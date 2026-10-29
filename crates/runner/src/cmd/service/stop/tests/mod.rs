use std::collections::VecDeque;
use std::path::PathBuf;

use super::*;
use runner_host::service::test_support;

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
            cleanup_states: VecDeque::from([Ok(test_support::cleanup_unit_active_state(
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
    fn is_unit_active<'a>(&'a mut self, _unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, bool> {
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
                .unwrap_or(Ok(test_support::cleanup_unit_active_state(
                    "inactive", false,
                ))),
        ))
    }

    fn kill_all_sigkill<'a>(&'a mut self, _unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
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

fn cleanup_state(active_state: &str, active_like: bool) -> RunnerResult<CleanupUnitActiveState> {
    Ok(test_support::cleanup_unit_active_state(
        active_state,
        active_like,
    ))
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
