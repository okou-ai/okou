use std::fs::File;
use std::io;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use nix::fcntl::{Flock, FlockArg};

use crate::error::{HostError, HostResult};
use crate::host_file::{self, DirMode, PRIVATE_FILE_MODE};

const LOCK_BUSY_ERROR: &str = "lock is already held by another process";
const LOCK_REPLACED_MAX_RETRIES: usize = 64;
const LOCK_RETRY_INITIAL_DELAY: Duration = Duration::from_millis(5);
const LOCK_RETRY_MAX_DELAY: Duration = Duration::from_millis(50);

/// Open (or create) the lock file, creating parent directories as needed.
pub fn open_lock_file(path: &Path) -> HostResult<File> {
    let parent = host_file::file_parent(path);
    host_file::ensure_dir(parent, DirMode::TrustedParent, "lock directory")
        .map_err(|e| HostError::Internal(format!("create lock dir {}: {e}", parent.display())))?;

    let file = File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(PRIVATE_FILE_MODE)
        .custom_flags(host_file::private_file_open_flags())
        .open(path)
        .map_err(|e| HostError::Internal(format!("open lock {}: {e}", path.display())))?;
    host_file::secure_regular_private_file(&file, path, "lock file")
        .map_err(|e| HostError::Internal(format!("validate lock {}: {e}", path.display())))?;
    Ok(file)
}

fn metadata_is_current_inode(lock_meta: std::fs::Metadata, path: &Path) -> HostResult<bool> {
    let path_meta = match std::fs::symlink_metadata(path) {
        Ok(path_meta) => path_meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => {
            return Err(HostError::Internal(format!(
                "lstat lock {}: {e}",
                path.display()
            )));
        }
    };
    Ok(lock_meta.dev() == path_meta.dev() && lock_meta.ino() == path_meta.ino())
}

/// Check whether an acquired lock still refers to the file currently at `path`.
pub fn lock_matches_path(lock: &Flock<File>, path: &Path) -> HostResult<bool> {
    let lock_meta = lock
        .metadata()
        .map_err(|e| HostError::Internal(format!("stat locked fd for {}: {e}", path.display())))?;
    metadata_is_current_inode(lock_meta, path)
}

fn file_matches_path(file: &File, path: &Path) -> HostResult<bool> {
    let lock_meta = file
        .metadata()
        .map_err(|e| HostError::Internal(format!("stat lock fd for {}: {e}", path.display())))?;
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

    fn map_error(self, path: &Path, e: nix::errno::Errno) -> HostError {
        HostError::Internal(format!("flock {}: {e}", path.display()))
    }
}

/// The result of an acquisition that reports contention instead of waiting
/// indefinitely.
///
/// `Acquired` owns the kernel flock for as long as its `Flock<File>` is kept.
/// Dropping that guard releases the lock. The guard's exclusive or shared mode
/// is determined by the helper that returned it. `Busy` means that the helper
/// did not obtain the lock because another lock holder had the current path;
/// filesystem, validation, and task failures are returned as `HostError`
/// values instead.
pub enum TryLock {
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
/// `HostError` values.
pub enum ExistingTryLock {
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

async fn acquire_result_once(path: &Path, mode: LockMode) -> HostResult<LockAcquire> {
    let attempt_path = path.to_path_buf();
    tokio::task::spawn_blocking(move || acquire_result_blocking(&attempt_path, mode))
        .await
        .map_err(|e| HostError::Internal(format!("lock task: {e}")))?
}

async fn acquire_after_busy(path: &Path, mode: LockMode) -> HostResult<Flock<File>> {
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

async fn acquire_result_with(path: PathBuf, mode: LockMode) -> HostResult<LockAcquire> {
    match acquire_result_once(&path, mode).await? {
        LockAcquire::Busy if mode.waits() => acquire_after_busy(&path, mode)
            .await
            .map(LockAcquire::Acquired),
        result => Ok(result),
    }
}

fn acquire_result_blocking(path: &Path, mode: LockMode) -> HostResult<LockAcquire> {
    acquire_result_blocking_with_open(path, mode, |path| open_lock_file(path).map(Some))?
        .ok_or_else(|| {
            HostError::Internal(format!("create lock {} returned missing", path.display()))
        })
}

fn acquire_existing_result_blocking(
    path: &Path,
    mode: LockMode,
) -> HostResult<Option<LockAcquire>> {
    debug_assert!(matches!(mode, LockMode::TryExclusive | LockMode::TryShared));
    acquire_result_blocking_with_open(path, mode, open_existing_lock_file)
}

fn acquire_result_blocking_with_open(
    path: &Path,
    mode: LockMode,
    mut open: impl FnMut(&Path) -> HostResult<Option<File>>,
) -> HostResult<Option<LockAcquire>> {
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
    Err(HostError::Internal(format!(
        "lock {} was repeatedly replaced while acquiring",
        path.display()
    )))
}

fn open_existing_lock_file(path: &Path) -> HostResult<Option<File>> {
    let parent = host_file::file_parent(path);
    match std::fs::symlink_metadata(parent) {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(HostError::Internal(format!(
                "stat lock parent {}: {e}",
                parent.display()
            )));
        }
    }
    match host_file::validate_file_parent(path, "lock directory") {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(HostError::Internal(format!(
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
            return Err(HostError::Internal(format!(
                "open lock {}: {e}",
                path.display()
            )));
        }
    };
    host_file::secure_regular_private_file(&file, path, "lock file")
        .map_err(|e| HostError::Internal(format!("validate lock {}: {e}", path.display())))?;
    Ok(Some(file))
}

async fn acquire_with(path: PathBuf, mode: LockMode) -> HostResult<Flock<File>> {
    match acquire_result_with(path, mode).await? {
        LockAcquire::Acquired(lock) => Ok(lock),
        LockAcquire::Busy => Err(HostError::Config(LOCK_BUSY_ERROR.into())),
    }
}

/// Acquire an exclusive flock on the given path, waiting asynchronously until available.
///
/// Missing parent directories and the lock file are created as needed. The
/// path is checked for a trusted parent and a runner-owned, regular, private
/// lock file; invalid or insecure paths return a `HostError`.
///
/// Waiting is cancellation-safe: dropping the returned future stops future attempts.
/// The returned guard holds the lock until dropped.
pub async fn acquire(path: PathBuf) -> HostResult<Flock<File>> {
    acquire_with(path, LockMode::Exclusive).await
}

/// Acquire a shared flock on the given path, waiting asynchronously until available.
///
/// Multiple shared locks can coexist; only exclusive locks conflict.
/// Missing parent directories and the lock file are created as needed. The
/// path is checked for a trusted parent and a runner-owned, regular, private
/// lock file; invalid or insecure paths return a `HostError`.
///
/// Waiting is cancellation-safe: dropping the returned future stops future attempts.
/// The returned guard holds the lock until dropped.
pub async fn acquire_shared(path: PathBuf) -> HostResult<Flock<File>> {
    acquire_with(path, LockMode::Shared).await
}

/// Try to acquire an exclusive flock, returning an error immediately if held by another process.
///
/// This helper does not wait for contention. It creates missing parent
/// directories and the lock file as needed, validates the path as a trusted
/// private lock path, and maps contention to `HostError::Config`. Other path,
/// validation, flock, and task failures are returned as `HostError` values.
///
/// The returned guard holds the lock until dropped.
pub async fn try_acquire(path: PathBuf) -> HostResult<Flock<File>> {
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
) -> HostResult<TryLock> {
    acquire_with_contention_timeout_after_busy(
        path,
        LockMode::Exclusive,
        contention_timeout,
        std::future::ready(()),
    )
    .await
}

/// Observe actual contention before arming the production retry timeout.
/// Only owner tests enable this hook; the acquisition and retry loop are unchanged.
#[cfg(feature = "test-support")]
pub async fn acquire_with_contention_timeout_for_test(
    path: PathBuf,
    contention_timeout: Duration,
    after_busy: impl std::future::Future<Output = ()>,
) -> HostResult<TryLock> {
    acquire_with_contention_timeout_after_busy(
        path,
        LockMode::Exclusive,
        contention_timeout,
        after_busy,
    )
    .await
}

async fn acquire_with_contention_timeout_after_busy(
    path: PathBuf,
    mode: LockMode,
    contention_timeout: Duration,
    after_busy: impl std::future::Future<Output = ()>,
) -> HostResult<TryLock> {
    match acquire_result_once(&path, mode).await? {
        LockAcquire::Acquired(lock) => Ok(TryLock::Acquired(lock)),
        LockAcquire::Busy => {
            after_busy.await;
            match tokio::time::timeout(contention_timeout, acquire_after_busy(&path, mode)).await {
                Ok(result) => result.map(TryLock::Acquired),
                Err(_) => Ok(TryLock::Busy),
            }
        }
    }
}

/// Try to acquire an exclusive flock without waiting for contention.
///
/// This helper creates missing parent directories and the lock file as needed
/// and validates the path as a trusted, runner-owned, regular, private lock
/// file. Contention is returned as `TryLock::Busy`; path, validation, flock,
/// and task failures are returned as `HostError` values. On success, the
/// `TryLock::Acquired` guard holds the lock until dropped.
pub async fn try_acquire_or_busy(path: PathBuf) -> HostResult<TryLock> {
    tokio::task::spawn_blocking(move || try_acquire_or_busy_blocking(&path))
        .await
        .map_err(|e| HostError::Internal(format!("lock task: {e}")))?
}

pub fn try_acquire_or_busy_blocking(path: &Path) -> HostResult<TryLock> {
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
/// and task failures are returned as `HostError` values. On success, the
/// `TryLock::Acquired` guard holds the shared lock until dropped.
pub async fn try_acquire_shared_or_busy(path: PathBuf) -> HostResult<TryLock> {
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
/// paths return a `HostError` rather than `Missing`. A successful
/// `ExistingTryLock::Acquired` guard holds the lock until dropped.
pub async fn try_acquire_existing_or_missing(path: PathBuf) -> HostResult<ExistingTryLock> {
    tokio::task::spawn_blocking(move || try_acquire_existing_or_missing_blocking(&path))
        .await
        .map_err(|e| HostError::Internal(format!("lock task: {e}")))?
}

pub fn try_acquire_existing_or_missing_blocking(path: &Path) -> HostResult<ExistingTryLock> {
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
/// paths return a `HostError` rather than `Missing`. A successful
/// `ExistingTryLock::Acquired` guard holds the shared lock until dropped.
pub async fn try_acquire_existing_shared_or_missing(path: PathBuf) -> HostResult<ExistingTryLock> {
    tokio::task::spawn_blocking(move || try_acquire_existing_shared_or_missing_blocking(&path))
        .await
        .map_err(|e| HostError::Internal(format!("lock task: {e}")))?
}

pub fn try_acquire_existing_shared_or_missing_blocking(path: &Path) -> HostResult<ExistingTryLock> {
    match acquire_existing_result_blocking(path, LockMode::TryShared)? {
        Some(LockAcquire::Acquired(lock)) => Ok(ExistingTryLock::Acquired(lock)),
        Some(LockAcquire::Busy) => Ok(ExistingTryLock::Busy),
        None => Ok(ExistingTryLock::Missing),
    }
}

#[cfg(test)]
mod tests;
