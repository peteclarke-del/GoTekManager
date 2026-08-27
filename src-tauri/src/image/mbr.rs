//! The master boot record of a GoTek USB layout.
//!
//! Real GoTek media is normally a partitioned USB stick rather than a bare
//! "superfloppy" filesystem, so both shapes have to be understood: an image
//! either starts with a partition table or is a filesystem from byte zero.

use crate::error::{Error, Result};

pub const SECTOR: u64 = 512;
/// One mebibyte in, which is what every modern partitioner aligns to.
pub const FIRST_LBA: u32 = 2048;

const SIGNATURE: [u8; 2] = [0x55, 0xAA];
const TABLE_OFFSET: usize = 446;
const ENTRY_SIZE: usize = 16;

/// Partition type bytes. FAT32 with LBA addressing is what a GoTek expects.
pub const TYPE_FAT32_LBA: u8 = 0x0C;
pub const TYPE_FAT16_LBA: u8 = 0x0E;

/// Where a filesystem lives inside an image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Region {
    pub offset: u64,
    pub length: u64,
}

impl Region {
    pub fn whole(length: u64) -> Self {
        Self { offset: 0, length }
    }
}

/// Builds a single-partition master boot record covering `total_sectors`.
pub fn build(total_sectors: u32, partition_type: u8) -> Result<[u8; SECTOR as usize]> {
    if total_sectors <= FIRST_LBA {
        return Err(Error::new(
            "The target is too small to hold a partition table and a filesystem.",
        ));
    }
    let mut sector = [0u8; SECTOR as usize];
    let count = total_sectors - FIRST_LBA;

    let entry = &mut sector[TABLE_OFFSET..TABLE_OFFSET + ENTRY_SIZE];
    entry[0] = 0x00; // Not bootable; a GoTek does not boot from the stick.
                     // The CHS fields are obsolete. 0xFE/0xFF/0xFF is the
                     // conventional "too large, use LBA" marker.
    entry[1..4].copy_from_slice(&[0xFE, 0xFF, 0xFF]);
    entry[4] = partition_type;
    entry[5..8].copy_from_slice(&[0xFE, 0xFF, 0xFF]);
    entry[8..12].copy_from_slice(&FIRST_LBA.to_le_bytes());
    entry[12..16].copy_from_slice(&count.to_le_bytes());

    sector[510..512].copy_from_slice(&SIGNATURE);
    Ok(sector)
}

/// Finds the filesystem in an image.
///
/// Returns the first partition when the image is partitioned, and the whole
/// image when it is not, so a bare filesystem image still opens.
pub fn locate(header: &[u8], total_length: u64) -> Region {
    if header.len() < SECTOR as usize || header[510..512] != SIGNATURE {
        return Region::whole(total_length);
    }
    for index in 0..4 {
        let start = TABLE_OFFSET + index * ENTRY_SIZE;
        let entry = &header[start..start + ENTRY_SIZE];
        let partition_type = entry[4];
        if partition_type == 0 {
            continue;
        }
        let first = u32::from_le_bytes([entry[8], entry[9], entry[10], entry[11]]) as u64;
        let count = u32::from_le_bytes([entry[12], entry[13], entry[14], entry[15]]) as u64;
        if count == 0 {
            continue;
        }
        let offset = first * SECTOR;
        // A table that points outside the image is not one worth trusting.
        if offset >= total_length {
            break;
        }
        let length = (count * SECTOR).min(total_length - offset);
        return Region { offset, length };
    }
    // A signature with no usable entry: treat the image as a bare filesystem
    // rather than refusing to read it at all.
    Region::whole(total_length)
}

#[cfg(test)]
mod tests {
    use super::{build, locate, Region, FIRST_LBA, SECTOR, TYPE_FAT32_LBA};

    #[test]
    fn a_built_table_is_found_again_by_the_reader() {
        let total_sectors = 16 * 1024 * 1024 / SECTOR as u32; // 16 MiB
        let sector = build(total_sectors, TYPE_FAT32_LBA).unwrap();

        let region = locate(&sector, total_sectors as u64 * SECTOR);

        assert_eq!(region.offset, FIRST_LBA as u64 * SECTOR);
        assert_eq!(
            region.length,
            (total_sectors - FIRST_LBA) as u64 * SECTOR
        );
    }

    #[test]
    fn the_signature_and_type_are_written_where_firmware_expects_them() {
        let sector = build(64 * 1024, TYPE_FAT32_LBA).unwrap();

        assert_eq!(&sector[510..512], &[0x55, 0xAA]);
        assert_eq!(sector[446 + 4], TYPE_FAT32_LBA);
        assert_eq!(&sector[446 + 8..446 + 12], &FIRST_LBA.to_le_bytes());
    }

    #[test]
    fn an_unpartitioned_image_reads_as_one_whole_filesystem() {
        // This is the shape the application has always read, and must keep
        // reading: a bare FAT filesystem with no table in front of it.
        let mut header = [0u8; SECTOR as usize];
        header[0..3].copy_from_slice(&[0xEB, 0x58, 0x90]); // FAT jump instruction

        assert_eq!(locate(&header, 1_474_560), Region::whole(1_474_560));
    }

    #[test]
    fn a_table_pointing_outside_the_image_is_not_trusted() {
        let mut sector = build(64 * 1024, TYPE_FAT32_LBA).unwrap();
        // Claim the partition starts far beyond the end of the file.
        sector[446 + 8..446 + 12].copy_from_slice(&u32::MAX.to_le_bytes());

        assert_eq!(locate(&sector, 1024 * 1024), Region::whole(1024 * 1024));
    }

    #[test]
    fn a_partition_running_past_the_end_is_clamped() {
        let mut sector = build(64 * 1024, TYPE_FAT32_LBA).unwrap();
        sector[446 + 12..446 + 16].copy_from_slice(&u32::MAX.to_le_bytes());

        let total = 8 * 1024 * 1024;
        let region = locate(&sector, total);

        assert_eq!(region.offset, FIRST_LBA as u64 * SECTOR);
        assert_eq!(region.offset + region.length, total);
    }

    #[test]
    fn a_target_too_small_for_a_table_is_refused() {
        assert!(build(FIRST_LBA, TYPE_FAT32_LBA).is_err());
        assert!(build(0, TYPE_FAT32_LBA).is_err());
    }
}
