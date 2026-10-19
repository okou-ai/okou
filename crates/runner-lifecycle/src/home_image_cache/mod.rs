//! Home image cache. There is no old directory/layout/metadata reader.
//!
//! Entry locks own checkout, publication, and orphan reclamation. Promotion
//! retains accepted physical work and phase-aware retry under the original entry
//! custody and bounded IO admission. Collectors own the routine singleton and
//! only try entry locks. The collector lock file also stores successful routine
//! maintenance cadence; publishers only need their own entry locks.
//!
//! A checkout removes the commit before moving its selected immutable image.
//! Publication syncs a new generation and directories before a single atomic
//! metadata commit. It never replaces bytes selected by an older commit. Proof
//! is a generation-bound candidate, not authority to skip live verification.
use crate::error::{LifecycleError, LifecycleResult};
use runner_host::paths::{HomePaths, RunnerPaths};
use runner_storage::SandboxOpReporter;
use std::collections::HashMap;
use std::path::PathBuf;
#[cfg(any(test, feature = "test-support"))]
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::task::TaskTracker;

mod background;
mod entry;
mod fs;
mod gc;
mod gc_metadata;
mod gc_pressure;
mod inspection;
mod inventory;
mod io_context;
mod lifecycle;
mod metadata;
mod path_safety;
mod pressure;
mod reclamation;
use reclamation::IdleHomeReclamation;
pub use reclamation::IdleHomeReclamationPermit;
pub mod snapshot;
#[cfg(test)]
mod tests;
mod types;
mod watcher;
use background::BackgroundGcActivity;
#[cfg(any(test, feature = "test-support"))]
pub use entry::CacheEntryPaths;
pub use gc_pressure::{HomeCacheReclaimOutcome, HomeCacheReclaimStatus};
pub use inventory::{HomeCacheInventory, HomeCacheKeyUpdates};
pub use lifecycle::{
    HomeImageLease, HomeImagePromotionContext, HomeImagePromotionIdentityFailure,
    HomeImagePromotionOutcome, cap_held_home_states,
};
use pressure::PressureReclamation;
pub use runner_host::paths::HomeImageCacheKey;
use types::HomeCacheLockOwner;
pub use types::{
    CacheBudget, FsStats, HomeCacheCheckoutResult, HomeCachePressureThresholds,
    HomeCacheTerminalStatus, HomeImageCacheInspection, HomeImageCacheInspectionEntry,
    HomeImageCacheInspectionStatus, HomeImageCacheInspectionSummary, HomeImageLeaseIdentity,
    HomeImageLeaseRequest, HomeImagePrepareLockPolicy, HomeImagePrepareRequest,
    HomeImagePromotionIdentity, HomeImagePromotionIdentityMismatch,
    HomeImagePromotionIdentityRequest, HomeImagePromotionRequest, HomeImageSourceIdentity,
};
use watcher::SelectionReleases;
pub use watcher::{HomeCacheChange, HomeCacheWatcher};

const CACHE_FORMAT_VERSION: u32 = 3;
const HOME_DRIVE_LAYOUT: &str = runner_host::paths::HOME_DRIVE_LAYOUT;
const GIB: u64 = 1024 * 1024 * 1024;
const MIN_FREE_BYTES_FLOOR: u64 = 50 * GIB;
/// Shared reserve for home cache publication and runtime image allocation.
pub const HOME_IMAGE_SPACE_RESERVE: sandbox::HomeDriveSpaceReserve =
    sandbox::HomeDriveSpaceReserve::new(MIN_FREE_BYTES_FLOOR, 10);
const MAX_HOME_PROMOTION_CONCURRENCY: usize = 4;
const HOME_PUBLICATION_IO_SLOTS: usize = 4;
#[cfg(any(test, feature = "test-support"))]
const TEST_FS_TOTAL_BYTES: u64 = 2_000 * GIB;
#[cfg(any(test, feature = "test-support"))]
const TEST_FS_AVAILABLE_BYTES: u64 = 1_000 * GIB;

#[derive(Clone)]
pub struct HomeImageCache {
    telemetry: Option<SandboxOpReporter>,
    is_first_run: Option<bool>,
    inner: Arc<HomeImageCacheInner>,
    idle_home_reclamation: Arc<IdleHomeReclamation>,
    background_gc: BackgroundGcActivity,
    #[cfg(any(test, feature = "test-support"))]
    prepare_lock_test_gate: Option<HomeImagePrepareLockTestGate>,
    #[cfg(any(test, feature = "test-support"))]
    inventory_test_gate: Option<HomeImagePrepareLockTestGate>,
    #[cfg(any(test, feature = "test-support"))]
    handoff_test_gate: Option<HomeImageHandoffTestGate>,
    #[cfg(any(test, feature = "test-support"))]
    routine_gc_test_gate: Option<(Arc<tokio::sync::Notify>, Arc<Semaphore>)>,
    #[cfg(test)]
    gc_inventory_test_gate: Option<gc::GcInventoryTestGate>,
    #[cfg(test)]
    publication_io_held_test_gate: Option<(Arc<tokio::sync::Notify>, Arc<Semaphore>)>,
    #[cfg(test)]
    publication_sync_test_gate: Option<HomeImageHandoffTestGate>,
    #[cfg(test)]
    publication_copy_test_gate: Option<HomeImagePrepareLockTestGate>,
    #[cfg(any(test, feature = "test-support"))]
    use_actual_fs_stats: bool,
    #[cfg(test)]
    pressure_reserve_override: Option<sandbox::HomeDriveSpaceReserve>,
    #[cfg(any(test, feature = "test-support"))]
    pressure_turn_test_gate: Option<HomeImagePrepareLockTestGate>,
    #[cfg(test)]
    pressure_completion_test_gate: Option<HomeImagePrepareLockTestGate>,
    #[cfg(test)]
    pressure_inventory_stopped_test_gate: Option<HomeImagePrepareLockTestGate>,
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
/// Synchronizes accepted physical revocation in isolated cancellation tests.
#[cfg(any(test, feature = "test-support"))]
#[derive(Clone, Default)]
pub struct HomeImageHandoffTestGate {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<(Mutex<bool>, std::sync::Condvar)>,
}
#[cfg(any(test, feature = "test-support"))]
pub struct HomeImageHandoffTestRelease(HomeImageHandoffTestGate);
#[cfg(any(test, feature = "test-support"))]
impl Drop for HomeImageHandoffTestRelease {
    fn drop(&mut self) {
        self.0.release();
    }
}
#[cfg(any(test, feature = "test-support"))]
impl HomeImageHandoffTestGate {
    pub fn release_on_drop(&self) -> HomeImageHandoffTestRelease {
        HomeImageHandoffTestRelease(self.clone())
    }

    fn enter_and_wait(&self) {
        self.entered.notify_one();
        let (released, wake) = &*self.release;
        let mut released = released.lock().unwrap();
        while !*released {
            released = wake.wait(released).unwrap();
        }
    }

    pub async fn wait_entered(&self, timeout: std::time::Duration) {
        tokio::time::timeout(timeout, self.entered.notified())
            .await
            .expect("handoff must reach physical revocation");
    }

    pub fn release(&self) {
        let (released, wake) = &*self.release;
        *released.lock().unwrap() = true;
        wake.notify_all();
    }
}
struct HomeImageCacheInner {
    paths: RunnerPaths,
    cache_dir: PathBuf,
    lock_dir: PathBuf,
    cache_scope: String,
    entry_lock_owners: Mutex<HashMap<String, HomeCacheLockRegistration>>,
    publication_admission: Semaphore,
    checkout_io: TaskTracker,
    selection_releases: SelectionReleases,
    pressure_reclamation: PressureReclamation,
    #[cfg(test)]
    pressure_demand_accepted: tokio::sync::Notify,
    #[cfg(test)]
    publication_admission_entered: Semaphore,
    #[cfg(any(test, feature = "test-support"))]
    fs_stats_override: Mutex<FsStats>,
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
    RemoveStagingBeforeImageRename,
    UnexpectedExdev,
    BeforeCopy,
    BeforeCandidateDirectorySync,
    BeforeMetadataSync,
    PartialMetadataWrite,
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
                    ..FsStats::default()
                },
            )
        }
        #[cfg(not(any(test, feature = "test-support")))]
        {
            Self {
                telemetry: None,
                is_first_run: None,
                inner: Arc::new(HomeImageCacheInner {
                    paths,
                    cache_dir,
                    lock_dir,
                    cache_scope: scope.to_owned(),
                    entry_lock_owners: Mutex::new(HashMap::new()),
                    publication_admission: Semaphore::new(HOME_PUBLICATION_IO_SLOTS),
                    checkout_io: TaskTracker::new(),
                    selection_releases: SelectionReleases::default(),
                    pressure_reclamation: PressureReclamation::new(),
                }),
                idle_home_reclamation: Arc::new(IdleHomeReclamation::new(
                    MAX_HOME_PROMOTION_CONCURRENCY,
                )),
                background_gc: BackgroundGcActivity::default(),
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
            telemetry: None,
            is_first_run: None,
            inner: Arc::new(HomeImageCacheInner {
                paths,
                cache_dir,
                lock_dir,
                cache_scope: scope.to_owned(),
                entry_lock_owners: Mutex::new(HashMap::new()),
                publication_admission: Semaphore::new(HOME_PUBLICATION_IO_SLOTS),
                checkout_io: TaskTracker::new(),
                selection_releases: SelectionReleases::default(),
                pressure_reclamation: PressureReclamation::new(),
                #[cfg(test)]
                pressure_demand_accepted: tokio::sync::Notify::new(),
                #[cfg(test)]
                publication_admission_entered: Semaphore::new(0),
                fs_stats_override: Mutex::new(stats),
                gc_root_scan_count: AtomicUsize::new(0),
                held_state_root_scan_count: AtomicUsize::new(0),
                held_state_root_scan_notify: tokio::sync::Notify::new(),
                #[cfg(test)]
                publication_fault: AtomicUsize::new(0),
            }),
            idle_home_reclamation: Arc::new(IdleHomeReclamation::new(
                MAX_HOME_PROMOTION_CONCURRENCY,
            )),
            background_gc: BackgroundGcActivity::default(),
            prepare_lock_test_gate: None,
            inventory_test_gate: None,
            handoff_test_gate: None,
            routine_gc_test_gate: None,
            #[cfg(test)]
            gc_inventory_test_gate: None,
            #[cfg(test)]
            publication_io_held_test_gate: None,
            #[cfg(test)]
            publication_sync_test_gate: None,
            #[cfg(test)]
            publication_copy_test_gate: None,
            use_actual_fs_stats: false,
            #[cfg(test)]
            pressure_reserve_override: None,
            pressure_turn_test_gate: None,
            #[cfg(test)]
            pressure_completion_test_gate: None,
            #[cfg(test)]
            pressure_inventory_stopped_test_gate: None,
        }
    }
    pub fn with_telemetry(mut self, telemetry: SandboxOpReporter) -> Self {
        self.telemetry = Some(telemetry);
        self
    }

    /// Bind only background collection to the current Running generation.
    /// Foreground demand, publication and explicit manual GC keep their authority.
    /// A later mode change expires this clone's background work permanently;
    /// resumed admission must bind a fresh clone to the new generation.
    pub fn with_background_gc_lifecycle(
        mut self,
        mut mode: tokio::sync::watch::Receiver<crate::lifecycle::RunnerMode>,
    ) -> Self {
        mode.borrow_and_update();
        self.background_gc = BackgroundGcActivity::Running(mode);
        self
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn with_handoff_test_gate(mut self, gate: HomeImageHandoffTestGate) -> Self {
        self.handoff_test_gate = Some(gate);
        self
    }

    pub fn with_first_run(mut self, is_first_run: Option<bool>) -> Self {
        self.is_first_run = is_first_run;
        self
    }

    fn with_promotion_capacity(mut self, capacity: usize) -> Self {
        self.idle_home_reclamation = Arc::new(IdleHomeReclamation::new(capacity.max(1)));
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
        Arc::clone(&self.idle_home_reclamation.permits)
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

    #[cfg(any(test, feature = "test-support"))]
    pub fn with_inventory_test_gate(mut self, gate: HomeImagePrepareLockTestGate) -> Self {
        self.inventory_test_gate = Some(gate);
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

    #[cfg(test)]
    async fn remove_staging_before_image_rename_for_test(
        &self,
        staging: &std::path::Path,
    ) -> LifecycleResult<()> {
        if self
            .inner
            .publication_fault
            .compare_exchange(
                PublicationFault::RemoveStagingBeforeImageRename as usize,
                0,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .is_ok()
        {
            tokio::fs::remove_file(staging).await?;
        }
        Ok(())
    }
}
