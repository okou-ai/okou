use std::path::PathBuf;
use std::time::Duration;

use futures_util::future::BoxFuture;
use runner_host::host_memory::HostMemoryObservation;
use runner_lifecycle::home_image_cache::{HomeImageLeaseIdentity, HomeImagePrepareRequest};
use runner_lifecycle::home_promotion::test_support::{
    TEST_HOME_IMAGE_SIZE_BYTES, add_healthy_cache_preparation_matcher, test_home_image,
};
use runner_lifecycle::host_memory_operations::{
    HostMemoryOperations, MemoryObservationSource, MemoryOperationPolicy,
};
use runner_lifecycle::host_memory_policy::HostMemoryBounds;
use runner_lifecycle::idle_pool::IdleRetirementEnvelope;
use sandbox_mock::{MockBackingProcess, MockLifecycleGate, MockSandbox, MockSandboxOverrides};

use super::*;

const MIB: u64 = 1024 * 1024;
const WAIT: Duration = Duration::from_secs(5);

fn memory_policy() -> MemoryOperationPolicy {
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
        max_cleanup_inflight: 2,
    }
}

struct FileSource(PathBuf);

impl MemoryObservationSource for FileSource {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(HostMemoryObservation::read_at(&self.0))
    }
}

#[tokio::test]
async fn cancelled_guarded_receiver_keeps_tracker_shutdown_saving_and_reuse_notification() {
    exercise_cancelled_receiver(false).await;
}

#[tokio::test]
async fn accepted_pool_retirement_survives_caller_cancellation_and_tracker_close() {
    exercise_cancelled_receiver(true).await;
}

async fn exercise_cancelled_receiver(from_pool: bool) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("meminfo");
    tokio::fs::write(&path, "MemAvailable: 65536 kB\n")
        .await
        .unwrap();
    let operations =
        HostMemoryOperations::new(memory_policy(), Arc::new(FileSource(path))).unwrap();
    let fixture = HomePromotionFixture::new("thread:cancelled-guarded-tracker").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    add_healthy_cache_preparation_matcher(&overrides);
    let kill = MockLifecycleGate::new();
    let destroy = MockLifecycleGate::new();
    overrides.set_kill_lifecycle_gate(kill.clone());
    overrides.set_destroy_lifecycle_gate(destroy.clone());
    let (exit, backing) = MockBackingProcess::channel();
    let sandbox = MockSandbox::with_overrides(fixture.sandbox_id.to_string(), overrides.clone())
        .with_backing_process(backing);
    let factory: Arc<Box<dyn SandboxFactory>> =
        Arc::new(Box::new(MockSandboxFactory::with_overrides(overrides)));
    let budget = Arc::new(ResourceBudget::new(2, 2048, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap();
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
    let mut candidate = ParkedIdleCandidateBuilder::new(&fixture.reuse_key, lease)
        .with_sandbox_id(fixture.sandbox_id)
        .with_sandbox(Box::new(sandbox))
        .with_factory(factory)
        .with_home_promotion(fixture.promotion)
        .build();
    if from_pool {
        candidate.capture_retirement_backing().unwrap();
    }
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let envelope = IdleRetirementEnvelope {
        live_growth_bytes: 8 * MIB,
        tail_growth_bytes: MIB,
    };
    let notify = Arc::new(Notify::new());
    let tracker = IdleDestroyTracker::new(notify.clone());
    let mut task = if from_pool {
        let candidate = pool
            .retirement_candidate(&runner_lifecycle::idle_pool::IdleSandboxIdentity::Exact(
                fixture.reuse_key.clone(),
            ))
            .unwrap();
        let pool = Arc::new(tokio::sync::Mutex::new(pool));
        let started = tracker
            .retire_pool_entry(
                &pool,
                &operations,
                IdlePoolRetirementRequest {
                    candidate,
                    envelope,
                    context: "cancelled_pool_tracker",
                },
            )
            .await
            .unwrap();
        assert!(started.snapshot.idle_sandboxes.is_empty());
        assert!(
            pool.lock()
                .await
                .status_snapshot()
                .idle_sandboxes
                .is_empty()
        );
        started.task
    } else {
        let mut retirement =
            GuardedIdleRetirement::new(pool.drain().pop().unwrap(), &operations, envelope).unwrap();
        retirement.try_grant().await.unwrap();
        tracker
            .spawn_guarded_retirement(retirement, "cancelled_guarded_tracker")
            .unwrap()
    };
    let (waiting, observed) = oneshot::channel();
    let caller = tokio::spawn(async move {
        let join = task.join();
        tokio::pin!(join);
        assert!(futures_util::poll!(join.as_mut()).is_pending());
        waiting.send(()).unwrap();
        join.await
    });
    observed.await.unwrap();
    kill.wait_entered(1, WAIT).await.unwrap();
    caller.abort();
    assert!(caller.await.err().unwrap().is_cancelled());
    exit.confirm_exit();
    tokio::time::timeout(WAIT, async {
        while operations.snapshot().unwrap().started != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(operations.snapshot().unwrap().cleanup_growth_bytes, MIB);
    assert_eq!(budget.allocated(), (2, 2048, 1));
    let tracker_shutdown = tracker.close_and_wait();
    let memory_shutdown = operations.close_and_wait();
    let notification = notify.notified();
    tokio::pin!(tracker_shutdown, memory_shutdown, notification);
    assert!(futures_util::poll!(tracker_shutdown.as_mut()).is_pending());
    assert!(futures_util::poll!(memory_shutdown.as_mut()).is_pending());
    assert!(futures_util::poll!(notification.as_mut()).is_pending());
    kill.release_one();
    destroy.wait_entered(1, WAIT).await.unwrap();
    assert!(futures_util::poll!(tracker_shutdown.as_mut()).is_pending());
    assert!(futures_util::poll!(notification.as_mut()).is_pending());
    destroy.release_one();
    tokio::time::timeout(WAIT, tracker_shutdown).await.unwrap();
    let report = tokio::time::timeout(WAIT, memory_shutdown)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(WAIT, notification).await.unwrap();
    assert_eq!((report.registered_operations, report.tracked_tasks), (0, 0));
    assert_eq!(budget.allocated(), (0, 0, 0));
    let mut checkout = fixture
        .cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default",
                rootfs_hash: "test-rootfs",
                reuse_key: Some(&fixture.reuse_key),
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
        sandbox::HomeDriveSeedImage::Copy(path) | sandbox::HomeDriveSeedImage::Move(path) => path,
    };
    assert_eq!(tokio::fs::read(path).await.unwrap(), test_home_image());
}

struct HeldSource {
    path: PathBuf,
    entered: Arc<Notify>,
    release: Arc<Notify>,
}

impl MemoryObservationSource for HeldSource {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(async move {
            let sample = HostMemoryObservation::read_at(&self.path).await;
            self.entered.notify_one();
            self.release.notified().await;
            sample
        })
    }
}

#[tokio::test]
async fn held_or_cancelled_pool_admission_never_holds_inventory_or_detaches_resources() {
    use runner_lifecycle::idle_pool::IdleSandboxIdentity;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("meminfo");
    tokio::fs::write(&path, "MemAvailable: 65536 kB\n")
        .await
        .unwrap();
    let entered = Arc::new(Notify::new());
    let operations = HostMemoryOperations::new(
        memory_policy(),
        Arc::new(HeldSource {
            path,
            entered: entered.clone(),
            release: Arc::new(Notify::new()),
        }),
    )
    .unwrap();
    let budget = Arc::new(ResourceBudget::new(2, 8, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 8).unwrap();
    let (exit, backing) = MockBackingProcess::channel();
    let overrides = Arc::new(MockSandboxOverrides::new());
    let mut candidate = ParkedIdleCandidateBuilder::new("thread:held-pool-admission", lease)
        .with_sandbox(Box::new(
            MockSandbox::with_overrides("held-pool-admission", overrides.clone())
                .with_backing_process(backing),
        ))
        .build();
    candidate.capture_retirement_backing().unwrap();
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let identity = IdleSandboxIdentity::Exact("thread:held-pool-admission".into());
    let request = IdlePoolRetirementRequest {
        candidate: pool.retirement_candidate(&identity).unwrap(),
        envelope: IdleRetirementEnvelope {
            live_growth_bytes: 8 * MIB,
            tail_growth_bytes: MIB,
        },
        context: "held_pool_admission",
    };
    let pool = Arc::new(tokio::sync::Mutex::new(pool));
    let tracker = cleanup_tracker();
    let caller = tokio::spawn({
        let pool = pool.clone();
        let operations = operations.clone();
        let tracker = tracker.clone();
        async move { tracker.retire_pool_entry(&pool, &operations, request).await }
    });
    tokio::time::timeout(WAIT, entered.notified())
        .await
        .unwrap();
    {
        let pool = tokio::time::timeout(WAIT, pool.lock()).await.unwrap();
        assert!(pool.retirement_candidate(&identity).is_ok());
    }
    assert_eq!(budget.allocated(), (2, 8, 1));
    assert_eq!(overrides.unpark_call_count(), 0);
    assert_eq!(overrides.kill_call_count(), 0);
    caller.abort();
    assert!(caller.await.is_err_and(|error| error.is_cancelled()));
    assert_eq!(operations.snapshot().unwrap().registered_operations, 0);
    tracker.close_and_wait().await;
    assert!(pool.lock().await.retirement_candidate(&identity).is_ok());
    exit.confirm_exit();
    let jobs = pool.lock().await.drain();
    for job in jobs {
        job.run_with_context("fixture_held_admission_recovery")
            .await;
    }
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn closed_supervisor_refuses_pool_retirement_without_inventory_mutation() {
    use runner_lifecycle::idle_pool::IdleSandboxIdentity;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("meminfo");
    tokio::fs::write(&path, "MemAvailable: 65536 kB\n")
        .await
        .unwrap();
    let operations =
        HostMemoryOperations::new(memory_policy(), Arc::new(FileSource(path))).unwrap();
    let budget = Arc::new(ResourceBudget::new(2, 8, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 8).unwrap();
    let (exit, backing) = MockBackingProcess::channel();
    let mut candidate = ParkedIdleCandidateBuilder::new("thread:closed-pool-admission", lease)
        .with_sandbox(Box::new(
            MockSandbox::new("closed-pool-admission").with_backing_process(backing),
        ))
        .build();
    candidate.capture_retirement_backing().unwrap();
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let identity = IdleSandboxIdentity::Exact("thread:closed-pool-admission".into());
    let revision = pool.status_snapshot().revision;
    let request = IdlePoolRetirementRequest {
        candidate: pool.retirement_candidate(&identity).unwrap(),
        envelope: IdleRetirementEnvelope {
            live_growth_bytes: 8 * MIB,
            tail_growth_bytes: MIB,
        },
        context: "closed_pool_admission",
    };
    let pool = Arc::new(tokio::sync::Mutex::new(pool));
    let tracker = cleanup_tracker();
    tracker.close_and_wait().await;
    assert!(matches!(
        tracker.retire_pool_entry(&pool, &operations, request).await,
        Err(MemoryOperationError::Closed)
    ));
    assert_eq!(pool.lock().await.status_snapshot().revision, revision);
    assert!(pool.lock().await.retirement_candidate(&identity).is_ok());
    assert_eq!(budget.allocated(), (2, 8, 1));
    assert_eq!(operations.snapshot().unwrap().registered_operations, 0);
    exit.confirm_exit();
    let jobs = pool.lock().await.drain();
    for job in jobs {
        job.run_with_context("fixture_closed_admission_recovery")
            .await;
    }
    assert_eq!(budget.allocated(), (0, 0, 0));
}

struct BackingDropProbe {
    identity: sandbox::BackingProcessIdentity,
    pool: std::sync::Weak<tokio::sync::Mutex<IdlePool>>,
    reported: Option<oneshot::Sender<bool>>,
}

#[async_trait::async_trait]
impl sandbox::SandboxBackingProcess for BackingDropProbe {
    fn identity(&self) -> sandbox::BackingProcessIdentity {
        self.identity
    }
    async fn exit_confirmed(&self) -> bool {
        false
    }
}

impl Drop for BackingDropProbe {
    fn drop(&mut self) {
        let unlocked = self
            .pool
            .upgrade()
            .is_some_and(|pool| pool.try_lock().is_ok());
        if let Some(reported) = self.reported.take() {
            let _ = reported.send(unlocked);
        }
    }
}

#[tokio::test]
async fn stale_pool_request_releases_its_last_provider_observer_after_unlocking_inventory() {
    use runner_lifecycle::idle_pool::IdleSandboxIdentity;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("meminfo");
    tokio::fs::write(&path, "MemAvailable: 65536 kB\n")
        .await
        .unwrap();
    let operations =
        HostMemoryOperations::new(memory_policy(), Arc::new(FileSource(path))).unwrap();
    let pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
        max_idle: 1,
    })));
    let budget = Arc::new(ResourceBudget::new(2, 8, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 8).unwrap();
    let (reported, observation) = oneshot::channel();
    let backing = Arc::new(BackingDropProbe {
        identity: sandbox::BackingProcessIdentity::new_generation(),
        pool: Arc::downgrade(&pool),
        reported: Some(reported),
    });
    let mut candidate = ParkedIdleCandidateBuilder::new("thread:stale-pool-observer", lease)
        .with_sandbox(Box::new(
            MockSandbox::new("stale-pool-observer").with_backing_process(backing),
        ))
        .build();
    candidate.capture_retirement_backing().unwrap();
    let identity = IdleSandboxIdentity::Exact("thread:stale-pool-observer".into());
    let candidate = {
        let mut pool = pool.lock().await;
        assert!(matches!(pool.park(candidate), ParkResult::Parked));
        pool.retirement_candidate(&identity).unwrap()
    };
    // A real independent owner has already completed disposal. The old claim
    // now holds the last retained provider observation, not a physical sandbox.
    let jobs = pool.lock().await.drain();
    for job in jobs {
        job.run_with_context("fixture_stale_owner_recovery").await;
    }
    assert_eq!(budget.allocated(), (0, 0, 0));
    let tracker = cleanup_tracker();
    let result = tracker
        .retire_pool_entry(
            &pool,
            &operations,
            IdlePoolRetirementRequest {
                candidate,
                envelope: IdleRetirementEnvelope {
                    live_growth_bytes: 8 * MIB,
                    tail_growth_bytes: MIB,
                },
                context: "stale_pool_observer",
            },
        )
        .await;
    assert!(matches!(result, Err(MemoryOperationError::ResourceChanged)));
    assert!(
        tokio::time::timeout(WAIT, observation)
            .await
            .unwrap()
            .unwrap()
    );
    assert_eq!(operations.snapshot().unwrap().registered_operations, 0);
    tracker.close_and_wait().await;
}
