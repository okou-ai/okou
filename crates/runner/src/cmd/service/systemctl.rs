use std::collections::BTreeMap;
use std::process::{ExitStatus, Output};
use std::time::Duration;

use crate::bounded_command::{
    BoundedCommandError, BoundedCommandOutcome, CommandOutputPolicy, run_bounded,
    run_output_bounded,
};
use crate::error::{RunnerError, RunnerResult};
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use tracing::warn;

use super::diagnostic::status_field_preview;
use super::target::RunnerServiceUnit;

const SYSTEMCTL_QUERY_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) fn journalctl_logs_status(svc: &str, status: ExitStatus) -> RunnerResult<()> {
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

    Err(RunnerError::Internal(format!(
        "journalctl for {svc} exited with {status}"
    )))
}

/// Run `systemctl <args>` and check exit status.
pub(super) async fn run_systemctl(args: &[&str]) -> RunnerResult<()> {
    let status = tokio::process::Command::new("systemctl")
        .args(args)
        .status()
        .await
        .map_err(|e| RunnerError::Internal(format!("spawn systemctl: {e}")))?;
    if !status.success() {
        return Err(RunnerError::Internal(format!(
            "systemctl {args:?} exited with {status}"
        )));
    }
    Ok(())
}

#[derive(Debug)]
pub(super) enum BoundedSystemctlOutcome {
    Success,
    Failed(ExitStatus),
    TimedOut,
}

#[derive(Debug)]
pub(super) enum BoundedSystemctlQuery<T> {
    Completed(T),
    TimedOut,
}

/// Run `systemctl <args>` with a caller-supplied deadline.
///
/// Timeout is a cleanup policy boundary, not normal service behavior. Existing
/// service commands should keep using [`run_systemctl`] unless they explicitly
/// need bounded recovery semantics.
pub(super) async fn run_systemctl_bounded(
    args: &[&str],
    duration: Duration,
) -> RunnerResult<BoundedSystemctlOutcome> {
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

pub(super) async fn run_systemctl_output_bounded(
    args: &[&str],
    duration: Duration,
) -> RunnerResult<Output> {
    match run_systemctl_output_bounded_query(args, duration).await? {
        BoundedSystemctlQuery::Completed(output) => Ok(output),
        BoundedSystemctlQuery::TimedOut => Err(systemctl_timeout_error(duration)),
    }
}

async fn run_systemctl_output_bounded_query(
    args: &[&str],
    duration: Duration,
) -> RunnerResult<BoundedSystemctlQuery<Output>> {
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

fn systemctl_timeout_error(duration: Duration) -> RunnerError {
    RunnerError::Internal(format!(
        "systemctl timed out after {}ms",
        duration.as_millis()
    ))
}

fn bounded_command_error(program: &str, error: BoundedCommandError) -> RunnerError {
    match error {
        BoundedCommandError::Spawn(error) => {
            RunnerError::Internal(format!("spawn {program}: {error}"))
        }
        BoundedCommandError::Wait(error) => {
            RunnerError::Internal(format!("wait {program}: {error}"))
        }
        BoundedCommandError::Lifecycle(message) => RunnerError::Internal(message),
        BoundedCommandError::OutputTooLarge { stream, limit } => RunnerError::Internal(format!(
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
/// Cleanup callers must use `cleanup_unit_active_state_bounded`, which treats
/// `deactivating` as active-like so cleanup can wait or escalate instead of
/// reporting success before the unit is fully inactive.
pub(crate) async fn is_unit_active(unit: &RunnerServiceUnit) -> RunnerResult<bool> {
    let svc = unit.service_name();
    let properties = ["LoadState", "ActiveState"];
    let output = run_systemctl_show(svc, &properties).await?;
    let values = parse_systemctl_show_output(svc, &properties, &output)?;
    unit_active_from_systemctl_show(svc, &properties, &output.status, &values, &output.stderr)
}

/// Check normal service activity while bounding the systemd query itself.
pub(super) async fn is_unit_active_bounded(
    unit: &RunnerServiceUnit,
    duration: Duration,
) -> RunnerResult<bool> {
    match is_unit_active_bounded_query(unit, duration).await? {
        BoundedSystemctlQuery::Completed(active) => Ok(active),
        BoundedSystemctlQuery::TimedOut => Err(systemctl_timeout_error(duration)),
    }
}

pub(super) async fn is_unit_active_bounded_query(
    unit: &RunnerServiceUnit,
    duration: Duration,
) -> RunnerResult<BoundedSystemctlQuery<bool>> {
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SystemdUnitLoadState {
    Stub,
    Loaded,
    NotFound,
    BadSetting,
    Error,
    Merged,
    Masked,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct SystemdReloadState {
    load_state: SystemdUnitLoadState,
    need_daemon_reload: bool,
    drop_in_paths: Vec<String>,
}

impl SystemdReloadState {
    pub(super) fn is_not_found(&self) -> bool {
        self.load_state == SystemdUnitLoadState::NotFound
    }

    pub(super) fn need_daemon_reload(&self) -> bool {
        self.need_daemon_reload
    }

    pub(super) fn has_drop_in_path(&self, path: &std::path::Path) -> bool {
        let path = path.to_string_lossy();
        self.drop_in_paths
            .iter()
            .any(|loaded| loaded == path.as_ref())
    }

    runner_test_support!(cmd_service; #[cfg(test)]
    pub(super) fn for_test(
        is_not_found: bool,
        need_daemon_reload: bool,
        drop_in_paths: Vec<String>,
    ) -> Self {
        Self {
            load_state: if is_not_found {
                SystemdUnitLoadState::NotFound
            } else {
                SystemdUnitLoadState::Loaded
            },
            need_daemon_reload,
            drop_in_paths,
        }
    });
}

/// Read systemd's authoritative dirty state for reload coalescing.
pub(super) async fn read_systemd_reload_state(
    unit: &RunnerServiceUnit,
) -> RunnerResult<SystemdReloadState> {
    let svc = unit.service_name();
    let properties = ["LoadState", "NeedDaemonReload", "DropInPaths"];
    let output = run_systemctl_show(svc, &properties).await?;
    systemd_reload_state_from_output(svc, &properties, &output)
}

/// Read systemd's authoritative dirty state with cleanup timeout semantics.
pub(super) async fn read_systemd_reload_state_bounded(
    unit: &RunnerServiceUnit,
    duration: Duration,
) -> RunnerResult<SystemdReloadState> {
    let svc = unit.service_name();
    let properties = ["LoadState", "NeedDaemonReload", "DropInPaths"];
    let output = run_systemctl_show_bounded(svc, &properties, duration).await?;
    systemd_reload_state_from_output(svc, &properties, &output)
}

fn systemd_reload_state_from_output(
    svc: &str,
    properties: &[&str],
    output: &Output,
) -> RunnerResult<SystemdReloadState> {
    let values = parse_systemctl_show_output(svc, properties, output)?;
    systemd_reload_state_from_systemctl_show(
        svc,
        properties,
        &output.status,
        &values,
        &output.stderr,
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct CleanupUnitActiveState {
    active_state: String,
    active_like: bool,
}

impl CleanupUnitActiveState {
    pub(super) fn active_state(&self) -> &str {
        &self.active_state
    }

    pub(super) fn is_active_like(&self) -> bool {
        self.active_like
    }

    runner_test_support!(cmd_service; #[cfg(test)]
    pub(super) fn for_test(active_state: &str, active_like: bool) -> Self {
        Self {
            active_state: active_state.to_string(),
            active_like,
        }
    });
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum NormalizedUnitState {
    ActiveLike,
    Inactive,
    Failed,
    Maintenance,
    NotFound,
}

impl NormalizedUnitState {
    fn is_active_like(self) -> bool {
        self == Self::ActiveLike
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ServiceUnitState {
    load_state: String,
    active_state: String,
    sub_state: String,
    result: String,
    normalized_state: NormalizedUnitState,
}

impl ServiceUnitState {
    runner_test_support!(cmd_service; #[cfg(test)]
    pub(super) fn for_test(
        load_state: &str,
        active_state: &str,
        sub_state: &str,
        result: &str,
    ) -> Self {
        let normalized_state =
            normalize_unit_state("vm0-runner-test.service", load_state, active_state).unwrap();
        Self {
            load_state: load_state.to_string(),
            active_state: active_state.to_string(),
            sub_state: sub_state.to_string(),
            result: result.to_string(),
            normalized_state,
        }
    });

    fn active_like(&self) -> bool {
        self.normalized_state.is_active_like()
    }

    runner_test_support!(cmd_service; #[cfg(test)]
    fn active_state(&self) -> &str {
        &self.active_state
    });

    runner_test_support!(cmd_service; #[cfg(test)]
    fn is_active_like(&self) -> bool {
        self.active_like()
    });
}

impl Serialize for ServiceUnitState {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("ServiceUnitState", 6)?;
        state.serialize_field("loadState", &self.load_state)?;
        state.serialize_field("activeState", &self.active_state)?;
        state.serialize_field("subState", &self.sub_state)?;
        state.serialize_field("result", &self.result)?;
        state.serialize_field("normalizedState", &self.normalized_state)?;
        state.serialize_field("activeLike", &self.active_like())?;
        state.end()
    }
}

/// Read the systemd unit state for machine-readable service reporting.
pub(super) async fn read_service_unit_state(
    unit: &RunnerServiceUnit,
) -> RunnerResult<ServiceUnitState> {
    let svc = unit.service_name();
    let properties = ["LoadState", "ActiveState", "SubState", "Result"];
    let output = run_systemctl_show_bounded(svc, &properties, SYSTEMCTL_QUERY_TIMEOUT).await?;
    service_unit_state_from_output(svc, &properties, &output)
}

fn service_unit_state_from_output(
    svc: &str,
    properties: &[&str],
    output: &Output,
) -> RunnerResult<ServiceUnitState> {
    let values = parse_systemctl_show_output(svc, properties, output)?;
    service_unit_state_from_systemctl_show(svc, properties, &output.status, &values, &output.stderr)
}

/// Read the fragment and drop-ins selected by the running systemd manager.
pub(super) async fn cat_unit_content(unit: &RunnerServiceUnit) -> RunnerResult<String> {
    match cat_unit_content_bounded(unit, SYSTEMCTL_QUERY_TIMEOUT).await? {
        BoundedSystemctlQuery::Completed(content) => Ok(content),
        BoundedSystemctlQuery::TimedOut => Err(systemctl_timeout_error(SYSTEMCTL_QUERY_TIMEOUT)),
    }
}

pub(super) async fn cat_unit_content_bounded(
    unit: &RunnerServiceUnit,
    duration: Duration,
) -> RunnerResult<BoundedSystemctlQuery<String>> {
    let svc = unit.service_name();
    match run_systemctl_output_bounded_query(&["--no-pager", "cat", "--", svc], duration).await? {
        BoundedSystemctlQuery::Completed(output) => {
            unit_content_from_systemctl_cat(svc, &output).map(BoundedSystemctlQuery::Completed)
        }
        BoundedSystemctlQuery::TimedOut => Ok(BoundedSystemctlQuery::TimedOut),
    }
}

/// Read the systemd ActiveState using cleanup semantics.
///
/// Normal health checks intentionally treat `deactivating` as inactive because
/// a service that has started shutdown is not runnable. Cleanup must treat
/// `deactivating` as still active-like so recovery waits or escalates instead
/// of reporting success too early.
pub(super) async fn cleanup_unit_active_state_bounded(
    unit: &RunnerServiceUnit,
    duration: Duration,
) -> RunnerResult<CleanupUnitActiveState> {
    let svc = unit.service_name();
    let properties = ["LoadState", "ActiveState"];
    let output = run_systemctl_show_bounded(svc, &properties, duration).await?;
    cleanup_unit_active_state_from_output(svc, &properties, &output)
}

fn cleanup_unit_active_state_from_output(
    svc: &str,
    properties: &[&str],
    output: &Output,
) -> RunnerResult<CleanupUnitActiveState> {
    let values = parse_systemctl_show_output(svc, properties, output)?;
    cleanup_unit_active_state_from_systemctl_show(
        svc,
        properties,
        &output.status,
        &values,
        &output.stderr,
    )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum SystemdUnitEnablement {
    Enabled,
    EnabledRuntime,
    NotEnabled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SystemdEnablementRestoreAction {
    Disable,
    Enable,
    EnableRuntime,
}

impl SystemdUnitEnablement {
    fn is_enabled(self) -> bool {
        matches!(self, Self::Enabled | Self::EnabledRuntime)
    }

    fn restore_actions(self) -> &'static [SystemdEnablementRestoreAction] {
        use SystemdEnablementRestoreAction::{Disable, Enable, EnableRuntime};

        match self {
            Self::Enabled => &[Enable],
            Self::EnabledRuntime => &[Disable, EnableRuntime],
            Self::NotEnabled => &[Disable],
        }
    }
}

/// Read the unit-file enablement state needed for exact lifecycle rollback.
pub(super) async fn read_unit_enablement(
    unit: &RunnerServiceUnit,
) -> RunnerResult<SystemdUnitEnablement> {
    read_unit_enablement_bounded(unit, SYSTEMCTL_QUERY_TIMEOUT).await
}

pub(super) async fn restore_unit_enablement(
    unit: &RunnerServiceUnit,
    enablement: SystemdUnitEnablement,
) -> RunnerResult<()> {
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
pub(crate) async fn is_unit_enabled(unit: &RunnerServiceUnit) -> RunnerResult<bool> {
    read_unit_enablement(unit)
        .await
        .map(SystemdUnitEnablement::is_enabled)
}

/// Check whether systemd reports a unit file as enabled.
///
/// Returns `true` for both the persistent `enabled` state and the transient
/// `enabled-runtime` state. This does not indicate whether the unit is active
/// or whether it will remain enabled after a reboot.
pub(super) async fn is_unit_enabled_bounded(
    unit: &RunnerServiceUnit,
    duration: Duration,
) -> RunnerResult<bool> {
    read_unit_enablement_bounded(unit, duration)
        .await
        .map(SystemdUnitEnablement::is_enabled)
}

async fn read_unit_enablement_bounded(
    unit: &RunnerServiceUnit,
    duration: Duration,
) -> RunnerResult<SystemdUnitEnablement> {
    let svc = unit.service_name();
    let output = run_systemctl_output_bounded(&["is-enabled", svc], duration).await?;
    unit_enablement_from_systemctl_is_enabled(svc, &output.status, &output.stdout, &output.stderr)
}

/// Check whether systemd currently reports a main process for a unit.
pub(super) async fn has_service_main_process(unit: &RunnerServiceUnit) -> RunnerResult<bool> {
    let svc = unit.service_name();
    let properties = ["LoadState", "MainPID"];
    let output = run_systemctl_show(svc, &properties).await?;
    service_main_process_from_output(svc, &properties, &output)
}

/// Check for a systemd main process while bounding the query and child cleanup.
pub(super) async fn has_service_main_process_bounded(
    unit: &RunnerServiceUnit,
    duration: Duration,
) -> RunnerResult<bool> {
    let svc = unit.service_name();
    let properties = ["LoadState", "MainPID"];
    let output = run_systemctl_show_bounded(svc, &properties, duration).await?;
    service_main_process_from_output(svc, &properties, &output)
}

fn service_main_process_from_output(
    svc: &str,
    properties: &[&str],
    output: &Output,
) -> RunnerResult<bool> {
    let values = parse_systemctl_show_output(svc, properties, output)?;
    service_main_process_present_from_systemctl_show(
        svc,
        properties,
        &output.status,
        &values,
        &output.stderr,
    )
}

/// Get the effective systemd Restart policy of a service unit.
pub(super) async fn get_service_restart_policy(unit: &RunnerServiceUnit) -> RunnerResult<String> {
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

async fn run_systemctl_show(svc: &str, properties: &[&str]) -> RunnerResult<Output> {
    let mut cmd = tokio::process::Command::new("systemctl");
    cmd.args(["show", svc]);
    for property in properties {
        cmd.arg(format!("--property={property}"));
    }
    cmd.output()
        .await
        .map_err(|e| RunnerError::Internal(format!("spawn systemctl show: {e}")))
}

async fn run_systemctl_show_bounded(
    svc: &str,
    properties: &[&str],
    duration: Duration,
) -> RunnerResult<Output> {
    match run_systemctl_show_bounded_query(svc, properties, duration).await? {
        BoundedSystemctlQuery::Completed(output) => Ok(output),
        BoundedSystemctlQuery::TimedOut => Err(systemctl_timeout_error(duration)),
    }
}

async fn run_systemctl_show_bounded_query(
    svc: &str,
    properties: &[&str],
    duration: Duration,
) -> RunnerResult<BoundedSystemctlQuery<Output>> {
    let mut args = vec!["show".to_string(), svc.to_string()];
    for property in properties {
        args.push(format!("--property={property}"));
    }
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_systemctl_output_bounded_query(&arg_refs, duration).await
}

fn parse_systemctl_show_output(
    svc: &str,
    properties: &[&str],
    output: &Output,
) -> RunnerResult<BTreeMap<String, String>> {
    match parse_systemctl_show_properties(svc, properties, &output.stdout) {
        Ok(values) => Ok(values),
        Err(_) if !output.status.success() => Err(systemctl_show_status_error(
            svc,
            properties,
            &output.status,
            &output.stderr,
        )),
        Err(e) => Err(e),
    }
}

fn parse_systemctl_show_properties(
    svc: &str,
    properties: &[&str],
    stdout: &[u8],
) -> RunnerResult<BTreeMap<String, String>> {
    let stdout = std::str::from_utf8(stdout).map_err(|e| {
        RunnerError::Internal(format!(
            "systemctl show {svc} returned non-UTF-8 output: {e}"
        ))
    })?;
    let mut values = BTreeMap::new();
    for line in stdout.lines().filter(|line| !line.is_empty()) {
        let Some((property, value)) = line.split_once('=') else {
            return Err(RunnerError::Internal(format!(
                "malformed systemctl show output for {svc}: {:?}",
                status_field_preview(line)
            )));
        };
        if !properties.contains(&property) {
            return Err(RunnerError::Internal(format!(
                "unexpected systemctl show property for {svc}: {property}"
            )));
        }
        if values
            .insert(property.to_string(), value.to_string())
            .is_some()
        {
            return Err(RunnerError::Internal(format!(
                "duplicate systemctl show property for {svc}: {property}"
            )));
        }
    }
    for property in properties {
        if !values.contains_key(*property) {
            return Err(RunnerError::Internal(format!(
                "missing systemctl show property for {svc}: {property}"
            )));
        }
    }
    Ok(values)
}

fn required_systemctl_property<'a>(
    svc: &str,
    values: &'a BTreeMap<String, String>,
    property: &str,
) -> RunnerResult<&'a str> {
    let value = values.get(property).ok_or_else(|| {
        RunnerError::Internal(format!(
            "missing systemctl show property for {svc}: {property}"
        ))
    })?;
    let value = value.trim();
    if value.is_empty() {
        return Err(RunnerError::Internal(format!(
            "empty systemctl show property for {svc}: {property}"
        )));
    }
    Ok(value)
}

fn systemctl_property<'a>(
    svc: &str,
    values: &'a BTreeMap<String, String>,
    property: &str,
) -> RunnerResult<&'a str> {
    let value = values.get(property).ok_or_else(|| {
        RunnerError::Internal(format!(
            "missing systemctl show property for {svc}: {property}"
        ))
    })?;
    Ok(value.trim())
}

fn classify_unit_active(svc: &str, load_state: &str, active_state: &str) -> RunnerResult<bool> {
    let normalized_state = normalize_unit_state(svc, load_state, active_state)?;
    Ok(normalized_state.is_active_like() && active_state != "deactivating")
}

fn parse_systemd_unit_load_state(svc: &str, value: &str) -> RunnerResult<SystemdUnitLoadState> {
    match value {
        "stub" => Ok(SystemdUnitLoadState::Stub),
        "loaded" => Ok(SystemdUnitLoadState::Loaded),
        "not-found" => Ok(SystemdUnitLoadState::NotFound),
        "bad-setting" => Ok(SystemdUnitLoadState::BadSetting),
        "error" => Ok(SystemdUnitLoadState::Error),
        "merged" => Ok(SystemdUnitLoadState::Merged),
        "masked" => Ok(SystemdUnitLoadState::Masked),
        other => Err(RunnerError::Internal(format!(
            "unknown LoadState for {svc}: {other:?}"
        ))),
    }
}

fn parse_systemd_boolean(svc: &str, property: &str, value: &str) -> RunnerResult<bool> {
    match value {
        "yes" => Ok(true),
        "no" => Ok(false),
        other => Err(RunnerError::Internal(format!(
            "unknown {property} for {svc}: {other:?}"
        ))),
    }
}

fn systemd_reload_state_from_systemctl_show(
    svc: &str,
    properties: &[&str],
    status: &ExitStatus,
    values: &BTreeMap<String, String>,
    stderr: &[u8],
) -> RunnerResult<SystemdReloadState> {
    let load_state =
        parse_systemd_unit_load_state(svc, required_systemctl_property(svc, values, "LoadState")?)?;
    let need_daemon_reload = parse_systemd_boolean(
        svc,
        "NeedDaemonReload",
        required_systemctl_property(svc, values, "NeedDaemonReload")?,
    )?;
    let drop_in_paths = systemctl_property(svc, values, "DropInPaths")?
        .split_ascii_whitespace()
        .map(str::to_owned)
        .collect();
    ensure_systemctl_show_status(
        svc,
        properties,
        status,
        stderr,
        load_state == SystemdUnitLoadState::NotFound,
    )?;
    Ok(SystemdReloadState {
        load_state,
        need_daemon_reload,
        drop_in_paths,
    })
}

fn normalize_unit_state(
    svc: &str,
    load_state: &str,
    active_state: &str,
) -> RunnerResult<NormalizedUnitState> {
    match active_state {
        "active" | "activating" | "reloading" | "refreshing" | "deactivating" => {
            Ok(NormalizedUnitState::ActiveLike)
        }
        "inactive" | "failed" | "maintenance" if load_state == "not-found" => {
            Ok(NormalizedUnitState::NotFound)
        }
        "inactive" => Ok(NormalizedUnitState::Inactive),
        "failed" => Ok(NormalizedUnitState::Failed),
        "maintenance" => Ok(NormalizedUnitState::Maintenance),
        _ => Err(RunnerError::Internal(format!(
            "unknown ActiveState for {svc}: {active_state} (LoadState={load_state})"
        ))),
    }
}

fn unit_active_from_systemctl_show(
    svc: &str,
    properties: &[&str],
    status: &ExitStatus,
    values: &BTreeMap<String, String>,
    stderr: &[u8],
) -> RunnerResult<bool> {
    let load_state = required_systemctl_property(svc, values, "LoadState")?;
    let active_state = required_systemctl_property(svc, values, "ActiveState")?;
    let active = classify_unit_active(svc, load_state, active_state)?;
    let missing_unit = load_state == "not-found" && !active;
    ensure_systemctl_show_status(svc, properties, status, stderr, missing_unit)?;
    Ok(active)
}

fn cleanup_unit_active_state_from_systemctl_show(
    svc: &str,
    properties: &[&str],
    status: &ExitStatus,
    values: &BTreeMap<String, String>,
    stderr: &[u8],
) -> RunnerResult<CleanupUnitActiveState> {
    let load_state = required_systemctl_property(svc, values, "LoadState")?;
    let active_state = required_systemctl_property(svc, values, "ActiveState")?;
    let active_like = normalize_unit_state(svc, load_state, active_state)?.is_active_like();
    let missing_unit = load_state == "not-found" && !active_like;
    ensure_systemctl_show_status(svc, properties, status, stderr, missing_unit)?;
    Ok(CleanupUnitActiveState {
        active_state: active_state.to_string(),
        active_like,
    })
}

fn service_unit_state_from_systemctl_show(
    svc: &str,
    properties: &[&str],
    status: &ExitStatus,
    values: &BTreeMap<String, String>,
    stderr: &[u8],
) -> RunnerResult<ServiceUnitState> {
    let load_state = required_systemctl_property(svc, values, "LoadState")?;
    let active_state = required_systemctl_property(svc, values, "ActiveState")?;
    let sub_state = systemctl_property(svc, values, "SubState")?;
    let result = systemctl_property(svc, values, "Result")?;
    let normalized_state = normalize_unit_state(svc, load_state, active_state)?;
    ensure_systemctl_show_status(svc, properties, status, stderr, load_state == "not-found")?;

    Ok(ServiceUnitState {
        load_state: load_state.to_string(),
        active_state: active_state.to_string(),
        sub_state: sub_state.to_string(),
        result: result.to_string(),
        normalized_state,
    })
}

fn service_main_process_present_from_systemctl_show(
    svc: &str,
    properties: &[&str],
    status: &ExitStatus,
    values: &BTreeMap<String, String>,
    stderr: &[u8],
) -> RunnerResult<bool> {
    let load_state = required_systemctl_property(svc, values, "LoadState")?;
    let pid_str = required_systemctl_property(svc, values, "MainPID")?;
    let pid = match parse_main_pid(svc, pid_str) {
        Ok(pid) => pid,
        Err(_) if !status.success() => {
            return Err(systemctl_show_status_error(svc, properties, status, stderr));
        }
        Err(e) => return Err(e),
    };
    let missing_unit = load_state == "not-found" && pid.is_none();
    ensure_systemctl_show_status(svc, properties, status, stderr, missing_unit)?;
    Ok(pid.is_some())
}

fn parse_main_pid(svc: &str, value: &str) -> RunnerResult<Option<u32>> {
    let value = value.trim();
    if value.is_empty() {
        return Err(RunnerError::Internal(format!("empty MainPID for {svc}")));
    }
    let pid = value.parse::<u32>().map_err(|e| {
        RunnerError::Internal(format!(
            "parse MainPID for {svc}: {:?}: {e}",
            status_field_preview(value)
        ))
    })?;
    if pid == 0 { Ok(None) } else { Ok(Some(pid)) }
}

fn service_restart_policy_from_systemctl_show(
    svc: &str,
    properties: &[&str],
    status: &ExitStatus,
    values: &BTreeMap<String, String>,
    stderr: &[u8],
) -> RunnerResult<String> {
    let restart = required_systemctl_property(svc, values, "Restart")?.to_string();
    ensure_systemctl_show_status(svc, properties, status, stderr, false)?;
    Ok(restart)
}

/// Strip the leading ANSI escape sequences systemd writes when it colorizes a
/// log line, so advisory detection does not depend on `SYSTEMD_COLORS`.
fn strip_leading_ansi(line: &str) -> &str {
    let mut rest = line;
    while let Some(after_escape) = rest.strip_prefix('\u{1b}') {
        let Some(after_bracket) = after_escape.strip_prefix('[') else {
            break;
        };
        let mut chars = after_bracket.char_indices();
        let Some((idx, terminator)) = chars.find(|(_, c)| !matches!(c, '0'..='9' | ';')) else {
            break;
        };
        rest = &after_bracket[idx + terminator.len_utf8()..];
    }
    rest
}

/// Classify one `systemctl cat` stderr line as systemd's advisory notice.
///
/// `systemctl cat` prints this notice with `fprintf(stderr, …)` when the unit
/// reports `NeedDaemonReload`, and systemd itself documents the block as
/// informational: the exit status stays 0 and the selected unit content is
/// still written to stdout. `NeedDaemonReload` is derived from mtime
/// comparisons over the unit's fragment and drop-in set, so it is routinely
/// raised without this unit's own content having changed, and a
/// `daemon-reload` does not reliably clear it — see systemd issues 10974,
/// 17730 and 35710. Failing a read on it therefore rejects healthy output for
/// a condition the caller neither owns nor can repair.
///
/// systemd only uses the `#` comment form for that notice; real `cat`
/// diagnostics are plain sentences, so they still fail the read.
fn is_systemctl_cat_advisory_line(line: &str) -> bool {
    strip_leading_ansi(line.trim_start())
        .trim_start()
        .starts_with('#')
}

fn unit_content_from_systemctl_cat(svc: &str, output: &Output) -> RunnerResult<String> {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stderr = stderr.trim();
    if !output.status.success() {
        return Err(systemctl_cat_status_error(svc, &output.status, stderr));
    }
    let unexpected = stderr
        .lines()
        .filter(|line| !line.trim().is_empty() && !is_systemctl_cat_advisory_line(line))
        .collect::<Vec<_>>()
        .join("\n");
    if !unexpected.is_empty() {
        return Err(RunnerError::Internal(format!(
            "systemctl cat {svc} emitted stderr: {:?}",
            status_field_preview(&unexpected)
        )));
    }
    if !stderr.is_empty() {
        warn!(
            unit = svc,
            advisory = %status_field_preview(stderr),
            "systemctl cat reported a pending systemd daemon-reload"
        );
    }

    let stdout = std::str::from_utf8(&output.stdout).map_err(|e| {
        RunnerError::Internal(format!(
            "systemctl cat {svc} returned non-UTF-8 output: {e}"
        ))
    })?;
    Ok(stdout.to_string())
}

fn systemctl_cat_status_error(svc: &str, status: &ExitStatus, stderr: &str) -> RunnerError {
    if stderr.is_empty() {
        RunnerError::Internal(format!("systemctl cat {svc} exited with {status}"))
    } else {
        RunnerError::Internal(format!(
            "systemctl cat {svc} exited with {status}: stderr={:?}",
            status_field_preview(stderr)
        ))
    }
}

fn unit_enablement_from_systemctl_is_enabled(
    svc: &str,
    status: &ExitStatus,
    stdout: &[u8],
    stderr: &[u8],
) -> RunnerResult<SystemdUnitEnablement> {
    let state = std::str::from_utf8(stdout).map_err(|e| {
        RunnerError::Internal(format!(
            "systemctl is-enabled {svc} returned non-UTF-8 output: {e}"
        ))
    })?;
    let state = state.trim();
    match state {
        "enabled" => Ok(SystemdUnitEnablement::Enabled),
        "enabled-runtime" => Ok(SystemdUnitEnablement::EnabledRuntime),
        "alias" | "disabled" | "generated" | "indirect" | "linked" | "linked-runtime"
        | "masked" | "masked-runtime" | "not-found" | "static" | "transient" => {
            Ok(SystemdUnitEnablement::NotEnabled)
        }
        "" if !status.success() => Err(systemctl_is_enabled_status_error(svc, status, stderr)),
        other if !status.success() => Err(RunnerError::Internal(format!(
            "unknown UnitFileState for {svc}: {other:?}; {}",
            systemctl_is_enabled_status_error(svc, status, stderr)
        ))),
        other => Err(RunnerError::Internal(format!(
            "unknown UnitFileState for {svc}: {other:?}"
        ))),
    }
}

runner_test_support!(cmd_service; #[cfg(test)]
fn unit_enabled_from_systemctl_is_enabled(
    svc: &str,
    status: &ExitStatus,
    stdout: &[u8],
    stderr: &[u8],
) -> RunnerResult<bool> {
    unit_enablement_from_systemctl_is_enabled(svc, status, stdout, stderr)
        .map(SystemdUnitEnablement::is_enabled)
});

fn systemctl_is_enabled_status_error(svc: &str, status: &ExitStatus, stderr: &[u8]) -> RunnerError {
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        RunnerError::Internal(format!("systemctl is-enabled {svc} exited with {status}"))
    } else {
        RunnerError::Internal(format!(
            "systemctl is-enabled {svc} exited with {status}: stderr={:?}",
            status_field_preview(stderr)
        ))
    }
}

fn ensure_systemctl_show_status(
    svc: &str,
    properties: &[&str],
    status: &ExitStatus,
    stderr: &[u8],
    allow_failed_status: bool,
) -> RunnerResult<()> {
    if status.success() || allow_failed_status {
        return Ok(());
    }
    Err(systemctl_show_status_error(svc, properties, status, stderr))
}

fn systemctl_show_status_error(
    svc: &str,
    properties: &[&str],
    status: &ExitStatus,
    stderr: &[u8],
) -> RunnerError {
    let property_args = properties.join(",");
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        RunnerError::Internal(format!(
            "systemctl show {svc} --property={property_args} exited with {status}"
        ))
    } else {
        RunnerError::Internal(format!(
            "systemctl show {svc} --property={property_args} exited with {status}: stderr={:?}",
            status_field_preview(stderr)
        ))
    }
}

runner_test_group!(cmd_service; #[cfg(test)]
mod tests {
    use super::*;
    fn systemctl_show_output(status: ExitStatus, stdout: &[u8], stderr: &[u8]) -> Output {
        Output {
            status,
            stdout: stdout.to_vec(),
            stderr: stderr.to_vec(),
        }
    }

    #[test]
    fn journalctl_logs_status_allows_successful_exit() {
        use std::os::unix::process::ExitStatusExt;

        let status = ExitStatus::from_raw(0);

        assert!(journalctl_logs_status("vm0-runner-test.service", status).is_ok());
    }

    #[test]
    fn journalctl_logs_status_rejects_failed_exit() {
        use std::os::unix::process::ExitStatusExt;

        let status = ExitStatus::from_raw(0x100);
        let err = journalctl_logs_status("vm0-runner-test.service", status).unwrap_err();

        assert!(
            matches!(err, RunnerError::Internal(message) if message.contains("journalctl for vm0-runner-test.service exited with"))
        );
    }

    #[test]
    fn journalctl_logs_status_allows_sigpipe() {
        use std::os::unix::process::ExitStatusExt;

        let status = ExitStatus::from_raw(libc::SIGPIPE);

        assert!(journalctl_logs_status("vm0-runner-test.service", status).is_ok());
    }

    #[test]
    fn systemctl_cat_returns_successful_content() {
        use std::os::unix::process::ExitStatusExt;

        let output = systemctl_show_output(
            ExitStatus::from_raw(0),
            b"[Service]\nExecStart=/usr/bin/runner\n",
            b"",
        );

        assert_eq!(
            unit_content_from_systemctl_cat("vm0-runner-test.service", &output).unwrap(),
            "[Service]\nExecStart=/usr/bin/runner\n"
        );
    }

    #[test]
    fn systemctl_cat_rejects_successful_stderr_with_bounded_diagnostic() {
        use std::os::unix::process::ExitStatusExt;

        let stderr = "reload required ".repeat(20);
        let output =
            systemctl_show_output(ExitStatus::from_raw(0), b"[Service]\n", stderr.as_bytes());
        let message =
            unit_content_from_systemctl_cat("vm0-runner-test.service", &output).unwrap_err();
        let message = message.to_string();

        assert!(message.contains("emitted stderr"));
        assert!(message.contains("[truncated]"));
        assert!(message.len() < stderr.len());
    }

    /// systemd emits this block on stderr while `systemctl cat` still exits 0.
    /// Reproduced from the `deploy-runner-start` failure in Turbo run
    /// 33409335059, where the runner had already reported ready.
    const DAEMON_RELOAD_ADVISORY: &str = concat!(
        "# Warning: vm0-runner-test.service changed on disk, the version systemd has loaded is outdated.\n",
        "# This output shows the current version of the unit's original fragment and drop-in files.\n",
        "# If fragments or drop-ins were added or removed, they are not properly reflected in this output.\n",
        "# Run 'systemctl daemon-reload' to reload units.",
    );

    #[test]
    fn systemctl_cat_accepts_daemon_reload_advisory_stderr() {
        use std::os::unix::process::ExitStatusExt;

        let output = systemctl_show_output(
            ExitStatus::from_raw(0),
            b"[Service]\nExecStart=/usr/bin/runner start --config /data/runner.yaml\n",
            DAEMON_RELOAD_ADVISORY.as_bytes(),
        );

        assert_eq!(
            unit_content_from_systemctl_cat("vm0-runner-test.service", &output).unwrap(),
            "[Service]\nExecStart=/usr/bin/runner start --config /data/runner.yaml\n"
        );
    }

    #[test]
    fn systemctl_cat_accepts_colorized_daemon_reload_advisory_stderr() {
        use std::os::unix::process::ExitStatusExt;

        let colorized = DAEMON_RELOAD_ADVISORY
            .lines()
            .map(|line| format!("\u{1b}[0;1;31m{line}"))
            .collect::<Vec<_>>()
            .join("\n");
        let output = systemctl_show_output(
            ExitStatus::from_raw(0),
            b"[Service]\n",
            format!("{colorized}\u{1b}[0m").as_bytes(),
        );

        assert_eq!(
            unit_content_from_systemctl_cat("vm0-runner-test.service", &output).unwrap(),
            "[Service]\n"
        );
    }

    #[test]
    fn systemctl_cat_rejects_failed_exit_with_advisory_only_stderr() {
        use std::os::unix::process::ExitStatusExt;

        let output = systemctl_show_output(
            ExitStatus::from_raw(0x100),
            b"",
            DAEMON_RELOAD_ADVISORY.as_bytes(),
        );

        assert!(unit_content_from_systemctl_cat("vm0-runner-test.service", &output).is_err());
    }

    #[test]
    fn systemctl_cat_rejects_real_diagnostic_alongside_advisory_stderr() {
        use std::os::unix::process::ExitStatusExt;

        let stderr =
            format!("{DAEMON_RELOAD_ADVISORY}\nFailed to get unit file path: No such file");
        let output =
            systemctl_show_output(ExitStatus::from_raw(0), b"[Service]\n", stderr.as_bytes());
        let message = unit_content_from_systemctl_cat("vm0-runner-test.service", &output)
            .unwrap_err()
            .to_string();

        assert!(message.contains("emitted stderr"));
        assert!(message.contains("Failed to get unit file path"));
        assert!(!message.contains("# Warning:"));
    }

    #[test]
    fn systemctl_cat_failure_does_not_expose_stdout() {
        use std::os::unix::process::ExitStatusExt;

        let output = systemctl_show_output(
            ExitStatus::from_raw(0x100),
            b"ExecStart=/usr/bin/runner --token should-not-appear",
            b"failed to read selected unit",
        );
        let message =
            unit_content_from_systemctl_cat("vm0-runner-test.service", &output).unwrap_err();
        let message = message.to_string();

        assert!(message.contains("failed to read selected unit"));
        assert!(!message.contains("should-not-appear"));
    }

    #[test]
    fn systemctl_cat_rejects_non_utf8_stdout_without_exposing_content() {
        use std::os::unix::process::ExitStatusExt;

        let output = systemctl_show_output(ExitStatus::from_raw(0), b"secret\xffcontent", b"");
        let message =
            unit_content_from_systemctl_cat("vm0-runner-test.service", &output).unwrap_err();
        let message = message.to_string();

        assert!(message.contains("non-UTF-8 output"));
        assert!(!message.contains("secret"));
    }

    #[test]
    fn parse_systemctl_show_properties_extracts_values() {
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &["MainPID"],
            b"MainPID=123\n",
        )
        .unwrap();

        assert_eq!(
            required_systemctl_property("vm0-runner-test.service", &values, "MainPID").unwrap(),
            "123"
        );
    }

    #[test]
    fn parse_systemctl_show_properties_rejects_missing_property() {
        let err = parse_systemctl_show_properties("vm0-runner-test.service", &["MainPID"], b"")
            .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("missing systemctl show property"));
    }

    #[test]
    fn parse_systemctl_show_properties_rejects_unexpected_property() {
        let err = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &["MainPID"],
            b"ActiveState=active\n",
        )
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("unexpected systemctl show property"));
    }

    #[test]
    fn parse_systemctl_show_properties_rejects_duplicate_property() {
        let err = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &["MainPID"],
            b"MainPID=123\nMainPID=456\n",
        )
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("duplicate systemctl show property"));
    }

    #[test]
    fn parse_systemctl_show_properties_rejects_malformed_line() {
        let err = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &["MainPID"],
            b"MainPID 123\n",
        )
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("malformed systemctl show output"));
    }

    #[test]
    fn parse_systemctl_show_output_preserves_parse_error_on_success_status() {
        use std::os::unix::process::ExitStatusExt;

        let output = systemctl_show_output(ExitStatus::from_raw(0), b"MainPID 123\n", b"");
        let err = parse_systemctl_show_output("vm0-runner-test.service", &["MainPID"], &output)
            .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("malformed systemctl show output"));
    }

    #[test]
    fn parse_systemctl_show_output_prefers_status_error_on_failed_status() {
        use std::os::unix::process::ExitStatusExt;

        let output = systemctl_show_output(
            ExitStatus::from_raw(0x100),
            b"MainPID 123\n",
            b"Failed to connect to bus\n",
        );
        let err = parse_systemctl_show_output("vm0-runner-test.service", &["MainPID"], &output)
            .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("systemctl show vm0-runner-test.service --property=MainPID"));
        assert!(message.contains("Failed to connect to bus"));
        assert!(!message.contains("malformed systemctl show output"));
    }

    #[test]
    fn required_systemctl_property_rejects_empty_value() {
        let values =
            parse_systemctl_show_properties("vm0-runner-test.service", &["MainPID"], b"MainPID=\n")
                .unwrap();
        let err =
            required_systemctl_property("vm0-runner-test.service", &values, "MainPID").unwrap_err();
        let message = err.to_string();

        assert!(message.contains("empty systemctl show property"));
    }

    #[test]
    fn systemd_reload_state_parses_loaded_dirty_unit() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "NeedDaemonReload", "DropInPaths"];
        let output = systemctl_show_output(
            ExitStatus::from_raw(0),
            b"LoadState=loaded\nNeedDaemonReload=yes\nDropInPaths=/run/systemd/system/vm0-runner-test.service.d/50-vm0-drain.conf\n",
            b"",
        );

        let state =
            systemd_reload_state_from_output("vm0-runner-test.service", &properties, &output)
                .unwrap();

        assert!(!state.is_not_found());
        assert!(state.need_daemon_reload());
        assert!(state.has_drop_in_path(std::path::Path::new(
            "/run/systemd/system/vm0-runner-test.service.d/50-vm0-drain.conf"
        )));
    }

    #[test]
    fn systemd_reload_state_accepts_not_found_with_failed_status() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "NeedDaemonReload", "DropInPaths"];
        let output = systemctl_show_output(
            ExitStatus::from_raw(0x100),
            b"LoadState=not-found\nNeedDaemonReload=no\nDropInPaths=\n",
            b"Unit not found\n",
        );

        let state =
            systemd_reload_state_from_output("vm0-runner-test.service", &properties, &output)
                .unwrap();

        assert!(state.is_not_found());
        assert!(!state.need_daemon_reload());
    }

    #[test]
    fn systemd_reload_state_rejects_unknown_boolean() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "NeedDaemonReload", "DropInPaths"];
        let output = systemctl_show_output(
            ExitStatus::from_raw(0),
            b"LoadState=loaded\nNeedDaemonReload=maybe\nDropInPaths=\n",
            b"",
        );

        let error =
            systemd_reload_state_from_output("vm0-runner-test.service", &properties, &output)
                .unwrap_err();

        assert!(error.to_string().contains("unknown NeedDaemonReload"));
    }

    #[test]
    fn systemd_reload_state_rejects_unknown_load_state() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "NeedDaemonReload", "DropInPaths"];
        let output = systemctl_show_output(
            ExitStatus::from_raw(0),
            b"LoadState=half-loaded\nNeedDaemonReload=yes\nDropInPaths=\n",
            b"",
        );

        let error =
            systemd_reload_state_from_output("vm0-runner-test.service", &properties, &output)
                .unwrap_err();

        assert!(error.to_string().contains("unknown LoadState"));
    }

    #[test]
    fn systemctl_show_status_error_includes_stderr() {
        use std::os::unix::process::ExitStatusExt;

        let status = ExitStatus::from_raw(0x100);
        let err = systemctl_show_status_error(
            "vm0-runner-test.service",
            &["MainPID"],
            &status,
            b"Failed to connect to bus: Host is down\n",
        );
        let message = err.to_string();

        assert!(message.contains("systemctl show vm0-runner-test.service --property=MainPID"));
        assert!(message.contains("Failed to connect to bus"));
    }

    #[test]
    fn classify_unit_active_accepts_active_states() {
        for active_state in ["active", "activating", "reloading", "refreshing"] {
            assert!(
                classify_unit_active("vm0-runner-test.service", "loaded", active_state).unwrap()
            );
        }
    }

    #[test]
    fn classify_unit_active_accepts_inactive_states() {
        for active_state in ["inactive", "failed", "deactivating", "maintenance"] {
            assert!(
                !classify_unit_active("vm0-runner-test.service", "loaded", active_state).unwrap()
            );
        }
    }

    #[test]
    fn classify_unit_active_treats_not_found_inactive_as_inactive() {
        assert!(!classify_unit_active("vm0-runner-test.service", "not-found", "inactive").unwrap());
    }

    #[test]
    fn classify_unit_active_rejects_unknown_active_state() {
        let err =
            classify_unit_active("vm0-runner-test.service", "loaded", "half-active").unwrap_err();
        let message = err.to_string();

        assert!(message.contains("unknown ActiveState"));
    }

    #[test]
    fn normalize_unit_state_keeps_lifecycle_active_like_states() {
        for active_state in [
            "active",
            "activating",
            "reloading",
            "refreshing",
            "deactivating",
        ] {
            assert_eq!(
                normalize_unit_state("vm0-runner-test.service", "loaded", active_state).unwrap(),
                NormalizedUnitState::ActiveLike,
                "{active_state} should normalize to active-like"
            );
        }
    }

    #[test]
    fn normalize_unit_state_preserves_loaded_inactive_states() {
        for (active_state, normalized_state) in [
            ("inactive", NormalizedUnitState::Inactive),
            ("failed", NormalizedUnitState::Failed),
            ("maintenance", NormalizedUnitState::Maintenance),
        ] {
            assert_eq!(
                normalize_unit_state("vm0-runner-test.service", "loaded", active_state).unwrap(),
                normalized_state,
                "{active_state} should preserve its loaded normalized state"
            );
        }
    }

    #[test]
    fn cleanup_unit_active_state_allows_not_found_inactive_on_failed_status() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "ActiveState"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"LoadState=not-found\nActiveState=inactive\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0x100);
        let state = cleanup_unit_active_state_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"Unit not found\n",
        )
        .unwrap();

        assert_eq!(state.active_state(), "inactive");
        assert!(!state.is_active_like());
    }

    #[test]
    fn service_unit_state_keeps_deactivating_active_like_for_reporting() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "ActiveState", "SubState", "Result"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"LoadState=loaded\nActiveState=deactivating\nSubState=stop-sigterm\nResult=success\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0);
        let state = service_unit_state_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"",
        )
        .unwrap();

        assert_eq!(state.active_state(), "deactivating");
        assert!(state.is_active_like());
        assert_eq!(state.normalized_state, NormalizedUnitState::ActiveLike);
    }

    #[test]
    fn service_unit_state_accepts_all_active_like_states_for_reporting() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "ActiveState", "SubState", "Result"];
        let status = ExitStatus::from_raw(0);
        for active_state in [
            "active",
            "activating",
            "reloading",
            "refreshing",
            "deactivating",
        ] {
            let stdout = format!(
                "LoadState=loaded\nActiveState={active_state}\nSubState=running\nResult=success\n"
            );
            let values = parse_systemctl_show_properties(
                "vm0-runner-test.service",
                &properties,
                stdout.as_bytes(),
            )
            .unwrap();
            let state = service_unit_state_from_systemctl_show(
                "vm0-runner-test.service",
                &properties,
                &status,
                &values,
                b"",
            )
            .unwrap();

            assert_eq!(state.normalized_state, NormalizedUnitState::ActiveLike);
            assert!(
                state.is_active_like(),
                "{active_state} should be active-like"
            );
        }
    }

    #[test]
    fn service_unit_state_accepts_inactive_like_states_for_reporting() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "ActiveState", "SubState", "Result"];
        let status = ExitStatus::from_raw(0);
        for (active_state, normalized_state) in [
            ("inactive", NormalizedUnitState::Inactive),
            ("failed", NormalizedUnitState::Failed),
            ("maintenance", NormalizedUnitState::Maintenance),
        ] {
            let stdout = format!(
                "LoadState=loaded\nActiveState={active_state}\nSubState=dead\nResult=success\n"
            );
            let values = parse_systemctl_show_properties(
                "vm0-runner-test.service",
                &properties,
                stdout.as_bytes(),
            )
            .unwrap();
            let state = service_unit_state_from_systemctl_show(
                "vm0-runner-test.service",
                &properties,
                &status,
                &values,
                b"",
            )
            .unwrap();

            assert_eq!(state.normalized_state, normalized_state);
            assert!(
                !state.is_active_like(),
                "{active_state} should not be active-like"
            );
        }
    }

    #[test]
    fn service_unit_state_preserves_empty_optional_fields() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "ActiveState", "SubState", "Result"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"LoadState=loaded\nActiveState=inactive\nSubState=\nResult=\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0);
        let state = service_unit_state_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"",
        )
        .unwrap();

        assert_eq!(state.sub_state, "");
        assert_eq!(state.result, "");
        assert!(!state.is_active_like());
        assert_eq!(state.normalized_state, NormalizedUnitState::Inactive);
    }

    #[test]
    fn service_unit_state_allows_not_found_on_failed_status() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "ActiveState", "SubState", "Result"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"LoadState=not-found\nActiveState=inactive\nSubState=dead\nResult=success\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0x100);
        let state = service_unit_state_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"Unit not found\n",
        )
        .unwrap();

        assert_eq!(state.normalized_state, NormalizedUnitState::NotFound);
        assert!(!state.is_active_like());
    }

    #[test]
    fn service_unit_state_accepts_not_found_inactive_like_states() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "ActiveState", "SubState", "Result"];
        let status = ExitStatus::from_raw(0x100);
        for active_state in ["inactive", "failed", "maintenance"] {
            let stdout = format!(
                "LoadState=not-found\nActiveState={active_state}\nSubState=dead\nResult=success\n"
            );
            let values = parse_systemctl_show_properties(
                "vm0-runner-test.service",
                &properties,
                stdout.as_bytes(),
            )
            .unwrap();
            let state = service_unit_state_from_systemctl_show(
                "vm0-runner-test.service",
                &properties,
                &status,
                &values,
                b"Unit not found\n",
            )
            .unwrap();

            assert_eq!(state.normalized_state, NormalizedUnitState::NotFound);
            assert!(
                !state.is_active_like(),
                "{active_state} should not be active-like"
            );
        }
    }

    #[test]
    fn service_unit_state_reports_not_found_active_like_state() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "ActiveState", "SubState", "Result"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"LoadState=not-found\nActiveState=deactivating\nSubState=stop-sigterm\nResult=success\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0x100);
        let state = service_unit_state_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"Unit not found\n",
        )
        .unwrap();

        assert_eq!(state.load_state, "not-found");
        assert_eq!(state.normalized_state, NormalizedUnitState::ActiveLike);
        assert!(state.is_active_like());
    }

    #[test]
    fn service_unit_state_rejects_unknown_active_state() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "ActiveState", "SubState", "Result"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"LoadState=loaded\nActiveState=half-active\nSubState=unknown\nResult=success\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0);
        let err = service_unit_state_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"",
        )
        .unwrap_err();

        assert!(err.to_string().contains("unknown ActiveState"));
    }

    #[test]
    fn service_unit_state_rejects_not_found_unknown_active_state() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "ActiveState", "SubState", "Result"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"LoadState=not-found\nActiveState=half-active\nSubState=unknown\nResult=success\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0x100);
        let err = service_unit_state_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"Unit not found\n",
        )
        .unwrap_err();

        assert!(err.to_string().contains("unknown ActiveState"));
    }

    #[test]
    fn unit_enabled_from_systemctl_is_enabled_accepts_enabled_states() {
        use std::os::unix::process::ExitStatusExt;

        let status = ExitStatus::from_raw(0);
        for state in ["enabled", "enabled-runtime"] {
            assert!(
                unit_enabled_from_systemctl_is_enabled(
                    "vm0-runner-test.service",
                    &status,
                    format!("{state}\n").as_bytes(),
                    b"",
                )
                .unwrap()
            );
        }
    }

    #[test]
    fn unit_enablement_preserves_runtime_only_state() {
        use std::os::unix::process::ExitStatusExt;

        let status = ExitStatus::from_raw(0);
        let enablement = unit_enablement_from_systemctl_is_enabled(
            "vm0-runner-test.service",
            &status,
            b"enabled-runtime\n",
            b"",
        )
        .unwrap();

        assert_eq!(enablement, SystemdUnitEnablement::EnabledRuntime);
        assert_eq!(
            enablement.restore_actions(),
            [
                SystemdEnablementRestoreAction::Disable,
                SystemdEnablementRestoreAction::EnableRuntime,
            ]
        );
    }

    #[test]
    fn unit_enabled_from_systemctl_is_enabled_rejects_disabled_states() {
        use std::os::unix::process::ExitStatusExt;

        let status = ExitStatus::from_raw(0x100);
        for state in [
            "alias",
            "disabled",
            "generated",
            "indirect",
            "linked",
            "linked-runtime",
            "masked",
            "masked-runtime",
            "not-found",
            "static",
            "transient",
        ] {
            assert!(
                !unit_enabled_from_systemctl_is_enabled(
                    "vm0-runner-test.service",
                    &status,
                    format!("{state}\n").as_bytes(),
                    b"",
                )
                .unwrap(),
                "{state} should not be treated as enabled"
            );
        }
    }

    #[test]
    fn unit_enabled_from_systemctl_is_enabled_rejects_unknown_success_state() {
        use std::os::unix::process::ExitStatusExt;

        let status = ExitStatus::from_raw(0);
        let err = unit_enabled_from_systemctl_is_enabled(
            "vm0-runner-test.service",
            &status,
            b"half-enabled\n",
            b"",
        )
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("unknown UnitFileState"));
    }

    #[test]
    fn unit_enabled_from_systemctl_is_enabled_rejects_unknown_failed_state() {
        use std::os::unix::process::ExitStatusExt;

        let status = ExitStatus::from_raw(0x100);
        let err = unit_enabled_from_systemctl_is_enabled(
            "vm0-runner-test.service",
            &status,
            b"bad\n",
            b"unit file is invalid\n",
        )
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("unknown UnitFileState"));
        assert!(message.contains("bad"));
        assert!(message.contains("unit file is invalid"));
    }

    #[test]
    fn unit_active_from_systemctl_show_allows_not_found_inactive_on_failed_status() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "ActiveState"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"LoadState=not-found\nActiveState=inactive\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0x100);

        assert!(
            !unit_active_from_systemctl_show(
                "vm0-runner-test.service",
                &properties,
                &status,
                &values,
                b"Unit not found\n",
            )
            .unwrap()
        );
    }

    #[test]
    fn unit_active_from_systemctl_show_rejects_nonzero_loaded_inactive() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "ActiveState"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"LoadState=loaded\nActiveState=inactive\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0x100);
        let err = unit_active_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"Failed to connect to bus\n",
        )
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("Failed to connect to bus"));
    }

    #[test]
    fn ensure_systemctl_show_status_requires_explicit_failed_status_allowance() {
        use std::os::unix::process::ExitStatusExt;

        let status = ExitStatus::from_raw(0x100);

        assert!(
            ensure_systemctl_show_status(
                "vm0-runner-test.service",
                &["MainPID"],
                &status,
                b"Unit not found\n",
                true,
            )
            .is_ok()
        );

        let err = ensure_systemctl_show_status(
            "vm0-runner-test.service",
            &["MainPID"],
            &status,
            b"Failed to connect to bus\n",
            false,
        )
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("systemctl show vm0-runner-test.service --property=MainPID"));
        assert!(message.contains("Failed to connect to bus"));
    }

    #[test]
    fn service_main_process_present_from_systemctl_show_returns_true_on_success() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "MainPID"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"LoadState=loaded\nMainPID=123\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0);

        assert!(
            service_main_process_present_from_systemctl_show(
                "vm0-runner-test.service",
                &properties,
                &status,
                &values,
                b"",
            )
            .unwrap()
        );
    }

    #[test]
    fn service_main_process_present_from_systemctl_show_allows_not_found_zero_on_failed_status() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "MainPID"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"LoadState=not-found\nMainPID=0\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0x100);

        assert!(
            !service_main_process_present_from_systemctl_show(
                "vm0-runner-test.service",
                &properties,
                &status,
                &values,
                b"Unit not found\n",
            )
            .unwrap()
        );
    }

    #[test]
    fn service_restart_policy_from_systemctl_show_returns_restart_value() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["Restart"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"Restart=no\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0);

        assert_eq!(
            service_restart_policy_from_systemctl_show(
                "vm0-runner-test.service",
                &properties,
                &status,
                &values,
                b"",
            )
            .unwrap(),
            "no"
        );
    }

    #[test]
    fn service_restart_policy_from_systemctl_show_exposes_non_no_policy() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["Restart"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"Restart=on-failure\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0);

        assert_eq!(
            service_restart_policy_from_systemctl_show(
                "vm0-runner-test.service",
                &properties,
                &status,
                &values,
                b"",
            )
            .unwrap(),
            "on-failure"
        );
    }

    #[test]
    fn service_restart_policy_from_systemctl_show_rejects_failed_status() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["Restart"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"Restart=no\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0x100);
        let err = service_restart_policy_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"Failed to connect to bus\n",
        )
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("systemctl show vm0-runner-test.service --property=Restart"));
        assert!(message.contains("Failed to connect to bus"));
    }

    #[test]
    fn service_main_process_present_from_systemctl_show_rejects_nonzero_loaded_zero() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "MainPID"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"LoadState=loaded\nMainPID=0\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0x100);
        let err = service_main_process_present_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"Failed to connect to bus\n",
        )
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("Failed to connect to bus"));
    }

    #[test]
    fn service_main_process_present_from_systemctl_show_rejects_malformed_pid_on_failed_status() {
        use std::os::unix::process::ExitStatusExt;

        let properties = ["LoadState", "MainPID"];
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            b"LoadState=not-found\nMainPID=abc\n",
        )
        .unwrap();
        let status = ExitStatus::from_raw(0x100);
        let err = service_main_process_present_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"Unit not found\n",
        )
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("Unit not found"));
    }

    #[test]
    fn parse_main_pid_zero_returns_none() {
        assert_eq!(
            parse_main_pid("vm0-runner-test.service", "0").unwrap(),
            None
        );
    }

    #[test]
    fn parse_main_pid_positive_returns_pid() {
        assert_eq!(
            parse_main_pid("vm0-runner-test.service", "123").unwrap(),
            Some(123)
        );
    }

    #[test]
    fn parse_main_pid_rejects_malformed_values() {
        for value in ["abc", "", "-1", "4294967296"] {
            assert!(
                parse_main_pid("vm0-runner-test.service", value).is_err(),
                "value should fail: {value}"
            );
        }
    }
});
