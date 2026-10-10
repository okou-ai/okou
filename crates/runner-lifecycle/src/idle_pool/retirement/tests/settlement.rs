use sandbox_mock::{MockBackingProcess, MockLifecycleGate};

use super::*;

#[tokio::test]
async fn unknown_fresh_settlement_keeps_both_phase_claims_after_real_home_saving() {
    let env = Env::new(64).await;
    let (exit, backing) = MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:unknown-settlement", Some(backing)).await;
    let kill = MockLifecycleGate::new();
    fixture.overrides.set_kill_lifecycle_gate(kill.clone());
    let task = admitted(&mut fixture, &env)
        .await
        .start("unknown_settlement")
        .unwrap();
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
    assert_eq!(result.outcome, DestroyOutcome::Uncertain);
    assert!(result.home_cache_promoted);
    drop(result.budget_lease);
    let report = env.operations.close_and_wait().await.unwrap();
    assert_eq!(
        (report.uncertain, report.cleanup_growth_bytes),
        (2, 9 * MIB)
    );
    fixture.saved().await;
}

#[tokio::test]
async fn concurrent_accounting_during_exit_observation_retries_without_abandoning_saved_home() {
    let env = Env::new(64).await;
    let (exit, backing) = MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:concurrent-exit-settlement", Some(backing)).await;
    let kill = MockLifecycleGate::new();
    fixture.overrides.set_kill_lifecycle_gate(kill.clone());
    let task = admitted(&mut fixture, &env)
        .await
        .start("concurrent_settlement")
        .unwrap();
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
    assert_eq!(result.outcome, DestroyOutcome::Completed);
    assert!(result.home_cache_promoted);
    drop(result.budget_lease);
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
