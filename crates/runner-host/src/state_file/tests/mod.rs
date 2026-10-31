use super::*;
use crate::test_support::{ignored_child_test_env_guard_enabled, run_ignored_child_test};
use std::ffi::CString;
use std::os::unix::fs::symlink;
use std::path::PathBuf;
use std::time::Duration;

const FIFO_READ_CHILD_PATH_ENV: &str = "OKOU_RUN_STATE_FILE_FIFO_READ_CHILD_PATH";

#[test]
fn blocking_atomic_write_replaces_without_following_symlink_and_stays_private() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    std::fs::write(&target, b"original target").unwrap();
    let path = dir.path().join("state.json");
    symlink(&target, &path).unwrap();

    write_private_atomic_blocking(&path, b"new content").unwrap();

    assert_eq!(std::fs::read(&path).unwrap(), b"new content");
    assert_eq!(std::fs::read(&target).unwrap(), b"original target");
    assert!(!std::fs::symlink_metadata(&path).unwrap().is_symlink());
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    write_private_atomic_blocking(&path, b"replacement").unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"replacement");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
}

#[test]
fn blocking_atomic_write_cleans_staging_after_publication_failure() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.json");
    std::fs::create_dir(&path).unwrap();

    let error = write_private_atomic_blocking(&path, b"content").unwrap_err();

    assert!(
        error.to_string().contains("rename state file"),
        "got {error}"
    );
    assert!(path.is_dir());
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[tokio::test]
async fn read_to_string_rejects_symlink_without_reading_target() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    std::fs::write(&target, "target").unwrap();
    let link = dir.path().join("link");
    symlink(&target, &link).unwrap();

    let error = read_to_string(&link, 1024, OwnerCheck::None)
        .await
        .unwrap_err();

    assert!(
        error.to_string().contains("open state file"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn read_to_string_rejects_fifo_without_blocking() {
    let dir = tempfile::tempdir().unwrap();
    let fifo = dir.path().join("fifo");
    let fifo_path = fifo.to_str().expect("temporary FIFO path must be UTF-8");
    run_ignored_child_test(
        "state_file::tests::read_to_string_rejects_fifo_without_blocking_child",
        (FIFO_READ_CHILD_PATH_ENV, fifo_path),
        &[],
        Duration::from_secs(10),
    )
    .await;
}

#[tokio::test]
#[ignore = "spawned by read_to_string_rejects_fifo_without_blocking"]
async fn read_to_string_rejects_fifo_without_blocking_child() {
    let Ok(fifo_path) = std::env::var(FIFO_READ_CHILD_PATH_ENV) else {
        return;
    };
    if !ignored_child_test_env_guard_enabled((FIFO_READ_CHILD_PATH_ENV, &fifo_path)) {
        return;
    }

    let fifo = PathBuf::from(fifo_path);
    let c_path = CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
    // SAFETY: `c_path` is a valid nul-terminated path for `mkfifo`.
    let result = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
    assert_eq!(
        result,
        0,
        "mkfifo failed: {}",
        std::io::Error::last_os_error()
    );

    let error = read_to_string(&fifo, 1024, OwnerCheck::None)
        .await
        .unwrap_err();

    assert!(
        error.to_string().contains("not a regular state file"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn read_to_string_rejects_directory() {
    let dir = tempfile::tempdir().unwrap();
    let state_dir = dir.path().join("state.json");
    std::fs::create_dir(&state_dir).unwrap();

    let error = read_to_string(&state_dir, 1024, OwnerCheck::None)
        .await
        .unwrap_err();

    assert!(
        error.to_string().contains("not a regular state file"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn read_to_string_rejects_oversized_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.json");
    std::fs::write(&path, b"abcdef").unwrap();

    let error = read_to_string(&path, 5, OwnerCheck::None)
        .await
        .unwrap_err();

    assert!(
        error.to_string().contains("exceeds 5 bytes"),
        "unexpected error: {error}"
    );
}

#[test]
fn validate_owner_uid_accepts_matching_uid() {
    let path = PathBuf::from("/tmp/state.json");
    validate_owner_uid(1000, 1000, OwnerCheck::CurrentEuid, &path).unwrap();
}

#[test]
fn validate_owner_uid_rejects_mismatched_uid() {
    let path = PathBuf::from("/tmp/state.json");
    let error = validate_owner_uid(1000, 2000, OwnerCheck::CurrentEuid, &path).unwrap_err();
    let message = error.to_string();

    assert!(
        message.contains(&path.display().to_string()),
        "missing path: {message}"
    );
    assert!(message.contains("1000"), "missing actual uid: {message}");
    assert!(message.contains("2000"), "missing expected uid: {message}");
}

#[test]
fn validate_owner_uid_none_accepts_mismatched_uid() {
    let path = PathBuf::from("/tmp/state.json");
    validate_owner_uid(1000, 2000, OwnerCheck::None, &path).unwrap();
}

#[test]
fn validate_open_state_file_accepts_regular_file_owned_by_current_uid() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.json");
    std::fs::write(&path, b"state").unwrap();

    let file = std::fs::File::open(&path).unwrap();
    validate_open_state_file(&file, &path, OwnerCheck::CurrentEuid).unwrap();
}
