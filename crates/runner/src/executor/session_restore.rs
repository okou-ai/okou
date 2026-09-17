//! CLI session restore helpers for guest agent frameworks.

mod codex;
mod compression;

use std::sync::Arc;
use std::time::Instant;

use chrono::{DateTime, Utc};
use guest_contracts::cli_agent_session_id::is_valid_cli_agent_session_id;
use guest_contracts::codex_thread_id::canonical_codex_thread_id;
use guest_contracts::env::CliFramework;
use guest_contracts::session_history_identity::{SessionHistoryFramework, SessionHistoryRefKind};
use sandbox::Sandbox;
use tracing::{info, warn};

use super::cli_framework::{EffectiveCliFramework, effective_cli_framework};
use super::env::validate_resume_session_id;
use super::{RunnerError, RunnerResult};
use crate::restored_session_identity::RestoredSessionIdentity;
use crate::telemetry::HistoryTransferMeasurements;
use crate::types::{ExecutionContext, ResumeSessionHistoryRefKind, SandboxReuseResult};
use api_contracts::generated::constants::runners::paths::{
    CANONICAL_CLAUDE_CONFIG_DIR, CANONICAL_WORKING_DIR,
};

impl RestoredSessionIdentity {
    pub(crate) fn from_context(context: &ExecutionContext) -> Option<Self> {
        validate_resume_session_id(context).ok()?;
        let resume_session = context.resume_session.as_ref()?;
        let history_ref = resume_session.history_ref()?;
        let effective_framework = effective_cli_framework(&context.cli_agent_type);
        let framework = SessionHistoryFramework::from(CliFramework::from(effective_framework));
        let history_ref_kind = match history_ref.kind {
            ResumeSessionHistoryRefKind::Blob => SessionHistoryRefKind::Blob,
        };
        let session_id = restored_session_identity_session_id(
            effective_framework,
            &resume_session.cli_agent_session_id,
        )?;
        Some(Self::new(
            framework,
            &session_id,
            history_ref_kind,
            history_ref.hash.clone(),
            Some(history_ref.raw_size),
        ))
    }
}

fn restored_session_identity_session_id(
    framework: EffectiveCliFramework,
    session_id: &str,
) -> Option<String> {
    match framework {
        EffectiveCliFramework::ClaudeCode => Some(session_id.to_owned()),
        EffectiveCliFramework::Codex => canonical_codex_thread_id(session_id),
        EffectiveCliFramework::Pi => Some(session_id.to_owned()),
    }
}

#[derive(Debug)]
pub(super) struct MaterializedResumeSession {
    cli_agent_session_id: String,
    history: MaterializedResumeHistory,
    codex_timestamp: Option<DateTime<Utc>>,
}

#[derive(Debug)]
enum MaterializedResumeHistory {
    SharedText(Arc<String>),
    Bytes(Vec<u8>),
    CodexZstd(Vec<u8>),
}

impl MaterializedResumeSession {
    pub(super) fn new(
        cli_agent_session_id: String,
        history_bytes: Vec<u8>,
        codex_timestamp: Option<DateTime<Utc>>,
    ) -> Self {
        Self {
            cli_agent_session_id,
            history: MaterializedResumeHistory::Bytes(history_bytes),
            codex_timestamp,
        }
    }

    pub(super) fn new_shared(
        cli_agent_session_id: String,
        session_history: Arc<String>,
        codex_timestamp: Option<DateTime<Utc>>,
    ) -> Self {
        Self {
            cli_agent_session_id,
            history: MaterializedResumeHistory::SharedText(session_history),
            codex_timestamp,
        }
    }

    pub(super) fn new_codex_zstd(
        cli_agent_session_id: String,
        history_bytes: Vec<u8>,
        codex_timestamp: Option<DateTime<Utc>>,
    ) -> Self {
        Self {
            cli_agent_session_id,
            history: MaterializedResumeHistory::CodexZstd(history_bytes),
            codex_timestamp,
        }
    }

    pub(super) fn cli_agent_session_id(&self) -> &str {
        &self.cli_agent_session_id
    }

    pub(super) fn history_bytes(&self) -> &[u8] {
        match &self.history {
            MaterializedResumeHistory::SharedText(session_history) => session_history.as_bytes(),
            MaterializedResumeHistory::Bytes(history_bytes) => history_bytes,
            MaterializedResumeHistory::CodexZstd(bytes) => bytes,
        }
    }

    pub(super) fn codex_timestamp(&self) -> Option<DateTime<Utc>> {
        self.codex_timestamp
    }

    pub(super) fn codex_zstd_history(&self) -> Option<&[u8]> {
        match &self.history {
            MaterializedResumeHistory::CodexZstd(bytes) => Some(bytes),
            MaterializedResumeHistory::SharedText(_) | MaterializedResumeHistory::Bytes(_) => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct SessionRestoreDiagnostics {
    pub(super) framework: &'static str,
    pub(super) session_id: String,
    pub(super) bytes_in: usize,
    pub(super) transfer: HistoryTransferMeasurements,
}

pub(super) async fn restore_session(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session: &MaterializedResumeSession,
    sandbox_reuse_result: SandboxReuseResult,
) -> RunnerResult<SessionRestoreDiagnostics> {
    // Validate the CLI agent session id to prevent path traversal.
    // Only allow alnum, dash, and underscore.
    // Applied up-front so unknown frameworks still reject malformed IDs in case the
    // skip branch is ever upgraded to a write.
    if !is_valid_cli_agent_session_id(session.cli_agent_session_id()) {
        return Err(RunnerError::Internal("invalid session_id".into()));
    }

    match effective_cli_framework(&context.cli_agent_type) {
        EffectiveCliFramework::ClaudeCode => {
            if !matches!(context.cli_agent_type.as_str(), "" | "claude-code") {
                warn!(
                    run_id = %context.run_id,
                    framework = %context.cli_agent_type,
                    "restoring session as claude-code for unknown framework"
                );
            }
            restore_claude_session(sandbox, context, session).await
        }
        EffectiveCliFramework::Codex => {
            codex::restore_codex_session(sandbox, context, session, sandbox_reuse_result).await
        }
        EffectiveCliFramework::Pi => restore_pi_session(sandbox, context, session).await,
    }
}

/// Restore Pi's official JSONL session into its canonical workspace directory.
async fn restore_pi_session(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session: &MaterializedResumeSession,
) -> RunnerResult<SessionRestoreDiagnostics> {
    let session_history = session.history_bytes();
    let session_id = session.cli_agent_session_id();
    let session_dir = api_contracts::generated::constants::runners::paths::CANONICAL_PI_SESSION_DIR;
    let session_path = format!("{session_dir}/restored-{session_id}.jsonl");
    let transfer = write_session_history_file(sandbox, &session_path, session).await?;
    let diagnostics = SessionRestoreDiagnostics {
        framework: "pi",
        session_id: session_id.to_string(),
        bytes_in: session_history.len(),
        transfer,
    };
    info!(
        run_id = %context.run_id,
        framework = diagnostics.framework,
        session_id = %diagnostics.session_id,
        bytes_in = diagnostics.bytes_in,
        "restored session history"
    );
    Ok(diagnostics)
}

/// Write a Claude Code session history file at `~/.claude/projects/-{project}/{id}.jsonl`.
pub(super) async fn restore_claude_session(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session: &MaterializedResumeSession,
) -> RunnerResult<SessionRestoreDiagnostics> {
    let session_history = session.history_bytes();
    let project_name = CANONICAL_WORKING_DIR
        .trim_start_matches('/')
        .replace('/', "-");
    let session_dir = format!("{CANONICAL_CLAUDE_CONFIG_DIR}/projects/-{project_name}");
    let session_id = session.cli_agent_session_id();
    let session_path = format!("{session_dir}/{session_id}.jsonl");

    let transfer = write_session_history_file(sandbox, &session_path, session).await?;
    let diagnostics = SessionRestoreDiagnostics {
        framework: "claude-code",
        session_id: session_id.to_string(),
        bytes_in: session_history.len(),
        transfer,
    };
    info!(
        run_id = %context.run_id,
        framework = diagnostics.framework,
        session_id = %diagnostics.session_id,
        bytes_in = diagnostics.bytes_in,
        "restored session history"
    );
    Ok(diagnostics)
}

async fn write_session_history_file(
    sandbox: &dyn Sandbox,
    session_path: &str,
    session: &MaterializedResumeSession,
) -> RunnerResult<HistoryTransferMeasurements> {
    let selection_started = Instant::now();
    let (compression, reason) = compression::select(session).await?;
    let selection_elapsed = selection_started.elapsed();
    let wire = sandbox
        .write_file_with_compression(session_path, session.history_bytes(), compression)
        .await
        .map_err(RunnerError::Sandbox)?;
    Ok(HistoryTransferMeasurements::new(
        compression,
        reason,
        selection_elapsed,
        session.history_bytes().len(),
        session.codex_zstd_history().is_some(),
        wire,
    ))
}
