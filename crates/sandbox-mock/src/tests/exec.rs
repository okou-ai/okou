use super::*;
use std::sync::Arc;

#[tokio::test]
async fn sandbox_default_exec_succeeds() {
    let sandbox = MockSandbox::new("test-1");
    let result = sandbox
        .exec(&ExecRequest {
            cmd: "echo hello",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            expected_exit_codes: &[],
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
        })
        .await;
    let exec = result.unwrap();
    assert_eq!(exec.termination, ExecTermination::Exited { exit_code: 0 });
    assert!(exec.stdout.is_empty());
}

#[tokio::test]
async fn sandbox_exec_lifecycle_gate_blocks_after_recording_call() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let gate = MockLifecycleGate::new();
    overrides.set_exec_lifecycle_gate(gate.clone());
    let sandbox = MockSandbox::with_overrides("gated-exec", Arc::clone(&overrides));
    let exec = tokio::spawn(async move {
        sandbox
            .exec(&ExecRequest {
                cmd: "echo gated",
                timeout: Duration::from_secs(5),
                env: &[],
                sudo: false,
                expected_exit_codes: &[],
                stdin_bytes: None,
                output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
            })
            .await
    });

    gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
    assert_eq!(overrides.exec_calls().len(), 1);
    assert!(!exec.is_finished());
    gate.release_one();
    assert_eq!(
        exec.await.unwrap().unwrap().termination,
        ExecTermination::Exited { exit_code: 0 }
    );
}

#[tokio::test]
async fn home_drive_mount_lifecycle_gate_blocks_after_recording_call() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let gate = MockLifecycleGate::new();
    overrides.set_home_drive_mount_lifecycle_gate(gate.clone());
    let sandbox = MockSandbox::with_overrides("gated-home-mount", Arc::clone(&overrides));
    let mount = tokio::spawn(async move { sandbox.mount_home_drive().await });

    gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
    assert_eq!(overrides.home_drive_mount_calls(), 1);
    assert!(!mount.is_finished());
    gate.release_one();
    assert_eq!(
        mount.await.unwrap().unwrap().termination,
        ExecTermination::Exited { exit_code: 0 }
    );
}

#[tokio::test]
async fn sandbox_exec_rejects_invalid_env_key_without_recording_call() {
    let sandbox = MockSandbox::new("test-1");
    let result = sandbox
        .exec(&ExecRequest {
            cmd: "echo hello",
            timeout: Duration::from_secs(5),
            env: &[("BAD-NAME", "x")],
            sudo: false,
            expected_exit_codes: &[],
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
        })
        .await;
    let err = match result {
        Ok(_) => panic!("invalid env key should be rejected"),
        Err(err) => err,
    };

    assert_operation_error(
        err,
        SandboxOperation::Exec,
        SandboxOperationReason::Other,
        "invalid environment variable name",
    );
    assert!(sandbox.exec_calls().is_empty());
}

#[tokio::test]
async fn sandbox_queued_exec_results() {
    let sandbox = MockSandbox::new("test-1");
    sandbox.push_exec_result(Ok(ExecResult {
        termination: ExecTermination::Exited { exit_code: 42 },
        guest_duration_ms: Some(17),
        stdout: b"out".to_vec(),
        stderr: b"err".to_vec(),
        diagnostic: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    }));
    sandbox.push_exec_result(Ok(ExecResult {
        termination: ExecTermination::WaitFailed,
        guest_duration_ms: None,
        stdout: Vec::new(),
        stderr: b"wait failed".to_vec(),
        diagnostic: "wait failed".to_string(),
        stdout_truncated: false,
        stderr_truncated: false,
    }));
    sandbox.push_exec_result(Err(SandboxError::Operation {
        operation: SandboxOperation::Exec,
        reason: SandboxOperationReason::Guest,
        message: "boom".into(),
    }));

    let req = ExecRequest {
        cmd: "test",
        timeout: Duration::from_secs(5),
        env: &[],
        sudo: false,
        expected_exit_codes: &[],
        stdin_bytes: None,
        output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
    };

    // First call returns queued result.
    let r1 = sandbox.exec(&req).await.unwrap();
    assert_eq!(r1.termination, ExecTermination::Exited { exit_code: 42 });
    assert_eq!(r1.guest_duration_ms, Some(17));
    assert_eq!(r1.stdout, b"out");

    // Second call preserves a queued non-exited terminal state.
    let r2 = sandbox.exec(&req).await.unwrap();
    assert_eq!(r2.termination, ExecTermination::WaitFailed);
    assert_eq!(r2.stderr, b"wait failed");
    assert_eq!(r2.diagnostic, "wait failed");

    // Third call returns queued error.
    let r3 = sandbox.exec(&req).await;
    assert!(r3.is_err());

    // Fourth call falls back to default (exit 0).
    let r4 = sandbox.exec(&req).await.unwrap();
    assert_eq!(r4.termination, ExecTermination::Exited { exit_code: 0 });
}

#[tokio::test]
async fn home_drive_mount_results_are_isolated_from_generic_exec() {
    let sandbox = MockSandbox::new("test-1");
    sandbox.push_home_drive_mount_result(Ok(ExecResult::new(
        64,
        b"mount out".to_vec(),
        b"mount failed".to_vec(),
    )));
    sandbox.push_exec_result(Ok(ExecResult::new(7, b"exec out".to_vec(), Vec::new())));

    let mount = sandbox.mount_home_drive().await.unwrap();
    assert_eq!(mount.termination, ExecTermination::Exited { exit_code: 64 });
    assert_eq!(mount.stderr, b"mount failed");
    assert_eq!(sandbox.home_drive_mount_calls(), 1);

    let exec = sandbox
        .exec(&ExecRequest {
            cmd: "test",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            expected_exit_codes: &[],
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
        })
        .await
        .unwrap();
    assert_eq!(exec.termination, ExecTermination::Exited { exit_code: 7 });
    assert_eq!(exec.stdout, b"exec out");
}

#[tokio::test]
async fn shared_home_drive_mount_results_are_consumed_across_sandboxes() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_home_drive_mount_result(Ok(ExecResult::new(
        64,
        Vec::new(),
        b"first mount failed".to_vec(),
    )));
    let first = MockSandbox::with_overrides("first", Arc::clone(&overrides));
    let second = MockSandbox::with_overrides("second", Arc::clone(&overrides));

    assert_eq!(
        first.mount_home_drive().await.unwrap().termination,
        ExecTermination::Exited { exit_code: 64 }
    );
    assert_eq!(
        second.mount_home_drive().await.unwrap().termination,
        ExecTermination::Exited { exit_code: 0 }
    );
    assert_eq!(overrides.home_drive_mount_calls(), 2);
}

#[tokio::test]
async fn sandbox_persistent_exec_matcher_serves_repeated_calls_after_one_shot_override() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.add_persistent_exec_matcher(ExecMatcher {
        pattern: "prepare".into(),
        exit_code: 0,
        stdout: b"healthy".to_vec(),
        stderr: Vec::new(),
    });
    overrides.add_exec_matcher(ExecMatcher {
        pattern: "prepare".into(),
        exit_code: 4,
        stdout: Vec::new(),
        stderr: b"cleanup failed".to_vec(),
    });
    let sandbox = MockSandbox::with_overrides("persistent", overrides);
    let request = ExecRequest {
        cmd: "prepare",
        timeout: Duration::from_secs(5),
        env: &[],
        sudo: false,
        expected_exit_codes: &[],
        stdin_bytes: None,
        output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
    };

    assert_eq!(
        sandbox.exec(&request).await.unwrap().termination,
        ExecTermination::Exited { exit_code: 4 }
    );
    assert_eq!(sandbox.exec(&request).await.unwrap().stdout, b"healthy");
    assert_eq!(sandbox.exec(&request).await.unwrap().stdout, b"healthy");
}

#[tokio::test]
async fn sandbox_exec_applies_mock_capture_budget() {
    let sandbox = MockSandbox::new("test-1");
    sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        b"stdout".to_vec(),
        b"stderr".to_vec(),
    )));

    let result = sandbox
        .exec(&ExecRequest {
            cmd: "test",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            expected_exit_codes: &[],
            stdin_bytes: None,
            output_limits: ExecOutputLimits::separate(3, 4),
        })
        .await
        .unwrap();

    assert_eq!(result.stdout, b"std");
    assert!(result.stdout_truncated);
    assert_eq!(result.stderr, b"stde");
    assert!(result.stderr_truncated);
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
}

#[tokio::test]
async fn sandbox_exec_matcher_applies_capture_limits_and_is_one_shot() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.add_exec_matcher(ExecMatcher {
        pattern: "echo hello".into(),
        exit_code: 42,
        stdout: b"stdout".to_vec(),
        stderr: b"stderr".to_vec(),
    });
    let factory = MockSandboxFactory::with_overrides(overrides);
    let sandbox = factory.create(test_sandbox_config()).await.unwrap();
    let request = ExecRequest {
        cmd: "echo hello world",
        timeout: Duration::from_secs(5),
        env: &[],
        sudo: false,
        expected_exit_codes: &[],
        stdin_bytes: None,
        output_limits: ExecOutputLimits::separate(3, 4),
    };

    let matched = sandbox.exec(&request).await.unwrap();
    assert_eq!(
        matched.termination,
        ExecTermination::Exited { exit_code: 42 }
    );
    assert_eq!(matched.stdout, b"std");
    assert!(matched.stdout_truncated);
    assert_eq!(matched.stderr, b"stde");
    assert!(matched.stderr_truncated);

    let fallback = sandbox.exec(&request).await.unwrap();
    assert_eq!(
        fallback.termination,
        ExecTermination::Exited { exit_code: 0 }
    );
    assert!(fallback.stdout.is_empty());
    assert!(!fallback.stdout_truncated);
    assert!(fallback.stderr.is_empty());
    assert!(!fallback.stderr_truncated);
}
