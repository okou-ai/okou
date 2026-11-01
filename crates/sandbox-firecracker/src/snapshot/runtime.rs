use std::io;
use std::time::Duration;

use guest_control_proto::ExecTermination;
use tokio_util::task::AbortOnDropHandle;
use tracing::info;

use crate::api::ApiClient;
use crate::boot_config::{BootConfigInput, FirecrackerBootConfig};
use crate::config::SnapshotConfig;
use crate::exec_operation_result::{captured_exec_output_bytes, reject_stream_overflow};
use crate::factory::InvariantConfig;
use crate::paths::{SandboxPaths, SnapshotOutputPaths, SockPaths};
use crate::runtime_dirs::{prepare_runtime_socket_dir, set_private_runtime_socket_mode};
use sandbox::SnapshotCreateConfig;

use super::SnapshotError;
use super::attempt::SnapshotAttempt;

const API_READY_TIMEOUT: Duration = Duration::from_secs(5);

/// Timeout for waiting for the guest to connect via vsock after start.
const VSOCK_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Pre-warm should be quiet; keep diagnostics bounded and explicit.
const PREWARM_EXEC_CAPTURE_LIMIT_BYTES: u32 = 64 * 1024;

pub(super) async fn run_snapshot_workflow(
    config: &SnapshotCreateConfig,
    attempt: &mut SnapshotAttempt,
) -> Result<SnapshotConfig, SnapshotError> {
    attempt.prepare_firecracker_files(config).await?;
    // 3. Acquire a namespace lease from the pre-warmed pool.
    attempt.acquire_network().await?;
    attempt.spawn_firecracker(config).await?;

    // Guard: ensure Firecracker and netns cleanup on any explicit exit path.
    let result = run_with_firecracker(
        config,
        attempt.paths(),
        attempt.sock_paths()?,
        attempt.output(),
    )
    .await;
    attempt.finish_runtime_after_workflow(result).await
}

/// Inner workflow that runs while Firecracker is alive.
async fn run_with_firecracker(
    config: &SnapshotCreateConfig,
    paths: &SandboxPaths,
    sock_paths: &SockPaths,
    output: &SnapshotOutputPaths,
) -> Result<SnapshotConfig, SnapshotError> {
    // 5. Wait for API socket ready.
    let api_sock = sock_paths.api_sock();
    let client = ApiClient::new(&api_sock)?;
    client.wait_for_ready(API_READY_TIMEOUT).await?;
    set_private_runtime_socket_mode(&api_sock)?;

    info!("firecracker API ready");

    let inv = InvariantConfig::new();
    let vsock_uds_str = configure_snapshot_vm(&client, config, paths, sock_paths, &inv).await?;

    info!("VM configured");

    // 7. Bind vsock listener BEFORE starting the instance (race: guest connects ~300ms after boot).
    let vsock_path_for_listen = vsock_uds_str.clone();
    let vsock_task = AbortOnDropHandle::new(tokio::spawn(async move {
        guest_control_client::GuestControlClient::wait_for_connection(
            &vsock_path_for_listen,
            VSOCK_CONNECT_TIMEOUT,
        )
        .await
    }));

    // 8. Start instance.
    let start_result = client.start_instance().await;
    if let Err(e) = start_result {
        vsock_task.abort();
        let _ = vsock_task.await;
        return Err(e.into());
    }

    info!("instance started, waiting for guest vsock connection");

    // 9. Wait for guest to connect via vsock.
    let guest = match vsock_task.await {
        Ok(Ok(g)) => g,
        Ok(Err(e)) => return Err(SnapshotError::Vsock(e.to_string())),
        Err(e) => return Err(SnapshotError::Vsock(format!("vsock task: {e}"))),
    };

    info!("guest connected");

    // A snapshot may only capture the paired home layout. The typed
    // request rejects an older rootfs helper even if its generic ping works.
    super::super::sandbox::validate_guest_home_drive(&guest)
        .await
        .map_err(|error| SnapshotError::Setup(format!("snapshot home drive: {error}")))?;

    // 10. Pre-warm caches (PAM/nsswitch, CLI modules) so post-restore calls
    //     are fast. The snapshot captures memory + disk state, so caches
    //     populated here persist across restores.
    let prewarm_result = guest
        .exec_operation_capture(guest_control_client::ExecCaptureRequest {
            command: inv.prewarm_script,
            timeout_ms: 30_000,
            env: &[],
            sudo: false,
            label: "snapshot-prewarm",
            stdout_limit_bytes: PREWARM_EXEC_CAPTURE_LIMIT_BYTES,
            stderr_limit_bytes: PREWARM_EXEC_CAPTURE_LIMIT_BYTES,
            expected_exit_codes: &[],
            stdin_bytes: None,
            wait_timeout: Duration::from_millis(35_000),
        })
        .await
        .map_err(|e| SnapshotError::Setup(format!("pre-warm exec: {e}")))?;
    validate_prewarm_exec_result(prewarm_result)?;
    info!("pre-warm complete");

    // Never snapshot a mounted temporary home superblock/inode cache: restore
    // substitutes a different image behind /dev/vdb. The prewarm operation's
    // terminal frame follows process and output cleanup, so all its home
    // readers are finished before this root-owned detach operation. PID 1 and
    // Guest control stay rooted at /root, not on the disposable home.
    detach_snapshot_home(&guest).await?;

    // 11. Pause VM.
    client.pause().await?;

    info!("VM paused");

    // 12. Create snapshot — Firecracker writes directly to output_dir.
    //
    // File content durability is guaranteed upstream: as of Firecracker
    // v1.16.2 (see `FIRECRACKER_VERSION` in `runner/src/deps.rs`), both
    // snapshot.bin and memory.bin are flushed and fsynced before the API
    // response returns. References (pinned to the v1.16.2 tag):
    //   - `snapshot_state_to_file` — https://github.com/firecracker-microvm/firecracker/blob/v1.16.2/src/vmm/src/persist.rs
    //   - `snapshot_memory_to_file` — https://github.com/firecracker-microvm/firecracker/blob/v1.16.2/src/vmm/src/vstate/vm.rs
    // Re-verify this guarantee whenever `FIRECRACKER_VERSION` is bumped;
    // if it ever regresses, add a host-side `sync_all` on both files here.
    // Directory-entry durability (persisting the `name → inode` mapping)
    // is handled separately; see #9825.
    let snapshot_str = output.snapshot().display().to_string();
    let memory_str = output.memory().display().to_string();
    client.create_snapshot(&snapshot_str, &memory_str).await?;

    info!("snapshot created");

    info!(output_dir = %config.output_dir.display(), "snapshot creation complete");

    Ok(output.snapshot_config(&config.id))
}

async fn detach_snapshot_home(
    guest: &guest_control_client::GuestControlClient,
) -> Result<(), SnapshotError> {
    let result = guest
        .exec_operation_capture(guest_control_client::ExecCaptureRequest {
            command: "/usr/bin/umount -- /home/user",
            timeout_ms: 30_000,
            env: &[],
            sudo: true,
            label: "snapshot-home-detach",
            stdout_limit_bytes: PREWARM_EXEC_CAPTURE_LIMIT_BYTES,
            stderr_limit_bytes: PREWARM_EXEC_CAPTURE_LIMIT_BYTES,
            expected_exit_codes: &[],
            stdin_bytes: None,
            wait_timeout: Duration::from_millis(35_000),
        })
        .await
        .map_err(|error| SnapshotError::Setup(format!("detach snapshot home: {error}")))?;
    let (termination, stderr, diagnostic) = prewarm_exec_result_parts(result)
        .map_err(|error| SnapshotError::Setup(format!("detach snapshot home: {error}")))?;
    if termination != (ExecTermination::Exited { exit_code: 0 }) {
        return Err(SnapshotError::Setup(format!(
            "detach snapshot home failed ({termination:?}): {} {diagnostic}",
            String::from_utf8_lossy(&stderr),
        )));
    }
    Ok(())
}

fn validate_prewarm_exec_result(
    result: guest_control_client::ExecOperationResult,
) -> Result<(), SnapshotError> {
    let (termination, stderr, diagnostic) = prewarm_exec_result_parts(result)
        .map_err(|e| SnapshotError::Setup(format!("pre-warm exec: {e}")))?;
    let stderr = String::from_utf8_lossy(&stderr);
    let stderr = stderr.trim();

    match termination {
        ExecTermination::Exited { exit_code: 0 } => Ok(()),
        ExecTermination::Exited { exit_code } => Err(SnapshotError::Setup(format!(
            "pre-warm failed (exit code {exit_code}): {stderr}",
        ))),
        termination => {
            let detail = prewarm_failure_detail(stderr, &diagnostic);
            if detail.is_empty() {
                Err(SnapshotError::Setup(format!(
                    "pre-warm failed (termination {termination:?})"
                )))
            } else {
                Err(SnapshotError::Setup(format!(
                    "pre-warm failed (termination {termination:?}): {detail}"
                )))
            }
        }
    }
}

fn prewarm_exec_result_parts(
    result: guest_control_client::ExecOperationResult,
) -> io::Result<(ExecTermination, Vec<u8>, String)> {
    reject_stream_overflow(&result)?;

    let guest_control_client::ExecOperationResult {
        termination,
        stdout,
        stderr,
        diagnostic,
        ..
    } = result;

    let _ = captured_exec_output_bytes("stdout", stdout)?;
    let (stderr, _) = captured_exec_output_bytes("stderr", stderr)?;
    Ok((termination, stderr, diagnostic))
}

fn prewarm_failure_detail(stderr: &str, diagnostic: &str) -> String {
    let diagnostic = diagnostic.trim();
    match (stderr.is_empty(), diagnostic.is_empty()) {
        (true, true) => String::new(),
        (false, true) => stderr.to_string(),
        (true, false) => diagnostic.to_string(),
        (false, false) => format!("{stderr}; diagnostic: {diagnostic}"),
    }
}

async fn configure_snapshot_vm(
    client: &ApiClient,
    config: &SnapshotCreateConfig,
    paths: &SandboxPaths,
    sock_paths: &SockPaths,
    inv: &InvariantConfig,
) -> Result<String, SnapshotError> {
    prepare_runtime_socket_dir(sock_paths)?;
    let boot_config = build_snapshot_boot_config(config, paths, sock_paths, inv);
    let vsock_uds_str = boot_config.vsock.uds_path.clone();
    let FirecrackerBootConfig {
        boot_source,
        drives,
        machine_config,
        network_interfaces: [network_interface],
        vsock,
        balloon,
    } = boot_config;

    for drive in &drives {
        client.configure_drive_payload(drive).await?;
    }

    tokio::try_join!(
        client.configure_machine_payload(&machine_config),
        client.configure_boot_source_payload(&boot_source),
        client.configure_network_interface_payload(&network_interface),
        client.configure_vsock_payload(&vsock),
        client.configure_balloon_payload(&balloon),
    )?;

    Ok(vsock_uds_str)
}

fn build_snapshot_boot_config(
    config: &SnapshotCreateConfig,
    paths: &SandboxPaths,
    sock_paths: &SockPaths,
    invariant: &InvariantConfig,
) -> FirecrackerBootConfig {
    // The COW-device bind mounts are established inside `unshare --mount`
    // at spawn time. Firecracker opens these stable paths inside that private
    // mount namespace, and the home drive is mandatory for snapshots.
    FirecrackerBootConfig::new(BootConfigInput {
        invariant,
        vcpu_count: config.vcpu_count,
        memory_mb: config.memory_mb,
        kernel_path: config.kernel_path.display().to_string(),
        rootfs_path: paths.cow_device_bind().display().to_string(),
        home_path: Some(paths.home_device_bind().display().to_string()),
        vsock_path: sock_paths.vsock().display().to_string(),
    })
}

#[cfg(test)]
mod tests;
