//! Safe extraction of disk images from ZIP archives.
//!
//! Archives are never modified. Only entries whose extension is supported by
//! the active platform are written, always beneath an `images` folder inside
//! the cache, and always through `enclosed_name` so a crafted archive cannot
//! escape the destination.

use crate::error::{Context, Error, Result};
use crate::paths::{extension_of, to_posix};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

/// Refuses to write more than this from a single archive, so a zip bomb cannot
/// fill the cache volume.
pub const EXTRACT_BYTE_LIMIT: u64 = 4 * 1024 * 1024 * 1024;

/// Caps the number of entries inspected in one archive.
const MAX_ENTRIES: usize = 1000;

const MANIFEST: &str = "images.json";

#[derive(Serialize, Deserialize)]
struct Manifest {
    /// The extensions the images were selected for. A different platform
    /// profile needs a fresh extraction.
    extensions: Vec<String>,
    files: Vec<String>,
}

fn images_folder(folder: &Path) -> PathBuf {
    folder.join("images")
}

/// Extracts every supported image, replacing anything previously extracted.
///
/// Returns the extracted paths relative to `folder`, which is empty when the
/// archive holds nothing for this platform. That is a normal outcome, not a
/// failure: a library folder may contain documentation or unrelated archives.
pub fn extract_zip_images(
    archive_path: &Path,
    folder: &Path,
    extensions: &HashSet<String>,
    byte_limit: u64,
) -> Result<Vec<String>> {
    let images = images_folder(folder);
    if images.exists() {
        fs::remove_dir_all(&images)?;
    }
    fs::create_dir_all(&images)?;

    let file = fs::File::open(archive_path)
        .with_context(|| format!("Unable to open {}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .with_context(|| format!("{} is not a valid ZIP archive", archive_path.display()))?;

    let mut extracted = Vec::new();
    let mut extracted_bytes = 0u64;
    for index in 0..archive.len().min(MAX_ENTRIES) {
        let item = archive.by_index(index)?;
        if !item.is_file() {
            continue;
        }
        // `enclosed_name` returns None for absolute paths and any entry that
        // would escape the destination folder.
        let Some(relative) = item.enclosed_name() else {
            continue;
        };
        if !extensions.contains(&extension_of(&relative)) {
            continue;
        }
        let remaining = byte_limit
            .checked_sub(extracted_bytes)
            .context("Extracted images exceed the cache limit.")?;
        let output_path = images.join(&relative);
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = fs::File::create(&output_path)?;
        // Reading one byte past the budget detects an oversized entry without
        // trusting the size recorded in the archive's own header.
        let copied = std::io::copy(&mut item.take(remaining + 1), &mut output)?;
        if copied > remaining {
            drop(output);
            let _ = fs::remove_dir_all(&images);
            return Err(Error::new("Extracted images exceed the cache limit."));
        }
        extracted_bytes += copied;
        extracted.push(relative_to(&output_path, folder));
    }
    extracted.sort();
    write_manifest(folder, extensions, &extracted)?;
    Ok(extracted)
}

/// Extracts an archive only when the cache does not already hold its images for
/// these extensions, mirroring how online downloads are reused.
pub fn cached_zip_images(
    archive_path: &Path,
    folder: &Path,
    extensions: &HashSet<String>,
    byte_limit: u64,
) -> Result<Vec<String>> {
    if let Some(files) = read_manifest(folder, extensions) {
        return Ok(files);
    }
    extract_zip_images(archive_path, folder, extensions, byte_limit)
}

fn relative_to(path: &Path, folder: &Path) -> String {
    to_posix(
        &path
            .strip_prefix(folder)
            .unwrap_or(path)
            .to_string_lossy(),
    )
}

fn sorted(extensions: &HashSet<String>) -> Vec<String> {
    let mut values = extensions.iter().cloned().collect::<Vec<_>>();
    values.sort();
    values
}

fn write_manifest(folder: &Path, extensions: &HashSet<String>, files: &[String]) -> Result<()> {
    let manifest = Manifest {
        extensions: sorted(extensions),
        files: files.to_vec(),
    };
    fs::write(folder.join(MANIFEST), serde_json::to_vec_pretty(&manifest)?)?;
    Ok(())
}

fn read_manifest(folder: &Path, extensions: &HashSet<String>) -> Option<Vec<String>> {
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(folder.join(MANIFEST)).ok()?).ok()?;
    if manifest.extensions != sorted(extensions) {
        return None;
    }
    manifest
        .files
        .iter()
        .all(|file| folder.join(file).is_file())
        .then_some(manifest.files)
}

#[cfg(test)]
mod tests {
    use super::{cached_zip_images, extract_zip_images, EXTRACT_BYTE_LIMIT};
    use crate::paths::normalise_extensions;
    use std::{fs, io::Write, path::PathBuf};

    fn fixture(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "gotek-archive-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_archive(path: &PathBuf, entries: &[(&str, &[u8])]) {
        let mut archive = zip::ZipWriter::new(fs::File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        for (name, content) in entries {
            archive.start_file(*name, options).unwrap();
            archive.write_all(content).unwrap();
        }
        archive.finish().unwrap();
    }

    #[test]
    fn only_supported_images_are_extracted() {
        let root = fixture("supported");
        let archive = root.join("collection.zip");
        write_archive(
            &archive,
            &[
                ("Games/Elite.SSD", b"disk image"),
                ("Notes/readme.txt", b"notes"),
            ],
        );
        let extensions = normalise_extensions(vec!["ssd".into()]);

        let files =
            extract_zip_images(&archive, &root, &extensions, EXTRACT_BYTE_LIMIT).unwrap();

        assert_eq!(files, vec!["images/Games/Elite.SSD".to_string()]);
        assert_eq!(fs::read(root.join(&files[0])).unwrap(), b"disk image");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_archive_without_supported_images_is_not_an_error() {
        let root = fixture("unsupported");
        let archive = root.join("documents.zip");
        write_archive(&archive, &[("manual.txt", b"how to use a gotek")]);

        let files = extract_zip_images(
            &archive,
            &root,
            &normalise_extensions(vec!["ssd".into()]),
            EXTRACT_BYTE_LIMIT,
        )
        .unwrap();

        assert!(files.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn oversized_entries_are_refused_and_leave_nothing_behind() {
        let root = fixture("oversized");
        let archive = root.join("big.zip");
        write_archive(&archive, &[("Big.adf", &[0u8; 4096])]);

        let error = extract_zip_images(
            &archive,
            &root,
            &normalise_extensions(vec!["adf".into()]),
            64,
        )
        .unwrap_err();

        assert_eq!(error.to_string(), "Extracted images exceed the cache limit.");
        assert!(!root.join("images").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_cached_archive_is_reused_until_the_platform_formats_change() {
        let root = fixture("cached");
        let archive = root.join("collection.zip");
        write_archive(&archive, &[("Elite.ssd", b"disk"), ("Elite.adf", b"amiga")]);
        let bbc = normalise_extensions(vec!["ssd".into()]);

        let first = cached_zip_images(&archive, &root, &bbc, EXTRACT_BYTE_LIMIT).unwrap();
        // Removing the archive proves the second call served the cache.
        fs::remove_file(&archive).unwrap();
        let second = cached_zip_images(&archive, &root, &bbc, EXTRACT_BYTE_LIMIT).unwrap();

        assert_eq!(first, second);
        assert_eq!(first, vec!["images/Elite.ssd".to_string()]);

        let amiga = normalise_extensions(vec!["adf".into()]);
        assert!(cached_zip_images(&archive, &root, &amiga, EXTRACT_BYTE_LIMIT).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
