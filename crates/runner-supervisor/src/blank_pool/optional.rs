//! Supplied-policy ordinary/aged blank preparation with actual owner custody.

use runner_lifecycle::host_memory_operations::{MemoryOperationError, MemoryOperationPlan};
use runner_lifecycle::host_memory_pressure::{
    OptionalPressureControl, OptionalPressureOpportunity,
};
use runner_lifecycle::idle_pool::{
    ActivationCleanupOutcome, IdlePoolRetirement, IdleRetirementEnvelope,
};

use super::*;

mod retention;
pub use retention::{OptionalBlankResult, OptionalBlankSnapshot};
use retention::{Origin, Payload, Slot};
mod preparation;

pub struct OptionalBlankPoolRequest<'a> {
    pub mode: RunnerMode,
    pub pool: &'a SharedIdlePool,
    pub budget: &'a Arc<ResourceBudget>,
    pub admission: &'a PreSpawnAdmission,
    pub status: &'a Arc<StatusTracker>,
    pub tracker: &'a IdleDestroyTracker,
    pub pressure: &'a OptionalPressureControl,
    pub preparation_bytes: u64,
    pub envelope: IdleRetirementEnvelope,
}

struct Context {
    plan: BlankPoolPlan,
    pool: SharedIdlePool,
    budget: Arc<ResourceBudget>,
    status: Arc<StatusTracker>,
    tracker: IdleDestroyTracker,
    result: OptionalBlankResult,
    preparation_bytes: u64,
    opportunity: Arc<OptionalPressureOpportunity>,
    pre_spawn: Option<BackgroundPreSpawnAdmissionLease>,
    #[cfg(feature = "test-support")]
    pool_wait: Option<tokio::sync::watch::Sender<bool>>,
}

impl BlankPoolReplenisher {
    #[cfg(feature = "test-support")]
    /// Observe this owner's first actual pending pool acquisition, without gating it.
    pub fn observe_optional_pool_wait_for_test(
        &mut self,
    ) -> Result<tokio::sync::watch::Receiver<bool>, MemoryOperationError> {
        if self.optional.is_some() || self.optional_pool_wait.is_some() {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        let (sender, receiver) = tokio::sync::watch::channel(false);
        self.optional_pool_wait = Some(sender);
        Ok(receiver)
    }

    /// Admission and provider waits progress outside the caller's reactor turn.
    pub fn maybe_start_optional(
        &mut self,
        request: OptionalBlankPoolRequest<'_>,
    ) -> Result<bool, MemoryOperationError> {
        if request.mode != RunnerMode::Running {
            self.cancel_if_inactive(request.mode);
            return Ok(false);
        }
        if !self.attempt_requested || self.preparation.is_some() || self.optional.is_some() {
            return Ok(false);
        }
        if request.preparation_bytes == 0
            || request.envelope.live_growth_bytes == 0
            || request.envelope.tail_growth_bytes == 0
        {
            return Err(MemoryOperationError::UnsupportedGrowth);
        }
        let Some(plan) = self.plan.clone() else {
            return Ok(false);
        };
        if !std::sync::Weak::ptr_eq(&self.budget, &Arc::downgrade(request.budget)) {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        // Known inventory/logical refusal must not consume the shared cadence
        // and starve real optional reads. Contention still progresses off-turn;
        // this observation never substitutes for the later admission fences.
        if let Ok(pool) = request.pool.try_lock()
            && (pool.blank_len() >= plan.target
                || (!ordinary_capacity_available(&pool, request.budget, &plan)
                    && super::guarded::aged_candidate(&pool, &plan)?.is_none()))
        {
            return Ok(false);
        }
        if !request.pressure.decision().optional_start_ready {
            return Ok(false);
        }
        let pre_spawn = request
            .admission
            .try_acquire_background(plan.profile.vcpu)
            .map_err(|_| MemoryOperationError::TaskLimit)?;
        let Some(pre_spawn) = pre_spawn else {
            return Ok(false);
        };
        let token = request.tracker.acceptance_token()?;
        // A busy foreground gate must leave the shared opportunity available
        // to snapshot reads, which do not consume guest pre-spawn CPU.
        let Some(opportunity) = request.pressure.take_optional_start()? else {
            return Ok(false);
        };
        let cancel = pre_spawn.cancellation_token();
        let opportunity = Arc::new(opportunity);
        let result = OptionalBlankResult::new(
            request.pressure.clone(),
            request.envelope,
            cancel.clone(),
            opportunity.clone(),
            Origin::new(&request),
        );
        let mut retained = request
            .tracker
            .optional_blank_owners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        retained.retain(|owner| {
            let snapshot = owner.snapshot();
            !snapshot.finished || snapshot.retained_resource
        });
        retained.push(result.clone());
        drop(retained);
        let context = Context {
            plan,
            pool: request.pool.clone(),
            budget: request.budget.clone(),
            status: request.status.clone(),
            tracker: request.tracker.clone(),
            result: result.clone(),
            preparation_bytes: request.preparation_bytes,
            opportunity,
            pre_spawn: Some(pre_spawn),
            #[cfg(feature = "test-support")]
            pool_wait: self.optional_pool_wait.clone(),
        };
        self.attempt_requested = false;
        self.diagnostics.preparing(cancel);
        self.optional = Some(result.clone());
        request.tracker.spawn_cleanup(
            async move {
                let _accepted = token;
                let monitor_stop = CancellationToken::new();
                let stop_on_drop = monitor_stop.clone().drop_guard();
                let monitor = tokio::spawn(monitor(
                    context.result.clone(),
                    context.opportunity.clone(),
                    monitor_stop.clone(),
                ));
                let outcome = AssertUnwindSafe(run(context))
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|_| {
                        Err("optional blank producer panicked; original custody retained".into())
                    });
                result.finish(outcome);
                monitor_stop.cancel();
                let _ = monitor.await;
                drop(stop_on_drop);
            },
            "optional_blank_preparation",
        );
        Ok(true)
    }

    pub async fn wait_for_optional_preparation(&self) -> Option<OptionalBlankResult> {
        let result = self.optional.as_ref()?;
        result.wait().await;
        Some(result.clone())
    }

    pub async fn finish_optional_preparation(
        &mut self,
        result: &OptionalBlankResult,
        request: OptionalBlankPoolRequest<'_>,
    ) -> Result<(), MemoryOperationError> {
        if !result.snapshot().finished
            || !self
                .optional
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(&current.state, &result.state))
        {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        if !result.pressure.same_owner(request.pressure)
            || result.envelope != request.envelope
            || !result.origin.matches(&request)
        {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        let mut slot = result.slot()?;
        let current = request.mode == RunnerMode::Running
            && !result.cancel.is_cancelled()
            && result.opportunity.revalidate()?;
        if !current || result.snapshot().error.is_some() {
            retire_result(&mut slot, request.tracker).await?;
        } else if let Some(Payload::Incoming(incoming)) = slot.payload.as_mut() {
            incoming.validate_captured_backing()?;
            // Mandatory insertion owns replacement/rejection; cancellation of
            // this borrowed future restores the incoming capsule through Slot.
            let plan = self.plan.as_ref().ok_or(MemoryOperationError::Closed)?;
            let pool = request.pool.lock().await;
            let needed = pool.blank_len() < plan.target;
            drop(pool);
            if !needed
                || request.pressure.decision().state
                    != runner_lifecycle::host_memory_pressure::HostPressureState::Ready
            {
                retire_result(&mut slot, request.tracker).await?;
            } else {
                let operations = request.pressure.operations();
                let token = request.tracker.acceptance_token()?;
                let started = request
                    .tracker
                    .insert_pool_entry_checked(
                        request.pool,
                        incoming,
                        &operations,
                        request.envelope,
                        "optional_blank_publish",
                        |pool| {
                            if pool.blank_len() >= plan.target
                                || result.cancel.is_cancelled()
                                || !result.opportunity.revalidate()?
                            {
                                return Err(MemoryOperationError::ResourceChanged);
                            }
                            Ok(())
                        },
                    )
                    .await?;
                if let Some(mut cleanup) = started.retirement {
                    request.tracker.spawn_cleanup(
                        async move {
                            let _token = token;
                            if matches!(
                                cleanup.join().await,
                                Ok(Ok(ActivationCleanupOutcome::Completed { .. }))
                            ) {
                                drop(cleanup.take_completed_lease());
                            }
                        },
                        "optional_blank_replaced_or_rejected",
                    );
                } else {
                    drop(token);
                }
                slot.payload = None;
                // P3b returns success only after synchronous insertion;
                // every refusal returns an error with incoming custody intact.
                result.lock().snapshot.published = true;
                set_idle_status_snapshot(request.status, started.snapshot).await;
            }
        }
        if slot.payload.is_none() {
            self.optional = None;
            self.attempt_requested = true;
            self.diagnostics.ready();
        }
        Ok(())
    }

    pub async fn shutdown_optional(
        &mut self,
        tracker: &IdleDestroyTracker,
    ) -> Result<(), MemoryOperationError> {
        let Some(result) = self.optional.clone() else {
            return Ok(());
        };
        result.cancel();
        result.wait().await;
        let mut slot = result.slot()?;
        retire_result(&mut slot, tracker).await?;
        if slot.payload.is_none() {
            self.optional = None;
        }
        Ok(())
    }
}

impl Drop for BlankPoolReplenisher {
    fn drop(&mut self) {
        if let Some(result) = &self.optional {
            result.cancel();
        }
    }
}

impl OptionalBlankResult {
    /// Explicit reconciliation of a completed, recovered capsule. This retains
    /// its original authority/envelope and refuses concurrent borrowed owners.
    pub async fn retire(&self, tracker: &IdleDestroyTracker) -> Result<(), MemoryOperationError> {
        if !self.snapshot().finished {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        let mut slot = self.slot()?;
        retire_result(&mut slot, tracker).await
    }
}

async fn monitor(
    result: OptionalBlankResult,
    opportunity: Arc<OptionalPressureOpportunity>,
    stopped: CancellationToken,
) {
    let mut ticks = tokio::time::interval(
        result
            .pressure
            .policy()
            .max_sample_age
            .min(result.pressure.policy().optional_start_interval),
    );
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let changed = result.pressure.changed();
        tokio::pin!(changed);
        changed.as_mut().enable();
        if !opportunity.revalidate().unwrap_or(false) {
            result.cancel();
            return;
        }
        tokio::select! { () = stopped.cancelled() => return, () = result.cancel.cancelled() => return, _ = &mut changed => {}, _ = ticks.tick() => {} }
    }
}

async fn run(mut context: Context) -> Result<(), String> {
    let operations = context.result.pressure.operations();
    let pool = lock_optional_pool(
        &context.pool,
        &context.result.cancel,
        &mut context.pre_spawn,
        #[cfg(feature = "test-support")]
        context.pool_wait.as_ref(),
    )
    .await?;
    if pool.blank_len() >= context.plan.target || context.result.cancel.is_cancelled() {
        return Ok(());
    }
    let lease = if context.plan.max_idle == 0 || pool.len() < context.plan.max_idle {
        ResourceBudget::try_reserve_lease(
            &context.budget,
            context.plan.profile.vcpu,
            context.plan.profile.memory_mb,
        )
        .filter(|_| {
            context
                .budget
                .can_afford(context.plan.headroom_vcpu, context.plan.headroom_memory_mb)
        })
    } else {
        None
    };
    let aged = if lease.is_none() {
        super::guarded::aged_candidate(&pool, &context.plan).map_err(|e| e.to_string())?
    } else {
        None
    };
    drop(pool);
    if lease.is_none() && aged.is_none() {
        return Err("ordinary capacity and aged exact victim unavailable".into());
    }
    let grant = async {
        let mut request = operations.request(MemoryOperationPlan::Fresh {
            memory_mib: context.plan.profile.memory_mb,
            preparation_bytes: context.preparation_bytes,
        })?;
        let mut permit = request.try_grant().await?;
        permit.refresh().await?;
        Ok::<_, MemoryOperationError>(permit)
    };
    let mut permit = tokio::select! { biased; () = context.result.cancel.cancelled() => return Ok(()), grant = grant => grant.map_err(|e| e.to_string())? };
    if !context
        .opportunity
        .revalidate()
        .map_err(|e| e.to_string())?
    {
        return Err("original optional opportunity revoked".into());
    }
    let lease = if let Some(lease) = lease {
        let pool = lock_optional_pool(
            &context.pool,
            &context.result.cancel,
            &mut context.pre_spawn,
            #[cfg(feature = "test-support")]
            context.pool_wait.as_ref(),
        )
        .await?;
        if pool.blank_len() >= context.plan.target
            || (context.plan.max_idle > 0 && pool.len() >= context.plan.max_idle)
            || !context
                .budget
                .can_afford(context.plan.headroom_vcpu, context.plan.headroom_memory_mb)
            || context.result.cancel.is_cancelled()
            || !context
                .opportunity
                .revalidate()
                .map_err(|e| e.to_string())?
        {
            return Err("ordinary selection changed during admission".into());
        }
        drop(pool);
        lease
    } else {
        let candidate = aged.ok_or("aged candidate disappeared")?;
        let mut retirement =
            IdlePoolRetirement::new(candidate.clone(), &operations, context.result.envelope)
                .map_err(|e| e.to_string())?;
        tokio::select! { biased; () = context.result.cancel.cancelled() => return Ok(()), result = retirement.try_grant() => result.map_err(|e|e.to_string())? }
        let mut pool = lock_optional_pool(
            &context.pool,
            &context.result.cancel,
            &mut context.pre_spawn,
            #[cfg(feature = "test-support")]
            context.pool_wait.as_ref(),
        )
        .await?;
        let ordinary_available = ordinary_capacity_available(&pool, &context.budget, &context.plan);
        if ordinary_available
            || pool.blank_len() >= context.plan.target
            || context.result.cancel.is_cancelled()
            || !context
                .opportunity
                .revalidate()
                .map_err(|e| e.to_string())?
            || !super::guarded::aged_candidate(&pool, &context.plan)
                .map_err(|e| e.to_string())?
                .is_some_and(|current| current.same_insertion(&candidate))
        {
            return Err("aged selection changed during admission".into());
        }
        let token = context
            .tracker
            .acceptance_token()
            .map_err(|e| e.to_string())?;
        let accepted = retirement
            .start(&mut pool, "optional_blank_aged_exact")
            .map_err(|failure| failure.into_error().to_string())?;
        let snapshot = pool.status_snapshot();
        drop(pool);
        let mut task =
            context
                .tracker
                .adopt_activation_cleanup(accepted, token, "optional_blank_aged_exact");
        context.result.lock().snapshot.retired_exact = true;
        let publication = set_idle_status_snapshot(&context.status, snapshot);
        tokio::pin!(publication);
        tokio::select! { biased; () = context.result.cancel.cancelled() => { drop(context.pre_spawn.take()); publication.await; }, () = &mut publication => {} }
        let joined = tokio::select! { biased; () = context.result.cancel.cancelled() => { drop(context.pre_spawn.take()); task.join().await }, result = task.join() => result };
        match joined
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?
        {
            ActivationCleanupOutcome::Completed { .. } => {
                task.take_completed_lease().map_err(|e| e.to_string())?
            }
            ActivationCleanupOutcome::NoProgress(error) => return Err(error),
        }
    };
    if context.result.cancel.is_cancelled()
        || !context
            .opportunity
            .revalidate()
            .map_err(|e| e.to_string())?
    {
        return Ok(());
    }
    tokio::select! {
        biased;
        () = context.result.cancel.cancelled() => return Ok(()),
        refreshed = permit.refresh() => { refreshed.map_err(|e| e.to_string())?; },
    }
    if !context
        .opportunity
        .revalidate()
        .map_err(|e| e.to_string())?
    {
        return Ok(());
    }
    let observed = context.result.clone();
    let task = permit
        .spawn(
            move |operation| async move { preparation::prepare(context, operation, lease).await },
        )
        .map_err(|e| e.to_string())?;
    let result = task.join().await.map_err(|e| e.to_string())?;
    observed.lock().snapshot.prepared = result.is_ok();
    result
}

async fn retire_result(
    slot: &mut Slot,
    tracker: &IdleDestroyTracker,
) -> Result<(), MemoryOperationError> {
    let Some(payload) = slot.payload.take() else {
        return Ok(());
    };
    slot.payload = Some(match payload {
        Payload::Creating(hold) => {
            let _ = hold.physical.close();
            hold.physical.wait().await;
            drop(hold.take_operation());
            drop(hold.take_lease());
            return Ok(());
        }
        Payload::Preparing(resource) => match resource.into_required_cleanup() {
            Ok(owner) => Payload::Cleanup(Box::new(Some(owner))),
            Err((resource, error)) => {
                slot.payload = Some(Payload::Preparing(resource));
                return Err(error);
            }
        },
        Payload::Incoming(mut incoming) => match incoming.take_required_cleanup_owner() {
            Ok(owner) => Payload::Cleanup(Box::new(Some(owner))),
            Err(error) => {
                slot.payload = Some(Payload::Incoming(incoming));
                return Err(error);
            }
        },
        payload => payload,
    });
    let Some(Payload::Cleanup(owner)) = slot.payload.as_mut() else {
        return Err(MemoryOperationError::OwnershipInvariant);
    };
    let operations = slot.result.pressure.operations();
    let token = tracker.acceptance_token()?;
    let mut accepted = tracker
        .retire_activation_owner(
            owner,
            &operations,
            slot.result.envelope,
            "optional_blank_required_cleanup",
        )
        .await?;
    slot.payload = None;
    let (sent, received) = tokio::sync::oneshot::channel();
    tracker.spawn_cleanup(
        async move {
            let _token = token;
            if matches!(
                accepted.join().await,
                Ok(Ok(ActivationCleanupOutcome::Completed { .. }))
            ) {
                drop(accepted.take_completed_lease());
            }
            let _ = sent.send(());
        },
        "optional_blank_cleanup_completion",
    );
    received
        .await
        .map_err(|_| MemoryOperationError::ProducerLost)?;
    Ok(())
}

async fn lock_optional_pool<'a>(
    pool: &'a SharedIdlePool,
    cancel: &CancellationToken,
    cpu: &mut Option<BackgroundPreSpawnAdmissionLease>,
    #[cfg(feature = "test-support")] observer: Option<&tokio::sync::watch::Sender<bool>>,
) -> Result<tokio::sync::MutexGuard<'a, IdlePool>, String> {
    let locked = pool.lock();
    #[cfg(feature = "test-support")]
    let locked = {
        let mut locked = Box::pin(locked);
        std::future::poll_fn(move |cx| {
            let result = locked.as_mut().poll(cx);
            if result.is_pending()
                && let Some(observer) = observer
            {
                observer.send_replace(true);
            }
            result
        })
    };
    tokio::select! {
        biased;
        () = cancel.cancelled() => { drop(cpu.take()); Err("optional pool wait cancelled".into()) }
        locked = locked => Ok(locked),
    }
}

fn ordinary_capacity_available(
    pool: &IdlePool,
    budget: &ResourceBudget,
    plan: &BlankPoolPlan,
) -> bool {
    (plan.max_idle == 0 || pool.len() < plan.max_idle)
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
}
