use std::collections::{HashMap, HashSet};
use std::future::poll_fn;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use futures_util::{FutureExt, StreamExt, future::BoxFuture, stream::FuturesUnordered};
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::ids::RunId;
use crate::local_queue;
use crate::local_queue::{CancelTargetState, LocalQueue};
#[cfg(test)]
use crate::run_cancellation::RunCancellationRegistration;
use crate::run_cancellation::{RunCancellationHandle, RunCancellationRegistry};

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
    handle: Mutex<Option<JoinHandle<()>>>,
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
            handle: Mutex::new(handle),
            scanner,
        }
    }

    pub(super) fn disabled(scanner: LocalCancelScanner) -> Self {
        let shutdown = CancellationToken::new();
        shutdown.cancel();
        Self {
            shutdown,
            handle: Mutex::new(None),
            scanner,
        }
    }

    pub(super) async fn shutdown(&self) {
        self.scanner.stop_cancel_deliveries();
        self.shutdown.cancel();
        let handle = self
            .handle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        let Some(handle) = handle else {
            return;
        };
        if let Err(e) = handle.await {
            warn!(error = %e, "local: cancel watcher task failed");
        }
    }
}

impl Drop for LocalCancelWatcher {
    fn drop(&mut self) {
        self.scanner.stop_cancel_deliveries();
        self.shutdown.cancel();
        let handle = self
            .handle
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(handle) = handle {
            handle.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn empty_cancel_tokens() -> RunCancellationRegistry {
        RunCancellationRegistry::new()
    }

    fn scanner(dir: &std::path::Path, tokens: RunCancellationRegistry) -> LocalCancelScanner {
        LocalCancelScanner::new(
            LocalQueue::new(dir.to_path_buf()),
            tokens,
            Arc::new(tokio::sync::Mutex::new(HashSet::new())),
        )
    }

    async fn insert_cancel_registration(
        tokens: &RunCancellationRegistry,
        run_id: RunId,
    ) -> RunCancellationRegistration {
        tokens.register(run_id).await.unwrap()
    }

    fn write_job(dir: &std::path::Path, run_id: RunId) {
        let job_path = local_queue::job_path(dir, crate::profile::DEFAULT_PROFILE, run_id).unwrap();
        std::fs::create_dir_all(job_path.parent().unwrap()).unwrap();
        std::fs::write(job_path, b"{}").unwrap();
    }

    fn write_cancel(dir: &std::path::Path, run_id: RunId) -> std::path::PathBuf {
        let cancel_path = local_queue::cancel_path(dir, run_id);
        std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
        std::fs::write(&cancel_path, b"").unwrap();
        cancel_path
    }

    fn write_claim(dir: &std::path::Path, run_id: RunId) -> std::path::PathBuf {
        let claim_path = local_queue::claim_path(dir, run_id);
        std::fs::create_dir_all(claim_path.parent().unwrap()).unwrap();
        std::fs::write(&claim_path, b"").unwrap();
        claim_path
    }

    fn write_result(dir: &std::path::Path, run_id: RunId, content: &[u8]) -> std::path::PathBuf {
        let result_path = local_queue::result_path(dir, run_id);
        std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
        std::fs::write(&result_path, content).unwrap();
        result_path
    }

    async fn wait_for_marker_cleanup(scanner: &LocalCancelScanner, path: &std::path::Path) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let scans = scanner.scan_count();
                if !path.exists() {
                    return;
                }
                scanner.wait_for_scan_count(scans + 1).await;
            }
        })
        .await
        .expect("completed cancellation should reconcile marker cleanup");
    }

    #[tokio::test]
    async fn blocked_delivery_does_not_delay_same_scan_or_repeat_requests() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let scanner = scanner(dir.path(), tokens.clone());
        let blocked_id = RunId::new_v4();
        let ready_id = RunId::new_v4();
        let blocked = insert_cancel_registration(&tokens, blocked_id).await;
        let ready = insert_cancel_registration(&tokens, ready_id).await;
        let guard = blocked.handle().transfer_guard().await;
        write_job(dir.path(), blocked_id);
        write_job(dir.path(), ready_id);
        let blocked_marker = write_cancel(dir.path(), blocked_id);
        let ready_marker = write_cancel(dir.path(), ready_id);
        scanner.mark_owned_claim(blocked_id).await;
        scanner.mark_owned_claim(ready_id).await;

        // Scan completion proves progress regardless of directory entry order.
        for _ in 0..3 {
            tokio::time::timeout(Duration::from_secs(2), scanner.scan_cancel_files())
                .await
                .expect("a held gate must not delay reconciliation");
        }
        assert!(ready.handle().is_hard_cancelled());
        assert!(!ready_marker.exists());
        assert!(!blocked.is_cancelled());
        assert!(blocked_marker.exists());
        assert_eq!(scanner.deliveries.lock().unwrap().futures.len(), 1);

        let watcher = LocalCancelWatcher::start(scanner.clone());
        drop(guard);
        tokio::time::timeout(Duration::from_secs(2), blocked.token().cancelled())
            .await
            .expect("pending cancellation should complete after gate release");
        wait_for_marker_cleanup(&scanner, &blocked_marker).await;
        watcher.shutdown().await;
    }

    #[tokio::test]
    async fn blocked_delivery_allows_later_markers_and_shutdown() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let scanner = scanner(dir.path(), tokens.clone());
        let blocked_id = RunId::new_v4();
        let blocked = insert_cancel_registration(&tokens, blocked_id).await;
        let guard = blocked.handle().transfer_guard().await;
        write_job(dir.path(), blocked_id);
        let blocked_marker = write_cancel(dir.path(), blocked_id);
        scanner.mark_owned_claim(blocked_id).await;
        let watcher = LocalCancelWatcher::start(scanner.clone());
        tokio::time::timeout(Duration::from_secs(2), scanner.wait_for_scan_count(1))
            .await
            .expect("watcher should finish discovering the blocked marker");

        let later_id = RunId::new_v4();
        let later = insert_cancel_registration(&tokens, later_id).await;
        write_job(dir.path(), later_id);
        write_cancel(dir.path(), later_id);
        tokio::time::timeout(Duration::from_secs(2), later.token().cancelled())
            .await
            .expect("later marker should progress while the earlier gate is held");
        assert!(!blocked.is_cancelled());
        assert!(blocked_marker.exists());

        tokio::time::timeout(Duration::from_secs(2), watcher.shutdown())
            .await
            .expect("shutdown must not wait for a transfer gate");
        // A scan racing after shutdown must not recreate pending deliveries.
        scanner.scan_cancel_files().await;
        drop(guard);
        let _guard =
            tokio::time::timeout(Duration::from_secs(2), blocked.handle().transfer_guard())
                .await
                .expect("shutdown should release the pending gate waiter");
        assert!(!blocked.is_cancelled());
        assert!(blocked_marker.exists());
    }

    #[tokio::test]
    async fn dropping_watcher_releases_pending_delivery_without_cancelling() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let scanner = scanner(dir.path(), tokens.clone());
        let run_id = RunId::new_v4();
        let registration = insert_cancel_registration(&tokens, run_id).await;
        let guard = registration.handle().transfer_guard().await;
        write_job(dir.path(), run_id);
        let marker = write_cancel(dir.path(), run_id);
        scanner.mark_owned_claim(run_id).await;
        let watcher = LocalCancelWatcher::start(scanner.clone());
        tokio::time::timeout(Duration::from_secs(2), scanner.wait_for_scan_count(1))
            .await
            .expect("watcher should discover the blocked marker");

        drop(watcher);
        drop(guard);
        let _guard = tokio::time::timeout(
            Duration::from_secs(2),
            registration.handle().transfer_guard(),
        )
        .await
        .expect("dropping the watcher should release its queued gate waiter");
        assert!(!registration.is_cancelled());
        assert!(marker.exists());
    }

    #[tokio::test]
    async fn deferred_cancellation_keeps_registration_identity_and_preclaim_marker() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let scanner = scanner(dir.path(), tokens.clone());
        let run_id = RunId::new_v4();
        let original = insert_cancel_registration(&tokens, run_id).await;
        let original_guard = original.handle().transfer_guard().await;
        write_job(dir.path(), run_id);
        let marker = write_cancel(dir.path(), run_id);
        scanner.scan_cancel_files().await;

        assert!(original.unregister().await);
        let replacement = insert_cancel_registration(&tokens, run_id).await;
        let replacement_guard = replacement.handle().transfer_guard().await;
        scanner.scan_cancel_files().await;
        assert_eq!(scanner.deliveries.lock().unwrap().futures.len(), 2);
        let watcher = LocalCancelWatcher::start(scanner.clone());

        drop(original_guard);
        tokio::time::timeout(Duration::from_secs(2), original.token().cancelled())
            .await
            .expect("the deferred request must still cancel its original registration");
        assert!(!replacement.is_cancelled());
        assert!(marker.exists());

        drop(replacement_guard);
        tokio::time::timeout(Duration::from_secs(2), replacement.token().cancelled())
            .await
            .expect("the replacement's separate delivery should also complete");
        scanner.scan_cancel_files().await;
        assert!(
            marker.exists(),
            "pre-claim cancellation must retain the marker"
        );
        scanner.mark_owned_claim(run_id).await;
        scanner.scan_cancel_files().await;
        assert!(!marker.exists());
        watcher.shutdown().await;
    }

    #[tokio::test]
    async fn cancel_file_triggers_token() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let run_id = RunId::new_v4();
        let registration = insert_cancel_registration(&tokens, run_id).await;
        let job_token = registration.token();
        let signals = registration.handle().signals();
        write_job(dir.path(), run_id);
        write_cancel(dir.path(), run_id);

        scanner(dir.path(), tokens).scan_cancel_files().await;

        assert!(job_token.is_cancelled(), "cancel token should be triggered");
        assert!(signals.hard().is_cancelled());
        assert!(!signals.cooperative_user().is_cancelled());
    }

    #[tokio::test]
    async fn cancel_file_deleted_after_owned_trigger() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let run_id = RunId::new_v4();
        let registration = insert_cancel_registration(&tokens, run_id).await;
        let job_token = registration.token();
        write_job(dir.path(), run_id);
        let cancel_path = write_cancel(dir.path(), run_id);
        let scanner = scanner(dir.path(), tokens);
        scanner.mark_owned_claim(run_id).await;

        scanner.scan_cancel_files().await;

        assert!(job_token.is_cancelled(), "cancel token should be triggered");
        assert!(
            !cancel_path.exists(),
            "cancel file should be deleted after triggering an owned token"
        );
    }

    #[tokio::test]
    async fn cancel_file_with_preclaim_token_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let run_id = RunId::new_v4();
        let registration = insert_cancel_registration(&tokens, run_id).await;
        let job_token = registration.token();
        write_job(dir.path(), run_id);
        let cancel_path = write_cancel(dir.path(), run_id);

        scanner(dir.path(), tokens).scan_cancel_files().await;

        assert!(
            job_token.is_cancelled(),
            "pre-claim token should be cancelled"
        );
        assert!(
            cancel_path.exists(),
            "cancel file should stay until this runner owns the claim"
        );
    }

    #[tokio::test]
    async fn cancel_file_with_preclaim_token_and_other_runner_claim_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let run_id = RunId::new_v4();
        let registration = insert_cancel_registration(&tokens, run_id).await;
        let job_token = registration.token();
        let cancel_path = write_cancel(dir.path(), run_id);
        write_claim(dir.path(), run_id);

        scanner(dir.path(), tokens).scan_cancel_files().await;

        assert!(
            job_token.is_cancelled(),
            "pre-claim token should still observe cancellation"
        );
        assert!(
            cancel_path.exists(),
            "cancel file should stay for the runner that owns the claim"
        );
    }

    #[tokio::test]
    async fn cancel_file_with_token_but_no_pending_target_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let run_id = RunId::new_v4();
        let registration = insert_cancel_registration(&tokens, run_id).await;
        let job_token = registration.token();
        let cancel_path = write_cancel(dir.path(), run_id);

        scanner(dir.path(), tokens).scan_cancel_files().await;

        assert!(
            job_token.is_cancelled(),
            "stale token should still be cancelled"
        );
        assert!(
            !cancel_path.exists(),
            "cancel file should be deleted when no claim or job target remains"
        );
    }

    #[tokio::test]
    async fn cancel_file_with_token_terminal_result_and_leftover_claim_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let run_id = RunId::new_v4();
        let registration = insert_cancel_registration(&tokens, run_id).await;
        let job_token = registration.token();
        let cancel_path = write_cancel(dir.path(), run_id);
        write_result(dir.path(), run_id, b"terminal");
        write_claim(dir.path(), run_id);

        scanner(dir.path(), tokens).scan_cancel_files().await;

        assert!(
            job_token.is_cancelled(),
            "stale token should still observe the cancel"
        );
        assert!(
            !cancel_path.exists(),
            "terminal result should let stale token markers be deleted"
        );
    }

    #[tokio::test]
    async fn cancel_watcher_triggers_owned_token_without_discover() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let scanner = scanner(dir.path(), tokens.clone());
        let run_id = RunId::new_v4();
        let registration = insert_cancel_registration(&tokens, run_id).await;
        let job_token = registration.token();
        write_job(dir.path(), run_id);
        write_cancel(dir.path(), run_id);
        scanner.mark_owned_claim(run_id).await;

        let watcher = LocalCancelWatcher::start(scanner);
        tokio::time::timeout(Duration::from_secs(2), job_token.cancelled())
            .await
            .expect("cancel watcher should trigger token");

        watcher.shutdown().await;
    }

    #[tokio::test]
    async fn cancel_watcher_shutdown_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let watcher = LocalCancelWatcher::start(scanner(dir.path(), empty_cancel_tokens()));

        tokio::time::timeout(Duration::from_secs(2), watcher.shutdown())
            .await
            .expect("first shutdown should complete");
        tokio::time::timeout(Duration::from_secs(2), watcher.shutdown())
            .await
            .expect("second shutdown should complete");
    }

    #[tokio::test]
    async fn owned_claim_without_cancel_token_is_pruned() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let run_id = RunId::new_v4();
        let registration = tokens.register(run_id).await.unwrap();
        let scanner = scanner(dir.path(), tokens.clone());
        scanner.mark_owned_claim(run_id).await;
        assert!(
            scanner
                .snapshot_owned_claims(&[run_id])
                .await
                .contains(&run_id),
            "claim should be tracked as locally owned"
        );

        scanner.prune_owned_claims_without_tokens().await;
        assert!(
            scanner
                .snapshot_owned_claims(&[run_id])
                .await
                .contains(&run_id),
            "owned claim should stay while its cancel token is still active"
        );

        registration.unregister().await;
        scanner.prune_owned_claims_without_tokens().await;

        assert!(
            !scanner
                .snapshot_owned_claims(&[run_id])
                .await
                .contains(&run_id),
            "owned claim should be pruned after token cleanup"
        );
    }

    #[tokio::test]
    async fn cancel_file_without_pending_target_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let unknown_id = RunId::new_v4();
        let cancel_path = write_cancel(dir.path(), unknown_id);

        scanner(dir.path(), empty_cancel_tokens())
            .scan_cancel_files()
            .await;

        assert!(
            !cancel_path.exists(),
            "cancel file should be deleted when no pending target exists"
        );
    }

    #[tokio::test]
    async fn cancel_file_is_kept_when_job_scan_fails() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = RunId::new_v4();
        let cancel_path = write_cancel(dir.path(), run_id);
        std::fs::write(local_queue::jobs_dir(dir.path()), b"not a directory").unwrap();

        scanner(dir.path(), empty_cancel_tokens())
            .scan_cancel_files()
            .await;

        assert!(
            cancel_path.exists(),
            "cancel file should stay when the pending target state is unknown"
        );
    }

    #[tokio::test]
    async fn cancel_file_with_claim_owned_by_other_runner_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = RunId::new_v4();
        let cancel_path = write_cancel(dir.path(), run_id);
        write_claim(dir.path(), run_id);

        scanner(dir.path(), empty_cancel_tokens())
            .scan_cancel_files()
            .await;

        assert!(
            cancel_path.exists(),
            "cancel file should be kept when another runner may own the claim"
        );
    }

    #[tokio::test]
    async fn cancel_file_with_terminal_result_and_leftover_job_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = RunId::new_v4();
        let cancel_path = write_cancel(dir.path(), run_id);
        write_result(dir.path(), run_id, b"terminal");
        write_job(dir.path(), run_id);

        scanner(dir.path(), empty_cancel_tokens())
            .scan_cancel_files()
            .await;

        assert!(
            !cancel_path.exists(),
            "cancel file should be deleted when the result is already terminal"
        );
    }

    #[tokio::test]
    async fn cancel_file_with_terminal_result_and_leftover_claim_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = RunId::new_v4();
        let cancel_path = write_cancel(dir.path(), run_id);
        write_result(dir.path(), run_id, b"terminal");
        write_claim(dir.path(), run_id);

        scanner(dir.path(), empty_cancel_tokens())
            .scan_cancel_files()
            .await;

        assert!(
            !cancel_path.exists(),
            "terminal result should make a leftover claim non-pending"
        );
    }

    #[tokio::test]
    async fn cancel_file_with_empty_result_and_pending_job_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = RunId::new_v4();
        let cancel_path = write_cancel(dir.path(), run_id);
        write_result(dir.path(), run_id, b"");
        write_job(dir.path(), run_id);

        scanner(dir.path(), empty_cancel_tokens())
            .scan_cancel_files()
            .await;

        assert!(
            cancel_path.exists(),
            "empty result file is not terminal, so cancel should stay pending"
        );
    }

    #[tokio::test]
    async fn cancel_file_before_token_survives_until_token_inserted() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let scanner = scanner(dir.path(), tokens.clone());
        let run_id = RunId::new_v4();
        let cancel_path = write_cancel(dir.path(), run_id);
        write_job(dir.path(), run_id);

        scanner.scan_cancel_files().await;
        assert!(
            cancel_path.exists(),
            "cancel file should survive while there is no token"
        );

        let registration = insert_cancel_registration(&tokens, run_id).await;
        let job_token = registration.token();
        scanner.mark_owned_claim(run_id).await;
        scanner.scan_cancel_files().await;

        assert!(
            job_token.is_cancelled(),
            "token should be cancelled on second scan"
        );
        assert!(
            !cancel_path.exists(),
            "cancel file should be deleted after trigger"
        );
    }
}
