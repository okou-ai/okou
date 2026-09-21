//! Transaction invariants for `service drain` and `service resume`.
//!
//! Both command entry points acquire the service lock before entering the
//! orchestration below. The systemd mutations inside that lock are ordered:
//! boot enablement controls the next boot, while the runtime restart override
//! takes effect only after a daemon reload. Do not reorder these operations
//! around signal delivery.
//!
//! ## Drain
//!
//! [`drain_with_ops`] reads the unit lifecycle state and best-effort snapshots
//! its boot enablement. For an active-like unit, it then writes the runtime
//! `Restart=no` drop-in, asks systemd to disable the unit without reloading,
//! reloads systemd with the drop-in required, and verifies the effective
//! restart policy before sending SIGUSR1. Disabling is best effort because it
//! protects the next boot; the loaded `Restart=no` policy is the safety gate
//! that prevents a draining process from being automatically replaced.
//!
//! The lifecycle read, policy verification, and signal can race with process
//! exit or a restart that systemd already committed. After the policy is
//! verified, [`wait_for_drain_signal_convergence`] keeps the transition
//! fail-closed while it either signals the active replacement or observes a
//! state that no longer needs a signal.
//! After signal delivery, [`wait_for_drain_acknowledgement`] requires the
//! captured live process and status generation to report Draining/Stopping,
//! or observes service/process exit. It does not wait for active runs.
//!
//! ## Drain rollback boundary
//!
//! Reload failures and effective-policy mismatches occur before the first
//! signal attempt and use [`rollback_drain_transition`] to restore captured boot
//! enablement and reload the restored state. A policy query error follows the
//! same path unless a lifecycle recheck proves the runner already exited; in
//! that case no signal or rollback is needed and drain leaves the protected
//! state in place. Rollback removes a drop-in created by the current attempt,
//! but a repeated drain reports that the drop-in already existed and preserves
//! that protection instead of removing it.
//!
//! Once signal delivery has been attempted, convergence failures deliberately
//! do not roll back. At that point the original process may have exited while
//! a replacement is racing into view; retaining the verified `Restart=no`
//! policy is safer than restoring automatic restart under stale assumptions.
//! The operator can retry `service drain` from that protected state.
//!
//! ## Resume
//!
//! [`resume_with_ops`] first requires an active unit whose status is exactly
//! `draining`. This preflight prevents an early SIGUSR2 from racing with a
//! pending SIGUSR1, and captures `started_at` as the identity of the process
//! being resumed. [`resume_after_preflight_with_ops`] then removes the drain
//! override, asks systemd to enable the unit without reloading, reloads with
//! the override required to be absent, sends SIGUSR2, and waits for an
//! acknowledgement through [`wait_for_resume_acknowledgement`]. The
//! acknowledgement is valid only when the unit remains active, the same
//! `started_at` process reports status, and its mode becomes `running`.
//!
//! Enabling is best effort for the same boot-versus-runtime reason as drain.
//! Reload, signal, or acknowledgement failure uses
//! [`rollback_resume_transition`] to restore captured boot enablement and
//! reload systemd. If this attempt removed a `Restart=no` override, rollback
//! recreates it first. This applies even after SIGUSR2 was sent; any rollback
//! failure is added to the transition error.
//!
//! ## Enforcement
//!
//! The orchestration and rollback helpers above define the phase boundaries.
//! The tests in this module lock down their contract: see
//! `drain_active_service_disables_restart_before_signal`,
//! `repeated_drain_reload_failure_preserves_restart_override`,
//! `drain_signal_failure_converges_without_rollback`, the
//! `drain_convergence_*_retains_restart_override` cases, the `resume_refuses_*`
//! preflight cases, `resume_enables_and_reloads_before_signal`, and the
//! `resume_*_rolls_back_transition` acknowledgement and rollback cases.

use std::path::Path;
use std::time::Duration;

use clap::Args;
use tokio::time::Instant;
use tracing::{info, warn};

use crate::error::{RunnerError, RunnerResult};
use crate::live_runner_instances::{self, LiveRunnerInstance};
use crate::paths::HomePaths;
use crate::status_file;

use super::drain_override::{
    DrainRestartOverrideWrite, remove_drain_restart_override, write_drain_restart_override,
};
use super::gate::read_runner_status;
use super::reload::{SystemdReloadRequirement, coordinate_systemd_reload};
use super::signal::{ServiceSignalOutcome, signal_service_main, signal_service_main_bounded};
use super::systemctl::{
    CleanupUnitActiveState, SystemdUnitEnablement, cleanup_unit_active_state_bounded,
    get_service_restart_policy, is_unit_active_bounded, read_unit_enablement,
    restore_unit_enablement, run_systemctl,
};
use super::{
    RunnerServiceUnit, ServiceFuture, acquire_service_lock, read_unit_config_path,
    selected_config_base_dir, selected_config_live_instance,
};

const DRAIN_SIGNAL_CONVERGENCE_TIMEOUT: Duration = Duration::from_secs(10);
const DRAIN_SIGNAL_CONVERGENCE_POLL_INTERVAL: Duration = Duration::from_millis(250);
const DRAIN_ACKNOWLEDGEMENT_TIMEOUT: Duration = Duration::from_secs(10);
const DRAIN_ACKNOWLEDGEMENT_POLL_INTERVAL: Duration = Duration::from_millis(250);
const RESUME_ACKNOWLEDGEMENT_TIMEOUT: Duration = Duration::from_secs(10);
const RESUME_ACKNOWLEDGEMENT_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Args)]
pub(super) struct DrainArgs {
    /// Service name suffix (e.g. v0.2.0 → unit vm0-runner-v0.2.0)
    #[arg(long)]
    name: String,
}

#[derive(Args)]
pub(super) struct ResumeArgs {
    /// Service name suffix (e.g. v0.2.0 → unit vm0-runner-v0.2.0)
    #[arg(long)]
    name: String,
}

fn ensure_drain_restart_policy_applied(
    unit: &RunnerServiceUnit,
    restart_policy: &str,
) -> RunnerResult<()> {
    if restart_policy == "no" {
        return Ok(());
    }
    Err(RunnerError::Internal(format!(
        "effective Restart={restart_policy:?} for {} after drain override; expected Restart=no",
        unit.service_name()
    )))
}

trait ServiceDrainOps {
    fn lifecycle_state<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        timeout: Duration,
    ) -> ServiceFuture<'a, CleanupUnitActiveState>;
    fn enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, SystemdUnitEnablement>;
    fn write_restart_override(
        &mut self,
        unit: &RunnerServiceUnit,
    ) -> RunnerResult<DrainRestartOverrideWrite>;
    fn remove_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<bool>;
    fn daemon_reload<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        requirement: SystemdReloadRequirement,
    ) -> ServiceFuture<'a, ()>;
    fn restart_policy<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, String>;
    fn signal_drain<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, ServiceSignalOutcome>;
    fn signal_drain_bounded<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        timeout: Duration,
    ) -> ServiceFuture<'a, ServiceSignalOutcome>;
    fn disable<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()>;
    fn restore_enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        enablement: SystemdUnitEnablement,
    ) -> ServiceFuture<'a, ()>;
    fn read_unit_config_path<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, Option<std::path::PathBuf>>;
}

trait ServiceResumeOps {
    fn is_active<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        timeout: Duration,
    ) -> ServiceFuture<'a, bool>;
    fn read_unit_config_path<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, Option<std::path::PathBuf>>;
    fn enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, SystemdUnitEnablement>;
    fn write_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<()>;
    fn remove_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<bool>;
    fn daemon_reload<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        requirement: SystemdReloadRequirement,
    ) -> ServiceFuture<'a, ()>;
    fn signal_resume<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, ServiceSignalOutcome>;
    fn enable<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()>;
    fn restore_enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        enablement: SystemdUnitEnablement,
    ) -> ServiceFuture<'a, ()>;
}

struct RealServiceDrainOps;
struct RealServiceResumeOps;

impl ServiceDrainOps for RealServiceDrainOps {
    fn lifecycle_state<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        timeout: Duration,
    ) -> ServiceFuture<'a, CleanupUnitActiveState> {
        Box::pin(async move { cleanup_unit_active_state_bounded(unit, timeout).await })
    }

    fn enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, SystemdUnitEnablement> {
        Box::pin(async move { read_unit_enablement(unit).await })
    }

    fn write_restart_override(
        &mut self,
        unit: &RunnerServiceUnit,
    ) -> RunnerResult<DrainRestartOverrideWrite> {
        write_drain_restart_override(unit)
    }

    fn remove_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<bool> {
        remove_drain_restart_override(unit)
    }

    fn daemon_reload<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        requirement: SystemdReloadRequirement,
    ) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            coordinate_systemd_reload(unit, requirement)
                .await
                .map(|_| ())
        })
    }

    fn restart_policy<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, String> {
        Box::pin(async move { get_service_restart_policy(unit).await })
    }

    fn signal_drain<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, ServiceSignalOutcome> {
        Box::pin(async move { signal_service_main(unit, nix::sys::signal::Signal::SIGUSR1).await })
    }

    fn signal_drain_bounded<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        timeout: Duration,
    ) -> ServiceFuture<'a, ServiceSignalOutcome> {
        Box::pin(async move {
            signal_service_main_bounded(unit, nix::sys::signal::Signal::SIGUSR1, timeout).await
        })
    }

    fn disable<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
        Box::pin(
            async move { run_systemctl(&["disable", "--no-reload", unit.service_name()]).await },
        )
    }

    fn restore_enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        enablement: SystemdUnitEnablement,
    ) -> ServiceFuture<'a, ()> {
        Box::pin(async move { restore_unit_enablement(unit, enablement).await })
    }

    fn read_unit_config_path<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, Option<std::path::PathBuf>> {
        Box::pin(async move { read_unit_config_path(unit).await })
    }
}

impl ServiceResumeOps for RealServiceResumeOps {
    fn is_active<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        timeout: Duration,
    ) -> ServiceFuture<'a, bool> {
        Box::pin(async move { is_unit_active_bounded(unit, timeout).await })
    }

    fn read_unit_config_path<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, Option<std::path::PathBuf>> {
        Box::pin(async move { read_unit_config_path(unit).await })
    }

    fn enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, SystemdUnitEnablement> {
        Box::pin(async move { read_unit_enablement(unit).await })
    }

    fn write_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<()> {
        write_drain_restart_override(unit).map(|_| ())
    }

    fn remove_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<bool> {
        remove_drain_restart_override(unit)
    }

    fn daemon_reload<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        requirement: SystemdReloadRequirement,
    ) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            coordinate_systemd_reload(unit, requirement)
                .await
                .map(|_| ())
        })
    }

    fn signal_resume<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, ServiceSignalOutcome> {
        Box::pin(async move { signal_service_main(unit, nix::sys::signal::Signal::SIGUSR2).await })
    }

    fn enable<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
        Box::pin(
            async move { run_systemctl(&["enable", "--no-reload", unit.service_name()]).await },
        )
    }

    fn restore_enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        enablement: SystemdUnitEnablement,
    ) -> ServiceFuture<'a, ()> {
        Box::pin(async move { restore_unit_enablement(unit, enablement).await })
    }
}

fn transition_error_with_rollback_failure(
    unit: &RunnerServiceUnit,
    transition: &str,
    error: RunnerError,
    rollback_error: RunnerError,
) -> RunnerError {
    RunnerError::Internal(format!(
        "{transition} failed for {}: {error}; additionally rollback failed: {rollback_error}",
        unit.unit_name()
    ))
}

async fn rollback_drain_transition(
    unit: &RunnerServiceUnit,
    restart_override_write: Option<DrainRestartOverrideWrite>,
    prior_enablement: Option<SystemdUnitEnablement>,
    ops: &mut impl ServiceDrainOps,
    context: &str,
) -> RunnerResult<()> {
    let mut failures = Vec::new();

    if restart_override_write == Some(DrainRestartOverrideWrite::Created) {
        match ops.remove_restart_override(unit) {
            Ok(_) => {}
            Err(error) => failures.push(format!("remove drain restart override: {error}")),
        }
    }

    match prior_enablement {
        Some(enablement) => {
            if let Err(error) = ops.restore_enablement(unit, enablement).await {
                failures.push(format!("restore boot enablement: {error}"));
            }
        }
        None => failures.push("prior boot enablement is unavailable".to_string()),
    }

    let reload_requirement = match restart_override_write {
        Some(DrainRestartOverrideWrite::Created) => {
            SystemdReloadRequirement::dirty().with_drain_override(false)
        }
        Some(DrainRestartOverrideWrite::Replaced) => {
            SystemdReloadRequirement::dirty().with_drain_override(true)
        }
        None => SystemdReloadRequirement::dirty(),
    };
    if let Err(error) = ops.daemon_reload(unit, reload_requirement).await {
        failures.push(format!("reload restored systemd state: {error}"));
    }

    if restart_override_write == Some(DrainRestartOverrideWrite::Replaced) {
        match ops.restart_policy(unit).await {
            Ok(restart_policy) => {
                if let Err(error) = ensure_drain_restart_policy_applied(unit, &restart_policy) {
                    failures.push(format!("verify restored drain restart policy: {error}"));
                }
            }
            Err(error) => {
                failures.push(format!("verify restored drain restart policy: {error}"));
            }
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(RunnerError::Internal(format!(
            "failed to roll back drain transition for {} ({context}): {}",
            unit.unit_name(),
            failures.join("; ")
        )))
    }
}

async fn rollback_resume_transition(
    unit: &RunnerServiceUnit,
    drain_override_removed: bool,
    prior_enablement: Option<SystemdUnitEnablement>,
    ops: &mut impl ServiceResumeOps,
    context: &str,
) -> RunnerResult<()> {
    let mut failures = Vec::new();

    if drain_override_removed && let Err(error) = ops.write_restart_override(unit) {
        failures.push(format!("restore drain restart override: {error}"));
    }

    match prior_enablement {
        Some(enablement) => {
            if let Err(error) = ops.restore_enablement(unit, enablement).await {
                failures.push(format!("restore boot enablement: {error}"));
            }
        }
        None => failures.push("prior boot enablement is unavailable".to_string()),
    }

    let reload_requirement = if drain_override_removed {
        SystemdReloadRequirement::dirty().with_drain_override(true)
    } else {
        SystemdReloadRequirement::dirty()
    };
    if let Err(error) = ops.daemon_reload(unit, reload_requirement).await {
        failures.push(format!("reload restored systemd state: {error}"));
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(RunnerError::Internal(format!(
            "failed to roll back resume transition for {} ({context}): {}",
            unit.unit_name(),
            failures.join("; ")
        )))
    }
}

async fn drain_error_after_rollback(
    unit: &RunnerServiceUnit,
    restart_override_write: Option<DrainRestartOverrideWrite>,
    prior_enablement: Option<SystemdUnitEnablement>,
    ops: &mut impl ServiceDrainOps,
    context: &str,
    error: RunnerError,
) -> RunnerError {
    match rollback_drain_transition(unit, restart_override_write, prior_enablement, ops, context)
        .await
    {
        Ok(()) => error,
        Err(rollback_error) => {
            transition_error_with_rollback_failure(unit, "drain", error, rollback_error)
        }
    }
}

async fn resume_error_after_rollback(
    unit: &RunnerServiceUnit,
    drain_override_removed: bool,
    prior_enablement: Option<SystemdUnitEnablement>,
    ops: &mut impl ServiceResumeOps,
    context: &str,
    error: RunnerError,
) -> RunnerError {
    match rollback_resume_transition(unit, drain_override_removed, prior_enablement, ops, context)
        .await
    {
        Ok(()) => error,
        Err(rollback_error) => {
            transition_error_with_rollback_failure(unit, "resume", error, rollback_error)
        }
    }
}

fn ensure_resume_mode_is_draining(unit: &RunnerServiceUnit, mode: &str) -> RunnerResult<()> {
    match mode {
        "draining" => Ok(()),
        "stopping" | "stopped" => Err(RunnerError::Internal(format!(
            "{} is already shutting down (mode={mode}) — cannot resume",
            unit.unit_name()
        ))),
        "running" => Err(RunnerError::Internal(format!(
            "{} is running, not draining — cannot resume",
            unit.unit_name()
        ))),
        "starting" => Err(RunnerError::Internal(format!(
            "{} is starting, not draining — cannot resume",
            unit.unit_name()
        ))),
        _ => Err(RunnerError::Internal(format!(
            "{} is in unknown mode {mode:?} — cannot resume",
            unit.unit_name()
        ))),
    }
}

async fn drain_enablement_before_transition(
    unit: &RunnerServiceUnit,
    ops: &mut impl ServiceDrainOps,
) -> Option<SystemdUnitEnablement> {
    match ops.enablement(unit).await {
        Ok(enablement) => Some(enablement),
        Err(error) => {
            warn!(
                unit = %unit.unit_name(),
                error = %error,
                "failed to read boot enablement before drain; rollback may be partial"
            );
            None
        }
    }
}

async fn resume_enablement_before_transition(
    unit: &RunnerServiceUnit,
    ops: &mut impl ServiceResumeOps,
) -> Option<SystemdUnitEnablement> {
    match ops.enablement(unit).await {
        Ok(enablement) => Some(enablement),
        Err(error) => {
            warn!(
                unit = %unit.unit_name(),
                error = %error,
                "failed to read boot enablement before resume; rollback may be partial"
            );
            None
        }
    }
}

fn drain_signal_convergence_error(unit: &RunnerServiceUnit, detail: &str) -> RunnerError {
    RunnerError::Internal(format!(
        "cannot safely complete drain for {} while converging signal delivery: {detail}; \
         Restart=no remains applied; retry service drain",
        unit.unit_name()
    ))
}

fn drain_signal_convergence_timeout_error(
    unit: &RunnerServiceUnit,
    last_active_state: &str,
) -> RunnerError {
    drain_signal_convergence_error(
        unit,
        &format!(
            "timed out after {}s waiting to signal an active runner \
             (last ActiveState={last_active_state:?})",
            DRAIN_SIGNAL_CONVERGENCE_TIMEOUT.as_secs()
        ),
    )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DrainSignalConvergence {
    SignalDelivered,
    ServiceStopped,
}

#[derive(serde::Deserialize)]
struct DrainStatusFile {
    mode: String,
    started_at: String,
    updated_at: String,
}

struct DrainStatusSnapshot {
    mode: String,
    started_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

async fn read_drain_status(base_dir: &Path) -> RunnerResult<DrainStatusSnapshot> {
    let path = status_file::path(base_dir);
    let file = status_file::read_as::<DrainStatusFile>(base_dir)
        .await
        .map_err(|error| RunnerError::Internal(error.to_string()))?
        .ok_or_else(|| RunnerError::Internal(format!("{} not found", path.display())))?;
    let started_at = chrono::DateTime::parse_from_rfc3339(&file.started_at)
        .map(|value| value.with_timezone(&chrono::Utc))
        .map_err(|error| {
            RunnerError::Internal(format!(
                "parse started_at {:?} in {}: {error}",
                file.started_at,
                path.display()
            ))
        })?;
    let updated_at = chrono::DateTime::parse_from_rfc3339(&file.updated_at)
        .map(|value| value.with_timezone(&chrono::Utc))
        .map_err(|error| {
            RunnerError::Internal(format!(
                "parse updated_at {:?} in {}: {error}",
                file.updated_at,
                path.display()
            ))
        })?;
    Ok(DrainStatusSnapshot {
        mode: file.mode,
        started_at,
        updated_at,
    })
}

async fn wait_for_drain_signal_convergence(
    unit: &RunnerServiceUnit,
    ops: &mut impl ServiceDrainOps,
) -> RunnerResult<DrainSignalConvergence> {
    let deadline = Instant::now() + DRAIN_SIGNAL_CONVERGENCE_TIMEOUT;
    let mut last_active_state = "unknown".to_string();

    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(drain_signal_convergence_timeout_error(
                unit,
                &last_active_state,
            ));
        }

        let state = ops
            .lifecycle_state(unit, deadline - now)
            .await
            .map_err(|error| {
                drain_signal_convergence_error(
                    unit,
                    &format!("cannot read systemd lifecycle state: {error}"),
                )
            })?;
        last_active_state = state.active_state().to_string();

        if !state.is_active_like() {
            info!(
                unit = %unit.unit_name(),
                active_state = %state.active_state(),
                "runner exited before drain signal convergence"
            );
            return Ok(DrainSignalConvergence::ServiceStopped);
        }
        if state.active_state() == "deactivating" {
            // Restart=no was verified before signal delivery. While systemd is
            // still deactivating it has not committed an auto-restart timer,
            // so the loaded policy prevents a replacement from appearing.
            info!(
                unit = %unit.unit_name(),
                "runner is deactivating with Restart=no applied; drain signal not needed"
            );
            return Ok(DrainSignalConvergence::ServiceStopped);
        }

        let now = Instant::now();
        if now >= deadline {
            continue;
        }
        let signal_result = ops
            .signal_drain_bounded(unit, deadline - now)
            .await
            .map_err(|error| {
                drain_signal_convergence_error(
                    unit,
                    &format!("cannot signal active runner: {error}"),
                )
            })?;

        match signal_result {
            ServiceSignalOutcome::Sent => {
                info!(unit = %unit.unit_name(), "sent SIGUSR1 (drain) during signal convergence");
                return Ok(DrainSignalConvergence::SignalDelivered);
            }
            ServiceSignalOutcome::AlreadyGone => {}
        }

        let now = Instant::now();
        if now >= deadline {
            continue;
        }
        tokio::time::sleep(std::cmp::min(
            DRAIN_SIGNAL_CONVERGENCE_POLL_INTERVAL,
            deadline - now,
        ))
        .await;
    }
}

async fn drain_with_ops(
    unit: &RunnerServiceUnit,
    ops: &mut impl ServiceDrainOps,
) -> RunnerResult<DrainSignalConvergence> {
    let initial_state = ops
        .lifecycle_state(unit, DRAIN_SIGNAL_CONVERGENCE_TIMEOUT)
        .await?;
    let mut should_signal = initial_state.is_active_like();
    let prior_enablement = drain_enablement_before_transition(unit, ops).await;
    if !should_signal {
        info!(unit = %unit.unit_name(), "no active service found; drain signal not needed");
    }

    let restart_override_write = if should_signal {
        Some(ops.write_restart_override(unit)?)
    } else {
        None
    };

    if let Err(error) = ops.disable(unit).await {
        warn!(unit = %unit.unit_name(), error = %error, "failed to disable unit");
        eprintln!(
            "WARNING: drain could not disable {}: {error}. \
             Run it manually to prevent the unit from restarting on reboot.",
            unit.service_name()
        );
    } else {
        info!(unit = %unit.unit_name(), "disabled (won't restart on reboot)");
    }

    let reload_requirement = if restart_override_write.is_some() {
        SystemdReloadRequirement::dirty().with_drain_override(true)
    } else {
        SystemdReloadRequirement::dirty()
    };
    if let Err(error) = ops.daemon_reload(unit, reload_requirement).await {
        return Err(drain_error_after_rollback(
            unit,
            restart_override_write,
            prior_enablement,
            ops,
            "daemon_reload",
            error,
        )
        .await);
    }

    if should_signal {
        match ops.restart_policy(unit).await {
            Ok(restart_policy) => {
                if let Err(error) = ensure_drain_restart_policy_applied(unit, &restart_policy) {
                    return Err(drain_error_after_rollback(
                        unit,
                        restart_override_write,
                        prior_enablement,
                        ops,
                        "restart_policy",
                        error,
                    )
                    .await);
                }
            }
            Err(error) => {
                match ops
                    .lifecycle_state(unit, DRAIN_SIGNAL_CONVERGENCE_TIMEOUT)
                    .await
                {
                    Ok(state) if state.is_active_like() => {
                        return Err(drain_error_after_rollback(
                            unit,
                            restart_override_write,
                            prior_enablement,
                            ops,
                            "restart_policy",
                            error,
                        )
                        .await);
                    }
                    Ok(_) => {}
                    Err(active_err) => {
                        return Err(drain_error_after_rollback(
                            unit,
                            restart_override_write,
                            prior_enablement,
                            ops,
                            "restart_policy_active_check",
                            active_err,
                        )
                        .await);
                    }
                }
                info!(
                    unit = %unit.unit_name(),
                    "runner exited before restart policy verification; drain signal not needed"
                );
                should_signal = false;
            }
        }
    }

    let convergence = if should_signal {
        // The lifecycle query above can race against the runner exiting or an
        // already-committed auto-restart timer. Once the main process is gone,
        // retain fail-closed state and converge instead of rolling protections
        // back into a potentially restarting service.
        match ops.signal_drain(unit).await {
            Err(error) => {
                warn!(
                    unit = %unit.unit_name(),
                    error = %error,
                    "initial drain signal failed; retaining Restart=no while converging"
                );
                wait_for_drain_signal_convergence(unit, ops).await?
            }
            Ok(ServiceSignalOutcome::Sent) => {
                info!(unit = %unit.unit_name(), "sent SIGUSR1 (drain)");
                DrainSignalConvergence::SignalDelivered
            }
            Ok(ServiceSignalOutcome::AlreadyGone) => {
                wait_for_drain_signal_convergence(unit, ops).await?
            }
        }
    } else {
        DrainSignalConvergence::ServiceStopped
    };

    Ok(convergence)
}

struct DrainAcknowledgementTarget {
    instance: LiveRunnerInstance,
    started_at: chrono::DateTime<chrono::Utc>,
}

async fn capture_drain_acknowledgement_target(
    unit: &RunnerServiceUnit,
    home: &HomePaths,
    ops: &mut impl ServiceDrainOps,
) -> RunnerResult<DrainAcknowledgementTarget> {
    let config_path = ops.read_unit_config_path(unit).await?.ok_or_else(|| {
        RunnerError::Internal(format!(
            "{} does not select a runner --config path — cannot observe drain acknowledgement",
            unit.unit_name()
        ))
    })?;
    let instance = selected_config_live_instance(unit, &config_path, home)
        .await?
        .ok_or_else(|| {
            RunnerError::Internal(format!(
                "cannot resolve a live runner instance for {} from selected config {} — cannot observe drain acknowledgement",
                unit.unit_name(),
                config_path.display()
            ))
        })?;
    let status = read_drain_status(&instance.base_dir)
        .await
        .map_err(|error| {
            RunnerError::Internal(format!(
                "cannot read status.json for {} before drain: {error}",
                unit.unit_name()
            ))
        })?;
    let instance_published_at = chrono::DateTime::parse_from_rfc3339(&instance.started_at)
        .map(|value| value.with_timezone(&chrono::Utc))
        .map_err(|error| {
            RunnerError::Internal(format!(
                "cannot parse live runner instance started_at {:?} for {} before drain: {error}",
                instance.started_at,
                unit.unit_name()
            ))
        })?;
    // Startup publishes the live-process record before its initial status.
    // Reject a leftover status file that the selected process has not updated.
    if status.updated_at < instance_published_at {
        return Err(RunnerError::Internal(format!(
            "status.json for {} predates the selected live process (status updated_at={}, live instance started_at={}) — cannot observe drain acknowledgement",
            unit.unit_name(),
            status.updated_at,
            instance_published_at
        )));
    }
    Ok(DrainAcknowledgementTarget {
        instance,
        started_at: status.started_at,
    })
}

fn drain_acknowledgement_timeout_error(
    unit: &RunnerServiceUnit,
    last_observation: &str,
) -> RunnerError {
    RunnerError::Internal(format!(
        "timed out after {}s waiting for {} to acknowledge drain (last observation: {last_observation}); Restart=no remains applied",
        DRAIN_ACKNOWLEDGEMENT_TIMEOUT.as_secs(),
        unit.unit_name()
    ))
}

async fn wait_for_next_drain_observation(deadline: Instant) {
    let now = Instant::now();
    if now < deadline {
        tokio::time::sleep(std::cmp::min(
            DRAIN_ACKNOWLEDGEMENT_POLL_INTERVAL,
            deadline - now,
        ))
        .await;
    }
}

async fn wait_for_drain_acknowledgement(
    unit: &RunnerServiceUnit,
    home: &HomePaths,
    target: Result<DrainAcknowledgementTarget, RunnerError>,
    ops: &mut impl ServiceDrainOps,
) -> RunnerResult<()> {
    let deadline = Instant::now() + DRAIN_ACKNOWLEDGEMENT_TIMEOUT;
    let mut last_observation = "not observed".to_string();

    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(drain_acknowledgement_timeout_error(unit, &last_observation));
        }

        let state = ops
            .lifecycle_state(unit, deadline - now)
            .await
            .map_err(|error| {
                RunnerError::Internal(format!(
                    "cannot read systemd lifecycle state for {} while waiting for drain acknowledgement: {error}; Restart=no remains applied",
                    unit.unit_name()
                ))
            })?;
        if !state.is_active_like() || state.active_state() == "deactivating" {
            info!(
                unit = %unit.unit_name(),
                active_state = %state.active_state(),
                "runner acknowledged drain by stopping"
            );
            return Ok(());
        }

        let target = match &target {
            Ok(target) => target,
            Err(error) => {
                last_observation = format!(
                    "ActiveState={:?}, acknowledgement target unavailable: {error}",
                    state.active_state()
                );
                wait_for_next_drain_observation(deadline).await;
                continue;
            }
        };

        let identity_result = tokio::time::timeout(
            deadline.saturating_duration_since(Instant::now()),
            live_runner_instances::is_current(home, &target.instance),
        )
        .await;
        match identity_result {
            Ok(Ok(true)) => {}
            Ok(Ok(false)) => {
                last_observation = format!(
                    "ActiveState={:?}, captured runner process identity is no longer current",
                    state.active_state()
                );
                wait_for_next_drain_observation(deadline).await;
                continue;
            }
            Ok(Err(error)) => {
                last_observation = format!(
                    "ActiveState={:?}, cannot verify runner process identity: {error}",
                    state.active_state()
                );
                wait_for_next_drain_observation(deadline).await;
                continue;
            }
            Err(_) => {
                let observation = format!(
                    "ActiveState={:?}, process identity observation did not finish",
                    state.active_state()
                );
                return Err(drain_acknowledgement_timeout_error(unit, &observation));
            }
        }

        let status_result = tokio::time::timeout(
            deadline.saturating_duration_since(Instant::now()),
            read_drain_status(&target.instance.base_dir),
        )
        .await;
        match status_result {
            Ok(Ok(status)) => {
                if status.started_at != target.started_at {
                    return Err(RunnerError::Internal(format!(
                        "{} status generation changed before drain acknowledgement (started_at changed from {} to {}); Restart=no remains applied",
                        unit.unit_name(),
                        target.started_at,
                        status.started_at
                    )));
                }
                match status.mode.as_str() {
                    "draining" | "stopping" | "stopped" => {
                        info!(
                            unit = %unit.unit_name(),
                            mode = %status.mode,
                            "runner acknowledged drain"
                        );
                        return Ok(());
                    }
                    "starting" | "running" => {
                        last_observation = format!(
                            "ActiveState={:?}, mode={:?}, started_at={}",
                            state.active_state(),
                            status.mode,
                            status.started_at
                        );
                    }
                    mode => {
                        return Err(RunnerError::Internal(format!(
                            "{} reported invalid mode {mode:?} while acknowledging drain; Restart=no remains applied",
                            unit.unit_name()
                        )));
                    }
                }
            }
            Ok(Err(error)) => {
                last_observation = format!(
                    "ActiveState={:?}, cannot read status.json: {error}",
                    state.active_state()
                );
            }
            Err(_) => {
                let observation = format!(
                    "ActiveState={:?}, status.json observation did not finish",
                    state.active_state()
                );
                return Err(drain_acknowledgement_timeout_error(unit, &observation));
            }
        }

        wait_for_next_drain_observation(deadline).await;
    }
}

async fn drain_and_wait_with_ops(
    unit: &RunnerServiceUnit,
    home: &HomePaths,
    ops: &mut impl ServiceDrainOps,
) -> RunnerResult<()> {
    let target = match tokio::time::timeout(
        DRAIN_ACKNOWLEDGEMENT_TIMEOUT,
        capture_drain_acknowledgement_target(unit, home, ops),
    )
    .await
    {
        Ok(target) => target,
        Err(_) => Err(RunnerError::Internal(format!(
            "timed out after {}s resolving the acknowledgement target for {} before drain",
            DRAIN_ACKNOWLEDGEMENT_TIMEOUT.as_secs(),
            unit.unit_name()
        ))),
    };
    match drain_with_ops(unit, ops).await? {
        DrainSignalConvergence::SignalDelivered => {
            wait_for_drain_acknowledgement(unit, home, target, ops).await
        }
        DrainSignalConvergence::ServiceStopped => Ok(()),
    }
}

fn resume_acknowledgement_timeout_error(unit: &RunnerServiceUnit) -> RunnerError {
    RunnerError::Internal(format!(
        "timed out after {}s waiting for {} to acknowledge resume (last mode=draining)",
        RESUME_ACKNOWLEDGEMENT_TIMEOUT.as_secs(),
        unit.unit_name()
    ))
}

async fn wait_for_resume_acknowledgement(
    unit: &RunnerServiceUnit,
    base_dir: &Path,
    expected_started_at: chrono::DateTime<chrono::Utc>,
    ops: &mut impl ServiceResumeOps,
) -> RunnerResult<()> {
    let deadline = Instant::now() + RESUME_ACKNOWLEDGEMENT_TIMEOUT;

    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(resume_acknowledgement_timeout_error(unit));
        }

        let active = ops.is_active(unit, deadline - now).await.map_err(|error| {
            RunnerError::Internal(format!(
                "cannot verify {} while waiting for resume acknowledgement: {error}",
                unit.unit_name()
            ))
        })?;
        if !active {
            return Err(RunnerError::Internal(format!(
                "{} exited before acknowledging resume",
                unit.unit_name()
            )));
        }
        if Instant::now() >= deadline {
            return Err(resume_acknowledgement_timeout_error(unit));
        }

        let status = read_runner_status(base_dir).await.map_err(|error| {
            RunnerError::Internal(format!(
                "cannot read status.json for {} while waiting for resume acknowledgement: {error}",
                unit.unit_name()
            ))
        })?;
        if Instant::now() >= deadline {
            return Err(resume_acknowledgement_timeout_error(unit));
        }
        if status.started_at != expected_started_at {
            return Err(RunnerError::Internal(format!(
                "{} was replaced before acknowledging resume (started_at changed from {} to {})",
                unit.unit_name(),
                expected_started_at,
                status.started_at
            )));
        }

        match status.mode.as_str() {
            "running" => {
                info!(unit = %unit.unit_name(), "runner acknowledged resume");
                return Ok(());
            }
            "draining" => {}
            "stopping" | "stopped" => {
                return Err(RunnerError::Internal(format!(
                    "{} entered mode={} before acknowledging resume",
                    unit.unit_name(),
                    status.mode
                )));
            }
            mode => {
                return Err(RunnerError::Internal(format!(
                    "{} reported invalid mode {mode:?} while acknowledging resume",
                    unit.unit_name()
                )));
            }
        }

        let now = Instant::now();
        if now >= deadline {
            return Err(resume_acknowledgement_timeout_error(unit));
        }
        tokio::time::sleep(std::cmp::min(
            RESUME_ACKNOWLEDGEMENT_POLL_INTERVAL,
            deadline - now,
        ))
        .await;
    }
}

async fn resume_after_preflight_with_ops(
    unit: &RunnerServiceUnit,
    base_dir: &Path,
    expected_started_at: chrono::DateTime<chrono::Utc>,
    ops: &mut impl ServiceResumeOps,
) -> RunnerResult<()> {
    let prior_enablement = resume_enablement_before_transition(unit, ops).await;
    let drain_override_removed = ops.remove_restart_override(unit)?;

    if let Err(error) = ops.enable(unit).await {
        warn!(unit = %unit.unit_name(), error = %error, "failed to re-enable unit");
        eprintln!(
            "WARNING: resume could not `systemctl enable {}`: {error}. \
             Run it manually to restore the restart-on-reboot behavior.",
            unit.service_name()
        );
    } else {
        info!(unit = %unit.unit_name(), "re-enabled (will restart on reboot)");
    }

    if let Err(error) = ops
        .daemon_reload(
            unit,
            SystemdReloadRequirement::dirty().with_drain_override(false),
        )
        .await
    {
        return Err(resume_error_after_rollback(
            unit,
            drain_override_removed,
            prior_enablement,
            ops,
            "daemon_reload",
            error,
        )
        .await);
    }

    let (failure_context, signal_result) = match ops.signal_resume(unit).await {
        Ok(ServiceSignalOutcome::Sent) => {
            info!(unit = %unit.unit_name(), "sent SIGUSR2 (resume)");
            match wait_for_resume_acknowledgement(unit, base_dir, expected_started_at, ops).await {
                Ok(()) => return Ok(()),
                Err(error) => ("acknowledge_resume", error),
            }
        }
        Ok(ServiceSignalOutcome::AlreadyGone) => {
            info!(
                unit = %unit.unit_name(),
                "runner exited between preflight and signal; refusing resume",
            );
            (
                "signal_resume",
                RunnerError::Internal(format!(
                    "{} is not active — cannot resume an inactive runner",
                    unit.unit_name()
                )),
            )
        }
        Err(error) => ("signal_resume", error),
    };

    Err(resume_error_after_rollback(
        unit,
        drain_override_removed,
        prior_enablement,
        ops,
        failure_context,
        signal_result,
    )
    .await)
}

async fn resume_with_ops(
    unit: &RunnerServiceUnit,
    home: &HomePaths,
    ops: &mut impl ServiceResumeOps,
) -> RunnerResult<()> {
    if !ops.is_active(unit, RESUME_ACKNOWLEDGEMENT_TIMEOUT).await? {
        return Err(RunnerError::Internal(format!(
            "{} is not active — cannot resume an inactive runner",
            unit.unit_name()
        )));
    }

    // Only remove Restart=no once status.json confirms the runner has
    // processed SIGUSR1 and entered Draining. A too-early resume while status
    // is still Running can race with the pending SIGUSR1: SIGUSR2 is a no-op
    // in Running, but removing the restart override would let a later Draining
    // runner regain restart behavior.
    let config_path = ops.read_unit_config_path(unit).await?.ok_or_else(|| {
        RunnerError::Internal(format!(
            "{} does not select a runner --config path — cannot resume",
            unit.unit_name()
        ))
    })?;
    let base_dir = selected_config_base_dir(unit, &config_path, home)
        .await?
        .ok_or_else(|| {
            RunnerError::Internal(format!(
                "cannot resolve a live runner instance for {} from selected config {} — cannot resume",
                unit.unit_name(),
                config_path.display()
            ))
        })?;
    let status = read_runner_status(&base_dir).await.map_err(|error| {
        RunnerError::Internal(format!(
            "cannot read status.json for {} during resume preflight: {error}",
            unit.unit_name()
        ))
    })?;
    ensure_resume_mode_is_draining(unit, &status.mode)?;

    resume_after_preflight_with_ops(unit, &base_dir, status.started_at, ops).await
}

/// `service drain` — send SIGUSR1, observe acknowledgement, and disable the unit
/// without waiting for active jobs to finish.
///
/// The command may wait for systemd operations and bounded drain-signal
/// convergence, followed by bounded same-process lifecycle acknowledgement.
pub(super) async fn run_drain(args: DrainArgs) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    let home = HomePaths::new()?;
    let _service_lock = acquire_service_lock(&unit, &home).await?;
    drain_and_wait_with_ops(&unit, &home, &mut RealServiceDrainOps).await
}

/// `service resume` — send SIGUSR2, re-enable unit.
///
/// Reverses a prior `service drain` while the runner is still `Draining`.
/// If the runner has already transitioned to `Stopping` (teardown in
/// progress), is still `Running`, exited, or has unreadable status, resume is
/// refused. SIGUSR2 on an already-`Running` runner is a no-op on the runner
/// side, so the CLI must not restore Restart=on-failure until the runner has
/// actually entered `Draining`.
pub(super) async fn run_resume(args: ResumeArgs) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    let home = HomePaths::new()?;
    let _service_lock = acquire_service_lock(&unit, &home).await?;

    resume_with_ops(&unit, &home, &mut RealServiceResumeOps).await
}

runner_test_group!(cmd_service; #[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::path::{Path, PathBuf};

    use super::*;

    const TEST_RUNNER_STARTED_AT: &str = "2026-08-04T00:00:00Z";

    fn test_started_at() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(TEST_RUNNER_STARTED_AT)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    fn test_status_content(mode: &str, started_at: &str) -> String {
        format!(r#"{{"mode":"{mode}","active_runs":[],"started_at":"{started_at}"}}"#)
    }

    fn drain_status_content(mode: &str, started_at: &str) -> String {
        let updated_at = chrono::Utc::now().to_rfc3339();
        format!(
            r#"{{"mode":"{mode}","active_runs":[],"started_at":"{started_at}","updated_at":"{updated_at}"}}"#
        )
    }

    fn active_results(count: usize) -> VecDeque<RunnerResult<bool>> {
        (0..count).map(|_| Ok(true)).collect()
    }

    fn lifecycle_state(active_state: &str) -> RunnerResult<CleanupUnitActiveState> {
        let active_like = matches!(
            active_state,
            "active" | "activating" | "reloading" | "refreshing" | "deactivating"
        );
        Ok(CleanupUnitActiveState::for_test(active_state, active_like))
    }

    fn lifecycle_states(
        active_state: &str,
        count: usize,
    ) -> VecDeque<RunnerResult<CleanupUnitActiveState>> {
        (0..count).map(|_| lifecycle_state(active_state)).collect()
    }

    fn signal_results(
        outcome: ServiceSignalOutcome,
        count: usize,
    ) -> VecDeque<RunnerResult<ServiceSignalOutcome>> {
        (0..count).map(|_| Ok(outcome)).collect()
    }

    async fn write_test_status(base_dir: &Path, mode: &str, started_at: &str) {
        tokio::fs::create_dir_all(base_dir).await.unwrap();
        tokio::fs::write(
            base_dir.join("status.json"),
            test_status_content(mode, started_at),
        )
        .await
        .unwrap();
    }

    async fn write_drain_status(base_dir: &Path, mode: &str, started_at: &str) {
        tokio::fs::create_dir_all(base_dir).await.unwrap();
        tokio::fs::write(
            base_dir.join("status.json"),
            drain_status_content(mode, started_at),
        )
        .await
        .unwrap();
    }

    async fn publish_test_live_runner(
        home: &HomePaths,
        config_path: &Path,
        base_dir: &Path,
    ) -> crate::live_runner_instances::LiveRunnerInstanceHandle {
        crate::live_runner_instances::publish(
            home,
            crate::live_runner_instances::LiveRunnerInstanceMetadata {
                config_path: config_path.to_path_buf(),
                base_dir: base_dir.to_path_buf(),
                runner_group: "test".to_string(),
                subcommand: "start".to_string(),
            },
        )
        .await
        .unwrap()
    }

    async fn setup_drain_target(
        mode: &str,
    ) -> (
        tempfile::TempDir,
        HomePaths,
        PathBuf,
        PathBuf,
        crate::live_runner_instances::LiveRunnerInstanceHandle,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let config_path = dir.path().join("runner.yaml");
        let base_dir = home.runners_dir().join("runner-test");
        let handle = publish_test_live_runner(&home, &config_path, &base_dir).await;
        write_drain_status(&base_dir, mode, TEST_RUNNER_STARTED_AT).await;
        (dir, home, config_path, base_dir, handle)
    }

    async fn resume_after_preflight_for_test(ops: &mut FakeResumeOps) -> RunnerResult<()> {
        let dir = tempfile::tempdir().unwrap();
        write_test_status(dir.path(), "running", TEST_RUNNER_STARTED_AT).await;
        resume_after_preflight_with_ops(&service_unit(), dir.path(), test_started_at(), ops).await
    }

    fn service_unit() -> RunnerServiceUnit {
        RunnerServiceUnit::from_suffix("test").unwrap()
    }

    struct FakeDrainOps {
        events: Vec<&'static str>,
        lifecycle_state_results: VecDeque<RunnerResult<CleanupUnitActiveState>>,
        lifecycle_timeouts: Vec<Duration>,
        enablement_results: VecDeque<RunnerResult<SystemdUnitEnablement>>,
        write_error: bool,
        restart_override_write: DrainRestartOverrideWrite,
        remove_error: bool,
        reload_errors: VecDeque<bool>,
        reload_requirements: Vec<SystemdReloadRequirement>,
        restart_policy_results: VecDeque<RunnerResult<String>>,
        signal_results: VecDeque<RunnerResult<ServiceSignalOutcome>>,
        signal_timeouts: Vec<Duration>,
        config_path: Option<PathBuf>,
        config_path_pending: bool,
        status_update_on_signal: Option<(PathBuf, String)>,
        disable_error: bool,
        restore_enablement_error: bool,
    }

    struct FakeResumeOps {
        events: Vec<&'static str>,
        active_results: VecDeque<RunnerResult<bool>>,
        config_path: Option<PathBuf>,
        enablement_results: VecDeque<RunnerResult<SystemdUnitEnablement>>,
        write_error: bool,
        remove_error: bool,
        removed_restart_override: bool,
        reload_errors: VecDeque<bool>,
        reload_requirements: Vec<SystemdReloadRequirement>,
        signal_error: bool,
        signal_outcome: ServiceSignalOutcome,
        status_update_on_signal: Option<(PathBuf, String)>,
        enable_error: bool,
        restore_enablement_error: bool,
    }

    impl Default for FakeDrainOps {
        fn default() -> Self {
            Self {
                events: Vec::new(),
                lifecycle_state_results: lifecycle_states("active", 1),
                lifecycle_timeouts: Vec::new(),
                enablement_results: VecDeque::from([Ok(SystemdUnitEnablement::Enabled)]),
                write_error: false,
                restart_override_write: DrainRestartOverrideWrite::Created,
                remove_error: false,
                reload_errors: VecDeque::new(),
                reload_requirements: Vec::new(),
                restart_policy_results: VecDeque::from([Ok("no".to_string())]),
                signal_results: signal_results(ServiceSignalOutcome::Sent, 1),
                signal_timeouts: Vec::new(),
                config_path: Some(PathBuf::from("/tmp/runner-config.yaml")),
                config_path_pending: false,
                status_update_on_signal: None,
                disable_error: false,
                restore_enablement_error: false,
            }
        }
    }

    impl Default for FakeResumeOps {
        fn default() -> Self {
            Self {
                events: Vec::new(),
                active_results: active_results(1),
                config_path: Some(PathBuf::from("/tmp/runner-config.yaml")),
                enablement_results: VecDeque::from([Ok(SystemdUnitEnablement::NotEnabled)]),
                write_error: false,
                remove_error: false,
                removed_restart_override: true,
                reload_errors: VecDeque::new(),
                reload_requirements: Vec::new(),
                signal_error: false,
                signal_outcome: ServiceSignalOutcome::Sent,
                status_update_on_signal: None,
                enable_error: false,
                restore_enablement_error: false,
            }
        }
    }

    fn fake_error(message: &str) -> RunnerError {
        RunnerError::Internal(message.to_string())
    }

    impl ServiceDrainOps for FakeDrainOps {
        fn lifecycle_state<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
            timeout: Duration,
        ) -> ServiceFuture<'a, CleanupUnitActiveState> {
            self.events.push("lifecycle_state");
            self.lifecycle_timeouts.push(timeout);
            Box::pin(std::future::ready(
                self.lifecycle_state_results
                    .pop_front()
                    .expect("missing fake lifecycle state result"),
            ))
        }

        fn enablement<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, SystemdUnitEnablement> {
            self.events.push("is_enabled");
            Box::pin(std::future::ready(
                self.enablement_results
                    .pop_front()
                    .unwrap_or(Ok(SystemdUnitEnablement::NotEnabled)),
            ))
        }

        fn write_restart_override(
            &mut self,
            _unit: &RunnerServiceUnit,
        ) -> RunnerResult<DrainRestartOverrideWrite> {
            self.events.push("write_restart_override");
            if self.write_error {
                Err(fake_error("write failed"))
            } else {
                Ok(self.restart_override_write)
            }
        }

        fn remove_restart_override(&mut self, _unit: &RunnerServiceUnit) -> RunnerResult<bool> {
            self.events.push("remove_restart_override");
            if self.remove_error {
                Err(fake_error("remove failed"))
            } else {
                Ok(true)
            }
        }

        fn daemon_reload<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
            requirement: SystemdReloadRequirement,
        ) -> ServiceFuture<'a, ()> {
            self.events.push("daemon_reload");
            self.reload_requirements.push(requirement);
            let reload_error = self.reload_errors.pop_front().unwrap_or(false);
            Box::pin(std::future::ready(if reload_error {
                Err(fake_error("reload failed"))
            } else {
                Ok(())
            }))
        }

        fn restart_policy<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, String> {
            self.events.push("restart_policy");
            Box::pin(std::future::ready(
                self.restart_policy_results
                    .pop_front()
                    .expect("missing fake restart policy result"),
            ))
        }

        fn signal_drain<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, ServiceSignalOutcome> {
            self.events.push("signal_drain");
            let result = self
                .signal_results
                .pop_front()
                .expect("missing fake drain signal result");
            let sent = matches!(&result, Ok(ServiceSignalOutcome::Sent));
            let status_update = if sent {
                self.status_update_on_signal.take()
            } else {
                None
            };
            Box::pin(async move {
                if let Some((path, content)) = status_update {
                    tokio::fs::write(path, content).await.unwrap();
                }
                result
            })
        }

        fn signal_drain_bounded<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
            timeout: Duration,
        ) -> ServiceFuture<'a, ServiceSignalOutcome> {
            self.events.push("signal_drain_bounded");
            self.signal_timeouts.push(timeout);
            Box::pin(std::future::ready(
                self.signal_results
                    .pop_front()
                    .expect("missing fake bounded drain signal result"),
            ))
        }

        fn disable<'a>(&'a mut self, _unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
            self.events.push("disable");
            Box::pin(std::future::ready(if self.disable_error {
                Err(fake_error("disable failed"))
            } else {
                Ok(())
            }))
        }

        fn restore_enablement<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
            enablement: SystemdUnitEnablement,
        ) -> ServiceFuture<'a, ()> {
            self.events.push(match enablement {
                SystemdUnitEnablement::Enabled => "restore_enabled",
                SystemdUnitEnablement::EnabledRuntime => "restore_enabled_runtime",
                SystemdUnitEnablement::NotEnabled => "restore_not_enabled",
            });
            Box::pin(std::future::ready(if self.restore_enablement_error {
                Err(fake_error("restore enablement failed"))
            } else {
                Ok(())
            }))
        }

        fn read_unit_config_path<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, Option<PathBuf>> {
            self.events.push("read_config_path");
            if self.config_path_pending {
                Box::pin(std::future::pending())
            } else {
                Box::pin(std::future::ready(Ok(self.config_path.clone())))
            }
        }
    }

    impl ServiceResumeOps for FakeResumeOps {
        fn is_active<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
            _timeout: Duration,
        ) -> ServiceFuture<'a, bool> {
            self.events.push("is_active");
            Box::pin(std::future::ready(
                self.active_results.pop_front().unwrap_or(Ok(false)),
            ))
        }

        fn read_unit_config_path<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, Option<PathBuf>> {
            self.events.push("read_config_path");
            Box::pin(std::future::ready(Ok(self.config_path.clone())))
        }

        fn enablement<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, SystemdUnitEnablement> {
            self.events.push("is_enabled");
            Box::pin(std::future::ready(
                self.enablement_results
                    .pop_front()
                    .unwrap_or(Ok(SystemdUnitEnablement::NotEnabled)),
            ))
        }

        fn write_restart_override(&mut self, _unit: &RunnerServiceUnit) -> RunnerResult<()> {
            self.events.push("write_restart_override");
            if self.write_error {
                Err(fake_error("write failed"))
            } else {
                Ok(())
            }
        }

        fn remove_restart_override(&mut self, _unit: &RunnerServiceUnit) -> RunnerResult<bool> {
            self.events.push("remove_restart_override");
            if self.remove_error {
                Err(fake_error("remove failed"))
            } else {
                Ok(self.removed_restart_override)
            }
        }

        fn daemon_reload<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
            requirement: SystemdReloadRequirement,
        ) -> ServiceFuture<'a, ()> {
            self.events.push("daemon_reload");
            self.reload_requirements.push(requirement);
            let reload_error = self.reload_errors.pop_front().unwrap_or(false);
            Box::pin(std::future::ready(if reload_error {
                Err(fake_error("reload failed"))
            } else {
                Ok(())
            }))
        }

        fn signal_resume<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, ServiceSignalOutcome> {
            self.events.push("signal_resume");
            let sent = !self.signal_error && self.signal_outcome == ServiceSignalOutcome::Sent;
            let result = if self.signal_error {
                Err(fake_error("signal failed"))
            } else {
                Ok(self.signal_outcome)
            };
            let status_update = if sent {
                self.status_update_on_signal.take()
            } else {
                None
            };
            Box::pin(async move {
                if let Some((path, content)) = status_update {
                    tokio::fs::write(path, content).await.unwrap();
                }
                result
            })
        }

        fn enable<'a>(&'a mut self, _unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
            self.events.push("enable");
            Box::pin(std::future::ready(if self.enable_error {
                Err(fake_error("enable failed"))
            } else {
                Ok(())
            }))
        }

        fn restore_enablement<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
            enablement: SystemdUnitEnablement,
        ) -> ServiceFuture<'a, ()> {
            self.events.push(match enablement {
                SystemdUnitEnablement::Enabled => "restore_enabled",
                SystemdUnitEnablement::EnabledRuntime => "restore_enabled_runtime",
                SystemdUnitEnablement::NotEnabled => "restore_not_enabled",
            });
            Box::pin(std::future::ready(if self.restore_enablement_error {
                Err(fake_error("restore enablement failed"))
            } else {
                Ok(())
            }))
        }
    }

    #[tokio::test]
    async fn drain_active_service_disables_restart_before_signal() {
        let unit = service_unit();
        let mut ops = FakeDrainOps::default();

        drain_with_ops(&unit, &mut ops).await.unwrap();

        assert_eq!(
            ops.events,
            [
                "lifecycle_state",
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "signal_drain",
            ]
        );
        assert_eq!(
            ops.reload_requirements,
            [SystemdReloadRequirement::dirty().with_drain_override(true),]
        );
    }

    #[tokio::test]
    async fn drain_disable_failure_remains_successful_after_signal() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            disable_error: true,
            ..FakeDrainOps::default()
        };

        drain_with_ops(&unit, &mut ops).await.unwrap();

        assert_eq!(
            ops.events,
            [
                "lifecycle_state",
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "signal_drain",
            ]
        );
    }

    #[tokio::test]
    async fn drain_inactive_service_skips_restart_override_and_signal() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            lifecycle_state_results: VecDeque::from([lifecycle_state("inactive")]),
            ..FakeDrainOps::default()
        };

        drain_with_ops(&unit, &mut ops).await.unwrap();

        assert_eq!(
            ops.events,
            ["lifecycle_state", "is_enabled", "disable", "daemon_reload"]
        );
        assert_eq!(ops.reload_requirements, [SystemdReloadRequirement::dirty()]);
    }

    #[tokio::test]
    async fn drain_write_failure_aborts_before_signal() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            write_error: true,
            ..FakeDrainOps::default()
        };

        let err = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert!(err.to_string().contains("write failed"));
        assert_eq!(
            ops.events,
            ["lifecycle_state", "is_enabled", "write_restart_override"]
        );
    }

    #[tokio::test]
    async fn drain_daemon_reload_failure_rolls_back_before_signal() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            reload_errors: VecDeque::from([true, false]),
            ..FakeDrainOps::default()
        };

        let err = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert!(err.to_string().contains("reload failed"));
        assert_eq!(
            ops.events,
            [
                "lifecycle_state",
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "remove_restart_override",
                "restore_enabled",
                "daemon_reload",
            ]
        );
        assert_eq!(
            ops.reload_requirements,
            [
                SystemdReloadRequirement::dirty().with_drain_override(true),
                SystemdReloadRequirement::dirty().with_drain_override(false),
            ]
        );
    }

    #[tokio::test]
    async fn drain_reload_failure_reports_unavailable_prior_enablement() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            enablement_results: VecDeque::from([Err(fake_error("enablement read failed"))]),
            reload_errors: VecDeque::from([true, false]),
            ..FakeDrainOps::default()
        };

        let error = drain_with_ops(&unit, &mut ops).await.unwrap_err();
        let message = error.to_string();

        assert!(message.contains(
            "drain failed for vm0-runner-test: internal error: reload failed; additionally rollback failed"
        ));
        assert!(
            message.contains(
                "failed to roll back drain transition for vm0-runner-test (daemon_reload)"
            )
        );
        assert!(message.contains("prior boot enablement is unavailable"));
        assert_eq!(
            ops.events,
            [
                "lifecycle_state",
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "remove_restart_override",
                "daemon_reload",
            ]
        );
        assert!(
            ops.events
                .iter()
                .all(|event| !event.starts_with("restore_"))
        );
        assert_eq!(
            ops.reload_requirements,
            [
                SystemdReloadRequirement::dirty().with_drain_override(true),
                SystemdReloadRequirement::dirty().with_drain_override(false),
            ]
        );
    }

    #[tokio::test]
    async fn repeated_drain_reload_failure_preserves_restart_override() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            enablement_results: VecDeque::from([Ok(SystemdUnitEnablement::NotEnabled)]),
            restart_override_write: DrainRestartOverrideWrite::Replaced,
            reload_errors: VecDeque::from([true, false]),
            ..FakeDrainOps::default()
        };

        let error = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert!(error.to_string().contains("reload failed"));
        assert_eq!(
            ops.events,
            [
                "lifecycle_state",
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restore_not_enabled",
                "daemon_reload",
                "restart_policy",
            ]
        );
        assert_eq!(
            ops.reload_requirements,
            [
                SystemdReloadRequirement::dirty().with_drain_override(true),
                SystemdReloadRequirement::dirty().with_drain_override(true),
            ]
        );
    }

    #[tokio::test]
    async fn drain_failure_restores_runtime_only_enablement() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            enablement_results: VecDeque::from([Ok(SystemdUnitEnablement::EnabledRuntime)]),
            reload_errors: VecDeque::from([true, false]),
            ..FakeDrainOps::default()
        };

        let error = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert!(error.to_string().contains("reload failed"));
        assert!(ops.events.contains(&"restore_enabled_runtime"));
        assert!(!ops.events.contains(&"restore_enabled"));
    }

    #[tokio::test]
    async fn drain_restart_policy_mismatch_aborts_before_signal() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            restart_policy_results: VecDeque::from([Ok("on-failure".to_string())]),
            ..FakeDrainOps::default()
        };

        let err = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert!(err.to_string().contains("Restart=\"on-failure\""));
        assert_eq!(
            ops.events,
            [
                "lifecycle_state",
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "remove_restart_override",
                "restore_enabled",
                "daemon_reload",
            ]
        );
    }

    #[tokio::test]
    async fn repeated_drain_policy_mismatch_restores_effective_override() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            enablement_results: VecDeque::from([Ok(SystemdUnitEnablement::NotEnabled)]),
            restart_override_write: DrainRestartOverrideWrite::Replaced,
            restart_policy_results: VecDeque::from([
                Ok("on-failure".to_string()),
                Ok("no".to_string()),
            ]),
            ..FakeDrainOps::default()
        };

        let error = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert!(error.to_string().contains("Restart=\"on-failure\""));
        assert!(!error.to_string().contains("additionally rollback failed"));
        assert_eq!(
            ops.events,
            [
                "lifecycle_state",
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "restore_not_enabled",
                "daemon_reload",
                "restart_policy",
            ]
        );
        assert_eq!(
            ops.reload_requirements,
            [
                SystemdReloadRequirement::dirty().with_drain_override(true),
                SystemdReloadRequirement::dirty().with_drain_override(true),
            ]
        );
    }

    #[tokio::test]
    async fn repeated_drain_persistent_policy_mismatch_reports_rollback_failure() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            enablement_results: VecDeque::from([Ok(SystemdUnitEnablement::NotEnabled)]),
            restart_override_write: DrainRestartOverrideWrite::Replaced,
            restart_policy_results: VecDeque::from([
                Ok("on-failure".to_string()),
                Ok("on-failure".to_string()),
            ]),
            ..FakeDrainOps::default()
        };

        let error = drain_with_ops(&unit, &mut ops).await.unwrap_err();
        let message = error.to_string();

        assert!(message.contains("additionally rollback failed"));
        assert!(message.contains("verify restored drain restart policy"));
        assert!(!ops.events.contains(&"remove_restart_override"));
        assert_eq!(
            ops.reload_requirements,
            [
                SystemdReloadRequirement::dirty().with_drain_override(true),
                SystemdReloadRequirement::dirty().with_drain_override(true),
            ]
        );
    }

    #[tokio::test]
    async fn repeated_drain_policy_query_failure_restores_effective_override() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            lifecycle_state_results: lifecycle_states("active", 2),
            enablement_results: VecDeque::from([Ok(SystemdUnitEnablement::NotEnabled)]),
            restart_override_write: DrainRestartOverrideWrite::Replaced,
            restart_policy_results: VecDeque::from([
                Err(fake_error("restart policy failed")),
                Ok("no".to_string()),
            ]),
            ..FakeDrainOps::default()
        };

        let error = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert!(error.to_string().contains("restart policy failed"));
        assert!(!error.to_string().contains("additionally rollback failed"));
        assert_eq!(
            ops.events,
            [
                "lifecycle_state",
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "lifecycle_state",
                "restore_not_enabled",
                "daemon_reload",
                "restart_policy",
            ]
        );
        assert_eq!(
            ops.reload_requirements,
            [
                SystemdReloadRequirement::dirty().with_drain_override(true),
                SystemdReloadRequirement::dirty().with_drain_override(true),
            ]
        );
    }

    #[tokio::test]
    async fn drain_restart_policy_error_for_still_active_service_aborts_before_signal() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            lifecycle_state_results: lifecycle_states("active", 2),
            restart_policy_results: VecDeque::from([Err(fake_error("restart policy failed"))]),
            ..FakeDrainOps::default()
        };

        let err = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert!(err.to_string().contains("restart policy failed"));
        assert_eq!(
            ops.events,
            [
                "lifecycle_state",
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "lifecycle_state",
                "remove_restart_override",
                "restore_enabled",
                "daemon_reload",
            ]
        );
    }

    #[tokio::test]
    async fn drain_restart_policy_error_for_deactivating_service_aborts_before_signal() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            lifecycle_state_results: lifecycle_states("deactivating", 2),
            restart_policy_results: VecDeque::from([Err(fake_error("restart policy failed"))]),
            ..FakeDrainOps::default()
        };

        let error = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert!(error.to_string().contains("restart policy failed"));
        assert_eq!(
            ops.events,
            [
                "lifecycle_state",
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "lifecycle_state",
                "remove_restart_override",
                "restore_enabled",
                "daemon_reload",
            ]
        );
    }

    #[tokio::test]
    async fn drain_restart_policy_error_with_failed_active_recheck_rolls_back() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            lifecycle_state_results: VecDeque::from([
                lifecycle_state("active"),
                Err(fake_error("active recheck failed")),
            ]),
            restart_policy_results: VecDeque::from([Err(fake_error("restart policy failed"))]),
            ..FakeDrainOps::default()
        };

        let err = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert!(err.to_string().contains("active recheck failed"));
        assert_eq!(
            ops.events,
            [
                "lifecycle_state",
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "lifecycle_state",
                "remove_restart_override",
                "restore_enabled",
                "daemon_reload",
            ]
        );
    }

    #[tokio::test]
    async fn drain_restart_policy_error_for_exited_service_still_disables_unit() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            lifecycle_state_results: VecDeque::from([
                lifecycle_state("active"),
                lifecycle_state("inactive"),
            ]),
            restart_policy_results: VecDeque::from([Err(fake_error("restart policy failed"))]),
            ..FakeDrainOps::default()
        };

        drain_with_ops(&unit, &mut ops).await.unwrap();

        assert_eq!(
            ops.events,
            [
                "lifecycle_state",
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "lifecycle_state",
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn drain_signal_failure_converges_without_rollback() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            lifecycle_state_results: lifecycle_states("active", 2),
            signal_results: VecDeque::from([
                Err(fake_error("initial signal failed")),
                Ok(ServiceSignalOutcome::Sent),
            ]),
            ..FakeDrainOps::default()
        };

        drain_with_ops(&unit, &mut ops).await.unwrap();

        assert_eq!(
            ops.events,
            [
                "lifecycle_state",
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "signal_drain",
                "lifecycle_state",
                "signal_drain_bounded",
            ]
        );
        assert_eq!(ops.signal_timeouts, [DRAIN_SIGNAL_CONVERGENCE_TIMEOUT]);
        assert!(!ops.events.contains(&"remove_restart_override"));
        assert!(!ops.events.contains(&"restore_enabled"));
    }

    #[tokio::test]
    async fn drain_deactivating_service_applies_override_before_safe_completion() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            lifecycle_state_results: lifecycle_states("deactivating", 2),
            signal_results: signal_results(ServiceSignalOutcome::AlreadyGone, 1),
            ..FakeDrainOps::default()
        };

        drain_with_ops(&unit, &mut ops).await.unwrap();

        assert_eq!(
            ops.events,
            [
                "lifecycle_state",
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "signal_drain",
                "lifecycle_state",
            ]
        );
        assert!(!ops.events.contains(&"remove_restart_override"));
    }

    #[tokio::test]
    async fn drain_already_gone_inactive_service_still_disables_unit() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            lifecycle_state_results: VecDeque::from([
                lifecycle_state("active"),
                lifecycle_state("inactive"),
            ]),
            signal_results: signal_results(ServiceSignalOutcome::AlreadyGone, 1),
            ..FakeDrainOps::default()
        };

        drain_with_ops(&unit, &mut ops).await.unwrap();

        assert_eq!(
            ops.events,
            [
                "lifecycle_state",
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "signal_drain",
                "lifecycle_state",
            ]
        );
        assert!(!ops.events.contains(&"remove_restart_override"));
    }

    #[tokio::test(start_paused = true)]
    async fn drain_signals_replacement_after_deactivating_restart_race() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            lifecycle_state_results: VecDeque::from([
                lifecycle_state("deactivating"),
                lifecycle_state("activating"),
                lifecycle_state("active"),
            ]),
            signal_results: VecDeque::from([
                Ok(ServiceSignalOutcome::AlreadyGone),
                Ok(ServiceSignalOutcome::AlreadyGone),
                Ok(ServiceSignalOutcome::Sent),
            ]),
            ..FakeDrainOps::default()
        };
        let started_at = Instant::now();

        drain_with_ops(&unit, &mut ops).await.unwrap();

        assert_eq!(
            ops.events,
            [
                "lifecycle_state",
                "is_enabled",
                "write_restart_override",
                "disable",
                "daemon_reload",
                "restart_policy",
                "signal_drain",
                "lifecycle_state",
                "signal_drain_bounded",
                "lifecycle_state",
                "signal_drain_bounded",
            ]
        );
        assert_eq!(
            Instant::now() - started_at,
            DRAIN_SIGNAL_CONVERGENCE_POLL_INTERVAL
        );
        assert_eq!(
            ops.lifecycle_timeouts,
            [
                DRAIN_SIGNAL_CONVERGENCE_TIMEOUT,
                DRAIN_SIGNAL_CONVERGENCE_TIMEOUT,
                DRAIN_SIGNAL_CONVERGENCE_TIMEOUT - DRAIN_SIGNAL_CONVERGENCE_POLL_INTERVAL,
            ]
        );
        assert_eq!(
            ops.signal_timeouts,
            [
                DRAIN_SIGNAL_CONVERGENCE_TIMEOUT,
                DRAIN_SIGNAL_CONVERGENCE_TIMEOUT - DRAIN_SIGNAL_CONVERGENCE_POLL_INTERVAL,
            ]
        );
    }

    #[tokio::test]
    async fn drain_convergence_state_failure_retains_restart_override() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            lifecycle_state_results: VecDeque::from([
                lifecycle_state("active"),
                Err(fake_error("state recheck failed")),
            ]),
            signal_results: signal_results(ServiceSignalOutcome::AlreadyGone, 1),
            ..FakeDrainOps::default()
        };

        let error = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert!(error.to_string().contains("state recheck failed"));
        assert!(error.to_string().contains("Restart=no remains applied"));
        assert!(!ops.events.contains(&"remove_restart_override"));
        assert!(!ops.events.contains(&"restore_enabled"));
    }

    #[tokio::test]
    async fn drain_convergence_signal_failure_retains_restart_override() {
        let unit = service_unit();
        let mut ops = FakeDrainOps {
            lifecycle_state_results: VecDeque::from([
                lifecycle_state("active"),
                lifecycle_state("activating"),
            ]),
            signal_results: VecDeque::from([
                Ok(ServiceSignalOutcome::AlreadyGone),
                Err(fake_error("replacement signal failed")),
            ]),
            ..FakeDrainOps::default()
        };

        let error = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert!(error.to_string().contains("replacement signal failed"));
        assert!(error.to_string().contains("Restart=no remains applied"));
        assert!(!ops.events.contains(&"remove_restart_override"));
        assert!(!ops.events.contains(&"restore_enabled"));
    }

    #[tokio::test(start_paused = true)]
    async fn drain_convergence_timeout_is_bounded_and_retains_restart_override() {
        let unit = service_unit();
        let attempts = (DRAIN_SIGNAL_CONVERGENCE_TIMEOUT.as_millis()
            / DRAIN_SIGNAL_CONVERGENCE_POLL_INTERVAL.as_millis()) as usize
            + 1;
        let mut ops = FakeDrainOps {
            lifecycle_state_results: lifecycle_states("activating", attempts),
            signal_results: signal_results(ServiceSignalOutcome::AlreadyGone, attempts),
            ..FakeDrainOps::default()
        };
        let started_at = Instant::now();

        let error = drain_with_ops(&unit, &mut ops).await.unwrap_err();

        assert_eq!(
            Instant::now() - started_at,
            DRAIN_SIGNAL_CONVERGENCE_TIMEOUT
        );
        assert!(error.to_string().contains("timed out after 10s"));
        assert!(error.to_string().contains("Restart=no remains applied"));
        assert!(!ops.events.contains(&"remove_restart_override"));
        assert!(!ops.events.contains(&"restore_enabled"));
        assert_eq!(
            ops.reload_requirements,
            [SystemdReloadRequirement::dirty().with_drain_override(true)]
        );
    }

    #[tokio::test]
    async fn drain_waits_for_same_process_draining_acknowledgement() {
        let (_dir, home, config_path, base_dir, _handle) = setup_drain_target("running").await;
        let mut ops = FakeDrainOps {
            lifecycle_state_results: lifecycle_states("active", 2),
            config_path: Some(config_path),
            status_update_on_signal: Some((
                base_dir.join("status.json"),
                drain_status_content("draining", TEST_RUNNER_STARTED_AT),
            )),
            ..FakeDrainOps::default()
        };

        drain_and_wait_with_ops(&service_unit(), &home, &mut ops)
            .await
            .unwrap();

        assert_eq!(ops.events.first(), Some(&"read_config_path"));
        assert!(ops.events.contains(&"signal_drain"));
        assert_eq!(ops.events.last(), Some(&"lifecycle_state"));
    }

    #[tokio::test(start_paused = true)]
    async fn drain_waits_for_delayed_acknowledgement() {
        let (_dir, home, config_path, base_dir, _handle) = setup_drain_target("running").await;
        let status_path = base_dir.join("status.json");
        let update = tokio::spawn(async move {
            tokio::time::sleep(DRAIN_ACKNOWLEDGEMENT_POLL_INTERVAL * 2).await;
            tokio::fs::write(
                status_path,
                drain_status_content("draining", TEST_RUNNER_STARTED_AT),
            )
            .await
            .unwrap();
        });
        let mut ops = FakeDrainOps {
            lifecycle_state_results: lifecycle_states("active", 10),
            config_path: Some(config_path),
            ..FakeDrainOps::default()
        };

        drain_and_wait_with_ops(&service_unit(), &home, &mut ops)
            .await
            .unwrap();
        update.await.unwrap();

        assert!(
            ops.events
                .iter()
                .filter(|event| **event == "lifecycle_state")
                .count()
                >= 3
        );
    }

    #[tokio::test]
    async fn drain_accepts_stopping_with_active_runs() {
        let (_dir, home, config_path, base_dir, _handle) = setup_drain_target("running").await;
        let updated_at = chrono::Utc::now().to_rfc3339();
        let stopping = format!(
            r#"{{"mode":"stopping","active_runs":[{{"run_id":"00000000-0000-0000-0000-000000000001"}}],"started_at":"{TEST_RUNNER_STARTED_AT}","updated_at":"{updated_at}"}}"#
        );
        let mut ops = FakeDrainOps {
            lifecycle_state_results: lifecycle_states("active", 2),
            config_path: Some(config_path),
            status_update_on_signal: Some((base_dir.join("status.json"), stopping)),
            ..FakeDrainOps::default()
        };

        drain_and_wait_with_ops(&service_unit(), &home, &mut ops)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn drain_accepts_service_exit_after_signal() {
        let (_dir, home, config_path, _base_dir, _handle) = setup_drain_target("running").await;
        let mut ops = FakeDrainOps {
            lifecycle_state_results: VecDeque::from([
                lifecycle_state("active"),
                lifecycle_state("inactive"),
            ]),
            config_path: Some(config_path),
            ..FakeDrainOps::default()
        };

        drain_and_wait_with_ops(&service_unit(), &home, &mut ops)
            .await
            .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn drain_stale_running_status_times_out_with_observation() {
        let (_dir, home, config_path, _base_dir, _handle) = setup_drain_target("running").await;
        let attempts = (DRAIN_ACKNOWLEDGEMENT_TIMEOUT.as_millis()
            / DRAIN_ACKNOWLEDGEMENT_POLL_INTERVAL.as_millis()) as usize
            + 2;
        let mut ops = FakeDrainOps {
            lifecycle_state_results: lifecycle_states("active", attempts),
            config_path: Some(config_path),
            ..FakeDrainOps::default()
        };
        let started_at = Instant::now();

        let error = drain_and_wait_with_ops(&service_unit(), &home, &mut ops)
            .await
            .unwrap_err();
        let message = error.to_string();

        assert_eq!(Instant::now() - started_at, DRAIN_ACKNOWLEDGEMENT_TIMEOUT);
        assert!(message.contains("waiting for vm0-runner-test to acknowledge drain"));
        assert!(message.contains("mode=\"running\""));
        assert!(message.contains("Restart=no remains applied"));
    }

    #[tokio::test(start_paused = true)]
    async fn drain_unreadable_status_times_out_with_read_error() {
        let (_dir, home, config_path, base_dir, _handle) = setup_drain_target("running").await;
        let attempts = (DRAIN_ACKNOWLEDGEMENT_TIMEOUT.as_millis()
            / DRAIN_ACKNOWLEDGEMENT_POLL_INTERVAL.as_millis()) as usize
            + 2;
        let mut ops = FakeDrainOps {
            lifecycle_state_results: lifecycle_states("active", attempts),
            config_path: Some(config_path),
            status_update_on_signal: Some((base_dir.join("status.json"), "not json".to_string())),
            ..FakeDrainOps::default()
        };

        let error = drain_and_wait_with_ops(&service_unit(), &home, &mut ops)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("cannot read status.json"));
        assert!(error.to_string().contains("Restart=no remains applied"));
    }

    #[tokio::test]
    async fn drain_rejects_replaced_status_generation() {
        let (_dir, home, config_path, base_dir, _handle) = setup_drain_target("running").await;
        let mut ops = FakeDrainOps {
            lifecycle_state_results: lifecycle_states("active", 2),
            config_path: Some(config_path),
            status_update_on_signal: Some((
                base_dir.join("status.json"),
                drain_status_content("draining", "2026-08-05T00:00:00Z"),
            )),
            ..FakeDrainOps::default()
        };

        let error = drain_and_wait_with_ops(&service_unit(), &home, &mut ops)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("status generation changed"));
        assert!(error.to_string().contains("Restart=no remains applied"));
    }

    #[tokio::test(start_paused = true)]
    async fn drain_rejects_status_from_noncurrent_process_identity() {
        let (_dir, home, config_path, _base_dir, handle) = setup_drain_target("running").await;
        let mut ops = FakeDrainOps {
            config_path: Some(config_path),
            lifecycle_state_results: lifecycle_states("active", 100),
            ..FakeDrainOps::default()
        };
        let target = capture_drain_acknowledgement_target(&service_unit(), &home, &mut ops)
            .await
            .unwrap();
        assert!(handle.remove_if_current().await.unwrap());

        let error = wait_for_drain_acknowledgement(&service_unit(), &home, Ok(target), &mut ops)
            .await
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("process identity is no longer current")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn drain_stale_preflight_status_does_not_skip_signal_safeguards() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let config_path = dir.path().join("runner.yaml");
        let base_dir = home.runners_dir().join("runner-test");
        let _handle = publish_test_live_runner(&home, &config_path, &base_dir).await;
        tokio::fs::create_dir_all(&base_dir).await.unwrap();
        tokio::fs::write(
            base_dir.join("status.json"),
            format!(
                r#"{{"mode":"running","active_runs":[],"started_at":"{TEST_RUNNER_STARTED_AT}","updated_at":"2026-01-01T00:00:00Z"}}"#
            ),
        )
        .await
        .unwrap();
        let attempts = (DRAIN_ACKNOWLEDGEMENT_TIMEOUT.as_millis()
            / DRAIN_ACKNOWLEDGEMENT_POLL_INTERVAL.as_millis()) as usize
            + 2;
        let mut ops = FakeDrainOps {
            lifecycle_state_results: lifecycle_states("active", attempts),
            config_path: Some(config_path),
            ..FakeDrainOps::default()
        };

        let error = drain_and_wait_with_ops(&service_unit(), &home, &mut ops)
            .await
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("predates the selected live process")
        );
        assert!(ops.events.contains(&"write_restart_override"));
        assert!(ops.events.contains(&"restart_policy"));
        assert!(ops.events.contains(&"signal_drain"));
        assert!(!ops.events.contains(&"remove_restart_override"));
    }

    #[tokio::test(start_paused = true)]
    async fn drain_preflight_timeout_does_not_skip_signal_safeguards() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let attempts = (DRAIN_ACKNOWLEDGEMENT_TIMEOUT.as_millis()
            / DRAIN_ACKNOWLEDGEMENT_POLL_INTERVAL.as_millis()) as usize
            + 2;
        let mut ops = FakeDrainOps {
            lifecycle_state_results: lifecycle_states("active", attempts),
            config_path_pending: true,
            ..FakeDrainOps::default()
        };
        let started_at = Instant::now();

        let error = drain_and_wait_with_ops(&service_unit(), &home, &mut ops)
            .await
            .unwrap_err();

        assert_eq!(
            Instant::now() - started_at,
            DRAIN_ACKNOWLEDGEMENT_TIMEOUT * 2
        );
        assert!(
            error
                .to_string()
                .contains("resolving the acknowledgement target")
        );
        assert!(ops.events.contains(&"write_restart_override"));
        assert!(ops.events.contains(&"restart_policy"));
        assert!(ops.events.contains(&"signal_drain"));
        assert!(!ops.events.contains(&"remove_restart_override"));
    }

    #[tokio::test]
    async fn resume_refuses_inactive_unit_before_status_read() {
        let unit = service_unit();
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let mut ops = FakeResumeOps {
            active_results: VecDeque::from([Ok(false)]),
            ..FakeResumeOps::default()
        };

        let error = resume_with_ops(&unit, &home, &mut ops).await.unwrap_err();

        assert!(
            error
                .to_string()
                .contains("cannot resume an inactive runner")
        );
        assert_eq!(ops.events, ["is_active"]);
    }

    #[tokio::test]
    async fn resume_refuses_unresolved_selected_config_before_mutation() {
        let unit = service_unit();
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let mut no_config_ops = FakeResumeOps {
            config_path: None,
            ..FakeResumeOps::default()
        };

        let no_config_error = resume_with_ops(&unit, &home, &mut no_config_ops)
            .await
            .unwrap_err();

        assert!(
            no_config_error
                .to_string()
                .contains("does not select a runner --config path")
        );
        assert_eq!(no_config_ops.events, ["is_active", "read_config_path"]);

        let config_path = dir.path().join("selected-config.yaml");
        let mut no_record_ops = FakeResumeOps {
            config_path: Some(config_path),
            ..FakeResumeOps::default()
        };

        let no_record_error = resume_with_ops(&unit, &home, &mut no_record_ops)
            .await
            .unwrap_err();

        assert!(
            no_record_error
                .to_string()
                .contains("cannot resolve a live runner instance")
        );
        assert_eq!(no_record_ops.events, ["is_active", "read_config_path"]);
    }

    #[tokio::test]
    async fn resume_refuses_missing_status_before_mutation() {
        let unit = service_unit();
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let config_path = dir.path().join("selected-config.yaml");
        let base_dir = home.runners_dir().join("runner-release");
        let _live_instance = publish_test_live_runner(&home, &config_path, &base_dir).await;
        let mut ops = FakeResumeOps {
            config_path: Some(config_path),
            ..FakeResumeOps::default()
        };

        let error = resume_with_ops(&unit, &home, &mut ops).await.unwrap_err();

        assert!(error.to_string().contains("cannot read status.json"));
        assert_eq!(ops.events, ["is_active", "read_config_path"]);
    }

    #[tokio::test]
    async fn resume_refuses_malformed_status_before_mutation() {
        let unit = service_unit();
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let config_path = dir.path().join("selected-config.yaml");
        let base_dir = home.runners_dir().join("runner-release");
        let _live_instance = publish_test_live_runner(&home, &config_path, &base_dir).await;
        tokio::fs::create_dir_all(&base_dir).await.unwrap();
        tokio::fs::write(base_dir.join("status.json"), "{")
            .await
            .unwrap();
        let mut ops = FakeResumeOps {
            config_path: Some(config_path),
            ..FakeResumeOps::default()
        };

        let error = resume_with_ops(&unit, &home, &mut ops).await.unwrap_err();

        assert!(error.to_string().contains("cannot read status.json"));
        assert_eq!(ops.events, ["is_active", "read_config_path"]);
    }

    #[tokio::test]
    async fn resume_refuses_non_draining_status_before_mutation() {
        let unit = service_unit();
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let config_path = dir.path().join("selected-config.yaml");
        let base_dir = home.runners_dir().join("runner-release");
        let _live_instance = publish_test_live_runner(&home, &config_path, &base_dir).await;
        tokio::fs::create_dir_all(&base_dir).await.unwrap();
        tokio::fs::write(
            base_dir.join("status.json"),
            r#"{"mode":"running","active_runs":[],"started_at":"2026-08-04T00:00:00Z"}"#,
        )
        .await
        .unwrap();
        let mut ops = FakeResumeOps {
            config_path: Some(config_path),
            ..FakeResumeOps::default()
        };

        let error = resume_with_ops(&unit, &home, &mut ops).await.unwrap_err();

        assert!(error.to_string().contains("running, not draining"));
        assert_eq!(ops.events, ["is_active", "read_config_path"]);
    }

    #[tokio::test]
    async fn resume_uses_selected_config_base_dir_for_transition() {
        let unit = service_unit();
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let config_path = dir.path().join("selected-config.yaml");
        let base_dir = home.runners_dir().join("runner-release");
        let _live_instance = publish_test_live_runner(&home, &config_path, &base_dir).await;
        tokio::fs::create_dir_all(&base_dir).await.unwrap();
        tokio::fs::write(
            base_dir.join("status.json"),
            r#"{"mode":"draining","active_runs":[],"started_at":"2026-08-04T00:00:00Z"}"#,
        )
        .await
        .unwrap();
        let mut ops = FakeResumeOps {
            active_results: active_results(2),
            config_path: Some(config_path),
            status_update_on_signal: Some((
                base_dir.join("status.json"),
                test_status_content("running", TEST_RUNNER_STARTED_AT),
            )),
            ..FakeResumeOps::default()
        };

        resume_with_ops(&unit, &home, &mut ops).await.unwrap();

        assert_eq!(
            ops.events,
            [
                "is_active",
                "read_config_path",
                "is_enabled",
                "remove_restart_override",
                "enable",
                "daemon_reload",
                "signal_resume",
                "is_active",
            ]
        );
    }

    #[tokio::test]
    async fn resume_enables_and_reloads_before_signal() {
        let mut ops = FakeResumeOps::default();

        resume_after_preflight_for_test(&mut ops).await.unwrap();

        assert_eq!(
            ops.events,
            [
                "is_enabled",
                "remove_restart_override",
                "enable",
                "daemon_reload",
                "signal_resume",
                "is_active",
            ]
        );
    }

    #[tokio::test]
    async fn resume_enable_failure_remains_successful_after_reload_and_signal() {
        let mut ops = FakeResumeOps {
            enable_error: true,
            ..FakeResumeOps::default()
        };

        resume_after_preflight_for_test(&mut ops).await.unwrap();

        assert_eq!(
            ops.events,
            [
                "is_enabled",
                "remove_restart_override",
                "enable",
                "daemon_reload",
                "signal_resume",
                "is_active",
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn resume_waits_for_delayed_running_acknowledgement() {
        let unit = service_unit();
        let dir = tempfile::tempdir().unwrap();
        write_test_status(dir.path(), "draining", TEST_RUNNER_STARTED_AT).await;
        let status_dir = dir.path().to_path_buf();
        let update_task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(125)).await;
            write_test_status(&status_dir, "running", TEST_RUNNER_STARTED_AT).await;
        });
        let mut ops = FakeResumeOps {
            active_results: active_results(2),
            ..FakeResumeOps::default()
        };

        resume_after_preflight_with_ops(&unit, dir.path(), test_started_at(), &mut ops)
            .await
            .unwrap();
        update_task.await.unwrap();

        assert_eq!(ops.events.first(), Some(&"is_enabled"));
        assert_eq!(
            ops.events
                .iter()
                .filter(|event| **event == "is_active")
                .count(),
            2
        );
        assert!(!ops.events.contains(&"write_restart_override"));
        assert!(!ops.events.contains(&"restore_not_enabled"));
    }

    #[tokio::test]
    async fn resume_stopping_after_draining_preflight_rolls_back_transition() {
        let unit = service_unit();
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let config_path = dir.path().join("selected-config.yaml");
        let base_dir = home.runners_dir().join("runner-release");
        let _live_instance = publish_test_live_runner(&home, &config_path, &base_dir).await;
        write_test_status(&base_dir, "draining", TEST_RUNNER_STARTED_AT).await;
        let mut ops = FakeResumeOps {
            active_results: active_results(2),
            config_path: Some(config_path),
            status_update_on_signal: Some((
                base_dir.join("status.json"),
                test_status_content("stopping", TEST_RUNNER_STARTED_AT),
            )),
            ..FakeResumeOps::default()
        };

        let error = resume_with_ops(&unit, &home, &mut ops).await.unwrap_err();

        assert!(error.to_string().contains("entered mode=stopping"));
        assert_eq!(
            ops.events,
            [
                "is_active",
                "read_config_path",
                "is_enabled",
                "remove_restart_override",
                "enable",
                "daemon_reload",
                "signal_resume",
                "is_active",
                "write_restart_override",
                "restore_not_enabled",
                "daemon_reload",
            ]
        );
    }

    #[tokio::test]
    async fn resume_stopped_acknowledgement_rolls_back_transition() {
        let unit = service_unit();
        let dir = tempfile::tempdir().unwrap();
        write_test_status(dir.path(), "stopped", TEST_RUNNER_STARTED_AT).await;
        let mut ops = FakeResumeOps::default();

        let error = resume_after_preflight_with_ops(&unit, dir.path(), test_started_at(), &mut ops)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("entered mode=stopped"));
        assert!(ops.events.contains(&"write_restart_override"));
        assert!(ops.events.contains(&"restore_not_enabled"));
    }

    #[tokio::test]
    async fn resume_target_exit_before_acknowledgement_rolls_back_transition() {
        let unit = service_unit();
        let dir = tempfile::tempdir().unwrap();
        write_test_status(dir.path(), "draining", TEST_RUNNER_STARTED_AT).await;
        let mut ops = FakeResumeOps {
            active_results: VecDeque::from([Ok(false)]),
            ..FakeResumeOps::default()
        };

        let error = resume_after_preflight_with_ops(&unit, dir.path(), test_started_at(), &mut ops)
            .await
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("exited before acknowledging resume")
        );
        assert!(ops.events.contains(&"write_restart_override"));
        assert!(ops.events.contains(&"restore_not_enabled"));
    }

    #[tokio::test]
    async fn resume_replacement_before_acknowledgement_rolls_back_transition() {
        let unit = service_unit();
        let dir = tempfile::tempdir().unwrap();
        write_test_status(dir.path(), "running", "2026-08-04T00:00:01Z").await;
        let mut ops = FakeResumeOps::default();

        let error = resume_after_preflight_with_ops(&unit, dir.path(), test_started_at(), &mut ops)
            .await
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("was replaced before acknowledging resume")
        );
        assert!(ops.events.contains(&"write_restart_override"));
        assert!(ops.events.contains(&"restore_not_enabled"));
    }

    #[tokio::test]
    async fn resume_unreadable_acknowledgement_rolls_back_transition() {
        let unit = service_unit();
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("status.json"), "{")
            .await
            .unwrap();
        let mut ops = FakeResumeOps::default();

        let error = resume_after_preflight_with_ops(&unit, dir.path(), test_started_at(), &mut ops)
            .await
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("while waiting for resume acknowledgement")
        );
        assert!(ops.events.contains(&"write_restart_override"));
        assert!(ops.events.contains(&"restore_not_enabled"));
    }

    #[tokio::test]
    async fn resume_unknown_acknowledgement_mode_rolls_back_transition() {
        let unit = service_unit();
        let dir = tempfile::tempdir().unwrap();
        write_test_status(dir.path(), "paused", TEST_RUNNER_STARTED_AT).await;
        let mut ops = FakeResumeOps::default();

        let error = resume_after_preflight_with_ops(&unit, dir.path(), test_started_at(), &mut ops)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("invalid mode \"paused\""));
        assert!(ops.events.contains(&"write_restart_override"));
        assert!(ops.events.contains(&"restore_not_enabled"));
    }

    #[tokio::test(start_paused = true)]
    async fn resume_draining_acknowledgement_times_out_and_rolls_back_transition() {
        let unit = service_unit();
        let dir = tempfile::tempdir().unwrap();
        write_test_status(dir.path(), "draining", TEST_RUNNER_STARTED_AT).await;
        let mut ops = FakeResumeOps {
            active_results: active_results(40),
            ..FakeResumeOps::default()
        };

        let error = resume_after_preflight_with_ops(&unit, dir.path(), test_started_at(), &mut ops)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("timed out after 10s"));
        assert_eq!(
            &ops.events[ops.events.len() - 3..],
            [
                "write_restart_override",
                "restore_not_enabled",
                "daemon_reload"
            ]
        );
    }

    #[tokio::test]
    async fn resume_reload_failure_restores_override_and_enablement() {
        let mut ops = FakeResumeOps {
            reload_errors: VecDeque::from([true, false]),
            ..FakeResumeOps::default()
        };

        let error = resume_after_preflight_for_test(&mut ops).await.unwrap_err();

        assert!(error.to_string().contains("reload failed"));
        assert_eq!(
            ops.events,
            [
                "is_enabled",
                "remove_restart_override",
                "enable",
                "daemon_reload",
                "write_restart_override",
                "restore_not_enabled",
                "daemon_reload",
            ]
        );
    }

    #[tokio::test]
    async fn resume_reload_failure_reports_unavailable_prior_enablement() {
        let mut ops = FakeResumeOps {
            enablement_results: VecDeque::from([Err(fake_error("enablement read failed"))]),
            reload_errors: VecDeque::from([true, false]),
            ..FakeResumeOps::default()
        };

        let error = resume_after_preflight_for_test(&mut ops).await.unwrap_err();
        let message = error.to_string();

        assert!(message.contains(
            "resume failed for vm0-runner-test: internal error: reload failed; additionally rollback failed"
        ));
        assert!(
            message.contains(
                "failed to roll back resume transition for vm0-runner-test (daemon_reload)"
            )
        );
        assert!(message.contains("prior boot enablement is unavailable"));
        assert_eq!(
            ops.events,
            [
                "is_enabled",
                "remove_restart_override",
                "enable",
                "daemon_reload",
                "write_restart_override",
                "daemon_reload",
            ]
        );
        assert!(
            ops.events
                .iter()
                .all(|event| !event.starts_with("restore_"))
        );
        assert_eq!(
            ops.reload_requirements,
            [
                SystemdReloadRequirement::dirty().with_drain_override(false),
                SystemdReloadRequirement::dirty().with_drain_override(true),
            ]
        );
    }

    #[tokio::test]
    async fn resume_signal_failure_restores_override_and_enablement() {
        let mut ops = FakeResumeOps {
            signal_error: true,
            ..FakeResumeOps::default()
        };

        let error = resume_after_preflight_for_test(&mut ops).await.unwrap_err();

        assert!(error.to_string().contains("signal failed"));
        assert_eq!(
            ops.events,
            [
                "is_enabled",
                "remove_restart_override",
                "enable",
                "daemon_reload",
                "signal_resume",
                "write_restart_override",
                "restore_not_enabled",
                "daemon_reload",
            ]
        );
    }

    #[tokio::test]
    async fn resume_signal_failure_reports_rollback_failures() {
        let mut ops = FakeResumeOps {
            write_error: true,
            restore_enablement_error: true,
            reload_errors: VecDeque::from([false, true]),
            signal_error: true,
            ..FakeResumeOps::default()
        };

        let error = resume_after_preflight_for_test(&mut ops).await.unwrap_err();
        let message = error.to_string();

        assert!(message.contains("signal failed"));
        assert!(message.contains("additionally rollback failed"));
        assert!(message.contains("write failed"));
        assert!(message.contains("restore enablement failed"));
        assert!(message.contains("reload failed"));
    }

    #[tokio::test]
    async fn resume_already_gone_restores_transition() {
        let mut ops = FakeResumeOps {
            signal_outcome: ServiceSignalOutcome::AlreadyGone,
            ..FakeResumeOps::default()
        };

        let error = resume_after_preflight_for_test(&mut ops).await.unwrap_err();

        assert!(
            error
                .to_string()
                .contains("cannot resume an inactive runner")
        );
        assert_eq!(
            ops.events,
            [
                "is_enabled",
                "remove_restart_override",
                "enable",
                "daemon_reload",
                "signal_resume",
                "write_restart_override",
                "restore_not_enabled",
                "daemon_reload",
            ]
        );
    }

    #[tokio::test]
    async fn resume_failure_without_override_restores_only_enablement() {
        let mut ops = FakeResumeOps {
            removed_restart_override: false,
            signal_error: true,
            ..FakeResumeOps::default()
        };

        let error = resume_after_preflight_for_test(&mut ops).await.unwrap_err();

        assert!(error.to_string().contains("signal failed"));
        assert_eq!(
            ops.events,
            [
                "is_enabled",
                "remove_restart_override",
                "enable",
                "daemon_reload",
                "signal_resume",
                "restore_not_enabled",
                "daemon_reload",
            ]
        );
        assert_eq!(
            ops.reload_requirements,
            [
                SystemdReloadRequirement::dirty().with_drain_override(false),
                SystemdReloadRequirement::dirty(),
            ]
        );
    }

    #[test]
    fn resume_preflight_allows_only_draining_mode() {
        let unit = service_unit();

        ensure_resume_mode_is_draining(&unit, "draining").unwrap();

        let running = ensure_resume_mode_is_draining(&unit, "running").unwrap_err();
        assert!(running.to_string().contains("running, not draining"));

        let starting = ensure_resume_mode_is_draining(&unit, "starting").unwrap_err();
        assert!(starting.to_string().contains("starting, not draining"));

        let stopping = ensure_resume_mode_is_draining(&unit, "stopping").unwrap_err();
        assert!(stopping.to_string().contains("already shutting down"));

        let stopped = ensure_resume_mode_is_draining(&unit, "stopped").unwrap_err();
        assert!(stopped.to_string().contains("already shutting down"));

        let unknown = ensure_resume_mode_is_draining(&unit, "paused").unwrap_err();
        assert!(unknown.to_string().contains("unknown mode"));
    }
});
