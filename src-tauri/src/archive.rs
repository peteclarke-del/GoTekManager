//! Reading disk images out of ZIP archives.
//!
//! A folder of archives is listed, not unpacked. Reading a zip's directory
//! costs a few small reads; decompressing every entry to find out what is
//! inside costs the whole archive, and over a network share that is the
//! difference between a moment and a very long wait — for a collection that
//! may hold nothing this application can use. A title inside an archive is
//! therefore a title like any other, read from the archive when it is actually
//! wanted. See `source.rs` for how such a title is addressed.
//!
//! Extraction still exists for downloads, where the bytes have already been
//! fetched and the cache is what the user gets to keep.
//!
//! Safe extraction of disk images from ZIP archives.
//!
//! Archives are never modified. Only entries whose extension is supported by
//! the active platform are written, always beneath an `images` folder inside
//! the cache, and always through `enclosed_name` so a crafted archive cannot
//! escape the destination.

use crate::error::{Context, Error, Result};
use crate::paths::{extension_of, to_posix};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

/// Caps the number of entries inspected in one archive.
const MAX_ENTRIES: usize = 1000;

/// One file inside an archive, as the listing sees it.
pub struct ArchiveEntry {
    /// The entry's path inside the archive, `/`-separated.
    pub name: String,
    /// The uncompressed size, which is what the file will occupy once written.
    pub size: u64,
}

/// The supported images an archive holds, without decompressing any of them.
///
/// Only the central directory and each entry's header are read, so listing a
/// thousand archives is a matter of seconds rather than of unpacking gigabytes.
/// An archive that cannot be opened at all lists nothing rather than failing:
/// one damaged file in a library of thousands should not stop the scan, and the
/// user sees it simply did not appear.
pub fn list_zip_images(
    archive_path: &Path,
    extensions: &HashSet<String>,
) -> Result<Vec<ArchiveEntry>> {
    let Ok(file) = fs::File::open(archive_path) else {
        return Ok(Vec::new());
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return Ok(Vec::new());
    };

    let mut entries = Vec::new();
    for index in 0..archive.len().min(MAX_ENTRIES) {
        let Ok(item) = archive.by_index(index) else {
            continue;
        };
        if !item.is_file() {
            continue;
        }
        // The same guard extraction uses: an entry that would escape its folder
        // is not one this application will ever read.
        let Some(relative) = item.enclosed_name() else {
            continue;
        };
        if !extensions.contains(&extension_of(&relative)) {
            continue;
        }
        entries.push(ArchiveEntry {
            name: to_posix(&relative.to_string_lossy()),
            size: item.size(),
        });
    }
    entries.sort_by_key(|entry| entry.name.to_lowercase());
    Ok(entries)
}

/// The uncompressed size of one entry, or `None` when the archive no longer
/// holds it.
pub fn zip_entry_size(archive_path: &Path, name: &str) -> Result<Option<u64>> {
    let file = fs::File::open(archive_path)
        .with_context(|| format!("Unable to open {}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .with_context(|| format!("{} is not a valid ZIP archive", archive_path.display()))?;
    Ok(archive.by_name(name).ok().map(|entry| entry.size()))
}

/// Hands one entry's contents to the caller, decompressing as it is read.
///
/// The reader is borrowed rather than returned because it borrows the archive:
/// a callback keeps both alive for exactly as long as the read takes, and
/// nothing is ever written to disk on the way.
pub fn read_zip_entry<T>(
    archive_path: &Path,
    name: &str,
    read: impl FnOnce(&mut dyn Read) -> Result<T>,
) -> Result<T> {
    let file = fs::File::open(archive_path)
        .with_context(|| format!("Unable to open {}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .with_context(|| format!("{} is not a valid ZIP archive", archive_path.display()))?;
    let mut entry = archive
        .by_name(name)
        .with_context(|| format!("{name} is no longer in {}", archive_path.display()))?;
    read(&mut entry)
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
    Ok(extracted)
}

fn relative_to(path: &Path, folder: &Path) -> String {
    to_posix(
        &path
            .strip_prefix(folder)
            .unwrap_or(path)
            .to_string_lossy(),
    )
}


#[cfg(test)]
mod tests {
    use super::{extract_zip_images, list_zip_images, read_zip_entry};

    /// Generous enough that a test never trips the limit by accident.
    const PLENTY: u64 = 4 * 1024 * 1024 * 1024;
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
    fn an_archive_is_listed_without_unpacking_anything() {
        let root = fixture("listed");
        let archive = root.join("collection.zip");
        write_archive(
            &archive,
            &[
                ("Games/Elite.SSD", b"disk image"),
                ("Notes/readme.txt", b"notes"),
                ("Repton.ssd", b"another disk"),
            ],
        );
        let extensions = normalise_extensions(vec!["ssd".into()]);

        let entries = list_zip_images(&archive, &extensions).unwrap();

        assert_eq!(
            entries.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(),
            vec!["Games/Elite.SSD", "Repton.ssd"],
        );
        // The uncompressed size, which is what the file will occupy once written.
        assert_eq!(entries[0].size, "disk image".len() as u64);
        // Nothing was written anywhere: that is the whole point of listing.
        assert!(!root.join("images").exists());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_collection_with_nothing_usable_lists_nothing_and_says_so_at_once() {
        // The case this was built for: thousands of archives of preservation
        // images a floppy emulator cannot load. Reading their directories is
        // cheap; unpacking them to find out was not.
        let root = fixture("preservation");
        let archive = root.join("game.zip");
        write_archive(&archive, &[("Game (1988).ipf", b"flux"), ("kick.rom", b"rom")]);

        let entries = list_zip_images(&archive, &normalise_extensions(vec!["adf".into()])).unwrap();

        assert!(entries.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_damaged_archive_lists_nothing_rather_than_stopping_the_scan() {
        let root = fixture("damaged");
        let archive = root.join("broken.zip");
        fs::write(&archive, b"this is not a zip file").unwrap();

        let entries = list_zip_images(&archive, &normalise_extensions(vec!["adf".into()])).unwrap();

        assert!(entries.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_entry_is_read_straight_out_of_the_archive() {
        let root = fixture("read-entry");
        let archive = root.join("collection.zip");
        write_archive(&archive, &[("Games/Elite.ssd", b"disk image")]);

        let read = read_zip_entry(&archive, "Games/Elite.ssd", |reader| {
            let mut buffer = Vec::new();
            std::io::Read::read_to_end(reader, &mut buffer)?;
            Ok(buffer)
        })
        .unwrap();

        assert_eq!(read, b"disk image");
        // An entry that has since left the archive is an error, not silence.
        assert!(read_zip_entry(&archive, "Games/Gone.ssd", |_| Ok(())).is_err());
        fs::remove_dir_all(root).unwrap();
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
            extract_zip_images(&archive, &root, &extensions, PLENTY).unwrap();

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
            PLENTY,
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
}
