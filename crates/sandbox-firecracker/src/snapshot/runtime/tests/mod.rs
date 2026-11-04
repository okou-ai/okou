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
        home_disk_mb: 1024,
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
    let snapshot_boot_config = build_snapshot_boot_config(&config, &paths, &sock_paths, &invariant);
    let fresh_boot_config = build_fresh_boot_firecracker_config(
        &invariant,
        &sandbox::ResourceLimits {
            cpu_count: config.vcpu_count,
            memory_mb: config.memory_mb,
        },
        config.kernel_path.display().to_string(),
        paths.cow_device_bind().display().to_string(),
        Some(paths.home_device_bind().display().to_string()),
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
    assert_eq!(requests[1].path, "/drives/home");

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

async fn read_guest_frame(stream: &mut tokio::net::UnixStream) -> guest_control_proto::RawMessage {
    use tokio::io::AsyncReadExt;
    let mut header = [0_u8; guest_control_proto::HEADER_SIZE];
    tokio::time::timeout(MOCK_REQUEST_READ_TIMEOUT, stream.read_exact(&mut header))
        .await
        .unwrap()
        .unwrap();
    let len = u32::from_be_bytes(header) as usize;
    assert!(
        (guest_control_proto::MIN_BODY_SIZE..=guest_control_proto::MAX_MESSAGE_SIZE).contains(&len)
    );
    let mut body = vec![0; len];
    tokio::time::timeout(MOCK_REQUEST_READ_TIMEOUT, stream.read_exact(&mut body))
        .await
        .unwrap()
        .unwrap();
    guest_control_proto::RawMessage {
        msg_type: body[0],
        seq: u32::from_be_bytes(body[1..5].try_into().unwrap()),
        payload: body[5..].to_vec(),
    }
}

async fn respond_guest_frame(
    stream: &mut tokio::net::UnixStream,
    message_type: u8,
    seq: u32,
    payload: &[u8],
) {
    use tokio::io::AsyncWriteExt;
    stream
        .write_all(&guest_control_proto::encode(message_type, seq, payload).unwrap())
        .await
        .unwrap();
}

#[tokio::test]
async fn snapshot_mount_and_detach_terminal_results_are_barriers_before_pause() {
    // Firecracker and the Guest protocol peer are external boundaries here;
    // this verifies workflow ordering, not a native mount or real KVM Guest.
    for (mount_exit, detach_exit) in [(64, 0), (0, 64), (0, 0)] {
        let mut api = MockFirecrackerApi::repeating(MockResponse::no_content());
        let dir = tempfile::tempdir().unwrap();
        let (workflow, listener) = spawn_snapshot_runtime(&api, dir.path());
        wait_for_snapshot_listener(&mut api, &listener).await;
        let mut peer = tokio::net::UnixStream::connect(&listener).await.unwrap();
        respond_guest_frame(&mut peer, guest_control_proto::MSG_READY, 0, &[]).await;
        let ping = read_guest_frame(&mut peer).await;
        assert_eq!(ping.msg_type, guest_control_proto::MSG_PING);
        respond_guest_frame(&mut peer, guest_control_proto::MSG_PONG, ping.seq, &[]).await;
        let mount = read_guest_frame(&mut peer).await;
        assert_eq!(mount.msg_type, guest_control_proto::MSG_HOME_DRIVE_MOUNT);
        guest_control_proto::decode_home_drive_mount_request(&mount.payload).unwrap();
        assert!(
            !api.drain_requests()
                .iter()
                .any(|request| request.path == "/vm" || request.path == "/snapshot/create")
        );
        let capture = guest_control_proto::ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: false,
        };
        let result = guest_control_proto::encode_home_drive_mount_result(
            ExecTermination::Exited {
                exit_code: mount_exit,
            },
            1,
            capture,
            capture,
            "",
        )
        .unwrap();
        respond_guest_frame(
            &mut peer,
            guest_control_proto::MSG_HOME_DRIVE_MOUNT_RESULT,
            mount.seq,
            &result,
        )
        .await;
        if mount_exit == 0 {
            for (command, sudo, exit_code) in [
                (InvariantConfig::new().prewarm_script, false, 0),
                ("/usr/bin/umount -- /home/user", true, detach_exit),
            ] {
                let start = read_guest_frame(&mut peer).await;
                assert_eq!(start.msg_type, guest_control_proto::MSG_EXEC_START);
                let decoded = guest_control_proto::decode_exec_start(&start.payload).unwrap();
                assert_eq!(decoded.command, command);
                assert_eq!(
                    decoded.lifecycle,
                    guest_control_proto::ExecLifecyclePolicy::OneShot
                );
                assert_eq!(decoded.sudo, sudo);
                assert!(decoded.env.is_empty());
                assert!(
                    !api.drain_requests()
                        .iter()
                        .any(|request| request.path == "/vm" || request.path == "/snapshot/create")
                );
                // Snapshot prewarm/detach are one-shot operations: the peer
                // returns only their terminal result, never a workload PID.
                let result = guest_control_proto::encode_exec_result(
                    ExecTermination::Exited { exit_code },
                    1,
                    capture,
                    capture,
                    "",
                )
                .unwrap();
                respond_guest_frame(
                    &mut peer,
                    guest_control_proto::MSG_EXEC_RESULT,
                    start.seq,
                    &result,
                )
                .await;
            }
        }
        let result = tokio::time::timeout(MOCK_REQUEST_READ_TIMEOUT, workflow)
            .await
            .unwrap()
            .unwrap();
        let requests = api.drain_requests();
        if mount_exit == 0 && detach_exit == 0 {
            assert!(result.is_ok());
            assert_eq!(
                requests
                    .iter()
                    .map(|request| request.path.as_str())
                    .collect::<Vec<_>>(),
                ["/vm", "/snapshot/create"]
            );
        } else {
            assert!(result.is_err());
            assert!(
                !requests
                    .iter()
                    .any(|request| request.path == "/vm" || request.path == "/snapshot/create")
            );
        }
    }
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
