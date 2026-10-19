use super::*;

#[tokio::test]
async fn mixed_batch_reports_blank_proof_refusal_without_blocking_exact_home_completion() {
    let fixture = BatchFixture::new().await;
    let mut home = fixture.park("thread:mixed-batch", true).await;
    home.confirm_exit();
    let id = SandboxId::new_v4();
    let blank = ParkedIdleCandidate::blank(
        Box::new(MockSandbox::new("mixed-blank")),
        Arc::new(Box::new(MockSandboxFactory::new())),
        ResourceBudget::try_reserve_lease(&fixture.budget, 2, 2048).unwrap(),
        id,
        "vm0/default".into(),
        "test-rootfs".into(),
        None,
    );
    assert!(matches!(
        fixture.pool.lock().await.park(blank),
        ParkResult::Parked
    ));
    let report = join(&mut fixture.start(IdleRetirementBatchScope::All).await).await;
    assert_eq!(
        (report.selected, report.completed, report.uncertain),
        (2, 1, 0)
    );
    assert_eq!(report.not_started.len(), 1);
    assert_eq!(report.not_started[0].sandbox_id, id);
    assert_eq!(
        report.not_started[0].error,
        MemoryOperationError::MissingBacking
    );
    assert!(!report.is_complete());
    home.assert_cached_bytes().await;
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    fixture.recover().await;
}

#[tokio::test]
async fn exact_batch_preserves_blank_inventory_and_empty_batch_is_complete() {
    let fixture = BatchFixture::new().await;
    let mut home = fixture.park("thread:exact-batch", true).await;
    home.confirm_exit();
    let id = SandboxId::new_v4();
    let (exit, backing) = MockBackingProcess::channel();
    let lease = ResourceBudget::try_reserve_lease(&fixture.budget, 2, 2048).unwrap();
    let mut blank = ParkedIdleCandidate::blank(
        Box::new(MockSandbox::new("blank-batch").with_backing_process(backing)),
        Arc::new(Box::new(MockSandboxFactory::new())),
        lease,
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
    let report = join(&mut fixture.start(IdleRetirementBatchScope::Exact).await).await;
    assert!(report.is_complete());
    assert_eq!((report.selected, report.completed), (1, 1));
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    home.assert_cached_bytes().await;
    let snapshot = fixture.pool.lock().await.status_snapshot();
    assert!(snapshot.idle_sandboxes.is_empty());
    assert_eq!(snapshot.blank_sandboxes[0].sandbox_id, id);
    let empty = join(&mut fixture.start(IdleRetirementBatchScope::Exact).await).await;
    assert!(empty.is_complete());
    assert_eq!(empty.selected, 0);
    exit.confirm_exit();
    let all = join(&mut fixture.start(IdleRetirementBatchScope::All).await).await;
    assert!(all.is_complete());
    assert_eq!((all.selected, all.completed), (1, 1));
    fixture.tracker.close_and_wait().await;
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn missing_backing_and_denied_live_admission_preserve_full_original_owners() {
    for captured in [false, true] {
        let fixture = BatchFixture::new().await;
        let mut home = fixture.park("thread:refused-batch", captured).await;
        tokio::fs::write(&fixture.meminfo, "MemAvailable: 0 kB\n")
            .await
            .unwrap();
        let before = fixture.pool.lock().await.status_snapshot();
        let report = join(&mut fixture.start(IdleRetirementBatchScope::All).await).await;
        assert!(!report.is_complete());
        assert_eq!(
            (report.selected, report.completed, report.uncertain),
            (1, 0, 0)
        );
        assert_eq!(report.not_started.len(), 1);
        assert_eq!(report.not_started[0].sandbox_id, home.id);
        assert_eq!(
            report.not_started[0].identity,
            runner_lifecycle::idle_pool::IdleSandboxIdentity::Exact(home.key.clone())
        );
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
            before.revision
        );
        assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
        assert_eq!(home.overrides.kill_call_count(), 0);
        assert_eq!(home.overrides.destroy_call_count(), 0);
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
async fn denied_tail_releases_unused_live_allowance_without_detach_or_data_loss() {
    let mut fixture = BatchFixture::new().await;
    let source = fixture.gate_observation(1);
    let mut home = fixture.park("thread:denied-tail-batch", true).await;
    let before = fixture.pool.lock().await.status_snapshot().revision;
    let mut task = fixture.start(IdleRetirementBatchScope::All).await;
    source.wait_entered().await;
    assert_eq!(
        fixture.operations.snapshot().unwrap().cleanup_growth_bytes,
        8 * MIB
    );
    assert_eq!(fixture.pool.lock().await.status_snapshot().revision, before);
    home.assert_active_bytes().await;
    tokio::fs::write(&fixture.meminfo, "MemAvailable: 0 kB\n")
        .await
        .unwrap();
    source.release.notify_one();
    let report = join(&mut task).await;
    assert_eq!((report.completed, report.uncertain), (0, 0));
    assert!(matches!(
        report.not_started[0].error,
        MemoryOperationError::InsufficientHeadroom { .. }
    ));
    assert!(!report.is_complete());
    assert_eq!(
        fixture.operations.snapshot().unwrap().registered_operations,
        0
    );
    assert_eq!(fixture.pool.lock().await.status_snapshot().revision, before);
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    assert_eq!(home.overrides.kill_call_count(), 0);
    home.confirm_exit();
    fixture.recover().await;
}

#[tokio::test]
async fn held_batch_refuses_reserve_restore_aba_and_never_recaptures_later_parking() {
    let mut fixture = BatchFixture::new().await;
    let source = fixture.gate_observation(0);
    let mut original = fixture.park("thread:original-batch", true).await;
    let mut task = fixture.start(IdleRetirementBatchScope::All).await;
    source.wait_entered().await;
    {
        let mut pool = tokio::time::timeout(WAIT, fixture.pool.lock())
            .await
            .unwrap();
        let reserved = pool
            .reserve_reusable(&original.key, "vm0/default", &None)
            .unwrap();
        assert_eq!(reserved.sandbox_id(), original.id);
        assert!(matches!(
            pool.restore_reserved(reserved),
            RestoreReservedIdleResult::Restored
        ));
    }
    let mut later = fixture.park("thread:later-batch", true).await;
    let revision = fixture.pool.lock().await.status_snapshot().revision;
    source.release.notify_one();
    let report = join(&mut task).await;
    assert_eq!(report.selected, 1);
    assert_eq!(report.not_started[0].sandbox_id, original.id);
    assert_eq!(
        report.not_started[0].error,
        MemoryOperationError::ResourceChanged
    );
    assert!(!report.is_complete());
    assert_eq!(
        fixture.pool.lock().await.status_snapshot().revision,
        revision
    );
    assert_eq!(fixture.budget.allocated(), (4, 4096, 2));
    original.assert_active_bytes().await;
    later.assert_active_bytes().await;
    assert_eq!(original.overrides.kill_call_count(), 0);
    assert_eq!(later.overrides.kill_call_count(), 0);
    let wire: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(fixture.dir.path().join("status.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(wire["idle_sandboxes"].as_array().unwrap().len(), 2);
    original.confirm_exit();
    later.confirm_exit();
    fixture.recover().await;
}

#[tokio::test]
async fn held_batch_does_not_clean_a_same_key_replacement() {
    let mut fixture = BatchFixture::new().await;
    let source = fixture.gate_observation(0);
    let mut original = fixture.park("thread:replaced-batch", true).await;
    let mut task = fixture.start(IdleRetirementBatchScope::Exact).await;
    source.wait_entered().await;
    original.confirm_exit();
    let jobs = fixture.pool.lock().await.drain();
    for job in jobs {
        job.run_with_context("fixture_original_completed_elsewhere")
            .await;
    }
    let mut replacement = fixture.park(&original.key, true).await;
    let revision = fixture.pool.lock().await.status_snapshot().revision;
    source.release.notify_one();
    let report = join(&mut task).await;
    assert_eq!(report.selected, 1);
    assert_eq!(report.not_started[0].sandbox_id, original.id);
    assert_eq!(
        report.not_started[0].error,
        MemoryOperationError::ResourceChanged
    );
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
async fn restored_insertion_is_saved_only_by_a_new_guarded_batch() {
    let mut fixture = BatchFixture::new().await;
    let source = fixture.gate_observation(0);
    let mut original = fixture.park("thread:aba-new-batch", true).await;
    let mut old = fixture.start(IdleRetirementBatchScope::All).await;
    source.wait_entered().await;
    let revision = {
        let mut pool = fixture.pool.lock().await;
        let before = pool.status_snapshot().revision;
        let reserved = pool
            .reserve_reusable(&original.key, "vm0/default", &None)
            .unwrap();
        assert_eq!(reserved.sandbox_id(), original.id);
        assert!(matches!(
            pool.restore_reserved(reserved),
            RestoreReservedIdleResult::Restored
        ));
        let after = pool.status_snapshot().revision;
        assert!(after > before);
        after
    };
    assert!(old.join().now_or_never().is_none());
    source.release.notify_one();
    let rejected = join(&mut old).await;
    assert_eq!(
        (rejected.selected, rejected.completed, rejected.uncertain),
        (1, 0, 0)
    );
    let [refusal] = rejected.not_started.as_slice() else {
        panic!("one original refusal required");
    };
    assert_eq!(refusal.sandbox_id, original.id);
    assert_eq!(refusal.error, MemoryOperationError::ResourceChanged);
    assert!(rejected.status_error.is_none());
    assert!(!rejected.is_complete());
    assert_eq!(
        fixture.pool.lock().await.status_snapshot().revision,
        revision
    );
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    assert_eq!(original.overrides.kill_call_count(), 0);
    original.assert_active_bytes().await;
    let published: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(fixture.dir.path().join("status.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        published["idle_sandboxes"],
        serde_json::json!([
        {"reuse_key":original.key,"sandbox_id":original.id}])
    );
    original.confirm_exit();
    let recovered = join(&mut fixture.start(IdleRetirementBatchScope::All).await).await;
    assert_eq!(
        (recovered.selected, recovered.completed, recovered.uncertain),
        (1, 1, 0)
    );
    assert!(recovered.is_complete());
    assert!(!rejected.is_complete());
    original.assert_cached_bytes().await;
    fixture.tracker.close_and_wait().await;
    let operations = fixture.operations.close_and_wait().await.unwrap();
    assert_eq!(
        (operations.registered_operations, operations.tracked_tasks),
        (0, 0)
    );
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
}
