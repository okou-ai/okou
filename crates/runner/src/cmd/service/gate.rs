use std::path::{Path, PathBuf};

use crate::error::{ActiveJobsError, RunnerError, RunnerResult};
use crate::status_file::{self, StatusFileReadError, StatusForGate};
use runner_host::paths::HomePaths;
use runner_types::ids::RunId;
use tracing::info;

use super::diagnostic::status_field_preview;
use super::target::RunnerServiceUnit;
use super::{ServiceFuture, selected_config_base_dir};

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
mod tests {
    use std::collections::VecDeque;
    use std::os::unix::fs::PermissionsExt;
    use std::time::Duration;

    use super::*;
    use crate::test_fixtures::ignored_child::{
        ignored_child_test_env_guard_enabled, run_ignored_child_test,
    };

    const COMMENT_MARKER_ENV: &str = "OKOU_RUN_SERVICE_GATE_COMMENT_MARKER";
    const COMMENT_CONFIG_ENV: &str = "OKOU_RUN_SERVICE_GATE_COMMENT_CONFIG";
    const COMMENT_CHILD_TEST: &str =
        "cmd::service::gate::tests::commented_unit_active_jobs_gate_child";
    const COMMENT_SYSTEMCTL: &str = r#"#!/bin/sh
if [ "$1" = "show" ]; then
  printf '%s\n' 'LoadState=loaded' 'ActiveState=active'
  exit 0
fi
if [ "$1" = "--no-pager" ] && [ "$2" = "cat" ] && [ "$3" = "--" ]; then
  printf '%s\n' \
    '[Service]' \
    "$OKOU_RUN_SERVICE_GATE_COMMENT_MARKER runner config example \\" \
    "ExecStart=/usr/bin/runner start --config \"$OKOU_RUN_SERVICE_GATE_COMMENT_CONFIG\""
  exit 0
fi
printf '%s\n' "unexpected fake systemctl invocation: $*" >&2
exit 2
"#;

    struct FakeGateOps {
        active_results: VecDeque<RunnerResult<bool>>,
        config_results: VecDeque<RunnerResult<Option<PathBuf>>>,
        active_queries: usize,
        config_queries: usize,
    }

    impl FakeGateOps {
        fn from_results(results: impl IntoIterator<Item = RunnerResult<bool>>) -> Self {
            Self {
                active_results: results.into_iter().collect(),
                config_results: VecDeque::new(),
                active_queries: 0,
                config_queries: 0,
            }
        }

        fn with_config_path(mut self, config_path: Option<PathBuf>) -> Self {
            self.config_results.push_back(Ok(config_path));
            self
        }
    }

    impl ActiveJobsGateOps for FakeGateOps {
        fn is_unit_active<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, bool> {
            self.active_queries += 1;
            let result = self
                .active_results
                .pop_front()
                .expect("unexpected unit-active query");
            Box::pin(std::future::ready(result))
        }

        fn read_unit_config_path<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, Option<PathBuf>> {
            self.config_queries += 1;
            let result = self
                .config_results
                .pop_front()
                .expect("unexpected unit-config query");
            Box::pin(std::future::ready(result))
        }
    }

    fn service_unit() -> RunnerServiceUnit {
        RunnerServiceUnit::from_suffix("test").unwrap()
    }

    fn fake_home(dir: &tempfile::TempDir) -> HomePaths {
        HomePaths::with_root(dir.path().join("vm0-runner"))
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

    // -----------------------------------------------------------------
    // status.json reader
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn read_runner_status_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_runner_status(dir.path()).await.is_err());
    }

    #[tokio::test]
    async fn read_runner_status_empty_json() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("status.json"), "{}")
            .await
            .unwrap();
        // Missing required fields -> error.
        assert!(read_runner_status(dir.path()).await.is_err());
    }

    #[tokio::test]
    async fn read_runner_status_missing_active_runs_is_error() {
        let dir = tempfile::tempdir().unwrap();
        let s = r#"{"mode":"running","started_at":"2026-04-13T00:00:00.000Z"}"#;
        tokio::fs::write(dir.path().join("status.json"), s)
            .await
            .unwrap();

        assert!(read_runner_status(dir.path()).await.is_err());
    }

    #[tokio::test]
    async fn read_runner_status_invalid_run_id_is_error() {
        let dir = tempfile::tempdir().unwrap();
        let s = r#"{
            "mode":"running",
            "active_runs":[{"run_id":"not-a-uuid"}],
            "started_at":"2026-04-13T00:00:00.000Z"
        }"#;
        tokio::fs::write(dir.path().join("status.json"), s)
            .await
            .unwrap();

        assert!(read_runner_status(dir.path()).await.is_err());
    }

    #[tokio::test]
    async fn read_runner_status_malformed_started_at() {
        let dir = tempfile::tempdir().unwrap();
        let s = r#"{"mode":"running","active_runs":[],"started_at":"not-a-date"}"#;
        tokio::fs::write(dir.path().join("status.json"), s)
            .await
            .unwrap();
        assert!(read_runner_status(dir.path()).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn read_runner_status_rejects_status_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        std::fs::create_dir(&path).unwrap();

        assert!(read_runner_status(dir.path()).await.is_err());
    }

    #[tokio::test]
    async fn read_runner_status_malformed_long_started_at_error_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let started_at = "x".repeat(512);
        let s = format!(r#"{{"mode":"running","active_runs":[],"started_at":"{started_at}"}}"#);
        tokio::fs::write(dir.path().join("status.json"), s)
            .await
            .unwrap();

        let err = match read_runner_status(dir.path()).await {
            Ok(_) => panic!("expected malformed started_at to fail"),
            Err(err) => err,
        };
        let message = err.to_string();

        assert!(message.contains(&"x".repeat(128)));
        assert!(message.contains("...[truncated]"));
        assert!(!message.contains(&"x".repeat(129)));
    }

    #[tokio::test]
    async fn read_runner_status_running_no_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let s = r#"{"mode":"running","active_runs":[],"started_at":"2026-04-13T00:00:00.000Z"}"#;
        tokio::fs::write(dir.path().join("status.json"), s)
            .await
            .unwrap();
        let status = read_runner_status(dir.path()).await.unwrap();
        assert_eq!(status.mode, "running");
        assert!(status.run_ids.is_empty());
    }

    #[tokio::test]
    async fn read_runner_status_with_active_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let s = r#"{
            "mode":"running",
            "active_runs":[
                {"run_id":"0191c4e0-0000-7000-8000-000000000001","sandbox_id":"aaaaaaaa-0000-7000-8000-000000000001"},
                {"run_id":"0191c4e0-0000-7000-8000-000000000002","sandbox_id":"aaaaaaaa-0000-7000-8000-000000000002"}
            ],
            "started_at":"2026-04-13T00:00:00.000Z"
        }"#;
        tokio::fs::write(dir.path().join("status.json"), s)
            .await
            .unwrap();
        let status = read_runner_status(dir.path()).await.unwrap();
        assert_eq!(status.mode, "running");
        assert_eq!(status.run_ids.len(), 2);
    }

    #[tokio::test]
    async fn read_runner_status_draining_mode() {
        let dir = tempfile::tempdir().unwrap();
        let s = r#"{
            "mode":"draining",
            "active_runs":[
                {"run_id":"0191c4e0-0000-7000-8000-000000000001","sandbox_id":"aaaaaaaa-0000-7000-8000-000000000001"}
            ],
            "started_at":"2026-04-13T00:00:00.000Z"
        }"#;
        tokio::fs::write(dir.path().join("status.json"), s)
            .await
            .unwrap();
        let status = read_runner_status(dir.path()).await.unwrap();
        assert_eq!(status.mode, "draining");
        assert_eq!(status.run_ids.len(), 1);
    }

    #[tokio::test]
    async fn read_runner_status_full_runner_payload() {
        // Guard against schema drift: status.json written by StatusTracker
        // (crates/runner/src/status.rs) contains more fields than the ones
        // we care about. The decoder must tolerate the full payload.
        let dir = tempfile::tempdir().unwrap();
        let s = r#"{
            "mode": "running",
            "max_concurrent": 4,
            "active_runs": [
                {
                    "run_id":"0191c4e0-0000-7000-8000-000000000001",
                    "sandbox_id":"aaaaaaaa-0000-7000-8000-000000000001",
                    "phase":"preparing",
                    "phase_started_at":"2026-04-13T00:00:01.000Z"
                },
                {
                    "run_id":"0191c4e0-0000-7000-8000-000000000002",
                    "sandbox_id":"aaaaaaaa-0000-7000-8000-000000000002",
                    "phase":"running",
                    "phase_started_at":"2026-04-13T00:00:02.000Z"
                }
            ],
            "idle_sandboxes": [
                {"reuse_key":"sess-1","sandbox_id":"bbbbbbbb-0000-7000-8000-000000000001"}
            ],
            "proxy_port": 8080,
            "dns_port": 5300,
            "started_at": "2026-04-13T00:00:00.000Z",
            "updated_at": "2026-04-13T00:05:00.000Z"
        }"#;
        tokio::fs::write(dir.path().join("status.json"), s)
            .await
            .unwrap();
        let status = read_runner_status(dir.path()).await.unwrap();
        assert_eq!(status.mode, "running");
        assert_eq!(status.run_ids.len(), 2);
    }

    #[tokio::test]
    async fn read_runner_status_future_started_at_yields_zero_uptime() {
        // Clock skew guard: if started_at is in the future (NTP correction,
        // misconfigured clock), `to_std()` fails and we fall back to
        // Duration::ZERO rather than propagating an error.
        let dir = tempfile::tempdir().unwrap();
        let future = (chrono::Utc::now() + chrono::Duration::hours(1))
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let s = format!(r#"{{"mode":"running","active_runs":[],"started_at":"{future}"}}"#);
        tokio::fs::write(dir.path().join("status.json"), s)
            .await
            .unwrap();
        let status = read_runner_status(dir.path()).await.unwrap();
        assert_eq!(status.uptime, std::time::Duration::ZERO);
    }

    #[tokio::test]
    async fn read_runner_status_started_at_without_millis() {
        // StatusTracker writes millisecond precision today, but RFC 3339
        // allows second-precision too. Make sure we accept both so a
        // future format change won't silently break the gate.
        let dir = tempfile::tempdir().unwrap();
        let s = r#"{"mode":"running","active_runs":[],"started_at":"2026-04-13T00:00:00Z"}"#;
        tokio::fs::write(dir.path().join("status.json"), s)
            .await
            .unwrap();
        let status = read_runner_status(dir.path()).await.unwrap();
        assert_eq!(status.mode, "running");
    }

    #[tokio::test]
    async fn read_runner_status_stopped_preserves_ids() {
        // Reader is unopinionated: it returns what's on disk, and the gate
        // consults `mode` to decide whether to short-circuit.
        let dir = tempfile::tempdir().unwrap();
        let s = r#"{
            "mode":"stopped",
            "active_runs":[
                {"run_id":"0191c4e0-0000-7000-8000-000000000001","sandbox_id":"aaaaaaaa-0000-7000-8000-000000000001"}
            ],
            "started_at":"2026-04-13T00:00:00.000Z"
        }"#;
        tokio::fs::write(dir.path().join("status.json"), s)
            .await
            .unwrap();
        let status = read_runner_status(dir.path()).await.unwrap();
        assert_eq!(status.mode, "stopped");
        assert_eq!(status.run_ids.len(), 1);
    }

    // -----------------------------------------------------------------
    // decide_gate — pure decision function
    // -----------------------------------------------------------------

    fn snapshot(mode: &str, run_count: usize) -> RunnerStatusSnapshot {
        RunnerStatusSnapshot {
            mode: mode.to_string(),
            started_at: chrono::DateTime::parse_from_rfc3339("2026-04-13T00:00:00.000Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
            run_ids: (0..run_count)
                .map(|_| RunId::from(uuid::Uuid::nil()))
                .collect(),
            uptime: std::time::Duration::from_secs(600),
        }
    }

    #[test]
    fn decide_gate_running_with_jobs_refuses_normal() {
        assert_eq!(
            decide_gate(&snapshot("running", 3)),
            GateDecision::Refuse { draining: false }
        );
    }

    #[test]
    fn decide_gate_running_without_jobs_bypasses() {
        assert_eq!(decide_gate(&snapshot("running", 0)), GateDecision::Bypass);
    }

    #[test]
    fn decide_gate_starting_with_jobs_refuses_normal() {
        assert_eq!(
            decide_gate(&snapshot("starting", 1)),
            GateDecision::Refuse { draining: false }
        );
    }

    #[test]
    fn decide_gate_stopped_bypasses_even_with_stale_ids() {
        // Covers the narrow window between status.json being rewritten
        // with "stopped" and systemd marking the unit inactive.
        assert_eq!(decide_gate(&snapshot("stopped", 2)), GateDecision::Bypass);
    }

    #[test]
    fn decide_gate_stopping_bypasses() {
        // Stopping = teardown in progress. The runner is already cancelling
        // in-flight jobs itself; user stop/uninstall accelerates rather than
        // endangers — bypass the active-jobs gate.
        assert_eq!(decide_gate(&snapshot("stopping", 3)), GateDecision::Bypass);
    }

    #[test]
    fn decide_gate_draining_with_jobs_refuses_draining_variant() {
        assert_eq!(
            decide_gate(&snapshot("draining", 1)),
            GateDecision::Refuse { draining: true }
        );
    }

    #[test]
    fn decide_gate_unknown_mode_with_jobs_refuses_normal() {
        // Forward-compat: a newer runner writing a mode string we don't
        // recognize (e.g. "paused") gets the normal refuse branch —
        // safer than bypassing, and does not impersonate "draining".
        assert_eq!(
            decide_gate(&snapshot("paused", 1)),
            GateDecision::Refuse { draining: false }
        );
    }

    // -----------------------------------------------------------------
    // concrete gate orchestration
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn check_active_jobs_gate_force_skips_unit_and_status_queries() {
        let dir = tempfile::tempdir().unwrap();
        let mut ops = FakeGateOps::from_results([]);

        check_active_jobs_gate(&service_unit(), &fake_home(&dir), true, "stop", &mut ops)
            .await
            .unwrap();

        assert_eq!(ops.active_queries, 0);
        assert_eq!(ops.config_queries, 0);
    }

    #[tokio::test]
    async fn check_active_jobs_gate_bypasses_confirmed_inactive_unit_state() {
        let dir = tempfile::tempdir().unwrap();
        let home = fake_home(&dir);
        let unit = service_unit();
        let mut ops = FakeGateOps::from_results([Ok(false)]);

        check_active_jobs_gate(&unit, &home, false, "stop", &mut ops)
            .await
            .unwrap();

        assert_eq!(ops.active_queries, 1);
        assert_eq!(ops.config_queries, 0);
    }

    #[tokio::test]
    async fn check_active_jobs_gate_fails_closed_for_unavailable_unit_state() {
        let dir = tempfile::tempdir().unwrap();
        let home = fake_home(&dir);
        let unit = service_unit();
        let mut ops = FakeGateOps::from_results([Err(RunnerError::Internal(
            "systemd unavailable".to_string(),
        ))]);

        let error = check_active_jobs_gate(&unit, &home, false, "stop", &mut ops)
            .await
            .unwrap_err();
        let message = error.to_string();

        assert!(message.contains("cannot determine whether vm0-runner-test is active"));
        assert!(message.contains("before service stop"));
        assert!(message.contains("systemd unavailable"));
        assert!(message.contains("--force"));
        assert_eq!(ops.active_queries, 1);
        assert_eq!(ops.config_queries, 0);
    }

    #[tokio::test]
    async fn check_active_jobs_gate_fails_closed_for_missing_and_malformed_status() {
        let dir = tempfile::tempdir().unwrap();
        let home = fake_home(&dir);
        let unit = service_unit();
        let config_path = dir.path().join("selected-config.yaml");
        let base_dir = home.runners_dir().join("runner-release");
        let _live_instance = publish_test_live_runner(&home, &config_path, &base_dir).await;

        let mut missing_ops =
            FakeGateOps::from_results([Ok(true)]).with_config_path(Some(config_path.clone()));
        let missing_error = check_active_jobs_gate(&unit, &home, false, "stop", &mut missing_ops)
            .await
            .unwrap_err();
        assert!(
            missing_error
                .to_string()
                .contains("cannot read status.json")
        );

        tokio::fs::create_dir_all(&base_dir).await.unwrap();
        tokio::fs::write(base_dir.join("status.json"), "not json")
            .await
            .unwrap();

        let mut malformed_ops =
            FakeGateOps::from_results([Ok(true)]).with_config_path(Some(config_path));
        let malformed_error =
            check_active_jobs_gate(&unit, &home, false, "stop", &mut malformed_ops)
                .await
                .unwrap_err();
        assert!(
            malformed_error
                .to_string()
                .contains("cannot read status.json")
        );

        assert_eq!(missing_ops.active_queries, 1);
        assert_eq!(missing_ops.config_queries, 1);
        assert_eq!(malformed_ops.active_queries, 1);
        assert_eq!(malformed_ops.config_queries, 1);
    }

    #[tokio::test]
    async fn check_active_jobs_gate_uses_selected_config_base_dir_for_safe_status() {
        let dir = tempfile::tempdir().unwrap();
        let home = fake_home(&dir);
        let unit = service_unit();
        let config_path = dir.path().join("selected-config.yaml");
        let base_dir = home.runners_dir().join("runner-release");
        let _live_instance = publish_test_live_runner(&home, &config_path, &base_dir).await;
        tokio::fs::create_dir_all(&base_dir).await.unwrap();
        tokio::fs::write(
            base_dir.join("status.json"),
            r#"{"mode":"running","active_runs":[],"started_at":"2026-04-13T00:00:00Z"}"#,
        )
        .await
        .unwrap();
        let mut ops = FakeGateOps::from_results([Ok(true)]).with_config_path(Some(config_path));

        check_active_jobs_gate(&unit, &home, false, "stop", &mut ops)
            .await
            .unwrap();

        assert_eq!(ops.active_queries, 1);
        assert_eq!(ops.config_queries, 1);
    }

    #[tokio::test]
    async fn check_active_jobs_gate_uses_config_after_backslash_ended_comments() {
        let dir = tempfile::tempdir().unwrap();
        let systemctl = dir.path().join("systemctl");
        std::fs::write(&systemctl, COMMENT_SYSTEMCTL).unwrap();
        std::fs::set_permissions(&systemctl, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config_path = dir.path().join("selected config.yaml");

        for marker in ["#", ";"] {
            run_ignored_child_test(
                COMMENT_CHILD_TEST,
                (COMMENT_MARKER_ENV, marker),
                &[
                    ("PATH", Some(dir.path().to_str().unwrap())),
                    (COMMENT_CONFIG_ENV, Some(config_path.to_str().unwrap())),
                ],
                Duration::from_secs(10),
            )
            .await;
        }
    }

    #[tokio::test]
    #[ignore = "spawned by the commented unit active-jobs gate test"]
    async fn commented_unit_active_jobs_gate_child() {
        let Ok(marker) = std::env::var(COMMENT_MARKER_ENV) else {
            return;
        };
        if !ignored_child_test_env_guard_enabled((COMMENT_MARKER_ENV, &marker)) {
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        let home = fake_home(&dir);
        let unit = service_unit();
        let config_path = PathBuf::from(std::env::var(COMMENT_CONFIG_ENV).unwrap());
        let base_dir = home.runners_dir().join("runner-release");
        let _live_instance = publish_test_live_runner(&home, &config_path, &base_dir).await;
        tokio::fs::create_dir_all(&base_dir).await.unwrap();

        let run_id = RunId::new_v4();
        for command in ["stop", "uninstall"] {
            for active_runs in [Vec::new(), vec![serde_json::json!({"run_id": run_id})]] {
                tokio::fs::write(
                    base_dir.join("status.json"),
                    serde_json::to_vec(&serde_json::json!({
                        "mode": "running",
                        "active_runs": active_runs,
                        "started_at": "2026-04-13T00:00:00Z",
                    }))
                    .unwrap(),
                )
                .await
                .unwrap();

                let result = check_active_jobs_gate(
                    &unit,
                    &home,
                    false,
                    command,
                    &mut super::super::RealServiceUninstallOps,
                )
                .await;
                if active_runs.is_empty() {
                    result.unwrap();
                } else {
                    let error = result.unwrap_err();
                    assert!(
                        matches!(&error, RunnerError::ActiveJobs(jobs) if jobs.run_ids == [run_id]),
                        "expected active-job protection for {command}, got {error}"
                    );
                }
            }
        }

        let bounded_config =
            super::super::unit_config::read_unit_config_path_bounded(&unit, Duration::from_secs(5))
                .await
                .unwrap();
        assert!(matches!(
            bounded_config,
            super::super::systemctl::BoundedSystemctlQuery::Completed(Some(path))
                if path == config_path
        ));
    }

    #[tokio::test]
    async fn check_active_jobs_gate_fails_closed_without_selected_config_or_live_record() {
        let dir = tempfile::tempdir().unwrap();
        let home = fake_home(&dir);
        let unit = service_unit();

        let mut no_config_ops = FakeGateOps::from_results([Ok(true)]).with_config_path(None);
        let no_config_error =
            check_active_jobs_gate(&unit, &home, false, "uninstall", &mut no_config_ops)
                .await
                .unwrap_err();
        assert!(
            no_config_error
                .to_string()
                .contains("does not select a runner --config path")
        );

        let config_path = dir.path().join("selected-config.yaml");
        let mut no_record_ops =
            FakeGateOps::from_results([Ok(true)]).with_config_path(Some(config_path));
        let no_record_error =
            check_active_jobs_gate(&unit, &home, false, "uninstall", &mut no_record_ops)
                .await
                .unwrap_err();
        assert!(
            no_record_error
                .to_string()
                .contains("cannot resolve a live runner instance")
        );
    }
}
