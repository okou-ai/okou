use super::super::{HomeCacheCheckoutResult, HomeCacheTerminalStatus, HomeImagePromotionOutcome};
use super::support::*;
use crate::storage_fingerprints::StorageFingerprints;
use runner_types::ids::RunId;
use std::sync::Arc;

use super::allocation_scan::wait_entered;
use std::time::Duration;

#[tokio::test]
async fn publication_progresses_while_unrelated_routine_cleanup_is_retained() {
    let f = Fixture::new().await;
    let committed = f
        .commit("gc-victim", b"committed-home", "2026-10-09T09:00:00Z")
        .await;
    let paths = f.cache.entry_paths(&f.key("gc-victim"));
    let metadata = tokio::fs::read(paths.metadata()).await.unwrap();
    let image = tokio::fs::read(f.image("gc-victim", &committed))
        .await
        .unwrap();
    let orphan = paths.tmp_image(RunId::new_v4());
    write_image(&orphan, b"orphaned-staging", SIZE);
    let publishing = f
        .context(
            "publishing-entry",
            b"new-home",
            "2026-10-09T10:00:00Z",
            HomeCacheTerminalStatus::Success,
            StorageFingerprints::default(),
        )
        .await;
    let expected = tokio::fs::read(f.paths.active_home_image(&publishing.sandbox_id()))
        .await
        .unwrap();
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let cache = f
        .cache
        .clone()
        .with_routine_gc_test_gate(entered.clone(), release.clone());
    let gc = tokio::spawn(async move { cache.try_routine_gc(Duration::ZERO).await });
    wait_entered(&entered).await;
    assert_eq!(
        publishing.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    drop(publishing);
    release.add_permits(1);
    assert!(gc.await.unwrap().unwrap().is_some());
    assert!(!orphan.exists());
    assert_eq!(tokio::fs::read(paths.metadata()).await.unwrap(), metadata);
    assert_eq!(
        tokio::fs::read(f.image("gc-victim", &committed))
            .await
            .unwrap(),
        image
    );
    let published = f.metadata("publishing-entry").await;
    assert_eq!(
        tokio::fs::read(f.image("publishing-entry", &published))
            .await
            .unwrap(),
        expected
    );
    assert_eq!(
        f.lease("publishing-entry").await.result(),
        HomeCacheCheckoutResult::Hit
    );
}

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
async fn multi_entry_inventory_scans_once_without_holding_capacity() {
    let fixture = Fixture::new().await;
    let first = fixture
        .commit("first", b"first-home", "2026-10-09T09:00:00Z")
        .await;
    let second = fixture
        .commit("second", b"second-home", "2026-10-09T09:00:01Z")
        .await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let cache =
        fixture
            .cache
            .clone()
            .with_gc_inventory_test_gate(1, entered.clone(), release.clone());
    fixture.cache.reset_gc_root_scan_count();
    let pending =
        tokio::spawn(async move { cache.try_routine_gc(std::time::Duration::ZERO).await });
    entered.notified().await;
    assert_eq!(fixture.cache.gc_root_scan_count(), 1);
    let capacity = runner_host::lock::try_acquire(fixture.cache.capacity_lock_path())
        .await
        .unwrap();
    drop(capacity);
    release.add_permits(1);
    assert!(pending.await.unwrap().unwrap().is_some());
    assert!(fixture.image("first", &first).exists());
    assert!(fixture.image("second", &second).exists());
    let candidates = fixture.cache.gc_candidates().await.unwrap();
    assert_eq!(candidates.len(), 2);
    assert_eq!(fixture.cache.held_home_states().await.len(), 2);
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
