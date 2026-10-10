use std::os::unix::fs::symlink;
use std::path::Path;
use std::time::Duration;

use nbd_cow::KeptCow;
use nbd_cow::pool::DevicePoolHandle;

use crate::api::ApiError;
use crate::paths::{SandboxPaths, SnapshotOutputPaths, SockPaths};
use crate::snapshot::cow::{snapshot_attempt_cow_file, snapshot_attempt_home_image_file};
use crate::snapshot::publish::SnapshotPublishAttempt;

use super::cleanup::{AttemptHomeImage, SnapshotCleanupPresence, SnapshotCleanupReport};

use super::*;

mod early_setup;

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
async fn snapshot_cleanup_resources_presence_tracks_all_handoff_resources() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut attempt, _sock_dir) = snapshot_attempt_for_test(&dir);
    let kept_cow = write_kept_cow_for_test(&attempt.output().work_dir(), "presence-summary").await;
    let (tx, rx) = tokio::sync::oneshot::channel();

    attempt.track_publish_attempt_for_test(SnapshotPublishAttempt::new_with_kept_cow_for_test(
        kept_cow,
    ));
    attempt.track_device_pool_for_test(DevicePoolHandle::new(
        nbd_cow::pool::DevicePoolConfig::default(),
    ));
    attempt.track_network_for_test("test-snapshot-presence");
    attempt.track_child_for_test(long_running_child_for_test());
    attempt.track_stdout_handle_for_test(tokio::spawn(std::future::pending::<()>()));
    attempt.track_stderr_handle_for_test(tokio::spawn(std::future::pending::<()>()));

    assert_eq!(
        attempt.cleanup_resources.presence(),
        SnapshotCleanupPresence {
            has_device_pool: true,
            has_netns_pool: true,
            has_cow_device: false,
            has_home_image: false,
            has_publish_attempt: true,
            has_network: true,
            has_child: true,
            has_stdout_forwarder: true,
            has_stderr_forwarder: true,
        }
    );
    assert!(attempt.cleanup_resources.has_cleanup_work());

    attempt.notify_cleanup_complete_for_test(tx);
    drop(attempt);
    let report = wait_for_snapshot_cleanup(rx).await;

    assert!(report.child_reaped);
    assert!(report.stdout_forwarder_finished);
    assert!(report.stderr_forwarder_finished);
    assert!(report.network_released);
    assert!(report.publish_cleaned);
    assert!(report.home_image_cleaned);
    assert!(report.device_pool_cleaned);
    assert!(report.netns_pool_cleaned);
}

#[tokio::test]
async fn snapshot_cleanup_finalizer_resolves_publish_before_device_pool_cleanup() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut attempt, _sock_dir) = snapshot_attempt_for_test(&dir);
    let kept_cow =
        write_kept_cow_for_test(&attempt.output().work_dir(), "publish-before-device-pool").await;
    let (tx, rx) = tokio::sync::oneshot::channel();

    attempt.track_publish_attempt_for_test(SnapshotPublishAttempt::new_with_kept_cow_for_test(
        kept_cow,
    ));
    attempt.track_device_pool_for_test(DevicePoolHandle::new(
        nbd_cow::pool::DevicePoolConfig::default(),
    ));
    attempt.notify_cleanup_complete_for_test(tx);

    drop(attempt);
    let report = wait_for_snapshot_cleanup(rx).await;

    assert!(report.publish_cleaned);
    assert!(report.device_pool_cleaned);
    assert_eq!(
        report.cleanup_events,
        vec!["publish", "device_pool"],
        "publish cleanup must finish before device pool cleanup"
    );
}

#[tokio::test]
async fn snapshot_cleanup_finalizer_removes_home_image() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut attempt, _sock_dir) = snapshot_attempt_for_test(&dir);
    let home_image = snapshot_attempt_home_image_file(attempt.paths().workspace(), "default-test");
    let (tx, rx) = tokio::sync::oneshot::channel();

    tokio::fs::create_dir_all(home_image.parent().expect("home image parent"))
        .await
        .expect("create home image parent");
    tokio::fs::write(&home_image, b"home")
        .await
        .expect("write home image");
    attempt.track_home_image_for_test(home_image.clone());
    attempt.notify_cleanup_complete_for_test(tx);

    drop(attempt);
    let report = wait_for_snapshot_cleanup(rx).await;

    assert!(report.home_image_cleaned);
    assert_eq!(report.cleanup_events, vec!["home_image"]);
    assert!(
        !tokio::fs::try_exists(&home_image).await.unwrap(),
        "detached cleanup should remove temporary home image"
    );
    assert!(
        !tokio::fs::try_exists(home_image.parent().expect("home image parent"))
            .await
            .unwrap(),
        "detached cleanup should remove the empty attempt dir"
    );
}

#[tokio::test]
async fn snapshot_home_image_cleanup_preserves_nonempty_attempt_dir() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut attempt, _sock_dir) = snapshot_attempt_for_test(&dir);
    let home_image = snapshot_attempt_home_image_file(attempt.paths().workspace(), "default-test");
    let attempt_dir = home_image
        .parent()
        .expect("home image parent")
        .to_path_buf();
    let cow_file = attempt_dir.join("cow.img");

    tokio::fs::create_dir_all(&attempt_dir)
        .await
        .expect("create attempt dir");
    tokio::fs::write(&home_image, b"home")
        .await
        .expect("write home image");
    tokio::fs::write(&cow_file, b"cow")
        .await
        .expect("write cow");
    attempt.track_home_image_for_test(home_image.clone());

    assert!(
        attempt
            .cleanup_resources
            .cleanup_home_image("failed to cleanup home image in test")
    );

    assert!(
        !tokio::fs::try_exists(&home_image).await.unwrap(),
        "home image should be removed"
    );
    assert!(
        tokio::fs::try_exists(&attempt_dir).await.unwrap(),
        "attempt dir must remain while COW artifacts still exist"
    );
    assert_eq!(
        tokio::fs::read(&cow_file).await.unwrap(),
        b"cow",
        "cleanup must not remove unrelated attempt files"
    );
}

#[tokio::test]
async fn snapshot_setup_error_cleanup_removes_home_image_inline() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut attempt, _sock_dir) = snapshot_attempt_for_test(&dir);
    let home_image = snapshot_attempt_home_image_file(attempt.paths().workspace(), "default-test");

    tokio::fs::create_dir_all(home_image.parent().expect("home image parent"))
        .await
        .expect("create home image parent");
    tokio::fs::write(&home_image, b"home")
        .await
        .expect("write home image");
    attempt.track_home_image_for_test(home_image.clone());

    attempt
        .cleanup_resources
        .destroy_cow_after_setup_error("test setup error")
        .await;

    assert!(matches!(
        attempt.cleanup_resources.home_image,
        AttemptHomeImage::Cleaned
    ));
    assert!(
        !tokio::fs::try_exists(&home_image).await.unwrap(),
        "setup error cleanup should remove temporary home image inline"
    );
}

#[tokio::test]
async fn snapshot_cleanup_finalizer_removes_attempt_dir_after_workspace_and_publish_cleanup() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    let paths = SandboxPaths::new(output.work_dir());
    let sock_paths = SockPaths::new(dir.path().join("sock"));
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "shared-attempt").await;
    let attempt_dir = kept_cow
        .cow_file
        .parent()
        .expect("attempt dir")
        .to_path_buf();
    let home_image = attempt_dir.join("home.ext4");
    let (tx, rx) = tokio::sync::oneshot::channel();

    tokio::fs::write(&home_image, b"home")
        .await
        .expect("write home image");
    let mut attempt =
        SnapshotAttempt::new_without_cow_for_test(paths, sock_paths, output, home_image.clone());
    attempt.track_home_image_for_test(home_image);
    attempt.track_publish_attempt_for_test(SnapshotPublishAttempt::new_with_kept_cow_for_test(
        kept_cow,
    ));
    attempt.notify_cleanup_complete_for_test(tx);

    drop(attempt);
    let report = wait_for_snapshot_cleanup(rx).await;

    assert!(report.home_image_cleaned);
    assert!(report.publish_cleaned);
    assert_eq!(
        report.cleanup_events,
        vec!["home_image", "publish"],
        "home image must be removed before COW publish cleanup removes the attempt dir"
    );
    assert!(
        !tokio::fs::try_exists(&attempt_dir).await.unwrap(),
        "attempt dir should be removed after home image and kept COW cleanup"
    );
}

#[tokio::test]
async fn snapshot_attempt_drop_handoff_cleans_publish_resolve_cancellation() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut attempt, _sock_dir) = snapshot_attempt_for_test(&dir);
    write_required_snapshot_artifacts(attempt.output()).await;
    let kept_cow = write_kept_cow_for_test(&attempt.output().work_dir(), "cancel-resolve").await;
    let cow_file = kept_cow.cow_file.clone();
    let bitmap_file = kept_cow.bitmap_file.clone();
    let output_dir = attempt.output().dir().to_path_buf();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (kept_tx, kept_rx) = tokio::sync::oneshot::channel();
    let (cleanup_tx, cleanup_rx) = tokio::sync::oneshot::channel();

    attempt.track_publish_attempt_for_test(SnapshotPublishAttempt::new_with_keep_future_for_test(
        async move {
            let _ = started_tx.send(());
            kept_rx.await.map_err(|_| {
                nbd_cow::error::NbdCowError::Io(std::io::Error::other("test sender dropped"))
            })
        },
    ));
    attempt.notify_cleanup_complete_for_test(cleanup_tx);

    let handle =
        tokio::spawn(async move { attempt.cleanup_resources.resolve_success_publish().await });
    started_rx
        .await
        .expect("keep-COW finalizer should be polled");
    handle.abort();
    let _ = handle.await;

    kept_tx.send(kept_cow).expect("send kept cow");
    let report = wait_for_snapshot_cleanup(cleanup_rx).await;
    let output = SnapshotOutputPaths::new(output_dir);

    assert!(report.publish_cleaned);
    assert!(
        !tokio::fs::try_exists(&cow_file).await.unwrap(),
        "cancellation cleanup should remove temporary cow"
    );
    assert!(
        !tokio::fs::try_exists(&bitmap_file).await.unwrap(),
        "cancellation cleanup should remove temporary bitmap"
    );
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "cancellation cleanup must not publish complete marker"
    );
}

#[tokio::test]
async fn cleanup_existing_snapshot_sock_dir_removes_existing_dir() {
    let dir = tempfile::tempdir().expect("tempdir");
    let sock_dir = dir.path().join("sock");
    let stale_socket = sock_dir.join("api.sock");

    tokio::fs::create_dir_all(&sock_dir)
        .await
        .expect("create sock dir");
    tokio::fs::write(&stale_socket, b"stale")
        .await
        .expect("write stale socket placeholder");

    cleanup_existing_snapshot_sock_dir(&sock_dir).await;

    assert!(
        !tokio::fs::try_exists(&sock_dir).await.unwrap(),
        "stale socket directory should be removed"
    );

    cleanup_existing_snapshot_sock_dir(&sock_dir).await;
}

#[tokio::test]
async fn snapshot_attempt_prepare_firecracker_files_rejects_socket_symlink() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut attempt, sock_dir) = snapshot_attempt_for_test(&dir);
    let target = dir.path().join("target");
    std::fs::create_dir(&target).expect("create symlink target");
    symlink(&target, &sock_dir).expect("create sock symlink");
    let config = SnapshotCreateConfig {
        id: "snapshot-attempt-test".into(),
        binary_path: dir.path().join("firecracker"),
        kernel_path: dir.path().join("vmlinux"),
        rootfs_path: dir.path().join("rootfs.ext4"),
        output_dir: dir.path().join("output"),
        vcpu_count: 2,
        memory_mb: 512,
        home_disk_mb: 1024,
    };

    let err = attempt
        .prepare_firecracker_files(&config)
        .await
        .expect_err("prepare firecracker files should reject sock symlink");

    let message = err.to_string();
    assert!(message.contains("prepare sock dir"), "got: {message}");
    assert!(message.contains("is a symlink"), "got: {message}");
    assert!(target.is_dir());
}

#[tokio::test]
async fn snapshot_attempt_routes_socket_cleanup_through_owner() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    let paths = SandboxPaths::new(output.work_dir());
    let sock_dir = dir.path().join("sock");
    let sock_paths = SockPaths::new(sock_dir.clone());
    let stale_socket = sock_dir.join("api.sock");
    let home_image = snapshot_attempt_home_image_file(paths.workspace(), "socket-cleanup-test");
    let mut attempt =
        SnapshotAttempt::new_without_cow_for_test(paths, sock_paths, output, home_image);

    tokio::fs::create_dir_all(&sock_dir)
        .await
        .expect("create sock dir");
    tokio::fs::write(&stale_socket, b"stale")
        .await
        .expect("write stale socket placeholder");

    attempt.cleanup_sock_dir().await;
    attempt.cleanup_netns_pool().await;

    assert!(
        !tokio::fs::try_exists(&sock_dir).await.unwrap(),
        "snapshot attempt should own runtime socket cleanup"
    );
}

fn snapshot_attempt_for_test(dir: &tempfile::TempDir) -> (SnapshotAttempt, std::path::PathBuf) {
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    let paths = SandboxPaths::new(output.work_dir());
    let sock_dir = dir.path().join("sock");
    let sock_paths = SockPaths::new(sock_dir.clone());
    let home_image = snapshot_attempt_home_image_file(paths.workspace(), "default-test");
    (
        SnapshotAttempt::new_without_cow_for_test(paths, sock_paths, output, home_image),
        sock_dir,
    )
}

async fn wait_for_snapshot_cleanup(
    rx: tokio::sync::oneshot::Receiver<SnapshotCleanupReport>,
) -> SnapshotCleanupReport {
    tokio::time::timeout(Duration::from_secs(5), rx)
        .await
        .expect("snapshot cleanup finalizer should complete")
        .expect("snapshot cleanup finalizer should report completion")
}

fn long_running_child_for_test() -> tokio::process::Child {
    tokio::process::Command::new("sh")
        .arg("-c")
        .arg("while true; do sleep 60; done")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .expect("spawn long-running child")
}

async fn exited_child_for_test() -> tokio::process::Child {
    let mut child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg("exit 1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .expect("spawn exiting child");
    let status = child.wait().await.expect("wait for exiting child");
    assert!(!status.success(), "test child should exit unsuccessfully");
    child
}

#[tokio::test]
async fn snapshot_attempt_drop_handoff_releases_netns_without_unlocked_sock_cleanup() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut attempt, sock_dir) = snapshot_attempt_for_test(&dir);
    let (tx, rx) = tokio::sync::oneshot::channel();

    attempt.track_network_for_test("test-snapshot-netns");
    attempt.notify_cleanup_complete_for_test(tx);
    tokio::fs::create_dir_all(&sock_dir)
        .await
        .expect("create sock dir");

    drop(attempt);
    let report = wait_for_snapshot_cleanup(rx).await;

    assert!(report.network_released);
    assert!(report.netns_pool_cleaned);
    assert!(
        tokio::fs::try_exists(&sock_dir).await.unwrap(),
        "detached cleanup must not remove the stable snapshot socket directory without the outer snapshot lock"
    );
}

#[tokio::test]
async fn snapshot_attempt_drop_handoff_reaps_child_before_netns_release() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut attempt, sock_dir) = snapshot_attempt_for_test(&dir);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let child = long_running_child_for_test();

    attempt.track_network_for_test("test-snapshot-netns-child");
    attempt.track_child_for_test(child);
    attempt.notify_cleanup_complete_for_test(tx);
    tokio::fs::create_dir_all(&sock_dir)
        .await
        .expect("create sock dir");

    drop(attempt);
    let report = wait_for_snapshot_cleanup(rx).await;

    assert!(report.child_reaped);
    assert!(report.network_released);
    assert_eq!(
        report.cleanup_events,
        vec!["child_reaped", "network_release_started"],
        "child reaping must finish before network release starts"
    );
    assert!(
        tokio::fs::try_exists(&sock_dir).await.unwrap(),
        "detached cleanup must not remove the stable snapshot socket directory without the outer snapshot lock"
    );
}

#[tokio::test]
async fn snapshot_attempt_cancelled_finish_hands_complete_process_to_finalizer() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut attempt, _sock_dir) = snapshot_attempt_for_test(&dir);

    attempt.track_child_for_test(exited_child_for_test().await);
    attempt.track_stderr_handle_for_test(tokio::spawn(std::future::pending::<()>()));

    {
        let finish = attempt.finish_runtime_after_workflow(Err(SnapshotError::Api(
            ApiError::Other("timeout".into()),
        )));
        tokio::pin!(finish);
        assert!(
            futures_util::poll!(finish.as_mut()).is_pending(),
            "explicit finish should wait for the stderr forwarder"
        );
    }

    let presence = attempt.cleanup_resources.presence();
    assert!(
        presence.has_child,
        "cancelled finish must retain the child owner"
    );
    assert!(
        presence.has_stderr_forwarder,
        "cancelled finish must retain the stderr forwarder"
    );

    let (tx, rx) = tokio::sync::oneshot::channel();
    attempt.notify_cleanup_complete_for_test(tx);
    drop(attempt);
    let report = wait_for_snapshot_cleanup(rx).await;

    assert!(report.child_reaped);
    assert!(report.stderr_forwarder_finished);
}

#[tokio::test]
async fn snapshot_attempt_drop_handoff_aborts_unfinished_forwarders() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut attempt, sock_dir) = snapshot_attempt_for_test(&dir);
    let (tx, rx) = tokio::sync::oneshot::channel();

    attempt.track_stdout_handle_for_test(tokio::spawn(std::future::pending::<()>()));
    attempt.track_stderr_handle_for_test(tokio::spawn(std::future::pending::<()>()));
    attempt.notify_cleanup_complete_for_test(tx);
    tokio::fs::create_dir_all(&sock_dir)
        .await
        .expect("create sock dir");

    drop(attempt);
    let report = wait_for_snapshot_cleanup(rx).await;

    assert!(report.stdout_forwarder_finished);
    assert!(report.stderr_forwarder_finished);
    assert!(
        tokio::fs::try_exists(&sock_dir).await.unwrap(),
        "detached cleanup must not remove the stable snapshot socket directory without the outer snapshot lock"
    );
}
