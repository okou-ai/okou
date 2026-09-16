mod copy;
mod read;
mod write;

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::{fmt, io};

use guest_control_proto::ExecTermination;
use shell_quote::quote_shell_arg;
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

use crate::exec_operation;

pub use copy::{COPY_FILE_STREAM_MAX_BYTES, CopyFileOptions, CopyFileResult};
pub use write::WriteFileEntry;

const MISSING_FILE_EXIT_CODE: i32 = 66;

#[derive(Default)]
pub(crate) struct FileWritePathLocks {
    entries: Mutex<HashMap<PathBuf, FileWritePathLockEntry>>,
}

struct FileWritePathLockEntry {
    lock: Arc<RwLock<()>>,
    // Includes operations waiting to acquire the lock as well as guard holders.
    reservations: usize,
}

struct FileWritePathLockReservation<'a> {
    owner: &'a FileWritePathLocks,
    path: PathBuf,
    lock: Arc<RwLock<()>>,
}

enum FileWritePathGuardKind {
    Shared(OwnedRwLockReadGuard<()>),
    Exclusive(OwnedRwLockWriteGuard<()>),
}

struct FileWritePathGuard<'a> {
    guard: Option<FileWritePathGuardKind>,
    reservation: Option<FileWritePathLockReservation<'a>>,
}

impl FileWritePathLocks {
    async fn acquire_shared(&self, path: &str) -> FileWritePathGuard<'_> {
        let reservation = self.reserve(PathBuf::from(path));
        let guard = Arc::clone(&reservation.lock).read_owned().await;
        FileWritePathGuard::new(FileWritePathGuardKind::Shared(guard), reservation)
    }

    async fn acquire_shared_many<'a>(
        &self,
        paths: impl IntoIterator<Item = &'a str>,
    ) -> Vec<FileWritePathGuard<'_>> {
        let reservations = paths
            .into_iter()
            .map(PathBuf::from)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .map(|path| self.reserve(path))
            .collect::<Vec<_>>();
        let mut guards = Vec::with_capacity(reservations.len());
        for reservation in reservations {
            let guard = Arc::clone(&reservation.lock).read_owned().await;
            guards.push(FileWritePathGuard::new(
                FileWritePathGuardKind::Shared(guard),
                reservation,
            ));
        }
        guards
    }

    async fn acquire_exclusive(&self, path: &str) -> FileWritePathGuard<'_> {
        let reservation = self.reserve(PathBuf::from(path));
        let guard = Arc::clone(&reservation.lock).write_owned().await;
        FileWritePathGuard::new(FileWritePathGuardKind::Exclusive(guard), reservation)
    }

    fn reserve(&self, path: PathBuf) -> FileWritePathLockReservation<'_> {
        let mut entries = self.entries.lock().unwrap_or_else(|err| err.into_inner());
        let lock = if let Some(entry) = entries.get_mut(&path) {
            assert_ne!(entry.reservations, usize::MAX);
            entry.reservations += 1;
            Arc::clone(&entry.lock)
        } else {
            let lock = Arc::new(RwLock::new(()));
            entries.insert(
                path.clone(),
                FileWritePathLockEntry {
                    lock: Arc::clone(&lock),
                    reservations: 1,
                },
            );
            lock
        };
        FileWritePathLockReservation {
            owner: self,
            path,
            lock,
        }
    }
}

impl<'a> FileWritePathGuard<'a> {
    fn new(
        guard: FileWritePathGuardKind,
        reservation: FileWritePathLockReservation<'a>,
    ) -> FileWritePathGuard<'a> {
        FileWritePathGuard {
            guard: Some(guard),
            reservation: Some(reservation),
        }
    }
}

impl Drop for FileWritePathGuard<'_> {
    fn drop(&mut self) {
        // Release destination ownership before the reservation can remove its
        // registry entry and allow a new lock for the same path to be created.
        match self.guard.take() {
            Some(FileWritePathGuardKind::Shared(guard)) => drop(guard),
            Some(FileWritePathGuardKind::Exclusive(guard)) => drop(guard),
            None => {}
        }
        drop(self.reservation.take());
    }
}

impl Drop for FileWritePathLockReservation<'_> {
    fn drop(&mut self) {
        let mut entries = self
            .owner
            .entries
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let remove = if let Some(entry) = entries.get_mut(&self.path)
            && Arc::ptr_eq(&entry.lock, &self.lock)
        {
            assert!(entry.reservations > 0);
            entry.reservations -= 1;
            entry.reservations == 0
        } else {
            false
        };
        if remove {
            entries.remove(&self.path);
        }
    }
}

fn validate_guest_file_path(path: &str) -> io::Result<()> {
    if path.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "guest file path must not be empty",
        ));
    }
    if path.as_bytes().contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "guest file path contains NUL bytes",
        ));
    }
    Ok(())
}

fn read_regular_file_command(path: &str, missing_file_exit_code: i32) -> String {
    let path = quote_shell_arg(path);
    format!(
        "if test -f {path}; then cat 2>/dev/null < {path} || {{ test -f {path} || exit {missing_file_exit_code}; printf '%s\\n' 'failed to read file' >&2; exit 1; }}; else exit {missing_file_exit_code}; fi"
    )
}

fn normalize_file_exec_stderr(mut stderr: Vec<u8>, stderr_truncated: bool) -> Vec<u8> {
    if stderr_truncated {
        exec_operation::append_diagnostic(&mut stderr, "stderr truncated");
    }
    stderr
}

// Callers validate their own output contract and normalize stderr first, then
// interpret exit codes locally. Only non-exit terminal diagnostics are shared.
fn file_exec_exit_code(
    termination: ExecTermination,
    operation: &str,
    context: impl fmt::Display,
    stderr: &[u8],
    diagnostic: &str,
) -> io::Result<i32> {
    let (kind, reason) = match termination {
        ExecTermination::Exited { exit_code } => return Ok(exit_code),
        ExecTermination::TimedOut => (io::ErrorKind::TimedOut, "timed out"),
        ExecTermination::Cancelled => (io::ErrorKind::Other, "was cancelled"),
        ExecTermination::StartFailed => (io::ErrorKind::Other, "exec start failed"),
        ExecTermination::WaitFailed => (io::ErrorKind::Other, "exec wait failed"),
    };
    let prefix = format!("{operation} {reason}{context}");
    let mut details = Vec::new();
    if !stderr.is_empty() {
        details.push(format!("stderr: {}", String::from_utf8_lossy(stderr)));
    }
    if !diagnostic.is_empty() {
        details.push(format!("diagnostic: {diagnostic}"));
    }
    let message = if details.is_empty() {
        prefix
    } else {
        format!("{prefix}: {}", details.join("; "))
    };
    Err(io::Error::new(kind, message))
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::io;

    use crate::{FrameWriteObserver, GuestControlClient};

    pub(crate) const TEST_WRITE_FILE_CHUNK_LIMIT: usize = 1024;
    pub(crate) const COPY_FILE_STREAM_CHUNK_LIMIT: u32 = super::copy::COPY_FILE_STREAM_CHUNK_LIMIT;
    pub(crate) const COPY_FILE_STREAM_MAX_BYTES: u64 = super::copy::COPY_FILE_STREAM_MAX_BYTES;
    pub(crate) const WRITE_FILE_CHUNK_LIMIT: usize = super::write::WRITE_FILE_CHUNK_LIMIT;
    pub(crate) const WRITE_FILES_BATCH_CONTENT_LIMIT: usize =
        super::write::WRITE_FILES_BATCH_CONTENT_LIMIT;
    pub(crate) const WRITE_FILES_BATCH_FILE_LIMIT: usize =
        super::write::WRITE_FILES_BATCH_FILE_LIMIT;

    pub(crate) async fn write_file_with_small_chunks(
        host: &GuestControlClient,
        path: &str,
        content: &[u8],
        sudo: bool,
        write_observer: FrameWriteObserver,
    ) -> io::Result<()> {
        host.write_file_with_write_observer_and_chunk_limit(
            path,
            content,
            sudo,
            write_observer,
            TEST_WRITE_FILE_CHUNK_LIMIT,
        )
        .await
    }

    pub(crate) async fn write_private_file_with_small_chunks(
        host: &GuestControlClient,
        path: &str,
        content: &[u8],
        write_observer: FrameWriteObserver,
    ) -> io::Result<()> {
        host.write_private_file_with_write_observer_and_chunk_limit(
            path,
            content,
            write_observer,
            TEST_WRITE_FILE_CHUNK_LIMIT,
        )
        .await
    }

    pub(crate) async fn write_private_files_with_small_limits(
        host: &GuestControlClient,
        files: &[crate::WriteFileEntry<'_>],
        write_observer: FrameWriteObserver,
    ) -> io::Result<()> {
        host.write_private_files_with_write_observer_and_limits(
            files,
            write_observer,
            TEST_WRITE_FILE_CHUNK_LIMIT,
            TEST_WRITE_FILE_CHUNK_LIMIT,
        )
        .await
    }
}
