use super::*;

#[tokio::test]
async fn mode_change_during_entered_park_joins_work_and_refuses_inventory_publication() {
    let mut owner = Owner::new().await;
    let park = MockLifecycleGate::new();
    owner.overrides.set_park_lifecycle_gate(park.clone());
    assert!(owner.start());
    park.wait_entered(1, WAIT).await.unwrap();
    owner.replenisher.cancel_if_inactive(RunnerMode::Draining);
    let foreground =
        tokio::time::timeout(WAIT, owner.admission.acquire(2, &CancellationToken::new()))
            .await
            .unwrap()
            .unwrap();
    assert_eq!(owner.fixture.budget.allocated(), (2, 2048, 1));
    park.release_one();
    let result = owner.ready().await;
    assert!(!result.snapshot().prepared && result.snapshot().retained_resource);
    owner.confirm_exit();
    let mut publication = request(&owner.fixture, &owner.admission, &owner.control);
    publication.mode = RunnerMode::Draining;
    owner
        .replenisher
        .finish_optional_preparation(&result, publication)
        .await
        .unwrap();
    assert!(!result.snapshot().published);
    assert_eq!(owner.fixture.pool.lock().await.blank_len(), 0);
    drop(foreground);
    owner.dispose().await;
}

#[tokio::test]
async fn publication_cannot_move_the_resource_to_another_pool_or_shutdown_registry() {
    let mut owner = Owner::new().await;
    assert!(owner.start());
    let result = owner.ready().await;
    let other_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
        max_idle: 1,
    })));
    let other_tracker = cleanup_tracker();
    for change_pool in [true, false] {
        let mut publication = request(&owner.fixture, &owner.admission, &owner.control);
        if change_pool {
            publication.pool = &other_pool;
        } else {
            publication.tracker = &other_tracker;
        }
        assert!(matches!(
            owner
                .replenisher
                .finish_optional_preparation(&result, publication)
                .await,
            Err(MemoryOperationError::OwnershipInvariant)
        ));
        assert!(result.snapshot().retained_resource);
        assert_eq!(owner.fixture.budget.allocated(), (2, 2048, 1));
        assert_eq!(other_pool.lock().await.len(), 0);
    }
    owner.publish(&result).await.unwrap();
    owner.dispose().await;
}

#[tokio::test]
async fn changed_pressure_during_fresh_grant_never_detaches_the_aged_victim() {
    let mut owner = Owner::new().await;
    let (candidate, mut home) = owner
        .fixture
        .candidate("thread:optional-grant-wait", true)
        .await;
    assert!(matches!(
        owner
            .fixture
            .pool
            .lock()
            .await
            .park_at_for_test(candidate, Instant::now() - Duration::from_secs(40 * 60)),
        ParkResult::Parked
    ));
    let source = GatedSource::new(owner.fixture.meminfo.clone(), 0);
    owner.fixture.operations =
        HostMemoryOperations::new(owner.fixture.operations.policy(), source.clone()).unwrap();
    owner.driver = HostPressureCoordinator::new(
        pressure_policy(&owner.fixture.operations),
        owner.fixture.operations.clone(),
    )
    .unwrap();
    owner.control = owner.driver.optional_control();
    owner.observe(32768).await;
    owner.observe(32768).await;
    assert!(owner.start());
    source.wait_entered().await;
    owner.observe(4096).await;
    source.release.notify_one();
    let result = owner.ready().await;
    assert!(!result.snapshot().retired_exact);
    assert_eq!(owner.fixture.pool.lock().await.len(), 1);
    assert_eq!(owner.fixture.budget.allocated(), (2, 2048, 1));
    assert!(owner.overrides.create_configs().is_empty());
    home.assert_active_bytes().await;
    owner.observe(32768).await;
    owner.observe(32768).await;
    home.confirm_exit();
    owner.dispose().await;
}

#[tokio::test]
async fn failed_guest_park_and_lost_backing_keep_full_no_progress_custody_after_shutdown() {
    let mut owner = Owner::new().await;
    owner
        .overrides
        .push_park_panic("optional park producer panic");
    assert!(owner.start());
    let result = owner.ready().await;
    assert!(result.snapshot().error.is_some() && result.snapshot().retained_resource);
    owner.exit.take().unwrap().fail_wait();
    owner
        .replenisher
        .shutdown_optional(&owner.fixture.tracker)
        .await
        .unwrap();
    owner.fixture.tracker.close_and_wait().await;
    assert_eq!(owner.fixture.budget.allocated(), (2, 2048, 1));
    assert_eq!(owner.overrides.destroy_call_count(), 0);
    let retained = owner
        .fixture
        .tracker
        .take_retained_activation_owners()
        .unwrap();
    assert_eq!(retained.len(), 1);
    assert!(!retained[0].cleanup_completed());
    assert!(
        owner
            .fixture
            .operations
            .close_and_wait()
            .await
            .unwrap()
            .uncertain
            > 0
    );
    // Explicit disposal of this invocation's uncertain external fixture.
    drop(retained);
    assert_eq!(owner.fixture.budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn late_pressure_change_while_publication_waits_on_pool_forces_required_cleanup() {
    let mut owner = Owner::new().await;
    assert!(owner.start());
    let result = owner.ready().await;
    owner.confirm_exit();
    let pool = owner.fixture.pool.lock().await;
    {
        let finish = owner.replenisher.finish_optional_preparation(
            &result,
            request(&owner.fixture, &owner.admission, &owner.control),
        );
        tokio::pin!(finish);
        assert!(futures_util::poll!(finish.as_mut()).is_pending());
        tokio::fs::write(&owner.fixture.meminfo, "MemAvailable: 4194304 kB\n")
            .await
            .unwrap();
        owner
            .driver
            .observe(HostMemoryObservation::read_at(&owner.fixture.meminfo).await);
        drop(pool);
        tokio::time::timeout(WAIT, finish).await.unwrap().unwrap();
    }
    assert!(!result.snapshot().published);
    assert_eq!(owner.fixture.pool.lock().await.blank_len(), 0);
    assert_eq!(owner.fixture.budget.allocated(), (0, 0, 0));
    owner.dispose().await;
}

#[tokio::test]
async fn entered_guest_start_is_joined_after_foreground_preempts_cpu() {
    let mut owner = Owner::new().await;
    let start = MockLifecycleGate::new();
    owner.overrides.set_start_lifecycle_gate(start.clone());
    assert!(owner.start());
    start.wait_entered(1, WAIT).await.unwrap();
    let foreground =
        tokio::time::timeout(WAIT, owner.admission.acquire(2, &CancellationToken::new()))
            .await
            .unwrap()
            .unwrap();
    assert_eq!(owner.fixture.budget.allocated(), (2, 2048, 1));
    let accounting = owner.fixture.operations.snapshot().unwrap();
    assert_eq!(accounting.registered_operations, 1);
    let result = {
        let waiting = owner.replenisher.wait_for_optional_preparation();
        tokio::pin!(waiting);
        assert!(futures_util::poll!(waiting.as_mut()).is_pending());
        start.release_one();
        tokio::time::timeout(WAIT, waiting).await.unwrap().unwrap()
    };
    assert!(!result.snapshot().prepared);
    assert!(result.snapshot().retained_resource);
    drop(foreground);
    owner.dispose().await;
}

#[tokio::test]
async fn transactional_create_wait_is_cancelled_without_waiting_for_unaccepted_acquisition() {
    let mut owner = Owner::new().await;
    let create = MockLifecycleGate::new();
    owner.overrides.set_create_lifecycle_gate(create.clone());
    assert!(owner.start());
    create.wait_entered(1, WAIT).await.unwrap();
    let foreground =
        tokio::time::timeout(WAIT, owner.admission.acquire(2, &CancellationToken::new()))
            .await
            .unwrap()
            .unwrap();
    let result = owner.ready().await;
    assert!(result.snapshot().error.is_some());
    assert!(!result.snapshot().retained_resource);
    assert_eq!(owner.fixture.budget.allocated(), (0, 0, 0));
    // Fresh was accepted, but no backing/positive completion exists: retain
    // physical uncertainty rather than falsely converting cancellation to RAM.
    assert_eq!(owner.fixture.operations.snapshot().unwrap().uncertain, 1);
    drop(foreground);
    owner.dispose().await;
}

#[tokio::test]
async fn critical_pressure_rejects_a_late_ready_result_via_required_cleanup() {
    let mut owner = Owner::new().await;
    assert!(owner.start());
    let result = owner.ready().await;
    assert!(result.snapshot().prepared);
    owner.observe(4096).await;
    owner.confirm_exit();
    owner.publish(&result).await.unwrap();
    assert!(!result.snapshot().published);
    assert_eq!(owner.fixture.pool.lock().await.blank_len(), 0);
    assert_eq!(owner.fixture.budget.allocated(), (0, 0, 0));
    owner.dispose().await;
}

#[tokio::test]
async fn equivalent_policy_on_another_controller_cannot_publish_the_owned_result() {
    let mut owner = Owner::new().await;
    assert!(owner.start());
    let result = owner.ready().await;
    let other = HostPressureCoordinator::new(
        pressure_policy(&owner.fixture.operations),
        owner.fixture.operations.clone(),
    )
    .unwrap();
    let control = other.optional_control();
    assert!(matches!(
        owner
            .replenisher
            .finish_optional_preparation(
                &result,
                request(&owner.fixture, &owner.admission, &control)
            )
            .await,
        Err(MemoryOperationError::OwnershipInvariant)
    ));
    assert!(result.snapshot().retained_resource);
    assert_eq!(owner.fixture.budget.allocated(), (2, 2048, 1));
    owner.publish(&result).await.unwrap();
    owner.dispose().await;
}

#[tokio::test]
async fn dropped_result_observer_and_replenisher_leave_full_resource_in_joined_registry() {
    let mut owner = Owner::new().await;
    assert!(owner.start());
    drop(owner.ready().await);
    drop(owner.replenisher);
    owner.fixture.tracker.close_and_wait().await;
    let retained = owner
        .fixture
        .tracker
        .take_retained_optional_blanks()
        .unwrap();
    assert_eq!(retained.len(), 1);
    assert!(retained[0].snapshot().retained_resource);
    assert_eq!(owner.fixture.budget.allocated(), (2, 2048, 1));
    assert_eq!(owner.overrides.destroy_call_count(), 0);
    owner.exit.take().unwrap().confirm_exit();
    // A recovered result still has its original required-cleanup capability,
    // even after the replenisher and its completed observer are gone.
    let recovery = cleanup_tracker();
    retained[0].retire(&recovery).await.unwrap();
    recovery.close_and_wait().await;
    assert!(!retained[0].snapshot().retained_resource);
    drop(retained);
    assert_eq!(owner.fixture.budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn pool_wait_does_not_block_foreground_or_drop_unfinished_attempt_on_shutdown() {
    let mut owner = Owner::new().await;
    let pool = owner.fixture.pool.lock().await;
    assert!(
        owner
            .replenisher
            .maybe_start_optional(request(&owner.fixture, &owner.admission, &owner.control))
            .unwrap()
    );
    let foreground =
        tokio::time::timeout(WAIT, owner.admission.acquire(2, &CancellationToken::new()))
            .await
            .unwrap()
            .unwrap();
    assert!(owner.overrides.create_configs().is_empty());
    assert_eq!(owner.fixture.budget.allocated(), (0, 0, 0));
    drop(pool);
    assert!(!owner.ready().await.snapshot().prepared);
    drop(foreground);
    owner.dispose().await;
}
