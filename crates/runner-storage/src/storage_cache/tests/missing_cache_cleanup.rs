use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::task::{Context, Waker};
use std::time::Duration;

use runner_host::lock::{self, ExistingTryLock, TryLock};
use runner_host::test_fixtures::blocking_worker::{BlockingWorkerRelease, occupy_blocking_worker};
use tokio::runtime::{Builder, Runtime};
use tokio::task::JoinHandle;

use super::super::remove_storage_lock_after_missing_cache;

const WAIT: Duration = Duration::from_secs(5);

fn runtime() -> Runtime {
    Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap()
}

fn acquire(path: &Path) -> nix::fcntl::Flock<std::fs::File> {
    match lock::try_acquire_or_busy_blocking(path).unwrap() {
        TryLock::Acquired(lock) => lock,
        TryLock::Busy => panic!("test lock unexpectedly held"),
    }
}

fn poll_pending(runtime: &Runtime, cleanup: Pin<&mut impl Future<Output = ()>>) {
    let _entered = runtime.enter();
    assert!(
        cleanup
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
}

fn drain_blocking(runtime: &Runtime, worker: JoinHandle<()>) {
    runtime.block_on(async {
        tokio::time::timeout(WAIT, async {
            worker.await.unwrap();
            tokio::task::spawn_blocking(|| ()).await.unwrap();
        })
        .await
        .expect("blocking work did not retire");
    });
}

fn queue_cleanup(
    runtime: &Runtime,
    mut cleanup: Pin<&mut impl Future<Output = ()>>,
) -> (BlockingWorkerRelease, JoinHandle<()>) {
    // First queue the existing-only probe, then retire it without polling its
    // observer. Its completed result now owns the acquired flock.
    let (probe_gate, probe_worker) = occupy_blocking_worker(runtime, WAIT);
    poll_pending(runtime, cleanup.as_mut());
    drop(probe_gate);
    drain_blocking(runtime, probe_worker);

    // Poll the acquired result with the only worker occupied: physical cleanup
    // is admitted but cannot validate or unlink until this gate is released.
    let (gate, worker) = occupy_blocking_worker(runtime, WAIT);
    poll_pending(runtime, cleanup);
    (gate, worker)
}

#[test]
fn cancelled_missing_cache_cleanup_retains_flock_until_physical_retirement() {
    let temp = tempfile::tempdir().unwrap();
    let lock_path = temp.path().join("storage.lock");
    let archive_path = temp.path().join("archive.tar.gz");
    drop(acquire(&lock_path));
    let runtime = runtime();
    let mut cleanup = Box::pin(remove_storage_lock_after_missing_cache(
        &lock_path,
        &archive_path,
    ));
    let (gate, worker) = queue_cleanup(&runtime, cleanup.as_mut());
    drop(cleanup);

    assert!(
        matches!(
            lock::try_acquire_existing_or_missing_blocking(&lock_path).unwrap(),
            ExistingTryLock::Busy
        ),
        "cancelled observer released the flock before physical cleanup retired"
    );

    drop(gate);
    drain_blocking(&runtime, worker);
    assert!(!lock_path.exists());

    let successor = acquire(&lock_path);
    std::fs::write(&lock_path, b"successor").unwrap();
    runtime.block_on(async {
        tokio::time::timeout(WAIT, tokio::task::spawn_blocking(|| ()))
            .await
            .unwrap()
            .unwrap();
    });
    assert!(lock::lock_matches_path(&successor, &lock_path).unwrap());
    assert_eq!(std::fs::read(&lock_path).unwrap(), b"successor");
    assert!(matches!(
        lock::try_acquire_or_busy_blocking(&lock_path).unwrap(),
        TryLock::Busy
    ));
}

#[test]
fn queued_missing_cache_cleanup_preserves_replacement_inode() {
    let temp = tempfile::tempdir().unwrap();
    let lock_path = temp.path().join("storage.lock");
    let archive_path = temp.path().join("archive.tar.gz");
    drop(acquire(&lock_path));
    let runtime = runtime();
    let mut cleanup = Box::pin(remove_storage_lock_after_missing_cache(
        &lock_path,
        &archive_path,
    ));
    let (gate, worker) = queue_cleanup(&runtime, cleanup.as_mut());

    std::fs::rename(&lock_path, temp.path().join("retired.lock")).unwrap();
    let replacement = acquire(&lock_path);
    std::fs::write(&lock_path, b"replacement").unwrap();
    drop(gate);
    runtime.block_on(async {
        tokio::time::timeout(WAIT, async {
            worker.await.unwrap();
            cleanup.await;
        })
        .await
        .expect("queued cleanup did not retire");
    });

    assert!(lock::lock_matches_path(&replacement, &lock_path).unwrap());
    assert_eq!(std::fs::read(&lock_path).unwrap(), b"replacement");
}

#[test]
fn queued_missing_cache_cleanup_rechecks_archive_before_removal() {
    let temp = tempfile::tempdir().unwrap();
    let lock_path = temp.path().join("storage.lock");
    let archive_path = temp.path().join("archive.tar.gz");
    drop(acquire(&lock_path));
    std::fs::write(&lock_path, b"archive lock").unwrap();
    let runtime = runtime();
    let mut cleanup = Box::pin(remove_storage_lock_after_missing_cache(
        &lock_path,
        &archive_path,
    ));
    let (gate, worker) = queue_cleanup(&runtime, cleanup.as_mut());

    std::fs::write(&archive_path, b"published archive").unwrap();
    drop(gate);
    runtime.block_on(async {
        tokio::time::timeout(WAIT, async {
            worker.await.unwrap();
            cleanup.await;
        })
        .await
        .expect("queued cleanup did not retire");
    });

    assert_eq!(std::fs::read(&lock_path).unwrap(), b"archive lock");
    let retained = acquire(&lock_path);
    assert!(lock::lock_matches_path(&retained, &lock_path).unwrap());
    assert_eq!(std::fs::read(&archive_path).unwrap(), b"published archive");
}
