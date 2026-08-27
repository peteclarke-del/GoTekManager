//! Discovery and validation of storage destinations.
//!
//! Discovery is read-only. Nothing in this module writes to a device except
//! [`probe_writable`], which is only called for an explicit inspection or
//! immediately before a transfer.
//!
//! Every platform-specific rule is expressed as a pure function that takes the
//! operating system as an argument, so the Windows and macOS behaviour is unit
//! tested from a Linux build host rather than assumed.

use crate::error::{Context, Result};
use crate::paths::{canonical, strip_verbatim};
use crate::task::blocking;
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use sysinfo::Disks;

/// A mount offered to the user in the destination picker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountedTarget {
    pub path: String,
    pub device: String,
    /// A readable name, resolved here so the frontend never parses device
    /// strings itself.
    pub label: String,
    pub filesystem: String,
    /// `removable`, `network`, `fixed`, or `system`.
    pub kind: String,
    pub total_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
    pub removable: bool,
    pub detected_firmware_id: Option<String>,
}

const FIRMWARE_EVIDENCE: [(&str, &str); 2] = [("FF.CFG", "flashfloppy"), ("HXCSDFE.CFG", "hxc")];

/// Identifies firmware only from configuration files in the volume root.
///
/// This is evidence, not identity: it says what the media was prepared for, not
/// what drive is attached. The user can always override it on the profile.
pub fn detected_firmware(mount: &Path) -> Option<String> {
    let names = fs::read_dir(mount)
        .ok()?
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_uppercase())
        .collect::<HashSet<_>>();
    FIRMWARE_EVIDENCE
        .iter()
        .find(|(marker, _)| names.contains(*marker))
        .map(|(_, firmware)| (*firmware).to_string())
}

// ---------------------------------------------------------------------------
// Platform rules
// ---------------------------------------------------------------------------

/// Folds separators, trailing slashes, and case where the platform is
/// case-insensitive, so path containment can be compared as text on any host.
fn normalise_for_compare(os: &str, path: &str) -> String {
    let mut value = path.replace('\\', "/");
    while value.len() > 1 && value.ends_with('/') {
        value.pop();
    }
    if matches!(os, "windows" | "macos") {
        value = value.to_lowercase();
    }
    value
}

/// Component-aware containment: `/usr` contains `/usr/share` but not `/usrshare`.
fn is_within(os: &str, path: &str, prefix: &str) -> bool {
    let path = normalise_for_compare(os, path);
    let prefix = normalise_for_compare(os, prefix);
    path == prefix || path.starts_with(&format!("{prefix}/"))
}

/// True for `/`, `\`, and any bare Windows drive such as `D:\`.
fn is_filesystem_root(os: &str, path: &str) -> bool {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return true;
    }
    if os == "windows" {
        let bytes = trimmed.as_bytes();
        return bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    }
    false
}

/// Locations that are protected together with everything inside them.
fn protected_trees(os: &str) -> &'static [&'static str] {
    match os {
        "windows" => &[],
        "macos" => &[
            "/System",
            "/Library",
            "/private",
            "/Applications",
            "/usr",
            "/bin",
            "/sbin",
            "/dev",
        ],
        _ => &[
            "/boot", "/proc", "/sys", "/dev", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64",
        ],
    }
}

/// Locations that hold mount points. Writing *into* one of these is a mistake;
/// writing into a volume mounted beneath one is exactly what this app is for.
fn protected_exact(os: &str) -> &'static [&'static str] {
    match os {
        "windows" => &[],
        "macos" => &["/Volumes", "/Users"],
        _ => &["/media", "/mnt", "/run/media", "/home"],
    }
}

/// Refuses system locations as transfer destinations.
///
/// `system_root` is `%SystemRoot%` on Windows and unused elsewhere; it is passed
/// in so this rule can be tested for every platform from one host.
pub fn is_protected_location(os: &str, path: &str, system_root: Option<&str>) -> bool {
    if is_filesystem_root(os, path) {
        return true;
    }
    if protected_exact(os)
        .iter()
        .any(|candidate| normalise_for_compare(os, path) == normalise_for_compare(os, candidate))
    {
        return true;
    }
    if protected_trees(os)
        .iter()
        .any(|tree| is_within(os, path, tree))
    {
        return true;
    }
    if os != "windows" {
        return false;
    }
    let Some(system_root) = system_root else {
        return false;
    };
    if is_within(os, path, system_root) {
        return true;
    }
    // %SystemRoot% is `C:\Windows`; derive the rest of the system drive from it.
    let drive = system_root.split(['/', '\\']).next().unwrap_or_default();
    ["Program Files", "Program Files (x86)", "ProgramData"]
        .iter()
        .any(|folder| is_within(os, path, &format!("{drive}/{folder}")))
}

fn is_network_filesystem(filesystem: &str) -> bool {
    let filesystem = filesystem.to_ascii_lowercase();
    const NETWORK: [&str; 13] = [
        "nfs", "nfs4", "cifs", "smbfs", "smb3", "smb-share", "sshfs", "davfs", "dav", "afpfs",
        "ceph", "glusterfs", "9p",
    ];
    NETWORK.contains(&filesystem.as_str())
        || filesystem.starts_with("fuse.sshfs")
        || filesystem.starts_with("gvfs")
}

/// Classifies one mount so the picker can group and filter it consistently.
pub fn classify_mount(
    os: &str,
    system_root: Option<&str>,
    path: &str,
    device: &str,
    filesystem: &str,
    removable: bool,
) -> &'static str {
    if is_network_filesystem(filesystem) || path.starts_with(r"\\") {
        return "network";
    }
    if removable {
        return "removable";
    }
    let system = match os {
        "windows" => is_protected_location(os, path, system_root) || is_filesystem_root(os, path),
        "macos" => is_filesystem_root(os, path) || is_protected_location(os, path, None),
        _ => {
            is_filesystem_root(os, path)
                || is_protected_location(os, path, None)
                || is_within(os, path, "/snap")
                || is_within(os, path, "/var/lib/docker")
                // Overlay, tmpfs, squashfs, and container mounts have no
                // backing block device.
                || !device.starts_with("/dev/")
        }
    };
    if system {
        "system"
    } else {
        "fixed"
    }
}

/// Turns a GVFS mount directory name such as
/// `smb-share:server=nas,share=games` into `games on nas`.
fn gvfs_label(device: &str) -> String {
    let mut parts = device.split([':', ',']);
    let scheme = parts.next().unwrap_or_default();
    let attributes = parts
        .filter_map(|part| part.split_once('='))
        .collect::<Vec<_>>();
    let value = |key: &str| {
        attributes
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| *value)
    };
    match (value("share"), value("server")) {
        (Some(share), Some(server)) => format!("{share} on {server}"),
        (Some(share), None) => share.to_string(),
        (None, Some(server)) => server.to_string(),
        (None, None) => scheme.to_string(),
    }
}

fn mount_label(path: &str, device: &str, filesystem: &str) -> String {
    if filesystem.starts_with("smb") || filesystem.starts_with("gvfs") || device.contains('=') {
        return gvfs_label(device);
    }
    let segments = path
        .split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    segments
        .last()
        .map(|segment| (*segment).to_string())
        // A Windows drive root has no trailing segment; show `C:\`.
        .unwrap_or_else(|| path.to_string())
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

fn sysinfo_mounts(system_root: Option<&str>) -> Vec<MountedTarget> {
    Disks::new_with_refreshed_list()
        .iter()
        .map(|disk| {
            let path = strip_verbatim(disk.mount_point().to_path_buf())
                .to_string_lossy()
                .into_owned();
            let device = disk.name().to_string_lossy().into_owned();
            let filesystem = disk.file_system().to_string_lossy().into_owned();
            let removable = disk.is_removable();
            MountedTarget {
                kind: classify_mount(
                    std::env::consts::OS,
                    system_root,
                    &path,
                    &device,
                    &filesystem,
                    removable,
                )
                .to_string(),
                label: mount_label(&path, &device, &filesystem),
                detected_firmware_id: detected_firmware(disk.mount_point()),
                total_bytes: Some(disk.total_space()),
                available_bytes: Some(disk.available_space()),
                removable,
                path,
                device,
                filesystem,
            }
        })
        .collect()
}

/// Linux desktops expose network and phone mounts through GVFS rather than the
/// kernel mount table, so `sysinfo` never sees them.
#[cfg(target_os = "linux")]
pub fn gvfs_targets(root: &Path) -> Vec<MountedTarget> {
    fs::read_dir(root)
        .into_iter()
        .flatten()
        .filter_map(std::result::Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() || fs::read_dir(&path).is_err() {
                return None;
            }
            let device = entry.file_name().to_string_lossy().into_owned();
            let filesystem = device.split(':').next().unwrap_or("gvfs").to_string();
            Some(MountedTarget {
                label: gvfs_label(&device),
                kind: "network".into(),
                detected_firmware_id: detected_firmware(&path),
                total_bytes: None,
                available_bytes: None,
                removable: false,
                path: path.to_string_lossy().into_owned(),
                device,
                filesystem,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn mounted_targets(include_system: bool) -> Result<Vec<MountedTarget>> {
    blocking(move || {
        let system_root = std::env::var("SystemRoot").ok();
        let mut targets = sysinfo_mounts(system_root.as_deref());
        #[cfg(target_os = "linux")]
        if let Some(runtime_dir) = std::env::var_os("XDG_RUNTIME_DIR") {
            targets.extend(gvfs_targets(&PathBuf::from(runtime_dir).join("gvfs")));
        }
        if !include_system {
            targets.retain(|target| target.kind != "system");
        }
        targets.sort_by(|left, right| left.path.cmp(&right.path));
        targets.dedup_by(|left, right| left.path == right.path);
        Ok(targets)
    })
    .await
}

// ---------------------------------------------------------------------------
// Destination validation
// ---------------------------------------------------------------------------

/// Resolves a destination and refuses system locations. Read-only: safe to call
/// while the user is still editing a plan.
pub fn resolve_destination(target: &str) -> Result<PathBuf> {
    let canonical = canonical(Path::new(target))
        .with_context(|| format!("Unable to resolve the destination {target}"))?;
    if !canonical.is_dir() {
        return Err("The selected destination is not a folder.".into());
    }
    if is_protected_location(
        std::env::consts::OS,
        &canonical.to_string_lossy(),
        std::env::var("SystemRoot").ok().as_deref(),
    ) {
        return Err("Choose a specific media folder or volume, not a system location.".into());
    }
    Ok(canonical)
}

/// Confirms the destination really accepts writes.
///
/// Read-only metadata is not a reliable answer on any platform: the Unix
/// permission bits describe the owner rather than this process, and the Windows
/// read-only attribute is not meaningful for directories. Creating and removing
/// one empty file is the only portable test.
pub fn probe_writable(folder: &Path) -> Result<()> {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let probe = folder.join(format!(".gotek-write-test-{}-{unique}", std::process::id()));
    fs::File::create(&probe)
        .with_context(|| format!("The destination is not writable: {}", folder.display()))?;
    let _ = fs::remove_file(&probe);
    Ok(())
}

fn disk_space(path: &Path, pick: impl Fn(&sysinfo::Disk) -> u64) -> Option<u64> {
    let canonical = canonical(path).ok()?;
    Disks::new_with_refreshed_list()
        .iter()
        .filter(|disk| canonical.starts_with(strip_verbatim(disk.mount_point().to_path_buf())))
        // The longest matching mount point is the volume the path is really on.
        .max_by_key(|disk| disk.mount_point().components().count())
        .map(pick)
}

pub fn available_space(path: &Path) -> Option<u64> {
    disk_space(path, sysinfo::Disk::available_space)
}

pub fn total_space(path: &Path) -> Option<u64> {
    disk_space(path, sysinfo::Disk::total_space)
}

#[cfg(test)]
mod tests {
    use super::{
        classify_mount, detected_firmware, gvfs_label, is_protected_location, mount_label,
        probe_writable,
    };
    use std::{fs, path::PathBuf};

    fn fixture(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "gotek-devices-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn filesystem_roots_are_protected_on_every_platform() {
        assert!(is_protected_location("linux", "/", None));
        assert!(is_protected_location("macos", "/", None));
        assert!(is_protected_location("windows", r"C:\", Some(r"C:\Windows")));
        assert!(is_protected_location("windows", "D:/", Some(r"C:\Windows")));
    }

    #[test]
    fn windows_system_folders_are_protected_case_insensitively() {
        let system_root = Some(r"C:\Windows");
        assert!(is_protected_location(
            "windows",
            r"c:\windows\system32",
            system_root
        ));
        assert!(is_protected_location(
            "windows",
            r"C:\Program Files\GoTek",
            system_root
        ));
        assert!(is_protected_location(
            "windows",
            r"C:\ProgramData\cache",
            system_root
        ));
        // A second drive is a perfectly good GoTek destination.
        assert!(!is_protected_location("windows", r"D:\GOTEK", system_root));
    }

    #[test]
    fn macos_volumes_hold_mount_points_but_a_mounted_volume_is_writable() {
        assert!(is_protected_location("macos", "/Volumes", None));
        assert!(is_protected_location("macos", "/System/Volumes/Data", None));
        assert!(!is_protected_location("macos", "/Volumes/GOTEK", None));
    }

    #[test]
    fn linux_system_trees_are_protected_without_blocking_real_media() {
        assert!(is_protected_location("linux", "/boot/efi", None));
        assert!(is_protected_location("linux", "/usr", None));
        assert!(is_protected_location("linux", "/media", None));
        assert!(!is_protected_location("linux", "/media/pclarke/GOTEK", None));
        // Prefix matching must be component-aware.
        assert!(!is_protected_location("linux", "/usrdata/library", None));
    }

    #[test]
    fn mounts_are_classified_per_platform() {
        assert_eq!(
            classify_mount("linux", None, "/media/pclarke/GOTEK", "/dev/sdb1", "vfat", true),
            "removable"
        );
        assert_eq!(
            classify_mount("linux", None, "/", "/dev/nvme0n1p2", "ext4", false),
            "system"
        );
        // Overlay and container mounts have no block device behind them.
        assert_eq!(
            classify_mount("linux", None, "/var/lib/docker/overlay2/x", "overlay", "overlay", false),
            "system"
        );
        assert_eq!(
            classify_mount("linux", None, "/mnt/nas", "//nas/games", "cifs", false),
            "network"
        );
        assert_eq!(
            classify_mount("windows", Some(r"C:\Windows"), r"C:\", r"C:\", "NTFS", false),
            "system"
        );
        assert_eq!(
            classify_mount("windows", Some(r"C:\Windows"), r"E:\", r"E:\", "FAT32", true),
            "removable"
        );
        assert_eq!(
            classify_mount("macos", None, "/Volumes/GOTEK", "/dev/disk4s1", "msdos", true),
            "removable"
        );
        assert_eq!(
            classify_mount("macos", None, "/", "/dev/disk1s1", "apfs", false),
            "system"
        );
    }

    #[test]
    fn network_share_names_are_resolved_for_display() {
        assert_eq!(gvfs_label("smb-share:server=nas,share=games"), "games on nas");
        assert_eq!(gvfs_label("mtp:host=phone"), "mtp");
        assert_eq!(
            mount_label("/media/pclarke/GOTEK", "/dev/sdb1", "vfat"),
            "GOTEK"
        );
        assert_eq!(mount_label(r"C:\", r"C:\", "NTFS"), "C:");
    }

    #[test]
    fn firmware_is_detected_from_root_configuration_only() {
        let root = fixture("firmware");
        assert_eq!(detected_firmware(&root), None);

        fs::write(root.join("ff.cfg"), b"host = acorn").unwrap();
        assert_eq!(detected_firmware(&root), Some("flashfloppy".into()));

        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn gvfs_discovery_includes_desktop_network_mounts() {
        let root = fixture("gvfs");
        let share = root.join("smb-share:server=nas,share=games");
        fs::create_dir(&share).unwrap();
        fs::write(root.join("not-a-mount"), b"file").unwrap();

        let mounts = super::gvfs_targets(&root);

        assert_eq!(mounts.len(), 1);
        assert_eq!(mounts[0].path, share.to_string_lossy());
        assert_eq!(mounts[0].filesystem, "smb-share");
        assert_eq!(mounts[0].label, "games on nas");
        assert_eq!(mounts[0].kind, "network");
        assert!(!mounts[0].removable);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn writability_is_proved_by_writing_and_leaves_nothing_behind() {
        let root = fixture("writable");

        probe_writable(&root).unwrap();

        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        assert!(probe_writable(&root.join("missing")).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
