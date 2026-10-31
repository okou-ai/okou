//! Bounded, hardened I/O helpers for small runner state files.
//!
//! State files handled here are local runner coordination files such as the
//! proxy registry, mitm-addon flush state, live runner instance records,
//! home cache metadata reads, and diagnostic config reads. The helper
//! centralizes size-bounded reads and filesystem checks for paths that come
//! from local process or runner state.
//!
//! On Unix, reads open files with `O_NOFOLLOW`, `O_CLOEXEC`, and
//! `O_NONBLOCK`, then validate the opened descriptor with `fstat` before
//! reading. The post-open check rejects non-regular files and can optionally
//! require ownership by the current effective uid and reject group/other write
//! permissions through [`OwnerCheck`].
//! Non-Unix builds use a weaker fallback that keeps the byte limit but does
//! not provide the Unix-specific open flags, file-type validation, or owner
//! validation.
//!
//! Unix writes create a private same-directory temporary file, write and flush
//! its contents, then rename it over the target. This avoids exposing partial
//! contents through the target path, but it does not fsync the file or parent
//! directory and should not be treated as a crash-durability guarantee.

use std::fs::File;
use std::path::{Path, PathBuf};

use nix::fcntl::Flock;
use tokio::task::JoinHandle;

use crate::error::{HostError, HostResult};

pub const PROXY_REGISTRY_MAX_BYTES: u64 = 16 * 1024 * 1024;
pub const HOME_METADATA_MAX_BYTES: u64 = 1024 * 1024;

/// Ownership and write-trust policy for reading a runner state file.
#[derive(Debug, Clone, Copy)]
pub enum OwnerCheck {
    /// Skip owner validation.
    ///
    /// Use this for files that may legitimately be produced by another
    /// runner-adjacent process or uid. On Unix, this still keeps the helper's
    /// bounded read, nofollow open, nonblocking open, and regular-file checks;
    /// it only skips the current-euid ownership check.
    None,
    /// Require the opened file to be owned by the runner process effective uid.
    ///
    /// Use this for runner-owned files discovered from local process or state
    /// paths, where accepting a file owned by another uid would be suspicious.
    CurrentEuid,
    /// Require the current effective uid and reject group/other write bits.
    ///
    /// Catalog consumers use these same Unix trust checks. Validate the opened
    /// descriptor so an atomic path replacement cannot race a separate stat.
    CurrentEuidNoUntrustedWrites,
}

/// Read an optional UTF-8 state file with a caller-supplied byte limit.
///
/// Missing files return `Ok(None)`. Existing files must be valid UTF-8 after
/// the configured byte limit and any platform-specific state-file validation
/// are applied.
pub async fn read_to_string(
    path: &Path,
    max_bytes: u64,
    owner_check: OwnerCheck,
) -> HostResult<Option<String>> {
    let Some(bytes) = read_to_bytes(path, max_bytes, owner_check).await? else {
        return Ok(None);
    };
    String::from_utf8(bytes).map(Some).map_err(|e| {
        HostError::Internal(format!("read state file {} as UTF-8: {e}", path.display()))
    })
}

/// Read a required state file as bytes with a caller-supplied byte limit.
///
/// Missing files are returned as `NotFound` errors. Existing files use the
/// same bounded, platform-specific read path as [`read_to_string`].
pub async fn read_to_bytes_required(
    path: &Path,
    max_bytes: u64,
    owner_check: OwnerCheck,
) -> HostResult<Vec<u8>> {
    match read_to_bytes(path, max_bytes, owner_check).await? {
        Some(bytes) => Ok(bytes),
        None => Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("state file {} not found", path.display()),
        )
        .into()),
    }
}

async fn read_to_bytes(
    path: &Path,
    max_bytes: u64,
    owner_check: OwnerCheck,
) -> HostResult<Option<Vec<u8>>> {
    #[cfg(unix)]
    {
        read_to_bytes_unix(path, max_bytes, owner_check).await
    }

    #[cfg(not(unix))]
    {
        let _ = owner_check;
        read_to_bytes_fallback(path, max_bytes).await
    }
}

#[cfg(unix)]
async fn read_to_bytes_unix(
    path: &Path,
    max_bytes: u64,
    owner_check: OwnerCheck,
) -> HostResult<Option<Vec<u8>>> {
    let mut options = tokio::fs::OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    let file = match options.open(path).await {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(HostError::Internal(format!(
                "open state file {}: {e}",
                path.display()
            )));
        }
    };
    validate_open_state_file(&file, path, owner_check)?;
    read_open_file_bytes(file, path, max_bytes).await.map(Some)
}

#[cfg(not(unix))]
async fn read_to_bytes_fallback(path: &Path, max_bytes: u64) -> HostResult<Option<Vec<u8>>> {
    let file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(HostError::Internal(format!(
                "open state file {}: {e}",
                path.display()
            )));
        }
    };
    read_open_file_bytes(file, path, max_bytes).await.map(Some)
}

async fn read_open_file_bytes(
    file: tokio::fs::File,
    path: &Path,
    max_bytes: u64,
) -> HostResult<Vec<u8>> {
    crate::host_file::read_bounded_contents(file, path, max_bytes, "state file")
        .await
        .map_err(|error| HostError::Internal(error.to_string()))
}

#[cfg(unix)]
fn validate_open_state_file<Fd: std::os::fd::AsRawFd>(
    file: &Fd,
    path: &Path,
    owner_check: OwnerCheck,
) -> HostResult<()> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `stat` points to valid writable memory and `file` owns a live fd.
    let result = unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) };
    if result != 0 {
        return Err(HostError::Internal(format!(
            "stat state file {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        )));
    }
    // SAFETY: successful `fstat` initialized the full `stat` struct.
    let stat = unsafe { stat.assume_init() };
    let file_type = stat.st_mode & libc::S_IFMT;
    if file_type != libc::S_IFREG {
        return Err(HostError::Internal(format!(
            "{} is not a regular state file",
            path.display()
        )));
    }
    validate_owner_uid(
        stat.st_uid,
        nix::unistd::geteuid().as_raw(),
        owner_check,
        path,
    )?;
    if matches!(owner_check, OwnerCheck::CurrentEuidNoUntrustedWrites)
        && stat.st_mode & (libc::S_IWGRP | libc::S_IWOTH) != 0
    {
        return Err(HostError::Internal(format!(
            "{} is writable by group or other users",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn validate_owner_uid(
    stat_uid: libc::uid_t,
    expected_uid: libc::uid_t,
    owner_check: OwnerCheck,
    path: &Path,
) -> HostResult<()> {
    if matches!(
        owner_check,
        OwnerCheck::CurrentEuid | OwnerCheck::CurrentEuidNoUntrustedWrites
    ) && stat_uid != expected_uid
    {
        return Err(HostError::Internal(format!(
            "{} is owned by uid {}, but runner euid is {expected_uid}",
            path.display(),
            stat_uid
        )));
    }
    Ok(())
}

/// Write a state file, using target-path atomic replacement on Unix.
///
/// On Unix, this writes to a hidden same-directory temporary file created with
/// private `0600` permissions, flushes the file, renames it over the target,
/// and removes the temporary file on errors as best-effort cleanup. This avoids
/// exposing partial contents through the target path. The file and parent
/// directory are not fsynced, so this does not provide a crash-durability
/// guarantee. Non-Unix builds use `tokio::fs::write` as a weaker fallback.
///
/// Unix staging keeps a cleanup owner even if the opening or writing observer
/// is cancelled. Its Drop performs a synchronous best-effort unlink. This does
/// not retain caller-owned locks or cancel an already submitted rename; the
/// caller must still account for uncertain publication after cancellation.
pub async fn write_private_atomic(path: &Path, content: &[u8]) -> HostResult<()> {
    crate::host_file::write_private_atomic(path, content, "state file")
        .await
        .map_err(|e| HostError::Internal(e.to_string()))
}

/// Synchronous counterpart to [`write_private_atomic`] for a blocking owner.
///
/// The caller must keep this off async workers and retain its write authority
/// until the call returns. Publication, permissions, error cleanup and the lack
/// of an fsync guarantee match the asynchronous helper.
pub fn write_private_atomic_blocking(path: &Path, content: &[u8]) -> HostResult<()> {
    crate::host_file::write_private_atomic_blocking(path, content, "state file")
        .map_err(|e| HostError::Internal(e.to_string()))
}

/// Submit a private atomic write with its caller-supplied write authority.
///
/// Call from a Tokio runtime with the lock that authorizes `path`. The blocking
/// worker owns that exact guard through publication and staging cleanup;
/// dropping the returned observer detaches the work without releasing its lock.
/// The join result stays separate from the native write result so callers can
/// retain their domain-specific task-failure diagnostics. Filesystem behavior
/// and the lack of an fsync guarantee match [`write_private_atomic_blocking`].
pub fn spawn_locked_private_atomic_write(
    path: PathBuf,
    content: Vec<u8>,
    guard: Flock<File>,
) -> JoinHandle<HostResult<()>> {
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        write_private_atomic_blocking(&path, &content)
    })
}

#[cfg(test)]
#[cfg(unix)]
mod tests;
