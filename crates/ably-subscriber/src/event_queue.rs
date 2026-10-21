//! Lossless asynchronous event handoff, matching the official SDK's FIFO.

use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::Event;

const BACKLOG_WARNING_THRESHOLD: usize = 64;

#[derive(Default)]
struct QueueStats {
    state: Mutex<QueueSnapshot>,
}

#[derive(Clone, Copy, Default)]
pub(crate) struct QueueSnapshot {
    pub depth: usize,
    pub peak: usize,
    pub backlog_since: Option<Instant>,
}

impl QueueStats {
    fn lock(&self) -> MutexGuard<'_, QueueSnapshot> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn remove_pending(&self) {
        let mut stats = self.lock();
        stats.depth -= 1;
        if stats.depth < BACKLOG_WARNING_THRESHOLD {
            stats.backlog_since = None;
        }
    }
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
        let depth = {
            let mut stats = self.stats.lock();
            stats.depth += 1;
            if stats.depth == BACKLOG_WARNING_THRESHOLD {
                stats.backlog_since = Some(Instant::now());
            }
            stats.depth
        };
        // Publishing can wake the receiver; keep it outside the accounting lock.
        match self.tx.send(event) {
            Ok(()) => {
                let mut stats = self.stats.lock();
                stats.peak = stats.peak.max(depth);
                Ok(())
            }
            Err(_) => {
                self.stats.remove_pending();
                // Callers only observe closure; the undeliverable event is no longer needed.
                Err(mpsc::error::SendError(()))
            }
        }
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }
    pub(crate) fn depth(&self) -> usize {
        self.snapshot().depth
    }
    pub(crate) fn peak(&self) -> usize {
        self.snapshot().peak
    }
    pub(crate) fn snapshot(&self) -> QueueSnapshot {
        *self.stats.lock()
    }
}

impl EventReceiver {
    pub(crate) async fn recv(&mut self) -> Option<Event> {
        let event = self.rx.recv().await?;
        self.stats.remove_pending();
        Some(event)
    }

    #[cfg(test)]
    pub(crate) fn try_recv(&mut self) -> Result<Event, mpsc::error::TryRecvError> {
        let event = self.rx.try_recv()?;
        self.stats.remove_pending();
        Ok(event)
    }
}
