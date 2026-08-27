//! Internet Archive adapter, using the public search and metadata APIs.

use super::{OnlineProvider, OnlineTitle, ResolvedDownload};
use crate::error::{Context, Error, Result};
use crate::paths::extension_of;
use serde::Deserialize;
use std::{collections::HashSet, path::Path};

const SEARCH_URL: &str = "https://archive.org/advancedsearch.php";
const METADATA_URL: &str = "https://archive.org/metadata";
// No trailing slash: `path_segments_mut().push` appends after the last
// segment, and a trailing slash would produce an empty one.
const DOWNLOAD_URL: &str = "https://archive.org/download";
const DETAILS_URL: &str = "https://archive.org/details";
/// A catalogue is a sample, not a census. Large enough to be useful for
/// coverage comparison, small enough not to lean on a free public API.
const SEARCH_ROWS: &str = "500";

#[derive(Deserialize)]
struct SearchResponse {
    response: SearchDocuments,
}

#[derive(Deserialize)]
struct SearchDocuments {
    docs: Vec<SearchDocument>,
}

#[derive(Deserialize)]
struct SearchDocument {
    identifier: String,
    title: Option<String>,
    publicdate: Option<String>,
}

#[derive(Deserialize)]
pub struct ItemMetadata {
    files: Vec<ItemFile>,
    metadata: Option<ItemFields>,
}

#[derive(Deserialize)]
struct ItemFile {
    name: String,
    size: Option<String>,
    source: Option<String>,
}

#[derive(Deserialize)]
struct ItemFields {
    licenseurl: Option<String>,
}

impl ItemMetadata {
    pub fn license(&self) -> Option<String> {
        self.metadata
            .as_ref()
            .and_then(|fields| fields.licenseurl.clone())
    }

    /// Original uploads only. Derived files are the Archive's own conversions
    /// and are not what a collector wants on a GoTek.
    fn originals(&self) -> impl Iterator<Item = &ItemFile> {
        self.files
            .iter()
            .filter(|file| file.source.as_deref() == Some("original"))
    }
}

fn supported(name: &str, extensions: &HashSet<String>) -> bool {
    let extension = extension_of(Path::new(name));
    extensions.contains(&extension) || extension == "zip"
}

fn download_url(identifier: &str, name: &str) -> Result<String> {
    let mut url = reqwest::Url::parse(DOWNLOAD_URL).context("Invalid archive download URL")?;
    url.path_segments_mut()
        .map_err(|_| Error::new("Unable to construct the archive download URL."))?
        .push(identifier)
        .push(name);
    Ok(url.to_string())
}

pub async fn fetch_metadata(client: &reqwest::Client, identifier: &str) -> Result<ItemMetadata> {
    client
        .get(format!("{METADATA_URL}/{identifier}"))
        .send()
        .await
        .context("Unable to load archive metadata")?
        .error_for_status()?
        .json::<ItemMetadata>()
        .await
        .context("Archive metadata was invalid")
}

/// Builds the search a provider describes.
///
/// A provider that names its platform has already said what it covers — its
/// query is a collection, and narrowing that further by the machine's name
/// would throw away almost everything, because an item in the Amstrad CPC
/// collection is not titled "Amstrad CPC464". Only an unscoped provider needs
/// the platform name as a filter.
pub fn build_query(provider: &OnlineProvider, platform_name: &str) -> String {
    let base = provider.query.as_deref().unwrap_or("mediatype:software");
    if provider.platform_id.is_some() {
        return base.to_string();
    }
    format!("({base}) AND (title:\"{platform_name}\" OR description:\"{platform_name}\")")
}

/// Searches the software collection for one platform.
pub async fn search(
    client: &reqwest::Client,
    provider: &OnlineProvider,
    platform_name: &str,
    platform_id: &str,
) -> Result<Vec<OnlineTitle>> {
    let query = build_query(provider, platform_name);
    let response = client
        .get(SEARCH_URL)
        .query(&[
            ("q", query.as_str()),
            ("fl[]", "identifier,title,publicdate"),
            ("rows", SEARCH_ROWS),
            ("output", "json"),
        ])
        .send()
        .await
        .context("Internet Archive search failed")?
        .error_for_status()?
        .json::<SearchResponse>()
        .await
        .context("Internet Archive returned invalid data")?;
    Ok(response
        .response
        .docs
        .into_iter()
        .map(|document| OnlineTitle {
            provider_id: provider.id.clone(),
            title: document
                .title
                .unwrap_or_else(|| document.identifier.clone()),
            details_url: Some(format!("{DETAILS_URL}/{}", document.identifier)),
            remote_id: document.identifier,
            platform_id: provider
                .platform_id
                .clone()
                .or_else(|| Some(platform_id.to_string())),
            extension: None,
            size: None,
            download_url: None,
            license: None,
            updated: document.publicdate,
        })
        .collect())
}

/// Lists the supported files inside one item so the user chooses exactly which
/// disk to download, rather than the application guessing.
pub fn item_files(
    provider: &OnlineProvider,
    title: &OnlineTitle,
    metadata: &ItemMetadata,
    extensions: &HashSet<String>,
) -> Vec<OnlineTitle> {
    let license = metadata.license().or_else(|| title.license.clone());
    let mut files = metadata
        .originals()
        .filter(|file| supported(&file.name, extensions))
        .filter_map(|file| {
            Some(OnlineTitle {
                provider_id: provider.id.clone(),
                remote_id: title.remote_id.clone(),
                title: file.name.clone(),
                platform_id: title.platform_id.clone(),
                extension: Some(extension_of(Path::new(&file.name))),
                size: file.size.as_deref().and_then(|value| value.parse().ok()),
                download_url: Some(download_url(&title.remote_id, &file.name).ok()?),
                details_url: title.details_url.clone(),
                license: license.clone(),
                updated: title.updated.clone(),
            })
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|file| file.title.to_lowercase());
    files
}

/// Resolves which file to fetch for a title.
///
/// When the user picked a specific file through the browser its name is used;
/// otherwise the alphabetically first supported original is chosen so the
/// choice is deterministic.
pub async fn resolve_download(
    client: &reqwest::Client,
    title: &OnlineTitle,
    extensions: &HashSet<String>,
) -> Result<ResolvedDownload> {
    let metadata = fetch_metadata(client, &title.remote_id).await?;
    let license = metadata.license();
    let chosen = metadata
        .originals()
        .filter(|file| supported(&file.name, extensions))
        .filter(|file| title.download_url.is_none() || file.name == title.title)
        .min_by_key(|file| file.name.to_lowercase())
        .context("No supported disk image was found in this Internet Archive item.")?;
    Ok(ResolvedDownload {
        url: download_url(&title.remote_id, &chosen.name)?,
        name: chosen.name.clone(),
        size: chosen.size.as_deref().and_then(|value| value.parse().ok()),
        license,
    })
}

#[cfg(test)]
mod tests {
    use super::{download_url, supported, ItemMetadata};
    use crate::paths::normalise_extensions;

    fn metadata(json: &str) -> ItemMetadata {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn only_original_uploads_are_offered() {
        let item = metadata(
            r#"{"files":[
                {"name":"Elite.ssd","source":"original","size":"200"},
                {"name":"Elite_archive.ssd","source":"derivative","size":"200"}
            ],"metadata":{"licenseurl":"https://creativecommons.org/licenses/by/4.0/"}}"#,
        );

        let names = item.originals().map(|file| &file.name).collect::<Vec<_>>();

        assert_eq!(names, vec!["Elite.ssd"]);
        assert_eq!(
            item.license().as_deref(),
            Some("https://creativecommons.org/licenses/by/4.0/")
        );
    }

    #[test]
    fn supported_files_include_archives_for_later_extraction() {
        let extensions = normalise_extensions(vec!["ssd".into()]);

        assert!(supported("Elite.SSD", &extensions));
        assert!(supported("collection.zip", &extensions));
        assert!(!supported("manual.pdf", &extensions));
    }

    #[test]
    fn a_platform_scoped_provider_is_not_narrowed_a_second_time() {
        use crate::online::{Adapter, OnlineProvider};
        let scoped = OnlineProvider {
            id: "ia-cpc".into(),
            name: "Internet Archive: Amstrad CPC".into(),
            adapter: Adapter::InternetArchive,
            catalog_url: None,
            query: Some("collection:softwarelibrary_cpc".into()),
            platform_id: Some("cpc464".into()),
            ignore_robots: false,
            user_agent: None,
        };

        // Adding `title:"Amstrad CPC464"` here would return almost nothing:
        // items in that collection are named after the game, not the machine.
        assert_eq!(
            super::build_query(&scoped, "Amstrad CPC464"),
            "collection:softwarelibrary_cpc"
        );

        let general = OnlineProvider {
            platform_id: None,
            query: Some("mediatype:software".into()),
            ..scoped
        };
        assert_eq!(
            super::build_query(&general, "Amstrad CPC464"),
            "(mediatype:software) AND (title:\"Amstrad CPC464\" OR description:\"Amstrad CPC464\")"
        );
    }

    #[test]
    fn download_urls_escape_identifiers_and_filenames() {
        let url = download_url("bbc-micro-games", "Elite (1984).ssd").unwrap();

        assert_eq!(
            url,
            "https://archive.org/download/bbc-micro-games/Elite%20(1984).ssd"
        );
    }
}
