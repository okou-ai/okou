use sandbox::ExecTermination;

use super::*;

#[test]
fn remote_exec_result_maps_structured_result() {
    let result = remote_exec_result_from_result(ExecResult::Success {
        termination: ExecTermination::Exited { exit_code: 7 },
        stdout: b"out".to_vec(),
        stderr: b"err".to_vec(),
        stdout_truncated: true,
        stderr_truncated: false,
        diagnostic: "diagnostic".into(),
    })
    .unwrap();

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 7 });
    assert_eq!(result.stdout, b"out");
    assert_eq!(result.stderr, b"err");
    assert!(result.stdout_truncated);
    assert!(!result.stderr_truncated);
    assert_eq!(result.diagnostic, "diagnostic");
}

#[test]
fn remote_exec_result_error_maps_to_remote_error() {
    let result = remote_exec_result_from_result(ExecResult::Error {
        error: "sandbox not running".into(),
    });

    let Err(SandboxControlError::Remote(message)) = result else {
        panic!("expected remote error");
    };
    assert_eq!(message, "sandbox not running");
}

#[tokio::test]
async fn exec_remote_empty_id() {
    let control = FirecrackerControl;
    let result = control
        .exec_remote(
            SandboxControlTarget::sandbox(""),
            "echo hi",
            Duration::from_secs(5),
            false,
        )
        .await;
    let Err(e) = result else {
        panic!("expected error");
    };
    assert!(e.to_string().contains("must not be empty"));
}

#[tokio::test]
async fn kill_remote_empty_id() {
    let control = FirecrackerControl;
    let result = control.kill_remote(SandboxControlTarget::sandbox("")).await;
    let Err(e) = result else {
        panic!("expected error");
    };
    assert!(e.to_string().contains("must not be empty"));
}

#[test]
fn runtime_dir_returns_sock_dir() {
    let control = FirecrackerControl;
    let dir = control.runtime_dir("test-id");
    assert!(dir.ends_with("test-id"));
}

#[test]
fn normal_timeout_uses_server_wait_budget() {
    let timeout_secs = request_timeout_secs(Duration::from_secs(5));

    assert_eq!(timeout_secs, 5);
    assert_eq!(control_timeout(timeout_secs), Duration::from_secs(10));
}

#[test]
fn positive_subsecond_timeout_becomes_zero_second_request() {
    let timeout_secs = request_timeout_secs(Duration::from_millis(999));

    assert_eq!(timeout_secs, 0);
    assert_eq!(
        control_timeout(timeout_secs),
        Duration::from_millis(CONTROL_SOCKET_OVERHEAD_MS)
    );
}

#[test]
fn fractional_timeout_truncates_to_whole_seconds() {
    let timeout_secs = request_timeout_secs(Duration::from_millis(1500));

    assert_eq!(timeout_secs, 1);
    assert_eq!(control_timeout(timeout_secs), Duration::from_secs(6));
}

#[test]
fn oversized_timeout_clamps_to_server_wait_budget() {
    let timeout_secs = request_timeout_secs(Duration::MAX);

    assert_eq!(timeout_secs, u32::MAX);
    assert_eq!(
        control_timeout(timeout_secs),
        Duration::from_millis(u64::from(u32::MAX) + CONTROL_SOCKET_OVERHEAD_MS)
    );
}
