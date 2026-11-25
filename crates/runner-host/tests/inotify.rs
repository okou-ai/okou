//! Kernel-backed coverage of the bounded inotify read and readiness lifecycle.
#![cfg(any(target_os = "linux", target_os = "android"))]

use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::time::Duration;

use nix::sys::inotify::{AddWatchFlags, WatchDescriptor};
use runner_host::inotify::InotifySource;
use tokio::io::unix::AsyncFd;

async fn read_changes(
    source: &AsyncFd<InotifySource>,
    watch: WatchDescriptor,
) -> io::Result<(bool, usize, Vec<OsString>)> {
    let ready = tokio::time::timeout(Duration::from_secs(2), source.readable())
        .await
        .map_err(|_| io::Error::other("queued filesystem events did not wake the descriptor"))??;
    let mut batches = 0;
    let mut names = Vec::new();
    let drained = InotifySource::drain_ready(ready, |events| {
        batches += 1;
        for event in events {
            assert_eq!(event.wd, watch);
            assert_eq!(event.mask, AddWatchFlags::IN_CREATE);
            assert!(event.name.is_some(), "create event must include the name");
            names.extend(event.name);
        }
    })?;
    Ok((drained, batches, names))
}

#[tokio::test]
async fn bounded_drain_retains_readiness_until_the_kernel_queue_is_empty() -> io::Result<()> {
    let dir = tempfile::tempdir()?;
    let source = InotifySource::initialize()?;
    let watch = source.add_watch(dir.path(), AddWatchFlags::IN_CREATE)?;
    let source = source.register()?;

    // With long names, this burst fills more than sixteen Nix read buffers.
    // Queue all events before waiting so later readiness needs no new write.
    let suffix = "x".repeat(235);
    let expected: Vec<_> = (0..300)
        .map(|index| OsString::from(format!("{index:03}-{suffix}")))
        .collect();
    for name in &expected {
        File::create(dir.path().join(name))?;
    }

    let (drained, batches, mut observed) = read_changes(&source, watch).await?;
    assert!(!drained);
    assert_eq!(batches, 16);
    assert!(!observed.is_empty() && observed.len() < expected.len());

    let (drained, _, remaining) = read_changes(&source, watch).await?;
    assert!(drained);
    observed.extend(remaining);
    assert_eq!(observed, expected);
    assert!(futures_util::poll!(std::pin::pin!(source.readable())).is_pending());

    File::create(dir.path().join("fresh"))?;
    let (drained, _, names) = read_changes(&source, watch).await?;
    assert!(drained);
    assert_eq!(names, [OsString::from("fresh")]);
    Ok(())
}
