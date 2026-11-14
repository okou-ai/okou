//! Bounded independently scheduled acceptance, activation and guarded dispatch.

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
    AcceptanceContext, ExecutionProfile, JobActivationContext, JobActivationResult, LocalJob,
    SandboxAcceptedJob, prepare_accepted_job, prepare_job_profile, prepare_local_job,
};
use super::job_spawn::JobResult;
use crate::SharedFactory;
use crate::executor::BlankPoolSelection;
use crate::job_acceptance::{
    AcceptanceRequest, AcceptedJob, AcceptedResource, LocalAcceptanceOutcome,
    SandboxAcceptedResource, accept_and_claim,
};
use runner_provider::LocalJobSource;
use runner_types::ids::RunId;

// A conservative pressure bound, independent of stricter local resources.
// Activation/recovery and completed unconsumed results retain their original slot.
pub(super) const MAX_IN_FLIGHT_ACCEPTANCES: usize = 4;

pub(super) struct AcceptanceTasks {
    context: Arc<AcceptanceContext>,
    tasks: FuturesUnordered<JoinHandle<AcceptanceTaskResult>>,
    in_flight: HashSet<RunId>,
    preparing: Option<oneshot::Receiver<()>>,
    slots: Arc<Semaphore>,
}

impl AcceptanceTasks {
    pub(super) fn new(context: AcceptanceContext) -> Self {
        Self {
            context: Arc::new(context),
            tasks: FuturesUnordered::new(),
            in_flight: HashSet::new(),
            preparing: None,
            slots: Arc::new(Semaphore::new(MAX_IN_FLIGHT_ACCEPTANCES)),
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
        use crate::job_acceptance::{SuppliedAcceptance, accept_supplied};
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
        let (acceptance_ready, ready) = oneshot::channel();
        self.preparing = Some(ready);
        self.tasks.push(tokio::spawn(async move {
            let acceptance = accept_supplied(
                supplied,
                AcceptanceRequest {
                    profile_name: &profile.profile_name,
                    job_vcpu: profile.vcpu,
                    job_memory: profile.memory_mb,
                    device_rate_limits: &context.spawn_ctx.device_rate_limits,
                },
                work.deadline,
                &context.resources(),
                acceptance_ready,
            )
            .await;
            let outcome = match acceptance {
                SuppliedAcceptance::Accepted(acceptance) => {
                    work.settle(Disposition::Accepted);
                    prepare_accepted(*acceptance, profile, context).await
                }
                SuppliedAcceptance::Rejected => {
                    work.settle(Disposition::Rejected);
                    AcceptanceTaskOutcome::Deferred
                }
                SuppliedAcceptance::Unknown => AcceptanceTaskOutcome::Deferred,
            };
            AcceptanceTaskResult {
                run_id,
                outcome,
                _permit: work.permit.take(),
            }
        }));
    }

    pub(super) async fn progress(&mut self) -> Option<Result<AcceptanceTaskResult, JoinError>> {
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
            info!(%run_id, "duplicate candidate already has an in-flight acceptance");
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
        let (acceptance_ready, ready) = oneshot::channel();
        self.preparing = Some(ready);
        // Dropping the observer detaches in-flight acceptance/activation work. Its
        // final guarded result owns recovery if Reactor disappears.
        self.tasks.push(tokio::spawn(async move {
            let resources = context.resources();
            let outcome = accept_and_claim(
                job.candidate,
                AcceptanceRequest {
                    profile_name: &job.profile.profile_name,
                    job_vcpu: job.profile.vcpu,
                    job_memory: job.profile.memory_mb,
                    device_rate_limits: &context.spawn_ctx.device_rate_limits,
                },
                source.as_ref(),
                &resources,
                acceptance_ready,
            )
            .await;
            let outcome = match outcome {
                LocalAcceptanceOutcome::Accepted(acceptance) => {
                    prepare_accepted(*acceptance, job.profile, context).await
                }
                LocalAcceptanceOutcome::Deferred => AcceptanceTaskOutcome::Deferred,
            };
            AcceptanceTaskResult {
                run_id,
                outcome,
                _permit: Some(permit),
            }
        }));
    }

    pub(super) async fn next(&mut self) -> Option<Result<AcceptanceTaskResult, JoinError>> {
        let result = self.tasks.next().await?;
        if let Ok(result) = &result {
            self.in_flight.remove(&result.run_id);
        }
        Some(result)
    }

    // Result consumption and dispatch are synchronous; every fallible activation or
    // recovery await remains owned by the bounded independently scheduled task.
    pub(super) fn consume(
        &self,
        result: Result<AcceptanceTaskResult, JoinError>,
        jobs: &mut JoinSet<JobResult>,
    ) -> Result<JobActivationResult, AcceptanceConsumptionError> {
        let result = result.map_err(|_| AcceptanceConsumptionError::AcceptanceTask)?;
        match result.outcome {
            AcceptanceTaskOutcome::Prepared(result) => (*result)
                .dispatch(&self.context.spawn_ctx, jobs)
                .map_err(AcceptanceConsumptionError::Ownership),
            AcceptanceTaskOutcome::Finalizing(acceptance) => {
                spawn_finalizing_activation(
                    (*acceptance)
                        .into_request()
                        .map_err(AcceptanceConsumptionError::Ownership)?,
                    &self.context.spawn_ctx,
                    jobs,
                );
                Ok(JobActivationResult::completed(false))
            }
            AcceptanceTaskOutcome::Deferred => Ok(JobActivationResult::completed(false)),
            AcceptanceTaskOutcome::Failed(error) => {
                Err(AcceptanceConsumptionError::Ownership(error))
            }
            // Activation retains its own recovery and Reactor panic boundary.
            AcceptanceTaskOutcome::Panicked(panic) => std::panic::resume_unwind(panic),
        }
    }
}

pub(super) enum AcceptanceConsumptionError {
    AcceptanceTask,
    Ownership(ReactorError),
}

impl AcceptanceConsumptionError {
    pub(super) fn into_stopping_failure(self) -> (&'static str, ReactorError) {
        match self {
            Self::AcceptanceTask => (
                "job acceptance task failure",
                ReactorError::Internal("job acceptance task failed".to_owned()),
            ),
            Self::Ownership(error) => ("acceptance result ownership failure", error),
        }
    }
}

pub(super) struct AcceptanceTaskResult {
    run_id: RunId,
    outcome: AcceptanceTaskOutcome,
    _permit: Option<OwnedSemaphorePermit>,
}

enum AcceptanceTaskOutcome {
    Finalizing(Box<UnconsumedFinalizingActivation>),
    Prepared(Box<JobActivationResult>),
    Deferred,
    Failed(ReactorError),
    Panicked(Box<dyn Any + Send>),
}

async fn prepare_accepted(
    acceptance: AcceptedJob,
    profile: ExecutionProfile,
    context: Arc<AcceptanceContext>,
) -> AcceptanceTaskOutcome {
    let AcceptedJob {
        job,
        resource,
        cancellation,
        accepted_at,
        blank_pool_selection,
    } = acceptance;
    let resource = match resource {
        AcceptedResource::Finalizing(handoff_context) => {
            let ExecutionProfile {
                profile_name,
                rootfs_hash,
                vcpu,
                memory_mb,
                home_disk_mb,
                restore_guest_state,
                factory,
            } = profile;
            return AcceptanceTaskOutcome::Finalizing(Box::new(UnconsumedFinalizingActivation {
                request: Some(FinalizingActivationRequest {
                    job,
                    cancellation,
                    handoff_context,
                    accepted_at,
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
        AcceptedResource::Fresh(lease) => SandboxAcceptedResource::Fresh(lease),
        AcceptedResource::Reusable(reservation) => SandboxAcceptedResource::Reusable(reservation),
    };
    let spawn_ctx = &context.spawn_ctx;
    let prepared = prepare_accepted_job(
        SandboxAcceptedJob {
            job,
            resource,
            cancellation,
            accepted_at,
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
        Ok(Ok(result)) => AcceptanceTaskOutcome::Prepared(Box::new(result)),
        Ok(Err(error)) => AcceptanceTaskOutcome::Failed(error),
        Err(panic) => AcceptanceTaskOutcome::Panicked(panic),
    }
}

struct UnconsumedFinalizingActivation {
    request: Option<FinalizingActivationRequest>,
    blank_pool_selection: Option<BlankPoolSelection>,
    context: Arc<AcceptanceContext>,
}

impl UnconsumedFinalizingActivation {
    fn into_request(mut self) -> Result<FinalizingActivationRequest, ReactorError> {
        self.request.take().ok_or_else(|| {
            ReactorError::Internal(
                "finalizing result lost its acceptance before handoff".to_owned(),
            )
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
