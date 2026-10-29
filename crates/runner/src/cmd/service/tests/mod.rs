use std::collections::VecDeque;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant as StdInstant, SystemTime};

use clap::Parser;

use super::*;
use crate::test_fixtures::ignored_child::{
    ignored_child_test_env_guard_enabled, run_ignored_child_test,
};
use runner_host::paths::RootfsPaths;
use runner_host::process::read_process_stat;

const TEST_ROOTFS_HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_SNAPSHOT_HASH: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const WAIT_RUNNING_SCENARIO_ENV: &str = "OKOU_RUN_SERVICE_WAIT_RUNNING_SCENARIO";
const WAIT_RUNNING_PID_PATH_ENV: &str = "OKOU_RUN_SERVICE_WAIT_RUNNING_PID_PATH";
const WAIT_RUNNING_COUNT_PATH_ENV: &str = "OKOU_RUN_SERVICE_WAIT_RUNNING_COUNT_PATH";
const WAIT_RUNNING_CHILD_TEST: &str = "cmd::service::tests::wait_running_systemctl_timeout_child";
const FAKE_WAIT_RUNNING_SYSTEMCTL: &str = r#"#!/bin/sh
record_identity_and_stall() {
  starttime=$(awk '{print $22}' "/proc/$$/stat")
  printf '%s %s\n' "$$" "$starttime" > "$OKOU_RUN_SERVICE_WAIT_RUNNING_PID_PATH.tmp"
  mv "$OKOU_RUN_SERVICE_WAIT_RUNNING_PID_PATH.tmp" "$OKOU_RUN_SERVICE_WAIT_RUNNING_PID_PATH"
  exec sleep 60
}

if [ "$OKOU_RUN_SERVICE_WAIT_RUNNING_SCENARIO" = "overflow" ]; then
  printf '%s\n' 'systemctl must not be called for an unrepresentable timeout' >&2
  exit 2
fi

if [ "$OKOU_RUN_SERVICE_WAIT_RUNNING_SCENARIO" = "config-query" ]; then
  record_identity_and_stall
fi

if [ "$1" = "--no-pager" ] && [ "$2" = "cat" ]; then
  printf '%s\n' '[Service]' 'ExecStart=/usr/local/bin/runner start --config /does/not/exist/runner.yaml'
  exit 0
fi

if [ "$1" = "show" ] && [ "$OKOU_RUN_SERVICE_WAIT_RUNNING_SCENARIO" = "active-query" ]; then
  count=0
  if [ -r "$OKOU_RUN_SERVICE_WAIT_RUNNING_COUNT_PATH" ]; then
    IFS= read -r count < "$OKOU_RUN_SERVICE_WAIT_RUNNING_COUNT_PATH"
  fi
  count=$((count + 1))
  printf '%s\n' "$count" > "$OKOU_RUN_SERVICE_WAIT_RUNNING_COUNT_PATH.tmp"
  mv "$OKOU_RUN_SERVICE_WAIT_RUNNING_COUNT_PATH.tmp" "$OKOU_RUN_SERVICE_WAIT_RUNNING_COUNT_PATH"
  if [ "$count" -eq 1 ]; then
    printf '%s\n' 'LoadState=loaded' 'ActiveState=active'
    exit 0
  fi
  record_identity_and_stall
fi

printf '%s\n' "unexpected fake systemctl invocation: $*" >&2
exit 2
"#;

fn parse_service_args(subcommand: &str, env: &str) -> ServiceArgs {
    let cli = crate::Cli::try_parse_from([
        "runner",
        "service",
        subcommand,
        "--config",
        "/does/not/exist/runner.yaml",
        "--name",
        "test",
        "--env",
        env,
    ])
    .unwrap();
    let crate::Command::Service(args) = cli.command else {
        panic!("expected service command");
    };
    args
}

fn parse_wait_running_args(timeout_secs: u64) -> ServiceArgs {
    let timeout_secs = timeout_secs.to_string();
    let cli = crate::Cli::try_parse_from([
        "runner",
        "service",
        "wait-running",
        "--name",
        "test",
        "--timeout-secs",
        &timeout_secs,
    ])
    .unwrap();
    let crate::Command::Service(args) = cli.command else {
        panic!("expected service command");
    };
    args
}

#[tokio::test]
async fn wait_running_rejects_unrepresentable_timeout_before_systemctl() {
    run_wait_running_timeout_scenario("overflow").await;
}

#[tokio::test]
async fn wait_running_bounds_initial_systemctl_query() {
    run_wait_running_timeout_scenario("config-query").await;
}

#[tokio::test]
async fn wait_running_bounds_active_systemctl_query_and_preserves_observation() {
    run_wait_running_timeout_scenario("active-query").await;
}

async fn run_wait_running_timeout_scenario(scenario: &str) {
    let dir = tempfile::tempdir().unwrap();
    let fake_systemctl = dir.path().join("systemctl");
    std::fs::write(&fake_systemctl, FAKE_WAIT_RUNNING_SYSTEMCTL).unwrap();
    let mut permissions = std::fs::metadata(&fake_systemctl).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&fake_systemctl, permissions).unwrap();

    let pid_path = dir.path().join("stalled-process");
    let count_path = dir.path().join("show-count");
    let path = format!(
        "{}:{}",
        dir.path().display(),
        std::env::var("PATH").expect("test process PATH must be set")
    );
    run_ignored_child_test(
        WAIT_RUNNING_CHILD_TEST,
        (WAIT_RUNNING_SCENARIO_ENV, scenario),
        &[
            ("PATH", Some(&path)),
            (
                WAIT_RUNNING_PID_PATH_ENV,
                Some(utf8_path(pid_path.as_path())),
            ),
            (
                WAIT_RUNNING_COUNT_PATH_ENV,
                Some(utf8_path(count_path.as_path())),
            ),
        ],
        Duration::from_secs(10),
    )
    .await;
}

fn utf8_path(path: &Path) -> &str {
    path.to_str().expect("temporary path must be UTF-8")
}

#[tokio::test]
#[ignore = "spawned by wait-running systemctl timeout tests"]
async fn wait_running_systemctl_timeout_child() {
    let Ok(scenario) = std::env::var(WAIT_RUNNING_SCENARIO_ENV) else {
        return;
    };
    if !ignored_child_test_env_guard_enabled((WAIT_RUNNING_SCENARIO_ENV, &scenario)) {
        return;
    }

    let timeout_secs = match scenario.as_str() {
        "overflow" => u64::MAX,
        "config-query" => 1,
        "active-query" => 2,
        unexpected => panic!("unexpected wait-running timeout scenario: {unexpected}"),
    };
    let started = StdInstant::now();
    let error = run_service(parse_wait_running_args(timeout_secs))
        .await
        .unwrap_err()
        .to_string();
    let elapsed = started.elapsed();

    if scenario == "overflow" {
        assert_eq!(error, "internal error: --timeout-secs is too large");
        return;
    }

    assert!(
        error.contains(&format!(
            "timed out waiting {timeout_secs}s for vm0-runner-test to reach running"
        )),
        "unexpected error: {error}"
    );
    let expected_observation = match scenario.as_str() {
        "config-query" => "last observation: not checked",
        "active-query" => "last observation: live runner instance record missing",
        unexpected => panic!("unexpected wait-running timeout scenario: {unexpected}"),
    };
    assert!(
        error.contains(expected_observation),
        "unexpected error: {error}"
    );
    assert!(
        elapsed >= Duration::from_millis(timeout_secs * 1_000 - 100),
        "wait-running returned before its budget: {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_secs(timeout_secs + 2),
        "wait-running exceeded its cleanup margin: {elapsed:?}"
    );

    let identity = std::fs::read_to_string(
        std::env::var(WAIT_RUNNING_PID_PATH_ENV).expect("stalled process path must be set"),
    )
    .unwrap();
    let (pid, starttime) = identity
        .trim()
        .split_once(' ')
        .expect("stalled process identity must contain pid and starttime");
    let pid = pid.parse::<u32>().unwrap();
    let starttime = starttime.parse::<u64>().unwrap();
    assert!(
        !matches!(read_process_stat(pid).await, Some(stat) if stat.starttime == starttime),
        "stalled systemctl process {pid}/{starttime} was not reaped"
    );
}

#[tokio::test]
async fn service_run_commands_reject_invalid_env_names_before_setup() {
    const SECRET: &str = "sentinel-service-env-secret";

    for subcommand in ["start", "install"] {
        for key in ["1INVALID", "API-KEY"] {
            let assignment = format!("{key}={SECRET}");
            let error = run_service(parse_service_args(subcommand, &assignment))
                .await
                .unwrap_err()
                .to_string();

            assert!(
                error.contains(&format!("invalid --env key {key:?}")),
                "unexpected {subcommand} error: {error}"
            );
            assert!(
                !error.contains(SECRET),
                "{subcommand} error exposed the environment value: {error}"
            );
        }
    }
}

struct ServiceActivationFixture {
    _dir: tempfile::TempDir,
    home: HomePaths,
    config_path: PathBuf,
    base_dir: PathBuf,
    ca_dir: PathBuf,
    firecracker: PathBuf,
    kernel: PathBuf,
}

impl ServiceActivationFixture {
    async fn with_complete_artifacts() -> Self {
        let fixture = Self::without_artifacts().await;
        write_complete_artifacts(&fixture.home).await;
        fixture
    }

    async fn with_complete_artifacts_and_relative_config() -> Self {
        let fixture = Self::without_artifacts_with_relative_config().await;
        write_complete_artifacts(&fixture.home).await;
        fixture
    }

    async fn without_artifacts() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let firecracker = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        tokio::fs::write(&firecracker, b"").await.unwrap();
        tokio::fs::write(&kernel, b"").await.unwrap();

        let config_path = dir.path().join("runner.yaml");
        let base_dir = dir.path().to_path_buf();
        let ca_dir = dir.path().to_path_buf();
        write_config(&config_path, &base_dir, &ca_dir, &firecracker, &kernel)
            .await
            .unwrap();

        Self {
            home: HomePaths::with_root(dir.path().join("vm0-runner")),
            base_dir,
            ca_dir,
            firecracker,
            kernel,
            _dir: dir,
            config_path,
        }
    }

    async fn without_artifacts_with_relative_config() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("config");
        let base_dir = config_dir.join("runner-state");
        let ca_dir = config_dir.join("ca");
        let firecracker = config_dir.join("bin/firecracker");
        let kernel = config_dir.join("bin/vmlinux");
        tokio::fs::create_dir_all(firecracker.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&firecracker, b"").await.unwrap();
        tokio::fs::write(&kernel, b"").await.unwrap();
        tokio::fs::create_dir_all(&ca_dir).await.unwrap();

        let config_path = config_dir.join("runner.yaml");
        write_config(
            &config_path,
            Path::new("runner-state"),
            Path::new("ca"),
            Path::new("bin/firecracker"),
            Path::new("bin/vmlinux"),
        )
        .await
        .unwrap();

        Self {
            home: HomePaths::with_root(dir.path().join("vm0-runner")),
            base_dir,
            ca_dir,
            firecracker,
            kernel,
            _dir: dir,
            config_path,
        }
    }

    fn rootfs(&self) -> RootfsPaths {
        RootfsPaths::new(&self.home, TEST_ROOTFS_HASH)
    }
}

async fn write_config(
    config_path: &Path,
    base_dir: &Path,
    ca_dir: &Path,
    firecracker: &Path,
    kernel: &Path,
) -> std::io::Result<()> {
    tokio::fs::write(
        config_path,
        format!(
            r#"
group: test/group
base_dir: {base_dir}
ca_dir: {ca_dir}
firecracker:
  binary: {firecracker}
  kernel: {kernel}
profiles:
  vm0/default:
    rootfs_hash: {TEST_ROOTFS_HASH}
    snapshot_hash: {TEST_SNAPSHOT_HASH}
    vcpu: 2
    memory_mb: 4096
    rootfs_disk_mb: 8192
    home_disk_mb: 16384
"#,
            base_dir = base_dir.display(),
            ca_dir = ca_dir.display(),
            firecracker = firecracker.display(),
            kernel = kernel.display(),
        ),
    )
    .await
}

async fn write_complete_artifacts(home: &HomePaths) {
    let rootfs = RootfsPaths::new(home, TEST_ROOTFS_HASH);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs(), b"rootfs").await.unwrap();

    let snapshot = rootfs.snapshot(TEST_SNAPSHOT_HASH);
    tokio::fs::create_dir_all(snapshot.dir()).await.unwrap();
    for path in snapshot.required_artifacts() {
        tokio::fs::write(path, b"snapshot").await.unwrap();
    }
    tokio::fs::write(
        snapshot.complete_marker(),
        sandbox_firecracker::SNAPSHOT_COMPLETE_MARKER_CONTENT,
    )
    .await
    .unwrap();
}

async fn assert_artifact_locks_held(home: &HomePaths) {
    let error = runner_host::lock::try_acquire(home.rootfs_lock(TEST_ROOTFS_HASH))
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("lock is already held"),
        "unexpected rootfs lock error: {error}"
    );

    let snapshot_err = runner_host::lock::try_acquire(home.snapshot_lock(TEST_SNAPSHOT_HASH))
        .await
        .unwrap_err();
    assert!(
        snapshot_err.to_string().contains("lock is already held"),
        "unexpected snapshot lock error: {snapshot_err}"
    );
}

async fn assert_artifact_locks_released(home: &HomePaths) {
    drop(
        runner_host::lock::try_acquire(home.rootfs_lock(TEST_ROOTFS_HASH))
            .await
            .unwrap(),
    );

    let snapshot_lock = runner_host::lock::try_acquire(home.snapshot_lock(TEST_SNAPSHOT_HASH))
        .await
        .unwrap();
    drop(snapshot_lock);
}

fn set_dir_mtime(path: &Path, time: SystemTime) {
    let file = std::fs::File::open(path).unwrap();
    file.set_times(std::fs::FileTimes::new().set_modified(time))
        .unwrap();
}

fn dir_mtime(path: &Path) -> SystemTime {
    std::fs::metadata(path).unwrap().modified().unwrap()
}

fn service_unit() -> RunnerServiceUnit {
    RunnerServiceUnit::from_suffix("test").unwrap()
}

struct FakeUninstallOps {
    events: Vec<&'static str>,
    gate_active_results: VecDeque<RunnerResult<bool>>,
    gate_config_path: Option<PathBuf>,
}

impl ActiveJobsGateOps for FakeUninstallOps {
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

impl ServiceUninstallOps for FakeUninstallOps {
    type LockGuard = ();

    fn acquire_lock<'a>(
        &'a mut self,
        _unit: &'a RunnerServiceUnit,
        _home: &'a HomePaths,
    ) -> ServiceFuture<'a, Self::LockGuard>
    where
        Self::LockGuard: 'a,
    {
        self.events.push("acquire_lock");
        Box::pin(std::future::ready(Ok(())))
    }

    fn uninstall_unit<'a>(&'a mut self, _unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
        self.events.push("uninstall_unit");
        Box::pin(std::future::ready(Ok(())))
    }
}

fn live_runner_instance(config_path: PathBuf, base_dir: PathBuf) -> LiveRunnerInstance {
    LiveRunnerInstance {
        pid: 123,
        starttime: 456,
        config_path,
        base_dir,
        runner_group: "test/group".to_string(),
        subcommand: "start".to_string(),
        started_at: "2026-01-01T00:00:00.000Z".to_string(),
    }
}

#[tokio::test]
async fn uninstall_uses_selected_config_base_dir_before_service_mutation() {
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
    let started_at = (chrono::Utc::now() - chrono::Duration::minutes(18))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let parsed_started_at = chrono::DateTime::parse_from_rfc3339(&started_at)
        .unwrap()
        .with_timezone(&chrono::Utc);
    tokio::fs::write(
        base_dir.join("status.json"),
        format!(
            r#"{{
                    "mode":"draining",
                    "active_runs":[
                        {{"run_id":"0191c4e0-0000-7000-8000-000000000003"}}
                    ],
                    "started_at":"{started_at}"
                }}"#
        ),
    )
    .await
    .unwrap();
    let mut ops = FakeUninstallOps {
        events: Vec::new(),
        gate_active_results: VecDeque::from([Ok(true)]),
        gate_config_path: Some(config_path),
    };

    let before_gate = chrono::Utc::now();
    let error = uninstall_with_ops(&unit, &home, false, &mut ops)
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
        ["0191c4e0-0000-7000-8000-000000000003"]
    );
    assert!(error.runner_uptime >= (before_gate - parsed_started_at).to_std().unwrap());
    assert!(error.runner_uptime <= (after_gate - parsed_started_at).to_std().unwrap());
    assert_eq!(error.command_name, "uninstall");
    assert!(error.draining);
}

#[tokio::test]
async fn uninstall_fails_closed_when_gate_unit_state_is_unavailable() {
    let unit = service_unit();
    let home = HomePaths::with_root(PathBuf::from("/tmp/vm0-runner-test"));
    let mut ops = FakeUninstallOps {
        events: Vec::new(),
        gate_active_results: VecDeque::from([Err(RunnerError::Internal(
            "systemd unavailable".to_string(),
        ))]),
        gate_config_path: None,
    };

    let error = uninstall_with_ops(&unit, &home, false, &mut ops)
        .await
        .unwrap_err();
    let message = error.to_string();

    assert!(message.contains("vm0-runner-test"));
    assert!(message.contains("before service uninstall"));
    assert!(message.contains("systemd unavailable"));
    assert_eq!(ops.events, ["acquire_lock", "gate_is_active"]);
}

#[test]
fn selected_config_waits_without_live_record() {
    let unit = RunnerServiceUnit::from_suffix("pr-123-1").unwrap();

    let config_path = PathBuf::from("/vm0-runner/runners/pr-123/runner.yaml");
    let instance = selected_config_live_instance_from_instances(&unit, &config_path, &[]).unwrap();

    assert_eq!(instance, None);
}

#[test]
fn selected_config_uses_exact_path_during_release_overlap() {
    let unit = RunnerServiceUnit::from_suffix("pr-123-1").unwrap();
    let actual_base_dir = PathBuf::from("/vm0-runner/runners/pr-123");
    let config_path = actual_base_dir.join("runner.yaml");
    let instances = vec![
        live_runner_instance(config_path.clone(), actual_base_dir.clone()),
        live_runner_instance(
            PathBuf::from("/vm0-runner/runners/other/runner.yaml"),
            PathBuf::from("/vm0-runner/runners/other"),
        ),
    ];

    let instance = selected_config_live_instance_from_instances(&unit, &config_path, &instances)
        .unwrap()
        .unwrap();

    assert_eq!(instance.base_dir, actual_base_dir);
}

#[test]
fn selected_config_rejects_duplicate_live_records() {
    let unit = RunnerServiceUnit::from_suffix("pr-123-1").unwrap();
    let config_path = PathBuf::from("/vm0-runner/runners/pr-123/runner.yaml");
    let instances = vec![
        live_runner_instance(
            config_path.clone(),
            PathBuf::from("/vm0-runner/runners/pr-123"),
        ),
        live_runner_instance(
            config_path.clone(),
            PathBuf::from("/vm0-runner/runners/other"),
        ),
    ];

    let error =
        selected_config_live_instance_from_instances(&unit, &config_path, &instances).unwrap_err();

    assert!(
        error.to_string().contains("multiple live runner instance"),
        "unexpected error: {error}"
    );
}

#[test]
fn systemd_run_uses_explicit_soft_and_hard_nofile_limit() {
    assert_eq!(
        systemd_run_limit_nofile_property_arg(),
        "--property=LimitNOFILE=524288:524288"
    );
}

#[test]
fn systemd_run_delegates_cpu_with_control_subgroup() {
    assert_eq!(
        systemd_run_cpu_delegation_property_args(),
        [
            "--property=Delegate=cpu".to_string(),
            "--property=DelegateSubgroup=control".to_string(),
        ]
    );
}

#[test]
fn systemd_run_preserves_literal_dollar_paths_and_environment() {
    let command = systemd_run_command(
        &service_unit(),
        Path::new("/opt/vm0-${BUILD}/vm0-runner"),
        Path::new("/srv/vm0-${TENANT}/runner.yaml"),
        &["LITERAL=${VALUE}".to_string()],
        true,
    );
    let args = command
        .as_std()
        .get_args()
        .map(|arg| arg.to_str().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(
        args,
        [
            "--unit=vm0-runner-test",
            "--description=Okou Runner (vm0-runner-test)",
            "--expand-environment=no",
            "--property=Type=exec",
            "--property=Restart=on-failure",
            "--property=RestartSec=5",
            "--property=StandardOutput=journal",
            "--property=StandardError=journal",
            "--property=KillSignal=SIGTERM",
            "--property=TimeoutStopSec=300",
            "--property=LimitNOFILE=524288:524288",
            "--property=Delegate=cpu",
            "--property=DelegateSubgroup=control",
            "--property=SyslogIdentifier=vm0-runner-test",
            "--setenv=LITERAL=${VALUE}",
            "/opt/vm0-${BUILD}/vm0-runner",
            "start",
            "--config",
            "/srv/vm0-${TENANT}/runner.yaml",
            "--local",
        ]
    );
}

#[test]
fn activation_config_snapshot_path_is_content_addressed() {
    let unit = service_unit();
    let base_dir = Path::new("/var/lib/vm0-runner/runners/test");

    let first = service_activation_config_snapshot_path(&unit, base_dir, b"group: test\n");
    let second = service_activation_config_snapshot_path(&unit, base_dir, b"group: test\n");
    let different = service_activation_config_snapshot_path(&unit, base_dir, b"group: different\n");

    assert_eq!(first, second);
    assert_ne!(first, different);
    assert_eq!(
        first.parent().unwrap(),
        base_dir.join(SERVICE_CONFIG_SNAPSHOT_DIR)
    );
    assert!(
        first
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("test-")
    );
    assert!(
        first
            .extension()
            .is_some_and(|extension| extension == "yaml")
    );
}

#[tokio::test]
async fn activation_config_snapshot_serializes_resolved_paths_and_is_private() {
    let fixture = ServiceActivationFixture::with_complete_artifacts_and_relative_config().await;
    let activation_config =
        prepare_service_activation_config(&service_unit(), &fixture.config_path, &fixture.home)
            .await
            .unwrap();

    assert_ne!(activation_config.snapshot_path, fixture.config_path);
    assert!(
        activation_config
            .snapshot_path
            .starts_with(fixture.base_dir.join(SERVICE_CONFIG_SNAPSHOT_DIR))
    );

    let snapshot = crate::config::load_for_start(&activation_config.snapshot_path, None)
        .await
        .unwrap();
    assert_eq!(snapshot.base_dir, fixture.base_dir);
    assert_eq!(snapshot.ca_dir, fixture.ca_dir);
    assert_eq!(snapshot.firecracker.binary, fixture.firecracker);
    assert_eq!(snapshot.firecracker.kernel, fixture.kernel);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mode = std::fs::metadata(&activation_config.snapshot_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}

#[tokio::test]
async fn activation_guard_hands_stable_snapshot_path_to_activation() {
    let fixture = ServiceActivationFixture::with_complete_artifacts().await;
    let config_path = fixture.config_path.clone();
    let base_dir = fixture.base_dir.clone();

    let snapshot_path = with_service_activation_image_artifacts(
        &service_unit(),
        &fixture.config_path,
        &fixture.home,
        |snapshot_path| async move {
            assert_ne!(snapshot_path, config_path);
            assert!(snapshot_path.starts_with(base_dir.join(SERVICE_CONFIG_SNAPSHOT_DIR)));

            tokio::fs::write(&config_path, "group: mutated\n")
                .await
                .unwrap();

            let snapshot_content = tokio::fs::read_to_string(&snapshot_path).await.unwrap();
            assert!(snapshot_content.contains(TEST_ROOTFS_HASH));
            assert!(snapshot_content.contains(TEST_SNAPSHOT_HASH));
            assert!(!snapshot_content.contains("mutated"));
            Ok(snapshot_path)
        },
    )
    .await
    .unwrap();

    assert!(snapshot_path.exists());
}

#[tokio::test]
async fn activation_guard_rejects_incomplete_artifacts_before_activation() {
    let fixture = ServiceActivationFixture::without_artifacts().await;
    let activation_polled = Arc::new(AtomicBool::new(false));
    let activation_polled_in_task = activation_polled.clone();

    let err = with_service_activation_image_artifacts(
        &service_unit(),
        &fixture.config_path,
        &fixture.home,
        |_| async {
            activation_polled_in_task.store(true, Ordering::SeqCst);
            Ok(())
        },
    )
    .await
    .unwrap_err();

    assert!(
        err.to_string().contains("rootfs") && err.to_string().contains("not found"),
        "unexpected error: {err}"
    );
    assert!(!activation_polled.load(Ordering::SeqCst));
}

#[tokio::test]
async fn activation_guard_holds_locks_during_activation_and_releases_after_success() {
    let fixture = ServiceActivationFixture::with_complete_artifacts().await;

    with_service_activation_image_artifacts(
        &service_unit(),
        &fixture.config_path,
        &fixture.home,
        |_| async {
            assert_artifact_locks_held(&fixture.home).await;
            Ok(())
        },
    )
    .await
    .unwrap();

    assert_artifact_locks_released(&fixture.home).await;
}

#[tokio::test]
async fn activation_guard_touches_artifacts_after_success() {
    let fixture = ServiceActivationFixture::with_complete_artifacts().await;
    let rootfs = fixture.rootfs();
    let snapshot = rootfs.snapshot(TEST_SNAPSHOT_HASH);
    let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(60);
    set_dir_mtime(rootfs.dir(), old_time);
    set_dir_mtime(snapshot.dir(), old_time);

    with_service_activation_image_artifacts(
        &service_unit(),
        &fixture.config_path,
        &fixture.home,
        |_| async {
            assert_eq!(dir_mtime(rootfs.dir()), old_time);
            assert_eq!(dir_mtime(snapshot.dir()), old_time);
            Ok(())
        },
    )
    .await
    .unwrap();

    assert!(dir_mtime(rootfs.dir()) > old_time);
    assert!(dir_mtime(snapshot.dir()) > old_time);
}

#[tokio::test]
async fn activation_guard_releases_locks_after_failure_without_touching_artifacts() {
    let fixture = ServiceActivationFixture::with_complete_artifacts().await;
    let rootfs = fixture.rootfs();
    let snapshot = rootfs.snapshot(TEST_SNAPSHOT_HASH);
    let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(60);
    set_dir_mtime(rootfs.dir(), old_time);
    set_dir_mtime(snapshot.dir(), old_time);

    let err = with_service_activation_image_artifacts(
        &service_unit(),
        &fixture.config_path,
        &fixture.home,
        |_| async {
            assert_artifact_locks_held(&fixture.home).await;
            Err::<(), RunnerError>(RunnerError::Internal("activation failed".to_string()))
        },
    )
    .await
    .unwrap_err();

    assert_eq!(err.to_string(), "internal error: activation failed");
    assert_artifact_locks_released(&fixture.home).await;
    assert_eq!(dir_mtime(rootfs.dir()), old_time);
    assert_eq!(dir_mtime(snapshot.dir()), old_time);
}
