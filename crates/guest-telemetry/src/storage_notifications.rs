//! One reusable inotify instance owned by the single-active storage connection.
//!
//! Each helper receives a close-on-exec duplicate over its anonymous stdin
//! socket. Its live watcher semantics do not change. The connection removes
//! residual watches and events only after the child and its accepted IO have
//! retired. Dropping an unfinished lease poisons reuse, retaining the instance
//! until the connection's joined teardown rather than inventing completion.

use rustix::fs::inotify;
use rustix::net::{
    RecvAncillaryBuffer, RecvAncillaryMessage, RecvFlags, ReturnFlags, SendAncillaryBuffer,
    SendAncillaryMessage, SendFlags, recvmsg, sendmsg,
};
use std::fs::File;
use std::io::{self, IoSlice, IoSliceMut, Read};
use std::mem::MaybeUninit;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, OwnedFd};
use std::sync::{Arc, Mutex, MutexGuard};

const BOOTSTRAP: u8 = 1;
const MAX_FDINFO_BYTES: u64 = 4096;
const MAX_EVENT_BYTES: usize = 1024 * 1024;

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[derive(Default)]
struct State {
    events: Option<Arc<File>>,
    leased_or_poisoned: bool,
}

/// A fixed connection resource; caller joins all storage work before dropping it.
#[derive(Default)]
pub struct NotificationOwner(Mutex<State>);

impl NotificationOwner {
    /// Borrow the instance for one confirmed single-active helper operation.
    /// An unfinished or failed previous lease permanently refuses reuse.
    pub fn lease(&self) -> io::Result<NotificationLease<'_>> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| invalid("storage notification owner panicked"))?;
        if state.leased_or_poisoned {
            return Err(invalid("storage notification owner did not settle"));
        }
        let events = match &state.events {
            Some(events) => Arc::clone(events),
            None => {
                let events = Arc::new(File::from(inotify::init(
                    inotify::CreateFlags::CLOEXEC | inotify::CreateFlags::NONBLOCK,
                )?));
                state.events = Some(Arc::clone(&events));
                events
            }
        };
        state.leased_or_poisoned = true;
        Ok(NotificationLease { state, events })
    }
}

/// Retains the connection instance until helper retirement and reset are proven.
pub struct NotificationLease<'a> {
    state: MutexGuard<'a, State>,
    events: Arc<File>,
}

impl NotificationLease<'_> {
    /// Descriptor to duplicate into exactly one fixed storage helper.
    pub fn descriptor(&self) -> BorrowedFd<'_> {
        self.events.as_ref().as_fd()
    }

    /// Reset after the helper, descendants and all accepted IO are joined.
    /// An error leaves this owner poisoned; no next operation may use its state.
    pub fn finish(mut self) -> io::Result<()> {
        reset(&self.events)?;
        self.state.leased_or_poisoned = false;
        Ok(())
    }
}

fn reset(events: &File) -> io::Result<()> {
    let mut metadata = String::new();
    File::open(format!("/proc/self/fdinfo/{}", events.as_raw_fd()))?
        .take(MAX_FDINFO_BYTES + 1)
        .read_to_string(&mut metadata)?;
    if metadata.len() as u64 > MAX_FDINFO_BYTES {
        return Err(invalid("storage notification watch metadata exceeds bound"));
    }
    let mut watch = None;
    for line in metadata.lines() {
        let Some(value) = line.strip_prefix("inotify wd:") else {
            continue;
        };
        let descriptor = value
            .split_whitespace()
            .next()
            .and_then(|value| i32::from_str_radix(value, 16).ok())
            .ok_or_else(|| invalid("invalid storage notification watch"))?;
        if watch.replace(descriptor).is_some() {
            return Err(invalid(
                "storage helper created multiple notification watches",
            ));
        }
    }
    if let Some(watch) = watch {
        inotify::remove_watch(events, watch)?;
    }
    let mut bytes = [0_u8; 4096];
    let mut events = events;
    for _ in 0..MAX_EVENT_BYTES / bytes.len() {
        match events.read(&mut bytes) {
            Ok(0) => return Err(invalid("storage notification stream closed")),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
            Err(error) => return Err(error),
        }
    }
    Err(invalid("storage notification reset exceeds event bound"))
}

/// Send the private version byte and one descriptor, leaving payload bytes separate.
pub fn send(socket: impl AsFd, events: BorrowedFd<'_>) -> io::Result<()> {
    let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
    let mut ancillary = SendAncillaryBuffer::new(&mut space);
    let descriptors = [events];
    if !ancillary.push(SendAncillaryMessage::ScmRights(&descriptors)) {
        return Err(invalid("storage descriptor bootstrap does not fit"));
    }
    let sent = sendmsg(
        socket,
        &[IoSlice::new(&[BOOTSTRAP])],
        &mut ancillary,
        SendFlags::NOSIGNAL,
    )?;
    if sent != 1 {
        return Err(io::Error::new(
            io::ErrorKind::WriteZero,
            "storage descriptor bootstrap",
        ));
    }
    Ok(())
}

/// Adopt exactly one close-on-exec inotify capability from the private stdin.
/// Invalid/truncated ancillary messages close every received right through RAII.
pub fn receive(socket: impl AsFd) -> io::Result<OwnedFd> {
    let mut version = [0_u8; 1];
    let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(2))];
    let mut ancillary = RecvAncillaryBuffer::new(&mut space);
    let result = recvmsg(
        socket,
        &mut [IoSliceMut::new(&mut version)],
        &mut ancillary,
        RecvFlags::CMSG_CLOEXEC,
    )?;
    let mut rights = Vec::new();
    let mut unexpected = false;
    for message in ancillary.drain() {
        match message {
            RecvAncillaryMessage::ScmRights(fds) => rights.extend(fds),
            _ => unexpected = true,
        }
    }
    if result.bytes != 1
        || version != [BOOTSTRAP]
        || result
            .flags
            .intersects(ReturnFlags::CTRUNC | ReturnFlags::TRUNC)
        || unexpected
    {
        return Err(invalid("invalid storage notification descriptor bootstrap"));
    }
    let [descriptor]: [OwnedFd; 1] = rights
        .try_into()
        .map_err(|_| invalid("storage notification bootstrap requires one descriptor"))?;
    if std::fs::read_link(format!("/proc/self/fd/{}", descriptor.as_raw_fd()))?
        != std::path::Path::new("anon_inode:inotify")
    {
        return Err(invalid("storage notification descriptor is not inotify"));
    }
    let flags = rustix::fs::fcntl_getfl(&descriptor)?;
    if !flags.contains(rustix::fs::OFlags::NONBLOCK) {
        return Err(invalid("storage notification descriptor is blocking"));
    }
    Ok(descriptor)
}

#[cfg(test)]
mod tests;
