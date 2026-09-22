use std::path::PathBuf;

use runner_host::process::{DiscoveredProcesses, FirecrackerProcessInfo, ProcfsProcessGeneration};

use super::target::KillTarget;

pub(super) fn make_fc(pid: u32, sandbox_id: &str) -> FirecrackerProcessInfo {
    FirecrackerProcessInfo {
        pid,
        ppid: None,
        sandbox_id: sandbox_id.into(),
        base_dir: Some(PathBuf::from("/data/r1")),
        generation: None,
    }
}

pub(super) fn make_target(pid: u32, sandbox_id: &str) -> KillTarget {
    KillTarget {
        pid,
        ppid: None,
        run_id: None,
        sandbox_id: sandbox_id.into(),
        base_dir: Some(PathBuf::from("/data/r1")),
        generation: Some(ProcfsProcessGeneration {
            pgid: pid + 1000,
            starttime: 123456,
        }),
    }
}

pub(super) fn make_fc_from_target(target: &KillTarget) -> FirecrackerProcessInfo {
    FirecrackerProcessInfo {
        pid: target.pid,
        ppid: target.ppid,
        sandbox_id: target.sandbox_id.clone(),
        base_dir: target.base_dir.clone(),
        generation: target.generation,
    }
}

pub(super) fn discovered_with_firecrackers(
    firecrackers: Vec<FirecrackerProcessInfo>,
) -> DiscoveredProcesses {
    DiscoveredProcesses {
        firecrackers,
        mitmdumps: vec![],
        dnsmasqs: vec![],
    }
}
