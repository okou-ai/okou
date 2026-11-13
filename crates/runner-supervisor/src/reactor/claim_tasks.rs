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
use super::job_discovery::{
    AdmissionContext, DiscoveredJob, DiscoveredJobContext, DiscoveredJobProfile,
    DiscoveredJobResult, SandboxAdmittedJob, prepare_admitted_job, prepare_discovered_job,
    prepare_job_profile,
};
use super::job_spawn::JobResult;
use crate::SharedFactory;
use crate::pre_claim_admission::{
    AdmittedClaim, PreClaimOutcome, PreClaimRequest, admit_and_claim,
};
use runner_provider::{JobCandidate, LocalJobSource};
use runner_types::ids::RunId;

// A conservative pressure bound, independent of stricter local resources.
// Activation/recovery and completed unconsumed results retain their original slot.
pub(super) const MAX_IN_FLIGHT_CLAIMS: usize = 4;

pub(super) struct ClaimTasks {
    context: Arc<AdmissionContext>,
    tasks: FuturesUnordered<JoinHandle<ClaimTaskResult>>,
    in_flight: HashSet<RunId>,
    preparing: Option<oneshot::Receiver<()>>,
    slots: Arc<Semaphore>,
}

impl ClaimTasks {
    pub(super) fn new(context: AdmissionContext) -> Self {
        Self {
            context: Arc::new(context),
            tasks: FuturesUnordered::new(),
            in_flight: HashSet::new(),
            preparing: None,
            slots: Arc::new(Semaphore::new(MAX_IN_FLIGHT_CLAIMS)),
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
        use crate::pre_claim_admission::{SuppliedAdmission, admit_supplied};
        let Some(supplied) = work.context.take() else {
            return;
        };
        let run_id = supplied.run_id;
        if self.in_flight.contains(&run_id) {
            return;
        }
        let candidate = JobCandidate::new(run_id, work.profile.clone())
            .with_reuse_key(supplied.reuse_key.clone());
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
                PreClaimRequest {
                    candidate,
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
                    prepare_claimed(*admission, profile, context).await
                }
                SuppliedAdmission::Rejected => {
                    work.settle(Disposition::Rejected);
                    ClaimTaskOutcome::Deferred
                }
                SuppliedAdmission::Unknown => ClaimTaskOutcome::Deferred,
            };
            ClaimTaskResult {
                run_id,
                outcome,

                _permit: work.permit.take(),
            }
        }));
    }

    pub(super) async fn progress(&mut self) -> Option<Result<ClaimTaskResult, JoinError>> {
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
        job: DiscoveredJob,
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
        let Some(job) = prepare_discovered_job(job, profiles, factories) else {
            return;
        };
        let Ok(permit) = self.slots.clone().try_acquire_owned() else {
            return;
        };
        self.in_flight.insert(run_id);
        let context = Arc::clone(&self.context);
        let (admission_ready, ready) = oneshot::channel();
        self.preparing = Some(ready);
        // Dropping the observer detaches accepted claim/activation work. Its
        // final guarded result owns recovery if Reactor disappears.
        self.tasks.push(tokio::spawn(async move {
            let resources = context.resources();
            let outcome = admit_and_claim(
                PreClaimRequest {
                    candidate: job.candidate,
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
                PreClaimOutcome::Claimed(admission) => {
                    prepare_claimed(*admission, job.profile, context).await
                }
                PreClaimOutcome::Deferred => ClaimTaskOutcome::Deferred,
            };
            ClaimTaskResult {
                run_id,
                outcome,

                _permit: Some(permit),
            }
        }));
    }

    pub(super) async fn next(&mut self) -> Option<Result<ClaimTaskResult, JoinError>> {
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
        result: Result<ClaimTaskResult, JoinError>,
        jobs: &mut JoinSet<JobResult>,
    ) -> Result<DiscoveredJobResult, ClaimConsumptionError> {
        let result = result.map_err(|_| ClaimConsumptionError::AdmissionTask)?;
        match result.outcome {
            ClaimTaskOutcome::Prepared(result) => (*result)
                .dispatch(&self.context.spawn_ctx, jobs)
                .map_err(ClaimConsumptionError::Ownership),
            ClaimTaskOutcome::Deferred => Ok(DiscoveredJobResult::completed(false)),
            ClaimTaskOutcome::Failed(error) => Err(ClaimConsumptionError::Ownership(error)),
            // Activation used to run inline: retain its existing recovery and
            // Reactor panic boundary rather than relabel it an admission error.
            ClaimTaskOutcome::Panicked(panic) => std::panic::resume_unwind(panic),
        }
    }
}

pub(super) enum ClaimConsumptionError {
    AdmissionTask,
    Ownership(ReactorError),
}

impl ClaimConsumptionError {
    pub(super) fn into_stopping_failure(self) -> (&'static str, ReactorError) {
        match self {
            Self::AdmissionTask => (
                "claim admission task failure",
                ReactorError::Internal("claim admission task failed".to_owned()),
            ),
            Self::Ownership(error) => ("claim result ownership failure", error),
        }
    }
}

pub(super) struct ClaimTaskResult {
    run_id: RunId,
    outcome: ClaimTaskOutcome,

    _permit: Option<OwnedSemaphorePermit>,
}

enum ClaimTaskOutcome {
    Prepared(Box<DiscoveredJobResult>),
    Deferred,
    Failed(ReactorError),
    Panicked(Box<dyn Any + Send>),
}

async fn prepare_claimed(
    admission: AdmittedClaim,
    profile: DiscoveredJobProfile,
    context: Arc<AdmissionContext>,
) -> ClaimTaskOutcome {
    let AdmittedClaim {
        claimed,
        resource,
        cancellation,
        claim_returned_at,
        blank_pool_selection,
    } = admission;
    let spawn_ctx = &context.spawn_ctx;
    let prepared = prepare_admitted_job(
        SandboxAdmittedJob {
            claimed,
            resource,
            cancellation,
            claim_returned_at,
            blank_pool_selection,
        },
        profile,
        DiscoveredJobContext {
            budget: &spawn_ctx.budget,
            idle_pool: &spawn_ctx.idle_pool,
            status: &spawn_ctx.status,
            mode_rx: &context.mode_rx,
            cancel_tokens: &context.cancel_tokens,
            spawn_ctx,
        },
    );
    match AssertUnwindSafe(prepared).catch_unwind().await {
        Ok(Ok(result)) => ClaimTaskOutcome::Prepared(Box::new(result)),
        Ok(Err(error)) => ClaimTaskOutcome::Failed(error),
        Err(panic) => ClaimTaskOutcome::Panicked(panic),
    }
}
