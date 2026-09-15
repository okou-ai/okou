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
use crate::paths::HomePaths;
use crate::process;
use crate::status_file::{self, StatusForDoctor};
use chrono::{DateTime, Utc};
use clap::Args;
use futures_util::{StreamExt, stream};
use reqwest::Client;

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
    },
    /// Runner is stopped but a mitmproxy process is still using its port.
    StaleMitmproxy { port: u16 },
    /// status.json lists a dns_port but no dnsmasq process found on it.
    NoDnsmasq { port: u16, base_dir: PathBuf },
    /// A network namespace whose pool lock is not held by any process.
    OrphanNamespace { ns_name: String, lock_path: PathBuf },
    /// An NBD device whose recorded owner task has exited and whose lock is free.
    OrphanNbdDevice { device_index: u32, pid: u32 },
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
            Self::OrphanMitmdump { pid, port, ppid } => {
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
            Self::OrphanNbdDevice { device_index, pid } => {
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
            Self::OrphanMitmdump { pid, .. } => {
                // Resolved if the process exited or a runner registry entry
                // appeared after the initial scan and now owns the process.
                pid_exists(*pid) && process::is_orphan(*pid, runner_pids).await
            }
            Self::OrphanNamespace { ns_name, lock_path } => {
                if network_namespaces.is_some_and(|namespaces| !namespaces.contains(ns_name)) {
                    return false;
                }
                is_lock_free(lock_path).await
            }
            Self::OrphanNbdDevice { device_index, pid } => {
                let idx = *device_index;
                let original_pid = *pid;
                tokio::task::spawn_blocking(move || {
                    super::nbd::nbd_orphan_is_reportable(idx, original_pid)
                })
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

/// Check if a process is still alive via `/proc/{pid}`.
fn pid_exists(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
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
    base_dir: Option<PathBuf>,
    pid: u32,
    config_path: PathBuf,
    subcommand: String,
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
        let selected_base_dir = reports.first().and_then(|r| r.base_dir.clone());
        if let Some(base_dir) = selected_base_dir {
            let runner_pids: Vec<u32> = live_runners.iter().map(|runner| runner.pid).collect();
            warnings.extend(
                detect_orphan_firecrackers(&discovered.firecrackers, &runner_pids, Some(&base_dir))
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
    let total_warnings = print_report(&reports, &stopped, &global_warnings);

    if total_warnings > 0 {
        Ok(ExitCode::FAILURE)
    } else {
        Ok(ExitCode::SUCCESS)
    }
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
        base_dir: Some(runner.base_dir.clone()),
        pid: runner.pid,
        config_path: runner.config_path.clone(),
        subcommand: runner.subcommand.clone(),
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

    let runner_pids: Vec<u32> = reports.iter().map(|r| r.pid).collect();

    // Orphan firecracker processes (all runners)
    warnings.extend(detect_orphan_firecrackers(fc_procs, &runner_pids, None).await);

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
        if process::is_orphan(mitm.pid, &runner_pids).await {
            warnings.push(Warning::OrphanMitmdump {
                pid: mitm.pid,
                port: mitm.port,
                ppid: mitm.ppid,
            });
        }
    }

    // Orphan network namespaces
    warnings.extend(detect_orphan_namespaces().await);

    // Orphan NBD devices
    warnings.extend(detect_nbd_orphans().await);

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
    let (_, orphans) = match tokio::task::spawn_blocking(super::nbd::find_nbd_orphans).await {
        Ok(result) => result,
        Err(e) => {
            tracing::warn!("NBD orphan scan task failed: {e}");
            return vec![Warning::NbdScanFailed];
        }
    };

    orphans
        .into_iter()
        .map(|(device_index, pid)| Warning::OrphanNbdDevice { device_index, pid })
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
) -> usize {
    let running = reports.len();
    let stopped_count = stopped.len();
    println!("Runners ({running} running, {stopped_count} stopped):\n");

    for (i, r) in reports.iter().enumerate() {
        println!(
            "[{}] {} (PID {}) [{}]",
            i + 1,
            r.config_path.display(),
            r.pid,
            r.subcommand,
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
    total_warnings
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
mod tests {
    use std::cell::Cell;
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use crate::test_fixtures::ignored_child::{
        ignored_child_test_env_guard_enabled, run_ignored_child_test,
    };
    use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, http_response};
    use httpmock::prelude::*;
    use tokio::sync::oneshot;

    const SERVICE_DISCOVERY_SCENARIO_ENV: &str = "OKOU_RUN_DOCTOR_DISCOVERY_SCENARIO";
    const SERVICE_DISCOVERY_SYSTEM_DIR_ENV: &str = "OKOU_RUN_DOCTOR_DISCOVERY_SYSTEM_DIR";
    const SERVICE_DISCOVERY_STATE_DIR_ENV: &str = "OKOU_RUN_DOCTOR_DISCOVERY_STATE_DIR";
    const SERVICE_DISCOVERY_INVOCATIONS_ENV: &str = "OKOU_RUN_DOCTOR_DISCOVERY_INVOCATIONS";
    const SERVICE_DISCOVERY_CHILD_TEST: &str =
        "cmd::doctor::tests::doctor_service_discovery_systemctl_child";
    const FAKE_DISCOVERY_SYSTEMCTL: &str = r#"#!/bin/sh
printf '%s\n' "$*" >> "$OKOU_RUN_DOCTOR_DISCOVERY_INVOCATIONS"

if [ "$1" != "--no-pager" ] || [ "$2" != "cat" ] || [ "$3" != "--" ]; then
  printf '%s\n' "unexpected fake systemctl invocation: $*" >&2
  exit 2
fi

unit="$4"
if [ "$OKOU_RUN_DOCTOR_DISCOVERY_SCENARIO" = "bounded" ]; then
  : > "$OKOU_RUN_DOCTOR_DISCOVERY_STATE_DIR/$unit.started"
  while [ ! -f "$OKOU_RUN_DOCTOR_DISCOVERY_STATE_DIR/$unit.release" ]; do :; done
fi

if [ "$unit" = "vm0-runner-failure.service" ]; then
  printf '%s\n' 'cannot read selected unit content' >&2
  exit 1
fi

suffix=${unit#vm0-runner-}
suffix=${suffix%.service}
printf '%s\n' \
  '[Service]' \
  "ExecStart=/usr/bin/runner start --config /configs/$suffix.yaml"
"#;

    #[tokio::test]
    async fn doctor_io_refills_slots_with_a_fixed_bound_and_preserves_order() {
        let count = DOCTOR_IO_CONCURRENCY + 2;
        let (mut releases, gates): (Vec<_>, Vec<_>) =
            (0..count).map(|_| oneshot::channel::<()>()).unzip();
        let started = Cell::new(0);
        let active = Cell::new(0);
        let operations = gates.into_iter().enumerate().map(|(index, gate)| {
            let started = &started;
            let active = &active;
            async move {
                started.set(started.get() + 1);
                active.set(active.get() + 1);
                assert!(active.get() <= DOCTOR_IO_CONCURRENCY);
                gate.await.unwrap();
                active.set(active.get() - 1);
                index
            }
        });
        let results = collect_doctor_io(operations);
        tokio::pin!(results);

        assert!(futures_util::poll!(&mut results).is_pending());
        assert_eq!(started.get(), DOCTOR_IO_CONCURRENCY);
        assert_eq!(active.get(), DOCTOR_IO_CONCURRENCY);

        // Keep the first operation blocked while later completions refill both slots.
        for expected_started in (DOCTOR_IO_CONCURRENCY + 1)..=count {
            releases.remove(1).send(()).unwrap();
            assert!(futures_util::poll!(&mut results).is_pending());
            assert_eq!(started.get(), expected_started);
            assert_eq!(active.get(), DOCTOR_IO_CONCURRENCY);
        }

        for release in releases.into_iter().rev() {
            release.send(()).unwrap();
        }
        assert_eq!(results.await, (0..count).collect::<Vec<_>>());
        assert_eq!(active.get(), 0);
    }

    async fn gated_doctor_apis() -> Vec<(RawHttpTestServer, oneshot::Sender<()>)> {
        let mut apis = Vec::new();
        for index in 0..=DOCTOR_IO_CONCURRENCY {
            let (release, gate) = oneshot::channel();
            // Any HTTP response, including a server error, proves connectivity.
            let status = if index == 0 {
                "503 Unavailable"
            } else {
                "200 OK"
            };
            let server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitThenRespond {
                release: gate,
                response: http_response(status, b""),
            }])
            .await;
            apis.push((server, release));
        }
        apis
    }

    async fn release_doctor_apis(mut apis: Vec<(RawHttpTestServer, oneshot::Sender<()>)>) {
        for (index, (server, _)) in apis.iter_mut().take(DOCTOR_IO_CONCURRENCY).enumerate() {
            let request = server.next_request("initial doctor API probe").await;
            assert!(request.starts_with("HEAD / HTTP/1.1\r\n"));
            assert!(request.contains(&format!("authorization: Bearer token-{index}\r\n")));
        }

        let (server, release) = apis.remove(1);
        release.send(()).unwrap();
        server.assert_finished().await;

        // The first response is still gated: ordered buffering cannot reach this request.
        let request = apis
            .last_mut()
            .unwrap()
            .0
            .next_request("queued doctor API probe while the first response is blocked")
            .await;
        assert!(request.starts_with("HEAD / HTTP/1.1\r\n"));
        assert!(request.contains(&format!(
            "authorization: Bearer token-{DOCTOR_IO_CONCURRENCY}\r\n"
        )));

        for (server, release) in apis {
            release.send(()).unwrap();
            server.assert_finished().await;
        }
    }

    #[test]
    fn format_uptime_minutes() {
        let now = chrono::Utc::now();
        let started = now - chrono::Duration::minutes(42);
        let s = started.to_rfc3339();
        assert_eq!(format_uptime(&s), "42m");
    }

    #[test]
    fn format_uptime_hours_and_minutes() {
        let now = chrono::Utc::now();
        let started = now - chrono::Duration::hours(3) - chrono::Duration::minutes(15);
        let s = started.to_rfc3339();
        assert_eq!(format_uptime(&s), "3h 15m");
    }

    #[test]
    fn format_uptime_days() {
        let now = chrono::Utc::now();
        let started = now - chrono::Duration::days(2) - chrono::Duration::hours(5);
        let s = started.to_rfc3339();
        assert_eq!(format_uptime(&s), "2d 5h 0m");
    }

    #[test]
    fn format_uptime_invalid_timestamp() {
        assert_eq!(format_uptime("not-a-date"), "unknown");
    }

    #[test]
    fn parse_netns_list_line_valid() {
        assert_eq!(
            parse_netns_list_line("vm0-ns-00-0a (id: 42)"),
            Some(("vm0-ns-00-0a", 0))
        );
        assert_eq!(
            parse_netns_list_line("vm0-ns-3f-ff"),
            Some(("vm0-ns-3f-ff", 63))
        );
    }

    #[test]
    fn parse_netns_list_line_ignores_malformed_names() {
        assert_eq!(parse_netns_list_line(""), None);
        assert_eq!(parse_netns_list_line("   "), None);
        assert_eq!(parse_netns_list_line("not-a-ns"), None);
        assert_eq!(parse_netns_list_line("vm0-ns-"), None);
        assert_eq!(parse_netns_list_line("vm0-ns-00"), None);
        assert_eq!(parse_netns_list_line("vm0-ns-00-extra"), None);
        assert_eq!(parse_netns_list_line("vm0-ns-00-zz"), None);
        assert_eq!(parse_netns_list_line("vm0-ns-00-0a-extra"), None);
        assert_eq!(parse_netns_list_line("vm0-ns-0A-00"), None);
        assert_eq!(parse_netns_list_line("vm0-ns-00-0A"), None);
        assert_eq!(parse_netns_list_line("vm0-ns-40-00"), None);
        assert_eq!(parse_netns_list_line("vm0-ns-ff-00"), None);
    }

    #[tokio::test]
    async fn read_status_defaults_missing_collections_to_empty() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("status.json"),
            r#"{"mode":"running","started_at":"2026-01-01T00:00:00.000Z"}"#,
        )
        .unwrap();

        let status = read_status(dir.path()).await.unwrap();

        assert!(status.active_runs.is_empty());
        assert!(status.idle_sandboxes.is_empty());
        assert!(status.blank_sandboxes.is_empty());
    }

    #[tokio::test]
    async fn read_status_missing_active_run_identifier_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("status.json"),
            r#"{
                "mode":"running",
                "started_at":"2026-01-01T00:00:00.000Z",
                "active_runs":[{
                    "run_id":"R1",
                    "phase":"running",
                    "phase_started_at":"2026-01-01T00:00:00.000Z"
                }]
            }"#,
        )
        .unwrap();

        assert!(read_status(dir.path()).await.is_none());
    }

    #[tokio::test]
    async fn read_status_missing_active_run_lifecycle_field_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let cases = [
            (
                "phase",
                r#"{
                    "mode":"running",
                    "started_at":"2026-01-01T00:00:00.000Z",
                    "active_runs":[{
                        "run_id":"R1",
                        "sandbox_id":"S1",
                        "phase_started_at":"2026-01-01T00:00:00.000Z"
                    }]
                }"#,
            ),
            (
                "phase_started_at",
                r#"{
                    "mode":"running",
                    "started_at":"2026-01-01T00:00:00.000Z",
                    "active_runs":[{
                        "run_id":"R1",
                        "sandbox_id":"S1",
                        "phase":"running"
                    }]
                }"#,
            ),
        ];

        for (field, content) in cases {
            std::fs::write(dir.path().join("status.json"), content).unwrap();

            assert!(
                read_status(dir.path()).await.is_none(),
                "status missing {field} must be rejected"
            );
        }
    }

    #[tokio::test]
    async fn read_status_missing_idle_sandbox_identifier_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("status.json"),
            r#"{
                "mode":"running",
                "started_at":"2026-01-01T00:00:00.000Z",
                "idle_sandboxes":[{"reuse_key":"session-a"}]
            }"#,
        )
        .unwrap();

        assert!(read_status(dir.path()).await.is_none());
    }

    #[tokio::test]
    async fn read_status_rejects_malformed_blank_sandboxes() {
        let dir = tempfile::tempdir().unwrap();
        for blank_sandboxes in [
            serde_json::json!(null),
            serde_json::json!({}),
            serde_json::json!([null]),
            serde_json::json!([{}]),
            serde_json::json!([{"sandbox_id": 1}]),
        ] {
            let content = serde_json::json!({
                "mode": "running",
                "started_at": "2026-01-01T00:00:00.000Z",
                "blank_sandboxes": blank_sandboxes,
            });
            std::fs::write(dir.path().join("status.json"), content.to_string()).unwrap();
            assert!(read_status(dir.path()).await.is_none(), "{content}");
        }
    }

    #[tokio::test]
    async fn read_status_preserves_exact_inventory_without_blank_collection() {
        let dir = tempfile::tempdir().unwrap();
        let content = serde_json::json!({
            "mode": "running",
            "started_at": "2026-01-01T00:00:00.000Z",
            "idle_sandboxes": [
                {"sandbox_id": "S1", "reuse_key": "thread:exact"},
            ],
        });
        std::fs::write(dir.path().join("status.json"), content.to_string()).unwrap();
        let status = read_status(dir.path()).await.unwrap();
        assert_eq!(status.idle_sandboxes.len(), 1);
        assert_eq!(status.idle_sandboxes[0].sandbox_id, "S1");
        assert_eq!(status.idle_sandboxes[0].reuse_key, "thread:exact");
        assert!(status.blank_sandboxes.is_empty());
    }

    #[tokio::test]
    async fn read_status_claimed_blank_is_only_an_active_job() {
        let dir = tempfile::tempdir().unwrap();
        let content = serde_json::json!({
            "mode": "running",
            "started_at": "2026-01-01T00:00:00.000Z",
            "active_runs": [{
                "run_id": "R1", "sandbox_id": "S1", "phase": "running",
                "phase_started_at": "2026-01-01T00:00:00.000Z",
            }],
            "idle_sandboxes": [{"sandbox_id": "S1", "reuse_key": "overlapping-mirror"}],
            "blank_sandboxes": [{"sandbox_id": "S1"}],
        });
        std::fs::write(dir.path().join("status.json"), content.to_string()).unwrap();
        let status = read_status(dir.path()).await.unwrap();
        let (jobs, warnings) =
            correlate_jobs(&status, dir.path(), &[fc_info(101, "S1", dir.path())]);
        assert!(status.idle_sandboxes.is_empty());
        assert!(status.blank_sandboxes.is_empty());
        assert!(warnings.is_empty());
        assert_eq!(jobs.len(), 1);
        assert!(matches!(&jobs[0].status, JobStatus::Running { run_id, .. } if run_id == "R1"));
    }

    #[test]
    fn active_run_unknown_phase_defaults_running() {
        let active = ActiveRun {
            run_id: "R1".into(),
            sandbox_id: "S1".into(),
            phase: "future-phase".into(),
            phase_started_at: "2026-01-01T00:00:00.000Z".into(),
        };

        assert_eq!(active.phase(), ActiveRunPhase::Running);
    }

    fn running_active_run(run_id: &str, sandbox_id: &str) -> ActiveRun {
        ActiveRun {
            run_id: run_id.into(),
            sandbox_id: sandbox_id.into(),
            phase: "running".into(),
            phase_started_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    fn phased_active_run(
        run_id: &str,
        sandbox_id: &str,
        phase: &str,
        phase_started_at: String,
    ) -> ActiveRun {
        ActiveRun {
            run_id: run_id.into(),
            sandbox_id: sandbox_id.into(),
            phase: phase.into(),
            phase_started_at,
        }
    }

    fn phase_started_at_ago(age: Duration) -> String {
        let age = chrono::Duration::from_std(age).unwrap();
        (Utc::now() - age)
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string()
    }

    fn status_info(active: Vec<(&str, &str)>, idle_sandboxes: Vec<&str>) -> StatusInfo {
        status_info_with_active_runs(
            active
                .into_iter()
                .map(|(run_id, sandbox_id)| running_active_run(run_id, sandbox_id))
                .collect(),
            idle_sandboxes,
        )
    }

    fn status_info_with_active_runs(
        active_runs: Vec<ActiveRun>,
        idle_sandboxes: Vec<&str>,
    ) -> StatusInfo {
        StatusInfo {
            mode: "running".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
            active_runs,
            // Tests only need sandbox_id lookup for idle sandboxes; synthesize a
            // placeholder reuse key.
            idle_sandboxes: idle_sandboxes
                .into_iter()
                .enumerate()
                .map(|(i, sbid)| IdleSandbox {
                    reuse_key: format!("thread:test-{i}"),
                    sandbox_id: sbid.into(),
                })
                .collect(),
            blank_sandboxes: vec![],
            proxy_port: None,
            dns_port: None,
        }
    }

    fn fc_info(pid: u32, sandbox_id: &str, base_dir: &Path) -> process::FirecrackerProcessInfo {
        process::FirecrackerProcessInfo {
            pid,
            ppid: None,
            sandbox_id: sandbox_id.to_string(),
            base_dir: Some(base_dir.to_path_buf()),
            generation: Some(process::ProcfsProcessGeneration {
                pgid: pid,
                starttime: u64::from(pid),
            }),
        }
    }

    #[test]
    fn correlate_jobs_matching() {
        // sandbox_id == run_id (first-job case: doctor still joins correctly).
        let status = status_info(vec![("abc", "abc"), ("def", "def")], vec![]);
        let fc = vec![
            fc_info(100, "abc", Path::new("/data/r1")),
            fc_info(101, "def", Path::new("/data/r1")),
        ];
        let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);
        assert_eq!(jobs.len(), 2);
        assert!(warnings.is_empty());
        assert!(matches!(
            jobs.first().unwrap().status,
            JobStatus::Running { pid: 100, .. }
        ));
    }

    #[test]
    fn correlate_active_reused_no_warning() {
        // Sandbox was reused: FC's sandbox_id differs from the active run_id
        // but matches via the status mapping — should emit zero warnings.
        let status = status_info(vec![("run-new", "sandbox-orig")], vec![]);
        let fc = vec![fc_info(200, "sandbox-orig", Path::new("/data/r1"))];
        let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);
        assert_eq!(jobs.len(), 1);
        assert!(warnings.is_empty(), "reused sandbox must not warn");
        let JobStatus::Running { run_id, pid } = &jobs.first().unwrap().status else {
            panic!("expected Running");
        };
        assert_eq!(
            run_id, "run-new",
            "Running should carry the run_id, not sandbox_id"
        );
        assert_eq!(*pid, 200);
    }

    #[test]
    fn correlate_idle_sandbox_no_warning() {
        // Parked idle sandbox: no active run, sandbox_id listed in idle_sandboxes.
        // This is the exact prod-3 v0.79.12 scenario that used to
        // false-positive with 2 `FirecrackerNotInStatus` warnings.
        let status = status_info(vec![], vec!["sandbox-idle"]);
        let fc = vec![fc_info(300, "sandbox-idle", Path::new("/data/r1"))];
        let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);
        assert!(jobs.is_empty(), "idle FC should not surface as a job");
        assert!(warnings.is_empty(), "idle FC must not warn");
    }

    #[test]
    fn correlate_active_no_fc_warns() {
        // Active run with no matching FC process.
        let status = status_info(vec![("run-x", "sandbox-x")], vec![]);
        let fc: Vec<process::FirecrackerProcessInfo> = vec![];
        let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);
        assert_eq!(jobs.len(), 1);
        assert!(matches!(
            jobs.first().unwrap().status,
            JobStatus::NoProcess { .. }
        ));
        assert_eq!(warnings.len(), 1);
        let msg = warnings[0].to_string();
        assert!(msg.contains("no firecracker"), "{msg}");
        assert!(msg.contains("run-x"), "{msg}");
        assert!(msg.contains("sandbox-x"), "{msg}");
    }

    #[test]
    fn correlate_preparing_active_without_fc_within_grace_does_not_warn() {
        let status = status_info_with_active_runs(
            vec![phased_active_run(
                "run-prep",
                "sandbox-prep",
                "preparing",
                phase_started_at_ago(Duration::from_secs(5)),
            )],
            vec![],
        );
        let fc: Vec<process::FirecrackerProcessInfo> = vec![];

        let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);

        assert_eq!(jobs.len(), 1);
        assert!(warnings.is_empty());
        assert!(matches!(
            jobs.first().unwrap().status,
            JobStatus::Preparing { .. }
        ));
    }

    #[test]
    fn correlate_preparing_active_without_fc_beyond_grace_warns() {
        let status = status_info_with_active_runs(
            vec![phased_active_run(
                "run-stale",
                "sandbox-stale",
                "preparing",
                phase_started_at_ago(PREPARING_NO_PROCESS_GRACE + Duration::from_secs(1)),
            )],
            vec![],
        );
        let fc: Vec<process::FirecrackerProcessInfo> = vec![];

        let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);

        assert_eq!(jobs.len(), 1);
        assert!(matches!(
            jobs.first().unwrap().status,
            JobStatus::Preparing { pid: None, .. }
        ));
        assert_eq!(warnings.len(), 1);
        let msg = warnings[0].to_string();
        assert!(msg.contains("stuck preparing"), "{msg}");
        assert!(msg.contains("run-stale"), "{msg}");
        assert!(msg.contains("sandbox-stale"), "{msg}");
    }

    #[test]
    fn correlate_preparing_active_with_fc_within_grace_stays_preparing() {
        let status = status_info_with_active_runs(
            vec![phased_active_run(
                "run-prep",
                "sandbox-prep",
                "preparing",
                phase_started_at_ago(Duration::from_secs(5)),
            )],
            vec![],
        );
        let fc = vec![fc_info(123, "sandbox-prep", Path::new("/data/r1"))];

        let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);

        assert_eq!(jobs.len(), 1);
        assert!(warnings.is_empty());
        let JobStatus::Preparing { run_id, pid } = &jobs.first().unwrap().status else {
            panic!("expected preparing job");
        };
        assert_eq!(run_id, "run-prep");
        assert_eq!(*pid, Some(123));
    }

    #[test]
    fn correlate_preparing_active_with_fc_beyond_grace_warns() {
        let status = status_info_with_active_runs(
            vec![phased_active_run(
                "run-stale-with-fc",
                "sandbox-stale-with-fc",
                "preparing",
                phase_started_at_ago(PREPARING_NO_PROCESS_GRACE + Duration::from_secs(1)),
            )],
            vec![],
        );
        let fc = vec![fc_info(456, "sandbox-stale-with-fc", Path::new("/data/r1"))];

        let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);

        assert_eq!(jobs.len(), 1);
        let JobStatus::Preparing { run_id, pid } = &jobs.first().unwrap().status else {
            panic!("expected preparing job");
        };
        assert_eq!(run_id, "run-stale-with-fc");
        assert_eq!(*pid, Some(456));
        assert_eq!(warnings.len(), 1);
        let msg = warnings[0].to_string();
        assert!(msg.contains("stuck preparing"), "{msg}");
        assert!(msg.contains("run-stale-with-fc"), "{msg}");
        assert!(msg.contains("sandbox-stale-with-fc"), "{msg}");
    }

    #[test]
    fn correlate_preparing_active_with_malformed_timestamp_warns() {
        let status = status_info_with_active_runs(
            vec![phased_active_run(
                "run-malformed-ts",
                "sandbox-malformed-ts",
                "preparing",
                "not-a-timestamp".into(),
            )],
            vec![],
        );
        let fc: Vec<process::FirecrackerProcessInfo> = vec![];

        let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);

        assert_eq!(jobs.len(), 1);
        assert!(matches!(
            jobs.first().unwrap().status,
            JobStatus::Preparing { pid: None, .. }
        ));
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn correlate_orphan_fc_warns() {
        // FC process with a sandbox_id outside both active and idle sets.
        let status = status_info(vec![("run-a", "sandbox-a")], vec!["sandbox-idle"]);
        let fc = vec![
            fc_info(400, "sandbox-a", Path::new("/data/r1")), // active, OK
            fc_info(401, "sandbox-idle", Path::new("/data/r1")), // idle, OK
            fc_info(402, "sandbox-orphan", Path::new("/data/r1")), // orphan, warn
        ];
        let expected_generation = fc[2].generation;
        let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);
        assert_eq!(jobs.len(), 2, "one active job + one orphan surface");
        assert_eq!(warnings.len(), 1);
        let msg = warnings[0].to_string();
        assert!(msg.contains("sandbox-orphan"), "{msg}");
        assert!(msg.contains("not in status.json"), "{msg}");
        let Warning::FirecrackerNotInStatus { generation, .. } = &warnings[0] else {
            panic!("orphan Firecracker must produce FirecrackerNotInStatus");
        };
        assert_eq!(generation, &expected_generation);

        // The orphan row must carry the sandbox_id in `NotInStatus`, not
        // misfiled into a `run_id` variant. Type-checking this here locks
        // in the distinction so future refactors can't quietly regress.
        let orphan_row = jobs
            .iter()
            .find(|j| matches!(j.status, JobStatus::NotInStatus { .. }))
            .expect("orphan row missing");
        let JobStatus::NotInStatus { sandbox_id } = &orphan_row.status else {
            panic!("orphan row must be NotInStatus");
        };
        assert_eq!(sandbox_id, "sandbox-orphan");
    }

    #[test]
    fn correlate_jobs_ignores_other_runners() {
        let status = status_info(vec![("abc", "sbox-abc")], vec![]);
        // This firecracker belongs to a different runner (different base_dir)
        let fc = vec![process::FirecrackerProcessInfo {
            pid: 300,
            ppid: None,
            sandbox_id: "sbox-abc".into(),
            base_dir: Some(PathBuf::from("/data/r2")),
            generation: None,
        }];
        let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);
        assert_eq!(jobs.len(), 1);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].to_string().contains("no firecracker process"));
    }

    #[test]
    fn correlate_jobs_empty_status_empty_fcs() {
        let status = status_info(vec![], vec![]);
        let fc: Vec<process::FirecrackerProcessInfo> = vec![];
        let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);
        assert!(jobs.is_empty());
        assert!(warnings.is_empty());
    }

    // -- persists() recheck tests --------------------------------------------
    //
    // These exercise the resolution logic used in the recheck loop. Each
    // writes a real status.json (since persists() calls read_status
    // internally) and asserts whether the warning clears.

    fn write_status_json(path: &std::path::Path, contents: &str) {
        std::fs::write(path, contents).unwrap();
    }

    fn empty_fresh() -> process::DiscoveredProcesses {
        process::DiscoveredProcesses {
            firecrackers: vec![],
            mitmdumps: vec![],
            dnsmasqs: vec![],
        }
    }

    fn fresh_with_firecracker(
        pid: u32,
        sandbox_id: &str,
        base_dir: &Path,
    ) -> process::DiscoveredProcesses {
        process::DiscoveredProcesses {
            firecrackers: vec![fc_info(pid, sandbox_id, base_dir)],
            mitmdumps: vec![],
            dnsmasqs: vec![],
        }
    }

    struct ChildGuard(std::process::Child);

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn sleeping_child() -> ChildGuard {
        ChildGuard(
            std::process::Command::new("sleep")
                .arg("30")
                .spawn()
                .unwrap(),
        )
    }

    fn observed_network_namespaces(ns_names: &[&str]) -> HashSet<String> {
        ns_names.iter().map(|name| (*name).to_string()).collect()
    }

    fn orphan_namespace_warning(ns_name: &str, lock_path: PathBuf) -> Warning {
        Warning::OrphanNamespace {
            ns_name: ns_name.to_string(),
            lock_path,
        }
    }

    #[tokio::test]
    async fn orphan_namespace_clears_when_exact_namespace_disappears() {
        let dir = tempfile::tempdir().unwrap();
        let free_lock_path = dir.path().join("free.lock");
        std::fs::File::create(&free_lock_path).unwrap();
        let missing_lock_path = dir.path().join("missing.lock");
        let namespaces = observed_network_namespaces(&["vm0-ns-00-0b"]);

        for lock_path in [free_lock_path, missing_lock_path] {
            let warning = orphan_namespace_warning("vm0-ns-00-0a", lock_path);
            assert!(
                !warning
                    .persists(None, &empty_fresh(), &[], Some(&namespaces))
                    .await,
                "a different namespace in the same pool must not retain the warning"
            );
        }
    }

    #[tokio::test]
    async fn orphan_namespace_persists_while_exact_namespace_and_free_lock_remain() {
        let dir = tempfile::tempdir().unwrap();
        let free_lock_path = dir.path().join("free.lock");
        std::fs::File::create(&free_lock_path).unwrap();
        let missing_lock_path = dir.path().join("missing.lock");
        let namespaces = observed_network_namespaces(&["vm0-ns-00-0a"]);

        for lock_path in [free_lock_path, missing_lock_path] {
            let warning = orphan_namespace_warning("vm0-ns-00-0a", lock_path);
            assert!(
                warning
                    .persists(None, &empty_fresh(), &[], Some(&namespaces))
                    .await
            );
        }
    }

    #[tokio::test]
    async fn orphan_namespace_clears_when_its_lock_becomes_held() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("held.lock");
        let file = std::fs::File::create(&lock_path).unwrap();
        let _lock = nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock)
            .expect("failed to acquire test lock");
        let namespaces = observed_network_namespaces(&["vm0-ns-00-0a"]);
        let warning = orphan_namespace_warning("vm0-ns-00-0a", lock_path);

        assert!(
            !warning
                .persists(None, &empty_fresh(), &[], Some(&namespaces))
                .await
        );
    }

    #[tokio::test]
    async fn orphan_namespace_uses_lock_evidence_when_observation_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let free_lock_path = dir.path().join("free.lock");
        std::fs::File::create(&free_lock_path).unwrap();
        let missing_lock_path = dir.path().join("missing.lock");
        let held_lock_path = dir.path().join("held.lock");
        let held_file = std::fs::File::create(&held_lock_path).unwrap();
        let _held_lock =
            nix::fcntl::Flock::lock(held_file, nix::fcntl::FlockArg::LockExclusiveNonblock)
                .expect("failed to acquire test lock");

        for lock_path in [free_lock_path, missing_lock_path] {
            let warning = orphan_namespace_warning("vm0-ns-00-0a", lock_path);
            assert!(warning.persists(None, &empty_fresh(), &[], None).await);
        }

        let held_warning = orphan_namespace_warning("vm0-ns-00-0a", held_lock_path);
        assert!(!held_warning.persists(None, &empty_fresh(), &[], None).await);
    }

    #[tokio::test]
    async fn no_firecracker_for_run_resolves_when_run_removed_even_if_sandbox_reused() {
        // Regression: a NoFirecrackerForRun warning for run R1 should clear
        // once R1 is no longer in active_runs, even if R1's sandbox_id got
        // reused by another active run R2. Keying on sandbox_id instead of
        // run_id would wrongly keep R1's warning.
        let dir = tempfile::tempdir().unwrap();
        let base_dir = dir.path().to_path_buf();
        write_status_json(
            &base_dir.join("status.json"),
            r#"{
                "mode": "running",
                "max_concurrent": 4,
                "active_runs": [
                    {
                        "run_id": "R2",
                        "sandbox_id": "S1",
                        "phase": "running",
                        "phase_started_at": "2026-01-01T00:00:00.000Z"
                    }
                ],
                "started_at": "2026-01-01T00:00:00.000Z",
                "updated_at": "2026-01-01T00:00:00.000Z"
            }"#,
        );

        let warning = Warning::NoFirecrackerForRun {
            run_id: "R1".into(),
            sandbox_id: "S1".into(),
            base_dir: base_dir.clone(),
        };
        assert!(
            !warning.persists(None, &empty_fresh(), &[], None).await,
            "warning about R1 must clear after R1 leaves active_runs even though S1 is reused"
        );
    }

    #[tokio::test]
    async fn no_firecracker_for_run_persists_while_run_still_active() {
        let dir = tempfile::tempdir().unwrap();
        let base_dir = dir.path().to_path_buf();
        write_status_json(
            &base_dir.join("status.json"),
            r#"{
                "mode": "running",
                "max_concurrent": 4,
                "active_runs": [
                    {
                        "run_id": "R1",
                        "sandbox_id": "S1",
                        "phase": "running",
                        "phase_started_at": "2026-01-01T00:00:00.000Z"
                    }
                ],
                "started_at": "2026-01-01T00:00:00.000Z",
                "updated_at": "2026-01-01T00:00:00.000Z"
            }"#,
        );

        let warning = Warning::NoFirecrackerForRun {
            run_id: "R1".into(),
            sandbox_id: "S1".into(),
            base_dir: base_dir.clone(),
        };
        // R1 is still active and there's no FC in fresh. Warning persists.
        assert!(warning.persists(None, &empty_fresh(), &[], None).await);
    }

    #[tokio::test]
    async fn no_firecracker_for_run_clears_for_preparing_run_within_grace() {
        let dir = tempfile::tempdir().unwrap();
        let base_dir = dir.path().to_path_buf();
        let phase_started_at = phase_started_at_ago(Duration::from_secs(10));
        write_status_json(
            &base_dir.join("status.json"),
            &format!(
                r#"{{
                    "mode": "running",
                    "max_concurrent": 4,
                    "active_runs": [
                        {{
                            "run_id": "R1",
                            "sandbox_id": "S1",
                            "phase": "preparing",
                            "phase_started_at": "{phase_started_at}"
                        }}
                    ],
                    "started_at": "2026-01-01T00:00:00.000Z",
                    "updated_at": "2026-01-01T00:00:00.000Z"
                }}"#
            ),
        );

        let warning = Warning::NoFirecrackerForRun {
            run_id: "R1".into(),
            sandbox_id: "S1".into(),
            base_dir: base_dir.clone(),
        };
        assert!(!warning.persists(None, &empty_fresh(), &[], None).await);
    }

    #[tokio::test]
    async fn no_firecracker_for_run_clears_for_stale_preparing_run() {
        let dir = tempfile::tempdir().unwrap();
        let base_dir = dir.path().to_path_buf();
        let phase_started_at =
            phase_started_at_ago(PREPARING_NO_PROCESS_GRACE + Duration::from_secs(1));
        write_status_json(
            &base_dir.join("status.json"),
            &format!(
                r#"{{
                    "mode": "running",
                    "max_concurrent": 4,
                    "active_runs": [
                        {{
                            "run_id": "R1",
                            "sandbox_id": "S1",
                            "phase": "preparing",
                            "phase_started_at": "{phase_started_at}"
                        }}
                    ],
                    "started_at": "2026-01-01T00:00:00.000Z",
                    "updated_at": "2026-01-01T00:00:00.000Z"
                }}"#
            ),
        );

        let warning = Warning::NoFirecrackerForRun {
            run_id: "R1".into(),
            sandbox_id: "S1".into(),
            base_dir: base_dir.clone(),
        };
        assert!(!warning.persists(None, &empty_fresh(), &[], None).await);
    }

    #[tokio::test]
    async fn stale_preparing_run_persists_while_run_remains_stale_preparing() {
        let dir = tempfile::tempdir().unwrap();
        let base_dir = dir.path().to_path_buf();
        let phase_started_at =
            phase_started_at_ago(PREPARING_NO_PROCESS_GRACE + Duration::from_secs(1));
        write_status_json(
            &base_dir.join("status.json"),
            &format!(
                r#"{{
                    "mode": "running",
                    "max_concurrent": 4,
                    "active_runs": [
                        {{
                            "run_id": "R1",
                            "sandbox_id": "S1",
                            "phase": "preparing",
                            "phase_started_at": "{phase_started_at}"
                        }}
                    ],
                    "started_at": "2026-01-01T00:00:00.000Z",
                    "updated_at": "2026-01-01T00:00:00.000Z"
                }}"#
            ),
        );

        let warning = Warning::StalePreparingRun {
            run_id: "R1".into(),
            sandbox_id: "S1".into(),
            base_dir: base_dir.clone(),
        };
        assert!(warning.persists(None, &empty_fresh(), &[], None).await);
    }

    #[tokio::test]
    async fn stale_preparing_run_clears_after_phase_changes_to_running_with_firecracker() {
        let dir = tempfile::tempdir().unwrap();
        let base_dir = dir.path().to_path_buf();
        write_status_json(
            &base_dir.join("status.json"),
            r#"{
                "mode": "running",
                "max_concurrent": 4,
                "active_runs": [
                    {
                        "run_id": "R1",
                        "sandbox_id": "S1",
                        "phase": "running",
                        "phase_started_at": "2026-01-01T00:00:00.000Z"
                    }
                ],
                "started_at": "2026-01-01T00:00:00.000Z",
                "updated_at": "2026-01-01T00:00:00.000Z"
            }"#,
        );

        let warning = Warning::StalePreparingRun {
            run_id: "R1".into(),
            sandbox_id: "S1".into(),
            base_dir: base_dir.clone(),
        };
        assert!(
            !warning
                .persists(
                    None,
                    &fresh_with_firecracker(123, "S1", &base_dir),
                    &[],
                    None,
                )
                .await
        );
    }

    #[tokio::test]
    async fn stale_preparing_run_persists_after_phase_changes_to_running_without_firecracker() {
        let dir = tempfile::tempdir().unwrap();
        let base_dir = dir.path().to_path_buf();
        write_status_json(
            &base_dir.join("status.json"),
            r#"{
                "mode": "running",
                "max_concurrent": 4,
                "active_runs": [
                    {
                        "run_id": "R1",
                        "sandbox_id": "S1",
                        "phase": "running",
                        "phase_started_at": "2026-01-01T00:00:00.000Z"
                    }
                ],
                "started_at": "2026-01-01T00:00:00.000Z",
                "updated_at": "2026-01-01T00:00:00.000Z"
            }"#,
        );

        let warning = Warning::StalePreparingRun {
            run_id: "R1".into(),
            sandbox_id: "S1".into(),
            base_dir: base_dir.clone(),
        };
        assert!(warning.persists(None, &empty_fresh(), &[], None).await);
    }

    #[tokio::test]
    async fn no_firecracker_for_run_clears_when_same_run_points_to_new_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let base_dir = dir.path().to_path_buf();
        write_status_json(
            &base_dir.join("status.json"),
            r#"{
                "mode": "running",
                "max_concurrent": 4,
                "active_runs": [
                    {
                        "run_id": "R1",
                        "sandbox_id": "S2",
                        "phase": "running",
                        "phase_started_at": "2026-01-01T00:00:00.000Z"
                    }
                ],
                "started_at": "2026-01-01T00:00:00.000Z",
                "updated_at": "2026-01-01T00:00:00.000Z"
            }"#,
        );

        let warning = Warning::NoFirecrackerForRun {
            run_id: "R1".into(),
            sandbox_id: "S1".into(),
            base_dir: base_dir.clone(),
        };
        assert!(!warning.persists(None, &empty_fresh(), &[], None).await);
    }

    #[tokio::test]
    async fn firecracker_not_in_status_clears_when_sandbox_becomes_idle() {
        // A FirecrackerNotInStatus warning must clear once its sandbox_id
        // shows up in idle_sandboxes (the sandbox was parked between scans).
        let dir = tempfile::tempdir().unwrap();
        let base_dir = dir.path().to_path_buf();
        write_status_json(
            &base_dir.join("status.json"),
            r#"{
                "mode": "running",
                "max_concurrent": 4,
                "active_runs": [],
                "idle_sandboxes": [
                    {"reuse_key": "sess-1", "sandbox_id": "S1"}
                ],
                "started_at": "2026-01-01T00:00:00.000Z",
                "updated_at": "2026-01-01T00:00:00.000Z"
            }"#,
        );

        let fresh = fresh_with_firecracker(101, "S1", &base_dir);
        let warning = Warning::FirecrackerNotInStatus {
            pid: 101,
            sandbox_id: "S1".into(),
            base_dir: base_dir.clone(),
            generation: fresh.firecrackers[0].generation,
        };
        assert!(
            !warning.persists(None, &fresh, &[], None).await,
            "warning must clear once the sandbox is tracked as idle"
        );
    }

    #[tokio::test]
    async fn firecracker_not_in_status_clears_when_sandbox_becomes_active() {
        let dir = tempfile::tempdir().unwrap();
        let base_dir = dir.path().to_path_buf();
        write_status_json(
            &base_dir.join("status.json"),
            r#"{
                "mode": "running",
                "max_concurrent": 4,
                "active_runs": [
                    {
                        "run_id": "R1",
                        "sandbox_id": "S1",
                        "phase": "running",
                        "phase_started_at": "2026-01-01T00:00:00.000Z"
                    }
                ],
                "started_at": "2026-01-01T00:00:00.000Z",
                "updated_at": "2026-01-01T00:00:00.000Z"
            }"#,
        );

        let fresh = fresh_with_firecracker(101, "S1", &base_dir);
        let warning = Warning::FirecrackerNotInStatus {
            pid: 101,
            sandbox_id: "S1".into(),
            base_dir: base_dir.clone(),
            generation: fresh.firecrackers[0].generation,
        };
        assert!(!warning.persists(None, &fresh, &[], None).await);
    }

    #[tokio::test]
    async fn firecracker_not_in_status_persists_when_still_orphan() {
        let dir = tempfile::tempdir().unwrap();
        let base_dir = dir.path().to_path_buf();
        write_status_json(
            &base_dir.join("status.json"),
            r#"{
                "mode": "running",
                "max_concurrent": 4,
                "active_runs": [],
                "started_at": "2026-01-01T00:00:00.000Z",
                "updated_at": "2026-01-01T00:00:00.000Z"
            }"#,
        );

        let fresh = fresh_with_firecracker(101, "S-ghost", &base_dir);
        let warning = Warning::FirecrackerNotInStatus {
            pid: 101,
            sandbox_id: "S-ghost".into(),
            base_dir: base_dir.clone(),
            generation: fresh.firecrackers[0].generation,
        };
        assert!(warning.persists(None, &fresh, &[], None).await);
    }

    #[tokio::test]
    async fn firecracker_not_in_status_clears_when_fresh_observation_is_absent() {
        let dir = tempfile::tempdir().unwrap();
        let base_dir = dir.path().to_path_buf();
        let firecracker = fc_info(101, "S-anything", &base_dir);
        let warning = Warning::FirecrackerNotInStatus {
            pid: firecracker.pid,
            sandbox_id: "S-anything".into(),
            base_dir,
            generation: firecracker.generation,
        };
        assert!(!warning.persists(None, &empty_fresh(), &[], None).await);
    }

    #[tokio::test]
    async fn firecracker_not_in_status_clears_when_process_generation_changes() {
        let dir = tempfile::tempdir().unwrap();
        let base_dir = dir.path().to_path_buf();
        let original = fc_info(101, "S-ghost", &base_dir);
        let warning = Warning::FirecrackerNotInStatus {
            pid: original.pid,
            sandbox_id: original.sandbox_id.clone(),
            base_dir: base_dir.clone(),
            generation: original.generation,
        };
        let mut replacement = fc_info(101, "S-ghost", &base_dir);
        replacement.generation.as_mut().unwrap().starttime += 1;
        let fresh = process::DiscoveredProcesses {
            firecrackers: vec![replacement],
            mitmdumps: vec![],
            dnsmasqs: vec![],
        };

        assert!(!warning.persists(None, &fresh, &[], None).await);
    }

    #[tokio::test]
    async fn firecracker_not_in_status_clears_when_workspace_facts_change() {
        let dir = tempfile::tempdir().unwrap();
        let base_dir = dir.path().to_path_buf();
        let original = fc_info(101, "S-ghost", &base_dir);
        let warning = Warning::FirecrackerNotInStatus {
            pid: original.pid,
            sandbox_id: original.sandbox_id.clone(),
            base_dir: base_dir.clone(),
            generation: original.generation,
        };

        let mut changed_sandbox = original.clone();
        changed_sandbox.sandbox_id = "S-replacement".into();
        let fresh = process::DiscoveredProcesses {
            firecrackers: vec![changed_sandbox],
            mitmdumps: vec![],
            dnsmasqs: vec![],
        };
        assert!(!warning.persists(None, &fresh, &[], None).await);

        let mut changed_base_dir = original;
        changed_base_dir.base_dir = Some(base_dir.join("replacement"));
        let fresh = process::DiscoveredProcesses {
            firecrackers: vec![changed_base_dir],
            mitmdumps: vec![],
            dnsmasqs: vec![],
        };
        assert!(!warning.persists(None, &fresh, &[], None).await);
    }

    #[tokio::test]
    async fn installed_service_discovery_refills_slots_and_preserves_order() {
        run_service_discovery_scenario("bounded").await;
    }

    #[tokio::test]
    async fn named_service_discovery_queries_only_the_target_once() {
        run_service_discovery_scenario("named").await;
    }

    async fn run_service_discovery_scenario(scenario: &str) {
        let dir = tempfile::tempdir().unwrap();
        let fake_systemctl = dir.path().join("systemctl");
        std::fs::write(&fake_systemctl, FAKE_DISCOVERY_SYSTEMCTL).unwrap();
        let mut permissions = std::fs::metadata(&fake_systemctl).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&fake_systemctl, permissions).unwrap();

        let system_dir = dir.path().join("system");
        std::fs::create_dir(&system_dir).unwrap();
        for suffix in ["alpha", "beta", "delta", "failure", "gamma"] {
            std::fs::write(system_dir.join(format!("vm0-runner-{suffix}.service")), "").unwrap();
        }
        std::fs::write(system_dir.join("unrelated.service"), "").unwrap();

        let state_dir = dir.path().join("state");
        std::fs::create_dir(&state_dir).unwrap();
        let invocations_path = dir.path().join("invocations");
        let path = format!(
            "{}:{}",
            dir.path().display(),
            std::env::var("PATH").unwrap()
        );
        run_ignored_child_test(
            SERVICE_DISCOVERY_CHILD_TEST,
            (SERVICE_DISCOVERY_SCENARIO_ENV, scenario),
            &[
                ("PATH", Some(path.as_str())),
                (
                    SERVICE_DISCOVERY_SYSTEM_DIR_ENV,
                    Some(system_dir.to_str().unwrap()),
                ),
                (
                    SERVICE_DISCOVERY_STATE_DIR_ENV,
                    Some(state_dir.to_str().unwrap()),
                ),
                (
                    SERVICE_DISCOVERY_INVOCATIONS_ENV,
                    Some(invocations_path.to_str().unwrap()),
                ),
            ],
            Duration::from_secs(15),
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "spawned by doctor service discovery systemctl tests"]
    async fn doctor_service_discovery_systemctl_child() {
        let Ok(scenario) = std::env::var(SERVICE_DISCOVERY_SCENARIO_ENV) else {
            return;
        };
        if !ignored_child_test_env_guard_enabled((SERVICE_DISCOVERY_SCENARIO_ENV, &scenario)) {
            return;
        }

        let system_dir = PathBuf::from(std::env::var(SERVICE_DISCOVERY_SYSTEM_DIR_ENV).unwrap());
        match scenario.as_str() {
            "bounded" => assert_bounded_installed_service_discovery(&system_dir).await,
            "named" => assert_named_service_discovery(&system_dir).await,
            unexpected => panic!("unexpected service discovery scenario: {unexpected}"),
        }
    }

    async fn assert_bounded_installed_service_discovery(system_dir: &Path) {
        let state_dir = PathBuf::from(std::env::var(SERVICE_DISCOVERY_STATE_DIR_ENV).unwrap());
        let units: Vec<_> = std::fs::read_dir(system_dir)
            .unwrap()
            .filter_map(|entry| {
                let name = entry.unwrap().file_name();
                super::super::service::RunnerServiceUnit::from_file_name(name.to_str().unwrap())
            })
            .collect();
        let first_unit = units.first().unwrap().service_name().to_string();
        let release_lookups = async {
            wait_for_started_units(&state_dir, DOCTOR_IO_CONCURRENCY).await;
            let first_batch = started_units(&state_dir);
            assert_eq!(first_batch.len(), DOCTOR_IO_CONCURRENCY);
            assert!(first_batch.contains(&first_unit));
            let later_units: Vec<_> = first_batch
                .into_iter()
                .filter(|unit| unit != &first_unit)
                .collect();
            release_units(&state_dir, &later_units);

            // The first lookup stays blocked until a freed slot starts the fifth unit.
            wait_for_started_units(&state_dir, DOCTOR_IO_CONCURRENCY + 1).await;
            release_units(&state_dir, &started_units(&state_dir));
        };
        let (services, ()) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(find_installed_services(system_dir), release_lookups)
        })
        .await
        .expect("bounded service discovery should finish after releases");

        assert_eq!(
            services
                .iter()
                .map(|service| service.unit_name.as_str())
                .collect::<Vec<_>>(),
            units
                .iter()
                .map(|unit| unit.unit_name())
                .collect::<Vec<_>>(),
        );
        assert_eq!(services.len(), 5);
        for service in services {
            let suffix = service.unit_name.strip_prefix("vm0-runner-").unwrap();
            if suffix == "failure" {
                assert_eq!(service.config_path, None);
            } else {
                assert_eq!(
                    service.config_path,
                    Some(PathBuf::from(format!("/configs/{suffix}.yaml")))
                );
            }
        }
    }

    async fn assert_named_service_discovery(system_dir: &Path) {
        let (config_path_filter, installed_services) =
            discover_services(Some("target"), system_dir).await.unwrap();

        assert_eq!(
            config_path_filter,
            Some(PathBuf::from("/configs/target.yaml"))
        );
        assert!(installed_services.is_empty());
        let invocations_path =
            PathBuf::from(std::env::var(SERVICE_DISCOVERY_INVOCATIONS_ENV).unwrap());
        assert_eq!(
            std::fs::read_to_string(invocations_path).unwrap(),
            "--no-pager cat -- vm0-runner-target.service\n"
        );
    }

    async fn wait_for_started_units(state_dir: &Path, expected: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if started_units(state_dir).len() >= expected {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("fake systemctl lookups should reach the gate");
    }

    fn started_units(state_dir: &Path) -> Vec<String> {
        std::fs::read_dir(state_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter_map(|name| name.strip_suffix(".started").map(str::to_string))
            .collect()
    }

    fn release_units(state_dir: &Path, units: &[String]) {
        for unit in units {
            std::fs::write(state_dir.join(format!("{unit}.release")), "").unwrap();
        }
    }

    #[tokio::test]
    async fn orphan_firecracker_recheck_requires_same_identified_observation() {
        let child = sleeping_child();
        let firecracker = fc_info(child.0.id(), "sandbox-orphan", Path::new("/data/r1"));
        let expected_generation = firecracker.generation;
        let fresh = process::DiscoveredProcesses {
            firecrackers: vec![firecracker.clone()],
            mitmdumps: vec![],
            dnsmasqs: vec![],
        };
        let warnings = detect_orphan_firecrackers(&[firecracker], &[], None).await;
        assert_eq!(warnings.len(), 1);
        let warning = &warnings[0];
        let Warning::OrphanFirecracker { generation, .. } = warning else {
            panic!("orphan Firecracker must produce OrphanFirecracker");
        };
        assert_eq!(generation, &expected_generation);
        assert!(warning.persists(None, &fresh, &[], None).await);
        assert!(
            !warning
                .persists(None, &fresh, &[std::process::id()], None)
                .await
        );

        let mut replacement = fresh.firecrackers[0].clone();
        replacement.generation.as_mut().unwrap().pgid += 1;
        let replacement_fresh = process::DiscoveredProcesses {
            firecrackers: vec![replacement],
            mitmdumps: vec![],
            dnsmasqs: vec![],
        };
        assert!(!warning.persists(None, &replacement_fresh, &[], None).await);
        assert!(!warning.persists(None, &empty_fresh(), &[], None).await);
    }

    #[tokio::test]
    async fn orphan_firecracker_recheck_requires_fresh_unidentified_observation() {
        let child = sleeping_child();
        let pid = child.0.id();
        let sandbox_id = format!("pid-{pid}");
        let firecracker = process::FirecrackerProcessInfo {
            pid,
            ppid: Some(std::process::id()),
            sandbox_id: sandbox_id.clone(),
            base_dir: None,
            generation: None,
        };
        let fresh = process::DiscoveredProcesses {
            firecrackers: vec![firecracker.clone()],
            mitmdumps: vec![],
            dnsmasqs: vec![],
        };
        let warnings = detect_orphan_firecrackers(&[firecracker], &[], None).await;
        assert_eq!(warnings.len(), 1);
        let warning = &warnings[0];
        assert!(warning.persists(None, &fresh, &[], None).await);

        let identified_replacement = process::FirecrackerProcessInfo {
            pid,
            ppid: Some(std::process::id()),
            sandbox_id: sandbox_id.clone(),
            base_dir: None,
            generation: Some(process::ProcfsProcessGeneration {
                pgid: pid,
                starttime: u64::from(pid),
            }),
        };
        let replacement_fresh = process::DiscoveredProcesses {
            firecrackers: vec![identified_replacement],
            mitmdumps: vec![],
            dnsmasqs: vec![],
        };
        assert!(!warning.persists(None, &replacement_fresh, &[], None).await);
        assert!(!warning.persists(None, &empty_fresh(), &[], None).await);
    }

    #[tokio::test]
    async fn orphan_mitmdump_clears_when_parent_runner_pid_appears() {
        let child = sleeping_child();
        let warning = Warning::OrphanMitmdump {
            pid: child.0.id(),
            port: 32821,
            ppid: Some(std::process::id()),
        };

        assert!(warning.persists(None, &empty_fresh(), &[], None).await);
        assert!(
            !warning
                .persists(None, &empty_fresh(), &[std::process::id()], None)
                .await
        );
    }

    #[test]
    fn find_stopped_services_detects_missing() {
        let installed = vec![
            InstalledService {
                unit_name: "vm0-runner-active".into(),
                config_path: Some(PathBuf::from("/data/active.yaml")),
            },
            InstalledService {
                unit_name: "vm0-runner-stopped".into(),
                config_path: Some(PathBuf::from("/data/stopped.yaml")),
            },
        ];
        let reports = vec![RunnerReport {
            live_runner: live_runner_instance(
                1,
                PathBuf::from("/data/active.yaml"),
                PathBuf::from("/data/active"),
            ),
            base_dir: None,
            pid: 1,
            config_path: PathBuf::from("/data/active.yaml"),
            subcommand: "start".into(),
            service_type: ServiceType::Installed("vm0-runner-active".into()),
            status: None,
            api_ok: None,
            proxy_pid: None,
            dns_pid: None,
            jobs: vec![],
            warnings: vec![],
        }];
        let stopped = find_stopped_services(&installed, &reports);
        assert_eq!(stopped.len(), 1);
        assert_eq!(stopped[0].unit_name, "vm0-runner-stopped");
        assert_eq!(stopped[0].config_info, "/data/stopped.yaml");
    }

    fn make_report(label: &str) -> RunnerReport {
        let config_path = PathBuf::from(format!("/data/{label}.yaml"));
        RunnerReport {
            live_runner: live_runner_instance(1, config_path.clone(), PathBuf::from("/data/test")),
            base_dir: None,
            pid: 1,
            config_path,
            subcommand: "start".into(),
            service_type: ServiceType::Bare,
            status: None,
            api_ok: None,
            proxy_pid: None,
            dns_pid: None,
            jobs: vec![],
            warnings: vec![],
        }
    }

    #[test]
    fn warning_display() {
        let w = Warning::StatusUnavailable {
            base_dir: PathBuf::from("/data/r1"),
        };
        assert_eq!(w.to_string(), "status.json unavailable");

        let w = Warning::NoFirecrackerForRun {
            run_id: "abc-123".into(),
            sandbox_id: "sbox-abc".into(),
            base_dir: PathBuf::from("/data/r1"),
        };
        assert_eq!(
            w.to_string(),
            "no firecracker process for run abc-123 (sandbox sbox-abc)"
        );

        let w = Warning::StalePreparingRun {
            run_id: "prep-123".into(),
            sandbox_id: "sbox-prep".into(),
            base_dir: PathBuf::from("/data/r1"),
        };
        assert_eq!(
            w.to_string(),
            "run prep-123 stuck preparing (sandbox sbox-prep)"
        );

        let w = Warning::FirecrackerNotInStatus {
            pid: 17,
            sandbox_id: "sbox-gone".into(),
            base_dir: PathBuf::from("/data/r1"),
            generation: None,
        };
        assert_eq!(
            w.to_string(),
            "firecracker PID 17 (sandbox sbox-gone) not in status.json"
        );

        let w = Warning::ApiUnreachable {
            server_url: "https://example.com".into(),
            server_token: "tok".into(),
        };
        assert_eq!(w.to_string(), "API unreachable");

        let w = Warning::OrphanFirecracker {
            pid: 42,
            sandbox_id: "xyz".into(),
            base_dir: None,
            ppid: Some(10),
            generation: None,
        };
        assert_eq!(
            w.to_string(),
            "orphan firecracker PID 42 (sandbox xyz, ppid=10)"
        );

        let w = Warning::OrphanFirecracker {
            pid: 42,
            sandbox_id: "xyz".into(),
            base_dir: None,
            ppid: None,
            generation: None,
        };
        assert_eq!(
            w.to_string(),
            "orphan firecracker PID 42 (sandbox xyz, ppid=?)"
        );

        let w = Warning::StaleMitmproxy { port: 32821 };
        assert_eq!(
            w.to_string(),
            "stale mitmproxy process on port 32821 (runner stopped)"
        );

        let w = Warning::OrphanNbdDevice {
            device_index: 3,
            pid: 12345,
        };
        assert_eq!(
            w.to_string(),
            "orphan NBD device /dev/nbd3 (owner PID 12345 no longer exists)"
        );

        let w = Warning::NbdScanFailed;
        assert_eq!(w.to_string(), "NBD orphan scan failed (task panicked)");
    }

    #[test]
    fn is_inactive_mode_classification() {
        assert!(is_inactive_mode("stopped"));
        assert!(is_inactive_mode("draining"));
        assert!(!is_inactive_mode("running"));
        assert!(!is_inactive_mode("starting"));
        assert!(!is_inactive_mode(""));
    }

    #[test]
    fn idle_sandbox_diagnostic_line_includes_reuse_key() {
        let reuse_key = "thread:doctor-17975";
        let line = format_idle_sandbox_diagnostic_line(&IdleSandbox {
            reuse_key: reuse_key.into(),
            sandbox_id: "sandbox-123".into(),
        });

        assert!(line.contains(reuse_key));
        assert!(line.contains("sandbox-123"));
    }

    struct DoctorReportFixture {
        _dir: tempfile::TempDir,
        config_path: PathBuf,
        base_dir: PathBuf,
    }

    fn doctor_report_fixture(
        mode: &str,
        proxy_port: Option<u16>,
        dns_port: Option<u16>,
    ) -> DoctorReportFixture {
        doctor_report_fixture_with_server(mode, proxy_port, dns_port, None)
    }

    fn doctor_report_fixture_without_status() -> DoctorReportFixture {
        let fixture = doctor_report_fixture("starting", None, None);
        std::fs::remove_file(fixture.base_dir.join("status.json")).unwrap();
        fixture
    }

    fn doctor_report_fixture_with_server(
        mode: &str,
        proxy_port: Option<u16>,
        dns_port: Option<u16>,
        server: Option<(&str, &str)>,
    ) -> DoctorReportFixture {
        let dir = tempfile::tempdir().unwrap();
        let base_dir = dir.path().join("runner");
        std::fs::create_dir_all(&base_dir).unwrap();

        let config_path = dir.path().join("runner.yaml");
        let mut config = serde_json::json!({
            "group": "vm0/test",
            "base_dir": base_dir.display().to_string(),
            "ca_dir": dir.path().join("ca").display().to_string(),
            "firecracker": {
                "binary": dir.path().join("firecracker").display().to_string(),
                "kernel": dir.path().join("vmlinux").display().to_string(),
            },
            "profiles": {
                "vm0/default": {
                    "rootfs_hash": "rootfs",
                    "snapshot_hash": "snapshot",
                    "vcpu": 1,
                    "memory_mb": 512,
                    "rootfs_disk_mb": 512,
                    "workspace_disk_mb": 1024,
                },
            },
        });
        if let Some((url, token)) = server {
            config["server"] = serde_json::json!({
                "url": url,
                "token": token,
            });
        }
        std::fs::write(&config_path, serde_yaml_ng::to_string(&config).unwrap()).unwrap();

        let status = serde_json::json!({
            "mode": mode,
            "started_at": "2026-01-01T00:00:00.000Z",
            "active_runs": [],
            "proxy_port": proxy_port,
            "dns_port": dns_port,
        });
        std::fs::write(base_dir.join("status.json"), status.to_string()).unwrap();

        DoctorReportFixture {
            _dir: dir,
            config_path,
            base_dir,
        }
    }

    fn live_runner_instance(
        pid: u32,
        config_path: PathBuf,
        base_dir: PathBuf,
    ) -> LiveRunnerInstance {
        LiveRunnerInstance {
            pid,
            starttime: 0,
            config_path,
            base_dir,
            runner_group: "vm0/test".into(),
            subcommand: "start".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    async fn build_test_runner_report(
        mode: &str,
        proxy_port: Option<u16>,
        dns_port: Option<u16>,
        mitm_procs: Vec<process::MitmproxyProcessInfo>,
        dns_procs: Vec<process::DnsmasqProcessInfo>,
    ) -> RunnerReport {
        let fixture = doctor_report_fixture(mode, proxy_port, dns_port);
        let runner = live_runner_instance(
            std::process::id(),
            fixture.config_path.clone(),
            fixture.base_dir.clone(),
        );
        let report = build_runner_report(&runner, None, &[], &mitm_procs, &dns_procs, &[]).await;
        assert!(report.base_dir.is_some(), "test config should load");
        assert!(report.status.is_some(), "test status should load");
        report
    }

    #[tokio::test]
    async fn report_distinguishes_owned_blank_inventory_with_overlapping_entries() {
        for parked in [
            serde_json::json!({
                "idle_sandboxes": [{"reuse_key": "thread:exact", "sandbox_id": "exact-id"}],
                "blank_sandboxes": [{"sandbox_id": "blank-id"}],
            }),
            serde_json::json!({
                "idle_sandboxes": [
                    {"reuse_key": "thread:exact", "sandbox_id": "exact-id"},
                    {"reuse_key": "overlapping-mirror", "sandbox_id": "blank-id"},
                ],
                "blank_sandboxes": [{"sandbox_id": "blank-id"}, {"sandbox_id": "blank-id"}],
            }),
        ] {
            let fixture = doctor_report_fixture("draining", None, None);
            let mut content = parked;
            content["mode"] = serde_json::json!("draining");
            content["started_at"] = serde_json::json!("2026-01-01T00:00:00.000Z");
            std::fs::write(fixture.base_dir.join("status.json"), content.to_string()).unwrap();
            let runner = live_runner_instance(
                std::process::id(),
                fixture.config_path.clone(),
                fixture.base_dir.clone(),
            );
            let firecrackers = vec![
                fc_info(101, "blank-id", &fixture.base_dir),
                fc_info(102, "exact-id", &fixture.base_dir),
            ];
            let report = build_runner_report(&runner, None, &firecrackers, &[], &[], &[]).await;
            assert!(
                report.jobs.is_empty(),
                "unclaimed inventory must not become jobs"
            );
            assert!(report.warnings.is_empty());
            let status = report.status.as_ref().unwrap();
            assert_eq!(status.idle_sandboxes.len(), 1);
            assert_eq!(status.blank_sandboxes.len(), 1);
            assert_eq!(
                format_parked_sandbox_diagnostics(status),
                concat!(
                    "    Idle:    1 exact sandboxes\n",
                    "      - reuse key thread:exact -> sandbox exact-id\n",
                    "    Blank:   1 sandboxes\n",
                    "      - sandbox blank-id\n",
                )
            );

            let fresh = fresh_with_firecracker(101, "blank-id", &fixture.base_dir);
            let warning = Warning::FirecrackerNotInStatus {
                pid: 101,
                sandbox_id: "blank-id".into(),
                base_dir: fixture.base_dir.clone(),
                generation: fresh.firecrackers[0].generation,
            };
            assert!(!warning.persists(None, &fresh, &[], None).await);
        }
    }

    fn mitm_proc(pid: u32, port: u16) -> process::MitmproxyProcessInfo {
        process::MitmproxyProcessInfo {
            pid,
            ppid: None,
            port,
        }
    }

    fn dns_proc(pid: u32, port: u16) -> process::DnsmasqProcessInfo {
        process::DnsmasqProcessInfo { pid, port }
    }

    fn empty_discovered() -> process::DiscoveredProcesses {
        process::DiscoveredProcesses {
            firecrackers: vec![],
            mitmdumps: vec![],
            dnsmasqs: vec![],
        }
    }

    fn has_proxy_warning(report: &RunnerReport) -> bool {
        report.warnings.iter().any(|w| {
            matches!(
                w,
                Warning::NoMitmproxy { .. } | Warning::StaleMitmproxy { .. }
            )
        })
    }

    fn has_dns_warning(report: &RunnerReport) -> bool {
        report
            .warnings
            .iter()
            .any(|w| matches!(w, Warning::NoDnsmasq { .. }))
    }

    fn has_status_unavailable_warning(report: &RunnerReport) -> bool {
        report
            .warnings
            .iter()
            .any(|w| matches!(w, Warning::StatusUnavailable { .. }))
    }

    #[tokio::test]
    async fn report_warns_for_each_unavailable_status_form() {
        enum StatusInput {
            Missing,
            Contents(String),
            Directory,
        }

        let cases = [
            ("missing", StatusInput::Missing),
            ("malformed json", StatusInput::Contents("{".into())),
            (
                "oversized",
                StatusInput::Contents(
                    "x".repeat(crate::private_fs::PRIVATE_STATUS_FILE_READ_MAX_BYTES as usize + 1),
                ),
            ),
            (
                "missing required field",
                StatusInput::Contents(
                    r#"{"active_runs":[],"started_at":"2026-01-01T00:00:00.000Z"}"#.into(),
                ),
            ),
            (
                "malformed required entry",
                StatusInput::Contents(
                    r#"{
                        "mode":"running",
                        "started_at":"2026-01-01T00:00:00.000Z",
                        "active_runs":[{"run_id":"run-1"}]
                    }"#
                    .into(),
                ),
            ),
            ("invalid file type", StatusInput::Directory),
        ];

        for (name, input) in cases {
            let fixture = doctor_report_fixture_without_status();
            let status_path = fixture.base_dir.join("status.json");
            match input {
                StatusInput::Missing => {}
                StatusInput::Contents(contents) => {
                    std::fs::write(&status_path, contents).unwrap();
                }
                StatusInput::Directory => {
                    std::fs::create_dir(&status_path).unwrap();
                }
            }
            let runner = live_runner_instance(
                std::process::id(),
                fixture.config_path.clone(),
                fixture.base_dir.clone(),
            );

            let report = build_runner_report(&runner, None, &[], &[], &[], &[]).await;

            assert!(report.status.is_none(), "{name}");
            assert!(has_status_unavailable_warning(&report), "{name}");
            assert_eq!(report.warnings.len(), 1, "{name}");
        }
    }

    #[tokio::test]
    async fn persistent_unavailable_status_survives_recheck_budget() {
        let fixture = doctor_report_fixture_without_status();
        let runner = live_runner_instance(
            std::process::id(),
            fixture.config_path.clone(),
            fixture.base_dir.clone(),
        );
        let report = build_runner_report(&runner, None, &[], &[], &[], &[]).await;
        let mut reports = [report];

        for _ in 0..RECHECK_MAX_ATTEMPTS {
            recheck_current_runner_warnings(None, &empty_discovered(), &mut reports).await;
        }

        assert!(reports[0].status.is_none());
        assert!(has_status_unavailable_warning(&reports[0]));
        assert_eq!(print_report(&reports, &[], &[]), 1);
    }

    #[tokio::test]
    async fn unavailable_status_recheck_applies_recovered_snapshot() {
        let fixture = doctor_report_fixture_without_status();
        let runner = live_runner_instance(
            std::process::id(),
            fixture.config_path.clone(),
            fixture.base_dir.clone(),
        );
        let report = build_runner_report(&runner, None, &[], &[], &[], &[]).await;
        std::fs::write(
            fixture.base_dir.join("status.json"),
            r#"{
                "mode":"starting",
                "started_at":"2026-01-01T00:00:00.000Z",
                "active_runs":[]
            }"#,
        )
        .unwrap();
        let mut reports = [report];

        recheck_current_runner_warnings(None, &empty_discovered(), &mut reports).await;

        assert_eq!(
            reports[0]
                .status
                .as_ref()
                .map(|status| status.mode.as_str()),
            Some("starting")
        );
        assert!(!has_status_unavailable_warning(&reports[0]));
        assert!(reports[0].warnings.is_empty());
        assert_eq!(print_report(&reports, &[], &[]), 0);
    }

    #[tokio::test]
    async fn unavailable_status_recheck_reports_recovered_proxy_anomaly() {
        let fixture = doctor_report_fixture_without_status();
        let runner = live_runner_instance(
            std::process::id(),
            fixture.config_path.clone(),
            fixture.base_dir.clone(),
        );
        let report = build_runner_report(&runner, None, &[], &[], &[], &[]).await;
        std::fs::write(
            fixture.base_dir.join("status.json"),
            r#"{
                "mode":"running",
                "started_at":"2026-01-01T00:00:00.000Z",
                "active_runs":[],
                "proxy_port":32821
            }"#,
        )
        .unwrap();
        let mut reports = [report];

        recheck_current_runner_warnings(None, &empty_discovered(), &mut reports).await;

        assert!(reports[0].status.is_some());
        assert!(!has_status_unavailable_warning(&reports[0]));
        assert!(has_proxy_warning(&reports[0]));
        assert_eq!(print_report(&reports, &[], &[]), 1);
    }

    #[tokio::test]
    async fn recheck_clears_runner_warnings_when_registry_entry_disappears() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let base_dir = dir.path().join("runner");
        let runner = live_runner_instance(
            std::process::id(),
            dir.path().join("runner.yaml"),
            base_dir.clone(),
        );
        let mut reports = vec![RunnerReport {
            live_runner: runner.clone(),
            base_dir: Some(base_dir.clone()),
            pid: runner.pid,
            config_path: runner.config_path.clone(),
            subcommand: "start".into(),
            service_type: ServiceType::Bare,
            status: None,
            api_ok: None,
            proxy_pid: None,
            dns_pid: None,
            jobs: vec![],
            warnings: vec![Warning::StatusUnavailable { base_dir }],
        }];

        recheck_per_runner_warnings(&home, None, &empty_discovered(), &mut reports)
            .await
            .unwrap();

        assert!(reports[0].warnings.is_empty());
    }

    #[tokio::test]
    async fn recheck_keeps_runner_warnings_while_registry_entry_is_current() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let base_dir = dir.path().join("runner");
        std::fs::create_dir_all(&base_dir).unwrap();
        std::fs::write(
            base_dir.join("status.json"),
            r#"{
                "mode": "running",
                "active_runs": [],
                "started_at": "2026-01-01T00:00:00.000Z",
                "proxy_port": 32821
            }"#,
        )
        .unwrap();
        let _handle = crate::live_runner_instances::publish(
            &home,
            crate::live_runner_instances::LiveRunnerInstanceMetadata {
                config_path: dir.path().join("runner.yaml"),
                base_dir: base_dir.clone(),
                runner_group: "vm0/test".into(),
                subcommand: "start".into(),
            },
        )
        .await
        .unwrap();
        let runner = crate::live_runner_instances::try_list(&home)
            .await
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        let mut reports = vec![RunnerReport {
            live_runner: runner.clone(),
            base_dir: Some(base_dir.clone()),
            pid: runner.pid,
            config_path: runner.config_path.clone(),
            subcommand: "start".into(),
            service_type: ServiceType::Bare,
            status: None,
            api_ok: None,
            proxy_pid: None,
            dns_pid: None,
            jobs: vec![],
            warnings: vec![Warning::NoMitmproxy {
                port: 32821,
                base_dir,
            }],
        }];

        recheck_per_runner_warnings(&home, None, &empty_discovered(), &mut reports)
            .await
            .unwrap();

        assert_eq!(reports[0].warnings.len(), 1);
    }

    #[tokio::test]
    async fn recheck_fails_when_live_registry_entry_becomes_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let base_dir = dir.path().join("runner");
        let _handle = crate::live_runner_instances::publish(
            &home,
            crate::live_runner_instances::LiveRunnerInstanceMetadata {
                config_path: dir.path().join("runner.yaml"),
                base_dir: base_dir.clone(),
                runner_group: "vm0/test".into(),
                subcommand: "start".into(),
            },
        )
        .await
        .unwrap();
        let runner = crate::live_runner_instances::try_list(&home)
            .await
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        crate::state_file::write_private_atomic(
            &home.live_runner_instance_record_path(runner.pid, runner.starttime),
            b"{",
        )
        .await
        .unwrap();
        let mut reports = vec![RunnerReport {
            live_runner: runner.clone(),
            base_dir: Some(base_dir.clone()),
            pid: runner.pid,
            config_path: runner.config_path.clone(),
            subcommand: "start".into(),
            service_type: ServiceType::Bare,
            status: None,
            api_ok: None,
            proxy_pid: None,
            dns_pid: None,
            jobs: vec![],
            warnings: vec![Warning::NoMitmproxy {
                port: 32821,
                base_dir,
            }],
        }];

        let error =
            match recheck_per_runner_warnings(&home, None, &empty_discovered(), &mut reports).await
            {
                Ok(_) => panic!("expected invalid live registry entry to fail"),
                Err(error) => error,
            };

        assert!(
            error.to_string().contains("live process identity"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn report_uses_registry_identity_when_config_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let base_dir = dir.path().join("runner");
        std::fs::create_dir_all(&base_dir).unwrap();
        std::fs::write(
            base_dir.join("status.json"),
            r#"{
                "mode": "running",
                "max_concurrent": 4,
                "active_runs": [],
                "started_at": "2026-01-01T00:00:00.000Z",
                "updated_at": "2026-01-01T00:00:00.000Z"
            }"#,
        )
        .unwrap();
        let runner = live_runner_instance(
            std::process::id(),
            dir.path().join("missing-runner.yaml"),
            base_dir.clone(),
        );

        let report = build_runner_report(&runner, None, &[], &[], &[], &[]).await;

        assert_eq!(report.base_dir.as_deref(), Some(base_dir.as_path()));
        assert_eq!(report.config_path, dir.path().join("missing-runner.yaml"));
        assert_eq!(report.pid, std::process::id());
        assert_eq!(report.subcommand, "start");
        assert!(report.status.is_some());
        assert_eq!(report.api_ok, None);
    }

    #[tokio::test]
    async fn report_ignores_status_for_benchmark() {
        let fixture = doctor_report_fixture("stopped", Some(32821), None);
        let mut runner = live_runner_instance(
            std::process::id(),
            fixture.config_path.clone(),
            fixture.base_dir.clone(),
        );
        runner.subcommand = "benchmark".into();

        let report =
            build_runner_report(&runner, None, &[], &[mitm_proc(123, 32821)], &[], &[]).await;

        assert_eq!(report.subcommand, "benchmark");
        assert!(report.status.is_none());
        assert!(!has_status_unavailable_warning(&report));
        assert!(report.warnings.is_empty());
    }

    #[tokio::test]
    async fn build_runner_reports_requires_live_registry_entries() {
        let server = MockServer::start_async().await;
        let api = server
            .mock_async(|when, then| {
                when.method("HEAD").path("/api");
                then.status(200);
            })
            .await;
        let fixture = doctor_report_fixture("running", None, None);
        let config = serde_json::json!({
            "name": "spoofed-runner",
            "group": "vm0/test",
            "base_dir": fixture.base_dir.display().to_string(),
            "ca_dir": fixture._dir.path().join("ca").display().to_string(),
            "firecracker": {
                "binary": fixture._dir.path().join("firecracker").display().to_string(),
                "kernel": fixture._dir.path().join("vmlinux").display().to_string(),
            },
            "profiles": {
                "vm0/default": {
                    "rootfs_hash": "rootfs",
                    "snapshot_hash": "snapshot",
                    "vcpu": 1,
                    "memory_mb": 512,
                    "rootfs_disk_mb": 512,
                    "workspace_disk_mb": 1024,
                },
            },
            "server": {
                "url": server.url("/api"),
                "token": "spoofed-token",
            },
        });
        std::fs::write(
            &fixture.config_path,
            serde_yaml_ng::to_string(&config).unwrap(),
        )
        .unwrap();
        let discovered = empty_discovered();

        let reports = build_runner_reports(&[], None, None, &discovered, &[]).await;

        assert!(reports.is_empty());
        api.assert_calls_async(0).await;
    }

    #[tokio::test]
    async fn build_runner_reports_allows_api_cold_starts() {
        let server = MockServer::start_async().await;
        let api = server
            .mock_async(|when, then| {
                when.method("HEAD")
                    .path("/api")
                    .header("authorization", "Bearer test-token");
                then.status(200).delay(Duration::from_secs(6));
            })
            .await;
        let api_url = server.url("/api");
        let fixture = doctor_report_fixture_with_server(
            "running",
            None,
            None,
            Some((&api_url, "test-token")),
        );
        let runner = live_runner_instance(
            std::process::id(),
            fixture.config_path.clone(),
            fixture.base_dir.clone(),
        );
        let client = build_api_client();

        let reports =
            build_runner_reports(&[runner], None, client.as_ref(), &empty_discovered(), &[]).await;

        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].api_ok, Some(true));
        api.assert_calls_async(1).await;
    }

    #[tokio::test]
    async fn build_runner_reports_refills_api_checks_and_preserves_order() {
        let apis = gated_doctor_apis().await;
        let fixtures: Vec<_> = apis
            .iter()
            .enumerate()
            .map(|(index, (server, _))| {
                doctor_report_fixture_with_server(
                    "running",
                    None,
                    None,
                    Some((&server.url(), &format!("token-{index}"))),
                )
            })
            .collect();
        let runners: Vec<_> = fixtures
            .iter()
            .enumerate()
            .map(|(index, fixture)| {
                live_runner_instance(
                    u32::MAX - index as u32,
                    fixture.config_path.clone(),
                    fixture.base_dir.clone(),
                )
            })
            .collect();
        let client = build_api_client();
        let discovered = empty_discovered();

        let (reports, ()) = tokio::join!(
            build_runner_reports(&runners, None, client.as_ref(), &discovered, &[]),
            release_doctor_apis(apis),
        );

        assert_eq!(
            reports
                .iter()
                .map(|report| report.config_path.as_path())
                .collect::<Vec<_>>(),
            fixtures
                .iter()
                .map(|fixture| fixture.config_path.as_path())
                .collect::<Vec<_>>(),
        );
        assert!(reports.iter().all(|report| report.api_ok == Some(true)));
    }

    #[tokio::test]
    async fn build_runner_reports_filters_non_target_config_path_before_api_check() {
        let server = MockServer::start_async().await;
        let target_api = server
            .mock_async(|when, then| {
                when.method("HEAD").path("/target");
                then.status(200);
            })
            .await;
        let other_api = server
            .mock_async(|when, then| {
                when.method("HEAD").path("/other");
                then.status(200);
            })
            .await;
        let target_url = server.url("/target");
        let other_url = server.url("/other");
        let target_fixture = doctor_report_fixture_with_server(
            "running",
            None,
            None,
            Some((&target_url, "target-token")),
        );
        let other_fixture = doctor_report_fixture_with_server(
            "running",
            None,
            None,
            Some((&other_url, "other-token")),
        );
        let runners = vec![
            live_runner_instance(
                u32::MAX - 1,
                other_fixture.config_path.clone(),
                other_fixture.base_dir.clone(),
            ),
            live_runner_instance(
                u32::MAX,
                target_fixture.config_path.clone(),
                target_fixture.base_dir.clone(),
            ),
        ];
        let client = build_api_client();

        let reports = build_runner_reports(
            &runners,
            Some(&target_fixture.config_path),
            client.as_ref(),
            &empty_discovered(),
            &[],
        )
        .await;

        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].config_path, target_fixture.config_path);
        target_api.assert_calls_async(1).await;
        other_api.assert_calls_async(0).await;
    }

    #[tokio::test]
    async fn recheck_current_runner_warnings_refills_api_checks_and_preserves_order() {
        let apis = gated_doctor_apis().await;
        let mut reports: Vec<_> = apis
            .iter()
            .enumerate()
            .map(|(index, (server, _))| {
                let mut report = make_report(&format!("runner-{index}"));
                report.warnings.push(Warning::ApiUnreachable {
                    server_url: server.url(),
                    server_token: format!("token-{index}"),
                });
                report
            })
            .collect();
        let expected_paths: Vec<_> = reports
            .iter()
            .map(|report| report.config_path.clone())
            .collect();
        let client = build_api_client();
        let discovered = empty_discovered();

        tokio::join!(
            recheck_current_runner_warnings(client.as_ref(), &discovered, &mut reports),
            release_doctor_apis(apis),
        );

        assert_eq!(
            reports
                .iter()
                .map(|report| report.config_path.clone())
                .collect::<Vec<_>>(),
            expected_paths,
        );
        assert!(reports.iter().all(|report| report.warnings.is_empty()));
    }

    #[tokio::test]
    async fn report_warns_for_running_without_proxy() {
        let report = build_test_runner_report("running", Some(32821), None, vec![], vec![]).await;
        assert!(
            report
                .warnings
                .iter()
                .any(|w| matches!(w, Warning::NoMitmproxy { port: 32821, .. }))
        );
    }

    #[tokio::test]
    async fn report_warns_stale_proxy_on_stopped_runner() {
        let report = build_test_runner_report(
            "stopped",
            Some(32821),
            None,
            vec![mitm_proc(999, 32821)],
            vec![],
        )
        .await;
        assert!(
            report
                .warnings
                .iter()
                .any(|w| matches!(w, Warning::StaleMitmproxy { port: 32821 }))
        );
    }

    #[tokio::test]
    async fn stale_proxy_recheck_tracks_the_recorded_port_across_pid_exit() {
        let report = build_test_runner_report(
            "stopped",
            Some(32821),
            None,
            vec![mitm_proc(111, 32821), mitm_proc(222, 32821)],
            vec![],
        )
        .await;
        assert_eq!(report.proxy_pid, Some(111));
        let mut reports = [report];
        let replacement_only = process::DiscoveredProcesses {
            firecrackers: vec![],
            mitmdumps: vec![mitm_proc(222, 32821)],
            dnsmasqs: vec![],
        };

        recheck_current_runner_warnings(None, &replacement_only, &mut reports).await;

        assert!(
            reports[0]
                .warnings
                .iter()
                .any(|warning| matches!(warning, Warning::StaleMitmproxy { port: 32821 }))
        );

        let unrelated_only = process::DiscoveredProcesses {
            firecrackers: vec![],
            mitmdumps: vec![mitm_proc(333, 32822)],
            dnsmasqs: vec![],
        };
        recheck_current_runner_warnings(None, &unrelated_only, &mut reports).await;

        assert!(!has_proxy_warning(&reports[0]));
    }

    #[tokio::test]
    async fn report_no_warning_for_stopped_without_proxy() {
        let report = build_test_runner_report("stopped", Some(32821), None, vec![], vec![]).await;
        assert!(!has_proxy_warning(&report));
    }

    #[tokio::test]
    async fn report_no_warning_for_draining_proxy() {
        let without_proxy =
            build_test_runner_report("draining", Some(32821), None, vec![], vec![]).await;
        assert!(!has_proxy_warning(&without_proxy));

        let with_proxy = build_test_runner_report(
            "draining",
            Some(32821),
            None,
            vec![mitm_proc(999, 32821)],
            vec![],
        )
        .await;
        assert!(!has_proxy_warning(&with_proxy));
    }

    #[tokio::test]
    async fn report_no_proxy_or_dns_warning_while_starting() {
        let report =
            build_test_runner_report("starting", Some(32821), Some(5353), vec![], vec![]).await;

        assert!(!has_proxy_warning(&report));
        assert!(!has_dns_warning(&report));
    }

    #[tokio::test]
    async fn report_no_warning_for_running_with_proxy() {
        let report = build_test_runner_report(
            "running",
            Some(32821),
            None,
            vec![mitm_proc(999, 32821)],
            vec![],
        )
        .await;
        assert!(!has_proxy_warning(&report));
    }

    #[tokio::test]
    async fn report_warns_for_running_when_only_unrelated_proxy_exists() {
        let report = build_test_runner_report(
            "running",
            Some(32821),
            None,
            vec![mitm_proc(999, 32822)],
            vec![],
        )
        .await;
        assert!(
            report
                .warnings
                .iter()
                .any(|w| matches!(w, Warning::NoMitmproxy { port: 32821, .. }))
        );
    }

    #[tokio::test]
    async fn report_no_stale_proxy_warning_for_stopped_with_unrelated_proxy() {
        let report = build_test_runner_report(
            "stopped",
            Some(32821),
            None,
            vec![mitm_proc(999, 32822)],
            vec![],
        )
        .await;
        assert!(!has_proxy_warning(&report));
    }

    #[tokio::test]
    async fn report_warns_for_running_without_dnsmasq() {
        let report = build_test_runner_report("running", None, Some(5353), vec![], vec![]).await;
        assert!(
            report
                .warnings
                .iter()
                .any(|w| matches!(w, Warning::NoDnsmasq { port: 5353, .. }))
        );
    }

    #[tokio::test]
    async fn report_no_warning_for_running_with_dnsmasq() {
        let report = build_test_runner_report(
            "running",
            None,
            Some(5353),
            vec![],
            vec![dns_proc(888, 5353)],
        )
        .await;
        assert!(!has_dns_warning(&report));
    }

    #[tokio::test]
    async fn report_warns_for_running_when_only_unrelated_dnsmasq_exists() {
        let report = build_test_runner_report(
            "running",
            None,
            Some(5353),
            vec![],
            vec![dns_proc(888, 5354)],
        )
        .await;
        assert!(
            report
                .warnings
                .iter()
                .any(|w| matches!(w, Warning::NoDnsmasq { port: 5353, .. }))
        );
    }

    #[tokio::test]
    async fn report_warns_for_running_when_dnsmasq_name_only_suffix_matches() {
        let suffix_collision_argv = ["not-dnsmasq", "--port", "5353"]
            .map(str::to_string)
            .to_vec();
        let dns_procs = process::parse_dnsmasq_cmdline(&suffix_collision_argv)
            .map(|port| dns_proc(888, port))
            .into_iter()
            .collect();

        let report = build_test_runner_report("running", None, Some(5353), vec![], dns_procs).await;

        assert!(has_dns_warning(&report));
        assert_eq!(report.dns_pid, None);
    }

    #[test]
    fn is_test_tld_matches_dot_test() {
        assert!(is_test_tld("https://not-a-real-server.test/api"));
        assert!(is_test_tld("https://sub.domain.test"));
        assert!(is_test_tld("https://test"));
        assert!(is_test_tld("https://server.test:8080/api"));
    }

    #[test]
    fn is_test_tld_rejects_substring_match() {
        assert!(!is_test_tld("https://attestation.service.internal/api"));
        assert!(!is_test_tld("https://my.testing.company.com/api"));
        assert!(!is_test_tld("https://contest.example.com"));
    }

    #[test]
    fn is_test_tld_handles_edge_cases() {
        assert!(!is_test_tld("not-a-url"));
        assert!(!is_test_tld("https://example.com/.test"));
        assert!(!is_test_tld("https://example.com?q=.test"));
    }

    #[tokio::test]
    async fn is_lock_free_returns_true_when_file_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no-such-file.lock");
        assert!(super::is_lock_free(&path).await);
    }

    #[tokio::test]
    async fn is_lock_free_returns_true_when_lock_not_held() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("free.lock");
        std::fs::File::create(&path).unwrap();
        assert!(super::is_lock_free(&path).await);
    }

    #[tokio::test]
    async fn is_lock_free_returns_false_when_lock_held() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("held.lock");
        let file = std::fs::File::create(&path).unwrap();
        // Hold an exclusive lock for the duration of the test.
        let _lock = nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock)
            .expect("failed to acquire test lock");
        assert!(!super::is_lock_free(&path).await);
    }
}
