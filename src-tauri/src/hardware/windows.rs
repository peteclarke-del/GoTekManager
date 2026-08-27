//! Windows device enumeration via PowerShell's storage cmdlets.
#![cfg_attr(not(target_os = "windows"), allow(dead_code))]
//!
//!
//! `Get-Disk` alone does not report volumes, and `Get-Volume` alone does not
//! report which disk a volume sits on, so one script joins them and emits a
//! single JSON document. Parsing that document is a pure function, which is how
//! this path is tested from a Linux build host.

use super::{device_name, mounts_are_system, Partition, PhysicalDevice};
use crate::error::{Context, Result};
use serde::Deserialize;

/// Emits one array of disks, each with its partitions and their volumes.
///
/// `ConvertTo-Json` collapses a single-element array to an object, so the
/// result is always wrapped in `@(...)` and depth is set high enough to keep
/// the nested volumes intact.
const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$disks = Get-Disk | ForEach-Object {
  $disk = $_
  $parts = @(Get-Partition -DiskNumber $disk.Number -ErrorAction SilentlyContinue | ForEach-Object {
    $part = $_
    $vol = Get-Volume -Partition $part -ErrorAction SilentlyContinue
    [pscustomobject]@{
      PartitionNumber = $part.PartitionNumber
      DriveLetter     = if ($part.DriveLetter) { "$($part.DriveLetter):" } else { $null }
      Size            = [uint64]$part.Size
      FileSystem      = $vol.FileSystem
      Label           = $vol.FileSystemLabel
      UniqueId        = $part.UniqueId
    }
  })
  [pscustomobject]@{
    Number       = $disk.Number
    FriendlyName = $disk.FriendlyName
    Manufacturer = $disk.Manufacturer
    Model        = $disk.Model
    SerialNumber = $disk.SerialNumber
    Size         = [uint64]$disk.Size
    BusType      = "$($disk.BusType)"
    IsBoot       = [bool]$disk.IsBoot
    IsSystem     = [bool]$disk.IsSystem
    Partitions   = $parts
  }
}
@($disks) | ConvertTo-Json -Depth 6 -Compress
"#;

pub const POWERSHELL_ARGS: [&str; 5] = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    SCRIPT,
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Disk {
    number: u32,
    #[serde(default)]
    friendly_name: Option<String>,
    #[serde(default)]
    manufacturer: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    serial_number: Option<String>,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    bus_type: Option<String>,
    #[serde(default)]
    is_boot: bool,
    #[serde(default)]
    is_system: bool,
    #[serde(default)]
    partitions: Vec<Volume>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Volume {
    #[serde(default)]
    partition_number: u32,
    #[serde(default)]
    drive_letter: Option<String>,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    file_system: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    unique_id: Option<String>,
}

fn clean(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

pub fn parse(json: &str) -> Result<Vec<PhysicalDevice>> {
    let text = json.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    // Tolerate a lone object in case the array wrapper is ever lost.
    let disks: Vec<Disk> = if text.starts_with('[') {
        serde_json::from_str(text)
    } else {
        serde_json::from_str::<Disk>(text).map(|disk| vec![disk])
    }
    .context("The Windows storage query returned unexpected output")?;

    Ok(disks
        .into_iter()
        .map(|disk| {
            let node = format!(r"\\.\PHYSICALDRIVE{}", disk.number);
            let partitions = disk
                .partitions
                .into_iter()
                .map(|volume| {
                    let letter = clean(volume.drive_letter);
                    Partition {
                        node: letter.clone().unwrap_or_else(|| {
                            format!("{node}\\Partition{}", volume.partition_number)
                        }),
                        size_bytes: volume.size,
                        filesystem: clean(volume.file_system),
                        label: clean(volume.label),
                        uuid: clean(volume.unique_id),
                        mount_points: letter.into_iter().collect(),
                    }
                })
                .collect::<Vec<_>>();

            let mounts = partitions
                .iter()
                .flat_map(|partition| partition.mount_points.clone())
                .collect::<Vec<_>>();
            let vendor = clean(disk.manufacturer);
            let model = clean(disk.model).or_else(|| clean(disk.friendly_name.clone()));

            PhysicalDevice {
                name: device_name(vendor.as_deref(), model.as_deref(), &node),
                // Windows states outright whether a disk carries the system,
                // which is more reliable than inspecting drive letters.
                system: disk.is_boot || disk.is_system || mounts_are_system(&mounts),
                size_bytes: disk.size,
                removable: disk
                    .bus_type
                    .as_deref()
                    .is_some_and(|bus| bus.eq_ignore_ascii_case("usb")),
                transport: clean(disk.bus_type).map(|bus| bus.to_lowercase()),
                serial: clean(disk.serial_number),
                vendor,
                model,
                partitions,
                node,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::parse;

    const FIXTURE: &str = r#"[
      {"Number":0,"FriendlyName":"Samsung SSD 980","Manufacturer":null,
       "Model":"Samsung SSD 980 PRO","SerialNumber":"S5GXNF0R","Size":1000204886016,
       "BusType":"NVMe","IsBoot":true,"IsSystem":true,
       "Partitions":[
         {"PartitionNumber":1,"DriveLetter":"C:","Size":999667990528,"FileSystem":"NTFS",
          "Label":"Windows","UniqueId":"{abc}"}]},
      {"Number":1,"FriendlyName":"SanDisk Cruzer Blade","Manufacturer":"SanDisk",
       "Model":"Cruzer Blade","SerialNumber":"4C530001","Size":8004999168,
       "BusType":"USB","IsBoot":false,"IsSystem":false,
       "Partitions":[
         {"PartitionNumber":1,"DriveLetter":"E:","Size":8003950592,"FileSystem":"FAT32",
          "Label":"GOTEK","UniqueId":"{def}"}]}
    ]"#;

    #[test]
    fn disks_are_addressed_by_their_physical_drive_path() {
        let devices = parse(FIXTURE).unwrap();

        assert_eq!(devices.len(), 2);
        assert_eq!(devices[1].node, r"\\.\PHYSICALDRIVE1");
        assert_eq!(devices[1].name, "SanDisk Cruzer Blade");
        assert_eq!(devices[1].serial.as_deref(), Some("4C530001"));
        assert_eq!(devices[1].transport.as_deref(), Some("usb"));
        assert!(devices[1].removable);
        assert!(devices[1].is_candidate());
    }

    #[test]
    fn the_boot_disk_is_refused_even_though_it_is_not_removable() {
        let devices = parse(FIXTURE).unwrap();

        assert!(devices[0].system);
        assert!(!devices[0].is_candidate());
    }

    #[test]
    fn drive_letters_become_both_the_node_and_the_mount_point() {
        let devices = parse(FIXTURE).unwrap();
        let partition = &devices[1].partitions[0];

        assert_eq!(partition.node, "E:");
        assert_eq!(partition.mount_points, vec!["E:".to_string()]);
        assert_eq!(partition.label.as_deref(), Some("GOTEK"));
    }

    #[test]
    fn a_single_disk_collapsed_to_an_object_is_still_understood() {
        // ConvertTo-Json unwraps one-element arrays, which would otherwise make
        // a machine with exactly one disk fail to enumerate at all.
        let single = r#"{"Number":1,"FriendlyName":"Cruzer","Model":"Cruzer",
          "SerialNumber":"X","Size":100,"BusType":"USB","IsBoot":false,"IsSystem":false,
          "Partitions":[]}"#;

        let devices = parse(single).unwrap();

        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].node, r"\\.\PHYSICALDRIVE1");
    }

    #[test]
    fn an_unpartitioned_disk_is_still_listed() {
        let blank = r#"[{"Number":2,"FriendlyName":"Blank","Model":"Blank","SerialNumber":"Y",
          "Size":4000000000,"BusType":"USB","IsBoot":false,"IsSystem":false,"Partitions":[]}]"#;

        let devices = parse(blank).unwrap();

        assert!(devices[0].partitions.is_empty());
        assert!(devices[0].is_candidate());
    }
}
