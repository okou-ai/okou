//! Startup and release ownership for deliberately occupied blocking workers.

use std::sync::mpsc::{self, SendError, Sender};
use std::time::Duration;

use tokio::runtime::Runtime;
use tokio::task::JoinHandle;

/// Sends one release message when dropped, including during assertion unwinding.
///
/// Drop ignores a disconnected receiver. Setup helpers or callers retain channel
/// creation and startup/receive deadlines; this owner never joins work.
#[must_use]
pub struct BlockingWorkerRelease {
    sender: Sender<()>,
    send_attempted: bool,
}

impl BlockingWorkerRelease {
    /// Owns one release attempt over the caller's existing unit channel.
    pub fn new(sender: Sender<()>) -> Self {
        Self {
            sender,
            send_attempted: false,
        }
    }

    /// Sends the release with its original result, without sending again on Drop.
    pub fn release(mut self) -> Result<(), SendError<()>> {
        self.send_attempted = true;
        self.sender.send(())
    }
}

impl Drop for BlockingWorkerRelease {
    fn drop(&mut self) {
        if !self.send_attempted {
            let _ = self.sender.send(());
        }
    }
}

/// Occupies a caller-owned runtime slot after a zero-capacity startup handshake.
///
/// The caller retains its startup bound, runtime capacity and worker join. The
/// worker waits without a release deadline; dropping the guard releases it.
pub fn occupy_blocking_worker(
    runtime: &Runtime,
    startup_timeout: Duration,
) -> (BlockingWorkerRelease, JoinHandle<()>) {
    let (started, started_rx) = mpsc::sync_channel(0);
    let (release, release_rx) = mpsc::channel();
    let gate = BlockingWorkerRelease::new(release);
    let worker = runtime.spawn_blocking(move || {
        started.send(()).expect("report occupied blocking worker");
        release_rx.recv().expect("wait for blocking worker release");
    });
    started_rx
        .recv_timeout(startup_timeout)
        .expect("blocking worker did not start");
    (gate, worker)
}

/// Occupies a current runtime slot with the publication fixtures' bounded waits.
///
/// Retains their 2 s oneshot startup bound and 5 s blocking release bound. The
/// caller owns runtime capacity and joining; the guard releases during unwind.
pub async fn occupy_blocking_worker_async() -> (BlockingWorkerRelease, JoinHandle<()>) {
    let (entered, started) = tokio::sync::oneshot::channel();
    let (release, wait) = mpsc::channel();
    let release = BlockingWorkerRelease::new(release);
    let worker = tokio::task::spawn_blocking(move || {
        entered.send(()).expect("report occupied blocking worker");
        wait.recv_timeout(Duration::from_secs(5))
            .expect("test did not release its blocking worker");
    });
    tokio::time::timeout(Duration::from_secs(2), started)
        .await
        .expect("blocking worker did not start")
        .expect("blocking worker dropped its start signal");
    (release, worker)
}

#[cfg(test)]
mod tests;
