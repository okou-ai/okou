use super::*;

use runner_lifecycle::idle_pool::test_support::ParkedIdleCandidateBuilder;
use runner_lifecycle::idle_pool::{IdlePool, IdlePoolConfig, ParkingGate};

fn profile(vcpu: u32, memory_mb: u32) -> BlankProfile {
    BlankProfile {
        vcpu,
        memory_mb,
        rootfs_hash: "test-rootfs".into(),
        home_disk_mb: 10240,
    }
}

#[tokio::test]
async fn aged_exact_cleanup_and_publication_remain_owned_until_shutdown() {
    let profiles = BTreeMap::from([("vm0/default".to_owned(), profile(2, 4096))]);
    let factory: SharedFactory = Arc::new(Box::new(sandbox_mock::MockSandboxFactory::new()));
    let factories = BTreeMap::from([("vm0/default".to_owned(), (factory, true))]);
    let budget = Arc::new(ResourceBudget::new(32, 65_536, 1.0, 0));
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let gate = sandbox_mock::MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(gate.clone());
    let exact_factory: SharedFactory = Arc::new(Box::new(
        sandbox_mock::MockSandboxFactory::with_overrides(overrides),
    ));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
    assert!(matches!(
        pool.park_at_for_test(
            ParkedIdleCandidateBuilder::new("aged-before-status", lease)
                .with_factory(exact_factory)
                .build(),
            Instant::now() - Duration::from_secs(40 * 60)
        ),
        ParkResult::Parked
    ));
    let idle_pool = Arc::new(tokio::sync::Mutex::new(pool));
    let dir = tempfile::tempdir().unwrap();
    let status = Arc::new(StatusTracker::new(
        dir.path().join("status.json"),
        1,
        None,
        None,
    ));
    status.write_initial().await.unwrap();
    let held = status.hold_state_for_test().await;
    let tracker = IdleDestroyTracker::new(Arc::new(tokio::sync::Notify::new()));
    let admission = PreSpawnAdmission::new(2).unwrap();
    let mut replenisher = BlankPoolReplenisher::new(&profiles, &factories, &budget, 1, None);
    replenisher
        .maybe_start(
            RunnerMode::Running,
            &idle_pool,
            &budget,
            &admission,
            &status,
            &tracker,
        )
        .await;
    assert!(replenisher.is_preparing());
    gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
    assert_eq!(budget.allocated().2, 1);
    let preparation_shutdown = replenisher.shutdown(&tracker);
    tokio::pin!(preparation_shutdown);
    assert!(preparation_shutdown.as_mut().now_or_never().is_none());
    gate.release_one();
    tokio::time::timeout(Duration::from_secs(5), preparation_shutdown)
        .await
        .unwrap();
    assert_eq!(budget.allocated(), (0, 0, 0));
    let shutdown = tracker.close_and_wait();
    tokio::pin!(shutdown);
    let retained = shutdown.as_mut().now_or_never().is_none();
    drop(held);
    tokio::time::timeout(Duration::from_secs(5), shutdown)
        .await
        .unwrap();
    assert!(retained);
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert!(idle_pool.lock().await.is_empty());
    let persisted: serde_json::Value = serde_json::from_str(
        &tokio::fs::read_to_string(dir.path().join("status.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(persisted.get("idle_sandboxes").is_none());
    assert!(persisted.get("blank_sandboxes").is_none());
}

fn enabled_diagnostics() -> BlankPoolDiagnostics {
    BlankPoolDiagnostics {
        plan: Some(BlankPoolDiagnosticPlan {
            profile_name: "vm0/default".into(),
            device_rate_limits: None,
        }),
        state: Arc::new(Mutex::new(BlankPoolObservedState::Ready)),
    }
}

async fn observed_empty_selection(
    replenisher: &BlankPoolReplenisher,
    idle_pool: &SharedIdlePool,
    budget: &ResourceBudget,
) -> BlankPoolSelection {
    let pool = idle_pool.lock().await;
    replenisher
        .diagnostics()
        .classify_empty("vm0/default", &None, pool.revision(), budget)
}

#[test]
fn diagnostics_classify_inventory_and_plan_facts() {
    let diagnostics = enabled_diagnostics();
    let budget = ResourceBudget::new(8, 16_384, 1.0, 0);

    assert_eq!(
        diagnostics.classify_empty("vm0/large", &None, 0, &budget),
        BlankPoolSelection::Miss(BlankPoolSelectionReason::IncompatibleShape)
    );
    assert_eq!(
        diagnostics.classify_empty("vm0/default", &None, 0, &budget),
        BlankPoolSelection::Miss(BlankPoolSelectionReason::EmptyInventory)
    );
    assert_eq!(
        BlankPoolDiagnostics::new(None).classify_empty("vm0/default", &None, 0, &budget),
        BlankPoolSelection::Miss(BlankPoolSelectionReason::DisabledPlan)
    );
}

#[test]
fn diagnostics_classify_live_preparation_and_preemption() {
    let diagnostics = enabled_diagnostics();
    let budget = ResourceBudget::new(8, 16_384, 1.0, 0);
    let cancel = CancellationToken::new();
    diagnostics.preparing(cancel.clone());
    assert_eq!(
        diagnostics.classify_empty("vm0/default", &None, 0, &budget),
        BlankPoolSelection::Miss(BlankPoolSelectionReason::RefillInProgress)
    );

    cancel.cancel();
    assert_eq!(
        diagnostics.classify_empty("vm0/default", &None, 0, &budget),
        BlankPoolSelection::Miss(BlankPoolSelectionReason::ForegroundPreempted)
    );
}

#[test]
fn diagnostics_keep_only_fresh_bounded_suppression() {
    let diagnostics = enabled_diagnostics();
    let pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
    let budget = Arc::new(ResourceBudget::new(8, 16_384, 1.0, 0));

    for reason in [
        BlankPoolSelectionReason::ResourceUnavailable,
        BlankPoolSelectionReason::HeadroomReserved,
    ] {
        diagnostics.suppressed(reason, &pool, Some(budget.allocated()));
        assert_eq!(
            diagnostics.classify_empty("vm0/default", &None, pool.revision(), &budget,),
            BlankPoolSelection::Miss(reason)
        );
    }

    diagnostics.suppressed(BlankPoolSelectionReason::MaxIdle, &pool, None);
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    assert_eq!(
        diagnostics.classify_empty("vm0/default", &None, pool.revision(), &budget),
        BlankPoolSelection::Miss(BlankPoolSelectionReason::MaxIdle)
    );
    drop(lease);

    diagnostics.suppressed(
        BlankPoolSelectionReason::ResourceUnavailable,
        &pool,
        Some(budget.allocated()),
    );
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    assert_eq!(
        diagnostics.classify_empty("vm0/default", &None, pool.revision(), &budget),
        BlankPoolSelection::Miss(BlankPoolSelectionReason::Unknown)
    );
    drop(lease);

    diagnostics.suppressed(
        BlankPoolSelectionReason::ResourceUnavailable,
        &pool,
        Some(budget.allocated()),
    );
    assert_eq!(
        diagnostics.classify_empty("vm0/default", &None, pool.revision() + 1, &budget,),
        BlankPoolSelection::Miss(BlankPoolSelectionReason::Unknown)
    );
    diagnostics.unknown();
    assert_eq!(
        diagnostics.classify_empty("vm0/default", &None, pool.revision(), &budget),
        BlankPoolSelection::Miss(BlankPoolSelectionReason::Unknown)
    );
}

#[tokio::test]
async fn replenisher_classifies_authoritative_suppression_branches() {
    let mut profiles = BTreeMap::new();
    profiles.insert("vm0/default".to_owned(), profile(2, 4096));
    let factory: SharedFactory = Arc::new(Box::new(sandbox_mock::MockSandboxFactory::new()));
    let mut factories = BTreeMap::new();
    factories.insert("vm0/default".to_owned(), (factory, true));
    let temp = tempfile::tempdir().unwrap();
    let status = Arc::new(StatusTracker::new(
        temp.path().join("status.json"),
        1,
        None,
        None,
    ));
    let tracker = IdleDestroyTracker::new(Arc::new(tokio::sync::Notify::new()));

    let budget = Arc::new(ResourceBudget::new(20, 40_960, 1.0, 0));
    let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
        max_idle: 0,
    })));
    let admission = PreSpawnAdmission::new(2).unwrap();
    let foreground_cancel = CancellationToken::new();
    let foreground = admission.acquire(2, &foreground_cancel).await.unwrap();
    let mut replenisher = BlankPoolReplenisher::new(&profiles, &factories, &budget, 0, None);
    replenisher
        .maybe_start(
            RunnerMode::Running,
            &idle_pool,
            &budget,
            &admission,
            &status,
            &tracker,
        )
        .await;
    assert!(!replenisher.is_preparing());
    assert_eq!(
        observed_empty_selection(&replenisher, &idle_pool, &budget).await,
        BlankPoolSelection::Miss(BlankPoolSelectionReason::Unknown)
    );
    drop(foreground);

    let budget = Arc::new(ResourceBudget::new(20, 40_960, 1.0, 0));
    let held = ResourceBudget::try_reserve_lease(&budget, 18, 36_864).unwrap();
    let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
        max_idle: 0,
    })));
    let admission = PreSpawnAdmission::new(2).unwrap();
    let mut replenisher = BlankPoolReplenisher::new(&profiles, &factories, &budget, 0, None);
    replenisher
        .maybe_start(
            RunnerMode::Running,
            &idle_pool,
            &budget,
            &admission,
            &status,
            &tracker,
        )
        .await;
    assert_eq!(
        observed_empty_selection(&replenisher, &idle_pool, &budget).await,
        BlankPoolSelection::Miss(BlankPoolSelectionReason::ResourceUnavailable)
    );
    drop(held);

    let budget = Arc::new(ResourceBudget::new(20, 40_960, 1.0, 0));
    let held = ResourceBudget::try_reserve_lease(&budget, 17, 34_816).unwrap();
    let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
        max_idle: 0,
    })));
    let admission = PreSpawnAdmission::new(2).unwrap();
    let mut replenisher = BlankPoolReplenisher::new(&profiles, &factories, &budget, 0, None);
    replenisher
        .maybe_start(
            RunnerMode::Running,
            &idle_pool,
            &budget,
            &admission,
            &status,
            &tracker,
        )
        .await;
    assert_eq!(
        observed_empty_selection(&replenisher, &idle_pool, &budget).await,
        BlankPoolSelection::Miss(BlankPoolSelectionReason::HeadroomReserved)
    );
    drop(held);

    let budget = Arc::new(ResourceBudget::new(20, 40_960, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
    assert!(matches!(
        pool.park(ParkedIdleCandidateBuilder::new("recent-exact", lease).build()),
        ParkResult::Parked
    ));
    let idle_pool = Arc::new(tokio::sync::Mutex::new(pool));
    let admission = PreSpawnAdmission::new(2).unwrap();
    let mut replenisher = BlankPoolReplenisher::new(&profiles, &factories, &budget, 1, None);
    replenisher
        .maybe_start(
            RunnerMode::Running,
            &idle_pool,
            &budget,
            &admission,
            &status,
            &tracker,
        )
        .await;
    assert_eq!(
        observed_empty_selection(&replenisher, &idle_pool, &budget).await,
        BlankPoolSelection::Miss(BlankPoolSelectionReason::MaxIdle)
    );
    for job in idle_pool.lock().await.drain() {
        job.run().await;
    }
    tracker.close_and_wait().await;
}

#[test]
fn target_scales_with_capacity_and_operator_cap() {
    assert_eq!(blank_pool_target(0, 0), 0);
    assert_eq!(blank_pool_target(1, 0), 0);
    assert_eq!(blank_pool_target(2, 0), 0);
    assert_eq!(blank_pool_target(5, 0), 1);
    assert_eq!(blank_pool_target(62, 0), 6);
    assert_eq!(blank_pool_target(62, 4), 4);
}

#[tokio::test]
async fn replenisher_creates_parks_and_publishes_one_blank_sandbox() {
    let mut profiles = BTreeMap::new();
    profiles.insert("vm0/default".to_owned(), profile(2, 4096));
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory: SharedFactory = Arc::new(Box::new(
        sandbox_mock::MockSandboxFactory::with_overrides(overrides.clone()),
    ));
    let mut factories = BTreeMap::new();
    factories.insert("vm0/default".to_owned(), (factory, true));
    let budget = Arc::new(ResourceBudget::new(16, 32_768, 1.0, 0));
    let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new_with_parking_gate(
        IdlePoolConfig { max_idle: 0 },
        ParkingGate::new_open(),
    )));
    let temp = tempfile::tempdir().unwrap();
    let status = Arc::new(StatusTracker::new(
        temp.path().join("status.json"),
        7,
        None,
        None,
    ));
    let idle_destroy_tracker = IdleDestroyTracker::new(Arc::new(tokio::sync::Notify::new()));
    let admission = PreSpawnAdmission::new(4).unwrap();
    let mut replenisher = BlankPoolReplenisher::new(&profiles, &factories, &budget, 0, None);

    replenisher
        .maybe_start(
            RunnerMode::Running,
            &idle_pool,
            &budget,
            &admission,
            &status,
            &idle_destroy_tracker,
        )
        .await;
    assert!(replenisher.is_preparing());
    {
        let pool = idle_pool.lock().await;
        assert_eq!(
            replenisher.diagnostics().classify_empty(
                "vm0/default",
                &None,
                pool.revision(),
                &budget,
            ),
            BlankPoolSelection::Miss(BlankPoolSelectionReason::RefillInProgress)
        );
    }
    let result = replenisher
        .wait_for_preparation()
        .await
        .expect("preparation should be active");
    replenisher
        .finish_preparation(result, &idle_pool, &status, &idle_destroy_tracker)
        .await;

    let mut pool = idle_pool.lock().await;
    assert_eq!(pool.blank_len(), 1);
    assert_eq!(
        overrides.create_configs()[0]
            .home_drive
            .as_ref()
            .unwrap()
            .space_reserve,
        runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
    );
    assert!(pool.status_snapshot().idle_sandboxes.is_empty());
    assert_eq!(pool.status_snapshot().blank_sandboxes.len(), 1);
    assert!(pool.held_sandbox_states().is_empty());
    let destroy = pool.drain();
    drop(pool);
    for job in destroy {
        job.run().await;
    }
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert!(admission.try_acquire_background(4).unwrap().is_some());
    replenisher.shutdown(&idle_destroy_tracker).await;
    idle_destroy_tracker.close_and_wait().await;
}

#[tokio::test]
async fn aged_exact_capacity_is_converted_to_blanks_one_at_a_time() {
    let mut profiles = BTreeMap::new();
    profiles.insert("vm0/default".to_owned(), profile(2, 4096));
    let blank_factory: SharedFactory = Arc::new(Box::new(sandbox_mock::MockSandboxFactory::new()));
    let mut factories = BTreeMap::new();
    factories.insert("vm0/default".to_owned(), (blank_factory, true));
    let budget = Arc::new(ResourceBudget::new(32, 65_536, 1.0, 0));
    let mut pool =
        IdlePool::new_with_parking_gate(IdlePoolConfig { max_idle: 2 }, ParkingGate::new_open());
    let exact_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    exact_overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let exact_factory: SharedFactory = Arc::new(Box::new(
        sandbox_mock::MockSandboxFactory::with_overrides(exact_overrides),
    ));
    let now = Instant::now();
    for (reuse_key, idle_for) in [
        ("older-exact", Duration::from_secs(40 * 60)),
        ("newer-exact", Duration::from_secs(30 * 60)),
    ] {
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let candidate = ParkedIdleCandidateBuilder::new(reuse_key, lease)
            .with_factory(Arc::clone(&exact_factory))
            .build();
        assert!(matches!(
            pool.park_at_for_test(candidate, now - idle_for),
            ParkResult::Parked
        ));
    }
    let idle_pool = Arc::new(tokio::sync::Mutex::new(pool));
    let temp = tempfile::tempdir().unwrap();
    let status_path = temp.path().join("status.json");
    let status = Arc::new(StatusTracker::new(status_path.clone(), 2, None, None));
    let reuse_state_notify = Arc::new(tokio::sync::Notify::new());
    let idle_destroy_tracker = IdleDestroyTracker::new(Arc::clone(&reuse_state_notify));
    let admission = PreSpawnAdmission::new(2).unwrap();
    let mut replenisher = BlankPoolReplenisher::new(&profiles, &factories, &budget, 2, None);

    replenisher
        .maybe_start(
            RunnerMode::Running,
            &idle_pool,
            &budget,
            &admission,
            &status,
            &idle_destroy_tracker,
        )
        .await;
    destroy_gate
        .wait_entered(1, Duration::from_secs(2))
        .await
        .expect("first exact destroy should start");
    tokio::time::timeout(Duration::from_secs(2), reuse_state_notify.notified())
        .await
        .expect("exact removal should request an immediate heartbeat");
    assert_eq!(idle_pool.lock().await.held_reuse_keys(), ["newer-exact"]);
    let status_json = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match tokio::fs::read_to_string(&status_path).await {
                Ok(status) => break status,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    tokio::task::yield_now().await;
                }
                Err(error) => panic!("read published idle inventory: {error}"),
            }
        }
    })
    .await
    .expect("accepted retirement inventory must be published");
    assert!(!status_json.contains("older-exact"));
    assert!(status_json.contains("newer-exact"));

    replenisher.request_attempt();
    replenisher
        .maybe_start(
            RunnerMode::Running,
            &idle_pool,
            &budget,
            &admission,
            &status,
            &idle_destroy_tracker,
        )
        .await;
    assert_eq!(idle_pool.lock().await.held_reuse_keys(), ["newer-exact"]);

    destroy_gate.release_many(1);
    let first = replenisher.wait_for_preparation().await.unwrap();
    replenisher
        .finish_preparation(first, &idle_pool, &status, &idle_destroy_tracker)
        .await;
    assert_eq!(idle_pool.lock().await.blank_len(), 1);

    replenisher
        .maybe_start(
            RunnerMode::Running,
            &idle_pool,
            &budget,
            &admission,
            &status,
            &idle_destroy_tracker,
        )
        .await;
    destroy_gate
        .wait_entered(2, Duration::from_secs(2))
        .await
        .expect("second exact destroy should start only after the first conversion");
    assert_eq!(idle_pool.lock().await.blank_len(), 1);

    destroy_gate.release_many(1);
    let second = replenisher.wait_for_preparation().await.unwrap();
    replenisher
        .finish_preparation(second, &idle_pool, &status, &idle_destroy_tracker)
        .await;
    let mut pool = idle_pool.lock().await;
    assert_eq!(pool.len(), 2);
    assert_eq!(pool.blank_len(), 2);
    let destroy = pool.drain();
    drop(pool);
    for job in destroy {
        job.run().await;
    }
    assert_eq!(budget.allocated(), (0, 0, 0));
    replenisher.shutdown(&idle_destroy_tracker).await;
    idle_destroy_tracker.close_and_wait().await;
}

#[tokio::test]
async fn uncertain_aged_exact_cleanup_does_not_create_a_blank() {
    let mut profiles = BTreeMap::new();
    profiles.insert("vm0/default".to_owned(), profile(2, 4096));
    let blank_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let blank_factory: SharedFactory = Arc::new(Box::new(
        sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&blank_overrides)),
    ));
    let mut factories = BTreeMap::new();
    factories.insert("vm0/default".to_owned(), (blank_factory, true));
    let budget = Arc::new(ResourceBudget::new(12, 24_576, 1.0, 0));
    let mut pool =
        IdlePool::new_with_parking_gate(IdlePoolConfig { max_idle: 1 }, ParkingGate::new_open());
    let exact_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    exact_overrides.push_destroy_panic("simulated aged exact destroy panic");
    let exact_factory: SharedFactory = Arc::new(Box::new(
        sandbox_mock::MockSandboxFactory::with_overrides(exact_overrides),
    ));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let candidate = ParkedIdleCandidateBuilder::new("aged-exact", lease)
        .with_factory(exact_factory)
        .build();
    assert!(matches!(
        pool.park_at_for_test(candidate, Instant::now() - EXACT_IDLE_CAPACITY_YIELD_AGE,),
        ParkResult::Parked
    ));
    let idle_pool = Arc::new(tokio::sync::Mutex::new(pool));
    let temp = tempfile::tempdir().unwrap();
    let status = Arc::new(StatusTracker::new(
        temp.path().join("status.json"),
        1,
        None,
        None,
    ));
    let idle_destroy_tracker = IdleDestroyTracker::new(Arc::new(tokio::sync::Notify::new()));
    let admission = PreSpawnAdmission::new(2).unwrap();
    let mut replenisher = BlankPoolReplenisher::new(&profiles, &factories, &budget, 1, None);

    replenisher
        .maybe_start(
            RunnerMode::Running,
            &idle_pool,
            &budget,
            &admission,
            &status,
            &idle_destroy_tracker,
        )
        .await;
    let result = replenisher.wait_for_preparation().await.unwrap();
    assert!(matches!(
        result,
        BlankPrepareResult::Failed(BlankPrepareFailure {
            stage: "retire_exact",
            error: Some(_),
        })
    ));
    assert!(blank_overrides.create_configs().is_empty());
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert_eq!(idle_pool.lock().await.len(), 0);
    replenisher.shutdown(&idle_destroy_tracker).await;
    idle_destroy_tracker.close_and_wait().await;
}

#[tokio::test]
async fn foreground_admission_preempts_blank_conversion_during_exact_destroy() {
    let mut profiles = BTreeMap::new();
    profiles.insert("vm0/default".to_owned(), profile(2, 4096));
    let blank_factory: SharedFactory = Arc::new(Box::new(sandbox_mock::MockSandboxFactory::new()));
    let mut factories = BTreeMap::new();
    factories.insert("vm0/default".to_owned(), (blank_factory, true));
    let budget = Arc::new(ResourceBudget::new(12, 24_576, 1.0, 0));
    let mut pool =
        IdlePool::new_with_parking_gate(IdlePoolConfig { max_idle: 1 }, ParkingGate::new_open());
    let exact_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    exact_overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let exact_factory: SharedFactory = Arc::new(Box::new(
        sandbox_mock::MockSandboxFactory::with_overrides(exact_overrides),
    ));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let candidate = ParkedIdleCandidateBuilder::new("aged-exact", lease)
        .with_factory(exact_factory)
        .build();
    assert!(matches!(
        pool.park_at_for_test(candidate, Instant::now() - EXACT_IDLE_CAPACITY_YIELD_AGE,),
        ParkResult::Parked
    ));
    let idle_pool = Arc::new(tokio::sync::Mutex::new(pool));
    let temp = tempfile::tempdir().unwrap();
    let status = Arc::new(StatusTracker::new(
        temp.path().join("status.json"),
        1,
        None,
        None,
    ));
    let idle_destroy_tracker = IdleDestroyTracker::new(Arc::new(tokio::sync::Notify::new()));
    let admission = PreSpawnAdmission::new(2).unwrap();
    let mut replenisher = BlankPoolReplenisher::new(&profiles, &factories, &budget, 1, None);

    replenisher
        .maybe_start(
            RunnerMode::Running,
            &idle_pool,
            &budget,
            &admission,
            &status,
            &idle_destroy_tracker,
        )
        .await;
    destroy_gate
        .wait_entered(1, Duration::from_secs(2))
        .await
        .expect("aged exact destroy should start");

    let foreground_cancel = CancellationToken::new();
    let foreground = tokio::time::timeout(
        Duration::from_secs(2),
        admission.acquire(2, &foreground_cancel),
    )
    .await
    .expect("foreground admission should not wait for exact destroy")
    .unwrap();
    assert!(replenisher.is_preparing());
    assert_eq!(budget.allocated().2, 1);
    {
        let pool = idle_pool.lock().await;
        assert_eq!(
            replenisher.diagnostics().classify_empty(
                "vm0/default",
                &None,
                pool.revision(),
                &budget,
            ),
            BlankPoolSelection::Miss(BlankPoolSelectionReason::ForegroundPreempted)
        );
    }

    destroy_gate.release_many(1);
    let result = replenisher.wait_for_preparation().await.unwrap();
    assert!(matches!(
        result,
        BlankPrepareResult::Failed(BlankPrepareFailure {
            stage: "retire_exact",
            error: None,
        })
    ));
    assert_eq!(
        observed_empty_selection(&replenisher, &idle_pool, &budget).await,
        BlankPoolSelection::Miss(BlankPoolSelectionReason::ForegroundPreempted)
    );
    replenisher
        .finish_preparation(result, &idle_pool, &status, &idle_destroy_tracker)
        .await;
    assert_eq!(
        observed_empty_selection(&replenisher, &idle_pool, &budget).await,
        BlankPoolSelection::Miss(BlankPoolSelectionReason::ForegroundPreempted)
    );
    drop(foreground);
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert_eq!(idle_pool.lock().await.len(), 0);
    replenisher.shutdown(&idle_destroy_tracker).await;
    idle_destroy_tracker.close_and_wait().await;
}
