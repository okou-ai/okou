use std::future::Future;
use std::path::{Path, PathBuf};

use super::procfs::{
    ProcessStatRead, read_cmdline, read_cwd, read_process_stat_checked_from, scan_proc_cmdlines,
};
use super::types::{
    DiscoveredProcesses, DnsmasqProcessInfo, FirecrackerProcessInfo, MitmproxyProcessInfo,
    ProcessDiscovery, ProcessStat, process_stat_is_live,
};

/// Check if an argv belongs to a firecracker process.
///
/// Looks at the binary name (`argv[0]`) — the run ID and base directory
/// are resolved from `/proc/{pid}/cwd` instead of argument parsing,
/// since our sandbox always sets `current_dir` to the workspace.
pub fn is_firecracker_cmdline(argv: &[String]) -> bool {
    let Some(binary) = argv.first() else {
        return false;
    };
    Path::new(binary).file_name().and_then(|n| n.to_str()) == Some("firecracker")
}

/// Parse a mitmdump argv for the listen port.
///
/// Identifies our mitmdump by `okou_proxy_registry_path=` and extracts
/// the `--listen-port` value.
fn parse_mitmdump_cmdline(argv: &[String]) -> Option<u16> {
    if !argv
        .iter()
        .any(|t| t.starts_with("okou_proxy_registry_path="))
    {
        return None;
    }
    let pos = argv.iter().position(|t| t == "--listen-port")?;
    argv.get(pos + 1)?.parse().ok()
}

/// Parse a dnsmasq argv for the listen port.
///
/// Identifies dnsmasq by binary name and extracts the `--port` value.
pub fn parse_dnsmasq_cmdline(argv: &[String]) -> Option<u16> {
    let binary = argv.first()?;
    if Path::new(binary).file_name().and_then(|name| name.to_str()) != Some("dnsmasq") {
        return None;
    }
    let pos = argv.iter().position(|t| t == "--port")?;
    argv.get(pos + 1)?.parse().ok()
}

/// Extract sandbox_id and base_dir from a firecracker workspace CWD.
///
/// CWD is `{base_dir}/workspaces/{sandbox_id}/`, so:
/// - `sandbox_id` is the last component
/// - `base_dir` is the grandparent of `workspaces`
pub fn parse_workspace_cwd(cwd: &Path) -> Option<(String, PathBuf)> {
    let sandbox_id = cwd.file_name()?.to_string_lossy().into_owned();
    let workspaces_dir = cwd.parent()?;
    if workspaces_dir.file_name().and_then(|n| n.to_str()) == Some("workspaces") {
        let base_dir = workspaces_dir.parent()?.to_path_buf();
        Some((sandbox_id, base_dir))
    } else {
        None
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum FirecrackerCandidateResolution {
    StableKnownWorkspace {
        pid: u32,
        ppid: Option<u32>,
        process_stat: ProcessStat,
        sandbox_id: String,
        base_dir: PathBuf,
    },
    StableUnknownWorkspace {
        pid: u32,
        ppid: Option<u32>,
        process_stat: ProcessStat,
    },
    // A candidate that may still be live, without a verified workspace or generation.
    UnidentifiedLive {
        pid: u32,
        ppid: Option<u32>,
    },
    NotPresent,
}

impl FirecrackerCandidateResolution {
    fn into_process_info(self) -> Option<FirecrackerProcessInfo> {
        match self {
            Self::StableKnownWorkspace {
                pid,
                ppid,
                process_stat,
                sandbox_id,
                base_dir,
            } => Some(FirecrackerProcessInfo {
                pid,
                ppid,
                sandbox_id,
                base_dir: Some(base_dir),
                generation: Some(process_stat.procfs_generation()),
            }),
            Self::StableUnknownWorkspace {
                pid,
                ppid,
                process_stat,
            } => {
                let sandbox_id = fallback_sandbox_id(pid);
                Some(FirecrackerProcessInfo {
                    pid,
                    ppid,
                    sandbox_id,
                    base_dir: None,
                    generation: Some(process_stat.procfs_generation()),
                })
            }
            Self::UnidentifiedLive { pid, ppid } => {
                Some(unidentified_firecracker_process(pid, ppid))
            }
            Self::NotPresent => None,
        }
    }
}

fn fallback_sandbox_id(pid: u32) -> String {
    format!("pid-{pid}")
}

async fn read_stable_firecracker_stat<Fut>(
    proc_root: &Path,
    pid: u32,
    read_stat: &mut impl FnMut(u32) -> Fut,
) -> Option<ProcessStat>
where
    Fut: Future<Output = ProcessStatRead>,
{
    let ProcessStatRead::Found(before) = read_stat(pid).await else {
        return None;
    };
    let argv = read_cmdline(proc_root, pid).await?;
    let ProcessStatRead::Found(after) = read_stat(pid).await else {
        return None;
    };
    stable_live_firecracker_stat(&before, &argv, after)
}

fn stable_live_firecracker_stat(
    before: &ProcessStat,
    argv: &[String],
    after: ProcessStat,
) -> Option<ProcessStat> {
    if process_stat_is_live(before)
        && process_stat_is_live(&after)
        && before.procfs_generation() == after.procfs_generation()
        && is_firecracker_cmdline(argv)
    {
        Some(after)
    } else {
        None
    }
}

fn should_keep_unidentified_firecracker_candidate(
    stat: &ProcessStat,
    argv: Option<&[String]>,
) -> bool {
    if !process_stat_is_live(stat) {
        return false;
    }
    match argv {
        Some(argv) => is_firecracker_cmdline(argv),
        None => true,
    }
}

fn unidentified_firecracker_process(pid: u32, ppid: Option<u32>) -> FirecrackerProcessInfo {
    FirecrackerProcessInfo {
        pid,
        ppid,
        sandbox_id: fallback_sandbox_id(pid),
        base_dir: None,
        generation: None,
    }
}

async fn unresolved_firecracker_resolution_if_present<Fut>(
    proc_root: &Path,
    pid: u32,
    read_stat: &mut impl FnMut(u32) -> Fut,
) -> FirecrackerCandidateResolution
where
    Fut: Future<Output = ProcessStatRead>,
{
    let stat = match read_stat(pid).await {
        ProcessStatRead::Found(stat) => stat,
        ProcessStatRead::Missing => return FirecrackerCandidateResolution::NotPresent,
        ProcessStatRead::Unreadable(_) | ProcessStatRead::Invalid => {
            // The cmdline scan identified this candidate. A failed stat read
            // cannot prove it exited or safely attribute its workspace.
            return FirecrackerCandidateResolution::UnidentifiedLive { pid, ppid: None };
        }
    };
    let argv = read_cmdline(proc_root, pid).await;
    if should_keep_unidentified_firecracker_candidate(&stat, argv.as_deref()) {
        FirecrackerCandidateResolution::UnidentifiedLive {
            pid,
            ppid: Some(stat.ppid),
        }
    } else {
        FirecrackerCandidateResolution::NotPresent
    }
}

fn stable_firecracker_resolution(
    pid: u32,
    cwd_info: Option<(String, PathBuf)>,
    initial_stat: ProcessStat,
    process_stat: ProcessStat,
) -> FirecrackerCandidateResolution {
    if !process_stat_is_live(&initial_stat) || !process_stat_is_live(&process_stat) {
        return FirecrackerCandidateResolution::NotPresent;
    }
    if initial_stat.procfs_generation() != process_stat.procfs_generation() {
        let ppid = Some(process_stat.ppid);
        return FirecrackerCandidateResolution::UnidentifiedLive { pid, ppid };
    }
    let ppid = Some(process_stat.ppid);
    match cwd_info {
        Some((sandbox_id, base_dir)) => FirecrackerCandidateResolution::StableKnownWorkspace {
            pid,
            ppid,
            process_stat,
            sandbox_id,
            base_dir,
        },
        None => FirecrackerCandidateResolution::StableUnknownWorkspace {
            pid,
            ppid,
            process_stat,
        },
    }
}

async fn resolve_firecracker_candidate<Fut>(
    proc_root: &Path,
    pid: u32,
    read_stat: &mut impl FnMut(u32) -> Fut,
) -> FirecrackerCandidateResolution
where
    Fut: Future<Output = ProcessStatRead>,
{
    let Some(initial_stat) = read_stable_firecracker_stat(proc_root, pid, read_stat).await else {
        return unresolved_firecracker_resolution_if_present(proc_root, pid, read_stat).await;
    };
    let cwd_info = read_cwd(proc_root, pid)
        .await
        .and_then(|cwd| parse_workspace_cwd(&cwd));
    let Some(process_stat) = read_stable_firecracker_stat(proc_root, pid, read_stat).await else {
        return unresolved_firecracker_resolution_if_present(proc_root, pid, read_stat).await;
    };
    stable_firecracker_resolution(pid, cwd_info, initial_stat, process_stat)
}

async fn resolve_mitmdump_candidate<Fut>(
    proc_root: &Path,
    pid: u32,
    read_stat: &mut impl FnMut(u32) -> Fut,
) -> Option<MitmproxyProcessInfo>
where
    Fut: Future<Output = ProcessStatRead>,
{
    // The scan's argv may already belong to an exited process. Bracket a new
    // cmdline read so a reused PID cannot lend its generation to the old port.
    let before = read_stat(pid).await;
    let port = parse_mitmdump_cmdline(&read_cmdline(proc_root, pid).await?)?;
    let after = read_stat(pid).await;
    for observation in [&before, &after] {
        match observation {
            ProcessStatRead::Missing => return None,
            ProcessStatRead::Found(stat) if !process_stat_is_live(stat) => return None,
            _ => {}
        }
    }
    let generation = match (&before, &after) {
        (ProcessStatRead::Found(before), ProcessStatRead::Found(after)) => {
            if before.procfs_generation() != after.procfs_generation() {
                return None;
            }
            Some(after.procfs_generation())
        }
        // A cmdline still establishes port presence when stat is unreadable,
        // but cannot establish identity for a persistent orphan warning.
        _ => None,
    };
    let ppid = match after {
        ProcessStatRead::Found(stat) => Some(stat.ppid),
        _ => None,
    };
    Some(MitmproxyProcessInfo {
        pid,
        ppid,
        port,
        generation,
    })
}

/// Scan `/proc` once for sandbox child process facts.
///
/// Live runner identity is published by `live_runner_instances`; this scan
/// intentionally does not infer runner identity from argv.
pub async fn discover_all() -> DiscoveredProcesses {
    discover_all_with_status().await.processes
}

/// Scan `/proc` once and report Firecracker discovery uncertainty.
///
/// `proc_scan_complete` is false when `/proc` traversal fails, when an
/// unreadable or unparseable cmdline belongs to a live Firecracker, or when
/// unavailable or malformed stat facts cannot rule one out. Missing PIDs,
/// zombie or otherwise terminal Firecrackers, and known non-Firecracker
/// processes do not make it false. Destructive cleanup code should use this
/// variant so it can fail closed; the status is not generic argv completeness
/// for every process.
/// Candidates whose identity cannot be verified after the cmdline scan remain
/// in the result with an unknown workspace and generation. Cleanup must also
/// account for these retained candidates when `proc_scan_complete` is true.
pub async fn discover_all_with_status() -> ProcessDiscovery {
    let proc_root = Path::new("/proc");
    discover_all_with_status_from(proc_root, |pid| {
        read_process_stat_checked_from(proc_root, pid)
    })
    .await
}

async fn discover_all_with_status_from<Fut>(
    proc_root: &Path,
    mut read_stat: impl FnMut(u32) -> Fut,
) -> ProcessDiscovery
where
    Fut: Future<Output = ProcessStatRead>,
{
    let proc_scan = scan_proc_cmdlines(proc_root).await;

    let mut firecrackers = Vec::new();
    let mut mitmdumps = Vec::new();
    let mut dnsmasqs = Vec::new();

    for (pid, argv) in &proc_scan.entries {
        if is_firecracker_cmdline(argv) {
            firecrackers.push(*pid);
        }
        if parse_mitmdump_cmdline(argv).is_some() {
            mitmdumps.push(*pid);
        }
        if let Some(port) = parse_dnsmasq_cmdline(argv) {
            dnsmasqs.push(DnsmasqProcessInfo { pid: *pid, port });
        }
    }

    // Resolve sandbox_id + base_dir + ppid from CWD for firecracker processes
    let mut fc_infos = Vec::with_capacity(firecrackers.len());
    for pid in firecrackers {
        if let Some(info) = resolve_firecracker_candidate(proc_root, pid, &mut read_stat)
            .await
            .into_process_info()
        {
            fc_infos.push(info);
        }
    }

    // Resolve the current port, ppid, and generation for mitmdump processes.
    let mut mitm_infos = Vec::with_capacity(mitmdumps.len());
    for pid in mitmdumps {
        if let Some(info) = resolve_mitmdump_candidate(proc_root, pid, &mut read_stat).await {
            mitm_infos.push(info);
        }
    }

    ProcessDiscovery {
        processes: DiscoveredProcesses {
            firecrackers: fc_infos,
            mitmdumps: mitm_infos,
            dnsmasqs,
        },
        proc_scan_complete: proc_scan.complete,
    }
}

/// Return true when the discovered Firecracker list contains `sandbox_id`.
pub fn firecracker_process_exists_for_sandbox_id(
    firecrackers: &[FirecrackerProcessInfo],
    sandbox_id: &str,
) -> bool {
    firecrackers
        .iter()
        .any(|process| process.sandbox_id == sandbox_id)
}

#[cfg(test)]
pub(crate) mod test_support;

#[cfg(test)]
mod tests;
