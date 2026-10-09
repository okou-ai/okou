//! `runner start` — executable boot and runtime composition.
//!
//! `run_start` registers signals before slow work, validates configuration,
//! claims the canonical base-dir lock and image locks, assembles provider,
//! network and executor resources, and publishes the live process registry.
//! It passes concrete profile/factory plans, release and logging policy to
//! `runner_supervisor::reactor::run`; no executable configuration type or
//! root-instantiated reactor future crosses that boundary. Locks remain held
//! until runtime teardown returns, followed by identity-aware registry removal.
//!
//! Supervisor owns the retained loop, ordered factory creation/rollback,
//! signal consumer, dispatch, independent maintenance and resource teardown.
//! The following delegated contracts remain mandatory:
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
//! See `docs/runner/runner-reactor-progress.md` for the shared-resource audit and
//! cancellation/teardown ownership rules.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
#[cfg(test)]
use std::time::Duration;

use clap::Args;
use sandbox::{RuntimeProvider, SandboxRuntime};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};
use uuid::Uuid;

#[cfg(test)]
use crate::config::RootfsSnapshotPathsExt;
use crate::config::{self, ProfileConfig};
use crate::error::{RunnerError, RunnerResult};
use crate::executor::{ExecutorConfig, SessionHistoryCpuPool, SessionHistoryProbe};
use crate::home_image_cache::HomeImageCache;
use crate::http::{HttpClient, HttpClientConfig};
use crate::idle_pool::{IdlePool, IdlePoolConfig, ParkingGate};
use crate::lifecycle::RunnerMode;
use crate::network_log_drain::NetworkLogDrainCoordinator;
use crate::network_log_manager::NetworkLogManager;
use crate::pre_spawn_admission::PreSpawnAdmission;
use crate::resource_budget::ResourceBudget;
use crate::status::{StatusTracker, remove_stale_status_file};
use crate::{deps, dns, kmsg_log, prefetch, proxy};
use runner_host::paths::{HomePaths, LogPaths, RunnerPaths, touch_mtime};
use runner_host::runner_process_identity::load_runner_process_identity;
use runner_host::{host, lock};
use runner_lifecycle::active_runs::ActiveRuns;
use runner_provider::{
    ApiProvider, ApiProviderConfig, BuiltinFirewallCatalogCachePaths, ConnectorRuntimeSyncHandle,
    JobProvider, LocalProvider, RunCancellationRegistry,
};
use runner_supervisor::reactor::{
    self, CapacityPolicy, EarlySignals, OrphanReapState, ProviderState, ProxyState, RunConfig,
    RunPaths, RunnerInfo, RunnerSharedState, RuntimeProfile, SandboxRuntimeConfig, ShutdownHandles,
    SignalSource, SignalState, WssConfig,
};

mod signals;

#[derive(Args)]
pub struct StartArgs {
    /// Path to runner.yaml config file
    #[arg(long, short)]
    pub(crate) config: PathBuf,
    /// Okou API URL (overrides config; `OKOU_API_BACKEND_URL`).
    /// Must be an absolute URL without credentials, query, or fragment.
    /// HTTPS is required except for HTTP hosts normalized to localhost, IPv4 loopback
    /// (127.0.0.0/8), or IPv6 loopback (::1). Private network addresses require HTTPS.
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
            Err(e.into())
        }
    }
}

/// Load config and run the main poll loop.
pub async fn run_start(
    args: StartArgs,
    runtime_provider: &dyn RuntimeProvider,
) -> RunnerResult<()> {
    run_start_with_home(args, runtime_provider, || Ok(HomePaths::new()?)).await
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
    let signals = signals::register_early_signals()
        .map_err(|e| RunnerError::Internal(format!("register signal handlers: {e}")))?;

    run_with_host_memory_observer(run_start_observed(
        args,
        runtime_provider,
        load_home,
        signals,
    ))
    .await
}

async fn run_with_host_memory_observer(
    work: impl std::future::Future<Output = RunnerResult<()>>,
) -> RunnerResult<()> {
    // This passive owner surrounds every fallible startup/reactor return. It starts
    // before optional warming and never depends on heartbeat, pool or status locks.
    let observer = runner_supervisor::host_memory::HostMemoryObserver::spawn();
    let result = work.await;
    if let Err(error) = observer.shutdown().await {
        if result.is_ok() {
            return Err(RunnerError::Internal(format!(
                "join host memory observer: {error}"
            )));
        }
        error!(%error, "host memory observer join failed during startup/runtime failure");
    }
    result
}

async fn run_start_observed(
    args: StartArgs,
    runtime_provider: &dyn RuntimeProvider,
    load_home: impl FnOnce() -> RunnerResult<HomePaths>,
    signals: EarlySignals,
) -> RunnerResult<()> {
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

    let runner_host_env = runner_host::host_env::read_runner_host_env()?;
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
            env_var = runner_host::host_env::RUNNER_CONCURRENCY_FACTOR_ENV,
            override_source = concurrency_factor_source.label(),
            concurrency_factor,
            yaml_concurrency_factor,
            "using host environment override for concurrency_factor"
        );
    }

    runner_host::private_fs::ensure_private_dir(&runner_config.base_dir).await?;

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
    let installed_okou_cli = resource_locks.uniform_installed_okou_cli().cloned();
    match &installed_okou_cli {
        Some(installed) => info!(
            cli_version = %installed.versions.cli,
            pi_agent_runtime_version = %installed.versions.pi_agent_runtime,
            pi_sdk_version = %installed.versions.pi_sdk,
            "installed Okou CLI advertised for claims"
        ),
        None => info!("no installed Okou CLI recorded for every profile; claims advertise none"),
    }

    let log_paths = LogPaths::new(home.logs_dir());
    runner_host::log_file::ensure_log_dir(log_paths.dir()).map_err(|e| {
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
        runner_version: env!("CARGO_PKG_VERSION"),
    })?;
    let background_fill = crate::storage_cache::StorageCacheBackgroundFillCoordinator::new()?;
    let hostname = runner_config.hostname;
    // Official socket health belongs to Supervisor; optional Caddy availability
    // only suppresses issuance. Admission uses the executor's exact registry.
    let wss = (!args.local)
        .then(|| WssConfig::official(http.clone(), server.token.clone(), hostname.clone()));
    let group = runner_config.group;
    let cancel_tokens = RunCancellationRegistry::new();
    let local_group_dir = if args.local {
        let group_dir = home.groups_dir().join(&group);
        runner_provider::local_queue::ensure_group_dir(&group_dir).map_err(|e| {
            RunnerError::Config(format!("create group dir {}: {e}", group_dir.display()))
        })?;
        for profile in runner_config.profiles.keys() {
            runner_provider::local_queue::ensure_profile_jobs_dir(&group_dir, profile).map_err(
                |e| RunnerError::Config(format!("create job dir for profile {profile}: {e}")),
            )?;
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
    let (mut mitm, mitm_crash_rx) = proxy::MitmProxy::new(
        proxy::ProxyConfig {
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
            client_version: env!("CARGO_PKG_VERSION"),
            system_ca_bundle: deps::SYSTEM_CA_BUNDLE,
        },
        crate::ADDON_FILES,
    )
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
        crate::ssh::SshRuntime::official(http.clone(), &server.token, runner_identity)
            .map_err(|error| crate::error::RunnerError::Internal(error.to_string()))?
    } else {
        None
    };
    let vnc = if local_group_dir.is_none() {
        crate::vnc::VncRuntime::official(http.clone(), &server.token, runner_identity)
            .map_err(|error| crate::error::RunnerError::Internal(error.to_string()))?
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
                ably_side_message_handler: ssh
                    .clone()
                    .map(|runtime| runtime as Arc<dyn runner_provider::AblySideMessageHandler>),
                runner_identity,
                runner_hostname: hostname.clone(),
                group,
                supported_profiles: profiles,
                installed_okou_cli,
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
    let guest_rpc = (ssh.is_some() || vnc.is_some()).then(|| crate::guest_rpc::Runtime {
        ssh,
        vnc,
        usage: Some(crate::run_usage::Runtime::new(
            crate::MitmUsageHandle::from(&mitm),
        )),
    });

    let exec_config = Arc::new(ExecutorConfig {
        api_url: server.url,
        runner_hostname: hostname,
        registry: registry_handle,
        http,
        log_paths,
        network_log_manager,
        network_log_drain,
        network_log_upload_health: crate::network_logs::NetworkLogUploadHealthTracker::new(),
        mitm_jsonl_flush: Some(mitm.jsonl_flush_handle()),
        connector_runtime_sync,
        guest_rpc,
        guest_duplex: runner_remote::guest_duplex::RunGuestChannels::default(),
        session_history_cpu: SessionHistoryCpuPool::for_host_cpus(host_cpus),
        session_history_probe: SessionHistoryProbe::default(),
        fresh_archive_delivery: crate::storage_cache::FreshArchiveDeliveryAdmission::new(),
        decoded_cache: crate::storage_cache::decoded::DecodedCache::new(home.clone()),
        background_fill,
        pre_spawn_admission,
        home: home.clone(),
        home_cache: Some(
            HomeImageCache::shared(paths.clone(), &home, &group_name)
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
            profiles: runtime_profiles(
                &runner_config.profiles,
                &runner_config.firecracker,
                &runner_config.base_dir,
                &home,
            ),
            release: crate::RUNNER_RELEASE,
        },
        paths: RunPaths {
            home,
            base_dir: runner_config.base_dir,
        },
        sandbox_runtime: SandboxRuntimeConfig { runtime },
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
        wss_ingress_service_probe: if args.local {
            Arc::new(|| Box::pin(async { false }))
        } else {
            Arc::new(|| Box::pin(runner_host::wss_ingress_service_status::is_active()))
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
        wss,
        signals: SignalState {
            signal_source: SignalSource::Real(signals),
        },
        orphan_reap: OrphanReapState::default(),
        diagnostic_error_tail_max_bytes: crate::axiom_layer::TEXT_FIELD_MAX_BYTES,
    };

    let run_result = reactor::run(config).await.map_err(Into::into);
    drop(resource_locks);
    if let Err(e) = live_runner_instance_handle.remove_if_current().await {
        tracing::warn!(error = %e, "failed to remove live runner instance record");
    }
    run_result
}

/// Project validated boot configuration into concrete runtime inputs only.
/// Factory creation remains after status publication and provider readiness.
fn runtime_profiles(
    profiles: &BTreeMap<String, ProfileConfig>,
    firecracker: &config::FirecrackerConfig,
    base_dir: &std::path::Path,
    home: &HomePaths,
) -> BTreeMap<String, RuntimeProfile> {
    profiles
        .iter()
        .map(|(name, profile)| {
            (
                name.clone(),
                RuntimeProfile {
                    vcpu: profile.vcpu,
                    memory_mb: profile.memory_mb,
                    rootfs_hash: profile.rootfs_hash.clone(),
                    rootfs_disk_mb: profile.rootfs_disk_mb,
                    home_disk_mb: profile.home_disk_mb,
                    factory_config: config::RunnerConfig::build_factory_config(
                        firecracker,
                        base_dir,
                        name,
                        profile,
                        home,
                    ),
                },
            )
        })
        .collect()
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

#[cfg(test)]
mod tests;
