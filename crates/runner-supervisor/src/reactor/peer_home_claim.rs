//! Resource-backed peer publication waiting after successful claim.
//!
//! The existing activation guard owns the claim, cancellation and local ordinary
//! capacity from the RPC result through this owned job and executor handoff.

use std::panic::AssertUnwindSafe;
use std::time::Instant;

use futures_util::FutureExt;
use runner_provider::{ClaimedJob, RunCancellationRegistration};
use runner_types::ids::RunId;

use super::job_discovery::{
    DiscoveredJobProfile, build_spawn_job_request, claimed_activation_resources,
};
use super::job_spawn::{JobResult, SpawnContext, run_job};
use crate::claimed_activation::{
    ClaimedActivationError, ClaimedActivationGuard, ClaimedJobSetup, ReadyClaimedResource,
};
use crate::executor::{
    BlankPoolSelection, RunnerPreSpawnPhase, RunnerPreSpawnTiming, validate_resume_session_id,
};
use crate::resource_budget::BudgetLease;
use runner_types::types::SandboxReuseResult;

pub(super) struct PeerHomeClaimRequest {
    pub(super) source_run_id: RunId,
    pub(super) claimed: ClaimedJob,
    pub(super) cancellation: RunCancellationRegistration,
    pub(super) lease: BudgetLease,
    pub(super) deadline: Instant,
    pub(super) claim_returned_at: Instant,
    pub(super) blank_pool_selection: Option<BlankPoolSelection>,
    pub(super) profile: DiscoveredJobProfile,
}

pub(super) struct PeerHomeClaim {
    source_run_id: RunId,
    activation: ClaimedActivationGuard,
    deadline: Instant,
}

impl PeerHomeClaim {
    pub(super) fn new(request: PeerHomeClaimRequest, ctx: &SpawnContext) -> Self {
        let PeerHomeClaimRequest {
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
        let home_source_run_id = match self.wait_for_home(&ctx).await {
            Ok(source) => source,
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
        setup
            .pre_spawn_timing
            .record_phase_elapsed(RunnerPreSpawnPhase::FinalizingWait, started_at);
        if setup.cancellation.handle().is_cancelled() {
            return Ok(self
                .activation
                .recover_cancelled()
                .await?
                .into_cancellation()
                .await);
        }
        // The same lease remains owned on expiry. Ordinary execution still
        // validates/locks checkout and may start without the peer's image.
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
                        "peer_activation_panicked",
                        "peer activation panicked".into(),
                    )
                    .await?
                    .finish()
                    .await;
                std::panic::resume_unwind(panic);
            }
        };
        request.job_profile.home_source_run_id = home_source_run_id;
        Ok(run_job(request, ctx).await)
    }

    async fn wait_for_home(
        &mut self,
        ctx: &SpawnContext,
    ) -> Result<Option<RunId>, ClaimedActivationError> {
        if ctx.exec_config.home_cache.is_none() {
            return Ok(None);
        }
        let setup = self.activation.setup()?;
        let Some(reuse_key) = setup.claimed.context().reuse_key().map(str::to_owned) else {
            return Ok(None);
        };
        let profile = setup.profile_name.clone();
        let cancelled = setup.cancellation.handle().token();
        let mut committed = ctx.home_cache_snapshot.subscribe_committed();
        let deadline = tokio::time::Instant::from_std(self.deadline);
        loop {
            if ctx.home_cache_snapshot.contains_source_home(
                &reuse_key,
                &profile,
                self.source_run_id,
            ) {
                return Ok(Some(self.source_run_id));
            }
            tokio::select! {
                biased;
                () = cancelled.cancelled() => return Ok(None),
                () = tokio::time::sleep_until(deadline) => return Ok(None),
                update = committed.changed() => {
                    // This task retains the snapshot and its sender through ctx.
                    update?;
                },
            }
        }
    }
}
