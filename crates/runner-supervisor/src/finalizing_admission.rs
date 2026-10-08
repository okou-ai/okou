//! Finalizing-successor wait, handoff, and fallback resource arbitration.
//!
//! The Runner composition root owns the provider claim, activation, and executor task.
//! This module owns the selection policy before activation and returns its owned resource.
//!
//! A one-shot direct handoff races predecessor publication and cancellation. The preference
//! deadline bounds pre-finalization waiting; acceptance grace starts once finalization and
//! successor waiting have both begun. Accepted delivery wins a deadline race, while cancellation
//! recovers delivered candidates. Fallback checks the exact generation before and after pressure
//! selection and waits on both idle-pool revisions and budget availability without spending a
//! retiring lease twice. The caller retains the panic-boundary rollback of `reserved_exact`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use sandbox::DeviceRateLimits;
use tokio::sync::Notify;
use tracing::info;

use crate::idle_lifecycle::{
    IdleDestroyTracker, IdlePressureRequest, IdlePressureSelection, ReservedIdleActivation,
    SharedIdlePool, reserve_exact_idle_for_spawn, rollback_reserved_idle_for_spawn,
    select_idle_entries_for_pressure,
};
use runner_executor::executor::{
    ExecutionFailure, FinalizingExactIdleLookup, FinalizingHandoffOutcome, FinalizingHandoffReason,
    RunnerPreSpawnTiming,
};
use runner_lifecycle::active_runs::{
    ActiveRunHandoffRequest, ActiveRunReuseProof, ActiveRunReuseState,
};
use runner_lifecycle::idle_pool::{ExactIdleReservationMiss, FinalizingHandoffCandidate};
use runner_lifecycle::resource_budget::{BudgetLease, ResourceBudget};
use runner_lifecycle::status::StatusTracker;
use runner_lifecycle::workspace_image_cache::WorkspaceImagePrepareLockPolicy;
use runner_provider::RunCancellationRegistration;
use runner_types::ids::RunId;

/// Grace for an in-progress predecessor to accept a successor's handoff request.
pub const FINALIZING_HANDOFF_ACCEPTANCE_GRACE: Duration = Duration::from_millis(1500);

/// Exact-predecessor proof carried across the provider claim boundary.
pub struct FinalizingAdmission {
    pub predecessor: ActiveRunReuseProof,
    pub deadline: Instant,
    pub reuse_key: String,
    pub history_generation_run_id: RunId,
}

impl FinalizingAdmission {
    /// Read the live predecessor state when a fresh fallback is ready to start,
    /// not when its resource was first selected. Return the same snapshot for logging.
    pub fn fresh_fallback_workspace_prepare_lock_policy(
        &self,
    ) -> (ActiveRunReuseState, WorkspaceImagePrepareLockPolicy) {
        let state = self.predecessor.state();
        (
            state,
            workspace_prepare_lock_policy_for_fresh_fallback(state),
        )
    }
}

fn workspace_prepare_lock_policy_for_fresh_fallback(
    state: ActiveRunReuseState,
) -> WorkspaceImagePrepareLockPolicy {
    match state {
        ActiveRunReuseState::Pending
        | ActiveRunReuseState::ExactSandboxPublished
        | ActiveRunReuseState::ExactSandboxHandedOff => {
            WorkspaceImagePrepareLockPolicy::ImmediateFallback
        }
        ActiveRunReuseState::Finalizing { .. }
        | ActiveRunReuseState::NoExactSandbox
        | ActiveRunReuseState::Released => {
            WorkspaceImagePrepareLockPolicy::WaitForTransientContention
        }
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

enum FallbackExactLookup {
    Hit(ReservedIdleActivation),
    Miss(ExactIdleReservationMiss),
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
    run_id: RunId,
    cancellation: &'a RunCancellationRegistration,
    reuse_key: &'a str,
    history_generation_run_id: RunId,
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
#[cfg(feature = "test-support")]
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
            info!(run_id = %run_id, finalizing_fallback_reason = reason.as_str(), "finalizing successor entering workspace or cold fallback");
            acquire_fallback_resource(
                FinalizingFallback {
                    run_id,
                    cancellation,
                    reuse_key: &admission.reuse_key,
                    history_generation_run_id: admission.history_generation_run_id,
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

/// Wait for a direct predecessor handoff, a published exact reservation, or the fallback point.
///
/// The handoff request is one-shot and is created before observing the predecessor state so a
/// successor that was claimed early can race publication safely. The API preference deadline
/// bounds pre-finalization waiting. Acceptance grace starts when both finalization and this
/// successor's wait have begun, so a late request cannot arrive already expired. Only an
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
                    admission.history_generation_run_id,
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
            let exact_lookup = reserve_exact_idle_for_spawn(
                ctx.idle_pool,
                &admission.reuse_key,
                profile_name,
                device_rate_limits,
                admission.history_generation_run_id,
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
                    )
                    .await;
                    ctx.reuse_state_notify.notify_one();
                }
                return FinalizingWaitOutcome::cancelled(None);
            }
            if let Some(reservation) = reserved_exact.take() {
                info!(
                    run_id = %run_id,
                    predecessor_run_id = %admission.history_generation_run_id,
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

        let deadline = match state {
            ActiveRunReuseState::Pending => tokio::time::Instant::from_std(admission.deadline),
            ActiveRunReuseState::Finalizing { started_at } => {
                tokio::time::Instant::from_std(started_at).max(wait_started_at)
                    + FINALIZING_HANDOFF_ACCEPTANCE_GRACE
            }
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
                            admission.history_generation_run_id,
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
                            admission.history_generation_run_id,
                            cancellation,
                        )
                        .await;
                    }
                    return match state {
                        ActiveRunReuseState::Pending => FinalizingWaitOutcome::Fallback {
                            reason: FinalizingHandoffReason::PreFinalizationDeadline,
                            exact_lookup_miss: None,
                            handoff_outcome:
                                FinalizingHandoffOutcome::PreFinalizationDeadline,
                        },
                        ActiveRunReuseState::Finalizing { .. } => FinalizingWaitOutcome::Fallback {
                            reason: FinalizingHandoffReason::HandoffAcceptanceDeadline,
                            exact_lookup_miss: None,
                            handoff_outcome: FinalizingHandoffOutcome::NotAcceptedBeforeDeadline,
                        },
                        ActiveRunReuseState::ExactSandboxPublished
                        | ActiveRunReuseState::ExactSandboxHandedOff
                        | ActiveRunReuseState::NoExactSandbox
                        | ActiveRunReuseState::Released => continue,
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
                    return match state {
                        ActiveRunReuseState::Pending => FinalizingWaitOutcome::Fallback {
                            reason: FinalizingHandoffReason::PreFinalizationDeadline,
                            exact_lookup_miss: None,
                            handoff_outcome:
                                FinalizingHandoffOutcome::PreFinalizationDeadline,
                        },
                        ActiveRunReuseState::Finalizing { .. } => {
                            FinalizingWaitOutcome::no_exact(
                                FinalizingHandoffReason::HandoffRequestUnavailable,
                            )
                        }
                        ActiveRunReuseState::ExactSandboxPublished
                        | ActiveRunReuseState::ExactSandboxHandedOff
                        | ActiveRunReuseState::NoExactSandbox
                        | ActiveRunReuseState::Released => continue,
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
/// Each loop first reserves a matching exact idle entry, then tries retained retiring leases and
/// rechecks exact reuse before accepting fresh budget capacity. Idle entries selected for pressure
/// are either returned as exact reservations or converted into retiring leases; they are never
/// counted twice. When neither source can make progress, the loop waits for cancellation, budget
/// availability, or an idle-pool change and retries. A cancellation or other failure returns
/// without a resource so the outer claim path can complete the job and release retained leases.
async fn acquire_fallback_resource(
    request: FinalizingFallback<'_>,
    pre_spawn_timing: &mut RunnerPreSpawnTiming,
    #[cfg(any(test, feature = "test-support"))] test_hooks: &FinalizingSelectionTestHooks,
) -> Result<FinalizingResource, Box<ExecutionFailure>> {
    let FinalizingFallback {
        run_id,
        cancellation,
        reuse_key,
        history_generation_run_id,
        profile_name,
        vcpu,
        memory_mb,
        device_rate_limits,
        ctx,
    } = request;
    let mut idle_pool_changes = ctx.idle_pool.lock().await.subscribe_changes();
    let cancel = cancellation.token();
    let mut retiring_leases = Vec::new();
    loop {
        let (selection, blank_pool_selection) = select_idle_entries_for_pressure(
            ctx.idle_pool,
            ctx.status,
            ctx.idle_destroy_tracker,
            ctx.budget,
            std::mem::take(&mut retiring_leases),
            IdlePressureRequest {
                run_id,
                reuse_key: Some(reuse_key),
                profile_name,
                device_rate_limits,
                history_generation_run_id: Some(history_generation_run_id),
                allow_compatible_blank: false,
                blank_pool_diagnostics: None,
                vcpu,
                memory_mb,
                context: "finalizing_fallback_oldest",
            },
        )
        .await;
        debug_assert!(blank_pool_selection.is_none());
        match selection {
            IdlePressureSelection::Reusable(reservation) => {
                let reservation = accept_fallback_exact(cancellation, reservation, ctx).await?;
                pre_spawn_timing
                    .record_finalizing_exact_idle_lookup(FinalizingExactIdleLookup::Hit);
                return Ok(FinalizingResource::Exact(reservation));
            }
            IdlePressureSelection::Fresh(lease) => {
                match reserve_fallback_exact(
                    cancellation,
                    reuse_key,
                    profile_name,
                    device_rate_limits,
                    history_generation_run_id,
                    ctx,
                )
                .await?
                {
                    FallbackExactLookup::Hit(reservation) => {
                        drop(lease);
                        pre_spawn_timing
                            .record_finalizing_exact_idle_lookup(FinalizingExactIdleLookup::Hit);
                        return Ok(FinalizingResource::Exact(reservation));
                    }
                    FallbackExactLookup::Miss(miss) => {
                        pre_spawn_timing.record_finalizing_exact_idle_lookup(
                            FinalizingExactIdleLookup::Miss(miss),
                        );
                    }
                }
                return Ok(FinalizingResource::Fresh(lease));
            }
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
            ) => {
                match reserve_fallback_exact(
                    cancellation,
                    reuse_key,
                    profile_name,
                    device_rate_limits,
                    history_generation_run_id,
                    ctx,
                ).await? {
                    FallbackExactLookup::Hit(reservation) => {
                        drop(lease);
                        pre_spawn_timing
                            .record_finalizing_exact_idle_lookup(FinalizingExactIdleLookup::Hit);
                        return Ok(FinalizingResource::Exact(reservation));
                    }
                    FallbackExactLookup::Miss(miss) => {
                        pre_spawn_timing.record_finalizing_exact_idle_lookup(
                            FinalizingExactIdleLookup::Miss(miss),
                        );
                    }
                }
                return Ok(FinalizingResource::Fresh(lease));
            }
            _ = idle_pool_changes.changed() => {}
        }
    }
}

async fn reserve_fallback_exact(
    cancellation: &RunCancellationRegistration,
    reuse_key: &str,
    profile_name: &str,
    device_rate_limits: &Option<sandbox::DeviceRateLimits>,
    history_generation_run_id: RunId,
    ctx: FinalizingSelectionResources<'_>,
) -> Result<FallbackExactLookup, Box<ExecutionFailure>> {
    let reservation = match reserve_exact_idle_for_spawn(
        ctx.idle_pool,
        reuse_key,
        profile_name,
        device_rate_limits,
        history_generation_run_id,
    )
    .await
    {
        Ok(reservation) => reservation,
        Err(miss) => return Ok(FallbackExactLookup::Miss(miss)),
    };
    accept_fallback_exact(cancellation, reservation, ctx)
        .await
        .map(FallbackExactLookup::Hit)
}

async fn accept_fallback_exact(
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
        )
        .await;
        ctx.reuse_state_notify.notify_one();
        return Err(ExecutionFailure::cancelled().into());
    }
    Ok(reservation)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tokio::sync::Notify;

    use super::*;
    use runner_executor::executor::RunnerPreSpawnConcurrency;
    use runner_lifecycle::active_runs::{ActiveRunHandoffDeliveryResult, ActiveRuns};
    use runner_lifecycle::idle_pool::{
        IdlePool, IdlePoolConfig, test_support::ParkedIdleCandidateBuilder,
    };
    use runner_provider::RunCancellationRegistry;
    use sandbox_mock::{MockSandbox, MockSandboxFactory, MockSandboxOverrides};

    #[test]
    fn fresh_fallback_workspace_lock_policy_matches_predecessor_state() {
        let cases = [
            (
                ActiveRunReuseState::Pending,
                WorkspaceImagePrepareLockPolicy::ImmediateFallback,
            ),
            (
                ActiveRunReuseState::Finalizing {
                    started_at: Instant::now(),
                },
                WorkspaceImagePrepareLockPolicy::WaitForTransientContention,
            ),
            (
                ActiveRunReuseState::ExactSandboxPublished,
                WorkspaceImagePrepareLockPolicy::ImmediateFallback,
            ),
            (
                ActiveRunReuseState::ExactSandboxHandedOff,
                WorkspaceImagePrepareLockPolicy::ImmediateFallback,
            ),
            (
                ActiveRunReuseState::NoExactSandbox,
                WorkspaceImagePrepareLockPolicy::WaitForTransientContention,
            ),
            (
                ActiveRunReuseState::Released,
                WorkspaceImagePrepareLockPolicy::WaitForTransientContention,
            ),
        ];
        for (state, expected) in cases {
            assert_eq!(
                workspace_prepare_lock_policy_for_fresh_fallback(state),
                expected,
                "{state:?}"
            );
        }
    }

    #[test]
    fn fresh_fallback_workspace_lock_policy_reads_live_predecessor() {
        let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
        let predecessor_run_id = RunId::new_v4();
        let guard = active_runs.register(
            predecessor_run_id,
            Some("thread:finalizing-owner".into()),
            "vm0/default".into(),
        );
        let predecessor = active_runs
            .finalizing_predecessor(predecessor_run_id, "thread:finalizing-owner", "vm0/default")
            .expect("predecessor should be registered");
        let admission = FinalizingAdmission {
            predecessor,
            deadline: Instant::now(),
            reuse_key: "thread:finalizing-owner".into(),
            history_generation_run_id: predecessor_run_id,
        };
        assert_eq!(
            admission.fresh_fallback_workspace_prepare_lock_policy(),
            (
                ActiveRunReuseState::Pending,
                WorkspaceImagePrepareLockPolicy::ImmediateFallback
            )
        );
        let publisher = guard.reuse_publisher();
        let started_at = Instant::now();
        assert!(publisher.mark_finalizing(started_at));
        assert_eq!(
            admission.fresh_fallback_workspace_prepare_lock_policy(),
            (
                ActiveRunReuseState::Finalizing { started_at },
                WorkspaceImagePrepareLockPolicy::WaitForTransientContention,
            )
        );
        assert!(publisher.publish_exact_sandbox());
        assert_eq!(
            admission.fresh_fallback_workspace_prepare_lock_policy(),
            (
                ActiveRunReuseState::ExactSandboxPublished,
                WorkspaceImagePrepareLockPolicy::ImmediateFallback
            )
        );
        drop(guard);
        assert_eq!(
            admission.fresh_fallback_workspace_prepare_lock_policy(),
            (
                ActiveRunReuseState::Released,
                WorkspaceImagePrepareLockPolicy::WaitForTransientContention
            )
        );
    }

    fn released_admission() -> FinalizingAdmission {
        let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
        let predecessor_run_id = RunId::new_v4();
        let guard = active_runs.register(
            predecessor_run_id,
            Some("thread:finalizing-owner".into()),
            "vm0/default".into(),
        );
        let predecessor = active_runs
            .finalizing_predecessor(predecessor_run_id, "thread:finalizing-owner", "vm0/default")
            .expect("predecessor should be registered");
        drop(guard);
        assert_eq!(predecessor.state(), ActiveRunReuseState::Released);
        FinalizingAdmission {
            predecessor,
            deadline: Instant::now(),
            reuse_key: "thread:finalizing-owner".into(),
            history_generation_run_id: predecessor_run_id,
        }
    }

    #[tokio::test]
    async fn released_predecessor_selects_fresh_capacity_without_double_ownership() {
        let mut admission = released_admission();
        let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(
            IdlePoolConfig::default(),
        )));
        let budget = Arc::new(ResourceBudget::new(2, 2048, 1.0, 0));
        let dir = tempfile::tempdir().unwrap();
        let status = StatusTracker::new(dir.path().join("status.json"), 2, None, None);
        status.write_initial().await.unwrap();
        let notify = Arc::new(Notify::new());
        let destroy_tracker = IdleDestroyTracker::new(Arc::clone(&notify));
        let run_id = RunId::new_v4();
        let cancellation = RunCancellationRegistry::new()
            .register(run_id)
            .await
            .unwrap();
        let mut timing = RunnerPreSpawnTiming::start_at(
            Instant::now(),
            None,
            &RunnerPreSpawnConcurrency::default(),
        );
        let mut reserved_exact = None;
        let resource = select_finalizing_resource(
            FinalizingSelectionRequest {
                run_id,
                cancellation: &cancellation,
                admission: &mut admission,
                profile_name: "vm0/default",
                vcpu: 2,
                memory_mb: 2048,
                device_rate_limits: &None,
                resources: FinalizingSelectionResources {
                    idle_pool: &idle_pool,
                    status: &status,
                    idle_destroy_tracker: &destroy_tracker,
                    budget: &budget,
                    reuse_state_notify: &notify,
                },
            },
            &mut timing,
            &mut reserved_exact,
        )
        .await
        .unwrap();
        assert!(reserved_exact.is_none());
        let FinalizingResource::Fresh(lease) = resource else {
            panic!("released predecessor should use fresh capacity");
        };
        assert_eq!(budget.allocated(), (2, 2048, 1));
        assert_eq!(idle_pool.lock().await.len(), 0);
        drop(lease);
        assert_eq!(budget.allocated(), (0, 0, 0));
        cancellation.unregister().await;
    }

    #[tokio::test]
    async fn expired_pre_finalization_deadline_uses_fallback_without_releasing_predecessor() {
        let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
        let predecessor_run_id = RunId::new_v4();
        let guard = active_runs.register(
            predecessor_run_id,
            Some("thread:finalizing-owner".into()),
            "vm0/default".into(),
        );
        let predecessor = active_runs
            .finalizing_predecessor(predecessor_run_id, "thread:finalizing-owner", "vm0/default")
            .unwrap();
        let mut admission = FinalizingAdmission {
            predecessor,
            deadline: Instant::now() - Duration::from_secs(1),
            reuse_key: "thread:finalizing-owner".into(),
            history_generation_run_id: predecessor_run_id,
        };
        let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(
            IdlePoolConfig::default(),
        )));
        let budget = Arc::new(ResourceBudget::new(2, 2048, 1.0, 0));
        let dir = tempfile::tempdir().unwrap();
        let status = StatusTracker::new(dir.path().join("status.json"), 2, None, None);
        status.write_initial().await.unwrap();
        let notify = Arc::new(Notify::new());
        let destroy_tracker = IdleDestroyTracker::new(Arc::clone(&notify));
        let run_id = RunId::new_v4();
        let cancellation = RunCancellationRegistry::new()
            .register(run_id)
            .await
            .unwrap();
        let mut timing = RunnerPreSpawnTiming::start_at(
            Instant::now(),
            None,
            &RunnerPreSpawnConcurrency::default(),
        );
        let mut reserved_exact = None;
        let selected = select_finalizing_resource(
            FinalizingSelectionRequest {
                run_id,
                cancellation: &cancellation,
                admission: &mut admission,
                profile_name: "vm0/default",
                vcpu: 2,
                memory_mb: 2048,
                device_rate_limits: &None,
                resources: FinalizingSelectionResources {
                    idle_pool: &idle_pool,
                    status: &status,
                    idle_destroy_tracker: &destroy_tracker,
                    budget: &budget,
                    reuse_state_notify: &notify,
                },
            },
            &mut timing,
            &mut reserved_exact,
        )
        .await
        .unwrap();
        let FinalizingResource::Fresh(lease) = selected else {
            panic!("expired pending wait should use fallback capacity");
        };
        assert_eq!(admission.predecessor.state(), ActiveRunReuseState::Pending);
        assert!(reserved_exact.is_none());
        drop(lease);
        assert_eq!(budget.allocated(), (0, 0, 0));
        drop(guard);
        cancellation.unregister().await;
    }

    #[tokio::test]
    async fn cancelled_successor_does_not_reserve_fallback_capacity() {
        let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
        let predecessor_run_id = RunId::new_v4();
        let guard = active_runs.register(
            predecessor_run_id,
            Some("thread:finalizing-owner".into()),
            "vm0/default".into(),
        );
        let predecessor = active_runs
            .finalizing_predecessor(predecessor_run_id, "thread:finalizing-owner", "vm0/default")
            .unwrap();
        let mut admission = FinalizingAdmission {
            predecessor,
            deadline: Instant::now() + Duration::from_secs(60),
            reuse_key: "thread:finalizing-owner".into(),
            history_generation_run_id: predecessor_run_id,
        };
        let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(
            IdlePoolConfig::default(),
        )));
        let budget = Arc::new(ResourceBudget::new(2, 2048, 1.0, 0));
        let dir = tempfile::tempdir().unwrap();
        let status = StatusTracker::new(dir.path().join("status.json"), 2, None, None);
        status.write_initial().await.unwrap();
        let notify = Arc::new(Notify::new());
        let destroy_tracker = IdleDestroyTracker::new(Arc::clone(&notify));
        let run_id = RunId::new_v4();
        let cancellation = RunCancellationRegistry::new()
            .register(run_id)
            .await
            .unwrap();
        cancellation.handle().request_hard_cancellation().await;
        let mut timing = RunnerPreSpawnTiming::start_at(
            Instant::now(),
            None,
            &RunnerPreSpawnConcurrency::default(),
        );
        let mut reserved_exact = None;
        assert!(
            select_finalizing_resource(
                FinalizingSelectionRequest {
                    run_id,
                    cancellation: &cancellation,
                    admission: &mut admission,
                    profile_name: "vm0/default",
                    vcpu: 2,
                    memory_mb: 2048,
                    device_rate_limits: &None,
                    resources: FinalizingSelectionResources {
                        idle_pool: &idle_pool,
                        status: &status,
                        idle_destroy_tracker: &destroy_tracker,
                        budget: &budget,
                        reuse_state_notify: &notify,
                    },
                },
                &mut timing,
                &mut reserved_exact,
            )
            .await
            .is_err()
        );
        assert!(reserved_exact.is_none());
        assert_eq!(budget.allocated(), (0, 0, 0));
        assert_eq!(idle_pool.lock().await.len(), 0);
        drop(guard);
        cancellation.unregister().await;
    }

    #[tokio::test]
    async fn fallback_capacity_wait_wakes_when_budget_is_released() {
        let budget = Arc::new(ResourceBudget::new(2, 2048, 1.0, 0));
        let held = ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap();
        let entered = Arc::new(Notify::new());
        let budget_for_task = Arc::clone(&budget);
        let entered_for_task = Arc::clone(&entered);
        let task = tokio::spawn(async move {
            let mut admission = released_admission();
            let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(
                IdlePoolConfig::default(),
            )));
            let dir = tempfile::tempdir().unwrap();
            let status = StatusTracker::new(dir.path().join("status.json"), 2, None, None);
            status.write_initial().await.unwrap();
            let notify = Arc::new(Notify::new());
            let destroy_tracker = IdleDestroyTracker::new(Arc::clone(&notify));
            let run_id = RunId::new_v4();
            let cancellation = RunCancellationRegistry::new()
                .register(run_id)
                .await
                .unwrap();
            let mut timing = RunnerPreSpawnTiming::start_at(
                Instant::now(),
                None,
                &RunnerPreSpawnConcurrency::default(),
            );
            let mut reserved_exact = None;
            let selected = select_finalizing_resource_inner(
                FinalizingSelectionRequest {
                    run_id,
                    cancellation: &cancellation,
                    admission: &mut admission,
                    profile_name: "vm0/default",
                    vcpu: 2,
                    memory_mb: 2048,
                    device_rate_limits: &None,
                    resources: FinalizingSelectionResources {
                        idle_pool: &idle_pool,
                        status: &status,
                        idle_destroy_tracker: &destroy_tracker,
                        budget: &budget_for_task,
                        reuse_state_notify: &notify,
                    },
                },
                &mut timing,
                &mut reserved_exact,
                FinalizingSelectionTestHooks {
                    on_capacity_wait: Some(Arc::new(move |_| {
                        entered_for_task.notify_one();
                    })),
                },
            )
            .await
            .unwrap();
            assert!(reserved_exact.is_none());
            let FinalizingResource::Fresh(lease) = selected else {
                panic!("free capacity should be selected after wakeup");
            };
            drop(lease);
            cancellation.unregister().await;
        });
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .expect("selector should enter capacity wait");
        drop(held);
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("selector should wake with capacity")
            .unwrap();
        assert_eq!(budget.allocated(), (0, 0, 0));
    }

    fn delivered_handoff_request() -> (
        ActiveRunHandoffRequest,
        Arc<ResourceBudget>,
        Arc<MockSandboxOverrides>,
    ) {
        let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
        let predecessor_run_id = RunId::new_v4();
        let successor_run_id = RunId::new_v4();
        let guard = active_runs.register(
            predecessor_run_id,
            Some("thread:finalizing-wait-race".into()),
            "vm0/default".into(),
        );
        let publisher = guard.reuse_publisher();
        let proof = active_runs
            .finalizing_predecessor(
                predecessor_run_id,
                "thread:finalizing-wait-race",
                "vm0/default",
            )
            .expect("registered predecessor should remain finalizing");
        let request = proof
            .request_handoff(successor_run_id)
            .expect("exact successor should register a handoff");
        assert!(publisher.handoff_signal().accept_if_requested());

        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096)
            .expect("handoff candidate should reserve the test budget");
        let overrides = Arc::new(MockSandboxOverrides::new());
        let sandbox = Box::new(MockSandbox::with_overrides(
            "finalizing-wait-race",
            Arc::clone(&overrides),
        ));
        let factory = Arc::new(
            Box::new(MockSandboxFactory::with_overrides(Arc::clone(&overrides)))
                as Box<dyn sandbox::SandboxFactory>,
        );
        let candidate = ParkedIdleCandidateBuilder::new("thread:finalizing-wait-race", lease)
            .with_sandbox(sandbox)
            .with_factory(factory)
            .with_history_generation_run_id(predecessor_run_id)
            .build();
        assert!(matches!(
            publisher.deliver_exact_handoff(
                runner_lifecycle::idle_pool::IdleParkCandidate::Ordinary(candidate),
                predecessor_run_id,
            ),
            ActiveRunHandoffDeliveryResult::Delivered
        ));

        (request, budget, overrides)
    }

    #[tokio::test]
    async fn cancellation_before_acceptance_branch_recovers_delivered_handoff() {
        let (mut request, budget, overrides) = delivered_handoff_request();

        let candidate = match FinalizingWaitOutcome::cancelled(Some(&mut request)) {
            FinalizingWaitOutcome::Cancelled(Some(candidate)) => candidate,
            _ => panic!("cancellation should retain an already delivered handoff candidate"),
        };
        candidate.into_destroy_job().run().await;

        assert_eq!(overrides.destroy_call_count(), 1);
        assert_eq!(budget.allocated(), (0, 0, 0));
    }

    #[tokio::test]
    async fn deadline_race_prefers_an_already_delivered_handoff() {
        let (mut request, budget, overrides) = delivered_handoff_request();

        assert!(!request.expire_if_unaccepted());
        let candidate = request
            .receive()
            .await
            .expect("deadline should not discard a handoff that already won delivery");
        candidate.into_destroy_job().run().await;

        assert_eq!(overrides.destroy_call_count(), 1);
        assert_eq!(budget.allocated(), (0, 0, 0));
    }
}
