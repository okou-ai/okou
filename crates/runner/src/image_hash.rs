//! Validation for content-addressed hashes (rootfs and snapshot).
//!
//! Both `rootfs_hash` and `snapshot_hash` are produced as
//! `hex::encode(Sha256::digest(...))`, so the canonical format is
//! exactly 64 lowercase hex characters. The values are joined
//! against [`runner_host::paths::HomePaths::images_dir`] to form on-disk
//! paths, so any input containing `..`, `/`, or other path
//! metacharacters could escape the intended directory. This module is
//! the single source of truth for what counts as a safe hash value.

use crate::error::{RunnerError, RunnerResult};

/// Validate `hash` and return a [`RunnerError::Config`] with a uniform
/// message if it fails. Use this at every callsite that takes a hash
/// from the user (CLI flags, YAML config) so the error wording stays
/// consistent.
pub fn validate_or_err(hash: &str) -> RunnerResult<()> {
    if !validate_name(hash) {
        return Err(RunnerError::Config(format!(
            "invalid image hash: {hash} (must be 64 lowercase hex characters)"
        )));
    }
    Ok(())
}

/// Validate that `hash` is exactly 64 lowercase hex characters.
fn validate_name(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}

#[cfg(test)]
mod tests;
