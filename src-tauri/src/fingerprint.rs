//! Content fingerprints.
//!
//! A disk image is the same disk image whatever it happens to be called. The
//! application used to decide whether a title was already on the media by
//! working out the path it would be written to and looking there, which meant a
//! naming or folder-layout choice silently changed the answer: shorten a name
//! for a two-line display and a library that was entirely present reported as
//! entirely missing.
//!
//! Identity is therefore the SHA-256 of the contents. Naming and layout decide
//! only where a file is written, never whether it is considered present.
//!
//! The obvious cost is reading everything, which is real when a library lives
//! on a network share. Digests are cached in the database against the file's
//! size and modification time, so each file is read once and re-read only if it
//! actually changes. Progress is reported as it goes, because the first pass
//! over a few thousand files is not instant and silence looks like a hang.

use crate::error::{Context, Result};
use crate::paths::sha256_reader;
use crate::store;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::{fs, path::Path};
use tauri::Emitter;

/// Emitted while a batch is being fingerprinted.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: usize,
    pub total: usize,
    /// The file being read, so the user can see it is making headway.
    pub current: String,
}

pub const PROGRESS_EVENT: &str = "fingerprint:progress";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fingerprint {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

fn digest_of(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)
        .with_context(|| format!("Unable to read {}", path.display()))?;
    Ok(sha256_reader(&mut file)?
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// The digest of one file, read from the cache when the file has not changed.
///
/// Size and modification time together are what decide whether a cached digest
/// still applies. Neither is proof on its own, and together they are what every
/// backup tool in existence relies on.
pub fn cached_digest(connection: &Connection, path: &Path) -> Result<Option<Fingerprint>> {
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(None);
    };
    if !metadata.is_file() {
        return Ok(None);
    }
    let size = metadata.len();
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0);
    let key = path.to_string_lossy().into_owned();

    let cached: Option<String> = connection
        .query_row(
            "SELECT sha256 FROM digests WHERE path = ?1 AND size = ?2 AND modified = ?3",
            params![key, size as i64, modified],
            |row| row.get(0),
        )
        .ok();
    if let Some(sha256) = cached {
        return Ok(Some(Fingerprint {
            path: key,
            sha256,
            size,
        }));
    }

    let sha256 = digest_of(path)?;
    connection.execute(
        "INSERT OR REPLACE INTO digests (path, size, modified, sha256) VALUES (?1,?2,?3,?4)",
        params![key, size as i64, modified, sha256],
    )?;
    Ok(Some(Fingerprint {
        path: key,
        sha256,
        size,
    }))
}

/// Somewhere to report progress to.
///
/// Taking a callback rather than an `AppHandle` keeps every decision here
/// testable without a running application; only the command knows about Tauri.
pub type OnProgress<'a> = &'a mut dyn FnMut(Progress);

/// A progress sink for callers that have nowhere to report to.
#[cfg_attr(not(test), allow(dead_code))]
pub fn ignore_progress(_: Progress) {}

/// Fingerprints a batch, reporting progress as it goes.
///
/// A file that cannot be read is skipped rather than failing the batch: one
/// unreadable file in a library of thousands should not stop the rest.
pub fn fingerprint_all(
    connection: &Connection,
    paths: &[String],
    on_progress: OnProgress<'_>,
) -> Result<Vec<Fingerprint>> {
    let total = paths.len();
    let mut results = Vec::with_capacity(total);
    for (index, path) in paths.iter().enumerate() {
        // Reported before the read, so a slow file is visible while it is slow
        // rather than only after it finishes.
        on_progress(Progress {
            done: index,
            total,
            current: path.clone(),
        });
        if let Ok(Some(fingerprint)) = cached_digest(connection, Path::new(path)) {
            results.push(fingerprint);
        }
    }
    on_progress(Progress {
        done: total,
        total,
        current: String::new(),
    });
    Ok(results)
}

/// Reports progress to the window.
pub fn emitter(app: &tauri::AppHandle) -> impl FnMut(Progress) + '_ {
    move |progress| {
        let _ = app.emit(PROGRESS_EVENT, progress);
    }
}

#[tauri::command]
pub async fn fingerprint_paths(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<Vec<Fingerprint>> {
    crate::task::blocking(move || {
        let connection = store::connection(&app)?;
        let mut report = emitter(&app);
        fingerprint_all(&connection, &paths, &mut report)
    })
    .await
}

/// Forgets cached digests for files that no longer exist.
#[tauri::command]
pub async fn prune_digests(app: tauri::AppHandle) -> Result<usize> {
    crate::task::blocking(move || {
        let connection = store::connection(&app)?;
        let paths: Vec<String> = connection
            .prepare("SELECT path FROM digests")?
            .query_map([], |row| row.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut removed = 0;
        for path in paths {
            if !Path::new(&path).is_file() {
                connection.execute("DELETE FROM digests WHERE path = ?1", params![path])?;
                removed += 1;
            }
        }
        Ok(removed)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{cached_digest, digest_of};
    use rusqlite::Connection;
    use std::{fs, path::PathBuf};

    fn fixture(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "gotek-fingerprint-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        crate::store::prepare(&connection).unwrap();
        connection
    }

    #[test]
    fn the_same_contents_fingerprint_the_same_whatever_the_file_is_called() {
        let root = fixture("names");
        let content = vec![0xC9u8; 194_816];
        let first = root.join("Zynaps (1987)(Hewson Consultants).dsk");
        let second = root.join("Zynaps (1987)(Hewson.dsk");
        fs::write(&first, &content).unwrap();
        fs::write(&second, &content).unwrap();

        // This is the whole point: renaming for a two-line display must not
        // change whether the application thinks it already has the title.
        assert_eq!(digest_of(&first).unwrap(), digest_of(&second).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn different_contents_fingerprint_differently() {
        let root = fixture("differ");
        let first = root.join("a.dsk");
        let second = root.join("b.dsk");
        fs::write(&first, vec![0u8; 1024]).unwrap();
        fs::write(&second, vec![1u8; 1024]).unwrap();

        assert_ne!(digest_of(&first).unwrap(), digest_of(&second).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_digest_is_cached_and_reused() {
        let root = fixture("cache");
        let connection = connection();
        let file = root.join("Elite.dsk");
        fs::write(&file, b"disk").unwrap();

        let first = cached_digest(&connection, &file).unwrap().unwrap();
        let rows: i64 = connection
            .query_row("SELECT count(*) FROM digests", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1);

        // Removing the file proves the second answer came from the cache.
        fs::remove_file(&file).unwrap();
        assert!(cached_digest(&connection, &file).unwrap().is_none());
        assert!(!first.sha256.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_changed_file_is_read_again_rather_than_trusted() {
        let root = fixture("changed");
        let connection = connection();
        let file = root.join("Elite.dsk");
        fs::write(&file, b"first").unwrap();
        let before = cached_digest(&connection, &file).unwrap().unwrap();

        // A different length invalidates the cached digest on its own.
        fs::write(&file, b"second version").unwrap();
        let after = cached_digest(&connection, &file).unwrap().unwrap();

        assert_ne!(before.sha256, after.sha256);
        assert_eq!(after.size, 14);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_missing_file_is_not_an_error() {
        let root = fixture("missing");

        assert!(cached_digest(&connection(), &root.join("nope.dsk"))
            .unwrap()
            .is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
