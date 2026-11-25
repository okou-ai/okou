//! Bounded readiness handling for long-lived inotify observers.

use std::io;
use std::os::fd::{AsFd, AsRawFd, RawFd};
use std::path::Path;

use nix::errno::Errno;
use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify, InotifyEvent, WatchDescriptor};
use tokio::io::unix::{AsyncFd, AsyncFdReadyGuard};

const MAX_READ_BATCHES: usize = 16;

/// An owned nonblocking inotify descriptor.
pub struct InotifySource(Inotify);

impl InotifySource {
    /// Opens the descriptor so callers can install initial watches before registration.
    pub fn initialize() -> Result<Self, Errno> {
        Inotify::init(InitFlags::IN_CLOEXEC | InitFlags::IN_NONBLOCK).map(Self)
    }

    /// Registers the descriptor with the current Tokio reactor.
    pub fn register(self) -> io::Result<AsyncFd<Self>> {
        // SAFETY: the owned descriptor is valid and stays fixed until deregistration.
        unsafe { AsyncFd::register(self) }.map_err(io::Error::from)
    }

    /// Installs a kernel watch on the path with the caller's event mask.
    pub fn add_watch(&self, path: &Path, flags: AddWatchFlags) -> Result<WatchDescriptor, Errno> {
        self.0.add_watch(path, flags)
    }

    /// Removes a kernel watch from this descriptor.
    pub fn remove_watch(&self, watch: WatchDescriptor) -> Result<(), Errno> {
        self.0.rm_watch(watch)
    }

    /// Delivers up to 16 batches in order, returning true once the queue is empty.
    /// At the limit, unread events may remain, so readiness stays cached.
    pub fn drain_ready(
        mut ready: AsyncFdReadyGuard<'_, Self>,
        mut consume: impl FnMut(Vec<InotifyEvent>),
    ) -> Result<bool, Errno> {
        for _ in 0..MAX_READ_BATCHES {
            match ready.get_inner().0.read_events() {
                Ok(events) => consume(events),
                Err(Errno::EAGAIN) => {
                    ready.clear_ready();
                    return Ok(true);
                }
                Err(error) => return Err(error),
            }
        }
        Ok(false)
    }
}

impl AsRawFd for InotifySource {
    fn as_raw_fd(&self) -> RawFd {
        self.0.as_fd().as_raw_fd()
    }
}
