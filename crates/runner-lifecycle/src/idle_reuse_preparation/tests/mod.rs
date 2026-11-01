use super::*;

use guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_SUCCESS;
use sandbox::{Sandbox, SandboxError, SandboxOperation, SandboxOperationReason};
use sandbox_mock::MockSandbox;
use tracing::Level;
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

fn report(
    before_bytes: u64,
    after_bytes: u64,
    before_inodes: u64,
    after_inodes: u64,
) -> ReusePreparationReport {
    use guest_contracts::reuse_preparation::FilesystemCapacity;

    ReusePreparationReport {
        before: FilesystemCapacity {
            available_bytes: before_bytes,
            available_inodes: before_inodes,
        },
        after: FilesystemCapacity {
            available_bytes: after_bytes,
            available_inodes: after_inodes,
        },
        removed_entries: 3,
        home: healthy_reuse_preparation_report().home,
    }
}

async fn capture_preparation(
    sandbox: &MockSandbox,
    run_id: RunId,
) -> (Result<(), IdleReusePreparationFailure>, Vec<CapturedEvent>) {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    let result = execute_preparation(sandbox, run_id, run_id, None).await;
    drop(guard);
    (result, captured.entries())
}

async fn execute_preparation(
    sandbox: &MockSandbox,
    operation_run_id: RunId,
    current_runtime_run_id: RunId,
    retained_runtime_dir: Option<&str>,
) -> Result<(), IdleReusePreparationFailure> {
    let preparation = IdleReusePreparation::new(
        sandbox.id(),
        operation_run_id,
        current_runtime_run_id,
        retained_runtime_dir,
    )?;
    let result = sandbox
        .exec_with_diagnostic_label(&preparation.exec_request(), "idle-reuse-preparation")
        .await
        .map_err(|error| {
            reject_without_exec(
                sandbox.id(),
                operation_run_id,
                ReuseRejectionReason::HelperFailed,
                format!("reuse-preparation exec failed: {error}"),
            )
        })?;
    preparation.validate_result(&result).map(drop)
}

fn captured_event<'a>(events: &'a [CapturedEvent], message: &str) -> &'a CapturedEvent {
    events
        .iter()
        .find(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|actual| actual == message)
        })
        .unwrap_or_else(|| panic!("missing event {message:?}; captured={events:#?}"))
}

#[tokio::test]
async fn full_home_rejects_idle_admission_with_independent_capacity_reason() {
    for (bytes, inodes, reason) in [
        (0, 2048, "home_low_bytes"),
        (256 * 1024 * 1024, 0, "home_low_inodes"),
        (0, 0, "home_low_bytes_and_inodes"),
    ] {
        let mut report = healthy_reuse_preparation_report();
        report.home.available_bytes = bytes;
        report.home.available_inodes = inodes;
        let sandbox = MockSandbox::new("full-home");
        sandbox.push_exec_result(Ok(ExecResult::new(
            0,
            serde_json::to_vec(&report).unwrap(),
            Vec::new(),
        )));
        let (result, events) = capture_preparation(&sandbox, RunId::new_v4()).await;
        assert!(result.unwrap_err().is_expected_capacity_rejection());
        let event = captured_event(&events, "sandbox rejected from idle reuse");
        assert_eq!(event.fields.get("reason").map(String::as_str), Some(reason));
        assert_eq!(
            event.fields.get("home_available_bytes"),
            Some(&bytes.to_string())
        );
        assert_eq!(
            event.fields.get("home_available_inodes"),
            Some(&inodes.to_string())
        );
    }
}

#[tokio::test]
async fn preparation_sends_canonical_current_and_retained_runtime_directories() {
    let sandbox = MockSandbox::new("reuse-request");
    sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&healthy_reuse_preparation_report()).unwrap(),
        Vec::new(),
    )));
    let operation_run_id = RunId::new_v4();
    let current_runtime_run_id = RunId::new_v4();
    let retained = "/home/user/.vm0/guest-agent/runs/previous";

    execute_preparation(
        &sandbox,
        operation_run_id,
        current_runtime_run_id,
        Some(retained),
    )
    .await
    .expect("healthy guest should be prepared");

    let calls = sandbox.exec_calls();
    assert_eq!(calls.len(), 1);
    assert!(calls[0].sudo);
    let helper_position = calls[0]
        .cmd
        .find("guest-agent prepare-for-reuse")
        .expect("reuse helper command");
    let mount_position = calls[0]
        .cmd
        .find(HOME_MOUNT_PATH)
        .expect("home mount command");
    assert!(
        mount_position < helper_position,
        "capacity must describe the mounted home"
    );
    let request: ReusePreparationRequest = serde_json::from_slice(
        calls[0]
            .stdin_bytes
            .as_deref()
            .expect("reuse request should be sent on stdin"),
    )
    .unwrap();
    assert_eq!(
        request.current_runtime_dir,
        format!("/home/user/.vm0/guest-agent/runs/{current_runtime_run_id}")
    );
    assert_eq!(request.retained_runtime_dir.as_deref(), Some(retained));
}

#[tokio::test]
async fn preparation_rejects_low_bytes_with_capacity_telemetry() {
    let sandbox = MockSandbox::new("low-bytes");
    sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&report(64, 96, 4096, 4090)).unwrap(),
        Vec::new(),
    )));

    let (result, events) = capture_preparation(&sandbox, RunId::new_v4()).await;

    assert!(result.is_err());
    let event = captured_event(&events, "sandbox rejected from idle reuse");
    assert_eq!(event.level, Level::INFO);
    assert_eq!(
        event.fields.get("reason").map(String::as_str),
        Some("low_bytes")
    );
    assert_eq!(
        event
            .fields
            .get("before_available_bytes")
            .map(String::as_str),
        Some("64")
    );
    assert_eq!(
        event
            .fields
            .get("after_available_bytes")
            .map(String::as_str),
        Some("96")
    );
    assert_eq!(
        event.fields.get("reclaimed_bytes").map(String::as_str),
        Some("32")
    );
}

#[tokio::test]
async fn preparation_rejects_low_inodes_with_capacity_telemetry() {
    let sandbox = MockSandbox::new("low-inodes");
    sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&report(256 * 1024 * 1024, 257 * 1024 * 1024, 500, 600)).unwrap(),
        Vec::new(),
    )));

    let (result, events) = capture_preparation(&sandbox, RunId::new_v4()).await;

    assert!(result.is_err());
    let event = captured_event(&events, "sandbox rejected from idle reuse");
    assert_eq!(event.level, Level::INFO);
    assert_eq!(
        event.fields.get("reason").map(String::as_str),
        Some("low_inodes")
    );
    assert_eq!(
        event
            .fields
            .get("after_available_inodes")
            .map(String::as_str),
        Some("600")
    );
    assert_eq!(
        event.fields.get("reclaimed_inodes").map(String::as_str),
        Some("100")
    );
}

#[tokio::test]
async fn preparation_rejects_low_bytes_and_inodes_at_info() {
    let sandbox = MockSandbox::new("low-bytes-and-inodes");
    sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&report(64, 96, 500, 600)).unwrap(),
        Vec::new(),
    )));

    let (result, events) = capture_preparation(&sandbox, RunId::new_v4()).await;

    assert!(result.is_err());
    let event = captured_event(&events, "sandbox rejected from idle reuse");
    assert_eq!(event.level, Level::INFO);
    assert_eq!(
        event.fields.get("reason").map(String::as_str),
        Some("low_bytes_and_inodes")
    );
}

#[tokio::test]
async fn preparation_distinguishes_typed_helper_failures() {
    for (exit_code, expected_reason) in [
        (REUSE_PREPARATION_EXIT_INVALID_REQUEST, "invalid_request"),
        (
            REUSE_PREPARATION_EXIT_INSPECTION_FAILED,
            "inspection_failed",
        ),
        (REUSE_PREPARATION_EXIT_CLEANUP_FAILED, "cleanup_failed"),
        (
            REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED,
            "containment_failed",
        ),
    ] {
        let sandbox = MockSandbox::new(expected_reason);
        sandbox.push_exec_result(Ok(ExecResult::new(
            exit_code,
            Vec::new(),
            b"helper failed".to_vec(),
        )));

        let (result, events) = capture_preparation(&sandbox, RunId::new_v4()).await;

        assert!(result.is_err());
        let event = captured_event(&events, "sandbox rejected from idle reuse");
        assert_eq!(event.level, Level::WARN);
        assert_eq!(
            event.fields.get("reason").map(String::as_str),
            Some(expected_reason)
        );
    }
}

#[test]
fn composed_command_preserves_helper_statuses_and_mount_boundary() {
    for helper_exit_code in [
        REUSE_PREPARATION_EXIT_INVALID_REQUEST,
        REUSE_PREPARATION_EXIT_INSPECTION_FAILED,
        REUSE_PREPARATION_EXIT_CLEANUP_FAILED,
        REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED,
    ] {
        let (output, mount_ran) = run_composed_command(helper_exit_code, 0);

        assert_eq!(output.status.code(), Some(helper_exit_code));
        assert!(
            mount_ran,
            "mount identity must be established before helper status {helper_exit_code}"
        );
    }

    let (output, mount_ran) = run_composed_command(REUSE_PREPARATION_EXIT_SUCCESS, 1);
    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_HOME_MOUNT_FAILED)
    );
    assert!(mount_ran, "mount failure must stop before preparation");
}

#[test]
fn mount_validation_cannot_consume_the_preparation_request_stdin() {
    use std::io::Write;
    let command = compose_reuse_preparation_command("cat", "cat >/dev/null");
    let mut child = std::process::Command::new("sh")
        .arg("-c")
        .arg(command)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"current preparation request")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"current preparation request");
}

#[test]
fn wrapper_status_is_reserved_outside_helper_statuses() {
    for helper_status in [
        REUSE_PREPARATION_EXIT_SUCCESS,
        REUSE_PREPARATION_EXIT_INVALID_REQUEST,
        REUSE_PREPARATION_EXIT_INSPECTION_FAILED,
        REUSE_PREPARATION_EXIT_CLEANUP_FAILED,
        REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED,
    ] {
        assert_ne!(REUSE_PREPARATION_EXIT_HOME_MOUNT_FAILED, helper_status);
    }
}

fn run_composed_command(
    helper_exit_code: i32,
    mount_exit_code: i32,
) -> (std::process::Output, bool) {
    let temp_dir = tempfile::tempdir().unwrap();
    let mount_marker = temp_dir.path().join("mount-ran");
    let mount_marker = shell_quote::quote_shell_arg(mount_marker.to_str().unwrap());
    let mount_command = format!("touch -- {mount_marker}\nexit {mount_exit_code}");
    let helper_command = if helper_exit_code == REUSE_PREPARATION_EXIT_SUCCESS {
        "true".to_owned()
    } else {
        format!("exit {helper_exit_code}")
    };
    let command = compose_reuse_preparation_command(&helper_command, &mount_command);
    let output = std::process::Command::new("sh")
        .arg("-c")
        .arg(command)
        .output()
        .unwrap();
    let mount_ran = temp_dir.path().join("mount-ran").exists();
    (output, mount_ran)
}

#[tokio::test]
async fn preparation_distinguishes_home_mount_failure() {
    let sandbox = MockSandbox::new("home-mount-failure");
    sandbox.push_exec_result(Ok(ExecResult::new(
        REUSE_PREPARATION_EXIT_HOME_MOUNT_FAILED,
        serde_json::to_vec(&healthy_reuse_preparation_report()).unwrap(),
        b"home mount failed".to_vec(),
    )));

    let (result, events) = capture_preparation(&sandbox, RunId::new_v4()).await;

    assert!(result.is_err());
    assert_eq!(
        captured_event(&events, "sandbox rejected from idle reuse").level,
        Level::WARN
    );
    assert_eq!(
        captured_event(&events, "sandbox rejected from idle reuse")
            .fields
            .get("reason")
            .map(String::as_str),
        Some("home_mount_failed")
    );
}

#[tokio::test]
async fn preparation_fails_closed_for_malformed_report_and_transport_failure() {
    let malformed = MockSandbox::new("malformed-report");
    malformed.push_exec_result(Ok(ExecResult::new(0, b"not-json".to_vec(), Vec::new())));
    let (result, events) = capture_preparation(&malformed, RunId::new_v4()).await;
    assert!(result.is_err());
    assert_eq!(
        captured_event(&events, "sandbox rejected from idle reuse").level,
        Level::WARN
    );
    assert_eq!(
        captured_event(&events, "sandbox rejected from idle reuse")
            .fields
            .get("reason")
            .map(String::as_str),
        Some("invalid_report")
    );

    let transport = MockSandbox::new("transport-failure");
    transport.push_exec_result(Err(SandboxError::Operation {
        operation: SandboxOperation::Exec,
        reason: SandboxOperationReason::Guest,
        message: "vsock disconnected".into(),
    }));
    let (result, events) = capture_preparation(&transport, RunId::new_v4()).await;
    assert!(result.is_err());
    assert_eq!(
        captured_event(&events, "sandbox rejected from idle reuse").level,
        Level::WARN
    );
    assert_eq!(
        captured_event(&events, "sandbox rejected from idle reuse")
            .fields
            .get("reason")
            .map(String::as_str),
        Some("helper_failed")
    );
}
