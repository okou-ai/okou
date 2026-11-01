use tracing::{info, warn};

use crate::error::{RunnerError, RunnerResult};
use nbd_cow::orphan::{self, NbdOrphanCandidate, NbdOrphanDisconnect};

use super::report::GcReport;

/// Scan for lock-free NBD devices whose recorded owner task has exited and
/// optionally disconnect them. Returns the number of orphans cleaned.
pub(super) async fn gc_nbd_orphans(dry_run: bool) -> RunnerResult<GcReport> {
    gc_nbd_orphans_with(
        dry_run,
        crate::cmd::nbd::find_nbd_orphans,
        orphan::disconnect,
    )
    .await
}

async fn gc_nbd_orphans_with<Scan, Disconnect>(
    dry_run: bool,
    scan: Scan,
    disconnect: Disconnect,
) -> RunnerResult<GcReport>
where
    Scan: FnOnce() -> Vec<NbdOrphanCandidate> + Send + 'static,
    Disconnect: Fn(NbdOrphanCandidate) -> NbdOrphanDisconnect + Clone + Send + 'static,
{
    let orphans = tokio::task::spawn_blocking(scan)
        .await
        .map_err(|e| RunnerError::Internal(format!("nbd orphan scan task failed: {e}")))?;

    if orphans.is_empty() {
        return Ok(GcReport::default());
    }

    let mut cleaned: u32 = 0;
    for candidate in orphans {
        let device_index = candidate.device_index();
        if dry_run {
            let pid = candidate.owner_tid();
            info!(
                "[dry-run] would disconnect orphan NBD device /dev/nbd{device_index} (owner PID {pid} dead)"
            );
            cleaned += 1;
        } else {
            // Re-check before disconnect while holding the same per-index lock
            // the allocator uses. Between the scan and now, the device could
            // have been freed and re-acquired by another runner.
            let disconnect = disconnect.clone();
            let result = match tokio::task::spawn_blocking(move || disconnect(candidate)).await {
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

#[cfg(test)]
mod tests;
