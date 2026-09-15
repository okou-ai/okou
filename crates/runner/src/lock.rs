use std::fs::File;
use std::io;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use nix::fcntl::{Flock, FlockArg};

use crate::error::{RunnerError, RunnerResult};
use crate::host_file::{self, DirMode, PRIVATE_FILE_MODE};

const LOCK_BUSY_ERROR: &str = "lock is already held by another process";
const LOCK_REPLACED_MAX_RETRIES: usize = 64;
const LOCK_RETRY_INITIAL_DELAY: Duration = Duration::from_millis(5);
const LOCK_RETRY_MAX_DELAY: Duration = Duration::from_millis(50);

/// Open (or create) the lock file, creating parent directories as needed.
pub(crate) fn open_lock_file(path: &Path) -> RunnerResult<File> {
    let parent = host_file::file_parent(path);
    host_file::ensure_dir(parent, DirMode::TrustedParent, "lock directory")
        .map_err(|e| RunnerError::Internal(format!("create lock dir {}: {e}", parent.display())))?;

    let file = File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(PRIVATE_FILE_MODE)
        .custom_flags(host_file::private_file_open_flags())
        .open(path)
        .map_err(|e| RunnerError::Internal(format!("open lock {}: {e}", path.display())))?;
    host_file::secure_regular_private_file(&file, path, "lock file")
        .map_err(|e| RunnerError::Internal(format!("validate lock {}: {e}", path.display())))?;
    Ok(file)
}

fn metadata_is_current_inode(lock_meta: std::fs::Metadata, path: &Path) -> RunnerResult<bool> {
    let path_meta = match std::fs::symlink_metadata(path) {
        Ok(path_meta) => path_meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "lstat lock {}: {e}",
                path.display()
            )));
        }
    };
    Ok(lock_meta.dev() == path_meta.dev() && lock_meta.ino() == path_meta.ino())
}

/// Check whether an acquired lock still refers to the file currently at `path`.
pub(crate) fn lock_matches_path(lock: &Flock<File>, path: &Path) -> RunnerResult<bool> {
    let lock_meta = lock.metadata().map_err(|e| {
        RunnerError::Internal(format!("stat locked fd for {}: {e}", path.display()))
    })?;
    metadata_is_current_inode(lock_meta, path)
}

fn file_matches_path(file: &File, path: &Path) -> RunnerResult<bool> {
    let lock_meta = file
        .metadata()
        .map_err(|e| RunnerError::Internal(format!("stat lock fd for {}: {e}", path.display())))?;
    metadata_is_current_inode(lock_meta, path)
}

#[derive(Clone, Copy)]
enum LockMode {
    Exclusive,
    Shared,
    TryExclusive,
    TryShared,
}

impl LockMode {
    fn nonblocking_arg(self) -> FlockArg {
        match self {
            Self::Exclusive | Self::TryExclusive => FlockArg::LockExclusiveNonblock,
            Self::Shared | Self::TryShared => FlockArg::LockSharedNonblock,
        }
    }

    fn waits(self) -> bool {
        matches!(self, Self::Exclusive | Self::Shared)
    }

    fn map_error(self, path: &Path, e: nix::errno::Errno) -> RunnerError {
        RunnerError::Internal(format!("flock {}: {e}", path.display()))
    }
}

/// The result of an acquisition that reports contention instead of waiting
/// indefinitely.
///
/// `Acquired` owns the kernel flock for as long as its `Flock<File>` is kept.
/// Dropping that guard releases the lock. The guard's exclusive or shared mode
/// is determined by the helper that returned it. `Busy` means that the helper
/// did not obtain the lock because another lock holder had the current path;
/// filesystem, validation, and task failures are returned as `RunnerError`
/// values instead.
pub(crate) enum TryLock {
    /// The requested flock was acquired and remains held by this guard.
    Acquired(Flock<File>),
    /// The requested flock could not be acquired because it was busy.
    Busy,
}

/// The result of a nonblocking acquisition that probes an existing lock path.
///
/// `Acquired` owns the kernel flock for as long as its `Flock<File>` is kept;
/// dropping that guard releases the lock. The guard's exclusive or shared mode
/// is determined by the helper that returned it. `Busy` reports contention on
/// an existing path. `Missing` is reserved for an absent parent directory or
/// lock file; other filesystem, validation, and task failures are returned as
/// `RunnerError` values.
pub(crate) enum ExistingTryLock {
    /// The requested flock was acquired and remains held by this guard.
    Acquired(Flock<File>),
    /// The existing lock path is currently held by another lock holder.
    Busy,
    /// The lock parent directory or lock file does not exist.
    Missing,
}

enum LockAcquire {
    Acquired(Flock<File>),
    Busy,
}

async fn acquire_result_once(path: &Path, mode: LockMode) -> RunnerResult<LockAcquire> {
    let attempt_path = path.to_path_buf();
    tokio::task::spawn_blocking(move || acquire_result_blocking(&attempt_path, mode))
        .await
        .map_err(|e| RunnerError::Internal(format!("lock task: {e}")))?
}

async fn acquire_after_busy(path: &Path, mode: LockMode) -> RunnerResult<Flock<File>> {
    debug_assert!(mode.waits());
    let mut retry_delay = LOCK_RETRY_INITIAL_DELAY;
    loop {
        tokio::time::sleep(retry_delay).await;
        retry_delay = (retry_delay * 2).min(LOCK_RETRY_MAX_DELAY);
        match acquire_result_once(path, mode).await? {
            LockAcquire::Acquired(lock) => return Ok(lock),
            LockAcquire::Busy => {}
        }
    }
}

async fn acquire_result_with(path: PathBuf, mode: LockMode) -> RunnerResult<LockAcquire> {
    match acquire_result_once(&path, mode).await? {
        LockAcquire::Busy if mode.waits() => acquire_after_busy(&path, mode)
            .await
            .map(LockAcquire::Acquired),
        result => Ok(result),
    }
}

fn acquire_result_blocking(path: &Path, mode: LockMode) -> RunnerResult<LockAcquire> {
    acquire_result_blocking_with_open(path, mode, |path| open_lock_file(path).map(Some))?
        .ok_or_else(|| {
            RunnerError::Internal(format!("create lock {} returned missing", path.display()))
        })
}

fn acquire_existing_result_blocking(
    path: &Path,
    mode: LockMode,
) -> RunnerResult<Option<LockAcquire>> {
    debug_assert!(matches!(mode, LockMode::TryExclusive | LockMode::TryShared));
    acquire_result_blocking_with_open(path, mode, open_existing_lock_file)
}

fn acquire_result_blocking_with_open(
    path: &Path,
    mode: LockMode,
    mut open: impl FnMut(&Path) -> RunnerResult<Option<File>>,
) -> RunnerResult<Option<LockAcquire>> {
    for _ in 0..LOCK_REPLACED_MAX_RETRIES {
        let file = match open(path)? {
            Some(file) => file,
            None => return Ok(None),
        };
        let lock = match Flock::lock(file, mode.nonblocking_arg()) {
            Ok(lock) => lock,
            Err((file, e)) if e == nix::errno::Errno::EWOULDBLOCK => {
                if file_matches_path(&file, path)? {
                    return Ok(Some(LockAcquire::Busy));
                }
                continue;
            }
            Err((_file, e)) => return Err(mode.map_error(path, e)),
        };
        if lock_matches_path(&lock, path)? {
            return Ok(Some(LockAcquire::Acquired(lock)));
        }
    }
    Err(RunnerError::Internal(format!(
        "lock {} was repeatedly replaced while acquiring",
        path.display()
    )))
}

fn open_existing_lock_file(path: &Path) -> RunnerResult<Option<File>> {
    let parent = host_file::file_parent(path);
    match std::fs::symlink_metadata(parent) {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "stat lock parent {}: {e}",
                parent.display()
            )));
        }
    }
    match host_file::validate_file_parent(path, "lock directory") {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "validate lock parent {}: {e}",
                path.display()
            )));
        }
    }

    let file = match File::options()
        .read(true)
        .write(true)
        .custom_flags(host_file::private_file_open_flags())
        .open(path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "open lock {}: {e}",
                path.display()
            )));
        }
    };
    host_file::secure_regular_private_file(&file, path, "lock file")
        .map_err(|e| RunnerError::Internal(format!("validate lock {}: {e}", path.display())))?;
    Ok(Some(file))
}

async fn acquire_with(path: PathBuf, mode: LockMode) -> RunnerResult<Flock<File>> {
    match acquire_result_with(path, mode).await? {
        LockAcquire::Acquired(lock) => Ok(lock),
        LockAcquire::Busy => Err(RunnerError::Config(LOCK_BUSY_ERROR.into())),
    }
}

/// Acquire an exclusive flock on the given path, waiting asynchronously until available.
///
/// Missing parent directories and the lock file are created as needed. The
/// path is checked for a trusted parent and a runner-owned, regular, private
/// lock file; invalid or insecure paths return a `RunnerError`.
///
/// Waiting is cancellation-safe: dropping the returned future stops future attempts.
/// The returned guard holds the lock until dropped.
pub async fn acquire(path: PathBuf) -> RunnerResult<Flock<File>> {
    acquire_with(path, LockMode::Exclusive).await
}

/// Acquire a shared flock on the given path, waiting asynchronously until available.
///
/// Multiple shared locks can coexist; only exclusive locks conflict.
/// Missing parent directories and the lock file are created as needed. The
/// path is checked for a trusted parent and a runner-owned, regular, private
/// lock file; invalid or insecure paths return a `RunnerError`.
///
/// Waiting is cancellation-safe: dropping the returned future stops future attempts.
/// The returned guard holds the lock until dropped.
pub async fn acquire_shared(path: PathBuf) -> RunnerResult<Flock<File>> {
    acquire_with(path, LockMode::Shared).await
}

/// Try to acquire an exclusive flock, returning an error immediately if held by another process.
///
/// This helper does not wait for contention. It creates missing parent
/// directories and the lock file as needed, validates the path as a trusted
/// private lock path, and maps contention to `RunnerError::Config`. Other path,
/// validation, flock, and task failures are returned as `RunnerError` values.
///
/// The returned guard holds the lock until dropped.
pub async fn try_acquire(path: PathBuf) -> RunnerResult<Flock<File>> {
    acquire_with(path, LockMode::TryExclusive).await
}

/// Acquire an exclusive flock, bounding only the wait after observed contention.
///
/// Scheduling delay before the first acquisition attempt does not consume the timeout.
/// The first attempt uses the create-or-open path and is immediate with
/// respect to lock contention. If it observes contention, retries wait
/// asynchronously for at most `contention_timeout`; expiration returns
/// `TryLock::Busy`. Path, validation, flock, and task failures remain errors.
/// On success, the `TryLock::Acquired` guard holds the lock until dropped.
pub async fn acquire_with_contention_timeout(
    path: PathBuf,
    contention_timeout: Duration,
) -> RunnerResult<TryLock> {
    acquire_with_contention_timeout_after_busy(path, contention_timeout, std::future::ready(()))
        .await
}

async fn acquire_with_contention_timeout_after_busy(
    path: PathBuf,
    contention_timeout: Duration,
    after_busy: impl std::future::Future<Output = ()>,
) -> RunnerResult<TryLock> {
    match acquire_result_once(&path, LockMode::Exclusive).await? {
        LockAcquire::Acquired(lock) => Ok(TryLock::Acquired(lock)),
        LockAcquire::Busy => {
            after_busy.await;
            match tokio::time::timeout(
                contention_timeout,
                acquire_after_busy(&path, LockMode::Exclusive),
            )
            .await
            {
                Ok(result) => result.map(TryLock::Acquired),
                Err(_) => Ok(TryLock::Busy),
            }
        }
    }
}

#[cfg(test)]
pub(crate) async fn acquire_with_contention_timeout_after_busy_for_test(
    path: PathBuf,
    contention_timeout: Duration,
    after_busy: impl std::future::Future<Output = ()>,
) -> RunnerResult<TryLock> {
    acquire_with_contention_timeout_after_busy(path, contention_timeout, after_busy).await
}

/// Try to acquire an exclusive flock without waiting for contention.
///
/// This helper creates missing parent directories and the lock file as needed
/// and validates the path as a trusted, runner-owned, regular, private lock
/// file. Contention is returned as `TryLock::Busy`; path, validation, flock,
/// and task failures are returned as `RunnerError` values. On success, the
/// `TryLock::Acquired` guard holds the lock until dropped.
pub async fn try_acquire_or_busy(path: PathBuf) -> RunnerResult<TryLock> {
    tokio::task::spawn_blocking(move || try_acquire_or_busy_blocking(&path))
        .await
        .map_err(|e| RunnerError::Internal(format!("lock task: {e}")))?
}

pub(crate) fn try_acquire_or_busy_blocking(path: &Path) -> RunnerResult<TryLock> {
    match acquire_result_blocking(path, LockMode::TryExclusive)? {
        LockAcquire::Acquired(lock) => Ok(TryLock::Acquired(lock)),
        LockAcquire::Busy => Ok(TryLock::Busy),
    }
}

/// Try to acquire a shared flock without waiting for an exclusive lock holder.
///
/// This helper creates missing parent directories and the lock file as needed
/// and validates the path as a trusted, runner-owned, regular, private lock
/// file. Contention is returned as `TryLock::Busy`; path, validation, flock,
/// and task failures are returned as `RunnerError` values. On success, the
/// `TryLock::Acquired` guard holds the shared lock until dropped.
pub async fn try_acquire_shared_or_busy(path: PathBuf) -> RunnerResult<TryLock> {
    match acquire_result_with(path, LockMode::TryShared).await? {
        LockAcquire::Acquired(lock) => Ok(TryLock::Acquired(lock)),
        LockAcquire::Busy => Ok(TryLock::Busy),
    }
}

/// Try to acquire an exclusive flock on an existing path without waiting.
///
/// This is an existing-only probe: it does not create missing parent
/// directories or a lock file. `ExistingTryLock::Missing` is returned when
/// either is absent, while contention is returned as
/// `ExistingTryLock::Busy`. An existing path is still required to be a
/// trusted, runner-owned, regular, private lock file; invalid or insecure
/// paths return a `RunnerError` rather than `Missing`. A successful
/// `ExistingTryLock::Acquired` guard holds the lock until dropped.
pub async fn try_acquire_existing_or_missing(path: PathBuf) -> RunnerResult<ExistingTryLock> {
    tokio::task::spawn_blocking(move || try_acquire_existing_or_missing_blocking(&path))
        .await
        .map_err(|e| RunnerError::Internal(format!("lock task: {e}")))?
}

pub(crate) fn try_acquire_existing_or_missing_blocking(
    path: &Path,
) -> RunnerResult<ExistingTryLock> {
    match acquire_existing_result_blocking(path, LockMode::TryExclusive)? {
        Some(LockAcquire::Acquired(lock)) => Ok(ExistingTryLock::Acquired(lock)),
        Some(LockAcquire::Busy) => Ok(ExistingTryLock::Busy),
        None => Ok(ExistingTryLock::Missing),
    }
}

/// Try to acquire a shared flock on an existing path without waiting for an
/// exclusive lock holder.
///
/// This is an existing-only probe: it does not create missing parent
/// directories or a lock file. `ExistingTryLock::Missing` is returned when
/// either is absent, while contention is returned as
/// `ExistingTryLock::Busy`. An existing path is still required to be a
/// trusted, runner-owned, regular, private lock file; invalid or insecure
/// paths return a `RunnerError` rather than `Missing`. A successful
/// `ExistingTryLock::Acquired` guard holds the shared lock until dropped.
pub async fn try_acquire_existing_shared_or_missing(
    path: PathBuf,
) -> RunnerResult<ExistingTryLock> {
    tokio::task::spawn_blocking(move || try_acquire_existing_shared_or_missing_blocking(&path))
        .await
        .map_err(|e| RunnerError::Internal(format!("lock task: {e}")))?
}

pub(crate) fn try_acquire_existing_shared_or_missing_blocking(
    path: &Path,
) -> RunnerResult<ExistingTryLock> {
    match acquire_existing_result_blocking(path, LockMode::TryShared)? {
        Some(LockAcquire::Acquired(lock)) => Ok(ExistingTryLock::Acquired(lock)),
        Some(LockAcquire::Busy) => Ok(ExistingTryLock::Busy),
        None => Ok(ExistingTryLock::Missing),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::{Future as _, poll_fn};
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::sync::mpsc;
    use std::time::Instant;

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn replace_lock_path(path: &Path) -> RunnerResult<()> {
        std::fs::remove_file(path).map_err(|e| {
            RunnerError::Internal(format!("remove replaced lock {}: {e}", path.display()))
        })?;
        std::fs::write(path, b"replacement").map_err(|e| {
            RunnerError::Internal(format!("write replaced lock {}: {e}", path.display()))
        })
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
        let probe_completed_while_locked = runtime
            .block_on(async { tokio::time::timeout(WAIT_TIMEOUT, &mut probe).await.is_ok() });

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
            error.to_string().contains("open lock")
                || error.to_string().contains("regular lock file"),
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
}
