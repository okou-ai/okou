//! A retained join owns the permit through SDK/runtime/physical IO destruction.

use std::{
    cell::RefCell,
    future::Future,
    pin::Pin,
    rc::Rc,
    sync::{Arc, Condvar, Mutex, mpsc},
    thread::JoinHandle,
    time::Duration,
};

use futures_util::FutureExt;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

const NODE_CAPACITY: usize = 4;

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Failure {
    ResourceExhausted,
    Cancelled,
    DomainFailed,
    CleanupTimedOut,
}

// Construct the future inside its owning thread. SDK state need not be Send.
pub(crate) type Work = Box<
    dyn FnOnce(Control) -> Pin<Box<dyn Future<Output = Result<(), Failure>> + 'static>>
        + Send
        + 'static,
>;

pub(crate) struct Control {
    completion: Arc<Completion>,
    finalizer: Rc<RefCell<Option<Finalizer>>>,
}

type Finalizer = Pin<Box<dyn Future<Output = Result<(), Failure>>>>;

impl Control {
    /// Record an observed root outcome before its live peer bindings are dropped.
    pub(super) fn record_failure(&self, failure: Failure) {
        self.completion.evidence.terminate(failure);
    }

    pub(super) fn ready(&self) {
        self.completion.publish_ready(Ok(()));
    }

    pub(super) fn retain_client(&self, client: super::node_root::Client) -> Result<(), Failure> {
        let mut retained = self
            .completion
            .client
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if retained.is_some() || self.completion.cancel.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        *retained = Some(client);
        Ok(())
    }

    pub(super) fn cancelled(&self) -> CancellationToken {
        self.completion.cancel.clone()
    }

    pub(super) fn ready_receipt(&self) -> impl Fn() -> bool + Send + use<> {
        let completion = Arc::clone(&self.completion);
        move || {
            matches!(
                *completion.ready.lock().unwrap_or_else(|p| p.into_inner()),
                Some(Ok(()))
            )
        }
    }

    /// The physical owner polls this once after dropping cancelled startup work.
    /// It is not subordinate to a requester's cancellation or async Drop.
    pub(super) fn retain_finalizer(&self, finalizer: Finalizer) -> Result<(), Failure> {
        let mut retained = self.finalizer.borrow_mut();
        if retained.is_some() {
            return Err(Failure::ResourceExhausted);
        }
        *retained = Some(finalizer);
        Ok(())
    }
}

pub(super) struct Completion {
    cancel: CancellationToken,
    start: Mutex<Option<mpsc::SyncSender<bool>>>,
    ready: Mutex<Option<Result<(), Failure>>>,
    ready_changed: Notify,
    physical: Mutex<Option<Result<(), Failure>>>,
    physical_changed: Notify,
    client: Mutex<Option<super::node_root::Client>>,
    journal: Option<Arc<super::provisioning_effect::Journal>>,
    pub(super) evidence: Arc<crate::diagnostics::NativeEvidence>,
}

struct TerminalGuard(Arc<Completion>);
impl Drop for TerminalGuard {
    fn drop(&mut self) {
        self.0.terminate(Failure::DomainFailed);
    }
}

impl Completion {
    pub(super) fn client(&self) -> Result<super::node_root::Client, Failure> {
        if let Some(failure) = self.terminal_failure() {
            return Err(failure);
        }
        if self.cancel.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        self.client
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .ok_or(Failure::DomainFailed)
    }
    pub(super) fn start(&self) {
        if let Some(start) = self.start.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = start.send(!self.cancel.is_cancelled());
        }
    }

    pub(super) fn cancel(&self) {
        self.terminate(Failure::Cancelled);
        if let Some(start) = self.start.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = start.send(false);
        }
    }

    pub(super) fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    pub(super) fn terminal_failure(&self) -> Option<Failure> {
        self.evidence.terminal()
    }

    pub(super) fn observe(&self, watch: crate::diagnostics::NativeWatch) {
        self.evidence.observe(watch);
    }

    fn terminate(&self, failure: Failure) {
        let failure = self.evidence.terminate(failure);
        self.publish_ready(Err(failure));
        self.cancel.cancel();
    }

    fn publish_ready(&self, value: Result<(), Failure>) {
        let mut ready = self.ready.lock().unwrap_or_else(|p| p.into_inner());
        if ready.is_none() {
            *ready = Some(value);
            if value.is_ok() {
                self.evidence.ready();
            }
            drop(ready);
            self.ready_changed.notify_waiters();
        }
    }

    pub(super) fn physically_finished(&self) -> bool {
        self.physical
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some()
    }

    pub(super) fn physical_result(&self) -> Option<Result<(), Failure>> {
        *self.physical.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(super) async fn ready(&self) -> Result<(), Failure> {
        loop {
            let changed = self.ready_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let ready = *self.ready.lock().unwrap_or_else(|p| p.into_inner());
            // Retirement seals success adoption, but must not erase an already
            // published fixed startup failure with a generic Cancelled reason.
            if let Some(Err(failure)) = ready {
                return Err(failure);
            }
            if let Some(failure) = self.terminal_failure() {
                return Err(failure);
            }
            if self.cancel.is_cancelled() {
                return Err(Failure::Cancelled);
            }
            if let Some(result) = ready {
                return result;
            }
            changed.await;
        }
    }

    pub(super) async fn physical(&self) -> Result<(), Failure> {
        loop {
            let changed = self.physical_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if let Some(result) = *self.physical.lock().unwrap_or_else(|p| p.into_inner()) {
                return result;
            }
            changed.await;
        }
    }
}

pub(crate) struct Pool {
    slots: Arc<Semaphore>,
    reapers: TaskTracker,
    shared: Arc<Shared>,
}

struct Entry {
    worker: JoinHandle<Option<Failure>>,
    completion: Arc<Completion>,
    permit: OwnedSemaphorePermit,
}

#[derive(Default)]
struct Entries {
    workers: Vec<Entry>,
    reaper_started: bool,
    stopping: bool,
}

#[derive(Default)]
struct Shared {
    entries: Mutex<Entries>,
    changed: Condvar,
}

impl Pool {
    pub(crate) fn new() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(NODE_CAPACITY)),
            reapers: TaskTracker::new(),
            shared: Arc::new(Shared::default()),
        }
    }

    pub(crate) fn retain_cleanup(
        &self,
        task: tokio::task::JoinHandle<()>,
    ) -> tokio::sync::oneshot::Receiver<bool> {
        let (finished, observed) = tokio::sync::oneshot::channel();
        self.reapers.spawn(async move {
            let _ = finished.send(task.await.is_ok());
        });
        observed
    }

    pub(super) fn allocate(
        &self,
        work: Work,
        journal: Option<Arc<super::provisioning_effect::Journal>>,
    ) -> Result<Arc<Completion>, Failure> {
        let permit = Arc::clone(&self.slots)
            .try_acquire_owned()
            .map_err(|_| Failure::ResourceExhausted)?;
        let runtime = tokio::runtime::Handle::try_current().map_err(|_| Failure::DomainFailed)?;
        let mut entries = self
            .shared
            .entries
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if entries.stopping {
            return Err(Failure::Cancelled);
        }
        if !entries.reaper_started {
            let shared = Arc::clone(&self.shared);
            let reaper = std::thread::Builder::new()
                .name("tailscale-reaper".into())
                .spawn(move || reap(shared))
                .map_err(|_| Failure::DomainFailed)?;
            // The actual reaper starts synchronously, before any SDK work. Cancellation
            // of a queued Tokio join cannot discard its worker joins or their permits.
            self.reapers.spawn_blocking_on(
                move || {
                    let _ = reaper.join();
                },
                &runtime,
            );
            entries.reaper_started = true;
        }
        let (start, started) = mpsc::sync_channel(1);
        let completion = Arc::new(Completion {
            cancel: CancellationToken::new(),
            start: Mutex::new(Some(start)),
            ready: Mutex::new(None),
            ready_changed: Notify::new(),
            physical: Mutex::new(None),
            physical_changed: Notify::new(),
            client: Mutex::new(None),
            journal,
            evidence: Arc::new(crate::diagnostics::NativeEvidence::new()),
        });
        let owned = Arc::clone(&completion);
        let dispatch = super::diagnostics::private_dispatch();
        let worker = std::thread::Builder::new()
            .name("tailscale-node".into())
            .spawn(move || {
                if !started.recv().unwrap_or(false) || owned.cancel.is_cancelled() {
                    return None;
                }
                let _diagnostics = super::diagnostics::Guard::enter(&dispatch);
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let start_dispatch = dispatch.clone();
                    let sdk_runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .on_thread_start(move || {
                            super::diagnostics::blocking_start(&start_dispatch)
                        })
                        .on_thread_stop(super::diagnostics::blocking_stop)
                        .build()
                        .map_err(|_| Failure::DomainFailed)?;
                    // Unwinding must seal adoption before Runtime Drop can block
                    // on a descendant. This guard drops first during a panic.
                    let _terminal_on_return = TerminalGuard(Arc::clone(&owned));
                    let finalizer = Rc::new(RefCell::new(None));
                    let control = Control {
                        completion: Arc::clone(&owned),
                        finalizer: Rc::clone(&finalizer),
                    };
                    let (result, cleanup, panicked) = sdk_runtime.block_on(async {
                        let trace = owned.evidence.layers();
                        let outcome = std::panic::AssertUnwindSafe(async {
                            tokio::select! { biased;
                                () = owned.cancel.cancelled() => Err(Failure::Cancelled),
                                result = trace.clone().scope(work(control)) => result,
                            }
                        })
                        .catch_unwind()
                        .await;
                        let panicked = outcome.is_err();
                        let result = outcome.unwrap_or(Err(Failure::DomainFailed));
                        if result.is_err() {
                            let ready = matches!(
                                *owned.ready.lock().unwrap_or_else(|p| p.into_inner()),
                                Some(Ok(()))
                            );
                            trace.root(if ready {
                                super::evidence::Root::Work
                            } else {
                                super::evidence::Root::Startup
                            });
                        }
                        // Seal adoption and publish startup failure before any
                        // asynchronous finalizer or blocking runtime destruction.
                        if let Err(failure) = result {
                            super::diagnostics::failed(failure, &owned.evidence);
                        }
                        owned.terminate(result.err().unwrap_or(Failure::Cancelled));
                        let retained = finalizer.borrow_mut().take();
                        let cleanup = if let Some(retained) = retained {
                            std::panic::AssertUnwindSafe(retained)
                                .catch_unwind()
                                .await
                                .unwrap_or(Err(Failure::DomainFailed))
                        } else {
                            Ok(())
                        };
                        if let Err(failure) = cleanup {
                            super::diagnostics::failed(failure, &owned.evidence);
                        }
                        (result, cleanup, panicked)
                    });
                    // Drop joins started blocking descendants and destroys SDK async tasks/IO.
                    // This may exceed the caller's deadline; only the reaper releases capacity.
                    drop(sdk_runtime);
                    Ok::<_, Failure>((result, cleanup, panicked))
                }));
                owned.terminate(match &result {
                    Ok(Ok((Err(failure), _, _))) | Ok(Err(failure)) => *failure,
                    Ok(Ok((Ok(()), _, _))) => Failure::Cancelled,
                    Err(_) => Failure::DomainFailed,
                });
                // A panic is a required-cleanup failure even after its thread physically ends.
                match result {
                    Ok(Ok((_, _, true))) => Some(Failure::DomainFailed),
                    Ok(Ok((_, Err(failure), _))) | Ok(Err(failure)) => Some(failure),
                    Ok(Ok(_)) => None,
                    Err(_) => Some(Failure::DomainFailed),
                }
            })
            .map_err(|_| Failure::DomainFailed)?;
        entries.workers.push(Entry {
            worker,
            completion: Arc::clone(&completion),
            permit,
        });
        drop(entries);
        self.shared.changed.notify_one();
        Ok(completion)
    }
}

impl Drop for Pool {
    fn drop(&mut self) {
        let mut entries = self
            .shared
            .entries
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        entries.stopping = true;
        for entry in &entries.workers {
            entry.completion.cancel();
        }
        drop(entries);
        self.shared.changed.notify_one();
        self.reapers.close();
    }
}

fn reap(shared: Arc<Shared>) {
    loop {
        let mut entries = shared.entries.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(index) = entries
            .workers
            .iter()
            .position(|entry| entry.worker.is_finished())
        {
            let entry = entries.workers.swap_remove(index);
            drop(entries);
            // is_finished schedules collection; the actual join proves reclamation.
            let result = match entry.worker.join() {
                Ok(None) => Ok(()),
                Ok(Some(failure)) => Err(failure),
                Err(_) => Err(Failure::DomainFailed),
            };
            entry
                .completion
                .terminate(result.err().unwrap_or(Failure::Cancelled));
            if let Some(journal) = &entry.completion.journal {
                journal.finished(result);
            }
            drop(entry.permit);
            entry.completion.evidence.cleanup(result);
            *entry
                .completion
                .physical
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = Some(result);
            entry.completion.physical_changed.notify_waiters();
            continue;
        }
        if entries.stopping && entries.workers.is_empty() {
            return;
        }
        // Worker return races its notification; polling only schedules a real join.
        drop(
            shared
                .changed
                .wait_timeout(entries, Duration::from_millis(10))
                .unwrap_or_else(|p| p.into_inner()),
        );
    }
}
