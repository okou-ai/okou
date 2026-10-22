//! Contract for preparing a completed guest for idle reuse.

use serde::{Deserialize, Serialize};

/// Helper completed successfully and emitted a reuse-preparation report.
pub const REUSE_PREPARATION_EXIT_SUCCESS: i32 = 0;
/// The helper request was missing or invalid.
pub const REUSE_PREPARATION_EXIT_INVALID_REQUEST: i32 = 2;
/// Guest root or home filesystem capacity could not be inspected.
pub const REUSE_PREPARATION_EXIT_INSPECTION_FAILED: i32 = 3;
/// Stale runner-owned runtime state could not be safely removed.
pub const REUSE_PREPARATION_EXIT_CLEANUP_FAILED: i32 = 4;
/// Exec process containment could not be proven ready for reuse.
pub const REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED: i32 = 5;
/// The runner-owned home-mount stage failed after helper success.
///
/// This value is reserved for the composed runner wrapper and must not be used
/// for a guest-helper failure.
pub const REUSE_PREPARATION_EXIT_HOME_MOUNT_FAILED: i32 = 6;

/// Runtime directories that must remain available after reuse preparation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReusePreparationRequest {
    /// Runtime directory created for the completed run.
    pub current_runtime_dir: String,
    /// Earlier runtime directory still referenced by a retained session identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retained_runtime_dir: Option<String>,
}

/// User-available capacity on one guest filesystem.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemCapacity {
    /// Bytes available to an unprivileged guest process.
    pub available_bytes: u64,
    /// Inodes available to an unprivileged guest process.
    pub available_inodes: u64,
}

impl FilesystemCapacity {
    /// Stable admission reason when the home lacks bootstrap working capacity.
    #[must_use]
    pub const fn home_rejection_reason(self) -> Option<&'static str> {
        use crate::disk_cleanup::{MIN_HOME_AVAILABLE_BYTES, MIN_HOME_AVAILABLE_INODES};
        match (
            self.available_bytes < MIN_HOME_AVAILABLE_BYTES,
            self.available_inodes < MIN_HOME_AVAILABLE_INODES,
        ) {
            (true, true) => Some("home_low_bytes_and_inodes"),
            (true, false) => Some("home_low_bytes"),
            (false, true) => Some("home_low_inodes"),
            (false, false) => None,
        }
    }
}

/// Result emitted after stale runner-owned runtime state is reclaimed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReusePreparationReport {
    /// Rootfs capacity observed before cleanup.
    pub before: FilesystemCapacity,
    /// Rootfs capacity observed after cleanup.
    pub after: FilesystemCapacity,
    /// Home capacity observed after cleanup, independent of rootfs capacity.
    pub home: FilesystemCapacity,
    /// Number of unprotected entries removed directly below the runtime parent.
    pub removed_entries: u64,
}
