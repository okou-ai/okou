use super::*;

mod batch;
mod guarded;
mod ownership;

fn cleanup_tracker() -> IdleDestroyTracker {
    IdleDestroyTracker::new(Arc::new(Notify::new()))
}

use sandbox::{ResourceLimits, SandboxConfig, SandboxFactory};
use sandbox_mock::MockSandboxFactory;

use runner_lifecycle::home_promotion::test_support::{HomePromotionFixture, TEST_COMPLETED_AT};
use runner_lifecycle::idle_pool::{
    ExactIdleReservationMiss, IdleParkRequest, IdleParkRequestParts, IdlePool, IdlePoolConfig,
    ParkResult, ParkingGate, test_support::ParkedIdleCandidateBuilder,
};
use runner_lifecycle::idle_reuse_preparation::add_healthy_reuse_preparation_matcher;
use runner_lifecycle::resource_budget::ResourceBudget;
use runner_storage::storage_fingerprints::StorageFingerprints;

fn claimed_idle_pool(
    gate: ParkingGate,
    native_generation_run_id: RunId,
) -> (SharedIdlePool, Arc<ResourceBudget>, SandboxId) {
    let budget = Arc::new(ResourceBudget::new(2, 2048, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap();
    let sandbox_id = SandboxId::new_v4();
    let mut pool = IdlePool::new_with_parking_gate(IdlePoolConfig { max_idle: 2 }, gate);
    assert!(matches!(
        pool.park(
            ParkedIdleCandidateBuilder::new("thread:claimed-idle", lease)
                .with_sandbox_id(sandbox_id)
                .with_source_run_id(native_generation_run_id)
                .with_native_generation_run_id(native_generation_run_id)
                .build()
        ),
        ParkResult::Parked
    ));
    (Arc::new(tokio::sync::Mutex::new(pool)), budget, sandbox_id)
}

#[tokio::test]
async fn claimed_idle_reservation_rollback_restores_pool_and_status() {
    let generation = RunId::new_v4();
    let (idle_pool, budget, sandbox_id) = claimed_idle_pool(ParkingGate::new_open(), generation);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let status = StatusTracker::new(path.clone(), 4, None, None);
    status.write_initial().await.unwrap();
    let initial = idle_pool.lock().await.status_snapshot();
    status.set_idle_snapshot(initial.clone()).await.unwrap();

    let reservation =
        reserve_reusable_idle_for_spawn(&idle_pool, "thread:claimed-idle", "vm0/default", &None)
            .await
            .expect("ordinary matching sandbox should reserve");
    assert_eq!(idle_pool.lock().await.len(), 0);
    assert_eq!(reservation.idle_snapshot.revision, initial.revision + 1);
    assert!(reservation.idle_snapshot.idle_sandboxes.is_empty());
    status
        .set_idle_snapshot(reservation.idle_snapshot.clone())
        .await
        .unwrap();
    let reuse_state_notify = Notify::new();
    rollback_reserved_idle_for_spawn(
        reservation,
        &idle_pool,
        &status,
        &reuse_state_notify,
        &cleanup_tracker(),
    )
    .await;

    let restored = idle_pool.lock().await.status_snapshot();
    assert_eq!(restored.revision, initial.revision + 2);
    assert_eq!(restored.idle_sandboxes.len(), 1);
    assert_eq!(restored.idle_sandboxes[0].sandbox_id, sandbox_id);
    let wire: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
    assert_eq!(
        wire["idle_sandboxes"][0]["sandbox_id"],
        sandbox_id.to_string()
    );
    assert!(reuse_state_notify.notified().now_or_never().is_none());
    assert_eq!(budget.allocated(), (2, 2048, 1));
    destroy_idle_jobs_and_wait(
        &cleanup_tracker(),
        idle_pool.lock().await.drain(),
        "claimed_idle_test",
    )
    .await;
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn claimed_exact_reservation_classifies_miss_without_mutation() {
    let generation = RunId::new_v4();
    let (idle_pool, budget, sandbox_id) = claimed_idle_pool(ParkingGate::new_open(), generation);
    let initial_revision = idle_pool.lock().await.revision();
    let other_limits = sandbox::DeviceRateLimits {
        block: sandbox::BlockRateLimits {
            bandwidth_bytes_per_sec: 1024,
            ops_per_sec: 100,
        },
        network: sandbox::NetworkRateLimits {
            rx_bytes_per_sec: 1024,
            tx_bytes_per_sec: 1024,
        },
    };
    for (reuse_key, profile, device_rate_limits, native_generation_run_id, expected) in [
        (
            "missing-key",
            "vm0/default",
            None,
            generation,
            ExactIdleReservationMiss::Absent,
        ),
        (
            "thread:claimed-idle",
            "other-profile",
            None,
            generation,
            ExactIdleReservationMiss::ProfileMismatch,
        ),
        (
            "thread:claimed-idle",
            "vm0/default",
            Some(other_limits),
            generation,
            ExactIdleReservationMiss::DeviceLimitMismatch,
        ),
        (
            "thread:claimed-idle",
            "vm0/default",
            None,
            RunId::new_v4(),
            ExactIdleReservationMiss::SourceMismatch,
        ),
    ] {
        let miss = reserve_exact_idle_for_spawn(
            &idle_pool,
            reuse_key,
            profile,
            &device_rate_limits,
            native_generation_run_id,
        )
        .await;
        assert!(matches!(miss, Err(reason) if reason == expected));
        let pool = idle_pool.lock().await;
        assert_eq!(pool.revision(), initial_revision);
        assert!(pool.contains_sandbox_id(sandbox_id));
    }
    let reservation = reserve_exact_idle_for_spawn(
        &idle_pool,
        "thread:claimed-idle",
        "vm0/default",
        &None,
        generation,
    )
    .await
    .expect("matching generation should reserve");
    assert_eq!(reservation.idle_snapshot.revision, initial_revision + 1);
    let dir = tempfile::tempdir().unwrap();
    let status = StatusTracker::new(dir.path().join("status.json"), 4, None, None);
    status.write_initial().await.unwrap();
    rollback_reserved_idle_for_spawn(
        reservation,
        &idle_pool,
        &status,
        &Notify::new(),
        &cleanup_tracker(),
    )
    .await;
    destroy_idle_jobs_and_wait(
        &cleanup_tracker(),
        idle_pool.lock().await.drain(),
        "claimed_exact_test",
    )
    .await;
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn rejected_claimed_idle_rollback_destroys_and_notifies() {
    let gate = ParkingGate::new_open();
    let (idle_pool, budget, _) = claimed_idle_pool(gate.clone(), RunId::new_v4());
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let status = StatusTracker::new(path.clone(), 4, None, None);
    status.write_initial().await.unwrap();
    let initial = idle_pool.lock().await.status_snapshot();
    status.set_idle_snapshot(initial).await.unwrap();
    let reservation =
        reserve_reusable_idle_for_spawn(&idle_pool, "thread:claimed-idle", "vm0/default", &None)
            .await
            .expect("sandbox should reserve before soft drain");
    status
        .set_idle_snapshot(reservation.idle_snapshot.clone())
        .await
        .unwrap();
    gate.close();
    let reuse_state_notify = Notify::new();
    rollback_reserved_idle_for_spawn(
        reservation,
        &idle_pool,
        &status,
        &reuse_state_notify,
        &cleanup_tracker(),
    )
    .await;

    assert_eq!(idle_pool.lock().await.len(), 0);
    assert_eq!(budget.allocated(), (0, 0, 0));
    let wire: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
    assert!(wire.get("idle_sandboxes").is_none());
    assert!(reuse_state_notify.notified().now_or_never().is_some());
}

#[tokio::test]
async fn exact_prune_keeps_reserved_entry_and_publishes_selected_snapshot() {
    let budget = Arc::new(ResourceBudget::new(8, 8192, 1.0, 2));
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 2 });
    for key in ["reserved", "pruned"] {
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap();
        assert!(matches!(
            pool.park(ParkedIdleCandidateBuilder::new(key, lease).build()),
            ParkResult::Parked
        ));
    }
    let reservation = pool.take_reserved("reserved").unwrap();
    let idle_pool = Arc::new(tokio::sync::Mutex::new(pool));
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let status = StatusTracker::new(path.clone(), 4, None, None);
    status.write_initial().await.unwrap();
    let tracker = IdleDestroyTracker::new(Arc::new(Notify::new()));

    let report = prune_exact_idle_pool(&idle_pool, &status, &tracker)
        .await
        .unwrap();
    assert_eq!(
        (report.selected, report.completed, report.uncertain),
        (1, 1, 0)
    );
    assert_eq!(budget.allocated(), (2, 2048, 1));
    assert_eq!(idle_pool.lock().await.len(), 0);
    let wire: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
    assert!(wire.get("idle_sandboxes").is_none());
    assert!(matches!(
        idle_pool.lock().await.restore_reserved(reservation),
        RestoreReservedIdleResult::Restored
    ));
    destroy_idle_jobs_and_wait(
        &cleanup_tracker(),
        idle_pool.lock().await.drain(),
        "exact_prune_test",
    )
    .await;
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn exact_prune_status_failure_or_cancellation_keeps_destroy_owned() {
    for cancel_caller in [false, true] {
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        let gate = sandbox_mock::MockLifecycleGate::new();
        overrides.set_destroy_lifecycle_gate(gate.clone());
        let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
            MockSandboxFactory::with_overrides(Arc::clone(&overrides)),
        ));
        let sandbox = factory
            .create(SandboxConfig {
                id: SandboxId::new_v4(),
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
                ParkedIdleCandidateBuilder::new("prune-with-gate", lease)
                    .with_sandbox(sandbox)
                    .with_factory(factory)
                    .build()
            ),
            ParkResult::Parked
        ));
        let idle_pool = Arc::new(tokio::sync::Mutex::new(pool));
        let dir = tempfile::tempdir().unwrap();
        let path = if cancel_caller {
            dir.path().join("status.json")
        } else {
            dir.path().join("missing/status.json")
        };
        let status = Arc::new(StatusTracker::new(path, 2, None, None));
        if cancel_caller {
            status.write_initial().await.unwrap();
        }
        let tracker = IdleDestroyTracker::new(Arc::new(Notify::new()));
        let pool_for_task = Arc::clone(&idle_pool);
        let status_for_task = Arc::clone(&status);
        let task_tracker = tracker.clone();
        let task = tokio::spawn(async move {
            prune_exact_idle_pool(&pool_for_task, &status_for_task, &task_tracker).await
        });
        gate.wait_entered(1, std::time::Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(idle_pool.lock().await.len(), 0);
        assert_eq!(budget.allocated(), (2, 2048, 1));
        if cancel_caller {
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
            let shutdown = tracker.close_and_wait();
            tokio::pin!(shutdown);
            assert!(
                shutdown.as_mut().now_or_never().is_none(),
                "shutdown must retain accepted prune cleanup"
            );
            gate.release_one();
            tokio::time::timeout(std::time::Duration::from_secs(5), shutdown)
                .await
                .unwrap();
        } else {
            gate.release_one();
            let error = task.await.unwrap().unwrap_err();
            assert!(error.contains("status publication failed"), "{error}");
        }
        tracker.close_and_wait().await;
        assert_eq!(budget.allocated(), (0, 0, 0));
    }
}

#[tokio::test]
async fn destroy_idle_jobs_and_wait_empty_returns_false() {
    assert!(!destroy_idle_jobs_and_wait(&cleanup_tracker(), Vec::new(), "test_empty").await);
}

#[tokio::test]
async fn destroy_idle_jobs_and_wait_reports_home_cache_promotion() {
    let fixture = HomePromotionFixture::new("thread:idle-destroy-cache").await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_reuse_preparation_matcher(&overrides);
    runner_lifecycle::home_promotion::test_support::add_healthy_cache_preparation_matcher(
        &overrides,
    );
    let factory: Arc<Box<dyn SandboxFactory>> =
        Arc::new(Box::new(MockSandboxFactory::with_overrides(overrides)));
    let sandbox = factory
        .create(SandboxConfig {
            id: fixture.sandbox_id,
            resources: ResourceLimits {
                cpu_count: 2,
                memory_mb: 4096,
            },
            device_rate_limits: None,
            home_drive: None,
        })
        .await
        .expect("create sandbox");
    let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let request = IdleParkRequest::new(IdleParkRequestParts {
        run_id: runner_types::ids::RunId::new_v4(),
        sandbox,
        factory,
        reuse_key: fixture.reuse_key.clone(),
        sandbox_id: fixture.sandbox_id,
        profile_name: "vm0/default".into(),
        rootfs_hash: "test-rootfs".into(),
        device_rate_limits: None,
        budget_lease: lease,
        source_ip: "10.0.0.1".into(),
        storage_fingerprints: StorageFingerprints::default(),
        restored_session_identity: None,
        native_generation_run_id: None,
        guest_timezone_intent: runner_lifecycle::guest_timezone::GuestTimezoneIntent::Unknown,
        home_image_size_bytes:
            runner_lifecycle::home_promotion::test_support::TEST_HOME_IMAGE_SIZE_BYTES,
        home_promotion: Some(fixture.promotion),
        handoff: None,
    });
    let candidate = match request.park_for_idle().await {
        Ok(outcome) => outcome
            .expect_reusable()
            .with_last_completed_at(TEST_COMPLETED_AT.into()),
        Err(_) => panic!("park should succeed"),
    };
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
    assert!(matches!(pool.park(candidate), ParkResult::Parked));

    let promoted =
        destroy_idle_jobs_and_wait(&cleanup_tracker(), pool.drain(), "test_idle_destroy_cache")
            .await;

    assert!(promoted);
    assert_eq!(budget.allocated(), (0, 0, 0));
    let held = fixture.cache.held_home_states().await;
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].reuse_key, fixture.reuse_key);
}
