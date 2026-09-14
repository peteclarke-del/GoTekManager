//! Keeps blocking filesystem work off the UI thread.
//!
//! Tauri runs a synchronous `#[tauri::command]` on the main thread, so a
//! recursive scan of a large library or a SHA-256 pass over a slow USB stick
//! would freeze the window. Every command that touches the filesystem is
//! therefore declared `async` and immediately hands its work to the blocking
//! pool through this helper.

use crate::error::{Context, Result};
use std::sync::atomic::{AtomicUsize, Ordering};

pub async fn blocking<T, F>(work: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .context("The background task did not complete")?
}

/// How many writes to a destination or a device are under way.
static WRITES: AtomicUsize = AtomicUsize::new(0);

/// Holds a write as under way until it is dropped.
struct Writing;

impl Writing {
    fn start() -> Self {
        WRITES.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for Writing {
    fn drop(&mut self) {
        WRITES.fetch_sub(1, Ordering::SeqCst);
    }
}

/// [`blocking`], for work that writes to a destination or a device.
///
/// The write counts as under way until it has finished, failed or panicked.
/// An update is not installed, and the application does not restart or close
/// for one, while any write is under way: stopping it part way would leave a
/// stick half written.
pub async fn writing<T, F>(work: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    let _held = Writing::start();
    blocking(work).await
}

/// Whether a write to a destination or a device is under way.
pub fn is_writing() -> bool {
    WRITES.load(Ordering::SeqCst) > 0
}

#[cfg(test)]
mod tests {
    use super::{is_writing, writing};

    // The only test that starts a write, so the count it reads is its own.
    #[test]
    fn a_write_is_under_way_until_it_ends_however_it_ends() {
        assert!(!is_writing());
        let seen = tauri::async_runtime::block_on(writing(|| Ok(is_writing()))).unwrap();
        assert!(seen);
        assert!(!is_writing());

        let failed = tauri::async_runtime::block_on(writing(|| -> crate::error::Result<()> {
            assert!(is_writing());
            Err("the stick was pulled out".into())
        }));
        assert!(failed.is_err());
        assert!(!is_writing());
    }
}
