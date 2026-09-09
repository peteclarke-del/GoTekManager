//! Reading media libraries, destinations, and FAT filesystem images.
//!
//! Every command here is read-only.

use crate::archive::list_zip_images;
use crate::cache::{converted_folder, is_archive};
use crate::convert::Conversion;
use crate::devices::{available_space, detected_firmware, probe_writable, total_space};
use crate::error::{Context, Result};
use crate::paths::{
    entry_at, extension_of, file_entry, normalise_extensions, sort_entries, FileEntry,
};
use crate::task::blocking;
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Condvar, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::Emitter;

/// How far a scan has got, emitted while it walks.
///
/// A library on a network share is not read in a moment: a TOSEC set of thirty
/// thousand images over SMB takes minutes before a single title can be shown,
/// and silence for that long is indistinguishable from the application having
/// ignored the folder entirely. There is no total to count towards — learning
/// it would mean walking the tree twice — so this reports what has been seen
/// rather than a percentage.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub folders: usize,
    /// Folders found but not yet read, which is what gives the bar a length.
    pub pending: usize,
    /// Recognised images found so far, archives included.
    pub found: usize,
    /// The folder being read, so it is visibly making headway.
    pub current: String,
    /// True for the last message, which lets the indicator clear itself.
    pub finished: bool,
}

pub const SCAN_PROGRESS_EVENT: &str = "scan:progress";

/// How often a walking scan reports itself.
///
/// Per folder would be thousands of messages a second on a local disk, which
/// costs more than the scan; this is often enough to look alive and rare
/// enough to be free.
const SCAN_REPORT_EVERY: Duration = Duration::from_millis(200);

/// The shared state of a parallel directory walk.
///
/// The only subtle part is knowing when to stop. An empty queue does not mean
/// the walk is over: a worker still reading a folder may be about to add a
/// dozen more. So the count of workers currently inside a folder is tracked
/// alongside the queue, and the walk is finished only when the queue is empty
/// *and* nobody is working — at which point every waiting worker is woken so
/// they can all leave together.
struct Walk {
    state: Mutex<WalkState>,
    ready: Condvar,
    /// Counted as each file is recognised rather than as each folder finishes.
    ///
    /// An organised set is often one flat folder holding tens of thousands of
    /// images, so a count that only moves when a folder completes sits at zero
    /// for the entire scan and then jumps to the total. This one rises while
    /// the folder is still being read, which is the whole point of showing it.
    found: AtomicUsize,
}

struct WalkState {
    queue: Vec<PathBuf>,
    /// Workers currently reading a folder, not merely alive.
    working: usize,
    folders: usize,
    files: Vec<FileEntry>,
    current: PathBuf,
}

impl Walk {
    fn new(root: PathBuf) -> Self {
        Self {
            state: Mutex::new(WalkState {
                queue: vec![root],
                working: 0,
                folders: 0,
                files: Vec::new(),
                current: PathBuf::new(),
            }),
            ready: Condvar::new(),
            found: AtomicUsize::new(0),
        }
    }

    /// Notes files recognised inside a folder that is still being read.
    fn note_found(&self, count: usize) {
        self.found.fetch_add(count, Ordering::Relaxed);
    }

    /// The next folder to read, or nothing once the walk is over.
    fn take(&self) -> Option<PathBuf> {
        let mut state = self.state.lock().unwrap_or_else(|held| held.into_inner());
        loop {
            if let Some(folder) = state.queue.pop() {
                state.working += 1;
                state.current = folder.clone();
                return Some(folder);
            }
            if state.working == 0 {
                // Nothing queued and nobody working: the walk is finished, and
                // every other worker waiting here has to be told so too.
                self.ready.notify_all();
                return None;
            }
            state = self
                .ready
                .wait(state)
                .unwrap_or_else(|held| held.into_inner());
        }
    }

    /// Hands back what a folder held, and wakes anyone waiting for work.
    fn done(&self, folder: PathBuf, folders: Vec<PathBuf>, files: Vec<FileEntry>) {
        let mut state = self.state.lock().unwrap_or_else(|held| held.into_inner());
        state.queue.extend(folders);
        state.files.extend(files);
        state.folders += 1;
        state.working -= 1;
        let _ = folder;
        self.ready.notify_all();
    }

    /// Where the walk has got to, or nothing once it is over.
    fn progress(&self) -> Option<ScanProgress> {
        let state = self.state.lock().unwrap_or_else(|held| held.into_inner());
        if state.queue.is_empty() && state.working == 0 {
            return None;
        }
        Some(ScanProgress {
            folders: state.folders,
            pending: state.queue.len(),
            found: self.found.load(Ordering::Relaxed),
            current: state.current.display().to_string(),
            finished: false,
        })
    }

    fn into_files(self) -> Vec<FileEntry> {
        self.state
            .into_inner()
            .unwrap_or_else(|held| held.into_inner())
            .files
    }
}

/// The state of a profile's destination, refreshed whenever it is selected.
///
/// A missing or read-only destination is reported rather than raised as an
/// error, so the profile list can show it without interrupting the user.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetSummary {
    pub path: String,
    pub exists: bool,
    /// `folder`, `image`, or `missing`.
    pub kind: String,
    pub writable: bool,
    pub entries: usize,
    pub total_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
    pub detected_firmware_id: Option<String>,
}

impl TargetSummary {
    fn missing(path: String) -> Self {
        Self {
            path,
            exists: false,
            kind: "missing".into(),
            writable: false,
            entries: 0,
            total_bytes: None,
            available_bytes: None,
            detected_firmware_id: None,
        }
    }
}

#[tauri::command]
pub async fn inspect_target(path: String) -> Result<TargetSummary> {
    blocking(move || {
        let item = PathBuf::from(&path);
        if !item.exists() {
            return Ok(TargetSummary::missing(path));
        }
        if item.is_file() {
            return Ok(TargetSummary {
                exists: true,
                kind: "image".into(),
                // Image destinations are browsed read-only.
                writable: false,
                entries: 1,
                total_bytes: None,
                available_bytes: None,
                detected_firmware_id: None,
                path,
            });
        }
        let entries = fs::read_dir(&item)
            .with_context(|| format!("Unable to read {}", item.display()))?
            .count();
        Ok(TargetSummary {
            exists: true,
            kind: "folder".into(),
            writable: probe_writable(&item).is_ok(),
            entries,
            total_bytes: total_space(&item),
            available_bytes: available_space(&item),
            detected_firmware_id: detected_firmware(&item),
            path,
        })
    })
    .await
}

#[tauri::command]
pub async fn list_directory(path: String) -> Result<Vec<FileEntry>> {
    blocking(move || {
        let mut entries = fs::read_dir(&path)
            .with_context(|| format!("Unable to read {path}"))?
            .filter_map(std::result::Result::ok)
            .filter_map(|entry| {
                entry
                    .metadata()
                    .ok()
                    .map(|metadata| file_entry(&entry.path(), metadata))
            })
            .collect::<Vec<_>>();
        sort_entries(&mut entries);
        Ok(entries)
    })
    .await
}

/// Lists one directory inside a FAT `.img`/`.ima` container without mounting it.
///
/// Handles both shapes of image: a partitioned USB stick, which is what real
/// GoTek media is, and a bare filesystem with no partition table.
///
/// `inner_path` is always `/`-separated and empty for the root.
#[tauri::command]
pub async fn list_image_directory(image: String, inner_path: String) -> Result<Vec<FileEntry>> {
    blocking(move || crate::image::read_directory(Path::new(&image), &inner_path)).await
}

/// Recursively indexes recognised media beneath `path`.
///
/// Symbolic links are never followed, so a link loop or a link pointing outside
/// the library cannot be walked. ZIP archives are inspected in place and their
/// supported contents are served from the cache, leaving the archive untouched.
/// One file held by a profile's destination, wherever that destination is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldFile {
    /// How to read it: a path, or a container path and the entry inside it.
    pub source: String,
    /// `/`-separated and relative to the destination root.
    pub relative_path: String,
    pub size: u64,
}

/// Everything a profile's destination holds, ready to be copied elsewhere.
///
/// Every file, not only the ones this application recognises: a stick built
/// from a destination has to carry the drive's own configuration too, and
/// `scan_folder` filters by extension. A destination is wherever somebody chose
/// to keep it — a folder, a mounted stick, or a FAT image kept as a backup — so
/// all three answer here, and each file comes back with the address its bytes
/// can be read from.
/// What a directory entry is, for the purposes of walking a tree.
///
/// Both walks in this module ask the same three questions of every entry, and
/// the middle one is a safety rule rather than a convenience: a symbolic link is
/// never followed, so a link pointing out of the tree cannot be read as though
/// it were inside it, and a link pointing back into the tree cannot make the
/// walk go round for ever. An entry whose kind cannot even be established is
/// passed over, for the same reason an unreadable folder is: one of them turns
/// up in any large library, and losing thirty thousand titles to it helps
/// nobody.
enum Walked {
    Folder,
    File,
}

fn walked(entry: &fs::DirEntry) -> Option<Walked> {
    let file_type = entry.file_type().ok()?;
    if file_type.is_symlink() {
        return None;
    }
    if file_type.is_dir() {
        return Some(Walked::Folder);
    }
    file_type.is_file().then_some(Walked::File)
}

#[tauri::command]
pub async fn read_destination(path: String) -> Result<Vec<HeldFile>> {
    blocking(move || {
        let root = PathBuf::from(&path);
        if matches!(extension_of(&root).as_str(), "img" | "ima") {
            return Ok(crate::image::list_files(&root)?
                .into_iter()
                .map(|entry| HeldFile {
                    source: crate::source::entry_path(&root, &entry.path),
                    relative_path: entry.path,
                    size: entry.size,
                })
                .collect());
        }
        if !root.is_dir() {
            return Err(format!("The destination is not there: {path}").into());
        }

        let mut held = Vec::new();
        let mut pending = vec![root.clone()];
        while let Some(folder) = pending.pop() {
            let Ok(entries) = fs::read_dir(&folder) else {
                continue;
            };
            for entry in entries.flatten() {
                match walked(&entry) {
                    None => continue,
                    Some(Walked::Folder) => pending.push(entry.path()),
                    Some(Walked::File) => {
                        let Ok(metadata) = entry.metadata() else {
                            continue;
                        };
                        let path = entry.path();
                        let Ok(relative) = path.strip_prefix(&root) else {
                            continue;
                        };
                        held.push(HeldFile {
                            source: path.to_string_lossy().into_owned(),
                            relative_path: crate::paths::to_posix(&relative.to_string_lossy()),
                            size: metadata.len(),
                        });
                    }
                }
            }
        }
        held.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        Ok(held)
    })
    .await
}

#[tauri::command]
pub async fn scan_folder(
    app: tauri::AppHandle,
    path: String,
    extensions: Vec<String>,
    convert: Option<bool>,
) -> Result<Vec<FileEntry>> {
    let convert = convert.unwrap_or(true);
    blocking(move || {
        let root = PathBuf::from(&path);
        if !root.is_dir() {
            return Err(format!("The source folder does not exist: {path}").into());
        }
        let extensions = normalise_extensions(extensions);

        // Walked by several threads at once, which is the whole difference on a
        // network share. A TOSEC set of thirty thousand images over SMB spends
        // nearly all of its time waiting for round trips rather than working,
        // so reading many folders at once costs little and finishes many times
        // sooner. On a local disk the threads simply queue behind the disk and
        // it is no worse than walking in one.
        let work = Walk::new(root);
        let workers = thread::available_parallelism()
            .map(|count| count.get() * 2)
            .unwrap_or(8)
            .clamp(4, 16);

        thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| {
                    while let Some(folder) = work.take() {
                        let mut found = Vec::new();
                        let mut folders = Vec::new();
                        // A folder that cannot be read is skipped rather than
                        // abandoning the whole scan. A library of any size
                        // collects one sooner or later — a permissions
                        // boundary, a share that dropped out — and losing
                        // thirty thousand titles to one of them helps nobody.
                        if let Ok(entries) = fs::read_dir(&folder) {
                            for entry in entries.flatten() {
                                match walked(&entry) {
                                    None => continue,
                                    Some(Walked::Folder) => folders.push(entry.path()),
                                    Some(Walked::File) => {
                                        let before = found.len();
                                        // One bad file is skipped for the same
                                        // reason one bad folder is.
                                        let _ = collect_file(
                                            &app,
                                            &entry,
                                            &extensions,
                                            convert,
                                            &mut found,
                                        );
                                        work.note_found(found.len() - before);
                                    }
                                }
                            }
                        }
                        work.done(folder, folders, found);
                    }
                });
            }

            // Reported from here rather than from a worker, so the rate is the
            // clock's rather than however fast folders happen to arrive.
            while let Some(progress) = work.progress() {
                let _ = app.emit(SCAN_PROGRESS_EVENT, progress);
                thread::sleep(SCAN_REPORT_EVERY);
            }
        });

        let mut files = work.into_files();
        let _ = app.emit(
            SCAN_PROGRESS_EVENT,
            ScanProgress {
                folders: 0,
                pending: 0,
                found: files.len(),
                current: String::new(),
                finished: true,
            },
        );

        files.sort_by(|left, right| {
            left.name
                .to_lowercase()
                .cmp(&right.name.to_lowercase())
                .then_with(|| left.path.cmp(&right.path))
        });
        Ok(files)
    })
    .await
}

/// Reads one directory entry into the library, if it is anything we can use.
///
/// Takes the entry rather than its path so the size and time can be asked of
/// the entry the directory already yielded. `fs::metadata` resolves the whole
/// path again, which on a network share is another round trip per file — over
/// thirty thousand of them, that alone is minutes.
fn collect_file(
    app: &tauri::AppHandle,
    entry: &fs::DirEntry,
    extensions: &HashSet<String>,
    convert: bool,
    files: &mut Vec<FileEntry>,
) -> Result<()> {
    let path = &entry.path();
    if extensions.contains(&extension_of(path)) {
        if let Ok(metadata) = entry.metadata() {
            files.push(file_entry(path, metadata));
        }
        return Ok(());
    }

    // An archive is listed, never unpacked: its directory says what is inside
    // for the cost of a few small reads, and a title is read from the archive
    // if and when it is actually written. A folder of a few thousand archives
    // that holds nothing this application can use now says so in seconds.
    if is_archive(path) {
        let modified = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|value| value.as_secs());
        for entry in list_zip_images(path, extensions)? {
            files.push(FileEntry {
                name: entry
                    .name
                    .rsplit('/')
                    .next()
                    .unwrap_or(&entry.name)
                    .to_string(),
                path: crate::source::entry_path(path, &entry.name),
                extension: extension_of(Path::new(&entry.name)),
                size: entry.size,
                // The archive's own time: an entry has none that survives the
                // trip between the tools that made it.
                modified,
                directory: false,
            });
        }
        return Ok(());
    }

    // A format the drive cannot read, which can be turned into one it can.
    // The converted copy is cached beside the extracted archives and behaves
    // from here on like any other file; the original is never modified.
    if convert {
        if let Some(conversion) = Conversion::for_path(path) {
            if extensions.contains(conversion.target_extension()) {
                if let Some(entry) = converted_copy(app, path, conversion)? {
                    files.push(entry);
                }
            }
        }
    }
    Ok(())
}

/// Converts one file into the cache, reusing an earlier conversion.
///
/// A file that cannot be converted is skipped rather than failing the scan: one
/// malformed image in a library of thousands should not stop the rest, and the
/// user will see it simply did not appear.
fn converted_copy(
    app: &tauri::AppHandle,
    path: &Path,
    conversion: Conversion,
) -> Result<Option<FileEntry>> {
    let folder = converted_folder(app, path)?;
    let name = format!(
        "{}.{}",
        path.file_stem().unwrap_or_default().to_string_lossy(),
        conversion.target_extension()
    );
    let output = folder.join(&name);
    if output.is_file() {
        return Ok(Some(entry_at(&output)?));
    }

    let source = fs::read(path).with_context(|| format!("Unable to read {}", path.display()))?;
    let Ok(converted) = conversion.apply(&source) else {
        return Ok(None);
    };
    // Written under a temporary name so an interrupted conversion cannot be
    // mistaken for a finished one on the next scan.
    let temporary = output.with_extension("part");
    fs::write(&temporary, &converted)?;
    fs::rename(&temporary, &output)?;
    Ok(Some(entry_at(&output)?))
}

#[cfg(test)]
mod tests {
    use crate::paths::{extension_of, sort_entries, FileEntry};
    use std::path::Path;

    // `scan_folder`, `list_directory`, and `list_image_directory` need a Tauri
    // AppHandle or a real FAT fixture; their pure parts are covered in
    // `paths` and `archive`. This keeps the ordering contract checked here.
    #[test]
    fn scan_results_are_ordered_by_name_then_path() {
        let mut entries = vec![
            FileEntry {
                name: "b.ssd".into(),
                path: "/library/b.ssd".into(),
                extension: extension_of(Path::new("b.ssd")),
                size: 0,
                modified: None,
                directory: false,
            },
            FileEntry {
                name: "A.ssd".into(),
                path: "/library/A.ssd".into(),
                extension: extension_of(Path::new("A.ssd")),
                size: 0,
                modified: None,
                directory: false,
            },
        ];

        sort_entries(&mut entries);

        assert_eq!(entries[0].name, "A.ssd");
    }
}

#[cfg(test)]
mod walk_tests {
    use super::Walk;
    use std::{
        path::{Path, PathBuf},
        thread,
    };

    #[test]
    fn a_parallel_walk_finishes_when_the_queue_drains() {
        // The subtle part of walking in parallel: an empty queue does not mean
        // the walk is over while a worker is still inside a folder that may
        // add more. Every worker must leave, and none may leave early.
        let work = Walk::new(PathBuf::from("/root"));
        let taken = std::sync::atomic::AtomicUsize::new(0);

        thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(|| {
                    while let Some(folder) = work.take() {
                        taken.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        // The root yields two children; they yield none.
                        let children = if folder.as_path() == Path::new("/root") {
                            vec![PathBuf::from("/root/a"), PathBuf::from("/root/b")]
                        } else {
                            Vec::new()
                        };
                        work.done(folder, children, Vec::new());
                    }
                });
            }
        });

        assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 3);
        assert!(
            work.progress().is_none(),
            "a drained walk reports no progress"
        );
    }
}
