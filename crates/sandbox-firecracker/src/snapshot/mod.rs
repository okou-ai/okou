mod attempt;
mod cow;
mod error;
mod output;
mod provider;
mod publish;
mod runtime;

pub use error::SnapshotError;
pub use output::{
    SNAPSHOT_COMPLETE_MARKER_CONTENT, SnapshotOutputValidation, validate_snapshot_output,
};
pub use provider::FirecrackerSnapshotProvider;

use sandbox::SnapshotCreateConfig;
use tracing::info;

use crate::config::SnapshotConfig;
use crate::network::{NetnsPool, NetnsPoolConfig};
use crate::paths::{RuntimePaths, SandboxPaths, SnapshotOutputPaths, SockPaths};
use crate::prerequisites;
use crate::runtime_dirs::checked_runtime_sock_dir;

use self::attempt::{SnapshotAttempt, cleanup_existing_snapshot_sock_dir};
use self::cow::{
    SnapshotAttemptDirGuard, create_sparse_cow_file, snapshot_attempt_cow_file,
    snapshot_attempt_dir, snapshot_attempt_home_image_file, snapshot_attempt_token,
};
use self::output::prepare_snapshot_output;
use self::publish::FirecrackerPendingSnapshotPublish;
use self::runtime::run_snapshot_workflow;

/// Create a snapshot by booting a fresh VM, configuring it, and capturing state.
///
/// This helper creates an uncommitted snapshot, commits the pending publish,
/// and returns only after the provider-specific completion marker and stable
/// output artifacts have been published. If publishing fails, it best-effort
/// discards the uncommitted artifacts and returns the original publish error;
/// any discard error is intentionally suppressed.
///
/// The `config.id` value must satisfy the Firecracker-specific socket-ID
/// contract documented on [`FirecrackerSnapshotProvider`]. Invalid IDs are
/// rejected as [`SnapshotError::Setup`] before snapshot-output cleanup.
///
/// The current Rust workflow spans orchestration in this module, live VM execution in
/// `snapshot/runtime.rs`, resource ownership and cleanup in `snapshot/attempt/`, and stable
/// artifact publication in `snapshot/publish.rs`:
///  1. Create work directory
///  2. Create NBD COW device backed by the rootfs image
///  3. Initialize the pre-warmed network namespace pool and acquire a namespace lease
///  4. Spawn Firecracker with `--api-sock`
///  5. Wait for API socket ready
///  6. Configure VM via API (ordered drives, then parallel remaining PUT calls)
///  7. Bind vsock listener
///  8. Start instance
///  9. Wait for guest vsock connection
/// 10. Pre-warm guest caches (PAM/nsswitch, CLI modules)
/// 11. Pause VM
/// 12. Create snapshot
/// 13. Cleanup Firecracker/netns/NBD runtime resources and keep the temporary COW
/// 14. Move COW file + bitmap to output dir and publish the complete marker
pub async fn create_snapshot(
    config: SnapshotCreateConfig,
) -> Result<SnapshotConfig, SnapshotError> {
    let mut pending = create_uncommitted_snapshot(config).await?;
    match pending.commit_config().await {
        Ok(config) => Ok(config),
        Err(err) => {
            let _ = pending.discard_inner().await;
            Err(err)
        }
    }
}

async fn create_uncommitted_snapshot(
    config: SnapshotCreateConfig,
) -> Result<FirecrackerPendingSnapshotPublish, SnapshotError> {
    let runtime_paths = RuntimePaths::new();
    let sock_dir = checked_runtime_sock_dir(&runtime_paths, &config.id)
        .map_err(|e| SnapshotError::Setup(format!("snapshot socket id: {e}")))?;

    // Check prerequisites (binary, kernel, rootfs, kvm, runtime dir, etc.).
    prerequisites::check_prerequisites(prerequisites::PrerequisiteConfig {
        binary_path: config.binary_path.clone(),
        kernel_path: config.kernel_path.clone(),
        rootfs_path: config.rootfs_path.clone(),
        mode: prerequisites::PrerequisiteMode::SnapshotCreate,
    })
    .await
    .map_err(|e| SnapshotError::Setup(e.to_string()))?;

    let output = SnapshotOutputPaths::new(config.output_dir.clone());

    // 1. Clean stale snapshot output from a previous failed attempt and create work dir.
    let work = prepare_snapshot_output(&output).await?;

    // Socket directory under /run, keyed by config id so concurrent builds don't collide.
    cleanup_existing_snapshot_sock_dir(&sock_dir).await;

    let paths = SandboxPaths::new(work);
    let sock_paths = SockPaths::new(sock_dir.clone());

    info!(work_dir = %paths.workspace().display(), "starting snapshot creation");

    // Validate network prerequisites before allocating an NBD device. The
    // actual namespace pool is still created after the device so the workflow
    // order stays the same, but this keeps pure host-command failures from
    // falling onto the NBD best-effort Drop path.
    let netns_config = NetnsPoolConfig {
        proxy_port: None,
        dns_port: None,
    }
    .into_checked()
    .await
    .map_err(|e| SnapshotError::Setup(e.to_string()))?;

    // 2. Create NBD COW device backed by the rootfs image.
    let base_size = tokio::fs::metadata(&config.rootfs_path)
        .await
        .map_err(|e| SnapshotError::Setup(format!("base image metadata: {e}")))?
        .len();

    // The stable `work/*-device-bind` paths are baked into the snapshot for
    // restore, but the temporary COW and workspace backing files are not. Keep
    // them under an attempt-scoped directory so a cancelled attempt's detached
    // finalizer cannot unlink a later rebuild's files after the outer snapshot
    // lock has been released.
    let attempt_token = snapshot_attempt_token();
    let attempt_dir = snapshot_attempt_dir(paths.workspace(), &attempt_token);
    tokio::fs::create_dir_all(&attempt_dir)
        .await
        .map_err(|e| SnapshotError::Setup(format!("create snapshot attempt dir: {e}")))?;
    let attempt_dir_guard = SnapshotAttemptDirGuard::new(attempt_dir);
    let cow_file = snapshot_attempt_cow_file(paths.workspace(), &attempt_token);
    let home_image_file = snapshot_attempt_home_image_file(paths.workspace(), &attempt_token);
    create_sparse_cow_file(&cow_file, base_size)?;

    let device_pool =
        nbd_cow::pool::DevicePoolHandle::new(nbd_cow::pool::DevicePoolConfig::default());
    let cow_device = device_pool
        .create_cow_device(&config.rootfs_path, &cow_file, base_size)
        .await
        .map_err(|e| SnapshotError::Setup(format!("create NBD COW device: {e}")))?;

    info!(device = %cow_device.device_path().display(), "NBD COW device created");

    // Transfer cleanup ownership before the first post-acquisition await.
    let mut attempt = SnapshotAttempt::new(
        paths,
        sock_paths,
        output,
        device_pool,
        cow_device.into(),
        home_image_file,
        attempt_dir_guard,
    );

    // 3. Initialize a pre-warmed network namespace pool (index auto-allocated via flock).
    attempt
        .initialize_netns_pool(async {
            NetnsPool::create_checked(netns_config)
                .await
                .map_err(|e| SnapshotError::Setup(format!("netns pool: {e}")))
        })
        .await?;
    let result = run_snapshot_workflow(&config, &mut attempt).await;
    let result = match result {
        Ok(snapshot_config) => attempt.prepare_success_publish().await.map(|kept_cow| {
            FirecrackerPendingSnapshotPublish::new(
                snapshot_config,
                SnapshotOutputPaths::new(config.output_dir.clone()),
                kept_cow,
            )
        }),
        Err(err) => Err(err),
    };

    attempt.cleanup_device_pool().await;
    attempt.cleanup_netns_pool().await;
    attempt.cleanup_sock_dir().await;

    result
}

#[cfg(test)]
mod tests {
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
}
