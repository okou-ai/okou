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
use crate::home_mount::ensure_home_drive_mounted;
use crate::proxy;
use runner_host::paths::{HomePaths, RunnerPaths};

use super::terminal_diagnostic::write_terminal_diagnostic;

#[derive(Default)]
struct Timing {
    boot_ms: Option<u128>,
    home_mount_ms: Option<u128>,
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
    runner_host::private_fs::ensure_private_dir(&runner_config.base_dir).await?;
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

    // 2. Start proxy (unconditional — benchmark always uses proxy)
    let t = Instant::now();
    let runner_paths = RunnerPaths::new(runner_config.base_dir.clone());
    // Benchmark runs a single short-lived sandbox; crash recovery is not needed.
    let (mut mitm, _crash_rx) = proxy::MitmProxy::new(
        proxy::ProxyConfig {
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
            client_version: env!("CARGO_PKG_VERSION"),
        },
        crate::ADDON_FILES,
    )
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
            return Err(e.into());
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
        home_drive: Some(sandbox::HomeDriveConfig {
            size_mb: profile_config.home_disk_mb,
            seed_image: None,
            space_reserve: runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
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
        home_mount_ms,
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
                home_mount_ms = ?home_mount_ms,
                guest_restore_ms = ?guest_restore_ms,
                exec_ms = ?exec_ms,
                total_ms,
                termination = ?exec_result.termination,
                exit_code,
                "benchmark complete"
            );
        }
        (Ok(_), Some(e)) => {
            info!(proxy_ms, factory_ms, boot_ms = ?boot_ms, home_mount_ms = ?home_mount_ms, guest_restore_ms = ?guest_restore_ms, exec_ms = ?exec_ms, total_ms, error = %e, "benchmark failed");
        }
        (Err(e), _) => {
            info!(proxy_ms, factory_ms, boot_ms = ?boot_ms, home_mount_ms = ?home_mount_ms, guest_restore_ms = ?guest_restore_ms, exec_ms = ?exec_ms, total_ms, error = %e, "benchmark failed");
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
    write_terminal_diagnostic(
        stderr,
        &result.termination,
        &result.stderr,
        &result.diagnostic,
        false,
        &mut line_open,
    );
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
        model_usage_long_context_min_total_input_tokens: None,
        pi_model_config: None,
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
    let mount_result = ensure_home_drive_mounted(sandbox, sandbox.id()).await;
    timing.home_mount_ms = Some(t_mount.elapsed().as_millis());
    if let Err(e) = mount_result {
        return (Err(e.error.into()), timing);
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
mod tests;
