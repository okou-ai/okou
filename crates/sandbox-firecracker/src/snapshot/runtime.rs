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
    // mount namespace, and the workspace drive is mandatory for snapshots.
    FirecrackerBootConfig::new(BootConfigInput {
        invariant,
        vcpu_count: config.vcpu_count,
        memory_mb: config.memory_mb,
        kernel_path: config.kernel_path.display().to_string(),
        rootfs_path: paths.cow_device_bind().display().to_string(),
        workspace_path: Some(paths.workspace_device_bind().display().to_string()),
        vsock_path: sock_paths.vsock().display().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use tokio::sync::Notify;

    use crate::api::test_support::{MOCK_REQUEST_READ_TIMEOUT, MockFirecrackerApi, MockResponse};
    use crate::sandbox::build_fresh_boot_firecracker_config;
    use crate::snapshot::SnapshotError;

    use super::*;

    fn snapshot_create_config(output_dir: PathBuf) -> SnapshotCreateConfig {
        SnapshotCreateConfig {
            id: "snapshot-test".into(),
            binary_path: PathBuf::from("/tmp/firecracker"),
            kernel_path: PathBuf::from("/tmp/vmlinux"),
            rootfs_path: PathBuf::from("/tmp/rootfs.ext4"),
            output_dir,
            vcpu_count: 2,
            memory_mb: 512,
            workspace_disk_mb: 1024,
        }
    }

    fn prewarm_result(
        termination: ExecTermination,
        stderr: Vec<u8>,
        diagnostic: &str,
    ) -> guest_control_client::ExecOperationResult {
        guest_control_client::ExecOperationResult {
            termination,
            duration_ms: 10,
            stdout: guest_control_client::ExecOwnedCapturedOutput::Captured {
                bytes: Vec::new(),
                truncated: false,
            },
            stderr: guest_control_client::ExecOwnedCapturedOutput::Captured {
                bytes: stderr,
                truncated: false,
            },
            diagnostic: diagnostic.to_string(),
            stream_overflowed: false,
        }
    }

    fn expect_prewarm_setup_error(result: Result<(), SnapshotError>) -> String {
        match result {
            Ok(()) => panic!("expected prewarm setup error"),
            Err(SnapshotError::Setup(message)) => message,
            Err(other) => panic!("expected prewarm setup error, got {other:?}"),
        }
    }

    #[test]
    fn prewarm_exec_result_accepts_exited_zero() {
        validate_prewarm_exec_result(prewarm_result(
            ExecTermination::Exited { exit_code: 0 },
            Vec::new(),
            "",
        ))
        .expect("zero exit should succeed");
    }

    #[test]
    fn prewarm_exec_result_preserves_nonzero_exit_wording() {
        let message = expect_prewarm_setup_error(validate_prewarm_exec_result(prewarm_result(
            ExecTermination::Exited { exit_code: 7 },
            b"prewarm failed\n".to_vec(),
            "ignored",
        )));

        assert_eq!(message, "pre-warm failed (exit code 7): prewarm failed");
    }

    #[test]
    fn prewarm_exec_result_reports_structured_terminal_states() {
        for (termination, diagnostic, expected) in [
            (ExecTermination::TimedOut, "", "TimedOut"),
            (ExecTermination::Cancelled, "cancelled by host", "Cancelled"),
            (ExecTermination::StartFailed, "spawn failed", "StartFailed"),
            (ExecTermination::WaitFailed, "wait failed", "WaitFailed"),
        ] {
            let message = expect_prewarm_setup_error(validate_prewarm_exec_result(prewarm_result(
                termination,
                b"stderr clue".to_vec(),
                diagnostic,
            )));

            assert!(message.contains(expected), "got: {message}");
            assert!(message.contains("stderr clue"), "got: {message}");
            if !diagnostic.is_empty() {
                assert!(message.contains(diagnostic), "got: {message}");
            }
        }
    }

    #[test]
    fn prewarm_exec_result_reports_terminal_state_without_detail() {
        let message = expect_prewarm_setup_error(validate_prewarm_exec_result(prewarm_result(
            ExecTermination::TimedOut,
            Vec::new(),
            "",
        )));

        assert_eq!(message, "pre-warm failed (termination TimedOut)");
    }

    #[test]
    fn prewarm_exec_result_reports_terminal_state_with_diagnostic_only() {
        let message = expect_prewarm_setup_error(validate_prewarm_exec_result(prewarm_result(
            ExecTermination::StartFailed,
            Vec::new(),
            "spawn failed",
        )));

        assert_eq!(
            message,
            "pre-warm failed (termination StartFailed): spawn failed"
        );
    }

    #[test]
    fn prewarm_exec_result_rejects_invalid_capture_state() {
        let overflow = expect_prewarm_setup_error(validate_prewarm_exec_result(
            guest_control_client::ExecOperationResult {
                stream_overflowed: true,
                ..prewarm_result(ExecTermination::Exited { exit_code: 0 }, Vec::new(), "")
            },
        ));
        assert!(overflow.contains("pre-warm exec"), "got: {overflow}");
        assert!(
            overflow.contains("overflowed a stream queue"),
            "got: {overflow}"
        );

        let stdout_discarded = expect_prewarm_setup_error(validate_prewarm_exec_result(
            guest_control_client::ExecOperationResult {
                stdout: guest_control_client::ExecOwnedCapturedOutput::Discarded,
                ..prewarm_result(ExecTermination::Exited { exit_code: 0 }, Vec::new(), "")
            },
        ));
        assert!(
            stdout_discarded.contains("discarded stdout"),
            "got: {stdout_discarded}"
        );

        let stderr_discarded = expect_prewarm_setup_error(validate_prewarm_exec_result(
            guest_control_client::ExecOperationResult {
                stderr: guest_control_client::ExecOwnedCapturedOutput::Discarded,
                ..prewarm_result(ExecTermination::Exited { exit_code: 0 }, Vec::new(), "")
            },
        ));
        assert!(
            stderr_discarded.contains("discarded stderr"),
            "got: {stderr_discarded}"
        );
    }

    #[tokio::test]
    async fn snapshot_api_configuration_matches_fresh_boot_topology() {
        let mut api = MockFirecrackerApi::repeating(MockResponse::no_content());
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = SandboxPaths::new(dir.path().join("work"));
        let sock_paths = SockPaths::new(dir.path().join("sock"));
        let client = ApiClient::new(api.socket_path()).unwrap();
        let config = snapshot_create_config(dir.path().join("snapshot-output"));
        let invariant = InvariantConfig::new();
        let snapshot_boot_config =
            build_snapshot_boot_config(&config, &paths, &sock_paths, &invariant);
        let fresh_boot_config = build_fresh_boot_firecracker_config(
            &invariant,
            &sandbox::ResourceLimits {
                cpu_count: config.vcpu_count,
                memory_mb: config.memory_mb,
            },
            config.kernel_path.display().to_string(),
            paths.cow_device_bind().display().to_string(),
            Some(paths.workspace_device_bind().display().to_string()),
            sock_paths.vsock().display().to_string(),
            None,
        )
        .unwrap();
        assert_eq!(fresh_boot_config, snapshot_boot_config);

        let FirecrackerBootConfig {
            boot_source,
            drives,
            machine_config,
            network_interfaces: [network_interface],
            vsock,
            balloon,
        } = snapshot_boot_config;
        let mut expected_bodies = HashMap::from([
            (
                "/machine-config".to_string(),
                serde_json::to_value(machine_config).unwrap(),
            ),
            (
                "/boot-source".to_string(),
                serde_json::to_value(boot_source).unwrap(),
            ),
            (
                format!("/network-interfaces/{}", network_interface.iface_id),
                serde_json::to_value(network_interface).unwrap(),
            ),
            ("/vsock".to_string(), serde_json::to_value(vsock).unwrap()),
            (
                "/balloon".to_string(),
                serde_json::to_value(balloon).unwrap(),
            ),
        ]);
        for drive in drives {
            let path = format!("/drives/{}", drive.drive_id);
            assert!(
                expected_bodies
                    .insert(path, serde_json::to_value(drive).unwrap())
                    .is_none()
            );
        }

        tokio::time::timeout(
            MOCK_REQUEST_READ_TIMEOUT,
            configure_snapshot_vm(&client, &config, &paths, &sock_paths, &invariant),
        )
        .await
        .expect("snapshot VM configuration should finish")
        .expect("snapshot VM configuration should succeed");

        let mut requests = Vec::new();
        for _ in 0..7 {
            requests.push(api.next_request().await);
        }

        assert_eq!(requests[0].method, "PUT");
        assert_eq!(requests[0].path, "/drives/rootfs");
        assert_eq!(requests[1].method, "PUT");
        assert_eq!(requests[1].path, "/drives/workspace");

        for request in requests {
            assert_eq!(request.method, "PUT");
            let expected_body = expected_bodies
                .remove(&request.path)
                .unwrap_or_else(|| panic!("unexpected API request path: {}", request.path));
            let actual_body: serde_json::Value = serde_json::from_str(&request.body)
                .unwrap_or_else(|error| panic!("invalid API request body: {error}"));
            assert_eq!(actual_body, expected_body, "path: {}", request.path);
        }
        assert!(expected_bodies.is_empty());
    }

    fn spawn_snapshot_runtime(
        api: &MockFirecrackerApi,
        dir: &Path,
    ) -> (
        AbortOnDropHandle<Result<SnapshotConfig, SnapshotError>>,
        PathBuf,
    ) {
        // The caller retains the tempdir so its teardown cannot hide a leaked listener.
        let paths = SandboxPaths::new(dir.join("work"));
        let sock_paths = SockPaths::new(dir.join("sock"));
        std::fs::create_dir(sock_paths.dir()).unwrap();
        std::fs::rename(api.socket_path(), sock_paths.api_sock()).unwrap();
        let listener = PathBuf::from(format!(
            "{}_{}",
            sock_paths.vsock().display(),
            guest_control_proto::VSOCK_PORT
        ));
        let config = snapshot_create_config(dir.join("snapshot-output"));
        let output = SnapshotOutputPaths::new(config.output_dir.clone());

        // Exercise the production listener owner without privileged VM acquisition.
        let workflow = AbortOnDropHandle::new(tokio::spawn(async move {
            run_with_firecracker(&config, &paths, &sock_paths, &output).await
        }));

        (workflow, listener)
    }

    async fn wait_for_snapshot_listener(api: &mut MockFirecrackerApi, listener: &Path) {
        tokio::time::timeout(MOCK_REQUEST_READ_TIMEOUT, async {
            loop {
                let request = api.next_request().await;
                if request.path == "/actions" {
                    assert_eq!(request.method, "PUT");
                    let body: serde_json::Value = serde_json::from_str(&request.body).unwrap();
                    assert_eq!(body["action_type"], "InstanceStart");
                    break;
                }
            }
            while !listener.try_exists().expect("stat vsock listener") {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("snapshot workflow should start the instance and bind its listener");
    }

    #[tokio::test]
    async fn cancelled_snapshot_workflow_removes_vsock_listener() {
        let mut api = MockFirecrackerApi::repeating(MockResponse::no_content());
        let dir = tempfile::tempdir().expect("tempdir");
        let (workflow, listener) = spawn_snapshot_runtime(&api, dir.path());

        wait_for_snapshot_listener(&mut api, &listener).await;
        assert!(
            !workflow.is_finished(),
            "workflow should be waiting for the guest"
        );

        workflow.abort();
        let join = tokio::time::timeout(MOCK_REQUEST_READ_TIMEOUT, workflow)
            .await
            .expect("cancelled snapshot workflow should stop");
        assert!(
            join.is_err_and(|e| e.is_cancelled()),
            "snapshot workflow should be cancelled"
        );

        tokio::time::timeout(MOCK_REQUEST_READ_TIMEOUT, async {
            while listener.try_exists().expect("stat vsock listener") {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelling the snapshot workflow should remove its vsock listener");
    }

    #[tokio::test]
    async fn rejected_snapshot_start_removes_vsock_listener() {
        let reject_start = Arc::new(Notify::new());
        let expected_error = "snapshot start rejected";
        let rejection = MockResponse::bad_request_fault(expected_error);
        let mut api = MockFirecrackerApi::with_handler({
            let reject_start = Arc::clone(&reject_start);
            move |request| {
                let reject_start = Arc::clone(&reject_start);
                let rejection = rejection.clone();
                async move {
                    if request.path == "/actions" {
                        reject_start.notified().await;
                        rejection
                    } else {
                        MockResponse::no_content()
                    }
                }
            }
        });
        let dir = tempfile::tempdir().expect("tempdir");
        let (workflow, listener) = spawn_snapshot_runtime(&api, dir.path());

        wait_for_snapshot_listener(&mut api, &listener).await;
        assert!(
            !workflow.is_finished(),
            "start response should still be pending"
        );
        reject_start.notify_one();

        let result = tokio::time::timeout(MOCK_REQUEST_READ_TIMEOUT, workflow)
            .await
            .expect("rejected start should stop the snapshot workflow")
            .expect("snapshot workflow should not panic");
        match result {
            Err(SnapshotError::Api(crate::api::ApiError::Http { status, body })) => {
                assert_eq!(status, 400);
                assert_eq!(body, expected_error);
            }
            other => panic!("expected the Firecracker start error, got {other:?}"),
        }
        assert!(
            !listener.try_exists().expect("stat vsock listener"),
            "failed snapshot start should remove its listener before returning"
        );
    }
}
