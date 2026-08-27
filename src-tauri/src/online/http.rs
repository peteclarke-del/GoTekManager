//! Shared HTTP rules for every online provider.

use crate::error::{Context, Result};

/// Identifies the application to every site it contacts, so operators can see
/// and, if they wish, block it.
///
/// This is the default and it is deliberately honest. A source may override it,
/// which is the user's decision to make about their own traffic, but the
/// application does not ship pretending to be a browser.
pub const USER_AGENT: &str = concat!("GoTekManager/", env!("CARGO_PKG_VERSION"));

/// Nothing larger than this is downloaded or extracted.
pub const DOWNLOAD_BYTE_LIMIT: u64 = 4 * 1024 * 1024 * 1024;

pub fn client(user_agent: Option<&str>) -> Result<reqwest::Client> {
    let identity = user_agent
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(USER_AGENT);
    reqwest::Client::builder()
        .user_agent(identity)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .context("Unable to start the network client")
}

/// Every provider URL and every download must be HTTPS with a real host.
///
/// This is enforced at the boundary rather than trusted from the frontend, so a
/// hand-edited catalogue cannot introduce `http://` or `file://` sources.
pub fn secure_url(value: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(value).with_context(|| format!("Invalid provider URL {value}"))?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err("Online providers and downloads must use an HTTPS URL.".into());
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::secure_url;

    #[test]
    fn only_https_urls_with_a_host_are_accepted() {
        assert!(secure_url("https://archive.org/download/x").is_ok());
        assert!(secure_url("http://archive.org/download/x").is_err());
        assert!(secure_url("file:///etc/passwd").is_err());
        assert!(secure_url("not a url").is_err());
    }
}
