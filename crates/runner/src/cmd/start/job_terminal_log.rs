//! Claimed job terminal outcome logging.
//!
//! This module owns the terminal tracing event, diagnostic field projection,
//! and failure severity policy. The job spawn module owns when the event is
//! emitted relative to executor completion and sandbox finalization.

use guest_contracts::diagnostics::{
    CliObservedExitDiagnostic, CliObservedExitKind, CliTerminationDiagnostic,
    EventDeliveryDiagnostic, FailureClass, FailureDiagnostic, FailureReason,
    HeartbeatFailureDiagnostic, WorkloadResourceLimitDiagnostic,
};
use tracing::info;

use crate::executor::{self, ExecutionFailureKind};
use crate::ids::RunId;

pub(super) fn log_terminal_job_outcome(
    run_id: RunId,
    exit_code: i32,
    reused: bool,
    cancelled: bool,
    failure: Option<&executor::ExecutionFailure>,
) {
    // Single sink for any claimed job's terminal state. Cancellation gets
    // its own info marker; every other failure is represented by a single
    // object carrying the exit code, error, and optional guest-authored diagnostic.
    match (cancelled, failure) {
        (true, _) => info!(run_id = %run_id, exit_code, reused, "job cancelled"),
        (false, Some(failure)) => {
            log_job_execution_failed(run_id, exit_code, reused, failure);
        }
        (false, None) => info!(run_id = %run_id, exit_code, reused, "job finished"),
    }
}

fn log_job_execution_failed(
    run_id: RunId,
    exit_code: i32,
    reused: bool,
    failure: &executor::ExecutionFailure,
) {
    let diagnostic = failure.diagnostic.as_ref();
    let cli_termination_fields = JobCliTerminationLogFields::from(
        diagnostic.and_then(|diagnostic| diagnostic.cli_termination.as_ref()),
    );
    let cli_observed_exit_fields = JobCliObservedExitLogFields::from(
        diagnostic.and_then(|diagnostic| diagnostic.cli_observed_exit.as_ref()),
    );
    let event_delivery_fields = JobEventDeliveryLogFields::from(
        diagnostic.and_then(|diagnostic| diagnostic.event_delivery.as_ref()),
    );
    let heartbeat_fields = JobHeartbeatLogFields::from(
        diagnostic.and_then(|diagnostic| diagnostic.heartbeat.as_ref()),
    );
    let workload_resource_fields = JobWorkloadResourceLogFields::from(
        diagnostic.and_then(|diagnostic| diagnostic.workload_resource_limit.as_ref()),
    );
    let resource_fields = JobResourceLogFields::from(failure.resource_diagnostics);
    let (timeout_ms, elapsed_ms, guest_duration_ms) = match failure.kind {
        ExecutionFailureKind::Generic => (None, None, None),
        ExecutionFailureKind::RunnerJobTimeout {
            timeout_ms,
            elapsed_ms,
            guest_duration_ms,
        } => (Some(timeout_ms), Some(elapsed_ms), guest_duration_ms),
    };

    macro_rules! emit_job_execution_failed {
        ($level:expr, $message:literal) => {
            tracing::event!(
                $level,
                run_id = %run_id,
                exit_code,
                reused,
                error = %failure.error,
                error_tail = crate::axiom_layer::error_tail(&failure.error),
                timeout_ms,
                elapsed_ms,
                guest_duration_ms,
                failure_class = diagnostic.map(|diagnostic| diagnostic.failure_class.as_str()),
                failure_framework = diagnostic.map(|diagnostic| diagnostic.framework.as_str()),
                failure_cli_exit_code =
                    diagnostic.and_then(|diagnostic| diagnostic.cli_exit_code),
                failure_claude_num_turns =
                    diagnostic.and_then(|diagnostic| diagnostic.claude_num_turns),
                failure_detail_source = diagnostic
                    .and_then(|diagnostic| diagnostic.failure_detail_source)
                    .map(|source| source.as_str()),
                failure_reason = diagnostic
                    .and_then(|diagnostic| diagnostic.failure_reason)
                    .map(|reason| reason.as_str()),
                model_http_status = diagnostic.and_then(|diagnostic| diagnostic.model_request)
                    .and_then(|request| request.http_status),
                model_transport_attempts = diagnostic.and_then(|diagnostic| diagnostic.model_request)
                    .map(|request| request.transport_attempts),
                model_retry_attempts = diagnostic.and_then(|diagnostic| diagnostic.model_request)
                    .map(|request| request.retry_attempts),
                model_retry_limit = diagnostic.and_then(|diagnostic| diagnostic.model_request)
                    .and_then(|request| request.retry_limit),
                cli_termination_initiator = cli_termination_fields.initiator,
                cli_termination_reason = cli_termination_fields.reason,
                cli_termination_signal_sent = cli_termination_fields.signal_sent,
                cli_termination_signal_pgid = cli_termination_fields.signal_pgid,
                cli_termination_signal_grace_ms = cli_termination_fields.signal_grace_ms,
                cli_termination_escalated = cli_termination_fields.escalated,
                cli_termination_observed_exit_code = cli_termination_fields.observed_exit_code,
                cli_observed_exit_kind = cli_observed_exit_fields.kind,
                cli_observed_exit_code = cli_observed_exit_fields.exit_code,
                cli_observed_signal_number = cli_observed_exit_fields.signal_number,
                cli_observed_signal_name = cli_observed_exit_fields.signal_name,
                cli_observed_mapped_exit_code = cli_observed_exit_fields.mapped_exit_code,
                session_history_status =
                    diagnostic.map(|diagnostic| diagnostic.session_history_status.as_str()),
                prompt_shape = diagnostic.map(|diagnostic| diagnostic.prompt_shape.as_str()),
                prompt_bytes = diagnostic.map(|diagnostic| diagnostic.prompt_bytes),
                first_line_bytes = diagnostic.map(|diagnostic| diagnostic.first_line_bytes),
                event_delivery_total_events = event_delivery_fields.total_events,
                event_delivery_total_batches = event_delivery_fields.total_batches,
                event_delivery_failed_batches = event_delivery_fields.failed_batches,
                event_delivery_last_acknowledged_sequence =
                    event_delivery_fields.last_acknowledged_sequence,
                event_delivery_first_failure_first_sequence =
                    event_delivery_fields.first_failure_first_sequence,
                event_delivery_first_failure_last_sequence =
                    event_delivery_fields.first_failure_last_sequence,
                event_delivery_first_failure_event_count =
                    event_delivery_fields.first_failure_event_count,
                event_delivery_first_failure_conservative_bytes =
                    event_delivery_fields.first_failure_conservative_bytes,
                event_delivery_first_failure_outcome =
                    event_delivery_fields.first_failure_outcome,
                event_delivery_first_failure_attempt_count =
                    event_delivery_fields.first_failure_attempt_count,
                event_delivery_first_failure_final_attempt_number =
                    event_delivery_fields.first_failure_final_attempt_number,
                event_delivery_first_failure_final_attempt_kind =
                    event_delivery_fields.first_failure_final_attempt_kind,
                event_delivery_first_failure_final_attempt_timeout_observed =
                    event_delivery_fields.first_failure_final_attempt_timeout_observed,
                event_delivery_first_failure_final_attempt_connect_observed =
                    event_delivery_fields.first_failure_final_attempt_connect_observed,
                event_delivery_first_failure_final_attempt_http_status =
                    event_delivery_fields.first_failure_final_attempt_http_status,
                event_delivery_first_failure_final_attempt_request_id =
                    event_delivery_fields.first_failure_final_attempt_request_id,
                event_delivery_first_failure_final_attempt_elapsed_ms =
                    event_delivery_fields.first_failure_final_attempt_elapsed_ms,
                event_delivery_drain_timeout = event_delivery_fields.drain_timeout,
                event_delivery_drain_queued_events =
                    event_delivery_fields.drain_queued_events,
                event_delivery_drain_queued_bytes = event_delivery_fields.drain_queued_bytes,
                event_delivery_drain_carried_events =
                    event_delivery_fields.drain_carried_events,
                event_delivery_drain_carried_bytes =
                    event_delivery_fields.drain_carried_bytes,
                event_delivery_drain_active_first_sequence =
                    event_delivery_fields.drain_active_first_sequence,
                event_delivery_drain_active_last_sequence =
                    event_delivery_fields.drain_active_last_sequence,
                event_delivery_drain_active_event_count =
                    event_delivery_fields.drain_active_event_count,
                event_delivery_drain_active_conservative_bytes =
                    event_delivery_fields.drain_active_conservative_bytes,
                event_delivery_drain_active_completed_attempt_count =
                    event_delivery_fields.drain_active_completed_attempt_count,
                event_delivery_drain_active_attempt_number =
                    event_delivery_fields.drain_active_attempt_number,
                event_delivery_drain_active_attempt_request_id =
                    event_delivery_fields.drain_active_attempt_request_id,
                event_delivery_drain_active_attempt_elapsed_ms =
                    event_delivery_fields.drain_active_attempt_elapsed_ms,
                event_delivery_drain_active_outcome =
                    event_delivery_fields.drain_active_outcome,
                heartbeat_failed_cycle_count = heartbeat_fields.failed_cycle_count,
                heartbeat_attempt_count = heartbeat_fields.attempt_count,
                heartbeat_final_scheduled_lag_ms = heartbeat_fields.final_scheduled_lag_ms,
                heartbeat_final_attempt_number = heartbeat_fields.final_attempt_number,
                heartbeat_final_attempt_kind = heartbeat_fields.final_attempt_kind,
                heartbeat_final_attempt_timeout_observed =
                    heartbeat_fields.final_attempt_timeout_observed,
                heartbeat_final_attempt_connect_observed =
                    heartbeat_fields.final_attempt_connect_observed,
                heartbeat_final_attempt_http_status = heartbeat_fields.final_attempt_http_status,
                heartbeat_final_attempt_request_id = heartbeat_fields.final_attempt_request_id,
                heartbeat_final_attempt_elapsed_ms = heartbeat_fields.final_attempt_elapsed_ms,
                workload_memory_max_events = workload_resource_fields.memory_max_events,
                workload_memory_oom_events = workload_resource_fields.memory_oom_events,
                workload_memory_oom_kill_events =
                    workload_resource_fields.memory_oom_kill_events,
                workload_memory_oom_group_kill_events =
                    workload_resource_fields.memory_oom_group_kill_events,
                workload_pids_max_events = workload_resource_fields.pids_max_events,
                resource_failure_kind = resource_fields.resource_failure_kind,
                guest_root_fs_used_percent = resource_fields.guest_root_fs_used_percent,
                guest_root_fs_available_kb = resource_fields.guest_root_fs_available_kb,
                guest_root_fs_inode_used_percent =
                    resource_fields.guest_root_fs_inode_used_percent,
                guest_root_fs_available_inodes = resource_fields.guest_root_fs_available_inodes,
                guest_workspace_fs_used_percent = resource_fields.guest_workspace_fs_used_percent,
                guest_memory_available_mb = resource_fields.guest_memory_available_mb,
                $message
            )
        };
    }

    match failure.kind {
        ExecutionFailureKind::RunnerJobTimeout { .. } => {
            emit_job_execution_failed!(
                tracing::Level::INFO,
                "runner job reached execution time limit"
            );
        }
        ExecutionFailureKind::Generic if diagnostic.is_some_and(is_info_level_job_failure) => {
            emit_job_execution_failed!(tracing::Level::INFO, "job execution failed");
        }
        ExecutionFailureKind::Generic => {
            emit_job_execution_failed!(tracing::Level::ERROR, "job execution failed");
        }
    }
}

struct JobResourceLogFields {
    resource_failure_kind: Option<&'static str>,
    guest_root_fs_used_percent: Option<u64>,
    guest_root_fs_available_kb: Option<u64>,
    guest_root_fs_inode_used_percent: Option<u64>,
    guest_root_fs_available_inodes: Option<u64>,
    guest_workspace_fs_used_percent: Option<u64>,
    guest_memory_available_mb: Option<u64>,
}

struct JobWorkloadResourceLogFields {
    memory_max_events: Option<u64>,
    memory_oom_events: Option<u64>,
    memory_oom_kill_events: Option<u64>,
    memory_oom_group_kill_events: Option<u64>,
    pids_max_events: Option<u64>,
}

struct JobCliTerminationLogFields {
    initiator: Option<&'static str>,
    reason: Option<&'static str>,
    signal_sent: Option<&'static str>,
    signal_pgid: Option<i32>,
    signal_grace_ms: Option<u64>,
    escalated: Option<bool>,
    observed_exit_code: Option<i32>,
}

struct JobCliObservedExitLogFields {
    kind: Option<&'static str>,
    exit_code: Option<i32>,
    signal_number: Option<i32>,
    signal_name: Option<&'static str>,
    mapped_exit_code: Option<i32>,
}

struct JobEventDeliveryLogFields<'a> {
    total_events: Option<u64>,
    total_batches: Option<u64>,
    failed_batches: Option<u64>,
    last_acknowledged_sequence: Option<u32>,
    first_failure_first_sequence: Option<u32>,
    first_failure_last_sequence: Option<u32>,
    first_failure_event_count: Option<u32>,
    first_failure_conservative_bytes: Option<u64>,
    first_failure_outcome: Option<&'static str>,
    first_failure_attempt_count: Option<u64>,
    first_failure_final_attempt_number: Option<u32>,
    first_failure_final_attempt_kind: Option<&'static str>,
    first_failure_final_attempt_timeout_observed: Option<bool>,
    first_failure_final_attempt_connect_observed: Option<bool>,
    first_failure_final_attempt_http_status: Option<u16>,
    first_failure_final_attempt_request_id: Option<&'a str>,
    first_failure_final_attempt_elapsed_ms: Option<u64>,
    drain_timeout: Option<bool>,
    drain_queued_events: Option<u32>,
    drain_queued_bytes: Option<u64>,
    drain_carried_events: Option<u32>,
    drain_carried_bytes: Option<u64>,
    drain_active_first_sequence: Option<u32>,
    drain_active_last_sequence: Option<u32>,
    drain_active_event_count: Option<u32>,
    drain_active_conservative_bytes: Option<u64>,
    drain_active_completed_attempt_count: Option<u64>,
    drain_active_attempt_number: Option<u32>,
    drain_active_attempt_request_id: Option<&'a str>,
    drain_active_attempt_elapsed_ms: Option<u64>,
    drain_active_outcome: Option<&'static str>,
}

struct JobHeartbeatLogFields<'a> {
    failed_cycle_count: Option<u64>,
    attempt_count: Option<u64>,
    final_scheduled_lag_ms: Option<u64>,
    final_attempt_number: Option<u32>,
    final_attempt_kind: Option<&'static str>,
    final_attempt_timeout_observed: Option<bool>,
    final_attempt_connect_observed: Option<bool>,
    final_attempt_http_status: Option<u16>,
    final_attempt_request_id: Option<&'a str>,
    final_attempt_elapsed_ms: Option<u64>,
}

impl From<Option<&CliTerminationDiagnostic>> for JobCliTerminationLogFields {
    fn from(diagnostic: Option<&CliTerminationDiagnostic>) -> Self {
        Self {
            initiator: diagnostic.map(|diagnostic| diagnostic.initiator.as_str()),
            reason: diagnostic.map(|diagnostic| diagnostic.reason.as_str()),
            signal_sent: diagnostic
                .and_then(|diagnostic| diagnostic.signal_sent.map(|signal| signal.as_str())),
            signal_pgid: diagnostic.and_then(|diagnostic| diagnostic.signal_pgid),
            signal_grace_ms: diagnostic.and_then(|diagnostic| diagnostic.signal_grace_ms),
            escalated: diagnostic.map(|diagnostic| diagnostic.escalated),
            observed_exit_code: diagnostic.and_then(|diagnostic| diagnostic.observed_exit_code),
        }
    }
}

impl From<Option<&CliObservedExitDiagnostic>> for JobCliObservedExitLogFields {
    fn from(diagnostic: Option<&CliObservedExitDiagnostic>) -> Self {
        let is_exit =
            diagnostic.is_some_and(|diagnostic| diagnostic.kind == CliObservedExitKind::Exit);
        let is_signal =
            diagnostic.is_some_and(|diagnostic| diagnostic.kind == CliObservedExitKind::Signal);
        Self {
            kind: diagnostic.map(|diagnostic| diagnostic.kind.as_str()),
            exit_code: is_exit
                .then(|| diagnostic.and_then(|diagnostic| diagnostic.exit_code))
                .flatten(),
            signal_number: is_signal
                .then(|| diagnostic.and_then(|diagnostic| diagnostic.signal_number))
                .flatten(),
            signal_name: is_signal
                .then(|| diagnostic.and_then(CliObservedExitDiagnostic::known_signal_name))
                .flatten(),
            mapped_exit_code: diagnostic.map(|diagnostic| diagnostic.mapped_exit_code),
        }
    }
}

impl<'a> From<Option<&'a EventDeliveryDiagnostic>> for JobEventDeliveryLogFields<'a> {
    fn from(diagnostic: Option<&'a EventDeliveryDiagnostic>) -> Self {
        let first_failure =
            diagnostic.and_then(|diagnostic| diagnostic.first_failed_batch.as_ref());
        let first_failure_final_attempt = first_failure.and_then(|failure| failure.attempts.last());
        let drain = diagnostic.and_then(|diagnostic| diagnostic.drain_timeout.as_ref());
        let drain_active = drain.and_then(|drain| drain.active_batch.as_ref());
        let drain_active_attempt = drain_active.and_then(|active| active.active_attempt.as_ref());

        Self {
            total_events: diagnostic.map(|diagnostic| diagnostic.total_events),
            total_batches: diagnostic.map(|diagnostic| diagnostic.total_batches),
            failed_batches: diagnostic.map(|diagnostic| diagnostic.failed_batches),
            last_acknowledged_sequence: diagnostic
                .and_then(|diagnostic| diagnostic.last_acknowledged_sequence),
            first_failure_first_sequence: first_failure.map(|failure| failure.first_sequence),
            first_failure_last_sequence: first_failure.map(|failure| failure.last_sequence),
            first_failure_event_count: first_failure.map(|failure| failure.event_count),
            first_failure_conservative_bytes: first_failure
                .map(|failure| failure.conservative_bytes),
            first_failure_outcome: first_failure.map(|failure| failure.outcome.as_str()),
            first_failure_attempt_count: first_failure
                .map(|failure| u64::try_from(failure.attempts.len()).unwrap_or(u64::MAX)),
            first_failure_final_attempt_number: first_failure_final_attempt
                .map(|attempt| attempt.attempt),
            first_failure_final_attempt_kind: first_failure_final_attempt
                .map(|attempt| attempt.failure_kind.as_str()),
            first_failure_final_attempt_timeout_observed: first_failure_final_attempt
                .and_then(|attempt| attempt.timeout_observed),
            first_failure_final_attempt_connect_observed: first_failure_final_attempt
                .and_then(|attempt| attempt.connect_observed),
            first_failure_final_attempt_http_status: first_failure_final_attempt
                .and_then(|attempt| attempt.http_status),
            first_failure_final_attempt_request_id: first_failure_final_attempt
                .map(|attempt| attempt.client_request_id.as_str()),
            first_failure_final_attempt_elapsed_ms: first_failure_final_attempt
                .map(|attempt| attempt.elapsed_ms),
            drain_timeout: drain.map(|_| true),
            drain_queued_events: drain.map(|drain| drain.queued_events),
            drain_queued_bytes: drain.map(|drain| drain.queued_bytes),
            drain_carried_events: drain.map(|drain| drain.carried_events),
            drain_carried_bytes: drain.map(|drain| drain.carried_bytes),
            drain_active_first_sequence: drain_active.map(|active| active.first_sequence),
            drain_active_last_sequence: drain_active.map(|active| active.last_sequence),
            drain_active_event_count: drain_active.map(|active| active.event_count),
            drain_active_conservative_bytes: drain_active.map(|active| active.conservative_bytes),
            drain_active_completed_attempt_count: drain_active
                .map(|active| u64::try_from(active.completed_attempts.len()).unwrap_or(u64::MAX)),
            drain_active_attempt_number: drain_active_attempt.map(|attempt| attempt.attempt),
            drain_active_attempt_request_id: drain_active_attempt
                .map(|attempt| attempt.client_request_id.as_str()),
            drain_active_attempt_elapsed_ms: drain_active_attempt.map(|attempt| attempt.elapsed_ms),
            drain_active_outcome: drain_active.map(|active| active.outcome.as_str()),
        }
    }
}

impl<'a> From<Option<&'a HeartbeatFailureDiagnostic>> for JobHeartbeatLogFields<'a> {
    fn from(diagnostic: Option<&'a HeartbeatFailureDiagnostic>) -> Self {
        let final_cycle = diagnostic.and_then(|diagnostic| diagnostic.failed_cycles.last());
        let final_attempt = final_cycle.and_then(|cycle| cycle.attempts.last());
        Self {
            failed_cycle_count: diagnostic.map(|diagnostic| {
                u64::try_from(diagnostic.failed_cycles.len()).unwrap_or(u64::MAX)
            }),
            attempt_count: diagnostic.map(|diagnostic| {
                diagnostic
                    .failed_cycles
                    .iter()
                    .map(|cycle| u64::try_from(cycle.attempts.len()).unwrap_or(u64::MAX))
                    .fold(0_u64, u64::saturating_add)
            }),
            final_scheduled_lag_ms: final_cycle.map(|cycle| cycle.scheduled_lag_ms),
            final_attempt_number: final_attempt.map(|attempt| attempt.attempt),
            final_attempt_kind: final_attempt.map(|attempt| attempt.failure_kind.as_str()),
            final_attempt_timeout_observed: final_attempt
                .and_then(|attempt| attempt.timeout_observed),
            final_attempt_connect_observed: final_attempt
                .and_then(|attempt| attempt.connect_observed),
            final_attempt_http_status: final_attempt.and_then(|attempt| attempt.http_status),
            final_attempt_request_id: final_attempt
                .map(|attempt| attempt.client_request_id.as_str()),
            final_attempt_elapsed_ms: final_attempt.map(|attempt| attempt.elapsed_ms),
        }
    }
}

impl From<Option<executor::ResourceFailureDiagnostics>> for JobResourceLogFields {
    fn from(diagnostics: Option<executor::ResourceFailureDiagnostics>) -> Self {
        Self {
            resource_failure_kind: diagnostics
                .and_then(|diagnostics| diagnostics.failure_kind)
                .map(executor::ResourceFailureKind::as_str),
            guest_root_fs_used_percent: diagnostics
                .and_then(|diagnostics| diagnostics.guest_root_fs_used_percent)
                .map(u64::from),
            guest_root_fs_available_kb: diagnostics
                .and_then(|diagnostics| diagnostics.guest_root_fs_available_kb),
            guest_root_fs_inode_used_percent: diagnostics
                .and_then(|diagnostics| diagnostics.guest_root_fs_inode_used_percent)
                .map(u64::from),
            guest_root_fs_available_inodes: diagnostics
                .and_then(|diagnostics| diagnostics.guest_root_fs_available_inodes),
            guest_workspace_fs_used_percent: diagnostics
                .and_then(|diagnostics| diagnostics.guest_workspace_fs_used_percent)
                .map(u64::from),
            guest_memory_available_mb: diagnostics
                .and_then(|diagnostics| diagnostics.guest_memory_available_mb),
        }
    }
}

impl From<Option<&WorkloadResourceLimitDiagnostic>> for JobWorkloadResourceLogFields {
    fn from(diagnostic: Option<&WorkloadResourceLimitDiagnostic>) -> Self {
        Self {
            memory_max_events: diagnostic.map(|diagnostic| diagnostic.memory_max_events),
            memory_oom_events: diagnostic.map(|diagnostic| diagnostic.memory_oom_events),
            memory_oom_kill_events: diagnostic.map(|diagnostic| diagnostic.memory_oom_kill_events),
            memory_oom_group_kill_events: diagnostic
                .map(|diagnostic| diagnostic.memory_oom_group_kill_events),
            pids_max_events: diagnostic.map(|diagnostic| diagnostic.pids_max_events),
        }
    }
}

fn is_info_level_job_failure(diagnostic: &FailureDiagnostic) -> bool {
    match diagnostic.failure_class {
        FailureClass::CliExecutionError => {
            diagnostic.failure_reason == Some(FailureReason::InputTooLarge)
        }
        FailureClass::CliNonzero => matches!(
            diagnostic.failure_reason,
            Some(
                FailureReason::InsufficientCredits
                    | FailureReason::ProviderInsufficientCredits
                    | FailureReason::InvalidApiKey
                    | FailureReason::InvalidCredentials
                    | FailureReason::TermsAcceptanceRequired
                    | FailureReason::ContextWindowExceeded
                    | FailureReason::OutputTokenLimit
                    | FailureReason::ProviderRateLimited
                    | FailureReason::ProviderOverloaded
                    | FailureReason::ProviderStreamTimeout
                    | FailureReason::ProviderServerError
                    | FailureReason::ResponseConnectionLost
                    | FailureReason::SafetyPolicyRefusal
                    | FailureReason::ReconnectRequired
                    | FailureReason::UnsupportedModel
                    | FailureReason::UsageLimit
            )
        ),
        FailureClass::ClaudeZeroTurnNoHistory => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    use guest_contracts::diagnostics::{
        AgentFramework, CliObservedExitKind, CliTerminationDiagnostic, CliTerminationReason,
        CliTerminationSignal, EventDeliveryAcceptanceOutcome, EventDeliveryActiveAttemptDiagnostic,
        EventDeliveryActiveBatchDiagnostic, EventDeliveryDiagnostic,
        EventDeliveryDrainTimeoutDiagnostic, EventDeliveryFailedBatchDiagnostic, FailureClass,
        FailureDetailSource, HeartbeatFailedCycleDiagnostic, HeartbeatFailureDiagnostic,
        HttpAttemptFailureKind, HttpCompletedAttemptDiagnostic, PromptMetadata,
        SessionHistoryStatus, WorkloadResourceLimitDiagnostic,
    };
    use tracing::Level;
    use tracing_subscriber::prelude::*;
    use tracing_test_support::{CapturedEvent, CapturedEvents};

    fn job_failure_diagnostic(failure_reason: Option<FailureReason>) -> FailureDiagnostic {
        let mut diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::Codex,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_cli_exit_code(1)
        .with_failure_detail_source(FailureDetailSource::CodexJsonl)
        .with_session_history_status(SessionHistoryStatus::NotApplicable);
        if let Some(reason) = failure_reason {
            diagnostic = diagnostic.with_failure_reason(reason);
        }
        diagnostic
    }

    #[test]
    fn pi_memory_phase2_terminal_diagnostics_remain_actionable() {
        let fixtures: Vec<serde_json::Value> = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/pi-memory-phase2-terminal.json"
        )))
        .unwrap();
        for fixture in fixtures {
            let message = fixture["stderr"].as_str().unwrap();
            let diagnostic = FailureDiagnostic::new(
                FailureClass::CliNonzero,
                AgentFramework::Pi,
                PromptMetadata::from_prompt(""),
            )
            .with_cli_exit_code(1)
            .with_failure_detail_source(FailureDetailSource::Stderr);
            let wire = serde_json::to_vec(&diagnostic).unwrap();
            let decoded: FailureDiagnostic = serde_json::from_slice(&wire).unwrap();
            let failure = executor::ExecutionFailure::new(1, message, Some(decoded));
            let event = capture_job_failure_log(&failure);
            assert_eq!(event.level, Level::ERROR);
            assert_field_eq(&event, "message", "job execution failed");
            assert_field_eq(&event, "error", message);
            assert_field_eq(&event, "failure_framework", "pi");
            assert_field_eq(&event, "failure_class", "cli_nonzero");
            assert_field_eq(&event, "failure_detail_source", "stderr");
        }
    }

    fn post_result_cli_termination() -> CliTerminationDiagnostic {
        CliTerminationDiagnostic::new(CliTerminationReason::PostResultReap)
            .record_signal(CliTerminationSignal::Sigterm, Some(1401), Some(10_000))
            .with_observed_exit_code(143)
    }

    fn capture_terminal_job_log(
        exit_code: i32,
        reused: bool,
        cancelled: bool,
        failure: Option<&executor::ExecutionFailure>,
    ) -> CapturedEvent {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        tracing::subscriber::with_default(subscriber, || {
            log_terminal_job_outcome(RunId::nil(), exit_code, reused, cancelled, failure);
        });
        let events = captured.entries();
        assert_eq!(events.len(), 1, "captured events: {events:#?}");
        events[0].clone()
    }

    fn capture_job_failure_log(failure: &executor::ExecutionFailure) -> CapturedEvent {
        capture_terminal_job_log(failure.exit_code, false, false, Some(failure))
    }

    fn assert_field_eq(event: &CapturedEvent, field: &str, expected: &str) {
        let value = event
            .fields
            .get(field)
            .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"));
        assert_eq!(value, expected, "field {field} mismatch; event={event:#?}");
    }

    fn assert_field_kind(event: &CapturedEvent, field: &str, expected: &str) {
        let kind = event
            .field_kinds
            .get(field)
            .unwrap_or_else(|| panic!("missing field kind {field}; event={event:#?}"));
        assert_eq!(
            kind, &expected,
            "field {field} kind mismatch; event={event:#?}"
        );
    }

    fn assert_shared_failure_log_fields(generic: &CapturedEvent, timeout: &CapturedEvent) {
        let mut generic_fields = generic.fields.clone();
        let mut timeout_fields = timeout.fields.clone();
        generic_fields.remove("message");
        timeout_fields.remove("message");

        let mut generic_field_kinds = generic.field_kinds.clone();
        let mut timeout_field_kinds = timeout.field_kinds.clone();
        generic_field_kinds.remove("message");
        timeout_field_kinds.remove("message");

        for timeout_field in ["timeout_ms", "elapsed_ms", "guest_duration_ms"] {
            assert!(!generic_fields.contains_key(timeout_field));
            assert!(!generic_field_kinds.contains_key(timeout_field));
            assert!(timeout_fields.remove(timeout_field).is_some());
            assert!(timeout_field_kinds.remove(timeout_field).is_some());
        }

        assert_eq!(generic_fields, timeout_fields);
        assert_eq!(generic_field_kinds, timeout_field_kinds);
    }

    #[test]
    fn terminal_failure_emits_a_bounded_causal_tail_only_for_long_errors() {
        let cause = "HTTP status 403 s3_code=ExpiredRequest";
        let error = format!("{}\n{cause}", "中".repeat(3000));
        let failure = executor::ExecutionFailure::new(1, &error, None);

        let event = capture_job_failure_log(&failure);

        assert_field_eq(&event, "message", "job execution failed");
        assert_field_eq(&event, "error", &error);
        assert_field_kind(&event, "error_tail", "str");
        let tail = event.fields.get("error_tail").expect("missing causal tail");
        assert!(tail.len() <= 4096);
        assert!(tail.ends_with(cause));
        assert!(error.ends_with(tail));

        for error in ["short failure".to_owned(), "x".repeat(4096)] {
            let failure = executor::ExecutionFailure::new(1, &error, None);
            let event = capture_job_failure_log(&failure);
            assert_field_eq(&event, "error", &error);
            assert!(!event.fields.contains_key("error_tail"));
        }
    }

    #[test]
    fn finished_and_cancelled_jobs_emit_one_terminal_event() {
        let finished = capture_terminal_job_log(0, true, false, None);

        assert_eq!(finished.level, Level::INFO);
        assert_eq!(
            finished.fields.get("message").map(String::as_str),
            Some("job finished")
        );
        assert_field_eq(&finished, "run_id", &RunId::nil().to_string());
        assert_field_eq(&finished, "exit_code", "0");
        assert_field_eq(&finished, "reused", "true");
        assert!(!finished.fields.contains_key("error"));

        let failure = executor::ExecutionFailure::new(1, "ignored failure", None);
        let cancelled = capture_terminal_job_log(130, false, true, Some(&failure));

        assert_eq!(cancelled.level, Level::INFO);
        assert_eq!(
            cancelled.fields.get("message").map(String::as_str),
            Some("job cancelled")
        );
        assert_field_eq(&cancelled, "run_id", &RunId::nil().to_string());
        assert_field_eq(&cancelled, "exit_code", "130");
        assert_field_eq(&cancelled, "reused", "false");
        assert!(!cancelled.fields.contains_key("error"));
    }

    #[test]
    fn expected_cli_failure_reasons_log_job_execution_failed_at_info() {
        for reason in [
            FailureReason::InsufficientCredits,
            FailureReason::ProviderInsufficientCredits,
            FailureReason::InvalidApiKey,
            FailureReason::InvalidCredentials,
            FailureReason::TermsAcceptanceRequired,
            FailureReason::ContextWindowExceeded,
            FailureReason::OutputTokenLimit,
            FailureReason::ProviderRateLimited,
            FailureReason::ProviderOverloaded,
            FailureReason::ProviderStreamTimeout,
            FailureReason::ProviderServerError,
            FailureReason::ResponseConnectionLost,
            FailureReason::SafetyPolicyRefusal,
            FailureReason::ReconnectRequired,
            FailureReason::UnsupportedModel,
            FailureReason::UsageLimit,
        ] {
            let diagnostic = job_failure_diagnostic(Some(reason));
            let failure_error = format!("classified failure: {}", reason.as_str());
            let failure =
                executor::ExecutionFailure::new(1, failure_error.clone(), Some(diagnostic));

            let event = capture_job_failure_log(&failure);

            assert_eq!(event.level, Level::INFO);
            assert_eq!(
                event.fields.get("message").map(String::as_str),
                Some("job execution failed")
            );
            assert_field_eq(&event, "error", &failure_error);
            assert_field_eq(&event, "run_id", &RunId::nil().to_string());
            assert_field_eq(&event, "exit_code", "1");
            assert_field_eq(&event, "failure_reason", reason.as_str());
            assert_field_eq(&event, "failure_class", "cli_nonzero");
            assert_field_eq(&event, "failure_framework", "codex");
            assert_field_eq(&event, "failure_detail_source", "codex_jsonl");
        }
    }

    #[test]
    fn codex_content_policy_rejection_logs_job_execution_failed_at_info() {
        const ENVELOPE: &str = r#"{"error":{"message":"Content Exists Risk","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}"#;
        let diagnostic = job_failure_diagnostic(Some(FailureReason::SafetyPolicyRefusal));
        let failure = executor::ExecutionFailure::new(1, ENVELOPE, Some(diagnostic));

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::INFO);
        assert_field_eq(&event, "error", ENVELOPE);
        assert_field_eq(&event, "failure_reason", "safety_policy_refusal");
        assert_field_eq(&event, "failure_framework", "codex");
        assert_field_eq(&event, "failure_class", "cli_nonzero");
        assert_field_eq(&event, "failure_detail_source", "codex_jsonl");
    }

    #[test]
    fn unclassified_codex_provider_envelope_stays_at_error() {
        let diagnostic = job_failure_diagnostic(None);
        let failure = executor::ExecutionFailure::new(
            1,
            r#"{"error":{"message":"Invalid Format","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}"#,
            Some(diagnostic),
        );

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::ERROR);
        assert!(!event.fields.contains_key("failure_reason"));
    }

    #[test]
    fn oversized_codex_input_logs_cli_execution_failure_at_info() {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliExecutionError,
            AgentFramework::Codex,
            PromptMetadata::from_prompt("oversized prompt"),
        )
        .with_failure_reason(FailureReason::InputTooLarge)
        .with_session_history_status(SessionHistoryStatus::NotApplicable);
        let failure = executor::ExecutionFailure::new(
            1,
            "Codex input exceeded the app-server limit",
            Some(diagnostic),
        );

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::INFO);
        assert_field_eq(&event, "failure_class", "cli_execution_error");
        assert_field_eq(&event, "failure_framework", "codex");
        assert_field_eq(&event, "failure_reason", "input_too_large");
        assert!(!event.fields.contains_key("failure_detail_source"));
    }

    #[test]
    fn oversized_input_near_misses_remain_error_level() {
        let diagnostics = [
            FailureDiagnostic::new(
                FailureClass::CliExecutionError,
                AgentFramework::Codex,
                PromptMetadata::from_prompt("plain prompt"),
            ),
            FailureDiagnostic::new(
                FailureClass::CliNonzero,
                AgentFramework::Codex,
                PromptMetadata::from_prompt("plain prompt"),
            )
            .with_failure_reason(FailureReason::InputTooLarge),
            FailureDiagnostic::new(
                FailureClass::CliExecutionError,
                AgentFramework::Codex,
                PromptMetadata::from_prompt("plain prompt"),
            )
            .with_failure_reason(FailureReason::ContextWindowExceeded),
        ];

        for diagnostic in diagnostics {
            let failure = executor::ExecutionFailure::new(
                1,
                "unclassified execution failure",
                Some(diagnostic),
            );
            let event = capture_job_failure_log(&failure);

            assert_eq!(event.level, Level::ERROR);
        }
    }

    #[test]
    fn pi_result_source_logs_pi_attribution() {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::Pi,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_cli_exit_code(1)
        .with_failure_detail_source(FailureDetailSource::PiResult)
        .with_session_history_status(SessionHistoryStatus::NotApplicable);
        let failure = executor::ExecutionFailure::new(1, "provider failed", Some(diagnostic));

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::ERROR);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("job execution failed")
        );
        assert_field_eq(&event, "failure_class", "cli_nonzero");
        assert_field_eq(&event, "failure_framework", "pi");
        assert_field_eq(&event, "failure_detail_source", "pi_result");
    }

    #[test]
    fn pi_rate_limit_logs_info_with_observed_request_and_retry_evidence() {
        let mut diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::Pi,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_failure_reason(FailureReason::ProviderRateLimited)
        .with_failure_detail_source(FailureDetailSource::PiResult);
        diagnostic.model_request = Some(guest_contracts::diagnostics::ModelRequestDiagnostic {
            http_status: Some(429),
            transport_attempts: 1,
            retry_attempts: 3,
            retry_limit: Some(3),
        });
        let failure = executor::ExecutionFailure::new(
            1,
            r#"{"detail":"Rate limit exceeded"}"#,
            Some(diagnostic),
        );
        let event = capture_job_failure_log(&failure);
        assert_eq!(event.level, Level::INFO);
        assert_field_eq(&event, "failure_reason", "provider_rate_limited");
        assert_field_eq(&event, "failure_framework", "pi");
        assert_field_eq(&event, "model_http_status", "429");
        assert_field_eq(&event, "model_transport_attempts", "1");
        assert_field_eq(&event, "model_retry_attempts", "3");
        assert_field_eq(&event, "model_retry_limit", "3");
    }

    #[test]
    fn pi_result_upstream_server_error_logs_job_execution_failed_at_info() {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::Pi,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_cli_exit_code(1)
        .with_failure_detail_source(FailureDetailSource::PiResult)
        .with_session_history_status(SessionHistoryStatus::NotApplicable)
        .with_failure_reason(FailureReason::ProviderServerError);
        let error =
            "upstream_non_api_response status=502 content_type=html bytes=4711 digest=1a2b3c4d";
        let failure = executor::ExecutionFailure::new(1, error, Some(diagnostic));

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::INFO);
        assert_field_eq(&event, "error", error);
        assert_field_eq(&event, "failure_reason", "provider_server_error");
        assert_field_eq(&event, "failure_framework", "pi");
        assert_field_eq(&event, "failure_detail_source", "pi_result");
    }

    #[test]
    fn claude_result_provider_overloaded_logs_job_execution_failed_at_info() {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_cli_exit_code(1)
        .with_failure_detail_source(FailureDetailSource::ClaudeResult)
        .with_session_history_status(SessionHistoryStatus::Present)
        .with_failure_reason(FailureReason::ProviderOverloaded);
        let failure = executor::ExecutionFailure::new(1, "API Error: Overloaded", Some(diagnostic));

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::INFO);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("job execution failed")
        );
        assert_field_eq(&event, "error", "API Error: Overloaded");
        assert_field_eq(&event, "failure_reason", "provider_overloaded");
        assert_field_eq(&event, "failure_class", "cli_nonzero");
        assert_field_eq(&event, "failure_framework", "claude_code");
        assert_field_eq(&event, "failure_detail_source", "claude_result");
    }

    #[test]
    fn claude_result_provider_stream_timeout_logs_job_execution_failed_at_info() {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_cli_exit_code(1)
        .with_failure_detail_source(FailureDetailSource::ClaudeResult)
        .with_session_history_status(SessionHistoryStatus::Present)
        .with_failure_reason(FailureReason::ProviderStreamTimeout);
        let failure = executor::ExecutionFailure::new(
            1,
            "API Error: Stream idle timeout - no chunks received",
            Some(diagnostic),
        );

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::INFO);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("job execution failed")
        );
        assert_field_eq(
            &event,
            "error",
            "API Error: Stream idle timeout - no chunks received",
        );
        assert_field_eq(&event, "failure_reason", "provider_stream_timeout");
        assert_field_eq(&event, "failure_class", "cli_nonzero");
        assert_field_eq(&event, "failure_framework", "claude_code");
        assert_field_eq(&event, "failure_detail_source", "claude_result");
    }

    #[test]
    fn claude_result_mid_response_failures_log_structured_outcomes() {
        for (reason, error, expected_level) in [
            (
                FailureReason::ProviderServerError,
                "API Error: Server error mid-response. The response above may be incomplete.",
                Level::INFO,
            ),
            (
                FailureReason::ResponseConnectionLost,
                "API Error: Connection lost mid-response. The response above may be incomplete.",
                Level::INFO,
            ),
        ] {
            let diagnostic = FailureDiagnostic::new(
                FailureClass::CliNonzero,
                AgentFramework::ClaudeCode,
                PromptMetadata::from_prompt("plain prompt"),
            )
            .with_cli_exit_code(1)
            .with_cli_observed_exit(CliObservedExitDiagnostic::from_exit_code(1))
            .with_claude_num_turns(Some(48))
            .with_failure_detail_source(FailureDetailSource::ClaudeResult)
            .with_session_history_status(SessionHistoryStatus::Present)
            .with_failure_reason(reason);
            let failure = executor::ExecutionFailure::new(1, error, Some(diagnostic));

            let event = capture_job_failure_log(&failure);

            assert_eq!(event.level, expected_level);
            assert_eq!(
                event.fields.get("message").map(String::as_str),
                Some("job execution failed")
            );
            assert_field_eq(&event, "error", error);
            assert_field_eq(&event, "failure_reason", reason.as_str());
            assert_field_eq(&event, "failure_class", "cli_nonzero");
            assert_field_eq(&event, "failure_framework", "claude_code");
            assert_field_eq(&event, "failure_detail_source", "claude_result");
            assert_field_eq(&event, "failure_claude_num_turns", "48");
            assert_field_eq(&event, "cli_observed_exit_kind", "exit");
            assert_field_eq(&event, "cli_observed_exit_code", "1");
            assert!(!event.fields.contains_key("cli_termination_initiator"));
            assert!(!event.fields.contains_key("cli_termination_reason"));
            assert!(!event.fields.contains_key("cli_observed_signal_number"));
            assert!(!event.fields.contains_key("cli_observed_signal_name"));
        }
    }

    #[test]
    fn claude_zero_turn_no_history_logs_job_execution_failed_at_info() {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::ClaudeZeroTurnNoHistory,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("/help"),
        )
        .with_cli_exit_code(0)
        .with_claude_num_turns(Some(0))
        .with_session_history_status(SessionHistoryStatus::Missing);
        let failure = executor::ExecutionFailure::new(
            1,
            "Claude Code emitted a zero-turn result without creating session history; skipping checkpoint",
            Some(diagnostic),
        );

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::INFO);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("job execution failed")
        );
        assert_field_eq(&event, "failure_class", "claude_zero_turn_no_history");
        assert_field_eq(&event, "session_history_status", "missing");
    }

    #[test]
    fn info_level_reason_on_non_cli_failure_logs_job_execution_failed_at_error() {
        for reason in [
            FailureReason::InvalidApiKey,
            FailureReason::InvalidCredentials,
            FailureReason::TermsAcceptanceRequired,
            FailureReason::ContextWindowExceeded,
            FailureReason::OutputTokenLimit,
            FailureReason::ProviderRateLimited,
            FailureReason::ProviderOverloaded,
            FailureReason::ProviderStreamTimeout,
            FailureReason::ProviderServerError,
            FailureReason::ResponseConnectionLost,
            FailureReason::SafetyPolicyRefusal,
            FailureReason::ReconnectRequired,
            FailureReason::UnsupportedModel,
            FailureReason::UsageLimit,
        ] {
            let diagnostic = FailureDiagnostic::new(
                FailureClass::CheckpointFailed,
                AgentFramework::Codex,
                PromptMetadata::from_prompt("plain prompt"),
            )
            .with_failure_reason(reason);
            let failure = executor::ExecutionFailure::new(
                1,
                format!("checkpoint upload failed after {} event", reason.as_str()),
                Some(diagnostic),
            );

            let event = capture_job_failure_log(&failure);

            assert_eq!(event.level, Level::ERROR);
            assert_eq!(
                event.fields.get("message").map(String::as_str),
                Some("job execution failed")
            );
            assert_field_eq(&event, "failure_reason", reason.as_str());
            assert_field_eq(&event, "failure_class", "checkpoint_failed");
        }
    }

    #[test]
    fn unclassified_diagnostic_failure_logs_job_execution_failed_at_error() {
        let diagnostic = job_failure_diagnostic(None);
        let failure = executor::ExecutionFailure::new(1, "permission denied", Some(diagnostic));

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::ERROR);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("job execution failed")
        );
        assert!(!event.fields.contains_key("failure_reason"));
        assert!(!event.fields.contains_key("timeout_ms"));
        assert!(!event.fields.contains_key("cli_termination_reason"));
        assert!(!event.fields.contains_key("cli_observed_exit_kind"));
        assert!(!event.fields.contains_key("event_delivery_total_batches"));
    }

    #[test]
    fn diagnostic_failure_logs_cli_termination_fields() {
        let diagnostic =
            job_failure_diagnostic(None).with_cli_termination(post_result_cli_termination());
        let failure =
            executor::ExecutionFailure::new(143, "Agent exited with code 143", Some(diagnostic));

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::ERROR);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("job execution failed")
        );
        assert_field_eq(&event, "cli_termination_initiator", "guest_agent");
        assert_field_eq(&event, "cli_termination_reason", "post_result_reap");
        assert_field_eq(&event, "cli_termination_signal_sent", "sigterm");
        assert_field_eq(&event, "cli_termination_signal_pgid", "1401");
        assert_field_eq(&event, "cli_termination_signal_grace_ms", "10000");
        assert_field_eq(&event, "cli_termination_escalated", "false");
        assert_field_eq(&event, "cli_termination_observed_exit_code", "143");
    }

    #[test]
    fn diagnostic_failure_logs_cli_observed_exit_fields() {
        let diagnostic = job_failure_diagnostic(None)
            .with_cli_exit_code(137)
            .with_cli_observed_exit(CliObservedExitDiagnostic::from_signal(libc::SIGKILL));
        let failure =
            executor::ExecutionFailure::new(137, "Agent exited with code 137", Some(diagnostic));

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::ERROR);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("job execution failed")
        );
        assert_field_eq(&event, "failure_cli_exit_code", "137");
        assert_field_eq(&event, "cli_observed_exit_kind", "signal");
        assert!(!event.fields.contains_key("cli_observed_exit_code"));
        assert_field_eq(&event, "cli_observed_signal_number", "9");
        assert_field_eq(&event, "cli_observed_signal_name", "sigkill");
        assert_field_eq(&event, "cli_observed_mapped_exit_code", "137");
    }

    #[test]
    fn diagnostic_failure_logs_cli_observed_normal_exit_fields() {
        let diagnostic = job_failure_diagnostic(None)
            .with_cli_exit_code(2)
            .with_cli_observed_exit(CliObservedExitDiagnostic::from_exit_code(2));
        let failure =
            executor::ExecutionFailure::new(2, "Agent exited with code 2", Some(diagnostic));

        let event = capture_job_failure_log(&failure);

        assert_field_eq(&event, "cli_observed_exit_kind", "exit");
        assert_field_eq(&event, "cli_observed_exit_code", "2");
        assert!(!event.fields.contains_key("cli_observed_signal_number"));
        assert!(!event.fields.contains_key("cli_observed_signal_name"));
        assert_field_eq(&event, "cli_observed_mapped_exit_code", "2");
    }

    #[test]
    fn diagnostic_failure_logs_bounded_event_delivery_fields() {
        let failed_attempt = HttpCompletedAttemptDiagnostic {
            attempt: 4,
            client_request_id: "11111111-1111-4111-8111-111111111111".to_string(),
            elapsed_ms: 30_001,
            failure_kind: HttpAttemptFailureKind::HttpStatus,
            http_status: Some(500),
            timeout_observed: None,
            connect_observed: None,
        };
        let first_active_completed_attempt = HttpCompletedAttemptDiagnostic {
            attempt: 1,
            client_request_id: "33333333-3333-4333-8333-333333333333".to_string(),
            elapsed_ms: 1_001,
            ..failed_attempt.clone()
        };
        let second_active_completed_attempt = HttpCompletedAttemptDiagnostic {
            attempt: 2,
            client_request_id: "44444444-4444-4444-8444-444444444444".to_string(),
            elapsed_ms: 2_001,
            ..failed_attempt.clone()
        };
        let diagnostic = FailureDiagnostic::new(
            FailureClass::EventUploadFailed,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("continue"),
        )
        .with_cli_exit_code(0)
        .with_event_delivery(EventDeliveryDiagnostic {
            total_events: 43,
            total_batches: 2,
            failed_batches: 1,
            last_acknowledged_sequence: Some(7),
            first_failed_batch: Some(EventDeliveryFailedBatchDiagnostic {
                first_sequence: 8,
                last_sequence: 18,
                event_count: 11,
                conservative_bytes: 2_048,
                outcome: EventDeliveryAcceptanceOutcome::ConfirmedRejection,
                attempts: vec![failed_attempt.clone()],
            }),
            drain_timeout: Some(EventDeliveryDrainTimeoutDiagnostic {
                queued_events: 5,
                queued_bytes: 256,
                carried_events: 6,
                carried_bytes: 129,
                active_batch: Some(EventDeliveryActiveBatchDiagnostic {
                    first_sequence: 19,
                    last_sequence: 42,
                    event_count: 24,
                    conservative_bytes: 8_193,
                    completed_attempts: vec![
                        first_active_completed_attempt,
                        second_active_completed_attempt,
                    ],
                    active_attempt: Some(EventDeliveryActiveAttemptDiagnostic {
                        attempt: 3,
                        client_request_id: "22222222-2222-4222-8222-222222222222".to_string(),
                        elapsed_ms: 4_001,
                    }),
                    outcome: EventDeliveryAcceptanceOutcome::OutcomeUnknown,
                }),
            }),
        });
        let failure = executor::ExecutionFailure::new(1, "event delivery failed", Some(diagnostic));

        let event = capture_job_failure_log(&failure);

        assert_field_eq(&event, "event_delivery_total_events", "43");
        assert_field_eq(&event, "event_delivery_total_batches", "2");
        assert_field_eq(&event, "event_delivery_failed_batches", "1");
        assert_field_eq(&event, "event_delivery_last_acknowledged_sequence", "7");
        assert_field_eq(&event, "event_delivery_first_failure_first_sequence", "8");
        assert_field_eq(&event, "event_delivery_first_failure_last_sequence", "18");
        assert_field_eq(&event, "event_delivery_first_failure_event_count", "11");
        assert_field_eq(
            &event,
            "event_delivery_first_failure_conservative_bytes",
            "2048",
        );
        assert_field_eq(
            &event,
            "event_delivery_first_failure_outcome",
            "confirmed_rejection",
        );
        assert_field_eq(&event, "event_delivery_first_failure_attempt_count", "1");
        assert_field_eq(
            &event,
            "event_delivery_first_failure_final_attempt_number",
            "4",
        );
        assert_field_eq(
            &event,
            "event_delivery_first_failure_final_attempt_kind",
            "http_status",
        );
        assert!(
            !event
                .fields
                .contains_key("event_delivery_first_failure_final_attempt_timeout_observed")
        );
        assert!(
            !event
                .fields
                .contains_key("event_delivery_first_failure_final_attempt_connect_observed")
        );
        assert_field_eq(
            &event,
            "event_delivery_first_failure_final_attempt_http_status",
            "500",
        );
        assert_field_eq(
            &event,
            "event_delivery_first_failure_final_attempt_request_id",
            "11111111-1111-4111-8111-111111111111",
        );
        assert_field_eq(
            &event,
            "event_delivery_first_failure_final_attempt_elapsed_ms",
            "30001",
        );
        assert_field_eq(&event, "event_delivery_drain_timeout", "true");
        assert_field_eq(&event, "event_delivery_drain_queued_events", "5");
        assert_field_eq(&event, "event_delivery_drain_queued_bytes", "256");
        assert_field_eq(&event, "event_delivery_drain_carried_events", "6");
        assert_field_eq(&event, "event_delivery_drain_carried_bytes", "129");
        assert_field_eq(&event, "event_delivery_drain_active_first_sequence", "19");
        assert_field_eq(&event, "event_delivery_drain_active_last_sequence", "42");
        assert_field_eq(&event, "event_delivery_drain_active_event_count", "24");
        assert_field_eq(
            &event,
            "event_delivery_drain_active_conservative_bytes",
            "8193",
        );
        assert_field_eq(
            &event,
            "event_delivery_drain_active_completed_attempt_count",
            "2",
        );
        assert_field_eq(&event, "event_delivery_drain_active_attempt_number", "3");
        assert_field_eq(
            &event,
            "event_delivery_drain_active_attempt_request_id",
            "22222222-2222-4222-8222-222222222222",
        );
        assert_field_eq(
            &event,
            "event_delivery_drain_active_attempt_elapsed_ms",
            "4001",
        );
        assert_field_eq(
            &event,
            "event_delivery_drain_active_outcome",
            "outcome_unknown",
        );
        for field in [
            "event_delivery_first_failure_event_count",
            "event_delivery_first_failure_attempt_count",
            "event_delivery_first_failure_final_attempt_number",
            "event_delivery_first_failure_final_attempt_elapsed_ms",
            "event_delivery_drain_queued_bytes",
            "event_delivery_drain_carried_bytes",
            "event_delivery_drain_active_last_sequence",
            "event_delivery_drain_active_event_count",
            "event_delivery_drain_active_conservative_bytes",
            "event_delivery_drain_active_completed_attempt_count",
            "event_delivery_drain_active_attempt_number",
        ] {
            assert_field_kind(&event, field, "u64");
        }
        assert!(!event.fields.contains_key("event_delivery_attempts"));
        assert!(!event.fields.contains_key("event_delivery_body"));
    }

    #[test]
    fn diagnostic_failure_logs_bounded_heartbeat_fields() {
        let diagnostic = job_failure_diagnostic(None).with_heartbeat(HeartbeatFailureDiagnostic {
            failed_cycles: vec![
                HeartbeatFailedCycleDiagnostic {
                    scheduled_lag_ms: 11,
                    attempts: vec![HttpCompletedAttemptDiagnostic {
                        attempt: 1,
                        client_request_id: "11111111-1111-4111-8111-111111111111".to_string(),
                        elapsed_ms: 100,
                        failure_kind: HttpAttemptFailureKind::HttpStatus,
                        http_status: Some(503),
                        timeout_observed: None,
                        connect_observed: None,
                    }],
                },
                HeartbeatFailedCycleDiagnostic {
                    scheduled_lag_ms: 27,
                    attempts: vec![
                        HttpCompletedAttemptDiagnostic {
                            attempt: 1,
                            client_request_id: "22222222-2222-4222-8222-222222222222".to_string(),
                            elapsed_ms: 30_000,
                            failure_kind: HttpAttemptFailureKind::Timeout,
                            http_status: None,
                            timeout_observed: Some(true),
                            connect_observed: Some(false),
                        },
                        HttpCompletedAttemptDiagnostic {
                            attempt: 2,
                            client_request_id: "33333333-3333-4333-8333-333333333333".to_string(),
                            elapsed_ms: 30_001,
                            failure_kind: HttpAttemptFailureKind::Timeout,
                            http_status: None,
                            timeout_observed: Some(true),
                            connect_observed: Some(false),
                        },
                    ],
                },
            ],
        });
        let failure = executor::ExecutionFailure::new(1, "heartbeat failed", Some(diagnostic));

        let event = capture_job_failure_log(&failure);

        assert_field_eq(&event, "heartbeat_failed_cycle_count", "2");
        assert_field_eq(&event, "heartbeat_attempt_count", "3");
        assert_field_eq(&event, "heartbeat_final_scheduled_lag_ms", "27");
        assert_field_eq(&event, "heartbeat_final_attempt_number", "2");
        assert_field_eq(&event, "heartbeat_final_attempt_kind", "timeout");
        assert_field_eq(&event, "heartbeat_final_attempt_timeout_observed", "true");
        assert_field_eq(&event, "heartbeat_final_attempt_connect_observed", "false");
        assert!(
            !event
                .fields
                .contains_key("heartbeat_final_attempt_http_status")
        );
        assert_field_eq(
            &event,
            "heartbeat_final_attempt_request_id",
            "33333333-3333-4333-8333-333333333333",
        );
        assert_field_eq(&event, "heartbeat_final_attempt_elapsed_ms", "30001");
        assert!(!event.fields.contains_key("heartbeat_failed_cycles"));
    }

    #[test]
    fn diagnostic_failure_logs_event_transport_observations() {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::EventUploadFailed,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("continue"),
        )
        .with_cli_exit_code(0)
        .with_event_delivery(EventDeliveryDiagnostic {
            total_events: 1,
            total_batches: 1,
            failed_batches: 1,
            last_acknowledged_sequence: None,
            first_failed_batch: Some(EventDeliveryFailedBatchDiagnostic {
                first_sequence: 0,
                last_sequence: 0,
                event_count: 1,
                conservative_bytes: 128,
                outcome: EventDeliveryAcceptanceOutcome::OutcomeUnknown,
                attempts: vec![HttpCompletedAttemptDiagnostic {
                    attempt: 3,
                    client_request_id: "11111111-1111-4111-8111-111111111111".to_string(),
                    elapsed_ms: 10_000,
                    failure_kind: HttpAttemptFailureKind::Timeout,
                    http_status: None,
                    timeout_observed: Some(true),
                    connect_observed: Some(true),
                }],
            }),
            drain_timeout: None,
        });
        let failure = executor::ExecutionFailure::new(1, "event delivery failed", Some(diagnostic));

        let event = capture_job_failure_log(&failure);

        assert_field_eq(
            &event,
            "event_delivery_first_failure_final_attempt_timeout_observed",
            "true",
        );
        assert_field_eq(
            &event,
            "event_delivery_first_failure_final_attempt_connect_observed",
            "true",
        );
    }

    #[test]
    fn diagnostic_failure_logs_observed_signal_name_from_number() {
        let diagnostic = job_failure_diagnostic(None)
            .with_cli_exit_code(137)
            .with_cli_observed_exit(CliObservedExitDiagnostic {
                kind: CliObservedExitKind::Signal,
                exit_code: Some(137),
                signal_number: Some(libc::SIGKILL),
                signal_name: Some("tampered".to_string()),
                mapped_exit_code: 137,
            });
        let failure =
            executor::ExecutionFailure::new(137, "Agent exited with code 137", Some(diagnostic));

        let event = capture_job_failure_log(&failure);

        assert_field_eq(&event, "cli_observed_signal_name", "sigkill");
        assert!(!event.fields.contains_key("cli_observed_exit_code"));
    }

    #[test]
    fn failure_without_diagnostic_logs_job_execution_failed_at_error() {
        let failure = executor::ExecutionFailure::new(1, "executor task panicked", None);

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::ERROR);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("job execution failed")
        );
        assert!(!event.fields.contains_key("failure_class"));
        assert!(!event.fields.contains_key("failure_reason"));
        assert!(!event.fields.contains_key("prompt_shape"));
        assert!(!event.fields.contains_key("timeout_ms"));
    }

    #[test]
    fn classified_resource_failure_logs_resource_fields() {
        let failure = executor::ExecutionFailure::new(137, "Agent exited with code 137", None)
            .with_resource_diagnostics(Some(executor::ResourceFailureDiagnostics {
                failure_kind: Some(executor::ResourceFailureKind::GuestRootFilesystemFull),
                guest_root_fs_used_percent: Some(100),
                guest_root_fs_available_kb: Some(20),
                guest_root_fs_inode_used_percent: Some(99),
                guest_root_fs_available_inodes: Some(42),
                guest_workspace_fs_used_percent: Some(1),
                guest_memory_available_mb: Some(624),
            }));

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::ERROR);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("job execution failed")
        );
        assert_field_eq(&event, "exit_code", "137");
        assert_field_eq(&event, "reused", "false");
        assert_field_eq(&event, "error", "Agent exited with code 137");
        assert_field_eq(
            &event,
            "resource_failure_kind",
            "guest_root_filesystem_full",
        );
        assert_field_eq(&event, "guest_root_fs_used_percent", "100");
        assert_field_eq(&event, "guest_root_fs_available_kb", "20");
        assert_field_eq(&event, "guest_root_fs_inode_used_percent", "99");
        assert_field_eq(&event, "guest_root_fs_available_inodes", "42");
        assert_field_eq(&event, "guest_workspace_fs_used_percent", "1");
        assert_field_eq(&event, "guest_memory_available_mb", "624");
    }

    #[test]
    fn workload_resource_limit_logs_structured_counters() {
        let diagnostic = job_failure_diagnostic(None).with_workload_resource_limit(
            WorkloadResourceLimitDiagnostic {
                memory_max_events: 5,
                memory_oom_events: 2,
                memory_oom_kill_events: 1,
                memory_oom_group_kill_events: 0,
                pids_max_events: 3,
            },
        );
        let failure = executor::ExecutionFailure::new(
            137,
            "Agent workload reached its memory limit",
            Some(diagnostic),
        );

        let event = capture_job_failure_log(&failure);

        assert_field_eq(&event, "workload_memory_max_events", "5");
        assert_field_eq(&event, "workload_memory_oom_events", "2");
        assert_field_eq(&event, "workload_memory_oom_kill_events", "1");
        assert_field_eq(&event, "workload_memory_oom_group_kill_events", "0");
        assert_field_eq(&event, "workload_pids_max_events", "3");
    }

    #[test]
    fn oom_resource_failure_logs_resource_kind() {
        let failure =
            executor::ExecutionFailure::new(1, "Agent process killed by OOM killer", None)
                .with_resource_diagnostics(Some(
                    executor::ResourceFailureDiagnostics::from_failure_kind(
                        executor::ResourceFailureKind::GuestMemoryOomKilled,
                    ),
                ));

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::ERROR);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("job execution failed")
        );
        assert_field_eq(&event, "exit_code", "1");
        assert_field_eq(&event, "error", "Agent process killed by OOM killer");
        assert_field_eq(&event, "resource_failure_kind", "guest_memory_oom_killed");
    }

    #[test]
    fn runner_job_timeout_logs_specific_terminal_message_and_fields() {
        let failure = executor::ExecutionFailure::runner_job_timeout(
            124,
            "Timeout",
            None,
            Duration::from_secs(7200),
            Duration::from_millis(7_199_949),
            Some(7_200_084),
        );

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::INFO);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("runner job reached execution time limit")
        );
        assert_field_eq(&event, "exit_code", "124");
        assert_field_eq(&event, "reused", "false");
        assert_field_eq(&event, "error", "Timeout");
        assert_field_eq(&event, "timeout_ms", "7200000");
        assert_field_eq(&event, "elapsed_ms", "7199949");
        assert_field_eq(&event, "guest_duration_ms", "7200084");
        assert!(!event.fields.contains_key("failure_class"));
        assert!(!event.fields.contains_key("failure_reason"));
        assert!(!event.fields.contains_key("prompt_shape"));
    }

    #[test]
    fn generic_and_timeout_failures_share_diagnostic_and_resource_fields() {
        let diagnostic = job_failure_diagnostic(Some(FailureReason::UsageLimit))
            .with_claude_num_turns(Some(2))
            .with_cli_termination(post_result_cli_termination())
            .with_cli_observed_exit(CliObservedExitDiagnostic::from_signal(libc::SIGKILL));
        let resource_diagnostics = executor::ResourceFailureDiagnostics {
            failure_kind: Some(executor::ResourceFailureKind::GuestRootFilesystemFull),
            guest_root_fs_used_percent: Some(100),
            guest_root_fs_available_kb: Some(20),
            guest_root_fs_inode_used_percent: Some(99),
            guest_root_fs_available_inodes: Some(42),
            guest_workspace_fs_used_percent: Some(1),
            guest_memory_available_mb: Some(624),
        };
        let generic_failure =
            executor::ExecutionFailure::new(124, "Timeout", Some(diagnostic.clone()))
                .with_resource_diagnostics(Some(resource_diagnostics));
        let timeout_failure = executor::ExecutionFailure::runner_job_timeout(
            124,
            "Timeout",
            Some(diagnostic),
            Duration::from_secs(7200),
            Duration::from_millis(7_200_100),
            Some(7_200_000),
        )
        .with_resource_diagnostics(Some(resource_diagnostics));

        let generic_event = capture_job_failure_log(&generic_failure);
        let timeout_event = capture_job_failure_log(&timeout_failure);

        assert_eq!(generic_event.level, Level::INFO);
        assert_eq!(timeout_event.level, Level::INFO);
        assert_eq!(
            generic_event.fields.get("message").map(String::as_str),
            Some("job execution failed")
        );
        assert_eq!(
            timeout_event.fields.get("message").map(String::as_str),
            Some("runner job reached execution time limit")
        );
        assert_field_eq(&timeout_event, "timeout_ms", "7200000");
        assert_field_eq(&timeout_event, "elapsed_ms", "7200100");
        assert_field_eq(&timeout_event, "guest_duration_ms", "7200000");
        assert_field_kind(&timeout_event, "timeout_ms", "u128");
        assert_field_kind(&timeout_event, "elapsed_ms", "u128");
        assert_field_kind(&timeout_event, "guest_duration_ms", "u64");

        for event in [&generic_event, &timeout_event] {
            assert_field_eq(event, "run_id", &RunId::nil().to_string());
            assert_field_eq(event, "exit_code", "124");
            assert_field_eq(event, "reused", "false");
            assert_field_eq(event, "error", "Timeout");
            assert_field_eq(event, "failure_reason", "usage_limit");
            assert_field_eq(event, "failure_class", "cli_nonzero");
            assert_field_eq(event, "failure_framework", "codex");
            assert_field_eq(event, "failure_cli_exit_code", "1");
            assert_field_eq(event, "failure_claude_num_turns", "2");
            assert_field_eq(event, "failure_detail_source", "codex_jsonl");
            assert_field_eq(event, "session_history_status", "not_applicable");
            assert_field_eq(event, "prompt_shape", "plain");
            assert_field_eq(event, "prompt_bytes", "12");
            assert_field_eq(event, "first_line_bytes", "12");
            assert_field_eq(event, "cli_termination_initiator", "guest_agent");
            assert_field_eq(event, "cli_termination_reason", "post_result_reap");
            assert_field_eq(event, "cli_termination_signal_sent", "sigterm");
            assert_field_eq(event, "cli_termination_signal_pgid", "1401");
            assert_field_eq(event, "cli_termination_signal_grace_ms", "10000");
            assert_field_eq(event, "cli_termination_escalated", "false");
            assert_field_eq(event, "cli_termination_observed_exit_code", "143");
            assert_field_eq(event, "cli_observed_exit_kind", "signal");
            assert_field_eq(event, "cli_observed_signal_number", "9");
            assert_field_eq(event, "cli_observed_signal_name", "sigkill");
            assert_field_eq(event, "cli_observed_mapped_exit_code", "137");
            assert_field_eq(event, "resource_failure_kind", "guest_root_filesystem_full");
            assert_field_eq(event, "guest_root_fs_used_percent", "100");
            assert_field_eq(event, "guest_root_fs_available_kb", "20");
            assert_field_eq(event, "guest_workspace_fs_used_percent", "1");
            assert_field_eq(event, "guest_memory_available_mb", "624");

            assert_field_kind(event, "message", "debug");
            assert_field_kind(event, "run_id", "debug");
            assert_field_kind(event, "exit_code", "i64");
            assert_field_kind(event, "reused", "bool");
            assert_field_kind(event, "error", "debug");
            assert_field_kind(event, "failure_class", "str");
            assert_field_kind(event, "failure_cli_exit_code", "i64");
            assert_field_kind(event, "failure_claude_num_turns", "u64");
            assert_field_kind(event, "cli_termination_escalated", "bool");
            assert_field_kind(event, "prompt_bytes", "u64");
            assert_field_kind(event, "guest_root_fs_used_percent", "u64");
        }

        assert_shared_failure_log_fields(&generic_event, &timeout_event);
    }
}
