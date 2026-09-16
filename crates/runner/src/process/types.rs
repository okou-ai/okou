use std::path::PathBuf;

/// Process facts read from `/proc/{pid}/stat`.
///
/// Only `pgid` and `starttime` are used as stable process identity; `ppid`
/// is the parent relationship observed at read time.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessStat {
    pub state: char,
    pub ppid: u32,
    pub pgid: u32,
    pub starttime: u64,
}

/// Stable generation of a process observed through procfs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProcfsProcessGeneration {
    pub pgid: u32,
    pub starttime: u64,
}

impl ProcessStat {
    pub(crate) fn procfs_generation(&self) -> ProcfsProcessGeneration {
        ProcfsProcessGeneration {
            pgid: self.pgid,
            starttime: self.starttime,
        }
    }
}

/// Return true when the process stat state still represents a live process.
///
/// `/proc/<pid>/stat` can briefly expose terminal states before the proc entry
/// disappears. Treat those as already exited so callers do not resolve or
/// signal a stale process identity.
pub(crate) fn process_stat_is_live(stat: &ProcessStat) -> bool {
    !matches!(stat.state, 'Z' | 'X' | 'x')
}

/// Info extracted from a firecracker process cmdline.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FirecrackerProcessInfo {
    pub pid: u32,
    pub ppid: Option<u32>,
    /// The sandbox identity, derived from the workspace dir basename
    /// (`/proc/{pid}/cwd` = `{base_dir}/workspaces/{sandbox_id}/`). After
    /// sandbox reuse this is stable across successive run_ids.
    pub sandbox_id: String,
    pub base_dir: Option<PathBuf>,
    pub generation: Option<ProcfsProcessGeneration>,
}

impl FirecrackerProcessInfo {
    pub(crate) fn workspace_identity_incomplete(&self) -> bool {
        self.base_dir.is_none()
    }
}

/// Info extracted from a mitmdump process cmdline.
pub struct MitmproxyProcessInfo {
    pub pid: u32,
    pub ppid: Option<u32>,
    pub port: u16,
    /// Unknown when stat could not verify the cmdline observation's generation.
    pub generation: Option<ProcfsProcessGeneration>,
}

/// Info extracted from a dnsmasq process cmdline.
pub struct DnsmasqProcessInfo {
    pub pid: u32,
    pub port: u16,
}

/// All discovered process info from a single `/proc` scan.
pub struct DiscoveredProcesses {
    pub firecrackers: Vec<FirecrackerProcessInfo>,
    pub mitmdumps: Vec<MitmproxyProcessInfo>,
    pub dnsmasqs: Vec<DnsmasqProcessInfo>,
}

/// Process discovery plus Firecracker cmdline-scan completeness.
pub(crate) struct ProcessDiscovery {
    pub(crate) processes: DiscoveredProcesses,
    /// Whether `/proc` traversal and per-process classification left no
    /// uncertainty that callers must treat as a potentially undiscovered live
    /// Firecracker.
    ///
    /// Missing PIDs, zombie or otherwise terminal Firecrackers, and known
    /// non-Firecracker processes are intentionally ignored. Traversal failures,
    /// unreadable or unparseable live Firecracker cmdlines, and unavailable or
    /// malformed stat facts that cannot rule one out make this false. This is
    /// not a completeness guarantee for arbitrary process argvs.
    pub(crate) proc_scan_complete: bool,
}
