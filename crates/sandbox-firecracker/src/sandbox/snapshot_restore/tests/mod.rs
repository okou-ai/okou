use super::*;

#[test]
fn mountinfo_contains_exact_snapshot_drive_bind_target() {
    let mountinfo = b"\
36 25 0:32 / /tmp/snapshot-work/cow-device-bind rw,relatime - ext4 /dev/nbd0 rw
37 25 0:33 / /tmp/snapshot-work rw,relatime - ext4 /dev/root rw
";

    assert!(mountinfo_contains_mount_point(
        mountinfo,
        std::path::Path::new("/tmp/snapshot-work/cow-device-bind"),
    ));
    assert!(!mountinfo_contains_mount_point(
        mountinfo,
        std::path::Path::new("/tmp/snapshot-work/cow"),
    ));
}

#[test]
fn mountinfo_decodes_escaped_mount_point_path() {
    let mountinfo =
        br"36 25 0:32 / /tmp/vm0\040snapshot/cow-device-bind rw,relatime - ext4 /dev/nbd0 rw";

    assert!(mountinfo_contains_mount_point(
        mountinfo,
        std::path::Path::new("/tmp/vm0 snapshot/cow-device-bind"),
    ));
}

#[test]
fn mountinfo_recognizes_complete_paths_with_unicode_whitespace() {
    for whitespace in ['\u{a0}', '\u{85}', '\u{2003}', '\u{2028}'] {
        for target in ["/tmp/ascii".to_owned(), format!("/tmp/a{whitespace}b")] {
            let mountinfo =
                format!("36 25 0:32 /root{whitespace}dir {target} rw - ext4 /dev/nbd0 rw");

            assert!(mountinfo_contains_mount_point(
                mountinfo.as_bytes(),
                Path::new(&target),
            ));
            assert!(!mountinfo_contains_mount_point(
                mountinfo.as_bytes(),
                Path::new("/tmp/a"),
            ));
        }
    }
}

#[test]
fn mountinfo_preserves_byte_paths_and_skips_malformed_records() {
    let mountinfo = b"malformed\n\
36 25 0:32 /root/\xff /tmp/a\xfe rw - ext4 /dev/nbd0 rw\n\
37 25 0:33 / /tmp/ascii rw - ext4 /dev/nbd1 rw";

    assert!(mountinfo_contains_mount_point(
        mountinfo,
        Path::new(OsStr::from_bytes(b"/tmp/a\xfe")),
    ));
    assert!(mountinfo_contains_mount_point(
        mountinfo,
        Path::new("/tmp/ascii"),
    ));
    assert!(!mountinfo_contains_mount_point(
        mountinfo,
        Path::new("/tmp/a"),
    ));
}

#[test]
fn normal_temp_bind_target_is_not_a_mount_point() {
    let dir = tempfile::tempdir().unwrap();
    let bind_target = dir.path().join("cow-device-bind");
    std::fs::write(&bind_target, b"").unwrap();

    assert!(!snapshot_drive_bind_target_is_mount_point(&bind_target).unwrap());
}

#[tokio::test]
async fn snapshot_drive_bind_target_rejects_existing_directory() {
    let dir = tempfile::tempdir().unwrap();
    let bind_target = dir.path().join("cow-device-bind");
    tokio::fs::create_dir(&bind_target).await.unwrap();

    let result = ensure_snapshot_drive_bind_target(&bind_target).await;

    assert!(
        matches!(result, Err(SandboxError::Start { message }) if message.contains("not a regular file"))
    );
}

#[tokio::test]
async fn snapshot_drive_bind_target_rejects_existing_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    let bind_target = dir.path().join("cow-device-bind");
    tokio::fs::write(&target, b"").await.unwrap();
    std::os::unix::fs::symlink(&target, &bind_target).unwrap();

    let result = ensure_snapshot_drive_bind_target(&bind_target).await;

    assert!(
        matches!(result, Err(SandboxError::Start { message }) if message.contains("not a regular file"))
    );
}

#[tokio::test]
async fn snapshot_drive_bind_target_rejects_existing_socket() {
    let dir = tempfile::tempdir().unwrap();
    let bind_target = dir.path().join("cow-device-bind");
    let _socket = std::os::unix::net::UnixListener::bind(&bind_target).unwrap();

    let result = ensure_snapshot_drive_bind_target(&bind_target).await;

    assert!(
        matches!(result, Err(SandboxError::Start { message }) if message.contains("not a regular file"))
    );
}

#[tokio::test]
async fn snapshot_drive_bind_target_creates_missing_file_and_parent() {
    let dir = tempfile::tempdir().unwrap();
    let bind_target = dir.path().join("snapshot-work").join("cow-device-bind");

    ensure_snapshot_drive_bind_target(&bind_target)
        .await
        .unwrap();

    let meta = tokio::fs::symlink_metadata(&bind_target).await.unwrap();
    assert!(meta.file_type().is_file());
}

#[tokio::test]
async fn snapshot_drive_bind_target_allows_concurrent_first_use() {
    let dir = tempfile::tempdir().unwrap();
    let bind_target = dir.path().join("snapshot-work").join("cow-device-bind");
    let left = bind_target.clone();
    let right = bind_target.clone();

    let (left_result, right_result) = tokio::join!(
        ensure_snapshot_drive_bind_target(&left),
        ensure_snapshot_drive_bind_target(&right),
    );

    left_result.unwrap();
    right_result.unwrap();
    let meta = tokio::fs::symlink_metadata(&bind_target).await.unwrap();
    assert!(meta.file_type().is_file());
}

#[tokio::test]
async fn snapshot_drive_bind_target_allows_concurrent_stale_mount_cleanup() {
    use std::os::unix::fs::MetadataExt;

    let dir = tempfile::tempdir().unwrap();
    let bind_target = dir.path().join("cow-device-bind");
    let backing_file = dir.path().join("underlying-target");
    tokio::fs::write(&backing_file, b"existing target")
        .await
        .unwrap();
    let before = tokio::fs::symlink_metadata(&backing_file).await.unwrap();
    let _socket = std::os::unix::net::UnixListener::bind(&bind_target).unwrap();
    let (observed_tx, observed_rx) = tokio::sync::oneshot::channel();
    let (cleaned_tx, cleaned_rx) = tokio::sync::oneshot::channel();
    let mut observation_gate = Some((observed_tx, cleaned_rx));

    // A real stale device mount requires privileged infrastructure. Model
    // its removal at the OS metadata boundary, retaining the backing inode
    // and using real creation, mountinfo, and final metadata checks.
    let stale_restore =
        ensure_snapshot_drive_bind_target_with_metadata(&bind_target, async |path: &Path| {
            let metadata = tokio::fs::symlink_metadata(path).await?;
            if let Some((observed_tx, cleaned_rx)) = observation_gate.take() {
                assert!(!metadata.file_type().is_file());
                observed_tx.send(()).unwrap();
                cleaned_rx.await.unwrap();
            }
            Ok(metadata)
        });
    let peer_restore = async {
        observed_rx.await.unwrap();
        tokio::fs::remove_file(&bind_target).await.unwrap();
        tokio::fs::rename(&backing_file, &bind_target)
            .await
            .unwrap();
        let result = ensure_snapshot_drive_bind_target(&bind_target).await;
        cleaned_tx.send(()).unwrap();
        result
    };

    let (stale_result, peer_result) =
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(stale_restore, peer_restore)
        })
        .await
        .unwrap();

    peer_result.unwrap();
    stale_result.unwrap();
    let after = tokio::fs::symlink_metadata(&bind_target).await.unwrap();
    assert!(after.file_type().is_file());
    assert_eq!(before.dev(), after.dev());
    assert_eq!(before.ino(), after.ino());
    assert_eq!(
        tokio::fs::read(&bind_target).await.unwrap(),
        b"existing target",
    );
}

#[tokio::test]
async fn snapshot_drive_bind_target_allows_existing_file() {
    use std::os::unix::fs::MetadataExt;

    let dir = tempfile::tempdir().unwrap();
    let bind_target = dir.path().join("cow-device-bind");
    tokio::fs::write(&bind_target, b"existing target")
        .await
        .unwrap();
    let before = tokio::fs::symlink_metadata(&bind_target).await.unwrap();

    ensure_snapshot_drive_bind_target(&bind_target)
        .await
        .unwrap();

    let after = tokio::fs::symlink_metadata(&bind_target).await.unwrap();
    assert_eq!(
        before.ino(),
        after.ino(),
        "existing bind target must not be replaced"
    );
    assert_eq!(
        tokio::fs::read(&bind_target).await.unwrap(),
        b"existing target",
        "existing bind target must not be truncated"
    );
}
