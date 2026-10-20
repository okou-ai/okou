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
            if let Some(at) = sample["monotonic_ns"].as_u64().filter(|at| *at > after_ns)
                && sample["processes"].as_array().is_some_and(|processes| {
                    processes.iter().any(|process| {
                        process["pid"].as_u64() == Some(u64::from(std::process::id()))
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
mod tests {
    use std::{io::Write, time::Duration};

    use super::*;

    fn line(at: u64) -> String {
        format!(
            "{{\"monotonic_ns\":{at},\"processes\":[{{\"pid\":{}}}]}}\n",
            std::process::id()
        )
    }

    #[tokio::test]
    async fn waits_for_a_complete_new_sample_without_losing_a_write() -> TestResult<()> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("samples.jsonl");
        let mut file = std::fs::File::create(&path)?;
        file.write_all(line(1).as_bytes())?;
        let wait = wait(&path, 1);
        tokio::pin!(wait);
        assert!(futures_util::poll!(&mut wait).is_pending());
        let next = line(2);
        file.write_all(next.trim_end().as_bytes())?;
        assert!(futures_util::poll!(&mut wait).is_pending());
        file.write_all(b"\n")?;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), wait).await??,
            2
        );
        Ok(())
    }

    #[tokio::test]
    async fn accepts_an_already_flushed_sample_and_rejects_symlinks() -> TestResult<()> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("samples.jsonl");
        std::fs::write(&path, line(2))?;
        assert_eq!(wait(&path, 1).await?, 2);
        let link = directory.path().join("linked.jsonl");
        std::os::unix::fs::symlink(&path, &link)?;
        assert!(wait(&link, 1).await.is_err());
        Ok(())
    }
}
