//! Locations for everything the application caches on disk.
//!
//! All roots come from Tauri's platform-aware `app_cache_dir`, which resolves
//! to `~/.cache/<id>` on Linux, `~/Library/Caches/<id>` on macOS, and
//! `%LOCALAPPDATA%\<id>` on Windows. Nothing here reads `HOME` or `XDG_*`
//! directly, so the cache lands in the right place on every platform and inside
//! sandboxed installations.

use crate::error::{Context, Result};
use crate::paths::extension_of;
use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri::Manager;

/// Reduces any string to characters that are legal in a filename on every
/// supported platform.
pub fn safe_cache_part(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('.')
        .to_string()
}

fn cache_root(app: &tauri::AppHandle) -> Result<PathBuf> {
    app.path()
        .app_cache_dir()
        .context("Unable to resolve the application cache folder")
}

/// Cached provider catalogues and downloads, grouped per provider.
pub fn online_root(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(cache_root(app)?.join("online-library"))
}

pub fn catalogue_folder(app: &tauri::AppHandle) -> Result<PathBuf> {
    let folder = online_root(app)?.join("catalogues");
    fs::create_dir_all(&folder)?;
    Ok(folder)
}

pub fn catalogue_file(app: &tauri::AppHandle, provider_id: &str, platform_id: &str) -> Result<PathBuf> {
    Ok(online_root(app)?.join("catalogues").join(format!(
        "{}--{}.json",
        safe_cache_part(provider_id),
        safe_cache_part(platform_id)
    )))
}

pub fn download_folder(app: &tauri::AppHandle, provider_id: &str, remote_id: &str) -> Result<PathBuf> {
    let folder = online_root(app)?
        .join("downloads")
        .join(safe_cache_part(provider_id))
        .join(safe_cache_part(remote_id));
    fs::create_dir_all(&folder)?;
    Ok(folder)
}

/// Where a converted copy of a file is kept.
///
/// The original is never touched. The folder is named after the file's identity
/// so that editing or replacing it produces a new folder rather than serving a
/// stale conversion.
pub fn converted_folder(app: &tauri::AppHandle, source: &Path) -> Result<PathBuf> {
    let metadata = fs::metadata(source)
        .with_context(|| format!("Unable to read {}", source.display()))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs())
        .unwrap_or_default();
    let name = source.file_stem().unwrap_or_default().to_string_lossy();
    let identity = safe_cache_part(&format!("{name}-{}-{modified}", metadata.len()));
    let folder = cache_root(app)?.join("converted").join(identity);
    fs::create_dir_all(&folder)?;
    Ok(folder)
}

/// True when a name looks like an archive the scanner should look inside.
pub fn is_archive(path: &Path) -> bool {
    extension_of(path) == "zip"
}

#[cfg(test)]
mod tests {
    use super::safe_cache_part;

    #[test]
    fn cache_names_strip_separators_and_leading_dots() {
        assert_eq!(safe_cache_part("bbc/elite (1984).ssd"), "bbc_elite__1984_.ssd");
        // Separators become underscores, so no traversal survives.
        assert_eq!(safe_cache_part("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_cache_part("..."), "");
    }
}

// ---------------------------------------------------------------------------
// Size accounting and eviction
// ---------------------------------------------------------------------------

use serde::{Deserialize, Serialize};

/// What the download cache currently holds.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheSummary {
    pub total_bytes: u64,
    pub download_count: usize,
    pub catalogue_count: usize,
}

/// One cached download, for eviction decisions.
#[derive(Debug, Clone)]
pub struct CacheEntry {
    pub folder: PathBuf,
    pub bytes: u64,
    /// When this download was last served, so the least useful goes first.
    pub last_used: u64,
}

fn folder_bytes(folder: &Path) -> u64 {
    let mut total = 0;
    let mut pending = vec![folder.to_path_buf()];
    while let Some(current) = pending.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            match entry.metadata() {
                Ok(metadata) if metadata.is_dir() => pending.push(entry.path()),
                Ok(metadata) => total += metadata.len(),
                Err(_) => {}
            }
        }
    }
    total
}

/// The `last_used` stamp a download recorded, falling back to its modification
/// time so a cache written by an older version still ages sensibly.
fn last_used(folder: &Path) -> u64 {
    #[derive(Deserialize)]
    struct Stamp {
        #[serde(rename = "lastUsed", default)]
        last_used: Option<u64>,
    }
    if let Ok(bytes) = fs::read(folder.join("download.json")) {
        if let Ok(stamp) = serde_json::from_slice::<Stamp>(&bytes) {
            if let Some(value) = stamp.last_used {
                return value;
            }
        }
    }
    fs::metadata(folder)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

/// Every cached download beneath an online-library root.
pub fn entries(online_root: &Path) -> Vec<CacheEntry> {
    let downloads = online_root.join("downloads");
    let mut found = Vec::new();
    let Ok(providers) = fs::read_dir(&downloads) else {
        return found;
    };
    for provider in providers.flatten().filter(|entry| entry.path().is_dir()) {
        let Ok(items) = fs::read_dir(provider.path()) else {
            continue;
        };
        for item in items.flatten().filter(|entry| entry.path().is_dir()) {
            let folder = item.path();
            found.push(CacheEntry {
                bytes: folder_bytes(&folder),
                last_used: last_used(&folder),
                folder,
            });
        }
    }
    found
}

pub fn summarise(online_root: &Path) -> CacheSummary {
    let downloads = entries(online_root);
    let catalogues = fs::read_dir(online_root.join("catalogues"))
        .map(|entries| entries.flatten().count())
        .unwrap_or(0);
    CacheSummary {
        total_bytes: downloads.iter().map(|entry| entry.bytes).sum(),
        download_count: downloads.len(),
        catalogue_count: catalogues,
    }
}

/// Removes the least recently used downloads until the cache fits.
///
/// Cached catalogues are never evicted: they are small, and losing them would
/// take the collection-coverage comparison offline for no meaningful gain.
pub fn evict_to_fit(online_root: &Path, max_bytes: u64) -> Result<Vec<String>> {
    let mut downloads = entries(online_root);
    let mut total: u64 = downloads.iter().map(|entry| entry.bytes).sum();
    if total <= max_bytes {
        return Ok(Vec::new());
    }
    // Oldest first, so what goes is what has been useful least recently.
    downloads.sort_by_key(|entry| entry.last_used);

    let mut removed = Vec::new();
    for entry in downloads {
        if total <= max_bytes {
            break;
        }
        fs::remove_dir_all(&entry.folder)
            .with_context(|| format!("Unable to remove {}", entry.folder.display()))?;
        total = total.saturating_sub(entry.bytes);
        removed.push(entry.folder.to_string_lossy().into_owned());
    }
    Ok(removed)
}

#[tauri::command]
pub async fn cache_summary(app: tauri::AppHandle) -> Result<CacheSummary> {
    let root = online_root(&app)?;
    crate::task::blocking(move || Ok(summarise(&root))).await
}

#[tauri::command]
pub async fn evict_cache(app: tauri::AppHandle, max_bytes: u64) -> Result<Vec<String>> {
    let root = online_root(&app)?;
    crate::task::blocking(move || evict_to_fit(&root, max_bytes)).await
}

/// Empties the download cache entirely. Catalogues are kept.
#[tauri::command]
pub async fn clear_download_cache(app: tauri::AppHandle) -> Result<Vec<String>> {
    let root = online_root(&app)?;
    crate::task::blocking(move || evict_to_fit(&root, 0)).await
}

#[cfg(test)]
mod cache_tests {
    use super::{entries, evict_to_fit, summarise};
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    fn fixture(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "gotek-cachetest-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn download(root: &Path, provider: &str, item: &str, bytes: usize, last_used: u64) {
        let folder = root.join("downloads").join(provider).join(item);
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("image.ssd"), vec![0u8; bytes]).unwrap();
        fs::write(
            folder.join("download.json"),
            format!(r#"{{"sourceUrl":"https://x/{item}","files":["image.ssd"],"lastUsed":{last_used}}}"#),
        )
        .unwrap();
    }

    #[test]
    fn the_cache_reports_what_it_holds() {
        let root = fixture("summary");
        download(&root, "archive", "elite", 1000, 10);
        download(&root, "archive", "repton", 2000, 20);
        fs::create_dir_all(root.join("catalogues")).unwrap();
        fs::write(root.join("catalogues/a--bbc.json"), b"[]").unwrap();

        let summary = summarise(&root);

        assert_eq!(summary.download_count, 2);
        assert_eq!(summary.catalogue_count, 1);
        // The metadata file counts too; the point is the total is real.
        assert!(summary.total_bytes > 3000);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn eviction_removes_the_least_recently_used_first() {
        let root = fixture("evict");
        download(&root, "archive", "oldest", 4000, 10);
        download(&root, "archive", "newest", 4000, 99);

        let removed = evict_to_fit(&root, 5000).unwrap();

        assert_eq!(removed.len(), 1);
        assert!(removed[0].ends_with("oldest"));
        assert!(root.join("downloads/archive/newest").exists());
        assert!(!root.join("downloads/archive/oldest").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_cache_already_within_its_limit_is_left_alone() {
        let root = fixture("within");
        download(&root, "archive", "elite", 100, 10);

        assert!(evict_to_fit(&root, 10_000_000).unwrap().is_empty());
        assert_eq!(entries(&root).len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clearing_removes_every_download_but_keeps_catalogues() {
        let root = fixture("clear");
        download(&root, "archive", "elite", 100, 10);
        fs::create_dir_all(root.join("catalogues")).unwrap();
        fs::write(root.join("catalogues/a--bbc.json"), b"[]").unwrap();

        evict_to_fit(&root, 0).unwrap();

        assert!(entries(&root).is_empty());
        // Losing these would take coverage comparison offline for no gain.
        assert!(root.join("catalogues/a--bbc.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
