//! Concrete retained runtime reactor above the existing domain owners.
//!
//! The executable owns validated configuration, early signal registration,
//! image/base-directory locks and live registry composition. It supplies
//! concrete factory plans and domain handles, plus its release/logging policy.
//! Runtime entry still publishes initial status, binds prune control, awaits
//! provider readiness and creates factories before announcing readiness.
//!
//! Local siblings own startup/rollback, factory lifecycle, claim/discovery, job
//! dispatch, terminal logging, prune admission and signal consumption. Adjacent Supervisor modules
//! retain their admission/finalization/heartbeat/orphan policies; Network owns
//! MITM recovery. No executable types, upward dependencies, caller futures,
//! copied provider fixtures or normal-feature test hooks are required.
//!
//! Important invariants:
//! - one process owns the canonical `base_dir` lock;
//! - lifecycle signals are registered before slow startup work;
//! - discovery is pinned across `select!` ticks so heartbeat and lifecycle
//!   branches do not restart polling;
//! - heartbeat and status retry tasks run independently of the reactor so its
//!   inline resource waits cannot strand a queued task ahead of it;
//! - home-cache watcher work is pinned across reactor turns so async
//!   metadata classification cannot lose already-drained kernel events;
//! - routine home-cache GC is independently scheduled and single-flight, and
//!   its host-global completion marker is coordinated through the collector lock;
//! - the first routine heartbeat tick is deferred;
//! - teardown drains heartbeat work and drops discovery before provider
//!   shutdown.
//!
//! See `docs/runner/runner-reactor-progress.md` for the shared-resource audit and
//! cancellation/teardown ownership rules.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sandbox::SandboxRuntime;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::dns;
use crate::duration::duration_ms as saturated_duration_ms;
use crate::executor::{ExecutorConfig, RunnerPreSpawnConcurrency};
#[cfg(test)]
use crate::home_image_cache::HomeImageCache;
use crate::idle_pool::ParkingGate;
#[cfg(test)]
use crate::idle_pool::{IdlePool, IdlePoolConfig};
use crate::kmsg_log;
use crate::lifecycle::{LifecycleController, RunnerMode};
use crate::network_log_drain::DrainableLineReaderExit;
#[cfg(test)]
use crate::network_log_drain::NetworkLogDrainCoordinator;
#[cfg(test)]
use crate::network_log_manager::NetworkLogManager;
use crate::proxy;
use crate::resource_budget::ResourceBudget;
use crate::status::StatusTracker;
use error::{ReactorError as RunnerError, ReactorResult as RunnerResult};
use runner_host::paths::HomePaths;
#[cfg(test)]
use runner_host::paths::RunnerPaths;
use runner_host::runner_process_identity::RunnerProcessIdentity;
#[cfg(test)]
use runner_provider::JobCandidate;
use runner_provider::{JobProvider, RunCancellationRegistry};
#[cfg(test)]
use runner_types::ids::RunId;

mod claim_tasks;
mod claimed_home_wait;
pub mod error;
mod factory_lifecycle;
mod finalizing_claim;
mod heartbeat;
mod home_cache_observation;
mod home_cache_refresh;
mod idle_memory;
mod job_discovery;
mod job_spawn;
mod job_terminal_log;
mod maintenance;
mod pending_candidate;
mod prune_idle;
mod sandbox_recovery;
pub(crate) mod signals;
mod soft_drain;
mod startup;

use crate::blank_pool::{BlankPoolReplenisher, BlankProfile};
use crate::heartbeat::{HEARTBEAT_PERIOD, HeartbeatContext, HeartbeatContextInit};
use crate::idle_lifecycle::{IdleDestroyTracker, SharedIdlePool, drain_idle_pool};
#[cfg(test)]
use crate::orphan_reap::OrphanReapProcessDiscovery;
use crate::orphan_reap::{OrphanReapMode, OrphanedActiveRuns};
use claim_tasks::ClaimTasks;
use factory_lifecycle::{shutdown_factory_instances, shutdown_runtime};
use heartbeat::heartbeat_profiles;
use home_cache_observation::HomeCacheObservationEvent;
use idle_memory::IdleMemoryReclaimer;
use job_discovery::{AdmissionContext, DiscoveredJob};
use job_spawn::{JobResult, SpawnContext, handle_job_result};
use maintenance::{MaintenanceCompletion, MaintenanceTasks};
use pending_candidate::PendingCandidate;
use runner_lifecycle::active_runs::ActiveRuns;
use runner_lifecycle::home_image_cache::snapshot::HomeCacheStateSnapshot;
use runner_network::proxy::MitmRecovery;
pub use signals::EarlySignals;
use signals::{SignalController, SignalHandlerTask, handle_stopping_signal, recv_handler_task};

const READY_DIRECT_CANDIDATE_DRAIN_LIMIT: usize = 8;
/// Bounds routine cache-budget and stale-state cleanup without returning full scans to promotions.
const HOME_CACHE_GC_PERIOD: Duration = Duration::from_secs(60);
/// Bounds authoritative state recovery from missed home-cache observations.
const HOME_CACHE_RECONCILIATION_PERIOD: Duration = Duration::from_secs(60);
const HOME_CACHE_PRESSURE_PERIOD: Duration = Duration::from_secs(5);
/// Staggers the first state inventory from the first routine cache GC.
const HOME_CACHE_RECONCILIATION_INITIAL_DELAY: Duration = Duration::from_secs(30);

async fn sleep_until_optional_instant(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
        None => std::future::pending().await,
    }
}

enum MaintenanceTrigger {
    Interval(tokio::time::Interval),
    #[cfg(test)]
    Manual(mpsc::UnboundedReceiver<()>),
}

impl MaintenanceTrigger {
    fn interval(period: Duration) -> Self {
        let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        Self::Interval(interval)
    }

    fn reset(&mut self) {
        match self {
            Self::Interval(interval) => interval.reset(),
            #[cfg(test)]
            Self::Manual(_) => {}
        }
    }

    async fn tick(&mut self) {
        match self {
            Self::Interval(interval) => {
                interval.tick().await;
            }
            #[cfg(test)]
            Self::Manual(receiver) => {
                receiver
                    .recv()
                    .await
                    .expect("manual maintenance sender should remain open");
            }
        }
    }
}

struct TeardownTimer {
    start: Instant,
}

impl TeardownTimer {
    fn start() -> Self {
        let timer = Self {
            start: Instant::now(),
        };
        info!("teardown started");
        timer
    }

    fn duration_ms(duration: Duration) -> u64 {
        saturated_duration_ms(duration)
    }

    fn elapsed_ms(&self) -> u64 {
        Self::duration_ms(self.start.elapsed())
    }

    fn phase_start(&self, phase: &'static str) -> runner_host::cleanup_progress::CleanupProgress {
        let phase_start = runner_host::cleanup_progress::CleanupProgress::start(
            "runner",
            phase,
            runner_host::cleanup_progress::CleanupIdentity::Runner,
        );
        info!(
            phase,
            elapsed_ms = self.elapsed_ms(),
            "teardown phase started"
        );
        phase_start
    }

    fn phase_complete(
        &self,
        phase: &'static str,
        phase_start: runner_host::cleanup_progress::CleanupProgress,
    ) {
        info!(
            phase,
            phase_ms = Self::duration_ms(phase_start.elapsed()),
            elapsed_ms = self.elapsed_ms(),
            "teardown phase complete"
        );
    }

    fn event(&self, phase: &'static str) {
        info!(
            phase,
            elapsed_ms = self.elapsed_ms(),
            "teardown phase event"
        );
    }
}

async fn abort_signal_handler_task(handler_task: SignalHandlerTask, context: &'static str) {
    match handler_task.abort_and_wait().await {
        Err(error) if error.is_cancelled() => {}
        Err(error) => {
            warn!(error = %error, context, "signal handler task failed during abort");
        }
        Ok(()) => {
            warn!(context, "signal handler task exited before abort completed");
        }
    }
}

/// Owned resources and policy at the existing boot-to-runtime boundary.
/// Test observation state is deliberately private and compiled only for this
/// owner's unit target; dependency callers never inherit it through cfg(test).
pub struct RunConfig {
    pub runner: RunnerInfo,
    pub paths: RunPaths,
    pub sandbox_runtime: SandboxRuntimeConfig,
    pub capacity: CapacityPolicy,
    pub shared: RunnerSharedState,
    pub provider: ProviderState,
    pub sandbox_op_reporter: Option<runner_storage::SandboxOpReporter>,
    pub proxy: ProxyState,
    pub exec_config: Arc<ExecutorConfig>,
    pub shutdown: ShutdownHandles,
    pub usage_flush_tx: mpsc::Sender<()>,
    pub usage_flush_rx: mpsc::Receiver<()>,
    pub signals: SignalState,
    pub orphan_reap: OrphanReapState,
    pub diagnostic_error_tail_max_bytes: usize,
    #[cfg(test)]
    test_hooks: RunTestHooks,
}

/// Only the per-profile data actually consumed by runtime orchestration.
#[derive(Clone)]
pub struct RuntimeProfile {
    pub vcpu: u32,
    pub memory_mb: u32,
    pub rootfs_hash: String,
    pub rootfs_disk_mb: u32,
    pub home_disk_mb: u32,
    pub factory_config: sandbox::FactoryConfig,
}

/// Process identity and profile plans from the executable composition root.
pub struct RunnerInfo {
    pub identity: RunnerProcessIdentity,
    pub group: String,
    pub profiles: BTreeMap<String, RuntimeProfile>,
    /// Executable release, never Supervisor's package version.
    pub release: &'static str,
}

pub struct RunPaths {
    pub home: HomePaths,
    pub base_dir: PathBuf,
}

pub struct SandboxRuntimeConfig {
    pub runtime: Box<dyn SandboxRuntime>,
}

pub struct CapacityPolicy {
    pub budget: Arc<ResourceBudget>,
    pub min_vcpu: u32,
    pub min_memory_mb: u32,
    pub max_idle: usize,
    pub device_rate_limits: Option<sandbox::DeviceRateLimits>,
}

pub struct RunnerSharedState {
    pub idle_pool: SharedIdlePool,
    pub parking_gate: ParkingGate,
    pub status: Arc<StatusTracker>,
    pub active_runs: ActiveRuns,
    pub reuse_state_notify: Arc<tokio::sync::Notify>,
}

pub struct ProviderState {
    pub provider: Arc<dyn JobProvider>,
    /// Cancellation registrations shared with the provider's external events.
    pub cancel_tokens: RunCancellationRegistry,
    pub cancel: CancellationToken,
}

pub struct ProxyState {
    pub mitm: proxy::MitmProxy,
    pub mitm_crash_rx: tokio::sync::mpsc::Receiver<()>,
}

pub struct ShutdownHandles {
    pub kmsg_handle: kmsg_log::KmsgHandle,
    pub dns_handle: dns::DnsProxy,
}

pub struct SignalState {
    pub signal_source: SignalSource,
}

/// Runtime orphan observation; the executable cannot supply test snapshots.
#[derive(Default)]
pub struct OrphanReapState {
    /// Deterministic process snapshot for orphan-reaper tests. Production leaves
    /// this unset and scans `/proc`.
    #[cfg(test)]
    process_discovery: Option<OrphanReapProcessDiscovery>,
}

impl OrphanReapState {
    async fn reap(
        &self,
        orphans: &OrphanedActiveRuns,
        idle_pool: &SharedIdlePool,
        status: &StatusTracker,
        mode: OrphanReapMode,
    ) {
        #[cfg(test)]
        crate::orphan_reap::reap_orphaned_active_runs_with_discovery(
            orphans,
            idle_pool,
            status,
            mode,
            self.process_discovery.as_ref(),
        )
        .await;
        #[cfg(not(test))]
        crate::orphan_reap::reap_orphaned_active_runs(orphans, idle_pool, status, mode).await;
    }
}

#[cfg(test)]
struct RunTestHooks {
    outer_job_panic: Option<OuterJobPanicPoint>,
    test_observer: StartLoopTestObserver,
    before_initial_home_cache_scan: Option<StartLoopTestGate>,
    after_initial_home_cache_scan: Option<StartLoopTestGate>,
    manual_routine_heartbeat_rx: Option<mpsc::UnboundedReceiver<()>>,
    manual_home_cache_gc_rx: Option<mpsc::UnboundedReceiver<()>>,
    manual_home_cache_pressure_rx: Option<mpsc::UnboundedReceiver<()>>,
    manual_idle_memory_rx: Option<mpsc::UnboundedReceiver<()>>,
    host_memory_source:
        Option<Arc<dyn runner_lifecycle::host_memory_operations::MemoryObservationSource>>,
}

pub enum SignalSource {
    /// Real signals pre-registered at the top of `run_start`. `run()`
    /// spawns the `SignalController` task that consumes them.
    Real(EarlySignals),
    /// Test-supplied controller. `run()` does not spawn a handler task and
    /// the caller drives `mode_tx` itself. Constructed only by `mod tests`
    /// below; non-test code matches on it but never builds it.
    #[cfg(test)]
    Override(SignalController),
}

#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
enum StartLoopEvent {
    BudgetExhaustedReactorEntered,
    RoutineHeartbeatRequested {
        mode: RunnerMode,
    },
    HomeCacheChangeObserved,
    HomeCacheGcTickConsumed,
    HomeCachePressureTickConsumed,
    IdleMemoryTickConsumed,
    IdleMemoryCompleted,
    ClaimsDrainEntered,
    MaintenanceDrainEntered,
    HomeInventoryDrainEntered,
    RunningJobsDrainEntered,
    DestroyTasksDrainEntered,
    DestroyTasksDrainCompleted,
    FinalizingCapacityWaitEntered {
        run_id: RunId,
    },
    HomeReadinessRecheckCompleted {
        run_id: RunId,
        ready: bool,
    },
    ReservedPreparingCommitted {
        run_id: RunId,
    },
    ActiveRunStatusPublished {
        run_id: RunId,
    },
    ExecutorCompleted {
        run_id: RunId,
        discovered_cli_agent_session_id: Option<String>,
        sandbox_reuse_disposition: crate::executor::SandboxReuseDisposition,
    },
    BeforeIdlePoolOwnershipTransfer {
        run_id: RunId,
    },
    SandboxParkedForReuse {
        run_id: RunId,
        reuse_key: String,
    },
    UsageFlushRequested,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct StartLoopCursor(usize);

#[cfg(test)]
#[derive(Clone, Default)]
struct StartLoopTestGate {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

#[cfg(test)]
impl StartLoopTestGate {
    async fn enter_and_wait(&self) {
        self.entered.notify_one();
        self.release.notified().await;
    }

    async fn wait_entered(&self, timeout: Duration, context: &str) {
        tokio::time::timeout(timeout, self.entered.notified())
            .await
            .unwrap_or_else(|_| panic!("runner did not reach {context} within {timeout:?}"));
    }

    fn release(&self) {
        self.release.notify_one();
    }
}

#[cfg(test)]
#[derive(Clone, Default)]
struct StartLoopTestObserver {
    inner: Arc<StartLoopTestObserverInner>,
}

#[cfg(test)]
#[derive(Default)]
struct StartLoopTestObserverInner {
    events: std::sync::Mutex<Vec<StartLoopEvent>>,
    notify: tokio::sync::Notify,
    reserved_preparing_gate: std::sync::Mutex<Option<StartLoopTestGate>>,
}

#[cfg(test)]
impl StartLoopTestObserver {
    fn record(&self, event: StartLoopEvent) {
        self.inner
            .events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(event);
        self.inner.notify.notify_waiters();
    }

    fn cursor(&self) -> StartLoopCursor {
        let events = self
            .inner
            .events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        StartLoopCursor(events.len())
    }

    async fn wait_for<T>(
        &self,
        timeout: Duration,
        context: &'static str,
        mut predicate: impl FnMut(&StartLoopEvent) -> Option<T> + Send,
    ) -> T {
        let (value, _) = self
            .wait_after(StartLoopCursor(0), timeout, context, &mut predicate)
            .await;
        value
    }

    // Keep predicate ownership with callers while sharing the waiting future.
    async fn wait_after<T>(
        &self,
        cursor: StartLoopCursor,
        timeout: Duration,
        context: &'static str,
        predicate: &mut (dyn FnMut(&StartLoopEvent) -> Option<T> + Send),
    ) -> (T, StartLoopCursor) {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.inner.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            {
                let events = self
                    .inner
                    .events
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                assert!(
                    cursor.0 <= events.len(),
                    "start-loop observer cursor {} is past event history length {}",
                    cursor.0,
                    events.len()
                );
                for (offset, event) in events[cursor.0..].iter().enumerate() {
                    if let Some(value) = predicate(event) {
                        return (value, StartLoopCursor(cursor.0 + offset + 1));
                    }
                }
            }

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            assert!(
                !remaining.is_zero(),
                "runner did not observe {context} within {timeout:?}"
            );
            let observed = tokio::time::timeout(remaining, notified).await;
            assert!(
                observed.is_ok(),
                "runner did not observe {context} within {timeout:?}"
            );
        }
    }

    fn notify_budget_exhausted_reactor(&self) {
        self.record(StartLoopEvent::BudgetExhaustedReactorEntered);
    }

    fn notify_routine_heartbeat_requested(&self, mode: RunnerMode) {
        self.record(StartLoopEvent::RoutineHeartbeatRequested { mode });
    }

    fn notify_home_cache_change_observed(&self) {
        self.record(StartLoopEvent::HomeCacheChangeObserved);
    }

    fn notify_destroy_tasks_drain_entered(&self) {
        self.record(StartLoopEvent::DestroyTasksDrainEntered);
    }

    fn notify_destroy_tasks_drain_completed(&self) {
        self.record(StartLoopEvent::DestroyTasksDrainCompleted);
    }

    fn destroy_tasks_drain_was_completed(&self) -> bool {
        self.inner
            .events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .any(|event| matches!(event, StartLoopEvent::DestroyTasksDrainCompleted))
    }

    fn notify_finalizing_capacity_wait_entered(&self, run_id: RunId) {
        self.record(StartLoopEvent::FinalizingCapacityWaitEntered { run_id });
    }

    fn notify_before_idle_pool_ownership_transfer(&self, run_id: RunId) {
        self.record(StartLoopEvent::BeforeIdlePoolOwnershipTransfer { run_id });
    }

    fn notify_active_run_status_published(&self, run_id: RunId) {
        self.record(StartLoopEvent::ActiveRunStatusPublished { run_id });
    }

    fn gate_reserved_preparing_commit(&self) -> StartLoopTestGate {
        let gate = StartLoopTestGate::default();
        *self
            .inner
            .reserved_preparing_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(gate.clone());
        gate
    }

    async fn notify_reserved_preparing_committed(&self, run_id: RunId) {
        self.record(StartLoopEvent::ReservedPreparingCommitted { run_id });
        let gate = self
            .inner
            .reserved_preparing_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some(gate) = gate {
            gate.enter_and_wait().await;
        }
    }

    fn active_run_status_was_published(&self, run_id: RunId) -> bool {
        self.inner
            .events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .any(|event| {
                matches!(
                    event,
                    StartLoopEvent::ActiveRunStatusPublished {
                        run_id: observed_run_id
                    } if *observed_run_id == run_id
                )
            })
    }

    fn notify_sandbox_parked_for_reuse(&self, run_id: RunId, reuse_key: String) {
        self.record(StartLoopEvent::SandboxParkedForReuse { run_id, reuse_key });
    }

    fn notify_usage_flush_requested(&self) {
        self.record(StartLoopEvent::UsageFlushRequested);
    }

    async fn wait_budget_exhausted_reactor(&self, timeout: Duration) {
        self.wait_for(timeout, "budget-exhausted reactor entry", |event| {
            matches!(event, StartLoopEvent::BudgetExhaustedReactorEntered).then_some(())
        })
        .await;
    }

    async fn wait_routine_heartbeat_requested_after(
        &self,
        cursor: StartLoopCursor,
        mode: RunnerMode,
        timeout: Duration,
    ) -> StartLoopCursor {
        let ((), cursor) = self
            .wait_after(cursor, timeout, "routine heartbeat request", &mut |event| {
                matches!(
                    event,
                    StartLoopEvent::RoutineHeartbeatRequested {
                        mode: observed_mode,
                    } if *observed_mode == mode
                )
                .then_some(())
            })
            .await;
        cursor
    }

    async fn wait_home_cache_change_observed_after(
        &self,
        cursor: StartLoopCursor,
        timeout: Duration,
    ) -> StartLoopCursor {
        let ((), cursor) = self
            .wait_after(cursor, timeout, "home-cache change", &mut |event| {
                matches!(event, StartLoopEvent::HomeCacheChangeObserved).then_some(())
            })
            .await;
        cursor
    }

    async fn wait_destroy_tasks_drain_entered(&self, timeout: Duration) {
        self.wait_for(timeout, "destroy-task drain", |event| {
            matches!(event, StartLoopEvent::DestroyTasksDrainEntered).then_some(())
        })
        .await;
    }

    async fn wait_destroy_tasks_drain_completed(&self, timeout: Duration) {
        self.wait_for(timeout, "destroy-task drain completion", |event| {
            matches!(event, StartLoopEvent::DestroyTasksDrainCompleted).then_some(())
        })
        .await;
    }

    async fn wait_finalizing_capacity_wait_entered(&self, run_id: RunId, timeout: Duration) {
        self.wait_for(timeout, "finalizing capacity wait", |event| match event {
            StartLoopEvent::FinalizingCapacityWaitEntered {
                run_id: observed_run_id,
            } if *observed_run_id == run_id => Some(()),
            _ => None,
        })
        .await
    }

    async fn wait_before_idle_pool_ownership_transfer(&self, run_id: RunId, timeout: Duration) {
        self.wait_for(
            timeout,
            "idle-pool ownership transfer attempt",
            |event| match event {
                StartLoopEvent::BeforeIdlePoolOwnershipTransfer {
                    run_id: observed_run_id,
                } if *observed_run_id == run_id => Some(()),
                _ => None,
            },
        )
        .await
    }

    async fn wait_sandbox_parked_for_reuse(&self, run_id: RunId, timeout: Duration) -> String {
        self.wait_for(timeout, "sandbox parked for reuse", |event| match event {
            StartLoopEvent::SandboxParkedForReuse {
                run_id: observed_run_id,
                reuse_key,
            } if *observed_run_id == run_id => Some(reuse_key.clone()),
            _ => None,
        })
        .await
    }

    async fn wait_usage_flush_requested(&self, timeout: Duration) {
        self.wait_for(timeout, "usage flush request", |event| {
            matches!(event, StartLoopEvent::UsageFlushRequested).then_some(())
        })
        .await
    }
}

#[cfg(test)]
mod start_loop_observer_tests;

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OuterJobPanicPoint {
    ClaimedWithoutSandbox,
    ClaimedActivation,
    ActiveOrUnknown,
    IdlePoolOwned,
    HandoffOwned,
    DestroyCompleted,
}

#[cfg(test)]
fn maybe_panic_outer_job(
    configured: Option<OuterJobPanicPoint>,
    point: OuterJobPanicPoint,
    run_id: RunId,
) {
    if configured == Some(point) {
        panic!("simulated outer job panic at {point:?} for {run_id}");
    }
}

#[cfg(test)]
fn finalization_test_hooks(
    configured: Option<OuterJobPanicPoint>,
    observer: StartLoopTestObserver,
) -> crate::sandbox_finalization::FinalizationTestHooks {
    use crate::sandbox_finalization::{FinalizationTestEvent, FinalizationTestHooks};

    FinalizationTestHooks {
        on_event: Some(Arc::new(move |event| match event {
            FinalizationTestEvent::BeforeIdlePoolOwnershipTransfer { run_id } => {
                observer.notify_before_idle_pool_ownership_transfer(run_id);
            }
            FinalizationTestEvent::SandboxParkedForReuse { run_id, reuse_key } => {
                observer.notify_sandbox_parked_for_reuse(run_id, reuse_key);
            }
            FinalizationTestEvent::HandoffOwned { run_id } => {
                maybe_panic_outer_job(configured, OuterJobPanicPoint::HandoffOwned, run_id);
            }
            FinalizationTestEvent::IdlePoolOwned { run_id } => {
                maybe_panic_outer_job(configured, OuterJobPanicPoint::IdlePoolOwned, run_id);
            }
            FinalizationTestEvent::DestroyCompleted { run_id } => {
                maybe_panic_outer_job(configured, OuterJobPanicPoint::DestroyCompleted, run_id);
            }
        })),
    }
}

#[derive(Clone, Copy)]
enum RequiredNetworkLogComponent {
    Kmsg,
    Dns,
}

impl RequiredNetworkLogComponent {
    fn label(self) -> &'static str {
        match self {
            Self::Kmsg => "kmsg",
            Self::Dns => "dns",
        }
    }

    fn stop_source(self) -> &'static str {
        match self {
            Self::Kmsg => "kmsg-monitor",
            Self::Dns => "dns-monitor",
        }
    }

    fn terminal_message(
        self,
        result: &Result<DrainableLineReaderExit, tokio::task::JoinError>,
    ) -> String {
        match self {
            Self::Kmsg => match result {
                Ok(exit) => format!("kmsg monitor exited unexpectedly: {exit:?}"),
                Err(error) => format!("kmsg monitor task failed: {error}"),
            },
            Self::Dns => match result {
                Ok(DrainableLineReaderExit::Cancelled) => {
                    "dns monitor exited unexpectedly: Cancelled".to_string()
                }
                Ok(DrainableLineReaderExit::DrainChannelClosed) => {
                    "dns monitor exited unexpectedly: DrainChannelClosed".to_string()
                }
                Ok(DrainableLineReaderExit::Eof { during_drain }) => {
                    format!(
                        "dns monitor exited unexpectedly: Eof {{ during_drain: {during_drain} }}"
                    )
                }
                Ok(DrainableLineReaderExit::ReadError {
                    during_drain,
                    error,
                }) => {
                    format!(
                        "dns monitor exited unexpectedly: ReadError {{ during_drain: {during_drain}, error: {error} }}"
                    )
                }
                Err(error) => format!("dns monitor task failed: {error}"),
            },
        }
    }
}

async fn handle_required_network_log_completion(
    component: RequiredNetworkLogComponent,
    result: Result<DrainableLineReaderExit, tokio::task::JoinError>,
    cancel: &CancellationToken,
    cancel_tokens: &RunCancellationRegistry,
    lifecycle: &LifecycleController,
) -> Option<RunnerError> {
    let mode = lifecycle.current_mode();
    if matches!(mode, RunnerMode::Stopping | RunnerMode::Stopped) {
        None
    } else {
        let message = component.terminal_message(&result);
        error!(
            component = component.label(),
            ?mode,
            result = ?result,
            "required runner component exited"
        );
        handle_stopping_signal(component.stop_source(), cancel, cancel_tokens, lifecycle).await;
        Some(RunnerError::Internal(message))
    }
}

fn handle_mitm_crash(recovery: &mut MitmRecovery) {
    error!(
        r#type = "usage_underbilling",
        reason = "mitm_restart_in_memory_usage_risk",
        underbilling_class = "risk",
        component = "runner",
        "mitmproxy exited unexpectedly, scheduling restart"
    );
    recovery.on_crash();
}

async fn handle_mitm_recovery_failure(
    recovery: &mut MitmRecovery,
    crash_rx: &mut mpsc::Receiver<()>,
    cancel: &CancellationToken,
    cancel_tokens: &RunCancellationRegistry,
    lifecycle: &LifecycleController,
) {
    recovery.stop_retries(crash_rx);
    handle_stopping_signal("mitm-recovery", cancel, cancel_tokens, lifecycle).await;
}

/// Run the concrete retained reactor and perform its ordered resource teardown.
pub async fn run(config: RunConfig) -> error::ReactorResult<()> {
    let RunConfig {
        runner,
        paths,
        sandbox_runtime,
        capacity,
        shared,
        provider: provider_state,
        sandbox_op_reporter,
        proxy,
        exec_config,
        shutdown,
        usage_flush_tx,
        mut usage_flush_rx,
        signals,
        orphan_reap,
        diagnostic_error_tail_max_bytes,
        #[cfg(test)]
        mut test_hooks,
    } = config;
    let active_runs = shared.active_runs.clone();
    let home_cache_snapshot = HomeCacheStateSnapshot::new();
    let projected_heartbeat_profiles = heartbeat_profiles(&runner.profiles);
    let hb_ctx = HeartbeatContext::new(HeartbeatContextInit {
        idle_pool: &shared.idle_pool,
        runner_hostname: exec_config.runner_hostname.as_deref(),
        runner_identity: runner.identity,
        group: &runner.group,
        profiles: &projected_heartbeat_profiles,
        budget: &capacity.budget,
        provider: Arc::clone(&provider_state.provider),
        active_runs: &active_runs,
        home_cache_snapshot: home_cache_snapshot.clone(),
        sandbox_op_reporter: sandbox_op_reporter.clone(),
    });
    let Some(started) = startup::start(
        startup::StartupResources {
            sandbox_runtime,
            proxy,
            shutdown,
        },
        startup::StartupContext {
            runner: &runner,
            paths: &paths,
            shared: &shared,
            provider: &provider_state,
            exec_config: &exec_config,
        },
        signals,
        startup::StartupInventory {
            heartbeat: hb_ctx,
            snapshot: &home_cache_snapshot,
            profiles: &projected_heartbeat_profiles,
            reporter: sandbox_op_reporter.as_ref(),
            #[cfg(test)]
            test_hooks: &test_hooks,
        },
    )
    .await?
    else {
        return Ok(());
    };
    let startup::StartedRunner {
        resources:
            startup::StartupResources {
                sandbox_runtime: SandboxRuntimeConfig { mut runtime },
                proxy:
                    ProxyState {
                        mut mitm,
                        mut mitm_crash_rx,
                    },
                shutdown:
                    ShutdownHandles {
                        mut kmsg_handle,
                        mut dns_handle,
                    },
            },
        signal:
            SignalController {
                mut mode_rx,
                lifecycle,
                handler_task: mut signal_handler_task,
            },
        mut factories,
        prune_listener,
        prune_admission,
        startup_mode,
        mut home_cache_observation,
        mut heartbeat,
    } = started;

    let mut jobs: JoinSet<JobResult> = JoinSet::new();

    if startup_mode == RunnerMode::Running {
        info!(
            runner_release = runner.release,
            group = %runner.group,
            effective_vcpu = capacity.budget.effective_vcpu(),
            effective_memory_mb = capacity.budget.effective_memory_mb(),
            max_concurrent = capacity.budget.max_concurrent(),
            "runner started"
        );
    } else {
        info!(
            runner_release = runner.release,
            group = %runner.group,
            mode = ?startup_mode,
            "runner startup completed after lifecycle signal"
        );
    }

    // -----------------------------------------------------------------------
    // Mitmproxy crash-restart state
    // -----------------------------------------------------------------------
    let mut mitm_recovery = MitmRecovery::new();

    // -----------------------------------------------------------------------
    // Heartbeat interval — same first-tick delay as above. Integration tests
    // inject manual ticks so their assertions do not advance unrelated Runner
    // timers.
    // -----------------------------------------------------------------------
    #[cfg(test)]
    let mut heartbeat_tick = match test_hooks.manual_routine_heartbeat_rx.take() {
        Some(receiver) => MaintenanceTrigger::Manual(receiver),
        None => MaintenanceTrigger::interval(HEARTBEAT_PERIOD),
    };
    #[cfg(not(test))]
    let mut heartbeat_tick = MaintenanceTrigger::interval(HEARTBEAT_PERIOD);

    // -----------------------------------------------------------------------
    // Main loop
    // -----------------------------------------------------------------------
    // Notification channel: spawned jobs signal the main loop to send an
    // immediate heartbeat after reusable state changes, so the server
    // learns about a held reusable sandbox or home image cache without
    // waiting for the next 10-second tick.
    let reuse_state_notify = Arc::clone(&shared.reuse_state_notify);
    let idle_destroy_tracker = IdleDestroyTracker::new(Arc::clone(&reuse_state_notify));
    let orphaned_active_runs = OrphanedActiveRuns::new();
    let mut orphan_reap_tick = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(10),
        Duration::from_secs(10),
    );
    orphan_reap_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // Pin the discover future so it survives cancellation by other select!
    // branches (heartbeat, lifecycle changes, etc.). Without pinning, heartbeat
    // (10s) cancels discover() on every tick, restarting its provider-owned
    // wait from scratch before reconciliation can run. See #8747.
    let mut discover_fut = Box::pin(provider_state.provider.discover());

    let mut current_mode = startup_mode;
    let blank_profiles = runner
        .profiles
        .iter()
        .map(|(name, profile)| {
            (
                name.clone(),
                BlankProfile {
                    vcpu: profile.vcpu,
                    memory_mb: profile.memory_mb,
                    rootfs_hash: profile.rootfs_hash.clone(),
                    home_disk_mb: profile.home_disk_mb,
                },
            )
        })
        .collect();
    let mut blank_pool = BlankPoolReplenisher::new(
        &blank_profiles,
        &factories,
        &capacity.budget,
        capacity.max_idle,
        capacity.device_rate_limits.clone(),
    );
    let spawn_ctx = SpawnContext {
        runner_id: runner.identity.runner_id().to_string(),
        diagnostic_error_tail_max_bytes,
        provider: Arc::clone(&provider_state.provider),
        exec_config: Arc::clone(&exec_config),
        idle_pool: Arc::clone(&shared.idle_pool),
        status: Arc::clone(&shared.status),
        orphaned_active_runs: orphaned_active_runs.clone(),
        parking_gate: shared.parking_gate.clone(),
        idle_destroy_tracker: idle_destroy_tracker.clone(),
        reuse_state_notify: Arc::clone(&reuse_state_notify),
        usage_flush_tx,
        active_runs: active_runs.clone(),
        pre_spawn_concurrency: RunnerPreSpawnConcurrency::default(),
        blank_pool_diagnostics: blank_pool.diagnostics(),
        budget: Arc::clone(&capacity.budget),
        home_cache_snapshot,
        device_rate_limits: capacity.device_rate_limits.clone(),
        sandbox_op_reporter,
        #[cfg(test)]
        outer_job_panic: test_hooks.outer_job_panic,
        #[cfg(test)]
        test_observer: test_hooks.test_observer.clone(),
    };
    let mut claim_tasks = ClaimTasks::new(AdmissionContext {
        runner_identity: runner.identity,
        mode_rx: mode_rx.clone(),
        cancel_tokens: provider_state.cancel_tokens.clone(),
        spawn_ctx: spawn_ctx.clone(),
    });
    let mut blank_pool_tick = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(1),
        Duration::from_secs(1),
    );
    blank_pool_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    #[cfg(test)]
    let mut home_cache_gc_tick = match test_hooks.manual_home_cache_gc_rx.take() {
        Some(receiver) => MaintenanceTrigger::Manual(receiver),
        None => MaintenanceTrigger::interval(HOME_CACHE_GC_PERIOD),
    };
    #[cfg(not(test))]
    let mut home_cache_gc_tick = MaintenanceTrigger::interval(HOME_CACHE_GC_PERIOD);
    #[cfg(test)]
    let mut home_cache_pressure_tick = match test_hooks.manual_home_cache_pressure_rx.take() {
        Some(receiver) => MaintenanceTrigger::Manual(receiver),
        None => MaintenanceTrigger::interval(HOME_CACHE_PRESSURE_PERIOD),
    };
    #[cfg(not(test))]
    let mut home_cache_pressure_tick = MaintenanceTrigger::interval(HOME_CACHE_PRESSURE_PERIOD);
    let mut home_cache_reconciliation_tick = tokio::time::interval_at(
        tokio::time::Instant::now() + HOME_CACHE_RECONCILIATION_INITIAL_DELAY,
        HOME_CACHE_RECONCILIATION_PERIOD,
    );
    home_cache_reconciliation_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut maintenance = MaintenanceTasks::new();
    let mut idle_memory = IdleMemoryReclaimer::new(
        runner
            .profiles
            .values()
            .map(|profile| profile.memory_mb)
            .fold(capacity.min_memory_mb, u32::max),
    );
    #[cfg(test)]
    if let Some(source) = test_hooks.host_memory_source.take() {
        idle_memory.set_source(source);
    }
    #[cfg(test)]
    let mut idle_memory_tick = match test_hooks.manual_idle_memory_rx.take() {
        Some(receiver) => MaintenanceTrigger::Manual(receiver),
        None => MaintenanceTrigger::interval(idle_memory::SAMPLE_PERIOD),
    };
    #[cfg(not(test))]
    let mut idle_memory_tick = MaintenanceTrigger::interval(idle_memory::SAMPLE_PERIOD);
    idle_memory.request(
        &shared.idle_pool,
        &shared.status,
        &idle_destroy_tracker,
        &mode_rx,
    );
    let mut soft_drain = soft_drain::SoftDrain::new();
    let mut pending_candidate = PendingCandidate::new();
    let mut ready_direct_candidates_left = 0;
    let mut terminal_error = None;
    loop {
        let mode = *mode_rx.borrow_and_update();
        if mode != current_mode {
            current_mode = mode;
            if let Err(error) = shared.status.set_mode(mode).await {
                handle_stopping_signal(
                    "status persistence failure",
                    &provider_state.cancel,
                    &provider_state.cancel_tokens,
                    &lifecycle,
                )
                .await;
                terminal_error = Some(RunnerError::Internal(format!(
                    "persist runner mode {mode:?}: {error}"
                )));
                break;
            }
        }
        pending_candidate.clear_if_inactive(mode);
        blank_pool.cancel_if_inactive(mode);
        match mode {
            RunnerMode::Starting => {}
            // Stopped should not normally reach here — teardown sets it and
            // exits. Treat as a safety break.
            RunnerMode::Stopped => break,
            // Stopping entry — skip the Draining soft-drain and go straight
            // to teardown.
            RunnerMode::Stopping => break,
            RunnerMode::Draining => {
                if claim_tasks.is_empty() {
                    // Settle admission before removing inventory that an
                    // in-flight claim may return or need for activation. Then
                    // release idle budget and keep servicing running jobs.
                    soft_drain
                        .start_if_needed(&idle_destroy_tracker, &shared.idle_pool, &shared.status)
                        .await;
                }
                if soft_drain.batch_completed() && jobs.is_empty() && claim_tasks.is_empty() {
                    // Watch updates can coalesce a resume and renewed drain.
                    // Recheck inventory under the same exclusive access that
                    // commits natural stop so a prior batch cannot skip it.
                    let pool = shared.idle_pool.lock().await;
                    if !pool.is_empty() {
                        soft_drain.inventory_changed();
                        continue;
                    }
                    // Natural drain complete — commit to Stopping so teardown
                    // is observable to heartbeat and status.json. Guard the
                    // transition on `mode == Draining` so a concurrent SIGUSR2
                    // resume wins instead of being overwritten.
                    info!("draining: jobs drained, transitioning to Stopping");
                    let transitioned = lifecycle.stop_after_natural_drain();
                    drop(pool);
                    if transitioned {
                        // Live observability: fire an immediate "stopping"
                        // heartbeat before teardown removes the runner.
                        if let Err(error) = heartbeat.flush(RunnerMode::Stopping).await {
                            terminal_error = Some(error.into());
                            break;
                        }
                    }
                    continue;
                }
            }
            RunnerMode::Running => {
                soft_drain.resume();
            }
        }

        if idle_memory.can_prepare_blank() {
            blank_pool
                .maybe_start(
                    mode,
                    &shared.idle_pool,
                    &capacity.budget,
                    &exec_config.pre_spawn_admission,
                    &shared.status,
                    &idle_destroy_tracker,
                )
                .await;
        } else {
            blank_pool.cancel_preparation();
        }

        // Spawn background restart task when timer fires
        mitm_recovery.maybe_start(&mut mitm, &mut mitm_crash_rx);

        if let Some(candidate) = pending_candidate.take_retry(mode, claim_tasks.has_capacity()) {
            claim_tasks.submit(DiscoveredJob { candidate }, &runner.profiles, &factories);
        }
        let can_discover = if matches!(mode, RunnerMode::Running) {
            // A selected finalizing successor can claim against an exact
            // in-process predecessor without reserving fresh capacity.
            capacity
                .budget
                .can_afford(capacity.min_vcpu, capacity.min_memory_mb)
                || !shared.idle_pool.lock().await.is_empty()
                || active_runs.has_reusable_run()
        } else {
            false
        };
        #[cfg(test)]
        if matches!(mode, RunnerMode::Running) && !can_discover {
            test_hooks.test_observer.notify_budget_exhausted_reactor();
        }
        let can_discover = can_discover && claim_tasks.has_capacity();
        let mitm_retry_deadline = mitm_recovery.retry_deadline();
        let heartbeat_sending = heartbeat.is_sending();
        let pending_finalizing_deadline =
            pending_candidate.expiry_deadline(mode, claim_tasks.has_capacity());
        tokio::select! {
            result = soft_drain.join(), if soft_drain.is_in_flight() => {
                if let Err(error) = soft_drain.complete(result, &lifecycle) {
                    warn!(%error, "idle drain cleanup producer lost");
                    handle_stopping_signal(
                        "idle drain cleanup producer lost",
                        &provider_state.cancel,
                        &provider_state.cancel_tokens,
                        &lifecycle,
                    ).await;
                    terminal_error.get_or_insert_with(|| {
                        RunnerError::Internal("idle drain cleanup producer lost".to_owned())
                    });
                }
            }
            connection = prune_listener.accept() => {
                match connection {
                    Ok(stream) => {
                        if let Ok(permit) = Arc::clone(&prune_admission).try_acquire_owned() {
                            let context = prune_idle::PruneIdleContext {
                                identity: runner.identity,
                                pool: Arc::clone(&shared.idle_pool),
                                status: Arc::clone(&shared.status),
                                lifecycle: lifecycle.clone(),
                                tracker: idle_destroy_tracker.clone(),
                            };
                            idle_destroy_tracker.spawn_cleanup(
                                prune_idle::handle(stream, context, permit), "operator_prune_idle",
                            );
                        }
                        // Busy requests are closed without admitting any work.
                    }
                    Err(error) => {
                        terminal_error = Some(error.into());
                        break;
                    }
                }
            }
            result = blank_pool.wait_for_preparation(), if blank_pool.is_preparing() => {
                if let Some(result) = result {
                    blank_pool
                        .finish_preparation(
                            result,
                            &shared.idle_pool,
                            &shared.status,
                            &idle_destroy_tracker,
                        )
                        .await;
                }
            }
            _ = blank_pool_tick.tick() => {
                blank_pool.request_attempt();
            }
            // Job discovery via provider (Ably/filesystem wakeups + reconciliation).
            // The future is pinned outside the loop so other reactor branches
            // do not cancel and restart its internal wait timer. See #8747.
            discovered = &mut discover_fut, if can_discover => {
                let Some(candidate) = discovered else { break };
                // Future completed — create a new one for the next discovery.
                discover_fut = Box::pin(provider_state.provider.discover());
                let candidate = pending_candidate.for_admission(candidate);
                claim_tasks.submit(DiscoveredJob { candidate }, &runner.profiles, &factories);
                ready_direct_candidates_left = READY_DIRECT_CANDIDATE_DRAIN_LIMIT;
            }
            candidate = provider_state.provider.try_discover_ready(),
                if can_discover && ready_direct_candidates_left > 0 =>
            {
                if let Some(candidate) = candidate {
                    ready_direct_candidates_left -= 1;
                    let candidate = pending_candidate.for_admission(candidate);
                    claim_tasks.submit(DiscoveredJob { candidate }, &runner.profiles, &factories);
                } else {
                    ready_direct_candidates_left = 0;
                }
            }
            result = claim_tasks.progress(),
                if !claim_tasks.is_empty() || claim_tasks.is_preparing() =>
            {
                let Some(result) = result else { continue };
                let result = match claim_tasks.consume(result, &mut jobs) {
                    Ok(result) => result,
                    Err(failure) => {
                        let (reason, error) = failure.into_stopping_failure();
                        handle_stopping_signal(
                            reason,
                            &provider_state.cancel,
                            &provider_state.cancel_tokens,
                            &lifecycle,
                        ).await;
                        terminal_error = Some(error);
                        break;
                    }
                };
                if let Some(candidate) = result.pending_candidate {
                    pending_candidate.retain(candidate, *mode_rx.borrow());
                }
                let live_mode = *mode_rx.borrow();
                if result.needs_reuse_state_refresh
                    && matches!(live_mode, RunnerMode::Running | RunnerMode::Draining)
                {
                    heartbeat.request(live_mode)?;
                }
            }
            // Observe independently scheduled heartbeat work without cancelling
            // it when another branch wins or waits for a shared resource.
            result = heartbeat.wait_for_send(), if heartbeat_sending => {
                let live_mode = *mode_rx.borrow();
                if let Err(error) = result.and_then(|()| heartbeat.finish_send(live_mode)) {
                    handle_stopping_signal(
                        "heartbeat task failure",
                        &provider_state.cancel,
                        &provider_state.cancel_tokens,
                        &lifecycle,
                    ).await;
                    terminal_error = Some(error.into());
                    break;
                }
            }
            observation = home_cache_observation.wait() => {
                match observation {
                    HomeCacheObservationEvent::Change(change) => {
                        #[cfg(test)]
                        test_hooks
                            .test_observer
                            .notify_home_cache_change_observed();
                        let live_mode = *mode_rx.borrow();
                        if matches!(live_mode, RunnerMode::Running | RunnerMode::Draining) {
                            home_cache_observation.request_refresh(change);
                        }
                    }
                    HomeCacheObservationEvent::Refreshed(change) => {
                        let live_mode = *mode_rx.borrow();
                        if matches!(live_mode, RunnerMode::Running | RunnerMode::Draining) {
                            heartbeat.request_home_cache(live_mode, change)?;
                        }
                    }
                    HomeCacheObservationEvent::Unavailable(error) => {
                        warn!(error = %error, "home cache watcher failed; using periodic reconciliation");
                    }
                    HomeCacheObservationEvent::RefreshFailed(error) => {
                        handle_stopping_signal(
                            "home cache refresh task failure",
                            &provider_state.cancel,
                            &provider_state.cancel_tokens,
                            &lifecycle,
                        ).await;
                        terminal_error = Some(error);
                        break;
                    }
                }
            }
            _ = home_cache_reconciliation_tick.tick(),
                if exec_config.home_cache.is_some() =>
            {
                let live_mode = *mode_rx.borrow();
                if matches!(live_mode, RunnerMode::Running | RunnerMode::Draining) {
                    home_cache_observation.request_reconciliation();
                }
            }
            completion = maintenance.wait() => {
                let (result, stopping_reason) = match completion {
                    MaintenanceCompletion::HomeCachePressure(result) => {
                        (result, "home cache pressure task failure")
                    }
                    MaintenanceCompletion::HomeCacheGc(result) => {
                        home_cache_gc_tick.reset();
                        (result, "home cache GC task failure")
                    }
                    MaintenanceCompletion::StatusRetry(result) => {
                        (result, "status retry task failure")
                    }
                };
                if let Err(error) = result {
                    handle_stopping_signal(
                        stopping_reason,
                        &provider_state.cancel,
                        &provider_state.cancel_tokens,
                        &lifecycle,
                    ).await;
                    terminal_error = Some(error);
                    break;
                }
            }
            result = idle_memory.wait() => {
                if let Err(error) = result {
                    warn!(%error, "host memory reclamation stopped; foreground work continues");
                }
                #[cfg(test)]
                test_hooks.test_observer.record(StartLoopEvent::IdleMemoryCompleted);
            }
            _ = idle_memory_tick.tick() => {
                idle_memory.request(&shared.idle_pool, &shared.status, &idle_destroy_tracker, &mode_rx);
                #[cfg(test)]
                test_hooks.test_observer.record(StartLoopEvent::IdleMemoryTickConsumed);
            }
            _ = home_cache_gc_tick.tick() => {
                maintenance.request_home_cache_gc(exec_config.home_cache.as_ref(), &mode_rx);
                #[cfg(test)]
                test_hooks.test_observer.record(StartLoopEvent::HomeCacheGcTickConsumed);
            }
            _ = home_cache_pressure_tick.tick(), if exec_config.home_cache.is_some() => {
                maintenance.request_home_cache_pressure(exec_config.home_cache.as_ref(), &mode_rx);
                #[cfg(test)]
                test_hooks.test_observer.record(StartLoopEvent::HomeCachePressureTickConsumed);
            }
            // Mode changes (signals)
            _ = mode_rx.changed() => {}
            // Signal handler task should run until teardown aborts it. If it
            // exits early, stop the runner because OS signals are no longer
            // being consumed.
            result = recv_handler_task(&mut signal_handler_task) => {
                match result {
                    Ok(()) => warn!("signal handler task exited unexpectedly"),
                    Err(error) => warn!(error = %error, "signal handler task failed"),
                }
                handle_stopping_signal(
                    "signal-handler-task",
                    &provider_state.cancel,
                    &provider_state.cancel_tokens,
                    &lifecycle,
                ).await;
            }
            result = kmsg_handle.wait() => {
                kmsg_handle.start_child_cleanup();
                if let Some(error) = handle_required_network_log_completion(
                    RequiredNetworkLogComponent::Kmsg,
                    result,
                    &provider_state.cancel,
                    &provider_state.cancel_tokens,
                    &lifecycle,
                ).await {
                    terminal_error = Some(error);
                }
            }
            result = dns_handle.wait() => {
                dns_handle.start_child_cleanup();
                if let Some(error) = handle_required_network_log_completion(
                    RequiredNetworkLogComponent::Dns,
                    result,
                    &provider_state.cancel,
                    &provider_state.cancel_tokens,
                    &lifecycle,
                ).await {
                    terminal_error = Some(error);
                }
            }
            // Reap completed jobs promptly in all live modes. Without this,
            // normal Running mode can retain completed JoinSet entries and
            // stale cancellation registrations until drain, budget exhaustion,
            // or shutdown.
            result = jobs.join_next(), if !jobs.is_empty() => {
                handle_job_result(result).await;
                if !orphaned_active_runs.is_empty() {
                    orphan_reap.reap(
                        &orphaned_active_runs,
                        &shared.idle_pool,
                        &shared.status,
                        OrphanReapMode::Immediate,
                    ).await;
                }
            }
            Some(()) = usage_flush_rx.recv() => {
                #[cfg(test)]
                test_hooks.test_observer.notify_usage_flush_requested();
                mitm.request_usage_flush();
            }
            // Reconcile active runs left visible after an outer job-task panic.
            _ = orphan_reap_tick.tick(), if !orphaned_active_runs.is_empty() => {
                orphan_reap.reap(
                    &orphaned_active_runs,
                    &shared.idle_pool,
                    &shared.status,
                    OrphanReapMode::ConfirmAbsent,
                ).await;
            }
            // Mitmproxy crash detection
            Some(()) = mitm_crash_rx.recv() => {
                handle_mitm_crash(&mut mitm_recovery);
            }
            // Mitmproxy restart result (background task)
            result = mitm_recovery.wait(&mut mitm) => {
                if let Err(error) = result {
                    handle_mitm_recovery_failure(
                        &mut mitm_recovery, &mut mitm_crash_rx, &provider_state.cancel,
                        &provider_state.cancel_tokens, &lifecycle,
                    ).await;
                    terminal_error = Some(error.into());
                }
            }
            // A late crash can arm a timer during recovery. Keep that request,
            // but do not spin on an expired timer while its owner is in flight.
            () = sleep_until_optional_instant(mitm_retry_deadline) => {}
            // Heartbeat: report runner state to the server
            _ = heartbeat_tick.tick() => {
                let live_mode = *mode_rx.borrow();
                heartbeat.request(live_mode)?;
                maintenance.request_status_retry(&shared.status);
                #[cfg(test)]
                test_hooks
                    .test_observer
                    .notify_routine_heartbeat_requested(live_mode);
            }
            _ = sleep_until_optional_instant(pending_finalizing_deadline) =>
            {
                let Some(candidate) = pending_candidate.take_expired() else {
                    continue;
                };
                claim_tasks.submit(DiscoveredJob { candidate }, &runner.profiles, &factories);
            }
            // Immediate heartbeat after reusable state changes eliminates the
            // up-to-10s blind spot for reuse-aware routing.
            _ = reuse_state_notify.notified(), if matches!(mode, RunnerMode::Running | RunnerMode::Draining) => {
                let live_mode = *mode_rx.borrow();
                pending_candidate.request_retry(live_mode);
                let source = match live_mode {
                    RunnerMode::Running if can_discover => "main",
                    RunnerMode::Running => "budget_exhausted",
                    RunnerMode::Draining => "draining",
                    RunnerMode::Starting | RunnerMode::Stopping | RunnerMode::Stopped => {
                        "inactive"
                    }
                };
                if matches!(live_mode, RunnerMode::Running | RunnerMode::Draining) {
                    info!(source, "reusable state triggered immediate heartbeat");
                    heartbeat.request(live_mode)?;
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Shutdown — drain idle pool, release discovery resources, then drain running jobs
    // -----------------------------------------------------------------------
    let teardown = TeardownTimer::start();
    drop(prune_listener);

    // Discovery may complete with None on cancellation before the mode-change
    // branch wins. Publish Stopping before any prolonged teardown in that case.
    // Ending discovery must not turn an otherwise natural job drain into hard
    // cancellation; keep lifecycle signal handling authoritative for that.
    let phase = teardown.phase_start("status_stopping");
    lifecycle.close_parking();
    if let Err(error) = shared.status.set_mode(RunnerMode::Stopping).await {
        error!(%error, "failed to publish stopping status before teardown");
        terminal_error.get_or_insert_with(|| {
            RunnerError::Internal(format!("persist stopping status before teardown: {error}"))
        });
    }
    teardown.phase_complete("status_stopping", phase);

    // Release retained discovery before settling claims. Admission/activation tasks run
    // independently and must finish before idle or provider teardown; successful
    // outcomes still enter the existing activation/executor ownership path.
    drop(discover_fut);
    teardown.event("drop_discover_fut");
    home_cache_observation.stop_watching();
    let phase = teardown.phase_start("claims_drain");
    #[cfg(test)]
    test_hooks
        .test_observer
        .record(StartLoopEvent::ClaimsDrainEntered);
    while let Some(result) = claim_tasks.next().await {
        if let Err(failure) = claim_tasks.consume(result, &mut jobs) {
            let (reason, error) = failure.into_stopping_failure();
            handle_stopping_signal(
                reason,
                &provider_state.cancel,
                &provider_state.cancel_tokens,
                &lifecycle,
            )
            .await;
            terminal_error.get_or_insert(error);
        }
    }
    drop(claim_tasks);
    teardown.phase_complete("claims_drain", phase);

    let phase = teardown.phase_start("blank_pool_shutdown");
    blank_pool.shutdown(&idle_destroy_tracker).await;
    teardown.phase_complete("blank_pool_shutdown", phase);

    let phase = teardown.phase_start("home_inventory_drain");
    #[cfg(test)]
    test_hooks
        .test_observer
        .record(StartLoopEvent::HomeInventoryDrainEntered);
    if let Err(error) = home_cache_observation.drain().await {
        terminal_error.get_or_insert(error);
    }
    teardown.phase_complete("home_inventory_drain", phase);

    let phase = teardown.phase_start("heartbeat_drain");
    if let Err(error) = heartbeat.drain().await {
        error!(%error, "failed to drain heartbeat task");
        terminal_error.get_or_insert(error.into());
    }
    let terminal_heartbeat = heartbeat.into_terminal_heartbeat();
    teardown.phase_complete("heartbeat_drain", phase);

    let phase = teardown.phase_start("maintenance_drain");
    #[cfg(test)]
    test_hooks
        .test_observer
        .record(StartLoopEvent::MaintenanceDrainEntered);
    if let Err(error) = idle_memory.drain().await {
        terminal_error.get_or_insert(error);
    }
    if let Err(error) = maintenance.drain().await {
        terminal_error.get_or_insert(error);
    }
    teardown.phase_complete("maintenance_drain", phase);

    // Drain idle pool first — these sandboxes hold budget reservations. This
    // also clears `idle_sandboxes` in status.json so the final snapshot is
    // consistent with the empty pool.
    lifecycle.close_parking();
    let phase = teardown.phase_start("drain_idle_pool");
    drain_idle_pool(
        &shared.idle_pool,
        &shared.status,
        &idle_destroy_tracker,
        "shutdown",
    )
    .await;
    teardown.phase_complete("drain_idle_pool", phase);

    let phase = teardown.phase_start("provider_shutdown");
    provider_state.provider.shutdown().await;
    teardown.phase_complete("provider_shutdown", phase);

    // Send final heartbeat with Stopping so the server stops routing jobs
    // to this runner immediately, without waiting for TTL expiry.
    let phase = teardown.phase_start("final_heartbeat");
    terminal_heartbeat.send().await;
    teardown.phase_complete("final_heartbeat", phase);

    let remaining = jobs.len();
    let phase = teardown.phase_start("running_jobs_drain");
    #[cfg(test)]
    test_hooks
        .test_observer
        .record(StartLoopEvent::RunningJobsDrainEntered);
    if remaining > 0 {
        info!(remaining, "waiting for running jobs to finish");
        while !jobs.is_empty() {
            mitm_recovery.maybe_start(&mut mitm, &mut mitm_crash_rx);
            let mitm_retry_deadline = mitm_recovery.retry_deadline();

            tokio::select! {
                result = jobs.join_next() => {
                    handle_job_result(result).await;
                    if !orphaned_active_runs.is_empty() {
                        orphan_reap.reap(
                            &orphaned_active_runs,
                            &shared.idle_pool,
                            &shared.status,
                            OrphanReapMode::Immediate,
                        ).await;
                    }
                }
                Some(()) = usage_flush_rx.recv() => {
                    #[cfg(test)]
                    test_hooks.test_observer.notify_usage_flush_requested();
                    mitm.request_usage_flush();
                }
                Some(()) = mitm_crash_rx.recv() => {
                    handle_mitm_crash(&mut mitm_recovery);
                }
                result = mitm_recovery.wait(&mut mitm) => {
                    if let Err(error) = result {
                        handle_mitm_recovery_failure(
                            &mut mitm_recovery, &mut mitm_crash_rx, &provider_state.cancel,
                            &provider_state.cancel_tokens, &lifecycle,
                        ).await;
                        terminal_error.get_or_insert(error.into());
                    }
                }
                () = sleep_until_optional_instant(mitm_retry_deadline) => {}
            }
        }
    }
    teardown.phase_complete("running_jobs_drain", phase);
    if let Some(cache) = &exec_config.home_cache {
        let phase = teardown.phase_start("home_checkout_handoffs_drain");
        cache.drain_checkout_handoffs().await;
        teardown.phase_complete("home_checkout_handoffs_drain", phase);
    }
    if !orphaned_active_runs.is_empty() {
        let phase = teardown.phase_start("orphan_reap_shutdown_final");
        orphan_reap
            .reap(
                &orphaned_active_runs,
                &shared.idle_pool,
                &shared.status,
                OrphanReapMode::ShutdownFinal,
            )
            .await;
        teardown.phase_complete("orphan_reap_shutdown_final", phase);
    }
    // Wait for any in-flight destroy tasks (from capacity or profile-mismatch
    // eviction) so their factory Arcs are dropped before the
    // factory shutdown ownership preflight.
    let phase = teardown.phase_start("destroy_tasks_drain");
    #[cfg(test)]
    test_hooks
        .test_observer
        .notify_destroy_tasks_drain_entered();
    idle_destroy_tracker.close_and_wait().await;
    #[cfg(test)]
    test_hooks
        .test_observer
        .notify_destroy_tasks_drain_completed();
    teardown.phase_complete("destroy_tasks_drain", phase);
    let phase = teardown.phase_start("fresh_archive_delivery_shutdown");
    exec_config.fresh_archive_delivery.shutdown().await;
    teardown.phase_complete("fresh_archive_delivery_shutdown", phase);
    let phase = teardown.phase_start("background_fill_shutdown");
    exec_config.background_fill.shutdown().await;
    exec_config.decoded_cache.shutdown().await;
    teardown.phase_complete("background_fill_shutdown", phase);
    let phase = teardown.phase_start("finish_mitm_restart");
    if let Err(error) = mitm_recovery.finish_before_shutdown(&mut mitm).await {
        error!(%error, "failed to finish mitmproxy recovery");
        terminal_error.get_or_insert(error.into());
    }
    teardown.phase_complete("finish_mitm_restart", phase);
    if let Some(handler_task) = signal_handler_task.take() {
        abort_signal_handler_task(handler_task, "shutdown").await;
        teardown.event("signal_handler_aborted");
    }

    info!("shutting down factories");
    let phase = teardown.phase_start("shutdown_factory_instances");
    shutdown_factory_instances(&mut factories, Some(&teardown)).await?;
    teardown.phase_complete("shutdown_factory_instances", phase);
    if let Some(cache) = &exec_config.home_cache {
        let phase = teardown.phase_start("home_pressure_reclamation_drain");
        cache.drain_pressure_reclamation().await;
        teardown.phase_complete("home_pressure_reclamation_drain", phase);
    }

    // Keep the pool-scoped INPUT filters installed until dnsmasq is gone.
    // Runtime shutdown owns those filters, so it must follow DNS shutdown to
    // avoid exposing the wildcard listener between the two cleanup phases.
    let phase = teardown.phase_start("dns_stop");
    if let Err(error) = dns_handle.stop().await {
        error!(%error, "DNS cleanup failed during shutdown");
        terminal_error.get_or_insert(error.into());
    }
    teardown.phase_complete("dns_stop", phase);

    shutdown_runtime(runtime.as_mut(), Some(&teardown)).await;

    // Observe actual delivery work within the existing total shutdown budget.
    // Quiescence is not an all-delivered receipt; the addon retains final retry ownership.
    let phase = teardown.phase_start("wait_usage_flush");
    if let Some(target) = mitm.usage_flush_target() {
        target.drain().await;
    } else {
        info!("proxy is not running; skipping usage flush wait");
    }
    teardown.phase_complete("wait_usage_flush", phase);

    // Stop proxy after all jobs have drained and factory is shut down.
    let phase = teardown.phase_start("mitm_stop");
    if let Err(e) = mitm.stop().await {
        warn!(error = %e, "proxy stop failed");
    }
    teardown.phase_complete("mitm_stop", phase);

    // Stop the kmsg monitor and wait for the `dmesg -w` child process
    // to be killed and reaped.
    let phase = teardown.phase_start("kmsg_stop");
    if let Err(error) = kmsg_handle.stop().await {
        error!(%error, "kmsg cleanup failed during shutdown");
        terminal_error.get_or_insert(error.into());
    }
    teardown.phase_complete("kmsg_stop", phase);
    let phase = teardown.phase_start("status_stopped");
    if let Err(error) = shared.status.set_mode(RunnerMode::Stopped).await {
        warn!(%error, "failed to persist final stopped runner status");
    }
    if let Err(error) = shared.status.retry_unpublished_snapshot().await {
        warn!(%error, "failed to publish final runner status snapshot");
    }
    teardown.phase_complete("status_stopped", phase);
    info!(total_teardown_ms = teardown.elapsed_ms(), "runner stopped");

    if let Some(error) = terminal_error {
        Err(error)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests;
