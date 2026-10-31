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
    let walk = walk_test_ppid_chain(10, &[7], &[(10, Some(9)), (9, Some(8)), (8, Some(7))]).await;

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
