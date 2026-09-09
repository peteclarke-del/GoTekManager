//! Changing the library without rewriting it.
//!
//! The workspace used to travel whole: every title read into the window at
//! startup and handed back in full whenever anything changed. That is a
//! seventeen-second write for a library of forty-five thousand, it grows with
//! the collection, and two of them landing together is where "the database is
//! locked" came from.
//!
//! So the library stays here and changes are stated rather than shipped. Each
//! command below names the rows it touches and touches no others, which is why
//! staging a title is instant however much else the user owns.
//!
//! Reading it back is [`crate::store::query_items`], which answers the screen's
//! question rather than handing over the collection to be filtered in
//! JavaScript.

use crate::error::Result;
use crate::store::{identity, item_from_row, open, write_transaction, StoredItem, ITEM_COLUMNS};
use crate::task::blocking;
use rusqlite::{params, Transaction};

/// The fields of an item that a person can change by hand.
///
/// Each is `Option` twice over: absent means "leave this alone", and present
/// but null means "clear it". Without the distinction, clearing a display title
/// and not mentioning it would be the same request.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemChanges {
    #[serde(default, with = "double_option")]
    pub assigned_platform_id: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    pub category: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    pub display_title: Option<Option<String>>,
}

/// Tells "absent" from "present and null" when deserialising.
mod double_option {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
    where
        D: Deserializer<'de>,
        T: Deserialize<'de>,
    {
        Option::deserialize(deserializer).map(Some)
    }
}

/// Writes one item and the platform rows that belong with it.
///
/// Membership is derived from the item, so it is rewritten with the item and
/// the two can never drift apart.
fn put_item(transaction: &Transaction, item: &StoredItem) -> Result<()> {
    transaction.execute(
        "INSERT OR REPLACE INTO items (id, source, path, name, extension, size, modified, \
         canonical_title, display_title, assigned_platform_id, category, \
         likely_platform_ids, provenance) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            identity(item),
            item.source,
            item.path,
            item.name,
            item.extension,
            item.size,
            item.modified,
            item.canonical_title.as_deref().unwrap_or(&item.name),
            item.display_title,
            item.assigned_platform_id,
            item.category,
            serde_json::to_string(&item.likely_platform_ids)?,
            item.provenance
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
        ],
    )?;
    transaction.execute(
        "DELETE FROM item_platforms WHERE item_id = ?1",
        params![identity(item)],
    )?;
    for platform in &item.likely_platform_ids {
        transaction.execute(
            "INSERT OR IGNORE INTO item_platforms (item_id, platform_id) VALUES (?1, ?2)",
            params![identity(item), platform],
        )?;
    }
    Ok(())
}

/// Forgets an item everywhere it is referred to.
///
/// Staging refers to items by id, so a title dropped from the library has to
/// leave the profiles that staged it as well — otherwise a write would plan
/// around a file that is no longer known.
fn drop_items(
    transaction: &Transaction,
    where_clause: &str,
    bound: &[&dyn rusqlite::ToSql],
) -> Result<()> {
    transaction.execute(
        &format!(
            "DELETE FROM item_platforms WHERE item_id IN (SELECT id FROM items WHERE {where_clause})"
        ),
        bound,
    )?;
    transaction.execute(
        &format!(
            "DELETE FROM collection_items \
             WHERE item_id IN (SELECT id FROM items WHERE {where_clause})"
        ),
        bound,
    )?;
    transaction.execute(&format!("DELETE FROM items WHERE {where_clause}"), bound)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands: the library
// ---------------------------------------------------------------------------

/// Replaces everything indexed from one source with what was just found there.
///
/// One transaction, because a source that is half re-indexed is worse than one
/// that was never re-indexed: the titles that went missing would be unstaged
/// and the ones that arrived would not be there to replace them.
#[tauri::command]
pub async fn replace_source_items(
    app: tauri::AppHandle,
    source: String,
    items: Vec<StoredItem>,
) -> Result<()> {
    blocking(move || {
        let mut connection = open(&app)?;
        let transaction = write_transaction(&mut connection)?;
        drop_items(&transaction, "source = ?1", &[&source])?;
        for item in &items {
            put_item(&transaction, item)?;
        }
        transaction.commit()?;
        Ok(())
    })
    .await
}

/// Adds or updates titles without disturbing anything else.
#[tauri::command]
pub async fn upsert_items(app: tauri::AppHandle, items: Vec<StoredItem>) -> Result<()> {
    blocking(move || {
        let mut connection = open(&app)?;
        let transaction = write_transaction(&mut connection)?;
        for item in &items {
            put_item(&transaction, item)?;
        }
        transaction.commit()?;
        Ok(())
    })
    .await
}

/// Forgets a source and everything indexed from it.
#[tauri::command]
pub async fn forget_source(app: tauri::AppHandle, source: String) -> Result<()> {
    blocking(move || {
        let mut connection = open(&app)?;
        let transaction = write_transaction(&mut connection)?;
        drop_items(&transaction, "source = ?1", &[&source])?;
        transaction.execute("DELETE FROM sources WHERE path = ?1", params![source])?;
        transaction.commit()?;
        Ok(())
    })
    .await
}

/// Applies one person's decision to a set of titles.
#[tauri::command]
pub async fn update_items(
    app: tauri::AppHandle,
    ids: Vec<String>,
    changes: ItemChanges,
) -> Result<()> {
    blocking(move || {
        if ids.is_empty() {
            return Ok(());
        }
        let mut assignments: Vec<&str> = Vec::new();
        let mut bound: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(value) = &changes.assigned_platform_id {
            assignments.push("assigned_platform_id = ?");
            bound.push(Box::new(value.clone()));
        }
        if let Some(value) = &changes.category {
            assignments.push("category = ?");
            bound.push(Box::new(value.clone()));
        }
        if let Some(value) = &changes.display_title {
            assignments.push("display_title = ?");
            bound.push(Box::new(value.clone()));
        }
        if assignments.is_empty() {
            return Ok(());
        }

        let mut connection = open(&app)?;
        let transaction = write_transaction(&mut connection)?;
        // In batches, because a library allows a person to select every title
        // they own and SQLite will not take an unbounded number of parameters.
        for batch in ids.chunks(500) {
            let holes = vec!["?"; batch.len()].join(",");
            let mut params: Vec<&dyn rusqlite::ToSql> =
                bound.iter().map(|value| &**value).collect();
            for id in batch {
                params.push(id);
            }
            transaction.execute(
                &format!(
                    "UPDATE items SET {} WHERE id IN ({holes})",
                    assignments.join(", ")
                ),
                params.as_slice(),
            )?;
        }
        transaction.commit()?;
        Ok(())
    })
    .await
}

/// Empties the library, leaving profiles and their settings alone.
#[tauri::command]
pub async fn clear_library(app: tauri::AppHandle) -> Result<()> {
    blocking(move || {
        let mut connection = open(&app)?;
        let transaction = write_transaction(&mut connection)?;
        transaction.execute("DELETE FROM collection_items", [])?;
        transaction.execute("DELETE FROM item_platforms", [])?;
        transaction.execute("DELETE FROM items", [])?;
        transaction.execute("DELETE FROM sources", [])?;
        transaction.commit()?;
        Ok(())
    })
    .await
}

/// The names of everything held for one machine, and nothing else about them.
///
/// The online catalogue marks the titles already owned, which means comparing
/// every name in the library against every name in the catalogue. That is the
/// one question that genuinely wants the whole library — but it wants two short
/// strings per title rather than the rows, and it is asked when somebody opens
/// the catalogue rather than when the application starts.
#[tauri::command]
pub async fn held_titles(app: tauri::AppHandle, platform_id: String) -> Result<Vec<String>> {
    blocking(move || {
        let connection = open(&app)?;
        let mut names = Vec::new();
        let mut statement = connection.prepare(
            "SELECT name, canonical_title FROM items \
             WHERE (CASE WHEN assigned_platform_id IS NOT NULL AND assigned_platform_id <> '' \
                    THEN assigned_platform_id = ?1 \
                    ELSE EXISTS (SELECT 1 FROM item_platforms \
                                 WHERE item_platforms.item_id = items.id \
                                 AND item_platforms.platform_id = ?1) END)",
        )?;
        let mut rows = statement.query(params![platform_id])?;
        while let Some(row) = rows.next()? {
            let name: String = row.get(0)?;
            let title: String = row.get(1)?;
            if title != name {
                names.push(title);
            }
            names.push(name);
        }
        Ok(names)
    })
    .await
}

// ---------------------------------------------------------------------------
// Commands: what a profile has staged
// ---------------------------------------------------------------------------

/// The titles one profile has staged, in the order they were staged.
///
/// Only the active profile's staging is ever asked for, so switching profile
/// costs one query rather than every profile's selection being carried around
/// from the moment the application opens.
#[tauri::command]
pub async fn staged_items(app: tauri::AppHandle, profile_id: String) -> Result<Vec<StoredItem>> {
    blocking(move || {
        let connection = open(&app)?;
        let rows = connection
            .prepare(&format!(
                "{ITEM_COLUMNS} FROM items \
                 JOIN collection_items ON collection_items.item_id = items.id \
                 WHERE collection_items.profile_id = ?1 \
                 ORDER BY collection_items.position"
            ))?
            .query_map(params![profile_id], item_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .await
}

/// Stages titles, appending them after whatever is already staged.
#[tauri::command]
pub async fn stage_items(
    app: tauri::AppHandle,
    profile_id: String,
    ids: Vec<String>,
) -> Result<()> {
    blocking(move || {
        let mut connection = open(&app)?;
        let transaction = write_transaction(&mut connection)?;
        let mut next: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM collection_items WHERE profile_id = ?1",
            params![profile_id],
            |row| row.get(0),
        )?;
        for id in &ids {
            // A title already staged keeps the place it has; staging it again
            // is not a request to move it to the end of the list.
            let changed = transaction.execute(
                "INSERT OR IGNORE INTO collection_items (profile_id, item_id, position) \
                 VALUES (?1, ?2, ?3)",
                params![profile_id, id, next],
            )?;
            if changed > 0 {
                next += 1;
            }
        }
        transaction.commit()?;
        Ok(())
    })
    .await
}

/// Takes titles out of a profile's staging.
#[tauri::command]
pub async fn unstage_items(
    app: tauri::AppHandle,
    profile_id: String,
    ids: Vec<String>,
) -> Result<()> {
    blocking(move || {
        let mut connection = open(&app)?;
        let transaction = write_transaction(&mut connection)?;
        for batch in ids.chunks(500) {
            let holes = vec!["?"; batch.len()].join(",");
            let mut bound: Vec<&dyn rusqlite::ToSql> = vec![&profile_id];
            for id in batch {
                bound.push(id);
            }
            transaction.execute(
                &format!(
                    "DELETE FROM collection_items WHERE profile_id = ?1 AND item_id IN ({holes})"
                ),
                bound.as_slice(),
            )?;
        }
        transaction.commit()?;
        Ok(())
    })
    .await
}

/// Empties one profile's staging.
#[tauri::command]
pub async fn clear_collection(app: tauri::AppHandle, profile_id: String) -> Result<()> {
    blocking(move || {
        let connection = open(&app)?;
        connection.execute(
            "DELETE FROM collection_items WHERE profile_id = ?1",
            params![profile_id],
        )?;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{prepare, ITEM_ORDER};
    use rusqlite::Connection;

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        prepare(&connection).unwrap();
        connection
    }

    fn item(path: &str, name: &str, platforms: &[&str]) -> StoredItem {
        StoredItem {
            id: None,
            source: "/library".into(),
            path: path.into(),
            name: name.into(),
            extension: "adf".into(),
            size: 901_120,
            modified: Some(1234),
            canonical_title: None,
            display_title: None,
            assigned_platform_id: None,
            category: Some("games".into()),
            likely_platform_ids: platforms.iter().map(|p| (*p).to_string()).collect(),
            provenance: None,
            directory: false,
        }
    }

    fn store(connection: &mut Connection, items: &[StoredItem]) {
        let transaction = connection.transaction().unwrap();
        for entry in items {
            put_item(&transaction, entry).unwrap();
        }
        transaction.commit().unwrap();
    }

    /// Reads items back the way the library page does, so these checks exercise
    /// the same path the application uses rather than a private one.
    fn read_all(connection: &Connection) -> Vec<StoredItem> {
        connection
            .prepare(&format!("{ITEM_COLUMNS} FROM items ORDER BY {ITEM_ORDER}"))
            .unwrap()
            .query_map([], item_from_row)
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap()
    }

    /// The reason the library left local storage: a few thousand titles is
    /// already most of a browser's quota, and exceeding it fails silently.
    #[test]
    fn a_library_far_beyond_the_browser_storage_limit_round_trips() {
        let mut connection = connection();
        let many: Vec<StoredItem> = (0..5000)
            .map(|index| {
                item(
                    &format!("/library/{index}.adf"),
                    &format!("Title {index}.adf"),
                    &["amiga"],
                )
            })
            .collect();

        store(&mut connection, &many);

        assert_eq!(read_all(&connection).len(), 5000);
    }

    /// A downloaded title is named by the catalogue it came from and may be
    /// identified by something other than where it was cached, so both have to
    /// survive; a scanned title has neither, and must not acquire one.
    #[test]
    fn a_title_named_by_its_catalogue_keeps_that_name_across_a_save() {
        let mut connection = connection();
        let mut download = item("/cache/00fa3b.adf", "00fa3b.adf", &["amiga"]);
        download.id = Some("download:elite:1".into());
        download.canonical_title = Some("Elite (Disk 1)".into());
        store(
            &mut connection,
            &[
                item("/library/Elite.adf", "Elite.adf", &["amiga"]),
                download,
            ],
        );

        let loaded = read_all(&connection);
        let scanned = loaded
            .iter()
            .find(|i| i.path == "/library/Elite.adf")
            .unwrap();
        assert_eq!(scanned.id, None, "a scanned title is its path");
        assert_eq!(scanned.canonical_title, None, "a scanned title is its file");

        let back = loaded
            .iter()
            .find(|i| i.path == "/cache/00fa3b.adf")
            .unwrap();
        assert_eq!(back.id.as_deref(), Some("download:elite:1"));
        assert_eq!(back.canonical_title.as_deref(), Some("Elite (Disk 1)"));
    }

    #[test]
    fn membership_is_written_with_the_item_it_belongs_to() {
        let mut connection = connection();
        store(
            &mut connection,
            &[item("/a/Elite.adf", "Elite.adf", &["amiga", "st"])],
        );

        let platforms: Vec<String> = connection
            .prepare("SELECT platform_id FROM item_platforms ORDER BY platform_id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(platforms, vec!["amiga".to_string(), "st".to_string()]);
    }

    #[test]
    fn re_indexing_an_item_leaves_no_membership_behind() {
        let mut connection = connection();
        store(
            &mut connection,
            &[item("/a/Elite.adf", "Elite.adf", &["amiga", "st"])],
        );
        store(
            &mut connection,
            &[item("/a/Elite.adf", "Elite.adf", &["st"])],
        );

        let count: i64 = connection
            .query_row("SELECT count(*) FROM item_platforms", [], |row| row.get(0))
            .unwrap();

        assert_eq!(count, 1, "the machine it no longer runs on should be gone");
    }

    /// A title dropped from the library must leave the profiles that staged it,
    /// or a write would plan around a file nothing knows about any more.
    #[test]
    fn forgetting_a_title_unstages_it_everywhere() {
        let mut connection = connection();
        store(
            &mut connection,
            &[item("/a/Elite.adf", "Elite.adf", &["amiga"])],
        );
        connection
            .execute(
                "INSERT INTO collection_items (profile_id, item_id, position) \
                 VALUES ('p1', '/a/Elite.adf', 0)",
                [],
            )
            .unwrap();

        let transaction = connection.transaction().unwrap();
        drop_items(&transaction, "source = ?1", &[&"/library"]).unwrap();
        transaction.commit().unwrap();

        for table in ["items", "item_platforms", "collection_items"] {
            let count: i64 = connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table} should have nothing left");
        }
    }
}
