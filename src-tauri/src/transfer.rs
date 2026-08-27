//! Planning and applying changes to a profile's destination.
//!
//! The planner is the single source of truth for the whole user interface. It
//! returns a merged inventory in which every file that will exist on the
//! destination is labelled, so the frontend can render "current", "changes",
//! and "result" views from one array instead of maintaining its own model.
//!
//! Nothing is ever overwritten. A destination path that already holds different
//! content becomes a conflict, and a plan carrying any warning cannot be
//! executed.

use crate::devices::{available_space, probe_writable, resolve_destination};
use crate::error::{Context, Result};
use crate::paths::{
    canonical, extension_of, file_size, files_equal, matches_indexed_size, normalise_extensions,
    readers_equal, relative_key, safe_relative_path, safe_target_path, sha256_reader, to_posix,
};
use crate::task::blocking;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

/// One planned copy: an indexed source file and where it should land, relative
/// to the destination root and always `/`-separated.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferOperation {
    pub source: String,
    pub relative_path: String,
    pub size: u64,
}

/// A change the user staged against the destination itself, before any copying.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationEdit {
    pub kind: EditKind,
    pub path: String,
    pub destination: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EditKind {
    Move,
    Delete,
}

/// What will happen to one path on the destination.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResultStatus {
    /// A new file will be copied here.
    Add,
    /// The file is already present and identical, or is untouched by this plan.
    Unchanged,
    /// An existing file will be renamed or moved.
    Move,
    /// An existing file will be deleted.
    Remove,
    /// Different content already occupies this path. Blocks the plan.
    Conflict,
}

/// One path on the destination and what will become of it.
///
/// The optional fields are omitted rather than serialised as `null`, because
/// the frontend distinguishes "not present on the destination" from "present
/// with an unknown size", and `null !== undefined` would quietly make every
/// addition look like an existing file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResultEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_path: Option<String>,
    pub status: ResultStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferPlan {
    pub target: String,
    pub operations: Vec<TransferOperation>,
    pub edits: Vec<DestinationEdit>,
    pub removals: Vec<String>,
    pub result: Vec<TransferResultEntry>,
    pub total_bytes: u64,
    pub available_bytes: Option<u64>,
    pub warnings: Vec<String>,
    pub ready: bool,
}

/// How a source file compares with the destination, used to annotate the
/// library table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    /// Not on the destination anywhere.
    New,
    /// Present at the path this profile would write it to, byte for byte.
    Identical,
    /// Something else already occupies that path.
    Different,
    /// Present on the destination, but somewhere else.
    ///
    /// This is what a library organised one way looks like against a profile
    /// configured another way. Reporting it as `New` was accurate about the
    /// path and badly misleading about the media: the title is on the stick.
    Elsewhere,
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetFileStatus {
    pub source: String,
    pub relative_path: String,
    pub status: FileStatus,
    /// Where it actually is, when the status is `elsewhere`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub found_at: Option<String>,
}

/// What the destination holds today: lookup key -> path as stored, its size,
/// and when it changed.
///
/// The modification time is carried from the directory walk so the digest
/// cache never has to look at the file a second time.
#[derive(Debug, Clone)]
struct TargetFile {
    path: String,
    size: u64,
    modified: i64,
}

type Inventory = HashMap<String, TargetFile>;

/// Recursively inventories the destination, keyed for case-insensitive lookup
/// because GoTek media is normally FAT.
fn read_inventory(root: &Path) -> Result<Inventory> {
    let mut files = Inventory::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(folder) = pending.pop() {
        let entries = fs::read_dir(&folder)
            .with_context(|| format!("Unable to inspect {}", folder.display()))?;
        for entry in entries {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                pending.push(entry.path());
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let relative = to_posix(
                &entry
                    .path()
                    .strip_prefix(root)
                    .context("A destination entry escaped the destination root.")?
                    .to_string_lossy(),
            );
            let metadata = entry.metadata()?;
            let stat = crate::fingerprint::Stat::of(&metadata);
            files.insert(
                relative.to_lowercase(),
                TargetFile {
                    path: relative,
                    size: stat.size,
                    modified: stat.modified,
                },
            );
        }
    }
    Ok(files)
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

struct PlanBuilder<'a> {
    root: &'a Path,
    current: Inventory,
    result: Vec<TransferResultEntry>,
    warnings: Vec<String>,
    removals: Vec<String>,
    /// Destination keys produced by a staged move. A copy may not land on one.
    moved_into: HashSet<String>,
    /// Sources of staged edits, used to reject overlapping edits.
    edited_sources: Vec<String>,
    /// Destination keys already claimed by a copy, to catch two sources that
    /// would produce the same filename.
    claimed: HashMap<String, String>,
    operations: Vec<TransferOperation>,
    total_bytes: u64,
}

impl<'a> PlanBuilder<'a> {
    fn new(root: &'a Path) -> Result<Self> {
        Ok(Self {
            current: read_inventory(root)?,
            root,
            result: Vec::new(),
            warnings: Vec::new(),
            removals: Vec::new(),
            moved_into: HashSet::new(),
            edited_sources: Vec::new(),
            claimed: HashMap::new(),
            operations: Vec::new(),
            total_bytes: 0,
        })
    }

    fn warn(&mut self, message: impl Into<String>) {
        self.warnings.push(message.into());
    }

    fn record(
        &mut self,
        path: String,
        status: ResultStatus,
        current_size: Option<u64>,
        result_size: Option<u64>,
    ) {
        self.result.push(TransferResultEntry {
            path,
            previous_path: None,
            status,
            current_size,
            result_size,
        });
    }

    /// Everything at or beneath `key`, so deleting or moving a folder carries
    /// its contents.
    fn affected(&self, key: &str) -> Vec<(String, TargetFile)> {
        let prefix = format!("{key}/");
        self.current
            .iter()
            .filter(|(candidate, _)| *candidate == key || candidate.starts_with(&prefix))
            .map(|(candidate, file)| (candidate.clone(), file.clone()))
            .collect()
    }

    fn overlaps_existing_edit(&self, key: &str) -> bool {
        self.edited_sources.iter().any(|previous| {
            previous == key
                || previous.starts_with(&format!("{key}/"))
                || key.starts_with(&format!("{previous}/"))
        })
    }

    fn apply_edits(&mut self, edits: &[DestinationEdit]) -> Result<()> {
        for edit in edits {
            safe_relative_path(&edit.path)?;
            let key = relative_key(&edit.path);
            if self.overlaps_existing_edit(&key) {
                self.warn(format!(
                    "Overlapping destination edits are not allowed: {}",
                    edit.path
                ));
                continue;
            }
            self.edited_sources.push(key.clone());

            let affected = self.affected(&key);
            let source_path = safe_target_path(self.root, &edit.path)?;
            if affected.is_empty() && !source_path.is_dir() {
                self.warn(format!("Edit source no longer exists: {}", edit.path));
                continue;
            }
            let is_symlink = fs::symlink_metadata(&source_path)
                .is_ok_and(|metadata| metadata.file_type().is_symlink());
            if is_symlink {
                self.warn(format!("Symbolic links cannot be edited: {}", edit.path));
                continue;
            }
            match edit.kind {
                EditKind::Delete => self.stage_delete(affected),
                EditKind::Move => self.stage_move(edit, &key, affected)?,
            }
        }
        Ok(())
    }

    fn stage_delete(&mut self, affected: Vec<(String, TargetFile)>) {
        for (key, file) in affected {
            self.current.remove(&key);
            self.removals.push(file.path.clone());
            self.record(file.path, ResultStatus::Remove, Some(file.size), None);
        }
    }

    fn stage_move(
        &mut self,
        edit: &DestinationEdit,
        key: &str,
        affected: Vec<(String, TargetFile)>,
    ) -> Result<()> {
        let destination = edit
            .destination
            .as_deref()
            .context("Move edits require a destination path.")?;
        safe_relative_path(destination)?;
        safe_target_path(self.root, destination)?;

        let destination_key = relative_key(destination);
        if destination_key == key || destination_key.starts_with(&format!("{key}/")) {
            self.warn(format!("A path cannot be moved into itself: {}", edit.path));
            return Ok(());
        }
        let occupied = self.root.join(destination).exists()
            || self.current.keys().any(|candidate| {
                candidate == &destination_key
                    || candidate.starts_with(&format!("{destination_key}/"))
            });
        if occupied {
            self.warn(format!("Move destination already exists: {destination}"));
            return Ok(());
        }
        for (existing_key, file) in affected {
            self.current.remove(&existing_key);
            // Preserve the subtree shape when a folder is moved.
            let suffix = file
                .path
                .get(edit.path.len()..)
                .unwrap_or_default()
                .trim_start_matches('/');
            let moved_path = if suffix.is_empty() {
                destination.to_string()
            } else {
                format!("{destination}/{suffix}")
            };
            let moved_key = relative_key(&moved_path);
            self.moved_into.insert(moved_key.clone());
            self.current.insert(
                moved_key,
                TargetFile {
                    path: moved_path.clone(),
                    size: file.size,
                    // A move does not change the file, only where it sits.
                    modified: file.modified,
                },
            );
            self.result.push(TransferResultEntry {
                path: moved_path,
                previous_path: Some(file.path),
                status: ResultStatus::Move,
                current_size: Some(file.size),
                result_size: Some(file.size),
            });
        }
        Ok(())
    }

    fn apply_operations(&mut self, operations: Vec<TransferOperation>) -> Result<()> {
        for operation in operations {
            safe_relative_path(&operation.relative_path)?;
            safe_target_path(self.root, &operation.relative_path)?;
            let source = Path::new(&operation.source);
            let source_ready = self.check_source(source, &operation);
            let key = relative_key(&operation.relative_path);

            if let Some(previous) = self.claimed.insert(key.clone(), operation.source.clone()) {
                self.warn(format!(
                    "Destination collision: {previous} and {}",
                    operation.source
                ));
            }

            if let Some(existing) = self.current.remove(&key) {
                self.resolve_collision(&operation, source, source_ready, existing)?;
                continue;
            }
            self.record(
                operation.relative_path.clone(),
                ResultStatus::Add,
                None,
                Some(operation.size),
            );
            if source_ready {
                self.total_bytes = self
                    .total_bytes
                    .checked_add(operation.size)
                    .context("Transfer size overflowed.")?;
                self.operations.push(operation);
            }
        }
        Ok(())
    }

    /// A source that vanished or changed since indexing must not be copied
    /// silently: the plan reports it and becomes unexecutable.
    fn check_source(&mut self, source: &Path, operation: &TransferOperation) -> bool {
        if !source.is_file() {
            self.warn(format!("Source is unavailable: {}", operation.source));
            return false;
        }
        if !matches_indexed_size(source, operation.size) {
            self.warn(format!(
                "Source changed since it was indexed: {}",
                operation.source
            ));
            return false;
        }
        true
    }

    fn record_conflict(&mut self, existing: &TargetFile, planned: u64, message: String) {
        self.warn(message);
        self.result.push(TransferResultEntry {
            path: existing.path.clone(),
            previous_path: None,
            status: ResultStatus::Conflict,
            current_size: Some(existing.size),
            result_size: Some(planned),
        });
    }

    fn resolve_collision(
        &mut self,
        operation: &TransferOperation,
        source: &Path,
        source_ready: bool,
        existing: TargetFile,
    ) -> Result<()> {
        if self
            .moved_into
            .contains(&relative_key(&operation.relative_path))
        {
            let message = format!(
                "Destination conflicts with a staged move: {}",
                operation.relative_path
            );
            self.record_conflict(&existing, operation.size, message);
            return Ok(());
        }
        let identical = source_ready
            && existing.size == operation.size
            && files_equal(source, &self.root.join(&existing.path))?;
        if identical {
            self.record(
                existing.path,
                ResultStatus::Unchanged,
                Some(existing.size),
                Some(operation.size),
            );
            return Ok(());
        }
        let message = format!("Different file already exists: {}", operation.relative_path);
        self.record_conflict(&existing, operation.size, message);
        Ok(())
    }

    /// Classifies everything left on the destination that no copy touched.
    fn apply_retained(&mut self, remove_existing: bool, managed: &HashSet<String>) {
        let retained = std::mem::take(&mut self.current);
        for (key, file) in retained {
            if self.moved_into.contains(&key) {
                // Already recorded by the move that created it.
                continue;
            }
            let managed_file = managed.contains(&extension_of(Path::new(&file.path)));
            if remove_existing && managed_file {
                self.removals.push(file.path.clone());
                self.record(file.path, ResultStatus::Remove, Some(file.size), None);
            } else {
                self.record(
                    file.path,
                    ResultStatus::Unchanged,
                    Some(file.size),
                    Some(file.size),
                );
            }
        }
    }

    fn finish(mut self, target: &str, edits: Vec<DestinationEdit>) -> TransferPlan {
        self.removals.sort();
        self.result.sort_by_key(|entry| entry.path.to_lowercase());
        let available_bytes = available_space(self.root);
        if available_bytes.is_some_and(|available| self.total_bytes > available) {
            self.warn("The destination does not have enough free space.");
        }
        TransferPlan {
            target: target.to_string(),
            operations: self.operations,
            edits,
            removals: self.removals,
            result: self.result,
            total_bytes: self.total_bytes,
            available_bytes,
            ready: self.warnings.is_empty(),
            warnings: self.warnings,
        }
    }
}

/// Builds a plan without touching the destination.
pub fn build_transfer_plan(
    target: &str,
    operations: Vec<TransferOperation>,
    edits: Vec<DestinationEdit>,
    remove_existing: bool,
    managed_extensions: &[String],
) -> Result<TransferPlan> {
    let root = resolve_destination(target)?;
    if remove_existing && operations.is_empty() {
        return Err(
            "Removing files outside the collection requires at least one selected title.".into(),
        );
    }
    let managed = normalise_extensions(managed_extensions.to_vec());
    let mut builder = PlanBuilder::new(&root)?;
    builder.apply_edits(&edits)?;
    builder.apply_operations(operations)?;
    builder.apply_retained(remove_existing, &managed);
    Ok(builder.finish(target, edits))
}

#[tauri::command]
pub async fn plan_transfer(
    target: String,
    operations: Vec<TransferOperation>,
    edits: Vec<DestinationEdit>,
    remove_existing: bool,
    managed_extensions: Vec<String>,
) -> Result<TransferPlan> {
    blocking(move || {
        build_transfer_plan(
            &target,
            operations,
            edits,
            remove_existing,
            &managed_extensions,
        )
    })
    .await
}

// ---------------------------------------------------------------------------
// Comparing sources with the destination
// ---------------------------------------------------------------------------

fn compare_image_file(image: &Path, relative_path: &str, source: &Path) -> Result<Option<bool>> {
    let filesystem = crate::image::open_read(image)?;
    let Ok(mut candidate) = filesystem.root_dir().open_file(relative_path) else {
        return Ok(None);
    };
    let mut source_file = fs::File::open(source)?;
    Ok(Some(
        sha256_reader(&mut source_file)? == sha256_reader(&mut candidate)?,
    ))
}

fn compare_folder_file(root: &Path, relative_path: &str, source: &Path) -> Result<Option<bool>> {
    let candidate = safe_target_path(root, relative_path)?;
    if !candidate.is_file() {
        return Ok(None);
    }
    if file_size(&candidate) != file_size(source) {
        return Ok(Some(false));
    }
    let mut source_file = fs::File::open(source)?;
    let mut target_file = fs::File::open(&candidate)?;
    Ok(Some(readers_equal(&mut source_file, &mut target_file)?))
}

/// Indexes a destination by the contents of its files.
///
/// This is what makes presence independent of naming: a title shortened for a
/// two-line display, or filed under a different folder scheme, has the same
/// digest and is recognised as the same disk image. Digests come from the
/// cache, so the destination is fully read once and only re-read where a file
/// has actually changed.
fn content_index(
    connection: &Connection,
    cache: &mut crate::fingerprint::DigestCache,
    root: &Path,
    on_progress: crate::fingerprint::OnProgress<'_>,
) -> Result<HashMap<String, Vec<String>>> {
    let inventory = read_inventory(root)?;
    let paths = inventory
        .values()
        .map(|file| {
            (
                root.join(&file.path).to_string_lossy().into_owned(),
                crate::fingerprint::Stat {
                    size: file.size,
                    modified: file.modified,
                },
            )
        })
        .collect::<Vec<_>>();

    // Every location, not just one: the same contents may sit both where this
    // profile would write them and somewhere else, and which of those is true
    // decides whether there is anything to do.
    let mut index: HashMap<String, Vec<String>> = HashMap::new();
    for fingerprint in crate::fingerprint::fingerprint_all(connection, cache, &paths, on_progress)?
    {
        let relative = Path::new(&fingerprint.path)
            .strip_prefix(root)
            .map(|value| to_posix(&value.to_string_lossy()))
            .unwrap_or_else(|_| fingerprint.path.clone());
        index.entry(fingerprint.sha256).or_default().push(relative);
    }
    // Deterministic, so the reported location does not depend on walk order.
    for locations in index.values_mut() {
        locations.sort();
    }
    Ok(index)
}

/// Reports, per source file, whether the destination already holds it.
///
/// Only paths that could actually collide are opened, which keeps a large
/// library responsive while still giving an exact answer.
#[tauri::command]
pub async fn compare_target_files(
    app: tauri::AppHandle,
    target: String,
    operations: Vec<TransferOperation>,
) -> Result<Vec<TargetFileStatus>> {
    blocking(move || {
        let connection = crate::store::connection(&app)?;
        let mut report = crate::fingerprint::emitter(&app);
        compare_files(&connection, &target, operations, &mut report)
    })
    .await
}

/// The comparison itself, with no dependency on a running application.
pub fn compare_files(
    connection: &Connection,
    target: &str,
    operations: Vec<TransferOperation>,
    on_progress: crate::fingerprint::OnProgress<'_>,
) -> Result<Vec<TargetFileStatus>> {
    {
        let target_path = PathBuf::from(target);
        let image_target = target_path.is_file();
        if !image_target && !target_path.is_dir() {
            return Err(
                "The comparison target must be a folder, mounted volume, or FAT image.".into(),
            );
        }
        let root = if image_target {
            target_path.clone()
        } else {
            canonical(&target_path)?
        };
        // Loaded once for the whole call: one query instead of one per file.
        let mut cache = crate::fingerprint::DigestCache::load(connection)?;
        // Built once for the whole call, from content rather than filenames.
        let by_content = if image_target {
            HashMap::new()
        } else {
            content_index(connection, &mut cache, &root, on_progress)?
        };

        operations
            .into_iter()
            .map(|operation| {
                let source = Path::new(&operation.source);
                // Looked at once. The size check and the digest both need this,
                // and over a few thousand files a second look is not free.
                let metadata = fs::metadata(source)
                    .ok()
                    .filter(|metadata| metadata.is_file())
                    .filter(|metadata| metadata.len() == operation.size);
                let Some(metadata) = metadata else {
                    return Ok(TargetFileStatus {
                        source: operation.source,
                        relative_path: operation.relative_path,
                        status: FileStatus::Unavailable,
                        found_at: None,
                    });
                };
                safe_relative_path(&operation.relative_path)?;

                // Content first. Where a title is filed, and what it is called,
                // are output decisions and must not change whether the media
                // already holds it.
                let digest = if image_target {
                    None
                } else {
                    Some(cache.digest(
                        connection,
                        source,
                        crate::fingerprint::Stat::of(&metadata),
                    )?)
                };
                let locations = digest
                    .as_deref()
                    .and_then(|sha256| by_content.get(sha256));
                if let Some(locations) = locations {
                    let wanted = relative_key(&operation.relative_path);
                    // Already where this profile would put it, so there is
                    // nothing to do, whatever other copies exist elsewhere.
                    let here = locations
                        .iter()
                        .any(|location| relative_key(location) == wanted);
                    return Ok(TargetFileStatus {
                        source: operation.source,
                        relative_path: operation.relative_path,
                        status: if here {
                            FileStatus::Identical
                        } else {
                            FileStatus::Elsewhere
                        },
                        found_at: (!here).then(|| locations[0].clone()),
                    });
                }

                // The contents are not on the destination at all. The only
                // question left is whether something else occupies the path
                // this profile would write to.
                let comparison = if image_target {
                    compare_image_file(&root, &operation.relative_path, source)?
                } else {
                    compare_folder_file(&root, &operation.relative_path, source)?
                };
                Ok(TargetFileStatus {
                    source: operation.source,
                    relative_path: operation.relative_path,
                    status: match comparison {
                        None => FileStatus::New,
                        Some(true) => FileStatus::Identical,
                        Some(false) => FileStatus::Different,
                    },
                    found_at: None,
                })
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

const PART_SUFFIX: &str = ".gotek-part";

/// Copies through a temporary file, flushes it to the device, verifies it, and
/// only then puts it in place.
///
/// Removable media is routinely unplugged mid-write. Writing directly to the
/// final name would leave a truncated file that looks like a valid disk image;
/// this way an interrupted copy leaves only an obvious partial file.
///
/// `checksum` trades speed for certainty: the size check catches a truncated
/// copy, but only a digest catches media that accepted the bytes and stored
/// something else, which is exactly how a failing USB stick behaves.
fn copy_verified(source: &Path, destination: &Path, expected: u64, checksum: bool) -> Result<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = destination.with_file_name(format!(
        "{}{PART_SUFFIX}",
        destination
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
    ));
    let outcome = (|| -> Result<()> {
        let mut reader = fs::File::open(source)
            .with_context(|| format!("Unable to read {}", source.display()))?;
        let mut writer = fs::File::create(&temporary)
            .with_context(|| format!("Unable to write {}", temporary.display()))?;
        let copied = std::io::copy(&mut reader, &mut writer)
            .with_context(|| format!("Failed to copy {}", source.display()))?;
        writer
            .sync_all()
            .with_context(|| format!("Failed to flush {}", temporary.display()))?;
        if copied != expected || file_size(&temporary) != Some(expected) {
            return Err(format!("Verification failed for {}", destination.display()).into());
        }
        if checksum {
            let mut original = fs::File::open(source)?;
            let mut written = fs::File::open(&temporary)?;
            if sha256_reader(&mut original)? != sha256_reader(&mut written)? {
                return Err(format!(
                    "{} did not read back the same as the source. The destination media may \
                     be faulty.",
                    destination.display()
                )
                .into());
            }
        }
        Ok(())
    })();
    if outcome.is_err() {
        let _ = fs::remove_file(&temporary);
        return outcome;
    }
    fs::rename(&temporary, destination)
        .with_context(|| format!("Failed to finalise {}", destination.display()))?;
    Ok(())
}

fn apply_edit(root: &Path, edit: &DestinationEdit) -> Result<()> {
    let source = safe_target_path(root, &edit.path)?;
    match edit.kind {
        EditKind::Delete if source.is_dir() => fs::remove_dir_all(&source)
            .with_context(|| format!("Failed to remove {}", source.display()))?,
        EditKind::Delete if source.is_file() => fs::remove_file(&source)
            .with_context(|| format!("Failed to remove {}", source.display()))?,
        EditKind::Delete => {}
        EditKind::Move => {
            let destination = safe_target_path(
                root,
                edit.destination
                    .as_deref()
                    .context("Move edits require a destination path.")?,
            )?;
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::rename(&source, &destination)
                .with_context(|| format!("Failed to move {}", source.display()))?;
        }
    }
    Ok(())
}

/// Re-plans, then applies. The plan the frontend was showing is never trusted:
/// the destination is inventoried again here, so media swapped or changed since
/// the user pressed Confirm cannot be written with stale expectations.
#[tauri::command]
pub async fn execute_transfer(
    target: String,
    operations: Vec<TransferOperation>,
    edits: Vec<DestinationEdit>,
    remove_existing: bool,
    managed_extensions: Vec<String>,
    #[allow(non_snake_case)] verify_checksums: Option<bool>,
) -> Result<TransferPlan> {
    blocking(move || {
        let plan = build_transfer_plan(
            &target,
            operations,
            edits,
            remove_existing,
            &managed_extensions,
        )?;
        if !plan.ready {
            return Err("The transfer plan has unresolved warnings.".into());
        }
        let root = resolve_destination(&target)?;
        probe_writable(&root)?;

        for edit in &plan.edits {
            apply_edit(&root, edit)?;
        }
        for operation in &plan.operations {
            let destination = safe_target_path(&root, &operation.relative_path)?;
            copy_verified(
                Path::new(&operation.source),
                &destination,
                operation.size,
                verify_checksums.unwrap_or(false),
            )?;
        }
        for relative_path in &plan.removals {
            let path = safe_target_path(&root, relative_path)?;
            if path.is_file() {
                fs::remove_file(&path)
                    .with_context(|| format!("Failed to remove {}", path.display()))?;
            }
        }
        Ok(plan)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        build_transfer_plan, copy_verified, DestinationEdit, EditKind, ResultStatus,
        TransferOperation,
    };
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    fn fixture(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "gotek-transfer-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn operation(source: &PathBuf, relative_path: &str) -> TransferOperation {
        TransferOperation {
            source: source.to_string_lossy().into_owned(),
            relative_path: relative_path.into(),
            size: fs::metadata(source).unwrap().len(),
        }
    }

    fn plan(
        target: &Path,
        operations: Vec<TransferOperation>,
        edits: Vec<DestinationEdit>,
        remove_existing: bool,
    ) -> super::TransferPlan {
        build_transfer_plan(
            &target.to_string_lossy(),
            operations,
            edits,
            remove_existing,
            &["ssd".into(), "adf".into()],
        )
        .unwrap()
    }

    #[test]
    fn an_addition_omits_the_current_size_rather_than_sending_null() {
        let entry = super::TransferResultEntry {
            path: "BBC/Elite.ssd".into(),
            previous_path: None,
            status: ResultStatus::Add,
            current_size: None,
            result_size: Some(200),
        };

        let json = serde_json::to_string(&entry).unwrap();

        // The frontend counts "files already on the destination" by asking
        // whether currentSize is present, so a null here would be a miscount.
        assert!(!json.contains("currentSize"), "{json}");
        assert!(!json.contains("previousPath"), "{json}");
        assert!(json.contains("\"resultSize\":200"), "{json}");
    }

    #[test]
    fn a_new_file_is_planned_as_an_addition() {
        let library = fixture("add-library");
        let target = fixture("add-target");
        let source = library.join("Elite.ssd");
        fs::write(&source, b"disk").unwrap();

        let result = plan(&target, vec![operation(&source, "BBC/Elite.ssd")], vec![], false);

        assert!(result.ready, "{:?}", result.warnings);
        assert_eq!(result.total_bytes, 4);
        assert_eq!(result.result.len(), 1);
        assert_eq!(result.result[0].status, ResultStatus::Add);
        fs::remove_dir_all(library).unwrap();
        fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn identical_content_is_unchanged_and_different_content_conflicts() {
        let library = fixture("same-library");
        let target = fixture("same-target");
        let source = library.join("Elite.ssd");
        fs::write(&source, b"disk").unwrap();
        fs::write(target.join("Elite.ssd"), b"disk").unwrap();

        let same = plan(&target, vec![operation(&source, "Elite.ssd")], vec![], false);

        assert!(same.ready);
        assert_eq!(same.result[0].status, ResultStatus::Unchanged);
        assert_eq!(same.total_bytes, 0);

        fs::write(target.join("Elite.ssd"), b"different").unwrap();
        let differs = plan(&target, vec![operation(&source, "Elite.ssd")], vec![], false);

        assert!(!differs.ready);
        assert_eq!(differs.result[0].status, ResultStatus::Conflict);
        assert!(differs.warnings[0].contains("Different file already exists"));
        fs::remove_dir_all(library).unwrap();
        fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn collisions_are_case_insensitive_because_gotek_media_is_fat() {
        let library = fixture("case-library");
        let target = fixture("case-target");
        let source = library.join("elite.ssd");
        fs::write(&source, b"disk").unwrap();
        fs::write(target.join("ELITE.SSD"), b"other").unwrap();

        let result = plan(&target, vec![operation(&source, "elite.ssd")], vec![], false);

        assert!(!result.ready);
        assert_eq!(result.result[0].status, ResultStatus::Conflict);
        fs::remove_dir_all(library).unwrap();
        fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn two_sources_that_would_share_one_name_are_reported() {
        let library = fixture("dupe-library");
        let target = fixture("dupe-target");
        let first = library.join("a.ssd");
        let second = library.join("b.ssd");
        fs::write(&first, b"one").unwrap();
        fs::write(&second, b"two").unwrap();

        let result = plan(
            &target,
            vec![operation(&first, "Elite.ssd"), operation(&second, "elite.ssd")],
            vec![],
            false,
        );

        assert!(!result.ready);
        assert!(result.warnings.iter().any(|w| w.contains("Destination collision")));
        fs::remove_dir_all(library).unwrap();
        fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn keep_retains_unmanaged_files_and_remove_only_takes_managed_ones() {
        let library = fixture("policy-library");
        let target = fixture("policy-target");
        let source = library.join("Elite.ssd");
        fs::write(&source, b"disk").unwrap();
        fs::write(target.join("Chuckie.ssd"), b"old").unwrap();
        fs::write(target.join("FF.CFG"), b"config").unwrap();

        let keep = plan(&target, vec![operation(&source, "Elite.ssd")], vec![], false);
        assert!(keep.removals.is_empty());

        let remove = plan(&target, vec![operation(&source, "Elite.ssd")], vec![], true);

        assert_eq!(remove.removals, vec!["Chuckie.ssd".to_string()]);
        // Firmware configuration is outside the profile's formats and survives.
        assert!(remove
            .result
            .iter()
            .any(|entry| entry.path == "FF.CFG" && entry.status == ResultStatus::Unchanged));
        fs::remove_dir_all(library).unwrap();
        fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn a_missing_source_blocks_the_plan_and_is_never_queued_for_copying() {
        let target = fixture("missing-target");
        let operation = TransferOperation {
            source: target.join("nowhere.ssd").to_string_lossy().into_owned(),
            relative_path: "nowhere.ssd".into(),
            size: 4,
        };

        let result = plan(&target, vec![operation], vec![], false);

        assert!(!result.ready);
        assert!(result.operations.is_empty());
        assert_eq!(result.total_bytes, 0);
        fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn staged_moves_carry_folder_contents_and_reject_overlapping_edits() {
        let target = fixture("move-target");
        fs::create_dir(target.join("Old")).unwrap();
        fs::write(target.join("Old/Elite.ssd"), b"disk").unwrap();

        let moved = plan(
            &target,
            vec![],
            vec![DestinationEdit {
                kind: EditKind::Move,
                path: "Old".into(),
                destination: Some("BBC".into()),
            }],
            false,
        );

        assert!(moved.ready, "{:?}", moved.warnings);
        let entry = moved.result.iter().find(|e| e.path == "BBC/Elite.ssd").unwrap();
        assert_eq!(entry.status, ResultStatus::Move);
        assert_eq!(entry.previous_path.as_deref(), Some("Old/Elite.ssd"));

        let overlapping = plan(
            &target,
            vec![],
            vec![
                DestinationEdit {
                    kind: EditKind::Delete,
                    path: "Old".into(),
                    destination: None,
                },
                DestinationEdit {
                    kind: EditKind::Delete,
                    path: "Old/Elite.ssd".into(),
                    destination: None,
                },
            ],
            false,
        );

        assert!(!overlapping.ready);
        assert!(overlapping
            .warnings
            .iter()
            .any(|w| w.contains("Overlapping destination edits")));
        fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn a_copy_may_not_land_on_a_path_a_move_just_created() {
        let library = fixture("clash-library");
        let target = fixture("clash-target");
        let source = library.join("Elite.ssd");
        fs::write(&source, b"disk").unwrap();
        fs::write(target.join("Old.ssd"), b"old").unwrap();

        let result = plan(
            &target,
            vec![operation(&source, "Elite.ssd")],
            vec![DestinationEdit {
                kind: EditKind::Move,
                path: "Old.ssd".into(),
                destination: Some("Elite.ssd".into()),
            }],
            false,
        );

        assert!(!result.ready);
        assert!(result
            .warnings
            .iter()
            .any(|w| w.contains("conflicts with a staged move")));
        fs::remove_dir_all(library).unwrap();
        fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn destination_paths_may_not_escape_the_target() {
        let library = fixture("escape-library");
        let target = fixture("escape-target");
        let source = library.join("Elite.ssd");
        fs::write(&source, b"disk").unwrap();

        let result = build_transfer_plan(
            &target.to_string_lossy(),
            vec![operation(&source, "../escaped.ssd")],
            vec![],
            false,
            &["ssd".into()],
        );

        assert!(result.is_err());
        fs::remove_dir_all(library).unwrap();
        fs::remove_dir_all(target).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_inside_the_target_cannot_redirect_a_write() {
        use std::os::unix::fs::symlink;
        let library = fixture("symlink-library");
        let target = fixture("symlink-target");
        let outside = fixture("symlink-outside");
        let source = library.join("Elite.ssd");
        fs::write(&source, b"disk").unwrap();
        symlink(&outside, target.join("escape")).unwrap();

        let result = build_transfer_plan(
            &target.to_string_lossy(),
            vec![operation(&source, "escape/Elite.ssd")],
            vec![],
            false,
            &["ssd".into()],
        );

        assert!(result.is_err());
        assert!(!outside.join("Elite.ssd").exists());
        fs::remove_dir_all(library).unwrap();
        fs::remove_dir_all(target).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn system_locations_are_refused_as_destinations() {
        assert!(build_transfer_plan("/", vec![], vec![], false, &[]).is_err());
    }

    #[test]
    fn an_interrupted_copy_never_leaves_a_file_at_the_final_name() {
        let library = fixture("verify-library");
        let target = fixture("verify-target");
        let source = library.join("Elite.ssd");
        fs::write(&source, b"disk").unwrap();
        let destination = target.join("Elite.ssd");

        // A size that disagrees with the source stands in for a truncated copy.
        let error = copy_verified(&source, &destination, 999, false).unwrap_err();

        assert!(error.to_string().contains("Verification failed"));
        assert!(!destination.exists());
        assert_eq!(fs::read_dir(&target).unwrap().count(), 0);

        copy_verified(&source, &destination, 4, true).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"disk");
        fs::remove_dir_all(library).unwrap();
        fs::remove_dir_all(target).unwrap();
    }
}

#[cfg(test)]
mod checksum_tests {
    use super::copy_verified;
    use std::{fs, path::PathBuf};

    fn fixture(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "gotek-checksum-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn checksum_verification_passes_for_a_good_copy_and_costs_nothing_when_off() {
        let root = fixture("good");
        let source = root.join("Elite.ssd");
        let content = vec![0x5Au8; 128 * 1024];
        fs::write(&source, &content).unwrap();

        copy_verified(&source, &root.join("with.ssd"), content.len() as u64, true).unwrap();
        copy_verified(&source, &root.join("without.ssd"), content.len() as u64, false).unwrap();

        assert_eq!(fs::read(root.join("with.ssd")).unwrap(), content);
        assert_eq!(fs::read(root.join("without.ssd")).unwrap(), content);
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod elsewhere_tests {
    use super::{FileStatus, TransferOperation};
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    fn fixture(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "gotek-elsewhere-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn compare(
        target: &Path,
        operations: Vec<TransferOperation>,
    ) -> Vec<super::TargetFileStatus> {
        // An in-memory database gives the digest cache somewhere to live
        // without needing a running application.
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::store::prepare(&connection).unwrap();
        let mut quiet = crate::fingerprint::ignore_progress;
        super::compare_files(
            &connection,
            &target.to_string_lossy(),
            operations,
            &mut quiet,
        )
        .unwrap()
    }

    #[test]
    fn a_title_filed_under_a_different_layout_is_found_where_it_really_is() {
        // Exactly the shape of a real collection: the destination groups by
        // initial letter, while the profile is set to platform folders.
        let library = fixture("layout-library");
        let target = fixture("layout-target");
        let source = library.join("Zynaps (1987)(Hewson Consultants).dsk");
        fs::write(&source, vec![0xC9u8; 194816]).unwrap();
        fs::create_dir(target.join("Z")).unwrap();
        fs::copy(&source, target.join("Z/Zynaps (1987)(Hewson Consultants).dsk")).unwrap();

        let result = compare(
            &target,
            vec![TransferOperation {
                source: source.to_string_lossy().into_owned(),
                // Where this profile would put it: nothing is there.
                relative_path: "CPC464/Zynaps (1987)(Hewson.dsk".into(),
                size: 194816,
            }],
        );

        assert_eq!(result[0].status, FileStatus::Elsewhere);
        assert_eq!(
            result[0].found_at.as_deref(),
            Some("Z/Zynaps (1987)(Hewson Consultants).dsk")
        );
        fs::remove_dir_all(library).unwrap();
        fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn a_shortened_name_is_still_recognised_as_the_same_disk_image() {
        // The case that started this: OLED naming truncates the title, so the
        // file on the media is called something else entirely. Identity is the
        // contents, so the rename must not make a present title look missing.
        let library = fixture("renamed-library");
        let target = fixture("renamed-target");
        let source = library.join("Zynaps (1987)(Hewson Consultants).dsk");
        fs::write(&source, vec![0xC9u8; 194_816]).unwrap();
        fs::create_dir(target.join("CPC464")).unwrap();
        fs::copy(&source, target.join("CPC464/Zynaps (1987)(Hewson.dsk")).unwrap();

        let result = compare(
            &target,
            vec![TransferOperation {
                source: source.to_string_lossy().into_owned(),
                // A different layout and the full name: neither matches what
                // is on the media, but the contents do.
                relative_path: "Z/Zynaps (1987)(Hewson Consultants).dsk".into(),
                size: 194_816,
            }],
        );

        assert_eq!(result[0].status, FileStatus::Elsewhere);
        assert_eq!(
            result[0].found_at.as_deref(),
            Some("CPC464/Zynaps (1987)(Hewson.dsk")
        );
        fs::remove_dir_all(library).unwrap();
        fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn a_different_release_of_the_same_title_is_not_mistaken_for_it() {
        // Same name, same length, different contents: a cracked or alternate
        // release. Content identity is what keeps these apart.
        let library = fixture("release-library");
        let target = fixture("release-target");
        let source = library.join("Elite.dsk");
        fs::write(&source, vec![0xAAu8; 194_816]).unwrap();
        fs::create_dir(target.join("E")).unwrap();
        fs::write(target.join("E/Elite.dsk"), vec![0xBBu8; 194_816]).unwrap();

        let result = compare(
            &target,
            vec![TransferOperation {
                source: source.to_string_lossy().into_owned(),
                relative_path: "CPC464/Elite.dsk".into(),
                size: 194_816,
            }],
        );

        assert_eq!(result[0].status, FileStatus::New);
        assert!(result[0].found_at.is_none());
        fs::remove_dir_all(library).unwrap();
        fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn a_genuinely_absent_title_is_still_new() {
        let library = fixture("absent-library");
        let target = fixture("absent-target");
        let source = library.join("Elite.dsk");
        fs::write(&source, b"disk").unwrap();

        let result = compare(
            &target,
            vec![TransferOperation {
                source: source.to_string_lossy().into_owned(),
                relative_path: "CPC464/Elite.dsk".into(),
                size: 4,
            }],
        );

        assert_eq!(result[0].status, FileStatus::New);
        assert!(result[0].found_at.is_none());
        fs::remove_dir_all(library).unwrap();
        fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn the_exact_path_still_wins_over_a_copy_elsewhere() {
        let library = fixture("exact-library");
        let target = fixture("exact-target");
        let source = library.join("Elite.dsk");
        fs::write(&source, b"disk").unwrap();
        fs::create_dir(target.join("CPC464")).unwrap();
        fs::copy(&source, target.join("CPC464/Elite.dsk")).unwrap();
        fs::create_dir(target.join("E")).unwrap();
        fs::copy(&source, target.join("E/Elite.dsk")).unwrap();

        let result = compare(
            &target,
            vec![TransferOperation {
                source: source.to_string_lossy().into_owned(),
                relative_path: "CPC464/Elite.dsk".into(),
                size: 4,
            }],
        );

        // Present where it belongs, so the copy elsewhere is not the story.
        assert_eq!(result[0].status, FileStatus::Identical);
        assert!(result[0].found_at.is_none());
        fs::remove_dir_all(library).unwrap();
        fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn a_same_named_file_of_different_contents_is_not_claimed_to_be_the_same() {
        let library = fixture("size-library");
        let target = fixture("size-target");
        let source = library.join("Elite.dsk");
        fs::write(&source, vec![0u8; 194816]).unwrap();
        fs::create_dir(target.join("E")).unwrap();
        // Same name, different content and length: a different release.
        fs::write(target.join("E/Elite.dsk"), vec![0u8; 1024]).unwrap();

        let result = compare(
            &target,
            vec![TransferOperation {
                source: source.to_string_lossy().into_owned(),
                relative_path: "CPC464/Elite.dsk".into(),
                size: 194816,
            }],
        );

        assert_eq!(result[0].status, FileStatus::New);
        fs::remove_dir_all(library).unwrap();
        fs::remove_dir_all(target).unwrap();
    }
}
