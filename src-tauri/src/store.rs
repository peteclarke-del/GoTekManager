//! The application's persistent store.
//!
//! Everything used to live in the webview's `localStorage`, which has three
//! problems that only show up once a library gets real: browsers cap it at a
//! few megabytes, a write that exceeds the cap fails silently, and there is no
//! transaction, so a crash part-way through leaves a half-written document.
//! A library of a few thousand titles is already most of that budget.
//!
//! This is a SQLite database with a versioned schema. A save is one
//! transaction: it either replaces the workspace completely or changes nothing.
//! Columns exist for the richer metadata the library is meant to grow into —
//! digests, provenance, and scan times — so adding it later is a migration
//! rather than a redesign.

use crate::error::{Context, Result};
use crate::task::blocking;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

/// Bumped whenever the schema changes; `migrate` moves an older file forward.
const SCHEMA_VERSION: i64 = 4;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS documents (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
    id               TEXT PRIMARY KEY,
    position         INTEGER NOT NULL,
    name             TEXT NOT NULL,
    destination      TEXT NOT NULL,
    platform_id      TEXT NOT NULL,
    firmware_id      TEXT NOT NULL,
    organise         INTEGER NOT NULL,
    folder_layout    TEXT NOT NULL,
    folder_template  TEXT,
    naming           TEXT NOT NULL,
    verify_checksums INTEGER NOT NULL DEFAULT 0,
    removal_policy   TEXT NOT NULL DEFAULT 'keep',
    display          TEXT
);
CREATE TABLE IF NOT EXISTS sources (
    id         TEXT PRIMARY KEY,
    position   INTEGER NOT NULL,
    name       TEXT NOT NULL,
    path       TEXT NOT NULL,
    scanned_at INTEGER
);
CREATE TABLE IF NOT EXISTS items (
    id                   TEXT PRIMARY KEY,
    source               TEXT NOT NULL,
    path                 TEXT NOT NULL,
    name                 TEXT NOT NULL,
    extension            TEXT NOT NULL,
    size                 INTEGER NOT NULL,
    modified             INTEGER,
    canonical_title      TEXT NOT NULL,
    display_title        TEXT,
    assigned_platform_id TEXT,
    category             TEXT,
    likely_platform_ids  TEXT NOT NULL,
    provenance           TEXT,
    sha256               TEXT,
    indexed_at           INTEGER
);
CREATE INDEX IF NOT EXISTS items_by_source ON items (source);
-- Content fingerprints, so identity is the contents rather than the filename.
-- Keyed by path and validated against size and modification time, so a file is
-- read once and re-read only when it actually changes.
CREATE TABLE IF NOT EXISTS digests (
    path     TEXT PRIMARY KEY,
    size     INTEGER NOT NULL,
    modified INTEGER NOT NULL,
    sha256   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS digests_by_hash ON digests (sha256);
CREATE TABLE IF NOT EXISTS collection_items (
    profile_id TEXT NOT NULL,
    item_id    TEXT NOT NULL,
    position   INTEGER NOT NULL,
    PRIMARY KEY (profile_id, item_id)
);
"#;

// ---------------------------------------------------------------------------
// The shapes exchanged with the interface
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProfile {
    pub id: String,
    pub name: String,
    /// Kept as JSON: the destination's shape belongs to the domain model, and
    /// spreading it over columns would mean a migration for every new field.
    pub destination: serde_json::Value,
    pub platform_id: String,
    pub firmware_id: String,
    pub organise: bool,
    pub folder_layout: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_template: Option<String>,
    pub naming: String,
    #[serde(default)]
    pub verify_checksums: bool,
    /// The drive's panel, written to FF.CFG. Added in schema 4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSource {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredItem {
    pub id: String,
    pub source: String,
    pub path: String,
    pub name: String,
    pub extension: String,
    pub size: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<i64>,
    pub canonical_title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assigned_platform_id: Option<String>,
    /// What the title is — a game, an application, a demo. Added in schema 3.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default)]
    pub likely_platform_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<serde_json::Value>,
    #[serde(default)]
    pub directory: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredWorkspace {
    #[serde(default)]
    pub profiles: Vec<StoredProfile>,
    #[serde(default)]
    pub active_profile_id: String,
    #[serde(default)]
    pub collections: std::collections::HashMap<String, Vec<String>>,
    #[serde(default)]
    pub removal_policies: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub sources: Vec<StoredSource>,
    #[serde(default)]
    pub items: Vec<StoredItem>,
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let folder = app
        .path()
        .app_data_dir()
        .context("Unable to resolve the application data folder")?;
    std::fs::create_dir_all(&folder)?;
    Ok(folder.join("gotek-manager.db"))
}

/// A prepared connection. Shared with the fingerprint cache, which lives in the
/// same database so digests survive a restart.
pub fn connection(app: &tauri::AppHandle) -> Result<Connection> {
    open(app)
}

fn open(app: &tauri::AppHandle) -> Result<Connection> {
    let path = database_path(app)?;
    let connection = Connection::open(&path)
        .with_context(|| format!("Unable to open {}", path.display()))?;
    prepare(&connection)?;
    Ok(connection)
}

pub fn prepare(connection: &Connection) -> Result<()> {
    // Write-ahead logging survives an abrupt exit far better than the default
    // journal, which matters for an application that talks to removable media.
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .context("Unable to enable write-ahead logging")?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .context("Unable to enable foreign keys")?;
    connection
        .execute_batch(SCHEMA)
        .context("Unable to prepare the database schema")?;
    migrate(connection)
}

/// Moves an existing database forward to the current schema.
fn migrate(connection: &Connection) -> Result<()> {
    let version: i64 =
        connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version == SCHEMA_VERSION {
        return Ok(());
    }
    if version > SCHEMA_VERSION {
        return Err(format!(
            "This library was written by a newer version of GoTek Manager (schema {version}). \
             Update the application rather than risk losing data."
        )
        .into());
    }
    // The schema statements above all use CREATE ... IF NOT EXISTS and have
    // already run, so a table that is merely new arrives on its own. A column
    // added to a table that already exists does not, so it is added here.
    add_missing_column(connection, "items", "category", "category TEXT")?;
    add_missing_column(connection, "profiles", "display", "display TEXT")?;
    connection.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}

/// Adds a column to an existing table, and does nothing if it is already there.
///
/// Keyed on the column rather than on the schema version, so a database created
/// fresh by the current schema and one being moved forward from an older
/// version both end up in the same state.
fn add_missing_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<()> {
    let present = connection
        .prepare(&format!("SELECT {column} FROM {table} LIMIT 0"))
        .is_ok();
    if !present {
        connection.execute(&format!("ALTER TABLE {table} ADD COLUMN {definition}"), [])?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

fn read_workspace(connection: &Connection) -> Result<StoredWorkspace> {
    let mut profiles = connection.prepare(
        "SELECT id, name, destination, platform_id, firmware_id, organise, folder_layout, \
         folder_template, naming, verify_checksums, removal_policy, display \
         FROM profiles ORDER BY position",
    )?;
    let mut removal_policies = std::collections::HashMap::new();
    let rows = profiles
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let destination: String = row.get(2)?;
            let policy: String = row.get(10)?;
            Ok((
                StoredProfile {
                    id: id.clone(),
                    name: row.get(1)?,
                    destination: serde_json::from_str(&destination)
                        .unwrap_or(serde_json::Value::Null),
                    platform_id: row.get(3)?,
                    firmware_id: row.get(4)?,
                    organise: row.get::<_, i64>(5)? != 0,
                    folder_layout: row.get(6)?,
                    folder_template: row.get(7)?,
                    naming: row.get(8)?,
                    verify_checksums: row.get::<_, i64>(9)? != 0,
                    display: row.get(11)?,
                },
                id,
                policy,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut ordered = Vec::new();
    for (profile, id, policy) in rows {
        if policy != "keep" {
            removal_policies.insert(id, policy);
        }
        ordered.push(profile);
    }

    let mut sources = connection
        .prepare("SELECT id, name, path FROM sources ORDER BY position")?
        .query_map([], |row| {
            Ok(StoredSource {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    sources.shrink_to_fit();

    let items = connection
        .prepare(
            "SELECT id, source, path, name, extension, size, modified, canonical_title, \
             display_title, assigned_platform_id, category, likely_platform_ids, provenance \
             FROM items ORDER BY name COLLATE NOCASE, path",
        )?
        .query_map([], |row| {
            let likely: String = row.get(11)?;
            let provenance: Option<String> = row.get(12)?;
            Ok(StoredItem {
                id: row.get(0)?,
                source: row.get(1)?,
                path: row.get(2)?,
                name: row.get(3)?,
                extension: row.get(4)?,
                size: row.get(5)?,
                modified: row.get(6)?,
                canonical_title: row.get(7)?,
                display_title: row.get(8)?,
                assigned_platform_id: row.get(9)?,
                category: row.get(10)?,
                likely_platform_ids: serde_json::from_str(&likely).unwrap_or_default(),
                provenance: provenance.and_then(|value| serde_json::from_str(&value).ok()),
                directory: false,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut collections: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    let mut staged = connection
        .prepare("SELECT profile_id, item_id FROM collection_items ORDER BY profile_id, position")?;
    let mut pairs = staged.query([])?;
    while let Some(row) = pairs.next()? {
        collections
            .entry(row.get(0)?)
            .or_default()
            .push(row.get(1)?);
    }

    let active_profile_id: String = connection
        .query_row(
            "SELECT value FROM documents WHERE key = 'activeProfileId'",
            [],
            |row| row.get(0),
        )
        .unwrap_or_default();

    Ok(StoredWorkspace {
        profiles: ordered,
        active_profile_id,
        collections,
        removal_policies,
        sources,
        items,
    })
}

fn write_workspace(connection: &mut Connection, workspace: &StoredWorkspace) -> Result<()> {
    // One transaction: the stored workspace is replaced completely or not at
    // all, so an interrupted save can never leave a half-written library.
    let transaction = connection.transaction()?;
    transaction.execute("DELETE FROM collection_items", [])?;
    transaction.execute("DELETE FROM items", [])?;
    transaction.execute("DELETE FROM sources", [])?;
    transaction.execute("DELETE FROM profiles", [])?;

    for (position, profile) in workspace.profiles.iter().enumerate() {
        let policy = workspace
            .removal_policies
            .get(&profile.id)
            .cloned()
            .unwrap_or_else(|| "keep".into());
        transaction.execute(
            "INSERT INTO profiles (id, position, name, destination, platform_id, firmware_id, \
             organise, folder_layout, folder_template, naming, verify_checksums, \
             removal_policy, display) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![
                profile.id,
                position as i64,
                profile.name,
                serde_json::to_string(&profile.destination)?,
                profile.platform_id,
                profile.firmware_id,
                profile.organise as i64,
                profile.folder_layout,
                profile.folder_template,
                profile.naming,
                profile.verify_checksums as i64,
                policy,
                profile.display,
            ],
        )?;
    }

    for (position, source) in workspace.sources.iter().enumerate() {
        transaction.execute(
            "INSERT INTO sources (id, position, name, path) VALUES (?1,?2,?3,?4)",
            params![source.id, position as i64, source.name, source.path],
        )?;
    }

    for item in &workspace.items {
        transaction.execute(
            "INSERT OR REPLACE INTO items (id, source, path, name, extension, size, modified, \
             canonical_title, display_title, assigned_platform_id, category, \
             likely_platform_ids, provenance) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![
                item.id,
                item.source,
                item.path,
                item.name,
                item.extension,
                item.size,
                item.modified,
                item.canonical_title,
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
    }

    for (profile_id, item_ids) in &workspace.collections {
        for (position, item_id) in item_ids.iter().enumerate() {
            transaction.execute(
                "INSERT OR REPLACE INTO collection_items (profile_id, item_id, position) \
                 VALUES (?1,?2,?3)",
                params![profile_id, item_id, position as i64],
            )?;
        }
    }

    transaction.execute(
        "INSERT OR REPLACE INTO documents (key, value) VALUES ('activeProfileId', ?1)",
        params![workspace.active_profile_id],
    )?;
    transaction.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn load_workspace(app: tauri::AppHandle) -> Result<StoredWorkspace> {
    blocking(move || {
        let connection = open(&app)?;
        read_workspace(&connection)
    })
    .await
}

#[tauri::command]
pub async fn save_workspace(app: tauri::AppHandle, workspace: StoredWorkspace) -> Result<()> {
    blocking(move || {
        let mut connection = open(&app)?;
        write_workspace(&mut connection, &workspace)
    })
    .await
}

/// Small preferences that have no shape worth modelling as tables.
#[tauri::command]
pub async fn read_document(app: tauri::AppHandle, key: String) -> Result<Option<String>> {
    blocking(move || {
        let connection = open(&app)?;
        Ok(connection
            .query_row(
                "SELECT value FROM documents WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .ok())
    })
    .await
}

#[tauri::command]
pub async fn write_document(app: tauri::AppHandle, key: String, value: String) -> Result<()> {
    blocking(move || {
        let connection = open(&app)?;
        connection.execute(
            "INSERT OR REPLACE INTO documents (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        migrate, prepare, read_workspace, write_workspace, StoredItem, StoredProfile,
        StoredSource, StoredWorkspace, SCHEMA_VERSION,
    };
    use rusqlite::Connection;

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        prepare(&connection).unwrap();
        connection
    }

    fn profile(id: &str, name: &str) -> StoredProfile {
        StoredProfile {
            id: id.into(),
            name: name.into(),
            destination: serde_json::json!({ "kind": "folder", "path": "/media/gotek" }),
            platform_id: "bbc".into(),
            firmware_id: "flashfloppy".into(),
            organise: true,
            folder_layout: "platform".into(),
            folder_template: None,
            naming: "oled".into(),
            verify_checksums: true,
            display: Some("oled-128x64-rotate".into()),
        }
    }

    fn item(id: &str, name: &str) -> StoredItem {
        StoredItem {
            id: id.into(),
            source: "/library".into(),
            path: id.into(),
            name: name.into(),
            extension: "ssd".into(),
            size: 204800,
            modified: Some(1234),
            canonical_title: name.into(),
            display_title: None,
            assigned_platform_id: Some("bbc".into()),
            category: Some("games".into()),
            likely_platform_ids: vec!["bbc".into(), "electron".into()],
            provenance: None,
            directory: false,
        }
    }

    fn workspace() -> StoredWorkspace {
        let mut collections = std::collections::HashMap::new();
        collections.insert("p1".to_string(), vec!["i2".to_string(), "i1".to_string()]);
        let mut policies = std::collections::HashMap::new();
        policies.insert("p1".to_string(), "remove".to_string());
        StoredWorkspace {
            profiles: vec![profile("p1", "BBC GOTEK"), profile("p2", "CPC")],
            active_profile_id: "p2".into(),
            collections,
            removal_policies: policies,
            sources: vec![StoredSource {
                id: "s1".into(),
                name: "Library".into(),
                path: "/library".into(),
            }],
            items: vec![item("i1", "Elite.ssd"), item("i2", "Aviator.ssd")],
        }
    }

    #[test]
    fn a_workspace_survives_a_round_trip() {
        let mut connection = connection();

        write_workspace(&mut connection, &workspace()).unwrap();
        let loaded = read_workspace(&connection).unwrap();

        assert_eq!(loaded.profiles.len(), 2);
        assert_eq!(loaded.active_profile_id, "p2");
        assert_eq!(loaded.sources.len(), 1);
        assert_eq!(loaded.items.len(), 2);
        assert!(loaded.profiles[0].verify_checksums);
        assert_eq!(loaded.profiles[0].destination["path"], "/media/gotek");
        assert_eq!(loaded.items[0].likely_platform_ids, vec!["bbc", "electron"]);
        assert_eq!(loaded.items[0].category.as_deref(), Some("games"));
        // The drive's panel travels with its profile, upside down and all.
        assert_eq!(
            loaded.profiles[0].display.as_deref(),
            Some("oled-128x64-rotate")
        );
    }

    #[test]
    fn profile_order_and_collection_order_are_preserved() {
        let mut connection = connection();

        write_workspace(&mut connection, &workspace()).unwrap();
        let loaded = read_workspace(&connection).unwrap();

        assert_eq!(
            loaded.profiles.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["p1", "p2"]
        );
        // The staged order is the user's order and must not be reshuffled.
        assert_eq!(loaded.collections["p1"], vec!["i2".to_string(), "i1".to_string()]);
    }

    #[test]
    fn only_a_non_default_removal_policy_is_recorded() {
        let mut connection = connection();

        write_workspace(&mut connection, &workspace()).unwrap();
        let loaded = read_workspace(&connection).unwrap();

        assert_eq!(loaded.removal_policies.get("p1").map(String::as_str), Some("remove"));
        // "keep" is the default, so it is absent rather than stored redundantly.
        assert!(!loaded.removal_policies.contains_key("p2"));
    }

    #[test]
    fn saving_replaces_the_previous_workspace_completely() {
        let mut connection = connection();
        write_workspace(&mut connection, &workspace()).unwrap();

        let mut smaller = workspace();
        smaller.profiles.truncate(1);
        smaller.items.truncate(1);
        smaller.collections.clear();
        write_workspace(&mut connection, &smaller).unwrap();

        let loaded = read_workspace(&connection).unwrap();
        assert_eq!(loaded.profiles.len(), 1);
        assert_eq!(loaded.items.len(), 1);
        // A removed profile must not leave its staged titles behind.
        assert!(loaded.collections.is_empty());
    }

    #[test]
    fn a_profile_written_before_the_display_setting_gains_the_column() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE profiles (
                    id               TEXT PRIMARY KEY,
                    position         INTEGER NOT NULL,
                    name             TEXT NOT NULL,
                    destination      TEXT NOT NULL,
                    platform_id      TEXT NOT NULL,
                    firmware_id      TEXT NOT NULL,
                    organise         INTEGER NOT NULL,
                    folder_layout    TEXT NOT NULL,
                    folder_template  TEXT,
                    naming           TEXT NOT NULL,
                    verify_checksums INTEGER NOT NULL DEFAULT 0,
                    removal_policy   TEXT NOT NULL DEFAULT 'keep'
                );
                INSERT INTO profiles (id, position, name, destination, platform_id,
                    firmware_id, organise, folder_layout, naming)
                VALUES ('p1',0,'GOTEK','{}','bbc','flashfloppy',1,'platform','oled');",
            )
            .unwrap();
        connection.pragma_update(None, "user_version", 3).unwrap();

        prepare(&connection).unwrap();

        let loaded = read_workspace(&connection).unwrap();
        assert_eq!(loaded.profiles.len(), 1);
        // No panel named yet, which is the firmware's own default.
        assert_eq!(loaded.profiles[0].display, None);
    }

    #[test]
    fn a_library_written_before_categories_gains_the_column() {
        // The shape schema 2 wrote: everything the current one has, without the
        // category. A real library in this state must survive the upgrade with
        // its titles intact rather than be refused or rebuilt.
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE items (
                    id                   TEXT PRIMARY KEY,
                    source               TEXT NOT NULL,
                    path                 TEXT NOT NULL,
                    name                 TEXT NOT NULL,
                    extension            TEXT NOT NULL,
                    size                 INTEGER NOT NULL,
                    modified             INTEGER,
                    canonical_title      TEXT NOT NULL,
                    display_title        TEXT,
                    assigned_platform_id TEXT,
                    likely_platform_ids  TEXT NOT NULL,
                    provenance           TEXT,
                    sha256               TEXT,
                    indexed_at           INTEGER
                );
                INSERT INTO items (id, source, path, name, extension, size, canonical_title,
                    likely_platform_ids)
                VALUES ('i1','/library','/library/Elite.ssd','Elite.ssd','ssd',204800,
                    'Elite.ssd','[\"bbc\"]');",
            )
            .unwrap();
        connection.pragma_update(None, "user_version", 2).unwrap();

        prepare(&connection).unwrap();

        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let loaded = read_workspace(&connection).unwrap();
        assert_eq!(loaded.items.len(), 1);
        // The column is there and empty, which is exactly "not categorised yet".
        assert_eq!(loaded.items[0].category, None);
    }

    #[test]
    fn an_empty_database_reads_as_an_empty_workspace() {
        let loaded = read_workspace(&connection()).unwrap();

        assert!(loaded.profiles.is_empty());
        assert!(loaded.items.is_empty());
        assert_eq!(loaded.active_profile_id, "");
    }

    #[test]
    fn a_library_far_beyond_the_browser_storage_limit_round_trips() {
        // The whole reason for moving off localStorage: a few thousand titles
        // is already most of a browser's quota, and exceeding it fails silently.
        let mut connection = connection();
        let mut large = workspace();
        large.items = (0..5000)
            .map(|index| item(&format!("i{index}"), &format!("Title {index}.ssd")))
            .collect();

        write_workspace(&mut connection, &large).unwrap();
        let loaded = read_workspace(&connection).unwrap();

        assert_eq!(loaded.items.len(), 5000);
    }

    #[test]
    fn a_database_from_a_newer_version_is_refused_rather_than_damaged() {
        let connection = connection();
        connection
            .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();

        let error = migrate(&connection).unwrap_err();

        assert!(error.to_string().contains("newer version"));
    }

    #[test]
    fn the_schema_version_is_stamped_on_a_new_database() {
        let version: i64 = connection()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();

        assert_eq!(version, SCHEMA_VERSION);
    }
}

// ---------------------------------------------------------------------------
// Editable configuration files
// ---------------------------------------------------------------------------

/// A configuration file the user may edit by hand.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    /// Always returned, whether or not the file is there, so the interface can
    /// say where to put one.
    pub path: String,
    pub contents: Option<String>,
}

/// Reads a named file from the application's configuration folder.
///
/// The name is a bare filename: anything with a separator in it is refused, so
/// this can only ever read from that one folder.
#[tauri::command]
pub async fn read_config_file(app: tauri::AppHandle, name: String) -> Result<ConfigFile> {
    blocking(move || {
        if name.contains(['/', '\\']) || name.contains("..") || name.is_empty() {
            return Err("A configuration file name cannot contain a path.".into());
        }
        let folder = app
            .path()
            .app_config_dir()
            .context("Unable to resolve the configuration folder")?;
        std::fs::create_dir_all(&folder)?;
        let path = folder.join(&name);
        Ok(ConfigFile {
            contents: std::fs::read_to_string(&path).ok(),
            path: path.to_string_lossy().into_owned(),
        })
    })
    .await
}
