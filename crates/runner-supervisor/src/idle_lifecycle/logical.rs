//! Mandatory physical coverage around deterministic full-profile substitution.

use runner_lifecycle::status::StatusPersistenceError;

use super::*;

pub type GuardedLogicalCleanupTask =
    IdleCleanupTask<Result<IdleDestroyResult, MemoryOperationError>>;

/// Shared measured coverage is required for every selected logical eviction.
pub struct GuardedIdlePressureRequest<'a> {
    pub selection: IdlePressureRequest<'a>,
    pub envelope: IdleRetirementEnvelope,
}

/// Logical admission and separately observed, cancellation-safe physical work.
/// Refusals preserve original inventory; a status error cannot retract acceptance.
pub struct GuardedIdlePressureResult {
    pub selection: IdlePressureSelection,
    pub blank_pool_selection: Option<BlankPoolSelection>,
    pub retirements: Vec<GuardedLogicalCleanupTask>,
    pub not_started: Vec<IdlePoolRetirementRefusal>,
    pub status_error: Option<StatusPersistenceError>,
}

/// Prefer reuse, then fitting capacity, then only enough guarded original victims.
/// Admission waits never hold inventory. Every accepted cleanup is tracked before
/// status/yield; complete leases transfer atomically without awaiting old exit.
/// This component takes supplied P2 authority; production assembly owns the same
/// authority for the replacement's separate Fresh/Resume preparation.
pub async fn select_idle_entries_for_guarded_pressure(
    idle_pool: &SharedIdlePool,
    status: &StatusTracker,
    tracker: &IdleDestroyTracker,
    budget: &Arc<ResourceBudget>,
    operations: &HostMemoryOperations,
    mut retiring_leases: Vec<BudgetLease>,
    request: GuardedIdlePressureRequest<'_>,
) -> GuardedIdlePressureResult {
    let mut retirements = Vec::new();
    let mut not_started = Vec::new();
    let (selections, mut blank_pool_selection) = {
        let mut pool = idle_pool.lock().await;
        let (ready, blank_pool_selection) =
            fitting_selection(&mut pool, budget, &mut retiring_leases, &request.selection);
        if let Some(selection) = ready {
            return GuardedIdlePressureResult {
                selection,
                blank_pool_selection,
                retirements,
                not_started,
                status_error: None,
            };
        }
        (pool.logical_retirement_candidates(), blank_pool_selection)
    };
    let mut ready = None;
    for selection in selections {
        let (identity, sandbox_id, candidate) = selection.into_parts();
        let refusal = |error| IdlePoolRetirementRefusal {
            identity: identity.clone(),
            sandbox_id,
            error,
        };
        let admission = candidate
            .and_then(|candidate| IdlePoolRetirement::new(candidate, operations, request.envelope));
        let mut admission = match admission {
            Ok(admission) => admission,
            Err(error) => {
                not_started.push(refusal(error));
                continue;
            }
        };
        if let Err(error) = AssertUnwindSafe(admission.try_grant())
            .catch_unwind()
            .await
            .unwrap_or(Err(MemoryOperationError::ProducerLost))
        {
            not_started.push(refusal(error));
            continue;
        }
        let mut pool = idle_pool.lock().await;
        let (selection, blank) =
            fitting_selection(&mut pool, budget, &mut retiring_leases, &request.selection);
        blank_pool_selection = blank;
        if selection.is_some() {
            ready = selection;
            // Release unused provider claims outside exclusive inventory access.
            drop(pool);
            drop(admission);
            break;
        }
        let token = tracker.tasks.token();
        if tracker.tasks.is_closed() {
            drop(pool);
            not_started.push(refusal(MemoryOperationError::Closed));
            continue;
        }
        let started = match admission.start_for_substitution(&mut pool, request.selection.context) {
            Ok(started) => started,
            Err(failure) => {
                drop(pool);
                not_started.push(refusal(failure.into_error()));
                continue;
            }
        };
        retirements.push(tracker.adopt_pool_substitution(
            started.task,
            token,
            request.selection.context,
        ));
        tracker.notify_reuse_state();
        retiring_leases.push(started.budget_lease);
        if let Some(lease) = try_substitute_retiring_leases(
            budget,
            &mut retiring_leases,
            request.selection.vcpu,
            request.selection.memory_mb,
        ) {
            ready = Some(IdlePressureSelection::Fresh(lease));
            break;
        }
    }
    if ready.is_none() {
        let mut pool = idle_pool.lock().await;
        let (selection, blank) =
            fitting_selection(&mut pool, budget, &mut retiring_leases, &request.selection);
        ready = selection;
        blank_pool_selection = blank;
    }
    let selection = ready.unwrap_or(IdlePressureSelection::Exhausted(retiring_leases));
    // Reuse already carries its exact current snapshot to the activation owner.
    // Do not retain a caller-owned reservation across a status await here.
    let status_error =
        if !retirements.is_empty() && !matches!(selection, IdlePressureSelection::Reusable(_)) {
            let snapshot = idle_pool.lock().await.status_snapshot();
            status.set_idle_snapshot(snapshot).await.err()
        } else {
            None
        };
    GuardedIdlePressureResult {
        selection,
        blank_pool_selection,
        retirements,
        not_started,
        status_error,
    }
}

impl IdleDestroyTracker {
    pub(crate) fn adopt_pool_substitution(
        &self,
        task: runner_lifecycle::host_memory_operations::MemoryOperationTask<IdleDestroyResult>,
        token: tokio_util::task::task_tracker::TaskTrackerToken,
        context: &'static str,
    ) -> GuardedLogicalCleanupTask {
        let notify = self.reuse_state_notify.clone();
        self.track(
            async move {
                let _token = token;
                let result = task.join().await;
                if result
                    .as_ref()
                    .is_ok_and(|result| result.home_cache_promoted)
                {
                    notify.notify_one();
                }
                result
            },
            context,
        )
    }
}

fn fitting_selection(
    pool: &mut IdlePool,
    budget: &Arc<ResourceBudget>,
    retiring_leases: &mut Vec<BudgetLease>,
    request: &IdlePressureRequest<'_>,
) -> (Option<IdlePressureSelection>, Option<BlankPoolSelection>) {
    let (reservation, blank) = reserve_pressure_reuse(pool, budget, request);
    if let Some(reservation) = reservation {
        retiring_leases.clear();
        return (
            Some(IdlePressureSelection::Reusable(ReservedIdleActivation {
                reservation: Box::new(reservation),
                idle_snapshot: pool.status_snapshot(),
            })),
            blank,
        );
    }
    (
        try_substitute_retiring_leases(budget, retiring_leases, request.vcpu, request.memory_mb)
            .map(IdlePressureSelection::Fresh),
        blank,
    )
}
