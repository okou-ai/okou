use std::time::Duration;

use tracing::{info, warn};

use crate::error::{RunnerError, RunnerResult};
use runner_host::paths::HomePaths;

use super::drain_override::drain_restart_override_path;
use super::systemctl::{
    BoundedSystemctlOutcome, SystemdReloadState, read_systemd_reload_state,
    read_systemd_reload_state_bounded, run_systemctl, run_systemctl_bounded,
};
use super::{RunnerServiceUnit, ServiceFuture};

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
                Some(duration) => read_systemd_reload_state_bounded(unit, duration).await,
                None => read_systemd_reload_state(unit).await,
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
                None => run_systemctl(&["daemon-reload"]).await,
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
) -> RunnerResult<bool> {
    let home = HomePaths::new()?;
    coordinate_systemd_reload_with_ops(
        unit,
        &home,
        requirement,
        None,
        &mut RealSystemdReloadOps {
            command_timeout: None,
        },
    )
    .await
}

pub(super) async fn coordinate_systemd_reload_bounded(
    unit: &RunnerServiceUnit,
    requirement: SystemdReloadRequirement,
    lock_timeout: Duration,
    command_timeout: Duration,
) -> RunnerResult<bool> {
    let home = HomePaths::new()?;
    coordinate_systemd_reload_with_ops(
        unit,
        &home,
        requirement,
        Some(lock_timeout),
        &mut RealSystemdReloadOps {
            command_timeout: Some(command_timeout),
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::future::Future as _;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;

    #[derive(Clone)]
    struct OperationGate {
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }

    #[derive(Clone)]
    struct FakeSystemdReloadOps {
        dirty: Arc<AtomicBool>,
        drain_override_loaded: bool,
        query_error: bool,
        read_count: Arc<AtomicUsize>,
        read_gate: Option<OperationGate>,
        reload_count: Arc<AtomicUsize>,
        reload_gate: Option<OperationGate>,
    }

    impl SystemdReloadOps for FakeSystemdReloadOps {
        fn read_state<'a>(
            &'a mut self,
            unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, SystemdReloadState> {
            let dirty = Arc::clone(&self.dirty);
            let drain_override_loaded = self.drain_override_loaded;
            let query_error = self.query_error;
            let read_count = Arc::clone(&self.read_count);
            let read_gate = self.read_gate.clone();
            Box::pin(async move {
                if let Some(gate) = read_gate {
                    gate.entered.notify_one();
                    gate.release.notified().await;
                }
                read_count.fetch_add(1, Ordering::SeqCst);
                if query_error {
                    Err(RunnerError::Internal("query failed".to_string()))
                } else {
                    Ok(SystemdReloadState::for_test(
                        false,
                        dirty.load(Ordering::SeqCst),
                        if drain_override_loaded {
                            vec![
                                drain_restart_override_path(unit)
                                    .to_string_lossy()
                                    .into_owned(),
                            ]
                        } else {
                            Vec::new()
                        },
                    ))
                }
            })
        }

        fn daemon_reload(&mut self) -> ServiceFuture<'_, ()> {
            let dirty = Arc::clone(&self.dirty);
            let reload_count = Arc::clone(&self.reload_count);
            let reload_gate = self.reload_gate.clone();
            Box::pin(async move {
                if let Some(gate) = reload_gate {
                    gate.entered.notify_one();
                    gate.release.notified().await;
                }
                reload_count.fetch_add(1, Ordering::SeqCst);
                dirty.store(false, Ordering::SeqCst);
                Ok(())
            })
        }
    }

    fn fake_ops(dirty: bool) -> FakeSystemdReloadOps {
        FakeSystemdReloadOps {
            dirty: Arc::new(AtomicBool::new(dirty)),
            drain_override_loaded: false,
            query_error: false,
            read_count: Arc::new(AtomicUsize::new(0)),
            read_gate: None,
            reload_count: Arc::new(AtomicUsize::new(0)),
            reload_gate: None,
        }
    }

    #[test]
    fn install_requires_reload_for_not_found_unit() {
        let unit = RunnerServiceUnit::from_suffix("test").unwrap();
        let state = SystemdReloadState::for_test(true, false, Vec::new());

        assert!(
            SystemdReloadRequirement::dirty_or_not_found().requires_reload(&unit, &state),
            "a newly written unit must be loaded before start"
        );
        assert!(!SystemdReloadRequirement::dirty().requires_reload(&unit, &state));
    }

    #[test]
    fn drain_override_state_requires_reload_when_systemd_dirty_flag_misses_change() {
        let unit = RunnerServiceUnit::from_suffix("test").unwrap();
        let absent = SystemdReloadState::for_test(false, false, Vec::new());
        let present = SystemdReloadState::for_test(
            false,
            false,
            vec![
                drain_restart_override_path(&unit)
                    .to_string_lossy()
                    .into_owned(),
            ],
        );

        assert!(
            SystemdReloadRequirement::dirty()
                .with_drain_override(true)
                .requires_reload(&unit, &absent)
        );
        assert!(
            !SystemdReloadRequirement::dirty()
                .with_drain_override(true)
                .requires_reload(&unit, &present)
        );
        assert!(
            SystemdReloadRequirement::dirty()
                .with_drain_override(false)
                .requires_reload(&unit, &present)
        );
        assert!(
            !SystemdReloadRequirement::dirty()
                .with_drain_override(false)
                .requires_reload(&unit, &absent)
        );
    }

    #[tokio::test]
    async fn query_failure_falls_back_to_daemon_reload() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let unit = RunnerServiceUnit::from_suffix("test").unwrap();
        let mut ops = fake_ops(false);
        ops.query_error = true;

        assert!(
            coordinate_systemd_reload_with_ops(
                &unit,
                &home,
                SystemdReloadRequirement::dirty(),
                None,
                &mut ops,
            )
            .await
            .unwrap()
        );
        assert_eq!(ops.reload_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn stale_loaded_drain_override_reloads_with_bounded_and_unbounded_lock_modes() {
        for lock_timeout in [None, Some(Duration::from_secs(1))] {
            let dir = tempfile::tempdir().unwrap();
            let home = HomePaths::with_root(dir.path().join("home"));
            let unit = RunnerServiceUnit::from_suffix("test").unwrap();
            let mut ops = fake_ops(false);
            ops.drain_override_loaded = true;

            assert!(
                coordinate_systemd_reload_with_ops(
                    &unit,
                    &home,
                    SystemdReloadRequirement::dirty().with_drain_override(false),
                    lock_timeout,
                    &mut ops,
                )
                .await
                .unwrap()
            );
            assert_eq!(ops.reload_count.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn different_units_coalesce_one_dirty_generation_under_real_flock() {
        const RENDEZVOUS_TIMEOUT: Duration = Duration::from_secs(5);

        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let unit_a = RunnerServiceUnit::from_suffix("reload-a").unwrap();
        let unit_b = RunnerServiceUnit::from_suffix("reload-b").unwrap();
        let ops = fake_ops(true);
        let mut ops_a = ops.clone();
        let mut ops_b = ops.clone();
        let read_entered = Arc::new(tokio::sync::Notify::new());
        let read_release = Arc::new(tokio::sync::Notify::new());
        let reload_entered = Arc::new(tokio::sync::Notify::new());
        let reload_release = Arc::new(tokio::sync::Notify::new());
        ops_a.read_gate = Some(OperationGate {
            entered: Arc::clone(&read_entered),
            release: Arc::clone(&read_release),
        });
        ops_a.reload_gate = Some(OperationGate {
            entered: Arc::clone(&reload_entered),
            release: Arc::clone(&reload_release),
        });
        let (follower_start_tx, follower_start_rx) = tokio::sync::oneshot::channel();
        let (follower_pending_tx, follower_pending_rx) = tokio::sync::oneshot::channel();
        let read_count = Arc::clone(&ops.read_count);
        let reload_count = Arc::clone(&ops.reload_count);

        let (leader_result, follower_result, ()) =
            tokio::time::timeout(RENDEZVOUS_TIMEOUT, async {
                tokio::join!(
                    coordinate_systemd_reload_with_ops(
                        &unit_a,
                        &home,
                        SystemdReloadRequirement::dirty(),
                        None,
                        &mut ops_a,
                    ),
                    async {
                        follower_start_rx
                            .await
                            .expect("follower start signal should be sent");
                        let follower = coordinate_systemd_reload_with_ops(
                            &unit_b,
                            &home,
                            SystemdReloadRequirement::dirty(),
                            None,
                            &mut ops_b,
                        );
                        tokio::pin!(follower);
                        let mut follower_pending_tx = Some(follower_pending_tx);
                        std::future::poll_fn(|context| {
                            let result = follower.as_mut().poll(context);
                            if result.is_pending()
                                && let Some(follower_pending_tx) = follower_pending_tx.take()
                            {
                                follower_pending_tx
                                    .send(())
                                    .expect("follower pending signal should be received");
                            }
                            result
                        })
                        .await
                    },
                    async {
                        read_entered.notified().await;
                        assert!(
                            matches!(
                                runner_host::lock::try_acquire_or_busy(
                                    home.systemd_daemon_reload_lock()
                                )
                                .await
                                .unwrap(),
                                runner_host::lock::TryLock::Busy
                            ),
                            "leader must acquire the host-global lock before reading state"
                        );
                        assert_eq!(read_count.load(Ordering::SeqCst), 0);
                        read_release.notify_one();

                        reload_entered.notified().await;
                        assert!(
                            matches!(
                                runner_host::lock::try_acquire_or_busy(
                                    home.systemd_daemon_reload_lock()
                                )
                                .await
                                .unwrap(),
                                runner_host::lock::TryLock::Busy
                            ),
                            "leader must hold the host-global lock during daemon-reload"
                        );

                        follower_start_tx
                            .send(())
                            .expect("follower should wait for its start signal");
                        follower_pending_rx
                            .await
                            .expect("follower should become pending on the held lock");
                        // The busy probe proves the leader still owns the real flock;
                        // this pending poll proves the follower started before release.
                        assert_eq!(read_count.load(Ordering::SeqCst), 1);
                        assert_eq!(reload_count.load(Ordering::SeqCst), 0);
                        reload_release.notify_one();
                    },
                )
            })
            .await
            .expect("lock-sensitive reload rendezvous should complete");

        assert!(leader_result.unwrap());
        assert!(!follower_result.unwrap());
        assert_eq!(ops.read_count.load(Ordering::SeqCst), 2);
        assert_eq!(ops.reload_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn bounded_coordinator_times_out_waiting_for_global_lock() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let unit = RunnerServiceUnit::from_suffix("test").unwrap();
        let _holder = runner_host::lock::acquire(home.systemd_daemon_reload_lock())
            .await
            .unwrap();
        let mut ops = fake_ops(true);

        let error = coordinate_systemd_reload_with_ops(
            &unit,
            &home,
            SystemdReloadRequirement::dirty(),
            Some(Duration::from_secs(1)),
            &mut ops,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("systemd daemon-reload lock"));
        assert_eq!(ops.reload_count.load(Ordering::SeqCst), 0);
    }
}
