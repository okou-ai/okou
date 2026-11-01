use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

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
    /// Publish a final snapshot without ordinary cache enrichment.
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
    /// Cancelling this wait retains the send; dropping its controller aborts it.
    pub async fn drain(&mut self) -> HeartbeatResult<()> {
        self.pending = None;
        if let Some(send) = self.in_flight.as_mut() {
            let result = send.await;
            self.in_flight = None;
            let _ = result.map_err(HeartbeatError::TaskFailed)?;
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
mod tests;
