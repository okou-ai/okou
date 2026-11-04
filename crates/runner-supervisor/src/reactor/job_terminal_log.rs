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
use runner_types::ids::RunId;

pub(super) fn log_terminal_job_outcome(
    run_id: RunId,
    exit_code: i32,
    reused: bool,
    cancelled: bool,
    failure: Option<&executor::ExecutionFailure>,
    error_tail_max_bytes: usize,
) {
    // Single sink for any claimed job's terminal state. Cancellation gets
    // its own info marker; every other failure is represented by a single
    // object carrying the exit code, error, and optional guest-authored diagnostic.
    match (cancelled, failure) {
        (true, _) => info!(run_id = %run_id, exit_code, reused, "job cancelled"),
        (false, Some(failure)) => {
            log_job_execution_failed(run_id, exit_code, reused, failure, error_tail_max_bytes);
        }
        (false, None) => info!(run_id = %run_id, exit_code, reused, "job finished"),
    }
}

fn log_job_execution_failed(
    run_id: RunId,
    exit_code: i32,
    reused: bool,
    failure: &executor::ExecutionFailure,
    error_tail_max_bytes: usize,
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
                error_tail = runner_host::log_file::bounded_error_tail(&failure.error, error_tail_max_bytes),
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
                codex_reported_failure_stage = diagnostic.and_then(|diagnostic| diagnostic.codex_failure)
                    .and_then(|evidence| evidence.reported_stage)
                    .map(|stage| stage.as_str()),
                codex_native_failure_kind = diagnostic.and_then(|diagnostic| diagnostic.codex_failure)
                    .and_then(|evidence| evidence.native_kind)
                    .map(|kind| kind.as_str()),
                codex_http_status = diagnostic.and_then(|diagnostic| diagnostic.codex_failure)
                    .and_then(|evidence| evidence.http_status),
                model_transport_attempts = diagnostic.and_then(|diagnostic| diagnostic.model_request)
                    .map(|request| request.transport_attempts),
                model_retry_attempts = diagnostic.and_then(|diagnostic| diagnostic.model_request)
                    .map(|request| request.retry_attempts),
                model_retry_limit = diagnostic.and_then(|diagnostic| diagnostic.model_request)
                    .and_then(|request| request.retry_limit),
                model_transport_failure_phase = diagnostic.and_then(|diagnostic| diagnostic.model_request)
                    .and_then(|request| request.transport_failure)
                    .and_then(|failure| failure.phase.as_str()),
                model_transport_signal_aborted = diagnostic.and_then(|diagnostic| diagnostic.model_request)
                    .and_then(|request| request.transport_failure)
                    .map(|failure| failure.signal_aborted),
                model_transport_error_name = diagnostic.and_then(|diagnostic| diagnostic.model_request)
                    .and_then(|request| request.transport_failure)
                    .and_then(|failure| failure.error_name)
                    .and_then(|name| name.as_str()),
                model_transport_error_code = diagnostic.and_then(|diagnostic| diagnostic.model_request)
                    .and_then(|request| request.transport_failure)
                    .and_then(|failure| failure.error_code)
                    .and_then(|code| code.as_str()),
                model_transport_cause_code = diagnostic.and_then(|diagnostic| diagnostic.model_request)
                    .and_then(|request| request.transport_failure)
                    .and_then(|failure| failure.cause_code)
                    .and_then(|code| code.as_str()),
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
                event_delivery_first_failure_response_state =
                    event_delivery_fields.first_failure_response_state,
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
                event_delivery_drain_active_response_state =
                    event_delivery_fields.drain_active_response_state,
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
                guest_home_fs_used_percent = resource_fields.guest_home_fs_used_percent,
                guest_home_fs_available_kb = resource_fields.guest_home_fs_available_kb,
                guest_home_fs_inode_used_percent = resource_fields.guest_home_fs_inode_used_percent,
                guest_home_fs_available_inodes = resource_fields.guest_home_fs_available_inodes,
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
        ExecutionFailureKind::Generic
            if failure
                .resource_diagnostics
                .and_then(|diagnostics| diagnostics.failure_kind)
                .is_some_and(executor::ResourceFailureKind::is_filesystem_full)
                || diagnostic.is_some_and(is_info_level_job_failure) =>
        {
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
    guest_home_fs_used_percent: Option<u64>,
    guest_home_fs_available_kb: Option<u64>,
    guest_home_fs_inode_used_percent: Option<u64>,
    guest_home_fs_available_inodes: Option<u64>,
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
    first_failure_response_state: Option<&'static str>,
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
    drain_active_response_state: Option<&'static str>,
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
            first_failure_response_state: first_failure
                .map(|failure| failure.response_state.as_str()),
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
            drain_active_response_state: drain_active.map(|active| active.response_state.as_str()),
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
            guest_home_fs_used_percent: diagnostics
                .and_then(|diagnostics| diagnostics.guest_home_fs_used_percent)
                .map(u64::from),
            guest_home_fs_available_kb: diagnostics
                .and_then(|diagnostics| diagnostics.guest_home_fs_available_kb),
            guest_home_fs_inode_used_percent: diagnostics
                .and_then(|diagnostics| diagnostics.guest_home_fs_inode_used_percent)
                .map(u64::from),
            guest_home_fs_available_inodes: diagnostics
                .and_then(|diagnostics| diagnostics.guest_home_fs_available_inodes),
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
                    | FailureReason::AccountVerificationRequired
                    | FailureReason::ContextWindowExceeded
                    | FailureReason::ProviderImageTooLarge
                    | FailureReason::OutputTokenLimit
                    | FailureReason::ProviderRateLimited
                    | FailureReason::ProviderOverloaded
                    | FailureReason::ProviderStreamTimeout
                    | FailureReason::ProviderQueueTimeout
                    | FailureReason::ProviderServerError
                    | FailureReason::ResponseConnectionLost
                    | FailureReason::SafetyPolicyRefusal
                    | FailureReason::ReconnectRequired
                    | FailureReason::CodexAccessProgramUnavailable
                    | FailureReason::UnsupportedModel
                    | FailureReason::UsageLimit
            )
        ),
        FailureClass::ClaudeZeroTurnNoHistory => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests;
