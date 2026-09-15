use std::future::Future;
use std::path::{Path, PathBuf};

use super::procfs::{
    ProcessStatRead, read_cmdline, read_cwd, read_ppid_from, read_process_stat_checked_from,
    scan_proc_cmdlines,
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
pub(crate) fn is_firecracker_cmdline(argv: &[String]) -> bool {
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
pub(crate) fn parse_dnsmasq_cmdline(argv: &[String]) -> Option<u16> {
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
pub(crate) fn parse_workspace_cwd(cwd: &Path) -> Option<(String, PathBuf)> {
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
pub(crate) async fn discover_all_with_status() -> ProcessDiscovery {
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
        if let Some(port) = parse_mitmdump_cmdline(argv) {
            mitmdumps.push((*pid, port));
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

    // Resolve ppid for mitmdump processes
    let mut mitm_infos = Vec::with_capacity(mitmdumps.len());
    for (pid, port) in mitmdumps {
        let ppid = read_ppid_from(proc_root, pid).await;
        mitm_infos.push(MitmproxyProcessInfo { pid, ppid, port });
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
mod tests {
    use super::*;
    use test_support::{FIRECRACKER_PID, ProcfsFixture, StatFault, UNCERTAIN_STAT_FAULTS};

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| (*s).to_string()).collect()
    }

    fn stat(state: char, pgid: u32, starttime: u64) -> ProcessStat {
        stat_with_ppid(state, 7, pgid, starttime)
    }

    fn stat_with_ppid(state: char, ppid: u32, pgid: u32, starttime: u64) -> ProcessStat {
        ProcessStat {
            state,
            ppid,
            pgid,
            starttime,
        }
    }

    #[tokio::test]
    async fn discovery_preserves_candidates_after_stat_faults_at_each_identity_read() {
        for fault in UNCERTAIN_STAT_FAULTS {
            // Two stat reads bracket each of the initial and final cmdline checks.
            for successful_reads in 0..4 {
                let fixture = ProcfsFixture::new(Path::new("/data/runner/workspaces/sandbox-a"));
                let discovered = fixture
                    .discover_with_stat_fault(successful_reads, fault)
                    .await;

                assert!(discovered.proc_scan_complete);
                assert_eq!(
                    discovered.processes.firecrackers,
                    vec![FirecrackerProcessInfo {
                        pid: FIRECRACKER_PID,
                        ppid: None,
                        sandbox_id: format!("pid-{FIRECRACKER_PID}"),
                        base_dir: None,
                        generation: None,
                    }],
                    "{fault:?} after {successful_reads} successful stat reads"
                );
            }
        }
    }

    #[tokio::test]
    async fn discovery_resolves_a_stable_workspace() {
        let fixture = ProcfsFixture::new(Path::new("/data/runner/workspaces/sandbox-a"));
        let discovered = fixture.discover().await;

        assert!(discovered.proc_scan_complete);
        assert_eq!(discovered.processes.firecrackers.len(), 1);
        let info = &discovered.processes.firecrackers[0];
        assert_eq!(info.pid, FIRECRACKER_PID);
        assert_eq!(info.ppid, Some(1));
        assert_eq!(info.sandbox_id, "sandbox-a");
        assert_eq!(info.base_dir.as_deref(), Some(Path::new("/data/runner")));
        assert_eq!(
            info.generation,
            Some(stat('S', 42, 123456).procfs_generation())
        );
    }

    #[tokio::test]
    async fn discovery_excludes_candidates_after_conclusive_observations() {
        for (fault, read_positions) in [
            (StatFault::Missing, &[0, 1, 2, 3][..]),
            (StatFault::Terminal('Z'), &[0, 1, 2, 3][..]),
            (StatFault::Terminal('X'), &[0, 1, 2, 3][..]),
            (StatFault::Terminal('x'), &[0, 1, 2, 3][..]),
            // Change argv before each cmdline observation, not after it.
            (StatFault::NonFirecracker, &[0, 2][..]),
        ] {
            for &successful_reads in read_positions {
                let fixture = ProcfsFixture::new(Path::new("/data/runner/workspaces/sandbox-a"));
                let discovered = fixture
                    .discover_with_stat_fault(successful_reads, fault)
                    .await;

                assert!(discovered.proc_scan_complete);
                assert!(
                    discovered.processes.firecrackers.is_empty(),
                    "{fault:?} after {successful_reads} successful stat reads"
                );
            }
        }
    }

    #[tokio::test]
    async fn discovery_preserves_a_candidate_when_stat_recovers_during_resolution() {
        for failed_read in 1..=4 {
            let fixture = ProcfsFixture::new(Path::new("/data/runner/workspaces/sandbox-a"));
            let mut reads = 0;
            let proc_root = fixture.root();
            let discovered = discover_all_with_status_from(proc_root, |pid| {
                reads += 1;
                let fail = reads == failed_read;
                async move {
                    if fail {
                        ProcessStatRead::Unreadable(std::io::Error::from_raw_os_error(libc::EMFILE))
                    } else {
                        read_process_stat_checked_from(proc_root, pid).await
                    }
                }
            })
            .await;

            assert!(discovered.proc_scan_complete);
            assert_eq!(
                discovered.processes.firecrackers,
                vec![FirecrackerProcessInfo {
                    pid: FIRECRACKER_PID,
                    ppid: Some(1),
                    sandbox_id: format!("pid-{FIRECRACKER_PID}"),
                    base_dir: None,
                    generation: None,
                }]
            );
        }
    }

    #[test]
    fn is_firecracker_bare_name() {
        assert!(is_firecracker_cmdline(&argv(&[
            "firecracker",
            "--api-sock",
            "/run/vm0/sock/abc/api.sock",
        ])));
    }

    #[test]
    fn is_firecracker_full_path() {
        assert!(is_firecracker_cmdline(&argv(&[
            "/var/lib/vm0-runner/firecracker/v1.10.1/firecracker",
            "--no-api",
        ])));
    }

    #[test]
    fn is_firecracker_not_runner() {
        assert!(!is_firecracker_cmdline(&argv(&[
            "runner",
            "start",
            "--config",
            "/data/config.yaml",
        ])));
    }

    #[test]
    fn is_firecracker_empty() {
        assert!(!is_firecracker_cmdline(&[]));
    }

    #[test]
    fn firecracker_process_exists_for_sandbox_id_matches_exact_id() {
        let processes = vec![FirecrackerProcessInfo {
            pid: 42,
            ppid: Some(1),
            sandbox_id: "sandbox-a".to_string(),
            base_dir: None,
            generation: None,
        }];

        assert!(firecracker_process_exists_for_sandbox_id(
            &processes,
            "sandbox-a"
        ));
        assert!(!firecracker_process_exists_for_sandbox_id(
            &processes, "sandbox"
        ));
    }

    #[test]
    fn parse_mitmdump_listen_port() {
        let a = argv(&[
            "mitmdump",
            "--mode",
            "transparent",
            "--listen-port",
            "8080",
            "--set",
            "okou_proxy_registry_path=/data/runner-01/proxy-registry.json",
        ]);
        assert_eq!(parse_mitmdump_cmdline(&a), Some(8080));
    }

    #[test]
    fn parse_mitmdump_registry_path_with_spaces() {
        // Regression for #10479.
        let a = argv(&[
            "mitmdump",
            "--listen-port",
            "8080",
            "--set",
            "okou_proxy_registry_path=/data/my runner/proxy-registry.json",
        ]);
        assert_eq!(parse_mitmdump_cmdline(&a), Some(8080));
    }

    #[test]
    fn parse_mitmdump_no_registry_returns_none() {
        let a = argv(&["mitmdump", "--mode", "transparent", "--listen-port", "8080"]);
        assert!(parse_mitmdump_cmdline(&a).is_none());
    }

    #[test]
    fn parse_mitmdump_no_listen_port_returns_none() {
        let a = argv(&[
            "mitmdump",
            "--set",
            "okou_proxy_registry_path=/data/proxy-registry.json",
        ]);
        assert!(parse_mitmdump_cmdline(&a).is_none());
    }

    #[test]
    fn parse_dnsmasq_cmdline_matches_exact_basename_and_port() {
        let cases: &[(&str, &[&str], Option<u16>)] = &[
            (
                "bare executable",
                &[
                    "dnsmasq",
                    "--no-daemon",
                    "--no-resolv",
                    "--port",
                    "5353",
                    "--server",
                    "8.8.8.8",
                ],
                Some(5353),
            ),
            (
                "full executable path",
                &["/usr/sbin/dnsmasq", "--port", "5354"],
                Some(5354),
            ),
            ("empty argv", &[], None),
            (
                "unrelated executable",
                &["mitmdump", "--port", "5353"],
                None,
            ),
            ("missing port", &["dnsmasq", "--no-daemon"], None),
            ("invalid port", &["dnsmasq", "--port", "invalid"], None),
            ("out-of-range port", &["dnsmasq", "--port", "65536"], None),
            (
                "executable name prefix collision",
                &["dnsmasq-wrapper", "--port", "5353"],
                None,
            ),
            (
                "executable name suffix collision",
                &["not-dnsmasq", "--port", "5353"],
                None,
            ),
            (
                "full-path basename suffix collision",
                &["/tmp/notdnsmasq", "--port", "5353"],
                None,
            ),
        ];

        for (name, parts, expected) in cases {
            assert_eq!(parse_dnsmasq_cmdline(&argv(parts)), *expected, "{name}");
        }
    }

    #[test]
    fn parse_workspace_cwd_valid() {
        let cwd = Path::new("/data/runner-01/workspaces/550e8400");
        let (sandbox_id, base_dir) = parse_workspace_cwd(cwd).unwrap();
        assert_eq!(sandbox_id, "550e8400");
        assert_eq!(base_dir, Path::new("/data/runner-01"));
    }

    #[test]
    fn parse_workspace_cwd_uuid() {
        let cwd = Path::new("/data/r1/workspaces/550e8400-e29b-41d4-a716-446655440000");
        let (sandbox_id, base_dir) = parse_workspace_cwd(cwd).unwrap();
        assert_eq!(sandbox_id, "550e8400-e29b-41d4-a716-446655440000");
        assert_eq!(base_dir, Path::new("/data/r1"));
    }

    #[test]
    fn parse_workspace_cwd_non_workspace() {
        assert!(parse_workspace_cwd(Path::new("/tmp/something")).is_none());
    }

    #[test]
    fn procfs_generation_uses_pgid_and_starttime() {
        let sleeping = stat('S', 1100, 123456);
        let running = stat('R', 1100, 123456);
        let different_group = stat('S', 2200, 123456);
        let different_start = stat('S', 1100, 654321);
        let different_parent = stat_with_ppid('S', 9, 1100, 123456);

        assert_eq!(sleeping.procfs_generation(), running.procfs_generation());
        assert_eq!(
            sleeping.procfs_generation(),
            different_parent.procfs_generation()
        );
        assert_ne!(
            sleeping.procfs_generation(),
            different_group.procfs_generation()
        );
        assert_ne!(
            sleeping.procfs_generation(),
            different_start.procfs_generation()
        );
    }

    #[test]
    fn firecracker_resolution_known_workspace_builds_identified_process() {
        let process_stat = stat('R', 1100, 123456);
        let base_dir = PathBuf::from("/data/runner-01");
        let resolution = stable_firecracker_resolution(
            42,
            Some(("sandbox-a".to_string(), base_dir.clone())),
            stat('S', 1100, 123456),
            process_stat.clone(),
        );

        assert_eq!(
            resolution,
            FirecrackerCandidateResolution::StableKnownWorkspace {
                pid: 42,
                ppid: Some(7),
                process_stat: process_stat.clone(),
                sandbox_id: "sandbox-a".to_string(),
                base_dir: base_dir.clone(),
            }
        );

        let info = resolution.into_process_info().unwrap();
        assert_eq!(info.pid, 42);
        assert_eq!(info.ppid, Some(7));
        assert_eq!(info.sandbox_id, "sandbox-a");
        assert_eq!(info.base_dir, Some(base_dir.clone()));
        assert_eq!(info.generation, Some(process_stat.procfs_generation()));
    }

    #[test]
    fn firecracker_resolution_unknown_workspace_keeps_stable_process_identity() {
        let process_stat = stat('R', 1100, 123456);
        let resolution =
            stable_firecracker_resolution(42, None, stat('S', 1100, 123456), process_stat.clone());

        assert_eq!(
            resolution,
            FirecrackerCandidateResolution::StableUnknownWorkspace {
                pid: 42,
                ppid: Some(7),
                process_stat: process_stat.clone(),
            }
        );

        let info = resolution.into_process_info().unwrap();
        assert_eq!(info.pid, 42);
        assert_eq!(info.ppid, Some(7));
        assert_eq!(info.sandbox_id, "pid-42");
        assert_eq!(info.base_dir, None);
        assert_eq!(info.generation, Some(process_stat.procfs_generation()));
        assert!(info.workspace_identity_incomplete());
    }

    #[test]
    fn firecracker_resolution_identity_drift_becomes_unidentified() {
        let resolution = stable_firecracker_resolution(
            42,
            Some(("sandbox-a".to_string(), PathBuf::from("/data/runner-01"))),
            stat('S', 1100, 123456),
            stat('R', 2200, 123456),
        );

        assert_eq!(
            resolution,
            FirecrackerCandidateResolution::UnidentifiedLive {
                pid: 42,
                ppid: Some(7),
            }
        );

        let info = resolution.into_process_info().unwrap();
        assert_eq!(info.pid, 42);
        assert_eq!(info.ppid, Some(7));
        assert_eq!(info.sandbox_id, "pid-42");
        assert_eq!(info.base_dir, None);
        assert_eq!(info.generation, None);
        assert!(info.workspace_identity_incomplete());
    }

    #[test]
    fn firecracker_resolution_rejects_dead_process_states() {
        let resolution = stable_firecracker_resolution(
            42,
            Some(("sandbox-a".to_string(), PathBuf::from("/data/runner-01"))),
            stat('Z', 1100, 123456),
            stat('R', 1100, 123456),
        );

        assert_eq!(resolution, FirecrackerCandidateResolution::NotPresent);
        assert_eq!(resolution.into_process_info(), None);
    }

    #[test]
    fn stable_live_firecracker_stat_accepts_live_stable_firecracker() {
        let before = stat('S', 1100, 123456);
        let after = stat('R', 1100, 123456);

        assert_eq!(
            stable_live_firecracker_stat(&before, &argv(&["firecracker"]), after.clone()),
            Some(after)
        );
    }

    #[test]
    fn stable_live_firecracker_stat_rejects_zombie_firecracker() {
        let before = stat('Z', 1100, 123456);
        let after = stat('Z', 1100, 123456);

        assert_eq!(
            stable_live_firecracker_stat(&before, &argv(&["firecracker"]), after),
            None
        );
    }

    #[test]
    fn stable_live_firecracker_stat_rejects_dead_firecracker() {
        let before = stat('X', 1100, 123456);
        let after = stat('x', 1100, 123456);

        assert_eq!(
            stable_live_firecracker_stat(&before, &argv(&["firecracker"]), after),
            None
        );
    }

    #[test]
    fn stable_live_firecracker_stat_rejects_exit_during_read() {
        let before = stat('S', 1100, 123456);
        let after = stat('Z', 1100, 123456);

        assert_eq!(
            stable_live_firecracker_stat(&before, &argv(&["firecracker"]), after),
            None
        );
    }

    #[test]
    fn unidentified_firecracker_candidate_keeps_uncertain_live_processes() {
        let stat = stat('S', 1100, 123456);

        assert!(should_keep_unidentified_firecracker_candidate(&stat, None));
        assert!(should_keep_unidentified_firecracker_candidate(
            &stat,
            Some(&argv(&["firecracker"]))
        ));
    }

    #[test]
    fn unidentified_firecracker_candidate_rejects_known_non_firecracker() {
        let stat = stat('S', 1100, 123456);

        assert!(!should_keep_unidentified_firecracker_candidate(
            &stat,
            Some(&argv(&["bash"]))
        ));
    }

    #[test]
    fn unidentified_firecracker_candidate_rejects_zombie_processes() {
        let stat = stat('Z', 1100, 123456);

        assert!(!should_keep_unidentified_firecracker_candidate(&stat, None));
        assert!(!should_keep_unidentified_firecracker_candidate(
            &stat,
            Some(&argv(&["firecracker"]))
        ));
    }

    #[test]
    fn unidentified_firecracker_candidate_rejects_dead_processes() {
        let stat = stat('X', 1100, 123456);

        assert!(!should_keep_unidentified_firecracker_candidate(&stat, None));
        assert!(!should_keep_unidentified_firecracker_candidate(
            &stat,
            Some(&argv(&["firecracker"]))
        ));
    }
}
