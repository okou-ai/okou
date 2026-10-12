use super::MIN_FREE_BYTES_FLOOR;
use crate::storage_fingerprints::StorageFingerprints;
use runner_types::ids::RunId;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HomeCacheCheckoutResult {
    Hit,
    Miss,
    NoReuseKey,
    InvalidWorkingDir,
    LockBusy,
    InvalidMetadata,
    DiskPressure,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HomeCacheLockOwner {
    Active,
    Finalizing,
    Unknown,
}
impl HomeCacheLockOwner {
    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Finalizing => "finalizing",
            Self::Unknown => "unknown",
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HomeCacheLockDecision {
    Busy(HomeCacheLockOwner),
    Unavailable,
}
impl HomeCacheLockDecision {
    pub(super) const fn outcome(self) -> &'static str {
        match self {
            Self::Busy(_) => "busy",
            Self::Unavailable => "unavailable",
        }
    }
    pub(super) const fn reason(self) -> Option<&'static str> {
        match self {
            Self::Busy(owner) => Some(owner.as_str()),
            Self::Unavailable => None,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HomeCacheTerminalStatus {
    Success,
    NonzeroExit,
    Cancelled,
}
impl HomeCacheTerminalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::NonzeroExit => "nonzeroExit",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HomeImageLeaseIdentity<'a> {
    pub run_id: RunId,
    pub sandbox_id: sandbox::SandboxId,
    pub profile_name: &'a str,
    pub rootfs_hash: &'a str,
    pub reuse_key: Option<&'a str>,
    pub working_dir: &'a str,
    pub image_size_bytes: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HomeImagePrepareRequest<'a> {
    pub identity: HomeImageLeaseIdentity<'a>,
    pub home_drive_required: bool,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum HomeImagePrepareLockPolicy {
    #[default]
    WaitForTransientContention,
    ImmediateFallback,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HomeImageLeaseRequest<'a> {
    pub identity: HomeImageLeaseIdentity<'a>,
    pub home_drive_available: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HomeImagePromotionIdentityRequest<'a> {
    pub sandbox_id: sandbox::SandboxId,
    pub profile_name: &'a str,
    pub rootfs_hash: &'a str,
    pub reuse_key: &'a str,
    pub working_dir: &'a str,
    pub image_size_bytes: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HomeImagePromotionIdentity {
    pub sandbox_id: sandbox::SandboxId,
    pub profile_name: String,
    pub rootfs_hash: String,
    pub reuse_key: String,
    pub working_dir: String,
    pub image_size_bytes: u64,
    pub active_image: PathBuf,
    pub cache_key: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HomeImagePromotionIdentityMismatch {
    UnsafeWorkingDir,
    SandboxId,
    ProfileName,
    RootfsHash,
    ReuseKey,
    WorkingDir,
    ImageSizeBytes,
    ActiveImage,
    CacheKey,
}
impl HomeImagePromotionIdentityMismatch {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnsafeWorkingDir => "unsafe working directory",
            Self::SandboxId => "sandbox id mismatch",
            Self::ProfileName => "profile mismatch",
            Self::RootfsHash => "rootfs hash mismatch",
            Self::ReuseKey => "reuse key mismatch",
            Self::WorkingDir => "working directory mismatch",
            Self::ImageSizeBytes => "image size mismatch",
            Self::ActiveImage => "active image path mismatch",
            Self::CacheKey => "cache key mismatch",
        }
    }
}
impl std::fmt::Display for HomeImagePromotionIdentityMismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}
pub struct HomeImagePromotionRequest<'a> {
    pub run_id: RunId,
    pub sandbox_id: sandbox::SandboxId,
    pub restored_session_identity:
        Option<&'a crate::restored_session_identity::RestoredSessionIdentity>,
    pub terminal_status: HomeCacheTerminalStatus,
    pub completed_at: String,
    pub storage_fingerprints: StorageFingerprints,
}

/// Actual captured profile shape and artifact identity for inventory eligibility.
#[derive(Clone, Copy, Debug)]
pub struct HomeImageProfileIdentity<'a> {
    pub rootfs_hash: &'a str,
    pub image_size_bytes: u64,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsStats {
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub total_inodes: u64,
    pub available_inodes: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheBudget {
    pub max_cache_bytes: u64,
    pub target_after_gc_bytes: u64,
    pub min_free_bytes: u64,
}
impl CacheBudget {
    pub fn from_fs_stats(stats: FsStats) -> Self {
        let max_cache_bytes = stats.total_bytes.saturating_mul(50) / 100;
        Self {
            max_cache_bytes,
            target_after_gc_bytes: max_cache_bytes.saturating_mul(75) / 100,
            min_free_bytes: (stats.total_bytes.saturating_mul(10) / 100).max(MIN_FREE_BYTES_FLOOR),
        }
    }
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HomeImageCacheInspection {
    pub cache_dir: String,
    pub lock_dir: String,
    pub fs_stats: FsStats,
    pub budget: CacheBudget,
    pub summary: HomeImageCacheInspectionSummary,
    pub entries: Vec<HomeImageCacheInspectionEntry>,
}
/// Totals exclude unavailable locked entries and are therefore lower bounds.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HomeImageCacheInspectionSummary {
    pub total_entries: usize,
    pub reusable_entries: usize,
    pub invalid_entries: usize,
    pub stale_entries: usize,
    pub temporary_entries: usize,
    pub locked_entries: usize,
    pub temporary_paths: usize,
    pub total_allocated_bytes: u64,
    pub total_logical_image_bytes: u64,
    pub temporary_allocated_bytes: u64,
}
/// Locked measurements are unavailable, not measured zero. Status and reason
/// carry that distinction for the bounded PR3 diagnostic projection.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HomeImageCacheInspectionEntry {
    pub cache_key: String,
    pub status: HomeImageCacheInspectionStatus,
    pub reason: Option<String>,
    pub cache_scope: Option<String>,
    pub profile_name: Option<String>,
    pub rootfs_hash: Option<String>,
    pub working_dir: Option<String>,
    pub last_completed_at: Option<String>,
    pub last_used_at: Option<String>,
    pub last_terminal_status: Option<HomeCacheTerminalStatus>,
    pub allocated_bytes: u64,
    pub logical_image_size_bytes: u64,
    pub temporary_path_count: usize,
    pub temporary_allocated_bytes: u64,
    pub storage_count: usize,
    pub artifact_count: usize,
}
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HomeImageCacheInspectionStatus {
    Reusable,
    Invalid,
    Stale,
    TemporaryOnly,
    Locked,
}
impl HomeImageCacheInspectionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reusable => "reusable",
            Self::Invalid => "invalid",
            Self::Stale => "stale",
            Self::TemporaryOnly => "temporaryOnly",
            Self::Locked => "locked",
        }
    }
}
