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

struct FileSource(PathBuf);

impl MemoryObservationSource for FileSource {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(HostMemoryObservation::read_at(&self.0))
    }
}

#[tokio::test]
async fn cancelled_guarded_receiver_keeps_tracker_shutdown_saving_and_reuse_notification() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("meminfo");
    tokio::fs::write(&path, "MemAvailable: 65536 kB\n")
        .await
        .unwrap();
    let operations = HostMemoryOperations::new(
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
        },
        Arc::new(FileSource(path)),
    )
    .unwrap();
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
    assert!(matches!(
        pool.park(
            ParkedIdleCandidateBuilder::new(&fixture.reuse_key, lease)
                .with_sandbox_id(fixture.sandbox_id)
                .with_sandbox(Box::new(sandbox))
                .with_factory(factory)
                .with_home_promotion(fixture.promotion)
                .build()
        ),
        ParkResult::Parked
    ));
    let mut retirement = GuardedIdleRetirement::new(
        pool.drain().pop().unwrap(),
        &operations,
        IdleRetirementEnvelope {
            live_growth_bytes: 8 * MIB,
            tail_growth_bytes: MIB,
        },
    )
    .unwrap();
    retirement.try_grant().await.unwrap();
    let notify = Arc::new(Notify::new());
    let tracker = IdleDestroyTracker::new(notify.clone());
    let mut task = tracker
        .spawn_guarded_retirement(retirement, "cancelled_guarded_tracker")
        .unwrap();
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
