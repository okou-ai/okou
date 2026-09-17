mod claude;
mod codex;
mod compression;
mod identity;
mod pi;
mod validation;

use sandbox_mock::MockSandbox;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use tracing_subscriber::prelude::*;

use super::super::DEFAULT_EXEC_TIMEOUT;
use super::super::session_history_cpu::codex_timestamp_for_test;
use super::super::session_restore::{
    MaterializedResumeSession, SessionRestoreDiagnostics,
    restore_session as restore_session_with_reuse_result,
};
use super::support::{CapturedEvent, CapturedEvents, minimal_context};
use crate::types::{
    ExecutionContext, ResumeSession, ResumeSessionHistory, ResumeSessionHistoryEncoding,
    ResumeSessionHistoryRef, ResumeSessionHistoryRefKind, SandboxReuseResult,
};

static RESTORE_SESSION_LOG_CALLSITE_LOCK: Mutex<()> = Mutex::new(());

const CODEX_SESSION_ID: &str = "019e9154-c304-70f0-adde-36efb1be1701";
const CODEX_SESSION_ID_COMPACT_UPPERCASE: &str = "019E9154C30470F0ADDE36EFB1BE1701";
const CODEX_SESSION_ID_MIXED_CASE: &str = "019e9154C30470f0ADDE36efB1be1701";
const CODEX_SESSION_ID_NO_DASHES: &str = "019e9154c30470f0adde36efb1be1701";
const CODEX_CANONICAL_ROLLOUT_PATH: &str = "/home/user/.codex/sessions/2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl";
const CODEX_EXISTING_ROLLOUT_PATH: &str = "/home/user/.codex/sessions/2026/07/23/rollout-2026-07-23T04-01-04-019e9154-c304-70f0-adde-36efb1be1701.jsonl";
const CODEX_CANONICAL_ROLLOUT_SUFFIX: &str =
    "/2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl";
const CODEX_CANONICAL_ROLLOUT_FILENAME_SUFFIX: &str = "-019e9154-c304-70f0-adde-36efb1be1701.jsonl";

fn materialized_text_session(
    session_id: impl Into<String>,
    history: impl Into<String>,
) -> MaterializedResumeSession {
    let history = history.into().into_bytes();
    let timestamp = codex_timestamp_for_test(&history);
    MaterializedResumeSession::new(session_id.into(), history, timestamp)
}

fn materialized_bytes_session(
    session_id: impl Into<String>,
    history: &[u8],
) -> MaterializedResumeSession {
    MaterializedResumeSession::new(
        session_id.into(),
        history.to_vec(),
        codex_timestamp_for_test(history),
    )
}

fn materialized_codex_zstd_session(
    session_id: impl Into<String>,
    history: &[u8],
    timestamp: chrono::DateTime<chrono::Utc>,
) -> MaterializedResumeSession {
    MaterializedResumeSession::new_codex_zstd(session_id.into(), history.to_vec(), Some(timestamp))
}

fn history_ref(hash: impl Into<String>, raw_size: u64) -> ResumeSessionHistoryRef {
    ResumeSessionHistoryRef {
        kind: ResumeSessionHistoryRefKind::Blob,
        hash: hash.into(),
        url: "https://example.com/history".into(),
        encoding: ResumeSessionHistoryEncoding::Identity,
        raw_size,
        encoded_size: raw_size,
        download_source: None,
    }
}

fn history_ref_for_bytes(history: &[u8]) -> ResumeSessionHistoryRef {
    history_ref(hex::encode(Sha256::digest(history)), history.len() as u64)
}

fn resume_ref(
    session_id: impl Into<String>,
    history_ref: ResumeSessionHistoryRef,
) -> ResumeSession {
    ResumeSession {
        cli_agent_session_id: session_id.into(),
        history: ResumeSessionHistory::Ref { history_ref },
    }
}

fn resume_ref_for_history(session_id: impl Into<String>, history: &[u8]) -> ResumeSession {
    resume_ref(session_id, history_ref_for_bytes(history))
}

fn claude_context() -> ExecutionContext {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "claude-code".into();
    ctx
}

fn codex_context() -> ExecutionContext {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx
}

fn pi_context() -> ExecutionContext {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "pi".into();
    ctx
}

fn codex_session_meta_history(session_id: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({
            "timestamp": "2026-06-04T07:18:08.001Z",
            "type": "session_meta",
            "payload": {
                "id": session_id,
                "timestamp": "2026-06-04T07:18:08.000Z",
                "cwd": "/workspace",
                "originator": "test",
                "cli_version": "0.137.0",
                "source": "cli",
                "model_provider": "test-provider",
                "base_instructions": null,
            },
        }),
    )
}

fn codex_minimal_session_meta_history(session_id: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({
            "timestamp": "2026-06-04T07:18:08.001Z",
            "type": "session_meta",
            "payload": {
                "id": session_id,
                "timestamp": "2026-06-04T07:18:08.000Z",
            },
        }),
    )
}

async fn restore_session(
    sandbox: &MockSandbox,
    context: &ExecutionContext,
    session: &MaterializedResumeSession,
) -> super::super::RunnerResult<SessionRestoreDiagnostics> {
    restore_session_with_reuse_result(sandbox, context, session, SandboxReuseResult::Reused).await
}

async fn restore_session_in_fresh_sandbox(
    sandbox: &MockSandbox,
    context: &ExecutionContext,
    session: &MaterializedResumeSession,
) -> super::super::RunnerResult<SessionRestoreDiagnostics> {
    restore_session_with_reuse_result(sandbox, context, session, SandboxReuseResult::PoolMiss).await
}

fn assert_codex_cleanup_call(sandbox: &MockSandbox) {
    assert!(sandbox.exec_calls().is_empty());
    let calls = sandbox.codex_session_cleanup_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].session_id, CODEX_SESSION_ID);
    let thread_id = guest_contracts::codex_thread_id::CodexThreadId::parse(CODEX_SESSION_ID)
        .expect("test Codex session id");
    assert!(
        guest_contracts::codex_session_path::is_canonical_codex_rollout_relative_path(
            &calls[0].fallback_relative_path,
            &thread_id,
        )
    );
    assert_eq!(calls[0].timeout, DEFAULT_EXEC_TIMEOUT);
}

fn capture_restore_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
where
    F: std::future::Future,
{
    let _capture_guard = RESTORE_SESSION_LOG_CALLSITE_LOCK
        .lock()
        .expect("restore session log callsite lock poisoned");
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    let output = block_on_restore_session(future);
    drop(guard);
    (output, captured.entries())
}

fn run_restore_session<F>(future: F) -> F::Output
where
    F: std::future::Future,
{
    let _capture_guard = RESTORE_SESSION_LOG_CALLSITE_LOCK
        .lock()
        .expect("restore session log callsite lock poisoned");
    block_on_restore_session(future)
}

fn block_on_restore_session<F>(future: F) -> F::Output
where
    F: std::future::Future,
{
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build restore session test runtime")
        .block_on(future)
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
