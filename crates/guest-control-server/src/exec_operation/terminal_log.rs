//! Existing Guest exec terminal-record eligibility, severity, and rendering.
//! The lifecycle caller owns emission timing relative to cleanup and publication.

use std::time::{Duration, Instant};

use guest_control_proto::ExecTermination;

use super::{ExecOperationLifecycle, ExecOperationWorkerRequest};
use crate::drain::BoundedDrainResult;
use crate::log::log;
use crate::shell_command::truncate_command_preview;

const EXEC_OPERATION_STAGE_SLOW_THRESHOLD: Duration = Duration::from_secs(5);

pub(super) fn exec_termination_is_notable(
    termination: ExecTermination,
    expected_exit_codes: &[i32],
) -> bool {
    !matches!(
        termination,
        ExecTermination::Exited { exit_code }
            if exit_code == 0 || expected_exit_codes.contains(&exit_code)
    )
}

fn exec_terminal_log_reason(
    slow: bool,
    notable: bool,
    oom_evidence_proof: bool,
    contained_tool_oom: bool,
) -> Option<&'static str> {
    if notable {
        return Some("notable");
    }
    if oom_evidence_proof {
        return Some(if contained_tool_oom {
            "contained_tool_oom"
        } else {
            "oom_evidence"
        });
    }
    if slow {
        return Some("slow");
    }
    None
}

pub(super) struct ExecTerminalLogMessageInput<'a> {
    pub(super) request: &'a ExecOperationWorkerRequest,
    pub(super) elapsed_ms: u128,
    pub(super) termination: ExecTermination,
    pub(super) stdout_result: &'a BoundedDrainResult,
    pub(super) stderr_result: &'a BoundedDrainResult,
    pub(super) diagnostic_present: bool,
    pub(super) oom_evidence: bool,
    pub(super) oom_evidence_proof: bool,
    pub(super) contained_tool_oom: bool,
    pub(super) slow: bool,
    pub(super) notable: bool,
}

pub(super) fn exec_terminal_log_message(input: ExecTerminalLogMessageInput<'_>) -> Option<String> {
    let terminal_reason = exec_terminal_log_reason(
        input.slow,
        input.notable,
        input.oom_evidence_proof,
        input.contained_tool_oom,
    )?;
    Some(format!(
        "exec result: seq={} label={} process_class={} operation_kind={} elapsed_ms={} slow={} notable={} terminal_reason={} termination={:?} stdout_len={} stderr_len={} stdout_truncated={} stderr_truncated={} diagnostic_present={} oom_evidence={} oom_evidence_proof={}",
        input.request.seq,
        truncate_command_preview(&input.request.label),
        input.request.process_class(),
        input.request.operation_kind(),
        input.elapsed_ms,
        input.slow,
        input.notable,
        terminal_reason,
        input.termination,
        input.stdout_result.captured.as_ref().map_or(0, Vec::len),
        input.stderr_result.captured.as_ref().map_or(0, Vec::len),
        input.stdout_result.capture_truncated,
        input.stderr_result.capture_truncated,
        input.diagnostic_present,
        input.oom_evidence,
        input.oom_evidence_proof,
    ))
}

pub(super) fn exec_terminal_log_message_for_diagnostic(
    request: &ExecOperationWorkerRequest,
    elapsed: Duration,
    termination: ExecTermination,
    stdout_result: &BoundedDrainResult,
    stderr_result: &BoundedDrainResult,
    diagnostic: &str,
) -> Option<(&'static str, String)> {
    let slow = elapsed >= EXEC_OPERATION_STAGE_SLOW_THRESHOLD;
    // The terminal frame also transports bounded OOM metadata. Classify on the
    // residual so an inspected-and-empty capture candidate is not reported as a
    // diagnostic, and keep a broken envelope loud.
    let split = guest_contracts::oom_evidence::split_diagnostic(diagnostic);
    let notable = exec_termination_is_notable(termination, &request.expected_exit_codes)
        || stdout_result.capture_truncated
        || stderr_result.capture_truncated
        || stdout_result.stream_truncated
        || stderr_result.stream_truncated
        || split.is_actionable()
        || split.malformed_lines > 0;

    // Mirror the Host's shared attribution rule; incomplete evidence must not
    // downgrade an unproven or agent-domain OOM to an informational tool OOM.
    let contained_tool_oom = split
        .evidence
        .as_ref()
        .and_then(guest_contracts::oom_evidence::OomEvidence::classification)
        == Some(guest_contracts::oom_evidence::OomClassification::ContainedToolOom);
    let clean_storage_download = slow
        && request.label == "storage-download"
        && request.lifecycle == ExecOperationLifecycle::OneShot
        && matches!(termination, ExecTermination::Exited { exit_code: 0 })
        && !split.has_proof();
    let level = if !notable && (contained_tool_oom || clean_storage_download) {
        "INFO"
    } else {
        "WARN"
    };
    let mut message = exec_terminal_log_message(ExecTerminalLogMessageInput {
        request,
        elapsed_ms: elapsed.as_millis(),
        termination,
        stdout_result,
        stderr_result,
        diagnostic_present: split.is_actionable(),
        oom_evidence: split.evidence.is_some(),
        oom_evidence_proof: split.has_proof(),
        contained_tool_oom,
        slow,
        notable,
    })?;
    if let Some(operation_id) = split
        .evidence
        .as_ref()
        .and_then(|evidence| uuid::Uuid::parse_str(&evidence.operation_id).ok())
    {
        message.push_str(&format!(" operation_id={operation_id}"));
    }
    if let Some(classification) = split
        .evidence
        .as_ref()
        .and_then(guest_contracts::oom_evidence::OomEvidence::classification)
    {
        message.push_str(&format!(" oom_classification={}", classification.as_str()));
    }
    Some((level, message))
}

pub(super) fn log_exec_terminal_if_notable(
    request: &ExecOperationWorkerRequest,
    started: Instant,
    termination: ExecTermination,
    stdout_result: &BoundedDrainResult,
    stderr_result: &BoundedDrainResult,
    diagnostic: &str,
) {
    if let Some((level, message)) = exec_terminal_log_message_for_diagnostic(
        request,
        started.elapsed(),
        termination,
        stdout_result,
        stderr_result,
        diagnostic,
    ) {
        log(level, &message);
    }
}
