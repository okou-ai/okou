use super::{Readiness, State};
use rustix::event::{EventfdFlags, eventfd};
use rustix::fs::inotify::{self, CreateFlags};
use std::ffi::CString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Instant;

pub(super) fn arm(path: &Path) -> io::Result<File> {
    let events = File::from(inotify::init(CreateFlags::CLOEXEC | CreateFlags::NONBLOCK)?);
    let path = CString::new(path.as_os_str().as_bytes()).map_err(io::Error::other)?;
    let mask = libc::IN_CREATE
        | libc::IN_ATTRIB
        | libc::IN_CLOSE_WRITE
        | libc::IN_MOVED_TO
        | libc::IN_DELETE
        | libc::IN_MOVED_FROM
        | libc::IN_DELETE_SELF
        | libc::IN_MOVE_SELF
        | libc::IN_UNMOUNT;
    // SAFETY: events is live, and path is a NUL-terminated owned-directory fd path.
    if unsafe { libc::inotify_add_watch(events.as_raw_fd(), path.as_ptr(), mask) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(events)
}

pub(crate) struct Watcher {
    stop: Arc<File>,
    state: Arc<State>,
    thread: Option<JoinHandle<io::Result<()>>>,
}

impl Readiness {
    pub(crate) fn watch(
        self,
        notify: impl Fn(io::Result<()>) + Send + 'static,
    ) -> io::Result<Watcher> {
        let stop = Arc::new(File::from(eventfd(0, EventfdFlags::CLOEXEC)?));
        let wake = stop.clone();
        let state = self.state.clone();
        let worker_state = state.clone();
        let worker = thread::Builder::new()
            .name("storage-ready".into())
            .spawn(move || {
                let result = monitor(self.events, &wake, &worker_state, self.deadline, &notify);
                match &result {
                    Ok(()) => {}
                    Err(error) => notify(Err(io::Error::new(error.kind(), error.to_string()))),
                }
                result
            })?;
        Ok(Watcher {
            stop,
            state,
            thread: Some(worker),
        })
    }
}

impl Watcher {
    pub(crate) fn finish(&mut self) -> io::Result<()> {
        let Some(worker) = self.thread.take() else {
            return Ok(());
        };
        let signalled = (&*self.stop).write_all(&1_u64.to_ne_bytes());
        let result = worker
            .join()
            .map_err(|_| io::Error::other("archive readiness worker panicked"))?;
        signalled?;
        result?;
        self.state.scan().map(|_| ())
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        // The explicit finish reports errors. Drop still retires the owner on
        // every early return or unwind, including an archive-worker failure.
        let _ = self.finish();
    }
}

fn monitor(
    mut events: File,
    stop: &File,
    state: &State,
    deadline: Instant,
    notify: &impl Fn(io::Result<()>),
) -> io::Result<()> {
    // Cleanup/target preparation can separate arming from thread startup. Drain
    // already-published state before considering a wait deadline or blocking.
    if state.scan()? {
        notify(Ok(()));
    }
    loop {
        let timeout = if state.pending() {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::TimedOut, "archive publication deadline")
                })?;
            i32::try_from(
                remaining
                    .as_millis()
                    .saturating_add(1)
                    .min(i32::MAX as u128),
            )
            .map_err(io::Error::other)?
        } else {
            -1
        };
        let mut descriptors = [
            libc::pollfd {
                fd: events.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: stop.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        // SAFETY: the fixed writable descriptor array and both owned fds live through poll.
        let count = unsafe { libc::poll(descriptors.as_mut_ptr(), 2, timeout) };
        if count < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if count == 0 {
            continue;
        } // Recompute the remaining one-shot deadline.
        let [source, stop] = descriptors;
        if (source.revents | stop.revents) & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
            return Err(io::Error::other("archive notification descriptor failed"));
        }
        if source.revents & libc::POLLIN != 0 {
            let mut buffer = [0_u8; 4096];
            match events.read(&mut buffer) {
                Ok(0) => return Err(io::Error::other("archive notification stream closed")),
                Ok(count) => validate_events(
                    buffer
                        .get(..count)
                        .ok_or_else(|| io::Error::other("invalid event length"))?,
                )?,
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) =>
                {
                    continue;
                }
                Err(error) => return Err(error),
            }
            // Monotonic source gates emit at most one wake per declared source;
            // repeated close/create notifications cannot grow the event queue.
            if state.scan()? {
                notify(Ok(()));
            }
        }
        if stop.revents & libc::POLLIN != 0 {
            return Ok(());
        }
    }
}

fn validate_events(mut bytes: &[u8]) -> io::Result<()> {
    let header = std::mem::size_of::<libc::inotify_event>();
    while !bytes.is_empty() {
        let data = bytes
            .get(..header)
            .ok_or_else(|| io::Error::other("short archive notification"))?;
        // SAFETY: data has a complete header; read_unaligned does not require alignment.
        let event =
            unsafe { std::ptr::read_unaligned(data.as_ptr().cast::<libc::inotify_event>()) };
        if event.mask
            & (libc::IN_DELETE_SELF | libc::IN_MOVE_SELF | libc::IN_UNMOUNT | libc::IN_IGNORED)
            != 0
        {
            return Err(io::Error::other("archive notification directory changed"));
        }
        let length = header
            .checked_add(event.len as usize)
            .ok_or_else(|| io::Error::other("archive notification overflow"))?;
        bytes = bytes
            .get(length..)
            .ok_or_else(|| io::Error::other("short archive notification name"))?;
        // Queue overflow is safe: immutable publication flags are all rescanned.
    }
    Ok(())
}
