use tracing::{info, warn};

use crate::cmd::nbd::NbdOrphanDisconnect;
use crate::error::{RunnerError, RunnerResult};

use super::report::GcReport;

/// Scan for lock-free NBD devices whose recorded owner task has exited and
/// optionally disconnect them. Returns the number of orphans cleaned.
pub(super) async fn gc_nbd_orphans(dry_run: bool) -> RunnerResult<GcReport> {
    gc_nbd_orphans_with(
        dry_run,
        crate::cmd::nbd::find_nbd_orphans,
        crate::cmd::nbd::disconnect_orphan_if_still_dead,
    )
    .await
}

async fn gc_nbd_orphans_with<Scan, Disconnect>(
    dry_run: bool,
    scan: Scan,
    disconnect: Disconnect,
) -> RunnerResult<GcReport>
where
    Scan: FnOnce() -> (u32, Vec<(u32, u32)>) + Send + 'static,
    Disconnect: Fn(u32, u32) -> NbdOrphanDisconnect + Clone + Send + 'static,
{
    let (_, orphans) = tokio::task::spawn_blocking(scan)
        .await
        .map_err(|e| RunnerError::Internal(format!("nbd orphan scan task failed: {e}")))?;

    if orphans.is_empty() {
        return Ok(GcReport::default());
    }

    let mut cleaned: u32 = 0;
    for (device_index, pid) in orphans {
        if dry_run {
            info!(
                "[dry-run] would disconnect orphan NBD device /dev/nbd{device_index} (owner PID {pid} dead)"
            );
            cleaned += 1;
        } else {
            // Re-check before disconnect while holding the same per-index lock
            // the allocator uses. Between the scan and now, the device could
            // have been freed and re-acquired by another runner.
            let disconnect = disconnect.clone();
            let result =
                match tokio::task::spawn_blocking(move || disconnect(device_index, pid)).await {
                    Ok(result) => result,
                    Err(e) => {
                        warn!("nbd disconnect task failed for /dev/nbd{device_index}: {e}");
                        continue;
                    }
                };

            match result {
                NbdOrphanDisconnect::Disconnected(_) => {
                    cleaned += 1;
                }
                NbdOrphanDisconnect::Locked
                | NbdOrphanDisconnect::Changed
                | NbdOrphanDisconnect::Live => {}
                NbdOrphanDisconnect::Failed(e) => {
                    warn!("failed to disconnect orphan NBD device /dev/nbd{device_index}: {e}");
                }
            }
        }
    }

    Ok(GcReport::cleanup(u64::from(cleaned), 0))
}

runner_test_group!(cmd_gc_build; #[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use super::*;

    fn disconnected(device_index: u32, owner_tid: u32) -> NbdOrphanDisconnect {
        NbdOrphanDisconnect::Disconnected(
            nbd_cow::orphan::NbdOrphanCandidate::from_dead_owner_observation(
                device_index,
                owner_tid,
            ),
        )
    }

    #[tokio::test]
    async fn gc_nbd_orphans_returns_empty_report_without_candidates() {
        let report = gc_nbd_orphans_with(
            false,
            || (8, Vec::new()),
            |_, _| panic!("disconnect should not run without candidates"),
        )
        .await
        .unwrap();

        assert_eq!(report, GcReport::default());
    }

    #[tokio::test]
    async fn gc_nbd_orphans_dry_run_counts_candidates_without_disconnect() {
        let report = gc_nbd_orphans_with(
            true,
            || (8, vec![(2, 101), (5, 202)]),
            |_, _| panic!("disconnect should not run during dry-run"),
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
                (
                    8,
                    vec![(0, 100), (1, 101), (2, 102), (3, 103), (4, 104), (5, 105)],
                )
            },
            |device_index, owner_tid| match device_index {
                0 | 4 => disconnected(device_index, owner_tid),
                1 => NbdOrphanDisconnect::Locked,
                2 => NbdOrphanDisconnect::Changed,
                3 => NbdOrphanDisconnect::Failed(nbd_cow::orphan::NbdOrphanError::Disconnect {
                    device_index,
                    source: nbd_cow::error::NbdCowError::Io(std::io::Error::other(
                        "netlink failed",
                    )),
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
            |_, _| panic!("disconnect should not run after scan failure"),
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
            || (8, vec![(0, 100), (1, 101)]),
            move |device_index, owner_tid| {
                attempts_for_disconnect.fetch_add(1, Ordering::Relaxed);
                if device_index == 0 {
                    panic!("disconnect task failed");
                }
                disconnected(device_index, owner_tid)
            },
        )
        .await
        .unwrap();

        assert_eq!(attempts.load(Ordering::Relaxed), 2);
        assert_eq!(report, GcReport::cleanup(1, 0));
    }
});
