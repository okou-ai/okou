use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

use guest_contracts::diagnostics::{
    CliTerminationReason, FailureDiagnostic, GUEST_MEMORY_OOM_KILLED_ERROR,
};
use guest_contracts::session_history_identity::{
    SessionHistoryIdentity, SessionHistoryIdentityError,
};
use sandbox::{
    ExecTermination, GuestProcessCancelHandle, GuestProcessControlHandle, GuestProcessHandle,
    OperationCancellationContext, ProcessControlFailureKind, ProcessControlGuestStatus,
    ProcessControlOutcome, ProcessOutputMode, Sandbox, StartAgentProcessRequest,
};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::codex_model_catalog_prefetch::{
    CodexModelCatalogPrefetch, CodexModelCatalogPrefetchStart, StartedCodexModelCatalogPrefetch,
    is_eligible as is_codex_model_catalog_prefetch_eligible,
};
use super::diagnostics::{
    AgentBootstrapAbnormalExitLogContext, AgentEnvDiagnostics, AgentStdoutStreamDiagnostics,
    StdoutDrainReport, build_agent_env_diagnostics, build_agent_env_key_diagnostics,
    check_host_oom, collect_agent_abnormal_exit_diagnostics, drain_stdout_to_file,
    enrich_codex_workspace_reconnect, explicit_enospc_evidence, host_oom_evidence_since_now,
    log_agent_abnormal_exit_env_diagnostics, log_agent_bootstrap_abnormal_exit_diagnostics,
    log_agent_process_exit_summary, read_guest_error_file, read_guest_failure_diagnostic_file,
    should_collect_agent_abnormal_exit_diagnostics,
    should_collect_unattributed_sigkill_resource_diagnostics,
    should_log_agent_bootstrap_abnormal_exit_diagnostics,
};
use super::env::{
    PreparedRunPayload, RequiredAgentFiles, build_env_json_for_run, build_user_env_json,
    prepare_required_agent_files,
};
use super::guest_state::{restore_guest_state, sync_guest_timezone};
use super::telemetry::{RunnerSpawnTiming, record_api_startup_boundaries};
use super::{
    EXIT_SIGKILL, ExecutionFailure, ExecutorConfig, JOB_TIMEOUT, JOB_TIMEOUT_EXIT_CODE,
    ResourceFailureDiagnostics, ResourceFailureKind, RunnerError, RunnerResult,
    SandboxReuseDisposition, SandboxReuseRejection, SandboxReuseResult, SandboxReuseTerminal,
    agent_exit_failure_message, guest_runtime_dir, guest_runtime_path, job_supervisor_timeout,
    job_terminal_wait_timeout, normalize_failure_exit_code,
};
use crate::restored_session_identity::{
    FINAL_SESSION_HISTORY_IDENTITY_READ_LIMIT, RestoredSessionIdentity,
};
use crate::storage_plan::{StoragePlan, build_storage_plan};
use crate::telemetry::JobTelemetry;
use guest_contracts::guest_binary::AGENT_PATH;
use runner_provider::ActiveInputSource;
use runner_types::ids::RunId;
use runner_types::types::{ExecutionContext, HomeReuseResult};

const AGENT_START_STDERR_CAPTURE_LIMIT_BYTES: u32 = 64 * 1024;
const STORAGE_CACHE_POPULATE_FAILED: &str = "storage-cache-populate-failed";
const STORAGE_DOWNLOAD_FAILED: &str = "storage-download-failed";
const USER_CANCELLATION_CONTROL_PAYLOAD: &[u8] = br#"{"type":"user-cancellation"}"#;

fn private_write_timeout_stage(error: &RunnerError) -> Option<&'static str> {
    let RunnerError::Sandbox(sandbox::SandboxError::OperationTimeout {
        operation: sandbox::SandboxOperation::WriteFile,
        stage,
        ..
    }) = error
    else {
        return None;
    };
    Some(match stage {
        sandbox::SandboxOperationTimeoutStage::BeforeFrameWrite => "before_frame_write",
        sandbox::SandboxOperationTimeoutStage::FrameWrite => "frame_write",
        sandbox::SandboxOperationTimeoutStage::AwaitingTerminalResponse => {
            "await_terminal_response"
        }
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FinalIdentityReason {
    MetadataPathUnresolved,
    RuntimeDirUnresolved,
    MissingMetadata,
    MetadataReadFailed,
    InvalidMetadata,
    UnverifiableMetadata,
}

impl FinalIdentityReason {
    const fn action_type(self) -> &'static str {
        match self {
            Self::MetadataPathUnresolved => {
                "session_history_identity_finalize_metadata_path_unresolved"
            }
            Self::RuntimeDirUnresolved => {
                "session_history_identity_finalize_runtime_dir_unresolved"
            }
            Self::MissingMetadata => "session_history_identity_finalize_missing_metadata",
            Self::MetadataReadFailed => "session_history_identity_finalize_metadata_read_failed",
            Self::InvalidMetadata => "session_history_identity_finalize_invalid_metadata",
            Self::UnverifiableMetadata => "session_history_identity_finalize_unverifiable_metadata",
        }
    }

    const fn from_final_metadata_error(error: SessionHistoryIdentityError) -> Self {
        match error {
            SessionHistoryIdentityError::MetadataTooLarge => Self::UnverifiableMetadata,
            SessionHistoryIdentityError::InvalidJson
            | SessionHistoryIdentityError::InvalidFramework
            | SessionHistoryIdentityError::InvalidHistoryRefKind
            | SessionHistoryIdentityError::InvalidSessionIdHash
            | SessionHistoryIdentityError::InvalidHistoryHash
            | SessionHistoryIdentityError::InvalidHistorySize
            | SessionHistoryIdentityError::InvalidHistorySource => Self::InvalidMetadata,
        }
    }
}

fn record_session_history_identity_reason(
    telemetry: &mut JobTelemetry,
    reason: FinalIdentityReason,
) {
    telemetry.record(reason.action_type(), Duration::ZERO, true, None);
}

fn validate_agent_bootstrap_exec_boundary(env_pairs: &[(String, String)]) -> RunnerResult<()> {
    let mut values = Vec::with_capacity(env_pairs.len() + 1);
    values.push(guest_contracts::exec_limits::ExecBoundaryValue::arg(
        "argv[0]", AGENT_PATH,
    ));
    for (key, value) in env_pairs {
        values.push(guest_contracts::exec_limits::ExecBoundaryValue::env(
            key.as_str(),
            value,
        ));
    }

    guest_contracts::exec_limits::validate_exec_boundary_sizes(values).map_err(|error| {
        RunnerError::Internal(format!("guest-agent bootstrap argv/env too large: {error}"))
    })
}

async fn read_final_session_history_identity(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
) -> Result<RestoredSessionIdentity, FinalIdentityReason> {
    let metadata_path = match guest_runtime_path(
        context.run_id,
        guest_contracts::runtime_paths::final_session_history_identity_file,
    ) {
        Ok(path) => path,
        Err(_) => {
            return Err(FinalIdentityReason::MetadataPathUnresolved);
        }
    };
    let runtime_dir = match guest_runtime_dir(context.run_id) {
        Ok(path) => path,
        Err(_) => {
            return Err(FinalIdentityReason::RuntimeDirUnresolved);
        }
    };
    let bytes = match sandbox
        .read_file(&metadata_path, FINAL_SESSION_HISTORY_IDENTITY_READ_LIMIT)
        .await
    {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Err(FinalIdentityReason::MissingMetadata),
        Err(_) => return Err(FinalIdentityReason::MetadataReadFailed),
    };
    let metadata = match SessionHistoryIdentity::from_json_slice(&bytes) {
        Ok(metadata) => metadata,
        Err(error) => {
            return Err(FinalIdentityReason::from_final_metadata_error(error));
        }
    };
    RestoredSessionIdentity::from_final_metadata(metadata, metadata_path, runtime_dir)
        .ok_or(FinalIdentityReason::UnverifiableMetadata)
}

#[derive(Clone, Copy)]
pub(super) struct ProcessCancelTimeouts {
    pub(super) write: Duration,
    pub(super) terminal_grace: Duration,
    pub(super) cooperative_grace: Duration,
}

pub(super) struct AgentExecutionResult {
    pub(super) pre_agent_retry: Option<Box<PreparedRunInputs>>,
    pub(super) failure: Option<ExecutionFailure>,
    pub(super) sandbox_reuse_disposition: SandboxReuseDisposition,
    pub(super) stdout_stream_diagnostics: AgentStdoutStreamDiagnostics,
    pub(super) reusable_session_identity: Option<RestoredSessionIdentity>,
}

impl AgentExecutionResult {
    pub(super) fn failure(
        exit_code: i32,
        error: impl Into<String>,
        diagnostic: Option<FailureDiagnostic>,
    ) -> Self {
        Self {
            pre_agent_retry: None,
            failure: Some(ExecutionFailure::new(exit_code, error, diagnostic)),
            sandbox_reuse_disposition: SandboxReuseDisposition::default(),
            stdout_stream_diagnostics: AgentStdoutStreamDiagnostics::default(),
            reusable_session_identity: None,
        }
    }

    pub(super) fn failure_from_error(error: impl Into<String>) -> Self {
        Self::failure(1, error, None)
    }

    pub(super) fn cancelled() -> Self {
        Self {
            pre_agent_retry: None,
            failure: Some(ExecutionFailure::cancelled()),
            sandbox_reuse_disposition: SandboxReuseDisposition::default(),
            stdout_stream_diagnostics: AgentStdoutStreamDiagnostics::default(),
            reusable_session_identity: None,
        }
    }

    pub(super) fn with_stdout_stream_diagnostics(
        mut self,
        diagnostics: AgentStdoutStreamDiagnostics,
    ) -> Self {
        self.stdout_stream_diagnostics = diagnostics;
        self
    }

    pub(super) fn with_resource_diagnostics(
        mut self,
        resource_diagnostics: Option<ResourceFailureDiagnostics>,
    ) -> Self {
        if resource_diagnostics.is_some_and(|diagnostics| diagnostics.failure_kind.is_some()) {
            self.sandbox_reuse_disposition =
                SandboxReuseDisposition::Ineligible(SandboxReuseRejection::ResourceFailure);
        }
        if let Some(failure) = self.failure.take() {
            self.failure = Some(failure.with_resource_diagnostics(resource_diagnostics));
        }
        self
    }

    #[must_use]
    pub(super) fn with_resource_failure_kind(mut self, kind: ResourceFailureKind) -> Self {
        self.sandbox_reuse_disposition =
            SandboxReuseDisposition::Ineligible(SandboxReuseRejection::ResourceFailure);
        if let Some(failure) = self.failure.take() {
            self.failure = Some(failure.with_resource_diagnostics(Some(
                ResourceFailureDiagnostics::from_failure_kind(kind),
            )));
        }
        self
    }
}
pub(super) fn cancelled_agent_process_exit(
    guest_pid: u32,
    stream_overflowed: bool,
) -> sandbox::ProcessExit {
    let mut exit = sandbox::ProcessExit::new(guest_pid, EXIT_SIGKILL, Vec::new(), Vec::new());
    exit.termination = ExecTermination::Cancelled;
    exit.stream_overflowed = stream_overflowed;
    exit
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CancellationDisposition {
    None,
    Cooperative,
    HardFallback,
}

impl CancellationDisposition {
    fn observed(self) -> bool {
        self != Self::None
    }
}

struct ProcessWaitOutcome {
    result: sandbox::Result<sandbox::ProcessExit>,
    cancellation: CancellationDisposition,
    interrupt_stdout_drain: bool,
    // Proof from the provider result, never from our synthetic Cancelled exit.
    hard_cancel_terminal_confirmed: bool,
    oom_evidence: Option<guest_contracts::oom_evidence::OomEvidence>,
}

impl ProcessWaitOutcome {
    fn normal(result: sandbox::Result<sandbox::ProcessExit>) -> Self {
        let interrupt_stdout_drain = result.is_err();
        Self {
            result,
            cancellation: CancellationDisposition::None,
            interrupt_stdout_drain,
            hard_cancel_terminal_confirmed: false,
            oom_evidence: None,
        }
    }

    fn cooperative(exit: sandbox::ProcessExit) -> Self {
        Self {
            result: Ok(exit),
            cancellation: CancellationDisposition::Cooperative,
            interrupt_stdout_drain: false,
            hard_cancel_terminal_confirmed: false,
            oom_evidence: None,
        }
    }

    fn hard_fallback(
        guest_process_pid: u32,
        stream_overflowed: bool,
        interrupt_stdout_drain: bool,
    ) -> Self {
        Self {
            result: Ok(cancelled_agent_process_exit(
                guest_process_pid,
                stream_overflowed,
            )),
            cancellation: CancellationDisposition::HardFallback,
            interrupt_stdout_drain,
            hard_cancel_terminal_confirmed: false,
            oom_evidence: None,
        }
    }
}

async fn request_guest_process_cancel(
    run_id: runner_types::ids::RunId,
    guest_process_pid: u32,
    process_cancel: &mut Option<GuestProcessCancelHandle>,
    timeout: Duration,
) -> bool {
    let Some(process_cancel) = process_cancel.take() else {
        warn!(
            run_id = %run_id,
            pid = guest_process_pid,
            "sandbox does not support guest process cancellation"
        );
        return false;
    };
    match process_cancel.cancel(timeout).await {
        Ok(()) => true,
        Err(error) => {
            warn!(
                run_id = %run_id,
                pid = guest_process_pid,
                error = %error,
                "failed to send guest process cancellation"
            );
            false
        }
    }
}

async fn force_cancel_guest_process<F>(
    run_id: runner_types::ids::RunId,
    guest_process_pid: u32,
    process_cancel: &mut Option<GuestProcessCancelHandle>,
    process_cancel_timeouts: ProcessCancelTimeouts,
    mut wait_process: Pin<&mut F>,
) -> ProcessWaitOutcome
where
    F: Future<Output = sandbox::Result<sandbox::ProcessExit>>,
{
    if !request_guest_process_cancel(
        run_id,
        guest_process_pid,
        process_cancel,
        process_cancel_timeouts.write,
    )
    .await
    {
        return ProcessWaitOutcome::hard_fallback(guest_process_pid, false, true);
    }

    match tokio::time::timeout(
        process_cancel_timeouts.terminal_grace,
        wait_process.as_mut(),
    )
    .await
    {
        Ok(Ok(mut exit)) => {
            info!(
                run_id = %run_id,
                pid = guest_process_pid,
                "cancelled guest process reached terminal status"
            );
            let mut outcome =
                ProcessWaitOutcome::hard_fallback(guest_process_pid, exit.stream_overflowed, false);
            // Preserve metadata before replacing the terminal result, and keep
            // it separate from the real diagnostic used for cancellation proof.
            outcome.oom_evidence = take_oom_evidence(run_id, &mut exit.diagnostic);
            outcome.hard_cancel_terminal_confirmed = exit.diagnostic.is_empty()
                && matches!(
                    exit.termination,
                    ExecTermination::Exited { .. } | ExecTermination::Cancelled
                );
            outcome
        }
        Ok(Err(error)) => {
            warn!(
                run_id = %run_id,
                pid = guest_process_pid,
                error = %error,
                "guest process wait failed after cancellation"
            );
            ProcessWaitOutcome::hard_fallback(guest_process_pid, false, true)
        }
        Err(_) => {
            warn!(
                run_id = %run_id,
                pid = guest_process_pid,
                timeout_ms = process_cancel_timeouts.terminal_grace.as_millis(),
                "timed out waiting for cancelled guest process"
            );
            ProcessWaitOutcome::hard_fallback(guest_process_pid, false, true)
        }
    }
}

enum CooperativeCancellationSend {
    Accepted,
    Force,
    Closed(std::io::Error),
}

fn control_closed_before_cancellation(outcome: &ProcessControlOutcome) -> bool {
    match outcome {
        ProcessControlOutcome::GuestStatus { status, .. } => matches!(
            status,
            ProcessControlGuestStatus::Inactive | ProcessControlGuestStatus::SinkClosed
        ),
        ProcessControlOutcome::Failed {
            kind: ProcessControlFailureKind::Operation,
            error,
            ..
        } => matches!(
            error.kind(),
            std::io::ErrorKind::BrokenPipe
                | std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::UnexpectedEof
        ),
        _ => false,
    }
}

async fn send_cooperative_user_cancellation(
    run_id: runner_types::ids::RunId,
    process_control: &GuestProcessControlHandle,
    hard_cancel: &CancellationToken,
    timeout: Duration,
) -> CooperativeCancellationSend {
    let message_id = format!("user-cancellation:{run_id}");
    tokio::select! {
        biased;
        () = hard_cancel.cancelled() => CooperativeCancellationSend::Force,
        outcome = process_control.control_outcome(
            &message_id,
            USER_CANCELLATION_CONTROL_PAYLOAD,
            timeout,
        ) => {
            let closed = control_closed_before_cancellation(&outcome);
            match outcome.into_ack() {
                Ok(ack) if ack.message_id == message_id => CooperativeCancellationSend::Accepted,
                Ok(ack) => {
                    warn!(
                        run_id = %run_id,
                        expected_message_id = %message_id,
                        acknowledged_message_id = %ack.message_id,
                        "guest acknowledged the wrong user-cancellation message"
                    );
                    CooperativeCancellationSend::Force
                }
                Err(error) if closed => CooperativeCancellationSend::Closed(error),
                Err(error) => {
                    warn!(
                        run_id = %run_id,
                        error = %error,
                        "failed to send cooperative user cancellation"
                    );
                    CooperativeCancellationSend::Force
                }
            }
        }
    }
}

async fn wait_for_cooperative_user_cancellation<F>(
    run_id: runner_types::ids::RunId,
    guest_process_pid: u32,
    process_control: &GuestProcessControlHandle,
    process_cancel: &mut Option<GuestProcessCancelHandle>,
    hard_cancel: &CancellationToken,
    process_cancel_timeouts: ProcessCancelTimeouts,
    mut wait_process: Pin<&mut F>,
) -> ProcessWaitOutcome
where
    F: Future<Output = sandbox::Result<sandbox::ProcessExit>>,
{
    let sent = send_cooperative_user_cancellation(
        run_id,
        process_control,
        hard_cancel,
        process_cancel_timeouts.write,
    )
    .await;
    if !matches!(sent, CooperativeCancellationSend::Accepted) {
        let outcome = force_cancel_guest_process(
            run_id,
            guest_process_pid,
            process_cancel,
            process_cancel_timeouts,
            wait_process,
        )
        .await;
        if let CooperativeCancellationSend::Closed(error) = sent {
            if outcome.hard_cancel_terminal_confirmed {
                info!(
                    run_id = %run_id,
                    error = %error,
                    recovered_after_cancellation = true,
                    "failed to send cooperative user cancellation"
                );
            } else {
                warn!(
                    run_id = %run_id,
                    error = %error,
                    recovered_after_cancellation = false,
                    "failed to send cooperative user cancellation"
                );
            }
        }
        return outcome;
    }

    tokio::select! {
        biased;
        result = wait_process.as_mut() => {
            match result {
                Ok(exit) => {
                    info!(
                        run_id = %run_id,
                        pid = guest_process_pid,
                        "guest completed cooperative user cancellation"
                    );
                    ProcessWaitOutcome::cooperative(exit)
                }
                Err(error) => {
                    warn!(
                        run_id = %run_id,
                        pid = guest_process_pid,
                        error = %error,
                        "guest process wait failed during cooperative cancellation"
                    );
                    request_guest_process_cancel(
                        run_id,
                        guest_process_pid,
                        process_cancel,
                        process_cancel_timeouts.write,
                    )
                    .await;
                    ProcessWaitOutcome::hard_fallback(guest_process_pid, false, true)
                }
            }
        }
        () = hard_cancel.cancelled() => {
            info!(
                run_id = %run_id,
                "hard cancellation preempted cooperative user cancellation"
            );
            force_cancel_guest_process(
                run_id,
                guest_process_pid,
                process_cancel,
                process_cancel_timeouts,
                wait_process,
            )
            .await
        }
        () = tokio::time::sleep(process_cancel_timeouts.cooperative_grace) => {
            warn!(
                run_id = %run_id,
                timeout_ms = process_cancel_timeouts.cooperative_grace.as_millis(),
                "cooperative user cancellation timed out"
            );
            force_cancel_guest_process(
                run_id,
                guest_process_pid,
                process_cancel,
                process_cancel_timeouts,
                wait_process,
            )
            .await
        }
    }
}

fn wait_process_timed_out(error: &sandbox::SandboxError) -> bool {
    matches!(
        error,
        sandbox::SandboxError::Operation {
            operation: sandbox::SandboxOperation::WaitProcess,
            reason: sandbox::SandboxOperationReason::Timeout,
            ..
        }
    ) || matches!(
        error,
        sandbox::SandboxError::Io(error) if error.kind() == std::io::ErrorKind::TimedOut
    )
}

fn process_exit_code(exit: &sandbox::ProcessExit) -> Option<i32> {
    match exit.termination {
        ExecTermination::Exited { exit_code } => Some(exit_code),
        ExecTermination::TimedOut
        | ExecTermination::Cancelled
        | ExecTermination::StartFailed
        | ExecTermination::WaitFailed => None,
    }
}

fn process_failed(exit: &sandbox::ProcessExit) -> bool {
    !matches!(exit.termination, ExecTermination::Exited { exit_code: 0 })
}

fn diagnostic_is_agent_execution_timeout(diagnostic: Option<&FailureDiagnostic>) -> bool {
    diagnostic
        .and_then(|diagnostic| diagnostic.cli_termination.as_ref())
        .is_some_and(|termination| termination.reason == CliTerminationReason::ExecutionTimeout)
}

fn diagnostic_is_control_path_failure(diagnostic: Option<&FailureDiagnostic>) -> bool {
    diagnostic
        .and_then(|diagnostic| diagnostic.cli_termination.as_ref())
        .is_some_and(|termination| {
            matches!(
                termination.reason,
                CliTerminationReason::HeartbeatError | CliTerminationReason::HeartbeatPanic
            )
        })
}

/// An app-server that cannot finish its local state backfill leaves the same
/// Codex home unusable for another run in this sandbox. The guest-generated
/// initialize error and Codex's backfill timeout must both be present so an
/// unrelated nonzero CLI exit remains reusable.
fn is_codex_state_backfill_timeout(failure: &ExecutionFailure) -> bool {
    failure
        .error
        .starts_with("execution: codex app-server child exited while waiting for initialize:")
        && failure
            .error
            .contains("timed out waiting for state db backfill")
}

fn sandbox_reuse_disposition_for_process_exit(
    exit: &sandbox::ProcessExit,
    cancellation: CancellationDisposition,
    failure: Option<&ExecutionFailure>,
) -> SandboxReuseDisposition {
    if cancellation == CancellationDisposition::HardFallback {
        return SandboxReuseDisposition::Ineligible(SandboxReuseRejection::HardCancellation);
    }
    if failure.is_some_and(|failure| {
        failure
            .resource_diagnostics
            .is_some_and(|diagnostics| diagnostics.failure_kind.is_some())
    }) {
        return SandboxReuseDisposition::Ineligible(SandboxReuseRejection::ResourceFailure);
    }
    // A guest-agent execution deadline is reusable only when the provider
    // observed the guest-agent itself exit. A provider-level timeout does not
    // carry the same process-termination evidence.
    let exit_code = match exit.termination {
        ExecTermination::Exited { exit_code } => exit_code,
        ExecTermination::TimedOut => {
            return SandboxReuseDisposition::Ineligible(SandboxReuseRejection::UnconfirmedTimeout);
        }
        ExecTermination::Cancelled | ExecTermination::StartFailed | ExecTermination::WaitFailed => {
            return SandboxReuseDisposition::Ineligible(SandboxReuseRejection::ExecutionUncertain);
        }
    };
    if failure
        .is_some_and(|failure| diagnostic_is_control_path_failure(failure.diagnostic.as_ref()))
    {
        return SandboxReuseDisposition::Ineligible(SandboxReuseRejection::ControlPathFailure);
    }
    if failure.is_some_and(is_codex_state_backfill_timeout) {
        return SandboxReuseDisposition::Ineligible(
            SandboxReuseRejection::CodexStateBackfillTimeout,
        );
    }
    if cancellation == CancellationDisposition::Cooperative {
        SandboxReuseDisposition::Eligible(SandboxReuseTerminal::CooperativeCancellation)
    } else if failure.is_some_and(|failure| {
        matches!(
            failure.kind,
            super::ExecutionFailureKind::RunnerJobTimeout { .. }
        )
    }) {
        SandboxReuseDisposition::Eligible(SandboxReuseTerminal::ExecutionTimeout)
    } else if exit_code == 0 {
        SandboxReuseDisposition::Eligible(SandboxReuseTerminal::Success)
    } else {
        SandboxReuseDisposition::Eligible(SandboxReuseTerminal::NonzeroExit)
    }
}

/// Whether this failed run was terminated by a guest out-of-memory kill of the
/// agent process itself.
///
/// Kernel victims or reliable local counters supply the domain attribution.
/// The terminal exit code only
/// corroborates that the process the guest waited on was killed: depending on
/// the launcher, that arrives either as an observed signal or as a shell's
/// `137` exit translation, so a signal field is not required for that path.
/// A surviving Guest wrapper exits 1 when its native app-server child dies;
/// that path additionally requires the child's typed natural SIGKILL diagnostic.
fn guest_memory_oom_killed_agent(
    agent_domain_oom_kill: bool,
    exit: &sandbox::ProcessExit,
    diagnostic: Option<&FailureDiagnostic>,
) -> bool {
    agent_domain_oom_kill
        && match exit.termination {
            ExecTermination::Exited {
                exit_code: EXIT_SIGKILL,
            } => true,
            ExecTermination::Exited { exit_code: 1 } => {
                diagnostic.is_some_and(FailureDiagnostic::is_codex_app_server_sigkill)
            }
            _ => false,
        }
}

/// Select the user-visible reason a failed agent run stopped.
fn agent_failure_error(
    guest_memory_oom_killed: bool,
    stderr: String,
    guest_error: Option<String>,
    failure_exit_code: i32,
) -> String {
    if guest_memory_oom_killed {
        // The captured stderr tail describes whatever the agent last reported,
        // not why it stopped. Guest logs retain that tail either way.
        return GUEST_MEMORY_OOM_KILLED_ERROR.to_string();
    }
    if !stderr.is_empty() {
        return stderr;
    }
    // Stderr is empty (redirected to log file). Check for a structured error
    // file written by the guest-agent for final failure handoff.
    guest_error.unwrap_or_else(|| agent_exit_failure_message(failure_exit_code))
}

/// Remove bounded OOM metadata before outcome processing so it never reaches
/// user-facing stderr. Metadata alone does not select terminal semantics;
/// correlated kernel evidence is evaluated separately for a proven agent OOM.
fn take_oom_evidence(
    run_id: runner_types::ids::RunId,
    diagnostic: &mut String,
) -> Option<guest_contracts::oom_evidence::OomEvidence> {
    let split = guest_contracts::oom_evidence::split_diagnostic(diagnostic);
    *diagnostic = split.residual;
    if split.malformed_lines > 0 {
        warn!(
            run_id = %run_id,
            malformed_lines = split.malformed_lines,
            "guest oom evidence envelope malformed"
        );
    }
    split.evidence
}

fn process_failure_exit_code(exit: &sandbox::ProcessExit) -> i32 {
    match exit.termination {
        ExecTermination::Exited { exit_code } => normalize_failure_exit_code(exit_code),
        ExecTermination::TimedOut => JOB_TIMEOUT_EXIT_CODE,
        ExecTermination::Cancelled | ExecTermination::StartFailed | ExecTermination::WaitFailed => {
            1
        }
    }
}

fn process_failure_stderr(exit: &sandbox::ProcessExit) -> String {
    let mut stderr = String::from_utf8_lossy(&exit.stderr).to_string();
    match exit.termination {
        ExecTermination::TimedOut => {
            if stderr.is_empty() {
                return "Timeout".to_string();
            }
        }
        ExecTermination::Cancelled => {
            if stderr.is_empty() {
                stderr.push_str("Cancelled");
            }
            append_process_diagnostic(&mut stderr, &exit.diagnostic);
        }
        ExecTermination::StartFailed | ExecTermination::WaitFailed => {
            append_process_diagnostic(&mut stderr, &exit.diagnostic);
        }
        ExecTermination::Exited { .. } => {}
    }

    stderr
}

fn append_process_diagnostic(stderr: &mut String, diagnostic: &str) {
    if diagnostic.is_empty() {
        return;
    }
    if !stderr.is_empty() && !stderr.ends_with('\n') {
        stderr.push('\n');
    }
    stderr.push_str(diagnostic);
}

/// How this run is entering its sandbox. `restore_guest_state` gates clock/entropy
/// repair and `prev_storage` enables the download-skip optimization on reuse. The
/// reuse outcomes guide execution preparation and label detailed startup telemetry.
/// `sandbox_startup_path` is the settled path sent separately as `sandboxStartupPath`
/// by the startup report; completion does not carry reuse outcomes.
pub(super) struct RunStart<'a> {
    pub(super) restore_guest_state: bool,
    pub(super) reuse_result: SandboxReuseResult,
    pub(super) home_reuse_result: HomeReuseResult,
    pub(super) sandbox_startup_path: runner_types::types::SandboxStartupPath,
    pub(super) prev_storage: Option<&'a crate::storage_fingerprints::StorageFingerprints>,
}

pub(super) struct RunControls {
    pub(super) sandbox_recovery: Option<super::SandboxRecoveryHooks>,
    pub(super) disk_recovery: bool,
    pub(super) cancel: CancellationToken,
    pub(super) cooperative_user_cancel: CancellationToken,
    pub(super) hard_cancel: CancellationToken,
    pub(super) active_input_source: Option<ActiveInputSource>,
    pub(super) spawn_timing: Option<RunnerSpawnTiming>,
    pub(super) home_history_proof:
        Option<guest_contracts::home_cache_history::HomeCacheHistoryProofBinding>,
    pub(super) prepared_storage: Option<crate::storage_cache::PreparedStorage>,
    pub(super) prepared_guest_runtime: Option<PreparedGuestRuntime>,
    pub(super) pre_spawn_admission_lease:
        Option<crate::pre_spawn_admission::PreSpawnAdmissionLease>,
    guest_state_prepared: bool,
}

pub(super) struct PreparedRunInputs {
    pub(super) controls: RunControls,
    pub(super) run_payload: PreparedRunPayload,
}

impl PreparedRunInputs {
    pub(super) fn new(controls: RunControls, run_payload: PreparedRunPayload) -> Self {
        Self {
            controls,
            run_payload,
        }
    }
}

pub(super) enum PreparedGuestRuntime {
    Ready(StartedCodexModelCatalogPrefetch),
    SandboxUnusable(RunnerError),
    Failed(RunnerError),
    Cancelled,
}

impl PreparedGuestRuntime {
    async fn start_codex_model_catalog_prefetch(
        sandbox: &dyn Sandbox,
        context: &ExecutionContext,
        reuse_result: SandboxReuseResult,
        cancel: &CancellationToken,
        telemetry: &mut JobTelemetry,
    ) -> Self {
        match StartedCodexModelCatalogPrefetch::start(sandbox, context, reuse_result, cancel).await
        {
            CodexModelCatalogPrefetchStart::Usable(prefetch) => Self::Ready(prefetch),
            CodexModelCatalogPrefetchStart::SandboxUnusable(unusable) => {
                Self::SandboxUnusable(unusable.record_and_into_error(telemetry).into())
            }
        }
    }

    pub(super) async fn prepare_for_codex_model_catalog_prefetch(
        sandbox: &dyn Sandbox,
        context: &ExecutionContext,
        restore_guest_state: bool,
        reuse_result: SandboxReuseResult,
        cancel: &CancellationToken,
        telemetry: &mut JobTelemetry,
    ) -> Option<Self> {
        if !is_codex_model_catalog_prefetch_eligible(context, reuse_result) {
            return None;
        }

        Some(
            Self::prepare(
                sandbox,
                context,
                restore_guest_state,
                reuse_result,
                cancel,
                telemetry,
            )
            .await,
        )
    }

    pub(super) async fn prepare_without_codex_model_catalog_prefetch(
        sandbox: &dyn Sandbox,
        context: &ExecutionContext,
        restore_guest_state: bool,
        cancel: &CancellationToken,
        telemetry: &mut JobTelemetry,
    ) -> Self {
        match prepare_guest_runtime_state_phase(
            sandbox,
            context,
            restore_guest_state,
            cancel,
            telemetry,
        )
        .await
        {
            GuestRuntimeStatePreparation::Ready => {
                Self::Ready(StartedCodexModelCatalogPrefetch::disabled())
            }
            GuestRuntimeStatePreparation::Failed(error) => Self::Failed(error),
            GuestRuntimeStatePreparation::Cancelled => Self::Cancelled,
        }
    }

    async fn prepare(
        sandbox: &dyn Sandbox,
        context: &ExecutionContext,
        restore_guest_state: bool,
        reuse_result: SandboxReuseResult,
        cancel: &CancellationToken,
        telemetry: &mut JobTelemetry,
    ) -> Self {
        match prepare_guest_runtime_state_phase(
            sandbox,
            context,
            restore_guest_state,
            cancel,
            telemetry,
        )
        .await
        {
            GuestRuntimeStatePreparation::Ready => {
                Self::start_codex_model_catalog_prefetch(
                    sandbox,
                    context,
                    reuse_result,
                    cancel,
                    telemetry,
                )
                .await
            }
            GuestRuntimeStatePreparation::Failed(error) => Self::Failed(error),
            GuestRuntimeStatePreparation::Cancelled => Self::Cancelled,
        }
    }

    pub(super) async fn finish(self, sandbox: &dyn Sandbox, telemetry: &mut JobTelemetry) {
        if let Self::Ready(prefetch) = self {
            prefetch.finish(sandbox, telemetry).await;
        }
    }
}

impl RunControls {
    pub(super) async fn prepare_codex_model_catalog_prefetch(
        &mut self,
        sandbox: &dyn Sandbox,
        context: &ExecutionContext,
        start: &RunStart<'_>,
        telemetry: &mut JobTelemetry,
    ) -> Option<PreparedGuestRuntime> {
        if !is_codex_model_catalog_prefetch_eligible(context, start.reuse_result) {
            return None;
        }
        if self.guest_state_prepared {
            Some(
                PreparedGuestRuntime::start_codex_model_catalog_prefetch(
                    sandbox,
                    context,
                    start.reuse_result,
                    &self.cancel,
                    telemetry,
                )
                .await,
            )
        } else {
            PreparedGuestRuntime::prepare_for_codex_model_catalog_prefetch(
                sandbox,
                context,
                start.restore_guest_state,
                start.reuse_result,
                &self.cancel,
                telemetry,
            )
            .await
        }
    }

    #[cfg(test)]
    pub(super) fn new(
        cancel: CancellationToken,
        active_input_source: Option<ActiveInputSource>,
    ) -> Self {
        Self::from_cancellation(
            runner_provider::RunCancellationSignals::from_hard_token(cancel),
            active_input_source,
        )
    }

    pub(super) fn from_cancellation(
        cancellation: runner_provider::RunCancellationSignals,
        active_input_source: Option<ActiveInputSource>,
    ) -> Self {
        Self {
            cancel: cancellation.any(),
            sandbox_recovery: None,
            disk_recovery: false,
            cooperative_user_cancel: cancellation.cooperative_user(),
            hard_cancel: cancellation.hard(),
            active_input_source,
            spawn_timing: None,
            home_history_proof: None,
            prepared_storage: None,
            prepared_guest_runtime: None,
            pre_spawn_admission_lease: None,
            guest_state_prepared: false,
        }
    }

    pub(super) fn with_spawn_timing(mut self, spawn_timing: RunnerSpawnTiming) -> Self {
        self.spawn_timing = Some(spawn_timing);
        self
    }

    pub(super) fn with_sandbox_recovery(
        mut self,
        source: Option<super::SandboxRecoveryHooks>,
    ) -> Self {
        self.sandbox_recovery = source;
        self
    }

    pub(super) fn with_guest_state_prepared(mut self, prepared: bool) -> Self {
        self.guest_state_prepared = prepared;
        self
    }
}

struct PreparedAgentProcess {
    handle: GuestProcessHandle,
    process_control: GuestProcessControlHandle,
    agent_started_at: Instant,
    host_oom_evidence_since: super::diagnostics::HostOomEvidenceSince,
    deferred_background_fill: Option<crate::storage_cache::DeferredBackgroundFill>,
    env_diagnostics: AgentEnvDiagnostics,
    env_pairs: Vec<(String, String)>,
}

struct AgentBootstrapInputs {
    user_env_map: HashMap<String, String>,
    env_map: HashMap<String, String>,
    run_payload: guest_contracts::env::RunPayload,
    original_native_continuation: Option<String>,
}

struct BootstrapFileFailure {
    error: RunnerError,
    replace: bool,
    resource_diagnostics: Option<Box<ResourceFailureDiagnostics>>,
}

impl AgentBootstrapInputs {
    async fn publish_files<'a>(
        &mut self,
        sandbox: &'a dyn Sandbox,
        context: &ExecutionContext,
        reuse_result: SandboxReuseResult,
        cancel: &CancellationToken,
        telemetry: &mut JobTelemetry,
        prefetch: &mut CodexModelCatalogPrefetch<'a>,
    ) -> Result<RequiredAgentFiles, BootstrapFileFailure> {
        let owner = OperationCancellationContext::new(
            &context.run_id.to_string(),
            sandbox.id(),
            "guest_agent_bootstrap_files",
        );
        let mut recovery_attempted = false;
        let mut resource_diagnostics = None;
        loop {
            let started = Instant::now();
            let result = prefetch
                .race(run_pre_spawn_phase(cancel, &owner, async {
                    // Storage reconciliation already finished. Prepare from
                    // captured inputs within this timed, cancellable owner.
                    let preparation_started = Instant::now();
                    let prepared = prepare_required_agent_files(
                        context,
                        &mut self.user_env_map,
                        &self.run_payload,
                    );
                    telemetry.record(
                        "runner_bootstrap_file_prepare",
                        preparation_started.elapsed(),
                        prepared.is_ok(),
                        None,
                    );
                    let files = prepared?;
                    super::storage::publish_bootstrap_files(sandbox, &files.entries(), telemetry)
                        .await?;
                    super::storage::apply_content_bundles(sandbox, context, telemetry).await?;
                    RunnerResult::Ok(files.into_paths())
                }))
                .await;
            let error = match result {
                Some(Ok(files)) => {
                    telemetry.record(
                        "runner_required_private_files_write",
                        started.elapsed(),
                        true,
                        None,
                    );
                    return Ok(files);
                }
                Some(Err(error)) => error,
                None => {
                    return Err(BootstrapFileFailure {
                        error: RunnerError::Cancelled,
                        replace: false,
                        resource_diagnostics,
                    });
                }
            };
            telemetry.record_with_outcome(
                "runner_required_private_files_write",
                started.elapsed(),
                false,
                None,
                private_write_timeout_stage(&error),
            );
            if recovery_attempted || !super::disk_cleanup::is_disk_write_error(&error) {
                return Err(BootstrapFileFailure {
                    replace: recovery_attempted && super::disk_cleanup::is_disk_write_error(&error),
                    error,
                    resource_diagnostics,
                });
            }
            recovery_attempted = true;

            // Cleanup must be the sole supervised workload. Finish ownership of
            // optional prefetch before asking the guest to prove containment.
            let old_prefetch = std::mem::replace(
                prefetch,
                StartedCodexModelCatalogPrefetch::disabled().supervise(sandbox),
            );
            old_prefetch.finish(telemetry).await;
            let recovered = run_pre_spawn_phase(
                cancel,
                &owner,
                super::disk_cleanup::recover(sandbox, context, reuse_result, cancel, telemetry),
            )
            .await;
            let recovered = match recovered {
                Some(recovered) if !cancel.is_cancelled() => recovered,
                _ => {
                    return Err(BootstrapFileFailure {
                        error: RunnerError::Cancelled,
                        replace: false,
                        resource_diagnostics,
                    });
                }
            };
            resource_diagnostics = recovered.diagnostics.map(Box::new);
            if !recovered.retry {
                return Err(BootstrapFileFailure {
                    error,
                    // Helper failure prohibits an in-place replay. A new VM
                    // still requires confirmed retirement of this entire VM,
                    // including any helper whose terminal result was unknown.
                    replace: true,
                    resource_diagnostics,
                });
            }
        }
    }
}

async fn run_pre_spawn_phase<T>(
    cancel: &CancellationToken,
    owner: &OperationCancellationContext,
    phase: impl Future<Output = T>,
) -> Option<T> {
    if cancel.is_cancelled() {
        return None;
    }

    // Select on a borrow: the owned future must outlive branch selection so
    // its guards see the selected cancellation before they are destroyed.
    let phase = owner.scope(phase);
    tokio::pin!(phase);
    tokio::select! {
        biased;
        result = &mut phase => Some(result),
        () = cancel.cancelled() => {
            owner.mark_cancelled();
            None
        },
    }
}

fn record_storage_plan_state(
    plan: &StoragePlan,
    previous_storage: bool,
    planning_started: Instant,
    telemetry: &mut JobTelemetry,
) {
    if previous_storage {
        telemetry.record(
            "runner_storage_manifest_fingerprint_reuse",
            planning_started.elapsed(),
            true,
            None,
        );
    }
    if plan.reused_entries() > 0 {
        info!(
            skipped = plan.reused_entries(),
            total = plan.entry_count(),
            "filtered unchanged manifest entries"
        );
    }
    if plan.cleanup_path_count() > 0 {
        info!(
            count = plan.cleanup_path_count(),
            "computed cleanup paths for stale file removal"
        );
    }
    if plan.instruction_cleanup_count() > 0 {
        info!(
            count = plan.instruction_cleanup_count(),
            "computed instruction cleanup entries for stale file removal"
        );
    }
}

async fn populate_storage_plan(
    plan: &mut StoragePlan,
    fresh_delivery: Option<&mut crate::storage_cache::FreshArchiveDelivery>,
    sandbox: &dyn Sandbox,
    config: &ExecutorConfig,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<Option<crate::storage_cache::DeferredBackgroundFill>> {
    let cache_started = Instant::now();
    let result = crate::storage_cache::populate_cache_with_fresh_delivery(
        plan,
        sandbox,
        &config.home,
        telemetry,
        fresh_delivery,
        Some(&config.decoded_cache),
    )
    .await;
    telemetry.record(
        "runner_storage_manifest_cache_populate",
        cache_started.elapsed(),
        result.is_ok(),
        result.is_err().then_some(STORAGE_CACHE_POPULATE_FAILED),
    );
    result.map_err(Into::into)
}

enum GuestRuntimeStatePreparation {
    Ready,
    Failed(RunnerError),
    Cancelled,
}

async fn prepare_guest_runtime_state(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    restore_guest_state_required: bool,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<()> {
    if restore_guest_state_required {
        let started = Instant::now();
        let result = restore_guest_state(sandbox, context).await;
        let error = result.as_ref().err().map(ToString::to_string);
        telemetry.record(
            "runner_guest_state_restore",
            started.elapsed(),
            result.is_ok(),
            error.as_deref(),
        );
        result?;
    } else {
        let started = Instant::now();
        sync_guest_timezone(sandbox, context).await;
        telemetry.record("runner_guest_timezone_sync", started.elapsed(), true, None);
    }
    Ok(())
}

async fn prepare_guest_runtime_state_phase(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    restore_guest_state_required: bool,
    cancel: &CancellationToken,
    telemetry: &mut JobTelemetry,
) -> GuestRuntimeStatePreparation {
    match run_pre_spawn_phase(
        cancel,
        &OperationCancellationContext::new(
            &context.run_id.to_string(),
            sandbox.id(),
            "guest_runtime_state",
        ),
        prepare_guest_runtime_state(sandbox, context, restore_guest_state_required, telemetry),
    )
    .await
    {
        Some(Ok(())) => GuestRuntimeStatePreparation::Ready,
        Some(Err(error)) => GuestRuntimeStatePreparation::Failed(error),
        None => GuestRuntimeStatePreparation::Cancelled,
    }
}

async fn prepare_guest_storage(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: &RunStart<'_>,
    telemetry: &mut JobTelemetry,
    prepared_storage: &mut Option<crate::storage_cache::PreparedStorage>,
) -> RunnerResult<Option<crate::storage_cache::DeferredBackgroundFill>> {
    let Some(manifest) = &context.storage_manifest else {
        return Ok(None);
    };
    let apply_started = Instant::now();
    let planning_started = Instant::now();

    let result: RunnerResult<Option<crate::storage_cache::DeferredBackgroundFill>> = async {
        if let Some(prepared) = prepared_storage.as_mut() {
            record_storage_plan_state(
                &prepared.plan,
                start.prev_storage.is_some(),
                planning_started,
                telemetry,
            );
            let has_work = prepared.plan.requires_guest_work();
            telemetry.record(
                "runner_storage_manifest_has_work",
                Duration::ZERO,
                true,
                None,
            );
            if !has_work {
                info!(run_id = %context.run_id, "storage manifest has no download work, skipping download");
                prepared.delivery.cancel_and_drain(telemetry).await;
                let _ = prepared_storage.take();
                Ok(None)
            } else {
                let deferred = populate_storage_plan(
                    &mut prepared.plan,
                    Some(&mut prepared.delivery),
                    sandbox,
                    config,
                    telemetry,
                )
                .await?;
                let mut prepared = prepared_storage.take().ok_or_else(|| {
                    RunnerError::Internal(
                        "prepared storage disappeared after cache population".into(),
                    )
                })?;
                let files = prepared.plan.take_decoded();
                let guest_manifest = prepared.plan.into_guest_manifest();
                let download_started = Instant::now();
                let download_result = super::storage::download_storages_with_files(
                    sandbox,
                    context,
                    guest_manifest,
                    &files,
                    telemetry,
                )
                .await;
                telemetry.record(
                    "runner_storage_manifest_guest_storage_apply",
                    download_started.elapsed(),
                    download_result.is_ok(),
                    download_result.is_err().then_some(STORAGE_DOWNLOAD_FAILED),
                );
                download_result.map(|_| deferred)
            }
        } else {
            let mut plan = build_storage_plan(manifest, start.prev_storage)?;
            record_storage_plan_state(
                &plan,
                start.prev_storage.is_some(),
                planning_started,
                telemetry,
            );
            let has_work = plan.requires_guest_work();
            telemetry.record(
                "runner_storage_manifest_has_work",
                Duration::ZERO,
                true,
                None,
            );
            if !has_work {
                info!(run_id = %context.run_id, "storage manifest has no download work, skipping download");
                Ok(None)
            } else {
                let deferred =
                    populate_storage_plan(&mut plan, None, sandbox, config, telemetry).await?;
                let files = plan.take_decoded();
                let guest_manifest = plan.into_guest_manifest();
                let download_started = Instant::now();
                let download_result = super::storage::download_storages_with_files(
                    sandbox,
                    context,
                    guest_manifest,
                    &files,
                    telemetry,
                )
                .await;
                telemetry.record(
                    "runner_storage_manifest_guest_storage_apply",
                    download_started.elapsed(),
                    download_result.is_ok(),
                    download_result.is_err().then_some(STORAGE_DOWNLOAD_FAILED),
                );
                download_result.map(|_| deferred)
            }
        }
    }
    .await;

    let error = result.as_ref().err().map(ToString::to_string);
    telemetry.record(
        "runner_storage_manifest_apply",
        apply_started.elapsed(),
        result.is_ok(),
        error.as_deref(),
    );
    result
}

fn pre_spawn_cancelled(
    run_id: RunId,
    pre_spawn_started: Instant,
    telemetry: &mut JobTelemetry,
) -> AgentExecutionResult {
    info!(
        run_id = %run_id,
        "cancel received before guest process started"
    );
    let result = AgentExecutionResult::cancelled();
    telemetry.record(
        "agent_execute",
        pre_spawn_started.elapsed(),
        false,
        result
            .failure
            .as_ref()
            .map(|failure| failure.error.as_str()),
    );
    result
}

#[cfg(test)]
pub(super) async fn run_in_sandbox(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: RunStart<'_>,
    telemetry: &mut JobTelemetry,
    controls: RunControls,
) -> RunnerResult<AgentExecutionResult> {
    let prepared_run_payload = super::env::prepare_run_payload_for_run(context)?;
    run_in_sandbox_with_process_cancel_timeouts(
        sandbox,
        context,
        config,
        start,
        telemetry,
        PreparedRunInputs::new(controls, prepared_run_payload),
        &mut AgentRunLifecycle::new(super::PROCESS_CANCEL_TIMEOUTS),
    )
    .await
}

/// Owned startup delivery and cancellation policy for one Agent attempt.
pub(super) struct AgentRunLifecycle {
    pub(super) startup_report: Option<super::StartupReport>,
    process_cancel_timeouts: ProcessCancelTimeouts,
}

fn confirmed_guest_failure(error: &RunnerError) -> bool {
    matches!(
        error,
        RunnerError::Sandbox(sandbox::SandboxError::Operation {
            reason: sandbox::SandboxOperationReason::Guest,
            ..
        })
    )
}

fn pre_agent_preparation_failure(
    error: RunnerError,
    mut controls: RunControls,
    payload: PreparedRunPayload,
) -> RunnerResult<AgentExecutionResult> {
    if !controls.disk_recovery || controls.cancel.is_cancelled() || !confirmed_guest_failure(&error)
    {
        return Err(error);
    }
    controls.home_history_proof = None;
    controls.prepared_storage = None;
    controls.prepared_guest_runtime = None;
    controls.guest_state_prepared = false;
    let mut result = AgentExecutionResult::failure_from_error(error.to_string());
    result.pre_agent_retry = Some(Box::new(PreparedRunInputs::new(controls, payload)));
    Ok(result)
}

impl AgentRunLifecycle {
    pub(super) fn new(process_cancel_timeouts: ProcessCancelTimeouts) -> Self {
        Self {
            startup_report: None,
            process_cancel_timeouts,
        }
    }
}

/// Runs the inner guest-agent lifecycle with configurable cancellation timeouts.
///
/// Guest runtime state may already be prepared, while storage delivery or
/// model-catalog prefetch may already be in flight. This function:
///
/// - completes cancellation-aware guest runtime and storage preparation while
///   taking ownership of model-catalog prefetch supervision;
/// - verifies retained-home evidence, finalizes and writes private
///   guest inputs, and spawns guest-agent;
/// - starts locally owned active-input and stdout-drain work, releases deferred
///   cache fill, and supervises normal exit or cancellation;
/// - stops or drains locally owned background work before classifying terminal
///   status and collecting diagnostics; and
/// - publishes a reusable session identity only after successful execution.
///
/// Pre-spawn cancellation returns without creating a process and drains any
/// prepared storage delivery that still owns asynchronous work.
///
/// The caller retains the enclosing sandbox and network-log cleanup lifecycle
/// after this function returns.
pub(super) async fn run_in_sandbox_with_process_cancel_timeouts(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: RunStart<'_>,
    telemetry: &mut JobTelemetry,
    inputs: PreparedRunInputs,
    lifecycle: &mut AgentRunLifecycle,
) -> RunnerResult<AgentExecutionResult> {
    let process_cancel_timeouts = lifecycle.process_cancel_timeouts;
    let PreparedRunInputs {
        mut controls,
        run_payload: prepared_run_payload,
    } = inputs;
    let pre_spawn_started = Instant::now();

    // Complete cancellation-aware guest runtime and storage preparation while
    // taking ownership of model-catalog prefetch supervision.
    let prepared_guest_runtime = match controls.prepared_guest_runtime.take() {
        Some(prepared) => prepared,
        None if controls.guest_state_prepared => {
            PreparedGuestRuntime::start_codex_model_catalog_prefetch(
                sandbox,
                context,
                start.reuse_result,
                &controls.cancel,
                telemetry,
            )
            .await
        }
        None => {
            PreparedGuestRuntime::prepare(
                sandbox,
                context,
                start.restore_guest_state,
                start.reuse_result,
                &controls.cancel,
                telemetry,
            )
            .await
        }
    };
    // Keep phase cancellation distinct from an error while sharing exit cleanup.
    let guest_preparation = match prepared_guest_runtime {
        PreparedGuestRuntime::Ready(prefetch) => Ok(prefetch),
        PreparedGuestRuntime::SandboxUnusable(error) | PreparedGuestRuntime::Failed(error) => {
            Err(Some(error))
        }
        PreparedGuestRuntime::Cancelled => Err(None),
    };
    let mut model_catalog_prefetch = match guest_preparation {
        Ok(prefetch) => prefetch.supervise(sandbox),
        Err(error) => {
            if let Some(prepared) = controls.prepared_storage.as_mut() {
                prepared.delivery.cancel_and_drain(telemetry).await;
            }
            let result = match error {
                Some(error) => pre_agent_preparation_failure(error, controls, prepared_run_payload),
                None => {
                    let result = pre_spawn_cancelled(context.run_id, pre_spawn_started, telemetry);
                    Ok(result)
                }
            };
            return result;
        }
    };
    model_catalog_prefetch.record_outcome(telemetry);
    let deferred_background_fill = {
        let storage_result = model_catalog_prefetch
            .race(run_pre_spawn_phase(
                &controls.cancel,
                &OperationCancellationContext::new(
                    &context.run_id.to_string(),
                    sandbox.id(),
                    "guest_storage",
                ),
                prepare_guest_storage(
                    sandbox,
                    context,
                    config,
                    &start,
                    telemetry,
                    &mut controls.prepared_storage,
                ),
            ))
            .await;
        model_catalog_prefetch.record_outcome(telemetry);
        let storage_preparation = match storage_result {
            Some(Ok(deferred)) => Ok(deferred),
            Some(Err(error)) => Err(Some(error)),
            None => Err(None),
        };
        match storage_preparation {
            Ok(deferred) => deferred,
            Err(error) => {
                if let Some(prepared) = controls.prepared_storage.as_mut() {
                    prepared.delivery.cancel_and_drain(telemetry).await;
                }
                model_catalog_prefetch.finish(telemetry).await;
                let result = match error {
                    Some(error) => {
                        pre_agent_preparation_failure(error, controls, prepared_run_payload)
                    }
                    None => {
                        let result =
                            pre_spawn_cancelled(context.run_id, pre_spawn_started, telemetry);
                        Ok(result)
                    }
                };
                return result;
            }
        }
    };
    let RunControls {
        sandbox_recovery,
        disk_recovery,
        cancel,
        cooperative_user_cancel,
        hard_cancel,
        active_input_source,
        spawn_timing,
        home_history_proof,
        prepared_storage: _prepared_storage,
        prepared_guest_runtime: _,
        mut pre_spawn_admission_lease,
        guest_state_prepared: _,
    } = controls;
    let pre_spawn_cancel = cancel.clone();
    let pre_spawn_start = &start;
    let pre_spawn_telemetry = &mut *telemetry;
    let startup_report_cancel = cancel.clone();
    let pre_spawn_owner = OperationCancellationContext::new(
        &context.run_id.to_string(),
        sandbox.id(),
        "guest_agent_preparation",
    );
    let bootstrap = model_catalog_prefetch
        .race(run_pre_spawn_phase(&cancel, &pre_spawn_owner, async move {
            let cancel = pre_spawn_cancel;
            let start = pre_spawn_start;
            let telemetry = pre_spawn_telemetry;

            // Check the selected home image before crossing the process-spawn boundary.
            let native_home_proof_failed = if let Some(binding) = home_history_proof {
                let started = Instant::now();
                let verified =
                    super::home_history::verify_home_candidate(sandbox, context, binding, &cancel)
                        .await?;
                telemetry.record(
                    "session_history_home_cache_verify",
                    started.elapsed(),
                    verified,
                    None,
                );
                telemetry.record(
                    if verified {
                        "session_history_home_cache_hit"
                    } else {
                        "session_history_home_cache_miss"
                    },
                    Duration::ZERO,
                    true,
                    None,
                );
                !verified && context.native_continuation.is_some()
            } else {
                false
            };

            // Finalize the prepared private run payload and build the environment used
            // to bootstrap guest-agent. User-provided env is passed through a private
            // guest file and injected into the CLI child after guest-agent has started.
            let user_env_map = build_user_env_json(context);
            let env_build_started = Instant::now();
            let mut run_payload = match prepared_run_payload.into_run_payload(context) {
                Ok(run_payload) => run_payload,
                Err(error) => {
                    telemetry.record(
                        "runner_agent_env_build",
                        env_build_started.elapsed(),
                        false,
                        None,
                    );
                    return Err(error);
                }
            };
            let original_native_continuation = if native_home_proof_failed {
                let mut native = context.native_continuation.clone().ok_or_else(|| {
                    RunnerError::Internal("native home proof lost its intent".into())
                })?;
                native.session_id = None;
                native.generation_run_id = None;
                let fresh_native = serde_json::to_string(&native).map_err(|error| {
                    RunnerError::Internal(format!("serialize fresh native intent: {error}"))
                })?;
                Some(std::mem::replace(
                    &mut run_payload.native_continuation,
                    fresh_native,
                ))
            } else {
                None
            };
            info!(
                run_id = %context.run_id,
                prompt_bytes = run_payload.prompt.len(),
                append_system_prompt_bytes = run_payload.append_system_prompt.len(),
                secret_values_present = !run_payload.secret_values.is_empty(),
                disallowed_tools_bytes = run_payload.disallowed_tools.len(),
                tools_bytes = run_payload.tools.len(),
                settings_bytes = run_payload.settings.len(),
                artifacts_bytes = run_payload.artifacts.len(),
                feature_flags_bytes = run_payload.feature_flags.len(),
                "guest-agent run payload prepared"
            );
            let mut env_map = match build_env_json_for_run(context, &config.api_url, sandbox.id()) {
                Ok(env_map) => env_map,
                Err(error) => {
                    telemetry.record(
                        "runner_agent_env_build",
                        env_build_started.elapsed(),
                        false,
                        None,
                    );
                    return Err(error);
                }
            };
            env_map.insert(
                guest_contracts::env::CANONICAL_SANDBOX_STARTUP_PATH_ENV.into(),
                guest_contracts::sandbox_startup::as_wire(start.sandbox_startup_path).into(),
            );
            telemetry.record(
                "runner_agent_env_build",
                env_build_started.elapsed(),
                true,
                None,
            );

            RunnerResult::Ok(AgentBootstrapInputs {
                user_env_map,
                env_map,
                run_payload,
                original_native_continuation,
            })
        }))
        .await;
    model_catalog_prefetch.record_outcome(telemetry);
    let mut bootstrap = 'bootstrap: {
        let error = match bootstrap {
            Some(Ok(bootstrap)) => break 'bootstrap bootstrap,
            Some(Err(error)) => Some(error),
            None => None,
        };
        model_catalog_prefetch.finish(telemetry).await;
        return match error {
            Some(RunnerError::Cancelled) | None => Ok(pre_spawn_cancelled(
                context.run_id,
                pre_spawn_started,
                telemetry,
            )),
            Some(error) => Err(error),
        };
    };
    let files = bootstrap
        .publish_files(
            sandbox,
            context,
            start.reuse_result,
            &cancel,
            telemetry,
            &mut model_catalog_prefetch,
        )
        .await;
    let required_files = match files {
        Ok(files) => files,
        Err(BootstrapFileFailure {
            error,
            replace,
            resource_diagnostics,
        }) => {
            model_catalog_prefetch.finish(telemetry).await;
            let resource_diagnostics = resource_diagnostics.map(|diagnostics| *diagnostics);
            return match error {
                RunnerError::Cancelled => Ok(pre_spawn_cancelled(
                    context.run_id,
                    pre_spawn_started,
                    telemetry,
                )),
                error
                    if replace
                        || resource_diagnostics.is_some()
                        || disk_recovery && confirmed_guest_failure(&error) =>
                {
                    let mut result = AgentExecutionResult::failure_from_error(error.to_string())
                        .with_resource_diagnostics(resource_diagnostics);
                    if (replace || disk_recovery && confirmed_guest_failure(&error))
                        && !cancel.is_cancelled()
                    {
                        if let Some(original) = bootstrap.original_native_continuation.take() {
                            bootstrap.run_payload.native_continuation = original;
                        }
                        result.pre_agent_retry = Some(Box::new(PreparedRunInputs::new(
                            RunControls {
                                sandbox_recovery,
                                disk_recovery,
                                cancel,
                                cooperative_user_cancel,
                                hard_cancel,
                                active_input_source,
                                spawn_timing,
                                home_history_proof: None,
                                prepared_storage: None,
                                prepared_guest_runtime: None,
                                pre_spawn_admission_lease,
                                guest_state_prepared: false,
                            },
                            PreparedRunPayload::from_captured(bootstrap.run_payload),
                        )));
                    }
                    Ok(result)
                }
                error => Err(error),
            };
        }
    };
    let AgentBootstrapInputs {
        user_env_map,
        mut env_map,
        ..
    } = bootstrap;
    let pre_spawn_start = &start;
    let pre_spawn_telemetry = &mut *telemetry;
    let prepared_agent = model_catalog_prefetch
        .race(run_pre_spawn_phase(&cancel, &pre_spawn_owner, async move {
            let start = pre_spawn_start;
            let telemetry = pre_spawn_telemetry;
            let user_env_file = required_files.user_env_file;
            let run_payload_file = required_files.run_payload_file;
            env_map.insert(
                guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV.into(),
                user_env_file,
            );
            env_map.insert(
                guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV.into(),
                run_payload_file,
            );
            let env_diagnostics = build_agent_env_diagnostics(&env_map, &user_env_map);
            let env_pairs: Vec<(String, String)> = env_map.into_iter().collect();
            let env_refs: Vec<(&str, &str)> = env_pairs
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect();
            info!(run_id = %context.run_id, count = env_refs.len(), "passing env vars via vsock");

            // Spawn the fixed guest-agent executable with combined stdout/stderr
            // streamed to the host. A small terminal capture remains available for
            // bounded pre-start diagnostics.
            validate_agent_bootstrap_exec_boundary(&env_pairs)?;
            info!(run_id = %context.run_id, "spawning agent");

            // Guest-agent receives JOB_TIMEOUT as the user execution budget. The
            // sandbox supervisor remains a later hard fallback so guest-agent can
            // terminate the CLI and persist recovery outputs first.
            let host_oom_evidence_since = host_oom_evidence_since_now();
            let t = Instant::now();
            let handle = sandbox
                .start_agent_process(&StartAgentProcessRequest {
                    timeout: job_supervisor_timeout(),
                    env: &env_refs,
                    output: ProcessOutputMode::stream_with_stderr_capture(
                        AGENT_START_STDERR_CAPTURE_LIMIT_BYTES,
                    ),
                })
                .await;

            let agent_handle = match handle {
                Ok(h) => {
                    telemetry.set_sandbox_startup_path(start.sandbox_startup_path);
                    let timing = h.start_timing();
                    telemetry.record(
                        "runner_agent_start_process",
                        timing.shell_started_at.saturating_duration_since(t),
                        true,
                        None,
                    );
                    telemetry.record(
                        "runner_agent_start_to_ready",
                        timing.ready_at.saturating_duration_since(t),
                        true,
                        None,
                    );
                    telemetry.record(
                        "runner_agent_containment_create",
                        timing.containment_create,
                        true,
                        None,
                    );
                    telemetry.record(
                        "runner_agent_placement_broker_setup",
                        timing.placement_broker_setup,
                        true,
                        None,
                    );
                    telemetry.record(
                        "runner_agent_shell_spawn",
                        timing.shell_spawn,
                        true,
                        None,
                    );
                    telemetry.record(
                        "runner_agent_bootstrap_ready_wait",
                        timing.bootstrap_ready_wait,
                        true,
                        None,
                    );
                    if let Some(spawn_timing) = spawn_timing {
                        spawn_timing.record_agent_ready_success_at(
                            telemetry,
                            timing.shell_started_at,
                            timing.ready_at,
                        );
                    }
                    record_api_startup_boundaries(
                        context,
                        telemetry,
                        start.reuse_result,
                        start.sandbox_startup_path,
                        timing.shell_started_at,
                        timing.ready_at,
                    );
                    telemetry.record_sandbox_startup(
                        start.sandbox_startup_path,
                        start.reuse_result,
                        start.home_reuse_result,
                        context.reuse_key(),
                    );
                    lifecycle.startup_report = Some(super::StartupReport::spawn(
                        config.http.clone(), context.run_id, context.sandbox_token.clone(),
                        start.sandbox_startup_path, startup_report_cancel,
                    ));
                    info!(
                        run_id = %context.run_id,
                        sandbox_reuse = ?start.reuse_result,
                        home_reuse = ?start.home_reuse_result,
                        sandbox_startup_path = guest_contracts::sandbox_startup::as_wire(start.sandbox_startup_path),
                        shell_spawn_ms = timing.shell_started_at.saturating_duration_since(t).as_millis(),
                        agent_ready_ms = timing.ready_at.saturating_duration_since(t).as_millis(),
                        containment_create_us = timing.containment_create.as_micros(),
                        placement_broker_setup_us = timing.placement_broker_setup.as_micros(),
                        shell_spawn_component_us = timing.shell_spawn.as_micros(),
                        bootstrap_ready_wait_us = timing.bootstrap_ready_wait.as_micros(),
                        "agent startup timing"
                    );
                    // Keep the burst gate through the authenticated Agent-ready boundary.
                    // Every pre-ready return continues to release through RAII.
                    drop(pre_spawn_admission_lease.take());
                    h
                }
                Err(e) => {
                    telemetry.record(
                        "runner_agent_start_process",
                        t.elapsed(),
                        false,
                        Some(&e.to_string()),
                    );
                    telemetry.record("agent_execute", t.elapsed(), false, Some(&e.to_string()));
                    return Err(e.into());
                }
            };
            let (handle, process_control) = agent_handle.into_parts();

            RunnerResult::Ok(PreparedAgentProcess {
                handle,
                process_control,
                agent_started_at: t,
                host_oom_evidence_since,
                deferred_background_fill,
                env_diagnostics,
                env_pairs,
            })
        }))
        .await;
    model_catalog_prefetch.record_outcome(telemetry);
    let prepared_agent = 'prepared_agent: {
        let preparation_error = match prepared_agent {
            Some(Ok(prepared_agent)) => break 'prepared_agent prepared_agent,
            Some(Err(error)) => Some(error),
            None => None,
        };
        model_catalog_prefetch.finish(telemetry).await;
        match preparation_error {
            Some(RunnerError::Cancelled) | None => {
                let result = pre_spawn_cancelled(context.run_id, pre_spawn_started, telemetry);
                return Ok(result);
            }
            Some(error) => return Err(error),
        }
    };
    let PreparedAgentProcess {
        mut handle,
        process_control,
        agent_started_at: t,
        host_oom_evidence_since,
        deferred_background_fill,
        env_diagnostics,
        env_pairs,
    } = prepared_agent;

    // Start locally owned input and output work, then release deferred cache
    // fill now that process spawn has succeeded.
    let active_input_forwarder = super::active_input::ActiveInputForwarder::start(
        context.run_id,
        active_input_source,
        Some(process_control.clone()),
        cancel.clone(),
    );
    // Spawn background task to drain stdout chunks and write to the host stream log file.
    let host_log_path = config.log_paths.system_stream_log(context.run_id);
    let stream_task = handle.take_stdout_receiver().map(|stdout_rx| {
        let stop = CancellationToken::new();
        let task_stop = stop.clone();
        let task = tokio::spawn(drain_stdout_to_file(stdout_rx, host_log_path, task_stop));
        // Scope destruction must close the receiver and flush accepted output,
        // including when the normal join below is abandoned.
        (stop.drop_guard(), task)
    });

    if let Some(background_fill) = deferred_background_fill {
        background_fill.start(&config.background_fill, telemetry);
    }

    // Supervise normal exit or cancellation. A user request first asks
    // guest-agent to persist recovery state and exit; hard cancellation and
    // bounded fallback use the existing supervised-process cancellation path.
    let guest_process_pid = handle.guest_pid;
    let mut process_cancel = handle.take_cancel_handle();
    let wait_process = sandbox.wait_process(handle, job_terminal_wait_timeout());
    tokio::pin!(wait_process);
    let wait_outcome = model_catalog_prefetch
        .race(async {
            tokio::select! {
                biased;
                result = wait_process.as_mut() => {
                    ProcessWaitOutcome::normal(result)
                }
                () = hard_cancel.cancelled() => {
                    info!(run_id = %context.run_id, "hard cancellation received, cancelling guest process");
                    force_cancel_guest_process(
                        context.run_id,
                        guest_process_pid,
                        &mut process_cancel,
                        process_cancel_timeouts,
                        wait_process.as_mut(),
                    )
                    .await
                }
                () = cooperative_user_cancel.cancelled() => {
                    info!(
                        run_id = %context.run_id,
                        "user cancellation received, requesting guest recovery"
                    );
                    wait_for_cooperative_user_cancellation(
                        context.run_id,
                        guest_process_pid,
                        &process_control,
                        &mut process_cancel,
                        &hard_cancel,
                        process_cancel_timeouts,
                        wait_process.as_mut(),
                    )
                    .await
                }
            }
        })
        .await;
    model_catalog_prefetch.record_outcome(telemetry);
    let ProcessWaitOutcome {
        result,
        cancellation,
        interrupt_stdout_drain,
        oom_evidence,
        ..
    } = wait_outcome;
    let cancellation_observed = cancellation.observed();

    // Stop locally owned post-spawn work before interpreting terminal process
    // state. Join active input and model prefetch; drain or abort stdout based
    // on the wait outcome.
    if let Some(forwarder) = active_input_forwarder {
        forwarder.stop().await;
    }
    // Wait for streaming to finish (channel closes when process exits).
    // When terminal proof is unavailable, close the bounded receiver so the
    // drain can flush accepted chunks without waiting for sender drop.
    let mut stdout_drain_report = StdoutDrainReport::default();
    if let Some((stop, task)) = stream_task {
        if interrupt_stdout_drain {
            stop.token().cancel();
        }
        match task.await {
            Ok(Ok(report)) => {
                stdout_drain_report = report;
            }
            Ok(Err(e)) => {
                stdout_drain_report.stream_incomplete = true;
                warn!(run_id = %context.run_id, error = %e, "stdout stream task failed");
            }
            Err(e) => {
                stdout_drain_report.stream_incomplete = true;
                warn!(run_id = %context.run_id, error = %e, "stdout stream task failed");
            }
        }
    }
    model_catalog_prefetch.finish(telemetry).await;

    // Classify terminal state and collect diagnostics justified by the outcome.
    let stdout_stream_diagnostics_on_wait_error = AgentStdoutStreamDiagnostics {
        bytes_written: stdout_drain_report.bytes_written,
        chunk_truncated: stdout_drain_report.chunk_truncated,
        stream_overflowed: false,
        stream_incomplete: stdout_drain_report.stream_incomplete,
    };
    let mut exit = match result {
        Ok(exit) => exit,
        Err(e) => {
            // Sandbox crashed — check host dmesg for OOM evidence naming the
            // firecracker process before propagating a generic error.
            if let Some(host_process_pid) = sandbox.host_process_pid()
                && check_host_oom(host_process_pid, host_oom_evidence_since).await
            {
                warn!(
                    run_id = %context.run_id,
                    pid = host_process_pid,
                    "host OOM kill detected for firecracker"
                );
                let error = "Firecracker VM killed by host OOM killer".to_string();
                telemetry.record("agent_execute", t.elapsed(), false, Some(&error));
                return Ok(AgentExecutionResult::failure(1, error, None)
                    .with_resource_failure_kind(ResourceFailureKind::HostMemoryOomKilled)
                    .with_stdout_stream_diagnostics(stdout_stream_diagnostics_on_wait_error));
            }
            let error = e.to_string();
            telemetry.record("agent_execute", t.elapsed(), false, Some(&error));
            if wait_process_timed_out(&e) {
                return Ok(AgentExecutionResult {
                    pre_agent_retry: None,
                    failure: Some(ExecutionFailure::runner_job_timeout(
                        JOB_TIMEOUT_EXIT_CODE,
                        error,
                        None,
                        JOB_TIMEOUT,
                        t.elapsed(),
                        None,
                    )),
                    sandbox_reuse_disposition: SandboxReuseDisposition::Ineligible(
                        SandboxReuseRejection::UnconfirmedTimeout,
                    ),
                    stdout_stream_diagnostics: stdout_stream_diagnostics_on_wait_error,
                    reusable_session_identity: None,
                });
            }
            let resource_diagnostics = if explicit_enospc_evidence([error.as_str()]) {
                collect_agent_abnormal_exit_diagnostics(
                    sandbox,
                    context.run_id,
                    sandbox.id(),
                    start.reuse_result,
                    1,
                )
                .await
            } else {
                None
            };
            return Ok(AgentExecutionResult::failure_from_error(error)
                .with_resource_diagnostics(resource_diagnostics)
                .with_stdout_stream_diagnostics(stdout_stream_diagnostics_on_wait_error));
        }
    };
    let mut agent_domain_oom_kill = false;
    if let Some(evidence) = take_oom_evidence(context.run_id, &mut exit.diagnostic).or(oom_evidence)
    {
        agent_domain_oom_kill = evidence.agent_domain_oom_kill();
        if evidence
            .incidents
            .iter()
            .any(|incident| !incident.kernel_events.is_empty())
        {
            info!(run_id = %context.run_id, operation_id = %evidence.operation_id,
                evidence_kind = ResourceFailureKind::GuestMemoryOomKilled.as_str(),
                oom_classification = evidence.classification().map_or("", guest_contracts::oom_evidence::OomClassification::as_str),
                "preserved operation-scoped guest kernel oom evidence");
        }
        let path = config.log_paths.oom_evidence_log(context.run_id);
        if let Ok(bytes) = serde_json::to_vec(&evidence) {
            let retained =
                tokio::time::timeout(Duration::from_secs(1), tokio::fs::write(path, bytes)).await;
            if !matches!(retained, Ok(Ok(()))) {
                warn!(run_id = %context.run_id, "guest oom evidence persistence unavailable or timed out");
            }
        }
        telemetry.upload_oom_evidence(&evidence, sandbox.id()).await;
    }
    if exit.stream_overflowed {
        warn!(run_id = %context.run_id, "agent stdout stream overflowed before process exit");
    }
    let stdout_stream_diagnostics = AgentStdoutStreamDiagnostics {
        bytes_written: stdout_drain_report.bytes_written,
        chunk_truncated: stdout_drain_report.chunk_truncated,
        stream_overflowed: exit.stream_overflowed,
        stream_incomplete: stdout_drain_report.stream_incomplete,
    };
    if !exit.diagnostic.is_empty() {
        warn!(
            run_id = %context.run_id,
            diagnostic = %exit.diagnostic,
            "agent process reported diagnostic"
        );
    }

    info!(
        run_id = %context.run_id,
        termination = ?exit.termination,
        exit_code = ?process_exit_code(&exit),
        "agent exited"
    );
    log_agent_process_exit_summary(
        context.run_id,
        sandbox.id(),
        start.reuse_result,
        &exit,
        &env_diagnostics,
        stdout_stream_diagnostics,
    );

    let failure_diagnostic = if !cancellation_observed && process_failed(&exit) {
        read_guest_failure_diagnostic_file(sandbox, context.run_id).await
    } else {
        None
    };

    // OOM evidence is captured by trusted Guest control before cleanup and
    // uploaded above, independently of workload counters. An unscoped dmesg
    // tail cannot attribute this operation or override its terminal outcome.

    let mut failure = if cancellation_observed {
        // Cancellation remains authoritative over guest failure files. Hard
        // fallback may also leave the guest process without terminal proof.
        Some(ExecutionFailure::cancelled())
    } else if process_failed(&exit) {
        let failure_exit_code = process_failure_exit_code(&exit);
        let stderr = process_failure_stderr(&exit);
        let should_read_guest_error = stderr.is_empty()
            || (failure_diagnostic.is_none()
                && matches!(exit.termination, ExecTermination::Exited { exit_code } if exit_code != 0));
        let guest_error = if should_read_guest_error {
            read_guest_error_file(sandbox, context.run_id).await
        } else {
            None
        };
        let should_log_bootstrap_diagnostics = should_log_agent_bootstrap_abnormal_exit_diagnostics(
            cancellation_observed,
            &exit,
            failure_diagnostic.as_ref(),
            guest_error.as_deref(),
        );
        let should_collect_resource_diagnostics = should_collect_agent_abnormal_exit_diagnostics(
            cancellation_observed,
            &exit,
            &stderr,
            failure_diagnostic.as_ref(),
            guest_error.as_deref(),
        );
        let should_collect_sigkill_resource_diagnostics =
            should_collect_unattributed_sigkill_resource_diagnostics(
                cancellation_observed,
                &exit,
                failure_diagnostic.as_ref(),
            );
        let should_collect_resource_diagnostics =
            should_collect_resource_diagnostics || should_collect_sigkill_resource_diagnostics;
        // Classify the bounded resource probe before emitting the related exit
        // records so expected rootfs exhaustion has consistent severity.
        let mut resource_diagnostics = if should_collect_resource_diagnostics {
            collect_agent_abnormal_exit_diagnostics(
                sandbox,
                context.run_id,
                sandbox.id(),
                start.reuse_result,
                failure_exit_code,
            )
            .await
        } else {
            None
        };
        let guest_memory_oom_killed = guest_memory_oom_killed_agent(
            agent_domain_oom_kill,
            &exit,
            failure_diagnostic.as_ref(),
        );
        if guest_memory_oom_killed {
            resource_diagnostics = Some(ResourceFailureDiagnostics {
                failure_kind: Some(ResourceFailureKind::GuestMemoryOomKilled),
                ..resource_diagnostics.unwrap_or_default()
            });
        }
        if should_log_bootstrap_diagnostics || should_collect_resource_diagnostics {
            let env_key_diagnostics = build_agent_env_key_diagnostics(&env_pairs);
            let resource_failure_kind =
                resource_diagnostics.and_then(|diagnostics| diagnostics.failure_kind);
            if should_log_bootstrap_diagnostics {
                log_agent_bootstrap_abnormal_exit_diagnostics(
                    AgentBootstrapAbnormalExitLogContext {
                        run_id: context.run_id,
                        sandbox_id: sandbox.id(),
                        reuse_result: start.reuse_result,
                        exit: &exit,
                        env_diagnostics: &env_diagnostics,
                        env_key_diagnostics: &env_key_diagnostics,
                        stdout_stream_diagnostics,
                        resource_failure_kind,
                    },
                );
            }
            if should_collect_resource_diagnostics {
                log_agent_abnormal_exit_env_diagnostics(
                    context.run_id,
                    sandbox.id(),
                    start.reuse_result,
                    &exit,
                    &env_diagnostics,
                    &env_key_diagnostics,
                    resource_failure_kind,
                );
            }
        }
        let error = agent_failure_error(
            guest_memory_oom_killed,
            stderr,
            guest_error,
            failure_exit_code,
        );
        let is_runner_job_timeout = matches!(exit.termination, ExecTermination::TimedOut)
            || diagnostic_is_agent_execution_timeout(failure_diagnostic.as_ref());
        Some(if is_runner_job_timeout {
            ExecutionFailure::runner_job_timeout(
                failure_exit_code,
                error,
                failure_diagnostic,
                JOB_TIMEOUT,
                t.elapsed(),
                exit.guest_duration_ms,
            )
            .with_resource_diagnostics(resource_diagnostics)
        } else {
            ExecutionFailure::new(failure_exit_code, error, failure_diagnostic)
                .with_resource_diagnostics(resource_diagnostics)
        })
    } else {
        None
    };

    if let Some(failure) = failure.as_mut() {
        enrich_codex_workspace_reconnect(failure, &config.log_paths.network_log(context.run_id))
            .await;
    }

    // Finalize reusable session identity only after successful execution. A
    // pre-run identity proves only what was restored, so verify the current
    // history or confirm that the restored history stayed unchanged.
    let reusable_session_identity = if failure.is_none() {
        match read_final_session_history_identity(sandbox, context).await {
            Ok(final_identity) => {
                telemetry.record(
                    "session_history_identity_finalized",
                    Duration::ZERO,
                    true,
                    None,
                );
                Some(final_identity)
            }
            Err(final_identity_reason) => {
                record_session_history_identity_reason(telemetry, final_identity_reason);
                None
            }
        }
    } else {
        None
    };

    let sandbox_reuse_disposition =
        sandbox_reuse_disposition_for_process_exit(&exit, cancellation, failure.as_ref());
    let agent_result = match failure {
        Some(failure) => AgentExecutionResult {
            pre_agent_retry: None,
            failure: Some(failure),
            sandbox_reuse_disposition,
            stdout_stream_diagnostics,
            reusable_session_identity: None,
        },
        None => AgentExecutionResult {
            pre_agent_retry: None,
            failure: None,
            sandbox_reuse_disposition,
            stdout_stream_diagnostics,
            reusable_session_identity,
        },
    };
    telemetry.record(
        "agent_execute",
        t.elapsed(),
        agent_result.failure.is_none(),
        agent_result
            .failure
            .as_ref()
            .map(|failure| failure.error.as_str()),
    );
    Ok(agent_result)
}

#[cfg(test)]
mod tests {
    mod cancellation;

    use super::*;
    use guest_contracts::diagnostics::{
        AgentFramework, CliTerminationDiagnostic, FailureClass, PromptMetadata,
    };

    fn control_path_failure(reason: CliTerminationReason) -> ExecutionFailure {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliExecutionError,
            AgentFramework::Codex,
            PromptMetadata::from_prompt("continue"),
        )
        .with_cli_exit_code(1)
        .with_cli_termination(CliTerminationDiagnostic::new(reason));
        ExecutionFailure::new(1, "heartbeat failed", Some(diagnostic))
    }

    fn nonzero_process_exit() -> sandbox::ProcessExit {
        sandbox::ProcessExit::new(42, 1, Vec::new(), Vec::new())
    }

    const TEST_WORKLOAD_CGROUP: &str = "/vm0-exec/exec-281-10-3/workload";
    const TEST_OPERATION_STARTED_US: u64 = 1_000_000;

    fn test_memory_snapshot(
        role: &str,
        cgroup: &str,
    ) -> guest_contracts::oom_evidence::MemorySnapshot {
        guest_contracts::oom_evidence::MemorySnapshot {
            role: role.to_string(),
            cgroup: cgroup.to_string(),
            inode: None,
            status: guest_contracts::oom_evidence::EvidenceStatus::Available,
            current: None,
            peak: None,
            limit: None,
            initial_limit: None,
            anon: None,
            file: None,
            kernel: None,
            baseline: guest_contracts::oom_evidence::MemoryEvents::default(),
            events: guest_contracts::oom_evidence::MemoryEvents::default(),
            delta: guest_contracts::oom_evidence::MemoryEvents::default(),
            local_baseline: guest_contracts::oom_evidence::MemoryEvents::default(),
            local_events: guest_contracts::oom_evidence::MemoryEvents::default(),
            local_delta: guest_contracts::oom_evidence::MemoryEvents::default(),
        }
    }

    fn test_memory_groups() -> [guest_contracts::oom_evidence::MemorySnapshot; 3] {
        [
            test_memory_snapshot("workload", TEST_WORKLOAD_CGROUP),
            test_memory_snapshot("runtime", &format!("{TEST_WORKLOAD_CGROUP}/runtime")),
            test_memory_snapshot("tools", &format!("{TEST_WORKLOAD_CGROUP}/tools")),
        ]
    }

    fn test_kernel_event(
        task_cgroup: &str,
        boottime_us: u64,
    ) -> guest_contracts::oom_evidence::KernelOomEvent {
        guest_contracts::oom_evidence::KernelOomEvent {
            source: "guest".to_string(),
            sequence: 7,
            boottime_us,
            constraint: "CONSTRAINT_NONE".to_string(),
            oom_cgroup: None,
            victim_pid: 4242,
            victim_comm: "tsc".to_string(),
            task_cgroup: task_cgroup.to_string(),
        }
    }

    fn test_oom_evidence(
        kernel_status: guest_contracts::oom_evidence::EvidenceStatus,
        kernel_events: Vec<guest_contracts::oom_evidence::KernelOomEvent>,
    ) -> guest_contracts::oom_evidence::OomEvidence {
        guest_contracts::oom_evidence::OomEvidence {
            operation_id: "1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e".to_string(),
            guest_boot_id: None,
            started_boottime_us: TEST_OPERATION_STARTED_US,
            sampled_at: "2026-09-09T10:34:57.253Z".to_string(),
            kernel_cursor: None,
            kernel_status,
            groups: test_memory_groups(),
            incidents: vec![guest_contracts::oom_evidence::OomIncident {
                id: "1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e:1".to_string(),
                captured_at: "2026-09-09T10:34:57.253Z".to_string(),
                reason: guest_contracts::oom_evidence::CaptureReason::Cleanup,
                after_observation: true,
                before_cleanup: true,
                kernel_status,
                kernel_events,
                groups: test_memory_groups(),
            }],
            dropped_incidents: 0,
        }
    }

    fn sigkill_process_exit() -> sandbox::ProcessExit {
        // Production observes the launcher's 137 exit translation, not a
        // signal field, so the exit shape here matches the recorded incident.
        sandbox::ProcessExit::new(42, EXIT_SIGKILL, Vec::new(), Vec::new())
    }

    #[test]
    fn user_visible_oom_failure_follows_the_shared_agent_domain_predicate() {
        // Attribution itself is owned and tested by `guest-contracts`; this
        // pins the user-facing failure to that predicate's verdict.
        let agent_domain = test_oom_evidence(
            guest_contracts::oom_evidence::EvidenceStatus::Available,
            vec![test_kernel_event(
                TEST_WORKLOAD_CGROUP,
                TEST_OPERATION_STARTED_US,
            )],
        );
        // A reclaimed shell tool is the ordinary case in production and must
        // keep the run's original terminal outcome.
        let tool_leaf = test_oom_evidence(
            guest_contracts::oom_evidence::EvidenceStatus::Available,
            vec![test_kernel_event(
                &format!("{TEST_WORKLOAD_CGROUP}/tools/tool-281-10-3-1"),
                TEST_OPERATION_STARTED_US + 10,
            )],
        );

        assert!(agent_domain.agent_domain_oom_kill());
        assert!(guest_memory_oom_killed_agent(
            agent_domain.agent_domain_oom_kill(),
            &sigkill_process_exit(),
            None,
        ));
        assert!(!tool_leaf.agent_domain_oom_kill());
        assert!(!guest_memory_oom_killed_agent(
            tool_leaf.agent_domain_oom_kill(),
            &sigkill_process_exit(),
            None,
        ));
    }

    #[test]
    fn guest_memory_oom_attribution_requires_a_kill_shaped_exit() {
        assert!(guest_memory_oom_killed_agent(
            true,
            &sigkill_process_exit(),
            None
        ));
        assert!(!guest_memory_oom_killed_agent(
            true,
            &nonzero_process_exit(),
            None,
        ));
        assert!(!guest_memory_oom_killed_agent(
            false,
            &sigkill_process_exit(),
            None,
        ));
        assert!(!guest_memory_oom_killed_agent(
            true,
            &sandbox::ProcessExit {
                termination: ExecTermination::TimedOut,
                ..sigkill_process_exit()
            },
            None,
        ));
    }

    #[test]
    fn oom_killed_agent_reports_the_termination_reason_over_captured_stderr() {
        let error = agent_failure_error(
            true,
            "{\"type\":\"pi_preparation_timing\",\"phase\":\"model_runtime\"} Killed".to_string(),
            Some("guest error file".to_string()),
            EXIT_SIGKILL,
        );

        assert_eq!(error, GUEST_MEMORY_OOM_KILLED_ERROR);
        assert!(!error.contains("pi_preparation_timing"));
    }

    #[test]
    fn ordinary_failures_keep_their_existing_error_selection() {
        assert_eq!(
            agent_failure_error(false, "boom".to_string(), None, 1),
            "boom"
        );
        assert_eq!(
            agent_failure_error(
                false,
                String::new(),
                Some("guest error file".to_string()),
                1
            ),
            "guest error file"
        );
        assert_eq!(
            agent_failure_error(false, String::new(), None, EXIT_SIGKILL),
            agent_exit_failure_message(EXIT_SIGKILL)
        );
    }

    #[test]
    fn heartbeat_control_failures_reject_sandbox_reuse() {
        for reason in [
            CliTerminationReason::HeartbeatError,
            CliTerminationReason::HeartbeatPanic,
        ] {
            let failure = control_path_failure(reason);
            let disposition = sandbox_reuse_disposition_for_process_exit(
                &nonzero_process_exit(),
                CancellationDisposition::None,
                Some(&failure),
            );

            assert_eq!(
                disposition,
                SandboxReuseDisposition::Ineligible(SandboxReuseRejection::ControlPathFailure)
            );
            assert_eq!(disposition.as_str(), "control_path_failure");
            assert_eq!(
                disposition.telemetry_action(),
                "runner_terminal_sandbox_reuse_rejected_control_path_failure"
            );
        }
    }

    #[test]
    fn ordinary_nonzero_exit_remains_reusable() {
        let failure = ExecutionFailure::new(1, "ordinary failure", None);

        assert_eq!(
            sandbox_reuse_disposition_for_process_exit(
                &nonzero_process_exit(),
                CancellationDisposition::None,
                Some(&failure),
            ),
            SandboxReuseDisposition::Eligible(SandboxReuseTerminal::NonzeroExit)
        );
    }

    #[test]
    fn codex_state_backfill_timeout_rejects_sandbox_reuse() {
        let failure = ExecutionFailure::new(
            1,
            "execution: codex app-server child exited while waiting for initialize: exit status: 1; stderr tail: Error: failed to initialize sqlite state runtime under /home/user/.codex: timed out waiting for state db backfill at /home/user/.codex after 30s (status: running)",
            None,
        );

        let disposition = sandbox_reuse_disposition_for_process_exit(
            &nonzero_process_exit(),
            CancellationDisposition::None,
            Some(&failure),
        );
        assert_eq!(
            disposition,
            SandboxReuseDisposition::Ineligible(SandboxReuseRejection::CodexStateBackfillTimeout)
        );
        assert_eq!(disposition.as_str(), "codex_state_backfill_timeout");
    }

    #[test]
    fn unrelated_initialize_and_backfill_errors_remain_reusable() {
        for error in [
            "execution: codex app-server child exited while waiting for initialize: exit status: 1; stderr tail: provider unavailable",
            "execution: another child exited; stderr tail: timed out waiting for state db backfill",
        ] {
            let failure = ExecutionFailure::new(1, error, None);
            assert_eq!(
                sandbox_reuse_disposition_for_process_exit(
                    &nonzero_process_exit(),
                    CancellationDisposition::None,
                    Some(&failure),
                ),
                SandboxReuseDisposition::Eligible(SandboxReuseTerminal::NonzeroExit)
            );
        }
    }

    #[test]
    fn hard_cancellation_and_resource_failure_precede_control_path_rejection() {
        let failure = control_path_failure(CliTerminationReason::HeartbeatError);
        assert_eq!(
            sandbox_reuse_disposition_for_process_exit(
                &nonzero_process_exit(),
                CancellationDisposition::HardFallback,
                Some(&failure),
            ),
            SandboxReuseDisposition::Ineligible(SandboxReuseRejection::HardCancellation)
        );

        let failure =
            failure.with_resource_diagnostics(Some(ResourceFailureDiagnostics::from_failure_kind(
                ResourceFailureKind::GuestMemoryOomKilled,
            )));
        assert_eq!(
            sandbox_reuse_disposition_for_process_exit(
                &nonzero_process_exit(),
                CancellationDisposition::None,
                Some(&failure),
            ),
            SandboxReuseDisposition::Ineligible(SandboxReuseRejection::ResourceFailure)
        );
    }

    fn exec_arg_aggregate_bytes(value: &str) -> usize {
        value.len() + 1
    }

    fn env_pairs_for_aggregate_bytes(target_bytes: usize) -> Vec<(String, String)> {
        let mut pairs: Vec<(String, String)> = Vec::new();
        let mut remaining = target_bytes;
        let mut index = 0;

        while remaining > 0 {
            let key = format!("TEST_FILL_{index}");
            let overhead = key.len() + 2;
            if remaining <= overhead {
                pairs
                    .last_mut()
                    .expect("aggregate target must require at least one env pair")
                    .1
                    .push_str(&"x".repeat(remaining));
                break;
            }

            let value_len = (64 * 1024).min(remaining - overhead);
            pairs.push((key, "x".repeat(value_len)));
            remaining -= overhead + value_len;
            index += 1;
        }

        pairs
    }

    #[test]
    fn bootstrap_exec_boundary_rejects_oversized_env_value_without_value_leak() {
        let secret = "x".repeat(guest_contracts::exec_limits::EXECVE_STRING_MAX_BYTES + 1);
        let env_pairs = vec![("TEST_OVERSIZED".to_string(), secret.clone())];

        let error = validate_agent_bootstrap_exec_boundary(&env_pairs)
            .unwrap_err()
            .to_string();

        assert!(error.contains("guest-agent bootstrap argv/env too large"));
        assert!(error.contains("TEST_OVERSIZED"));
        assert!(!error.contains(&secret));
    }

    #[test]
    fn bootstrap_exec_boundary_rejects_aggregate_overflow() {
        let value = "x".repeat(guest_contracts::exec_limits::EXECVE_STRING_MAX_BYTES - 16);
        let env_pairs: Vec<(String, String)> = (0..20)
            .map(|index| (format!("TEST_CHUNK_{index}"), value.clone()))
            .collect();

        let error = validate_agent_bootstrap_exec_boundary(&env_pairs)
            .unwrap_err()
            .to_string();

        assert!(error.contains("argv/env aggregate too large"));
    }

    #[test]
    fn bootstrap_exec_boundary_counts_fixed_agent_executable_arg() {
        let executable_arg_bytes = exec_arg_aggregate_bytes(AGENT_PATH);
        let env_pairs = env_pairs_for_aggregate_bytes(
            guest_contracts::exec_limits::EXECVE_ARG_ENV_MAX_BYTES + 1 - executable_arg_bytes,
        );

        let error = validate_agent_bootstrap_exec_boundary(&env_pairs)
            .unwrap_err()
            .to_string();

        assert!(error.contains("argv/env aggregate too large"));
    }
}
