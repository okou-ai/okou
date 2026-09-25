//! Runner composition of a claimed finalizing successor's selected resource.
//!
//! `runner-supervisor::finalizing_admission` owns the predecessor wait, exact lookup,
//! handoff and fallback arbitration; this module owns claim completion, activation,
//! and executor handoff.
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
//! handoff acceptance remains open for `FINALIZING_HANDOFF_ACCEPTANCE_GRACE` after the later of
//! the producer's finalization start and this successor's wait start. A late successor therefore
//! has time to interrupt an ongoing park. An accepted handoff, including a candidate that was
//! already delivered, wins a deadline race. Cancellation is checked with priority; if a candidate
//! was delivered before the receiver was closed, the handoff request recovers it so the supervisor
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
use std::time::Instant;

use futures_util::FutureExt;
use tokio::task::JoinSet;
use tracing::info;

use super::factory_lifecycle::SharedFactory;
use super::job_discovery::{
    ReservedActivation, ReservedActivationRequest, activate_reserved_idle, build_spawn_job_request,
    claimed_activation_resources,
};
use super::job_spawn::{SpawnContext, run_job};
#[cfg(test)]
use super::{OuterJobPanicPoint, maybe_panic_outer_job};
use crate::executor::{
    ExecutionFailure, FinalizingDiagnostics, FinalizingHandoffOutcome, FinalizingHandoffReason,
    RunnerPreSpawnPhase, RunnerPreSpawnTiming, validate_resume_session_id,
};
use crate::resource_budget::BudgetLease;
use crate::telemetry::JobTelemetry;
use crate::workspace_image_cache::WorkspaceImagePrepareLockPolicy;
use runner_lifecycle::active_runs::ActiveRunReuseState;
use runner_provider::ClaimedJob;
use runner_provider::RunCancellationRegistration;
use runner_supervisor::claimed_activation::{
    ClaimedActivationGuard, ClaimedJobSetup, ReadyClaimedResource,
};
#[cfg(not(test))]
use runner_supervisor::finalizing_admission::select_finalizing_resource;
use runner_supervisor::finalizing_admission::{
    FinalizingAdmission, FinalizingResource, FinalizingSelectionRequest,
    FinalizingSelectionResources,
};
#[cfg(test)]
use runner_supervisor::finalizing_admission::{
    FinalizingSelectionTestHooks, select_finalizing_resource_with_test_hooks,
};
use runner_supervisor::idle_lifecycle::{ReservedIdleActivation, rollback_reserved_idle_for_spawn};
use runner_types::types::{CompleteRequest, SandboxReuseResult};

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
                rollback_reserved_idle_for_spawn(
                    reservation,
                    &ctx.idle_pool,
                    &ctx.status,
                    &ctx.reuse_state_notify,
                )
                .await;
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
                rollback_reserved_idle_for_spawn(
                    reservation,
                    &ctx.idle_pool,
                    &ctx.status,
                    &ctx.reuse_state_notify,
                )
                .await;
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
                rollback_reserved_idle_for_spawn(
                    reservation,
                    &ctx.idle_pool,
                    &ctx.status,
                    &ctx.reuse_state_notify,
                )
                .await;
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
        claimed_activation_resources(&ctx),
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
                .await
                .into_cancellation()
                .await;
        }
        Err(panic) => {
            activation
                .recover(
                    "activation_setup_panicked",
                    "claimed activation setup panicked".to_owned(),
                )
                .await
                .finish()
                .await;
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
    let selection = FinalizingSelectionRequest {
        run_id,
        cancellation,
        admission,
        profile_name,
        vcpu,
        memory_mb,
        device_rate_limits,
        resources: FinalizingSelectionResources {
            idle_pool: &ctx.idle_pool,
            status: &ctx.status,
            idle_destroy_tracker: &ctx.idle_destroy_tracker,
            budget: &ctx.budget,
            reuse_state_notify: &ctx.reuse_state_notify,
        },
    };
    #[cfg(test)]
    {
        let observer = ctx.test_observer.clone();
        select_finalizing_resource_with_test_hooks(
            selection,
            pre_spawn_timing,
            reserved_exact,
            FinalizingSelectionTestHooks {
                on_capacity_wait: Some(std::sync::Arc::new(move |run_id| {
                    observer.notify_finalizing_capacity_wait_entered(run_id);
                })),
            },
        )
        .await
    }
    #[cfg(not(test))]
    select_finalizing_resource(selection, pre_spawn_timing, reserved_exact).await
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
