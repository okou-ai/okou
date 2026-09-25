//! Job discovery branch wiring and claimed-run dispatch.
//!
//! `run()` owns the provider discovery future and reactor scheduling. This module resolves
//! concrete profile/factory inputs and wires the supervisor-owned pre-claim admission transaction
//! to claimed-resource activation and executor dispatch.
//!
//! ## Ownership lifecycle
//!
//! A discovered candidate is not provider-owned until `JobProvider::claim` returns a claim. The
//! path before that boundary must remain reversible: local resources can be reserved, cancellation
//! can be registered, and either step can still be rolled back without completing a provider job.
//! In ordinary control flow after a successful claim, every exit either transfers the claimed setup
//! to the executor or completes the claim through the provider before releasing or recovering its
//! local ownership. A panic after ownership becomes active instead preserves enough active state
//! for cleanup and orphan reconciliation to resolve the uncertain provider outcome.
//!
//! The lifecycle is ordered as follows:
//!
//! 1. **Prepare the candidate.** Resolve the profile, factory, resource requirements, and runner
//!    preference. Preference preparation may select a compatible idle sandbox, an exact
//!    history-generation sandbox, a workspace-cache opportunity, or a finalizing predecessor. If
//!    a required preference resource is not available, the candidate is deferred or retained for a
//!    later poll rather than claimed.
//! 2. **Reserve local admission.** Before ordinary claim, hold either a budget lease or a reserved
//!    exact or blank idle entry. Exact speculation holds a generation-matching reservation while it
//!    prepares the sandbox in parallel with claim. A finalizing successor is the deliberate
//!    exception: a proof of its predecessor's reuse identity allows claim before the predecessor
//!    publishes an exact sandbox, so no fresh capacity is reserved for this admission.
//! 3. **Register cancellation and recheck lifecycle mode.** The cancellation registration is made
//!    before claim so provider-side cancellation can find the run, and duplicate registration is
//!    rejected without overwriting the active executor handle. The mode is checked after local
//!    admission: starting, draining, and stopped runners release the resource without claiming;
//!    stopping runners still claim but request hard cancellation so the provider-owned job can be
//!    completed deterministically.
//! 4. **Cross the provider boundary.** `claim()` runs in the non-cancellable branch handler. A
//!    rejected claim or a mismatched returned run ID unregisters cancellation and rolls back the
//!    admitted resource. In ordinary control flow, a successful claim is paired with `complete()`
//!    by either the pre-executor recovery path or the spawned job lifecycle; this pairing is why
//!    claim must not be interrupted. A panic after ownership becomes active is handled by the
//!    cleanup and orphan-reconciliation path rather than by fabricating a completion.
//! 5. **Activate the claimed resource.** Runner validates the resume session and registers an
//!    active-run guard so the claimed reuse key is not advertised as available during activation.
//!    `runner_supervisor::claimed_resource_activation` owns sandbox selection and state: a fresh
//!    admission first tries ordinary idle reuse and then fresh creation. A reserved idle entry
//!    persists `preparing` active status before unpark. Exact speculation validates the claimed
//!    identity and commits the prepared sandbox only under the cancellation transfer guard. A
//!    finalizing admission is handed to the specialized finalizing-successor path described in
//!    [`finalizing_claim.rs`](https://github.com/okou-ai/okou/blob/main/crates/runner/src/cmd/start/finalizing_claim.rs#L1-L72).
//! 6. **Transfer to the executor.** The supervisor's `ClaimedActivationGuard` owns the claimed
//!    setup while active status and the spawn request are prepared. It publishes the active status
//!    using the matching idle snapshot; Runner builds the session-history restore plan and takes
//!    the setup only after status publication and request preparation. Dropping the guard before
//!    transfer schedules recovery instead of losing the provider claim or sandbox ownership.
//! 7. **Complete and reconcile.** After handoff, `job_spawn` owns executor completion, provider
//!    reporting, and the post-executor park-or-destroy decision. If cleanup proves destruction or
//!    an idle-pool transfer, matching active status can be removed. If destruction is uncertain,
//!    active status remains visible and `(run_id, sandbox_id)` is recorded for orphan reconciliation
//!    by `runner-supervisor`'s ownership and orphan-reaper modules.
//!
//! ## Local admission ownership
//!
//! `runner_supervisor::pre_claim_admission::LocalAdmissionResource` records who owns the resource
//! while the provider claim is in flight:
//!
//! - **`Fresh(BudgetLease)`:** local admission owns a fresh capacity lease. A claim conflict,
//!   lifecycle rejection, or pre-claim cancellation drops it. After a successful claim, the lease
//!   remains the fresh fallback while ordinary idle reuse is attempted; it is either transferred to
//!   the executor's fresh sandbox or released after no-sandbox completion. If idle reuse wins, the
//!   idle sandbox's active lease replaces this speculative fresh lease.
//! - **`Reusable(ReservedIdleActivation)`:** the reservation owns an exact or blank idle-pool entry
//!   removed from the pool. Before claim loss it is restored to the pool. After a claim, activation
//!   preserves exact and workspace-cache priority over blank inventory, validates the applicable
//!   identity and configuration, persists `preparing`, and then unparks. A status or unpark failure
//!   completes the claim without a sandbox and either restores or destroys the entry before any
//!   fresh fallback; the reservation is not silently dropped.
//! - **`ExactSpeculative(ExactSpeculationReservation)`:** a generation-matching reservation owns
//!   the idle entry while unpark and guest-state preparation run alongside claim. The idle status
//!   snapshot remains the visible pool state until the prepared sandbox is committed. A lost claim
//!   reparks or destroys the prepared sandbox, while a successful claim checks cancellation under
//!   the transfer guard before committing it. Preparation or identity failure destroys the
//!   speculative sandbox before fresh fallback.
//! - **`Finalizing(FinalizingAdmission)`:** the admission owns an active-run reuse proof, deadline,
//!   reuse key, and history-generation identity rather than a local capacity lease. The
//!   finalizing-successor task owns the next decision: receive a direct handoff, reserve the exact
//!   published generation, or wait for fallback capacity. Cancellation, preparation failure, and
//!   activation failure complete the claimed job without a sandbox while returning or destroying
//!   any candidate it still owns.
//!
//! The cancellation registration remains owned from registration through claim rollback, no-sandbox
//! completion, or executor-task cleanup. Its transfer gate serializes cancellation with transitions
//! that move a sandbox from an idle reservation into active executor ownership. Active status is
//! published before ordinary reserved-idle unpark and is removed only after the matching sandbox
//! ownership transition is proved; exact speculation uses its persisted idle snapshot until its
//! commit point. The representative admission, cancellation, panic, status-recovery, telemetry,
//! and orphan tests are in `tests/main_loop/admission.rs`, `tests/main_loop/telemetry.rs`,
//! `tests/failure_recovery/outer_panic.rs` and the supervisor's pre-claim, ownership and
//! orphan-reaper tests.

use std::collections::BTreeMap;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Instant;

use futures_util::FutureExt;
use tokio::task::JoinSet;
use tracing::{info, warn};

use super::factory_lifecycle::SharedFactory;
use super::finalizing_claim::{FinalizingClaimRequest, spawn_finalizing_claim};
use super::job_spawn::{JobProfile, SpawnContext, SpawnJobRequest, spawn_job};
#[cfg(test)]
use super::{OuterJobPanicPoint, maybe_panic_outer_job};
use crate::config::ProfileConfig;
use crate::executor::{
    BlankPoolSelection, RunnerPreSpawnPhase, RunnerPreSpawnTiming, SessionHistoryRestorePlanInput,
    build_session_history_restore_plan, validate_resume_session_id,
};
use crate::idle_pool::ReusableIdleSandbox;
use crate::lifecycle::RunnerMode;
use crate::resource_budget::ResourceBudget;
use crate::status::{StatusPersistenceError, StatusTracker};
use crate::telemetry::JobTelemetry;
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_provider::{ClaimedJob, JobCandidate};
use runner_provider::{RunCancellationRegistration, RunCancellationRegistry};
use runner_supervisor::claimed_activation::{
    ClaimedActivationGuard, ClaimedActivationResources, ClaimedJobSetup, ReadyClaimedResource,
    blank_pool_selection_telemetry,
};
use runner_supervisor::claimed_resource_activation::{
    ActivationResources, ExactActivation, ReservedActivation, ReservedActivationRequest,
    ReuseAdmissionRequest, activate_reserved_idle, activate_speculated_exact, try_reuse_from_pool,
};
use runner_supervisor::idle_lifecycle::SharedIdlePool;
use runner_supervisor::pre_claim_admission::{
    AdmittedClaim, AdmittedResource, PreClaimOutcome, PreClaimRequest, PreClaimResources,
    SandboxAdmittedResource, admit_and_claim, rollback_sandbox_admitted_resource,
};
use runner_types::ids::RunId;
use runner_types::types::{CompleteRequest, SandboxReuseResult};

pub(super) struct DiscoveredJob {
    pub(super) candidate: JobCandidate,
}

pub(super) struct DiscoveredJobContext<'a> {
    pub(super) runner_identity: RunnerProcessIdentity,
    pub(super) profiles: &'a BTreeMap<String, ProfileConfig>,
    pub(super) factories: &'a BTreeMap<String, (SharedFactory, bool)>,
    pub(super) budget: &'a Arc<ResourceBudget>,
    pub(super) idle_pool: &'a SharedIdlePool,
    pub(super) status: &'a StatusTracker,
    pub(super) mode_rx: &'a tokio::sync::watch::Receiver<RunnerMode>,
    pub(super) cancel_tokens: &'a RunCancellationRegistry,
    pub(super) spawn_ctx: &'a SpawnContext,
    pub(super) jobs: &'a mut JoinSet<RunCancellationRegistration>,
}

pub(super) struct DiscoveredJobResult {
    pub(super) needs_reuse_state_refresh: bool,
    pub(super) pending_candidate: Option<JobCandidate>,
}

impl DiscoveredJobResult {
    fn completed(needs_reuse_state_refresh: bool) -> Self {
        Self {
            needs_reuse_state_refresh,
            pending_candidate: None,
        }
    }

    fn pending(candidate: JobCandidate) -> Self {
        Self {
            needs_reuse_state_refresh: false,
            pending_candidate: Some(candidate),
        }
    }
}

pub(super) fn activation_resources(ctx: &SpawnContext) -> ActivationResources<'_> {
    #[cfg(test)]
    let on_preparing_committed = {
        let observer = ctx.test_observer.clone();
        Some(Arc::new(move |run_id| {
            let observer = observer.clone();
            async move { observer.notify_reserved_preparing_committed(run_id).await }.boxed()
        })
            as Arc<
                dyn Fn(RunId) -> futures_util::future::BoxFuture<'static, ()> + Send + Sync,
            >)
    };
    #[cfg(not(test))]
    let on_preparing_committed = None;
    ActivationResources {
        idle_pool: &ctx.idle_pool,
        status: &ctx.status,
        idle_destroy_tracker: &ctx.idle_destroy_tracker,
        orphaned_active_runs: &ctx.orphaned_active_runs,
        reuse_state_notify: &ctx.reuse_state_notify,
        budget: &ctx.budget,
        workspace_cache: ctx.exec_config.workspace_cache.as_ref(),
        workspace_cache_snapshot: &ctx.workspace_cache_snapshot,
        blank_pool_diagnostics: &ctx.blank_pool_diagnostics,
        on_preparing_committed,
    }
}

fn pre_claim_resources<'a>(ctx: &'a DiscoveredJobContext<'_>) -> PreClaimResources<'a> {
    PreClaimResources {
        runner_identity: ctx.runner_identity,
        idle_pool: ctx.idle_pool,
        status: ctx.status,
        mode_rx: ctx.mode_rx,
        cancel_tokens: ctx.cancel_tokens,
        provider: ctx.spawn_ctx.provider.as_ref(),
        budget: ctx.budget,
        active_runs: &ctx.spawn_ctx.active_runs,
        workspace_cache_snapshot: &ctx.spawn_ctx.workspace_cache_snapshot,
        has_workspace_cache: ctx.spawn_ctx.exec_config.workspace_cache.is_some(),
        idle_destroy_tracker: &ctx.spawn_ctx.idle_destroy_tracker,
        reuse_state_notify: ctx.spawn_ctx.reuse_state_notify.as_ref(),
        blank_pool_diagnostics: &ctx.spawn_ctx.blank_pool_diagnostics,
    }
}

pub(super) async fn handle_discovered_job(
    job: DiscoveredJob,
    mut ctx: DiscoveredJobContext<'_>,
) -> DiscoveredJobResult {
    let DiscoveredJob { mut candidate } = job;
    candidate.mark_main_loop_handling_started();
    let run_id = candidate.run_id();
    let profile_name = candidate.profile_name().to_owned();
    // Look up profile config for resource requirements.
    let Some(profile_config) = ctx.profiles.get(&profile_name) else {
        warn!(run_id = %run_id, profile = %profile_name, "unknown profile, skipping");
        return DiscoveredJobResult::completed(false);
    };
    let job_vcpu = profile_config.vcpu;
    let job_memory = profile_config.memory_mb;
    let job_workspace_disk_mb = profile_config.workspace_disk_mb;
    let device_rate_limits = ctx.spawn_ctx.device_rate_limits.clone();
    let Some((factory, restore_guest_state)) = ctx.factories.get(&profile_name) else {
        warn!(run_id = %run_id, profile = %profile_name, "no factory for profile, skipping");
        return DiscoveredJobResult::completed(false);
    };

    let resources = pre_claim_resources(&ctx);
    let admission = match admit_and_claim(
        PreClaimRequest {
            candidate,
            profile_name: &profile_name,
            job_vcpu,
            job_memory,
            workspace_disk_mb: job_workspace_disk_mb,
            device_rate_limits: &device_rate_limits,
        },
        &resources,
    )
    .await
    {
        PreClaimOutcome::Claimed(admission) => *admission,
        PreClaimOutcome::Pending(candidate) => return DiscoveredJobResult::pending(*candidate),
        PreClaimOutcome::Deferred => return DiscoveredJobResult::completed(false),
    };
    let AdmittedClaim {
        claimed,
        resource,
        cancellation,
        claim_returned_at,
        blank_pool_selection,
    } = admission;
    let resource = match resource {
        AdmittedResource::Finalizing(admission) => {
            spawn_finalizing_claim(
                FinalizingClaimRequest {
                    claimed,
                    cancellation,
                    admission,
                    claim_returned_at,
                    profile_name,
                    vcpu: job_vcpu,
                    memory_mb: job_memory,
                    workspace_disk_mb: job_workspace_disk_mb,
                    restore_guest_state: *restore_guest_state,
                    device_rate_limits,
                    factory: Arc::clone(factory),
                },
                ctx.spawn_ctx,
                ctx.jobs,
            );
            return DiscoveredJobResult::completed(false);
        }
        AdmittedResource::Fresh(lease) => SandboxAdmittedResource::Fresh(lease),
        AdmittedResource::Reusable(reservation) => SandboxAdmittedResource::Reusable(reservation),
        AdmittedResource::ExactSpeculation(speculation) => {
            SandboxAdmittedResource::ExactSpeculation(speculation)
        }
    };
    if cancellation.handle().is_cancelled()
        && matches!(&resource, SandboxAdmittedResource::ExactSpeculation(_))
    {
        complete_claimed_without_sandbox(
            claimed,
            cancellation,
            resource,
            job_workspace_disk_mb,
            ClaimedFailureDiagnostics::without_timing(None),
            crate::executor::ExecutionFailure::cancelled(),
            &mut ctx,
        )
        .await;
        return DiscoveredJobResult::completed(true);
    }
    let mut pre_spawn_timing = RunnerPreSpawnTiming::start_at(
        claim_returned_at,
        claimed.api_claim_timing(),
        &ctx.spawn_ctx.pre_spawn_concurrency,
    );
    if let Some(selection) = blank_pool_selection {
        pre_spawn_timing.record_blank_pool_selection(selection);
    }
    let started_at = Instant::now();
    let resume_session_error = validate_resume_session_id(claimed.context()).err();
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::ResumeSessionValidation, started_at);
    if let Some(error) = resume_session_error {
        let needs_reuse_state_refresh = matches!(
            &resource,
            SandboxAdmittedResource::Reusable(_) | SandboxAdmittedResource::ExactSpeculation(_)
        );
        complete_claimed_without_sandbox(
            claimed,
            cancellation,
            resource,
            job_workspace_disk_mb,
            ClaimedFailureDiagnostics::from_timing(None, &pre_spawn_timing),
            crate::executor::ExecutionFailure::from_error(error),
            &mut ctx,
        )
        .await;
        return DiscoveredJobResult::completed(needs_reuse_state_refresh);
    }
    info!(run_id = %run_id, profile = %profile_name, "job claimed, spawning executor");
    let started_at = Instant::now();
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::DeviceRateLimits, started_at);

    // Hide the claimed reuse key from heartbeats before unpark or fallback
    // cleanup can yield. Otherwise a concurrent heartbeat could briefly
    // advertise stale workspace-cache state for an active run.
    let active_run_guard = ctx.spawn_ctx.active_runs.register(
        run_id,
        claimed.context().reuse_key().map(str::to_owned),
        profile_name.clone(),
    );
    let cancellation_handle = cancellation.handle();

    let (
        reuse_entry,
        active_lease,
        reuse_result,
        idle_snapshot,
        needs_reuse_state_refresh,
        activation_transfer_guard,
    ) = match resource {
        SandboxAdmittedResource::Fresh(job_lease) => {
            let (reuse_entry, active_lease, reuse_result, idle_snapshot, refresh, transfer_guard) =
                match try_reuse_from_pool(
                    run_id,
                    ReuseAdmissionRequest {
                        profile_name: &profile_name,
                        device_rate_limits: &device_rate_limits,
                        workspace_disk_mb: job_workspace_disk_mb,
                        context: claimed.context(),
                        job_lease,
                    },
                    &activation_resources(ctx.spawn_ctx),
                    &mut pre_spawn_timing,
                    &cancellation_handle,
                )
                .await
                {
                    Ok(ready) => ready,
                    Err(failure) => {
                        let completion = complete_claimed_failure(
                            claimed,
                            cancellation,
                            ClaimedFailureDiagnostics::from_timing(
                                Some(failure.reuse_result),
                                &pre_spawn_timing,
                            ),
                            crate::executor::ExecutionFailure::from_error(failure.error),
                            &ctx,
                        )
                        .await;
                        drop(active_run_guard);
                        completion.flush_telemetry().await;
                        return DiscoveredJobResult::completed(true);
                    }
                };
            (
                reuse_entry,
                active_lease,
                reuse_result,
                idle_snapshot,
                refresh,
                transfer_guard,
            )
        }
        SandboxAdmittedResource::Reusable(reservation) => {
            let transfer_guard = cancellation_handle.transfer_guard().await;
            if cancellation_handle.is_cancelled() {
                drop(transfer_guard);
                drop(active_run_guard);
                complete_claimed_without_sandbox(
                    claimed,
                    cancellation,
                    SandboxAdmittedResource::Reusable(reservation),
                    job_workspace_disk_mb,
                    ClaimedFailureDiagnostics::from_timing(None, &pre_spawn_timing),
                    crate::executor::ExecutionFailure::cancelled(),
                    &mut ctx,
                )
                .await;
                return DiscoveredJobResult::completed(true);
            }
            match activate_reserved_idle(
                reservation,
                ReservedActivationRequest {
                    run_id,
                    profile_name: &profile_name,
                    device_rate_limits: &device_rate_limits,
                    workspace_disk_mb: job_workspace_disk_mb,
                    context: claimed.context(),
                },
                &activation_resources(ctx.spawn_ctx),
                &mut pre_spawn_timing,
            )
            .await
            {
                ReservedActivation::Ready {
                    reuse_entry,
                    active_lease,
                    reuse_result,
                    idle_snapshot,
                } => (
                    reuse_entry.map(|entry| *entry),
                    active_lease,
                    reuse_result,
                    Some(idle_snapshot),
                    true,
                    Some(transfer_guard),
                ),
                ReservedActivation::CannotStart {
                    budget_lease,
                    reuse_result,
                    error,
                } => {
                    drop(transfer_guard);
                    let failure = crate::executor::ExecutionFailure::from_error(error);
                    if let Some(budget_lease) = budget_lease {
                        complete_claimed_without_sandbox(
                            claimed,
                            cancellation,
                            SandboxAdmittedResource::Fresh(budget_lease),
                            job_workspace_disk_mb,
                            ClaimedFailureDiagnostics::from_timing(
                                Some(reuse_result),
                                &pre_spawn_timing,
                            ),
                            failure,
                            &mut ctx,
                        )
                        .await;
                    } else {
                        let completion = complete_claimed_failure(
                            claimed,
                            cancellation,
                            ClaimedFailureDiagnostics::from_timing(
                                Some(reuse_result),
                                &pre_spawn_timing,
                            ),
                            failure,
                            &ctx,
                        )
                        .await;
                        completion.flush_telemetry().await;
                    }
                    return DiscoveredJobResult::completed(true);
                }
            }
        }
        SandboxAdmittedResource::ExactSpeculation(speculation) => {
            match activate_speculated_exact(
                speculation,
                ReservedActivationRequest {
                    run_id,
                    profile_name: &profile_name,
                    device_rate_limits: &device_rate_limits,
                    workspace_disk_mb: job_workspace_disk_mb,
                    context: claimed.context(),
                },
                &activation_resources(ctx.spawn_ctx),
                &mut pre_spawn_timing,
                &cancellation.handle(),
            )
            .await
            {
                ExactActivation::Ready {
                    reuse_entry,
                    active_lease,
                    reuse_result,
                    idle_snapshot,
                    transfer_guard,
                } => (
                    reuse_entry.map(|entry| *entry),
                    active_lease,
                    reuse_result,
                    Some(idle_snapshot),
                    true,
                    Some(transfer_guard),
                ),
                ExactActivation::Cancelled {
                    resource,
                    reuse_result,
                } => {
                    let completion = complete_claimed_failure(
                        claimed,
                        cancellation,
                        ClaimedFailureDiagnostics::from_timing(reuse_result, &pre_spawn_timing),
                        crate::executor::ExecutionFailure::cancelled(),
                        &ctx,
                    )
                    .await;
                    let run_id = completion.run_id;
                    resource
                        .rollback(run_id, job_workspace_disk_mb, &pre_claim_resources(&ctx))
                        .await;
                    completion.flush_telemetry().await;
                    return DiscoveredJobResult::completed(true);
                }
                ExactActivation::CannotStart {
                    budget_lease,
                    reuse_result,
                    error,
                } => {
                    complete_claimed_without_sandbox(
                        claimed,
                        cancellation,
                        SandboxAdmittedResource::Fresh(budget_lease),
                        job_workspace_disk_mb,
                        ClaimedFailureDiagnostics::from_timing(
                            Some(reuse_result),
                            &pre_spawn_timing,
                        ),
                        crate::executor::ExecutionFailure::from_error(error),
                        &mut ctx,
                    )
                    .await;
                    return DiscoveredJobResult::completed(true);
                }
            }
        }
    };

    let mut activation = ClaimedActivationGuard::new(
        ClaimedJobSetup {
            claimed,
            cancellation,
            profile_name,
            vcpu: job_vcpu,
            memory_mb: job_memory,
            workspace_disk_mb: job_workspace_disk_mb,
            restore_guest_state: *restore_guest_state,
            device_rate_limits,
            factory: Arc::clone(factory),
            resource: ReadyClaimedResource {
                reuse_entry,
                active_lease,
                reuse_result,
                idle_snapshot,
            },
            pre_spawn_timing,
            active_run_guard,
        },
        claimed_activation_resources(ctx.spawn_ctx),
    );
    let request = match AssertUnwindSafe(build_spawn_job_request(&mut activation, ctx.spawn_ctx))
        .catch_unwind()
        .await
    {
        Ok(Ok(request)) => request,
        Ok(Err(error)) => {
            activation
                .recover(
                    "active_status_persistence_failed",
                    format!("persist active runner ownership: {error}"),
                )
                .await
                .finish()
                .await;
            drop(activation_transfer_guard);
            return DiscoveredJobResult::completed(true);
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
            drop(activation_transfer_guard);
            std::panic::resume_unwind(panic);
        }
    };
    spawn_job(request, ctx.spawn_ctx, ctx.jobs);
    drop(activation_transfer_guard);
    DiscoveredJobResult::completed(needs_reuse_state_refresh)
}

pub(super) fn claimed_activation_resources(ctx: &SpawnContext) -> ClaimedActivationResources {
    ClaimedActivationResources {
        provider: Arc::clone(&ctx.provider),
        exec_config: Arc::clone(&ctx.exec_config),
        status: Arc::clone(&ctx.status),
        orphaned_active_runs: ctx.orphaned_active_runs.clone(),
        reuse_state_notify: Arc::clone(&ctx.reuse_state_notify),
        idle_destroy_tracker: ctx.idle_destroy_tracker.clone(),
    }
}

pub(super) async fn build_spawn_job_request(
    activation: &mut ClaimedActivationGuard,
    ctx: &SpawnContext,
) -> Result<SpawnJobRequest, StatusPersistenceError> {
    activation.record_resource_budget_occupancy(&ctx.budget);
    #[cfg(test)]
    let run_id = activation.setup().claimed.context().run_id;
    let sandbox_id = activation.sandbox_id();
    #[cfg(test)]
    maybe_panic_outer_job(
        ctx.outer_job_panic,
        OuterJobPanicPoint::ClaimedActivation,
        run_id,
    );
    activation.publish_active_status().await?;
    #[cfg(test)]
    ctx.test_observer.notify_active_run_status_published(run_id);

    let setup = activation.setup();
    let session_history_restore_plan =
        build_session_history_restore_plan(SessionHistoryRestorePlanInput {
            http: &ctx.exec_config.http,
            cpu: &ctx.exec_config.session_history_cpu,
            context: setup.claimed.context(),
            cancel: setup.cancellation.token(),
            reuse_result: setup.resource.reuse_result,
            idle_kind: setup
                .resource
                .reuse_entry
                .as_ref()
                .map(ReusableIdleSandbox::kind),
            restored_identity: setup
                .resource
                .reuse_entry
                .as_ref()
                .and_then(ReusableIdleSandbox::restored_session_identity),
            pre_spawn_timing: &mut setup.pre_spawn_timing,
            probe: Some(&ctx.exec_config.session_history_probe),
        });

    let ClaimedJobSetup {
        claimed,
        cancellation,
        profile_name,
        vcpu,
        memory_mb,
        workspace_disk_mb,
        restore_guest_state,
        device_rate_limits,
        factory,
        resource,
        pre_spawn_timing,
        active_run_guard,
    } = activation.take_setup_after_status();
    let ReadyClaimedResource {
        reuse_entry,
        active_lease,
        reuse_result,
        idle_snapshot,
    } = resource;
    drop(idle_snapshot);

    Ok(SpawnJobRequest {
        claimed,
        sandbox_id,
        job_profile: JobProfile {
            profile_name,
            vcpu,
            memory_mb,
            workspace_disk_mb,
            budget_lease: active_lease,
            restore_guest_state,
            device_rate_limits,
            workspace_image_prepare_lock_policy: Default::default(),
            factory,
            cancellation,
        },
        reuse_entry,
        reuse_result,
        pre_spawn_timing,
        session_history_restore_plan,
        active_run_guard,
    })
}

async fn complete_claimed_without_sandbox(
    claimed: ClaimedJob,
    cancellation: RunCancellationRegistration,
    resource: SandboxAdmittedResource,
    workspace_disk_mb: u32,
    diagnostics: ClaimedFailureDiagnostics,
    failure: crate::executor::ExecutionFailure,
    ctx: &mut DiscoveredJobContext<'_>,
) {
    let completion =
        complete_claimed_failure(claimed, cancellation, diagnostics, failure, ctx).await;
    rollback_sandbox_admitted_resource(
        resource,
        completion.run_id,
        workspace_disk_mb,
        &pre_claim_resources(ctx),
    )
    .await;
    completion.flush_telemetry().await;
}

#[derive(Clone, Copy)]
struct ClaimedFailureDiagnostics {
    reuse_result: Option<SandboxReuseResult>,
    blank_pool_selection: Option<BlankPoolSelection>,
}

impl ClaimedFailureDiagnostics {
    const fn without_timing(reuse_result: Option<SandboxReuseResult>) -> Self {
        Self {
            reuse_result,
            blank_pool_selection: None,
        }
    }

    fn from_timing(
        reuse_result: Option<SandboxReuseResult>,
        timing: &RunnerPreSpawnTiming,
    ) -> Self {
        Self {
            reuse_result,
            blank_pool_selection: timing.blank_pool_selection(),
        }
    }
}

struct ClaimedFailureCompletion {
    run_id: RunId,
    telemetry: Option<JobTelemetry>,
}

impl ClaimedFailureCompletion {
    async fn flush_telemetry(self) {
        if let Some(telemetry) = self.telemetry {
            telemetry.flush().await;
        }
    }
}

async fn complete_claimed_failure(
    claimed: ClaimedJob,
    cancellation: RunCancellationRegistration,
    diagnostics: ClaimedFailureDiagnostics,
    failure: crate::executor::ExecutionFailure,
    ctx: &DiscoveredJobContext<'_>,
) -> ClaimedFailureCompletion {
    let (context, completion_auth, active_input_source) = claimed.into_parts();
    let run_id = context.run_id;
    drop(active_input_source);
    let telemetry = blank_pool_selection_telemetry(
        &context,
        diagnostics.blank_pool_selection,
        &ctx.spawn_ctx.exec_config,
    );
    ctx.spawn_ctx
        .provider
        .complete(
            CompleteRequest {
                run_id,
                exit_code: failure.exit_code,
                failure_reason: None,
                error: Some(failure.error),
                sandbox_id: None,
                sandbox_reuse_result: diagnostics.reuse_result,
                workspace_reuse_result: None,
                active_input_delivery_ids: Vec::new(),
            },
            completion_auth,
        )
        .await;
    cancellation.unregister().await;
    ClaimedFailureCompletion { run_id, telemetry }
}
