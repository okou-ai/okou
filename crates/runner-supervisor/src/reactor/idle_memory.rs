//! Reactive reclamation of owned idle inventory from actual Host availability.

use std::num::NonZeroUsize;
use std::sync::Arc;
use std::time::Duration;

use runner_host::host_memory::{HostMemoryObservation, HostMemoryUnknown};
use runner_lifecycle::host_memory_operations::{
    MemoryObservationSource, ProcMemoryObservationSource,
};
use runner_lifecycle::idle_pool::{DestroyOutcome, RetainedIdleDestroyResult};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tracing::{Instrument, info, warn};

use crate::idle_lifecycle::{IdleDestroyTracker, SharedIdlePool, set_idle_status_snapshot};
use crate::lifecycle::RunnerMode;
use crate::status::StatusTracker;

use super::{RunnerError, RunnerResult};

pub(super) const SAMPLE_PERIOD: Duration = Duration::from_secs(10);
const MAX_SAMPLE_AGE: Duration = SAMPLE_PERIOD.saturating_mul(2);

pub(super) struct IdleMemoryReclaimer {
    headroom_bytes: u64,
    source: Arc<dyn MemoryObservationSource>,
    latest: watch::Sender<MemorySnapshot>,
    task: Option<JoinHandle<ReclaimResult>>,
    fenced: bool,
    // An uncertain outcome cannot make its full logical lease available again.
    retained: Option<RetainedIdleDestroyResult>,
}

struct ReclaimResult {
    observation: HostMemoryObservation,
    cleanup: Option<Result<RetainedIdleDestroyResult, tokio::sync::oneshot::error::RecvError>>,
}

struct MemorySnapshot {
    observation: HostMemoryObservation,
    cleanup_pending: bool,
}

impl IdleMemoryReclaimer {
    /// Keep one configured profile available; optional preparation needs a second.
    /// This is a reactive watermark, not a physical reservation or eviction yield.
    pub(super) fn new(headroom_memory_mb: u32) -> Self {
        Self {
            headroom_bytes: u64::from(headroom_memory_mb) * 1024 * 1024,
            source: Arc::new(ProcMemoryObservationSource),
            latest: watch::channel(MemorySnapshot {
                observation: HostMemoryObservation::unknown(HostMemoryUnknown::NotObserved),
                cleanup_pending: false,
            })
            .0,
            task: None,
            fenced: false,
            retained: None,
        }
    }

    #[cfg(test)]
    pub(super) fn set_source(&mut self, source: Arc<dyn MemoryObservationSource>) {
        self.source = source;
    }

    pub(super) fn can_prepare_blank(&self) -> bool {
        let latest = self.latest.borrow();
        !self.fenced
            && !latest.cleanup_pending
            && latest
                .observation
                .available_bytes_at(Instant::now(), MAX_SAMPLE_AGE)
                .is_ok_and(|available| available >= self.headroom_bytes * 2)
    }

    pub(super) fn request(
        &mut self,
        pool: &SharedIdlePool,
        status: &Arc<StatusTracker>,
        tracker: &IdleDestroyTracker,
        mode: &watch::Receiver<RunnerMode>,
    ) {
        if self.task.is_some() || self.fenced || *mode.borrow() != RunnerMode::Running {
            return;
        }
        let source = Arc::clone(&self.source);
        let pool = Arc::clone(pool);
        let status = Arc::clone(status);
        let tracker = tracker.clone();
        let mode = mode.clone();
        let headroom_bytes = self.headroom_bytes;
        let latest = self.latest.clone();
        self.task = Some(tokio::spawn(
            async move {
                let observation = source.observe().await;
                latest.send_replace(MemorySnapshot {
                    observation: observation.clone(),
                    cleanup_pending: false,
                });
                if !observation
                    .available_bytes_at(Instant::now(), MAX_SAMPLE_AGE)
                    .is_ok_and(|available| available < headroom_bytes)
                {
                    return ReclaimResult { observation, cleanup: None };
                }
                let selected = {
                    let mut pool = pool.lock().await;
                    // Recheck freshness and lifecycle after waiting for selection access.
                    if *mode.borrow() != RunnerMode::Running
                        || !observation
                            .available_bytes_at(Instant::now(), MAX_SAMPLE_AGE)
                            .is_ok_and(|available| available < headroom_bytes)
                    {
                        None
                    } else {
                        pool.pressure_candidates(NonZeroUsize::MIN)
                            .first()
                            .and_then(|candidate| pool.evict_for_pressure(candidate.identity()))
                            .map(|job| {
                                // Accept physical cleanup before any post-selection await.
                                let cleanup = tracker.spawn_confirmed_job(job, "host_memory_pressure");
                                latest.send_modify(|state| state.cleanup_pending = true);
                                info!(
                                    headroom_bytes,
                                    mem_available_bytes = ?observation.available_bytes_at(Instant::now(), MAX_SAMPLE_AGE).ok(),
                                    "reclaiming idle sandbox under host memory pressure"
                                );
                                (cleanup, pool.status_snapshot())
                            })
                    }
                };
                let Some((mut cleanup, snapshot)) = selected else {
                    return ReclaimResult { observation, cleanup: None };
                };
                tracker.notify_reuse_state();
                set_idle_status_snapshot(&status, snapshot).await;
                let result = cleanup.join().await;
                if result.as_ref().is_ok_and(|result| result.home_cache_promoted) {
                    tracker.notify_reuse_state();
                }
                // Only completed cleanup gets a fresh recovery observation.
                // Return uncertain lease custody before starting any further IO.
                let observation = if result
                    .as_ref()
                    .is_ok_and(|result| result.outcome == DestroyOutcome::Completed)
                {
                    source.observe().await
                } else {
                    observation
                };
                ReclaimResult { observation, cleanup: Some(result) }
            }
            .in_current_span(),
        ));
    }

    /// Borrow the accepted task: losing a reactor select race cannot abort it.
    pub(super) async fn wait(&mut self) -> RunnerResult<()> {
        let result = match &mut self.task {
            Some(task) => task.await,
            None => return std::future::pending().await,
        };
        self.task = None;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                self.fenced = true;
                return Err(RunnerError::Internal(format!(
                    "idle memory reclamation task: {error}"
                )));
            }
        };
        self.latest.send_replace(MemorySnapshot {
            observation: result.observation,
            cleanup_pending: false,
        });
        match result.cleanup {
            Some(Ok(cleanup)) if cleanup.outcome == DestroyOutcome::Uncertain => {
                self.fenced = true;
                self.retained = Some(cleanup);
                warn!("idle memory reclamation is uncertain; further pressure reclamation paused");
            }
            Some(Err(error)) => {
                self.fenced = true;
                warn!(%error, "idle memory cleanup producer lost; further pressure reclamation paused");
            }
            Some(Ok(_)) | None => {}
        }
        Ok(())
    }

    /// Normal teardown joins accepted observation, saving and destruction first.
    pub(super) async fn drain(&mut self) -> RunnerResult<()> {
        if self.task.is_some() {
            self.wait().await?;
        }
        Ok(())
    }
}
