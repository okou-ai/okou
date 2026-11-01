use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use tracing::warn;

use crate::error::{RunnerError, RunnerResult};

use super::unit_file::{cleanup_unit_staging_files, write_unit_file};
use runner_host::service::RunnerServiceUnit;

pub(super) const RUNTIME_SYSTEMD_SYSTEM_DIR: &str = "/run/systemd/system";
const DRAIN_DROP_IN_FILE_NAME: &str = "50-vm0-drain.conf";
const DRAIN_DROP_IN_CONTENT: &str = "[Service]\nRestart=no\n";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum DrainRestartOverrideWrite {
    Created,
    Replaced,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum DrainRestartOverrideRemoval {
    OverrideRemoved,
    DirectoryRemoved,
    AlreadyAbsent,
}

impl DrainRestartOverrideRemoval {
    pub(super) const fn override_removed(self) -> bool {
        matches!(self, Self::OverrideRemoved)
    }

    pub(super) const fn reload_required(self) -> bool {
        !matches!(self, Self::AlreadyAbsent)
    }
}

pub(super) fn write_drain_restart_override(
    unit: &RunnerServiceUnit,
) -> RunnerResult<DrainRestartOverrideWrite> {
    write_drain_restart_override_at(Path::new(RUNTIME_SYSTEMD_SYSTEM_DIR), unit)
}

/// Returns whether cleanup found state that warrants reloading systemd.
pub(super) fn remove_drain_restart_override(unit: &RunnerServiceUnit) -> RunnerResult<bool> {
    remove_drain_restart_override_outcome(unit).map(DrainRestartOverrideRemoval::reload_required)
}

pub(super) fn remove_drain_restart_override_outcome(
    unit: &RunnerServiceUnit,
) -> RunnerResult<DrainRestartOverrideRemoval> {
    remove_drain_restart_override_at(Path::new(RUNTIME_SYSTEMD_SYSTEM_DIR), unit)
}

pub(super) fn drain_restart_override_path(unit: &RunnerServiceUnit) -> PathBuf {
    drain_restart_override_path_at(Path::new(RUNTIME_SYSTEMD_SYSTEM_DIR), unit)
}

fn drain_restart_override_dir_at(root: &Path, unit: &RunnerServiceUnit) -> PathBuf {
    root.join(format!("{}.d", unit.service_name()))
}

fn drain_restart_override_path_at(root: &Path, unit: &RunnerServiceUnit) -> PathBuf {
    drain_restart_override_dir_at(root, unit).join(DRAIN_DROP_IN_FILE_NAME)
}

pub(super) fn write_drain_restart_override_at(
    root: &Path,
    unit: &RunnerServiceUnit,
) -> RunnerResult<DrainRestartOverrideWrite> {
    let dir = drain_restart_override_dir_at(root, unit);
    std::fs::create_dir_all(&dir).map_err(|e| {
        RunnerError::Internal(format!(
            "create drain restart override directory {}: {e}",
            dir.display()
        ))
    })?;
    let path = drain_restart_override_path_at(root, unit);
    cleanup_unit_staging_files(&path)?;
    let outcome = match std::fs::symlink_metadata(&path) {
        Ok(_) => DrainRestartOverrideWrite::Replaced,
        Err(e) if e.kind() == ErrorKind::NotFound => DrainRestartOverrideWrite::Created,
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "stat drain restart override {}: {e}",
                path.display()
            )));
        }
    };
    write_unit_file(&path, DRAIN_DROP_IN_CONTENT)?;
    Ok(outcome)
}

pub(super) fn remove_drain_restart_override_at(
    root: &Path,
    unit: &RunnerServiceUnit,
) -> RunnerResult<DrainRestartOverrideRemoval> {
    let path = drain_restart_override_path_at(root, unit);
    cleanup_unit_staging_files(&path)?;

    let override_removed = match std::fs::remove_file(&path) {
        Ok(()) => true,
        Err(e) if e.kind() == ErrorKind::NotFound => false,
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "remove drain restart override {}: {e}",
                path.display()
            )));
        }
    };

    let dir = drain_restart_override_dir_at(root, unit);
    let directory_removed = match std::fs::remove_dir(&dir) {
        Ok(()) => true,
        Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::DirectoryNotEmpty) => false,
        Err(e) => {
            warn!(
                directory = %dir.display(),
                error = %e,
                "failed to remove empty drain restart override directory"
            );
            false
        }
    };

    Ok(if override_removed {
        DrainRestartOverrideRemoval::OverrideRemoved
    } else if directory_removed {
        DrainRestartOverrideRemoval::DirectoryRemoved
    } else {
        DrainRestartOverrideRemoval::AlreadyAbsent
    })
}

#[cfg(test)]
mod tests;
