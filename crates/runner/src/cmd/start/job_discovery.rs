//! Job discovery branch handling and idle-reuse admission.
//!
//! `run()` owns the provider discovery future and reactor scheduling. This
//! module owns the body that turns a discovered job into a claimed spawned job.
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
//! 5. **Activate the claimed resource.** Validate the resume session and register an active-run
//!    guard so the claimed reuse key is not advertised as available during activation. A fresh
//!    admission first tries ordinary idle reuse and then fresh creation. A reserved idle entry
//!    persists `preparing` active status before unpark. Exact speculation validates the claimed
//!    identity and commits the prepared sandbox only under the cancellation transfer guard. A
//!    finalizing admission is handed to the specialized finalizing-successor path described in
//!    [`finalizing_claim.rs`](https://github.com/vm0-ai/vm0/blob/main/crates/runner/src/cmd/start/finalizing_claim.rs#L1-L72).
//! 6. **Transfer to the executor.** `ClaimedActivationGuard` owns the claimed setup while active
//!    status and the spawn request are prepared. It publishes the active status using the matching
//!    idle snapshot, builds the session-history restore plan, and takes the setup only when the
//!    executor request is complete. Dropping the guard before that transfer schedules recovery
//!    instead of losing the provider claim or sandbox ownership.
//! 7. **Complete and reconcile.** After handoff, `job_spawn` owns executor completion, provider
//!    reporting, and the post-executor park-or-destroy decision. If cleanup proves destruction or
//!    an idle-pool transfer, matching active status can be removed. If destruction is uncertain,
//!    active status remains visible and `(run_id, sandbox_id)` is recorded for orphan reconciliation
//!    by `ownership.rs` and `orphan_reap.rs`.
//!
//! ## Local admission ownership
//!
//! `LocalAdmissionResource` records who owns the resource while the provider claim is in flight:
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
//! `tests/failure_recovery/outer_panic.rs`, `ownership.rs`, and `orphan_reap.rs`.

use std::collections::BTreeMap;
use std::mem::ManuallyDrop;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Instant;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use futures_util::FutureExt;
use sandbox::SandboxId;
use tokio::sync::OwnedMutexGuard;
use tokio::task::JoinSet;
use tracing::{info, warn};

use super::active_runs::{ActiveRunGuard, ActiveRunReuseProof};
use super::factory_lifecycle::SharedFactory;
use super::finalizing_claim::{FinalizingClaimRequest, spawn_finalizing_claim};
use super::idle_lifecycle::{
    IdleDestroyTracker, IdlePressureRequest, IdlePressureSelection, ReservedIdleActivation,
    SharedIdlePool, add_preparing_run_with_idle_status_snapshot,
    add_running_run_with_idle_status_snapshot, destroy_idle_jobs_and_wait,
    select_idle_entries_for_pressure, set_idle_status_snapshot, spawn_idle_destroy_job,
};
use super::job_spawn::{JobProfile, SpawnContext, SpawnJobRequest, spawn_job};
use super::ownership::{OwnershipTransitions, RunSandbox};
#[cfg(test)]
use super::{OuterJobPanicPoint, maybe_panic_outer_job};
use crate::config::ProfileConfig;
use crate::executor::{
    ExactReuseSpeculationTiming, GuestTimezoneSyncOutcome, RunnerPreSpawnOperationTiming,
    RunnerPreSpawnPhase, RunnerPreSpawnTiming, SessionHistoryRestorePlanInput,
    build_session_history_restore_plan, restore_guest_state_with_intent,
    try_sync_guest_timezone_intent, validate_resume_session_id,
};
use crate::guest_timezone::{GuestTimezoneAssumption, GuestTimezoneIntent};
use crate::idle_pool::{
    DestroyOutcome, ExactIdleReservationMiss, IdlePoolSnapshot, IdleSandboxKind, IdleUnparkResult,
    ReservedIdleSandbox, RestoreReservedIdleResult, ReusableIdleSandbox, SpeculativeIdleSandbox,
    SpeculativeIdleUnparkResult, SpeculativeReparkResult,
};
use crate::ids::RunId;
use crate::lifecycle::RunnerMode;
use crate::paths::short_digest;
use crate::provider::{
    ClaimedJob, JobCandidate, JobProvider, RunnerPreferenceRemovalReason, RunnerPreferenceTier,
};
use crate::resource_budget::{BudgetLease, ResourceBudget};
use crate::run_cancellation::{
    RunCancellationHandle, RunCancellationRegistration, RunCancellationRegistry,
};
use crate::runner_process_identity::RunnerProcessIdentity;
use crate::status::{StatusPersistenceError, StatusTracker};
use crate::types::{
    CompleteRequest, ExecutionContext, HeldWorkspaceState, SandboxReuseResult,
    WORKSPACE_AFFINITY_VERSION, reuse_key_kind,
};

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

struct LocalAdmission {
    resource: LocalAdmissionResource,
    cancellation: RunCancellationRegistration,
}

enum LocalAdmissionResource {
    Fresh(BudgetLease),
    Reusable(ReservedIdleActivation),
    ExactSpeculative(ExactSpeculationReservation),
    Finalizing(FinalizingAdmission),
}

enum AdmittedResource {
    Fresh(BudgetLease),
    Reusable(ReservedIdleActivation),
    ExactSpeculation(ExactSpeculation),
    Finalizing(FinalizingAdmission),
}

enum SandboxAdmittedResource {
    Fresh(BudgetLease),
    Reusable(ReservedIdleActivation),
    ExactSpeculation(ExactSpeculation),
}

pub(super) struct FinalizingAdmission {
    pub(super) predecessor: ActiveRunReuseProof,
    pub(super) deadline: Instant,
    pub(super) reuse_key: String,
    pub(super) history_generation_run_id: RunId,
}

struct ExactSpeculation {
    outcome: ExactSpeculationOutcome,
    sandbox_id: SandboxId,
    idle_snapshot: IdlePoolSnapshot,
    preparation_started_at: Instant,
    preparation_completed_at: Instant,
    claim_started_at: Instant,
    claim_returned_at: Instant,
    unpark: RunnerPreSpawnOperationTiming,
    guest_restore: Option<RunnerPreSpawnOperationTiming>,
}

struct ExactSpeculationReservation {
    reservation: Box<ReservedIdleSandbox>,
    sandbox_id: SandboxId,
    idle_snapshot: IdlePoolSnapshot,
}

struct ExactSpeculationPreparation {
    outcome: ExactSpeculationOutcome,
    started_at: Instant,
    completed_at: Instant,
    unpark: RunnerPreSpawnOperationTiming,
    guest_restore: Option<RunnerPreSpawnOperationTiming>,
}

enum ExactSpeculationOutcome {
    Prepared(Box<SpeculativeIdleSandbox>),
    Failed {
        destroy_job: Box<crate::idle_pool::IdleDestroyJob>,
        error: String,
    },
}

struct AdmittedClaim {
    claimed: ClaimedJob,
    resource: AdmittedResource,
    cancellation: RunCancellationRegistration,
    claim_returned_at: Instant,
}

struct PreparedCandidate {
    candidate: JobCandidate,
    resource: Option<LocalAdmissionResource>,
}

enum PreferencePreparation {
    Ready(PreparedCandidate),
    Pending(JobCandidate),
    Deferred,
}

struct ReuseAdmissionRequest<'a> {
    profile_name: &'a str,
    device_rate_limits: &'a Option<sandbox::DeviceRateLimits>,
    workspace_disk_mb: u32,
    context: &'a ExecutionContext,
    job_lease: BudgetLease,
}

struct ReuseFromPoolFailure {
    reuse_result: SandboxReuseResult,
    error: String,
}

struct ClaimAdmissionRequest<'a> {
    prepared: PreparedCandidate,
    run_id: RunId,
    profile_name: &'a str,
    job_vcpu: u32,
    job_memory: u32,
    workspace_disk_mb: u32,
    device_rate_limits: &'a Option<sandbox::DeviceRateLimits>,
}

struct PreferenceCandidateRequest<'a> {
    candidate: JobCandidate,
    preference: &'a crate::provider::ActiveRunnerPreference,
    reuse_key: &'a str,
    profile_name: &'a str,
    job_vcpu: u32,
    job_memory: u32,
    device_rate_limits: &'a Option<sandbox::DeviceRateLimits>,
    ctx: &'a DiscoveredJobContext<'a>,
}

pub(super) struct ReservedActivationRequest<'a> {
    pub(super) run_id: RunId,
    pub(super) profile_name: &'a str,
    pub(super) device_rate_limits: &'a Option<sandbox::DeviceRateLimits>,
    pub(super) workspace_disk_mb: u32,
    pub(super) context: &'a ExecutionContext,
}

impl LocalAdmission {
    async fn rollback(self, ctx: &mut DiscoveredJobContext<'_>) {
        let Self {
            resource,
            cancellation,
        } = self;
        cancellation.unregister().await;
        rollback_untracked_resource(resource, ctx).await;
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

    let prepared = match prepare_preference_candidate(
        candidate,
        &profile_name,
        job_vcpu,
        job_memory,
        &device_rate_limits,
        &ctx,
    )
    .await
    {
        PreferencePreparation::Ready(prepared) => prepared,
        PreferencePreparation::Pending(candidate) => {
            return DiscoveredJobResult::pending(candidate);
        }
        PreferencePreparation::Deferred => return DiscoveredJobResult::completed(false),
    };
    let Some(admission) = claim_with_local_admission(
        ClaimAdmissionRequest {
            prepared,
            run_id,
            profile_name: &profile_name,
            job_vcpu,
            job_memory,
            workspace_disk_mb: job_workspace_disk_mb,
            device_rate_limits: &device_rate_limits,
        },
        &mut ctx,
    )
    .await
    else {
        return DiscoveredJobResult::completed(false);
    };
    let AdmittedClaim {
        claimed,
        resource,
        cancellation,
        claim_returned_at,
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
            None,
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
            None,
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
                    &mut ctx,
                    &mut pre_spawn_timing,
                    &cancellation_handle,
                )
                .await
                {
                    Ok(ready) => ready,
                    Err(failure) => {
                        complete_claimed_failure(
                            claimed,
                            cancellation,
                            Some(failure.reuse_result),
                            crate::executor::ExecutionFailure::from_error(failure.error),
                            &ctx,
                        )
                        .await;
                        drop(active_run_guard);
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
                    None,
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
                ctx.spawn_ctx,
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
                            Some(reuse_result),
                            failure,
                            &mut ctx,
                        )
                        .await;
                    } else {
                        complete_claimed_failure(
                            claimed,
                            cancellation,
                            Some(reuse_result),
                            failure,
                            &ctx,
                        )
                        .await;
                    }
                    return DiscoveredJobResult::completed(true);
                }
            }
        }
        SandboxAdmittedResource::ExactSpeculation(speculation) => {
            let pending = activate_speculated_exact(
                speculation,
                ReservedActivationRequest {
                    run_id,
                    profile_name: &profile_name,
                    device_rate_limits: &device_rate_limits,
                    workspace_disk_mb: job_workspace_disk_mb,
                    context: claimed.context(),
                },
                &ctx,
                &mut pre_spawn_timing,
            )
            .await;
            match finish_exact_activation(pending, &cancellation.handle(), run_id).await {
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
                    let run_id = complete_claimed_failure(
                        claimed,
                        cancellation,
                        reuse_result,
                        crate::executor::ExecutionFailure::cancelled(),
                        &ctx,
                    )
                    .await;
                    match resource {
                        CancelledExactResource::Prepared(sandbox) => {
                            rollback_exact_speculation_outcome(
                                ExactSpeculationOutcome::Prepared(sandbox),
                                run_id,
                                job_workspace_disk_mb,
                                &mut ctx,
                            )
                            .await;
                        }
                        CancelledExactResource::Fresh(budget_lease) => drop(budget_lease),
                    }
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
                        Some(reuse_result),
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
        ctx.spawn_ctx,
    );
    let request = match AssertUnwindSafe(build_spawn_job_request(&mut activation, ctx.spawn_ctx))
        .catch_unwind()
        .await
    {
        Ok(Ok(request)) => request,
        Ok(Err(error)) => {
            let cancellation = activation
                .recover(
                    "active_status_persistence_failed",
                    format!("persist active runner ownership: {error}"),
                )
                .await;
            cancellation.unregister().await;
            drop(activation_transfer_guard);
            return DiscoveredJobResult::completed(true);
        }
        Err(panic) => {
            let cancellation = activation
                .recover(
                    "activation_setup_panicked",
                    "claimed activation setup panicked".to_owned(),
                )
                .await;
            cancellation.unregister().await;
            drop(activation_transfer_guard);
            std::panic::resume_unwind(panic);
        }
    };
    spawn_job(request, ctx.spawn_ctx, ctx.jobs);
    drop(activation_transfer_guard);
    DiscoveredJobResult::completed(needs_reuse_state_refresh)
}

pub(super) struct ReadyClaimedResource {
    pub(super) reuse_entry: Option<ReusableIdleSandbox>,
    pub(super) active_lease: BudgetLease,
    pub(super) reuse_result: SandboxReuseResult,
    pub(super) idle_snapshot: Option<IdlePoolSnapshot>,
}

pub(super) struct ClaimedJobSetup {
    pub(super) claimed: ClaimedJob,
    pub(super) cancellation: RunCancellationRegistration,
    pub(super) profile_name: String,
    pub(super) vcpu: u32,
    pub(super) memory_mb: u32,
    pub(super) workspace_disk_mb: u32,
    pub(super) restore_guest_state: bool,
    pub(super) device_rate_limits: Option<sandbox::DeviceRateLimits>,
    pub(super) factory: SharedFactory,
    pub(super) resource: ReadyClaimedResource,
    pub(super) pre_spawn_timing: RunnerPreSpawnTiming,
    pub(super) active_run_guard: ActiveRunGuard,
}

#[derive(Clone)]
struct ActivationRecoveryContext {
    provider: Arc<dyn JobProvider>,
    status: Arc<StatusTracker>,
    orphaned_active_runs: super::orphan_reap::OrphanedActiveRuns,
    reuse_state_notify: Arc<tokio::sync::Notify>,
}

impl ActivationRecoveryContext {
    fn new(ctx: &SpawnContext) -> Self {
        Self {
            provider: Arc::clone(&ctx.provider),
            status: Arc::clone(&ctx.status),
            orphaned_active_runs: ctx.orphaned_active_runs.clone(),
            reuse_state_notify: Arc::clone(&ctx.reuse_state_notify),
        }
    }
}

pub(super) struct ClaimedActivationGuard {
    setup: ManuallyDrop<ClaimedJobSetup>,
    armed: bool,
    sandbox_id: SandboxId,
    recovery: ActivationRecoveryContext,
    cleanup: IdleDestroyTracker,
}

impl ClaimedActivationGuard {
    pub(super) fn new(setup: ClaimedJobSetup, ctx: &SpawnContext) -> Self {
        let sandbox_id = match &setup.resource.reuse_entry {
            Some(entry) => entry.sandbox_id(),
            None => SandboxId::new_v4(),
        };
        Self {
            setup: ManuallyDrop::new(setup),
            armed: true,
            sandbox_id,
            recovery: ActivationRecoveryContext::new(ctx),
            cleanup: ctx.idle_destroy_tracker.clone(),
        }
    }

    pub(super) async fn recover(
        mut self,
        reason: &'static str,
        error: String,
    ) -> RunCancellationRegistration {
        recover_claimed_activation_failure(
            self.take_setup(),
            self.sandbox_id,
            reason,
            error,
            &self.recovery,
        )
        .await
    }

    fn take_setup(&mut self) -> ClaimedJobSetup {
        self.armed = false;
        // SAFETY: `armed` is true exactly while `setup` has not been taken.
        // Every take clears it first, and `Drop` only takes while it is true.
        unsafe { ManuallyDrop::take(&mut self.setup) }
    }
}

impl Drop for ClaimedActivationGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let setup = self.take_setup();
        let sandbox_id = self.sandbox_id;
        let recovery = self.recovery.clone();
        self.cleanup.spawn_cleanup(
            async move {
                let cancellation = recover_claimed_activation_failure(
                    setup,
                    sandbox_id,
                    "activation_task_dropped",
                    "claimed activation task dropped before executor ownership transfer".to_owned(),
                    &recovery,
                )
                .await;
                cancellation.unregister().await;
            },
            "claimed_activation_drop",
        );
    }
}

pub(super) async fn build_spawn_job_request(
    activation: &mut ClaimedActivationGuard,
    ctx: &SpawnContext,
) -> Result<SpawnJobRequest, StatusPersistenceError> {
    let setup = &mut *activation.setup;
    setup
        .pre_spawn_timing
        .record_resource_budget_occupancy(&ctx.budget);
    let run_id = setup.claimed.context().run_id;
    let sandbox_id = activation.sandbox_id;
    ctx.provider
        .bind_claimed_sandbox(run_id, sandbox_id)
        .await
        .map_err(|source| StatusPersistenceError::Write {
            path: std::path::PathBuf::from("deferred-claim-journal"),
            source,
        })?;
    #[cfg(test)]
    maybe_panic_outer_job(
        ctx.outer_job_panic,
        OuterJobPanicPoint::ClaimedActivation,
        run_id,
    );
    let started_at = Instant::now();
    let status_result = publish_active_run_status(
        &ctx.status,
        run_id,
        sandbox_id,
        setup.resource.reuse_entry.is_some(),
        setup.resource.idle_snapshot.clone(),
    )
    .await;
    setup
        .pre_spawn_timing
        .record_phase_elapsed(RunnerPreSpawnPhase::ActiveStatusPublish, started_at);
    status_result?;
    #[cfg(test)]
    ctx.test_observer.notify_active_run_status_published(run_id);

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
    } = activation.take_setup();
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

async fn publish_active_run_status(
    status: &StatusTracker,
    run_id: RunId,
    sandbox_id: SandboxId,
    reused_idle: bool,
    idle_snapshot: Option<IdlePoolSnapshot>,
) -> Result<(), StatusPersistenceError> {
    if let Some(snapshot) = idle_snapshot {
        if reused_idle {
            add_running_run_with_idle_status_snapshot(status, run_id, sandbox_id, snapshot).await
        } else {
            add_preparing_run_with_idle_status_snapshot(status, run_id, sandbox_id, snapshot).await
        }
    } else {
        status.add_preparing_run(run_id, sandbox_id).await
    }
}

async fn recover_claimed_activation_failure(
    setup: ClaimedJobSetup,
    sandbox_id: SandboxId,
    reason: &'static str,
    error: String,
    ctx: &ActivationRecoveryContext,
) -> RunCancellationRegistration {
    let ClaimedJobSetup {
        claimed,
        cancellation,
        profile_name: _,
        vcpu: _,
        memory_mb: _,
        workspace_disk_mb: _,
        restore_guest_state: _,
        device_rate_limits: _,
        factory,
        resource,
        pre_spawn_timing: _,
        active_run_guard,
    } = setup;
    let ReadyClaimedResource {
        reuse_entry,
        active_lease,
        reuse_result,
        idle_snapshot: _,
    } = resource;
    let (context, completion_auth, active_input_source) = claimed.into_parts();
    let run_id = context.run_id;
    drop(active_input_source);
    warn!(
        run_id = %run_id,
        sandbox_id = %sandbox_id,
        error,
        recovery_reason = reason,
        activation_phase = "before_executor_handoff",
        recovery_outcome = "destroy_or_release",
        "recovering claimed activation before executor handoff"
    );
    let execution_failure = crate::executor::ExecutionFailure::from_error(error);
    ctx.provider
        .complete(
            CompleteRequest {
                run_id,
                exit_code: execution_failure.exit_code,
                failure_reason: None,
                error: Some(execution_failure.error),
                sandbox_id: None,
                sandbox_reuse_result: Some(reuse_result),
                workspace_reuse_result: None,
                active_input_delivery_ids: Vec::new(),
            },
            completion_auth,
        )
        .await;
    let cleanup_completed = if let Some(reuse_entry) = reuse_entry {
        let cleanup = reuse_entry
            .into_destroy_job(factory, active_lease, reason)
            .run_retaining_lease(reason)
            .await;
        if cleanup.workspace_cache_promoted {
            ctx.reuse_state_notify.notify_one();
        }
        drop(cleanup.budget_lease);
        cleanup.outcome == DestroyOutcome::Completed
    } else {
        drop(active_lease);
        true
    };
    ctx.provider.claimed_actor_gone(run_id).await;
    if cleanup_completed {
        remove_failed_activation_status(&ctx.status, run_id, sandbox_id).await;
    } else {
        retain_uncertain_activation_ownership(
            ctx.status.as_ref(),
            &ctx.orphaned_active_runs,
            run_id,
            sandbox_id,
            reason,
        );
    }
    drop(active_run_guard);
    cancellation
}

async fn claim_with_local_admission(
    request: ClaimAdmissionRequest<'_>,
    ctx: &mut DiscoveredJobContext<'_>,
) -> Option<AdmittedClaim> {
    let ClaimAdmissionRequest {
        prepared,
        run_id,
        profile_name,
        job_vcpu,
        job_memory,
        workspace_disk_mb,
        device_rate_limits,
    } = request;
    let PreparedCandidate {
        mut candidate,
        resource,
    } = prepared;
    candidate.mark_local_admission_started();

    // Reserve either the exact reusable sandbox or fresh capacity before
    // claiming. A proven finalizing successor is the only exception: it can
    // claim before its predecessor publishes the sandbox. This keeps ordinary
    // admission races out of the provider claim path and makes rollback
    // explicit when another runner wins.
    let resource = match resource {
        Some(resource) => resource,
        None => {
            acquire_local_admission_resource(
                &candidate,
                profile_name,
                job_vcpu,
                job_memory,
                device_rate_limits,
                ctx,
            )
            .await?
        }
    };
    // Register cancellation before claiming so provider-side cancel channels
    // (Ably supervisor for ApiProvider, `.cancel` scan for LocalProvider) can
    // find the active job. Skip duplicate discoveries; overwriting would break
    // cancel delivery for the executor.
    let cancellation = match ctx.cancel_tokens.register(run_id).await {
        Ok(registration) => registration,
        Err(_) => {
            rollback_untracked_resource(resource, ctx).await;
            return None;
        }
    };

    let admission = LocalAdmission {
        resource,
        cancellation,
    };

    // This is the last reversible point before provider-side ownership.
    // Soft drain must stop new claims, while hard stop still claims and
    // cancels so provider state is completed deterministically.
    let mode = *ctx.mode_rx.borrow();
    match mode {
        RunnerMode::Running => {}
        RunnerMode::Starting => {
            admission.rollback(ctx).await;
            return None;
        }
        RunnerMode::Draining => {
            admission.rollback(ctx).await;
            return None;
        }
        RunnerMode::Stopping => {
            admission.cancellation.request_hard_cancellation().await;
        }
        RunnerMode::Stopped => {
            admission.rollback(ctx).await;
            return None;
        }
    }
    // claim() runs in the branch handler: non-interruptible, so a valid
    // successful claim is always paired with complete().
    let LocalAdmission {
        resource,
        cancellation,
    } = admission;
    let claim_started_at = Instant::now();
    let (claimed, admitted_resource, claim_returned_at) = match resource {
        LocalAdmissionResource::Fresh(budget_lease) => {
            let claimed = ctx.spawn_ctx.provider.claim(candidate).await;
            (
                claimed,
                AdmittedResource::Fresh(budget_lease),
                Instant::now(),
            )
        }
        LocalAdmissionResource::Reusable(reservation) => {
            let claimed = ctx.spawn_ctx.provider.claim(candidate).await;
            (
                claimed,
                AdmittedResource::Reusable(reservation),
                Instant::now(),
            )
        }
        LocalAdmissionResource::ExactSpeculative(speculative) => {
            let ExactSpeculationReservation {
                reservation,
                sandbox_id,
                idle_snapshot,
            } = speculative;
            let claim = async {
                let claimed = ctx.spawn_ctx.provider.claim(candidate).await;
                (claimed, Instant::now())
            };
            let preparation = prepare_exact_speculation(*reservation, run_id);
            let ((claimed, claim_returned_at), preparation) = tokio::join!(claim, preparation);
            let speculation = ExactSpeculation {
                outcome: preparation.outcome,
                sandbox_id,
                idle_snapshot,
                preparation_started_at: preparation.started_at,
                preparation_completed_at: preparation.completed_at,
                claim_started_at,
                claim_returned_at,
                unpark: preparation.unpark,
                guest_restore: preparation.guest_restore,
            };
            (
                claimed,
                AdmittedResource::ExactSpeculation(speculation),
                claim_returned_at,
            )
        }
        LocalAdmissionResource::Finalizing(finalizing) => {
            let claimed = ctx.spawn_ctx.provider.claim(candidate).await;
            (
                claimed,
                AdmittedResource::Finalizing(finalizing),
                Instant::now(),
            )
        }
    };
    let Some(claimed) = claimed else {
        // None means the job won't run here: either lost the race to another
        // runner, or the provider rejected the job. Release the reservation and
        // cancellation registration so the runner can continue.
        cancellation.unregister().await;
        rollback_admitted_resource(admitted_resource, run_id, workspace_disk_mb, ctx).await;
        return None;
    };
    if claimed.context().run_id != run_id {
        warn!(
            run_id = %run_id,
            context_run_id = %claimed.context().run_id,
            "provider returned claimed job with mismatched run_id"
        );
        cancellation.unregister().await;
        rollback_admitted_resource(admitted_resource, run_id, workspace_disk_mb, ctx).await;
        return None;
    }

    Some(AdmittedClaim {
        claimed,
        resource: admitted_resource,
        cancellation,
        claim_returned_at,
    })
}

async fn prepare_exact_speculation(
    reservation: ReservedIdleSandbox,
    run_id: RunId,
) -> ExactSpeculationPreparation {
    let preparation_started_at = Instant::now();
    let predicted_timezone = reservation.guest_timezone_intent().clone();
    let unpark_started_at = Instant::now();
    let unpark_result = reservation.try_unpark_for_speculation(run_id).await;
    let unpark_duration = unpark_started_at.elapsed();
    let (outcome, unpark_succeeded, guest_restore) = match unpark_result {
        SpeculativeIdleUnparkResult::Ready(sandbox) => {
            let restore_started_at = Instant::now();
            let restored = AssertUnwindSafe(restore_guest_state_with_intent(
                sandbox.sandbox(),
                run_id,
                &predicted_timezone,
            ))
            .catch_unwind()
            .await;
            let restore_duration = restore_started_at.elapsed();
            let (outcome, restore_succeeded) = match restored {
                Ok(Ok(())) => (ExactSpeculationOutcome::Prepared(sandbox), true),
                Ok(Err(error)) => (
                    ExactSpeculationOutcome::Failed {
                        destroy_job: Box::new(
                            sandbox.into_destroy_job("speculative_guest_restore_failed"),
                        ),
                        error: error.to_string(),
                    },
                    false,
                ),
                Err(_) => (
                    ExactSpeculationOutcome::Failed {
                        destroy_job: Box::new(
                            sandbox.into_destroy_job("speculative_guest_restore_panicked"),
                        ),
                        error: "speculative guest restore panicked".into(),
                    },
                    false,
                ),
            };
            (
                outcome,
                true,
                Some(RunnerPreSpawnOperationTiming {
                    duration: restore_duration,
                    succeeded: restore_succeeded,
                }),
            )
        }
        SpeculativeIdleUnparkResult::Failed { destroy_job, error } => (
            ExactSpeculationOutcome::Failed { destroy_job, error },
            false,
            None,
        ),
    };
    let preparation_completed_at = Instant::now();
    ExactSpeculationPreparation {
        outcome,
        started_at: preparation_started_at,
        completed_at: preparation_completed_at,
        unpark: RunnerPreSpawnOperationTiming {
            duration: unpark_duration,
            succeeded: unpark_succeeded,
        },
        guest_restore,
    }
}

async fn prepare_preference_candidate(
    candidate: JobCandidate,
    profile_name: &str,
    job_vcpu: u32,
    job_memory: u32,
    device_rate_limits: &Option<sandbox::DeviceRateLimits>,
    ctx: &DiscoveredJobContext<'_>,
) -> PreferencePreparation {
    let Some(preference) = candidate.runner_preference().cloned() else {
        return ordinary_preparation(candidate);
    };
    if preference.is_expired() {
        return ordinary_preparation(
            candidate.without_runner_preference(RunnerPreferenceRemovalReason::Expired),
        );
    }
    let Some(reuse_key) = candidate.reuse_key().map(str::to_owned) else {
        return ordinary_preparation(
            candidate.without_runner_preference(RunnerPreferenceRemovalReason::Cleared),
        );
    };

    let request = PreferenceCandidateRequest {
        candidate,
        preference: &preference,
        reuse_key: &reuse_key,
        profile_name,
        job_vcpu,
        job_memory,
        device_rate_limits,
        ctx,
    };
    prepare_ranked_preference_candidate(request, preference.tier()).await
}

async fn prepare_ranked_preference_candidate(
    request: PreferenceCandidateRequest<'_>,
    advertised_tier: RunnerPreferenceTier,
) -> PreferencePreparation {
    let PreferenceCandidateRequest {
        candidate,
        preference,
        reuse_key,
        profile_name,
        job_vcpu,
        job_memory,
        device_rate_limits,
        ctx,
    } = request;
    let selected = preference.targets(ctx.runner_identity);
    let history_generation_run_id = candidate.history_generation_run_id();

    if ranked_preference_allows(
        advertised_tier,
        RunnerPreferenceTier::ExactSandbox,
        selected,
    ) && let Some(history_generation_run_id) = history_generation_run_id
        && let Some(reservation) = reserve_reusable_idle(
            reuse_key,
            profile_name,
            device_rate_limits,
            Some(history_generation_run_id),
            ctx,
        )
        .await
    {
        return if reservation.guest_timezone_intent().is_usable_prediction() {
            exact_speculative_preparation(candidate, reservation, ctx).await
        } else {
            reusable_preparation(candidate, reservation)
        };
    }

    if advertised_tier == RunnerPreferenceTier::FinalizingPredecessor && selected {
        if let Some(history_generation_run_id) = history_generation_run_id
            && let Some(predecessor) = ctx.spawn_ctx.active_runs.finalizing_predecessor(
                history_generation_run_id,
                reuse_key,
                profile_name,
            )
        {
            return finalizing_preparation(
                candidate,
                predecessor,
                preference.deadline(),
                reuse_key,
                history_generation_run_id,
            );
        }
        return defer_preference_candidate(candidate, preference, reuse_key, ctx, true).await;
    }

    if ranked_preference_allows(
        advertised_tier,
        RunnerPreferenceTier::ReusableSandbox,
        selected,
    ) && let Some(reservation) =
        reserve_reusable_idle(reuse_key, profile_name, device_rate_limits, None, ctx).await
    {
        return reusable_preparation(candidate, reservation);
    }

    if ranked_preference_allows(
        advertised_tier,
        RunnerPreferenceTier::WorkspaceCache,
        selected,
    ) && has_compatible_workspace(reuse_key, profile_name, ctx)
        && let Some(lease) = ResourceBudget::try_reserve_lease(ctx.budget, job_vcpu, job_memory)
    {
        return PreferencePreparation::Ready(PreparedCandidate {
            candidate,
            resource: Some(LocalAdmissionResource::Fresh(lease)),
        });
    }

    defer_preference_candidate(candidate, preference, reuse_key, ctx, false).await
}

fn ranked_preference_allows(
    advertised_tier: RunnerPreferenceTier,
    local_tier: RunnerPreferenceTier,
    selected: bool,
) -> bool {
    if selected {
        local_tier.rank() >= advertised_tier.rank()
    } else {
        local_tier.rank() > advertised_tier.rank()
    }
}

fn has_compatible_workspace(
    reuse_key: &str,
    profile_name: &str,
    ctx: &DiscoveredJobContext<'_>,
) -> bool {
    current_local_held_workspace_states(ctx)
        .iter()
        .filter(|state| state.reuse_key == reuse_key)
        .flat_map(|state| &state.workspace_caches)
        .any(|workspace| {
            workspace.profile == profile_name
                && workspace.workspace_affinity_version == WORKSPACE_AFFINITY_VERSION
        })
}

fn ordinary_preparation(candidate: JobCandidate) -> PreferencePreparation {
    PreferencePreparation::Ready(PreparedCandidate {
        candidate,
        resource: None,
    })
}

fn reusable_preparation(
    candidate: JobCandidate,
    reservation: ReservedIdleActivation,
) -> PreferencePreparation {
    PreferencePreparation::Ready(PreparedCandidate {
        candidate,
        resource: Some(LocalAdmissionResource::Reusable(reservation)),
    })
}

async fn exact_speculative_preparation(
    candidate: JobCandidate,
    reservation: ReservedIdleActivation,
    ctx: &DiscoveredJobContext<'_>,
) -> PreferencePreparation {
    let sandbox_id = reservation.sandbox_id();
    let (reservation, idle_snapshot) = reservation.into_parts();
    if let Err(error) = ctx.status.set_idle_snapshot(idle_snapshot.clone()).await {
        warn!(%error, "failed to persist exact speculation idle reservation");
        rollback_reserved_idle_for_spawn(
            ReservedIdleActivation::new(reservation, idle_snapshot),
            ctx.spawn_ctx,
        )
        .await;
        return ordinary_preparation(candidate);
    }
    PreferencePreparation::Ready(PreparedCandidate {
        candidate,
        resource: Some(LocalAdmissionResource::ExactSpeculative(
            ExactSpeculationReservation {
                reservation: Box::new(reservation),
                sandbox_id,
                idle_snapshot,
            },
        )),
    })
}

fn finalizing_preparation(
    candidate: JobCandidate,
    predecessor: ActiveRunReuseProof,
    deadline: Instant,
    reuse_key: &str,
    history_generation_run_id: RunId,
) -> PreferencePreparation {
    PreferencePreparation::Ready(PreparedCandidate {
        candidate,
        resource: Some(LocalAdmissionResource::Finalizing(FinalizingAdmission {
            predecessor,
            deadline,
            reuse_key: reuse_key.to_owned(),
            history_generation_run_id,
        })),
    })
}

async fn defer_preference_candidate(
    candidate: JobCandidate,
    preference: &crate::provider::ActiveRunnerPreference,
    reuse_key: &str,
    ctx: &DiscoveredJobContext<'_>,
    retain: bool,
) -> PreferencePreparation {
    if preference.is_expired() {
        return ordinary_preparation(
            candidate.without_runner_preference(RunnerPreferenceRemovalReason::Expired),
        );
    }
    let delay = preference.remaining();
    info!(
        run_id = %candidate.run_id(),
        reuse_key_fingerprint = %diagnostic_reuse_key_fingerprint(reuse_key),
        reuse_key_kind = reuse_key_kind(reuse_key),
        preference_tier = ?preference.tier(),
        delay_ms = delay.as_millis(),
        retained = retain,
        "runner preference has no qualifying local resource, deferring claim"
    );
    ctx.spawn_ctx
        .provider
        .defer_poll_until(preference.deadline())
        .await;
    if retain {
        PreferencePreparation::Pending(candidate)
    } else {
        PreferencePreparation::Deferred
    }
}

fn diagnostic_reuse_key_fingerprint(reuse_key: &str) -> String {
    short_digest(reuse_key)
}

fn current_local_held_workspace_states(ctx: &DiscoveredJobContext<'_>) -> Vec<HeldWorkspaceState> {
    ctx.spawn_ctx
        .workspace_cache_snapshot
        .current_held_workspace_states(&ctx.spawn_ctx.active_runs, None)
}

async fn acquire_local_admission_resource(
    candidate: &JobCandidate,
    profile_name: &str,
    job_vcpu: u32,
    job_memory: u32,
    device_rate_limits: &Option<sandbox::DeviceRateLimits>,
    ctx: &mut DiscoveredJobContext<'_>,
) -> Option<LocalAdmissionResource> {
    let workspace_cache_possible = ctx.spawn_ctx.exec_config.workspace_cache.is_some()
        && candidate.reuse_key().is_some_and(|reuse_key| {
            ctx.spawn_ctx
                .workspace_cache_snapshot
                .might_contain_workspace_cache_reuse_key(reuse_key)
        });
    match select_idle_entries_for_pressure(
        ctx.idle_pool,
        ctx.status,
        &ctx.spawn_ctx.idle_destroy_tracker,
        ctx.budget,
        Vec::new(),
        IdlePressureRequest {
            run_id: candidate.run_id(),
            reuse_key: candidate.reuse_key(),
            profile_name,
            device_rate_limits,
            history_generation_run_id: None,
            allow_compatible_blank: !candidate.deferred_sandbox() && !workspace_cache_possible,
            vcpu: job_vcpu,
            memory_mb: job_memory,
            context: "candidate_admission_oldest",
        },
    )
    .await
    {
        IdlePressureSelection::Reusable(reservation) => {
            Some(LocalAdmissionResource::Reusable(reservation))
        }
        IdlePressureSelection::Fresh(lease) => {
            if let Some(reuse_key) = candidate.reuse_key()
                && let Some(reservation) =
                    reserve_reusable_idle(reuse_key, profile_name, device_rate_limits, None, ctx)
                        .await
            {
                drop(lease);
                return Some(LocalAdmissionResource::Reusable(reservation));
            }
            Some(LocalAdmissionResource::Fresh(lease))
        }
        IdlePressureSelection::Exhausted(retiring_leases) => {
            drop(retiring_leases);
            None
        }
    }
}

async fn reserve_reusable_idle(
    reuse_key: &str,
    profile_name: &str,
    device_rate_limits: &Option<sandbox::DeviceRateLimits>,
    history_generation_run_id: Option<RunId>,
    ctx: &DiscoveredJobContext<'_>,
) -> Option<ReservedIdleActivation> {
    reserve_reusable_idle_for_spawn(
        reuse_key,
        profile_name,
        device_rate_limits,
        history_generation_run_id,
        ctx.spawn_ctx,
    )
    .await
}

pub(super) async fn reserve_reusable_idle_for_spawn(
    reuse_key: &str,
    profile_name: &str,
    device_rate_limits: &Option<sandbox::DeviceRateLimits>,
    history_generation_run_id: Option<RunId>,
    ctx: &SpawnContext,
) -> Option<ReservedIdleActivation> {
    let (reservation, snapshot) = {
        let mut pool = ctx.idle_pool.lock().await;
        let reservation = match history_generation_run_id {
            Some(history_generation_run_id) => pool.reserve_reusable_generation(
                reuse_key,
                profile_name,
                device_rate_limits,
                history_generation_run_id,
            )?,
            None => pool.reserve_reusable(reuse_key, profile_name, device_rate_limits)?,
        };
        let snapshot = pool.status_snapshot();
        (reservation, snapshot)
    };
    Some(ReservedIdleActivation::new(reservation, snapshot))
}

pub(super) async fn reserve_exact_idle_for_spawn(
    reuse_key: &str,
    profile_name: &str,
    device_rate_limits: &Option<sandbox::DeviceRateLimits>,
    history_generation_run_id: RunId,
    ctx: &SpawnContext,
) -> Result<ReservedIdleActivation, ExactIdleReservationMiss> {
    let (reservation, snapshot) = {
        let mut pool = ctx.idle_pool.lock().await;
        let reservation = pool.reserve_reusable_generation_with_reason(
            reuse_key,
            profile_name,
            device_rate_limits,
            history_generation_run_id,
        )?;
        let snapshot = pool.status_snapshot();
        (reservation, snapshot)
    };
    Ok(ReservedIdleActivation::new(reservation, snapshot))
}

pub(super) async fn rollback_reserved_idle_for_spawn(
    reservation: ReservedIdleActivation,
    ctx: &SpawnContext,
) {
    let (reservation, _) = reservation.into_parts();
    let (restore_result, snapshot) = {
        let mut pool = ctx.idle_pool.lock().await;
        let restore_result = pool.restore_reserved(reservation);
        let snapshot = pool.status_snapshot();
        (restore_result, snapshot)
    };
    set_idle_status_snapshot(&ctx.status, snapshot).await;
    if let RestoreReservedIdleResult::Replaced(destroy_job)
    | RestoreReservedIdleResult::Rejected(destroy_job) = restore_result
    {
        destroy_idle_jobs_and_wait(
            vec![*destroy_job],
            "finalizing_claim_reserved_idle_rollback",
        )
        .await;
        ctx.reuse_state_notify.notify_one();
    }
}

async fn rollback_untracked_resource(
    resource: LocalAdmissionResource,
    ctx: &mut DiscoveredJobContext<'_>,
) {
    match resource {
        LocalAdmissionResource::Fresh(budget_lease) => drop(budget_lease),
        LocalAdmissionResource::Finalizing(_) => {}
        LocalAdmissionResource::Reusable(reservation) => {
            rollback_reserved_idle_for_spawn(reservation, ctx.spawn_ctx).await;
        }
        LocalAdmissionResource::ExactSpeculative(speculative) => {
            rollback_reserved_idle_for_spawn(
                ReservedIdleActivation::new(*speculative.reservation, speculative.idle_snapshot),
                ctx.spawn_ctx,
            )
            .await;
        }
    }
}

async fn rollback_admitted_resource(
    resource: AdmittedResource,
    run_id: RunId,
    workspace_disk_mb: u32,
    ctx: &mut DiscoveredJobContext<'_>,
) {
    let resource = match resource {
        AdmittedResource::Fresh(lease) => SandboxAdmittedResource::Fresh(lease),
        AdmittedResource::Reusable(reservation) => SandboxAdmittedResource::Reusable(reservation),
        AdmittedResource::ExactSpeculation(speculation) => {
            SandboxAdmittedResource::ExactSpeculation(speculation)
        }
        AdmittedResource::Finalizing(_) => return,
    };
    rollback_sandbox_admitted_resource(resource, run_id, workspace_disk_mb, ctx).await;
}

async fn rollback_sandbox_admitted_resource(
    resource: SandboxAdmittedResource,
    run_id: RunId,
    workspace_disk_mb: u32,
    ctx: &mut DiscoveredJobContext<'_>,
) {
    match resource {
        SandboxAdmittedResource::Fresh(budget_lease) => drop(budget_lease),
        SandboxAdmittedResource::Reusable(reservation) => {
            rollback_untracked_resource(LocalAdmissionResource::Reusable(reservation), ctx).await;
        }
        SandboxAdmittedResource::ExactSpeculation(speculation) => {
            rollback_exact_speculation(speculation, run_id, workspace_disk_mb, ctx).await;
        }
    }
}

async fn rollback_exact_speculation(
    speculation: ExactSpeculation,
    run_id: RunId,
    workspace_disk_mb: u32,
    ctx: &mut DiscoveredJobContext<'_>,
) {
    rollback_exact_speculation_outcome(speculation.outcome, run_id, workspace_disk_mb, ctx).await;
}

async fn rollback_exact_speculation_outcome(
    outcome: ExactSpeculationOutcome,
    run_id: RunId,
    workspace_disk_mb: u32,
    ctx: &mut DiscoveredJobContext<'_>,
) {
    let destroy_job = match outcome {
        ExactSpeculationOutcome::Prepared(sandbox) => {
            match sandbox
                .repark_for_claim_rollback(run_id, u64::from(workspace_disk_mb) * 1024 * 1024)
                .await
            {
                SpeculativeReparkResult::Reparked(reservation) => {
                    let (restore_result, snapshot) = {
                        let mut pool = ctx.idle_pool.lock().await;
                        let restore_result = pool.restore_reserved(*reservation);
                        let snapshot = pool.status_snapshot();
                        (restore_result, snapshot)
                    };
                    set_idle_status_snapshot(ctx.status, snapshot).await;
                    ctx.spawn_ctx.reuse_state_notify.notify_one();
                    match restore_result {
                        RestoreReservedIdleResult::Restored => None,
                        RestoreReservedIdleResult::Replaced(destroy_job)
                        | RestoreReservedIdleResult::Rejected(destroy_job) => Some(destroy_job),
                    }
                }
                SpeculativeReparkResult::Destroy {
                    destroy_job,
                    reason,
                    error,
                    expected_capacity_rejection,
                } => {
                    if expected_capacity_rejection {
                        info!(
                            run_id = %run_id,
                            reason,
                            error,
                            "speculative exact-reuse rollback rejected by idle capacity admission"
                        );
                    } else {
                        warn!(
                            run_id = %run_id,
                            reason,
                            error,
                            "speculative exact-reuse rollback could not restore idle ownership"
                        );
                    }
                    Some(destroy_job)
                }
            }
        }
        ExactSpeculationOutcome::Failed { destroy_job, error } => {
            warn!(
                run_id = %run_id,
                error,
                "speculative exact-reuse preparation failed before claim resolved"
            );
            Some(destroy_job)
        }
    };
    if let Some(destroy_job) = destroy_job {
        destroy_idle_jobs_and_wait(vec![*destroy_job], "speculative_exact_reuse_claim_rollback")
            .await;
        ctx.spawn_ctx.reuse_state_notify.notify_one();
    }
}

pub(super) enum ReservedActivation {
    Ready {
        reuse_entry: Option<Box<ReusableIdleSandbox>>,
        active_lease: BudgetLease,
        reuse_result: SandboxReuseResult,
        idle_snapshot: IdlePoolSnapshot,
    },
    CannotStart {
        budget_lease: Option<BudgetLease>,
        reuse_result: SandboxReuseResult,
        error: String,
    },
}

enum FreshFallbackActivation {
    Ready {
        active_lease: BudgetLease,
        reuse_result: SandboxReuseResult,
        idle_snapshot: IdlePoolSnapshot,
    },
    CannotStart {
        budget_lease: BudgetLease,
        reuse_result: SandboxReuseResult,
        error: String,
    },
}

impl From<FreshFallbackActivation> for ReservedActivation {
    fn from(activation: FreshFallbackActivation) -> Self {
        match activation {
            FreshFallbackActivation::Ready {
                active_lease,
                reuse_result,
                idle_snapshot,
            } => Self::Ready {
                reuse_entry: None,
                active_lease,
                reuse_result,
                idle_snapshot,
            },
            FreshFallbackActivation::CannotStart {
                budget_lease,
                reuse_result,
                error,
            } => Self::CannotStart {
                budget_lease: Some(budget_lease),
                reuse_result,
                error,
            },
        }
    }
}

enum PendingExactActivation {
    Prepared {
        sandbox: Box<SpeculativeIdleSandbox>,
        guest_state_prepared: bool,
        idle_snapshot: IdlePoolSnapshot,
    },
    FreshFallback(FreshFallbackActivation),
}

impl From<FreshFallbackActivation> for PendingExactActivation {
    fn from(activation: FreshFallbackActivation) -> Self {
        Self::FreshFallback(activation)
    }
}

enum CancelledExactResource {
    Prepared(Box<SpeculativeIdleSandbox>),
    Fresh(BudgetLease),
}

enum ExactActivation {
    Ready {
        reuse_entry: Option<Box<ReusableIdleSandbox>>,
        active_lease: BudgetLease,
        reuse_result: SandboxReuseResult,
        idle_snapshot: IdlePoolSnapshot,
        transfer_guard: OwnedMutexGuard<()>,
    },
    Cancelled {
        resource: CancelledExactResource,
        reuse_result: Option<SandboxReuseResult>,
    },
    CannotStart {
        budget_lease: BudgetLease,
        reuse_result: SandboxReuseResult,
        error: String,
    },
}

async fn activate_speculated_exact(
    speculation: ExactSpeculation,
    request: ReservedActivationRequest<'_>,
    ctx: &DiscoveredJobContext<'_>,
    pre_spawn_timing: &mut RunnerPreSpawnTiming,
) -> PendingExactActivation {
    let ReservedActivationRequest {
        run_id,
        profile_name,
        device_rate_limits: _,
        workspace_disk_mb,
        context,
    } = request;
    let ExactSpeculation {
        outcome,
        sandbox_id,
        idle_snapshot,
        preparation_started_at,
        preparation_completed_at,
        claim_started_at,
        claim_returned_at,
        unpark,
        guest_restore,
    } = speculation;
    let overlap_started_at = preparation_started_at.max(claim_started_at);
    let overlap_completed_at = preparation_completed_at.min(claim_returned_at);
    let claim_overlap = overlap_completed_at.saturating_duration_since(overlap_started_at);
    let post_claim_remainder =
        preparation_completed_at.saturating_duration_since(claim_returned_at);
    let mut speculation_timing = ExactReuseSpeculationTiming {
        unpark,
        guest_restore,
        claim_overlap,
        post_claim_remainder,
        timezone_correction: None,
        timezone_assumption: None,
    };
    pre_spawn_timing.record_exact_reuse_speculation(speculation_timing);
    let sandbox = match outcome {
        ExactSpeculationOutcome::Prepared(sandbox) => sandbox,
        ExactSpeculationOutcome::Failed { destroy_job, error } => {
            warn!(
                run_id = %run_id,
                error,
                "speculative exact-reuse preparation failed, destroying before fresh fallback"
            );
            return cleanup_claimed_speculation_for_fresh_fallback(
                *destroy_job,
                SandboxReuseResult::UnparkFailed,
                "speculative_exact_reuse_prepare_failed",
                run_id,
                sandbox_id,
                &idle_snapshot,
                ctx.spawn_ctx,
            )
            .await;
        }
    };

    let reserved_reuse_key = sandbox.reuse_key().map(str::to_owned);
    let requested_reuse_key = context.reuse_key();
    if requested_reuse_key != reserved_reuse_key.as_deref() {
        warn!(
            run_id = %run_id,
            reuse_key_fingerprint = reserved_reuse_key.as_deref().map(diagnostic_reuse_key_fingerprint),
            reuse_key_kind = reserved_reuse_key.as_deref().map(reuse_key_kind),
            "claimed reuse key does not match speculatively prepared idle sandbox"
        );
        return cleanup_claimed_speculation_for_fresh_fallback(
            sandbox.into_destroy_job("speculative_reuse_session_mismatch"),
            if requested_reuse_key.is_none() {
                SandboxReuseResult::NoReuseKey
            } else {
                SandboxReuseResult::PoolMiss
            },
            "speculative_reuse_session_mismatch",
            run_id,
            sandbox_id,
            &idle_snapshot,
            ctx.spawn_ctx,
        )
        .await;
    }

    if let Some(cache) = ctx.spawn_ctx.exec_config.workspace_cache.as_ref() {
        let started_at = Instant::now();
        let validation = sandbox.validate_workspace_promotion_identity(
            cache,
            CANONICAL_WORKING_DIR,
            u64::from(workspace_disk_mb) * 1024 * 1024,
        );
        pre_spawn_timing.record_phase_elapsed(
            RunnerPreSpawnPhase::WorkspacePromotionValidation,
            started_at,
        );
        if let Err(mismatch) = validation {
            warn!(
                run_id = %run_id,
                reuse_key_fingerprint = reserved_reuse_key.as_deref().map(diagnostic_reuse_key_fingerprint),
                reuse_key_kind = reserved_reuse_key.as_deref().map(reuse_key_kind),
                profile = %profile_name,
                mismatch = mismatch.as_str(),
                "workspace promotion identity mismatch after speculative preparation"
            );
            return cleanup_claimed_speculation_for_fresh_fallback(
                sandbox.into_destroy_job("speculative_workspace_promotion_mismatch"),
                SandboxReuseResult::PoolMiss,
                "speculative_workspace_promotion_mismatch",
                run_id,
                sandbox_id,
                &idle_snapshot,
                ctx.spawn_ctx,
            )
            .await;
        }
    }

    let claimed_timezone = GuestTimezoneIntent::from_context(context);
    let assumption = sandbox.guest_timezone_intent().compare(&claimed_timezone);
    let mut correction_duration = None;
    let mut correction_succeeded = false;
    let guest_state_prepared = match assumption {
        GuestTimezoneAssumption::Match => true,
        GuestTimezoneAssumption::Mismatch => {
            let correction_started_at = Instant::now();
            let corrected = AssertUnwindSafe(try_sync_guest_timezone_intent(
                sandbox.sandbox(),
                run_id,
                &claimed_timezone,
            ))
            .catch_unwind()
            .await;
            correction_duration = Some(correction_started_at.elapsed());
            match corrected {
                Ok(Ok(outcome)) => {
                    correction_succeeded = outcome == GuestTimezoneSyncOutcome::Applied;
                }
                Ok(Err(error)) => {
                    speculation_timing.timezone_correction =
                        correction_duration.map(|duration| RunnerPreSpawnOperationTiming {
                            duration,
                            succeeded: false,
                        });
                    speculation_timing.timezone_assumption = Some(assumption);
                    pre_spawn_timing.record_exact_reuse_speculation(speculation_timing);
                    warn!(
                        run_id = %run_id,
                        error = %error,
                        "speculative exact-reuse timezone correction transport failed"
                    );
                    return cleanup_claimed_speculation_for_fresh_fallback(
                        sandbox.into_destroy_job("speculative_timezone_correction_failed"),
                        SandboxReuseResult::UnparkFailed,
                        "speculative_timezone_correction_failed",
                        run_id,
                        sandbox_id,
                        &idle_snapshot,
                        ctx.spawn_ctx,
                    )
                    .await;
                }
                Err(_) => {
                    speculation_timing.timezone_correction =
                        correction_duration.map(|duration| RunnerPreSpawnOperationTiming {
                            duration,
                            succeeded: false,
                        });
                    speculation_timing.timezone_assumption = Some(assumption);
                    pre_spawn_timing.record_exact_reuse_speculation(speculation_timing);
                    warn!(
                        run_id = %run_id,
                        "speculative exact-reuse timezone correction panicked"
                    );
                    return cleanup_claimed_speculation_for_fresh_fallback(
                        sandbox.into_destroy_job("speculative_timezone_correction_panicked"),
                        SandboxReuseResult::UnparkFailed,
                        "speculative_timezone_correction_panicked",
                        run_id,
                        sandbox_id,
                        &idle_snapshot,
                        ctx.spawn_ctx,
                    )
                    .await;
                }
            }
            true
        }
        GuestTimezoneAssumption::Unknown => false,
    };
    speculation_timing.timezone_correction =
        correction_duration.map(|duration| RunnerPreSpawnOperationTiming {
            duration,
            succeeded: correction_succeeded,
        });
    speculation_timing.timezone_assumption = Some(assumption);
    pre_spawn_timing.record_exact_reuse_speculation(speculation_timing);

    PendingExactActivation::Prepared {
        sandbox,
        guest_state_prepared,
        idle_snapshot,
    }
}

async fn finish_exact_activation(
    activation: PendingExactActivation,
    cancellation: &RunCancellationHandle,
    run_id: RunId,
) -> ExactActivation {
    match activation {
        PendingExactActivation::Prepared {
            sandbox,
            guest_state_prepared,
            idle_snapshot,
        } => {
            let transfer_guard = cancellation.transfer_guard().await;
            if cancellation.is_cancelled() {
                drop(transfer_guard);
                return ExactActivation::Cancelled {
                    resource: CancelledExactResource::Prepared(sandbox),
                    reuse_result: None,
                };
            }

            let reuse_key = sandbox.reuse_key().map(str::to_owned);
            let (reuse_entry, active_lease) = sandbox.commit(guest_state_prepared);
            info!(
                run_id = %run_id,
                reuse_key_fingerprint = reuse_key.as_deref().map(diagnostic_reuse_key_fingerprint),
                reuse_key_kind = reuse_key.as_deref().map(reuse_key_kind),
                "committing speculatively prepared exact-reuse sandbox"
            );
            ExactActivation::Ready {
                reuse_entry: Some(Box::new(reuse_entry)),
                active_lease,
                reuse_result: SandboxReuseResult::Reused,
                idle_snapshot,
                transfer_guard,
            }
        }
        PendingExactActivation::FreshFallback(FreshFallbackActivation::Ready {
            active_lease,
            reuse_result,
            idle_snapshot,
        }) => {
            let transfer_guard = cancellation.transfer_guard().await;
            if cancellation.is_cancelled() {
                drop(transfer_guard);
                return ExactActivation::Cancelled {
                    resource: CancelledExactResource::Fresh(active_lease),
                    reuse_result: Some(reuse_result),
                };
            }
            ExactActivation::Ready {
                reuse_entry: None,
                active_lease,
                reuse_result,
                idle_snapshot,
                transfer_guard,
            }
        }
        PendingExactActivation::FreshFallback(FreshFallbackActivation::CannotStart {
            budget_lease,
            reuse_result,
            error,
        }) => {
            let transfer_guard = cancellation.transfer_guard().await;
            if cancellation.is_cancelled() {
                drop(transfer_guard);
                return ExactActivation::Cancelled {
                    resource: CancelledExactResource::Fresh(budget_lease),
                    reuse_result: Some(reuse_result),
                };
            }
            drop(transfer_guard);
            ExactActivation::CannotStart {
                budget_lease,
                reuse_result,
                error,
            }
        }
    }
}

pub(super) async fn activate_reserved_idle(
    reservation: ReservedIdleActivation,
    request: ReservedActivationRequest<'_>,
    ctx: &SpawnContext,
    pre_spawn_timing: &mut RunnerPreSpawnTiming,
) -> ReservedActivation {
    let (reservation, idle_snapshot) = reservation.into_parts();
    let ReservedActivationRequest {
        run_id,
        profile_name,
        device_rate_limits,
        workspace_disk_mb,
        context,
    } = request;
    let started_at = Instant::now();
    let requested_reuse_key = context.reuse_key();
    // A matching exact sandbox can park while the provider claim is in
    // flight. Preserve the normal exact-over-blank priority without giving up
    // the blank reservation that owns admission capacity during that wait.
    let (reservation, idle_snapshot) = match (reservation.kind(), requested_reuse_key) {
        (IdleSandboxKind::Blank, Some(reuse_key)) => {
            let mut pool = ctx.idle_pool.lock().await;
            if let Some(exact) = pool.reserve_reusable(reuse_key, profile_name, device_rate_limits)
            {
                let restore_result = pool.restore_reserved(reservation);
                let snapshot = pool.status_snapshot();
                drop(pool);
                if let RestoreReservedIdleResult::Replaced(destroy_job)
                | RestoreReservedIdleResult::Rejected(destroy_job) = restore_result
                {
                    spawn_idle_destroy_job(
                        &ctx.idle_destroy_tracker,
                        *destroy_job,
                        "reserved_blank_exact_priority_restore_rejected",
                    );
                }
                (exact, snapshot)
            } else {
                drop(pool);
                (reservation, idle_snapshot)
            }
        }
        (IdleSandboxKind::Exact | IdleSandboxKind::Blank, _) => (reservation, idle_snapshot),
    };
    let reservation_kind = reservation.kind();
    let reserved_reuse_key = reservation.reuse_key().map(str::to_owned);
    let miss_result = if requested_reuse_key.is_some() {
        SandboxReuseResult::PoolMiss
    } else {
        SandboxReuseResult::NoReuseKey
    };
    let activation_reuse_result = match reservation_kind {
        IdleSandboxKind::Exact => SandboxReuseResult::Reused,
        IdleSandboxKind::Blank => miss_result,
    };
    let fallback_reuse_result = match reservation_kind {
        IdleSandboxKind::Exact => SandboxReuseResult::PoolMiss,
        IdleSandboxKind::Blank => miss_result,
    };
    let unpark_failure_reuse_result = match reservation_kind {
        IdleSandboxKind::Exact => SandboxReuseResult::UnparkFailed,
        IdleSandboxKind::Blank => miss_result,
    };
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::IdleReuseLookup, started_at);

    let claimed_workspace_cache_reuse_key = if reservation_kind == IdleSandboxKind::Blank {
        let started_at = Instant::now();
        let possible = ctx.exec_config.workspace_cache.is_some()
            && requested_reuse_key.is_some_and(|reuse_key| {
                ctx.workspace_cache_snapshot
                    .might_contain_workspace_cache_reuse_key(reuse_key)
            });
        pre_spawn_timing
            .record_phase_elapsed(RunnerPreSpawnPhase::WorkspaceCacheStateLookup, started_at);
        possible
    } else {
        false
    };
    if claimed_workspace_cache_reuse_key {
        return cleanup_reserved_for_fresh_fallback(
            reservation.into_destroy_job(),
            fallback_reuse_result,
            "reserved_blank_workspace_cache_priority",
            ctx,
        )
        .await
        .into();
    }

    if reservation.profile_name() != profile_name
        || reservation.device_rate_limits() != device_rate_limits
    {
        let reuse_key_fingerprint = reserved_reuse_key
            .as_deref()
            .map(diagnostic_reuse_key_fingerprint);
        warn!(
            run_id = %run_id,
            reuse_key_fingerprint,
            reuse_key_kind = reserved_reuse_key.as_deref().map(reuse_key_kind),
            profile = %profile_name,
            "reserved idle sandbox configuration does not match claimed job, destroying before fresh fallback"
        );
        return cleanup_reserved_for_fresh_fallback(
            reservation.into_destroy_job(),
            fallback_reuse_result,
            "reserved_reuse_configuration_mismatch",
            ctx,
        )
        .await
        .into();
    }

    if reservation_kind == IdleSandboxKind::Exact
        && requested_reuse_key != reserved_reuse_key.as_deref()
    {
        let reuse_key_fingerprint = reserved_reuse_key
            .as_deref()
            .map(diagnostic_reuse_key_fingerprint);
        warn!(
            run_id = %run_id,
            reuse_key_fingerprint,
            reuse_key_kind = reserved_reuse_key.as_deref().map(reuse_key_kind),
            "claimed reuse key does not match reserved idle sandbox, destroying before fresh fallback"
        );
        return cleanup_reserved_for_fresh_fallback(
            reservation.into_destroy_job(),
            miss_result,
            "reserved_reuse_session_mismatch",
            ctx,
        )
        .await
        .into();
    }

    if let Some(cache) = ctx.exec_config.workspace_cache.as_ref() {
        let started_at = Instant::now();
        let validation = reservation.validate_workspace_promotion_identity(
            cache,
            CANONICAL_WORKING_DIR,
            u64::from(workspace_disk_mb) * 1024 * 1024,
        );
        pre_spawn_timing.record_phase_elapsed(
            RunnerPreSpawnPhase::WorkspacePromotionValidation,
            started_at,
        );
        if let Err(mismatch) = validation {
            warn!(
                run_id = %run_id,
                reuse_key_fingerprint = reserved_reuse_key.as_deref().map(diagnostic_reuse_key_fingerprint),
                reuse_key_kind = reserved_reuse_key.as_deref().map(reuse_key_kind),
                profile = %profile_name,
                mismatch = mismatch.as_str(),
                "workspace promotion identity mismatch, destroying reserved idle sandbox before fresh fallback"
            );
            return cleanup_reserved_for_fresh_fallback(
                reservation.into_destroy_job_without_workspace_promotion_for_mismatch(),
                fallback_reuse_result,
                "reserved_reuse_workspace_promotion_mismatch",
                ctx,
            )
            .await
            .into();
        }
    }

    let sandbox_id = reservation.sandbox_id();
    let status_started_at = Instant::now();
    if let Err(error) = add_preparing_run_with_idle_status_snapshot(
        &ctx.status,
        run_id,
        sandbox_id,
        idle_snapshot.clone(),
    )
    .await
    {
        warn!(
            run_id = %run_id,
            sandbox_id = %sandbox_id,
            %error,
            activation_phase = "preparing_commit",
            recovery_outcome = "restore_parked",
            "failed to persist reserved sandbox activation ownership"
        );
        recover_failed_parked_activation_status(
            ReservedIdleActivation::new(reservation, idle_snapshot),
            run_id,
            sandbox_id,
            ctx,
        )
        .await;
        return ReservedActivation::CannotStart {
            budget_lease: None,
            reuse_result: fallback_reuse_result,
            error: format!("persist preparing reuse ownership: {error}"),
        };
    }
    pre_spawn_timing
        .record_phase_elapsed(RunnerPreSpawnPhase::ActiveStatusPublish, status_started_at);
    info!(
        run_id = %run_id,
        sandbox_id = %sandbox_id,
        activation_phase = "preparing_committed",
        "reserved sandbox activation ownership persisted"
    );
    #[cfg(test)]
    ctx.test_observer
        .notify_reserved_preparing_committed(run_id)
        .await;

    let started_at = Instant::now();
    let unpark_result = reservation.try_unpark_for_run(run_id).await;
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::IdleUnpark, started_at);
    match unpark_result {
        IdleUnparkResult::Reused {
            sandbox,
            budget_lease,
        } => {
            info!(
                run_id = %run_id,
                idle_kind = ?reservation_kind,
                reuse_key_fingerprint = reserved_reuse_key.as_deref().map(diagnostic_reuse_key_fingerprint),
                reuse_key_kind = reserved_reuse_key.as_deref().map(reuse_key_kind),
                "activating pre-claim reserved idle sandbox"
            );
            ReservedActivation::Ready {
                reuse_entry: Some(sandbox),
                active_lease: budget_lease,
                reuse_result: activation_reuse_result,
                idle_snapshot,
            }
        }
        IdleUnparkResult::Failed { destroy_job, error } => {
            warn!(
                run_id = %run_id,
                reuse_key_fingerprint = reserved_reuse_key.as_deref().map(diagnostic_reuse_key_fingerprint),
                reuse_key_kind = reserved_reuse_key.as_deref().map(reuse_key_kind),
                error = %error,
                "reserved idle sandbox unpark failed, destroying before fresh fallback"
            );
            let activation = cleanup_reserved_for_fresh_fallback(
                *destroy_job,
                unpark_failure_reuse_result,
                "reserved_reuse_unpark_failed",
                ctx,
            )
            .await;
            if matches!(activation, FreshFallbackActivation::CannotStart { .. }) {
                retain_uncertain_activation_ownership(
                    &ctx.status,
                    &ctx.orphaned_active_runs,
                    run_id,
                    sandbox_id,
                    "reserved_reuse_unpark_failed",
                );
            }
            activation.into()
        }
    }
}

async fn recover_failed_parked_activation_status(
    reservation: ReservedIdleActivation,
    run_id: RunId,
    sandbox_id: SandboxId,
    ctx: &SpawnContext,
) {
    remove_failed_activation_status(&ctx.status, run_id, sandbox_id).await;
    rollback_reserved_idle_for_spawn(reservation, ctx).await;
}

async fn remove_failed_activation_status(
    status: &StatusTracker,
    run_id: RunId,
    sandbox_id: SandboxId,
) {
    match status.remove_run_if_matching(run_id, sandbox_id).await {
        Ok(true) => {}
        Ok(false) => {
            warn!(
                run_id = %run_id,
                sandbox_id = %sandbox_id,
                "failed activation status had already changed before recovery"
            );
        }
        Err(error) => {
            warn!(
                run_id = %run_id,
                sandbox_id = %sandbox_id,
                %error,
                "failed to persist active status removal during activation recovery"
            );
        }
    }
}

fn retain_uncertain_activation_ownership(
    status: &StatusTracker,
    orphaned_active_runs: &super::orphan_reap::OrphanedActiveRuns,
    run_id: RunId,
    sandbox_id: SandboxId,
    reason: &'static str,
) {
    warn!(
        run_id = %run_id,
        sandbox_id = %sandbox_id,
        recovery_reason = reason,
        recovery_outcome = "orphaned_after_uncertain_destroy",
        "activation cleanup could not prove sandbox destruction; keeping active status for orphan reconciliation"
    );
    OwnershipTransitions::new(status)
        .active_ownership_unknown(orphaned_active_runs, RunSandbox::new(run_id, sandbox_id));
}

async fn cleanup_claimed_speculation_for_fresh_fallback(
    destroy_job: crate::idle_pool::IdleDestroyJob,
    reuse_result: SandboxReuseResult,
    cleanup_context: &'static str,
    run_id: RunId,
    sandbox_id: SandboxId,
    idle_snapshot: &IdlePoolSnapshot,
    ctx: &SpawnContext,
) -> PendingExactActivation {
    let activation =
        cleanup_reserved_for_fresh_fallback(destroy_job, reuse_result, cleanup_context, ctx).await;
    if matches!(activation, FreshFallbackActivation::CannotStart { .. }) {
        if let Err(error) = add_preparing_run_with_idle_status_snapshot(
            &ctx.status,
            run_id,
            sandbox_id,
            idle_snapshot.clone(),
        )
        .await
        {
            warn!(
                run_id = %run_id,
                sandbox_id = %sandbox_id,
                %error,
                recovery_reason = cleanup_context,
                "failed to persist uncertain speculative activation ownership"
            );
        }
        retain_uncertain_activation_ownership(
            &ctx.status,
            &ctx.orphaned_active_runs,
            run_id,
            sandbox_id,
            cleanup_context,
        );
    }
    activation.into()
}

async fn cleanup_reserved_for_fresh_fallback(
    destroy_job: crate::idle_pool::IdleDestroyJob,
    reuse_result: SandboxReuseResult,
    cleanup_context: &'static str,
    ctx: &SpawnContext,
) -> FreshFallbackActivation {
    let cleanup = destroy_job.run_retaining_lease(cleanup_context).await;
    match cleanup.outcome {
        DestroyOutcome::Completed => FreshFallbackActivation::Ready {
            active_lease: cleanup.budget_lease,
            reuse_result,
            idle_snapshot: ctx.idle_pool.lock().await.status_snapshot(),
        },
        DestroyOutcome::Uncertain => FreshFallbackActivation::CannotStart {
            budget_lease: cleanup.budget_lease,
            reuse_result,
            error: "reserved idle sandbox cleanup was uncertain; fresh replacement was not started"
                .to_string(),
        },
    }
}

async fn complete_claimed_without_sandbox(
    claimed: ClaimedJob,
    cancellation: RunCancellationRegistration,
    resource: SandboxAdmittedResource,
    workspace_disk_mb: u32,
    reuse_result: Option<SandboxReuseResult>,
    failure: crate::executor::ExecutionFailure,
    ctx: &mut DiscoveredJobContext<'_>,
) {
    let run_id = complete_claimed_failure(claimed, cancellation, reuse_result, failure, ctx).await;
    rollback_sandbox_admitted_resource(resource, run_id, workspace_disk_mb, ctx).await;
}

async fn complete_claimed_failure(
    claimed: ClaimedJob,
    cancellation: RunCancellationRegistration,
    reuse_result: Option<SandboxReuseResult>,
    failure: crate::executor::ExecutionFailure,
    ctx: &DiscoveredJobContext<'_>,
) -> RunId {
    let (context, completion_auth, active_input_source) = claimed.into_parts();
    let run_id = context.run_id;
    drop(active_input_source);
    ctx.spawn_ctx
        .provider
        .complete(
            CompleteRequest {
                run_id,
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
    ctx.spawn_ctx.provider.claimed_actor_gone(run_id).await;
    cancellation.unregister().await;
    run_id
}

async fn try_reuse_from_pool(
    run_id: RunId,
    request: ReuseAdmissionRequest<'_>,
    ctx: &mut DiscoveredJobContext<'_>,
    pre_spawn_timing: &mut RunnerPreSpawnTiming,
    cancellation: &RunCancellationHandle,
) -> Result<
    (
        Option<ReusableIdleSandbox>,
        BudgetLease,
        SandboxReuseResult,
        Option<IdlePoolSnapshot>,
        bool,
        Option<OwnedMutexGuard<()>>,
    ),
    ReuseFromPoolFailure,
> {
    let ReuseAdmissionRequest {
        profile_name,
        device_rate_limits,
        workspace_disk_mb,
        context,
        job_lease,
    } = request;

    if context
        .pi_launch_config
        .as_ref()
        .and_then(|launch| launch.get("apiFirstTurn"))
        .and_then(|handoff| handoff.get("schemaVersion"))
        .and_then(serde_json::Value::as_u64)
        == Some(2)
    {
        // v4 is demand-only. A blank pool entry is already activated before
        // the normal spawn binding, so it cannot provide our release proof.
        return Ok((
            None,
            job_lease,
            SandboxReuseResult::NoReuseKey,
            None,
            false,
            None,
        ));
    }

    let reuse_key = context.reuse_key();
    let miss_result = if reuse_key.is_some() {
        SandboxReuseResult::PoolMiss
    } else {
        SandboxReuseResult::NoReuseKey
    };
    let started_at = Instant::now();
    // Take the entry under the pool lock, then drop the lock before any awaits
    // so unpark does not block other take/park operations.
    let exact = {
        let mut pool = ctx.idle_pool.lock().await;
        reuse_key
            .and_then(|reuse_key| pool.take_reserved(reuse_key))
            .map(|entry| (entry, pool.status_snapshot()))
    };
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::IdleReuseLookup, started_at);
    let started_at = Instant::now();
    let claimed_workspace_cache_reuse_key = ctx.spawn_ctx.exec_config.workspace_cache.is_some()
        && reuse_key.is_some_and(|reuse_key| {
            ctx.spawn_ctx
                .workspace_cache_snapshot
                .might_contain_workspace_cache_reuse_key(reuse_key)
        });
    pre_spawn_timing
        .record_phase_elapsed(RunnerPreSpawnPhase::WorkspaceCacheStateLookup, started_at);
    let taken = match exact {
        Some(exact) => Some(exact),
        None if !claimed_workspace_cache_reuse_key => {
            let mut pool = ctx.idle_pool.lock().await;
            reuse_key
                .and_then(|reuse_key| pool.take_reserved(reuse_key))
                .or_else(|| pool.reserve_blank(profile_name, device_rate_limits))
                .map(|entry| (entry, pool.status_snapshot()))
        }
        None => None,
    };
    let took_idle_session = taken.is_some();
    let needs_reuse_state_refresh = took_idle_session || claimed_workspace_cache_reuse_key;
    match taken {
        Some((entry, snapshot))
            if entry.profile_name() == profile_name
                && entry.device_rate_limits() == device_rate_limits =>
        {
            let entry_kind = entry.kind();
            let entry_reuse_key = entry.reuse_key().map(str::to_owned);
            let activation_reuse_result = match entry_kind {
                IdleSandboxKind::Exact => SandboxReuseResult::Reused,
                IdleSandboxKind::Blank => miss_result,
            };
            let fallback_reuse_result = match entry_kind {
                IdleSandboxKind::Exact => SandboxReuseResult::PoolMiss,
                IdleSandboxKind::Blank => miss_result,
            };
            let unpark_failure_reuse_result = match entry_kind {
                IdleSandboxKind::Exact => SandboxReuseResult::UnparkFailed,
                IdleSandboxKind::Blank => miss_result,
            };
            if let Some(cache) = ctx.spawn_ctx.exec_config.workspace_cache.as_ref() {
                let started_at = Instant::now();
                let validation = entry.validate_workspace_promotion_identity(
                    cache,
                    CANONICAL_WORKING_DIR,
                    u64::from(workspace_disk_mb) * 1024 * 1024,
                );
                pre_spawn_timing.record_phase_elapsed(
                    RunnerPreSpawnPhase::WorkspacePromotionValidation,
                    started_at,
                );
                if let Err(mismatch) = validation {
                    warn!(
                        run_id = %run_id,
                        reuse_key_fingerprint = entry_reuse_key.as_deref().map(diagnostic_reuse_key_fingerprint),
                        reuse_key_kind = entry_reuse_key.as_deref().map(reuse_key_kind),
                        profile = %profile_name,
                        mismatch = mismatch.as_str(),
                        "workspace promotion identity mismatch, destroying idle sandbox and falling through to fresh create"
                    );
                    spawn_idle_destroy_job(
                        &ctx.spawn_ctx.idle_destroy_tracker,
                        entry.into_destroy_job_without_workspace_promotion_for_mismatch(),
                        "reuse_workspace_promotion_mismatch",
                    );
                    return Ok((
                        None,
                        job_lease,
                        fallback_reuse_result,
                        Some(snapshot),
                        needs_reuse_state_refresh,
                        None,
                    ));
                }
            }
            let idle_snapshot = snapshot.clone();
            let sandbox_id = entry.sandbox_id();
            let transfer_guard = cancellation.transfer_guard().await;
            if cancellation.is_cancelled() {
                drop(transfer_guard);
                rollback_reserved_idle_for_spawn(
                    ReservedIdleActivation::new(entry, idle_snapshot),
                    ctx.spawn_ctx,
                )
                .await;
                return Ok((
                    None,
                    job_lease,
                    fallback_reuse_result,
                    None,
                    needs_reuse_state_refresh,
                    None,
                ));
            }
            let status_started_at = Instant::now();
            if let Err(error) = add_preparing_run_with_idle_status_snapshot(
                ctx.status,
                run_id,
                sandbox_id,
                idle_snapshot.clone(),
            )
            .await
            {
                drop(transfer_guard);
                warn!(
                    run_id = %run_id,
                    sandbox_id = %sandbox_id,
                    %error,
                    activation_phase = "preparing_commit",
                    recovery_outcome = "restore_parked",
                    "failed to persist claimed idle sandbox activation ownership"
                );
                recover_failed_parked_activation_status(
                    ReservedIdleActivation::new(entry, idle_snapshot),
                    run_id,
                    sandbox_id,
                    ctx.spawn_ctx,
                )
                .await;
                return Ok((
                    None,
                    job_lease,
                    fallback_reuse_result,
                    None,
                    needs_reuse_state_refresh,
                    None,
                ));
            }
            pre_spawn_timing
                .record_phase_elapsed(RunnerPreSpawnPhase::ActiveStatusPublish, status_started_at);
            #[cfg(test)]
            ctx.spawn_ctx
                .test_observer
                .notify_reserved_preparing_committed(run_id)
                .await;
            let started_at = Instant::now();
            let unpark_result = entry.try_unpark_for_run(run_id).await;
            pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::IdleUnpark, started_at);
            match unpark_result {
                IdleUnparkResult::Reused {
                    sandbox,
                    budget_lease,
                } => {
                    info!(
                        run_id = %run_id,
                        idle_kind = ?entry_kind,
                        reuse_key_fingerprint = entry_reuse_key.as_deref().map(diagnostic_reuse_key_fingerprint),
                        reuse_key_kind = entry_reuse_key.as_deref().map(reuse_key_kind),
                        "activating idle sandbox"
                    );
                    // Idle entry already holds budget. Drop the speculative
                    // fresh-job lease and move the idle lease to the outer job
                    // task before handing the sandbox to the executor.
                    drop(job_lease);
                    Ok((
                        Some(*sandbox),
                        budget_lease,
                        activation_reuse_result,
                        Some(snapshot),
                        needs_reuse_state_refresh,
                        Some(transfer_guard),
                    ))
                }
                IdleUnparkResult::Failed { destroy_job, error } => {
                    warn!(
                        run_id = %run_id,
                        idle_kind = ?entry_kind,
                        reuse_key_fingerprint = entry_reuse_key.as_deref().map(diagnostic_reuse_key_fingerprint),
                        reuse_key_kind = entry_reuse_key.as_deref().map(reuse_key_kind),
                        error = %error,
                        "unpark failed, destroying idle sandbox and falling through to fresh create"
                    );
                    let cleanup = destroy_job.run_retaining_lease("reuse_unpark_failed").await;
                    if cleanup.workspace_cache_promoted {
                        ctx.spawn_ctx.reuse_state_notify.notify_one();
                    }
                    drop(transfer_guard);
                    match cleanup.outcome {
                        DestroyOutcome::Completed => {
                            drop(cleanup.budget_lease);
                            Ok((
                                None,
                                job_lease,
                                unpark_failure_reuse_result,
                                Some(snapshot),
                                needs_reuse_state_refresh,
                                None,
                            ))
                        }
                        DestroyOutcome::Uncertain => {
                            drop(cleanup.budget_lease);
                            drop(job_lease);
                            retain_uncertain_activation_ownership(
                                &ctx.spawn_ctx.status,
                                &ctx.spawn_ctx.orphaned_active_runs,
                                run_id,
                                sandbox_id,
                                "reuse_unpark_failed",
                            );
                            Err(ReuseFromPoolFailure {
                                reuse_result: unpark_failure_reuse_result,
                                error: "idle sandbox cleanup was uncertain; fresh replacement was not started"
                                    .to_owned(),
                            })
                        }
                    }
                }
            }
        }
        Some((stale, snapshot)) if stale.profile_name() == profile_name => {
            let stale_reuse_key = stale.reuse_key().map(str::to_owned);
            info!(
                run_id = %run_id,
                reuse_key_fingerprint = stale_reuse_key.as_deref().map(diagnostic_reuse_key_fingerprint),
                reuse_key_kind = stale_reuse_key.as_deref().map(reuse_key_kind),
                profile = %profile_name,
                "idle sandbox device rate limiter mismatch, destroying"
            );
            spawn_idle_destroy_job(
                &ctx.spawn_ctx.idle_destroy_tracker,
                stale.into_destroy_job(),
                "reuse_device_limit_mismatch",
            );
            Ok((
                None,
                job_lease,
                SandboxReuseResult::DeviceLimitMismatch,
                Some(snapshot),
                needs_reuse_state_refresh,
                None,
            ))
        }
        Some((stale, snapshot)) => {
            let stale_reuse_key = stale.reuse_key().map(str::to_owned);
            info!(
                run_id = %run_id,
                reuse_key_fingerprint = stale_reuse_key.as_deref().map(diagnostic_reuse_key_fingerprint),
                reuse_key_kind = stale_reuse_key.as_deref().map(reuse_key_kind),
                old_profile = %stale.profile_name(),
                new_profile = %profile_name,
                "idle sandbox profile mismatch, destroying"
            );
            spawn_idle_destroy_job(
                &ctx.spawn_ctx.idle_destroy_tracker,
                stale.into_destroy_job(),
                "reuse_profile_mismatch",
            );
            Ok((
                None,
                job_lease,
                SandboxReuseResult::ProfileMismatch,
                Some(snapshot),
                needs_reuse_state_refresh,
                None,
            ))
        }
        None => {
            match reuse_key {
                Some(reuse_key) => info!(
                    run_id = %run_id,
                    reuse_key_fingerprint = %diagnostic_reuse_key_fingerprint(reuse_key),
                    reuse_key_kind = reuse_key_kind(reuse_key),
                    workspace_cache_possible = claimed_workspace_cache_reuse_key,
                    "no compatible idle sandbox found for reuse key"
                ),
                None => info!(run_id = %run_id, "no compatible blank sandbox found"),
            }
            Ok((
                None,
                job_lease,
                miss_result,
                None,
                needs_reuse_state_refresh,
                None,
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::status::IdleSandbox;

    fn read_active_run_phase(path: &std::path::Path) -> String {
        let raw = std::fs::read_to_string(path).unwrap();
        let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
        status["active_runs"][0]["phase"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn idle_snapshot() -> IdlePoolSnapshot {
        IdlePoolSnapshot {
            revision: 1,
            blank_sandboxes: vec![],
            idle_sandboxes: vec![IdleSandbox {
                reuse_key: "sess-removed-from-pool".into(),
                sandbox_id: SandboxId::new_v4(),
            }],
        }
    }

    #[test]
    fn ranked_preference_admission_matrix() {
        use RunnerPreferenceTier::{
            ExactSandbox, FinalizingPredecessor, ReusableSandbox, WorkspaceCache,
        };

        let tiers = [
            WorkspaceCache,
            ReusableSandbox,
            FinalizingPredecessor,
            ExactSandbox,
        ];
        let selected = [
            [true, true, true, true],
            [false, true, true, true],
            [false, false, true, true],
            [false, false, false, true],
        ];
        let unselected = [
            [false, true, true, true],
            [false, false, true, true],
            [false, false, false, true],
            [false, false, false, false],
        ];

        for ((advertised_tier, selected_row), unselected_row) in
            tiers.into_iter().zip(selected).zip(unselected)
        {
            for ((local_tier, selected_expected), unselected_expected) in
                tiers.into_iter().zip(selected_row).zip(unselected_row)
            {
                assert_eq!(
                    ranked_preference_allows(advertised_tier, local_tier, true),
                    selected_expected,
                    "selected runner: advertised={advertised_tier:?}, local={local_tier:?}"
                );
                assert_eq!(
                    ranked_preference_allows(advertised_tier, local_tier, false),
                    unselected_expected,
                    "unselected runner: advertised={advertised_tier:?}, local={local_tier:?}"
                );
            }
        }
    }

    #[tokio::test]
    async fn publish_active_run_status_writes_preparing_after_reuse_miss_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);

        publish_active_run_status(
            &status,
            RunId::new_v4(),
            SandboxId::new_v4(),
            false,
            Some(idle_snapshot()),
        )
        .await
        .unwrap();

        assert_eq!(read_active_run_phase(&status_path), "preparing");
    }

    #[tokio::test]
    async fn publish_active_run_status_writes_running_for_reused_idle_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);

        publish_active_run_status(
            &status,
            RunId::new_v4(),
            SandboxId::new_v4(),
            true,
            Some(idle_snapshot()),
        )
        .await
        .unwrap();

        assert_eq!(read_active_run_phase(&status_path), "running");
    }
}
