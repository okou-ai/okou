use clap::{Args, ValueEnum};
use tokio::time::{Duration as TokioDuration, Instant as TokioInstant};
use tracing::{info, warn};

use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;

use super::drain_override_cleanup::{
    DrainOverrideReloadPolicy, reconcile_drain_restart_override_removal,
};
use super::gate::{ActiveJobsGateOps, check_active_jobs_gate};
use super::systemctl::{
    BoundedSystemctlOutcome, CleanupUnitActiveState, cleanup_unit_active_state_bounded,
    is_unit_active, is_unit_enabled_bounded, run_systemctl, run_systemctl_bounded,
};
use super::{RunnerServiceUnit, ServiceFuture, acquire_service_lock, read_unit_config_path};

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
        match crate::lock::try_acquire_or_busy(path.clone()).await? {
            crate::lock::TryLock::Acquired(lock) => return Ok(lock),
            crate::lock::TryLock::Busy => {
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
        Box::pin(async move { is_unit_active(unit).await })
    }

    fn stop<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
        Box::pin(async move { run_systemctl(&["stop", unit.service_name()]).await })
    }

    fn stop_bounded<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        duration: TokioDuration,
    ) -> ServiceFuture<'a, BoundedSystemctlOutcome> {
        Box::pin(
            async move { run_systemctl_bounded(&["stop", unit.service_name()], duration).await },
        )
    }

    fn cleanup_active_state<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, CleanupUnitActiveState> {
        Box::pin(
            async move { cleanup_unit_active_state_bounded(unit, CLEANUP_ACTION_TIMEOUT).await },
        )
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
        Box::pin(async move { run_systemctl(&["reset-failed", unit.service_name()]).await })
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
        Box::pin(async move { is_unit_enabled_bounded(unit, CLEANUP_ACTION_TIMEOUT).await })
    }

    fn cleanup_drain_restart_override<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            reconcile_drain_restart_override_removal(unit, DrainOverrideReloadPolicy::Unbounded)
                .await
        })
    }

    fn cleanup_drain_restart_override_bounded<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            reconcile_drain_restart_override_removal(
                unit,
                DrainOverrideReloadPolicy::Bounded {
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
        Box::pin(async move { is_unit_active(unit).await })
    }

    fn read_unit_config_path<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, Option<std::path::PathBuf>> {
        Box::pin(async move { read_unit_config_path(unit).await })
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

runner_test_group!(cmd_service; #[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::path::PathBuf;

    use super::*;

    fn service_unit() -> RunnerServiceUnit {
        RunnerServiceUnit::from_suffix("test").unwrap()
    }

    fn fake_home() -> HomePaths {
        HomePaths::with_root(PathBuf::from("/tmp/vm0-runner-test"))
    }

    fn fake_error(message: &str) -> RunnerError {
        RunnerError::Internal(message.to_string())
    }

    struct FakeStopOps {
        events: Vec<&'static str>,
        acquire_lock_error: bool,
        gate_active_results: VecDeque<RunnerResult<bool>>,
        gate_config_path: Option<PathBuf>,
        active_results: VecDeque<RunnerResult<bool>>,
        stop_results: VecDeque<RunnerResult<()>>,
        bounded_stop_results: VecDeque<RunnerResult<BoundedSystemctlOutcome>>,
        cleanup_states: VecDeque<RunnerResult<CleanupUnitActiveState>>,
        kill_error: bool,
        stop_no_block_error: bool,
        reset_failed_error: bool,
        disable_error: bool,
        enabled_results: VecDeque<RunnerResult<bool>>,
        cleanup_drain_error: bool,
        advance_time_on_sleep: bool,
    }

    impl Default for FakeStopOps {
        fn default() -> Self {
            Self {
                events: Vec::new(),
                acquire_lock_error: false,
                gate_active_results: VecDeque::from([Ok(false)]),
                gate_config_path: Some(PathBuf::from("/tmp/runner-config.yaml")),
                active_results: VecDeque::from([Ok(true)]),
                stop_results: VecDeque::from([Ok(())]),
                bounded_stop_results: VecDeque::from([Ok(BoundedSystemctlOutcome::Success)]),
                cleanup_states: VecDeque::from([Ok(CleanupUnitActiveState::for_test(
                    "inactive", false,
                ))]),
                kill_error: false,
                stop_no_block_error: false,
                reset_failed_error: false,
                disable_error: false,
                enabled_results: VecDeque::from([Ok(false)]),
                cleanup_drain_error: false,
                advance_time_on_sleep: false,
            }
        }
    }

    impl ActiveJobsGateOps for FakeStopOps {
        fn is_unit_active<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, bool> {
            self.events.push("gate_is_active");
            Box::pin(std::future::ready(
                self.gate_active_results
                    .pop_front()
                    .expect("unexpected gate unit-active query"),
            ))
        }

        fn read_unit_config_path<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, Option<PathBuf>> {
            self.events.push("gate_config_path");
            Box::pin(std::future::ready(Ok(self.gate_config_path.clone())))
        }
    }

    impl ServiceStopOps for FakeStopOps {
        type LockGuard = ();

        fn acquire_lock<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
            _home: &'a HomePaths,
            cleanup: Option<CleanupPolicy>,
        ) -> ServiceFuture<'a, Self::LockGuard>
        where
            Self::LockGuard: 'a,
        {
            self.events.push(if cleanup.is_some() {
                "acquire_cleanup_lock"
            } else {
                "acquire_lock"
            });
            Box::pin(std::future::ready(if self.acquire_lock_error {
                Err(fake_error("lock busy"))
            } else {
                Ok(())
            }))
        }

        fn is_active<'a>(&'a mut self, _unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, bool> {
            self.events.push("is_active");
            Box::pin(std::future::ready(
                self.active_results.pop_front().unwrap_or(Ok(false)),
            ))
        }

        fn stop<'a>(&'a mut self, _unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
            self.events.push("stop");
            Box::pin(std::future::ready(
                self.stop_results.pop_front().unwrap_or(Ok(())),
            ))
        }

        fn stop_bounded<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
            _duration: TokioDuration,
        ) -> ServiceFuture<'a, BoundedSystemctlOutcome> {
            self.events.push("stop_bounded");
            Box::pin(std::future::ready(
                self.bounded_stop_results
                    .pop_front()
                    .unwrap_or(Ok(BoundedSystemctlOutcome::Success)),
            ))
        }

        fn cleanup_active_state<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, CleanupUnitActiveState> {
            self.events.push("cleanup_active_state");
            Box::pin(std::future::ready(
                self.cleanup_states
                    .pop_front()
                    .unwrap_or(Ok(CleanupUnitActiveState::for_test("inactive", false))),
            ))
        }

        fn kill_all_sigkill<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, ()> {
            self.events.push("kill_all_sigkill");
            Box::pin(std::future::ready(if self.kill_error {
                Err(fake_error("kill failed"))
            } else {
                Ok(())
            }))
        }

        fn stop_no_block<'a>(&'a mut self, _unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
            self.events.push("stop_no_block");
            Box::pin(std::future::ready(if self.stop_no_block_error {
                Err(fake_error("stop no-block failed"))
            } else {
                Ok(())
            }))
        }

        fn reset_failed<'a>(&'a mut self, _unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
            self.events.push("reset_failed");
            Box::pin(std::future::ready(if self.reset_failed_error {
                Err(fake_error("reset failed"))
            } else {
                Ok(())
            }))
        }

        fn reset_failed_bounded<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, ()> {
            self.events.push("reset_failed_bounded");
            Box::pin(std::future::ready(if self.reset_failed_error {
                Err(fake_error("reset failed"))
            } else {
                Ok(())
            }))
        }

        fn disable<'a>(&'a mut self, _unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
            self.events.push("disable");
            Box::pin(std::future::ready(if self.disable_error {
                Err(fake_error("disable failed"))
            } else {
                Ok(())
            }))
        }

        fn is_enabled<'a>(&'a mut self, _unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, bool> {
            self.events.push("is_enabled");
            Box::pin(std::future::ready(
                self.enabled_results.pop_front().unwrap_or(Ok(false)),
            ))
        }

        fn cleanup_drain_restart_override<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, ()> {
            self.events.push("cleanup_drain_restart_override");
            Box::pin(std::future::ready(if self.cleanup_drain_error {
                Err(fake_error("cleanup drain failed"))
            } else {
                Ok(())
            }))
        }

        fn cleanup_drain_restart_override_bounded<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, ()> {
            self.events.push("cleanup_drain_restart_override_bounded");
            Box::pin(std::future::ready(if self.cleanup_drain_error {
                Err(fake_error("cleanup drain failed"))
            } else {
                Ok(())
            }))
        }

        fn sleep(&mut self, duration: TokioDuration) -> ServiceFuture<'_, ()> {
            self.events.push("sleep");
            let advance_time = self.advance_time_on_sleep;
            Box::pin(async move {
                if advance_time {
                    tokio::time::advance(duration).await;
                }
                Ok(())
            })
        }
    }

    fn cleanup_state(
        active_state: &str,
        active_like: bool,
    ) -> RunnerResult<CleanupUnitActiveState> {
        Ok(CleanupUnitActiveState::for_test(active_state, active_like))
    }

    #[tokio::test]
    async fn stop_default_active_service_preserves_existing_sequence() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps::default();

        stop_with_ops(&unit, &home, false, None, &mut ops)
            .await
            .unwrap();

        assert_eq!(
            ops.events,
            [
                "acquire_lock",
                "gate_is_active",
                "is_active",
                "stop",
                "reset_failed",
                "cleanup_drain_restart_override",
            ]
        );
    }

    #[tokio::test]
    async fn stop_uses_selected_config_base_dir_before_service_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let unit = service_unit();
        let config_path = dir.path().join("selected-config.yaml");
        let base_dir = home.runners_dir().join("runner-release");
        let _live_instance = crate::live_runner_instances::publish(
            &home,
            crate::live_runner_instances::LiveRunnerInstanceMetadata {
                config_path: config_path.clone(),
                base_dir: base_dir.clone(),
                runner_group: "test".to_string(),
                subcommand: "start".to_string(),
            },
        )
        .await
        .unwrap();
        tokio::fs::create_dir_all(&base_dir).await.unwrap();
        let started_at = (chrono::Utc::now() - chrono::Duration::minutes(10))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let parsed_started_at = chrono::DateTime::parse_from_rfc3339(&started_at)
            .unwrap()
            .with_timezone(&chrono::Utc);
        tokio::fs::write(
            base_dir.join("status.json"),
            format!(
                r#"{{
                    "mode":"running",
                    "active_runs":[
                        {{"run_id":"0191c4e0-0000-7000-8000-000000000001"}},
                        {{"run_id":"0191c4e0-0000-7000-8000-000000000002"}}
                    ],
                    "started_at":"{started_at}"
                }}"#
            ),
        )
        .await
        .unwrap();
        let mut ops = FakeStopOps {
            gate_active_results: VecDeque::from([Ok(true)]),
            gate_config_path: Some(config_path),
            ..FakeStopOps::default()
        };

        let before_gate = chrono::Utc::now();
        let error = stop_with_ops(&unit, &home, false, None, &mut ops)
            .await
            .unwrap_err();
        let after_gate = chrono::Utc::now();

        assert_eq!(
            ops.events,
            ["acquire_lock", "gate_is_active", "gate_config_path"]
        );
        let RunnerError::ActiveJobs(error) = error else {
            panic!("expected active-jobs refusal");
        };
        assert_eq!(error.unit, "vm0-runner-test");
        assert_eq!(error.suffix, "test");
        assert_eq!(
            error
                .run_ids
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
            [
                "0191c4e0-0000-7000-8000-000000000001",
                "0191c4e0-0000-7000-8000-000000000002",
            ]
        );
        assert!(error.runner_uptime >= (before_gate - parsed_started_at).to_std().unwrap());
        assert!(error.runner_uptime <= (after_gate - parsed_started_at).to_std().unwrap());
        assert_eq!(error.command_name, "stop");
        assert!(!error.draining);
    }

    #[tokio::test]
    async fn stop_fails_closed_when_gate_unit_state_is_unavailable() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps {
            gate_active_results: VecDeque::from([Err(fake_error("systemd unavailable"))]),
            ..FakeStopOps::default()
        };

        let error = stop_with_ops(&unit, &home, false, None, &mut ops)
            .await
            .unwrap_err();
        let message = error.to_string();

        assert!(message.contains("vm0-runner-test"));
        assert!(message.contains("before service stop"));
        assert!(message.contains("systemd unavailable"));
        assert_eq!(ops.events, ["acquire_lock", "gate_is_active"]);
    }

    #[tokio::test]
    async fn stop_default_reports_drain_cleanup_failure() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps {
            cleanup_drain_error: true,
            ..FakeStopOps::default()
        };

        let error = stop_with_ops(&unit, &home, false, None, &mut ops)
            .await
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("failed to make drain restart override cleanup effective")
        );
    }

    #[tokio::test]
    async fn stop_force_without_cleanup_does_not_escalate_or_disable() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps::default();

        stop_with_ops(&unit, &home, true, None, &mut ops)
            .await
            .unwrap();

        assert!(!ops.events.contains(&"stop_bounded"));
        assert!(!ops.events.contains(&"kill_all_sigkill"));
        assert!(!ops.events.contains(&"disable"));
    }

    #[tokio::test]
    async fn stop_cleanup_requires_force_before_gate_or_lock() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps::default();

        let err = stop_with_ops(
            &unit,
            &home,
            false,
            Some(CleanupPolicy::PartialStart),
            &mut ops,
        )
        .await
        .unwrap_err();

        assert!(err.to_string().contains("--cleanup requires --force"));
        assert!(ops.events.is_empty());
    }

    #[tokio::test]
    async fn stop_partial_start_cleanup_uses_bounded_stop_without_disable() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps::default();

        stop_with_ops(
            &unit,
            &home,
            true,
            Some(CleanupPolicy::PartialStart),
            &mut ops,
        )
        .await
        .unwrap();

        assert_eq!(
            ops.events,
            [
                "acquire_cleanup_lock",
                "stop_bounded",
                "cleanup_active_state",
                "reset_failed_bounded",
                "cleanup_drain_restart_override_bounded",
                "cleanup_active_state",
            ]
        );
    }

    #[tokio::test]
    async fn stop_cleanup_reports_coordinated_reload_failure() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps {
            cleanup_drain_error: true,
            ..FakeStopOps::default()
        };

        let error = stop_with_ops(
            &unit,
            &home,
            true,
            Some(CleanupPolicy::PartialStart),
            &mut ops,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("cleanup drain failed"));
    }

    #[tokio::test]
    async fn stop_failed_start_cleanup_disables_service() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps::default();

        stop_with_ops(
            &unit,
            &home,
            true,
            Some(CleanupPolicy::FailedStart),
            &mut ops,
        )
        .await
        .unwrap();

        assert_eq!(
            ops.events,
            [
                "acquire_cleanup_lock",
                "stop_bounded",
                "cleanup_active_state",
                "disable",
                "reset_failed_bounded",
                "cleanup_drain_restart_override_bounded",
                "cleanup_active_state",
                "is_enabled",
            ]
        );
    }

    #[tokio::test]
    async fn stop_failed_start_cleanup_disables_when_initial_state_read_fails() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps {
            cleanup_states: VecDeque::from([
                Err(fake_error("state unavailable")),
                cleanup_state("inactive", false),
            ]),
            ..FakeStopOps::default()
        };

        stop_with_ops(
            &unit,
            &home,
            true,
            Some(CleanupPolicy::FailedStart),
            &mut ops,
        )
        .await
        .unwrap();

        assert_eq!(
            ops.events,
            [
                "acquire_cleanup_lock",
                "stop_bounded",
                "cleanup_active_state",
                "disable",
                "reset_failed_bounded",
                "cleanup_drain_restart_override_bounded",
                "cleanup_active_state",
                "is_enabled",
            ]
        );
    }

    #[tokio::test]
    async fn stop_failed_start_cleanup_accepts_disable_error_after_confirming_not_enabled() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps {
            disable_error: true,
            ..FakeStopOps::default()
        };

        stop_with_ops(
            &unit,
            &home,
            true,
            Some(CleanupPolicy::FailedStart),
            &mut ops,
        )
        .await
        .unwrap();

        assert_eq!(
            ops.events,
            [
                "acquire_cleanup_lock",
                "stop_bounded",
                "cleanup_active_state",
                "disable",
                "reset_failed_bounded",
                "cleanup_drain_restart_override_bounded",
                "cleanup_active_state",
                "is_enabled",
            ]
        );
    }

    #[tokio::test]
    async fn stop_failed_start_cleanup_fails_when_disable_errors_and_unit_remains_enabled() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps {
            disable_error: true,
            enabled_results: VecDeque::from([Ok(true)]),
            ..FakeStopOps::default()
        };

        let err = stop_with_ops(
            &unit,
            &home,
            true,
            Some(CleanupPolicy::FailedStart),
            &mut ops,
        )
        .await
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("left vm0-runner-test.service enabled"));
        assert!(message.contains("disable failed"));
        assert_eq!(
            ops.events,
            [
                "acquire_cleanup_lock",
                "stop_bounded",
                "cleanup_active_state",
                "disable",
                "reset_failed_bounded",
                "cleanup_drain_restart_override_bounded",
                "cleanup_active_state",
                "is_enabled",
            ]
        );
    }

    #[tokio::test]
    async fn stop_failed_start_cleanup_fails_when_disable_succeeds_but_unit_remains_enabled() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps {
            enabled_results: VecDeque::from([Ok(true)]),
            ..FakeStopOps::default()
        };

        let err = stop_with_ops(
            &unit,
            &home,
            true,
            Some(CleanupPolicy::FailedStart),
            &mut ops,
        )
        .await
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("left vm0-runner-test.service enabled"));
        assert!(!message.contains("disable failed"));
    }

    #[tokio::test]
    async fn stop_failed_start_cleanup_preserves_disable_and_enablement_query_errors() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps {
            disable_error: true,
            enabled_results: VecDeque::from([Err(fake_error("is-enabled unavailable"))]),
            ..FakeStopOps::default()
        };

        let err = stop_with_ops(
            &unit,
            &home,
            true,
            Some(CleanupPolicy::FailedStart),
            &mut ops,
        )
        .await
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("failed to verify vm0-runner-test.service is not enabled"));
        assert!(message.contains("is-enabled unavailable"));
        assert!(message.contains("disable failed"));
    }

    #[tokio::test(start_paused = true)]
    async fn stop_failed_start_cleanup_preserves_inactive_and_enablement_failures() {
        let unit = service_unit();
        let home = fake_home();
        let active_states = std::iter::repeat_with(|| cleanup_state("active", true))
            .take(16)
            .collect();
        let mut ops = FakeStopOps {
            cleanup_states: active_states,
            enabled_results: VecDeque::from([Ok(true)]),
            advance_time_on_sleep: true,
            ..FakeStopOps::default()
        };

        let err = stop_with_ops(
            &unit,
            &home,
            true,
            Some(CleanupPolicy::FailedStart),
            &mut ops,
        )
        .await
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("ActiveState=active"));
        assert!(message.contains("left vm0-runner-test.service enabled"));
        assert_eq!(ops.events.last(), Some(&"is_enabled"));
    }

    #[tokio::test]
    async fn stop_cleanup_escalates_when_stop_times_out_and_state_remains_active_like() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps {
            bounded_stop_results: VecDeque::from([Ok(BoundedSystemctlOutcome::TimedOut)]),
            cleanup_states: VecDeque::from([
                cleanup_state("deactivating", true),
                cleanup_state("inactive", false),
            ]),
            ..FakeStopOps::default()
        };

        stop_with_ops(
            &unit,
            &home,
            true,
            Some(CleanupPolicy::PartialStart),
            &mut ops,
        )
        .await
        .unwrap();

        assert_eq!(
            ops.events,
            [
                "acquire_cleanup_lock",
                "stop_bounded",
                "cleanup_active_state",
                "kill_all_sigkill",
                "stop_no_block",
                "reset_failed_bounded",
                "cleanup_drain_restart_override_bounded",
                "cleanup_active_state",
            ]
        );
    }

    #[tokio::test]
    async fn stop_cleanup_escalates_when_stop_times_out_and_state_read_fails() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps {
            bounded_stop_results: VecDeque::from([Ok(BoundedSystemctlOutcome::TimedOut)]),
            cleanup_states: VecDeque::from([
                Err(fake_error("state unavailable")),
                cleanup_state("inactive", false),
            ]),
            ..FakeStopOps::default()
        };

        stop_with_ops(
            &unit,
            &home,
            true,
            Some(CleanupPolicy::PartialStart),
            &mut ops,
        )
        .await
        .unwrap();

        assert_eq!(
            ops.events,
            [
                "acquire_cleanup_lock",
                "stop_bounded",
                "cleanup_active_state",
                "kill_all_sigkill",
                "stop_no_block",
                "reset_failed_bounded",
                "cleanup_drain_restart_override_bounded",
                "cleanup_active_state",
            ]
        );
    }

    #[tokio::test]
    async fn stop_cleanup_recovers_from_bounded_stop_error() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps {
            bounded_stop_results: VecDeque::from([Err(fake_error("initial stop unavailable"))]),
            cleanup_states: VecDeque::from([
                Err(fake_error("state unavailable")),
                cleanup_state("inactive", false),
            ]),
            ..FakeStopOps::default()
        };

        stop_with_ops(
            &unit,
            &home,
            true,
            Some(CleanupPolicy::PartialStart),
            &mut ops,
        )
        .await
        .unwrap();

        assert_eq!(
            ops.events,
            [
                "acquire_cleanup_lock",
                "stop_bounded",
                "cleanup_active_state",
                "kill_all_sigkill",
                "stop_no_block",
                "reset_failed_bounded",
                "cleanup_drain_restart_override_bounded",
                "cleanup_active_state",
            ]
        );
    }

    #[tokio::test]
    async fn stop_failed_start_cleanup_preserves_bounded_stop_and_enablement_failures() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps {
            bounded_stop_results: VecDeque::from([Err(fake_error("initial stop unavailable"))]),
            enabled_results: VecDeque::from([Ok(true)]),
            ..FakeStopOps::default()
        };

        let error = stop_with_ops(
            &unit,
            &home,
            true,
            Some(CleanupPolicy::FailedStart),
            &mut ops,
        )
        .await
        .unwrap_err();
        let message = error.to_string();

        assert!(message.contains("bounded systemctl stop error"));
        assert!(message.contains("initial stop unavailable"));
        assert!(message.contains("left vm0-runner-test.service enabled"));
        assert_eq!(
            ops.events,
            [
                "acquire_cleanup_lock",
                "stop_bounded",
                "cleanup_active_state",
                "disable",
                "reset_failed_bounded",
                "cleanup_drain_restart_override_bounded",
                "cleanup_active_state",
                "is_enabled",
            ]
        );
    }

    #[tokio::test]
    async fn stop_cleanup_escalates_when_successful_stop_leaves_state_active_like() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps {
            cleanup_states: VecDeque::from([
                cleanup_state("deactivating", true),
                cleanup_state("inactive", false),
            ]),
            ..FakeStopOps::default()
        };

        stop_with_ops(
            &unit,
            &home,
            true,
            Some(CleanupPolicy::PartialStart),
            &mut ops,
        )
        .await
        .unwrap();

        assert_eq!(
            ops.events,
            [
                "acquire_cleanup_lock",
                "stop_bounded",
                "cleanup_active_state",
                "kill_all_sigkill",
                "stop_no_block",
                "reset_failed_bounded",
                "cleanup_drain_restart_override_bounded",
                "cleanup_active_state",
            ]
        );
    }

    #[tokio::test]
    async fn stop_cleanup_verify_retries_transient_state_read_error() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps {
            cleanup_states: VecDeque::from([
                cleanup_state("inactive", false),
                Err(fake_error("systemd show unavailable")),
                cleanup_state("inactive", false),
            ]),
            ..FakeStopOps::default()
        };

        stop_with_ops(
            &unit,
            &home,
            true,
            Some(CleanupPolicy::PartialStart),
            &mut ops,
        )
        .await
        .unwrap();

        assert_eq!(
            ops.events,
            [
                "acquire_cleanup_lock",
                "stop_bounded",
                "cleanup_active_state",
                "reset_failed_bounded",
                "cleanup_drain_restart_override_bounded",
                "cleanup_active_state",
                "sleep",
                "cleanup_active_state",
            ]
        );
    }

    #[tokio::test]
    async fn stop_cleanup_verify_escalates_after_initial_state_read_error() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps {
            cleanup_states: VecDeque::from([
                Err(fake_error("systemd show unavailable")),
                cleanup_state("deactivating", true),
                cleanup_state("inactive", false),
            ]),
            ..FakeStopOps::default()
        };

        stop_with_ops(
            &unit,
            &home,
            true,
            Some(CleanupPolicy::PartialStart),
            &mut ops,
        )
        .await
        .unwrap();

        assert_eq!(
            ops.events,
            [
                "acquire_cleanup_lock",
                "stop_bounded",
                "cleanup_active_state",
                "reset_failed_bounded",
                "cleanup_drain_restart_override_bounded",
                "cleanup_active_state",
                "kill_all_sigkill",
                "stop_no_block",
                "sleep",
                "cleanup_active_state",
            ]
        );
    }

    #[tokio::test]
    async fn stop_cleanup_does_not_escalate_when_failed_stop_left_unit_inactive() {
        use std::os::unix::process::ExitStatusExt;

        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps {
            bounded_stop_results: VecDeque::from([Ok(BoundedSystemctlOutcome::Failed(
                std::process::ExitStatus::from_raw(0x100),
            ))]),
            cleanup_states: VecDeque::from([
                cleanup_state("inactive", false),
                cleanup_state("inactive", false),
            ]),
            ..FakeStopOps::default()
        };

        stop_with_ops(
            &unit,
            &home,
            true,
            Some(CleanupPolicy::PartialStart),
            &mut ops,
        )
        .await
        .unwrap();

        assert_eq!(
            ops.events,
            [
                "acquire_cleanup_lock",
                "stop_bounded",
                "cleanup_active_state",
                "reset_failed_bounded",
                "cleanup_drain_restart_override_bounded",
                "cleanup_active_state",
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn stop_cleanup_verify_timeout_fails_when_unit_stays_active_like() {
        let unit = service_unit();
        let home = fake_home();
        let active_states = std::iter::repeat_with(|| cleanup_state("active", true))
            .take(16)
            .collect();
        let mut ops = FakeStopOps {
            cleanup_states: active_states,
            advance_time_on_sleep: true,
            ..FakeStopOps::default()
        };

        let err = stop_with_ops(
            &unit,
            &home,
            true,
            Some(CleanupPolicy::PartialStart),
            &mut ops,
        )
        .await
        .unwrap_err();

        assert!(err.to_string().contains("ActiveState=active"));
        assert!(ops.events.contains(&"sleep"));
    }

    #[tokio::test]
    async fn stop_cleanup_lock_failure_returns_before_systemctl() {
        let unit = service_unit();
        let home = fake_home();
        let mut ops = FakeStopOps {
            acquire_lock_error: true,
            ..FakeStopOps::default()
        };

        let err = stop_with_ops(
            &unit,
            &home,
            true,
            Some(CleanupPolicy::PartialStart),
            &mut ops,
        )
        .await
        .unwrap_err();

        assert!(err.to_string().contains("lock busy"));
        assert_eq!(ops.events, ["acquire_cleanup_lock"]);
    }
});
