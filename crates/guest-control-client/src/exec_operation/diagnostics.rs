use std::io;

use guest_control_proto::{
    ExecCapturedOutput, ExecLifecyclePolicy, ExecProcessRole, ExecTermination,
};
use tokio::time::Instant;

use super::state::ExecOperationLifecycle;
use super::{EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES, EXEC_OPERATION_STAGE_SLOW_THRESHOLD};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::exec_operation) enum ExecTerminalLogLifecycle {
    OneShot,
    Supervised,
}

impl ExecTerminalLogLifecycle {
    fn as_str(self) -> &'static str {
        match self {
            ExecTerminalLogLifecycle::OneShot => "one_shot",
            ExecTerminalLogLifecycle::Supervised => "supervised",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::exec_operation) enum ExecTerminalLogSeverity {
    Info,
    Warn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::exec_operation) enum ExecTerminalLogReason {
    ExpectedCancel,
    ExpectedTimeout,
    Notable,
    OomEvidence,
    ContainedToolOom,
    Slow,
}

impl ExecTerminalLogReason {
    fn as_str(self) -> &'static str {
        match self {
            ExecTerminalLogReason::ExpectedCancel => "expected_cancel",
            ExecTerminalLogReason::ExpectedTimeout => "expected_timeout",
            ExecTerminalLogReason::Notable => "notable",
            ExecTerminalLogReason::OomEvidence => "oom_evidence",
            ExecTerminalLogReason::ContainedToolOom => "contained_tool_oom",
            ExecTerminalLogReason::Slow => "slow",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::exec_operation) struct ExecTerminalLogDecision {
    pub(in crate::exec_operation) severity: ExecTerminalLogSeverity,
    pub(in crate::exec_operation) reason: ExecTerminalLogReason,
}

#[derive(Clone, Copy)]
pub(in crate::exec_operation) struct ExecTerminalLogContext<'a> {
    pub(in crate::exec_operation) label: &'a str,
    pub(in crate::exec_operation) lifecycle: ExecTerminalLogLifecycle,
    pub(in crate::exec_operation) timeout_is_expected: bool,
    pub(in crate::exec_operation) slow: bool,
    pub(in crate::exec_operation) termination: ExecTermination,
    pub(in crate::exec_operation) stdout_truncated: bool,
    pub(in crate::exec_operation) stderr_truncated: bool,
    pub(in crate::exec_operation) stream_overflowed: bool,
    /// The diagnostic left after removing bounded OOM metadata. Only this part
    /// describes an operation failure; Runner drops the metadata before outcome
    /// processing, so severity must not be selected on the raw frame.
    pub(in crate::exec_operation) actionable_diagnostic: bool,
    /// The transported evidence proves an OOM decision rather than recording an
    /// inspected-and-empty capture candidate.
    pub(in crate::exec_operation) evidence_has_proof: bool,
    pub(in crate::exec_operation) contained_tool_oom: bool,
    /// A line claimed the evidence prefix but broke its bounds or encoding.
    pub(in crate::exec_operation) evidence_malformed: bool,
    pub(in crate::exec_operation) host_cancel_requested: bool,
}

#[derive(Clone)]
pub(in crate::exec_operation) struct ExecOperationDiagnostic {
    pub(in crate::exec_operation) seq: u32,
    pub(in crate::exec_operation) timeout_is_expected: bool,
    pub(in crate::exec_operation) label_log: String,
    pub(in crate::exec_operation) registered_at: Instant,
    pub(in crate::exec_operation) first_output_at: Option<Instant>,
    pub(in crate::exec_operation) process_class: &'static str,
    pub(in crate::exec_operation) operation_kind: &'static str,
}

pub(in crate::exec_operation) struct ExecOperationSnapshot {
    pub(in crate::exec_operation) seq: u32,
    pub(in crate::exec_operation) label_log: String,
    pub(in crate::exec_operation) elapsed_ms: u128,
    pub(in crate::exec_operation) process_class: &'static str,
    pub(in crate::exec_operation) operation_kind: &'static str,
}

pub(crate) struct ExecOperationCloseSnapshot {
    pub(in crate::exec_operation) active_count: usize,
    pub(in crate::exec_operation) operations: Vec<ExecOperationSnapshot>,
}

pub(in crate::exec_operation) struct ExecOperationFrameDiagnostic {
    pub(in crate::exec_operation) seq: u32,
    pub(in crate::exec_operation) label_log: String,
    pub(in crate::exec_operation) frame: &'static str,
    pub(in crate::exec_operation) process_class: &'static str,
    pub(in crate::exec_operation) operation_kind: &'static str,
}

impl ExecOperationDiagnostic {
    pub(in crate::exec_operation) fn new(
        seq: u32,
        label: &str,
        role: ExecProcessRole,
        supervised: bool,
        timeout_is_expected: bool,
    ) -> Self {
        let lifecycle = if supervised {
            ExecLifecyclePolicy::Supervised
        } else {
            ExecLifecyclePolicy::OneShot
        };
        Self {
            seq,
            timeout_is_expected: timeout_is_expected
                && supervised
                && role == ExecProcessRole::Workload,
            label_log: exec_operation_label_log(label),
            registered_at: Instant::now(),
            first_output_at: None,
            process_class: role.process_class(),
            operation_kind: role.operation_kind(lifecycle),
        }
    }

    pub(in crate::exec_operation) fn frame(
        &self,
        frame: &'static str,
    ) -> ExecOperationFrameDiagnostic {
        ExecOperationFrameDiagnostic {
            seq: self.seq,
            label_log: self.label_log.clone(),
            frame,
            process_class: self.process_class,
            operation_kind: self.operation_kind,
        }
    }

    pub(in crate::exec_operation) fn elapsed_ms(&self) -> u128 {
        self.registered_at.elapsed().as_millis()
    }

    pub(in crate::exec_operation) fn snapshot(&self) -> ExecOperationSnapshot {
        ExecOperationSnapshot {
            seq: self.seq,
            label_log: self.label_log.clone(),
            elapsed_ms: self.elapsed_ms(),
            process_class: self.process_class,
            operation_kind: self.operation_kind,
        }
    }

    pub(in crate::exec_operation) fn mark_first_output(&mut self) -> Option<ExecOperationSnapshot> {
        if self.first_output_at.is_some() {
            return None;
        }

        self.first_output_at = Some(Instant::now());
        let elapsed_ms = self.elapsed_ms();
        if elapsed_ms >= EXEC_OPERATION_STAGE_SLOW_THRESHOLD.as_millis() {
            return Some(ExecOperationSnapshot {
                seq: self.seq,
                label_log: self.label_log.clone(),
                elapsed_ms,
                process_class: self.process_class,
                operation_kind: self.operation_kind,
            });
        }

        None
    }

    pub(in crate::exec_operation) fn log_terminal(
        &self,
        lifecycle: ExecTerminalLogLifecycle,
        result: &guest_control_proto::DecodedExecResult<'_>,
        stream_overflowed: bool,
        host_cancel_requested: bool,
    ) {
        let elapsed_ms = self.elapsed_ms();
        let slow = elapsed_ms >= EXEC_OPERATION_STAGE_SLOW_THRESHOLD.as_millis();
        let stdout_truncated = exec_operation_captured_output_truncated(result.stdout);
        let stderr_truncated = exec_operation_captured_output_truncated(result.stderr);
        // Bounded OOM metadata shares this transport with real diagnostics, so
        // classify on the residual. Only metadata counts are logged here; the
        // payload itself belongs to the evidence upload.
        let split = guest_contracts::oom_evidence::split_diagnostic(result.diagnostic);
        let diagnostic_present = split.is_actionable();
        let evidence_has_proof = split.has_proof();
        let evidence_malformed = split.malformed_lines > 0;
        let oom_evidence = split.evidence.is_some();
        let contained_tool_oom = self.process_class == ExecProcessRole::Agent.process_class()
            && lifecycle == ExecTerminalLogLifecycle::Supervised
            && split.evidence.as_ref().is_some_and(|evidence| {
                evidence.operation_sequence() == Some(self.seq)
                    && evidence.proves_contained_tool_oom()
            });
        let oom_classification = if contained_tool_oom {
            "contained_tool_oom"
        } else {
            "unproven_containment"
        };
        // Parse identity before logging so malformed payload text never becomes
        // an unbounded log field. The owning Runner supplies run_id separately.
        let operation_id = split
            .evidence
            .as_ref()
            .and_then(|evidence| uuid::Uuid::parse_str(&evidence.operation_id).ok());
        let oom_incidents = split
            .evidence
            .as_ref()
            .map_or(0, |evidence| evidence.incidents.len());
        let oom_kernel_events = split.evidence.as_ref().map_or(0, |evidence| {
            evidence
                .incidents
                .iter()
                .map(|incident| incident.kernel_events.len())
                .sum::<usize>()
        });
        let oom_dropped_incidents = split
            .evidence
            .as_ref()
            .map_or(0, |evidence| evidence.dropped_incidents);
        let Some(decision) = exec_terminal_log_decision(ExecTerminalLogContext {
            label: &self.label_log,
            lifecycle,
            timeout_is_expected: self.timeout_is_expected,
            slow,
            termination: result.termination,
            stdout_truncated,
            stderr_truncated,
            stream_overflowed,
            actionable_diagnostic: diagnostic_present,
            evidence_has_proof,
            contained_tool_oom,
            evidence_malformed,
            host_cancel_requested,
        }) else {
            return;
        };
        let terminal_reason = decision.reason.as_str();

        macro_rules! emit_terminal_result_log {
            ($level:expr $(, $field:ident = $value:expr)*) => {
                tracing::event!(
                    $level,
                    $($field = $value,)*
                    seq = self.seq,
                    label = %self.label_log,
                    elapsed_ms,
                    slow,
                    lifecycle = lifecycle.as_str(),
                    terminal_reason,
                    guest_duration_ms = result.duration_ms,
                    termination = ?result.termination,
                    stream_overflowed,
                    stdout_truncated,
                    stderr_truncated,
                    diagnostic_present,
                    oom_evidence,
                    operation_id = ?operation_id,
                    oom_classification,
                    oom_evidence_proof = evidence_has_proof,
                    oom_evidence_malformed = evidence_malformed,
                    oom_incidents,
                    oom_kernel_events,
                    oom_dropped_incidents,
                    host_cancel_requested,
                    process_class = self.process_class,
                    operation_kind = self.operation_kind,
                    "exec operation terminal result"
                )
            };
        }

        match decision.severity {
            ExecTerminalLogSeverity::Info
                if decision.reason == ExecTerminalLogReason::Slow
                    && lifecycle == ExecTerminalLogLifecycle::OneShot =>
            {
                // Preserve this bounded latency observation in Axiom without
                // admitting unrelated informational terminal events.
                emit_terminal_result_log!(tracing::Level::INFO, storage_download_latency = true)
            }
            ExecTerminalLogSeverity::Info => emit_terminal_result_log!(tracing::Level::INFO),
            ExecTerminalLogSeverity::Warn => emit_terminal_result_log!(tracing::Level::WARN),
        }
    }

    pub(in crate::exec_operation) fn log_error_response(&self, error: &io::Error) {
        tracing::warn!(
            seq = self.seq,
            label = %self.label_log,
            elapsed_ms = self.elapsed_ms(),
            error = %error,
            process_class = self.process_class,
            operation_kind = self.operation_kind,
            "exec operation error response"
        );
    }
}

pub(in crate::exec_operation) fn exec_termination_requires_low_level_warning(
    termination: ExecTermination,
) -> bool {
    match termination {
        ExecTermination::Exited { .. } => false,
        ExecTermination::TimedOut
        | ExecTermination::Cancelled
        | ExecTermination::StartFailed
        | ExecTermination::WaitFailed => true,
    }
}

pub(in crate::exec_operation) fn exec_terminal_cancel_is_expected(
    context: ExecTerminalLogContext<'_>,
) -> bool {
    matches!(context.termination, ExecTermination::Cancelled)
        && context.host_cancel_requested
        && !context.stdout_truncated
        && !context.stderr_truncated
        && !context.stream_overflowed
        && !context.actionable_diagnostic
        && !context.evidence_malformed
        && !context.evidence_has_proof
}

pub(in crate::exec_operation) fn exec_terminal_log_lifecycle(
    lifecycle: &ExecOperationLifecycle,
) -> ExecTerminalLogLifecycle {
    match lifecycle {
        ExecOperationLifecycle::OneShot => ExecTerminalLogLifecycle::OneShot,
        ExecOperationLifecycle::SupervisedAwaitingStart { .. }
        | ExecOperationLifecycle::SupervisedAwaitingAgentReady { .. }
        | ExecOperationLifecycle::SupervisedStarted { .. } => ExecTerminalLogLifecycle::Supervised,
    }
}

#[cfg(test)]
pub(in crate::exec_operation) fn exec_terminal_log_severity(
    context: ExecTerminalLogContext<'_>,
) -> Option<ExecTerminalLogSeverity> {
    exec_terminal_log_decision(context).map(|decision| decision.severity)
}

pub(in crate::exec_operation) fn exec_terminal_log_decision(
    context: ExecTerminalLogContext<'_>,
) -> Option<ExecTerminalLogDecision> {
    if exec_terminal_cancel_is_expected(context) {
        return Some(ExecTerminalLogDecision {
            severity: ExecTerminalLogSeverity::Info,
            reason: ExecTerminalLogReason::ExpectedCancel,
        });
    }

    if context.timeout_is_expected
        && matches!(context.termination, ExecTermination::TimedOut)
        && !context.stdout_truncated
        && !context.stderr_truncated
        && !context.stream_overflowed
        && !context.actionable_diagnostic
        && !context.evidence_malformed
        && !context.evidence_has_proof
    {
        return Some(ExecTerminalLogDecision {
            severity: ExecTerminalLogSeverity::Info,
            reason: ExecTerminalLogReason::ExpectedTimeout,
        });
    }

    let notable = exec_termination_requires_low_level_warning(context.termination)
        || context.stdout_truncated
        || context.stderr_truncated
        || context.stream_overflowed
        || context.actionable_diagnostic
        || context.evidence_malformed;
    if notable {
        return Some(ExecTerminalLogDecision {
            severity: ExecTerminalLogSeverity::Warn,
            reason: ExecTerminalLogReason::Notable,
        });
    }
    if context.evidence_has_proof {
        // A clean process exit permits this informational observation; it does
        // not assert run success. Guest Agent/Runner retain semantic failures.
        let contained = context.contained_tool_oom
            && matches!(
                context.termination,
                ExecTermination::Exited { exit_code: 0 }
            );
        return Some(ExecTerminalLogDecision {
            severity: if contained {
                ExecTerminalLogSeverity::Info
            } else {
                ExecTerminalLogSeverity::Warn
            },
            reason: if contained {
                ExecTerminalLogReason::ContainedToolOom
            } else {
                ExecTerminalLogReason::OomEvidence
            },
        });
    }
    if !context.slow {
        return None;
    }
    let severity = match context.lifecycle {
        ExecTerminalLogLifecycle::OneShot
            if context.label == "storage-download"
                && matches!(
                    context.termination,
                    ExecTermination::Exited { exit_code: 0 }
                )
                && !context.host_cancel_requested =>
        {
            ExecTerminalLogSeverity::Info
        }
        ExecTerminalLogLifecycle::OneShot => ExecTerminalLogSeverity::Warn,
        ExecTerminalLogLifecycle::Supervised => ExecTerminalLogSeverity::Info,
    };
    Some(ExecTerminalLogDecision {
        severity,
        reason: ExecTerminalLogReason::Slow,
    })
}

pub(in crate::exec_operation) fn exec_operation_label_log(label: &str) -> String {
    if label.len() <= EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES {
        return label.to_string();
    }

    let mut end = EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES;
    while !label.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &label[..end])
}

pub(in crate::exec_operation) fn exec_operation_captured_output_truncated(
    output: ExecCapturedOutput<'_>,
) -> bool {
    matches!(
        output,
        ExecCapturedOutput::Captured {
            truncated: true,
            ..
        }
    )
}

pub(crate) fn log_operations_closed(reason: &'static str, snapshot: &ExecOperationCloseSnapshot) {
    if snapshot.active_count == 0 {
        return;
    }

    let active_operations = snapshot
        .operations
        .iter()
        .map(|operation| {
            format!(
                "seq={} label={} elapsed_ms={} process_class={} operation_kind={}",
                operation.seq,
                operation.label_log,
                operation.elapsed_ms,
                operation.process_class,
                operation.operation_kind
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let active_omitted = snapshot
        .active_count
        .saturating_sub(snapshot.operations.len());
    tracing::warn!(
        reason = reason,
        active_count = snapshot.active_count,
        active_omitted,
        active_operations = %active_operations,
        "closing connection with active exec operations"
    );
}
