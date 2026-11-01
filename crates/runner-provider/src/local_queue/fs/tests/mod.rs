use std::os::unix::fs::{PermissionsExt, symlink};

use super::*;

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn ensure_profile_jobs_dir_keeps_existing_group_dir_mode() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path().join("group");
    std::fs::create_dir(&group_dir).unwrap();
    std::fs::set_permissions(&group_dir, std::fs::Permissions::from_mode(0o755)).unwrap();

    let job_dir = ensure_profile_jobs_dir(&group_dir, crate::profile::DEFAULT_PROFILE).unwrap();

    assert_eq!(mode(&group_dir), 0o755);
    assert_eq!(mode(&job_dir), 0o700);
}

#[test]
fn ensure_profile_jobs_dir_creates_missing_group_dir_as_shared_trusted() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path().join("groups").join("org").join("group");

    let job_dir = ensure_profile_jobs_dir(&group_dir, crate::profile::DEFAULT_PROFILE).unwrap();

    assert_eq!(mode(&group_dir), host_file::SHARED_TRUSTED_DIR_MODE);
    assert_eq!(mode(&job_dir), host_file::PRIVATE_DIR_MODE);
}

#[test]
fn ensure_group_dir_rejects_final_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let groups_dir = dir.path().join("groups").join("org");
    std::fs::create_dir_all(&groups_dir).unwrap();
    let target = dir.path().join("target-group");
    let group_dir = groups_dir.join("group");
    std::fs::create_dir(&target).unwrap();
    symlink(&target, &group_dir).unwrap();

    let error = ensure_group_dir(&group_dir).expect_err("final group symlink should be rejected");

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
}

#[test]
fn ensure_profile_jobs_dir_rejects_final_profile_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path().join("groups").join("org").join("group");
    let profile_parent = group_dir.join("jobs").join("vm0");
    std::fs::create_dir_all(&profile_parent).unwrap();
    let target = dir.path().join("target-profile");
    let profile_dir = profile_parent.join("default");
    std::fs::create_dir(&target).unwrap();
    symlink(&target, &profile_dir).unwrap();

    let error = ensure_profile_jobs_dir(&group_dir, crate::profile::DEFAULT_PROFILE)
        .expect_err("final profile symlink should be rejected");

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
}

#[test]
fn ensure_profile_jobs_dir_rejects_intermediate_group_symlink_without_touching_target() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    let link = dir.path().join("link");
    let group_dir = link.join("group");
    std::fs::create_dir(&target).unwrap();
    symlink(&target, &link).unwrap();

    let error = ensure_profile_jobs_dir(&group_dir, crate::profile::DEFAULT_PROFILE)
        .expect_err("intermediate group symlink should be rejected");

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(!target.join("group").exists());
}
