use std::fmt;
use std::time::Duration;

use runner_lifecycle::LifecycleError;
use runner_lifecycle::home_mount::{ensure_home_drive_mounted, freeze_home_drive};
use sandbox::{
    ExecResult, ExecTermination, SandboxError, SandboxOperation, SandboxOperationReason,
};
use sandbox_mock::MockSandbox;

struct UnformattableDiagnostic;

impl fmt::Display for UnformattableDiagnostic {
    fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
        Err(fmt::Error)
    }
}

fn helper_failures() -> [(ExecTermination, &'static str); 5] {
    [
        (ExecTermination::Exited { exit_code: 73 }, "exit code 73"),
        (ExecTermination::TimedOut, "timed out"),
        (ExecTermination::Cancelled, "cancelled"),
        (ExecTermination::StartFailed, "start failed"),
        (ExecTermination::WaitFailed, "wait failed"),
    ]
}

#[tokio::test]
async fn mount_success_preserves_optional_guest_duration_without_formatting_identity() {
    let sandbox = MockSandbox::new("mount-success");
    for guest_duration_ms in [None, Some(0), Some(23)] {
        let mut result = ExecResult::new(0, Vec::new(), Vec::new());
        result.guest_duration_ms = guest_duration_ms;
        sandbox.push_home_drive_mount_result(Ok(result));

        assert_eq!(
            ensure_home_drive_mounted(&sandbox, UnformattableDiagnostic)
                .await
                .unwrap(),
            guest_duration_ms.map(|ms| Duration::from_millis(u64::from(ms)))
        );
    }
}

#[tokio::test]
async fn mount_helper_failures_preserve_duration_and_operation_diagnostic() {
    for (termination, description) in helper_failures() {
        for guest_duration_ms in [None, Some(31)] {
            let sandbox = MockSandbox::new("mount-failure");
            let mut result = ExecResult::new(0, Vec::new(), b"mount denied".to_vec());
            result.termination = termination;
            result.guest_duration_ms = guest_duration_ms;
            result.diagnostic = "guest-mount-diagnostic".into();
            sandbox.push_home_drive_mount_result(Ok(result));

            let failure = ensure_home_drive_mounted(&sandbox, "mount-id")
                .await
                .unwrap_err();

            assert_eq!(
                failure.guest_duration,
                guest_duration_ms.map(|ms| Duration::from_millis(u64::from(ms)))
            );
            let LifecycleError::Internal(message) = failure.error else {
                panic!("helper failure must remain an internal lifecycle error");
            };
            assert_eq!(
                message,
                format!(
                    "mount home drive failed ({description}); diagnostic (captured): guest-mount-diagnostic; stderr (captured): mount denied; diagnostic id: mount-id"
                )
            );
        }
    }
}

#[tokio::test]
async fn mount_transport_failure_keeps_sandbox_error_without_guest_duration_or_identity() {
    let sandbox = MockSandbox::new("mount-transport-failure");
    sandbox.push_home_drive_mount_result(Err(SandboxError::Operation {
        operation: SandboxOperation::MountHomeDrive,
        reason: SandboxOperationReason::GuestConnectionUnavailable,
        message: "mount transport unavailable".into(),
    }));

    let failure = ensure_home_drive_mounted(&sandbox, UnformattableDiagnostic)
        .await
        .unwrap_err();

    assert_eq!(failure.guest_duration, None);
    match failure.error {
        LifecycleError::Sandbox(SandboxError::Operation {
            operation: SandboxOperation::MountHomeDrive,
            reason: SandboxOperationReason::GuestConnectionUnavailable,
            message,
        }) => assert_eq!(message, "mount transport unavailable"),
        error => panic!("unexpected transport error: {error:?}"),
    }
}

#[tokio::test]
async fn freeze_success_projects_to_unit_without_formatting_identity() {
    let sandbox = MockSandbox::new("freeze-success");
    for guest_duration_ms in [None, Some(0), Some(47)] {
        let mut result = ExecResult::new(0, Vec::new(), Vec::new());
        result.guest_duration_ms = guest_duration_ms;
        sandbox.push_exec_result(Ok(result));

        freeze_home_drive(&sandbox, UnformattableDiagnostic)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn freeze_helper_failures_project_operation_diagnostic_to_inner_error() {
    for (termination, description) in helper_failures() {
        for guest_duration_ms in [None, Some(47)] {
            let sandbox = MockSandbox::new("freeze-failure");
            let mut result = ExecResult::new(0, Vec::new(), b"freeze denied".to_vec());
            result.termination = termination;
            result.guest_duration_ms = guest_duration_ms;
            result.diagnostic = "guest-freeze-diagnostic".into();
            sandbox.push_exec_result(Ok(result));

            let error = freeze_home_drive(&sandbox, "freeze-id").await.unwrap_err();

            let LifecycleError::Internal(message) = error else {
                panic!("helper failure must project to its inner lifecycle error");
            };
            assert_eq!(
                message,
                format!(
                    "freeze home drive failed ({description}); diagnostic (captured): guest-freeze-diagnostic; stderr (captured): freeze denied; diagnostic id: freeze-id"
                )
            );
        }
    }
}

#[tokio::test]
async fn freeze_transport_failure_projects_sandbox_error_without_formatting_identity() {
    let sandbox = MockSandbox::new("freeze-transport-failure");
    sandbox.push_exec_result(Err(SandboxError::Operation {
        operation: SandboxOperation::Exec,
        reason: SandboxOperationReason::GuestConnectionUnavailable,
        message: "freeze transport unavailable".into(),
    }));

    let error = freeze_home_drive(&sandbox, UnformattableDiagnostic)
        .await
        .unwrap_err();

    match error {
        LifecycleError::Sandbox(SandboxError::Operation {
            operation: SandboxOperation::Exec,
            reason: SandboxOperationReason::GuestConnectionUnavailable,
            message,
        }) => assert_eq!(message, "freeze transport unavailable"),
        error => panic!("unexpected transport error: {error:?}"),
    }
}

#[tokio::test]
async fn home_helper_failures_keep_bounded_redacted_output() {
    for mount in [true, false] {
        let sandbox = MockSandbox::new("home-failure-output");
        let mut result = ExecResult::new(
            73,
            b"https://example.test/stdout?token=stdout-secret".to_vec(),
            format!(
                "discarded-prefix{} https://example.test/stderr?token=stderr-secret",
                "x".repeat(9000)
            )
            .into_bytes(),
        );
        result.diagnostic = "https://example.test/diagnostic?token=diagnostic-secret".into();
        result.stderr_truncated = true;
        let error = if mount {
            sandbox.push_home_drive_mount_result(Ok(result));
            ensure_home_drive_mounted(&sandbox, "output-id")
                .await
                .unwrap_err()
                .error
        } else {
            sandbox.push_exec_result(Ok(result));
            freeze_home_drive(&sandbox, "output-id").await.unwrap_err()
        };

        let message = error.to_string();
        assert!(message.contains("stderr (last 8192 bytes, sandbox-truncated):"));
        assert!(message.contains("https://example.test/stderr?<redacted>"));
        assert!(message.contains("stdout (captured): https://example.test/stdout?<redacted>"));
        assert!(
            message.contains("diagnostic (captured): https://example.test/diagnostic?<redacted>")
        );
        assert!(message.ends_with("; diagnostic id: output-id"));
        assert!(!message.contains("discarded-prefix"));
        assert!(!message.contains("secret"));
        assert!(message.len() < 9000);
    }
}
