use super::*;
use std::future::{Future as _, poll_fn};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::sync::mpsc;
use std::time::Instant;

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn replace_lock_path(path: &Path) -> HostResult<()> {
    std::fs::remove_file(path).map_err(|e| {
        HostError::Internal(format!("remove replaced lock {}: {e}", path.display()))
    })?;
    std::fs::write(path, b"replacement")
        .map_err(|e| HostError::Internal(format!("write replaced lock {}: {e}", path.display())))
}

#[tokio::test]
async fn acquire_creates_lock_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");

    let guard = acquire(path.clone()).await.unwrap();
    assert!(path.exists());
    drop(guard);
}

#[test]
fn cancelled_acquire_does_not_occupy_blocking_pool() {
    const WAIT_TIMEOUT: Duration = Duration::from_secs(1);

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    let holder = Flock::lock(open_lock_file(&path).unwrap(), FlockArg::LockExclusive).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap();

    let (blocker_started_tx, blocker_started_rx) = mpsc::channel();
    let (release_blocker_tx, release_blocker_rx) = mpsc::channel();
    let blocker = runtime.spawn_blocking(move || {
        blocker_started_tx.send(()).unwrap();
        release_blocker_rx.recv().unwrap();
    });
    blocker_started_rx.recv_timeout(WAIT_TIMEOUT).unwrap();

    let (waiter_pending_tx, waiter_pending_rx) = mpsc::channel();
    let waiter_path = path.clone();
    let waiter = runtime.spawn(async move {
        let mut acquisition = Box::pin(acquire(waiter_path));
        let mut waiter_pending_tx = Some(waiter_pending_tx);
        poll_fn(move |context| {
            let poll = acquisition.as_mut().poll(context);
            if poll.is_pending()
                && let Some(waiter_pending_tx) = waiter_pending_tx.take()
            {
                waiter_pending_tx.send(()).unwrap();
            }
            poll
        })
        .await
    });
    waiter_pending_rx.recv_timeout(WAIT_TIMEOUT).unwrap();

    release_blocker_tx.send(()).unwrap();
    runtime.block_on(blocker).unwrap();
    let open_deadline = Instant::now() + WAIT_TIMEOUT;
    while mode(&path) != 0o600 {
        assert!(
            Instant::now() < open_deadline,
            "lock waiter did not open and tighten the lock file"
        );
        std::thread::yield_now();
    }

    waiter.abort();
    let waiter_error = runtime.block_on(waiter).unwrap_err();
    assert!(waiter_error.is_cancelled());

    let mut probe = runtime.spawn_blocking(|| {});
    let probe_completed_while_locked =
        runtime.block_on(async { tokio::time::timeout(WAIT_TIMEOUT, &mut probe).await.is_ok() });

    drop(holder);
    if !probe_completed_while_locked {
        runtime.block_on(probe).unwrap();
    }

    assert!(
        probe_completed_while_locked,
        "cancelled lock waiter kept the blocking-pool thread occupied"
    );
}

#[tokio::test]
async fn contention_timeout_acquires_after_observed_busy_is_released() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    let holder = acquire(path.clone()).await.unwrap();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let mut acquisition = Box::pin(acquire_with_contention_timeout_after_busy(
        path.clone(),
        LockMode::Exclusive,
        Duration::from_secs(2),
        async {
            entered_tx.send(()).unwrap();
            release_rx.await.unwrap();
        },
    ));
    tokio::select! {
        _ = acquisition.as_mut() => panic!("completed before observing Busy"),
        result = tokio::time::timeout(Duration::from_secs(2), entered_rx) => {
            result.unwrap().unwrap();
        }
    }
    drop(holder);
    release_tx.send(()).unwrap();
    let TryLock::Acquired(guard) = acquisition.await.unwrap() else {
        panic!("released flock must be acquired within the contention budget");
    };
    assert!(matches!(
        try_acquire_or_busy(path.clone()).await.unwrap(),
        TryLock::Busy
    ));
    drop(guard);
    assert!(matches!(
        try_acquire_or_busy(path).await.unwrap(),
        TryLock::Acquired(_)
    ));
}

#[tokio::test]
async fn contention_timeout_expires_after_the_retry_timer_is_armed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    let holder = acquire(path.clone()).await.unwrap();
    let timeout = Duration::from_millis(100);
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let mut acquisition = Box::pin(acquire_with_contention_timeout_after_busy(
        path.clone(),
        LockMode::Exclusive,
        timeout,
        async {
            entered_tx.send(()).unwrap();
            release_rx.await.unwrap();
        },
    ));
    tokio::select! {
        _ = acquisition.as_mut() => panic!("completed before observing Busy"),
        result = tokio::time::timeout(Duration::from_secs(2), entered_rx) => {
            result.unwrap().unwrap();
        }
    }
    // Real flock setup has completed; pause only the observed-contention phase.
    tokio::time::pause();
    release_tx.send(()).unwrap();
    poll_fn(|context| {
        assert!(acquisition.as_mut().poll(context).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    tokio::time::advance(timeout).await;
    assert!(matches!(acquisition.await.unwrap(), TryLock::Busy));
    tokio::time::resume();
    assert!(matches!(
        try_acquire_or_busy(path.clone()).await.unwrap(),
        TryLock::Busy
    ));
    drop(holder);
    assert!(matches!(
        acquire_with_contention_timeout(path, Duration::from_secs(2))
            .await
            .unwrap(),
        TryLock::Acquired(_)
    ));
}

#[tokio::test]
async fn cancelled_contention_timeout_leaves_no_lock_owner() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    let holder = acquire(path.clone()).await.unwrap();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let mut acquisition = Box::pin(acquire_with_contention_timeout_after_busy(
        path.clone(),
        LockMode::Exclusive,
        Duration::from_secs(2),
        async {
            entered_tx.send(()).unwrap();
            release_rx.await.unwrap();
        },
    ));
    tokio::select! {
        _ = acquisition.as_mut() => panic!("completed before observing Busy"),
        result = tokio::time::timeout(Duration::from_secs(2), entered_rx) => {
            result.unwrap().unwrap();
        }
    }
    tokio::time::pause();
    release_tx.send(()).unwrap();
    poll_fn(|context| {
        assert!(acquisition.as_mut().poll(context).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    drop(acquisition);
    tokio::time::resume();
    assert!(matches!(
        try_acquire_or_busy(path.clone()).await.unwrap(),
        TryLock::Busy
    ));
    drop(holder);
    assert!(matches!(
        acquire_with_contention_timeout(path, Duration::ZERO)
            .await
            .unwrap(),
        TryLock::Acquired(_)
    ));
}

#[tokio::test]
async fn acquire_creates_private_lock_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");

    let guard = acquire(path.clone()).await.unwrap();

    assert_eq!(mode(&path), 0o600);
    drop(guard);
}

#[tokio::test]
async fn acquire_tightens_existing_safe_lock_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    std::fs::write(&path, b"base-dir").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

    let guard = acquire(path.clone()).await.unwrap();

    assert_eq!(mode(&path), 0o600);
    drop(guard);
}

#[tokio::test]
async fn acquire_rejects_symlink_lock_path() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target.lock");
    let path = dir.path().join("test.lock");
    std::fs::write(&target, b"target").unwrap();
    symlink(&target, &path).unwrap();

    let error = acquire(path).await.unwrap_err();

    assert!(
        error.to_string().contains("open lock"),
        "unexpected error: {error}"
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"target");
}

#[tokio::test]
async fn acquire_rejects_fifo_lock_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    nix::unistd::mkfifo(&path, nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();

    let error = acquire(path).await.unwrap_err();

    assert!(
        error.to_string().contains("regular lock file"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn acquire_rejects_directory_lock_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    std::fs::create_dir(&path).unwrap();

    let error = acquire(path).await.unwrap_err();

    assert!(
        error.to_string().contains("open lock") || error.to_string().contains("regular lock file"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn acquire_rejects_group_writable_direct_parent() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("unsafe");
    std::fs::create_dir(&parent).unwrap();
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o777)).unwrap();
    let path = parent.join("test.lock");

    let error = acquire(path.clone()).await.unwrap_err();

    assert!(
        error.to_string().contains("group/other writable"),
        "unexpected error: {error}"
    );
    assert!(!path.exists());
}

#[tokio::test]
async fn acquire_allows_sticky_intermediate_parent_but_rejects_sticky_direct_parent() {
    let dir = tempfile::tempdir().unwrap();
    let sticky = dir.path().join("sticky");
    std::fs::create_dir(&sticky).unwrap();
    std::fs::set_permissions(&sticky, std::fs::Permissions::from_mode(0o1777)).unwrap();

    let direct_path = sticky.join("direct.lock");
    let error = acquire(direct_path.clone()).await.unwrap_err();
    assert!(
        error.to_string().contains("group/other writable"),
        "unexpected error: {error}"
    );
    assert!(!direct_path.exists());

    let nested_path = sticky.join("private").join("nested.lock");
    let guard = acquire(nested_path.clone()).await.unwrap();
    assert_eq!(mode(&nested_path), 0o600);
    drop(guard);
}

#[test]
fn acquire_returns_bounded_error_when_lock_path_keeps_being_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    let mut replacements = 0;

    let result = acquire_result_blocking_with_open(&path, LockMode::Exclusive, |path| {
        let file = open_lock_file(path)?;
        replacements += 1;
        replace_lock_path(path)?;
        Ok(Some(file))
    });
    let error = match result {
        Ok(_) => panic!("lock acquisition should fail after repeated replacement"),
        Err(error) => error,
    };

    assert_eq!(replacements, LOCK_REPLACED_MAX_RETRIES);
    assert!(
        error.to_string().contains("repeatedly replaced"),
        "unexpected error: {error}"
    );
}

#[test]
fn existing_acquire_returns_bounded_error_when_lock_path_keeps_being_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    std::fs::write(&path, b"initial").unwrap();
    let mut replacements = 0;

    let result = acquire_result_blocking_with_open(&path, LockMode::TryExclusive, |path| {
        let file = open_existing_lock_file(path)?.unwrap();
        replacements += 1;
        replace_lock_path(path)?;
        Ok(Some(file))
    });
    let error = match result {
        Ok(_) => panic!("existing lock acquisition should fail after repeated replacement"),
        Err(error) => error,
    };

    assert_eq!(replacements, LOCK_REPLACED_MAX_RETRIES);
    assert!(
        error.to_string().contains("repeatedly replaced"),
        "unexpected error: {error}"
    );
}

#[test]
fn acquire_retries_a_stale_successful_inode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    let mut attempts = 0;

    let result = acquire_result_blocking_with_open(&path, LockMode::TryExclusive, |path| {
        let file = open_lock_file(path)?;
        attempts += 1;
        if attempts == 1 {
            replace_lock_path(path)?;
        }
        Ok(Some(file))
    })
    .unwrap()
    .unwrap();
    let LockAcquire::Acquired(lock) = result else {
        panic!("replacement retry should acquire the current lock path");
    };

    assert_eq!(attempts, 2);
    assert!(lock_matches_path(&lock, &path).unwrap());
}

#[test]
fn acquire_retries_a_stale_contended_inode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    let holder = Flock::lock(open_lock_file(&path).unwrap(), FlockArg::LockExclusive).unwrap();
    let mut attempts = 0;

    let result = acquire_result_blocking_with_open(&path, LockMode::TryExclusive, |path| {
        let file = open_lock_file(path)?;
        attempts += 1;
        if attempts == 1 {
            replace_lock_path(path)?;
        }
        Ok(Some(file))
    })
    .unwrap()
    .unwrap();
    let LockAcquire::Acquired(lock) = result else {
        panic!("stale contention must not report the replacement path busy");
    };

    assert_eq!(attempts, 2);
    assert!(lock_matches_path(&lock, &path).unwrap());
    drop(holder);
}

#[tokio::test]
async fn held_lock_blocks_nonblocking_attempt() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");

    // Hold the lock via acquire().
    let _guard = acquire(path.clone()).await.unwrap();

    // A non-blocking attempt on the same file must fail with EWOULDBLOCK.
    let file = std::fs::File::options()
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    let err = Flock::lock(file, FlockArg::LockExclusiveNonblock).unwrap_err();
    assert_eq!(err.1, nix::errno::Errno::EWOULDBLOCK);
}

#[tokio::test]
async fn lock_released_on_drop() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");

    let guard = acquire(path.clone()).await.unwrap();
    drop(guard);

    // After drop, a non-blocking lock should succeed.
    let file = std::fs::File::options()
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    let _lock = Flock::lock(file, FlockArg::LockExclusiveNonblock).unwrap();
}

#[tokio::test]
async fn acquire_creates_parent_directories() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a").join("b").join("test.lock");

    let guard = acquire(path.clone()).await.unwrap();
    assert!(path.exists());
    drop(guard);
}

#[tokio::test]
async fn try_acquire_fails_when_held() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");

    let _guard = acquire(path.clone()).await.unwrap();
    let err = try_acquire(path).await.unwrap_err();
    assert!(err.to_string().contains("already held by another process"));
}

#[tokio::test]
async fn try_acquire_succeeds_when_free() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");

    let guard = try_acquire(path.clone()).await.unwrap();
    assert!(path.exists());
    drop(guard);
}

#[tokio::test]
async fn try_acquire_or_busy_reports_busy_when_held() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    let _guard = acquire(path.clone()).await.unwrap();

    let result = try_acquire_or_busy(path).await.unwrap();

    assert!(matches!(result, TryLock::Busy));
}

#[tokio::test]
async fn try_acquire_or_busy_propagates_lock_path_errors() {
    let path = PathBuf::from("/dev/null/impossible/test.lock");

    let result = try_acquire_or_busy(path).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn try_acquire_shared_or_busy_succeeds_with_existing_shared_lock() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    let _guard = acquire_shared(path.clone()).await.unwrap();

    let result = try_acquire_shared_or_busy(path).await.unwrap();

    assert!(matches!(result, TryLock::Acquired(_)));
}

#[tokio::test]
async fn try_acquire_shared_or_busy_reports_busy_when_exclusive_lock_held() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    let _guard = acquire(path.clone()).await.unwrap();

    let result = try_acquire_shared_or_busy(path).await.unwrap();

    assert!(matches!(result, TryLock::Busy));
}

#[tokio::test]
async fn try_acquire_existing_or_missing_does_not_create_missing_lock() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing.lock");

    let result = try_acquire_existing_or_missing(path.clone()).await.unwrap();

    assert!(matches!(result, ExistingTryLock::Missing));
    assert!(!path.exists());
}

#[tokio::test]
async fn try_acquire_existing_or_missing_reports_busy_when_shared_lock_held() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    let _guard = acquire_shared(path.clone()).await.unwrap();

    let result = try_acquire_existing_or_missing(path).await.unwrap();

    assert!(matches!(result, ExistingTryLock::Busy));
}

#[test]
fn try_acquire_existing_or_missing_blocking_tightens_safe_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    std::fs::write(&path, b"lock").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

    let result = try_acquire_existing_or_missing_blocking(&path).unwrap();

    assert!(matches!(result, ExistingTryLock::Acquired(_)));
    assert_eq!(mode(&path), 0o600);
}

#[test]
fn try_acquire_existing_or_missing_blocking_rejects_unsafe_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    std::fs::write(&path, b"lock").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o622)).unwrap();

    let error = match try_acquire_existing_or_missing_blocking(&path) {
        Ok(_) => panic!("group/other-writable lock file must be rejected"),
        Err(error) => error,
    };

    assert!(
        error.to_string().contains("group/other writable"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn try_acquire_existing_shared_or_missing_does_not_create_missing_lock() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing.lock");

    let result = try_acquire_existing_shared_or_missing(path.clone())
        .await
        .unwrap();

    assert!(matches!(result, ExistingTryLock::Missing));
    assert!(!path.exists());
}

#[tokio::test]
async fn try_acquire_existing_shared_or_missing_does_not_create_missing_parent() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("missing-parent");
    let path = parent.join("missing.lock");

    let result = try_acquire_existing_shared_or_missing(path).await.unwrap();

    assert!(matches!(result, ExistingTryLock::Missing));
    assert!(!parent.exists());
}

#[tokio::test]
async fn try_acquire_existing_shared_or_missing_succeeds_with_existing_shared_lock() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    let _guard = acquire_shared(path.clone()).await.unwrap();

    let result = try_acquire_existing_shared_or_missing(path).await.unwrap();

    assert!(matches!(result, ExistingTryLock::Acquired(_)));
}

#[tokio::test]
async fn try_acquire_existing_shared_or_missing_reports_busy_when_exclusive_lock_held() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    let _guard = acquire(path.clone()).await.unwrap();

    let result = try_acquire_existing_shared_or_missing(path).await.unwrap();

    assert!(matches!(result, ExistingTryLock::Busy));
}

#[test]
fn file_identity_check_detects_replaced_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    let file = open_lock_file(&path).unwrap();

    std::fs::remove_file(&path).unwrap();
    drop(open_lock_file(&path).unwrap());

    assert!(
        !file_matches_path(&file, &path).unwrap(),
        "inode check must reject an opened lock fd whose path was recreated"
    );
}

#[test]
fn lock_identity_check_rejects_symlink_to_same_inode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");
    let alias = dir.path().join("alias.lock");
    let lock = try_acquire_or_busy_blocking(&path).unwrap();
    let TryLock::Acquired(lock) = lock else {
        panic!("new lock path must be free");
    };

    std::fs::hard_link(&path, &alias).unwrap();
    std::fs::remove_file(&path).unwrap();
    symlink(&alias, &path).unwrap();

    assert!(
        !lock_matches_path(&lock, &path).unwrap(),
        "identity check must reject a symlink even when it resolves to the locked inode"
    );
}

#[tokio::test]
async fn shared_locks_coexist() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");

    let _guard1 = acquire_shared(path.clone()).await.unwrap();
    let _guard2 = acquire_shared(path.clone()).await.unwrap();
    // Both held simultaneously — no conflict.
}

#[tokio::test]
async fn shared_lock_blocks_exclusive() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");

    let _guard = acquire_shared(path.clone()).await.unwrap();
    let err = try_acquire(path).await.unwrap_err();
    assert!(err.to_string().contains("already held by another process"));
}

#[tokio::test]
async fn exclusive_blocks_shared_nonblocking() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.lock");

    let _guard = acquire(path.clone()).await.unwrap();

    // A nonblocking shared attempt must fail.
    let file = std::fs::File::options()
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    let err = Flock::lock(file, FlockArg::LockSharedNonblock).unwrap_err();
    assert_eq!(err.1, nix::errno::Errno::EWOULDBLOCK);
}

#[tokio::test]
async fn invalid_path_returns_error() {
    // /dev/null is a file, so create_dir_all cannot create a child directory
    // inside it — this fails even as root.
    let path = PathBuf::from("/dev/null/impossible/test.lock");
    let result = acquire(path).await;
    assert!(result.is_err());
}
