//! Sandbox finalization after executor completion.
//!
//! This module owns the post-executor decision to park or destroy a sandbox.
//! The job spawn module coordinates executor orchestration, provider completion,
//! deferred uploads, and panic boundaries.

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

use super::active_runs::{ActiveRunHandoffDeliveryResult, ActiveRunReusePublisher};
use super::heartbeat::WorkspaceCacheStateSnapshot;
use super::idle_lifecycle::{
    SharedIdlePool, destroy_idle_jobs_and_wait, destroy_idle_payload_and_wait,
};
use super::job_lifecycle::{
    ActiveBudgetLease, BudgetOwnership, FinalizationReady, RunCleanupState,
};
use super::ownership::OwnershipTransitions;
#[cfg(test)]
use super::{OuterJobPanicPoint, StartLoopTestObserver, maybe_panic_outer_job};
use crate::executor::{SandboxReuseDisposition, SandboxReuseTerminal};
use crate::guest_timezone::GuestTimezoneIntent;
use crate::idle_pool::{
    DestroyOutcome, IdleDestroyPayload, IdleParkActiveParts, IdleParkCandidate,
    IdleParkFailureParts, IdleParkRequest, IdleParkRequestParts, ParkResult, ParkedIdleCandidate,
    ParkingGate,
};
use crate::ids::RunId;
use crate::network_log_drain::NetworkLogDrainCoordinator;
use crate::network_log_manager::NetworkLogSession;
use crate::resource_budget::BudgetLease;
use crate::restored_session_identity::RestoredSessionIdentity;
use crate::run_cancellation::RunCancellationHandle;
use crate::status::StatusTracker;
use crate::storage_fingerprints::StorageFingerprints;
use crate::telemetry::JobTelemetry;
use crate::types::reuse_key_kind;
use crate::types::{
    HeldWorkspaceState, SandboxReuseResult, WORKSPACE_AFFINITY_VERSION, WorkspaceCacheCapability,
};
use crate::workspace_image_cache::{
    WorkspaceCacheTerminalStatus, WorkspaceImageLease, WorkspaceImagePromotionContext,
    WorkspaceImagePromotionRequest,
};
use crate::workspace_promotion::prepare_workspace_image_from_active_sandbox;

struct FinalizationTelemetry<'a> {
    telemetry: Option<&'a mut JobTelemetry>,
    physical_park_completed_at: Option<Instant>,
}

impl<'a> FinalizationTelemetry<'a> {
    fn new(telemetry: &'a mut JobTelemetry) -> Self {
        Self {
            telemetry: Some(telemetry),
            physical_park_completed_at: None,
        }
    }

    #[cfg(test)]
    fn disabled() -> Self {
        Self {
            telemetry: None,
            physical_park_completed_at: None,
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
        }
    }

    fn record_outcome(&mut self, action_type: &'static str, error: &'static str) {
        if let Some(telemetry) = self.telemetry.as_deref_mut() {
            telemetry.record(action_type, Duration::ZERO, false, Some(error));
        }
    }

    fn record_handoff(
        &mut self,
        success: bool,
        error: Option<&'static str>,
        outcome: &'static str,
    ) {
        if let Some(telemetry) = self.telemetry.as_deref_mut() {
            telemetry.record_with_outcome(
                "runner_host_exact_sandbox_handoff",
                Duration::ZERO,
                success,
                error,
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

fn mark_workspace_cache_snapshot_promoted(
    snapshot: &WorkspaceCacheStateSnapshot,
    reuse_key: Option<&str>,
    profile_name: &str,
    completed_at: &str,
    promoted: bool,
) -> bool {
    if promoted && let Some(reuse_key) = reuse_key {
        snapshot.upsert_workspace_cache_state(HeldWorkspaceState {
            reuse_key: reuse_key.to_owned(),
            last_completed_at: completed_at.to_owned(),
            workspace_caches: vec![WorkspaceCacheCapability {
                profile: profile_name.to_owned(),
                workspace_affinity_version: WORKSPACE_AFFINITY_VERSION,
            }],
        });
    }
    promoted
}

pub(super) struct FinalizeContext {
    pub(super) run_id: RunId,
    pub(super) sandbox_id: SandboxId,
    pub(super) runner_id: String,
    pub(super) reuse_result: SandboxReuseResult,
    pub(super) profile_name: String,
    pub(super) reuse_key: Option<String>,
    pub(super) cli_agent_session_id: Option<String>,
    pub(super) discovered_cli_agent_session_id: Option<String>,
    pub(super) restored_session_identity: Option<RestoredSessionIdentity>,
    pub(super) source_ip: String,
    pub(super) network_log_session: Option<NetworkLogSession>,
    pub(super) workspace_image: Option<WorkspaceImageLease>,
    pub(super) workspace_image_size_bytes: u64,
    pub(super) storage_fingerprints: StorageFingerprints,
    pub(super) device_rate_limits: Option<sandbox::DeviceRateLimits>,
    pub(super) guest_timezone_intent: GuestTimezoneIntent,
    pub(super) factory: Arc<Box<dyn SandboxFactory>>,
    pub(super) idle_pool: SharedIdlePool,
    pub(super) status: Arc<StatusTracker>,
    pub(super) reuse_state_notify: Arc<tokio::sync::Notify>,
    pub(super) active_run_reuse: ActiveRunReusePublisher,
    pub(super) workspace_cache_snapshot: WorkspaceCacheStateSnapshot,
    pub(super) parking_gate: ParkingGate,
    pub(super) network_log_drain: NetworkLogDrainCoordinator,
    pub(super) exit_code: i32,
    pub(super) sandbox_reuse_disposition: SandboxReuseDisposition,
    pub(super) cancel: RunCancellationHandle,
    pub(super) cleanup_state: RunCleanupState,
    #[cfg(test)]
    pub(super) outer_job_panic: Option<OuterJobPanicPoint>,
    #[cfg(test)]
    pub(super) test_observer: StartLoopTestObserver,
}

/// Finalizes ownership of a sandbox returned by the executor.
///
/// `None` requires no sandbox lifecycle action. For `Some`, idle parking is
/// considered only when execution supplied positive reuse evidence, hard
/// cancellation is not active, the parking gate is open, and a reuse key is
/// available. Otherwise, or if hard cancellation wins before ownership
/// transfer or parking cannot complete, the sandbox is stopped and destroyed.
pub(super) async fn finalize_sandbox_for_completion_with_telemetry(
    sandbox: Option<Box<dyn Sandbox>>,
    active_lease: ActiveBudgetLease,
    telemetry: &mut JobTelemetry,
    ctx: FinalizeContext,
) -> FinalizationReady {
    finalize_sandbox_for_completion_inner(
        sandbox,
        active_lease,
        FinalizationTelemetry::new(telemetry),
        ctx,
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
    )
    .await
}

async fn finalize_sandbox_for_completion_inner(
    sandbox: Option<Box<dyn Sandbox>>,
    active_lease: ActiveBudgetLease,
    mut telemetry: FinalizationTelemetry<'_>,
    ctx: FinalizeContext,
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
        reuse_key,
        cli_agent_session_id,
        discovered_cli_agent_session_id,
        restored_session_identity,
        source_ip,
        mut network_log_session,
        workspace_image,
        workspace_image_size_bytes,
        storage_fingerprints,
        device_rate_limits,
        guest_timezone_intent,
        factory,
        idle_pool,
        status,
        reuse_state_notify,
        active_run_reuse,
        workspace_cache_snapshot,
        parking_gate,
        network_log_drain,
        exit_code,
        sandbox_reuse_disposition,
        cancel,
        cleanup_state,
        #[cfg(test)]
        outer_job_panic,
        #[cfg(test)]
        test_observer,
    } = ctx;

    let destroy_bookkeeping = DestroyBookkeepingContext {
        cleanup_state: &cleanup_state,
        #[cfg(test)]
        run_id,
        #[cfg(test)]
        outer_job_panic,
    };
    let cancelled = cancel.is_cancelled();
    let hard_cancelled = cancel.is_hard_cancelled();
    if hard_cancelled {
        telemetry.record_outcome("runner_host_finalization_cancelled", "cancelled");
    }
    let terminal_status = workspace_terminal_status(exit_code, cancelled);
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
    let workspace_promotion = workspace_image.and_then(|workspace_image| {
        workspace_image.into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            restored_session_identity: restored_session_identity.as_ref(),
            terminal_status,
            completed_at: completed_at.clone(),
            storage_fingerprints: storage_fingerprints.clone(),
        })
    });
    let workspace_promotion_reuse_key = workspace_promotion
        .as_ref()
        .map(|promotion| promotion.reuse_key().to_owned());

    let mut reuse_state_changed = false;
    let budget = if let Some(reuse_key) = parkable_reuse_key {
        let reuse_key_fingerprint = crate::paths::short_digest(&reuse_key);
        let reuse_kind = reuse_key_kind(&reuse_key);
        // Inflate the guest balloon BEFORE acquiring the pool lock —
        // the HTTP call to Firecracker can take milliseconds, and we
        // must not block other take/park operations on it.
        let history_generation_run_id = match sandbox_reuse_disposition {
            SandboxReuseDisposition::Eligible(SandboxReuseTerminal::Success) => Some(run_id),
            SandboxReuseDisposition::Eligible(
                SandboxReuseTerminal::NonzeroExit
                | SandboxReuseTerminal::ExecutionTimeout
                | SandboxReuseTerminal::CooperativeCancellation,
            )
            | SandboxReuseDisposition::Ineligible(_) => None,
        };
        let publishes_exact_sandbox = history_generation_run_id == Some(run_id);
        let park_request = IdleParkRequest::new(IdleParkRequestParts {
            run_id,
            sandbox,
            factory: Arc::clone(&factory),
            reuse_key: reuse_key.clone(),
            sandbox_id,
            profile_name: profile_name.clone(),
            device_rate_limits: device_rate_limits.clone(),
            budget_lease: active_lease.into_idle_park_lease(),
            source_ip,
            storage_fingerprints,
            restored_session_identity,
            history_generation_run_id,
            guest_timezone_intent,
            workspace_image_size_bytes,
            workspace_promotion,
            handoff: publishes_exact_sandbox.then(|| active_run_reuse.handoff_signal()),
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
                        workspace_promotion,
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
                        workspace_promotion,
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
                    let workspace_cache_promoted = mark_workspace_cache_snapshot_promoted(
                        &workspace_cache_snapshot,
                        Some(&reuse_key),
                        &profile_name,
                        &completed_at,
                        destroy_result.workspace_cache_promoted,
                    );
                    record_destroy_result(destroy_result.outcome, destroy_bookkeeping);
                    return mark_reuse_state_refresh(
                        FinalizationReady::new(BudgetOwnership::active(
                            ActiveBudgetLease::from_idle_park_lease(budget_lease),
                        )),
                        workspace_cache_promoted,
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
                    let workspace_cache_promoted = mark_workspace_cache_snapshot_promoted(
                        &workspace_cache_snapshot,
                        Some(&reuse_key),
                        &profile_name,
                        &completed_at,
                        destroy_result.workspace_cache_promoted,
                    );
                    return mark_reuse_state_refresh(
                        FinalizationReady::new(destroy_result.budget),
                        workspace_cache_promoted,
                    );
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
            reuse_state_changed |= mark_workspace_cache_snapshot_promoted(
                &workspace_cache_snapshot,
                Some(&reuse_key),
                &profile_name,
                &completed_at,
                destroy_result.workspace_cache_promoted,
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
            reuse_state_changed |= mark_workspace_cache_snapshot_promoted(
                &workspace_cache_snapshot,
                Some(&reuse_key),
                &profile_name,
                &completed_at,
                destroy_result.workspace_cache_promoted,
            );
            destroy_result.budget
        } else {
            close_network_log_session(run_id, network_log_session.take(), &network_log_drain).await;
            let candidate = candidate.with_last_completed_at(completed_at.clone());
            let handoff_attempt = if publishes_exact_sandbox {
                let transfer_guard = cancel.transfer_guard().await;
                if cancel.is_hard_cancelled() {
                    drop(transfer_guard);
                    telemetry.record_outcome("runner_host_finalization_cancelled", "cancelled");
                    telemetry.record_handoff(false, Some("cancelled"), "cancelled");
                    let (payload, budget_lease) = candidate.into_active_destroy_parts();
                    let destroy_result = destroy_active_owned_idle_payload(
                        payload,
                        budget_lease,
                        "hard_cancellation",
                        destroy_bookkeeping,
                    )
                    .await;
                    let workspace_cache_promoted = mark_workspace_cache_snapshot_promoted(
                        &workspace_cache_snapshot,
                        Some(&reuse_key),
                        &profile_name,
                        &completed_at,
                        destroy_result.workspace_cache_promoted,
                    );
                    return mark_reuse_state_refresh(
                        FinalizationReady::new(destroy_result.budget),
                        workspace_cache_promoted,
                    );
                }
                match deliver_exact_handoff(&active_run_reuse, candidate, run_id) {
                    ExactHandoffAttempt::Delivered { handoff_point } => {
                        cleanup_state.mark_handoff_owned();
                        #[cfg(test)]
                        maybe_panic_outer_job(
                            outer_job_panic,
                            OuterJobPanicPoint::HandoffOwned,
                            run_id,
                        );
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
                        telemetry.record_handoff(true, None, handoff_path);
                        info!(
                            run_id = %run_id,
                            reuse_key_fingerprint = %reuse_key_fingerprint,
                            reuse_key_kind = reuse_kind,
                            handoff_path,
                            "sandbox delivered directly to claimed exact successor"
                        );
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
            } else {
                match candidate {
                    IdleParkCandidate::Ordinary(candidate) => {
                        UndeliveredExactHandoff::ContinueIdle(candidate)
                    }
                    IdleParkCandidate::Immediate(candidate) => UndeliveredExactHandoff::Destroy {
                        candidate: IdleParkCandidate::Immediate(candidate),
                        error: "request_unavailable",
                    },
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
                    telemetry.record_handoff(false, Some(error), handoff_outcome);
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
                    let workspace_cache_promoted = mark_workspace_cache_snapshot_promoted(
                        &workspace_cache_snapshot,
                        Some(&reuse_key),
                        &profile_name,
                        &completed_at,
                        destroy_result.workspace_cache_promoted,
                    );
                    return mark_reuse_state_refresh(
                        FinalizationReady::new(destroy_result.budget),
                        workspace_cache_promoted,
                    );
                }
            };
            #[cfg(test)]
            test_observer.notify_before_idle_pool_ownership_transfer(run_id);
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
                        let workspace_cache_promoted = mark_workspace_cache_snapshot_promoted(
                            &workspace_cache_snapshot,
                            Some(&reuse_key),
                            &profile_name,
                            &completed_at,
                            destroy_result.workspace_cache_promoted,
                        );
                        return mark_reuse_state_refresh(
                            FinalizationReady::new(destroy_result.budget),
                            workspace_cache_promoted,
                        );
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
                    let workspace_cache_promoted = mark_workspace_cache_snapshot_promoted(
                        &workspace_cache_snapshot,
                        Some(&reuse_key),
                        &profile_name,
                        &completed_at,
                        destroy_result.workspace_cache_promoted,
                    );
                    return mark_reuse_state_refresh(
                        FinalizationReady::new(destroy_result.budget),
                        workspace_cache_promoted,
                    );
                }
                break match pool.park(candidate) {
                    ParkResult::Parked => {
                        info!(
                            run_id = %run_id,
                            reuse_key_fingerprint = %reuse_key_fingerprint,
                            reuse_key_kind = reuse_kind,
                            "sandbox parked for reuse"
                        );
                        #[cfg(test)]
                        test_observer.notify_sandbox_parked_for_reuse(run_id, reuse_key.clone());
                        cleanup_state.mark_idle_pool_owned();
                        #[cfg(test)]
                        maybe_panic_outer_job(
                            outer_job_panic,
                            OuterJobPanicPoint::IdlePoolOwned,
                            run_id,
                        );
                        // Push fresh idle state to status.json BEFORE
                        // conditional active-run removal (below) clears the run_id
                        // from active_runs. Without this, doctor would
                        // briefly see the FC as unknown (neither active
                        // nor idle), producing transient false-positive
                        // FirecrackerNotInStatus warnings.
                        let snapshot = pool.status_snapshot();
                        drop(transfer_guard);
                        drop(pool);
                        if publishes_exact_sandbox {
                            active_run_reuse.publish_exact_sandbox();
                        }
                        let ownership = OwnershipTransitions::new(status.as_ref());
                        ownership
                            .publish_idle_status_after_pool_transfer(snapshot)
                            .await;
                        reuse_state_changed = true;
                        telemetry.record_idle_publication(true, None);
                        reuse_state_notify.notify_one();
                        BudgetOwnership::idle_owned()
                    }
                    ParkResult::Replaced(evicted) => {
                        info!(
                            run_id = %run_id,
                            reuse_key_fingerprint = %reuse_key_fingerprint,
                            reuse_key_kind = reuse_kind,
                            "sandbox parked, evicting previous"
                        );
                        cleanup_state.mark_idle_pool_owned();
                        #[cfg(test)]
                        maybe_panic_outer_job(
                            outer_job_panic,
                            OuterJobPanicPoint::IdlePoolOwned,
                            run_id,
                        );
                        let snapshot = pool.status_snapshot();
                        drop(transfer_guard);
                        drop(pool);
                        if publishes_exact_sandbox {
                            active_run_reuse.publish_exact_sandbox();
                        }
                        let ownership = OwnershipTransitions::new(status.as_ref());
                        ownership
                            .publish_idle_status_after_pool_transfer(snapshot)
                            .await;
                        reuse_state_changed = true;
                        telemetry.record_idle_publication(true, None);
                        reuse_state_notify.notify_one();
                        // The replaced sandbox was park()ed when it entered the
                        // pool; destroying a parked sandbox is safe — Drop
                        // aborts any leftover handles and the FC process is
                        // killed regardless of balloon state.
                        if destroy_idle_jobs_and_wait(vec![evicted], "park_replaced").await {
                            reuse_state_notify.notify_one();
                        }
                        BudgetOwnership::idle_owned()
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
                        // Pool unchanged (park rejected) — no status
                        // update needed. The rejected sandbox was just
                        // park()ed above; destroying a parked sandbox is
                        // safe — see Replaced arm for rationale.
                        let (payload, lease) = rejected.into_active_destroy_parts();
                        let destroy_result = destroy_active_owned_idle_payload(
                            payload,
                            lease,
                            "park_rejected",
                            destroy_bookkeeping,
                        )
                        .await;
                        reuse_state_changed |= mark_workspace_cache_snapshot_promoted(
                            &workspace_cache_snapshot,
                            Some(&reuse_key),
                            &profile_name,
                            &completed_at,
                            destroy_result.workspace_cache_promoted,
                        );
                        destroy_result.budget
                    }
                };
            }
        }
    } else {
        // No parkable reuse key — stop + destroy.
        let cleanup_reason = active_cleanup_reason(
            sandbox_reuse_disposition,
            hard_cancelled,
            parking_gate.is_open(),
        );
        let destroy_result = stop_and_destroy_sandbox(
            sandbox,
            &**factory,
            workspace_promotion,
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
        reuse_state_changed |= mark_workspace_cache_snapshot_promoted(
            &workspace_cache_snapshot,
            workspace_promotion_reuse_key.as_deref(),
            &profile_name,
            &completed_at,
            destroy_result.workspace_cache_promoted,
        );
        record_destroy_result(destroy_result.outcome, destroy_bookkeeping);
        BudgetOwnership::active(active_lease)
    };

    mark_reuse_state_refresh(FinalizationReady::new(budget), reuse_state_changed)
}

#[derive(Clone, Copy)]
struct DestroyBookkeepingContext<'a> {
    cleanup_state: &'a RunCleanupState,
    #[cfg(test)]
    run_id: RunId,
    #[cfg(test)]
    outer_job_panic: Option<OuterJobPanicPoint>,
}

struct ActiveOwnedIdleDestroyResult {
    budget: BudgetOwnership,
    workspace_cache_promoted: bool,
}

struct ActiveDestroyResult {
    outcome: DestroyOutcome,
    workspace_cache_promoted: bool,
}

fn record_destroy_result(outcome: DestroyOutcome, context: DestroyBookkeepingContext<'_>) {
    if outcome == DestroyOutcome::Completed {
        context.cleanup_state.mark_destroy_completed();
    }
    #[cfg(test)]
    maybe_panic_outer_job(
        context.outer_job_panic,
        OuterJobPanicPoint::DestroyCompleted,
        context.run_id,
    );
}

async fn destroy_active_owned_idle_payload(
    payload: IdleDestroyPayload,
    budget_lease: BudgetLease,
    reason: &'static str,
    bookkeeping: DestroyBookkeepingContext<'_>,
) -> ActiveOwnedIdleDestroyResult {
    let destroy_result = destroy_idle_payload_and_wait(payload, reason).await;
    record_destroy_result(destroy_result.outcome, bookkeeping);
    ActiveOwnedIdleDestroyResult {
        budget: BudgetOwnership::active(ActiveBudgetLease::from_idle_park_lease(budget_lease)),
        workspace_cache_promoted: destroy_result.workspace_cache_promoted,
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

fn workspace_terminal_status(exit_code: i32, cancelled: bool) -> WorkspaceCacheTerminalStatus {
    if cancelled {
        WorkspaceCacheTerminalStatus::Cancelled
    } else if exit_code == 0 {
        WorkspaceCacheTerminalStatus::Success
    } else {
        WorkspaceCacheTerminalStatus::NonzeroExit
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
    workspace_promotion: Option<WorkspaceImagePromotionContext>,
    mut context: ActiveCleanupContext<'_>,
) -> ActiveDestroyResult {
    let prepared_promotion = prepare_workspace_image_from_active_sandbox(
        sandbox.as_ref(),
        workspace_promotion,
        context.reason,
    )
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
    let workspace_cache_promoted = match (prepared_promotion, stopped) {
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
        workspace_cache_promoted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::future::Future;
    use std::sync::Arc;
    use std::time::Duration;

    use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
    use guest_contracts::reuse_preparation::{ReusePreparationReport, RootFilesystemCapacity};
    use guest_contracts::session_history_identity::{
        SessionHistoryFramework, SessionHistoryIdentity, SessionHistoryRefKind,
        SessionHistorySidecarExportMetadata, SessionHistorySourceRef,
    };
    use sandbox::{ExecResult, SandboxFactory, SandboxId};
    use sandbox_mock::{MockLifecycleGate, MockSandbox, MockSandboxFactory, MockSandboxOverrides};
    use sha2::{Digest, Sha256};
    use tracing::Level;
    use tracing_subscriber::prelude::*;
    use tracing_test_support::{CapturedEvent, CapturedEvents};

    use super::super::active_runs::ActiveRuns;
    use super::super::idle_lifecycle::SharedIdlePool;
    use super::super::job_lifecycle::{ActiveBudgetLease, RunCleanupDisposition, RunCleanupState};
    use crate::idle_pool::{
        IdleParkRequest, IdleParkRequestParts, IdlePool, IdlePoolConfig, ParkResult, ParkingGate,
        RestoreReservedIdleResult, test_support::ParkedIdleCandidateBuilder,
    };
    use crate::idle_reuse_preparation::{
        add_healthy_reuse_preparation_matcher, mock_sandbox_ready_for_idle_reuse,
    };
    use crate::ids::RunId;
    use crate::network_log_drain::NetworkLogDrainCoordinator;
    use crate::network_log_manager::NetworkLogManager;
    use crate::paths::RunnerPaths;
    use crate::resource_budget::{BudgetLease, ResourceBudget};
    use crate::restored_session_identity::RestoredSessionIdentity;
    use crate::status::StatusTracker;
    use crate::storage_fingerprints::StorageFingerprint;
    use crate::storage_manifest::{ArtifactEntry, StorageEntry, StorageManifest};
    use crate::storage_plan::build_storage_plan;
    use crate::types::SandboxReuseResult;
    use crate::workspace_image_cache::{
        WorkspaceImageCache, WorkspaceImageLeaseIdentity, WorkspaceImagePrepareRequest,
        WorkspaceImagePromotionContext, WorkspaceImagePromotionIdentityRequest,
        WorkspaceImagePromotionOutcome, WorkspaceImagePromotionRequest,
        WorkspaceSessionHistorySidecarRepresentation,
    };

    fn test_active_runs() -> ActiveRuns {
        ActiveRuns::new(Arc::new(tokio::sync::Notify::new()))
    }

    async fn prepare_and_publish_workspace_image(
        sandbox: &dyn Sandbox,
        promotion: WorkspaceImagePromotionContext,
    ) -> bool {
        prepare_workspace_image_from_active_sandbox(sandbox, Some(promotion), "test")
            .await
            .expect("workspace promotion should prepare")
            .publish()
            .await
    }

    fn test_budget_lease() -> (Arc<ResourceBudget>, BudgetLease) {
        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        (budget, lease)
    }

    async fn capture_async_log_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
    where
        F: Future,
    {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let guard = tracing::subscriber::set_default(subscriber);
        tracing::callsite::rebuild_interest_cache();
        let output = future.await;
        drop(guard);
        (output, captured.entries())
    }

    fn captured_event<'a>(events: &'a [CapturedEvent], message: &str) -> &'a CapturedEvent {
        events
            .iter()
            .find(|event| {
                event
                    .fields
                    .get("message")
                    .is_some_and(|actual| actual == message)
            })
            .unwrap_or_else(|| panic!("missing event {message:?}; captured={events:#?}"))
    }

    fn assert_event_field(event: &CapturedEvent, field: &str, expected: &str) {
        assert_eq!(
            event.fields.get(field).map(String::as_str),
            Some(expected),
            "unexpected {field}; event={event:#?}"
        );
    }

    fn severe_memory_retention_diagnostics() -> sandbox::SevereMemoryRetentionDiagnostics {
        sandbox::SevereMemoryRetentionDiagnostics {
            requested_target_mib: 3584,
            first_observed_target_mib: Some(3584),
            observed_target_mib: Some(3584),
            target_observed: true,
            first_actual_mib: Some(2074),
            previous_actual_mib: Some(2300),
            actual_mib: Some(2448),
            max_actual_mib: Some(2448),
            deficit_mib: Some(1136),
            actual_delta_mib: Some(374),
            elapsed_ms: 5001,
            sample_count: 9,
            reported_free_memory_bytes: Some(8 * 1024 * 1024),
            reported_available_memory_bytes: Some(9 * 1024 * 1024),
            reported_total_memory_bytes: Some(4_i64 * 1024 * 1024 * 1024),
            reported_swap_in_bytes: Some(11),
            reported_swap_out_bytes: Some(12),
            reported_major_faults: Some(13),
            reported_minor_faults: Some(14),
            reported_disk_caches_bytes: Some(15),
            progress_extension_blocker: Some("fresh_guest_available_reserve_insufficient"),
            guest_memory_snapshot_attempted: true,
            guest_memory_snapshot: Some(sandbox::GuestMemorySnapshot {
                mem_total_bytes: 101,
                mem_free_bytes: 102,
                mem_available_bytes: 103,
                buffers_bytes: 104,
                cached_bytes: 105,
                anon_pages_bytes: 106,
                mapped_bytes: 107,
                dirty_bytes: 108,
                writeback_bytes: 109,
                shmem_bytes: 110,
                slab_bytes: 111,
                slab_reclaimable_bytes: 112,
                slab_unreclaimable_bytes: 113,
                unevictable_bytes: 114,
                kernel_stack_bytes: 115,
                page_tables_bytes: 116,
                swap_total_bytes: 117,
                swap_free_bytes: 118,
            }),
        }
    }

    struct FinalizeTestFixture {
        dir: tempfile::TempDir,
        status: Arc<StatusTracker>,
        parking_gate: ParkingGate,
        idle_pool: SharedIdlePool,
        network_log_manager: NetworkLogManager,
    }

    impl FinalizeTestFixture {
        async fn new() -> Self {
            Self::new_with_max_idle(10).await
        }

        async fn new_with_max_idle(max_idle: usize) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let status = Arc::new(StatusTracker::new(
                dir.path().join("status.json"),
                4,
                None,
                None,
            ));
            status.write_initial().await.unwrap();
            let parking_gate = ParkingGate::new_open();
            let idle_pool: SharedIdlePool = Arc::new(tokio::sync::Mutex::new(
                IdlePool::new_with_parking_gate(IdlePoolConfig { max_idle }, parking_gate.clone()),
            ));
            let network_log_manager = NetworkLogManager::new();

            Self {
                dir,
                status,
                parking_gate,
                idle_pool,
                network_log_manager,
            }
        }

        async fn network_log_session(&self) -> NetworkLogSession {
            self.network_log_manager
                .register_source_ip("10.0.0.1", self.dir.path().join("network.jsonl"))
                .await
        }

        fn finalize_context(
            &self,
            run_id: RunId,
            sandbox_id: SandboxId,
            session_id: &str,
            network_log_session: NetworkLogSession,
            cancel: RunCancellationHandle,
        ) -> FinalizeContext {
            FinalizeContext {
                run_id,
                sandbox_id,
                runner_id: "runner-test".into(),
                reuse_result: SandboxReuseResult::PoolMiss,
                profile_name: "vm0/default".into(),
                reuse_key: Some(session_id.into()),
                cli_agent_session_id: Some(session_id.into()),
                discovered_cli_agent_session_id: None,
                restored_session_identity: None,
                source_ip: "10.0.0.1".into(),
                network_log_session: Some(network_log_session),
                workspace_image: None,
                workspace_image_size_bytes: 0,
                storage_fingerprints: crate::storage_fingerprints::StorageFingerprints::default(),
                device_rate_limits: None,
                guest_timezone_intent: GuestTimezoneIntent::Unknown,
                factory: Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
                idle_pool: Arc::clone(&self.idle_pool),
                status: Arc::clone(&self.status),
                reuse_state_notify: Arc::new(tokio::sync::Notify::new()),
                active_run_reuse: ActiveRunReusePublisher::detached(),
                workspace_cache_snapshot: WorkspaceCacheStateSnapshot::new(),
                parking_gate: self.parking_gate.clone(),
                network_log_drain: NetworkLogDrainCoordinator::noop(),
                exit_code: 0,
                sandbox_reuse_disposition: SandboxReuseDisposition::Eligible(
                    SandboxReuseTerminal::Success,
                ),
                cancel,
                cleanup_state: RunCleanupState::new(),
                outer_job_panic: None,
                test_observer: StartLoopTestObserver::default(),
            }
        }
    }

    async fn prepare_test_workspace_image_lease(
        paths: &RunnerPaths,
        cache: &WorkspaceImageCache,
        run_id: RunId,
        sandbox_id: SandboxId,
        reuse_key: &str,
    ) -> WorkspaceImageLease {
        let lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                identity: WorkspaceImageLeaseIdentity {
                    run_id,
                    sandbox_id,
                    profile_name: "vm0/default",
                    reuse_key: Some(reuse_key),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: b"image".len() as u64,
                },
                workspace_drive_required: true,
            })
            .await;
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
            .await
            .unwrap();
        lease
    }

    fn test_restored_session_identity(
        framework: SessionHistoryFramework,
        session_id: &str,
        history: &[u8],
    ) -> RestoredSessionIdentity {
        RestoredSessionIdentity::new(
            framework,
            session_id,
            SessionHistoryRefKind::Blob,
            hex::encode(Sha256::digest(history)),
            Some(history.len() as u64),
        )
    }

    fn test_verified_restored_session_identity(
        framework: SessionHistoryFramework,
        session_id: &str,
        history: &[u8],
    ) -> RestoredSessionIdentity {
        let history_source = match framework {
            SessionHistoryFramework::ClaudeCode => SessionHistorySourceRef::ClaudeCode {
                config_dir: "/home/user/.claude".to_string(),
                working_dir: CANONICAL_WORKING_DIR.to_string(),
                session_id: session_id.to_string(),
            },
            SessionHistoryFramework::Codex => SessionHistorySourceRef::Codex {
                sessions_dir: "/home/user/.codex/sessions".to_string(),
                thread_id: session_id.to_string(),
            },
            SessionHistoryFramework::Pi => SessionHistorySourceRef::Pi {
                session_path: format!(
                    "{}/restored-{session_id}.jsonl",
                    api_contracts::generated::constants::runners::paths::CANONICAL_PI_SESSION_DIR,
                ),
                session_id: session_id.to_string(),
            },
        };
        let metadata = SessionHistoryIdentity::new(
            framework,
            hex::encode(Sha256::digest(session_id.as_bytes())),
            SessionHistoryRefKind::Blob,
            hex::encode(Sha256::digest(history)),
            history.len() as u64,
            history_source,
        )
        .unwrap();
        RestoredSessionIdentity::from_final_metadata(
            metadata,
            "/home/user/.vm0/guest-agent/runs/run-b/final-session-history-identity.json",
            "/home/user/.vm0/guest-agent/runs/run-b",
        )
        .unwrap()
    }

    async fn seed_workspace_cache_with_sidecar(
        paths: &RunnerPaths,
        cache: &WorkspaceImageCache,
        reuse_key: &str,
        session_id: &str,
        history: &[u8],
    ) -> RestoredSessionIdentity {
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let restored_session_identity = test_restored_session_identity(
            SessionHistoryFramework::ClaudeCode,
            session_id,
            history,
        );
        let lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                identity: WorkspaceImageLeaseIdentity {
                    run_id,
                    sandbox_id,
                    profile_name: "vm0/default",
                    reuse_key: Some(reuse_key),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: b"image".len() as u64,
                },
                workspace_drive_required: true,
            })
            .await;
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
            .await
            .unwrap();
        let promotion = lease
            .into_promotion_context(WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                restored_session_identity: Some(&restored_session_identity),
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: "2026-07-31T00:00:00.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
            })
            .unwrap();
        let guard = promotion
            .try_acquire_session_history_sidecar_entry_guard()
            .await
            .unwrap();
        let tmp_path = guard.session_history_sidecar_tmp_path();
        tokio::fs::create_dir_all(tmp_path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&tmp_path, history).await.unwrap();
        let source = guard.session_history_sidecar_source(
            tmp_path,
            WorkspaceSessionHistorySidecarRepresentation::Raw,
            history.len() as u64,
        );
        assert_eq!(
            guard
                .promote_with_session_history_sidecar(&promotion, &source)
                .await
                .unwrap(),
            WorkspaceImagePromotionOutcome::Promoted
        );
        restored_session_identity
    }

    fn test_promotion_context(
        lease: WorkspaceImageLease,
        run_id: RunId,
        sandbox_id: SandboxId,
        terminal_status: WorkspaceCacheTerminalStatus,
        storage_fingerprints: crate::storage_fingerprints::StorageFingerprints,
    ) -> WorkspaceImagePromotionContext {
        lease
            .into_promotion_context(WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                restored_session_identity: None,
                terminal_status,
                completed_at: local_completed_at(),
                storage_fingerprints,
            })
            .expect("test workspace image should be promotable")
    }

    async fn sandbox_with_overrides(
        sandbox_id: SandboxId,
        overrides: Arc<sandbox_mock::MockSandboxOverrides>,
    ) -> (Arc<Box<dyn SandboxFactory>>, Box<dyn Sandbox>) {
        let factory: Arc<Box<dyn SandboxFactory>> =
            Arc::new(Box::new(MockSandboxFactory::with_overrides(overrides)));
        let sandbox = factory
            .create(sandbox::SandboxConfig {
                id: sandbox_id,
                resources: sandbox::ResourceLimits {
                    cpu_count: 2,
                    memory_mb: 4096,
                },
                device_rate_limits: None,
                workspace_drive: None,
            })
            .await
            .expect("create sandbox with overrides");
        (factory, sandbox)
    }

    #[tokio::test]
    async fn finalizer_closes_network_log_session_before_parking() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let mut context = fixture.finalize_context(
            run_id,
            sandbox_id,
            "sess-network-log-park",
            network_log_session,
            RunCancellationHandle::new(),
        );
        context.guest_timezone_intent = GuestTimezoneIntent::Configured("Asia/Shanghai".into());

        let _finalization_ready = finalize_sandbox_for_completion(
            Some(Box::new(mock_sandbox_ready_for_idle_reuse(
                "network-log-park",
            ))),
            ActiveBudgetLease::new(lease),
            context,
        )
        .await;

        {
            let mut idle_pool = fixture.idle_pool.lock().await;
            let reservation = idle_pool
                .reserve_reusable_generation("sess-network-log-park", "vm0/default", &None, run_id)
                .expect("finalized sandbox should be reusable for its generation");
            assert_eq!(
                reservation.guest_timezone_intent(),
                &GuestTimezoneIntent::Configured("Asia/Shanghai".into())
            );
            assert!(matches!(
                idle_pool.restore_reserved(reservation),
                RestoreReservedIdleResult::Restored
            ));
        }
        assert!(
            !fixture
                .network_log_manager
                .append_for_ip(
                    "10.0.0.1",
                    serde_json::json!({"type":"dns","host":"after-park.test"})
                )
                .await,
            "parked sandbox must not retain the previous run's network-log attribution",
        );
    }

    #[tokio::test]
    async fn finalizer_emits_joined_severe_memory_retention_warning() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let report = ReusePreparationReport {
            before: RootFilesystemCapacity {
                available_bytes: 256 * 1024 * 1024,
                available_inodes: 2048,
            },
            after: RootFilesystemCapacity {
                available_bytes: 384 * 1024 * 1024,
                available_inodes: 4096,
            },
            removed_entries: 7,
        };
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
            pattern: "prepare-for-reuse".into(),
            exit_code: 0,
            stdout: serde_json::to_vec(&report).unwrap(),
            stderr: Vec::new(),
        });
        overrides.push_park_result(Ok(sandbox::SandboxParkOutcome::NonReusable(
            sandbox::SandboxParkNonReusableReason::SevereMemoryRetention(Box::new(
                severe_memory_retention_diagnostics(),
            )),
        )));
        let (factory, sandbox) = sandbox_with_overrides(sandbox_id, Arc::clone(&overrides)).await;
        let mut context = fixture.finalize_context(
            run_id,
            sandbox_id,
            "thread:severe-memory-warning",
            network_log_session,
            RunCancellationHandle::new(),
        );
        context.factory = factory;
        context.runner_id = "runner-attribution-test".into();
        context.reuse_result = SandboxReuseResult::Reused;

        let (_finalization_ready, events) = capture_async_log_events(
            finalize_sandbox_for_completion(Some(sandbox), ActiveBudgetLease::new(lease), context),
        )
        .await;

        assert_eq!(overrides.destroy_call_count(), 1);
        assert_eq!(fixture.idle_pool.lock().await.len(), 0);
        let matching_events: Vec<_> = events
            .iter()
            .filter(|event| {
                event.fields.get("message").is_some_and(|message| {
                    message == "sandbox parked with severe memory retention, destroying sandbox"
                })
            })
            .collect();
        assert_eq!(matching_events.len(), 1, "captured={events:#?}");
        let event = captured_event(
            &events,
            "sandbox parked with severe memory retention, destroying sandbox",
        );
        assert_eq!(event.level, Level::WARN);
        assert_event_field(event, "run_id", &run_id.to_string());
        assert_event_field(event, "sandbox_id", &sandbox_id.to_string());
        assert_event_field(event, "runner_id", "runner-attribution-test");
        assert_event_field(event, "runner_version", env!("CARGO_PKG_VERSION"));
        assert_event_field(event, "profile_name", "vm0/default");
        assert_event_field(event, "reuse_key_kind", "thread");
        assert_event_field(event, "sandbox_reuse_result", "reused");
        assert_event_field(event, "reuse_preparation_ready", "true");
        assert_event_field(event, "containment_ready", "true");
        assert_event_field(event, "reuse_preparation_removed_entries", "7");
        assert_event_field(
            event,
            "reuse_preparation_before_available_bytes",
            "268435456",
        );
        assert_event_field(
            event,
            "reuse_preparation_after_available_bytes",
            "402653184",
        );
        assert_event_field(event, "requested_target_mib", "3584");
        assert_event_field(event, "first_actual_mib", "2074");
        assert_event_field(event, "previous_actual_mib", "2300");
        assert_event_field(event, "actual_mib", "2448");
        assert_event_field(event, "deficit_mib", "1136");
        assert_event_field(
            event,
            "progress_extension_blocker",
            "fresh_guest_available_reserve_insufficient",
        );
        assert_event_field(event, "guest_memory_snapshot_attempted", "true");
        assert_event_field(event, "reported_swap_in_bytes", "11");
        assert_event_field(event, "reported_disk_caches_bytes", "15");
        assert_event_field(event, "guest_memory_snapshot_available", "true");
        for (field, value) in [
            ("guest_mem_total_bytes", 101),
            ("guest_mem_free_bytes", 102),
            ("guest_mem_available_bytes", 103),
            ("guest_buffers_bytes", 104),
            ("guest_cached_bytes", 105),
            ("guest_anon_pages_bytes", 106),
            ("guest_mapped_bytes", 107),
            ("guest_dirty_bytes", 108),
            ("guest_writeback_bytes", 109),
            ("guest_shmem_bytes", 110),
            ("guest_slab_bytes", 111),
            ("guest_slab_reclaimable_bytes", 112),
            ("guest_slab_unreclaimable_bytes", 113),
            ("guest_unevictable_bytes", 114),
            ("guest_kernel_stack_bytes", 115),
            ("guest_page_tables_bytes", 116),
            ("guest_swap_total_bytes", 117),
            ("guest_swap_free_bytes", 118),
        ] {
            assert_event_field(event, field, &value.to_string());
        }
        assert_eq!(event.field_kinds.get("first_actual_mib"), Some(&"u64"));
        assert_eq!(
            event.field_kinds.get("reported_swap_in_bytes"),
            Some(&"i64")
        );
        assert_eq!(event.field_kinds.get("guest_mem_total_bytes"), Some(&"u64"));
        assert_event_field(event, "reason", "severe_memory_retention");
        assert_event_field(event, "admission_action", "reject_and_destroy");
    }

    #[tokio::test]
    async fn finalizer_preserves_success_when_reuse_preparation_rejects_guest() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let cleanup_state = RunCleanupState::new();
        let workspace_dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(workspace_dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = WorkspaceImageCache::new(paths.clone());
        let workspace_image = prepare_test_workspace_image_lease(
            &paths,
            &cache,
            run_id,
            sandbox_id,
            "thread:reuse-rejected",
        )
        .await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
            pattern: "prepare-for-reuse".into(),
            exit_code: 0,
            stdout: serde_json::to_vec(&ReusePreparationReport {
                before: RootFilesystemCapacity {
                    available_bytes: 64 * 1024 * 1024,
                    available_inodes: 4096,
                },
                after: RootFilesystemCapacity {
                    available_bytes: 64 * 1024 * 1024,
                    available_inodes: 4096,
                },
                removed_entries: 0,
            })
            .unwrap(),
            stderr: Vec::new(),
        });
        let (factory, sandbox) = sandbox_with_overrides(sandbox_id, Arc::clone(&overrides)).await;
        let mut context = fixture.finalize_context(
            run_id,
            sandbox_id,
            "thread:reuse-rejected",
            network_log_session,
            RunCancellationHandle::new(),
        );
        context.factory = factory;
        context.cleanup_state = cleanup_state.clone();
        context.workspace_image = Some(workspace_image);
        context.workspace_image_size_bytes = b"image".len() as u64;

        let (_finalization_ready, events) = capture_async_log_events(
            finalize_sandbox_for_completion(Some(sandbox), ActiveBudgetLease::new(lease), context),
        )
        .await;

        assert_eq!(overrides.park_call_count(), 1);
        assert_eq!(overrides.unpark_call_count(), 1);
        assert_eq!(overrides.destroy_call_count(), 1);
        assert_eq!(fixture.idle_pool.lock().await.len(), 0);
        let cache_states = cache.held_workspace_states().await;
        assert_eq!(cache_states.len(), 1);
        assert_eq!(cache_states[0].reuse_key, "thread:reuse-rejected");
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::DestroyCompleted
        );
        let capacity_event = captured_event(&events, "sandbox rejected from idle reuse");
        assert_eq!(capacity_event.level, Level::INFO);
        assert_event_field(capacity_event, "reason", "low_bytes");
        let lifecycle_event = captured_event(
            &events,
            "parked sandbox rejected by idle capacity admission, destroying instead of reusing",
        );
        assert_eq!(lifecycle_event.level, Level::INFO);
    }

    #[tokio::test]
    async fn finalizer_parking_observer_uses_reuse_key() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let reuse_key = "thread:finalizer-17975";
        let observer = StartLoopTestObserver::default();
        let mut context = fixture.finalize_context(
            run_id,
            sandbox_id,
            reuse_key,
            network_log_session,
            RunCancellationHandle::new(),
        );
        context.test_observer = observer.clone();

        let _finalization_ready = finalize_sandbox_for_completion(
            Some(Box::new(mock_sandbox_ready_for_idle_reuse(
                "finalizer-redaction",
            ))),
            ActiveBudgetLease::new(lease),
            context,
        )
        .await;
        let observed_reuse_key = observer
            .wait_sandbox_parked_for_reuse(run_id, Duration::from_secs(1))
            .await;

        assert_eq!(observed_reuse_key, reuse_key);
    }

    #[tokio::test]
    async fn finalizer_keeps_idle_pool_ownership_when_cancelled_after_transfer() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let cancel = RunCancellationHandle::new();
        let cleanup_state = RunCleanupState::new();
        let mut context = fixture.finalize_context(
            run_id,
            sandbox_id,
            "sess-cancel-after-transfer",
            network_log_session,
            cancel.clone(),
        );
        context.cleanup_state = cleanup_state.clone();

        let _finalization_ready = finalize_sandbox_for_completion(
            Some(Box::new(mock_sandbox_ready_for_idle_reuse(
                "cancel-after-transfer",
            ))),
            ActiveBudgetLease::new(lease),
            context,
        )
        .await;

        assert_eq!(fixture.idle_pool.lock().await.len(), 1);
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::IdlePoolOwned,
        );

        assert!(cancel.request_hard_cancellation().await);

        assert_eq!(
            fixture.idle_pool.lock().await.len(),
            1,
            "late cancellation must not undo idle-pool ownership",
        );
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::IdlePoolOwned,
        );
    }

    #[tokio::test]
    async fn workspace_promotion_freezes_and_promotes_cache_entry() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = WorkspaceImageCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let lease =
            prepare_test_workspace_image_lease(&paths, &cache, run_id, sandbox_id, "sess-promote")
                .await;
        let sandbox = MockSandbox::new("workspace-promotion");
        let promotion = test_promotion_context(
            lease,
            run_id,
            sandbox_id,
            WorkspaceCacheTerminalStatus::Success,
            crate::storage_fingerprints::StorageFingerprints::default(),
        );

        let promoted = prepare_and_publish_workspace_image(&sandbox, promotion).await;

        assert!(promoted);
        let states = cache.held_workspace_states().await;
        assert_eq!(states.len(), 1);
        assert_eq!(states[0].reuse_key, "sess-promote");
        let exec_calls = sandbox.exec_calls();
        assert_eq!(exec_calls.len(), 1);
        assert!(exec_calls[0].sudo);
        assert!(
            exec_calls[0]
                .cmd
                .contains("\"$workspace_fsfreeze_path\" --freeze")
        );
    }

    #[tokio::test]
    async fn non_success_workspace_promotion_preserves_affected_paths_across_cache_sources() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = WorkspaceImageCache::new(paths.clone());

        for (terminal_name, terminal_status) in [
            ("nonzero", WorkspaceCacheTerminalStatus::NonzeroExit),
            ("cancelled", WorkspaceCacheTerminalStatus::Cancelled),
        ] {
            for (source_name, publish_seed) in [("cache-hit", true), ("idle-reuse", false)] {
                let session_id = format!("sess-{terminal_name}-{source_name}");
                let removed_storage_path = format!("{CANONICAL_WORKING_DIR}/removed-storage");
                let removed_artifact_path = format!("{CANONICAL_WORKING_DIR}/removed-artifact");
                let current_storage_path = format!("{CANONICAL_WORKING_DIR}/current-storage");
                let current_artifact_path = format!("{CANONICAL_WORKING_DIR}/current-artifact");
                let previous_storage = StorageFingerprints {
                    storages: HashMap::from([(
                        removed_storage_path.clone(),
                        StorageFingerprint::new("removed-storage", "v1"),
                    )]),
                    artifacts: HashMap::from([(
                        removed_artifact_path.clone(),
                        StorageFingerprint::new("removed-artifact", "v1"),
                    )]),
                };

                let seed_run_id = RunId::new_v4();
                let seed_sandbox_id = SandboxId::new_v4();
                let seed_lease = prepare_test_workspace_image_lease(
                    &paths,
                    &cache,
                    seed_run_id,
                    seed_sandbox_id,
                    &session_id,
                )
                .await;
                let seed_promotion = test_promotion_context(
                    seed_lease,
                    seed_run_id,
                    seed_sandbox_id,
                    WorkspaceCacheTerminalStatus::Success,
                    previous_storage.clone(),
                );

                let run_id = RunId::new_v4();
                let (sandbox_id, lease) = if publish_seed {
                    assert!(
                        prepare_and_publish_workspace_image(
                            &MockSandbox::new(format!("workspace-seed-{session_id}")),
                            seed_promotion,
                        )
                        .await
                    );
                    let sandbox_id = SandboxId::new_v4();
                    let lease = prepare_test_workspace_image_lease(
                        &paths,
                        &cache,
                        run_id,
                        sandbox_id,
                        &session_id,
                    )
                    .await;
                    assert!(lease.is_cache_hit());
                    (sandbox_id, lease)
                } else {
                    let expected = cache
                        .expected_promotion_identity(WorkspaceImagePromotionIdentityRequest {
                            sandbox_id: seed_sandbox_id,
                            profile_name: "vm0/default",
                            reuse_key: &session_id,
                            working_dir: CANONICAL_WORKING_DIR,
                            image_size_bytes: b"image".len() as u64,
                        })
                        .expect("idle reuse promotion identity should be valid");
                    let lease = seed_promotion
                        .try_into_active_lease(&expected, true)
                        .expect("parked promotion should become an active lease");
                    (seed_sandbox_id, lease)
                };
                assert_eq!(lease.previous_storage(), Some(&previous_storage));

                let sandbox = MockSandbox::new(format!("workspace-promotion-{session_id}"));
                let current_manifest = StorageManifest {
                    storages: vec![StorageEntry {
                        name: "current-storage".into(),
                        mount_path: current_storage_path.clone(),
                        vas_storage_name: "current-storage".into(),
                        vas_version_id: "v1".into(),
                        baseline_candidate: false,
                        instructions_target_filename: None,
                        archive_url: "https://example.com/current-storage.tar.gz".into(),
                        archive_size: None,
                    }],
                    artifacts: vec![ArtifactEntry {
                        mount_path: current_artifact_path.clone(),
                        vas_storage_name: "current-artifact".into(),
                        vas_storage_id: "current-artifact-id".into(),
                        vas_version_id: "v1".into(),
                        archive_url: Some("https://example.com/current-artifact.tar.gz".into()),
                        empty: None,
                        missing_root_policy: None,
                        archive_size: None,
                    }],
                };
                let promotion = test_promotion_context(
                    lease,
                    run_id,
                    sandbox_id,
                    terminal_status,
                    StorageFingerprints::from_manifest(&current_manifest),
                );

                let promoted = prepare_and_publish_workspace_image(&sandbox, promotion).await;

                assert!(promoted);
                let exec_calls = sandbox.exec_calls();
                assert_eq!(exec_calls.len(), 1);
                assert!(
                    exec_calls[0]
                        .cmd
                        .contains("\"$workspace_fsfreeze_path\" --freeze")
                );
                assert!(!exec_calls[0].cmd.contains("export-session-history-sidecar"));
                let checkout = cache
                    .prepare(WorkspaceImagePrepareRequest {
                        identity: WorkspaceImageLeaseIdentity {
                            run_id: RunId::new_v4(),
                            sandbox_id: SandboxId::new_v4(),
                            profile_name: "vm0/default",
                            reuse_key: Some(&session_id),
                            working_dir: CANONICAL_WORKING_DIR,
                            image_size_bytes: b"image".len() as u64,
                        },
                        workspace_drive_required: true,
                    })
                    .await;

                assert!(checkout.is_cache_hit());
                let previous_storage = checkout
                    .previous_storage()
                    .expect("cache hit should expose previous storage fingerprints");
                for path in [&removed_storage_path, &current_storage_path] {
                    assert!(
                        previous_storage
                            .storages
                            .get(path)
                            .is_some_and(StorageFingerprint::is_tainted),
                        "storage path should be retained as tainted: {path}",
                    );
                }
                for path in [&removed_artifact_path, &current_artifact_path] {
                    assert!(
                        previous_storage
                            .artifacts
                            .get(path)
                            .is_some_and(StorageFingerprint::is_tainted),
                        "artifact path should be retained as tainted: {path}",
                    );
                }

                let plan = build_storage_plan(&current_manifest, "/run", Some(previous_storage))
                    .expect("next storage plan should build from promoted fingerprints");
                assert_eq!(plan.reused_entries(), 0);
                let guest_manifest = plan.into_guest_manifest();
                assert!(!guest_manifest.storages[0].cached);
                assert!(!guest_manifest.artifacts[0].cached);
                assert_eq!(
                    guest_manifest
                        .cleanup_paths
                        .into_iter()
                        .collect::<HashSet<_>>(),
                    HashSet::from([
                        removed_storage_path,
                        removed_artifact_path,
                        current_storage_path,
                        current_artifact_path,
                    ])
                );
            }
        }
    }

    #[tokio::test]
    async fn workspace_promotion_skips_cache_when_guest_freeze_fails() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = WorkspaceImageCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let lease =
            prepare_test_workspace_image_lease(&paths, &cache, run_id, sandbox_id, "sess-failed")
                .await;
        let sandbox = MockSandbox::new("workspace-promotion-fail");
        sandbox.push_exec_result(Ok(ExecResult::new(64, Vec::new(), b"not mounted".to_vec())));
        let promotion = test_promotion_context(
            lease,
            run_id,
            sandbox_id,
            WorkspaceCacheTerminalStatus::Success,
            crate::storage_fingerprints::StorageFingerprints::default(),
        );

        let prepared =
            prepare_workspace_image_from_active_sandbox(&sandbox, Some(promotion), "test").await;

        assert!(prepared.is_none());
        assert!(
            cache.held_workspace_states().await.is_empty(),
            "freeze failure must not advertise an inconsistent workspace image"
        );
        assert_eq!(sandbox.exec_calls().len(), 1);
    }

    #[tokio::test]
    async fn finalizer_parks_workspace_cache_promotion_without_publishing_cache() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = WorkspaceImageCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let workspace_image = cache
            .prepare(WorkspaceImagePrepareRequest {
                identity: WorkspaceImageLeaseIdentity {
                    run_id,
                    sandbox_id,
                    profile_name: "vm0/default",
                    reuse_key: Some("unused-context-session"),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: b"image".len() as u64,
                },
                workspace_drive_required: true,
            })
            .await;
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
            .await
            .unwrap();
        let mut context = fixture.finalize_context(
            run_id,
            sandbox_id,
            "unused-context-session",
            network_log_session,
            RunCancellationHandle::new(),
        );
        context.cli_agent_session_id = None;
        context.discovered_cli_agent_session_id = Some("sess-guest".into());
        context.workspace_image = Some(workspace_image);
        context.workspace_image_size_bytes = b"image".len() as u64;

        let _finalization_ready = finalize_sandbox_for_completion(
            Some(Box::new(mock_sandbox_ready_for_idle_reuse(
                "guest-session-promotion",
            ))),
            ActiveBudgetLease::new(lease),
            context,
        )
        .await;

        let idle_states = fixture.idle_pool.lock().await.held_sandbox_states();
        assert_eq!(idle_states.len(), 1);
        assert_eq!(idle_states[0].reuse_key, "unused-context-session");
        let cache_states = cache.held_workspace_states().await;
        assert!(
            cache_states.is_empty(),
            "parked sandboxes keep the live workspace mounted and must not publish a separate cache image"
        );
    }

    #[tokio::test]
    async fn finalizer_rejects_mismatched_workspace_promotion_before_parking() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = WorkspaceImageCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let workspace_image = cache
            .prepare(WorkspaceImagePrepareRequest {
                identity: WorkspaceImageLeaseIdentity {
                    run_id,
                    sandbox_id,
                    profile_name: "vm0/default",
                    reuse_key: Some("sess-mismatch"),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: b"image".len() as u64,
                },
                workspace_drive_required: true,
            })
            .await;
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
            .await
            .unwrap();
        let overrides = Arc::new(MockSandboxOverrides::new());
        let (factory, sandbox) = sandbox_with_overrides(sandbox_id, Arc::clone(&overrides)).await;
        let mut context = fixture.finalize_context(
            run_id,
            sandbox_id,
            "sess-mismatch",
            network_log_session,
            RunCancellationHandle::new(),
        );
        context.factory = factory;
        context.workspace_image = Some(workspace_image);
        context.workspace_image_size_bytes = b"image".len() as u64 + 1;

        let _finalization_ready =
            finalize_sandbox_for_completion(Some(sandbox), ActiveBudgetLease::new(lease), context)
                .await;

        assert_eq!(
            overrides.park_call_count(),
            0,
            "mismatched promotion should be rejected before sandbox park"
        );
        assert_eq!(overrides.destroy_call_count(), 1);
        assert_eq!(fixture.idle_pool.lock().await.len(), 0);
        assert!(
            cache.held_workspace_states().await.is_empty(),
            "mismatched park-time promotion must not publish workspace cache"
        );
    }

    #[tokio::test]
    async fn finalizer_republishes_failed_sessionless_cache_hit_and_preserves_sidecar() {
        assert_finalizer_republishes_sessionless_cache_hit_and_preserves_sidecar(false).await;
    }

    #[tokio::test]
    async fn finalizer_republishes_cancelled_sessionless_cache_hit_and_preserves_sidecar() {
        assert_finalizer_republishes_sessionless_cache_hit_and_preserves_sidecar(true).await;
    }

    async fn assert_finalizer_republishes_sessionless_cache_hit_and_preserves_sidecar(
        cancelled: bool,
    ) {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = WorkspaceImageCache::new(paths.clone());
        let reuse_key = "thread:rotating-provider";
        let previous_session_id = "claude-session-a";
        let previous_history = br#"{"type":"message","content":"claude-a"}"#;
        let previous_identity = seed_workspace_cache_with_sidecar(
            &paths,
            &cache,
            reuse_key,
            previous_session_id,
            previous_history,
        )
        .await;
        let seeded_entry = cache.inspect().await.unwrap().entries.remove(0);
        let sidecar_metadata_path = cache
            .entry_paths(&seeded_entry.cache_key)
            .session_history_sidecar_metadata()
            .to_path_buf();

        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let workspace_image = cache
            .prepare(WorkspaceImagePrepareRequest {
                identity: WorkspaceImageLeaseIdentity {
                    run_id,
                    sandbox_id,
                    profile_name: "vm0/default",
                    reuse_key: Some(reuse_key),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: b"image".len() as u64,
                },
                workspace_drive_required: true,
            })
            .await;
        assert_eq!(
            workspace_image.result(),
            crate::workspace_image_cache::WorkspaceCacheCheckoutResult::Hit
        );
        let sidecar_body_path = workspace_image
            .probe_session_history_sidecar(&previous_identity)
            .await
            .unwrap()
            .path;
        let previous_sidecar_body = tokio::fs::read(&sidecar_body_path).await.unwrap();
        let previous_sidecar_metadata = tokio::fs::read(&sidecar_metadata_path).await.unwrap();
        let codex_identity = test_restored_session_identity(
            SessionHistoryFramework::Codex,
            "codex-session-b",
            previous_history,
        );
        assert!(
            workspace_image
                .probe_session_history_sidecar(&codex_identity)
                .await
                .is_err(),
            "a Codex rotation must not consume the Claude sidecar"
        );
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::rename(
            cache
                .entry_paths(&seeded_entry.cache_key)
                .current_image()
                .to_path_buf(),
            paths.active_workspace_image(&sandbox_id),
        )
        .await
        .unwrap();
        let overrides = Arc::new(MockSandboxOverrides::new());
        let (factory, sandbox) = sandbox_with_overrides(sandbox_id, Arc::clone(&overrides)).await;
        let cancel = RunCancellationHandle::new();
        if cancelled {
            assert!(cancel.request_hard_cancellation().await);
        }
        let mut context = fixture.finalize_context(
            run_id,
            sandbox_id,
            "unused-context-session",
            network_log_session,
            cancel,
        );
        context.factory = factory;
        context.reuse_key = Some(reuse_key.into());
        context.cli_agent_session_id = None;
        context.discovered_cli_agent_session_id = None;
        context.restored_session_identity = None;
        context.exit_code = 1;
        context.sandbox_reuse_disposition = if cancelled {
            SandboxReuseDisposition::Eligible(SandboxReuseTerminal::CooperativeCancellation)
        } else {
            SandboxReuseDisposition::Eligible(SandboxReuseTerminal::NonzeroExit)
        };
        if !cancelled {
            assert!(context.parking_gate.soft_drain());
        }
        context.workspace_image = Some(workspace_image);
        context.workspace_image_size_bytes = b"image".len() as u64;

        let _finalization_ready =
            finalize_sandbox_for_completion(Some(sandbox), ActiveBudgetLease::new(lease), context)
                .await;

        assert_eq!(overrides.park_call_count(), 0);
        assert_eq!(overrides.destroy_call_count(), 1);
        let states = cache.held_workspace_states().await;
        assert_eq!(states.len(), 1);
        assert_eq!(states[0].reuse_key, reuse_key);
        let workspace_metadata: serde_json::Value = serde_json::from_slice(
            &tokio::fs::read(
                cache
                    .entry_paths(&seeded_entry.cache_key)
                    .metadata()
                    .to_path_buf(),
            )
            .await
            .unwrap(),
        )
        .unwrap();
        assert!(workspace_metadata.get("cliAgentSessionId").is_none());
        assert_eq!(
            tokio::fs::read(&sidecar_body_path).await.unwrap(),
            previous_sidecar_body
        );
        assert_eq!(
            tokio::fs::read(&sidecar_metadata_path).await.unwrap(),
            previous_sidecar_metadata
        );

        let exact_checkout = cache
            .prepare(WorkspaceImagePrepareRequest {
                identity: WorkspaceImageLeaseIdentity {
                    run_id: RunId::new_v4(),
                    sandbox_id: SandboxId::new_v4(),
                    profile_name: "vm0/default",
                    reuse_key: Some(reuse_key),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: b"image".len() as u64,
                },
                workspace_drive_required: true,
            })
            .await;
        let sidecar = exact_checkout
            .probe_session_history_sidecar(&previous_identity)
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read(sidecar.path).await.unwrap(),
            previous_history
        );
    }

    #[tokio::test]
    async fn finalizer_replaces_previous_sidecar_after_verified_session_rotation() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = WorkspaceImageCache::new(paths.clone());
        let reuse_key = "thread:verified-provider-rotation";
        let previous_history = br#"{"type":"message","content":"claude-a"}"#;
        let previous_identity = seed_workspace_cache_with_sidecar(
            &paths,
            &cache,
            reuse_key,
            "claude-session-a",
            previous_history,
        )
        .await;
        let seeded_entry = cache.inspect().await.unwrap().entries.remove(0);
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let workspace_image = cache
            .prepare(WorkspaceImagePrepareRequest {
                identity: WorkspaceImageLeaseIdentity {
                    run_id,
                    sandbox_id,
                    profile_name: "vm0/default",
                    reuse_key: Some(reuse_key),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: b"image".len() as u64,
                },
                workspace_drive_required: true,
            })
            .await;
        assert_eq!(
            workspace_image.result(),
            crate::workspace_image_cache::WorkspaceCacheCheckoutResult::Hit
        );
        let previous_body_path = workspace_image
            .probe_session_history_sidecar(&previous_identity)
            .await
            .unwrap()
            .path;
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::rename(
            cache
                .entry_paths(&seeded_entry.cache_key)
                .current_image()
                .to_path_buf(),
            paths.active_workspace_image(&sandbox_id),
        )
        .await
        .unwrap();

        let next_session_id = "019e9154-c304-70f0-adde-36efb1be1701";
        let next_history = br#"{"type":"message","content":"codex-b"}"#;
        let next_identity = test_verified_restored_session_identity(
            SessionHistoryFramework::Codex,
            next_session_id,
            next_history,
        );
        let sandbox = MockSandbox::new(sandbox_id.to_string());
        sandbox.push_exec_result(Ok(ExecResult::new(
            0,
            serde_json::to_vec(&SessionHistorySidecarExportMetadata {
                timings: Default::default(),
                representation: WorkspaceSessionHistorySidecarRepresentation::Raw,
                encoded_size: next_history.len() as u64,
            })
            .unwrap(),
            Vec::new(),
        )));
        sandbox.push_copy_file_result(Ok(next_history.to_vec()));
        let mut context = fixture.finalize_context(
            run_id,
            sandbox_id,
            "unused-context-session",
            network_log_session,
            RunCancellationHandle::new(),
        );
        context.reuse_key = Some(reuse_key.into());
        context.cli_agent_session_id = None;
        context.discovered_cli_agent_session_id = Some(next_session_id.into());
        context.restored_session_identity = Some(next_identity.clone());
        context.exit_code = 0;
        context.workspace_image = Some(workspace_image);
        context.workspace_image_size_bytes = b"image".len() as u64;
        context.parking_gate.close();

        let _finalization_ready = finalize_sandbox_for_completion(
            Some(Box::new(sandbox)),
            ActiveBudgetLease::new(lease),
            context,
        )
        .await;

        let checkout = cache
            .prepare(WorkspaceImagePrepareRequest {
                identity: WorkspaceImageLeaseIdentity {
                    run_id: RunId::new_v4(),
                    sandbox_id: SandboxId::new_v4(),
                    profile_name: "vm0/default",
                    reuse_key: Some(reuse_key),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: b"image".len() as u64,
                },
                workspace_drive_required: true,
            })
            .await;
        assert!(
            checkout
                .probe_session_history_sidecar(&previous_identity)
                .await
                .is_err(),
            "the verified replacement must not retain the previous identity"
        );
        let next_sidecar = checkout
            .probe_session_history_sidecar(&next_identity)
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read(next_sidecar.path).await.unwrap(),
            next_history
        );
        assert!(!previous_body_path.exists());
    }

    #[tokio::test]
    async fn finalizer_promotes_workspace_cache_from_reuse_key_without_resolved_session() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = WorkspaceImageCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let reuse_key = "thread:lease-only";
        let workspace_image = cache
            .prepare(WorkspaceImagePrepareRequest {
                identity: WorkspaceImageLeaseIdentity {
                    run_id,
                    sandbox_id,
                    profile_name: "vm0/default",
                    reuse_key: Some(reuse_key),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: b"image".len() as u64,
                },
                workspace_drive_required: true,
            })
            .await;
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
            .await
            .unwrap();
        let mut context = fixture.finalize_context(
            run_id,
            sandbox_id,
            "unused-context-session",
            network_log_session,
            RunCancellationHandle::new(),
        );
        context.cli_agent_session_id = None;
        context.discovered_cli_agent_session_id = None;
        context.exit_code = 1;
        context.sandbox_reuse_disposition =
            SandboxReuseDisposition::Eligible(SandboxReuseTerminal::NonzeroExit);
        assert!(context.parking_gate.soft_drain());
        context.workspace_image = Some(workspace_image);
        context.workspace_image_size_bytes = b"image".len() as u64;
        let workspace_cache_snapshot = context.workspace_cache_snapshot.clone();

        let _finalization_ready = finalize_sandbox_for_completion(
            Some(Box::new(MockSandbox::new("reuse-key-promotion"))),
            ActiveBudgetLease::new(lease),
            context,
        )
        .await;

        assert_eq!(fixture.idle_pool.lock().await.len(), 0);
        let cache_states = cache.held_workspace_states().await;
        assert_eq!(cache_states.len(), 1);
        assert_eq!(cache_states[0].reuse_key, reuse_key);
        let active_runs = test_active_runs();
        let snapshot_states =
            workspace_cache_snapshot.current_held_workspace_states(&active_runs, None);
        assert_eq!(snapshot_states.len(), 1);
        assert_eq!(snapshot_states[0].reuse_key, reuse_key);
        assert_eq!(snapshot_states[0].workspace_caches.len(), 1);
        assert_eq!(
            snapshot_states[0].workspace_caches[0].profile,
            "vm0/default"
        );
    }

    #[tokio::test]
    async fn finalizer_promotes_failed_first_run_workspace_without_session() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = WorkspaceImageCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let reuse_key = "thread:first-run-failure";
        let workspace_image = cache
            .prepare(WorkspaceImagePrepareRequest {
                identity: WorkspaceImageLeaseIdentity {
                    run_id,
                    sandbox_id,
                    profile_name: "vm0/default",
                    reuse_key: Some(reuse_key),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: b"image".len() as u64,
                },
                workspace_drive_required: true,
            })
            .await;
        assert_eq!(
            workspace_image.result(),
            crate::workspace_image_cache::WorkspaceCacheCheckoutResult::Miss
        );
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
            .await
            .unwrap();
        let overrides = Arc::new(MockSandboxOverrides::new());
        let (factory, sandbox) = sandbox_with_overrides(sandbox_id, Arc::clone(&overrides)).await;
        let mut context = fixture.finalize_context(
            run_id,
            sandbox_id,
            "unused-context-session",
            network_log_session,
            RunCancellationHandle::new(),
        );
        context.factory = factory;
        context.reuse_key = Some(reuse_key.into());
        context.cli_agent_session_id = None;
        context.discovered_cli_agent_session_id = None;
        context.exit_code = 1;
        context.sandbox_reuse_disposition =
            SandboxReuseDisposition::Eligible(SandboxReuseTerminal::NonzeroExit);
        assert!(context.parking_gate.soft_drain());
        context.workspace_image = Some(workspace_image);
        context.workspace_image_size_bytes = b"image".len() as u64;
        let workspace_cache_snapshot = context.workspace_cache_snapshot.clone();

        let _finalization_ready =
            finalize_sandbox_for_completion(Some(sandbox), ActiveBudgetLease::new(lease), context)
                .await;

        assert_eq!(overrides.park_call_count(), 0);
        assert_eq!(overrides.destroy_call_count(), 1);
        assert_eq!(fixture.idle_pool.lock().await.len(), 0);
        let cache_states = cache.held_workspace_states().await;
        assert_eq!(cache_states.len(), 1);
        assert_eq!(cache_states[0].reuse_key, reuse_key);
        let inspection = cache.inspect().await.unwrap();
        assert_eq!(inspection.entries.len(), 1);
        assert_eq!(
            inspection.entries[0].last_terminal_status,
            Some(WorkspaceCacheTerminalStatus::NonzeroExit)
        );
        let metadata: serde_json::Value = serde_json::from_slice(
            &tokio::fs::read(
                cache
                    .entry_paths(&inspection.entries[0].cache_key)
                    .metadata()
                    .to_path_buf(),
            )
            .await
            .unwrap(),
        )
        .unwrap();
        assert!(metadata.get("cliAgentSessionId").is_none());
        let active_runs = test_active_runs();
        let snapshot_states =
            workspace_cache_snapshot.current_held_workspace_states(&active_runs, None);
        assert_eq!(snapshot_states.len(), 1);
        assert_eq!(snapshot_states[0].reuse_key, reuse_key);
        assert_eq!(snapshot_states[0].workspace_caches.len(), 1);
    }

    #[tokio::test]
    async fn finalizer_stop_error_abandons_frozen_workspace_cache_before_destroy() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = WorkspaceImageCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let session_id = "sess-active-stop-error";
        let workspace_image =
            prepare_test_workspace_image_lease(&paths, &cache, run_id, sandbox_id, session_id)
                .await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.push_stop_result(Err(sandbox::SandboxError::Start {
            message: "simulated active stop failure".into(),
        }));
        let (factory, sandbox) = sandbox_with_overrides(sandbox_id, Arc::clone(&overrides)).await;
        let mut context = fixture.finalize_context(
            run_id,
            sandbox_id,
            session_id,
            network_log_session,
            RunCancellationHandle::new(),
        );
        context.factory = factory;
        context.exit_code = 1;
        context.sandbox_reuse_disposition =
            SandboxReuseDisposition::Eligible(SandboxReuseTerminal::NonzeroExit);
        assert!(context.parking_gate.soft_drain());
        context.workspace_image = Some(workspace_image);
        context.workspace_image_size_bytes = b"image".len() as u64;
        let workspace_cache_snapshot = context.workspace_cache_snapshot.clone();

        let _finalization_ready =
            finalize_sandbox_for_completion(Some(sandbox), ActiveBudgetLease::new(lease), context)
                .await;

        let exec_calls = overrides.exec_calls();
        assert_eq!(exec_calls.len(), 1);
        assert!(
            exec_calls[0]
                .cmd
                .contains("\"$workspace_fsfreeze_path\" --freeze")
        );
        assert_eq!(overrides.destroy_call_count(), 1);
        assert!(cache.held_workspace_states().await.is_empty());
        assert_eq!(fixture.idle_pool.lock().await.len(), 0);
        let active_runs = test_active_runs();
        assert!(
            workspace_cache_snapshot
                .current_held_workspace_states(&active_runs, None)
                .is_empty(),
            "failed post-freeze stop must not advertise reusable state"
        );
    }

    #[tokio::test]
    async fn finalizer_promotes_workspace_cache_when_parked_candidate_is_rejected() {
        let fixture = FinalizeTestFixture::new_with_max_idle(1).await;
        let (_existing_budget, existing_lease) = test_budget_lease();
        let existing = ParkedIdleCandidateBuilder::new("sess-existing", existing_lease)
            .with_mock_sandbox_name("existing-idle")
            .with_last_completed_at(local_completed_at())
            .build();
        assert!(matches!(
            fixture.idle_pool.lock().await.park(existing),
            ParkResult::Parked
        ));

        let (_budget, lease) = test_budget_lease();
        let network_log_session = fixture.network_log_session().await;
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = WorkspaceImageCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let workspace_image = cache
            .prepare(WorkspaceImagePrepareRequest {
                identity: WorkspaceImageLeaseIdentity {
                    run_id,
                    sandbox_id,
                    profile_name: "vm0/default",
                    reuse_key: Some("sess-new"),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: b"image".len() as u64,
                },
                workspace_drive_required: true,
            })
            .await;
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
            .await
            .unwrap();
        let mut context = fixture.finalize_context(
            run_id,
            sandbox_id,
            "sess-new",
            network_log_session,
            RunCancellationHandle::new(),
        );
        context.workspace_image = Some(workspace_image);
        context.workspace_image_size_bytes = b"image".len() as u64;

        let _finalization_ready = finalize_sandbox_for_completion(
            Some(Box::new(mock_sandbox_ready_for_idle_reuse(
                "rejected-workspace-promotion",
            ))),
            ActiveBudgetLease::new(lease),
            context,
        )
        .await;

        let idle_states = fixture.idle_pool.lock().await.held_sandbox_states();
        assert_eq!(idle_states.len(), 1);
        assert_eq!(idle_states[0].reuse_key, "sess-existing");
        let cache_states = cache.held_workspace_states().await;
        assert_eq!(cache_states.len(), 1);
        assert_eq!(cache_states[0].reuse_key, "sess-new");
    }

    #[tokio::test]
    async fn finalizer_notifies_after_replaced_idle_promotion_despite_destroy_panic() {
        let fixture = FinalizeTestFixture::new().await;
        let session_id = "sess-replaced-cache";
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = WorkspaceImageCache::new(paths.clone());

        let old_run_id = RunId::new_v4();
        let old_sandbox_id = SandboxId::new_v4();
        let old_workspace_image = prepare_test_workspace_image_lease(
            &paths,
            &cache,
            old_run_id,
            old_sandbox_id,
            session_id,
        )
        .await;
        let old_promotion = test_promotion_context(
            old_workspace_image,
            old_run_id,
            old_sandbox_id,
            WorkspaceCacheTerminalStatus::Success,
            crate::storage_fingerprints::StorageFingerprints::default(),
        );
        let destroy_gate = MockLifecycleGate::new();
        let existing_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        add_healthy_reuse_preparation_matcher(&existing_overrides);
        existing_overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
        existing_overrides.push_destroy_panic("simulated replaced idle destroy panic");
        let existing_factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
            MockSandboxFactory::with_overrides(Arc::clone(&existing_overrides)),
        ));
        let existing_sandbox = existing_factory
            .create(sandbox::SandboxConfig {
                id: old_sandbox_id,
                resources: sandbox::ResourceLimits {
                    cpu_count: 2,
                    memory_mb: 4096,
                },
                device_rate_limits: None,
                workspace_drive: None,
            })
            .await
            .expect("create existing sandbox");
        let (_existing_budget, existing_lease) = test_budget_lease();
        let existing_candidate = IdleParkRequest::new(IdleParkRequestParts {
            run_id: old_run_id,
            source_ip: existing_sandbox.source_ip().to_owned(),
            sandbox: existing_sandbox,
            factory: existing_factory,
            reuse_key: session_id.into(),
            sandbox_id: old_sandbox_id,
            profile_name: "vm0/default".into(),
            device_rate_limits: None,
            budget_lease: existing_lease,
            storage_fingerprints: crate::storage_fingerprints::StorageFingerprints::default(),
            restored_session_identity: None,
            history_generation_run_id: None,
            guest_timezone_intent: GuestTimezoneIntent::Unknown,
            workspace_image_size_bytes: b"image".len() as u64,
            workspace_promotion: Some(old_promotion),
            handoff: None,
        })
        .park_for_idle()
        .await
        .unwrap_or_else(|failure| {
            let error = failure.into_error();
            panic!("existing sandbox should park: {error}");
        })
        .expect_reusable()
        .with_last_completed_at(local_completed_at());
        assert!(matches!(
            fixture.idle_pool.lock().await.park(existing_candidate),
            ParkResult::Parked
        ));

        let reuse_state_notify = Arc::new(tokio::sync::Notify::new());
        let (_budget, lease) = test_budget_lease();
        let network_log_session = fixture.network_log_session().await;
        let new_run_id = RunId::new_v4();
        let new_sandbox_id = SandboxId::new_v4();
        let mut context = fixture.finalize_context(
            new_run_id,
            new_sandbox_id,
            session_id,
            network_log_session,
            RunCancellationHandle::new(),
        );
        context.reuse_state_notify = Arc::clone(&reuse_state_notify);

        let finalize_task = tokio::spawn(finalize_sandbox_for_completion(
            Some(Box::new(mock_sandbox_ready_for_idle_reuse(
                "replacement-sandbox",
            ))),
            ActiveBudgetLease::new(lease),
            context,
        ));

        destroy_gate
            .wait_entered(1, Duration::from_secs(5))
            .await
            .expect("replaced idle destroy should reach destroy gate");
        assert!(
            reuse_state_notify.notified().now_or_never().is_some(),
            "newly parked replacement should notify before replaced destroy finishes"
        );

        destroy_gate.release_one();
        let _finalization_ready = finalize_task.await.expect("finalizer task should join");
        assert!(
            reuse_state_notify.notified().now_or_never().is_some(),
            "replaced idle workspace cache promotion should notify after destroy"
        );
        assert!(
            cache
                .held_workspace_states()
                .await
                .iter()
                .any(|state| state.reuse_key == session_id),
            "replaced idle workspace cache should be visible after destroy completion"
        );
    }

    #[tokio::test]
    async fn finalizer_closes_network_log_session_before_cancel_destroy() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let cancel = RunCancellationHandle::new();
        cancel.request_hard_cancellation().await;
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();

        let _finalization_ready = finalize_sandbox_for_completion(
            Some(Box::new(MockSandbox::new("network-log-cancel"))),
            ActiveBudgetLease::new(lease),
            fixture.finalize_context(
                run_id,
                sandbox_id,
                "sess-network-log-cancel",
                network_log_session,
                cancel,
            ),
        )
        .await;

        assert_eq!(fixture.idle_pool.lock().await.len(), 0);
        assert!(
            !fixture
                .network_log_manager
                .append_for_ip(
                    "10.0.0.1",
                    serde_json::json!({"type":"dns","host":"after-destroy.test"})
                )
                .await,
            "cancelled destroyed sandbox must not retain network-log attribution",
        );
    }

    #[tokio::test]
    async fn finalizer_preserves_verified_success_metadata_after_late_cooperative_cancel() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let session_id = "sess-late-cooperative-cancel";
        let cancel = RunCancellationHandle::new();
        cancel.request_cooperative_user_cancellation().await;
        let cleanup_state = RunCleanupState::new();
        let identity = RestoredSessionIdentity::claude_code_for_test("verified-history");
        let mut context =
            fixture.finalize_context(run_id, sandbox_id, session_id, network_log_session, cancel);
        context.exit_code = 137;
        context.restored_session_identity = Some(identity.clone());
        context.cleanup_state = cleanup_state.clone();

        let _finalization_ready = finalize_sandbox_for_completion(
            Some(Box::new(mock_sandbox_ready_for_idle_reuse(
                "late-cooperative-cancel",
            ))),
            ActiveBudgetLease::new(lease),
            context,
        )
        .await;

        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::IdlePoolOwned,
        );
        let held = fixture.idle_pool.lock().await.held_sandbox_states();
        assert_eq!(held.len(), 1);
        assert_eq!(
            held[0].reusable_sandbox.history_generation_run_id,
            Some(run_id),
        );
        let entry = fixture
            .idle_pool
            .lock()
            .await
            .take(session_id)
            .expect("late-cancelled successful sandbox should be parked");
        let crate::idle_pool::IdleUnparkResult::Reused { sandbox, .. } =
            entry.try_unpark_for_run(RunId::new_v4()).await
        else {
            panic!("late-cancelled successful sandbox should unpark");
        };
        assert_eq!(sandbox.restored_session_identity(), Some(&identity));
    }

    #[tokio::test]
    async fn finalizer_destroys_candidate_when_cancelled_after_park() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let cancel = RunCancellationHandle::new();
        let cleanup_state = RunCleanupState::new();
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        add_healthy_reuse_preparation_matcher(&overrides);
        let park_gate = MockLifecycleGate::new();
        let destroy_gate = MockLifecycleGate::new();
        overrides.set_park_lifecycle_gate(park_gate.clone());
        overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
        let (factory, sandbox) = sandbox_with_overrides(sandbox_id, Arc::clone(&overrides)).await;
        let mut context = fixture.finalize_context(
            run_id,
            sandbox_id,
            "sess-cancel-after-park",
            network_log_session,
            cancel.clone(),
        );
        context.factory = factory;
        context.cleanup_state = cleanup_state.clone();

        let finalize_task = tokio::spawn(finalize_sandbox_for_completion(
            Some(sandbox),
            ActiveBudgetLease::new(lease),
            context,
        ));

        assert_eq!(
            park_gate
                .wait_entered(1, Duration::from_secs(5))
                .await
                .expect("park should enter gate"),
            1
        );
        cancel.request_hard_cancellation().await;
        park_gate.release_one();
        assert_eq!(
            destroy_gate
                .wait_entered(1, Duration::from_secs(5))
                .await
                .expect("cancelled parked candidate should enter destroy gate"),
            1
        );
        assert_eq!(fixture.idle_pool.lock().await.len(), 0);
        assert!(
            !fixture
                .network_log_manager
                .append_for_ip(
                    "10.0.0.1",
                    serde_json::json!({"type":"dns","host":"after-cancelled-park.test"})
                )
                .await,
            "cancelled parked candidate must close network-log attribution before destroy",
        );

        destroy_gate.release_one();
        let _finalization_ready = finalize_task.await.expect("finalizer task should join");
        assert_eq!(overrides.park_call_count(), 1);
        assert_eq!(overrides.destroy_call_count(), 1);
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::DestroyCompleted
        );
        assert_eq!(fixture.idle_pool.lock().await.len(), 0);
    }

    #[tokio::test]
    async fn finalizer_destroys_candidate_when_cancelled_before_idle_pool_transfer() {
        let (_budget, lease) = test_budget_lease();
        let fixture = FinalizeTestFixture::new().await;
        let network_log_session = fixture.network_log_session().await;
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let cancel = RunCancellationHandle::new();
        let cleanup_state = RunCleanupState::new();
        let observer = StartLoopTestObserver::default();
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        add_healthy_reuse_preparation_matcher(&overrides);
        let destroy_gate = MockLifecycleGate::new();
        overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
        let (factory, sandbox) = sandbox_with_overrides(sandbox_id, Arc::clone(&overrides)).await;
        let mut context = fixture.finalize_context(
            run_id,
            sandbox_id,
            "sess-cancel-before-transfer",
            network_log_session,
            cancel.clone(),
        );
        context.factory = factory;
        context.cleanup_state = cleanup_state.clone();
        context.test_observer = observer.clone();
        // Hold the pool lock so cancellation lands after the observer event but
        // before ownership can transfer into the idle pool.
        let pool_guard = fixture.idle_pool.lock().await;

        let finalize_task = tokio::spawn(finalize_sandbox_for_completion(
            Some(sandbox),
            ActiveBudgetLease::new(lease),
            context,
        ));

        observer
            .wait_before_idle_pool_ownership_transfer(run_id, Duration::from_secs(5))
            .await;
        cancel.request_hard_cancellation().await;
        assert!(
            !fixture
                .network_log_manager
                .append_for_ip(
                    "10.0.0.1",
                    serde_json::json!({"type":"dns","host":"before-transfer-cancel.test"})
                )
                .await,
            "network-log attribution must be closed before waiting for idle-pool ownership",
        );
        drop(pool_guard);
        assert_eq!(
            destroy_gate
                .wait_entered(1, Duration::from_secs(5))
                .await
                .expect("cancelled candidate should enter destroy gate"),
            1
        );

        destroy_gate.release_one();
        let _finalization_ready = finalize_task.await.expect("finalizer task should join");
        assert_eq!(overrides.park_call_count(), 1);
        assert_eq!(overrides.destroy_call_count(), 1);
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::DestroyCompleted
        );
        assert_eq!(fixture.idle_pool.lock().await.len(), 0);
    }
}
