use runner_lifecycle::idle_pool::{
    ActivationCleanupOutcome, IdleActivationOwner, IdleActivationState,
};
use sandbox_mock::ExecMatcher;

use super::*;

fn envelope() -> IdleRetirementEnvelope {
    IdleRetirementEnvelope {
        live_growth_bytes: 8 * MIB,
        tail_growth_bytes: MIB,
    }
}

async fn failed_owner(fixture: &BatchFixture, home: &ParkedHome) -> Option<IdleActivationOwner> {
    let reserved = fixture.pool.lock().await.take_reserved(&home.key).unwrap();
    let mut owner = IdleActivationOwner::new(reserved).unwrap_or_else(|_| panic!("parked fixture"));
    home.overrides
        .push_unpark_result(Err(sandbox::SandboxError::Start {
            message: "partial activation failed".into(),
        }));
    assert!(owner.activate(RunId::new_v4()).await.is_err());
    Some(owner)
}

#[tokio::test]
async fn accepted_caller_cleanup_survives_receiver_cancel_and_status_lock_through_shutdown() {
    let fixture = BatchFixture::new().await;
    let mut home = fixture.park("thread:tracked-caller-cleanup", false).await;
    let mut owner = failed_owner(&fixture, &home).await;
    let destroy = MockLifecycleGate::new();
    home.overrides.set_destroy_lifecycle_gate(destroy.clone());
    let task = fixture
        .tracker
        .retire_activation_owner(
            &mut owner,
            &fixture.operations,
            envelope(),
            "tracked_caller_cleanup",
        )
        .await
        .unwrap();
    assert!(owner.is_none());
    drop(task);
    home.confirm_exit();
    destroy.wait_entered(1, WAIT).await.unwrap();
    let pool = fixture.pool.lock().await;
    let status = fixture.status.hold_state_for_test().await;
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    assert_eq!(
        fixture.operations.snapshot().unwrap().cleanup_growth_bytes,
        MIB
    );
    let mut shutdown = Box::pin(fixture.tracker.close_and_wait());
    assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
    assert!(fixture.tracker.take_retained_activation_owners().is_err());
    destroy.release_one();
    tokio::time::timeout(WAIT, shutdown).await.unwrap();
    drop(pool);
    drop(status);
    let retained = fixture.tracker.take_retained_activation_owners().unwrap();
    assert_eq!(retained.len(), 1);
    assert_eq!(retained[0].state(), IdleActivationState::Destroyed);
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    drop(retained);
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
    home.assert_cached_bytes().await;
}

#[tokio::test]
async fn lost_caller_result_retains_failed_required_saving_owner_after_joined_shutdown() {
    let fixture = BatchFixture::new().await;
    let home = fixture
        .park("thread:tracked-caller-saving-failure", false)
        .await;
    let mut owner = failed_owner(&fixture, &home).await;
    home.overrides.add_exec_matcher(ExecMatcher {
        pattern: "--freeze".into(),
        exit_code: 64,
        stdout: Vec::new(),
        stderr: b"required freeze failed".to_vec(),
    });
    drop(
        fixture
            .tracker
            .retire_activation_owner(
                &mut owner,
                &fixture.operations,
                envelope(),
                "tracked_saving_failure",
            )
            .await
            .unwrap(),
    );
    tokio::time::timeout(WAIT, fixture.tracker.close_and_wait())
        .await
        .unwrap();
    let retained = fixture.tracker.take_retained_activation_owners().unwrap();
    assert_eq!(retained.len(), 1);
    assert_eq!(retained[0].sandbox_id(), home.id);
    assert_eq!(retained[0].state(), IdleActivationState::Uncertain);
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    assert_eq!(home.overrides.kill_call_count(), 0);
    assert_eq!(home.overrides.destroy_call_count(), 0);
    home.assert_active_bytes().await;
    assert_eq!(
        HomePromotionFixture::checkout_result(&home.cache, &home.key).await,
        runner_lifecycle::home_image_cache::HomeCacheCheckoutResult::LockBusy
    );
    assert_eq!(
        fixture.operations.close_and_wait().await.unwrap().uncertain,
        2
    );
}

#[tokio::test]
async fn closed_tracker_rejects_before_acceptance_and_retains_the_caller_resource() {
    let fixture = BatchFixture::new().await;
    let home = fixture.park("thread:tracked-caller-closed", false).await;
    let mut owner = failed_owner(&fixture, &home).await;
    fixture.tracker.close_and_wait().await;
    assert!(matches!(
        fixture
            .tracker
            .retire_activation_owner(
                &mut owner,
                &fixture.operations,
                envelope(),
                "tracked_closed"
            )
            .await,
        Err(MemoryOperationError::Closed)
    ));
    assert_eq!(owner.as_ref().unwrap().sandbox_id(), home.id);
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    assert_eq!(home.overrides.kill_call_count(), 0);
    home.assert_active_bytes().await;
}

#[tokio::test]
async fn fitting_caller_cleanup_continues_while_another_required_freeze_is_held() {
    let fixture = BatchFixture::new().await;
    let mut first = fixture.park("thread:held-caller", false).await;
    let mut first_owner = failed_owner(&fixture, &first).await;
    let exec = MockLifecycleGate::new();
    first.overrides.set_exec_lifecycle_gate(exec.clone());
    let mut first_task = fixture
        .tracker
        .retire_activation_owner(
            &mut first_owner,
            &fixture.operations,
            envelope(),
            "held_caller",
        )
        .await
        .unwrap();
    exec.wait_entered(1, WAIT).await.unwrap();
    let mut second = fixture.park("thread:fitting-caller", false).await;
    let mut second_owner = failed_owner(&fixture, &second).await;
    second.confirm_exit();
    let mut second_task = fixture
        .tracker
        .retire_activation_owner(
            &mut second_owner,
            &fixture.operations,
            envelope(),
            "fitting_caller",
        )
        .await
        .unwrap();
    assert!(matches!(
        tokio::time::timeout(WAIT, second_task.join())
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        ActivationCleanupOutcome::Completed {
            home_cache_promoted: true
        }
    ));
    second.assert_cached_bytes().await;
    drop(second_task.take_completed_lease().unwrap());
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    assert_eq!(first.overrides.kill_call_count(), 0);
    first.confirm_exit();
    exec.release_one();
    exec.wait_entered(2, WAIT).await.unwrap();
    exec.release_one();
    assert!(matches!(
        tokio::time::timeout(WAIT, first_task.join())
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        ActivationCleanupOutcome::Completed {
            home_cache_promoted: true
        }
    ));
    fixture.tracker.close_and_wait().await;
    drop(first_task.take_completed_lease().unwrap());
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
}
