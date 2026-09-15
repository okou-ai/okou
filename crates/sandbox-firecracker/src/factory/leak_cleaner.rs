use futures_util::stream::{FuturesUnordered, StreamExt};
use tracing::{info, warn};

use crate::cow_cleanup::{CowCleanupOutcome, destroy_cow_device_with_retries};
use crate::leaked_resources::LeakedResources;
use crate::network::NetnsPoolHandle;

/// Maximum number of leaked sandbox reports cleaned up concurrently.
const LEAK_CLEANUP_CONCURRENCY: usize = 4;

/// Maximum time to wait without a completed leaked-resource cleanup during shutdown.
///
/// Shutdown is the graceful path, so already-queued leak reports should drain
/// before the pool Arcs are unwrapped. If cleanup gets stuck, fall back to
/// aborting and let the next `runner gc` clean leftovers. This inactivity
/// window must exceed the COW destroy retry budget because leaked sandbox
/// cleanup owns the pooled COW device and may need a full finalizer pass before
/// releasing netns/dirs.
const LEAK_CLEANUP_INACTIVITY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

pub(super) struct LeakCleaner {
    tx: Option<tokio::sync::mpsc::UnboundedSender<LeakedResources>>,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    completed_cleanup_count_rx: tokio::sync::watch::Receiver<u64>,
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl LeakCleaner {
    pub(super) fn spawn(netns_pool: NetnsPoolHandle) -> Self {
        // Drop cannot await, and losing a leak report can strand host resources.
        // Keep this unbounded: reports only come from exceptional cleanup paths,
        // with runner GC as the final backstop if the cleaner stalls.
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let (completed_cleanup_count_tx, completed_cleanup_count_rx) =
            tokio::sync::watch::channel(0);
        let handle = tokio::spawn(drain_leaked_resources(
            rx,
            shutdown_rx,
            completed_cleanup_count_tx,
            netns_pool,
        ));
        Self {
            tx: Some(tx),
            shutdown_tx: Some(shutdown_tx),
            completed_cleanup_count_rx,
            handle: Some(handle),
        }
    }

    pub(super) fn sender(&self) -> Option<tokio::sync::mpsc::UnboundedSender<LeakedResources>> {
        self.tx.clone()
    }

    #[cfg(test)]
    pub(super) fn from_parts_for_test(
        tx: tokio::sync::mpsc::UnboundedSender<LeakedResources>,
        shutdown_tx: tokio::sync::oneshot::Sender<()>,
        completed_cleanup_count_rx: tokio::sync::watch::Receiver<u64>,
        handle: tokio::task::JoinHandle<()>,
    ) -> Self {
        Self {
            tx: Some(tx),
            shutdown_tx: Some(shutdown_tx),
            completed_cleanup_count_rx,
            handle: Some(handle),
        }
    }

    pub(super) async fn shutdown(mut self) {
        self.tx.take();
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }
        let Some(mut handle) = self.handle.take() else {
            return;
        };

        drop(self.completed_cleanup_count_rx.borrow_and_update());
        let inactivity_timeout = tokio::time::sleep(LEAK_CLEANUP_INACTIVITY_TIMEOUT);
        tokio::pin!(inactivity_timeout);
        let mut progress_channel_open = true;

        loop {
            tokio::select! {
                biased;
                result = &mut handle => {
                    if let Err(e) = result {
                        warn!(error = %e, "leak cleanup task exited unexpectedly");
                    }
                    return;
                }
                progress = self.completed_cleanup_count_rx.changed(), if progress_channel_open => {
                    if progress.is_ok() {
                        inactivity_timeout.as_mut().reset(
                            tokio::time::Instant::now() + LEAK_CLEANUP_INACTIVITY_TIMEOUT,
                        );
                    } else {
                        progress_channel_open = false;
                    }
                }
                () = &mut inactivity_timeout => {
                    warn!(
                        timeout_ms = LEAK_CLEANUP_INACTIVITY_TIMEOUT.as_millis() as u64,
                        completed_cleanups = *self.completed_cleanup_count_rx.borrow(),
                        "no leaked-resource cleanup completed before timeout; aborting task"
                    );
                    handle.abort();
                    if let Err(e) = handle.await
                        && !e.is_cancelled()
                    {
                        warn!(error = %e, "leak cleanup task failed after abort");
                    }
                    return;
                }
            }
        }
    }

    #[cfg(test)]
    fn abort(&mut self) {
        // Drop handles first, then abort immediately as a synchronous Drop backstop.
        self.tx.take();
        self.shutdown_tx.take();
        if let Some(handle) = self.handle.take() {
            handle.abort();
        }
    }

    fn detach_for_drop(&mut self) {
        self.tx.take();
        self.shutdown_tx.take();
        // Dropping JoinHandle detaches the task. If the runtime is still alive,
        // the drain loop can finish queued cleanup and accept leak reports from
        // live sandbox sender clones without blocking this synchronous Drop path.
        self.handle.take();
    }
}

impl Drop for LeakCleaner {
    fn drop(&mut self) {
        self.detach_for_drop();
    }
}

async fn drain_leaked_resources(
    rx: tokio::sync::mpsc::UnboundedReceiver<LeakedResources>,
    shutdown_rx: tokio::sync::oneshot::Receiver<()>,
    completed_cleanup_count_tx: tokio::sync::watch::Sender<u64>,
    netns_pool: NetnsPoolHandle,
) {
    drain_leaked_resources_with_cleanup(
        rx,
        shutdown_rx,
        completed_cleanup_count_tx,
        move |leaked| {
            let netns_pool = netns_pool.clone();
            async move {
                cleanup_leaked_resource(leaked, &netns_pool).await;
            }
        },
    )
    .await;
}

async fn drain_leaked_resources_with_cleanup<C, Fut>(
    mut rx: tokio::sync::mpsc::UnboundedReceiver<LeakedResources>,
    shutdown_rx: tokio::sync::oneshot::Receiver<()>,
    completed_cleanup_count_tx: tokio::sync::watch::Sender<u64>,
    mut cleanup: C,
) where
    C: FnMut(LeakedResources) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let mut shutdown_rx = Some(shutdown_rx);
    let mut cleanups = FuturesUnordered::new();
    let mut receiver_closed = false;

    loop {
        if receiver_closed && cleanups.is_empty() {
            break;
        }

        tokio::select! {
            biased;
            shutdown = wait_for_leak_cleaner_shutdown(&mut shutdown_rx) => {
                if shutdown {
                    rx.close();
                }
            }
            Some(()) = cleanups.next(), if !cleanups.is_empty() => {
                completed_cleanup_count_tx.send_modify(|count| *count += 1);
            }
            maybe_leaked = rx.recv(),
                if !receiver_closed && cleanups.len() < LEAK_CLEANUP_CONCURRENCY =>
            {
                match maybe_leaked {
                    Some(leaked) => {
                        warn!(
                            id = %leaked.sandbox_id,
                            has_cow_device = leaked.cow_device.is_some(),
                            has_network = leaked.network.is_some(),
                            queued_reports = rx.len(),
                            active_cleanups = cleanups.len() + 1,
                            concurrency_limit = LEAK_CLEANUP_CONCURRENCY,
                            "cleaning up leaked sandbox resources"
                        );
                        cleanups.push(cleanup(leaked));
                    }
                    None => receiver_closed = true,
                }
            }
        }
    }
}

async fn wait_for_leak_cleaner_shutdown(
    shutdown_rx: &mut Option<tokio::sync::oneshot::Receiver<()>>,
) -> bool {
    let Some(rx) = shutdown_rx.as_mut() else {
        return std::future::pending::<bool>().await;
    };

    let shutdown = rx.await.is_ok();
    *shutdown_rx = None;
    shutdown
}

async fn cleanup_leaked_resource(mut leaked: LeakedResources, netns_pool: &NetnsPoolHandle) {
    if let Some(exit) = &leaked.process_exit
        && !exit.confirmed().await
    {
        warn!(
            id = %leaked.sandbox_id,
            "process exit unconfirmed; retaining leaked netns and directories for runner gc"
        );
        return;
    }
    let cow_cleanup_outcome = match leaked.cow_device.take() {
        Some(cow_device) => destroy_cow_device_with_retries(&leaked.sandbox_id, cow_device).await,
        None => CowCleanupOutcome::BackingFilesSafeToDelete,
    };

    cleanup_leaked_resource_after_cow_cleanup(leaked, netns_pool, cow_cleanup_outcome).await;
}

async fn cleanup_leaked_resource_after_cow_cleanup(
    leaked: LeakedResources,
    netns_pool: &NetnsPoolHandle,
    cow_cleanup_outcome: CowCleanupOutcome,
) {
    if let Some(network) = leaked.network {
        let mut network = Some(network);
        let outcome = netns_pool.release(&mut network).await;
        if let Some(message) = outcome.invalid_message() {
            warn!(id = %leaked.sandbox_id, error = %message, "failed to release leaked netns");
        }
    }
    if let Err(e) = tokio::fs::remove_dir_all(&leaked.sock_dir).await {
        warn!(id = %leaked.sandbox_id, error = %e, "failed to delete leaked sock dir");
    }
    if cow_cleanup_outcome.backing_files_safe_to_delete()
        && leaked.delete_workspace
        && let Err(e) = tokio::fs::remove_dir_all(&leaked.workspace).await
    {
        warn!(id = %leaked.sandbox_id, error = %e, "failed to delete leaked workspace");
    }
    info!(id = %leaked.sandbox_id, "leaked sandbox resources cleaned up");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
    };

    use crate::cow_cleanup::cow_destroy_retry_policy;
    use crate::network::NetnsPool;
    use crate::process::ProcessExitCompletion;
    use tracing_subscriber::prelude::*;

    fn test_leaked_resource(sandbox_id: &str) -> LeakedResources {
        LeakedResources {
            sandbox_id: sandbox_id.into(),
            process_exit: None,
            cow_device: None,
            network: None,
            sock_dir: PathBuf::from("/nonexistent"),
            workspace: PathBuf::from("/nonexistent"),
            delete_workspace: true,
        }
    }

    async fn leaked_resource_with_paths(
        delete_workspace: bool,
    ) -> (tempfile::TempDir, LeakedResources) {
        let tmp = tempfile::tempdir().unwrap();
        let sock_dir = tmp.path().join("sock");
        let workspace = tmp.path().join("workspace");
        tokio::fs::create_dir_all(&sock_dir).await.unwrap();
        tokio::fs::create_dir_all(&workspace).await.unwrap();

        (
            tmp,
            LeakedResources {
                sandbox_id: "sandbox".into(),
                process_exit: None,
                cow_device: None,
                network: None,
                sock_dir,
                workspace,
                delete_workspace,
            },
        )
    }

    fn attach_reusable_network(leaked: &mut LeakedResources) -> NetnsPoolHandle {
        let mut pool = NetnsPool::active_at_capacity_for_test();
        let network = pool.lease_for_test("test-leaked-netns");
        pool.track_lease_for_test(&network);
        leaked.network = Some(network);
        NetnsPoolHandle::new_for_test(pool)
    }

    async fn assert_network_unavailable(pool: &NetnsPoolHandle) {
        assert!(pool.acquire().await.is_err());
    }

    async fn assert_network_recycled(pool: &NetnsPoolHandle) {
        let network = pool.acquire().await.unwrap();
        assert_eq!(network.name(), "test-leaked-netns");
        let mut network = Some(network);
        assert!(pool.release(&mut network).await.invalid_message().is_none());
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn leaked_cleanup_waits_for_process_exit_before_recycling_network() {
        let (tmp, mut leaked) = leaked_resource_with_paths(true).await;
        let pool = attach_reusable_network(&mut leaked);
        let (exit_tx, exit) = ProcessExitCompletion::channel();
        leaked.process_exit = Some(exit);
        let cleanup = cleanup_leaked_resource(leaked, &pool);
        tokio::pin!(cleanup);

        assert!(futures_util::poll!(&mut cleanup).is_pending());
        assert_network_unavailable(&pool).await;
        assert!(tmp.path().join("sock").exists());
        assert!(tmp.path().join("workspace").exists());

        exit_tx.send(true).unwrap();
        cleanup.await;

        assert_network_recycled(&pool).await;
        assert!(!tmp.path().join("sock").exists());
        assert!(!tmp.path().join("workspace").exists());
    }

    #[tokio::test]
    async fn leaked_cleanup_preserves_resources_when_process_exit_is_unconfirmed() {
        for completion in [Some(false), None] {
            let (tmp, mut leaked) = leaked_resource_with_paths(true).await;
            let pool = attach_reusable_network(&mut leaked);
            let (exit_tx, exit) = ProcessExitCompletion::channel();
            leaked.process_exit = Some(exit);
            if let Some(confirmed) = completion {
                exit_tx.send(confirmed).unwrap();
            } else {
                drop(exit_tx);
            }

            cleanup_leaked_resource(leaked, &pool).await;

            assert_network_unavailable(&pool).await;
            assert!(tmp.path().join("sock").exists());
            assert!(tmp.path().join("workspace").exists());
            pool.cleanup().await.unwrap();
        }
    }

    #[tokio::test]
    async fn cancelled_leaked_cleanup_does_not_recycle_network_before_exit() {
        let (tmp, mut leaked) = leaked_resource_with_paths(true).await;
        let pool = attach_reusable_network(&mut leaked);
        let (exit_tx, exit) = ProcessExitCompletion::channel();
        leaked.process_exit = Some(exit);
        let mut cleanup = Box::pin(cleanup_leaked_resource(leaked, &pool));

        assert!(futures_util::poll!(&mut cleanup).is_pending());
        drop(cleanup);
        let _ = exit_tx.send(true);

        assert_network_unavailable(&pool).await;
        assert!(tmp.path().join("sock").exists());
        assert!(tmp.path().join("workspace").exists());
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn leaked_cleanup_recycles_network_without_a_launched_process() {
        let (tmp, mut leaked) = leaked_resource_with_paths(true).await;
        let pool = attach_reusable_network(&mut leaked);

        cleanup_leaked_resource(leaked, &pool).await;

        assert_network_recycled(&pool).await;
        assert!(!tmp.path().join("sock").exists());
        assert!(!tmp.path().join("workspace").exists());
    }

    #[tokio::test]
    async fn safe_cow_cleanup_deletes_workspace() {
        let (tmp, leaked) = leaked_resource_with_paths(true).await;
        let netns_pool = NetnsPoolHandle::new_for_test(NetnsPool::inactive_for_test());

        cleanup_leaked_resource(leaked, &netns_pool).await;

        assert!(!tmp.path().join("sock").exists());
        assert!(!tmp.path().join("workspace").exists());
    }

    #[tokio::test]
    async fn unsafe_cow_cleanup_preserves_workspace() {
        let (tmp, leaked) = leaked_resource_with_paths(true).await;
        let netns_pool = NetnsPoolHandle::new_for_test(NetnsPool::inactive_for_test());

        cleanup_leaked_resource_after_cow_cleanup(
            leaked,
            &netns_pool,
            CowCleanupOutcome::DeviceMayStillReferenceBackingFiles,
        )
        .await;

        assert!(!tmp.path().join("sock").exists());
        assert!(tmp.path().join("workspace").exists());
    }

    #[tokio::test]
    async fn disabled_workspace_deletion_preserves_workspace_after_safe_cow_cleanup() {
        let (tmp, leaked) = leaked_resource_with_paths(false).await;
        let netns_pool = NetnsPoolHandle::new_for_test(NetnsPool::inactive_for_test());

        cleanup_leaked_resource_after_cow_cleanup(
            leaked,
            &netns_pool,
            CowCleanupOutcome::BackingFilesSafeToDelete,
        )
        .await;

        assert!(!tmp.path().join("sock").exists());
        assert!(tmp.path().join("workspace").exists());
    }

    #[tokio::test]
    async fn drain_leaked_resources_shutdown_closes_receiver_and_drains_buffer() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let live_sender_clone = tx.clone();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();

        for index in 0..64 {
            tx.send(test_leaked_resource(&format!("leaked-{index}")))
                .unwrap();
        }

        let cleaned = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let cleaned_clone = Arc::clone(&cleaned);
        let (completed_cleanup_count_tx, _completed_cleanup_count_rx) =
            tokio::sync::watch::channel(0);
        let handle = tokio::spawn(drain_leaked_resources_with_cleanup(
            rx,
            shutdown_rx,
            completed_cleanup_count_tx,
            move |leaked| {
                let cleaned = Arc::clone(&cleaned_clone);
                async move {
                    cleaned.lock().await.push(leaked.sandbox_id);
                }
            },
        ));

        shutdown_tx.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), handle)
            .await
            .unwrap()
            .unwrap();

        let mut expected: Vec<String> = (0..64).map(|index| format!("leaked-{index}")).collect();
        expected.sort();
        let mut actual = cleaned.lock().await.clone();
        actual.sort();
        assert_eq!(actual, expected);
        assert!(matches!(
            live_sender_clone.send(test_leaked_resource("late")),
            Err(tokio::sync::mpsc::error::SendError(_))
        ));
    }

    #[tokio::test]
    async fn drain_leaked_resources_starts_later_cleanup_while_first_is_blocked() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let (_shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let release_first = Arc::new(tokio::sync::Semaphore::new(0));
        let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
        let (completed_tx, mut completed_rx) = tokio::sync::mpsc::unbounded_channel();

        tx.send(test_leaked_resource("first")).unwrap();
        tx.send(test_leaked_resource("second")).unwrap();
        drop(tx);

        let cleanup_release_first = Arc::clone(&release_first);
        let (completed_cleanup_count_tx, _completed_cleanup_count_rx) =
            tokio::sync::watch::channel(0);
        let handle = tokio::spawn(drain_leaked_resources_with_cleanup(
            rx,
            shutdown_rx,
            completed_cleanup_count_tx,
            move |leaked| {
                let release_first = Arc::clone(&cleanup_release_first);
                let started_tx = started_tx.clone();
                let completed_tx = completed_tx.clone();
                async move {
                    let sandbox_id = leaked.sandbox_id;
                    started_tx.send(sandbox_id.clone()).unwrap();
                    if sandbox_id == "first" {
                        release_first.acquire().await.unwrap().forget();
                    }
                    completed_tx.send(sandbox_id).unwrap();
                }
            },
        ));

        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), started_rx.recv())
                .await
                .unwrap()
                .unwrap(),
            "first"
        );
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), started_rx.recv())
                .await
                .unwrap()
                .unwrap(),
            "second"
        );
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), completed_rx.recv())
                .await
                .unwrap()
                .unwrap(),
            "second"
        );
        assert!(!handle.is_finished());

        release_first.add_permits(1);
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), completed_rx.recv())
                .await
                .unwrap()
                .unwrap(),
            "first"
        );
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn drain_leaked_resources_bounds_active_cleanup_and_refills_capacity() {
        let report_count = LEAK_CLEANUP_CONCURRENCY + 2;
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let (_shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();

        for index in 0..report_count {
            tx.send(test_leaked_resource(&format!("leaked-{index}")))
                .unwrap();
        }
        drop(tx);

        let cleanup_release = Arc::clone(&release);
        let cleanup_active = Arc::clone(&active);
        let cleanup_peak = Arc::clone(&peak);
        let (completed_cleanup_count_tx, _completed_cleanup_count_rx) =
            tokio::sync::watch::channel(0);
        let handle = tokio::spawn(drain_leaked_resources_with_cleanup(
            rx,
            shutdown_rx,
            completed_cleanup_count_tx,
            move |leaked| {
                let release = Arc::clone(&cleanup_release);
                let active = Arc::clone(&cleanup_active);
                let peak = Arc::clone(&cleanup_peak);
                let started_tx = started_tx.clone();
                async move {
                    let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(current, Ordering::SeqCst);
                    started_tx.send(leaked.sandbox_id).unwrap();
                    release.acquire().await.unwrap().forget();
                    active.fetch_sub(1, Ordering::SeqCst);
                }
            },
        ));

        for _ in 0..LEAK_CLEANUP_CONCURRENCY {
            tokio::time::timeout(std::time::Duration::from_secs(1), started_rx.recv())
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(active.load(Ordering::SeqCst), LEAK_CLEANUP_CONCURRENCY);
        assert_eq!(peak.load(Ordering::SeqCst), LEAK_CLEANUP_CONCURRENCY);
        assert!(matches!(
            started_rx.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));

        release.add_permits(1);
        tokio::time::timeout(std::time::Duration::from_secs(1), started_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(active.load(Ordering::SeqCst), LEAK_CLEANUP_CONCURRENCY);
        assert_eq!(peak.load(Ordering::SeqCst), LEAK_CLEANUP_CONCURRENCY);

        release.add_permits(report_count);
        handle.await.unwrap();
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert_eq!(peak.load(Ordering::SeqCst), LEAK_CLEANUP_CONCURRENCY);
    }

    #[tokio::test]
    async fn drain_leaked_resources_shutdown_closes_intake_and_waits_for_active_cleanup() {
        let report_count = LEAK_CLEANUP_CONCURRENCY + 2;
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let live_sender_clone = tx.clone();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let completed = Arc::new(AtomicUsize::new(0));
        let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();

        for index in 0..report_count {
            tx.send(test_leaked_resource(&format!("leaked-{index}")))
                .unwrap();
        }
        drop(tx);

        let cleanup_release = Arc::clone(&release);
        let cleanup_completed = Arc::clone(&completed);
        let (completed_cleanup_count_tx, _completed_cleanup_count_rx) =
            tokio::sync::watch::channel(0);
        let handle = tokio::spawn(drain_leaked_resources_with_cleanup(
            rx,
            shutdown_rx,
            completed_cleanup_count_tx,
            move |leaked| {
                let release = Arc::clone(&cleanup_release);
                let completed = Arc::clone(&cleanup_completed);
                let started_tx = started_tx.clone();
                async move {
                    started_tx.send(leaked.sandbox_id).unwrap();
                    release.acquire().await.unwrap().forget();
                    completed.fetch_add(1, Ordering::SeqCst);
                }
            },
        ));

        for _ in 0..LEAK_CLEANUP_CONCURRENCY {
            tokio::time::timeout(std::time::Duration::from_secs(1), started_rx.recv())
                .await
                .unwrap()
                .unwrap();
        }
        shutdown_tx.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !live_sender_clone.is_closed() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        assert!(!handle.is_finished());
        assert!(matches!(
            live_sender_clone.send(test_leaked_resource("late")),
            Err(tokio::sync::mpsc::error::SendError(_))
        ));

        release.add_permits(report_count);
        handle.await.unwrap();
        assert_eq!(completed.load(Ordering::SeqCst), report_count);
    }

    #[tokio::test]
    async fn drain_leaked_resources_reports_backlog_and_active_cleanup_fields() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let (_shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        tx.send(test_leaked_resource("first")).unwrap();
        tx.send(test_leaked_resource("second")).unwrap();
        drop(tx);

        let captured = tracing_test_support::CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let guard = tracing::subscriber::set_default(subscriber);
        tracing::callsite::rebuild_interest_cache();
        let (completed_cleanup_count_tx, _completed_cleanup_count_rx) =
            tokio::sync::watch::channel(0);
        drain_leaked_resources_with_cleanup(
            rx,
            shutdown_rx,
            completed_cleanup_count_tx,
            |_| async {},
        )
        .await;
        drop(guard);

        let events = captured.entries();
        let event = events
            .iter()
            .find(|event| {
                event.fields.get("message").map(String::as_str)
                    == Some("cleaning up leaked sandbox resources")
                    && event.fields.get("queued_reports").map(String::as_str) == Some("1")
            })
            .unwrap_or_else(|| panic!("missing cleanup backlog event; events={events:#?}"));
        assert_eq!(
            event.fields.get("active_cleanups").map(String::as_str),
            Some("1")
        );
        assert_eq!(
            event.fields.get("concurrency_limit").map(String::as_str),
            Some("4")
        );
        assert_eq!(
            event.field_kinds.get("queued_reports").copied(),
            Some("u64")
        );
        assert_eq!(
            event.field_kinds.get("active_cleanups").copied(),
            Some("u64")
        );
        assert_eq!(
            event.field_kinds.get("concurrency_limit").copied(),
            Some("u64")
        );
    }

    #[tokio::test]
    async fn drain_leaked_resources_exits_after_sender_close() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let (_shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();

        tx.send(test_leaked_resource("first")).unwrap();
        tx.send(test_leaked_resource("second")).unwrap();
        drop(tx);

        let cleaned = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let cleaned_clone = Arc::clone(&cleaned);
        let (completed_cleanup_count_tx, _completed_cleanup_count_rx) =
            tokio::sync::watch::channel(0);
        drain_leaked_resources_with_cleanup(
            rx,
            shutdown_rx,
            completed_cleanup_count_tx,
            move |leaked| {
                let cleaned = Arc::clone(&cleaned_clone);
                async move {
                    cleaned.lock().await.push(leaked.sandbox_id);
                }
            },
        )
        .await;

        assert_eq!(
            *cleaned.lock().await,
            vec!["first".to_string(), "second".to_string()]
        );
    }

    #[tokio::test]
    async fn leak_cleaner_shutdown_signals_drain_with_live_sender_clone() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let _live_sender_clone = tx.clone();
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel();
        let (_completed_cleanup_count_tx, completed_cleanup_count_rx) =
            tokio::sync::watch::channel(0);
        let drained = Arc::new(AtomicBool::new(false));
        let drained_clone = Arc::clone(&drained);
        let handle = tokio::spawn(async move {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    rx.close();
                    while rx.recv().await.is_some() {}
                    drained_clone.store(true, Ordering::SeqCst);
                }
                _ = rx.recv() => {
                    panic!("leak cleaner did not signal shutdown before receiver completion");
                }
            }
        });

        let cleaner = LeakCleaner {
            tx: Some(tx),
            shutdown_tx: Some(shutdown_tx),
            completed_cleanup_count_rx,
            handle: Some(handle),
        };
        cleaner.shutdown().await;

        assert!(drained.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn leak_cleaner_shutdown_drains_progressing_backlog_past_inactivity_timeout() {
        const CLEANUP_DURATION: std::time::Duration = std::time::Duration::from_secs(2);
        const CLEANUP_WAVES: usize = 16;

        let report_count = LEAK_CLEANUP_CONCURRENCY * CLEANUP_WAVES;
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let (completed_cleanup_count_tx, completed_cleanup_count_rx) =
            tokio::sync::watch::channel(0);
        let post_cow_cleanup_count = Arc::new(AtomicUsize::new(0));

        for index in 0..report_count {
            tx.send(test_leaked_resource(&format!("leaked-{index}")))
                .unwrap();
        }

        let cleanup_count = Arc::clone(&post_cow_cleanup_count);
        let handle = tokio::spawn(drain_leaked_resources_with_cleanup(
            rx,
            shutdown_rx,
            completed_cleanup_count_tx,
            move |_| {
                let cleanup_count = Arc::clone(&cleanup_count);
                async move {
                    tokio::time::sleep(CLEANUP_DURATION).await;
                    cleanup_count.fetch_add(1, Ordering::SeqCst);
                }
            },
        ));
        let cleaner = LeakCleaner {
            tx: Some(tx),
            shutdown_tx: Some(shutdown_tx),
            completed_cleanup_count_rx,
            handle: Some(handle),
        };

        let shutdown_started_at = tokio::time::Instant::now();
        cleaner.shutdown().await;

        assert!(
            tokio::time::Instant::now().duration_since(shutdown_started_at)
                > LEAK_CLEANUP_INACTIVITY_TIMEOUT,
            "regression backlog must exceed the old whole-drain timeout"
        );
        assert_eq!(post_cow_cleanup_count.load(Ordering::SeqCst), report_count);
    }

    #[tokio::test(start_paused = true)]
    async fn leak_cleaner_shutdown_aborts_after_inactivity_timeout() {
        struct AbortFlag(Arc<AtomicBool>);

        impl Drop for AbortFlag {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let (shutdown_tx, _shutdown_rx) = tokio::sync::oneshot::channel();
        let (_completed_cleanup_count_tx, completed_cleanup_count_rx) =
            tokio::sync::watch::channel(0);
        let aborted = Arc::new(AtomicBool::new(false));
        let aborted_clone = Arc::clone(&aborted);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let _flag = AbortFlag(aborted_clone);
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        });
        let cleaner = LeakCleaner {
            tx: Some(tx),
            shutdown_tx: Some(shutdown_tx),
            completed_cleanup_count_rx,
            handle: Some(handle),
        };

        started_rx.await.unwrap();
        let shutdown = cleaner.shutdown();
        tokio::pin!(shutdown);
        tokio::task::yield_now().await;
        tokio::time::advance(LEAK_CLEANUP_INACTIVITY_TIMEOUT).await;
        shutdown.await;

        assert!(aborted.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn leak_cleaner_drop_detaches_drain_and_keeps_live_senders_usable() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let live_sender_clone = tx.clone();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let cleaned = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let cleaned_clone = Arc::clone(&cleaned);
        let (completed_cleanup_count_tx, completed_cleanup_count_rx) =
            tokio::sync::watch::channel(0);
        let handle = tokio::spawn(async move {
            drain_leaked_resources_with_cleanup(
                rx,
                shutdown_rx,
                completed_cleanup_count_tx,
                move |leaked| {
                    let cleaned = Arc::clone(&cleaned_clone);
                    async move {
                        cleaned.lock().await.push(leaked.sandbox_id);
                    }
                },
            )
            .await;
            done_tx.send(()).unwrap();
        });
        let cleaner = LeakCleaner {
            tx: Some(tx),
            shutdown_tx: Some(shutdown_tx),
            completed_cleanup_count_rx,
            handle: Some(handle),
        };

        live_sender_clone
            .send(test_leaked_resource("queued"))
            .unwrap();
        drop(cleaner);
        live_sender_clone
            .send(test_leaked_resource("late"))
            .unwrap();
        drop(live_sender_clone);

        tokio::time::timeout(std::time::Duration::from_secs(1), done_rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            *cleaned.lock().await,
            vec!["queued".to_string(), "late".to_string()]
        );
    }

    #[tokio::test]
    async fn leak_cleaner_drop_without_sender_clones_lets_drain_exit() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let cleaned = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let cleaned_clone = Arc::clone(&cleaned);
        let (completed_cleanup_count_tx, completed_cleanup_count_rx) =
            tokio::sync::watch::channel(0);
        let handle = tokio::spawn(async move {
            drain_leaked_resources_with_cleanup(
                rx,
                shutdown_rx,
                completed_cleanup_count_tx,
                move |leaked| {
                    let cleaned = Arc::clone(&cleaned_clone);
                    async move {
                        cleaned.lock().await.push(leaked.sandbox_id);
                    }
                },
            )
            .await;
            done_tx.send(()).unwrap();
        });
        let cleaner = LeakCleaner {
            tx: Some(tx),
            shutdown_tx: Some(shutdown_tx),
            completed_cleanup_count_rx,
            handle: Some(handle),
        };

        drop(cleaner);

        tokio::time::timeout(std::time::Duration::from_secs(1), done_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(cleaned.lock().await.is_empty());
    }

    #[test]
    fn leak_cleaner_inactivity_timeout_covers_cow_destroy_retry_budget() {
        let retry_policy = cow_destroy_retry_policy();
        let retry_budget = retry_policy
            .delay
            .checked_mul(retry_policy.attempts)
            .expect("destroy retry budget should fit in Duration");

        assert!(
            LEAK_CLEANUP_INACTIVITY_TIMEOUT > retry_budget,
            "leak cleaner inactivity timeout must allow one COW finalizer to finish"
        );
    }

    #[tokio::test]
    async fn leak_cleaner_abort_closes_sender_and_aborts_task() {
        struct AbortFlag(Arc<AtomicBool>);

        impl Drop for AbortFlag {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let (shutdown_tx, _shutdown_rx) = tokio::sync::oneshot::channel();
        let (_completed_cleanup_count_tx, completed_cleanup_count_rx) =
            tokio::sync::watch::channel(0);
        let aborted = Arc::new(AtomicBool::new(false));
        let aborted_clone = Arc::clone(&aborted);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let _flag = AbortFlag(aborted_clone);
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        });
        let mut cleaner = LeakCleaner {
            tx: Some(tx),
            shutdown_tx: Some(shutdown_tx),
            completed_cleanup_count_rx,
            handle: Some(handle),
        };

        started_rx.await.unwrap();
        cleaner.abort();

        assert!(cleaner.tx.is_none());
        assert!(cleaner.shutdown_tx.is_none());
        assert!(cleaner.handle.is_none());
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !aborted.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}
