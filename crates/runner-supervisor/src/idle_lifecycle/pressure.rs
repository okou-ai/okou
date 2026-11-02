//! Bounded physical-pressure cohorts through the existing guarded terminal owner.

use runner_lifecycle::host_memory_pressure::HostPressurePolicy;
use runner_lifecycle::idle_pool::{
    AcceptedActivationCleanup, ActivationCleanupOutcome, IdlePressureCandidate,
};
use runner_lifecycle::status::StatusPersistenceError;
use tokio_util::sync::CancellationToken;
use tokio_util::task::task_tracker::TaskTrackerToken;

use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdlePressureWaveStop {
    Stopping,
    NoLongerCritical,
    InventoryBusy,
    AdmissionRefused,
}

/// Actual bounded outcomes, never predicted released bytes. Refused and skipped
/// entries have not been detached; uncertainty is distinct from no progress.
#[derive(Debug)]
pub struct IdlePressureWaveReport {
    pub selected: usize,
    pub completed: usize,
    pub uncertain: usize,
    pub not_started: Vec<IdlePoolRetirementRefusal>,
    pub skipped: usize,
    pub stop: Option<IdlePressureWaveStop>,
    pub status_error: Option<StatusPersistenceError>,
}

impl IdlePressureWaveReport {
    /// Every accepted physical task was positively observed. Refusal/skip is
    /// resolved no-progress, not proof of relief or completed original inventory.
    pub fn is_resolved(&self) -> bool {
        self.uncertain == 0
            && self.selected == self.completed + self.not_started.len() + self.skipped
    }

    fn stop(&mut self, count: usize, reason: IdlePressureWaveStop) {
        self.skipped += count;
        self.stop = Some(reason);
    }

    fn refuse(&mut self, candidate: &IdlePressureCandidate, error: MemoryOperationError) {
        self.not_started.push(IdlePoolRetirementRefusal {
            identity: candidate.identity().clone(),
            sandbox_id: candidate.sandbox_id(),
            error,
        });
    }
}

pub(crate) struct IdlePressureWaveRequest {
    pub pool: SharedIdlePool,
    pub status: Arc<StatusTracker>,
    pub operations: HostMemoryOperations,
    pub policy: HostPressurePolicy,
    pub envelope: IdleRetirementEnvelope,
    pub cancel: CancellationToken,
}

const CONTEXT: &str = "guarded_idle_pressure";

impl IdleDestroyTracker {
    /// Observe the actual pressure cohort's initial inventory-lock Pending poll.
    #[cfg(any(test, feature = "test-support"))]
    pub fn pressure_pool_waits_for_test(&self) -> tokio::sync::watch::Receiver<u64> {
        self.pressure_pool_waits.subscribe()
    }

    #[cfg(any(test, feature = "test-support"))]
    async fn lock_pressure_pool_for_test<'a>(
        &self,
        pool: &'a SharedIdlePool,
    ) -> tokio::sync::MutexGuard<'a, IdlePool> {
        let lock = pool.lock();
        tokio::pin!(lock);
        match futures_util::poll!(&mut lock) {
            std::task::Poll::Ready(pool) => return pool,
            std::task::Poll::Pending => self.pressure_pool_waits.send_modify(|count| *count += 1),
        }
        lock.await
    }

    /// Register the entire attempt before its first pool/grant wait. Physical
    /// acceptance separately installs each existing guarded cleanup observer.
    pub(crate) fn start_pressure_wave(
        &self,
        request: IdlePressureWaveRequest,
    ) -> Result<IdleCleanupTask<IdlePressureWaveReport>, MemoryOperationError> {
        let token = self.acceptance_token()?;
        let tracker = self.clone();
        Ok(self.track(
            async move {
                let _token = token;
                run_wave(&tracker, request).await
            },
            CONTEXT,
        ))
    }

    fn adopt_pressure_retirement(
        &self,
        accepted: AcceptedActivationCleanup,
        token: TaskTrackerToken,
    ) -> IdleCleanupTask<DestroyOutcome> {
        let notify = self.reuse_state_notify.clone();
        let (task, retained) = accepted.into_parts();
        {
            let mut owners = self
                .pressure_owners
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            // Completed slots no longer contain a provider or lease. Keep only
            // in-flight or unresolved original capsules, bounded by P2 custody.
            owners.retain(RetainedActivationCleanup::needs_retention);
            owners.push(retained.clone());
        }
        self.track(
            async move {
                let _token = token;
                match task.join().await {
                    Ok(ActivationCleanupOutcome::Completed {
                        home_cache_promoted,
                    }) => {
                        if home_cache_promoted {
                            notify.notify_one();
                        }
                        match retained.take_completed_lease() {
                            Ok(lease) => {
                                drop(lease);
                                DestroyOutcome::Completed
                            }
                            Err(_) => DestroyOutcome::Uncertain,
                        }
                    }
                    Ok(ActivationCleanupOutcome::NoProgress(_)) | Err(_) => {
                        DestroyOutcome::Uncertain
                    }
                }
            },
            CONTEXT,
        )
    }

    /// Explicit reconciliation custody after joined shutdown. Unresolved
    /// capsules retain original data/resources and complete logical leases.
    pub fn take_retained_pressure_owners(
        &self,
    ) -> Result<Vec<RetainedActivationCleanup>, MemoryOperationError> {
        if !self.tasks.is_closed() || !self.tasks.is_empty() {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        let mut owners = self
            .pressure_owners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        owners.retain(RetainedActivationCleanup::needs_retention);
        Ok(std::mem::take(&mut *owners))
    }
}

async fn run_wave(
    tracker: &IdleDestroyTracker,
    request: IdlePressureWaveRequest,
) -> IdlePressureWaveReport {
    let mut report = IdlePressureWaveReport {
        selected: 0,
        completed: 0,
        uncertain: 0,
        not_started: Vec::new(),
        skipped: 0,
        stop: None,
        status_error: None,
    };
    #[cfg(any(test, feature = "test-support"))]
    let pool_lock = tracker.lock_pressure_pool_for_test(&request.pool);
    #[cfg(not(any(test, feature = "test-support")))]
    let pool_lock = request.pool.lock();
    let selections = tokio::select! {
        biased;
        () = request.cancel.cancelled() => {
            report.stop(0, IdlePressureWaveStop::Stopping);
            return report;
        }
        pool = pool_lock => {
            pool.pressure_candidates(request.policy.max_wave_entries)
                .into_iter()
                .map(|candidate| {
                    let retirement = pool.retirement_candidate(candidate.identity());
                    (candidate, retirement)
                })
                .collect::<Vec<_>>()
        }
    };
    report.selected = selections.len();
    let mut ready = Vec::new();
    for (candidate, captured) in selections {
        let mut admission = match captured.and_then(|captured| {
            IdlePoolRetirement::new(captured, &request.operations, request.envelope)
        }) {
            Ok(admission) => admission,
            Err(error) => {
                report.refuse(&candidate, error);
                continue;
            }
        };
        let grant = tokio::select! {
            biased;
            () = request.cancel.cancelled() => Err(MemoryOperationError::Closed),
            result = AssertUnwindSafe(admission.try_grant()).catch_unwind() => {
                result.unwrap_or(Err(MemoryOperationError::ProducerLost))
            }
        };
        match grant {
            Ok(()) => ready.push((candidate, admission)),
            Err(error) => report.refuse(&candidate, error),
        }
    }
    let mut refreshed = Vec::new();
    let mut remaining = ready.into_iter();
    let mut confirmation = None;
    while let Some((candidate, mut admission)) = remaining.next() {
        let grant = tokio::select! {
            biased;
            () = request.cancel.cancelled() => Err(MemoryOperationError::Closed),
            result = AssertUnwindSafe(admission.refresh_grants()).catch_unwind() => {
                result.unwrap_or(Err(MemoryOperationError::ProducerLost))
            }
        };
        match grant {
            Ok(observation) => {
                // The last paired grant covers all other granted claims too;
                // use that exact fresh fenced read to confirm physical pressure.
                confirmation = Some(observation);
                refreshed.push((candidate, admission));
            }
            Err(error) => {
                report.refuse(&candidate, error);
                report.stop(
                    refreshed.len() + remaining.len(),
                    if request.cancel.is_cancelled() {
                        IdlePressureWaveStop::Stopping
                    } else {
                        IdlePressureWaveStop::AdmissionRefused
                    },
                );
                return report;
            }
        }
    }
    let Some(observation) = confirmation else {
        return report;
    };
    let available = observation
        .available_bytes_at(tokio::time::Instant::now(), request.policy.max_sample_age)
        .map_err(MemoryOperationError::from);
    match available {
        Ok(bytes) if bytes > request.policy.bounds.host_total_bytes => {
            for (candidate, _) in &refreshed {
                report.refuse(candidate, MemoryOperationError::ObservationExceedsTotal);
            }
            return report;
        }
        Ok(bytes) if bytes > request.policy.bounds.critical_available_bytes => {
            report.stop(refreshed.len(), IdlePressureWaveStop::NoLongerCritical);
            return report;
        }
        Err(error) => {
            // One failed confirmation rejects the original cohort together.
            let mut entries = refreshed.into_iter();
            if let Some((candidate, _)) = entries.next() {
                report.refuse(&candidate, error);
            }
            report.stop(entries.count(), IdlePressureWaveStop::AdmissionRefused);
            return report;
        }
        Ok(_) => {}
    }
    let mut ready = Vec::new();
    for (candidate, mut admission) in refreshed {
        match admission.validate_granted_backing() {
            Ok(()) => ready.push((candidate, admission)),
            Err(error) => report.refuse(&candidate, error),
        }
    }
    if request.cancel.is_cancelled() {
        report.stop(ready.len(), IdlePressureWaveStop::Stopping);
        return report;
    }
    let mut pool = match request.pool.try_lock() {
        Ok(pool) => pool,
        Err(_) => {
            report.stop(ready.len(), IdlePressureWaveStop::InventoryBusy);
            return report;
        }
    };
    // Check the entire original revision before this cohort's own removals
    // increment it. No await or provider callback can interleave the commit.
    if ready
        .iter()
        .any(|(candidate, _)| !pool.revalidate_pressure_candidate(candidate))
    {
        drop(pool);
        for (candidate, _) in ready {
            report.refuse(&candidate, MemoryOperationError::ResourceChanged);
        }
        return report;
    }
    let mut tasks = Vec::new();
    let mut rejected = Vec::new();
    for (candidate, admission) in ready {
        let token = match tracker.acceptance_token() {
            Ok(token) => token,
            Err(error) => {
                rejected.push((candidate, Err((error, admission))));
                continue;
            }
        };
        match admission.start_required(&mut pool, &request.operations, request.envelope, CONTEXT) {
            Ok(task) => tasks.push(tracker.adopt_pressure_retirement(task, token)),
            Err(failure) => rejected.push((candidate, Ok(failure))),
        }
    }
    drop(pool);
    for (candidate, failure) in rejected {
        let error = match failure {
            Ok(failure) => failure.into_error(),
            Err((error, _admission)) => error,
        };
        report.refuse(&candidate, error);
    }
    let accepted = !tasks.is_empty();
    if accepted {
        tracker.notify_reuse_state();
    }
    let mut pending: FuturesUnordered<_> = tasks.iter_mut().map(IdleCleanupTask::join).collect();
    while let Some(result) = pending.next().await {
        match result {
            Ok(DestroyOutcome::Completed) => report.completed += 1,
            Ok(DestroyOutcome::Uncertain) | Err(_) => report.uncertain += 1,
        }
    }
    if accepted {
        let snapshot = request.pool.lock().await.status_snapshot();
        report.status_error = request.status.set_idle_snapshot(snapshot).await.err();
    }
    report
}

#[cfg(test)]
mod wait_observer_tests;
