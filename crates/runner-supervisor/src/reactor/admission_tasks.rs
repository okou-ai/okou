//! Bounded independently scheduled admission, activation and guarded dispatch.

use std::any::Any;
use std::collections::{BTreeMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures_util::stream::FuturesUnordered;
use futures_util::{FutureExt, StreamExt};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot};
use tokio::task::{JoinError, JoinHandle, JoinSet};
use tracing::info;

use super::RuntimeProfile;
use super::error::ReactorError;
use super::finalizing_activation::{FinalizingActivationRequest, spawn_finalizing_activation};
use super::job_activation::recover_unconsumed_finalizing_activation;
use super::job_activation::{
    AdmissionContext, ExecutionProfile, JobActivationContext, JobActivationResult, LocalJob,
    SandboxAdmittedJob, prepare_admitted_job, prepare_job_profile, prepare_local_job,
};
use super::job_spawn::JobResult;
use crate::SharedFactory;
use crate::executor::BlankPoolSelection;
use crate::resource_admission::{
    AdmissionRequest, AdmittedJob, AdmittedResource, LocalAdmissionOutcome,
    SandboxAdmittedResource, admit_and_claim,
};
use runner_provider::LocalJobSource;
use runner_types::ids::RunId;

// A conservative pressure bound, independent of stricter local resources.
// Activation/recovery and completed unconsumed results retain their original slot.
pub(super) const MAX_IN_FLIGHT_ADMISSIONS: usize = 4;

pub(super) struct AdmissionTasks {
    context: Arc<AdmissionContext>,
    tasks: FuturesUnordered<JoinHandle<AdmissionTaskResult>>,
    in_flight: HashSet<RunId>,
    preparing: Option<oneshot::Receiver<()>>,
    slots: Arc<Semaphore>,
}

impl AdmissionTasks {
    pub(super) fn new(context: AdmissionContext) -> Self {
        Self {
            context: Arc::new(context),
            tasks: FuturesUnordered::new(),
            in_flight: HashSet::new(),
            preparing: None,
            slots: Arc::new(Semaphore::new(MAX_IN_FLIGHT_ADMISSIONS)),
        }
    }

    pub(super) fn has_capacity(&self) -> bool {
        self.preparing.is_none() && self.slots.available_permits() > 0
    }

    pub(super) fn is_preparing(&self) -> bool {
        self.preparing.is_some()
    }

    pub(super) fn slots(&self) -> Arc<Semaphore> {
        self.slots.clone()
    }

    pub(super) fn submit_supplied(
        &mut self,
        mut work: crate::ingress::dispatch::DispatchWork,
        profiles: &BTreeMap<String, RuntimeProfile>,
        factories: &BTreeMap<String, (SharedFactory, bool)>,
    ) {
        use crate::ingress::dispatch::Disposition;
        use crate::resource_admission::{SuppliedAdmission, admit_supplied};
        let Some(supplied) = work.context.take() else {
            return;
        };
        let run_id = supplied.run_id;
        if self.in_flight.contains(&run_id) {
            return;
        }
        let Some(profile) = prepare_job_profile(&work.profile, profiles, factories) else {
            work.settle(Disposition::Rejected);
            return;
        };
        self.in_flight.insert(run_id);
        let context = self.context.clone();
        let (admission_ready, ready) = oneshot::channel();
        self.preparing = Some(ready);
        self.tasks.push(tokio::spawn(async move {
            let admission = admit_supplied(
                supplied,
                AdmissionRequest {
                    profile_name: &profile.profile_name,
                    job_vcpu: profile.vcpu,
                    job_memory: profile.memory_mb,
                    device_rate_limits: &context.spawn_ctx.device_rate_limits,
                },
                work.deadline,
                &context.resources(),
                admission_ready,
            )
            .await;
            let outcome = match admission {
                SuppliedAdmission::Admitted(admission) => {
                    work.settle(Disposition::Accepted);
                    prepare_admitted(*admission, profile, context).await
                }
                SuppliedAdmission::Rejected => {
                    work.settle(Disposition::Rejected);
                    AdmissionTaskOutcome::Deferred
                }
                SuppliedAdmission::Unknown => AdmissionTaskOutcome::Deferred,
            };
            AdmissionTaskResult {
                run_id,
                outcome,

                _permit: work.permit.take(),
            }
        }));
    }

    pub(super) async fn progress(&mut self) -> Option<Result<AdmissionTaskResult, JoinError>> {
        let preparing = self.is_preparing();
        tokio::select! {
            result = self.tasks.next(), if !self.tasks.is_empty() => {
                let result = result?;
                if let Ok(result) = &result {
                    self.in_flight.remove(&result.run_id);
                }
                Some(result)
            }
            () = async {
                if let Some(ready) = &mut self.preparing {
                    let _ = ready.await;
                }
            }, if preparing => {
                self.preparing = None;
                None
            }
        }
    }

    pub(super) fn is_empty(&self) -> bool {
        self.tasks.is_empty()
    }

    pub(super) fn submit(
        &mut self,
        job: LocalJob,
        profiles: &BTreeMap<String, RuntimeProfile>,
        factories: &BTreeMap<String, (SharedFactory, bool)>,
        source: Arc<dyn LocalJobSource>,
    ) {
        if !self.has_capacity() {
            return;
        }
        let run_id = job.candidate.run_id();
        if self.in_flight.contains(&run_id) {
            info!(%run_id, "duplicate candidate already has an in-flight admission");
            return;
        }
        let Some(job) = prepare_local_job(job, profiles, factories) else {
            return;
        };
        let Ok(permit) = self.slots.clone().try_acquire_owned() else {
            return;
        };
        self.in_flight.insert(run_id);
        let context = Arc::clone(&self.context);
        let (admission_ready, ready) = oneshot::channel();
        self.preparing = Some(ready);
        // Dropping the observer detaches accepted admission/activation work. Its
        // final guarded result owns recovery if Reactor disappears.
        self.tasks.push(tokio::spawn(async move {
            let resources = context.resources();
            let outcome = admit_and_claim(
                job.candidate,
                AdmissionRequest {
                    profile_name: &job.profile.profile_name,
                    job_vcpu: job.profile.vcpu,
                    job_memory: job.profile.memory_mb,
                    device_rate_limits: &context.spawn_ctx.device_rate_limits,
                },
                source.as_ref(),
                &resources,
                admission_ready,
            )
            .await;
            let outcome = match outcome {
                LocalAdmissionOutcome::Admitted(admission) => {
                    prepare_admitted(*admission, job.profile, context).await
                }
                LocalAdmissionOutcome::Deferred => AdmissionTaskOutcome::Deferred,
            };
            AdmissionTaskResult {
                run_id,
                outcome,

                _permit: Some(permit),
            }
        }));
    }

    pub(super) async fn next(&mut self) -> Option<Result<AdmissionTaskResult, JoinError>> {
        let result = self.tasks.next().await?;
        if let Ok(result) = &result {
            self.in_flight.remove(&result.run_id);
        }
        Some(result)
    }

    // Acceptance and dispatch are synchronous; every fallible activation or
    // recovery await remains owned by the bounded independently scheduled task.
    pub(super) fn consume(
        &self,
        result: Result<AdmissionTaskResult, JoinError>,
        jobs: &mut JoinSet<JobResult>,
    ) -> Result<JobActivationResult, AdmissionConsumptionError> {
        let result = result.map_err(|_| AdmissionConsumptionError::AdmissionTask)?;
        match result.outcome {
            AdmissionTaskOutcome::Prepared(result) => (*result)
                .dispatch(&self.context.spawn_ctx, jobs)
                .map_err(AdmissionConsumptionError::Ownership),
            AdmissionTaskOutcome::Finalizing(admission) => {
                spawn_finalizing_activation(
                    (*admission)
                        .into_request()
                        .map_err(AdmissionConsumptionError::Ownership)?,
                    &self.context.spawn_ctx,
                    jobs,
                );
                Ok(JobActivationResult::completed(false))
            }
            AdmissionTaskOutcome::Deferred => Ok(JobActivationResult::completed(false)),
            AdmissionTaskOutcome::Failed(error) => Err(AdmissionConsumptionError::Ownership(error)),
            // Activation used to run inline: retain its existing recovery and
            // Reactor panic boundary rather than relabel it an admission error.
            AdmissionTaskOutcome::Panicked(panic) => std::panic::resume_unwind(panic),
        }
    }
}

pub(super) enum AdmissionConsumptionError {
    AdmissionTask,
    Ownership(ReactorError),
}

impl AdmissionConsumptionError {
    pub(super) fn into_stopping_failure(self) -> (&'static str, ReactorError) {
        match self {
            Self::AdmissionTask => (
                "job admission task failure",
                ReactorError::Internal("job admission task failed".to_owned()),
            ),
            Self::Ownership(error) => ("admission result ownership failure", error),
        }
    }
}

pub(super) struct AdmissionTaskResult {
    run_id: RunId,
    outcome: AdmissionTaskOutcome,

    _permit: Option<OwnedSemaphorePermit>,
}

enum AdmissionTaskOutcome {
    Finalizing(Box<UnconsumedFinalizingActivation>),
    Prepared(Box<JobActivationResult>),
    Deferred,
    Failed(ReactorError),
    Panicked(Box<dyn Any + Send>),
}

async fn prepare_admitted(
    admission: AdmittedJob,
    profile: ExecutionProfile,
    context: Arc<AdmissionContext>,
) -> AdmissionTaskOutcome {
    let AdmittedJob {
        job,
        resource,
        cancellation,
        admitted_at,
        blank_pool_selection,
    } = admission;
    let resource = match resource {
        AdmittedResource::Finalizing(admission) => {
            let ExecutionProfile {
                profile_name,
                rootfs_hash,
                vcpu,
                memory_mb,
                home_disk_mb,
                restore_guest_state,
                factory,
            } = profile;
            return AdmissionTaskOutcome::Finalizing(Box::new(UnconsumedFinalizingActivation {
                request: Some(FinalizingActivationRequest {
                    job,
                    cancellation,
                    admission,
                    admitted_at,
                    profile_name,
                    rootfs_hash,
                    vcpu,
                    memory_mb,
                    home_disk_mb,
                    restore_guest_state,
                    device_rate_limits: context.spawn_ctx.device_rate_limits.clone(),
                    factory,
                }),
                blank_pool_selection,
                context,
            }));
        }
        AdmittedResource::Fresh(lease) => SandboxAdmittedResource::Fresh(lease),
        AdmittedResource::Reusable(reservation) => SandboxAdmittedResource::Reusable(reservation),
    };
    let spawn_ctx = &context.spawn_ctx;
    let prepared = prepare_admitted_job(
        SandboxAdmittedJob {
            job,
            resource,
            cancellation,
            admitted_at,
            blank_pool_selection,
        },
        profile,
        JobActivationContext {
            budget: &spawn_ctx.budget,
            idle_pool: &spawn_ctx.idle_pool,
            status: &spawn_ctx.status,
            mode_rx: &context.mode_rx,
            cancel_tokens: &context.cancel_tokens,
            spawn_ctx,
        },
    );
    match AssertUnwindSafe(prepared).catch_unwind().await {
        Ok(Ok(result)) => AdmissionTaskOutcome::Prepared(Box::new(result)),
        Ok(Err(error)) => AdmissionTaskOutcome::Failed(error),
        Err(panic) => AdmissionTaskOutcome::Panicked(panic),
    }
}

struct UnconsumedFinalizingActivation {
    request: Option<FinalizingActivationRequest>,
    blank_pool_selection: Option<BlankPoolSelection>,
    context: Arc<AdmissionContext>,
}

impl UnconsumedFinalizingActivation {
    fn into_request(mut self) -> Result<FinalizingActivationRequest, ReactorError> {
        self.request.take().ok_or_else(|| {
            ReactorError::Internal("finalizing result lost its admission before handoff".to_owned())
        })
    }
}

impl Drop for UnconsumedFinalizingActivation {
    fn drop(&mut self) {
        let Some(request) = self.request.take() else {
            return;
        };
        let blank_pool_selection = self.blank_pool_selection;
        let context = Arc::clone(&self.context);
        let cleanup = context.spawn_ctx.idle_destroy_tracker.clone();
        cleanup.spawn_cleanup(
            async move {
                recover_unconsumed_finalizing_activation(request, blank_pool_selection, &context)
                    .await;
            },
            "unconsumed_finalizing_activation",
        );
    }
}
