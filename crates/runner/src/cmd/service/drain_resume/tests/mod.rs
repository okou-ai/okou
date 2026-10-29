use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use super::super::drain_override::{
    remove_drain_restart_override_at, write_drain_restart_override_at,
};
use super::*;
use runner_host::service::test_support;

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
    Ok(test_support::cleanup_unit_active_state(
        active_state,
        active_like,
    ))
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
    restart_override_removal: DrainRestartOverrideRemoval,
    systemd_root: Option<PathBuf>,
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
            restart_override_removal: DrainRestartOverrideRemoval::OverrideRemoved,
            systemd_root: None,
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

    fn restart_policy<'a>(&'a mut self, _unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, String> {
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

    fn write_restart_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<()> {
        self.events.push("write_restart_override");
        if self.write_error {
            Err(fake_error("write failed"))
        } else if let Some(root) = &self.systemd_root {
            write_drain_restart_override_at(root, unit).map(|_| ())
        } else {
            Ok(())
        }
    }

    fn remove_restart_override(
        &mut self,
        unit: &RunnerServiceUnit,
    ) -> RunnerResult<DrainRestartOverrideRemoval> {
        self.events.push("remove_restart_override");
        if self.remove_error {
            Err(fake_error("remove failed"))
        } else if let Some(root) = &self.systemd_root {
            remove_drain_restart_override_at(root, unit)
        } else {
            Ok(self.restart_override_removal)
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
        message
            .contains("failed to roll back drain transition for vm0-runner-test (daemon_reload)")
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
        message
            .contains("failed to roll back resume transition for vm0-runner-test (daemon_reload)")
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

#[derive(Clone, Copy, Debug)]
enum ResumeFailure {
    Reload,
    Signal,
    Acknowledgement,
}

async fn assert_resume_failure_preserves_filesystem_override_ownership(failure: ResumeFailure) {
    for initial_state in [
        DrainRestartOverrideRemoval::DirectoryRemoved,
        DrainRestartOverrideRemoval::AlreadyAbsent,
        DrainRestartOverrideRemoval::OverrideRemoved,
    ] {
        let (dir, home, config_path, base_dir, _handle) = setup_drain_target("draining").await;
        let unit = service_unit();
        let systemd_root = dir.path().join("systemd");
        let drop_in_dir = systemd_root.join(format!("{}.d", unit.service_name()));
        let override_path = drop_in_dir.join("50-vm0-drain.conf");
        match initial_state {
            DrainRestartOverrideRemoval::DirectoryRemoved => {
                std::fs::create_dir_all(&drop_in_dir).unwrap();
            }
            DrainRestartOverrideRemoval::AlreadyAbsent => {}
            DrainRestartOverrideRemoval::OverrideRemoved => {
                write_drain_restart_override_at(&systemd_root, &unit).unwrap();
            }
        }
        let acknowledgement_mode = if matches!(failure, ResumeFailure::Acknowledgement) {
            "stopping"
        } else {
            "running"
        };
        let mut ops = FakeResumeOps {
            active_results: active_results(2),
            config_path: Some(config_path),
            enablement_results: VecDeque::from([Ok(SystemdUnitEnablement::EnabledRuntime)]),
            systemd_root: Some(systemd_root),
            reload_errors: VecDeque::from([matches!(failure, ResumeFailure::Reload), false]),
            signal_error: matches!(failure, ResumeFailure::Signal),
            status_update_on_signal: Some((
                base_dir.join("status.json"),
                test_status_content(acknowledgement_mode, TEST_RUNNER_STARTED_AT),
            )),
            ..FakeResumeOps::default()
        };

        let error = resume_with_ops(&unit, &home, &mut ops).await.unwrap_err();

        let expected_error = match failure {
            ResumeFailure::Reload => "reload failed",
            ResumeFailure::Signal => "signal failed",
            ResumeFailure::Acknowledgement => "entered mode=stopping before acknowledging resume",
        };
        assert!(error.to_string().contains(expected_error), "{error}");
        if initial_state.override_removed() {
            assert_eq!(
                std::fs::read_to_string(&override_path).unwrap(),
                "[Service]\nRestart=no\n"
            );
        } else {
            assert!(
                !override_path.exists(),
                "{failure:?} recreated an initially absent override after {initial_state:?}"
            );
            assert!(!drop_in_dir.exists());
        }
        assert!(ops.events.contains(&"restore_enabled_runtime"));
        assert_eq!(
            ops.reload_requirements,
            [
                SystemdReloadRequirement::dirty().with_drain_override(false),
                if initial_state.override_removed() {
                    SystemdReloadRequirement::dirty().with_drain_override(true)
                } else {
                    SystemdReloadRequirement::dirty()
                },
            ],
            "{failure:?} after {initial_state:?}"
        );
    }
}

#[tokio::test]
async fn resume_reload_failure_preserves_filesystem_override_ownership() {
    assert_resume_failure_preserves_filesystem_override_ownership(ResumeFailure::Reload).await;
}

#[tokio::test]
async fn resume_signal_failure_preserves_filesystem_override_ownership() {
    assert_resume_failure_preserves_filesystem_override_ownership(ResumeFailure::Signal).await;
}

#[tokio::test]
async fn resume_acknowledgement_failure_preserves_filesystem_override_ownership() {
    assert_resume_failure_preserves_filesystem_override_ownership(ResumeFailure::Acknowledgement)
        .await;
}

#[tokio::test]
async fn resume_after_directory_only_cleanup_reloads_and_acknowledges() {
    let (dir, home, config_path, base_dir, _handle) = setup_drain_target("draining").await;
    let unit = service_unit();
    let systemd_root = dir.path().join("systemd");
    let drop_in_dir = systemd_root.join(format!("{}.d", unit.service_name()));
    std::fs::create_dir_all(&drop_in_dir).unwrap();
    let mut ops = FakeResumeOps {
        active_results: active_results(2),
        config_path: Some(config_path),
        systemd_root: Some(systemd_root),
        status_update_on_signal: Some((
            base_dir.join("status.json"),
            test_status_content("running", TEST_RUNNER_STARTED_AT),
        )),
        ..FakeResumeOps::default()
    };

    resume_with_ops(&unit, &home, &mut ops).await.unwrap();

    assert!(!drop_in_dir.exists());
    assert_eq!(read_runner_status(&base_dir).await.unwrap().mode, "running");
    assert_eq!(
        ops.reload_requirements,
        [SystemdReloadRequirement::dirty().with_drain_override(false)]
    );
}

#[tokio::test]
async fn resume_failure_without_override_restores_only_enablement() {
    let mut ops = FakeResumeOps {
        restart_override_removal: DrainRestartOverrideRemoval::AlreadyAbsent,
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
