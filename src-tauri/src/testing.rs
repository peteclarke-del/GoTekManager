//! Scratch space for tests.
//!
//! Ten test modules had grown their own copy of the same thing: build a
//! uniquely named folder under the system temporary directory, create it, and
//! hand back the path. Most of them then left it behind. A few tidied up on
//! their last line, which is the one line a failing test never reaches, so a
//! single assertion failure leaked a folder as well.
//!
//! One implementation does both jobs, and does the tidying in `Drop` so it
//! happens whether the test passes, fails, or panics part way through.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// Distinguishes folders made in the same process, where the clock cannot.
static MADE: AtomicUsize = AtomicUsize::new(0);

/// A temporary folder that removes itself when it goes out of scope.
///
/// Dereferences to its own path, so it can be joined onto and passed anywhere
/// a `&Path` is wanted, and the guard is simply held in a local for as long as
/// the test needs the folder.
pub struct Scratch {
    path: PathBuf,
}

impl Scratch {
    /// A new empty folder, named after the test so a leftover is traceable.
    pub fn new(name: &str) -> Self {
        // The process id separates concurrent runs, and the counter separates
        // folders within one run: tests share a process and run in parallel, so
        // the clock alone can hand the same name to two of them.
        let path = std::env::temp_dir().join(format!(
            "gotek-{name}-{}-{}",
            std::process::id(),
            MADE.fetch_add(1, Ordering::Relaxed)
        ));
        // A leftover from a previous run under the same name would otherwise be
        // read as this run's own work.
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("unable to create a scratch folder");
        Self { path }
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        // Nothing depends on this having worked, and a test that has already
        // failed should report its own failure rather than a tidying error.
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

impl std::ops::Deref for Scratch {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.path
    }
}

impl AsRef<Path> for Scratch {
    fn as_ref(&self) -> &Path {
        &self.path
    }
}
