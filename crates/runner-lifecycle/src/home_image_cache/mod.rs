//! Whole-home image cache. There is no old directory/layout/metadata reader.
//!
//! Entry locks own checkout, publication, and orphan reclamation. Promotion
//! attempts capacity non-blockingly while holding entry; GC holds capacity and
//! attempts entries non-blockingly. Routine inventory releases entry locks
//! before attempting capacity. Never introduce blocking nested acquisition.
//!
//! A checkout removes the commit before moving its selected immutable image.
//! Publication syncs a new generation and directories before a single atomic
//! metadata commit. It never replaces bytes selected by an older commit. Proof
//! is a generation-bound candidate, not authority to skip live verification.
use crate::error::{LifecycleError, LifecycleResult};
use runner_host::paths::{HomePaths, RunnerPaths};
use std::collections::HashMap;
use std::path::PathBuf;
#[cfg(any(test, feature = "test-support"))]
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

mod entry;
mod fs;
mod gc;
mod inspection;
mod lifecycle;
mod metadata;
mod path_safety;
pub mod snapshot;
#[cfg(test)]
mod tests;
mod types;
mod watcher;
#[cfg(any(test, feature = "test-support"))]
pub use entry::CacheEntryPaths;
pub use lifecycle::{
    HomeImageLease, HomeImagePromotionContext, HomeImagePromotionIdentityFailure,
    HomeImagePromotionOutcome, cap_held_home_states,
};
pub use runner_host::paths::HomeImageCacheKey;
use types::HomeCacheLockOwner;
pub use types::{
    CacheBudget, FsStats, HomeCacheCheckoutResult, HomeCacheTerminalStatus,
    HomeImageCacheInspection, HomeImageCacheInspectionEntry, HomeImageCacheInspectionStatus,
    HomeImageCacheInspectionSummary, HomeImageLeaseIdentity, HomeImageLeaseRequest,
    HomeImagePrepareLockPolicy, HomeImagePrepareRequest, HomeImageProfileIdentity,
    HomeImagePromotionIdentity, HomeImagePromotionIdentityMismatch,
    HomeImagePromotionIdentityRequest, HomeImagePromotionRequest,
};
pub use watcher::{HomeCacheChange, HomeCacheWatcher};

const CACHE_FORMAT_VERSION: u32 = 3;
const HOME_DRIVE_LAYOUT: &str = runner_host::paths::HOME_DRIVE_LAYOUT;
const GIB: u64 = 1024 * 1024 * 1024;
const MIN_FREE_BYTES_FLOOR: u64 = 50 * GIB;
const MAX_HOME_PROMOTION_CONCURRENCY: usize = 4;
#[cfg(any(test, feature = "test-support"))]
const TEST_FS_TOTAL_BYTES: u64 = 2_000 * GIB;
#[cfg(any(test, feature = "test-support"))]
const TEST_FS_AVAILABLE_BYTES: u64 = 1_000 * GIB;

#[derive(Clone)]
pub struct HomeImageCache {
    inner: Arc<HomeImageCacheInner>,
    idle_home_reclamation_permits: Arc<Semaphore>,
    #[cfg(any(test, feature = "test-support"))]
    prepare_lock_test_gate: Option<HomeImagePrepareLockTestGate>,
    #[cfg(any(test, feature = "test-support"))]
    routine_gc_test_gate: Option<(Arc<tokio::sync::Notify>, Arc<Semaphore>)>,
    #[cfg(test)]
    gc_inventory_test_gate: Option<gc::GcInventoryTestGate>,
}
#[cfg(any(test, feature = "test-support"))]
#[derive(Clone, Default)]
pub struct HomeImagePrepareLockTestGate {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}
#[cfg(any(test, feature = "test-support"))]
impl HomeImagePrepareLockTestGate {
    pub async fn enter_and_wait(&self) {
        self.entered.notify_one();
        self.release.notified().await;
    }
    pub async fn wait_entered(&self, timeout: std::time::Duration) {
        tokio::time::timeout(timeout, self.entered.notified())
            .await
            .expect("home prepare must observe contention");
    }
    pub fn release(&self) {
        self.release.notify_one();
    }
}
struct HomeImageCacheInner {
    paths: RunnerPaths,
    cache_dir: PathBuf,
    lock_dir: PathBuf,
    cache_scope: String,
    entry_lock_owners: Mutex<HashMap<String, HomeCacheLockRegistration>>,
    #[cfg(any(test, feature = "test-support"))]
    fs_stats_override: FsStats,
    #[cfg(any(test, feature = "test-support"))]
    gc_root_scan_count: AtomicUsize,
    #[cfg(any(test, feature = "test-support"))]
    held_state_root_scan_count: AtomicUsize,
    #[cfg(any(test, feature = "test-support"))]
    held_state_root_scan_notify: tokio::sync::Notify,
    #[cfg(test)]
    publication_fault: AtomicUsize,
}
#[derive(Clone)]
struct HomeCacheLockRegistration {
    identity: Arc<()>,
    owner: HomeCacheLockOwner,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct TemporaryPathStats {
    path_count: usize,
    allocated_bytes: u64,
}
#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(usize)]
enum PublicationFault {
    BeforeImageSync = 1,
    AfterImageSync,
    BeforeMetadataRename,
    AfterMetadataRename,
}

impl HomeImageCache {
    #[cfg(any(test, feature = "test-support"))]
    pub fn new(paths: RunnerPaths) -> Self {
        let cache_dir = crate::test_fixtures::runner_home_image_cache_dir(&paths);
        let lock_dir = paths.base_dir().join("locks");
        Self::with_cache_dirs(paths, cache_dir, lock_dir, "")
    }
    #[cfg(any(test, feature = "test-support"))]
    fn new_with_fs_stats(paths: RunnerPaths, stats: FsStats) -> Self {
        let cache_dir = crate::test_fixtures::runner_home_image_cache_dir(&paths);
        let lock_dir = paths.base_dir().join("locks");
        Self::with_cache_dirs_and_fs_stats(paths, cache_dir, lock_dir, "", stats)
    }
    pub fn shared(paths: RunnerPaths, home: &HomePaths, scope: &str) -> Self {
        Self::with_cache_dirs(paths, home.home_image_cache_dir(), home.locks_dir(), scope)
    }
    fn with_cache_dirs(
        paths: RunnerPaths,
        cache_dir: PathBuf,
        lock_dir: PathBuf,
        scope: &str,
    ) -> Self {
        #[cfg(any(test, feature = "test-support"))]
        {
            Self::with_cache_dirs_and_fs_stats(
                paths,
                cache_dir,
                lock_dir,
                scope,
                FsStats {
                    total_bytes: TEST_FS_TOTAL_BYTES,
                    available_bytes: TEST_FS_AVAILABLE_BYTES,
                },
            )
        }
        #[cfg(not(any(test, feature = "test-support")))]
        {
            Self {
                inner: Arc::new(HomeImageCacheInner {
                    paths,
                    cache_dir,
                    lock_dir,
                    cache_scope: scope.to_owned(),
                    entry_lock_owners: Mutex::new(HashMap::new()),
                }),
                idle_home_reclamation_permits: Arc::new(Semaphore::new(
                    MAX_HOME_PROMOTION_CONCURRENCY,
                )),
            }
        }
    }
    #[cfg(any(test, feature = "test-support"))]
    fn with_cache_dirs_and_fs_stats(
        paths: RunnerPaths,
        cache_dir: PathBuf,
        lock_dir: PathBuf,
        scope: &str,
        stats: FsStats,
    ) -> Self {
        Self {
            inner: Arc::new(HomeImageCacheInner {
                paths,
                cache_dir,
                lock_dir,
                cache_scope: scope.to_owned(),
                entry_lock_owners: Mutex::new(HashMap::new()),
                fs_stats_override: stats,
                gc_root_scan_count: AtomicUsize::new(0),
                held_state_root_scan_count: AtomicUsize::new(0),
                held_state_root_scan_notify: tokio::sync::Notify::new(),
                #[cfg(test)]
                publication_fault: AtomicUsize::new(0),
            }),
            idle_home_reclamation_permits: Arc::new(Semaphore::new(MAX_HOME_PROMOTION_CONCURRENCY)),
            prepare_lock_test_gate: None,
            routine_gc_test_gate: None,
            #[cfg(test)]
            gc_inventory_test_gate: None,
        }
    }
    fn with_promotion_capacity(mut self, capacity: usize) -> Self {
        self.idle_home_reclamation_permits = Arc::new(Semaphore::new(capacity.max(1)));
        self
    }
    pub fn with_promotion_host_cpus(self, host_cpus: usize) -> Self {
        self.with_promotion_capacity((host_cpus / 2).clamp(1, MAX_HOME_PROMOTION_CONCURRENCY))
    }
    #[cfg(any(test, feature = "test-support"))]
    pub fn with_promotion_capacity_for_test(self, capacity: usize) -> Self {
        self.with_promotion_capacity(capacity)
    }
    async fn acquire_idle_home_reclamation_permit(&self) -> LifecycleResult<OwnedSemaphorePermit> {
        Arc::clone(&self.idle_home_reclamation_permits)
            .acquire_owned()
            .await
            .map_err(|e| {
                LifecycleError::Internal(format!("idle home reclamation admission closed: {e}"))
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
    pub fn with_prepare_lock_test_gate(mut self, gate: HomeImagePrepareLockTestGate) -> Self {
        self.prepare_lock_test_gate = Some(gate);
        self
    }
    #[cfg(test)]
    fn publication_fault(&self, point: PublicationFault) -> LifecycleResult<()> {
        if self
            .inner
            .publication_fault
            .compare_exchange(
                point as usize,
                0,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .is_ok()
        {
            return Err(LifecycleError::Internal(
                "injected publication IO failure".into(),
            ));
        }
        Ok(())
    }
}
