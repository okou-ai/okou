//! Unique temporary paths and bounded inotify-backed file readiness.

use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
use std::io::{self, Seek, SeekFrom};
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
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
    wait_for_file_marker(path, needle, timeout, false).await
}

/// Wait for a marker in a file whose existing bytes are never rewritten.
/// A replacement file or an observed shrink starts a fresh scan.
pub async fn wait_for_appended_file_contains(
    path: &Path,
    needle: &str,
    timeout: Duration,
) -> io::Result<()> {
    wait_for_file_marker(path, needle, timeout, true).await
}

async fn wait_for_file_marker(
    path: &Path,
    needle: &str,
    timeout: Duration,
    append_only: bool,
) -> io::Result<()> {
    tokio::time::timeout(
        timeout,
        wait_for_file_contains_event(path, needle.as_bytes(), append_only),
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

async fn wait_for_file_contains_event(
    path: &Path,
    needle: &[u8],
    append_only: bool,
) -> io::Result<()> {
    if needle.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "file readiness marker must not be empty",
        ));
    }
    // Large backlog tests wait on multi-MiB logs. Compile the existing byte
    // matcher once instead of comparing every byte window after each write.
    let matcher = aho_corasick::AhoCorasick::new([needle]).map_err(io::Error::other)?;
    let inotify = watch_parent_directory(
        path,
        AddWatchFlags::IN_CREATE
            | AddWatchFlags::IN_MODIFY
            | AddWatchFlags::IN_MOVED_TO
            | AddWatchFlags::IN_CLOSE_WRITE,
    )?;
    let async_fd = async_inotify_fd(inotify)?;

    let overlap = append_only.then_some((needle.len() - 1) as u64);
    let mut previous = None;
    loop {
        match file_contains(path, &matcher, overlap, previous.take()).await {
            Ok((true, _)) => return Ok(()),
            Ok((false, cursor)) => previous = cursor,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }

        let mut guard = async_fd.readable().await?;
        drain_inotify_fd(async_fd.get_ref().as_fd());
        guard.clear_ready();
    }
}

struct ScannedFile {
    // Keep the inode alive until the next open, so reuse cannot look like an append.
    _file: std::fs::File,
    device: u64,
    inode: u64,
    end: u64,
}

async fn file_contains(
    path: &Path,
    matcher: &aho_corasick::AhoCorasick,
    overlap: Option<u64>,
    previous: Option<ScannedFile>,
) -> io::Result<(bool, Option<ScannedFile>)> {
    let path = path.to_owned();
    let matcher = matcher.clone();
    tokio::task::spawn_blocking(move || {
        let mut opened = std::fs::File::open(path)?;
        let identity = if let Some(overlap) = overlap {
            let metadata = opened.metadata()?;
            if let Some(previous) = previous
                && metadata.dev() == previous.device
                && metadata.ino() == previous.inode
                && metadata.len() >= previous.end
            {
                opened.seek(SeekFrom::Start(previous.end.saturating_sub(overlap)))?;
            }
            Some((metadata.dev(), metadata.ino()))
        } else {
            None
        };
        let mut file = ReadinessReader(opened);
        let found = matcher
            .try_stream_find_iter(&mut file)
            .map_err(io::Error::other)?
            .next()
            .transpose()?
            .is_some();
        if found {
            // Preserve the former read-to-EOF error boundary without retaining
            // the unread tail. Stream matching already consumed any lookahead.
            io::copy(&mut file, &mut io::sink())?;
            return Ok((true, None));
        }
        let cursor = if let Some((device, inode)) = identity {
            Some(ScannedFile {
                end: file.0.stream_position()?,
                _file: file.0,
                device,
                inode,
            })
        } else {
            None
        };
        Ok((false, cursor))
    })
    .await
    .map_err(io::Error::other)?
}

struct ReadinessReader(std::fs::File);

impl io::Read for ReadinessReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        loop {
            // Like the former read-to-end operation, retry interrupted reads.
            // The streaming matcher otherwise returns them to the caller.
            match io::Read::read(&mut self.0, buffer) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                result => return result,
            }
        }
    }
}

/// Wait for a path to appear, leaving deadline policy to the caller.
///
/// Callers may wrap this future in a timeout or race it against other paths.
/// Dropping the future releases its owned inotify descriptor.
pub async fn wait_for_path_event(path: &Path) -> io::Result<()> {
    if tokio::fs::try_exists(path).await? {
        return Ok(());
    }

    let inotify =
        watch_parent_directory(path, AddWatchFlags::IN_CREATE | AddWatchFlags::IN_MOVED_TO)?;

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

fn watch_parent_directory(path: &Path, flags: AddWatchFlags) -> io::Result<Inotify> {
    let dir = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("path has no parent directory: {}", path.display()),
        )
    })?;
    let inotify = Inotify::init(InitFlags::IN_NONBLOCK)
        .map_err(|error| io::Error::other(format!("inotify init: {error}")))?;
    inotify
        .add_watch(dir, flags)
        .map_err(|error| io::Error::other(format!("inotify watch: {error}")))?;
    Ok(inotify)
}

fn async_inotify_fd(inotify: Inotify) -> io::Result<AsyncFd<OwnedFd>> {
    let fd: OwnedFd = inotify.into();
    // SAFETY: AsyncFd owns fd and keeps its descriptor unchanged until drop.
    unsafe { AsyncFd::register(fd) }.map_err(|error| io::Error::other(format!("AsyncFd: {error}")))
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

#[cfg(test)]
mod tests;
