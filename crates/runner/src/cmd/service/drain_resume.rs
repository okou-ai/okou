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
//! recreates it first. Directory-only cleanup does not own file restoration.
//! This applies even after SIGUSR2 was sent; any rollback failure is added to
//! the transition error.
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
use crate::status_file;
use runner_host::paths::HomePaths;

use super::drain_override::{
    DrainRestartOverrideRemoval, DrainRestartOverrideWrite, remove_drain_restart_override,
    remove_drain_restart_override_outcome, write_drain_restart_override,
};
use super::gate::read_runner_status;
use super::reload::{SystemdReloadPolicy, SystemdReloadRequirement, coordinate_systemd_reload};
use super::signal::{ServiceSignalOutcome, signal_service_main, signal_service_main_bounded};
use super::{
    RunnerServiceUnit, ServiceFuture, acquire_service_lock, read_unit_config_path,
    selected_config_base_dir, selected_config_live_instance,
};
use runner_host::service::{
    CleanupUnitActiveState, SystemdUnitEnablement, cleanup_unit_active_state_bounded,
    get_service_restart_policy, is_unit_active_bounded, read_unit_enablement,
    restore_unit_enablement, run_systemctl,
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
    fn remove_restart_override(
        &mut self,
        unit: &RunnerServiceUnit,
    ) -> RunnerResult<DrainRestartOverrideRemoval>;
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
        Box::pin(async move {
            cleanup_unit_active_state_bounded(unit, timeout)
                .await
                .map_err(Into::into)
        })
    }

    fn enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, SystemdUnitEnablement> {
        Box::pin(async move { read_unit_enablement(unit).await.map_err(Into::into) })
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
            coordinate_systemd_reload(unit, requirement, SystemdReloadPolicy::Unbounded)
                .await
                .map(|_| ())
        })
    }

    fn restart_policy<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, String> {
        Box::pin(async move { get_service_restart_policy(unit).await.map_err(Into::into) })
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
        Box::pin(async move {
            run_systemctl(&["disable", "--no-reload", unit.service_name()])
                .await
                .map_err(Into::into)
        })
    }

    fn restore_enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        enablement: SystemdUnitEnablement,
    ) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            restore_unit_enablement(unit, enablement)
                .await
                .map_err(Into::into)
        })
    }

    fn read_unit_config_path<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, Option<std::path::PathBuf>> {
        Box::pin(async move { read_unit_config_path(unit).await.map_err(Into::into) })
    }
}

impl ServiceResumeOps for RealServiceResumeOps {
    fn is_active<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        timeout: Duration,
    ) -> ServiceFuture<'a, bool> {
        Box::pin(async move {
            is_unit_active_bounded(unit, timeout)
                .await
                .map_err(Into::into)
        })
    }

    fn read_unit_config_path<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, Option<std::path::PathBuf>> {
        Box::pin(async move { read_unit_config_path(unit).await.map_err(Into::into) })
    }

    fn enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, SystemdUnitEnablement> {
        Box::pin(async move { read_unit_enablement(unit).await.map_err(Into::into) })
    }

    fn write_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<()> {
        write_drain_restart_override(unit).map(|_| ())
    }

    fn remove_restart_override(
        &mut self,
        unit: &RunnerServiceUnit,
    ) -> RunnerResult<DrainRestartOverrideRemoval> {
        remove_drain_restart_override_outcome(unit)
    }

    fn daemon_reload<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        requirement: SystemdReloadRequirement,
    ) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            coordinate_systemd_reload(unit, requirement, SystemdReloadPolicy::Unbounded)
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
        Box::pin(async move {
            run_systemctl(&["enable", "--no-reload", unit.service_name()])
                .await
                .map_err(Into::into)
        })
    }

    fn restore_enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        enablement: SystemdUnitEnablement,
    ) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            restore_unit_enablement(unit, enablement)
                .await
                .map_err(Into::into)
        })
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
    drain_override_removal: DrainRestartOverrideRemoval,
    prior_enablement: Option<SystemdUnitEnablement>,
    ops: &mut impl ServiceResumeOps,
    context: &str,
) -> RunnerResult<()> {
    let mut failures = Vec::new();

    if drain_override_removal.override_removed()
        && let Err(error) = ops.write_restart_override(unit)
    {
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

    let reload_requirement = if drain_override_removal.override_removed() {
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
    drain_override_removal: DrainRestartOverrideRemoval,
    prior_enablement: Option<SystemdUnitEnablement>,
    ops: &mut impl ServiceResumeOps,
    context: &str,
    error: RunnerError,
) -> RunnerError {
    match rollback_resume_transition(unit, drain_override_removal, prior_enablement, ops, context)
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
    let drain_override_removal = ops.remove_restart_override(unit)?;

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
            drain_override_removal,
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
        drain_override_removal,
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

#[cfg(test)]
mod tests;
