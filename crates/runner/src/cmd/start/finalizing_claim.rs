//! A claimed finalizing successor waits for the exact sandbox its predecessor may publish.
//!
//! A finalizing successor is claimed before the predecessor has finished finalizing and is
//! allowed to wait for a direct handoff without reserving fresh capacity. The predecessor's
//! `ActiveRunReuseState` drives the wait:
//!
//! - `Pending` means that execution or other pre-finalization work is still in progress.
//! - `Finalizing { started_at }` means that sandbox finalization is active and publication or
//!   handoff is possible.
//! - `ExactSandboxPublished` means that the successor may reserve the exact idle entry.
//! - `ExactSandboxHandedOff` means that the exact entry was handed off. A live request for this
//!   successor receives its candidate before fallback; otherwise the successor uses fallback
//!   resources.
//! - `NoExactSandbox` and `Released` mean that no exact predecessor resource will be published,
//!   so the successor must use fallback resources.
//!
//! The successor requests one direct handoff while the predecessor can still publish exact
//! reuse. Pre-finalization waiting ends at the API preference deadline. Once finalization begins,
//! handoff acceptance remains open until the producer's finalization start plus
//! `FINALIZING_HANDOFF_ACCEPTANCE_GRACE`. An accepted handoff, including a candidate that was
//! already delivered, wins a deadline race. Cancellation is checked with priority; if a candidate
//! was delivered before the receiver was closed, the handoff request recovers it so this module
//! can destroy it rather than lose ownership.
//!
//! Every exact resource is reserved for the claimed successor's reuse key, profile, device
//! limits, and history-generation run ID. A handed-off candidate is checked against the
//! successor and history-generation identities before activation. Reserved candidates are
//! rolled back on cancellation, while identity mismatches, activation failures, preparation
//! errors, and panics destroy or recover the candidate through the activation guards before the
//! claimed job is completed without a sandbox. Finalizing handoff outcomes are recorded even
//! when there is no executor to emit ordinary job telemetry.
//!
//! When no direct or published exact resource is available, fallback first retries matching idle
//! exact reuse, then consumes retiring idle capacity, and finally uses fresh budget capacity. A
//! fresh fallback still attempts workspace-cache checkout, but skips its transient-contention
//! retry when the predecessor state proves that a live or transferred sandbox retains the entry.
//! Retiring leases are retained while the loop waits for capacity. The wait observes both budget
//! availability and idle-pool changes: either can make the next exact or fresh-resource attempt
//! viable, while cancellation exits through the same no-sandbox completion path. The admission
//! timing and ownership contract is exercised by `tests/main_loop/admission.rs`, including
//! `pre_finalization_wait_ends_at_preference_deadline`,
//! `finalizing_handoff_grace_starts_when_predecessor_enters_finalization`,
//! `finalizing_immediate_handoff_reuses_matching_sandbox_past_preference_deadline`, and
//! `competing_finalizing_successors_reserve_exact_generation_once`. The no-executor and
//! activation-failure telemetry paths are covered by `tests/main_loop/telemetry.rs`, including
//! `cancelled_finalizing_handoff_flushes_outcome_without_executor`,
//! `finalizing_handoff_activation_failure_is_not_reported_as_accepted`, and
//! `published_exact_activation_failure_is_reported_as_activation_failed`.

use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use futures_util::FutureExt;
use tokio::task::JoinSet;
use tracing::info;

use super::active_runs::{ActiveRunHandoffRequest, ActiveRunReuseState};
use super::factory_lifecycle::SharedFactory;
use super::idle_lifecycle::{
    IdlePressureRequest, IdlePressureSelection, ReservedIdleActivation,
    select_idle_entries_for_pressure,
};
use super::job_discovery::{
    ClaimedActivationGuard, ClaimedJobSetup, FinalizingAdmission, ReadyClaimedResource,
    ReservedActivation, ReservedActivationRequest, activate_reserved_idle, build_spawn_job_request,
    reserve_exact_idle_for_spawn, rollback_reserved_idle_for_spawn,
};
use super::job_spawn::{SpawnContext, run_job};
#[cfg(test)]
use super::{OuterJobPanicPoint, maybe_panic_outer_job};
use crate::executor::{
    ExecutionFailure, FinalizingDiagnostics, FinalizingExactIdleLookup, FinalizingHandoffOutcome,
    FinalizingHandoffReason, RunnerPreSpawnPhase, RunnerPreSpawnTiming, validate_resume_session_id,
};
use crate::idle_pool::{ExactIdleReservationMiss, FinalizingHandoffCandidate};
use crate::ids::RunId;
use crate::provider::ClaimedJob;
use crate::resource_budget::{BudgetLease, ResourceBudget};
use crate::run_cancellation::RunCancellationRegistration;
use crate::telemetry::JobTelemetry;
use crate::types::{CompleteRequest, SandboxReuseResult};
use crate::workspace_image_cache::WorkspaceImagePrepareLockPolicy;

pub(super) const FINALIZING_HANDOFF_ACCEPTANCE_GRACE: Duration = Duration::from_millis(1500);

pub(super) struct FinalizingClaimRequest {
    pub(super) claimed: ClaimedJob,
    pub(super) cancellation: RunCancellationRegistration,
    pub(super) admission: FinalizingAdmission,
    pub(super) claim_returned_at: Instant,
    pub(super) profile_name: String,
    pub(super) vcpu: u32,
    pub(super) memory_mb: u32,
    pub(super) workspace_disk_mb: u32,
    pub(super) restore_guest_state: bool,
    pub(super) device_rate_limits: Option<sandbox::DeviceRateLimits>,
    pub(super) factory: SharedFactory,
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

enum FinalizingResource {
    Handoff(Box<FinalizingHandoffCandidate>),
    Exact(ReservedIdleActivation),
    Fresh(BudgetLease),
}

enum FinalizingActivationOrigin {
    IdlePool,
    DirectHandoff,
}

/// Acquired capacity after origin-specific identity checks and snapshot capture.
enum FinalizingActivation {
    Reserved {
        reservation: ReservedIdleActivation,
        origin: FinalizingActivationOrigin,
    },
    Fresh(BudgetLease),
}

enum FallbackExactLookup {
    Hit(ReservedIdleActivation),
    Miss(ExactIdleReservationMiss),
}

struct FinalizingPreparation<'a> {
    claimed: &'a ClaimedJob,
    cancellation: &'a RunCancellationRegistration,
    admission: &'a mut FinalizingAdmission,
    profile_name: &'a str,
    vcpu: u32,
    memory_mb: u32,
    device_rate_limits: &'a Option<sandbox::DeviceRateLimits>,
    pre_spawn_timing: &'a mut RunnerPreSpawnTiming,
    ctx: &'a SpawnContext,
}

struct FinalizingWait<'a> {
    run_id: RunId,
    cancellation: &'a RunCancellationRegistration,
    admission: &'a mut FinalizingAdmission,
    profile_name: &'a str,
    device_rate_limits: &'a Option<sandbox::DeviceRateLimits>,
    ctx: &'a SpawnContext,
}

struct FinalizingFallback<'a> {
    run_id: RunId,
    cancellation: &'a RunCancellationRegistration,
    reuse_key: &'a str,
    history_generation_run_id: RunId,
    profile_name: &'a str,
    vcpu: u32,
    memory_mb: u32,
    device_rate_limits: &'a Option<sandbox::DeviceRateLimits>,
    ctx: &'a SpawnContext,
}

pub(super) fn spawn_finalizing_claim(
    request: FinalizingClaimRequest,
    ctx: &SpawnContext,
    jobs: &mut JoinSet<RunCancellationRegistration>,
) {
    jobs.spawn(run_finalizing_claim(request, ctx.clone()));
}

async fn run_finalizing_claim(
    request: FinalizingClaimRequest,
    ctx: SpawnContext,
) -> RunCancellationRegistration {
    let FinalizingClaimRequest {
        claimed,
        cancellation,
        mut admission,
        claim_returned_at,
        profile_name,
        vcpu,
        memory_mb,
        workspace_disk_mb,
        restore_guest_state,
        device_rate_limits,
        factory,
    } = request;
    let run_id = claimed.context().run_id;
    let mut pre_spawn_timing = RunnerPreSpawnTiming::start_at(
        claim_returned_at,
        claimed.api_claim_timing(),
        &ctx.pre_spawn_concurrency,
    );
    pre_spawn_timing.mark_task_enqueued();
    let started_at = Instant::now();
    let mut reserved_exact = None;
    let preparation = AssertUnwindSafe(prepare_finalizing_resource(
        FinalizingPreparation {
            claimed: &claimed,
            cancellation: &cancellation,
            admission: &mut admission,
            profile_name: &profile_name,
            vcpu,
            memory_mb,
            device_rate_limits: &device_rate_limits,
            pre_spawn_timing: &mut pre_spawn_timing,
            ctx: &ctx,
        },
        &mut reserved_exact,
    ))
    .catch_unwind()
    .await;
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::FinalizingWait, started_at);

    let resource = match preparation {
        Ok(Ok(resource)) => resource,
        Ok(Err(failure)) => {
            if let Some(reservation) = reserved_exact.take() {
                rollback_reserved_idle_for_spawn(reservation, &ctx).await;
            }
            return complete_claimed_without_sandbox(
                claimed,
                cancellation,
                *failure,
                None,
                pre_spawn_timing.finalizing_diagnostics(),
                &ctx,
            )
            .await;
        }
        Err(payload) => {
            if let Some(reservation) = reserved_exact.take() {
                rollback_reserved_idle_for_spawn(reservation, &ctx).await;
            }
            let cancellation = complete_claimed_without_sandbox(
                claimed,
                cancellation,
                ExecutionFailure::from_error(
                    "runner panicked while preparing a claimed finalizing successor",
                ),
                None,
                pre_spawn_timing.finalizing_diagnostics(),
                &ctx,
            )
            .await;
            cancellation.unregister().await;
            std::panic::resume_unwind(payload);
        }
    };

    let fresh_fallback = matches!(&resource, FinalizingResource::Fresh(_));
    let active_run_guard = ctx.active_runs.register(
        run_id,
        claimed.context().reuse_key().map(str::to_owned),
        profile_name.clone(),
    );
    let activation = match resource {
        FinalizingResource::Fresh(lease) => FinalizingActivation::Fresh(lease),
        FinalizingResource::Exact(reservation) => FinalizingActivation::Reserved {
            reservation,
            origin: FinalizingActivationOrigin::IdlePool,
        },
        FinalizingResource::Handoff(candidate) => {
            let reservation =
                match candidate.into_reservation(run_id, admission.history_generation_run_id) {
                    Ok(reservation) => reservation,
                    Err(candidate) => {
                        drop(active_run_guard);
                        candidate
                            .into_destroy_job()
                            .run_with_context("finalizing_handoff_identity_mismatch")
                            .await;
                        ctx.reuse_state_notify.notify_one();
                        pre_spawn_timing.record_finalizing_handoff(
                            FinalizingHandoffOutcome::ActivationFailed,
                            Some(FinalizingHandoffReason::HandoffIdentityMismatch),
                        );
                        return complete_claimed_without_sandbox(
                            claimed,
                            cancellation,
                            ExecutionFailure::from_error(
                                "finalizing handoff identity did not match claimed successor",
                            ),
                            None,
                            pre_spawn_timing.finalizing_diagnostics(),
                            &ctx,
                        )
                        .await;
                    }
                };
            let idle_snapshot = ctx.idle_pool.lock().await.status_snapshot();
            FinalizingActivation::Reserved {
                reservation: ReservedIdleActivation::new(reservation, idle_snapshot),
                origin: FinalizingActivationOrigin::DirectHandoff,
            }
        }
    };
    let cancellation_handle = cancellation.handle();
    let mut activation_transfer_guard = None;
    let ready = match activation {
        FinalizingActivation::Fresh(active_lease) => ReadyClaimedResource {
            reuse_entry: None,
            active_lease,
            reuse_result: SandboxReuseResult::PoolMiss,
            idle_snapshot: None,
        },
        FinalizingActivation::Reserved {
            reservation,
            origin,
        } => {
            let transfer_guard = cancellation_handle.transfer_guard().await;
            if cancellation_handle.is_cancelled() {
                drop(transfer_guard);
                drop(active_run_guard);
                rollback_reserved_idle_for_spawn(reservation, &ctx).await;
                pre_spawn_timing.record_finalizing_handoff(
                    FinalizingHandoffOutcome::ActivationFailed,
                    Some(FinalizingHandoffReason::ActivationCancelled),
                );
                return complete_claimed_without_sandbox(
                    claimed,
                    cancellation,
                    ExecutionFailure::cancelled(),
                    None,
                    pre_spawn_timing.finalizing_diagnostics(),
                    &ctx,
                )
                .await;
            }
            activation_transfer_guard = Some(transfer_guard);
            match activate_reserved_idle(
                reservation,
                ReservedActivationRequest {
                    run_id,
                    profile_name: &profile_name,
                    device_rate_limits: &device_rate_limits,
                    workspace_disk_mb,
                    context: claimed.context(),
                },
                &ctx,
                &mut pre_spawn_timing,
            )
            .await
            {
                ReservedActivation::Ready {
                    reuse_entry,
                    active_lease,
                    reuse_result,
                    idle_snapshot,
                } => {
                    if reuse_entry.is_none() {
                        pre_spawn_timing.record_finalizing_handoff(
                            FinalizingHandoffOutcome::ActivationFailed,
                            Some(FinalizingHandoffReason::ExactActivationFallback),
                        );
                    } else if matches!(origin, FinalizingActivationOrigin::DirectHandoff) {
                        pre_spawn_timing
                            .record_finalizing_handoff_outcome(FinalizingHandoffOutcome::Accepted);
                    }
                    ReadyClaimedResource {
                        reuse_entry: reuse_entry.map(|entry| *entry),
                        active_lease,
                        reuse_result,
                        idle_snapshot: Some(idle_snapshot),
                    }
                }
                ReservedActivation::CannotStart {
                    budget_lease,
                    reuse_result,
                    error,
                } => {
                    drop(activation_transfer_guard.take());
                    drop(active_run_guard);
                    pre_spawn_timing.record_finalizing_handoff(
                        FinalizingHandoffOutcome::ActivationFailed,
                        Some(FinalizingHandoffReason::ExactActivationFailed),
                    );
                    let cancellation = complete_claimed_without_sandbox(
                        claimed,
                        cancellation,
                        ExecutionFailure::from_error(error),
                        Some(reuse_result),
                        pre_spawn_timing.finalizing_diagnostics(),
                        &ctx,
                    )
                    .await;
                    drop(budget_lease);
                    return cancellation;
                }
            }
        }
    };
    let mut activation = ClaimedActivationGuard::new(
        ClaimedJobSetup {
            claimed,
            cancellation,
            profile_name,
            vcpu,
            memory_mb,
            workspace_disk_mb,
            restore_guest_state,
            device_rate_limits,
            factory,
            resource: ready,
            pre_spawn_timing,
            active_run_guard,
        },
        &ctx,
    );
    let mut request = match AssertUnwindSafe(build_spawn_job_request(&mut activation, &ctx))
        .catch_unwind()
        .await
    {
        Ok(Ok(request)) => request,
        Ok(Err(error)) => {
            return activation
                .recover(
                    "active_status_persistence_failed",
                    format!("persist active runner ownership: {error}"),
                )
                .await;
        }
        Err(panic) => {
            let cancellation = activation
                .recover(
                    "activation_setup_panicked",
                    "claimed activation setup panicked".to_owned(),
                )
                .await;
            cancellation.unregister().await;
            std::panic::resume_unwind(panic);
        }
    };
    drop(activation_transfer_guard);
    let predecessor_state = admission.predecessor.state();
    if fresh_fallback
        && matches!(
            predecessor_state,
            ActiveRunReuseState::Pending
                | ActiveRunReuseState::ExactSandboxPublished
                | ActiveRunReuseState::ExactSandboxHandedOff
        )
    {
        request.job_profile.workspace_image_prepare_lock_policy =
            WorkspaceImagePrepareLockPolicy::ImmediateFallback;
        info!(
            run_id = %run_id,
            ?predecessor_state,
            "finalizing fallback will skip workspace cache lock retry"
        );
    }
    run_job(request, ctx).await
}

async fn prepare_finalizing_resource(
    request: FinalizingPreparation<'_>,
    reserved_exact: &mut Option<ReservedIdleActivation>,
) -> Result<FinalizingResource, Box<ExecutionFailure>> {
    let FinalizingPreparation {
        claimed,
        cancellation,
        admission,
        profile_name,
        vcpu,
        memory_mb,
        device_rate_limits,
        pre_spawn_timing,
        ctx,
    } = request;
    let run_id = claimed.context().run_id;
    #[cfg(test)]
    maybe_panic_outer_job(
        ctx.outer_job_panic,
        OuterJobPanicPoint::ClaimedWithoutSandbox,
        run_id,
    );
    if let Err(error) = validate_resume_session_id(claimed.context()) {
        return Err(ExecutionFailure::from_error(error).into());
    }

    info!(
        run_id = %run_id,
        predecessor_run_id = %admission.history_generation_run_id,
        "finalizing successor claimed before sandbox publication"
    );
    match wait_for_finalizing_resource(
        FinalizingWait {
            run_id,
            cancellation,
            admission,
            profile_name,
            device_rate_limits,
            ctx,
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
            info!(
                run_id = %run_id,
                finalizing_fallback_reason = reason.as_str(),
                "finalizing successor entering workspace or cold fallback"
            );
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
                    ctx,
                },
                pre_spawn_timing,
            )
            .await
        }
        FinalizingWaitOutcome::Cancelled(candidate) => {
            if let Some(candidate) = candidate {
                candidate
                    .into_destroy_job()
                    .run_with_context("cancelled_finalizing_handoff")
                    .await;
                ctx.reuse_state_notify.notify_one();
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
/// bounds pre-finalization waiting; the producer's finalization start bounds the subsequent
/// acceptance grace. Only an unaccepted request expires at either boundary, while an accepted
/// handoff is still received. A cancellation can recover a candidate already sent over the
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
                &admission.reuse_key,
                profile_name,
                device_rate_limits,
                admission.history_generation_run_id,
                ctx,
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
                    rollback_reserved_idle_for_spawn(reservation, ctx).await;
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

        let deadline = tokio::time::Instant::from_std(match state {
            ActiveRunReuseState::Pending => admission.deadline,
            ActiveRunReuseState::Finalizing { started_at } => {
                started_at + FINALIZING_HANDOFF_ACCEPTANCE_GRACE
            }
            ActiveRunReuseState::ExactSandboxPublished
            | ActiveRunReuseState::ExactSandboxHandedOff
            | ActiveRunReuseState::NoExactSandbox
            | ActiveRunReuseState::Released => continue,
        });
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
        "finalizing successor received direct parked sandbox handoff"
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
        match select_idle_entries_for_pressure(
            &ctx.idle_pool,
            &ctx.status,
            &ctx.idle_destroy_tracker,
            &ctx.budget,
            std::mem::take(&mut retiring_leases),
            IdlePressureRequest {
                run_id,
                reuse_key: Some(reuse_key),
                profile_name,
                device_rate_limits,
                history_generation_run_id: Some(history_generation_run_id),
                allow_compatible_blank: false,
                vcpu,
                memory_mb,
                context: "finalizing_fallback_oldest",
            },
        )
        .await
        {
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
        #[cfg(test)]
        ctx.test_observer
            .notify_finalizing_capacity_wait_entered(run_id);
        tokio::select! {
            biased;
            () = cancel.cancelled() => {
                return Err(ExecutionFailure::cancelled().into());
            }
            lease = ResourceBudget::substitute_leases_when_available(
                &ctx.budget,
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
    ctx: &SpawnContext,
) -> Result<FallbackExactLookup, Box<ExecutionFailure>> {
    let reservation = match reserve_exact_idle_for_spawn(
        reuse_key,
        profile_name,
        device_rate_limits,
        history_generation_run_id,
        ctx,
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
    ctx: &SpawnContext,
) -> Result<ReservedIdleActivation, Box<ExecutionFailure>> {
    if cancellation.token().is_cancelled() {
        rollback_reserved_idle_for_spawn(reservation, ctx).await;
        ctx.reuse_state_notify.notify_one();
        return Err(ExecutionFailure::cancelled().into());
    }
    Ok(reservation)
}

/// Complete a claimed finalizing successor without activating a sandbox.
///
/// This path is used for cancellation, preparation and activation failures, identity mismatches,
/// and recovered panics after their resource cleanup has run. It always completes with no sandbox
/// and flushes the supplied finalizing handoff outcome directly because no executor is running to
/// emit that telemetry.
async fn complete_claimed_without_sandbox(
    claimed: ClaimedJob,
    cancellation: RunCancellationRegistration,
    failure: ExecutionFailure,
    reuse_result: Option<SandboxReuseResult>,
    diagnostics: Option<FinalizingDiagnostics>,
    ctx: &SpawnContext,
) -> RunCancellationRegistration {
    let (context, completion_auth, active_input_source) = claimed.into_parts();
    drop(active_input_source);
    let telemetry = diagnostics.map(|diagnostics| {
        let mut telemetry = JobTelemetry::new(
            ctx.exec_config.http.clone(),
            context.run_id,
            context.sandbox_token.clone(),
            ctx.exec_config.runner_hostname.clone(),
        );
        diagnostics.record(&mut telemetry);
        telemetry
    });
    ctx.provider
        .complete(
            CompleteRequest {
                run_id: context.run_id,
                exit_code: failure.exit_code,
                failure_reason: None,
                error: Some(failure.error),
                sandbox_id: None,
                sandbox_reuse_result: reuse_result,
                workspace_reuse_result: None,
                active_input_delivery_ids: Vec::new(),
            },
            completion_auth,
        )
        .await;
    if let Some(telemetry) = telemetry {
        telemetry.flush().await;
    }
    cancellation
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tokio::sync::Notify;

    use super::super::active_runs::{ActiveRunHandoffDeliveryResult, ActiveRuns};
    use super::*;
    use crate::idle_pool::test_support::ParkedIdleCandidateBuilder;
    use crate::resource_budget::ResourceBudget;
    use sandbox_mock::{MockSandbox, MockSandboxFactory, MockSandboxOverrides};

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
            publisher.deliver_exact_handoff(candidate, predecessor_run_id),
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
