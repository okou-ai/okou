use guest_contracts::session_history_identity::FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES;
use sha2::{Digest, Sha256};

use super::LARGE_SESSION_HISTORY_SIZE_BYTES;
use crate::executor::agent_run::{RunControls, RunStart, run_in_sandbox};
use crate::executor::tests::agent_run_tests::support::{
    final_identity_metadata_bytes, final_identity_runtime_paths,
};
use crate::executor::tests::support::{
    minimal_context, sandbox_read_file_error, test_executor_config, test_telemetry,
};
use runner_types::types::SandboxReuseResult;

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
            sandbox_startup_path: runner_types::types::SandboxStartupPath::Cold,
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
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
            sandbox_startup_path: runner_types::types::SandboxStartupPath::Cold,
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
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
            sandbox_startup_path: runner_types::types::SandboxStartupPath::Cold,
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
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
            sandbox_startup_path: runner_types::types::SandboxStartupPath::Cold,
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
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
            sandbox_startup_path: runner_types::types::SandboxStartupPath::Cold,
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
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

fn assert_successful_action(ops: &[(String, bool, Option<String>)], action: &str) {
    assert!(
        ops.iter().any(|op| op.0 == action && op.1),
        "expected {action} telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn unusable_home_proof_starts_fresh_with_the_required_chat_recovery_instruction() {
    use guest_contracts::home_cache_history::{
        HomeCacheHistoryProof, HomeCacheHistoryProofBinding,
    };
    use guest_contracts::session_history_identity::SessionHistoryIdentity;
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("native-recovery");
    let mut context = minimal_context();
    let recovery_prompt =
        "Before proceeding, read prior context with okou chat messages --output-dir threads";
    context.native_continuation = Some(guest_contracts::env::NativeContinuation {
        session_id: Some("native-session".into()),
        generation_run_id: Some(context.run_id.to_string()),
        recovery_prompt: Some(recovery_prompt.into()),
    });
    let identity = SessionHistoryIdentity::from_json_slice(&final_identity_metadata_bytes(
        "native-session",
        b"{}",
    ))
    .unwrap();
    let proof = HomeCacheHistoryProof {
        format_version: 1,
        generation: runner_types::ids::RunId::new_v4().to_string(),
        identity,
    };
    let binding = HomeCacheHistoryProofBinding {
        sha256: hex::encode(Sha256::digest(proof.to_json_vec().unwrap())),
        proof,
    };
    let mut controls = RunControls::new(tokio_util::sync::CancellationToken::new(), None);
    controls.home_history_proof = Some(binding);
    let mut telemetry = test_telemetry(&config, &context);
    let outcome = run_in_sandbox(
        &sandbox,
        &context,
        &config,
        RunStart {
            sandbox_startup_path: runner_types::types::SandboxStartupPath::Home,
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            home_reuse_result: runner_types::types::HomeReuseResult::Reused,
            prev_storage: None,
        },
        &mut telemetry,
        controls,
    )
    .await
    .unwrap();
    assert!(outcome.failure.is_none());
    let path = crate::executor::env::guest_run_payload_file_path(context.run_id).unwrap();
    let files = sandbox.private_write_files_calls();
    let payload = files
        .iter()
        .flat_map(|batch| &batch.files)
        .find(|file| file.path == path)
        .unwrap();
    let payload: guest_contracts::env::RunPayload =
        serde_json::from_slice(&payload.content).unwrap();
    let native: guest_contracts::env::NativeContinuation =
        serde_json::from_str(&payload.native_continuation).unwrap();
    assert_eq!(native.session_id, None);
    assert_eq!(native.generation_run_id, None);
    assert_eq!(native.recovery_prompt.as_deref(), Some(recovery_prompt));
}
