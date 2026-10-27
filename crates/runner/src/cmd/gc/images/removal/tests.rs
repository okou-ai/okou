use std::fs::File;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::task::{Context, Waker};
use std::time::Duration;

use nix::fcntl::Flock;
use runner_host::gc::{ExistingLockProbe, LockProbe, probe_existing_lock, probe_lock};
use runner_host::lock::lock_matches_path;
use runner_host::paths::HomePaths;
use tokio::runtime::{Builder, Runtime};
use tokio::task::JoinHandle;

use super::{SnapshotRemovalLocks, remove_image_dir, remove_snapshot_dir};
use crate::cmd::gc::test_support::test_home;

const WAIT: Duration = Duration::from_secs(5);

struct ReleaseWorkerOnDrop(Option<mpsc::Sender<()>>);

impl Drop for ReleaseWorkerOnDrop {
    fn drop(&mut self) {
        if let Some(release) = self.0.take() {
            let _ = release.send(());
        }
    }
}

fn occupy_blocking_worker(runtime: &Runtime) -> (ReleaseWorkerOnDrop, JoinHandle<()>) {
    let (started, started_rx) = mpsc::sync_channel(0);
    let (release, release_rx) = mpsc::channel();
    let gate = ReleaseWorkerOnDrop(Some(release));
    let worker = runtime.spawn_blocking(move || {
        started.send(()).unwrap();
        release_rx.recv().unwrap();
    });
    started_rx.recv_timeout(WAIT).unwrap();
    (gate, worker)
}

fn runtime() -> Runtime {
    Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap()
}

fn acquire(path: &Path) -> Flock<File> {
    match probe_lock(path) {
        LockProbe::Free(lock) => lock,
        _ => panic!("image fixture could not acquire its real key"),
    }
}

fn assert_held(path: &Path) {
    assert!(
        matches!(probe_existing_lock(path), ExistingLockProbe::Held),
        "cancelled GC released image authority before physical removal retired: {}",
        path.display()
    );
}

fn assert_returned(lock: &Flock<File>, path: &Path) {
    assert!(lock_matches_path(lock, path).unwrap());
    assert_held(path);
}

fn assert_released(path: &Path) {
    assert!(matches!(
        probe_existing_lock(path),
        ExistingLockProbe::Free(_)
    ));
}

// Discovery and policy IO precede this boundary. Poll the actual image admission
// once with its blocking worker occupied, then cancel only its async observer.
fn cancel_admitted_removal(
    runtime: &Runtime,
    removal: impl Future,
    lock_paths: &[PathBuf],
) -> Vec<Flock<File>> {
    let (gate, worker) = occupy_blocking_worker(runtime);
    let mut removal = Box::pin(removal);
    let entered = runtime.enter();
    assert!(
        removal
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    drop(entered);
    drop(removal);
    for path in lock_paths {
        assert_held(path);
    }

    drop(gate);
    runtime.block_on(async {
        tokio::time::timeout(WAIT, async {
            worker.await.unwrap();
            let mut successors = Vec::new();
            for path in lock_paths {
                let successor = loop {
                    match probe_existing_lock(path) {
                        ExistingLockProbe::Free(lock) => break lock,
                        ExistingLockProbe::Held => tokio::task::yield_now().await,
                        ExistingLockProbe::Missing => panic!("image lock key disappeared"),
                        ExistingLockProbe::Error(error) => {
                            panic!("cannot inspect image lock: {error}")
                        }
                    }
                };
                assert_returned(&successor, path);
                successors.push(successor);
            }
            successors
        })
        .await
        .expect("accepted image deletion did not retire its authority")
    })
}

#[derive(Clone, Copy)]
enum SingleImage {
    TemplateWarm,
    OrphanRootfs,
}

fn single_image(home: &HomePaths, kind: SingleImage) -> (PathBuf, PathBuf, Flock<File>) {
    let (path, key) = match kind {
        SingleImage::TemplateWarm => (
            home.images_dir().join("template-warm-template-old"),
            home.template_lock("template-old"),
        ),
        SingleImage::OrphanRootfs => (
            home.images_dir().join("rootfs-old"),
            home.rootfs_lock("rootfs-old"),
        ),
    };
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let lock = acquire(&key);
    (path, key, lock)
}

fn snapshot(home: &HomePaths) -> (PathBuf, [PathBuf; 2], SnapshotRemovalLocks) {
    let rootfs_key = home.rootfs_lock("rootfs-old");
    let snapshot_key = home.snapshot_lock("snapshot-old");
    let rootfs = acquire(&rootfs_key);
    let snapshot = acquire(&snapshot_key);
    let path = home.images_dir().join("rootfs-old/snapshots/snapshot-old");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    (
        path,
        [rootfs_key, snapshot_key],
        SnapshotRemovalLocks { rootfs, snapshot },
    )
}

fn prepare_removal(path: &Path, failing: bool) {
    if failing {
        std::fs::write(path, b"retained image").unwrap();
    } else {
        std::fs::create_dir(path).unwrap();
        std::fs::write(path.join("image.bin"), b"retired image").unwrap();
    }
}

fn assert_physical_result(path: &Path, failing: bool) {
    if failing {
        assert_eq!(std::fs::read(path).unwrap(), b"retained image");
    } else {
        assert!(!path.try_exists().unwrap());
    }
}

fn cancelled_single_image(kind: SingleImage, failing: bool) {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();
    let (path, key, lock) = single_image(&home, kind);
    prepare_removal(&path, failing);
    let runtime = runtime();
    let _successors = cancel_admitted_removal(&runtime, remove_image_dir(&path, lock), &[key]);
    assert_physical_result(&path, failing);
}

fn cancelled_snapshot(failing: bool) {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();
    let (path, keys, locks) = snapshot(&home);
    prepare_removal(&path, failing);
    let runtime = runtime();
    let _successors = cancel_admitted_removal(&runtime, remove_snapshot_dir(&path, locks), &keys);
    assert_physical_result(&path, failing);
}

#[test]
fn cancelled_template_deletion_retains_lock_until_physical_retirement() {
    cancelled_single_image(SingleImage::TemplateWarm, false);
}

#[test]
fn cancelled_template_io_error_retains_lock_until_physical_retirement() {
    cancelled_single_image(SingleImage::TemplateWarm, true);
}

#[test]
fn cancelled_orphan_rootfs_deletion_retains_lock_until_physical_retirement() {
    cancelled_single_image(SingleImage::OrphanRootfs, false);
}

#[test]
fn cancelled_orphan_rootfs_io_error_retains_lock_until_physical_retirement() {
    cancelled_single_image(SingleImage::OrphanRootfs, true);
}

#[test]
fn cancelled_snapshot_deletion_retains_both_locks_until_physical_retirement() {
    cancelled_snapshot(false);
}

#[test]
fn cancelled_snapshot_io_error_retains_both_locks_until_physical_retirement() {
    cancelled_snapshot(true);
}

#[tokio::test]
async fn observed_template_io_error_returns_guard_and_retains_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();
    let (path, key, lock) = single_image(&home, SingleImage::TemplateWarm);
    prepare_removal(&path, true);
    let (lock, result) = remove_image_dir(&path, lock).await;

    assert_eq!(
        result.unwrap_err().kind(),
        std::io::ErrorKind::NotADirectory
    );
    assert_physical_result(&path, true);
    assert_returned(&lock, &key);
    drop(lock);
    assert_released(&key);
}

#[tokio::test]
async fn observed_missing_rootfs_returns_native_error_and_guard() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();
    let (path, key, lock) = single_image(&home, SingleImage::OrphanRootfs);
    let (lock, result) = remove_image_dir(&path, lock).await;

    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::NotFound);
    assert_returned(&lock, &key);
    drop(lock);
    assert_released(&key);
}

async fn observed_snapshot_result(failing: bool) {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();
    let (path, keys, locks) = snapshot(&home);
    if failing {
        prepare_removal(&path, true);
    }
    let (locks, result) = remove_snapshot_dir(&path, locks).await;

    let expected = if failing {
        std::io::ErrorKind::NotADirectory
    } else {
        std::io::ErrorKind::NotFound
    };
    assert_eq!(result.unwrap_err().kind(), expected);
    if failing {
        assert_physical_result(&path, true);
    }
    assert_returned(&locks.rootfs, &keys[0]);
    assert_returned(&locks.snapshot, &keys[1]);
    drop(locks);
    for key in keys {
        assert_released(&key);
    }
}

#[tokio::test]
async fn observed_snapshot_io_error_returns_both_guards_and_retains_bytes() {
    observed_snapshot_result(true).await;
}

#[tokio::test]
async fn observed_missing_snapshot_returns_native_error_and_both_guards() {
    observed_snapshot_result(false).await;
}
