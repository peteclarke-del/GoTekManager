//! Bounded, policy-aware inspection of a public catalogue website.
//!
//! This is deliberately narrow. It starts at one page the user supplied, stays
//! on that origin, honours `robots.txt` for every request, paces itself, and
//! records only links whose contents the active platform actually supports.
//!
//! What a link *is* comes from the server, not from the URL. Plenty of archives
//! hand out each title from a script — `dl.php?id=...` — whose address says
//! nothing about what comes back; judging by the URL alone, every one of those
//! looks like another page to walk, so the downloads are missed and the page
//! budget is spent fetching them anyway. A response that turns out to be a file
//! is therefore recorded as one, under the name the server gives it.
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

/// Never read more pages than this from one site in one refresh.
///
/// Counted in pages actually walked. A link that turns out to be a file is not
/// a page and does not spend this budget; how many of those may be recorded is
/// what `MAX_DOWNLOADS` is for.
const MAX_PAGES: usize = 100;
/// Never make more requests than this in one refresh, of any kind.
///
/// A catalogue page can carry a hundred links to other catalogue pages and a
/// score of downloads. Following every one of those is how a polite inspection
/// turns into a crawl of the whole site, so the visit is bounded outright.
const MAX_REQUESTS: usize = 700;
/// Never record more candidate downloads than this.
const MAX_DOWNLOADS: usize = 1000;
/// How deep to follow same-site catalogue pages from the starting page.
const MAX_DEPTH: usize = 2;
/// Courtesy delay between requests to the same host.
const REQUEST_DELAY: Duration = Duration::from_millis(100);
/// The delay used when a site's robots.txt has been overridden.
///
/// Ten times slower on purpose. If the operator's stated preference is being
/// ignored, the least this can do is cost them almost nothing to serve.
const OVERRIDE_DELAY: Duration = Duration::from_millis(1000);

const PAGE_EXTENSIONS: [&str; 5] = ["html", "htm", "php", "asp", "aspx"];

fn link_extension(url: &reqwest::Url) -> String {
    crate::paths::extension_of(Path::new(url.path()))
}

/// The filename a response asks to be saved as, if it says.
///
/// `Content-Disposition: attachment; filename=Elite.zip` is how a download
/// script names what it is returning, and often the only place the real name
/// appears. Quotes are optional in the wild, and anything that looks like a
/// path is reduced to its last segment so a header can never write outside the
/// cache folder.
fn attachment_name(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let value = headers
        .get(reqwest::header::CONTENT_DISPOSITION)?
        .to_str()
        .ok()?;
    let filename = value
        .split(';')
        .filter_map(|part| part.trim().strip_prefix("filename="))
        .next()?
        .trim()
        .trim_matches('"');
    let name = filename.rsplit(['/', '\\']).next()?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// What a response turned out to be: something to read, or something to record.
///
/// A file is recognised by its disposition or by a content type that is not a
/// page. Anything else is treated as a page, which is the safe way round: a
/// page misread as a file would be recorded as a title nobody can use, while a
/// file misread as a page is simply dropped, as it always was.
fn downloadable_name(headers: &reqwest::header::HeaderMap, url: &reqwest::Url) -> Option<String> {
    if let Some(name) = attachment_name(headers) {
        return Some(name);
    }
    let content_type = headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if content_type.starts_with("text/") || content_type.contains("xml") {
        return None;
    }
    url.path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
}

/// Link text that says nothing about what is behind it.
///
/// A page of titles whose every link reads "Download" is the common case, not a
/// strange one, and taking that as the name gives a catalogue of identical
/// entries. The file's own name is the better answer wherever the page has not
/// given a real one.
const EMPTY_LABELS: [&str; 8] = [
    "download", "download now", "get", "get it", "click here", "here", "link", "file",
];

/// What to call a title: what the page called it, or what the file is called.
///
/// The filename comes from the server and is usually the fuller name — the game,
/// its publisher, sometimes the disk — so it wins whenever the page offered
/// nothing but a button. Its extension is dropped: the format has a column of
/// its own, and repeating it in every title reads as noise.
fn download_title(label: &str, filename: &str) -> String {
    let stem = filename
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(filename)
        .trim();
    let generic = label.trim().is_empty()
        || EMPTY_LABELS.contains(&label.trim().trim_end_matches(['.', '!', '»', '>']).to_lowercase().as_str());
    if generic && !stem.is_empty() {
        return stem.to_string();
    }
    if label.trim().is_empty() {
        return filename.to_string();
    }
    label.trim().to_string()
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

/// The origin the inspection is confined to.
///
/// Taken from where the starting page landed rather than from what was typed.
/// A great many sites redirect `www.` to their apex or the reverse, and judging
/// every later link against the typed origin abandoned the crawl at its first
/// page, silently and with nothing to show for it. The landing must still be
/// HTTPS: a redirect down to plain HTTP ends the inspection rather than
/// quietly continuing over a connection nobody asked for.
fn landing_origin(landed: &reqwest::Url) -> Result<String> {
    if landed.scheme() != "https" {
        return Err(format!(
            "{} redirected to an address that is not HTTPS.",
            landed.host_str().unwrap_or("This site")
        )
        .into());
    }
    Ok(landed.origin().ascii_serialization())
}

/// The directory a starting URL names.
///
/// `/collections/Atari ST/index.html` and `/collections/Atari ST/` both name
/// the same folder, and that folder is what the user chose.
fn start_directory(start: &reqwest::Url) -> String {
    let path = start.path();
    match path.rfind('/') {
        Some(at) => path[..=at].to_string(),
        None => "/".to_string(),
    }
}

/// Whether a page may be followed, given where the crawl was pointed.
///
/// Sideways and downwards are allowed; upwards is not. Every directory index
/// carries a link to its parent, and following it turns a deliberate choice of
/// one collection into a crawl of everything sitting beside it — which is how a
/// scan of an Atari ST folder fills up with somebody's Atari 8-bit disks.
fn within_scope(directory: &str, path: &str) -> bool {
    path == directory || !directory.starts_with(path)
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

    // With the override on, robots.txt is not fetched at all: reading it only
    // to disregard it would be theatre.
    let robots = if provider.ignore_robots {
        String::new()
    } else {
        let mut robots_url = start.clone();
        robots_url.set_path("/robots.txt");
        robots_url.set_query(None);
        robots_url.set_fragment(None);
        match client.get(robots_url).send().await {
            Ok(response) if response.status().is_success() => {
                response.text().await.unwrap_or_default()
            }
            _ => String::new(),
        }
    };
    if !provider.ignore_robots && !robots::allows(&robots, start.path()) {
        return Err(
            "This site disallows automated catalogue inspection in robots.txt. You can \
             override that for this source, at your own risk, in its settings."
                .into(),
        );
    }
    let delay = if provider.ignore_robots {
        OVERRIDE_DELAY
    } else {
        REQUEST_DELAY
    };

    let selector = Selector::parse("a[href]").map_err(|error| error.to_string())?;
    // Both are replaced by where the starting page actually lands.
    let mut origin = start.origin().ascii_serialization();
    let mut directory = start_directory(&start);
    // Three queues, and what the site has already shown decides which one a
    // link joins.
    //
    // A catalogue page links to a score of downloads and a hundred other pages.
    // Taken in the order they were found, the queue fills with pages while the
    // downloads — the only reason any of this is being read — wait behind them,
    // and the visit ends having confirmed a handful. Nothing about a URL says
    // which it is, but a site answers that once and then keeps answering it the
    // same way: everything under `/dl.php` is a file, everything under
    // `/items.php` is a page. So the answer is remembered per path, and later
    // links are ordered by it. It is only an ordering — what any one link turns
    // out to be is still decided by the response, never by the guess.
    let mut kinds: HashMap<String, bool> = HashMap::new();
    let mut files: VecDeque<(reqwest::Url, usize, String)> = VecDeque::new();
    let mut unknown = VecDeque::from([(start, 0usize, String::new())]);
    let mut pages: VecDeque<(reqwest::Url, usize, String)> = VecDeque::new();
    let mut pages_read = 0usize;
    let mut requests = 0usize;
    let mut visited = HashSet::new();
    let mut downloads: HashMap<String, OnlineTitle> = HashMap::new();

    while let Some((url, depth, label)) = files
        .pop_front()
        .or_else(|| unknown.pop_front())
        .or_else(|| pages.pop_front())
    {
        if requests >= MAX_REQUESTS || downloads.len() >= MAX_DOWNLOADS {
            break;
        }
        if !visited.insert(url.as_str().to_string())
            || (!provider.ignore_robots && !robots::allows(&robots, url.path()))
        {
            continue;
        }
        if requests > 0 {
            tokio::time::sleep(delay).await;
        }
        requests += 1;
        // A link is asked about before it is read: a HEAD says whether this is
        // a page or a file, and a site should not have to send a disk image
        // just to be told what it is. A path already known to serve pages skips
        // the question — asking twice for every page of a catalogue is a cost
        // the site pays for nothing.
        let known_page = kinds.get(url.path()) == Some(&false);
        let asked = if known_page {
            None
        } else {
            client.head(url.clone()).send().await.ok().filter(|response| {
                response.status().is_success() || response.status().is_redirection()
            })
        };
        let head_is_page = known_page
            || asked.as_ref().is_none_or(|response| {
            response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_none_or(|value| value.contains("text/html"))
            });
        let response = match asked {
            Some(response) if !head_is_page => response,
            _ => {
                // Reading a page is what the page budget is for, and it is the
                // only thing that spends a second request.
                if pages_read >= MAX_PAGES || depth > MAX_DEPTH {
                    continue;
                }
                requests += 1;
                tokio::time::sleep(delay).await;
                client
                    .get(url.clone())
                    .send()
                    .await
                    .with_context(|| format!("Unable to inspect {url}"))?
            }
        };
        if response.status().is_success() && pages_read == 0 {
            origin = landing_origin(response.url())?;
            directory = start_directory(response.url());
        }
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
        kinds.insert(url.path().to_string(), !is_html);
        if !is_html {
            // Not a page, so this is where a link stopped being a guess: if the
            // server is handing back a supported image, record it under the
            // name the server gives it and the label the page gave it.
            if let Some(name) = downloadable_name(response.headers(), response.url()) {
                let extension = crate::paths::extension_of(Path::new(&name));
                if extensions.contains(&extension) || extension == "zip" {
                    let key = url.as_str().to_string();
                    downloads.entry(key.clone()).or_insert_with(|| OnlineTitle {
                        provider_id: provider.id.clone(),
                        remote_id: key,
                        title: download_title(&label, &name),
                        platform_id: provider
                            .platform_id
                            .clone()
                            .or_else(|| Some(platform_id.to_string())),
                        extension: Some(extension),
                        size: response.content_length().filter(|length| *length > 0),
                        download_url: Some(url.to_string()),
                        details_url: None,
                        license: None,
                        updated: None,
                    });
                }
            }
            continue;
        }
        pages_read += 1;
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
                || (!provider.ignore_robots && !robots::allows(&robots, link.path()))
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
                && within_scope(&directory, link.path())
            {
                // Which queue it joins is a guess from its address; what it
                // turns out to be is decided by the answer, not by the guess.
                let label = link_label(&anchor, &link);
                let queue = match kinds.get(link.path()) {
                    Some(true) => &mut files,
                    Some(false) => &mut pages,
                    None => &mut unknown,
                };
                queue.push_back((link, depth + 1, label));
            }
        }
    }
    let mut titles = downloads.into_values().collect::<Vec<_>>();
    titles.sort_by_key(|title| title.title.to_lowercase());
    Ok(titles)
}

#[cfg(test)]
mod tests {
    use super::{
        attachment_name, downloadable_name, link_extension, link_label, PAGE_EXTENSIONS,
    };

    fn headers(pairs: &[(&str, &str)]) -> reqwest::header::HeaderMap {
        let mut map = reqwest::header::HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                reqwest::header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                value.parse().unwrap(),
            );
        }
        map
    }

    #[test]
    fn a_title_is_named_by_the_file_when_the_page_only_says_download() {
        use super::download_title;

        // Every link on the page reads "Download"; the file knows better.
        assert_eq!(
            download_title("Download", "Syndicate American Revolt (Bullfrog).zip"),
            "Syndicate American Revolt (Bullfrog)"
        );
        assert_eq!(download_title("Download now", "Elite.adf"), "Elite");
        assert_eq!(download_title("  ", "Hellfire (Martech).zip"), "Hellfire (Martech)");
        // A page that does give a real name keeps it.
        assert_eq!(
            download_title("Elite (1988) (Firebird)", "dl-1234.zip"),
            "Elite (1988) (Firebird)"
        );
        // Nothing useful anywhere still produces something to click on.
        assert_eq!(download_title("Download", ""), "Download");
    }

    #[test]
    fn a_download_script_is_recognised_by_what_it_returns() {
        // The shape that prompted this: every title behind dl.php?id=..., whose
        // URL says nothing, and whose response says everything.
        let url = reqwest::Url::parse("https://example.org/dl.php?id=LFHFEEGKJM").unwrap();
        let map = headers(&[
            ("content-type", "application/zip"),
            (
                "content-disposition",
                "attachment; filename=Syndicate (Bullfrog).zip",
            ),
        ]);

        assert_eq!(
            downloadable_name(&map, &url).as_deref(),
            Some("Syndicate (Bullfrog).zip")
        );
        // Judged by its URL alone it looks like one more page to walk.
        assert_eq!(link_extension(&url), "php");
    }

    #[test]
    fn a_page_is_never_mistaken_for_a_download() {
        let url = reqwest::Url::parse("https://example.org/index.php?page=2").unwrap();

        assert_eq!(
            downloadable_name(&headers(&[("content-type", "text/html; charset=utf-8")]), &url),
            None
        );
        assert_eq!(
            downloadable_name(&headers(&[("content-type", "application/xhtml+xml")]), &url),
            None
        );
    }

    #[test]
    fn a_file_with_no_disposition_falls_back_to_its_address() {
        let url = reqwest::Url::parse("https://example.org/files/Elite.adf").unwrap();

        assert_eq!(
            downloadable_name(&headers(&[("content-type", "application/octet-stream")]), &url)
                .as_deref(),
            Some("Elite.adf")
        );
    }

    #[test]
    fn a_disposition_can_never_name_somewhere_else() {
        // Quotes are optional in the wild, and a header is not to be trusted
        // with a path: only the last segment of it is ever used.
        assert_eq!(
            attachment_name(&headers(&[("content-disposition", "attachment; filename=\"Elite.adf\"")]))
                .as_deref(),
            Some("Elite.adf")
        );
        assert_eq!(
            attachment_name(&headers(&[(
                "content-disposition",
                "attachment; filename=../../etc/passwd",
            )]))
            .as_deref(),
            Some("passwd")
        );
        assert_eq!(attachment_name(&headers(&[("content-type", "application/zip")])), None);
    }

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

    fn provider(ignore_robots: bool, user_agent: Option<&str>) -> crate::online::OnlineProvider {
        crate::online::OnlineProvider {
            id: "site".into(),
            name: "Site".into(),
            adapter: crate::online::Adapter::HtmlSite,
            catalog_url: Some("https://example.org/games/".into()),
            query: None,
            platform_id: Some("bbc".into()),
            ignore_robots,
            user_agent: user_agent.map(str::to_string),
        }
    }

    #[test]
    fn the_override_is_off_unless_it_was_asked_for() {
        // Nothing shipped enables it, and a source deserialised without the
        // field must not acquire it.
        let parsed: crate::online::OnlineProvider = serde_json::from_str(
            r#"{"id":"s","name":"S","adapter":"htmlSite","catalogUrl":"https://x/"}"#,
        )
        .unwrap();

        assert!(!parsed.ignore_robots);
        assert!(parsed.user_agent.is_none());
        assert!(!provider(false, None).ignore_robots);
    }

    #[test]
    fn overriding_slows_the_crawl_right_down() {
        // Disregarding the operator's stated preference is not a licence to
        // cost them more; it is a reason to cost them less.
        assert!(super::OVERRIDE_DELAY >= super::REQUEST_DELAY * 10);
    }

    #[test]
    fn the_default_identity_names_the_application() {
        use crate::online::http::USER_AGENT;
        assert!(USER_AGENT.starts_with("GoTekManager/"));
        // A source may override it; the application does not ship doing so.
        assert!(provider(false, None).user_agent.is_none());
        assert_eq!(
            provider(true, Some("Custom/1.0")).user_agent.as_deref(),
            Some("Custom/1.0")
        );
    }

    #[test]
    fn the_crawl_follows_the_starting_page_to_where_it_lands() {
        use super::landing_origin;
        // Redirecting www to the apex is the commonest arrangement there is.
        // Holding later pages to the typed origin dropped every such site at
        // its first page and reported nothing found, which reads as an empty
        // site rather than as a crawl that never started.
        let landed = reqwest::Url::parse("https://abbuc.de/index.php").unwrap();

        assert_eq!(landing_origin(&landed).unwrap(), "https://abbuc.de");

        // A redirect down to plain HTTP is refused rather than followed.
        let insecure = reqwest::Url::parse("http://abbuc.de/").unwrap();
        assert!(landing_origin(&insecure).is_err());
    }

    #[test]
    fn a_crawl_does_not_climb_out_of_the_folder_it_was_pointed_at() {
        use super::{start_directory, within_scope};
        let start =
            reqwest::Url::parse("https://ftp.example.net/collections/Atari%20ST/").unwrap();
        let directory = start_directory(&start);

        assert_eq!(directory, "/collections/Atari%20ST/");
        // Down and sideways within the folder: followed.
        assert!(within_scope(&directory, "/collections/Atari%20ST/packs/"));
        assert!(within_scope(&directory, "/collections/Atari%20ST/"));
        // The parent-directory link every index carries, and what lies beside
        // the chosen folder through it: not followed.
        assert!(!within_scope(&directory, "/collections/"));
        assert!(!within_scope(&directory, "/"));

        // A starting page rather than a folder still names its folder.
        let page = reqwest::Url::parse("https://example.org/bbc/homepage.html").unwrap();
        assert_eq!(start_directory(&page), "/bbc/");
        assert!(within_scope("/bbc/", "/bbc/downloads/list.html"));
        assert!(!within_scope("/bbc/", "/"));

        // A site pointed at its root is not confined to anything.
        assert!(within_scope("/", "/anywhere/at/all"));
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
            ignore_robots: false,
            user_agent: None,
        };
        let extensions = normalise_extensions(vec!["ssd".into(), "dsd".into(), "zip".into()]);

        let titles = tauri::async_runtime::block_on(super::inspect(
            &client(None).unwrap(),
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
