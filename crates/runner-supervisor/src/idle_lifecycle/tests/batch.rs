use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::future::BoxFuture;
use runner_host::host_memory::HostMemoryObservation;
use runner_lifecycle::home_image_cache::{
    HomeImageCache, HomeImageLeaseIdentity, HomeImagePrepareRequest,
};
use runner_lifecycle::home_promotion::test_support::{
    TEST_HOME_IMAGE_SIZE_BYTES, add_healthy_cache_preparation_matcher, test_home_image,
};
use runner_lifecycle::host_memory_operations::{MemoryObservationSource, MemoryOperationPolicy};
use runner_lifecycle::host_memory_policy::HostMemoryBounds;
use runner_lifecycle::idle_pool::{
    IdleRetirementBatchScope, IdleRetirementEnvelope, ParkedIdleCandidate,
};
use sandbox_mock::{
    MockBackingProcess, MockBackingProcessCompletion, MockLifecycleGate, MockSandbox,
    MockSandboxOverrides,
};

use super::*;

mod activation;
mod admission;
mod insertion;
mod logical;
mod ownership;
mod pressure;

const MIB: u64 = 1024 * 1024;
const WAIT: Duration = Duration::from_secs(5);

struct FileSource(PathBuf);

impl MemoryObservationSource for FileSource {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(HostMemoryObservation::read_at(&self.0))
    }
}

struct GatedSource {
    path: PathBuf,
    hold_on: usize,
    calls: AtomicUsize,
    entered: Notify,
    release: Notify,
}

impl GatedSource {
    fn new(path: PathBuf, hold_on: usize) -> Arc<Self> {
        Arc::new(Self {
            path,
            hold_on,
            calls: AtomicUsize::new(0),
            entered: Notify::new(),
            release: Notify::new(),
        })
    }

    async fn wait_entered(&self) {
        tokio::time::timeout(WAIT, self.entered.notified())
            .await
            .unwrap();
    }
}

impl MemoryObservationSource for GatedSource {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(async move {
            if self.calls.fetch_add(1, Ordering::Relaxed) == self.hold_on {
                self.entered.notify_one();
                self.release.notified().await;
            }
            HostMemoryObservation::read_at(&self.path).await
        })
    }
}

fn policy() -> MemoryOperationPolicy {
    MemoryOperationPolicy {
        bounds: HostMemoryBounds {
            host_total_bytes: 64 * MIB,
            operating_floor_bytes: 2 * MIB,
            cleanup_reserve_bytes: 4 * MIB,
            critical_available_bytes: 2 * MIB,
            recovery_available_bytes: 8 * MIB,
        },
        max_sample_age: Duration::from_secs(10),
        max_operations: 16,
        max_cleanup_inflight: 4,
    }
}

struct BatchFixture {
    dir: tempfile::TempDir,
    pool: SharedIdlePool,
    budget: Arc<ResourceBudget>,
    operations: HostMemoryOperations,
    status: Arc<StatusTracker>,
    tracker: IdleDestroyTracker,
    meminfo: PathBuf,
}

impl BatchFixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let meminfo = dir.path().join("meminfo");
        tokio::fs::write(&meminfo, "MemAvailable: 65536 kB\n")
            .await
            .unwrap();
        let operations =
            HostMemoryOperations::new(policy(), Arc::new(FileSource(meminfo.clone()))).unwrap();
        let status = Arc::new(StatusTracker::new(
            dir.path().join("status.json"),
            4,
            None,
            None,
        ));
        status.write_initial().await.unwrap();
        Self {
            dir,
            pool: Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
                max_idle: 0,
            }))),
            budget: Arc::new(ResourceBudget::new(8, 8192, 1.0, 0)),
            operations,
            status,
            tracker: cleanup_tracker(),
            meminfo,
        }
    }

    fn gate_observation(&mut self, hold_on: usize) -> Arc<GatedSource> {
        let source = GatedSource::new(self.meminfo.clone(), hold_on);
        self.operations = HostMemoryOperations::new(policy(), source.clone()).unwrap();
        source
    }

    async fn park(&self, key: &str, captured: bool) -> ParkedHome {
        let (candidate, home) = self.candidate(key, captured).await;
        assert!(matches!(
            self.pool.lock().await.park(candidate),
            ParkResult::Parked
        ));
        home
    }

    async fn candidate(&self, key: &str, captured: bool) -> (ParkedIdleCandidate, ParkedHome) {
        let fixture = HomePromotionFixture::new(key).await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        add_healthy_cache_preparation_matcher(&overrides);
        let (exit, backing) = MockBackingProcess::channel();
        let lease = ResourceBudget::try_reserve_lease(&self.budget, 2, 2048).unwrap();
        let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
            MockSandboxFactory::with_overrides(overrides.clone()),
        ));
        let mut candidate = ParkedIdleCandidateBuilder::new(key, lease)
            .with_sandbox_id(fixture.sandbox_id)
            .with_sandbox(Box::new(
                MockSandbox::with_overrides(fixture.sandbox_id.to_string(), overrides.clone())
                    .with_backing_process(backing),
            ))
            .with_factory(factory)
            .with_home_promotion(fixture.promotion)
            .build();
        if captured {
            candidate.capture_retirement_backing().unwrap();
        }
        (
            candidate,
            ParkedHome {
                _dir: fixture._dir,
                cache: fixture.cache,
                key: key.into(),
                id: fixture.sandbox_id,
                exit: Some(exit),
                overrides,
            },
        )
    }

    async fn start(
        &self,
        scope: IdleRetirementBatchScope,
    ) -> IdleCleanupTask<IdlePoolRetirementBatchReport> {
        self.tracker
            .start_pool_retirement_batch(
                self.pool.clone(),
                self.status.clone(),
                self.operations.clone(),
                IdlePoolBatchRetirementRequest {
                    scope,
                    envelope: IdleRetirementEnvelope {
                        live_growth_bytes: 8 * MIB,
                        tail_growth_bytes: MIB,
                    },
                    context: "test_captured_batch",
                },
            )
            .await
            .unwrap()
    }

    async fn recover(&self) {
        // Only invocation-owned fixture disposal after assertions; not an
        // admission fallback or a path used by the guarded batch implementation.
        let jobs = self.pool.lock().await.drain();
        for job in jobs {
            job.run_with_context("fixture_batch_disposal").await;
        }
        self.tracker.close_and_wait().await;
    }
}

struct ParkedHome {
    _dir: Arc<tempfile::TempDir>,
    cache: HomeImageCache,
    key: String,
    id: SandboxId,
    exit: Option<MockBackingProcessCompletion>,
    overrides: Arc<MockSandboxOverrides>,
}

impl ParkedHome {
    fn confirm_exit(&mut self) {
        self.exit.take().unwrap().confirm_exit();
    }

    async fn assert_active_bytes(&self) {
        assert_eq!(
            tokio::fs::read(self.cache.paths().active_home_image(&self.id))
                .await
                .unwrap(),
            test_home_image()
        );
    }

    async fn assert_cached_bytes(&self) {
        let mut checkout = self
            .cache
            .prepare(HomeImagePrepareRequest {
                identity: HomeImageLeaseIdentity {
                    run_id: RunId::new_v4(),
                    sandbox_id: SandboxId::new_v4(),
                    profile_name: "vm0/default",
                    rootfs_hash: "test-rootfs",
                    reuse_key: Some(&self.key),
                    working_dir:
                        api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR,
                    image_size_bytes: TEST_HOME_IMAGE_SIZE_BYTES,
                },
                home_drive_required: true,
            })
            .await;
        assert!(checkout.is_cache_hit());
        let seed = checkout.home_drive_config().unwrap().seed_image.unwrap();
        let path = match seed {
            sandbox::HomeDriveSeedImage::Copy(path) | sandbox::HomeDriveSeedImage::Move(path) => {
                path
            }
        };
        assert_eq!(tokio::fs::read(path).await.unwrap(), test_home_image());
    }
}

async fn join(
    task: &mut IdleCleanupTask<IdlePoolRetirementBatchReport>,
) -> IdlePoolRetirementBatchReport {
    tokio::time::timeout(WAIT, task.join())
        .await
        .unwrap()
        .unwrap()
}
