use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use runner_host::home_observation::{HomeObservation, HomeObservationKind, HomeObservationOutcome};
use tokio_util::task::AbortOnDropHandle;
use tracing::{Instrument, info};

use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_lifecycle::active_runs::ActiveRuns;
use runner_lifecycle::home_image_cache::snapshot::{
    HomeCacheStateSnapshot, filter_current_held_home_states,
};
use runner_lifecycle::home_image_cache::{HomeCacheChange, HomeCacheInventory, HomeImageCache};
use runner_lifecycle::idle_pool::IdlePool;
use runner_lifecycle::lifecycle::RunnerMode;
use runner_lifecycle::resource_budget::ResourceBudget;
use runner_provider::{JobProvider, ProviderResult};
use runner_types::types::{
    HeartbeatState, HeldHomeState, HeldSandboxState, MAX_ACTIVE_REUSE_PRODUCERS,
    MAX_HELD_SANDBOX_STATES,
};

/// Period between routine heartbeat ticks sent to the server. First tick is
/// deferred by one period via `interval_at`.
pub const HEARTBEAT_PERIOD: Duration = Duration::from_secs(10);

/// Resource shape projected from Runner configuration for heartbeat policy.
#[derive(Clone)]
pub struct HeartbeatProfile {
    pub vcpu: u32,
    pub memory_mb: u32,
    /// Full configured rootfs identity, never a display/normalized prefix.
    pub rootfs_hash: String,
    pub home_disk_mb: u32,
}

/// Host-local WSS ingress service state sampled for each heartbeat, never a browser reachability proof.
pub type WssIngressServiceProbe = Arc<dyn Fn() -> BoxFuture<'static, bool> + Send + Sync>;

#[derive(Debug, thiserror::Error)]
pub enum HeartbeatError {
    #[error("heartbeat wait requires an active send")]
    NoActiveSend,
    #[error("heartbeat task failed: {0}")]
    TaskFailed(tokio::task::JoinError),
    #[error("heartbeat snapshot sequence overflow")]
    SequenceOverflow,
    #[error("initial home-cache heartbeat failed")]
    InitialDeliveryFailed,
}

pub type HeartbeatResult<T> = Result<T, HeartbeatError>;

/// Shared inputs owned by independently scheduled heartbeat work.
///
/// Avoids passing 8+ arguments through `send_heartbeat`.
#[derive(Clone)]
pub struct HeartbeatContext {
    base: BaseHeartbeatContext,
    active_runs: ActiveRuns,
    home_cache_snapshot: HomeCacheStateSnapshot,
    wss_ingress_service_probe: WssIngressServiceProbe,
    sandbox_op_reporter: Option<runner_storage::SandboxOpReporter>,
}

/// Original snapshot authority shared by ordinary and terminal publication.
#[derive(Clone)]
struct BaseHeartbeatContext {
    idle_pool: Arc<tokio::sync::Mutex<IdlePool>>,
    runner_identity: RunnerProcessIdentity,
    runner_hostname: Option<String>,
    group: Arc<str>,
    profiles: Arc<BTreeMap<String, HeartbeatProfile>>,
    budget: Arc<ResourceBudget>,
    provider: Arc<dyn JobProvider>,
}

pub struct HeartbeatContextInit<'a> {
    pub idle_pool: &'a Arc<tokio::sync::Mutex<IdlePool>>,
    pub runner_identity: RunnerProcessIdentity,
    pub runner_hostname: Option<&'a str>,
    pub group: &'a str,
    pub profiles: &'a BTreeMap<String, HeartbeatProfile>,
    pub budget: &'a Arc<ResourceBudget>,
    pub provider: Arc<dyn JobProvider>,
    pub active_runs: &'a ActiveRuns,
    pub home_cache_snapshot: HomeCacheStateSnapshot,
    pub wss_ingress_service_probe: WssIngressServiceProbe,
    pub sandbox_op_reporter: Option<runner_storage::SandboxOpReporter>,
}

impl HeartbeatContext {
    pub fn new(init: HeartbeatContextInit<'_>) -> Self {
        Self {
            base: BaseHeartbeatContext {
                idle_pool: Arc::clone(init.idle_pool),
                runner_identity: init.runner_identity,
                runner_hostname: init.runner_hostname.map(str::to_owned),
                group: Arc::from(init.group),
                profiles: Arc::new(init.profiles.clone()),
                budget: Arc::clone(init.budget),
                provider: init.provider,
            },
            active_runs: init.active_runs.clone(),
            home_cache_snapshot: init.home_cache_snapshot,
            wss_ingress_service_probe: init.wss_ingress_service_probe,
            sandbox_op_reporter: init.sandbox_op_reporter,
        }
    }
}

impl BaseHeartbeatContext {
    async fn collect_state(&self, mode: RunnerMode, snapshot_sequence: u64) -> HeartbeatState {
        let pool = self.idle_pool.lock().await;
        let mut state = collect_heartbeat_state(
            HeartbeatSnapshotMetadata {
                runner_identity: self.runner_identity,
                group: &self.group,
                sequence: snapshot_sequence,
            },
            &self.profiles,
            &self.budget,
            &pool,
            mode,
        );
        drop(pool);
        state.runner_hostname = self.runner_hostname.clone();
        state
    }
}

/// Single-flight heartbeat work scheduled independently of the main reactor.
///
/// Trigger handlers only call [`request`](Self::request). The task continues
/// even while a reactor branch awaits a resource also used by heartbeat work.
/// Any number of triggers during one send collapse into one
/// follow-up built from live state when that send starts.
pub struct HeartbeatController {
    context: HeartbeatContext,
    in_flight: Option<AbortOnDropHandle<ProviderResult<()>>>,
    pending: Option<HeartbeatRequest>,
    next_snapshot_sequence: u64,
}

/// One final basic snapshot, retained after controller work has drained.
pub(crate) struct TerminalHeartbeat {
    context: BaseHeartbeatContext,
    snapshot_sequence: u64,
}

impl TerminalHeartbeat {
    /// Publish a final snapshot without ordinary cache or WSS enrichment.
    pub(crate) async fn send(self) {
        let state = self
            .context
            .collect_state(RunnerMode::Stopping, self.snapshot_sequence)
            .await;
        let _ = self.context.provider.heartbeat(&state).await;
    }
}

struct HeartbeatRequest {
    home_cache_change: Option<HomeCacheChange>,
}

impl HeartbeatRequest {
    fn ordinary() -> Self {
        Self {
            home_cache_change: None,
        }
    }

    fn home_cache(change: HomeCacheChange) -> Self {
        Self {
            home_cache_change: Some(change),
        }
    }

    fn merge(mut self, other: Self) -> Self {
        match (self.home_cache_change.as_mut(), other.home_cache_change) {
            (Some(existing), Some(incoming)) => existing.merge(incoming),
            (None, Some(incoming)) => self.home_cache_change = Some(incoming),
            (Some(_) | None, None) => {}
        }
        self
    }
}

impl HeartbeatController {
    pub fn new(context: HeartbeatContext) -> Self {
        Self {
            context,
            in_flight: None,
            pending: None,
            next_snapshot_sequence: 1,
        }
    }

    pub fn request(&mut self, mode: RunnerMode) -> HeartbeatResult<()> {
        self.request_inner(mode, HeartbeatRequest::ordinary())
    }

    /// Publish a change already committed by the inventory owner. Sending a
    /// heartbeat never waits for cache validation or a directory scan.
    pub fn request_home_cache(
        &mut self,
        mode: RunnerMode,
        change: HomeCacheChange,
    ) -> HeartbeatResult<()> {
        self.request_inner(mode, HeartbeatRequest::home_cache(change))
    }

    fn request_inner(
        &mut self,
        mode: RunnerMode,
        request: HeartbeatRequest,
    ) -> HeartbeatResult<()> {
        if self.in_flight.is_some() {
            self.pending = Some(match self.pending.take() {
                Some(pending) => pending.merge(request),
                None => request,
            });
        } else {
            self.start(mode, request)?;
        }
        Ok(())
    }

    pub fn is_sending(&self) -> bool {
        self.in_flight.is_some()
    }

    /// Observe the task from an enabled `tokio::select!` branch.
    pub async fn wait_for_send(&mut self) -> HeartbeatResult<()> {
        let _ = self.wait_for_delivery().await?;
        Ok(())
    }

    async fn wait_for_delivery(&mut self) -> HeartbeatResult<ProviderResult<()>> {
        let send = self
            .in_flight
            .as_mut()
            .ok_or(HeartbeatError::NoActiveSend)?;
        let result = send.await;
        if result.is_err() {
            // Teardown must not poll a completed JoinHandle a second time.
            self.in_flight = None;
            self.pending = None;
        }
        result.map_err(HeartbeatError::TaskFailed)
    }

    /// Startup shares the ordinary sequence source, but requires delivery
    /// success before publishing local running readiness. Cancellation leaves
    /// the active send owned here so rollback can drain and fence it.
    pub(crate) async fn report_initial_home_cache(
        &mut self,
        mode: RunnerMode,
        change: Option<HomeCacheChange>,
    ) -> HeartbeatResult<()> {
        debug_assert!(self.in_flight.is_none());
        self.request_inner(
            mode,
            HeartbeatRequest {
                home_cache_change: change,
            },
        )?;
        let delivery = self.wait_for_delivery().await?;
        self.finish_send(mode)?;
        // Provider telemetry records sanitized failure details. Do not copy
        // arbitrary API response bodies into the startup error or its logs.
        delivery.map_err(|_| HeartbeatError::InitialDeliveryFailed)
    }

    /// Clear a completed send and start one live-state follow-up when dirty.
    pub fn finish_send(&mut self, live_mode: RunnerMode) -> HeartbeatResult<()> {
        debug_assert!(self.in_flight.is_some());
        self.in_flight = None;
        if let Some(request) = self.pending.take() {
            self.start(live_mode, request)?;
        }
        Ok(())
    }

    /// Finish current work and emit one lifecycle-critical snapshot.
    ///
    /// Natural stopping uses this to replace all ordinary pending work with a
    /// single `Stopping` heartbeat before teardown.
    pub async fn flush(&mut self, mode: RunnerMode) -> HeartbeatResult<()> {
        self.request(mode)?;
        loop {
            self.wait_for_send().await?;
            self.in_flight = None;
            if let Some(request) = self.pending.take() {
                self.start(mode, request)?;
            } else {
                break;
            }
        }
        Ok(())
    }

    /// Finish only the active send and discard ordinary coalesced work.
    ///
    /// Hard stopping calls this before provider shutdown. Awaiting the bounded
    /// request preserves local ordering without assuming that dropping a
    /// client future retracts a request already queued remotely.
    pub async fn drain(&mut self) -> HeartbeatResult<()> {
        self.pending = None;
        if let Some(send) = self.in_flight.take() {
            let _ = send.await.map_err(HeartbeatError::TaskFailed)?;
        }
        Ok(())
    }

    /// Transfer the original base context and sequence after [`Self::drain`].
    pub(crate) fn into_terminal_heartbeat(self) -> TerminalHeartbeat {
        debug_assert!(self.in_flight.is_none());
        debug_assert!(self.pending.is_none());
        TerminalHeartbeat {
            context: self.context.base,
            snapshot_sequence: self.next_snapshot_sequence,
        }
    }

    fn start(&mut self, mode: RunnerMode, request: HeartbeatRequest) -> HeartbeatResult<()> {
        debug_assert!(self.in_flight.is_none());
        let snapshot_sequence = self.next_snapshot_sequence;
        let next_snapshot_sequence = snapshot_sequence
            .checked_add(1)
            .ok_or(HeartbeatError::SequenceOverflow)?;
        self.next_snapshot_sequence = next_snapshot_sequence;
        let context = self.context.clone();
        self.in_flight = Some(AbortOnDropHandle::new(tokio::spawn(
            async move { send_heartbeat(&context, mode, snapshot_sequence, request).await }
                .in_current_span(),
        )));
        Ok(())
    }
}

pub struct InitialHomeCacheRefreshOutcome {
    pub states: Vec<HeldHomeState>,
    pub locked_commit_keys: BTreeSet<String>,
    pub loaded_cache_keys: BTreeSet<String>,
}

/// Assemble current runner state and the committed home-cache snapshot, then
/// send a heartbeat to the server.
async fn send_heartbeat(
    hb: &HeartbeatContext,
    mode: RunnerMode,
    snapshot_sequence: u64,
    request: HeartbeatRequest,
) -> ProviderResult<()> {
    // A producer can move into the idle pool while the heartbeat waits for
    // its lock. Include either side of that transfer in this advisory snapshot.
    let mut producers = hb.active_runs.active_reuse_producers();
    let mut state = hb.base.collect_state(mode, snapshot_sequence).await;
    let cache_change = request.home_cache_change.as_ref();
    let refresh = hb.home_cache_snapshot.loaded_home_cache_snapshot();
    // Preserve the pre-transfer producer even if filtering observes its
    // resolved state; the next snapshot will advertise the parked sandbox.
    state.held_sandbox_states =
        filter_current_held_sandbox_states(state.held_sandbox_states, &hb.active_runs, None);
    producers.extend(hb.active_runs.active_reuse_producers());
    producers.sort_unstable_by_key(|entry| entry.run_id);
    producers.dedup_by_key(|entry| entry.run_id);
    producers.truncate(MAX_ACTIVE_REUSE_PRODUCERS);
    state.active_reuse_producers = producers;
    let inventory_observed_states = refresh.states.len();
    state.held_home_states = filter_home_states_for_profiles(
        filter_current_held_home_states(refresh.states, &hb.active_runs, None),
        &hb.base.profiles,
    );
    state.wss_ingress_service_active = (hb.wss_ingress_service_probe)().await;
    if let Some(reporter) = &hb.sandbox_op_reporter {
        let mut observation = HomeObservation::new(
            HomeObservationKind::Inventory,
            HomeObservationOutcome::Assembled,
        );
        observation.runner_id = Some(hb.base.runner_identity.runner_id().to_string());
        observation.runner_heartbeat_generation =
            Some(hb.base.runner_identity.heartbeat_generation());
        observation.inventory_loaded = Some(refresh.loaded);
        observation.inventory_observed_states = Some(inventory_observed_states);
        observation.inventory_output_states = Some(state.held_home_states.len());
        observation.inventory_omitted_states =
            Some(inventory_observed_states - state.held_home_states.len());
        let mut record = runner_storage::SandboxOpRecord::new(
            "runner_home_inventory",
            std::time::Duration::ZERO,
            true,
            None,
        );
        record.home = Some(observation);
        reporter.record(record);
    }
    info!(
        mode = ?mode,
        running = state.running_count,
        reusable_sandboxes = state.held_sandbox_states.len(),
        active_reuse_producers = state.active_reuse_producers.len(),
        home_states = state.held_home_states.len(),
        "heartbeat"
    );
    let delivery = hb.base.provider.heartbeat(&state).await;
    if let Some(change) = cache_change {
        info!(
            changed = true,
            elapsed_ms = duration_ms(change.observed_at.elapsed()),
            "home cache change heartbeat completed"
        );
    }
    delivery
}

/// Scans the home cache and commits the result to the shared snapshot.
///
/// The revision is captured before the asynchronous scan, and no snapshot
/// mutex is held across the await. The returned value is the committed
/// snapshot, which may also contain updates merged from concurrent promotions.
pub async fn refresh_initial_home_cache_snapshot(
    snapshot: &HomeCacheStateSnapshot,
    home_cache: Option<&HomeImageCache>,
    profiles: &BTreeMap<String, HeartbeatProfile>,
) -> InitialHomeCacheRefreshOutcome {
    let refresh = snapshot.begin_home_cache_refresh();
    let inventory = match home_cache {
        Some(cache) => {
            cache
                .home_cache_inventory_for_profiles(&profile_home_sizes(profiles))
                .await
        }
        None => HomeCacheInventory::default(),
    };
    let locked_commit_keys = inventory.locked_keys.clone();
    let loaded_cache_keys = inventory.projected_cache_keys();
    let outcome = snapshot.finish_home_cache_refresh(refresh, inventory);
    InitialHomeCacheRefreshOutcome {
        states: outcome.states,
        locked_commit_keys,
        loaded_cache_keys,
    }
}

pub(crate) fn profile_home_sizes(
    profiles: &BTreeMap<String, HeartbeatProfile>,
) -> BTreeMap<&str, u64> {
    profiles
        .iter()
        .map(|(name, profile)| (name.as_str(), u64::from(profile.home_disk_mb) * 1024 * 1024))
        .collect()
}

#[cfg(test)]
async fn home_cache_states(
    home_cache: Option<&HomeImageCache>,
    profiles: &BTreeMap<String, HeartbeatProfile>,
) -> Vec<HeldHomeState> {
    match home_cache {
        Some(cache) => {
            cache
                .held_home_states_for_profiles(&profile_home_sizes(profiles))
                .await
        }
        None => Vec::new(),
    }
}

/// Cached snapshots are advisory, but may advertise only the current configured
/// profiles/version. Their underlying image and shape identity was validated by
/// inventory or a successful generation-owned publication under its lease.
fn filter_home_states_for_profiles(
    mut states: Vec<HeldHomeState>,
    profiles: &BTreeMap<String, HeartbeatProfile>,
) -> Vec<HeldHomeState> {
    for state in &mut states {
        state.home_caches.retain(|cache| {
            profiles.contains_key(&cache.profile)
                && cache.home_affinity_version == runner_types::types::HOME_AFFINITY_VERSION
        });
    }
    states.retain(|state| !state.home_caches.is_empty());
    states
}

fn filter_current_held_sandbox_states(
    states: Vec<HeldSandboxState>,
    active_runs: &ActiveRuns,
    extra_active_reuse_key: Option<&str>,
) -> Vec<HeldSandboxState> {
    let mut active_reuse_keys = active_runs.reuse_keys();
    if let Some(reuse_key) = extra_active_reuse_key {
        active_reuse_keys.insert(reuse_key.to_owned());
    }
    let mut states = states
        .into_iter()
        .filter(|state| !active_reuse_keys.contains(&state.reuse_key))
        .collect::<Vec<_>>();
    states.sort_unstable_by(|a, b| {
        b.last_completed_at
            .cmp(&a.last_completed_at)
            .then_with(|| a.reuse_key.cmp(&b.reuse_key))
    });
    states.truncate(MAX_HELD_SANDBOX_STATES);
    states.sort_unstable_by(|a, b| a.reuse_key.cmp(&b.reuse_key));
    states
}

fn admittable_profiles_for_heartbeat(
    profiles: &BTreeMap<String, HeartbeatProfile>,
    budget: &ResourceBudget,
    idle_pool: &IdlePool,
    mode: RunnerMode,
) -> Vec<String> {
    if mode != RunnerMode::Running {
        return Vec::new();
    }

    profiles
        .iter()
        .filter(|(_, profile)| {
            idle_pool.can_admit_after_reclaiming(budget, profile.vcpu, profile.memory_mb)
        })
        .map(|(name, _)| name.clone())
        .collect()
}

/// Collect current runner state for heartbeat reporting.
pub struct HeartbeatSnapshotMetadata<'a> {
    pub runner_identity: RunnerProcessIdentity,
    pub group: &'a str,
    pub sequence: u64,
}

pub fn collect_heartbeat_state(
    snapshot: HeartbeatSnapshotMetadata<'_>,
    profiles: &BTreeMap<String, HeartbeatProfile>,
    budget: &ResourceBudget,
    idle_pool: &IdlePool,
    mode: RunnerMode,
) -> HeartbeatState {
    // Stopped is set only by `status.set_mode(Stopped)` immediately before
    // `run()` returns, after the last heartbeat has been sent. If a caller
    // reaches here with Stopped it means a new code path was added that
    // heartbeats post-teardown, which breaks the contract that the server
    // never sees mode=stopped on the wire. Debug-only: release still falls
    // through to the defensive "stopping" mapping below.
    debug_assert_ne!(
        mode,
        RunnerMode::Stopped,
        "Stopped is never live-heartbeated",
    );
    let (allocated_vcpu, allocated_memory_mb, budget_running) = budget.allocated();
    // budget.allocated() includes parked (idle) sandboxes that hold their budget.
    // Report only actively running jobs so the scheduler sees real capacity.
    let idle_count = idle_pool.len();
    let running_count = budget_running.saturating_sub(idle_count);
    let admittable_profiles = admittable_profiles_for_heartbeat(profiles, budget, idle_pool, mode);
    HeartbeatState {
        runner_id: snapshot.runner_identity.runner_id().to_string(),
        runner_hostname: None,
        group: snapshot.group.to_string(),
        snapshot_generation: snapshot.runner_identity.heartbeat_generation(),
        snapshot_sequence: snapshot.sequence,
        total_vcpu: budget.effective_vcpu(),
        total_memory_mb: budget.effective_memory_mb(),
        max_concurrent: budget.max_concurrent(),
        allocated_vcpu,
        allocated_memory_mb,
        running_count,
        admittable_profiles,
        held_sandbox_states: idle_pool.held_sandbox_states(),
        held_home_states: Vec::new(),
        active_reuse_producers: Vec::new(),
        wss_ingress_service_active: false,
        mode: match mode {
            RunnerMode::Starting => "starting".to_string(),
            RunnerMode::Running => "running".to_string(),
            RunnerMode::Draining => "draining".to_string(),
            // Stopped caught by the debug_assert above; release falls here.
            RunnerMode::Stopping | RunnerMode::Stopped => "stopping".to_string(),
        },
    }
}

use crate::duration::duration_ms;

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;
    use runner_host::paths::RunnerPaths;
    use runner_lifecycle::home_image_cache::{
        HomeCacheTerminalStatus, HomeImageLeaseIdentity, HomeImagePrepareRequest,
    };
    use runner_lifecycle::idle_pool::{
        IdlePoolConfig, ParkResult, ParkedIdleCandidate, test_support::ParkedIdleCandidateBuilder,
    };
    use runner_types::types::{HomeCacheCapability, ReusableSandboxState};
    use sandbox::SandboxId;
    use tracing_subscriber::prelude::*;
    use tracing_test_support::{CapturedEvent, CapturedEvents};

    #[derive(Default)]
    struct RecordingProvider {
        heartbeats: std::sync::Mutex<Vec<HeartbeatState>>,
    }

    #[async_trait::async_trait]
    impl JobProvider for RecordingProvider {
        async fn discover(&self) -> Option<runner_provider::JobCandidate> {
            None
        }

        async fn claim(
            &self,
            _candidate: runner_provider::JobCandidate,
        ) -> Option<runner_provider::ClaimedJob> {
            None
        }

        async fn complete(
            &self,
            _request: runner_types::types::CompleteRequest,
            _completion_auth: runner_provider::CompletionAuth,
        ) {
        }

        async fn heartbeat(&self, state: &HeartbeatState) -> ProviderResult<()> {
            self.heartbeats
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(state.clone());
            Ok(())
        }

        async fn shutdown(&self) {}
    }

    fn test_runner_identity() -> RunnerProcessIdentity {
        RunnerProcessIdentity::new(uuid::Uuid::from_u128(1), 7).unwrap()
    }

    fn test_profiles() -> BTreeMap<String, HeartbeatProfile> {
        let mut m = BTreeMap::new();
        m.insert(
            "vm0/default".to_string(),
            HeartbeatProfile {
                vcpu: 2,
                memory_mb: 4096,
                rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .into(),
                home_disk_mb: 1,
            },
        );
        m
    }

    fn test_snapshot_metadata() -> HeartbeatSnapshotMetadata<'static> {
        HeartbeatSnapshotMetadata {
            runner_identity: test_runner_identity(),
            group: "vm0/test",
            sequence: 42,
        }
    }

    fn make_parked_candidate(reuse_key: &str, budget: &Arc<ResourceBudget>) -> ParkedIdleCandidate {
        ParkedIdleCandidateBuilder::new(
            reuse_key,
            ResourceBudget::try_reserve_lease(budget, 2, 4096).unwrap(),
        )
        .with_mock_sandbox_name("test")
        .build()
    }

    fn refresh_snapshot(snapshot: &HomeCacheStateSnapshot, states: Vec<HeldHomeState>) {
        let refresh = snapshot.begin_home_cache_refresh();
        let mut inventory = HomeCacheInventory::default();
        for state in states {
            for home in state.home_caches {
                inventory.entries.insert(
                    format!("{}:{}", state.reuse_key, home.profile),
                    HeldHomeState {
                        reuse_key: state.reuse_key.clone(),
                        last_completed_at: state.last_completed_at.clone(),
                        home_caches: vec![home],
                    },
                );
            }
        }
        snapshot.finish_home_cache_refresh(refresh, inventory);
    }

    #[tokio::test]
    async fn home_inventory_operations_distinguish_unloaded_empty_and_omitted_states() {
        let observations =
            runner_storage::operation_test_support::RecordedHomeObservations::default();
        let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
            max_idle: 0,
        })));
        let profiles = test_profiles();
        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
        let active_runs = test_active_runs();
        let provider = Arc::new(RecordingProvider::default());
        let snapshot = HomeCacheStateSnapshot::new();
        let hb = HeartbeatContext::new(HeartbeatContextInit {
            idle_pool: &idle_pool,
            runner_hostname: None,
            runner_identity: test_runner_identity(),
            group: "vm0/test",
            profiles: &profiles,
            budget: &budget,
            provider: provider.clone(),
            active_runs: &active_runs,
            home_cache_snapshot: snapshot.clone(),
            sandbox_op_reporter: Some(observations.handle()),
            wss_ingress_service_probe: Arc::new(|| Box::pin(async { false })),
        });
        send_heartbeat(&hb, RunnerMode::Running, 1, HeartbeatRequest::ordinary())
            .await
            .unwrap();
        refresh_snapshot(&snapshot, Vec::new());
        send_heartbeat(&hb, RunnerMode::Running, 2, HeartbeatRequest::ordinary())
            .await
            .unwrap();
        refresh_snapshot(
            &snapshot,
            vec![
                held_home_state(
                    "thread:available",
                    "2026-06-01T00:00:00.000Z",
                    &["vm0/default"],
                ),
                held_home_state(
                    "thread:active",
                    "2026-06-01T00:00:00.000Z",
                    &["vm0/default"],
                ),
                held_home_state(
                    "thread:other-profile",
                    "2026-06-01T00:00:00.000Z",
                    &["other"],
                ),
            ],
        );
        let _active = active_runs.register(
            runner_types::ids::RunId::new_v4(),
            Some("thread:active".into()),
            "vm0/default".into(),
        );
        send_heartbeat(&hb, RunnerMode::Running, 3, HeartbeatRequest::ordinary())
            .await
            .unwrap();
        let events = observations.events();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].inventory_loaded, Some(false));
        assert_eq!(events[0].inventory_output_states, Some(0));
        assert_eq!(events[1].inventory_loaded, Some(true));
        assert_eq!(events[1].inventory_output_states, Some(0));
        let event = &events[2];
        assert_eq!(event.kind, HomeObservationKind::Inventory);
        assert_eq!(event.outcome, HomeObservationOutcome::Assembled);
        assert_eq!(
            event.runner_id.as_deref(),
            Some(test_runner_identity().runner_id().to_string().as_str())
        );
        assert_eq!(event.runner_heartbeat_generation, Some(7));
        assert_eq!(event.inventory_loaded, Some(true));
        assert_eq!(event.inventory_observed_states, Some(3));
        assert_eq!(event.inventory_output_states, Some(1));
        assert_eq!(event.inventory_omitted_states, Some(2));
        assert!(event.run_id.is_none());
        assert!(event.is_first_run.is_none());
        let sent = provider.heartbeats.lock().unwrap();
        assert_eq!(
            sent[2].held_home_states,
            vec![held_home_state(
                "thread:available",
                "2026-06-01T00:00:00.000Z",
                &["vm0/default"]
            )]
        );
    }

    fn test_active_runs() -> ActiveRuns {
        ActiveRuns::new(Arc::new(tokio::sync::Notify::new()))
    }

    fn home_cache(profile: &str) -> HomeCacheCapability {
        HomeCacheCapability {
            profile: profile.to_owned(),
            home_affinity_version: runner_types::types::HOME_AFFINITY_VERSION,
        }
    }

    fn held_home_state(
        reuse_key: &str,
        last_completed_at: &str,
        profiles: &[&str],
    ) -> HeldHomeState {
        HeldHomeState {
            reuse_key: reuse_key.to_owned(),
            last_completed_at: last_completed_at.to_owned(),
            home_caches: profiles.iter().map(|profile| home_cache(profile)).collect(),
        }
    }

    async fn seed_home_cache_state(
        cache: &HomeImageCache,
        paths: &RunnerPaths,
        reuse_key: &str,
        completed_at: &str,
    ) {
        let run_id = runner_types::ids::RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let lease = cache
            .prepare(HomeImagePrepareRequest {
                identity: HomeImageLeaseIdentity {
                    run_id,
                    sandbox_id,
                    profile_name: "vm0/default",
                    reuse_key: Some(reuse_key),
                    working_dir:
                        api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR,
                    rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    image_size_bytes: 1024 * 1024,
                },
                home_drive_required: true,
            })
            .await;
        let active_image = paths.active_home_image(&sandbox_id);
        tokio::fs::create_dir_all(active_image.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::File::create(&active_image)
            .await
            .unwrap()
            .set_len(1024 * 1024)
            .await
            .unwrap();
        assert!(
            lease
                .promote(
                    run_id,
                    HomeCacheTerminalStatus::Success,
                    completed_at.into(),
                    &runner_storage::storage_fingerprints::StorageFingerprints::default(),
                )
                .await
                .unwrap()
        );
    }

    async fn capture_heartbeat_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
    where
        F: std::future::Future,
    {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let guard = tracing::subscriber::set_default(subscriber);
        tracing::callsite::rebuild_interest_cache();
        let output = future.await;
        drop(guard);
        (output, captured.entries())
    }

    fn captured_event<'a>(events: &'a [CapturedEvent], message: &str) -> &'a CapturedEvent {
        events
            .iter()
            .find(|event| {
                event
                    .fields
                    .get("message")
                    .is_some_and(|actual| actual == message)
            })
            .unwrap_or_else(|| panic!("missing event {message:?}; captured={events:#?}"))
    }

    fn home_cache_change(cache_key: &str) -> HomeCacheChange {
        HomeCacheChange {
            observed_at: tokio::time::Instant::now(),
            dirty_cache_keys: BTreeSet::from([cache_key.to_owned()]),
            requires_full_reconcile: false,
        }
    }

    #[test]
    fn ordinary_heartbeat_forces_send_without_dropping_coalesced_cache_commits() {
        let ordinary = HeartbeatRequest::ordinary();
        let cache_then_ordinary = HeartbeatRequest::home_cache(home_cache_change("a"))
            .merge(HeartbeatRequest::ordinary());
        let ordinary_then_cache = HeartbeatRequest::ordinary()
            .merge(HeartbeatRequest::home_cache(home_cache_change("b")));
        assert!(ordinary.home_cache_change.is_none());
        assert!(cache_then_ordinary.home_cache_change.is_some());
        assert_eq!(
            cache_then_ordinary
                .home_cache_change
                .unwrap()
                .dirty_cache_keys,
            BTreeSet::from(["a".to_owned()])
        );
        assert!(ordinary_then_cache.home_cache_change.is_some());
        assert_eq!(
            ordinary_then_cache
                .home_cache_change
                .unwrap()
                .dirty_cache_keys,
            BTreeSet::from(["b".to_owned()])
        );
    }

    #[test]
    fn heartbeat_running_count_no_idle() {
        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
        let _leases = [
            ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
            ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
        ];
        let pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
        let profiles = test_profiles();

        let state = collect_heartbeat_state(
            test_snapshot_metadata(),
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );
        assert_eq!(state.running_count, 2);
    }

    #[test]
    fn heartbeat_admittable_profiles_match_current_budget() {
        let budget = Arc::new(ResourceBudget::new(5, 8192, 1.0, 2));
        let _lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let mut profiles = test_profiles();
        profiles.insert(
            "vm0/large".to_string(),
            HeartbeatProfile {
                vcpu: 4,
                memory_mb: 8192,
                rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .into(),
                home_disk_mb: 10240,
            },
        );
        let pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });

        let state = collect_heartbeat_state(
            test_snapshot_metadata(),
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );

        assert_eq!(state.admittable_profiles, vec!["vm0/default"]);
    }

    #[test]
    fn heartbeat_admittable_profiles_include_reclaimable_but_not_reserved_inventory() {
        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 1));
        let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
        let candidate = ParkedIdleCandidateBuilder::new(
            "sess-idle",
            ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
        )
        .with_last_completed_at("2026-06-01T00:00:00.000Z")
        .build();
        assert!(matches!(pool.park(candidate), ParkResult::Parked));
        let profiles = test_profiles();

        let state = collect_heartbeat_state(
            test_snapshot_metadata(),
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );

        assert_eq!(state.admittable_profiles, vec!["vm0/default"]);
        assert_eq!(state.allocated_vcpu, 2);
        assert_eq!(state.allocated_memory_mb, 4096);
        assert_eq!(state.running_count, 0);

        let reserved = pool
            .reserve_reusable("sess-idle", "vm0/default", &None)
            .unwrap();
        let state = collect_heartbeat_state(
            test_snapshot_metadata(),
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );
        assert!(state.admittable_profiles.is_empty());
        assert_eq!(budget.allocated(), (2, 4096, 1));
        assert!(matches!(
            pool.restore_reserved(reserved),
            runner_lifecycle::idle_pool::RestoreReservedIdleResult::Restored
        ));
    }

    #[test]
    fn heartbeat_reclaimable_profiles_respect_active_capacity_for_all_parked_kinds() {
        for blank_count in 0..=2 {
            let budget = Arc::new(ResourceBudget::new(4, 6144, 1.0, 3));
            let _active = ResourceBudget::try_reserve_lease(&budget, 1, 2048).unwrap();
            let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
            for index in 0..2 {
                let lease = ResourceBudget::try_reserve_lease(&budget, 1, 2048).unwrap();
                let candidate = if index < blank_count {
                    let sandbox_id = SandboxId::new_v4();
                    ParkedIdleCandidate::blank(
                        Box::new(sandbox_mock::MockSandbox::new(sandbox_id.to_string())),
                        Arc::new(Box::new(sandbox_mock::MockSandboxFactory::new())),
                        lease,
                        sandbox_id,
                        "vm0/small".into(),
                        "test-rootfs".into(),
                        None,
                    )
                } else {
                    ParkedIdleCandidateBuilder::new(format!("idle-{index}"), lease)
                        .with_profile_name("vm0/small")
                        .build()
                };
                assert!(matches!(pool.park(candidate), ParkResult::Parked));
            }
            let mut profiles = test_profiles();
            profiles.insert(
                "vm0/small".into(),
                HeartbeatProfile {
                    vcpu: 1,
                    memory_mb: 2048,
                    rootfs_hash: "test-rootfs".into(),
                    home_disk_mb: 10240,
                },
            );
            profiles.insert(
                "vm0/large".into(),
                HeartbeatProfile {
                    vcpu: 4,
                    memory_mb: 8192,
                    rootfs_hash: "test-rootfs".into(),
                    home_disk_mb: 10240,
                },
            );

            let state = collect_heartbeat_state(
                test_snapshot_metadata(),
                &profiles,
                &budget,
                &pool,
                RunnerMode::Running,
            );
            assert_eq!(state.admittable_profiles, vec!["vm0/default", "vm0/small"]);
            assert_eq!(state.running_count, 1);
            assert_eq!(state.allocated_vcpu, 3);
            assert_eq!(state.allocated_memory_mb, 6144);
            assert!(ResourceBudget::try_reserve_lease(&budget, 2, 4096).is_none());
        }
    }

    #[test]
    fn heartbeat_admittable_profiles_empty_when_not_running() {
        let budget = ResourceBudget::new(8, 32768, 1.0, 4);
        let pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
        let profiles = test_profiles();

        let state = collect_heartbeat_state(
            test_snapshot_metadata(),
            &profiles,
            &budget,
            &pool,
            RunnerMode::Draining,
        );

        assert!(state.admittable_profiles.is_empty());
    }

    #[test]
    fn heartbeat_starting_reports_no_admittable_profiles() {
        let budget = ResourceBudget::new(8, 32768, 1.0, 4);
        let pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
        let profiles = test_profiles();

        let state = collect_heartbeat_state(
            test_snapshot_metadata(),
            &profiles,
            &budget,
            &pool,
            RunnerMode::Starting,
        );

        assert_eq!(state.mode, "starting");
        assert!(state.admittable_profiles.is_empty());
    }

    #[tokio::test]
    async fn each_heartbeat_observes_wss_ingress_transitions_while_running_or_draining() {
        let active = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let wss_ingress_service_probe: WssIngressServiceProbe = {
            let active = Arc::clone(&active);
            Arc::new(move || {
                let active = Arc::clone(&active);
                Box::pin(async move { active.load(std::sync::atomic::Ordering::SeqCst) })
            })
        };
        let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
            max_idle: 0,
        })));
        let profiles = test_profiles();
        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
        let provider = Arc::new(RecordingProvider::default());
        let active_runs = test_active_runs();
        let hb = HeartbeatContext::new(HeartbeatContextInit {
            idle_pool: &idle_pool,
            runner_hostname: None,
            sandbox_op_reporter: None,
            runner_identity: test_runner_identity(),
            group: "vm0/test",
            profiles: &profiles,
            budget: &budget,
            provider: provider.clone(),
            active_runs: &active_runs,
            home_cache_snapshot: HomeCacheStateSnapshot::new(),
            wss_ingress_service_probe,
        });

        send_heartbeat(&hb, RunnerMode::Running, 1, HeartbeatRequest::ordinary())
            .await
            .unwrap();
        active.store(true, std::sync::atomic::Ordering::SeqCst);
        send_heartbeat(&hb, RunnerMode::Draining, 2, HeartbeatRequest::ordinary())
            .await
            .unwrap();
        active.store(false, std::sync::atomic::Ordering::SeqCst);
        send_heartbeat(&hb, RunnerMode::Running, 3, HeartbeatRequest::ordinary())
            .await
            .unwrap();
        let sent = provider.heartbeats.lock().unwrap();
        assert_eq!(
            sent.iter()
                .map(|s| s.wss_ingress_service_active)
                .collect::<Vec<_>>(),
            vec![false, true, false]
        );
        assert_eq!(sent[1].mode, "draining");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn send_heartbeat_logs_state_counts_without_raw_reuse_state() {
        let reuse_key = "thread:sensitive-heartbeat-17975";
        let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
            max_idle: 1,
        })));
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = HomeImageCache::new(paths.clone());
        seed_home_cache_state(&cache, &paths, reuse_key, "2026-06-01T00:00:00.000Z").await;
        let profiles = test_profiles();
        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
        let active_runs = test_active_runs();
        let provider = Arc::new(RecordingProvider::default());
        let home_cache_snapshot = HomeCacheStateSnapshot::new();
        refresh_initial_home_cache_snapshot(&home_cache_snapshot, Some(&cache), &profiles).await;
        let hb = HeartbeatContext::new(HeartbeatContextInit {
            idle_pool: &idle_pool,
            runner_hostname: None,
            sandbox_op_reporter: None,
            runner_identity: test_runner_identity(),
            group: "vm0/test",
            profiles: &profiles,
            budget: &budget,
            provider,
            active_runs: &active_runs,
            home_cache_snapshot: home_cache_snapshot.clone(),
            wss_ingress_service_probe: Arc::new(|| Box::pin(async { false })),
        });

        let (delivery, events) = capture_heartbeat_events(send_heartbeat(
            &hb,
            RunnerMode::Running,
            42,
            HeartbeatRequest::ordinary(),
        ))
        .await;

        delivery.unwrap();

        let heartbeat_event = captured_event(&events, "heartbeat");
        assert_eq!(heartbeat_event.level, tracing::Level::INFO);
        assert_eq!(
            heartbeat_event
                .fields
                .get("reusable_sandboxes")
                .map(String::as_str),
            Some("0")
        );
        assert_eq!(
            heartbeat_event
                .fields
                .get("home_states")
                .map(String::as_str),
            Some("1")
        );
        for event in &events {
            for (field, value) in &event.fields {
                assert!(
                    !value.contains(reuse_key),
                    "captured field {field} leaked raw reuse key {reuse_key:?}: {event:#?}"
                );
            }
        }
        let cached_states = home_cache_snapshot.current_held_home_states(&active_runs, None);
        assert_eq!(cached_states.len(), 1);
        assert_eq!(cached_states[0].reuse_key, reuse_key);
        assert_eq!(
            cached_states[0].home_caches,
            vec![home_cache("vm0/default")]
        );
    }

    #[tokio::test]
    async fn unused_release_heartbeat_revalidates_one_key_and_preserves_independent_homes() {
        for replace_source in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let paths = RunnerPaths::new(dir.path().join("runner"));
            let cache = HomeImageCache::new(paths.clone());
            seed_home_cache_state(&cache, &paths, "released", "2026-06-01T00:00:00.000Z").await;
            seed_home_cache_state(&cache, &paths, "independent", "2026-06-01T00:01:00.000Z").await;
            let mut watcher =
                runner_lifecycle::home_image_cache::HomeCacheWatcher::new(cache.clone())
                    .await
                    .unwrap();
            let profiles = test_profiles();
            let snapshot = HomeCacheStateSnapshot::new();
            refresh_initial_home_cache_snapshot(&snapshot, Some(&cache), &profiles).await;
            assert_eq!(snapshot.loaded_home_cache_snapshot().states.len(), 2);
            let lease = cache.prepare(HomeImagePrepareRequest { identity: HomeImageLeaseIdentity {
                run_id: runner_types::ids::RunId::new_v4(), sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default", rootfs_hash: "current-rootfs", reuse_key: Some("released"),
                working_dir: api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR,
                image_size_bytes: 1024 * 1024,
            }, home_drive_required: true }).await;
            assert!(lease.is_cache_hit());
            if replace_source {
                let identity = lease.source_identity().unwrap();
                let image = cache
                    .entry_paths(identity.cache_key)
                    .image(identity.image_generation)
                    .unwrap();
                tokio::fs::rename(&image, dir.path().join("original.ext4"))
                    .await
                    .unwrap();
                tokio::fs::File::create(&image)
                    .await
                    .unwrap()
                    .set_len(1024 * 1024)
                    .await
                    .unwrap();
            }
            drop(lease);
            let change = tokio::time::timeout(Duration::from_secs(10), watcher.next_change())
                .await
                .unwrap()
                .unwrap();
            assert!(!change.requires_full_reconcile);
            cache.reset_held_state_root_scan_count();
            let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
                max_idle: 0,
            })));
            let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
            let active_runs = test_active_runs();
            let provider = Arc::new(RecordingProvider::default());
            let hb = HeartbeatContext::new(HeartbeatContextInit {
                idle_pool: &idle_pool,
                runner_hostname: None,
                sandbox_op_reporter: None,
                runner_identity: test_runner_identity(),
                group: "vm0/test",
                profiles: &profiles,
                budget: &budget,
                provider: provider.clone(),
                active_runs: &active_runs,
                home_cache_snapshot: snapshot,
                wss_ingress_service_probe: Arc::new(|| Box::pin(async { false })),
            });
            hb.home_cache_snapshot.note_home_cache_change(&change);
            let token = hb.home_cache_snapshot.begin_home_cache_refresh();
            let updates = cache
                .revalidate_home_cache_keys(
                    &profile_home_sizes(&profiles),
                    &change.dirty_cache_keys,
                )
                .await;
            hb.home_cache_snapshot
                .finish_home_cache_key_updates(token, updates);
            send_heartbeat(
                &hb,
                RunnerMode::Running,
                1,
                HeartbeatRequest::home_cache(change).merge(HeartbeatRequest::ordinary()),
            )
            .await
            .unwrap();
            let sent = provider.heartbeats.lock().unwrap();
            assert_eq!(sent.len(), 1);
            let keys = sent[0]
                .held_home_states
                .iter()
                .map(|state| state.reuse_key.as_str())
                .collect::<BTreeSet<_>>();
            let expected = if replace_source {
                BTreeSet::from(["independent"])
            } else {
                BTreeSet::from(["independent", "released"])
            };
            assert_eq!(keys, expected);
            assert_eq!(cache.held_state_root_scan_count(), 0);
        }
    }

    #[tokio::test]
    async fn initial_home_cache_heartbeat_uses_loaded_snapshot() {
        let reuse_key = "thread:loaded-initial-snapshot";
        let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
            max_idle: 1,
        })));
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = HomeImageCache::new(paths.clone());
        seed_home_cache_state(&cache, &paths, reuse_key, "2026-06-01T00:00:00.000Z").await;
        let profiles = test_profiles();
        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
        let active_runs = test_active_runs();
        let provider = Arc::new(RecordingProvider::default());
        let home_cache_snapshot = HomeCacheStateSnapshot::new();
        refresh_snapshot(
            &home_cache_snapshot,
            vec![held_home_state(
                reuse_key,
                "2026-06-01T00:00:00.000Z",
                &["vm0/default"],
            )],
        );
        let cache_key = runner_host::paths::scoped_home_image_cache_key(
            "",
            "vm0/default",
            reuse_key,
            1024 * 1024,
        );
        let metadata = runner_lifecycle::test_fixtures::runner_home_image_cache_dir(&paths)
            .join(cache_key)
            .join("metadata.json");
        tokio::fs::remove_file(metadata).await.unwrap();
        let hb = HeartbeatContext::new(HeartbeatContextInit {
            idle_pool: &idle_pool,
            runner_hostname: None,
            sandbox_op_reporter: None,
            runner_identity: test_runner_identity(),
            group: "vm0/test",
            profiles: &profiles,
            budget: &budget,
            provider: provider.clone(),
            active_runs: &active_runs,
            home_cache_snapshot,
            wss_ingress_service_probe: Arc::new(|| Box::pin(async { false })),
        });

        send_heartbeat(&hb, RunnerMode::Running, 42, HeartbeatRequest::ordinary())
            .await
            .unwrap();

        let heartbeats = provider
            .heartbeats
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(heartbeats.len(), 1);
        assert_eq!(
            heartbeats[0].held_home_states,
            vec![held_home_state(
                reuse_key,
                "2026-06-01T00:00:00.000Z",
                &["vm0/default"],
            )]
        );
    }

    #[tokio::test]
    async fn home_inventory_survives_rootfs_changes_and_requires_exact_home_shape() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = HomeImageCache::new(paths.clone());
        seed_home_cache_state(
            &cache,
            &paths,
            "thread:profile-identity",
            "2026-06-01T00:00:00.000Z",
        )
        .await;
        let mut profiles = test_profiles();
        assert_eq!(home_cache_states(Some(&cache), &profiles).await.len(), 1);
        // A new rootfs uses the same independent home image and physical key.
        profiles.get_mut("vm0/default").unwrap().rootfs_hash =
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab".into();
        assert_eq!(home_cache_states(Some(&cache), &profiles).await.len(), 1);
        let snapshot = HomeCacheStateSnapshot::new();
        let initial = refresh_initial_home_cache_snapshot(&snapshot, Some(&cache), &profiles).await;
        assert_eq!(initial.states.len(), 1);
        profiles.get_mut("vm0/default").unwrap().rootfs_hash =
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into();
        profiles.get_mut("vm0/default").unwrap().home_disk_mb = 2;
        assert!(home_cache_states(Some(&cache), &profiles).await.is_empty());
        profiles.get_mut("vm0/default").unwrap().home_disk_mb = 1;
        assert_eq!(home_cache_states(Some(&cache), &profiles).await.len(), 1);
        profiles.clear();
        assert!(home_cache_states(Some(&cache), &profiles).await.is_empty());
    }

    #[test]
    fn cached_home_snapshot_filters_profiles_and_serializes_empty_inventory() {
        let profiles = test_profiles();
        let filtered = filter_home_states_for_profiles(
            vec![held_home_state(
                "thread:configured",
                "2026-06-01T00:00:00.000Z",
                &["vm0/default", "vm0/removed"],
            )],
            &profiles,
        );
        assert_eq!(filtered[0].home_caches, vec![home_cache("vm0/default")]);
        let budget = ResourceBudget::new(8, 32768, 1.0, 4);
        let pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
        let state = collect_heartbeat_state(
            test_snapshot_metadata(),
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );
        let body = serde_json::to_value(&state).unwrap();
        assert_eq!(body["heldHomeStates"], serde_json::json!([]));
        assert!(
            state.held_home_states.is_empty(),
            "inventory is populated only by eligible cache evidence"
        );
    }

    #[tokio::test]
    async fn home_cache_states_filter_claimed_reuse_key() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = HomeImageCache::new(paths.clone());
        seed_home_cache_state(&cache, &paths, "sess-cache", "2026-06-01T00:00:00.000Z").await;
        seed_home_cache_state(&cache, &paths, "sess-claimed", "2026-06-01T00:00:01.000Z").await;
        let active_runs = test_active_runs();
        let profiles = test_profiles();
        let cache_states = home_cache_states(Some(&cache), &profiles).await;
        let states =
            filter_current_held_home_states(cache_states, &active_runs, Some("sess-claimed"));

        assert!(
            states.iter().any(|state| state.reuse_key == "sess-cache"),
            "unrelated home cache should remain advertised"
        );
        assert!(
            !states.iter().any(|state| state.reuse_key == "sess-claimed"),
            "currently claimed reuse key should be filtered until the run finishes"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn heartbeat_advertises_live_producer_then_held_sandbox() {
        let reuse_key = "thread:heartbeat-producer";
        let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
            max_idle: 1,
        })));
        let notify = Arc::new(tokio::sync::Notify::new());
        let active_runs = ActiveRuns::new(Arc::clone(&notify));
        let run_id = runner_types::ids::RunId::new_v4();
        let guard = active_runs.register(run_id, Some(reuse_key.into()), "vm0/default".into());
        assert!(notify.notified().now_or_never().is_some());
        let publisher = guard.reuse_publisher();
        let provider = Arc::new(RecordingProvider::default());
        let profiles = test_profiles();
        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
        let hb = HeartbeatContext::new(HeartbeatContextInit {
            idle_pool: &idle_pool,
            runner_hostname: None,
            sandbox_op_reporter: None,
            runner_identity: test_runner_identity(),
            group: "vm0/test",
            profiles: &profiles,
            budget: &budget,
            provider: provider.clone(),
            active_runs: &active_runs,
            home_cache_snapshot: HomeCacheStateSnapshot::new(),
            wss_ingress_service_probe: Arc::new(|| Box::pin(async { false })),
        });

        send_heartbeat(&hb, RunnerMode::Running, 1, HeartbeatRequest::ordinary())
            .await
            .unwrap();
        assert!(publisher.mark_finalizing(std::time::Instant::now()));
        send_heartbeat(&hb, RunnerMode::Running, 2, HeartbeatRequest::ordinary())
            .await
            .unwrap();
        let mut pool = idle_pool.lock().await;
        let in_flight_hb = hb.clone();
        let in_flight = tokio::spawn(async move {
            send_heartbeat(
                &in_flight_hb,
                RunnerMode::Running,
                3,
                HeartbeatRequest::ordinary(),
            )
            .await
            .unwrap();
        });
        // The task takes the active snapshot then waits for the pool lock.
        tokio::task::yield_now().await;
        let candidate = ParkedIdleCandidateBuilder::new(
            reuse_key,
            ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
        )
        .with_last_completed_at("2026-06-01T00:00:00.000Z")
        .build();
        assert!(matches!(pool.park(candidate), ParkResult::Parked));
        assert!(publisher.publish_exact_sandbox());
        drop(pool);
        in_flight.await.unwrap();
        send_heartbeat(&hb, RunnerMode::Running, 4, HeartbeatRequest::ordinary())
            .await
            .unwrap();

        let heartbeats = provider
            .heartbeats
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(heartbeats[0].active_reuse_producers[0].run_id, run_id);
        assert_eq!(heartbeats[0].active_reuse_producers[0].reuse_key, reuse_key);
        assert!(heartbeats[0].held_sandbox_states.is_empty());
        assert_eq!(heartbeats[1].active_reuse_producers[0].run_id, run_id);
        assert_eq!(heartbeats[2].active_reuse_producers[0].run_id, run_id);
        assert_eq!(heartbeats[2].held_sandbox_states[0].reuse_key, reuse_key);
        assert!(heartbeats[3].active_reuse_producers.is_empty());
        assert_eq!(heartbeats[3].held_sandbox_states[0].reuse_key, reuse_key);
    }

    #[test]
    fn held_sandbox_states_filter_active_reuse_keys() {
        let active_runs = test_active_runs();
        let active_guard = active_runs.register(
            runner_types::ids::RunId::new_v4(),
            Some("thread-active".into()),
            "vm0/default".into(),
        );
        let states = vec![
            HeldSandboxState {
                reuse_key: "thread-active".into(),
                last_completed_at: "2026-06-01T00:00:01.000Z".into(),
                reusable_sandbox: ReusableSandboxState {
                    profile: "vm0/default".into(),
                    history_generation_run_id: None,
                },
            },
            HeldSandboxState {
                reuse_key: "thread-held".into(),
                last_completed_at: "2026-06-01T00:00:02.000Z".into(),
                reusable_sandbox: ReusableSandboxState {
                    profile: "vm0/default".into(),
                    history_generation_run_id: None,
                },
            },
        ];

        let filtered = filter_current_held_sandbox_states(
            states.clone(),
            &active_runs,
            Some("thread-claimed"),
        );

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].reuse_key, "thread-held");

        assert!(active_guard.reuse_publisher().publish_exact_sandbox());
        let filtered = filter_current_held_sandbox_states(states, &active_runs, None);
        assert_eq!(filtered.len(), 2);
        assert_eq!(filtered[0].reuse_key, "thread-active");
        assert_eq!(filtered[1].reuse_key, "thread-held");
    }

    #[test]
    fn heartbeat_running_count_excludes_idle() {
        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
        let _leases = [
            ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
            ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
        ];
        let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
        assert!(matches!(
            pool.park(make_parked_candidate("sess-1", &budget)),
            ParkResult::Parked,
        ));
        let profiles = test_profiles();

        let state = collect_heartbeat_state(
            test_snapshot_metadata(),
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );
        assert_eq!(state.running_count, 2);
        assert!(state.held_sandbox_states.is_empty());
    }

    #[test]
    fn heartbeat_running_count_all_idle() {
        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
        let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
        assert!(matches!(
            pool.park(make_parked_candidate("sess-1", &budget)),
            ParkResult::Parked,
        ));
        assert!(matches!(
            pool.park(make_parked_candidate("sess-2", &budget)),
            ParkResult::Parked,
        ));
        let profiles = test_profiles();

        let state = collect_heartbeat_state(
            test_snapshot_metadata(),
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );
        assert_eq!(state.running_count, 0);
    }

    #[test]
    #[should_panic(expected = "substituted leases must belong to the target resource budget")]
    fn heartbeat_rejects_foreign_pool_budget() {
        let budget = ResourceBudget::new(8, 32768, 1.0, 4);
        let foreign_budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
        let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
        assert!(matches!(
            pool.park(make_parked_candidate("sess-1", &foreign_budget)),
            ParkResult::Parked,
        ));
        assert_eq!(pool.len(), 1);
        let profiles = test_profiles();

        collect_heartbeat_state(
            test_snapshot_metadata(),
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );
    }
}
