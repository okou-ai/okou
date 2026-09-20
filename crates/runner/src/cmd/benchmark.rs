use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use clap::Args;
use sandbox::{
    EXEC_OUTPUT_LIMIT_7_MIB, ExecRequest, ExecResult, ExecTermination, RuntimeProvider,
    SandboxConfig, SandboxFactory, SandboxId, SandboxRuntime,
};
use tracing::{info, warn};

use crate::config;
use crate::deps::MITMPROXY_VERSION;
use crate::error::{RunnerError, RunnerResult};
use crate::executor;
use crate::paths::{HomePaths, RunnerPaths};
use crate::prefetch;
use crate::proxy;
use crate::workspace_mount::ensure_workspace_drive_mounted;

#[derive(Default)]
struct Timing {
    boot_ms: Option<u128>,
    workspace_mount_ms: Option<u128>,
    guest_restore_ms: Option<u128>,
    exec_ms: Option<u128>,
}

#[derive(Default)]
struct BenchmarkStartObserver {
    stages: Vec<(sandbox::SandboxStartStage, Duration, bool)>,
    connection: Vec<(
        sandbox::SandboxGuestConnectionPhase,
        Duration,
        Duration,
        bool,
    )>,
}

impl sandbox::SandboxStartObserver for BenchmarkStartObserver {
    fn record_stage(
        &mut self,
        stage: sandbox::SandboxStartStage,
        duration: Duration,
        success: bool,
    ) {
        self.stages.push((stage, duration, success));
    }

    fn record_guest_connection_phase(
        &mut self,
        phase: sandbox::SandboxGuestConnectionPhase,
        duration: Duration,
        remaining: Duration,
        success: bool,
    ) {
        self.connection.push((phase, duration, remaining, success));
    }
}

impl BenchmarkStartObserver {
    fn report(self) {
        for (stage, duration, success) in self.stages {
            info!(
                ?stage,
                duration_ms = duration.as_secs_f64() * 1000.0,
                success,
                "benchmark sandbox start stage"
            );
        }
        for (phase, duration, remaining, success) in self.connection {
            info!(
                ?phase,
                duration_ms = duration.as_secs_f64() * 1000.0,
                remaining_ms = remaining.as_secs_f64() * 1000.0,
                success,
                "benchmark guest connection phase"
            );
        }
    }
}

const DEFAULT_BENCHMARK_TIMEZONE: &str = "UTC";

/// Reject malformed entries so typos fail loud before benchmark startup.
fn parse_env_args(env: &[String]) -> RunnerResult<Vec<(String, String)>> {
    env.iter()
        .enumerate()
        .map(|(index, s)| {
            let (key, value) = s.split_once('=').ok_or_else(|| {
                RunnerError::Config(format!(
                    "invalid --env entry {}: expected KEY=VALUE format",
                    index + 1
                ))
            })?;
            if !guest_contracts::env::is_shell_identifier_env_key(key) {
                return Err(RunnerError::Config(format!(
                    "invalid --env key in entry {}: expected shell identifier",
                    index + 1
                )));
            }
            Ok((key.to_string(), value.to_string()))
        })
        .collect()
}

fn validate_timezone_arg(timezone: &str) -> RunnerResult<()> {
    if executor::is_shell_safe_guest_timezone_name(timezone) {
        return Ok(());
    }
    Err(RunnerError::Config(format!(
        "invalid --timezone {timezone:?}: expected a non-empty guest zoneinfo name containing only ASCII letters, digits, '/', '_', '-', or '+'"
    )))
}

#[derive(Args)]
pub struct BenchmarkArgs {
    /// The bash command to execute in the sandbox
    command: String,
    /// Path to runner.yaml config file
    #[arg(long, short)]
    config: PathBuf,
    /// Command timeout in seconds
    #[arg(long, default_value_t = 300)]
    timeout_secs: u64,
    /// Environment variables to pass (KEY=VALUE), can be repeated
    #[arg(long, short)]
    env: Vec<String>,
    /// Guest zoneinfo name to configure; benchmark fails if unavailable in the sandbox
    #[arg(long, default_value = DEFAULT_BENCHMARK_TIMEZONE)]
    timezone: String,
    /// Run the command as root (sudo)
    #[arg(long)]
    sudo: bool,
    /// Profile to benchmark
    #[arg(long)]
    profile: String,
}

pub async fn run_benchmark(
    args: BenchmarkArgs,
    runtime_provider: &dyn RuntimeProvider,
) -> RunnerResult<ExitCode> {
    let total = Instant::now();

    // Validate --env up front so typos fail before proxy/sandbox startup.
    let env_pairs = parse_env_args(&args.env)?;
    validate_timezone_arg(&args.timezone)?;

    // 1. Load config, force concurrency=1
    let mut runner_config = config::load(&args.config).await?;
    let registry_config_path = tokio::fs::canonicalize(&args.config).await.map_err(|e| {
        RunnerError::Config(format!(
            "canonicalize config path {} for live runner registry: {e}",
            args.config.display()
        ))
    })?;
    runner_config.sandbox.max_concurrent = 1;
    crate::private_fs::ensure_private_dir(&runner_config.base_dir).await?;
    let base_dir_canonical = runner_config.base_dir.canonicalize().map_err(|e| {
        RunnerError::Config(format!(
            "canonicalize base_dir {} for live runner registry: {e}",
            runner_config.base_dir.display()
        ))
    })?;

    let home = HomePaths::new()?;

    // Look up the profile selected via --profile.
    let profile_name = args.profile.as_str();
    let profile_config = runner_config.profiles.get(profile_name).ok_or_else(|| {
        RunnerError::Config(format!("profile '{profile_name}' not found in config"))
    })?;

    let resource_locks =
        config::lock_and_validate_profile_image_artifacts(profile_name, profile_config, &home)
            .await?;

    // Block until memory.bin is in page cache so benchmark numbers are stable.
    {
        let path = resource_locks.snapshot_paths().memory();
        let _ = tokio::task::spawn_blocking(move || prefetch::prefetch_memory(&path)).await;
    }

    // 2. Start proxy (unconditional — benchmark always uses proxy)
    let t = Instant::now();
    let runner_paths = RunnerPaths::new(runner_config.base_dir.clone());
    // Benchmark runs a single short-lived sandbox; crash recovery is not needed.
    let (mut mitm, _crash_rx) = proxy::MitmProxy::new(proxy::ProxyConfig {
        mitmdump_bin: home.mitmdump_bin(MITMPROXY_VERSION),
        ca_dir: runner_config.ca_dir.clone(),
        ca_lock_path: home.ca_lock(),
        addon_dir: runner_paths.mitm_addon_dir(),
        registry_path: runner_paths.proxy_registry(),
        registry_lock_path: runner_paths.proxy_registry_lock(),
        builtin_firewall_catalog_cache_path: runner_paths.builtin_firewall_catalog_cache(),
        runtime_dir: runner_paths.mitmdump_runtime_dir(),
        runtime_lock_path: runner_paths.mitmdump_runtime_lock(),
        api_url: runner_config.server.as_ref().map(|s| s.url.clone()),
        client_session_id: uuid::Uuid::new_v4().to_string(),
        runner_token: None,
    })
    .await?;
    mitm.start().await?;
    let proxy_ms = t.elapsed().as_millis();
    info!(proxy_ms, port = mitm.port(), "proxy ready");

    let live_runner_instance_handle = match crate::live_runner_instances::publish(
        &home,
        crate::live_runner_instances::LiveRunnerInstanceMetadata {
            config_path: registry_config_path,
            base_dir: base_dir_canonical,
            runner_group: runner_config.group.clone(),
            subcommand: "benchmark".into(),
        },
    )
    .await
    {
        Ok(handle) => handle,
        Err(e) => {
            drop(resource_locks);
            stop_benchmark_proxy(&mut mitm, "live_runner_publish").await;
            return Err(e);
        }
    };

    // 3. Factory init (with proxy port) via sandbox runtime
    let factory_config = runner_config.factory_config(profile_name, profile_config, &home);

    let t = Instant::now();
    let mut runtime = match runtime_provider
        .create_runtime(sandbox::RuntimeConfig {
            proxy_port: Some(mitm.port()),
            dns_port: None, // benchmark does not use custom DNS proxy
            host_cpu_placement: None,
        })
        .await
    {
        Ok(runtime) => runtime,
        Err(e) => {
            drop(resource_locks);
            stop_benchmark_proxy(&mut mitm, "runtime_create").await;
            remove_benchmark_live_runner_instance(&live_runner_instance_handle, "runtime_create")
                .await;
            return Err(e.into());
        }
    };
    let mut factory = match create_factory_or_shutdown_runtime(runtime.as_mut(), factory_config)
        .await
    {
        Ok(factory) => factory,
        Err(e) => {
            drop(resource_locks);
            stop_benchmark_proxy(&mut mitm, "factory_create").await;
            remove_benchmark_live_runner_instance(&live_runner_instance_handle, "factory_create")
                .await;
            return Err(e.into());
        }
    };
    let factory_ms = t.elapsed().as_millis();
    info!(factory_ms, "factory ready");

    // 4. Create + run sandbox — always shutdown factory and runtime afterwards
    let sandbox_config = SandboxConfig {
        id: SandboxId::new_v4(),
        resources: sandbox::ResourceLimits {
            cpu_count: profile_config.vcpu,
            memory_mb: profile_config.memory_mb,
        },
        device_rate_limits: None,
        workspace_drive: Some(sandbox::WorkspaceDriveConfig {
            size_mb: profile_config.workspace_disk_mb,
            seed_image: None,
        }),
    };
    let (result, timing) = run_sandbox(&args, &env_pairs, &*factory, &mitm, sandbox_config).await;
    let total_ms = total.elapsed().as_millis();
    // Shutdown factory first (releases the COW pool), then runtime-owned pools.
    factory.shutdown().await;
    runtime.shutdown().await;
    drop(resource_locks);
    let proxy_stop_result = mitm.stop().await;
    remove_benchmark_live_runner_instance(&live_runner_instance_handle, "complete").await;

    // 5. Log timing summary (always, even on error)
    let Timing {
        boot_ms,
        workspace_mount_ms,
        guest_restore_ms,
        exec_ms,
    } = timing;
    let proxy_stop_would_be_primary = match &result {
        Ok(exec_result) => benchmark_exit_code(exec_result) == 0,
        Err(_) => false,
    };
    let primary_proxy_stop_error = if proxy_stop_would_be_primary {
        proxy_stop_result.as_ref().err()
    } else {
        None
    };
    match (&result, primary_proxy_stop_error) {
        (Ok(exec_result), None) => {
            let exit_code = benchmark_exit_code(exec_result);
            info!(
                proxy_ms,
                factory_ms,
                boot_ms = ?boot_ms,
                workspace_mount_ms = ?workspace_mount_ms,
                guest_restore_ms = ?guest_restore_ms,
                exec_ms = ?exec_ms,
                total_ms,
                termination = ?exec_result.termination,
                exit_code,
                "benchmark complete"
            );
        }
        (Ok(_), Some(e)) | (Err(e), _) => {
            info!(proxy_ms, factory_ms, boot_ms = ?boot_ms, workspace_mount_ms = ?workspace_mount_ms, guest_restore_ms = ?guest_restore_ms, exec_ms = ?exec_ms, total_ms, error = %e, "benchmark failed");
        }
    }
    if !proxy_stop_would_be_primary && let Err(e) = &proxy_stop_result {
        warn!(error = %e, "proxy stop also failed after benchmark execution failure");
    }

    let exec_result = result?;

    // 6. Print stdout/stderr directly to terminal
    let stdout = std::io::stdout();
    let stderr = std::io::stderr();
    write_benchmark_exec_output(&mut stdout.lock(), &mut stderr.lock(), &exec_result);

    // 7. Propagate cleanup failure before a successful guest exit code
    let exit_code = benchmark_exit_code(&exec_result);
    if exit_code == 0 {
        proxy_stop_result?;
    }
    Ok(ExitCode::from(exit_code))
}

fn benchmark_exit_code(exec_result: &ExecResult) -> u8 {
    match exec_result.termination {
        ExecTermination::Exited { exit_code } => match u8::try_from(exit_code) {
            Ok(code) => code,
            Err(_) => {
                warn!(exit_code, "exit code out of u8 range, using 1");
                1
            }
        },
        ExecTermination::TimedOut => 124,
        ExecTermination::Cancelled | ExecTermination::StartFailed | ExecTermination::WaitFailed => {
            1
        }
    }
}

fn write_benchmark_exec_output(
    stdout: &mut impl Write,
    stderr: &mut impl Write,
    result: &ExecResult,
) {
    let _ = stdout.write_all(&result.stdout);
    let _ = stderr.write_all(&result.stderr);
    let mut line_open = !result.stderr.is_empty() && !result.stderr.ends_with(b"\n");
    write_benchmark_terminal_diagnostic(stderr, result, &mut line_open);
}

fn write_benchmark_terminal_diagnostic(
    stderr: &mut impl Write,
    result: &ExecResult,
    line_open: &mut bool,
) {
    let (fallback, include_diagnostic) = match result.termination {
        ExecTermination::Exited { .. } => (None, false),
        ExecTermination::TimedOut => (Some("Timeout"), false),
        ExecTermination::Cancelled => (Some("Cancelled"), true),
        ExecTermination::StartFailed | ExecTermination::WaitFailed => (None, true),
    };

    if result.stderr.is_empty() {
        if let Some(message) = fallback {
            let _ = writeln!(stderr, "{message}");
            *line_open = false;
        }
    } else if include_diagnostic && !result.diagnostic.is_empty() && *line_open {
        let _ = writeln!(stderr);
        *line_open = false;
    }

    if include_diagnostic && !result.diagnostic.is_empty() {
        let _ = writeln!(stderr, "{}", result.diagnostic);
        *line_open = false;
    }
}

async fn stop_benchmark_proxy(mitm: &mut proxy::MitmProxy, phase: &'static str) {
    if let Err(e) = mitm.stop().await {
        warn!(error = %e, phase, "proxy stop failed during benchmark cleanup");
    }
}

async fn remove_benchmark_live_runner_instance(
    handle: &crate::live_runner_instances::LiveRunnerInstanceHandle,
    phase: &'static str,
) {
    if let Err(e) = handle.remove_if_current().await {
        warn!(error = %e, phase, "failed to remove benchmark live runner instance record");
    }
}

async fn create_factory_or_shutdown_runtime(
    runtime: &mut dyn SandboxRuntime,
    factory_config: sandbox::FactoryConfig,
) -> sandbox::Result<Box<dyn SandboxFactory>> {
    match runtime.create_factory(factory_config).await {
        Ok(factory) => Ok(factory),
        Err(e) => {
            runtime.shutdown().await;
            Err(e)
        }
    }
}

/// Create, register, run, unregister, stop, destroy.
/// Timing is always returned even on error.
/// Caller is responsible for `factory.shutdown()`.
async fn run_sandbox(
    args: &BenchmarkArgs,
    env_pairs: &[(String, String)],
    factory: &dyn SandboxFactory,
    mitm: &proxy::MitmProxy,
    sandbox_config: SandboxConfig,
) -> (RunnerResult<ExecResult>, Timing) {
    let mut sandbox = match factory.create(sandbox_config).await {
        Ok(s) => s,
        Err(e) => return (Err(e.into()), Timing::default()),
    };

    let source_ip = sandbox.source_ip().to_string();
    let run_id = sandbox.id().to_string();
    let network_log_path = std::path::PathBuf::from("/dev/null");
    let proxy_log_path = std::path::PathBuf::from("/dev/null");
    let registration = proxy::SandboxRegistration {
        run_id: &run_id,
        cli_agent_type: "claude-code",
        sandbox_token: "",
        network_log_path: &network_log_path,
        proxy_log_path: &proxy_log_path,
        firewalls: None,
        network_policies: None,
        connector_runtime_targets: None,
        encrypted_secrets: None,
        secret_connector_map: None,
        secret_connector_metadata_map: None,
        vars: None,
        capture_network_bodies: false,
        billable_firewalls: &[],
        model_usage_provider: None,
    };
    if let Err(e) = mitm.register_sandbox(&source_ip, &registration).await {
        warn!(error = %e, "failed to register sandbox in proxy");
    }

    let (result, timing) = run_in_sandbox(args, env_pairs, sandbox.as_mut()).await;

    if let Err(e) = mitm.unregister_sandbox(&source_ip).await {
        warn!(error = %e, "failed to unregister sandbox from proxy");
    }
    if let Err(e) = sandbox.stop().await {
        warn!(error = %e, "sandbox stop failed");
    }
    factory.destroy(sandbox).await;

    (result, timing)
}

/// Images always contain a snapshot — restore guest state before the benchmark command.
async fn setup_guest(sandbox: &dyn sandbox::Sandbox, timezone: &str) -> RunnerResult<()> {
    executor::restore_guest_state_with_timezone(sandbox, timezone).await?;
    Ok(())
}

/// Start sandbox, restore guest state, exec command. Returns result + timing.
async fn run_in_sandbox(
    args: &BenchmarkArgs,
    env_pairs: &[(String, String)],
    sandbox: &mut dyn sandbox::Sandbox,
) -> (RunnerResult<ExecResult>, Timing) {
    let mut timing = Timing::default();

    let mut observer = BenchmarkStartObserver::default();
    let t_boot = Instant::now();
    let start_result = sandbox.start_with_observer(&mut observer).await;
    timing.boot_ms = Some(t_boot.elapsed().as_millis());
    observer.report();
    if let Err(e) = start_result {
        return (Err(e.into()), timing);
    }

    let t_mount = Instant::now();
    let mount_result = ensure_workspace_drive_mounted(sandbox, sandbox.id()).await;
    timing.workspace_mount_ms = Some(t_mount.elapsed().as_millis());
    if let Err(e) = mount_result {
        return (Err(e.error), timing);
    }

    let t_guest_restore = Instant::now();
    let guest_restore_result = setup_guest(sandbox, &args.timezone).await;
    timing.guest_restore_ms = Some(t_guest_restore.elapsed().as_millis());
    if let Err(e) = guest_restore_result {
        return (Err(e), timing);
    }

    let env_refs: Vec<(&str, &str)> = env_pairs
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();

    let t_exec = Instant::now();
    let result = sandbox
        .exec_with_diagnostic_label(
            &ExecRequest {
                cmd: &args.command,
                timeout: Duration::from_secs(args.timeout_secs),
                env: &env_refs,
                sudo: args.sudo,
                expected_exit_codes: &[],
                stdin_bytes: None,
                output_limits: EXEC_OUTPUT_LIMIT_7_MIB,
            },
            "benchmark-exec",
        )
        .await
        .map_err(Into::into);
    timing.exec_ms = Some(t_exec.elapsed().as_millis());

    (result, timing)
}

#[cfg(test)]
mod tests {
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
            let (proxy, _crash_rx) = proxy::MitmProxy::new(proxy::ProxyConfig {
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
                runner_token: None,
            })
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
        WorkspaceMountFailure,
        GuestRestoreFailure,
        ExecFailure,
    }

    impl BenchmarkLifecycleCase {
        const ALL: [Self; 5] = [
            Self::Success,
            Self::StartFailure,
            Self::WorkspaceMountFailure,
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
                Self::WorkspaceMountFailure => overrides.push_workspace_drive_mount_result(Err(
                    sandbox_workspace_mount_error(self.primary_error().unwrap()),
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
                Self::WorkspaceMountFailure => Some("benchmark workspace primary failure"),
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

    fn sandbox_workspace_mount_error(message: impl Into<String>) -> SandboxError {
        SandboxError::Operation {
            operation: SandboxOperation::MountWorkspaceDrive,
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
            workspace_drive: Some(sandbox::WorkspaceDriveConfig {
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

        let (run_output, observation) =
            tokio::time::timeout(BENCHMARK_LIFECYCLE_TEST_TIMEOUT, async {
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
        overrides
            .push_workspace_drive_mount_result(Err(sandbox_workspace_mount_error(PRIMARY_ERROR)));
        queue_stop_failures(&overrides);
        let workspace_mount_gate = MockLifecycleGate::new();
        overrides.set_workspace_drive_mount_lifecycle_gate(workspace_mount_gate.clone());
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
            let workspace_mount_seen = overrides
                .wait_workspace_drive_mount_call_count(1, BENCHMARK_LIFECYCLE_TEST_TIMEOUT)
                .await;
            let corrupt_result = tokio::fs::write(&proxy.registry_path, b"{invalid-json").await;
            workspace_mount_gate.release_one();

            let destroy_entry = destroy_gate
                .wait_entered(1, BENCHMARK_LIFECYCLE_TEST_TIMEOUT)
                .await;
            let destroy_calls = overrides.destroy_call_count();
            let events = captured.entries();
            destroy_gate.release_one();
            (
                workspace_mount_seen,
                corrupt_result,
                destroy_entry,
                destroy_calls,
                events,
            )
        };

        let (run_output, observation) =
            tokio::time::timeout(BENCHMARK_LIFECYCLE_TEST_TIMEOUT, async {
                tokio::join!(run, corrupt_registry_and_observe_destroy)
            })
            .await
            .expect("benchmark cleanup failure scenario timed out");
        let (result, _timing) = run_output;
        let (workspace_mount_seen, corrupt_result, destroy_entry, destroy_calls, events_at_destroy) =
            observation;

        assert!(
            workspace_mount_seen,
            "workspace setup mount was not observed"
        );
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

        async fn create(
            &self,
            _config: sandbox::SandboxConfig,
        ) -> sandbox::Result<Box<dyn Sandbox>> {
            panic!("benchmark initialization tests do not create sandboxes")
        }

        async fn destroy(&self, _sandbox: Box<dyn Sandbox>) {}

        async fn shutdown(&mut self) {}
    }

    fn test_factory_config() -> sandbox::FactoryConfig {
        sandbox::FactoryConfig {
            profile: "vm0/test".into(),
            binary_path: PathBuf::from("/firecracker"),
            kernel_path: PathBuf::from("/vmlinux"),
            rootfs_path: PathBuf::from("/rootfs.ext4"),
            base_dir: PathBuf::from("/tmp/vm0-test"),
            snapshot: None,
        }
    }
}
