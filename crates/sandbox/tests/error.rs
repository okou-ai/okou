use sandbox::{
    SandboxError, SandboxInvalidStateContext, SandboxOperation, SandboxOperationReason,
    SandboxOperationTimeoutStage,
};

#[test]
fn display_includes_category_and_message() {
    let err = SandboxError::Operation {
        operation: SandboxOperation::WaitProcess,
        reason: SandboxOperationReason::BackendCrashed,
        message: "firecracker process crashed".into(),
    };

    let text = err.to_string();
    assert!(text.contains("wait process"), "got: {text}");
    assert!(text.contains("backend crashed"), "got: {text}");
    assert!(text.contains("firecracker process crashed"), "got: {text}");
}

#[test]
fn operation_timeout_display_contains_only_typed_context() {
    let err = SandboxError::OperationTimeout {
        operation: SandboxOperation::WriteFile,
        stage: SandboxOperationTimeoutStage::FrameWrite,
        timeout_ms: 60_000,
    };

    assert_eq!(
        err.to_string(),
        "sandbox write file failed (timeout during frame write after 60000 ms)"
    );
}

#[test]
fn display_includes_file_operation_labels() {
    let read_err = SandboxError::Operation {
        operation: SandboxOperation::ReadFile,
        reason: SandboxOperationReason::Guest,
        message: "missing diagnostics".into(),
    };
    let copy_err = SandboxError::Operation {
        operation: SandboxOperation::CopyFile,
        reason: SandboxOperationReason::Timeout,
        message: "copy timed out".into(),
    };
    let read_state_err = SandboxError::InvalidState {
        context: SandboxInvalidStateContext::Operation(SandboxOperation::ReadFile),
        state: "created".into(),
        message: "sandbox not running".into(),
    };
    let copy_state_err = SandboxError::InvalidState {
        context: SandboxInvalidStateContext::Operation(SandboxOperation::CopyFile),
        state: "stopped".into(),
        message: "sandbox not running".into(),
    };

    assert!(
        read_err.to_string().contains("sandbox read file failed"),
        "got: {read_err}"
    );
    assert!(
        copy_err.to_string().contains("sandbox copy file failed"),
        "got: {copy_err}"
    );
    assert!(
        read_state_err
            .to_string()
            .contains("invalid state for read file operation"),
        "got: {read_state_err}"
    );
    assert!(
        copy_state_err
            .to_string()
            .contains("invalid state for copy file operation"),
        "got: {copy_state_err}"
    );
}

#[test]
fn guest_dns_readiness_preserves_start_error_display_contract() {
    let err = SandboxError::GuestDnsReadiness {
        reason: sandbox::SandboxGuestDnsReadinessReason::ProcessTimeout,
        message: "guest resolver unavailable".into(),
    };

    assert!(matches!(
        &err,
        SandboxError::GuestDnsReadiness {
            reason: sandbox::SandboxGuestDnsReadinessReason::ProcessTimeout,
            ..
        }
    ));
    assert_eq!(
        err.to_string(),
        "sandbox start failed: guest resolver unavailable"
    );
}
