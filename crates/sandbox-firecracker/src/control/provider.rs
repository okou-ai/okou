use std::io;
use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use sandbox::{
    RemoteExecResult, RemoteKillResult, SandboxControl, SandboxControlError, SandboxControlTarget,
};

use super::CONTROL_SOCKET_OVERHEAD_MS;
use super::client::{send_exec, send_terminate};
use super::exec_response::ExecResult;
use super::protocol::{
    ExecRequest, TerminateAction, TerminateRequest, TerminateResponse, TerminateStatus,
};
use super::resolver::resolve_control_socket;
use crate::paths::RuntimePaths;

/// Firecracker-backed sandbox control.
///
/// Stateless - can be created with zero cost and used immediately.
///
/// # Remote exec timeouts
///
/// Remote exec requires a positive timeout after normalization to whole
/// seconds. Fractional seconds are truncated, so 1,500 milliseconds becomes
/// one second, while a positive duration below one second becomes zero and is
/// rejected before guest execution. The control server's saturating
/// seconds-to-milliseconds conversion caps the effective command timeout at
/// `u32::MAX` milliseconds (about 49.7 days).
///
/// The control path adds five seconds to its host-side wait budget. That
/// overhead does not extend the guest command timeout.
pub struct FirecrackerControl;

#[async_trait]
impl SandboxControl for FirecrackerControl {
    async fn exec_remote(
        &self,
        target: SandboxControlTarget,
        command: &str,
        timeout: Duration,
        sudo: bool,
    ) -> Result<RemoteExecResult, SandboxControlError> {
        let sandbox_id = target.sandbox_id();
        if sandbox_id.is_empty() {
            return Err(SandboxControlError::NotFound(
                "sandbox id must not be empty".into(),
            ));
        }

        let sock_path = resolve_control_socket(sandbox_id)?;

        let timeout_secs = request_timeout_secs(timeout);
        let request = ExecRequest {
            expected_run_id: target.expected_run_id().map(str::to_owned),
            command: command.to_owned(),
            timeout_secs,
            sudo,
        };

        // Add 5 seconds for control socket overhead beyond the command timeout.
        let response = send_exec(&sock_path, &request, control_timeout(timeout_secs))
            .await
            .map_err(|e| {
                if e.kind() == io::ErrorKind::InvalidInput {
                    SandboxControlError::Io(e)
                } else {
                    SandboxControlError::Connection(format!("failed to connect to sandbox: {e}"))
                }
            })?;

        remote_exec_result_from_result(response)
    }

    async fn kill_remote(
        &self,
        target: SandboxControlTarget,
    ) -> Result<RemoteKillResult, SandboxControlError> {
        let sandbox_id = target.sandbox_id();
        if sandbox_id.is_empty() {
            return Err(SandboxControlError::NotFound(
                "sandbox id must not be empty".into(),
            ));
        }

        let sock_path = resolve_control_socket(sandbox_id)?;
        let request = TerminateRequest {
            action: TerminateAction::Terminate,
            expected_run_id: target.expected_run_id().map(str::to_owned),
        };

        let response = send_terminate(&sock_path, &request, Duration::from_secs(5))
            .await
            .map_err(|e| {
                if e.kind() == io::ErrorKind::InvalidInput {
                    SandboxControlError::Io(e)
                } else {
                    SandboxControlError::Connection(format!("failed to connect to sandbox: {e}"))
                }
            })?;

        match response {
            TerminateResponse::Status {
                status: TerminateStatus::Accepted,
            } => Ok(RemoteKillResult::Accepted),
            TerminateResponse::Status {
                status: TerminateStatus::AlreadyStopped,
            } => Ok(RemoteKillResult::AlreadyStopped),
            TerminateResponse::Status {
                status: TerminateStatus::RefusedIdle,
            } => Ok(RemoteKillResult::RefusedIdle),
            TerminateResponse::Error { error } => Err(SandboxControlError::Remote(error)),
        }
    }

    fn runtime_dir(&self, sandbox_id: &str) -> PathBuf {
        RuntimePaths::new().sock_dir(sandbox_id)
    }
}

fn remote_exec_result_from_result(
    result: ExecResult,
) -> Result<RemoteExecResult, SandboxControlError> {
    match result {
        ExecResult::Success {
            termination,
            stdout,
            stderr,
            stdout_truncated,
            stderr_truncated,
            diagnostic,
        } => Ok(RemoteExecResult {
            termination,
            stdout,
            stderr,
            diagnostic,
            stdout_truncated,
            stderr_truncated,
        }),
        ExecResult::Error { error } => Err(SandboxControlError::Remote(error)),
    }
}

fn request_timeout_secs(timeout: Duration) -> u32 {
    u32::try_from(timeout.as_secs()).unwrap_or(u32::MAX)
}

fn control_timeout(timeout_secs: u32) -> Duration {
    // Match control server's timeout_secs -> saturated timeout_ms conversion.
    let timeout_ms = timeout_secs.saturating_mul(1000);
    Duration::from_millis(u64::from(timeout_ms) + CONTROL_SOCKET_OVERHEAD_MS)
}

#[cfg(test)]
mod tests;
