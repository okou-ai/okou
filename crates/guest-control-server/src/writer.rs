use std::cmp;
use std::io;
use std::net::Shutdown;
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use guest_contracts::file_write::GUEST_FRAME_WRITE_DEADLINE;

/// Shared guest-to-host frame writer.
///
/// The mutex is held for exactly one encoded protocol frame, so concurrent
/// producers cannot interleave bytes on the stream.
#[derive(Clone)]
pub(crate) struct GuestWriter {
    stream: Arc<Mutex<UnixStream>>,
}

impl GuestWriter {
    pub(crate) fn new(stream: UnixStream) -> Self {
        Self {
            stream: Arc::new(Mutex::new(stream)),
        }
    }

    pub(crate) fn write_frame(&self, frame: &[u8]) -> io::Result<()> {
        self.write_frame_with_deadline(frame, GUEST_FRAME_WRITE_DEADLINE)
    }

    pub(crate) fn shutdown(&self) {
        let stream = self.stream.lock().unwrap_or_else(|e| e.into_inner());
        let _ = stream.shutdown(Shutdown::Both);
    }

    pub(crate) fn shutdown_after_lock<F>(&self, after_lock: F)
    where
        F: FnOnce(),
    {
        let stream = self.stream.lock().unwrap_or_else(|e| e.into_inner());
        after_lock();
        let _ = stream.shutdown(Shutdown::Both);
    }

    fn write_frame_with_deadline(&self, frame: &[u8], deadline: Duration) -> io::Result<()> {
        self.write_frame_with_deadline_after_lock(frame, deadline, || {})
    }

    /// Run `after_lock` while holding the writer mutex, immediately before
    /// sending `frame`.
    ///
    /// Guarded operations use this to mark themselves complete at the point
    /// where no later lifecycle response can overtake their terminal frame on
    /// the shared connection.
    pub(crate) fn write_frame_after_lock<F>(&self, frame: &[u8], after_lock: F) -> io::Result<()>
    where
        F: FnOnce(),
    {
        self.write_frame_with_deadline_after_lock(frame, GUEST_FRAME_WRITE_DEADLINE, after_lock)
    }

    /// Release operation ownership at the writer boundary, then send the
    /// terminal frame only if the owning connection remains live.
    pub(crate) fn write_frame_after_lock_unless_cancelled<F>(
        &self,
        frame: &[u8],
        cancelled: &AtomicBool,
        after_lock: F,
    ) -> io::Result<bool>
    where
        F: FnOnce(),
    {
        let stream = self.stream.lock().unwrap_or_else(|e| e.into_inner());
        after_lock();
        if cancelled.load(Ordering::Acquire) {
            return Ok(false);
        }
        send_frame_or_shutdown(&stream, frame, GUEST_FRAME_WRITE_DEADLINE).map(|()| true)
    }

    /// Build and send one frame while holding the writer mutex.
    ///
    /// Control paths that derive the response from operation state use this so
    /// the state check and frame ordering are linearized with terminal frames.
    pub(crate) fn write_generated_frame_after_lock<F>(&self, build_frame: F) -> io::Result<()>
    where
        F: FnOnce() -> io::Result<Vec<u8>>,
    {
        let stream = self.stream.lock().unwrap_or_else(|e| e.into_inner());
        let frame = build_frame()?;
        send_frame_or_shutdown(&stream, &frame, GUEST_FRAME_WRITE_DEADLINE)
    }

    fn write_frame_with_deadline_after_lock<F>(
        &self,
        frame: &[u8],
        deadline: Duration,
        after_lock: F,
    ) -> io::Result<()>
    where
        F: FnOnce(),
    {
        let stream = self.stream.lock().unwrap_or_else(|e| e.into_inner());
        after_lock();
        send_frame_or_shutdown(&stream, frame, deadline)
    }
}

fn send_frame_or_shutdown(stream: &UnixStream, frame: &[u8], deadline: Duration) -> io::Result<()> {
    let result = send_frame(stream.as_raw_fd(), frame, deadline);
    if result.is_err() {
        // The protocol has no resync marker. After a timeout or partial
        // write failure, keep the stream from carrying corrupted frames.
        let _ = stream.shutdown(Shutdown::Both);
    }
    result
}

fn send_frame(fd: RawFd, frame: &[u8], deadline: Duration) -> io::Result<()> {
    if frame.is_empty() {
        return Ok(());
    }

    let Some(deadline_at) = Instant::now().checked_add(deadline) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "guest writer deadline overflowed",
        ));
    };

    let mut written = 0usize;
    while written < frame.len() {
        if Instant::now() >= deadline_at {
            return Err(write_timeout_error());
        }

        let Some(remaining) = frame.get(written..) else {
            return Err(io::Error::other(
                "guest writer offset exceeded frame length",
            ));
        };
        match send_nonblocking(fd, remaining) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "guest writer sent zero bytes",
                ));
            }
            Ok(n) => {
                written = written
                    .checked_add(n)
                    .filter(|next| *next <= frame.len())
                    .ok_or_else(|| io::Error::other("guest writer sent past frame length"))?;
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => wait_writable(fd, deadline_at)?,
            Err(e) => return Err(e),
        }
    }

    Ok(())
}

fn wait_writable(fd: RawFd, deadline_at: Instant) -> io::Result<()> {
    loop {
        let now = Instant::now();
        if now >= deadline_at {
            return Err(write_timeout_error());
        }

        let mut pollfd = libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        };
        // SAFETY: pollfd points to one initialized descriptor entry, and the
        // timeout is a bounded non-negative millisecond value.
        let ret = unsafe {
            libc::poll(
                &mut pollfd,
                1 as libc::nfds_t,
                poll_timeout_ms(deadline_at.saturating_duration_since(now)),
            )
        };

        if ret < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(err);
        }
        if ret == 0 {
            return Err(write_timeout_error());
        }

        if pollfd.revents & libc::POLLNVAL != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "guest writer socket fd is invalid",
            ));
        }
        if pollfd.revents & (libc::POLLERR | libc::POLLHUP) != 0 {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "guest writer socket is no longer writable",
            ));
        }
        if pollfd.revents & libc::POLLOUT != 0 {
            return Ok(());
        }
    }
}

fn send_nonblocking(fd: RawFd, bytes: &[u8]) -> io::Result<usize> {
    // SAFETY: bytes points to a valid buffer for the provided length. send()
    // does not retain the pointer after returning.
    let ret = unsafe {
        libc::send(
            fd,
            bytes.as_ptr().cast::<libc::c_void>(),
            bytes.len(),
            send_flags(),
        )
    };
    if ret < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(ret as usize)
}

fn poll_timeout_ms(remaining: Duration) -> libc::c_int {
    cmp::min(cmp::max(remaining.as_millis(), 1), libc::c_int::MAX as u128) as libc::c_int
}

fn write_timeout_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        "guest writer timed out waiting for peer to drain",
    )
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn send_flags() -> libc::c_int {
    libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn send_flags() -> libc::c_int {
    libc::MSG_DONTWAIT
}

#[cfg(test)]
mod tests;
