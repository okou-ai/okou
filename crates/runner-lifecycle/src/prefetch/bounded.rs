//! One bounded opened-file read contract for startup and guarded snapshot warming.

use std::io::Read as _;

#[cfg(any(test, feature = "test-support"))]
use super::PrefetchReadCheckpoint;
use super::{MEMORY_PREFETCH_CHUNK_BYTES, PrefetchOutcome};

pub(super) fn read(
    path: &std::path::Path,
    max_bytes: u64,
    stopped: impl Fn() -> bool,
    #[cfg(any(test, feature = "test-support"))] checkpoint: Option<&PrefetchReadCheckpoint>,
) -> PrefetchOutcome {
    if stopped() {
        return PrefetchOutcome::Cancelled { bytes: 0 };
    }
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) => return PrefetchOutcome::OpenFailed { error },
    };
    let expected = match file.metadata() {
        Ok(metadata) if metadata.len() <= max_bytes => metadata.len(),
        Ok(_) => {
            return PrefetchOutcome::ReadFailed {
                bytes: 0,
                error: std::io::Error::other("snapshot exceeds its declared read bound"),
            };
        }
        Err(error) => return PrefetchOutcome::ReadFailed { bytes: 0, error },
    };
    let mut buffer = vec![0_u8; MEMORY_PREFETCH_CHUNK_BYTES];
    let mut bytes = 0_u64;
    loop {
        if stopped() {
            return PrefetchOutcome::Cancelled { bytes };
        }
        let remaining = max_bytes.saturating_sub(bytes);
        if remaining == 0 {
            return if bytes == expected && file.metadata().is_ok_and(|m| m.len() == expected) {
                PrefetchOutcome::Complete { bytes }
            } else {
                PrefetchOutcome::ReadFailed {
                    bytes,
                    error: std::io::Error::other("snapshot read exceeded its declared bound"),
                }
            };
        }
        let count = match std::io::Read::by_ref(&mut file)
            .take(remaining)
            .read(&mut buffer)
        {
            Ok(count) => count,
            Err(error) => return PrefetchOutcome::ReadFailed { bytes, error },
        };
        #[cfg(any(test, feature = "test-support"))]
        if count > 0
            && let Some(checkpoint) = checkpoint
            && let Err(error) = checkpoint(bytes + count as u64)
        {
            return PrefetchOutcome::ReadFailed {
                bytes: bytes + count as u64,
                error,
            };
        }
        if stopped() {
            return PrefetchOutcome::Cancelled {
                bytes: bytes + count as u64,
            };
        }
        if count == 0 {
            return if bytes == expected && file.metadata().is_ok_and(|m| m.len() == expected) {
                PrefetchOutcome::Complete { bytes }
            } else {
                PrefetchOutcome::ReadFailed {
                    bytes,
                    error: std::io::Error::other("snapshot changed during its owned read"),
                }
            };
        }
        bytes += count as u64;
    }
}
