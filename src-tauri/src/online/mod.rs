//! Online catalogues: search, browse, and cached downloads.
//!
//! Every provider is an adapter behind one interface. Adding a site means
//! adding an adapter with its own terms review, rate limiting, and attribution;
//! nothing here performs generic scraping, bypasses authentication or payment,
//! or ignores a site's stated policy.

pub mod archive_org;
pub mod feed;
pub mod http;
pub mod robots;
pub mod website;

use crate::archive::extract_zip_images;
use crate::cache::{catalogue_file, catalogue_folder, download_folder, safe_cache_part};
use crate::error::{Context, Result};
use crate::paths::{entry_at, extension_of, normalise_extensions, sha256_reader, to_posix, FileEntry};
use crate::task::blocking;
use futures_util::StreamExt;
use http::{client, secure_url, DOWNLOAD_BYTE_LIMIT};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Adapter {
    InternetArchive,
    JsonFeed,
    HtmlSite,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineProvider {
    pub id: String,
    pub name: String,
    pub adapter: Adapter,
    pub catalog_url: Option<String>,
    pub query: Option<String>,
    pub platform_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineTitle {
    #[serde(default)]
    pub provider_id: String,
    pub remote_id: String,
    pub title: String,
    pub platform_id: Option<String>,
    pub extension: Option<String>,
    pub size: Option<u64>,
    pub download_url: Option<String>,
    pub details_url: Option<String>,
    pub license: Option<String>,
    pub updated: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalog {
    pub provider_id: String,
    pub platform_id: String,
    pub refreshed_at: u64,
    pub items: Vec<OnlineTitle>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedDownload {
    pub entries: Vec<FileEntry>,
    pub cache_path: String,
    pub reused: bool,
    pub source_url: String,
    pub license: Option<String>,
}

/// The concrete file an adapter decided to fetch for a title.
pub struct ResolvedDownload {
    pub url: String,
    pub name: String,
    pub size: Option<u64>,
    pub license: Option<String>,
}

/// Provenance for a cached download, so a later run can reuse it and the
/// library can always say where a file came from.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadMetadata {
    source_url: String,
    updated: Option<String>,
    files: Vec<String>,
    license: Option<String>,
    /// Digest of the cached files, so a truncated or corrupted cache entry is
    /// detected on reuse rather than silently written to a GoTek.
    #[serde(default)]
    sha256: Option<String>,
    /// When this entry was last served, used to decide what to evict first.
    #[serde(default)]
    last_used: u64,
}

/// A digest over every cached file, in a stable order.
fn digest_files(folder: &Path, files: &[String]) -> Result<String> {
    let mut hasher = Sha256::new();
    let mut ordered = files.to_vec();
    ordered.sort();
    for name in &ordered {
        hasher.update(name.as_bytes());
        let mut file = fs::File::open(folder.join(name))?;
        hasher.update(sha256_reader(&mut file)?);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// ---------------------------------------------------------------------------
// Catalogues
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn refresh_provider(
    app: tauri::AppHandle,
    provider: OnlineProvider,
    platform_name: String,
    platform_id: String,
    extensions: Vec<String>,
) -> Result<ProviderCatalog> {
    if safe_cache_part(&provider.id).is_empty() {
        return Err("Provider ID must contain letters or numbers.".into());
    }
    let client = client()?;
    let items = match provider.adapter {
        Adapter::InternetArchive => {
            archive_org::search(&client, &provider, &platform_name, &platform_id).await?
        }
        Adapter::JsonFeed => {
            let url = provider
                .catalog_url
                .as_deref()
                .context("A JSON feed provider requires a catalogue URL.")?;
            let value = client
                .get(secure_url(url)?)
                .send()
                .await
                .context("Catalogue refresh failed")?
                .error_for_status()?
                .json::<serde_json::Value>()
                .await
                .context("The catalogue returned invalid JSON")?;
            feed::normalise(value, &provider, Some(&platform_id))?
        }
        Adapter::HtmlSite => {
            let supported = normalise_extensions(extensions);
            website::inspect(&client, &provider, &platform_id, &supported).await?
        }
    };

    let catalog = ProviderCatalog {
        provider_id: provider.id.clone(),
        platform_id: platform_id.clone(),
        refreshed_at: now(),
        items,
    };
    let folder = catalogue_folder(&app)?;
    let file = folder.join(format!(
        "{}--{}.json",
        safe_cache_part(&provider.id),
        safe_cache_part(&platform_id)
    ));
    fs::write(file, serde_json::to_vec_pretty(&catalog)?)?;
    Ok(catalog)
}

/// Reads a previously cached catalogue. Never touches the network, so the
/// library still works offline.
#[tauri::command]
pub async fn load_provider_catalog(
    app: tauri::AppHandle,
    provider_id: String,
    platform_id: String,
) -> Result<Option<ProviderCatalog>> {
    let path = catalogue_file(&app, &provider_id, &platform_id)?;
    blocking(move || {
        if !path.is_file() {
            return Ok(None);
        }
        serde_json::from_slice(&fs::read(&path)?)
            .map(Some)
            .context("Unable to read the cached catalogue")
    })
    .await
}

/// Lists the individual files inside one catalogue entry.
///
/// Only the Internet Archive exposes item contents; every other adapter already
/// points at a single file.
#[tauri::command]
pub async fn browse_online_title(
    provider: OnlineProvider,
    title: OnlineTitle,
    extensions: Vec<String>,
) -> Result<Vec<OnlineTitle>> {
    if provider.adapter != Adapter::InternetArchive {
        return Ok(vec![title]);
    }
    let extensions = normalise_extensions(extensions);
    let client = client()?;
    let metadata = archive_org::fetch_metadata(&client, &title.remote_id).await?;
    Ok(archive_org::item_files(
        &provider,
        &title,
        &metadata,
        &extensions,
    ))
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/// Resolves what a non-Archive provider should fetch, deriving a filename from
/// the URL when the catalogue does not supply one.
fn resolve_direct_download(title: &OnlineTitle) -> Result<ResolvedDownload> {
    let url = title
        .download_url
        .clone()
        .context("This catalogue item has no download URL.")?;
    let parsed = secure_url(&url)?;
    let name = parsed
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .map(str::to_string)
        .filter(|segment| !segment.is_empty())
        .unwrap_or_else(|| {
            format!(
                "{}.{}",
                title.title,
                title.extension.as_deref().unwrap_or("img")
            )
        });
    Ok(ResolvedDownload {
        url,
        name,
        size: title.size,
        license: title.license.clone(),
    })
}

/// True when the folder already holds exactly this download, intact.
///
/// Reuse is only safe if the bytes are still the bytes that were fetched, so a
/// recorded digest is re-checked before the cache is trusted. Serving it also
/// stamps the entry, which is what makes eviction least-recently-used.
fn cached_files(folder: &Path, source_url: &str, updated: Option<&str>) -> Option<Vec<String>> {
    let path = folder.join("download.json");
    let mut metadata: DownloadMetadata = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
    let present = metadata.source_url == source_url
        && metadata.updated.as_deref() == updated
        && !metadata.files.is_empty()
        && metadata.files.iter().all(|file| folder.join(file).is_file());
    if !present {
        return None;
    }
    if let Some(recorded) = metadata.sha256.as_deref() {
        let actual = digest_files(folder, &metadata.files).ok()?;
        if actual != recorded {
            // Corrupt or truncated: fetch it again rather than use it.
            return None;
        }
    }
    metadata.last_used = now();
    if let Ok(bytes) = serde_json::to_vec_pretty(&metadata) {
        let _ = fs::write(&path, bytes);
    }
    Some(metadata.files)
}

async fn stream_to_file(
    client: &reqwest::Client,
    url: &str,
    destination: &Path,
    expected: Option<u64>,
) -> Result<()> {
    let response = client
        .get(secure_url(url)?)
        .send()
        .await
        .context("Download failed")?
        .error_for_status()?;
    if response
        .content_length()
        .is_some_and(|size| size > DOWNLOAD_BYTE_LIMIT)
    {
        return Err("Downloads larger than 4 GiB are not supported.".into());
    }

    let temporary = destination.with_extension("part");
    let outcome = async {
        let mut output = fs::File::create(&temporary)?;
        let mut stream = response.bytes_stream();
        let mut total = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("Download interrupted")?;
            total = total
                .checked_add(chunk.len() as u64)
                .context("Download size overflowed.")?;
            if total > DOWNLOAD_BYTE_LIMIT {
                return Err("Downloads larger than 4 GiB are not supported.".into());
            }
            output.write_all(&chunk)?;
        }
        output.sync_all()?;
        if expected.is_some_and(|size| size != total) {
            return Err("The downloaded size did not match the catalogue metadata.".into());
        }
        Ok(())
    }
    .await;

    if outcome.is_err() {
        let _ = fs::remove_file(&temporary);
        return outcome;
    }
    if destination.exists() {
        fs::remove_file(destination)?;
    }
    fs::rename(&temporary, destination)?;
    Ok(())
}

#[tauri::command]
pub async fn download_online_title(
    app: tauri::AppHandle,
    provider: OnlineProvider,
    title: OnlineTitle,
    extensions: Vec<String>,
) -> Result<CachedDownload> {
    let extensions = normalise_extensions(extensions);
    let client = client()?;
    let resolved = if provider.adapter == Adapter::InternetArchive {
        archive_org::resolve_download(&client, &title, &extensions).await?
    } else {
        resolve_direct_download(&title)?
    };

    let extension = extension_of(Path::new(&resolved.name));
    if !extensions.contains(&extension) && extension != "zip" {
        return Err(format!("The selected download uses unsupported format .{extension}.").into());
    }
    let filename = safe_cache_part(&resolved.name);
    if filename.is_empty() {
        return Err("The download did not provide a safe filename.".into());
    }

    let folder = download_folder(&app, &provider.id, &title.remote_id)?;
    if let Some(files) = cached_files(&folder, &resolved.url, title.updated.as_deref()) {
        return Ok(CachedDownload {
            entries: read_entries(&folder, &files)?,
            cache_path: folder.to_string_lossy().into_owned(),
            reused: true,
            source_url: resolved.url,
            license: resolved.license,
        });
    }

    let destination = folder.join(&filename);
    stream_to_file(&client, &resolved.url, &destination, resolved.size).await?;

    let files = if extension == "zip" {
        let folder = folder.clone();
        let destination = destination.clone();
        let extracted = blocking(move || {
            extract_zip_images(&destination, &folder, &extensions, DOWNLOAD_BYTE_LIMIT)
        })
        .await?;
        if extracted.is_empty() {
            return Err(
                "The ZIP archive contains no supported images for this platform.".into(),
            );
        }
        extracted
    } else {
        vec![to_posix(&filename)]
    };

    let metadata = DownloadMetadata {
        source_url: resolved.url.clone(),
        updated: title.updated,
        sha256: digest_files(&folder, &files).ok(),
        last_used: now(),
        files: files.clone(),
        license: resolved.license.clone(),
    };
    fs::write(
        folder.join("download.json"),
        serde_json::to_vec_pretty(&metadata)?,
    )?;

    Ok(CachedDownload {
        entries: read_entries(&folder, &files)?,
        cache_path: folder.to_string_lossy().into_owned(),
        reused: false,
        source_url: resolved.url,
        license: resolved.license,
    })
}

fn read_entries(folder: &Path, files: &[String]) -> Result<Vec<FileEntry>> {
    files
        .iter()
        .map(|file| entry_at(&PathBuf::from(folder).join(file)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{resolve_direct_download, Adapter, OnlineProvider, OnlineTitle};

    fn title(download_url: Option<&str>, extension: Option<&str>) -> OnlineTitle {
        OnlineTitle {
            provider_id: "site".into(),
            remote_id: "elite".into(),
            title: "Elite".into(),
            platform_id: Some("bbc".into()),
            extension: extension.map(str::to_string),
            size: None,
            download_url: download_url.map(str::to_string),
            details_url: None,
            license: None,
            updated: None,
        }
    }

    #[test]
    fn adapters_use_the_names_the_frontend_sends() {
        assert_eq!(
            serde_json::to_string(&Adapter::InternetArchive).unwrap(),
            "\"internetArchive\""
        );
        assert_eq!(
            serde_json::from_str::<Adapter>("\"htmlSite\"").unwrap(),
            Adapter::HtmlSite
        );
    }

    #[test]
    fn unknown_provider_fields_are_ignored_so_the_frontend_can_add_its_own() {
        let provider: OnlineProvider = serde_json::from_str(
            r#"{"id":"site","name":"Site","adapter":"htmlSite","builtIn":true}"#,
        )
        .unwrap();

        assert_eq!(provider.adapter, Adapter::HtmlSite);
        assert!(provider.catalog_url.is_none());
    }

    #[test]
    fn direct_downloads_take_their_filename_from_the_url() {
        let resolved =
            resolve_direct_download(&title(Some("https://example.org/bbc/Elite.ssd"), None))
                .unwrap();

        assert_eq!(resolved.name, "Elite.ssd");
    }

    #[test]
    fn a_url_without_a_filename_falls_back_to_the_title_and_extension() {
        let resolved =
            resolve_direct_download(&title(Some("https://example.org/download/"), Some("ssd")))
                .unwrap();

        assert_eq!(resolved.name, "Elite.ssd");
    }

    #[test]
    fn a_reference_only_title_cannot_be_downloaded() {
        assert!(resolve_direct_download(&title(None, None)).is_err());
        assert!(resolve_direct_download(&title(Some("http://example.org/e.ssd"), None)).is_err());
    }
}
