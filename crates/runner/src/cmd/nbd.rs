//! Shared NBD scan helpers used by `gc` and `doctor`.

use nbd_cow::orphan::{self, NbdOrphanCandidate, NbdOrphanPolicy, NbdOrphanProbe};

/// Recheck one previously observed dead-owner candidate with its claim held.
pub(crate) fn nbd_orphan_is_reportable(candidate: NbdOrphanCandidate) -> bool {
    match orphan::probe(candidate) {
        NbdOrphanProbe::Orphan(_) => true,
        NbdOrphanProbe::Failed(error) => {
            tracing::warn!(
                device_index = candidate.device_index(),
                owner_tid = candidate.owner_tid(),
                error = %error,
                "skipping NBD orphan candidate because revalidation failed"
            );
            false
        }
        NbdOrphanProbe::Locked | NbdOrphanProbe::Changed | NbdOrphanProbe::Live => false,
    }
}

/// Scan all NBD devices for reportable orphans: lock-free devices whose
/// recorded owner task has exited.
///
/// Candidates retain the shared owner's identity and policy for later revalidation.
pub(crate) fn find_nbd_orphans() -> Vec<NbdOrphanCandidate> {
    let max_devs = nbd_cow::netlink::nbds_max();
    let mut orphans = Vec::new();
    for device_index in 0..max_devs {
        let candidate = match orphan::observe(device_index, NbdOrphanPolicy::DeadOwner) {
            Ok(Some(candidate)) => candidate,
            Ok(None) => continue,
            Err(error) => {
                tracing::warn!(
                    device_index,
                    error = %error,
                    "skipping NBD device because owner liveness check failed"
                );
                continue;
            }
        };
        if nbd_orphan_is_reportable(candidate) {
            orphans.push(candidate);
        }
    }
    orphans
}
