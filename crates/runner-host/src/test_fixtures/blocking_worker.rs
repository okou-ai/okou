//! Release ownership for tests that deliberately occupy a blocking worker.

use std::sync::mpsc::{SendError, Sender};

/// Sends one release message when dropped, including during assertion unwinding.
///
/// Drop ignores a disconnected receiver. Callers retain channel creation,
/// startup/receive deadlines and the worker handle; this owner never joins work.
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

#[cfg(test)]
mod tests;
