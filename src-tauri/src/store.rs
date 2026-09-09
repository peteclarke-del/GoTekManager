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
use rusqlite::{params, Connection, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tauri::Manager;

/// Bumped whenever the schema changes; `migrate` moves an older file forward.
const SCHEMA_VERSION: i64 = 6;

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
    display          TEXT,
    category_folders TEXT
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
CREATE INDEX IF NOT EXISTS collection_by_item ON collection_items (item_id);
-- Which machines a title might run on, one row per machine.
--
-- The same answer as the item's own `likely_platform_ids`, which is a JSON
-- array in a text column and therefore cannot be indexed or joined: asking
-- "everything for the Amiga" of a text column means a LIKE that reads every
-- row and matches any platform whose name contains another's. The library page
-- asks exactly that question of every screen it draws, so the answer lives
-- where an index can reach it.
CREATE TABLE IF NOT EXISTS item_platforms (
    item_id     TEXT NOT NULL,
    platform_id TEXT NOT NULL,
    PRIMARY KEY (item_id, platform_id)
);
CREATE INDEX IF NOT EXISTS item_platforms_by_platform
    ON item_platforms (platform_id);
-- The order the library is listed in, so a page of it can be taken without
-- sorting the whole table first.
CREATE INDEX IF NOT EXISTS items_by_name ON items (name COLLATE NOCASE, path);
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
    /// The destination's own folder name for each category, by category id.
    ///
    /// Kept as JSON for the same reason the destination is: which categories
    /// exist belongs to the domain model, and a column apiece would mean a
    /// migration every time one was added. Added in schema 5.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_folders: Option<serde_json::Value>,
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
    /// The item's own identity, when it is not simply where the file is.
    ///
    /// A scanned title is identified by its path, so for all but a handful of
    /// rows these two are the same string — and the path is the longest column
    /// in the library. Carrying both doubles it, several megabytes across a
    /// large collection, for no information at all, so it travels only when it
    /// genuinely differs. See {@link identity}.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub source: String,
    pub path: String,
    pub name: String,
    pub extension: String,
    pub size: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<i64>,
    /// The real name of the title, when it is not simply the file's name.
    ///
    /// Left out for the same reason as `id`: a scanned title is named by its
    /// file, and only a download — which is named by the catalogue it came
    /// from — has anything different to say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_title: Option<String>,
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
/// The workspace's own shape: everything except the library itself.
///
/// Profiles and sources are tens of rows however large a collection grows, so
/// they are still read and written whole. The library is not, and neither is
/// what a profile has staged: those are asked for by the screen that needs them
/// and changed by the commands in {@link crate::library}. Loading them here
/// would put the size of the collection back in the path of every start and
/// every save, which is the thing this shape exists to avoid.
pub struct StoredWorkspace {
    #[serde(default)]
    pub profiles: Vec<StoredProfile>,
    #[serde(default)]
    pub active_profile_id: String,
    #[serde(default)]
    pub removal_policies: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub sources: Vec<StoredSource>,
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

pub(crate) fn open(app: &tauri::AppHandle) -> Result<Connection> {
    let path = database_path(app)?;
    let connection = Connection::open(&path)
        .with_context(|| format!("Unable to open {}", path.display()))?;
    prepare(&connection)?;
    Ok(connection)
}

/// How long a writer waits for another one to finish before giving up.
///
/// Several connections write by design: the workspace is saved while a transfer
/// records fingerprints. Saving replaces the whole workspace in one
/// transaction, which on a library of tens of thousands of items takes long
/// enough that the driver's own five-second default runs out — and the user is
/// told the database is locked when nothing is wrong and the wait would have
/// ended. Thirty seconds is well past any write here and still short enough
/// that a genuine deadlock surfaces rather than hanging the window forever.
const BUSY_TIMEOUT: Duration = Duration::from_secs(30);

/// Begins a transaction that is going to write.
///
/// A plain `BEGIN` is deferred: the write lock is taken at the first statement
/// that actually writes, and a connection that reaches that point while another
/// one is writing is refused there and then with "database is locked". The
/// timeout above does not cover that refusal. SQLite deliberately skips the
/// busy handler for a transaction that has already read, because two of them
/// waiting to upgrade would wait on each other forever, so it fails one rather
/// than deadlocking both.
///
/// `BEGIN IMMEDIATE` asks for the write lock at the start instead, before
/// anything has been read, where waiting is safe and the handler does run. A
/// workspace save that overlaps a scan then queues behind it for as long as the
/// timeout allows rather than failing in front of the person using it.
pub(crate) fn write_transaction(connection: &mut Connection) -> Result<Transaction<'_>> {
    Ok(connection.transaction_with_behavior(TransactionBehavior::Immediate)?)
}

pub fn prepare(connection: &Connection) -> Result<()> {
    // Before anything else, so it covers the schema statements below as well.
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .context("Unable to set the database busy timeout")?;
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
    add_missing_column(
        connection,
        "profiles",
        "category_folders",
        "category_folders TEXT",
    )?;
    // Schema 6 moved platform membership into a table of its own. The rows are
    // derived, so a library written before it simply has them built once here
    // rather than being asked to re-read the collection.
    if version < 6 {
        fill_item_platforms(connection)?;
    }
    connection.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}

/// Adds a column to an existing table, and does nothing if it is already there.
///
/// Keyed on the column rather than on the schema version, so a database created
/// fresh by the current schema and one being moved forward from an older
/// version both end up in the same state.
/// Rebuilds platform membership from the items' own JSON column.
///
/// Used once when an older library is opened; from then on membership is
/// written with each item, so the two can never disagree about what runs where.
///
/// One statement, done inside SQLite. A library of forty-five thousand titles
/// is a few hundred thousand of these rows, and sending them one at a time —
/// each its own transaction, each a flush to the disk — turns seconds of work
/// into many minutes of it. Nothing is stamped until this returns, so an
/// upgrade interrupted part-way is simply an upgrade that has not happened yet.
fn fill_item_platforms(connection: &Connection) -> Result<()> {
    let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    transaction.execute("DELETE FROM item_platforms", [])?;
    transaction.execute(
        "INSERT OR IGNORE INTO item_platforms (item_id, platform_id) \
         SELECT items.id, json_each.value FROM items, json_each(items.likely_platform_ids)",
        [],
    )?;
    transaction.commit()?;
    Ok(())
}

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

/// The columns an item is read from, in the order `item_from_row` expects.
pub(crate) const ITEM_COLUMNS: &str = "SELECT id, source, path, name, extension, size, modified, \
     canonical_title, display_title, assigned_platform_id, category, likely_platform_ids, \
     provenance";

/// How the library is listed. Matched by `items_by_name` so a page can be taken
/// without sorting the whole table to find it.
pub(crate) const ITEM_ORDER: &str = "name COLLATE NOCASE, path";

/// One row of `ITEM_COLUMNS` as an item.
///
/// The identity and the title are folded away when they say nothing the path
/// and the name do not; see {@link StoredItem}.
pub(crate) fn item_from_row(row: &rusqlite::Row) -> rusqlite::Result<StoredItem> {
    let likely: String = row.get(11)?;
    let provenance: Option<String> = row.get(12)?;
    let id: String = row.get(0)?;
    let path: String = row.get(2)?;
    let title: String = row.get(7)?;
    let name: String = row.get(3)?;
    Ok(StoredItem {
        id: (id != path).then_some(id),
        source: row.get(1)?,
        name: name.clone(),
        extension: row.get(4)?,
        size: row.get(5)?,
        modified: row.get(6)?,
        canonical_title: (title != name).then_some(title),
        path,
        display_title: row.get(8)?,
        assigned_platform_id: row.get(9)?,
        category: row.get(10)?,
        likely_platform_ids: serde_json::from_str(&likely).unwrap_or_default(),
        provenance: provenance.and_then(|value| serde_json::from_str(&value).ok()),
        directory: false,
    })
}

fn read_workspace(connection: &Connection) -> Result<StoredWorkspace> {
    let mut profiles = connection.prepare(
        "SELECT id, name, destination, platform_id, firmware_id, organise, folder_layout, \
         folder_template, naming, verify_checksums, removal_policy, display, \
         category_folders FROM profiles ORDER BY position",
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
                    category_folders: row
                        .get::<_, Option<String>>(12)?
                        .and_then(|folders| serde_json::from_str(&folders).ok()),
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
        removal_policies,
        sources,
    })
}

/// An item's identity: its own, or the path that stands in for it.
///
/// One place decides this, because a staged collection refers to items by it
/// and a disagreement here would silently unstage somebody's whole selection.
pub(crate) fn identity(item: &StoredItem) -> &str {
    item.id.as_deref().unwrap_or(&item.path)
}

fn write_workspace(connection: &mut Connection, workspace: &StoredWorkspace) -> Result<()> {
    // One transaction: the stored workspace is replaced completely or not at
    // all, so an interrupted save can never leave a half-written library.
    let transaction = write_transaction(connection)?;
    // Only what this command owns. The library and what each profile has staged
    // belong to the commands in {@link crate::library}, and clearing them here
    // would make saving a renamed profile throw away the collection.
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
             removal_policy, display, category_folders) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
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
                profile
                    .category_folders
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
            ],
        )?;
    }

    for (position, source) in workspace.sources.iter().enumerate() {
        transaction.execute(
            "INSERT INTO sources (id, position, name, path) VALUES (?1,?2,?3,?4)",
            params![source.id, position as i64, source.name, source.path],
        )?;
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

// ---------------------------------------------------------------------------
// Asking the library a question
// ---------------------------------------------------------------------------

/// What the library page is showing: a filter, an order, and one page of it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemQuery {
    /// Titles this machine might run. Empty asks for the whole library.
    #[serde(default)]
    pub platform_id: String,
    /// Restrict to these source folders. Empty means all of them.
    #[serde(default)]
    pub sources: Vec<String>,
    /// Matched against the file's name, anywhere in it.
    #[serde(default)]
    pub search: String,
    /// One of the column names below; anything else lists by name.
    #[serde(default)]
    pub sort: String,
    #[serde(default)]
    pub descending: bool,
    #[serde(default)]
    pub offset: i64,
    /// How many rows to return. Zero asks only for the counts.
    #[serde(default)]
    pub limit: i64,
}

/// A page of the library, and the shape of the whole answer around it.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemPage {
    pub rows: Vec<StoredItem>,
    /// How many titles match, of which `rows` is one page.
    pub total: i64,
    /// How many each source contributes, so the sidebar can say so without a
    /// second pass over the library.
    pub by_source: std::collections::HashMap<String, i64>,
}

/// The column each sort key orders by.
///
/// A fixed table rather than anything built from the request: these names are
/// interpolated into SQL, and a table is the difference between a sort key and
/// an injection. An unknown key lists by name, which is what the page does
/// before anybody has chosen.
fn order_by(sort: &str) -> &'static str {
    match sort {
        "title" => "canonical_title COLLATE NOCASE",
        "platform" => "assigned_platform_id",
        "category" => "category",
        "format" => "extension",
        "size" => "size",
        "location" => "path COLLATE NOCASE",
        _ => ITEM_ORDER,
    }
}

/// Everything after `FROM`, built once and used for the rows and the counts.
///
/// A title belongs to a machine either because somebody said so or, failing
/// that, because its format says it might — the same rule the interface applies,
/// kept in one place so the count under the table and the rows in it can never
/// disagree.
fn matching_items(query: &ItemQuery) -> (String, Vec<Box<dyn rusqlite::ToSql>>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut bound: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if !query.platform_id.is_empty() {
        clauses.push(
            "(CASE WHEN items.assigned_platform_id IS NOT NULL              AND items.assigned_platform_id <> ''              THEN items.assigned_platform_id = ?              ELSE EXISTS (SELECT 1 FROM item_platforms                           WHERE item_platforms.item_id = items.id                           AND item_platforms.platform_id = ?) END)"
                .into(),
        );
        bound.push(Box::new(query.platform_id.clone()));
        bound.push(Box::new(query.platform_id.clone()));
    }

    if !query.search.trim().is_empty() {
        // ESCAPE, so a title with an underscore or a per-cent in it searches for
        // itself rather than for anything at all.
        clauses.push("items.name LIKE ? ESCAPE '\\'".into());
        let escaped = query
            .search
            .trim()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        bound.push(Box::new(format!("%{escaped}%")));
    }

    if !query.sources.is_empty() {
        let holes = vec!["?"; query.sources.len()].join(",");
        clauses.push(format!("items.source IN ({holes})"));
        for source in &query.sources {
            bound.push(Box::new(source.clone()));
        }
    }

    let where_clause = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    (format!("FROM items{where_clause}"), bound)
}

/// One page of the library, with the counts that describe the whole of it.
///
/// The page exists so that a collection of any size costs the same to show. The
/// filtering, the ordering and the paging are the database's work, where the
/// index is, rather than an array of every title the user owns being sorted in
/// the window on every keystroke.
#[tauri::command]
pub async fn query_items(app: tauri::AppHandle, query: ItemQuery) -> Result<ItemPage> {
    blocking(move || {
        let connection = open(&app)?;
        let (from, bound) = matching_items(&query);
        let params: Vec<&dyn rusqlite::ToSql> = bound.iter().map(|value| &**value).collect();

        let total: i64 = connection.query_row(
            &format!("SELECT count(*) {from}"),
            params.as_slice(),
            |row| row.get(0),
        )?;

        let mut by_source = std::collections::HashMap::new();
        let mut counts = connection.prepare(&format!(
            "SELECT items.source, count(*) {from} GROUP BY items.source"
        ))?;
        let mut rows = counts.query(params.as_slice())?;
        while let Some(row) = rows.next()? {
            by_source.insert(row.get::<_, String>(0)?, row.get::<_, i64>(1)?);
        }

        let rows = if query.limit > 0 {
            let direction = if query.descending { "DESC" } else { "ASC" };
            let order = order_by(&query.sort);
            let sql = format!(
                "{ITEM_COLUMNS} {from} ORDER BY {order} {direction} LIMIT {} OFFSET {}",
                query.limit, query.offset
            );
            connection
                .prepare(&sql)?
                .query_map(params.as_slice(), item_from_row)?
                .collect::<std::result::Result<Vec<_>, _>>()?
        } else {
            Vec::new()
        };

        Ok(ItemPage {
            rows,
            total,
            by_source,
        })
    })
    .await
}

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

#[cfg(test)]
mod tests {
    use super::{
        migrate, prepare, read_workspace, write_transaction, write_workspace, StoredProfile,
        StoredSource, StoredWorkspace, BUSY_TIMEOUT, SCHEMA_VERSION,
    };
    use crate::testing::Scratch;
    use rusqlite::{Connection, Transaction, TransactionBehavior};
    use std::time::Duration;

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
            category_folders: Some(serde_json::json!({ "applications": "Applications" })),
        }
    }

    fn workspace() -> StoredWorkspace {
        let mut policies = std::collections::HashMap::new();
        policies.insert("p1".to_string(), "remove".to_string());
        StoredWorkspace {
            profiles: vec![profile("p1", "BBC GOTEK"), profile("p2", "CPC")],
            active_profile_id: "p2".into(),
            removal_policies: policies,
            sources: vec![StoredSource {
                id: "s1".into(),
                name: "Library".into(),
                path: "/library".into(),
            }],
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
        assert!(loaded.profiles[0].verify_checksums);
        assert_eq!(loaded.profiles[0].destination["path"], "/media/gotek");
        // The drive's panel travels with its profile, upside down and all.
        assert_eq!(
            loaded.profiles[0].display.as_deref(),
            Some("oled-128x64-rotate")
        );
        // So do the folder names the destination already uses: a stick calling
        // its applications folder `Applications` has to keep being written
        // there, or the next run makes a second folder beside it and every
        // title in it reports as filed somewhere unexpected.
        assert_eq!(
            loaded.profiles[0].category_folders,
            Some(serde_json::json!({ "applications": "Applications" }))
        );
    }

    #[test]
    fn profile_order_is_preserved() {
        let mut connection = connection();

        write_workspace(&mut connection, &workspace()).unwrap();
        let loaded = read_workspace(&connection).unwrap();

        assert_eq!(
            loaded.profiles.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["p1", "p2"]
        );
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
    fn saving_replaces_the_profiles_and_sources_completely() {
        let mut connection = connection();
        write_workspace(&mut connection, &workspace()).unwrap();

        let mut smaller = workspace();
        smaller.profiles.truncate(1);
        smaller.sources.clear();
        write_workspace(&mut connection, &smaller).unwrap();

        let loaded = read_workspace(&connection).unwrap();
        assert_eq!(loaded.profiles.len(), 1);
        assert!(loaded.sources.is_empty());
    }

    /// Saving the workspace must not disturb the library, which is written by
    /// its own commands: renaming a profile is not a reason to lose a
    /// collection that took an afternoon to assemble.
    #[test]
    fn saving_the_workspace_leaves_the_library_alone() {
        let mut connection = connection();
        connection
            .execute_batch(
                "INSERT INTO items (id, source, path, name, extension, size, \
                 canonical_title, likely_platform_ids) \
                 VALUES ('i1','/library','/library/Elite.ssd','Elite.ssd','ssd',204800, \
                 'Elite.ssd','[\"bbc\"]'); \
                 INSERT INTO collection_items (profile_id, item_id, position) \
                 VALUES ('p1','i1',0);",
            )
            .unwrap();

        write_workspace(&mut connection, &workspace()).unwrap();

        for table in ["items", "collection_items"] {
            let count: i64 = connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 1, "{table} should be untouched by a workspace save");
        }
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
        // Nor any folder names of its own, so the canonical ones are used.
        assert_eq!(loaded.profiles[0].category_folders, None);
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
        let category: Option<String> = connection
            .query_row("SELECT category FROM items", [], |row| row.get(0))
            .unwrap();
        // The column is there and empty, which is exactly "not categorised yet".
        assert_eq!(category, None);
        // And schema 6's membership table was filled from what was already there.
        let platform: String = connection
            .query_row("SELECT platform_id FROM item_platforms", [], |row| row.get(0))
            .unwrap();
        assert_eq!(platform, "bbc");
    }

    #[test]
    fn an_empty_database_reads_as_an_empty_workspace() {
        let loaded = read_workspace(&connection()).unwrap();

        assert!(loaded.profiles.is_empty());
        assert!(loaded.sources.is_empty());
        assert_eq!(loaded.active_profile_id, "");
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

    /// The workspace is saved while a transfer records fingerprints, so two
    /// connections write at once by design. A whole-workspace save outlasts the
    /// driver's own five-second default, and the writer that waited would then
    /// be told the database is locked although the wait was about to end.
    #[test]
    fn a_writer_waits_far_longer_than_the_drivers_own_default() {
        let waited: i64 = connection()
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .unwrap();

        assert_eq!(waited, BUSY_TIMEOUT.as_millis() as i64);
        assert!(BUSY_TIMEOUT > Duration::from_secs(5));
    }

    /// And the wait has to be one SQLite will actually make. A transaction that
    /// only asks for the write lock when it reaches its first write is refused
    /// the instant the lock is busy, without the handler being consulted, so
    /// the timeout above was reported to the window as a lock failure rather
    /// than being spent. Asking for the lock at `BEGIN` is what puts the
    /// waiting back, and this measures that it happens.
    #[test]
    fn a_writer_meeting_a_busy_database_waits_rather_than_giving_up_at_once() {
        let scratch = Scratch::new("store-lock");
        let path = scratch.join("library.sqlite");

        // Both connections are prepared before anything holds the lock:
        // creating the schema is itself a write, and would otherwise be what
        // waits.
        let holder = Connection::open(&path).unwrap();
        prepare(&holder).unwrap();
        let mut waiting = Connection::open(&path).unwrap();
        prepare(&waiting).unwrap();
        // Short enough to measure, where the real timeout is half a minute.
        waiting.busy_timeout(Duration::from_millis(400)).unwrap();

        // Held for the rest of the test, so the writer below can never win.
        let held = Transaction::new_unchecked(&holder, TransactionBehavior::Immediate).unwrap();
        held.execute("DELETE FROM sources", []).unwrap();

        let started = std::time::Instant::now();
        let refused = write_transaction(&mut waiting).unwrap_err();
        let waited = started.elapsed();

        assert!(
            refused.to_string().to_lowercase().contains("locked"),
            "expected a lock failure, got: {refused}"
        );
        assert!(
            waited >= Duration::from_millis(300),
            "gave up after {waited:?} without waiting for the lock"
        );

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
