use super::*;

struct FaultBacking {
    original: sandbox::BackingProcessIdentity,
    replacement: sandbox::BackingProcessIdentity,
    fault: std::sync::atomic::AtomicU8,
}

#[async_trait::async_trait]
impl sandbox::SandboxBackingProcess for FaultBacking {
    fn identity(&self) -> sandbox::BackingProcessIdentity {
        match self.fault.load(Ordering::SeqCst) {
            1 => panic!("external backing capture panicked"),
            2 => self.replacement,
            _ => self.original,
        }
    }

    async fn exit_confirmed(&self) -> bool {
        true
    }
}

#[tokio::test]
async fn changed_or_panicking_backing_after_the_last_read_cannot_capture_a_victim() {
    for fault in [1, 2] {
        let mut fixture = fixture(24).await;
        let source = gate(&mut fixture, 3);
        let home = HomePromotionFixture::new("thread:last-pressure-backing").await;
        let backing = Arc::new(FaultBacking {
            original: sandbox::BackingProcessIdentity::new_generation(),
            replacement: sandbox::BackingProcessIdentity::new_generation(),
            fault: std::sync::atomic::AtomicU8::new(0),
        });
        let overrides = Arc::new(MockSandboxOverrides::new());
        add_healthy_cache_preparation_matcher(&overrides);
        let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
            MockSandboxFactory::with_overrides(overrides.clone()),
        ));
        let mut candidate = ParkedIdleCandidateBuilder::new(
            &home.reuse_key,
            ResourceBudget::try_reserve_lease(&fixture.budget, 2, 2048).unwrap(),
        )
        .with_sandbox_id(home.sandbox_id)
        .with_sandbox(Box::new(
            MockSandbox::with_overrides(home.sandbox_id.to_string(), overrides.clone())
                .with_backing_process(backing.clone()),
        ))
        .with_factory(factory)
        .with_home_promotion(home.promotion)
        .build();
        candidate.capture_retirement_backing().unwrap();
        assert!(matches!(
            fixture.pool.lock().await.park(candidate),
            ParkResult::Parked
        ));
        let mut task = wave(&fixture, 1, CancellationToken::new());
        source.wait_entered().await;
        backing.fault.store(fault, Ordering::SeqCst);
        source.release.notify_one();
        let report = result(&mut task).await;
        assert_eq!(
            (report.selected, report.completed, report.uncertain),
            (1, 0, 0)
        );
        assert!(report.is_resolved());
        assert_eq!(
            report.not_started[0].error,
            if fault == 1 {
                MemoryOperationError::ProducerLost
            } else {
                MemoryOperationError::OwnershipInvariant
            }
        );
        assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
        assert_eq!(overrides.kill_call_count(), 0);
        assert_eq!(
            fixture.operations.snapshot().unwrap().registered_operations,
            0
        );
        assert_eq!(
            tokio::fs::read(home.cache.paths().active_home_image(&home.sandbox_id))
                .await
                .unwrap(),
            test_home_image()
        );
        backing.fault.store(0, Ordering::SeqCst);
        fixture.recover().await;
    }
}

#[tokio::test]
async fn bounded_cohort_retires_blank_then_old_exact_without_adopting_newer_inventory() {
    let fixture = fixture(24).await;
    let (old, mut oldest) = fixture.candidate("thread:old-pressure", true).await;
    let (young, mut newer) = fixture.candidate("thread:new-pressure", true).await;
    let (last, mut newest) = fixture.candidate("thread:last-pressure", true).await;
    let now = std::time::Instant::now();
    {
        let mut pool = fixture.pool.lock().await;
        for (candidate, age) in [(old, 30), (young, 20), (last, 10)] {
            assert!(matches!(
                pool.park_at_for_test(candidate, now - Duration::from_secs(age)),
                ParkResult::Parked
            ));
        }
    }
    let (blank, exit) = fixture.blank().await;
    exit.confirm_exit();
    oldest.confirm_exit();
    let report = result(&mut wave(&fixture, 2, CancellationToken::new())).await;
    assert!(report.is_resolved());
    assert_eq!(
        (report.selected, report.completed, report.uncertain),
        (2, 2, 0)
    );
    let current = fixture.pool.lock().await.status_snapshot();
    assert!(
        !current
            .blank_sandboxes
            .iter()
            .any(|entry| entry.sandbox_id == blank)
    );
    assert_eq!(current.idle_sandboxes.len(), 2);
    oldest.assert_cached_bytes().await;
    newer.assert_active_bytes().await;
    newest.assert_active_bytes().await;
    assert_eq!(newer.overrides.kill_call_count(), 0);
    assert_eq!(newest.overrides.kill_call_count(), 0);
    assert_eq!(fixture.budget.allocated(), (4, 4096, 2));
    newer.confirm_exit();
    newest.confirm_exit();
    fixture.recover().await;
}

#[tokio::test]
async fn missing_proof_and_no_headroom_keep_original_data_and_complete_lease() {
    for captured in [false, true] {
        let fixture = fixture(0).await;
        let mut home = fixture.park("thread:no-pressure-headroom", captured).await;
        let original = fixture.pool.lock().await.status_snapshot();
        let report = result(&mut wave(&fixture, 1, CancellationToken::new())).await;
        assert!(report.is_resolved());
        assert_eq!(
            (report.selected, report.completed, report.uncertain),
            (1, 0, 0)
        );
        assert_eq!(report.not_started.len(), 1);
        assert_eq!(report.not_started[0].sandbox_id, home.id);
        if captured {
            assert!(matches!(
                report.not_started[0].error,
                MemoryOperationError::InsufficientHeadroom { .. }
            ));
        } else {
            assert_eq!(
                report.not_started[0].error,
                MemoryOperationError::MissingBacking
            );
        }
        assert_eq!(
            fixture.pool.lock().await.status_snapshot().revision,
            original.revision
        );
        assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
        assert_eq!(home.overrides.kill_call_count(), 0);
        assert_eq!(home.overrides.unpark_call_count(), 0);
        assert_eq!(
            fixture.operations.snapshot().unwrap().registered_operations,
            0
        );
        home.assert_active_bytes().await;
        home.confirm_exit();
        fixture.recover().await;
    }
}

#[tokio::test]
async fn reservation_and_restore_during_grant_invalidate_the_original_whole_pool_fence() {
    let mut fixture = fixture(24).await;
    let source = gate(&mut fixture, 0);
    let mut home = fixture.park("thread:changed-pressure-park", true).await;
    let mut task = wave(&fixture, 1, CancellationToken::new());
    source.wait_entered().await;
    {
        let mut pool = tokio::time::timeout(WAIT, fixture.pool.lock())
            .await
            .unwrap();
        let reserved = pool.take_reserved(&home.key).unwrap();
        assert!(matches!(
            pool.restore_reserved(reserved),
            RestoreReservedIdleResult::Restored
        ));
    }
    source.release.notify_one();
    let report = result(&mut task).await;
    assert!(report.is_resolved());
    assert_eq!(report.completed, 0);
    assert_eq!(
        report.not_started[0].error,
        MemoryOperationError::ResourceChanged
    );
    assert_eq!(home.overrides.kill_call_count(), 0);
    home.assert_active_bytes().await;
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    home.confirm_exit();
    fixture.recover().await;
}

#[tokio::test]
async fn held_pool_defers_without_callback_or_detach_after_outside_lock_grants() {
    let mut fixture = fixture(24).await;
    let source = gate(&mut fixture, 3);
    let mut home = fixture.park("thread:busy-pressure-pool", true).await;
    let mut task = wave(&fixture, 1, CancellationToken::new());
    source.wait_entered().await;
    let held = fixture.pool.lock().await;
    source.release.notify_one();
    let report = result(&mut task).await;
    assert_eq!(report.stop, Some(IdlePressureWaveStop::InventoryBusy));
    assert_eq!(
        (report.selected, report.completed, report.skipped),
        (1, 0, 1)
    );
    assert!(report.is_resolved());
    assert_eq!(held.len(), 1);
    assert_eq!(home.overrides.kill_call_count(), 0);
    assert_eq!(
        fixture.operations.snapshot().unwrap().registered_operations,
        0
    );
    drop(held);
    home.assert_active_bytes().await;
    home.confirm_exit();
    fixture.recover().await;
}

#[tokio::test]
async fn fresh_grant_recovery_and_lost_headroom_reject_cached_pressure_opportunities() {
    for recovered in [false, true] {
        let mut fixture = fixture(24).await;
        let source = gate(&mut fixture, 2);
        let mut home = fixture.park("thread:pressure-refresh", true).await;
        let mut task = wave(&fixture, 1, CancellationToken::new());
        source.wait_entered().await;
        available_bytes(&fixture, if recovered { 64 } else { 4 }).await;
        source.release.notify_one();
        let report = result(&mut task).await;
        assert!(report.is_resolved());
        assert_eq!(report.completed, 0);
        if recovered {
            assert_eq!(report.stop, Some(IdlePressureWaveStop::NoLongerCritical));
            assert_eq!(report.skipped, 1);
        } else {
            assert!(matches!(
                report.not_started[0].error,
                MemoryOperationError::InsufficientHeadroom { .. }
            ));
        }
        assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
        assert_eq!(home.overrides.kill_call_count(), 0);
        home.assert_active_bytes().await;
        home.confirm_exit();
        fixture.recover().await;
    }
}

#[tokio::test]
async fn stopping_cancels_unaccepted_grant_without_dropping_inventory() {
    let mut fixture = fixture(24).await;
    let source = gate(&mut fixture, 0);
    let mut home = fixture
        .park("thread:stop-before-pressure-acceptance", true)
        .await;
    let cancel = CancellationToken::new();
    let mut task = wave(&fixture, 1, cancel.clone());
    source.wait_entered().await;
    cancel.cancel();
    let report = result(&mut task).await;
    assert!(report.is_resolved());
    assert_eq!(report.not_started[0].error, MemoryOperationError::Closed);
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    assert_eq!(
        fixture.operations.snapshot().unwrap().registered_operations,
        0
    );
    home.assert_active_bytes().await;
    home.confirm_exit();
    fixture.recover().await;
}
