//! Runtime health diagnostics for all runners on the host.

use std::collections::HashSet;
use std::fmt;
use std::fmt::Write as _;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use crate::config::RunnerConfig;
use crate::error::{RunnerError, RunnerResult};
use crate::live_runner_instances::LiveRunnerInstance;
use crate::status_file::{self, StatusForDoctor};
use chrono::{DateTime, Utc};
use clap::Args;
use futures_util::{StreamExt, stream};
use nbd_cow::orphan::NbdOrphanCandidate;
use reqwest::Client;
use runner_host::paths::HomePaths;
use runner_host::process;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

/// CLI arguments for the `doctor` subcommand.
#[derive(Args)]
pub struct DoctorArgs {
    /// Only check the Runner service with this systemd unit suffix
    #[arg(long)]
    name: Option<String>,
}

// ---------------------------------------------------------------------------
// Warning type — structured anomalies with targeted recheck
// ---------------------------------------------------------------------------

/// How long to wait before each recheck of detected anomalies.
const RECHECK_DELAY: Duration = Duration::from_secs(3);

/// Maximum number of recheck attempts before reporting persistent anomalies.
///
/// The explicit sleep budget is `RECHECK_MAX_ATTEMPTS × RECHECK_DELAY` = 9 s.
/// Total latency also includes the bounded I/O performed during each recheck.
const RECHECK_MAX_ATTEMPTS: u32 = 3;

/// Maximum number of doctor I/O operations performed concurrently.
const DOCTOR_IO_CONCURRENCY: usize = 4;

const SYSTEMD_SYSTEM_DIR: &str = "/etc/systemd/system";

/// Total timeout for each API connectivity probe, including cold starts.
const API_CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// Grace period where a freshly claimed new-sandbox run may still be preparing
/// and may not have a stable Firecracker process yet.
const PREPARING_NO_PROCESS_GRACE: Duration = Duration::from_secs(120);

/// A detected anomaly that carries enough context to recheck itself.
enum Warning {
    /// status.json is missing or cannot be read as Doctor status.
    StatusUnavailable { base_dir: PathBuf },
    /// API server not responding to HEAD request.
    ApiUnreachable {
        server_url: String,
        server_token: String,
    },
    /// status.json lists a proxy port but no mitmdump process found on it.
    NoMitmproxy { port: u16, base_dir: PathBuf },
    /// status.json lists a run with its sandbox_id but no firecracker process
    /// hosts that sandbox_id.
    NoFirecrackerForRun {
        run_id: String,
        sandbox_id: String,
        base_dir: PathBuf,
    },
    /// status.json lists a run that has remained in preparing too long.
    StalePreparingRun {
        run_id: String,
        sandbox_id: String,
        base_dir: PathBuf,
    },
    /// A firecracker process exists but its sandbox_id is not tracked as
    /// active, exact idle, or blank inventory for this runner.
    FirecrackerNotInStatus {
        pid: u32,
        sandbox_id: String,
        base_dir: PathBuf,
        generation: Option<process::ProcfsProcessGeneration>,
    },
    /// A firecracker process whose ppid chain doesn't lead to any runner.
    OrphanFirecracker {
        pid: u32,
        sandbox_id: String,
        base_dir: Option<PathBuf>,
        ppid: Option<u32>,
        generation: Option<process::ProcfsProcessGeneration>,
    },
    /// A mitmdump process on an unclaimed port whose ppid chain is orphaned.
    OrphanMitmdump {
        pid: u32,
        port: u16,
        ppid: Option<u32>,
        generation: Option<process::ProcfsProcessGeneration>,
    },
    /// Runner is stopped but a mitmproxy process is still using its port.
    StaleMitmproxy { port: u16 },
    /// status.json lists a dns_port but no dnsmasq process found on it.
    NoDnsmasq { port: u16, base_dir: PathBuf },
    /// A network namespace whose pool lock is not held by any process.
    OrphanNamespace { ns_name: String, lock_path: PathBuf },
    /// An NBD device whose recorded owner task has exited and whose lock is free.
    OrphanNbdDevice { candidate: NbdOrphanCandidate },
    /// The NBD orphan scan task panicked (bug in find_nbd_orphans).
    NbdScanFailed,
}

impl fmt::Display for Warning {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StatusUnavailable { .. } => write!(f, "status.json unavailable"),
            Self::ApiUnreachable { .. } => write!(f, "API unreachable"),
            Self::NoMitmproxy { port, .. } => {
                write!(f, "no mitmproxy process on port {port}")
            }
            Self::NoDnsmasq { port, .. } => {
                write!(f, "no dnsmasq process on port {port}")
            }
            Self::NoFirecrackerForRun {
                run_id, sandbox_id, ..
            } => {
                write!(
                    f,
                    "no firecracker process for run {run_id} (sandbox {sandbox_id})"
                )
            }
            Self::StalePreparingRun {
                run_id, sandbox_id, ..
            } => {
                write!(f, "run {run_id} stuck preparing (sandbox {sandbox_id})")
            }
            Self::FirecrackerNotInStatus {
                pid, sandbox_id, ..
            } => {
                write!(
                    f,
                    "firecracker PID {pid} (sandbox {sandbox_id}) not in status.json"
                )
            }
            Self::OrphanFirecracker {
                pid,
                sandbox_id,
                ppid,
                ..
            } => {
                let ppid_str = ppid.map_or("?".into(), |p| p.to_string());
                write!(
                    f,
                    "orphan firecracker PID {pid} (sandbox {sandbox_id}, ppid={ppid_str})"
                )
            }
            Self::OrphanMitmdump {
                pid, port, ppid, ..
            } => {
                let ppid_str = ppid.map_or("?".into(), |p| p.to_string());
                write!(
                    f,
                    "orphan mitmdump PID {pid} (port {port}, ppid={ppid_str})"
                )
            }
            Self::StaleMitmproxy { port } => {
                write!(f, "stale mitmproxy process on port {port} (runner stopped)")
            }
            Self::OrphanNamespace { ns_name, .. } => {
                write!(f, "orphan namespace {ns_name} (pool lock not held)")
            }
            Self::OrphanNbdDevice { candidate } => {
                let device_index = candidate.device_index();
                let pid = candidate.owner_tid();
                write!(
                    f,
                    "orphan NBD device /dev/nbd{device_index} (owner PID {pid} no longer exists)"
                )
            }
            Self::NbdScanFailed => {
                write!(f, "NBD orphan scan failed (task panicked)")
            }
        }
    }
}

impl Warning {
    /// Targeted recheck: returns `true` if the anomaly still persists.
    ///
    /// Process-related checks use the pre-scanned `fresh` data (a single
    /// `/proc` scan shared across all warnings), and namespace checks use one
    /// observation shared across the global warning pass. Other checks do
    /// their own minimal I/O (status.json read, HTTP HEAD, flock).
    async fn persists(
        &self,
        api_client: Option<&Client>,
        fresh: &process::DiscoveredProcesses,
        runner_pids: &[u32],
        network_namespaces: Option<&HashSet<String>>,
    ) -> bool {
        match self {
            // Report-level rechecks consume a recovered snapshot before clearing
            // this warning. A generic recheck must never clear it without that update.
            Self::StatusUnavailable { .. } => true,
            Self::ApiUnreachable {
                server_url,
                server_token,
            } => {
                let Some(client) = api_client else {
                    return true;
                };
                !probe_api(client, server_url, server_token).await
            }
            Self::NoMitmproxy { port, base_dir } => {
                // Resolved if mitmproxy process now exists on this port.
                if fresh.mitmdumps.iter().any(|m| m.port == *port) {
                    return false;
                }
                // Resolved if mode transitioned to stopped/draining (proxy
                // shutdown is expected in these modes).
                !matches!(read_status(base_dir).await, Some(st) if is_inactive_mode(&st.mode))
            }
            Self::NoDnsmasq { port, base_dir } => {
                if fresh.dnsmasqs.iter().any(|d| d.port == *port) {
                    return false;
                }
                !matches!(read_status(base_dir).await, Some(st) if is_inactive_mode(&st.mode))
            }
            Self::NoFirecrackerForRun {
                run_id,
                sandbox_id,
                base_dir,
            } => {
                // Resolved if firecracker process now exists for this sandbox_id.
                if firecracker_found_for_sandbox(fresh, sandbox_id, base_dir) {
                    return false;
                }
                // Resolved if the original run/sandbox mapping is no longer
                // active. If the run finished or the same run id points at a
                // replacement sandbox, this warning no longer applies.
                //
                // On status-read failure we clear (return `false`) rather
                // than persist: if the runner's status.json is gone, any
                // still-running FC will be picked up by the orphan path
                // instead, and keeping a stale run-centric warning would
                // be noise.
                match read_status(base_dir).await {
                    Some(st) => st
                        .active_runs
                        .iter()
                        .find(|r| r.run_id == *run_id && r.sandbox_id == *sandbox_id)
                        .is_some_and(|active| active.phase() == ActiveRunPhase::Running),
                    None => false,
                }
            }
            Self::StalePreparingRun {
                run_id,
                sandbox_id,
                base_dir,
            } => match read_status(base_dir).await {
                Some(st) => st
                    .active_runs
                    .iter()
                    .find(|r| r.run_id == *run_id && r.sandbox_id == *sandbox_id)
                    .is_some_and(|active| {
                        active_run_is_stale_preparing(active, Utc::now())
                            || (active.phase() == ActiveRunPhase::Running
                                && !firecracker_found_for_sandbox(fresh, sandbox_id, base_dir))
                    }),
                None => false,
            },
            Self::FirecrackerNotInStatus {
                pid,
                sandbox_id,
                base_dir,
                generation,
            } => {
                // Resolved if fresh discovery no longer contains the same
                // Firecracker observation or sandbox_id is now known (either
                // tracked as active or parked as exact/blank inventory).
                if !fresh_contains_firecracker(
                    fresh,
                    *pid,
                    sandbox_id,
                    Some(base_dir),
                    generation.as_ref(),
                ) {
                    return false;
                }
                match read_status(base_dir).await {
                    Some(st) => {
                        let active = st.active_runs.iter().any(|r| r.sandbox_id == *sandbox_id);
                        let idle = st
                            .idle_sandboxes
                            .iter()
                            .any(|v| v.sandbox_id == *sandbox_id);
                        let blank = st
                            .blank_sandboxes
                            .iter()
                            .any(|v| v.sandbox_id == *sandbox_id);
                        !(active || idle || blank)
                    }
                    None => true,
                }
            }
            Self::StaleMitmproxy { port } => fresh.mitmdumps.iter().any(|mitm| mitm.port == *port),
            Self::OrphanFirecracker {
                pid,
                sandbox_id,
                base_dir,
                generation,
                ..
            } => {
                // Resolved if fresh discovery no longer contains the same
                // Firecracker observation or a runner registry entry appeared
                // after the initial scan and now owns the process.
                fresh_contains_firecracker(
                    fresh,
                    *pid,
                    sandbox_id,
                    base_dir.as_deref(),
                    generation.as_ref(),
                ) && process::is_orphan(*pid, runner_pids).await
            }
            Self::OrphanMitmdump {
                pid,
                port,
                generation,
                ..
            } => {
                // A live PID alone may belong to a replacement. Require the
                // same known proxy observation before checking current ancestry.
                generation.is_some()
                    && fresh.mitmdumps.iter().any(|mitm| {
                        mitm.pid == *pid && mitm.port == *port && mitm.generation == *generation
                    })
                    && process::is_orphan(*pid, runner_pids).await
            }
            Self::OrphanNamespace { ns_name, lock_path } => {
                if network_namespaces.is_some_and(|namespaces| !namespaces.contains(ns_name)) {
                    return false;
                }
                is_lock_free(lock_path).await
            }
            Self::OrphanNbdDevice { candidate } => {
                let candidate = *candidate;
                tokio::task::spawn_blocking(move || super::nbd::nbd_orphan_is_reportable(candidate))
                    .await
                    .unwrap_or(false)
            }
            Self::NbdScanFailed => {
                // Retry the scan — persists if it panics again.
                tokio::task::spawn_blocking(super::nbd::find_nbd_orphans)
                    .await
                    .is_err()
            }
        }
    }
}

struct ObservedNetworkNamespace {
    ns_name: String,
    pool_idx: u32,
}

fn fresh_contains_firecracker(
    fresh: &process::DiscoveredProcesses,
    pid: u32,
    sandbox_id: &str,
    base_dir: Option<&Path>,
    generation: Option<&process::ProcfsProcessGeneration>,
) -> bool {
    fresh.firecrackers.iter().any(|firecracker| {
        firecracker.pid == pid
            && firecracker.sandbox_id == sandbox_id
            && firecracker.base_dir.as_deref() == base_dir
            && firecracker.generation.as_ref() == generation
    })
}

fn firecracker_found_for_sandbox(
    fresh: &process::DiscoveredProcesses,
    sandbox_id: &str,
    base_dir: &Path,
) -> bool {
    fresh
        .firecrackers
        .iter()
        .any(|f| f.sandbox_id == sandbox_id && f.base_dir.as_deref() == Some(base_dir))
}

// ---------------------------------------------------------------------------
// Report structs
// ---------------------------------------------------------------------------

struct RunnerReport {
    live_runner: LiveRunnerInstance,
    service_type: ServiceType,
    status: Option<StatusInfo>,
    api_ok: Option<bool>,
    proxy_pid: Option<u32>,
    dns_pid: Option<u32>,
    jobs: Vec<JobReport>,
    warnings: Vec<Warning>,
}

impl RunnerReport {
    fn apply_status_diagnostics(&mut self, diagnostics: StatusDiagnostics) {
        self.status = Some(diagnostics.status);
        self.proxy_pid = diagnostics.proxy_pid;
        self.dns_pid = diagnostics.dns_pid;
        self.jobs = diagnostics.jobs;
        self.warnings.extend(diagnostics.warnings);
    }
}

struct StatusDiagnostics {
    status: StatusInfo,
    proxy_pid: Option<u32>,
    dns_pid: Option<u32>,
    jobs: Vec<JobReport>,
    warnings: Vec<Warning>,
}

enum ServiceType {
    Installed(String),
    Transient(String),
    Bare,
}

struct StatusInfo {
    mode: String,
    started_at: String,
    active_runs: Vec<ActiveRun>,
    idle_sandboxes: Vec<IdleSandbox>,
    blank_sandboxes: Vec<BlankSandbox>,
    proxy_port: Option<u16>,
    dns_port: Option<u16>,
}

struct InstalledService {
    unit_name: String,
    config_path: Option<PathBuf>,
}

/// One row in the per-runner jobs table. The inner `JobStatus` variant
/// carries whichever identifier is meaningful for that row — `run_id`
/// for tracked runs, `sandbox_id` for orphan firecrackers — so the two
/// cannot be confused by downstream formatting.
struct JobReport {
    status: JobStatus,
}

enum JobStatus {
    /// Active run with a matching firecracker process.
    Running { run_id: String, pid: u32 },
    /// Active run is still preparing a fresh sandbox; Firecracker may not exist
    /// or may not be ready yet.
    Preparing { run_id: String, pid: Option<u32> },
    /// Active run whose firecracker process is missing.
    NoProcess { run_id: String },
    /// Firecracker process present but not recorded in status.json.
    /// Keyed by `sandbox_id` because no `run_id` is known.
    NotInStatus { sandbox_id: String },
}

struct StoppedInfo {
    unit_name: String,
    config_info: String,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Run runtime health diagnostics for runner processes on this host.
///
/// Returns `ExitCode::FAILURE` when any per-runner or global anomaly still
/// persists after targeted rechecks; otherwise returns `ExitCode::SUCCESS`.
pub async fn run_doctor(args: DoctorArgs) -> RunnerResult<ExitCode> {
    // Phase 1: Discover running processes (single /proc scan)
    let discovered = process::discover_all().await;
    let home = HomePaths::new()?;

    // Phase 2: Resolve the selected service or discover installed services
    let (config_path_filter, installed_services) =
        discover_services(args.name.as_deref(), Path::new(SYSTEMD_SYSTEM_DIR)).await?;

    // Phase 3: Build runner reports
    let live_runners = crate::live_runner_instances::try_list(&home).await?;
    let api_client = build_api_client();
    let mut reports = build_runner_reports(
        &live_runners,
        config_path_filter.as_deref(),
        api_client.as_ref(),
        &discovered,
        &installed_services,
    )
    .await;

    // Phase 4: Find stopped services (installed but no matching running process)
    // Skip when filtering by service — other runners' stopped services are irrelevant.
    let stopped = if args.name.is_none() {
        find_stopped_services(&installed_services, &reports)
    } else {
        vec![]
    };

    // Phase 5: Global orphan detection
    // When --name is set, run orphan firecracker detection scoped to that
    // service's selected Runner. Orphan mitmproxy and namespace are skipped (no
    // runner-identifying info on orphaned processes).
    let mut global_warnings: Vec<Warning> = if args.name.is_none() {
        detect_global_orphans(&reports, &discovered.firecrackers, &discovered.mitmdumps).await
    } else {
        // Scoped detection: orphan firecracker for the selected service.
        // Orphan mitmproxy, namespace, and NBD devices are skipped because
        // they lack per-runner attribution — report them only in global mode
        // (no --name) so they don't cause unrelated runners to fail.
        let mut warnings = Vec::new();

        // Orphan firecracker: scope by base_dir match.
        let selected_base_dir = reports.first().map(|r| r.live_runner.base_dir.as_path());
        if let Some(base_dir) = selected_base_dir {
            let runner_pids: Vec<u32> = live_runners.iter().map(|runner| runner.pid).collect();
            warnings.extend(
                detect_orphan_firecrackers(&discovered.firecrackers, &runner_pids, Some(base_dir))
                    .await,
            );
        }

        warnings
    };

    // Phase 6: Targeted recheck of anomalies
    // When warnings are found, wait briefly and recheck only the failing items.
    // This filters transient false-positives (e.g. NO PROCESS during run cleanup)
    // without redoing the entire scan. Up to 3 attempts, 3s apart.
    for _ in 0..RECHECK_MAX_ATTEMPTS {
        let has_warnings =
            reports.iter().any(|r| !r.warnings.is_empty()) || !global_warnings.is_empty();
        if !has_warnings {
            break;
        }

        tokio::time::sleep(RECHECK_DELAY).await;

        // Single /proc scan shared across all warning rechecks.
        let fresh = process::discover_all().await;

        recheck_per_runner_warnings(&home, api_client.as_ref(), &fresh, &mut reports).await?;

        let rechecks_orphan_process = global_warnings.iter().any(|warning| {
            matches!(
                warning,
                Warning::OrphanFirecracker { .. } | Warning::OrphanMitmdump { .. }
            )
        });
        let fresh_runner_pids: Vec<u32> = if rechecks_orphan_process {
            crate::live_runner_instances::try_list(&home)
                .await?
                .into_iter()
                .map(|runner| runner.pid)
                .collect()
        } else {
            Vec::new()
        };
        let network_namespaces: Option<HashSet<String>> = if global_warnings
            .iter()
            .any(|warning| matches!(warning, Warning::OrphanNamespace { .. }))
        {
            observe_network_namespaces().await.map(|namespaces| {
                namespaces
                    .into_iter()
                    .map(|namespace| namespace.ns_name)
                    .collect()
            })
        } else {
            None
        };
        let mut rechecked_global = Vec::new();
        for warning in global_warnings.drain(..) {
            if warning
                .persists(
                    api_client.as_ref(),
                    &fresh,
                    &fresh_runner_pids,
                    network_namespaces.as_ref(),
                )
                .await
            {
                rechecked_global.push(warning);
            }
        }
        global_warnings = rechecked_global;
    }

    // Phase 7: Output
    Ok(print_report(&reports, &stopped, &global_warnings))
}

async fn recheck_per_runner_warnings(
    home: &HomePaths,
    api_client: Option<&Client>,
    fresh: &process::DiscoveredProcesses,
    reports: &mut [RunnerReport],
) -> RunnerResult<()> {
    for report in reports.iter_mut() {
        if report.warnings.is_empty() {
            continue;
        }
        if !crate::live_runner_instances::is_current(home, &report.live_runner).await? {
            report.warnings.clear();
        }
    }

    recheck_current_runner_warnings(api_client, fresh, reports).await;
    Ok(())
}

async fn recheck_current_runner_warnings(
    api_client: Option<&Client>,
    fresh: &process::DiscoveredProcesses,
    reports: &mut [RunnerReport],
) {
    stream::iter(
        reports
            .iter_mut()
            .filter(|report| !report.warnings.is_empty()),
    )
    .map(|report| async move {
        let mut rechecked = Vec::new();
        let mut recovered_status = None;
        for warning in std::mem::take(&mut report.warnings) {
            match warning {
                Warning::StatusUnavailable { base_dir } => {
                    if let Some(status) = read_status(&base_dir).await {
                        recovered_status = Some(build_status_diagnostics(
                            status,
                            &base_dir,
                            &fresh.firecrackers,
                            &fresh.mitmdumps,
                            &fresh.dnsmasqs,
                        ));
                    } else {
                        rechecked.push(Warning::StatusUnavailable { base_dir });
                    }
                }
                warning => {
                    if warning.persists(api_client, fresh, &[], None).await {
                        rechecked.push(warning);
                    }
                }
            }
        }
        report.warnings = rechecked;
        if let Some(diagnostics) = recovered_status {
            report.apply_status_diagnostics(diagnostics);
        }
    })
    .buffer_unordered(DOCTOR_IO_CONCURRENCY)
    .for_each(|_| async {})
    .await;
}

/// Refill completed I/O slots immediately while preserving input order for display.
async fn collect_doctor_io<F: Future>(operations: impl IntoIterator<Item = F>) -> Vec<F::Output> {
    let mut results = stream::iter(operations.into_iter().enumerate())
        .map(|(index, operation)| async move { (index, operation.await) })
        .buffer_unordered(DOCTOR_IO_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    results.sort_unstable_by_key(|(index, _)| *index);
    results.into_iter().map(|(_, result)| result).collect()
}

async fn build_runner_reports(
    live_runners: &[LiveRunnerInstance],
    config_path_filter: Option<&Path>,
    api_client: Option<&Client>,
    discovered: &process::DiscoveredProcesses,
    installed: &[InstalledService],
) -> Vec<RunnerReport> {
    collect_doctor_io(
        live_runners
            .iter()
            .filter(|runner| {
                config_path_filter.is_none_or(|config_path| runner.config_path == config_path)
            })
            .map(|runner| {
                build_runner_report(
                    runner,
                    api_client,
                    &discovered.firecrackers,
                    &discovered.mitmdumps,
                    &discovered.dnsmasqs,
                    installed,
                )
            }),
    )
    .await
}

// ---------------------------------------------------------------------------
// Report building
// ---------------------------------------------------------------------------

async fn build_runner_report(
    runner: &LiveRunnerInstance,
    api_client: Option<&Client>,
    fc_procs: &[process::FirecrackerProcessInfo],
    mitm_procs: &[process::MitmproxyProcessInfo],
    dns_procs: &[process::DnsmasqProcessInfo],
    installed: &[InstalledService],
) -> RunnerReport {
    let mut warnings = Vec::new();

    // Load config (best-effort)
    let config = load_config_lenient(&runner.config_path).await;

    // Detect service type
    let service_type = detect_service_type(runner.pid, installed).await;

    // Benchmark publishes live identity but intentionally has no status writer.
    let status_expected = runner.subcommand == "start";
    let status = if status_expected {
        read_status(&runner.base_dir).await
    } else {
        None
    };

    // API connectivity check (only when server is configured)
    let api_ok = match &config {
        Some(cfg) => check_api(api_client, cfg).await,
        None => None,
    };
    if api_ok == Some(false)
        && let Some(cfg) = &config
        && let Some(server) = &cfg.server
    {
        warnings.push(Warning::ApiUnreachable {
            server_url: server.url.clone(),
            server_token: server.token.clone(),
        });
    }

    let mut report = RunnerReport {
        live_runner: runner.clone(),
        service_type,
        status: None,
        api_ok,
        proxy_pid: None,
        dns_pid: None,
        jobs: Vec::new(),
        warnings,
    };

    if let Some(status) = status {
        report.apply_status_diagnostics(build_status_diagnostics(
            status,
            &runner.base_dir,
            fc_procs,
            mitm_procs,
            dns_procs,
        ));
    } else if status_expected {
        report.warnings.push(Warning::StatusUnavailable {
            base_dir: runner.base_dir.clone(),
        });
    }

    report
}

async fn discover_services(
    name: Option<&str>,
    system_dir: &Path,
) -> RunnerResult<(Option<PathBuf>, Vec<InstalledService>)> {
    let Some(name) = name else {
        return Ok((None, find_installed_services(system_dir).await));
    };
    let unit = super::service::RunnerServiceUnit::from_suffix(name)?;
    let config_path = super::service::read_unit_config_path(&unit)
        .await?
        .ok_or_else(|| {
            RunnerError::Internal(format!(
                "{} does not select a runner --config path",
                unit.unit_name()
            ))
        })?;
    Ok((Some(config_path), Vec::new()))
}

fn build_status_diagnostics(
    status: StatusInfo,
    base_dir: &Path,
    fc_procs: &[process::FirecrackerProcessInfo],
    mitm_procs: &[process::MitmproxyProcessInfo],
    dns_procs: &[process::DnsmasqProcessInfo],
) -> StatusDiagnostics {
    let mut warnings = Vec::new();

    // Proxy check (match by port from status.json).
    //   running  + proxy missing  → NoMitmproxy warning
    //   stopped  + proxy present  → StaleMitmproxy warning
    //   draining                  → no warning either way
    let proxy_pid = if let Some(port) = status.proxy_port {
        let pid = mitm_procs.iter().find(|m| m.port == port).map(|m| m.pid);
        match (status.mode.as_str(), pid) {
            ("running", None) => {
                warnings.push(Warning::NoMitmproxy {
                    port,
                    base_dir: base_dir.to_path_buf(),
                });
            }
            ("stopped", Some(_)) => {
                warnings.push(Warning::StaleMitmproxy { port });
            }
            _ => {}
        }
        pid
    } else {
        None
    };

    // DNS proxy check (same pattern as proxy check).
    let dns_pid = if let Some(port) = status.dns_port {
        let pid = dns_procs.iter().find(|d| d.port == port).map(|d| d.pid);
        if status.mode == "running" && pid.is_none() {
            warnings.push(Warning::NoDnsmasq {
                port,
                base_dir: base_dir.to_path_buf(),
            });
        }
        pid
    } else {
        None
    };

    let (jobs, job_warnings) = correlate_jobs(&status, base_dir, fc_procs);
    warnings.extend(job_warnings);

    StatusDiagnostics {
        status,
        proxy_pid,
        dns_pid,
        jobs,
        warnings,
    }
}

// ---------------------------------------------------------------------------
// Config loading (lenient parse, safe candidate read)
// ---------------------------------------------------------------------------

async fn load_config_lenient(path: &Path) -> Option<RunnerConfig> {
    let content = crate::config::read_diagnostic_config_to_string(path)
        .await
        .ok()??;
    let mut config: RunnerConfig = serde_yaml_ng::from_str(&content).ok()?;
    if let Some(config_dir) = path.parent() {
        config.resolve_relative_paths(config_dir);
    }
    Some(config)
}

// ---------------------------------------------------------------------------
// Service type detection
// ---------------------------------------------------------------------------

/// Read `/proc/{pid}/cgroup` to find the systemd unit, then classify it.
async fn detect_service_type(pid: u32, installed: &[InstalledService]) -> ServiceType {
    let unit_name = match process::read_service_unit(pid).await {
        Some(name) if name.starts_with("vm0-runner-") => name,
        _ => return ServiceType::Bare,
    };

    // Check if the unit file exists on disk (installed vs transient)
    let unit_path = format!("/etc/systemd/system/{unit_name}.service");
    if tokio::fs::try_exists(&unit_path).await.unwrap_or(false)
        || installed.iter().any(|s| s.unit_name == unit_name)
    {
        ServiceType::Installed(unit_name)
    } else {
        ServiceType::Transient(unit_name)
    }
}

// ---------------------------------------------------------------------------
// Installed service discovery
// ---------------------------------------------------------------------------

/// Scan `vm0-runner-*.service` unit files for installed services.
async fn find_installed_services(system_dir: &Path) -> Vec<InstalledService> {
    let mut units = Vec::new();
    let mut entries = match tokio::fs::read_dir(system_dir).await {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!(
                "find_installed_services: cannot read {}: {e}",
                system_dir.display()
            );
            return Vec::new();
        }
    };
    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(e) => {
                tracing::warn!(
                    "find_installed_services: read entry in {}: {e}",
                    system_dir.display()
                );
                break;
            }
        };
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        let Some(unit) = super::service::RunnerServiceUnit::from_file_name(name_str) else {
            continue;
        };
        units.push(unit);
    }

    collect_doctor_io(units.into_iter().map(|unit| async move {
        let config_path = match super::service::read_unit_config_path(&unit).await {
            Ok(config_path) => config_path,
            Err(e) => {
                tracing::warn!(
                    "find_installed_services: cannot read effective config for {}: {e}",
                    unit.service_name()
                );
                None
            }
        };
        InstalledService {
            unit_name: unit.unit_name().to_string(),
            config_path,
        }
    }))
    .await
}

/// Find installed services that have no matching running runner.
fn find_stopped_services(
    installed: &[InstalledService],
    reports: &[RunnerReport],
) -> Vec<StoppedInfo> {
    installed
        .iter()
        .filter(|svc| {
            !reports.iter().any(|r| match &r.service_type {
                ServiceType::Installed(name) => name == &svc.unit_name,
                _ => false,
            })
        })
        .map(|svc| StoppedInfo {
            unit_name: svc.unit_name.clone(),
            config_info: svc
                .config_path
                .as_ref()
                .map_or("unknown config".into(), |p| p.display().to_string()),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Status reading
// ---------------------------------------------------------------------------

struct ActiveRun {
    run_id: String,
    sandbox_id: String,
    phase: String,
    phase_started_at: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ActiveRunPhase {
    Preparing,
    Running,
}

impl ActiveRun {
    fn phase(&self) -> ActiveRunPhase {
        match self.phase.as_str() {
            "preparing" => ActiveRunPhase::Preparing,
            _ => ActiveRunPhase::Running,
        }
    }
}

struct IdleSandbox {
    reuse_key: String,
    sandbox_id: String,
}

struct BlankSandbox {
    sandbox_id: String,
}

/// Returns `true` for modes where proxy absence is expected (not a warning).
fn is_inactive_mode(mode: &str) -> bool {
    matches!(mode, "stopped" | "draining")
}

async fn read_status(base_dir: &Path) -> Option<StatusInfo> {
    let file = status_file::read_as::<StatusForDoctor>(base_dir)
        .await
        .ok()
        .flatten()?;
    let blank_ids: HashSet<&str> = file
        .blank_sandboxes
        .iter()
        .map(|sandbox| sandbox.sandbox_id.as_str())
        .collect();
    let idle_sandboxes = file
        .idle_sandboxes()
        .iter()
        .filter(|sandbox| !blank_ids.contains(sandbox.sandbox_id.as_str()))
        .map(|sandbox| IdleSandbox {
            reuse_key: sandbox.reuse_key.clone(),
            sandbox_id: sandbox.sandbox_id.clone(),
        })
        .collect();
    let active_ids: HashSet<&str> = file
        .active_runs
        .iter()
        .map(|run| run.sandbox_id.as_str())
        .collect();
    let mut blank_sandboxes: Vec<BlankSandbox> = blank_ids
        .into_iter()
        .filter(|sandbox_id| !active_ids.contains(sandbox_id))
        .map(|sandbox_id| BlankSandbox {
            sandbox_id: sandbox_id.to_owned(),
        })
        .collect();
    blank_sandboxes.sort_by(|a, b| a.sandbox_id.cmp(&b.sandbox_id));
    let active_runs = file
        .active_runs
        .into_iter()
        .map(|run| ActiveRun {
            run_id: run.run_id,
            sandbox_id: run.sandbox_id,
            phase: run.phase,
            phase_started_at: run.phase_started_at,
        })
        .collect();
    Some(StatusInfo {
        mode: file.mode,
        started_at: file.started_at,
        active_runs,
        idle_sandboxes,
        blank_sandboxes,
        proxy_port: file.proxy_port,
        dns_port: file.dns_port,
    })
}

// ---------------------------------------------------------------------------
// API connectivity check
// ---------------------------------------------------------------------------

/// Returns `true` if the URL's host TLD is `.test` (RFC 2606).
fn is_test_tld(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    parsed
        .host_str()
        .is_some_and(|h| h.ends_with(".test") || h == "test")
}

/// Returns `None` if no server configured or URL uses `.test` TLD (RFC 2606),
/// `Some(true)` if reachable, `Some(false)` if unreachable.
async fn check_api(client: Option<&Client>, config: &RunnerConfig) -> Option<bool> {
    let server = config.server.as_ref()?;
    // Skip connectivity check for .test domains (reserved per RFC 2606, used in CI)
    if is_test_tld(&server.url) {
        return None;
    }
    Some(probe_api(client?, &server.url, &server.token).await)
}

fn build_api_client() -> Option<Client> {
    Client::builder().timeout(API_CHECK_TIMEOUT).build().ok()
}

async fn probe_api(client: &Client, server_url: &str, server_token: &str) -> bool {
    client
        .head(server_url)
        .bearer_auth(server_token)
        .send()
        .await
        .is_ok()
}

// ---------------------------------------------------------------------------
// Job correlation
// ---------------------------------------------------------------------------

fn preparing_run_is_stale(active: &ActiveRun, now: DateTime<Utc>) -> bool {
    let Ok(started_at) = DateTime::parse_from_rfc3339(&active.phase_started_at) else {
        return true;
    };
    let elapsed = now.signed_duration_since(started_at.with_timezone(&Utc));
    match elapsed.to_std() {
        Ok(elapsed) => elapsed >= PREPARING_NO_PROCESS_GRACE,
        Err(_) => false,
    }
}

fn active_run_is_stale_preparing(active: &ActiveRun, now: DateTime<Utc>) -> bool {
    active.phase() == ActiveRunPhase::Preparing && preparing_run_is_stale(active, now)
}

fn correlate_jobs(
    status: &StatusInfo,
    base_dir: &Path,
    fc_procs: &[process::FirecrackerProcessInfo],
) -> (Vec<JobReport>, Vec<Warning>) {
    let mut jobs = Vec::new();
    let mut warnings = Vec::new();

    // Firecracker processes belonging to this runner
    let my_fcs: Vec<&process::FirecrackerProcessInfo> = fc_procs
        .iter()
        .filter(|p| p.base_dir.as_deref() == Some(base_dir))
        .collect();

    // For each active run, find the FC hosting its sandbox_id.
    let now = Utc::now();
    for active in &status.active_runs {
        let fc = my_fcs.iter().find(|p| p.sandbox_id == active.sandbox_id);
        let status_variant = match active.phase() {
            ActiveRunPhase::Running => match fc {
                Some(p) => JobStatus::Running {
                    run_id: active.run_id.clone(),
                    pid: p.pid,
                },
                None => {
                    warnings.push(Warning::NoFirecrackerForRun {
                        run_id: active.run_id.clone(),
                        sandbox_id: active.sandbox_id.clone(),
                        base_dir: base_dir.to_path_buf(),
                    });
                    JobStatus::NoProcess {
                        run_id: active.run_id.clone(),
                    }
                }
            },
            ActiveRunPhase::Preparing => {
                if preparing_run_is_stale(active, now) {
                    warnings.push(Warning::StalePreparingRun {
                        run_id: active.run_id.clone(),
                        sandbox_id: active.sandbox_id.clone(),
                        base_dir: base_dir.to_path_buf(),
                    });
                }
                match fc {
                    Some(p) => JobStatus::Preparing {
                        run_id: active.run_id.clone(),
                        pid: Some(p.pid),
                    },
                    None => JobStatus::Preparing {
                        run_id: active.run_id.clone(),
                        pid: None,
                    },
                }
            }
        };
        jobs.push(JobReport {
            status: status_variant,
        });
    }

    // Known sandboxes = active + exact idle + blank. FCs outside this set
    // are flagged as orphans not reflected in status.json.
    for fc in &my_fcs {
        let known = status
            .active_runs
            .iter()
            .any(|r| r.sandbox_id == fc.sandbox_id)
            || status
                .idle_sandboxes
                .iter()
                .any(|v| v.sandbox_id == fc.sandbox_id)
            || status
                .blank_sandboxes
                .iter()
                .any(|v| v.sandbox_id == fc.sandbox_id);
        if !known {
            warnings.push(Warning::FirecrackerNotInStatus {
                pid: fc.pid,
                sandbox_id: fc.sandbox_id.clone(),
                base_dir: base_dir.to_path_buf(),
                generation: fc.generation,
            });
            jobs.push(JobReport {
                status: JobStatus::NotInStatus {
                    sandbox_id: fc.sandbox_id.clone(),
                },
            });
        }
    }

    (jobs, warnings)
}

// ---------------------------------------------------------------------------
// Global orphan detection
// ---------------------------------------------------------------------------

async fn detect_global_orphans(
    reports: &[RunnerReport],
    fc_procs: &[process::FirecrackerProcessInfo],
    mitm_procs: &[process::MitmproxyProcessInfo],
) -> Vec<Warning> {
    let mut warnings = Vec::new();

    let runner_pids: Vec<u32> = reports.iter().map(|r| r.live_runner.pid).collect();

    // Orphan firecracker processes (all runners)
    warnings.extend(detect_orphan_firecrackers(fc_procs, &runner_pids, None).await);

    warnings.extend(detect_orphan_mitmdumps(reports, mitm_procs, &runner_pids).await);

    // Orphan network namespaces
    warnings.extend(detect_orphan_namespaces().await);

    // Orphan NBD devices
    warnings.extend(detect_nbd_orphans().await);

    warnings
}

async fn detect_orphan_mitmdumps(
    reports: &[RunnerReport],
    mitm_procs: &[process::MitmproxyProcessInfo],
    runner_pids: &[u32],
) -> Vec<Warning> {
    let mut warnings = Vec::new();
    // Orphan mitmproxy processes.
    // A mitmdump belongs to a runner if its port matches the runner's proxy
    // port (from status.json). All processes on that port — main process and
    // worker forks — are considered owned.
    let claimed_ports: Vec<u16> = reports
        .iter()
        .filter_map(|r| r.status.as_ref()?.proxy_port)
        .collect();
    for mitm in mitm_procs {
        if claimed_ports.contains(&mitm.port) {
            continue;
        }
        if process::is_orphan(mitm.pid, runner_pids).await {
            warnings.push(Warning::OrphanMitmdump {
                pid: mitm.pid,
                port: mitm.port,
                ppid: mitm.ppid,
                generation: mitm.generation,
            });
        }
    }

    warnings
}

/// Detect orphan firecracker processes whose ppid chain doesn't lead to any runner.
///
/// When `base_dir_filter` is `Some`, only reports processes whose working
/// directory is under the specified base_dir (for `--name` scoping).
async fn detect_orphan_firecrackers(
    fc_procs: &[process::FirecrackerProcessInfo],
    runner_pids: &[u32],
    base_dir_filter: Option<&Path>,
) -> Vec<Warning> {
    let mut warnings = Vec::new();
    for fc in fc_procs {
        if let Some(filter) = base_dir_filter
            && fc.base_dir.as_deref() != Some(filter)
        {
            continue;
        }
        if process::is_orphan(fc.pid, runner_pids).await {
            warnings.push(Warning::OrphanFirecracker {
                pid: fc.pid,
                sandbox_id: fc.sandbox_id.clone(),
                base_dir: fc.base_dir.clone(),
                ppid: fc.ppid,
                generation: fc.generation,
            });
        }
    }
    warnings
}

/// List `vm0-ns-*` namespaces and check if their pool locks are held.
async fn detect_orphan_namespaces() -> Vec<Warning> {
    let mut warnings = Vec::new();

    let Some(namespaces) = observe_network_namespaces().await else {
        return warnings;
    };
    let lock_paths = sandbox_firecracker::LockPaths::new();

    for namespace in namespaces {
        let lock_path = lock_paths.netns_pool(namespace.pool_idx);
        if is_lock_free(&lock_path).await {
            warnings.push(Warning::OrphanNamespace {
                ns_name: namespace.ns_name,
                lock_path,
            });
        }
    }

    warnings
}

async fn observe_network_namespaces() -> Option<Vec<ObservedNetworkNamespace>> {
    let output = tokio::process::Command::new("ip")
        .args(["netns", "list"])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }

    Some(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                parse_netns_list_line(line).map(|(ns_name, pool_idx)| ObservedNetworkNamespace {
                    ns_name: ns_name.to_string(),
                    pool_idx,
                })
            })
            .collect(),
    )
}

/// Parse `ip netns list` output line and return the namespace plus pool index.
fn parse_netns_list_line(line: &str) -> Option<(&str, u32)> {
    // ip netns list output: "vm0-ns-00-0a (id: 42)" or just "vm0-ns-00-0a"
    let ns_name = line.split_whitespace().next()?;
    let parsed = sandbox_firecracker::parse_netns_name(ns_name)?;
    Some((ns_name, parsed.pool_index))
}

/// Scan for lock-free NBD devices whose recorded owner task has exited.
async fn detect_nbd_orphans() -> Vec<Warning> {
    let orphans = match tokio::task::spawn_blocking(super::nbd::find_nbd_orphans).await {
        Ok(result) => result,
        Err(e) => {
            tracing::warn!("NBD orphan scan task failed: {e}");
            return vec![Warning::NbdScanFailed];
        }
    };

    orphans
        .into_iter()
        .map(|candidate| Warning::OrphanNbdDevice { candidate })
        .collect()
}

/// Try non-blocking flock to check if a lock file is free (not held by anyone).
async fn is_lock_free(lock_path: &Path) -> bool {
    let lock_path = lock_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        use std::fs::File;
        let file = match File::open(&lock_path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return true,
            Err(e) => {
                tracing::warn!(
                    "cannot open lock file {}: {e}, assuming held",
                    lock_path.display()
                );
                return false;
            }
        };
        // Try exclusive lock without blocking
        match nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock) {
            Ok(_lock) => true, // lock acquired → was free → orphaned
            Err(_) => false,   // lock held → pool is active
        }
    })
    .await
    .unwrap_or(false) // if task panics, assume lock is held (don't false-positive)
}

// ---------------------------------------------------------------------------
// Pretty-print output
// ---------------------------------------------------------------------------

fn print_report(
    reports: &[RunnerReport],
    stopped: &[StoppedInfo],
    global_warnings: &[Warning],
) -> ExitCode {
    let running = reports.len();
    let stopped_count = stopped.len();
    println!("Runners ({running} running, {stopped_count} stopped):\n");

    for (i, r) in reports.iter().enumerate() {
        println!(
            "[{}] {} (PID {}) [{}]",
            i + 1,
            r.live_runner.config_path.display(),
            r.live_runner.pid,
            r.live_runner.subcommand,
        );

        // Service type
        match &r.service_type {
            ServiceType::Installed(name) => println!("    Service: {name} (installed)"),
            ServiceType::Transient(name) => println!("    Service: {name} (transient)"),
            ServiceType::Bare => println!("    Service: none (bare process)"),
        }

        // Mode + uptime
        if let Some(st) = &r.status {
            let uptime = format_uptime(&st.started_at);
            println!("    Mode:    {} ({uptime})", st.mode);
        }

        // API
        match r.api_ok {
            Some(true) => println!("    API:     ok"),
            Some(false) => println!("    API:     UNREACHABLE"),
            None => println!("    API:     not configured"),
        }

        // Proxy
        match (r.proxy_pid, r.status.as_ref().and_then(|st| st.proxy_port)) {
            (Some(pid), Some(port)) => println!("    Proxy:   PID {pid} (port {port})"),
            (Some(pid), None) => println!("    Proxy:   PID {pid}"),
            (None, Some(port)) => println!("    Proxy:   NOT FOUND (port {port})"),
            (None, None) => println!("    Proxy:   unknown"),
        }

        // DNS proxy
        match (r.dns_pid, r.status.as_ref().and_then(|st| st.dns_port)) {
            (Some(pid), Some(port)) => println!("    DNS:     PID {pid} (port {port})"),
            (Some(pid), None) => println!("    DNS:     PID {pid}"),
            (None, Some(port)) => println!("    DNS:     NOT FOUND (port {port})"),
            (None, None) => {}
        }

        // Jobs
        if !r.jobs.is_empty() {
            let active_count = r
                .jobs
                .iter()
                .filter(|j| {
                    matches!(
                        j.status,
                        JobStatus::Running { .. }
                            | JobStatus::Preparing { .. }
                            | JobStatus::NoProcess { .. }
                    )
                })
                .count();
            println!("    Jobs:    {active_count} active");
            for job in &r.jobs {
                match &job.status {
                    JobStatus::Running { run_id, pid } => {
                        println!("      - run {run_id} -> PID {pid}");
                    }
                    JobStatus::Preparing { run_id, pid } => {
                        if let Some(pid) = pid {
                            println!("      - run {run_id} -> PREPARING (PID {pid})");
                        } else {
                            println!("      - run {run_id} -> PREPARING");
                        }
                    }
                    JobStatus::NoProcess { run_id } => {
                        println!("      - run {run_id} -> NO PROCESS");
                    }
                    JobStatus::NotInStatus { sandbox_id } => {
                        println!("      - sandbox {sandbox_id} -> not in status.json");
                    }
                }
            }
        } else if r.status.is_some() {
            println!("    Jobs:    0 active");
        }

        if let Some(st) = &r.status {
            print!("{}", format_parked_sandbox_diagnostics(st));
        }

        // Per-runner warnings
        if !r.warnings.is_empty() {
            for w in &r.warnings {
                println!("    WARNING: {w}");
            }
        }
        println!();
    }

    // Stopped services
    if !stopped.is_empty() {
        println!("Stopped services:");
        for svc in stopped {
            println!("  {} ({}) -- not running", svc.unit_name, svc.config_info);
        }
        println!();
    }

    // Global warnings (orphans only — per-runner warnings printed above)
    if !global_warnings.is_empty() {
        println!("Warnings:");
        for w in global_warnings {
            println!("  ! {w}");
        }
        println!();
    }

    let total_warnings: usize =
        reports.iter().map(|r| r.warnings.len()).sum::<usize>() + global_warnings.len();
    println!("{total_warnings} warning(s) found");
    if total_warnings > 0 {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn format_idle_sandbox_diagnostic_line(sandbox: &IdleSandbox) -> String {
    format!(
        "      - reuse key {} -> sandbox {}",
        sandbox.reuse_key, sandbox.sandbox_id
    )
}

fn format_parked_sandbox_diagnostics(status: &StatusInfo) -> String {
    let mut output = String::new();
    if !status.idle_sandboxes.is_empty() {
        let _ = writeln!(
            output,
            "    Idle:    {} exact sandboxes",
            status.idle_sandboxes.len()
        );
        for sandbox in &status.idle_sandboxes {
            let _ = writeln!(output, "{}", format_idle_sandbox_diagnostic_line(sandbox));
        }
    }
    if !status.blank_sandboxes.is_empty() {
        let _ = writeln!(
            output,
            "    Blank:   {} sandboxes",
            status.blank_sandboxes.len()
        );
        for sandbox in &status.blank_sandboxes {
            let _ = writeln!(output, "      - sandbox {}", sandbox.sandbox_id);
        }
    }
    output
}

/// Format an ISO 8601 timestamp as a human-readable relative duration.
fn format_uptime(started_at: &str) -> String {
    let Ok(started) = chrono::DateTime::parse_from_rfc3339(started_at) else {
        return "unknown".into();
    };
    let elapsed = chrono::Utc::now().signed_duration_since(started);
    let total_mins = elapsed.num_minutes();
    if total_mins < 0 {
        return "just started".into();
    }
    let days = elapsed.num_days();
    let hours = elapsed.num_hours() % 24;
    let mins = total_mins % 60;
    let mut out = String::new();
    if days > 0 {
        let _ = write!(out, "{days}d ");
    }
    if days > 0 || hours > 0 {
        let _ = write!(out, "{hours}h ");
    }
    let _ = write!(out, "{mins}m");
    out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests;
