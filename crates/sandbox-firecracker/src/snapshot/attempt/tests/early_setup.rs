use std::future::{Future, pending};
use std::path::PathBuf;
use std::time::Duration;

use tokio::sync::oneshot;

use super::super::*;
use crate::snapshot::cow::{snapshot_attempt_cow_file, snapshot_attempt_home_image_file};

struct EarlyAttempt {
    _dir: tempfile::TempDir,
    attempt: SnapshotAttempt,
    cow_file: PathBuf,
    bitmap_file: PathBuf,
    sock_dir: PathBuf,
    destroy_started: oneshot::Receiver<()>,
    release_destroy: oneshot::Sender<bool>,
    cow_cleanup_complete: oneshot::Receiver<()>,
}

impl EarlyAttempt {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let output = SnapshotOutputPaths::new(dir.path().join("output"));
        let paths = SandboxPaths::new(output.work_dir());
        let cow_file = snapshot_attempt_cow_file(paths.workspace(), "early");
        let bitmap_file = cow_file.with_file_name("cow.img.bitmap");
        let attempt_dir = cow_file.parent().unwrap().to_path_buf();
        std::fs::create_dir_all(&attempt_dir).unwrap();
        std::fs::write(&cow_file, b"cow").unwrap();
        std::fs::write(&bitmap_file, b"bitmap").unwrap();
        let sock_dir = dir.path().join("sockets");
        std::fs::create_dir(&sock_dir).unwrap();

        let (started_tx, destroy_started) = oneshot::channel();
        let (release_destroy, release_rx) = oneshot::channel();
        let (done_tx, cow_cleanup_complete) = oneshot::channel();
        let destroy_cow_file = cow_file.clone();
        let destroy_bitmap_file = bitmap_file.clone();
        let cow = SnapshotCowDevice::Test {
            cow_file: cow_file.clone(),
            destroy: Box::pin(async move {
                started_tx.send(()).unwrap();
                if release_rx.await.unwrap() {
                    // Model the kernel-device boundary's successful finalizer;
                    // snapshot directory cleanup remains production code.
                    std::fs::remove_file(destroy_cow_file).unwrap();
                    std::fs::remove_file(destroy_bitmap_file).unwrap();
                    Ok(())
                } else {
                    Err(nbd_cow::error::NbdCowError::Io(std::io::Error::other(
                        "device shutdown remains uncertain",
                    ))
                    .into())
                }
            }),
            cleanup_complete: Some(done_tx),
        };
        let home_image = snapshot_attempt_home_image_file(paths.workspace(), "early");
        let attempt = SnapshotAttempt::new(
            paths,
            SockPaths::new(sock_dir.clone()),
            output,
            DevicePoolHandle::new(nbd_cow::pool::DevicePoolConfig::default()),
            cow,
            home_image,
            SnapshotAttemptDirGuard::new(attempt_dir),
        );

        Self {
            _dir: dir,
            attempt,
            cow_file,
            bitmap_file,
            sock_dir,
            destroy_started,
            release_destroy,
            cow_cleanup_complete,
        }
    }
}

async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .expect("snapshot cleanup should make progress")
}

fn assert_backing_files(cow_file: &std::path::Path, bitmap_file: &std::path::Path) {
    assert_eq!(std::fs::read(cow_file).unwrap(), b"cow");
    assert_eq!(std::fs::read(bitmap_file).unwrap(), b"bitmap");
}

#[tokio::test]
async fn netns_failure_respects_cow_cleanup_safety_and_preserves_setup_error() {
    for safe_to_delete in [true, false] {
        let EarlyAttempt {
            _dir,
            mut attempt,
            cow_file,
            bitmap_file,
            sock_dir,
            destroy_started,
            release_destroy,
            cow_cleanup_complete,
        } = EarlyAttempt::new();
        assert_backing_files(&cow_file, &bitmap_file);
        let result = bounded(async {
            tokio::join!(
                attempt.initialize_netns_pool(async {
                    Err(SnapshotError::Setup(
                        "netns pool: lock allocation failed".into(),
                    ))
                }),
                async {
                    destroy_started.await.unwrap();
                    assert_backing_files(&cow_file, &bitmap_file);
                    release_destroy.send(safe_to_delete).unwrap();
                }
            )
            .0
        })
        .await;
        assert!(
            matches!(result, Err(SnapshotError::Setup(message)) if message == "netns pool: lock allocation failed")
        );
        bounded(cow_cleanup_complete).await.unwrap();
        assert!(!attempt.has_cleanup_work());
        drop(attempt);
        assert!(
            !sock_dir.exists(),
            "explicit cleanup still owns the snapshot lock"
        );
        if safe_to_delete {
            assert!(!cow_file.parent().unwrap().exists());
        } else {
            assert_backing_files(&cow_file, &bitmap_file);
        }
    }
}

#[tokio::test]
async fn cancellation_during_netns_creation_uses_attempt_finalizer() {
    for safe_to_delete in [true, false] {
        let EarlyAttempt {
            _dir,
            mut attempt,
            cow_file,
            bitmap_file,
            sock_dir,
            destroy_started,
            release_destroy,
            cow_cleanup_complete,
        } = EarlyAttempt::new();
        let (netns_started_tx, netns_started_rx) = oneshot::channel();
        let (attempt_done_tx, attempt_done_rx) = oneshot::channel();
        attempt.notify_cleanup_complete_for_test(attempt_done_tx);
        let task = tokio::spawn(async move {
            attempt
                .initialize_netns_pool(async {
                    netns_started_tx.send(()).unwrap();
                    pending().await
                })
                .await
        });
        bounded(netns_started_rx).await.unwrap();
        task.abort();
        assert!(bounded(task).await.unwrap_err().is_cancelled());
        bounded(destroy_started).await.unwrap();
        assert_backing_files(&cow_file, &bitmap_file);
        release_destroy.send(safe_to_delete).unwrap();
        bounded(cow_cleanup_complete).await.unwrap();
        let report = bounded(attempt_done_rx).await.unwrap();
        assert_eq!(report.cow_destroyed, safe_to_delete);
        assert!(report.device_pool_cleaned);
        assert!(report.netns_pool_cleaned);
        assert!(
            sock_dir.exists(),
            "detached cleanup cannot remove stable sockets"
        );
        if safe_to_delete {
            assert!(!cow_file.parent().unwrap().exists());
        } else {
            assert_backing_files(&cow_file, &bitmap_file);
        }
    }
}

#[tokio::test]
async fn cancellation_during_netns_failure_cleanup_waits_for_cow_safety() {
    for safe_to_delete in [true, false] {
        let EarlyAttempt {
            _dir,
            mut attempt,
            cow_file,
            bitmap_file,
            sock_dir,
            destroy_started,
            release_destroy,
            cow_cleanup_complete,
        } = EarlyAttempt::new();
        let (attempt_done_tx, attempt_done_rx) = oneshot::channel();
        attempt.notify_cleanup_complete_for_test(attempt_done_tx);
        let task = tokio::spawn(async move {
            attempt
                .initialize_netns_pool(async {
                    Err(SnapshotError::Setup(
                        "netns pool: forwarding setup failed".into(),
                    ))
                })
                .await
        });
        bounded(destroy_started).await.unwrap();
        task.abort();
        assert!(bounded(task).await.unwrap_err().is_cancelled());
        assert_backing_files(&cow_file, &bitmap_file);
        release_destroy.send(safe_to_delete).unwrap();
        bounded(cow_cleanup_complete).await.unwrap();
        let report = bounded(attempt_done_rx).await.unwrap();
        assert!(report.device_pool_cleaned);
        assert!(
            sock_dir.exists(),
            "detached cleanup cannot remove stable sockets"
        );
        if safe_to_delete {
            assert!(!cow_file.parent().unwrap().exists());
        } else {
            assert_backing_files(&cow_file, &bitmap_file);
        }
    }
}

#[tokio::test]
async fn successful_netns_creation_keeps_cow_owned_until_attempt_cleanup() {
    let EarlyAttempt {
        _dir,
        mut attempt,
        cow_file,
        bitmap_file,
        destroy_started,
        release_destroy,
        cow_cleanup_complete,
        ..
    } = EarlyAttempt::new();
    attempt
        .initialize_netns_pool(async { Ok(NetnsPool::inactive_for_test()) })
        .await
        .unwrap();
    assert_backing_files(&cow_file, &bitmap_file);
    assert!(attempt.cleanup_resources.netns_pool.is_some());
    let (done_tx, done_rx) = oneshot::channel();
    attempt.notify_cleanup_complete_for_test(done_tx);
    drop(attempt);
    bounded(destroy_started).await.unwrap();
    release_destroy.send(true).unwrap();
    bounded(cow_cleanup_complete).await.unwrap();
    let report = bounded(done_rx).await.unwrap();
    assert!(report.cow_destroyed);
    assert!(report.netns_pool_cleaned);
    assert!(!cow_file.parent().unwrap().exists());
}
