//! Bounded, policy-aware inspection of a public catalogue website.
//!
//! This is deliberately narrow. It starts at one page the user supplied, stays
//! on that origin, honours `robots.txt` for every request, paces itself, and
//! records only links whose extension the active platform actually supports.
//! It is not a general crawler and must not become one: any new provider needs
//! its own adapter, terms review, and attribution.

use super::{OnlineProvider, OnlineTitle};
use crate::error::{Context, Result};
use crate::online::{http::secure_url, robots};
use scraper::{Html, Selector};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::Path,
    time::Duration,
};

/// Never fetch more pages than this from one site in one refresh.
const MAX_PAGES: usize = 100;
/// Never record more candidate downloads than this.
const MAX_DOWNLOADS: usize = 1000;
/// How deep to follow same-site catalogue pages from the starting page.
const MAX_DEPTH: usize = 2;
/// Courtesy delay between requests to the same host.
const REQUEST_DELAY: Duration = Duration::from_millis(100);

const PAGE_EXTENSIONS: [&str; 5] = ["html", "htm", "php", "asp", "aspx"];

fn link_extension(url: &reqwest::Url) -> String {
    crate::paths::extension_of(Path::new(url.path()))
}

/// Anchor text, collapsed to a single line, or the filename when there is none.
fn link_label(anchor: &scraper::ElementRef<'_>, url: &reqwest::Url) -> String {
    let label = anchor
        .text()
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if !label.is_empty() {
        return label;
    }
    url.path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|segment| !segment.is_empty())
        .unwrap_or("Untitled")
        .to_string()
}

pub async fn inspect(
    client: &reqwest::Client,
    provider: &OnlineProvider,
    platform_id: &str,
    extensions: &HashSet<String>,
) -> Result<Vec<OnlineTitle>> {
    let start = secure_url(
        provider
            .catalog_url
            .as_deref()
            .context("A website provider requires a starting URL.")?,
    )?;

    let mut robots_url = start.clone();
    robots_url.set_path("/robots.txt");
    robots_url.set_query(None);
    robots_url.set_fragment(None);
    let robots = match client.get(robots_url).send().await {
        Ok(response) if response.status().is_success() => response.text().await.unwrap_or_default(),
        _ => String::new(),
    };
    if !robots::allows(&robots, start.path()) {
        return Err("This site disallows automated catalogue inspection in robots.txt.".into());
    }

    let selector = Selector::parse("a[href]").map_err(|error| error.to_string())?;
    let origin = start.origin().ascii_serialization();
    let mut pending = VecDeque::from([(start, 0usize)]);
    let mut visited = HashSet::new();
    let mut downloads: HashMap<String, OnlineTitle> = HashMap::new();

    while let Some((url, depth)) = pending.pop_front() {
        if visited.len() >= MAX_PAGES || downloads.len() >= MAX_DOWNLOADS {
            break;
        }
        if !visited.insert(url.as_str().to_string()) || !robots::allows(&robots, url.path()) {
            continue;
        }
        if visited.len() > 1 {
            tokio::time::sleep(REQUEST_DELAY).await;
        }
        let response = client
            .get(url.clone())
            .send()
            .await
            .with_context(|| format!("Unable to inspect {url}"))?;
        // A redirect off-site, an error page, or a non-HTML body ends this branch.
        if !response.status().is_success()
            || response.url().origin().ascii_serialization() != origin
        {
            continue;
        }
        let is_html = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("text/html"));
        if !is_html {
            continue;
        }
        let final_url = response.url().clone();
        let body = response.text().await.context("Unable to read the page")?;
        let document = Html::parse_document(&body);

        for anchor in document.select(&selector) {
            let Some(href) = anchor.value().attr("href") else {
                continue;
            };
            let Ok(link) = final_url.join(href) else {
                continue;
            };
            if link.scheme() != "https"
                || link.origin().ascii_serialization() != origin
                || !robots::allows(&robots, link.path())
            {
                continue;
            }
            let extension = link_extension(&link);
            if extensions.contains(&extension) || extension == "zip" {
                let key = link.as_str().to_string();
                downloads.entry(key.clone()).or_insert_with(|| OnlineTitle {
                    provider_id: provider.id.clone(),
                    remote_id: key,
                    title: link_label(&anchor, &link),
                    platform_id: provider
                        .platform_id
                        .clone()
                        .or_else(|| Some(platform_id.to_string())),
                    extension: Some(extension),
                    size: None,
                    download_url: Some(link.to_string()),
                    details_url: Some(final_url.to_string()),
                    license: None,
                    updated: None,
                });
            } else if depth < MAX_DEPTH
                && (extension.is_empty() || PAGE_EXTENSIONS.contains(&extension.as_str()))
            {
                pending.push_back((link, depth + 1));
            }
        }
    }
    let mut titles = downloads.into_values().collect::<Vec<_>>();
    titles.sort_by_key(|title| title.title.to_lowercase());
    Ok(titles)
}

#[cfg(test)]
mod tests {
    use super::{link_extension, link_label, PAGE_EXTENSIONS};
    use scraper::{Html, Selector};

    #[test]
    fn download_extensions_are_read_from_the_link_path() {
        let url = reqwest::Url::parse("https://example.org/bbc/Elite.SSD?v=2").unwrap();

        assert_eq!(link_extension(&url), "ssd");
    }

    #[test]
    fn anchor_text_becomes_the_title_and_the_filename_is_the_fallback() {
        let document = Html::parse_document(
            r#"<a href="/a.ssd">  Elite
               (1984) </a><a href="/b.ssd"></a>"#,
        );
        let selector = Selector::parse("a[href]").unwrap();
        let anchors = document.select(&selector).collect::<Vec<_>>();
        let first = reqwest::Url::parse("https://example.org/a.ssd").unwrap();
        let second = reqwest::Url::parse("https://example.org/b.ssd").unwrap();

        assert_eq!(link_label(&anchors[0], &first), "Elite (1984)");
        assert_eq!(link_label(&anchors[1], &second), "b.ssd");
    }

    #[test]
    fn only_catalogue_page_types_are_followed() {
        assert!(PAGE_EXTENSIONS.contains(&"html"));
        assert!(!PAGE_EXTENSIONS.contains(&"pdf"));
    }

    /// Opt-in: `cargo test -- --ignored` reaches the live site. Kept out of the
    /// default run so the suite stays offline and does not load a third party.
    #[ignore]
    #[test]
    fn live_stairway_to_hell_inspection_finds_bbc_packages() {
        use crate::online::{http::client, Adapter, OnlineProvider};
        use crate::paths::normalise_extensions;

        let provider = OnlineProvider {
            id: "stairway-bbc".into(),
            name: "Stairway to Hell: BBC".into(),
            adapter: Adapter::HtmlSite,
            catalog_url: Some("https://www.stairwaytohell.com/bbc/homepage.html".into()),
            query: None,
            platform_id: Some("bbc".into()),
        };
        let extensions = normalise_extensions(vec!["ssd".into(), "dsd".into(), "zip".into()]);

        let titles = tauri::async_runtime::block_on(super::inspect(
            &client().unwrap(),
            &provider,
            "bbc",
            &extensions,
        ))
        .unwrap();

        assert!(!titles.is_empty());
        assert!(titles
            .iter()
            .all(|title| title.download_url.as_deref().unwrap_or_default().starts_with("https://")));
    }
}
