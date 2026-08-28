//! Converting images a GoTek cannot present into ones it can.
//!
//! Deliberately narrow. Every conversion here is between two fully specified
//! formats and is exercised against bytes in the tests, because a conversion
//! that is nearly right produces media that looks fine and will not load, which
//! is worse than refusing outright.
//!
//! What is supported, and why these two:
//!
//! - **`.msa` to `.st`** — a Magic Shadow Archiver image is an Atari ST disk
//!   with its tracks run-length encoded. Neither FlashFloppy nor HxC reads it,
//!   yet a great deal of ST software is distributed this way. Decoding is
//!   lossless: the result is the same sectors, uncompressed.
//! - **`.scl` to `.trd`** — an SCL file is a bare collection of TR-DOS files
//!   with no disk around them. Firmware reads `.trd`, so the files are placed
//!   on an empty TR-DOS disk and a catalogue is built for them.
//!
//! What is not supported, and will not be guessed at: `.d64` to `.d81` needs a
//! CBM DOS filesystem copy and would break the loaders most titles rely on;
//! `.ipf` and `.stx` hold flux and copy protection that cannot be reduced to
//! sectors; `.dms` and `.adz` need decompressors that would ship untested.

use crate::error::{Error, Result};
use crate::paths::extension_of;
use serde::Serialize;
use std::path::Path;

/// A supported conversion, named by what it reads and what it writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Conversion {
    MsaToSt,
    SclToTrd,
}

impl Conversion {
    pub fn source_extension(self) -> &'static str {
        match self {
            Conversion::MsaToSt => "msa",
            Conversion::SclToTrd => "scl",
        }
    }

    pub fn target_extension(self) -> &'static str {
        match self {
            Conversion::MsaToSt => "st",
            Conversion::SclToTrd => "trd",
        }
    }

    /// The conversion that applies to a filename, if any.
    pub fn for_path(path: &Path) -> Option<Self> {
        match extension_of(path).as_str() {
            "msa" => Some(Conversion::MsaToSt),
            "scl" => Some(Conversion::SclToTrd),
            _ => None,
        }
    }

    pub fn apply(self, source: &[u8]) -> Result<Vec<u8>> {
        match self {
            Conversion::MsaToSt => msa_to_st(source),
            Conversion::SclToTrd => scl_to_trd(source),
        }
    }
}

// ---------------------------------------------------------------------------
// Magic Shadow Archiver -> raw Atari ST image
// ---------------------------------------------------------------------------

const MSA_MAGIC: u16 = 0x0E0F;
/// The byte that introduces a run. Chosen by the format, not by us.
const MSA_RUN_MARKER: u8 = 0xE5;
const SECTOR: usize = 512;
/// A double-sided 80-track disk is 720 sectors; this leaves room for oddities
/// while refusing anything that is clearly not a floppy.
const MSA_MAX_BYTES: usize = 32 * 1024 * 1024;

fn be16(bytes: &[u8], at: usize) -> Result<u16> {
    bytes
        .get(at..at + 2)
        .map(|slice| u16::from_be_bytes([slice[0], slice[1]]))
        .ok_or_else(|| Error::new("The image ends in the middle of its header."))
}

/// Expands one track, which is either stored raw or run-length encoded.
fn msa_track(source: &[u8], at: usize, length: usize, expected: usize) -> Result<Vec<u8>> {
    let data = source
        .get(at..at + length)
        .ok_or_else(|| Error::new("The image ends in the middle of a track."))?;

    // A track whose stored length equals its real length was not compressed.
    if length == expected {
        return Ok(data.to_vec());
    }

    let mut out = Vec::with_capacity(expected);
    let mut index = 0;
    while index < data.len() {
        let byte = data[index];
        index += 1;
        if byte != MSA_RUN_MARKER {
            out.push(byte);
            continue;
        }
        // A run: the value, then how many times it repeats.
        let value = *data
            .get(index)
            .ok_or_else(|| Error::new("A compressed track ends in the middle of a run."))?;
        let count = u16::from_be_bytes([
            *data.get(index + 1).unwrap_or(&0),
            *data.get(index + 2).unwrap_or(&0),
        ]) as usize;
        if index + 3 > data.len() {
            return Err(Error::new("A compressed track ends in the middle of a run."));
        }
        index += 3;
        if out.len() + count > expected {
            return Err(Error::new(
                "A compressed track expands beyond the size of a track.",
            ));
        }
        out.resize(out.len() + count, value);
    }
    if out.len() != expected {
        return Err(Error::new(format!(
            "A track expanded to {} bytes rather than {expected}.",
            out.len()
        )));
    }
    Ok(out)
}

pub fn msa_to_st(source: &[u8]) -> Result<Vec<u8>> {
    if be16(source, 0)? != MSA_MAGIC {
        return Err(Error::new("This is not a Magic Shadow Archiver image."));
    }
    let sectors = be16(source, 2)? as usize;
    // The field holds the highest side number, so 0 means one side.
    let sides = be16(source, 4)? as usize + 1;
    let first_track = be16(source, 6)? as usize;
    let last_track = be16(source, 8)? as usize;

    if sectors == 0 || sectors > 64 || sides > 2 || last_track < first_track || last_track > 90 {
        return Err(Error::new(
            "The image describes a disk geometry that is not a floppy.",
        ));
    }
    let track_bytes = sectors * SECTOR;
    let total = (last_track - first_track + 1) * sides * track_bytes;
    if total == 0 || total > MSA_MAX_BYTES {
        return Err(Error::new("The image describes an implausible disk size."));
    }

    let mut out = Vec::with_capacity(total);
    let mut at = 10;
    for _ in first_track..=last_track {
        for _ in 0..sides {
            let length = be16(source, at)? as usize;
            at += 2;
            out.extend_from_slice(&msa_track(source, at, length, track_bytes)?);
            at += length;
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// SCL -> TR-DOS disk image
// ---------------------------------------------------------------------------

const SCL_MAGIC: &[u8; 8] = b"SINCLAIR";
const TRD_SECTOR: usize = 256;
const TRD_SECTORS_PER_TRACK: usize = 16;
/// Eighty tracks, two sides: the disk TR-DOS expects and FlashFloppy presents.
const TRD_TRACKS: usize = 80;
const TRD_SIDES: usize = 2;
const TRD_TOTAL_SECTORS: usize = TRD_TRACKS * TRD_SIDES * TRD_SECTORS_PER_TRACK;
const TRD_SIZE: usize = TRD_TOTAL_SECTORS * TRD_SECTOR;
/// The catalogue occupies the first eight sectors, then the disk-information
/// sector; files begin on track one.
const TRD_CATALOGUE_ENTRIES: usize = 128;
const TRD_INFO_OFFSET: usize = 8 * TRD_SECTOR;
const TRD_FIRST_FILE_SECTOR: usize = TRD_SECTORS_PER_TRACK;
/// Eighty-track double-sided, as recorded in the disk information sector.
const TRD_DISK_TYPE: u8 = 0x16;
const TRD_ID: u8 = 0x10;

pub fn scl_to_trd(source: &[u8]) -> Result<Vec<u8>> {
    if source.len() < 9 || &source[0..8] != SCL_MAGIC {
        return Err(Error::new("This is not an SCL file."));
    }
    let count = source[8] as usize;
    if count == 0 {
        return Err(Error::new("The SCL file holds no files."));
    }
    if count > TRD_CATALOGUE_ENTRIES {
        return Err(Error::new(format!(
            "The SCL file holds {count} files; a TR-DOS disk catalogue holds {TRD_CATALOGUE_ENTRIES}."
        )));
    }

    // Fourteen bytes each: eight of name, one of type, two of start, two of
    // length, one of length in sectors.
    let descriptors = source
        .get(9..9 + count * 14)
        .ok_or_else(|| Error::new("The SCL file ends in the middle of its catalogue."))?;
    let total_sectors: usize = (0..count)
        .map(|index| descriptors[index * 14 + 13] as usize)
        .sum();
    if total_sectors + TRD_FIRST_FILE_SECTOR > TRD_TOTAL_SECTORS {
        return Err(Error::new(
            "The SCL file holds more data than a TR-DOS disk can.",
        ));
    }

    let mut disk = vec![0u8; TRD_SIZE];
    let mut data_at = 9 + count * 14;
    let mut sector = TRD_FIRST_FILE_SECTOR;

    for index in 0..count {
        let descriptor = &descriptors[index * 14..index * 14 + 14];
        let sectors = descriptor[13] as usize;

        // Catalogue entry: the descriptor, then where the file was placed.
        let entry = index * 16;
        disk[entry..entry + 14].copy_from_slice(descriptor);
        disk[entry + 14] = (sector % TRD_SECTORS_PER_TRACK) as u8;
        disk[entry + 15] = (sector / TRD_SECTORS_PER_TRACK) as u8;

        let length = sectors * TRD_SECTOR;
        let body = source
            .get(data_at..data_at + length)
            .ok_or_else(|| Error::new("The SCL file ends in the middle of a file."))?;
        let at = sector * TRD_SECTOR;
        disk[at..at + length].copy_from_slice(body);

        data_at += length;
        sector += sectors;
    }

    let free = TRD_TOTAL_SECTORS - sector;
    let info = &mut disk[TRD_INFO_OFFSET..TRD_INFO_OFFSET + TRD_SECTOR];
    info[0xE1] = (sector % TRD_SECTORS_PER_TRACK) as u8;
    info[0xE2] = (sector / TRD_SECTORS_PER_TRACK) as u8;
    info[0xE3] = TRD_DISK_TYPE;
    info[0xE4] = count as u8;
    info[0xE5] = (free & 0xFF) as u8;
    info[0xE6] = (free >> 8) as u8;
    info[0xE7] = TRD_ID;
    // The label is eight spaces unless something better is known.
    info[0xF5..0xFD].copy_from_slice(b"GOTEK   ");
    Ok(disk)
}

// ---------------------------------------------------------------------------
// What the settings screen shows
// ---------------------------------------------------------------------------

/// One supported conversion, described for the person deciding whether to
/// enable them. The list is built here rather than written out again in the
/// interface, so a conversion cannot be offered that does not exist.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionSupport {
    pub conversion: Conversion,
    pub from: String,
    pub to: String,
    pub summary: &'static str,
}

pub const SUPPORTED: [Conversion; 2] = [Conversion::MsaToSt, Conversion::SclToTrd];

impl Conversion {
    fn summary(self) -> &'static str {
        match self {
            Conversion::MsaToSt => {
                "Atari ST disks stored by the Magic Shadow Archiver, unpacked to plain sectors."
            }
            Conversion::SclToTrd => {
                "ZX Spectrum TR-DOS file collections, written onto an empty 80-track disk."
            }
        }
    }
}

#[tauri::command]
pub fn supported_conversions() -> Vec<ConversionSupport> {
    SUPPORTED
        .iter()
        .map(|&conversion| ConversionSupport {
            conversion,
            from: format!(".{}", conversion.source_extension()),
            to: format!(".{}", conversion.target_extension()),
            summary: conversion.summary(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{msa_to_st, scl_to_trd, Conversion, MSA_RUN_MARKER, TRD_SECTOR, TRD_SIZE};
    use std::path::Path;

    /// Builds an MSA the way the format specifies, so the decoder is tested
    /// against the format rather than against itself.
    fn msa(sectors: u16, sides: u16, tracks: (u16, u16), bodies: Vec<Vec<u8>>) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&0x0E0Fu16.to_be_bytes());
        out.extend_from_slice(&sectors.to_be_bytes());
        out.extend_from_slice(&sides.to_be_bytes());
        out.extend_from_slice(&tracks.0.to_be_bytes());
        out.extend_from_slice(&tracks.1.to_be_bytes());
        for body in bodies {
            out.extend_from_slice(&(body.len() as u16).to_be_bytes());
            out.extend_from_slice(&body);
        }
        out
    }

    #[test]
    fn an_uncompressed_track_survives_unchanged() {
        let track = (0..9 * 512).map(|i| (i % 251) as u8).collect::<Vec<u8>>();
        let image = msa(9, 0, (0, 0), vec![track.clone()]);

        assert_eq!(msa_to_st(&image).unwrap(), track);
    }

    #[test]
    fn a_run_is_expanded_to_the_bytes_it_stands_for() {
        // 4608 bytes of 0xAA, written as one run.
        let mut encoded = vec![MSA_RUN_MARKER, 0xAA];
        encoded.extend_from_slice(&(9u16 * 512).to_be_bytes());
        let image = msa(9, 0, (0, 0), vec![encoded]);

        let out = msa_to_st(&image).unwrap();

        assert_eq!(out.len(), 9 * 512);
        assert!(out.iter().all(|byte| *byte == 0xAA));
    }

    #[test]
    fn literals_and_runs_mix_within_one_track() {
        let mut encoded = vec![0x01, 0x02, 0x03];
        encoded.extend_from_slice(&[MSA_RUN_MARKER, 0xFF]);
        encoded.extend_from_slice(&(9u16 * 512 - 3).to_be_bytes());
        let image = msa(9, 0, (0, 0), vec![encoded]);

        let out = msa_to_st(&image).unwrap();

        assert_eq!(&out[..3], &[0x01, 0x02, 0x03]);
        assert!(out[3..].iter().all(|byte| *byte == 0xFF));
        assert_eq!(out.len(), 9 * 512);
    }

    #[test]
    fn both_sides_of_every_track_are_written_in_order() {
        let side0 = vec![0xA0; 9 * 512];
        let side1 = vec![0xB1; 9 * 512];
        let image = msa(
            9,
            1,
            (0, 1),
            vec![side0.clone(), side1.clone(), side0.clone(), side1.clone()],
        );

        let out = msa_to_st(&image).unwrap();

        assert_eq!(out.len(), 2 * 2 * 9 * 512);
        assert_eq!(&out[..9 * 512], &side0[..]);
        assert_eq!(&out[9 * 512..2 * 9 * 512], &side1[..]);
    }

    #[test]
    fn something_that_is_not_an_msa_is_refused() {
        assert!(msa_to_st(b"not an image at all").is_err());
        assert!(msa_to_st(&[]).is_err());
    }

    #[test]
    fn an_implausible_geometry_is_refused_rather_than_allocated() {
        // A track count and sector count that would demand gigabytes.
        let image = msa(60, 1, (0, 89), vec![]);
        assert!(msa_to_st(&image).is_err());

        assert!(msa_to_st(&msa(0, 0, (0, 0), vec![])).is_err());
    }

    #[test]
    fn a_run_that_overflows_its_track_is_refused() {
        let mut encoded = vec![MSA_RUN_MARKER, 0xAA];
        encoded.extend_from_slice(&u16::MAX.to_be_bytes());
        let image = msa(9, 0, (0, 0), vec![encoded]);

        assert!(msa_to_st(&image).is_err());
    }

    /// Builds an SCL holding files of the given sector counts.
    fn scl(files: &[(&[u8; 8], u8, u8)]) -> Vec<u8> {
        let mut out = b"SINCLAIR".to_vec();
        out.push(files.len() as u8);
        for (name, kind, sectors) in files {
            out.extend_from_slice(*name);
            out.push(*kind);
            out.extend_from_slice(&[0, 0]); // start
            out.extend_from_slice(&[0, 0]); // length
            out.push(*sectors);
        }
        for (index, (_, _, sectors)) in files.iter().enumerate() {
            out.extend(std::iter::repeat_n(
                0xC0u8.wrapping_add(index as u8),
                *sectors as usize * TRD_SECTOR,
            ));
        }
        out
    }

    #[test]
    fn files_are_placed_on_a_disk_with_a_catalogue_that_finds_them() {
        let image = scl_to_trd(&scl(&[(b"GAME    ", b'C', 2), (b"LOADER  ", b'B', 1)])).unwrap();

        assert_eq!(image.len(), TRD_SIZE);

        // First entry: the name, then track one sector zero.
        assert_eq!(&image[0..8], b"GAME    ");
        assert_eq!(image[13], 2, "length in sectors");
        assert_eq!(image[14], 0, "start sector");
        assert_eq!(image[15], 1, "start track");

        // Second file follows the first, so sector two of track one.
        assert_eq!(&image[16..24], b"LOADER  ");
        assert_eq!(image[16 + 14], 2);
        assert_eq!(image[16 + 15], 1);

        // And the data landed where the catalogue says it did.
        assert_eq!(image[16 * TRD_SECTOR], 0xC0);
        assert_eq!(image[18 * TRD_SECTOR], 0xC1);
    }

    #[test]
    fn the_disk_information_sector_describes_the_disk() {
        let image = scl_to_trd(&scl(&[(b"GAME    ", b'C', 3)])).unwrap();
        let info = &image[8 * TRD_SECTOR..9 * TRD_SECTOR];

        assert_eq!(info[0xE4], 1, "file count");
        assert_eq!(info[0xE3], 0x16, "eighty tracks, two sides");
        assert_eq!(info[0xE7], 0x10, "TR-DOS identifier");
        // Nineteen sectors used: sixteen for track zero, three for the file.
        assert_eq!(info[0xE1], 3, "next free sector");
        assert_eq!(info[0xE2], 1, "next free track");
        let free = u16::from_le_bytes([info[0xE5], info[0xE6]]) as usize;
        assert_eq!(free, 80 * 2 * 16 - 19);
    }

    #[test]
    fn an_scl_that_does_not_fit_a_disk_is_refused() {
        // More files than the catalogue holds, whatever their size.
        let too_many = (0..200).map(|_| (b"FILE    ", b'C', 1u8)).collect::<Vec<_>>();
        assert!(scl_to_trd(&scl(&too_many)).is_err());

        // And files that fit the catalogue but not the disk.
        let too_big = (0..100).map(|_| (b"FILE    ", b'C', 255u8)).collect::<Vec<_>>();
        assert!(scl_to_trd(&scl(&too_big)).is_err());
    }

    #[test]
    fn a_truncated_scl_is_refused_rather_than_half_converted() {
        let mut image = scl(&[(b"GAME    ", b'C', 4)]);
        image.truncate(image.len() - TRD_SECTOR);

        assert!(scl_to_trd(&image).is_err());
    }

    #[test]
    fn something_that_is_not_an_scl_is_refused() {
        assert!(scl_to_trd(b"SINCLAIRX").is_err(), "no files");
        assert!(scl_to_trd(b"NOTANSCL").is_err());
    }

    #[test]
    fn a_conversion_is_chosen_by_the_file_it_is_given() {
        assert_eq!(
            Conversion::for_path(Path::new("/x/Game.MSA")),
            Some(Conversion::MsaToSt)
        );
        assert_eq!(
            Conversion::for_path(Path::new("/x/Game.scl")),
            Some(Conversion::SclToTrd)
        );
        // Formats that cannot be reduced to sectors are not offered.
        assert_eq!(Conversion::for_path(Path::new("/x/Game.ipf")), None);
        assert_eq!(Conversion::for_path(Path::new("/x/Game.d64")), None);
        assert_eq!(Conversion::for_path(Path::new("/x/Game.ssd")), None);

        assert_eq!(Conversion::MsaToSt.target_extension(), "st");
        assert_eq!(Conversion::SclToTrd.target_extension(), "trd");
    }
}
