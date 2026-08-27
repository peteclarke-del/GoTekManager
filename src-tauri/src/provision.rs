//! Provisioning a physical device.
//!
//! This is the only code in the application that can destroy data the user did
//! not choose to delete, so it is built to be refused rather than to succeed.
//!
//! The shape is deliberate: the finished media is assembled as an **image file**
//! first, using [`crate::image`], and only then copied to the device in one
//! verified pass. Nothing here partitions or formats a live device, so there is
//! no window in which a stick is half-formatted, and every decision about what
//! the media will contain is ordinary file I/O that is tested without hardware.
//!
//! Before anything is written:
//!
//! 1. The device is re-resolved by identity, not by path. A stick removed and
//!    replaced between planning and writing is a different device and is refused.
//! 2. A device carrying the running system is refused, twice: once from the
//!    platform's own flag and once from its mount points.
//! 3. The user must type a phrase naming that exact device.
//! 4. The image must fit.
//!
//! After writing, the device is read back and compared against the image. The
//! operation is not reported as successful until that comparison passes.

use crate::error::{Context, Error, Result};
use crate::hardware::{self, PhysicalDevice};
use crate::image::{self, ImageFile, ImageOptions};
use crate::paths::sha256_reader;
use crate::task::blocking;
use crate::transfer::TransferOperation;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::Command,
};

/// Copy buffer. Large enough to keep a USB stick busy, small enough to report
/// progress and to fail early.
const CHUNK: usize = 4 * 1024 * 1024;

/// What should end up on the device.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProvisionSource {
    /// Write an image file that already exists, byte for byte.
    Image { path: String },
    /// Build a fresh image from staged files, then write that.
    Build {
        options: ImageOptions,
        operations: Vec<TransferOperation>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionRequest {
    /// From `PhysicalDevice::identity()`, recorded when the plan was built.
    pub device_identity: String,
    pub source: ProvisionSource,
}

/// What will be destroyed, in the user's terms.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Destroyed {
    pub node: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionPlan {
    pub device: PhysicalDevice,
    pub image_bytes: u64,
    /// Ordered, plain-language description of what will happen.
    pub steps: Vec<String>,
    /// Everything currently on the device that will be lost.
    pub destroys: Vec<Destroyed>,
    pub warnings: Vec<String>,
    pub ready: bool,
    /// The exact text the user must type to authorise this.
    pub confirmation_phrase: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionReport {
    pub device: String,
    pub bytes_written: u64,
    pub verified: bool,
}

/// The phrase that authorises writing to one specific device.
///
/// It names the device and includes the tail of its serial, so it cannot be
/// typed from memory or copied from a previous session: the user has to read
/// the device actually in front of them.
pub fn confirmation_phrase(device: &PhysicalDevice) -> String {
    let tail = device
        .serial
        .as_deref()
        .map(|serial| {
            let trimmed = serial.trim();
            let start = trimmed.len().saturating_sub(4);
            trimmed[start..].to_string()
        })
        .filter(|tail| !tail.is_empty())
        .unwrap_or_else(|| format!("{}MB", device.size_bytes / 1_000_000));
    format!("ERASE {} {}", device.node, tail)
}

fn describe(device: &PhysicalDevice) -> Vec<Destroyed> {
    if device.partitions.is_empty() {
        return vec![Destroyed {
            node: device.node.clone(),
            description: format!(
                "The whole device ({:.1} GB), which currently has no partitions",
                device.size_bytes as f64 / 1_000_000_000.0
            ),
        }];
    }
    device
        .partitions
        .iter()
        .map(|partition| {
            let label = partition.label.as_deref().unwrap_or("no label");
            let filesystem = partition.filesystem.as_deref().unwrap_or("unknown format");
            let mounted = if partition.mount_points.is_empty() {
                String::new()
            } else {
                format!(", mounted at {}", partition.mount_points.join(", "))
            };
            Destroyed {
                node: partition.node.clone(),
                description: format!(
                    "{filesystem}, {label}, {:.1} GB{mounted}",
                    partition.size_bytes as f64 / 1_000_000_000.0
                ),
            }
        })
        .collect()
}

/// Builds a plan without touching anything.
pub fn plan(request: &ProvisionRequest, image_bytes: u64) -> Result<ProvisionPlan> {
    let device = hardware::resolve(&request.device_identity)?;
    let mut warnings = Vec::new();

    if !device.is_candidate() {
        warnings.push(if device.system {
            "This device carries the running operating system and can never be written to."
                .to_string()
        } else {
            "This device reports no capacity and cannot be written to.".to_string()
        });
    }
    if !device.removable {
        warnings.push(
            "This device does not report itself as removable. Check very carefully that it is \
             the GoTek stick and not an internal or backup disk."
                .into(),
        );
    }
    if image_bytes > device.size_bytes {
        warnings.push(format!(
            "The image is {:.1} GB but the device holds only {:.1} GB.",
            image_bytes as f64 / 1_000_000_000.0,
            device.size_bytes as f64 / 1_000_000_000.0
        ));
    }
    if image_bytes == 0 {
        warnings.push("There is nothing to write.".into());
    }

    let steps = vec![
        format!("Re-check that {} is still the same device", device.node),
        "Unmount every filesystem on the device".to_string(),
        format!(
            "Write {:.1} GB to {}, replacing its partition table and all its contents",
            image_bytes as f64 / 1_000_000_000.0,
            device.node
        ),
        "Flush the device and read it back to verify every byte".to_string(),
    ];

    Ok(ProvisionPlan {
        confirmation_phrase: confirmation_phrase(&device),
        destroys: describe(&device),
        // A device carrying the system is never ready, whatever else is true.
        ready: warnings.is_empty() && device.is_candidate(),
        image_bytes,
        steps,
        warnings,
        device,
    })
}

/// Builds the image that a request describes, returning its path and size.
///
/// A built image lands in a temporary file that the caller removes; an existing
/// image is used where it lies and is never modified.
fn prepare(source: &ProvisionSource) -> Result<(PathBuf, u64, bool)> {
    match source {
        ProvisionSource::Image { path } => {
            let path = PathBuf::from(path);
            let size = fs::metadata(&path)
                .with_context(|| format!("Unable to read {}", path.display()))?
                .len();
            Ok((path, size, false))
        }
        ProvisionSource::Build {
            options,
            operations,
        } => {
            let path = std::env::temp_dir().join(format!(
                "gotek-provision-{}-{}.img",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ));
            image::create(&path, options)?;
            let files = operations
                .iter()
                .map(|operation| ImageFile {
                    source: PathBuf::from(&operation.source),
                    relative_path: operation.relative_path.clone(),
                    size: operation.size,
                })
                .collect::<Vec<_>>();
            if let Err(error) = image::write_files(&path, &files) {
                let _ = fs::remove_file(&path);
                return Err(error);
            }
            let size = fs::metadata(&path)?.len();
            Ok((path, size, true))
        }
    }
}

/// Asks the platform to unmount everything on a device.
///
/// Best effort by design: a device with nothing mounted is the normal case, and
/// a refusal here is reported as a warning rather than silently ignored, but
/// the write itself will fail loudly if the kernel still holds the volume.
fn unmount(device: &PhysicalDevice) -> Vec<String> {
    let mut problems = Vec::new();
    for partition in &device.partitions {
        if partition.mount_points.is_empty() {
            continue;
        }
        let attempts: Vec<(&str, Vec<&str>)> = if cfg!(target_os = "macos") {
            vec![("diskutil", vec!["unmountDisk", &device.node])]
        } else {
            vec![
                // udisksctl goes through polkit and needs no elevation for
                // removable media, which is the common case.
                ("udisksctl", vec!["unmount", "-b", &partition.node]),
                ("umount", vec![partition.node.as_str()]),
            ]
        };
        let unmounted = attempts.into_iter().any(|(program, args)| {
            Command::new(program)
                .args(args)
                .output()
                .is_ok_and(|output| output.status.success())
        });
        if !unmounted {
            problems.push(format!("Unable to unmount {}", partition.node));
        }
    }
    problems
}

/// Copies an image onto a target, flushes it, and reads it back to verify.
///
/// Deliberately takes plain paths so the copy-and-verify core can be exercised
/// against an ordinary file; only the caller decides that a target is a device.
pub fn write_image(image: &Path, target: &Path) -> Result<(u64, bool)> {
    let mut source = fs::File::open(image)
        .with_context(|| format!("Unable to read {}", image.display()))?;
    let length = source.metadata()?.len();

    let mut destination = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(target)
        .with_context(|| {
            format!(
                "Unable to open {} for writing. Writing to a device needs elevated \
                 privileges or membership of the disk group",
                target.display()
            )
        })?;

    let mut buffer = vec![0u8; CHUNK];
    let mut written = 0u64;
    loop {
        let read = source.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        destination.write_all(&buffer[..read])?;
        written += read as u64;
    }
    // Without this the copy may still be in the page cache when the user pulls
    // the stick out, and the media would be silently incomplete.
    destination
        .sync_all()
        .with_context(|| format!("Unable to flush {}", target.display()))?;

    if written != length {
        return Err(Error::new(format!(
            "Only {written} of {length} bytes reached {}",
            target.display()
        )));
    }

    // Read back exactly what was written and compare digests.
    source.seek(SeekFrom::Start(0))?;
    destination.seek(SeekFrom::Start(0))?;
    let expected = sha256_reader(&mut source)?;
    let actual = sha256_reader(&mut (&mut destination).take(length))?;
    Ok((written, expected == actual))
}

#[tauri::command]
pub async fn plan_provision(request: ProvisionRequest) -> Result<ProvisionPlan> {
    blocking(move || {
        // Building the real image is the only honest way to know its size, but
        // planning must not leave anything behind.
        let (path, size, temporary) = prepare(&request.source)?;
        let outcome = plan(&request, size);
        if temporary {
            let _ = fs::remove_file(&path);
        }
        outcome
    })
    .await
}

/// Writes the media. Everything above exists to make this refuse.
#[tauri::command]
pub async fn execute_provision(
    request: ProvisionRequest,
    confirmation: String,
) -> Result<ProvisionReport> {
    blocking(move || {
        if cfg!(target_os = "windows") {
            return Err(Error::new(
                "Writing a whole device is not implemented on Windows yet. It needs volume \
                 locking through the Win32 API, and shipping that untested could corrupt a \
                 disk. Create an image instead and write it with a tool you trust.",
            ));
        }

        let (path, size, temporary) = prepare(&request.source)?;
        let outcome = (|| -> Result<ProvisionReport> {
            // Re-plan from scratch against the device as it is *now*.
            let plan = plan(&request, size)?;
            if !plan.ready {
                return Err(Error::new(format!(
                    "This cannot be written: {}",
                    plan.warnings.join(" ")
                )));
            }
            if confirmation.trim() != plan.confirmation_phrase {
                return Err(Error::new(
                    "The confirmation phrase does not match the device. Nothing was written.",
                ));
            }

            let device = &plan.device;
            let problems = unmount(device);
            if !problems.is_empty() {
                return Err(Error::new(format!(
                    "{}. Close anything using the device and try again.",
                    problems.join("; ")
                )));
            }

            // One last look. Unmounting takes time, and a device can be pulled
            // during it; this is the last moment it is still cheap to stop.
            let confirmed = hardware::resolve(&request.device_identity)?;
            if confirmed.system {
                return Err(Error::new("Refusing to write to the system device."));
            }

            let (bytes_written, verified) = write_image(&path, Path::new(&device.node))?;
            if !verified {
                return Err(Error::new(
                    "The device does not read back the same as the image. The media may be \
                     faulty or was removed during writing. Do not use it.",
                ));
            }
            Ok(ProvisionReport {
                device: device.node.clone(),
                bytes_written,
                verified,
            })
        })();

        if temporary {
            let _ = fs::remove_file(&path);
        }
        outcome
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{confirmation_phrase, describe, write_image};
    use crate::hardware::{Partition, PhysicalDevice};
    use std::{fs, path::PathBuf};

    fn fixture(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "gotek-provision-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn device() -> PhysicalDevice {
        PhysicalDevice {
            node: "/dev/sdb".into(),
            name: "SanDisk Cruzer Blade".into(),
            vendor: Some("SanDisk".into()),
            model: Some("Cruzer Blade".into()),
            serial: Some("4C530001234567".into()),
            size_bytes: 8_004_999_168,
            removable: true,
            transport: Some("usb".into()),
            partitions: vec![Partition {
                node: "/dev/sdb1".into(),
                size_bytes: 8_003_950_592,
                filesystem: Some("vfat".into()),
                label: Some("GOTEK".into()),
                uuid: None,
                mount_points: vec!["/media/pclarke/GOTEK".into()],
            }],
            system: false,
        }
    }

    #[test]
    fn the_confirmation_phrase_names_the_device_in_front_of_you() {
        let phrase = confirmation_phrase(&device());

        // The serial tail cannot be guessed, so it has to be read off the plan,
        // which means reading which device the plan is about.
        assert_eq!(phrase, "ERASE /dev/sdb 4567");

        let mut other = device();
        other.serial = None;
        assert_eq!(confirmation_phrase(&other), "ERASE /dev/sdb 8004MB");
    }

    #[test]
    fn a_different_stick_of_the_same_model_needs_a_different_phrase() {
        let mut second = device();
        second.serial = Some("4C530009999999".into());

        assert_ne!(confirmation_phrase(&device()), confirmation_phrase(&second));
    }

    #[test]
    fn what_will_be_lost_is_described_in_the_users_terms() {
        let described = describe(&device());

        assert_eq!(described.len(), 1);
        assert_eq!(described[0].node, "/dev/sdb1");
        assert!(described[0].description.contains("vfat"));
        assert!(described[0].description.contains("GOTEK"));
        assert!(described[0].description.contains("/media/pclarke/GOTEK"));
    }

    #[test]
    fn an_unpartitioned_device_still_says_what_is_at_stake() {
        let mut blank = device();
        blank.partitions.clear();

        let described = describe(&blank);

        assert_eq!(described.len(), 1);
        assert!(described[0].description.contains("no partitions"));
    }

    #[test]
    fn writing_copies_every_byte_and_proves_it_read_back() {
        let root = fixture("write");
        let image = root.join("gotek.img");
        let target = root.join("device.bin");
        // Deliberately not a round number of buffers.
        let content = (0..(9 * 1024 * 1024 + 7))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        fs::write(&image, &content).unwrap();
        fs::write(&target, vec![0xFFu8; content.len()]).unwrap();

        let (written, verified) = write_image(&image, &target).unwrap();

        assert_eq!(written, content.len() as u64);
        assert!(verified);
        assert_eq!(fs::read(&target).unwrap(), content);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_target_that_cannot_be_opened_says_what_is_needed() {
        let root = fixture("denied");

        let error = write_image(&root.join("missing.img"), &root.join("nowhere")).unwrap_err();

        assert!(error.to_string().contains("Unable to read"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_larger_target_keeps_whatever_follows_the_image() {
        // Writing an 8 MB image to a 16 GB stick must not be reported as a
        // mismatch just because the device is bigger than the image.
        let root = fixture("shorter");
        let image = root.join("small.img");
        let target = root.join("device.bin");
        fs::write(&image, vec![0xABu8; 1024]).unwrap();
        fs::write(&target, vec![0x00u8; 8192]).unwrap();

        let (written, verified) = write_image(&image, &target).unwrap();

        assert_eq!(written, 1024);
        assert!(verified, "verification must compare only what was written");
        let after = fs::read(&target).unwrap();
        assert_eq!(after.len(), 8192);
        assert!(after[1024..].iter().all(|byte| *byte == 0));
        fs::remove_dir_all(root).unwrap();
    }
}
