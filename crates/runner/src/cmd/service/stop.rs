use clap::{Args, ValueEnum};
use tokio::time::{Duration as TokioDuration, Instant as TokioInstant};
use tracing::{info, warn};

use crate::error::{RunnerError, RunnerResult};
use runner_host::paths::HomePaths;

use super::drain_override_cleanup::reconcile_drain_restart_override_removal;
use super::gate::{ActiveJobsGateOps, check_active_jobs_gate};
use super::reload::SystemdReloadPolicy;
use super::{RunnerServiceUnit, ServiceFuture, acquire_service_lock, read_unit_config_path};
use runner_host::service::{
    BoundedSystemctlOutcome, CleanupUnitActiveState, cleanup_unit_active_state_bounded,
    is_unit_active, is_unit_enabled_bounded, run_systemctl, run_systemctl_bounded,
};

const CLEANUP_LOCK_TIMEOUT: TokioDuration = TokioDuration::from_secs(20);
const CLEANUP_LOCK_POLL_INTERVAL: TokioDuration = TokioDuration::from_millis(250);
const CLEANUP_STOP_TIMEOUT: TokioDuration = TokioDuration::from_secs(20);
const CLEANUP_ACTION_TIMEOUT: TokioDuration = TokioDuration::from_secs(10);
const CLEANUP_VERIFY_TIMEOUT: TokioDuration = TokioDuration::from_secs(10);
const CLEANUP_VERIFY_INTERVAL: TokioDuration = TokioDuration::from_secs(1);

#[derive(Args)]
pub(super) struct StopArgs {
    /// Service name suffix (e.g. v0.2.0 -> unit vm0-runner-v0.2.0)
    #[arg(long)]
    name: String,
    /// Skip active-jobs pre-check and force stop (active jobs will be killed).
    #[arg(long)]
    force: bool,
    /// Use bounded cleanup recovery semantics. Requires --force.
    #[arg(long, value_enum)]
    cleanup: Option<CleanupPolicy>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum CleanupPolicy {
    /// Cleanup a failed production target service and require it to be disabled.
    FailedStart,
    /// Cleanup a partially started transient CI service without disabling it.
    PartialStart,
}

impl CleanupPolicy {
    fn requires_disabled_service(self) -> bool {
        matches!(self, Self::FailedStart)
    }
}

trait ServiceStopOps: ActiveJobsGateOps {
    type LockGuard;

    fn acquire_lock<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        home: &'a HomePaths,
        cleanup: Option<CleanupPolicy>,
    ) -> ServiceFuture<'a, Self::LockGuard>
    where
        Self::LockGuard: 'a;

    fn is_active<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, bool>;
    fn stop<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()>;
    fn stop_bounded<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        duration: TokioDuration,
    ) -> ServiceFuture<'a, BoundedSystemctlOutcome>;
    fn cleanup_active_state<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, CleanupUnitActiveState>;
    fn kill_all_sigkill<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()>;
    fn stop_no_block<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()>;
    fn reset_failed<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()>;
    fn reset_failed_bounded<'a>(&'a mut self, unit: &'a RunnerServiceUnit)
    -> ServiceFuture<'a, ()>;
    fn disable<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()>;
    fn is_enabled<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, bool>;
    fn cleanup_drain_restart_override<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, ()>;
    fn cleanup_drain_restart_override_bounded<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, ()>;
    fn sleep(&mut self, duration: TokioDuration) -> ServiceFuture<'_, ()>;
}

struct RealServiceStopOps;

pub(super) async fn run(args: StopArgs) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    let home = HomePaths::new()?;
    let mut ops = RealServiceStopOps;
    stop_with_ops(&unit, &home, args.force, args.cleanup, &mut ops).await
}

async fn acquire_cleanup_service_lock(
    unit: &RunnerServiceUnit,
    home: &HomePaths,
) -> RunnerResult<nix::fcntl::Flock<std::fs::File>> {
    let path = unit.lock_path(home);
    let deadline = TokioInstant::now() + CLEANUP_LOCK_TIMEOUT;

    loop {
        match runner_host::lock::try_acquire_or_busy(path.clone()).await? {
            runner_host::lock::TryLock::Acquired(lock) => return Ok(lock),
            runner_host::lock::TryLock::Busy => {
                let now = TokioInstant::now();
                if now >= deadline {
                    return Err(RunnerError::Internal(format!(
                        "timed out waiting {}s for {} service lock during cleanup",
                        CLEANUP_LOCK_TIMEOUT.as_secs(),
                        unit.unit_name()
                    )));
                }
                tokio::time::sleep(std::cmp::min(CLEANUP_LOCK_POLL_INTERVAL, deadline - now)).await;
            }
        }
    }
}

async fn run_cleanup_systemctl(args: &[&str], duration: TokioDuration) -> RunnerResult<()> {
    match run_systemctl_bounded(args, duration).await? {
        BoundedSystemctlOutcome::Success => Ok(()),
        BoundedSystemctlOutcome::Failed(status) => Err(RunnerError::Internal(format!(
            "systemctl {args:?} exited with {status} during cleanup"
        ))),
        BoundedSystemctlOutcome::TimedOut => Err(RunnerError::Internal(format!(
            "systemctl {args:?} timed out after {}s during cleanup",
            duration.as_secs()
        ))),
    }
}

impl ServiceStopOps for RealServiceStopOps {
    type LockGuard = nix::fcntl::Flock<std::fs::File>;

    fn acquire_lock<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        home: &'a HomePaths,
        cleanup: Option<CleanupPolicy>,
    ) -> ServiceFuture<'a, Self::LockGuard>
    where
        Self::LockGuard: 'a,
    {
        Box::pin(async move {
            if cleanup.is_some() {
                acquire_cleanup_service_lock(unit, home).await
            } else {
                acquire_service_lock(unit, home).await
            }
        })
    }

    fn is_active<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, bool> {
        Box::pin(async move { is_unit_active(unit).await.map_err(Into::into) })
    }

    fn stop<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            run_systemctl(&["stop", unit.service_name()])
                .await
                .map_err(Into::into)
        })
    }

    fn stop_bounded<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        duration: TokioDuration,
    ) -> ServiceFuture<'a, BoundedSystemctlOutcome> {
        Box::pin(async move {
            run_systemctl_bounded(&["stop", unit.service_name()], duration)
                .await
                .map_err(Into::into)
        })
    }

    fn cleanup_active_state<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, CleanupUnitActiveState> {
        Box::pin(async move {
            cleanup_unit_active_state_bounded(unit, CLEANUP_ACTION_TIMEOUT)
                .await
                .map_err(Into::into)
        })
    }

    fn kill_all_sigkill<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            run_cleanup_systemctl(
                &[
                    "kill",
                    "--kill-whom=all",
                    "--signal=SIGKILL",
                    unit.service_name(),
                ],
                CLEANUP_ACTION_TIMEOUT,
            )
            .await
        })
    }

    fn stop_no_block<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            run_cleanup_systemctl(
                &["stop", "--no-block", unit.service_name()],
                CLEANUP_ACTION_TIMEOUT,
            )
            .await
        })
    }

    fn reset_failed<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            run_systemctl(&["reset-failed", unit.service_name()])
                .await
                .map_err(Into::into)
        })
    }

    fn reset_failed_bounded<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            run_cleanup_systemctl(
                &["reset-failed", unit.service_name()],
                CLEANUP_ACTION_TIMEOUT,
            )
            .await
        })
    }

    fn disable<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            run_cleanup_systemctl(
                &["disable", "--no-reload", unit.service_name()],
                CLEANUP_ACTION_TIMEOUT,
            )
            .await
        })
    }

    fn is_enabled<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, bool> {
        Box::pin(async move {
            is_unit_enabled_bounded(unit, CLEANUP_ACTION_TIMEOUT)
                .await
                .map_err(Into::into)
        })
    }

    fn cleanup_drain_restart_override<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            reconcile_drain_restart_override_removal(unit, SystemdReloadPolicy::Unbounded).await
        })
    }

    fn cleanup_drain_restart_override_bounded<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            reconcile_drain_restart_override_removal(
                unit,
                SystemdReloadPolicy::Bounded {
                    lock_timeout: CLEANUP_LOCK_TIMEOUT,
                    command_timeout: CLEANUP_ACTION_TIMEOUT,
                },
            )
            .await
        })
    }

    fn sleep(&mut self, duration: TokioDuration) -> ServiceFuture<'_, ()> {
        Box::pin(async move {
            tokio::time::sleep(duration).await;
            Ok(())
        })
    }
}

impl ActiveJobsGateOps for RealServiceStopOps {
    fn is_unit_active<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, bool> {
        Box::pin(async move { is_unit_active(unit).await.map_err(Into::into) })
    }

    fn read_unit_config_path<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, Option<std::path::PathBuf>> {
        Box::pin(async move { read_unit_config_path(unit).await.map_err(Into::into) })
    }
}

async fn stop_with_ops(
    unit: &RunnerServiceUnit,
    home: &HomePaths,
    force: bool,
    cleanup: Option<CleanupPolicy>,
    ops: &mut impl ServiceStopOps,
) -> RunnerResult<()> {
    if let Some(cleanup) = cleanup {
        if !force {
            return Err(RunnerError::Internal(
                "runner service stop --cleanup requires --force because cleanup may kill active jobs"
                    .to_string(),
            ));
        }
        check_active_jobs_gate(unit, home, force, "stop", ops).await?;
        let _service_lock = ops.acquire_lock(unit, home, Some(cleanup)).await?;
        stop_cleanup_with_ops(unit, cleanup, ops).await
    } else {
        let _service_lock = ops.acquire_lock(unit, home, cleanup).await?;
        check_active_jobs_gate(unit, home, force, "stop", ops).await?;
        stop_default_with_ops(unit, ops).await
    }
}

async fn stop_default_with_ops(
    unit: &RunnerServiceUnit,
    ops: &mut impl ServiceStopOps,
) -> RunnerResult<()> {
    let svc = unit.service_name();

    if ops.is_active(unit).await? {
        // Active unit: stop must succeed; otherwise the runner process and sandboxes
        // can keep running.
        ops.stop(unit).await?;
        info!(unit = %unit.unit_name(), "stopped");
    } else {
        // Unit may be loaded but inactive (residual transient unit).
        // Try stop to trigger systemd GC. Ignore errors because the unit may
        // not exist at all on a first run.
        let _ = ops.stop(unit).await;
        info!(unit = %unit.unit_name(), "no active service found");
    }

    // Clear "failed" latch so systemd fully unloads the transient unit.
    let _ = ops.reset_failed(unit).await;
    ops.cleanup_drain_restart_override(unit)
        .await
        .map_err(|error| {
            RunnerError::Internal(format!(
                "stopped {svc}, but failed to make drain restart override cleanup effective: {error}"
            ))
        })?;
    Ok(())
}

async fn stop_cleanup_with_ops(
    unit: &RunnerServiceUnit,
    cleanup: CleanupPolicy,
    ops: &mut impl ServiceStopOps,
) -> RunnerResult<()> {
    let (stop_needs_escalation, initial_stop_error) = match ops
        .stop_bounded(unit, CLEANUP_STOP_TIMEOUT)
        .await
    {
        Ok(BoundedSystemctlOutcome::Success) => (false, None),
        Ok(BoundedSystemctlOutcome::Failed(status)) => {
            warn!(unit = %unit.unit_name(), %status, "bounded systemctl stop failed during cleanup");
            (true, None)
        }
        Ok(BoundedSystemctlOutcome::TimedOut) => {
            warn!(unit = %unit.unit_name(), "bounded systemctl stop timed out during cleanup");
            (true, None)
        }
        Err(error) => {
            warn!(unit = %unit.unit_name(), error = %error, "bounded systemctl stop errored during cleanup");
            (true, Some(error))
        }
    };

    let state = match ops.cleanup_active_state(unit).await {
        Ok(state) => Some(state),
        Err(e) => {
            warn!(unit = %unit.unit_name(), error = %e, "failed to read service state after stop during cleanup");
            None
        }
    };
    let mut cleanup_escalated = false;
    match state.as_ref() {
        Some(state) if state.is_active_like() => {
            warn!(
                unit = %unit.unit_name(),
                active_state = state.active_state(),
                "runner service remains active-like after stop; escalating cleanup"
            );
            escalate_cleanup_stop(unit, ops).await;
            cleanup_escalated = true;
        }
        None if stop_needs_escalation => {
            warn!(
                unit = %unit.unit_name(),
                "runner service state is unknown after failed stop; escalating cleanup"
            );
            escalate_cleanup_stop(unit, ops).await;
            cleanup_escalated = true;
        }
        _ => {}
    }

    let disable_error = if cleanup.requires_disabled_service() {
        match ops.disable(unit).await {
            Ok(()) => None,
            Err(e) => {
                warn!(unit = %unit.unit_name(), error = %e, "failed to disable runner service during cleanup");
                Some(e)
            }
        }
    } else {
        None
    };

    if let Err(e) = ops.reset_failed_bounded(unit).await {
        warn!(unit = %unit.unit_name(), error = %e, "failed to reset failed service state during cleanup");
    }
    let drain_cleanup_result = ops.cleanup_drain_restart_override_bounded(unit).await;
    if let Err(error) = &drain_cleanup_result {
        warn!(unit = %unit.unit_name(), error = %error, "failed to remove drain restart override during cleanup");
    }

    let inactive_result = verify_cleanup_inactive(unit, ops, cleanup_escalated).await;
    let disabled_result = if cleanup.requires_disabled_service() {
        verify_cleanup_not_enabled(unit, ops, disable_error).await
    } else {
        Ok(())
    };

    let postcondition_result =
        combine_cleanup_postcondition_results(unit, inactive_result, disabled_result);
    let cleanup_result =
        combine_cleanup_transition_results(unit, drain_cleanup_result, postcondition_result);
    combine_cleanup_initial_stop_result(unit, initial_stop_error, cleanup_result)
}

async fn verify_cleanup_not_enabled(
    unit: &RunnerServiceUnit,
    ops: &mut impl ServiceStopOps,
    disable_error: Option<RunnerError>,
) -> RunnerResult<()> {
    match ops.is_enabled(unit).await {
        Ok(false) => {
            info!(unit = %unit.unit_name(), "runner service cleanup verified not enabled");
            Ok(())
        }
        Ok(true) => {
            let disable_detail = disable_error
                .map(|e| format!("; disable attempt failed: {e}"))
                .unwrap_or_default();
            Err(RunnerError::Internal(format!(
                "failed-start cleanup left {} enabled{disable_detail}",
                unit.service_name()
            )))
        }
        Err(verification_error) => match disable_error {
            Some(disable_error) => Err(RunnerError::Internal(format!(
                "failed to verify {} is not enabled after failed-start cleanup: {verification_error}; disable attempt also failed: {disable_error}",
                unit.service_name()
            ))),
            None => Err(RunnerError::Internal(format!(
                "failed to verify {} is not enabled after failed-start cleanup: {verification_error}",
                unit.service_name()
            ))),
        },
    }
}

fn combine_cleanup_postcondition_results(
    unit: &RunnerServiceUnit,
    inactive_result: RunnerResult<()>,
    disabled_result: RunnerResult<()>,
) -> RunnerResult<()> {
    match (inactive_result, disabled_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(inactive_error), Err(disabled_error)) => Err(RunnerError::Internal(format!(
            "cleanup postconditions failed for {}: {inactive_error}; additionally: {disabled_error}",
            unit.service_name()
        ))),
    }
}

fn combine_cleanup_transition_results(
    unit: &RunnerServiceUnit,
    drain_cleanup_result: RunnerResult<()>,
    postcondition_result: RunnerResult<()>,
) -> RunnerResult<()> {
    match (drain_cleanup_result, postcondition_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(drain_cleanup_error), Err(postcondition_error)) => {
            Err(RunnerError::Internal(format!(
                "cleanup failed for {}: {drain_cleanup_error}; additionally: {postcondition_error}",
                unit.service_name()
            )))
        }
    }
}

fn combine_cleanup_initial_stop_result(
    unit: &RunnerServiceUnit,
    initial_stop_error: Option<RunnerError>,
    cleanup_result: RunnerResult<()>,
) -> RunnerResult<()> {
    match (initial_stop_error, cleanup_result) {
        (_, Ok(())) => Ok(()),
        (None, Err(error)) => Err(error),
        (Some(initial_stop_error), Err(cleanup_error)) => Err(RunnerError::Internal(format!(
            "cleanup failed for {} after bounded systemctl stop error: {initial_stop_error}; additionally: {cleanup_error}",
            unit.service_name()
        ))),
    }
}

async fn escalate_cleanup_stop(unit: &RunnerServiceUnit, ops: &mut impl ServiceStopOps) {
    if let Err(e) = ops.kill_all_sigkill(unit).await {
        warn!(unit = %unit.unit_name(), error = %e, "failed to SIGKILL runner service during cleanup");
    }
    if let Err(e) = ops.stop_no_block(unit).await {
        warn!(unit = %unit.unit_name(), error = %e, "failed to queue no-block stop during cleanup");
    }
}

async fn verify_cleanup_inactive(
    unit: &RunnerServiceUnit,
    ops: &mut impl ServiceStopOps,
    mut cleanup_escalated: bool,
) -> RunnerResult<()> {
    let deadline = TokioInstant::now() + CLEANUP_VERIFY_TIMEOUT;
    let mut last_active_state: Option<String> = None;
    let mut last_read_error: Option<String> = None;

    loop {
        match ops.cleanup_active_state(unit).await {
            Ok(state) => {
                if !state.is_active_like() {
                    info!(unit = %unit.unit_name(), "runner service cleanup verified inactive");
                    return Ok(());
                }
                last_active_state = Some(state.active_state().to_string());
                if !cleanup_escalated {
                    warn!(
                        unit = %unit.unit_name(),
                        active_state = state.active_state(),
                        "runner service remains active-like during verification; escalating cleanup"
                    );
                    escalate_cleanup_stop(unit, ops).await;
                    cleanup_escalated = true;
                }
            }
            Err(e) => {
                warn!(unit = %unit.unit_name(), error = %e, "failed to read service state during cleanup verification");
                last_read_error = Some(e.to_string());
            }
        }

        let now = TokioInstant::now();
        if now >= deadline {
            if let Some(active_state) = last_active_state {
                return Err(RunnerError::Internal(format!(
                    "failed to stop {}; ActiveState={} after {}s cleanup verification",
                    unit.service_name(),
                    active_state,
                    CLEANUP_VERIFY_TIMEOUT.as_secs()
                )));
            }
            if let Some(error) = last_read_error {
                return Err(RunnerError::Internal(format!(
                    "failed to verify {} is inactive after {}s cleanup verification: {error}",
                    unit.service_name(),
                    CLEANUP_VERIFY_TIMEOUT.as_secs()
                )));
            }
            return Err(RunnerError::Internal(format!(
                "failed to verify {} is inactive after {}s cleanup verification",
                unit.service_name(),
                CLEANUP_VERIFY_TIMEOUT.as_secs()
            )));
        }

        ops.sleep(std::cmp::min(CLEANUP_VERIFY_INTERVAL, deadline - now))
            .await?;
    }
}

#[cfg(test)]
mod tests;
