//! Scratch space and a loopback web server for tests.
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

/// What the test server sends for one path.
pub struct Reply {
    status: u16,
    body: Vec<u8>,
}

impl Reply {
    pub fn ok(body: impl Into<Vec<u8>>) -> Self {
        Self::status(200, body)
    }

    pub fn status(status: u16, body: impl Into<Vec<u8>>) -> Self {
        Self {
            status,
            body: body.into(),
        }
    }
}

/// A web server on the loopback address that answers each path with its reply,
/// and anything else with 404. Returns the address to put in front of a path.
///
/// Just enough HTTP for the client to read an answer from, so code that talks
/// to a server can be tested without the network. It lives until the test
/// process ends.
pub fn serve(routes: Vec<(&str, Reply)>) -> String {
    use std::io::{Read, Write};

    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("no loopback port");
    let base = format!("http://{}", listener.local_addr().expect("no address"));
    let routes: Vec<(String, Reply)> = routes
        .into_iter()
        .map(|(path, reply)| (path.to_string(), reply))
        .collect();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut head = Vec::new();
            let mut byte = [0u8];
            while !head.ends_with(b"\r\n\r\n") {
                match stream.read(&mut byte) {
                    Ok(1) => head.push(byte[0]),
                    _ => break,
                }
            }
            let request = String::from_utf8_lossy(&head);
            let path = request.split_whitespace().nth(1).unwrap_or("/");
            let (status, body) = routes
                .iter()
                .find(|(route, _)| route == path)
                .map_or((404, &[][..]), |(_, reply)| (reply.status, &reply.body[..]));
            // A client that has stopped reading is a test that has its answer.
            let _ = write!(
                stream,
                "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(body);
        }
    });
    base
}
