use super::*;

#[tokio::test]
async fn create_uncommitted_snapshot_rejects_invalid_socket_id_before_output_cleanup() {
    let tmp = tempfile::tempdir().unwrap();
    let output_dir = tmp.path().join("output");
    tokio::fs::create_dir_all(&output_dir).await.unwrap();
    let sentinel = output_dir.join("keep.txt");
    tokio::fs::write(&sentinel, b"keep").await.unwrap();

    let result = create_uncommitted_snapshot(SnapshotCreateConfig {
        id: "../snapshot".into(),
        binary_path: tmp.path().join("firecracker"),
        kernel_path: tmp.path().join("vmlinux"),
        rootfs_path: tmp.path().join("rootfs.ext4"),
        output_dir,
        vcpu_count: 2,
        memory_mb: 512,
        home_disk_mb: 1024,
    })
    .await;

    match result {
        Ok(_) => panic!("expected invalid socket id to fail"),
        Err(SnapshotError::Setup(message)) => {
            assert!(message.contains("snapshot socket id"), "got: {message}");
            assert!(
                message.contains("runtime socket id must be"),
                "got: {message}"
            );
        }
        Err(other) => panic!("expected setup error, got {other:?}"),
    }
    assert!(sentinel.exists());
}

#[tokio::test]
async fn create_uncommitted_snapshot_rejects_overlong_listener_before_output_cleanup() {
    let tmp = tempfile::tempdir().unwrap();
    let output_dir = tmp.path().join("output");
    tokio::fs::create_dir_all(&output_dir).await.unwrap();
    let sentinel = output_dir.join("keep.txt");
    tokio::fs::write(&sentinel, b"keep").await.unwrap();

    let result = create_uncommitted_snapshot(SnapshotCreateConfig {
        id: "a".repeat(71),
        binary_path: tmp.path().join("firecracker"),
        kernel_path: tmp.path().join("vmlinux"),
        rootfs_path: tmp.path().join("rootfs.ext4"),
        output_dir,
        vcpu_count: 2,
        memory_mb: 512,
        home_disk_mb: 1024,
    })
    .await;

    match result {
        Ok(_) => panic!("expected overlong listener to fail"),
        Err(SnapshotError::Setup(message)) => {
            assert!(
                message.contains("vsock listener path too long"),
                "got: {message}"
            );
        }
        Err(other) => panic!("expected setup error, got {other:?}"),
    }
    assert!(sentinel.exists());
}
