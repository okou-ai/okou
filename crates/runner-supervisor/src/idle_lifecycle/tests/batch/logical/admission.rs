use super::*;

#[tokio::test]
async fn reuse_arriving_during_admission_wins_without_detaching_the_original_victim() {
    let mut fixture = BatchFixture::new().await;
    let source = fixture.gate_observation(0);
    let mut original = fixture.park("thread:oldest-waiting-logical", true).await;
    let key = "thread:new-matching-logical";
    let caller = fixture.logical_request(IdlePressureRequest {
        run_id: RunId::new_v4(),
        reuse_key: Some(key),
        profile_name: "vm0/default",
        device_rate_limits: &None,
        allow_compatible_blank: false,
        blank_pool_diagnostics: None,
        vcpu: 6,
        memory_mb: 8192,
        context: "test_late_matching_reuse",
    });
    tokio::pin!(caller);
    tokio::select! {
        () = source.wait_entered() => {},
        _ = &mut caller => panic!("held grant completed"),
    }
    let mut matching = fixture.park(key, true).await;
    source.release.notify_one();
    let result = tokio::time::timeout(WAIT, caller).await.unwrap();
    let IdlePressureSelection::Reusable(reservation) = result.selection else {
        panic!("late matching reuse must win");
    };
    let (reservation, snapshot) = reservation.into_parts();
    assert_eq!(reservation.sandbox_id(), matching.id);
    assert_eq!(snapshot.idle_sandboxes.len(), 1);
    assert_eq!(snapshot.idle_sandboxes[0].sandbox_id, original.id);
    assert!(result.retirements.is_empty());
    assert!(result.not_started.is_empty());
    assert_eq!(
        fixture.operations.snapshot().unwrap().registered_operations,
        0
    );
    assert_eq!(fixture.budget.allocated(), (4, 4096, 2));
    assert_eq!(original.overrides.kill_call_count(), 0);
    original.assert_active_bytes().await;
    matching.assert_active_bytes().await;
    assert!(matches!(
        fixture.pool.lock().await.restore_reserved(reservation),
        RestoreReservedIdleResult::Restored
    ));
    original.confirm_exit();
    matching.confirm_exit();
    fixture.recover().await;
}

#[tokio::test]
async fn independently_released_fitting_capacity_after_wait_avoids_physical_eviction() {
    let mut fixture = BatchFixture::new().await;
    let source = fixture.gate_observation(0);
    let active = ResourceBudget::try_reserve_lease(&fixture.budget, 2, 4096).unwrap();
    let mut home = fixture.park("thread:unneeded-logical-victim", true).await;
    let caller = fixture.logical(4, 4096);
    tokio::pin!(caller);
    tokio::select! {
        () = source.wait_entered() => {},
        _ = &mut caller => panic!("held grant completed"),
    }
    let revision = fixture.pool.lock().await.status_snapshot().revision;
    drop(active);
    source.release.notify_one();
    let mut result = tokio::time::timeout(WAIT, caller).await.unwrap();
    let fitting = fresh(&mut result);
    assert_eq!((fitting.vcpu(), fitting.memory_mb()), (4, 4096));
    assert!(result.retirements.is_empty());
    assert_eq!(
        fixture.operations.snapshot().unwrap().registered_operations,
        0
    );
    assert_eq!(
        fixture.pool.lock().await.status_snapshot().revision,
        revision
    );
    assert_eq!(fixture.budget.allocated(), (6, 6144, 2));
    assert_eq!(home.overrides.kill_call_count(), 0);
    home.assert_active_bytes().await;
    drop(fitting);
    home.confirm_exit();
    fixture.recover().await;
}

#[tokio::test]
async fn proof_live_and_tail_refusals_preserve_original_inventory_full_lease_and_home_bytes() {
    for (captured, available_mib) in [(false, 64), (true, 9), (true, 10)] {
        let fixture = BatchFixture::new().await;
        let mut home = fixture.park("thread:refused-logical", captured).await;
        tokio::fs::write(
            &fixture.meminfo,
            format!("MemAvailable: {} kB\n", available_mib * 1024),
        )
        .await
        .unwrap();
        let revision = fixture.pool.lock().await.status_snapshot().revision;
        let result = fixture.logical(6, 8192).await;
        assert!(
            matches!(result.selection, IdlePressureSelection::Exhausted(ref leases) if leases.is_empty())
        );
        assert_eq!(result.not_started.len(), 1);
        assert_eq!(result.not_started[0].sandbox_id, home.id);
        if captured {
            assert!(matches!(
                result.not_started[0].error,
                MemoryOperationError::InsufficientHeadroom { .. }
            ));
        } else {
            assert_eq!(
                result.not_started[0].error,
                MemoryOperationError::MissingBacking
            );
        }
        assert!(result.retirements.is_empty());
        assert_eq!(
            fixture.pool.lock().await.status_snapshot().revision,
            revision
        );
        assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
        assert_eq!(
            fixture.operations.snapshot().unwrap().registered_operations,
            0
        );
        assert_eq!(home.overrides.kill_call_count(), 0);
        assert_eq!(home.overrides.destroy_call_count(), 0);
        home.assert_active_bytes().await;
        home.confirm_exit();
        fixture.recover().await;
    }
}

#[tokio::test]
async fn caller_cancelled_during_tail_observation_retains_the_complete_pool_owner() {
    let mut fixture = BatchFixture::new().await;
    let source = fixture.gate_observation(1);
    let mut home = fixture.park("thread:cancelled-logical-grant", true).await;
    let revision = fixture.pool.lock().await.status_snapshot().revision;
    {
        let caller = fixture.logical(6, 8192);
        tokio::pin!(caller);
        tokio::select! {
            () = source.wait_entered() => {},
            _ = &mut caller => panic!("held observation cannot return admission"),
        }
        assert_eq!(
            fixture.operations.snapshot().unwrap().cleanup_growth_bytes,
            8 * MIB
        );
        home.assert_active_bytes().await;
    }
    assert_eq!(
        fixture.operations.snapshot().unwrap().registered_operations,
        0
    );
    assert_eq!(
        fixture.pool.lock().await.status_snapshot().revision,
        revision
    );
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    assert_eq!(home.overrides.kill_call_count(), 0);
    home.confirm_exit();
    fixture.recover().await;
}

#[tokio::test]
async fn held_admission_cannot_detach_a_reserved_or_reparked_original_insertion() {
    for restored_before_grant in [false, true] {
        let mut fixture = BatchFixture::new().await;
        let source = fixture.gate_observation(0);
        let mut home = fixture.park("thread:reserved-logical", true).await;
        let caller = fixture.logical(6, 8192);
        tokio::pin!(caller);
        tokio::select! {
            () = source.wait_entered() => {},
            _ = &mut caller => panic!("held grant completed"),
        }
        let reservation = fixture.pool.lock().await.take_reserved(&home.key).unwrap();
        let mut reservation = Some(reservation);
        if restored_before_grant {
            assert!(matches!(
                fixture
                    .pool
                    .lock()
                    .await
                    .restore_reserved(reservation.take().unwrap()),
                RestoreReservedIdleResult::Restored
            ));
        }
        let revision = fixture.pool.lock().await.status_snapshot().revision;
        source.release.notify_one();
        let result = tokio::time::timeout(WAIT, caller).await.unwrap();
        assert!(matches!(
            result.selection,
            IdlePressureSelection::Exhausted(_)
        ));
        assert_eq!(result.not_started[0].sandbox_id, home.id);
        assert_eq!(
            result.not_started[0].error,
            MemoryOperationError::ResourceChanged
        );
        assert!(result.retirements.is_empty());
        assert_eq!(
            fixture.pool.lock().await.status_snapshot().revision,
            revision
        );
        assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
        assert_eq!(home.overrides.kill_call_count(), 0);
        home.assert_active_bytes().await;
        if let Some(reservation) = reservation {
            assert!(matches!(
                fixture.pool.lock().await.restore_reserved(reservation),
                RestoreReservedIdleResult::Restored
            ));
        }
        home.confirm_exit();
        fixture.recover().await;
    }
}

#[tokio::test]
async fn same_key_replacement_during_observation_does_not_become_the_captured_victim() {
    let mut fixture = BatchFixture::new().await;
    let source = fixture.gate_observation(0);
    let mut original = fixture.park("thread:replacement-logical", true).await;
    let caller = fixture.logical(6, 8192);
    tokio::pin!(caller);
    tokio::select! {
        () = source.wait_entered() => {},
        _ = &mut caller => panic!("held grant completed"),
    }
    let old = fixture.pool.lock().await.take(&original.key).unwrap();
    original.confirm_exit();
    old.into_destroy_job()
        .run_with_context("fixture_original_logical_disposal")
        .await;
    let mut replacement = fixture.park(&original.key, true).await;
    let revision = fixture.pool.lock().await.status_snapshot().revision;
    source.release.notify_one();
    let result = tokio::time::timeout(WAIT, caller).await.unwrap();
    assert_eq!(result.not_started[0].sandbox_id, original.id);
    assert_eq!(
        result.not_started[0].error,
        MemoryOperationError::ResourceChanged
    );
    assert!(result.retirements.is_empty());
    assert_eq!(
        fixture.pool.lock().await.status_snapshot().revision,
        revision
    );
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    assert_eq!(replacement.overrides.kill_call_count(), 0);
    replacement.assert_active_bytes().await;
    original.assert_cached_bytes().await;
    replacement.confirm_exit();
    fixture.recover().await;
}

#[tokio::test]
async fn exact_and_compatible_blank_reuse_precede_physical_retirement() {
    let fixture = BatchFixture::new().await;
    let mut home = fixture.park("thread:preferred-logical", true).await;
    let (exit, backing) = MockBackingProcess::channel();
    let id = SandboxId::new_v4();
    let mut blank = ParkedIdleCandidate::blank(
        Box::new(MockSandbox::new("preferred-blank").with_backing_process(backing)),
        Arc::new(Box::new(MockSandboxFactory::new())),
        ResourceBudget::try_reserve_lease(&fixture.budget, 2, 2048).unwrap(),
        id,
        "vm0/default".into(),
        "test-rootfs".into(),
        None,
    );
    blank.capture_retirement_backing().unwrap();
    assert!(matches!(
        fixture.pool.lock().await.park(blank),
        ParkResult::Parked
    ));
    for exact in [true, false] {
        let result = fixture
            .logical_request(IdlePressureRequest {
                run_id: RunId::new_v4(),
                reuse_key: exact.then_some(home.key.as_str()),
                profile_name: "vm0/default",
                device_rate_limits: &None,
                allow_compatible_blank: true,
                blank_pool_diagnostics: None,
                vcpu: 6,
                memory_mb: 8192,
                context: "test_preferred_reuse",
            })
            .await;
        let IdlePressureSelection::Reusable(reservation) = result.selection else {
            panic!("matching reuse must win");
        };
        let (reservation, _) = reservation.into_parts();
        assert_eq!(reservation.sandbox_id(), if exact { home.id } else { id });
        assert!(result.retirements.is_empty());
        assert!(result.not_started.is_empty());
        assert_eq!(
            fixture.operations.snapshot().unwrap().registered_operations,
            0
        );
        assert!(matches!(
            fixture.pool.lock().await.restore_reserved(reservation),
            RestoreReservedIdleResult::Restored
        ));
    }
    assert_eq!(home.overrides.kill_call_count(), 0);
    home.assert_active_bytes().await;
    home.confirm_exit();
    exit.confirm_exit();
    fixture.recover().await;
}

#[tokio::test]
async fn blank_first_pressure_detaches_only_the_needed_victim() {
    let fixture = BatchFixture::new().await;
    let mut home = fixture.park("thread:older-exact-logical", true).await;
    let (exit, backing) = MockBackingProcess::channel();
    let id = SandboxId::new_v4();
    let mut blank = ParkedIdleCandidate::blank(
        Box::new(MockSandbox::new("later-blank").with_backing_process(backing)),
        Arc::new(Box::new(MockSandboxFactory::new())),
        ResourceBudget::try_reserve_lease(&fixture.budget, 2, 2048).unwrap(),
        id,
        "vm0/default".into(),
        "test-rootfs".into(),
        None,
    );
    blank.capture_retirement_backing().unwrap();
    assert!(matches!(
        fixture.pool.lock().await.park(blank),
        ParkResult::Parked
    ));
    let mut result = fixture.logical(4, 4096).await;
    let lease = fresh(&mut result);
    assert_eq!(result.retirements.len(), 1);
    let snapshot = fixture.pool.lock().await.status_snapshot();
    assert!(snapshot.blank_sandboxes.is_empty());
    assert_eq!(snapshot.idle_sandboxes[0].sandbox_id, home.id);
    assert_eq!(fixture.budget.allocated(), (6, 6144, 2));
    assert_eq!(home.overrides.kill_call_count(), 0);
    home.assert_active_bytes().await;
    exit.confirm_exit();
    finish_retirements(&mut result).await;
    drop(lease);
    home.confirm_exit();
    fixture.recover().await;
}
