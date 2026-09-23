//! Runner executor diagnostics and post-job log preservation.
//!
//! This facade keeps the executor-facing diagnostics API narrow while the
//! implementation is split by diagnostic source and side-effect boundary.
//!
//! The submodules own best-effort diagnostics gathered around an agent process:
//! environment key summaries, guest-authored error and failure diagnostic files,
//! in-VM abnormal-exit resource probes, host and guest OOM checks, stdout stream
//! truncation and overflow markers, and post-job guest log copies.
//!
//! Environment diagnostics are deliberately key-only. They may record counts,
//! byte totals, sanitized key names, omitted-key counts, value lengths, and
//! suspicious key names, but they must not log environment values. This keeps
//! operator debugging signals separate from secret-bearing user, model, or
//! connector environment data.
//!
//! Diagnostic collection should not mask the original run result. Failed reads,
//! failed probes, and failed log copies are reported to operator logs when useful
//! and otherwise remain best-effort. User-visible failure enrichment must flow
//! through the existing structured failure fields such as `ExecutionFailure`
//! and `ResourceFailureDiagnostics`.
//!
//! Real-time stdout stream logs and post-job guest log copies preserve different
//! sources. The stream log is host-captured supervised process output; copied
//! guest logs are guest-authored files preserved after the job.

mod environment;
mod exit;
mod guest_files;
mod guest_logs;
mod oom;
mod resource;
mod stdout_stream;

pub(super) use environment::{
    AgentEnvDiagnostics, build_agent_env_diagnostics, build_agent_env_key_diagnostics,
};
pub(super) use exit::{
    AgentBootstrapAbnormalExitLogContext, explicit_enospc_evidence,
    log_agent_abnormal_exit_env_diagnostics, log_agent_bootstrap_abnormal_exit_diagnostics,
    log_agent_process_exit_summary, should_collect_agent_abnormal_exit_diagnostics,
    should_collect_unattributed_sigkill_resource_diagnostics,
    should_log_agent_bootstrap_abnormal_exit_diagnostics,
};
pub(super) use guest_files::{
    read_guest_cli_agent_session_id, read_guest_error_file, read_guest_failure_diagnostic_file,
};
pub(super) use guest_logs::copy_guest_logs;
#[cfg(test)]
pub(super) use guest_logs::{GuestLogCopyFailureKind, guest_log_copy_failure_kind};
#[cfg(test)]
pub(super) use oom::host_dmesg_indicates_oom;
pub(super) use oom::{HostOomEvidenceSince, check_host_oom, host_oom_evidence_since_now};
pub(super) use resource::collect_agent_abnormal_exit_diagnostics;
#[cfg(test)]
pub(super) use resource::parse_agent_abnormal_exit_resource_diagnostics;
pub(super) use stdout_stream::{
    AgentStdoutStreamDiagnostics, StdoutDrainReport,
    append_stdout_stream_diagnostics_to_stream_log, drain_stdout_to_file,
};
#[cfg(test)]
pub(super) use stdout_stream::{StdoutDrainError, append_stdout_stream_diagnostics};
