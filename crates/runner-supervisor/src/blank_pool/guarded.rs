//! Mandatory coverage for the pool-owned half of aged blank replenishment.
//!
//! Production/Fresh preparation assembly remains P4. Caller-owned failed
//! preparation/repark recovery is separate; there is no unguarded cleanup retry.

use runner_lifecycle::host_memory_operations::{HostMemoryOperations, MemoryOperationError};
use runner_lifecycle::idle_pool::{
    ActivationCleanupOutcome, IdlePoolIncoming, IdlePoolRetirement, IdleRetirementCandidate,
    IdleRetirementEnvelope,
};

use super::*;

pub struct GuardedBlankPoolRequest<'a> {
    pub mode: RunnerMode,
    pub pool: &'a SharedIdlePool,
    pub budget: &'a Arc<ResourceBudget>,
    pub admission: &'a PreSpawnAdmission,
    pub status: &'a Arc<StatusTracker>,
    pub tracker: &'a IdleDestroyTracker,
    pub operations: &'a HostMemoryOperations,
    pub envelope: IdleRetirementEnvelope,
}

enum GuardedPrepareBudget {
    Available(BudgetLease),
    Aged(IdleRetirementCandidate),
}

impl BlankPoolReplenisher {
    /// Schedule grant/status/old cleanup waits independently of the reactor.
    /// The pool-owned victim is never removed before mandatory acceptance.
    /// Caller-owned new-VM preparation requires its separate Fresh coverage in
    /// the same accepting authority and a join before dependent teardown. This
    /// method covers the old pool-owned phase; the native fixture composes both.
    pub async fn maybe_start_guarded(&mut self, request: GuardedBlankPoolRequest<'_>) {
        if !self.attempt_requested
            || self.preparation.is_some()
            || self.optional.is_some()
            || request.mode != RunnerMode::Running
        {
            return;
        }
        self.attempt_requested = false;
        let Some(plan) = self.plan.clone() else {
            return;
        };
        let pool = request.pool.lock().await;
        if pool.blank_len() >= plan.target {
            self.diagnostics.ready();
            return;
        }
        let pre_spawn_lease = match request.admission.try_acquire_background(plan.profile.vcpu) {
            Ok(Some(lease)) => lease,
            Ok(None) | Err(_) => {
                self.diagnostics.unknown();
                return;
            }
        };
        let available = if plan.max_idle > 0 && pool.len() >= plan.max_idle {
            None
        } else {
            ResourceBudget::try_reserve_lease(
                request.budget,
                plan.profile.vcpu,
                plan.profile.memory_mb,
            )
            .filter(|_| {
                request
                    .budget
                    .can_afford(plan.headroom_vcpu, plan.headroom_memory_mb)
            })
        };
        let prepare_budget = match available {
            Some(lease) => GuardedPrepareBudget::Available(lease),
            None => match aged_candidate(&pool, &plan) {
                Ok(Some(candidate)) => GuardedPrepareBudget::Aged(candidate),
                Ok(None) | Err(_) => {
                    self.diagnostics.unknown();
                    return;
                }
            },
        };
        drop(pool);
        let cancel = pre_spawn_lease.cancellation_token();
        self.diagnostics.preparing(cancel.clone());
        let task_cancel = cancel.clone();
        let pool = request.pool.clone();
        let status = request.status.clone();
        let tracker = request.tracker.clone();
        let budget = request.budget.clone();
        let operations = request.operations.clone();
        let envelope = request.envelope;
        let task = tokio::spawn(async move {
            let mut pre_spawn_lease = Some(pre_spawn_lease);
            let retired_exact = matches!(prepare_budget, GuardedPrepareBudget::Aged(_));
            let lease = match prepare_budget {
                GuardedPrepareBudget::Available(lease) => lease,
                GuardedPrepareBudget::Aged(candidate) => {
                    let started = async {
                        let mut retirement =
                            IdlePoolRetirement::new(candidate.clone(), &operations, envelope)?;
                        retirement.try_grant().await?;
                        let mut pool = pool.lock().await;
                        if cancel.is_cancelled() {
                            return Err(MemoryOperationError::Closed);
                        }
                        // Newly available ordinary capacity invalidates the
                        // old retirement decision. Defer with both owners intact
                        // rather than remove a now-unnecessary exact resource.
                        if (plan.max_idle == 0 || pool.len() < plan.max_idle)
                            && matches!(
                                budget
                                    .observe_reservation_with_headroom(
                                        plan.profile.vcpu,
                                        plan.profile.memory_mb,
                                        plan.headroom_vcpu,
                                        plan.headroom_memory_mb,
                                    )
                                    .0,
                                ReservationWithHeadroomStatus::Available
                            )
                        {
                            return Err(MemoryOperationError::ResourceChanged);
                        }
                        if pool.blank_len() >= plan.target
                            || !aged_candidate(&pool, &plan)?
                                .is_some_and(|current| current.same_insertion(&candidate))
                        {
                            return Err(MemoryOperationError::ResourceChanged);
                        }
                        let token = tracker.acceptance_token()?;
                        let started =
                            match retirement.start(&mut pool, "blank_pool_guarded_aged_exact") {
                                Ok(task) => task,
                                Err(failure) => {
                                    drop(pool);
                                    return Err(failure.into_error());
                                }
                            };
                        let task = tracker.adopt_activation_cleanup(
                            started,
                            token,
                            "blank_pool_guarded_aged_exact",
                        );
                        tracker.notify_reuse_state();
                        Ok((task, pool.status_snapshot()))
                    };
                    let (mut cleanup, snapshot) = tokio::select! {
                        biased;
                        _ = cancel.cancelled() => return failed("aged_admission_cancelled", None),
                        result = started => match result {
                            Ok(started) => started,
                            Err(error) => return failed("aged_admission", Some(error.to_string())),
                        },
                    };
                    // Cleanup is already adopted. A slow publication cannot
                    // retract it. Preemption releases CPU admission while the
                    // original full lease stays with required saving custody.
                    let publication = set_idle_status_snapshot(&status, snapshot);
                    tokio::pin!(publication);
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => {
                            drop(pre_spawn_lease.take());
                            let failure = match cleanup.join().await {
                                Ok(Ok(ActivationCleanupOutcome::Completed { .. })) => {
                                    match cleanup.take_completed_lease() {
                                        Ok(lease) => {
                                            drop(lease);
                                            failed("aged_cleanup_cancelled", None)
                                        }
                                        Err(error) => failed("aged_cleanup", Some(error.to_string())),
                                    }
                                }
                                Ok(Ok(ActivationCleanupOutcome::NoProgress(error))) => {
                                    failed("aged_cleanup_uncertain", Some(error))
                                }
                                Ok(Err(error)) => failed("aged_cleanup", Some(error.to_string())),
                                Err(error) => failed("aged_cleanup_producer", Some(error.to_string())),
                            };
                            publication.await;
                            return failure;
                        }
                        () = &mut publication => {},
                    }
                    let result = tokio::select! {
                        biased;
                        _ = cancel.cancelled() => {
                            drop(pre_spawn_lease.take()); cleanup.join().await
                        }
                        result = cleanup.join() => result,
                    };
                    match result {
                        Ok(Ok(ActivationCleanupOutcome::Completed { .. })) => {
                            let lease = match cleanup.take_completed_lease() {
                                Ok(lease) => lease,
                                Err(error) => {
                                    return failed("aged_cleanup", Some(error.to_string()));
                                }
                            };
                            if cancel.is_cancelled() {
                                drop(lease);
                                return failed("aged_cleanup_cancelled", None);
                            }
                            lease
                        }
                        Ok(Ok(ActivationCleanupOutcome::NoProgress(error))) => {
                            return failed("aged_cleanup_uncertain", Some(error));
                        }
                        Ok(Err(error)) => return failed("aged_cleanup", Some(error.to_string())),
                        Err(error) => {
                            return failed("aged_cleanup_producer", Some(error.to_string()));
                        }
                    }
                }
            };
            let Some(pre_spawn_lease) = pre_spawn_lease.take() else {
                return failed("preempted", None);
            };
            let result = prepare_blank_sandbox(
                BlankPrepareInput {
                    profile_name: plan.profile_name,
                    profile: plan.profile,
                    factory: plan.factory,
                    device_rate_limits: plan.device_rate_limits,
                    budget: BlankPrepareBudget::Available(lease),
                    pre_spawn_lease,
                },
                cancel,
            )
            .await;
            match result {
                BlankPrepareResult::Ready { candidate, .. } => BlankPrepareResult::Ready {
                    candidate,
                    retired_exact,
                },
                failed => failed,
            }
        });
        self.preparation = Some(BlankPreparation {
            task,
            cancel: task_cancel,
        });
    }

    /// The caller retains the incoming capsule across cancellation/refusal.
    /// Capture its backing outside inventory locks before calling this method.
    pub async fn finish_guarded_preparation(
        &mut self,
        incoming: &mut IdlePoolIncoming,
        request: GuardedBlankPoolRequest<'_>,
    ) -> Result<(), MemoryOperationError> {
        let Some(plan) = self.plan.as_ref() else {
            return Err(MemoryOperationError::Closed);
        };
        if request.mode != RunnerMode::Running {
            return Err(MemoryOperationError::Closed);
        }
        if !incoming.is_compatible_blank(
            &plan.profile_name,
            &plan.profile.rootfs_hash,
            &plan.device_rate_limits,
            plan.profile.vcpu,
            plan.profile.memory_mb,
        ) {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        // Bridge acceptance to the independently owned successful-lease release
        // observer before status can yield. Uncertain capsules stay retained.
        let completion_token = request.tracker.acceptance_token()?;
        let started = request
            .tracker
            .insert_pool_entry(
                request.pool,
                incoming,
                request.operations,
                request.envelope,
                "blank_pool_guarded_finish",
            )
            .await?;
        if let Some(mut retirement) = started.retirement {
            request.tracker.spawn_cleanup(
                async move {
                    let _token = completion_token;
                    if matches!(
                        retirement.join().await,
                        Ok(Ok(ActivationCleanupOutcome::Completed { .. }))
                    ) {
                        drop(retirement.take_completed_lease());
                    }
                },
                "blank_pool_guarded_finish_lease",
            );
        } else {
            drop(completion_token);
        }
        set_idle_status_snapshot(request.status, started.snapshot).await;
        self.diagnostics.ready();
        if let Some(plan) = &self.plan {
            self.attempt_requested = request.pool.lock().await.blank_len() < plan.target;
        }
        Ok(())
    }
}

pub(super) fn aged_candidate(
    pool: &IdlePool,
    plan: &BlankPoolPlan,
) -> Result<Option<IdleRetirementCandidate>, MemoryOperationError> {
    pool.aged_retirement_candidate(
        Instant::now(),
        EXACT_IDLE_CAPACITY_YIELD_AGE,
        &plan.profile_name,
        &plan.device_rate_limits,
        plan.profile.vcpu,
        plan.profile.memory_mb,
    )
}

fn failed(stage: &'static str, error: Option<String>) -> BlankPrepareResult {
    BlankPrepareResult::Failed(BlankPrepareFailure { stage, error })
}
