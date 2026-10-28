use std::fs::File;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::task::{Context, Waker};
use std::time::Duration;

use nix::fcntl::Flock;
use runner_host::gc::{ExistingLockProbe, LockProbe, probe_existing_lock, probe_lock};
use runner_host::lock::lock_matches_path;
use tokio::runtime::{Builder, Runtime};
use tokio::task::JoinHandle;

use super::remove_cache_file;
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

fn cache_lease(root: &Path) -> (PathBuf, PathBuf, Flock<File>) {
    let home = test_home(root);
    std::fs::create_dir_all(home.debootstrap_dir()).unwrap();
    let key = home.debootstrap_lock();
    let lock = match probe_lock(&key) {
        LockProbe::Free(lock) => lock,
        _ => panic!("cache fixture could not acquire its actual debootstrap key"),
    };
    (home.debootstrap_dir().join("noble-amd64.tar"), key, lock)
}

fn assert_held(key: &Path) {
    assert!(
        matches!(probe_existing_lock(key), ExistingLockProbe::Held),
        "released debootstrap cache authority before physical unlink retired"
    );
}

fn cancelled_unlink_retains_cache_authority(failing: bool) {
    let dir = tempfile::tempdir().unwrap();
    let (path, key, lock) = cache_lease(dir.path());
    if failing {
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("retained"), b"cache bytes").unwrap();
    } else {
        std::fs::write(&path, b"retired cache").unwrap();
    }
    let runtime = Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    let (gate, worker) = occupy_blocking_worker(&runtime);
    // Discovery and retention precede this admission. Poll the real unlink
    // owner once with its worker occupied, then drop only its observer.
    let mut unlink = Box::pin(remove_cache_file(&path, lock));
    let entered = runtime.enter();
    assert!(
        unlink
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    drop(entered);
    drop(unlink);
    assert_held(&key);

    drop(gate);
    let successor = runtime.block_on(async {
        tokio::time::timeout(WAIT, async {
            worker.await.unwrap();
            loop {
                match probe_existing_lock(&key) {
                    ExistingLockProbe::Free(lock) => break lock,
                    ExistingLockProbe::Held => tokio::task::yield_now().await,
                    ExistingLockProbe::Missing => panic!("cache lock path disappeared"),
                    ExistingLockProbe::Error(error) => {
                        panic!("cannot inspect cache authority: {error}")
                    }
                }
            }
        })
        .await
        .expect("accepted cache unlink did not retire its authority")
    });
    assert!(lock_matches_path(&successor, &key).unwrap());
    assert_held(&key);
    if failing {
        assert_eq!(
            std::fs::read(path.join("retained")).unwrap(),
            b"cache bytes"
        );
    } else {
        assert!(!path.try_exists().unwrap());
        std::fs::write(&path, b"successor cache").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"successor cache");
    }
}

#[test]
fn cancelled_cache_unlink_retains_lock_until_physical_retirement() {
    cancelled_unlink_retains_cache_authority(false);
}

#[test]
fn cancelled_cache_io_error_retains_lock_until_physical_retirement() {
    cancelled_unlink_retains_cache_authority(true);
}

#[tokio::test]
async fn observed_missing_cache_returns_native_error_and_acquired_guard() {
    let dir = tempfile::tempdir().unwrap();
    let (path, key, lock) = cache_lease(dir.path());
    let (lock, result) = remove_cache_file(&path, lock).await;

    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::NotFound);
    assert!(lock_matches_path(&lock, &key).unwrap());
    assert_held(&key);
    drop(lock);
    assert!(matches!(
        probe_existing_lock(&key),
        ExistingLockProbe::Free(_)
    ));
}

#[tokio::test]
async fn observed_cache_io_error_returns_guard_and_retains_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let (path, key, lock) = cache_lease(dir.path());
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("retained"), b"cache bytes").unwrap();
    let (lock, result) = remove_cache_file(&path, lock).await;

    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::IsADirectory);
    assert_eq!(
        std::fs::read(path.join("retained")).unwrap(),
        b"cache bytes"
    );
    assert!(lock_matches_path(&lock, &key).unwrap());
    assert_held(&key);
    drop(lock);
    assert!(matches!(
        probe_existing_lock(&key),
        ExistingLockProbe::Free(_)
    ));
}
