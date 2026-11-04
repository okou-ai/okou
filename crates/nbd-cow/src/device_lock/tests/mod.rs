use std::os::unix::fs::{PermissionsExt, symlink};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Barrier, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::*;

fn replace_lock_file(path: &Path) {
    std::fs::remove_file(path).expect("remove lock path");
    drop(create_lock_file(path).expect("recreate lock path"));
}

const CONCURRENT_CLAIM_RESULT_TIMEOUT: Duration = Duration::from_secs(5);
const CLAIM_WORKER_RELEASE_TIMEOUT: Duration = Duration::from_secs(10);
const WAITING_WORKER_RELEASE_TIMEOUT: Duration = Duration::from_secs(1);

type ClaimAttemptResult = Result<bool, String>;

fn collect_claim_results_and_join_workers(
    result_rx: mpsc::Receiver<ClaimAttemptResult>,
    expected_results: usize,
    timeout: Duration,
    release_txs: Vec<mpsc::Sender<()>>,
    handles: Vec<JoinHandle<()>>,
) -> Result<Vec<ClaimAttemptResult>, String> {
    let deadline = Instant::now() + timeout;
    let mut results = Vec::with_capacity(expected_results);
    let collection_result = loop {
        if results.len() == expected_results {
            break Ok(results);
        }

        let now = Instant::now();
        if now >= deadline {
            break Err(format!(
                "claim result collection timed out after {timeout:?}: {} of {expected_results} workers completed",
                results.len()
            ));
        }

        match result_rx.recv_timeout(deadline - now) {
            Ok(result) => results.push(result),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                break Err(format!(
                    "claim result collection timed out after {timeout:?}: {} of {expected_results} workers completed",
                    results.len()
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break Err(format!(
                    "claim result channel disconnected after {} of {expected_results} workers completed",
                    results.len()
                ));
            }
        }
    };

    for release_tx in release_txs {
        let _ = release_tx.send(());
    }

    let panicked_workers = handles
        .into_iter()
        .map(|handle| handle.join())
        .filter(Result::is_err)
        .count();

    match (collection_result, panicked_workers) {
        (Ok(results), 0) => Ok(results),
        (Ok(_), count) => Err(format!("claim worker panics during cleanup: {count}")),
        (Err(error), 0) => Err(error),
        (Err(error), count) => Err(format!(
            "{error}; claim worker panics during cleanup: {count}"
        )),
    }
}

#[test]
fn second_claim_for_same_index_reports_busy_until_first_drops() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first = try_acquire_device_claim_in(7, dir.path())
        .expect("first lock")
        .expect("first claim");

    assert!(
        try_acquire_device_claim_in(7, dir.path())
            .expect("second lock attempt")
            .is_none()
    );

    drop(first);

    assert!(
        try_acquire_device_claim_in(7, dir.path())
            .expect("third lock")
            .is_some()
    );
}

#[test]
fn concurrent_claims_for_same_index_have_single_winner() {
    let dir = tempfile::tempdir().expect("tempdir");
    let lock_dir = Arc::new(dir.path().to_owned());
    let worker_count = 8;
    let start = Arc::new(Barrier::new(worker_count + 1));
    let (result_tx, result_rx) = mpsc::channel();
    let mut release_txs = Vec::with_capacity(worker_count);
    let mut handles = Vec::with_capacity(worker_count);

    for _ in 0..worker_count {
        let lock_dir = Arc::clone(&lock_dir);
        let start = Arc::clone(&start);
        let result_tx = result_tx.clone();
        let (release_tx, release_rx) = mpsc::channel();
        release_txs.push(release_tx);
        handles.push(std::thread::spawn(move || {
            start.wait();
            let claim = try_acquire_device_claim_in(7, &lock_dir);
            let result = claim
                .as_ref()
                .map(|claim| claim.is_some())
                .map_err(|error| error.to_string());
            let holds_claim = matches!(&claim, Ok(Some(_)));
            let _ = result_tx.send(result);
            drop(result_tx);
            if holds_claim {
                release_rx
                    .recv_timeout(CLAIM_WORKER_RELEASE_TIMEOUT)
                    .expect("claim worker should be released");
            }
            drop(claim);
        }));
    }
    drop(result_tx);

    start.wait();
    let results = collect_claim_results_and_join_workers(
        result_rx,
        worker_count,
        CONCURRENT_CLAIM_RESULT_TIMEOUT,
        release_txs,
        handles,
    )
    .expect("claim workers should complete");

    assert_eq!(results.len(), worker_count);
    let winner_count = results
        .into_iter()
        .map(|result| result.expect("lock attempt should not fail"))
        .filter(|acquired| *acquired)
        .count();
    assert_eq!(winner_count, 1);
}

#[test]
fn claim_retries_after_successful_flock_on_replaced_inode() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = device_lock_path_in(7, dir.path());
    let mut replaced = false;

    let claim = try_acquire_device_claim_in_with(7, dir.path(), |lock_path| {
        if !replaced {
            replace_lock_file(lock_path);
            replaced = true;
        }
    })
    .expect("lock attempt should not fail")
    .expect("replacement lock should be free");

    assert!(replaced, "lock path should be replaced after flock");
    assert!(
        lock_inode_is_current(&claim._lock, &path).expect("inode comparison"),
        "returned claim should hold the current lock inode"
    );
}

#[test]
fn claim_retries_after_contention_on_replaced_inode() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = device_lock_path_in(7, dir.path());
    let stale_file = create_lock_file(&path).expect("create stale lock file");
    let _stale_lock = Flock::lock(stale_file, FlockArg::LockExclusiveNonblock)
        .map_err(|(_file, errno)| errno)
        .expect("hold stale lock");
    let mut replaced = false;

    let claim = try_acquire_device_claim_in_with(7, dir.path(), |lock_path| {
        if !replaced {
            replace_lock_file(lock_path);
            replaced = true;
        }
    })
    .expect("lock attempt should not fail")
    .expect("replacement lock should be free");

    assert!(replaced, "contended lock path should be replaced");
    assert!(
        lock_inode_is_current(&claim._lock, &path).expect("inode comparison"),
        "returned claim should hold the current lock inode"
    );
}

#[test]
fn claim_errors_after_repeated_lock_path_replacement() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = device_lock_path_in(7, dir.path());
    let mut replacement_count = 0;

    let error = try_acquire_device_claim_in_with(7, dir.path(), |lock_path| {
        replace_lock_file(lock_path);
        replacement_count += 1;
    })
    .expect_err("repeated lock path replacement should fail");

    assert_eq!(replacement_count, MAX_STALE_INODE_RETRIES);
    assert_eq!(error.kind(), io::ErrorKind::Other);
    assert_eq!(
        error.to_string(),
        format!("lock path {} changed during NBD claim", path.display())
    );
}

#[test]
fn claim_result_timeout_releases_and_joins_waiting_worker() {
    let (result_tx, result_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release_observed = Arc::new(AtomicBool::new(false));
    let worker_completed = Arc::new(AtomicBool::new(false));
    let release_observed_by_worker = Arc::clone(&release_observed);
    let worker_completed_by_worker = Arc::clone(&worker_completed);
    let handle = std::thread::spawn(move || {
        let released = release_rx
            .recv_timeout(WAITING_WORKER_RELEASE_TIMEOUT)
            .is_ok();
        release_observed_by_worker.store(released, Ordering::SeqCst);
        result_tx
            .send(Ok(false))
            .expect("send result after release");
        worker_completed_by_worker.store(true, Ordering::SeqCst);
    });

    let error = collect_claim_results_and_join_workers(
        result_rx,
        1,
        Duration::ZERO,
        vec![release_tx],
        vec![handle],
    )
    .expect_err("waiting result should exceed the collection deadline");

    assert!(
        error.contains("0 of 1 workers completed"),
        "unexpected error: {error}"
    );
    assert!(release_observed.load(Ordering::SeqCst));
    assert!(worker_completed.load(Ordering::SeqCst));
}

#[test]
fn held_claim_detects_replaced_lock_file_inode() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = device_lock_path_in(7, dir.path());
    let claim = try_acquire_device_claim_in(7, dir.path())
        .expect("lock")
        .expect("claim");

    replace_lock_file(&path);

    assert!(
        !lock_inode_is_current(&claim._lock, &path).expect("inode comparison"),
        "held claim should detect that the path was replaced"
    );
}

#[test]
fn claim_rejects_symlink_lock_path_without_touching_target() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = device_lock_path_in(7, dir.path());
    let target = dir.path().join("target.lock");
    std::fs::write(&target, b"target").expect("write target");
    symlink(&target, &path).expect("create lock path symlink");

    try_acquire_device_claim_in(7, dir.path()).expect_err("symlink lock path should fail");

    assert_eq!(std::fs::read(&target).expect("read target"), b"target");
    assert!(
        std::fs::symlink_metadata(&path)
            .expect("lock path metadata")
            .file_type()
            .is_symlink(),
        "lock path should remain a symlink"
    );
}

#[test]
fn held_claim_rejects_symlink_replacement_to_same_inode() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = device_lock_path_in(7, dir.path());
    let alias = dir.path().join("alias.lock");
    let claim = try_acquire_device_claim_in(7, dir.path())
        .expect("lock")
        .expect("claim");

    std::fs::hard_link(&path, &alias).expect("create lock alias");
    std::fs::remove_file(&path).expect("remove lock path");
    symlink(&alias, &path).expect("replace lock path with symlink");

    assert!(
        !lock_inode_is_current(&claim._lock, &path).expect("inode comparison"),
        "held claim should reject a symlink replacement even when it resolves to the same inode"
    );
}

#[test]
fn claim_rejects_fifo_lock_path_without_blocking() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = device_lock_path_in(7, dir.path());
    nix::unistd::mkfifo(
        &path,
        nix::sys::stat::Mode::from_bits_truncate(PRIVATE_FILE_MODE),
    )
    .expect("create fifo lock path");

    let error = try_acquire_device_claim_in(7, dir.path()).expect_err("fifo lock path should fail");

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(
        error.to_string().contains("not a regular lock file"),
        "unexpected error: {error}"
    );
}

#[test]
fn claim_rejects_hard_link_lock_path_without_chmod_target() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = device_lock_path_in(7, dir.path());
    let target = dir.path().join("target.lock");
    std::fs::write(&target, b"target").expect("write target");
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644))
        .expect("set target permissions");
    std::fs::hard_link(&target, &path).expect("create lock hard link");

    let error =
        try_acquire_device_claim_in(7, dir.path()).expect_err("hard-linked lock path should fail");

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(
        error.to_string().contains("multiple hard links"),
        "unexpected error: {error}"
    );
    assert_eq!(std::fs::read(&target).expect("read target"), b"target");
    assert_eq!(
        std::fs::metadata(&target)
            .expect("target metadata")
            .permissions()
            .mode()
            & 0o777,
        0o644
    );
}

#[test]
fn claim_tightens_world_readable_lock_file_permissions() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = device_lock_path_in(7, dir.path());
    std::fs::write(&path, b"").expect("write lock path");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
        .expect("set loose lock permissions");

    let _claim = try_acquire_device_claim_in(7, dir.path())
        .expect("lock")
        .expect("claim");

    assert_eq!(
        std::fs::metadata(&path)
            .expect("lock metadata")
            .permissions()
            .mode()
            & 0o777,
        PRIVATE_FILE_MODE
    );
}

#[test]
fn claim_reports_busy_for_held_legacy_world_readable_lock_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = device_lock_path_in(7, dir.path());
    std::fs::write(&path, b"").expect("write lock path");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
        .expect("set legacy lock permissions");
    let legacy_file = std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .expect("open legacy lock file");
    let _legacy_lock = Flock::lock(legacy_file, FlockArg::LockExclusiveNonblock)
        .map_err(|(_file, errno)| errno)
        .expect("hold legacy lock");

    let claim =
        try_acquire_device_claim_in(7, dir.path()).expect("new lock attempt should not fail");

    assert!(claim.is_none());
    assert_eq!(
        std::fs::metadata(&path)
            .expect("lock metadata")
            .permissions()
            .mode()
            & 0o777,
        PRIVATE_FILE_MODE
    );
}

#[test]
fn claim_rejects_group_writable_lock_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = device_lock_path_in(7, dir.path());
    std::fs::write(&path, b"").expect("write lock path");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o620))
        .expect("set group-writable lock permissions");

    let error = try_acquire_device_claim_in(7, dir.path())
        .expect_err("group-writable lock path should fail");

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(
        error.to_string().contains("group/other writable"),
        "unexpected error: {error}"
    );
}
