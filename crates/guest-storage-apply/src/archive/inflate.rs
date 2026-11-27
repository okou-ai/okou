//! Bounded gzip read-ahead while the archive writer processes tar entries.

use crate::error::DownloadError;
use crate::source::{
    HttpBodyReadFailure, LocalArchive, LocalArchiveAttemptMetrics, measure_local_body,
};
use flate2::bufread::GzDecoder;
use std::io::{self, BufReader, Read};
use std::os::unix::fs::FileExt;
use std::path::Path;
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::thread;
use std::time::Duration;

const MIN_COMPRESSED_BYTES: u64 = 256 * 1024;
const MIN_TWO_WORKER_ARTIFACT_EXPANDED_BYTES: u32 = 8 * 1024 * 1024;
const TAR_PREFIX_BYTES: u64 = 128 * 1024;
// Fewer input refills and decoded block handoffs during extraction.
const COMPRESSED_BUFFER_BYTES: usize = 128 * 1024;
const BLOCK_BYTES: usize = 256 * 1024;
const BLOCK_COUNT: usize = 2;

type DecodedBlock = (Vec<u8>, usize);

#[derive(Clone, Copy)]
pub(crate) enum InflateLoad {
    Light,
    WideBatch,
}

impl InflateLoad {
    fn writer_concurrency(self, concurrency: usize) -> usize {
        match self {
            Self::Light => 1,
            Self::WideBatch => concurrency,
        }
    }

    fn can_read_ahead(
        self,
        compressed_bytes: Option<u64>,
        read_exact_at: impl Fn(&mut [u8], u64) -> io::Result<()>,
    ) -> bool {
        let (max_compressed_bytes, min_expanded_bytes) = match self {
            Self::Light => (4 * 1024 * 1024, 8 * 1024 * 1024),
            // Wide batches share CPU with ordinary archive workers. Require more
            // expanded work and a prefix of small regular files.
            Self::WideBatch => (1024 * 1024, 24 * 1024 * 1024),
        };
        let Some(compressed_bytes) = compressed_bytes
            .filter(|size| (MIN_COMPRESSED_BYTES..max_compressed_bytes).contains(size))
        else {
            return false;
        };
        // Affinity can expose two CPUs even when the Guest workload's
        // fractional CPU quota rounds down in available_parallelism.
        has_expanded_work(&read_exact_at, compressed_bytes, min_expanded_bytes)
            && rustix::thread::sched_getaffinity(None).is_ok_and(|cpus| cpus.count() >= 2)
            && (matches!(self, Self::Light)
                || has_small_file_prefix(read_exact_at, 16, 8 * 1024, None))
    }
}

struct InflateReader {
    ready: Receiver<io::Result<DecodedBlock>>,
    recycle: SyncSender<Vec<u8>>,
    block: Vec<u8>,
    end: usize,
    offset: usize,
}

impl Read for InflateReader {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        if self.offset == self.end {
            if !self.block.is_empty() {
                // One of the fixed number of buffers is held here, so the
                // recycle queue has room unless the producer already exited.
                let _ = self.recycle.send(std::mem::take(&mut self.block));
            }
            let Ok(next) = self.ready.recv() else {
                return Ok(0);
            };
            (self.block, self.end) = next?;
            self.offset = 0;
        }
        let count = output.len().min(self.end - self.offset);
        let remaining = self.block.split_at(self.offset).1;
        output
            .split_at_mut(count)
            .0
            .copy_from_slice(remaining.split_at(count).0);
        self.offset += count;
        Ok(count)
    }
}

pub(crate) fn extract_staged(
    mut archive: LocalArchive,
    target: &Path,
    metrics: Option<&LocalArchiveAttemptMetrics>,
    concurrency: usize,
    load: InflateLoad,
) -> Result<(), DownloadError> {
    let concurrency = load.writer_concurrency(concurrency);
    if load.can_read_ahead(archive.compressed_bytes, |output, offset| {
        archive.file.read_exact_at(output, offset)
    }) && let Some(result) = try_extract(&mut archive.file, target, concurrency, metrics)
    {
        return result;
    }
    super::extract_tar_gz(archive.into_source(metrics), target, concurrency)
}

pub(crate) fn extract_inline(
    bytes: &[u8],
    target: &Path,
    metrics: Option<&LocalArchiveAttemptMetrics>,
    concurrency: usize,
    load: InflateLoad,
) -> Result<(), DownloadError> {
    let concurrency = load.writer_concurrency(concurrency);
    let compressed_bytes = Some(bytes.len() as u64);
    if load.can_read_ahead(compressed_bytes, |output, offset| {
        read_inline_at(bytes, output, offset)
    }) && let Some(result) = try_extract(bytes, target, concurrency, metrics)
    {
        return result;
    }
    super::extract_tar_gz(
        crate::source::ArchiveSource::inline(bytes),
        target,
        concurrency,
    )
}

fn read_inline_at(bytes: &[u8], output: &mut [u8], offset: u64) -> io::Result<()> {
    let mut remaining = usize::try_from(offset)
        .ok()
        .and_then(|offset| bytes.get(offset..))
        .ok_or(io::ErrorKind::UnexpectedEof)?;
    remaining.read_exact(output)
}

fn has_expanded_work(
    read_exact_at: impl Fn(&mut [u8], u64) -> io::Result<()>,
    compressed_bytes: u64,
    min_expanded_bytes: u32,
) -> bool {
    // A gzip member ends with ISIZE, the low 32 bits of its decoded size.
    // Look at it only as a scheduling hint. The decoder still validates the
    // trailer, and neither the memory budget nor extraction depends on this value.
    let mut size = [0; size_of::<u32>()];
    let offset = compressed_bytes - size.len() as u64;
    read_exact_at(&mut size, offset).is_ok() && u32::from_le_bytes(size) >= min_expanded_bytes
}

pub(crate) fn has_small_inline_file_prefix(archive: &[u8]) -> bool {
    has_small_file_prefix(
        |output, offset| read_inline_at(archive, output, offset),
        8,
        16 * 1024,
        Some(TAR_PREFIX_BYTES),
    )
}

pub(crate) fn inline_artifact_size_is_eligible(archive: &[u8]) -> bool {
    // Use the gzip length hint to stay within the measured Memory size range.
    // Full extraction still owns gzip validation.
    (1024 * 1024..4 * 1024 * 1024).contains(&archive.len())
        && inline_expanded_bytes(archive).is_some_and(|size| {
            (MIN_TWO_WORKER_ARTIFACT_EXPANDED_BYTES..16 * 1024 * 1024).contains(&size)
        })
}

pub(crate) fn small_companion_expanded_bytes(archive: &[u8]) -> Option<u32> {
    inline_expanded_bytes(archive).filter(|&size| size < MIN_TWO_WORKER_ARTIFACT_EXPANDED_BYTES)
}

fn inline_expanded_bytes(archive: &[u8]) -> Option<u32> {
    archive.last_chunk::<4>().copied().map(u32::from_le_bytes)
}

fn has_small_file_prefix(
    read_exact_at: impl Fn(&mut [u8], u64) -> io::Result<()>,
    sample_files: usize,
    max_file_bytes: u64,
    max_following_entry_bytes: Option<u64>,
) -> bool {
    const COMPRESSED_PREFIX_BYTES: usize = 16 * 1024;

    let mut compressed = [0; COMPRESSED_PREFIX_BYTES];
    if read_exact_at(&mut compressed, 0).is_err() {
        return false;
    }
    let decoder = GzDecoder::new(compressed.as_slice()).take(TAR_PREFIX_BYTES);
    let mut sample = tar::Archive::new(decoder);
    // Raw entries are enough for the work estimate. Full extraction parses
    // extended metadata and validates the complete gzip stream.
    sample.entries().is_ok_and(|entries| {
        let mut entries = entries.raw(true);
        let small_files = entries
            .by_ref()
            .take(sample_files)
            .take_while(|entry| {
                entry.as_ref().is_ok_and(|entry| {
                    entry.header().entry_type().is_file() && entry.size() <= max_file_bytes
                })
            })
            .count();
        small_files == sample_files
            && max_following_entry_bytes.is_none_or(|limit| {
                // Only headers readable within the same sample inform this hint.
                entries
                    .map_while(Result::ok)
                    .all(|entry| entry.size() <= limit)
            })
    })
}

/// None means the worker could not start and the archive has not been read.
fn try_extract(
    reader: impl Read + Send,
    target: &Path,
    concurrency: usize,
    metrics: Option<&LocalArchiveAttemptMetrics>,
) -> Option<Result<(), DownloadError>> {
    let (result, body_read) = thread::scope(|scope| {
        let (ready_tx, ready) = sync_channel(1);
        // Each block belongs to one of the worker, reader or queues. Dropping
        // the reader closes both channels, even on an early extraction error.
        let (recycle, recycle_rx) = sync_channel(BLOCK_COUNT);
        let worker = thread::Builder::new()
            .name("archive-inflate".into())
            .spawn_scoped(scope, move || inflate(reader, ready_tx, recycle_rx))
            .ok()?;
        let result = super::extract_tar(
            InflateReader {
                ready,
                recycle,
                block: Vec::new(),
                end: 0,
                offset: 0,
            },
            HttpBodyReadFailure::disabled(),
            target,
            concurrency,
            u64::MAX,
            |_, _, _, _| Ok(()),
        );
        // A closed ready channel also follows a producer panic. Do not treat
        // that as a validated gzip trailer, even when the tar reader reached EOF.
        Some(match worker.join() {
            Ok(body_read) => (result, body_read),
            Err(_) => (
                Err(DownloadError::new("Archive inflate worker panicked")),
                Duration::ZERO,
            ),
        })
    })?;
    if let Some(metrics) = metrics {
        metrics.record_body_read(body_read);
    }
    Some(result)
}

fn inflate(
    reader: impl Read,
    ready: SyncSender<io::Result<DecodedBlock>>,
    recycle: Receiver<Vec<u8>>,
) -> Duration {
    let metrics = LocalArchiveAttemptMetrics::default();
    let mut decoder = GzDecoder::new(BufReader::with_capacity(
        COMPRESSED_BUFFER_BYTES,
        measure_local_body(reader, &metrics),
    ));
    let buffers: [_; BLOCK_COUNT] = std::array::from_fn(|_| vec![0; BLOCK_BYTES]);
    for mut buffer in buffers.into_iter().chain(recycle) {
        let read = loop {
            match decoder.read(&mut buffer) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                result => break result,
            }
        };
        let message = match read {
            Ok(0) => break,
            Ok(read) => Ok((buffer, read)),
            Err(error) => {
                let _ = ready.send(Err(error));
                break;
            }
        };
        if ready.send(message).is_err() {
            break;
        }
    }
    metrics.body_read()
}

#[cfg(test)]
mod tests;
