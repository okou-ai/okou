//! Complete original-artifact byte verification for native fixtures.

use std::io::{self, IoSliceMut};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

use sha2::{Digest, Sha256};

use super::super::TestResult;

const BLOCK_BYTES: usize = 4096;
const BUFFER_BLOCKS: usize = 256;

#[repr(align(4096))]
struct AlignedBlock([u8; BLOCK_BYTES]);

pub(crate) fn file_sha256(path: &Path) -> TestResult<String> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECT | libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let before = file.metadata()?;
    if !before.file_type().is_file() {
        return Err(io::Error::other("native artifact is not a regular file").into());
    }
    let limit = before
        .len()
        .checked_add(1)
        .ok_or_else(|| io::Error::other("native artifact length overflow"))?;
    let mut hash = Sha256::new();
    let mut blocks: Vec<_> = (0..BUFFER_BLOCKS)
        .map(|_| AlignedBlock([0; BLOCK_BYTES]))
        .collect();
    let mut total = 0_u64;
    while total < limit {
        // A partial final read leaves an unaligned logical cursor. Re-read its
        // aligned prefix so the next direct request can positively observe EOF.
        let offset = total / BLOCK_BYTES as u64 * BLOCK_BYTES as u64;
        let prefix = (total - offset) as usize;
        let wanted = (limit - total).min((BUFFER_BLOCKS * BLOCK_BYTES - prefix) as u64) as usize;
        let count_blocks = (prefix + wanted).div_ceil(BLOCK_BYTES);
        let count = {
            let mut vectors: Vec<_> = blocks
                .iter_mut()
                .take(count_blocks)
                .map(|block| IoSliceMut::new(&mut block.0))
                .collect();
            rustix::io::preadv(&file, &mut vectors, offset).map_err(io::Error::from)?
        };
        let fresh = count
            .checked_sub(prefix)
            .ok_or_else(|| io::Error::other("native artifact shrank while hashing"))?;
        if fresh == 0 {
            break;
        }
        if fresh as u64 > before.len() - total {
            return Err(io::Error::other("native artifact grew while hashing").into());
        }
        let mut skip = prefix;
        let mut remaining = count;
        for block in blocks.iter().take(count_blocks) {
            let length = remaining.min(BLOCK_BYTES);
            if skip < length {
                hash.update(block.0.get(skip..length).ok_or_else(|| {
                    io::Error::other("native artifact read exceeded its aligned block")
                })?);
            }
            skip = skip.saturating_sub(length);
            remaining -= length;
            if remaining == 0 {
                break;
            }
        }
        total += fresh as u64;
    }
    let after = file.metadata()?;
    if total != before.len()
        || before.len() != after.len()
        || (
            before.mtime(),
            before.mtime_nsec(),
            before.ctime(),
            before.ctime_nsec(),
        ) != (
            after.mtime(),
            after.mtime_nsec(),
            after.ctime(),
            after.ctime_nsec(),
        )
    {
        return Err(io::Error::other("native artifact changed while hashing").into());
    }
    Ok(hex::encode(hash.finalize()))
}

#[cfg(test)]
mod tests;
