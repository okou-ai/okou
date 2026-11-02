use std::io;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::time::Duration;

use super::*;
use crate::test_support::{ignored_child_test_env_guard_enabled, run_ignored_child_test};

const RESTRICTIVE_UMASK_CHILD_ENV: &str = "OKOU_RUN_RESTRICTIVE_UMASK_TEST";

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn ensure_dir_preserves_nested_relative_non_utf8_components() {
    let dir = tempfile::tempdir_in(".").unwrap();
    let relative = Path::new(".").join(dir.path().file_name().unwrap());
    let parent = relative.join(OsStr::from_bytes(b"cache-\xff"));
    let path = parent.join("nested/leaf");

    ensure_dir(&path, DirMode::Private, "test cache").unwrap();
    validate_dir(&path, DirMode::Private, "test cache").unwrap();
    let file = path.join("state");
    let mut writer = open_private_append_file(&file, false).unwrap();
    std::io::Write::write_all(&mut writer, b"cached bytes").unwrap();

    assert_eq!(std::fs::read(&file).unwrap(), b"cached bytes");
    assert_eq!(mode(&parent), PRIVATE_DIR_MODE);
    assert_eq!(mode(&parent.join("nested")), PRIVATE_DIR_MODE);
    assert_eq!(mode(&path), PRIVATE_DIR_MODE);
}

#[test]
fn validate_dir_does_not_create_missing_nested_components() {
    let dir = tempfile::tempdir().unwrap();
    for dir_mode in [
        DirMode::Private,
        DirMode::TrustedParent,
        DirMode::SharedTrustedParent,
        DirMode::SharedTrusted,
    ] {
        let error = validate_dir(
            &dir.path().join("missing/child"),
            dir_mode,
            "test directory",
        )
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert!(error.to_string().contains("missing"));
        assert!(!dir.path().join("missing").exists());
    }
}

#[test]
fn ensure_dir_reports_unsafe_nested_component_without_creating_descendants() {
    let dir = tempfile::tempdir().unwrap();
    let unsafe_parent = dir.path().join("safe/writable");
    std::fs::create_dir_all(&unsafe_parent).unwrap();
    std::fs::set_permissions(&unsafe_parent, std::fs::Permissions::from_mode(0o777)).unwrap();

    let error = ensure_dir(
        &unsafe_parent.join("missing/leaf"),
        DirMode::TrustedParent,
        "test cache",
    )
    .unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(
        error.to_string(),
        format!(
            "test cache component {} is group/other writable without the sticky bit",
            unsafe_parent.display()
        )
    );
    assert!(!unsafe_parent.join("missing").exists());
    assert_eq!(mode(&unsafe_parent), 0o777);
}

#[test]
fn ensure_dir_keeps_sticky_intermediate_but_rejects_writable_final_directory() {
    let dir = tempfile::tempdir().unwrap();
    let sticky = dir.path().join("sticky");
    std::fs::create_dir(&sticky).unwrap();
    std::fs::set_permissions(&sticky, std::fs::Permissions::from_mode(0o1777)).unwrap();
    let leaf = sticky.join("shared/leaf");

    ensure_dir(&leaf, DirMode::SharedTrustedParent, "test directory").unwrap();

    assert_eq!(mode(&leaf), SHARED_TRUSTED_DIR_MODE);
    assert_eq!(
        std::fs::metadata(&sticky).unwrap().permissions().mode() & 0o7777,
        0o1777
    );
    let error = validate_dir(&sticky, DirMode::TrustedParent, "test directory").unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(
        error.to_string(),
        format!(
            "test directory {} is group/other writable",
            sticky.display()
        )
    );
}

#[tokio::test]
async fn write_private_new_preserves_existing_files_and_symlinks() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("existing.json");
    std::fs::write(&path, b"existing content").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660)).unwrap();
    let link = dir.path().join("link.json");
    symlink(&path, &link).unwrap();

    for destination in [&path, &link] {
        let error = write_private_new(destination, b"replacement", "test file")
            .await
            .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&path).unwrap(), b"existing content");
        assert_eq!(mode(&path), 0o660);
    }
    assert!(std::fs::symlink_metadata(&link).unwrap().is_symlink());
}

#[tokio::test]
async fn write_private_atomic_publishes_private_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.json");

    write_private_atomic(&path, b"new content", "test file")
        .await
        .unwrap();

    assert_eq!(std::fs::read(&path).unwrap(), b"new content");
    assert_eq!(mode(&path), PRIVATE_FILE_MODE);
}

#[tokio::test]
async fn write_private_atomic_replaces_existing_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.json");
    std::fs::write(&path, b"old content").unwrap();

    write_private_atomic(&path, b"new content", "test file")
        .await
        .unwrap();

    assert_eq!(std::fs::read(&path).unwrap(), b"new content");
}

#[tokio::test]
async fn write_private_atomic_removes_staging_file_after_rename_failure() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.json");
    std::fs::create_dir(&path).unwrap();

    let error = write_private_atomic(&path, b"content", "test file")
        .await
        .unwrap_err();

    assert!(
        error.to_string().contains("rename test file"),
        "unexpected error: {error}"
    );
    let leftover_staging_files: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with(".state.json.") && name.ends_with(".tmp")
        })
        .collect();
    assert!(
        leftover_staging_files.is_empty(),
        "private file staging sibling should be removed after rename failure"
    );
    assert!(path.is_dir());
}

#[tokio::test]
async fn ensure_dir_handles_restrictive_umask() {
    run_ignored_child_test(
        "host_file::tests::ensure_dir_handles_restrictive_umask_child",
        (RESTRICTIVE_UMASK_CHILD_ENV, "1"),
        &[],
        Duration::from_secs(60),
    )
    .await;
}

#[test]
#[ignore]
fn ensure_dir_handles_restrictive_umask_child() {
    if !ignored_child_test_env_guard_enabled((RESTRICTIVE_UMASK_CHILD_ENV, "1")) {
        return;
    }

    let dir = tempfile::tempdir().unwrap();
    let _umask = UmaskGuard::set(Mode::from_bits_truncate(0o777));
    for (name, dir_mode) in [
        ("shared-parent", DirMode::SharedTrustedParent),
        ("shared", DirMode::SharedTrusted),
    ] {
        let base = dir.path().join(name);
        let path = base.join("child");

        ensure_dir(&path, dir_mode, "test directory").unwrap();

        assert_eq!(mode(&base), SHARED_TRUSTED_DIR_MODE);
        assert_eq!(mode(&path), SHARED_TRUSTED_DIR_MODE);
    }
}

struct UmaskGuard {
    original: Mode,
}

impl UmaskGuard {
    fn set(mask: Mode) -> Self {
        Self {
            original: nix::sys::stat::umask(mask),
        }
    }
}

impl Drop for UmaskGuard {
    fn drop(&mut self) {
        nix::sys::stat::umask(self.original);
    }
}

#[test]
fn ensure_dir_rejects_private_intermediate_symlink_without_touching_target() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    let link = dir.path().join("link");
    std::fs::create_dir(&target).unwrap();
    symlink(&target, &link).unwrap();

    let error = ensure_dir(&link.join("child"), DirMode::Private, "test directory").unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(!target.join("child").exists());
}

#[test]
fn ensure_dir_rejects_trusted_parent_intermediate_symlink_without_touching_target() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    let link = dir.path().join("link");
    std::fs::create_dir(&target).unwrap();
    symlink(&target, &link).unwrap();

    let error = ensure_dir(
        &link.join("child"),
        DirMode::TrustedParent,
        "test directory",
    )
    .unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(!target.join("child").exists());
}

#[test]
fn ensure_dir_rejects_private_parent_segment_before_creating_missing_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("base");
    std::fs::create_dir(&base).unwrap();

    let error = ensure_dir(
        &base.join("missing").join("..").join("leaf"),
        DirMode::Private,
        "test directory",
    )
    .unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(!base.join("missing").exists());
    assert!(!base.join("leaf").exists());
}

#[test]
fn ensure_dir_rejects_trusted_parent_parent_segment_before_creating_missing_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("base");
    std::fs::create_dir(&base).unwrap();

    let error = ensure_dir(
        &base.join("missing").join("..").join("leaf"),
        DirMode::TrustedParent,
        "test directory",
    )
    .unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(!base.join("missing").exists());
    assert!(!base.join("leaf").exists());
}

#[test]
fn ensure_dir_creates_shared_trusted_parent_as_shared() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("base");
    let path = base.join("child");

    ensure_dir(&path, DirMode::SharedTrustedParent, "test directory").unwrap();

    assert_eq!(mode(&base), SHARED_TRUSTED_DIR_MODE);
    assert_eq!(mode(&path), SHARED_TRUSTED_DIR_MODE);
}

#[test]
fn ensure_dir_keeps_existing_shared_trusted_parent_mode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("shared");
    std::fs::create_dir(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(PRIVATE_DIR_MODE)).unwrap();

    ensure_dir(&path, DirMode::SharedTrustedParent, "test directory").unwrap();

    assert_eq!(mode(&path), PRIVATE_DIR_MODE);
}

#[test]
fn ensure_dir_normalizes_existing_shared_trusted_mode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("shared");
    std::fs::create_dir(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(PRIVATE_DIR_MODE)).unwrap();

    ensure_dir(&path, DirMode::SharedTrusted, "test directory").unwrap();

    assert_eq!(mode(&path), SHARED_TRUSTED_DIR_MODE);
}

#[test]
fn ensure_dir_rejects_writable_shared_trusted_final_before_normalizing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("shared");
    std::fs::create_dir(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o777)).unwrap();

    let error = ensure_dir(&path, DirMode::SharedTrusted, "test directory").unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(mode(&path), 0o777);
}

#[test]
fn create_dir_component_keeps_eexist_intermediate_mode() {
    let dir = tempfile::tempdir().unwrap();
    let component = dir.path().join("existing");
    std::fs::create_dir(&component).unwrap();
    std::fs::set_permissions(
        &component,
        std::fs::Permissions::from_mode(PRIVATE_DIR_MODE),
    )
    .unwrap();
    let parent = open(dir.path(), dir_open_flags(), Mode::empty()).unwrap();
    let full_path = component.join("child");
    let walk = DirWalk {
        full_path: &full_path,
        mode: DirMode::SharedTrusted,
        context: "test directory",
        expected_uid: nix::unistd::geteuid().as_raw(),
        create_missing: true,
    };

    let component_fd = create_and_open_dir_component(
        &parent,
        Path::new("existing").as_os_str(),
        &component,
        &walk,
        false,
    )
    .unwrap();

    drop(component_fd);
    assert_eq!(mode(&component), PRIVATE_DIR_MODE);
}

#[test]
fn ensure_dir_rejects_shared_trusted_parent_intermediate_symlink_without_touching_target() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    let link = dir.path().join("link");
    std::fs::create_dir(&target).unwrap();
    symlink(&target, &link).unwrap();

    let error = ensure_dir(
        &link.join("child"),
        DirMode::SharedTrustedParent,
        "test directory",
    )
    .unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(!target.join("child").exists());
}

#[test]
fn open_private_append_file_rejects_symlink_parent_without_touching_target() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    let link = dir.path().join("link");
    std::fs::create_dir(&target).unwrap();
    symlink(&target, &link).unwrap();

    let error = open_private_append_file(&link.join("log.jsonl"), false).unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(!target.join("log.jsonl").exists());
}
