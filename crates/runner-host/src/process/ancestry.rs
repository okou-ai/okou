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
mod tests {
    use super::*;

    async fn walk_test_ppid_chain(
        pid: u32,
        target_pids: &[u32],
        ppid_chain: &[(u32, Option<u32>)],
    ) -> PpidChainWalk {
        walk_ppid_chain(pid, target_pids, |current| {
            std::future::ready(
                ppid_chain
                    .iter()
                    .find(|(candidate, _)| *candidate == current)
                    .and_then(|(_, ppid)| *ppid),
            )
        })
        .await
    }

    #[tokio::test]
    async fn ppid_chain_empty_targets_reaches_init() {
        let walk = walk_test_ppid_chain(10, &[], &[(10, Some(9)), (9, Some(1))]).await;

        assert_eq!(walk, PpidChainWalk::ReachedBoundary);
        assert_eq!(process_has_ancestor_from_walk(walk), Some(false));
        assert!(is_orphan_from_walk(walk));
    }

    #[tokio::test]
    async fn ppid_chain_empty_targets_unreadable_first_hop() {
        let walk = walk_test_ppid_chain(10, &[], &[]).await;

        assert_eq!(walk, PpidChainWalk::Unreadable);
        assert_eq!(process_has_ancestor_from_walk(walk), None);
        assert!(!is_orphan_from_walk(walk));
    }

    #[tokio::test]
    async fn ppid_chain_finds_immediate_target() {
        let walk = walk_test_ppid_chain(10, &[9], &[(10, Some(9))]).await;

        assert_eq!(walk, PpidChainWalk::FoundTarget);
        assert_eq!(process_has_ancestor_from_walk(walk), Some(true));
        assert!(!is_orphan_from_walk(walk));
    }

    #[tokio::test]
    async fn ppid_chain_finds_multi_hop_target() {
        let walk =
            walk_test_ppid_chain(10, &[7], &[(10, Some(9)), (9, Some(8)), (8, Some(7))]).await;

        assert_eq!(walk, PpidChainWalk::FoundTarget);
        assert_eq!(process_has_ancestor_from_walk(walk), Some(true));
        assert!(!is_orphan_from_walk(walk));
    }

    #[tokio::test]
    async fn ppid_chain_finds_target_at_max_depth_boundary() {
        let chain = [
            (100, Some(101)),
            (101, Some(102)),
            (102, Some(103)),
            (103, Some(104)),
            (104, Some(105)),
            (105, Some(106)),
            (106, Some(107)),
            (107, Some(108)),
            (108, Some(109)),
            (109, Some(110)),
            (110, Some(111)),
            (111, Some(112)),
            (112, Some(113)),
            (113, Some(114)),
            (114, Some(115)),
            (115, Some(116)),
        ];
        let walk = walk_test_ppid_chain(100, &[116], &chain).await;

        assert_eq!(walk, PpidChainWalk::FoundTarget);
        assert_eq!(process_has_ancestor_from_walk(walk), Some(true));
        assert!(!is_orphan_from_walk(walk));
    }

    #[tokio::test]
    async fn ppid_chain_reaches_pid_one_boundary() {
        let walk = walk_test_ppid_chain(10, &[99], &[(10, Some(9)), (9, Some(1))]).await;

        assert_eq!(walk, PpidChainWalk::ReachedBoundary);
        assert_eq!(process_has_ancestor_from_walk(walk), Some(false));
        assert!(is_orphan_from_walk(walk));
    }

    #[tokio::test]
    async fn ppid_chain_reaches_pid_zero_boundary() {
        let walk = walk_test_ppid_chain(10, &[99], &[(10, Some(9)), (9, Some(0))]).await;

        assert_eq!(walk, PpidChainWalk::ReachedBoundary);
        assert_eq!(process_has_ancestor_from_walk(walk), Some(false));
        assert!(is_orphan_from_walk(walk));
    }

    #[tokio::test]
    async fn ppid_chain_unreadable_mid_chain() {
        let walk = walk_test_ppid_chain(10, &[99], &[(10, Some(9))]).await;

        assert_eq!(walk, PpidChainWalk::Unreadable);
        assert_eq!(process_has_ancestor_from_walk(walk), None);
        assert!(!is_orphan_from_walk(walk));
    }

    #[tokio::test]
    async fn ppid_chain_circular_reference_hits_max_depth() {
        let walk = walk_test_ppid_chain(10, &[99], &[(10, Some(11)), (11, Some(10))]).await;

        assert_eq!(walk, PpidChainWalk::MaxDepth);
        assert_eq!(process_has_ancestor_from_walk(walk), None);
        assert!(!is_orphan_from_walk(walk));
    }

    #[tokio::test]
    async fn ppid_chain_target_after_max_depth_is_unknown() {
        let chain = [
            (100, Some(101)),
            (101, Some(102)),
            (102, Some(103)),
            (103, Some(104)),
            (104, Some(105)),
            (105, Some(106)),
            (106, Some(107)),
            (107, Some(108)),
            (108, Some(109)),
            (109, Some(110)),
            (110, Some(111)),
            (111, Some(112)),
            (112, Some(113)),
            (113, Some(114)),
            (114, Some(115)),
            (115, Some(116)),
            (116, Some(117)),
        ];
        let walk = walk_test_ppid_chain(100, &[117], &chain).await;

        assert_eq!(walk, PpidChainWalk::MaxDepth);
        assert_eq!(process_has_ancestor_from_walk(walk), None);
        assert!(!is_orphan_from_walk(walk));
    }

    #[tokio::test]
    async fn ppid_chain_target_match_precedes_boundary_check() {
        let pid_one_walk = walk_test_ppid_chain(10, &[1], &[(10, Some(1))]).await;
        let pid_zero_walk = walk_test_ppid_chain(20, &[0], &[(20, Some(0))]).await;

        assert_eq!(pid_one_walk, PpidChainWalk::FoundTarget);
        assert_eq!(pid_zero_walk, PpidChainWalk::FoundTarget);
        assert_eq!(process_has_ancestor_from_walk(pid_one_walk), Some(true));
        assert_eq!(process_has_ancestor_from_walk(pid_zero_walk), Some(true));
        assert!(!is_orphan_from_walk(pid_one_walk));
        assert!(!is_orphan_from_walk(pid_zero_walk));
    }
}
