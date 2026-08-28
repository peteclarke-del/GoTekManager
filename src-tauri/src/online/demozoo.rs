//! Demozoo adapter.
//!
//! Demozoo catalogues demoscene and homebrew productions for exactly the
//! machines this application targets, and publishes a documented JSON API for
//! them. That matters: crawling a database-backed site finds almost nothing,
//! because its downloads sit behind scripts, whereas asking its API returns the
//! links directly. Sampling eight productions per platform found downloads on
//! all eight for the BBC Micro and the Amstrad CPC, including `.ssd`, `.dsd`
//! and `.dsk` files rather than only archives.
//!
//! A provider's `query` holds the Demozoo platform number: 66 for the BBC
//! Micro, 36 for the Amstrad CPC, 9 for the Atari ST, and so on.
//!
//! Download links live on each production's own resource rather than in the
//! listing, so they are fetched when a title is opened, exactly as the Internet
//! Archive adapter does. Fetching them for a whole catalogue up front would be
//! hundreds of requests for something the user may never look at.

use super::{OnlineProvider, OnlineTitle, ResolvedDownload};
use crate::error::{Context, Error, Result};
use crate::paths::extension_of;
use serde::Deserialize;
use std::{collections::HashSet, path::Path, time::Duration};

const API: &str = "https://demozoo.org/api/v1/productions/";
/// Pages of 100. Enough to be useful for coverage without pulling a whole
/// database that is mostly for other machines.
const MAX_PAGES: usize = 5;
/// Between pages. The API is free and someone pays for it.
const PAGE_DELAY: Duration = Duration::from_millis(250);

#[derive(Debug, Deserialize)]
struct Listing {
    #[serde(default)]
    next: Option<String>,
    #[serde(default)]
    results: Vec<Production>,
}

#[derive(Debug, Deserialize)]
struct Production {
    id: u64,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    demozoo_url: Option<String>,
    #[serde(default)]
    release_date: Option<String>,
    #[serde(default)]
    author_nicks: Vec<Nick>,
}

#[derive(Debug, Deserialize)]
struct Nick {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Detail {
    #[serde(default)]
    download_links: Vec<DownloadLink>,
}

#[derive(Debug, Deserialize)]
struct DownloadLink {
    url: String,
}

/// "Elite by Acornsoft", where the author is known.
fn display_title(production: &Production) -> String {
    let title = production
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Untitled");
    let authors = production
        .author_nicks
        .iter()
        .filter_map(|nick| nick.name.as_deref())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    if authors.is_empty() {
        title.to_string()
    } else {
        format!("{title} by {}", authors.join(", "))
    }
}

fn supported(url: &str, extensions: &HashSet<String>) -> bool {
    // The path decides, not the query string: a link may carry parameters.
    let path = reqwest::Url::parse(url)
        .map(|parsed| parsed.path().to_string())
        .unwrap_or_else(|_| url.to_string());
    let extension = extension_of(Path::new(&path));
    extensions.contains(&extension) || extension == "zip"
}

fn platform_query(provider: &OnlineProvider) -> Result<String> {
    let value = provider
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .context("A Demozoo source needs the platform number in its query field.")?;
    if !value.chars().all(|character| character.is_ascii_digit()) {
        return Err(Error::new(format!(
            "A Demozoo source's query must be a platform number, not \"{value}\"."
        )));
    }
    Ok(value.to_string())
}

/// Lists productions for one machine.
pub async fn search(
    client: &reqwest::Client,
    provider: &OnlineProvider,
    platform_id: &str,
) -> Result<Vec<OnlineTitle>> {
    let platform = platform_query(provider)?;
    let mut url = format!("{API}?format=json&platform={platform}");
    let mut titles = Vec::new();

    for page in 0..MAX_PAGES {
        if page > 0 {
            tokio::time::sleep(PAGE_DELAY).await;
        }
        let listing = client
            .get(&url)
            .send()
            .await
            .context("Demozoo could not be reached")?
            .error_for_status()?
            .json::<Listing>()
            .await
            .context("Demozoo returned unexpected data")?;

        for production in &listing.results {
            titles.push(OnlineTitle {
                provider_id: provider.id.clone(),
                remote_id: production.id.to_string(),
                title: display_title(production),
                platform_id: provider
                    .platform_id
                    .clone()
                    .or_else(|| Some(platform_id.to_string())),
                extension: None,
                size: None,
                // Resolved from the production's own resource when opened.
                download_url: None,
                details_url: production.demozoo_url.clone(),
                license: None,
                updated: production.release_date.clone(),
            });
        }

        match listing.next {
            // The API returns an absolute URL for the next page.
            Some(next) if next.starts_with("https://") => url = next,
            _ => break,
        }
    }
    Ok(titles)
}

pub async fn fetch_detail(client: &reqwest::Client, id: &str) -> Result<Detail> {
    if !id.chars().all(|character| character.is_ascii_digit()) {
        return Err(Error::new("Not a Demozoo production reference."));
    }
    client
        .get(format!("{API}{id}/?format=json"))
        .send()
        .await
        .context("Unable to load the production")?
        .error_for_status()?
        .json::<Detail>()
        .await
        .context("Demozoo returned unexpected data")
}

/// The downloadable files attached to one production.
pub fn item_files(
    provider: &OnlineProvider,
    title: &OnlineTitle,
    detail: &Detail,
    extensions: &HashSet<String>,
) -> Vec<OnlineTitle> {
    let mut files = detail
        .download_links
        .iter()
        .map(|link| link.url.as_str())
        // Only HTTPS, and only something this machine could use.
        .filter(|url| url.starts_with("https://"))
        .filter(|url| supported(url, extensions))
        .map(|url| {
            let name = reqwest::Url::parse(url)
                .ok()
                .and_then(|parsed| {
                    parsed
                        .path_segments()
                        .and_then(|mut segments| segments.next_back())
                        .map(str::to_string)
                })
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| title.title.clone());
            OnlineTitle {
                provider_id: provider.id.clone(),
                remote_id: title.remote_id.clone(),
                extension: Some(extension_of(Path::new(&name))),
                title: name,
                platform_id: title.platform_id.clone(),
                size: None,
                download_url: Some(url.to_string()),
                details_url: title.details_url.clone(),
                license: None,
                updated: title.updated.clone(),
            }
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|file| file.title.to_lowercase());
    files.dedup_by(|left, right| left.download_url == right.download_url);
    files
}

/// Picks the file to fetch when a title is downloaded without being opened.
pub async fn resolve_download(
    client: &reqwest::Client,
    provider: &OnlineProvider,
    title: &OnlineTitle,
    extensions: &HashSet<String>,
) -> Result<ResolvedDownload> {
    // An already-resolved link is used as it stands.
    if let Some(url) = title.download_url.as_deref() {
        let name = reqwest::Url::parse(url)
            .ok()
            .and_then(|parsed| {
                parsed
                    .path_segments()
                    .and_then(|mut segments| segments.next_back())
                    .map(str::to_string)
            })
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| title.title.clone());
        return Ok(ResolvedDownload {
            url: url.to_string(),
            name,
            size: None,
            license: None,
        });
    }

    let detail = fetch_detail(client, &title.remote_id).await?;
    let candidate = item_files(provider, title, &detail, extensions)
        .into_iter()
        .next()
        .context("This production has no file this machine can use.")?;
    Ok(ResolvedDownload {
        url: candidate.download_url.unwrap_or_default(),
        name: candidate.title,
        size: None,
        license: None,
    })
}

#[cfg(test)]
mod tests {
    use super::{display_title, item_files, platform_query, supported, Detail, Production};
    use crate::online::{Adapter, OnlineProvider, OnlineTitle};
    use crate::paths::normalise_extensions;

    fn provider(query: Option<&str>) -> OnlineProvider {
        OnlineProvider {
            id: "demozoo-bbc".into(),
            name: "Demozoo: BBC Micro".into(),
            adapter: Adapter::Demozoo,
            catalog_url: None,
            query: query.map(str::to_string),
            platform_id: Some("bbc".into()),
            ignore_robots: false,
            user_agent: None,
        }
    }

    fn title() -> OnlineTitle {
        OnlineTitle {
            provider_id: "demozoo-bbc".into(),
            remote_id: "12345".into(),
            title: "Twisted Brain".into(),
            platform_id: Some("bbc".into()),
            extension: None,
            size: None,
            download_url: None,
            details_url: Some("https://demozoo.org/productions/12345/".into()),
            license: None,
            updated: None,
        }
    }

    #[test]
    fn a_production_is_named_with_its_author() {
        let listed: Production = serde_json::from_str(
            r#"{"id":1,"title":"Twisted Brain","author_nicks":[{"name":"Bitshifters"}]}"#,
        )
        .unwrap();

        assert_eq!(display_title(&listed), "Twisted Brain by Bitshifters");

        let anonymous: Production =
            serde_json::from_str(r#"{"id":2,"title":"Untitled Demo","author_nicks":[]}"#).unwrap();
        assert_eq!(display_title(&anonymous), "Untitled Demo");
    }

    #[test]
    fn the_platform_number_is_required_and_must_be_a_number() {
        assert_eq!(platform_query(&provider(Some("66"))).unwrap(), "66");
        assert!(platform_query(&provider(None)).is_err());
        // A collection query pasted from an Archive source would otherwise be
        // sent as a platform filter and silently return the wrong machine.
        assert!(platform_query(&provider(Some("collection:softwarelibrary_cpc"))).is_err());
    }

    #[test]
    fn only_files_this_machine_could_use_are_offered() {
        let extensions = normalise_extensions(vec!["ssd".into(), "dsd".into()]);
        let detail: Detail = serde_json::from_str(
            r#"{"download_links":[
                {"url":"https://bitshifters.github.io/a/TwistedBrain.ssd"},
                {"url":"https://files.scene.org/get/x/demo.zip"},
                {"url":"https://example.org/notes.pdf"},
                {"url":"http://insecure.example.org/game.ssd"}
            ]}"#,
        )
        .unwrap();

        let files = item_files(&provider(Some("66")), &title(), &detail, &extensions);

        // The PDF is not a disk image, and the plain-HTTP link is refused.
        // Ordering is alphabetical so the list does not shuffle between runs.
        assert_eq!(
            files.iter().map(|f| f.title.as_str()).collect::<Vec<_>>(),
            vec!["demo.zip", "TwistedBrain.ssd"]
        );
        let image = files.iter().find(|f| f.title.ends_with(".ssd")).unwrap();
        assert_eq!(image.extension.as_deref(), Some("ssd"));
        assert_eq!(image.remote_id, "12345");
    }

    #[test]
    fn a_production_with_nothing_usable_offers_nothing() {
        let detail: Detail =
            serde_json::from_str(r#"{"download_links":[{"url":"https://x/readme.txt"}]}"#).unwrap();

        assert!(item_files(
            &provider(Some("66")),
            &title(),
            &detail,
            &normalise_extensions(vec!["ssd".into()])
        )
        .is_empty());
    }

    #[test]
    fn a_link_with_a_query_string_is_judged_on_its_path() {
        let extensions = normalise_extensions(vec!["dsk".into()]);

        assert!(supported("https://x/y/game.dsk?dl=1", &extensions));
        assert!(!supported("https://x/y/page.php?file=game.dsk", &extensions));
    }

    /// Opt-in: `cargo test -- --ignored` reaches the live API.
    #[ignore]
    #[test]
    fn live_bbc_micro_productions_carry_usable_files() {
        use crate::online::http::client;
        let http = client(None).unwrap();
        let source = provider(Some("66"));

        let titles =
            tauri::async_runtime::block_on(super::search(&http, &source, "bbc")).unwrap();
        assert!(!titles.is_empty(), "no productions listed");
        assert!(titles.iter().all(|t| t.platform_id.as_deref() == Some("bbc")));

        // Walk a few until one has something this machine could use, which is
        // the whole point of preferring an API over crawling the site.
        let extensions = normalise_extensions(vec!["ssd".into(), "dsd".into(), "adf".into()]);
        let mut found = 0;
        for title in titles.iter().take(8) {
            let detail =
                tauri::async_runtime::block_on(super::fetch_detail(&http, &title.remote_id))
                    .unwrap();
            found += item_files(&source, title, &detail, &extensions).len();
        }
        assert!(found > 0, "no usable files across eight productions");
    }

    #[test]
    fn a_missing_download_list_is_not_an_error() {
        // Older productions are catalogued without files, which is normal.
        let detail: Detail = serde_json::from_str("{}").unwrap();

        assert!(item_files(
            &provider(Some("66")),
            &title(),
            &detail,
            &normalise_extensions(vec!["ssd".into()])
        )
        .is_empty());
    }
}
