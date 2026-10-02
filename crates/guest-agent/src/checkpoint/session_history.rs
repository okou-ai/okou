//! Checkpoint-specific session-history preparation and persistence.

use super::{CheckpointInputs, CheckpointMode, LOG_TAG};
use crate::constants;
use crate::env;
use crate::error::AgentError;
use crate::http::HttpClient;
use crate::session_history as history;
use crate::session_history_identity::{
    SessionHistoryIdentityBuildError, build_final_session_history_identity,
};
use api_contracts::generated::constants::runners::{
    RESUME_SESSION_HISTORY_MAX_BYTES, SESSION_HISTORY_ENCODING_GZIP,
    SESSION_HISTORY_ENCODING_IDENTITY, SESSION_HISTORY_ENCODING_ZSTD,
    SESSION_HISTORY_GZIP_MIN_BYTES,
};
use api_contracts::generated::types::webhooks::agent::checkpoints::prepare_history;
use bytes::Bytes;
use guest_contracts::session_history_identity::SessionHistorySourceRef;
use guest_telemetry::telemetry::{
    SandboxOpDimensions, record_sandbox_op, record_sandbox_op_with_dimensions,
};
use guest_telemetry::{log_info, log_warn};
use session_history_selector::{
    ClaudeHistoryCandidate, ClaudeHistoryIneligibleReason, ClaudeHistorySelection,
    CodexHistoryCandidate, CodexHistoryIneligibleReason, CodexHistorySelection,
    PI_COMPACT_GENERATION_MAX_BYTES, PiHistoryCandidate, PiHistorySelection,
    select_claude_compact_generation_from_file,
    select_claude_compact_generation_from_file_with_candidate_limit_for_test,
    select_codex_compact_generation, select_codex_compact_generation_with_candidate_limit_for_test,
    select_pi_compact_generation, select_pi_compact_generation_with_candidate_limit_for_test,
};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Write};
use std::time::Duration;

const SESSION_HISTORY_UPLOAD_MAX_RETRIES: u32 = 3;
const SESSION_HISTORY_ZSTD_LEVEL: i32 = 3;
const SESSION_HISTORY_COMPRESSION_MIN_BYTES: usize = SESSION_HISTORY_GZIP_MIN_BYTES as usize;

#[derive(Clone, Copy)]
enum SessionHistoryPruneOutcome {
    Selected,
    Ineligible,
    Error,
}

impl SessionHistoryPruneOutcome {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Selected => "selected",
            Self::Ineligible => "ineligible",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Copy)]
enum SessionHistoryPruneReason {
    Selector(&'static str),
    CompressedSource,
    SelectorIo,
    ReplacementStageFailed,
}

impl SessionHistoryPruneReason {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Selector(reason) => reason,
            Self::CompressedSource => "compressed_source",
            Self::SelectorIo => "selector_io",
            Self::ReplacementStageFailed => "replacement_stage_failed",
        }
    }
}

fn record_session_history_prune(
    started: std::time::Instant,
    outcome: SessionHistoryPruneOutcome,
    reason: Option<SessionHistoryPruneReason>,
) {
    let reason = reason.map(SessionHistoryPruneReason::as_str);
    let error = matches!(outcome, SessionHistoryPruneOutcome::Error)
        .then_some(reason.unwrap_or("selector_io"));
    record_sandbox_op_with_dimensions(
        "session_history_prune",
        started.elapsed(),
        !matches!(outcome, SessionHistoryPruneOutcome::Error),
        error,
        SandboxOpDimensions {
            outcome: Some(outcome.as_str()),
            reason,
        },
    );
}

#[derive(Clone, Copy)]
pub(super) enum CheckpointSessionHistoryLimits {
    Production,
    BoundedForTest {
        candidate_max_bytes: u64,
        checkpoint_max_bytes: u64,
    },
}

impl CheckpointSessionHistoryLimits {
    fn pi_compact_trigger_bytes(self) -> u64 {
        match self {
            Self::Production => PI_COMPACT_GENERATION_MAX_BYTES,
            Self::BoundedForTest {
                candidate_max_bytes,
                ..
            } => candidate_max_bytes,
        }
    }

    fn checkpoint_max_bytes(self) -> u64 {
        match self {
            Self::Production => RESUME_SESSION_HISTORY_MAX_BYTES,
            Self::BoundedForTest {
                checkpoint_max_bytes,
                ..
            } => checkpoint_max_bytes,
        }
    }

    fn select_claude(
        self,
        source: &mut std::fs::File,
        expected_session_id: &str,
    ) -> std::io::Result<ClaudeHistorySelection> {
        match self {
            Self::Production => {
                select_claude_compact_generation_from_file(source, expected_session_id)
            }
            Self::BoundedForTest {
                candidate_max_bytes,
                ..
            } => select_claude_compact_generation_from_file_with_candidate_limit_for_test(
                source,
                expected_session_id,
                candidate_max_bytes,
            ),
        }
    }

    fn select_pi(
        self,
        source: &mut std::fs::File,
        expected_session_id: &str,
    ) -> std::io::Result<PiHistorySelection> {
        match self {
            Self::Production => select_pi_compact_generation(source, expected_session_id),
            Self::BoundedForTest {
                candidate_max_bytes,
                ..
            } => select_pi_compact_generation_with_candidate_limit_for_test(
                source,
                expected_session_id,
                candidate_max_bytes,
            ),
        }
    }

    fn select_codex(
        self,
        source: &mut std::fs::File,
        expected_thread_id: &str,
    ) -> std::io::Result<CodexHistorySelection> {
        match self {
            Self::Production => select_codex_compact_generation(source, expected_thread_id),
            Self::BoundedForTest {
                candidate_max_bytes,
                ..
            } => select_codex_compact_generation_with_candidate_limit_for_test(
                source,
                expected_thread_id,
                candidate_max_bytes,
            ),
        }
    }
}

enum SessionHistoryUploadBody {
    Identity(Vec<u8>),
    Zstd(Vec<u8>),
}

struct SessionHistoryUpload {
    raw_size: u64,
    body: SessionHistoryUploadBody,
}

struct PreparedSessionHistory {
    hash: String,
    raw_size: u64,
    upload_source: PreparedSessionHistoryUploadSource,
    live_history: PreparedLiveHistory,
}

enum PreparedSessionHistoryOutcome {
    Upload(PreparedSessionHistory),
    DiscardedOversized,
}

trait NativeSessionHistoryCandidate {
    fn into_bytes(self) -> Vec<u8>;
}

impl NativeSessionHistoryCandidate for ClaudeHistoryCandidate {
    fn into_bytes(self) -> Vec<u8> {
        self.into_bytes()
    }
}

impl NativeSessionHistoryCandidate for CodexHistoryCandidate {
    fn into_bytes(self) -> Vec<u8> {
        self.into_bytes()
    }
}

impl NativeSessionHistoryCandidate for PiHistoryCandidate {
    fn into_bytes(self) -> Vec<u8> {
        self.into_bytes()
    }
}

pub(super) enum PreparedLiveHistory {
    MatchesCheckpoint,
    NativeCandidate {
        kind: NativeHistoryKind,
        replacement: Option<PendingNativeHistoryReplacement>,
    },
}

#[derive(Clone, Copy)]
pub(super) enum NativeHistoryKind {
    ClaudeCode,
    Codex,
    Pi,
}

impl NativeHistoryKind {
    const fn label(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude",
            Self::Codex => "Codex",
            Self::Pi => "Pi",
        }
    }
}

pub(super) struct PendingNativeHistoryReplacement {
    replacement: history::SafeHistoryReplacement,
}

impl PendingNativeHistoryReplacement {
    fn stage(
        target: &history::SafeHistoryReplacementTarget,
        candidate: &[u8],
    ) -> std::io::Result<Self> {
        target
            .stage(candidate)
            .map(|replacement| Self { replacement })
    }

    fn persist(self) -> std::io::Result<()> {
        self.replacement.persist()
    }
}

enum PreparedSessionHistoryUploadSource {
    Raw(Vec<u8>),
    ReusedCodexZstd(Vec<u8>),
}

impl PreparedSessionHistoryUploadSource {
    fn into_upload(self, raw_size: u64) -> Result<SessionHistoryUpload, AgentError> {
        match self {
            Self::Raw(history_bytes) => build_session_history_upload(history_bytes),
            Self::ReusedCodexZstd(zstd_bytes) => Ok(SessionHistoryUpload {
                raw_size,
                body: SessionHistoryUploadBody::Zstd(zstd_bytes),
            }),
        }
    }
}

struct DecodedSessionHistoryAnalysis {
    raw_size: u64,
    sha256_hex: String,
    line_count: usize,
    invalid_utf8: Option<String>,
    is_empty: bool,
    validation_error: Option<String>,
}

impl SessionHistoryUpload {
    fn requested_encoding(&self) -> prepare_history::SessionHistoryEncoding {
        match self.body {
            SessionHistoryUploadBody::Identity(_) => {
                prepare_history::SessionHistoryEncoding::Identity
            }
            SessionHistoryUploadBody::Zstd(_) => prepare_history::SessionHistoryEncoding::Zstd,
        }
    }

    fn encoded_size(&self) -> u64 {
        match &self.body {
            SessionHistoryUploadBody::Identity(raw) => raw.len() as u64,
            SessionHistoryUploadBody::Zstd(zstd) => zstd.len() as u64,
        }
    }

    fn into_bytes(self) -> Bytes {
        match self.body {
            SessionHistoryUploadBody::Identity(raw) => Bytes::from(raw),
            SessionHistoryUploadBody::Zstd(zstd) => Bytes::from(zstd),
        }
    }
}

const fn session_history_encoding_label(
    encoding: prepare_history::SessionHistoryEncoding,
) -> &'static str {
    match encoding {
        prepare_history::SessionHistoryEncoding::Identity => SESSION_HISTORY_ENCODING_IDENTITY,
        prepare_history::SessionHistoryEncoding::Gzip => SESSION_HISTORY_ENCODING_GZIP,
        prepare_history::SessionHistoryEncoding::Zstd => SESSION_HISTORY_ENCODING_ZSTD,
    }
}

fn build_session_history_upload(
    history_bytes: Vec<u8>,
) -> Result<SessionHistoryUpload, AgentError> {
    let raw_size = history_bytes.len() as u64;
    if history_bytes.len() < SESSION_HISTORY_COMPRESSION_MIN_BYTES {
        return Ok(SessionHistoryUpload {
            raw_size,
            body: SessionHistoryUploadBody::Identity(history_bytes),
        });
    }

    let zstd_bytes = zstd_session_history(&history_bytes)?;
    if zstd_bytes.len() >= history_bytes.len() {
        return Ok(SessionHistoryUpload {
            raw_size,
            body: SessionHistoryUploadBody::Identity(history_bytes),
        });
    }

    Ok(SessionHistoryUpload {
        raw_size,
        body: SessionHistoryUploadBody::Zstd(zstd_bytes),
    })
}

fn zstd_session_history(history_bytes: &[u8]) -> Result<Vec<u8>, AgentError> {
    let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), SESSION_HISTORY_ZSTD_LEVEL)
        .map_err(|error| AgentError::Checkpoint(format!("zstd session history: {error}")))?;
    encoder
        .write_all(history_bytes)
        .map_err(|error| AgentError::Checkpoint(format!("zstd session history: {error}")))?;
    encoder
        .finish()
        .map_err(|error| AgentError::Checkpoint(format!("finish zstd session history: {error}")))
}

fn fail_preserving_error(op: &str, start: std::time::Instant, error: AgentError) -> AgentError {
    record_history_failure(op, start, &error.to_string());
    error
}

fn history_failure(op: &str, start: std::time::Instant, message: impl Into<String>) -> AgentError {
    let message = message.into();
    record_history_failure(op, start, &message);
    AgentError::Checkpoint(message)
}

fn record_history_failure(op: &str, start: std::time::Instant, message: &str) {
    log_warn!(LOG_TAG, "{message}");
    record_sandbox_op(op, start.elapsed(), false, Some(message));
}

pub(super) struct CheckpointSessionHistoryInputs {
    mode: CheckpointMode,
    framework: env::Framework,
    limits: CheckpointSessionHistoryLimits,
    cli_agent_session_id: String,
    history_source: Option<SessionHistorySourceRef>,
}

impl CheckpointSessionHistoryInputs {
    pub(super) fn from_checkpoint(mode: CheckpointMode, inputs: &CheckpointInputs<'_>) -> Self {
        Self {
            mode,
            framework: inputs.framework,
            limits: inputs.session_history_limits,
            cli_agent_session_id: inputs.session_metadata.cli_agent_session_id().to_string(),
            history_source: inputs.session_metadata.history_source().cloned(),
        }
    }
}

pub(super) struct UploadedCheckpointSessionHistory {
    pub(super) cli_agent_session_id: String,
    pub(super) history_source: SessionHistorySourceRef,
    pub(super) history_hash: String,
    pub(super) history_size: u64,
    pub(super) live_history: PreparedLiveHistory,
}

pub(super) enum CheckpointSessionHistory {
    Uploaded(UploadedCheckpointSessionHistory),
    DiscardedOversized { cli_agent_session_id: String },
    Unavailable { cli_agent_session_id: String },
}

enum PreparedCheckpointSessionHistory {
    Upload {
        checkpoint: Box<UploadedCheckpointSessionHistory>,
        upload: SessionHistoryUpload,
    },
    DiscardedOversized {
        cli_agent_session_id: String,
    },
}

const fn should_discard_oversized_claude(reason: ClaudeHistoryIneligibleReason) -> bool {
    match reason {
        ClaudeHistoryIneligibleReason::NoCompactBoundary => true,
        ClaudeHistoryIneligibleReason::SourceWithinGuard
        | ClaudeHistoryIneligibleReason::InvalidRecord
        | ClaudeHistoryIneligibleReason::RecordTooLarge
        | ClaudeHistoryIneligibleReason::InvalidCompactBoundary
        | ClaudeHistoryIneligibleReason::InvalidCompactSummary
        | ClaudeHistoryIneligibleReason::SessionIdMismatch
        | ClaudeHistoryIneligibleReason::InvalidUuid
        | ClaudeHistoryIneligibleReason::BrokenParent
        | ClaudeHistoryIneligibleReason::BrokenToolPair
        | ClaudeHistoryIneligibleReason::SourceChanged => false,
    }
}

const fn should_discard_oversized_codex(reason: CodexHistoryIneligibleReason) -> bool {
    match reason {
        CodexHistoryIneligibleReason::NoCompactBoundary
        | CodexHistoryIneligibleReason::CandidateTooLarge => true,
        CodexHistoryIneligibleReason::SourceWithinGuard
        | CodexHistoryIneligibleReason::InvalidCanonicalMetadata
        | CodexHistoryIneligibleReason::ThreadIdMismatch
        | CodexHistoryIneligibleReason::UnsupportedHistoryMode
        | CodexHistoryIneligibleReason::InvalidRecord
        | CodexHistoryIneligibleReason::RecordTooLarge
        | CodexHistoryIneligibleReason::InvalidCompactBoundary
        | CodexHistoryIneligibleReason::InvalidTurn
        | CodexHistoryIneligibleReason::MissingTurnContext
        | CodexHistoryIneligibleReason::RollbackAfterCompact
        | CodexHistoryIneligibleReason::SourceChanged => false,
    }
}

async fn run_session_history_blocking<T>(
    operation: impl FnOnce() -> Result<T, AgentError> + Send + 'static,
) -> Result<Result<T, AgentError>, AgentError>
where
    T: Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| {
            AgentError::Execution(format!("session history blocking task failed: {error}"))
        })
}

enum SessionHistoryUploadOutcome {
    Uploaded,
    Unavailable,
}

/// Prepare + upload one session history to S3 via a presigned URL. If
/// the prepare endpoint reports `existing=true`, skip the upload
/// (content-addressed dedup). Telemetry is recorded under
/// `session_history_prepare` and `session_history_s3_upload` to match the
/// pre-parallelization op names. Content-addressed uploads retry the same bytes
/// up to three times. Exhausted uploads leave history unavailable so the remaining
/// checkpoint can still persist where the framework permits missing history.
async fn upload_session_history(
    http: &HttpClient,
    run_id: &str,
    history_hash: &str,
    history_upload: SessionHistoryUpload,
) -> Result<SessionHistoryUploadOutcome, AgentError> {
    let prep_start = std::time::Instant::now();
    let url = http.checkpoint_prepare_history_url()?;
    let requested_encoding = history_upload.requested_encoding();
    let requested_encoding_label = session_history_encoding_label(requested_encoding);
    let encoded_size = history_upload.encoded_size();
    let request = prepare_history::Request {
        run_id: run_id.to_string(),
        hash: history_hash.to_string(),
        raw_size: history_upload.raw_size,
        encoded_size,
        encoding: Some(requested_encoding),
    };
    let prep_resp = match http
        .post_json(url, &request, constants::HTTP_MAX_ATTEMPTS)
        .await
    {
        Ok(Some(value)) => match serde_json::from_value::<prepare_history::Response>(value) {
            Ok(response) => {
                record_sandbox_op("session_history_prepare", prep_start.elapsed(), true, None);
                response
            }
            Err(_) => {
                let message = "Invalid prepare-history response";
                record_sandbox_op(
                    "session_history_prepare",
                    prep_start.elapsed(),
                    false,
                    Some(message),
                );
                return Err(AgentError::Checkpoint(message.into()));
            }
        },
        Ok(None) => {
            record_sandbox_op("session_history_prepare", prep_start.elapsed(), false, None);
            return Err(AgentError::Checkpoint(
                "Empty prepare-history response".into(),
            ));
        }
        Err(e) => {
            record_sandbox_op("session_history_prepare", prep_start.elapsed(), false, None);
            return Err(e);
        }
    };

    let existing = prep_resp.existing;
    let response_encoding = prep_resp.encoding;
    // Existing content-addressed blobs retain their persisted encoding; no upload occurs.
    let zstd_response_encoding_is_compatible = response_encoding
        == Some(prepare_history::SessionHistoryEncoding::Zstd)
        || (existing
            && matches!(
                response_encoding,
                Some(
                    prepare_history::SessionHistoryEncoding::Identity
                        | prepare_history::SessionHistoryEncoding::Gzip
                )
            ));
    if requested_encoding == prepare_history::SessionHistoryEncoding::Zstd
        && !zstd_response_encoding_is_compatible
    {
        return Err(AgentError::Checkpoint(
            "Prepare-history response did not acknowledge zstd session history".into(),
        ));
    }

    if existing {
        let accepted_encoding = session_history_encoding_label(
            response_encoding.unwrap_or(prepare_history::SessionHistoryEncoding::Identity),
        );
        log_info!(
            LOG_TAG,
            "Session history already exists in S3 (deduplicated, encoding={accepted_encoding})"
        );
        return Ok(SessionHistoryUploadOutcome::Uploaded);
    }

    let presigned_url = prep_resp.presigned_url.ok_or_else(|| {
        AgentError::Checkpoint("No presignedUrl in prepare-history response".into())
    })?;

    let upload_bytes = history_upload.into_bytes();

    log_info!(
        LOG_TAG,
        "Uploading session history to S3 (encoding={requested_encoding_label})..."
    );
    let upload_start = std::time::Instant::now();
    if let Err(e) = http
        .put_presigned_with_retries(
            &presigned_url,
            upload_bytes,
            "application/octet-stream",
            SESSION_HISTORY_UPLOAD_MAX_RETRIES,
        )
        .await
    {
        let error = e.to_string();
        record_sandbox_op(
            "session_history_s3_upload",
            upload_start.elapsed(),
            false,
            Some(&error),
        );
        log_info!(
            LOG_TAG,
            "Session history upload failed after {SESSION_HISTORY_UPLOAD_MAX_RETRIES} retries; \
             continuing checkpoint without history: {error}"
        );
        return Ok(SessionHistoryUploadOutcome::Unavailable);
    }
    record_sandbox_op(
        "session_history_s3_upload",
        upload_start.elapsed(),
        true,
        None,
    );
    log_info!(LOG_TAG, "Session history uploaded to S3");
    Ok(SessionHistoryUploadOutcome::Uploaded)
}

fn prepare_session_history(
    mode: CheckpointMode,
    framework: env::Framework,
    limits: CheckpointSessionHistoryLimits,
    cli_agent_session_id: &str,
    history_source: &SessionHistorySourceRef,
    history_read_start: std::time::Instant,
) -> Result<PreparedSessionHistoryOutcome, AgentError> {
    let mut resolved =
        history::resolve_session_history_from_source(history_source).map_err(|error| {
            fail_preserving_error("session_history_read", history_read_start, error)
        })?;

    if mode.can_prune_history() && framework == env::Framework::ClaudeCode {
        let prune_start = std::time::Instant::now();
        if let Some(file) = resolved.plain_file_mut() {
            match limits.select_claude(file, cli_agent_session_id) {
                Ok(ClaudeHistorySelection::Candidate(candidate)) => {
                    let source_size = candidate.source_size();
                    let candidate_size = candidate.candidate_size();
                    let replacement = PendingNativeHistoryReplacement::stage(
                        resolved.replacement_target(),
                        candidate.as_bytes(),
                    )
                    .ok();
                    log_info!(
                        LOG_TAG,
                        "Selected Claude compact generation for checkpoint \
                         (source_size={source_size}, candidate_size={candidate_size})"
                    );
                    record_session_history_prune(
                        prune_start,
                        SessionHistoryPruneOutcome::Selected,
                        None,
                    );
                    let mut prepared =
                        prepare_native_session_history(history_read_start, candidate)?;
                    prepared.live_history = PreparedLiveHistory::NativeCandidate {
                        kind: NativeHistoryKind::ClaudeCode,
                        replacement,
                    };
                    return Ok(PreparedSessionHistoryOutcome::Upload(prepared));
                }
                Ok(ClaudeHistorySelection::Ineligible(reason)) => {
                    log_info!(
                        LOG_TAG,
                        "Claude session history not eligible for pruning: {}",
                        reason.as_str()
                    );
                    record_session_history_prune(
                        prune_start,
                        SessionHistoryPruneOutcome::Ineligible,
                        Some(SessionHistoryPruneReason::Selector(reason.as_str())),
                    );
                    if should_discard_oversized_claude(reason) {
                        log_info!(
                            LOG_TAG,
                            "Discarding oversized Claude session history without a bounded generation"
                        );
                        return Ok(PreparedSessionHistoryOutcome::DiscardedOversized);
                    }
                }
                Err(error) => {
                    log_warn!(
                        LOG_TAG,
                        "Claude session history selector failed; using ordinary checkpoint path: {error}"
                    );
                    record_session_history_prune(
                        prune_start,
                        SessionHistoryPruneOutcome::Error,
                        Some(SessionHistoryPruneReason::SelectorIo),
                    );
                }
            }
        }
    }

    if mode.can_prune_history() && framework == env::Framework::Codex {
        let prune_start = std::time::Instant::now();
        if let Some(file) = resolved.plain_file_mut() {
            match limits.select_codex(file, cli_agent_session_id) {
                Ok(CodexHistorySelection::Candidate(candidate)) => {
                    let source_size = candidate.source_size();
                    let candidate_size = candidate.candidate_size();
                    let replacement = PendingNativeHistoryReplacement::stage(
                        resolved.replacement_target(),
                        candidate.as_bytes(),
                    )
                    .ok();
                    log_info!(
                        LOG_TAG,
                        "Selected Codex compact generation for checkpoint \
                         (source_size={source_size}, candidate_size={candidate_size})"
                    );
                    record_session_history_prune(
                        prune_start,
                        SessionHistoryPruneOutcome::Selected,
                        None,
                    );
                    let mut prepared =
                        prepare_native_session_history(history_read_start, candidate)?;
                    prepared.live_history = PreparedLiveHistory::NativeCandidate {
                        kind: NativeHistoryKind::Codex,
                        replacement,
                    };
                    return Ok(PreparedSessionHistoryOutcome::Upload(prepared));
                }
                Ok(CodexHistorySelection::Ineligible(reason)) => {
                    log_info!(
                        LOG_TAG,
                        "Codex session history not eligible for pruning: {}",
                        reason.as_str()
                    );
                    record_session_history_prune(
                        prune_start,
                        SessionHistoryPruneOutcome::Ineligible,
                        Some(SessionHistoryPruneReason::Selector(reason.as_str())),
                    );
                    if should_discard_oversized_codex(reason) {
                        log_info!(
                            LOG_TAG,
                            "Discarding oversized Codex session history without a bounded generation"
                        );
                        return Ok(PreparedSessionHistoryOutcome::DiscardedOversized);
                    }
                }
                Err(error) => {
                    log_warn!(
                        LOG_TAG,
                        "Codex session history selector failed; using ordinary checkpoint path: \
                         {error}"
                    );
                    record_session_history_prune(
                        prune_start,
                        SessionHistoryPruneOutcome::Error,
                        Some(SessionHistoryPruneReason::SelectorIo),
                    );
                }
            }
        } else {
            log_info!(
                LOG_TAG,
                "Codex session history not eligible for pruning: compressed_source"
            );
            record_session_history_prune(
                prune_start,
                SessionHistoryPruneOutcome::Ineligible,
                Some(SessionHistoryPruneReason::CompressedSource),
            );
        }
    }

    let checkpoint_max_bytes = limits.checkpoint_max_bytes();
    let pi_source_size = if mode.can_prune_history() && framework == env::Framework::Pi {
        Some(resolved.encoded_len()?)
    } else {
        None
    };
    if pi_source_size.is_some_and(|size| size > limits.pi_compact_trigger_bytes()) {
        let original_fits_checkpoint =
            pi_source_size.is_some_and(|size| size <= checkpoint_max_bytes);
        let prune_start = std::time::Instant::now();
        if let Some(file) = resolved.plain_file_mut() {
            match limits.select_pi(file, cli_agent_session_id) {
                Ok(PiHistorySelection::Candidate(candidate)) => {
                    if candidate.candidate_size() > checkpoint_max_bytes {
                        return Err(AgentError::PiCompactGenerationUnavailable {
                            reason: "candidate_too_large",
                        });
                    }
                    match PendingNativeHistoryReplacement::stage(
                        resolved.replacement_target(),
                        candidate.as_bytes(),
                    ) {
                        Ok(replacement) => {
                            let mut prepared =
                                prepare_native_session_history(history_read_start, candidate)?;
                            record_session_history_prune(
                                prune_start,
                                SessionHistoryPruneOutcome::Selected,
                                None,
                            );
                            prepared.live_history = PreparedLiveHistory::NativeCandidate {
                                kind: NativeHistoryKind::Pi,
                                replacement: Some(replacement),
                            };
                            return Ok(PreparedSessionHistoryOutcome::Upload(prepared));
                        }
                        Err(error) => {
                            record_session_history_prune(
                                prune_start,
                                SessionHistoryPruneOutcome::Error,
                                Some(SessionHistoryPruneReason::ReplacementStageFailed),
                            );
                            log_warn!(LOG_TAG, "Pi history replacement staging failed: {error}");
                            if !original_fits_checkpoint {
                                return Err(AgentError::PiCompactGenerationUnavailable {
                                    reason: "replacement_stage_failed",
                                });
                            }
                        }
                    }
                }
                Ok(PiHistorySelection::Ineligible(reason)) => {
                    record_session_history_prune(
                        prune_start,
                        SessionHistoryPruneOutcome::Ineligible,
                        Some(SessionHistoryPruneReason::Selector(reason.as_str())),
                    );
                    if !original_fits_checkpoint {
                        return Err(AgentError::PiCompactGenerationUnavailable {
                            reason: reason.as_str(),
                        });
                    }
                }
                Err(error) => {
                    record_session_history_prune(
                        prune_start,
                        SessionHistoryPruneOutcome::Error,
                        Some(SessionHistoryPruneReason::SelectorIo),
                    );
                    log_warn!(LOG_TAG, "Pi session history selection failed: {error}");
                    if !original_fits_checkpoint {
                        return Err(AgentError::PiCompactGenerationUnavailable {
                            reason: "selector_io",
                        });
                    }
                }
            }
        }
        // A valid original below the upload cap remains usable when pruning fails.
    }
    let source = resolved
        .into_checkpoint_source_bounded(checkpoint_max_bytes)
        .map_err(|error| {
            fail_preserving_error("session_history_read", history_read_start, error)
        })?;
    match source {
        history::SessionHistoryCheckpointSource::Decoded(history_bytes) => {
            prepare_raw_session_history(history_read_start, history_bytes)
                .map(PreparedSessionHistoryOutcome::Upload)
        }
        history::SessionHistoryCheckpointSource::CodexZstd { encoded } => {
            prepare_reused_zstd_session_history(history_read_start, encoded, checkpoint_max_bytes)
                .map(PreparedSessionHistoryOutcome::Upload)
        }
    }
}

fn prepare_raw_session_history(
    history_read_start: std::time::Instant,
    history_bytes: Vec<u8>,
) -> Result<PreparedSessionHistory, AgentError> {
    let session_history = require_session_history_text(history_read_start, &history_bytes)?;
    let line_count = validate_session_history(session_history)
        .map_err(|msg| history_failure("session_history_validate", history_read_start, msg))?;
    Ok(finalize_raw_session_history(
        history_read_start,
        history_bytes,
        line_count,
    ))
}

fn prepare_native_session_history(
    history_read_start: std::time::Instant,
    candidate: impl NativeSessionHistoryCandidate,
) -> Result<PreparedSessionHistory, AgentError> {
    let history_bytes = candidate.into_bytes();
    let line_count = require_session_history_text(history_read_start, &history_bytes)?
        .lines()
        .count();
    Ok(finalize_raw_session_history(
        history_read_start,
        history_bytes,
        line_count,
    ))
}

fn require_session_history_text(
    history_read_start: std::time::Instant,
    history_bytes: &[u8],
) -> Result<&str, AgentError> {
    let session_history = std::str::from_utf8(history_bytes).map_err(|error| {
        history_failure(
            "session_history_read",
            history_read_start,
            format!("Session history is not valid UTF-8: {error}"),
        )
    })?;

    if session_history.trim().is_empty() {
        return Err(history_failure(
            "session_history_read",
            history_read_start,
            "Session history is empty",
        ));
    }

    Ok(session_history)
}

fn finalize_raw_session_history(
    history_read_start: std::time::Instant,
    history_bytes: Vec<u8>,
    line_count: usize,
) -> PreparedSessionHistory {
    let history_size = history_bytes.len() as u64;
    log_info!(LOG_TAG, "Session history loaded ({line_count} lines)");
    record_sandbox_op(
        "session_history_read",
        history_read_start.elapsed(),
        true,
        None,
    );

    let history_hash = hex::encode(Sha256::digest(&history_bytes));
    log_info!(
        LOG_TAG,
        "Session history hash={}, size={history_size}",
        &history_hash[..8]
    );
    PreparedSessionHistory {
        hash: history_hash,
        raw_size: history_size,
        upload_source: PreparedSessionHistoryUploadSource::Raw(history_bytes),
        live_history: PreparedLiveHistory::MatchesCheckpoint,
    }
}

fn prepare_reused_zstd_session_history(
    history_read_start: std::time::Instant,
    zstd_bytes: Vec<u8>,
    checkpoint_max_bytes: u64,
) -> Result<PreparedSessionHistory, AgentError> {
    let analysis = analyze_zstd_session_history(&zstd_bytes, checkpoint_max_bytes)
        .map_err(|e| fail_preserving_error("session_history_read", history_read_start, e))?;

    if let Some(msg) = &analysis.invalid_utf8 {
        return Err(history_failure(
            "session_history_read",
            history_read_start,
            msg,
        ));
    }

    if analysis.is_empty {
        return Err(history_failure(
            "session_history_read",
            history_read_start,
            "Session history is empty",
        ));
    }

    if let Some(msg) = analysis.validation_error {
        return Err(history_failure(
            "session_history_validate",
            history_read_start,
            msg,
        ));
    }

    log_info!(
        LOG_TAG,
        "Session history loaded ({} lines)",
        analysis.line_count
    );
    record_sandbox_op(
        "session_history_read",
        history_read_start.elapsed(),
        true,
        None,
    );

    log_info!(
        LOG_TAG,
        "Session history hash={}, size={}",
        &analysis.sha256_hex[..8],
        analysis.raw_size
    );
    Ok(PreparedSessionHistory {
        hash: analysis.sha256_hex,
        raw_size: analysis.raw_size,
        upload_source: PreparedSessionHistoryUploadSource::ReusedCodexZstd(zstd_bytes),
        live_history: PreparedLiveHistory::MatchesCheckpoint,
    })
}

fn analyze_zstd_session_history(
    zstd_bytes: &[u8],
    max_bytes: u64,
) -> Result<DecodedSessionHistoryAnalysis, AgentError> {
    let decoder = zstd::stream::read::Decoder::new(zstd_bytes).map_err(|error| {
        AgentError::Checkpoint(format!(
            "Failed to decompress zstd session history: {error}"
        ))
    })?;
    analyze_decoded_session_history_reader(
        BufReader::new(decoder.take(max_bytes.saturating_add(1))),
        max_bytes,
    )
}

fn analyze_decoded_session_history_reader(
    mut reader: impl BufRead,
    max_bytes: u64,
) -> Result<DecodedSessionHistoryAnalysis, AgentError> {
    let mut hasher = Sha256::new();
    let mut raw_size = 0u64;
    let mut line_count = 0usize;
    let mut all_bytes_ascii_whitespace = true;
    let mut all_utf8_lines_trim_empty = true;
    let mut invalid_utf8 = None;
    let mut validation_error = None;
    let mut line = Vec::new();

    loop {
        line.clear();
        let bytes_read = reader.read_until(b'\n', &mut line).map_err(|error| {
            AgentError::Checkpoint(format!(
                "Failed to decompress zstd session history: {error}"
            ))
        })?;
        if bytes_read == 0 {
            break;
        }

        raw_size = raw_size
            .checked_add(bytes_read as u64)
            .ok_or(history::session_history_exceeds_max_error(max_bytes))?;
        if raw_size > max_bytes {
            return Err(history::session_history_exceeds_max_error(max_bytes));
        }
        hasher.update(&line);
        if line.iter().any(|byte| !byte.is_ascii_whitespace()) {
            all_bytes_ascii_whitespace = false;
        }

        let logical_line = strip_jsonl_line_ending(&line);
        match std::str::from_utf8(logical_line) {
            Ok(text) => {
                line_count += 1;
                if !text.trim().is_empty() {
                    all_utf8_lines_trim_empty = false;
                }
                if validation_error.is_none()
                    && let Err(error) = validate_session_history_line(line_count, text)
                {
                    validation_error = Some(error);
                }
            }
            Err(error) => {
                invalid_utf8
                    .get_or_insert_with(|| format!("Session history is not valid UTF-8: {error}"));
            }
        }
    }

    let is_empty = if invalid_utf8.is_some() {
        all_bytes_ascii_whitespace
    } else {
        all_utf8_lines_trim_empty
    };
    Ok(DecodedSessionHistoryAnalysis {
        raw_size,
        sha256_hex: hex::encode(hasher.finalize()),
        line_count,
        invalid_utf8,
        is_empty,
        validation_error,
    })
}

fn strip_jsonl_line_ending(line: &[u8]) -> &[u8] {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    line.strip_suffix(b"\r").unwrap_or(line)
}

fn prepare_checkpoint_session_history(
    inputs: CheckpointSessionHistoryInputs,
) -> Result<PreparedCheckpointSessionHistory, AgentError> {
    let CheckpointSessionHistoryInputs {
        mode,
        framework,
        limits,
        cli_agent_session_id,
        history_source,
    } = inputs;
    if cli_agent_session_id.is_empty() {
        return Err(history_failure(
            "session_id_read",
            std::time::Instant::now(),
            "Session ID is empty",
        ));
    }
    let history_source = history_source.ok_or_else(|| {
        history_failure(
            "session_history_read",
            std::time::Instant::now(),
            "Session history source is unavailable",
        )
    })?;

    let history_read_start = std::time::Instant::now();
    let prepared_history = prepare_session_history(
        mode,
        framework,
        limits,
        &cli_agent_session_id,
        &history_source,
        history_read_start,
    )?;
    match prepared_history {
        PreparedSessionHistoryOutcome::Upload(prepared_history) => {
            let PreparedSessionHistory {
                hash: history_hash,
                raw_size: history_size,
                upload_source,
                live_history,
            } = prepared_history;
            let upload = upload_source.into_upload(history_size)?;
            Ok(PreparedCheckpointSessionHistory::Upload {
                checkpoint: Box::new(UploadedCheckpointSessionHistory {
                    cli_agent_session_id,
                    history_source,
                    history_hash,
                    history_size,
                    live_history,
                }),
                upload,
            })
        }
        PreparedSessionHistoryOutcome::DiscardedOversized => {
            Ok(PreparedCheckpointSessionHistory::DiscardedOversized {
                cli_agent_session_id,
            })
        }
    }
}

fn pi_history_preparation_is_fatal(
    mode: CheckpointMode,
    framework: env::Framework,
    error: &AgentError,
) -> bool {
    framework == env::Framework::Pi
        && (matches!(error, AgentError::PiCompactGenerationUnavailable { .. })
            || (mode.can_prune_history()
                && matches!(error, AgentError::CheckpointHistoryTooLarge { .. })))
}

pub(super) async fn prepare_and_upload_session_history(
    http: &HttpClient,
    run_id: &str,
    inputs: CheckpointSessionHistoryInputs,
) -> Result<CheckpointSessionHistory, AgentError> {
    if inputs.cli_agent_session_id.is_empty() {
        return Err(history_failure(
            "session_id_read",
            std::time::Instant::now(),
            "Session ID is empty",
        ));
    }
    let cli_agent_session_id = inputs.cli_agent_session_id.clone();
    let framework = inputs.framework;
    let mode = inputs.mode;
    let prepared =
        match run_session_history_blocking(move || prepare_checkpoint_session_history(inputs))
            .await?
        {
            Ok(prepared) => prepared,
            Err(error) => {
                if pi_history_preparation_is_fatal(mode, framework, &error) {
                    return Err(error);
                }
                log_warn!(
                    LOG_TAG,
                    "Session history is unavailable; continuing checkpoint without history: {error}"
                );
                return Ok(CheckpointSessionHistory::Unavailable {
                    cli_agent_session_id,
                });
            }
        };
    match prepared {
        PreparedCheckpointSessionHistory::Upload { checkpoint, upload } => {
            match upload_session_history(http, run_id, &checkpoint.history_hash, upload).await? {
                SessionHistoryUploadOutcome::Uploaded => {
                    Ok(CheckpointSessionHistory::Uploaded(*checkpoint))
                }
                SessionHistoryUploadOutcome::Unavailable => {
                    Ok(CheckpointSessionHistory::Unavailable {
                        cli_agent_session_id,
                    })
                }
            }
        }
        PreparedCheckpointSessionHistory::DiscardedOversized {
            cli_agent_session_id,
        } => Ok(CheckpointSessionHistory::DiscardedOversized {
            cli_agent_session_id,
        }),
    }
}

pub(super) fn reconcile_live_history_after_checkpoint(live_history: PreparedLiveHistory) -> bool {
    let started_at = std::time::Instant::now();
    match live_history {
        PreparedLiveHistory::MatchesCheckpoint => true,
        PreparedLiveHistory::NativeCandidate {
            kind,
            replacement: Some(replacement),
        } => {
            if replacement.persist().is_ok() {
                record_sandbox_op(
                    "session_history_prune_reconcile",
                    started_at.elapsed(),
                    true,
                    None,
                );
                log_info!(
                    LOG_TAG,
                    "Replaced live {} session history with committed compact generation",
                    kind.label()
                );
                true
            } else {
                record_sandbox_op(
                    "session_history_prune_reconcile",
                    started_at.elapsed(),
                    false,
                    Some("replace_failed"),
                );
                log_warn!(
                    LOG_TAG,
                    "Failed to reconcile committed {} compact generation into live session \
                     history; next resume will restore checkpoint history",
                    kind.label()
                );
                false
            }
        }
        PreparedLiveHistory::NativeCandidate {
            kind,
            replacement: None,
        } => {
            record_sandbox_op(
                "session_history_prune_reconcile",
                started_at.elapsed(),
                false,
                Some("stage_failed"),
            );
            log_warn!(
                LOG_TAG,
                "Failed to reconcile committed {} compact generation into live session \
                 history; next resume will restore checkpoint history",
                kind.label()
            );
            false
        }
    }
}

pub(super) fn write_final_session_history_identity(
    mode: CheckpointMode,
    cli_agent_session_id: &str,
    history_hash: &str,
    history_size: u64,
    history_source: &SessionHistorySourceRef,
    framework: env::Framework,
    final_session_history_identity_file: &str,
) {
    if !matches!(mode, CheckpointMode::Success) {
        return;
    }
    let identity = match build_final_session_history_identity(
        framework,
        cli_agent_session_id,
        history_hash,
        history_size,
        history_source,
    ) {
        Ok(identity) => identity,
        Err(error) => {
            match error {
                SessionHistoryIdentityBuildError::InvalidSessionId => record_sandbox_op(
                    "session_history_identity_write_skipped_invalid_session_id",
                    Duration::ZERO,
                    true,
                    None,
                ),
                SessionHistoryIdentityBuildError::InvalidMetadata(_) => record_sandbox_op(
                    "session_history_identity_write_skipped_invalid_metadata",
                    Duration::ZERO,
                    true,
                    None,
                ),
            }
            log_info!(LOG_TAG, "Final session history identity skipped: {error}");
            return;
        }
    };
    let bytes = match identity.to_json_vec() {
        Ok(bytes) => bytes,
        Err(error) => {
            record_sandbox_op(
                "session_history_identity_write_skipped_invalid_metadata",
                Duration::ZERO,
                true,
                None,
            );
            log_info!(LOG_TAG, "Final session history identity skipped: {error}");
            return;
        }
    };
    match crate::paths::write_private(final_session_history_identity_file, bytes) {
        Ok(()) => {
            record_sandbox_op(
                "session_history_identity_written",
                Duration::ZERO,
                true,
                None,
            );
            log_info!(LOG_TAG, "Final session history identity written");
        }
        Err(_) => {
            record_sandbox_op(
                "session_history_identity_write_failed",
                Duration::ZERO,
                false,
                None,
            );
            log_warn!(LOG_TAG, "Failed to write final session history identity");
        }
    }
}

fn validate_session_history(session_history: &str) -> Result<usize, String> {
    let mut line_count = 0usize;
    for (index, line) in session_history.lines().enumerate() {
        validate_session_history_line(index + 1, line)?;
        line_count += 1;
    }

    if line_count == 0 {
        return Err("Session history has no JSONL entries".into());
    }

    Ok(line_count)
}

fn validate_session_history_line(index: usize, line: &str) -> Result<(), String> {
    if line.trim().is_empty() {
        return Err(format!("Session history line {index} is empty"));
    }
    serde_json::from_str::<serde::de::IgnoredAny>(line)
        .map_err(|e| format!("Session history line {index} is not valid JSON: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AgentError;

    #[test]
    fn checkpoint_failure_recording_preserves_typed_history_limit_error() {
        let error = fail_preserving_error(
            "session_history_read",
            std::time::Instant::now(),
            AgentError::CheckpointHistoryTooLarge { max_bytes: 1 },
        );
        assert!(matches!(
            error,
            AgentError::CheckpointHistoryTooLarge { max_bytes: 1 }
        ));
    }

    #[test]
    fn pi_success_does_not_downgrade_a_late_history_size_failure() {
        let too_large = AgentError::CheckpointHistoryTooLarge { max_bytes: 128 };
        assert!(pi_history_preparation_is_fatal(
            CheckpointMode::Success,
            env::Framework::Pi,
            &too_large
        ));
        assert!(!pi_history_preparation_is_fatal(
            CheckpointMode::Recovery,
            env::Framework::Pi,
            &too_large
        ));
        assert!(!pi_history_preparation_is_fatal(
            CheckpointMode::Success,
            env::Framework::ClaudeCode,
            &too_large
        ));
    }

    #[test]
    fn zstd_checkpoint_analysis_returns_typed_history_limit_error() {
        let encoded = zstd_session_history(b"{}\n").unwrap();
        let error = match analyze_zstd_session_history(&encoded, 1) {
            Ok(_) => panic!("expected zstd history to exceed the decoded limit"),
            Err(error) => error,
        };
        assert!(matches!(
            error,
            AgentError::CheckpointHistoryTooLarge { max_bytes: 1 }
        ));
    }

    #[test]
    fn session_history_validation_accepts_valid_jsonl() {
        let history = r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant"}"#;

        assert_eq!(validate_session_history(&history), Ok(2));
    }

    #[test]
    fn session_history_validation_rejects_partial_trailing_json() {
        let history = r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant""#;

        let err = validate_session_history(&history).unwrap_err();

        assert!(err.contains("line 2"));
    }

    #[test]
    fn session_history_validation_rejects_blank_lines() {
        let history = r#"{"type":"system"}"#.to_string() + "\n\n" + r#"{"type":"assistant"}"#;

        let err = validate_session_history(&history).unwrap_err();

        assert!(err.contains("line 2"));
    }

    #[test]
    fn pi_history_validates_official_jsonl() {
        let history = br#"{"type":"session","id":"00000000-0000-4000-8000-000000000001"}
{"type":"message","id":"message-1","parentId":null}"#;
        let prepared = prepare_raw_session_history(std::time::Instant::now(), history.to_vec())
            .expect("Pi JSONL should pass recovery validation");

        assert_eq!(prepared.raw_size, history.len() as u64);
        assert_eq!(prepared.hash, hex::encode(Sha256::digest(history)));
        match prepared.upload_source {
            PreparedSessionHistoryUploadSource::Raw(bytes) => assert_eq!(bytes, history),
            PreparedSessionHistoryUploadSource::ReusedCodexZstd(_) => {
                panic!("Pi history must remain raw JSONL bytes")
            }
        }
    }
}
