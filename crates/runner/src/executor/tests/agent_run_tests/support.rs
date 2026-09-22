use api_contracts::generated::constants::runners::paths::CANONICAL_GUEST_HOME_DIR;
use guest_contracts::session_history_identity::{
    SessionHistoryFramework, SessionHistoryIdentity, SessionHistoryRefKind, SessionHistorySourceRef,
};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::executor::workspace_session_history_materializer::WorkspaceSessionHistoryMaterializer;
use crate::executor::{ExecutorConfig, SessionHistoryRestorePlan, effective_cli_framework};
use crate::workspace_image_cache::WorkspaceSessionHistorySidecar;
use runner_types::types::ExecutionContext;

pub(super) async fn local_sidecar_restore_plan(
    context: &ExecutionContext,
    config: &ExecutorConfig,
    sidecar: WorkspaceSessionHistorySidecar,
    cancel: CancellationToken,
) -> SessionHistoryRestorePlan {
    let materializer = WorkspaceSessionHistoryMaterializer::start(
        sidecar,
        context.resume_session.as_ref(),
        effective_cli_framework(&context.cli_agent_type),
        &config.session_history_cpu,
        cancel,
    )
    .await;
    SessionHistoryRestorePlan::LocalSidecar {
        materializer,
        fallback: None,
    }
}

pub(super) fn claude_history_path(session_id: &str) -> String {
    format!("/home/user/.claude/projects/-home-user-workspace/{session_id}.jsonl")
}

pub(super) fn claude_history_source(session_id: &str) -> SessionHistorySourceRef {
    SessionHistorySourceRef::ClaudeCode {
        config_dir: "/home/user/.claude".to_string(),
        working_dir: "/home/user/workspace".to_string(),
        session_id: session_id.to_string(),
    }
}

pub(super) fn final_identity_runtime_paths(
    ctx: &runner_types::types::ExecutionContext,
) -> (String, String) {
    let run_dir = guest_contracts::runtime_paths::run_dir_for_home(
        CANONICAL_GUEST_HOME_DIR,
        &ctx.run_id.to_string(),
    )
    .unwrap();
    let metadata_path =
        guest_contracts::runtime_paths::final_session_history_identity_file(&run_dir)
            .to_string_lossy()
            .into_owned();
    (metadata_path, run_dir.to_string_lossy().into_owned())
}

pub(super) fn final_identity_metadata_bytes(session_id: &str, history: &[u8]) -> Vec<u8> {
    SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        hex::encode(Sha256::digest(session_id.as_bytes())),
        SessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(history)),
        history.len() as u64,
        claude_history_source(session_id),
    )
    .unwrap()
    .to_json_vec()
    .unwrap()
}

pub(super) fn assert_successful_action_once(ops: &[(String, bool, Option<String>)], action: &str) {
    let matches = ops.iter().filter(|op| op.0 == action && op.1).count();
    assert_eq!(
        matches, 1,
        "expected exactly one successful {action} telemetry, got: {ops:?}"
    );
}

pub(super) fn assert_failed_action_error_once(
    ops: &[(String, bool, Option<String>)],
    action: &str,
    error: &str,
) {
    let matches = ops
        .iter()
        .filter(|op| op.0 == action && !op.1 && op.2.as_deref() == Some(error))
        .count();
    assert_eq!(
        matches, 1,
        "expected exactly one failed {action} telemetry with {error:?}, got: {ops:?}"
    );
}

pub(super) fn assert_no_action(ops: &[(String, bool, Option<String>)], action: &str) {
    assert!(
        ops.iter().all(|op| op.0 != action),
        "expected no {action} telemetry, got: {ops:?}"
    );
}
