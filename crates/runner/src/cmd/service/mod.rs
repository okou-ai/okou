use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use crate::error::{RunnerError, RunnerResult};
use crate::live_runner_instances::{self, LiveRunnerInstance};
use crate::paths::{HomePaths, touch_mtime};
use crate::status_file::{self, StatusFileReadError, StatusForReadiness};
use clap::{Args, Subcommand};
use sha2::{Digest, Sha256};
use tokio::time::{Duration as TokioDuration, Instant as TokioInstant};
use tracing::{info, warn};

mod diagnostic;
mod drain_override;
mod drain_override_cleanup;
mod drain_resume;
mod gate;
mod prune_idle;
mod reload;
mod signal;
mod state;
mod stop;
mod systemctl;
mod target;
mod unit_config;
mod unit_file;

pub(crate) use systemctl::{is_unit_active, is_unit_enabled};
pub(crate) use target::RunnerServiceUnit;
pub(crate) use unit_config::read_unit_config_path;

use drain_override::{remove_drain_restart_override, write_drain_restart_override};
use drain_override_cleanup::{DrainOverrideReloadPolicy, reconcile_drain_restart_override_removal};
use gate::{ActiveJobsGateOps, check_active_jobs_gate};
use reload::{SystemdReloadRequirement, coordinate_systemd_reload};
use systemctl::{
    BoundedSystemctlQuery, SystemdUnitEnablement, is_unit_active_bounded_query,
    journalctl_logs_status, read_unit_enablement, restore_unit_enablement, run_systemctl,
};
use unit_config::read_unit_config_path_bounded;
use unit_file::{
    RUNNER_SERVICE_CONTROL_SUBGROUP_DIRECTIVE, RUNNER_SERVICE_CPU_DELEGATION_DIRECTIVE,
    RUNNER_SERVICE_NOFILE_LIMIT_DIRECTIVE, cleanup_unit_staging_files, generate_unit_file,
    remove_unit_file_if_exists, resolve_config_path, validate_current_exe_path, validate_env_vars,
    validate_systemd_path, write_unit_file,
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
        ServiceCommand::Install(a) => install(a).await,
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
    crate::lock::acquire(unit.lock_path(home)).await
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

async fn restore_service_state_after_reload_failure(
    unit: &RunnerServiceUnit,
    prior_enablement: SystemdUnitEnablement,
    restore_drain_override: bool,
) -> RunnerResult<()> {
    let mut failures = Vec::new();

    if restore_drain_override && let Err(error) = write_drain_restart_override(unit) {
        failures.push(format!("restore drain restart override: {error}"));
    }

    if let Err(error) = restore_unit_enablement(unit, prior_enablement).await {
        failures.push(format!("restore boot enablement: {error}"));
    }

    let requirement = if restore_drain_override {
        SystemdReloadRequirement::dirty_or_not_found().with_drain_override(true)
    } else {
        SystemdReloadRequirement::dirty_or_not_found()
    };
    if let Err(error) = coordinate_systemd_reload(unit, requirement).await {
        failures.push(format!("reload restored systemd state: {error}"));
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(RunnerError::Internal(format!(
            "failed to restore service state for {}: {}",
            unit.unit_name(),
            failures.join("; ")
        )))
    }
}

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

    crate::private_fs::ensure_private_dir(&runner_config.base_dir).await?;
    let snapshot_dir = snapshot_path.parent().ok_or_else(|| {
        RunnerError::Internal(format!(
            "activation config snapshot path has no parent: {}",
            snapshot_path.display()
        ))
    })?;
    crate::private_fs::ensure_private_dir(snapshot_dir).await?;
    crate::private_fs::write_private_file(&snapshot_path, snapshot_content.as_bytes()).await?;

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
    reconcile_drain_restart_override_removal(&unit, DrainOverrideReloadPolicy::Unbounded).await?;

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

/// `service install` — persistent unit file (production).
async fn install(args: ServiceRunArgs) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    let home = HomePaths::new()?;
    let _service_lock = acquire_service_lock(&unit, &home).await?;

    let config_path = resolve_config_path(&args.config)?;
    let exe_path = validate_current_exe_path(
        std::env::current_exe().map_err(|e| RunnerError::Internal(format!("current_exe: {e}")))?,
    )?;
    validate_systemd_path("current executable path", &exe_path)?;
    validate_systemd_path("config path", &config_path)?;

    let unit_for_activation = unit.clone();
    let upath = unit.unit_file_path().to_path_buf();
    let prior_enablement = read_unit_enablement(&unit).await?;

    with_service_activation_image_artifacts(
        &unit,
        &config_path,
        &home,
        |snapshot_path| async move {
            let unit_content = generate_unit_file(
                &unit_for_activation,
                &exe_path,
                &snapshot_path,
                &args.env,
                args.local,
            );
            let drain_override_removed = if is_unit_active(&unit_for_activation).await? {
                warn!(
                    unit = %unit_for_activation.unit_name(),
                    "skipping drain restart override cleanup while service is active"
                );
                false
            } else {
                remove_drain_restart_override(&unit_for_activation)?
            };
            cleanup_unit_staging_files(&upath)?;
            write_unit_file(&upath, &unit_content)?;

            let enable_result = run_systemctl(&[
                "enable",
                "--no-reload",
                unit_for_activation.service_name(),
            ])
            .await;
            let requirement = if drain_override_removed {
                SystemdReloadRequirement::dirty_or_not_found().with_drain_override(false)
            } else {
                SystemdReloadRequirement::dirty_or_not_found()
            };
            let reload_result =
                coordinate_systemd_reload(&unit_for_activation, requirement).await;

            if let Err(reload_error) = reload_result {
                let primary_error = match enable_result {
                    Ok(()) => reload_error,
                    Err(enable_error) => RunnerError::Internal(format!(
                        "failed to enable {}: {enable_error}; additionally failed to reload systemd: {reload_error}",
                        unit_for_activation.unit_name()
                    )),
                };
                return match restore_service_state_after_reload_failure(
                    &unit_for_activation,
                    prior_enablement,
                    drain_override_removed,
                )
                .await
                {
                    Ok(()) => Err(primary_error),
                    Err(rollback_error) => Err(RunnerError::Internal(format!(
                        "install failed for {}: {primary_error}; additionally failed to restore service state: {rollback_error}",
                        unit_for_activation.unit_name()
                    ))),
                };
            }
            enable_result?;
            run_systemctl(&["start", unit_for_activation.service_name()]).await?;
            Ok(())
        },
    )
    .await?;

    info!(unit = %unit.unit_name(), "service installed and started");
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
        Box::pin(async move { is_unit_active(unit).await })
    }

    fn read_unit_config_path<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, Option<PathBuf>> {
        Box::pin(async move { read_unit_config_path(unit).await })
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
        None => target::all_units_pattern(),
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
    journalctl_logs_status(unit.service_name(), status)
}

runner_test_group!(cmd_service; #[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant as StdInstant, SystemTime};

    use clap::Parser;

    use super::*;
    use crate::paths::RootfsPaths;
    use crate::process::read_process_stat;
    use crate::test_fixtures::ignored_child::{
        ignored_child_test_env_guard_enabled, run_ignored_child_test,
    };

    const TEST_ROOTFS_HASH: &str =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const TEST_SNAPSHOT_HASH: &str =
        "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    const WAIT_RUNNING_SCENARIO_ENV: &str = "OKOU_RUN_SERVICE_WAIT_RUNNING_SCENARIO";
    const WAIT_RUNNING_PID_PATH_ENV: &str = "OKOU_RUN_SERVICE_WAIT_RUNNING_PID_PATH";
    const WAIT_RUNNING_COUNT_PATH_ENV: &str = "OKOU_RUN_SERVICE_WAIT_RUNNING_COUNT_PATH";
    const WAIT_RUNNING_CHILD_TEST: &str =
        "cmd::service::tests::wait_running_systemctl_timeout_child";
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
    workspace_disk_mb: 16384
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
        let error = crate::lock::try_acquire(home.rootfs_lock(TEST_ROOTFS_HASH))
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("lock is already held"),
            "unexpected rootfs lock error: {error}"
        );

        let snapshot_err = crate::lock::try_acquire(home.snapshot_lock(TEST_SNAPSHOT_HASH))
            .await
            .unwrap_err();
        assert!(
            snapshot_err.to_string().contains("lock is already held"),
            "unexpected snapshot lock error: {snapshot_err}"
        );
    }

    async fn assert_artifact_locks_released(home: &HomePaths) {
        drop(
            crate::lock::try_acquire(home.rootfs_lock(TEST_ROOTFS_HASH))
                .await
                .unwrap(),
        );

        let snapshot_lock = crate::lock::try_acquire(home.snapshot_lock(TEST_SNAPSHOT_HASH))
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
        fn is_unit_active<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, bool> {
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
        let instance =
            selected_config_live_instance_from_instances(&unit, &config_path, &[]).unwrap();

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

        let instance =
            selected_config_live_instance_from_instances(&unit, &config_path, &instances)
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

        let error = selected_config_live_instance_from_instances(&unit, &config_path, &instances)
            .unwrap_err();

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
        let different =
            service_activation_config_snapshot_path(&unit, base_dir, b"group: different\n");

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
});
