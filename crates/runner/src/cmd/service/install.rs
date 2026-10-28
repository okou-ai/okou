//! Installation retains drain-override removal ownership through reload failure.
//! Directory-only cleanup still warrants the forward absence reload, but only
//! removal of the override file authorizes recreating it during compensation.

use std::path::Path;

use runner_host::paths::HomePaths;
use runner_host::service::{
    SystemdUnitEnablement, is_unit_active, read_unit_enablement, restore_unit_enablement,
    run_systemctl,
};
use tracing::{info, warn};

use crate::error::{RunnerError, RunnerResult};

use super::drain_override::{
    DrainRestartOverrideRemoval, RUNTIME_SYSTEMD_SYSTEM_DIR, remove_drain_restart_override_at,
    write_drain_restart_override_at,
};
use super::reload::{SystemdReloadPolicy, SystemdReloadRequirement, coordinate_systemd_reload};
use super::unit_file::{
    cleanup_unit_staging_files, generate_unit_file, resolve_config_path, validate_current_exe_path,
    validate_systemd_path, write_unit_file,
};
use super::{
    RunnerServiceUnit, ServiceFuture, ServiceRunArgs, acquire_service_lock,
    with_service_activation_image_artifacts,
};

trait ServiceInstallOps {
    fn is_active<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, bool>;
    fn systemctl<'a>(&'a mut self, args: &'a [&'a str]) -> ServiceFuture<'a, ()>;
    fn restore_enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        enablement: SystemdUnitEnablement,
    ) -> ServiceFuture<'a, ()>;
    fn reload<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        requirement: SystemdReloadRequirement,
    ) -> ServiceFuture<'a, ()>;
}

struct RealServiceInstallOps;

impl ServiceInstallOps for RealServiceInstallOps {
    fn is_active<'a>(&'a mut self, unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, bool> {
        Box::pin(async move { is_unit_active(unit).await.map_err(Into::into) })
    }

    fn systemctl<'a>(&'a mut self, args: &'a [&'a str]) -> ServiceFuture<'a, ()> {
        Box::pin(async move { run_systemctl(args).await.map_err(Into::into) })
    }

    fn restore_enablement<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        enablement: SystemdUnitEnablement,
    ) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            restore_unit_enablement(unit, enablement)
                .await
                .map_err(Into::into)
        })
    }

    fn reload<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        requirement: SystemdReloadRequirement,
    ) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            coordinate_systemd_reload(unit, requirement, SystemdReloadPolicy::Unbounded)
                .await
                .map(|_| ())
        })
    }
}

async fn restore_service_state_after_reload_failure(
    unit: &RunnerServiceUnit,
    runtime_systemd_dir: &Path,
    prior_enablement: SystemdUnitEnablement,
    drain_override_removal: Option<DrainRestartOverrideRemoval>,
    ops: &mut impl ServiceInstallOps,
) -> RunnerResult<()> {
    let mut failures = Vec::new();
    let restore_drain_override =
        drain_override_removal.is_some_and(DrainRestartOverrideRemoval::override_removed);

    if restore_drain_override
        && let Err(error) = write_drain_restart_override_at(runtime_systemd_dir, unit)
    {
        failures.push(format!("restore drain restart override: {error}"));
    }

    if let Err(error) = ops.restore_enablement(unit, prior_enablement).await {
        failures.push(format!("restore boot enablement: {error}"));
    }

    let requirement = if restore_drain_override {
        SystemdReloadRequirement::dirty_or_not_found().with_drain_override(true)
    } else {
        SystemdReloadRequirement::dirty_or_not_found()
    };
    if let Err(error) = ops.reload(unit, requirement).await {
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

async fn activate_with_ops(
    unit: &RunnerServiceUnit,
    unit_path: &Path,
    runtime_systemd_dir: &Path,
    unit_content: &str,
    prior_enablement: SystemdUnitEnablement,
    ops: &mut impl ServiceInstallOps,
) -> RunnerResult<()> {
    let drain_override_removal = if ops.is_active(unit).await? {
        warn!(
            unit = %unit.unit_name(),
            "skipping drain restart override cleanup while service is active"
        );
        None
    } else {
        Some(remove_drain_restart_override_at(runtime_systemd_dir, unit)?)
    };
    cleanup_unit_staging_files(unit_path)?;
    write_unit_file(unit_path, unit_content)?;

    let enable_result = ops
        .systemctl(&["enable", "--no-reload", unit.service_name()])
        .await;
    let requirement =
        if drain_override_removal.is_some_and(DrainRestartOverrideRemoval::reload_required) {
            SystemdReloadRequirement::dirty_or_not_found().with_drain_override(false)
        } else {
            SystemdReloadRequirement::dirty_or_not_found()
        };
    let reload_result = ops.reload(unit, requirement).await;

    if let Err(reload_error) = reload_result {
        let primary_error = match enable_result {
            Ok(()) => reload_error,
            Err(enable_error) => RunnerError::Internal(format!(
                "failed to enable {}: {enable_error}; additionally failed to reload systemd: {reload_error}",
                unit.unit_name()
            )),
        };
        return match restore_service_state_after_reload_failure(
            unit,
            runtime_systemd_dir,
            prior_enablement,
            drain_override_removal,
            ops,
        )
        .await
        {
            Ok(()) => Err(primary_error),
            Err(rollback_error) => Err(RunnerError::Internal(format!(
                "install failed for {}: {primary_error}; additionally failed to restore service state: {rollback_error}",
                unit.unit_name()
            ))),
        };
    }
    enable_result?;
    ops.systemctl(&["start", unit.service_name()]).await
}

/// `service install` — persistent unit file (production).
pub(super) async fn run(args: ServiceRunArgs) -> RunnerResult<()> {
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
            activate_with_ops(
                &unit_for_activation,
                &upath,
                Path::new(RUNTIME_SYSTEMD_SYSTEM_DIR),
                &unit_content,
                prior_enablement,
                &mut RealServiceInstallOps,
            )
            .await
        },
    )
    .await?;

    info!(unit = %unit.unit_name(), "service installed and started");
    Ok(())
}

#[cfg(test)]
mod tests;
