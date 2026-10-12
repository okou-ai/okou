use super::super::fs::allocated_bytes;
use super::support::*;
use crate::error::LifecycleError;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::{Notify, Semaphore};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(in crate::home_image_cache) enum ScanPoint {
    Metadata,
    ReadDirectory,
}

pub(super) struct ScanGate {
    path: PathBuf,
    point: ScanPoint,
    armed: AtomicBool,
    entered: Arc<Notify>,
    release: Arc<Semaphore>,
}

impl ScanGate {
    pub(super) fn new(
        path: PathBuf,
        point: ScanPoint,
        entered: Arc<Notify>,
        release: Arc<Semaphore>,
    ) -> Self {
        Self {
            path,
            point,
            armed: AtomicBool::new(true),
            entered,
            release,
        }
    }
}

tokio::task_local! {
    static SCAN_GATE: ScanGate;
}

pub(super) async fn with_scan_gate<F: Future>(gate: ScanGate, scan: F) -> F::Output {
    SCAN_GATE.scope(gate, scan).await
}

pub(in crate::home_image_cache) async fn pause(path: &Path, point: ScanPoint) {
    let gate = SCAN_GATE
        .try_with(|gate| {
            (gate.path == path && gate.point == point && gate.armed.swap(false, Ordering::Relaxed))
                .then(|| (gate.entered.clone(), gate.release.clone()))
        })
        .ok()
        .flatten();
    if let Some((entered, release)) = gate {
        entered.notify_one();
        release.acquire().await.expect("scan gate closed").forget();
    }
}

pub(super) async fn wait_entered(entered: &Notify) {
    tokio::time::timeout(Duration::from_secs(10), entered.notified())
        .await
        .expect("allocation scan must reach the controlled filesystem boundary");
}

#[tokio::test]
async fn allocation_scan_preserves_survivors_when_a_discovered_directory_disappears() {
    for point in [ScanPoint::Metadata, ScanPoint::ReadDirectory] {
        let f = Fixture::new().await;
        let committed = f
            .commit("survivor", b"retained-home", "2026-10-09T09:00:00Z")
            .await;
        let image = f.image("survivor", &committed);
        let image_bytes = tokio::fs::read(&image).await.unwrap();
        let doomed = f.cache.home_image_cache_entry_dir(&f.key("discarded"));
        f.cache
            .ensure_home_cache_entry_dir(&f.key("discarded"))
            .await
            .unwrap();
        tokio::fs::write(doomed.join("orphan"), b"obsolete allocation")
            .await
            .unwrap();
        let before = f.cache.total_cache_allocated_bytes().await.unwrap();
        assert!(before >= allocated_bytes(&std::fs::symlink_metadata(&image).unwrap()));
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let gate = ScanGate::new(doomed.clone(), point, entered.clone(), release.clone());
        let cache = f.cache.clone();
        let pending = tokio::spawn(with_scan_gate(gate, async move {
            cache.total_cache_allocated_bytes().await
        }));
        wait_entered(&entered).await;
        tokio::fs::remove_dir_all(&doomed).await.unwrap();
        release.add_permits(1);
        let measured = tokio::time::timeout(Duration::from_secs(10), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let remaining = f.cache.total_cache_allocated_bytes().await.unwrap();
        assert!(remaining > 0, "the survivor must still consume allocation");
        assert!(
            measured >= remaining,
            "previously counted blocks stay conservative"
        );
        assert!(measured <= before);
        assert_eq!(tokio::fs::read(&image).await.unwrap(), image_bytes);
        assert_eq!(
            f.metadata("survivor").await.image_generation,
            committed.image_generation
        );
    }
}

#[tokio::test]
async fn allocation_scan_propagates_a_discovered_directory_shape_error() {
    let f = Fixture::new().await;
    f.commit("survivor", b"retained-home", "2026-10-09T09:00:00Z")
        .await;
    let changed = f.cache.home_image_cache_entry_dir(&f.key("changed"));
    f.cache
        .ensure_home_cache_entry_dir(&f.key("changed"))
        .await
        .unwrap();
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let gate = ScanGate::new(
        changed.clone(),
        ScanPoint::ReadDirectory,
        entered.clone(),
        release.clone(),
    );
    let cache = f.cache.clone();
    let pending = tokio::spawn(with_scan_gate(gate, async move {
        cache.total_cache_allocated_bytes().await
    }));
    wait_entered(&entered).await;
    tokio::fs::remove_dir(&changed).await.unwrap();
    tokio::fs::write(&changed, b"replacement regular file")
        .await
        .unwrap();
    release.add_permits(1);
    let error = tokio::time::timeout(Duration::from_secs(10), pending)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    let LifecycleError::Io(error) = error else {
        panic!("expected a filesystem error");
    };
    assert_eq!(error.kind(), std::io::ErrorKind::NotADirectory);
    use std::error::Error;
    let original = error
        .source()
        .and_then(|error| error.downcast_ref::<std::io::Error>())
        .unwrap();
    assert_eq!(original.raw_os_error(), Some(libc::ENOTDIR));
}

#[tokio::test]
async fn allocation_scan_propagates_root_disappearance_after_initial_observation() {
    let f = Fixture::new().await;
    f.commit("survivor", b"retained-home", "2026-10-09T09:00:00Z")
        .await;
    let root = f.cache.home_image_cache_dir().to_path_buf();
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let gate = ScanGate::new(
        root.clone(),
        ScanPoint::ReadDirectory,
        entered.clone(),
        release.clone(),
    );
    let cache = f.cache.clone();
    let pending = tokio::spawn(with_scan_gate(gate, async move {
        cache.total_cache_allocated_bytes().await
    }));
    wait_entered(&entered).await;
    tokio::fs::remove_dir_all(root).await.unwrap();
    release.add_permits(1);
    let error = tokio::time::timeout(Duration::from_secs(10), pending)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    let LifecycleError::Io(error) = error else {
        panic!("expected a filesystem error");
    };
    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
}
