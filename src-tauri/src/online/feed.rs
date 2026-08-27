//! Structured JSON catalogues.
//!
//! A feed may be a full download source or a bare list of known titles used
//! only for collection-coverage comparison, so `downloadUrl` is optional.

use super::{OnlineProvider, OnlineTitle};
use crate::error::Result;
use crate::online::http::secure_url;

/// Accepts either a bare array or `{ "items": [...] }`.
pub fn normalise(
    value: serde_json::Value,
    provider: &OnlineProvider,
    platform_id: Option<&str>,
) -> Result<Vec<OnlineTitle>> {
    let items = value
        .as_array()
        .or_else(|| value.get("items").and_then(serde_json::Value::as_array))
        .ok_or("The JSON catalogue must be an array or an object containing an items array.")?;
    items
        .iter()
        .cloned()
        .map(|item| {
            let mut title: OnlineTitle = serde_json::from_value(item)
                .map_err(|error| format!("Invalid catalogue item: {error}"))?;
            if title.remote_id.trim().is_empty() || title.title.trim().is_empty() {
                return Err("Catalogue items require remoteId and title.".into());
            }
            // A feed cannot smuggle in a plain-HTTP or local-file download.
            for url in [title.download_url.as_deref(), title.details_url.as_deref()]
                .into_iter()
                .flatten()
            {
                secure_url(url)?;
            }
            title.provider_id = provider.id.clone();
            title.platform_id = title
                .platform_id
                .or_else(|| provider.platform_id.clone())
                .or_else(|| platform_id.map(str::to_string));
            title.extension = title
                .extension
                .map(|value| value.trim_start_matches('.').to_lowercase());
            Ok(title)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::normalise;
    use crate::online::{Adapter, OnlineProvider};

    fn provider() -> OnlineProvider {
        OnlineProvider {
            id: "known-bbc".into(),
            name: "Known BBC titles".into(),
            adapter: Adapter::JsonFeed,
            catalog_url: Some("https://example.org/bbc.json".into()),
            query: None,
            platform_id: None,
        }
    }

    #[test]
    fn a_bare_array_and_an_items_object_are_both_accepted() {
        let array = serde_json::json!([{ "remoteId": "elite", "title": "Elite" }]);
        let object = serde_json::json!({ "items": [{ "remoteId": "elite", "title": "Elite" }] });

        let from_array = normalise(array, &provider(), Some("bbc")).unwrap();
        let from_object = normalise(object, &provider(), Some("bbc")).unwrap();

        assert_eq!(from_array.len(), 1);
        assert_eq!(from_object.len(), 1);
        assert_eq!(from_array[0].platform_id.as_deref(), Some("bbc"));
        assert_eq!(from_array[0].provider_id, "known-bbc");
    }

    #[test]
    fn extensions_are_normalised_and_identity_fields_are_required() {
        let feed = serde_json::json!([
            { "remoteId": "elite", "title": "Elite", "extension": ".SSD" }
        ]);

        let titles = normalise(feed, &provider(), Some("bbc")).unwrap();

        assert_eq!(titles[0].extension.as_deref(), Some("ssd"));

        let missing = serde_json::json!([{ "remoteId": " ", "title": "Elite" }]);
        assert!(normalise(missing, &provider(), Some("bbc")).is_err());
    }

    #[test]
    fn insecure_download_urls_are_rejected_at_the_boundary() {
        let feed = serde_json::json!([
            { "remoteId": "elite", "title": "Elite", "downloadUrl": "http://example.org/e.ssd" }
        ]);

        assert!(normalise(feed, &provider(), Some("bbc")).is_err());
    }

    #[test]
    fn a_reference_only_list_without_downloads_is_valid() {
        let feed = serde_json::json!([{ "remoteId": "elite", "title": "Elite" }]);

        let titles = normalise(feed, &provider(), Some("bbc")).unwrap();

        assert!(titles[0].download_url.is_none());
    }
}
