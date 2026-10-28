use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::task::{Context, Waker};

use runner_host::gc::{ExistingLockProbe, LockProbe, probe_existing_lock, probe_lock};
use tokio::runtime::{Builder, Runtime};
use tokio::task::JoinHandle;

use super::*;

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

fn service_paths(root: &Path) -> (PathBuf, PathBuf) {
    let home = test_home(root);
    let unit = test_version_service_unit("v1.2.3");
    (home.runners_dir().join("v1.2.3"), unit.lock_path(&home))
}

fn acquire(path: &Path) -> Flock<std::fs::File> {
    match probe_lock(path) {
        LockProbe::Free(lock) => lock,
        LockProbe::Held => panic!("test service lock unexpectedly held"),
        LockProbe::Error(error) => panic!("cannot acquire test service lock: {error}"),
    }
}

// Inventory/systemctl IO precedes deletion admission. Exercise the actual
// production adapter with the real service-key flock at that narrow boundary.
fn cancelled_removal_retains_service_authority(failing: bool) {
    let dir = tempfile::tempdir().unwrap();
    let (path, lock_path) = service_paths(dir.path());
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    if failing {
        std::fs::write(&path, b"retained config").unwrap();
    } else {
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("runner.yaml"), b"retired config").unwrap();
    }
    let lock = acquire(&lock_path);
    let runtime = Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    let (gate, worker) = occupy_blocking_worker(&runtime);
    let mut removal = Box::pin(remove_version_dir(&path, lock, real_remove_dir_all));
    let entered = runtime.enter();
    assert!(
        removal
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    drop(entered);
    drop(removal);

    assert!(
        matches!(probe_existing_lock(&lock_path), ExistingLockProbe::Held),
        "cancelled version GC released service authority before physical removal retired"
    );

    drop(gate);
    runtime.block_on(async {
        tokio::time::timeout(WAIT, async {
            worker.await.unwrap();
            loop {
                match probe_existing_lock(&lock_path) {
                    ExistingLockProbe::Free(lock) => {
                        drop(lock);
                        break;
                    }
                    ExistingLockProbe::Held => tokio::task::yield_now().await,
                    ExistingLockProbe::Missing => panic!("service lock path disappeared"),
                    ExistingLockProbe::Error(error) => {
                        panic!("cannot inspect service lock: {error}")
                    }
                }
            }
        })
        .await
        .expect("accepted version removal did not retire its service authority");
    });

    let successor = acquire(&lock_path);
    assert!(runner_host::lock::lock_matches_path(&successor, &lock_path).unwrap());
    if failing {
        assert_eq!(std::fs::read(&path).unwrap(), b"retained config");
    } else {
        assert!(!path.try_exists().unwrap());
    }
}

#[test]
fn cancelled_version_deletion_retains_service_lock_until_physical_retirement() {
    cancelled_removal_retains_service_authority(false);
}

#[test]
fn cancelled_version_io_error_retains_service_lock_until_physical_retirement() {
    cancelled_removal_retains_service_authority(true);
}

#[tokio::test]
async fn observed_missing_version_succeeds_and_returns_acquired_service_guard() {
    let dir = tempfile::tempdir().unwrap();
    let (path, lock_path) = service_paths(dir.path());
    let lock = acquire(&lock_path);
    let (lock, removed) = remove_version_dir(&path, lock, real_remove_dir_all).await;

    assert!(removed);
    assert!(!path.try_exists().unwrap());
    assert!(runner_host::lock::lock_matches_path(&lock, &lock_path).unwrap());
    assert!(matches!(
        probe_existing_lock(&lock_path),
        ExistingLockProbe::Held
    ));
    drop(lock);
    assert!(matches!(
        probe_existing_lock(&lock_path),
        ExistingLockProbe::Free(_)
    ));
}

#[tokio::test]
async fn observed_version_io_error_returns_guard_and_retains_config_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let (path, lock_path) = service_paths(dir.path());
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"retained config").unwrap();
    let lock = acquire(&lock_path);
    let (lock, removed) = remove_version_dir(&path, lock, real_remove_dir_all).await;

    assert!(!removed);
    assert_eq!(std::fs::read(&path).unwrap(), b"retained config");
    assert!(runner_host::lock::lock_matches_path(&lock, &lock_path).unwrap());
    assert!(matches!(
        probe_existing_lock(&lock_path),
        ExistingLockProbe::Held
    ));
    drop(lock);
    assert!(matches!(
        probe_existing_lock(&lock_path),
        ExistingLockProbe::Free(_)
    ));
}
