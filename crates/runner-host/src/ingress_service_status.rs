//! Fresh observation of the dedicated Caddy service's kernel process membership.
//! This requires cgroup v2 at the official host's standard mount and system slice.
//! Process membership is not proof of responsive TLS or per-Runner routing.

use std::num::NonZeroU32;
use std::path::Path;
use std::time::Duration;

const CGROUP_PROCS: &str = "/sys/fs/cgroup/system.slice/okou-runner-caddy.service/cgroup.procs";
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Read current membership without a manager RPC, subprocess or cached PID.
/// Empty, missing, unreadable, invalid or timed-out observations fail closed.
pub async fn is_active() -> bool {
    query_active(Path::new(CGROUP_PROCS)).await
}

async fn query_active(cgroup_procs: &Path) -> bool {
    let Ok(Ok(pids)) =
        tokio::time::timeout(PROBE_TIMEOUT, tokio::fs::read_to_string(cgroup_procs)).await
    else {
        return false;
    };
    let mut active = false;
    for pid in pids.lines() {
        if pid.parse::<NonZeroU32>().is_err() {
            return false;
        }
        active = true;
    }
    active
}

#[cfg(test)]
mod tests;
