//! Checking for, downloading and installing a newer release of this application.
//!
//! Nothing here runs until someone presses Check for Application Updates in the
//! About box: a tool that writes to removable media should not be reaching out
//! to the internet unless someone has asked it a question.
//!
//! The check reads the one release GitHub marks as the latest, which is never a
//! draft or a prerelease, and compares its `vX.Y.Z` tag with the version of the
//! crate. A check that cannot reach GitHub or read its answer is an error with
//! the reason, and is never reported as "this is the latest".
//!
//! A release carries one file for every way the application is installed, and a
//! `SHA256SUMS` file for all of them. Which file an update takes is decided by
//! how the running copy was installed, never by guessing from the system it is
//! running on. The bundler writes the kind of package into the executable when
//! it builds each one ([`bundle_type`]), and that is checked against where the
//! executable actually is, so a copy that merely came out of a build folder is
//! not mistaken for an installed one. Anything that cannot be identified for
//! certain is sent to the release page instead of being offered an install.
//!
//! The chosen file is downloaded into the cache, checked against `SHA256SUMS`
//! before anything else is done with it, and then put in place the way that kind
//! of installation is normally updated:
//!
//! - a Debian package with `pkexec apt-get install`, and an RPM package with
//!   `pkexec dnf install`, both of which ask for the user's password;
//! - an AppImage by replacing the file the application was started from;
//! - a Windows installer by starting it and closing, so it can replace us;
//! - a macOS disk image by opening it for the user to drag the new copy in,
//!   since replacing a signed application bundle in place is not reliable.
//!
//! The window never names a file or a URL for any of this. It asks the backend
//! to check, then to download what the check found, then to install what was
//! downloaded, and the backend holds each answer between the steps.

use crate::error::{Context, Error, Result};
use crate::online::http::client;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::utils::config::BundleType;
use tauri::utils::platform::bundle_type;
use tauri::Emitter;

/// The repository releases are published from.
///
/// `tauri.conf.json` names the same repository as the homepage; a test holds
/// the two together.
pub const REPOSITORY: &str = "peteclarke-del/GoTekManager";

/// The checksum file every release carries for its installers.
pub const SUMS_NAME: &str = "SHA256SUMS";

/// The event that reports how much of an update has been downloaded.
const PROGRESS_EVENT: &str = "app-update-progress";

/// Notes longer than this are cut, with the release page carrying the rest.
const MAX_NOTES: usize = 2000;

/// `SHA256SUMS` is a line per installer; anything this large is not one.
const MAX_SUMS: usize = 64 * 1024;

/// How long the check waits for GitHub before saying it could not be reached.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// Said instead of installing while media is being written.
pub const BUSY_WHILE_WRITING: &str =
    "GoTek Manager can be updated once the write in progress has finished.";

// pkexec's exit statuses when the password prompt is dismissed, and when the
// system refuses or there is nobody to ask.
const PKEXEC_DISMISSED: i32 = 126;
const PKEXEC_REFUSED: i32 = 127;

fn latest_url() -> String {
    format!("https://api.github.com/repos/{REPOSITORY}/releases/latest")
}

/// Every installer this project publishes is downloaded from under here.
fn download_prefix() -> String {
    format!("https://github.com/{REPOSITORY}/releases/download/")
}

// ---------------------------------------------------------------------------
// How the running copy was installed
// ---------------------------------------------------------------------------

/// How the running copy was installed, which decides what an update downloads
/// and how it is put in place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Installation {
    Deb,
    Rpm,
    /// The AppImage file the application was started from.
    AppImage(PathBuf),
    Nsis,
    Msi,
    MacApp,
    /// Not an installation this application can update; the reason says why.
    Unmanaged(&'static str),
}

const FROM_A_BUILD: &str = "This copy was not installed from one of the release's packages, \
     so it cannot update itself.";

/// What the running process knows about where it came from.
struct Running<'a> {
    os: &'a str,
    bundle: Option<BundleType>,
    exe: Option<&'a Path>,
    appimage: Option<&'a OsStr>,
    appdir: Option<&'a OsStr>,
}

/// How the running copy was installed, from what the process can see of itself.
///
/// The bundler's own record comes first, and each kind is then held to where
/// that kind of package puts the executable. The record alone is not enough:
/// an executable taken out of a package and run from somewhere else still
/// carries it.
fn installation(running: &Running) -> Installation {
    let exe = running.exe;
    match running.os {
        "linux" => match running.bundle {
            Some(BundleType::AppImage) => {
                let (Some(image), Some(appdir)) = (running.appimage, running.appdir) else {
                    return Installation::Unmanaged(
                        "This copy is an AppImage that was not started from its file, \
                         so it cannot replace that file.",
                    );
                };
                let image = Path::new(image);
                let mounted = exe.is_some_and(|exe| exe.starts_with(appdir));
                if image.is_absolute() && mounted {
                    Installation::AppImage(image.to_path_buf())
                } else {
                    Installation::Unmanaged(
                        "This copy is an AppImage that was not started from its file, \
                         so it cannot replace that file.",
                    )
                }
            }
            Some(ref bundle @ (BundleType::Deb | BundleType::Rpm)) => {
                let packaged = exe
                    .and_then(Path::parent)
                    .is_some_and(|folder| folder == Path::new("/usr/bin"));
                match (packaged, bundle) {
                    (true, BundleType::Deb) => Installation::Deb,
                    (true, _) => Installation::Rpm,
                    _ => Installation::Unmanaged(FROM_A_BUILD),
                }
            }
            _ => Installation::Unmanaged(FROM_A_BUILD),
        },
        "windows" => match running.bundle {
            Some(BundleType::Nsis) => Installation::Nsis,
            Some(BundleType::Msi) => Installation::Msi,
            _ => Installation::Unmanaged(FROM_A_BUILD),
        },
        "macos" => {
            // Only an application bundle has anything to replace:
            // `Name.app/Contents/MacOS/executable`.
            let bundled = exe
                .and_then(Path::parent)
                .filter(|folder| folder.file_name() == Some(OsStr::new("MacOS")))
                .and_then(Path::parent)
                .filter(|folder| folder.file_name() == Some(OsStr::new("Contents")))
                .and_then(Path::parent)
                .is_some_and(|app| app.extension() == Some(OsStr::new("app")));
            if bundled {
                Installation::MacApp
            } else {
                Installation::Unmanaged(FROM_A_BUILD)
            }
        }
        _ => Installation::Unmanaged(FROM_A_BUILD),
    }
}

/// How this process was installed.
fn this_installation() -> Installation {
    let exe = tauri::utils::platform::current_exe().ok();
    let appimage = std::env::var_os("APPIMAGE");
    let appdir = std::env::var_os("APPDIR");
    installation(&Running {
        os: std::env::consts::OS,
        bundle: bundle_type(),
        exe: exe.as_deref(),
        appimage: appimage.as_deref(),
        appdir: appdir.as_deref(),
    })
}

/// The name GitHub gives an uploaded file: it turns spaces into dots.
///
/// The release workflow renames the installers the same way before it writes
/// `SHA256SUMS`, so the checksum file names exactly what GitHub serves.
fn release_stem(product: &str) -> String {
    product.replace(' ', ".")
}

/// The release file built for this installation and processor, as the bundler
/// names it, or `None` when the release has nothing that could replace it.
fn asset_name(
    installation: &Installation,
    product: &str,
    version: &str,
    arch: &str,
) -> Option<String> {
    let stem = release_stem(product);
    // Each format spells the two processors its own way.
    let spelt = |x86_64: &'static str, aarch64: &'static str| match arch {
        "x86_64" => Some(x86_64),
        "aarch64" => Some(aarch64),
        _ => None,
    };
    Some(match installation {
        Installation::Deb => format!("{stem}_{version}_{}.deb", spelt("amd64", "arm64")?),
        Installation::Rpm => format!("{stem}-{version}-1.{}.rpm", spelt("x86_64", "aarch64")?),
        Installation::AppImage(_) => {
            format!("{stem}_{version}_{}.AppImage", spelt("amd64", "aarch64")?)
        }
        Installation::Nsis => format!("{stem}_{version}_{}-setup.exe", spelt("x64", "arm64")?),
        Installation::Msi => format!("{stem}_{version}_{}_en-US.msi", spelt("x64", "arm64")?),
        Installation::MacApp => format!("{stem}_{version}_{}.dmg", spelt("x64", "aarch64")?),
        Installation::Unmanaged(_) => return None,
    })
}

// ---------------------------------------------------------------------------
// Versions and releases
// ---------------------------------------------------------------------------

/// `(0, 2, 0)` for `v0.2.0` or `0.2.0`, and `None` for anything else.
///
/// Strict on purpose: a tag with a suffix, such as `v0.2.0-rc1`, is not a
/// release this application offers.
fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let text = text.strip_prefix('v').unwrap_or(text);
    let number = |part: &str| {
        let digits = !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
        digits.then(|| part.parse().ok()).flatten()
    };
    let mut parts = text.split('.');
    let version = (
        number(parts.next()?)?,
        number(parts.next()?)?,
        number(parts.next()?)?,
    );
    parts.next().is_none().then_some(version)
}

/// Whether the release tagged `tag` is later than `current`, by number.
fn is_newer(tag: &str, current: &str) -> bool {
    match (parse_version(tag), parse_version(current)) {
        (Some(theirs), Some(ours)) => theirs > ours,
        (Some(_), None) => true,
        (None, _) => false,
    }
}

/// A release as GitHub returns it.
#[derive(Debug, Deserialize)]
struct ApiRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<ApiAsset>,
}

#[derive(Debug, Deserialize)]
struct ApiAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: Option<u64>,
}

/// How an update is put in place, for the window to describe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Method {
    Apt,
    Dnf,
    AppImage,
    Installer,
    DiskImage,
}

/// A newer release, as the window shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub version: String,
    pub name: String,
    pub notes: String,
    pub page_url: String,
    /// The file an update downloads, when this copy can update itself.
    pub asset: Option<String>,
    pub size: Option<u64>,
    pub method: Option<Method>,
    /// The AppImage an update replaces.
    pub replaces: Option<String>,
    /// Why this copy cannot update itself, when it cannot.
    pub blocked: Option<String>,
}

/// What a check found.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checked {
    pub current: String,
    /// `None` when the running version is the latest.
    pub update: Option<Update>,
}

/// What an install needs, kept by the backend between the steps.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Pending {
    installation: Installation,
    asset: String,
    url: String,
    size: Option<u64>,
    sums_url: String,
}

/// Where the rest of the release information comes from, for testing.
struct Host<'a> {
    product: &'a str,
    current: &'a str,
    arch: &'a str,
    /// Whether a program is on the path.
    has: &'a dyn Fn(&str) -> bool,
}

/// The newer release in `release`, with what an install of it needs, or `None`
/// when the running version is the latest.
fn offer(
    release: ApiRelease,
    installation: &Installation,
    host: &Host,
) -> Result<Option<(Update, Option<Pending>)>> {
    let Some(version) = parse_version(&release.tag_name) else {
        return Err(Error::new(format!(
            "The latest release on GitHub, {}, is not an application release.",
            if release.tag_name.is_empty() {
                "without a tag"
            } else {
                &release.tag_name
            }
        )));
    };
    if release.draft || release.prerelease || !is_newer(&release.tag_name, host.current) {
        return Ok(None);
    }
    let version = format!("{}.{}.{}", version.0, version.1, version.2);
    let mut update = Update {
        // A release's title is free text, so the window names the release by
        // the application and the version instead.
        name: format!("{} {version}", host.product),
        notes: shorten(release.body.unwrap_or_default()),
        page_url: release.html_url,
        version,
        asset: None,
        size: None,
        method: None,
        replaces: None,
        blocked: None,
    };
    match installable(&release.assets, installation, host, &update) {
        Ok((method, pending)) => {
            update.method = Some(method);
            update.asset = Some(pending.asset.clone());
            update.size = pending.size;
            if let Installation::AppImage(path) = installation {
                update.replaces = Some(path.display().to_string());
            }
            Ok(Some((update, Some(pending))))
        }
        Err(reason) => {
            update.blocked = Some(reason);
            Ok(Some((update, None)))
        }
    }
}

/// How `update` would be installed here and what that needs, or why this copy
/// cannot install it and should be sent to the release page.
fn installable(
    assets: &[ApiAsset],
    installation: &Installation,
    host: &Host,
    update: &Update,
) -> std::result::Result<(Method, Pending), String> {
    let method = match installation {
        Installation::Unmanaged(reason) => return Err(reason.to_string()),
        Installation::Deb if !(host.has)("apt-get") => {
            return Err(
                "This copy was installed from the Debian package, and apt-get is not \
                        available to install the new one."
                    .into(),
            )
        }
        Installation::Rpm if !(host.has)("dnf") => {
            return Err(
                "This copy was installed from the RPM package, and dnf is not \
                        available to install the new one."
                    .into(),
            )
        }
        Installation::Deb => Method::Apt,
        Installation::Rpm => Method::Dnf,
        Installation::AppImage(_) => Method::AppImage,
        Installation::Nsis | Installation::Msi => Method::Installer,
        Installation::MacApp => Method::DiskImage,
    };
    let find = |name: &str| assets.iter().find(|asset| asset.name == name);
    let no_file = || {
        format!(
            "{} has no file for this system; the release page lists the files it has.",
            update.name
        )
    };
    let name =
        asset_name(installation, host.product, &update.version, host.arch).ok_or_else(no_file)?;
    let asset = find(&name).ok_or_else(no_file)?;
    let sums = find(SUMS_NAME).ok_or_else(|| {
        format!(
            "{} has no {SUMS_NAME} file to check a download against.",
            update.name
        )
    })?;
    // The reply names the downloads. Nothing outside this project's own
    // releases is fetched, whatever it says.
    let prefix = download_prefix();
    if !asset.browser_download_url.starts_with(&prefix)
        || !sums.browser_download_url.starts_with(&prefix)
    {
        return Err(format!(
            "GitHub named a download for {} outside this project's releases, so it is not \
             used.",
            update.name
        ));
    }
    Ok((
        method,
        Pending {
            installation: installation.clone(),
            asset: name,
            url: asset.browser_download_url.clone(),
            size: asset.size,
            sums_url: sums.browser_download_url.clone(),
        },
    ))
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

/// The SHA-256 `SHA256SUMS` gives for `name`, or `None`.
fn published_sum(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (digest, file) = line.trim().split_once(char::is_whitespace)?;
        let file = file.trim_start();
        // `sha256sum` marks a file it read in binary mode with a star.
        let file = file.strip_prefix('*').unwrap_or(file);
        let valid = digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit());
        (valid && file == name).then(|| digest.to_ascii_lowercase())
    })
}

// ---------------------------------------------------------------------------
// Talking to GitHub
// ---------------------------------------------------------------------------

/// A network failure as a sentence, with every cause it carries.
///
/// The address is left out: the sentence already says which file it was.
fn reason(error: reqwest::Error) -> String {
    let error = error.without_url();
    let mut text = error.to_string();
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

/// The release GitHub marks as the latest, or `None` when none is published.
async fn latest_release(client: &reqwest::Client, url: &str) -> Result<Option<ApiRelease>> {
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .timeout(CHECK_TIMEOUT)
        .send()
        .await
        .map_err(|error| Error::new(format!("GitHub could not be reached: {}.", reason(error))))?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| Error::new(format!("GitHub's reply was cut short: {}.", reason(error))))?;
    if !status.is_success() {
        // GitHub says why in a `message`, most often that the hourly limit
        // for requests without an account has been reached.
        let message = serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .and_then(|reply| reply.get("message")?.as_str().map(str::to_string));
        return Err(Error::new(match message {
            Some(message) => format!("GitHub refused the request (HTTP {status}): {message}"),
            None => format!("GitHub sent an unexpected reply (HTTP {status})."),
        }));
    }
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|_| Error::new("GitHub's reply could not be read as a release."))
}

/// What a download ended with, when it did not fail.
#[derive(Debug, PartialEq, Eq)]
enum Fetched {
    Done(PathBuf),
    Cancelled,
}

#[derive(Clone, Copy, Serialize)]
struct Progress {
    done: u64,
    total: Option<u64>,
}

/// Downloads `pending`'s file into `folder` and checks it against the
/// release's `SHA256SUMS`, deleting it if it does not match.
async fn fetch_verified(
    client: &reqwest::Client,
    pending: &Pending,
    folder: &Path,
    cancelled: &AtomicBool,
    mut progress: impl FnMut(Progress),
) -> Result<Fetched> {
    let sums = client
        .get(&pending.sums_url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| {
            Error::new(format!(
                "{SUMS_NAME} could not be downloaded: {}.",
                reason(error)
            ))
        })?
        .bytes()
        .await
        .map_err(|error| {
            Error::new(format!(
                "{SUMS_NAME} could not be downloaded: {}.",
                reason(error)
            ))
        })?;
    if sums.len() > MAX_SUMS {
        return Err(Error::new(format!(
            "{SUMS_NAME} is too large to be a checksum file."
        )));
    }
    let expected = published_sum(&String::from_utf8_lossy(&sums), &pending.asset)
        .with_context(|| format!("{SUMS_NAME} has no line for {}", pending.asset))?;

    let response = client
        .get(&pending.url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| {
            Error::new(format!(
                "{} could not be downloaded: {}.",
                pending.asset,
                reason(error)
            ))
        })?;
    let total = pending.size.or(response.content_length());
    fs::create_dir_all(folder)?;
    let destination = folder.join(&pending.asset);
    let partial = folder.join(format!("{}.part", pending.asset));

    let outcome = async {
        let mut output = fs::File::create(&partial)?;
        let mut digest = Sha256::new();
        let mut stream = response.bytes_stream();
        let mut done = 0u64;
        let mut reported = 0u64;
        progress(Progress { done, total });
        while let Some(chunk) = stream.next().await {
            if cancelled.load(Ordering::Relaxed) {
                return Ok(false);
            }
            let chunk = chunk
                .map_err(|error| Error::new(format!("The download stopped: {}.", reason(error))))?;
            done += chunk.len() as u64;
            if total.is_some_and(|total| done > total) {
                return Err(Error::new(format!(
                    "{} is larger than GitHub said it would be, so it was not used.",
                    pending.asset
                )));
            }
            digest.update(&chunk);
            output.write_all(&chunk)?;
            // Often enough for the bar to move, not once for every packet.
            if done - reported >= 256 * 1024 {
                reported = done;
                progress(Progress { done, total });
            }
        }
        output.sync_all()?;
        progress(Progress { done, total });
        if total.is_some_and(|total| done != total) {
            return Err(Error::new(format!(
                "{} arrived incomplete, so it was not used. Try again.",
                pending.asset
            )));
        }
        let actual = format!("{:x}", digest.finalize());
        if actual != expected {
            return Err(Error::new(format!(
                "{} does not match its published checksum, so it was not used. Try again.",
                pending.asset
            )));
        }
        Ok(true)
    }
    .await;

    match outcome {
        Ok(true) => {
            fs::rename(&partial, &destination)?;
            Ok(Fetched::Done(destination))
        }
        Ok(false) => {
            let _ = fs::remove_file(&partial);
            Ok(Fetched::Cancelled)
        }
        Err(error) => {
            let _ = fs::remove_file(&partial);
            Err(error)
        }
    }
}

// ---------------------------------------------------------------------------
// Putting an update in place
// ---------------------------------------------------------------------------

/// How an install ended, when it did not fail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum Outcome {
    /// Installed; the new version runs once the application restarts.
    Restart,
    /// The disk image is open for the new copy to be dragged into place.
    Opened,
    /// The installer is running, and the application closes so it can replace it.
    Handover,
    /// Nothing was done, and the update is still on offer.
    Held { message: String },
}

/// The effects an install has on the system, so tests can stand in for them.
trait System {
    /// The full path of a program on the path.
    fn find(&self, program: &str) -> Option<PathBuf>;
    /// Runs a command to completion.
    fn run(&self, command: &[OsString]) -> std::io::Result<Output>;
    /// Opens a file the way the desktop would.
    fn open(&self, path: &Path) -> Result<()>;
}

struct Desktop;

impl System for Desktop {
    fn find(&self, program: &str) -> Option<PathBuf> {
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path)
            .map(|folder| folder.join(program))
            .find(|candidate| candidate.is_file())
    }

    fn run(&self, command: &[OsString]) -> std::io::Result<Output> {
        let (program, arguments) = command
            .split_first()
            .ok_or_else(|| std::io::Error::other("no command"))?;
        std::process::Command::new(program).args(arguments).output()
    }

    fn open(&self, path: &Path) -> Result<()> {
        tauri_plugin_opener::open_path(path, None::<&str>)
            .map_err(|error| Error::new(format!("{} could not be opened: {error}", path.display())))
    }
}

/// Quotes a path for a POSIX shell, for a command the user can copy.
fn quoted(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', r"'\''"))
}

/// The command a user can run in a terminal instead.
fn manual_command(installation: &Installation, package: &Path) -> String {
    let tool = if *installation == Installation::Rpm {
        "dnf"
    } else {
        "apt"
    };
    format!("sudo {tool} install {}", quoted(package))
}

/// Puts the downloaded `package` in place for `installation`.
///
/// Refuses while media is being written: an installer that closes the
/// application, or a restart, would stop that write part way.
///
/// There is no time limit on a package install. pkexec waits for as long as
/// the password prompt is open, and once it is answered the package manager
/// runs as root, where this process cannot stop it: giving up would report a
/// failure while the install went on.
fn put_in_place(
    installation: &Installation,
    package: &Path,
    writing: bool,
    system: &dyn System,
) -> Result<Outcome> {
    if writing {
        return Ok(Outcome::Held {
            message: BUSY_WHILE_WRITING.into(),
        });
    }
    match installation {
        Installation::Deb | Installation::Rpm => {
            let by_hand = format!(
                "Install it in a terminal with: {}",
                manual_command(installation, package)
            );
            let (tool, yes) = if *installation == Installation::Deb {
                ("apt-get", "--yes")
            } else {
                ("dnf", "--assumeyes")
            };
            let (Some(pkexec), Some(tool)) = (system.find("pkexec"), system.find(tool)) else {
                return Err(Error::new(format!(
                    "pkexec is not installed, so the package cannot be installed from here. \
                     {by_hand}"
                )));
            };
            let command = [
                pkexec.into_os_string(),
                tool.into_os_string(),
                "install".into(),
                yes.into(),
                package.as_os_str().to_owned(),
            ];
            let result = system.run(&command).map_err(|error| {
                Error::new(format!(
                    "The package could not be installed: {error}. {by_hand}"
                ))
            })?;
            match result.status.code() {
                Some(0) => {
                    let _ = fs::remove_file(package);
                    Ok(Outcome::Restart)
                }
                Some(PKEXEC_DISMISSED) => Ok(Outcome::Held {
                    message: "The password prompt was dismissed, so nothing was installed.".into(),
                }),
                Some(PKEXEC_REFUSED) => Err(Error::new(format!(
                    "The system did not allow the installation. {by_hand}"
                ))),
                code => {
                    let output = if result.stderr.is_empty() {
                        &result.stdout
                    } else {
                        &result.stderr
                    };
                    let text = String::from_utf8_lossy(output);
                    let last = text.lines().rev().find(|line| !line.trim().is_empty());
                    let why = match (last, code) {
                        // The sentence supplies its own full stop.
                        (Some(line), _) => line.trim().trim_end_matches('.').to_string(),
                        (None, Some(code)) => format!("it stopped with status {code}"),
                        (None, None) => "it was stopped".to_string(),
                    };
                    Err(Error::new(format!(
                        "The package could not be installed: {why}. {by_hand}"
                    )))
                }
            }
        }
        Installation::AppImage(target) => {
            replace_file(package, target)?;
            let _ = fs::remove_file(package);
            Ok(Outcome::Restart)
        }
        Installation::Nsis | Installation::Msi => {
            system.open(package)?;
            Ok(Outcome::Handover)
        }
        Installation::MacApp => {
            system.open(package)?;
            Ok(Outcome::Opened)
        }
        Installation::Unmanaged(reason) => Err(Error::new(*reason)),
    }
}

/// Replaces `target` with a copy of `new` in one step, keeping its permissions.
///
/// The copy is made beside the target and renamed over it, so the target is
/// always either the old file or the whole new one. The running application
/// keeps the old file open until it exits, which is what lets it be replaced
/// while it runs.
fn replace_file(new: &Path, target: &Path) -> Result<()> {
    // APPIMAGE can name a link; the file it leads to is the one to replace.
    let target = fs::canonicalize(target)
        .with_context(|| format!("The AppImage {} could not be found", target.display()))?;
    let permissions = fs::metadata(&target)?.permissions();
    let folder = target
        .parent()
        .context("The AppImage has no folder to be replaced in")?;
    let name = target
        .file_name()
        .context("The AppImage has no file name")?
        .to_string_lossy();
    let staged = folder.join(format!(".{name}.update"));
    let outcome = (|| -> std::io::Result<()> {
        fs::copy(new, &staged)?;
        fs::set_permissions(&staged, permissions)?;
        fs::File::open(&staged)?.sync_all()?;
        fs::rename(&staged, &target)
    })();
    if let Err(error) = outcome {
        let _ = fs::remove_file(&staged);
        return Err(Error::new(format!(
            "The AppImage in {} could not be replaced: {error}. Download the new AppImage \
             from the release page instead.",
            folder.display()
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// What the backend holds between the check, the download and the install.
#[derive(Default)]
pub struct Updates {
    pending: Mutex<Option<Pending>>,
    downloaded: Mutex<Option<(Installation, PathBuf)>>,
    downloading: AtomicBool,
    cancelled: AtomicBool,
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The running application, as the About box shows it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct About {
    pub name: String,
    pub version: String,
    pub homepage: String,
}

/// The name, version and project page of the application that is running.
///
/// The version is taken from the crate rather than from anything the interface
/// holds, so what the About box reports and what was installed cannot
/// disagree; the packaging keeps this and `tauri.conf.json` in step. The
/// project page is the repository's: the bundle's homepage setting is not
/// available to the running application.
#[tauri::command]
pub fn app_about(app: tauri::AppHandle) -> About {
    About {
        name: app.package_info().name.clone(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        homepage: format!("https://github.com/{REPOSITORY}"),
    }
}

/// Asks GitHub whether a newer release has been published.
#[tauri::command]
pub async fn check_for_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, Updates>,
) -> Result<Checked> {
    let current = env!("CARGO_PKG_VERSION");
    let client = client(None)?;
    let release = latest_release(&client, &latest_url())
        .await?
        .context("No release of GoTek Manager has been published on GitHub yet.")?;
    let installation = this_installation();
    let product = app.package_info().name.clone();
    let has = |program: &str| Desktop.find(program).is_some();
    let host = Host {
        product: &product,
        current,
        arch: std::env::consts::ARCH,
        has: &has,
    };
    let (update, pending) = match offer(release, &installation, &host)? {
        Some((update, pending)) => (Some(update), pending),
        None => (None, None),
    };
    *locked(&state.pending) = pending;
    *locked(&state.downloaded) = None;
    Ok(Checked {
        current: current.to_string(),
        update,
    })
}

/// What a download ended with, for the window.
#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum Downloaded {
    Ready,
    Held { message: String },
}

/// Downloads the update the last check found and checks it against the
/// release's `SHA256SUMS`.
#[tauri::command]
pub async fn download_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, Updates>,
) -> Result<Downloaded> {
    let folder = crate::cache::updates_folder(&app)?;
    let client = client(None)?;
    download(
        &state,
        crate::task::is_writing(),
        &client,
        &folder,
        |progress| {
            let _ = app.emit(PROGRESS_EVENT, progress);
        },
    )
    .await
}

/// The download step, with what the command takes from the application
/// passed in.
///
/// Refuses while media is being written, as installing does: the download is
/// the start of an install, and should not begin when the install could not
/// follow it.
async fn download(
    state: &Updates,
    writing: bool,
    client: &reqwest::Client,
    folder: &Path,
    progress: impl FnMut(Progress),
) -> Result<Downloaded> {
    if writing {
        return Ok(Downloaded::Held {
            message: BUSY_WHILE_WRITING.into(),
        });
    }
    let pending = locked(&state.pending)
        .clone()
        .context("Check for Application Updates again before updating.")?;
    if state.downloading.swap(true, Ordering::SeqCst) {
        return Err(Error::new("The update is already being downloaded."));
    }
    state.cancelled.store(false, Ordering::SeqCst);
    // An installer from an earlier update has done its job by now.
    if let Ok(entries) = fs::read_dir(folder) {
        for entry in entries.flatten() {
            let _ = fs::remove_file(entry.path());
        }
    }
    let outcome = fetch_verified(client, &pending, folder, &state.cancelled, progress).await;
    state.downloading.store(false, Ordering::SeqCst);
    match outcome? {
        Fetched::Done(path) => {
            *locked(&state.downloaded) = Some((pending.installation, path));
            Ok(Downloaded::Ready)
        }
        Fetched::Cancelled => Ok(Downloaded::Held {
            message: "The update was cancelled.".into(),
        }),
    }
}

/// Stops a download in progress.
#[tauri::command]
pub fn cancel_update(state: tauri::State<'_, Updates>) {
    state.cancelled.store(true, Ordering::SeqCst);
}

/// Installs the update that was downloaded.
#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, Updates>,
) -> Result<Outcome> {
    let (installation, package) = locked(&state.downloaded)
        .clone()
        .context("Download the update again before installing it.")?;
    let outcome = crate::task::blocking(move || {
        put_in_place(&installation, &package, crate::task::is_writing(), &Desktop)
    })
    .await?;
    if outcome == Outcome::Handover {
        // The installer cannot replace files the application is still using.
        app.exit(0);
    }
    Ok(outcome)
}

/// Whether the application may stop now, to restart or to be replaced.
///
/// Not while media is being written: stopping would leave it half written.
fn may_stop(writing: bool, what: &str) -> Result<()> {
    if writing {
        return Err(Error::new(format!(
            "GoTek Manager can {what} once the write in progress has finished."
        )));
    }
    Ok(())
}

/// Starts the application again, so that an installed update runs.
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) -> Result<()> {
    may_stop(crate::task::is_writing(), "restart")?;
    app.request_restart();
    Ok(())
}

/// Closes the application, so that an update can replace it.
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) -> Result<()> {
    may_stop(crate::task::is_writing(), "close")?;
    app.exit(0);
    Ok(())
}

// The suite runs on Linux, and stands in for the system with Unix exit
// statuses and permissions.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::testing::{serve, Reply, Scratch};
    use std::cell::RefCell;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::ExitStatusExt;

    /// The names of every file the v0.6.1 release carries, as GitHub lists them.
    const V061_ASSETS: [&str; 10] = [
        "GoTek.Manager-0.6.1-1.x86_64.rpm",
        "GoTek.Manager_0.6.1_aarch64.dmg",
        "GoTek.Manager_0.6.1_amd64.AppImage",
        "GoTek.Manager_0.6.1_amd64.deb",
        "GoTek.Manager_0.6.1_arm64-setup.exe",
        "GoTek.Manager_0.6.1_arm64.deb",
        "GoTek.Manager_0.6.1_arm64_en-US.msi",
        "GoTek.Manager_0.6.1_x64-setup.exe",
        "GoTek.Manager_0.6.1_x64.dmg",
        "GoTek.Manager_0.6.1_x64_en-US.msi",
    ];

    fn config() -> serde_json::Value {
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap()
    }

    fn product() -> String {
        config()["productName"].as_str().unwrap().to_string()
    }

    fn appimage_run() -> Running<'static> {
        Running {
            os: "linux",
            bundle: Some(BundleType::AppImage),
            exe: Some(Path::new("/tmp/.mount_GoTekab12/usr/bin/gotek-manager")),
            appimage: Some(OsStr::new(
                "/home/pete/Apps/GoTek.Manager_0.6.1_amd64.AppImage",
            )),
            appdir: Some(OsStr::new("/tmp/.mount_GoTekab12")),
        }
    }

    fn linux(bundle: Option<BundleType>, exe: &'static str) -> Running<'static> {
        Running {
            os: "linux",
            bundle,
            exe: Some(Path::new(exe)),
            appimage: None,
            appdir: None,
        }
    }

    #[test]
    fn the_repository_is_the_one_the_configuration_names() {
        assert_eq!(
            config()["bundle"]["homepage"].as_str(),
            Some(format!("https://github.com/{REPOSITORY}").as_str())
        );
    }

    #[test]
    fn a_package_is_recognised_only_where_that_package_puts_the_executable() {
        assert_eq!(
            installation(&linux(Some(BundleType::Deb), "/usr/bin/gotek-manager")),
            Installation::Deb
        );
        assert_eq!(
            installation(&linux(Some(BundleType::Rpm), "/usr/bin/gotek-manager")),
            Installation::Rpm
        );
        // An executable taken out of a package and run from elsewhere still
        // carries the record, and is not an installed package.
        for bundle in [BundleType::Deb, BundleType::Rpm] {
            assert!(matches!(
                installation(&linux(
                    Some(bundle),
                    "/home/pete/GoTekManager/src-tauri/target/release/gotek-manager"
                )),
                Installation::Unmanaged(_)
            ));
        }
        // Run from the source tree, nothing is recorded at all.
        assert!(matches!(
            installation(&linux(None, "/usr/bin/gotek-manager")),
            Installation::Unmanaged(_)
        ));
    }

    #[test]
    fn an_appimage_is_recognised_only_when_started_from_its_file() {
        assert_eq!(
            installation(&appimage_run()),
            Installation::AppImage(PathBuf::from(
                "/home/pete/Apps/GoTek.Manager_0.6.1_amd64.AppImage"
            ))
        );
        let without = |change: fn(&mut Running<'static>)| {
            let mut running = appimage_run();
            change(&mut running);
            installation(&running)
        };
        // No APPIMAGE, no APPDIR, a relative file, or an executable that is not
        // inside the mounted image: any of those and the file is not ours to
        // replace.
        assert!(matches!(
            without(|running| running.appimage = None),
            Installation::Unmanaged(_)
        ));
        assert!(matches!(
            without(|running| running.appdir = None),
            Installation::Unmanaged(_)
        ));
        assert!(matches!(
            without(|running| running.appimage = Some(OsStr::new("GoTek.AppImage"))),
            Installation::Unmanaged(_)
        ));
        assert!(matches!(
            without(|running| running.exe = Some(Path::new("/usr/bin/gotek-manager"))),
            Installation::Unmanaged(_)
        ));
        // The environment alone is not enough: a deb started from a shell that
        // happens to carry APPIMAGE is still the deb.
        let mut deb = appimage_run();
        deb.bundle = Some(BundleType::Deb);
        deb.exe = Some(Path::new("/usr/bin/gotek-manager"));
        assert_eq!(installation(&deb), Installation::Deb);
    }

    #[test]
    fn windows_and_macos_are_recognised_from_their_installers() {
        let run = |os, bundle, exe| {
            installation(&Running {
                os,
                bundle,
                exe: Some(Path::new(exe)),
                appimage: None,
                appdir: None,
            })
        };
        let exe = r"C:\Users\pete\AppData\Local\GoTek Manager\gotek-manager.exe";
        assert_eq!(
            run("windows", Some(BundleType::Nsis), exe),
            Installation::Nsis
        );
        assert_eq!(
            run("windows", Some(BundleType::Msi), exe),
            Installation::Msi
        );
        assert!(matches!(
            run("windows", None, exe),
            Installation::Unmanaged(_)
        ));
        // macOS always reports an application bundle, so the path decides.
        assert_eq!(
            run(
                "macos",
                Some(BundleType::App),
                "/Applications/GoTek Manager.app/Contents/MacOS/gotek-manager"
            ),
            Installation::MacApp
        );
        for exe in [
            "/Users/pete/GoTekManager/src-tauri/target/release/gotek-manager",
            // Laid out like a bundle, but not an application bundle.
            "/Users/pete/Unpacked/Contents/MacOS/gotek-manager",
            // Inside an application bundle, but not where it keeps its executable.
            "/Applications/GoTek Manager.app/Contents/Resources/gotek-manager",
            "/Applications/GoTek Manager.app/Resources/MacOS/gotek-manager",
        ] {
            assert!(matches!(
                run("macos", Some(BundleType::App), exe),
                Installation::Unmanaged(_)
            ));
        }
    }

    #[test]
    fn every_installation_takes_the_file_the_release_names_for_it() {
        let product = product();
        let image = Installation::AppImage(PathBuf::from("/a/b.AppImage"));
        let cases = [
            (Installation::Deb, "x86_64", "GoTek.Manager_0.6.1_amd64.deb"),
            (
                Installation::Deb,
                "aarch64",
                "GoTek.Manager_0.6.1_arm64.deb",
            ),
            (
                Installation::Rpm,
                "x86_64",
                "GoTek.Manager-0.6.1-1.x86_64.rpm",
            ),
            (image, "x86_64", "GoTek.Manager_0.6.1_amd64.AppImage"),
            (
                Installation::Nsis,
                "x86_64",
                "GoTek.Manager_0.6.1_x64-setup.exe",
            ),
            (
                Installation::Nsis,
                "aarch64",
                "GoTek.Manager_0.6.1_arm64-setup.exe",
            ),
            (
                Installation::Msi,
                "x86_64",
                "GoTek.Manager_0.6.1_x64_en-US.msi",
            ),
            (
                Installation::Msi,
                "aarch64",
                "GoTek.Manager_0.6.1_arm64_en-US.msi",
            ),
            (
                Installation::MacApp,
                "x86_64",
                "GoTek.Manager_0.6.1_x64.dmg",
            ),
            (
                Installation::MacApp,
                "aarch64",
                "GoTek.Manager_0.6.1_aarch64.dmg",
            ),
        ];
        let mut named: Vec<String> = cases
            .iter()
            .map(|(installation, arch, expected)| {
                let name = asset_name(installation, &product, "0.6.1", arch).unwrap();
                assert_eq!(&name, expected);
                name
            })
            .collect();
        // Every file the last release published is somebody's update, and no
        // two installations share one.
        named.sort();
        let mut published = V061_ASSETS.map(str::to_string).to_vec();
        published.sort();
        assert_eq!(named, published);

        assert_eq!(
            asset_name(
                &Installation::Unmanaged(FROM_A_BUILD),
                &product,
                "0.6.1",
                "x86_64"
            ),
            None
        );
        assert_eq!(
            asset_name(&Installation::Deb, &product, "0.6.1", "riscv64"),
            None
        );
    }

    #[test]
    fn a_version_is_three_numbers_and_nothing_else() {
        assert_eq!(parse_version("v0.2.0"), Some((0, 2, 0)));
        assert_eq!(parse_version("0.2.0"), Some((0, 2, 0)));
        assert_eq!(parse_version("v10.20.30"), Some((10, 20, 30)));
        for tag in [
            "v0.2.0-rc1",
            "v0.2",
            "v0.2.0.1",
            "latest",
            "",
            "v+1.0.0",
            "v0..1",
        ] {
            assert_eq!(parse_version(tag), None, "{tag}");
        }
    }

    #[test]
    fn one_version_is_newer_than_another_by_number_never_by_spelling() {
        assert!(is_newer("v0.3.0", "0.2.0"));
        assert!(!is_newer("v0.2.0", "0.2.0"));
        assert!(!is_newer("v0.1.9", "0.2.0"));
        // As text, "0.10.0" sorts before "0.9.0".
        assert!(is_newer("v0.10.0", "0.9.0"));
        assert!(!is_newer("v0.9.0", "0.10.0"));
        assert!(is_newer("v1.0.0", "0.99.99"));
        assert!(!is_newer("nightly", "0.2.0"));
        assert!(!is_newer("v0.7.0-rc1", "0.6.1"));
    }

    fn url(name: &str) -> String {
        format!("{}v0.7.0/{name}", download_prefix())
    }

    fn release(tag: &str, assets: &[&str]) -> ApiRelease {
        ApiRelease {
            tag_name: tag.into(),
            body: Some("Fixes a thing.\r\n".into()),
            html_url: format!("https://github.com/{REPOSITORY}/releases/tag/{tag}"),
            draft: false,
            prerelease: false,
            assets: assets
                .iter()
                .map(|name| ApiAsset {
                    name: name.to_string(),
                    browser_download_url: url(name),
                    size: Some(1234),
                })
                .collect(),
        }
    }

    fn host_with<'a>(product: &'a str, has: &'a dyn Fn(&str) -> bool) -> Host<'a> {
        Host {
            product,
            current: "0.6.1",
            arch: "x86_64",
            has,
        }
    }

    const DEB_070: &str = "GoTek.Manager_0.7.0_amd64.deb";

    #[test]
    fn a_newer_release_is_offered_with_the_file_for_this_installation() {
        let product = product();
        let everything = |_: &str| true;
        let (update, pending) = offer(
            release("v0.7.0", &[DEB_070, SUMS_NAME]),
            &Installation::Deb,
            &host_with(&product, &everything),
        )
        .unwrap()
        .unwrap();

        assert_eq!(update.version, "0.7.0");
        assert_eq!(update.name, "GoTek Manager 0.7.0");
        assert_eq!(update.notes, "Fixes a thing.");
        assert_eq!(update.asset.as_deref(), Some(DEB_070));
        assert_eq!(update.method, Some(Method::Apt));
        assert_eq!(update.blocked, None);
        let pending = pending.unwrap();
        assert_eq!(pending.url, url(DEB_070));
        assert_eq!(pending.sums_url, url(SUMS_NAME));
        assert_eq!(pending.size, Some(1234));
    }

    #[test]
    fn the_running_version_or_an_older_one_is_not_offered() {
        let product = product();
        let everything = |_: &str| true;
        let host = host_with(&product, &everything);
        for tag in ["v0.6.1", "v0.6.0"] {
            assert!(offer(release(tag, &[SUMS_NAME]), &Installation::Deb, &host)
                .unwrap()
                .is_none());
        }
        let mut draft = release("v0.7.0", &[DEB_070, SUMS_NAME]);
        draft.prerelease = true;
        assert!(offer(draft, &Installation::Deb, &host).unwrap().is_none());
        // A latest release that is not an application release is a mistake
        // in publishing, and says so rather than claiming this is the latest.
        let error = offer(release("catalogue-1", &[]), &Installation::Deb, &host).unwrap_err();
        assert!(error.to_string().contains("not an application release"));
    }

    #[test]
    fn a_copy_that_cannot_update_itself_is_sent_to_the_release_page() {
        let product = product();
        let everything = |_: &str| true;
        let host = host_with(&product, &everything);
        let blocked = |release: ApiRelease, installation: &Installation| {
            let (update, pending) = offer(release, installation, &host).unwrap().unwrap();
            assert!(pending.is_none());
            assert_eq!(update.method, None);
            assert!(update.page_url.ends_with("/releases/tag/v0.7.0"));
            update.blocked.unwrap()
        };

        let reason = blocked(
            release("v0.7.0", &[DEB_070, SUMS_NAME]),
            &Installation::Unmanaged(FROM_A_BUILD),
        );
        assert_eq!(reason, FROM_A_BUILD);
        // No file for this system.
        let reason = blocked(release("v0.7.0", &[SUMS_NAME]), &Installation::Deb);
        assert!(reason.contains("has no file for this system"));
        // Nothing to check a download against.
        let reason = blocked(release("v0.7.0", &[DEB_070]), &Installation::Deb);
        assert!(reason.contains("has no SHA256SUMS"));
        // A download somewhere else than this project's releases.
        let mut elsewhere = release("v0.7.0", &[DEB_070, SUMS_NAME]);
        elsewhere.assets[0].browser_download_url = format!("https://example.org/{DEB_070}");
        let reason = blocked(elsewhere, &Installation::Deb);
        assert!(reason.contains("outside this project's releases"));
    }

    #[test]
    fn a_package_is_only_offered_where_its_package_manager_is() {
        let product = product();
        let no_dnf = |program: &str| program != "dnf";
        let host = host_with(&product, &no_dnf);
        let rpm = "GoTek.Manager-0.7.0-1.x86_64.rpm";
        let (update, pending) = offer(
            release("v0.7.0", &[rpm, SUMS_NAME]),
            &Installation::Rpm,
            &host,
        )
        .unwrap()
        .unwrap();
        assert!(pending.is_none());
        assert!(update.blocked.unwrap().contains("dnf is not available"));

        let everything = |_: &str| true;
        let host = host_with(&product, &everything);
        let (update, pending) = offer(
            release("v0.7.0", &[rpm, SUMS_NAME]),
            &Installation::Rpm,
            &host,
        )
        .unwrap()
        .unwrap();
        assert_eq!(update.method, Some(Method::Dnf));
        assert_eq!(pending.unwrap().asset, rpm);
    }

    #[test]
    fn the_appimage_update_names_the_file_it_replaces() {
        let product = product();
        let everything = |_: &str| true;
        let image = Installation::AppImage(PathBuf::from("/home/pete/Apps/GoTek.AppImage"));
        let (update, _) = offer(
            release("v0.7.0", &["GoTek.Manager_0.7.0_amd64.AppImage", SUMS_NAME]),
            &image,
            &host_with(&product, &everything),
        )
        .unwrap()
        .unwrap();
        assert_eq!(update.method, Some(Method::AppImage));
        assert_eq!(
            update.replaces.as_deref(),
            Some("/home/pete/Apps/GoTek.AppImage")
        );
    }

    #[test]
    fn a_checksum_is_found_by_the_exact_file_name() {
        let digest = "a".repeat(64);
        let other = "b".repeat(64);
        let sums =
            format!("{other}  GoTek.Manager_0.7.0_arm64.deb\n{digest} *{DEB_070}\nnot a line\n");
        assert_eq!(published_sum(&sums, DEB_070), Some(digest.clone()));
        assert_eq!(
            published_sum(&sums.to_uppercase(), &DEB_070.to_uppercase()),
            Some(digest)
        );
        assert_eq!(published_sum(&sums, "GoTek.Manager_0.7.0_amd64"), None);
        assert_eq!(published_sum("abc  GoTek.deb", "GoTek.deb"), None);
    }

    #[test]
    fn long_notes_are_cut_and_say_where_the_rest_is() {
        assert_eq!(shorten("  Fixes a thing.\n".into()), "Fixes a thing.");
        let notes = shorten("x".repeat(MAX_NOTES + 500));
        assert!(notes.ends_with("(continues on the release page)"));
        assert!(notes.chars().count() < MAX_NOTES + 100);
    }

    // -----------------------------------------------------------------------
    // Against a server
    // -----------------------------------------------------------------------

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn a_check_that_cannot_be_answered_says_why() {
        let client = client(None).unwrap();
        let base = serve(vec![
            (
                "/missing",
                Reply::status(404, "{\"message\":\"Not Found\"}"),
            ),
            (
                "/limited",
                Reply::status(403, "{\"message\":\"API rate limit exceeded\"}"),
            ),
            ("/garbled", Reply::ok("<html>")),
            (
                "/latest",
                Reply::ok(r#"{"tag_name":"v0.7.0","html_url":"https://x"}"#),
            ),
        ]);

        // Nothing published is an answer, and not an error.
        assert!(
            block_on(latest_release(&client, &format!("{base}/missing")))
                .unwrap()
                .is_none()
        );
        let limited = block_on(latest_release(&client, &format!("{base}/limited"))).unwrap_err();
        assert!(
            limited.to_string().contains("API rate limit exceeded"),
            "{limited}"
        );
        let garbled = block_on(latest_release(&client, &format!("{base}/garbled"))).unwrap_err();
        assert!(
            garbled.to_string().contains("could not be read"),
            "{garbled}"
        );
        let found = block_on(latest_release(&client, &format!("{base}/latest")))
            .unwrap()
            .unwrap();
        assert_eq!(found.tag_name, "v0.7.0");

        // Nobody listening.
        let unreachable = block_on(latest_release(&client, "http://127.0.0.1:9/")).unwrap_err();
        assert!(unreachable
            .to_string()
            .starts_with("GitHub could not be reached"));
    }

    fn pending_at(base: &str, body: &[u8]) -> Pending {
        Pending {
            installation: Installation::Deb,
            asset: DEB_070.into(),
            url: format!("{base}/{DEB_070}"),
            size: Some(body.len() as u64),
            sums_url: format!("{base}/{SUMS_NAME}"),
        }
    }

    fn sums_for(body: &[u8]) -> String {
        format!("{:x}  {DEB_070}\n", Sha256::digest(body))
    }

    #[test]
    fn a_download_is_kept_only_when_it_matches_its_published_checksum() {
        let folder = Scratch::new("update-download");
        let client = client(None).unwrap();
        let body = vec![7u8; 600 * 1024];
        let base = serve(vec![
            (&format!("/{SUMS_NAME}"), Reply::ok(sums_for(&body))),
            (&format!("/{DEB_070}"), Reply::ok(body.clone())),
        ]);
        let mut reports = Vec::new();

        let fetched = block_on(fetch_verified(
            &client,
            &pending_at(&base, &body),
            &folder,
            &AtomicBool::new(false),
            |progress| reports.push((progress.done, progress.total)),
        ))
        .unwrap();

        assert_eq!(fetched, Fetched::Done(folder.join(DEB_070)));
        assert_eq!(fs::read(folder.join(DEB_070)).unwrap(), body);
        assert_eq!(reports.first(), Some(&(0, Some(body.len() as u64))));
        assert_eq!(
            reports.last(),
            Some(&(body.len() as u64, Some(body.len() as u64)))
        );
        assert!(!folder.join(format!("{DEB_070}.part")).exists());
    }

    #[test]
    fn a_download_that_does_not_match_is_deleted() {
        let folder = Scratch::new("update-mismatch");
        let client = client(None).unwrap();
        let body = b"the real package".to_vec();
        let base = serve(vec![
            (
                &format!("/{SUMS_NAME}"),
                Reply::ok(sums_for(b"another package")),
            ),
            (&format!("/{DEB_070}"), Reply::ok(body.clone())),
        ]);

        let error = block_on(fetch_verified(
            &client,
            &pending_at(&base, &body),
            &folder,
            &AtomicBool::new(false),
            |_| {},
        ))
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("does not match its published checksum"));
        assert_eq!(fs::read_dir(&*folder).unwrap().count(), 0);
    }

    #[test]
    fn a_download_needs_a_checksum_line_for_its_own_file() {
        let folder = Scratch::new("update-no-line");
        let client = client(None).unwrap();
        let body = b"the real package".to_vec();
        let other = format!(
            "{:x}  GoTek.Manager_0.7.0_arm64.deb\n",
            Sha256::digest(&body)
        );
        let base = serve(vec![
            (&format!("/{SUMS_NAME}"), Reply::ok(other)),
            (&format!("/{DEB_070}"), Reply::ok(body.clone())),
        ]);

        let error = block_on(fetch_verified(
            &client,
            &pending_at(&base, &body),
            &folder,
            &AtomicBool::new(false),
            |_| {},
        ))
        .unwrap_err();

        assert!(error.to_string().contains("has no line for"), "{error}");
        assert!(!folder.join(DEB_070).exists());
    }

    #[test]
    fn a_cancelled_download_leaves_nothing_behind() {
        let folder = Scratch::new("update-cancel");
        let client = client(None).unwrap();
        let body = vec![1u8; 1024 * 1024];
        let base = serve(vec![
            (&format!("/{SUMS_NAME}"), Reply::ok(sums_for(&body))),
            (&format!("/{DEB_070}"), Reply::ok(body.clone())),
        ]);
        let cancelled = AtomicBool::new(false);

        let fetched = block_on(fetch_verified(
            &client,
            &pending_at(&base, &body),
            &folder,
            &cancelled,
            |_| cancelled.store(true, Ordering::Relaxed),
        ))
        .unwrap();

        assert_eq!(fetched, Fetched::Cancelled);
        assert_eq!(fs::read_dir(&*folder).unwrap().count(), 0);
    }

    #[test]
    fn a_download_of_the_wrong_size_is_not_used() {
        let folder = Scratch::new("update-size");
        let client = client(None).unwrap();
        let body = b"the real package".to_vec();
        let base = serve(vec![
            (&format!("/{SUMS_NAME}"), Reply::ok(sums_for(&body))),
            (&format!("/{DEB_070}"), Reply::ok(body.clone())),
        ]);
        let fetch = |size: u64| {
            let mut pending = pending_at(&base, &body);
            pending.size = Some(size);
            block_on(fetch_verified(
                &client,
                &pending,
                &folder,
                &AtomicBool::new(false),
                |_| {},
            ))
        };

        let longer = fetch(body.len() as u64 - 1).unwrap_err();
        assert!(
            longer.to_string().contains("larger than GitHub said"),
            "{longer}"
        );
        let shorter = fetch(body.len() as u64 + 1).unwrap_err();
        assert!(
            shorter.to_string().contains("arrived incomplete"),
            "{shorter}"
        );
        assert_eq!(fs::read_dir(&*folder).unwrap().count(), 0);
    }

    #[test]
    fn a_checksum_file_that_is_not_one_is_refused() {
        let folder = Scratch::new("update-sums-size");
        let client = client(None).unwrap();
        let body = b"the real package".to_vec();
        let huge = format!("{}{}", sums_for(&body), "x".repeat(MAX_SUMS));
        let base = serve(vec![
            (&format!("/{SUMS_NAME}"), Reply::ok(huge)),
            (&format!("/{DEB_070}"), Reply::ok(body.clone())),
        ]);

        let error = block_on(fetch_verified(
            &client,
            &pending_at(&base, &body),
            &folder,
            &AtomicBool::new(false),
            |_| {},
        ))
        .unwrap_err();

        assert!(error.to_string().contains("too large"), "{error}");
        assert_eq!(fs::read_dir(&*folder).unwrap().count(), 0);
    }

    #[test]
    fn a_download_starts_only_from_a_check_and_only_once() {
        let folder = Scratch::new("update-steps");
        let client = client(None).unwrap();
        let body = b"the real package".to_vec();
        let base = serve(vec![
            (&format!("/{SUMS_NAME}"), Reply::ok(sums_for(&body))),
            (&format!("/{DEB_070}"), Reply::ok(body.clone())),
        ]);
        let state = Updates::default();
        // Something left from an earlier update is cleared away.
        fs::write(folder.join("GoTek.Manager_0.6.0_amd64.deb"), b"old").unwrap();

        // Nothing has been checked, so there is nothing to download.
        let unchecked = block_on(download(&state, false, &client, &folder, |_| {})).unwrap_err();
        assert!(unchecked
            .to_string()
            .contains("Check for Application Updates again"));

        *locked(&state.pending) = Some(pending_at(&base, &body));
        // While media is being written, nothing starts.
        let busy = block_on(download(&state, true, &client, &folder, |_| {})).unwrap();
        assert!(matches!(busy, Downloaded::Held { message } if message == BUSY_WHILE_WRITING));
        assert!(locked(&state.downloaded).is_none());

        // One download at a time.
        state.downloading.store(true, Ordering::SeqCst);
        let twice = block_on(download(&state, false, &client, &folder, |_| {})).unwrap_err();
        assert!(twice.to_string().contains("already being downloaded"));
        state.downloading.store(false, Ordering::SeqCst);

        let ready = block_on(download(&state, false, &client, &folder, |_| {})).unwrap();
        assert!(matches!(ready, Downloaded::Ready));
        assert_eq!(
            *locked(&state.downloaded),
            Some((Installation::Deb, folder.join(DEB_070)))
        );
        assert!(!state.downloading.load(Ordering::SeqCst));
        assert!(!folder.join("GoTek.Manager_0.6.0_amd64.deb").exists());
    }

    #[test]
    fn the_application_does_not_stop_part_way_through_a_write() {
        let error = may_stop(true, "restart").unwrap_err();
        assert_eq!(
            error.to_string(),
            "GoTek Manager can restart once the write in progress has finished."
        );
        assert!(may_stop(false, "restart").is_ok());
    }

    // -----------------------------------------------------------------------
    // Installing
    // -----------------------------------------------------------------------

    /// A system that records what it was asked to do.
    struct Recorder {
        status: i32,
        stderr: &'static str,
        ran: RefCell<Vec<Vec<OsString>>>,
        opened: RefCell<Vec<PathBuf>>,
        missing: &'static [&'static str],
    }

    impl Recorder {
        fn exiting(status: i32) -> Self {
            Self {
                status,
                stderr: "",
                ran: RefCell::default(),
                opened: RefCell::default(),
                missing: &[],
            }
        }
    }

    impl System for Recorder {
        fn find(&self, program: &str) -> Option<PathBuf> {
            (!self.missing.contains(&program)).then(|| PathBuf::from("/usr/bin").join(program))
        }

        fn run(&self, command: &[OsString]) -> std::io::Result<Output> {
            self.ran.borrow_mut().push(command.to_vec());
            Ok(Output {
                status: std::process::ExitStatus::from_raw(self.status << 8),
                stdout: Vec::new(),
                stderr: self.stderr.as_bytes().to_vec(),
            })
        }

        fn open(&self, path: &Path) -> Result<()> {
            self.opened.borrow_mut().push(path.to_path_buf());
            Ok(())
        }
    }

    fn command(parts: &[&str]) -> Vec<OsString> {
        parts.iter().map(OsString::from).collect()
    }

    #[test]
    fn a_package_is_installed_by_its_package_manager_after_the_password_prompt() {
        let folder = Scratch::new("update-apt");
        let package = folder.join(DEB_070);
        fs::write(&package, b"deb").unwrap();
        let system = Recorder::exiting(0);

        let outcome = put_in_place(&Installation::Deb, &package, false, &system).unwrap();

        assert_eq!(outcome, Outcome::Restart);
        let path = package.to_str().unwrap();
        assert_eq!(
            system.ran.borrow().as_slice(),
            [command(&[
                "/usr/bin/pkexec",
                "/usr/bin/apt-get",
                "install",
                "--yes",
                path
            ])]
        );
        // The download has done its job.
        assert!(!package.exists());

        let system = Recorder::exiting(0);
        put_in_place(&Installation::Rpm, &package, false, &system).unwrap();
        assert_eq!(
            system.ran.borrow().as_slice(),
            [command(&[
                "/usr/bin/pkexec",
                "/usr/bin/dnf",
                "install",
                "--assumeyes",
                path
            ])]
        );
    }

    #[test]
    fn a_dismissed_password_prompt_is_not_a_failure() {
        let package = Path::new("/nowhere/GoTek.deb");
        let outcome =
            put_in_place(&Installation::Deb, package, false, &Recorder::exiting(126)).unwrap();
        assert_eq!(
            outcome,
            Outcome::Held {
                message: "The password prompt was dismissed, so nothing was installed.".into()
            }
        );
    }

    #[test]
    fn a_failed_install_says_why_and_how_to_do_it_by_hand() {
        let package = Path::new("/home/pete/.cache/it's here/GoTek.deb");
        let refused =
            put_in_place(&Installation::Deb, package, false, &Recorder::exiting(127)).unwrap_err();
        assert!(refused
            .to_string()
            .contains("did not allow the installation"));
        assert!(refused
            .to_string()
            .ends_with(r"sudo apt install '/home/pete/.cache/it'\''s here/GoTek.deb'"));

        let mut broken = Recorder::exiting(100);
        broken.stderr =
            "Reading package lists...\nE: Unable to lock the administration directory\n";
        let failed = put_in_place(&Installation::Deb, package, false, &broken).unwrap_err();
        assert!(failed
            .to_string()
            .starts_with("The package could not be installed: E: Unable to lock"));

        let mut bare = Recorder::exiting(0);
        bare.missing = &["pkexec"];
        let missing = put_in_place(&Installation::Rpm, package, false, &bare).unwrap_err();
        assert!(missing.to_string().starts_with("pkexec is not installed"));
        assert!(missing.to_string().contains("sudo dnf install"));
        assert!(bare.ran.borrow().is_empty());
    }

    #[test]
    fn nothing_is_installed_while_media_is_being_written() {
        let folder = Scratch::new("update-busy");
        let package = folder.join(DEB_070);
        fs::write(&package, b"deb").unwrap();
        let image = folder.join("GoTek.AppImage");
        fs::write(&image, b"old").unwrap();

        for installation in [
            Installation::Deb,
            Installation::Rpm,
            Installation::AppImage(image.clone()),
            Installation::Nsis,
            Installation::Msi,
            Installation::MacApp,
        ] {
            let system = Recorder::exiting(0);
            let outcome = put_in_place(&installation, &package, true, &system).unwrap();
            assert_eq!(
                outcome,
                Outcome::Held {
                    message: BUSY_WHILE_WRITING.into()
                },
                "{installation:?}"
            );
            assert!(system.ran.borrow().is_empty());
            assert!(system.opened.borrow().is_empty());
        }
        assert_eq!(fs::read(&image).unwrap(), b"old");
        assert!(package.exists());
    }

    #[test]
    fn an_appimage_is_replaced_whole_and_keeps_its_permissions() {
        let folder = Scratch::new("update-appimage");
        let image = folder.join("GoTek.Manager_0.6.1_amd64.AppImage");
        fs::write(&image, b"old version").unwrap();
        fs::set_permissions(&image, fs::Permissions::from_mode(0o750)).unwrap();
        // Launchers often point at a link rather than the file itself.
        let link = folder.join("gotek-manager");
        std::os::unix::fs::symlink(&image, &link).unwrap();
        let download = folder.join("download.AppImage");
        fs::write(&download, b"new version").unwrap();
        fs::set_permissions(&download, fs::Permissions::from_mode(0o600)).unwrap();

        let outcome = put_in_place(
            &Installation::AppImage(link.clone()),
            &download,
            false,
            &Recorder::exiting(0),
        )
        .unwrap();

        assert_eq!(outcome, Outcome::Restart);
        assert_eq!(fs::read(&image).unwrap(), b"new version");
        assert_eq!(
            fs::metadata(&image).unwrap().permissions().mode() & 0o777,
            0o750
        );
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!download.exists());
        // Nothing half-made is left beside it.
        let mut left: Vec<_> = fs::read_dir(&*folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                OsString::from("GoTek.Manager_0.6.1_amd64.AppImage"),
                "gotek-manager".into()
            ]
        );
    }

    #[test]
    fn an_appimage_in_a_folder_that_cannot_be_written_is_left_alone() {
        let folder = Scratch::new("update-readonly");
        let shelf = folder.join("shelf");
        fs::create_dir(&shelf).unwrap();
        let image = shelf.join("GoTek.AppImage");
        fs::write(&image, b"old version").unwrap();
        let download = folder.join("download.AppImage");
        fs::write(&download, b"new version").unwrap();
        fs::set_permissions(&shelf, fs::Permissions::from_mode(0o555)).unwrap();
        // Root can write anywhere, so there is nothing to refuse it.
        let privileged = fs::write(shelf.join(".probe"), b"").is_ok();

        let result = put_in_place(
            &Installation::AppImage(image.clone()),
            &download,
            false,
            &Recorder::exiting(0),
        );
        fs::set_permissions(&shelf, fs::Permissions::from_mode(0o755)).unwrap();

        if !privileged {
            let error = result.unwrap_err();
            assert!(
                error.to_string().contains("could not be replaced"),
                "{error}"
            );
            assert_eq!(fs::read(&image).unwrap(), b"old version");
            assert!(download.exists());
        }
    }

    #[test]
    fn a_replacement_that_fails_part_way_leaves_nothing_beside_the_file() {
        let folder = Scratch::new("update-rename");
        // A folder where the AppImage should be: the copy can be made beside
        // it, and the rename over it then fails.
        let image = folder.join("GoTek.AppImage");
        fs::create_dir(&image).unwrap();
        let download = folder.join("download.AppImage");
        fs::write(&download, b"new version").unwrap();

        let error = replace_file(&download, &image).unwrap_err();

        assert!(
            error.to_string().contains("could not be replaced"),
            "{error}"
        );
        assert!(!folder.join(".GoTek.AppImage.update").exists());
        assert!(image.is_dir());
    }

    #[test]
    fn windows_starts_the_installer_and_macos_opens_the_disk_image() {
        let package = Path::new("/cache/updates/GoTek.Manager_0.7.0_x64-setup.exe");
        for installation in [Installation::Nsis, Installation::Msi] {
            let system = Recorder::exiting(0);
            let outcome = put_in_place(&installation, package, false, &system).unwrap();
            assert_eq!(outcome, Outcome::Handover);
            assert_eq!(system.opened.borrow().as_slice(), [package.to_path_buf()]);
            assert!(system.ran.borrow().is_empty());
        }

        let image = Path::new("/cache/updates/GoTek.Manager_0.7.0_aarch64.dmg");
        let system = Recorder::exiting(0);
        assert_eq!(
            put_in_place(&Installation::MacApp, image, false, &system).unwrap(),
            Outcome::Opened
        );
        assert_eq!(system.opened.borrow().as_slice(), [image.to_path_buf()]);
    }

    /// Asks the real GitHub for the latest release and checks that every
    /// installation finds its own file there.
    ///
    /// Opt-in, because it needs the network: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn the_published_release_has_a_file_for_every_installation() {
        let client = client(None).unwrap();
        let release = block_on(latest_release(&client, &latest_url()))
            .unwrap()
            .expect("a release is published");
        let version = parse_version(&release.tag_name).expect("an application release");
        let version = format!("{}.{}.{}", version.0, version.1, version.2);
        let names: Vec<&str> = release
            .assets
            .iter()
            .map(|asset| asset.name.as_str())
            .collect();
        let product = product();
        for (installation, arch) in [
            (Installation::Deb, "x86_64"),
            (Installation::Deb, "aarch64"),
            (Installation::Rpm, "x86_64"),
            (Installation::AppImage(PathBuf::new()), "x86_64"),
            (Installation::Nsis, "x86_64"),
            (Installation::Nsis, "aarch64"),
            (Installation::Msi, "x86_64"),
            (Installation::Msi, "aarch64"),
            (Installation::MacApp, "x86_64"),
            (Installation::MacApp, "aarch64"),
        ] {
            let name = asset_name(&installation, &product, &version, arch).unwrap();
            assert!(names.contains(&name.as_str()), "{name} is not in {names:?}");
        }
        for asset in &release.assets {
            assert!(asset.browser_download_url.starts_with(&download_prefix()));
        }
    }
}
