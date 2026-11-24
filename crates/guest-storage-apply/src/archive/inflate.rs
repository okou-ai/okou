//! Read ahead while the only active archive task is writing its tar entries.

use crate::error::DownloadError;
use crate::source::{
    HttpBodyReadFailure, LocalArchive, LocalArchiveAttemptMetrics, measure_local_body,
};
use flate2::read::GzDecoder;
use std::fs::File;
use std::io::{self, Read};
use std::os::unix::fs::FileExt;
use std::path::Path;
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::thread;
use std::time::Duration;

const STAGED_ARTIFACT_BYTES: std::ops::Range<u64> = 1024 * 1024..4 * 1024 * 1024;
const MIN_EXPANDED_BYTES: u32 = 8 * 1024 * 1024;
const BLOCK_BYTES: usize = 64 * 1024;
const BLOCK_COUNT: usize = 2;

type DecodedBlock = (Vec<u8>, usize);

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
) -> Result<(), DownloadError> {
    // The Guest workload reserves part of a core for the control plane.
    // Its fractional CPU quota can round down in available_parallelism even
    // when this thread and the inflater are eligible to use different CPUs.
    if let Some(compressed_bytes) = archive
        .compressed_bytes
        .filter(|size| STAGED_ARTIFACT_BYTES.contains(size))
        && has_expanded_work(&archive.file, compressed_bytes)
        && rustix::thread::sched_getaffinity(None).is_ok_and(|cpus| cpus.count() >= 2)
        && let Some((result, body_read)) = try_extract(&mut archive.file, target)
    {
        if let Some(metrics) = metrics {
            metrics.record_body_read(body_read);
        }
        return result;
    }
    super::extract_tar_gz(archive.into_source(metrics), target, 1)
}

fn has_expanded_work(file: &File, compressed_bytes: u64) -> bool {
    // A gzip member ends with ISIZE, the low 32 bits of its decoded size.
    // Look at it only as a scheduling hint. The decoder still validates the
    // trailer, and neither the memory budget nor extraction depends on this value.
    let mut size = [0; size_of::<u32>()];
    let offset = compressed_bytes - size.len() as u64;
    file.read_exact_at(&mut size, offset).is_ok() && u32::from_le_bytes(size) >= MIN_EXPANDED_BYTES
}

/// None means the worker could not start and the archive has not been read.
fn try_extract(file: &mut File, target: &Path) -> Option<(Result<(), DownloadError>, Duration)> {
    thread::scope(|scope| {
        let (ready_tx, ready) = sync_channel(1);
        // Each block belongs to one of the worker, reader or queues. Dropping
        // the reader closes both channels, even on an early extraction error.
        let (recycle, recycle_rx) = sync_channel(BLOCK_COUNT);
        let worker = thread::Builder::new()
            .name("archive-inflate".into())
            .spawn_scoped(scope, move || inflate(file, ready_tx, recycle_rx))
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
            1,
            u64::MAX,
            |_, _, _, _| Ok(()),
        );
        // A closed ready channel also follows a producer panic. Do not treat
        // that as a validated gzip trailer, even when the tar reader reached EOF.
        Some(match worker.join() {
            Ok(body_read) => (result, body_read),
            Err(_) => (
                result.and(Err(DownloadError::new("Archive inflate worker panicked"))),
                Duration::ZERO,
            ),
        })
    })
}

fn inflate(
    file: &mut File,
    ready: SyncSender<io::Result<DecodedBlock>>,
    recycle: Receiver<Vec<u8>>,
) -> Duration {
    let metrics = LocalArchiveAttemptMetrics::default();
    let mut decoder = GzDecoder::new(measure_local_body(file, &metrics));
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
