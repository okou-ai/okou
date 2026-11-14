//! Shared ordinary admission activation and guarded executor dispatch.

use std::collections::BTreeMap;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Instant;

use futures_util::FutureExt;
use tokio::task::JoinSet;
use tracing::{info, warn};

use super::RuntimeProfile as ProfileConfig;
use super::error::{ReactorError, ReactorResult};
use super::finalizing_activation::FinalizingActivationRequest;
use super::job_spawn::{JobProfile, JobResult, SpawnContext, SpawnJobRequest, spawn_job};
#[cfg(test)]
use super::{OuterJobPanicPoint, maybe_panic_outer_job};
use crate::SharedFactory;
use crate::activation::{
    JobActivationError, JobActivationGuard, JobActivationResources, JobActivationSetup,
    ReadyExecutionResource, blank_pool_selection_telemetry,
};
use crate::executor::{
    BlankPoolSelection, RunnerPreSpawnPhase, RunnerPreSpawnTiming, validate_resume_session_id,
};
use crate::idle_lifecycle::SharedIdlePool;
use crate::lifecycle::RunnerMode;
use crate::resource_activation::{
    ActivationResources, ReservedActivation, ReservedActivationRequest, ReuseAdmissionRequest,
    ReuseFromPoolReady, activate_reserved_idle, try_reuse_from_pool,
};
use crate::resource_admission::{
    AdmissionResources, SandboxAdmittedResource, rollback_sandbox_admitted_resource,
};
use crate::resource_budget::ResourceBudget;
use crate::status::StatusTracker;
use crate::telemetry::JobTelemetry;
use runner_provider::{ExecutionJob, JobCandidate};
use runner_provider::{RunCancellationRegistration, RunCancellationRegistry};
#[cfg(test)]
use runner_types::ids::RunId;
use runner_types::types::CompleteRequest;

pub(super) struct LocalJob {
    pub(super) candidate: JobCandidate,
}

pub(super) struct ExecutionProfile {
    pub(super) profile_name: String,
    pub(super) rootfs_hash: String,
    pub(super) vcpu: u32,
    pub(super) memory_mb: u32,
    pub(super) home_disk_mb: u32,
    pub(super) restore_guest_state: bool,
    pub(super) factory: SharedFactory,
}

pub(super) struct PreparedLocalJob {
    pub(super) candidate: JobCandidate,
    pub(super) profile: ExecutionProfile,
}

/// Ordinary job custody, excluding the specialized finalizing successor.
pub(super) struct SandboxAdmittedJob {
    pub(super) job: ExecutionJob,
    pub(super) resource: SandboxAdmittedResource,
    pub(super) cancellation: RunCancellationRegistration,
    pub(super) admitted_at: Instant,
    pub(super) blank_pool_selection: Option<BlankPoolSelection>,
}

pub(super) struct AdmissionContext {
    pub(super) mode_rx: tokio::sync::watch::Receiver<RunnerMode>,
    pub(super) cancel_tokens: RunCancellationRegistry,
    pub(super) spawn_ctx: SpawnContext,
}

impl AdmissionContext {
    pub(super) fn resources(&self) -> AdmissionResources<'_> {
        AdmissionResources {
            active_runs: &self.spawn_ctx.active_runs,
            idle_pool: &self.spawn_ctx.idle_pool,
            status: &self.spawn_ctx.status,
            mode_rx: &self.mode_rx,
            cancel_tokens: &self.cancel_tokens,
            provider: self.spawn_ctx.provider.as_ref(),
            budget: &self.spawn_ctx.budget,
            idle_destroy_tracker: &self.spawn_ctx.idle_destroy_tracker,
            reuse_state_notify: &self.spawn_ctx.reuse_state_notify,
            blank_pool_diagnostics: &self.spawn_ctx.blank_pool_diagnostics,
        }
    }
}

pub(super) struct JobActivationContext<'a> {
    pub(super) budget: &'a Arc<ResourceBudget>,
    pub(super) idle_pool: &'a SharedIdlePool,
    pub(super) status: &'a Arc<StatusTracker>,
    pub(super) mode_rx: &'a tokio::sync::watch::Receiver<RunnerMode>,
    pub(super) cancel_tokens: &'a RunCancellationRegistry,
    pub(super) spawn_ctx: &'a SpawnContext,
}

pub(super) struct JobActivationResult {
    pub(super) needs_reuse_state_refresh: bool,
    prepared: Option<Box<JobActivationGuard>>,
}

impl JobActivationResult {
    pub(super) fn completed(needs_reuse_state_refresh: bool) -> Self {
        Self {
            needs_reuse_state_refresh,
            prepared: None,
        }
    }

    pub(super) fn dispatch(
        mut self,
        ctx: &SpawnContext,
        jobs: &mut JoinSet<JobResult>,
    ) -> ReactorResult<Self> {
        if let Some(mut activation) = self.prepared.take() {
            let request = finish_spawn_job_request(&mut activation, ctx)
                .map_err(|error| ReactorError::Internal(error.to_string()))?;
            spawn_job(request, ctx, jobs);
        }
        Ok(self)
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
        home_cache: ctx.exec_config.home_cache.as_ref(),
        home_cache_snapshot: &ctx.home_cache_snapshot,
        blank_pool_diagnostics: &ctx.blank_pool_diagnostics,
        on_preparing_committed,
    }
}

fn admission_resources<'a>(ctx: &'a JobActivationContext<'_>) -> AdmissionResources<'a> {
    AdmissionResources {
        active_runs: &ctx.spawn_ctx.active_runs,
        idle_pool: ctx.idle_pool,
        status: ctx.status,
        mode_rx: ctx.mode_rx,
        cancel_tokens: ctx.cancel_tokens,
        provider: ctx.spawn_ctx.provider.as_ref(),
        budget: ctx.budget,
        idle_destroy_tracker: &ctx.spawn_ctx.idle_destroy_tracker,
        reuse_state_notify: ctx.spawn_ctx.reuse_state_notify.as_ref(),
        blank_pool_diagnostics: &ctx.spawn_ctx.blank_pool_diagnostics,
    }
}

pub(super) fn prepare_local_job(
    job: LocalJob,
    profiles: &BTreeMap<String, ProfileConfig>,
    factories: &BTreeMap<String, (SharedFactory, bool)>,
) -> Option<PreparedLocalJob> {
    let LocalJob { candidate } = job;
    let run_id = candidate.run_id();
    let profile_name = candidate.profile_name();
    let Some(profile) = prepare_job_profile(profile_name, profiles, factories) else {
        warn!(run_id = %run_id, profile = %profile_name, "unknown profile or missing factory, skipping");
        return None;
    };
    Some(PreparedLocalJob { candidate, profile })
}

/// Profile lookup shared by discovery and authenticated complete-input intake.
/// The intake path must not log an unknown caller-supplied profile or payload.
pub(super) fn prepare_job_profile(
    profile_name: &str,
    profiles: &BTreeMap<String, ProfileConfig>,
    factories: &BTreeMap<String, (SharedFactory, bool)>,
) -> Option<ExecutionProfile> {
    let profile = profiles.get(profile_name)?;
    let (factory, restore_guest_state) = factories.get(profile_name)?;
    Some(ExecutionProfile {
        profile_name: profile_name.to_owned(),
        rootfs_hash: profile.rootfs_hash.clone(),
        vcpu: profile.vcpu,
        memory_mb: profile.memory_mb,
        home_disk_mb: profile.home_disk_mb,
        restore_guest_state: *restore_guest_state,
        factory: Arc::clone(factory),
    })
}

pub(super) async fn prepare_admitted_job(
    admission: SandboxAdmittedJob,
    profile: ExecutionProfile,
    mut ctx: JobActivationContext<'_>,
) -> ReactorResult<JobActivationResult> {
    let run_id = admission.job.context().run_id;
    let ExecutionProfile {
        profile_name,
        rootfs_hash: job_rootfs_hash,
        vcpu: job_vcpu,
        memory_mb: job_memory,
        home_disk_mb: job_home_disk_mb,
        restore_guest_state,
        factory,
    } = profile;
    let restore_guest_state = &restore_guest_state;
    let factory = &factory;
    let device_rate_limits = ctx.spawn_ctx.device_rate_limits.clone();
    let SandboxAdmittedJob {
        job,
        resource,
        cancellation,
        admitted_at,
        blank_pool_selection,
    } = admission;
    let mut pre_spawn_timing =
        RunnerPreSpawnTiming::start_at(admitted_at, &ctx.spawn_ctx.pre_spawn_concurrency);
    if let Some(selection) = blank_pool_selection {
        pre_spawn_timing.record_blank_pool_selection(selection);
    }
    let started_at = Instant::now();
    let resume_session_error = validate_resume_session_id(job.context()).err();
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::ResumeSessionValidation, started_at);
    if let Some(error) = resume_session_error {
        let needs_reuse_state_refresh = matches!(&resource, SandboxAdmittedResource::Reusable(_));
        complete_without_sandbox(
            job,
            cancellation,
            resource,
            ActivationFailureDiagnostics::from_timing(&pre_spawn_timing),
            crate::executor::ExecutionFailure::from_error(error),
            &mut ctx,
        )
        .await;
        return Ok(JobActivationResult::completed(needs_reuse_state_refresh));
    }
    info!(run_id = %run_id, profile = %profile_name, "admitted job, spawning executor");
    let started_at = Instant::now();
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::DeviceRateLimits, started_at);

    // Hide the job reuse key from heartbeats before unpark or fallback
    // cleanup can yield. Otherwise a concurrent heartbeat could briefly
    // advertise stale home-cache state for an active run.
    let active_run_guard = ctx.spawn_ctx.active_runs.register(
        run_id,
        job.context().reuse_key().map(str::to_owned),
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
            let ReuseFromPoolReady {
                reuse_entry,
                active_lease,
                reuse_result,
                idle_snapshot,
                needs_reuse_state_refresh: refresh,
                transfer_guard,
            } = match try_reuse_from_pool(
                run_id,
                ReuseAdmissionRequest {
                    profile_name: &profile_name,
                    device_rate_limits: &device_rate_limits,
                    home_disk_mb: job_home_disk_mb,
                    rootfs_hash: &job_rootfs_hash,
                    context: job.context(),
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
                    let completion = complete_execution_failure(
                        job,
                        cancellation,
                        ActivationFailureDiagnostics::from_timing(&pre_spawn_timing),
                        crate::executor::ExecutionFailure::from_error(failure.error),
                        ctx.spawn_ctx,
                    )
                    .await;
                    drop(active_run_guard);
                    completion.flush_telemetry().await;
                    return Ok(JobActivationResult::completed(true));
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
                complete_without_sandbox(
                    job,
                    cancellation,
                    SandboxAdmittedResource::Reusable(reservation),
                    ActivationFailureDiagnostics::from_timing(&pre_spawn_timing),
                    crate::executor::ExecutionFailure::cancelled(),
                    &mut ctx,
                )
                .await;
                return Ok(JobActivationResult::completed(true));
            }
            match activate_reserved_idle(
                reservation,
                ReservedActivationRequest {
                    run_id,
                    required_home_source_run_id: None,
                    profile_name: &profile_name,
                    device_rate_limits: &device_rate_limits,
                    home_disk_mb: job_home_disk_mb,
                    rootfs_hash: &job_rootfs_hash,
                    context: job.context(),
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
                    reuse_result: _,
                    error,
                } => {
                    drop(transfer_guard);
                    let failure = crate::executor::ExecutionFailure::from_error(error);
                    if let Some(budget_lease) = budget_lease {
                        complete_without_sandbox(
                            job,
                            cancellation,
                            SandboxAdmittedResource::Fresh(budget_lease),
                            ActivationFailureDiagnostics::from_timing(&pre_spawn_timing),
                            failure,
                            &mut ctx,
                        )
                        .await;
                    } else {
                        let completion = complete_execution_failure(
                            job,
                            cancellation,
                            ActivationFailureDiagnostics::from_timing(&pre_spawn_timing),
                            failure,
                            ctx.spawn_ctx,
                        )
                        .await;
                        completion.flush_telemetry().await;
                    }
                    return Ok(JobActivationResult::completed(true));
                }
            }
        }
    };

    let mut activation = JobActivationGuard::new(
        JobActivationSetup {
            required_home_source_run_id: None,
            job,
            rootfs_hash: job_rootfs_hash,
            cancellation,
            profile_name,
            vcpu: job_vcpu,
            memory_mb: job_memory,
            home_disk_mb: job_home_disk_mb,
            restore_guest_state: *restore_guest_state,
            device_rate_limits,
            factory: Arc::clone(factory),
            resource: ReadyExecutionResource {
                reuse_entry,
                active_lease,
                reuse_result,
                idle_snapshot,
            },
            pre_spawn_timing,
            active_run_guard,
        },
        job_activation_resources(ctx.spawn_ctx),
    );
    match AssertUnwindSafe(prepare_spawn_job_request(&mut activation, ctx.spawn_ctx))
        .catch_unwind()
        .await
    {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            activation
                .recover(error.recovery_reason(), error.to_string())
                .await
                .map_err(|error| ReactorError::Internal(error.to_string()))?
                .finish()
                .await;
            drop(activation_transfer_guard);
            return Ok(JobActivationResult::completed(true));
        }
        Err(panic) => {
            if let Err(error) = activation.recover_setup_panic().await {
                tracing::error!(%error, "job activation panic recovery failed");
            }
            drop(activation_transfer_guard);
            std::panic::resume_unwind(panic);
        }
    };
    let result = JobActivationResult {
        needs_reuse_state_refresh,
        prepared: Some(Box::new(activation)),
    };
    // The published setup now has its own guarded result owner. Cancellation
    // must not wait for Reactor to consume that result and release this gate.
    drop(activation_transfer_guard);
    Ok(result)
}

pub(super) fn job_activation_resources(ctx: &SpawnContext) -> JobActivationResources {
    JobActivationResources {
        provider: Arc::clone(&ctx.provider),
        exec_config: Arc::clone(&ctx.exec_config),
        status: Arc::clone(&ctx.status),
        orphaned_active_runs: ctx.orphaned_active_runs.clone(),
        reuse_state_notify: Arc::clone(&ctx.reuse_state_notify),
        idle_destroy_tracker: ctx.idle_destroy_tracker.clone(),
    }
}

async fn prepare_spawn_job_request(
    activation: &mut JobActivationGuard,
    ctx: &SpawnContext,
) -> Result<(), JobActivationError> {
    activation.record_resource_budget_occupancy(&ctx.budget)?;
    #[cfg(test)]
    let run_id = activation.setup()?.job.context().run_id;
    #[cfg(test)]
    maybe_panic_outer_job(
        ctx.outer_job_panic,
        OuterJobPanicPoint::JobActivation,
        run_id,
    );
    activation.publish_active_status().await?;
    #[cfg(test)]
    ctx.test_observer.notify_active_run_status_published(run_id);
    Ok(())
}

fn finish_spawn_job_request(
    activation: &mut JobActivationGuard,
    ctx: &SpawnContext,
) -> Result<SpawnJobRequest, JobActivationError> {
    let sandbox_id = activation.sandbox_id();
    let JobActivationSetup {
        required_home_source_run_id,
        job,
        rootfs_hash,
        cancellation,
        profile_name,
        vcpu,
        memory_mb,
        home_disk_mb,
        restore_guest_state,
        device_rate_limits,
        factory,
        resource,
        pre_spawn_timing,
        active_run_guard,
    } = activation.take_setup_after_status()?;
    let ReadyExecutionResource {
        reuse_entry,
        active_lease,
        reuse_result,
        idle_snapshot,
    } = resource;
    drop(idle_snapshot);

    let home_image_prepare_policy = if ctx.exec_config.home_cache.is_some()
        && job.context().reuse_key().is_some_and(|key| {
            ctx.home_cache_snapshot
                .has_compatible_home_hint(key, &profile_name)
        }) {
        crate::home_image_cache::HomeImagePreparePolicy::TryCacheWithLockWait
    } else if job.is_supplied() {
        // Assigned direct work can check a ready home without waiting for an
        // unknown owner; advisory inventory need not observe every publication.
        crate::home_image_cache::HomeImagePreparePolicy::TryCacheWithoutLockWait
    } else {
        crate::home_image_cache::HomeImagePreparePolicy::SkipCache
    };

    Ok(SpawnJobRequest {
        job,
        sandbox_id,
        job_profile: JobProfile {
            required_home_source_run_id,
            profile_name,
            rootfs_hash,
            vcpu,
            memory_mb,
            home_disk_mb,
            budget_lease: active_lease,
            restore_guest_state,
            device_rate_limits,
            home_image_prepare_policy,
            factory,
            cancellation,
        },
        reuse_entry,
        reuse_result,
        pre_spawn_timing,
        active_run_guard,
    })
}

async fn complete_without_sandbox(
    job: ExecutionJob,
    cancellation: RunCancellationRegistration,
    resource: SandboxAdmittedResource,
    diagnostics: ActivationFailureDiagnostics,
    failure: crate::executor::ExecutionFailure,
    ctx: &mut JobActivationContext<'_>,
) {
    let completion =
        complete_execution_failure(job, cancellation, diagnostics, failure, ctx.spawn_ctx).await;
    rollback_sandbox_admitted_resource(resource, &admission_resources(ctx)).await;
    completion.flush_telemetry().await;
}

#[derive(Clone, Copy)]
struct ActivationFailureDiagnostics {
    blank_pool_selection: Option<BlankPoolSelection>,
}

impl ActivationFailureDiagnostics {
    fn from_timing(timing: &RunnerPreSpawnTiming) -> Self {
        Self {
            blank_pool_selection: timing.blank_pool_selection(),
        }
    }
}

struct ActivationFailureCompletion {
    telemetry: Option<JobTelemetry>,
}

impl ActivationFailureCompletion {
    async fn flush_telemetry(self) {
        if let Some(telemetry) = self.telemetry {
            telemetry.flush().await;
        }
    }
}

async fn complete_execution_failure(
    job: ExecutionJob,
    cancellation: RunCancellationRegistration,
    diagnostics: ActivationFailureDiagnostics,
    failure: crate::executor::ExecutionFailure,
    ctx: &SpawnContext,
) -> ActivationFailureCompletion {
    let (context, completion_auth, active_input_source) = job.into_parts();
    let run_id = context.run_id;
    drop(active_input_source);
    let telemetry = blank_pool_selection_telemetry(
        &context,
        diagnostics.blank_pool_selection,
        &ctx.exec_config,
    );
    ctx.provider
        .complete(
            CompleteRequest {
                run_id,
                exit_code: failure.exit_code,
                failure_reason: None,
                error: Some(failure.error),
                sandbox_id: None,
            },
            completion_auth,
        )
        .await;
    cancellation.unregister().await;
    ActivationFailureCompletion { telemetry }
}

pub(super) async fn build_spawn_job_request(
    activation: &mut JobActivationGuard,
    ctx: &SpawnContext,
) -> Result<SpawnJobRequest, JobActivationError> {
    prepare_spawn_job_request(activation, ctx).await?;
    finish_spawn_job_request(activation, ctx)
}

pub(super) async fn recover_unconsumed_finalizing_activation(
    request: FinalizingActivationRequest,
    blank_pool_selection: Option<BlankPoolSelection>,
    ctx: &AdmissionContext,
) {
    let FinalizingActivationRequest {
        job,
        cancellation,
        admission,
        ..
    } = request;
    warn!(run_id = %job.context().run_id, "admitted job lost its reactor owner; completing without sandbox");
    let completion = complete_execution_failure(
        job,
        cancellation,
        ActivationFailureDiagnostics {
            blank_pool_selection,
        },
        crate::executor::ExecutionFailure::cancelled(),
        &ctx.spawn_ctx,
    )
    .await;
    // Keep the finalizing predecessor proof owned through provider completion.
    drop(admission);
    completion.flush_telemetry().await;
}
