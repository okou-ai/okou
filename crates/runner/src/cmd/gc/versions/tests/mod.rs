use nix::fcntl::{Flock, FlockArg};

use super::*;
use crate::cmd::gc::test_support::test_home;

fn test_version_service_unit(version: &str) -> service::RunnerServiceUnit {
    service::RunnerServiceUnit::from_suffix(version).unwrap()
}

fn age_version_past_gc_min_age(home: &HomePaths, name: &str) {
    let old_time = SystemTime::now() - Duration::from_secs(GC_MIN_AGE.as_secs() + 60);
    for path in [
        home.bin_dir().join(name),
        home.bin_dir().join(name).join("runner"),
        home.runners_dir().join(name),
        home.runners_dir().join(name).join("runner.yaml"),
    ] {
        if path.exists() {
            std::fs::File::open(path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(old_time))
                .unwrap();
        }
    }
}

fn age_versions_past_gc_min_age(home: &HomePaths, names: &[&str]) {
    for name in names {
        age_version_past_gc_min_age(home, name);
    }
}

#[test]
fn parse_semver_valid() {
    assert_eq!(parse_semver("v1.0.0"), Some((1, 0, 0)));
    assert_eq!(parse_semver("v0.2.10"), Some((0, 2, 10)));
    assert_eq!(parse_semver("v12.34.56"), Some((12, 34, 56)));
}

#[test]
fn parse_semver_invalid() {
    assert!(parse_semver("staging").is_none());
    assert!(parse_semver("test-abc").is_none());
    assert!(parse_semver("v1.0").is_none());
    assert!(parse_semver("v1.0.0-rc1").is_none());
    assert!(parse_semver("1.0.0").is_none());
    assert!(parse_semver("").is_none());
    assert!(parse_semver("v").is_none());
    assert!(parse_semver("v1.0.0.0").is_none());
}

/// Ordering must be numeric (`v0.10.0 > v0.9.0`), not lexicographic.
#[test]
fn parse_semver_orders_numerically() {
    assert!(parse_semver("v0.10.0") > parse_semver("v0.9.0"));
    assert!(parse_semver("v1.0.0") > parse_semver("v0.99.99"));
}

#[tokio::test]
async fn analyze_version_gc_marks_partial_directory_scan_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let versions = ["v1.0.0", "v2.0.0", "v3.0.0"];
    for version in versions {
        std::fs::create_dir_all(home.bin_dir().join(version)).unwrap();
    }
    age_versions_past_gc_min_age(&home, &versions);

    let analysis = analyze_version_gc_with_injected_scan_error(&home, None, None, 1)
        .await
        .unwrap();

    assert!(!analysis.directory_scan_complete());
    assert_eq!(analysis.entries.len(), 1);

    let removed = gc_versions_with_analysis_and_uninstall(
        &home,
        false,
        analysis,
        successful_fake_uninstall_service_unit,
    )
    .await
    .unwrap();
    assert_eq!(removed.len(), 1);
    assert_eq!(
        versions
            .into_iter()
            .filter(|version| home.bin_dir().join(version).exists())
            .count(),
        2,
        "versions omitted by the interrupted scan must remain untouched"
    );
}

#[tokio::test]
async fn analyze_version_gc_retains_config_only_entry_when_binary_scan_is_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version = "v2.0.0";
    std::fs::create_dir_all(home.bin_dir()).unwrap();
    std::fs::create_dir_all(home.runners_dir().join(version)).unwrap();
    age_version_past_gc_min_age(&home, version);

    let analysis = analyze_version_gc_with_injected_scan_error(&home, None, None, 0)
        .await
        .unwrap();

    assert!(!analysis.directory_scan_complete());
    assert_eq!(analysis.entries.len(), 1);
    assert_eq!(
        analysis.entries[0].retained,
        Some(VersionRetentionReason::IncompleteBinaryScan)
    );

    let removed = gc_versions_with_analysis_and_uninstall(
        &home,
        false,
        analysis,
        successful_fake_uninstall_service_unit,
    )
    .await
    .unwrap();
    assert!(removed.is_empty());
    assert!(home.runners_dir().join(version).exists());
}

#[tokio::test]
async fn analyze_version_gc_treats_config_iteration_failure_as_nonfatal() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version = "v1.0.0";
    std::fs::create_dir_all(home.bin_dir().join(version)).unwrap();
    std::fs::create_dir_all(home.runners_dir()).unwrap();
    age_version_past_gc_min_age(&home, version);

    let analysis = analyze_version_gc_with_injected_config_scan_error(&home, None, None, 0)
        .await
        .unwrap();

    assert!(!analysis.directory_scan_complete());
    assert_eq!(analysis.entries.len(), 1);
    assert_eq!(analysis.entries[0].name, version);
}

#[tokio::test]
async fn analyze_version_gc_treats_config_root_open_failure_as_nonfatal() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version = "v1.0.0";
    std::fs::create_dir_all(home.bin_dir().join(version)).unwrap();
    std::fs::create_dir_all(home.runners_dir().parent().unwrap()).unwrap();
    std::fs::write(home.runners_dir(), "not a directory").unwrap();
    age_version_past_gc_min_age(&home, version);

    let analysis = analyze_version_gc(&home, None, None).await.unwrap();

    assert!(!analysis.directory_scan_complete());
    assert_eq!(analysis.entries.len(), 1);
    assert_eq!(analysis.entries[0].name, version);
}

#[tokio::test]
async fn gc_versions_removes_inactive_semver_dirs() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let bin_dir = home.bin_dir();
    let runners_dir = home.runners_dir();

    // Create semver version dirs in bin/
    std::fs::create_dir_all(bin_dir.join("v1.0.0")).unwrap();
    std::fs::create_dir_all(bin_dir.join("v2.0.0")).unwrap();
    // Create a non-semver dir that should be untouched
    std::fs::create_dir_all(bin_dir.join("staging")).unwrap();

    // Create corresponding runner config dirs
    std::fs::create_dir_all(runners_dir.join("v1.0.0")).unwrap();
    age_versions_past_gc_min_age(&home, &["v1.0.0", "v2.0.0"]);

    let mut removed = gc_versions(&home, false, None, None).await.unwrap();
    removed.sort();
    assert_eq!(removed, ["v1.0.0", "v2.0.0"]);
    assert!(!bin_dir.join("v1.0.0").exists());
    assert!(!bin_dir.join("v2.0.0").exists());
    assert!(
        bin_dir.join("staging").exists(),
        "non-semver should be untouched"
    );
    assert!(!runners_dir.join("v1.0.0").exists());
}

#[tokio::test]
async fn gc_versions_keeps_version_when_service_uninstall_fails() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let bin_dir = home.bin_dir();
    let runners_dir = home.runners_dir();
    let version = "v1.0.0";

    std::fs::create_dir_all(bin_dir.join(version)).unwrap();
    std::fs::create_dir_all(runners_dir.join(version)).unwrap();
    age_version_past_gc_min_age(&home, version);

    let analysis = analyze_version_gc(&home, None, None).await.unwrap();
    let removed = gc_versions_with_analysis_and_uninstall(
        &home,
        false,
        analysis,
        failing_fake_uninstall_service_unit,
    )
    .await
    .unwrap();

    assert!(removed.is_empty());
    assert!(
        bin_dir.join(version).exists(),
        "failed service uninstall must keep version bin dir"
    );
    assert!(
        runners_dir.join(version).exists(),
        "failed service uninstall must keep version config dir"
    );
}

#[tokio::test]
async fn gc_versions_keeps_binary_config_and_lock_when_config_removal_fails() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version = "v1.0.0";
    let version_bin = home.bin_dir().join(version);
    let version_config = home.runners_dir().join(version);
    std::fs::create_dir_all(&version_bin).unwrap();
    std::fs::create_dir_all(&version_config).unwrap();
    age_version_past_gc_min_age(&home, version);

    let analysis = analyze_version_gc(&home, None, None).await.unwrap();
    let removed = gc_versions_with_analysis_and_operations(
        &home,
        false,
        analysis,
        successful_fake_uninstall_service_unit,
        failing_fake_remove_config_dir,
    )
    .await
    .unwrap();

    assert!(removed.is_empty());
    assert!(
        version_config.exists(),
        "failed config removal must leave credentials retryable"
    );
    assert!(
        version_bin.exists(),
        "config removal failure must preserve the binary discovery anchor"
    );
    assert!(
        test_version_service_unit(version).lock_path(&home).exists(),
        "partial cleanup must preserve its lifecycle lock"
    );
}

#[tokio::test]
async fn gc_versions_retries_config_only_cleanup_after_removal_failure() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version = "v1.0.0";
    let version_config = home.runners_dir().join(version);
    let service_lock = test_version_service_unit(version).lock_path(&home);
    std::fs::create_dir_all(&version_config).unwrap();
    age_version_past_gc_min_age(&home, version);

    let first_analysis = analyze_version_gc(&home, None, None).await.unwrap();
    let first_removed = gc_versions_with_analysis_and_operations(
        &home,
        false,
        first_analysis,
        successful_fake_uninstall_service_unit,
        failing_fake_remove_config_dir,
    )
    .await
    .unwrap();

    assert!(first_removed.is_empty());
    assert!(version_config.exists());
    assert!(service_lock.exists());

    let retry_analysis = analyze_version_gc(&home, None, None).await.unwrap();
    let retry_removed = gc_versions_with_analysis_and_uninstall(
        &home,
        false,
        retry_analysis,
        successful_fake_uninstall_service_unit,
    )
    .await
    .unwrap();

    assert_eq!(retry_removed, [version]);
    assert!(!version_config.exists());
    assert!(!service_lock.exists());
}

#[tokio::test]
async fn gc_versions_rechecks_artifact_type_before_removal() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version = "v1.0.0";
    let version_bin = home.bin_dir().join(version);
    let version_config = home.runners_dir().join(version);
    std::fs::create_dir_all(&version_bin).unwrap();
    std::fs::create_dir_all(&version_config).unwrap();
    age_version_past_gc_min_age(&home, version);
    let analysis = analyze_version_gc(&home, None, None).await.unwrap();

    std::fs::remove_dir(&version_config).unwrap();
    std::fs::write(&version_config, "replacement file").unwrap();

    let removed = gc_versions_with_analysis_and_uninstall(
        &home,
        false,
        analysis,
        successful_fake_uninstall_service_unit,
    )
    .await
    .unwrap();

    assert!(removed.is_empty());
    assert!(
        version_bin.exists(),
        "a replacement path must stop the whole version cleanup"
    );
    assert!(
        version_config.is_file(),
        "the replacement path must remain untouched"
    );
}

#[tokio::test]
async fn gc_versions_skips_version_when_service_lock_is_held() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let bin_dir = home.bin_dir();
    let runners_dir = home.runners_dir();
    let version = "v1.0.0";
    let unit = test_version_service_unit(version);
    std::fs::create_dir_all(bin_dir.join(version)).unwrap();
    std::fs::create_dir_all(runners_dir.join(version)).unwrap();
    age_version_past_gc_min_age(&home, version);
    let _service_lock = lock::acquire(unit.lock_path(&home)).await.unwrap();

    let removed = gc_versions(&home, false, None, None).await.unwrap();

    assert!(removed.is_empty());
    assert!(bin_dir.join(version).exists());
    assert!(runners_dir.join(version).exists());
}

#[tokio::test]
async fn gc_versions_dry_run() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let bin_dir = home.bin_dir();

    std::fs::create_dir_all(bin_dir.join("v1.0.0")).unwrap();
    age_version_past_gc_min_age(&home, "v1.0.0");
    let unit = test_version_service_unit("v1.0.0");
    let service_lock_path = unit.lock_path(&home);

    let removed = gc_versions(&home, true, None, None).await.unwrap();
    assert_eq!(removed, ["v1.0.0"]);
    assert!(bin_dir.join("v1.0.0").exists(), "dry-run should not delete");
    assert!(
        !service_lock_path.exists(),
        "dry-run should not leave a service lock it created"
    );
}

#[tokio::test]
async fn gc_versions_dry_run_reports_config_only_version() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version = "v1.0.0";
    let version_config = home.runners_dir().join(version);
    std::fs::create_dir_all(&version_config).unwrap();
    age_version_past_gc_min_age(&home, version);

    let removed = gc_versions(&home, true, None, None).await.unwrap();

    assert_eq!(removed, [version]);
    assert!(
        version_config.exists(),
        "dry-run must preserve config-only versions"
    );
}

#[tokio::test]
async fn gc_versions_dry_run_preserves_existing_service_lock() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let bin_dir = home.bin_dir();
    let version = "v1.0.0";

    std::fs::create_dir_all(bin_dir.join(version)).unwrap();
    age_version_past_gc_min_age(&home, version);
    let unit = test_version_service_unit(version);
    let service_lock_path = unit.lock_path(&home);
    drop(lock::open_lock_file(&service_lock_path).unwrap());

    let removed = gc_versions(&home, true, None, None).await.unwrap();

    assert_eq!(removed, [version]);
    assert!(
        service_lock_path.exists(),
        "dry-run must not remove an existing service lock"
    );
}

#[tokio::test]
async fn gc_versions_dry_run_skips_when_service_lock_is_held() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let bin_dir = home.bin_dir();
    let runners_dir = home.runners_dir();
    let version = "v1.0.0";
    let unit = test_version_service_unit(version);

    std::fs::create_dir_all(bin_dir.join(version)).unwrap();
    std::fs::create_dir_all(runners_dir.join(version)).unwrap();
    age_version_past_gc_min_age(&home, version);
    let lock_file = lock::open_lock_file(&unit.lock_path(&home)).unwrap();
    let _held_lock = Flock::lock(lock_file, FlockArg::LockExclusive).unwrap();

    let removed = gc_versions(&home, true, None, None).await.unwrap();

    assert!(removed.is_empty());
    assert!(
        bin_dir.join(version).exists(),
        "dry-run should skip locked version bin dir"
    );
    assert!(
        runners_dir.join(version).exists(),
        "dry-run should skip locked version config dir"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn gc_versions_dry_run_skips_dangling_service_lock_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let bin_dir = home.bin_dir();
    let runners_dir = home.runners_dir();
    let version = "v1.0.0";
    let unit = test_version_service_unit(version);

    std::fs::create_dir_all(bin_dir.join(version)).unwrap();
    std::fs::create_dir_all(runners_dir.join(version)).unwrap();
    age_version_past_gc_min_age(&home, version);

    let service_lock_path = unit.lock_path(&home);
    std::fs::create_dir_all(home.locks_dir()).unwrap();
    std::os::unix::fs::symlink(dir.path().join("missing-lock-target"), &service_lock_path).unwrap();

    let removed = gc_versions(&home, true, None, None).await.unwrap();

    assert!(
        removed.is_empty(),
        "dry-run should match real delete mode and skip unsafe service locks"
    );
    assert!(bin_dir.join(version).exists());
    assert!(runners_dir.join(version).exists());
    assert!(
        std::fs::symlink_metadata(&service_lock_path)
            .unwrap()
            .file_type()
            .is_symlink(),
        "dry-run should not touch the suspicious lock path"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn gc_versions_dry_run_skips_symlink_service_lock_parent() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let bin_dir = home.bin_dir();
    let runners_dir = home.runners_dir();
    let version = "v1.0.0";

    std::fs::create_dir_all(bin_dir.join(version)).unwrap();
    std::fs::create_dir_all(runners_dir.join(version)).unwrap();
    age_version_past_gc_min_age(&home, version);

    let unsafe_lock_target = dir.path().join("unsafe-lock-target");
    std::fs::create_dir_all(&unsafe_lock_target).unwrap();
    std::os::unix::fs::symlink(&unsafe_lock_target, home.locks_dir()).unwrap();

    let removed = gc_versions(&home, true, None, None).await.unwrap();

    assert!(
        removed.is_empty(),
        "dry-run should skip when real mode cannot trust the service lock parent"
    );
    assert!(bin_dir.join(version).exists());
    assert!(runners_dir.join(version).exists());
}

#[tokio::test]
async fn gc_versions_keeps_recent_version() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let bin_dir = home.bin_dir();
    let runners_dir = home.runners_dir();

    std::fs::create_dir_all(bin_dir.join("v1.0.0")).unwrap();
    std::fs::create_dir_all(runners_dir.join("v1.0.0")).unwrap();

    let removed = gc_versions(&home, false, None, None).await.unwrap();

    assert!(removed.is_empty());
    assert!(
        bin_dir.join("v1.0.0").exists(),
        "recent version bin dir should survive"
    );
    assert!(
        runners_dir.join("v1.0.0").exists(),
        "recent version config dir should survive"
    );
}

#[tokio::test]
async fn gc_versions_keeps_recent_config_only_version() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version = "v1.0.0";
    let version_config = home.runners_dir().join(version);
    std::fs::create_dir_all(&version_config).unwrap();

    let removed = gc_versions(&home, false, None, None).await.unwrap();

    assert!(removed.is_empty());
    assert!(version_config.exists());
}

#[tokio::test]
async fn gc_versions_keeps_recent_runner_binary_file() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version_bin = home.bin_dir().join("v1.0.0");
    let runner_binary = version_bin.join("runner");

    std::fs::create_dir_all(&version_bin).unwrap();
    std::fs::write(&runner_binary, "binary").unwrap();
    age_version_past_gc_min_age(&home, "v1.0.0");
    // Update the existing leaf without refreshing its parent directory's mtime.
    std::fs::write(&runner_binary, "updated binary").unwrap();

    let now = SystemTime::now();
    let directory_mtime = version_bin.metadata().unwrap().modified().unwrap();
    let binary_mtime = runner_binary.metadata().unwrap().modified().unwrap();
    assert!(
        now.duration_since(directory_mtime).unwrap() > GC_MIN_AGE,
        "fixture directory must be old so only the runner binary protects the version"
    );
    assert!(
        now.duration_since(binary_mtime).unwrap() < GC_MIN_AGE,
        "fixture runner binary must be recent"
    );

    let removed = gc_versions(&home, false, None, None).await.unwrap();

    assert!(removed.is_empty());
    assert!(
        version_bin.exists(),
        "recent runner binary file should protect its version"
    );
}

#[tokio::test]
async fn gc_versions_keeps_recent_runner_config_file() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version_bin = home.bin_dir().join("v1.0.0");
    let version_config = home.runners_dir().join("v1.0.0");
    let runner_config = version_config.join("runner.yaml");

    std::fs::create_dir_all(&version_bin).unwrap();
    std::fs::create_dir_all(&version_config).unwrap();
    std::fs::write(&runner_config, "config").unwrap();
    age_version_past_gc_min_age(&home, "v1.0.0");
    // Update the existing leaf without refreshing its parent directory's mtime.
    std::fs::write(&runner_config, "updated config").unwrap();

    let now = SystemTime::now();
    for path in [&version_bin, &version_config] {
        let directory_mtime = path.metadata().unwrap().modified().unwrap();
        assert!(
            now.duration_since(directory_mtime).unwrap() > GC_MIN_AGE,
            "fixture directory {} must be old so only the config file protects the version",
            path.display()
        );
    }
    let config_mtime = runner_config.metadata().unwrap().modified().unwrap();
    assert!(
        now.duration_since(config_mtime).unwrap() < GC_MIN_AGE,
        "fixture runner config must be recent"
    );

    let removed = gc_versions(&home, false, None, None).await.unwrap();

    assert!(removed.is_empty());
    assert!(
        version_bin.exists(),
        "recent runner config file should protect its version"
    );
    assert!(
        version_config.exists(),
        "recent runner config file should protect its config directory"
    );
}

#[tokio::test]
async fn gc_versions_ignores_semver_named_file() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let bin_dir = home.bin_dir();
    let runners_dir = home.runners_dir();

    std::fs::create_dir_all(&bin_dir).unwrap();
    std::fs::write(bin_dir.join("v1.0.0"), "not a directory").unwrap();
    std::fs::create_dir_all(runners_dir.join("v1.0.0")).unwrap();
    age_version_past_gc_min_age(&home, "v1.0.0");

    let removed = gc_versions(&home, false, None, None).await.unwrap();

    assert!(removed.is_empty());
    assert!(
        bin_dir.join("v1.0.0").is_file(),
        "semver-named files are not version dirs"
    );
    assert!(
        runners_dir.join("v1.0.0").exists(),
        "config dir must not be removed for a non-directory bin entry"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn gc_versions_ignores_semver_named_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let bin_dir = home.bin_dir();
    let runners_dir = home.runners_dir();
    let target_dir = dir.path().join("external-version");

    std::fs::create_dir_all(&bin_dir).unwrap();
    std::fs::create_dir_all(&target_dir).unwrap();
    std::fs::create_dir_all(runners_dir.join("v1.0.0")).unwrap();
    std::os::unix::fs::symlink(&target_dir, bin_dir.join("v1.0.0")).unwrap();

    let removed = gc_versions(&home, false, None, None).await.unwrap();

    assert!(removed.is_empty());
    assert!(
        std::fs::symlink_metadata(bin_dir.join("v1.0.0"))
            .unwrap()
            .file_type()
            .is_symlink(),
        "semver-named symlinks are not version dirs"
    );
    assert!(
        runners_dir.join("v1.0.0").exists(),
        "a config dir paired with a suspicious binary path must remain untouched"
    );
}

#[tokio::test]
async fn gc_versions_skips_when_service_lock_is_held() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let bin_dir = home.bin_dir();
    let runners_dir = home.runners_dir();

    std::fs::create_dir_all(bin_dir.join("v1.0.0")).unwrap();
    std::fs::create_dir_all(runners_dir.join("v1.0.0")).unwrap();
    age_version_past_gc_min_age(&home, "v1.0.0");

    let unit = test_version_service_unit("v1.0.0");
    let lock_file = lock::open_lock_file(&unit.lock_path(&home)).unwrap();
    let _held_lock = Flock::lock(lock_file, FlockArg::LockExclusive).unwrap();

    let removed = gc_versions(&home, false, None, None).await.unwrap();

    assert!(removed.is_empty());
    assert!(
        bin_dir.join("v1.0.0").exists(),
        "locked version bin dir should survive"
    );
    assert!(
        runners_dir.join("v1.0.0").exists(),
        "locked version config dir should survive"
    );
}

#[tokio::test]
async fn gc_versions_keeps_config_only_version_when_service_lock_is_held() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version = "v1.0.0";
    let version_config = home.runners_dir().join(version);
    std::fs::create_dir_all(&version_config).unwrap();
    age_version_past_gc_min_age(&home, version);

    let unit = test_version_service_unit(version);
    let lock_file = lock::open_lock_file(&unit.lock_path(&home)).unwrap();
    let _held_lock = Flock::lock(lock_file, FlockArg::LockExclusive).unwrap();

    let removed = gc_versions(&home, false, None, None).await.unwrap();

    assert!(removed.is_empty());
    assert!(version_config.exists());
}

#[tokio::test]
async fn gc_versions_removes_service_lock_after_version_removal() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let bin_dir = home.bin_dir();
    let runners_dir = home.runners_dir();
    let version = "v1.0.0";

    std::fs::create_dir_all(bin_dir.join(version)).unwrap();
    std::fs::create_dir_all(runners_dir.join(version)).unwrap();
    age_version_past_gc_min_age(&home, version);
    let unit = test_version_service_unit(version);
    let service_lock_path = unit.lock_path(&home);
    drop(lock::open_lock_file(&service_lock_path).unwrap());

    let removed = gc_versions(&home, false, None, None).await.unwrap();

    assert_eq!(removed, [version]);
    assert!(
        !service_lock_path.exists(),
        "removed version should not leave its service lock behind"
    );
}

#[tokio::test]
async fn gc_versions_empty_bin_dir() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.bin_dir()).unwrap();

    let removed = gc_versions(&home, false, None, None).await.unwrap();
    assert!(removed.is_empty());
}

#[tokio::test]
async fn gc_versions_missing_bin_dir() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    // Don't create bin_dir — should return 0, not error.
    let removed = gc_versions(&home, false, None, None).await.unwrap();
    assert!(removed.is_empty());
}

#[tokio::test]
async fn gc_versions_protect_keeps_named_version() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let bin_dir = home.bin_dir();

    std::fs::create_dir_all(bin_dir.join("v1.0.0")).unwrap();
    std::fs::create_dir_all(bin_dir.join("v2.0.0")).unwrap();
    age_versions_past_gc_min_age(&home, &["v1.0.0", "v2.0.0"]);

    let mut removed = gc_versions(&home, false, Some("v1.0.0"), None)
        .await
        .unwrap();
    removed.sort();
    assert_eq!(removed, ["v2.0.0"]);
    assert!(
        bin_dir.join("v1.0.0").exists(),
        "skipped version should survive"
    );
    assert!(!bin_dir.join("v2.0.0").exists());
}

#[tokio::test]
async fn gc_versions_protect_keeps_config_only_version() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version = "v1.0.0";
    let version_config = home.runners_dir().join(version);
    std::fs::create_dir_all(&version_config).unwrap();
    age_version_past_gc_min_age(&home, version);

    let removed = gc_versions(&home, false, Some(version), None)
        .await
        .unwrap();

    assert!(removed.is_empty());
    assert!(version_config.exists());
}

/// Two overlapping release pipelines can interleave: v0.88.2's promote
/// runs `gc --keep-latest 6 --protect-version v0.88.2` after v0.88.3 has
/// already staged its binary. `--keep-latest` must cover semver dirs so
/// v0.88.3 survives by version ordering alone, not just `--protect-version`.
#[tokio::test]
async fn gc_versions_keep_latest_covers_staged_newer_version() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let bin_dir = home.bin_dir();

    for v in ["v0.88.0", "v0.88.1", "v0.88.2", "v0.88.3"] {
        std::fs::create_dir_all(bin_dir.join(v)).unwrap();
    }
    age_versions_past_gc_min_age(&home, &["v0.88.0", "v0.88.1", "v0.88.2", "v0.88.3"]);

    // Simulating v0.88.2's own promote: protects itself, keeps top 1.
    // v0.88.3 must survive via keep_latest even though protect is v0.88.2.
    let mut removed = gc_versions(&home, false, Some("v0.88.2"), Some(1))
        .await
        .unwrap();
    removed.sort();
    assert_eq!(removed, ["v0.88.0", "v0.88.1"]);
    assert!(
        bin_dir.join("v0.88.3").exists(),
        "newest survives via keep_latest"
    );
    assert!(bin_dir.join("v0.88.2").exists(), "protect-version survives");
    assert!(!bin_dir.join("v0.88.1").exists());
    assert!(!bin_dir.join("v0.88.0").exists());
}

/// `--keep-latest` orders numerically, not lexicographically — v0.10.0
/// must outrank v0.9.0.
#[tokio::test]
async fn gc_versions_keep_latest_numeric_ordering() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let bin_dir = home.bin_dir();

    for v in ["v0.9.0", "v0.10.0"] {
        std::fs::create_dir_all(bin_dir.join(v)).unwrap();
    }
    age_versions_past_gc_min_age(&home, &["v0.9.0", "v0.10.0"]);

    let removed = gc_versions(&home, false, None, Some(1)).await.unwrap();
    assert_eq!(removed, ["v0.9.0"]);
    assert!(bin_dir.join("v0.10.0").exists());
}

#[tokio::test]
async fn gc_versions_config_only_version_does_not_consume_keep_latest_slot() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let binary_version = "v1.0.0";
    let config_only_version = "v9.0.0";
    std::fs::create_dir_all(home.bin_dir().join(binary_version)).unwrap();
    std::fs::create_dir_all(home.runners_dir().join(config_only_version)).unwrap();
    age_versions_past_gc_min_age(&home, &[binary_version, config_only_version]);

    let removed = gc_versions(&home, false, None, Some(1)).await.unwrap();

    assert_eq!(removed, [config_only_version]);
    assert!(
        home.bin_dir().join(binary_version).exists(),
        "the newest real binary must receive the keep-latest slot"
    );
    assert!(!home.runners_dir().join(config_only_version).exists());
}
