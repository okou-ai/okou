use std::process::ExitStatus;
use std::time::Duration;

use tokio::time::Instant;

use crate::error::{RunnerError, RunnerResult};

use super::diagnostic::status_field_preview;
use super::systemctl::{
    has_service_main_process, has_service_main_process_bounded, run_systemctl_output_bounded,
};
use super::target::RunnerServiceUnit;

/// Outcome of asking systemd to signal a unit's main process.
///
/// `AlreadyGone` means the delivery command failed and a follow-up systemd
/// query proved that the unit no longer has a main process. Callers retain
/// their distinct policies for that race: drain continues boot-enablement
/// cleanup, while resume rejects an inactive runner.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ServiceSignalOutcome {
    Sent,
    AlreadyGone,
}

/// Ask systemd to send `signal` to the current main process of `unit`.
///
/// Systemd owns the unit's process identity, so resolving and signaling the
/// target inside the manager avoids a caller-side numeric PID reuse race.
pub(super) async fn signal_service_main(
    unit: &RunnerServiceUnit,
    signal: nix::sys::signal::Signal,
) -> RunnerResult<ServiceSignalOutcome> {
    let signal_arg = format!("--signal={}", signal.as_str());
    let output = tokio::process::Command::new("systemctl")
        .args([
            "kill",
            "--kill-whom=main",
            signal_arg.as_str(),
            unit.service_name(),
        ])
        .output()
        .await
        .map_err(|e| {
            RunnerError::Internal(format!(
                "spawn systemctl kill for {}: {e}",
                unit.service_name()
            ))
        })?;

    if output.status.success() {
        return Ok(ServiceSignalOutcome::Sent);
    }

    let signal_error = systemctl_kill_error(unit, signal, output.status, &output.stderr);
    match has_service_main_process(unit).await {
        Ok(false) => Ok(ServiceSignalOutcome::AlreadyGone),
        Ok(true) | Err(_) => Err(signal_error),
    }
}

/// Ask systemd to signal the current main process within a cleanup deadline.
///
/// Unlike an outer future timeout, the bounded command path kills and reaps a
/// timed-out `systemctl` child before returning.
pub(super) async fn signal_service_main_bounded(
    unit: &RunnerServiceUnit,
    signal: nix::sys::signal::Signal,
    duration: Duration,
) -> RunnerResult<ServiceSignalOutcome> {
    let deadline = Instant::now() + duration;
    let signal_arg = format!("--signal={}", signal.as_str());
    let output = run_systemctl_output_bounded(
        &[
            "kill",
            "--kill-whom=main",
            signal_arg.as_str(),
            unit.service_name(),
        ],
        duration,
    )
    .await
    .map_err(|error| {
        RunnerError::Internal(format!(
            "signal {} with systemctl for {}: {error}",
            signal.as_str(),
            unit.service_name()
        ))
    })?;

    if output.status.success() {
        return Ok(ServiceSignalOutcome::Sent);
    }

    let signal_error = systemctl_kill_error(unit, signal, output.status, &output.stderr);
    let now = Instant::now();
    if now >= deadline {
        return Err(signal_error);
    }
    match has_service_main_process_bounded(unit, deadline - now).await {
        Ok(false) => Ok(ServiceSignalOutcome::AlreadyGone),
        Ok(true) | Err(_) => Err(signal_error),
    }
}

fn systemctl_kill_error(
    unit: &RunnerServiceUnit,
    signal: nix::sys::signal::Signal,
    status: ExitStatus,
    stderr: &[u8],
) -> RunnerError {
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    let command = format!(
        "systemctl kill --kill-whom=main --signal={} {}",
        signal.as_str(),
        unit.service_name()
    );
    if stderr.is_empty() {
        RunnerError::Internal(format!("{command} exited with {status}"))
    } else {
        RunnerError::Internal(format!(
            "{command} exited with {status}: stderr={:?}",
            status_field_preview(stderr)
        ))
    }
}

runner_test_group!(cmd_service; #[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::time::Duration;

    use super::*;
    use crate::test_fixtures::ignored_child::{
        ignored_child_test_env_guard_enabled, run_ignored_child_test,
    };

    const SCENARIO_ENV: &str = "OKOU_RUN_SERVICE_SIGNAL_SCENARIO";
    const SIGNAL_ENV: &str = "OKOU_RUN_SERVICE_SIGNAL_NAME";
    const INVOCATIONS_ENV: &str = "OKOU_RUN_SERVICE_SIGNAL_INVOCATIONS";
    const CHILD_TEST: &str = "cmd::service::signal::tests::signal_service_main_systemctl_child";
    const BOUNDED_OUTCOME_SCENARIO_BUDGET: Duration = Duration::from_secs(5);
    const BOUNDED_TIMEOUT_SCENARIO_BUDGET: Duration = Duration::from_millis(100);
    const FAKE_SYSTEMCTL: &str = r#"#!/bin/sh
printf '%s\n' "$*" >> "$OKOU_RUN_SERVICE_SIGNAL_INVOCATIONS"

if [ "$1" = "kill" ]; then
  case "$OKOU_RUN_SERVICE_SIGNAL_SCENARIO" in
    success-*|bounded-success) exit 0 ;;
    bounded-timeout) while :; do :; done ;;
    absent|bounded-absent|live|recheck-failed)
      printf '%s\n' 'signal delivery failed' >&2
      exit 1
      ;;
  esac
fi

if [ "$1" = "show" ]; then
  case "$OKOU_RUN_SERVICE_SIGNAL_SCENARIO" in
    absent|bounded-absent)
      printf '%s\n' 'LoadState=loaded' 'MainPID=0'
      exit 0
      ;;
    live)
      printf '%s\n' 'LoadState=loaded' 'MainPID=123'
      exit 0
      ;;
    recheck-failed)
      printf '%s\n' 'state lookup failed' >&2
      exit 1
      ;;
  esac
fi

printf '%s\n' "unexpected fake systemctl invocation: $*" >&2
exit 2
"#;

    #[tokio::test]
    async fn signal_service_main_uses_systemd_main_scope_for_both_signals() {
        for (scenario, signal) in [
            ("success-sigusr1", nix::sys::signal::Signal::SIGUSR1),
            ("success-sigusr2", nix::sys::signal::Signal::SIGUSR2),
        ] {
            let invocations = run_signal_scenario(scenario, signal).await;

            assert_eq!(invocations, vec![expected_kill_invocation(signal)]);
        }
    }

    #[tokio::test]
    async fn signal_service_main_returns_already_gone_when_recheck_proves_absence() {
        let signal = nix::sys::signal::Signal::SIGUSR1;
        let invocations = run_signal_scenario("absent", signal).await;

        assert_eq!(
            invocations,
            vec![expected_kill_invocation(signal), expected_show_invocation()]
        );
    }

    #[tokio::test]
    async fn signal_service_main_preserves_failure_when_main_process_is_present() {
        let signal = nix::sys::signal::Signal::SIGUSR2;
        let invocations = run_signal_scenario("live", signal).await;

        assert_eq!(
            invocations,
            vec![expected_kill_invocation(signal), expected_show_invocation()]
        );
    }

    #[tokio::test]
    async fn signal_service_main_preserves_failure_when_recheck_fails() {
        let signal = nix::sys::signal::Signal::SIGUSR1;
        let invocations = run_signal_scenario("recheck-failed", signal).await;

        assert_eq!(
            invocations,
            vec![expected_kill_invocation(signal), expected_show_invocation()]
        );
    }

    #[tokio::test]
    async fn signal_service_main_bounded_times_out_systemctl() {
        let signal = nix::sys::signal::Signal::SIGUSR1;
        let invocations = run_signal_scenario("bounded-timeout", signal).await;

        assert_eq!(invocations, vec![expected_kill_invocation(signal)]);
    }

    #[tokio::test]
    async fn signal_service_main_bounded_preserves_signal_outcomes() {
        let signal = nix::sys::signal::Signal::SIGUSR1;

        let sent_invocations = run_signal_scenario("bounded-success", signal).await;
        assert_eq!(sent_invocations, vec![expected_kill_invocation(signal)]);

        let gone_invocations = run_signal_scenario("bounded-absent", signal).await;
        assert_eq!(
            gone_invocations,
            vec![expected_kill_invocation(signal), expected_show_invocation()]
        );
    }

    async fn run_signal_scenario(scenario: &str, signal: nix::sys::signal::Signal) -> Vec<String> {
        let dir = tempfile::tempdir().unwrap();
        let fake_systemctl = dir.path().join("systemctl");
        std::fs::write(&fake_systemctl, FAKE_SYSTEMCTL).unwrap();
        let mut permissions = std::fs::metadata(&fake_systemctl).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&fake_systemctl, permissions).unwrap();

        let invocations_path = dir.path().join("invocations");
        let path = utf8_path(dir.path());
        let invocations = utf8_path(&invocations_path);
        run_ignored_child_test(
            CHILD_TEST,
            (SCENARIO_ENV, scenario),
            &[
                ("PATH", Some(path)),
                (SIGNAL_ENV, Some(signal.as_str())),
                (INVOCATIONS_ENV, Some(invocations)),
            ],
            Duration::from_secs(10),
        )
        .await;

        std::fs::read_to_string(invocations_path)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn utf8_path(path: &Path) -> &str {
        path.to_str().expect("temporary path must be UTF-8")
    }

    fn expected_kill_invocation(signal: nix::sys::signal::Signal) -> String {
        format!(
            "kill --kill-whom=main --signal={} vm0-runner-test.service",
            signal.as_str()
        )
    }

    fn expected_show_invocation() -> String {
        "show vm0-runner-test.service --property=LoadState --property=MainPID".to_string()
    }

    #[tokio::test]
    #[ignore = "spawned by signal service main systemctl tests"]
    async fn signal_service_main_systemctl_child() {
        let Ok(scenario) = std::env::var(SCENARIO_ENV) else {
            return;
        };
        if !ignored_child_test_env_guard_enabled((SCENARIO_ENV, &scenario)) {
            return;
        }

        let signal = match std::env::var(SIGNAL_ENV).as_deref() {
            Ok("SIGUSR1") => nix::sys::signal::Signal::SIGUSR1,
            Ok("SIGUSR2") => nix::sys::signal::Signal::SIGUSR2,
            value => panic!("unexpected signal scenario value: {value:?}"),
        };
        let unit = RunnerServiceUnit::from_suffix("test").unwrap();
        let result = match scenario.as_str() {
            "bounded-success" | "bounded-absent" => {
                signal_service_main_bounded(&unit, signal, BOUNDED_OUTCOME_SCENARIO_BUDGET).await
            }
            "bounded-timeout" => {
                signal_service_main_bounded(&unit, signal, BOUNDED_TIMEOUT_SCENARIO_BUDGET).await
            }
            _ => signal_service_main(&unit, signal).await,
        };

        match scenario.as_str() {
            "success-sigusr1" | "success-sigusr2" => {
                assert_eq!(result.unwrap(), ServiceSignalOutcome::Sent);
            }
            "bounded-success" => {
                assert_eq!(result.unwrap(), ServiceSignalOutcome::Sent);
            }
            "absent" | "bounded-absent" => {
                assert_eq!(result.unwrap(), ServiceSignalOutcome::AlreadyGone);
            }
            "live" | "recheck-failed" => {
                let error = result.unwrap_err().to_string();
                assert!(
                    error.contains("signal delivery failed"),
                    "unexpected error: {error}"
                );
                assert!(
                    !error.contains("state lookup failed"),
                    "recheck error replaced original failure: {error}"
                );
            }
            "bounded-timeout" => {
                let error = result.unwrap_err().to_string();
                assert!(
                    error.contains(&format!(
                        "systemctl timed out after {}ms",
                        BOUNDED_TIMEOUT_SCENARIO_BUDGET.as_millis()
                    )),
                    "unexpected error: {error}"
                );
            }
            unexpected => panic!("unexpected service signal scenario: {unexpected}"),
        }
    }
});
