//! Where a title's bytes actually live.
//!
//! Most titles are files. Some are entries inside a ZIP archive, and those are
//! addressed by the archive's path, `!/`, and the entry's path inside it:
//!
//! ```text
//! /library/Elite (1988).zip!/Elite.adf
//! ```
//!
//! The point of the convention is that everything downstream — the library, the
//! digest cache, a transfer operation, the plan the user approves — carries one
//! kind of thing: a string that says where the bytes are. Only this module
//! knows the difference, and it is the single place that opens a source, so
//! comparing, fingerprinting and copying all gained archive support at once
//! rather than three times over.
//!
//! Nothing is unpacked to disk. An entry is decompressed as it is read, which
//! is what lets a folder of a few thousand archives be listed in seconds.

use crate::archive;
use crate::error::{Context, Result};
use crate::fingerprint::Stat;
use crate::paths::extension_of;
use std::{fs, io::Read, path::Path, time::UNIX_EPOCH};

/// Separates an archive from the entry inside it.
pub const ENTRY_SEPARATOR: &str = "!/";

/// The archive and entry a path names, when it names one at all.
///
/// The separator alone is not enough to decide: a folder could contain it. The
/// left-hand side must actually be an archive, which is what stops an ordinary
/// path with an unusual name being read as something it is not.
pub fn split(path: &Path) -> Option<(&Path, &str)> {
    let text = path.to_str()?;
    let (archive, entry) = text.split_once(ENTRY_SEPARATOR)?;
    let archive = Path::new(archive);
    (extension_of(archive) == "zip" && !entry.is_empty()).then_some((archive, entry))
}

/// Builds the path that names one entry inside an archive.
pub fn entry_path(archive: &Path, entry: &str) -> String {
    format!("{}{ENTRY_SEPARATOR}{entry}", archive.to_string_lossy())
}

/// The size and modification time of a source, or `None` when it is not there.
///
/// An entry takes its archive's modification time: the entry has none of its
/// own that can be trusted across tools, and what matters to the digest cache
/// is whether the bytes could have changed since they were last read.
///
/// `expected` is the size the library recorded when it listed the source. For a
/// file it is only a check; for an archive entry it is the answer, because
/// reading it back out of the archive means opening the archive, and a library
/// of a few thousand entries would open a few thousand archives to learn what
/// it already knew. The archive's own modification time still decides whether
/// what was recorded can still be believed.
pub fn stat(path: &Path, expected: Option<u64>) -> Result<Option<Stat>> {
    let Some((archive, entry)) = split(path) else {
        return Ok(fs::metadata(path)
            .ok()
            .filter(|metadata| metadata.is_file())
            .map(|metadata| Stat::of(&metadata)));
    };
    let Ok(metadata) = fs::metadata(archive) else {
        return Ok(None);
    };
    let size = match expected {
        Some(size) => size,
        None => match archive::zip_entry_size(archive, entry)? {
            Some(size) => size,
            None => return Ok(None),
        },
    };
    Ok(Some(Stat {
        size,
        modified: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs() as i64)
            .unwrap_or(0),
    }))
}

/// Hands the source's contents to the caller, wherever they live.
pub fn read_with<T>(path: &Path, read: impl FnOnce(&mut dyn Read) -> Result<T>) -> Result<T> {
    match split(path) {
        Some((archive, entry)) => archive::read_zip_entry(archive, entry, read),
        None => {
            let mut file = fs::File::open(path)
                .with_context(|| format!("Unable to read {}", path.display()))?;
            read(&mut file)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{entry_path, split, ENTRY_SEPARATOR};
    use std::path::Path;

    #[test]
    fn an_entry_inside_an_archive_is_recognised() {
        let path = Path::new("/library/Elite (1988).zip!/disks/Elite.adf");
        let (archive, entry) = split(path).expect("an archive entry");

        assert_eq!(archive, Path::new("/library/Elite (1988).zip"));
        assert_eq!(entry, "disks/Elite.adf");
        assert_eq!(
            entry_path(archive, entry),
            format!("/library/Elite (1988).zip{ENTRY_SEPARATOR}disks/Elite.adf")
        );
    }

    #[test]
    fn an_ordinary_path_is_never_read_as_an_archive_entry() {
        // A file is a file even when its name contains the separator, because
        // what precedes it is not an archive.
        assert!(split(Path::new("/library/Elite.adf")).is_none());
        assert!(split(Path::new("/library/odd!/name.adf")).is_none());
        // An archive with nothing named after it addresses no entry.
        assert!(split(Path::new("/library/Elite.zip!/")).is_none());
        // The extension is read without regard to case, as everywhere else.
        assert!(split(Path::new("/library/Elite.ZIP!/Elite.adf")).is_some());
    }
}
