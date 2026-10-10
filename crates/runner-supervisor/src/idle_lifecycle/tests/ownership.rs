use super::*;
use std::time::Duration;

use runner_lifecycle::home_image_cache::{
    HomeCacheCheckoutResult, HomeImageLeaseIdentity, HomeImagePrepareRequest,
};
use runner_lifecycle::home_promotion::test_support::{TEST_HOME_IMAGE_SIZE_BYTES, test_home_image};
use sandbox_mock::{MockLifecycleGate, MockSandboxOverrides};

const WAIT: Duration = Duration::from_secs(5);

async fn owned_pool(overrides: Arc<MockSandboxOverrides>) -> (SharedIdlePool, Arc<ResourceBudget>) {
    let factory: Arc<Box<dyn SandboxFactory>> =
        Arc::new(Box::new(MockSandboxFactory::with_overrides(overrides)));
    let sandbox_id = SandboxId::new_v4();
    let sandbox = factory
        .create(SandboxConfig {
            id: sandbox_id,
            resources: ResourceLimits {
                cpu_count: 2,
                memory_mb: 2048,
            },
            device_rate_limits: None,
            home_drive: None,
        })
        .await
        .unwrap();
    let budget = Arc::new(ResourceBudget::new(2, 2048, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap();
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
    assert!(matches!(
        pool.park(
            ParkedIdleCandidateBuilder::new("owned", lease)
                .with_sandbox_id(sandbox_id)
                .with_sandbox(sandbox)
                .with_factory(factory)
                .build()
        ),
        ParkResult::Parked
    ));
    (Arc::new(tokio::sync::Mutex::new(pool)), budget)
}

#[tokio::test]
async fn cancelled_drain_retains_cleanup_and_lease_until_tracker_shutdown() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let gate = MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(gate.clone());
    let (pool, budget) = owned_pool(overrides).await;
    let dir = tempfile::tempdir().unwrap();
    let status = Arc::new(StatusTracker::new(
        dir.path().join("status.json"),
        1,
        None,
        None,
    ));
    status.write_initial().await.unwrap();
    status
        .set_idle_snapshot(pool.lock().await.status_snapshot())
        .await
        .unwrap();
    let tracker = cleanup_tracker();
    let task = tokio::spawn({
        let pool = Arc::clone(&pool);
        let status = Arc::clone(&status);
        let tracker = tracker.clone();
        async move { drain_idle_pool(&pool, &status, &tracker, "cancelled_drain").await }
    });
    gate.wait_entered(1, WAIT).await.unwrap();
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    assert_eq!(budget.allocated(), (2, 2048, 1));
    let shutdown = tracker.close_and_wait();
    tokio::pin!(shutdown);
    let retained = shutdown.as_mut().now_or_never().is_none();
    gate.release_one();
    tokio::time::timeout(WAIT, shutdown).await.unwrap();
    assert!(
        retained,
        "cancelled drain must remain in shutdown's work set"
    );
    assert_eq!(budget.allocated(), (0, 0, 0));
    drain_idle_pool(&pool, &status, &tracker, "final_status").await;
    let wire: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(dir.path().join("status.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(wire.get("idle_sandboxes").is_none());
}

#[tokio::test]
async fn rollback_accepts_cleanup_before_a_blocked_status_write() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let gate = MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(gate.clone());
    let (pool, budget) = owned_pool(overrides).await;
    let reservation = reserve_reusable_idle_for_spawn(&pool, "owned", "vm0/default", &None, None)
        .await
        .unwrap();
    pool.lock().await.parking_gate().close();
    let dir = tempfile::tempdir().unwrap();
    let status = Arc::new(StatusTracker::new(
        dir.path().join("status.json"),
        1,
        None,
        None,
    ));
    status.write_initial().await.unwrap();
    let held_status = status.hold_state_for_test().await;
    let tracker = cleanup_tracker();
    let task = tokio::spawn({
        let pool = Arc::clone(&pool);
        let status = Arc::clone(&status);
        let tracker = tracker.clone();
        async move {
            rollback_reserved_idle_for_spawn(reservation, &pool, &status, &Notify::new(), &tracker)
                .await
        }
    });
    gate.wait_entered(1, WAIT)
        .await
        .expect("cleanup must enter while publication is blocked");
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    assert_eq!(budget.allocated(), (2, 2048, 1));
    let shutdown = tracker.close_and_wait();
    tokio::pin!(shutdown);
    let retained = shutdown.as_mut().now_or_never().is_none();
    gate.release_one();
    tokio::time::timeout(WAIT, shutdown).await.unwrap();
    drop(held_status);
    assert!(retained);
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert!(pool.lock().await.is_empty());
}

#[tokio::test]
async fn cancelled_payload_wait_retains_lease_and_published_home_bytes() {
    let fixture = HomePromotionFixture::new("thread:cancelled-owned-payload").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    runner_lifecycle::home_promotion::test_support::add_healthy_cache_preparation_matcher(
        &overrides,
    );
    let gate = MockLifecycleGate::new();
    // Publication follows confirmed guest termination, so cancellation at
    // this external gate must still allow the real image commit afterward.
    overrides.set_kill_lifecycle_gate(gate.clone());
    let factory: Arc<Box<dyn SandboxFactory>> =
        Arc::new(Box::new(MockSandboxFactory::with_overrides(overrides)));
    let sandbox = factory
        .create(SandboxConfig {
            id: fixture.sandbox_id,
            resources: ResourceLimits {
                cpu_count: 2,
                memory_mb: 2048,
            },
            device_rate_limits: None,
            home_drive: None,
        })
        .await
        .unwrap();
    let budget = Arc::new(ResourceBudget::new(2, 2048, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap();
    let candidate = ParkedIdleCandidateBuilder::new(&fixture.reuse_key, lease)
        .with_sandbox_id(fixture.sandbox_id)
        .with_sandbox(sandbox)
        .with_factory(factory)
        .with_home_promotion(fixture.promotion)
        .build();
    let (payload, lease) = candidate.into_active_destroy_parts();
    let tracker = cleanup_tracker();
    let task = tokio::spawn({
        let tracker = tracker.clone();
        async move { destroy_idle_payload_and_wait(&tracker, payload, lease, "cancelled_payload").await }
    });
    gate.wait_entered(1, WAIT).await.unwrap();
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    assert_eq!(budget.allocated(), (2, 2048, 1));
    let shutdown = tracker.close_and_wait();
    tokio::pin!(shutdown);
    let retained = shutdown.as_mut().now_or_never().is_none();
    gate.release_one();
    tokio::time::timeout(WAIT, shutdown).await.unwrap();
    assert!(retained);
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
    assert_eq!(checkout.result(), HomeCacheCheckoutResult::Hit);
    let seed = checkout.home_drive_config().unwrap().seed_image.unwrap();
    let seed_path = match seed {
        sandbox::HomeDriveSeedImage::Copy(path) | sandbox::HomeDriveSeedImage::Move(path) => path,
    };
    assert_eq!(tokio::fs::read(seed_path).await.unwrap(), test_home_image());
}

#[tokio::test]
async fn tracked_prune_reports_uncertain_cleanup_after_provider_panic() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_kill_panic("owned terminal kill failed");
    let (pool, budget) = owned_pool(overrides).await;
    let dir = tempfile::tempdir().unwrap();
    let status = StatusTracker::new(dir.path().join("status.json"), 1, None, None);
    status.write_initial().await.unwrap();
    let tracker = cleanup_tracker();
    let report = prune_exact_idle_pool(&pool, &status, &tracker)
        .await
        .unwrap();
    assert_eq!(
        (report.selected, report.completed, report.uncertain),
        (1, 0, 1)
    );
    tracker.close_and_wait().await;
    assert_eq!(budget.allocated(), (0, 0, 0));
}
