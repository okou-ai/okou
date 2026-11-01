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
