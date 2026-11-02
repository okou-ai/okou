mod custody;

use super::*;
use nix::fcntl::FlockArg;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

#[test]
fn probe_lock_free_when_no_holder() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    match probe_lock(&path) {
        LockProbe::Free(_) => {}
        _ => panic!("expected Free"),
    }
}

#[test]
fn probe_lock_creates_parent_dirs() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("locks").join("test.lock");
    assert!(!dir.path().join("locks").exists());
    match probe_lock(&path) {
        LockProbe::Free(_) => {}
        _ => panic!("expected Free"),
    }
    assert!(dir.path().join("locks").exists());
}

#[test]
fn probe_existing_lock_missing_path_does_not_create_lock() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("locks").join("test.lock");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();

    match probe_existing_lock(&path) {
        ExistingLockProbe::Missing => {}
        _ => panic!("missing lock path must not be probeable"),
    }

    assert!(
        !path.exists(),
        "existing-lock probe must not create a missing lock"
    );
    assert!(
        dir.path().join("locks").exists(),
        "test setup should leave the existing parent dir intact"
    );
}

#[test]
fn probe_existing_lock_missing_parent_does_not_create_path() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("locks");
    let path = parent.join("test.lock");

    match probe_existing_lock(&path) {
        ExistingLockProbe::Missing => {}
        _ => panic!("missing lock parent must be reported missing"),
    }

    assert!(!parent.exists());
}

#[test]
fn probe_lock_held_when_shared_lock_exists() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");

    // Hold a shared lock (simulating a running runner).
    let file = std::fs::File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    let _shared = Flock::lock(file, FlockArg::LockShared).unwrap();

    match probe_lock(&path) {
        LockProbe::Held => {}
        _ => panic!("expected Held"),
    }
}

#[test]
fn probe_lock_held_when_exclusive_lock_exists() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");

    // Hold an exclusive lock (simulating a build).
    let file = std::fs::File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    let _excl = Flock::lock(file, FlockArg::LockExclusive).unwrap();

    match probe_lock(&path) {
        LockProbe::Held => {}
        _ => panic!("expected Held"),
    }
}

#[tokio::test]
async fn remove_unused_lock_after_probe_keeps_replaced_lock_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("locks").join("home-image-cache-test.lock");

    let held_lock = match probe_lock(&path) {
        LockProbe::Free(lock) => lock,
        LockProbe::Held => panic!("new test lock must not be held"),
        LockProbe::Error(e) => panic!("new test lock must be probeable: {e}"),
    };

    std::fs::remove_file(&path).unwrap();
    drop(lock::open_lock_file(&path).unwrap());
    assert!(
        path.exists(),
        "test setup must recreate the lock path with a new inode"
    );

    let removed =
        remove_unused_lock_after_probe(&path, held_lock, "home-image-cache-test.lock", false).await;

    assert!(!removed, "stale lock fd must not remove a recreated path");
    assert!(
        path.exists(),
        "cleanup must not remove a lock path recreated after this lock was acquired"
    );
}

#[test]
fn remove_lock_file_treats_missing_path_as_benign() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing.lock");
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());

    let removed = tracing::subscriber::with_default(subscriber, || remove_lock_file(&path));

    assert!(
        !removed,
        "a missing path must not count as this pass's removal"
    );
    assert!(
        captured.entries().is_empty(),
        "a concurrently removed lock path must not produce a warning"
    );
}
