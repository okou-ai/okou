use std::path::PathBuf;

use nix::fcntl::{Flock, FlockArg};

use super::*;
use crate::cmd::gc::test_support::test_home;
use crate::cmd::service;
use runner_host::lock;

fn test_version_service_lock(home: &HomePaths, version: &str) -> PathBuf {
    let unit = service::RunnerServiceUnit::from_suffix(version).unwrap();
    unit.lock_path(home)
}

fn create_test_version_service_lock(home: &HomePaths, version: &str) -> PathBuf {
    let path = test_version_service_lock(home, version);
    drop(lock::open_lock_file(&path).unwrap());
    path
}
#[test]
fn version_service_unit_from_lock_file_name_parses_only_semver_runner_locks() {
    let unit = service::RunnerServiceUnit::from_suffix("v1.0.0").unwrap();
    assert_eq!(
        version_service_unit_from_lock_file_name(unit.lock_file_name()),
        Some(unit)
    );
    assert!(version_service_unit_from_lock_file_name("service-vm0-runner-staging.lock").is_none());
    assert!(version_service_unit_from_lock_file_name("service-vm0-runner-v1.0.lock").is_none());
    assert!(version_service_unit_from_lock_file_name("home-image-cache-v1.0.0.lock").is_none());
    assert!(version_service_unit_from_lock_file_name("service-vm0-runner-v1.0.0").is_none());
}

#[tokio::test]
async fn gc_orphaned_version_service_locks_removes_missing_version_bin() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let service_lock = create_test_version_service_lock(&home, "v1.0.0");

    let removed = gc_orphaned_version_service_locks(&home, false)
        .await
        .unwrap();

    assert_eq!(removed.version_service_locks_removed, 1);
    assert!(
        !service_lock.exists(),
        "missing version bin dir should make its service lock stale"
    );
}

#[tokio::test]
async fn gc_orphaned_version_service_locks_keeps_lock_for_recreated_version_dir() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version = "v1.0.0";
    let service_lock = create_test_version_service_lock(&home, version);
    let version_bin = home.bin_dir().join(version);

    let removed = gc_orphaned_version_service_locks_with_observer(&home, false, || {
        std::fs::create_dir_all(&version_bin).unwrap();
    })
    .await
    .unwrap();

    assert!(
        version_bin.is_dir(),
        "test observer should recreate the version directory"
    );
    assert_eq!(removed.version_service_locks_removed, 0);
    assert!(
        service_lock.exists(),
        "version recreated before the lock probe should keep its service lock"
    );
}

#[tokio::test]
async fn gc_orphaned_version_service_locks_keeps_existing_version_dir() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version = "v1.0.0";
    let service_lock = create_test_version_service_lock(&home, version);
    std::fs::create_dir_all(home.bin_dir().join(version)).unwrap();

    let removed = gc_orphaned_version_service_locks(&home, false)
        .await
        .unwrap();

    assert_eq!(removed.version_service_locks_removed, 0);
    assert!(
        service_lock.exists(),
        "existing version dir should keep its service lock"
    );
}

#[tokio::test]
async fn gc_orphaned_version_service_locks_tracks_config_only_version() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version = "v1.0.0";
    let service_lock = create_test_version_service_lock(&home, version);
    let version_config = home.runners_dir().join(version);
    std::fs::create_dir_all(&version_config).unwrap();

    let first_removed = gc_orphaned_version_service_locks(&home, false)
        .await
        .unwrap();

    assert_eq!(first_removed.version_service_locks_removed, 0);
    assert!(
        service_lock.exists(),
        "config-only version should keep its lifecycle lock"
    );

    std::fs::remove_dir_all(version_config).unwrap();
    let second_removed = gc_orphaned_version_service_locks(&home, false)
        .await
        .unwrap();

    assert_eq!(second_removed.version_service_locks_removed, 1);
    assert!(
        !service_lock.exists(),
        "lock should become removable after both managed directories are absent"
    );
}

#[tokio::test]
async fn gc_orphaned_version_service_locks_removes_semver_file() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version = "v1.0.0";
    let service_lock = create_test_version_service_lock(&home, version);
    std::fs::create_dir_all(home.bin_dir()).unwrap();
    std::fs::write(home.bin_dir().join(version), "not a directory").unwrap();

    let removed = gc_orphaned_version_service_locks(&home, false)
        .await
        .unwrap();

    assert_eq!(removed.version_service_locks_removed, 1);
    assert!(
        !service_lock.exists(),
        "semver-named files are not GC-enumerable version dirs"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn gc_orphaned_version_service_locks_removes_semver_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version = "v1.0.0";
    let service_lock = create_test_version_service_lock(&home, version);
    let target_dir = dir.path().join("external-version");
    std::fs::create_dir_all(home.bin_dir()).unwrap();
    std::fs::create_dir_all(&target_dir).unwrap();
    std::os::unix::fs::symlink(&target_dir, home.bin_dir().join(version)).unwrap();

    let removed = gc_orphaned_version_service_locks(&home, false)
        .await
        .unwrap();

    assert_eq!(removed.version_service_locks_removed, 1);
    assert!(
        !service_lock.exists(),
        "semver-named symlinks are not GC-enumerable version dirs"
    );
}

#[tokio::test]
async fn gc_orphaned_version_service_locks_keeps_held_lock() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let service_lock = test_version_service_lock(&home, "v1.0.0");
    let lock_file = lock::open_lock_file(&service_lock).unwrap();
    let _held_lock = Flock::lock(lock_file, FlockArg::LockExclusive).unwrap();

    let removed = gc_orphaned_version_service_locks(&home, false)
        .await
        .unwrap();

    assert_eq!(removed.version_service_locks_removed, 0);
    assert!(
        service_lock.exists(),
        "held orphaned service lock must not be removed"
    );
}

#[tokio::test]
async fn gc_orphaned_version_service_locks_keeps_non_semver_service_lock() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let unit = service::RunnerServiceUnit::from_suffix("staging").unwrap();
    let service_lock = unit.lock_path(&home);
    drop(lock::open_lock_file(&service_lock).unwrap());

    let removed = gc_orphaned_version_service_locks(&home, false)
        .await
        .unwrap();

    assert_eq!(removed.version_service_locks_removed, 0);
    assert!(
        service_lock.exists(),
        "non-semver service locks belong outside version GC"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn gc_orphaned_version_service_locks_skips_symlink_lock() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let service_lock = test_version_service_lock(&home, "v1.0.0");
    let target = dir.path().join("outside-lock-target");
    std::fs::create_dir_all(home.locks_dir()).unwrap();
    std::fs::write(&target, "outside").unwrap();
    std::os::unix::fs::symlink(&target, &service_lock).unwrap();

    let removed = gc_orphaned_version_service_locks(&home, false)
        .await
        .unwrap();

    assert_eq!(removed.version_service_locks_removed, 0);
    assert!(
        std::fs::symlink_metadata(&service_lock)
            .unwrap()
            .file_type()
            .is_symlink(),
        "symlink lock path must be left untouched"
    );
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "outside");
}

#[tokio::test]
async fn gc_orphaned_version_service_locks_dry_run_preserves_lock() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let service_lock = create_test_version_service_lock(&home, "v1.0.0");

    let removed = gc_orphaned_version_service_locks(&home, true)
        .await
        .unwrap();

    assert_eq!(removed.version_service_locks_removed, 1);
    assert!(
        service_lock.exists(),
        "dry-run should count but not remove stale service locks"
    );
}
