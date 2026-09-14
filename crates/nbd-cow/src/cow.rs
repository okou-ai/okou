//! Copy-on-write storage layer for `nbd-cow`.
//!
//! [`CowLayer`] serves reads from pending writes, then dirty blocks in the COW
//! file, then the read-only base image. Writes are collected in memory and
//! flushed to a sparse COW file; a bitmap sidecar records which blocks have been
//! materialized when snapshots are kept.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, IoSlice};
use std::ops::Range;
use std::os::unix::fs::FileExt;
use std::path::Path;
#[cfg(test)]
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use bitvec::prelude::*;

use crate::error::{NbdCowError, Result};

mod bitmap;

const MAX_WRITE_IOVECS: usize = libc::UIO_MAXIOV as usize;

#[cfg(test)]
pub(crate) use bitmap::bitmap_tmp_path_for;
pub use bitmap::{bitmap_path_for, validate_bitmap, validate_bitmap_cow_coverage};

#[derive(Clone, Copy, Eq, PartialEq)]
enum FileReadSource {
    Base,
    Cow,
}

struct FileReadRun {
    source: FileReadSource,
    absolute_offset: u64,
    buffer_offset: usize,
    len: usize,
}

impl FileReadRun {
    fn new(source: FileReadSource, span: &BlockSpan) -> Self {
        Self {
            source,
            absolute_offset: span.absolute_offset,
            buffer_offset: span.buffer_offset,
            len: span.len,
        }
    }

    fn can_extend(&self, source: FileReadSource, span: &BlockSpan) -> bool {
        let Some(next_absolute_offset) = self.absolute_offset.checked_add(self.len as u64) else {
            return false;
        };
        let Some(next_buffer_offset) = self.buffer_offset.checked_add(self.len) else {
            return false;
        };
        self.source == source
            && next_absolute_offset == span.absolute_offset
            && next_buffer_offset == span.buffer_offset
    }

    fn extend(&mut self, span: &BlockSpan) {
        self.len += span.len;
    }

    fn buffer_range(&self) -> Range<usize> {
        self.buffer_offset..self.buffer_offset + self.len
    }
}

#[cfg(test)]
#[derive(Default)]
struct ReadCallCounts {
    base: AtomicUsize,
    cow: AtomicUsize,
}

struct BlockSpan {
    block_idx: u64,
    absolute_offset: u64,
    block_offset: usize,
    buffer_offset: usize,
    len: usize,
}

impl BlockSpan {
    fn buffer_range(&self) -> Range<usize> {
        self.buffer_offset..self.buffer_offset + self.len
    }

    fn block_range(&self) -> Range<usize> {
        self.block_offset..self.block_offset + self.len
    }

    fn is_full_block(&self, block_size: usize) -> bool {
        self.block_offset == 0 && self.len == block_size
    }
}

struct BlockSpans {
    offset: u64,
    len: usize,
    block_size: usize,
    pos: usize,
}

impl BlockSpans {
    fn new(offset: u64, len: usize, block_size: usize) -> Self {
        debug_assert!(block_size > 0);
        Self {
            offset,
            len,
            block_size,
            pos: 0,
        }
    }
}

impl Iterator for BlockSpans {
    type Item = BlockSpan;

    fn next(&mut self) -> Option<Self::Item> {
        if self.pos >= self.len {
            return None;
        }

        let absolute_offset = self.offset + self.pos as u64;
        let block_idx = absolute_offset / self.block_size as u64;
        let block_offset = (absolute_offset % self.block_size as u64) as usize;
        let remaining_in_block = self.block_size - block_offset;
        let len = remaining_in_block.min(self.len - self.pos);
        let span = BlockSpan {
            block_idx,
            absolute_offset,
            block_offset,
            buffer_offset: self.pos,
            len,
        };
        self.pos += len;
        Some(span)
    }
}

/// COW (Copy-on-Write) layer with write buffering.
///
/// Reads check: write buffer -> dirty COW file -> base image.
/// Writes accumulate in an in-memory buffer. [`CowLayer::write`] reports when
/// buffered bytes reach or exceed the flush threshold, but does not flush them.
/// Callers choose when to invoke [`CowLayer::flush`].
/// [`crate::cow_io::CowIo::write`] acts on the signal and flushes automatically.
pub struct CowLayer {
    /// Read-only base image file.
    base_fd: File,
    /// Path for the sparse COW file (opened or created when buffered writes are
    /// flushed).
    cow_path: std::path::PathBuf,
    /// Open COW file handle (lazily opened when buffered writes are flushed).
    cow_fd: Option<File>,
    /// 1 bit per block: set if the block has been written (and flushed to COW file).
    dirty: BitVec,
    /// Pending writes: block index -> block data.
    write_buffer: BTreeMap<u64, Vec<u8>>,
    /// Report that flushing is needed when buffer usage reaches or exceeds this
    /// threshold.
    flush_threshold: usize,
    /// Block size in bytes.
    block_size: usize,
    /// Total device size in bytes.
    size: u64,
    #[cfg(test)]
    read_call_counts: ReadCallCounts,
    #[cfg(test)]
    bitmap_rename_attempts: Option<Arc<AtomicUsize>>,
}

impl CowLayer {
    /// Create a new COW layer.
    ///
    /// If a bitmap sidecar file (`{cow_path}.bitmap`) exists, its dirty bitmap
    /// is restored. When the bitmap contains dirty blocks, the COW file is
    /// opened eagerly and validated to cover them. An empty restored bitmap
    /// leaves the COW file unopened until buffered writes are flushed. This
    /// enables snapshot restore: a previous `save_bitmap()` +
    /// `destroy_keep_cow()` cycle preserves the COW state, and a subsequent
    /// `new()` with the same paths picks it up automatically.
    ///
    /// `base_path`: read-only base image file
    /// `cow_path`: path for the sparse COW file (opened or created when buffered
    /// writes are flushed)
    /// `size`: total device size in bytes
    /// `block_size`: block size (typically 4096)
    /// `flush_threshold`: `write()` reports that a flush is needed when buffer
    /// usage reaches or exceeds this size in bytes
    ///
    /// # Errors
    ///
    /// Returns an invalid-input error if `block_size` is zero, if `size` is
    /// zero, or if `size` is not an exact multiple of `block_size`. The COW
    /// layer stores and restores full blocks internally, so partial final blocks
    /// are not supported.
    ///
    /// Returns an I/O error if the base image cannot be opened, or if an
    /// existing bitmap sidecar cannot be inspected or loaded. When the restored
    /// bitmap contains dirty blocks, also returns an I/O error if the associated
    /// COW file cannot be opened or validated to cover those blocks.
    pub fn new(
        base_path: &Path,
        cow_path: &Path,
        size: u64,
        block_size: usize,
        flush_threshold: usize,
    ) -> Result<Self> {
        if block_size == 0 {
            return Err(NbdCowError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "block_size must be positive",
            )));
        }
        if size == 0 {
            return Err(NbdCowError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "device size must be positive",
            )));
        }
        if !size.is_multiple_of(block_size as u64) {
            return Err(NbdCowError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("device size ({size}) must be a multiple of block_size ({block_size})"),
            )));
        }
        let base_fd = File::open(base_path)?;
        let num_blocks = (size as usize).div_ceil(block_size);

        // Auto-detect restore mode: load bitmap if a sidecar directory entry exists.
        let bitmap_path = bitmap_path_for(cow_path);
        let dirty = match std::fs::symlink_metadata(&bitmap_path) {
            Ok(_) => {
                let bv = bitmap::load_bitmap(&bitmap_path, num_blocks)?;
                tracing::info!(dirty_blocks = bv.count_ones(), "restored dirty bitmap");
                bv
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => bitvec![0; num_blocks],
            Err(e) => {
                return Err(NbdCowError::Io(std::io::Error::new(
                    e.kind(),
                    format!("stat dirty bitmap sidecar {}: {e}", bitmap_path.display()),
                )));
            }
        };

        // If bitmap has dirty bits, COW file must already exist — open it eagerly.
        let cow_fd = if dirty.count_ones() > 0 {
            let fd = File::options()
                .read(true)
                .write(true)
                .open(cow_path)
                .map_err(|e| {
                    NbdCowError::Io(std::io::Error::other(format!(
                        "dirty bitmap present but COW file cannot be opened: {e}"
                    )))
                })?;
            bitmap::validate_dirty_cow_coverage(&dirty, fd.metadata()?.len(), block_size)?;
            Some(fd)
        } else {
            None
        };

        Ok(Self {
            base_fd,
            cow_path: cow_path.to_path_buf(),
            cow_fd,
            dirty,
            write_buffer: BTreeMap::new(),
            flush_threshold,
            block_size,
            size,
            #[cfg(test)]
            read_call_counts: ReadCallCounts::default(),
            #[cfg(test)]
            bitmap_rename_attempts: None,
        })
    }

    /// Read `buf.len()` bytes starting at `offset`.
    ///
    /// Read path: write buffer -> COW file (if dirty) -> base image.
    pub fn read(&self, offset: u64, buf: &mut [u8]) -> Result<()> {
        self.check_bounds(offset, buf.len() as u64)?;

        let mut file_read_run: Option<FileReadRun> = None;
        for span in BlockSpans::new(offset, buf.len(), self.block_size) {
            // Check write buffer first
            if let Some(block_data) = self.write_buffer.get(&span.block_idx) {
                self.flush_file_read_run(&mut file_read_run, buf)?;
                let dest = buf.get_mut(span.buffer_range()).ok_or_else(|| {
                    NbdCowError::Io(std::io::Error::other("slice out of bounds in read"))
                })?;
                let src = block_data.get(span.block_range()).ok_or_else(|| {
                    NbdCowError::Io(std::io::Error::other("block_data slice out of bounds"))
                })?;
                dest.copy_from_slice(src);
            } else {
                let source = if self.is_dirty(span.block_idx) {
                    FileReadSource::Cow
                } else {
                    FileReadSource::Base
                };
                if let Some(run) = file_read_run.as_mut()
                    && run.can_extend(source, &span)
                {
                    run.extend(&span);
                    continue;
                }
                self.flush_file_read_run(&mut file_read_run, buf)?;
                file_read_run = Some(FileReadRun::new(source, &span));
            }
        }

        self.flush_file_read_run(&mut file_read_run, buf)?;

        Ok(())
    }

    /// Buffer `data` at `offset` and report whether the buffer needs flushing.
    ///
    /// Returns `true` when buffered bytes reach or exceed `flush_threshold`.
    /// This method does not invoke [`CowLayer::flush`].
    pub fn write(&mut self, offset: u64, data: &[u8]) -> Result<bool> {
        self.check_bounds(offset, data.len() as u64)?;

        for span in BlockSpans::new(offset, data.len(), self.block_size) {
            let src_slice = data.get(span.buffer_range()).ok_or_else(|| {
                NbdCowError::Io(std::io::Error::other("data src slice out of bounds"))
            })?;

            if let Some(block_data) = self.write_buffer.get_mut(&span.block_idx) {
                let dest_slice = block_data.get_mut(span.block_range()).ok_or_else(|| {
                    NbdCowError::Io(std::io::Error::other("block_data dest slice out of bounds"))
                })?;
                dest_slice.copy_from_slice(src_slice);
                continue;
            }

            if span.is_full_block(self.block_size) {
                self.write_buffer.insert(span.block_idx, src_slice.to_vec());
                continue;
            }

            let mut block_data = self.read_full_block(span.block_idx)?;
            let dest_slice = block_data.get_mut(span.block_range()).ok_or_else(|| {
                NbdCowError::Io(std::io::Error::other("block_data dest slice out of bounds"))
            })?;
            dest_slice.copy_from_slice(src_slice);
            self.write_buffer.insert(span.block_idx, block_data);
        }

        Ok(self.buffer_bytes() >= self.flush_threshold)
    }

    /// Flush the write buffer to the COW file.
    ///
    /// Adjacent blocks are submitted in bounded positioned batches. On I/O
    /// failure, the first incomplete block and all later blocks are restored
    /// to the buffer so no data is lost.
    pub fn flush(&mut self) -> Result<()> {
        if self.write_buffer.is_empty() {
            return Ok(());
        }

        self.ensure_cow_fd()?;
        let cow_fd = self
            .cow_fd
            .take()
            .ok_or_else(|| NbdCowError::Io(std::io::Error::other("cow_fd missing after ensure")))?;
        let result =
            self.flush_buffered(|offset, buffers| write_block_batch_at(&cow_fd, offset, buffers));
        self.cow_fd = Some(cow_fd);
        result
    }

    /// Drain `write_buffer` through `write_fn` in contiguous batches. The
    /// writer returns the number of bytes accepted from the concatenated
    /// buffers. On failure, restores the first incomplete block and all
    /// unprocessed blocks to `write_buffer` and returns the error. Dirty bits
    /// are set only for complete blocks.
    ///
    /// The writer boundary is a closure so tests can cover short writes and
    /// partial-success-then-fail at arbitrary byte offsets, which real-I/O
    /// injection (/dev/full, file seals, RLIMIT_FSIZE) cannot reproduce.
    fn flush_buffered<W>(&mut self, mut write_fn: W) -> Result<()>
    where
        W: FnMut(u64, &[IoSlice<'_>]) -> io::Result<usize>,
    {
        let block_size = self.block_size;
        let mut blocks = std::mem::take(&mut self.write_buffer)
            .into_iter()
            .peekable();
        let mut batch: Vec<(u64, Vec<u8>)> = Vec::new();

        while let Some(first_block) = blocks.next() {
            let first_block_idx = first_block.0;
            let mut previous_block_idx = first_block_idx;
            batch.push(first_block);
            while batch.len() < MAX_WRITE_IOVECS {
                let Some(next_block_idx) = blocks.peek().map(|(block_idx, _)| *block_idx) else {
                    break;
                };
                if previous_block_idx.checked_add(1) != Some(next_block_idx) {
                    break;
                }
                let Some(next_block) = blocks.next() else {
                    break;
                };
                previous_block_idx = next_block_idx;
                batch.push(next_block);
            }

            let offset = first_block_idx * block_size as u64;
            let batch_result = if let [(_, block_data)] = batch.as_slice() {
                let mut single_buffer = [IoSlice::new(block_data)];
                write_block_slices(offset, block_size, &mut single_buffer, &mut write_fn)
            } else {
                let mut buffers: Vec<IoSlice<'_>> = batch
                    .iter()
                    .map(|(_, block_data)| IoSlice::new(block_data))
                    .collect();
                write_block_slices(offset, block_size, buffers.as_mut_slice(), &mut write_fn)
            };

            match batch_result {
                Ok(()) => {
                    for (block_idx, _) in &batch {
                        self.set_dirty(*block_idx);
                    }
                    batch.clear();
                }
                Err((error, first_incomplete_block)) => {
                    for (position, (block_idx, block_data)) in batch.into_iter().enumerate() {
                        if position < first_incomplete_block {
                            self.set_dirty(block_idx);
                        } else {
                            self.write_buffer.insert(block_idx, block_data);
                        }
                    }
                    self.write_buffer.extend(blocks);
                    return Err(error.into());
                }
            }
        }

        Ok(())
    }

    /// Flush and fsync the COW file.
    pub fn sync(&mut self) -> Result<()> {
        self.flush()?;
        if let Some(ref cow_fd) = self.cow_fd {
            cow_fd.sync_all()?;
        }
        Ok(())
    }

    /// Number of dirty blocks (flushed to COW file).
    pub fn dirty_block_count(&self) -> usize {
        self.dirty.count_ones()
    }

    /// Number of blocks in the write buffer (not yet flushed).
    pub fn buffered_block_count(&self) -> usize {
        self.write_buffer.len()
    }

    /// Current write buffer size in bytes.
    pub fn buffer_bytes(&self) -> usize {
        self.write_buffer.len() * self.block_size
    }

    fn check_bounds(&self, offset: u64, length: u64) -> Result<()> {
        if offset.saturating_add(length) > self.size {
            return Err(NbdCowError::OutOfBounds {
                offset,
                length,
                device_size: self.size,
            });
        }
        Ok(())
    }

    fn is_dirty(&self, block_idx: u64) -> bool {
        debug_assert!(
            (block_idx as usize) < self.dirty.len(),
            "block_idx {block_idx} out of range (max {})",
            self.dirty.len()
        );
        self.dirty
            .get(block_idx as usize)
            .as_deref()
            .copied()
            .unwrap_or(false)
    }

    fn set_dirty(&mut self, block_idx: u64) {
        debug_assert!(
            (block_idx as usize) < self.dirty.len(),
            "block_idx {block_idx} out of range (max {})",
            self.dirty.len()
        );
        if let Some(mut bit) = self.dirty.get_mut(block_idx as usize) {
            *bit = true;
        }
    }

    fn read_file_span(&self, source: FileReadSource, offset: u64, dest: &mut [u8]) -> Result<()> {
        match source {
            FileReadSource::Base => {
                self.record_file_read(source);
                self.base_fd.read_exact_at(dest, offset)?;
            }
            FileReadSource::Cow => {
                let cow_fd = self.cow_fd.as_ref().ok_or_else(|| {
                    NbdCowError::Io(std::io::Error::other("dirty bit set but COW file not open"))
                })?;
                self.record_file_read(source);
                cow_fd.read_exact_at(dest, offset)?;
            }
        }
        Ok(())
    }

    fn flush_file_read_run(&self, run: &mut Option<FileReadRun>, buf: &mut [u8]) -> Result<()> {
        let Some(run) = run.take() else {
            return Ok(());
        };
        let dest = buf
            .get_mut(run.buffer_range())
            .ok_or_else(|| NbdCowError::Io(std::io::Error::other("slice out of bounds in read")))?;
        self.read_file_span(run.source, run.absolute_offset, dest)
    }

    #[cfg(test)]
    fn record_file_read(&self, source: FileReadSource) {
        match source {
            FileReadSource::Base => {
                self.read_call_counts.base.fetch_add(1, Ordering::Relaxed);
            }
            FileReadSource::Cow => {
                self.read_call_counts.cow.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    #[cfg(not(test))]
    fn record_file_read(&self, _source: FileReadSource) {}

    #[cfg(test)]
    fn base_read_call_count(&self) -> usize {
        self.read_call_counts.base.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    fn cow_read_call_count(&self) -> usize {
        self.read_call_counts.cow.load(Ordering::Relaxed)
    }

    /// Read a full block, preferring COW file if dirty, otherwise base image.
    fn read_full_block(&self, block_idx: u64) -> Result<Vec<u8>> {
        let mut buf = vec![0u8; self.block_size];
        let offset = block_idx * self.block_size as u64;

        if self.is_dirty(block_idx) {
            if let Some(ref cow_fd) = self.cow_fd {
                cow_fd.read_exact_at(&mut buf, offset)?;
                return Ok(buf);
            }
            return Err(NbdCowError::Io(std::io::Error::other(
                "dirty bit set but COW file not open",
            )));
        }

        self.base_fd.read_exact_at(&mut buf, offset)?;
        Ok(buf)
    }

    fn ensure_cow_fd(&mut self) -> Result<()> {
        if self.cow_fd.is_none() {
            let fd = File::options()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(&self.cow_path)?;
            self.cow_fd = Some(fd);
        }
        Ok(())
    }

    pub(crate) fn relocate_cow_file_after_rename(&mut self, cow_path: std::path::PathBuf) {
        self.cow_path = cow_path;
    }

    /// Save the dirty bitmap to a file.
    pub(crate) fn save_bitmap(&self, path: &Path) -> Result<()> {
        #[cfg(test)]
        if let Some(attempts) = &self.bitmap_rename_attempts {
            return bitmap::save_bitmap_with_first_rename_failure(&self.dirty, path, attempts);
        }
        bitmap::save_bitmap(&self.dirty, path)
    }

    /// Inject one filesystem rename failure without replacing the save transaction.
    #[cfg(test)]
    pub(crate) fn fail_first_bitmap_rename(&mut self) -> Arc<AtomicUsize> {
        let attempts = Arc::new(AtomicUsize::new(0));
        self.bitmap_rename_attempts = Some(attempts.clone());
        attempts
    }
}

fn write_block_slices<W>(
    mut offset: u64,
    block_size: usize,
    buffers: &mut [IoSlice<'_>],
    write_fn: &mut W,
) -> std::result::Result<(), (io::Error, usize)>
where
    W: FnMut(u64, &[IoSlice<'_>]) -> io::Result<usize>,
{
    let mut remaining = buffers;
    let mut completed_bytes = 0;

    loop {
        let written = match write_fn(offset, remaining) {
            Ok(0) => {
                return Err((
                    io::Error::new(io::ErrorKind::WriteZero, "failed to flush COW write batch"),
                    completed_bytes / block_size,
                ));
            }
            Ok(written) => written,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err((error, completed_bytes / block_size)),
        };

        completed_bytes += written;
        offset += written as u64;
        IoSlice::advance_slices(&mut remaining, written);
        if remaining.is_empty() {
            return Ok(());
        }
    }
}

fn write_block_batch_at(cow_fd: &File, offset: u64, buffers: &[IoSlice<'_>]) -> io::Result<usize> {
    if let [buffer] = buffers {
        cow_fd.write_all_at(buffer, offset)?;
        return Ok(buffer.len());
    }

    let offset = libc::off_t::try_from(offset).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("COW write offset {offset} exceeds off_t"),
        )
    })?;
    nix::sys::uio::pwritev(cow_fd, buffers, offset).map_err(io::Error::from)
}

#[cfg(test)]
mod tests;
