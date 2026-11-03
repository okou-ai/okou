use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

use guest_contracts::agent_instructions::InstructionOperation;
use guest_control_client::GuestControlClient;
use guest_control_proto::{ExecTermination, VSOCK_PORT};
use sandbox::AgentInstructionsRequest;

use crate::support::{join_raw_guest_connection, pid_alive, wait_for_path};

async fn start_guest(
    program: &str,
) -> (
    tempfile::TempDir,
    GuestControlClient,
    crate::support::RawGuestHandle,
) {
    start_guest_with_gate(program, None).await
}

async fn start_guest_with_gate(
    program: &str,
    timeout_gate: Option<std::sync::mpsc::SyncSender<u32>>,
) -> (
    tempfile::TempDir,
    GuestControlClient,
    crate::support::RawGuestHandle,
) {
    let directory = tempfile::tempdir().unwrap();
    let helper = directory.path().join("helper");
    fs::write(&helper, program).unwrap();
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
    let vsock = directory.path().join("vsock");
    let listener = format!("{}_{VSOCK_PORT}", vsock.display());
    let host =
        GuestControlClient::wait_for_connection(vsock.to_str().unwrap(), Duration::from_secs(5));
    let guest = async {
        wait_for_path(std::path::Path::new(&listener), Duration::from_secs(5)).await;
        std::thread::spawn(move || {
            let stream = guest_control_server::connect_unix(&listener)?;
            match timeout_gate {
                Some(gate) => {
                    guest_control_server::handle_connection_with_test_storage_manifest_timeout_gate(
                        stream, helper, None, gate,
                    )
                }
                None => guest_control_server::handle_connection_with_test_storage_manifest_program(
                    stream, helper,
                ),
            }
        })
    };
    let (host, guest) = tokio::join!(host, guest);
    (directory, host.unwrap(), guest)
}

fn request(
    operation: InstructionOperation,
    timeout: Duration,
) -> AgentInstructionsRequest<'static> {
    AgentInstructionsRequest {
        operation,
        metadata: br#"{"framework":"codex"}"#,
        run_id: "instruction-run",
        runtime_dir: "/run/instruction",
        timeout,
    }
}

#[tokio::test]
async fn instruction_actions_preserve_flags_env_stdin_errors_and_worker_reuse() {
    let (_directory, host, guest) = start_guest("#!/bin/sh\ncase \"$1\" in\n--instructions-check-stdin) printf check:;;\n--instructions-stdin) printf apply:;;\n*) exit 42;;\nesac\nprintf '%s:%s:' \"$OKOU_RUN_ID\" \"$OKOU_GUEST_RUNTIME_DIR\"\ncat\n[ \"$1\" != --instructions-stdin ] || { printf failure >&2; exit 23; }\n").await;
    for operation in [
        InstructionOperation::Check,
        InstructionOperation::Apply,
        InstructionOperation::Check,
    ] {
        let input = request(operation, Duration::from_secs(2));
        let result = host
            .guest_agent_instructions(&input, Duration::from_secs(5))
            .await
            .unwrap();
        let prefix = if operation == InstructionOperation::Check {
            "check"
        } else {
            "apply"
        };
        assert_eq!(
            result.stdout,
            format!("{prefix}:instruction-run:/run/instruction:{{\"framework\":\"codex\"}}")
                .as_bytes()
        );
        assert_eq!(
            result.termination,
            ExecTermination::Exited {
                exit_code: if operation == InstructionOperation::Apply {
                    23
                } else {
                    0
                }
            }
        );
        assert_eq!(
            result.stderr,
            if operation == InstructionOperation::Apply {
                b"failure".as_slice()
            } else {
                b""
            }
        );
        assert!(result.resources.is_none());
        host.quiesce_operations(Duration::from_secs(2))
            .await
            .unwrap();
        host.resume_operations(Duration::from_secs(2))
            .await
            .unwrap();
    }
    drop(host);
    join_raw_guest_connection(guest);
}

#[tokio::test]
async fn instruction_capture_remains_bounded_on_the_real_server() {
    let (_directory, host, guest) = start_guest("#!/bin/sh\nhead -c 70000 /dev/zero\n").await;
    let result = host
        .guest_agent_instructions(
            &request(InstructionOperation::Check, Duration::from_secs(2)),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout.len(), 64 * 1024);
    assert!(result.stdout_truncated);
    drop(host);
    join_raw_guest_connection(guest);
}

async fn blocked_helper(disconnect: bool) {
    let state = tempfile::tempdir().unwrap();
    let fifo = state.path().join("release");
    let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    // SAFETY: the test owns this fresh path and supplies a valid C string.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let started = state.path().join("started");
    let program = format!(
        "#!/bin/sh\n: > '{}'\nread value < '{}'\n",
        started.display(),
        fifo.display()
    );
    let (timeout_tx, timeout_rx) = std::sync::mpsc::sync_channel(0);
    let (_directory, host, guest) = start_guest_with_gate(&program, Some(timeout_tx)).await;
    let host = Arc::new(host);
    let task_host = Arc::clone(&host);
    let task = tokio::spawn(async move {
        task_host
            .guest_agent_instructions(
                &request(
                    InstructionOperation::Apply,
                    if disconnect {
                        Duration::from_secs(30)
                    } else {
                        Duration::from_millis(100)
                    },
                ),
                Duration::from_secs(35),
            )
            .await
    });
    wait_for_path(&started, Duration::from_secs(5)).await;
    // The control loop stays responsive, while both request types share one
    // helper admission slot. The first child's timeout is still gated here.
    let competing = host
        .guest_storage_manifest(
            b"{}",
            "competing-storage",
            "/run/competing",
            1000,
            Duration::from_secs(2),
        )
        .await
        .unwrap_err();
    assert!(competing.to_string().contains("already active"));
    // Establish actual child readiness before releasing its process timeout.
    // Path creation is only a signal; receive the owned PID without racing a
    // shell redirection's create-before-write window.
    let pid = timeout_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("started instruction helper reaches its timeout gate");
    if disconnect {
        assert!(
            host.quiesce_operations(Duration::from_secs(2))
                .await
                .is_err()
        );
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        drop(host);
        join_raw_guest_connection(guest);
    } else {
        let result = task.await.unwrap().unwrap();
        assert_eq!(result.termination, ExecTermination::TimedOut);
        host.quiesce_operations(Duration::from_secs(2))
            .await
            .unwrap();
        drop(host);
        join_raw_guest_connection(guest);
    }
    assert!(
        !pid_alive(pid),
        "owned helper must be reaped before cleanup completes"
    );
}

#[tokio::test]
async fn instruction_timeout_reaps_child_and_releases_quiesce_ownership() {
    blocked_helper(false).await;
}

#[tokio::test]
async fn instruction_disconnect_cancels_child_and_joins_the_storage_worker() {
    blocked_helper(true).await;
}
