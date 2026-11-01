use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};

/// Default buffer size for reading process output from stdout/stderr pipes.
const DEFAULT_DRAIN_READ_BYTES: usize = 64 * 1024;
/// Initial allocation for captured output, independent of the drain read size.
const INITIAL_CAPTURE_CAPACITY_BYTES: usize = 8 * 1024;

pub(crate) struct DrainCancellation {
    cancelled: AtomicBool,
    wake_reader: OwnedFd,
    wake_writer: Mutex<Option<OwnedFd>>,
}

impl DrainCancellation {
    pub(crate) fn new() -> io::Result<Self> {
        let mut fds = [0; 2];
        // SAFETY: `pipe2` initializes both descriptor slots on success.
        if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `pipe2` returned two distinct owned descriptors.
        let wake_reader = unsafe { OwnedFd::from_raw_fd(fds[0]) };
        // SAFETY: ownership of the second descriptor is transferred separately.
        let wake_writer = unsafe { OwnedFd::from_raw_fd(fds[1]) };
        Ok(Self {
            cancelled: AtomicBool::new(false),
            wake_reader,
            wake_writer: Mutex::new(Some(wake_writer)),
        })
    }

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        // Closing the sole writer leaves POLLHUP level-visible to every drain
        // polling the shared reader.
        drop(
            self.wake_writer
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take(),
        );
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    fn wake_fd(&self) -> RawFd {
        self.wake_reader.as_raw_fd()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BoundedStreamConfig {
    pub(crate) chunk_limit_bytes: usize,
    pub(crate) stream_limit_bytes: usize,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct BoundedDrainResult {
    pub(crate) captured: Option<Vec<u8>>,
    pub(crate) capture_truncated: bool,
    pub(crate) stream_truncated: bool,
}

/// Owns a bounded capture thread and collects its result after joining.
pub(crate) struct BoundedDrainHandle {
    handle: JoinHandle<BoundedDrainResult>,
}

impl BoundedDrainHandle {
    pub(crate) fn spawn(
        pipe: impl Into<OwnedFd> + Send + 'static,
        capture_limit_bytes: usize,
        cancel: Arc<DrainCancellation>,
        done_tx: mpsc::Sender<()>,
        thread_name: &'static str,
    ) -> io::Result<Self> {
        let handle = thread::Builder::new()
            .name(thread_name.to_string())
            .spawn(move || {
                let result = drain_bounded_cancellable(
                    pipe,
                    &cancel,
                    Some(capture_limit_bytes),
                    None,
                    |_, _| true,
                );
                let _ = done_tx.send(());
                result
            })?;
        Ok(Self { handle })
    }

    pub(crate) fn join(self) -> Result<BoundedDrainResult, ()> {
        self.handle.join().map_err(|_| ())
    }
}

/// Drain `pipe` until EOF or `cancel` is set, calling `on_chunk` for each
/// non-empty read.
///
/// Each iteration polls the output and cancellation descriptors indefinitely.
/// Cancelling closes the sole cancellation-pipe writer, so every worker sharing
/// its reader wakes through level-triggered POLLHUP even if a leaked grandchild
/// still holds the output writer open. Returning drops the owned output read
/// end, at which point any still-writing producer gets EPIPE / SIGPIPE on its
/// next write. That's the property a tempfile-based capture cannot offer: a
/// regular file is always writable, so a leaked daemon would grow tmpfs memory
/// indefinitely.
pub(crate) fn drain_until_eof_or_cancelled(
    pipe: impl Into<OwnedFd>,
    cancel: &DrainCancellation,
    mut on_chunk: impl FnMut(&[u8]),
) {
    let pipe = pipe.into();
    let raw_fd = pipe.as_raw_fd();
    // Keep the buffer off the stack so a short-lived drain does not fault in
    // every stack page before reading even a small amount of output.
    let mut chunk = Box::<[u8; DEFAULT_DRAIN_READ_BYTES]>::new_uninit();
    loop {
        if cancel.is_cancelled() {
            break;
        }

        let mut pollfds = [
            libc::pollfd {
                fd: raw_fd,
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: cancel.wake_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        // SAFETY: `pollfds` contains two initialized descriptors that remain
        // owned by `pipe` and `cancel` for the duration of this call.
        let r = unsafe { libc::poll(pollfds.as_mut_ptr(), pollfds.len() as libc::nfds_t, -1) };
        if r < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            break;
        }
        if cancel.is_cancelled() {
            break;
        }
        let cancel_revents = pollfds[1].revents;
        if cancel_revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
            break;
        }
        let pipe_revents = pollfds[0].revents;
        if pipe_revents & libc::POLLNVAL != 0 {
            break;
        }
        if pipe_revents & (libc::POLLIN | libc::POLLHUP) == 0 {
            if pipe_revents & libc::POLLERR != 0 {
                break;
            }
            continue;
        }

        // SAFETY: raw_fd belongs to the owned pipe. read initializes up to
        // DEFAULT_DRAIN_READ_BYTES bytes in this writable allocation; it never
        // reads the buffer.
        let n = unsafe { libc::read(raw_fd, chunk.as_mut_ptr().cast(), DEFAULT_DRAIN_READ_BYTES) };
        if n == 0 {
            break; // EOF
        }
        if n < 0 {
            let kind = io::Error::last_os_error().kind();
            if matches!(kind, io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock) {
                continue;
            }
            break;
        }

        // SAFETY: the successful read initialized exactly n bytes. Only that
        // prefix is exposed, so short reads cannot reveal uninitialized data.
        let initialized = unsafe { std::slice::from_raw_parts(chunk.as_ptr().cast(), n as usize) };
        on_chunk(initialized);
    }

    drop(pipe);
}

/// Buffered variant of [`drain_until_eof_or_cancelled`]: accumulates
/// everything read into a `Vec<u8>` and returns it.
pub(crate) fn drain_into_vec_cancellable(
    pipe: impl Into<OwnedFd>,
    cancel: &DrainCancellation,
) -> Vec<u8> {
    let mut buf = Vec::new();
    drain_until_eof_or_cancelled(pipe, cancel, |chunk| buf.extend_from_slice(chunk));
    buf
}

/// Bounded variant of [`drain_until_eof_or_cancelled`].
///
/// The helper keeps draining after capture/stream limits are reached so the
/// child cannot block on a full pipe. `capture_limit_bytes = None` discards the
/// final captured output. Returning `false` from `on_stream_chunk` disables
/// further stream forwarding; draining still continues unless `cancel` is set.
pub(crate) fn drain_bounded_cancellable<R>(
    pipe: R,
    cancel: &DrainCancellation,
    capture_limit_bytes: Option<usize>,
    stream: Option<BoundedStreamConfig>,
    mut on_stream_chunk: impl FnMut(&[u8], bool) -> bool,
) -> BoundedDrainResult
where
    R: Into<OwnedFd>,
{
    let mut captured = capture_limit_bytes
        .map(|limit| Vec::with_capacity(limit.min(INITIAL_CAPTURE_CAPACITY_BYTES)));
    let mut capture_truncated = false;
    let mut stream_emitted = 0usize;
    let mut stream_truncated = false;
    let mut stream_enabled = stream.is_some();

    drain_until_eof_or_cancelled(pipe, cancel, |chunk| {
        if let (Some(limit), Some(output)) = (capture_limit_bytes, captured.as_mut()) {
            if output.len() < limit {
                let remaining = limit - output.len();
                let keep = remaining.min(chunk.len());
                output.extend_from_slice(chunk.get(..keep).unwrap_or_default());
                if keep < chunk.len() {
                    capture_truncated = true;
                }
            } else if !chunk.is_empty() {
                capture_truncated = true;
            }
        }

        let Some(config) = stream else {
            return;
        };
        if !stream_enabled || stream_truncated || chunk.is_empty() {
            return;
        }

        if stream_emitted >= config.stream_limit_bytes || config.chunk_limit_bytes == 0 {
            stream_truncated = true;
            stream_enabled = on_stream_chunk(&[], true);
            return;
        }

        let remaining_stream = config.stream_limit_bytes - stream_emitted;
        let emit_total = remaining_stream.min(chunk.len());
        let emit = chunk.get(..emit_total).unwrap_or_default();
        for part in emit.chunks(config.chunk_limit_bytes) {
            if !on_stream_chunk(part, false) {
                stream_enabled = false;
                return;
            }
            stream_emitted += part.len();
        }

        if emit_total < chunk.len() {
            stream_truncated = true;
            stream_enabled = on_stream_chunk(&[], true);
        }
    });

    BoundedDrainResult {
        captured,
        capture_truncated,
        stream_truncated,
    }
}

#[cfg(test)]
mod tests;
