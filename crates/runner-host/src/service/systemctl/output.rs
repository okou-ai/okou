//! Interpretation of systemctl output, typed service states and reporting.

use std::collections::BTreeMap;
use std::process::{ExitStatus, Output};

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use tracing::warn;

use super::super::diagnostic::status_field_preview;
use crate::error::{HostError, HostResult};

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
    pub(in crate::service) fn for_test(
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
    pub(in crate::service) fn for_test(active_state: &str, active_like: bool) -> Self {
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
    pub(in crate::service) fn for_test(
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SystemdUnitEnablement {
    Enabled,
    EnabledRuntime,
    NotEnabled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum SystemdEnablementRestoreAction {
    Disable,
    Enable,
    EnableRuntime,
}

impl SystemdUnitEnablement {
    pub(super) fn is_enabled(self) -> bool {
        matches!(self, Self::Enabled | Self::EnabledRuntime)
    }

    pub(super) fn restore_actions(self) -> &'static [SystemdEnablementRestoreAction] {
        use SystemdEnablementRestoreAction::{Disable, Enable, EnableRuntime};

        match self {
            Self::Enabled => &[Enable],
            Self::EnabledRuntime => &[Disable, EnableRuntime],
            Self::NotEnabled => &[Disable],
        }
    }
}

pub(super) fn systemd_reload_state_from_output(
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

pub(super) fn service_unit_state_from_output(
    svc: &str,
    properties: &[&str],
    output: &Output,
) -> HostResult<ServiceUnitState> {
    let values = parse_systemctl_show_output(svc, properties, output)?;
    service_unit_state_from_systemctl_show(svc, properties, &output.status, &values, &output.stderr)
}

pub(super) fn cleanup_unit_active_state_from_output(
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

pub(super) fn service_main_process_from_output(
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

pub(super) fn parse_systemctl_show_output(
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

pub(super) fn unit_active_from_systemctl_show(
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

pub(super) fn service_restart_policy_from_systemctl_show(
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

pub(super) fn unit_content_from_systemctl_cat(svc: &str, output: &Output) -> HostResult<String> {
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

pub(super) fn unit_enablement_from_systemctl_is_enabled(
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
