//! Claimed sandbox selection, activation and fallback above the idle, provider and executor owners.

use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Instant;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use futures_util::{FutureExt, future::BoxFuture};
use runner_executor::executor::{
    BlankPoolSelection, BlankPoolSelectionReason, ExactReuseSpeculationTiming,
    GuestTimezoneSyncOutcome, RunnerPreSpawnOperationTiming, RunnerPreSpawnPhase,
    RunnerPreSpawnTiming, try_sync_guest_timezone_intent,
};
use runner_host::paths::short_digest;
use runner_lifecycle::guest_timezone::{GuestTimezoneAssumption, GuestTimezoneIntent};
use runner_lifecycle::idle_pool::{
    BlankIdleReservationMiss, DestroyOutcome, IdlePoolSnapshot, IdleSandboxKind, IdleUnparkResult,
    RestoreReservedIdleResult, ReusableIdleSandbox, SpeculativeIdleSandbox,
};
use runner_lifecycle::resource_budget::{BudgetLease, ResourceBudget};
use runner_lifecycle::status::StatusTracker;
use runner_lifecycle::workspace_image_cache::{
    WorkspaceImageCache, snapshot::WorkspaceCacheStateSnapshot,
};
use runner_provider::RunCancellationHandle;
use runner_types::ids::RunId;
use runner_types::types::{ExecutionContext, SandboxReuseResult, reuse_key_kind};
use sandbox::{DeviceRateLimits, SandboxId};
use tokio::sync::{Notify, OwnedMutexGuard};
use tracing::{info, warn};

use crate::blank_pool::BlankPoolDiagnostics;
use crate::claimed_activation::{
    remove_failed_activation_status, retain_uncertain_activation_ownership,
};
use crate::idle_lifecycle::{
    IdleDestroyTracker, ReservedIdleActivation, SharedIdlePool,
    add_preparing_run_with_idle_status_snapshot, rollback_reserved_idle_for_spawn,
    spawn_idle_destroy_job,
};
use crate::orphan_reap::OrphanedActiveRuns;
use crate::pre_claim_admission::{
    ExactSpeculation, ExactSpeculationOutcome, PreClaimResources,
    rollback_exact_speculation_outcome,
};

/// Concrete owner resources projected by Runner without importing its `SpawnContext`.
pub struct ActivationResources<'a> {
    pub idle_pool: &'a SharedIdlePool,
    pub status: &'a StatusTracker,
    pub idle_destroy_tracker: &'a IdleDestroyTracker,
    pub orphaned_active_runs: &'a OrphanedActiveRuns,
    pub reuse_state_notify: &'a Notify,
    pub budget: &'a Arc<ResourceBudget>,
    pub workspace_cache: Option<&'a WorkspaceImageCache>,
    pub workspace_cache_snapshot: &'a WorkspaceCacheStateSnapshot,
    pub blank_pool_diagnostics: &'a BlankPoolDiagnostics,
    /// Runs after durable preparing status and before unpark; supplied only for Runner tests.
    pub on_preparing_committed: Option<Arc<dyn Fn(RunId) -> BoxFuture<'static, ()> + Send + Sync>>,
}

impl ActivationResources<'_> {
    async fn preparing_committed(&self, run_id: RunId) {
        if let Some(callback) = &self.on_preparing_committed {
            (callback)(run_id).await;
        }
    }
}

pub struct ReuseAdmissionRequest<'a> {
    pub profile_name: &'a str,
    pub device_rate_limits: &'a Option<DeviceRateLimits>,
    pub workspace_disk_mb: u32,
    pub context: &'a ExecutionContext,
    pub job_lease: BudgetLease,
}

pub struct ReuseFromPoolFailure {
    pub reuse_result: SandboxReuseResult,
    pub error: String,
}

pub struct ReservedActivationRequest<'a> {
    pub run_id: RunId,
    pub profile_name: &'a str,
    pub device_rate_limits: &'a Option<DeviceRateLimits>,
    pub workspace_disk_mb: u32,
    pub context: &'a ExecutionContext,
}

fn diagnostic_reuse_key_fingerprint(reuse_key: &str) -> String {
    short_digest(reuse_key)
}

pub enum ReservedActivation {
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

/// Opaque failed transfer retained until Runner has completed the provider claim.
/// A prepared sandbox cannot be committed by the caller after cancellation.
pub struct CancelledExactResource(CancelledExactResourceKind);

enum CancelledExactResourceKind {
    Prepared(Box<SpeculativeIdleSandbox>),
    Fresh(BudgetLease),
}

impl CancelledExactResource {
    pub async fn rollback(
        self,
        run_id: RunId,
        workspace_disk_mb: u32,
        resources: &PreClaimResources<'_>,
    ) {
        match self.0 {
            CancelledExactResourceKind::Prepared(sandbox) => {
                rollback_exact_speculation_outcome(
                    ExactSpeculationOutcome::Prepared(sandbox),
                    run_id,
                    workspace_disk_mb,
                    resources,
                )
                .await;
            }
            CancelledExactResourceKind::Fresh(budget_lease) => drop(budget_lease),
        }
    }
}

pub enum ExactActivation {
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

/// Finish speculative activation under the cancellation transfer guard.
pub async fn activate_speculated_exact(
    speculation: ExactSpeculation,
    request: ReservedActivationRequest<'_>,
    ctx: &ActivationResources<'_>,
    pre_spawn_timing: &mut RunnerPreSpawnTiming,
    cancellation: &RunCancellationHandle,
) -> ExactActivation {
    let run_id = request.run_id;
    let pending = prepare_speculated_exact(speculation, request, ctx, pre_spawn_timing).await;
    finish_exact_activation(pending, cancellation, run_id).await
}

async fn prepare_speculated_exact(
    speculation: ExactSpeculation,
    request: ReservedActivationRequest<'_>,
    ctx: &ActivationResources<'_>,
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
                ctx,
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
            ctx,
        )
        .await;
    }

    if let Some(cache) = ctx.workspace_cache {
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
                ctx,
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
                        ctx,
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
                        ctx,
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
                    resource: CancelledExactResource(CancelledExactResourceKind::Prepared(sandbox)),
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
                    resource: CancelledExactResource(CancelledExactResourceKind::Fresh(
                        active_lease,
                    )),
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
                    resource: CancelledExactResource(CancelledExactResourceKind::Fresh(
                        budget_lease,
                    )),
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

pub async fn activate_reserved_idle(
    reservation: ReservedIdleActivation,
    request: ReservedActivationRequest<'_>,
    ctx: &ActivationResources<'_>,
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
                        ctx.idle_destroy_tracker,
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
        let possible = ctx.workspace_cache.is_some()
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

    if let Some(cache) = ctx.workspace_cache {
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
        ctx.status,
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
    ctx.preparing_committed(run_id).await;

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
                    ctx.status,
                    ctx.orphaned_active_runs,
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
    ctx: &ActivationResources<'_>,
) {
    remove_failed_activation_status(ctx.status, run_id, sandbox_id).await;
    rollback_reserved_idle_for_spawn(
        reservation,
        ctx.idle_pool,
        ctx.status,
        ctx.reuse_state_notify,
    )
    .await;
}

async fn cleanup_claimed_speculation_for_fresh_fallback(
    destroy_job: runner_lifecycle::idle_pool::IdleDestroyJob,
    reuse_result: SandboxReuseResult,
    cleanup_context: &'static str,
    run_id: RunId,
    sandbox_id: SandboxId,
    idle_snapshot: &IdlePoolSnapshot,
    ctx: &ActivationResources<'_>,
) -> PendingExactActivation {
    let activation =
        cleanup_reserved_for_fresh_fallback(destroy_job, reuse_result, cleanup_context, ctx).await;
    if matches!(activation, FreshFallbackActivation::CannotStart { .. }) {
        if let Err(error) = add_preparing_run_with_idle_status_snapshot(
            ctx.status,
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
            ctx.status,
            ctx.orphaned_active_runs,
            run_id,
            sandbox_id,
            cleanup_context,
        );
    }
    activation.into()
}

async fn cleanup_reserved_for_fresh_fallback(
    destroy_job: runner_lifecycle::idle_pool::IdleDestroyJob,
    reuse_result: SandboxReuseResult,
    cleanup_context: &'static str,
    ctx: &ActivationResources<'_>,
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

pub async fn try_reuse_from_pool(
    run_id: RunId,
    request: ReuseAdmissionRequest<'_>,
    ctx: &ActivationResources<'_>,
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
    let claimed_workspace_cache_reuse_key = ctx.workspace_cache.is_some()
        && reuse_key.is_some_and(|reuse_key| {
            ctx.workspace_cache_snapshot
                .might_contain_workspace_cache_reuse_key(reuse_key)
        });
    pre_spawn_timing
        .record_phase_elapsed(RunnerPreSpawnPhase::WorkspaceCacheStateLookup, started_at);
    let (taken, blank_pool_selection) = match exact {
        Some(exact) => (Some(exact), None),
        None if !claimed_workspace_cache_reuse_key => {
            let mut pool = ctx.idle_pool.lock().await;
            let exact = reuse_key
                .and_then(|reuse_key| pool.take_reserved(reuse_key))
                .map(|entry| (entry, pool.status_snapshot()));
            if exact.is_some() {
                (exact, None)
            } else {
                match pool.reserve_blank(profile_name, device_rate_limits) {
                    Ok(entry) => (
                        Some((entry, pool.status_snapshot())),
                        Some(BlankPoolSelection::Hit),
                    ),
                    Err(BlankIdleReservationMiss::Empty) => (
                        None,
                        Some(ctx.blank_pool_diagnostics.classify_empty(
                            profile_name,
                            device_rate_limits,
                            pool.revision(),
                            ctx.budget,
                        )),
                    ),
                    Err(BlankIdleReservationMiss::Incompatible) => (
                        None,
                        Some(BlankPoolSelection::Miss(
                            BlankPoolSelectionReason::IncompatibleShape,
                        )),
                    ),
                    Err(BlankIdleReservationMiss::Unknown) => (
                        None,
                        Some(BlankPoolSelection::Miss(BlankPoolSelectionReason::Unknown)),
                    ),
                }
            }
        }
        None => (None, None),
    };
    if let Some(selection) = blank_pool_selection {
        pre_spawn_timing.record_blank_pool_selection(selection);
    }
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
            if let Some(cache) = ctx.workspace_cache {
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
                        ctx.idle_destroy_tracker,
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
                    ctx.idle_pool,
                    ctx.status,
                    ctx.reuse_state_notify,
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
                    ctx,
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
            ctx.preparing_committed(run_id).await;
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
                        ctx.reuse_state_notify.notify_one();
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
                                ctx.status,
                                ctx.orphaned_active_runs,
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
                ctx.idle_destroy_tracker,
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
                ctx.idle_destroy_tracker,
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
