use super::*;
use crate::test_support::{ignored_child_test_env_guard_enabled, run_ignored_child_test};
use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::time::Duration;

const FIFO_READ_CHILD_PATH_ENV: &str = "OKOU_RUN_PRIVATE_FILE_FIFO_READ_CHILD_PATH";

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[tokio::test]
async fn read_private_file_rejects_fifo_without_blocking() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("runner_id");
    let fifo_path = path.to_str().expect("temporary FIFO path must be UTF-8");
    run_ignored_child_test(
        "private_fs::tests::read_private_file_rejects_fifo_without_blocking_child",
        (FIFO_READ_CHILD_PATH_ENV, fifo_path),
        &[],
        Duration::from_secs(10),
    )
    .await;
}

#[tokio::test]
#[ignore = "spawned by read_private_file_rejects_fifo_without_blocking"]
async fn read_private_file_rejects_fifo_without_blocking_child() {
    let Ok(path) = std::env::var(FIFO_READ_CHILD_PATH_ENV) else {
        return;
    };
    if !ignored_child_test_env_guard_enabled((FIFO_READ_CHILD_PATH_ENV, &path)) {
        return;
    }

    let path = PathBuf::from(path);
    let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();
    // SAFETY: `c_path` is a valid nul-terminated path for `mkfifo`.
    let result = unsafe { nix::libc::mkfifo(c_path.as_ptr(), 0o600) };
    assert_eq!(
        result,
        0,
        "mkfifo failed: {}",
        std::io::Error::last_os_error()
    );

    let error = read_private_file_to_string(&path).await.unwrap_err();

    assert!(
        error.to_string().contains("not a regular private file"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn read_private_file_rejects_large_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("runner_id");
    std::fs::write(
        &path,
        vec![b'x'; (PRIVATE_FILE_READ_MAX_BYTES + 1) as usize],
    )
    .unwrap();

    let error = read_private_file_to_string(&path).await.unwrap_err();

    assert!(
        error.to_string().contains("exceeds"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn read_private_file_rejects_group_writable_file_without_chmodding() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("runner_id");
    std::fs::write(&path, b"x").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660)).unwrap();

    let error = read_private_file_to_string(&path).await.unwrap_err();

    assert!(
        error.to_string().contains("group/other writable"),
        "unexpected error: {error}"
    );
    assert_eq!(mode(&path), 0o660);
}

#[tokio::test]
async fn read_private_file_tightens_safe_permissions() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("runner_id");
    std::fs::write(&path, b"runner-123").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

    let contents = read_private_file_to_string(&path).await.unwrap();

    assert_eq!(contents.as_deref(), Some("runner-123"));
    assert_eq!(mode(&path), crate::host_file::PRIVATE_FILE_MODE);
}

#[tokio::test]
async fn read_private_file_rejects_overflowing_read_limit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("runner_id");
    std::fs::write(&path, b"x").unwrap();

    let error = read_private_file_to_string_with_max(&path, u64::MAX)
        .await
        .unwrap_err();

    assert!(
        error.to_string().contains("read limit is too large"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn ensure_private_dir_creates_missing_dir_with_private_mode() {
    let dir = tempfile::tempdir().unwrap();
    let private_dir = dir.path().join("runner");

    ensure_private_dir(&private_dir).await.unwrap();

    assert_eq!(mode(&private_dir), PRIVATE_DIR_MODE);
}

#[tokio::test]
async fn ensure_private_dir_creates_missing_nested_dir_with_private_mode() {
    let dir = tempfile::tempdir().unwrap();
    let private_dir = dir.path().join("nested").join("runner");

    ensure_private_dir(&private_dir).await.unwrap();

    assert_eq!(mode(&private_dir), PRIVATE_DIR_MODE);
}

#[tokio::test]
async fn ensure_private_dir_rejects_filesystem_root() {
    let error = ensure_private_dir(Path::new("/")).await.unwrap_err();

    assert!(
        error.to_string().contains("reserved system path"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn ensure_private_dir_tightens_existing_dir() {
    let dir = tempfile::tempdir().unwrap();
    let private_dir = dir.path().join("runner");
    std::fs::create_dir(&private_dir).unwrap();
    std::fs::set_permissions(&private_dir, std::fs::Permissions::from_mode(0o755)).unwrap();

    ensure_private_dir(&private_dir).await.unwrap();

    assert_eq!(mode(&private_dir), PRIVATE_DIR_MODE);
}

#[tokio::test]
async fn ensure_private_dir_preserves_existing_intermediate_dir_mode() {
    let dir = tempfile::tempdir().unwrap();
    let intermediate = dir.path().join("nested");
    let private_dir = intermediate.join("runner");
    std::fs::create_dir(&intermediate).unwrap();
    std::fs::set_permissions(&intermediate, std::fs::Permissions::from_mode(0o755)).unwrap();

    ensure_private_dir(&private_dir).await.unwrap();

    assert_eq!(mode(&intermediate), 0o755);
    assert_eq!(mode(&private_dir), PRIVATE_DIR_MODE);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn ensure_private_dir_repairs_unreadable_existing_dir() {
    let dir = tempfile::tempdir().unwrap();
    let private_dir = dir.path().join("runner");
    std::fs::create_dir(&private_dir).unwrap();
    std::fs::set_permissions(&private_dir, std::fs::Permissions::from_mode(0o000)).unwrap();

    ensure_private_dir(&private_dir).await.unwrap();

    assert_eq!(mode(&private_dir), PRIVATE_DIR_MODE);
}

#[test]
fn create_private_dir_component_rejects_reserved_component() {
    use nix::fcntl::open;
    use nix::sys::stat::Mode;

    let dir = tempfile::tempdir().unwrap();
    let fd = open(dir.path(), private_dir_open_flags(), Mode::empty()).unwrap();

    let error = create_and_open_private_dir_component(
        &fd,
        OsStr::new("runners"),
        Path::new("/var/lib/vm0-runner"),
        Path::new("/var/lib/vm0-runner/runners/runner-01"),
        nix::unistd::geteuid().as_raw(),
        true,
    )
    .unwrap_err();

    assert!(
        error.to_string().contains("reserved system path"),
        "unexpected error: {error}"
    );
    assert!(
        !dir.path().join("runners").exists(),
        "reserved component should not be created"
    );
}

#[tokio::test]
async fn ensure_private_dir_rejects_regular_file() {
    let dir = tempfile::tempdir().unwrap();
    let private_dir = dir.path().join("runner");
    std::fs::write(&private_dir, b"not a dir").unwrap();

    let error = ensure_private_dir(&private_dir).await.unwrap_err();

    assert!(
        error.to_string().contains("not a directory"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn ensure_private_dir_rejects_intermediate_regular_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("file");
    let private_dir = file.join("runner");
    std::fs::write(&file, b"not a dir").unwrap();

    let error = ensure_private_dir(&private_dir).await.unwrap_err();

    assert!(
        error.to_string().contains("not a directory"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn ensure_private_dir_rejects_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    let private_dir = dir.path().join("runner");
    std::fs::create_dir(&target).unwrap();
    symlink(&target, &private_dir).unwrap();

    let error = ensure_private_dir(&private_dir).await.unwrap_err();

    assert!(
        error.to_string().contains("symlink"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn ensure_private_dir_rejects_symlink_with_trailing_separator() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    let private_dir = dir.path().join("runner");
    std::fs::create_dir(&target).unwrap();
    symlink(&target, &private_dir).unwrap();
    let private_dir_with_separator = PathBuf::from(format!("{}/", private_dir.display()));

    let error = ensure_private_dir(&private_dir_with_separator)
        .await
        .unwrap_err();

    assert!(
        error.to_string().contains("symlink"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn ensure_private_dir_rejects_intermediate_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    let link = dir.path().join("link");
    let private_dir = link.join("runner");
    std::fs::create_dir(&target).unwrap();
    symlink(&target, &link).unwrap();

    let error = ensure_private_dir(&private_dir).await.unwrap_err();

    assert!(
        error.to_string().contains("symlink component"),
        "unexpected error: {error}"
    );
    assert!(
        !target.join("runner").exists(),
        "private dir should not be created through an intermediate symlink"
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn ensure_private_dir_rejects_symlink_under_unreadable_intermediate_dir() {
    let dir = tempfile::tempdir().unwrap();
    let intermediate = dir.path().join("nested");
    let target = dir.path().join("target");
    let link = intermediate.join("link");
    let private_dir = link.join("runner");
    std::fs::create_dir(&intermediate).unwrap();
    std::fs::create_dir(&target).unwrap();
    symlink(&target, &link).unwrap();
    std::fs::set_permissions(&intermediate, std::fs::Permissions::from_mode(0o000)).unwrap();

    let error = ensure_private_dir(&private_dir).await.unwrap_err();
    let message = error.to_string();

    assert!(
        message.contains("symlink component")
            || message.contains("not a directory")
            || message.contains("EACCES")
            || message.contains("Permission denied"),
        "unexpected error: {error}"
    );
    assert!(
        !target.join("runner").exists(),
        "private dir should not be created through a symlink hidden by an unreadable parent"
    );
}

#[tokio::test]
async fn ensure_private_dir_rejects_parent_segments_before_creating_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing-prefix");
    let private_dir = missing.join("..").join("runner");

    let error = ensure_private_dir(&private_dir).await.unwrap_err();

    assert!(
        error.to_string().contains("parent directory segment"),
        "unexpected error: {error}"
    );
    assert!(
        !missing.exists(),
        "private dir validation should not create path prefixes before rejecting parent segments"
    );
}

#[tokio::test]
async fn ensure_private_dir_rejects_group_writable_parent_without_sticky_bit() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("shared");
    let private_dir = parent.join("runner");
    std::fs::create_dir(&parent).unwrap();
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o777)).unwrap();

    let error = ensure_private_dir(&private_dir).await.unwrap_err();

    assert!(
        error.to_string().contains("group/other writable"),
        "unexpected error: {error}"
    );
    assert!(
        !private_dir.exists(),
        "private dir should not be created under a replaceable parent"
    );
}

#[tokio::test]
async fn ensure_private_dir_allows_sticky_group_writable_parent() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("sticky");
    let private_dir = parent.join("runner");
    std::fs::create_dir(&parent).unwrap();
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o1777)).unwrap();

    ensure_private_dir(&private_dir).await.unwrap();

    assert_eq!(mode(&private_dir), PRIVATE_DIR_MODE);
}

#[tokio::test]
async fn ensure_private_dir_rejects_sticky_group_writable_final_dir() {
    let dir = tempfile::tempdir().unwrap();
    let private_dir = dir.path().join("runner");
    std::fs::create_dir(&private_dir).unwrap();
    std::fs::set_permissions(&private_dir, std::fs::Permissions::from_mode(0o1777)).unwrap();

    let error = ensure_private_dir(&private_dir).await.unwrap_err();

    assert!(
        error.to_string().contains("group/other writable"),
        "unexpected error: {error}"
    );
    assert_eq!(mode(&private_dir), 0o777);
}

#[test]
fn private_dir_parent_rejects_untrusted_owner() {
    use nix::fcntl::open;
    use nix::sys::stat::Mode;
    use nix::unistd::{Uid, chown};

    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("owned-by-other-user");
    std::fs::create_dir(&parent).unwrap();
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o555)).unwrap();
    if nix::unistd::geteuid().is_root() {
        chown(&parent, Some(Uid::from_raw(1)), None).unwrap();
    }
    let fd = open(&parent, private_dir_open_flags(), Mode::empty()).unwrap();

    let error = ensure_private_dir_parent_not_replaceable(&fd, &parent, &parent.join("runner"), 0)
        .unwrap_err();

    assert!(
        error.to_string().contains("untrusted uid"),
        "unexpected error: {error}"
    );
}

#[test]
fn private_dir_parent_allows_root_owned_parent_for_non_root_expected_uid() {
    use nix::fcntl::open;
    use nix::sys::stat::Mode;
    use nix::unistd::{Uid, chown};

    if !nix::unistd::geteuid().is_root() {
        return;
    }

    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("root-owned");
    std::fs::create_dir(&parent).unwrap();
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755)).unwrap();
    chown(&parent, Some(Uid::from_raw(0)), None).unwrap();
    let fd = open(&parent, private_dir_open_flags(), Mode::empty()).unwrap();

    ensure_private_dir_parent_not_replaceable(&fd, &parent, &parent.join("runner"), 1000).unwrap();
}

#[test]
fn reserved_private_dir_path_rejects_lexical_parent_segments() {
    for path in ["/var/lib/../lib", "/..", "/var/../.."] {
        let error = reject_reserved_private_dir_path(Path::new(path))
            .expect_err("reserved path should be rejected");

        assert!(
            error.to_string().contains("reserved system path"),
            "unexpected error for {path}: {error}"
        );
    }
}

#[test]
fn reserved_private_dir_path_rejects_relative_escape_from_cwd() {
    let cwd = Path::new("/var/lib/vm0-runner/runners/runner-01");

    for path in ["..", "../../.."] {
        let error = reject_reserved_private_dir_path_with_cwd(Path::new(path), cwd)
            .expect_err("reserved path should be rejected");

        assert!(
            error.to_string().contains("reserved system path"),
            "unexpected error for {path}: {error}"
        );
    }
}

#[test]
fn reserved_private_dir_path_rejects_shared_home_subtrees() {
    let home = HomePaths::new().unwrap();
    let shared_roots = [
        home.bin_dir(),
        home.ca_dir(),
        home.runner_control_dir(),
        home.debootstrap_dir(),
        home.root().join("firecracker"),
        home.firecracker_dir("v1"),
        home.groups_dir(),
        home.images_dir(),
        home.locks_dir(),
        home.live_runner_instances_dir(),
        home.logs_dir(),
        home.root().join("mitmproxy"),
        home.mitmproxy_dir("v1"),
        home.storages_dir(),
        home.home_image_cache_dir(),
    ];
    for root in shared_roots {
        for path in [root.clone(), root.join("runner-state")] {
            let error = reject_reserved_private_dir_path(&path)
                .expect_err("shared home subtree should be rejected");

            assert!(
                error.to_string().contains("reserved system path"),
                "unexpected error for {}: {error}",
                path.display()
            );
        }
    }
}

#[test]
fn reserved_private_dir_path_rejects_runner_control_dir_and_child() {
    let control = HomePaths::new().unwrap().runner_control_dir();
    for path in [control.clone(), control.join("runner-01")] {
        reject_reserved_private_dir_path(&path)
            .expect_err("runner control must remain shared state");
    }
    reject_reserved_private_dir_path(Path::new("/var/lib/vm0-runner/control-other")).unwrap();
}

#[test]
fn reserved_private_dir_path_allows_runner_child_dir() {
    let home = HomePaths::new().unwrap();
    reject_reserved_private_dir_path(home.root()).expect_err("home root must be reserved");
    reject_reserved_private_dir_path(&home.runners_dir())
        .expect_err("runners parent must be reserved");
    reject_reserved_private_dir_path(Path::new("/var/lib/vm0-runner/runners/runner-01")).unwrap();
    reject_reserved_private_dir_path(Path::new("/data/runner-01")).unwrap();
}

#[tokio::test]
async fn ensure_private_dir_rejects_owner_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let private_dir = dir.path().join("runner");
    std::fs::create_dir(&private_dir).unwrap();
    let actual_uid = std::fs::metadata(&private_dir).unwrap().uid();
    let mismatched_uid = if actual_uid == 0 { 1 } else { 0 };

    let fd =
        ensure_private_dir_exists_without_symlinks(&private_dir, nix::unistd::geteuid().as_raw())
            .unwrap();
    let error = ensure_private_dir_fd_owned_by(&private_dir, &fd, mismatched_uid).unwrap_err();

    assert!(
        error.to_string().contains("owned by uid"),
        "unexpected error: {error}"
    );
}
