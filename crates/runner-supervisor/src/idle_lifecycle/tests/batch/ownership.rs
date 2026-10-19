use super::*;

#[tokio::test]
async fn complete_fixed_batch_publishes_later_inventory_without_retiring_it() {
    let fixture = BatchFixture::new().await;
    let mut original = fixture.park("thread:fixed-original", true).await;
    let kill = MockLifecycleGate::new();
    original.overrides.set_kill_lifecycle_gate(kill.clone());
    original.confirm_exit();
    let mut task = fixture.start(IdleRetirementBatchScope::All).await;
    kill.wait_entered(1, WAIT).await.unwrap();
    let mut later = fixture.park("thread:fixed-later", true).await;
    let revision = fixture.pool.lock().await.status_snapshot().revision;
    assert_eq!(fixture.budget.allocated(), (4, 4096, 2));
    assert!(task.join().now_or_never().is_none());
    kill.release_one();
    let report = join(&mut task).await;
    assert_eq!(
        (report.selected, report.completed, report.uncertain),
        (1, 1, 0)
    );
    assert!(report.is_complete());
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    let current = fixture.pool.lock().await.status_snapshot();
    assert_eq!(current.revision, revision);
    assert_eq!(current.idle_sandboxes.len(), 1);
    assert_eq!(current.idle_sandboxes[0].sandbox_id, later.id);
    let published: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(fixture.dir.path().join("status.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        published["idle_sandboxes"],
        serde_json::json!([
        {"reuse_key":later.key,"sandbox_id":later.id}])
    );
    assert_eq!(later.overrides.kill_call_count(), 0);
    later.assert_active_bytes().await;
    original.assert_cached_bytes().await;
    later.confirm_exit();
    let later_report = join(&mut fixture.start(IdleRetirementBatchScope::All).await).await;
    assert_eq!((later_report.selected, later_report.completed), (1, 1));
    assert!(later_report.is_complete());
    later.assert_cached_bytes().await;
    fixture.tracker.close_and_wait().await;
    let operations = fixture.operations.close_and_wait().await.unwrap();
    assert_eq!(
        (operations.registered_operations, operations.tracked_tasks),
        (0, 0)
    );
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn dropped_batch_receiver_does_not_cancel_original_pending_admission() {
    let mut fixture = BatchFixture::new().await;
    let source = fixture.gate_observation(0);
    let mut home = fixture.park("thread:dropped-pending-batch", true).await;
    let kill = MockLifecycleGate::new();
    home.overrides.set_kill_lifecycle_gate(kill.clone());
    home.confirm_exit();
    let task = fixture.start(IdleRetirementBatchScope::All).await;
    source.wait_entered().await;
    drop(task);
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    home.assert_active_bytes().await;
    source.release.notify_one();
    kill.wait_entered(1, WAIT).await.unwrap();
    let shutdown = fixture.tracker.close_and_wait();
    tokio::pin!(shutdown);
    assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
    kill.release_one();
    tokio::time::timeout(WAIT, shutdown).await.unwrap();
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
    home.assert_cached_bytes().await;
}

#[tokio::test]
async fn fitting_original_entry_finishes_and_releases_lease_while_another_admission_is_held() {
    let mut fixture = BatchFixture::new().await;
    let source = fixture.gate_observation(0);
    let mut held = fixture.park("thread:a-held-batch", true).await;
    let mut fitting = fixture.park("thread:b-fitting-batch", true).await;
    let destroy = MockLifecycleGate::new();
    fitting
        .overrides
        .set_destroy_lifecycle_gate(destroy.clone());
    fitting.confirm_exit();
    let mut task = fixture.start(IdleRetirementBatchScope::All).await;
    source.wait_entered().await;
    destroy.wait_entered(1, WAIT).await.unwrap();
    assert_eq!(fixture.budget.allocated(), (4, 4096, 2));
    held.assert_active_bytes().await;
    assert!(ResourceBudget::try_reserve_lease(&fixture.budget, 4, 6144).is_none());
    destroy.release_one();
    // A real incoming owner can reserve the released full profile while the
    // other original VM remains pool-owned behind its observation gate.
    let mut leases = Vec::new();
    let incoming = tokio::time::timeout(
        WAIT,
        ResourceBudget::substitute_leases_when_available(&fixture.budget, &mut leases, 4, 6144),
    )
    .await
    .unwrap();
    drop(incoming);
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    fitting.assert_cached_bytes().await;
    assert_eq!(held.overrides.kill_call_count(), 0);
    assert!(task.join().now_or_never().is_none());
    source.release.notify_one();
    let report = join(&mut task).await;
    assert_eq!(
        (report.selected, report.completed, report.uncertain),
        (2, 1, 0)
    );
    assert_eq!(report.not_started[0].sandbox_id, held.id);
    assert_eq!(
        report.not_started[0].error,
        MemoryOperationError::AccountingChanged
    );
    assert!(!report.is_complete());
    held.confirm_exit();
    fixture.recover().await;
}

#[tokio::test]
async fn cancelled_receiver_and_shutdown_keep_accepted_cleanup_and_status_owner() {
    let fixture = BatchFixture::new().await;
    let mut home = fixture.park("thread:cancelled-batch", true).await;
    let kill = MockLifecycleGate::new();
    home.overrides.set_kill_lifecycle_gate(kill.clone());
    home.confirm_exit();
    let status_guard = fixture.status.hold_state_for_test().await;
    let task = fixture.start(IdleRetirementBatchScope::All).await;
    kill.wait_entered(1, WAIT).await.unwrap();
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    drop(task);
    let shutdown = fixture.tracker.close_and_wait();
    tokio::pin!(shutdown);
    assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
    kill.release_one();
    let mut leases = Vec::new();
    let incoming = tokio::time::timeout(
        WAIT,
        ResourceBudget::substitute_leases_when_available(&fixture.budget, &mut leases, 8, 8192),
    )
    .await
    .unwrap();
    drop(incoming);
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
    assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
    drop(status_guard);
    tokio::time::timeout(WAIT, shutdown).await.unwrap();
    home.assert_cached_bytes().await;
    let report = fixture.operations.close_and_wait().await.unwrap();
    assert_eq!((report.registered_operations, report.tracked_tasks), (0, 0));
}

#[tokio::test]
async fn closed_tracker_refuses_capture_and_shutdown_refuses_pending_detach() {
    for before_capture in [true, false] {
        let mut fixture = BatchFixture::new().await;
        let source = fixture.gate_observation(0);
        let mut home = fixture.park("thread:closed-batch", true).await;
        let revision = fixture.pool.lock().await.status_snapshot().revision;
        if before_capture {
            fixture.tracker.close_and_wait().await;
            let result = fixture
                .tracker
                .start_pool_retirement_batch(
                    fixture.pool.clone(),
                    fixture.status.clone(),
                    fixture.operations.clone(),
                    IdlePoolBatchRetirementRequest {
                        scope: IdleRetirementBatchScope::All,
                        envelope: IdleRetirementEnvelope {
                            live_growth_bytes: 8 * MIB,
                            tail_growth_bytes: MIB,
                        },
                        context: "closed_capture",
                    },
                )
                .await;
            assert!(matches!(result, Err(MemoryOperationError::Closed)));
            assert_eq!(source.calls.load(Ordering::Relaxed), 0);
        } else {
            let mut task = fixture.start(IdleRetirementBatchScope::All).await;
            source.wait_entered().await;
            let shutdown = fixture.tracker.close_and_wait();
            tokio::pin!(shutdown);
            assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
            source.release.notify_one();
            let report = join(&mut task).await;
            assert_eq!(report.not_started[0].error, MemoryOperationError::Closed);
            assert!(!report.is_complete());
            tokio::time::timeout(WAIT, shutdown).await.unwrap();
        }
        assert_eq!(
            fixture.pool.lock().await.status_snapshot().revision,
            revision
        );
        assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
        assert_eq!(home.overrides.kill_call_count(), 0);
        home.assert_active_bytes().await;
        assert_eq!(
            fixture.operations.snapshot().unwrap().registered_operations,
            0
        );
        home.confirm_exit();
        fixture.recover().await;
    }
}

#[tokio::test]
async fn status_failure_is_explicit_after_real_physical_completion_and_home_publication() {
    let fixture = BatchFixture::new().await;
    let mut home = fixture.park("thread:status-failed-batch", true).await;
    home.confirm_exit();
    let status_path = fixture.dir.path().join("status.json");
    tokio::fs::remove_file(&status_path).await.unwrap();
    tokio::fs::create_dir(&status_path).await.unwrap();
    let report = join(&mut fixture.start(IdleRetirementBatchScope::All).await).await;
    assert_eq!(
        (report.selected, report.completed, report.uncertain),
        (1, 1, 0)
    );
    assert!(report.not_started.is_empty());
    assert!(report.status_error.is_some());
    assert!(!report.is_complete());
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
    assert!(fixture.pool.lock().await.is_empty());
    home.assert_cached_bytes().await;
    fixture.tracker.close_and_wait().await;
}

struct PanickingSource;

impl MemoryObservationSource for PanickingSource {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(async { panic!("external observation producer failed") })
    }
}

#[tokio::test]
async fn lost_observation_producer_is_not_started_and_accepted_provider_panic_is_uncertain() {
    for accepted in [false, true] {
        let mut fixture = BatchFixture::new().await;
        let mut home = fixture.park("thread:producer-failed-batch", true).await;
        home.confirm_exit();
        if accepted {
            home.overrides
                .push_kill_panic("external terminal provider failed");
        } else {
            fixture.operations =
                HostMemoryOperations::new(policy(), Arc::new(PanickingSource)).unwrap();
        }
        let report = join(&mut fixture.start(IdleRetirementBatchScope::All).await).await;
        assert_eq!(report.selected, 1);
        assert_eq!(report.completed, 0);
        assert!(!report.is_complete());
        if accepted {
            assert_eq!(report.uncertain, 1);
            assert!(report.not_started.is_empty());
            assert!(fixture.pool.lock().await.is_empty());
            assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
            home.assert_active_bytes().await;
            assert_eq!(home.overrides.destroy_call_count(), 0);
        } else {
            assert_eq!(report.uncertain, 0);
            assert_eq!(
                report.not_started[0].error,
                MemoryOperationError::ProducerLost
            );
            assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
            home.assert_active_bytes().await;
            assert_eq!(home.overrides.kill_call_count(), 0);
        }
        fixture.recover().await;
    }
}
