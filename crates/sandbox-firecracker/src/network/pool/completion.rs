use std::future::Future;
use std::sync::Arc;

use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tracing::warn;

use super::super::error::{NetworkError, Result};
use super::host::{NetnsLifecycleOps, PoolIndexLock};
use super::types::{NamespaceDeleteOutcome, NetnsInfo};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) struct PendingId(pub(super) u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum NetnsKind {
    Plain,
    Proxy,
}

pub(super) struct CreationCompletion {
    pub(super) id: PendingId,
    pub(super) kind: NetnsKind,
    pub(super) result: Result<NetnsInfo>,
}

pub(super) struct PreparedCreationWait {
    pub(super) completions: Vec<CreationCompletion>,
    pub(super) receiver: watch::Receiver<()>,
}

/// Owns durable creation completions and the broadcast signal used by waiters.
///
/// The mpsc queue is the source of truth. The watch channel is only a progress
/// hint, so every caller that may wait must use [`Self::prepare_wait`].
pub(super) struct CreationCompletionCoordinator {
    tx: mpsc::UnboundedSender<CreationCompletion>,
    rx: mpsc::UnboundedReceiver<CreationCompletion>,
    wake_tx: watch::Sender<()>,
}

impl CreationCompletionCoordinator {
    pub(super) fn new() -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let (wake_tx, _) = watch::channel(());
        Self { tx, rx, wake_tx }
    }

    pub(super) fn notifier(&self, ops: NetnsLifecycleOps) -> CreationNotifier {
        CreationNotifier {
            tx: self.tx.clone(),
            wake_tx: self.wake_tx.clone(),
            ops,
        }
    }

    pub(super) fn try_recv(&mut self) -> Option<CreationCompletion> {
        self.rx.try_recv().ok()
    }

    fn drain(&mut self) -> Vec<CreationCompletion> {
        let mut completions = Vec::new();
        while let Some(completion) = self.try_recv() {
            completions.push(completion);
        }
        completions
    }

    /// Arms a wake receiver before draining so a caller cannot miss a completion
    /// between deciding to wait and observing the durable queue.
    pub(super) fn prepare_wait(&mut self) -> PreparedCreationWait {
        let receiver = self.wake_tx.subscribe();
        let completions = self.drain();
        PreparedCreationWait {
            completions,
            receiver,
        }
    }

    #[cfg(test)]
    pub(super) fn enqueue_for_test(&self, completion: CreationCompletion) {
        self.tx.send(completion).expect("completion receiver open");
    }
}

#[derive(Clone)]
pub(super) struct CreationNotifier {
    tx: mpsc::UnboundedSender<CreationCompletion>,
    wake_tx: watch::Sender<()>,
    ops: NetnsLifecycleOps,
}

impl CreationNotifier {
    pub(super) async fn send(self, completion: CreationCompletion) {
        match self.tx.send(completion) {
            Ok(()) => self.wake(),
            Err(err) => {
                let completion = err.0;
                if let Ok(ns) = completion.result {
                    warn!(
                        name = %ns.name,
                        host_device = %ns.host_device,
                        "namespace creation completed after pool receiver dropped; deleting"
                    );
                    let outcome = self
                        .ops
                        .delete_network_resources(vec![ns.clone()], None)
                        .await;
                    if matches!(outcome, NamespaceDeleteOutcome::Abandoned) {
                        warn!(
                            name = %ns.name,
                            host_device = %ns.host_device,
                            "failed to delete namespace after completion delivery failed; startup orphan reconciliation will retry"
                        );
                    }
                }
                self.wake();
            }
        }
    }

    fn wake(&self) {
        // Watch versions every successful send; the payload itself is unused.
        // With no receiver, the mpsc queue still retains the completion.
        let _ = self.wake_tx.send(());
    }
}

pub(super) fn spawn_creation_worker<F>(
    id: PendingId,
    kind: NetnsKind,
    index_lock: Arc<PoolIndexLock>,
    notifier: CreationNotifier,
    future: F,
) -> JoinHandle<()>
where
    F: Future<Output = Result<NetnsInfo>> + Send + 'static,
{
    // The worker can outlive both the pool and a cancelled completion reporter.
    // Keep its index reserved through creation and creation-error cleanup.
    let worker_lock = Arc::clone(&index_lock);
    let worker = tokio::spawn(async move {
        let _index_lock = worker_lock;
        future.await
    });
    tokio::spawn(async move {
        // Failed completion delivery may delete the namespace after the worker
        // has finished, so the reporter needs its own ownership through cleanup.
        let _index_lock = index_lock;
        let result = match worker.await {
            Ok(result) => result,
            Err(error) => Err(join_error_to_creation_error(error, kind)),
        };
        notifier.send(CreationCompletion { id, kind, result }).await;
    })
}

fn join_error_to_creation_error(error: tokio::task::JoinError, kind: NetnsKind) -> NetworkError {
    if error.is_panic() {
        NetworkError::Prerequisite(format!(
            "{kind:?} namespace creation task panicked: {error}"
        ))
    } else {
        NetworkError::Prerequisite(format!(
            "{kind:?} namespace creation task cancelled: {error}"
        ))
    }
}

#[cfg(test)]
mod tests;
