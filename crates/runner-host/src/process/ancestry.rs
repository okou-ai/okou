use super::procfs::read_ppid;

const PPID_CHAIN_MAX_DEPTH: usize = 16;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PpidChainWalk {
    FoundTarget,
    ReachedBoundary,
    Unreadable,
    MaxDepth,
}

async fn walk_ppid_chain<F, Fut>(
    pid: u32,
    target_pids: &[u32],
    mut read_parent_pid: F,
) -> PpidChainWalk
where
    F: FnMut(u32) -> Fut,
    Fut: std::future::Future<Output = Option<u32>>,
{
    let mut current = pid;
    for _ in 0..PPID_CHAIN_MAX_DEPTH {
        let Some(ppid) = read_parent_pid(current).await else {
            return PpidChainWalk::Unreadable;
        };
        if target_pids.contains(&ppid) {
            return PpidChainWalk::FoundTarget;
        }
        if ppid <= 1 {
            return PpidChainWalk::ReachedBoundary;
        }
        current = ppid;
    }
    PpidChainWalk::MaxDepth
}

fn process_has_ancestor_from_walk(walk: PpidChainWalk) -> Option<bool> {
    match walk {
        PpidChainWalk::FoundTarget => Some(true),
        PpidChainWalk::ReachedBoundary => Some(false),
        PpidChainWalk::Unreadable | PpidChainWalk::MaxDepth => None,
    }
}

/// Walk the ppid chain from `pid` upward to determine whether it descends from
/// one of `ancestor_pids`.
///
/// Reads at most 16 parent entries. Returns `Some(true)` when an ancestor is
/// found and `Some(false)` when the walk reaches PID 1 or PPID 0 without a
/// match. Returns `None` when the chain cannot be read or the depth limit is
/// exhausted before either conclusive outcome.
pub async fn process_has_ancestor(pid: u32, ancestor_pids: &[u32]) -> Option<bool> {
    process_has_ancestor_from_walk(walk_ppid_chain(pid, ancestor_pids, read_ppid).await)
}

fn is_orphan_from_walk(walk: PpidChainWalk) -> bool {
    match walk {
        PpidChainWalk::FoundTarget | PpidChainWalk::Unreadable | PpidChainWalk::MaxDepth => false,
        PpidChainWalk::ReachedBoundary => true,
    }
}

/// Walk the ppid chain from `pid` upward to determine if it's an orphan.
///
/// Firecracker is not a direct child of the runner — the spawn chain is
/// `runner → sudo → ip netns exec → sudo -u → firecracker`, so checking
/// only the immediate ppid is insufficient. This function walks up the
/// process tree until it either finds a runner PID (not orphan) or reaches
/// PID 1 / init or the PPID 0 boundary (orphan), reading at most 16 parent
/// entries.
///
/// Returns `false` (not orphan) when the ppid chain cannot be read or the
/// depth limit is exhausted, to avoid false positives. Returns `true` only
/// after reaching the process-tree boundary without finding a runner PID.
pub async fn is_orphan(pid: u32, runner_pids: &[u32]) -> bool {
    is_orphan_from_walk(walk_ppid_chain(pid, runner_pids, read_ppid).await)
}

#[cfg(test)]
mod tests;
