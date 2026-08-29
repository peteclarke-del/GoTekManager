//! Writing the drive's own configuration file onto the stick.
//!
//! What the file should say is decided in the frontend, where the platform and
//! firmware catalogue lives. What this module decides is *where* it goes and
//! whether it may be written at all, both of which are questions about the
//! stick in front of us rather than about the machine being prepared.
//!
//! The placement is the part that is easy to get wrong and impossible to
//! notice: FlashFloppy reads `FF.CFG` from the root of the stick, but if an
//! `FF` folder exists it reads the file only from there. A configuration
//! written to the root of a stick that has an `FF` folder is a file the
//! firmware never opens, and the drive behaves exactly as though nothing had
//! been written.

use crate::error::{Context, Result};
use crate::paths::safe_target_path;
use crate::task::blocking;
use serde::Serialize;
use std::{fs, path::Path};

/// The file FlashFloppy reads.
pub const CONFIG_NAME: &str = "FF.CFG";
/// The folder that, when present, is the only place the firmware looks.
pub const CONFIG_FOLDER: &str = "FF";

/// Where the configuration belongs on this stick, relative to its root.
pub fn config_location(root: &Path) -> String {
    if root.join(CONFIG_FOLDER).is_dir() {
        format!("{CONFIG_FOLDER}/{CONFIG_NAME}")
    } else {
        CONFIG_NAME.to_string()
    }
}

/// What is on the stick now, so the interface can say what writing would do.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareConfigState {
    /// Where the file belongs, relative to the destination root.
    pub path: String,
    pub exists: bool,
    /// The existing file, so a replacement can be compared against it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contents: Option<String>,
}

fn read_state(root: &Path) -> Result<FirmwareConfigState> {
    let path = config_location(root);
    let full = safe_target_path(root, &path)?;
    // Read as bytes and convert loosely: a configuration edited on another
    // machine may not be valid UTF-8, and that is not a reason to refuse to
    // tell the user a file is there.
    let contents = fs::read(&full)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
    Ok(FirmwareConfigState {
        exists: contents.is_some(),
        contents,
        path,
    })
}

fn write_config(root: &Path, contents: &str, replace: bool) -> Result<String> {
    let path = config_location(root);
    let full = safe_target_path(root, &path)?;
    if full.exists() && !replace {
        return Err(format!(
            "{path} is already on this drive. Choose to replace it if you mean to."
        )
        .into());
    }
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)?;
    }

    // Written beside itself and renamed, so a stick pulled out mid-write is
    // left with either the old configuration or the new one, never half a file
    // that the firmware would read and act on.
    let temporary = full.with_extension("part");
    fs::write(&temporary, contents.as_bytes())
        .with_context(|| format!("Unable to write {path}"))?;
    fs::rename(&temporary, &full).with_context(|| format!("Unable to write {path}"))?;

    let written = fs::read(&full).with_context(|| format!("Unable to read back {path}"))?;
    if written != contents.as_bytes() {
        return Err(format!("{path} did not read back as it was written.").into());
    }
    Ok(path)
}

#[tauri::command]
pub async fn firmware_config_state(target: String) -> Result<FirmwareConfigState> {
    blocking(move || {
        let root = crate::devices::resolve_destination(&target)?;
        read_state(&root)
    })
    .await
}

#[tauri::command]
pub async fn write_firmware_config(
    target: String,
    contents: String,
    replace: Option<bool>,
) -> Result<String> {
    blocking(move || {
        let root = crate::devices::resolve_destination(&target)?;
        crate::devices::probe_writable(&root)?;
        write_config(&root, &contents, replace.unwrap_or(false))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{config_location, read_state, write_config, CONFIG_FOLDER, CONFIG_NAME};
    use std::{fs, path::PathBuf};

    /// A throwaway directory standing in for a mounted stick.
    fn drive(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "gotek-firmware-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn an_ff_folder_moves_the_configuration_into_it() {
        let root = drive("folder");

        // No folder: the root is where the firmware looks.
        assert_eq!(config_location(&root), CONFIG_NAME);

        // With one, the root copy would be ignored, so that is not where it goes.
        fs::create_dir(root.join(CONFIG_FOLDER)).unwrap();
        assert_eq!(config_location(&root), "FF/FF.CFG");
    }

    #[test]
    fn a_configuration_already_on_the_drive_is_not_overwritten_by_accident() {
        let root = drive("existing");
        fs::write(root.join(CONFIG_NAME), b"# tuned by hand\nnav-mode = indexed\n").unwrap();

        let refused = write_config(&root, "nav-mode = native\n", false);

        assert!(refused.is_err());
        // And the file that was there is exactly as it was.
        let kept = fs::read_to_string(root.join(CONFIG_NAME)).unwrap();
        assert!(kept.contains("indexed"));

        // Replacing is possible, but only when asked for.
        write_config(&root, "nav-mode = native\n", true).unwrap();
        assert_eq!(
            fs::read_to_string(root.join(CONFIG_NAME)).unwrap(),
            "nav-mode = native\n"
        );
    }

    #[test]
    fn writing_leaves_no_partial_file_behind_and_reads_back_byte_for_byte() {
        let root = drive("atomic");
        let contents = "# FF.CFG\nnav-mode = native\nhost = acorn\n";

        let path = write_config(&root, contents, false).unwrap();

        assert_eq!(path, CONFIG_NAME);
        assert_eq!(fs::read_to_string(root.join(CONFIG_NAME)).unwrap(), contents);
        // The temporary name used during the write is gone.
        assert!(!root.join("FF.part").exists());
    }

    #[test]
    fn the_state_reports_where_the_file_belongs_and_what_is_there() {
        let root = drive("state");
        fs::create_dir(root.join(CONFIG_FOLDER)).unwrap();

        let before = read_state(&root).unwrap();
        assert_eq!(before.path, "FF/FF.CFG");
        assert!(!before.exists);
        assert!(before.contents.is_none());

        write_config(&root, "nav-mode = native\n", false).unwrap();

        let after = read_state(&root).unwrap();
        assert!(after.exists);
        assert_eq!(after.contents.as_deref(), Some("nav-mode = native\n"));
    }

    #[test]
    fn a_configuration_that_is_not_valid_utf8_is_still_reported_as_present() {
        // One edited on another machine, or written by other software. Refusing
        // to read it would tell the user the drive has no configuration, and
        // the next write would then quietly replace one they rely on.
        let root = drive("bytes");
        fs::write(root.join(CONFIG_NAME), [0x6E, 0x61, 0x76, 0xFF, 0xFE]).unwrap();

        let state = read_state(&root).unwrap();

        assert!(state.exists);
        assert!(state.contents.is_some());
    }
}
