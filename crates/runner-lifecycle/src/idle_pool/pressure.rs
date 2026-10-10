//! Bounded physical-pressure candidate snapshots, not detach or backing authority.

use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::num::NonZeroUsize;
use std::time::Instant;

use sandbox::{DeviceRateLimits, SandboxId};
use uuid::Uuid;

use super::{IdleEntry, IdlePool, IdleSandboxIdentity, IdleSandboxKind};

/// Immutable metadata from one exact pool revision. A capacity wait happens
/// outside exclusive pool access; revalidate afterward under the same access
/// used for selection/removal. A valid candidate grants no memory permission.
#[derive(Clone, Debug)]
pub struct IdlePressureCandidate {
    pool: Uuid,
    revision: u64,
    identity: IdleSandboxIdentity,
    sandbox_id: SandboxId,
    parked_at: Instant,
    profile_name: String,
    device_rate_limits: Option<DeviceRateLimits>,
    vcpu: u32,
    memory_mb: u32,
}

impl IdlePressureCandidate {
    pub fn identity(&self) -> &IdleSandboxIdentity {
        &self.identity
    }

    pub fn sandbox_id(&self) -> SandboxId {
        self.sandbox_id
    }

    pub fn profile_name(&self) -> &str {
        &self.profile_name
    }

    pub fn device_rate_limits(&self) -> &Option<DeviceRateLimits> {
        &self.device_rate_limits
    }

    pub fn vcpu(&self) -> u32 {
        self.vcpu
    }

    pub fn memory_mb(&self) -> u32 {
        self.memory_mb
    }

    pub fn parked_at(&self) -> Instant {
        self.parked_at
    }
}

impl IdlePool {
    /// Scan only owned parked inventory and retain O(limit) ordering references.
    /// Blanks precede exact entries; each kind is oldest-first with identity ties.
    /// No provider accessor, I/O, sampling, logical lease release or detach runs
    /// here. Active, reserved and accepted handoff resources are not inventory.
    pub fn pressure_candidates(&self, limit: NonZeroUsize) -> Vec<IdlePressureCandidate> {
        if self.revision == u64::MAX {
            // The existing saturated revision can no longer fence mutations.
            return Vec::new();
        }
        let mut oldest = BinaryHeap::new();
        for entry in self.entries() {
            let key = PressureKey(entry);
            if oldest.len() < limit.get() {
                oldest.push(key);
            } else if let Some(mut newest) = oldest.peek_mut()
                && key < *newest
            {
                *newest = key;
            }
        }
        oldest
            .into_sorted_vec()
            .into_iter()
            .map(|PressureKey(entry)| IdlePressureCandidate {
                pool: self.generation,
                revision: self.revision,
                identity: entry.metadata.identity.clone(),
                sandbox_id: entry.metadata.sandbox_id,
                parked_at: entry.parked_at,
                profile_name: entry.metadata.profile_name.clone(),
                device_rate_limits: entry.metadata.device_rate_limits.clone(),
                vcpu: entry.budget_lease.vcpu(),
                memory_mb: entry.budget_lease.memory_mb(),
            })
            .collect()
    }

    /// Revalidate after outside-lock waits, under the same exclusive pool access
    /// as a later mutation. Even unrelated inventory changes conservatively
    /// defer. P2 cleanup coverage and exact backing capture are separate required
    /// steps before removal/export; this function supplies neither.
    pub fn revalidate_pressure_candidate(&self, candidate: &IdlePressureCandidate) -> bool {
        if self.revision == u64::MAX
            || candidate.pool != self.generation
            || candidate.revision != self.revision
        {
            return false;
        }
        let entry = match &candidate.identity {
            IdleSandboxIdentity::Exact(key) => self.exact_entries.get(key),
            IdleSandboxIdentity::Blank(id) => self.blank_entries.get(id),
        };
        entry.is_some_and(|entry| {
            entry.metadata.sandbox_id == candidate.sandbox_id
                && entry.parked_at == candidate.parked_at
                && entry.metadata.profile_name == candidate.profile_name
                && entry.metadata.device_rate_limits == candidate.device_rate_limits
                && entry.budget_lease.vcpu() == candidate.vcpu
                && entry.budget_lease.memory_mb() == candidate.memory_mb
        })
    }
}

struct PressureKey<'a>(&'a IdleEntry);

impl Ord for PressureKey<'_> {
    fn cmp(&self, other: &Self) -> Ordering {
        let key = |entry: &IdleEntry| {
            (
                entry.metadata.identity.kind() == IdleSandboxKind::Exact,
                entry.parked_at,
            )
        };
        key(self.0)
            .cmp(&key(other.0))
            .then_with(|| self.0.metadata.identity.cmp(&other.0.metadata.identity))
    }
}

impl PartialOrd for PressureKey<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for PressureKey<'_> {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for PressureKey<'_> {}

#[cfg(test)]
mod tests;
