use std::fs::File;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

use nix::fcntl::Flock;
use runner_host::gc::test_support::cancel_queued_removal;
use runner_host::gc::{ExistingLockProbe, LockProbe, probe_existing_lock, probe_lock};
use runner_host::lock::lock_matches_path;

use super::remove_cache_file;
use crate::cmd::gc::test_support::test_home;

fn cache_lease(root: &Path) -> (PathBuf, PathBuf, Flock<File>) {
    let home = test_home(root);
    std::fs::create_dir_all(home.debootstrap_dir()).unwrap();
    let key = home.debootstrap_lock();
    let lock = match probe_lock(&key) {
        LockProbe::Free(lock) => lock,
        _ => panic!("cache fixture could not acquire its actual debootstrap key"),
    };
    (home.debootstrap_dir().join("noble-amd64.tar"), key, lock)
}

fn assert_held(key: &Path) {
    assert!(
        matches!(probe_existing_lock(key), ExistingLockProbe::Held),
        "released debootstrap cache authority before physical unlink retired"
    );
}

fn cancelled_unlink_retains_cache_authority(failing: bool) {
    let dir = tempfile::tempdir().unwrap();
    let (path, key, lock) = cache_lease(dir.path());
    if failing {
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("retained"), b"cache bytes").unwrap();
    } else {
        std::fs::write(&path, b"retired cache").unwrap();
    }
    // Discovery and retention precede this admission. Poll the real unlink
    // owner once with its worker occupied, then drop only its observer.
    let _successors =
        cancel_queued_removal(remove_cache_file(&path, lock), std::slice::from_ref(&key)).unwrap();
    assert_held(&key);
    if failing {
        assert_eq!(
            std::fs::read(path.join("retained")).unwrap(),
            b"cache bytes"
        );
    } else {
        assert!(!path.try_exists().unwrap());
        std::fs::write(&path, b"successor cache").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"successor cache");
    }
}

#[test]
fn cancelled_cache_unlink_retains_lock_until_physical_retirement() {
    cancelled_unlink_retains_cache_authority(false);
}

#[tokio::test]
async fn observed_cache_unlink_returns_original_guard_for_remaining_files() {
    let dir = tempfile::tempdir().unwrap();
    let (path, key, lock) = cache_lease(dir.path());
    std::fs::write(&path, b"retired cache").unwrap();
    let original_fd = lock.as_raw_fd();
    let (lock, result) = remove_cache_file(&path, lock).await;

    result.unwrap();
    assert!(!path.try_exists().unwrap());
    assert_eq!(lock.as_raw_fd(), original_fd);
    assert!(lock_matches_path(&lock, &key).unwrap());
    assert_held(&key);
    // The caller keeps this same cache authority while unlinking its next file.
    std::fs::write(&path, b"next cache").unwrap();
    let (lock, result) = remove_cache_file(&path, lock).await;
    result.unwrap();
    assert!(!path.try_exists().unwrap());
    assert_eq!(lock.as_raw_fd(), original_fd);
    assert_held(&key);
    drop(lock);
    assert!(matches!(
        probe_existing_lock(&key),
        ExistingLockProbe::Free(_)
    ));
}

#[test]
fn cancelled_cache_io_error_retains_lock_until_physical_retirement() {
    cancelled_unlink_retains_cache_authority(true);
}

#[tokio::test]
async fn observed_missing_cache_returns_native_error_and_acquired_guard() {
    let dir = tempfile::tempdir().unwrap();
    let (path, key, lock) = cache_lease(dir.path());
    let (lock, result) = remove_cache_file(&path, lock).await;

    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::NotFound);
    assert!(lock_matches_path(&lock, &key).unwrap());
    assert_held(&key);
    drop(lock);
    assert!(matches!(
        probe_existing_lock(&key),
        ExistingLockProbe::Free(_)
    ));
}

#[tokio::test]
async fn observed_cache_io_error_returns_guard_and_retains_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let (path, key, lock) = cache_lease(dir.path());
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("retained"), b"cache bytes").unwrap();
    let (lock, result) = remove_cache_file(&path, lock).await;

    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::IsADirectory);
    assert_eq!(
        std::fs::read(path.join("retained")).unwrap(),
        b"cache bytes"
    );
    assert!(lock_matches_path(&lock, &key).unwrap());
    assert_held(&key);
    drop(lock);
    assert!(matches!(
        probe_existing_lock(&key),
        ExistingLockProbe::Free(_)
    ));
}
