//! Creating, reading, and unpacking GoTek USB filesystem images.
//!
//! An image is built as a file first and only afterwards written to a device.
//! That is deliberate: every step that decides *what* the media will contain is
//! ordinary file I/O that can be tested without a device, without elevated
//! privileges, and without the chance of destroying anything. Writing the
//! finished image to a stick is then a single, verifiable copy.
//!
//! It also means one code path serves three of the original requirements:
//! creating an image from a folder, unpacking an image into a folder, and
//! provisioning a physical device.

pub mod mbr;
mod region;

use crate::error::{Context, Error, Result};
use crate::paths::{extension_of, safe_relative_path, sort_entries, to_posix, FileEntry};
use fatfs::{FatType, FileSystem, FormatVolumeOptions, FsOptions};
use mbr::{Region, SECTOR, TYPE_FAT16_LBA, TYPE_FAT32_LBA};
use region::RegionIo;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

/// Below this, FAT32 wastes most of the volume on its own structures.
const FAT32_MINIMUM: u64 = 48 * 1024 * 1024;
/// Refuses to build anything implausible for a GoTek stick.
pub const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MIN_IMAGE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FatKind {
    Fat16,
    Fat32,
    /// Chosen from the volume size.
    Auto,
}

impl FatKind {
    fn resolve(self, bytes: u64) -> FatType {
        match self {
            FatKind::Fat16 => FatType::Fat16,
            FatKind::Fat32 => FatType::Fat32,
            FatKind::Auto if bytes >= FAT32_MINIMUM => FatType::Fat32,
            FatKind::Auto => FatType::Fat16,
        }
    }
}

fn partition_type(fat: FatType) -> u8 {
    match fat {
        FatType::Fat32 => TYPE_FAT32_LBA,
        _ => TYPE_FAT16_LBA,
    }
}

/// FAT stores the label as eleven padded, upper-case bytes.
fn volume_label(label: &str) -> [u8; 11] {
    let mut bytes = *b"           ";
    for (slot, character) in bytes.iter_mut().zip(
        label
            .chars()
            .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
            .map(|character| character.to_ascii_uppercase() as u8),
    ) {
        *slot = character;
    }
    bytes
}

/// Where the filesystem lives inside an image file.
pub fn locate(file: &mut fs::File) -> Result<Region> {
    let length = file.metadata()?.len();
    let mut header = [0u8; SECTOR as usize];
    file.seek(SeekFrom::Start(0))?;
    let read = file.read(&mut header)?;
    file.seek(SeekFrom::Start(0))?;
    if read < header.len() {
        return Ok(Region::whole(length));
    }
    Ok(mbr::locate(&header, length))
}

/// Opens the filesystem inside an image for reading.
pub fn open_read(path: &Path) -> Result<FileSystem<RegionIo<fs::File>>> {
    let mut file =
        fs::File::open(path).with_context(|| format!("Unable to open {}", path.display()))?;
    let region = locate(&mut file)?;
    let io = RegionIo::new(file, region)?;
    FileSystem::new(io, FsOptions::new())
        .with_context(|| format!("{} is not a supported FAT filesystem", path.display()))
}

fn open_write(path: &Path) -> Result<FileSystem<RegionIo<fs::File>>> {
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .with_context(|| format!("Unable to open {} for writing", path.display()))?;
    let region = locate(&mut file)?;
    let io = RegionIo::new(file, region)?;
    FileSystem::new(io, FsOptions::new())
        .with_context(|| format!("{} is not a supported FAT filesystem", path.display()))
}

/// What a new image should look like.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageOptions {
    pub size_bytes: u64,
    pub label: String,
    pub fat: FatKind,
    /// A real GoTek stick is partitioned; a bare filesystem is the exception.
    pub partitioned: bool,
}

impl Default for ImageOptions {
    fn default() -> Self {
        Self {
            size_bytes: 256 * 1024 * 1024,
            label: "GOTEK".into(),
            fat: FatKind::Auto,
            partitioned: true,
        }
    }
}

/// Creates an empty, formatted image file.
pub fn create(path: &Path, options: &ImageOptions) -> Result<()> {
    if options.size_bytes < MIN_IMAGE_BYTES {
        return Err(Error::new("An image must be at least 2 MiB."));
    }
    if options.size_bytes > MAX_IMAGE_BYTES {
        return Err(Error::new("An image larger than 64 GiB is not supported."));
    }
    // Round down to whole sectors so the geometry is exact.
    let total = options.size_bytes / SECTOR * SECTOR;

    // Read access matters as much as write: formatting reads structures back
    // as it lays them down, and a write-only handle fails part way through.
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .with_context(|| format!("Unable to create {}", path.display()))?;
    file.set_len(total)?;

    let region = if options.partitioned {
        let sectors = u32::try_from(total / SECTOR)
            .map_err(|_| Error::new("An image that large cannot use a partition table."))?;
        let fat = options.fat.resolve(total - mbr::FIRST_LBA as u64 * SECTOR);
        let table = mbr::build(sectors, partition_type(fat))?;
        file.write_all(&table)?;
        mbr::locate(&table, total)
    } else {
        Region::whole(total)
    };

    let fat = options.fat.resolve(region.length);
    let mut io = RegionIo::new(file, region)?;
    fatfs::format_volume(
        &mut io,
        FormatVolumeOptions::new()
            .fat_type(fat)
            .volume_label(volume_label(&options.label)),
    )
    .with_context(|| format!("Unable to format {}", path.display()))?;
    io.flush()?;
    Ok(())
}

/// Creates every missing folder along a `/`-separated path inside the image.
fn ensure_directory<T: fatfs::ReadWriteSeek>(
    filesystem: &FileSystem<T>,
    relative: &str,
) -> Result<()> {
    let mut built = String::new();
    for part in relative.split('/').filter(|part| !part.is_empty()) {
        if !built.is_empty() {
            built.push('/');
        }
        built.push_str(part);
        // Already present is the common case, not a failure.
        let _ = filesystem.root_dir().create_dir(&built);
    }
    Ok(())
}

/// One file to place inside an image.
pub struct ImageFile {
    pub source: PathBuf,
    /// `/`-separated and relative to the image root.
    pub relative_path: String,
    pub size: u64,
}

/// Copies files into an existing image, creating folders as needed.
///
/// Returns the number of bytes written. Every destination path is validated,
/// so nothing can escape the image root.
pub fn write_files(path: &Path, files: &[ImageFile]) -> Result<u64> {
    let filesystem = open_write(path)?;
    let mut written = 0u64;
    for file in files {
        safe_relative_path(&file.relative_path)?;
        if let Some((parent, _)) = file.relative_path.rsplit_once('/') {
            ensure_directory(&filesystem, parent)?;
        }
        let mut target = filesystem
            .root_dir()
            .create_file(&file.relative_path)
            .with_context(|| format!("Unable to create {} in the image", file.relative_path))?;
        target.truncate().map_err(|error| Error::new(error.to_string()))?;
        // Read through the source resolver rather than opened as a file: a
        // title can live in a folder, inside a ZIP, or inside another image,
        // and opening the path directly worked for only the first of those.
        let copied = crate::source::read_with(&file.source, |reader| {
            std::io::copy(reader, &mut target)
                .with_context(|| format!("Unable to write {} into the image", file.relative_path))
        })?;
        if copied != file.size {
            return Err(Error::new(format!(
                "Short write for {}: the source changed while it was being copied.",
                file.relative_path
            )));
        }
        written += copied;
    }
    filesystem
        .unmount()
        .map_err(|error| Error::new(format!("Unable to finalise the image: {error}")))?;
    Ok(written)
}

/// Lists one directory inside an image.
pub fn read_directory(path: &Path, inner: &str) -> Result<Vec<FileEntry>> {
    let filesystem = open_read(path)?;
    let root = filesystem.root_dir();
    let directory = if inner.is_empty() {
        root
    } else {
        root.open_dir(inner)
            .with_context(|| format!("Unable to open /{inner}"))?
    };
    let mut entries = directory
        .iter()
        .filter_map(std::result::Result::ok)
        .filter(|entry| !matches!(entry.file_name().as_str(), "." | ".."))
        .map(|entry| {
            let name = entry.file_name();
            let virtual_path = if inner.is_empty() {
                name.clone()
            } else {
                format!("{inner}/{name}")
            };
            FileEntry {
                extension: extension_of(Path::new(&name)),
                name,
                path: virtual_path,
                size: entry.len(),
                modified: None,
                directory: entry.is_dir(),
            }
        })
        .collect::<Vec<_>>();
    sort_entries(&mut entries);
    Ok(entries)
}

/// Every file in an image, depth first, as `/`-separated paths.
pub fn list_files(path: &Path) -> Result<Vec<FileEntry>> {
    let mut found = Vec::new();
    let mut pending = vec![String::new()];
    while let Some(folder) = pending.pop() {
        for entry in read_directory(path, &folder)? {
            if entry.directory {
                pending.push(entry.path.clone());
            } else {
                found.push(entry);
            }
        }
        if found.len() > 100_000 {
            return Err(Error::new("The image holds an implausible number of files."));
        }
    }
    found.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(found)
}

/// What a stick of this size will actually hold.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCapacity {
    /// Bytes left for files once the filesystem has taken its own.
    pub usable_bytes: u64,
    /// The allocation unit. Every file costs a whole number of these.
    pub cluster_bytes: u64,
}

/// Measures a stick by building one and asking it.
///
/// The cluster size is chosen by the formatter from the volume's size, and it is
/// the number that decides whether a collection fits: an 881 KB disk image on a
/// 32 KB cluster occupies 896 KB, and ten thousand of them turn a comfortable
/// byte total into an overflowing one. Estimating it would mean reimplementing
/// the formatter's judgement and being wrong occasionally, so a volume is laid
/// out in a sparse temporary file and asked directly. Formatting writes only the
/// structures, so this costs little more than the directory it creates.
pub fn capacity(options: &ImageOptions) -> Result<ImageCapacity> {
    let probe = std::env::temp_dir().join(format!(
        "gotek-capacity-{}.img",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_nanos())
            .unwrap_or_default()
    ));
    let measured = (|| -> Result<ImageCapacity> {
        create(&probe, options)?;
        let filesystem = open_read(&probe)?;
        let stats = filesystem
            .stats()
            .map_err(|error| Error::new(format!("Unable to measure the volume: {error}")))?;
        let cluster_bytes = u64::from(stats.cluster_size());
        Ok(ImageCapacity {
            usable_bytes: u64::from(stats.free_clusters()) * cluster_bytes,
            cluster_bytes,
        })
    })();
    let _ = fs::remove_file(&probe);
    measured
}

/// The size of one file inside an image, or `None` when it is not there.
///
/// Read from the filesystem's own directory rather than by reading the file, so
/// asking about a few thousand entries costs a few thousand lookups rather than
/// a few thousand decompressions.
pub fn entry_size(image: &Path, inner: &str) -> Result<Option<u64>> {
    let Ok(filesystem) = open_read(image) else {
        return Ok(None);
    };
    let Some(inner) = normalised_inner(inner) else {
        return Ok(None);
    };
    let Ok(mut file) = filesystem.root_dir().open_file(&inner) else {
        return Ok(None);
    };
    // The length is the seek end, which the filesystem answers from its own
    // directory rather than by reading anything.
    Ok(std::io::Seek::seek(&mut file, std::io::SeekFrom::End(0)).ok())
}

/// Hands the contents of one file inside an image to the caller.
///
/// Nothing is unpacked on the way: the bytes are read straight out of the image,
/// exactly as an entry inside an archive is.
pub fn read_entry<T>(
    image: &Path,
    inner: &str,
    read: impl FnOnce(&mut dyn std::io::Read) -> Result<T>,
) -> Result<T> {
    let filesystem = open_read(image)?;
    let path = normalised_inner(inner)
        .ok_or_else(|| Error::new(format!("{inner} does not name a file in the image.")))?;
    let mut file = filesystem
        .root_dir()
        .open_file(&path)
        .with_context(|| format!("Unable to read {inner} from {}", image.display()))?;
    read(&mut file)
}

/// An inner path in the form the filesystem expects, or nothing when it is empty.
fn normalised_inner(inner: &str) -> Option<String> {
    let trimmed = inner.trim_matches('/');
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Unpacks an image into a folder.
///
/// Nothing is overwritten: an existing destination file is reported rather than
/// replaced, which matches how every other write in this application behaves.
pub fn extract(image: &Path, destination: &Path) -> Result<Vec<String>> {
    if !destination.is_dir() {
        return Err(Error::new("Choose an existing folder to unpack into."));
    }
    let filesystem = open_read(image)?;
    let mut written = Vec::new();
    for entry in list_files(image)? {
        let relative = safe_relative_path(&entry.path)?;
        let target = destination.join(&relative);
        if target.exists() {
            return Err(Error::new(format!(
                "{} already exists in the destination folder.",
                entry.path
            )));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut source = filesystem
            .root_dir()
            .open_file(&entry.path)
            .with_context(|| format!("Unable to read {} from the image", entry.path))?;
        let mut output = fs::File::create(&target)
            .with_context(|| format!("Unable to write {}", target.display()))?;
        std::io::copy(&mut source, &mut output)?;
        output.sync_all()?;
        written.push(to_posix(&relative.to_string_lossy()));
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::{
        create, entry_size, extract, list_files, read_directory, read_entry, volume_label,
        write_files, FatKind, ImageFile, ImageOptions,
    };
    use std::{fs, path::PathBuf};

    #[test]
    fn a_stick_is_measured_in_clusters_rather_than_bytes() {
        // The number that decides whether a collection fits. A byte total says
        // an 881 KB image costs 881 KB; the volume charges a whole cluster for
        // it, and across thousands of titles that difference is the difference
        // between fitting and not.
        let measured = super::capacity(&ImageOptions {
            size_bytes: 64 * 1024 * 1024,
            label: "GOTEK".into(),
            fat: FatKind::Fat16,
            partitioned: false,
        })
        .unwrap();

        assert!(measured.cluster_bytes >= 512, "a cluster is at least a sector");
        assert!(measured.cluster_bytes.is_power_of_two());
        assert!(measured.usable_bytes > 0);
        // The filesystem's own structures are not available for files.
        assert!(measured.usable_bytes < 64 * 1024 * 1024);
    }

    #[test]
    fn a_stick_can_be_built_from_a_folder_an_archive_or_another_image() {
        // A profile's destination is wherever somebody chose to keep it: a
        // folder, a stick, or a FAT image kept as a backup. Populating an image
        // opened its sources as files, so only the first of those worked.
        let root = fixture("mixed-sources");
        let options = ImageOptions {
            size_bytes: 16 * 1024 * 1024,
            label: "GOTEK".into(),
            fat: FatKind::Fat16,
            partitioned: false,
        };

        // A plain file, an entry in a ZIP, and an entry in another image.
        let loose = root.join("Loose.adf");
        fs::write(&loose, b"loose title").unwrap();

        let archive = root.join("library.zip");
        {
            let mut writer = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
            writer
                .start_file("Zipped.adf", zip::write::SimpleFileOptions::default())
                .unwrap();
            std::io::Write::write_all(&mut writer, b"zipped title").unwrap();
            writer.finish().unwrap();
        }

        let held = root.join("held.img");
        create(&held, &options).unwrap();
        write_files(
            &held,
            &[ImageFile {
                source: loose.clone(),
                relative_path: "Games/Inside.adf".into(),
                size: "loose title".len() as u64,
            }],
        )
        .unwrap();

        // What the image holds can be measured and read without unpacking it.
        assert_eq!(
            entry_size(&held, "Games/Inside.adf").unwrap(),
            Some("loose title".len() as u64),
        );
        let read_back =
            read_entry(&held, "Games/Inside.adf", |reader| {
                let mut buffer = Vec::new();
                std::io::Read::read_to_end(reader, &mut buffer).unwrap();
                Ok(buffer)
            })
            .unwrap();
        assert_eq!(read_back, b"loose title");

        // And all three can be written into a stick in one pass.
        let stick = root.join("stick.img");
        create(&stick, &options).unwrap();
        write_files(
            &stick,
            &[
                ImageFile {
                    source: loose,
                    relative_path: "Games/A.adf".into(),
                    size: "loose title".len() as u64,
                },
                ImageFile {
                    source: PathBuf::from(crate::source::entry_path(&archive, "Zipped.adf")),
                    relative_path: "Games/B.adf".into(),
                    size: "zipped title".len() as u64,
                },
                ImageFile {
                    source: PathBuf::from(crate::source::entry_path(&held, "Games/Inside.adf")),
                    relative_path: "Games/C.adf".into(),
                    size: "loose title".len() as u64,
                },
            ],
        )
        .unwrap();

        let written = list_files(&stick).unwrap();
        let mut names: Vec<_> = written.iter().map(|entry| entry.path.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["Games/A.adf", "Games/B.adf", "Games/C.adf"]);

        fs::remove_dir_all(root).unwrap();
    }

    fn fixture(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "gotek-image-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn options(size: u64, partitioned: bool) -> ImageOptions {
        ImageOptions {
            size_bytes: size,
            label: "GOTEK".into(),
            fat: FatKind::Auto,
            partitioned,
        }
    }

    #[test]
    fn a_created_image_can_be_read_back() {
        let root = fixture("create");
        let image = root.join("gotek.img");

        create(&image, &options(64 * 1024 * 1024, true)).unwrap();

        assert_eq!(fs::metadata(&image).unwrap().len(), 64 * 1024 * 1024);
        // Freshly formatted, so it opens and is empty.
        assert!(read_directory(&image, "").unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn files_written_into_an_image_come_back_out_byte_for_byte() {
        let root = fixture("roundtrip");
        let image = root.join("gotek.img");
        let source = root.join("Elite.ssd");
        let content = vec![0xA5u8; 200 * 1024];
        fs::write(&source, &content).unwrap();
        create(&image, &options(64 * 1024 * 1024, true)).unwrap();

        let written = write_files(
            &image,
            &[ImageFile {
                source: source.clone(),
                relative_path: "BBC/Elite.ssd".into(),
                size: content.len() as u64,
            }],
        )
        .unwrap();

        assert_eq!(written, content.len() as u64);

        let listing = list_files(&image).unwrap();
        assert_eq!(listing.len(), 1);
        assert_eq!(listing[0].path, "BBC/Elite.ssd");
        assert_eq!(listing[0].size, content.len() as u64);

        // And unpacking gives back exactly what went in.
        let out = fixture("roundtrip-out");
        let extracted = extract(&image, &out).unwrap();
        assert_eq!(extracted, vec!["BBC/Elite.ssd".to_string()]);
        assert_eq!(fs::read(out.join("BBC/Elite.ssd")).unwrap(), content);

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(out).unwrap();
    }

    #[test]
    fn an_unpartitioned_image_works_too() {
        // This is the shape the application could already read, and must keep
        // being able to produce for anyone who needs a bare filesystem.
        let root = fixture("superfloppy");
        let image = root.join("bare.img");

        create(&image, &options(16 * 1024 * 1024, false)).unwrap();
        let source = root.join("Game.ssd");
        fs::write(&source, b"disk").unwrap();
        write_files(
            &image,
            &[ImageFile {
                source,
                relative_path: "Game.ssd".into(),
                size: 4,
            }],
        )
        .unwrap();

        assert_eq!(list_files(&image).unwrap()[0].path, "Game.ssd");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_destination_path_cannot_escape_the_image() {
        let root = fixture("escape");
        let image = root.join("gotek.img");
        let source = root.join("Elite.ssd");
        fs::write(&source, b"disk").unwrap();
        create(&image, &options(16 * 1024 * 1024, true)).unwrap();

        let result = write_files(
            &image,
            &[ImageFile {
                source,
                relative_path: "../escaped.ssd".into(),
                size: 4,
            }],
        );

        assert!(result.is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unpacking_never_overwrites_an_existing_file() {
        let root = fixture("no-overwrite");
        let image = root.join("gotek.img");
        let source = root.join("Elite.ssd");
        fs::write(&source, b"new").unwrap();
        create(&image, &options(16 * 1024 * 1024, true)).unwrap();
        write_files(
            &image,
            &[ImageFile {
                source,
                relative_path: "Elite.ssd".into(),
                size: 3,
            }],
        )
        .unwrap();

        let out = fixture("no-overwrite-out");
        fs::write(out.join("Elite.ssd"), b"existing").unwrap();

        let error = extract(&image, &out).unwrap_err();

        assert!(error.to_string().contains("already exists"));
        assert_eq!(fs::read(out.join("Elite.ssd")).unwrap(), b"existing");
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(out).unwrap();
    }

    #[test]
    fn implausible_sizes_are_refused() {
        let root = fixture("sizes");
        let image = root.join("x.img");

        assert!(create(&image, &options(1024, true)).is_err());
        assert!(create(&image, &options(u64::MAX, true)).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn volume_labels_are_padded_and_folded_to_fat_rules() {
        assert_eq!(&volume_label("GOTEK"), b"GOTEK      ");
        assert_eq!(&volume_label("bbc micro!"), b"BBCMICRO   ");
        assert_eq!(&volume_label("a-very-long-label"), b"AVERYLONGLA");
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// What an image holds, without opening every file in it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSummary {
    pub path: String,
    pub size_bytes: u64,
    pub partitioned: bool,
    pub filesystem_bytes: u64,
    pub file_count: usize,
    pub used_bytes: u64,
}

/// What a stick of this size would hold, before anything is written to it.
#[tauri::command]
pub async fn image_capacity(options: ImageOptions) -> crate::error::Result<ImageCapacity> {
    crate::task::blocking(move || capacity(&options)).await
}

#[tauri::command]
pub async fn image_summary(path: String) -> crate::error::Result<ImageSummary> {
    crate::task::blocking(move || {
        let target = PathBuf::from(&path);
        let mut file = fs::File::open(&target)
            .with_context(|| format!("Unable to open {path}"))?;
        let total = file.metadata()?.len();
        let region = locate(&mut file)?;
        let files = list_files(&target)?;
        Ok(ImageSummary {
            partitioned: region.offset > 0,
            filesystem_bytes: region.length,
            used_bytes: files.iter().map(|entry| entry.size).sum(),
            file_count: files.len(),
            size_bytes: total,
            path,
        })
    })
    .await
}

/// Creates an empty image, optionally filling it from staged files.
///
/// Refuses to replace an existing file: an image is a destination like any
/// other, and nothing in this application overwrites without being asked.
#[tauri::command]
pub async fn create_image(
    path: String,
    options: ImageOptions,
    operations: Vec<crate::transfer::TransferOperation>,
) -> crate::error::Result<u64> {
    crate::task::blocking(move || {
        let target = PathBuf::from(&path);
        if target.exists() {
            return Err(Error::new(format!("{path} already exists.")));
        }
        create(&target, &options)?;
        if operations.is_empty() {
            return Ok(0);
        }
        let files = operations
            .iter()
            .map(|operation| ImageFile {
                source: PathBuf::from(&operation.source),
                relative_path: operation.relative_path.clone(),
                size: operation.size,
            })
            .collect::<Vec<_>>();
        match write_files(&target, &files) {
            Ok(written) => Ok(written),
            Err(error) => {
                // A half-filled image is worse than none: remove it.
                let _ = fs::remove_file(&target);
                Err(error)
            }
        }
    })
    .await
}

/// Unpacks an image into a folder.
#[tauri::command]
pub async fn extract_image(image: String, destination: String) -> crate::error::Result<Vec<String>> {
    crate::task::blocking(move || extract(Path::new(&image), Path::new(&destination))).await
}
