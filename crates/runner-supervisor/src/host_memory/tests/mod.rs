use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

#[tokio::test]
async fn real_reader_progresses_without_unrelated_pool_or_status_locks() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("meminfo");
    tokio::fs::write(&path, "MemAvailable: 0 kB\n")
        .await
        .unwrap();
    let queued_state = Arc::new(tokio::sync::Mutex::new(()));
    let held = queued_state.lock().await;
    let waiter = tokio::spawn({
        let state = Arc::clone(&queued_state);
        async move { drop(state.lock().await) }
    });
    let mut observer = HostMemoryObserver::spawn_reader(move || {
        let path = path.clone();
        Box::pin(async move { HostMemoryObservation::read_at(&path).await })
    });
    tokio::time::timeout(Duration::from_secs(1), observer.latest.changed())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(observer.available_bytes(), Ok(0));
    assert!(!waiter.is_finished());
    observer.shutdown().await.unwrap();
    drop(held);
    waiter.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn slow_reads_are_single_flight_and_cancel_joins_without_a_tick() {
    let reads = Arc::new(AtomicUsize::new(0));
    let mut observer = HostMemoryObserver::spawn_reader({
        let reads = Arc::clone(&reads);
        move || {
            reads.fetch_add(1, Ordering::SeqCst);
            Box::pin(std::future::pending())
        }
    });
    tokio::task::yield_now().await;
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    tokio::time::advance(HEARTBEAT_PERIOD - Duration::from_millis(1)).await;
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    tokio::time::advance(HEARTBEAT_PERIOD * 3).await;
    observer.latest.changed().await.unwrap();
    assert_eq!(
        observer.available_bytes(),
        Err(HostMemoryUnknown::ReadTimeout)
    );
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    observer.shutdown().await.unwrap();
    assert_eq!(reads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn stopped_producer_does_not_keep_a_successful_cache() {
    let mut observer = HostMemoryObserver::spawn_reader(|| {
        Box::pin(async {
            HostMemoryObservation::read_at(std::path::Path::new("/proc/meminfo")).await
        })
    });
    // Real filesystem I/O is not driven by fake time.
    observer.latest.changed().await.unwrap();
    assert!(observer.available_bytes().is_ok());
    observer.task.abort();
    observer.latest.changed().await.unwrap_err();
    assert_eq!(
        observer.available_bytes(),
        Err(HostMemoryUnknown::ObserverStopped)
    );
    assert!(observer.shutdown().await.is_err());
}

#[tokio::test]
async fn failed_read_invalidates_the_latest_observation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("meminfo");
    tokio::fs::write(&path, "MemAvailable: 42 kB\n")
        .await
        .unwrap();
    let valid = HostMemoryObservation::read_at(&path).await;
    tokio::fs::remove_file(&path).await.unwrap();
    let failed = HostMemoryObservation::read_at(&path).await;
    let mut observations = std::collections::VecDeque::from([valid, failed]);
    tokio::time::pause();
    let mut observer = HostMemoryObserver::spawn_reader(move || {
        let observation = observations.pop_front().unwrap();
        Box::pin(async move { observation })
    });
    observer.latest.changed().await.unwrap();
    assert_eq!(observer.available_bytes(), Ok(43008));
    tokio::time::advance(HEARTBEAT_PERIOD).await;
    observer.latest.changed().await.unwrap();
    assert_eq!(
        observer.available_bytes(),
        Err(HostMemoryUnknown::ReadFailed(std::io::ErrorKind::NotFound))
    );
    observer.shutdown().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn missed_ticks_are_coalesced_instead_of_replayed() {
    let reads = Arc::new(AtomicUsize::new(0));
    let mut observer = HostMemoryObserver::spawn_reader({
        let reads = Arc::clone(&reads);
        move || {
            reads.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { HostMemoryObservation::unknown(HostMemoryUnknown::Missing) })
        }
    });
    observer.latest.changed().await.unwrap();
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    tokio::time::advance(HEARTBEAT_PERIOD * 100).await;
    observer.latest.changed().await.unwrap();
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    observer.shutdown().await.unwrap();
}
