//! Optional file-cache warming owned by one snapshot-restoring factory.
//!
//! Residency is an over-approximation of startup accesses, including read-ahead
//! and other restores. Accept only a small observation after real Agent readiness;
//! a completely hot file must not become a whole-memory prefetch request.

mod file;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use file::Envelope;

const UNTRAINED: u8 = 0;
const TRAINED: u8 = 1;
const STOPPED: u8 = 2;
const MAX_BYTES: usize = 128 * 1024 * 1024;
const MAX_RANGES: usize = 4096;

struct Control {
    phase: AtomicU8,
    busy: AtomicBool,
    stop: CancellationToken,
    #[cfg(test)]
    completed: tokio::sync::Notify,
}

struct Reservation(Arc<Control>);

impl Drop for Reservation {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::Release);
    }
}

#[derive(Clone, Copy)]
enum WorkKind {
    Learn,
    Prefetch,
}

struct Request {
    kind: WorkKind,
    reservation: Reservation,
}

/// Shared request capability; shutdown authority remains with the factory.
#[derive(Clone)]
pub(crate) struct SnapshotMemoryHandle {
    control: Arc<Control>,
    tx: mpsc::Sender<Request>,
}

impl SnapshotMemoryHandle {
    pub(crate) fn learn(&self) {
        self.request(WorkKind::Learn, UNTRAINED);
    }

    pub(crate) fn prefetch(&self) {
        self.request(WorkKind::Prefetch, TRAINED);
    }

    fn request(&self, kind: WorkKind, phase: u8) -> bool {
        if self.control.phase.load(Ordering::Acquire) != phase
            || self
                .control
                .busy
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return false;
        }
        let request = Request {
            kind,
            reservation: Reservation(self.control.clone()),
        };
        if self.control.stop.is_cancelled() {
            return false;
        }
        // Failed/closed submission drops the reservation too. No waiter or
        // unbounded backlog is created by concurrent sandbox requests.
        self.tx.try_send(request).is_ok()
    }
}

pub(crate) struct SnapshotMemoryPrefetch {
    handle: SnapshotMemoryHandle,
    worker: Option<JoinHandle<()>>,
}

impl SnapshotMemoryPrefetch {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self::start(
            path,
            #[cfg(test)]
            None,
        )
    }

    fn start(path: PathBuf, #[cfg(test)] hook: Option<tests::WorkHook>) -> Self {
        let control = Arc::new(Control {
            phase: AtomicU8::new(UNTRAINED),
            busy: AtomicBool::new(false),
            stop: CancellationToken::new(),
            #[cfg(test)]
            completed: tokio::sync::Notify::new(),
        });
        let (tx, mut rx) = mpsc::channel::<Request>(1);
        let handle = SnapshotMemoryHandle {
            control: control.clone(),
            tx,
        };
        let worker = tokio::spawn(async move {
            let mut envelope: Option<Envelope> = None;
            loop {
                let request = tokio::select! {
                    biased;
                    () = control.stop.cancelled() => break,
                    request = rx.recv() => match request {
                        Some(request) => request,
                        None => break,
                    },
                };
                let path = path.clone();
                let stop = control.stop.clone();
                #[cfg(test)]
                let hook = hook.clone();
                // The reservation travels with physical IO, not its waiter.
                // Never abort this producer during ordinary shutdown.
                let result = tokio::task::spawn_blocking(move || {
                    let _reservation = request.reservation;
                    #[cfg(test)]
                    if let Some(hook) = hook {
                        hook.wait();
                    }
                    let started = std::time::Instant::now();
                    let stats = match request.kind {
                        WorkKind::Learn if envelope.is_none() => {
                            envelope = file::learn(&path, &stop, MAX_BYTES)?;
                            if let Some(envelope) = envelope.as_ref() {
                                info!(
                                    bytes = envelope.bytes(),
                                    ranges = envelope.range_count(),
                                    "snapshot memory startup envelope learned"
                                );
                            }
                            file::PrefetchStats::default()
                        }
                        WorkKind::Prefetch => match envelope.as_ref() {
                            Some(envelope) => file::prefetch(&path, envelope, &stop)?,
                            None => file::PrefetchStats::default(),
                        },
                        WorkKind::Learn => file::PrefetchStats::default(),
                    };
                    info!(
                        learning = matches!(request.kind, WorkKind::Learn),
                        requested_bytes = stats.requested_bytes,
                        resident_bytes = stats.resident_bytes,
                        elapsed_ms = crate::duration::duration_ms(started.elapsed()),
                        "snapshot memory work completed"
                    );
                    Ok::<_, std::io::Error>(envelope)
                })
                .await;
                match result {
                    Ok(Ok(next)) => envelope = next,
                    Ok(Err(error)) => {
                        warn!(%error, "snapshot memory warming disabled; demand paging remains active");
                        break;
                    }
                    Err(error) => {
                        warn!(%error, "snapshot memory worker failed; demand paging remains active");
                        break;
                    }
                }
                if control.stop.is_cancelled() {
                    break;
                }
                control.phase.store(
                    if envelope.is_some() {
                        TRAINED
                    } else {
                        UNTRAINED
                    },
                    Ordering::Release,
                );
                // Observe physical return and published admission state without
                // making tests poll either the reservation or the phase.
                #[cfg(test)]
                control.completed.notify_one();
            }
            control.phase.store(STOPPED, Ordering::Release);
        });
        Self {
            handle,
            worker: Some(worker),
        }
    }

    pub(crate) fn handle(&self) -> SnapshotMemoryHandle {
        self.handle.clone()
    }

    pub(crate) async fn shutdown(&mut self) {
        self.stop();
        if let Some(worker) = self.worker.as_mut() {
            // Borrow instead of taking: a cancelled shutdown waiter leaves
            // the join handle with its owner for the next shutdown attempt.
            if let Err(error) = worker.await {
                warn!(%error, "snapshot memory owner exited unexpectedly");
            }
            self.worker.take();
        }
    }

    fn stop(&self) {
        self.handle.control.phase.store(STOPPED, Ordering::Release);
        self.handle.control.stop.cancel();
    }
}

impl Drop for SnapshotMemoryPrefetch {
    fn drop(&mut self) {
        // The worker retains each blocking handle until physical return. A
        // kernel read cannot be cancelled by aborting its observing task.
        self.stop();
    }
}

#[cfg(test)]
mod tests;
