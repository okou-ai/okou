use std::time::Duration;

use tracing::{info, warn};

use crate::error::{RunnerError, RunnerResult};
use runner_host::paths::HomePaths;

use super::drain_override::drain_restart_override_path;
use super::{RunnerServiceUnit, ServiceFuture};
use runner_host::service::{
    BoundedSystemctlOutcome, SystemdReloadState, read_systemd_reload_state,
    read_systemd_reload_state_bounded, run_systemctl, run_systemctl_bounded,
};

/// Reload-specific wait policy, shared by forward and compensating transitions.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum SystemdReloadPolicy {
    Unbounded,
    Bounded {
        lock_timeout: Duration,
        command_timeout: Duration,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct SystemdReloadRequirement {
    reload_if_not_found: bool,
    expected_drain_override: Option<bool>,
}

impl SystemdReloadRequirement {
    pub(super) const fn dirty() -> Self {
        Self {
            reload_if_not_found: false,
            expected_drain_override: None,
        }
    }

    pub(super) const fn dirty_or_not_found() -> Self {
        Self {
            reload_if_not_found: true,
            expected_drain_override: None,
        }
    }

    pub(super) const fn with_drain_override(mut self, expected_present: bool) -> Self {
        self.expected_drain_override = Some(expected_present);
        self
    }

    fn requires_reload(self, unit: &RunnerServiceUnit, state: &SystemdReloadState) -> bool {
        state.need_daemon_reload()
            || self.reload_if_not_found && state.is_not_found()
            || self.expected_drain_override.is_some_and(|expected| {
                state.has_drop_in_path(&drain_restart_override_path(unit)) != expected
            })
    }
}

trait SystemdReloadOps {
    fn read_state<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, SystemdReloadState>;
    fn daemon_reload(&mut self) -> ServiceFuture<'_, ()>;
}

struct RealSystemdReloadOps {
    command_timeout: Option<Duration>,
}

impl SystemdReloadOps for RealSystemdReloadOps {
    fn read_state<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, SystemdReloadState> {
        Box::pin(async move {
            match self.command_timeout {
                Some(duration) => read_systemd_reload_state_bounded(unit, duration)
                    .await
                    .map_err(Into::into),
                None => read_systemd_reload_state(unit).await.map_err(Into::into),
            }
        })
    }

    fn daemon_reload(&mut self) -> ServiceFuture<'_, ()> {
        Box::pin(async move {
            match self.command_timeout {
                Some(duration) => {
                    match run_systemctl_bounded(&["daemon-reload"], duration).await? {
                        BoundedSystemctlOutcome::Success => Ok(()),
                        BoundedSystemctlOutcome::Failed(status) => Err(RunnerError::Internal(
                            format!("systemctl daemon-reload exited with {status} during cleanup"),
                        )),
                        BoundedSystemctlOutcome::TimedOut => Err(RunnerError::Internal(format!(
                            "systemctl daemon-reload timed out after {}s during cleanup",
                            duration.as_secs()
                        ))),
                    }
                }
                None => run_systemctl(&["daemon-reload"]).await.map_err(Into::into),
            }
        })
    }
}

async fn acquire_systemd_reload_lock(
    home: &HomePaths,
    unit: &RunnerServiceUnit,
    lock_timeout: Option<Duration>,
) -> RunnerResult<nix::fcntl::Flock<std::fs::File>> {
    let path = home.systemd_daemon_reload_lock();
    Ok(match lock_timeout {
        Some(duration) => tokio::time::timeout(duration, runner_host::lock::acquire(path))
            .await
            .map_err(|_| {
                RunnerError::Internal(format!(
                    "timed out waiting {}s for systemd daemon-reload lock while updating {}",
                    duration.as_secs(),
                    unit.unit_name()
                ))
            })??,
        None => runner_host::lock::acquire(path).await?,
    })
}

async fn coordinate_systemd_reload_with_ops(
    unit: &RunnerServiceUnit,
    home: &HomePaths,
    requirement: SystemdReloadRequirement,
    lock_timeout: Option<Duration>,
    ops: &mut impl SystemdReloadOps,
) -> RunnerResult<bool> {
    let _reload_lock = acquire_systemd_reload_lock(home, unit, lock_timeout).await?;

    let should_reload = match ops.read_state(unit).await {
        Ok(state) => requirement.requires_reload(unit, &state),
        Err(error) => {
            warn!(
                unit = %unit.unit_name(),
                error = %error,
                "failed to read systemd reload state; falling back to daemon-reload"
            );
            true
        }
    };

    if !should_reload {
        return Ok(false);
    }

    ops.daemon_reload().await?;
    info!(unit = %unit.unit_name(), "systemd daemon reloaded");
    Ok(true)
}

pub(super) async fn coordinate_systemd_reload(
    unit: &RunnerServiceUnit,
    requirement: SystemdReloadRequirement,
    policy: SystemdReloadPolicy,
) -> RunnerResult<bool> {
    let home = HomePaths::new()?;
    let (lock_timeout, command_timeout) = match policy {
        SystemdReloadPolicy::Unbounded => (None, None),
        SystemdReloadPolicy::Bounded {
            lock_timeout,
            command_timeout,
        } => (Some(lock_timeout), Some(command_timeout)),
    };
    coordinate_systemd_reload_with_ops(
        unit,
        &home,
        requirement,
        lock_timeout,
        &mut RealSystemdReloadOps { command_timeout },
    )
    .await
}

#[cfg(test)]
mod tests;
