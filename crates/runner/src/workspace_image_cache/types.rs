use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::storage_fingerprints::StorageFingerprints;
use runner_types::ids::RunId;

use super::{MAX_ENTRY_BYTES_CAP, MIN_FREE_BYTES_FLOOR};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkspaceCacheCheckoutResult {
    Hit,
    Miss,
    NoReuseKey,
    InvalidWorkingDir,
    LockBusy,
    InvalidMetadata,
    DiskPressure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkspaceCacheLockOwner {
    Active,
    Finalizing,
    Unknown,
}

impl WorkspaceCacheLockOwner {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Finalizing => "finalizing",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkspaceCacheLockDecision {
    Busy(WorkspaceCacheLockOwner),
    Unavailable,
}

impl WorkspaceCacheLockDecision {
    pub(crate) const fn outcome(self) -> &'static str {
        match self {
            Self::Busy(_) => "busy",
            Self::Unavailable => "unavailable",
        }
    }

    pub(crate) const fn reason(self) -> Option<&'static str> {
        match self {
            Self::Busy(owner) => Some(owner.as_str()),
            Self::Unavailable => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WorkspaceCacheTerminalStatus {
    Success,
    NonzeroExit,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceImageLeaseIdentity<'a> {
    pub(crate) run_id: RunId,
    pub(crate) sandbox_id: sandbox::SandboxId,
    pub(crate) profile_name: &'a str,
    pub(crate) reuse_key: Option<&'a str>,
    pub(crate) working_dir: &'a str,
    pub(crate) image_size_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceImagePrepareRequest<'a> {
    pub(crate) identity: WorkspaceImageLeaseIdentity<'a>,
    pub(crate) workspace_drive_required: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum WorkspaceImagePrepareLockPolicy {
    #[default]
    WaitForTransientContention,
    ImmediateFallback,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceImageActiveLeaseRequest<'a> {
    pub(crate) identity: WorkspaceImageLeaseIdentity<'a>,
    pub(crate) workspace_drive_available: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceImagePromotionIdentityRequest<'a> {
    pub(crate) sandbox_id: sandbox::SandboxId,
    pub(crate) profile_name: &'a str,
    pub(crate) reuse_key: &'a str,
    pub(crate) working_dir: &'a str,
    pub(crate) image_size_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceImagePromotionIdentity {
    pub(crate) sandbox_id: sandbox::SandboxId,
    pub(crate) profile_name: String,
    pub(crate) reuse_key: String,
    pub(crate) working_dir: String,
    pub(crate) image_size_bytes: u64,
    pub(crate) active_image: PathBuf,
    pub(crate) cache_key: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkspaceImagePromotionIdentityMismatch {
    UnsafeWorkingDir,
    SandboxId,
    ProfileName,
    ReuseKey,
    WorkingDir,
    ImageSizeBytes,
    ActiveImage,
    CacheKey,
}

impl WorkspaceImagePromotionIdentityMismatch {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::UnsafeWorkingDir => "unsafe working directory",
            Self::SandboxId => "sandbox id mismatch",
            Self::ProfileName => "profile mismatch",
            Self::ReuseKey => "reuse key mismatch",
            Self::WorkingDir => "working directory mismatch",
            Self::ImageSizeBytes => "image size mismatch",
            Self::ActiveImage => "active image path mismatch",
            Self::CacheKey => "cache key mismatch",
        }
    }
}

impl std::fmt::Display for WorkspaceImagePromotionIdentityMismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

pub(crate) struct WorkspaceImagePromotionRequest<'a> {
    pub(crate) run_id: RunId,
    pub(crate) sandbox_id: sandbox::SandboxId,
    pub(crate) restored_session_identity:
        Option<&'a crate::restored_session_identity::RestoredSessionIdentity>,
    pub(crate) terminal_status: WorkspaceCacheTerminalStatus,
    pub(crate) completed_at: String,
    pub(crate) storage_fingerprints: StorageFingerprints,
}

/// Encoding of the bytes stored in a workspace session-history sidecar body.
pub(crate) type WorkspaceSessionHistorySidecarRepresentation =
    guest_contracts::session_history_identity::SessionHistorySidecarRepresentation;

/// A committed sidecar body that passed metadata, request, and file validation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkspaceSessionHistorySidecar {
    /// Path to the body slot selected by the committed sidecar metadata.
    pub(crate) path: PathBuf,
    /// Encoding to use when materializing the stored bytes.
    pub(crate) representation: WorkspaceSessionHistorySidecarRepresentation,
    /// Validated length of the encoded body.
    pub(crate) encoded_size: u64,
}

/// A guarded temporary body proposed for the next sidecar publication.
///
/// The restored-session identity is persisted with the source when promotion
/// succeeds. Publication consumes the temporary path by moving it into the
/// cache entry, or discards it when the source is invalid or promotion fails.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkspaceSessionHistorySidecarPromotionSource {
    /// Runner-managed temporary body path inside the guarded cache entry.
    pub(crate) tmp_path: PathBuf,
    /// Encoding of the staged body.
    pub(crate) representation: WorkspaceSessionHistorySidecarRepresentation,
    /// Declared encoded length checked before publication.
    pub(crate) encoded_size: u64,
    /// Identity fields to commit with the staged body.
    pub(crate) restored_session_identity: crate::restored_session_identity::RestoredSessionIdentity,
}

/// Sidecar policy applied while publishing the enclosing workspace image.
#[derive(Clone, Copy, Debug)]
pub(crate) enum WorkspaceSessionHistorySidecarPublication<'a> {
    /// Keep the committed sidecar after promoting a consumed workspace cache hit
    /// when finalization did not stage a replacement.
    PreserveExisting,
    /// Publish a guarded staged source with the promoted workspace image.
    Replace(&'a WorkspaceSessionHistorySidecarPromotionSource),
    /// Remove any committed sidecar when promoting a non-hit workspace without
    /// a staged source.
    Prune,
}

/// Non-fatal reason a local sidecar cannot satisfy a restore request.
///
/// Callers can record the stable string form as miss telemetry before using the
/// authoritative session-history materializer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkspaceSessionHistorySidecarMiss {
    /// The workspace image itself was not obtained from this cache entry.
    NoCacheHit,
    /// No committed sidecar metadata exists for the cache entry.
    Missing,
    /// Metadata could not be read, decoded, or accepted as a supported version
    /// with a valid encoded-size bound.
    InvalidMetadata,
    /// The requested restored-session identity is incomplete or differs from
    /// the identity recorded in the metadata.
    IdentityMismatch,
    /// The recorded framework, representation, and size relationship is not
    /// supported by the materializer.
    UnsupportedFormat,
    /// Metadata selects a body slot that no longer exists.
    BodyMissing,
    /// The selected body is not the recorded regular file with the expected
    /// encoded length.
    FileIdentityMismatch,
}

impl WorkspaceSessionHistorySidecarMiss {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::NoCacheHit => "no_cache_hit",
            Self::Missing => "missing",
            Self::InvalidMetadata => "invalid_metadata",
            Self::IdentityMismatch => "identity_mismatch",
            Self::UnsupportedFormat => "unsupported_format",
            Self::BodyMissing => "body_missing",
            Self::FileIdentityMismatch => "file_identity_mismatch",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FsStats {
    pub(crate) total_bytes: u64,
    pub(crate) available_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CacheBudget {
    pub(crate) max_cache_bytes: u64,
    pub(crate) target_after_gc_bytes: u64,
    pub(crate) min_free_bytes: u64,
    pub(crate) max_entry_bytes: u64,
}

impl CacheBudget {
    pub(crate) fn from_fs_stats(stats: FsStats) -> Self {
        let max_cache_bytes = stats.total_bytes.saturating_mul(50) / 100;
        let target_after_gc_bytes = max_cache_bytes.saturating_mul(75) / 100;
        let min_free_bytes = (stats.total_bytes.saturating_mul(10) / 100).max(MIN_FREE_BYTES_FLOOR);
        let max_entry_bytes = (stats.total_bytes.saturating_mul(5) / 100).min(MAX_ENTRY_BYTES_CAP);
        Self {
            max_cache_bytes,
            target_after_gc_bytes,
            min_free_bytes,
            max_entry_bytes,
        }
    }
}

/// A non-blocking, best-effort snapshot of the workspace image cache.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceImageCacheInspection {
    pub(crate) cache_dir: String,
    pub(crate) lock_dir: String,
    pub(crate) fs_stats: FsStats,
    pub(crate) budget: CacheBudget,
    pub(crate) summary: WorkspaceImageCacheInspectionSummary,
    pub(crate) entries: Vec<WorkspaceImageCacheInspectionEntry>,
}

/// Aggregates from a non-blocking, best-effort cache scan.
///
/// When `locked_entries` is nonzero, reusable, invalid, stale, and temporary
/// entry counts and temporary-path and size totals exclude locked entry
/// contents and are lower bounds. `total_entries` and `locked_entries` remain
/// observed values.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceImageCacheInspectionSummary {
    pub(crate) total_entries: usize,
    pub(crate) reusable_entries: usize,
    pub(crate) invalid_entries: usize,
    pub(crate) stale_entries: usize,
    pub(crate) temporary_entries: usize,
    pub(crate) locked_entries: usize,
    pub(crate) temporary_paths: usize,
    pub(crate) total_allocated_bytes: u64,
    pub(crate) total_logical_image_bytes: u64,
    pub(crate) temporary_allocated_bytes: u64,
}

/// A best-effort per-entry inspection record.
///
/// A locked record skips metadata, image-size, temporary-path, storage, and
/// artifact inspection. Its `None` metadata fields and zero-valued size/count
/// fields mean unavailable, not measured zero.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceImageCacheInspectionEntry {
    pub(crate) cache_key: String,
    pub(crate) status: WorkspaceImageCacheInspectionStatus,
    pub(crate) reason: Option<String>,
    pub(crate) cache_scope: Option<String>,
    pub(crate) profile_name: Option<String>,
    pub(crate) working_dir: Option<String>,
    pub(crate) last_completed_at: Option<String>,
    pub(crate) last_used_at: Option<String>,
    pub(crate) last_terminal_status: Option<WorkspaceCacheTerminalStatus>,
    pub(crate) allocated_bytes: u64,
    pub(crate) logical_image_size_bytes: u64,
    pub(crate) temporary_path_count: usize,
    pub(crate) temporary_allocated_bytes: u64,
    pub(crate) storage_count: usize,
    pub(crate) artifact_count: usize,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WorkspaceImageCacheInspectionStatus {
    Reusable,
    Invalid,
    Stale,
    TemporaryOnly,
    Locked,
}

impl WorkspaceCacheTerminalStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::NonzeroExit => "nonzeroExit",
            Self::Cancelled => "cancelled",
        }
    }
}

impl WorkspaceImageCacheInspectionStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Reusable => "reusable",
            Self::Invalid => "invalid",
            Self::Stale => "stale",
            Self::TemporaryOnly => "temporaryOnly",
            Self::Locked => "locked",
        }
    }
}
