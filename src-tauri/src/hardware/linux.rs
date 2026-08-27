//! Linux device enumeration via `lsblk`.
//!
//! `lsblk --json` is used rather than `/proc/mounts` because only it reports
//! the vendor, model, serial, and partition graph that a destructive operation
//! must be addressed by.

use super::{device_name, mounts_are_system, Partition, PhysicalDevice};
use crate::error::{Context, Result};
use serde::Deserialize;

pub const LSBLK_ARGS: [&str; 4] = [
    "--json",
    "--bytes",
    "--output",
    "NAME,PATH,SIZE,TYPE,RM,ROTA,TRAN,VENDOR,MODEL,SERIAL,FSTYPE,LABEL,UUID,MOUNTPOINTS",
];

#[derive(Debug, Deserialize)]
struct Output {
    blockdevices: Vec<Node>,
}

#[derive(Debug, Deserialize)]
struct Node {
    #[serde(default)]
    path: Option<String>,
    name: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    rm: Option<bool>,
    #[serde(default)]
    tran: Option<String>,
    #[serde(default)]
    vendor: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    serial: Option<String>,
    #[serde(default)]
    fstype: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    uuid: Option<String>,
    /// May contain nulls for an unmounted device.
    #[serde(default)]
    mountpoints: Vec<Option<String>>,
    #[serde(default)]
    children: Vec<Node>,
}

impl Node {
    fn node_path(&self) -> String {
        self.path.clone().unwrap_or_else(|| format!("/dev/{}", self.name))
    }

    /// Mount points of this node and everything layered on it.
    ///
    /// Encryption and LVM put the filesystem several levels below the
    /// partition, so a shallow look would miss that a disk holds the root
    /// filesystem and wrongly offer it as a target.
    fn all_mount_points(&self) -> Vec<String> {
        let mut mounts = self
            .mountpoints
            .iter()
            .flatten()
            .cloned()
            .collect::<Vec<_>>();
        for child in &self.children {
            mounts.extend(child.all_mount_points());
        }
        mounts
    }

    fn partitions(&self) -> Vec<Partition> {
        let mut partitions = Vec::new();
        for child in &self.children {
            let kind = child.kind.as_deref().unwrap_or_default();
            if kind == "part" {
                partitions.push(Partition {
                    node: child.node_path(),
                    size_bytes: child.size.unwrap_or_default(),
                    // The partition's own type. For an encrypted or LVM member
                    // that is the container type, not the filesystem inside it,
                    // which is the honest thing to show for a partition.
                    filesystem: child.fstype.clone().or_else(|| {
                        child.children.first().and_then(|inner| inner.fstype.clone())
                    }),
                    label: child.label.clone(),
                    uuid: child.uuid.clone(),
                    mount_points: child.all_mount_points(),
                });
            } else {
                partitions.extend(child.partitions());
            }
        }
        partitions
    }
}

/// Turns `lsblk --json` output into devices.
///
/// Only whole disks are returned. Loop devices back Snap packages and disk
/// images, and optical drives cannot be provisioned, so neither is a candidate.
pub fn parse(json: &str) -> Result<Vec<PhysicalDevice>> {
    let output: Output = serde_json::from_str(json).context("lsblk returned unexpected output")?;
    Ok(output
        .blockdevices
        .into_iter()
        .filter(|node| node.kind.as_deref() == Some("disk"))
        .map(|node| {
            let mounts = node.all_mount_points();
            let vendor = node.vendor.clone().filter(|value| !value.trim().is_empty());
            let model = node.model.clone().filter(|value| !value.trim().is_empty());
            let path = node.node_path();
            PhysicalDevice {
                name: device_name(vendor.as_deref(), model.as_deref(), &path),
                system: mounts_are_system(&mounts),
                partitions: node.partitions(),
                size_bytes: node.size.unwrap_or_default(),
                removable: node.rm.unwrap_or(false),
                transport: node.tran.clone().filter(|value| !value.trim().is_empty()),
                serial: node.serial.clone().filter(|value| !value.trim().is_empty()),
                vendor: vendor.map(|value| value.trim().to_string()),
                model: model.map(|value| value.trim().to_string()),
                node: path,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::parse;

    /// Trimmed from real `lsblk` output: a system NVMe disk, a USB stick, and a
    /// Snap loop device.
    const FIXTURE: &str = r#"{
      "blockdevices": [
        {"name":"loop0","path":"/dev/loop0","size":1632018432,"type":"loop","rm":false,
         "tran":null,"vendor":null,"model":null,"serial":null,"fstype":"squashfs",
         "label":null,"uuid":null,"mountpoints":["/snap/android-studio/236"]},
        {"name":"nvme0n1","path":"/dev/nvme0n1","size":1000204886016,"type":"disk","rm":false,
         "tran":"nvme","vendor":null,"model":"Samsung SSD 980 PRO","serial":"S5GXNF0R",
         "fstype":null,"label":null,"uuid":null,"mountpoints":[null],
         "children":[
           {"name":"nvme0n1p1","path":"/dev/nvme0n1p1","size":536870912,"type":"part","rm":false,
            "fstype":"vfat","label":"EFI","uuid":"1234-ABCD","mountpoints":["/boot/efi"]},
           {"name":"nvme0n1p2","path":"/dev/nvme0n1p2","size":999667990528,"type":"part","rm":false,
            "fstype":"crypto_LUKS","label":null,"uuid":"aaa","mountpoints":[null],
            "children":[
              {"name":"root","path":"/dev/mapper/root","size":999667990528,"type":"crypt",
               "fstype":"ext4","label":null,"uuid":"bbb","mountpoints":["/"]}
            ]}
         ]},
        {"name":"sdb","path":"/dev/sdb","size":8004999168,"type":"disk","rm":true,
         "tran":"usb","vendor":"SanDisk ","model":"Cruzer Blade   ","serial":"4C530001",
         "fstype":null,"label":null,"uuid":null,"mountpoints":[null],
         "children":[
           {"name":"sdb1","path":"/dev/sdb1","size":8003950592,"type":"part","rm":true,
            "fstype":"vfat","label":"GOTEK","uuid":"5E7A-1B2C",
            "mountpoints":["/media/pclarke/GOTEK"]}
         ]}
      ]}"#;

    #[test]
    fn only_whole_disks_are_returned() {
        let devices = parse(FIXTURE).unwrap();

        assert_eq!(
            devices.iter().map(|d| d.node.as_str()).collect::<Vec<_>>(),
            vec!["/dev/nvme0n1", "/dev/sdb"]
        );
    }

    #[test]
    fn a_usb_stick_is_described_well_enough_to_confirm_by_eye() {
        let devices = parse(FIXTURE).unwrap();
        let stick = devices.iter().find(|d| d.node == "/dev/sdb").unwrap();

        assert_eq!(stick.name, "SanDisk Cruzer Blade");
        assert_eq!(stick.serial.as_deref(), Some("4C530001"));
        assert_eq!(stick.transport.as_deref(), Some("usb"));
        assert_eq!(stick.size_bytes, 8_004_999_168);
        assert!(stick.removable);
        assert!(!stick.system);
        assert!(stick.is_candidate());

        assert_eq!(stick.partitions.len(), 1);
        let partition = &stick.partitions[0];
        assert_eq!(partition.node, "/dev/sdb1");
        assert_eq!(partition.filesystem.as_deref(), Some("vfat"));
        assert_eq!(partition.label.as_deref(), Some("GOTEK"));
        assert_eq!(partition.mount_points, vec!["/media/pclarke/GOTEK".to_string()]);
    }

    #[test]
    fn the_root_filesystem_is_found_through_encryption() {
        let devices = parse(FIXTURE).unwrap();
        let disk = devices.iter().find(|d| d.node == "/dev/nvme0n1").unwrap();

        // The root filesystem sits on a LUKS mapping two levels down. Missing
        // that would offer the system disk as a target for formatting.
        assert!(disk.system, "the system disk must be recognised through LUKS");
        assert!(!disk.is_candidate());

        let encrypted = disk
            .partitions
            .iter()
            .find(|p| p.node == "/dev/nvme0n1p2")
            .unwrap();
        // The mount point is what matters: it is found two levels down.
        assert_eq!(encrypted.mount_points, vec!["/".to_string()]);
        // The partition itself is the LUKS container, and says so.
        assert_eq!(encrypted.filesystem.as_deref(), Some("crypto_LUKS"));
    }

    #[test]
    fn unexpected_output_is_an_error_rather_than_an_empty_list() {
        // An empty list would read as "no devices", which is indistinguishable
        // from "nothing is plugged in" and would hide a broken environment.
        assert!(parse("not json").is_err());
        assert!(parse(r#"{"blockdevices":[]}"#).unwrap().is_empty());
    }
}
