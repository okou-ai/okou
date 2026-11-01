//! Pre-claim preference, resource admission, claim and rollback ownership.
//!
//! The successful claim transfers a typed resource to Runner's existing post-claim activation.
//! Claim rejection and a mismatched returned run ID keep rollback with the admission owner.

mod guarded;
pub use guarded::{GuardedSpeculativeAdmission, GuardedSpeculativeRollback};

use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Instant;

use futures_util::FutureExt;
use runner_executor::executor::{
    BlankPoolSelection, RunnerPreSpawnOperationTiming, restore_guest_state_with_intent,
};
use runner_host::home_observation::{HomeObservation, HomeObservationKind, HomeObservationOutcome};
use runner_host::paths::short_digest;
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_lifecycle::active_runs::{ActiveRunReuseProof, ActiveRuns};
use runner_lifecycle::home_image_cache::snapshot::HomeCacheStateSnapshot;
use runner_lifecycle::home_image_cache::{HomeCacheProbe, HomeImageCache};
use runner_lifecycle::idle_pool::{
    IdlePoolSnapshot, ReservedIdleSandbox, RestoreReservedIdleResult, SpeculativeIdleSandbox,
    SpeculativeIdleUnparkResult, SpeculativeReparkResult,
};
use runner_lifecycle::lifecycle::RunnerMode;
use runner_lifecycle::resource_budget::{BudgetLease, ResourceBudget};
use runner_lifecycle::status::StatusTracker;
use runner_provider::{
    ActivePredecessorHomeEvidence, ClaimedJob, JobCandidate, JobProvider,
    RunCancellationRegistration, RunCancellationRegistry, RunnerPreferenceRemovalReason,
    RunnerPreferenceTier,
};
use runner_types::ids::RunId;
use runner_types::types::reuse_key_kind;
use sandbox::SandboxId;
use tokio::sync::{Notify, oneshot, watch};
use tracing::{info, warn};

use crate::blank_pool::BlankPoolDiagnostics;
use crate::finalizing_admission::FinalizingAdmission;
use crate::idle_lifecycle::{
    IdleDestroyTracker, IdlePressureOutcome, IdlePressureRequest, IdlePressureSelection,
    ReservedIdleActivation, SharedIdlePool, reserve_reusable_idle_for_spawn,
    reserve_source_idle_for_spawn, rollback_reserved_idle_for_spawn,
    select_idle_entries_for_pressure, set_idle_status_snapshot,
};

/// Narrow, borrowed composition inputs required for the admission-to-claim transaction.
#[derive(Clone, Copy)]
pub struct PreClaimResources<'a> {
    pub runner_identity: RunnerProcessIdentity,
    pub idle_pool: &'a SharedIdlePool,
    pub status: &'a Arc<StatusTracker>,
    pub mode_rx: &'a watch::Receiver<RunnerMode>,
    pub cancel_tokens: &'a RunCancellationRegistry,
    pub provider: &'a dyn JobProvider,
    pub budget: &'a Arc<ResourceBudget>,
    pub active_runs: &'a ActiveRuns,
    pub home_cache_snapshot: &'a HomeCacheStateSnapshot,
    pub sandbox_op_reporter: Option<&'a runner_storage::SandboxOpReporter>,
    pub home_cache: Option<&'a HomeImageCache>,
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
    /// This Runner's ordinary capacity retained through the source publication wait.
    HomeWait {
        lease: BudgetLease,
        wait_deadline: Instant,
        predecessor_run_id: RunId,
    },
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
    pub required_home_source_run_id: Option<RunId>,
}

/// Concrete profile facts supplied by Runner, without exposing a pre-claim reservation.
pub struct PreClaimRequest<'a> {
    pub candidate: JobCandidate,
    pub profile_name: &'a str,
    pub job_vcpu: u32,
    pub job_memory: u32,
    pub home_disk_mb: u32,
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
    required_home_source_run_id: Option<RunId>,
    home_readiness_wait: Option<HomeReadinessWait>,
    candidate: JobCandidate,
    resource: Option<LocalAdmissionResource>,
    blank_pool_selection: Option<BlankPoolSelection>,
}

struct HomeReadinessWait {
    predecessor_run_id: RunId,
    wait_deadline: Instant,
}

enum AdmissionReusePolicy {
    Compatible { allow_blank: bool },
    RequiredHomeSource,
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
    home_disk_mb: u32,
    device_rate_limits: &'a Option<sandbox::DeviceRateLimits>,
}

struct PreferenceCandidateRequest<'a> {
    candidate: JobCandidate,
    preference: &'a runner_provider::ActiveRunnerPreference,
    reuse_key: &'a str,
    profile_name: &'a str,
    job_vcpu: u32,
    job_memory: u32,
    home_disk_mb: u32,
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
/// Its owner must keep the transaction alive until claim settlement and resource
/// handoff. Normal shutdown joins independently scheduled admissions, never aborts them.
/// `admission_ready` signals after reservation/cancellation registration and before
/// claim; an early rejection closes it so discovery can re-evaluate capacity.
pub async fn admit_and_claim(
    request: PreClaimRequest<'_>,
    ctx: &PreClaimResources<'_>,
    admission_ready: oneshot::Sender<()>,
) -> PreClaimOutcome {
    let PreClaimRequest {
        candidate,
        profile_name,
        job_vcpu,
        job_memory,
        home_disk_mb,
        device_rate_limits,
    } = request;
    let run_id = candidate.run_id();
    let prepared = match prepare_preference_candidate(
        candidate,
        profile_name,
        job_vcpu,
        job_memory,
        home_disk_mb,
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
            home_disk_mb,
            device_rate_limits,
        },
        ctx,
        admission_ready,
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
    admission_ready: oneshot::Sender<()>,
) -> Option<AdmittedClaim> {
    let ClaimAdmissionRequest {
        prepared,
        run_id,
        profile_name,
        job_vcpu,
        job_memory,
        home_disk_mb,
        device_rate_limits,
    } = request;
    let PreparedCandidate {
        required_home_source_run_id,
        home_readiness_wait,
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
            let allow_compatible_blank = !(ctx.home_cache.is_some()
                && candidate.reuse_key().is_some_and(|key| {
                    ctx.home_cache_snapshot
                        .has_compatible_home_hint(key, profile_name)
                }));
            let Some((resource, selection)) = acquire_local_admission_resource(
                &candidate,
                profile_name,
                job_vcpu,
                job_memory,
                device_rate_limits,
                AdmissionReusePolicy::Compatible {
                    allow_blank: allow_compatible_blank,
                },
                ctx,
            )
            .await
            else {
                record_home_admission_deferral(&candidate, ctx, "capacity_exhausted");
                return None;
            };
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
    // The admission task is not aborted during normal shutdown. A valid
    // successful claim must transfer to activation or complete-with-rollback.
    let LocalAdmission {
        resource,
        cancellation,
        blank_pool_selection,
    } = admission;
    // Let discovery re-evaluate authoritative capacity only after this task
    // reserved its resource and registered cancellation. A missing receiver
    // means Reactor disappeared, not that this owned claim should be aborted.
    let _ = admission_ready.send(());
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
            let preparation = async {
                let journal = match ctx.status.set_idle_snapshot(idle_snapshot.clone()).await {
                    Ok(true) => Ok(()),
                    // A newer in-memory revision can still be waiting for IO.
                    // Persist the current status, never the superseded inventory.
                    Ok(false) => ctx.status.retry_unpublished_snapshot().await,
                    Err(error) => Err(error),
                };
                if let Err(error) = journal {
                    warn!(%error, "failed to persist exact speculation idle reservation");
                    return Err(reservation);
                }
                Ok(prepare_exact_speculation(*reservation, run_id).await)
            };
            let ((claimed, claim_returned_at), preparation) = tokio::join!(claim, preparation);
            let resource = match preparation {
                Ok(preparation) => AdmittedResource::ExactSpeculation(ExactSpeculation {
                    outcome: preparation.outcome,
                    sandbox_id,
                    idle_snapshot,
                    preparation_started_at: preparation.started_at,
                    preparation_completed_at: preparation.completed_at,
                    claim_started_at,
                    claim_returned_at,
                    unpark: preparation.unpark,
                    guest_restore: preparation.guest_restore,
                }),
                // The Guest is still parked. Claimed activation must persist
                // Preparing before unpark; rejection restores this same owner.
                Err(reservation) => AdmittedResource::Reusable(ReservedIdleActivation::new(
                    *reservation,
                    idle_snapshot,
                )),
            };
            (claimed, resource, claim_returned_at)
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
        rollback_admitted_resource(admitted_resource, run_id, home_disk_mb, ctx).await;
        return None;
    };
    if claimed.context().run_id != run_id {
        warn!(
            run_id = %run_id,
            context_run_id = %claimed.context().run_id,
            "provider returned claimed job with mismatched run_id"
        );
        cancellation.unregister().await;
        rollback_admitted_resource(admitted_resource, run_id, home_disk_mb, ctx).await;
        return None;
    }

    let admitted_resource = match (admitted_resource, home_readiness_wait) {
        (
            AdmittedResource::Fresh(lease),
            Some(HomeReadinessWait {
                predecessor_run_id,
                wait_deadline,
            }),
        ) => AdmittedResource::HomeWait {
            lease,
            wait_deadline,
            predecessor_run_id,
        },
        (resource, _) => resource,
    };
    Some(AdmittedClaim {
        required_home_source_run_id,
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
    home_disk_mb: u32,
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
        home_disk_mb,
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
        home_disk_mb,
        device_rate_limits,
        ctx,
    } = request;
    let selected = preference.targets(ctx.runner_identity);
    let predecessor_run_id = preference.target().predecessor_run_id();

    if let Some(predecessor) = predecessor_run_id
        && ranked_preference_allows(
            advertised_tier,
            RunnerPreferenceTier::ExactSandbox,
            selected,
        )
        && let Ok(reservation) = reserve_source_idle_for_spawn(
            ctx.idle_pool,
            reuse_key,
            profile_name,
            device_rate_limits,
            predecessor,
        )
        .await
    {
        return if reservation.guest_timezone_intent().is_usable_prediction() {
            exact_speculative_preparation(candidate, reservation)
        } else {
            reusable_preparation(candidate, reservation)
        };
    }

    let selected_finalizing =
        advertised_tier == RunnerPreferenceTier::FinalizingPredecessor && selected;
    let selected_predecessor_home_evidence = match preference.target() {
        runner_provider::RunnerPreferenceTarget::PredecessorHome(_, home) if selected => Some(home),
        _ => None,
    };
    if selected_finalizing
        && let runner_provider::RunnerPreferenceTarget::FinalizingPredecessor(predecessor_run_id) =
            preference.target()
        && predecessor_run_id != candidate.run_id()
        && let Some(predecessor) =
            ctx.active_runs
                .finalizing_predecessor(predecessor_run_id, reuse_key, profile_name)
    {
        return finalizing_preparation(
            candidate,
            predecessor,
            preference.deadline(),
            reuse_key,
            predecessor_run_id,
        );
    }
    // Publication can resolve the selected producer between discovery and
    // admission. Consume its ready resource through ordinary guarded activation.

    let predecessor_home_probe = if let Some(predecessor) = predecessor_run_id
        && (selected_finalizing
            || selected_predecessor_home_evidence.is_some()
            || ctx
                .home_cache_snapshot
                .has_source_home_hint(reuse_key, profile_name, predecessor)
                && ranked_preference_allows(
                    advertised_tier,
                    RunnerPreferenceTier::PredecessorHome(
                        ActivePredecessorHomeEvidence::Advertised,
                    ),
                    selected,
                )) {
        probe_home(
            ctx.home_cache,
            reuse_key,
            profile_name,
            u64::from(home_disk_mb) * 1024 * 1024,
            Some(predecessor),
        )
        .await
        .map(|observed| (predecessor, observed))
    } else {
        None
    };

    if let Some((predecessor, HomeCacheProbe::Ready { .. })) = predecessor_home_probe
        && let Some((resource, blank_pool_selection)) = acquire_local_admission_resource(
            &candidate,
            profile_name,
            job_vcpu,
            job_memory,
            device_rate_limits,
            AdmissionReusePolicy::RequiredHomeSource,
            ctx,
        )
        .await
    {
        return PreferencePreparation::Ready(PreparedCandidate {
            required_home_source_run_id: Some(predecessor),
            candidate,
            resource: Some(resource),
            home_readiness_wait: None,
            blank_pool_selection,
        });
    }

    if (selected_finalizing
        || selected_predecessor_home_evidence.is_some()
        || ranked_preference_allows(
            advertised_tier,
            RunnerPreferenceTier::ReusableSandbox,
            selected,
        ))
        && let Some(reservation) = reserve_reusable_idle_for_spawn(
            ctx.idle_pool,
            reuse_key,
            profile_name,
            device_rate_limits,
        )
        .await
    {
        return reusable_preparation(candidate, reservation);
    }

    let home_wait_deadline = match selected_predecessor_home_evidence {
        Some(ActivePredecessorHomeEvidence::Expected { wait_deadline }) => Some(wait_deadline),
        Some(ActivePredecessorHomeEvidence::HostLocation)
            if matches!(predecessor_home_probe, Some((_, HomeCacheProbe::Busy))) =>
        {
            Some(preference.deadline())
        }
        _ => None,
    };
    if let Some(deadline) = home_wait_deadline.filter(|deadline| *deadline > Instant::now())
        && let Some(predecessor_run_id) = predecessor_run_id
    {
        if let Some((resource, blank_pool_selection)) = acquire_local_admission_resource(
            &candidate,
            profile_name,
            job_vcpu,
            job_memory,
            device_rate_limits,
            AdmissionReusePolicy::Compatible {
                allow_blank: ctx.home_cache.is_none(),
            },
            ctx,
        )
        .await
        {
            return PreferencePreparation::Ready(PreparedCandidate {
                required_home_source_run_id: None,
                home_readiness_wait: Some(HomeReadinessWait {
                    predecessor_run_id,
                    wait_deadline: deadline,
                }),
                candidate,
                resource: Some(resource),
                blank_pool_selection,
            });
        }
        return defer_preference_candidate(
            candidate,
            preference,
            reuse_key,
            ctx,
            true,
            "capacity_exhausted",
        )
        .await;
    }

    if selected_predecessor_home_evidence.is_some() {
        return ordinary_preparation(
            candidate.without_runner_preference(RunnerPreferenceRemovalReason::Cleared),
        );
    }

    let has_local_home_hint = ctx
        .home_cache_snapshot
        .has_compatible_home_hint(reuse_key, profile_name);
    // Only selected advice or positive local inventory authorizes IO.
    // Ranking still requires ready bytes, never a Busy/unknown entry.
    let home_probe = if selected_finalizing
        || ranked_preference_allows(advertised_tier, RunnerPreferenceTier::HomeCache, selected)
            && (selected || has_local_home_hint)
    {
        probe_home(
            ctx.home_cache,
            reuse_key,
            profile_name,
            u64::from(home_disk_mb) * 1024 * 1024,
            None,
        )
        .await
    } else {
        None
    };
    let reason = if let Some(HomeCacheProbe::Ready { source_run_id }) = home_probe {
        if let Some((resource, blank_pool_selection)) = acquire_local_admission_resource(
            &candidate,
            profile_name,
            job_vcpu,
            job_memory,
            device_rate_limits,
            AdmissionReusePolicy::Compatible { allow_blank: false },
            ctx,
        )
        .await
        {
            return PreferencePreparation::Ready(PreparedCandidate {
                required_home_source_run_id: Some(source_run_id),
                candidate,
                resource: Some(resource),
                home_readiness_wait: None,
                blank_pool_selection,
            });
        }
        "capacity_exhausted"
    } else if selected_finalizing {
        "no_publishable_predecessor"
    } else {
        "no_qualifying_local_resource"
    };

    defer_preference_candidate(
        candidate,
        preference,
        reuse_key,
        ctx,
        selected_finalizing,
        reason,
    )
    .await
}

async fn probe_home(
    cache: Option<&HomeImageCache>,
    reuse_key: &str,
    profile: &str,
    image_size_bytes: u64,
    required_source_run_id: Option<RunId>,
) -> Option<HomeCacheProbe> {
    match cache?
        .probe_home(reuse_key, profile, image_size_bytes, required_source_run_id)
        .await
    {
        Ok(observed) => Some(observed),
        Err(error) => {
            warn!(%error, profile, required_source = ?required_source_run_id, reuse_key_fingerprint = %short_digest(reuse_key),
                "requested Home lookup failed during selection");
            None
        }
    }
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

fn ordinary_preparation(candidate: JobCandidate) -> PreferencePreparation {
    PreferencePreparation::Ready(PreparedCandidate {
        required_home_source_run_id: None,
        home_readiness_wait: None,
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
        required_home_source_run_id: None,
        candidate,
        resource: Some(LocalAdmissionResource::Reusable(reservation)),
        home_readiness_wait: None,
        blank_pool_selection: None,
    })
}

fn exact_speculative_preparation(
    candidate: JobCandidate,
    reservation: ReservedIdleActivation,
) -> PreferencePreparation {
    let sandbox_id = reservation.sandbox_id();
    let (reservation, idle_snapshot) = reservation.into_parts();
    PreferencePreparation::Ready(PreparedCandidate {
        required_home_source_run_id: None,
        candidate,
        resource: Some(LocalAdmissionResource::ExactSpeculative(
            ExactSpeculationReservation {
                reservation: Box::new(reservation),
                sandbox_id,
                idle_snapshot,
            },
        )),
        home_readiness_wait: None,
        blank_pool_selection: None,
    })
}

fn finalizing_preparation(
    candidate: JobCandidate,
    predecessor: ActiveRunReuseProof,
    deadline: Instant,
    reuse_key: &str,
    source_run_id: RunId,
) -> PreferencePreparation {
    PreferencePreparation::Ready(PreparedCandidate {
        required_home_source_run_id: None,
        candidate,
        resource: Some(LocalAdmissionResource::Finalizing(FinalizingAdmission {
            predecessor,
            deadline,
            reuse_key: reuse_key.to_owned(),
            source_run_id,
            // Native handoff is established only by the authoritative claim.
            native_generation_run_id: None,
        })),
        home_readiness_wait: None,
        blank_pool_selection: None,
    })
}

async fn defer_preference_candidate(
    candidate: JobCandidate,
    preference: &runner_provider::ActiveRunnerPreference,
    reuse_key: &str,
    ctx: &PreClaimResources<'_>,
    retain: bool,
    reason: &'static str,
) -> PreferencePreparation {
    if preference.is_expired() {
        return ordinary_preparation(
            candidate.without_runner_preference(RunnerPreferenceRemovalReason::Expired),
        );
    }
    let delay = preference.remaining();
    record_home_admission_deferral(&candidate, ctx, reason);
    info!(
        run_id = %candidate.run_id(),
        reuse_key_fingerprint = %diagnostic_reuse_key_fingerprint(reuse_key),
        reuse_key_kind = reuse_key_kind(reuse_key),
        preference_tier = ?preference.tier(),
        reason,
        delay_ms = delay.as_millis(),
        retained = retain,
        "runner preference admission deferred"
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

fn record_home_admission_deferral(
    candidate: &JobCandidate,
    ctx: &PreClaimResources<'_>,
    reason: &'static str,
) {
    let Some(reporter) = ctx.sandbox_op_reporter else {
        return;
    };
    let mut observation = HomeObservation::new(
        HomeObservationKind::Admission,
        HomeObservationOutcome::Deferred,
    );
    observation.run_id = Some(candidate.run_id());
    observation.reuse_key = candidate.reuse_key().map(str::to_owned);
    observation.profile_name = Some(candidate.profile_name().to_owned());
    observation.runner_id = Some(ctx.runner_identity.runner_id().to_string());
    observation.runner_heartbeat_generation = Some(ctx.runner_identity.heartbeat_generation());
    observation.reason = Some(reason.to_owned());
    let mut record = runner_storage::SandboxOpRecord::new(
        "runner_home_admission",
        std::time::Duration::ZERO,
        true,
        None,
    );
    record.home = Some(observation);
    reporter.record(record);
}

async fn acquire_local_admission_resource(
    candidate: &JobCandidate,
    profile_name: &str,
    job_vcpu: u32,
    job_memory: u32,
    device_rate_limits: &Option<sandbox::DeviceRateLimits>,
    reuse_policy: AdmissionReusePolicy,
    ctx: &PreClaimResources<'_>,
) -> Option<(LocalAdmissionResource, Option<BlankPoolSelection>)> {
    let (reuse_key, allow_compatible_blank) = match reuse_policy {
        AdmissionReusePolicy::Compatible { allow_blank } => (candidate.reuse_key(), allow_blank),
        // Reserve fresh capacity so another idle VM cannot displace the selected home.
        AdmissionReusePolicy::RequiredHomeSource => (None, false),
    };
    let IdlePressureOutcome {
        selection,
        blank_pool_selection,
        idle_snapshot,
    } = select_idle_entries_for_pressure(
        ctx.idle_pool,
        ctx.idle_destroy_tracker,
        ctx.budget,
        Vec::new(),
        IdlePressureRequest {
            run_id: candidate.run_id(),
            reuse_key,
            profile_name,
            device_rate_limits,
            allow_compatible_blank,
            blank_pool_diagnostics: Some(ctx.blank_pool_diagnostics),
            vcpu: job_vcpu,
            memory_mb: job_memory,
            context: "candidate_admission_oldest",
        },
    )
    .await;
    if let Some(snapshot) = idle_snapshot {
        let status = Arc::clone(ctx.status);
        ctx.idle_destroy_tracker.spawn_cleanup(
            async move { set_idle_status_snapshot(&status, snapshot).await },
            "candidate_admission_idle_status",
        );
    }
    match selection {
        IdlePressureSelection::Reusable(reservation) => Some((
            LocalAdmissionResource::Reusable(reservation),
            blank_pool_selection,
        )),
        IdlePressureSelection::Fresh(lease) => {
            // Claimed activation rechecks the pool, so claim need not wait for it.
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
                ctx.idle_destroy_tracker,
            )
            .await;
        }
        LocalAdmissionResource::ExactSpeculative(speculative) => {
            rollback_reserved_idle_for_spawn(
                ReservedIdleActivation::new(*speculative.reservation, speculative.idle_snapshot),
                ctx.idle_pool,
                ctx.status,
                ctx.reuse_state_notify,
                ctx.idle_destroy_tracker,
            )
            .await;
        }
    }
}

async fn rollback_admitted_resource(
    resource: AdmittedResource,
    run_id: RunId,
    home_disk_mb: u32,
    ctx: &PreClaimResources<'_>,
) {
    let resource = match resource {
        AdmittedResource::Fresh(lease) | AdmittedResource::HomeWait { lease, .. } => {
            SandboxAdmittedResource::Fresh(lease)
        }
        AdmittedResource::Reusable(reservation) => SandboxAdmittedResource::Reusable(reservation),
        AdmittedResource::ExactSpeculation(speculation) => {
            SandboxAdmittedResource::ExactSpeculation(speculation)
        }
        AdmittedResource::Finalizing(_) => return,
    };
    rollback_sandbox_admitted_resource(resource, run_id, home_disk_mb, ctx).await;
}

/// Recover a claimed resource only after the provider claim has been completed.
pub async fn rollback_sandbox_admitted_resource(
    resource: SandboxAdmittedResource,
    run_id: RunId,
    home_disk_mb: u32,
    ctx: &PreClaimResources<'_>,
) {
    match resource {
        SandboxAdmittedResource::Fresh(budget_lease) => drop(budget_lease),
        SandboxAdmittedResource::Reusable(reservation) => {
            rollback_untracked_resource(LocalAdmissionResource::Reusable(reservation), ctx).await;
        }
        SandboxAdmittedResource::ExactSpeculation(speculation) => {
            rollback_exact_speculation(speculation, run_id, home_disk_mb, ctx).await;
        }
    }
}

async fn rollback_exact_speculation(
    speculation: ExactSpeculation,
    run_id: RunId,
    home_disk_mb: u32,
    ctx: &PreClaimResources<'_>,
) {
    rollback_exact_speculation_outcome(speculation.outcome, run_id, home_disk_mb, ctx).await;
}

/// Repark or destroy a prepared sandbox after the claimed job was completed without transfer.
pub async fn rollback_exact_speculation_outcome(
    outcome: ExactSpeculationOutcome,
    run_id: RunId,
    home_disk_mb: u32,
    ctx: &PreClaimResources<'_>,
) {
    let destroy_task = match outcome {
        ExactSpeculationOutcome::Prepared(sandbox) => {
            match sandbox
                .repark_for_claim_rollback(run_id, u64::from(home_disk_mb) * 1024 * 1024)
                .await
            {
                SpeculativeReparkResult::Reparked(reservation) => {
                    let (destroy_task, snapshot) = {
                        let mut pool = ctx.idle_pool.lock().await;
                        let restore_result = pool.restore_reserved(*reservation);
                        let snapshot = pool.status_snapshot();
                        let destroy_task = match restore_result {
                            RestoreReservedIdleResult::Restored => None,
                            RestoreReservedIdleResult::Replaced(job)
                            | RestoreReservedIdleResult::Rejected(job) => Some(
                                ctx.idle_destroy_tracker
                                    .spawn_job(*job, "speculative_exact_reuse_claim_rollback"),
                            ),
                        };
                        (destroy_task, snapshot)
                    };
                    set_idle_status_snapshot(ctx.status, snapshot).await;
                    ctx.reuse_state_notify.notify_one();
                    destroy_task
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
                    Some(
                        ctx.idle_destroy_tracker
                            .spawn_job(*destroy_job, "speculative_exact_reuse_claim_rollback"),
                    )
                }
            }
        }
        ExactSpeculationOutcome::Failed { destroy_job, error } => {
            warn!(
                run_id = %run_id,
                error,
                "speculative exact-reuse preparation failed before claim resolved"
            );
            Some(
                ctx.idle_destroy_tracker
                    .spawn_job(*destroy_job, "speculative_exact_reuse_claim_rollback"),
            )
        }
    };
    if let Some(mut task) = destroy_task {
        if let Err(error) = task.join().await {
            warn!(%error, "speculative exact rollback cleanup producer lost");
        }
        ctx.reuse_state_notify.notify_one();
    }
}

#[cfg(test)]
mod tests;
