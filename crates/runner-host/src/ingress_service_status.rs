//! Fresh observation of the dedicated Caddy service's kernel process membership.
//! This requires cgroup v2 at the official host's standard mount and system slice.
//! Process membership is not proof of responsive TLS or per-Runner routing.

use std::path::Path;
use std::time::Duration;

const CGROUP_PROCS: &str = "/sys/fs/cgroup/system.slice/okou-runner-caddy.service/cgroup.procs";
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Read current membership without a manager RPC, subprocess or cached PID.
/// Empty, missing, unreadable or timed-out observations fail closed.
pub async fn is_active() -> bool {
    query_active(Path::new(CGROUP_PROCS)).await
}

async fn query_active(cgroup_procs: &Path) -> bool {
    matches!(
        tokio::time::timeout(PROBE_TIMEOUT, tokio::fs::read(cgroup_procs)).await,
        Ok(Ok(pids)) if !pids.is_empty()
    )
}

#[cfg(test)]
mod tests;
