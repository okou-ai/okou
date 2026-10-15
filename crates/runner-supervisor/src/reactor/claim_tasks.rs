//! Bounded independently scheduled admission/claim and guarded result handoff.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use futures_util::StreamExt;
use futures_util::stream::FuturesUnordered;
use tokio::sync::oneshot;
use tokio::task::{JoinError, JoinHandle, JoinSet};
use tracing::info;

use super::RuntimeProfile;
use super::error::{ReactorError, ReactorResult};
use super::job_discovery::{
    AdmissionContext, DiscoveredJob, DiscoveredJobContext, DiscoveredJobProfile,
    DiscoveredJobResult, handle_admitted_job, prepare_discovered_job, recover_unconsumed_admission,
};
use crate::SharedFactory;
use crate::pre_claim_admission::{
    AdmittedClaim, PreClaimOutcome, PreClaimRequest, admit_and_claim,
};
use runner_provider::{JobCandidate, RunCancellationRegistration};
use runner_types::ids::RunId;

// A conservative request-pressure bound, independent of the stricter local
// resource budget. Completed results occupy a slot until Reactor consumes them.
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
                    // An early rejection drops the sender and also opens the gate.
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
        // JoinHandle drop detaches rather than aborts this transaction. Its
        // successful output owns recovery if Reactor disappears before handoff.
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
                PreClaimOutcome::Claimed(admission) => ClaimTaskOutcome::Claimed(UnconsumedClaim {
                    admission: Some(admission),
                    context,
                    home_disk_mb: job.profile.home_disk_mb,
                }),
                PreClaimOutcome::Pending(candidate) => ClaimTaskOutcome::Pending(candidate),
                PreClaimOutcome::Deferred => ClaimTaskOutcome::Deferred,
            };
            ClaimTaskResult {
                run_id,
                profile: job.profile,
                outcome,
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

    // Share handoff and failure classification, leaving runtime continuation,
    // pending candidates and teardown's first-error policy with their callers.
    pub(super) async fn consume(
        &self,
        result: Result<ClaimTaskResult, JoinError>,
        jobs: &mut JoinSet<RunCancellationRegistration>,
    ) -> Result<DiscoveredJobResult, ClaimConsumptionError> {
        let result = result.map_err(|_| ClaimConsumptionError::AdmissionTask)?;
        let context = &self.context;
        let spawn_ctx = &context.spawn_ctx;
        result
            .handle(DiscoveredJobContext {
                runner_identity: context.runner_identity,
                budget: &spawn_ctx.budget,
                idle_pool: &spawn_ctx.idle_pool,
                status: &spawn_ctx.status,
                mode_rx: &context.mode_rx,
                cancel_tokens: &context.cancel_tokens,
                spawn_ctx,
                jobs,
            })
            .await
            .map_err(ClaimConsumptionError::Ownership)
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
    profile: DiscoveredJobProfile,
    outcome: ClaimTaskOutcome,
}

enum ClaimTaskOutcome {
    Claimed(UnconsumedClaim),
    Pending(Box<JobCandidate>),
    Deferred,
}

impl ClaimTaskResult {
    pub(super) async fn handle(
        self,
        context: DiscoveredJobContext<'_>,
    ) -> ReactorResult<DiscoveredJobResult> {
        Ok(match self.outcome {
            ClaimTaskOutcome::Claimed(claim) => {
                handle_admitted_job(claim.into_admission()?, self.profile, context).await
            }
            ClaimTaskOutcome::Pending(candidate) => DiscoveredJobResult::pending(*candidate),
            ClaimTaskOutcome::Deferred => DiscoveredJobResult::completed(false),
        })
    }
}

struct UnconsumedClaim {
    admission: Option<Box<AdmittedClaim>>,
    context: Arc<AdmissionContext>,
    home_disk_mb: u32,
}

impl UnconsumedClaim {
    fn into_admission(mut self) -> ReactorResult<AdmittedClaim> {
        // This guard is consumed by value; only this handoff or Drop can take
        // the admission. Surface a broken invariant rather than fabricating an
        // unclaimed result or adding a production panic.
        self.admission
            .take()
            .map(|admission| *admission)
            .ok_or_else(|| {
                ReactorError::Internal("claim result lost its admission before handoff".to_owned())
            })
    }
}

impl Drop for UnconsumedClaim {
    fn drop(&mut self) {
        let Some(admission) = self.admission.take() else {
            return;
        };
        let context = Arc::clone(&self.context);
        let cleanup = context.spawn_ctx.idle_destroy_tracker.clone();
        let home_disk_mb = self.home_disk_mb;
        cleanup.spawn_cleanup(
            async move {
                recover_unconsumed_admission(*admission, home_disk_mb, &context).await;
            },
            "unconsumed_claim",
        );
    }
}
