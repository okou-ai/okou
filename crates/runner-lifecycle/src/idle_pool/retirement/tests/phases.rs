use sandbox_mock::{MockBackingProcess, MockLifecycleGate};

use super::*;

#[tokio::test]
async fn exact_owned_child_exit_settles_live_while_kill_and_factory_tails_remain_covered() {
    let env = Env::new(64).await;
    let (exit, backing) = MockBackingProcess::channel();
    let mut child = tokio::process::Command::new("cat")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    let monitor = tokio::spawn(async move {
        assert!(child.wait().await.unwrap().success());
        exit.confirm_exit();
    });
    let mut fixture = JobFixture::new("thread:positive-owned-child", Some(backing)).await;
    let kill = MockLifecycleGate::new();
    let destroy = MockLifecycleGate::new();
    fixture.overrides.set_kill_lifecycle_gate(kill.clone());
    fixture
        .overrides
        .set_destroy_lifecycle_gate(destroy.clone());
    let task = admitted(&mut fixture, &env)
        .await
        .start("owned_child_exit")
        .unwrap();
    kill.wait_entered(1, WAIT).await.unwrap();
    let started = env.operations.snapshot().unwrap();
    assert_eq!(started.started, 2);
    assert_eq!(started.cleanup_growth_bytes, 9 * MIB);
    assert!(fixture.cache.held_home_states().await.is_empty());
    drop(stdin);
    tokio::time::timeout(WAIT, monitor).await.unwrap().unwrap();
    let after_exit = wait_snapshot(&env.operations, |s| s.started == 1).await;
    assert_eq!(after_exit.cleanup_growth_bytes, MIB);
    assert_eq!(after_exit.tracked_tasks, 1);
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
    assert_eq!(fixture.overrides.destroy_call_count(), 0);
    kill.release_one();
    destroy.wait_entered(1, WAIT).await.unwrap();
    assert_eq!(env.operations.snapshot().unwrap().cleanup_growth_bytes, MIB);
    let shutdown = env.operations.close_and_wait();
    tokio::pin!(shutdown);
    assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
    destroy.release_one();
    let result = tokio::time::timeout(WAIT, task.join())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.outcome, DestroyOutcome::Completed);
    assert!(result.home_cache_promoted);
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
    drop(result.budget_lease);
    let report = tokio::time::timeout(WAIT, shutdown).await.unwrap().unwrap();
    assert_eq!(report.registered_operations, 0);
    assert_eq!(report.tracked_tasks, 0);
    fixture.saved().await;
}

#[tokio::test]
async fn exact_exit_before_required_freeze_cannot_settle_live_preparation() {
    let env = Env::new(64).await;
    let (exit, backing) = MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:exit-is-not-freeze", Some(backing)).await;
    let exec = MockLifecycleGate::new();
    fixture.overrides.set_exec_lifecycle_gate(exec.clone());
    let task = admitted(&mut fixture, &env)
        .await
        .start("preparation_evidence")
        .unwrap();
    exec.wait_entered(1, WAIT).await.unwrap();
    exit.confirm_exit();
    assert_eq!(env.operations.snapshot().unwrap().started, 2);
    assert_eq!(fixture.overrides.kill_call_count(), 0);
    exec.release_one();
    exec.wait_entered(2, WAIT).await.unwrap();
    assert!(fixture.overrides.exec_calls()[1].cmd.contains("--freeze"));
    assert_eq!(
        env.operations.snapshot().unwrap().cleanup_growth_bytes,
        9 * MIB
    );
    exec.release_one();
    let result = tokio::time::timeout(WAIT, task.join())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.outcome, DestroyOutcome::Completed);
    drop(result.budget_lease);
    fixture.saved().await;
}

#[tokio::test]
async fn failed_or_lost_backing_never_publishes_or_settles_after_generic_kill_success() {
    for lost in [false, true] {
        let env = Env::new(64).await;
        let (exit, backing) = MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:unconfirmed-backing", Some(backing)).await;
        let task = admitted(&mut fixture, &env)
            .await
            .start("unconfirmed_exit")
            .unwrap();
        if lost {
            drop(exit);
        } else {
            exit.fail_wait();
        }
        let result = tokio::time::timeout(WAIT, task.join())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.outcome, DestroyOutcome::Uncertain);
        assert!(!result.home_cache_promoted);
        assert_eq!(fixture.overrides.destroy_call_count(), 1);
        drop(result.budget_lease);
        let snapshot = env.operations.close_and_wait().await.unwrap();
        assert_eq!(snapshot.uncertain, 2);
        assert_eq!(snapshot.cleanup_growth_bytes, 9 * MIB);
        assert!(fixture.cache.held_home_states().await.is_empty());
    }
}

#[tokio::test]
async fn failed_kill_reaches_factory_before_pending_exact_exit_to_avoid_owner_deadlock() {
    let env = Env::new(64).await;
    let (exit, backing) = MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:factory-owns-termination", Some(backing)).await;
    fixture
        .overrides
        .push_kill_result(Err(sandbox::SandboxError::Start {
            message: "kill rejected".into(),
        }));
    let destroy = MockLifecycleGate::new();
    fixture
        .overrides
        .set_destroy_lifecycle_gate(destroy.clone());
    let task = admitted(&mut fixture, &env)
        .await
        .start("factory_exit")
        .unwrap();
    destroy.wait_entered(1, WAIT).await.unwrap();
    assert_eq!(env.operations.snapshot().unwrap().started, 2);
    exit.confirm_exit();
    wait_snapshot(&env.operations, |s| s.started == 1).await;
    destroy.release_one();
    let result = tokio::time::timeout(WAIT, task.join())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.outcome, DestroyOutcome::Completed);
    assert!(!result.home_cache_promoted);
    drop(result.budget_lease);
    assert_eq!(env.operations.snapshot().unwrap().registered_operations, 0);
}

#[tokio::test]
async fn preparation_and_destroy_panics_keep_the_unconfirmed_phase_allowance() {
    for preparation in [false, true] {
        let env = Env::new(64).await;
        let (exit, backing) = MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:phase-provider-panic", Some(backing)).await;
        if preparation {
            fixture
                .overrides
                .add_exec_panic_matcher("--freeze", "required freeze panic");
        } else {
            fixture
                .overrides
                .push_destroy_panic("post-exit destroy panic");
        }
        exit.confirm_exit();
        let task = admitted(&mut fixture, &env)
            .await
            .start("provider_phase_panic")
            .unwrap();
        let result = tokio::time::timeout(WAIT, task.join())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.outcome, DestroyOutcome::Uncertain);
        assert_eq!(result.home_cache_promoted, !preparation);
        drop(result.budget_lease);
        let snapshot = env.operations.close_and_wait().await.unwrap();
        assert_eq!(snapshot.uncertain, 1);
        assert_eq!(
            snapshot.cleanup_growth_bytes,
            if preparation { 8 * MIB } else { MIB }
        );
        if !preparation {
            fixture.saved().await;
        }
    }
}

#[tokio::test]
async fn receiver_loss_and_outer_panic_keep_saving_owned_and_shutdown_joined() {
    for panic in [false, true] {
        let env = Env::new(64).await;
        let (exit, backing) = MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:receiver-loss", Some(backing)).await;
        let destroy = MockLifecycleGate::new();
        fixture
            .overrides
            .set_destroy_lifecycle_gate(destroy.clone());
        exit.confirm_exit();
        let task = admitted(&mut fixture, &env)
            .await
            .start("receiver_only")
            .unwrap();
        destroy.wait_entered(1, WAIT).await.unwrap();
        let observer = tokio::spawn(async move {
            let _receiver = task;
            if panic {
                panic!("outer observer panic");
            }
        });
        if panic {
            assert!(observer.await.unwrap_err().is_panic());
        } else {
            observer.await.unwrap();
        }
        assert_eq!(fixture.budget.allocated(), (2, 8, 1));
        let shutdown = env.operations.close_and_wait();
        tokio::pin!(shutdown);
        assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
        destroy.release_one();
        let report = tokio::time::timeout(WAIT, shutdown).await.unwrap().unwrap();
        assert_eq!(report.registered_operations, 0);
        assert_eq!(fixture.budget.allocated(), (0, 0, 0));
        fixture.saved().await;
    }
}

#[tokio::test]
async fn supplied_fitting_phases_allow_parallel_real_terminal_progress() {
    let env = Env::new(64).await;
    let mut fixtures = Vec::new();
    let mut tasks = Vec::new();
    let destroy = MockLifecycleGate::new();
    for key in ["thread:parallel-first", "thread:parallel-second"] {
        let (exit, backing) = MockBackingProcess::channel();
        let mut fixture = JobFixture::new(key, Some(backing)).await;
        fixture
            .overrides
            .set_destroy_lifecycle_gate(destroy.clone());
        exit.confirm_exit();
        tasks.push(
            admitted(&mut fixture, &env)
                .await
                .start("fitting_parallel")
                .unwrap(),
        );
        fixtures.push(fixture);
    }
    destroy.wait_entered(2, WAIT).await.unwrap();
    wait_snapshot(&env.operations, |s| {
        s.started == 2 && s.cleanup_growth_bytes == 2 * MIB
    })
    .await;
    assert_eq!(env.operations.snapshot().unwrap().tracked_tasks, 2);
    destroy.release_one();
    destroy.release_one();
    for task in tasks {
        let result = tokio::time::timeout(WAIT, task.join())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.outcome, DestroyOutcome::Completed);
        drop(result.budget_lease);
    }
    for fixture in fixtures {
        fixture.saved().await;
    }
    assert_eq!(
        env.operations
            .close_and_wait()
            .await
            .unwrap()
            .registered_operations,
        0
    );
}
