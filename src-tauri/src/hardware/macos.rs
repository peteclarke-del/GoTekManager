//! macOS device enumeration via `diskutil`.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]
//!
//!
//! `diskutil` speaks property lists, so its output is converted to JSON with
//! the stock `plutil` rather than by adding a plist dependency. The listing
//! gives the partition graph and `diskutil info` gives the identity, so both
//! are needed.

use super::{device_name, mounts_are_system, Partition, PhysicalDevice};
use crate::error::{Context, Result};
use serde::Deserialize;

const LIST_ARGS: [&str; 3] = ["list", "-plist", "physical"];
const PLUTIL_ARGS: [&str; 5] = ["-convert", "json", "-r", "-o", "-"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Listing {
    #[serde(default, rename = "AllDisksAndPartitions")]
    disks: Vec<Disk>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Disk {
    device_identifier: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    partitions: Vec<Slice>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Slice {
    device_identifier: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    volume_name: Option<String>,
    #[serde(default)]
    mount_point: Option<String>,
    #[serde(default)]
    volume_uuid: Option<String>,
}

/// The subset of `diskutil info -plist` that identifies a device.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Info {
    #[serde(default)]
    media_name: Option<String>,
    #[serde(default)]
    device_model: Option<String>,
    #[serde(default)]
    ejectable: Option<bool>,
    #[serde(default)]
    removable_media: Option<bool>,
    #[serde(default)]
    internal: Option<bool>,
    #[serde(default)]
    bus_protocol: Option<String>,
    #[serde(default)]
    io_registry_entry_name: Option<String>,
    #[serde(default)]
    device_identifier: Option<String>,
    /// macOS reports this for the volume carrying the running system.
    #[serde(default)]
    system_image: Option<bool>,
}

fn clean(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// Builds devices from one listing plus the per-disk identity documents.
pub fn build(listing_json: &str, info_json: &[(String, String)]) -> Result<Vec<PhysicalDevice>> {
    let listing: Listing =
        serde_json::from_str(listing_json).context("diskutil returned unexpected output")?;
    let infos = info_json
        .iter()
        .map(|(id, json)| {
            let info: Info = serde_json::from_str(json).unwrap_or_default();
            (id.clone(), info)
        })
        .collect::<Vec<_>>();

    Ok(listing
        .disks
        .into_iter()
        .map(|disk| {
            let node = format!("/dev/{}", disk.device_identifier);
            let info = infos
                .iter()
                .find(|(id, _)| *id == disk.device_identifier)
                .map(|(_, info)| info);

            let partitions = disk
                .partitions
                .into_iter()
                .map(|slice| Partition {
                    node: format!("/dev/{}", slice.device_identifier),
                    size_bytes: slice.size,
                    filesystem: clean(slice.content),
                    label: clean(slice.volume_name),
                    uuid: clean(slice.volume_uuid),
                    mount_points: clean(slice.mount_point).into_iter().collect(),
                })
                .collect::<Vec<_>>();

            let mounts = partitions
                .iter()
                .flat_map(|partition| partition.mount_points.clone())
                .collect::<Vec<_>>();
            let model = info.and_then(|info| {
                clean(info.device_model.clone())
                    .or_else(|| clean(info.media_name.clone()))
                    .or_else(|| clean(info.io_registry_entry_name.clone()))
            });
            // macOS exposes no stable serial through diskutil, so identity
            // leans on the model, the size, and the device node.
            let removable = info.is_some_and(|info| {
                info.removable_media.unwrap_or(false)
                    || info.ejectable.unwrap_or(false)
                    || !info.internal.unwrap_or(true)
            });

            PhysicalDevice {
                name: device_name(None, model.as_deref(), &node),
                system: info.is_some_and(|info| info.system_image.unwrap_or(false))
                    || mounts_are_system(&mounts)
                    // The data volume of the running system lives here.
                    || mounts.iter().any(|mount| mount.starts_with("/System/Volumes")),
                size_bytes: disk.size,
                removable,
                transport: info
                    .and_then(|info| clean(info.bus_protocol.clone()))
                    .map(|bus| bus.to_lowercase()),
                serial: None,
                vendor: None,
                model,
                partitions,
                node,
            }
        })
        .collect())
}

/// Runs `diskutil` and `plutil`, then builds the devices.
pub fn enumerate(run: impl Fn(&str, &[&str]) -> Result<String>) -> Result<Vec<PhysicalDevice>> {
    let listing = to_json(&run, &LIST_ARGS)?;
    let parsed: Listing =
        serde_json::from_str(&listing).context("diskutil returned unexpected output")?;

    let mut infos = Vec::new();
    for disk in &parsed.disks {
        let identifier = disk.device_identifier.clone();
        let json = to_json(&run, &["info", "-plist", &identifier]).unwrap_or_default();
        infos.push((identifier, json));
    }
    build(&listing, &infos)
}

/// `diskutil` writes a property list; `plutil` turns it into JSON.
///
/// The plist goes through a temporary file because the shared command runner
/// deliberately offers no standard-input pipe: every invocation is a fixed
/// argument array with nothing fed to it.
fn to_json(run: &impl Fn(&str, &[&str]) -> Result<String>, args: &[&str]) -> Result<String> {
    let plist = run("diskutil", args)?;
    let temporary = std::env::temp_dir().join(format!(
        "gotek-diskutil-{}-{}.plist",
        std::process::id(),
        args.join("-").replace(['/', ' '], "_")
    ));
    std::fs::write(&temporary, plist)?;

    let path = temporary.to_string_lossy().into_owned();
    let mut arguments = PLUTIL_ARGS.to_vec();
    arguments.push(&path);
    let json = run("plutil", &arguments);

    let _ = std::fs::remove_file(&temporary);
    json
}

#[cfg(test)]
mod tests {
    use super::build;

    const LISTING: &str = r#"{
      "AllDisksAndPartitions": [
        {"DeviceIdentifier":"disk0","Size":1000555581440,
         "Partitions":[
           {"DeviceIdentifier":"disk0s1","Size":314572800,"Content":"EFI",
            "VolumeName":"EFI","MountPoint":null},
           {"DeviceIdentifier":"disk0s2","Size":1000240742400,"Content":"Apple_APFS",
            "VolumeName":"Macintosh HD","MountPoint":"/System/Volumes/Data"}]},
        {"DeviceIdentifier":"disk4","Size":8004999168,
         "Partitions":[
           {"DeviceIdentifier":"disk4s1","Size":8003950592,"Content":"DOS_FAT_32",
            "VolumeName":"GOTEK","MountPoint":"/Volumes/GOTEK","VolumeUUID":"5E7A-1B2C"}]}
      ]}"#;

    fn infos() -> Vec<(String, String)> {
        vec![
            (
                "disk0".into(),
                r#"{"MediaName":"APPLE SSD AP1024","Internal":true,"Ejectable":false,
                    "RemovableMedia":false,"BusProtocol":"PCI-Express","SystemImage":true}"#
                    .into(),
            ),
            (
                "disk4".into(),
                r#"{"MediaName":"Cruzer Blade","DeviceModel":"Cruzer Blade","Internal":false,
                    "Ejectable":true,"RemovableMedia":true,"BusProtocol":"USB"}"#
                    .into(),
            ),
        ]
    }

    #[test]
    fn a_usb_stick_is_identified_and_offered() {
        let devices = build(LISTING, &infos()).unwrap();
        let stick = devices.iter().find(|d| d.node == "/dev/disk4").unwrap();

        assert_eq!(stick.name, "Cruzer Blade");
        assert_eq!(stick.transport.as_deref(), Some("usb"));
        assert!(stick.removable);
        assert!(!stick.system);
        assert!(stick.is_candidate());
        assert_eq!(stick.partitions[0].label.as_deref(), Some("GOTEK"));
        assert_eq!(
            stick.partitions[0].mount_points,
            vec!["/Volumes/GOTEK".to_string()]
        );
    }

    #[test]
    fn the_internal_disk_is_refused() {
        let devices = build(LISTING, &infos()).unwrap();
        let internal = devices.iter().find(|d| d.node == "/dev/disk0").unwrap();

        // Both the SystemImage flag and the data volume's mount point say so.
        assert!(internal.system);
        assert!(!internal.is_candidate());
        assert!(!internal.removable);
    }

    #[test]
    fn missing_identity_documents_do_not_lose_the_device() {
        let devices = build(LISTING, &[]).unwrap();

        assert_eq!(devices.len(), 2);
        // With nothing to name it by, the node stands in.
        assert_eq!(devices[1].name, "/dev/disk4");
        // And with no evidence it is removable, it is not assumed to be.
        assert!(!devices[1].removable);
        // The data volume mount still marks the internal disk as the system.
        assert!(devices[0].system);
    }
}
