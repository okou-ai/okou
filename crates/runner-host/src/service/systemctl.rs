use std::process::{ExitStatus, Output};
use std::time::Duration;

use crate::bounded_command::{
    BoundedCommandError, BoundedCommandOutcome, CommandOutputPolicy, run_bounded,
    run_output_bounded,
};
use crate::error::{HostError, HostResult};

use super::target::RunnerServiceUnit;

mod output;

pub use output::{
    CleanupUnitActiveState, ServiceUnitState, SystemdReloadState, SystemdUnitEnablement,
};
use output::{
    SystemdEnablementRestoreAction, cleanup_unit_active_state_from_output,
    parse_systemctl_show_output, service_main_process_from_output,
    service_restart_policy_from_systemctl_show, service_unit_state_from_output,
    systemd_reload_state_from_output, unit_active_from_systemctl_show,
    unit_content_from_systemctl_cat, unit_enablement_from_systemctl_is_enabled,
};

const SYSTEMCTL_QUERY_TIMEOUT: Duration = Duration::from_secs(10);

pub fn journalctl_logs_status(svc: &str, status: ExitStatus) -> HostResult<()> {
    if status.success() {
        return Ok(());
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;

        // Preserve normal Unix pipeline behavior: `runner service logs | head`
        // can close stdout early, causing journalctl to terminate with SIGPIPE.
        if status.signal() == Some(libc::SIGPIPE) {
            return Ok(());
        }
    }

    Err(HostError::Internal(format!(
        "journalctl for {svc} exited with {status}"
    )))
}

/// Run `systemctl <args>` and check exit status.
pub async fn run_systemctl(args: &[&str]) -> HostResult<()> {
    let status = tokio::process::Command::new("systemctl")
        .args(args)
        .status()
        .await
        .map_err(|e| HostError::Internal(format!("spawn systemctl: {e}")))?;
    if !status.success() {
        return Err(HostError::Internal(format!(
            "systemctl {args:?} exited with {status}"
        )));
    }
    Ok(())
}

#[derive(Debug)]
pub enum BoundedSystemctlOutcome {
    Success,
    Failed(ExitStatus),
    TimedOut,
}

#[derive(Debug)]
pub enum BoundedSystemctlQuery<T> {
    Completed(T),
    TimedOut,
}

/// Run `systemctl <args>` with a caller-supplied deadline.
///
/// Timeout is a cleanup policy boundary, not normal service behavior. Existing
/// service commands should keep using [`run_systemctl`] unless they explicitly
/// need bounded recovery semantics.
pub async fn run_systemctl_bounded(
    args: &[&str],
    duration: Duration,
) -> HostResult<BoundedSystemctlOutcome> {
    let mut command = tokio::process::Command::new("systemctl");
    command.args(args);
    match run_bounded(command, "systemctl", duration)
        .await
        .map_err(|error| bounded_command_error("systemctl", error))?
    {
        BoundedCommandOutcome::Exited(status) if status.success() => {
            Ok(BoundedSystemctlOutcome::Success)
        }
        BoundedCommandOutcome::Exited(status) => Ok(BoundedSystemctlOutcome::Failed(status)),
        BoundedCommandOutcome::TimedOut => Ok(BoundedSystemctlOutcome::TimedOut),
    }
}

pub async fn run_systemctl_output_bounded(args: &[&str], duration: Duration) -> HostResult<Output> {
    match run_systemctl_output_bounded_query(args, duration).await? {
        BoundedSystemctlQuery::Completed(output) => Ok(output),
        BoundedSystemctlQuery::TimedOut => Err(systemctl_timeout_error(duration)),
    }
}

async fn run_systemctl_output_bounded_query(
    args: &[&str],
    duration: Duration,
) -> HostResult<BoundedSystemctlQuery<Output>> {
    let mut command = tokio::process::Command::new("systemctl");
    command.args(args);
    match run_output_bounded(
        command,
        "systemctl",
        CommandOutputPolicy::semantic_stdout(),
        duration,
    )
    .await
    .map_err(|error| bounded_command_error("systemctl", error))?
    {
        BoundedCommandOutcome::Exited(output) => Ok(BoundedSystemctlQuery::Completed(output)),
        BoundedCommandOutcome::TimedOut => Ok(BoundedSystemctlQuery::TimedOut),
    }
}

fn systemctl_timeout_error(duration: Duration) -> HostError {
    HostError::Internal(format!(
        "systemctl timed out after {}ms",
        duration.as_millis()
    ))
}

fn bounded_command_error(program: &str, error: BoundedCommandError) -> HostError {
    match error {
        BoundedCommandError::Spawn(error) => {
            HostError::Internal(format!("spawn {program}: {error}"))
        }
        BoundedCommandError::Wait(error) => HostError::Internal(format!("wait {program}: {error}")),
        BoundedCommandError::Lifecycle(message) => HostError::Internal(message),
        BoundedCommandError::OutputTooLarge { stream, limit } => HostError::Internal(format!(
            "{program} {stream} exceeded output limit of {limit} bytes"
        )),
    }
}

/// Check whether a systemd unit is active for normal health checks.
///
/// Returns `true` for the `ActiveState` values `active`, `activating`,
/// `reloading`, and `refreshing`. `deactivating` intentionally returns `false`
/// because a unit that has begun shutdown is no longer runnable.
///
/// Cleanup callers must use [`cleanup_unit_active_state`] or its bounded variant.
/// These treat `deactivating` as active-like so cleanup can wait or escalate instead of
/// reporting success before the unit is fully inactive.
pub async fn is_unit_active(unit: &RunnerServiceUnit) -> HostResult<bool> {
    let svc = unit.service_name();
    let properties = ["LoadState", "ActiveState"];
    let output = run_systemctl_show(svc, &properties).await?;
    let values = parse_systemctl_show_output(svc, &properties, &output)?;
    unit_active_from_systemctl_show(svc, &properties, &output.status, &values, &output.stderr)
}

/// Check normal service activity while bounding the systemd query itself.
pub async fn is_unit_active_bounded(
    unit: &RunnerServiceUnit,
    duration: Duration,
) -> HostResult<bool> {
    match is_unit_active_bounded_query(unit, duration).await? {
        BoundedSystemctlQuery::Completed(active) => Ok(active),
        BoundedSystemctlQuery::TimedOut => Err(systemctl_timeout_error(duration)),
    }
}

pub async fn is_unit_active_bounded_query(
    unit: &RunnerServiceUnit,
    duration: Duration,
) -> HostResult<BoundedSystemctlQuery<bool>> {
    let svc = unit.service_name();
    let properties = ["LoadState", "ActiveState"];
    match run_systemctl_show_bounded_query(svc, &properties, duration).await? {
        BoundedSystemctlQuery::Completed(output) => {
            let values = parse_systemctl_show_output(svc, &properties, &output)?;
            unit_active_from_systemctl_show(
                svc,
                &properties,
                &output.status,
                &values,
                &output.stderr,
            )
            .map(BoundedSystemctlQuery::Completed)
        }
        BoundedSystemctlQuery::TimedOut => Ok(BoundedSystemctlQuery::TimedOut),
    }
}

/// Read systemd's authoritative dirty state for reload coalescing.
pub async fn read_systemd_reload_state(unit: &RunnerServiceUnit) -> HostResult<SystemdReloadState> {
    let svc = unit.service_name();
    let properties = ["LoadState", "NeedDaemonReload", "DropInPaths"];
    let output = run_systemctl_show(svc, &properties).await?;
    systemd_reload_state_from_output(svc, &properties, &output)
}

/// Read systemd's authoritative dirty state with cleanup timeout semantics.
pub async fn read_systemd_reload_state_bounded(
    unit: &RunnerServiceUnit,
    duration: Duration,
) -> HostResult<SystemdReloadState> {
    let svc = unit.service_name();
    let properties = ["LoadState", "NeedDaemonReload", "DropInPaths"];
    let output = run_systemctl_show_bounded(svc, &properties, duration).await?;
    systemd_reload_state_from_output(svc, &properties, &output)
}

/// Read the systemd unit state for machine-readable service reporting.
pub async fn read_service_unit_state(unit: &RunnerServiceUnit) -> HostResult<ServiceUnitState> {
    let svc = unit.service_name();
    let properties = ["LoadState", "ActiveState", "SubState", "Result"];
    let output = run_systemctl_show_bounded(svc, &properties, SYSTEMCTL_QUERY_TIMEOUT).await?;
    service_unit_state_from_output(svc, &properties, &output)
}

/// Read the fragment and drop-ins selected by the running systemd manager.
pub(super) async fn cat_unit_content(unit: &RunnerServiceUnit) -> HostResult<String> {
    match cat_unit_content_bounded(unit, SYSTEMCTL_QUERY_TIMEOUT).await? {
        BoundedSystemctlQuery::Completed(content) => Ok(content),
        BoundedSystemctlQuery::TimedOut => Err(systemctl_timeout_error(SYSTEMCTL_QUERY_TIMEOUT)),
    }
}

pub(super) async fn cat_unit_content_bounded(
    unit: &RunnerServiceUnit,
    duration: Duration,
) -> HostResult<BoundedSystemctlQuery<String>> {
    let svc = unit.service_name();
    match run_systemctl_output_bounded_query(&["--no-pager", "cat", "--", svc], duration).await? {
        BoundedSystemctlQuery::Completed(output) => {
            unit_content_from_systemctl_cat(svc, &output).map(BoundedSystemctlQuery::Completed)
        }
        BoundedSystemctlQuery::TimedOut => Ok(BoundedSystemctlQuery::TimedOut),
    }
}

/// Read the systemd ActiveState using cleanup semantics and the default query timeout.
///
/// Normal health checks intentionally treat `deactivating` as inactive because
/// a service that has started shutdown is not runnable. Cleanup must treat
/// `deactivating` as still active-like so recovery waits or escalates instead
/// of reporting success too early.
pub async fn cleanup_unit_active_state(
    unit: &RunnerServiceUnit,
) -> HostResult<CleanupUnitActiveState> {
    cleanup_unit_active_state_bounded(unit, SYSTEMCTL_QUERY_TIMEOUT).await
}

/// Read cleanup activity with a caller-supplied query deadline.
pub async fn cleanup_unit_active_state_bounded(
    unit: &RunnerServiceUnit,
    duration: Duration,
) -> HostResult<CleanupUnitActiveState> {
    let svc = unit.service_name();
    let properties = ["LoadState", "ActiveState"];
    let output = run_systemctl_show_bounded(svc, &properties, duration).await?;
    cleanup_unit_active_state_from_output(svc, &properties, &output)
}

/// Read the unit-file enablement state needed for exact lifecycle rollback.
pub async fn read_unit_enablement(unit: &RunnerServiceUnit) -> HostResult<SystemdUnitEnablement> {
    read_unit_enablement_bounded(unit, SYSTEMCTL_QUERY_TIMEOUT).await
}

pub async fn restore_unit_enablement(
    unit: &RunnerServiceUnit,
    enablement: SystemdUnitEnablement,
) -> HostResult<()> {
    for action in enablement.restore_actions() {
        match action {
            SystemdEnablementRestoreAction::Disable => {
                run_systemctl(&["disable", "--no-reload", unit.service_name()]).await?;
            }
            SystemdEnablementRestoreAction::Enable => {
                run_systemctl(&["enable", "--no-reload", unit.service_name()]).await?;
            }
            SystemdEnablementRestoreAction::EnableRuntime => {
                run_systemctl(&["enable", "--runtime", "--no-reload", unit.service_name()]).await?;
            }
        }
    }
    Ok(())
}

/// Check whether systemd reports a unit file as enabled.
///
/// Returns `true` for both the persistent `enabled` state and the transient
/// `enabled-runtime` state. This does not indicate whether the unit is active
/// or whether it will remain enabled after a reboot.
pub async fn is_unit_enabled(unit: &RunnerServiceUnit) -> HostResult<bool> {
    read_unit_enablement(unit)
        .await
        .map(SystemdUnitEnablement::is_enabled)
}

/// Check whether systemd reports a unit file as enabled.
///
/// Returns `true` for both the persistent `enabled` state and the transient
/// `enabled-runtime` state. This does not indicate whether the unit is active
/// or whether it will remain enabled after a reboot.
pub async fn is_unit_enabled_bounded(
    unit: &RunnerServiceUnit,
    duration: Duration,
) -> HostResult<bool> {
    read_unit_enablement_bounded(unit, duration)
        .await
        .map(SystemdUnitEnablement::is_enabled)
}

async fn read_unit_enablement_bounded(
    unit: &RunnerServiceUnit,
    duration: Duration,
) -> HostResult<SystemdUnitEnablement> {
    let svc = unit.service_name();
    let output = run_systemctl_output_bounded(&["is-enabled", svc], duration).await?;
    unit_enablement_from_systemctl_is_enabled(svc, &output.status, &output.stdout, &output.stderr)
}

/// Check whether systemd currently reports a main process for a unit.
pub async fn has_service_main_process(unit: &RunnerServiceUnit) -> HostResult<bool> {
    let svc = unit.service_name();
    let properties = ["LoadState", "MainPID"];
    let output = run_systemctl_show(svc, &properties).await?;
    service_main_process_from_output(svc, &properties, &output)
}

/// Check for a systemd main process while bounding the query and child cleanup.
pub async fn has_service_main_process_bounded(
    unit: &RunnerServiceUnit,
    duration: Duration,
) -> HostResult<bool> {
    let svc = unit.service_name();
    let properties = ["LoadState", "MainPID"];
    let output = run_systemctl_show_bounded(svc, &properties, duration).await?;
    service_main_process_from_output(svc, &properties, &output)
}

/// Get the effective systemd Restart policy of a service unit.
pub async fn get_service_restart_policy(unit: &RunnerServiceUnit) -> HostResult<String> {
    let svc = unit.service_name();
    let properties = ["Restart"];
    let output = run_systemctl_show(svc, &properties).await?;
    let values = parse_systemctl_show_output(svc, &properties, &output)?;
    service_restart_policy_from_systemctl_show(
        svc,
        &properties,
        &output.status,
        &values,
        &output.stderr,
    )
}

async fn run_systemctl_show(svc: &str, properties: &[&str]) -> HostResult<Output> {
    let mut cmd = tokio::process::Command::new("systemctl");
    cmd.args(["show", svc]);
    for property in properties {
        cmd.arg(format!("--property={property}"));
    }
    cmd.output()
        .await
        .map_err(|e| HostError::Internal(format!("spawn systemctl show: {e}")))
}

async fn run_systemctl_show_bounded(
    svc: &str,
    properties: &[&str],
    duration: Duration,
) -> HostResult<Output> {
    match run_systemctl_show_bounded_query(svc, properties, duration).await? {
        BoundedSystemctlQuery::Completed(output) => Ok(output),
        BoundedSystemctlQuery::TimedOut => Err(systemctl_timeout_error(duration)),
    }
}

async fn run_systemctl_show_bounded_query(
    svc: &str,
    properties: &[&str],
    duration: Duration,
) -> HostResult<BoundedSystemctlQuery<Output>> {
    let mut args = vec!["show".to_string(), svc.to_string()];
    for property in properties {
        args.push(format!("--property={property}"));
    }
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_systemctl_output_bounded_query(&arg_refs, duration).await
}

#[cfg(test)]
mod tests;
