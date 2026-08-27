//! Path, filesystem-entry, and comparison helpers shared by every command.
//!
//! Everything here is written to behave identically on Linux, macOS, and
//! Windows. Where behaviour genuinely differs the operating system is passed in
//! as a parameter so the rule can be unit-tested from any host.

use crate::error::{Context, Error, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

/// A file or folder as presented to the frontend.
///
/// `path` is a native absolute path for real filesystem entries and a
/// `/`-separated path inside the container for entries read out of a FAT image.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub extension: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<u64>,
    pub directory: bool,
}

pub fn file_entry(path: &Path, metadata: fs::Metadata) -> FileEntry {
    FileEntry {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: path.to_string_lossy().into_owned(),
        extension: extension_of(path),
        size: metadata.len(),
        modified: metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs()),
        directory: metadata.is_dir(),
    }
}

pub fn entry_at(path: &Path) -> Result<FileEntry> {
    let metadata =
        fs::metadata(path).with_context(|| format!("Unable to read {}", path.display()))?;
    Ok(file_entry(path, metadata))
}

/// Lowercase extension without the leading dot, or an empty string.
pub fn extension_of(path: &Path) -> String {
    path.extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase()
}

/// Accepts `.SSD`, `ssd`, or `SSD` and yields a comparable `ssd`.
pub fn normalise_extensions<I>(values: I) -> HashSet<String>
where
    I: IntoIterator<Item = String>,
{
    values
        .into_iter()
        .map(|value| value.trim_start_matches('.').to_lowercase())
        .filter(|value| !value.is_empty())
        .collect()
}

/// Folders first, then files, each alphabetically and case-insensitively.
pub fn sort_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|left, right| {
        (!left.directory, left.name.to_lowercase())
            .cmp(&(!right.directory, right.name.to_lowercase()))
    });
}

/// Windows canonicalisation returns verbatim (`\\?\`) paths, which compare
/// unequal to the drive-letter form that `sysinfo` reports for mount points and
/// which users never expect to see. Removing the prefix keeps path comparison
/// and display consistent across platforms.
pub fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        let mut characters = rest.chars();
        let drive_letter = matches!(
            (characters.next(), characters.next()),
            (Some(letter), Some(':')) if letter.is_ascii_alphabetic()
        );
        if drive_letter {
            return PathBuf::from(rest);
        }
    }
    path
}

/// Resolves symbolic links and relative segments, then normalises the result so
/// it can be compared with mount points and shown to the user.
pub fn canonical(path: &Path) -> Result<PathBuf> {
    let resolved = path
        .canonicalize()
        .with_context(|| format!("Unable to resolve {}", path.display()))?;
    Ok(strip_verbatim(resolved))
}

/// The canonical separator for every relative path exchanged with the frontend.
pub fn to_posix(value: &str) -> String {
    value.replace('\\', "/")
}

/// The key used to detect case-insensitive collisions on FAT destinations.
pub fn relative_key(value: &str) -> String {
    to_posix(value).to_lowercase()
}

/// Validates a destination-relative path.
///
/// Rejects absolute paths, drive prefixes, `.`/`..` traversal, and backslashes,
/// so a plan built on one operating system means exactly the same thing on
/// another.
pub fn safe_relative_path(value: &str) -> Result<PathBuf> {
    if value.is_empty() {
        return Err(Error::new("Unsafe destination path: the path is empty"));
    }
    if value.contains('\\') {
        return Err(Error::new(format!(
            "Unsafe destination path: use / to separate folders, not \\: {value}"
        )));
    }
    let path = Path::new(value);
    let safe = path
        .components()
        .all(|component| matches!(component, Component::Normal(_)));
    if !safe {
        return Err(Error::new(format!("Unsafe destination path: {value}")));
    }
    Ok(path.to_path_buf())
}

/// Joins a relative path onto a destination root, refusing to follow a symbolic
/// link at any level so a link inside the target cannot redirect a write
/// outside it.
pub fn safe_target_path(root: &Path, value: &str) -> Result<PathBuf> {
    let relative = safe_relative_path(value)?;
    let mut path = canonical(root)?;
    for component in relative.components() {
        path.push(component.as_os_str());
        let is_symlink =
            fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink());
        if is_symlink {
            return Err(Error::new(format!(
                "Symbolic links are not allowed in destination paths: {value}"
            )));
        }
    }
    Ok(path)
}

/// Fills `buffer` unless the reader is genuinely exhausted.
///
/// `Read::read` is allowed to return fewer bytes than requested at any time,
/// which network filesystems routinely do. Comparing raw `read` counts would
/// report two identical files as different, so every byte comparison goes
/// through this instead.
fn read_full(reader: &mut dyn Read, buffer: &mut [u8]) -> Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..])? {
            0 => break,
            count => filled += count,
        }
    }
    Ok(filled)
}

const COMPARE_BUFFER: usize = 64 * 1024;

/// Byte-for-byte comparison of two readable streams.
pub fn readers_equal(left: &mut dyn Read, right: &mut dyn Read) -> Result<bool> {
    let mut left_buffer = [0u8; COMPARE_BUFFER];
    let mut right_buffer = [0u8; COMPARE_BUFFER];
    loop {
        let left_read = read_full(left, &mut left_buffer)?;
        let right_read = read_full(right, &mut right_buffer)?;
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

pub fn files_equal(left: &Path, right: &Path) -> Result<bool> {
    let mut left = fs::File::open(left)?;
    let mut right = fs::File::open(right)?;
    readers_equal(&mut left, &mut right)
}

pub fn sha256_reader(reader: &mut dyn Read) -> Result<Vec<u8>> {
    let mut digest = Sha256::new();
    let mut buffer = [0u8; COMPARE_BUFFER];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(digest.finalize().to_vec())
}

pub fn file_size(path: &Path) -> Option<u64> {
    fs::metadata(path).ok().map(|metadata| metadata.len())
}

/// True when the file exists and is exactly the size that was indexed.
pub fn matches_indexed_size(path: &Path, expected: u64) -> bool {
    path.is_file() && file_size(path) == Some(expected)
}

#[cfg(test)]
mod tests {
    use super::{
        extension_of, normalise_extensions, readers_equal, relative_key, safe_relative_path,
        sort_entries, strip_verbatim, FileEntry,
    };
    use std::path::{Path, PathBuf};

    fn entry(name: &str, directory: bool) -> FileEntry {
        FileEntry {
            name: name.into(),
            path: name.into(),
            extension: extension_of(Path::new(name)),
            size: 0,
            modified: None,
            directory,
        }
    }

    #[test]
    fn extensions_are_compared_without_case_or_leading_dots() {
        assert_eq!(extension_of(Path::new("/library/Elite.SSD")), "ssd");
        assert_eq!(extension_of(Path::new("/library/README")), "");

        let normalised = normalise_extensions(vec![".SSD".into(), "DSD".into(), "".into()]);

        assert_eq!(normalised.len(), 2);
        assert!(normalised.contains("ssd"));
        assert!(normalised.contains("dsd"));
    }

    #[test]
    fn entries_list_folders_before_files() {
        let mut entries = vec![
            entry("zeta.adf", false),
            entry("Alpha", true),
            entry("alpha.adf", false),
        ];

        sort_entries(&mut entries);

        assert_eq!(entries[0].name, "Alpha");
        assert_eq!(entries[1].name, "alpha.adf");
        assert_eq!(entries[2].name, "zeta.adf");
    }

    #[test]
    fn windows_verbatim_prefixes_are_removed_so_mount_points_still_match() {
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\D:\GOTEK\BBC")),
            PathBuf::from(r"D:\GOTEK\BBC")
        );
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\UNC\nas\games")),
            PathBuf::from(r"\\nas\games")
        );
        assert_eq!(
            strip_verbatim(PathBuf::from("/media/gotek")),
            PathBuf::from("/media/gotek")
        );
    }

    #[test]
    fn relative_paths_reject_traversal_roots_and_backslashes() {
        assert!(safe_relative_path("BBC/Elite.ssd").is_ok());
        assert!(safe_relative_path("../outside.adf").is_err());
        assert!(safe_relative_path("/absolute.adf").is_err());
        assert!(safe_relative_path("").is_err());
        // Rejected on every platform so one plan means one thing everywhere.
        assert!(safe_relative_path(r"BBC\Elite.ssd").is_err());
    }

    #[test]
    fn relative_keys_fold_separators_and_case_for_fat_destinations() {
        assert_eq!(relative_key(r"BBC\Elite.SSD"), "bbc/elite.ssd");
        assert_eq!(relative_key("BBC/Elite.SSD"), "bbc/elite.ssd");
    }

    #[test]
    fn short_reads_do_not_make_identical_streams_look_different() {
        /// Returns one byte at a time, as a slow network mount may.
        struct Trickle(Vec<u8>, usize);
        impl std::io::Read for Trickle {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                if self.1 >= self.0.len() || buffer.is_empty() {
                    return Ok(0);
                }
                buffer[0] = self.0[self.1];
                self.1 += 1;
                Ok(1)
            }
        }

        let content = b"identical disk image".to_vec();
        let mut left = Trickle(content.clone(), 0);
        let mut right = std::io::Cursor::new(content);

        assert!(readers_equal(&mut left, &mut right).unwrap());
    }

    #[test]
    fn different_content_is_still_detected() {
        let mut left = std::io::Cursor::new(b"disk one".to_vec());
        let mut right = std::io::Cursor::new(b"disk two".to_vec());

        assert!(!readers_equal(&mut left, &mut right).unwrap());
    }
}
