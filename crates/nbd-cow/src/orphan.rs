//! Lock-aware NBD orphan observation and cleanup.
//!
//! Linux records the task ID (TID) that connected an NBD device in
//! `/sys/block/nbdN/pid`. The helpers in this module observe that state, apply
//! an explicit cleanup policy, and then revalidate the exact observed TID while
//! holding the cooperative per-index claim. Destructive cleanup keeps the
//! claim held through the netlink disconnect call.
//!
//! The claim coordinates only processes that use the same claim mechanism.
//! Exact sysfs revalidation under that claim is therefore required before any
//! disconnect; non-cooperating device users are still outside its protection.

use std::path::Path;

use crate::error::NbdCowError;

/// Owner and size policy for one NBD orphan-cleanup caller.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NbdOrphanPolicy {
    /// Accept only an owner TID that no longer exists, without reading size.
    DeadOwner,
    /// Accept a dead or current-process owner TID only when size is non-zero.
    DeadOrCurrentProcessOwnerWithNonZeroSize,
}

impl NbdOrphanPolicy {
    const fn requires_non_zero_size(self) -> bool {
        matches!(self, Self::DeadOrCurrentProcessOwnerWithNonZeroSize)
    }
}

/// One policy-eligible NBD state observed before cooperative claim acquisition.
///
/// This value is evidence to revalidate, not proof of current ownership. Pass
/// it to [`probe`] or [`disconnect`] before reporting or mutating the device.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NbdOrphanCandidate {
    device_index: u32,
    owner_tid: u32,
    size_sectors: Option<u64>,
    policy: NbdOrphanPolicy,
}

impl NbdOrphanCandidate {
    /// Reconstruct a previously persisted dead-owner observation.
    ///
    /// [`probe`] and [`disconnect`] still acquire the cooperative claim and
    /// revalidate this exact TID before returning an eligible outcome.
    pub const fn from_dead_owner_observation(device_index: u32, owner_tid: u32) -> Self {
        Self {
            device_index,
            owner_tid,
            size_sectors: None,
            policy: NbdOrphanPolicy::DeadOwner,
        }
    }

    /// N in `/dev/nbdN`.
    pub const fn device_index(self) -> u32 {
        self.device_index
    }

    /// TID observed in `/sys/block/nbdN/pid`.
    pub const fn owner_tid(self) -> u32 {
        self.owner_tid
    }

    /// Observed `/sys/block/nbdN/size` in 512-byte sectors when required.
    pub const fn size_sectors(self) -> Option<u64> {
        self.size_sectors
    }
}

/// Failure while checking owner liveness, acquiring a claim, or disconnecting an orphan.
#[derive(Debug, thiserror::Error)]
pub enum NbdOrphanError {
    /// Owner liveness could not be established from procfs.
    #[error("failed to check owner TID {owner_tid} for /dev/nbd{device_index}: {source}")]
    OwnerLiveness {
        /// N in `/dev/nbdN`.
        device_index: u32,
        /// TID read from `/sys/block/nbdN/pid`.
        owner_tid: u32,
        /// Underlying procfs metadata error.
        #[source]
        source: std::io::Error,
    },
    /// The per-index cooperative claim could not be acquired.
    #[error("failed to acquire cooperative claim for /dev/nbd{device_index}: {source}")]
    Claim {
        /// N in `/dev/nbdN`.
        device_index: u32,
        /// Underlying lock-file error.
        #[source]
        source: std::io::Error,
    },
    /// Netlink failed while the revalidated cooperative claim was held.
    #[error("failed to disconnect /dev/nbd{device_index}: {source}")]
    Disconnect {
        /// N in `/dev/nbdN`.
        device_index: u32,
        /// Underlying NBD netlink error.
        #[source]
        source: NbdCowError,
    },
}

/// Result of revalidating an observed orphan without disconnecting it.
#[must_use = "orphan probe outcomes must be checked before reporting the device"]
#[derive(Debug)]
pub enum NbdOrphanProbe {
    /// The exact observed owner still satisfies the selected policy.
    Orphan(NbdOrphanCandidate),
    /// Another cooperating process currently holds the per-index claim.
    Locked,
    /// The owner or policy-relevant device state changed after observation.
    Changed,
    /// The exact observed owner now exists and is ineligible under the policy.
    Live,
    /// Owner liveness or cooperative claim acquisition failed.
    Failed(NbdOrphanError),
}

/// Result of revalidating and attempting to disconnect an observed orphan.
#[must_use = "orphan disconnect outcomes must be checked for skipped or failed cleanup"]
#[derive(Debug)]
pub enum NbdOrphanDisconnect {
    /// Netlink disconnected the exact revalidated orphan.
    Disconnected(NbdOrphanCandidate),
    /// Another cooperating process currently holds the per-index claim.
    Locked,
    /// The owner or policy-relevant device state changed after observation.
    Changed,
    /// The exact observed owner now exists and is ineligible under the policy.
    Live,
    /// Owner liveness, cooperative claim acquisition, or netlink disconnect failed.
    Failed(NbdOrphanError),
}

#[derive(Clone, Copy)]
struct NbdDeviceState {
    owner_tid: u32,
    size_sectors: Option<u64>,
}

enum RevalidatedCandidate<Guard> {
    Ready(NbdOrphanCandidate, Guard),
    Locked,
    Changed,
    Live,
    Failed(NbdOrphanError),
}

/// Observe one policy-eligible NBD orphan candidate without acquiring its claim.
///
/// Missing, released, malformed, unreadable, or policy-ineligible sysfs state
/// returns `Ok(None)`. Uncertain owner liveness returns an error. A returned
/// candidate must be passed to [`probe`] or [`disconnect`] before it is treated
/// as current.
pub fn observe(
    device_index: u32,
    policy: NbdOrphanPolicy,
) -> Result<Option<NbdOrphanCandidate>, NbdOrphanError> {
    observe_with(
        device_index,
        policy,
        read_nbd_device_state,
        proc_tid_exists,
        crate::is_our_thread,
    )
}

/// Acquire the cooperative claim and revalidate an observed candidate.
///
/// The claim is released before this function returns, so the outcome records
/// the locked observation rather than reserving the device for a later action.
pub fn probe(candidate: NbdOrphanCandidate) -> NbdOrphanProbe {
    probe_with(
        candidate,
        crate::device_lock::try_acquire_device_claim,
        read_nbd_device_state,
        proc_tid_exists,
        crate::is_our_thread,
    )
}

/// Acquire the cooperative claim, revalidate an observed candidate, and
/// disconnect it while the claim remains held.
pub fn disconnect(candidate: NbdOrphanCandidate) -> NbdOrphanDisconnect {
    disconnect_with(
        candidate,
        crate::device_lock::try_acquire_device_claim,
        read_nbd_device_state,
        proc_tid_exists,
        crate::is_our_thread,
        crate::netlink::disconnect,
    )
}

fn observe_with(
    device_index: u32,
    policy: NbdOrphanPolicy,
    read_state: impl FnOnce(u32, NbdOrphanPolicy) -> Option<NbdDeviceState>,
    owner_exists: impl FnOnce(u32) -> std::io::Result<bool>,
    current_process_owns: impl FnOnce(u32) -> bool,
) -> Result<Option<NbdOrphanCandidate>, NbdOrphanError> {
    let Some(state) = read_state(device_index, policy) else {
        return Ok(None);
    };
    if !size_is_eligible(state, policy) {
        return Ok(None);
    }
    let owner_is_eligible =
        owner_is_eligible(state.owner_tid, policy, owner_exists, current_process_owns).map_err(
            |source| NbdOrphanError::OwnerLiveness {
                device_index,
                owner_tid: state.owner_tid,
                source,
            },
        )?;
    if !owner_is_eligible {
        return Ok(None);
    }

    Ok(Some(candidate_from_state(device_index, state, policy)))
}

fn probe_with<Guard>(
    candidate: NbdOrphanCandidate,
    try_claim: impl FnOnce(u32) -> std::io::Result<Option<Guard>>,
    read_state: impl FnOnce(u32, NbdOrphanPolicy) -> Option<NbdDeviceState>,
    owner_exists: impl FnOnce(u32) -> std::io::Result<bool>,
    current_process_owns: impl FnOnce(u32) -> bool,
) -> NbdOrphanProbe {
    match revalidate_with(
        candidate,
        try_claim,
        read_state,
        owner_exists,
        current_process_owns,
    ) {
        RevalidatedCandidate::Ready(current, claim) => {
            drop(claim);
            NbdOrphanProbe::Orphan(current)
        }
        RevalidatedCandidate::Locked => NbdOrphanProbe::Locked,
        RevalidatedCandidate::Changed => NbdOrphanProbe::Changed,
        RevalidatedCandidate::Live => NbdOrphanProbe::Live,
        RevalidatedCandidate::Failed(error) => NbdOrphanProbe::Failed(error),
    }
}

fn disconnect_with<Guard>(
    candidate: NbdOrphanCandidate,
    try_claim: impl FnOnce(u32) -> std::io::Result<Option<Guard>>,
    read_state: impl FnOnce(u32, NbdOrphanPolicy) -> Option<NbdDeviceState>,
    owner_exists: impl FnOnce(u32) -> std::io::Result<bool>,
    current_process_owns: impl FnOnce(u32) -> bool,
    disconnect_device: impl FnOnce(u32) -> crate::error::Result<()>,
) -> NbdOrphanDisconnect {
    match revalidate_with(
        candidate,
        try_claim,
        read_state,
        owner_exists,
        current_process_owns,
    ) {
        RevalidatedCandidate::Ready(current, claim) => {
            let result = match disconnect_device(candidate.device_index) {
                Ok(()) => NbdOrphanDisconnect::Disconnected(current),
                Err(source) => NbdOrphanDisconnect::Failed(NbdOrphanError::Disconnect {
                    device_index: candidate.device_index,
                    source,
                }),
            };
            drop(claim);
            result
        }
        RevalidatedCandidate::Locked => NbdOrphanDisconnect::Locked,
        RevalidatedCandidate::Changed => NbdOrphanDisconnect::Changed,
        RevalidatedCandidate::Live => NbdOrphanDisconnect::Live,
        RevalidatedCandidate::Failed(error) => NbdOrphanDisconnect::Failed(error),
    }
}

fn revalidate_with<Guard>(
    candidate: NbdOrphanCandidate,
    try_claim: impl FnOnce(u32) -> std::io::Result<Option<Guard>>,
    read_state: impl FnOnce(u32, NbdOrphanPolicy) -> Option<NbdDeviceState>,
    owner_exists: impl FnOnce(u32) -> std::io::Result<bool>,
    current_process_owns: impl FnOnce(u32) -> bool,
) -> RevalidatedCandidate<Guard> {
    let claim = match try_claim(candidate.device_index) {
        Ok(Some(claim)) => claim,
        Ok(None) => return RevalidatedCandidate::Locked,
        Err(source) => {
            return RevalidatedCandidate::Failed(NbdOrphanError::Claim {
                device_index: candidate.device_index,
                source,
            });
        }
    };

    let Some(current) = read_state(candidate.device_index, candidate.policy) else {
        return RevalidatedCandidate::Changed;
    };
    if current.owner_tid != candidate.owner_tid || !size_is_eligible(current, candidate.policy) {
        return RevalidatedCandidate::Changed;
    }
    let owner_is_eligible = match owner_is_eligible(
        current.owner_tid,
        candidate.policy,
        owner_exists,
        current_process_owns,
    ) {
        Ok(owner_is_eligible) => owner_is_eligible,
        Err(source) => {
            return RevalidatedCandidate::Failed(NbdOrphanError::OwnerLiveness {
                device_index: candidate.device_index,
                owner_tid: current.owner_tid,
                source,
            });
        }
    };
    if !owner_is_eligible {
        return RevalidatedCandidate::Live;
    }

    RevalidatedCandidate::Ready(
        candidate_from_state(candidate.device_index, current, candidate.policy),
        claim,
    )
}

fn read_nbd_device_state(device_index: u32, policy: NbdOrphanPolicy) -> Option<NbdDeviceState> {
    read_nbd_device_state_with(device_index, policy, |path| std::fs::read_to_string(path))
}

fn read_nbd_device_state_with(
    device_index: u32,
    policy: NbdOrphanPolicy,
    mut read: impl FnMut(&Path) -> std::io::Result<String>,
) -> Option<NbdDeviceState> {
    let size_sectors = if policy.requires_non_zero_size() {
        let size_path = format!("/sys/block/nbd{device_index}/size");
        Some(read(Path::new(&size_path)).ok()?.trim().parse().ok()?)
    } else {
        None
    };

    let owner_path = format!("/sys/block/nbd{device_index}/pid");
    let owner_tid = parse_owner_tid(&read(Path::new(&owner_path)).ok()?)?;
    Some(NbdDeviceState {
        owner_tid,
        size_sectors,
    })
}

fn parse_owner_tid(contents: &str) -> Option<u32> {
    let owner = contents.trim();
    if owner.is_empty() || owner == "-1" || owner == "0" {
        return None;
    }
    owner.parse().ok()
}

fn proc_tid_exists(owner_tid: u32) -> std::io::Result<bool> {
    Path::new(&format!("/proc/{owner_tid}")).try_exists()
}

fn size_is_eligible(state: NbdDeviceState, policy: NbdOrphanPolicy) -> bool {
    !policy.requires_non_zero_size() || state.size_sectors.is_some_and(|size| size != 0)
}

fn owner_is_eligible(
    owner_tid: u32,
    policy: NbdOrphanPolicy,
    owner_exists: impl FnOnce(u32) -> std::io::Result<bool>,
    current_process_owns: impl FnOnce(u32) -> bool,
) -> std::io::Result<bool> {
    match policy {
        NbdOrphanPolicy::DeadOwner => owner_exists(owner_tid).map(|exists| !exists),
        NbdOrphanPolicy::DeadOrCurrentProcessOwnerWithNonZeroSize => {
            if current_process_owns(owner_tid) {
                Ok(true)
            } else {
                owner_exists(owner_tid).map(|exists| !exists)
            }
        }
    }
}

const fn candidate_from_state(
    device_index: u32,
    state: NbdDeviceState,
    policy: NbdOrphanPolicy,
) -> NbdOrphanCandidate {
    NbdOrphanCandidate {
        device_index,
        owner_tid: state.owner_tid,
        size_sectors: state.size_sectors,
        policy,
    }
}

#[cfg(test)]
mod tests;
