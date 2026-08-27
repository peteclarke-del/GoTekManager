//! Keeps blocking filesystem work off the UI thread.
//!
//! Tauri runs a synchronous `#[tauri::command]` on the main thread, so a
//! recursive scan of a large library or a SHA-256 pass over a slow USB stick
//! would freeze the window. Every command that touches the filesystem is
//! therefore declared `async` and immediately hands its work to the blocking
//! pool through this helper.

use crate::error::{Context, Result};

pub async fn blocking<T, F>(work: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .context("The background task did not complete")?
}
