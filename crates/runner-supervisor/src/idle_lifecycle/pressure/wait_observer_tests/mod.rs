use super::*;
use runner_lifecycle::idle_pool::IdlePoolConfig;

#[tokio::test]
async fn pressure_inventory_observer_requires_an_actual_pending_lock() {
    let pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
        max_idle: 1,
    })));
    let tracker = IdleDestroyTracker::new(Arc::new(tokio::sync::Notify::new()));
    let mut waits = tracker.pressure_pool_waits_for_test();
    drop(tracker.lock_pressure_pool_for_test(&pool).await);
    assert_eq!(*waits.borrow_and_update(), 0);
    let held = pool.lock().await;
    let waiting = tracker.lock_pressure_pool_for_test(&pool);
    tokio::pin!(waiting);
    assert!(futures_util::poll!(&mut waiting).is_pending());
    waits.changed().await.unwrap();
    assert_eq!(*waits.borrow_and_update(), 1);
    drop(held);
    assert!(waiting.await.is_empty());
    assert_eq!(*waits.borrow_and_update(), 1);
    tracker.close_and_wait().await;
}
