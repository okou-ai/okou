use std::path::{Path, PathBuf};

use crate::error::{ActiveJobsError, RunnerError, RunnerResult};
use crate::status_file::{self, StatusFileReadError, StatusForGate};
use runner_host::paths::HomePaths;
use runner_types::ids::RunId;
use tracing::info;

use super::{ServiceFuture, selected_config_base_dir};
use runner_host::service::{RunnerServiceUnit, status_field_preview};

pub(super) trait ActiveJobsGateOps {
    fn is_unit_active<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, bool>;
    fn read_unit_config_path<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, Option<PathBuf>>;
}

/// Parsed snapshot of the runner's status.json.
pub(super) struct RunnerStatusSnapshot {
    /// Mode string sourced verbatim from status.json. Valid values are the
    /// lowercase serialization of [`crate::lifecycle::RunnerMode`]: `"starting"`,
    /// `"running"`, `"draining"`, `"stopping"`, `"stopped"`. Unknown values
    /// (e.g. from a newer runner writing a future variant) are preserved and
    /// routed to the normal refuse branch by [`decide_gate`].
    pub(super) mode: String,
    /// Stable identity of the runner process that wrote this snapshot.
    pub(super) started_at: chrono::DateTime<chrono::Utc>,
    /// UUIDs of runs currently in flight.
    run_ids: Vec<RunId>,
    /// How long the runner process itself has been up, derived from the
    /// `started_at` timestamp. status.json does not record per-run start
    /// times, so the error message surfaces this runner-level uptime
    /// rather than a misleading per-job duration.
    uptime: std::time::Duration,
}

#[derive(Debug)]
pub(super) enum RunnerStatusReadError {
    Read {
        path: PathBuf,
        error: std::io::Error,
    },
    ParseJson {
        path: PathBuf,
        error: serde_json::Error,
    },
    ParseStartedAt {
        started_at: String,
        error: chrono::ParseError,
    },
}

impl std::fmt::Display for RunnerStatusReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read { path, error } => write!(f, "read {}: {error}", path.display()),
            Self::ParseJson { path, error } => write!(f, "parse {}: {error}", path.display()),
            Self::ParseStartedAt { started_at, error } => {
                write!(
                    f,
                    "parse started_at {:?}: {error}",
                    status_field_preview(started_at)
                )
            }
        }
    }
}

/// Decision from [`decide_gate`] — pure function that maps a status
/// snapshot to the gate outcome without performing any I/O.
#[derive(Debug, PartialEq, Eq)]
enum GateDecision {
    /// Let the stop/uninstall proceed.
    Bypass,
    /// Refuse the operation; `draining` selects the UX variant.
    Refuse { draining: bool },
}

/// Pure decision logic shared by the gate — testable without systemctl.
///
/// Short-circuit order:
/// 1. `mode == "stopped"` or `"stopping"` — teardown has already started.
///    The runner is actively cancelling any in-flight jobs itself; a user
///    `stop`/`uninstall` just accelerates the process and is safe.
/// 2. `run_ids.is_empty()` — nothing to protect, regardless of mode.
/// 3. Otherwise refuse; `draining=true` when `mode == "draining"` so the
///    error message suggests waiting rather than re-running `drain`.
///
/// Mode strings mirror [`crate::lifecycle::RunnerMode`] (serde lowercase).
fn decide_gate(status: &RunnerStatusSnapshot) -> GateDecision {
    if matches!(status.mode.as_str(), "stopped" | "stopping") {
        return GateDecision::Bypass;
    }
    if status.run_ids.is_empty() {
        return GateDecision::Bypass;
    }
    GateDecision::Refuse {
        draining: status.mode == "draining",
    }
}

pub(super) async fn read_runner_status(
    base_dir: &Path,
) -> Result<RunnerStatusSnapshot, RunnerStatusReadError> {
    let path = status_file::path(base_dir);
    let file = match status_file::read_as::<StatusForGate>(base_dir).await {
        Ok(Some(file)) => file,
        Ok(None) => {
            return Err(RunnerStatusReadError::Read {
                path: path.clone(),
                error: std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("{} not found", path.display()),
                ),
            });
        }
        Err(StatusFileReadError::Read { path, error }) => {
            return Err(RunnerStatusReadError::Read {
                path,
                error: std::io::Error::other(error.to_string()),
            });
        }
        Err(StatusFileReadError::ParseJson { path, error }) => {
            return Err(RunnerStatusReadError::ParseJson { path, error });
        }
    };
    let started = chrono::DateTime::parse_from_rfc3339(&file.started_at).map_err(|error| {
        RunnerStatusReadError::ParseStartedAt {
            started_at: file.started_at.clone(),
            error,
        }
    })?;
    let started_at = started.with_timezone(&chrono::Utc);
    let now = chrono::Utc::now();
    let uptime = (now - started_at).to_std().unwrap_or_default();
    Ok(RunnerStatusSnapshot {
        mode: file.mode,
        started_at,
        run_ids: file.active_runs.into_iter().map(|run| run.run_id).collect(),
        uptime,
    })
}

/// Gate for `service stop` / `service uninstall`: block the operation when
/// the runner has active jobs unless `force` is set.
///
/// Returns `Ok(())` to proceed (either bypassed or confirmed safe). Returns
/// `Err(RunnerError::ActiveJobs(_))` to refuse with a user-facing message.
///
/// ## Transient / race handling
///
/// Each of these conditions returns `Ok(())` to let the operator through:
///
/// 1. **Dead / crashed runner** — if the systemd unit is inactive, the
///    on-disk `active_runs` may be stale (runner was SIGKILLed before it
///    could update status.json). Nothing alive to protect; skip the gate.
/// 2. **Cleanly stopped runner** — `mode == "stopped"` indicates the
///    runner's own drain finished. Covers the short window between
///    status.json being rewritten with `"stopped"` (`start.rs` end of
///    `run_with_config`) and systemd noticing the process has exited
///    (marking the unit inactive). Without this, the gate could spuriously
///    refuse a stop issued during that window.
///
/// Once systemd confirms that the unit is active, the gate fails closed unless
/// the unit's selected config resolves to one verified live Runner record and
/// that record's status is readable. Without that correlation, the gate cannot
/// prove that teardown is safe. `--force` remains the explicit override.
/// A systemd query error is likewise unknown state rather than confirmed
/// inactivity, so it fails closed before selected-config or status inspection.
///
/// When the runner's `mode == "draining"`, we still refuse but flip the
/// `draining` flag so the error renders a wait-or-force message (the
/// operator already initiated drain, so re-suggesting drain would be
/// noise).
///
/// ## TOCTOU (documented, not mitigated)
///
/// Between this gate reading status.json and `systemctl stop` killing the
/// process, the runner may claim a new job via its API poll (seconds
/// cadence). That job will be killed. This is *intentional*: `stop` is
/// defined as forceful. Callers who need zero-race graceful shutdown
/// should use `service drain`. Mitigating this race would require sending
/// SIGUSR1 first and waiting — which is exactly what `drain` does.
pub(super) async fn check_active_jobs_gate(
    unit: &RunnerServiceUnit,
    home: &HomePaths,
    force: bool,
    command_name: &'static str,
    ops: &mut impl ActiveJobsGateOps,
) -> RunnerResult<()> {
    if force {
        // Leave an audit trail — --force is valid but destructive, so
        // journalctl should show it was used if jobs later appear lost.
        info!(
            unit = %unit.unit_name(),
            command = command_name,
            "--force passed, bypassing active-jobs gate"
        );
        return Ok(());
    }

    // (1) Dead-runner short-circuit.
    let active = ops.is_unit_active(unit).await.map_err(|error| {
        RunnerError::Internal(format!(
            "cannot determine whether {} is active while checking active jobs before service {command_name}: {error}; retry or pass --force to override the active-jobs gate",
            unit.unit_name()
        ))
    })?;
    if !active {
        return Ok(());
    }

    let config_path = ops.read_unit_config_path(unit).await?.ok_or_else(|| {
        RunnerError::Internal(format!(
            "{} does not select a runner --config path; refusing service {command_name} while the unit is active; retry or pass --force to override the active-jobs gate",
            unit.unit_name()
        ))
    })?;
    let base_dir = selected_config_base_dir(unit, &config_path, home)
        .await?
        .ok_or_else(|| {
            RunnerError::Internal(format!(
                "cannot resolve a live runner instance for {} from selected config {}; refusing service {command_name} while the unit is active; retry or pass --force to override the active-jobs gate",
                unit.unit_name(),
                config_path.display()
            ))
        })?;
    let status = read_runner_status(&base_dir).await.map_err(|error| {
        RunnerError::Internal(format!(
            "cannot read status.json for {} at {} while checking active jobs before service {command_name}: {error}; retry or pass --force to override the active-jobs gate",
            unit.unit_name(),
            base_dir.display()
        ))
    })?;

    match decide_gate(&status) {
        GateDecision::Bypass => Ok(()),
        GateDecision::Refuse { draining } => {
            Err(RunnerError::ActiveJobs(Box::new(ActiveJobsError {
                unit: unit.unit_name().to_string(),
                suffix: unit.suffix().to_string(),
                run_ids: status.run_ids,
                runner_uptime: status.uptime,
                command_name,
                draining,
            })))
        }
    }
}

#[cfg(test)]
mod tests;
