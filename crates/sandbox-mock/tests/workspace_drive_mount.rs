use std::sync::Arc;

use sandbox::{
    ExecResult, ExecTermination, Sandbox, SandboxError, SandboxOperation, SandboxOperationReason,
};
use sandbox_mock::{MockSandbox, MockSandboxOverrides};

#[tokio::test]
async fn local_mount_result_preserves_shared_fifo_across_sandboxes() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_workspace_drive_mount_result(Ok(ExecResult::new(64, Vec::new(), Vec::new())));
    overrides.push_workspace_drive_mount_result(Ok(ExecResult::new(65, Vec::new(), Vec::new())));
    let first = MockSandbox::with_overrides("first", Arc::clone(&overrides));
    let second = MockSandbox::with_overrides("second", Arc::clone(&overrides));
    first.push_workspace_drive_mount_result(Ok(ExecResult::new(
        7,
        b"local output".to_vec(),
        Vec::new(),
    )));

    let local = first.mount_workspace_drive().await.unwrap();
    assert_eq!(local.termination, ExecTermination::Exited { exit_code: 7 });
    assert_eq!(local.stdout, b"local output");
    assert_eq!(
        second.mount_workspace_drive().await.unwrap().termination,
        ExecTermination::Exited { exit_code: 64 }
    );
    assert_eq!(
        first.mount_workspace_drive().await.unwrap().termination,
        ExecTermination::Exited { exit_code: 65 }
    );

    let default = second.mount_workspace_drive().await.unwrap();
    assert_eq!(
        default.termination,
        ExecTermination::Exited { exit_code: 0 }
    );
    assert!(default.stdout.is_empty());
    assert!(default.stderr.is_empty());
    assert_eq!(first.workspace_drive_mount_calls(), 2);
    assert_eq!(second.workspace_drive_mount_calls(), 2);
    assert_eq!(overrides.workspace_drive_mount_calls(), 4);
}

#[tokio::test]
async fn local_mount_results_and_errors_preserve_shared_fifo_on_one_sandbox() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_workspace_drive_mount_result(Err(SandboxError::Operation {
        operation: SandboxOperation::Exec,
        reason: SandboxOperationReason::Guest,
        message: "shared mount failed".into(),
    }));
    overrides.push_workspace_drive_mount_result(Ok(ExecResult::new(
        64,
        Vec::new(),
        b"shared mount output".to_vec(),
    )));
    let sandbox = MockSandbox::with_overrides("test", Arc::clone(&overrides));
    sandbox.push_workspace_drive_mount_result(Ok(ExecResult::new(7, Vec::new(), Vec::new())));
    sandbox.push_workspace_drive_mount_result(Err(SandboxError::Operation {
        operation: SandboxOperation::Exec,
        reason: SandboxOperationReason::Guest,
        message: "local mount failed".into(),
    }));

    assert_eq!(
        sandbox.mount_workspace_drive().await.unwrap().termination,
        ExecTermination::Exited { exit_code: 7 }
    );
    assert!(matches!(
        sandbox.mount_workspace_drive().await,
        Err(SandboxError::Operation {
            operation: SandboxOperation::Exec,
            reason: SandboxOperationReason::Guest,
            message,
        }) if message == "local mount failed"
    ));
    assert!(matches!(
        sandbox.mount_workspace_drive().await,
        Err(SandboxError::Operation {
            operation: SandboxOperation::Exec,
            reason: SandboxOperationReason::Guest,
            message,
        }) if message == "shared mount failed"
    ));

    let shared = sandbox.mount_workspace_drive().await.unwrap();
    assert_eq!(
        shared.termination,
        ExecTermination::Exited { exit_code: 64 }
    );
    assert_eq!(shared.stderr, b"shared mount output");
    let default = sandbox.mount_workspace_drive().await.unwrap();
    assert_eq!(
        default.termination,
        ExecTermination::Exited { exit_code: 0 }
    );
    assert!(default.stdout.is_empty());
    assert!(default.stderr.is_empty());
    assert_eq!(sandbox.workspace_drive_mount_calls(), 5);
    assert_eq!(overrides.workspace_drive_mount_calls(), 5);
}
