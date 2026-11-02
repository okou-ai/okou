//! Factory-owned asynchronous cleanup.
//!
//! While it is not closed, `FactoryCleanupGroup` owns registered destroy and
//! create-rollback cleanup independently of the caller waiting for it. Dropping
//! or cancelling the returned waiter therefore does not cancel the spawned task.
//! Its handle stays under group or shutdown-batch ownership until the task
//! finishes, unless bounded abort processing explicitly detaches it.
//!
//! The group has three lifecycle conditions:
//!
//! - **Accepting:** a new group starts here. Registrations are spawned and
//!   tracked normally.
//! - **Shutting down:** `shutdown` marks the lifecycle as shutting down while it
//!   drains tracked tasks. Registrations made while this condition remains are
//!   still spawned and tracked for the current shutdown, or for a later retry
//!   if that shutdown is cancelled.
//! - **Closed:** shutdown has exhausted tracked work. Later registrations are
//!   not spawned; their cleanup future remains in the returned registration and
//!   runs in the caller only when that registration is awaited. Calling
//!   `start_accepting` after shutdown reopens the group.
//!
//! Cleanup registration is concurrency-safe, but shutdown attempts must be
//! serialized. The factory enforces this through its mutable shutdown lifecycle;
//! after a shutdown future is cancelled, callers may start a later retry.
//!
//! Shutdown has one 30-second production cleanup window shared across its
//! initial and late-registration batches. If the shutdown future is cancelled,
//! dropping its current batch puts unfinished task handles back into the group
//! so a later shutdown can resume ownership. If the window expires, shutdown
//! aborts unfinished tasks, briefly observes their cooperative cancellation,
//! and detaches any task that still cannot finish. Tasks registered during that
//! abort path are also aborted and passed through the bounded post-abort drain
//! before the group closes. Factory shutdown then continues to leak cleanup and
//! pool teardown; runner GC remains the final backstop for host resources left
//! by detached cleanup.
//!
//! The caller chooses how a caught cleanup panic affects its own operation.
//! `FirecrackerFactory::destroy` waits with panic propagation, while
//! `rollback_create_transaction` waits with logging and suppression so the
//! original create error remains authoritative. Dropping the group itself is an
//! abnormal best-effort fallback that cannot await cleanup and does not replace
//! an orderly `shutdown`.

use std::{
    any::Any,
    future::Future,
    panic::AssertUnwindSafe,
    pin::Pin,
    sync::{Mutex as StdMutex, MutexGuard as StdMutexGuard, TryLockError},
    task::{Context, Poll},
};

use futures_util::{FutureExt, task::noop_waker_ref};
use tokio::task::{JoinError, JoinHandle};
use tracing::{info, warn};

/// Maximum time to wait for explicit factory cleanup tasks during shutdown.
///
/// These tasks own normal destroy/rollback cleanup work. If they stall, abort
/// them before shutting down leak cleanup and factory-owned pools; runner GC
/// remains the final backstop for orphaned host resources.
#[cfg(not(test))]
const FACTORY_CLEANUP_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
#[cfg(test)]
const FACTORY_CLEANUP_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(50);

/// Maximum time to observe prompt cancellation after aborting cleanup tasks.
///
/// This is not a second cleanup window. It only gives already-cancelled tasks a
/// chance to finish their cooperative cancellation path. Any task still running
/// after this window is detached so factory shutdown can continue to leak
/// cleanup and runner GC fallback paths.
#[cfg(not(test))]
const FACTORY_CLEANUP_POST_ABORT_DRAIN_TIMEOUT: std::time::Duration =
    std::time::Duration::from_millis(250);
#[cfg(test)]
const FACTORY_CLEANUP_POST_ABORT_DRAIN_TIMEOUT: std::time::Duration =
    std::time::Duration::from_millis(20);

#[derive(Clone, Copy)]
pub(super) enum FactoryCleanupTaskKind {
    Destroy,
    Rollback,
}

impl FactoryCleanupTaskKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Destroy => "destroy",
            Self::Rollback => "rollback",
        }
    }
}

struct FactoryCleanupTaskRecord {
    kind: FactoryCleanupTaskKind,
    label: String,
}

struct FactoryCleanupTaskHandle {
    record: FactoryCleanupTaskRecord,
    handle: JoinHandle<()>,
}

impl FactoryCleanupTaskHandle {
    fn abort(&self) {
        self.handle.abort();
    }

    fn is_finished(&self) -> bool {
        self.handle.is_finished()
    }

    fn record(&self) -> &FactoryCleanupTaskRecord {
        &self.record
    }
}

enum FactoryCleanupTaskOutcome {
    Completed,
    Panicked(Box<dyn Any + Send + 'static>),
}

enum FactoryCleanupPanicPolicy {
    Propagate,
    Log,
}

pub(super) struct FactoryCleanupWaiter {
    kind: FactoryCleanupTaskKind,
    label: String,
    rx: tokio::sync::oneshot::Receiver<FactoryCleanupTaskOutcome>,
}

impl FactoryCleanupWaiter {
    async fn wait(self, panic_policy: FactoryCleanupPanicPolicy) {
        match self.rx.await {
            Ok(FactoryCleanupTaskOutcome::Completed) => {}
            Ok(FactoryCleanupTaskOutcome::Panicked(payload)) => match panic_policy {
                FactoryCleanupPanicPolicy::Propagate => std::panic::resume_unwind(payload),
                FactoryCleanupPanicPolicy::Log => {}
            },
            Err(_) => {
                info!(
                    kind = self.kind.as_str(),
                    label = %self.label,
                    "factory cleanup task ended before reporting completion"
                );
            }
        }
    }
}

/// Owns tracked factory cleanup tasks and coordinates their bounded shutdown.
pub(super) struct FactoryCleanupGroup {
    state: StdMutex<FactoryCleanupGroupState>,
}

enum FactoryCleanupLifecycle {
    /// New cleanup is spawned and tracked normally.
    Accepting,
    /// Shutdown has begun but may have been cancelled; new registrations remain
    /// tracked for the current or a later shutdown attempt.
    ShuttingDown,
    /// Shutdown has exhausted tracked work.
    ///
    /// A closed group defers new cleanup to the caller until `start_accepting`
    /// reopens it.
    Closed,
}

/// Mutable task ownership and lifecycle state for `FactoryCleanupGroup`.
struct FactoryCleanupGroupState {
    lifecycle: FactoryCleanupLifecycle,
    tasks: Vec<FactoryCleanupTaskHandle>,
}

impl FactoryCleanupGroupState {
    fn new() -> Self {
        Self {
            lifecycle: FactoryCleanupLifecycle::Accepting,
            tasks: Vec::new(),
        }
    }
}

/// Tasks temporarily owned by one shutdown drain pass.
///
/// Dropping an unfinished batch returns its handles to the group, which keeps a
/// cancelled shutdown retryable.
struct FactoryCleanupBatch<'a> {
    group: &'a FactoryCleanupGroup,
    tasks: Vec<FactoryCleanupTaskHandle>,
}

impl FactoryCleanupBatch<'_> {
    fn is_empty(&self) -> bool {
        self.tasks.is_empty()
    }

    fn len(&self) -> usize {
        self.tasks.len()
    }

    fn abort_all(&self) {
        for task in &self.tasks {
            task.abort();
        }
    }

    fn records(&self) -> impl Iterator<Item = &FactoryCleanupTaskRecord> {
        self.tasks.iter().map(FactoryCleanupTaskHandle::record)
    }

    fn detach_all(&mut self) -> Vec<FactoryCleanupTaskRecord> {
        std::mem::take(&mut self.tasks)
            .into_iter()
            .map(|task| task.record)
            .collect()
    }

    async fn next_finished(&mut self) -> Option<(FactoryCleanupTaskRecord, Result<(), JoinError>)> {
        std::future::poll_fn(|cx| {
            let mut index = 0;
            while index < self.tasks.len() {
                let poll_result = {
                    let Some(task) = self.tasks.get_mut(index) else {
                        break;
                    };
                    Pin::new(&mut task.handle).poll(cx)
                };
                match poll_result {
                    Poll::Ready(result) => {
                        let task = self.tasks.swap_remove(index);
                        return Poll::Ready(Some((task.record, result)));
                    }
                    Poll::Pending => {
                        index += 1;
                    }
                }
            }

            if self.tasks.is_empty() {
                Poll::Ready(None)
            } else {
                Poll::Pending
            }
        })
        .await
    }
}

impl Drop for FactoryCleanupBatch<'_> {
    fn drop(&mut self) {
        if self.tasks.is_empty() {
            return;
        }

        let mut state = self.group.lock_state();
        state.tasks.append(&mut self.tasks);
    }
}

/// Cleanup deferred to the caller because the group was already closed.
pub(super) struct FactoryCleanupRejected<F> {
    kind: FactoryCleanupTaskKind,
    label: String,
    cleanup: F,
}

/// A completion waiter or caller-owned fallback returned by `FactoryCleanupGroup::spawn`.
///
/// `Waiter` only observes cleanup that is already group-owned, so dropping it
/// does not cancel the task. `Rejected` still owns an unstarted closed-group
/// cleanup future, so awaiting that variant is what runs cleanup in the caller
/// task.
#[must_use = "factory cleanup registrations must be awaited so closed-group cleanup can run"]
pub(super) enum FactoryCleanupRegistration<F> {
    /// Observes a cleanup task that has already been spawned and retained by the group.
    Waiter(FactoryCleanupWaiter),
    /// Owns an unspawned cleanup future rejected from a closed group.
    Rejected(FactoryCleanupRejected<F>),
}

impl<F> FactoryCleanupRegistration<F>
where
    F: Future<Output = ()> + Send + 'static,
{
    /// Wait for cleanup and resume any caught panic in this caller.
    ///
    /// `FirecrackerFactory::destroy` uses this policy so destroy cleanup
    /// failures remain visible to its caller.
    pub(super) async fn wait_propagating_panic(self) {
        self.wait(FactoryCleanupPanicPolicy::Propagate).await;
    }

    /// Wait for cleanup while leaving any caught panic logged and suppressed.
    ///
    /// `rollback_create_transaction` uses this policy so a rollback panic does
    /// not replace the original create error.
    pub(super) async fn wait_logging_panic(self) {
        self.wait(FactoryCleanupPanicPolicy::Log).await;
    }

    async fn wait(self, panic_policy: FactoryCleanupPanicPolicy) {
        match self {
            Self::Waiter(waiter) => waiter.wait(panic_policy).await,
            Self::Rejected(rejected) => rejected.wait(panic_policy).await,
        }
    }
}

impl<F> FactoryCleanupRejected<F>
where
    F: Future<Output = ()> + Send + 'static,
{
    async fn wait(self, panic_policy: FactoryCleanupPanicPolicy) {
        warn!(
            kind = self.kind.as_str(),
            label = %self.label,
            "factory cleanup group is closed; running cleanup in caller task"
        );

        match AssertUnwindSafe(self.cleanup).catch_unwind().await {
            Ok(()) => {}
            Err(payload) => match panic_policy {
                FactoryCleanupPanicPolicy::Propagate => std::panic::resume_unwind(payload),
                FactoryCleanupPanicPolicy::Log => {
                    warn!(
                        kind = self.kind.as_str(),
                        label = %self.label,
                        "factory cleanup task panicked"
                    );
                }
            },
        }
    }
}

impl FactoryCleanupGroup {
    pub(super) fn new() -> Self {
        Self {
            state: StdMutex::new(FactoryCleanupGroupState::new()),
        }
    }

    fn lock_state(&self) -> StdMutexGuard<'_, FactoryCleanupGroupState> {
        match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => {
                warn!("factory cleanup group state mutex was poisoned; continuing");
                poisoned.into_inner()
            }
        }
    }

    /// Put the group in its accepting lifecycle condition.
    ///
    /// A new group already accepts work, so the initial call is idempotent.
    /// Calling this after shutdown has completed reaps completed handles and
    /// reopens the closed group for tracked cleanup.
    pub(super) fn start_accepting(&self) {
        let mut state = self.lock_state();
        Self::reap_completed_locked(&mut state);
        state.lifecycle = FactoryCleanupLifecycle::Accepting;
    }

    /// Register cleanup for factory ownership and return its completion handle.
    ///
    /// In the accepting or shutting-down condition, this starts the cleanup in
    /// a Tokio task and retains its handle in the group. Cancelling or dropping
    /// the returned waiter does not cancel that task. Once the group is closed,
    /// this instead returns a deferred registration whose cleanup runs in the
    /// caller task only when awaited.
    pub(super) fn spawn<F>(
        &self,
        kind: FactoryCleanupTaskKind,
        label: impl Into<String>,
        cleanup: F,
    ) -> FactoryCleanupRegistration<F>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let label = label.into();
        let waiter_label = label.clone();
        let mut state = self.lock_state();
        Self::reap_completed_locked(&mut state);
        match state.lifecycle {
            FactoryCleanupLifecycle::Accepting => {}
            FactoryCleanupLifecycle::ShuttingDown => {
                warn!(
                    kind = kind.as_str(),
                    label = %label,
                    "factory cleanup group is shutting down; registered cleanup task for shutdown drain"
                );
            }
            FactoryCleanupLifecycle::Closed => {
                warn!(
                    kind = kind.as_str(),
                    label = %label,
                    "factory cleanup group is closed; rejecting tracked cleanup registration"
                );
                return FactoryCleanupRegistration::Rejected(FactoryCleanupRejected {
                    kind,
                    label,
                    cleanup,
                });
            }
        }

        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let task = Self::cleanup_task(kind, label.clone(), cleanup, done_tx);
        let handle = tokio::spawn(task);
        state.tasks.push(FactoryCleanupTaskHandle {
            record: FactoryCleanupTaskRecord {
                kind,
                label: label.clone(),
            },
            handle,
        });

        FactoryCleanupRegistration::Waiter(FactoryCleanupWaiter {
            kind,
            label: waiter_label,
            rx: done_rx,
        })
    }

    /// Drain tracked cleanup and transition the group to closed.
    ///
    /// Callers must run only one shutdown attempt at a time. A cancelled attempt
    /// may be followed by a new one after the first future has been dropped.
    ///
    /// Registrations accepted before the group closes are drained or aborted by
    /// the same call. The graceful batches share one timeout; after it expires,
    /// unfinished and late tasks are aborted, briefly observed, and detached if
    /// necessary. Cancelling this future before completion returns unfinished
    /// batch ownership to the group so a later shutdown can retry it.
    pub(super) async fn shutdown(&self) {
        let timeout = tokio::time::sleep(FACTORY_CLEANUP_SHUTDOWN_TIMEOUT);
        tokio::pin!(timeout);

        loop {
            let Some(mut batch) = self.take_shutdown_batch() else {
                return;
            };

            if self.drain_shutdown_batch(&mut batch, &mut timeout).await {
                self.abort_remaining_after_shutdown_timeout().await;
                return;
            }
        }
    }

    fn take_shutdown_batch(&self) -> Option<FactoryCleanupBatch<'_>> {
        let mut state = self.lock_state();
        state.lifecycle = FactoryCleanupLifecycle::ShuttingDown;
        Self::reap_completed_locked(&mut state);
        if state.tasks.is_empty() {
            state.lifecycle = FactoryCleanupLifecycle::Closed;
            return None;
        }
        Some(FactoryCleanupBatch {
            group: self,
            tasks: std::mem::take(&mut state.tasks),
        })
    }

    async fn drain_shutdown_batch(
        &self,
        batch: &mut FactoryCleanupBatch<'_>,
        timeout: &mut std::pin::Pin<&mut tokio::time::Sleep>,
    ) -> bool {
        loop {
            if batch.is_empty() {
                return false;
            }

            tokio::select! {
                result = batch.next_finished() => {
                    let Some((record, result)) = result else {
                        return false;
                    };
                    Self::handle_join_result(record, result, false);
                }
                () = timeout.as_mut() => {
                    let task_count = batch.len();
                    warn!(
                        task_count,
                        timeout_ms = FACTORY_CLEANUP_SHUTDOWN_TIMEOUT.as_millis() as u64,
                        "timed out waiting for factory cleanup tasks; aborting"
                    );
                    for record in batch.records() {
                        warn!(
                            kind = record.kind.as_str(),
                            label = %record.label,
                            "aborting factory cleanup task; runner gc may need to clean leftovers"
                        );
                    }
                    batch.abort_all();
                    Self::drain_aborted_batch(batch).await;
                    return true;
                }
            }
        }
    }

    async fn drain_aborted_batch(batch: &mut FactoryCleanupBatch<'_>) {
        let timeout = tokio::time::sleep(FACTORY_CLEANUP_POST_ABORT_DRAIN_TIMEOUT);
        tokio::pin!(timeout);

        loop {
            if batch.is_empty() {
                return;
            }

            tokio::select! {
                biased;
                result = batch.next_finished() => {
                    let Some((record, result)) = result else {
                        return;
                    };
                    Self::handle_join_result(record, result, true);
                }
                () = timeout.as_mut() => {
                    for record in batch.detach_all() {
                        warn!(
                            kind = record.kind.as_str(),
                            label = %record.label,
                            timeout_ms = FACTORY_CLEANUP_POST_ABORT_DRAIN_TIMEOUT.as_millis() as u64,
                            "detaching aborted factory cleanup task after post-abort drain timeout"
                        );
                    }
                    return;
                }
            }
        }
    }

    async fn abort_remaining_after_shutdown_timeout(&self) {
        loop {
            let mut batch = {
                let mut state = self.lock_state();
                state.lifecycle = FactoryCleanupLifecycle::ShuttingDown;
                Self::reap_completed_locked(&mut state);
                if state.tasks.is_empty() {
                    state.lifecycle = FactoryCleanupLifecycle::Closed;
                    return;
                }
                FactoryCleanupBatch {
                    group: self,
                    tasks: std::mem::take(&mut state.tasks),
                }
            };

            for record in batch.records() {
                warn!(
                    kind = record.kind.as_str(),
                    label = %record.label,
                    "aborting late factory cleanup task after shutdown timeout"
                );
            }
            batch.abort_all();
            Self::drain_aborted_batch(&mut batch).await;
        }
    }

    async fn cleanup_task<F>(
        kind: FactoryCleanupTaskKind,
        label: String,
        cleanup: F,
        done_tx: tokio::sync::oneshot::Sender<FactoryCleanupTaskOutcome>,
    ) where
        F: Future<Output = ()> + Send + 'static,
    {
        let result = AssertUnwindSafe(cleanup).catch_unwind().await;
        match result {
            Ok(()) => {
                let _ = done_tx.send(FactoryCleanupTaskOutcome::Completed);
            }
            Err(payload) => {
                warn!(
                    kind = kind.as_str(),
                    label = %label,
                    "factory cleanup task panicked"
                );
                let _ = done_tx.send(FactoryCleanupTaskOutcome::Panicked(payload));
            }
        }
    }

    fn reap_completed_locked(state: &mut FactoryCleanupGroupState) {
        let mut index = 0;
        while index < state.tasks.len() {
            let Some(task) = state.tasks.get(index) else {
                break;
            };
            if !task.is_finished() {
                index += 1;
                continue;
            }

            let mut task = state.tasks.swap_remove(index);
            let waker = noop_waker_ref();
            let mut cx = Context::from_waker(waker);
            match Pin::new(&mut task.handle).poll(&mut cx) {
                Poll::Ready(result) => {
                    Self::handle_join_result(task.record, result, false);
                }
                Poll::Pending => {
                    state.tasks.insert(index, task);
                    index += 1;
                }
            };
        }
    }

    fn handle_join_result(
        record: FactoryCleanupTaskRecord,
        result: Result<(), JoinError>,
        after_abort: bool,
    ) {
        match result {
            Ok(()) => {
                if after_abort {
                    info!(
                        kind = record.kind.as_str(),
                        label = %record.label,
                        "factory cleanup task completed while shutdown abort was in progress"
                    );
                }
            }
            Err(err) => {
                let kind = record.kind.as_str();
                let label = record.label;
                if err.is_cancelled() && after_abort {
                    info!(
                        kind,
                        label = %label,
                        "factory cleanup task aborted during shutdown"
                    );
                } else {
                    warn!(
                        kind,
                        label = %label,
                        error = %err,
                        "factory cleanup task exited unexpectedly"
                    );
                }
            }
        }
    }
}

impl Drop for FactoryCleanupGroup {
    fn drop(&mut self) {
        match self.state.try_lock() {
            Ok(mut state) => {
                Self::reap_completed_locked(&mut state);
                if state.tasks.is_empty() {
                    return;
                }
                warn!(
                    task_count = state.tasks.len(),
                    "factory cleanup group dropped with in-flight tasks; aborting without await"
                );
                for task in state.tasks.iter() {
                    task.abort();
                }
            }
            Err(TryLockError::WouldBlock) => {
                warn!("factory cleanup group dropped while locked; cleanup tasks may keep running");
            }
            Err(TryLockError::Poisoned(poisoned)) => {
                let mut state = poisoned.into_inner();
                Self::reap_completed_locked(&mut state);
                if !state.tasks.is_empty() {
                    warn!(
                        task_count = state.tasks.len(),
                        "factory cleanup group dropped with poisoned state and in-flight tasks; aborting without await"
                    );
                    for task in state.tasks.iter() {
                        task.abort();
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
