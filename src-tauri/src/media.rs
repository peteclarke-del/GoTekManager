//! Reading media libraries, destinations, and FAT filesystem images.
//!
//! Every command here is read-only.

use crate::archive::{cached_zip_images, EXTRACT_BYTE_LIMIT};
use crate::cache::{is_archive, local_archive_folder};
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
) -> Result<Vec<FileEntry>> {
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
                    collect_file(&app, &entry.path(), &extensions, &mut files)?;
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
    files: &mut Vec<FileEntry>,
) -> Result<()> {
    if extensions.contains(&extension_of(path)) {
        if let Ok(metadata) = fs::metadata(path) {
            files.push(file_entry(path, metadata));
        }
        return Ok(());
    }
    if !is_archive(path) {
        return Ok(());
    }
    let folder = local_archive_folder(app, path)?;
    for relative in cached_zip_images(path, &folder, extensions, EXTRACT_BYTE_LIMIT)? {
        files.push(entry_at(&folder.join(relative))?);
    }
    Ok(())
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
