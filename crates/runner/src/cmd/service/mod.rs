use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

#[cfg(test)]
use crate::config::RootfsSnapshotPathsExt;
use crate::error::{RunnerError, RunnerResult};
use crate::live_runner_instances::{self, LiveRunnerInstance};
use crate::status_file::{self, StatusFileReadError, StatusForReadiness};
use clap::{Args, Subcommand};
use runner_host::paths::{HomePaths, touch_mtime};
use sha2::{Digest, Sha256};
use tokio::time::{Duration as TokioDuration, Instant as TokioInstant};
use tracing::{info, warn};

mod drain_override;
mod drain_override_cleanup;
mod drain_resume;
mod gate;
mod install;
mod prune_idle;
mod reload;
mod signal;
mod state;
mod stop;
mod unit_file;

pub(crate) use runner_host::service::{
    RunnerServiceUnit, is_unit_active, is_unit_enabled, read_unit_config_path,
};

use drain_override::remove_drain_restart_override;
use drain_override_cleanup::reconcile_drain_restart_override_removal;
use gate::{ActiveJobsGateOps, check_active_jobs_gate};
use reload::{SystemdReloadPolicy, SystemdReloadRequirement, coordinate_systemd_reload};
use runner_host::service::{
    BoundedSystemctlQuery, all_units_pattern, is_unit_active_bounded_query, journalctl_logs_status,
    read_unit_config_path_bounded, run_systemctl,
};
use unit_file::{
    RUNNER_SERVICE_CONTROL_SUBGROUP_DIRECTIVE, RUNNER_SERVICE_CPU_DELEGATION_DIRECTIVE,
    RUNNER_SERVICE_NOFILE_LIMIT_DIRECTIVE, cleanup_unit_staging_files, remove_unit_file_if_exists,
    resolve_config_path, validate_current_exe_path, validate_env_vars, validate_systemd_path,
};

const SERVICE_CONFIG_SNAPSHOT_DIR: &str = "service-config-snapshots";

#[derive(Args)]
pub struct ServiceArgs {
    #[command(subcommand)]
    command: ServiceCommand,
}

#[derive(Subcommand)]
enum ServiceCommand {
    /// Start runner as a transient systemd service (CI, does not survive reboot)
    Start(ServiceRunArgs),
    /// Stop the runner service
    Stop(stop::StopArgs),
    /// Install runner as a persistent systemd service (production, survives reboot)
    Install(ServiceRunArgs),
    /// Uninstall the runner service (stop + disable + remove unit)
    Uninstall(ServiceUninstallArgs),
    /// Drain without waiting for active jobs (waits for bounded same-process acknowledgement)
    Drain(drain_resume::DrainArgs),
    /// Resume a draining runner (SIGUSR2, reverses `drain` before teardown begins)
    Resume(drain_resume::ResumeArgs),
    /// Reclaim only exact idle sandboxes in an explicitly identified process generation
    PruneIdle(prune_idle::PruneIdleArgs),
    /// Wait until a runner service is active and job-admitting. On success, emit the resolved
    /// max_concurrent as one machine-readable integer line on stdout for scripts; diagnostics go
    /// to stderr.
    WaitRunning(ServiceWaitRunningArgs),
    /// Show machine-readable systemd unit state for runner services
    UnitState(state::UnitStateArgs),
    /// Show service status (all runner services if --name is omitted)
    Status(ServiceStatusArgs),
    /// Show service logs
    Logs(ServiceLogsArgs),
}

/// Common arguments shared by `service start` and `service install`.
#[derive(Args)]
struct ServiceRunArgs {
    /// Path to runner config YAML to snapshot for service activation
    #[arg(long, short)]
    config: PathBuf,
    /// Service name suffix (e.g. v0.2.0 → unit vm0-runner-v0.2.0)
    #[arg(long)]
    name: String,
    /// Environment variables to pass to the service (KEY=VALUE)
    #[arg(long, value_name = "KEY=VALUE")]
    env: Vec<String>,
    /// Use local file queue provider instead of API
    #[arg(long)]
    local: bool,
}

#[derive(Args)]
struct ServiceUninstallArgs {
    /// Service name suffix (e.g. v0.2.0 → unit vm0-runner-v0.2.0)
    #[arg(long)]
    name: String,
    /// Skip active-jobs pre-check and force uninstall (active jobs will be killed).
    #[arg(long)]
    force: bool,
}

#[derive(Args)]
struct ServiceWaitRunningArgs {
    /// Service name suffix (e.g. v0.2.0 -> unit vm0-runner-v0.2.0)
    #[arg(long)]
    name: String,
    /// Maximum time to wait for status.json mode=running.
    #[arg(long, default_value_t = 120)]
    timeout_secs: u64,
}

#[derive(Args)]
struct ServiceStatusArgs {
    /// Service name suffix (omit to show all runner services)
    #[arg(long)]
    name: Option<String>,
}

#[derive(Args)]
struct ServiceLogsArgs {
    /// Service name suffix (e.g. v0.2.0 → unit vm0-runner-v0.2.0)
    #[arg(long)]
    name: String,
    /// Follow log output
    #[arg(long, short)]
    follow: bool,
    /// Number of lines to show
    #[arg(long, short, default_value = "100")]
    lines: u32,
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

pub async fn run_service(args: ServiceArgs) -> RunnerResult<()> {
    if let ServiceCommand::Start(args) | ServiceCommand::Install(args) = &args.command {
        validate_env_vars(&args.env)?;
    }

    match args.command {
        ServiceCommand::Start(a) => start(a).await,
        ServiceCommand::Stop(a) => stop::run(a).await,
        ServiceCommand::Install(a) => install::run(a).await,
        ServiceCommand::Uninstall(a) => uninstall(a).await,
        ServiceCommand::Drain(a) => drain_resume::run_drain(a).await,
        ServiceCommand::Resume(a) => drain_resume::run_resume(a).await,
        ServiceCommand::PruneIdle(a) => prune_idle::run(a).await,
        ServiceCommand::WaitRunning(a) => wait_running(a).await,
        ServiceCommand::UnitState(a) => state::run(a).await,
        ServiceCommand::Status(a) => status(a).await,
        ServiceCommand::Logs(a) => logs(a).await,
    }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async fn acquire_service_lock(
    unit: &RunnerServiceUnit,
    home: &HomePaths,
) -> RunnerResult<nix::fcntl::Flock<std::fs::File>> {
    Ok(runner_host::lock::acquire(unit.lock_path(home)).await?)
}

struct ServiceActivationConfig {
    snapshot_path: PathBuf,
    image_artifact_guards: crate::config::LockedRunnerImageArtifacts,
}

fn service_activation_config_snapshot_path(
    unit: &RunnerServiceUnit,
    base_dir: &Path,
    snapshot_content: &[u8],
) -> PathBuf {
    let digest = hex::encode(Sha256::digest(snapshot_content));
    base_dir
        .join(SERVICE_CONFIG_SNAPSHOT_DIR)
        .join(format!("{}-{digest}.yaml", unit.suffix()))
}

fn systemd_run_limit_nofile_property_arg() -> String {
    format!("--property={RUNNER_SERVICE_NOFILE_LIMIT_DIRECTIVE}")
}

fn systemd_run_cpu_delegation_property_args() -> [String; 2] {
    [
        format!("--property={RUNNER_SERVICE_CPU_DELEGATION_DIRECTIVE}"),
        format!("--property={RUNNER_SERVICE_CONTROL_SUBGROUP_DIRECTIVE}"),
    ]
}

fn systemd_run_command(
    unit: &RunnerServiceUnit,
    exe_path: &Path,
    config_path: &Path,
    env_vars: &[String],
    local: bool,
) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("systemd-run");
    command
        .arg(format!("--unit={}", unit.unit_name()))
        .arg(format!("--description=Okou Runner ({})", unit.unit_name()))
        .arg("--expand-environment=no")
        .args([
            "--property=Type=exec",
            "--property=Restart=on-failure",
            "--property=RestartSec=5",
            "--property=StandardOutput=journal",
            "--property=StandardError=journal",
            "--property=KillSignal=SIGTERM",
            "--property=TimeoutStopSec=300",
        ])
        .arg(systemd_run_limit_nofile_property_arg());
    for property in systemd_run_cpu_delegation_property_args() {
        command.arg(property);
    }
    command.arg(format!("--property=SyslogIdentifier={}", unit.unit_name()));
    for entry in env_vars {
        command.arg(format!("--setenv={entry}"));
    }
    command
        .arg(exe_path)
        .args(["start", "--config"])
        .arg(config_path);
    if local {
        command.arg("--local");
    }
    command
}

type ServiceFuture<'a, T> = Pin<Box<dyn Future<Output = RunnerResult<T>> + 'a>>;

async fn prepare_service_activation_config(
    unit: &RunnerServiceUnit,
    config_path: &Path,
    home: &HomePaths,
) -> RunnerResult<ServiceActivationConfig> {
    let runner_config = crate::config::load(config_path).await?;
    let snapshot_content = serde_yaml_ng::to_string(&runner_config)
        .map_err(|e| RunnerError::Config(format!("serialize activation config snapshot: {e}")))?;
    let snapshot_path = service_activation_config_snapshot_path(
        unit,
        &runner_config.base_dir,
        snapshot_content.as_bytes(),
    );
    validate_systemd_path("activation config path", &snapshot_path)?;

    let image_artifact_guards =
        crate::config::lock_and_validate_runner_image_artifacts(&runner_config.profiles, home)
            .await?;

    runner_host::private_fs::ensure_private_dir(&runner_config.base_dir).await?;
    let snapshot_dir = snapshot_path.parent().ok_or_else(|| {
        RunnerError::Internal(format!(
            "activation config snapshot path has no parent: {}",
            snapshot_path.display()
        ))
    })?;
    runner_host::private_fs::ensure_private_dir(snapshot_dir).await?;
    runner_host::private_fs::write_private_file(&snapshot_path, snapshot_content.as_bytes())
        .await?;

    Ok(ServiceActivationConfig {
        snapshot_path,
        image_artifact_guards,
    })
}

async fn with_service_activation_image_artifacts<T, Fut>(
    unit: &RunnerServiceUnit,
    config_path: &Path,
    home: &HomePaths,
    activation: impl FnOnce(PathBuf) -> Fut,
) -> RunnerResult<T>
where
    Fut: Future<Output = RunnerResult<T>>,
{
    let activation_config = prepare_service_activation_config(unit, config_path, home).await?;

    let output = activation(activation_config.snapshot_path).await?;
    touch_service_activation_image_artifacts(&activation_config.image_artifact_guards);
    Ok(output)
}

fn touch_service_activation_image_artifacts(
    image_artifact_guards: &crate::config::LockedRunnerImageArtifacts,
) {
    for (_, profile_paths) in image_artifact_guards.profile_paths() {
        touch_mtime(profile_paths.rootfs_paths().dir());
        touch_mtime(profile_paths.snapshot_paths().dir());
    }
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

/// `service start` — transient unit via systemd-run (CI).
async fn start(args: ServiceRunArgs) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    let home = HomePaths::new()?;
    let _service_lock = acquire_service_lock(&unit, &home).await?;

    if is_unit_active(&unit).await? {
        return Err(RunnerError::Internal(format!(
            "unit {} is already running, stop it first with: runner service stop --name {}",
            unit.unit_name(),
            args.name
        )));
    }

    let config_path = resolve_config_path(&args.config)?;
    let exe_path = validate_current_exe_path(
        std::env::current_exe().map_err(|e| RunnerError::Internal(format!("current_exe: {e}")))?,
    )?;
    validate_systemd_path("current executable path", &exe_path)?;
    validate_systemd_path("config path", &config_path)?;
    reconcile_drain_restart_override_removal(&unit, SystemdReloadPolicy::Unbounded).await?;

    let unit_for_start = unit.clone();
    with_service_activation_image_artifacts(
        &unit,
        &config_path,
        &home,
        |snapshot_path| async move {
            let mut cmd = systemd_run_command(
                &unit_for_start,
                &exe_path,
                &snapshot_path,
                &args.env,
                args.local,
            );

            let status = cmd
                .status()
                .await
                .map_err(|e| RunnerError::Internal(format!("spawn systemd-run: {e}")))?;

            if !status.success() {
                return Err(RunnerError::Internal(format!(
                    "systemd-run failed: {status}"
                )));
            }
            Ok(())
        },
    )
    .await?;

    info!(unit = %unit.unit_name(), "transient service started");
    Ok(())
}

/// Stop + disable + remove the unit file for the given service unit.
///
/// Best-effort for already-stopped or missing services, but refuses to remove
/// unit files when `systemctl stop` fails and the service still appears active.
///
/// Callers that can race with install/uninstall/GC must hold the service lock.
pub(crate) async fn uninstall_service_unit(unit: &RunnerServiceUnit) -> RunnerResult<()> {
    // Best-effort stop + disable (may already be stopped/disabled).
    let stop_result = run_systemctl(&["stop", unit.service_name()]).await;
    if let Err(e) = &stop_result {
        warn!(unit = %unit.unit_name(), error = %e, "failed to stop service during uninstall");
    }
    match stop_result {
        Ok(()) => {}
        Err(_) => match is_unit_active(unit).await {
            Ok(false) => {}
            Ok(true) => {
                return Err(RunnerError::Internal(format!(
                    "failed to stop active service {}; refusing to remove unit files",
                    unit.unit_name()
                )));
            }
            Err(e) => {
                return Err(RunnerError::Internal(format!(
                    "failed to stop service {} and could not verify it is inactive; refusing to remove unit files: {e}",
                    unit.unit_name()
                )));
            }
        },
    };

    let _ = run_systemctl(&["disable", "--no-reload", unit.service_name()]).await;

    // Remove the unit file if it exists.
    let upath = unit.unit_file_path();
    if let Err(e) = cleanup_unit_staging_files(upath) {
        warn!(unit = %unit.unit_name(), error = %e, "failed to remove stale unit staging files");
    }
    if let Err(e) = remove_unit_file_if_exists(upath) {
        warn!(unit = %unit.unit_name(), error = %e, "failed to remove unit file");
    }
    match remove_drain_restart_override(unit) {
        Ok(_) => {}
        Err(e) => {
            warn!(unit = %unit.unit_name(), error = %e, "failed to remove drain restart override");
        }
    }

    coordinate_systemd_reload(
        unit,
        SystemdReloadRequirement::dirty().with_drain_override(false),
        SystemdReloadPolicy::Unbounded,
    )
    .await?;

    info!(unit = %unit.unit_name(), "service uninstalled");
    Ok(())
}

/// `service uninstall` — stop + disable + remove unit file.
///
/// Refuses when the runner has active jobs unless `--force` is passed.
trait ServiceUninstallOps: ActiveJobsGateOps {
    type LockGuard;

    fn acquire_lock<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        home: &'a HomePaths,
    ) -> ServiceFuture<'a, Self::LockGuard>
    where
        Self::LockGuard: 'a;

    fn uninstall_unit<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()>;
}

struct RealServiceUninstallOps;

impl ActiveJobsGateOps for RealServiceUninstallOps {
    fn is_unit_active<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, bool> {
        Box::pin(async move { is_unit_active(unit).await.map_err(Into::into) })
    }

    fn read_unit_config_path<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, Option<PathBuf>> {
        Box::pin(async move { read_unit_config_path(unit).await.map_err(Into::into) })
    }
}

impl ServiceUninstallOps for RealServiceUninstallOps {
    type LockGuard = nix::fcntl::Flock<std::fs::File>;

    fn acquire_lock<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        home: &'a HomePaths,
    ) -> ServiceFuture<'a, Self::LockGuard>
    where
        Self::LockGuard: 'a,
    {
        Box::pin(async move { acquire_service_lock(unit, home).await })
    }

    fn uninstall_unit<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, ()> {
        Box::pin(async move { uninstall_service_unit(unit).await })
    }
}

async fn uninstall(args: ServiceUninstallArgs) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    let home = HomePaths::new()?;
    uninstall_with_ops(&unit, &home, args.force, &mut RealServiceUninstallOps).await
}

async fn uninstall_with_ops(
    unit: &RunnerServiceUnit,
    home: &HomePaths,
    force: bool,
    ops: &mut impl ServiceUninstallOps,
) -> RunnerResult<()> {
    let _service_lock = ops.acquire_lock(unit, home).await?;
    check_active_jobs_gate(unit, home, force, "uninstall", ops).await?;
    ops.uninstall_unit(unit).await
}

fn selected_config_live_instance_from_instances(
    unit: &RunnerServiceUnit,
    config_path: &Path,
    instances: &[LiveRunnerInstance],
) -> RunnerResult<Option<LiveRunnerInstance>> {
    let matches = instances
        .iter()
        .filter(|instance| instance.config_path == config_path && instance.subcommand == "start")
        .collect::<Vec<_>>();

    match matches.as_slice() {
        [instance] => Ok(Some((*instance).clone())),
        [] => Ok(None),
        _ => Err(RunnerError::Internal(format!(
            "{} has multiple live runner instance records for selected config {}",
            unit.unit_name(),
            config_path.display()
        ))),
    }
}

async fn selected_config_live_instance(
    unit: &RunnerServiceUnit,
    config_path: &Path,
    home: &HomePaths,
) -> RunnerResult<Option<LiveRunnerInstance>> {
    let instances = live_runner_instances::try_list(home).await?;
    selected_config_live_instance_from_instances(unit, config_path, &instances)
}

async fn selected_config_base_dir(
    unit: &RunnerServiceUnit,
    config_path: &Path,
    home: &HomePaths,
) -> RunnerResult<Option<PathBuf>> {
    Ok(selected_config_live_instance(unit, config_path, home)
        .await?
        .map(|instance| instance.base_dir))
}

fn wait_running_timeout_error(
    timeout_secs: u64,
    unit: &RunnerServiceUnit,
    last_observation: &str,
) -> RunnerError {
    RunnerError::Internal(format!(
        "timed out waiting {timeout_secs}s for {} to reach running (last observation: {last_observation})",
        unit.unit_name()
    ))
}

fn wait_running_remaining(
    deadline: TokioInstant,
    timeout_secs: u64,
    unit: &RunnerServiceUnit,
    last_observation: &str,
) -> RunnerResult<TokioDuration> {
    let remaining = deadline.saturating_duration_since(TokioInstant::now());
    if remaining.is_zero() {
        return Err(wait_running_timeout_error(
            timeout_secs,
            unit,
            last_observation,
        ));
    }
    Ok(remaining)
}

async fn wait_running(args: ServiceWaitRunningArgs) -> RunnerResult<()> {
    if args.timeout_secs == 0 {
        return Err(RunnerError::Internal(
            "--timeout-secs must be greater than zero".into(),
        ));
    }

    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    let deadline = TokioInstant::now()
        .checked_add(TokioDuration::from_secs(args.timeout_secs))
        .ok_or_else(|| RunnerError::Internal("--timeout-secs is too large".into()))?;
    let mut last_observation = "not checked".to_string();
    let home = HomePaths::new()?;
    let config_path = match read_unit_config_path_bounded(
        &unit,
        wait_running_remaining(deadline, args.timeout_secs, &unit, &last_observation)?,
    )
    .await?
    {
        BoundedSystemctlQuery::Completed(Some(config_path)) => config_path,
        BoundedSystemctlQuery::Completed(None) => {
            return Err(RunnerError::Internal(format!(
                "{} does not select a runner --config path",
                unit.unit_name()
            )));
        }
        BoundedSystemctlQuery::TimedOut => {
            return Err(wait_running_timeout_error(
                args.timeout_secs,
                &unit,
                &last_observation,
            ));
        }
    };

    loop {
        let active = match is_unit_active_bounded_query(
            &unit,
            wait_running_remaining(deadline, args.timeout_secs, &unit, &last_observation)?,
        )
        .await?
        {
            BoundedSystemctlQuery::Completed(active) => active,
            BoundedSystemctlQuery::TimedOut => {
                return Err(wait_running_timeout_error(
                    args.timeout_secs,
                    &unit,
                    &last_observation,
                ));
            }
        };
        if !active {
            return Err(RunnerError::Internal(format!(
                "{} is not active while waiting for running (last observation: {})",
                unit.unit_name(),
                last_observation
            )));
        }

        let base_dir = match tokio::time::timeout_at(
            deadline,
            selected_config_base_dir(&unit, &config_path, &home),
        )
        .await
        {
            Ok(result) => result?,
            Err(_) => {
                return Err(wait_running_timeout_error(
                    args.timeout_secs,
                    &unit,
                    &last_observation,
                ));
            }
        };
        match base_dir {
            Some(base_dir) => {
                let status = match tokio::time::timeout_at(
                    deadline,
                    status_file::read_as::<StatusForReadiness>(&base_dir),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => {
                        return Err(wait_running_timeout_error(
                            args.timeout_secs,
                            &unit,
                            &last_observation,
                        ));
                    }
                };
                match status {
                    Ok(Some(status)) => match status.mode.as_str() {
                        "running" => {
                            println!("{}", status.max_concurrent);
                            return Ok(());
                        }
                        "starting" => {
                            last_observation = "mode=starting".to_string();
                        }
                        "draining" | "stopping" | "stopped" => {
                            return Err(RunnerError::Internal(format!(
                                "{} reported mode={} while waiting for running",
                                unit.unit_name(),
                                status.mode
                            )));
                        }
                        mode => {
                            return Err(RunnerError::Internal(format!(
                                "{} reported unknown mode {:?} while waiting for running",
                                unit.unit_name(),
                                mode
                            )));
                        }
                    },
                    Ok(None) => {
                        last_observation =
                            format!("{} missing", status_file::path(&base_dir).display());
                    }
                    Err(StatusFileReadError::Read { path, error }) => {
                        return Err(RunnerError::Internal(format!(
                            "read {} while waiting for {} to run: {error}",
                            path.display(),
                            unit.unit_name()
                        )));
                    }
                    Err(StatusFileReadError::ParseJson { path, error }) => {
                        return Err(RunnerError::Internal(format!(
                            "parse {} while waiting for {} to run: {error}",
                            path.display(),
                            unit.unit_name()
                        )));
                    }
                }
            }
            None => {
                last_observation = "live runner instance record missing".to_string();
            }
        }

        let remaining =
            wait_running_remaining(deadline, args.timeout_secs, &unit, &last_observation)?;
        tokio::time::sleep(std::cmp::min(TokioDuration::from_secs(1), remaining)).await;
    }
}

/// `service status` — show systemctl status for the named unit, or all runner units.
async fn status(args: ServiceStatusArgs) -> RunnerResult<()> {
    let pattern = match &args.name {
        Some(suffix) => RunnerServiceUnit::from_suffix(suffix)?
            .service_name()
            .to_string(),
        None => all_units_pattern(),
    };
    // Inherit stdout so user sees output directly.
    // systemctl status returns exit code 3 for inactive — ignore exit code.
    tokio::process::Command::new("systemctl")
        .args(["status", &pattern])
        .status()
        .await
        .map_err(|e| RunnerError::Internal(format!("spawn systemctl: {e}")))?;
    Ok(())
}

/// `service logs` — show journalctl output for the named unit.
async fn logs(args: ServiceLogsArgs) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    let lines = args.lines.to_string();
    let mut cmd = tokio::process::Command::new("journalctl");
    cmd.args(["--unit", unit.service_name(), "--lines", &lines]);
    if args.follow {
        cmd.arg("--follow");
    }
    let status = cmd
        .status()
        .await
        .map_err(|e| RunnerError::Internal(format!("spawn journalctl: {e}")))?;
    journalctl_logs_status(unit.service_name(), status).map_err(Into::into)
}

#[cfg(test)]
mod tests;
