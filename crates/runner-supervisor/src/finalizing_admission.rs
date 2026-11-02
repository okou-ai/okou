//! Finalizing-successor wait, handoff, and fallback resource arbitration.
//!
//! The Runner composition root owns the provider claim, activation, and executor task.
//! This module owns the selection policy before activation and returns its owned resource.
//!
//! A one-shot physical handoff races predecessor publication and cancellation. Generic sources
//! keep their API preference deadline. Native-matching sources use that deadline before
//! finalization, then acceptance grace once finalization and successor waiting have both begun.
//! Accepted delivery wins a deadline race, while cancellation recovers delivered candidates.
//! Fallback rechecks source-bound and compatible idle resources around pressure selection and
//! waits on idle-pool revisions and budget availability without spending a retiring lease twice.
//! The caller retains the panic-boundary rollback of `reserved_exact`.

mod guarded;
pub use guarded::{
    ActivatedGuardedFinalizing, GuardedFinalizingAdmission, GuardedFinalizingOffer,
    GuardedFinalizingOfferOutcome, GuardedFinalizingRecovery, RetainedFinalizingResource,
};

use std::sync::Arc;
use std::time::{Duration, Instant};

use sandbox::DeviceRateLimits;
use tokio::sync::Notify;
use tracing::info;

use crate::idle_lifecycle::{
    IdleDestroyTracker, IdlePressureOutcome, IdlePressureRequest, IdlePressureSelection,
    ReservedIdleActivation, SharedIdlePool, reserve_exact_idle_for_spawn,
    reserve_reusable_idle_for_spawn, reserve_source_idle_for_spawn,
    rollback_reserved_idle_for_spawn, select_idle_entries_for_pressure, set_idle_status_snapshot,
};
use runner_executor::executor::{
    ExecutionFailure, FinalizingExactIdleLookup, FinalizingHandoffOutcome, FinalizingHandoffReason,
    RunnerPreSpawnTiming,
};
use runner_lifecycle::active_runs::{
    ActiveRunHandoffRequest, ActiveRunReuseProof, ActiveRunReuseState,
};
use runner_lifecycle::home_image_cache::HomeImagePreparePolicy;
use runner_lifecycle::idle_pool::{ExactIdleReservationMiss, FinalizingHandoffCandidate};
use runner_lifecycle::resource_budget::{BudgetLease, ResourceBudget};
use runner_lifecycle::status::StatusTracker;
use runner_provider::RunCancellationRegistration;
use runner_types::ids::RunId;

/// Grace for an in-progress predecessor to accept a successor's handoff request.
pub const FINALIZING_HANDOFF_ACCEPTANCE_GRACE: Duration = Duration::from_millis(
    api_contracts::generated::constants::runners::RUNNER_FINALIZING_HANDOFF_ACCEPTANCE_GRACE_MS,
);

/// Local source proof carried across the provider claim boundary.
pub struct FinalizingAdmission {
    pub predecessor: ActiveRunReuseProof,
    pub deadline: Instant,
    pub reuse_key: String,
    pub source_run_id: RunId,
    /// Present only when the selected source is the actual native generation.
    pub native_generation_run_id: Option<RunId>,
}

impl FinalizingAdmission {
    /// Read the live predecessor state when a fresh fallback is ready to start,
    /// not when its resource was first selected. Return the same snapshot for logging.
    pub fn fresh_fallback_home_prepare_policy(
        &self,
    ) -> (ActiveRunReuseState, HomeImagePreparePolicy) {
        let state = self.predecessor.state();
        (state, home_prepare_lock_policy_for_fresh_fallback(state))
    }
}

fn home_prepare_lock_policy_for_fresh_fallback(
    state: ActiveRunReuseState,
) -> HomeImagePreparePolicy {
    match state {
        ActiveRunReuseState::Pending
        | ActiveRunReuseState::ExactSandboxPublished
        | ActiveRunReuseState::ExactSandboxHandedOff => {
            HomeImagePreparePolicy::TryCacheWithoutLockWait
        }
        ActiveRunReuseState::Finalizing { .. }
        | ActiveRunReuseState::NoExactSandbox
        | ActiveRunReuseState::Released => HomeImagePreparePolicy::TryCacheWithLockWait,
    }
}

/// Only the shared resources required to select a claimed finalizing successor's sandbox.
#[derive(Clone, Copy)]
pub struct FinalizingSelectionResources<'a> {
    pub idle_pool: &'a SharedIdlePool,
    pub status: &'a StatusTracker,
    pub idle_destroy_tracker: &'a IdleDestroyTracker,
    pub budget: &'a Arc<ResourceBudget>,
    pub reuse_state_notify: &'a Notify,
}

pub struct FinalizingSelectionRequest<'a> {
    pub run_id: RunId,
    pub cancellation: &'a RunCancellationRegistration,
    pub admission: &'a mut FinalizingAdmission,
    pub profile_name: &'a str,
    pub vcpu: u32,
    pub memory_mb: u32,
    pub device_rate_limits: &'a Option<DeviceRateLimits>,
    pub resources: FinalizingSelectionResources<'a>,
}

/// Pre-activation resource returned to Runner, which owns activation or completion.
pub enum FinalizingResource {
    Handoff(Box<FinalizingHandoffCandidate>),
    Exact(ReservedIdleActivation),
    Reusable(ReservedIdleActivation),
    Fresh(BudgetLease),
}

enum FinalizingWaitOutcome {
    Handoff(Box<FinalizingHandoffCandidate>),
    Exact(ReservedIdleActivation),
    Fallback {
        reason: FinalizingHandoffReason,
        exact_lookup_miss: Option<ExactIdleReservationMiss>,
        handoff_outcome: FinalizingHandoffOutcome,
    },
    Cancelled(Option<Box<FinalizingHandoffCandidate>>),
}

impl FinalizingWaitOutcome {
    fn no_exact(reason: FinalizingHandoffReason) -> Self {
        Self::Fallback {
            reason,
            exact_lookup_miss: None,
            handoff_outcome: FinalizingHandoffOutcome::NoExact,
        }
    }

    fn cancelled(request: Option<&mut ActiveRunHandoffRequest>) -> Self {
        Self::Cancelled(request.and_then(ActiveRunHandoffRequest::cancel_and_recover_delivery))
    }
}

enum FallbackIdleLookup {
    Hit(ReservedIdleActivation),
    Miss(Option<ExactIdleReservationMiss>),
}

struct FinalizingWait<'a> {
    run_id: RunId,
    cancellation: &'a RunCancellationRegistration,
    admission: &'a mut FinalizingAdmission,
    profile_name: &'a str,
    device_rate_limits: &'a Option<DeviceRateLimits>,
    ctx: FinalizingSelectionResources<'a>,
}

struct FinalizingFallback<'a> {
    source_run_id: RunId,
    run_id: RunId,
    cancellation: &'a RunCancellationRegistration,
    reuse_key: &'a str,
    native_generation_run_id: Option<RunId>,
    profile_name: &'a str,
    vcpu: u32,
    memory_mb: u32,
    device_rate_limits: &'a Option<DeviceRateLimits>,
    ctx: FinalizingSelectionResources<'a>,
}

/// Test-only wait checkpoint; not stored in a production request or context.
#[cfg(any(test, feature = "test-support"))]
#[derive(Clone, Default)]
pub struct FinalizingSelectionTestHooks {
    pub on_capacity_wait: Option<Arc<dyn Fn(RunId) + Send + Sync>>,
}

#[cfg(any(test, feature = "test-support"))]
impl FinalizingSelectionTestHooks {
    fn notify_capacity_wait(&self, run_id: RunId) {
        if let Some(callback) = &self.on_capacity_wait {
            callback(run_id);
        }
    }
}

/// Select the exact predecessor sandbox or wait for fallback capacity.
///
/// `reserved_exact` is an escape hatch for the Runner's outer panic boundary:
/// an exact reservation acquired before an unwind is rolled back by that caller.
pub async fn select_finalizing_resource(
    request: FinalizingSelectionRequest<'_>,
    pre_spawn_timing: &mut RunnerPreSpawnTiming,
    reserved_exact: &mut Option<ReservedIdleActivation>,
) -> Result<FinalizingResource, Box<ExecutionFailure>> {
    select_finalizing_resource_inner(
        request,
        pre_spawn_timing,
        reserved_exact,
        #[cfg(any(test, feature = "test-support"))]
        FinalizingSelectionTestHooks::default(),
    )
    .await
}

/// Observe the fallback capacity wait without changing production selection.
#[cfg(any(test, feature = "test-support"))]
pub async fn select_finalizing_resource_with_test_hooks(
    request: FinalizingSelectionRequest<'_>,
    pre_spawn_timing: &mut RunnerPreSpawnTiming,
    reserved_exact: &mut Option<ReservedIdleActivation>,
    test_hooks: FinalizingSelectionTestHooks,
) -> Result<FinalizingResource, Box<ExecutionFailure>> {
    select_finalizing_resource_inner(request, pre_spawn_timing, reserved_exact, test_hooks).await
}

async fn select_finalizing_resource_inner(
    request: FinalizingSelectionRequest<'_>,
    pre_spawn_timing: &mut RunnerPreSpawnTiming,
    reserved_exact: &mut Option<ReservedIdleActivation>,
    #[cfg(any(test, feature = "test-support"))] test_hooks: FinalizingSelectionTestHooks,
) -> Result<FinalizingResource, Box<ExecutionFailure>> {
    let FinalizingSelectionRequest {
        run_id,
        cancellation,
        admission,
        profile_name,
        vcpu,
        memory_mb,
        device_rate_limits,
        resources,
    } = request;
    match wait_for_finalizing_resource(
        FinalizingWait {
            run_id,
            cancellation,
            admission,
            profile_name,
            device_rate_limits,
            ctx: resources,
        },
        reserved_exact,
    )
    .await
    {
        FinalizingWaitOutcome::Handoff(candidate) => Ok(FinalizingResource::Handoff(candidate)),
        FinalizingWaitOutcome::Exact(reservation) => {
            pre_spawn_timing
                .record_finalizing_handoff_outcome(FinalizingHandoffOutcome::PublishedExact);
            pre_spawn_timing.record_finalizing_exact_idle_lookup(FinalizingExactIdleLookup::Hit);
            Ok(FinalizingResource::Exact(reservation))
        }
        FinalizingWaitOutcome::Fallback {
            reason,
            exact_lookup_miss,
            handoff_outcome,
        } => {
            pre_spawn_timing.record_finalizing_handoff(handoff_outcome, Some(reason));
            if let Some(miss) = exact_lookup_miss {
                pre_spawn_timing
                    .record_finalizing_exact_idle_lookup(FinalizingExactIdleLookup::Miss(miss));
            }
            info!(run_id = %run_id, finalizing_fallback_reason = reason.as_str(), "finalizing successor entering home or cold fallback");
            acquire_fallback_resource(
                FinalizingFallback {
                    source_run_id: admission.source_run_id,
                    run_id,
                    cancellation,
                    reuse_key: &admission.reuse_key,
                    native_generation_run_id: admission.native_generation_run_id,
                    profile_name,
                    vcpu,
                    memory_mb,
                    device_rate_limits,
                    ctx: resources,
                },
                pre_spawn_timing,
                #[cfg(any(test, feature = "test-support"))]
                &test_hooks,
            )
            .await
        }
        FinalizingWaitOutcome::Cancelled(candidate) => {
            if let Some(candidate) = candidate {
                candidate
                    .into_destroy_job()
                    .run_with_context("cancelled_finalizing_handoff")
                    .await;
                resources.reuse_state_notify.notify_one();
            }
            pre_spawn_timing.record_finalizing_handoff(
                FinalizingHandoffOutcome::Cancelled,
                Some(FinalizingHandoffReason::SuccessorCancelled),
            );
            Err(ExecutionFailure::cancelled().into())
        }
    }
}

/// Wait for a physical predecessor handoff, a published exact reservation, or fallback.
///
/// The handoff request is one-shot and is created before observing the predecessor state so a
/// successor that was claimed early can race publication safely. Generic sources retain their
/// original API preference deadline, including during finalization. A native-matching source
/// uses that deadline before finalization, then a separate acceptance grace starting when both
/// finalization and this successor's wait have begun. A late request cannot arrive expired. Only an
/// unaccepted request expires at either boundary, while an accepted handoff is still received.
/// A cancellation can recover a candidate already sent over the
/// request, and the caller owns destroying that candidate or rolling back an exact reservation
/// returned through `reserved_exact`.
async fn wait_for_finalizing_resource(
    request: FinalizingWait<'_>,
    reserved_exact: &mut Option<ReservedIdleActivation>,
) -> FinalizingWaitOutcome {
    let FinalizingWait {
        run_id,
        cancellation,
        admission,
        profile_name,
        device_rate_limits,
        ctx,
    } = request;
    let cancel = cancellation.token();
    let wait_started_at = tokio::time::Instant::now();
    let mut handoff = admission.predecessor.request_handoff(run_id);
    loop {
        if cancel.is_cancelled() {
            return FinalizingWaitOutcome::cancelled(handoff.as_mut());
        }
        let state = admission.predecessor.state();
        if !state.can_publish_exact()
            && let Some(request) = handoff.as_mut()
        {
            if request.accepted().await {
                return receive_finalizing_handoff(
                    request,
                    run_id,
                    admission.source_run_id,
                    cancellation,
                )
                .await;
            }
            handoff = None;
        }
        let missing_exact_reason = match state {
            ActiveRunReuseState::ExactSandboxPublished => {
                Some(FinalizingHandoffReason::PublishedExactUnavailable)
            }
            ActiveRunReuseState::ExactSandboxHandedOff => {
                return FinalizingWaitOutcome::no_exact(
                    FinalizingHandoffReason::ExactHandoffUnavailable,
                );
            }
            ActiveRunReuseState::Released => {
                Some(FinalizingHandoffReason::PredecessorReleasedWithoutExact)
            }
            ActiveRunReuseState::NoExactSandbox => {
                return FinalizingWaitOutcome::no_exact(
                    FinalizingHandoffReason::PredecessorNoExact,
                );
            }
            ActiveRunReuseState::Pending | ActiveRunReuseState::Finalizing { .. } => None,
        };
        if let Some(missing_exact_reason) = missing_exact_reason {
            let Some(native_generation_run_id) = admission.native_generation_run_id else {
                // A ready physical source is selected by the existing generic
                // fallback, without granting exact native-history authority.
                return FinalizingWaitOutcome::no_exact(missing_exact_reason);
            };
            let exact_lookup = reserve_exact_idle_for_spawn(
                ctx.idle_pool,
                &admission.reuse_key,
                profile_name,
                device_rate_limits,
                native_generation_run_id,
            )
            .await;
            let exact_lookup_miss = match exact_lookup {
                Ok(reservation) => {
                    *reserved_exact = Some(reservation);
                    None
                }
                Err(miss) => Some(miss),
            };
            if cancel.is_cancelled() {
                if let Some(reservation) = reserved_exact.take() {
                    rollback_reserved_idle_for_spawn(
                        reservation,
                        ctx.idle_pool,
                        ctx.status,
                        ctx.reuse_state_notify,
                        ctx.idle_destroy_tracker,
                    )
                    .await;
                    ctx.reuse_state_notify.notify_one();
                }
                return FinalizingWaitOutcome::cancelled(None);
            }
            if let Some(reservation) = reserved_exact.take() {
                info!(
                    run_id = %run_id,
                    predecessor_run_id = %admission.source_run_id,
                    "finalizing successor reserved exact published sandbox"
                );
                return FinalizingWaitOutcome::Exact(reservation);
            }
            return FinalizingWaitOutcome::Fallback {
                reason: missing_exact_reason,
                exact_lookup_miss,
                handoff_outcome: FinalizingHandoffOutcome::NoExact,
            };
        }

        let (deadline, timeout_reason, timeout_outcome) = match state {
            ActiveRunReuseState::Finalizing { started_at }
                if admission.native_generation_run_id.is_some() =>
            {
                (
                    tokio::time::Instant::from_std(started_at).max(wait_started_at)
                        + FINALIZING_HANDOFF_ACCEPTANCE_GRACE,
                    FinalizingHandoffReason::HandoffAcceptanceDeadline,
                    FinalizingHandoffOutcome::NotAcceptedBeforeDeadline,
                )
            }
            ActiveRunReuseState::Pending | ActiveRunReuseState::Finalizing { .. } => (
                tokio::time::Instant::from_std(admission.deadline),
                FinalizingHandoffReason::PreFinalizationDeadline,
                FinalizingHandoffOutcome::PreFinalizationDeadline,
            ),
            ActiveRunReuseState::ExactSandboxPublished
            | ActiveRunReuseState::ExactSandboxHandedOff
            | ActiveRunReuseState::NoExactSandbox
            | ActiveRunReuseState::Released => continue,
        };
        if let Some(request) = handoff.as_mut() {
            tokio::select! {
                biased;
                () = cancel.cancelled() => {
                    return FinalizingWaitOutcome::cancelled(Some(request));
                }
                accepted = request.accepted() => {
                    if accepted {
                        return receive_finalizing_handoff(
                            request,
                            run_id,
                            admission.source_run_id,
                            cancellation,
                        )
                        .await;
                    }
                    handoff = None;
                }
                _ = admission.predecessor.changed() => {}
                _ = tokio::time::sleep_until(deadline) => {
                    if admission.predecessor.state() != state {
                        continue;
                    }
                    if cancel.is_cancelled() {
                        return FinalizingWaitOutcome::cancelled(Some(request));
                    }
                    if !request.expire_if_unaccepted() {
                        return receive_finalizing_handoff(
                            request,
                            run_id,
                            admission.source_run_id,
                            cancellation,
                        )
                        .await;
                    }
                    return FinalizingWaitOutcome::Fallback {
                        reason: timeout_reason,
                        exact_lookup_miss: None,
                        handoff_outcome: timeout_outcome,
                    };
                }
            }
        } else {
            tokio::select! {
                biased;
                () = cancel.cancelled() => {
                    return FinalizingWaitOutcome::cancelled(None);
                }
                _ = admission.predecessor.changed() => {}
                _ = tokio::time::sleep_until(deadline) => {
                    if admission.predecessor.state() != state {
                        continue;
                    }
                    if matches!(state, ActiveRunReuseState::Finalizing { .. })
                        && admission.native_generation_run_id.is_some()
                    {
                        return FinalizingWaitOutcome::no_exact(
                            FinalizingHandoffReason::HandoffRequestUnavailable,
                        );
                    }
                    return FinalizingWaitOutcome::Fallback {
                        reason: timeout_reason,
                        exact_lookup_miss: None,
                        handoff_outcome: timeout_outcome,
                    };
                }
            }
        }
    }
}

/// Receive a delivered candidate while preserving ownership when cancellation races delivery.
///
/// The returned handoff candidate is not activated yet. If cancellation wins after the sender
/// has delivered it, this returns it as `Cancelled` so the caller destroys it; a successful return
/// transfers the candidate to the activation path for identity validation and reservation.
async fn receive_finalizing_handoff(
    request: &mut ActiveRunHandoffRequest,
    run_id: RunId,
    predecessor_run_id: RunId,
    cancellation: &RunCancellationRegistration,
) -> FinalizingWaitOutcome {
    let cancel = cancellation.token();
    let candidate = tokio::select! {
        biased;
        candidate = request.receive() => candidate,
        () = cancel.cancelled() => {
            return FinalizingWaitOutcome::cancelled(Some(request));
        }
    };
    let Ok(candidate) = candidate else {
        return FinalizingWaitOutcome::no_exact(FinalizingHandoffReason::ExactHandoffClosed);
    };
    if cancel.is_cancelled() {
        return FinalizingWaitOutcome::Cancelled(Some(candidate));
    }
    info!(
        run_id = %run_id,
        predecessor_run_id = %predecessor_run_id,
        "finalizing successor received direct sandbox handoff"
    );
    FinalizingWaitOutcome::Handoff(candidate)
}

/// Acquire capacity after the predecessor can no longer provide an exact direct handoff.
///
/// Each loop first reserves a matching idle entry, then tries retained retiring leases and
/// rechecks exact or generic reuse before accepting fresh budget capacity. Idle entries selected
/// for pressure are either returned as reuse reservations or converted into retiring leases;
/// they are never counted twice. When neither source can make progress, the loop waits for cancellation, budget
/// availability, or an idle-pool change and retries. A cancellation or other failure returns
/// without a resource so the outer claim path can complete the job and release retained leases.
async fn acquire_fallback_resource(
    request: FinalizingFallback<'_>,
    pre_spawn_timing: &mut RunnerPreSpawnTiming,
    #[cfg(any(test, feature = "test-support"))] test_hooks: &FinalizingSelectionTestHooks,
) -> Result<FinalizingResource, Box<ExecutionFailure>> {
    let FinalizingFallback {
        source_run_id,
        run_id,
        cancellation,
        reuse_key,
        native_generation_run_id,
        profile_name,
        vcpu,
        memory_mb,
        device_rate_limits,
        ctx,
    } = request;
    let mut idle_pool_changes = ctx.idle_pool.lock().await.subscribe_changes();
    let cancel = cancellation.token();
    let mut retiring_leases = Vec::new();
    let lease = loop {
        if let Ok(reservation) = reserve_source_idle_for_spawn(
            ctx.idle_pool,
            reuse_key,
            profile_name,
            device_rate_limits,
            source_run_id,
        )
        .await
        {
            let reservation = accept_fallback_idle(cancellation, reservation, ctx).await?;
            return Ok(fallback_idle_resource(
                reservation,
                native_generation_run_id,
                pre_spawn_timing,
            ));
        }
        let IdlePressureOutcome {
            selection,
            blank_pool_selection,
            idle_snapshot,
        } = select_idle_entries_for_pressure(
            ctx.idle_pool,
            ctx.idle_destroy_tracker,
            ctx.budget,
            std::mem::take(&mut retiring_leases),
            IdlePressureRequest {
                run_id,
                reuse_key: Some(reuse_key),
                profile_name,
                device_rate_limits,
                // Exact and generic publication share the reuse-key slot. A
                // generic predecessor must be reserved before pressure eviction.
                allow_compatible_blank: false,
                blank_pool_diagnostics: None,
                vcpu,
                memory_mb,
                context: "finalizing_fallback_oldest",
            },
        )
        .await;
        if let Some(snapshot) = idle_snapshot {
            set_idle_status_snapshot(ctx.status, snapshot).await;
        }
        debug_assert!(blank_pool_selection.is_none());
        match selection {
            IdlePressureSelection::Reusable(reservation) => {
                let reservation = accept_fallback_idle(cancellation, reservation, ctx).await?;
                return Ok(fallback_idle_resource(
                    reservation,
                    native_generation_run_id,
                    pre_spawn_timing,
                ));
            }
            IdlePressureSelection::Fresh(lease) => break lease,
            IdlePressureSelection::Exhausted(retained) => retiring_leases = retained,
        }

        info!(run_id = %run_id, "finalizing fallback waiting for fresh capacity");
        #[cfg(any(test, feature = "test-support"))]
        test_hooks.notify_capacity_wait(run_id);
        tokio::select! {
            biased;
            () = cancel.cancelled() => {
                return Err(ExecutionFailure::cancelled().into());
            }
            lease = ResourceBudget::substitute_leases_when_available(
                ctx.budget,
                &mut retiring_leases,
                vcpu,
                memory_mb,
            ) => break lease,
            _ = idle_pool_changes.changed() => {}
        }
    };

    match reserve_fallback_idle(
        cancellation,
        reuse_key,
        profile_name,
        device_rate_limits,
        native_generation_run_id,
        ctx,
    )
    .await?
    {
        FallbackIdleLookup::Hit(reservation) => {
            drop(lease);
            Ok(fallback_idle_resource(
                reservation,
                native_generation_run_id,
                pre_spawn_timing,
            ))
        }
        FallbackIdleLookup::Miss(miss) => {
            if let Some(miss) = miss {
                pre_spawn_timing
                    .record_finalizing_exact_idle_lookup(FinalizingExactIdleLookup::Miss(miss));
            }
            Ok(FinalizingResource::Fresh(lease))
        }
    }
}

fn fallback_idle_resource(
    reservation: ReservedIdleActivation,
    native_generation_run_id: Option<RunId>,
    pre_spawn_timing: &mut RunnerPreSpawnTiming,
) -> FinalizingResource {
    if let Some(native_generation_run_id) = native_generation_run_id {
        if reservation.native_generation_run_id() == Some(native_generation_run_id)
            && reservation.source_run_id() == Some(native_generation_run_id)
        {
            pre_spawn_timing.record_finalizing_exact_idle_lookup(FinalizingExactIdleLookup::Hit);
            return FinalizingResource::Exact(reservation);
        }
        pre_spawn_timing.record_finalizing_exact_idle_lookup(FinalizingExactIdleLookup::Miss(
            if reservation.source_run_id() == Some(native_generation_run_id) {
                ExactIdleReservationMiss::NativeGenerationMismatch
            } else {
                ExactIdleReservationMiss::SourceMismatch
            },
        ));
    }
    FinalizingResource::Reusable(reservation)
}

async fn reserve_fallback_idle(
    cancellation: &RunCancellationRegistration,
    reuse_key: &str,
    profile_name: &str,
    device_rate_limits: &Option<sandbox::DeviceRateLimits>,
    native_generation_run_id: Option<RunId>,
    ctx: FinalizingSelectionResources<'_>,
) -> Result<FallbackIdleLookup, Box<ExecutionFailure>> {
    let miss = if let Some(generation) = native_generation_run_id {
        match reserve_exact_idle_for_spawn(
            ctx.idle_pool,
            reuse_key,
            profile_name,
            device_rate_limits,
            generation,
        )
        .await
        {
            Ok(reservation) => {
                return accept_fallback_idle(cancellation, reservation, ctx)
                    .await
                    .map(FallbackIdleLookup::Hit);
            }
            Err(miss) => Some(miss),
        }
    } else {
        None
    };
    let Some(reservation) =
        reserve_reusable_idle_for_spawn(ctx.idle_pool, reuse_key, profile_name, device_rate_limits)
            .await
    else {
        return Ok(FallbackIdleLookup::Miss(miss));
    };
    accept_fallback_idle(cancellation, reservation, ctx)
        .await
        .map(FallbackIdleLookup::Hit)
}

async fn accept_fallback_idle(
    cancellation: &RunCancellationRegistration,
    reservation: ReservedIdleActivation,
    ctx: FinalizingSelectionResources<'_>,
) -> Result<ReservedIdleActivation, Box<ExecutionFailure>> {
    if cancellation.token().is_cancelled() {
        rollback_reserved_idle_for_spawn(
            reservation,
            ctx.idle_pool,
            ctx.status,
            ctx.reuse_state_notify,
            ctx.idle_destroy_tracker,
        )
        .await;
        ctx.reuse_state_notify.notify_one();
        return Err(ExecutionFailure::cancelled().into());
    }
    Ok(reservation)
}

#[cfg(test)]
mod tests;
