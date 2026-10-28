use super::HOME_IMAGE_SPACE_RESERVE;
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

/// Identity of the selected immutable source, borrowed without further IO.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HomeImageSourceIdentity<'a> {
    pub cache_key: &'a str,
    pub profile_name: &'a str,
    pub image_generation: &'a str,
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
pub enum HomeImagePreparePolicy {
    /// Do not read a cached image; retain only nonblocking publication ownership.
    Fresh,
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
    PublicationStarted,
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
            Self::PublicationStarted => "home publication already started",
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
    /// Legacy byte projections are unknown when allocation was only partial.
    pub complete: bool,
}
impl CacheBudget {
    pub(super) fn from_observed_allocation(stats: FsStats, allocated: Option<u64>) -> Self {
        let pressure = HomeCachePressureThresholds::from_fs_stats(stats);
        Self {
            max_cache_bytes: allocated.map_or(0, |bytes| {
                bytes
                    .saturating_add(stats.available_bytes)
                    .min(stats.total_bytes)
                    .saturating_sub(pressure.reserve_bytes)
            }),
            target_after_gc_bytes: allocated.map_or(0, |bytes| {
                bytes.saturating_sub(
                    pressure
                        .high_free_bytes
                        .saturating_sub(stats.available_bytes),
                )
            }),
            min_free_bytes: pressure.reserve_bytes,
            complete: allocated.is_some(),
        }
    }
}

/// Observed receiving-filesystem watermarks, independent of retained-cache size.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeCachePressureThresholds {
    pub reserve_bytes: u64,
    pub low_free_bytes: u64,
    pub high_free_bytes: u64,
    pub reserve_feasible: bool,
}

impl HomeCachePressureThresholds {
    pub fn from_fs_stats(stats: FsStats) -> Self {
        Self::with_reserve(stats, HOME_IMAGE_SPACE_RESERVE)
    }

    pub(super) fn with_reserve(stats: FsStats, reserve: sandbox::HomeDriveSpaceReserve) -> Self {
        let reserve_bytes = reserve.bytes_for_capacity(stats.total_bytes);
        let margin = reserve_bytes.min(stats.total_bytes.saturating_sub(reserve_bytes)) / 4;
        Self {
            reserve_bytes,
            low_free_bytes: reserve_bytes.saturating_add(margin),
            high_free_bytes: reserve_bytes.saturating_add(margin.saturating_mul(2)),
            reserve_feasible: reserve_bytes <= stats.total_bytes,
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
    pub pressure: HomeCachePressureThresholds,
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
