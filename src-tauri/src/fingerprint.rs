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

use crate::error::Result;
use crate::paths::sha256_reader;
use crate::store;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::{collections::HashMap, fs, path::Path};
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

/// The digest of whatever the path names, file or archive entry alike.
fn digest_of(path: &Path) -> Result<String> {
    crate::source::read_with(path, |reader| {
        Ok(sha256_reader(reader)?
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect())
    })
}

/// A file the caller has already looked at, so it need not be looked at again.
#[derive(Debug, Clone, Copy)]
pub struct Stat {
    pub size: u64,
    pub modified: i64,
}

impl Stat {
    pub fn of(metadata: &fs::Metadata) -> Self {
        Self {
            size: metadata.len(),
            modified: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|value| value.as_secs() as i64)
                .unwrap_or(0),
        }
    }
}

/// Every digest already known, held for the length of one operation.
///
/// Loading the table once and consulting it in memory replaces a query per
/// file. Over a few thousand files that is the difference between a fifth of a
/// second and nothing, and the comparison runs on every change to a profile.
pub struct DigestCache {
    entries: HashMap<String, (u64, i64, String)>,
}

impl DigestCache {
    pub fn load(connection: &Connection) -> Result<Self> {
        let mut statement =
            connection.prepare("SELECT path, size, modified, sha256 FROM digests")?;
        let entries = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (
                        row.get::<_, i64>(1)? as u64,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ),
                ))
            })?
            .collect::<std::result::Result<HashMap<_, _>, _>>()?;
        Ok(Self { entries })
    }

    fn get(&self, path: &str, stat: Stat) -> Option<&str> {
        self.entries
            .get(path)
            .filter(|(size, modified, _)| *size == stat.size && *modified == stat.modified)
            .map(|(_, _, sha256)| sha256.as_str())
    }

    /// The digest of a file whose metadata the caller already has.
    ///
    /// Taking the stat as an argument is the point: the destination walk and
    /// the source check have both already looked at the file, and looking again
    /// doubles the cost of the whole comparison for nothing.
    pub fn digest(
        &mut self,
        connection: &Connection,
        path: &Path,
        stat: Stat,
    ) -> Result<String> {
        let key = path.to_string_lossy().into_owned();
        if let Some(sha256) = self.get(&key, stat) {
            return Ok(sha256.to_string());
        }
        let sha256 = digest_of(path)?;
        connection.execute(
            "INSERT OR REPLACE INTO digests (path, size, modified, sha256) VALUES (?1,?2,?3,?4)",
            params![key, stat.size as i64, stat.modified, sha256],
        )?;
        self.entries
            .insert(key, (stat.size, stat.modified, sha256.clone()));
        Ok(sha256)
    }
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
    cache: &mut DigestCache,
    files: &[(String, Stat)],
    on_progress: OnProgress<'_>,
) -> Result<Vec<Fingerprint>> {
    let total = files.len();
    let mut results = Vec::with_capacity(total);
    for (index, (path, stat)) in files.iter().enumerate() {
        // Reported before the read, so a slow file is visible while it is slow
        // rather than only after it finishes.
        on_progress(Progress {
            done: index,
            total,
            current: path.clone(),
        });
        if let Ok(sha256) = cache.digest(connection, Path::new(path), *stat) {
            results.push(Fingerprint {
                path: path.clone(),
                sha256,
                size: stat.size,
            });
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
        let mut cache = DigestCache::load(&connection)?;
        let files = paths
            .into_iter()
            .filter_map(|path| {
                let metadata = fs::metadata(&path).ok()?;
                metadata.is_file().then(|| (path, Stat::of(&metadata)))
            })
            .collect::<Vec<_>>();
        let mut report = emitter(&app);
        fingerprint_all(&connection, &mut cache, &files, &mut report)
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
    use super::{digest_of, DigestCache, Stat};
    use rusqlite::Connection;
    use std::{fs, path::{Path, PathBuf}};

    fn stat_of(path: &Path) -> Stat {
        Stat::of(&fs::metadata(path).unwrap())
    }

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
    fn a_file_is_read_once_and_remembered() {
        let root = fixture("cache");
        let connection = connection();
        let file = root.join("Elite.dsk");
        fs::write(&file, b"disk").unwrap();
        let stat = stat_of(&file);

        let mut cache = DigestCache::load(&connection).unwrap();
        let first = cache.digest(&connection, &file, stat).unwrap();

        // Removing the file proves the second answer never touched the disk:
        // this is what stops a library being re-read on every comparison.
        fs::remove_file(&file).unwrap();
        let second = cache.digest(&connection, &file, stat).unwrap();
        assert_eq!(first, second);

        // And it survives a restart, because it is in the database.
        let mut reopened = DigestCache::load(&connection).unwrap();
        assert_eq!(reopened.digest(&connection, &file, stat).unwrap(), first);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_changed_file_is_read_again_rather_than_trusted() {
        let root = fixture("changed");
        let connection = connection();
        let file = root.join("Elite.dsk");
        fs::write(&file, b"first").unwrap();
        let mut cache = DigestCache::load(&connection).unwrap();
        let before = cache.digest(&connection, &file, stat_of(&file)).unwrap();

        fs::write(&file, b"second version").unwrap();
        let after = cache.digest(&connection, &file, stat_of(&file)).unwrap();

        // A different length invalidates the entry on its own.
        assert_ne!(before, after);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn contents_that_change_without_changing_length_are_still_noticed() {
        let root = fixture("same-length");
        let connection = connection();
        let file = root.join("Elite.dsk");
        fs::write(&file, b"aaaa").unwrap();
        let mut cache = DigestCache::load(&connection).unwrap();
        let before = cache.digest(&connection, &file, stat_of(&file)).unwrap();

        // Same size, different bytes: only the modification time separates
        // them, which is why it is part of the key.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        fs::write(&file, b"bbbb").unwrap();
        let after = cache.digest(&connection, &file, stat_of(&file)).unwrap();

        assert_ne!(before, after);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_missing_file_reports_a_failure_rather_than_a_wrong_answer() {
        let root = fixture("missing");
        let connection = connection();
        let mut cache = DigestCache::load(&connection).unwrap();

        let outcome = cache.digest(
            &connection,
            &root.join("nope.dsk"),
            super::Stat {
                size: 4,
                modified: 0,
            },
        );

        assert!(outcome.is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
