use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use super::*;

fn candidate(device_index: u32, owner_tid: u32) -> NbdOrphanCandidate {
    NbdOrphanCandidate::from_dead_owner_observation(device_index, owner_tid)
}

#[tokio::test]
async fn gc_nbd_orphans_returns_empty_report_without_candidates() {
    let report = gc_nbd_orphans_with(false, Vec::new, |_| {
        panic!("disconnect should not run without candidates")
    })
    .await
    .unwrap();

    assert_eq!(report, GcReport::default());
}

#[tokio::test]
async fn gc_nbd_orphans_dry_run_counts_candidates_without_disconnect() {
    let report = gc_nbd_orphans_with(
        true,
        || vec![candidate(2, 101), candidate(5, 202)],
        |_| panic!("disconnect should not run during dry-run"),
    )
    .await
    .unwrap();

    assert_eq!(report, GcReport::cleanup(2, 0));
}

#[tokio::test]
async fn gc_nbd_orphans_counts_only_disconnected_outcomes() {
    let report = gc_nbd_orphans_with(
        false,
        || {
            vec![
                candidate(0, 100),
                candidate(1, 101),
                candidate(2, 102),
                candidate(3, 103),
                candidate(4, 104),
                candidate(5, 105),
            ]
        },
        |candidate| match candidate.device_index() {
            0 | 4 => NbdOrphanDisconnect::Disconnected(candidate),
            1 => NbdOrphanDisconnect::Locked,
            2 => NbdOrphanDisconnect::Changed,
            3 => NbdOrphanDisconnect::Failed(nbd_cow::orphan::NbdOrphanError::Disconnect {
                device_index: candidate.device_index(),
                source: nbd_cow::error::NbdCowError::Io(std::io::Error::other("netlink failed")),
            }),
            5 => NbdOrphanDisconnect::Live,
            other => panic!("unexpected device index {other}"),
        },
    )
    .await
    .unwrap();

    assert_eq!(report, GcReport::cleanup(2, 0));
}

#[tokio::test]
async fn gc_nbd_orphans_propagates_scan_task_failure() {
    let error = gc_nbd_orphans_with(
        false,
        || panic!("scan failed"),
        |_| panic!("disconnect should not run after scan failure"),
    )
    .await
    .unwrap_err();

    match error {
        RunnerError::Internal(message) => {
            assert!(message.contains("nbd orphan scan task failed"));
        }
        other => panic!("expected internal scan task error, got {other}"),
    }
}

#[tokio::test]
async fn gc_nbd_orphans_continues_after_disconnect_task_failure() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let attempts_for_disconnect = attempts.clone();
    let report = gc_nbd_orphans_with(
        false,
        || vec![candidate(0, 100), candidate(1, 101)],
        move |candidate| {
            attempts_for_disconnect.fetch_add(1, Ordering::Relaxed);
            if candidate.device_index() == 0 {
                panic!("disconnect task failed");
            }
            NbdOrphanDisconnect::Disconnected(candidate)
        },
    )
    .await
    .unwrap();

    assert_eq!(attempts.load(Ordering::Relaxed), 2);
    assert_eq!(report, GcReport::cleanup(1, 0));
}
