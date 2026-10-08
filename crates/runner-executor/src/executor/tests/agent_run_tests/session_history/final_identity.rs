use guest_contracts::session_history_identity::FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES;
use httpmock::prelude::*;
use sha2::{Digest, Sha256};

use super::{LARGE_SESSION_HISTORY_SIZE_BYTES, assert_successful_action, serve_history_once};
use crate::executor::agent_run::{RunControls, RunStart, run_in_sandbox};
use crate::executor::tests::agent_run_tests::support::{
    assert_failed_action_error_once, final_identity_metadata_bytes, final_identity_runtime_paths,
};
use crate::executor::tests::support::{
    minimal_context, sandbox_read_file_error, test_executor_config, test_telemetry,
};
use crate::executor::{
    SessionHistoryMaterializer, SessionHistoryRestorePlan, effective_cli_framework,
};
use crate::telemetry::SessionHistoryTelemetrySnapshot;
use runner_types::types::{
    ResumeSession, ResumeSessionHistory, ResumeSessionHistoryEncoding, ResumeSessionHistoryRef,
    ResumeSessionHistoryRefKind, SandboxReuseResult,
};

fn assert_failed_action_with_session_history_metadata(
    ops: &[SessionHistoryTelemetrySnapshot],
    action: &str,
    error: &str,
    encoding: &str,
    raw_size_bucket: &str,
    encoded_size_bucket: &str,
    compression_ratio_bucket: &str,
) {
    assert!(
        ops.iter().any(|op| {
            op.action_type == action
                && !op.success
                && op.error.as_deref() == Some(error)
                && op.session_history.is_some_and(|fields| {
                    fields.encoding() == encoding
                        && fields.raw_size_bucket() == raw_size_bucket
                        && fields.encoded_size_bucket() == encoded_size_bucket
                        && fields.compression_ratio_bucket() == compression_ratio_bucket
                })
        }),
        "expected failed {action} telemetry with session history metadata, got: {ops:?}"
    );
}
#[tokio::test]
async fn run_in_sandbox_uses_final_identity_when_restored_history_changes_before_parking() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = br#"{"type":"init"}"#;
    let final_history = br#"{"type":"done"}"#;
    let server = MockServer::start_async().await;
    server
        .mock_async(|when, then| {
            when.method(GET).path("/history.blob");
            then.status(200).body(history);
        })
        .await;
    let mut ctx = minimal_context();
    let session_id = "sess-final-mutated-123";
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
    let (metadata_path, _) = final_identity_runtime_paths(&ctx);
    sandbox.push_read_file_result(Ok(Some(final_identity_metadata_bytes(
        session_id,
        final_history,
    ))));
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
                fallback: None,
            }),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    let identity = result
        .reusable_session_identity
        .as_ref()
        .expect("final identity");
    assert_eq!(
        identity.history_hash(),
        hex::encode(Sha256::digest(final_history))
    );
    assert_eq!(
        identity.history_size_bytes(),
        Some(final_history.len() as u64)
    );
    assert_eq!(identity.final_metadata_path(), Some(metadata_path.as_str()));
    let read_calls = sandbox.read_file_calls();
    assert_eq!(read_calls.len(), 1);
    assert_eq!(read_calls[0].path, metadata_path);
    assert_eq!(
        read_calls[0].max_bytes,
        FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES + 1
    );
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter()
            .any(|op| op.0 == "session_history_identity_finalized" && op.1),
        "expected final identity telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_uses_final_identity_without_resume_request() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = br#"{"type":"init"}"#;
    let ctx = minimal_context();
    let session_id = "sess-first-turn-final-123";
    let (metadata_path, _) = final_identity_runtime_paths(&ctx);
    sandbox.push_read_file_result(Ok(Some(final_identity_metadata_bytes(session_id, history))));
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    let identity = result
        .reusable_session_identity
        .as_ref()
        .expect("final identity");
    assert_eq!(
        identity.history_hash(),
        hex::encode(Sha256::digest(history))
    );
    assert_eq!(identity.history_size_bytes(), Some(history.len() as u64));
    assert_eq!(identity.final_metadata_path(), Some(metadata_path.as_str()));
    let read_calls = sandbox.read_file_calls();
    assert_eq!(read_calls.len(), 1);
    assert_eq!(read_calls[0].path, metadata_path);
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter()
            .any(|op| op.0 == "session_history_identity_finalized" && op.1),
        "expected first-turn final identity telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_records_invalid_final_identity_metadata_reason() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let ctx = minimal_context();
    sandbox.push_read_file_result(Ok(Some(b"{not-json".to_vec())));
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    assert!(result.reusable_session_identity.is_none());
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action(&ops, "session_history_identity_finalize_invalid_metadata");
    assert!(
        ops.iter()
            .all(|op| op.0 != "session_history_identity_finalized"),
        "invalid metadata should not record finalized identity telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_records_oversized_final_identity_metadata_reason() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let ctx = minimal_context();
    let session_id = "sess-oversized-final-123";
    let history = br#"{"type":"init"}"#;
    let (metadata_path, _) = final_identity_runtime_paths(&ctx);
    let mut metadata = final_identity_metadata_bytes(session_id, history);
    let oversized_metadata_len = FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES as usize + 1;
    assert!(metadata.len() < oversized_metadata_len);
    metadata.resize(oversized_metadata_len, b' ');
    serde_json::from_slice::<serde_json::Value>(&metadata).unwrap();
    sandbox.push_read_file_result(Ok(Some(metadata)));
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    assert!(result.reusable_session_identity.is_none());
    let read_calls = sandbox.read_file_calls();
    assert_eq!(read_calls.len(), 1);
    assert_eq!(read_calls[0].path, metadata_path);
    assert_eq!(
        read_calls[0].max_bytes,
        FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES + 1
    );
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action(
        &ops,
        "session_history_identity_finalize_unverifiable_metadata",
    );
    assert!(
        ops.iter().all(|op| {
            op.0 != "session_history_identity_finalize_invalid_metadata"
                && op.0 != "session_history_identity_finalized"
        }),
        "oversized metadata should not record invalid or finalized identity telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_records_large_final_identity_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let ctx = minimal_context();
    let (metadata_path, _) = final_identity_runtime_paths(&ctx);
    let session_id = "large-history";
    let metadata = serde_json::json!({
        "framework": "claude-code",
        "sessionIdHash": hex::encode(Sha256::digest(session_id.as_bytes())),
        "historyRefKind": "blob",
        "historyHash": "b".repeat(64),
        "historySizeBytes": LARGE_SESSION_HISTORY_SIZE_BYTES,
        "historySource": {
            "kind": "claude-code",
            "configDir": "/home/user/.claude",
            "workingDir": "/home/user/workspace",
            "sessionId": session_id,
        },
    });
    sandbox.push_read_file_result(Ok(Some(serde_json::to_vec(&metadata).unwrap())));
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    let identity = result
        .reusable_session_identity
        .as_ref()
        .expect("large final identity");
    assert_eq!(
        identity.history_size_bytes(),
        Some(LARGE_SESSION_HISTORY_SIZE_BYTES as u64)
    );
    assert_eq!(identity.final_metadata_path(), Some(metadata_path.as_str()));
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter()
            .any(|op| op.0 == "session_history_identity_finalized" && op.1),
        "large metadata should record finalized identity telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_records_final_identity_metadata_read_failure_reason() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let ctx = minimal_context();
    sandbox.push_read_file_result(Err(sandbox_read_file_error("guest read failed")));
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    assert!(result.reusable_session_identity.is_none());
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action(
        &ops,
        "session_history_identity_finalize_metadata_read_failed",
    );
    assert!(
        ops.iter()
            .all(|op| op.0 != "session_history_identity_finalized"),
        "metadata read failure should not record finalized identity telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_redacts_session_history_download_details_from_telemetry() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = br#"{"type":"init"}"#;
    let expected_hash = hex::encode(Sha256::digest(b"different"));
    let actual_hash = hex::encode(Sha256::digest(history));
    let history_server = serve_history_once(history).await;
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-ref-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: expected_hash.clone(),
                url: history_server.url(),
                encoding: ResumeSessionHistoryEncoding::Identity,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
                download_source: None,
            },
        },
    });
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await;
    let error = match result {
        Ok(_) => panic!("expected session history hash mismatch error"),
        Err(error) => error,
    };

    assert!(error.to_string().contains("hash mismatch"));
    assert!(!error.to_string().contains(&expected_hash));
    assert!(!error.to_string().contains(&actual_hash));
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter().any(|op| {
            op.0 == "session_history_materialization_wait"
                && !op.1
                && op.2.as_deref() == Some("session history materialization failed")
        }),
        "expected redacted session history wait telemetry, got: {ops:?}"
    );
    assert_failed_action_error_once(
        &ops,
        "session_history_materializer_waited_at_restore",
        "session history materialization failed",
    );
    assert!(
        ops.iter().any(|op| {
            op.0 == "session_history_download"
                && !op.1
                && op.2.as_deref() == Some("session history download failed")
        }),
        "expected redacted session history download telemetry, got: {ops:?}"
    );
    assert_successful_action(&ops, "session_history_download_request_status");
    assert_successful_action(&ops, "session_history_download_body_read");
    assert_successful_action(&ops, "session_history_download_validation");
    assert_failed_action_error_once(
        &ops,
        "session_history_download_hash_verification",
        "session history download phase failed",
    );
    let metadata_ops = telemetry.pending_ops_with_session_history_metadata_snapshot();
    assert_failed_action_with_session_history_metadata(
        &metadata_ops,
        "session_history_materializer_waited_at_restore",
        "session history materialization failed",
        "identity",
        "lt_64_kib",
        "lt_64_kib",
        "identity",
    );
    assert_failed_action_with_session_history_metadata(
        &metadata_ops,
        "session_history_download",
        "session history download failed",
        "identity",
        "lt_64_kib",
        "lt_64_kib",
        "identity",
    );
    assert_failed_action_with_session_history_metadata(
        &metadata_ops,
        "session_history_download_hash_verification",
        "session history download phase failed",
        "identity",
        "lt_64_kib",
        "lt_64_kib",
        "identity",
    );
    let telemetry_debug = format!("{ops:?}");
    assert!(!telemetry_debug.contains(&expected_hash));
    assert!(!telemetry_debug.contains(&actual_hash));
    history_server.assert_served().await;
}
