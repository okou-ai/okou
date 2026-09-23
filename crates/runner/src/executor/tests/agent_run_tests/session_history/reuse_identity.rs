use std::sync::Arc;
use std::time::Duration;

use guest_contracts::session_history_identity::{
    FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_EXPECTED_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FAILURE,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FRAMEWORK_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_METADATA,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ, SessionHistoryFramework,
    SessionHistoryIdentity, SessionHistoryRefKind,
};
use httpmock::prelude::*;
use sandbox::{ExecResult, ExecTermination, ProcessExit};
use sandbox_mock::MockLifecycleGate;
use sha2::{Digest, Sha256};

use super::{
    LARGE_SESSION_HISTORY_SIZE_BYTES, assert_successful_action, history_prefix_attribution,
};
use crate::executor::agent_run::{RunControls, RunStart, run_in_sandbox};
use crate::executor::tests::agent_run_tests::support::{
    assert_failed_action_error_once, assert_no_action, assert_successful_action_once,
    claude_history_path, claude_history_source, final_identity_runtime_paths,
};
use crate::executor::tests::support::{
    RUN_IN_SANDBOX_TEST_TIMEOUT, create_overridden_sandbox, minimal_context, sandbox_exec_error,
    test_executor_config, test_telemetry,
};
use crate::executor::{
    EXIT_SIGKILL, RestoredSessionIdentity, SessionHistoryCpuPool, SessionHistoryMaterializer,
    SessionHistoryRestoreFallback, SessionHistoryRestorePlan, effective_cli_framework,
};
use crate::restored_session_identity::{
    RestoredSessionHistoryHashSizeRelationship, RestoredSessionIdentityMismatchReason,
};
use runner_types::types::{
    ResumeSession, ResumeSessionHistory, ResumeSessionHistoryEncoding, ResumeSessionHistoryRef,
    ResumeSessionHistoryRefKind, SandboxReuseResult,
};

const SESSION_HISTORY_IDENTITY_REUSE_VERIFY_ERROR: &str =
    "session history identity reuse verification failed";

fn context_with_checkpointed_session_identity(
    session_id: &str,
    history: &[u8],
) -> (
    runner_types::types::ExecutionContext,
    RestoredSessionIdentity,
) {
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: session_id.into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: format!("https://example.com/{session_id}.blob"),
                encoding: ResumeSessionHistoryEncoding::Identity,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
                download_source: None,
            },
        },
    });
    let runtime_dir = format!("/home/user/.vm0/guest-agent/runs/{session_id}-previous");
    let metadata_path = format!("{runtime_dir}/final-session-history-identity.json");
    let metadata = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        hex::encode(Sha256::digest(session_id.as_bytes())),
        SessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(history)),
        history.len() as u64,
        claude_history_source(session_id),
    )
    .unwrap();
    let identity =
        RestoredSessionIdentity::from_final_metadata(metadata, metadata_path, runtime_dir)
            .expect("checkpointed identity");
    (ctx, identity)
}
async fn assert_checkpointed_final_identity_helper_failure_falls_back(
    session_id: &str,
    helper_result: ExecResult,
    expected_reason_action: &str,
) {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = br#"{"type":"init"}"#;
    let server = MockServer::start_async().await;
    let history_mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/history.blob");
            then.status(200).body(history);
        })
        .await;
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: session_id.into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: server.url("/history.blob?token=secret"),
                encoding: ResumeSessionHistoryEncoding::Identity,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
                download_source: None,
            },
        },
    });
    let (metadata_path, runtime_dir) = final_identity_runtime_paths(&ctx);
    let metadata = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        hex::encode(Sha256::digest(session_id.as_bytes())),
        SessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(history)),
        history.len() as u64,
        claude_history_source(session_id),
    )
    .unwrap();
    let idle_identity =
        RestoredSessionIdentity::from_final_metadata(metadata, metadata_path, runtime_dir)
            .expect("checkpointed identity");
    sandbox.push_exec_result(Ok(helper_result));
    sandbox.push_read_file_result(Ok(None));
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::SandboxReused,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_session_history_restore_plan(SessionHistoryRestorePlan::SkipVerified(
                idle_identity,
            )),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    assert!(result.reusable_session_identity.is_none());
    history_mock.assert_calls_async(1).await;
    assert_eq!(sandbox.session_history_identity_verify_calls().len(), 1);
    assert!(sandbox.exec_calls().is_empty());
    let ops = telemetry.pending_ops_snapshot();
    assert_failed_action_error_once(
        &ops,
        "session_history_identity_reuse_verify",
        SESSION_HISTORY_IDENTITY_REUSE_VERIFY_ERROR,
    );
    assert_successful_action(&ops, expected_reason_action);
    assert_successful_action(&ops, "session_history_restore_fallback_stale_idle_identity");
    assert!(
        ops.iter().all(|op| op.0 != "session_history_restore_skip"),
        "helper failure should not record skip telemetry, got: {ops:?}"
    );
}
#[tokio::test]
async fn run_in_sandbox_skips_checkpointed_final_session_history_restore() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
    let server = MockServer::start_async().await;
    let history_mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/history.blob");
            then.status(200).body(history.clone());
        })
        .await;
    let mut ctx = minimal_context();
    let session_id = "sess-final-skip-123";
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: session_id.into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(&history)),
                url: server.url("/history.blob?token=secret"),
                encoding: ResumeSessionHistoryEncoding::Identity,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
                download_source: None,
            },
        },
    });
    let (metadata_path, runtime_dir) = final_identity_runtime_paths(&ctx);
    let previous_metadata_path =
        "/home/user/.vm0/guest-agent/runs/previous/final-session-history-identity.json";
    let previous_runtime_dir = "/home/user/.vm0/guest-agent/runs/previous";
    let metadata = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        hex::encode(Sha256::digest(session_id.as_bytes())),
        SessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(&history)),
        history.len() as u64,
        claude_history_source(session_id),
    )
    .unwrap();
    let idle_identity = RestoredSessionIdentity::from_final_metadata(
        metadata.clone(),
        previous_metadata_path,
        previous_runtime_dir,
    )
    .expect("checkpointed identity");
    let final_identity = RestoredSessionIdentity::from_final_metadata(
        metadata.clone(),
        metadata_path.clone(),
        runtime_dir,
    )
    .expect("final identity");
    sandbox.push_exec_result(Ok(ExecResult::new(0, Vec::new(), Vec::new())));
    sandbox.push_read_file_result(Ok(Some(metadata.to_json_vec().unwrap())));
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::SandboxReused,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_session_history_restore_plan(SessionHistoryRestorePlan::SkipVerified(
                idle_identity,
            )),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    assert_eq!(result.reusable_session_identity, Some(final_identity));
    assert_eq!(
        result
            .reusable_session_identity
            .as_ref()
            .and_then(RestoredSessionIdentity::final_metadata_path),
        Some(metadata_path.as_str())
    );
    let read_calls = sandbox.read_file_calls();
    assert_eq!(read_calls.len(), 1);
    assert_eq!(read_calls[0].path, metadata_path);
    assert_eq!(
        read_calls[0].max_bytes,
        FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES + 1
    );
    let verify_calls = sandbox.session_history_identity_verify_calls();
    assert_eq!(verify_calls.len(), 1);
    let call = &verify_calls[0];
    assert_eq!(call.metadata_path, previous_metadata_path);
    assert_eq!(call.runtime_dir, previous_runtime_dir);
    assert_eq!(call.framework, metadata.framework.as_str());
    assert_eq!(call.session_id_hash, metadata.session_id_hash);
    assert_eq!(call.history_ref_kind, metadata.history_ref_kind.as_str());
    assert_eq!(call.history_hash, metadata.history_hash);
    assert_eq!(call.history_size_bytes, metadata.history_size_bytes);
    assert_eq!(call.timeout, Duration::from_secs(5));
    assert!(sandbox.exec_calls().is_empty());
    history_mock.assert_calls_async(0).await;
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action_once(&ops, "session_history_identity_reuse_verify");
    assert!(
        ops.iter()
            .any(|op| op.0 == "session_history_identity_reuse_hit" && op.1),
        "expected checkpointed identity reuse hit telemetry, got: {ops:?}"
    );
    assert!(
        ops.iter()
            .any(|op| op.0 == "session_history_restore_skip" && op.1),
        "expected checkpointed skip telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_drops_checkpointed_identity_when_agent_is_cancelled() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let start_process_gate = MockLifecycleGate::new();
    overrides.set_start_process_lifecycle_gate(start_process_gate.clone());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let (ctx, idle_identity) = context_with_checkpointed_session_identity(
        "sess-cancelled-reuse-123",
        br#"{"type":"before"}"#,
    );
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut telemetry = test_telemetry(&config, &ctx);
    let run = run_in_sandbox(
        sandbox.as_ref(),
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::SandboxReused,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(cancel.clone(), None).with_session_history_restore_plan(
            SessionHistoryRestorePlan::SkipVerified(idle_identity),
        ),
    );
    tokio::pin!(run);

    tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, async {
        tokio::select! {
            result = &mut run => {
                let _ = result;
                panic!("run finished before the start-process barrier");
            }
            entered = start_process_gate.wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT) => {
                entered.expect("run should reach the start-process barrier");
            }
        }
    })
    .await
    .expect("run should verify the checkpointed identity before starting the agent");
    assert_eq!(overrides.session_history_identity_verify_calls().len(), 1);
    assert!(overrides.exec_calls().is_empty());

    cancel.cancel();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, &mut run)
        .await
        .expect("cancelled run should finish")
        .unwrap();

    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
    assert!(result.reusable_session_identity.is_none());
    assert_eq!(overrides.session_history_identity_verify_calls().len(), 1);
    assert!(overrides.exec_calls().is_empty());
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(overrides.wait_process_calls().is_empty());
    assert!(overrides.process_cancel_calls().is_empty());
}

#[tokio::test]
async fn run_in_sandbox_drops_checkpointed_identity_when_agent_exits_nonzero() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(
        1,
        42,
        Vec::new(),
        b"agent failed".to_vec(),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let (ctx, idle_identity) = context_with_checkpointed_session_identity(
        "sess-nonzero-reuse-123",
        br#"{"type":"before"}"#,
    );
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &*sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::SandboxReused,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_session_history_restore_plan(SessionHistoryRestorePlan::SkipVerified(
                idle_identity,
            )),
    )
    .await
    .unwrap();

    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(42)
    );
    assert!(result.reusable_session_identity.is_none());
    assert_eq!(overrides.session_history_identity_verify_calls().len(), 1);
    assert!(overrides.exec_calls().is_empty());
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter()
            .all(|op| !op.0.starts_with("session_history_identity_finalize")),
        "failed agent should not inspect final identity metadata: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_classifies_checkpointed_final_identity_helper_failure_codes() {
    let cases = [
        (
            "generic",
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FAILURE,
            "session_history_identity_verify_helper_failed",
        ),
        (
            "invalid-args",
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS,
            "session_history_identity_verify_helper_invalid_args",
        ),
        (
            "metadata-read",
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ,
            "session_history_identity_verify_helper_metadata_read_failed",
        ),
        (
            "invalid-metadata",
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_METADATA,
            "session_history_identity_verify_helper_invalid_metadata",
        ),
        (
            "framework-mismatch",
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FRAMEWORK_MISMATCH,
            "session_history_identity_verify_helper_framework_mismatch",
        ),
        (
            "expected-mismatch",
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_EXPECTED_MISMATCH,
            "session_history_identity_verify_helper_expected_mismatch",
        ),
        (
            "history-read",
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ,
            "session_history_identity_verify_helper_history_read_failed",
        ),
    ];

    for (name, exit_code, expected_reason_action) in cases {
        let session_id = format!("sess-final-helper-{name}-123");
        assert_checkpointed_final_identity_helper_failure_falls_back(
            &session_id,
            ExecResult::new(exit_code, Vec::new(), Vec::new()),
            expected_reason_action,
        )
        .await;
    }
}

#[tokio::test]
async fn run_in_sandbox_restores_when_checkpointed_final_identity_helper_reports_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = br#"{"type":"init"}"#;
    let server = MockServer::start_async().await;
    let history_mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/history.blob");
            then.status(200).body(history);
        })
        .await;
    let mut ctx = minimal_context();
    let session_id = "sess-final-helper-mismatch-123";
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: session_id.into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: server.url("/history.blob?token=secret"),
                encoding: ResumeSessionHistoryEncoding::Identity,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
                download_source: None,
            },
        },
    });
    let (metadata_path, runtime_dir) = final_identity_runtime_paths(&ctx);
    let metadata = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        hex::encode(Sha256::digest(session_id.as_bytes())),
        SessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(history)),
        history.len() as u64,
        claude_history_source(session_id),
    )
    .unwrap();
    let idle_identity =
        RestoredSessionIdentity::from_final_metadata(metadata, metadata_path.clone(), runtime_dir)
            .expect("checkpointed identity");
    sandbox.push_exec_result(Ok(ExecResult::new(
        SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH,
        Vec::new(),
        Vec::new(),
    )));
    sandbox.push_read_file_result(Ok(None));
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::SandboxReused,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_session_history_restore_plan(SessionHistoryRestorePlan::SkipVerified(
                idle_identity,
            )),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    assert!(result.reusable_session_identity.is_none());
    let verify_calls = sandbox.session_history_identity_verify_calls();
    assert_eq!(verify_calls.len(), 1);
    assert_eq!(verify_calls[0].metadata_path, metadata_path);
    assert!(sandbox.exec_calls().is_empty());
    history_mock.assert_calls_async(1).await;
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, claude_history_path(session_id));
    assert_eq!(writes[0].content, history);
    let ops = telemetry.pending_ops_snapshot();
    assert_failed_action_error_once(
        &ops,
        "session_history_identity_reuse_verify",
        SESSION_HISTORY_IDENTITY_REUSE_VERIFY_ERROR,
    );
    assert_successful_action(
        &ops,
        "session_history_identity_verify_helper_history_mismatch",
    );
    assert!(
        ops.iter()
            .any(|op| op.0 == "session_history_restore_fallback_stale_idle_identity" && op.1),
        "expected helper failure stale fallback telemetry, got: {ops:?}"
    );
    assert!(
        ops.iter().all(|op| op.0 != "session_history_restore_skip"),
        "helper failure should not record skip telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_restores_when_checkpointed_final_identity_helper_exec_errors() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = br#"{"type":"init"}"#;
    let server = MockServer::start_async().await;
    let history_mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/history.blob");
            then.status(200).body(history);
        })
        .await;
    let mut ctx = minimal_context();
    let session_id = "sess-final-helper-exec-errors-123";
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: session_id.into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: server.url("/history.blob?token=secret"),
                encoding: ResumeSessionHistoryEncoding::Identity,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
                download_source: None,
            },
        },
    });
    let (metadata_path, runtime_dir) = final_identity_runtime_paths(&ctx);
    let metadata = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        hex::encode(Sha256::digest(session_id.as_bytes())),
        SessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(history)),
        history.len() as u64,
        claude_history_source(session_id),
    )
    .unwrap();
    let idle_identity =
        RestoredSessionIdentity::from_final_metadata(metadata, metadata_path.clone(), runtime_dir)
            .expect("checkpointed identity");
    sandbox.push_exec_result(Err(sandbox_exec_error("vsock exec failed")));
    sandbox.push_read_file_result(Ok(None));
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::SandboxReused,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_session_history_restore_plan(SessionHistoryRestorePlan::SkipVerified(
                idle_identity,
            )),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    assert!(result.reusable_session_identity.is_none());
    history_mock.assert_calls_async(1).await;
    assert_eq!(sandbox.session_history_identity_verify_calls().len(), 1);
    assert!(sandbox.exec_calls().is_empty());
    let ops = telemetry.pending_ops_snapshot();
    assert_failed_action_error_once(
        &ops,
        "session_history_identity_reuse_verify",
        SESSION_HISTORY_IDENTITY_REUSE_VERIFY_ERROR,
    );
    assert_successful_action(&ops, "session_history_identity_verify_helper_exec_error");
    assert_successful_action(&ops, "session_history_restore_fallback_stale_idle_identity");
    assert!(
        ops.iter().all(|op| op.0 != "session_history_restore_skip"),
        "helper exec error should not record skip telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_restores_when_checkpointed_final_identity_helper_times_out() {
    assert_checkpointed_final_identity_helper_failure_falls_back(
        "sess-final-helper-timeout-123",
        ExecResult {
            termination: ExecTermination::TimedOut,
            guest_duration_ms: None,
            stdout: Vec::new(),
            stderr: Vec::new(),
            diagnostic: "session history identity helper timed out".to_string(),
            stdout_truncated: false,
            stderr_truncated: false,
        },
        "session_history_identity_verify_helper_timed_out",
    )
    .await;
}

#[tokio::test]
async fn run_in_sandbox_restores_when_checkpointed_final_identity_helper_is_over_budget() {
    assert_checkpointed_final_identity_helper_failure_falls_back(
        "sess-final-helper-too-large-123",
        ExecResult::new(
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE,
            Vec::new(),
            Vec::new(),
        ),
        "session_history_identity_verify_helper_history_too_large",
    )
    .await;
}

#[tokio::test]
async fn run_in_sandbox_restores_when_skip_verified_identity_mismatches_request() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = br#"{"type":"init"}"#;
    let server = MockServer::start_async().await;
    let history_mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/history.blob");
            then.status(200).body(history);
        })
        .await;
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-mismatch-skip-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: server.url("/history.blob?token=secret"),
                encoding: ResumeSessionHistoryEncoding::Identity,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
                download_source: None,
            },
        },
    });
    let mut mismatched_ctx = minimal_context();
    mismatched_ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-other-skip-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: server.url("/other-history.blob?token=secret"),
                encoding: ResumeSessionHistoryEncoding::Identity,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
                download_source: None,
            },
        },
    });
    let idle_identity =
        crate::executor::session_restore::restored_session_identity_from_context(&mismatched_ctx)
            .expect("identity");
    sandbox.push_read_file_result(Ok(None));
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::SandboxReused,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_session_history_restore_plan(SessionHistoryRestorePlan::SkipVerified(
                idle_identity,
            )),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    assert!(result.reusable_session_identity.is_none());
    history_mock.assert_calls_async(1).await;
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        "/home/user/.claude/projects/-home-user-workspace/sess-mismatch-skip-123.jsonl"
    );
    assert_eq!(writes[0].content, history);
    let ops = telemetry.pending_ops_snapshot();
    assert_failed_action_error_once(
        &ops,
        "session_history_identity_reuse_verify",
        SESSION_HISTORY_IDENTITY_REUSE_VERIFY_ERROR,
    );
    assert_successful_action(&ops, "session_history_identity_verify_request_mismatch");
    assert!(
        ops.iter()
            .any(|op| op.0 == "session_history_restore_fallback_stale_idle_identity" && op.1),
        "expected mismatch fallback telemetry, got: {ops:?}"
    );
    assert!(
        ops.iter().all(|op| op.0 != "session_history_restore_skip"),
        "mismatched identity should not record skip telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_records_mismatch_fallback_and_restores_prestarted_history() {
    const RELATIONSHIP_ACTIONS: [&str; 4] = [
        "session_history_identity_mismatch_history_hash_requested_smaller",
        "session_history_identity_mismatch_history_hash_requested_equal",
        "session_history_identity_mismatch_history_hash_requested_larger",
        "session_history_identity_mismatch_history_hash_size_unknown",
    ];
    let cases = [
        (
            RestoredSessionIdentityMismatchReason::HistoryHash(
                RestoredSessionHistoryHashSizeRelationship::RequestedSmaller,
            ),
            "session_history_identity_mismatch_history_hash",
            Some("session_history_identity_mismatch_history_hash_requested_smaller"),
        ),
        (
            RestoredSessionIdentityMismatchReason::HistoryHash(
                RestoredSessionHistoryHashSizeRelationship::RequestedEqual,
            ),
            "session_history_identity_mismatch_history_hash",
            Some("session_history_identity_mismatch_history_hash_requested_equal"),
        ),
        (
            RestoredSessionIdentityMismatchReason::HistoryHash(
                RestoredSessionHistoryHashSizeRelationship::RequestedLarger,
            ),
            "session_history_identity_mismatch_history_hash",
            Some("session_history_identity_mismatch_history_hash_requested_larger"),
        ),
        (
            RestoredSessionIdentityMismatchReason::HistoryHash(
                RestoredSessionHistoryHashSizeRelationship::SizeUnknown,
            ),
            "session_history_identity_mismatch_history_hash",
            Some("session_history_identity_mismatch_history_hash_size_unknown"),
        ),
        (
            RestoredSessionIdentityMismatchReason::SessionIdentity,
            "session_history_identity_mismatch_session_identity",
            None,
        ),
    ];

    for (reason, aggregate_action, expected_relationship_action) in cases {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let sandbox = sandbox_mock::MockSandbox::new("test");
        let history = br#"{"type":"init"}"#;
        let server = MockServer::start_async().await;
        let history_mock = server
            .mock_async(|when, then| {
                when.method(GET).path("/history.blob");
                then.status(200).body(history);
            })
            .await;
        let mut ctx = minimal_context();
        ctx.resume_session = Some(ResumeSession {
            cli_agent_session_id: "sess-fallback-123".into(),
            history: ResumeSessionHistory::Ref {
                history_ref: ResumeSessionHistoryRef {
                    kind: ResumeSessionHistoryRefKind::Blob,
                    hash: hex::encode(Sha256::digest(history)),
                    url: server.url("/history.blob?token=secret"),
                    encoding: ResumeSessionHistoryEncoding::Identity,
                    raw_size: history.len() as u64,
                    encoded_size: history.len() as u64,
                    download_source: None,
                },
            },
        });
        sandbox.push_read_file_result(Ok(None));
        let materializer = SessionHistoryMaterializer::start_cancellable(
            &config.http,
            &config.session_history_cpu,
            ctx.resume_session.as_ref(),
            effective_cli_framework(&ctx.cli_agent_type),
            tokio_util::sync::CancellationToken::new(),
            None,
        );
        let mut telemetry = test_telemetry(&config, &ctx);

        let result = run_in_sandbox(
            &sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::Reused,
                workspace_reuse_result: runner_types::types::WorkspaceReuseResult::SandboxReused,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(tokio_util::sync::CancellationToken::new(), None)
                .with_session_history_restore_plan(SessionHistoryRestorePlan::Prestarted {
                    materializer,
                    fallback: Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                        reason,
                    ))),
                }),
        )
        .await
        .unwrap();

        assert!(result.failure.is_none());
        assert!(result.reusable_session_identity.is_none());
        history_mock.assert_calls_async(1).await;
        let writes = sandbox.write_file_calls();
        assert_eq!(writes.len(), 1);
        assert_eq!(
            writes[0].path,
            "/home/user/.claude/projects/-home-user-workspace/sess-fallback-123.jsonl"
        );
        assert_eq!(writes[0].content, history);
        let ops = telemetry.pending_ops_snapshot();
        assert!(
            ops.iter()
                .any(|op| op.0 == "session_history_restore_fallback_identity_mismatch" && op.1),
            "expected fallback telemetry, got: {ops:?}"
        );
        assert_successful_action(&ops, aggregate_action);
        for action in RELATIONSHIP_ACTIONS {
            let expected_count = usize::from(expected_relationship_action == Some(action));
            assert_eq!(
                ops.iter().filter(|op| op.0 == action).count(),
                expected_count,
                "unexpected relationship telemetry for {reason:?}: {ops:?}"
            );
            if expected_count == 1 {
                assert_successful_action(&ops, action);
            }
        }
        assert!(
            ops.iter()
                .any(|op| op.0 == "session_history_download" && op.1),
            "expected download telemetry, got: {ops:?}"
        );
        assert!(
            ops.iter().any(|op| op.0 == "session_restore" && op.1),
            "expected restore telemetry, got: {ops:?}"
        );
        assert_successful_action(&ops, "session_history_identity_finalize_missing_metadata");
        assert!(
            ops.iter()
                .all(|op| { !op.0.starts_with("session_history_requested_larger_prefix_") }),
            "ineligible materializers must not emit prefix attribution telemetry: {ops:?}"
        );
    }
}

#[tokio::test]
async fn run_in_sandbox_records_requested_larger_prefix_outcomes_without_changing_restore() {
    let requested_history = b"prefix\nextension\n";
    let cases: [(&[u8], bool); 2] = [(b"prefix\n", true), (b"differ\n", false)];

    for (local_history, expected_verified) in cases {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let sandbox = sandbox_mock::MockSandbox::new("test");
        let server = MockServer::start_async().await;
        let history_mock = server
            .mock_async(|when, then| {
                when.method(GET).path("/history.blob");
                then.status(200).body(requested_history);
            })
            .await;
        let requested_hash = hex::encode(Sha256::digest(requested_history));
        let local_hash = hex::encode(Sha256::digest(local_history));
        let mut ctx = minimal_context();
        ctx.resume_session = Some(ResumeSession {
            cli_agent_session_id: "sess-prefix-attribution-123".into(),
            history: ResumeSessionHistory::Ref {
                history_ref: ResumeSessionHistoryRef {
                    kind: ResumeSessionHistoryRefKind::Blob,
                    hash: requested_hash.clone(),
                    url: server.url("/history.blob?token=secret"),
                    encoding: ResumeSessionHistoryEncoding::Identity,
                    raw_size: requested_history.len() as u64,
                    encoded_size: requested_history.len() as u64,
                    download_source: None,
                },
            },
        });
        sandbox.push_read_file_result(Ok(None));
        let materializer = SessionHistoryMaterializer::start_cancellable_with_prefix_attribution(
            &config.http,
            &config.session_history_cpu,
            ctx.resume_session.as_ref(),
            effective_cli_framework(&ctx.cli_agent_type),
            tokio_util::sync::CancellationToken::new(),
            None,
            history_prefix_attribution(local_history),
        );
        let mut telemetry = test_telemetry(&config, &ctx);

        let result = run_in_sandbox(
            &sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::Reused,
                workspace_reuse_result: runner_types::types::WorkspaceReuseResult::SandboxReused,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(tokio_util::sync::CancellationToken::new(), None)
                .with_session_history_restore_plan(SessionHistoryRestorePlan::Prestarted {
                    materializer,
                    fallback: Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                        RestoredSessionIdentityMismatchReason::HistoryHash(
                            RestoredSessionHistoryHashSizeRelationship::RequestedLarger,
                        ),
                    ))),
                }),
        )
        .await
        .unwrap();

        assert!(result.failure.is_none());
        assert!(result.reusable_session_identity.is_none());
        history_mock.assert_calls_async(1).await;
        let writes = sandbox.write_file_calls();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].content, requested_history);

        let ops = telemetry.pending_ops_snapshot();
        assert_successful_action_once(&ops, "session_history_restore_fallback_identity_mismatch");
        assert_successful_action_once(&ops, "session_history_identity_mismatch_history_hash");
        assert_successful_action_once(
            &ops,
            "session_history_identity_mismatch_history_hash_requested_larger",
        );
        assert_successful_action_once(&ops, "session_history_download");
        assert_successful_action_once(&ops, "session_restore");

        let extension_actions = ops
            .iter()
            .filter(|op| {
                op.0.starts_with("session_history_requested_larger_prefix_extension_")
            })
            .count();
        if expected_verified {
            assert_successful_action_once(&ops, "session_history_requested_larger_prefix_verified");
            assert_no_action(&ops, "session_history_requested_larger_prefix_divergent");
            assert_successful_action_once(
                &ops,
                "session_history_requested_larger_prefix_extension_lt_64_kib",
            );
            assert_eq!(
                extension_actions, 1,
                "unexpected extension actions: {ops:?}"
            );
        } else {
            assert_no_action(&ops, "session_history_requested_larger_prefix_verified");
            assert_successful_action_once(
                &ops,
                "session_history_requested_larger_prefix_divergent",
            );
            assert_eq!(
                extension_actions, 0,
                "unexpected extension actions: {ops:?}"
            );
        }

        let diagnostics = format!("{ops:?}");
        assert!(!diagnostics.contains(&requested_hash));
        assert!(!diagnostics.contains(&local_hash));
        assert!(!diagnostics.contains("token=secret"));
        assert!(!diagnostics.contains("prefix\nextension"));
    }
}

#[tokio::test]
async fn run_in_sandbox_records_missing_idle_identity_reuse_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = br#"{"type":"init"}"#;
    let server = MockServer::start_async().await;
    let history_mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/history.blob");
            then.status(200).body(history);
        })
        .await;
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-missing-identity-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: server.url("/history.blob?token=secret"),
                encoding: ResumeSessionHistoryEncoding::Identity,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
                download_source: None,
            },
        },
    });
    sandbox.push_read_file_result(Ok(None));
    let materializer = SessionHistoryMaterializer::start_cancellable(
        &config.http,
        &config.session_history_cpu,
        ctx.resume_session.as_ref(),
        effective_cli_framework(&ctx.cli_agent_type),
        tokio_util::sync::CancellationToken::new(),
        None,
    );
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::SandboxReused,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_session_history_restore_plan(SessionHistoryRestorePlan::Prestarted {
                materializer,
                fallback: Some(SessionHistoryRestoreFallback::MissingIdleIdentity),
            }),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    assert!(result.reusable_session_identity.is_none());
    history_mock.assert_calls_async(1).await;
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        "/home/user/.claude/projects/-home-user-workspace/sess-missing-identity-123.jsonl"
    );
    assert_eq!(writes[0].content, history);
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action(
        &ops,
        "session_history_identity_reuse_missing_no_idle_identity",
    );
    assert_successful_action(&ops, "session_history_identity_finalize_missing_metadata");
    assert!(
        ops.iter()
            .any(|op| { op.0 == "session_history_restore_fallback_missing_idle_identity" && op.1 }),
        "expected missing identity fallback telemetry, got: {ops:?}"
    );
    assert!(
        ops.iter()
            .any(|op| op.0 == "session_history_identity_reuse_missing" && op.1),
        "expected identity reuse missing telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn reused_sandbox_fallback_materializes_prune_eligible_codex_zstd_as_raw() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let session_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let history =
        b"{\"type\":\"session_meta\",\"payload\":{\"timestamp\":\"2026-06-04T07:18:08Z\"}}\n";
    let compressed_history = zstd::encode_all(history.as_slice(), 0).unwrap();
    config.session_history_cpu =
        SessionHistoryCpuPool::with_test_codex_raw_restore_threshold(1, history.len() as u64 - 1);
    let server = MockServer::start_async().await;
    let history_mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/history.blob");
            then.status(200).body(&compressed_history);
        })
        .await;
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: session_id.into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: server.url("/history.blob?token=secret"),
                encoding: ResumeSessionHistoryEncoding::Zstd,
                raw_size: history.len() as u64,
                encoded_size: compressed_history.len() as u64,
                download_source: None,
            },
        },
    });
    sandbox.push_read_file_result(Ok(None));
    let materializer = SessionHistoryMaterializer::start_cancellable(
        &config.http,
        &config.session_history_cpu,
        ctx.resume_session.as_ref(),
        effective_cli_framework(&ctx.cli_agent_type),
        tokio_util::sync::CancellationToken::new(),
        None,
    );
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::SandboxReused,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_session_history_restore_plan(SessionHistoryRestorePlan::Prestarted {
                materializer,
                fallback: Some(SessionHistoryRestoreFallback::MissingIdleIdentity),
            }),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    history_mock.assert_calls_async(1).await;
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        "/home/user/.codex/sessions/2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl"
    );
    assert_eq!(writes[0].content, history);
}
