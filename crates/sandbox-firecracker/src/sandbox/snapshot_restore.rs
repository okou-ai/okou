use std::ffi::OsStr;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use sandbox::SandboxError;
use tracing::info;

use crate::api::ApiClient;
use crate::boot_config::{HOME_DRIVE_ID, ROOTFS_DRIVE_ID, nonzero_drive_count};
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
                nonzero_drive_count([ROOTFS_DRIVE_ID, HOME_DRIVE_ID].len())
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
            .patch_drive_rate_limiter(HOME_DRIVE_ID, &drive_rate_limiter)
            .await
            .map_err(|e| SandboxError::Start {
                message: format!("snapshot home drive rate limiter patch failed: {e}"),
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
mod tests;
