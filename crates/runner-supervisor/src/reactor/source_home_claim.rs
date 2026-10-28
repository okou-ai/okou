//! Source Home publication waiting, independently of expired routing advice.
//!
//! The existing activation guard owns the claim, cancellation and local ordinary
//! capacity from the RPC result through this owned job and executor handoff.

use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use futures_util::FutureExt;
use runner_lifecycle::home_image_cache::HomeCacheProbe;
use runner_provider::{ClaimedJob, RunCancellationRegistration};
use runner_types::ids::RunId;
use tracing::{info, warn};

use super::job_discovery::{
    DiscoveredJobProfile, build_spawn_job_request, claimed_activation_resources,
};
use super::job_spawn::{JobResult, SpawnContext, run_job};
use crate::claimed_activation::{
    ClaimedActivationError, ClaimedActivationGuard, ClaimedJobSetup, ReadyClaimedResource,
};
use crate::executor::{
    BlankPoolSelection, PeerHomeWaitOutcome, RunnerPreSpawnTiming, validate_resume_session_id,
};
use crate::resource_budget::BudgetLease;
use runner_types::types::SandboxReuseResult;

const HOME_RECHECK_INITIAL_DELAY: Duration = Duration::from_millis(50);
const HOME_RECHECK_MAX_DELAY: Duration = Duration::from_secs(1);

pub(super) struct SourceHomeClaimRequest {
    pub(super) source_run_id: RunId,
    pub(super) claimed: ClaimedJob,
    pub(super) cancellation: RunCancellationRegistration,
    pub(super) lease: BudgetLease,
    pub(super) deadline: Instant,
    pub(super) claim_returned_at: Instant,
    pub(super) blank_pool_selection: Option<BlankPoolSelection>,
    pub(super) profile: DiscoveredJobProfile,
}

pub(super) struct SourceHomeClaim {
    source_run_id: RunId,
    activation: ClaimedActivationGuard,
    deadline: Instant,
}

impl SourceHomeClaim {
    pub(super) fn new(request: SourceHomeClaimRequest, ctx: &SpawnContext) -> Self {
        let SourceHomeClaimRequest {
            source_run_id,
            claimed,
            cancellation,
            lease,
            deadline,
            claim_returned_at,
            blank_pool_selection,
            profile,
        } = request;
        let run_id = claimed.context().run_id;
        let active_run_guard = ctx.active_runs.register(
            run_id,
            claimed.context().reuse_key().map(str::to_owned),
            profile.profile_name.clone(),
        );
        let mut timing = RunnerPreSpawnTiming::start_at(
            claim_returned_at,
            claimed.api_claim_timing(),
            &ctx.pre_spawn_concurrency,
        );
        timing.mark_task_enqueued();
        if let Some(selection) = blank_pool_selection {
            timing.record_blank_pool_selection(selection);
        }
        Self {
            source_run_id,
            activation: ClaimedActivationGuard::new(
                ClaimedJobSetup {
                    home_source_run_id: None,
                    claimed,
                    cancellation,
                    rootfs_hash: profile.rootfs_hash,
                    profile_name: profile.profile_name,
                    vcpu: profile.vcpu,
                    memory_mb: profile.memory_mb,
                    home_disk_mb: profile.home_disk_mb,
                    restore_guest_state: profile.restore_guest_state,
                    device_rate_limits: ctx.device_rate_limits.clone(),
                    factory: profile.factory,
                    resource: ReadyClaimedResource {
                        reuse_entry: None,
                        active_lease: lease,
                        reuse_result: SandboxReuseResult::PoolMiss,
                        idle_snapshot: None,
                    },
                    pre_spawn_timing: timing,
                    active_run_guard,
                },
                claimed_activation_resources(ctx),
            ),
            deadline,
        }
    }

    pub(super) async fn run(mut self, ctx: SpawnContext) -> JobResult {
        let setup = self.activation.setup()?;
        if let Err(error) = validate_resume_session_id(setup.claimed.context()) {
            return Ok(self
                .activation
                .recover("invalid_resume_session", error.to_string())
                .await?
                .into_cancellation()
                .await);
        }
        let started_at = Instant::now();
        let (home_source_run_id, outcome) = match self.wait_for_home(&ctx).await {
            Ok(result) => result,
            Err(error) => {
                return Ok(self
                    .activation
                    .recover(error.recovery_reason(), error.to_string())
                    .await?
                    .into_cancellation()
                    .await);
            }
        };
        let setup = self.activation.setup()?;
        let elapsed = started_at.elapsed();
        info!(
            run_id = %setup.claimed.context().run_id,
            source_run_id = %self.source_run_id,
            outcome = outcome.as_str(),
            elapsed_ms = elapsed.as_millis(),
            "claimed source Home wait completed"
        );
        setup
            .pre_spawn_timing
            .record_peer_home_wait(elapsed, outcome);
        if setup.cancellation.handle().is_cancelled() {
            return Ok(self
                .activation
                .recover_cancelled()
                .await?
                .into_cancellation()
                .await);
        }
        // The same lease remains owned on expiry. Ordinary execution still
        // validates/locks checkout and may start without the source image.
        let prepared = AssertUnwindSafe(build_spawn_job_request(&mut self.activation, &ctx))
            .catch_unwind()
            .await;
        let mut request = match prepared {
            Ok(Ok(request)) => request,
            Ok(Err(error)) => {
                return Ok(self
                    .activation
                    .recover(error.recovery_reason(), error.to_string())
                    .await?
                    .into_cancellation()
                    .await);
            }
            Err(panic) => {
                self.activation
                    .recover(
                        "source_home_activation_panicked",
                        "source Home activation panicked".into(),
                    )
                    .await?
                    .finish()
                    .await;
                std::panic::resume_unwind(panic);
            }
        };
        request.job_profile.home_source_run_id = home_source_run_id;
        // Routing/publication expiry does not erase this claim's accepted
        // local hint. Keep ordinary checkout's existing short contention policy.
        request.job_profile.home_image_prepare_policy =
            crate::home_image_cache::HomeImagePreparePolicy::WaitForTransientContention;
        Ok(run_job(request, ctx).await)
    }

    async fn wait_for_home(
        &mut self,
        ctx: &SpawnContext,
    ) -> Result<(Option<RunId>, PeerHomeWaitOutcome), ClaimedActivationError> {
        let Some(cache) = ctx.exec_config.home_cache.as_ref() else {
            return Ok((None, PeerHomeWaitOutcome::Unavailable));
        };
        let setup = self.activation.setup()?;
        let Some(reuse_key) = setup.claimed.context().reuse_key().map(str::to_owned) else {
            return Ok((None, PeerHomeWaitOutcome::Unavailable));
        };
        let run_id = setup.claimed.context().run_id;
        let profile = setup.profile_name.clone();
        let image_size_bytes = u64::from(setup.home_disk_mb) * 1024 * 1024;
        let cancelled = setup.cancellation.handle().token();
        let mut committed = ctx.home_cache_snapshot.subscribe_committed();
        let deadline = tokio::time::Instant::from_std(self.deadline);
        let mut recheck_delay = HOME_RECHECK_INITIAL_DELAY;
        let mut recheck_at = tokio::time::Instant::now();
        loop {
            if cancelled.is_cancelled() {
                return Ok((None, PeerHomeWaitOutcome::Cancelled));
            }
            if ctx.home_cache_snapshot.contains_source_home(
                &reuse_key,
                &profile,
                self.source_run_id,
            ) {
                return Ok((Some(self.source_run_id), PeerHomeWaitOutcome::SnapshotReady));
            }
            tokio::select! {
                biased;
                () = cancelled.cancelled() => return Ok((None, PeerHomeWaitOutcome::Cancelled)),
                () = tokio::time::sleep_until(deadline) => return Ok((None, PeerHomeWaitOutcome::PreferenceExpired)),
                () = tokio::time::sleep_until(recheck_at) => {
                    // The claimed job owns this read through completion. Busy
                    // never blocks on a predecessor and a positive observation
                    // still requires ordinary source-bound locked checkout.
                    let observed = cache.probe_home(
                        &reuse_key,
                        &profile,
                        image_size_bytes,
                        Some(self.source_run_id),
                    ).await;
                    #[cfg(test)]
                    ctx.test_observer.record(super::StartLoopEvent::SourceHomeRecheckCompleted {
                        run_id,
                        ready: matches!(&observed, Ok(HomeCacheProbe::Ready { .. })),
                    });
                    if cancelled.is_cancelled() {
                        return Ok((None, PeerHomeWaitOutcome::Cancelled));
                    }
                    let now = tokio::time::Instant::now();
                    if now >= deadline {
                        return Ok((None, PeerHomeWaitOutcome::PreferenceExpired));
                    }
                    match observed {
                        Ok(HomeCacheProbe::Ready { .. }) => return Ok((Some(self.source_run_id), PeerHomeWaitOutcome::RevalidatedReady)),
                        Ok(HomeCacheProbe::Busy | HomeCacheProbe::Missing | HomeCacheProbe::Incompatible) => {}
                        Err(error) => warn!(
                            %run_id,
                            source_run_id = %self.source_run_id,
                            %error,
                            "claimed source Home revalidation failed; retaining original wait"
                        ),
                    }
                    recheck_at = now + recheck_delay;
                    recheck_delay = (recheck_delay * 2).min(HOME_RECHECK_MAX_DELAY);
                },
                update = committed.changed() => {
                    // This task retains the snapshot and its sender through ctx.
                    update?;
                },
            }
        }
    }
}
