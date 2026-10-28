use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::task::{Context, Waker};

use crate::gc::{ExistingLockProbe, probe_existing_lock};
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

fn workspace_lease(root: &Path) -> (PathBuf, PathBuf, Flock<File>) {
    let home = test_home(root);
    std::fs::create_dir_all(home.locks_dir()).unwrap();
    let base_dir = root.join("runner-data");
    std::fs::create_dir_all(base_dir.join("workspaces")).unwrap();
    let base_dir = base_dir.canonicalize().unwrap();
    let lock_path = write_base_dir_lock(&home, &base_dir);
    let candidate = DeadRunnerBaseDirLockCandidate {
        lock_name: lock_path.file_name().unwrap().to_str().unwrap().to_owned(),
        lock_path: lock_path.clone(),
    };
    let lease = acquire_dead_runner_base_dir_lease(candidate).unwrap();
    assert_eq!(lease.base_dir, Some(base_dir.clone()));
    (
        base_dir.join("workspaces/run-old"),
        lock_path,
        lease.lock_guard,
    )
}

// Discovery and eligibility IO precede physical deletion admission. Use the
// actual adapter with a lease acquired from the same base-dir key as startup.
fn cancelled_removal_retains_base_dir_authority(failing: bool) {
    let dir = tempfile::tempdir().unwrap();
    let (path, lock_path, lock) = workspace_lease(dir.path());
    if failing {
        std::fs::write(&path, b"retained workspace").unwrap();
    } else {
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("cow.img"), b"retired workspace").unwrap();
    }
    let runtime = Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    let (gate, worker) = occupy_blocking_worker(&runtime);
    let mut removal = Box::pin(real_remove_dir_all(&path, lock));
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
        "cancelled workspace GC released base-dir authority before physical removal retired"
    );

    drop(gate);
    let successor = runtime.block_on(async {
        tokio::time::timeout(WAIT, async {
            worker.await.unwrap();
            loop {
                match probe_existing_lock(&lock_path) {
                    ExistingLockProbe::Free(lock) => break lock,
                    ExistingLockProbe::Held => tokio::task::yield_now().await,
                    ExistingLockProbe::Missing => panic!("base-dir retry lock disappeared"),
                    ExistingLockProbe::Error(error) => {
                        panic!("cannot inspect base-dir lock: {error}")
                    }
                }
            }
        })
        .await
        .expect("accepted workspace removal did not retire its base-dir authority")
    });

    assert!(crate::lock::lock_matches_path(&successor, &lock_path).unwrap());
    if failing {
        assert_eq!(std::fs::read(&path).unwrap(), b"retained workspace");
    } else {
        assert!(!path.try_exists().unwrap());
    }
}

#[test]
fn cancelled_workspace_deletion_retains_base_dir_lock_until_physical_retirement() {
    cancelled_removal_retains_base_dir_authority(false);
}

#[test]
fn cancelled_workspace_io_error_retains_base_dir_lock_until_physical_retirement() {
    cancelled_removal_retains_base_dir_authority(true);
}

#[tokio::test]
async fn observed_missing_workspace_returns_native_error_and_acquired_guard() {
    let dir = tempfile::tempdir().unwrap();
    let (path, lock_path, lock) = workspace_lease(dir.path());
    let (lock, result) = real_remove_dir_all(&path, lock).await;

    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::NotFound);
    assert!(crate::lock::lock_matches_path(&lock, &lock_path).unwrap());
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
async fn observed_workspace_io_error_returns_guard_and_retains_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let (path, lock_path, lock) = workspace_lease(dir.path());
    std::fs::write(&path, b"retained workspace").unwrap();
    let (lock, result) = real_remove_dir_all(&path, lock).await;

    assert_eq!(
        result.unwrap_err().kind(),
        std::io::ErrorKind::NotADirectory
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"retained workspace");
    assert!(crate::lock::lock_matches_path(&lock, &lock_path).unwrap());
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
