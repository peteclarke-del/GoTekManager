//! A read/write window onto part of a file.
//!
//! The FAT layer must see a partition as if it were the whole volume. Clamping
//! every read, write, and seek to the partition's bounds means a filesystem
//! bug, or a corrupt image, cannot reach the partition table in front of it or
//! anything after it.

use super::mbr::Region;
use std::io::{self, Read, Seek, SeekFrom, Write};

pub struct RegionIo<T> {
    inner: T,
    region: Region,
    /// Position within the region, not within the underlying file.
    position: u64,
}

impl<T: Seek> RegionIo<T> {
    pub fn new(mut inner: T, region: Region) -> io::Result<Self> {
        inner.seek(SeekFrom::Start(region.offset))?;
        Ok(Self {
            inner,
            region,
            position: 0,
        })
    }

    fn remaining(&self) -> u64 {
        self.region.length.saturating_sub(self.position)
    }
}

impl<T: Read + Seek> Read for RegionIo<T> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let allowed = self.remaining().min(buffer.len() as u64) as usize;
        if allowed == 0 {
            return Ok(0);
        }
        let read = self.inner.read(&mut buffer[..allowed])?;
        self.position += read as u64;
        Ok(read)
    }
}

impl<T: Write + Seek> Write for RegionIo<T> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let allowed = self.remaining().min(buffer.len() as u64) as usize;
        if allowed == 0 {
            // Refusing rather than silently discarding: a full volume must
            // surface as an error, not as a quietly truncated file.
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "the filesystem is full",
            ));
        }
        let written = self.inner.write(&buffer[..allowed])?;
        self.position += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl<T: Seek> Seek for RegionIo<T> {
    fn seek(&mut self, target: SeekFrom) -> io::Result<u64> {
        let position = match target {
            SeekFrom::Start(offset) => offset as i64,
            SeekFrom::Current(delta) => self.position as i64 + delta,
            SeekFrom::End(delta) => self.region.length as i64 + delta,
        };
        if position < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek before the start of the partition",
            ));
        }
        // Seeking past the end is legal; writing there is what fails.
        self.position = position as u64;
        self.inner
            .seek(SeekFrom::Start(self.region.offset + self.position))?;
        Ok(self.position)
    }
}

#[cfg(test)]
mod tests {
    use super::{Region, RegionIo};
    use std::io::{Cursor, Read, Seek, SeekFrom, Write};

    fn window() -> RegionIo<Cursor<Vec<u8>>> {
        // 32 bytes, with a 8-byte window starting at 8.
        let data = (0u8..32).collect::<Vec<_>>();
        RegionIo::new(
            Cursor::new(data),
            Region {
                offset: 8,
                length: 8,
            },
        )
        .unwrap()
    }

    #[test]
    fn reads_start_at_the_region_and_stop_at_its_end() {
        let mut io = window();
        let mut buffer = [0u8; 32];

        let read = io.read(&mut buffer).unwrap();

        assert_eq!(read, 8);
        assert_eq!(&buffer[..8], &[8, 9, 10, 11, 12, 13, 14, 15]);
        // Nothing beyond the region is reachable.
        assert_eq!(io.read(&mut buffer).unwrap(), 0);
    }

    #[test]
    fn writes_cannot_run_past_the_partition_into_what_follows() {
        let mut io = window();

        io.seek(SeekFrom::Start(6)).unwrap();
        assert_eq!(io.write(&[0xAA; 4]).unwrap(), 2);

        // The next write has nowhere to go and must say so.
        let error = io.write(&[0xAA; 4]).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::WriteZero);

        let data = io.inner.into_inner();
        assert_eq!(&data[14..16], &[0xAA, 0xAA]);
        // The byte after the region is untouched.
        assert_eq!(data[16], 16);
    }

    #[test]
    fn seeking_is_relative_to_the_partition_not_the_file() {
        let mut io = window();

        assert_eq!(io.seek(SeekFrom::Start(0)).unwrap(), 0);
        assert_eq!(io.seek(SeekFrom::End(0)).unwrap(), 8);
        assert_eq!(io.seek(SeekFrom::Current(-3)).unwrap(), 5);

        let mut byte = [0u8; 1];
        io.read_exact(&mut byte).unwrap();
        assert_eq!(byte[0], 13);
    }

    #[test]
    fn seeking_before_the_partition_is_refused() {
        let mut io = window();

        assert!(io.seek(SeekFrom::Start(0)).is_ok());
        assert!(io.seek(SeekFrom::Current(-1)).is_err());
    }
}
