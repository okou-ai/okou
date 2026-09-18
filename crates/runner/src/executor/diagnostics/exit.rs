use guest_contracts::diagnostics::{
    CliObservedExitDiagnostic, FailureClass, FailureDetailSource, FailureDiagnostic,
};
use sandbox::ExecTermination;
use tracing::info;

use super::super::session_restore::SessionRestoreDiagnostics;
use super::super::{EXIT_SIGKILL, EXIT_SIGNAL_KILL, ResourceFailureKind, SandboxReuseResult};
use super::environment::{AgentEnvDiagnostics, AgentEnvKeyDiagnostics};
use super::stdout_stream::AgentStdoutStreamDiagnostics;
use crate::ids::RunId;

pub(in crate::executor) fn should_collect_agent_abnormal_exit_diagnostics(
    wait_cancelled: bool,
    exit: &sandbox::ProcessExit,
    stderr: &str,
    failure_diagnostic: Option<&FailureDiagnostic>,
    guest_error: Option<&str>,
) -> bool {
    let unexplained_failure = exit.diagnostic.is_empty()
        && stderr.is_empty()
        && failure_diagnostic.is_none()
        && guest_error.is_none();
    let explicit_enospc = explicit_enospc_evidence([
        stderr,
        exit.diagnostic.as_str(),
        guest_error.unwrap_or_default(),
    ]);

    !wait_cancelled && process_failed(exit) && (unexplained_failure || explicit_enospc)
}

pub(in crate::executor) fn explicit_enospc_evidence<'a>(
    values: impl IntoIterator<Item = &'a str>,
) -> bool {
    values.into_iter().any(|value| {
        let value = value.to_ascii_lowercase();
        value.contains("no space left on device") || value.contains("os error 28")
    })
}

pub(in crate::executor) fn should_collect_unattributed_sigkill_resource_diagnostics(
    wait_cancelled: bool,
    exit: &sandbox::ProcessExit,
    failure_diagnostic: Option<&FailureDiagnostic>,
) -> bool {
    let ExecTermination::Exited { exit_code } = exit.termination else {
        return false;
    };

    !wait_cancelled
        && exit_code != 0
        && exit.diagnostic.is_empty()
        && failure_diagnostic
            .is_some_and(|diagnostic| unattributed_sigkill_cli_failure(diagnostic, exit_code))
}

pub(in crate::executor) fn failure_diagnostic_reports_workload_memory_oom(
    diagnostic: Option<&FailureDiagnostic>,
) -> bool {
    diagnostic
        .and_then(|diagnostic| diagnostic.workload_resource_limit.as_ref())
        .is_some_and(|limit| {
            limit.memory_oom_events > 0
                || limit.memory_oom_kill_events > 0
                || limit.memory_oom_group_kill_events > 0
        })
}

fn unattributed_sigkill_cli_failure(diagnostic: &FailureDiagnostic, exit_code: i32) -> bool {
    diagnostic.failure_class == FailureClass::CliNonzero
        && diagnostic.cli_exit_code == Some(exit_code)
        && diagnostic.cli_termination.is_none()
        && diagnostic.failure_detail_source == Some(FailureDetailSource::FallbackExitCode)
        && diagnostic
            .cli_observed_exit
            .as_ref()
            .is_some_and(|observed_exit| {
                observed_sigkill_matches_exit_code(observed_exit, exit_code)
            })
        && !failure_diagnostic_reports_workload_memory_oom(Some(diagnostic))
}

fn observed_sigkill_matches_exit_code(
    observed_exit: &CliObservedExitDiagnostic,
    exit_code: i32,
) -> bool {
    observed_exit.is_sigkill()
        && observed_exit.exit_code.is_none()
        && observed_exit.signal_number == Some(EXIT_SIGNAL_KILL)
        && observed_exit.mapped_exit_code == EXIT_SIGKILL
        && exit_code == EXIT_SIGKILL
}

pub(in crate::executor) fn should_log_agent_bootstrap_abnormal_exit_diagnostics(
    wait_cancelled: bool,
    exit: &sandbox::ProcessExit,
    failure_diagnostic: Option<&FailureDiagnostic>,
    guest_error: Option<&str>,
) -> bool {
    !wait_cancelled
        && process_exited_nonzero(exit)
        && failure_diagnostic.is_none()
        && guest_error.is_none()
}

fn process_failed(exit: &sandbox::ProcessExit) -> bool {
    !matches!(exit.termination, ExecTermination::Exited { exit_code: 0 })
}

fn process_exited_nonzero(exit: &sandbox::ProcessExit) -> bool {
    matches!(exit.termination, ExecTermination::Exited { exit_code } if exit_code != 0)
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

pub(in crate::executor) fn log_agent_process_exit_summary(
    run_id: RunId,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
    exit: &sandbox::ProcessExit,
    env_diagnostics: &AgentEnvDiagnostics,
    stdout_stream_diagnostics: AgentStdoutStreamDiagnostics,
) {
    info!(
        run_id = %run_id,
        sandbox_id = %sandbox_id,
        sandbox_reuse_result = reuse_result.as_wire(),
        termination = ?exit.termination,
        exit_code = ?process_exit_code(exit),
        stdout_len = exit.stdout.len(),
        stderr_len = exit.stderr.len(),
        stdout_truncated = exit.stdout_truncated,
        stderr_truncated = exit.stderr_truncated,
        stdout_stream_bytes = stdout_stream_diagnostics.bytes_written,
        stdout_stream_incomplete = stdout_stream_diagnostics.stream_incomplete,
        diagnostic_present = !exit.diagnostic.is_empty(),
        stream_overflowed = exit.stream_overflowed,
        env_count = env_diagnostics.env_count,
        env_bytes = env_diagnostics.env_bytes,
        largest_env_value_lengths = %env_diagnostics.largest_entries_csv(),
        suspicious_env_keys = %env_diagnostics.suspicious_keys_csv(),
        "agent process exit summary"
    );
}

pub(in crate::executor) fn log_agent_abnormal_exit_env_diagnostics(
    run_id: RunId,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
    exit: &sandbox::ProcessExit,
    env_diagnostics: &AgentEnvDiagnostics,
    env_key_diagnostics: &AgentEnvKeyDiagnostics,
    resource_failure_kind: Option<ResourceFailureKind>,
) {
    macro_rules! emit_diagnostics {
        ($level:expr) => {
            tracing::event!(
                $level,
                run_id = %run_id,
                sandbox_id = %sandbox_id,
                sandbox_reuse_result = reuse_result.as_wire(),
                termination = ?exit.termination,
                exit_code = ?process_exit_code(exit),
                env_count = env_diagnostics.env_count,
                env_bytes = env_diagnostics.env_bytes,
                runner_owned_env_count = env_diagnostics.runner_owned_count,
                external_env_count = env_diagnostics.external_count,
                largest_env_value_lengths = %env_diagnostics.largest_entries_csv(),
                suspicious_env_keys = %env_diagnostics.suspicious_keys_csv(),
                env_keys = %env_key_diagnostics.logged_keys_csv(),
                omitted_env_key_count = env_key_diagnostics.omitted_key_count,
                resource_failure_kind = resource_failure_kind.map(ResourceFailureKind::as_str),
                "agent abnormal exit env diagnostics"
            );
        };
    }
    if resource_failure_kind == Some(ResourceFailureKind::GuestRootFilesystemFull) {
        emit_diagnostics!(tracing::Level::INFO);
    } else {
        emit_diagnostics!(tracing::Level::WARN);
    }
}

pub(in crate::executor) struct AgentBootstrapAbnormalExitLogContext<'a> {
    pub(in crate::executor) run_id: RunId,
    pub(in crate::executor) sandbox_id: &'a str,
    pub(in crate::executor) reuse_result: SandboxReuseResult,
    pub(in crate::executor) exit: &'a sandbox::ProcessExit,
    pub(in crate::executor) env_diagnostics: &'a AgentEnvDiagnostics,
    pub(in crate::executor) env_key_diagnostics: &'a AgentEnvKeyDiagnostics,
    pub(in crate::executor) stdout_stream_diagnostics: AgentStdoutStreamDiagnostics,
    pub(in crate::executor) session_restore_diagnostics: Option<&'a SessionRestoreDiagnostics>,
    pub(in crate::executor) resource_failure_kind: Option<ResourceFailureKind>,
}

pub(in crate::executor) fn log_agent_bootstrap_abnormal_exit_diagnostics(
    context: AgentBootstrapAbnormalExitLogContext<'_>,
) {
    let resume_session_framework = context
        .session_restore_diagnostics
        .map(|diagnostics| diagnostics.framework)
        .unwrap_or("none");
    let resume_session_id = context
        .session_restore_diagnostics
        .map(|diagnostics| diagnostics.session_id.as_str())
        .unwrap_or("");
    let resume_session_bytes_in = context
        .session_restore_diagnostics
        .map(|diagnostics| diagnostics.bytes_in);

    macro_rules! emit_diagnostics {
        ($level:expr) => {
            tracing::event!(
                $level,
                run_id = %context.run_id,
                sandbox_id = %context.sandbox_id,
                sandbox_reuse_result = context.reuse_result.as_wire(),
                termination = ?context.exit.termination,
                exit_code = ?process_exit_code(context.exit),
                stdout_len = context.exit.stdout.len(),
                stderr_len = context.exit.stderr.len(),
                stdout_truncated = context.exit.stdout_truncated,
                stderr_truncated = context.exit.stderr_truncated,
                stdout_stream_bytes = context.stdout_stream_diagnostics.bytes_written,
                stdout_stream_incomplete = context.stdout_stream_diagnostics.stream_incomplete,
                captured_stderr_present = !context.exit.stderr.is_empty(),
                captured_stderr_truncated = context.exit.stderr_truncated,
                diagnostic_present = !context.exit.diagnostic.is_empty(),
                stream_overflowed = context.exit.stream_overflowed,
                env_count = context.env_diagnostics.env_count,
                env_bytes = context.env_diagnostics.env_bytes,
                runner_owned_env_count = context.env_diagnostics.runner_owned_count,
                external_env_count = context.env_diagnostics.external_count,
                largest_env_value_lengths = %context.env_diagnostics.largest_entries_csv(),
                suspicious_env_keys = %context.env_diagnostics.suspicious_keys_csv(),
                env_keys = %context.env_key_diagnostics.logged_keys_csv(),
                omitted_env_key_count = context.env_key_diagnostics.omitted_key_count,
                resume_session_framework = %resume_session_framework,
                resume_session_id = %resume_session_id,
                resume_session_bytes_in = ?resume_session_bytes_in,
                resource_failure_kind = context.resource_failure_kind.map(ResourceFailureKind::as_str),
                "agent bootstrap abnormal exit diagnostics"
            );
        };
    }
    if context.resource_failure_kind == Some(ResourceFailureKind::GuestRootFilesystemFull) {
        emit_diagnostics!(tracing::Level::INFO);
    } else {
        emit_diagnostics!(tracing::Level::WARN);
    }
}
