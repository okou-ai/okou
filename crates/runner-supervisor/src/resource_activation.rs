//! Claimed sandbox selection, activation and fallback above the idle, provider and executor owners.

use std::sync::Arc;
use std::time::Instant;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use futures_util::future::BoxFuture;
use runner_executor::executor::{
    BlankPoolSelection, BlankPoolSelectionReason, RunnerPreSpawnPhase, RunnerPreSpawnTiming,
};
use runner_host::paths::short_digest;
use runner_lifecycle::home_image_cache::{HomeImageCache, snapshot::HomeCacheStateSnapshot};
use runner_lifecycle::idle_pool::{
    BlankIdleReservationMiss, DestroyOutcome, IdlePoolSnapshot, IdleSandboxKind, IdleUnparkResult,
    RestoreReservedIdleResult, ReusableIdleSandbox,
};
use runner_lifecycle::resource_budget::{BudgetLease, ResourceBudget};
use runner_lifecycle::status::StatusTracker;
use runner_provider::RunCancellationHandle;
use runner_types::ids::RunId;
use runner_types::types::{ExecutionContext, SandboxReuseResult, reuse_key_kind};
use sandbox::{DeviceRateLimits, SandboxId};
use tokio::sync::{Notify, OwnedMutexGuard};
use tracing::{info, warn};

use crate::activation::{remove_failed_activation_status, retain_uncertain_activation_ownership};
use crate::blank_pool::BlankPoolDiagnostics;
use crate::idle_lifecycle::{
    IdleDestroyTracker, ReservedIdleActivation, SharedIdlePool,
    add_preparing_run_with_idle_status_snapshot, rollback_reserved_idle_for_spawn,
    spawn_idle_destroy_job,
};
use crate::orphan_reap::OrphanedActiveRuns;
/// Concrete owner resources projected by Runner without importing its `SpawnContext`.
pub struct ActivationResources<'a> {
    pub idle_pool: &'a SharedIdlePool,
    pub status: &'a StatusTracker,
    pub idle_destroy_tracker: &'a IdleDestroyTracker,
    pub orphaned_active_runs: &'a OrphanedActiveRuns,
    pub reuse_state_notify: &'a Notify,
    pub budget: &'a Arc<ResourceBudget>,
    pub home_cache: Option<&'a HomeImageCache>,
    pub home_cache_snapshot: &'a HomeCacheStateSnapshot,
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
    pub rootfs_hash: &'a str,
    pub device_rate_limits: &'a Option<DeviceRateLimits>,
    pub home_disk_mb: u32,
    pub context: &'a ExecutionContext,
    pub job_lease: BudgetLease,
}

pub struct ReuseFromPoolFailure {
    pub reuse_result: SandboxReuseResult,
    pub error: String,
}

/// Fully selected resource and transfer gate for a job fresh admission.
pub struct ReuseFromPoolReady {
    pub reuse_entry: Option<ReusableIdleSandbox>,
    pub active_lease: BudgetLease,
    pub reuse_result: SandboxReuseResult,
    pub idle_snapshot: Option<IdlePoolSnapshot>,
    pub needs_reuse_state_refresh: bool,
    pub transfer_guard: Option<OwnedMutexGuard<()>>,
}

pub struct ReservedActivationRequest<'a> {
    pub run_id: RunId,
    /// Observed producer home selected for this blank carrier.
    pub required_home_source_run_id: Option<RunId>,
    pub rootfs_hash: &'a str,
    pub profile_name: &'a str,
    pub device_rate_limits: &'a Option<DeviceRateLimits>,
    pub home_disk_mb: u32,
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

pub async fn activate_reserved_idle(
    reservation: ReservedIdleActivation,
    request: ReservedActivationRequest<'_>,
    ctx: &ActivationResources<'_>,
    pre_spawn_timing: &mut RunnerPreSpawnTiming,
) -> ReservedActivation {
    let (reservation, idle_snapshot) = reservation.into_parts();
    let ReservedActivationRequest {
        run_id,
        required_home_source_run_id,
        rootfs_hash,
        profile_name,
        device_rate_limits,
        home_disk_mb,
        context,
    } = request;
    let started_at = Instant::now();
    let requested_reuse_key = context.reuse_key();
    // Ordinary reuse preserves exact-over-blank priority. A blank carrying an
    // observed source home must not be replaced by a different VM's retained state.
    let (reservation, idle_snapshot) = match (
        reservation.kind(),
        requested_reuse_key,
        required_home_source_run_id,
    ) {
        (IdleSandboxKind::Blank, Some(reuse_key), None) => {
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
        (IdleSandboxKind::Exact | IdleSandboxKind::Blank, _, _) => (reservation, idle_snapshot),
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

    if reservation.profile_name() != profile_name
        || reservation.rootfs_hash() != rootfs_hash
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
            "reserved idle sandbox configuration does not match admitted job, destroying before fresh fallback"
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
            "job reuse key does not match reserved idle sandbox, destroying before fresh fallback"
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

    if let Some(cache) = ctx.home_cache {
        let started_at = Instant::now();
        let validation = reservation.validate_home_promotion_identity(
            cache,
            rootfs_hash,
            CANONICAL_WORKING_DIR,
            u64::from(home_disk_mb) * 1024 * 1024,
        );
        pre_spawn_timing
            .record_phase_elapsed(RunnerPreSpawnPhase::HomePromotionValidation, started_at);
        if let Err(mismatch) = validation {
            warn!(
                run_id = %run_id,
                reuse_key_fingerprint = reserved_reuse_key.as_deref().map(diagnostic_reuse_key_fingerprint),
                reuse_key_kind = reserved_reuse_key.as_deref().map(reuse_key_kind),
                profile = %profile_name,
                mismatch = mismatch.as_str(),
                "home promotion identity mismatch, destroying reserved idle sandbox before fresh fallback"
            );
            return cleanup_reserved_for_fresh_fallback(
                reservation.into_destroy_job_without_home_promotion_for_mismatch(),
                fallback_reuse_result,
                "reserved_reuse_home_promotion_mismatch",
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
        ctx.idle_destroy_tracker,
    )
    .await;
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
) -> Result<ReuseFromPoolReady, ReuseFromPoolFailure> {
    let ReuseAdmissionRequest {
        profile_name,
        rootfs_hash,
        device_rate_limits,
        home_disk_mb,
        context,
        job_lease,
    } = request;

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
    let home_cache_possible = exact.is_none()
        && (ctx.home_cache.is_some()
            && reuse_key.is_some_and(|key| {
                ctx.home_cache_snapshot
                    .has_compatible_home_hint(key, profile_name)
            }));
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::HomeCacheStateLookup, started_at);
    let (taken, blank_pool_selection) = match exact {
        Some(exact) => (Some(exact), None),
        None => {
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
    };
    if let Some(selection) = blank_pool_selection {
        pre_spawn_timing.record_blank_pool_selection(selection);
    }
    let took_idle_session = taken.is_some();
    let needs_reuse_state_refresh = took_idle_session || home_cache_possible;
    match taken {
        Some((entry, snapshot))
            if entry.profile_name() == profile_name
                && entry.rootfs_hash() == rootfs_hash
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
            if let Some(cache) = ctx.home_cache {
                let started_at = Instant::now();
                let validation = entry.validate_home_promotion_identity(
                    cache,
                    rootfs_hash,
                    CANONICAL_WORKING_DIR,
                    u64::from(home_disk_mb) * 1024 * 1024,
                );
                pre_spawn_timing
                    .record_phase_elapsed(RunnerPreSpawnPhase::HomePromotionValidation, started_at);
                if let Err(mismatch) = validation {
                    warn!(
                        run_id = %run_id,
                        reuse_key_fingerprint = entry_reuse_key.as_deref().map(diagnostic_reuse_key_fingerprint),
                        reuse_key_kind = entry_reuse_key.as_deref().map(reuse_key_kind),
                        profile = %profile_name,
                        mismatch = mismatch.as_str(),
                        "home promotion identity mismatch, destroying idle sandbox and falling through to fresh create"
                    );
                    spawn_idle_destroy_job(
                        ctx.idle_destroy_tracker,
                        entry.into_destroy_job_without_home_promotion_for_mismatch(),
                        "reuse_home_promotion_mismatch",
                    );
                    return Ok(ReuseFromPoolReady {
                        reuse_entry: None,
                        active_lease: job_lease,
                        reuse_result: fallback_reuse_result,
                        idle_snapshot: Some(snapshot),
                        needs_reuse_state_refresh,
                        transfer_guard: None,
                    });
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
                    ctx.idle_destroy_tracker,
                )
                .await;
                return Ok(ReuseFromPoolReady {
                    reuse_entry: None,
                    active_lease: job_lease,
                    reuse_result: fallback_reuse_result,
                    idle_snapshot: None,
                    needs_reuse_state_refresh,
                    transfer_guard: None,
                });
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
                    "failed to persist job idle sandbox activation ownership"
                );
                recover_failed_parked_activation_status(
                    ReservedIdleActivation::new(entry, idle_snapshot),
                    run_id,
                    sandbox_id,
                    ctx,
                )
                .await;
                return Ok(ReuseFromPoolReady {
                    reuse_entry: None,
                    active_lease: job_lease,
                    reuse_result: fallback_reuse_result,
                    idle_snapshot: None,
                    needs_reuse_state_refresh,
                    transfer_guard: None,
                });
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
                    Ok(ReuseFromPoolReady {
                        reuse_entry: Some(*sandbox),
                        active_lease: budget_lease,
                        reuse_result: activation_reuse_result,
                        idle_snapshot: Some(snapshot),
                        needs_reuse_state_refresh,
                        transfer_guard: Some(transfer_guard),
                    })
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
                    if cleanup.home_cache_promoted {
                        ctx.reuse_state_notify.notify_one();
                    }
                    drop(transfer_guard);
                    match cleanup.outcome {
                        DestroyOutcome::Completed => {
                            drop(cleanup.budget_lease);
                            Ok(ReuseFromPoolReady {
                                reuse_entry: None,
                                active_lease: job_lease,
                                reuse_result: unpark_failure_reuse_result,
                                idle_snapshot: Some(snapshot),
                                needs_reuse_state_refresh,
                                transfer_guard: None,
                            })
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
        Some((stale, snapshot))
            if stale.profile_name() == profile_name && stale.rootfs_hash() == rootfs_hash =>
        {
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
            Ok(ReuseFromPoolReady {
                reuse_entry: None,
                active_lease: job_lease,
                reuse_result: SandboxReuseResult::DeviceLimitMismatch,
                idle_snapshot: Some(snapshot),
                needs_reuse_state_refresh,
                transfer_guard: None,
            })
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
            Ok(ReuseFromPoolReady {
                reuse_entry: None,
                active_lease: job_lease,
                reuse_result: SandboxReuseResult::ProfileMismatch,
                idle_snapshot: Some(snapshot),
                needs_reuse_state_refresh,
                transfer_guard: None,
            })
        }
        None => {
            match reuse_key {
                Some(reuse_key) => info!(
                    run_id = %run_id,
                    reuse_key_fingerprint = %diagnostic_reuse_key_fingerprint(reuse_key),
                    reuse_key_kind = reuse_key_kind(reuse_key),
                    home_cache_possible,
                    "no compatible idle sandbox found for reuse key"
                ),
                None => info!(run_id = %run_id, "no compatible blank sandbox found"),
            }
            Ok(ReuseFromPoolReady {
                reuse_entry: None,
                active_lease: job_lease,
                reuse_result: miss_result,
                idle_snapshot: None,
                needs_reuse_state_refresh,
                transfer_guard: None,
            })
        }
    }
}
