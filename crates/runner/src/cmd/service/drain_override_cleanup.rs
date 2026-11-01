//! Reconciles Okou's drain restart override with systemd's effective state.
//!
//! Removing `50-vm0-drain.conf` changes the on-disk state, but systemd can keep
//! the drop-in loaded in `DropInPaths` until a coordinated reload. The cleanup
//! transaction therefore retains the removal outcome and always asks the
//! reload coordinator to make the expected absence effective, including when
//! the override is already absent or removal itself fails. This also repairs a
//! retry interrupted after disk removal but before the reload, while the
//! coordinator avoids an unnecessary daemon reload when effective state already
//! matches.
//!
//! Restoration is compensation for a failed absence reload, and is allowed
//! only after this attempt removed the override file (`OverrideRemoved`). A
//! `DirectoryRemoved` outcome means that only the empty drop-in directory was
//! removed, and `AlreadyAbsent` means that neither path was removed; neither
//! outcome owns restoration. Recreating `Restart=no` for either case could
//! reintroduce the drain policy that this cleanup is removing.
//!
//! The same unbounded or bounded reload policy is used for the forward absence
//! transition and for compensation back to expected presence. Cleanup-mode
//! stop supplies the bounded policy with its existing lock and systemd-command
//! timeouts. Removal, reload, restoration, and combined failures retain their
//! error context so that a partial transition is diagnosable.
//!
//! Transient `service start` and default `service stop` use the unbounded
//! policy; cleanup-mode `service stop` uses the bounded policy. Install and
//! uninstall retain their separate service-lifecycle ordering and rollback
//! contracts and are outside this transaction.

use crate::error::{RunnerError, RunnerResult};

use super::drain_override::{
    DrainRestartOverrideRemoval, remove_drain_restart_override_outcome,
    write_drain_restart_override,
};
use super::reload::{SystemdReloadPolicy, SystemdReloadRequirement, coordinate_systemd_reload};
use super::{RunnerServiceUnit, ServiceFuture};

trait DrainOverrideCleanupOps {
    fn remove_override(
        &mut self,
        unit: &RunnerServiceUnit,
    ) -> RunnerResult<DrainRestartOverrideRemoval>;
    fn restore_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<()>;
    fn reload<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        requirement: SystemdReloadRequirement,
        policy: SystemdReloadPolicy,
    ) -> ServiceFuture<'a, ()>;
}

struct RealDrainOverrideCleanupOps;

impl DrainOverrideCleanupOps for RealDrainOverrideCleanupOps {
    fn remove_override(
        &mut self,
        unit: &RunnerServiceUnit,
    ) -> RunnerResult<DrainRestartOverrideRemoval> {
        remove_drain_restart_override_outcome(unit)
    }

    fn restore_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<()> {
        write_drain_restart_override(unit).map(|_| ())
    }

    fn reload<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        requirement: SystemdReloadRequirement,
        policy: SystemdReloadPolicy,
    ) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            coordinate_systemd_reload(unit, requirement, policy)
                .await
                .map(|_| ())
        })
    }
}

fn cleanup_reload_error(
    unit: &RunnerServiceUnit,
    reload_error: RunnerError,
    restore_error: RunnerError,
) -> RunnerError {
    RunnerError::Internal(format!(
        "failed to reload systemd after removing drain restart override for {}: {reload_error}; additionally failed to restore drain restart override: {restore_error}",
        unit.unit_name()
    ))
}

async fn restore_after_failed_cleanup(
    unit: &RunnerServiceUnit,
    policy: SystemdReloadPolicy,
    ops: &mut impl DrainOverrideCleanupOps,
) -> RunnerResult<()> {
    if let Err(error) = ops.restore_override(unit) {
        return Err(RunnerError::Internal(format!(
            "failed to restore drain restart override for {} after cleanup reload failure: {error}",
            unit.unit_name()
        )));
    }

    if let Err(error) = ops
        .reload(
            unit,
            SystemdReloadRequirement::dirty().with_drain_override(true),
            policy,
        )
        .await
    {
        return Err(RunnerError::Internal(format!(
            "failed to reload systemd after restoring drain restart override for {}: {error}",
            unit.unit_name()
        )));
    }

    Ok(())
}

async fn reconcile_drain_restart_override_removal_with_ops(
    unit: &RunnerServiceUnit,
    policy: SystemdReloadPolicy,
    ops: &mut impl DrainOverrideCleanupOps,
) -> RunnerResult<()> {
    let remove_result = ops.remove_override(unit);
    let removed = remove_result
        .as_ref()
        .is_ok_and(|outcome| outcome.override_removed());

    let reload_result = ops
        .reload(
            unit,
            SystemdReloadRequirement::dirty().with_drain_override(false),
            policy,
        )
        .await;

    if let Err(reload_error) = reload_result {
        let reload_error = if removed {
            match restore_after_failed_cleanup(unit, policy, ops).await {
                Ok(()) => reload_error,
                Err(restore_error) => cleanup_reload_error(unit, reload_error, restore_error),
            }
        } else {
            reload_error
        };

        return match remove_result {
            Ok(_) => Err(reload_error),
            Err(remove_error) => Err(RunnerError::Internal(format!(
                "failed to remove drain restart override for {}: {remove_error}; additionally failed to reload systemd: {reload_error}",
                unit.unit_name()
            ))),
        };
    }

    remove_result.map(|_| ())
}

pub(super) async fn reconcile_drain_restart_override_removal(
    unit: &RunnerServiceUnit,
    policy: SystemdReloadPolicy,
) -> RunnerResult<()> {
    reconcile_drain_restart_override_removal_with_ops(
        unit,
        policy,
        &mut RealDrainOverrideCleanupOps,
    )
    .await
}

#[cfg(test)]
mod tests;
