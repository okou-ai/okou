use std::process::{ExitStatus, Output};
use std::time::Duration;

use tokio::time::Instant;

use crate::error::{RunnerError, RunnerResult};

use runner_host::service::{
    RunnerServiceUnit, has_service_main_process, has_service_main_process_bounded,
    run_systemctl_output_bounded, status_field_preview,
};

/// Outcome of asking systemd to signal a unit's main process.
///
/// `AlreadyGone` means the delivery command failed and a follow-up systemd
/// query proved that the unit no longer has a main process. Callers retain
/// their distinct policies for that race: drain continues boot-enablement
/// cleanup, while resume rejects an inactive runner.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ServiceSignalOutcome {
    Sent,
    AlreadyGone,
}

/// Ask systemd to send `signal` to the current main process of `unit`.
///
/// Systemd owns the unit's process identity, so resolving and signaling the
/// target inside the manager avoids a caller-side numeric PID reuse race.
pub(super) async fn signal_service_main(
    unit: &RunnerServiceUnit,
    signal: nix::sys::signal::Signal,
) -> RunnerResult<ServiceSignalOutcome> {
    let signal_arg = format!("--signal={}", signal.as_str());
    let output = tokio::process::Command::new("systemctl")
        .args([
            "kill",
            "--kill-whom=main",
            signal_arg.as_str(),
            unit.service_name(),
        ])
        .output()
        .await
        .map_err(|e| {
            RunnerError::Internal(format!(
                "spawn systemctl kill for {}: {e}",
                unit.service_name()
            ))
        })?;

    complete_service_signal(unit, signal, output, None).await
}

/// Ask systemd to signal the current main process within a cleanup deadline.
///
/// Unlike an outer future timeout, the bounded command path kills and reaps a
/// timed-out `systemctl` child before returning.
pub(super) async fn signal_service_main_bounded(
    unit: &RunnerServiceUnit,
    signal: nix::sys::signal::Signal,
    duration: Duration,
) -> RunnerResult<ServiceSignalOutcome> {
    let deadline = Instant::now() + duration;
    let signal_arg = format!("--signal={}", signal.as_str());
    let output = run_systemctl_output_bounded(
        &[
            "kill",
            "--kill-whom=main",
            signal_arg.as_str(),
            unit.service_name(),
        ],
        duration,
    )
    .await
    .map_err(|error| {
        RunnerError::Internal(format!(
            "signal {} with systemctl for {}: {error}",
            signal.as_str(),
            unit.service_name()
        ))
    })?;

    complete_service_signal(unit, signal, output, Some(deadline)).await
}

async fn complete_service_signal(
    unit: &RunnerServiceUnit,
    signal: nix::sys::signal::Signal,
    output: Output,
    deadline: Option<Instant>,
) -> RunnerResult<ServiceSignalOutcome> {
    if output.status.success() {
        return Ok(ServiceSignalOutcome::Sent);
    }

    let signal_error = systemctl_kill_error(unit, signal, output.status, &output.stderr);
    let main_process = match deadline {
        Some(deadline) => {
            let now = Instant::now();
            if now >= deadline {
                return Err(signal_error);
            }
            has_service_main_process_bounded(unit, deadline - now).await
        }
        None => has_service_main_process(unit).await,
    };
    match main_process {
        Ok(false) => Ok(ServiceSignalOutcome::AlreadyGone),
        Ok(true) | Err(_) => Err(signal_error),
    }
}

fn systemctl_kill_error(
    unit: &RunnerServiceUnit,
    signal: nix::sys::signal::Signal,
    status: ExitStatus,
    stderr: &[u8],
) -> RunnerError {
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    let command = format!(
        "systemctl kill --kill-whom=main --signal={} {}",
        signal.as_str(),
        unit.service_name()
    );
    if stderr.is_empty() {
        RunnerError::Internal(format!("{command} exited with {status}"))
    } else {
        RunnerError::Internal(format!(
            "{command} exited with {status}: stderr={:?}",
            status_field_preview(stderr)
        ))
    }
}

#[cfg(test)]
mod tests;
