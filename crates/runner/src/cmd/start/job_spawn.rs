//! Claimed job task spawning, completion, and panic cleanup.
//!
//! Discovery and idle reuse decide when a claimed job should start. This module
//! owns the spawned task body: executor orchestration, provider completion,
//! deferred telemetry/network-log uploads, and outer-task panic cleanup.

use crate::provider::DeferredSandboxFence;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::{Duration, Instant};

use api_contracts::generated::types::webhooks::agent::complete::RequestFailureReason;
use futures_util::FutureExt;
use sandbox::SandboxId;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tracing::{error, warn};

use super::active_runs::{ActiveRunGuard, ActiveRunReusePublisher, ActiveRuns};
use super::factory_lifecycle::SharedFactory;
use super::heartbeat::WorkspaceCacheStateSnapshot;
use super::idle_lifecycle::{IdleDestroyTracker, SharedIdlePool};
use super::job_lifecycle::{
    ActiveBudgetLease, CompletionPayload, FinalizationReady, RunCleanupDisposition, RunCleanupState,
};
use super::job_terminal_log::log_terminal_job_outcome;
use super::orphan_reap::OrphanedActiveRuns;
use super::ownership::{OwnershipTransitions, RunSandbox};
use super::sandbox_finalization::{
    FinalizeContext, finalize_sandbox_for_completion_with_telemetry,
};
#[cfg(test)]
use super::{OuterJobPanicPoint, StartLoopTestObserver, maybe_panic_outer_job};
use crate::error::RunnerError;
use crate::executor::{
    self, ExecutorConfig, RunnerPreSpawnConcurrency, RunnerPreSpawnPhase, RunnerPreSpawnTiming,
    SessionHistoryRestorePlan,
};
use crate::guest_timezone::GuestTimezoneIntent;
use crate::idle_pool::{ParkingGate, ReusableIdleSandbox};
use crate::ids::RunId;
use crate::network_log_drain::NetworkLogDrainCoordinator;
use crate::network_logs;
use crate::provider::{ClaimedJob, CompletionReportTiming, JobProvider};
use crate::resource_budget::{BudgetLease, ResourceBudget};
use crate::run_cancellation::{
    RunCancellationHandle, RunCancellationRegistration, RunCancellationSignals,
};
use crate::status::StatusTracker;
use crate::storage_fingerprints::StorageFingerprints;
use crate::telemetry::JobTelemetry;
use crate::types::{ExecutionContext, SandboxReuseResult};

/// Per-job profile parameters resolved from the profile config.
pub(super) struct JobProfile {
    pub(super) profile_name: String,
    pub(super) vcpu: u32,
    pub(super) memory_mb: u32,
    pub(super) workspace_disk_mb: u32,
    pub(super) budget_lease: BudgetLease,
    pub(super) restore_guest_state: bool,
    pub(super) device_rate_limits: Option<sandbox::DeviceRateLimits>,
    pub(super) workspace_image_prepare_lock_policy:
        crate::workspace_image_cache::WorkspaceImagePrepareLockPolicy,
    pub(super) factory: SharedFactory,
    pub(super) cancellation: RunCancellationRegistration,
}

/// Shared state passed to each spawned job task.
#[derive(Clone)]
pub(super) struct SpawnContext {
    pub(super) runner_id: String,
    pub(super) provider: Arc<dyn JobProvider>,
    pub(super) exec_config: Arc<ExecutorConfig>,
    pub(super) idle_pool: SharedIdlePool,
    pub(super) status: Arc<StatusTracker>,
    pub(super) orphaned_active_runs: OrphanedActiveRuns,
    /// Current lifecycle parking permission. This is checked at job
    /// completion so soft-drain/resume races do not depend on a stale
    /// spawn-time mode snapshot.
    pub(super) parking_gate: ParkingGate,
    pub(super) idle_destroy_tracker: IdleDestroyTracker,
    /// Notifies the main loop to send an immediate heartbeat after reusable
    /// state changes. This eliminates the up-to-10s blind spot where
    /// the server does not know which runner holds a reusable sandbox or
    /// workspace image cache.
    pub(super) reuse_state_notify: Arc<tokio::sync::Notify>,
    /// Best-effort signal for the main loop to ask mitmproxy to flush usage.
    pub(super) usage_flush_tx: mpsc::Sender<()>,
    pub(super) active_runs: ActiveRuns,
    pub(super) pre_spawn_concurrency: RunnerPreSpawnConcurrency,
    pub(super) budget: Arc<ResourceBudget>,
    pub(super) workspace_cache_snapshot: WorkspaceCacheStateSnapshot,
    pub(super) device_rate_limits: Option<sandbox::DeviceRateLimits>,
    #[cfg(test)]
    pub(super) outer_job_panic: Option<OuterJobPanicPoint>,
    #[cfg(test)]
    pub(super) test_observer: StartLoopTestObserver,
}

fn completion_failure_reason(
    exit_code: i32,
    cancelled: bool,
    failure: Option<&executor::ExecutionFailure>,
) -> Option<RequestFailureReason> {
    if exit_code == 0 || cancelled {
        return None;
    }
    let failure = failure?;
    match failure.kind {
        executor::ExecutionFailureKind::Generic
            if failure
                .resource_diagnostics
                .and_then(|diagnostics| diagnostics.failure_kind)
                == Some(executor::ResourceFailureKind::GuestRootFilesystemFull) =>
        {
            Some(RequestFailureReason::GuestRootFilesystemFull)
        }
        executor::ExecutionFailureKind::Generic => failure
            .diagnostic
            .as_ref()
            .and_then(|diagnostic| diagnostic.failure_reason)
            .map(Into::into),
        executor::ExecutionFailureKind::RunnerJobTimeout { .. } => {
            Some(RequestFailureReason::ExecutionTimeout)
        }
    }
}

pub(super) struct SpawnJobRequest {
    pub(super) claimed: ClaimedJob,
    pub(super) sandbox_id: SandboxId,
    pub(super) job_profile: JobProfile,
    pub(super) reuse_entry: Option<ReusableIdleSandbox>,
    pub(super) reuse_result: SandboxReuseResult,
    pub(super) pre_spawn_timing: RunnerPreSpawnTiming,
    pub(super) session_history_restore_plan: SessionHistoryRestorePlan,
    pub(super) active_run_guard: ActiveRunGuard,
}

struct ExecutorInvocation {
    run_id: RunId,
    sandbox_id: SandboxId,
    context: ExecutionContext,
    exec_config: Arc<ExecutorConfig>,
    params: executor::JobParams,
    factory: SharedFactory,
    reuse_entry: Option<ReusableIdleSandbox>,
    reuse_result: SandboxReuseResult,
    pre_spawn_timing: RunnerPreSpawnTiming,
    session_history_restore_plan: SessionHistoryRestorePlan,
    cancellation: RunCancellationSignals,
    sandbox_token: String,
    sandbox_prepared: Option<executor::SandboxPreparedNotifier>,
    active_input_source: Option<crate::active_input::ActiveInputSource>,
}

struct ExecutorPhaseOutcome {
    outcome: executor::ExecuteOutcome,
    exit_code: i32,
    err: Option<String>,
    telemetry: JobTelemetry,
}

impl ExecutorInvocation {
    async fn execute(self) -> ExecutorPhaseOutcome {
        let Self {
            run_id,
            sandbox_id,
            context,
            exec_config,
            params,
            factory,
            reuse_entry,
            reuse_result,
            pre_spawn_timing,
            session_history_restore_plan,
            cancellation,
            sandbox_token,
            sandbox_prepared,
            active_input_source,
        } = self;
        let exec_config_for_panic = Arc::clone(&exec_config);
        let cancel_for_outcome = cancellation.any();
        let cancellation_for_executor = cancellation.clone();

        // Inner spawn isolates panics: if execute_job panics, the outer task
        // still reports completion and releases budget.
        let inner = tokio::spawn(async move {
            if let Some(idle_entry) = reuse_entry {
                executor::execute_job_reuse_with_hooks(
                    executor::ReusedSandboxDispatch {
                        factory: &**factory,
                        idle_sandbox: idle_entry,
                        reuse_result,
                    },
                    context,
                    &exec_config,
                    &params,
                    cancellation_for_executor,
                    executor::ExecutionHooks {
                        sandbox_prepared: None,
                        active_input_source,
                        pre_spawn_timing: Some(pre_spawn_timing),
                        session_history_restore_plan,
                    },
                )
                .await
            } else {
                executor::execute_job_with_prepared_notifier(
                    &**factory,
                    context,
                    executor::NewSandboxDispatch {
                        id: sandbox_id,
                        reuse_result,
                    },
                    &exec_config,
                    &params,
                    cancellation_for_executor,
                    executor::ExecutionHooks {
                        sandbox_prepared,
                        active_input_source,
                        pre_spawn_timing: Some(pre_spawn_timing),
                        session_history_restore_plan,
                    },
                )
                .await
            }
        });

        match inner.await {
            Ok((mut outcome, telemetry)) => {
                if cancel_for_outcome.is_cancelled() {
                    outcome.mark_cancelled();
                }
                let exit_code = outcome.exit_code();
                let err = outcome.error().map(ToOwned::to_owned);
                ExecutorPhaseOutcome {
                    outcome,
                    exit_code,
                    err,
                    telemetry,
                }
            }
            Err(e) => {
                if let Some(runtime_sync) = exec_config_for_panic.connector_runtime_sync.as_ref() {
                    runtime_sync.unregister_run(run_id).await;
                }
                // Panic lost the in-flight telemetry buffer; substitute an
                // empty collector so the post-complete flush path stays
                // unconditional. `flush` early-returns on empty pending_ops.
                let telemetry = JobTelemetry::new(
                    exec_config_for_panic.http.clone(),
                    run_id,
                    sandbox_token,
                    exec_config_for_panic.runner_hostname.clone(),
                );
                let failure =
                    executor::ExecutionFailure::from_error(format!("executor task panicked: {e}"));
                let exit_code = failure.exit_code;
                let err = Some(failure.error.clone());
                ExecutorPhaseOutcome {
                    outcome: executor::ExecuteOutcome {
                        failure: Some(failure),
                        active_input_delivery_ids: Vec::new(),
                        sandbox_reuse_disposition: executor::SandboxReuseDisposition::default(),
                        sandbox: None,
                        source_ip: String::new(),
                        network_log_session: None,
                        workspace_image: None,
                        workspace_reuse_result: None,
                        discovered_cli_agent_session_id: None,
                        restored_session_identity: None,
                    },
                    exit_code,
                    err,
                    telemetry,
                }
            }
        }
    }
}

struct FinalizationPhase {
    run_id: RunId,
    sandbox_id: SandboxId,
    runner_id: String,
    active_lease: BudgetLease,
    reuse_result: SandboxReuseResult,
    workspace_disk_mb: u32,
    profile_name: String,
    reuse_key: Option<String>,
    cli_agent_session_id: Option<String>,
    storage_fingerprints: StorageFingerprints,
    device_rate_limits: Option<sandbox::DeviceRateLimits>,
    guest_timezone_intent: GuestTimezoneIntent,
    factory: SharedFactory,
    idle_pool: SharedIdlePool,
    status: Arc<StatusTracker>,
    reuse_state_notify: Arc<tokio::sync::Notify>,
    workspace_cache_snapshot: WorkspaceCacheStateSnapshot,
    parking_gate: ParkingGate,
    network_log_drain: NetworkLogDrainCoordinator,
    cancel: RunCancellationHandle,
    cleanup_state: RunCleanupState,
    active_run_reuse: ActiveRunReusePublisher,
    #[cfg(test)]
    outer_job_panic: Option<OuterJobPanicPoint>,
    #[cfg(test)]
    test_observer: StartLoopTestObserver,
}

struct FinalizedJob {
    release_proven: bool,
    finalization_ready: FinalizationReady,
    telemetry: JobTelemetry,
}

impl FinalizationPhase {
    async fn finalize(self, executor_result: ExecutorPhaseOutcome) -> FinalizedJob {
        let Self {
            run_id,
            sandbox_id,
            runner_id,
            active_lease,
            reuse_result,
            workspace_disk_mb,
            profile_name,
            reuse_key,
            cli_agent_session_id,
            storage_fingerprints,
            device_rate_limits,
            guest_timezone_intent,
            factory,
            idle_pool,
            status,
            reuse_state_notify,
            workspace_cache_snapshot,
            parking_gate,
            network_log_drain,
            cancel,
            cleanup_state,
            active_run_reuse,
            #[cfg(test)]
            outer_job_panic,
            #[cfg(test)]
            test_observer,
        } = self;
        let ExecutorPhaseOutcome {
            outcome,
            exit_code,
            err: _,
            mut telemetry,
        } = executor_result;
        let executor::ExecuteOutcome {
            failure: _,
            active_input_delivery_ids: _,
            sandbox_reuse_disposition,
            sandbox,
            source_ip,
            network_log_session,
            workspace_image,
            workspace_reuse_result: _,
            discovered_cli_agent_session_id,
            restored_session_identity,
        } = outcome;
        let had_sandbox = sandbox.is_some();
        let has_restored_session_identity = restored_session_identity.is_some();
        let has_reuse_key = reuse_key.is_some();
        let cleanup_state_after_finalize = cleanup_state.clone();

        // Cancellation can arrive after terminal logging or while
        // `sandbox.park()` is in flight. Pass the live handle so finalization
        // can synchronize the final idle-pool ownership transfer.
        let finalization_started = Instant::now();
        if has_reuse_key {
            assert!(
                active_run_reuse.mark_finalizing(finalization_started),
                "reusable active run entered finalization from a resolved state"
            );
        }
        telemetry.record(
            "runner_host_finalization_started",
            Duration::ZERO,
            true,
            None,
        );
        let finalization_ready = finalize_sandbox_for_completion_with_telemetry(
            sandbox,
            ActiveBudgetLease::new(active_lease),
            &mut telemetry,
            FinalizeContext {
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
                network_log_session,
                workspace_image,
                workspace_image_size_bytes: u64::from(workspace_disk_mb) * 1024 * 1024,
                storage_fingerprints,
                device_rate_limits,
                guest_timezone_intent,
                factory,
                idle_pool,
                status,
                reuse_state_notify: Arc::clone(&reuse_state_notify),
                active_run_reuse: active_run_reuse.clone(),
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
            },
        )
        .await;
        if has_reuse_key && active_run_reuse.publish_no_exact_sandbox() {
            reuse_state_notify.notify_one();
        }
        let finalization_duration = finalization_started.elapsed();
        let disposition = cleanup_state_after_finalize.disposition();
        let reuse_state_changed = finalization_ready.reuse_state_changed();
        if had_sandbox {
            telemetry.record(
                sandbox_reuse_disposition.telemetry_action(),
                Duration::ZERO,
                true,
                None,
            );
        }
        let (finalization_action, finalization_success, finalization_error) = match disposition {
            RunCleanupDisposition::IdlePoolOwned | RunCleanupDisposition::HandoffOwned => {
                ("runner_host_finalization_reusable_sandbox", true, None)
            }
            _ if reuse_state_changed => ("runner_host_finalization_workspace_cache", true, None),
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
        telemetry.record(
            finalization_action,
            finalization_duration,
            finalization_success,
            finalization_error,
        );
        record_session_history_identity_park_telemetry(
            &mut telemetry,
            disposition,
            has_restored_session_identity,
        );

        FinalizedJob {
            release_proven: disposition == RunCleanupDisposition::DestroyCompleted,
            finalization_ready,
            telemetry,
        }
    }
}

fn record_session_history_identity_park_telemetry(
    telemetry: &mut JobTelemetry,
    disposition: RunCleanupDisposition,
    has_restored_session_identity: bool,
) {
    if !matches!(disposition, RunCleanupDisposition::IdlePoolOwned) {
        return;
    }
    let action_type = if has_restored_session_identity {
        "session_history_identity_parked"
    } else {
        "session_history_identity_park_missing"
    };
    telemetry.record(action_type, Duration::ZERO, true, None);
}

struct CompletionSettlementPhase {
    run_id: RunId,
    sandbox_id: SandboxId,
    status: Arc<StatusTracker>,
    active_run_guard: ActiveRunGuard,
    cleanup_state: RunCleanupState,
}

impl CompletionSettlementPhase {
    async fn settle(self, finalization_ready: FinalizationReady, telemetry: &mut JobTelemetry) {
        let Self {
            run_id,
            sandbox_id,
            status,
            active_run_guard,
            cleanup_state,
        } = self;

        let ownership = OwnershipTransitions::new(status.as_ref());
        finalization_ready
            .settle(
                RunSandbox::new(run_id, sandbox_id),
                &ownership,
                &cleanup_state,
            )
            .await;
        if active_run_guard.release() {
            telemetry.record(
                "runner_active_reuse_key_released",
                Duration::ZERO,
                true,
                None,
            );
        }
    }
}

struct DeferredUploadPhase {
    run_id: RunId,
    sandbox_token: String,
    exec_config: Arc<ExecutorConfig>,
    mitm_log_flush: Option<crate::proxy::MitmRunLogFlush>,
}

impl DeferredUploadPhase {
    async fn flush(self, telemetry: JobTelemetry) {
        let Self {
            run_id,
            sandbox_token,
            exec_config,
            mitm_log_flush,
        } = self;

        // Best-effort telemetry, deferred past `provider.complete` so the
        // user-visible run-complete signal isn't blocked on these uploads.
        // They're still awaited (not spawned) so the surrounding `jobs`
        // JoinSet drains them on graceful shutdown: no data loss on SIGTERM.
        // Telemetry flush runs concurrently with best-effort network-log upload.
        // The job finalizer already closed the local Rust-side DNS/kmsg
        // session before sandbox reuse/release. Keep this flush as a
        // defensive no-op for any accepted writes still finishing.
        let network_log_path = exec_config.log_paths.network_log(run_id);
        let network_log_upload = async {
            exec_config
                .network_log_manager
                .flush_path(&network_log_path)
                .await;
            if let Some(mitm_log_flush) = mitm_log_flush {
                let flushed = mitm_log_flush.flush().await;
                if !flushed {
                    warn!(
                        run_id = %run_id,
                        path = %network_log_path.display(),
                        "proxy network log flush did not complete before upload"
                    );
                }
            }
            network_logs::upload_network_logs(
                &exec_config.http,
                run_id,
                &sandbox_token,
                &network_log_path,
            )
            .await;
        };
        tokio::join!(telemetry.flush(), network_log_upload,);
    }
}

/// Spawn a job executor task.
///
/// The provider has already claimed the job and the caller has reserved
/// resources in the budget. The spawned task runs the executor, reports
/// completion through the provider, and delegates the post-executor
/// park-or-destroy decision to [`finalize_sandbox_for_completion_with_telemetry`].
///
/// If `reuse_entry` is `Some`, the job reuses an existing idle sandbox.
/// Otherwise it creates a new one via the factory.
///
/// A sandbox is considered for idle parking only after execution supplies a
/// positive reuse disposition while parking is open, no hard cancellation is
/// active, and a reuse key is available. Park failure, hard cancellation before
/// idle-pool transfer, or pool rejection falls back to destruction.
///
/// The ownership state returned by finalization carries
/// [`BudgetOwnership`](super::job_lifecycle::BudgetOwnership). Non-accepted paths
/// keep the active lease until provider completion and active-status settlement
/// have both finished, then release it. An accepted idle entry owns and retains
/// the lease until reuse or destruction.
pub(super) fn spawn_job(
    mut request: SpawnJobRequest,
    ctx: &SpawnContext,
    jobs: &mut JoinSet<RunCancellationRegistration>,
) {
    request.pre_spawn_timing.mark_task_enqueued();
    jobs.spawn(run_job(request, ctx.clone()));
}

pub(super) async fn run_job(
    request: SpawnJobRequest,
    ctx: SpawnContext,
) -> RunCancellationRegistration {
    let started_at = Instant::now();
    let SpawnJobRequest {
        claimed,
        sandbox_id,
        job_profile,
        reuse_entry,
        reuse_result,
        pre_spawn_timing,
        session_history_restore_plan,
        active_run_guard,
    } = request;
    let active_run_reuse = active_run_guard.reuse_publisher();
    let (context, completion_auth, active_input_source) = claimed.into_parts();
    let run_id = context.run_id;
    let deferred_fence = context
        .pi_launch_config
        .as_ref()
        .and_then(|launch| launch.get("apiFirstTurn"))
        .filter(|handoff| {
            handoff
                .get("schemaVersion")
                .and_then(serde_json::Value::as_u64)
                == Some(2)
        })
        .and_then(|handoff| serde_json::from_value::<DeferredSandboxFence>(handoff.clone()).ok());
    let reuse_key = context.reuse_key().map(str::to_owned);
    let cli_agent_session_id = if executor::validate_resume_session_id(&context).is_ok() {
        context.cli_agent_session_id().map(String::from)
    } else {
        None
    };
    let guest_timezone_intent = GuestTimezoneIntent::from_context(&context);
    let vcpu = job_profile.vcpu;
    let memory_mb = job_profile.memory_mb;
    let workspace_disk_mb = job_profile.workspace_disk_mb;
    let workspace_image_prepare_lock_policy = job_profile.workspace_image_prepare_lock_policy;
    let active_lease = job_profile.budget_lease;
    let profile_name = job_profile.profile_name;
    let factory = job_profile.factory;
    let cancellation = job_profile.cancellation;
    let job_cancel = cancellation.handle();
    let params = executor::JobParams {
        profile_name: profile_name.clone(),
        vcpu,
        memory_mb,
        workspace_disk_mb,
        restore_guest_state: job_profile.restore_guest_state,
        device_rate_limits: job_profile.device_rate_limits.clone(),
        workspace_image_prepare_lock_policy,
    };
    let job_device_rate_limits = params.device_rate_limits.clone();

    let storage_fingerprints = context
        .storage_manifest
        .as_ref()
        .map(crate::storage_fingerprints::StorageFingerprints::from_manifest)
        .unwrap_or_default();

    let provider = Arc::clone(&ctx.provider);
    let runner_id = ctx.runner_id.clone();
    let exec_config = Arc::clone(&ctx.exec_config);
    let status = Arc::clone(&ctx.status);
    let idle_pool = Arc::clone(&ctx.idle_pool);
    let reuse_state_notify = Arc::clone(&ctx.reuse_state_notify);
    let workspace_cache_snapshot = ctx.workspace_cache_snapshot.clone();
    let usage_flush_tx = ctx.usage_flush_tx.clone();
    let parking_gate = ctx.parking_gate.clone();
    let cleanup_state = RunCleanupState::new();
    let cleanup_state_for_body = cleanup_state.clone();
    let cleanup_state_for_panic = cleanup_state.clone();
    let status_for_panic = Arc::clone(&status);
    let idle_pool_for_panic = Arc::clone(&idle_pool);
    let orphaned_active_runs_for_panic = ctx.orphaned_active_runs.clone();
    #[cfg(test)]
    let outer_job_panic = ctx.outer_job_panic;
    #[cfg(test)]
    let test_observer = ctx.test_observer.clone();

    // Captured for the executor panic-arm empty `JobTelemetry`, the final
    // `telemetry.flush()`, and the network-log upload. `context` gets moved
    // into the executor phase, so snapshot the token before spawning.
    let sandbox_token = context.sandbox_token.clone();
    let reused = reuse_entry.is_some();
    let sandbox_prepared = if reused {
        None
    } else {
        let status_for_prepared = Arc::clone(&status);
        Some(executor::SandboxPreparedNotifier::new(
            move |run_id, sandbox_id| {
                let status = Arc::clone(&status_for_prepared);
                async move {
                    match status
                        .mark_run_running_if_matching(run_id, sandbox_id)
                        .await
                    {
                        Ok(true) => Ok(()),
                        Ok(false) => Err(RunnerError::Internal(format!(
                            "sandbox {sandbox_id} prepared after active status changed for run {run_id}"
                        ))),
                        Err(error) => Err(RunnerError::Internal(format!(
                            "persist prepared sandbox {sandbox_id} as running for run {run_id}: {error}"
                        ))),
                    }
                }
                .boxed()
            },
        ))
    };
    let mut executor = ExecutorInvocation {
        run_id,
        sandbox_id,
        context,
        exec_config: Arc::clone(&exec_config),
        params,
        factory: Arc::clone(&factory),
        reuse_entry,
        reuse_result,
        pre_spawn_timing,
        session_history_restore_plan,
        cancellation: job_cancel.signals(),
        sandbox_token: sandbox_token.clone(),
        sandbox_prepared,
        active_input_source,
    };
    let finalization = FinalizationPhase {
        run_id,
        sandbox_id,
        runner_id,
        active_lease,
        reuse_result,
        workspace_disk_mb,
        profile_name,
        reuse_key,
        cli_agent_session_id,
        storage_fingerprints,
        device_rate_limits: job_device_rate_limits,
        guest_timezone_intent,
        factory,
        idle_pool: Arc::clone(&idle_pool),
        status: Arc::clone(&status),
        reuse_state_notify: Arc::clone(&reuse_state_notify),
        workspace_cache_snapshot,
        parking_gate,
        network_log_drain: exec_config.network_log_drain.clone(),
        cancel: job_cancel.clone(),
        cleanup_state: cleanup_state_for_body.clone(),
        active_run_reuse,
        #[cfg(test)]
        outer_job_panic,
        #[cfg(test)]
        test_observer,
    };
    let completion_settlement = CompletionSettlementPhase {
        run_id,
        sandbox_id,
        status,
        active_run_guard,
        cleanup_state: cleanup_state_for_body,
    };
    let deferred_upload = DeferredUploadPhase {
        run_id,
        sandbox_token,
        exec_config: Arc::clone(&exec_config),
        mitm_log_flush: exec_config
            .mitm_jsonl_flush
            .as_ref()
            .map(|handle| handle.for_run(run_id, exec_config.log_paths.network_log(run_id))),
    };

    executor
        .pre_spawn_timing
        .record_phase_elapsed(RunnerPreSpawnPhase::SpawnJobSetup, started_at);
    let recovery_provider = Arc::clone(&provider);
    let body = async move {
        #[cfg(test)]
        maybe_panic_outer_job(outer_job_panic, OuterJobPanicPoint::ActiveOrUnknown, run_id);

        let mut executor_result = executor.execute().await;
        let cancelled_for_log = job_cancel.is_cancelled();
        log_terminal_job_outcome(
            run_id,
            executor_result.exit_code,
            reused,
            cancelled_for_log,
            executor_result.outcome.failure.as_ref(),
        );
        let failure_reason = completion_failure_reason(
            executor_result.exit_code,
            cancelled_for_log,
            executor_result.outcome.failure.as_ref(),
        );

        let completion_payload = CompletionPayload::new(
            run_id,
            executor_result.exit_code,
            failure_reason,
            executor_result.err.take(),
            sandbox_id,
            reuse_result,
            completion_auth,
        )
        .with_active_input_delivery_ids(std::mem::take(
            &mut executor_result.outcome.active_input_delivery_ids,
        ))
        .with_workspace_reuse_result(executor_result.outcome.workspace_reuse_result);
        // Structural guarantee: claim (in provider) is always paired with complete.
        signal_usage_flush(run_id, &usage_flush_tx);
        let (completion_report, finalized) = match provider.completion_report_timing() {
            CompletionReportTiming::ConcurrentWithFinalization => tokio::join!(
                completion_payload.report(provider.as_ref()),
                finalization.finalize(executor_result),
            ),
            CompletionReportTiming::AfterFinalization => {
                let finalized = finalization.finalize(executor_result).await;
                let completion_report = completion_payload.report(provider.as_ref()).await;
                (completion_report, finalized)
            }
        };
        let FinalizedJob {
            release_proven,
            finalization_ready,
            mut telemetry,
        } = finalized;
        if release_proven && let Some(fence) = deferred_fence {
            provider.release_deferred_sandbox(run_id, fence).await;
        }
        completion_report.record(&mut telemetry);
        completion_settlement
            .settle(finalization_ready, &mut telemetry)
            .await;
        deferred_upload.flush(telemetry).await;
    };

    let body_result = AssertUnwindSafe(body).catch_unwind().await;
    recovery_provider.claimed_actor_gone(run_id).await;
    match body_result {
        Ok(()) => cancellation,
        Err(payload) => {
            let cleanup = cleanup_panicked_job(
                run_id,
                sandbox_id,
                cancellation,
                status_for_panic,
                idle_pool_for_panic,
                cleanup_state_for_panic,
                orphaned_active_runs_for_panic,
            );
            if AssertUnwindSafe(cleanup).catch_unwind().await.is_err() {
                error!(
                    run_id = %run_id,
                    sandbox_id = %sandbox_id,
                    "outer job panic cleanup panicked"
                );
            }
            std::panic::resume_unwind(payload);
        }
    }
}

fn signal_usage_flush(run_id: RunId, usage_flush_tx: &mpsc::Sender<()>) {
    match usage_flush_tx.try_send(()) {
        Ok(()) | Err(mpsc::error::TrySendError::Full(())) => {}
        Err(mpsc::error::TrySendError::Closed(())) => {
            warn!(run_id = %run_id, "proxy usage flush signal channel closed before completion");
        }
    }
}

pub(super) async fn cleanup_panicked_job(
    run_id: RunId,
    sandbox_id: SandboxId,
    cancellation: RunCancellationRegistration,
    status: Arc<StatusTracker>,
    idle_pool: SharedIdlePool,
    cleanup_state: RunCleanupState,
    orphaned_active_runs: OrphanedActiveRuns,
) {
    cancellation.unregister().await;
    let ownership = OwnershipTransitions::new(status.as_ref());
    let run = RunSandbox::new(run_id, sandbox_id);

    match cleanup_state.disposition() {
        RunCleanupDisposition::StatusRemoved => {}
        RunCleanupDisposition::DestroyCompleted => {
            ownership.active_destroy_completed(run).await;
        }
        RunCleanupDisposition::IdlePoolOwned => {
            let snapshot = idle_pool.lock().await.status_snapshot();
            ownership.active_idle_pool_owned(run, snapshot).await;
        }
        RunCleanupDisposition::HandoffOwned => {
            ownership.active_completed(run).await;
        }
        RunCleanupDisposition::ActiveOrUnknown => {
            warn!(
                run_id = %run_id,
                sandbox_id = %sandbox_id,
                "outer job task panicked before sandbox ownership was proven; leaving active run visible for orphan reconciliation"
            );
            ownership.active_ownership_unknown(&orphaned_active_runs, run);
        }
    }
}

/// Handle a completed job from the JoinSet, removing its cancellation registration.
pub(super) async fn handle_job_result(
    result: Option<Result<RunCancellationRegistration, tokio::task::JoinError>>,
) {
    match result {
        Some(Ok(cancellation)) => {
            cancellation.unregister().await;
        }
        Some(Err(e)) => {
            error!(error = %e, "job task panicked");
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use guest_contracts::diagnostics::{
        AgentFramework, FailureClass, FailureDiagnostic, FailureReason, PromptMetadata,
    };
    use std::sync::Arc;
    use std::time::Duration;

    use sandbox::SandboxId;

    use super::super::active_runs::ActiveRuns;
    use super::super::idle_lifecycle::SharedIdlePool;
    use super::super::job_lifecycle::RunCleanupState;
    use super::super::orphan_reap::OrphanedActiveRuns;
    use crate::http::{HttpClient, HttpClientConfig};
    use crate::idle_pool::{
        IdlePool, IdlePoolConfig, IdleUnparkResult, ParkResult,
        test_support::ParkedIdleCandidateBuilder,
    };
    use crate::idle_reuse_preparation::mock_sandbox_ready_for_idle_reuse;
    use crate::ids::RunId;
    use crate::resource_budget::ResourceBudget;
    use crate::restored_session_identity::RestoredSessionIdentity;
    use crate::run_cancellation::RunCancellationRegistry;
    use crate::status::StatusTracker;

    fn test_http_client() -> HttpClient {
        HttpClient::new(HttpClientConfig {
            api_url: "http://localhost".into(),
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
        })
        .unwrap()
    }

    fn test_budget_lease() -> (Arc<ResourceBudget>, BudgetLease) {
        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        (budget, lease)
    }

    fn assert_telemetry_action(telemetry: &JobTelemetry, action: &str) {
        let ops = telemetry.pending_ops_snapshot();
        assert!(
            ops.iter().any(|op| op.0 == action && op.1),
            "expected telemetry action {action}, got: {ops:?}"
        );
    }

    fn assert_failed_telemetry_action(telemetry: &JobTelemetry, action: &str, error: &str) {
        let ops = telemetry.pending_ops_snapshot();
        assert!(
            ops.iter()
                .any(|op| op.0 == action && !op.1 && op.2.as_deref() == Some(error)),
            "expected failed telemetry action {action} with {error}, got: {ops:?}"
        );
    }

    fn assert_no_telemetry_action(telemetry: &JobTelemetry, action: &str) {
        let ops = telemetry.pending_ops_snapshot();
        assert!(
            ops.iter().all(|op| op.0 != action),
            "unexpected telemetry action {action}, got: {ops:?}"
        );
    }

    fn assert_telemetry_outcome(telemetry: &JobTelemetry, action: &str, outcome: Option<&str>) {
        let outcomes = telemetry.pending_ops_with_outcome_snapshot();
        assert!(
            outcomes
                .iter()
                .any(|op| op.0 == action && op.2.as_deref() == outcome),
            "expected telemetry action {action} with outcome {outcome:?}, got: {outcomes:?}"
        );
    }

    struct FinalizationTelemetryFixture {
        _dir: tempfile::TempDir,
        status: Arc<StatusTracker>,
        idle_pool: SharedIdlePool,
        parking_gate: ParkingGate,
        reuse_state_notify: Arc<tokio::sync::Notify>,
        active_runs: ActiveRuns,
        active_run_guards: std::sync::Mutex<Vec<ActiveRunGuard>>,
    }

    impl FinalizationTelemetryFixture {
        async fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let status = Arc::new(StatusTracker::new(
                dir.path().join("status.json"),
                4,
                None,
                None,
            ));
            status.write_initial().await.unwrap();
            let parking_gate = ParkingGate::new_open();
            let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new_with_parking_gate(
                IdlePoolConfig { max_idle: 10 },
                parking_gate.clone(),
            )));

            let reuse_state_notify = Arc::new(tokio::sync::Notify::new());
            let active_runs = ActiveRuns::new(Arc::clone(&reuse_state_notify));
            Self {
                _dir: dir,
                status,
                idle_pool,
                parking_gate,
                reuse_state_notify,
                active_runs,
                active_run_guards: std::sync::Mutex::new(Vec::new()),
            }
        }

        fn finalization_phase(
            &self,
            run_id: RunId,
            sandbox_id: SandboxId,
            session_id: &str,
            active_lease: BudgetLease,
            cleanup_state: RunCleanupState,
        ) -> FinalizationPhase {
            let active_run_guard =
                self.active_runs
                    .register(run_id, Some(session_id.into()), "vm0/default".into());
            let active_run_reuse = active_run_guard.reuse_publisher();
            self.active_run_guards
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(active_run_guard);
            FinalizationPhase {
                run_id,
                sandbox_id,
                runner_id: "runner-test".into(),
                active_lease,
                reuse_result: SandboxReuseResult::PoolMiss,
                workspace_disk_mb: 0,
                profile_name: "vm0/default".into(),
                reuse_key: Some(session_id.into()),
                cli_agent_session_id: Some(session_id.into()),
                storage_fingerprints: StorageFingerprints::default(),
                guest_timezone_intent: GuestTimezoneIntent::Unknown,
                device_rate_limits: None,
                factory: Arc::new(Box::new(sandbox_mock::MockSandboxFactory::new())),
                idle_pool: Arc::clone(&self.idle_pool),
                status: Arc::clone(&self.status),
                reuse_state_notify: Arc::clone(&self.reuse_state_notify),
                workspace_cache_snapshot: WorkspaceCacheStateSnapshot::new(),
                parking_gate: self.parking_gate.clone(),
                network_log_drain: NetworkLogDrainCoordinator::noop(),
                cancel: RunCancellationHandle::new(),
                cleanup_state,
                active_run_reuse,
                outer_job_panic: None,
                test_observer: StartLoopTestObserver::default(),
            }
        }
    }

    fn executor_phase_outcome(
        run_id: RunId,
        sandbox_name: &str,
        restored_session_identity: Option<RestoredSessionIdentity>,
    ) -> ExecutorPhaseOutcome {
        executor_phase_outcome_with_sandbox(
            run_id,
            Box::new(mock_sandbox_ready_for_idle_reuse(sandbox_name)),
            restored_session_identity,
        )
    }

    fn executor_phase_outcome_with_sandbox(
        run_id: RunId,
        sandbox: Box<dyn sandbox::Sandbox>,
        restored_session_identity: Option<RestoredSessionIdentity>,
    ) -> ExecutorPhaseOutcome {
        ExecutorPhaseOutcome {
            outcome: executor::ExecuteOutcome {
                failure: None,
                active_input_delivery_ids: Vec::new(),
                sandbox_reuse_disposition: executor::SandboxReuseDisposition::Eligible(
                    executor::SandboxReuseTerminal::Success,
                ),
                sandbox: Some(sandbox),
                source_ip: "10.0.0.1".into(),
                network_log_session: None,
                workspace_image: None,
                workspace_reuse_result: None,
                discovered_cli_agent_session_id: None,
                restored_session_identity,
            },
            exit_code: 0,
            err: None,
            telemetry: JobTelemetry::new(test_http_client(), run_id, "sandbox-token".into(), None),
        }
    }

    fn executor_phase_outcome_without_sandbox(run_id: RunId) -> ExecutorPhaseOutcome {
        ExecutorPhaseOutcome {
            outcome: executor::ExecuteOutcome {
                failure: None,
                active_input_delivery_ids: Vec::new(),
                sandbox_reuse_disposition: executor::SandboxReuseDisposition::default(),
                sandbox: None,
                source_ip: String::new(),
                network_log_session: None,
                workspace_image: None,
                workspace_reuse_result: None,
                discovered_cli_agent_session_id: None,
                restored_session_identity: None,
            },
            exit_code: 1,
            err: Some("sandbox unavailable".into()),
            telemetry: JobTelemetry::new(test_http_client(), run_id, "sandbox-token".into(), None),
        }
    }

    #[test]
    fn generic_zero_exit_code_normalizes_to_generic_failure() {
        let failure = executor::ExecutionFailure::new(0, "", None);

        assert_eq!(failure.exit_code, 1);
        assert_eq!(failure.error, "Agent exited with code 1");
        assert_eq!(failure.kind, executor::ExecutionFailureKind::Generic);
    }

    #[test]
    fn runner_job_timeout_zero_exit_code_normalizes_to_timeout_failure() {
        let failure = executor::ExecutionFailure::runner_job_timeout(
            0,
            "",
            None,
            Duration::from_secs(7200),
            Duration::from_secs(7201),
            None,
        );

        assert_eq!(failure.exit_code, 124);
        assert_eq!(failure.error, "Agent exited with code 124");
        match failure.kind {
            executor::ExecutionFailureKind::RunnerJobTimeout {
                timeout_ms,
                elapsed_ms,
                guest_duration_ms,
            } => {
                assert_eq!(timeout_ms, 7_200_000);
                assert_eq!(elapsed_ms, 7_201_000);
                assert_eq!(guest_duration_ms, None);
            }
            executor::ExecutionFailureKind::Generic => {
                panic!("expected runner job timeout failure kind")
            }
        }
    }

    #[test]
    fn completion_reason_uses_diagnostic_for_generic_failure() {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_failure_reason(FailureReason::UsageLimit);
        let failure = executor::ExecutionFailure::new(1, "usage limit", Some(diagnostic));

        assert_eq!(
            completion_failure_reason(1, false, Some(&failure)),
            Some(RequestFailureReason::UsageLimit)
        );
    }

    #[test]
    fn completion_reason_reports_proven_rootfs_exhaustion() {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_failure_reason(FailureReason::UsageLimit);
        for diagnostic in [None, Some(diagnostic)] {
            let failure =
                executor::ExecutionFailure::new(1, "Agent exited with code 1", diagnostic)
                    .with_resource_diagnostics(Some(
                        executor::ResourceFailureDiagnostics::from_failure_kind(
                            executor::ResourceFailureKind::GuestRootFilesystemFull,
                        ),
                    ));
            assert_eq!(
                completion_failure_reason(1, false, Some(&failure)),
                Some(RequestFailureReason::GuestRootFilesystemFull)
            );
            assert_eq!(completion_failure_reason(0, false, Some(&failure)), None);
            assert_eq!(completion_failure_reason(1, true, Some(&failure)), None);
        }
    }

    #[test]
    fn completion_reason_does_not_infer_rootfs_exhaustion_from_error_text() {
        let failure = executor::ExecutionFailure::new(1, "No space left on device", None);
        assert_eq!(completion_failure_reason(1, false, Some(&failure)), None);
        for kind in [
            executor::ResourceFailureKind::GuestMemoryOomKilled,
            executor::ResourceFailureKind::HostMemoryOomKilled,
        ] {
            let failure = executor::ExecutionFailure::new(1, "Agent process killed", None)
                .with_resource_diagnostics(Some(
                    executor::ResourceFailureDiagnostics::from_failure_kind(kind),
                ));
            assert_eq!(completion_failure_reason(1, false, Some(&failure)), None);
        }
    }

    #[test]
    fn completion_reason_uses_runner_kind_for_timeout_and_overrides_diagnostic() {
        let failure = executor::ExecutionFailure::runner_job_timeout(
            124,
            "execution timed out",
            None,
            Duration::from_secs(7200),
            Duration::from_secs(7200),
            None,
        );

        assert_eq!(
            completion_failure_reason(124, false, Some(&failure)),
            Some(RequestFailureReason::ExecutionTimeout)
        );

        let conflicting_diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_failure_reason(FailureReason::UsageLimit);
        let failure_with_conflicting_diagnostic = executor::ExecutionFailure::runner_job_timeout(
            124,
            "execution timed out",
            Some(conflicting_diagnostic),
            Duration::from_secs(7200),
            Duration::from_secs(7200),
            None,
        )
        .with_resource_diagnostics(Some(
            executor::ResourceFailureDiagnostics::from_failure_kind(
                executor::ResourceFailureKind::GuestRootFilesystemFull,
            ),
        ));

        assert_eq!(
            completion_failure_reason(124, false, Some(&failure_with_conflicting_diagnostic)),
            Some(RequestFailureReason::ExecutionTimeout)
        );
    }

    #[test]
    fn completion_reason_omits_success_and_cancellation() {
        let failure = executor::ExecutionFailure::runner_job_timeout(
            124,
            "execution timed out",
            None,
            Duration::from_secs(7200),
            Duration::from_secs(7200),
            None,
        );

        assert_eq!(completion_failure_reason(0, false, None), None);
        assert_eq!(completion_failure_reason(124, true, Some(&failure)), None);
    }

    #[tokio::test]
    async fn finalization_records_identity_parked_when_idle_pool_receives_restored_identity() {
        let fixture = FinalizationTelemetryFixture::new().await;
        let (_budget, lease) = test_budget_lease();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let cleanup_state = RunCleanupState::new();
        let identity = RestoredSessionIdentity::claude_code_for_test("history-hash-a");
        let finalization = fixture.finalization_phase(
            run_id,
            sandbox_id,
            "thread:restore-plan",
            lease,
            cleanup_state.clone(),
        );

        let finalized = finalization
            .finalize(executor_phase_outcome(
                run_id,
                "identity-parked",
                Some(identity.clone()),
            ))
            .await;

        assert_telemetry_action(
            &finalized.telemetry,
            "runner_host_finalization_reusable_sandbox",
        );
        assert_telemetry_action(
            &finalized.telemetry,
            "runner_terminal_sandbox_reuse_eligible_success",
        );
        for action in [
            "runner_host_finalization_started",
            "runner_host_reuse_preparation",
            "runner_host_physical_park",
            "runner_host_idle_publication",
            "runner_host_physical_park_balloon_setup",
            "runner_host_physical_park_balloon_settle",
            "runner_host_physical_park_vcpu_pause",
        ] {
            assert_telemetry_action(&finalized.telemetry, action);
        }
        assert_telemetry_outcome(
            &finalized.telemetry,
            "runner_host_physical_park_balloon_setup",
            Some("skipped"),
        );
        assert_telemetry_outcome(
            &finalized.telemetry,
            "runner_host_physical_park_balloon_settle",
            Some("skipped"),
        );
        assert_telemetry_outcome(
            &finalized.telemetry,
            "runner_host_physical_park_vcpu_pause",
            None,
        );
        assert_telemetry_action(&finalized.telemetry, "session_history_identity_parked");
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::IdlePoolOwned,
        );
        let entry = fixture
            .idle_pool
            .lock()
            .await
            .take("thread:restore-plan")
            .expect("parked sandbox should be in idle pool");
        let IdleUnparkResult::Reused { sandbox, .. } =
            entry.try_unpark_for_run(RunId::new_v4()).await
        else {
            panic!("parked sandbox should unpark");
        };
        assert_eq!(sandbox.restored_session_identity(), Some(&identity));
    }

    #[tokio::test]
    async fn cooperative_cancellation_reuse_does_not_record_hard_cancellation_marker() {
        let fixture = FinalizationTelemetryFixture::new().await;
        let (_budget, lease) = test_budget_lease();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let session_id = "sess-cooperative-cancellation";
        let cleanup_state = RunCleanupState::new();
        let finalization = fixture.finalization_phase(
            run_id,
            sandbox_id,
            session_id,
            lease,
            cleanup_state.clone(),
        );
        finalization
            .cancel
            .request_cooperative_user_cancellation()
            .await;
        let mut executor_result = executor_phase_outcome(run_id, "cooperative-cancellation", None);
        executor_result.outcome.sandbox_reuse_disposition =
            executor::SandboxReuseDisposition::Eligible(
                executor::SandboxReuseTerminal::CooperativeCancellation,
            );

        let finalized = finalization.finalize(executor_result).await;

        assert_telemetry_action(
            &finalized.telemetry,
            "runner_host_finalization_reusable_sandbox",
        );
        assert_telemetry_action(
            &finalized.telemetry,
            "runner_terminal_sandbox_reuse_eligible_cooperative_cancellation",
        );
        assert_no_telemetry_action(&finalized.telemetry, "runner_host_finalization_cancelled");
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::IdlePoolOwned,
        );
        assert!(fixture.idle_pool.lock().await.take(session_id).is_some());
    }

    #[tokio::test]
    async fn hard_cancellation_records_finalization_cancellation_marker() {
        let fixture = FinalizationTelemetryFixture::new().await;
        let (_budget, lease) = test_budget_lease();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let cleanup_state = RunCleanupState::new();
        let finalization = fixture.finalization_phase(
            run_id,
            sandbox_id,
            "sess-hard-cancellation",
            lease,
            cleanup_state.clone(),
        );
        finalization.cancel.request_hard_cancellation().await;
        let mut executor_result = executor_phase_outcome(run_id, "hard-cancellation", None);
        executor_result.outcome.sandbox_reuse_disposition =
            executor::SandboxReuseDisposition::Ineligible(
                executor::SandboxReuseRejection::HardCancellation,
            );

        let finalized = finalization.finalize(executor_result).await;

        assert_failed_telemetry_action(
            &finalized.telemetry,
            "runner_host_finalization_cancelled",
            "cancelled",
        );
        assert_telemetry_action(
            &finalized.telemetry,
            "runner_terminal_sandbox_reuse_rejected_hard_cancellation",
        );
        assert_telemetry_action(&finalized.telemetry, "runner_host_finalization_no_resource");
        assert_no_telemetry_action(&finalized.telemetry, "runner_host_reuse_preparation");
        assert_no_telemetry_action(&finalized.telemetry, "runner_host_physical_park");
        assert_no_telemetry_action(&finalized.telemetry, "runner_host_idle_publication");
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::DestroyCompleted,
        );
    }

    #[tokio::test]
    async fn finalization_records_identity_park_missing_when_parked_without_restored_identity() {
        let fixture = FinalizationTelemetryFixture::new().await;
        let (_budget, lease) = test_budget_lease();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let cleanup_state = RunCleanupState::new();
        let session_id = "sess-park-missing";
        let finalization = fixture.finalization_phase(
            run_id,
            sandbox_id,
            session_id,
            lease,
            cleanup_state.clone(),
        );

        let finalized = finalization
            .finalize(executor_phase_outcome(
                run_id,
                "identity-park-missing",
                None,
            ))
            .await;

        assert_telemetry_action(
            &finalized.telemetry,
            "session_history_identity_park_missing",
        );
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::IdlePoolOwned,
        );
        let entry = fixture
            .idle_pool
            .lock()
            .await
            .take(session_id)
            .expect("parked sandbox should be in idle pool");
        let IdleUnparkResult::Reused { sandbox, .. } =
            entry.try_unpark_for_run(RunId::new_v4()).await
        else {
            panic!("parked sandbox should unpark");
        };
        assert!(sandbox.restored_session_identity().is_none());
    }

    #[tokio::test]
    async fn finalization_delivers_requested_exact_handoff_without_idle_publication() {
        let fixture = FinalizationTelemetryFixture::new().await;
        let (_budget, lease) = test_budget_lease();
        let run_id = RunId::new_v4();
        let successor_run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let reuse_key = "thread:direct-finalization-handoff";
        let cleanup_state = RunCleanupState::new();
        let finalization =
            fixture.finalization_phase(run_id, sandbox_id, reuse_key, lease, cleanup_state.clone());
        let proof = fixture
            .active_runs
            .finalizing_predecessor(run_id, reuse_key, "vm0/default")
            .expect("registered predecessor should be available");
        let mut handoff = proof
            .request_handoff(successor_run_id)
            .expect("exact successor should register one handoff");

        let finalized = finalization
            .finalize(executor_phase_outcome(run_id, "direct-handoff", None))
            .await;

        assert_telemetry_action(&finalized.telemetry, "runner_host_exact_sandbox_handoff");
        assert_telemetry_outcome(
            &finalized.telemetry,
            "runner_host_exact_sandbox_handoff",
            Some("after_full_park"),
        );
        assert_no_telemetry_action(&finalized.telemetry, "runner_host_idle_publication");
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::HandoffOwned
        );
        assert_eq!(fixture.idle_pool.lock().await.len(), 0);
        assert!(handoff.accepted().await);
        let candidate = handoff
            .receive()
            .await
            .expect("accepted exact handoff should deliver its sandbox");
        candidate
            .into_destroy_job()
            .run_with_context("test_direct_handoff_cleanup")
            .await;
    }

    #[tokio::test]
    async fn finalization_records_no_resource_when_execution_has_no_sandbox() {
        let fixture = FinalizationTelemetryFixture::new().await;
        let (_budget, lease) = test_budget_lease();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let finalization = fixture.finalization_phase(
            run_id,
            sandbox_id,
            "sess-no-sandbox",
            lease,
            RunCleanupState::new(),
        );

        let finalized = finalization
            .finalize(executor_phase_outcome_without_sandbox(run_id))
            .await;

        assert_telemetry_action(&finalized.telemetry, "runner_host_finalization_no_resource");
    }

    #[tokio::test]
    async fn finalization_records_reuse_preparation_failure_without_physical_park() {
        let fixture = FinalizationTelemetryFixture::new().await;
        let (_budget, lease) = test_budget_lease();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let cleanup_state = RunCleanupState::new();
        let sandbox = sandbox_mock::MockSandbox::new("reuse-preparation-failed");
        sandbox.push_exec_result(Err(sandbox::SandboxError::Operation {
            operation: sandbox::SandboxOperation::Exec,
            reason: sandbox::SandboxOperationReason::Guest,
            message: "reuse preparation disconnected".into(),
        }));
        let finalization = fixture.finalization_phase(
            run_id,
            sandbox_id,
            "sess-reuse-preparation-failed",
            lease,
            cleanup_state,
        );

        let finalized = finalization
            .finalize(executor_phase_outcome_with_sandbox(
                run_id,
                Box::new(sandbox),
                None,
            ))
            .await;

        assert_failed_telemetry_action(
            &finalized.telemetry,
            "runner_host_reuse_preparation",
            "reuse preparation failed",
        );
        assert_no_telemetry_action(&finalized.telemetry, "runner_host_physical_park");
        assert_no_telemetry_action(&finalized.telemetry, "runner_host_idle_publication");
        assert_telemetry_action(&finalized.telemetry, "runner_host_finalization_no_resource");
    }

    #[tokio::test]
    async fn finalization_records_physical_park_failure_after_reuse_preparation() {
        let fixture = FinalizationTelemetryFixture::new().await;
        let (_budget, lease) = test_budget_lease();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let cleanup_state = RunCleanupState::new();
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher(&overrides);
        overrides.push_park_result(Err(sandbox::SandboxError::IdleTransition {
            transition: sandbox::SandboxIdleTransition::Park,
            message: "physical park failed".into(),
        }));
        let finalization = fixture.finalization_phase(
            run_id,
            sandbox_id,
            "sess-physical-park-failed",
            lease,
            cleanup_state,
        );

        let finalized = finalization
            .finalize(executor_phase_outcome_with_sandbox(
                run_id,
                Box::new(sandbox_mock::MockSandbox::with_overrides(
                    "physical-park-failed",
                    overrides,
                )),
                None,
            ))
            .await;

        assert_telemetry_action(&finalized.telemetry, "runner_host_reuse_preparation");
        assert_failed_telemetry_action(
            &finalized.telemetry,
            "runner_host_physical_park",
            "physical park failed",
        );
        assert_no_telemetry_action(&finalized.telemetry, "runner_host_idle_publication");
        assert_telemetry_action(&finalized.telemetry, "runner_host_finalization_no_resource");
    }

    async fn status_idle_reuse_keys_and_active_runs(
        status_path: &std::path::Path,
    ) -> (Vec<String>, Vec<String>) {
        let raw = tokio::fs::read_to_string(status_path).await.unwrap();
        let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let mut reuse_keys: Vec<String> = status
            .get("idle_sandboxes")
            .and_then(|v| v.as_array())
            .map(|idle_sandboxes| {
                idle_sandboxes
                    .iter()
                    .filter_map(|sandbox| {
                        sandbox
                            .get("reuse_key")
                            .and_then(|reuse_key| reuse_key.as_str())
                            .map(str::to_string)
                    })
                    .collect()
            })
            .unwrap_or_default();
        reuse_keys.sort_unstable();
        let mut run_ids: Vec<String> = status["active_runs"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|run| {
                run.get("run_id")
                    .and_then(|run_id| run_id.as_str())
                    .map(str::to_string)
            })
            .collect();
        run_ids.sort_unstable();
        (reuse_keys, run_ids)
    }
    async fn status_active_run_records(status_path: &std::path::Path) -> Vec<(String, String)> {
        let raw = tokio::fs::read_to_string(status_path).await.unwrap();
        let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let mut records: Vec<(String, String)> = status["active_runs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|run| {
                (
                    run["run_id"].as_str().unwrap().to_string(),
                    run["sandbox_id"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        records.sort_unstable();
        records
    }

    struct CleanupPanickedJobFixture {
        status_path: std::path::PathBuf,
        status: Arc<StatusTracker>,
        idle_pool: SharedIdlePool,
        tokens: RunCancellationRegistry,
        orphans: OrphanedActiveRuns,
        _dir: tempfile::TempDir,
    }

    impl CleanupPanickedJobFixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let status_path = dir.path().join("status.json");
            let status = Arc::new(StatusTracker::new(status_path.clone(), 4, None, None));
            let idle_pool: SharedIdlePool =
                Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
                    max_idle: 10,
                })));
            let tokens = RunCancellationRegistry::new();
            let orphans = OrphanedActiveRuns::new();

            Self {
                status_path,
                status,
                idle_pool,
                tokens,
                orphans,
                _dir: dir,
            }
        }

        async fn cleanup(
            &self,
            run_id: RunId,
            sandbox_id: SandboxId,
            cleanup_state: RunCleanupState,
        ) {
            let cancellation = self.tokens.register(run_id).await.unwrap();
            self.cleanup_with_registration(run_id, sandbox_id, cleanup_state, cancellation)
                .await;
        }

        async fn cleanup_with_registration(
            &self,
            run_id: RunId,
            sandbox_id: SandboxId,
            cleanup_state: RunCleanupState,
            cancellation: RunCancellationRegistration,
        ) {
            cleanup_panicked_job(
                run_id,
                sandbox_id,
                cancellation,
                Arc::clone(&self.status),
                Arc::clone(&self.idle_pool),
                cleanup_state,
                self.orphans.clone(),
            )
            .await;
        }
    }

    #[tokio::test]
    async fn panic_cleanup_status_removed_only_clears_cancel_token() {
        let fixture = CleanupPanickedJobFixture::new();
        let cleanup_state = RunCleanupState::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        fixture.status.add_run(run_id, sandbox_id).await.unwrap();
        fixture
            .status
            .remove_run_if_matching(run_id, sandbox_id)
            .await
            .unwrap();
        cleanup_state.mark_status_removed();

        fixture.cleanup(run_id, sandbox_id, cleanup_state).await;

        assert!(!fixture.tokens.contains(run_id).await);
        let (_idle_reuse_keys, active_runs) =
            status_idle_reuse_keys_and_active_runs(&fixture.status_path).await;
        assert!(active_runs.is_empty());
        assert_eq!(fixture.orphans.len(), 0);
    }

    #[tokio::test]
    async fn panic_cleanup_active_unknown_keeps_active_and_registers_orphan() {
        let fixture = CleanupPanickedJobFixture::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        fixture.status.add_run(run_id, sandbox_id).await.unwrap();
        fixture
            .cleanup(run_id, sandbox_id, RunCleanupState::new())
            .await;

        assert!(!fixture.tokens.contains(run_id).await);
        let (_idle_reuse_keys, active_runs) =
            status_idle_reuse_keys_and_active_runs(&fixture.status_path).await;
        assert_eq!(active_runs, vec![run_id.to_string()]);
        assert_eq!(fixture.orphans.len(), 1);
    }

    #[tokio::test]
    async fn panic_cleanup_destroy_completed_removes_active_run() {
        let fixture = CleanupPanickedJobFixture::new();
        let cleanup_state = RunCleanupState::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        fixture.status.add_run(run_id, sandbox_id).await.unwrap();
        cleanup_state.mark_destroy_completed();

        fixture.cleanup(run_id, sandbox_id, cleanup_state).await;

        assert!(!fixture.tokens.contains(run_id).await);
        let (_idle_reuse_keys, active_runs) =
            status_idle_reuse_keys_and_active_runs(&fixture.status_path).await;
        assert!(active_runs.is_empty());
        assert_eq!(fixture.orphans.len(), 0);
    }

    #[tokio::test]
    async fn panic_cleanup_destroy_completed_does_not_remove_reinserted_active_run() {
        let fixture = CleanupPanickedJobFixture::new();
        let cleanup_state = RunCleanupState::new();
        let run_id = RunId::new_v4();
        let completed_sandbox_id = SandboxId::new_v4();
        let current_sandbox_id = SandboxId::new_v4();
        fixture
            .status
            .add_run(run_id, completed_sandbox_id)
            .await
            .unwrap();
        fixture
            .status
            .add_run(run_id, current_sandbox_id)
            .await
            .unwrap();
        let stale_cancellation = fixture.tokens.register(run_id).await.unwrap();
        assert!(stale_cancellation.unregister().await);
        let replacement_cancellation = fixture.tokens.register(run_id).await.unwrap();
        cleanup_state.mark_destroy_completed();

        fixture
            .cleanup_with_registration(
                run_id,
                completed_sandbox_id,
                cleanup_state,
                stale_cancellation,
            )
            .await;

        assert!(
            fixture.tokens.contains(run_id).await,
            "stale panic cleanup must preserve the replacement registration",
        );
        assert_eq!(
            status_active_run_records(&fixture.status_path).await,
            vec![(run_id.to_string(), current_sandbox_id.to_string())],
        );
        assert_eq!(fixture.orphans.len(), 0);
        assert!(replacement_cancellation.unregister().await);
    }

    #[tokio::test]
    async fn panic_cleanup_idle_pool_owned_refreshes_idle_status_before_removing_active() {
        let fixture = CleanupPanickedJobFixture::new();
        let cleanup_state = RunCleanupState::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let candidate = ParkedIdleCandidateBuilder::new("sess-idle-owned-cleanup", lease)
            .with_mock_sandbox_name("idle-owned-cleanup")
            .with_sandbox_id(sandbox_id)
            .build();
        assert!(matches!(
            fixture.idle_pool.lock().await.park(candidate),
            ParkResult::Parked
        ));
        fixture.status.add_run(run_id, sandbox_id).await.unwrap();
        cleanup_state.mark_idle_pool_owned();

        fixture.cleanup(run_id, sandbox_id, cleanup_state).await;

        assert!(!fixture.tokens.contains(run_id).await);
        let (idle_reuse_keys, active_runs) =
            status_idle_reuse_keys_and_active_runs(&fixture.status_path).await;
        assert_eq!(idle_reuse_keys, vec!["sess-idle-owned-cleanup"]);
        assert!(active_runs.is_empty());
        assert_eq!(fixture.orphans.len(), 0);
    }
}
