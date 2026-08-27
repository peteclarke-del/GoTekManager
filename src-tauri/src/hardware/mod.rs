//! Physical device identity.
//!
//! Mount paths are not identity. A USB stick can be unplugged and a different
//! one mounted at the same path a second later, so anything destructive has to
//! be addressed by the device itself — node, model, serial, size, and its
//! partition graph — and re-resolved immediately before it is touched.
//!
//! Each operating system is served by a pure parser over the output of its own
//! tooling, so the Windows and macOS behaviour is unit-tested from a Linux
//! build host against captured fixtures rather than assumed.

mod linux;
mod macos;
mod windows;

use crate::error::{Context, Result};
use crate::task::blocking;
use serde::{Deserialize, Serialize};
use std::process::Command;

/// One partition or volume on a physical device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Partition {
    /// `/dev/sdb1`, `disk4s1`, or the drive letter on Windows.
    pub node: String,
    pub size_bytes: u64,
    pub filesystem: Option<String>,
    pub label: Option<String>,
    pub uuid: Option<String>,
    /// Every path this partition, or anything layered on it, is mounted at.
    pub mount_points: Vec<String>,
}

/// A whole physical device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalDevice {
    /// The stable OS handle: `/dev/sdb`, `\\.\PHYSICALDRIVE1`, `/dev/disk4`.
    pub node: String,
    /// A readable name assembled from vendor and model.
    pub name: String,
    pub vendor: Option<String>,
    pub model: Option<String>,
    pub serial: Option<String>,
    pub size_bytes: u64,
    pub removable: bool,
    /// `usb`, `sata`, `nvme`, and so on, where the platform reports it.
    pub transport: Option<String>,
    pub partitions: Vec<Partition>,
    /// True when this device carries the running operating system. Never a
    /// candidate for anything destructive, under any circumstances.
    pub system: bool,
}

impl PhysicalDevice {
    /// A short fingerprint used to prove the device has not been swapped
    /// between planning a destructive operation and performing it.
    ///
    /// Deliberately built only from properties that cannot change while the
    /// same device stays plugged in. The mount path is excluded precisely
    /// because it is the thing that does change.
    pub fn identity(&self) -> String {
        format!(
            "{}|{}|{}|{}",
            self.node,
            self.model.as_deref().unwrap_or("?"),
            self.serial.as_deref().unwrap_or("?"),
            self.size_bytes
        )
    }

    /// True when this device is a plausible target for GoTek media.
    pub fn is_candidate(&self) -> bool {
        !self.system && self.size_bytes > 0
    }
}

/// Mount points that mean "the running system lives here".
pub const SYSTEM_MOUNTS: [&str; 7] = ["/", "/boot", "/boot/efi", "/usr", "/var", "/etc", "[SWAP]"];

pub fn mounts_are_system(mount_points: &[String]) -> bool {
    mount_points.iter().any(|mount| {
        let mount = mount.trim_end_matches('/');
        let mount = if mount.is_empty() { "/" } else { mount };
        SYSTEM_MOUNTS.contains(&mount)
            // A Windows system volume reports the drive letter that holds it.
            || mount.eq_ignore_ascii_case("C:")
            || mount.eq_ignore_ascii_case("C:\\")
    })
}

/// Joins a vendor and model into something worth showing a person.
pub fn device_name(vendor: Option<&str>, model: Option<&str>, node: &str) -> String {
    let parts = [vendor, model]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.is_empty() {
        node.to_string()
    } else {
        parts.join(" ")
    }
}

fn run(program: &str, args: &[&str]) -> Result<String> {
    // Fixed argument arrays only. Nothing here is ever assembled into a shell
    // command, so a device name or label can never be interpreted as syntax.
    let output = Command::new(program)
        .args(args)
        .output()
        .with_context(|| format!("Unable to run {program}"))?;
    if !output.status.success() {
        return Err(format!(
            "{program} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Enumerates every physical device the operating system reports.
///
/// Read-only. Devices that carry the running system are still listed, flagged
/// as such, so the interface can show them greyed out rather than pretending
/// they do not exist.
pub fn enumerate() -> Result<Vec<PhysicalDevice>> {
    #[cfg(target_os = "linux")]
    {
        let output = run("lsblk", &linux::LSBLK_ARGS)?;
        linux::parse(&output)
    }
    #[cfg(target_os = "windows")]
    {
        let output = run("powershell", &windows::POWERSHELL_ARGS)?;
        windows::parse(&output)
    }
    #[cfg(target_os = "macos")]
    {
        macos::enumerate(run)
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        Err("Device enumeration is not supported on this platform.".into())
    }
}

#[tauri::command]
pub async fn physical_devices() -> Result<Vec<PhysicalDevice>> {
    blocking(enumerate).await
}

/// Finds a device again by the identity recorded when a plan was made.
///
/// Returns an error rather than a guess: if the device is gone, or something
/// else is now at that node, the caller must abandon the operation.
pub fn resolve(identity: &str) -> Result<PhysicalDevice> {
    let devices = enumerate()?;
    devices
        .into_iter()
        .find(|device| device.identity() == identity)
        .context(
            "The device is no longer present, or is not the same device. \
             Re-scan and build the plan again.",
        )
}

#[cfg(test)]
mod tests {
    use super::{device_name, mounts_are_system, PhysicalDevice};

    fn device(system: bool, size: u64) -> PhysicalDevice {
        PhysicalDevice {
            node: "/dev/sdb".into(),
            name: "SanDisk Cruzer".into(),
            vendor: Some("SanDisk".into()),
            model: Some("Cruzer".into()),
            serial: Some("4C530001".into()),
            size_bytes: size,
            removable: true,
            transport: Some("usb".into()),
            partitions: vec![],
            system,
        }
    }

    #[test]
    fn identity_ignores_the_mount_path_because_that_is_what_changes() {
        let first = device(false, 8_000_000_000);
        let mut second = first.clone();
        second.partitions.push(super::Partition {
            node: "/dev/sdb1".into(),
            size_bytes: 8_000_000_000,
            filesystem: Some("vfat".into()),
            label: Some("GOTEK".into()),
            uuid: None,
            mount_points: vec!["/media/somewhere-else".into()],
        });

        assert_eq!(first.identity(), second.identity());

        // A different stick of the same model is a different device.
        let mut other = first.clone();
        other.serial = Some("4C530002".into());
        assert_ne!(first.identity(), other.identity());

        // So is the same model at a different capacity.
        let mut resized = first.clone();
        resized.size_bytes = 16_000_000_000;
        assert_ne!(first.identity(), resized.identity());
    }

    #[test]
    fn a_system_device_is_never_a_candidate() {
        assert!(device(false, 8_000_000_000).is_candidate());
        assert!(!device(true, 8_000_000_000).is_candidate());
        assert!(!device(false, 0).is_candidate());
    }

    #[test]
    fn system_mount_points_are_recognised_on_every_platform() {
        assert!(mounts_are_system(&["/".into()]));
        assert!(mounts_are_system(&["/boot/efi".into()]));
        assert!(mounts_are_system(&["[SWAP]".into()]));
        assert!(mounts_are_system(&["C:\\".into()]));
        assert!(!mounts_are_system(&["/media/pclarke/GOTEK".into()]));
        assert!(!mounts_are_system(&["E:\\".into()]));
        assert!(!mounts_are_system(&[]));
    }

    #[test]
    fn device_names_fall_back_to_the_node() {
        assert_eq!(device_name(Some("SanDisk "), Some("Cruzer"), "/dev/sdb"), "SanDisk Cruzer");
        assert_eq!(device_name(None, Some("Cruzer"), "/dev/sdb"), "Cruzer");
        assert_eq!(device_name(Some("  "), None, "/dev/sdb"), "/dev/sdb");
    }
}
