use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use tracing::warn;

use crate::error::{RunnerError, RunnerResult};

use super::target::RunnerServiceUnit;
use super::unit_file::{cleanup_unit_staging_files, write_unit_file};

const RUNTIME_SYSTEMD_SYSTEM_DIR: &str = "/run/systemd/system";
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

    const fn reload_required(self) -> bool {
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

fn write_drain_restart_override_at(
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

fn remove_drain_restart_override_at(
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

runner_test_group!(cmd_service; #[cfg(test)]
mod tests {
    use super::*;

    fn service_unit() -> RunnerServiceUnit {
        RunnerServiceUnit::from_suffix("test").unwrap()
    }

    #[test]
    fn override_path_is_derived_from_service_name() {
        let dir = tempfile::tempdir().unwrap();
        let unit = RunnerServiceUnit::from_suffix("v1.2.3").unwrap();

        assert_eq!(
            drain_restart_override_path_at(dir.path(), &unit),
            dir.path()
                .join("vm0-runner-v1.2.3.service.d")
                .join(DRAIN_DROP_IN_FILE_NAME)
        );
    }

    #[test]
    fn write_creates_fixed_drop_in() {
        let dir = tempfile::tempdir().unwrap();
        let unit = service_unit();
        let path = drain_restart_override_path_at(dir.path(), &unit);

        assert_eq!(
            write_drain_restart_override_at(dir.path(), &unit).unwrap(),
            DrainRestartOverrideWrite::Created
        );

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            DRAIN_DROP_IN_CONTENT
        );
    }

    #[test]
    fn repeated_writes_overwrite_same_drop_in() {
        let dir = tempfile::tempdir().unwrap();
        let unit = service_unit();
        let drop_in_dir = drain_restart_override_dir_at(dir.path(), &unit);
        let path = drain_restart_override_path_at(dir.path(), &unit);

        assert_eq!(
            write_drain_restart_override_at(dir.path(), &unit).unwrap(),
            DrainRestartOverrideWrite::Created
        );
        std::fs::write(&path, "old content").unwrap();
        assert_eq!(
            write_drain_restart_override_at(dir.path(), &unit).unwrap(),
            DrainRestartOverrideWrite::Replaced
        );

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            DRAIN_DROP_IN_CONTENT
        );
        let entries: Vec<_> = std::fs::read_dir(&drop_in_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec![DRAIN_DROP_IN_FILE_NAME]);
    }

    #[test]
    fn remove_ignores_missing_drop_in() {
        let dir = tempfile::tempdir().unwrap();
        let unit = service_unit();

        let outcome = remove_drain_restart_override_at(dir.path(), &unit).unwrap();

        assert_eq!(outcome, DrainRestartOverrideRemoval::AlreadyAbsent);
        assert!(!outcome.reload_required());
    }

    #[test]
    fn remove_reports_change_when_empty_directory_is_cleaned() {
        let dir = tempfile::tempdir().unwrap();
        let unit = service_unit();
        let drop_in_dir = drain_restart_override_dir_at(dir.path(), &unit);
        std::fs::create_dir(&drop_in_dir).unwrap();

        let outcome = remove_drain_restart_override_at(dir.path(), &unit).unwrap();

        assert_eq!(outcome, DrainRestartOverrideRemoval::DirectoryRemoved);
        assert!(outcome.reload_required());

        assert!(!drop_in_dir.exists());
    }

    #[test]
    fn remove_deletes_empty_drop_in_directory() {
        let dir = tempfile::tempdir().unwrap();
        let unit = service_unit();
        let drop_in_dir = drain_restart_override_dir_at(dir.path(), &unit);

        write_drain_restart_override_at(dir.path(), &unit).unwrap();
        assert_eq!(
            remove_drain_restart_override_at(dir.path(), &unit).unwrap(),
            DrainRestartOverrideRemoval::OverrideRemoved
        );

        assert!(!drop_in_dir.exists());
    }

    #[test]
    fn remove_preserves_nonempty_drop_in_directory() {
        let dir = tempfile::tempdir().unwrap();
        let unit = service_unit();
        let drop_in_dir = drain_restart_override_dir_at(dir.path(), &unit);
        let other = drop_in_dir.join("90-operator.conf");

        write_drain_restart_override_at(dir.path(), &unit).unwrap();
        std::fs::write(&other, "[Service]\nEnvironment=EXTRA=1\n").unwrap();
        assert_eq!(
            remove_drain_restart_override_at(dir.path(), &unit).unwrap(),
            DrainRestartOverrideRemoval::OverrideRemoved
        );

        assert!(drop_in_dir.exists());
        assert!(other.exists());
        assert!(!drain_restart_override_path_at(dir.path(), &unit).exists());
    }

    #[cfg(unix)]
    #[test]
    fn remove_reports_override_change_when_directory_cleanup_fails() {
        let dir = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let unit = service_unit();
        let drop_in_dir = drain_restart_override_dir_at(dir.path(), &unit);
        std::os::unix::fs::symlink(target.path(), &drop_in_dir).unwrap();
        let path = drain_restart_override_path_at(dir.path(), &unit);
        std::fs::write(&path, DRAIN_DROP_IN_CONTENT).unwrap();

        assert_eq!(
            remove_drain_restart_override_at(dir.path(), &unit).unwrap(),
            DrainRestartOverrideRemoval::OverrideRemoved
        );

        assert!(!path.exists());
        assert!(
            std::fs::symlink_metadata(&drop_in_dir)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
});
