use std::future::Future;
use std::sync::mpsc;
use std::task::{Context, Waker};
use std::time::Duration;

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

fn acquire(path: &Path) -> Flock<std::fs::File> {
    match probe_lock(path) {
        LockProbe::Free(lock) => lock,
        LockProbe::Held => panic!("test version lock unexpectedly held"),
        LockProbe::Error(error) => panic!("cannot acquire test version lock: {error}"),
    }
}

fn cancelled_removal_retains_authority(failing: bool) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache");
    let lock_path = dir.path().join("version.lock");
    if failing {
        std::fs::write(&path, b"retained file").unwrap();
    } else {
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("archive.tar.gz"), b"retired cache").unwrap();
    }
    let lock = acquire(&lock_path);
    let runtime = Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    let (gate, worker) = occupy_blocking_worker(&runtime);
    let mut removal = Box::pin(remove_dir_all_with_lock(&path, lock));
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
        "cancelled Storage GC released version authority before physical removal retired"
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
                    ExistingLockProbe::Missing => panic!("version lock path disappeared"),
                    ExistingLockProbe::Error(error) => {
                        panic!("cannot inspect version lock: {error}")
                    }
                }
            }
        })
        .await
        .expect("accepted physical removal did not retire its version authority");
    });

    let successor = acquire(&lock_path);
    assert!(runner_host::lock::lock_matches_path(&successor, &lock_path).unwrap());
    if failing {
        assert_eq!(std::fs::read(&path).unwrap(), b"retained file");
    } else {
        assert!(!path.try_exists().unwrap());
    }
}

#[test]
fn cancelled_deletion_retains_version_lock_until_physical_retirement() {
    cancelled_removal_retains_authority(false);
}

#[test]
fn cancelled_io_error_retains_version_lock_until_physical_retirement() {
    cancelled_removal_retains_authority(true);
}

#[tokio::test]
async fn observed_io_error_returns_the_acquired_version_guard() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("not-a-directory");
    let lock_path = dir.path().join("version.lock");
    std::fs::write(&path, b"retained file").unwrap();
    let lock = acquire(&lock_path);
    let (lock, result) = remove_dir_all_with_lock(&path, lock).await;

    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::NotADirectory);
    assert!(runner_host::lock::lock_matches_path(&lock, &lock_path).unwrap());
    assert!(matches!(
        probe_existing_lock(&lock_path),
        ExistingLockProbe::Held
    ));
    assert_eq!(std::fs::read(&path).unwrap(), b"retained file");
    drop(lock);
    assert!(matches!(
        probe_existing_lock(&lock_path),
        ExistingLockProbe::Free(_)
    ));
}
