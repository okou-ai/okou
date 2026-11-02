use std::time::Duration;

use super::*;

#[test]
fn snapshot_attempt_cow_file_is_attempt_scoped() {
    let work = std::path::Path::new("/tmp/snapshot-work");

    assert_eq!(
        snapshot_attempt_cow_file(work, "abc123ef"),
        work.join("attempts").join("abc123ef").join("cow.img")
    );
    assert_ne!(
        snapshot_attempt_cow_file(work, "abc123ef"),
        work.join("cow.img")
    );
}

#[test]
fn snapshot_attempt_home_image_file_is_attempt_scoped() {
    let work = std::path::Path::new("/tmp/snapshot-work");

    assert_eq!(
        snapshot_attempt_home_image_file(work, "abc123ef"),
        work.join("attempts").join("abc123ef").join("home.ext4")
    );
    assert_ne!(
        snapshot_attempt_home_image_file(work, "abc123ef"),
        work.join("home.ext4")
    );
}

#[test]
fn snapshot_attempt_dir_guard_removes_unowned_attempt_dir() {
    let dir = tempfile::tempdir().expect("tempdir");
    let attempt_dir = dir.path().join("work").join("attempts").join("abc123ef");
    std::fs::create_dir_all(&attempt_dir).expect("create attempt dir");
    std::fs::write(attempt_dir.join("cow.img"), b"partial cow").expect("write cow");

    {
        let _guard = SnapshotAttemptDirGuard::new(attempt_dir.clone());
    }

    assert!(
        !attempt_dir.exists(),
        "unowned attempt dir should be removed on cancellation"
    );
}

#[test]
fn snapshot_attempt_dir_guard_disarm_preserves_owned_attempt_dir() {
    let dir = tempfile::tempdir().expect("tempdir");
    let attempt_dir = dir.path().join("work").join("attempts").join("abc123ef");
    std::fs::create_dir_all(&attempt_dir).expect("create attempt dir");

    {
        let mut guard = SnapshotAttemptDirGuard::new(attempt_dir.clone());
        guard.disarm();
    }

    assert!(
        attempt_dir.exists(),
        "disarmed attempt dir guard should leave the owned dir intact"
    );
}

#[tokio::test]
async fn snapshot_cow_cleanup_finalizer_continues_after_future_drop() {
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();

    let finalizer = SnapshotCowCleanupFinalizer::new(tokio::spawn(async move {
        let _ = started_tx.send(());
        finish_rx.await.map_err(|e| {
            nbd_cow::error::NbdCowError::Io(std::io::Error::other(format!(
                "test cleanup finalizer release dropped: {e}"
            )))
        })?;
        let _ = done_tx.send(());
        Ok(())
    }));

    started_rx
        .await
        .expect("cleanup finalizer task should start");
    drop(finalizer);
    finish_tx.send(()).expect("release cleanup finalizer");
    tokio::time::timeout(Duration::from_secs(1), done_rx)
        .await
        .expect("dropped cleanup finalizer should continue")
        .expect("cleanup finalizer should finish");
}

#[tokio::test]
async fn cleanup_snapshot_attempt_dir_removes_empty_token_dir() {
    let dir = tempfile::tempdir().expect("tempdir");
    let work = dir.path().join("work");
    let cow = snapshot_attempt_cow_file(&work, "abc123ef");
    let attempt_dir = cow.parent().expect("attempt dir").to_path_buf();
    tokio::fs::create_dir_all(&attempt_dir)
        .await
        .expect("create attempt dir");
    tokio::fs::write(&cow, b"cow").await.expect("write cow");
    tokio::fs::remove_file(&cow).await.expect("remove cow");

    assert!(cleanup_snapshot_attempt_dir_for_cow(&cow).await);
    assert!(
        !tokio::fs::try_exists(&attempt_dir).await.unwrap(),
        "empty attempt token dir should be removed after cow cleanup"
    );
}

#[tokio::test]
async fn cleanup_snapshot_attempt_dir_treats_missing_dir_as_clean() {
    let dir = tempfile::tempdir().expect("tempdir");
    let cow = snapshot_attempt_cow_file(&dir.path().join("work"), "missing");

    assert!(cleanup_snapshot_attempt_dir_for_cow(&cow).await);
}

#[tokio::test]
async fn cleanup_snapshot_attempt_dir_reports_nonempty_dir() {
    let dir = tempfile::tempdir().expect("tempdir");
    let work = dir.path().join("work");
    let cow = snapshot_attempt_cow_file(&work, "abc123ef");
    let attempt_dir = cow.parent().expect("attempt dir").to_path_buf();
    tokio::fs::create_dir_all(&attempt_dir)
        .await
        .expect("create attempt dir");
    tokio::fs::write(attempt_dir.join("extra"), b"keep")
        .await
        .expect("write extra");

    assert!(!cleanup_snapshot_attempt_dir_for_cow(&cow).await);
    assert!(
        tokio::fs::try_exists(&attempt_dir).await.unwrap(),
        "nonempty attempt dir should not be force removed"
    );
}
