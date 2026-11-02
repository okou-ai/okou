//! Wait for the owning P1 collector's actual sample, without a fixed delay.

use std::{fs::OpenOptions, io::Read, os::unix::fs::OpenOptionsExt, path::Path};

use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
use serde_json::Value;
use tokio::io::unix::AsyncFd;

use super::*;

pub async fn wait(path: &Path, after_ns: u64) -> TestResult<u64> {
    let inotify = Inotify::init(InitFlags::IN_CLOEXEC | InitFlags::IN_NONBLOCK)?;
    inotify.add_watch(
        path,
        AddWatchFlags::IN_MODIFY | AddWatchFlags::IN_DELETE_SELF | AddWatchFlags::IN_MOVE_SELF,
    )?;
    let fd: std::os::fd::OwnedFd = inotify.into();
    // SAFETY: AsyncFd owns this nonblocking descriptor until it is dropped.
    let watcher = unsafe { AsyncFd::register(fd) }?;
    loop {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)?;
        if !file.metadata()?.is_file() {
            return Err(io::Error::other("P1 samples must be a regular file").into());
        }
        let mut raw = Vec::new();
        file.take(16 * 1024 * 1024 + 1).read_to_end(&mut raw)?;
        if raw.len() > 16 * 1024 * 1024 {
            return Err(io::Error::other("P1 sample acknowledgement exceeded its bound").into());
        }
        // P1 flushes whole JSON lines. An in-progress final line cannot release
        // the producer, even when its partial bytes already contain a clock.
        for line in raw
            .split_inclusive(|byte| *byte == b'\n')
            .filter(|line| line.ends_with(b"\n"))
        {
            let sample: Value = serde_json::from_slice(line)?;
            if let Some(at) = sample
                .get("monotonic_ns")
                .and_then(Value::as_u64)
                .filter(|at| *at > after_ns)
                && sample
                    .get("processes")
                    .and_then(Value::as_array)
                    .is_some_and(|processes| {
                        processes.iter().any(|process| {
                            process.get("pid").and_then(Value::as_u64)
                                == Some(u64::from(std::process::id()))
                        })
                    })
            {
                return Ok(at);
            }
        }
        let mut ready = watcher.readable().await?;
        let mut events = [0; 4096];
        loop {
            match nix::unistd::read(watcher.get_ref(), &mut events) {
                Ok(0) => return Err(io::Error::other("P1 sample watcher closed").into()),
                Ok(_) => {}
                Err(nix::errno::Errno::EAGAIN) => {
                    ready.clear_ready();
                    break;
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
}

#[cfg(test)]
mod tests;
