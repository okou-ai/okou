use std::fs::{File, Metadata};
use std::io;
use std::ops::Range;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::Path;

use tokio_util::sync::CancellationToken;

use super::MAX_RANGES;

const SCAN_PAGES: usize = 4096;
const READ_BUFFER_BYTES: usize = 256 * 1024;

#[derive(PartialEq, Eq)]
struct Identity {
    device: u64,
    inode: u64,
    size: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}

impl Identity {
    fn of(metadata: &Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            size: metadata.len(),
            modified: (metadata.mtime(), metadata.mtime_nsec()),
            changed: (metadata.ctime(), metadata.ctime_nsec()),
        }
    }
}

pub(super) struct Envelope {
    identity: Identity,
    ranges: Vec<Range<usize>>,
}

impl Envelope {
    pub(super) fn bytes(&self) -> usize {
        self.ranges.iter().map(Range::len).sum()
    }

    pub(super) fn range_count(&self) -> usize {
        self.ranges.len()
    }
}

#[derive(Default)]
pub(super) struct PrefetchStats {
    pub(super) requested_bytes: usize,
    pub(super) resident_bytes: usize,
}

/// The published memory file is immutable for its factory lifetime. This
/// mapping never accesses its contents; mincore observes only cache residency.
struct Residency {
    address: *mut libc::c_void,
    size: usize,
    page_size: usize,
}

impl Residency {
    fn new(file: &File) -> io::Result<Self> {
        let size = usize::try_from(file.metadata()?.len()).map_err(io::Error::other)?;
        // SAFETY: sysconf has no pointer arguments and does not change state.
        let page_size = usize::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) })
            .map_err(io::Error::other)?;
        if size == 0 || size > isize::MAX as usize || page_size == 0 {
            return Err(io::Error::other("invalid snapshot memory mapping size"));
        }
        // SAFETY: valid open file, nonzero bounded size, no fixed address or
        // writable mapping. The mapping is owned until its matching munmap.
        let address = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                size,
                libc::PROT_NONE,
                libc::MAP_PRIVATE,
                file.as_raw_fd(),
                0,
            )
        };
        if address == libc::MAP_FAILED {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            address,
            size,
            page_size,
        })
    }

    fn observe(&self, range: Range<usize>, vector: &mut [u8]) -> io::Result<()> {
        if range.is_empty()
            || !range.start.is_multiple_of(self.page_size)
            || range.end > self.size
            || vector.len() < range.len().div_ceil(self.page_size)
        {
            return Err(io::Error::other("invalid snapshot residency range"));
        }
        // SAFETY: range is page-aligned and inside our live mapping. The
        // output vector has at least one byte per mapped page. No file bytes
        // are dereferenced; the kernel writes only to the supplied vector.
        let result = unsafe {
            libc::mincore(
                self.address.cast::<u8>().add(range.start).cast(),
                range.len(),
                vector.as_mut_ptr().cast(),
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

impl Drop for Residency {
    fn drop(&mut self) {
        // SAFETY: this is exactly the still-owned address/size from mmap.
        unsafe { libc::munmap(self.address, self.size) };
    }
}

pub(super) fn learn(
    path: &Path,
    stop: &CancellationToken,
    byte_budget: usize,
) -> io::Result<Option<Envelope>> {
    if stop.is_cancelled() {
        return Ok(None);
    }
    let file = File::open(path)?;
    let identity = Identity::of(&file.metadata()?);
    let map = Residency::new(&file)?;
    let mut vector = vec![0u8; SCAN_PAGES];
    let mut ranges: Vec<Range<usize>> = Vec::new();
    let mut bytes = 0;
    for offset in (0..map.size).step_by(SCAN_PAGES * map.page_size) {
        if stop.is_cancelled() {
            return Ok(None);
        }
        let end = map.size.min(offset + SCAN_PAGES * map.page_size);
        let pages = (end - offset).div_ceil(map.page_size);
        let observed = vector
            .get_mut(..pages)
            .ok_or_else(|| io::Error::other("snapshot residency buffer too small"))?;
        map.observe(offset..end, observed)?;
        for (index, entry) in observed.iter().enumerate() {
            if entry & 1 == 0 {
                continue;
            }
            let start = offset + index * map.page_size;
            let end = map.size.min(start + map.page_size);
            bytes += end - start;
            if bytes > byte_budget {
                return Ok(None);
            }
            match ranges.last_mut() {
                Some(range) if range.end == start => range.end = end,
                _ => ranges.push(start..end),
            }
            if ranges.len() > MAX_RANGES {
                return Ok(None);
            }
        }
    }
    if ranges.is_empty() {
        return Ok(None);
    }
    if Identity::of(&file.metadata()?) != identity {
        return Err(io::Error::other("snapshot memory changed during learning"));
    }
    Ok(Some(Envelope { identity, ranges }))
}

pub(super) fn prefetch(
    path: &Path,
    envelope: &Envelope,
    stop: &CancellationToken,
) -> io::Result<PrefetchStats> {
    if stop.is_cancelled() {
        return Ok(PrefetchStats::default());
    }
    let file = File::open(path)?;
    if Identity::of(&file.metadata()?) != envelope.identity {
        return Err(io::Error::other("snapshot memory identity changed"));
    }
    let map = Residency::new(&file)?;
    let mut buffer = Vec::new();
    let mut stats = PrefetchStats::default();
    for range in &envelope.ranges {
        if stop.is_cancelled() {
            break;
        }
        let mut vector = vec![0u8; range.len().div_ceil(map.page_size)];
        map.observe(range.clone(), &mut vector)?;
        let mut missing_start = None;
        for (index, entry) in vector.iter().enumerate() {
            let offset = range.start + index * map.page_size;
            if entry & 1 == 0 {
                missing_start.get_or_insert(offset);
            } else {
                stats.resident_bytes += map.page_size.min(range.end - offset);
                if let Some(start) = missing_start.take() {
                    read_missing(&file, start..offset, &mut buffer, stop, &mut stats)?;
                }
            }
        }
        if let Some(start) = missing_start {
            read_missing(&file, start..range.end, &mut buffer, stop, &mut stats)?;
        }
    }
    Ok(stats)
}

fn read_missing(
    file: &File,
    range: Range<usize>,
    buffer: &mut Vec<u8>,
    stop: &CancellationToken,
    stats: &mut PrefetchStats,
) -> io::Result<()> {
    let mut offset = range.start;
    while offset < range.end && !stop.is_cancelled() {
        if buffer.is_empty() {
            buffer.resize(READ_BUFFER_BYTES, 0);
        }
        let length = buffer.len().min(range.end - offset);
        let chunk = buffer
            .get_mut(..length)
            .ok_or_else(|| io::Error::other("snapshot read buffer too small"))?;
        file.read_exact_at(chunk, offset as u64)?;
        stats.requested_bytes += length;
        offset += length;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
