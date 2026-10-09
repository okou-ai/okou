use super::super::*;
use super::support::*;
use std::sync::Arc;

#[tokio::test]
async fn routine_inventory_does_not_hold_capacity_while_blocked_at_scan_boundary() {
    let f = Fixture::new().await;
    f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let cache = f
        .cache
        .clone()
        .with_routine_gc_test_gate(entered.clone(), release.clone());
    let pending =
        tokio::spawn(async move { cache.try_routine_gc(std::time::Duration::ZERO).await });
    entered.notified().await;
    let capacity = runner_host::lock::try_acquire(f.cache.capacity_lock_path())
        .await
        .unwrap();
    drop(capacity);
    release.add_permits(1);
    assert!(pending.await.unwrap().unwrap().is_some());
    assert_eq!(f.cache.held_home_states().await.len(), 1);
}

#[tokio::test]
async fn routine_gc_respects_capacity_contention_without_waiting_or_deleting() {
    let f = Fixture::new().await;
    let metadata = f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    let capacity = runner_host::lock::acquire(f.cache.capacity_lock_path())
        .await
        .unwrap();
    assert!(
        f.cache
            .try_routine_gc(std::time::Duration::ZERO)
            .await
            .unwrap()
            .is_none()
    );
    assert!(f.image("thread", &metadata).exists());
    drop(capacity);
}
