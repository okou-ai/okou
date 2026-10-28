//! Bounded independently scheduled admission, activation and guarded dispatch.

use std::any::Any;
use std::collections::{BTreeMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures_util::stream::FuturesUnordered;
use futures_util::{FutureExt, StreamExt};
use tokio::sync::oneshot;
use tokio::task::{JoinError, JoinHandle, JoinSet};
use tracing::info;

use super::RuntimeProfile;
use super::error::ReactorError;
use super::finalizing_claim::{FinalizingClaimRequest, spawn_finalizing_claim};
use super::job_discovery::{
    AdmissionContext, DiscoveredJob, DiscoveredJobContext, DiscoveredJobProfile,
    DiscoveredJobResult, SandboxAdmittedJob, prepare_admitted_job, prepare_discovered_job,
    recover_unconsumed_finalizing_claim,
};
use super::job_spawn::JobResult;
use super::peer_home_claim::{PeerHomeClaim, PeerHomeClaimRequest};
use crate::SharedFactory;
use crate::pre_claim_admission::{
    AdmittedClaim, AdmittedResource, PreClaimOutcome, PreClaimRequest, SandboxAdmittedResource,
    admit_and_claim,
};
use runner_executor::executor::BlankPoolSelection;
use runner_provider::JobCandidate;
use runner_types::ids::RunId;

// A conservative pressure bound, independent of stricter local resources.
// Activation/recovery and completed unconsumed results retain their original slot.
pub(super) const MAX_IN_FLIGHT_CLAIMS: usize = 4;

pub(super) struct ClaimTasks {
    context: Arc<AdmissionContext>,
    tasks: FuturesUnordered<JoinHandle<ClaimTaskResult>>,
    in_flight: HashSet<RunId>,
    preparing: Option<oneshot::Receiver<()>>,
}

impl ClaimTasks {
    pub(super) fn new(context: AdmissionContext) -> Self {
        Self {
            context: Arc::new(context),
            tasks: FuturesUnordered::new(),
            in_flight: HashSet::new(),
            preparing: None,
        }
    }

    pub(super) fn has_capacity(&self) -> bool {
        self.preparing.is_none() && self.tasks.len() < MAX_IN_FLIGHT_CLAIMS
    }

    pub(super) fn is_preparing(&self) -> bool {
        self.preparing.is_some()
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
                    home_disk_mb: job.profile.home_disk_mb,
                    device_rate_limits: &context.spawn_ctx.device_rate_limits,
                },
                &resources,
                admission_ready,
            )
            .await;
            let outcome = match outcome {
                PreClaimOutcome::Claimed(admission) => {
                    prepare_claimed(*admission, job.profile, context).await
                }
                PreClaimOutcome::Pending(candidate) => ClaimTaskOutcome::Pending(candidate),
                PreClaimOutcome::Deferred => ClaimTaskOutcome::Deferred,
            };
            ClaimTaskResult { run_id, outcome }
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
            ClaimTaskOutcome::Finalizing(claim) => {
                let request = (*claim)
                    .into_request()
                    .map_err(ClaimConsumptionError::Ownership)?;
                spawn_finalizing_claim(request, &self.context.spawn_ctx, jobs);
                Ok(DiscoveredJobResult::completed(false))
            }
            ClaimTaskOutcome::PeerHome(claim) => {
                jobs.spawn((*claim).run(self.context.spawn_ctx.clone()));
                Ok(DiscoveredJobResult::completed(false))
            }
            ClaimTaskOutcome::Pending(candidate) => Ok(DiscoveredJobResult::pending(*candidate)),
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
}

enum ClaimTaskOutcome {
    Prepared(Box<DiscoveredJobResult>),
    Finalizing(Box<UnconsumedFinalizingClaim>),
    PeerHome(Box<PeerHomeClaim>),
    Pending(Box<JobCandidate>),
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
        home_source_run_id,
        claimed,
        resource,
        cancellation,
        claim_returned_at,
        blank_pool_selection,
    } = admission;
    let resource = match resource {
        AdmittedResource::PeerHome {
            lease,
            deadline,
            source_run_id,
        } => {
            return ClaimTaskOutcome::PeerHome(Box::new(PeerHomeClaim::new(
                PeerHomeClaimRequest {
                    source_run_id,
                    claimed,
                    cancellation,
                    lease,
                    deadline,
                    claim_returned_at,
                    blank_pool_selection,
                    profile,
                },
                &context.spawn_ctx,
            )));
        }
        AdmittedResource::Finalizing(admission) => {
            let DiscoveredJobProfile {
                profile_name,
                rootfs_hash,
                vcpu,
                memory_mb,
                home_disk_mb,
                restore_guest_state,
                factory,
            } = profile;
            return ClaimTaskOutcome::Finalizing(Box::new(UnconsumedFinalizingClaim {
                request: Some(FinalizingClaimRequest {
                    claimed,
                    cancellation,
                    admission,
                    claim_returned_at,
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
        AdmittedResource::ExactSpeculation(speculation) => {
            SandboxAdmittedResource::ExactSpeculation(speculation)
        }
    };
    let spawn_ctx = &context.spawn_ctx;
    let prepared = prepare_admitted_job(
        SandboxAdmittedJob {
            home_source_run_id,
            claimed,
            resource,
            cancellation,
            claim_returned_at,
            blank_pool_selection,
        },
        profile,
        DiscoveredJobContext {
            runner_identity: context.runner_identity,
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

struct UnconsumedFinalizingClaim {
    request: Option<FinalizingClaimRequest>,
    blank_pool_selection: Option<BlankPoolSelection>,
    context: Arc<AdmissionContext>,
}

impl UnconsumedFinalizingClaim {
    fn into_request(mut self) -> Result<FinalizingClaimRequest, ReactorError> {
        self.request.take().ok_or_else(|| {
            ReactorError::Internal("finalizing result lost its admission before handoff".to_owned())
        })
    }
}

impl Drop for UnconsumedFinalizingClaim {
    fn drop(&mut self) {
        let Some(request) = self.request.take() else {
            return;
        };
        let blank_pool_selection = self.blank_pool_selection;
        let context = Arc::clone(&self.context);
        let cleanup = context.spawn_ctx.idle_destroy_tracker.clone();
        cleanup.spawn_cleanup(
            async move {
                recover_unconsumed_finalizing_claim(request, blank_pool_selection, &context).await;
            },
            "unconsumed_finalizing_claim",
        );
    }
}
