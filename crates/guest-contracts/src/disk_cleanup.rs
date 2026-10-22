//! Paired Runner/Guest contract for bounded pre-agent disk recovery.

use serde::{Deserialize, Serialize};

/// Guest filesystem whose disposable caches may be reclaimed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiskCleanupFilesystem {
    /// The persistent `/home/user` filesystem.
    Home,
    /// The guest root filesystem, excluding mounted home.
    Rootfs,
}

impl DiskCleanupFilesystem {
    /// Fixed helper argument; no caller-controlled cleanup paths are accepted.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Rootfs => "rootfs",
        }
    }
}

/// Capacity observed on the selected filesystem before and after cleanup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiskCleanupReport {
    /// Filesystem actually inspected and cleaned.
    pub filesystem: DiskCleanupFilesystem,
    /// Bytes available to the unprivileged user before cleanup.
    pub available_bytes_before: u64,
    /// Bytes available to the unprivileged user after cleanup.
    pub available_bytes_after: u64,
    /// Inodes available before cleanup.
    pub available_inodes_before: u64,
    /// Inodes available after cleanup.
    pub available_inodes_after: u64,
    /// Immediate cache children removed, excluding descendants; not an allocation estimate.
    pub removed_entries: u64,
}

impl DiskCleanupReport {
    /// Whether measured improvement leaves a bounded bootstrap retry reserve.
    #[must_use]
    pub const fn permits_retry(&self) -> bool {
        self.available_bytes_after >= 64 * 1024 * 1024
            && self.available_inodes_after >= 128
            && (self.available_bytes_after > self.available_bytes_before
                || self.available_inodes_after > self.available_inodes_before)
    }
}
