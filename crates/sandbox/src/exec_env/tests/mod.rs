use crate::{SandboxError, SandboxOperation, SandboxOperationReason, validate_exec_env_keys};

#[test]
fn invalid_exec_env_key_returns_operation_error() {
    let err = validate_exec_env_keys(SandboxOperation::Exec, &[("BAD-NAME", "x")]).unwrap_err();

    match err {
        SandboxError::Operation {
            operation,
            reason,
            message,
        } => {
            assert_eq!(operation, SandboxOperation::Exec);
            assert_eq!(reason, SandboxOperationReason::Other);
            assert!(message.contains("BAD-NAME"), "got: {message}");
        }
        other => panic!("expected operation error, got {other:?}"),
    }
}

#[test]
fn invalid_start_process_env_key_returns_operation_error() {
    let err = validate_exec_env_keys(SandboxOperation::StartProcess, &[("1BAD", "x")]).unwrap_err();

    match err {
        SandboxError::Operation {
            operation,
            reason,
            message,
        } => {
            assert_eq!(operation, SandboxOperation::StartProcess);
            assert_eq!(reason, SandboxOperationReason::Other);
            assert!(message.contains("1BAD"), "got: {message}");
        }
        other => panic!("expected operation error, got {other:?}"),
    }
}

#[test]
fn valid_env_keys_accept_empty_input_and_arbitrary_values() {
    validate_exec_env_keys(SandboxOperation::Exec, &[]).unwrap();
    validate_exec_env_keys(
        SandboxOperation::Exec,
        &[("PATH", ""), ("_", "\0\n雪"), ("a_09", "x=y")],
    )
    .unwrap();
}

#[test]
fn first_invalid_env_key_preserves_operation_and_escaped_diagnostic() {
    let err = validate_exec_env_keys(
        SandboxOperation::StartAgentProcess,
        &[
            ("GOOD", "secret"),
            ("BAD\nKEY", "private"),
            ("ALSO-BAD", "later"),
        ],
    )
    .unwrap_err();

    match err {
        SandboxError::Operation {
            operation,
            reason,
            message,
        } => {
            assert_eq!(operation, SandboxOperation::StartAgentProcess);
            assert_eq!(reason, SandboxOperationReason::Other);
            assert_eq!(message, "invalid environment variable name: BAD\\nKEY");
        }
        other => panic!("expected operation error, got {other:?}"),
    }
}
