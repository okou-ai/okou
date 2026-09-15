use std::ffi::OsStr;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use sandbox::SandboxError;
use tracing::info;

use crate::api::ApiClient;
use crate::boot_config::{ROOTFS_DRIVE_ID, WORKSPACE_DRIVE_ID, nonzero_drive_count};
use crate::config::FirecrackerDeviceRateLimits;
use crate::factory::InvariantConfig;

pub(super) async fn load_snapshot_and_apply_rate_limits(
    client: &ApiClient,
    snapshot_path: &str,
    memory_path: &str,
    rate_limits: Option<&FirecrackerDeviceRateLimits>,
) -> sandbox::Result<()> {
    // Keep the default restore path unchanged. Only hold the VM paused
    // when rate limiters must be patched before guest execution resumes.
    client
        .load_snapshot(snapshot_path, memory_path, rate_limits.is_none())
        .await
        .map_err(|e| SandboxError::Start {
            message: format!("snapshot load failed: {e}"),
        })?;
    if let Some(rate_limits) = rate_limits {
        let drive_rate_limiter = rate_limits
            .block_drive_limiter(
                nonzero_drive_count([ROOTFS_DRIVE_ID, WORKSPACE_DRIVE_ID].len())
                    .map_err(|error| SandboxError::Start { message: error })?,
            )
            .map_err(|e| SandboxError::Start {
                message: format!("build snapshot drive rate limiter: {e}"),
            })?;
        client
            .patch_drive_rate_limiter(ROOTFS_DRIVE_ID, &drive_rate_limiter)
            .await
            .map_err(|e| SandboxError::Start {
                message: format!("snapshot drive rate limiter patch failed: {e}"),
            })?;
        client
            .patch_drive_rate_limiter(WORKSPACE_DRIVE_ID, &drive_rate_limiter)
            .await
            .map_err(|e| SandboxError::Start {
                message: format!("snapshot workspace drive rate limiter patch failed: {e}"),
            })?;
        let inv = InvariantConfig::new();
        client
            .patch_network_rate_limiters(inv.iface_id, &rate_limits.net_rx, &rate_limits.net_tx)
            .await
            .map_err(|e| SandboxError::Start {
                message: format!("snapshot network rate limiter patch failed: {e}"),
            })?;
        client.resume().await.map_err(|e| SandboxError::Start {
            message: format!("snapshot resume failed: {e}"),
        })?;
    }

    Ok(())
}

pub(super) async fn ensure_snapshot_drive_bind_target(path: &Path) -> Result<(), SandboxError> {
    ensure_snapshot_drive_bind_target_with_metadata(path, async |path: &Path| {
        tokio::fs::symlink_metadata(path).await
    })
    .await
}

async fn ensure_snapshot_drive_bind_target_with_metadata(
    path: &Path,
    mut read_metadata: impl AsyncFnMut(&Path) -> io::Result<std::fs::Metadata>,
) -> Result<(), SandboxError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| SandboxError::Start {
                message: format!("mkdir snapshot drive: {e}"),
            })?;
    }

    if create_snapshot_drive_bind_target_file(path).await? {
        return Ok(());
    }

    if snapshot_drive_bind_target_is_regular_file(path, &mut read_metadata).await? {
        return Ok(());
    }

    if snapshot_drive_bind_target_is_mount_point(path)? {
        unmount_snapshot_drive_bind_target(path).await?;
        if create_snapshot_drive_bind_target_file(path).await? {
            return Ok(());
        }
    }

    // Another restore may clear the mount after our first metadata read but
    // before the mountinfo read. Revalidate even when no mount was observed.
    if snapshot_drive_bind_target_is_regular_file(path, &mut read_metadata).await? {
        return Ok(());
    }

    Err(SandboxError::Start {
        message: format!(
            "snapshot drive bind target is not a regular file: {}",
            path.display()
        ),
    })
}

async fn create_snapshot_drive_bind_target_file(path: &Path) -> Result<bool, SandboxError> {
    match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
    {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(SandboxError::Start {
            message: format!("create snapshot drive bind target: {e}"),
        }),
    }
}

async fn snapshot_drive_bind_target_is_regular_file(
    path: &Path,
    read_metadata: &mut impl AsyncFnMut(&Path) -> io::Result<std::fs::Metadata>,
) -> Result<bool, SandboxError> {
    let meta = read_metadata(path).await.map_err(|e| SandboxError::Start {
        message: format!("stat snapshot drive bind target: {e}"),
    })?;
    Ok(meta.file_type().is_file())
}

fn snapshot_drive_bind_target_is_mount_point(path: &Path) -> Result<bool, SandboxError> {
    let path =
        absolute_path_without_following_final_symlink(path).map_err(|e| SandboxError::Start {
            message: format!("resolve snapshot drive bind target path: {e}"),
        })?;
    let mountinfo = std::fs::read("/proc/self/mountinfo").map_err(|e| SandboxError::Start {
        message: format!("read /proc/self/mountinfo: {e}"),
    })?;
    Ok(mountinfo_contains_mount_point(&mountinfo, &path))
}

fn absolute_path_without_following_final_symlink(path: &Path) -> io::Result<std::path::PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn mountinfo_contains_mount_point(mountinfo: &[u8], path: &Path) -> bool {
    linux_mountinfo::parse(mountinfo)
        .filter_map(Result::ok)
        .any(|mount| Path::new(OsStr::from_bytes(&mount.target)) == path)
}

async fn unmount_snapshot_drive_bind_target(path: &Path) -> Result<(), SandboxError> {
    let output = tokio::process::Command::new("umount")
        .arg(path)
        .output()
        .await
        .map_err(|e| SandboxError::Start {
            message: format!("spawn umount for snapshot drive bind target: {e}"),
        })?;

    if output.status.success() || !snapshot_drive_bind_target_is_mount_point(path)? {
        if output.status.success() {
            info!(
                path = %path.display(),
                "cleared stale snapshot drive bind target mount"
            );
        }
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(SandboxError::Start {
        message: format!(
            "umount stale snapshot drive bind target {}: {}",
            path.display(),
            stderr.trim()
        ),
    })
}

#[cfg(test)]
mod tests {
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
}
