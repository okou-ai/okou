use std::path::Path;

use nbd_cow::KeptCow;
use sandbox::{PendingSnapshotPublish, SnapshotProvider};

use crate::paths::SnapshotOutputPaths;
use crate::snapshot::cow::snapshot_attempt_cow_file;
use crate::snapshot::provider::FirecrackerSnapshotProvider;
use crate::snapshot::{SNAPSHOT_COMPLETE_MARKER_CONTENT, SnapshotError};

use super::*;

async fn write_required_snapshot_artifacts(output: &SnapshotOutputPaths) {
    tokio::fs::create_dir_all(output.dir())
        .await
        .expect("create output dir");
    for artifact in [output.snapshot(), output.memory()] {
        tokio::fs::write(&artifact, b"snapshot artifact")
            .await
            .unwrap_or_else(|e| panic!("write {}: {e}", artifact.display()));
    }
}

async fn write_kept_cow_for_test(work: &Path, token: &str) -> KeptCow {
    let cow_file = snapshot_attempt_cow_file(work, token);
    let bitmap_file = cow_file.with_file_name("cow.img.bitmap");
    let attempt_dir = cow_file.parent().expect("attempt dir");
    tokio::fs::create_dir_all(attempt_dir)
        .await
        .expect("create attempt dir");
    tokio::fs::write(&cow_file, b"cow")
        .await
        .expect("write cow");
    tokio::fs::write(&bitmap_file, b"bitmap")
        .await
        .expect("write bitmap");
    KeptCow {
        cow_file,
        bitmap_file,
    }
}

#[tokio::test]
async fn snapshot_publish_commit_moves_cow_and_writes_complete_marker() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "publish-ok").await;
    let attempt_dir = kept_cow
        .cow_file
        .parent()
        .expect("attempt dir")
        .to_path_buf();

    commit_snapshot_cow_output(&kept_cow, &output).expect("commit snapshot cow output");

    assert!(
        tokio::fs::try_exists(output.cow()).await.unwrap(),
        "stable cow should be published"
    );
    assert!(
        tokio::fs::try_exists(output.cow_bitmap()).await.unwrap(),
        "stable bitmap should be published"
    );
    assert!(
        !tokio::fs::try_exists(attempt_dir).await.unwrap(),
        "empty attempt dir should be removed after publish"
    );
    let marker = tokio::fs::read(output.complete_marker())
        .await
        .expect("read marker");
    assert_eq!(marker, SNAPSHOT_COMPLETE_MARKER_CONTENT);

    let provider = FirecrackerSnapshotProvider;
    assert!(provider.is_complete(output.dir()).await.unwrap());
}

#[tokio::test]
async fn pending_snapshot_publish_commit_writes_complete_marker() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "pending-commit").await;

    let mut pending: Box<dyn PendingSnapshotPublish> =
        Box::new(FirecrackerPendingSnapshotPublish::new(
            output.snapshot_config("pending-commit"),
            SnapshotOutputPaths::new(output.dir().to_path_buf()),
            kept_cow,
        ));

    let published = pending.commit().await.expect("commit pending publish");

    assert_eq!(published.snapshot_path, output.snapshot());
    assert_eq!(published.memory_path, output.memory());
    assert_eq!(published.cow_path, output.cow());
    assert!(
        tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "commit should write complete marker"
    );

    let provider = FirecrackerSnapshotProvider;
    assert!(provider.is_complete(output.dir()).await.unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn pending_snapshot_publish_commit_multi_thread_runtime_writes_complete_marker() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "pending-commit-multi-thread").await;
    let mut pending: Box<dyn PendingSnapshotPublish> =
        Box::new(FirecrackerPendingSnapshotPublish::new(
            output.snapshot_config("pending-commit-multi-thread"),
            SnapshotOutputPaths::new(output.dir().to_path_buf()),
            kept_cow,
        ));

    pending
        .commit()
        .await
        .expect("multi-thread commit should publish snapshot");

    assert!(
        FirecrackerSnapshotProvider
            .is_complete(output.dir())
            .await
            .unwrap(),
        "multi-thread commit should write a complete snapshot"
    );
}

#[tokio::test]
async fn pending_snapshot_publish_commit_failure_does_not_publish_marker() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    tokio::fs::create_dir_all(output.dir())
        .await
        .expect("create output dir");
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "pending-commit-fail").await;

    let mut pending: Box<dyn PendingSnapshotPublish> =
        Box::new(FirecrackerPendingSnapshotPublish::new(
            output.snapshot_config("pending-commit-fail"),
            SnapshotOutputPaths::new(output.dir().to_path_buf()),
            kept_cow,
        ));

    let err = pending
        .commit()
        .await
        .expect_err("pending commit should fail without snapshot and memory artifacts");
    assert!(matches!(err, sandbox::SnapshotError::Io(_)), "got: {err:?}");
    pending
        .discard()
        .await
        .expect("failed pending commit should keep cleanup state for discard");
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "failed pending commit must not write complete marker"
    );

    let provider = FirecrackerSnapshotProvider;
    assert!(
        !provider.is_complete(output.dir()).await.unwrap(),
        "failed pending commit must remain incomplete"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn pending_snapshot_publish_discard_does_not_publish_marker_or_stable_cow() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "pending-discard").await;
    let attempt_dir = kept_cow
        .cow_file
        .parent()
        .expect("attempt dir")
        .to_path_buf();

    let mut pending: Box<dyn PendingSnapshotPublish> =
        Box::new(FirecrackerPendingSnapshotPublish::new(
            output.snapshot_config("pending-discard"),
            SnapshotOutputPaths::new(output.dir().to_path_buf()),
            kept_cow,
        ));

    pending.discard().await.expect("discard pending publish");

    assert!(
        !tokio::fs::try_exists(output.snapshot()).await.unwrap(),
        "discard should remove uncommitted snapshot file"
    );
    assert!(
        !tokio::fs::try_exists(output.memory()).await.unwrap(),
        "discard should remove uncommitted memory file"
    );
    assert!(
        !tokio::fs::try_exists(output.cow()).await.unwrap(),
        "discard should not publish stable cow"
    );
    assert!(
        !tokio::fs::try_exists(output.cow_bitmap()).await.unwrap(),
        "discard should not publish stable cow bitmap"
    );
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "discard should not write complete marker"
    );
    assert!(
        !tokio::fs::try_exists(attempt_dir).await.unwrap(),
        "discard should remove temporary attempt dir"
    );
    assert!(
        !tokio::fs::try_exists(output.work_dir()).await.unwrap(),
        "discard should remove uncommitted snapshot work dir"
    );

    let provider = FirecrackerSnapshotProvider;
    assert!(!provider.is_complete(output.dir()).await.unwrap());
}

#[tokio::test]
async fn pending_snapshot_publish_discard_failure_keeps_cleanup_state_for_retry() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    let cow_file = snapshot_attempt_cow_file(&output.work_dir(), "pending-discard-retry");
    let attempt_dir = cow_file.parent().expect("attempt dir").to_path_buf();
    tokio::fs::create_dir_all(&cow_file)
        .await
        .expect("create cow path as directory");
    let bitmap_file = attempt_dir.join("cow.img.bitmap");
    tokio::fs::write(&bitmap_file, b"bitmap")
        .await
        .expect("write bitmap");
    let mut pending = FirecrackerPendingSnapshotPublish::new(
        output.snapshot_config("pending-discard-retry"),
        SnapshotOutputPaths::new(output.dir().to_path_buf()),
        KeptCow {
            cow_file: cow_file.clone(),
            bitmap_file: bitmap_file.clone(),
        },
    );

    pending
        .discard_inner()
        .await
        .expect_err("discard should fail when a temp artifact cannot be removed");

    assert!(
        !tokio::fs::try_exists(&bitmap_file).await.unwrap(),
        "failed discard should still remove cleanup work that succeeded"
    );
    assert!(
        tokio::fs::try_exists(&cow_file).await.unwrap(),
        "failed discard should leave the failed temp artifact for retry"
    );
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "failed discard must not publish marker"
    );

    tokio::fs::remove_dir(&cow_file)
        .await
        .expect("remove blocking cow directory");
    tokio::fs::write(&cow_file, b"cow")
        .await
        .expect("write retryable cow file");

    pending
        .discard_inner()
        .await
        .expect("retry should clean retained pending publish state");

    assert!(
        !tokio::fs::try_exists(attempt_dir).await.unwrap(),
        "retry should remove temporary attempt dir"
    );
    assert!(
        !tokio::fs::try_exists(output.cow()).await.unwrap(),
        "discard retry must not publish stable cow"
    );
    assert!(
        !tokio::fs::try_exists(output.cow_bitmap()).await.unwrap(),
        "discard retry must not publish stable cow bitmap"
    );
}

#[tokio::test]
async fn pending_snapshot_publish_discard_output_cleanup_failure_keeps_state_for_retry() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    tokio::fs::remove_file(output.snapshot())
        .await
        .expect("remove snapshot file");
    tokio::fs::create_dir(output.snapshot())
        .await
        .expect("replace snapshot file with directory");
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "pending-output-retry").await;
    let cow_file = kept_cow.cow_file.clone();
    let bitmap_file = kept_cow.bitmap_file.clone();
    let mut pending = FirecrackerPendingSnapshotPublish::new(
        output.snapshot_config("pending-output-retry"),
        SnapshotOutputPaths::new(output.dir().to_path_buf()),
        kept_cow,
    );

    pending
        .discard_inner()
        .await
        .expect_err("discard should fail when an output artifact cannot be removed");

    assert!(
        tokio::fs::metadata(output.snapshot())
            .await
            .expect("snapshot directory should remain")
            .is_dir(),
        "failed output cleanup should leave the blocking artifact for retry"
    );
    assert!(
        !tokio::fs::try_exists(&cow_file).await.unwrap(),
        "failed output cleanup should still remove temporary cow"
    );
    assert!(
        !tokio::fs::try_exists(&bitmap_file).await.unwrap(),
        "failed output cleanup should still remove temporary bitmap"
    );

    tokio::fs::remove_dir(output.snapshot())
        .await
        .expect("remove blocking snapshot directory");
    pending
        .discard_inner()
        .await
        .expect("retry should clean retained pending publish state");

    assert!(
        !tokio::fs::try_exists(output.snapshot()).await.unwrap(),
        "retry should leave no snapshot output"
    );
    assert!(
        !tokio::fs::try_exists(output.memory()).await.unwrap(),
        "retry should leave no memory output"
    );
    assert!(
        !tokio::fs::try_exists(output.work_dir()).await.unwrap(),
        "retry should leave no snapshot work dir"
    );
}

#[tokio::test]
async fn pending_snapshot_publish_drop_cleans_temp_without_publishing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "pending-drop").await;
    let attempt_dir = kept_cow
        .cow_file
        .parent()
        .expect("attempt dir")
        .to_path_buf();
    let cow_file = kept_cow.cow_file.clone();
    let bitmap_file = kept_cow.bitmap_file.clone();

    let pending = FirecrackerPendingSnapshotPublish::new(
        output.snapshot_config("pending-drop"),
        SnapshotOutputPaths::new(output.dir().to_path_buf()),
        kept_cow,
    );

    drop(pending);

    assert!(
        !tokio::fs::try_exists(&cow_file).await.unwrap(),
        "drop should cleanup temporary cow"
    );
    assert!(
        !tokio::fs::try_exists(&bitmap_file).await.unwrap(),
        "drop should cleanup temporary bitmap"
    );
    assert!(
        !tokio::fs::try_exists(attempt_dir).await.unwrap(),
        "drop should cleanup temporary attempt dir"
    );
    assert!(
        tokio::fs::try_exists(output.snapshot()).await.unwrap(),
        "drop must not cleanup stable snapshot output without the caller's lock"
    );
    assert!(
        tokio::fs::try_exists(output.memory()).await.unwrap(),
        "drop must not cleanup stable memory output without the caller's lock"
    );
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "drop must not write complete marker"
    );
    assert!(
        !tokio::fs::try_exists(output.cow()).await.unwrap(),
        "drop must not publish stable cow"
    );
}

#[tokio::test]
async fn snapshot_publish_commit_failure_does_not_leave_complete_marker() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    tokio::fs::create_dir_all(output.dir())
        .await
        .expect("create output dir");
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "missing-core-artifacts").await;

    let err = commit_snapshot_cow_output(&kept_cow, &output).expect_err("commit should fail");
    assert!(matches!(err, SnapshotError::Io(_)), "got: {err:?}");
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "failed publish must not leave complete marker"
    );

    let provider = FirecrackerSnapshotProvider;
    assert!(
        !provider.is_complete(output.dir()).await.unwrap(),
        "partial stable output without marker must remain incomplete"
    );
}

#[tokio::test]
async fn snapshot_publish_commit_failure_keeps_cleanup_state_for_partial_output() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    tokio::fs::create_dir_all(output.dir())
        .await
        .expect("create output dir");
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "commit-cleanup").await;
    let mut pending = FirecrackerPendingSnapshotPublish::new(
        output.snapshot_config("commit-cleanup"),
        SnapshotOutputPaths::new(output.dir().to_path_buf()),
        kept_cow,
    );

    let err = pending
        .commit_config()
        .await
        .expect_err("commit should fail without snapshot and memory artifacts");
    assert!(matches!(err, SnapshotError::Io(_)), "got: {err:?}");
    assert!(
        tokio::fs::try_exists(output.cow()).await.unwrap(),
        "failed marker publication may leave partial stable cow"
    );
    assert!(
        tokio::fs::try_exists(output.cow_bitmap()).await.unwrap(),
        "failed marker publication may leave partial stable bitmap"
    );

    pending
        .discard_inner()
        .await
        .expect("failed commit should keep cleanup state for discard");
    assert!(
        !tokio::fs::try_exists(output.cow()).await.unwrap(),
        "cleanup should remove partial stable cow after failed commit"
    );
    assert!(
        !tokio::fs::try_exists(output.cow_bitmap()).await.unwrap(),
        "cleanup should remove partial stable bitmap after failed commit"
    );
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "cleanup must not write marker for failed commit"
    );

    let provider = FirecrackerSnapshotProvider;
    assert!(
        !provider.is_complete(output.dir()).await.unwrap(),
        "partial stable output must remain incomplete"
    );
}

#[tokio::test]
async fn pending_snapshot_publish_discard_recovers_after_partial_bitmap_publish() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    tokio::fs::create_dir(output.cow())
        .await
        .expect("block cow rename with directory");
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "partial-bitmap").await;
    let cow_file = kept_cow.cow_file.clone();
    let bitmap_file = kept_cow.bitmap_file.clone();
    let mut pending = FirecrackerPendingSnapshotPublish::new(
        output.snapshot_config("partial-bitmap"),
        SnapshotOutputPaths::new(output.dir().to_path_buf()),
        kept_cow,
    );

    let err = pending
        .commit_config()
        .await
        .expect_err("commit should fail after publishing bitmap but before cow");
    assert!(matches!(err, SnapshotError::Io(_)), "got: {err:?}");
    assert!(
        tokio::fs::try_exists(output.cow_bitmap()).await.unwrap(),
        "failed commit should expose the partial stable bitmap"
    );
    assert!(
        !tokio::fs::try_exists(&bitmap_file).await.unwrap(),
        "bitmap rename should move the temp bitmap before commit fails"
    );

    pending
        .discard_inner()
        .await
        .expect_err("discard should keep state when blocking output cow directory remains");
    assert!(
        !tokio::fs::try_exists(output.cow_bitmap()).await.unwrap(),
        "discard should remove the partial stable bitmap"
    );
    assert!(
        !tokio::fs::try_exists(&cow_file).await.unwrap(),
        "discard should remove the remaining temp cow"
    );

    tokio::fs::remove_dir(output.cow())
        .await
        .expect("remove blocking cow directory");
    pending
        .discard_inner()
        .await
        .expect("retry should finish cleanup after blocking output is fixed");
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "failed commit cleanup must not publish marker"
    );
    assert!(
        !FirecrackerSnapshotProvider
            .is_complete(output.dir())
            .await
            .unwrap(),
        "partial bitmap publish must remain incomplete"
    );
}

#[tokio::test]
async fn snapshot_publish_cleanup_kept_cow_does_not_publish_stable_output() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "cleanup-kept").await;
    let mut publish_attempt = SnapshotPublishAttempt::new_with_kept_cow_for_test(kept_cow);

    assert!(publish_attempt.cleanup_after_cancellation().await);

    assert!(
        !tokio::fs::try_exists(output.cow()).await.unwrap(),
        "cancellation cleanup must not publish stable cow"
    );
    assert!(
        !tokio::fs::try_exists(output.cow_bitmap()).await.unwrap(),
        "cancellation cleanup must not publish stable bitmap"
    );
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "cancellation cleanup must not write complete marker"
    );

    let provider = FirecrackerSnapshotProvider;
    assert!(!provider.is_complete(output.dir()).await.unwrap());
}

#[tokio::test]
async fn snapshot_publish_cleanup_keeps_retry_state_when_temp_cleanup_fails() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    let cow_file = snapshot_attempt_cow_file(&output.work_dir(), "cleanup-retry");
    let attempt_dir = cow_file.parent().expect("attempt dir");
    tokio::fs::create_dir_all(&cow_file)
        .await
        .expect("create cow path as directory");
    let bitmap_file = attempt_dir.join("cow.img.bitmap");
    tokio::fs::write(&bitmap_file, b"bitmap")
        .await
        .expect("write bitmap");
    let mut publish_attempt = SnapshotPublishAttempt::new_with_kept_cow_for_test(KeptCow {
        cow_file,
        bitmap_file,
    });

    assert!(
        !publish_attempt.cleanup_after_cancellation().await,
        "cleanup should report failure when a temp artifact cannot be removed"
    );
    assert!(
        publish_attempt.has_cleanup_work(),
        "failed temp cleanup must retain publish state for a later retry"
    );
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "failed cleanup must not publish marker"
    );
}

#[tokio::test]
async fn snapshot_publish_cleanup_keep_cow_error_does_not_publish() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    let mut publish_attempt = SnapshotPublishAttempt::new_with_keep_future_for_test(async move {
        Err(nbd_cow::error::NbdCowError::Io(std::io::Error::other(
            "keep cow failed",
        )))
    });

    assert!(
        !publish_attempt.cleanup_after_cancellation().await,
        "keep-COW failure should report cleanup failure"
    );
    assert!(
        !publish_attempt.has_cleanup_work(),
        "failed keep-COW finalizer has already resolved the NBD lease path"
    );
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "failed keep-COW cleanup must not write marker"
    );

    let provider = FirecrackerSnapshotProvider;
    assert!(!provider.is_complete(output.dir()).await.unwrap());
}

#[tokio::test]
async fn snapshot_publish_cleanup_waits_for_keep_cow_without_committing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "pending-keep").await;
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (kept_tx, kept_rx) = tokio::sync::oneshot::channel();
    let mut publish_attempt = SnapshotPublishAttempt::new_with_keep_future_for_test(async move {
        let _ = started_tx.send(());
        kept_rx.await.map_err(|_| {
            nbd_cow::error::NbdCowError::Io(std::io::Error::other("test sender dropped"))
        })
    });

    let cleanup_task =
        tokio::spawn(async move { publish_attempt.cleanup_after_cancellation().await });
    started_rx
        .await
        .expect("keep-COW finalizer should be polled");
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "pending publish cleanup must not write marker before keep-COW resolves"
    );

    kept_tx.send(kept_cow).expect("send kept cow");
    assert!(
        cleanup_task.await.expect("cleanup task should join"),
        "cleanup should succeed after keep-COW resolves"
    );
    assert!(
        !tokio::fs::try_exists(output.cow()).await.unwrap(),
        "cleanup must not publish stable cow after keep-COW resolves"
    );
    assert!(
        !tokio::fs::try_exists(output.cow_bitmap()).await.unwrap(),
        "cleanup must not publish stable bitmap after keep-COW resolves"
    );
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "cleanup must not write complete marker after keep-COW resolves"
    );
}
