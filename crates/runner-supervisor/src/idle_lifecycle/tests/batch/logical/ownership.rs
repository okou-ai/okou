use super::*;

#[tokio::test]
async fn insufficient_multi_victim_transfer_returns_all_accepted_full_leases_without_physical_credit()
 {
    let fixture = BatchFixture::new().await;
    let mut accepted = fixture.park("thread:partly-accepted-logical", true).await;
    let mut refused = fixture.park("thread:uncaptured-logical", false).await;
    let kill = MockLifecycleGate::new();
    accepted.overrides.set_kill_lifecycle_gate(kill.clone());
    let mut result = fixture.logical(6, 8192).await;
    let IdlePressureSelection::Exhausted(leases) = std::mem::replace(
        &mut result.selection,
        IdlePressureSelection::Exhausted(Vec::new()),
    ) else {
        panic!("one lease cannot replace the whole incoming profile");
    };
    assert_eq!(leases.len(), 1);
    assert_eq!((leases[0].vcpu(), leases[0].memory_mb()), (2, 2048));
    assert_eq!(result.retirements.len(), 1);
    assert_eq!(result.not_started[0].sandbox_id, refused.id);
    assert_eq!(
        result.not_started[0].error,
        MemoryOperationError::MissingBacking
    );
    assert_eq!(fixture.budget.allocated(), (4, 4096, 2));
    assert!(ResourceBudget::try_reserve_lease(&fixture.budget, 6, 8192).is_none());
    assert_eq!(refused.overrides.kill_call_count(), 0);
    refused.assert_active_bytes().await;
    kill.wait_entered(1, WAIT).await.unwrap();
    assert_eq!(
        fixture.operations.snapshot().unwrap().cleanup_growth_bytes,
        9 * MIB
    );
    drop(leases);
    assert_eq!(
        fixture.operations.snapshot().unwrap().cleanup_growth_bytes,
        9 * MIB
    );
    accepted.confirm_exit();
    kill.release_one();
    finish_retirements(&mut result).await;
    accepted.assert_cached_bytes().await;
    refused.confirm_exit();
    fixture.recover().await;
}

#[tokio::test]
async fn fitting_foreground_progresses_while_another_logical_admission_observation_is_held() {
    let mut fixture = BatchFixture::new().await;
    let source = fixture.gate_observation(0);
    let mut home = fixture.park("thread:held-logical-fit", true).await;
    let caller = fixture.logical(6, 8192);
    tokio::pin!(caller);
    tokio::select! {
        () = source.wait_entered() => {},
        _ = &mut caller => panic!("held grant completed"),
    }
    let mut independent = tokio::time::timeout(WAIT, fixture.logical(1, 1024))
        .await
        .unwrap();
    let fitting = fresh(&mut independent);
    assert_eq!((fitting.vcpu(), fitting.memory_mb()), (1, 1024));
    assert!(independent.retirements.is_empty());
    assert_eq!(fixture.budget.allocated(), (3, 3072, 2));
    assert_eq!(home.overrides.kill_call_count(), 0);
    home.assert_active_bytes().await;
    drop(fitting);
    source.release.notify_one();
    let mut result = tokio::time::timeout(WAIT, caller).await.unwrap();
    drop(fresh(&mut result));
    home.confirm_exit();
    finish_retirements(&mut result).await;
    home.assert_cached_bytes().await;
    fixture.recover().await;
}

#[tokio::test]
async fn accepted_cleanup_survives_caller_cancellation_at_status_and_tracker_shutdown_joins_it() {
    let fixture = BatchFixture::new().await;
    let mut home = fixture.park("thread:cancelled-logical-status", true).await;
    let kill = MockLifecycleGate::new();
    home.overrides.set_kill_lifecycle_gate(kill.clone());
    let status_guard = fixture.status.hold_state_for_test().await;
    {
        let caller = fixture.logical(6, 8192);
        tokio::pin!(caller);
        tokio::select! {
            _ = async { kill.wait_entered(1, WAIT).await.unwrap() } => {},
            _ = &mut caller => panic!("held status completed"),
        }
        assert!(fixture.pool.lock().await.is_empty());
        assert_eq!(fixture.budget.allocated(), (6, 8192, 1));
        assert_eq!(
            fixture.operations.snapshot().unwrap().cleanup_growth_bytes,
            9 * MIB
        );
    }
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
    assert_eq!(
        fixture.operations.snapshot().unwrap().cleanup_growth_bytes,
        9 * MIB
    );
    drop(status_guard);
    let shutdown = fixture.tracker.close_and_wait();
    tokio::pin!(shutdown);
    assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
    home.confirm_exit();
    kill.release_one();
    tokio::time::timeout(WAIT, shutdown).await.unwrap();
    home.assert_cached_bytes().await;
    assert_eq!(
        fixture
            .operations
            .close_and_wait()
            .await
            .unwrap()
            .registered_operations,
        0
    );
}

#[tokio::test]
async fn failed_status_publication_cannot_retract_accepted_logical_transfer_or_required_saving() {
    let fixture = BatchFixture::new().await;
    let mut home = fixture.park("thread:failed-logical-status", true).await;
    let kill = MockLifecycleGate::new();
    home.overrides.set_kill_lifecycle_gate(kill.clone());
    let path = fixture.dir.path().join("status.json");
    tokio::fs::remove_file(&path).await.unwrap();
    tokio::fs::create_dir(&path).await.unwrap();
    let mut result = tokio::time::timeout(WAIT, fixture.logical(6, 8192))
        .await
        .unwrap();
    let lease = fresh(&mut result);
    assert!(result.status_error.is_some());
    assert!(result.not_started.is_empty());
    assert_eq!(result.retirements.len(), 1);
    assert!(fixture.pool.lock().await.is_empty());
    assert_eq!(fixture.budget.allocated(), (6, 8192, 1));
    kill.wait_entered(1, WAIT).await.unwrap();
    assert_eq!(
        fixture.operations.snapshot().unwrap().cleanup_growth_bytes,
        9 * MIB
    );
    home.confirm_exit();
    kill.release_one();
    finish_retirements(&mut result).await;
    home.assert_cached_bytes().await;
    drop(lease);
    fixture.recover().await;
}

#[tokio::test]
async fn tracker_close_during_held_admission_refuses_detach_and_preserves_full_owner() {
    let mut fixture = BatchFixture::new().await;
    let source = fixture.gate_observation(0);
    let mut home = fixture.park("thread:closed-logical", true).await;
    let caller = fixture.logical(6, 8192);
    tokio::pin!(caller);
    tokio::select! {
        () = source.wait_entered() => {},
        _ = &mut caller => panic!("held grant completed"),
    }
    fixture.tracker.close_and_wait().await;
    let revision = fixture.pool.lock().await.status_snapshot().revision;
    source.release.notify_one();
    let result = tokio::time::timeout(WAIT, caller).await.unwrap();
    assert_eq!(result.not_started[0].error, MemoryOperationError::Closed);
    assert!(result.retirements.is_empty());
    assert_eq!(
        fixture.pool.lock().await.status_snapshot().revision,
        revision
    );
    assert_eq!(
        fixture.operations.snapshot().unwrap().registered_operations,
        0
    );
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    home.assert_active_bytes().await;
    home.confirm_exit();
    fixture.recover().await;
}

struct PanicObservation;

impl MemoryObservationSource for PanicObservation {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(async { panic!("external logical observation producer lost") })
    }
}

#[tokio::test]
async fn lost_admission_producer_is_refused_and_accepted_provider_panic_keeps_uncertain_coverage() {
    for accepted in [false, true] {
        let mut fixture = BatchFixture::new().await;
        let mut home = fixture.park("thread:logical-producer-fault", true).await;
        if accepted {
            home.overrides
                .push_kill_panic("external accepted retirement provider failed");
            home.confirm_exit();
        } else {
            fixture.operations =
                HostMemoryOperations::new(policy(), Arc::new(PanicObservation)).unwrap();
        }
        let mut result = fixture.logical(6, 8192).await;
        if accepted {
            let lease = fresh(&mut result);
            assert_eq!(result.retirements.len(), 1);
            let outcome = tokio::time::timeout(WAIT, result.retirements[0].join())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(outcome.outcome, DestroyOutcome::Uncertain);
            drop(lease);
            let physical = fixture.operations.close_and_wait().await.unwrap();
            assert!(physical.uncertain > 0);
            assert!(physical.cleanup_growth_bytes > 0);
        } else {
            assert_eq!(
                result.not_started[0].error,
                MemoryOperationError::ProducerLost
            );
            assert!(result.retirements.is_empty());
            assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
            assert_eq!(
                fixture.operations.snapshot().unwrap().registered_operations,
                0
            );
            home.assert_active_bytes().await;
            home.confirm_exit();
        }
        fixture.recover().await;
    }
}
