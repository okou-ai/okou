//! `runner start` — run the long-lived worker loop.
//!
//! `run_start` registers lifecycle signals early, loads config, claims the
//! canonical runner `base_dir` lock, initializes shared resources, then enters
//! `run()`, the main reactor for discovery, heartbeats, job execution,
//! idle-pool maintenance, mitmproxy restart, and teardown.
//!
//! The sibling modules keep focused responsibilities out of this orchestration
//! file:
//! - `factory_lifecycle`: sandbox factory creation and shutdown.
//! - `idle_lifecycle`: idle-pool lifecycle, status updates, and destroy helpers.
//! - `identity`: persistent runner id storage.
//! - `job_discovery`: discovery branch handling and idle-reuse admission.
//! - `job_lifecycle`: cleanup, budget, and completion ownership state.
//! - `job_spawn`: claimed job task spawning, completion, and panic cleanup.
//! - `job_terminal_log`: terminal outcome tracing and diagnostic projection.
//! - `mitm_restart`: mitmproxy crash restart and backoff.
//! - `orphan_reap`: orphan active-run reconciliation.
//! - `ownership`: active/idle/orphan ownership transition ordering.
//! - `sandbox_finalization`: post-executor sandbox park/destroy finalization.
//! - `signals`: lifecycle signal registration, task ownership, and dispatch.
//!
//! Important invariants:
//! - one process owns the canonical `base_dir` lock;
//! - lifecycle signals are registered before slow startup work;
//! - discovery is pinned across `select!` ticks so heartbeat and lifecycle
//!   branches do not restart polling;
//! - heartbeat and status retry tasks run independently of the reactor so its
//!   inline resource waits cannot strand a queued task ahead of it;
//! - workspace-cache watcher work is pinned across reactor turns so async
//!   metadata classification cannot lose already-drained kernel events;
//! - routine workspace-cache GC is independently scheduled and single-flight, and
//!   its host-global cadence is coordinated through the capacity lock;
//! - the first routine heartbeat tick is deferred;
//! - teardown drains heartbeat work and drops discovery before provider
//!   shutdown.
//!
//! See `docs/runner-reactor-progress.md` for the shared-resource audit and
//! cancellation/teardown ownership rules.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use clap::Args;
use futures_util::future::BoxFuture;
use sandbox::{RuntimeProvider, SandboxRuntime};
use tokio::sync::mpsc;
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;
use tracing::{Instrument, error, info, warn};
use uuid::Uuid;

use crate::duration::duration_ms as saturated_duration_ms;
#[cfg(test)]
use crate::ids::RunId;

use crate::config::{self, ProfileConfig};
use crate::deps;
use crate::dns;
use crate::error::{RunnerError, RunnerResult};
use crate::executor::{
    ExecutorConfig, RunnerPreSpawnConcurrency, SessionHistoryCpuPool, SessionHistoryProbe,
};
use crate::host;
use crate::http::{HttpClient, HttpClientConfig};
use crate::idle_pool::{IdlePool, IdlePoolConfig, ParkingGate};
use crate::kmsg_log;
use crate::lifecycle::{LifecycleController, RunnerMode};
use crate::lock;
use crate::network_log_drain::{DrainableLineReaderExit, NetworkLogDrainCoordinator};
use crate::network_log_manager::NetworkLogManager;
use crate::paths::{HomePaths, LogPaths, RunnerPaths, touch_mtime};
use crate::pre_spawn_admission::PreSpawnAdmission;
use crate::prefetch;
use crate::provider::{
    ApiProvider, ApiProviderConfig, BuiltinFirewallCatalogCachePaths, ConnectorRuntimeSyncHandle,
    JobCandidate, JobProvider, LocalProvider, RunnerPreferenceRemovalReason,
};
use crate::proxy;
use crate::resource_budget::ResourceBudget;
use crate::retry::{RetryState, sleep_until_retry};
use crate::run_cancellation::{RunCancellationRegistration, RunCancellationRegistry};
use crate::runner_process_identity::RunnerProcessIdentity;
use crate::status::{StatusTracker, remove_stale_status_file};
use crate::workspace_image_cache::{
    WorkspaceCacheChange, WorkspaceCacheWatcher, WorkspaceImageCache,
};

mod active_runs;
mod blank_pool;
mod factory_lifecycle;
mod finalizing_claim;
mod heartbeat;
mod identity;
mod idle_lifecycle;
mod job_discovery;
mod job_lifecycle;
mod job_spawn;
mod job_terminal_log;
mod mitm_restart;
mod orphan_reap;
mod ownership;
mod prune_idle;
mod sandbox_finalization;
mod signals;

use active_runs::ActiveRuns;
use blank_pool::BlankPoolReplenisher;
use factory_lifecycle::{shutdown_factory_instances, shutdown_runtime, start_factories};
use heartbeat::{
    HEARTBEAT_PERIOD, HeartbeatContext, HeartbeatContextInit, HeartbeatController,
    HeartbeatSnapshotMetadata, WorkspaceCacheStateSnapshot, collect_heartbeat_state,
    refresh_initial_workspace_cache_snapshot,
};
use identity::load_runner_process_identity;
use idle_lifecycle::{IdleDestroyTracker, SharedIdlePool, drain_idle_pool};
use job_discovery::{DiscoveredJob, DiscoveredJobContext, handle_discovered_job};
use job_spawn::{SpawnContext, handle_job_result};
use mitm_restart::{
    MITM_BACKOFF_INITIAL, MITM_BACKOFF_MAX, MITM_MAX_CONSECUTIVE_FAILURES, MitmRestartHandle,
    finish_mitm_restart_before_shutdown, handle_mitm_restart_result, maybe_spawn_mitm_restart,
    recv_mitm_restart, stop_mitm_retries,
};
use orphan_reap::{
    OrphanReapMode, OrphanReapProcessDiscovery, OrphanedActiveRuns, reap_orphaned_active_runs,
};
use signals::{
    EarlySignals, SignalController, SignalHandlerTask, handle_stopping_signal, recv_handler_task,
};

const READY_DIRECT_CANDIDATE_DRAIN_LIMIT: usize = 8;
/// Bounds routine cache-budget and stale-state cleanup without returning full scans to promotions.
const WORKSPACE_CACHE_GC_PERIOD: Duration = Duration::from_secs(60);
/// Bounds authoritative state recovery from missed workspace-cache observations.
const WORKSPACE_CACHE_RECONCILIATION_PERIOD: Duration = Duration::from_secs(60);
/// Staggers the first state inventory from the first routine cache GC.
const WORKSPACE_CACHE_RECONCILIATION_INITIAL_DELAY: Duration = Duration::from_secs(30);

fn candidate_for_admission(
    candidate: JobCandidate,
    pending_candidate: &mut Option<JobCandidate>,
) -> JobCandidate {
    if let Some(pending) =
        pending_candidate.take_if(|pending| pending.run_id() == candidate.run_id())
    {
        info!(
            run_id = %candidate.run_id(),
            "duplicate finalizing candidate rechecks retained admission state"
        );
        pending
    } else {
        candidate
    }
}

fn retain_finalizing_candidate(
    pending_candidate: &mut Option<JobCandidate>,
    candidate: JobCandidate,
) {
    if pending_candidate.is_none() {
        *pending_candidate = Some(candidate);
    } else {
        info!(
            run_id = %candidate.run_id(),
            "finalizing candidate not retained because the pending slot is occupied"
        );
    }
}

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

type WorkspaceCacheChangeFuture = BoxFuture<
    'static,
    (
        WorkspaceCacheWatcher,
        RunnerResult<crate::workspace_image_cache::WorkspaceCacheChange>,
    ),
>;

fn workspace_cache_change_future(mut watcher: WorkspaceCacheWatcher) -> WorkspaceCacheChangeFuture {
    Box::pin(async move {
        let result = watcher.next_change().await;
        (watcher, result)
    })
}

async fn next_workspace_cache_change(
    future: &mut Option<WorkspaceCacheChangeFuture>,
) -> (
    WorkspaceCacheWatcher,
    RunnerResult<crate::workspace_image_cache::WorkspaceCacheChange>,
) {
    match future {
        Some(future) => future.await,
        None => std::future::pending().await,
    }
}

// Maintenance tasks are joined during teardown, not aborted: filesystem work
// may continue after its async future is dropped. If the reactor itself is
// cancelled, these tasks retain their locks until their work completes.
fn workspace_cache_gc_task(cache: WorkspaceImageCache) -> JoinHandle<()> {
    tokio::spawn(
        async move {
            match cache.try_routine_gc(WORKSPACE_CACHE_GC_PERIOD).await {
                Ok(Some(freed_bytes)) if freed_bytes > 0 => {
                    info!(freed_bytes, "periodic workspace image cache GC completed");
                }
                Ok(Some(_) | None) => {}
                Err(error) => warn!(%error, "periodic workspace image cache GC failed"),
            }
        }
        .in_current_span(),
    )
}

fn status_retry_task(status: Arc<StatusTracker>) -> JoinHandle<()> {
    tokio::spawn(
        async move {
            if let Err(error) = status.retry_unpublished_snapshot().await {
                warn!(%error, "failed to retry unpublished runner status");
            }
        }
        .in_current_span(),
    )
}

async fn next_maintenance_task(task: &mut Option<JoinHandle<()>>, name: &str) -> RunnerResult<()> {
    match task {
        Some(task) => task
            .await
            .map_err(|error| RunnerError::Internal(format!("{name} task failed: {error}"))),
        None => std::future::pending().await,
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

    fn phase_start(&self, phase: &'static str) -> crate::cleanup_progress::CleanupProgress {
        let phase_start = crate::cleanup_progress::CleanupProgress::start(
            "runner",
            phase,
            crate::cleanup_progress::CleanupIdentity::Runner,
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
        phase_start: crate::cleanup_progress::CleanupProgress,
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

#[derive(Args)]
pub struct StartArgs {
    /// Path to runner.yaml config file
    #[arg(long, short)]
    pub(crate) config: PathBuf,
    /// Okou API URL (overrides config; `OKOU_API_BACKEND_URL`)
    #[arg(long, env = "OKOU_API_BACKEND_URL", hide_env_values = true)]
    api_url: Option<String>,
    /// Runner authentication token (overrides config; `OKOU_RUNNER_TOKEN`)
    #[arg(long, env = "OKOU_RUNNER_TOKEN", hide_env_values = true)]
    token: Option<String>,
    /// Use local file queue provider instead of API (for testing)
    #[arg(long)]
    local: bool,
}

#[cfg(test)]
impl StartArgs {
    pub(crate) fn api_url_for_test(&self) -> Option<&str> {
        self.api_url.as_deref()
    }

    pub(crate) fn token_for_test(&self) -> Option<&str> {
        self.token.as_deref()
    }
}

struct LiveRunnerPublishResources<'a> {
    provider: &'a dyn JobProvider,
    runtime: &'a mut dyn SandboxRuntime,
    mitm: &'a mut proxy::MitmProxy,
    kmsg_handle: kmsg_log::KmsgHandle,
    dns_handle: dns::DnsProxy,
    memory_prefetch: &'a mut prefetch::MemoryPrefetchTasks,
    status: &'a StatusTracker,
}

struct StartupFailureResources<'a> {
    provider: &'a dyn JobProvider,
    runtime: Option<&'a mut dyn SandboxRuntime>,
    mitm: &'a mut proxy::MitmProxy,
    kmsg_handle: kmsg_log::KmsgHandle,
    dns_handle: dns::DnsProxy,
    memory_prefetch: &'a mut prefetch::MemoryPrefetchTasks,
    status: &'a StatusTracker,
}

struct DnsStartupResources<'a> {
    runtime_provider: &'a dyn RuntimeProvider,
    mitm: &'a mut proxy::MitmProxy,
    kmsg_handle: kmsg_log::KmsgHandle,
    memory_prefetch: &'a mut prefetch::MemoryPrefetchTasks,
    network_log_manager: NetworkLogManager,
    host_cpu_placement: sandbox::HostCpuPlacementConfig,
}

async fn start_runtime_with_dns<F, Fut>(
    resources: DnsStartupResources<'_>,
    mut start_dns: F,
) -> RunnerResult<(Box<dyn SandboxRuntime>, dns::DnsProxy, kmsg_log::KmsgHandle)>
where
    F: FnMut(dns::DnsPortReservation, String, NetworkLogManager) -> Fut,
    Fut: Future<Output = std::io::Result<dns::DnsProxy>>,
{
    let DnsStartupResources {
        runtime_provider,
        mitm,
        kmsg_handle,
        memory_prefetch,
        network_log_manager,
        host_cpu_placement,
    } = resources;

    const DNS_START_MAX_ATTEMPTS: usize = 3;
    let mut dns_start_attempt = 1;
    loop {
        let dns_port_reservation =
            dns::reserve_port().map_err(|e| RunnerError::Internal(format!("dns port: {e}")))?;
        let dns_port = dns_port_reservation.port();
        let mut runtime = runtime_provider
            .create_runtime(sandbox::RuntimeConfig {
                proxy_port: Some(mitm.port()),
                dns_port: Some(dns_port),
                host_cpu_placement: Some(host_cpu_placement),
            })
            .await
            .map_err(|e| RunnerError::Internal(format!("sandbox runtime: {e}")))?;

        let Some(dns_interface_pattern) = runtime.dns_interface_pattern().await else {
            memory_prefetch.cancel();
            runtime.shutdown().await;
            if let Err(e) = mitm.kill_now().await {
                warn!(error = %e, "failed to kill proxy after DNS interface resolution failed");
            }
            if let Err(error) = kmsg_handle.stop().await {
                warn!(%error, "failed to clean up network-log helper after startup failure");
            }
            memory_prefetch.drain().await;
            return Err(RunnerError::Internal(
                "sandbox runtime did not provide DNS interface pattern".into(),
            ));
        };

        match start_dns(
            dns_port_reservation,
            dns_interface_pattern,
            network_log_manager.clone(),
        )
        .await
        {
            Ok(handle) => {
                if let Err(e) = runtime.activate_dns_readiness().await {
                    memory_prefetch.cancel();
                    if let Err(error) = handle.stop().await {
                        warn!(%error, "failed to clean up network-log helper after startup failure");
                    }
                    runtime.shutdown().await;
                    if let Err(kill_error) = mitm.kill_now().await {
                        warn!(
                            error = %kill_error,
                            "failed to kill proxy after namespace DNS readiness failed"
                        );
                    }
                    if let Err(error) = kmsg_handle.stop().await {
                        warn!(%error, "failed to clean up network-log helper after startup failure");
                    }
                    memory_prefetch.drain().await;
                    return Err(RunnerError::Internal(format!(
                        "sandbox runtime DNS readiness: {e}"
                    )));
                }
                return Ok((runtime, handle, kmsg_handle));
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::AddrInUse
                    && dns_start_attempt < DNS_START_MAX_ATTEMPTS =>
            {
                warn!(
                    attempt = dns_start_attempt,
                    max_attempts = DNS_START_MAX_ATTEMPTS,
                    port = dns_port,
                    error = %e,
                    "dns proxy port was claimed before dnsmasq could bind; retrying with a fresh runtime",
                );
                runtime.shutdown().await;
                dns_start_attempt += 1;
            }
            Err(e) => {
                memory_prefetch.cancel();
                runtime.shutdown().await;
                if let Err(kill_error) = mitm.kill_now().await {
                    warn!(error = %kill_error, "failed to kill proxy after DNS startup failed");
                }
                if let Err(error) = kmsg_handle.stop().await {
                    warn!(%error, "failed to clean up network-log helper after startup failure");
                }
                memory_prefetch.drain().await;
                return Err(RunnerError::Internal(format!("dns proxy: {e}")));
            }
        }
    }
}

async fn publish_live_runner_instance_or_shutdown_startup_resources(
    home: &HomePaths,
    metadata: crate::live_runner_instances::LiveRunnerInstanceMetadata,
    resources: LiveRunnerPublishResources<'_>,
) -> RunnerResult<(
    crate::live_runner_instances::LiveRunnerInstanceHandle,
    kmsg_log::KmsgHandle,
    dns::DnsProxy,
)> {
    match crate::live_runner_instances::publish(home, metadata).await {
        Ok(handle) => Ok((handle, resources.kmsg_handle, resources.dns_handle)),
        Err(e) => {
            resources.memory_prefetch.cancel();
            resources.provider.shutdown().await;
            if let Err(error) = resources.dns_handle.stop().await {
                warn!(%error, "failed to clean up network-log helper after startup failure");
            }
            resources.runtime.shutdown().await;
            if let Err(kill_error) = resources.mitm.kill_now().await {
                warn!(error = %kill_error, "failed to kill proxy after live runner instance publish failed");
            }
            if let Err(error) = resources.kmsg_handle.stop().await {
                warn!(%error, "failed to clean up network-log helper after startup failure");
            }
            resources.memory_prefetch.drain().await;
            if let Err(status_error) = resources.status.set_mode(RunnerMode::Stopped).await {
                warn!(
                    error = %status_error,
                    "failed to persist stopped status after live runner publication failure"
                );
            }
            Err(e)
        }
    }
}

async fn shutdown_startup_resources_after_startup_failure(
    resources: StartupFailureResources<'_>,
    context: &'static str,
) {
    resources.memory_prefetch.cancel();
    resources.provider.shutdown().await;
    if let Err(error) = resources.dns_handle.stop().await {
        warn!(%error, "failed to clean up network-log helper after startup failure");
    }
    if let Some(runtime) = resources.runtime {
        runtime.shutdown().await;
    }
    if let Err(e) = resources.mitm.kill_now().await {
        warn!(error = %e, context, "failed to kill proxy after startup failed");
    }
    if let Err(error) = resources.kmsg_handle.stop().await {
        warn!(%error, "failed to clean up network-log helper after startup failure");
    }
    resources.memory_prefetch.drain().await;
    if let Err(error) = resources.status.set_mode(RunnerMode::Stopped).await {
        warn!(%error, context, "failed to persist stopped status after startup failure");
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

/// Load config and run the main poll loop.
pub async fn run_start(
    args: StartArgs,
    runtime_provider: &dyn RuntimeProvider,
) -> RunnerResult<()> {
    run_start_with_home(args, runtime_provider, HomePaths::new).await
}

async fn run_start_with_home(
    args: StartArgs,
    runtime_provider: &dyn RuntimeProvider,
    load_home: impl FnOnce() -> RunnerResult<HomePaths>,
) -> RunnerResult<()> {
    // Register lifecycle signals (SIGTERM/SIGINT/SIGUSR1/SIGUSR2) before
    // any slow startup work. Tokio's `signal()` installs the process-wide
    // `sigaction` handler on first call; until then the default disposition
    // (Term) applies, so a drain SIGUSR1 racing with `service install`
    // would kill the process and leave a restart that no one drains. See
    // issue #10416.
    let signals = EarlySignals::register()
        .map_err(|e| RunnerError::Internal(format!("register signal handlers: {e}")))?;

    let mut runner_config = config::load_for_start(&args.config, args.api_url.as_deref()).await?;
    let registry_config_path = tokio::fs::canonicalize(&args.config).await.map_err(|e| {
        RunnerError::Config(format!(
            "canonicalize config path {} for live runner registry: {e}",
            args.config.display()
        ))
    })?;

    // CLI / env overrides — take server out so we can mutate independently
    let mut server = runner_config.server.take().unwrap_or(config::ServerConfig {
        url: String::new(),
        token: String::new(),
    });
    if let Some(url) = args.api_url {
        server.url = url;
    }
    if let Some(token) = args.token {
        server.token = token;
    }

    let server = validate_server_config_for_start(server)?;

    let runner_host_env = crate::host_env::read_runner_host_env()?;
    let config::SandboxConfig {
        max_concurrent,
        concurrency_factor: yaml_concurrency_factor,
        max_idle,
    } = runner_config.sandbox;
    let (concurrency_factor, concurrency_factor_source) =
        crate::runtime_overrides::resolve_concurrency_factor(
            yaml_concurrency_factor,
            &runner_host_env,
        )?;
    if concurrency_factor_source.is_override() {
        info!(
            env_var = crate::host_env::RUNNER_CONCURRENCY_FACTOR_ENV,
            override_source = concurrency_factor_source.label(),
            concurrency_factor,
            yaml_concurrency_factor,
            "using host environment override for concurrency_factor"
        );
    }

    crate::private_fs::ensure_private_dir(&runner_config.base_dir).await?;

    // Exclusive lock — prevents two runner processes from sharing the same base_dir.
    // Canonicalize so that equivalent paths (e.g. with `..`) produce the same lock.
    let base_dir_canonical = runner_config.base_dir.canonicalize().map_err(|e| {
        RunnerError::Config(format!(
            "canonicalize base_dir {}: {e}",
            runner_config.base_dir.display()
        ))
    })?;
    let home = load_home()?;
    let mut base_dir_lock = lock::try_acquire(home.base_dir_lock(&base_dir_canonical))
        .await
        .map_err(|e| {
            RunnerError::Config(format!(
                "cannot lock base_dir {}: {e}",
                runner_config.base_dir.display()
            ))
        })?;
    // Write base_dir path into lock file so `runner gc` can discover workspace
    // directories even after all processes for this runner have died.
    {
        use std::io::{Seek, Write};
        if let Err(e) = base_dir_lock
            .seek(std::io::SeekFrom::Start(0))
            .and_then(|_| base_dir_lock.set_len(0))
            .and_then(|_| {
                base_dir_lock.write_all(base_dir_canonical.as_os_str().as_encoded_bytes())
            })
        {
            tracing::warn!(
                error = %e,
                "failed to write base_dir into lock file — runner gc may not discover orphaned workspaces"
            );
        }
    }
    let paths = RunnerPaths::new(runner_config.base_dir.clone());
    remove_stale_status_file(&paths.status()).await?;

    let runner_identity = load_runner_process_identity(&runner_config.base_dir).await?;
    info!(
        runner_id = %runner_identity.runner_id(),
        runner_release = crate::RUNNER_RELEASE,
        "runner identity"
    );

    // Shared locks on rootfs + snapshot per profile — allows `runner gc` to detect in-use resources.
    let resource_locks =
        config::lock_and_validate_runner_image_artifacts(&runner_config.profiles, &home).await?;
    for (_, profile_paths) in resource_locks.profile_paths() {
        touch_mtime(profile_paths.rootfs_paths().dir());
        touch_mtime(profile_paths.snapshot_paths().dir());
    }

    let log_paths = LogPaths::new(home.logs_dir());
    crate::log_file::ensure_log_dir(log_paths.dir()).map_err(|e| {
        RunnerError::Config(format!(
            "create logs_dir {}: {e}",
            log_paths.dir().display()
        ))
    })?;

    // Create provider inputs before startup resources are allocated. These
    // checks can fail due to config/filesystem state and should not leave
    // runtime-owned pools behind.
    let cancel = CancellationToken::new();
    let runner_client_session_id = Uuid::new_v4().to_string();
    let http = HttpClient::new(HttpClientConfig {
        api_url: server.url.clone(),
        vercel_bypass: std::env::var("VERCEL_AUTOMATION_BYPASS_SECRET").ok(),
        client_session_id: runner_client_session_id.clone(),
    })?;
    let background_fill = crate::storage_cache::StorageCacheBackgroundFillCoordinator::new()?;
    let hostname = runner_config.hostname;
    let group = runner_config.group;
    let cancel_tokens = RunCancellationRegistry::new();
    let local_group_dir = if args.local {
        let group_dir = home.groups_dir().join(&group);
        crate::local_queue::ensure_group_dir(&group_dir).map_err(|e| {
            RunnerError::Config(format!("create group dir {}: {e}", group_dir.display()))
        })?;
        for profile in runner_config.profiles.keys() {
            crate::local_queue::ensure_profile_jobs_dir(&group_dir, profile).map_err(|e| {
                RunnerError::Config(format!("create job dir for profile {profile}: {e}"))
            })?;
        }
        Some(group_dir)
    } else {
        None
    };

    // Resource budget from host resources + config.
    let host_cpus = host::cpu_count()?;
    let host_memory_mb = u32::try_from(host::memory_mb()?).map_err(|_| {
        RunnerError::Internal("host memory exceeds supported runner capacity".into())
    })?;
    let pre_spawn_capacity = host::pre_spawn_cpu_capacity(host_cpus)?;
    let pre_spawn_vcpu_tokens = pre_spawn_capacity.tokens();
    let pre_spawn_admission = PreSpawnAdmission::new(pre_spawn_vcpu_tokens)?;
    let budget = Arc::new(ResourceBudget::new(
        host_cpus as u32,
        host_memory_mb,
        concurrency_factor,
        max_concurrent,
    ));
    let host_cpu_placement = host_cpu_placement_config(&budget, args.local)?;
    let control_cpu_weight = host_cpu_placement.control_weight();
    let guests_cpu_weight = host_cpu_placement.guests_weight();
    info!(
        host_cpus,
        host_memory_mb,
        concurrency_factor,
        concurrency_factor_source = concurrency_factor_source.label(),
        yaml_concurrency_factor,
        max_concurrent,
        host_cpu_admission_reservation = budget.host_cpu_admission_reservation(),
        guest_cpu_admission_capacity = budget.guest_cpu_admission_capacity(),
        control_cpu_weight,
        guests_cpu_weight,
        host_cpu_placement_mode = ?host_cpu_placement.mode(),
        vcpu_admission_limit = budget.vcpu_admission_limit(),
        effective_vcpu = budget.effective_vcpu(),
        effective_memory_mb = budget.effective_memory_mb(),
        profiles = runner_config.profiles.len(),
        "resource budget initialized"
    );
    match pre_spawn_capacity {
        host::PreSpawnCpuCapacity::ExactPhysical(_) => {
            info!(
                capacity_source = "physical_topology",
                pre_spawn_vcpu_tokens = pre_spawn_admission.total_tokens(),
                host_logical_cpus = host_cpus,
                "pre-spawn admission initialized"
            );
        }
        host::PreSpawnCpuCapacity::ConservativeLogical(_) => {
            warn!(
                capacity_source = "logical_cpu_fallback",
                reason = "topology directories are absent for all online CPUs",
                pre_spawn_vcpu_tokens = pre_spawn_admission.total_tokens(),
                host_logical_cpus = host_cpus,
                "pre-spawn admission initialized"
            );
        }
    }

    let memory_prefetch_candidates = resource_locks
        .profile_paths()
        .map(|(name, profile_paths)| {
            let profile = runner_config.profiles.get(name).ok_or_else(|| {
                RunnerError::Internal(format!(
                    "missing runner profile for locked image artifacts {name}"
                ))
            })?;
            Ok(prefetch::MemoryPrefetchCandidate {
                path: profile_paths.snapshot_paths().memory(),
                memory_mb: profile.memory_mb,
            })
        })
        .collect::<RunnerResult<Vec<_>>>()?;
    let memory_prefetch_budget_mb = u64::from(budget.effective_memory_mb().min(host_memory_mb));
    let mut memory_prefetch =
        prefetch::MemoryPrefetchTasks::spawn(memory_prefetch_candidates, memory_prefetch_budget_mb);

    // Compute the smallest profile resources for budget pre-check.
    // When budget is exhausted for all profiles, we wait instead of polling.
    let min_vcpu = runner_config
        .profiles
        .values()
        .map(|p| p.vcpu)
        .min()
        .unwrap_or(1);
    let min_memory_mb = runner_config
        .profiles
        .values()
        .map(|p| p.memory_mb)
        .min()
        .unwrap_or(1);

    // Start proxy before factory so proxy_port is available for netns pool.
    let (mut mitm, mitm_crash_rx) = proxy::MitmProxy::new(proxy::ProxyConfig {
        mitmdump_bin: home.mitmdump_bin(deps::MITMPROXY_VERSION),
        ca_dir: runner_config.ca_dir.clone(),
        ca_lock_path: home.ca_lock(),
        addon_dir: paths.mitm_addon_dir(),
        registry_path: paths.proxy_registry(),
        registry_lock_path: paths.proxy_registry_lock(),
        builtin_firewall_catalog_cache_path: paths.builtin_firewall_catalog_cache(),
        runtime_dir: paths.mitmdump_runtime_dir(),
        runtime_lock_path: paths.mitmdump_runtime_lock(),
        api_url: Some(server.url.clone()),
        client_session_id: runner_client_session_id,
        runner_token: local_group_dir.is_none().then(|| server.token.clone()),
    })
    .await?;
    mitm.start().await?;
    info!(port = mitm.port(), "proxy ready");

    let registry_handle = mitm.registry_handle();

    // Start background DNS/kmsg monitors for Rust-side network logging.
    let network_log_manager = NetworkLogManager::new();
    let kmsg_handle = kmsg_log::spawn(network_log_manager.clone())
        .map_err(|e| RunnerError::Internal(format!("kmsg monitor: {e}")))?;

    let io_limit_resolution =
        crate::io_limits::resolve_io_limits(&runner_config.profiles, &budget, &runner_host_env);
    let device_rate_limits = io_limit_resolution.device_rate_limits();
    match &io_limit_resolution {
        crate::io_limits::IoLimitResolution::Disabled => {
            info!("I/O limiters disabled");
        }
        crate::io_limits::IoLimitResolution::Misconfigured { reason } => {
            warn!(%reason, "I/O limiter host env config invalid; disabling I/O limiter capacity");
        }
        crate::io_limits::IoLimitResolution::Configured {
            limits,
            denominator,
        } => {
            info!(
                denominator,
                disk_bandwidth_bytes_per_sec = limits.block.bandwidth_bytes_per_sec,
                disk_ops_per_sec = limits.block.ops_per_sec,
                net_rx_bytes_per_sec = limits.network.rx_bytes_per_sec,
                net_tx_bytes_per_sec = limits.network.tx_bytes_per_sec,
                "I/O limiter capacity configured; applying limiters to all jobs"
            );
        }
    }

    // Idle sandbox pool for sandbox reuse across conversation turns.
    let parking_gate = ParkingGate::new_open();
    let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new_with_parking_gate(
        IdlePoolConfig { max_idle },
        parking_gate.clone(),
    )));

    // Estimated capacity for status reporting.
    // Derived from the smallest profile to cover the worst case.
    let estimated_capacity = {
        let resource_limit = std::cmp::min(
            budget.effective_vcpu() as usize / min_vcpu as usize,
            budget.effective_memory_mb() as usize / min_memory_mb as usize,
        )
        .max(1);
        if max_concurrent > 0 {
            std::cmp::min(resource_limit, max_concurrent)
        } else {
            resource_limit
        }
    };

    // Build sandbox runtime with shared resources (netns and NBD device pools),
    // then start dnsmasq once the backend exposes the runner-scoped veth
    // interface pattern. If the reserved DNS port is claimed in the small
    // release-before-dnsmasq-bind window, rebuild the runtime with a fresh port
    // so all prewarmed namespace REDIRECT rules stay consistent.
    let (mut runtime, dns_handle, kmsg_handle) = start_runtime_with_dns(
        DnsStartupResources {
            runtime_provider,
            mitm: &mut mitm,
            kmsg_handle,
            memory_prefetch: &mut memory_prefetch,
            network_log_manager: network_log_manager.clone(),
            host_cpu_placement,
        },
        dns::start_on_reserved_port,
    )
    .await?;
    let network_log_drain = NetworkLogDrainCoordinator::new(vec![
        kmsg_handle.drain_producer(),
        dns_handle.drain_producer(),
    ]);

    let status = Arc::new(StatusTracker::new(
        paths.status(),
        estimated_capacity,
        Some(mitm.port()),
        Some(dns_handle.port()),
    ));

    // Create provider — handles discovery + claim + complete
    let ssh = if local_group_dir.is_none() {
        crate::ssh::SshRuntime::official(http.clone(), &server.token, runner_identity)?
    } else {
        None
    };
    let (usage_flush_tx, usage_flush_rx) = mpsc::channel(1);
    let (provider, group_name, connector_runtime_sync): (
        Arc<dyn JobProvider>,
        String,
        Option<ConnectorRuntimeSyncHandle>,
    ) = if let Some(group_dir) = local_group_dir {
        let profiles: Vec<String> = runner_config.profiles.keys().cloned().collect();
        let provider =
            LocalProvider::new(group_dir, profiles, cancel.clone(), cancel_tokens.clone());
        (provider, group, None)
    } else {
        let group_name = group.clone();
        let profiles: Vec<String> = runner_config.profiles.keys().cloned().collect();
        let provider = ApiProvider::new(
            http.clone(),
            server.token,
            ApiProviderConfig {
                deferred_release_root: home.deferred_sandbox_recovery_dir(),
                ssh: ssh.clone(),
                runner_identity,
                runner_hostname: hostname.clone(),
                group,
                supported_profiles: profiles,
            },
            BuiltinFirewallCatalogCachePaths {
                cache_path: paths.builtin_firewall_catalog_cache(),
                lock_path: paths.builtin_firewall_catalog_cache_lock(),
            },
            cancel.clone(),
            cancel_tokens.clone(),
        );
        let connector_runtime_sync = provider.connector_runtime_sync_handle();
        (provider, group_name, Some(connector_runtime_sync))
    };

    let exec_config = Arc::new(ExecutorConfig {
        api_url: server.url,
        runner_hostname: hostname,
        registry: registry_handle,
        http,
        log_paths,
        network_log_manager,
        network_log_drain,
        mitm_jsonl_flush: Some(mitm.jsonl_flush_handle()),
        connector_runtime_sync,
        guest_rpc: ssh.map(|ssh| crate::guest_rpc::Runtime { ssh: Some(ssh) }),
        session_history_cpu: SessionHistoryCpuPool::for_host_cpus(host_cpus),
        session_history_probe: SessionHistoryProbe::default(),
        fresh_archive_delivery: crate::storage_cache::FreshArchiveDeliveryAdmission::new(),
        decoded_cache: crate::storage_cache::decoded::DecodedCache::new(home.clone()),
        background_fill,
        pre_spawn_admission,
        storage_baseline_observer: Default::default(),
        home: home.clone(),
        workspace_cache: Some(
            WorkspaceImageCache::shared(paths.clone(), &home, &group_name)
                .with_promotion_host_cpus(host_cpus),
        ),
    });

    let live_runner_instance_metadata = crate::live_runner_instances::LiveRunnerInstanceMetadata {
        config_path: registry_config_path,
        base_dir: base_dir_canonical.clone(),
        runner_group: group_name.clone(),
        subcommand: "start".into(),
    };

    let (live_runner_instance_handle, kmsg_handle, dns_handle) =
        publish_live_runner_instance_or_shutdown_startup_resources(
            &home,
            live_runner_instance_metadata,
            LiveRunnerPublishResources {
                provider: provider.as_ref(),
                runtime: runtime.as_mut(),
                mitm: &mut mitm,
                kmsg_handle,
                dns_handle,
                memory_prefetch: &mut memory_prefetch,
                status: status.as_ref(),
            },
        )
        .await?;

    let reuse_state_notify = Arc::new(tokio::sync::Notify::new());
    let active_runs = ActiveRuns::new(Arc::clone(&reuse_state_notify));
    let config = RunConfig {
        runner: RunnerInfo {
            identity: runner_identity,
            group: group_name,
            profiles: runner_config.profiles,
        },
        paths: RunPaths {
            home,
            base_dir: runner_config.base_dir,
        },
        sandbox_runtime: SandboxRuntimeConfig {
            runtime,
            firecracker: runner_config.firecracker,
        },
        capacity: CapacityPolicy {
            budget,
            min_vcpu,
            min_memory_mb,
            max_idle,
            device_rate_limits,
        },
        shared: RunnerSharedState {
            idle_pool,
            parking_gate,
            status,
            active_runs,
            reuse_state_notify,
        },
        provider: ProviderState {
            provider,
            cancel_tokens,
            cancel,
        },
        proxy: ProxyState {
            mitm,
            mitm_crash_rx,
        },
        exec_config,
        shutdown: ShutdownHandles {
            kmsg_handle,
            dns_handle,
            memory_prefetch,
        },
        usage_flush_tx,
        usage_flush_rx,
        signals: SignalState {
            signal_source: SignalSource::Real(signals),
        },
        orphan_reap: OrphanReapState {
            process_discovery: None,
        },
        #[cfg(test)]
        test_hooks: RunTestHooks {
            outer_job_panic: None,
            test_observer: StartLoopTestObserver::default(),
            before_initial_workspace_cache_scan: None,
            after_initial_workspace_cache_scan: None,
            manual_routine_heartbeat_rx: None,
            manual_workspace_cache_gc_rx: None,
        },
    };

    let run_result = run(config).await;
    drop(resource_locks);
    if let Err(e) = live_runner_instance_handle.remove_if_current().await {
        tracing::warn!(error = %e, "failed to remove live runner instance record");
    }
    run_result
}

fn host_cpu_placement_config(
    budget: &ResourceBudget,
    local: bool,
) -> RunnerResult<sandbox::HostCpuPlacementConfig> {
    let (control_weight, guests_weight) = budget.host_cpu_cgroup_weights();
    sandbox::HostCpuPlacementConfig::new(
        control_weight,
        guests_weight,
        if local {
            sandbox::HostCpuPlacementMode::PreferManaged
        } else {
            sandbox::HostCpuPlacementMode::Required
        },
    )
    .map_err(|message| RunnerError::Internal(format!("host CPU placement policy: {message}")))
}

fn validate_server_config_for_start(
    mut server: config::ServerConfig,
) -> RunnerResult<config::ServerConfig> {
    if server.url.is_empty() {
        return Err(RunnerError::Config(
            "server.url is required (set in config or via --api-url / OKOU_API_BACKEND_URL)".into(),
        ));
    }
    server.url = config::normalize_api_base_url(&server.url)?;
    if server.token.is_empty() {
        return Err(RunnerError::Config(
            "server.token is required (set in config or via --token / OKOU_RUNNER_TOKEN)".into(),
        ));
    }

    Ok(server)
}

struct RunConfig {
    runner: RunnerInfo,
    paths: RunPaths,
    sandbox_runtime: SandboxRuntimeConfig,
    capacity: CapacityPolicy,
    shared: RunnerSharedState,
    provider: ProviderState,
    proxy: ProxyState,
    exec_config: Arc<ExecutorConfig>,
    shutdown: ShutdownHandles,
    usage_flush_tx: mpsc::Sender<()>,
    usage_flush_rx: mpsc::Receiver<()>,
    signals: SignalState,
    orphan_reap: OrphanReapState,
    #[cfg(test)]
    test_hooks: RunTestHooks,
}

struct RunnerInfo {
    identity: RunnerProcessIdentity,
    group: String,
    profiles: BTreeMap<String, ProfileConfig>,
}

struct RunPaths {
    home: HomePaths,
    base_dir: PathBuf,
}

struct SandboxRuntimeConfig {
    runtime: Box<dyn SandboxRuntime>,
    firecracker: config::FirecrackerConfig,
}

struct CapacityPolicy {
    budget: Arc<ResourceBudget>,
    min_vcpu: u32,
    min_memory_mb: u32,
    max_idle: usize,
    device_rate_limits: Option<sandbox::DeviceRateLimits>,
}

struct RunnerSharedState {
    idle_pool: SharedIdlePool,
    parking_gate: ParkingGate,
    status: Arc<StatusTracker>,
    active_runs: ActiveRuns,
    reuse_state_notify: Arc<tokio::sync::Notify>,
}

struct ProviderState {
    provider: Arc<dyn JobProvider>,
    /// Per-job cancellation registrations shared with the provider for cancel
    /// events (Ably for ApiProvider, `.cancel` files for LocalProvider).
    cancel_tokens: RunCancellationRegistry,
    cancel: CancellationToken,
}

struct ProxyState {
    mitm: proxy::MitmProxy,
    mitm_crash_rx: tokio::sync::mpsc::Receiver<()>,
}

struct ShutdownHandles {
    kmsg_handle: kmsg_log::KmsgHandle,
    dns_handle: dns::DnsProxy,
    memory_prefetch: prefetch::MemoryPrefetchTasks,
}

struct SignalState {
    /// How the run's mode channel is driven. Production supplies the signal
    /// streams registered at the top of `run_start`; tests supply a
    /// pre-built `SignalController` so they can drive mode transitions
    /// through the lifecycle controller.
    signal_source: SignalSource,
}

struct OrphanReapState {
    /// Deterministic process snapshot for orphan-reaper tests. Production leaves
    /// this unset and scans `/proc`.
    process_discovery: Option<OrphanReapProcessDiscovery>,
}

#[cfg(test)]
struct RunTestHooks {
    outer_job_panic: Option<OuterJobPanicPoint>,
    test_observer: StartLoopTestObserver,
    before_initial_workspace_cache_scan: Option<StartLoopTestGate>,
    after_initial_workspace_cache_scan: Option<StartLoopTestGate>,
    manual_routine_heartbeat_rx: Option<mpsc::UnboundedReceiver<()>>,
    manual_workspace_cache_gc_rx: Option<mpsc::UnboundedReceiver<()>>,
}

enum SignalSource {
    /// Real signals pre-registered at the top of `run_start`. `run()`
    /// spawns the `SignalController` task that consumes them.
    Real(EarlySignals),
    /// Test-supplied controller. `run()` does not spawn a handler task and
    /// the caller drives `mode_tx` itself. Constructed only by `mod tests`
    /// below; non-test code matches on it but never builds it.
    #[cfg_attr(not(test), allow(dead_code))]
    Override(SignalController),
}

#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
enum StartLoopEvent {
    BudgetExhaustedReactorEntered,
    RoutineHeartbeatRequested { mode: RunnerMode },
    WorkspaceCacheChangeObserved,
    MaintenanceDrainEntered,
    RunningJobsDrainEntered,
    DestroyTasksDrainEntered,
    DestroyTasksDrainCompleted,
    FinalizingCapacityWaitEntered { run_id: RunId },
    ReservedPreparingCommitted { run_id: RunId },
    ActiveRunStatusPublished { run_id: RunId },
    BeforeIdlePoolOwnershipTransfer { run_id: RunId },
    SandboxParkedForReuse { run_id: RunId, reuse_key: String },
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
        predicate: impl FnMut(&StartLoopEvent) -> Option<T>,
    ) -> T {
        let (value, _) = self
            .wait_after(StartLoopCursor(0), timeout, context, predicate)
            .await;
        value
    }

    async fn wait_after<T>(
        &self,
        cursor: StartLoopCursor,
        timeout: Duration,
        context: &'static str,
        mut predicate: impl FnMut(&StartLoopEvent) -> Option<T>,
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

    fn notify_workspace_cache_change_observed(&self) {
        self.record(StartLoopEvent::WorkspaceCacheChangeObserved);
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
            .wait_after(cursor, timeout, "routine heartbeat request", |event| {
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

    async fn wait_workspace_cache_change_observed_after(
        &self,
        cursor: StartLoopCursor,
        timeout: Duration,
    ) -> StartLoopCursor {
        let ((), cursor) = self
            .wait_after(cursor, timeout, "workspace-cache change", |event| {
                matches!(event, StartLoopEvent::WorkspaceCacheChangeObserved).then_some(())
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
mod start_loop_observer_tests {
    use super::*;

    fn ownership_transfer_run_id(event: &StartLoopEvent) -> Option<RunId> {
        match event {
            StartLoopEvent::BeforeIdlePoolOwnershipTransfer { run_id } => Some(*run_id),
            _ => None,
        }
    }

    #[tokio::test]
    async fn start_loop_observer_wait_after_ignores_events_before_cursor() {
        let observer = StartLoopTestObserver::default();
        let first = RunId::new_v4();
        let second = RunId::new_v4();
        let third = RunId::new_v4();

        observer.record(StartLoopEvent::BeforeIdlePoolOwnershipTransfer { run_id: first });
        let cursor = observer.cursor();
        observer.record(StartLoopEvent::BeforeIdlePoolOwnershipTransfer { run_id: second });

        let (observed_run_id, cursor) = observer
            .wait_after(
                cursor,
                Duration::from_secs(1),
                "second ownership transfer",
                ownership_transfer_run_id,
            )
            .await;
        assert_eq!(
            observed_run_id, second,
            "wait_after should ignore stale events before the cursor"
        );

        observer.record(StartLoopEvent::BeforeIdlePoolOwnershipTransfer { run_id: third });
        let (observed_run_id, _) = observer
            .wait_after(
                cursor,
                Duration::from_secs(1),
                "third ownership transfer",
                ownership_transfer_run_id,
            )
            .await;
        assert_eq!(
            observed_run_id, third,
            "next cursor should advance past the matched event"
        );
    }

    #[tokio::test]
    #[should_panic(expected = "start-loop observer cursor")]
    async fn start_loop_observer_wait_after_rejects_cursor_past_history() {
        let observer = StartLoopTestObserver::default();

        observer
            .wait_after(
                StartLoopCursor(1),
                Duration::from_secs(1),
                "invalid cursor",
                |_| Some(()),
            )
            .await;
    }

    #[tokio::test]
    async fn start_loop_observer_wait_before_idle_pool_ownership_transfer_observes_existing_event()
    {
        let observer = StartLoopTestObserver::default();
        let run_id = RunId::new_v4();

        observer.notify_before_idle_pool_ownership_transfer(run_id);
        observer
            .wait_before_idle_pool_ownership_transfer(run_id, Duration::from_secs(1))
            .await;
    }

    #[tokio::test]
    #[should_panic(expected = "runner did not observe idle-pool ownership transfer attempt")]
    async fn start_loop_observer_wait_before_idle_pool_ownership_transfer_ignores_other_runs() {
        let observer = StartLoopTestObserver::default();
        let run_id = RunId::new_v4();
        let other_run_id = RunId::new_v4();

        observer.notify_before_idle_pool_ownership_transfer(other_run_id);
        observer
            .wait_before_idle_pool_ownership_transfer(run_id, Duration::ZERO)
            .await;
    }
}

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

async fn run(config: RunConfig) -> RunnerResult<()> {
    let RunConfig {
        runner,
        paths,
        sandbox_runtime,
        capacity,
        shared,
        provider: provider_state,
        proxy,
        exec_config,
        shutdown,
        usage_flush_tx,
        mut usage_flush_rx,
        signals,
        orphan_reap,
        #[cfg(test)]
        mut test_hooks,
    } = config;
    let SandboxRuntimeConfig {
        mut runtime,
        firecracker,
    } = sandbox_runtime;
    let ProxyState {
        mut mitm,
        mut mitm_crash_rx,
    } = proxy;
    let ShutdownHandles {
        mut kmsg_handle,
        mut dns_handle,
        mut memory_prefetch,
    } = shutdown;

    // -----------------------------------------------------------------------
    // Signal handling / mode channel
    // -----------------------------------------------------------------------
    let signal = match signals.signal_source {
        SignalSource::Real(signals) => SignalController::spawn(
            provider_state.cancel.clone(),
            provider_state.cancel_tokens.clone(),
            signals,
            shared.parking_gate.clone(),
        ),
        SignalSource::Override(controller) => controller,
    };
    let mut mode_rx = signal.mode_rx;
    let lifecycle = signal.lifecycle;
    let mut signal_handler_task = signal.handler_task;

    if let Err(error) = shared.status.write_initial().await {
        shutdown_startup_resources_after_startup_failure(
            StartupFailureResources {
                provider: provider_state.provider.as_ref(),
                runtime: Some(runtime.as_mut()),
                mitm: &mut mitm,
                kmsg_handle,
                dns_handle,
                memory_prefetch: &mut memory_prefetch,
                status: shared.status.as_ref(),
            },
            "initial_status_persistence_failure",
        )
        .await;
        if let Some(handler_task) = signal_handler_task.take() {
            abort_signal_handler_task(handler_task, "initial_status_persistence_failure").await;
        }
        return Err(RunnerError::Internal(format!(
            "persist initial runner status: {error}"
        )));
    }

    let prune_listener = match crate::idle_prune_control::PruneIdleListener::bind(
        &paths.home,
        &paths.base_dir,
        runner.identity,
    ) {
        Ok(listener) => listener,
        Err(error) => {
            shutdown_startup_resources_after_startup_failure(
                StartupFailureResources {
                    provider: provider_state.provider.as_ref(),
                    runtime: Some(runtime.as_mut()),
                    mitm: &mut mitm,
                    kmsg_handle,
                    dns_handle,
                    memory_prefetch: &mut memory_prefetch,
                    status: shared.status.as_ref(),
                },
                "prune_control_startup_failure",
            )
            .await;
            if let Some(handler_task) = signal_handler_task.take() {
                abort_signal_handler_task(handler_task, "prune_control_startup_failure").await;
            }
            return Err(error.into());
        }
    };
    let prune_admission = Arc::new(tokio::sync::Semaphore::new(1));

    if let Err(e) = provider_state.provider.prepare_startup_readiness().await {
        let startup_readiness_cancelled = provider_state.cancel.is_cancelled();
        let cleanup_reason = if startup_readiness_cancelled {
            "provider_startup_readiness_cancelled"
        } else {
            "provider_startup_readiness_failure"
        };
        shutdown_startup_resources_after_startup_failure(
            StartupFailureResources {
                provider: provider_state.provider.as_ref(),
                runtime: Some(runtime.as_mut()),
                mitm: &mut mitm,
                kmsg_handle,
                dns_handle,
                memory_prefetch: &mut memory_prefetch,
                status: shared.status.as_ref(),
            },
            cleanup_reason,
        )
        .await;
        if let Some(handler_task) = signal_handler_task.take() {
            abort_signal_handler_task(handler_task, cleanup_reason).await;
        }
        if startup_readiness_cancelled {
            return Ok(());
        }
        return Err(e);
    }

    let mut factories = match start_factories(
        &runner.profiles,
        &firecracker,
        &paths.base_dir,
        &paths.home,
        runtime.as_mut(),
    )
    .await
    {
        Ok(factories) => factories,
        Err(e) => {
            shutdown_startup_resources_after_startup_failure(
                StartupFailureResources {
                    provider: provider_state.provider.as_ref(),
                    runtime: Some(runtime.as_mut()),
                    mitm: &mut mitm,
                    kmsg_handle,
                    dns_handle,
                    memory_prefetch: &mut memory_prefetch,
                    status: shared.status.as_ref(),
                },
                "factory_startup_failure",
            )
            .await;
            if let Some(handler_task) = signal_handler_task.take() {
                abort_signal_handler_task(handler_task, "factory_startup_failure").await;
            }
            return Err(e);
        }
    };
    let startup_mode = lifecycle.mark_startup_ready();
    if let Err(error) = shared.status.set_mode(startup_mode).await {
        handle_stopping_signal(
            "startup status persistence failure",
            &provider_state.cancel,
            &provider_state.cancel_tokens,
            &lifecycle,
        )
        .await;
        if let Err(factory_error) = shutdown_factory_instances(&mut factories, None).await {
            warn!(
                error = %factory_error,
                "failed to shut down factories after startup status persistence failure"
            );
        }
        shutdown_startup_resources_after_startup_failure(
            StartupFailureResources {
                provider: provider_state.provider.as_ref(),
                runtime: Some(runtime.as_mut()),
                mitm: &mut mitm,
                kmsg_handle,
                dns_handle,
                memory_prefetch: &mut memory_prefetch,
                status: shared.status.as_ref(),
            },
            "startup_status_persistence_failure",
        )
        .await;
        if let Some(handler_task) = signal_handler_task.take() {
            abort_signal_handler_task(handler_task, "startup_status_persistence_failure").await;
        }
        return Err(RunnerError::Internal(format!(
            "persist ready runner status: {error}"
        )));
    }

    let mut jobs: JoinSet<RunCancellationRegistration> = JoinSet::new();

    if startup_mode == RunnerMode::Running {
        info!(
            runner_release = crate::RUNNER_RELEASE,
            group = %runner.group,
            effective_vcpu = capacity.budget.effective_vcpu(),
            effective_memory_mb = capacity.budget.effective_memory_mb(),
            max_concurrent = capacity.budget.max_concurrent(),
            "runner started"
        );
    } else {
        info!(
            runner_release = crate::RUNNER_RELEASE,
            group = %runner.group,
            mode = ?startup_mode,
            "runner startup completed after lifecycle signal"
        );
    }

    // -----------------------------------------------------------------------
    // Mitmproxy crash-restart state
    // -----------------------------------------------------------------------
    let mut mitm_retry: RetryState<MitmRestartHandle> = RetryState::new(
        MITM_BACKOFF_INITIAL,
        MITM_BACKOFF_MAX,
        Some(MITM_MAX_CONSECUTIVE_FAILURES),
    );

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
    // learns about a held reusable sandbox or workspace image cache without
    // waiting for the next 10-second tick.
    let reuse_state_notify = Arc::clone(&shared.reuse_state_notify);
    let idle_destroy_tracker = IdleDestroyTracker::new(Arc::clone(&reuse_state_notify));
    let orphaned_active_runs = OrphanedActiveRuns::new();
    let active_runs = shared.active_runs.clone();
    let workspace_cache_snapshot = WorkspaceCacheStateSnapshot::new();
    let mut orphan_reap_tick = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(10),
        Duration::from_secs(10),
    );
    orphan_reap_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut workspace_cache_watcher = match exec_config.workspace_cache.clone() {
        Some(cache) => match WorkspaceCacheWatcher::new(cache).await {
            Ok(watcher) => Some(watcher),
            Err(error) => {
                warn!(error = %error, "workspace cache watcher unavailable; using periodic reconciliation");
                None
            }
        },
        None => None,
    };
    #[cfg(test)]
    if let Some(gate) = &test_hooks.before_initial_workspace_cache_scan {
        gate.enter_and_wait().await;
    }
    let hb_ctx = HeartbeatContext::new(HeartbeatContextInit {
        idle_pool: &shared.idle_pool,
        runner_identity: runner.identity,
        group: &runner.group,
        profiles: &runner.profiles,
        budget: &capacity.budget,
        provider: Arc::clone(&provider_state.provider),
        workspace_cache: exec_config.workspace_cache.clone(),
        active_runs: &active_runs,
        workspace_cache_snapshot: workspace_cache_snapshot.clone(),
    });
    let initial_workspace_cache = refresh_initial_workspace_cache_snapshot(
        &workspace_cache_snapshot,
        exec_config.workspace_cache.as_ref(),
        &runner.profiles,
    )
    .await;
    #[cfg(test)]
    if let Some(gate) = &test_hooks.after_initial_workspace_cache_scan {
        gate.enter_and_wait().await;
    }
    debug_assert!(workspace_cache_snapshot.workspace_cache_loaded());
    let mut initial_relevant_cache_keys = initial_workspace_cache.loaded_cache_keys;
    initial_relevant_cache_keys.extend(initial_workspace_cache.locked_commit_keys.iter().cloned());
    let mut initial_workspace_cache_change = match workspace_cache_watcher.as_mut() {
        Some(watcher) => match watcher
            .reconcile_initial_relevant_entries(&initial_relevant_cache_keys)
            .await
        {
            Ok(change) => change,
            Err(error) => {
                warn!(error = %error, "workspace cache watcher failed during startup reconciliation; using periodic reconciliation");
                workspace_cache_watcher = None;
                Some(crate::workspace_image_cache::WorkspaceCacheChange {
                    observed_at: tokio::time::Instant::now(),
                    committed_cache_keys: std::collections::BTreeSet::new(),
                })
            }
        },
        None => None,
    };
    if !initial_workspace_cache.locked_commit_keys.is_empty() {
        let locked_change = crate::workspace_image_cache::WorkspaceCacheChange {
            observed_at: tokio::time::Instant::now(),
            committed_cache_keys: initial_workspace_cache.locked_commit_keys,
        };
        match initial_workspace_cache_change.as_mut() {
            Some(change) => change.merge(locked_change),
            None => initial_workspace_cache_change = Some(locked_change),
        }
    }
    let mut workspace_cache_change_fut = workspace_cache_watcher.map(workspace_cache_change_future);
    let mut heartbeat = HeartbeatController::new(hb_ctx);
    let initial_heartbeat_mode = lifecycle.current_mode();
    if initial_heartbeat_mode == RunnerMode::Running {
        match initial_workspace_cache_change {
            Some(change) => {
                heartbeat.request_initial_workspace_cache(initial_heartbeat_mode, change)?;
            }
            None if !initial_workspace_cache.states.is_empty() => {
                heartbeat.request_initial_workspace_cache_snapshot(initial_heartbeat_mode)?;
            }
            None => {}
        }
    }

    // Pin the discover future so it survives cancellation by other select!
    // branches (heartbeat, lifecycle changes, etc.). Without pinning, heartbeat
    // (10s) cancels discover() on every tick, restarting its provider-owned
    // wait from scratch before reconciliation can run. See #8747.
    let mut discover_fut = Box::pin(provider_state.provider.discover());

    let mut current_mode = startup_mode;
    let spawn_ctx = SpawnContext {
        runner_id: runner.identity.runner_id().to_string(),
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
        budget: Arc::clone(&capacity.budget),
        workspace_cache_snapshot,
        device_rate_limits: capacity.device_rate_limits.clone(),
        #[cfg(test)]
        outer_job_panic: test_hooks.outer_job_panic,
        #[cfg(test)]
        test_observer: test_hooks.test_observer.clone(),
    };
    let mut blank_pool = BlankPoolReplenisher::new(
        &runner.profiles,
        &factories,
        &capacity.budget,
        capacity.max_idle,
        capacity.device_rate_limits.clone(),
    );
    let mut blank_pool_tick = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(1),
        Duration::from_secs(1),
    );
    blank_pool_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    #[cfg(test)]
    let mut workspace_cache_gc_tick = match test_hooks.manual_workspace_cache_gc_rx.take() {
        Some(receiver) => MaintenanceTrigger::Manual(receiver),
        None => MaintenanceTrigger::interval(WORKSPACE_CACHE_GC_PERIOD),
    };
    #[cfg(not(test))]
    let mut workspace_cache_gc_tick = MaintenanceTrigger::interval(WORKSPACE_CACHE_GC_PERIOD);
    let mut workspace_cache_reconciliation_tick = tokio::time::interval_at(
        tokio::time::Instant::now() + WORKSPACE_CACHE_RECONCILIATION_INITIAL_DELAY,
        WORKSPACE_CACHE_RECONCILIATION_PERIOD,
    );
    workspace_cache_reconciliation_tick
        .set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut workspace_cache_gc_handle = None;
    let mut status_retry_handle = None;
    let mut draining_idle_pool_drained = false;
    let mut pending_finalizing_candidate = None;
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
        if mode != RunnerMode::Running {
            pending_finalizing_candidate = None;
        }
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
                if !draining_idle_pool_drained {
                    // Soft drain entry. Destroy the idle pool once (releases
                    // budget — matches pre-split teardown behavior), then keep
                    // servicing the shared reactor while jobs finish.
                    drain_idle_pool(&shared.idle_pool, &shared.status, "draining").await;
                    draining_idle_pool_drained = true;
                }
                if jobs.is_empty() {
                    // Natural drain complete — commit to Stopping so teardown
                    // is observable to heartbeat and status.json. Guard the
                    // transition on `mode == Draining` so a concurrent SIGUSR2
                    // resume wins instead of being overwritten.
                    info!("draining: jobs drained, transitioning to Stopping");
                    let transitioned = lifecycle.stop_after_natural_drain();
                    if transitioned {
                        // Live observability: fire an immediate "stopping"
                        // heartbeat before teardown removes the runner.
                        if let Err(error) = heartbeat.flush(RunnerMode::Stopping).await {
                            terminal_error = Some(error);
                            break;
                        }
                    }
                    continue;
                }
            }
            RunnerMode::Running => {
                draining_idle_pool_drained = false;
            }
        }

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

        // Spawn background restart task when timer fires
        maybe_spawn_mitm_restart(&mut mitm, &mut mitm_crash_rx, &mut mitm_retry);

        let can_discover = if matches!(mode, RunnerMode::Running) {
            // A selected finalizing successor can claim against an exact
            // in-process predecessor without reserving fresh capacity.
            capacity
                .budget
                .can_afford(capacity.min_vcpu, capacity.min_memory_mb)
                || shared.idle_pool.lock().await.len() > 0
                || active_runs.has_reusable_run()
        } else {
            false
        };
        #[cfg(test)]
        if matches!(mode, RunnerMode::Running) && !can_discover {
            test_hooks.test_observer.notify_budget_exhausted_reactor();
        }
        let heartbeat_sending = heartbeat.is_sending();
        let pending_finalizing_deadline = pending_finalizing_candidate
            .as_ref()
            .and_then(JobCandidate::runner_preference)
            .map(crate::provider::ActiveRunnerPreference::deadline);
        tokio::select! {
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
                let candidate = candidate_for_admission(
                    candidate,
                    &mut pending_finalizing_candidate,
                );
                let result = handle_discovered_job(
                    DiscoveredJob { candidate },
                    DiscoveredJobContext {
                        runner_identity: runner.identity,
                        profiles: &runner.profiles,
                        factories: &factories,
                        budget: &capacity.budget,
                        idle_pool: &shared.idle_pool,
                        status: &shared.status,
                        mode_rx: &mode_rx,
                        cancel_tokens: &provider_state.cancel_tokens,
                        spawn_ctx: &spawn_ctx,
                        jobs: &mut jobs,
                    },
                ).await;
                let mut needs_reuse_state_refresh =
                    result.needs_reuse_state_refresh;
                if let Some(candidate) = result.pending_candidate {
                    retain_finalizing_candidate(
                        &mut pending_finalizing_candidate,
                        candidate,
                    );
                }
                let mut drained_ready_candidates = 0;
                while drained_ready_candidates < READY_DIRECT_CANDIDATE_DRAIN_LIMIT {
                    let live_mode = *mode_rx.borrow();
                    if !matches!(live_mode, RunnerMode::Running) {
                        break;
                    }
                    if !capacity
                        .budget
                        .can_afford(capacity.min_vcpu, capacity.min_memory_mb)
                        && shared.idle_pool.lock().await.len() == 0
                    {
                        break;
                    }
                    let Some(candidate) = provider_state.provider.try_discover_ready().await else {
                        break;
                    };
                    drained_ready_candidates += 1;
                    let candidate = candidate_for_admission(
                        candidate,
                        &mut pending_finalizing_candidate,
                    );
                    let result = handle_discovered_job(
                        DiscoveredJob { candidate },
                        DiscoveredJobContext {
                            runner_identity: runner.identity,
                            profiles: &runner.profiles,
                            factories: &factories,
                            budget: &capacity.budget,
                            idle_pool: &shared.idle_pool,
                            status: &shared.status,
                            mode_rx: &mode_rx,
                            cancel_tokens: &provider_state.cancel_tokens,
                            spawn_ctx: &spawn_ctx,
                            jobs: &mut jobs,
                        },
                    ).await;
                    needs_reuse_state_refresh |= result.needs_reuse_state_refresh;
                    if let Some(candidate) = result.pending_candidate {
                        retain_finalizing_candidate(
                            &mut pending_finalizing_candidate,
                            candidate,
                        );
                    }
                }
                let live_mode = *mode_rx.borrow();
                if needs_reuse_state_refresh
                    && matches!(live_mode, RunnerMode::Running | RunnerMode::Draining)
                {
                    info!(
                        source = "direct_candidate_batch",
                        drained_ready_candidates,
                        "reusable state triggered immediate heartbeat"
                    );
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
                    terminal_error = Some(error);
                    break;
                }
            }
            (watcher, result) = next_workspace_cache_change(&mut workspace_cache_change_fut) => {
                match result {
                    Ok(change) => {
                        workspace_cache_change_fut = Some(workspace_cache_change_future(watcher));
                        #[cfg(test)]
                        test_hooks
                            .test_observer
                            .notify_workspace_cache_change_observed();
                        let live_mode = *mode_rx.borrow();
                        if matches!(live_mode, RunnerMode::Running | RunnerMode::Draining) {
                            heartbeat.request_workspace_cache(live_mode, change)?;
                        }
                    }
                    Err(error) => {
                        warn!(error = %error, "workspace cache watcher failed; using periodic reconciliation");
                        workspace_cache_change_fut = None;
                    }
                }
            }
            _ = workspace_cache_reconciliation_tick.tick(),
                if exec_config.workspace_cache.is_some() =>
            {
                let live_mode = *mode_rx.borrow();
                if matches!(live_mode, RunnerMode::Running | RunnerMode::Draining) {
                    heartbeat.request_workspace_cache(
                        live_mode,
                        WorkspaceCacheChange {
                            observed_at: tokio::time::Instant::now(),
                            committed_cache_keys: std::collections::BTreeSet::new(),
                        },
                    )?;
                }
            }
            result = next_maintenance_task(&mut workspace_cache_gc_handle, "workspace cache GC") => {
                workspace_cache_gc_handle = None;
                workspace_cache_gc_tick.reset();
                if let Err(error) = result {
                    handle_stopping_signal(
                        "workspace cache GC task failure",
                        &provider_state.cancel,
                        &provider_state.cancel_tokens,
                        &lifecycle,
                    ).await;
                    terminal_error = Some(error);
                    break;
                }
            }
            result = next_maintenance_task(&mut status_retry_handle, "status retry") => {
                status_retry_handle = None;
                if let Err(error) = result {
                    handle_stopping_signal(
                        "status retry task failure",
                        &provider_state.cancel,
                        &provider_state.cancel_tokens,
                        &lifecycle,
                    ).await;
                    terminal_error = Some(error);
                    break;
                }
            }
            _ = workspace_cache_gc_tick.tick() => {
                if workspace_cache_gc_handle.is_none()
                    && let Some(cache) = exec_config.workspace_cache.clone()
                {
                    workspace_cache_gc_handle = Some(workspace_cache_gc_task(cache));
                }
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
                    reap_orphaned_active_runs(
                        &orphaned_active_runs,
                        &shared.idle_pool,
                        &shared.status,
                        OrphanReapMode::Immediate,
                        orphan_reap.process_discovery.as_ref(),
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
                reap_orphaned_active_runs(
                    &orphaned_active_runs,
                    &shared.idle_pool,
                    &shared.status,
                    OrphanReapMode::ConfirmAbsent,
                    orphan_reap.process_discovery.as_ref(),
                ).await;
            }
            // Mitmproxy crash detection
            Some(()) = mitm_crash_rx.recv() => {
                error!(
                    r#type = "usage_underbilling",
                    reason = "mitm_restart_in_memory_usage_risk",
                    underbilling_class = "risk",
                    component = "runner",
                    "mitmproxy exited unexpectedly, scheduling restart"
                );
                mitm_retry.schedule();
            }
            // Mitmproxy restart result (background task)
            result = recv_mitm_restart(&mut mitm_retry.handle) => {
                match result {
                    Ok(result) => handle_mitm_restart_result(result, &mut mitm, &mut mitm_retry),
                    Err(error) => {
                        stop_mitm_retries(&mut mitm_crash_rx, &mut mitm_retry);
                        handle_stopping_signal("mitm-recovery", &provider_state.cancel,
                            &provider_state.cancel_tokens, &lifecycle).await;
                        terminal_error = Some(error);
                    }
                }
            }
            // A late crash can arm a timer during recovery. Keep that request,
            // but do not spin on an expired timer while its owner is in flight.
            () = sleep_until_retry(&mitm_retry.restart_at), if mitm_retry.handle.is_none() => {}
            // Heartbeat: report runner state to the server
            _ = heartbeat_tick.tick() => {
                let live_mode = *mode_rx.borrow();
                heartbeat.request(live_mode)?;
                if status_retry_handle.is_none() {
                    status_retry_handle = Some(status_retry_task(Arc::clone(&shared.status)));
                }
                #[cfg(test)]
                test_hooks
                    .test_observer
                    .notify_routine_heartbeat_requested(live_mode);
            }
            _ = sleep_until_optional_instant(pending_finalizing_deadline),
                if pending_finalizing_candidate.is_some() && mode == RunnerMode::Running =>
            {
                let Some(candidate) = pending_finalizing_candidate.take() else {
                    continue;
                };
                let candidate = candidate
                    .without_runner_preference(RunnerPreferenceRemovalReason::Expired);
                let result = handle_discovered_job(
                    DiscoveredJob { candidate },
                    DiscoveredJobContext {
                        runner_identity: runner.identity,
                        profiles: &runner.profiles,
                        factories: &factories,
                        budget: &capacity.budget,
                        idle_pool: &shared.idle_pool,
                        status: &shared.status,
                        mode_rx: &mode_rx,
                        cancel_tokens: &provider_state.cancel_tokens,
                        spawn_ctx: &spawn_ctx,
                        jobs: &mut jobs,
                    },
                ).await;
                if let Some(candidate) = result.pending_candidate {
                    retain_finalizing_candidate(
                        &mut pending_finalizing_candidate,
                        candidate,
                    );
                }
                if result.needs_reuse_state_refresh {
                    heartbeat.request(*mode_rx.borrow())?;
                }
            }
            // Immediate heartbeat after reusable state changes eliminates the
            // up-to-10s blind spot for reuse-aware routing.
            _ = reuse_state_notify.notified(), if matches!(mode, RunnerMode::Running | RunnerMode::Draining) => {
                let live_mode = *mode_rx.borrow();
                if live_mode == RunnerMode::Running
                    && let Some(candidate) = pending_finalizing_candidate.take()
                {
                    let result = handle_discovered_job(
                        DiscoveredJob { candidate },
                        DiscoveredJobContext {
                            runner_identity: runner.identity,
                            profiles: &runner.profiles,
                            factories: &factories,
                            budget: &capacity.budget,
                            idle_pool: &shared.idle_pool,
                            status: &shared.status,
                            mode_rx: &mode_rx,
                            cancel_tokens: &provider_state.cancel_tokens,
                            spawn_ctx: &spawn_ctx,
                            jobs: &mut jobs,
                        },
                    ).await;
                    if let Some(candidate) = result.pending_candidate {
                        retain_finalizing_candidate(
                            &mut pending_finalizing_candidate,
                            candidate,
                        );
                    }
                }
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
    memory_prefetch.cancel();
    teardown.event("memory_prefetch_cancelled");

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

    let phase = teardown.phase_start("blank_pool_shutdown");
    blank_pool.shutdown().await;
    teardown.phase_complete("blank_pool_shutdown", phase);

    let phase = teardown.phase_start("heartbeat_drain");
    if let Err(error) = heartbeat.drain().await {
        error!(%error, "failed to drain heartbeat task");
        terminal_error.get_or_insert(error);
    }
    let final_heartbeat_sequence = heartbeat.into_next_snapshot_sequence();
    teardown.phase_complete("heartbeat_drain", phase);

    let phase = teardown.phase_start("maintenance_drain");
    #[cfg(test)]
    test_hooks
        .test_observer
        .record(StartLoopEvent::MaintenanceDrainEntered);
    for (name, task) in [
        ("status retry", &mut status_retry_handle),
        ("workspace cache GC", &mut workspace_cache_gc_handle),
    ] {
        if task.is_some()
            && let Err(error) = next_maintenance_task(task, name).await
        {
            error!(%error, "failed to drain maintenance task");
            terminal_error.get_or_insert(error);
        }
        *task = None;
    }
    teardown.phase_complete("maintenance_drain", phase);

    // Drop the pinned discover future before provider shutdown so any
    // provider-local discovery resources are released first. This also keeps
    // the historical shutdown-deadlock regression covered by mock providers.
    drop(discover_fut);
    teardown.event("drop_discover_fut");
    drop(workspace_cache_change_fut);

    // Drain idle pool first — these sandboxes hold budget reservations. This
    // also clears `idle_sandboxes` in status.json so the final snapshot is
    // consistent with the empty pool.
    lifecycle.close_parking();
    let phase = teardown.phase_start("drain_idle_pool");
    drain_idle_pool(&shared.idle_pool, &shared.status, "shutdown").await;
    teardown.phase_complete("drain_idle_pool", phase);

    let phase = teardown.phase_start("provider_shutdown");
    provider_state.provider.shutdown().await;
    teardown.phase_complete("provider_shutdown", phase);

    // Send final heartbeat with Stopping so the server stops routing jobs
    // to this runner immediately, without waiting for TTL expiry.
    let phase = teardown.phase_start("final_heartbeat");
    {
        let pool = shared.idle_pool.lock().await;
        let state = collect_heartbeat_state(
            HeartbeatSnapshotMetadata {
                runner_identity: runner.identity,
                group: &runner.group,
                sequence: final_heartbeat_sequence,
            },
            &runner.profiles,
            &capacity.budget,
            &pool,
            RunnerMode::Stopping,
        );
        drop(pool);
        provider_state.provider.heartbeat(&state).await;
    }
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
            maybe_spawn_mitm_restart(&mut mitm, &mut mitm_crash_rx, &mut mitm_retry);

            tokio::select! {
                result = jobs.join_next() => {
                    handle_job_result(result).await;
                    if !orphaned_active_runs.is_empty() {
                        reap_orphaned_active_runs(
                            &orphaned_active_runs,
                            &shared.idle_pool,
                            &shared.status,
                            OrphanReapMode::Immediate,
                            orphan_reap.process_discovery.as_ref(),
                        ).await;
                    }
                }
                Some(()) = usage_flush_rx.recv() => {
                    #[cfg(test)]
                    test_hooks.test_observer.notify_usage_flush_requested();
                    mitm.request_usage_flush();
                }
                Some(()) = mitm_crash_rx.recv() => {
                    error!(
                        r#type = "usage_underbilling",
                        reason = "mitm_restart_in_memory_usage_risk",
                        underbilling_class = "risk",
                        component = "runner",
                        "mitmproxy exited unexpectedly, scheduling restart"
                    );
                    mitm_retry.schedule();
                }
                result = recv_mitm_restart(&mut mitm_retry.handle) => {
                    match result {
                        Ok(result) => handle_mitm_restart_result(result, &mut mitm, &mut mitm_retry),
                        Err(error) => {
                            stop_mitm_retries(&mut mitm_crash_rx, &mut mitm_retry);
                            handle_stopping_signal("mitm-recovery", &provider_state.cancel,
                                &provider_state.cancel_tokens, &lifecycle).await;
                            terminal_error.get_or_insert(error);
                        }
                    }
                }
                () = sleep_until_retry(&mitm_retry.restart_at), if mitm_retry.handle.is_none() => {}
            }
        }
    }
    teardown.phase_complete("running_jobs_drain", phase);
    if !orphaned_active_runs.is_empty() {
        let phase = teardown.phase_start("orphan_reap_shutdown_final");
        reap_orphaned_active_runs(
            &orphaned_active_runs,
            &shared.idle_pool,
            &shared.status,
            OrphanReapMode::ShutdownFinal,
            orphan_reap.process_discovery.as_ref(),
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
    let phase = teardown.phase_start("background_fill_shutdown");
    exec_config.background_fill.shutdown().await;
    exec_config.decoded_cache.shutdown().await;
    teardown.phase_complete("background_fill_shutdown", phase);
    let phase = teardown.phase_start("finish_mitm_restart");
    if let Err(error) = finish_mitm_restart_before_shutdown(&mut mitm, &mut mitm_retry).await {
        error!(%error, "failed to finish mitmproxy recovery");
        terminal_error.get_or_insert(error);
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

    // Keep the pool-scoped INPUT filters installed until dnsmasq is gone.
    // Runtime shutdown owns those filters, so it must follow DNS shutdown to
    // avoid exposing the wildcard listener between the two cleanup phases.
    let phase = teardown.phase_start("dns_stop");
    if let Err(error) = dns_handle.stop().await {
        error!(%error, "DNS cleanup failed during shutdown");
        terminal_error.get_or_insert(error);
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
        terminal_error.get_or_insert(error);
    }
    teardown.phase_complete("kmsg_stop", phase);
    let phase = teardown.phase_start("memory_prefetch_drain");
    memory_prefetch.drain().await;
    teardown.phase_complete("memory_prefetch_drain", phase);

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
