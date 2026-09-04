//! Whether a newer release of this application has been published.
//!
//! Asked for rather than done on every start: a tool that writes to removable
//! media should not be reaching out to the internet unless someone has asked it
//! a question.
//!
//! The asking is deliberately forgiving. A network that is not there, an API
//! that has changed, a repository with no releases yet — none of those are
//! worth an error, because none of them mean anything is wrong with the copy in
//! front of the user. They mean the question could not be answered, and that is
//! what the empty list says.
//!
//! Which release is newer is decided in the frontend, where the comparison is
//! pure and tested; this only fetches what has been published.

use crate::error::Result;
use crate::online::http::client;
use serde::{Deserialize, Serialize};

const RELEASES_API: &str =
    "https://api.github.com/repos/peteclarke-del/GoTekManager/releases";

/// How many releases to look at. The newest handful is all that can matter.
const MAX_RELEASES: usize = 10;

/// Notes longer than this are cut, with the release page carrying the rest.
const MAX_NOTES: usize = 2000;

/// A release as the interface needs it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedRelease {
    pub tag: String,
    pub name: String,
    pub notes: String,
    pub url: String,
    pub draft: bool,
    pub prerelease: bool,
}

/// A release as GitHub returns it.
#[derive(Deserialize)]
struct ApiRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

/// The version of the application that is running.
///
/// Taken from the crate rather than from anything the interface holds, so what
/// Help reports and what was installed cannot disagree; the packaging keeps
/// this and `tauri.conf.json` in step.
#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// The releases published for this application, newest first.
///
/// An empty list means the question could not be answered — no network, no
/// releases, an API that has moved — and never that the copy in front of the
/// user is the latest. The interface says as much.
#[tauri::command]
pub async fn published_releases() -> Result<Vec<PublishedRelease>> {
    let Ok(client) = client(None) else {
        return Ok(Vec::new());
    };
    let response = client
        .get(RELEASES_API)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await;
    let Ok(response) = response else {
        return Ok(Vec::new());
    };
    if !response.status().is_success() {
        return Ok(Vec::new());
    }
    let Ok(releases) = response.json::<Vec<ApiRelease>>().await else {
        return Ok(Vec::new());
    };

    Ok(releases
        .into_iter()
        .take(MAX_RELEASES)
        .map(|release| PublishedRelease {
            name: release
                .name
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| release.tag_name.clone()),
            notes: shorten(release.body.unwrap_or_default()),
            tag: release.tag_name,
            url: release.html_url,
            draft: release.draft,
            prerelease: release.prerelease,
        })
        .collect())
}

/// Release notes are written for a web page, not for a panel in a dialog.
fn shorten(notes: String) -> String {
    let notes = notes.replace("\r\n", "\n");
    if notes.chars().count() <= MAX_NOTES {
        return notes.trim().to_string();
    }
    let cut: String = notes.chars().take(MAX_NOTES).collect();
    format!("{}\n\n(continues on the release page)", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::{shorten, MAX_NOTES};

    #[test]
    fn short_notes_are_left_alone() {
        assert_eq!(shorten("  Fixes a thing.\n".into()), "Fixes a thing.");
        // Windows line endings would otherwise show as stray characters.
        assert_eq!(shorten("one\r\ntwo".into()), "one\ntwo");
    }

    #[test]
    fn long_notes_are_cut_and_say_where_the_rest_is() {
        let notes = shorten("x".repeat(MAX_NOTES + 500));

        assert!(notes.ends_with("(continues on the release page)"));
        assert!(notes.chars().count() < MAX_NOTES + 100);
    }
}
