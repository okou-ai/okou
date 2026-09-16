use super::*;
use crate::executor::{SandboxReuseDisposition, SandboxReuseRejection, SandboxReuseTerminal};
use guest_contracts::diagnostics::{
    EventDeliveryAcceptanceOutcome, EventDeliveryDiagnostic, EventDeliveryFailedBatchDiagnostic,
    HttpAttemptFailureKind, HttpCompletedAttemptDiagnostic, WorkloadResourceLimitDiagnostic,
};

#[tokio::test]
async fn execute_inner_appends_stream_overflow_marker() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let mut exit = ProcessExit::new(1, 0, Vec::new(), Vec::new());
    exit.stream_overflowed = true;
    overrides.push_wait_process_exit(exit);
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);

    let (exit_code, error_msg) = run_new_sandbox_status(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());
    let system_stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    assert_eq!(system_stream_log, STDOUT_STREAM_OVERFLOW_MARKER);
}

#[tokio::test]
async fn execute_inner_appends_stream_limit_marker() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"partial stdout".to_vec(),
        truncated: true,
    }]);
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);

    let (exit_code, error_msg) = run_new_sandbox_status(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());
    let system_stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    let mut expected = b"partial stdout\n".to_vec();
    expected.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
    assert_eq!(system_stream_log, expected);
}

#[tokio::test]
async fn execute_prepared_marks_stdout_incomplete_when_process_cancel_send_fails() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.set_keep_stdout_sender_open(true);
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"partial stdout".to_vec(),
        truncated: true,
    }]);
    overrides.push_process_cancel_error("cancel write failed");
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let source_ip = sandbox.source_ip().to_string();
    let network_log_session = register_proxy(&config, &ctx, &source_ip).await.unwrap();
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_cancel = cancel.clone();
    let run_task = tokio::spawn(async move {
        let mut telemetry = test_telemetry(&config, &ctx);
        execute_prepared_sandbox_run_with_process_cancel_timeouts(
            PreparedSandboxRun {
                sandbox,
                source_ip,
                network_log_session,
                prepared_guest_runtime: None,
            },
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            PreparedRunInputs::new(
                RunControls::new(run_cancel, None),
                prepare_run_payload_for_run(&ctx).unwrap(),
            ),
            ProcessCancelTimeouts {
                write: Duration::from_secs(1),
                terminal_grace: Duration::ZERO,
                cooperative_grace: Duration::ZERO,
            },
        )
        .await
    });
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("run should enter process wait before cancellation");
    cancel.cancel();

    let outcome = tokio::time::timeout(Duration::from_secs(5), run_task)
        .await
        .expect("cancel-send failure must not wait for stdout sender drop")
        .unwrap();

    assert_eq!(outcome.exit_code(), EXIT_SIGKILL);
    assert_eq!(overrides.process_cancel_calls().len(), 1);
    let stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    let mut expected = b"partial stdout\n".to_vec();
    expected.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
    expected.extend_from_slice(STDOUT_STREAM_INCOMPLETE_MARKER);
    assert_eq!(stream_log, expected);
}

#[tokio::test]
async fn execute_prepared_marks_stdout_incomplete_when_terminal_grace_expires() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.set_process_cancel_releases_wait_gate(false);
    overrides.set_keep_stdout_sender_open(true);
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"partial stdout".to_vec(),
        truncated: true,
    }]);
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let source_ip = sandbox.source_ip().to_string();
    let network_log_session = register_proxy(&config, &ctx, &source_ip).await.unwrap();
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_cancel = cancel.clone();
    let run_task = tokio::spawn(async move {
        let mut telemetry = test_telemetry(&config, &ctx);
        execute_prepared_sandbox_run_with_process_cancel_timeouts(
            PreparedSandboxRun {
                sandbox,
                source_ip,
                network_log_session,
                prepared_guest_runtime: None,
            },
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            PreparedRunInputs::new(
                RunControls::new(run_cancel, None),
                prepare_run_payload_for_run(&ctx).unwrap(),
            ),
            ProcessCancelTimeouts {
                write: Duration::from_secs(1),
                terminal_grace: Duration::ZERO,
                cooperative_grace: Duration::ZERO,
            },
        )
        .await
    });
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("run should enter process wait before cancellation");
    cancel.cancel();

    let outcome = tokio::time::timeout(Duration::from_secs(5), run_task)
        .await
        .expect("terminal-grace expiry must not wait for stdout sender drop")
        .unwrap();

    assert_eq!(outcome.exit_code(), EXIT_SIGKILL);
    assert_eq!(overrides.process_cancel_calls().len(), 1);
    let stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    let mut expected = b"partial stdout\n".to_vec();
    expected.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
    expected.extend_from_slice(STDOUT_STREAM_INCOMPLETE_MARKER);
    assert_eq!(stream_log, expected);
}

#[tokio::test]
async fn execute_inner_preserves_raw_sigkill_with_unrelated_kernel_tail() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"partial stdout".to_vec(),
        truncated: true,
    }]);
    overrides.push_wait_process_exit(ProcessExit::new(1, EXIT_SIGKILL, Vec::new(), Vec::new()));
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "dmesg".to_string(),
        exit_code: 0,
        stdout: b"Out of memory: Killed process 1234".to_vec(),
        stderr: Vec::new(),
    });
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);

    let outcome = run_new_sandbox_outcome(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    let failure = outcome.failure.as_ref().expect("expected signal failure");
    assert_eq!(outcome.exit_code(), EXIT_SIGKILL);
    assert_eq!(failure.error.as_str(), "Agent exited with code 137");
    assert_eq!(
        outcome.sandbox_reuse_disposition,
        SandboxReuseDisposition::Eligible(SandboxReuseTerminal::NonzeroExit),
    );
    assert!(failure.resource_diagnostics.is_none());
    let system_stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    let mut expected = b"partial stdout\n".to_vec();
    expected.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
    assert_eq!(system_stream_log, expected);
}

#[tokio::test]
async fn execute_inner_preserves_workload_oom_diagnostic_and_exit_code() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(1, EXIT_SIGKILL, Vec::new(), Vec::new()));
    let workload_resource_limit = WorkloadResourceLimitDiagnostic {
        memory_max_events: 3,
        memory_oom_events: 2,
        memory_oom_kill_events: 1,
        memory_oom_group_kill_events: 0,
        pids_max_events: 0,
    };
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("consume memory"),
    )
    .with_cli_exit_code(EXIT_SIGKILL)
    .with_cli_observed_exit(CliObservedExitDiagnostic::from_signal(libc::SIGKILL))
    .with_failure_detail_source(FailureDetailSource::FallbackExitCode)
    .with_workload_resource_limit(workload_resource_limit);
    overrides.push_read_file_result(Ok(Some(serde_json::to_vec(&diagnostic).unwrap())));
    let guest_error = "Process killed by signal 9; workload resource limit reached";
    overrides.push_read_file_result(Ok(Some(guest_error.as_bytes().to_vec())));
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "dmesg".to_string(),
        exit_code: 0,
        stdout: b"Out of memory: Killed process 1234".to_vec(),
        stderr: Vec::new(),
    });
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let outcome = run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
        .await
        .unwrap();

    let failure = outcome.failure.as_ref().expect("expected workload failure");
    assert_eq!(failure.exit_code, EXIT_SIGKILL);
    assert_eq!(failure.error, guest_error);
    assert_eq!(failure.diagnostic, Some(diagnostic));
    assert!(failure.resource_diagnostics.is_none());
    assert_eq!(
        outcome.sandbox_reuse_disposition,
        SandboxReuseDisposition::Eligible(SandboxReuseTerminal::NonzeroExit),
    );
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains("dmesg") && !call.cmd.contains("guest-agent-binary"))
    );
}

#[tokio::test]
async fn execute_inner_preserves_system_stream_log_after_nonzero_exit_guest_copy() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"bootstrap diagnostic\n".to_vec(),
        truncated: false,
    }]);
    overrides.push_wait_process_exit(ProcessExit::new(1, 126, Vec::new(), Vec::new()));
    overrides.push_copy_file_result(Ok(b"guest system log\n".to_vec()));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let source_ip = sandbox.source_ip().to_string();
    let network_log_session = register_proxy(&config, &ctx, &source_ip).await.unwrap();
    let system_log_path = config.log_paths.system_log(ctx.run_id);
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);
    let mut telemetry = test_telemetry(&config, &ctx);

    let (outcome, events) = capture_async_events(execute_prepared_sandbox_run(
        PreparedSandboxRun {
            sandbox,
            source_ip,
            network_log_session,
            prepared_guest_runtime: None,
        },
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        PreparedRunInputs::new(
            RunControls::new(tokio_util::sync::CancellationToken::new(), None),
            prepare_run_payload_for_run(&ctx).unwrap(),
        ),
    ))
    .await;

    assert_eq!(outcome.exit_code(), 126);
    assert_eq!(outcome.error(), Some("Agent exited with code 126"));
    assert!(outcome.sandbox.is_some());
    assert_proxy_registry_empty(dir.path()).await;
    let system_log = tokio::fs::read(&system_log_path).await.unwrap();
    assert_eq!(system_log, b"guest system log\n");
    let system_stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    assert_eq!(system_stream_log, b"bootstrap diagnostic\n");
    let bootstrap_event = captured_event(&events, "agent bootstrap abnormal exit diagnostics");
    assert_eq!(
        bootstrap_event
            .fields
            .get("stdout_stream_bytes")
            .map(String::as_str),
        Some("21")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn execute_prepared_sandbox_run_logs_discovered_guest_session_id() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let raw_session_id = "sess-sensitive-first-run-17975";
    overrides.push_wait_process_exit(ProcessExit::new(1, 0, Vec::new(), Vec::new()));
    overrides.push_read_file_result(Ok(None));
    overrides.push_read_file_result(Ok(Some(raw_session_id.as_bytes().to_vec())));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let source_ip = sandbox.source_ip().to_string();
    let network_log_session = register_proxy(&config, &ctx, &source_ip).await.unwrap();
    let mut telemetry = test_telemetry(&config, &ctx);

    let (outcome, events) = capture_async_events(execute_prepared_sandbox_run(
        PreparedSandboxRun {
            sandbox,
            source_ip,
            network_log_session,
            prepared_guest_runtime: None,
        },
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        PreparedRunInputs::new(
            RunControls::new(tokio_util::sync::CancellationToken::new(), None),
            prepare_run_payload_for_run(&ctx).unwrap(),
        ),
    ))
    .await;

    assert_eq!(outcome.exit_code(), 0);
    assert_eq!(
        outcome.discovered_cli_agent_session_id.as_deref(),
        Some(raw_session_id)
    );
    let event = captured_event(&events, "read guest CLI agent session ID after execution");
    assert_eq!(
        event.fields.get("session_id").map(String::as_str),
        Some(raw_session_id)
    );
}

#[tokio::test(flavor = "current_thread")]
async fn execute_prepared_sandbox_run_discovers_guest_session_id_after_nonzero_exit() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let raw_session_id = "sess-failed-first-run";
    overrides.push_wait_process_exit(ProcessExit::new(1, 7, Vec::new(), Vec::new()));
    overrides.push_read_file_result(Ok(None));
    overrides.push_read_file_result(Ok(None));
    overrides.push_read_file_result(Ok(Some(raw_session_id.as_bytes().to_vec())));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let source_ip = sandbox.source_ip().to_string();
    let network_log_session = register_proxy(&config, &ctx, &source_ip).await.unwrap();
    let mut telemetry = test_telemetry(&config, &ctx);

    let (outcome, events) = capture_async_events(execute_prepared_sandbox_run(
        PreparedSandboxRun {
            sandbox,
            source_ip,
            network_log_session,
            prepared_guest_runtime: None,
        },
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        PreparedRunInputs::new(
            RunControls::new(tokio_util::sync::CancellationToken::new(), None),
            prepare_run_payload_for_run(&ctx).unwrap(),
        ),
    ))
    .await;

    assert_eq!(outcome.exit_code(), 7);
    assert_eq!(
        outcome.workspace_reuse_result,
        Some(crate::types::WorkspaceReuseResult::NotConfigured),
    );
    assert_eq!(outcome.error(), Some("Agent exited with code 7"));
    assert_eq!(
        outcome.discovered_cli_agent_session_id.as_deref(),
        Some(raw_session_id)
    );
    let event = captured_event(&events, "read guest CLI agent session ID after execution");
    assert_eq!(
        event.fields.get("session_id").map(String::as_str),
        Some(raw_session_id)
    );
}

#[tokio::test(flavor = "current_thread")]
async fn execute_prepared_sandbox_run_canonicalizes_codex_discovered_cli_agent_session_id() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let raw_session_id = "019E9154C30470F0ADDE36EFB1BE1701";
    let canonical_session_id = "019e9154-c304-70f0-adde-36efb1be1701";
    overrides.push_wait_process_exit(ProcessExit::new(1, 0, Vec::new(), Vec::new()));
    overrides.push_read_file_result(Ok(None));
    overrides.push_read_file_result(Ok(Some(raw_session_id.as_bytes().to_vec())));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let source_ip = sandbox.source_ip().to_string();
    let network_log_session = register_proxy(&config, &ctx, &source_ip).await.unwrap();
    let mut telemetry = test_telemetry(&config, &ctx);

    let (outcome, events) = capture_async_events(execute_prepared_sandbox_run(
        PreparedSandboxRun {
            sandbox,
            source_ip,
            network_log_session,
            prepared_guest_runtime: None,
        },
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        PreparedRunInputs::new(
            RunControls::new(tokio_util::sync::CancellationToken::new(), None),
            prepare_run_payload_for_run(&ctx).unwrap(),
        ),
    ))
    .await;

    assert_eq!(outcome.exit_code(), 0);
    assert_eq!(
        outcome.discovered_cli_agent_session_id.as_deref(),
        Some(canonical_session_id)
    );
    let event = captured_event(&events, "read guest CLI agent session ID after execution");
    assert_eq!(
        event.fields.get("session_id").map(String::as_str),
        Some(canonical_session_id)
    );
}

#[tokio::test(flavor = "current_thread")]
async fn execute_prepared_sandbox_run_ignores_non_uuid_codex_discovered_cli_agent_session_id() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let raw_session_id = "codex-safe-but-not-uuid";
    overrides.push_wait_process_exit(ProcessExit::new(1, 0, Vec::new(), Vec::new()));
    overrides.push_read_file_result(Ok(None));
    overrides.push_read_file_result(Ok(Some(raw_session_id.as_bytes().to_vec())));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let source_ip = sandbox.source_ip().to_string();
    let network_log_session = register_proxy(&config, &ctx, &source_ip).await.unwrap();
    let mut telemetry = test_telemetry(&config, &ctx);

    let (outcome, events) = capture_async_events(execute_prepared_sandbox_run(
        PreparedSandboxRun {
            sandbox,
            source_ip,
            network_log_session,
            prepared_guest_runtime: None,
        },
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        PreparedRunInputs::new(
            RunControls::new(tokio_util::sync::CancellationToken::new(), None),
            prepare_run_payload_for_run(&ctx).unwrap(),
        ),
    ))
    .await;

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.discovered_cli_agent_session_id.is_none());
    let event = captured_event(&events, "ignoring invalid guest session ID for framework");
    assert_eq!(
        event.fields.get("framework").map(String::as_str),
        Some("codex")
    );
    assert_eq!(
        event.fields.get("session_id").map(String::as_str),
        Some(raw_session_id)
    );
}

#[tokio::test]
async fn execute_inner_marks_stdout_incomplete_on_wait_process_error() {
    // Simulate wait_process timeout: stdout channel stays open (sender held
    // alive by MockSandbox), wait_process returns error.
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_error(
        "wait timeout",
    ));
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"wait error stdout".to_vec(),
        truncated: false,
    }]);
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);
    let outcome = run_new_sandbox_outcome(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    assert_eq!(outcome.exit_code(), 124);
    let failure = outcome.failure.as_ref().expect("expected failure");
    assert_eq!(failure.exit_code, 124);
    assert!(failure.error.contains("wait timeout"), "got: {failure:?}");
    match failure.kind {
        ExecutionFailureKind::RunnerJobTimeout {
            timeout_ms,
            elapsed_ms: _,
            guest_duration_ms,
        } => {
            assert_eq!(timeout_ms, 7_200_000);
            assert_eq!(guest_duration_ms, None);
        }
        ExecutionFailureKind::Generic => panic!("expected runner job timeout failure kind"),
    }
    assert_eq!(
        outcome.sandbox_reuse_disposition,
        SandboxReuseDisposition::Ineligible(SandboxReuseRejection::UnconfirmedTimeout),
    );
    assert!(
        outcome.sandbox.is_some(),
        "sandbox must be returned on post-start execution failure"
    );
    assert!(
        outcome.network_log_session.is_some(),
        "network log session must be returned on post-start execution failure"
    );
    let stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    let mut expected = b"wait error stdout\n".to_vec();
    expected.extend_from_slice(STDOUT_STREAM_INCOMPLETE_MARKER);
    assert_eq!(stream_log, expected);
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_inner_preserves_incomplete_stdout_on_backend_crash() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(
        sandbox_mock::MockSandboxOverrides::with_wait_process_error_reason(
            SandboxOperationReason::BackendCrashed,
            "firecracker process crashed",
        ),
    );
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"crash stdout".to_vec(),
        truncated: false,
    }]);
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);

    let outcome = run_new_sandbox_outcome(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    assert_eq!(outcome.exit_code(), 1);
    assert!(
        outcome
            .error()
            .is_some_and(|error| error.contains("firecracker process crashed"))
    );
    let stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    let mut expected = b"crash stdout\n".to_vec();
    expected.extend_from_slice(STDOUT_STREAM_INCOMPLETE_MARKER);
    assert_eq!(stream_log, expected);
    assert_proxy_registry_empty(dir.path()).await;
}

async fn capture_async_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
where
    F: std::future::Future,
{
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    let output = future.await;
    drop(guard);
    (output, captured.entries())
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
async fn execute_inner_nonzero_without_guest_error_returns_failure_message() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_code(
        7,
    ));
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);

    let (exit_code, error) =
        run_new_sandbox_status(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();

    assert_eq!(exit_code, 7);
    assert_eq!(error.as_deref(), Some("Agent exited with code 7"));
}

#[tokio::test]
async fn execute_inner_non_exited_zero_code_is_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let mut exit = ProcessExit::new(1, 0, Vec::new(), Vec::new());
    exit.termination = ExecTermination::WaitFailed;
    overrides.push_wait_process_exit(exit);
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let ctx = minimal_context();
    let outcome = run_new_sandbox_outcome(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    let failure = outcome.failure.as_ref().expect("expected failure");
    assert_eq!(outcome.exit_code(), 1);
    assert_eq!(failure.exit_code, 1);
    assert_eq!(failure.error, "Agent exited with code 1");
    assert_eq!(failure.kind, ExecutionFailureKind::Generic);
    assert_eq!(
        outcome.sandbox_reuse_disposition,
        SandboxReuseDisposition::Ineligible(SandboxReuseRejection::ExecutionUncertain),
    );
    assert!(outcome.discovered_cli_agent_session_id.is_none());
    assert!(
        overrides
            .exec_calls()
            .iter()
            .any(|call| call.cmd.contains("guest-agent-binary"))
    );
}

#[tokio::test]
async fn execute_inner_non_exited_diagnostic_is_user_visible() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let mut exit = ProcessExit::new(1, 0, Vec::new(), Vec::new());
    exit.termination = ExecTermination::WaitFailed;
    exit.diagnostic = "wait failed inside provider".to_string();
    overrides.push_wait_process_exit(exit);
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let ctx = minimal_context();
    let outcome = run_new_sandbox_outcome(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    let failure = outcome.failure.as_ref().expect("expected failure");
    assert_eq!(outcome.exit_code(), 1);
    assert_eq!(failure.exit_code, 1);
    assert_eq!(failure.error, "wait failed inside provider");
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains("guest-agent-binary"))
    );
}

#[tokio::test]
async fn execute_inner_guest_process_timeout_marks_failure_kind() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let mut exit = ProcessExit::new(1, 124, Vec::new(), b"Timeout".to_vec());
    exit.termination = ExecTermination::TimedOut;
    exit.guest_duration_ms = Some(7_200_084);
    overrides.push_wait_process_exit(exit);
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let outcome = run_new_sandbox_outcome(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    let failure = outcome.failure.as_ref().expect("expected timeout failure");
    assert_eq!(failure.exit_code, 124);
    assert_eq!(failure.error, "Timeout");
    match failure.kind {
        ExecutionFailureKind::RunnerJobTimeout {
            timeout_ms,
            elapsed_ms: _,
            guest_duration_ms,
        } => {
            assert_eq!(timeout_ms, 7_200_000);
            assert_eq!(guest_duration_ms, Some(7_200_084));
        }
        ExecutionFailureKind::Generic => panic!("expected runner job timeout failure kind"),
    }
    assert_eq!(
        outcome.sandbox_reuse_disposition,
        SandboxReuseDisposition::Ineligible(SandboxReuseRejection::UnconfirmedTimeout),
    );
}

#[tokio::test]
async fn execute_inner_guest_process_timeout_waits_for_terminal_grace_and_copies_logs() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let mut exit = ProcessExit::new(1, 124, Vec::new(), b"Timeout".to_vec());
    exit.termination = ExecTermination::TimedOut;
    exit.guest_duration_ms = Some(7_200_084);
    overrides.push_wait_process_exit(exit);
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let ctx = minimal_context();
    let outcome = run_new_sandbox_outcome(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    let start_calls = overrides.start_agent_process_calls();
    assert_eq!(start_calls.len(), 1);
    assert_eq!(start_calls[0].timeout, job_supervisor_timeout());

    let wait_calls = overrides.wait_process_calls();
    assert_eq!(wait_calls.len(), 1);
    assert_eq!(wait_calls[0].timeout, job_terminal_wait_timeout());

    let failure = outcome.failure.as_ref().expect("expected timeout failure");
    match failure.kind {
        ExecutionFailureKind::RunnerJobTimeout {
            timeout_ms,
            elapsed_ms: _,
            guest_duration_ms,
        } => {
            assert_eq!(timeout_ms, JOB_TIMEOUT.as_millis());
            assert_eq!(guest_duration_ms, Some(7_200_084));
        }
        ExecutionFailureKind::Generic => panic!("expected runner job timeout failure kind"),
    }

    let copy_calls = overrides.copy_file_calls();
    assert_eq!(copy_calls.len(), 3);
    assert!(
        copy_calls[0].path.ends_with("/system.log"),
        "unexpected copy calls: {copy_calls:#?}"
    );
    assert!(
        copy_calls[1].path.ends_with("/metrics.jsonl"),
        "unexpected copy calls: {copy_calls:#?}"
    );
    assert!(
        copy_calls[2].path.ends_with("/sandbox-ops.jsonl"),
        "unexpected copy calls: {copy_calls:#?}"
    );
}

#[tokio::test]
async fn execute_inner_timeout_without_stderr_uses_timeout_message() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let mut exit = ProcessExit::new(1, 0, Vec::new(), Vec::new());
    exit.termination = ExecTermination::TimedOut;
    exit.guest_duration_ms = Some(7_200_084);
    overrides.push_wait_process_exit(exit);
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let ctx = minimal_context();
    let outcome = run_new_sandbox_outcome(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    let failure = outcome.failure.as_ref().expect("expected timeout failure");
    assert_eq!(outcome.exit_code(), 124);
    assert_eq!(failure.exit_code, 124);
    assert_eq!(failure.error, "Timeout");
    match failure.kind {
        ExecutionFailureKind::RunnerJobTimeout {
            timeout_ms,
            elapsed_ms: _,
            guest_duration_ms,
        } => {
            assert_eq!(timeout_ms, 7_200_000);
            assert_eq!(guest_duration_ms, Some(7_200_084));
        }
        ExecutionFailureKind::Generic => panic!("expected runner job timeout failure kind"),
    }
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains("guest-agent-binary"))
    );
}

#[tokio::test]
async fn execute_inner_ordinary_124_timeout_text_is_generic_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(1, 124, Vec::new(), b"Timeout".to_vec()));
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let outcome = run_new_sandbox_outcome(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    let failure = outcome.failure.as_ref().expect("expected failure");
    assert_eq!(failure.exit_code, 124);
    assert_eq!(failure.error, "Timeout");
    assert_eq!(failure.kind, ExecutionFailureKind::Generic);
}

#[tokio::test]
async fn execute_inner_structured_guest_execution_timeout_marks_failure_kind() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(1, 124, Vec::new(), Vec::new()));
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliExecutionError,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("/help"),
    )
    .with_cli_exit_code(143)
    .with_cli_termination(guest_contracts::diagnostics::CliTerminationDiagnostic::new(
        guest_contracts::diagnostics::CliTerminationReason::ExecutionTimeout,
    ));
    overrides.push_read_file_result(Ok(Some(serde_json::to_vec(&diagnostic).unwrap())));
    overrides.push_read_file_result(Ok(Some(b"Agent execution timed out".to_vec())));
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let outcome = run_new_sandbox_outcome(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    let failure = outcome.failure.as_ref().expect("expected failure");
    assert_eq!(failure.exit_code, 124);
    assert_eq!(failure.error, "Agent execution timed out");
    match failure.kind {
        ExecutionFailureKind::RunnerJobTimeout {
            timeout_ms,
            elapsed_ms: _,
            guest_duration_ms,
        } => {
            assert_eq!(timeout_ms, JOB_TIMEOUT.as_millis());
            assert_eq!(guest_duration_ms, None);
        }
        ExecutionFailureKind::Generic => panic!("expected runner job timeout failure kind"),
    }
    assert_eq!(
        outcome.sandbox_reuse_disposition,
        SandboxReuseDisposition::Eligible(SandboxReuseTerminal::ExecutionTimeout),
    );
}

#[tokio::test]
async fn execute_inner_abnormal_exit_collects_guest_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(1, 126, Vec::new(), Vec::new()));
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "guest-agent-binary".to_string(),
        exit_code: 0,
        stdout: format!(
            "/dev/root       7.8G  7.4G   20K 100% /\n/dev/vdb         16G   24K   15G   1% /home/user/workspace\nMem:            3934        3310         255           0         552         624\n{}\n== rootfs-usage ==\n/tmp bytes=4194304 entries=4096 status=partial reason=entries\n== processes ==\n73\n",
            "x".repeat(5000)
        ).into_bytes(),
        stderr: Vec::new(),
    });
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let ctx = minimal_context();
    let (outcome, events) = capture_async_events(run_new_sandbox_outcome(
        &factory,
        &ctx,
        &config,
        &default_params(),
    ))
    .await;
    let outcome = outcome.unwrap();

    let failure = outcome.failure.as_ref().expect("expected failure");
    assert_eq!(failure.exit_code, 126);
    assert_eq!(failure.error, "Agent exited with code 126");
    let resource_diagnostics = failure
        .resource_diagnostics
        .expect("expected resource diagnostics");
    assert_eq!(
        resource_diagnostics.failure_kind,
        Some(ResourceFailureKind::GuestRootFilesystemFull)
    );
    assert_eq!(resource_diagnostics.guest_root_fs_used_percent, Some(100));
    assert_eq!(resource_diagnostics.guest_root_fs_available_kb, Some(20));
    assert_eq!(
        resource_diagnostics.guest_workspace_fs_used_percent,
        Some(1)
    );
    assert_eq!(resource_diagnostics.guest_memory_available_mb, Some(624));
    let calls = overrides.exec_calls();
    let diagnostic_calls: Vec<&sandbox_mock::ExecCall> = calls
        .iter()
        .filter(|call| call.cmd.contains("guest-agent-binary"))
        .collect();
    assert_eq!(diagnostic_calls.len(), 1);
    let call = diagnostic_calls[0];
    assert!(call.cmd.contains("guest-agent-binary"));
    let active_diagnostic_cmd = call
        .cmd
        .lines()
        .map(str::trim_start)
        .filter(|line| !line.starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");
    for forbidden in ["environ", "printenv", "ps aux", "ps -ef", "ps e"] {
        assert!(
            !active_diagnostic_cmd.contains(forbidden),
            "diagnostic command must not collect environment values via {forbidden}"
        );
    }
    assert!(
        !active_diagnostic_cmd
            .lines()
            .any(|line| line == "env" || line.starts_with("env ")),
        "diagnostic command must not collect raw environment output"
    );
    assert!(active_diagnostic_cmd.contains("df -P -k / /home/user/workspace"));
    assert!(active_diagnostic_cmd.contains("df -P -i / /home/user/workspace"));
    for command in ["ls -l", "stat", "file", "sha256sum"] {
        let expected = format!(
            "{command} {} 2>&1",
            guest_contracts::guest_binary::AGENT_PATH
        );
        assert!(
            active_diagnostic_cmd.lines().any(|line| line == expected),
            "diagnostic command must inspect the canonical Guest Agent path with {command}"
        );
    }
    assert!(active_diagnostic_cmd.contains("section rootfs-usage"));
    let mut syntax_check = std::process::Command::new("sh")
        .arg("-n")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    std::io::Write::write_all(&mut syntax_check.stdin.take().unwrap(), call.cmd.as_bytes())
        .unwrap();
    assert!(syntax_check.wait().unwrap().success());
    let event = captured_event(&events, "agent abnormal exit in-vm diagnostics");
    assert_eq!(
        event.fields.get("guest_root_fs_usage").map(String::as_str),
        Some("/tmp bytes=4194304 entries=4096 status=partial reason=entries")
    );
    assert_eq!(call.timeout, AGENT_ABNORMAL_EXIT_DIAGNOSTIC_TIMEOUT);
    assert!(call.env_keys.is_empty());
    assert!(call.sudo);
    assert!(call.stdin_bytes.is_none());
    assert_eq!(call.output_limits, EXEC_OUTPUT_LIMIT_64_KIB);
}

#[tokio::test]
async fn execute_inner_keeps_partial_resource_output_when_diagnostic_helper_fails() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(1, 126, Vec::new(), Vec::new()));
    overrides.add_exec_result_matcher(
        "guest-agent-binary",
        ExecResult {
            termination: ExecTermination::WaitFailed,
            guest_duration_ms: None,
            stdout: b"/dev/root       7.8G  7.4G   20K 100% /\n/dev/vdb         16G   24K   15G   1% /home/user/workspace\nMem:            3934        3310         255           0         552         624\n\n== rootfs-usage ==\n/tmp status=started\n".to_vec(),
            stderr: b"wait failed".to_vec(),
            diagnostic: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        },
    );
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let (outcome, events) = capture_async_events(run_new_sandbox_outcome(
        &factory,
        &ctx,
        &config,
        &default_params(),
    ))
    .await;
    let outcome = outcome.unwrap();

    let failure = outcome.failure.as_ref().expect("expected failure");
    assert_eq!(failure.exit_code, 126);
    assert_eq!(failure.error, "Agent exited with code 126");
    assert_eq!(
        failure
            .resource_diagnostics
            .expect("valid partial resource output should be retained")
            .failure_kind,
        Some(ResourceFailureKind::GuestRootFilesystemFull)
    );
    let event = captured_event(&events, "agent abnormal exit in-vm diagnostics");
    assert_eq!(
        event.fields.get("guest_root_fs_usage").map(String::as_str),
        Some("/tmp status=started")
    );
}

#[tokio::test]
async fn execute_inner_success_skips_abnormal_exit_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let (exit_code, error) =
        run_new_sandbox_status(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();

    assert_eq!(exit_code, 0);
    assert!(error.is_none());
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains("guest-agent-binary"))
    );
}

#[tokio::test]
async fn execute_inner_nonzero_with_stderr_skips_abnormal_exit_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(1, 7, Vec::new(), b"guest stderr".to_vec()));
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let (exit_code, error) =
        run_new_sandbox_status(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();

    assert_eq!(exit_code, 7);
    assert_eq!(error.as_deref(), Some("guest stderr"));
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains("guest-agent-binary"))
    );
}

#[tokio::test]
async fn execute_inner_nonzero_with_stderr_and_guest_error_skips_bootstrap_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(1, 7, Vec::new(), b"guest stderr".to_vec()));
    overrides.push_read_file_result(Ok(None));
    overrides.push_read_file_result(Ok(Some(b"guest checkpoint error".to_vec())));
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let (result, events) = capture_async_events(run_new_sandbox_status(
        &factory,
        &minimal_context(),
        &config,
        &default_params(),
    ))
    .await;
    let (exit_code, error) = result.unwrap();

    assert_eq!(exit_code, 7);
    assert_eq!(error.as_deref(), Some("guest stderr"));
    assert!(
        events.iter().all(|event| {
            event.fields.get("message").map(String::as_str)
                != Some("agent bootstrap abnormal exit diagnostics")
        }),
        "guest error file should suppress bootstrap diagnostics: {events:#?}"
    );
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains("guest-agent-binary"))
    );
}

#[tokio::test]
async fn execute_inner_nonzero_with_process_diagnostic_skips_abnormal_exit_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let mut exit = ProcessExit::new(1, 126, Vec::new(), Vec::new());
    exit.diagnostic = "guest-agent bootstrap diagnostic".to_string();
    overrides.push_wait_process_exit(exit);
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let (exit_code, error) =
        run_new_sandbox_status(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();

    assert_eq!(exit_code, 126);
    assert_eq!(error.as_deref(), Some("Agent exited with code 126"));
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains("guest-agent-binary"))
    );
}

#[tokio::test]
async fn execute_inner_nonzero_with_failure_diagnostic_skips_abnormal_exit_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(1, 126, Vec::new(), Vec::new()));
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("/help"),
    )
    .with_event_delivery(EventDeliveryDiagnostic {
        total_events: 1,
        total_batches: 1,
        failed_batches: 1,
        last_acknowledged_sequence: None,
        first_failed_batch: Some(EventDeliveryFailedBatchDiagnostic {
            first_sequence: 0,
            last_sequence: 0,
            event_count: 1,
            conservative_bytes: 128,
            outcome: EventDeliveryAcceptanceOutcome::OutcomeUnknown,
            attempts: vec![HttpCompletedAttemptDiagnostic {
                attempt: 1,
                client_request_id: "11111111-1111-4111-8111-111111111111".to_string(),
                elapsed_ms: 10_000,
                failure_kind: HttpAttemptFailureKind::Timeout,
                http_status: None,
                timeout_observed: None,
                connect_observed: None,
            }],
        }),
        drain_timeout: None,
    });
    overrides.push_read_file_result(Ok(Some(serde_json::to_vec(&diagnostic).unwrap())));
    overrides.push_read_file_result(Ok(None));
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let outcome = run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
        .await
        .unwrap();

    let failure = outcome.failure.expect("expected execution failure");
    assert_eq!(failure.exit_code, 126);
    assert_eq!(failure.error, "Agent exited with code 126");
    assert_eq!(failure.diagnostic, Some(diagnostic));
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains("guest-agent-binary"))
    );
}

#[tokio::test]
async fn execute_inner_codex_enospc_preserves_structured_failure_and_collects_resources() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(1, 1, Vec::new(), Vec::new()));
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("continue"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(FailureDetailSource::CodexJsonl);
    overrides.push_read_file_result(Ok(Some(serde_json::to_vec(&diagnostic).unwrap())));
    let guest_error = "thread store initialization failed: No space left on device (os error 28)";
    overrides.push_read_file_result(Ok(Some(guest_error.as_bytes().to_vec())));
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "guest-agent-binary".into(),
        exit_code: 0,
        stdout: b"VM0_DF_BLOCKS_V1\n/dev/root 8388608 8388608 0 100% /\nVM0_DF_INODES_V1\n/dev/root 524288 524288 0 100% /\n".to_vec(),
        stderr: Vec::new(),
    });
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let outcome = run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
        .await
        .unwrap();

    let failure = outcome.failure.as_ref().expect("expected failure");
    assert_eq!(failure.exit_code, 1);
    assert_eq!(failure.error, guest_error);
    let retained_diagnostic = failure
        .diagnostic
        .as_ref()
        .expect("structured Codex diagnostic should be retained");
    assert_eq!(retained_diagnostic.failure_class, FailureClass::CliNonzero);
    assert_eq!(retained_diagnostic.framework, AgentFramework::Codex);
    assert_eq!(retained_diagnostic.cli_exit_code, Some(1));
    assert_eq!(
        failure
            .resource_diagnostics
            .expect("expected ENOSPC resource diagnostics")
            .failure_kind,
        Some(ResourceFailureKind::GuestRootFilesystemFull)
    );
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    assert_eq!(
        overrides
            .exec_calls()
            .iter()
            .filter(|call| call.cmd.contains("guest-agent-binary"))
            .count(),
        1
    );
}

#[tokio::test]
async fn execute_inner_unattributed_sigkill_failure_collects_resource_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(1, 137, Vec::new(), Vec::new()));
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("/help"),
    )
    .with_cli_exit_code(137)
    .with_cli_observed_exit(CliObservedExitDiagnostic::from_signal(libc::SIGKILL))
    .with_failure_detail_source(FailureDetailSource::FallbackExitCode);
    overrides.push_read_file_result(Ok(Some(serde_json::to_vec(&diagnostic).unwrap())));
    overrides.push_read_file_result(Ok(Some(b"Agent exited with code 137".to_vec())));
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "guest-agent-binary".to_string(),
        exit_code: 0,
        stdout: b"/dev/root       7.8G  7.4G   20K 100% /\nMem:            3934        3310         255           0         552         624\n".to_vec(),
        stderr: Vec::new(),
    });
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let outcome = run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
        .await
        .unwrap();

    let failure = outcome.failure.as_ref().expect("expected failure");
    assert_eq!(failure.exit_code, 137);
    assert_eq!(failure.error.as_str(), "Agent exited with code 137");
    let resource_diagnostics = failure
        .resource_diagnostics
        .expect("expected resource diagnostics");
    assert_eq!(
        resource_diagnostics.failure_kind,
        Some(ResourceFailureKind::GuestRootFilesystemFull)
    );
    assert_eq!(resource_diagnostics.guest_root_fs_used_percent, Some(100));
    assert_eq!(resource_diagnostics.guest_memory_available_mb, Some(624));
    let diagnostic_calls: Vec<sandbox_mock::ExecCall> = overrides
        .exec_calls()
        .into_iter()
        .filter(|call| call.cmd.contains("guest-agent-binary"))
        .collect();
    assert_eq!(diagnostic_calls.len(), 1);
    assert_eq!(
        diagnostic_calls[0].timeout,
        AGENT_ABNORMAL_EXIT_DIAGNOSTIC_TIMEOUT
    );
}

#[tokio::test]
async fn execute_inner_nonzero_records_agent_execute_error() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_code(
        7,
    ));
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let mut telemetry = test_telemetry(&config, &ctx);
    let cancel = tokio_util::sync::CancellationToken::new();

    let outcome = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        cancel,
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 7);
    assert_eq!(
        outcome.workspace_reuse_result,
        Some(crate::types::WorkspaceReuseResult::NotConfigured),
    );
    assert_eq!(
        outcome.sandbox_reuse_disposition,
        SandboxReuseDisposition::Eligible(SandboxReuseTerminal::NonzeroExit),
    );
    let ops = telemetry.pending_ops_snapshot();
    let agent_execute = ops
        .iter()
        .find(|op| op.0 == "agent_execute")
        .expect("agent_execute telemetry should be recorded");
    assert!(!agent_execute.1);
    assert_eq!(agent_execute.2.as_deref(), Some("Agent exited with code 7"));
}

#[tokio::test]
async fn execute_inner_reports_a_broken_oom_evidence_envelope_without_leaking_it() {
    for payload in [
        "not json".to_string(),
        "x".repeat(guest_contracts::oom_evidence::MAX_EVIDENCE_BYTES + 1),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        let mut exit = ProcessExit::new(1, 1, Vec::new(), Vec::new());
        exit.diagnostic = format!(
            "{}{payload}",
            guest_contracts::oom_evidence::EVIDENCE_PREFIX
        );
        overrides.push_wait_process_exit(exit);
        let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
        let ctx = minimal_context();
        let evidence_path = config.log_paths.oom_evidence_log(ctx.run_id);

        let (outcome, events) = capture_async_events(run_new_sandbox_outcome(
            &factory,
            &ctx,
            &config,
            &default_params(),
        ))
        .await;
        let outcome = outcome.unwrap();

        // A broken envelope is still metadata: it is dropped from the
        // diagnostic, never retained, and never shown to the user.
        assert_eq!(outcome.exit_code(), 1);
        assert!(!tokio::fs::try_exists(&evidence_path).await.unwrap());
        assert!(
            !outcome
                .failure
                .as_ref()
                .unwrap()
                .error
                .as_str()
                .contains("OKOU_OOM_EVIDENCE")
        );
        let event = captured_event(&events, "guest oom evidence envelope malformed");
        assert_eq!(event.level, Level::WARN);
        assert_eq!(
            event.fields.get("malformed_lines").map(String::as_str),
            Some("1")
        );
    }
}

#[tokio::test]
async fn execute_inner_retains_trusted_oom_evidence_and_attributes_agent_domain_sigkill() {
    let evidence =
        include_str!("../../../../../guest-contracts/tests/fixtures/oom-evidence-v1.json");
    let parsed: guest_contracts::oom_evidence::OomEvidence =
        serde_json::from_str(evidence).unwrap();
    for (code, termination) in [
        (0, ExecTermination::Exited { exit_code: 0 }),
        (137, ExecTermination::Exited { exit_code: 137 }),
        (124, ExecTermination::TimedOut),
        (1, ExecTermination::Cancelled),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        let mut exit = ProcessExit::new(1, code, Vec::new(), Vec::new());
        exit.termination = termination;
        exit.diagnostic = format!(
            "{}{}",
            guest_contracts::oom_evidence::EVIDENCE_PREFIX,
            serde_json::to_string(&parsed).unwrap()
        );
        overrides.push_wait_process_exit(exit);
        let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
        let ctx = minimal_context();
        let outcome = tokio::time::timeout(
            Duration::from_secs(10),
            run_new_sandbox_outcome(&factory, &ctx, &config, &default_params()),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(outcome.exit_code(), code);
        let retained = tokio::fs::read(config.log_paths.oom_evidence_log(ctx.run_id))
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<guest_contracts::oom_evidence::OomEvidence>(&retained)
                .unwrap(),
            parsed
        );
        if code == 0 {
            assert!(
                outcome.failure.is_none(),
                "recovered tool OOM must preserve success"
            );
        } else {
            let failure = outcome.failure.as_ref().unwrap();
            assert!(!failure.error.as_str().contains("OKOU_OOM_EVIDENCE"));
            if matches!(
                termination,
                ExecTermination::Exited {
                    exit_code: EXIT_SIGKILL
                }
            ) {
                assert_eq!(
                    failure.error,
                    "The agent process ran out of memory and was terminated by the sandbox out-of-memory killer"
                );
                assert_eq!(
                    failure
                        .resource_diagnostics
                        .and_then(|diagnostics| diagnostics.failure_kind),
                    Some(ResourceFailureKind::GuestMemoryOomKilled)
                );
                assert_eq!(
                    outcome.sandbox_reuse_disposition,
                    SandboxReuseDisposition::Ineligible(SandboxReuseRejection::ResourceFailure)
                );
            }
        }
        if termination == ExecTermination::TimedOut {
            assert!(matches!(
                outcome.failure.as_ref().unwrap().kind,
                ExecutionFailureKind::RunnerJobTimeout { .. }
            ));
        }
    }
}

#[tokio::test]
async fn execute_inner_keeps_tool_domain_oom_out_of_agent_terminal_attribution() {
    let evidence =
        include_str!("../../../../../guest-contracts/tests/fixtures/oom-evidence-v1.json");
    let mut parsed: guest_contracts::oom_evidence::OomEvidence =
        serde_json::from_str(evidence).unwrap();
    let workload = parsed.groups[0].cgroup.clone();
    parsed.incidents[0].kernel_events[0].task_cgroup = format!("{workload}/tools/tool-281-10-3-1");

    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let mut exit = ProcessExit::new(1, EXIT_SIGKILL, Vec::new(), Vec::new());
    exit.diagnostic = format!(
        "{}{}",
        guest_contracts::oom_evidence::EVIDENCE_PREFIX,
        serde_json::to_string(&parsed).unwrap()
    );
    overrides.push_wait_process_exit(exit);
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();

    let outcome = run_new_sandbox_outcome(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    let failure = outcome
        .failure
        .as_ref()
        .expect("tool OOM must retain the failed run");
    assert_eq!(failure.error, "Agent exited with code 137");
    assert_ne!(
        failure
            .resource_diagnostics
            .and_then(|diagnostics| diagnostics.failure_kind),
        Some(ResourceFailureKind::GuestMemoryOomKilled)
    );
    assert_eq!(
        outcome.sandbox_reuse_disposition,
        SandboxReuseDisposition::Eligible(SandboxReuseTerminal::NonzeroExit)
    );
}
