//! Unique temporary paths and bounded inotify-backed file readiness.

use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
use std::io;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::unix::AsyncFd;

static UNIQUE_TEMP_PATH_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn unique_temp_path(prefix: &str) -> PathBuf {
    let timestamp_nanos = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_nanos(),
        Err(error) => error.duration().as_nanos(),
    };
    let counter = UNIQUE_TEMP_PATH_COUNTER.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!(
        "{prefix}-{}-{timestamp_nanos}-{counter}",
        std::process::id()
    ))
}

pub async fn wait_for_path(path: &Path, timeout: Duration) -> io::Result<()> {
    tokio::time::timeout(timeout, wait_for_path_event(path))
        .await
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                format!("timed out waiting for {}", path.display()),
            )
        })?
}

pub async fn wait_for_file_contains(
    path: &Path,
    needle: &str,
    timeout: Duration,
) -> io::Result<()> {
    tokio::time::timeout(
        timeout,
        wait_for_file_contains_event(path, needle.as_bytes()),
    )
    .await
    .map_err(|_| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            format!(
                "timed out waiting for {} to contain {needle:?}",
                path.display()
            ),
        )
    })?
}

async fn wait_for_file_contains_event(path: &Path, needle: &[u8]) -> io::Result<()> {
    if needle.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "file readiness marker must not be empty",
        ));
    }
    // Large backlog tests wait on multi-MiB logs. Compile the existing byte
    // matcher once instead of comparing every byte window after each write.
    let matcher = aho_corasick::AhoCorasick::new([needle]).map_err(io::Error::other)?;
    let dir = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("path has no parent directory: {}", path.display()),
        )
    })?;
    let inotify = Inotify::init(InitFlags::IN_NONBLOCK)
        .map_err(|error| io::Error::other(format!("inotify init: {error}")))?;
    inotify
        .add_watch(
            dir,
            AddWatchFlags::IN_CREATE
                | AddWatchFlags::IN_MODIFY
                | AddWatchFlags::IN_MOVED_TO
                | AddWatchFlags::IN_CLOSE_WRITE,
        )
        .map_err(|error| io::Error::other(format!("inotify watch: {error}")))?;
    let async_fd = async_inotify_fd(inotify)?;

    loop {
        match tokio::fs::read(path).await {
            Ok(contents) if matcher.find(&contents).is_some() => return Ok(()),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }

        let mut guard = async_fd.readable().await?;
        drain_inotify_fd(async_fd.get_ref().as_fd());
        guard.clear_ready();
    }
}

async fn wait_for_path_event(path: &Path) -> io::Result<()> {
    if tokio::fs::try_exists(path).await? {
        return Ok(());
    }

    let dir = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("path has no parent directory: {}", path.display()),
        )
    })?;
    let inotify = Inotify::init(InitFlags::IN_NONBLOCK)
        .map_err(|error| io::Error::other(format!("inotify init: {error}")))?;
    inotify
        .add_watch(dir, AddWatchFlags::IN_CREATE | AddWatchFlags::IN_MOVED_TO)
        .map_err(|error| io::Error::other(format!("inotify watch: {error}")))?;

    if tokio::fs::try_exists(path).await? {
        return Ok(());
    }

    let async_fd = async_inotify_fd(inotify)?;
    loop {
        let mut guard = async_fd.readable().await?;
        drain_inotify_fd(async_fd.get_ref().as_fd());
        guard.clear_ready();

        if tokio::fs::try_exists(path).await? {
            return Ok(());
        }
    }
}

fn async_inotify_fd(inotify: Inotify) -> io::Result<AsyncFd<OwnedFd>> {
    let fd: OwnedFd = inotify.into();
    AsyncFd::new(fd).map_err(|error| io::Error::other(format!("AsyncFd: {error}")))
}

fn drain_inotify_fd(fd: std::os::fd::BorrowedFd<'_>) {
    let mut buf = [0u8; 4096];
    loop {
        // SAFETY: fd is a valid non-blocking inotify descriptor borrowed from
        // AsyncFd. The stack buffer is valid for the requested byte length.
        let result = unsafe { libc::read(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
        if result <= 0 {
            break;
        }
    }
}
