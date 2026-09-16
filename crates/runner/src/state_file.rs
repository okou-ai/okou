//! Bounded, hardened I/O helpers for small runner state files.
//!
//! State files handled here are local runner coordination files such as the
//! proxy registry, mitm-addon flush state, live runner instance records,
//! workspace cache metadata reads, and diagnostic config reads. The helper
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

use std::path::Path;

use crate::error::{RunnerError, RunnerResult};

pub(crate) const PROXY_REGISTRY_MAX_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const WORKSPACE_METADATA_MAX_BYTES: u64 = 1024 * 1024;

/// Ownership and write-trust policy for reading a runner state file.
#[derive(Debug, Clone, Copy)]
pub(crate) enum OwnerCheck {
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
pub(crate) async fn read_to_string(
    path: &Path,
    max_bytes: u64,
    owner_check: OwnerCheck,
) -> RunnerResult<Option<String>> {
    let Some(bytes) = read_to_bytes(path, max_bytes, owner_check).await? else {
        return Ok(None);
    };
    String::from_utf8(bytes).map(Some).map_err(|e| {
        RunnerError::Internal(format!("read state file {} as UTF-8: {e}", path.display()))
    })
}

/// Read a required state file as bytes with a caller-supplied byte limit.
///
/// Missing files are returned as `NotFound` errors. Existing files use the
/// same bounded, platform-specific read path as [`read_to_string`].
pub(crate) async fn read_to_bytes_required(
    path: &Path,
    max_bytes: u64,
    owner_check: OwnerCheck,
) -> RunnerResult<Vec<u8>> {
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
) -> RunnerResult<Option<Vec<u8>>> {
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
) -> RunnerResult<Option<Vec<u8>>> {
    let mut options = tokio::fs::OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    let file = match options.open(path).await {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "open state file {}: {e}",
                path.display()
            )));
        }
    };
    validate_open_state_file(&file, path, owner_check)?;
    read_open_file_bytes(file, path, max_bytes).await.map(Some)
}

#[cfg(not(unix))]
async fn read_to_bytes_fallback(path: &Path, max_bytes: u64) -> RunnerResult<Option<Vec<u8>>> {
    let file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
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
) -> RunnerResult<Vec<u8>> {
    use tokio::io::AsyncReadExt;

    let read_limit = max_bytes.checked_add(1).ok_or_else(|| {
        RunnerError::Internal(format!(
            "state file {} read limit is too large",
            path.display()
        ))
    })?;
    let mut limited = file.take(read_limit);
    let mut contents = Vec::new();
    limited
        .read_to_end(&mut contents)
        .await
        .map_err(|e| RunnerError::Internal(format!("read state file {}: {e}", path.display())))?;
    if contents.len() as u64 > max_bytes {
        return Err(RunnerError::Internal(format!(
            "state file {} exceeds {} bytes",
            path.display(),
            max_bytes
        )));
    }
    Ok(contents)
}

#[cfg(unix)]
fn validate_open_state_file<Fd: std::os::fd::AsRawFd>(
    file: &Fd,
    path: &Path,
    owner_check: OwnerCheck,
) -> RunnerResult<()> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `stat` points to valid writable memory and `file` owns a live fd.
    let result = unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) };
    if result != 0 {
        return Err(RunnerError::Internal(format!(
            "stat state file {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        )));
    }
    // SAFETY: successful `fstat` initialized the full `stat` struct.
    let stat = unsafe { stat.assume_init() };
    let file_type = stat.st_mode & libc::S_IFMT;
    if file_type != libc::S_IFREG {
        return Err(RunnerError::Internal(format!(
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
        return Err(RunnerError::Internal(format!(
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
) -> RunnerResult<()> {
    if matches!(
        owner_check,
        OwnerCheck::CurrentEuid | OwnerCheck::CurrentEuidNoUntrustedWrites
    ) && stat_uid != expected_uid
    {
        return Err(RunnerError::Internal(format!(
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
pub(crate) async fn write_private_atomic(path: &Path, content: &[u8]) -> RunnerResult<()> {
    crate::host_file::write_private_atomic(path, content, "state file")
        .await
        .map_err(|e| RunnerError::Internal(e.to_string()))
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use crate::test_fixtures::ignored_child::{
        ignored_child_test_env_guard_enabled, run_ignored_child_test,
    };
    use std::ffi::CString;
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;
    use std::time::Duration;

    const FIFO_READ_CHILD_PATH_ENV: &str = "OKOU_RUN_STATE_FILE_FIFO_READ_CHILD_PATH";

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
}
