//! Local workspace image cache keyed by runner reuse identity.
//!
//! This cache stores reusable workspace drive images for reuse-key-backed runs.
//! Each cache entry is keyed by cache scope, profile, reuse key, and logical
//! workspace image size. The normalized working directory is still stored in
//! metadata and validated at promotion/reuse boundaries; the hash key itself
//! follows the canonical-workspace semantics in `paths.rs`. A cache entry
//! contains a `metadata.json` file and a `current.ext4` image file.
//!
//! ## Guest path and fingerprint scope
//!
//! A cache-safe guest working directory is an absolute, non-root path string: it
//! starts with `/`, contains no NUL byte, and contains no component equal to
//! `.` or `..`. Repeated and trailing `/` separators are normalized away. The
//! normalizer only performs these string checks; it does not resolve host
//! filesystem paths or symlinks. Root, relative, NUL-containing, and
//! dot-component paths are unsafe.
//!
//! A mount path is in the workspace scope when its normalized form is exactly
//! the normalized working directory or is a component-boundary descendant of
//! it. This is deliberately stricter than a raw string-prefix check, so a path
//! such as `/workspace2` is not inside `/workspace`. An invalid working or
//! mount path fails closed and cannot make an entry eligible for cache reuse.
//!
//! Promotion filters both the storage and artifact fingerprint maps against
//! this scope. Normalized paths are used only to decide membership; retained
//! entries keep their original map keys and fingerprint values. Only
//! fingerprints for state represented by the workspace image are persisted in
//! cache metadata. On a cache hit, those persisted fingerprints become the
//! previous storage state for the next storage plan.
//!
//! Unsafe paths have lifecycle effects at several boundaries. Active checkout
//! and preparation use the fresh-workspace fallback, promotion identity
//! rejects the path, and an unsafe lease cannot produce a promotion target.
//! Metadata with an unsafe working directory is not reusable for metadata or
//! held-state publication, and GC classifies the entry as unusable.
//!
//! ## Invariants
//!
//! - Within this module, entry paths are always derived from the same cache key
//!   through `CacheEntryPaths`; callers should not hand-roll per-entry paths.
//! - The shared cache root may contain entries for multiple runner groups. Reuse
//!   is scoped by cache key metadata; global inspection and GC may scan the
//!   shared root.
//! - Entry locks protect one cache key. Capacity lock protects budget-sensitive
//!   promotion and GC work across the shared cache root.
//! - Session-history sidecar staging inside a cache entry holds that entry's
//!   lock from the first managed temporary-path operation through publication
//!   or discard, so GC cannot classify active staging as orphaned state.
//! - GC takes the capacity lock and then uses non-blocking entry lock attempts.
//!   Promotion already holds or reacquires an entry lock and then uses a
//!   non-blocking capacity lock attempt. Do not turn either side into blocking
//!   nested lock acquisition.
//! - A checkout hit removes `metadata.json` before returning the current image as
//!   a move seed, so the cache entry is not reusable while the image is active.
//! - Promotion may move the active image into the cache. Callers must stop all
//!   image writers before promotion and must not depend on the active path
//!   afterward.
//! - Metadata is reusable only when it matches the cache key inputs, workspace
//!   drive layout, terminal status, trust/state, and current image identity.
//! - GC refreshes a candidate and compares the current image identity before
//!   deleting, so concurrent replacement by another runner is preserved.

use std::collections::HashMap;
use std::path::PathBuf;
#[cfg(any(test, feature = "test-support"))]
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::error::{LifecycleError, LifecycleResult};
use runner_host::paths::{HomePaths, RunnerPaths};

mod entry;
mod fs;
mod gc;
mod inspection;
mod lifecycle;
mod metadata;
mod path_safety;
mod sidecar;
mod types;
mod watcher;

#[cfg(test)]
mod tests;

#[cfg(any(test, feature = "test-support"))]
pub use entry::CacheEntryPaths;
pub use lifecycle::{
    WorkspaceImageLease, WorkspaceImagePromotionContext, WorkspaceImagePromotionIdentityFailure,
    WorkspaceImagePromotionOutcome, WorkspaceSessionHistorySidecarEntryGuard,
    cap_held_workspace_states,
};
pub use types::{
    CacheBudget, FsStats, WorkspaceCacheCheckoutResult, WorkspaceCacheLockOwner,
    WorkspaceCacheTerminalStatus, WorkspaceImageActiveLeaseRequest, WorkspaceImageCacheInspection,
    WorkspaceImageCacheInspectionEntry, WorkspaceImageCacheInspectionStatus,
    WorkspaceImageCacheInspectionSummary, WorkspaceImageLeaseIdentity,
    WorkspaceImagePrepareLockPolicy, WorkspaceImagePrepareRequest,
    WorkspaceImagePromotionIdentityMismatch, WorkspaceImagePromotionIdentityRequest,
    WorkspaceImagePromotionRequest, WorkspaceSessionHistorySidecar,
    WorkspaceSessionHistorySidecarPromotionSource, WorkspaceSessionHistorySidecarRepresentation,
};
pub use watcher::{WorkspaceCacheChange, WorkspaceCacheWatcher};

const CACHE_FORMAT_VERSION: u32 = 2;
const WORKSPACE_DRIVE_LAYOUT: &str = "workspace-drive-v1";
const GIB: u64 = 1024 * 1024 * 1024;
const MIN_FREE_BYTES_FLOOR: u64 = 50 * GIB;
const MAX_ENTRY_BYTES_CAP: u64 = 32 * GIB;
const MAX_WORKSPACE_PROMOTION_CONCURRENCY: usize = 4;

#[cfg(any(test, feature = "test-support"))]
const TEST_FS_TOTAL_BYTES: u64 = 2_000 * GIB;
#[cfg(any(test, feature = "test-support"))]
const TEST_FS_AVAILABLE_BYTES: u64 = 1_000 * GIB;

#[derive(Clone)]
pub struct WorkspaceImageCache {
    inner: Arc<WorkspaceImageCacheInner>,
    session_history_sidecar_export_permits: Arc<Semaphore>,
    idle_workspace_reclamation_permits: Arc<Semaphore>,
    #[cfg(any(test, feature = "test-support"))]
    prepare_lock_test_gate: Option<WorkspaceImagePrepareLockTestGate>,
    #[cfg(any(test, feature = "test-support"))]
    routine_gc_test_gate: Option<(Arc<tokio::sync::Notify>, Arc<Semaphore>)>,
}

#[cfg(any(test, feature = "test-support"))]
#[derive(Clone, Default)]
pub struct WorkspaceImagePrepareLockTestGate {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

#[cfg(any(test, feature = "test-support"))]
impl WorkspaceImagePrepareLockTestGate {
    pub async fn enter_and_wait(&self) {
        self.entered.notify_one();
        self.release.notified().await;
    }

    pub async fn wait_entered(&self, timeout: std::time::Duration) {
        tokio::time::timeout(timeout, self.entered.notified())
            .await
            .expect("workspace image prepare should observe lock contention");
    }

    pub fn release(&self) {
        self.release.notify_one();
    }
}

struct WorkspaceImageCacheInner {
    paths: RunnerPaths,
    cache_dir: PathBuf,
    lock_dir: PathBuf,
    cache_scope: String,
    entry_lock_owners: Mutex<HashMap<String, WorkspaceCacheLockRegistration>>,
    #[cfg(any(test, feature = "test-support"))]
    fs_stats_override: FsStats,
    #[cfg(any(test, feature = "test-support"))]
    gc_root_scan_count: AtomicUsize,
    #[cfg(any(test, feature = "test-support"))]
    held_state_root_scan_count: AtomicUsize,
    #[cfg(any(test, feature = "test-support"))]
    held_state_root_scan_notify: tokio::sync::Notify,
    #[cfg(any(test, feature = "test-support"))]
    fail_next_session_history_sidecar_metadata_commit: AtomicBool,
}

#[derive(Clone)]
struct WorkspaceCacheLockRegistration {
    identity: Arc<()>,
    owner: WorkspaceCacheLockOwner,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct TemporaryPathStats {
    path_count: usize,
    allocated_bytes: u64,
}

impl WorkspaceImageCache {
    #[cfg(any(test, feature = "test-support"))]
    pub fn new(paths: RunnerPaths) -> Self {
        let cache_dir = crate::test_fixtures::runner_workspace_image_cache_dir(&paths);
        let lock_dir = paths.base_dir().join("locks");
        Self::with_cache_dirs(paths, cache_dir, lock_dir, "")
    }

    #[cfg(any(test, feature = "test-support"))]
    fn new_with_fs_stats(paths: RunnerPaths, fs_stats: FsStats) -> Self {
        let cache_dir = crate::test_fixtures::runner_workspace_image_cache_dir(&paths);
        let lock_dir = paths.base_dir().join("locks");
        Self::with_cache_dirs_and_fs_stats(paths, cache_dir, lock_dir, "", fs_stats)
    }

    pub fn shared(paths: RunnerPaths, home: &HomePaths, cache_scope: &str) -> Self {
        Self::with_cache_dirs(
            paths,
            home.workspace_image_cache_dir(),
            home.locks_dir(),
            cache_scope,
        )
    }

    fn with_cache_dirs(
        paths: RunnerPaths,
        cache_dir: PathBuf,
        lock_dir: PathBuf,
        cache_scope: &str,
    ) -> Self {
        #[cfg(any(test, feature = "test-support"))]
        {
            Self::with_cache_dirs_and_fs_stats(
                paths,
                cache_dir,
                lock_dir,
                cache_scope,
                FsStats {
                    total_bytes: TEST_FS_TOTAL_BYTES,
                    available_bytes: TEST_FS_AVAILABLE_BYTES,
                },
            )
        }

        #[cfg(not(any(test, feature = "test-support")))]
        {
            Self {
                inner: Arc::new(WorkspaceImageCacheInner {
                    paths,
                    cache_dir,
                    lock_dir,
                    cache_scope: cache_scope.to_owned(),
                    entry_lock_owners: Mutex::new(HashMap::new()),
                }),
                session_history_sidecar_export_permits: Arc::new(Semaphore::new(
                    MAX_WORKSPACE_PROMOTION_CONCURRENCY,
                )),
                idle_workspace_reclamation_permits: Arc::new(Semaphore::new(
                    MAX_WORKSPACE_PROMOTION_CONCURRENCY,
                )),
            }
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    fn with_cache_dirs_and_fs_stats(
        paths: RunnerPaths,
        cache_dir: PathBuf,
        lock_dir: PathBuf,
        cache_scope: &str,
        fs_stats: FsStats,
    ) -> Self {
        Self {
            inner: Arc::new(WorkspaceImageCacheInner {
                paths,
                cache_dir,
                lock_dir,
                cache_scope: cache_scope.to_owned(),
                entry_lock_owners: Mutex::new(HashMap::new()),
                fs_stats_override: fs_stats,
                gc_root_scan_count: AtomicUsize::new(0),
                held_state_root_scan_count: AtomicUsize::new(0),
                held_state_root_scan_notify: tokio::sync::Notify::new(),
                fail_next_session_history_sidecar_metadata_commit: AtomicBool::new(false),
            }),
            session_history_sidecar_export_permits: Arc::new(Semaphore::new(
                MAX_WORKSPACE_PROMOTION_CONCURRENCY,
            )),
            idle_workspace_reclamation_permits: Arc::new(Semaphore::new(
                MAX_WORKSPACE_PROMOTION_CONCURRENCY,
            )),
            prepare_lock_test_gate: None,
            routine_gc_test_gate: None,
        }
    }

    fn with_promotion_capacity(mut self, capacity: usize) -> Self {
        self.session_history_sidecar_export_permits = Arc::new(Semaphore::new(capacity.max(1)));
        self.idle_workspace_reclamation_permits = Arc::new(Semaphore::new(capacity.max(1)));
        self
    }

    pub fn with_promotion_host_cpus(self, host_cpus: usize) -> Self {
        self.with_promotion_capacity((host_cpus / 2).clamp(1, MAX_WORKSPACE_PROMOTION_CONCURRENCY))
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn with_promotion_capacity_for_test(self, capacity: usize) -> Self {
        self.with_promotion_capacity(capacity)
    }

    async fn acquire_idle_workspace_reclamation_permit(
        &self,
    ) -> LifecycleResult<OwnedSemaphorePermit> {
        Arc::clone(&self.idle_workspace_reclamation_permits)
            .acquire_owned()
            .await
            .map_err(|error| {
                LifecycleError::Internal(format!(
                    "idle workspace reclamation admission closed unexpectedly: {error}"
                ))
            })
    }

    async fn acquire_session_history_sidecar_export_permit(
        &self,
    ) -> LifecycleResult<OwnedSemaphorePermit> {
        Arc::clone(&self.session_history_sidecar_export_permits)
            .acquire_owned()
            .await
            .map_err(|error| {
                LifecycleError::Internal(format!(
                    "session history sidecar export admission closed unexpectedly: {error}"
                ))
            })
    }

    pub fn paths(&self) -> &RunnerPaths {
        &self.inner.paths
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn with_routine_gc_test_gate(
        mut self,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<Semaphore>,
    ) -> Self {
        self.routine_gc_test_gate = Some((entered, release));
        self
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn with_prepare_lock_test_gate(mut self, gate: WorkspaceImagePrepareLockTestGate) -> Self {
        self.prepare_lock_test_gate = Some(gate);
        self
    }
}
