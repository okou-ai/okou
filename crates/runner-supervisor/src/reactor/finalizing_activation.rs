//! Complete-input continuation activation and executor handoff.
//!
//! Local predecessor proof selects a bounded handoff or a source-fenced fallback
//! through `finalizing_admission`. This task owns accepted input and cancellation
//! while waiting, preserves delivered resources across cancellation, and validates
//! physical source identity before activation. The existing activation guard owns
//! status publication, executor dispatch and panic recovery.
//!
//! Accepted handoff wins a deadline race; cancellation wins before activation.
//! Preparation/activation failures complete the original Run without a sandbox,
//! flushing execution diagnostics after resource recovery. Blank or fresh fallback checks
//! the producer's home identity under its cache entry lock and uses the live
//! predecessor state to avoid waiting for a home still held by another sandbox.
//! Actual HTTP regressions live in `tests/main_loop/direct_dispatch/continuation`;
//! selection and guarded physical ownership have their own owner tests.

use std::panic::AssertUnwindSafe;
use std::time::Instant;

use futures_util::FutureExt;
use tokio::task::JoinSet;
use tracing::info;

use super::job_activation::{
    activation_resources, build_spawn_job_request, job_activation_resources,
};
use super::job_spawn::{JobResult, SpawnContext, run_job};
#[cfg(test)]
use super::{OuterJobPanicPoint, maybe_panic_outer_job};
use crate::SharedFactory;
use crate::activation::{JobActivationGuard, JobActivationSetup, ReadyExecutionResource};
use crate::executor::{
    ExecutionFailure, FinalizingDiagnostics, FinalizingHandoffOutcome, FinalizingHandoffReason,
    RunnerPreSpawnPhase, RunnerPreSpawnTiming, validate_resume_session_id,
};
#[cfg(not(test))]
use crate::finalizing_admission::select_finalizing_resource;
use crate::finalizing_admission::{
    FinalizingAdmission, FinalizingResource, FinalizingSelectionRequest,
    FinalizingSelectionResources,
};
#[cfg(test)]
use crate::finalizing_admission::{
    FinalizingSelectionTestHooks, select_finalizing_resource_with_test_hooks,
};
use crate::home_image_cache::HomeImagePreparePolicy;
use crate::idle_lifecycle::{ReservedIdleActivation, rollback_reserved_idle_for_spawn};
use crate::idle_pool::IdleSandboxKind;
use crate::resource_activation::{
    ReservedActivation, ReservedActivationRequest, activate_reserved_idle,
};
use crate::resource_budget::BudgetLease;
use crate::telemetry::JobTelemetry;
use runner_provider::ExecutionJob;
use runner_provider::RunCancellationRegistration;
use runner_types::types::{CompleteRequest, SandboxReuseResult};

pub(super) struct FinalizingActivationRequest {
    pub(super) job: ExecutionJob,
    pub(super) cancellation: RunCancellationRegistration,
    pub(super) admission: FinalizingAdmission,
    pub(super) admitted_at: Instant,
    pub(super) profile_name: String,
    pub(super) rootfs_hash: String,
    pub(super) vcpu: u32,
    pub(super) memory_mb: u32,
    pub(super) home_disk_mb: u32,
    pub(super) restore_guest_state: bool,
    pub(super) device_rate_limits: Option<sandbox::DeviceRateLimits>,
    pub(super) factory: SharedFactory,
}

enum FinalizingActivationOrigin {
    IdlePool,
    GenericIdlePool,
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
    job: &'a ExecutionJob,
    cancellation: &'a RunCancellationRegistration,
    admission: &'a mut FinalizingAdmission,
    profile_name: &'a str,
    vcpu: u32,
    memory_mb: u32,
    device_rate_limits: &'a Option<sandbox::DeviceRateLimits>,
    pre_spawn_timing: &'a mut RunnerPreSpawnTiming,
    ctx: &'a SpawnContext,
}

pub(super) fn spawn_finalizing_activation(
    request: FinalizingActivationRequest,
    ctx: &SpawnContext,
    jobs: &mut JoinSet<JobResult>,
) {
    jobs.spawn(run_finalizing_activation(request, ctx.clone()));
}

async fn run_finalizing_activation(
    request: FinalizingActivationRequest,
    ctx: SpawnContext,
) -> JobResult {
    let FinalizingActivationRequest {
        job,
        cancellation,
        mut admission,
        admitted_at,
        profile_name,
        rootfs_hash,
        vcpu,
        memory_mb,
        home_disk_mb,
        restore_guest_state,
        device_rate_limits,
        factory,
    } = request;
    let run_id = job.context().run_id;
    let mut pre_spawn_timing =
        RunnerPreSpawnTiming::start_at(admitted_at, &ctx.pre_spawn_concurrency);
    pre_spawn_timing.mark_task_enqueued();
    let started_at = Instant::now();
    let mut reserved_exact = None;
    let preparation = AssertUnwindSafe(prepare_finalizing_resource(
        FinalizingPreparation {
            job: &job,
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
                    &ctx.idle_destroy_tracker,
                )
                .await;
            }
            return Ok(complete_without_sandbox(
                job,
                cancellation,
                *failure,
                pre_spawn_timing.finalizing_diagnostics(),
                &ctx,
            )
            .await);
        }
        Err(payload) => {
            if let Some(reservation) = reserved_exact.take() {
                rollback_reserved_idle_for_spawn(
                    reservation,
                    &ctx.idle_pool,
                    &ctx.status,
                    &ctx.reuse_state_notify,
                    &ctx.idle_destroy_tracker,
                )
                .await;
            }
            let cancellation = complete_without_sandbox(
                job,
                cancellation,
                ExecutionFailure::from_error(
                    "runner panicked while preparing a job finalizing successor",
                ),
                pre_spawn_timing.finalizing_diagnostics(),
                &ctx,
            )
            .await;
            cancellation.unregister().await;
            std::panic::resume_unwind(payload);
        }
    };

    let active_run_guard = ctx.active_runs.register(
        run_id,
        job.context().reuse_key().map(str::to_owned),
        profile_name.clone(),
    );
    let activation = match resource {
        FinalizingResource::Fresh(lease) => FinalizingActivation::Fresh(lease),
        FinalizingResource::Exact(reservation) => FinalizingActivation::Reserved {
            reservation,
            origin: FinalizingActivationOrigin::IdlePool,
        },
        FinalizingResource::Reusable(reservation) => FinalizingActivation::Reserved {
            reservation,
            origin: FinalizingActivationOrigin::GenericIdlePool,
        },
        FinalizingResource::Handoff(candidate) => {
            let reservation = match candidate.into_reservation(run_id, admission.source_run_id) {
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
                    return Ok(complete_without_sandbox(
                        job,
                        cancellation,
                        ExecutionFailure::from_error(
                            "finalizing handoff identity did not match job successor",
                        ),
                        pre_spawn_timing.finalizing_diagnostics(),
                        &ctx,
                    )
                    .await);
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
    let mut selected_home_source_run_id = None;
    let ready = match activation {
        FinalizingActivation::Fresh(active_lease) => ReadyExecutionResource {
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
                    &ctx.idle_destroy_tracker,
                )
                .await;
                pre_spawn_timing.record_finalizing_handoff(
                    FinalizingHandoffOutcome::ActivationFailed,
                    Some(FinalizingHandoffReason::ActivationCancelled),
                );
                return Ok(complete_without_sandbox(
                    job,
                    cancellation,
                    ExecutionFailure::cancelled(),
                    pre_spawn_timing.finalizing_diagnostics(),
                    &ctx,
                )
                .await);
            }
            activation_transfer_guard = Some(transfer_guard);
            selected_home_source_run_id = (reservation.kind() == IdleSandboxKind::Blank
                && ctx.home_cache_snapshot.has_source_home_hint(
                    &admission.reuse_key,
                    &profile_name,
                    admission.source_run_id,
                ))
            .then_some(admission.source_run_id);
            match activate_reserved_idle(
                reservation,
                ReservedActivationRequest {
                    run_id,
                    required_home_source_run_id: selected_home_source_run_id,
                    profile_name: &profile_name,
                    device_rate_limits: &device_rate_limits,
                    home_disk_mb,
                    rootfs_hash: &rootfs_hash,
                    context: job.context(),
                },
                &activation_resources(&ctx),
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
                    if reuse_entry.is_none()
                        && !matches!(origin, FinalizingActivationOrigin::GenericIdlePool)
                    {
                        pre_spawn_timing.record_finalizing_handoff(
                            FinalizingHandoffOutcome::ActivationFailed,
                            Some(FinalizingHandoffReason::ExactActivationFallback),
                        );
                    } else if matches!(origin, FinalizingActivationOrigin::DirectHandoff) {
                        pre_spawn_timing
                            .record_finalizing_handoff_outcome(FinalizingHandoffOutcome::Accepted);
                    }
                    ReadyExecutionResource {
                        reuse_entry: reuse_entry.map(|entry| *entry),
                        active_lease,
                        reuse_result,
                        idle_snapshot: Some(idle_snapshot),
                    }
                }
                ReservedActivation::CannotStart {
                    budget_lease,
                    reuse_result: _,
                    error,
                } => {
                    drop(activation_transfer_guard.take());
                    drop(active_run_guard);
                    if !matches!(origin, FinalizingActivationOrigin::GenericIdlePool) {
                        pre_spawn_timing.record_finalizing_handoff(
                            FinalizingHandoffOutcome::ActivationFailed,
                            Some(FinalizingHandoffReason::ExactActivationFailed),
                        );
                    }
                    let cancellation = complete_without_sandbox(
                        job,
                        cancellation,
                        ExecutionFailure::from_error(error),
                        pre_spawn_timing.finalizing_diagnostics(),
                        &ctx,
                    )
                    .await;
                    drop(budget_lease);
                    return Ok(cancellation);
                }
            }
        }
    };
    let home_fallback = ready
        .reuse_entry
        .as_ref()
        .is_none_or(|entry| entry.kind() == IdleSandboxKind::Blank);
    // Inventory can change while unpark awaits. Keep a source already selected
    // before activation; checkout revalidates it under the cache entry lock.
    let required_home_source_run_id = if home_fallback {
        selected_home_source_run_id.or_else(|| {
            ctx.home_cache_snapshot
                .has_source_home_hint(&admission.reuse_key, &profile_name, admission.source_run_id)
                .then_some(admission.source_run_id)
        })
    } else {
        None
    };
    let mut activation = JobActivationGuard::new(
        JobActivationSetup {
            required_home_source_run_id,
            job,
            rootfs_hash,
            cancellation,
            profile_name,
            vcpu,
            memory_mb,
            home_disk_mb,
            restore_guest_state,
            device_rate_limits,
            factory,
            resource: ready,
            pre_spawn_timing,
            active_run_guard,
        },
        job_activation_resources(&ctx),
    );
    let mut request = match AssertUnwindSafe(build_spawn_job_request(&mut activation, &ctx))
        .catch_unwind()
        .await
    {
        Ok(Ok(request)) => request,
        Ok(Err(error)) => {
            return Ok(activation
                .recover(error.recovery_reason(), error.to_string())
                .await?
                .into_cancellation()
                .await);
        }
        Err(panic) => {
            if let Err(error) = activation.recover_setup_panic().await {
                tracing::error!(%error, "job activation panic recovery failed");
            }
            std::panic::resume_unwind(panic);
        }
    };
    drop(activation_transfer_guard);
    if home_fallback {
        let (predecessor_state, lock_policy) = admission.fallback_home_prepare_policy();
        request.job_profile.home_image_prepare_policy = lock_policy;
        if lock_policy == HomeImagePreparePolicy::TryCacheWithoutLockWait {
            info!(
                run_id = %run_id,
                ?predecessor_state,
                "finalizing fallback will skip home cache lock retry"
            );
        }
    }
    Ok(run_job(request, ctx).await)
}

async fn prepare_finalizing_resource(
    request: FinalizingPreparation<'_>,
    reserved_exact: &mut Option<ReservedIdleActivation>,
) -> Result<FinalizingResource, Box<ExecutionFailure>> {
    let FinalizingPreparation {
        job,
        cancellation,
        admission,
        profile_name,
        vcpu,
        memory_mb,
        device_rate_limits,
        pre_spawn_timing,
        ctx,
    } = request;
    let run_id = job.context().run_id;
    #[cfg(test)]
    maybe_panic_outer_job(
        ctx.outer_job_panic,
        OuterJobPanicPoint::AdmittedWithoutSandbox,
        run_id,
    );
    if let Err(error) = validate_resume_session_id(job.context()) {
        return Err(ExecutionFailure::from_error(error).into());
    }

    // Bound execution input owns native intent. Physical handoff alone grants
    // no native-history authority.
    admission.native_generation_run_id = job
        .context()
        .native_continuation
        .as_ref()
        .filter(|native| native.session_id.is_some())
        .and_then(|native| native.generation_run_id.as_deref())
        .filter(|generation| *generation == admission.source_run_id.to_string())
        .map(|_| admission.source_run_id);

    info!(
        run_id = %run_id,
        predecessor_run_id = %admission.source_run_id,
        native_generation_matches_source = admission.native_generation_run_id.is_some(),
        "finalizing successor job before sandbox publication"
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
        let handoff_observer = ctx.test_observer.clone();
        select_finalizing_resource_with_test_hooks(
            selection,
            pre_spawn_timing,
            reserved_exact,
            FinalizingSelectionTestHooks {
                on_handoff_requested: Some(std::sync::Arc::new(move |predecessor, successor| {
                    handoff_observer.notify_finalizing_handoff_requested(predecessor, successor);
                })),
                on_capacity_wait: None,
            },
        )
        .await
    }
    #[cfg(not(test))]
    select_finalizing_resource(selection, pre_spawn_timing, reserved_exact).await
}

/// Complete a job finalizing successor without activating a sandbox.
///
/// This path is used for cancellation, preparation and activation failures, identity mismatches,
/// and recovered panics after their resource cleanup has run. It always completes with no sandbox
/// and flushes the supplied finalizing handoff outcome directly because no executor is running to
/// emit that telemetry.
async fn complete_without_sandbox(
    job: ExecutionJob,
    cancellation: RunCancellationRegistration,
    failure: ExecutionFailure,
    diagnostics: Option<FinalizingDiagnostics>,
    ctx: &SpawnContext,
) -> RunCancellationRegistration {
    let (context, completion_auth, active_input_source) = job.into_parts();
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
            },
            completion_auth,
        )
        .await;
    if let Some(telemetry) = telemetry {
        telemetry.flush().await;
    }
    cancellation
}
