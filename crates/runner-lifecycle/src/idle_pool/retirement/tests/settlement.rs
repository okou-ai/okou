use sandbox_mock::{MockBackingProcess, MockLifecycleGate};

use super::inventory::{park, pending};
use super::*;
use crate::idle_pool::{ActivationCleanupOutcome, IdleActivationState, IdlePool, IdlePoolConfig};

#[tokio::test]
async fn unknown_fresh_live_settlement_retains_required_home_and_full_lease() {
    let env = Env::new(64).await;
    let (exit, backing) = MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:unknown-settlement", Some(backing)).await;
    let kill = MockLifecycleGate::new();
    fixture.overrides.set_kill_lifecycle_gate(kill.clone());
    let mut pool = IdlePool::new(IdlePoolConfig::default());
    let identity = park(&mut fixture, &mut pool);
    let mut retirement = pending(&pool, &identity, &env);
    retirement.try_grant().await.unwrap();
    let (task, retained) = retirement
        .start_required(&mut pool, &env.operations, envelope(), "unknown_settlement")
        .unwrap()
        .into_parts();
    kill.wait_entered(1, WAIT).await.unwrap();
    tokio::fs::write(&env.source.path, b"malformed procfs bytes\n")
        .await
        .unwrap();
    exit.confirm_exit();
    kill.release_one();
    let result = tokio::time::timeout(WAIT, task.join())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(result, ActivationCleanupOutcome::NoProgress(_)));
    assert!(retained.take_completed_lease().is_err());
    let mut owner = retained.take_owner().unwrap();
    assert_eq!(owner.state(), IdleActivationState::Exited);
    assert!(!owner.cleanup_completed());
    assert!(owner.take_completed_lease().is_err());
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
    assert_eq!(fixture.overrides.destroy_call_count(), 0);
    assert_eq!(
        tokio::fs::read(&fixture.active_image).await.unwrap(),
        test_home_image()
    );
    assert_eq!(
        HomePromotionFixture::checkout_result(&fixture.cache, &fixture.reuse_key).await,
        crate::home_image_cache::HomeCacheCheckoutResult::LockBusy
    );
    let report = env.operations.close_and_wait().await.unwrap();
    assert_eq!(
        (report.uncertain, report.cleanup_growth_bytes),
        (2, 9 * MIB)
    );
}

#[tokio::test]
async fn concurrent_accounting_during_exit_observation_retries_without_abandoning_saved_home() {
    let env = Env::new(64).await;
    let (exit, backing) = MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:concurrent-exit-settlement", Some(backing)).await;
    let kill = MockLifecycleGate::new();
    fixture.overrides.set_kill_lifecycle_gate(kill.clone());
    let mut pool = IdlePool::new(IdlePoolConfig::default());
    let identity = park(&mut fixture, &mut pool);
    let mut retirement = pending(&pool, &identity, &env);
    retirement.try_grant().await.unwrap();
    let (task, retained) = retirement
        .start_required(
            &mut pool,
            &env.operations,
            envelope(),
            "concurrent_settlement",
        )
        .unwrap()
        .into_parts();
    kill.wait_entered(1, WAIT).await.unwrap();
    let (captured, release) = env.source.gate_read();
    exit.confirm_exit();
    tokio::time::timeout(WAIT, captured).await.unwrap().unwrap();
    // Another real owner registers while the actual procfs-format read is held.
    // The old observation cannot settle the phase against this newer ledger.
    let queued = env
        .operations
        .request(MemoryOperationPlan::HostIo { growth_bytes: MIB })
        .unwrap();
    release.send(()).unwrap();
    let snapshot = wait_snapshot(&env.operations, |s| s.started == 1).await;
    assert_eq!(
        (snapshot.uncertain, snapshot.cleanup_growth_bytes),
        (0, MIB)
    );
    drop(queued);
    kill.release_one();
    let result = tokio::time::timeout(WAIT, task.join())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        result,
        ActivationCleanupOutcome::Completed {
            home_cache_promoted: true
        }
    ));
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
    drop(retained.take_completed_lease().unwrap());
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
    assert_eq!(
        env.operations
            .close_and_wait()
            .await
            .unwrap()
            .registered_operations,
        0
    );
    fixture.saved().await;
}
