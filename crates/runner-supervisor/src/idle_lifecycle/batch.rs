//! Independently owned, fixed guarded batches for prune, drain and shutdown.

use runner_lifecycle::idle_pool::{
    IdleRetirementBatchScope, IdleRetirementEnvelope, IdleRetirementSelection, IdleSandboxIdentity,
};
use runner_lifecycle::status::StatusPersistenceError;

use super::*;

/// Mandatory measured coverage; there is no unguarded admission alternative.
pub struct IdlePoolBatchRetirementRequest {
    pub scope: IdleRetirementBatchScope,
    pub envelope: IdleRetirementEnvelope,
    pub context: &'static str,
}

#[derive(Debug)]
pub struct IdlePoolRetirementRefusal {
    pub identity: IdleSandboxIdentity,
    pub sandbox_id: SandboxId,
    pub error: MemoryOperationError,
}

/// Admission refusal is distinct from uncertainty after physical acceptance.
/// Status failure cannot retract accepted work or prove a complete drain.
#[derive(Debug)]
pub struct IdlePoolRetirementBatchReport {
    pub selected: usize,
    pub completed: usize,
    pub uncertain: usize,
    pub not_started: Vec<IdlePoolRetirementRefusal>,
    pub status_error: Option<StatusPersistenceError>,
}

impl IdlePoolRetirementBatchReport {
    /// Completion of this original selection, not proof that resumed inventory
    /// is empty or that a caller's current drain generation is still active.
    pub fn is_complete(&self) -> bool {
        self.selected == self.completed
            && self.uncertain == 0
            && self.not_started.is_empty()
            && self.status_error.is_none()
    }
}

impl IdleDestroyTracker {
    /// Capture/register ownership before any post-capture yield. Dropping the
    /// returned receiver leaves admission and accepted physical work tracked.
    pub async fn start_pool_retirement_batch(
        &self,
        pool: SharedIdlePool,
        status: Arc<StatusTracker>,
        operations: HostMemoryOperations,
        request: IdlePoolBatchRetirementRequest,
    ) -> Result<IdleCleanupTask<IdlePoolRetirementBatchReport>, MemoryOperationError> {
        let (selections, token) = {
            let pool = pool.lock().await;
            let token = self.tasks.token();
            if self.tasks.is_closed() {
                return Err(MemoryOperationError::Closed);
            }
            (pool.retirement_batch(request.scope), token)
        };
        let tracker = self.clone();
        let context = request.context;
        Ok(self.track(
            async move {
                let _token = token;
                let mut report = IdlePoolRetirementBatchReport {
                    selected: selections.len(),
                    completed: 0,
                    uncertain: 0,
                    not_started: Vec::new(),
                    status_error: None,
                };
                let mut pending: FuturesUnordered<_> = selections
                    .into_iter()
                    .map(|selection| {
                        retire_selection(&tracker, &pool, &operations, selection, &request)
                    })
                    .collect();
                while let Some(result) = pending.next().await {
                    match result {
                        Ok(DestroyOutcome::Completed) => report.completed += 1,
                        Ok(DestroyOutcome::Uncertain) => report.uncertain += 1,
                        Err(refusal) => report.not_started.push(refusal),
                    }
                }
                report
                    .not_started
                    .sort_by(|a, b| a.identity.cmp(&b.identity));
                // Resumed parking is outside the fixed batch but must remain
                // visible. The revision fence also rejects delayed stale writes.
                let snapshot = pool.lock().await.status_snapshot();
                report.status_error = status.set_idle_snapshot(snapshot).await.err();
                report
            },
            context,
        ))
    }
}

async fn retire_selection(
    tracker: &IdleDestroyTracker,
    pool: &SharedIdlePool,
    operations: &HostMemoryOperations,
    selection: IdleRetirementSelection,
    request: &IdlePoolBatchRetirementRequest,
) -> Result<DestroyOutcome, IdlePoolRetirementRefusal> {
    let (identity, sandbox_id, candidate) = selection.into_parts();
    let refusal = |error| IdlePoolRetirementRefusal {
        identity: identity.clone(),
        sandbox_id,
        error,
    };
    let candidate = candidate.map_err(refusal)?;
    let admission = tracker.retire_pool_entry(
        pool,
        operations,
        IdlePoolRetirementRequest {
            candidate,
            envelope: request.envelope,
            context: request.context,
        },
    );
    // External observation failures occur before acceptance. Physical work has
    // its own producer and tracker observer installed atomically by admission.
    let mut started = AssertUnwindSafe(admission)
        .catch_unwind()
        .await
        .unwrap_or(Err(MemoryOperationError::ProducerLost))
        .map_err(refusal)?;
    tracker.notify_reuse_state();
    let outcome = match started.task.join().await {
        Ok(Ok(result)) => {
            // Release this full logical lease at real completion, even while
            // another original entry is still waiting for admission or exit.
            let outcome = result.outcome;
            drop(result.budget_lease);
            outcome
        }
        Ok(Err(_)) | Err(_) => DestroyOutcome::Uncertain,
    };
    Ok(outcome)
}
