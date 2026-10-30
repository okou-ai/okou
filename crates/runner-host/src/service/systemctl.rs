use std::collections::BTreeMap;
use std::process::{ExitStatus, Output};
use std::time::Duration;

use crate::bounded_command::{
    BoundedCommandError, BoundedCommandOutcome, CommandOutputPolicy, run_bounded,
    run_output_bounded,
};
use crate::error::{HostError, HostResult};
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use tracing::warn;

use super::diagnostic::status_field_preview;
use super::target::RunnerServiceUnit;

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
/// Cleanup callers must use `cleanup_unit_active_state_bounded`, which treats
/// `deactivating` as active-like so cleanup can wait or escalate instead of
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
pub struct SystemdReloadState {
    load_state: SystemdUnitLoadState,
    need_daemon_reload: bool,
    drop_in_paths: Vec<String>,
}

impl SystemdReloadState {
    pub fn is_not_found(&self) -> bool {
        self.load_state == SystemdUnitLoadState::NotFound
    }

    pub fn need_daemon_reload(&self) -> bool {
        self.need_daemon_reload
    }

    pub fn has_drop_in_path(&self, path: &std::path::Path) -> bool {
        let path = path.to_string_lossy();
        self.drop_in_paths
            .iter()
            .any(|loaded| loaded == path.as_ref())
    }

    #[cfg(any(test, feature = "test-support"))]
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

fn systemd_reload_state_from_output(
    svc: &str,
    properties: &[&str],
    output: &Output,
) -> HostResult<SystemdReloadState> {
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
pub struct CleanupUnitActiveState {
    active_state: String,
    active_like: bool,
}

impl CleanupUnitActiveState {
    pub fn active_state(&self) -> &str {
        &self.active_state
    }

    pub fn is_active_like(&self) -> bool {
        self.active_like
    }

    #[cfg(any(test, feature = "test-support"))]
    pub(super) fn for_test(active_state: &str, active_like: bool) -> Self {
        Self {
            active_state: active_state.to_string(),
            active_like,
        }
    }
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
pub struct ServiceUnitState {
    load_state: String,
    active_state: String,
    sub_state: String,
    result: String,
    normalized_state: NormalizedUnitState,
}

impl ServiceUnitState {
    #[cfg(any(test, feature = "test-support"))]
    pub(super) fn for_test(
        load_state: &str,
        active_state: &str,
        sub_state: &str,
        result: &str,
    ) -> HostResult<Self> {
        let normalized_state =
            normalize_unit_state("vm0-runner-test.service", load_state, active_state)?;
        Ok(Self {
            load_state: load_state.to_string(),
            active_state: active_state.to_string(),
            sub_state: sub_state.to_string(),
            result: result.to_string(),
            normalized_state,
        })
    }

    fn active_like(&self) -> bool {
        self.normalized_state.is_active_like()
    }

    #[cfg(test)]
    fn active_state(&self) -> &str {
        &self.active_state
    }

    #[cfg(test)]
    fn is_active_like(&self) -> bool {
        self.active_like()
    }
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
pub async fn read_service_unit_state(unit: &RunnerServiceUnit) -> HostResult<ServiceUnitState> {
    let svc = unit.service_name();
    let properties = ["LoadState", "ActiveState", "SubState", "Result"];
    let output = run_systemctl_show_bounded(svc, &properties, SYSTEMCTL_QUERY_TIMEOUT).await?;
    service_unit_state_from_output(svc, &properties, &output)
}

fn service_unit_state_from_output(
    svc: &str,
    properties: &[&str],
    output: &Output,
) -> HostResult<ServiceUnitState> {
    let values = parse_systemctl_show_output(svc, properties, output)?;
    service_unit_state_from_systemctl_show(svc, properties, &output.status, &values, &output.stderr)
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

/// Read the systemd ActiveState using cleanup semantics.
///
/// Normal health checks intentionally treat `deactivating` as inactive because
/// a service that has started shutdown is not runnable. Cleanup must treat
/// `deactivating` as still active-like so recovery waits or escalates instead
/// of reporting success too early.
pub async fn cleanup_unit_active_state_bounded(
    unit: &RunnerServiceUnit,
    duration: Duration,
) -> HostResult<CleanupUnitActiveState> {
    let svc = unit.service_name();
    let properties = ["LoadState", "ActiveState"];
    let output = run_systemctl_show_bounded(svc, &properties, duration).await?;
    cleanup_unit_active_state_from_output(svc, &properties, &output)
}

fn cleanup_unit_active_state_from_output(
    svc: &str,
    properties: &[&str],
    output: &Output,
) -> HostResult<CleanupUnitActiveState> {
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
pub enum SystemdUnitEnablement {
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

fn service_main_process_from_output(
    svc: &str,
    properties: &[&str],
    output: &Output,
) -> HostResult<bool> {
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

fn parse_systemctl_show_output(
    svc: &str,
    properties: &[&str],
    output: &Output,
) -> HostResult<BTreeMap<String, String>> {
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
) -> HostResult<BTreeMap<String, String>> {
    let stdout = std::str::from_utf8(stdout).map_err(|e| {
        HostError::Internal(format!(
            "systemctl show {svc} returned non-UTF-8 output: {e}"
        ))
    })?;
    let mut values = BTreeMap::new();
    for line in stdout.lines().filter(|line| !line.is_empty()) {
        let Some((property, value)) = line.split_once('=') else {
            return Err(HostError::Internal(format!(
                "malformed systemctl show output for {svc}: {:?}",
                status_field_preview(line)
            )));
        };
        if !properties.contains(&property) {
            return Err(HostError::Internal(format!(
                "unexpected systemctl show property for {svc}: {property}"
            )));
        }
        if values
            .insert(property.to_string(), value.to_string())
            .is_some()
        {
            return Err(HostError::Internal(format!(
                "duplicate systemctl show property for {svc}: {property}"
            )));
        }
    }
    for property in properties {
        if !values.contains_key(*property) {
            return Err(HostError::Internal(format!(
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
) -> HostResult<&'a str> {
    let value = values.get(property).ok_or_else(|| {
        HostError::Internal(format!(
            "missing systemctl show property for {svc}: {property}"
        ))
    })?;
    let value = value.trim();
    if value.is_empty() {
        return Err(HostError::Internal(format!(
            "empty systemctl show property for {svc}: {property}"
        )));
    }
    Ok(value)
}

fn systemctl_property<'a>(
    svc: &str,
    values: &'a BTreeMap<String, String>,
    property: &str,
) -> HostResult<&'a str> {
    let value = values.get(property).ok_or_else(|| {
        HostError::Internal(format!(
            "missing systemctl show property for {svc}: {property}"
        ))
    })?;
    Ok(value.trim())
}

fn classify_unit_active(svc: &str, load_state: &str, active_state: &str) -> HostResult<bool> {
    let normalized_state = normalize_unit_state(svc, load_state, active_state)?;
    Ok(normalized_state.is_active_like() && active_state != "deactivating")
}

fn parse_systemd_unit_load_state(svc: &str, value: &str) -> HostResult<SystemdUnitLoadState> {
    match value {
        "stub" => Ok(SystemdUnitLoadState::Stub),
        "loaded" => Ok(SystemdUnitLoadState::Loaded),
        "not-found" => Ok(SystemdUnitLoadState::NotFound),
        "bad-setting" => Ok(SystemdUnitLoadState::BadSetting),
        "error" => Ok(SystemdUnitLoadState::Error),
        "merged" => Ok(SystemdUnitLoadState::Merged),
        "masked" => Ok(SystemdUnitLoadState::Masked),
        other => Err(HostError::Internal(format!(
            "unknown LoadState for {svc}: {other:?}"
        ))),
    }
}

fn parse_systemd_boolean(svc: &str, property: &str, value: &str) -> HostResult<bool> {
    match value {
        "yes" => Ok(true),
        "no" => Ok(false),
        other => Err(HostError::Internal(format!(
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
) -> HostResult<SystemdReloadState> {
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
) -> HostResult<NormalizedUnitState> {
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
        _ => Err(HostError::Internal(format!(
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
) -> HostResult<bool> {
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
) -> HostResult<CleanupUnitActiveState> {
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
) -> HostResult<ServiceUnitState> {
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
) -> HostResult<bool> {
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

fn parse_main_pid(svc: &str, value: &str) -> HostResult<Option<u32>> {
    let value = value.trim();
    if value.is_empty() {
        return Err(HostError::Internal(format!("empty MainPID for {svc}")));
    }
    let pid = value.parse::<u32>().map_err(|e| {
        HostError::Internal(format!(
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
) -> HostResult<String> {
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

fn unit_content_from_systemctl_cat(svc: &str, output: &Output) -> HostResult<String> {
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
        return Err(HostError::Internal(format!(
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
        HostError::Internal(format!(
            "systemctl cat {svc} returned non-UTF-8 output: {e}"
        ))
    })?;
    Ok(stdout.to_string())
}

fn systemctl_cat_status_error(svc: &str, status: &ExitStatus, stderr: &str) -> HostError {
    if stderr.is_empty() {
        HostError::Internal(format!("systemctl cat {svc} exited with {status}"))
    } else {
        HostError::Internal(format!(
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
) -> HostResult<SystemdUnitEnablement> {
    let state = std::str::from_utf8(stdout).map_err(|e| {
        HostError::Internal(format!(
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
        other if !status.success() => Err(HostError::Internal(format!(
            "unknown UnitFileState for {svc}: {other:?}; {}",
            systemctl_is_enabled_status_error(svc, status, stderr)
        ))),
        other => Err(HostError::Internal(format!(
            "unknown UnitFileState for {svc}: {other:?}"
        ))),
    }
}

#[cfg(test)]
fn unit_enabled_from_systemctl_is_enabled(
    svc: &str,
    status: &ExitStatus,
    stdout: &[u8],
    stderr: &[u8],
) -> HostResult<bool> {
    unit_enablement_from_systemctl_is_enabled(svc, status, stdout, stderr)
        .map(SystemdUnitEnablement::is_enabled)
}

fn systemctl_is_enabled_status_error(svc: &str, status: &ExitStatus, stderr: &[u8]) -> HostError {
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        HostError::Internal(format!("systemctl is-enabled {svc} exited with {status}"))
    } else {
        HostError::Internal(format!(
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
) -> HostResult<()> {
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
) -> HostError {
    let property_args = properties.join(",");
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        HostError::Internal(format!(
            "systemctl show {svc} --property={property_args} exited with {status}"
        ))
    } else {
        HostError::Internal(format!(
            "systemctl show {svc} --property={property_args} exited with {status}: stderr={:?}",
            status_field_preview(stderr)
        ))
    }
}

#[cfg(test)]
mod tests;
