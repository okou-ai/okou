use sandbox_mock::{MockBackingProcess, MockLifecycleGate};

use super::inventory::{park, pending};
use super::*;
use crate::idle_pool::{ActivationCleanupOutcome, IdlePool, IdlePoolConfig};

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
    let mut pool = IdlePool::new(IdlePoolConfig::default());
    let identity = park(&mut fixture, &mut pool);
    let mut retirement = pending(&pool, &identity, &env);
    retirement.try_grant().await.unwrap();
    let (task, retained) = retirement
        .start_required(&mut pool, &env.operations, envelope(), "owned_child_exit")
        .unwrap()
        .into_parts();
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
    assert!(matches!(
        tokio::time::timeout(WAIT, task.join())
            .await
            .unwrap()
            .unwrap(),
        ActivationCleanupOutcome::Completed {
            home_cache_promoted: true
        }
    ));
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
    drop(retained.take_completed_lease().unwrap());
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
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
    let mut pool = IdlePool::new(IdlePoolConfig::default());
    let identity = park(&mut fixture, &mut pool);
    let mut retirement = pending(&pool, &identity, &env);
    retirement.try_grant().await.unwrap();
    let (task, retained) = retirement
        .start_required(
            &mut pool,
            &env.operations,
            envelope(),
            "preparation_evidence",
        )
        .unwrap()
        .into_parts();
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
    assert!(matches!(
        tokio::time::timeout(WAIT, task.join())
            .await
            .unwrap()
            .unwrap(),
        ActivationCleanupOutcome::Completed {
            home_cache_promoted: true
        }
    ));
    drop(retained.take_completed_lease().unwrap());
    fixture.saved().await;
}
