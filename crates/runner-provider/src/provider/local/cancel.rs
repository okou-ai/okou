use std::collections::{HashMap, HashSet};
use std::future::poll_fn;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use futures_util::{FutureExt, StreamExt, future::BoxFuture, stream::FuturesUnordered};
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::local_queue;
use crate::local_queue::{CancelTargetState, LocalQueue};
#[cfg(test)]
use crate::run_cancellation::RunCancellationRegistration;
use crate::run_cancellation::{RunCancellationHandle, RunCancellationRegistry};
use runner_types::ids::RunId;

use super::super::worker_join::join_retained_worker;
#[cfg(test)]
use super::ScanObserver;
use super::watch::{QueueFileKind, RECONCILE_INTERVAL, ensure_watcher, next_change_or_pending};

#[derive(Clone)]
pub(super) struct LocalCancelScanner {
    queue: LocalQueue,
    cancel_tokens: RunCancellationRegistry,
    owned_claims: Arc<tokio::sync::Mutex<HashSet<RunId>>>,
    deliveries: Arc<Mutex<PendingCancelDeliveries>>,
    delivery_queued: Arc<Notify>,
    #[cfg(test)]
    scan_observer: ScanObserver,
}

pub(super) struct LocalCancelWatcher {
    shutdown: CancellationToken,
    handle: tokio::sync::Mutex<Option<JoinHandle<()>>>,
    scanner: LocalCancelScanner,
}

type CancelDelivery = BoxFuture<'static, (RunId, RunCancellationHandle)>;

#[derive(Default)]
struct PendingCancelDeliveries {
    futures: FuturesUnordered<CancelDelivery>,
    registrations: HashMap<RunId, Vec<RunCancellationHandle>>,
    stopped: bool,
}

impl PendingCancelDeliveries {
    /// Poll once to preserve immediate claim-time cancellation, retaining the
    /// exact future (and its gate queue position) only when it has to wait.
    fn enqueue(&mut self, run_id: RunId, handle: &RunCancellationHandle) -> bool {
        if self.stopped
            || handle.is_hard_cancelled()
            || self.registrations.get(&run_id).is_some_and(|handles| {
                handles
                    .iter()
                    .any(|pending| pending.same_registration(handle))
            })
        {
            return false;
        }

        let delivery_handle = handle.clone();
        let mut delivery = async move {
            if delivery_handle.request_hard_cancellation().await {
                info!(run_id = %run_id, "local: cancel file detected, cancelling job");
            }
            (run_id, delivery_handle)
        }
        .boxed();
        if delivery.as_mut().now_or_never().is_some() {
            return false;
        }

        self.registrations
            .entry(run_id)
            .or_default()
            .push(handle.clone());
        self.futures.push(delivery);
        true
    }

    fn poll_completed(&mut self, cx: &mut Context<'_>) -> Poll<()> {
        let mut completed = false;
        while let Poll::Ready(Some((run_id, handle))) = self.futures.poll_next_unpin(cx) {
            completed = true;
            if let std::collections::hash_map::Entry::Occupied(mut entry) =
                self.registrations.entry(run_id)
            {
                entry
                    .get_mut()
                    .retain(|pending| !pending.same_registration(&handle));
                if entry.get().is_empty() {
                    entry.remove();
                }
            }
        }
        if completed {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    }

    fn stop(&mut self) {
        self.stopped = true;
        self.futures.clear();
        self.registrations.clear();
    }
}

impl LocalCancelScanner {
    pub(super) fn new(
        queue: LocalQueue,
        cancel_tokens: RunCancellationRegistry,
        owned_claims: Arc<tokio::sync::Mutex<HashSet<RunId>>>,
    ) -> Self {
        Self {
            queue,
            cancel_tokens,
            owned_claims,
            deliveries: Arc::new(Mutex::new(PendingCancelDeliveries::default())),
            delivery_queued: Arc::new(Notify::new()),
            #[cfg(test)]
            scan_observer: ScanObserver::default(),
        }
    }

    /// Scan for `.cancel` files and trigger the corresponding cancel tokens.
    ///
    /// Active markers are deleted only when this runner owns the claim. A token
    /// can exist before `claim()` succeeds, so ownership is tracked separately
    /// to avoid stealing another runner's cancel marker. Markers without a
    /// token are kept while a claim/job may still exist, and are deleted only
    /// after they no longer have a pending target. Gate-blocked deliveries stay
    /// owned by the provider and are polled by the watcher, not awaited here.
    pub(super) async fn scan_cancel_files(&self) {
        #[cfg(test)]
        let _scan_observation = self.scan_observer.observe();
        let queue = self.queue.clone();
        let cancel_markers =
            match tokio::task::spawn_blocking(move || queue.collect_cancel_markers_sync()).await {
                Ok(markers) => markers,
                Err(e) => {
                    warn!(error = %e, "local: blocking cancel marker scan failed");
                    return;
                }
            };
        if cancel_markers.is_empty() {
            return;
        }

        let cancel_ids: Vec<RunId> = cancel_markers.iter().map(|marker| marker.run_id).collect();
        if cancel_ids.is_empty() {
            return;
        }

        let tokens = self.snapshot_cancel_tokens(&cancel_ids).await;
        let owned_claims = self.snapshot_owned_claims(&cancel_ids).await;

        let mut delete_cancel_ids = Vec::new();
        for marker in cancel_markers {
            let run_id = marker.run_id;
            if let Some(handle) = tokens.get(&run_id) {
                let queued = self
                    .deliveries
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .enqueue(run_id, handle);
                if queued {
                    // Claim can scan while the watcher is asleep with no
                    // pending deliveries, so insertion needs its own wakeup.
                    self.delivery_queued.notify_one();
                }
                let should_delete = handle.is_hard_cancelled()
                    && (owned_claims.contains(&run_id)
                        || marker.target_state == CancelTargetState::NotPending);
                if should_delete {
                    delete_cancel_ids.push(run_id);
                }
            } else if marker.target_state == CancelTargetState::NotPending {
                delete_cancel_ids.push(run_id);
            }
        }

        if !delete_cancel_ids.is_empty() {
            let queue = self.queue.clone();
            if let Err(e) = tokio::task::spawn_blocking(move || {
                queue.remove_cancel_files_sync(delete_cancel_ids)
            })
            .await
            {
                warn!(error = %e, "local: blocking cancel marker cleanup failed");
            }
        }
    }

    async fn next_cancel_completion(&self) {
        // Release the shared lock after every poll, including Pending, so
        // scans and teardown never wait for a delivery's transfer gate.
        poll_fn(|cx| {
            self.deliveries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .poll_completed(cx)
        })
        .await;
    }

    fn stop_cancel_deliveries(&self) {
        self.deliveries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .stop();
    }

    async fn snapshot_cancel_tokens(
        &self,
        cancel_ids: &[RunId],
    ) -> HashMap<RunId, RunCancellationHandle> {
        self.cancel_tokens.handles_for(cancel_ids).await
    }

    async fn snapshot_owned_claims(&self, cancel_ids: &[RunId]) -> HashSet<RunId> {
        let owned = self.owned_claims.lock().await;
        cancel_ids
            .iter()
            .copied()
            .filter(|run_id| owned.contains(run_id))
            .collect()
    }

    pub(super) async fn mark_owned_claim(&self, run_id: RunId) {
        self.owned_claims.lock().await.insert(run_id);
    }

    pub(super) async fn remove_owned_claim(&self, run_id: RunId) {
        self.owned_claims.lock().await.remove(&run_id);
    }

    async fn prune_owned_claims_without_tokens(&self) {
        let owned_ids: Vec<RunId> = {
            let owned = self.owned_claims.lock().await;
            if owned.is_empty() {
                return;
            }
            owned.iter().copied().collect()
        };
        let stale_ids = self.cancel_tokens.missing_run_ids(&owned_ids).await;
        if stale_ids.is_empty() {
            return;
        }

        let mut owned = self.owned_claims.lock().await;
        for run_id in stale_ids {
            owned.remove(&run_id);
        }
    }

    #[cfg(test)]
    pub(super) async fn wait_for_scan_count(&self, expected: usize) {
        self.scan_observer.wait_for_count(expected).await;
    }

    #[cfg(test)]
    pub(super) fn scan_count(&self) -> usize {
        self.scan_observer.count()
    }
}

impl LocalCancelWatcher {
    pub(super) fn start(scanner: LocalCancelScanner) -> Self {
        let shutdown = CancellationToken::new();
        let task_shutdown = shutdown.clone();
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                let cancel_dir = match local_queue::ensure_cancels_dir(scanner.queue.group_dir()) {
                    Ok(path) => path,
                    Err(error) => {
                        warn!(error = %error, "local: cancel directory unavailable, using reconciliation");
                        local_queue::cancels_dir(scanner.queue.group_dir())
                    }
                };
                let watch_paths = vec![cancel_dir];
                let mut watcher = None;
                if let Err(error) =
                    ensure_watcher(&mut watcher, &watch_paths, QueueFileKind::Cancel)
                {
                    warn!(error = %error, "local: cancel watcher unavailable, using reconciliation");
                }
                let task_scanner = scanner.clone();
                Some(handle.spawn(async move {
                    let scanner = task_scanner;
                    loop {
                        if task_shutdown.is_cancelled() {
                            break;
                        }
                        if let Err(error) =
                            ensure_watcher(&mut watcher, &watch_paths, QueueFileKind::Cancel)
                        {
                            warn!(error = %error, "local: cancel watcher unavailable, using reconciliation");
                        }
                        scanner.prune_owned_claims_without_tokens().await;
                        scanner.scan_cancel_files().await;
                        tokio::select! {
                            biased;
                            () = task_shutdown.cancelled() => break,
                            () = scanner.next_cancel_completion() => {}
                            () = scanner.delivery_queued.notified() => {}
                            () = tokio::time::sleep(RECONCILE_INTERVAL) => {}
                            result = next_change_or_pending(&mut watcher) => {
                                if let Err(error) = result {
                                    warn!(error = %error, "local: cancel watcher failed, using reconciliation");
                                    watcher = None;
                                }
                            }
                        }
                    }
                }))
            }
            Err(e) => {
                warn!(error = %e, "local: cancel watcher not started because no tokio runtime is active");
                None
            }
        };

        Self {
            shutdown,
            handle: tokio::sync::Mutex::new(handle),
            scanner,
        }
    }

    pub(super) fn disabled(scanner: LocalCancelScanner) -> Self {
        let shutdown = CancellationToken::new();
        shutdown.cancel();
        Self {
            shutdown,
            handle: tokio::sync::Mutex::new(None),
            scanner,
        }
    }

    pub(super) async fn shutdown(&self) {
        self.scanner.stop_cancel_deliveries();
        self.shutdown.cancel();
        if let Err(e) = join_retained_worker(&self.handle).await {
            warn!(error = %e, "local: cancel watcher task failed");
        }
    }
}

impl Drop for LocalCancelWatcher {
    fn drop(&mut self) {
        self.scanner.stop_cancel_deliveries();
        self.shutdown.cancel();
        let handle = self.handle.get_mut().take();
        if let Some(handle) = handle {
            handle.abort();
        }
    }
}

#[cfg(test)]
mod tests;
