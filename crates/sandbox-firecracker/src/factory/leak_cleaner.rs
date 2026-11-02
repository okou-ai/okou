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
                if leaked.create_custody.is_some() {
                    // Shutdown may abandon its observer, never accepted owned
                    // creation rollback while its physical custody is retained.
                    let producer = tokio::spawn(async move {
                        cleanup_leaked_resource(leaked, &netns_pool).await;
                    });
                    let _ = producer.await;
                } else {
                    cleanup_leaked_resource(leaked, &netns_pool).await;
                }
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
mod tests;
