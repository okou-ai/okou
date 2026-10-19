use super::*;
use runner_lifecycle::idle_pool::{ActivationCleanupOutcome, IdleActivationState};
use sandbox_mock::ExecMatcher;

mod reclamation;

#[tokio::test]
async fn publication_refusal_retains_ordinary_batch_saving_custody_after_exact_exit() {
    let fixture = BatchFixture::new().await;
    let mut home = fixture
        .park("thread:required-batch-publication", true)
        .await;
    // An infeasible filesystem reserve refuses publication without changing source bytes.
    home.cache
        .set_fs_stats_for_test(runner_lifecycle::home_image_cache::FsStats {
            total_bytes: 1,
            available_bytes: 0,
            ..Default::default()
        });
    home.confirm_exit();
    let report = join(&mut fixture.start(IdleRetirementBatchScope::All).await).await;
    assert_eq!((report.completed, report.uncertain), (0, 1));
    assert!(!report.is_complete());
    fixture.tracker.close_and_wait().await;
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    assert_eq!(home.overrides.destroy_call_count(), 0);
    home.assert_active_bytes().await;
    assert_eq!(
        fixture.operations.close_and_wait().await.unwrap().uncertain,
        1
    );
    let retained = fixture.tracker.take_retained_activation_owners().unwrap();
    assert_eq!(retained.len(), 1);
    assert_eq!(retained[0].sandbox_id(), home.id);
    assert_eq!(retained[0].state(), IdleActivationState::Exited);
    assert!(!retained[0].cleanup_completed());
    assert!(retained[0].cleanup_error().is_some());
    drop(retained);
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn ordinary_batch_preparation_freeze_and_failed_or_lost_exit_keep_original_custody() {
    for phase in [
        "prepare-for-cache",
        "--freeze",
        "panic",
        "failed_exit",
        "lost_exit",
    ] {
        let fixture = BatchFixture::new().await;
        let mut home = fixture.park("thread:ordinary-required-failure", true).await;
        match phase {
            "failed_exit" => home.exit.take().unwrap().fail_wait(),
            "lost_exit" => drop(home.exit.take()),
            "panic" => home
                .overrides
                .add_exec_panic_matcher("--freeze", "required freeze panic"),
            pattern => home.overrides.add_exec_matcher(ExecMatcher {
                pattern: pattern.into(),
                exit_code: 64,
                stdout: Vec::new(),
                stderr: b"required saving failed".to_vec(),
            }),
        }
        let report = join(&mut fixture.start(IdleRetirementBatchScope::All).await).await;
        assert_eq!((report.completed, report.uncertain), (0, 1), "{phase}");
        assert!(!report.is_complete());
        fixture.tracker.close_and_wait().await;
        assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
        assert_eq!(home.overrides.destroy_call_count(), 0);
        home.assert_active_bytes().await;
        assert_eq!(
            HomePromotionFixture::checkout_result(&home.cache, &home.key).await,
            runner_lifecycle::home_image_cache::HomeCacheCheckoutResult::LockBusy
        );
        let accounting = fixture.operations.close_and_wait().await.unwrap();
        assert_eq!(
            (accounting.uncertain, accounting.cleanup_growth_bytes),
            (2, 9 * MIB)
        );
        let owners = fixture.tracker.take_retained_activation_owners().unwrap();
        assert_eq!(owners.len(), 1);
        assert_eq!(owners[0].sandbox_id(), home.id);
        assert!(!owners[0].cleanup_completed());
        drop(owners);
        assert_eq!(fixture.budget.allocated(), (0, 0, 0));
    }
}

#[tokio::test]
async fn publication_refusal_retains_replaced_home_and_both_full_leases() {
    let fixture = BatchFixture::new().await;
    let mut old = fixture
        .park("thread:required-replacement-publication", true)
        .await;
    let (candidate, mut new) = fixture.candidate(&old.key, true).await;
    let mut incoming = runner_lifecycle::idle_pool::IdlePoolIncoming::park(candidate);
    incoming.capture_backing().unwrap();
    // An infeasible filesystem reserve refuses publication without changing source bytes.
    old.cache
        .set_fs_stats_for_test(runner_lifecycle::home_image_cache::FsStats {
            total_bytes: 1,
            available_bytes: 0,
            ..Default::default()
        });
    old.confirm_exit();
    let mut started = fixture.insert(&mut incoming).await.unwrap();
    assert_eq!(started.snapshot.idle_sandboxes[0].sandbox_id, new.id);
    assert!(incoming.into_owner().is_none());
    let task = started.retirement.as_mut().unwrap();
    assert!(matches!(
        tokio::time::timeout(WAIT, task.join())
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        ActivationCleanupOutcome::NoProgress(_)
    ));
    assert!(task.take_completed_lease().is_err());
    assert_eq!(fixture.budget.allocated(), (4, 4096, 2));
    assert_eq!(old.overrides.destroy_call_count(), 0);
    old.assert_active_bytes().await;
    new.assert_active_bytes().await;
    new.confirm_exit();
    fixture.recover().await;
    assert_eq!(
        fixture.operations.close_and_wait().await.unwrap().uncertain,
        1
    );
    let retained = fixture.tracker.take_retained_activation_owners().unwrap();
    assert_eq!(retained.len(), 1);
    assert_eq!(retained[0].sandbox_id(), old.id);
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    drop(retained);
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn logical_transfer_keeps_required_publication_custody_even_when_its_observer_drops() {
    for drop_observer in [false, true] {
        let fixture = BatchFixture::new().await;
        let mut home = fixture
            .park("thread:required-logical-publication", true)
            .await;
        // An infeasible filesystem reserve refuses publication without changing source bytes.
        home.cache
            .set_fs_stats_for_test(runner_lifecycle::home_image_cache::FsStats {
                total_bytes: 1,
                available_bytes: 0,
                ..Default::default()
            });
        let kill = MockLifecycleGate::new();
        home.overrides.set_kill_lifecycle_gate(kill.clone());
        let mut result = tokio::time::timeout(WAIT, fixture.logical(8, 8192))
            .await
            .unwrap();
        let IdlePressureSelection::Fresh(replacement) = result.selection else {
            panic!("full-profile replacement did not transfer before old exit");
        };
        assert_eq!((replacement.vcpu(), replacement.memory_mb()), (8, 8192));
        assert_eq!(fixture.budget.allocated(), (8, 8192, 1));
        kill.wait_entered(1, WAIT).await.unwrap();
        assert_eq!(
            fixture.operations.snapshot().unwrap().cleanup_growth_bytes,
            9 * MIB
        );
        home.confirm_exit();
        kill.release_one();
        if drop_observer {
            drop(result.retirements);
        } else {
            let outcome = tokio::time::timeout(WAIT, result.retirements[0].join())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(outcome.outcome, DestroyOutcome::Uncertain);
            assert!(!outcome.home_cache_promoted);
        }
        fixture.tracker.close_and_wait().await;
        assert_eq!(home.overrides.destroy_call_count(), 0);
        home.assert_active_bytes().await;
        assert_eq!(
            fixture.operations.close_and_wait().await.unwrap().uncertain,
            1
        );
        let mut owners = fixture.tracker.take_retained_activation_owners().unwrap();
        assert_eq!(owners.len(), 1);
        assert_eq!(owners[0].sandbox_id(), home.id);
        assert!(owners[0].take_completed_lease().is_err());
        assert_eq!(fixture.budget.allocated(), (8, 8192, 1));
        drop(replacement);
        assert_eq!(fixture.budget.allocated(), (0, 0, 0));
        // Explicit invocation-owned reconciliation, never physical credit.
        drop(owners);
    }
}
