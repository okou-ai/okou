//! Claimed job task spawning, completion, and panic cleanup.
//!
//! Discovery and idle reuse decide when a claimed job should start. This module
//! owns the spawned task body: concrete executor invocation and request wiring,
//! deferred telemetry/network-log uploads, and the outer panic boundary.
//! The supervisor owns post-executor finalizing, completion and settlement policy.

use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Instant;

use futures_util::FutureExt;
use sandbox::SandboxId;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tracing::{error, warn};

use super::job_terminal_log::log_terminal_job_outcome;
use super::sandbox_recovery::{self, ActiveSandboxIdentity};
#[cfg(test)]
use super::{
    OuterJobPanicPoint, StartLoopEvent, StartLoopTestObserver, finalization_test_hooks,
    maybe_panic_outer_job,
};
use crate::SharedFactory;
use crate::blank_pool::BlankPoolDiagnostics;
use crate::claimed_activation::ClaimedActivationError;
use crate::executor::{
    self, ExecutorConfig, RunnerPreSpawnConcurrency, RunnerPreSpawnPhase, RunnerPreSpawnTiming,
};
use crate::guest_timezone::GuestTimezoneIntent;
use crate::idle_lifecycle::{IdleDestroyTracker, SharedIdlePool};
use crate::idle_pool::{ParkingGate, ReusableIdleSandbox};
use crate::job_lifecycle::{
    ActiveBudgetLease, CompletionPayload, FinalizedJob, RunCleanupState, completion_failure_reason,
    recover_panicked_run,
};
use crate::network_log_drain::NetworkLogDrainCoordinator;
use crate::network_logs;
use crate::orphan_reap::OrphanedActiveRuns;
use crate::ownership::RunSandbox;
use crate::resource_budget::{BudgetLease, ResourceBudget};
use crate::sandbox_finalization::FinalizeContext;
#[cfg(not(test))]
use crate::sandbox_finalization::finalize_claimed_run;
#[cfg(test)]
use crate::sandbox_finalization::finalize_claimed_run_with_test_hooks;
use crate::status::StatusTracker;
use crate::storage_fingerprints::StorageFingerprints;
use crate::telemetry::JobTelemetry;
use runner_lifecycle::active_runs::{ActiveRunGuard, ActiveRunReusePublisher, ActiveRuns};
use runner_lifecycle::home_image_cache::snapshot::HomeCacheStateSnapshot;
use runner_provider::{ClaimedJob, JobProvider};
use runner_provider::{RunCancellationHandle, RunCancellationRegistration, RunCancellationSignals};
use runner_types::ids::RunId;
use runner_types::types::{ExecutionContext, SandboxReuseResult};

pub(super) type JobResult = Result<RunCancellationRegistration, ClaimedActivationError>;

/// Per-job profile parameters resolved from the profile config.
pub(super) struct JobProfile {
    pub(super) required_home_source_run_id: Option<RunId>,
    pub(super) profile_name: String,
    pub(super) rootfs_hash: String,
    pub(super) vcpu: u32,
    pub(super) memory_mb: u32,
    pub(super) home_disk_mb: u32,
    pub(super) budget_lease: BudgetLease,
    pub(super) restore_guest_state: bool,
    pub(super) device_rate_limits: Option<sandbox::DeviceRateLimits>,
    pub(super) home_image_prepare_policy: crate::home_image_cache::HomeImagePreparePolicy,
    pub(super) factory: SharedFactory,
    pub(super) cancellation: RunCancellationRegistration,
}

/// Shared state passed to each spawned job task.
#[derive(Clone)]
pub(super) struct SpawnContext {
    pub(super) runner_id: String,
    pub(super) diagnostic_error_tail_max_bytes: usize,
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
    /// home image cache.
    pub(super) reuse_state_notify: Arc<tokio::sync::Notify>,
    /// Best-effort signal for the main loop to ask mitmproxy to flush usage.
    pub(super) usage_flush_tx: mpsc::Sender<()>,
    pub(super) active_runs: ActiveRuns,
    pub(super) pre_spawn_concurrency: RunnerPreSpawnConcurrency,
    pub(super) blank_pool_diagnostics: BlankPoolDiagnostics,
    pub(super) budget: Arc<ResourceBudget>,
    pub(super) home_cache_snapshot: HomeCacheStateSnapshot,
    pub(super) sandbox_op_reporter: Option<runner_storage::SandboxOpReporter>,
    pub(super) device_rate_limits: Option<sandbox::DeviceRateLimits>,
    #[cfg(test)]
    pub(super) outer_job_panic: Option<OuterJobPanicPoint>,
    #[cfg(test)]
    pub(super) test_observer: StartLoopTestObserver,
}

pub(super) struct SpawnJobRequest {
    pub(super) claimed: ClaimedJob,
    pub(super) sandbox_id: SandboxId,
    pub(super) job_profile: JobProfile,
    pub(super) reuse_entry: Option<ReusableIdleSandbox>,
    pub(super) reuse_result: SandboxReuseResult,
    pub(super) pre_spawn_timing: RunnerPreSpawnTiming,
    pub(super) active_run_guard: ActiveRunGuard,
}

struct ExecutorInvocation {
    sandbox_recovery: Option<executor::SandboxRecoveryHooks>,
    run_id: RunId,
    sandbox_id: SandboxId,
    context: ExecutionContext,
    exec_config: Arc<ExecutorConfig>,
    params: executor::JobParams,
    factory: SharedFactory,
    reuse_entry: Option<ReusableIdleSandbox>,
    reuse_result: SandboxReuseResult,
    pre_spawn_timing: RunnerPreSpawnTiming,
    cancellation: RunCancellationSignals,
    sandbox_token: String,
    sandbox_prepared: Option<executor::SandboxPreparedNotifier>,
    active_input_source: Option<runner_provider::ActiveInputSource>,
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
            sandbox_recovery,
            run_id,
            sandbox_id,
            context,
            exec_config,
            params,
            factory,
            reuse_entry,
            reuse_result,
            pre_spawn_timing,
            cancellation,
            sandbox_token,
            sandbox_prepared,
            active_input_source,
        } = self;
        let exec_config_for_panic = Arc::clone(&exec_config);
        let cancel_for_outcome = cancellation.any();
        let cancellation_for_executor = cancellation.clone();
        let initial_storage_fingerprints = context
            .storage_manifest
            .as_ref()
            .map(StorageFingerprints::from_manifest)
            .unwrap_or_default();

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
                        sandbox_recovery,
                        sandbox_prepared: None,
                        active_input_source,
                        pre_spawn_timing: Some(pre_spawn_timing),
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
                        sandbox_recovery,
                        sandbox_prepared,
                        active_input_source,
                        pre_spawn_timing: Some(pre_spawn_timing),
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
                        storage_fingerprints: initial_storage_fingerprints,
                        sandbox_reuse_disposition: executor::SandboxReuseDisposition::default(),
                        sandbox: None,
                        source_ip: String::new(),
                        network_log_session: None,
                        home_image: None,
                        home_reuse_result: None,
                        startup_report: None,
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
    active_sandbox: ActiveSandboxIdentity,
    orphaned_active_runs: OrphanedActiveRuns,
    run_id: RunId,
    runner_id: String,
    active_lease: BudgetLease,
    reuse_result: SandboxReuseResult,
    home_disk_mb: u32,
    profile_name: String,
    rootfs_hash: String,
    reuse_key: Option<String>,
    cli_agent_session_id: Option<String>,
    device_rate_limits: Option<sandbox::DeviceRateLimits>,
    guest_timezone_intent: GuestTimezoneIntent,
    factory: SharedFactory,
    idle_pool: SharedIdlePool,
    idle_destroy_tracker: IdleDestroyTracker,
    status: Arc<StatusTracker>,
    reuse_state_notify: Arc<tokio::sync::Notify>,
    home_cache_snapshot: HomeCacheStateSnapshot,
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

impl FinalizationPhase {
    async fn finalize(self, executor_result: ExecutorPhaseOutcome) -> FinalizedJob {
        let Self {
            active_sandbox,
            orphaned_active_runs,
            run_id,
            runner_id,
            active_lease,
            reuse_result,
            home_disk_mb,
            profile_name,
            rootfs_hash,
            reuse_key,
            cli_agent_session_id,
            device_rate_limits,
            guest_timezone_intent,
            factory,
            idle_pool,
            idle_destroy_tracker,
            status,
            reuse_state_notify,
            home_cache_snapshot,
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
        if active_sandbox.is_unresolved() {
            let id = active_sandbox.current();
            if !orphaned_active_runs.has_retained_budget(run_id, id) {
                orphaned_active_runs.insert_retaining_budget(run_id, id, active_lease);
            }
            return FinalizedJob {
                finalization_ready: crate::job_lifecycle::FinalizationReady::new(
                    crate::job_lifecycle::BudgetOwnership::orphan_owned(),
                ),
                telemetry,
            };
        }
        let executor::ExecuteOutcome {
            failure: _,
            sandbox_reuse_disposition,
            storage_fingerprints,
            sandbox,
            source_ip,
            network_log_session,
            home_image,
            home_reuse_result: _,
            startup_report: _,
            discovered_cli_agent_session_id,
            restored_session_identity,
        } = outcome;
        #[cfg(test)]
        test_observer.record(StartLoopEvent::ExecutorCompleted {
            run_id,
            discovered_cli_agent_session_id: discovered_cli_agent_session_id.clone(),
            sandbox_reuse_disposition,
        });
        // Cancellation can arrive after terminal logging or while
        // `sandbox.park()` is in flight. Pass the live handle to the supervisor.
        let finalization_context = FinalizeContext {
            run_id,
            sandbox_id: active_sandbox.current(),
            runner_id,
            reuse_result,
            profile_name,
            rootfs_hash,
            reuse_key,
            cli_agent_session_id,
            discovered_cli_agent_session_id,
            restored_session_identity,
            source_ip,
            network_log_session,
            home_image,
            home_image_size_bytes: u64::from(home_disk_mb) * 1024 * 1024,
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
        };
        #[cfg(not(test))]
        let finalization_ready = finalize_claimed_run(
            sandbox,
            ActiveBudgetLease::new(active_lease),
            &mut telemetry,
            finalization_context,
        )
        .await;
        #[cfg(test)]
        let finalization_ready = finalize_claimed_run_with_test_hooks(
            sandbox,
            ActiveBudgetLease::new(active_lease),
            &mut telemetry,
            finalization_context,
            finalization_test_hooks(outer_job_panic, test_observer),
        )
        .await;
        FinalizedJob {
            finalization_ready,
            telemetry,
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
            let outcome = network_logs::upload_network_logs(
                &crate::network_log_http_adapter::NetworkLogHttpAdapter(&exec_config.http),
                run_id,
                &sandbox_token,
                &network_log_path,
            )
            .await;
            exec_config.network_log_upload_health.observe(outcome);
        };
        tokio::join!(telemetry.flush(), network_log_upload,);
    }
}

/// Spawn a job executor task.
///
/// The provider has already claimed the job and the caller has reserved
/// resources in the budget. The spawned task runs the executor, reports
/// completion through the supervisor, which owns the post-executor
/// park-or-destroy decision in [`crate::sandbox_finalization::finalize_claimed_run`].
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
/// [`BudgetOwnership`](crate::job_lifecycle::BudgetOwnership). Non-accepted paths
/// keep the active lease until provider completion and active-status settlement
/// have both finished, then release it. An accepted idle entry owns and retains
/// the lease until reuse or destruction.
pub(super) fn spawn_job(
    mut request: SpawnJobRequest,
    ctx: &SpawnContext,
    jobs: &mut JoinSet<JobResult>,
) {
    request.pre_spawn_timing.mark_task_enqueued();
    let ctx = ctx.clone();
    jobs.spawn(async move { Ok(run_job(request, ctx).await) });
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
        active_run_guard,
    } = request;
    let active_run_reuse = active_run_guard.reuse_publisher();
    let (context, completion_auth, active_input_source) = claimed.into_parts();
    let run_id = context.run_id;
    let reuse_key = context.reuse_key().map(str::to_owned);
    let cli_agent_session_id = if executor::validate_resume_session_id(&context).is_ok() {
        context.cli_agent_session_id().map(String::from)
    } else {
        None
    };
    let guest_timezone_intent = GuestTimezoneIntent::from_context(&context);
    let vcpu = job_profile.vcpu;
    let memory_mb = job_profile.memory_mb;
    let home_disk_mb = job_profile.home_disk_mb;
    let home_image_prepare_policy = job_profile.home_image_prepare_policy;
    let active_lease = job_profile.budget_lease;
    let profile_name = job_profile.profile_name;
    let factory = job_profile.factory;
    let cancellation = job_profile.cancellation;
    let job_cancel = cancellation.handle();
    let rootfs_hash = job_profile.rootfs_hash;
    let params = executor::JobParams {
        required_home_source_run_id: job_profile.required_home_source_run_id,
        profile_name: profile_name.clone(),
        rootfs_hash: rootfs_hash.clone(),
        vcpu,
        memory_mb,
        home_disk_mb,
        restore_guest_state: job_profile.restore_guest_state,
        device_rate_limits: job_profile.device_rate_limits.clone(),
        home_image_prepare_policy,
    };
    let job_device_rate_limits = params.device_rate_limits.clone();

    let provider = Arc::clone(&ctx.provider);
    let runner_id = ctx.runner_id.clone();
    let exec_config = Arc::clone(&ctx.exec_config);
    let status = Arc::clone(&ctx.status);
    let idle_pool = Arc::clone(&ctx.idle_pool);
    let reuse_state_notify = Arc::clone(&ctx.reuse_state_notify);
    let home_cache_snapshot = ctx.home_cache_snapshot.clone();
    let usage_flush_tx = ctx.usage_flush_tx.clone();
    let parking_gate = ctx.parking_gate.clone();
    let cleanup_state = RunCleanupState::new();
    let active_sandbox = ActiveSandboxIdentity::new(sandbox_id);
    let active_sandbox_for_panic = active_sandbox.clone();
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
                        Ok(false) => Err(runner_executor::ExecutorError::Internal(format!(
                            "sandbox {sandbox_id} prepared after active status changed for run {run_id}"
                        ))),
                        Err(error) => Err(runner_executor::ExecutorError::Internal(format!(
                            "persist prepared sandbox {sandbox_id} as running for run {run_id}: {error}"
                        ))),
                    }
                }
                .boxed()
            },
        ))
    };
    let mut executor = ExecutorInvocation {
        sandbox_recovery: Some(sandbox_recovery::source(
            &ctx,
            &params,
            factory.clone(),
            active_sandbox.clone(),
        )),
        run_id,
        sandbox_id,
        context,
        exec_config: Arc::clone(&exec_config),
        params,
        factory: Arc::clone(&factory),
        reuse_entry,
        reuse_result,
        pre_spawn_timing,
        cancellation: job_cancel.signals(),
        sandbox_token: sandbox_token.clone(),
        sandbox_prepared,
        active_input_source,
    };
    let finalization = FinalizationPhase {
        active_sandbox: active_sandbox.clone(),
        orphaned_active_runs: ctx.orphaned_active_runs.clone(),
        run_id,
        runner_id,
        active_lease,
        reuse_result,
        home_disk_mb,
        profile_name,
        rootfs_hash,
        reuse_key,
        cli_agent_session_id,
        device_rate_limits: job_device_rate_limits,
        guest_timezone_intent,
        factory,
        idle_pool: Arc::clone(&idle_pool),
        idle_destroy_tracker: ctx.idle_destroy_tracker.clone(),
        status: Arc::clone(&status),
        reuse_state_notify: Arc::clone(&reuse_state_notify),
        home_cache_snapshot,
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
    let diagnostic_error_tail_max_bytes = ctx.diagnostic_error_tail_max_bytes;
    let body = async move {
        #[cfg(test)]
        maybe_panic_outer_job(outer_job_panic, OuterJobPanicPoint::ActiveOrUnknown, run_id);

        let mut executor_result = executor.execute().await;
        let startup_report = executor_result.outcome.startup_report.take();
        let cancelled_for_log = job_cancel.is_cancelled();
        log_terminal_job_outcome(
            run_id,
            executor_result.exit_code,
            reused,
            cancelled_for_log,
            executor_result.outcome.failure.as_ref(),
            diagnostic_error_tail_max_bytes,
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
            active_sandbox.current(),
            completion_auth,
        );
        // Structural guarantee: claim (in provider) is always paired with complete.
        signal_usage_flush(run_id, &usage_flush_tx);
        let telemetry = completion_payload
            .complete_claimed_run(
                provider.as_ref(),
                move || finalization.finalize(executor_result),
                status.as_ref(),
                active_run_guard,
                &cleanup_state_for_body,
            )
            .await;
        // Completion, reuse handoff, and capacity release precede ancillary
        // delivery. The existing job owner still drains both tasks on shutdown.
        tokio::join!(deferred_upload.flush(telemetry), async {
            if let Some(report) = startup_report {
                report.finish().await;
            }
        });
    };

    let body_result = AssertUnwindSafe(body).catch_unwind().await;
    match body_result {
        Ok(()) => cancellation,
        Err(payload) => {
            let cleanup = cleanup_panicked_job(
                run_id,
                active_sandbox_for_panic.current(),
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
    recover_panicked_run(
        RunSandbox::new(run_id, sandbox_id),
        status.as_ref(),
        &idle_pool,
        &cleanup_state,
        &orphaned_active_runs,
    )
    .await;
}

/// Handle a completed job from the JoinSet, removing its cancellation registration.
pub(super) async fn handle_job_result(result: Option<Result<JobResult, tokio::task::JoinError>>) {
    match result {
        Some(Ok(Ok(cancellation))) => {
            cancellation.unregister().await;
        }
        Some(Ok(Err(error))) => {
            error!(%error, "claimed activation job failed");
        }
        Some(Err(e)) => {
            error!(error = %e, "job task panicked");
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests;
