use super::*;
use runner_lifecycle::{
    idle_pool::{IdlePool, IdlePoolConfig},
    status::StatusTracker,
};

#[tokio::test]
async fn real_heartbeat_and_observer_progress_while_status_is_held() -> TestResult<()> {
    let directory = tempfile::tempdir()?;
    let pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
        max_idle: 1,
    })));
    let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
    let status = StatusTracker::new(directory.path().join("status.json"), 1, None, None);
    status.write_initial().await?;
    let mut probe = Probe::new(&pool, &budget, directory.path(), "synthetic-rootfs").await?;
    let holder = pool.lock().await;
    probe.request()?;
    let observed = observe().await?;
    assert!(observed["available_bytes"].as_u64().is_some_and(|n| n > 0));
    assert!(!probe.has_receipts()?);
    let status_holder = status.hold_state_for_test().await;
    drop(holder);
    let completed = probe.complete().await?;
    assert_eq!(completed["receipt"]["state"]["snapshotSequence"], 1);
    assert_eq!(completed["receipt"]["acknowledgement_status"], 204);
    drop(status_holder);
    probe.finish().await
}
