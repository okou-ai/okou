//! Sandbox finalization after executor completion.
//!
//! This module owns the post-executor finalizing transition and decision to
//! park or destroy a sandbox, including reuse resolution and outcome telemetry.
//! `job_lifecycle` coordinates provider completion and status/lease settlement;
//! Runner wires the executor, deferred uploads, and outer panic boundary.

use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::SecondsFormat;
use futures_util::FutureExt;
use sandbox::{
    Sandbox, SandboxFactory, SandboxFinalExecParkHandoffPoint, SandboxFinalExecParkObserver,
    SandboxFinalExecParkStage, SandboxFinalExecParkSubstage, SandboxFinalExecParkSubstageOutcome,
    SandboxId,
};
use tracing::{info, warn};

use crate::idle_lifecycle::{IdleDestroyTracker, SharedIdlePool, destroy_idle_payload_and_wait};
use crate::job_lifecycle::{
    ActiveBudgetLease, BudgetOwnership, FinalizationReady, RunCleanupDisposition, RunCleanupState,
};
use crate::ownership::OwnershipTransitions;
use runner_executor::executor::{SandboxReuseDisposition, SandboxReuseTerminal};
use runner_executor::telemetry::JobTelemetry;
use runner_host::home_observation::{HomeObservation, HomeObservationKind, HomeObservationOutcome};
use runner_lifecycle::active_runs::{ActiveRunHandoffDeliveryResult, ActiveRunReusePublisher};
use runner_lifecycle::guest_timezone::GuestTimezoneIntent;
use runner_lifecycle::home_image_cache::snapshot::HomeCacheStateSnapshot;
use runner_lifecycle::home_image_cache::{
    HomeCacheTerminalStatus, HomeImageLease, HomeImagePromotionContext, HomeImagePromotionRequest,
};
use runner_lifecycle::home_promotion::prepare_home_image_from_active_sandbox;
use runner_lifecycle::idle_pool::{
    DestroyOutcome, IdleDestroyPayload, IdleParkActiveParts, IdleParkCandidate,
    IdleParkFailureParts, IdleParkRequest, IdleParkRequestParts, ParkResult, ParkedIdleCandidate,
    ParkingGate,
};
use runner_lifecycle::resource_budget::BudgetLease;
use runner_lifecycle::restored_session_identity::RestoredSessionIdentity;
use runner_lifecycle::status::StatusTracker;
use runner_network::network_log_drain::NetworkLogDrainCoordinator;
use runner_network::network_log_manager::NetworkLogSession;
use runner_provider::RunCancellationHandle;
use runner_types::ids::RunId;
use runner_types::storage_fingerprints::StorageFingerprints;
use runner_types::types::reuse_key_kind;
use runner_types::types::{
    HOME_AFFINITY_VERSION, HeldHomeState, HomeCacheCapability, SandboxReuseResult,
};

struct FinalizationTelemetry<'a> {
    telemetry: Option<&'a mut JobTelemetry>,
    physical_park_completed_at: Option<Instant>,
    home_identity: HomeObservation,
}

impl<'a> FinalizationTelemetry<'a> {
    fn new(telemetry: &'a mut JobTelemetry, ctx: &FinalizeContext) -> Self {
        let mut home_identity = HomeObservation::new(
            HomeObservationKind::Preservation,
            HomeObservationOutcome::Retained,
        );
        home_identity.run_id = Some(ctx.run_id);
        home_identity.reuse_key = ctx.reuse_key.clone();
        home_identity.profile_name = Some(ctx.profile_name.clone());
        Self {
            telemetry: Some(telemetry),
            physical_park_completed_at: None,
            home_identity,
        }
    }

    #[cfg(test)]
    fn disabled() -> Self {
        Self {
            telemetry: None,
            physical_park_completed_at: None,
            home_identity: HomeObservation::new(
                HomeObservationKind::Preservation,
                HomeObservationOutcome::Retained,
            ),
        }
    }

    fn record_idle_publication(&mut self, success: bool, error: Option<&'static str>) {
        let Some(started_at) = self.physical_park_completed_at else {
            return;
        };
        if let Some(telemetry) = self.telemetry.as_deref_mut() {
            telemetry.record(
                "runner_host_idle_publication",
                started_at.elapsed(),
                success,
                error,
            );
            if success {
                let mut observation = self.home_identity.clone();
                observation.reason = Some("idle_pool".into());
                telemetry.observe_home(observation);
            }
        }
    }

    fn record_outcome(&mut self, action_type: &'static str, error: &'static str) {
        if let Some(telemetry) = self.telemetry.as_deref_mut() {
            telemetry.record(action_type, Duration::ZERO, false, Some(error));
        }
    }

    fn record_handoff_delivered(&mut self, handoff_path: &'static str) {
        if let Some(telemetry) = self.telemetry.as_deref_mut() {
            let mut observation = self.home_identity.clone();
            observation.reason = Some("exact_handoff".into());
            observation.handoff_path = Some(handoff_path.into());
            telemetry.observe_home(observation);
        }
    }

    fn record_handoff_failed(&mut self, error: &'static str, outcome: &'static str) {
        if let Some(telemetry) = self.telemetry.as_deref_mut() {
            // A refused/cancelled attempt can still fall back to idle or image
            // preservation. Keep its diagnostic separate from retained-home facts.
            telemetry.record_with_outcome(
                "runner_host_exact_sandbox_handoff",
                Duration::ZERO,
                false,
                Some(error),
                Some(outcome),
            );
        }
    }
}

impl SandboxFinalExecParkObserver for FinalizationTelemetry<'_> {
    fn record_stage(
        &mut self,
        stage: SandboxFinalExecParkStage,
        duration: Duration,
        success: bool,
    ) {
        let completed_at = Instant::now();
        let (action_type, error) = match stage {
            SandboxFinalExecParkStage::ReusePreparation => (
                "runner_host_reuse_preparation",
                (!success).then_some("reuse preparation failed"),
            ),
            SandboxFinalExecParkStage::PhysicalPark => (
                "runner_host_physical_park",
                (!success).then_some("physical park failed"),
            ),
        };
        if let Some(telemetry) = self.telemetry.as_deref_mut() {
            telemetry.record(action_type, duration, success, error);
        }
        if stage == SandboxFinalExecParkStage::PhysicalPark && success {
            self.physical_park_completed_at = Some(completed_at);
        }
    }

    fn record_substage(
        &mut self,
        substage: SandboxFinalExecParkSubstage,
        duration: Duration,
        success: bool,
        outcome: Option<SandboxFinalExecParkSubstageOutcome>,
    ) {
        let (action_type, error) = match substage {
            SandboxFinalExecParkSubstage::BalloonSetup => (
                "runner_host_physical_park_balloon_setup",
                (!success).then_some("balloon setup failed"),
            ),
            SandboxFinalExecParkSubstage::BalloonSettle => (
                "runner_host_physical_park_balloon_settle",
                (!success).then_some("balloon settle failed"),
            ),
            SandboxFinalExecParkSubstage::BalloonDeflate => (
                "runner_host_physical_park_balloon_deflate",
                (!success).then_some("balloon deflation failed"),
            ),
            SandboxFinalExecParkSubstage::VcpuPause => (
                "runner_host_physical_park_vcpu_pause",
                (!success).then_some("vCPU pause failed"),
            ),
        };
        if let Some(telemetry) = self.telemetry.as_deref_mut() {
            telemetry.record_with_outcome(
                action_type,
                duration,
                success,
                error,
                outcome.map(SandboxFinalExecParkSubstageOutcome::as_str),
            );
        }
    }
}

enum ExactHandoffAttempt {
    Delivered {
        handoff_point: Option<SandboxFinalExecParkHandoffPoint>,
    },
    ContinueIdle(ParkedIdleCandidate),
    Destroy {
        candidate: IdleParkCandidate,
        error: &'static str,
    },
}

enum UndeliveredExactHandoff {
    ContinueIdle(ParkedIdleCandidate),
    Destroy {
        candidate: IdleParkCandidate,
        error: &'static str,
    },
}

fn deliver_exact_handoff(
    publisher: &ActiveRunReusePublisher,
    candidate: IdleParkCandidate,
    predecessor_run_id: RunId,
) -> ExactHandoffAttempt {
    let handoff_point = match &candidate {
        IdleParkCandidate::Ordinary(_) => None,
        IdleParkCandidate::Immediate(candidate) => Some(candidate.handoff_point()),
    };
    match publisher.deliver_exact_handoff(candidate, predecessor_run_id) {
        ActiveRunHandoffDeliveryResult::Delivered => {
            ExactHandoffAttempt::Delivered { handoff_point }
        }
        ActiveRunHandoffDeliveryResult::NotRequested(IdleParkCandidate::Ordinary(candidate)) => {
            ExactHandoffAttempt::ContinueIdle(candidate)
        }
        ActiveRunHandoffDeliveryResult::NotRequested(candidate) => ExactHandoffAttempt::Destroy {
            candidate,
            error: "request_unavailable",
        },
        ActiveRunHandoffDeliveryResult::Failed(candidate) => ExactHandoffAttempt::Destroy {
            candidate,
            error: "receiver_unavailable",
        },
    }
}

fn local_completed_at() -> String {
    chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn mark_reuse_state_refresh(
    finalization_ready: FinalizationReady,
    reuse_state_changed: bool,
) -> FinalizationReady {
    if reuse_state_changed {
        finalization_ready.with_reuse_state_changed()
    } else {
        finalization_ready
    }
}

fn mark_home_cache_snapshot_promoted(
    source_run_id: RunId,
    snapshot: &HomeCacheStateSnapshot,
    cache_key: Option<&str>,
    reuse_key: Option<&str>,
    profile_name: &str,
    completed_at: &str,
    promoted: bool,
) -> bool {
    if promoted && let (Some(cache_key), Some(reuse_key)) = (cache_key, reuse_key) {
        snapshot.upsert_home_cache_state(
            cache_key.to_owned(),
            HeldHomeState {
                reuse_key: reuse_key.to_owned(),
                last_completed_at: completed_at.to_owned(),
                home_caches: vec![HomeCacheCapability {
                    profile: profile_name.to_owned(),
                    home_affinity_version: HOME_AFFINITY_VERSION,
                    source_run_id,
                }],
            },
        );
    }
    promoted
}

pub struct FinalizeContext {
    pub run_id: RunId,
    pub sandbox_id: SandboxId,
    pub runner_id: String,
    pub reuse_result: SandboxReuseResult,
    pub profile_name: String,
    pub rootfs_hash: String,
    pub reuse_key: Option<String>,
    pub cli_agent_session_id: Option<String>,
    pub discovered_cli_agent_session_id: Option<String>,
    pub restored_session_identity: Option<RestoredSessionIdentity>,
    pub source_ip: String,
    pub network_log_session: Option<NetworkLogSession>,
    pub home_image: Option<HomeImageLease>,
    pub home_image_size_bytes: u64,
    pub storage_fingerprints: StorageFingerprints,
    pub device_rate_limits: Option<sandbox::DeviceRateLimits>,
    pub guest_timezone_intent: GuestTimezoneIntent,
    pub factory: Arc<Box<dyn SandboxFactory>>,
    pub idle_pool: SharedIdlePool,
    pub idle_destroy_tracker: IdleDestroyTracker,
    pub status: Arc<StatusTracker>,
    pub reuse_state_notify: Arc<tokio::sync::Notify>,
    pub active_run_reuse: ActiveRunReusePublisher,
    pub home_cache_snapshot: HomeCacheStateSnapshot,
    pub parking_gate: ParkingGate,
    pub network_log_drain: NetworkLogDrainCoordinator,
    pub exit_code: i32,
    pub sandbox_reuse_disposition: SandboxReuseDisposition,
    pub cancel: RunCancellationHandle,
    pub cleanup_state: RunCleanupState,
}

/// Synchronous lifecycle checkpoints for tests of finalization and its caller.
/// Not present in the default production build.
#[cfg(any(test, feature = "test-support"))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FinalizationTestEvent {
    BeforeIdlePoolOwnershipTransfer { run_id: RunId },
    SandboxParkedForReuse { run_id: RunId, reuse_key: String },
    HandoffOwned { run_id: RunId },
    IdlePoolOwned { run_id: RunId },
    DestroyCompleted { run_id: RunId },
}

#[cfg(any(test, feature = "test-support"))]
#[derive(Clone, Default)]
pub struct FinalizationTestHooks {
    pub on_event: Option<Arc<dyn Fn(FinalizationTestEvent) + Send + Sync>>,
}

#[cfg(any(test, feature = "test-support"))]
impl FinalizationTestHooks {
    fn emit(&self, event: FinalizationTestEvent) {
        if let Some(callback) = &self.on_event {
            callback(event);
        }
    }
}

/// Coordinate the finalizing transition, physical resource disposition and
/// observable outcome after executor return. Provider reporting and settlement
/// surround this future in `job_lifecycle`.
pub async fn finalize_claimed_run(
    sandbox: Option<Box<dyn Sandbox>>,
    active_lease: ActiveBudgetLease,
    telemetry: &mut JobTelemetry,
    ctx: FinalizeContext,
) -> FinalizationReady {
    finalize_claimed_run_inner(
        sandbox,
        active_lease,
        telemetry,
        ctx,
        #[cfg(any(test, feature = "test-support"))]
        FinalizationTestHooks::default(),
    )
    .await
}

/// Keep fault injection outside the production finalization interface.
#[cfg(any(test, feature = "test-support"))]
pub async fn finalize_claimed_run_with_test_hooks(
    sandbox: Option<Box<dyn Sandbox>>,
    active_lease: ActiveBudgetLease,
    telemetry: &mut JobTelemetry,
    ctx: FinalizeContext,
    test_hooks: FinalizationTestHooks,
) -> FinalizationReady {
    finalize_claimed_run_inner(sandbox, active_lease, telemetry, ctx, test_hooks).await
}

async fn finalize_claimed_run_inner(
    sandbox: Option<Box<dyn Sandbox>>,
    active_lease: ActiveBudgetLease,
    telemetry: &mut JobTelemetry,
    ctx: FinalizeContext,
    #[cfg(any(test, feature = "test-support"))] test_hooks: FinalizationTestHooks,
) -> FinalizationReady {
    let had_sandbox = sandbox.is_some();
    let has_restored_session_identity = ctx.restored_session_identity.is_some();
    let has_reuse_key = ctx.reuse_key.is_some();
    let disposition = ctx.sandbox_reuse_disposition;
    let cleanup_state = ctx.cleanup_state.clone();
    let active_run_reuse = ctx.active_run_reuse.clone();
    let reuse_state_notify = Arc::clone(&ctx.reuse_state_notify);
    let started = Instant::now();
    if has_reuse_key {
        assert!(
            active_run_reuse.mark_finalizing(started),
            "reusable active run entered finalization from a resolved state"
        );
    }
    telemetry.record(
        "runner_host_finalization_started",
        Duration::ZERO,
        true,
        None,
    );
    let ready = finalize_sandbox_for_completion_inner(
        sandbox,
        active_lease,
        FinalizationTelemetry::new(telemetry, &ctx),
        ctx,
        #[cfg(any(test, feature = "test-support"))]
        test_hooks,
    )
    .await;
    if has_reuse_key && active_run_reuse.publish_no_exact_sandbox() {
        reuse_state_notify.notify_one();
    }
    let final_disposition = cleanup_state.disposition();
    let reuse_state_changed = ready.reuse_state_changed();
    if had_sandbox {
        telemetry.record(disposition.telemetry_action(), Duration::ZERO, true, None);
    }
    let (action, success, error) = match final_disposition {
        RunCleanupDisposition::IdlePoolOwned | RunCleanupDisposition::HandoffOwned => {
            ("runner_host_finalization_reusable_sandbox", true, None)
        }
        _ if reuse_state_changed => ("runner_host_finalization_home_cache", true, None),
        RunCleanupDisposition::DestroyCompleted | RunCleanupDisposition::StatusRemoved => {
            ("runner_host_finalization_no_resource", true, None)
        }
        RunCleanupDisposition::ActiveOrUnknown if !had_sandbox => {
            ("runner_host_finalization_no_resource", true, None)
        }
        RunCleanupDisposition::ActiveOrUnknown => (
            "runner_host_finalization_failed",
            false,
            Some("sandbox ownership unresolved"),
        ),
    };
    telemetry.record(action, started.elapsed(), success, error);
    if matches!(final_disposition, RunCleanupDisposition::IdlePoolOwned) {
        let action = if has_restored_session_identity {
            "session_history_identity_parked"
        } else {
            "session_history_identity_park_missing"
        };
        telemetry.record(action, Duration::ZERO, true, None);
    }
    ready
}

/// Finalizes ownership of a sandbox returned by the executor.
///
/// `None` requires no sandbox lifecycle action. For `Some`, idle parking is
/// considered only when execution supplied positive reuse evidence, hard
/// cancellation is not active, the parking gate is open, and a reuse key is
/// available. Otherwise, or if hard cancellation wins before ownership
/// transfer or parking cannot complete, the sandbox is stopped and destroyed.
pub async fn finalize_sandbox_for_completion_with_telemetry(
    sandbox: Option<Box<dyn Sandbox>>,
    active_lease: ActiveBudgetLease,
    telemetry: &mut JobTelemetry,
    ctx: FinalizeContext,
) -> FinalizationReady {
    finalize_sandbox_for_completion_inner(
        sandbox,
        active_lease,
        FinalizationTelemetry::new(telemetry, &ctx),
        ctx,
        #[cfg(any(test, feature = "test-support"))]
        FinalizationTestHooks::default(),
    )
    .await
}

/// Test-only entrypoint that observes finalization without exposing hooks to
/// the production context or changing its call signature.
#[cfg(feature = "test-support")]
pub async fn finalize_sandbox_for_completion_with_test_hooks(
    sandbox: Option<Box<dyn Sandbox>>,
    active_lease: ActiveBudgetLease,
    telemetry: &mut JobTelemetry,
    ctx: FinalizeContext,
    test_hooks: FinalizationTestHooks,
) -> FinalizationReady {
    finalize_sandbox_for_completion_inner(
        sandbox,
        active_lease,
        FinalizationTelemetry::new(telemetry, &ctx),
        ctx,
        test_hooks,
    )
    .await
}

#[cfg(test)]
async fn finalize_sandbox_for_completion(
    sandbox: Option<Box<dyn Sandbox>>,
    active_lease: ActiveBudgetLease,
    ctx: FinalizeContext,
) -> FinalizationReady {
    finalize_sandbox_for_completion_inner(
        sandbox,
        active_lease,
        FinalizationTelemetry::disabled(),
        ctx,
        FinalizationTestHooks::default(),
    )
    .await
}

#[cfg(test)]
async fn finalize_sandbox_for_completion_observed(
    sandbox: Option<Box<dyn Sandbox>>,
    active_lease: ActiveBudgetLease,
    ctx: FinalizeContext,
    test_hooks: FinalizationTestHooks,
) -> FinalizationReady {
    finalize_sandbox_for_completion_inner(
        sandbox,
        active_lease,
        FinalizationTelemetry::disabled(),
        ctx,
        test_hooks,
    )
    .await
}

async fn finalize_sandbox_for_completion_inner(
    sandbox: Option<Box<dyn Sandbox>>,
    active_lease: ActiveBudgetLease,
    mut telemetry: FinalizationTelemetry<'_>,
    ctx: FinalizeContext,
    #[cfg(any(test, feature = "test-support"))] test_hooks: FinalizationTestHooks,
) -> FinalizationReady {
    let Some(sandbox) = sandbox else {
        return FinalizationReady::new(BudgetOwnership::active(active_lease));
    };

    let FinalizeContext {
        run_id,
        sandbox_id,
        runner_id,
        reuse_result,
        profile_name,
        rootfs_hash,
        reuse_key,
        cli_agent_session_id,
        discovered_cli_agent_session_id,
        restored_session_identity,
        source_ip,
        mut network_log_session,
        home_image,
        home_image_size_bytes,
        storage_fingerprints,
        device_rate_limits,
        guest_timezone_intent,
        factory,
        idle_pool,
        idle_destroy_tracker,
        status,
        reuse_state_notify,
        active_run_reuse,
        home_cache_snapshot,
        parking_gate,
        network_log_drain,
        exit_code,
        sandbox_reuse_disposition,
        cancel,
        cleanup_state,
    } = ctx;

    let destroy_bookkeeping = DestroyBookkeepingContext {
        cleanup_state: &cleanup_state,
        idle_destroy_tracker: &idle_destroy_tracker,
        #[cfg(any(test, feature = "test-support"))]
        run_id,
        #[cfg(any(test, feature = "test-support"))]
        test_hooks: &test_hooks,
    };
    let cancelled = cancel.is_cancelled();
    let hard_cancelled = cancel.is_hard_cancelled();
    if hard_cancelled {
        telemetry.record_outcome("runner_host_finalization_cancelled", "cancelled");
    }
    let terminal_status = home_terminal_status(exit_code, cancelled);
    let completed_at = local_completed_at();
    let resolved_cli_agent_session_id = cli_agent_session_id
        .as_deref()
        .or(discovered_cli_agent_session_id.as_deref());
    info!(
        run_id = %run_id,
        sandbox_reuse_disposition = sandbox_reuse_disposition.as_str(),
        "evaluating terminal sandbox reuse"
    );
    let parkable_reuse_key =
        if sandbox_reuse_disposition.is_eligible() && !hard_cancelled && parking_gate.is_open() {
            reuse_key.clone()
        } else {
            None
        };
    let home_cache_key = home_image
        .as_ref()
        .and_then(HomeImageLease::cache_key)
        .map(str::to_owned);
    let home_promotion = home_image.and_then(|home_image| {
        home_image.into_promotion_context(HomeImagePromotionRequest {
            run_id,
            sandbox_id,
            restored_session_identity: restored_session_identity.as_ref(),
            terminal_status,
            completed_at: completed_at.clone(),
            storage_fingerprints: storage_fingerprints.clone(),
        })
    });
    let home_promotion_reuse_key = home_promotion
        .as_ref()
        .map(|promotion| promotion.reuse_key().to_owned());

    let mut reuse_state_changed = false;
    let budget = 'finalization: {
        let Some(reuse_key) = parkable_reuse_key else {
            // No parkable reuse key — stop + destroy.
            let cleanup_reason = active_cleanup_reason(
                sandbox_reuse_disposition,
                hard_cancelled,
                parking_gate.is_open(),
            );
            let destroy_result = stop_and_destroy_sandbox(
                sandbox,
                &**factory,
                home_promotion,
                ActiveCleanupContext {
                    run_id,
                    sandbox_id,
                    profile_name: &profile_name,
                    cli_agent_session_id: resolved_cli_agent_session_id,
                    reason: cleanup_reason,
                    network_log_session: network_log_session.take(),
                    network_log_drain: network_log_drain.clone(),
                },
            )
            .await;
            reuse_state_changed |= mark_home_cache_snapshot_promoted(
                run_id,
                &home_cache_snapshot,
                home_cache_key.as_deref(),
                home_promotion_reuse_key.as_deref(),
                &profile_name,
                &completed_at,
                destroy_result.home_cache_promoted,
            );
            record_destroy_result(destroy_result.outcome, destroy_bookkeeping);
            break 'finalization BudgetOwnership::active(active_lease);
        };
        let reuse_key_fingerprint = runner_host::paths::short_digest(&reuse_key);
        let reuse_kind = reuse_key_kind(&reuse_key);
        // Inflate the guest balloon BEFORE acquiring the pool lock —
        // the HTTP call to Firecracker can take milliseconds, and we
        // must not block other take/park operations on it.
        let native_generation_run_id = match sandbox_reuse_disposition {
            SandboxReuseDisposition::Eligible(SandboxReuseTerminal::Success) => Some(run_id),
            SandboxReuseDisposition::Eligible(
                SandboxReuseTerminal::NonzeroExit
                | SandboxReuseTerminal::ExecutionTimeout
                | SandboxReuseTerminal::CooperativeCancellation,
            )
            | SandboxReuseDisposition::Ineligible(_) => None,
        };
        let publishes_exact_sandbox = native_generation_run_id == Some(run_id);
        let park_request = IdleParkRequest::new(IdleParkRequestParts {
            run_id,
            sandbox,
            factory: Arc::clone(&factory),
            reuse_key: reuse_key.clone(),
            sandbox_id,
            profile_name: profile_name.clone(),
            rootfs_hash: rootfs_hash.clone(),
            device_rate_limits: device_rate_limits.clone(),
            budget_lease: active_lease.into_idle_park_lease(),
            source_ip,
            storage_fingerprints,
            restored_session_identity,
            native_generation_run_id,
            guest_timezone_intent,
            home_image_size_bytes,
            home_promotion,
            // Physical reuse eligibility was established above. Native history
            // authority is independent: a failed run can still hand off its home.
            handoff: Some(active_run_reuse.handoff_signal()),
        });
        let park_outcome = match park_request
            .park_for_idle_with_observer(&mut telemetry)
            .await
        {
            Ok(outcome) => outcome,
            Err(failure) => match failure.into_parts() {
                IdleParkFailureParts::Active {
                    active,
                    reason,
                    error,
                } => {
                    telemetry.record_idle_publication(false, Some(reason));
                    let IdleParkActiveParts {
                        sandbox,
                        factory: failure_factory,
                        budget_lease,
                        home_promotion,
                    } = active;
                    warn!(
                        run_id = %run_id,
                        reuse_key_fingerprint = %reuse_key_fingerprint,
                        reuse_key_kind = reuse_kind,
                        reason,
                        error,
                        "sandbox idle admission failed, destroying instead of parking"
                    );
                    let destroy_result = stop_and_destroy_sandbox(
                        sandbox,
                        &**failure_factory,
                        home_promotion,
                        ActiveCleanupContext {
                            run_id,
                            sandbox_id,
                            profile_name: &profile_name,
                            cli_agent_session_id: resolved_cli_agent_session_id,
                            reason,
                            network_log_session: network_log_session.take(),
                            network_log_drain: network_log_drain.clone(),
                        },
                    )
                    .await;
                    let home_cache_promoted = mark_home_cache_snapshot_promoted(
                        run_id,
                        &home_cache_snapshot,
                        home_cache_key.as_deref(),
                        Some(&reuse_key),
                        &profile_name,
                        &completed_at,
                        destroy_result.home_cache_promoted,
                    );
                    record_destroy_result(destroy_result.outcome, destroy_bookkeeping);
                    return mark_reuse_state_refresh(
                        FinalizationReady::new(BudgetOwnership::active(
                            ActiveBudgetLease::from_idle_park_lease(budget_lease),
                        )),
                        home_cache_promoted,
                    );
                }
                IdleParkFailureParts::Parked {
                    rejected,
                    reason,
                    error,
                    expected_capacity_rejection,
                } => {
                    telemetry.record_idle_publication(false, Some(reason));
                    if expected_capacity_rejection {
                        info!(
                            run_id = %run_id,
                            reuse_key_fingerprint = %reuse_key_fingerprint,
                            reuse_key_kind = reuse_kind,
                            reason,
                            error,
                            "parked sandbox rejected by idle capacity admission, destroying instead of reusing"
                        );
                    } else {
                        warn!(
                            run_id = %run_id,
                            reuse_key_fingerprint = %reuse_key_fingerprint,
                            reuse_key_kind = reuse_kind,
                            reason,
                            error,
                            "parked sandbox failed idle admission, destroying instead of reusing"
                        );
                    }
                    close_network_log_session(
                        run_id,
                        network_log_session.take(),
                        &network_log_drain,
                    )
                    .await;
                    let (payload, budget_lease) = rejected.into_active_destroy_parts();
                    let destroy_result = destroy_active_owned_idle_payload(
                        payload,
                        budget_lease,
                        reason,
                        destroy_bookkeeping,
                    )
                    .await;
                    reuse_state_changed = mark_home_cache_snapshot_promoted(
                        run_id,
                        &home_cache_snapshot,
                        home_cache_key.as_deref(),
                        Some(&reuse_key),
                        &profile_name,
                        &completed_at,
                        destroy_result.home_cache_promoted,
                    );
                    break 'finalization destroy_result.budget;
                }
                IdleParkFailureParts::RunningHandoff {
                    candidate,
                    reason,
                    error,
                    expected_capacity_rejection,
                } => {
                    telemetry.record_idle_publication(false, Some(reason));
                    warn!(
                        %run_id,
                        reason,
                        error,
                        expected_capacity_rejection,
                        "running handoff failed reuse preparation validation; destroying sandbox"
                    );
                    close_network_log_session(
                        run_id,
                        network_log_session.take(),
                        &network_log_drain,
                    )
                    .await;
                    let (payload, budget_lease) = candidate.into_active_destroy_parts();
                    let destroy_result = destroy_active_owned_idle_payload(
                        payload,
                        budget_lease,
                        reason,
                        destroy_bookkeeping,
                    )
                    .await;
                    return FinalizationReady::new(destroy_result.budget);
                }
            },
        };
        let (candidate, non_reusable) = park_outcome.into_parts();
        if cancel.is_hard_cancelled() {
            telemetry.record_outcome("runner_host_finalization_cancelled", "cancelled");
            telemetry.record_idle_publication(false, Some("cancelled"));
            let (payload, budget_lease) = candidate.into_active_destroy_parts();
            close_network_log_session(run_id, network_log_session.take(), &network_log_drain).await;
            info!(
                run_id = %run_id,
                reuse_key_fingerprint = %reuse_key_fingerprint,
                reuse_key_kind = reuse_kind,
                "job hard-cancelled while parking, destroying sandbox"
            );
            let destroy_result = destroy_active_owned_idle_payload(
                payload,
                budget_lease,
                "hard_cancellation",
                destroy_bookkeeping,
            )
            .await;
            reuse_state_changed |= mark_home_cache_snapshot_promoted(
                run_id,
                &home_cache_snapshot,
                home_cache_key.as_deref(),
                Some(&reuse_key),
                &profile_name,
                &completed_at,
                destroy_result.home_cache_promoted,
            );
            destroy_result.budget
        } else if let Some(non_reusable) = non_reusable {
            let reason = non_reusable.reason;
            let preparation_report = non_reusable.preparation_report;
            telemetry.record_idle_publication(false, Some("non_reusable"));
            close_network_log_session(run_id, network_log_session.take(), &network_log_drain).await;
            match &reason {
                sandbox::SandboxParkNonReusableReason::SevereMemoryRetention(diagnostics) => {
                    let guest = diagnostics.guest_memory_snapshot;
                    warn!(
                        run_id = %run_id,
                        sandbox_id = %sandbox_id,
                        runner_id = %runner_id,
                        runner_version = env!("CARGO_PKG_VERSION"),
                        profile_name = %profile_name,
                        reuse_key_fingerprint = %reuse_key_fingerprint,
                        reuse_key_kind = reuse_kind,
                        sandbox_reuse_result = reuse_result.as_wire(),
                        reuse_preparation_ready = true,
                        containment_ready = true,
                        reuse_preparation_removed_entries = preparation_report.removed_entries,
                        reuse_preparation_before_available_bytes =
                            preparation_report.before.available_bytes,
                        reuse_preparation_before_available_inodes =
                            preparation_report.before.available_inodes,
                        reuse_preparation_after_available_bytes =
                            preparation_report.after.available_bytes,
                        reuse_preparation_after_available_inodes =
                            preparation_report.after.available_inodes,
                        requested_target_mib = diagnostics.requested_target_mib,
                        first_observed_target_mib = diagnostics.first_observed_target_mib,
                        observed_target_mib = diagnostics.observed_target_mib,
                        target_observed = diagnostics.target_observed,
                        first_actual_mib = diagnostics.first_actual_mib,
                        previous_actual_mib = diagnostics.previous_actual_mib,
                        actual_mib = diagnostics.actual_mib,
                        max_actual_mib = diagnostics.max_actual_mib,
                        deficit_mib = diagnostics.deficit_mib,
                        actual_delta_mib = diagnostics.actual_delta_mib,
                        elapsed_ms = diagnostics.elapsed_ms,
                        sample_count = diagnostics.sample_count,
                        reported_free_memory_bytes = diagnostics.reported_free_memory_bytes,
                        reported_available_memory_bytes =
                            diagnostics.reported_available_memory_bytes,
                        reported_total_memory_bytes = diagnostics.reported_total_memory_bytes,
                        reported_swap_in_bytes = diagnostics.reported_swap_in_bytes,
                        reported_swap_out_bytes = diagnostics.reported_swap_out_bytes,
                        reported_major_faults = diagnostics.reported_major_faults,
                        reported_minor_faults = diagnostics.reported_minor_faults,
                        reported_disk_caches_bytes = diagnostics.reported_disk_caches_bytes,
                        progress_extension_blocker = diagnostics.progress_extension_blocker,
                        guest_memory_snapshot_attempted =
                            diagnostics.guest_memory_snapshot_attempted,
                        guest_memory_snapshot_available = guest.is_some(),
                        guest_mem_total_bytes = guest.map(|snapshot| snapshot.mem_total_bytes),
                        guest_mem_free_bytes = guest.map(|snapshot| snapshot.mem_free_bytes),
                        guest_mem_available_bytes =
                            guest.map(|snapshot| snapshot.mem_available_bytes),
                        guest_buffers_bytes = guest.map(|snapshot| snapshot.buffers_bytes),
                        guest_cached_bytes = guest.map(|snapshot| snapshot.cached_bytes),
                        guest_anon_pages_bytes = guest.map(|snapshot| snapshot.anon_pages_bytes),
                        guest_mapped_bytes = guest.map(|snapshot| snapshot.mapped_bytes),
                        guest_dirty_bytes = guest.map(|snapshot| snapshot.dirty_bytes),
                        guest_writeback_bytes = guest.map(|snapshot| snapshot.writeback_bytes),
                        guest_shmem_bytes = guest.map(|snapshot| snapshot.shmem_bytes),
                        guest_slab_bytes = guest.map(|snapshot| snapshot.slab_bytes),
                        guest_slab_reclaimable_bytes =
                            guest.map(|snapshot| snapshot.slab_reclaimable_bytes),
                        guest_slab_unreclaimable_bytes =
                            guest.map(|snapshot| snapshot.slab_unreclaimable_bytes),
                        guest_unevictable_bytes = guest.map(|snapshot| snapshot.unevictable_bytes),
                        guest_kernel_stack_bytes =
                            guest.map(|snapshot| snapshot.kernel_stack_bytes),
                        guest_page_tables_bytes = guest.map(|snapshot| snapshot.page_tables_bytes),
                        guest_swap_total_bytes = guest.map(|snapshot| snapshot.swap_total_bytes),
                        guest_swap_free_bytes = guest.map(|snapshot| snapshot.swap_free_bytes),
                        reason = reason.as_str(),
                        admission_action = "reject_and_destroy",
                        "sandbox parked with severe memory retention, destroying sandbox"
                    );
                }
            }
            let (payload, budget_lease) = candidate.into_active_destroy_parts();
            let destroy_result = destroy_active_owned_idle_payload(
                payload,
                budget_lease,
                reason.as_str(),
                destroy_bookkeeping,
            )
            .await;
            reuse_state_changed |= mark_home_cache_snapshot_promoted(
                run_id,
                &home_cache_snapshot,
                home_cache_key.as_deref(),
                Some(&reuse_key),
                &profile_name,
                &completed_at,
                destroy_result.home_cache_promoted,
            );
            destroy_result.budget
        } else {
            close_network_log_session(run_id, network_log_session.take(), &network_log_drain).await;
            let candidate = candidate.with_last_completed_at(completed_at.clone());
            let handoff_attempt = {
                let transfer_guard = cancel.transfer_guard().await;
                if cancel.is_hard_cancelled() {
                    drop(transfer_guard);
                    telemetry.record_outcome("runner_host_finalization_cancelled", "cancelled");
                    telemetry.record_handoff_failed("cancelled", "cancelled");
                    let (payload, budget_lease) = candidate.into_active_destroy_parts();
                    let destroy_result = destroy_active_owned_idle_payload(
                        payload,
                        budget_lease,
                        "hard_cancellation",
                        destroy_bookkeeping,
                    )
                    .await;
                    reuse_state_changed = mark_home_cache_snapshot_promoted(
                        run_id,
                        &home_cache_snapshot,
                        home_cache_key.as_deref(),
                        Some(&reuse_key),
                        &profile_name,
                        &completed_at,
                        destroy_result.home_cache_promoted,
                    );
                    break 'finalization destroy_result.budget;
                }
                match deliver_exact_handoff(&active_run_reuse, candidate, run_id) {
                    ExactHandoffAttempt::Delivered { handoff_point } => {
                        cleanup_state.mark_handoff_owned();
                        reuse_state_notify.notify_one();
                        #[cfg(any(test, feature = "test-support"))]
                        test_hooks.emit(FinalizationTestEvent::HandoffOwned { run_id });
                        drop(transfer_guard);
                        let handoff_path = match handoff_point {
                            Some(SandboxFinalExecParkHandoffPoint::BeforeBalloon) => {
                                "before_balloon"
                            }
                            Some(SandboxFinalExecParkHandoffPoint::DuringBalloonSettle) => {
                                "during_balloon"
                            }
                            Some(SandboxFinalExecParkHandoffPoint::DuringDeflation) => {
                                "during_deflation"
                            }
                            None => "after_full_park",
                        };
                        telemetry.record_handoff_delivered(handoff_path);
                        return FinalizationReady::new(BudgetOwnership::handoff_owned());
                    }
                    ExactHandoffAttempt::ContinueIdle(candidate) => {
                        drop(transfer_guard);
                        UndeliveredExactHandoff::ContinueIdle(candidate)
                    }
                    ExactHandoffAttempt::Destroy { candidate, error } => {
                        drop(transfer_guard);
                        UndeliveredExactHandoff::Destroy { candidate, error }
                    }
                }
            };
            let candidate = match handoff_attempt {
                UndeliveredExactHandoff::ContinueIdle(candidate) => candidate,
                UndeliveredExactHandoff::Destroy { candidate, error } => {
                    let handoff_outcome = if error == "receiver_unavailable" {
                        "receiver_closed_destroyed"
                    } else {
                        "request_unavailable_destroyed"
                    };
                    telemetry.record_handoff_failed(error, handoff_outcome);
                    warn!(
                        run_id = %run_id,
                        reuse_key_fingerprint = %reuse_key_fingerprint,
                        reuse_key_kind = reuse_kind,
                        handoff_error = error,
                        "exact handoff unavailable, destroying sandbox"
                    );
                    let (payload, budget_lease) = candidate.into_active_destroy_parts();
                    let destroy_result = destroy_active_owned_idle_payload(
                        payload,
                        budget_lease,
                        "exact_handoff_unavailable",
                        destroy_bookkeeping,
                    )
                    .await;
                    reuse_state_changed = mark_home_cache_snapshot_promoted(
                        run_id,
                        &home_cache_snapshot,
                        home_cache_key.as_deref(),
                        Some(&reuse_key),
                        &profile_name,
                        &completed_at,
                        destroy_result.home_cache_promoted,
                    );
                    break 'finalization destroy_result.budget;
                }
            };
            #[cfg(any(test, feature = "test-support"))]
            test_hooks.emit(FinalizationTestEvent::BeforeIdlePoolOwnershipTransfer { run_id });
            loop {
                let mut pool = idle_pool.lock().await;
                // Let hard cancellation win while finalization is still waiting
                // for the pool lock. Once the pool lock is held, only enter the
                // final transfer boundary if the per-run gate is immediately
                // available; otherwise release the pool lock before waiting.
                let Some(transfer_guard) = cancel.try_transfer_guard() else {
                    drop(pool);
                    let transfer_guard = cancel.transfer_guard().await;
                    if cancel.is_hard_cancelled() {
                        telemetry.record_outcome("runner_host_finalization_cancelled", "cancelled");
                        telemetry.record_idle_publication(false, Some("cancelled"));
                        info!(
                            run_id = %run_id,
                            reuse_key_fingerprint = %reuse_key_fingerprint,
                            reuse_key_kind = reuse_kind,
                            "job hard-cancelled before idle pool ownership transfer, destroying sandbox"
                        );
                        drop(transfer_guard);
                        let (payload, budget_lease) = candidate.into_active_destroy_parts();
                        let destroy_result = destroy_active_owned_idle_payload(
                            payload,
                            budget_lease,
                            "hard_cancellation",
                            destroy_bookkeeping,
                        )
                        .await;
                        reuse_state_changed = mark_home_cache_snapshot_promoted(
                            run_id,
                            &home_cache_snapshot,
                            home_cache_key.as_deref(),
                            Some(&reuse_key),
                            &profile_name,
                            &completed_at,
                            destroy_result.home_cache_promoted,
                        );
                        break 'finalization destroy_result.budget;
                    }
                    drop(transfer_guard);
                    continue;
                };
                if cancel.is_hard_cancelled() {
                    telemetry.record_outcome("runner_host_finalization_cancelled", "cancelled");
                    telemetry.record_idle_publication(false, Some("cancelled"));
                    info!(
                        run_id = %run_id,
                        reuse_key_fingerprint = %reuse_key_fingerprint,
                        reuse_key_kind = reuse_kind,
                        "job hard-cancelled before idle pool ownership transfer, destroying sandbox"
                    );
                    drop(transfer_guard);
                    drop(pool);
                    let (payload, budget_lease) = candidate.into_active_destroy_parts();
                    let destroy_result = destroy_active_owned_idle_payload(
                        payload,
                        budget_lease,
                        "hard_cancellation",
                        destroy_bookkeeping,
                    )
                    .await;
                    reuse_state_changed = mark_home_cache_snapshot_promoted(
                        run_id,
                        &home_cache_snapshot,
                        home_cache_key.as_deref(),
                        Some(&reuse_key),
                        &profile_name,
                        &completed_at,
                        destroy_result.home_cache_promoted,
                    );
                    break 'finalization destroy_result.budget;
                }
                let replacement_cleanup = match pool.park(candidate) {
                    ParkResult::Parked => {
                        info!(
                            run_id = %run_id,
                            reuse_key_fingerprint = %reuse_key_fingerprint,
                            reuse_key_kind = reuse_kind,
                            "sandbox parked for reuse"
                        );
                        #[cfg(any(test, feature = "test-support"))]
                        test_hooks.emit(FinalizationTestEvent::SandboxParkedForReuse {
                            run_id,
                            reuse_key: reuse_key.clone(),
                        });
                        None
                    }
                    ParkResult::Replaced(evicted) => {
                        // Adopt evicted ownership before status publication can await.
                        let destroy_task = idle_destroy_tracker.spawn_job(evicted, "park_replaced");
                        info!(
                            run_id = %run_id,
                            reuse_key_fingerprint = %reuse_key_fingerprint,
                            reuse_key_kind = reuse_kind,
                            "sandbox parked, evicting previous"
                        );
                        Some(destroy_task)
                    }
                    ParkResult::Rejected(rejected) => {
                        telemetry.record_idle_publication(false, Some("idle_pool_rejected"));
                        info!(
                            run_id = %run_id,
                            reuse_key_fingerprint = %reuse_key_fingerprint,
                            reuse_key_kind = reuse_kind,
                            "idle parking rejected, destroying sandbox"
                        );
                        drop(transfer_guard);
                        drop(pool);
                        // Pool unchanged: the parked candidate remains active-owned
                        // until destruction completes, without idle publication.
                        let (payload, lease) = rejected.into_active_destroy_parts();
                        let destroy_result = destroy_active_owned_idle_payload(
                            payload,
                            lease,
                            "park_rejected",
                            destroy_bookkeeping,
                        )
                        .await;
                        reuse_state_changed |= mark_home_cache_snapshot_promoted(
                            run_id,
                            &home_cache_snapshot,
                            home_cache_key.as_deref(),
                            Some(&reuse_key),
                            &profile_name,
                            &completed_at,
                            destroy_result.home_cache_promoted,
                        );
                        break destroy_result.budget;
                    }
                };
                cleanup_state.mark_idle_pool_owned();
                #[cfg(any(test, feature = "test-support"))]
                test_hooks.emit(FinalizationTestEvent::IdlePoolOwned { run_id });
                // Publish idle status before later settlement removes active visibility,
                // so doctor cannot briefly see the sandbox as neither active nor idle.
                let snapshot = pool.status_snapshot();
                drop(transfer_guard);
                drop(pool);
                if publishes_exact_sandbox {
                    active_run_reuse.publish_exact_sandbox();
                } else {
                    // The generic sandbox is pool-owned now. Wake successors
                    // before waiting for unrelated replaced-entry cleanup.
                    active_run_reuse.publish_no_exact_sandbox();
                }
                let ownership = OwnershipTransitions::new(status.as_ref());
                ownership
                    .publish_idle_status_after_pool_transfer(snapshot)
                    .await;
                reuse_state_changed = true;
                telemetry.record_idle_publication(true, None);
                reuse_state_notify.notify_one();
                if let Some(mut destroy_task) = replacement_cleanup
                    && let Err(error) = destroy_task.join().await
                {
                    warn!(%error, "replaced idle cleanup producer lost");
                }
                break BudgetOwnership::idle_owned();
            }
        }
    };

    mark_reuse_state_refresh(FinalizationReady::new(budget), reuse_state_changed)
}

#[derive(Clone, Copy)]
struct DestroyBookkeepingContext<'a> {
    cleanup_state: &'a RunCleanupState,
    idle_destroy_tracker: &'a IdleDestroyTracker,
    #[cfg(any(test, feature = "test-support"))]
    run_id: RunId,
    #[cfg(any(test, feature = "test-support"))]
    test_hooks: &'a FinalizationTestHooks,
}

struct ActiveOwnedIdleDestroyResult {
    budget: BudgetOwnership,
    home_cache_promoted: bool,
}

struct ActiveDestroyResult {
    outcome: DestroyOutcome,
    home_cache_promoted: bool,
}

fn record_destroy_result(outcome: DestroyOutcome, context: DestroyBookkeepingContext<'_>) {
    if outcome == DestroyOutcome::Completed {
        context.cleanup_state.mark_destroy_completed();
    }
    #[cfg(any(test, feature = "test-support"))]
    context
        .test_hooks
        .emit(FinalizationTestEvent::DestroyCompleted {
            run_id: context.run_id,
        });
}

async fn destroy_active_owned_idle_payload(
    payload: IdleDestroyPayload,
    budget_lease: BudgetLease,
    reason: &'static str,
    bookkeeping: DestroyBookkeepingContext<'_>,
) -> ActiveOwnedIdleDestroyResult {
    let destroy_result = match destroy_idle_payload_and_wait(
        bookkeeping.idle_destroy_tracker,
        payload,
        budget_lease,
        reason,
    )
    .await
    {
        Ok(result) => result,
        // Escalate lost ownership to the outer job's existing panic recovery;
        // normal status/lease settlement cannot claim this cleanup completed.
        Err(error) => std::panic::resume_unwind(Box::new(error)),
    };
    record_destroy_result(destroy_result.outcome, bookkeeping);
    ActiveOwnedIdleDestroyResult {
        budget: BudgetOwnership::active(ActiveBudgetLease::from_idle_park_lease(
            destroy_result.budget_lease,
        )),
        home_cache_promoted: destroy_result.home_cache_promoted,
    }
}

async fn close_network_log_session(
    run_id: RunId,
    session: Option<NetworkLogSession>,
    drain: &NetworkLogDrainCoordinator,
) {
    if let Some(session) = session {
        session.close_for_upload(run_id, drain).await;
    }
}

fn active_cleanup_reason(
    sandbox_reuse_disposition: SandboxReuseDisposition,
    hard_cancelled: bool,
    parking_open: bool,
) -> &'static str {
    if hard_cancelled {
        "hard_cancellation"
    } else if matches!(
        sandbox_reuse_disposition,
        SandboxReuseDisposition::Ineligible(_)
    ) {
        sandbox_reuse_disposition.as_str()
    } else if !parking_open {
        "parking_closed"
    } else {
        "no_reuse_key"
    }
}

fn home_terminal_status(exit_code: i32, cancelled: bool) -> HomeCacheTerminalStatus {
    if cancelled {
        HomeCacheTerminalStatus::Cancelled
    } else if exit_code == 0 {
        HomeCacheTerminalStatus::Success
    } else {
        HomeCacheTerminalStatus::NonzeroExit
    }
}

struct ActiveCleanupContext<'a> {
    run_id: RunId,
    sandbox_id: SandboxId,
    profile_name: &'a str,
    cli_agent_session_id: Option<&'a str>,
    reason: &'static str,
    network_log_session: Option<NetworkLogSession>,
    network_log_drain: NetworkLogDrainCoordinator,
}

/// Stop a sandbox and destroy it via its factory.
async fn stop_and_destroy_sandbox(
    mut sandbox: Box<dyn Sandbox>,
    factory: &dyn SandboxFactory,
    home_promotion: Option<HomeImagePromotionContext>,
    mut context: ActiveCleanupContext<'_>,
) -> ActiveDestroyResult {
    let prepared_promotion =
        prepare_home_image_from_active_sandbox(sandbox.as_ref(), home_promotion, context.reason)
            .await;
    let mut uncertain = false;
    let session_id = context.cli_agent_session_id;
    let stopped = match AssertUnwindSafe(sandbox.stop()).catch_unwind().await {
        Ok(Ok(())) => true,
        Ok(Err(e)) => {
            warn!(
                run_id = %context.run_id,
                sandbox_id = %context.sandbox_id,
                profile_name = context.profile_name,
                session_id = ?session_id,
                reason = context.reason,
                error = %e,
                "sandbox stop failed during active cleanup"
            );
            false
        }
        Err(_) => {
            warn!(
                run_id = %context.run_id,
                sandbox_id = %context.sandbox_id,
                profile_name = context.profile_name,
                session_id = ?session_id,
                reason = context.reason,
                "sandbox stop panicked during active cleanup"
            );
            uncertain = true;
            false
        }
    };
    let home_cache_promoted = match (prepared_promotion, stopped) {
        (Some(promotion), true) => promotion.publish().await,
        (Some(promotion), false) => {
            promotion.abandon("active_sandbox_stop_failed").await;
            false
        }
        (None, _) => false,
    };
    close_network_log_session(
        context.run_id,
        context.network_log_session.take(),
        &context.network_log_drain,
    )
    .await;
    if AssertUnwindSafe(factory.destroy(sandbox))
        .catch_unwind()
        .await
        .is_err()
    {
        warn!(
            run_id = %context.run_id,
            sandbox_id = %context.sandbox_id,
            profile_name = context.profile_name,
            session_id = ?session_id,
            reason = context.reason,
            "sandbox destroy panicked during active cleanup"
        );
        uncertain = true;
    }
    let outcome = if uncertain {
        DestroyOutcome::Uncertain
    } else {
        DestroyOutcome::Completed
    };
    ActiveDestroyResult {
        outcome,
        home_cache_promoted,
    }
}

#[cfg(test)]
mod tests;
