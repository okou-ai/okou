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
use crate::telemetry::{HistoryCodecDecision, HistoryTransferMeasurements};
use api_contracts::generated::constants::runners::paths::CANONICAL_PI_SESSION_DIR;
use runner_types::types::{ExecutionContext, ResumeSessionHistoryRefKind, SandboxReuseResult};

const CANONICAL_CLAUDE_WORKSPACE_SESSION_DIR: &str =
    "/home/user/.claude/projects/-home-user-workspace";

pub(super) fn restored_session_identity_from_context(
    context: &ExecutionContext,
) -> Option<RestoredSessionIdentity> {
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
    Some(RestoredSessionIdentity::new(
        framework,
        &session_id,
        history_ref_kind,
        history_ref.hash.clone(),
        Some(history_ref.raw_size),
    ))
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
    SourceZstd {
        bytes: Vec<u8>,
        raw_size: u32,
        crc32: u32,
    },
}

impl MaterializedResumeSession {
    pub(super) fn new_zstd_source(
        cli_agent_session_id: String,
        bytes: Vec<u8>,
        raw_size: u64,
        crc32: u32,
    ) -> RunnerResult<Self> {
        let raw_size = u32::try_from(raw_size)
            .map_err(|_| RunnerError::Internal("invalid source raw size".into()))?;
        Ok(Self {
            cli_agent_session_id,
            history: MaterializedResumeHistory::SourceZstd {
                bytes,
                raw_size,
                crc32,
            },
            codex_timestamp: None,
        })
    }

    pub(super) fn zstd_source_compression(&self) -> Option<sandbox::FileCompression> {
        match &self.history {
            MaterializedResumeHistory::SourceZstd {
                raw_size, crc32, ..
            } => Some(sandbox::FileCompression::ZstdSource {
                raw_size: *raw_size,
                crc32: *crc32,
            }),
            _ => None,
        }
    }

    pub(super) fn restore_len(&self) -> usize {
        match &self.history {
            MaterializedResumeHistory::SourceZstd { raw_size, .. } => *raw_size as usize,
            _ => self.history_bytes().len(),
        }
    }

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
            MaterializedResumeHistory::SourceZstd { bytes, .. } => bytes,
        }
    }

    pub(super) fn codex_timestamp(&self) -> Option<DateTime<Utc>> {
        self.codex_timestamp
    }

    pub(super) fn codex_zstd_history(&self) -> Option<&[u8]> {
        match &self.history {
            MaterializedResumeHistory::CodexZstd(bytes) => Some(bytes),
            MaterializedResumeHistory::SharedText(_)
            | MaterializedResumeHistory::Bytes(_)
            | MaterializedResumeHistory::SourceZstd { .. } => None,
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

#[derive(Debug)]
pub(super) struct FreshSessionRestorePlan {
    final_path: String,
    framework: &'static str,
    session_id: String,
    compression: sandbox::FileCompression,
    codec_decision: HistoryCodecDecision,
    selection_elapsed: std::time::Duration,
}

impl FreshSessionRestorePlan {
    pub(super) fn final_path(&self) -> &str {
        &self.final_path
    }

    /// Prepare the live destination only after storage reconciliation, never during staging.
    pub(super) async fn prepare_destination(
        &mut self,
        sandbox: &dyn Sandbox,
        context: &ExecutionContext,
        session: &MaterializedResumeSession,
    ) -> RunnerResult<()> {
        if effective_cli_framework(&context.cli_agent_type) == EffectiveCliFramework::Codex {
            self.final_path =
                codex::prepare_codex_session_target(sandbox, context, session, &self.final_path)
                    .await?;
        }
        Ok(())
    }

    pub(super) async fn write_to(
        &self,
        sandbox: &dyn Sandbox,
        path: &str,
        session: &MaterializedResumeSession,
    ) -> RunnerResult<HistoryTransferMeasurements> {
        let wire = sandbox
            .write_file_with_compression(path, session.history_bytes(), self.compression)
            .await
            .map_err(RunnerError::Sandbox)?;
        Ok(HistoryTransferMeasurements::new(
            self.compression,
            self.codec_decision,
            self.selection_elapsed,
            session.restore_len(),
            session.codex_zstd_history().is_some(),
            wire,
        ))
    }

    pub(super) async fn write_final(
        &self,
        sandbox: &dyn Sandbox,
        context: &ExecutionContext,
        session: &MaterializedResumeSession,
    ) -> RunnerResult<SessionRestoreDiagnostics> {
        let final_path = if effective_cli_framework(&context.cli_agent_type)
            == EffectiveCliFramework::Codex
        {
            codex::prepare_codex_session_target(sandbox, context, session, &self.final_path).await?
        } else {
            self.final_path.clone()
        };
        let transfer = self.write_to(sandbox, &final_path, session).await?;
        Ok(self.complete(context, session, transfer))
    }

    pub(super) fn complete(
        &self,
        context: &ExecutionContext,
        session: &MaterializedResumeSession,
        transfer: HistoryTransferMeasurements,
    ) -> SessionRestoreDiagnostics {
        let diagnostics = SessionRestoreDiagnostics {
            framework: self.framework,
            session_id: self.session_id.clone(),
            bytes_in: session.restore_len(),
            transfer,
        };
        info!(
            run_id = %context.run_id,
            framework = diagnostics.framework,
            session_id = %diagnostics.session_id,
            bytes_in = diagnostics.bytes_in,
            "restored session history",
        );
        diagnostics
    }
}

pub(super) fn plan_fresh_session_restore(
    context: &ExecutionContext,
    session: &MaterializedResumeSession,
    sandbox_reuse_result: SandboxReuseResult,
) -> RunnerResult<Option<FreshSessionRestorePlan>> {
    if sandbox_reuse_result == SandboxReuseResult::Reused {
        return Ok(None);
    }
    if !is_valid_cli_agent_session_id(session.cli_agent_session_id()) {
        return Err(RunnerError::Internal("invalid session_id".into()));
    }
    let selection_started = Instant::now();
    let (compression, codec_decision) = compression::select(session);
    let selection_elapsed = selection_started.elapsed();
    let (framework, session_id, final_path) = match effective_cli_framework(&context.cli_agent_type)
    {
        EffectiveCliFramework::ClaudeCode => {
            if !matches!(context.cli_agent_type.as_str(), "" | "claude-code") {
                warn!(
                    run_id = %context.run_id,
                    framework = %context.cli_agent_type,
                    "restoring session as claude-code for unknown framework"
                );
            }
            let session_id = session.cli_agent_session_id().to_string();
            (
                "claude-code",
                session_id.clone(),
                format!("{CANONICAL_CLAUDE_WORKSPACE_SESSION_DIR}/{session_id}.jsonl"),
            )
        }
        EffectiveCliFramework::Pi => {
            let session_id = session.cli_agent_session_id().to_string();
            (
                "pi",
                session_id.clone(),
                format!("{CANONICAL_PI_SESSION_DIR}/restored-{session_id}.jsonl"),
            )
        }
        EffectiveCliFramework::Codex => {
            let (session_id, final_path) = codex::fresh_codex_session_target(session)?;
            ("codex", session_id, final_path)
        }
    };
    Ok(Some(FreshSessionRestorePlan {
        final_path,
        framework,
        session_id,
        compression,
        codec_decision,
        selection_elapsed,
    }))
}

pub(super) async fn restore_session(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session: &MaterializedResumeSession,
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
            codex::restore_codex_session(sandbox, context, session).await
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
    let session_id = session.cli_agent_session_id();
    let session_dir = CANONICAL_PI_SESSION_DIR;
    let session_path = format!("{session_dir}/restored-{session_id}.jsonl");
    let transfer = write_session_history_file(sandbox, &session_path, session).await?;
    let diagnostics = SessionRestoreDiagnostics {
        framework: "pi",
        session_id: session_id.to_string(),
        bytes_in: session.restore_len(),
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
    let session_id = session.cli_agent_session_id();
    let session_path = format!("{CANONICAL_CLAUDE_WORKSPACE_SESSION_DIR}/{session_id}.jsonl");

    let transfer = write_session_history_file(sandbox, &session_path, session).await?;
    let diagnostics = SessionRestoreDiagnostics {
        framework: "claude-code",
        session_id: session_id.to_string(),
        bytes_in: session.restore_len(),
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
    let (compression, decision) = compression::select(session);
    let selection_elapsed = selection_started.elapsed();
    let wire = sandbox
        .write_file_with_compression(session_path, session.history_bytes(), compression)
        .await
        .map_err(RunnerError::Sandbox)?;
    Ok(HistoryTransferMeasurements::new(
        compression,
        decision,
        selection_elapsed,
        session.restore_len(),
        session.codex_zstd_history().is_some(),
        wire,
    ))
}
