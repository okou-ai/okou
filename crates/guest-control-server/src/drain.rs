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

/// Pairs a bounded capture thread with its result and joins before collection.
pub(crate) struct BoundedDrainHandle {
    handle: JoinHandle<()>,
    result_rx: mpsc::Receiver<BoundedDrainResult>,
}

impl BoundedDrainHandle {
    pub(crate) fn spawn(
        pipe: impl Into<OwnedFd> + Send + 'static,
        capture_limit_bytes: usize,
        cancel: Arc<DrainCancellation>,
        done_tx: mpsc::Sender<()>,
        thread_name: &'static str,
    ) -> io::Result<Self> {
        let (result_tx, result_rx) = mpsc::channel();
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
                let _ = result_tx.send(result);
                let _ = done_tx.send(());
            })?;
        Ok(Self { handle, result_rx })
    }

    pub(crate) fn join(self) -> Result<BoundedDrainResult, ()> {
        if self.handle.join().is_err() {
            return Err(());
        }
        self.result_rx.recv().map_err(|_| ())
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
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::{Seek, SeekFrom, Write};
    use std::os::unix::io::FromRawFd;
    use std::path::Path;
    use std::sync::{Arc, mpsc};
    use std::thread;
    use std::time::Duration;

    const EXPECTED_DEFAULT_DRAIN_READ_BYTES: usize = 64 * 1024;

    fn pipe_pair() -> (File, File) {
        let mut fds = [0; 2];
        // SAFETY: fds points to two valid c_int slots for pipe2() to fill.
        let ret = unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) };
        assert_eq!(ret, 0, "pipe failed: {}", io::Error::last_os_error());

        // SAFETY: pipe2() initialized both fds and ownership is transferred to File.
        unsafe { (File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])) }
    }

    fn file_with_contents(contents: &[u8]) -> File {
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(contents).unwrap();
        file.seek(SeekFrom::Start(0)).unwrap();
        file
    }

    fn fd_target(fd: i32) -> std::path::PathBuf {
        std::fs::read_link(format!("/proc/self/fd/{fd}"))
            .unwrap_or_else(|e| panic!("read fd target for {fd}: {e}"))
    }

    fn assert_fd_open(fd: i32, message: &str) {
        // SAFETY: fcntl(F_GETFD) does not mutate memory and accepts any fd value.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        assert!(flags >= 0, "{message}: {}", io::Error::last_os_error());
    }

    fn assert_no_current_process_read_end(pipe_target: &Path, writer_fd: i32) {
        let entries = std::fs::read_dir("/proc/self/fd").expect("read /proc/self/fd");
        for entry in entries {
            let entry = entry.expect("read fd entry");
            let fd_path = entry.path();
            let Ok(target) = std::fs::read_link(&fd_path) else {
                continue;
            };
            if target != pipe_target {
                continue;
            }

            let Some(name) = fd_path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Ok(fd) = name.parse::<i32>() else {
                continue;
            };
            if fd == writer_fd {
                continue;
            }

            // SAFETY: fcntl(F_GETFL) does not mutate memory and accepts any fd value.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0 {
                continue;
            }
            let access_mode = flags & libc::O_ACCMODE;
            assert_eq!(
                access_mode,
                libc::O_WRONLY,
                "owned reader should close when drain returns; fd {fd} still points to {target:?}"
            );
        }
    }

    #[test]
    fn drain_cancel_wakes_all_idle_workers_and_closes_owned_readers() {
        let (first_reader, first_writer) = pipe_pair();
        let (second_reader, second_writer) = pipe_pair();
        let pipe_targets = [
            fd_target(first_reader.as_raw_fd()),
            fd_target(second_reader.as_raw_fd()),
        ];
        let writer_fds = [first_writer.as_raw_fd(), second_writer.as_raw_fd()];
        let cancel = Arc::new(DrainCancellation::new().unwrap());
        let (ready_tx, ready_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let handles = [first_reader, second_reader]
            .into_iter()
            .map(|reader| {
                let drain_cancel = Arc::clone(&cancel);
                let ready_tx = ready_tx.clone();
                let done_tx = done_tx.clone();
                thread::spawn(move || {
                    let _ = ready_tx.send(());
                    drain_until_eof_or_cancelled(reader, &drain_cancel, |_| {});
                    let _ = done_tx.send(());
                })
            })
            .collect::<Vec<_>>();
        drop(ready_tx);
        drop(done_tx);

        for _ in 0..2 {
            ready_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        }
        assert!(
            matches!(
                done_rx.recv_timeout(Duration::from_millis(250)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ),
            "idle drains must remain blocked beyond the removed poll timeout"
        );

        cancel.cancel();
        cancel.cancel();
        for _ in 0..2 {
            done_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        }

        for (index, writer_fd) in writer_fds.into_iter().enumerate() {
            assert_fd_open(
                writer_fd,
                "writer fd should remain open after drain cancellation",
            );
            assert_no_current_process_read_end(&pipe_targets[index], writer_fd);
        }
        drop(first_writer);
        drop(second_writer);
        for handle in handles {
            handle.join().unwrap();
        }
    }

    #[test]
    fn drain_cancelled_before_entry_closes_owned_reader() {
        let (reader, writer) = pipe_pair();
        let pipe_target = fd_target(reader.as_raw_fd());
        let writer_fd = writer.as_raw_fd();
        let cancel = DrainCancellation::new().unwrap();
        cancel.cancel();

        drain_until_eof_or_cancelled(reader, &cancel, |_| {
            panic!("pre-cancelled drain must not read output");
        });

        assert_fd_open(
            writer_fd,
            "writer fd should remain open after pre-cancelled drain",
        );
        assert_no_current_process_read_end(&pipe_target, writer_fd);
    }

    #[test]
    fn drain_exits_on_eof_without_chunks() {
        let (reader, writer) = pipe_pair();
        drop(writer);

        let cancel = DrainCancellation::new().unwrap();
        let mut output = Vec::new();
        drain_until_eof_or_cancelled(reader, &cancel, |chunk| {
            output.extend_from_slice(chunk);
        });

        assert!(output.is_empty());
    }

    #[test]
    fn bounded_drain_retains_limit_and_reports_truncation() {
        let (reader, mut writer) = pipe_pair();
        writer.write_all(b"abcdef").unwrap();
        drop(writer);

        let cancel = DrainCancellation::new().unwrap();
        let result = drain_bounded_cancellable(reader, &cancel, Some(3), None, |_, _| true);

        assert_eq!(result.captured, Some(b"abc".to_vec()));
        assert!(result.capture_truncated);
    }

    #[test]
    fn bounded_drain_exact_capture_limit_is_not_truncated() {
        let (reader, mut writer) = pipe_pair();
        writer.write_all(b"abc").unwrap();
        drop(writer);

        let cancel = DrainCancellation::new().unwrap();
        let result = drain_bounded_cancellable(reader, &cancel, Some(3), None, |_, _| true);

        assert_eq!(result.captured, Some(b"abc".to_vec()));
        assert!(!result.capture_truncated);
    }

    #[test]
    fn bounded_drain_zero_capture_limit_stores_empty_and_truncates_on_data() {
        let (reader, mut writer) = pipe_pair();
        writer.write_all(b"abc").unwrap();
        drop(writer);

        let cancel = DrainCancellation::new().unwrap();
        let result = drain_bounded_cancellable(reader, &cancel, Some(0), None, |_, _| true);

        assert_eq!(result.captured, Some(Vec::new()));
        assert!(result.capture_truncated);
    }

    #[test]
    fn bounded_drain_discard_capture_stores_no_output() {
        let (reader, mut writer) = pipe_pair();
        writer.write_all(b"abc").unwrap();
        drop(writer);

        let cancel = DrainCancellation::new().unwrap();
        let result = drain_bounded_cancellable(reader, &cancel, None, None, |_, _| true);

        assert_eq!(result.captured, None);
        assert!(!result.capture_truncated);
        assert!(!result.stream_truncated);
    }

    #[test]
    fn bounded_drain_streams_sustained_input_in_64_kib_chunks() {
        assert_eq!(DEFAULT_DRAIN_READ_BYTES, EXPECTED_DEFAULT_DRAIN_READ_BYTES);
        let input = vec![b'x'; EXPECTED_DEFAULT_DRAIN_READ_BYTES * 3 + 123];
        let reader = file_with_contents(&input);
        let cancel = DrainCancellation::new().unwrap();
        let mut streamed = Vec::new();
        let mut chunk_lengths = Vec::new();

        let result = drain_bounded_cancellable(
            reader,
            &cancel,
            None,
            Some(BoundedStreamConfig {
                chunk_limit_bytes: EXPECTED_DEFAULT_DRAIN_READ_BYTES,
                stream_limit_bytes: input.len(),
            }),
            |chunk, truncated| {
                assert!(!truncated);
                streamed.extend_from_slice(chunk);
                chunk_lengths.push(chunk.len());
                true
            },
        );

        assert_eq!(result.captured, None);
        assert!(!result.capture_truncated);
        assert_eq!(streamed, input);
        assert_eq!(
            chunk_lengths,
            vec![
                EXPECTED_DEFAULT_DRAIN_READ_BYTES,
                EXPECTED_DEFAULT_DRAIN_READ_BYTES,
                EXPECTED_DEFAULT_DRAIN_READ_BYTES,
                123,
            ]
        );
    }

    #[test]
    fn bounded_drain_large_read_preserves_stream_truncation() {
        let input = vec![b'y'; EXPECTED_DEFAULT_DRAIN_READ_BYTES + 123];
        let stream_limit = EXPECTED_DEFAULT_DRAIN_READ_BYTES / 2;
        let reader = file_with_contents(&input);
        let cancel = DrainCancellation::new().unwrap();
        let mut chunks = Vec::new();

        let result = drain_bounded_cancellable(
            reader,
            &cancel,
            Some(input.len()),
            Some(BoundedStreamConfig {
                chunk_limit_bytes: EXPECTED_DEFAULT_DRAIN_READ_BYTES,
                stream_limit_bytes: stream_limit,
            }),
            |chunk, truncated| {
                chunks.push((chunk.len(), truncated));
                true
            },
        );

        assert_eq!(result.captured, Some(input));
        assert!(!result.capture_truncated);
        assert!(result.stream_truncated);
        assert_eq!(chunks, vec![(stream_limit, false), (0, true)]);
    }

    #[test]
    fn bounded_drain_splits_stream_chunks_and_marks_stream_truncation() {
        let (reader, mut writer) = pipe_pair();
        writer.write_all(b"abcdef").unwrap();
        drop(writer);

        let cancel = DrainCancellation::new().unwrap();
        let mut chunks = Vec::new();
        let result = drain_bounded_cancellable(
            reader,
            &cancel,
            Some(10),
            Some(BoundedStreamConfig {
                chunk_limit_bytes: 2,
                stream_limit_bytes: 5,
            }),
            |chunk, truncated| {
                chunks.push((chunk.to_vec(), truncated));
                true
            },
        );

        assert_eq!(result.captured, Some(b"abcdef".to_vec()));
        assert!(!result.capture_truncated);
        assert!(result.stream_truncated);
        assert_eq!(
            chunks,
            vec![
                (b"ab".to_vec(), false),
                (b"cd".to_vec(), false),
                (b"e".to_vec(), false),
                (Vec::new(), true),
            ]
        );
    }

    #[test]
    fn bounded_drain_exact_stream_limit_has_no_truncation_marker() {
        let (reader, mut writer) = pipe_pair();
        writer.write_all(b"abcd").unwrap();
        drop(writer);

        let cancel = DrainCancellation::new().unwrap();
        let mut chunks = Vec::new();
        let result = drain_bounded_cancellable(
            reader,
            &cancel,
            None,
            Some(BoundedStreamConfig {
                chunk_limit_bytes: 2,
                stream_limit_bytes: 4,
            }),
            |chunk, truncated| {
                chunks.push((chunk.to_vec(), truncated));
                true
            },
        );

        assert_eq!(result.captured, None);
        assert!(!result.stream_truncated);
        assert_eq!(
            chunks,
            vec![(b"ab".to_vec(), false), (b"cd".to_vec(), false)]
        );
    }

    #[test]
    fn bounded_drain_zero_stream_limit_emits_truncation_marker_on_data() {
        let (reader, mut writer) = pipe_pair();
        writer.write_all(b"abc").unwrap();
        drop(writer);

        let cancel = DrainCancellation::new().unwrap();
        let mut chunks = Vec::new();
        let result = drain_bounded_cancellable(
            reader,
            &cancel,
            None,
            Some(BoundedStreamConfig {
                chunk_limit_bytes: 2,
                stream_limit_bytes: 0,
            }),
            |chunk, truncated| {
                chunks.push((chunk.to_vec(), truncated));
                true
            },
        );

        assert_eq!(result.captured, None);
        assert!(result.stream_truncated);
        assert_eq!(chunks, vec![(Vec::new(), true)]);
    }

    #[test]
    fn bounded_drain_zero_chunk_limit_emits_truncation_marker_on_data() {
        let (reader, mut writer) = pipe_pair();
        writer.write_all(b"abc").unwrap();
        drop(writer);

        let cancel = DrainCancellation::new().unwrap();
        let mut chunks = Vec::new();
        let result = drain_bounded_cancellable(
            reader,
            &cancel,
            None,
            Some(BoundedStreamConfig {
                chunk_limit_bytes: 0,
                stream_limit_bytes: 3,
            }),
            |chunk, truncated| {
                chunks.push((chunk.to_vec(), truncated));
                true
            },
        );

        assert_eq!(result.captured, None);
        assert!(result.stream_truncated);
        assert_eq!(chunks, vec![(Vec::new(), true)]);
    }

    #[test]
    fn bounded_drain_stream_callback_failure_stops_stream_but_keeps_draining() {
        let (reader, mut writer) = pipe_pair();
        writer.write_all(b"abcdef").unwrap();
        drop(writer);

        let cancel = DrainCancellation::new().unwrap();
        let mut chunks = Vec::new();
        let result = drain_bounded_cancellable(
            reader,
            &cancel,
            Some(10),
            Some(BoundedStreamConfig {
                chunk_limit_bytes: 2,
                stream_limit_bytes: 10,
            }),
            |chunk, truncated| {
                chunks.push((chunk.to_vec(), truncated));
                false
            },
        );

        assert_eq!(chunks, vec![(b"ab".to_vec(), false)]);
        assert_eq!(result.captured, Some(b"abcdef".to_vec()));
        assert!(!result.capture_truncated);
        assert!(!result.stream_truncated);
    }
}
