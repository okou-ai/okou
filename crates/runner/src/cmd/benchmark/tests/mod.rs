use super::*;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use clap::CommandFactory;
use sandbox::{
    Sandbox, SandboxError, SandboxInitializationPhase, SandboxOperation, SandboxOperationReason,
};
use sandbox_mock::{MockLifecycleGate, MockSandboxFactory, MockSandboxOverrides};
use tracing::instrument::WithSubscriber;
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

const BENCHMARK_LIFECYCLE_COMMAND: &str = "benchmark-lifecycle-command";
const BENCHMARK_LIFECYCLE_TEST_TIMEOUT: Duration = Duration::from_secs(5);
const FIRST_STOP_ERROR: &str = "first benchmark stop cleanup failure";
const SECOND_STOP_ERROR: &str = "second benchmark stop cleanup failure";

#[test]
fn benchmark_help_describes_required_guest_zoneinfo() {
    let mut command = crate::Cli::command();
    let help = command
        .find_subcommand_mut("benchmark")
        .expect("runner CLI should expose benchmark")
        .render_help()
        .to_string();
    let normalized_help = help.split_whitespace().collect::<Vec<_>>().join(" ");

    assert!(normalized_help.contains(
        "Guest zoneinfo name to configure; benchmark fails if unavailable in the sandbox"
    ));
}

#[test]
fn parse_env_args_accepts_key_value_pairs() {
    let input = vec![
        "FOO=bar".to_string(),
        "_FOO=bar".to_string(),
        "FOO_1=bar".to_string(),
        "EMPTY=".to_string(),
    ];
    let parsed = parse_env_args(&input).unwrap();
    assert_eq!(
        parsed,
        vec![
            ("FOO".to_string(), "bar".to_string()),
            ("_FOO".to_string(), "bar".to_string()),
            ("FOO_1".to_string(), "bar".to_string()),
            ("EMPTY".to_string(), String::new()),
        ]
    );
}

#[test]
fn parse_env_args_preserves_value_with_equals() {
    let input = vec!["URL=https://a?x=1&y=2".to_string()];
    let parsed = parse_env_args(&input).unwrap();
    assert_eq!(
        parsed,
        vec![("URL".to_string(), "https://a?x=1&y=2".to_string())]
    );
}

#[test]
fn parse_env_args_rejects_missing_equals() {
    let input = vec!["FOO".to_string()];
    let err = parse_env_args(&input).unwrap_err();
    assert!(
        err.to_string()
            .contains("invalid --env entry 1: expected KEY=VALUE format"),
        "got: {err}"
    );
}

#[test]
fn parse_env_args_rejects_when_any_entry_is_missing_equals() {
    let input = vec!["GOOD=ok".to_string(), "secret-without-equals".to_string()];
    let err = parse_env_args(&input).unwrap_err();
    assert!(
        err.to_string()
            .contains("invalid --env entry 2: expected KEY=VALUE format"),
        "got: {err}"
    );
    assert!(
        !err.to_string().contains("secret-without-equals"),
        "got: {err}"
    );
}

#[test]
fn parse_env_args_rejects_invalid_shell_identifier_keys() {
    for value in [
        "=secret-value",
        "1BAD=secret-value",
        "BAD-NAME=secret-value",
    ] {
        let input = vec![value.to_string()];
        let err = parse_env_args(&input).unwrap_err();
        assert!(
            err.to_string()
                .contains("invalid --env key in entry 1: expected shell identifier"),
            "got: {err}"
        );
        assert!(!err.to_string().contains("secret-value"), "got: {err}");
        assert!(!err.to_string().contains(value), "got: {err}");
    }
}

#[test]
fn validate_timezone_arg_accepts_shell_safe_zoneinfo_name_shapes() {
    for timezone in [
        DEFAULT_BENCHMARK_TIMEZONE,
        "Asia/Shanghai",
        "Etc/GMT+1",
        "America/Argentina/Buenos_Aires",
        "Mars/Olympus",
    ] {
        validate_timezone_arg(timezone).unwrap();
    }
}

#[test]
fn validate_timezone_arg_rejects_empty_and_shell_metacharacters() {
    for timezone in ["", "UTC;id", "America/New York", "UTC'", "$(date)"] {
        let err = validate_timezone_arg(timezone).unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("invalid --timezone")
                && message.contains("non-empty guest zoneinfo name")
                && message.contains("ASCII letters"),
            "timezone {timezone:?} produced unexpected error: {err}"
        );
        assert!(!message.contains("IANA"), "got: {message}");
    }
}

fn exec_result(
    termination: ExecTermination,
    stdout: &[u8],
    stderr: &[u8],
    diagnostic: &str,
) -> ExecResult {
    ExecResult {
        termination,
        guest_duration_ms: None,
        stdout: stdout.to_vec(),
        stderr: stderr.to_vec(),
        diagnostic: diagnostic.to_string(),
        stdout_truncated: false,
        stderr_truncated: false,
    }
}

#[test]
fn benchmark_exit_codes_match_terminal_states() {
    for (case, termination, expected_exit_code) in [
        ("exited zero", ExecTermination::Exited { exit_code: 0 }, 0),
        (
            "exited u8 maximum",
            ExecTermination::Exited { exit_code: 255 },
            255,
        ),
        (
            "exited below u8 range",
            ExecTermination::Exited { exit_code: -1 },
            1,
        ),
        (
            "exited above u8 range",
            ExecTermination::Exited { exit_code: 256 },
            1,
        ),
        ("timed out", ExecTermination::TimedOut, 124),
        ("cancelled", ExecTermination::Cancelled, 1),
        ("start failed", ExecTermination::StartFailed, 1),
        ("wait failed", ExecTermination::WaitFailed, 1),
    ] {
        let result = exec_result(termination, b"", b"", "");

        assert_eq!(
            benchmark_exit_code(&result),
            expected_exit_code,
            "case={case}"
        );
    }
}

#[test]
fn benchmark_output_preserves_timeout_stderr_fallback() {
    let result = exec_result(ExecTermination::TimedOut, b"partial stdout\n", b"", "");
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();

    write_benchmark_exec_output(&mut stdout, &mut stderr, &result);

    assert_eq!(stdout, b"partial stdout\n");
    assert_eq!(stderr, b"Timeout\n");
}

#[test]
fn benchmark_output_starts_terminal_diagnostic_on_new_line() {
    let result = exec_result(
        ExecTermination::WaitFailed,
        b"",
        b"stderr clue",
        "wait failed",
    );
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();

    write_benchmark_exec_output(&mut stdout, &mut stderr, &result);

    assert!(stdout.is_empty());
    assert_eq!(stderr, b"stderr clue\nwait failed\n");
}

#[test]
fn benchmark_terminal_output_preserves_binary_bytes_and_diagnostic_policy() {
    for (termination, raw_stderr, diagnostic, expected_stderr) in [
        (
            ExecTermination::Exited { exit_code: 0 },
            b"".as_slice(),
            "exit diagnostic",
            b"".as_slice(),
        ),
        (
            ExecTermination::Exited { exit_code: 42 },
            b"\xff\0".as_slice(),
            "exit diagnostic",
            b"\xff\0".as_slice(),
        ),
        (
            ExecTermination::TimedOut,
            b"".as_slice(),
            "timeout diagnostic",
            b"Timeout\n".as_slice(),
        ),
        (
            ExecTermination::TimedOut,
            b"\xff\0".as_slice(),
            "timeout diagnostic",
            b"\xff\0".as_slice(),
        ),
        (
            ExecTermination::Cancelled,
            b"".as_slice(),
            "cancel diagnostic",
            b"Cancelled\ncancel diagnostic\n".as_slice(),
        ),
        (
            ExecTermination::Cancelled,
            b"\xff\0".as_slice(),
            "cancel diagnostic",
            b"\xff\0\ncancel diagnostic\n".as_slice(),
        ),
        (
            ExecTermination::StartFailed,
            b"".as_slice(),
            "start diagnostic",
            b"start diagnostic\n".as_slice(),
        ),
        (
            ExecTermination::StartFailed,
            b"\xff\0".as_slice(),
            "",
            b"\xff\0".as_slice(),
        ),
        (
            ExecTermination::WaitFailed,
            b"\xff\0\n".as_slice(),
            "wait diagnostic",
            b"\xff\0\nwait diagnostic\n".as_slice(),
        ),
    ] {
        let result = exec_result(termination, b"\0\xfe\n", raw_stderr, diagnostic);
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        write_benchmark_exec_output(&mut stdout, &mut stderr, &result);

        assert_eq!(stdout, b"\0\xfe\n", "{termination:?}");
        assert_eq!(stderr, expected_stderr, "{termination:?}");
    }
}

#[tokio::test]
async fn create_factory_or_shutdown_runtime_shuts_down_runtime_after_factory_error() {
    let shutdowns = Arc::new(AtomicUsize::new(0));
    let mut runtime = FailingFactoryRuntime {
        shutdowns: Arc::clone(&shutdowns),
    };

    let result = create_factory_or_shutdown_runtime(&mut runtime, test_factory_config()).await;

    assert!(matches!(
        result,
        Err(SandboxError::Initialization {
            phase: SandboxInitializationPhase::Factory,
            message,
        }) if message == "factory failed"
    ));
    assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn create_factory_or_shutdown_runtime_returns_factory_without_shutdown() {
    let shutdowns = Arc::new(AtomicUsize::new(0));
    let mut runtime = SuccessfulFactoryRuntime {
        shutdowns: Arc::clone(&shutdowns),
    };

    let factory = create_factory_or_shutdown_runtime(&mut runtime, test_factory_config())
        .await
        .unwrap();

    assert_eq!(factory.name(), "test");
    assert_eq!(shutdowns.load(Ordering::SeqCst), 0);
}

struct BenchmarkProxyHarness {
    proxy: proxy::MitmProxy,
    registry_path: PathBuf,
    _dir: tempfile::TempDir,
}

impl BenchmarkProxyHarness {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("proxy-registry.json");
        let (proxy, _crash_rx) = proxy::MitmProxy::new(
            proxy::ProxyConfig {
                mitmdump_bin: dir.path().join("unused-mitmdump"),
                ca_dir: dir.path().join("ca"),
                ca_lock_path: dir.path().join("ca.lock"),
                addon_dir: dir.path().join("addon"),
                registry_path: registry_path.clone(),
                registry_lock_path: dir.path().join("proxy-registry.json.lock"),
                builtin_firewall_catalog_cache_path: dir
                    .path()
                    .join("builtin-firewall-catalog-cache.json"),
                runtime_dir: dir.path().join("mitmdump-runtime"),
                runtime_lock_path: dir.path().join("mitmdump-runtime.lock"),
                api_url: None,
                client_session_id: "benchmark-lifecycle-test".to_string(),
                client_version: env!("CARGO_PKG_VERSION"),
            },
            crate::ADDON_FILES,
        )
        .await
        .unwrap();
        Self {
            proxy,
            registry_path,
            _dir: dir,
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum BenchmarkLifecycleCase {
    Success,
    StartFailure,
    HomeMountFailure,
    GuestRestoreFailure,
    ExecFailure,
}

impl BenchmarkLifecycleCase {
    const ALL: [Self; 5] = [
        Self::Success,
        Self::StartFailure,
        Self::HomeMountFailure,
        Self::GuestRestoreFailure,
        Self::ExecFailure,
    ];

    fn configure(self, overrides: &MockSandboxOverrides) {
        match self {
            Self::Success => {}
            Self::StartFailure => {
                overrides.push_start_result(Err(SandboxError::Start {
                    message: self.primary_error().unwrap().to_string(),
                }));
            }
            Self::HomeMountFailure => overrides.push_home_drive_mount_result(Err(
                sandbox_home_mount_error(self.primary_error().unwrap()),
            )),
            Self::GuestRestoreFailure => overrides.push_guest_state_restore_result(Err(
                sandbox_exec_error(self.primary_error().unwrap()),
            )),
            Self::ExecFailure => overrides.add_exec_error_matcher(
                BENCHMARK_LIFECYCLE_COMMAND,
                sandbox_exec_error(self.primary_error().unwrap()),
            ),
        }
    }

    const fn primary_error(self) -> Option<&'static str> {
        match self {
            Self::Success => None,
            Self::StartFailure => Some("benchmark start primary failure"),
            Self::HomeMountFailure => Some("benchmark workspace primary failure"),
            Self::GuestRestoreFailure => Some("benchmark guest restore primary failure"),
            Self::ExecFailure => Some("benchmark exec primary failure"),
        }
    }
}

fn sandbox_exec_error(message: impl Into<String>) -> SandboxError {
    SandboxError::Operation {
        operation: SandboxOperation::Exec,
        reason: SandboxOperationReason::Guest,
        message: message.into(),
    }
}

fn sandbox_home_mount_error(message: impl Into<String>) -> SandboxError {
    SandboxError::Operation {
        operation: SandboxOperation::MountHomeDrive,
        reason: SandboxOperationReason::Guest,
        message: message.into(),
    }
}

fn benchmark_lifecycle_args() -> BenchmarkArgs {
    BenchmarkArgs {
        command: BENCHMARK_LIFECYCLE_COMMAND.to_string(),
        config: PathBuf::from("/unused/runner.yaml"),
        timeout_secs: 1,
        env: Vec::new(),
        timezone: DEFAULT_BENCHMARK_TIMEZONE.to_string(),
        sudo: false,
        profile: "vm0/test".to_string(),
    }
}

fn benchmark_lifecycle_sandbox_config() -> SandboxConfig {
    SandboxConfig {
        id: SandboxId::new_v4(),
        resources: sandbox::ResourceLimits {
            cpu_count: 2,
            memory_mb: 4096,
        },
        device_rate_limits: None,
        home_drive: Some(sandbox::HomeDriveConfig {
            space_reserve: runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
            size_mb: 1024,
            seed_image: None,
        }),
    }
}

fn queue_stop_failures(overrides: &MockSandboxOverrides) {
    overrides.push_stop_result(Err(sandbox_exec_error(FIRST_STOP_ERROR)));
    overrides.push_stop_result(Err(sandbox_exec_error(SECOND_STOP_ERROR)));
}

fn event_positions(events: &[CapturedEvent], message: &str) -> Vec<usize> {
    events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| {
            (event.fields.get("message").map(String::as_str) == Some(message)).then_some(index)
        })
        .collect()
}

fn assert_cleanup_event_order(
    events: &[CapturedEvent],
    case: impl std::fmt::Debug,
    unregister_message: &str,
) {
    let register = event_positions(events, "registered sandbox in proxy registry");
    let unregister = event_positions(events, unregister_message);
    let stop = event_positions(events, "sandbox stop failed");

    assert_eq!(register.len(), 1, "case={case:?}; events={events:#?}");
    assert_eq!(unregister.len(), 1, "case={case:?}; events={events:#?}");
    assert_eq!(stop.len(), 1, "case={case:?}; events={events:#?}");
    assert!(
        register[0] < unregister[0] && unregister[0] < stop[0],
        "case={case:?}; events={events:#?}"
    );
}

fn assert_primary_result(case: BenchmarkLifecycleCase, result: RunnerResult<ExecResult>) {
    match (case.primary_error(), result) {
        (None, Ok(exec_result)) => assert!(matches!(
            exec_result.termination,
            ExecTermination::Exited { exit_code: 0 }
        )),
        (Some(expected), Err(error)) => assert!(
            error.to_string().contains(expected),
            "case={case:?}; error={error}"
        ),
        (None, Err(error)) => panic!("case={case:?} unexpectedly failed: {error}"),
        (Some(expected), Ok(_)) => {
            panic!("case={case:?} unexpectedly succeeded instead of returning {expected:?}")
        }
    }
}

async fn assert_lifecycle_case(proxy: &proxy::MitmProxy, case: BenchmarkLifecycleCase) {
    let overrides = Arc::new(MockSandboxOverrides::new());
    case.configure(&overrides);
    queue_stop_failures(&overrides);
    let destroy_gate = MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let args = benchmark_lifecycle_args();
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());

    let run = run_sandbox(
        &args,
        &[],
        &factory,
        proxy,
        benchmark_lifecycle_sandbox_config(),
    )
    .with_subscriber(subscriber);
    let observe_destroy = async {
        let entered = destroy_gate
            .wait_entered(1, BENCHMARK_LIFECYCLE_TEST_TIMEOUT)
            .await;
        let destroy_calls = overrides.destroy_call_count();
        let events = captured.entries();
        destroy_gate.release_one();
        (entered, destroy_calls, events)
    };

    let (run_output, observation) = tokio::time::timeout(BENCHMARK_LIFECYCLE_TEST_TIMEOUT, async {
        tokio::join!(run, observe_destroy)
    })
    .await
    .unwrap_or_else(|_| panic!("case={case:?} timed out"));
    let (result, _timing) = run_output;
    let (destroy_entry, destroy_calls, events_at_destroy) = observation;

    assert_eq!(
        destroy_entry.unwrap_or_else(|error| panic!("case={case:?}; {error}")),
        1
    );
    assert_eq!(destroy_calls, 1, "case={case:?}");
    assert_eq!(overrides.destroy_call_count(), 1, "case={case:?}");
    assert_cleanup_event_order(
        &events_at_destroy,
        case,
        "unregistered sandbox from proxy registry",
    );
    assert_cleanup_event_order(
        &captured.entries(),
        case,
        "unregistered sandbox from proxy registry",
    );
    assert_primary_result(case, result);
}

#[tokio::test]
async fn run_sandbox_preserves_ordered_cleanup_for_post_create_outcomes() {
    let proxy = BenchmarkProxyHarness::new().await;

    for case in BenchmarkLifecycleCase::ALL {
        assert_lifecycle_case(&proxy.proxy, case).await;
    }
}

#[tokio::test]
async fn run_sandbox_preserves_primary_error_when_registry_and_stop_cleanup_fail() {
    const PRIMARY_ERROR: &str = "benchmark cleanup-case primary failure";

    let proxy = BenchmarkProxyHarness::new().await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_home_drive_mount_result(Err(sandbox_home_mount_error(PRIMARY_ERROR)));
    queue_stop_failures(&overrides);
    let home_mount_gate = MockLifecycleGate::new();
    overrides.set_home_drive_mount_lifecycle_gate(home_mount_gate.clone());
    let destroy_gate = MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let args = benchmark_lifecycle_args();
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());

    let run = run_sandbox(
        &args,
        &[],
        &factory,
        &proxy.proxy,
        benchmark_lifecycle_sandbox_config(),
    )
    .with_subscriber(subscriber);
    let corrupt_registry_and_observe_destroy = async {
        let home_mount_seen = overrides
            .wait_home_drive_mount_call_count(1, BENCHMARK_LIFECYCLE_TEST_TIMEOUT)
            .await;
        let corrupt_result = tokio::fs::write(&proxy.registry_path, b"{invalid-json").await;
        home_mount_gate.release_one();

        let destroy_entry = destroy_gate
            .wait_entered(1, BENCHMARK_LIFECYCLE_TEST_TIMEOUT)
            .await;
        let destroy_calls = overrides.destroy_call_count();
        let events = captured.entries();
        destroy_gate.release_one();
        (
            home_mount_seen,
            corrupt_result,
            destroy_entry,
            destroy_calls,
            events,
        )
    };

    let (run_output, observation) = tokio::time::timeout(BENCHMARK_LIFECYCLE_TEST_TIMEOUT, async {
        tokio::join!(run, corrupt_registry_and_observe_destroy)
    })
    .await
    .expect("benchmark cleanup failure scenario timed out");
    let (result, _timing) = run_output;
    let (home_mount_seen, corrupt_result, destroy_entry, destroy_calls, events_at_destroy) =
        observation;

    assert!(home_mount_seen, "workspace setup mount was not observed");
    corrupt_result.expect("corrupt temporary proxy registry");
    assert_eq!(destroy_entry.unwrap(), 1);
    assert_eq!(destroy_calls, 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_cleanup_event_order(
        &events_at_destroy,
        "cleanup failures",
        "failed to unregister sandbox from proxy",
    );
    let final_events = captured.entries();
    assert_cleanup_event_order(
        &final_events,
        "cleanup failures",
        "failed to unregister sandbox from proxy",
    );
    assert!(
        event_positions(&final_events, "unregistered sandbox from proxy registry").is_empty(),
        "events={final_events:#?}"
    );

    let error = match result {
        Ok(_) => panic!("workspace setup unexpectedly succeeded"),
        Err(error) => error,
    };
    let message = error.to_string();
    assert!(message.contains(PRIMARY_ERROR), "error={error}");
    assert!(!message.contains(FIRST_STOP_ERROR), "error={error}");
    assert!(!message.contains("parse registry"), "error={error}");
}

struct SuccessfulFactoryRuntime {
    shutdowns: Arc<AtomicUsize>,
}

#[async_trait]
impl SandboxRuntime for SuccessfulFactoryRuntime {
    async fn create_factory(
        &self,
        _config: sandbox::FactoryConfig,
    ) -> sandbox::Result<Box<dyn SandboxFactory>> {
        Ok(Box::new(TestFactory))
    }

    async fn shutdown(&mut self) {
        self.shutdowns.fetch_add(1, Ordering::SeqCst);
    }
}

struct FailingFactoryRuntime {
    shutdowns: Arc<AtomicUsize>,
}

#[async_trait]
impl SandboxRuntime for FailingFactoryRuntime {
    async fn create_factory(
        &self,
        _config: sandbox::FactoryConfig,
    ) -> sandbox::Result<Box<dyn SandboxFactory>> {
        Err(SandboxError::Initialization {
            phase: SandboxInitializationPhase::Factory,
            message: "factory failed".into(),
        })
    }

    async fn shutdown(&mut self) {
        self.shutdowns.fetch_add(1, Ordering::SeqCst);
    }
}

struct TestFactory;

#[async_trait]
impl SandboxFactory for TestFactory {
    fn name(&self) -> &str {
        "test"
    }

    fn config_hash(&self) -> String {
        "test".into()
    }

    async fn create(&self, _config: sandbox::SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
        panic!("benchmark initialization tests do not create sandboxes")
    }

    async fn destroy(&self, _sandbox: Box<dyn Sandbox>) {}

    async fn shutdown(&mut self) {}
}

fn test_factory_config() -> sandbox::FactoryConfig {
    sandbox::FactoryConfig {
        home_drive_pressure: None,
        profile: "vm0/test".into(),
        binary_path: PathBuf::from("/firecracker"),
        kernel_path: PathBuf::from("/vmlinux"),
        rootfs_path: PathBuf::from("/rootfs.ext4"),
        base_dir: PathBuf::from("/tmp/vm0-test"),
        snapshot: None,
    }
}
