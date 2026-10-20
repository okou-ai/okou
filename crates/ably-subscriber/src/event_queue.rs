//! Lossless asynchronous event handoff, matching the official SDK's FIFO.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::sync::mpsc;

use crate::Event;

#[derive(Default)]
struct QueueStats {
    depth: AtomicUsize,
    peak: AtomicUsize,
}

pub(crate) struct EventSender {
    tx: mpsc::UnboundedSender<Event>,
    stats: Arc<QueueStats>,
}

pub(crate) struct EventReceiver {
    rx: mpsc::UnboundedReceiver<Event>,
    stats: Arc<QueueStats>,
}

pub(crate) fn event_queue() -> (EventSender, EventReceiver) {
    let (tx, rx) = mpsc::unbounded_channel();
    let stats = Arc::new(QueueStats::default());
    (
        EventSender {
            tx,
            stats: stats.clone(),
        },
        EventReceiver { rx, stats },
    )
}

impl EventSender {
    pub(crate) fn send(&self, event: Event) -> Result<(), mpsc::error::SendError<()>> {
        // Account before publishing so a concurrent receiver cannot underflow.
        let depth = self.stats.depth.fetch_add(1, Ordering::Relaxed) + 1;
        match self.tx.send(event) {
            Ok(()) => {
                self.stats.peak.fetch_max(depth, Ordering::Relaxed);
                Ok(())
            }
            Err(_) => {
                self.stats.depth.fetch_sub(1, Ordering::Relaxed);
                // Callers only observe closure; the undeliverable event is no longer needed.
                Err(mpsc::error::SendError(()))
            }
        }
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }
    pub(crate) fn depth(&self) -> usize {
        self.stats.depth.load(Ordering::Relaxed)
    }
    pub(crate) fn peak(&self) -> usize {
        self.stats.peak.load(Ordering::Relaxed)
    }
}

impl EventReceiver {
    pub(crate) async fn recv(&mut self) -> Option<Event> {
        let event = self.rx.recv().await?;
        self.stats.depth.fetch_sub(1, Ordering::Relaxed);
        Some(event)
    }

    #[cfg(test)]
    pub(crate) fn try_recv(&mut self) -> Result<Event, mpsc::error::TryRecvError> {
        let event = self.rx.try_recv()?;
        self.stats.depth.fetch_sub(1, Ordering::Relaxed);
        Ok(event)
    }
}
