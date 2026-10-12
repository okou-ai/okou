//! Contract for preparing a completed guest for idle reuse.

use serde::{Deserialize, Serialize};

/// Helper completed successfully and emitted a reuse-preparation report.
pub const REUSE_PREPARATION_EXIT_SUCCESS: i32 = 0;
/// The helper request was missing or invalid.
pub const REUSE_PREPARATION_EXIT_INVALID_REQUEST: i32 = 2;
/// Root filesystem capacity could not be inspected.
pub const REUSE_PREPARATION_EXIT_INSPECTION_FAILED: i32 = 3;
/// Stale runner-owned runtime state could not be safely removed.
pub const REUSE_PREPARATION_EXIT_CLEANUP_FAILED: i32 = 4;
/// Exec process containment could not be proven ready for reuse.
pub const REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED: i32 = 5;
/// The runner-owned workspace-mount stage failed after helper success.
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

/// User-available capacity on the guest root filesystem.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootFilesystemCapacity {
    /// Bytes available to an unprivileged guest process.
    pub available_bytes: u64,
    /// Inodes available to an unprivileged guest process.
    pub available_inodes: u64,
}

/// Result emitted after stale runner-owned runtime state is reclaimed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReusePreparationReport {
    /// Rootfs capacity observed before cleanup.
    pub before: RootFilesystemCapacity,
    /// Rootfs capacity observed after cleanup.
    pub after: RootFilesystemCapacity,
    /// Number of unprotected entries removed directly below the runtime parent.
    pub removed_entries: u64,
}
