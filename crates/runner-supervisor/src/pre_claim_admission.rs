//! Pre-claim preference, resource admission, claim and rollback ownership.
//!
//! The successful claim transfers a typed resource to Runner's existing post-claim activation.
//! Claim rejection and a mismatched returned run ID keep rollback with the admission owner.

use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Instant;

use futures_util::FutureExt;
use runner_executor::executor::{
    BlankPoolSelection, RunnerPreSpawnOperationTiming, restore_guest_state_with_intent,
};
use runner_host::paths::short_digest;
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_lifecycle::active_runs::{ActiveRunReuseProof, ActiveRuns};
use runner_lifecycle::idle_pool::{
    IdlePoolSnapshot, ReservedIdleSandbox, RestoreReservedIdleResult, SpeculativeIdleSandbox,
    SpeculativeIdleUnparkResult, SpeculativeReparkResult,
};
use runner_lifecycle::lifecycle::RunnerMode;
use runner_lifecycle::resource_budget::{BudgetLease, ResourceBudget};
use runner_lifecycle::status::StatusTracker;
use runner_lifecycle::workspace_image_cache::snapshot::WorkspaceCacheStateSnapshot;
use runner_provider::{
    ClaimedJob, JobCandidate, JobProvider, RunCancellationRegistration, RunCancellationRegistry,
    RunnerPreferenceRemovalReason, RunnerPreferenceTier,
};
use runner_types::ids::RunId;
use runner_types::types::{HeldWorkspaceState, WORKSPACE_AFFINITY_VERSION, reuse_key_kind};
use sandbox::SandboxId;
use tokio::sync::{Notify, watch};
use tracing::{info, warn};

use crate::blank_pool::BlankPoolDiagnostics;
use crate::finalizing_admission::FinalizingAdmission;
use crate::idle_lifecycle::{
    IdleDestroyTracker, IdlePressureRequest, IdlePressureSelection, ReservedIdleActivation,
    SharedIdlePool, destroy_idle_jobs_and_wait, reserve_reusable_idle_for_spawn,
    rollback_reserved_idle_for_spawn, select_idle_entries_for_pressure, set_idle_status_snapshot,
};

/// Narrow, borrowed composition inputs required for the admission-to-claim transaction.
#[derive(Clone, Copy)]
pub struct PreClaimResources<'a> {
    pub runner_identity: RunnerProcessIdentity,
    pub idle_pool: &'a SharedIdlePool,
    pub status: &'a StatusTracker,
    pub mode_rx: &'a watch::Receiver<RunnerMode>,
    pub cancel_tokens: &'a RunCancellationRegistry,
    pub provider: &'a dyn JobProvider,
    pub budget: &'a Arc<ResourceBudget>,
    pub active_runs: &'a ActiveRuns,
    pub workspace_cache_snapshot: &'a WorkspaceCacheStateSnapshot,
    pub has_workspace_cache: bool,
    pub idle_destroy_tracker: &'a IdleDestroyTracker,
    pub reuse_state_notify: &'a Notify,
    pub blank_pool_diagnostics: &'a BlankPoolDiagnostics,
}

struct LocalAdmission {
    resource: LocalAdmissionResource,
    cancellation: RunCancellationRegistration,
    blank_pool_selection: Option<BlankPoolSelection>,
}

enum LocalAdmissionResource {
    Fresh(BudgetLease),
    Reusable(ReservedIdleActivation),
    ExactSpeculative(ExactSpeculationReservation),
    Finalizing(FinalizingAdmission),
}

/// One owned resource transferred with a successful claim to Runner activation.
pub enum AdmittedResource {
    Fresh(BudgetLease),
    Reusable(ReservedIdleActivation),
    ExactSpeculation(ExactSpeculation),
    Finalizing(FinalizingAdmission),
}

pub enum SandboxAdmittedResource {
    Fresh(BudgetLease),
    Reusable(ReservedIdleActivation),
    ExactSpeculation(ExactSpeculation),
}

pub struct ExactSpeculation {
    pub outcome: ExactSpeculationOutcome,
    pub sandbox_id: SandboxId,
    pub idle_snapshot: IdlePoolSnapshot,
    pub preparation_started_at: Instant,
    pub preparation_completed_at: Instant,
    pub claim_started_at: Instant,
    pub claim_returned_at: Instant,
    pub unpark: RunnerPreSpawnOperationTiming,
    pub guest_restore: Option<RunnerPreSpawnOperationTiming>,
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

pub enum ExactSpeculationOutcome {
    Prepared(Box<SpeculativeIdleSandbox>),
    Failed {
        destroy_job: Box<runner_lifecycle::idle_pool::IdleDestroyJob>,
        error: String,
    },
}

pub struct AdmittedClaim {
    pub claimed: ClaimedJob,
    pub resource: AdmittedResource,
    pub cancellation: RunCancellationRegistration,
    pub claim_returned_at: Instant,
    pub blank_pool_selection: Option<BlankPoolSelection>,
}

/// Concrete profile facts supplied by Runner, without exposing a pre-claim reservation.
pub struct PreClaimRequest<'a> {
    pub candidate: JobCandidate,
    pub profile_name: &'a str,
    pub job_vcpu: u32,
    pub job_memory: u32,
    pub workspace_disk_mb: u32,
    pub device_rate_limits: &'a Option<sandbox::DeviceRateLimits>,
}

/// Only a successful claim transfers local resource ownership to Runner.
pub enum PreClaimOutcome {
    Claimed(Box<AdmittedClaim>),
    Pending(Box<JobCandidate>),
    Deferred,
}

/// The one unclaimed finalizing candidate retained between reactor wakeups.
///
/// Admission owns the candidate's original preference and the decision to
/// recheck it. Runner still owns discovery, timer and reuse-notification wiring.
#[derive(Default)]
pub struct PendingFinalizingCandidate {
    candidate: Option<JobCandidate>,
}

impl PendingFinalizingCandidate {
    pub fn new() -> Self {
        Self::default()
    }

    /// A rediscovery of the same run must not replace its original deadline.
    pub fn for_admission(&mut self, candidate: JobCandidate) -> JobCandidate {
        if let Some(pending) = self
            .candidate
            .take_if(|pending| pending.run_id() == candidate.run_id())
        {
            info!(
                run_id = %candidate.run_id(),
                "duplicate finalizing candidate rechecks retained admission state"
            );
            pending
        } else {
            candidate
        }
    }

    /// Keep the first pending candidate without blocking unrelated ready work.
    pub fn retain(&mut self, candidate: JobCandidate) {
        if self.candidate.is_none() {
            self.candidate = Some(candidate);
        } else {
            info!(
                run_id = %candidate.run_id(),
                "finalizing candidate not retained because the pending slot is occupied"
            );
        }
    }

    pub fn is_some(&self) -> bool {
        self.candidate.is_some()
    }

    pub fn deadline(&self) -> Option<Instant> {
        self.candidate
            .as_ref()
            .and_then(JobCandidate::runner_preference)
            .map(runner_provider::ActiveRunnerPreference::deadline)
    }

    /// Retry on a reuse-state notification, preserving the selected preference.
    pub fn take(&mut self) -> Option<JobCandidate> {
        self.candidate.take()
    }

    /// Retry after the timer fired with the original preference expired.
    pub fn take_expired(&mut self) -> Option<JobCandidate> {
        self.take().map(|candidate| {
            candidate.without_runner_preference(RunnerPreferenceRemovalReason::Expired)
        })
    }

    /// Draining or stopping cannot retain unclaimed preference state.
    pub fn clear(&mut self) {
        self.candidate = None;
    }
}

struct PreparedCandidate {
    candidate: JobCandidate,
    resource: Option<LocalAdmissionResource>,
    blank_pool_selection: Option<BlankPoolSelection>,
}

enum PreferencePreparation {
    Ready(PreparedCandidate),
    Pending(JobCandidate),
    Deferred,
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
    preference: &'a runner_provider::ActiveRunnerPreference,
    reuse_key: &'a str,
    profile_name: &'a str,
    job_vcpu: u32,
    job_memory: u32,
    device_rate_limits: &'a Option<sandbox::DeviceRateLimits>,
    ctx: &'a PreClaimResources<'a>,
}

impl LocalAdmission {
    async fn rollback(self, ctx: &PreClaimResources<'_>) {
        let Self {
            resource,
            cancellation,
            blank_pool_selection: _,
        } = self;
        cancellation.unregister().await;
        rollback_untracked_resource(resource, ctx).await;
    }
}

/// Prepare a candidate and complete its admission-to-claim transaction in one owner.
/// The caller must await this operation in a non-interruptible discovery branch.
pub async fn admit_and_claim(
    request: PreClaimRequest<'_>,
    ctx: &PreClaimResources<'_>,
) -> PreClaimOutcome {
    let PreClaimRequest {
        candidate,
        profile_name,
        job_vcpu,
        job_memory,
        workspace_disk_mb,
        device_rate_limits,
    } = request;
    let run_id = candidate.run_id();
    let prepared = match prepare_preference_candidate(
        candidate,
        profile_name,
        job_vcpu,
        job_memory,
        device_rate_limits,
        ctx,
    )
    .await
    {
        PreferencePreparation::Ready(prepared) => prepared,
        PreferencePreparation::Pending(candidate) => {
            return PreClaimOutcome::Pending(Box::new(candidate));
        }
        PreferencePreparation::Deferred => return PreClaimOutcome::Deferred,
    };
    match claim_with_local_admission(
        ClaimAdmissionRequest {
            prepared,
            run_id,
            profile_name,
            job_vcpu,
            job_memory,
            workspace_disk_mb,
            device_rate_limits,
        },
        ctx,
    )
    .await
    {
        Some(claimed) => PreClaimOutcome::Claimed(Box::new(claimed)),
        None => PreClaimOutcome::Deferred,
    }
}

async fn claim_with_local_admission(
    request: ClaimAdmissionRequest<'_>,
    ctx: &PreClaimResources<'_>,
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
        mut blank_pool_selection,
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
            let (resource, selection) = acquire_local_admission_resource(
                &candidate,
                profile_name,
                job_vcpu,
                job_memory,
                device_rate_limits,
                ctx,
            )
            .await?;
            blank_pool_selection = selection;
            resource
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
        blank_pool_selection,
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
        blank_pool_selection,
    } = admission;
    let claim_started_at = Instant::now();
    let (claimed, admitted_resource, claim_returned_at) = match resource {
        LocalAdmissionResource::Fresh(budget_lease) => {
            let claimed = ctx.provider.claim(candidate).await;
            (
                claimed,
                AdmittedResource::Fresh(budget_lease),
                Instant::now(),
            )
        }
        LocalAdmissionResource::Reusable(reservation) => {
            let claimed = ctx.provider.claim(candidate).await;
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
                let claimed = ctx.provider.claim(candidate).await;
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
            let claimed = ctx.provider.claim(candidate).await;
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
        blank_pool_selection,
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
    ctx: &PreClaimResources<'_>,
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
        && let Some(reservation) = reserve_reusable_idle_for_spawn(
            ctx.idle_pool,
            reuse_key,
            profile_name,
            device_rate_limits,
            Some(history_generation_run_id),
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
            && let Some(predecessor) = ctx.active_runs.finalizing_predecessor(
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
    ) && let Some(reservation) = reserve_reusable_idle_for_spawn(
        ctx.idle_pool,
        reuse_key,
        profile_name,
        device_rate_limits,
        None,
    )
    .await
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
            blank_pool_selection: None,
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
    ctx: &PreClaimResources<'_>,
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
        blank_pool_selection: None,
    })
}

fn reusable_preparation(
    candidate: JobCandidate,
    reservation: ReservedIdleActivation,
) -> PreferencePreparation {
    PreferencePreparation::Ready(PreparedCandidate {
        candidate,
        resource: Some(LocalAdmissionResource::Reusable(reservation)),
        blank_pool_selection: None,
    })
}

async fn exact_speculative_preparation(
    candidate: JobCandidate,
    reservation: ReservedIdleActivation,
    ctx: &PreClaimResources<'_>,
) -> PreferencePreparation {
    let sandbox_id = reservation.sandbox_id();
    let (reservation, idle_snapshot) = reservation.into_parts();
    if let Err(error) = ctx.status.set_idle_snapshot(idle_snapshot.clone()).await {
        warn!(%error, "failed to persist exact speculation idle reservation");
        rollback_reserved_idle_for_spawn(
            ReservedIdleActivation::new(reservation, idle_snapshot),
            ctx.idle_pool,
            ctx.status,
            ctx.reuse_state_notify,
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
        blank_pool_selection: None,
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
        blank_pool_selection: None,
    })
}

async fn defer_preference_candidate(
    candidate: JobCandidate,
    preference: &runner_provider::ActiveRunnerPreference,
    reuse_key: &str,
    ctx: &PreClaimResources<'_>,
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
    ctx.provider.defer_poll_until(preference.deadline()).await;
    if retain {
        PreferencePreparation::Pending(candidate)
    } else {
        PreferencePreparation::Deferred
    }
}

fn diagnostic_reuse_key_fingerprint(reuse_key: &str) -> String {
    short_digest(reuse_key)
}

fn current_local_held_workspace_states(ctx: &PreClaimResources<'_>) -> Vec<HeldWorkspaceState> {
    ctx.workspace_cache_snapshot
        .current_held_workspace_states(ctx.active_runs, None)
}

async fn acquire_local_admission_resource(
    candidate: &JobCandidate,
    profile_name: &str,
    job_vcpu: u32,
    job_memory: u32,
    device_rate_limits: &Option<sandbox::DeviceRateLimits>,
    ctx: &PreClaimResources<'_>,
) -> Option<(LocalAdmissionResource, Option<BlankPoolSelection>)> {
    let workspace_cache_possible = ctx.has_workspace_cache
        && candidate.reuse_key().is_some_and(|reuse_key| {
            ctx.workspace_cache_snapshot
                .might_contain_workspace_cache_reuse_key(reuse_key)
        });
    let (selection, blank_pool_selection) = select_idle_entries_for_pressure(
        ctx.idle_pool,
        ctx.status,
        ctx.idle_destroy_tracker,
        ctx.budget,
        Vec::new(),
        IdlePressureRequest {
            run_id: candidate.run_id(),
            reuse_key: candidate.reuse_key(),
            profile_name,
            device_rate_limits,
            history_generation_run_id: None,
            allow_compatible_blank: !workspace_cache_possible,
            blank_pool_diagnostics: Some(ctx.blank_pool_diagnostics),
            vcpu: job_vcpu,
            memory_mb: job_memory,
            context: "candidate_admission_oldest",
        },
    )
    .await;
    match selection {
        IdlePressureSelection::Reusable(reservation) => Some((
            LocalAdmissionResource::Reusable(reservation),
            blank_pool_selection,
        )),
        IdlePressureSelection::Fresh(lease) => {
            if let Some(reuse_key) = candidate.reuse_key()
                && let Some(reservation) = reserve_reusable_idle_for_spawn(
                    ctx.idle_pool,
                    reuse_key,
                    profile_name,
                    device_rate_limits,
                    None,
                )
                .await
            {
                drop(lease);
                return Some((
                    LocalAdmissionResource::Reusable(reservation),
                    blank_pool_selection,
                ));
            }
            Some((LocalAdmissionResource::Fresh(lease), blank_pool_selection))
        }
        IdlePressureSelection::Exhausted(retiring_leases) => {
            drop(retiring_leases);
            None
        }
    }
}

async fn rollback_untracked_resource(
    resource: LocalAdmissionResource,
    ctx: &PreClaimResources<'_>,
) {
    match resource {
        LocalAdmissionResource::Fresh(budget_lease) => drop(budget_lease),
        LocalAdmissionResource::Finalizing(_) => {}
        LocalAdmissionResource::Reusable(reservation) => {
            rollback_reserved_idle_for_spawn(
                reservation,
                ctx.idle_pool,
                ctx.status,
                ctx.reuse_state_notify,
            )
            .await;
        }
        LocalAdmissionResource::ExactSpeculative(speculative) => {
            rollback_reserved_idle_for_spawn(
                ReservedIdleActivation::new(*speculative.reservation, speculative.idle_snapshot),
                ctx.idle_pool,
                ctx.status,
                ctx.reuse_state_notify,
            )
            .await;
        }
    }
}

async fn rollback_admitted_resource(
    resource: AdmittedResource,
    run_id: RunId,
    workspace_disk_mb: u32,
    ctx: &PreClaimResources<'_>,
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

/// Recover a claimed resource only after the provider claim has been completed.
pub async fn rollback_sandbox_admitted_resource(
    resource: SandboxAdmittedResource,
    run_id: RunId,
    workspace_disk_mb: u32,
    ctx: &PreClaimResources<'_>,
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
    ctx: &PreClaimResources<'_>,
) {
    rollback_exact_speculation_outcome(speculation.outcome, run_id, workspace_disk_mb, ctx).await;
}

/// Repark or destroy a prepared sandbox after the claimed job was completed without transfer.
pub async fn rollback_exact_speculation_outcome(
    outcome: ExactSpeculationOutcome,
    run_id: RunId,
    workspace_disk_mb: u32,
    ctx: &PreClaimResources<'_>,
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
                    ctx.reuse_state_notify.notify_one();
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
        ctx.reuse_state_notify.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use runner_provider::{ActiveRunnerPreference, RunnerPreferenceClaimState};
    use std::time::Duration;
    use uuid::Uuid;

    fn finalizing_candidate(run_id: RunId, deadline: Instant) -> JobCandidate {
        JobCandidate::new(run_id, "vm0/default".into()).with_runner_preference(
            ActiveRunnerPreference::new(
                RunnerProcessIdentity::new(Uuid::new_v4(), 1).unwrap(),
                RunnerPreferenceTier::FinalizingPredecessor,
                deadline,
            ),
        )
    }

    #[test]
    fn pending_same_run_rediscovery_keeps_original_deadline() {
        let run_id = RunId::new_v4();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut pending = PendingFinalizingCandidate::new();
        pending.retain(finalizing_candidate(run_id, deadline));

        let selected = pending.for_admission(finalizing_candidate(
            run_id,
            deadline + Duration::from_secs(30),
        ));
        assert_eq!(selected.runner_preference().unwrap().deadline(), deadline);
        assert!(!pending.is_some());
    }

    #[test]
    fn pending_first_candidate_does_not_block_unrelated_ready_work() {
        let first_run = RunId::new_v4();
        let second_run = RunId::new_v4();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut pending = PendingFinalizingCandidate::new();
        pending.retain(finalizing_candidate(first_run, deadline));

        let ready = pending.for_admission(finalizing_candidate(second_run, deadline));
        assert_eq!(ready.run_id(), second_run);
        pending.retain(ready);
        assert_eq!(pending.deadline(), Some(deadline));
        assert_eq!(pending.take().unwrap().run_id(), first_run);
        assert!(!pending.is_some());
    }

    #[test]
    fn pending_expiry_and_mode_clear_release_unclaimed_state() {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut pending = PendingFinalizingCandidate::new();
        pending.retain(finalizing_candidate(RunId::new_v4(), deadline));
        let expired = pending.take_expired().unwrap();
        assert!(expired.runner_preference().is_none());
        assert_eq!(
            expired.runner_preference_claim_telemetry().unwrap().state,
            Some(RunnerPreferenceClaimState::Expired)
        );
        assert_eq!(pending.deadline(), None);
        pending.retain(finalizing_candidate(RunId::new_v4(), deadline));
        pending.clear();
        assert!(pending.take().is_none());
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
}
