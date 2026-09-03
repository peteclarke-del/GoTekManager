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
};

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
        let mut files = Vec::new();
        let mut pending = vec![root];
        while let Some(folder) = pending.pop() {
            let entries = fs::read_dir(&folder)
                .with_context(|| format!("Unable to read {}", folder.display()))?;
            for entry in entries.flatten() {
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                if file_type.is_symlink() {
                    continue;
                }
                if file_type.is_dir() {
                    pending.push(entry.path());
                } else if file_type.is_file() {
                    collect_file(&app, &entry.path(), &extensions, convert, &mut files)?;
                }
            }
        }
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

fn collect_file(
    app: &tauri::AppHandle,
    path: &Path,
    extensions: &HashSet<String>,
    convert: bool,
    files: &mut Vec<FileEntry>,
) -> Result<()> {
    if extensions.contains(&extension_of(path)) {
        if let Ok(metadata) = fs::metadata(path) {
            files.push(file_entry(path, metadata));
        }
        return Ok(());
    }

    // An archive is listed, never unpacked: its directory says what is inside
    // for the cost of a few small reads, and a title is read from the archive
    // if and when it is actually written. A folder of a few thousand archives
    // that holds nothing this application can use now says so in seconds.
    if is_archive(path) {
        let modified = fs::metadata(path)
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
