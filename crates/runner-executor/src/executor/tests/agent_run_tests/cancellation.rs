use std::fs;
use std::os::unix::fs::OpenOptionsExt;
use std::sync::Arc;
use std::time::Duration;

use sandbox::{ProcessExit, ProcessOutputChunk};
use sandbox_mock::MockLifecycleGate;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tracing::Level;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

use super::support::{
    final_identity_metadata_bytes, final_identity_runtime_paths, local_sidecar_restore_plan,
};
use crate::executor::agent_run::{ProcessCancelTimeouts, RunControls, RunStart, run_in_sandbox};
use crate::executor::diagnostics::AgentStdoutStreamDiagnostics;
use crate::executor::tests::support::{
    RUN_IN_SANDBOX_TEST_TIMEOUT, create_overridden_sandbox, minimal_context,
    spawn_run_in_sandbox_test, spawn_run_in_sandbox_test_with_cancellation,
    spawn_run_in_sandbox_test_with_timeouts, test_executor_config, test_telemetry,
};
use crate::executor::{
    EXIT_SIGKILL, PROCESS_CANCEL_TIMEOUTS, PROCESS_CANCEL_WRITE_TIMEOUT, SandboxReuseDisposition,
    SandboxReuseRejection, SandboxReuseTerminal, SessionHistoryMaterializer,
    SessionHistoryRestorePlan, effective_cli_framework,
};
use crate::workspace_image_cache::{
    WorkspaceSessionHistorySidecar, WorkspaceSessionHistorySidecarRepresentation,
};
use runner_provider::RunCancellationHandle;
use runner_types::types::{
    ResumeSession, ResumeSessionHistory, ResumeSessionHistoryEncoding, ResumeSessionHistoryRef,
    ResumeSessionHistoryRefKind, SandboxReuseResult,
};

#[tokio::test]
async fn closed_cooperative_control_retains_oom_without_changing_terminal_confirmation() {
    let evidence: guest_contracts::oom_evidence::OomEvidence = serde_json::from_str(include_str!(
        "../../../../../guest-contracts/tests/fixtures/oom-evidence-v1.json"
    ))
    .unwrap();
    for (diagnostic, level, recovered) in [
        ("", Level::INFO, "true"),
        ("cleanup failed", Level::WARN, "false"),
    ] {
        let captured = CapturedEvents::default();
        let _subscriber =
            tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let context = minimal_context();
        let retained_path = config.log_paths.oom_evidence_log(context.run_id);
        let wait_gate = MockLifecycleGate::new();
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
        overrides.push_process_control_outcome(sandbox::ProcessControlOutcome::GuestStatus {
            status: sandbox::ProcessControlGuestStatus::SinkClosed,
            diagnostic: "closed control peer".into(),
        });
        let mut exit = ProcessExit::new(1, 0, Vec::new(), Vec::new());
        exit.diagnostic = format!(
            "{}{}\n{diagnostic}",
            guest_contracts::oom_evidence::EVIDENCE_PREFIX,
            serde_json::to_string(&evidence).unwrap()
        );
        overrides.push_wait_process_exit(exit);
        let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
        let cancellation = RunCancellationHandle::new();
        let run_task = spawn_run_in_sandbox_test_with_cancellation(
            sandbox,
            context,
            config,
            cancellation.signals(),
            PROCESS_CANCEL_TIMEOUTS,
        );
        wait_gate
            .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
            .unwrap();
        cancellation.request_cooperative_user_cancellation().await;
        let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(result.failure.unwrap().exit_code, EXIT_SIGKILL);
        assert_eq!(
            result.sandbox_reuse_disposition,
            SandboxReuseDisposition::Ineligible(SandboxReuseRejection::HardCancellation)
        );
        let retained = tokio::fs::read(retained_path).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<guest_contracts::oom_evidence::OomEvidence>(&retained)
                .unwrap(),
            evidence
        );
        let events = captured.entries();
        let event = events
            .iter()
            .find(|event| event.fields.contains_key("recovered_after_cancellation"))
            .unwrap();
        assert_eq!(event.level, level);
        assert_eq!(
            event
                .fields
                .get("recovered_after_cancellation")
                .map(String::as_str),
            Some(recovered)
        );
    }
}

#[tokio::test]
async fn closed_cooperative_control_remains_warning_when_terminal_grace_expires() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.set_process_cancel_releases_wait_gate(false);
    overrides.push_process_control_outcome(sandbox::ProcessControlOutcome::GuestStatus {
        status: sandbox::ProcessControlGuestStatus::SinkClosed,
        diagnostic: "closed control peer".into(),
    });
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let cancellation = RunCancellationHandle::new();
    let run_task = spawn_run_in_sandbox_test_with_cancellation(
        sandbox,
        minimal_context(),
        config,
        cancellation.signals(),
        ProcessCancelTimeouts {
            terminal_grace: Duration::ZERO,
            ..PROCESS_CANCEL_TIMEOUTS
        },
    );
    wait_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .unwrap();
    cancellation.request_cooperative_user_cancellation().await;
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(result.failure.unwrap().exit_code, EXIT_SIGKILL);
    assert_eq!(
        result.sandbox_reuse_disposition,
        SandboxReuseDisposition::Ineligible(SandboxReuseRejection::HardCancellation)
    );
    let events = captured.entries();
    for message in [
        "timed out waiting for cancelled guest process",
        "failed to send cooperative user cancellation",
    ] {
        let event = events
            .iter()
            .find(|event| event.fields.get("message").map(String::as_str) == Some(message))
            .unwrap();
        assert_eq!(event.level, Level::WARN);
    }
    let event = events
        .iter()
        .find(|event| event.fields.contains_key("recovered_after_cancellation"))
        .unwrap();
    assert_eq!(
        event
            .fields
            .get("recovered_after_cancellation")
            .map(String::as_str),
        Some("false")
    );
}

#[tokio::test]
async fn run_in_sandbox_preserves_wait_result_when_cancel_arrives_after_wait() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"partial stdout".to_vec(),
        truncated: true,
    }]);
    let ctx = minimal_context();
    let session_id = "sess-late-cancel-123";
    let history = br#"{"type":"done"}"#;
    let (metadata_path, _) = final_identity_runtime_paths(&ctx);
    overrides.push_read_file_result(Ok(Some(final_identity_metadata_bytes(session_id, history))));
    let cancel = tokio_util::sync::CancellationToken::new();
    overrides.cancel_after_next_wait_process_result(cancel.clone());
    let sandbox = create_overridden_sandbox(overrides).await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        sandbox.as_ref(),
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(cancel.clone(), None),
    )
    .await
    .unwrap();

    assert!(cancel.is_cancelled());
    assert!(result.failure.is_none());
    let identity = result
        .reusable_session_identity
        .as_ref()
        .expect("completed agent identity should survive late cancellation");
    assert_eq!(
        identity.history_hash(),
        hex::encode(Sha256::digest(history))
    );
    assert_eq!(identity.final_metadata_path(), Some(metadata_path.as_str()));
    assert_eq!(
        result.stdout_stream_diagnostics,
        AgentStdoutStreamDiagnostics {
            bytes_written: 14,
            chunk_truncated: true,
            stream_overflowed: false,
            stream_incomplete: false,
        }
    );
}

#[tokio::test]
async fn run_in_sandbox_reports_cancelled_while_workspace_sidecar_read_is_pending() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let history = b"x";
    let sidecar_path = dir.path().join("pending-session-history.blob");
    nix::unistd::mkfifo(
        &sidecar_path,
        nix::sys::stat::Mode::from_bits_truncate(0o600),
    )
    .unwrap();
    let writer_path = sidecar_path.clone();
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-sidecar-cancel-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: "https://example.test/history.blob?token=secret".into(),
                encoding: ResumeSessionHistoryEncoding::Identity,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
                download_source: None,
            },
        },
    });
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_cancel = cancel.clone();
    let run_task = tokio::spawn(async move {
        let restore_plan = local_sidecar_restore_plan(
            &ctx,
            &config,
            WorkspaceSessionHistorySidecar {
                path: sidecar_path,
                representation: WorkspaceSessionHistorySidecarRepresentation::Raw,
                encoded_size: history.len() as u64,
            },
            run_cancel.clone(),
        )
        .await;
        let mut telemetry = test_telemetry(&config, &ctx);
        run_in_sandbox(
            &*sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                workspace_reuse_result: runner_types::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(run_cancel, None).with_session_history_restore_plan(restore_plan),
        )
        .await
    });

    let writer = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, async {
        loop {
            match fs::OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(&writer_path)
            {
                Ok(writer) => break writer,
                Err(error) if error.raw_os_error() == Some(libc::ENXIO) => {
                    tokio::task::yield_now().await;
                }
                Err(error) => panic!("open sidecar FIFO writer: {error}"),
            }
        }
    })
    .await
    .expect("run should open the sidecar reader");
    cancel.cancel();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .expect("cancelled run should finish")
        .unwrap()
        .unwrap();
    drop(writer);

    let failure = result.failure.expect("cancelled run should fail");
    assert_eq!(failure.exit_code, EXIT_SIGKILL);
    assert_eq!(failure.error, "cancelled by user");
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(overrides.wait_process_calls().is_empty());
}

#[tokio::test]
async fn run_in_sandbox_reports_cancelled_while_session_history_download_is_pending() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (request_received_tx, request_received_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0u8; 1024];
        let request_bytes = stream.read(&mut request).await.unwrap();
        assert!(request_bytes > 0);
        request_received_tx.send(()).unwrap();
        let mut byte = [0u8; 1];
        let closed = stream.read(&mut byte).await.unwrap();
        assert_eq!(closed, 0);
    });
    let history = br#"{"type":"init"}"#;
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-cancel-pending-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: format!("http://{address}/history.blob?token=secret"),
                encoding: ResumeSessionHistoryEncoding::Identity,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
                download_source: None,
            },
        },
    });
    // Production materializers receive a child of the run token. Keep the
    // tokens independent here so the inner cancellation result deterministically
    // reaches the result-first pre-spawn branch instead of racing the outer
    // cancellation branch.
    let materializer_cancel = tokio_util::sync::CancellationToken::new();
    let materializer = SessionHistoryMaterializer::start_cancellable(
        &config.http,
        &config.session_history_cpu,
        ctx.resume_session.as_ref(),
        effective_cli_framework(&ctx.cli_agent_type),
        materializer_cancel.clone(),
        Some(&config.session_history_probe),
    );
    let run_task = tokio::spawn(async move {
        let mut telemetry = test_telemetry(&config, &ctx);
        run_in_sandbox(
            &*sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                workspace_reuse_result: runner_types::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(tokio_util::sync::CancellationToken::new(), None)
                .with_session_history_restore_plan(SessionHistoryRestorePlan::Prestarted {
                    materializer,
                    fallback: None,
                }),
        )
        .await
    });

    tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, request_received_rx)
        .await
        .expect("session history request should start")
        .unwrap();
    materializer_cancel.cancel();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .expect("cancelled run should finish")
        .unwrap()
        .unwrap();
    tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, server)
        .await
        .expect("session history server should observe disconnect")
        .unwrap();

    let failure = result.failure.expect("cancelled run should fail");
    assert_eq!(failure.exit_code, EXIT_SIGKILL);
    assert_eq!(failure.error, "cancelled by user");
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(overrides.wait_process_calls().is_empty());
}

#[tokio::test]
async fn run_in_sandbox_starts_no_guest_work_when_already_cancelled() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    cancel.cancel();
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        sandbox.as_ref(),
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(cancel, None),
    )
    .await
    .unwrap();

    let failure = result.failure.expect("cancelled run should fail");
    assert_eq!(failure.exit_code, EXIT_SIGKILL);
    assert_eq!(failure.error, "cancelled by user");
    assert!(overrides.exec_calls().is_empty());
    assert!(overrides.write_file_calls().is_empty());
    assert!(overrides.private_write_file_calls().is_empty());
    assert!(overrides.private_write_files_calls().is_empty());
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(overrides.wait_process_calls().is_empty());
}

#[tokio::test]
async fn run_in_sandbox_observes_cancellation_while_guest_helper_is_pending() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let helper_gate = MockLifecycleGate::new();
    overrides.set_private_write_file_lifecycle_gate(helper_gate.clone());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_task = spawn_run_in_sandbox_test(sandbox, ctx, config, cancel.clone());

    helper_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .expect("run should enter the guest helper");
    cancel.cancel();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .expect("cancelled helper should not hold the run open")
        .unwrap()
        .unwrap();

    let failure = result.failure.expect("cancelled run should fail");
    assert_eq!(failure.exit_code, EXIT_SIGKILL);
    assert_eq!(failure.error, "cancelled by user");
    assert!(overrides.exec_calls().is_empty());
    assert!(overrides.private_write_file_calls().is_empty());
    assert!(overrides.private_write_files_calls().is_empty());
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(overrides.wait_process_calls().is_empty());
}

#[tokio::test]
async fn run_in_sandbox_preserves_ready_start_result_when_cancellation_arrives() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let cancel = tokio_util::sync::CancellationToken::new();
    overrides.cancel_after_next_start_process_result(cancel.clone());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        sandbox.as_ref(),
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(cancel.clone(), None),
    )
    .await
    .unwrap();

    assert!(cancel.is_cancelled());
    assert!(result.failure.is_none());
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    assert_eq!(overrides.wait_process_calls().len(), 1);
    assert!(overrides.process_cancel_calls().is_empty());
}

#[tokio::test]
async fn run_in_sandbox_cancels_guest_process_and_waits_for_terminal_status() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"partial stdout".to_vec(),
        truncated: true,
    }]);
    let mut exit = ProcessExit::new(1, 0, Vec::new(), Vec::new());
    exit.stream_overflowed = true;
    overrides.push_wait_process_exit(exit);
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_task = spawn_run_in_sandbox_test(sandbox, ctx, config, cancel.clone());
    wait_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .expect("run should enter process wait before cancellation");
    cancel.cancel();

    assert!(
        overrides
            .wait_for_process_cancel_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    assert_eq!(
        overrides.process_cancel_calls().as_slice(),
        [sandbox_mock::ProcessCancelCall {
            timeout: PROCESS_CANCEL_WRITE_TIMEOUT
        }]
    );
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
    assert_eq!(
        result.sandbox_reuse_disposition,
        SandboxReuseDisposition::Ineligible(SandboxReuseRejection::HardCancellation),
    );
    assert_eq!(
        result.stdout_stream_diagnostics,
        AgentStdoutStreamDiagnostics {
            bytes_written: 14,
            chunk_truncated: true,
            stream_overflowed: true,
            stream_incomplete: false,
        }
    );
    assert!(overrides.process_control_calls().is_empty());
}

#[tokio::test]
async fn run_in_sandbox_requests_cooperative_user_cancellation() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let cancellation = RunCancellationHandle::new();
    let run_task = spawn_run_in_sandbox_test_with_cancellation(
        sandbox,
        ctx,
        config,
        cancellation.signals(),
        PROCESS_CANCEL_TIMEOUTS,
    );
    wait_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .expect("run should enter process wait before cancellation");

    cancellation.request_cooperative_user_cancellation().await;
    assert!(
        overrides
            .wait_for_process_control_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );
    wait_gate.release_one();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].message_id, format!("user-cancellation:{run_id}"));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&calls[0].payload).unwrap(),
        serde_json::json!({ "type": "user-cancellation" })
    );
    assert_eq!(calls[0].timeout, PROCESS_CANCEL_WRITE_TIMEOUT);
    assert!(overrides.process_cancel_calls().is_empty());
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
    assert_eq!(
        result.sandbox_reuse_disposition,
        SandboxReuseDisposition::Eligible(SandboxReuseTerminal::CooperativeCancellation),
    );
}

#[tokio::test]
async fn run_in_sandbox_falls_back_when_cooperative_cancellation_fails() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.push_process_control_error("guest rejected cancellation");
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancellation = RunCancellationHandle::new();
    let run_task = spawn_run_in_sandbox_test_with_cancellation(
        sandbox,
        ctx,
        config,
        cancellation.signals(),
        PROCESS_CANCEL_TIMEOUTS,
    );
    wait_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .expect("run should enter process wait before cancellation");

    cancellation.request_cooperative_user_cancellation().await;
    assert!(
        overrides
            .wait_for_process_cancel_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(overrides.process_control_calls().len(), 1);
    assert_eq!(overrides.process_cancel_calls().len(), 1);
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
}

#[tokio::test]
async fn run_in_sandbox_fails_startup_when_process_control_is_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_process_control_supported(false);
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancellation = RunCancellationHandle::new();
    let run_task = spawn_run_in_sandbox_test_with_cancellation(
        sandbox,
        ctx,
        config,
        cancellation.signals(),
        PROCESS_CANCEL_TIMEOUTS,
    );
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap();
    let error = match result {
        Ok(_) => panic!("Agent run unexpectedly started without process control"),
        Err(error) => error,
    };
    assert!(
        error
            .to_string()
            .contains("provider returned an Agent process without process control")
    );
    assert!(overrides.process_control_calls().is_empty());
    assert!(overrides.process_cancel_calls().is_empty());
    assert!(overrides.wait_process_calls().is_empty());
}

#[tokio::test]
async fn run_in_sandbox_forces_cancellation_when_cooperative_wait_fails() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = MockLifecycleGate::new();
    let mut overrides = sandbox_mock::MockSandboxOverrides::new();
    overrides.set_wait_process_error("wait failed during cooperative cancellation");
    let overrides = Arc::new(overrides);
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancellation = RunCancellationHandle::new();
    let run_task = spawn_run_in_sandbox_test_with_cancellation(
        sandbox,
        ctx,
        config,
        cancellation.signals(),
        PROCESS_CANCEL_TIMEOUTS,
    );
    wait_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .expect("run should enter process wait before cancellation");

    cancellation.request_cooperative_user_cancellation().await;
    assert!(
        overrides
            .wait_for_process_control_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );
    wait_gate.release_one();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(overrides.process_control_calls().len(), 1);
    assert_eq!(overrides.process_cancel_calls().len(), 1);
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
}

#[tokio::test]
async fn run_in_sandbox_falls_back_when_cooperative_grace_expires() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancellation = RunCancellationHandle::new();
    let run_task = spawn_run_in_sandbox_test_with_cancellation(
        sandbox,
        ctx,
        config,
        cancellation.signals(),
        ProcessCancelTimeouts {
            cooperative_grace: Duration::ZERO,
            ..PROCESS_CANCEL_TIMEOUTS
        },
    );
    wait_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .expect("run should enter process wait before cancellation");

    cancellation.request_cooperative_user_cancellation().await;
    assert!(
        overrides
            .wait_for_process_cancel_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(overrides.process_control_calls().len(), 1);
    assert_eq!(overrides.process_cancel_calls().len(), 1);
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
}

#[tokio::test]
async fn hard_cancellation_preempts_cooperative_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancellation = RunCancellationHandle::new();
    let run_task = spawn_run_in_sandbox_test_with_cancellation(
        sandbox,
        ctx,
        config,
        cancellation.signals(),
        PROCESS_CANCEL_TIMEOUTS,
    );
    wait_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .expect("run should enter process wait before cancellation");

    cancellation.request_cooperative_user_cancellation().await;
    assert!(
        overrides
            .wait_for_process_control_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );
    cancellation.request_hard_cancellation().await;
    assert!(
        overrides
            .wait_for_process_cancel_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(overrides.process_cancel_calls().len(), 1);
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
    assert_eq!(
        result.sandbox_reuse_disposition,
        SandboxReuseDisposition::Ineligible(SandboxReuseRejection::HardCancellation),
    );
}

#[tokio::test]
async fn run_in_sandbox_returns_cancelled_when_cancel_handle_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.set_process_cancel_supported(false);
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_task = spawn_run_in_sandbox_test(sandbox, ctx, config, cancel.clone());
    wait_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .expect("run should enter process wait before cancellation");
    cancel.cancel();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    assert!(overrides.process_cancel_calls().is_empty());
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
}

#[tokio::test]
async fn run_in_sandbox_returns_cancelled_when_process_cancel_send_fails() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.push_process_cancel_error("cancel write failed");
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_task = spawn_run_in_sandbox_test(sandbox, ctx, config, cancel.clone());
    wait_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .expect("run should enter process wait before cancellation");
    cancel.cancel();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    assert_eq!(
        overrides.process_cancel_calls().as_slice(),
        [sandbox_mock::ProcessCancelCall {
            timeout: PROCESS_CANCEL_WRITE_TIMEOUT
        }]
    );
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
}

#[tokio::test]
async fn run_in_sandbox_returns_cancelled_when_wait_fails_after_process_cancel() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = MockLifecycleGate::new();
    let mut overrides = sandbox_mock::MockSandboxOverrides::new();
    overrides.set_wait_process_error("wait failed after cancel");
    let overrides = Arc::new(overrides);
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_task = spawn_run_in_sandbox_test(sandbox, ctx, config, cancel.clone());
    wait_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .expect("run should enter process wait before cancellation");
    cancel.cancel();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    assert_eq!(
        overrides.process_cancel_calls().as_slice(),
        [sandbox_mock::ProcessCancelCall {
            timeout: PROCESS_CANCEL_WRITE_TIMEOUT
        }]
    );
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
}

#[tokio::test]
async fn run_in_sandbox_returns_cancelled_when_terminal_grace_times_out() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.set_process_cancel_releases_wait_gate(false);
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_task = spawn_run_in_sandbox_test_with_timeouts(
        sandbox,
        ctx,
        config,
        cancel.clone(),
        ProcessCancelTimeouts {
            write: PROCESS_CANCEL_WRITE_TIMEOUT,
            terminal_grace: Duration::ZERO,
            cooperative_grace: Duration::ZERO,
        },
    );
    wait_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .expect("run should enter process wait before cancellation");
    cancel.cancel();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    assert_eq!(
        overrides.process_cancel_calls().as_slice(),
        [sandbox_mock::ProcessCancelCall {
            timeout: PROCESS_CANCEL_WRITE_TIMEOUT
        }]
    );
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
}
