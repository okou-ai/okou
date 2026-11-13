//! Owned cancellable stdin worker for the shared exec lifecycle.
//!
//! The caller chooses cancellation and join phases relative to child and
//! containment cleanup. Completion notification never replaces physical join.

use std::io::{self, Write};
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;

use super::THREAD_EXEC_OPERATION_STDIN;
use crate::log::log;
use crate::shell_command::truncate_command_preview;
use crate::threading::ThreadSpawner;

const STDIN_WRITE_CANCELLED: &str = "stdin write cancelled";

pub(super) struct StdinWriter {
    handle: JoinHandle<io::Result<()>>,
    done_rx: mpsc::Receiver<()>,
    cancel: Arc<AtomicBool>,
    cancel_wake_writer: OwnedFd,
}

impl StdinWriter {
    pub(super) fn spawn<W, S>(mut stdin: W, stdin_bytes: Vec<u8>, spawner: S) -> io::Result<Self>
    where
        W: AsRawFd + Write + Send + 'static,
        S: ThreadSpawner,
    {
        set_nonblocking(stdin.as_raw_fd())?;
        let (cancel_wake_reader, cancel_wake_writer) = stdin_cancel_pipe()?;
        let cancel = Arc::new(AtomicBool::new(false));
        let writer_cancel = Arc::clone(&cancel);
        let (done_tx, done_rx) = mpsc::channel();
        let handle = spawner.spawn(
            THREAD_EXEC_OPERATION_STDIN,
            Box::new(move || {
                let result = write_stdin_cancellable(
                    &mut stdin,
                    &stdin_bytes,
                    &writer_cancel,
                    cancel_wake_reader.as_raw_fd(),
                );
                let _ = done_tx.send(());
                result
            }),
        )?;
        Ok(Self {
            handle,
            done_rx,
            cancel,
            cancel_wake_writer,
        })
    }

    /// Request cancellation only while the completion channel is still empty.
    /// The notification is an early observation; callers must still join.
    pub(super) fn cancel_if_running(&self) -> bool {
        if matches!(self.done_rx.try_recv(), Err(mpsc::TryRecvError::Empty)) {
            self.request_cancel();
            true
        } else {
            false
        }
    }

    pub(super) fn join_after_wait(self, seq: u32, label: &str) {
        // The direct shell is no longer running, but a descendant can still
        // keep stdin open. Stop the writer before joining it so bounded stdin
        // cannot strand this worker thread.
        self.cancel_if_running();
        self.join(seq, label);
    }

    pub(super) fn join_after_kill(self) {
        self.request_cancel();
        self.join(0, "");
    }

    fn request_cancel(&self) {
        self.cancel.store(true, Ordering::Release);
        let byte = [1u8];
        loop {
            // SAFETY: `cancel_wake_writer` is an open nonblocking pipe descriptor
            // owned by `self`; the byte buffer is valid for this call.
            let result = unsafe {
                libc::write(
                    self.cancel_wake_writer.as_raw_fd(),
                    byte.as_ptr().cast(),
                    byte.len(),
                )
            };
            if result >= 0 {
                return;
            }
            let err = io::Error::last_os_error();
            match err.kind() {
                io::ErrorKind::Interrupted => {}
                io::ErrorKind::WouldBlock | io::ErrorKind::BrokenPipe => return,
                _ => {
                    log(
                        "WARN",
                        &format!("exec operation: failed to wake stdin writer cancel: {err}"),
                    );
                    return;
                }
            }
        }
    }

    fn join(self, seq: u32, label: &str) {
        let result = match self.handle.join() {
            Ok(result) => result,
            Err(panic) => std::panic::resume_unwind(panic),
        };
        match result {
            Ok(()) => {}
            Err(e) if is_stdin_write_cancelled(&e) => {}
            Err(e) => {
                let label_preview = truncate_command_preview(label);
                log(
                    "WARN",
                    &format!(
                        "exec operation: stdin writer finished with error seq={seq} label={label_preview}: {e}"
                    ),
                );
            }
        }
    }
}

fn stdin_cancel_pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    rustix::pipe::pipe_with(rustix::pipe::PipeFlags::NONBLOCK | rustix::pipe::PipeFlags::CLOEXEC)
        .map_err(io::Error::from)
}

fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    // SAFETY: `fcntl` reads flags for an open file descriptor owned by the caller.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if flags & libc::O_NONBLOCK != 0 {
        return Ok(());
    }
    // SAFETY: `fcntl` updates flags for the same open file descriptor.
    let ret = unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
    if ret < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn write_stdin_cancellable<W>(
    stdin: &mut W,
    stdin_bytes: &[u8],
    cancel: &AtomicBool,
    cancel_fd: RawFd,
) -> io::Result<()>
where
    W: AsRawFd + Write,
{
    let mut written = 0usize;
    while written < stdin_bytes.len() {
        if cancel.load(Ordering::Acquire) {
            return Err(stdin_write_cancelled());
        }
        let remaining = stdin_bytes
            .get(written..)
            .ok_or_else(|| io::Error::other("stdin write offset out of range"))?;
        match stdin.write(remaining) {
            Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "write stdin")),
            Ok(n) => written += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                wait_stdin_writable_or_cancelled(stdin.as_raw_fd(), cancel_fd, cancel)?;
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn wait_stdin_writable_or_cancelled(
    fd: RawFd,
    cancel_fd: RawFd,
    cancel: &AtomicBool,
) -> io::Result<()> {
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(stdin_write_cancelled());
        }
        let mut pollfds = [
            libc::pollfd {
                fd,
                events: libc::POLLOUT,
                revents: 0,
            },
            libc::pollfd {
                fd: cancel_fd,
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        // Observe readiness only after the final cancellation check. Even if
        // cancellation arrives before poll starts, the wake pipe must be ready.
        #[cfg(test)]
        tests::STDIN_POLL_READY.with(|ready| {
            if let Some(ready) = ready.take() {
                let _ = ready.send(());
            }
        });
        // SAFETY: `pollfds` points to two initialized descriptor entries.
        let result = unsafe { libc::poll(pollfds.as_mut_ptr(), pollfds.len() as libc::nfds_t, -1) };
        if result > 0 {
            let stdin_revents = pollfds[0].revents;
            let cancel_revents = pollfds[1].revents;
            if cancel.load(Ordering::Acquire)
                || cancel_revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL)
                    != 0
            {
                return Err(stdin_write_cancelled());
            }
            if stdin_revents & libc::POLLNVAL != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "stdin pipe fd invalid",
                ));
            }
            if stdin_revents & (libc::POLLOUT | libc::POLLHUP | libc::POLLERR) != 0 {
                return Ok(());
            }
            continue;
        }
        if result == 0 {
            continue;
        }
        let err = io::Error::last_os_error();
        if err.kind() != io::ErrorKind::Interrupted {
            return Err(err);
        }
    }
}

fn stdin_write_cancelled() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, STDIN_WRITE_CANCELLED)
}

fn is_stdin_write_cancelled(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::Interrupted && error.to_string() == STDIN_WRITE_CANCELLED
}

#[cfg(test)]
mod tests;
