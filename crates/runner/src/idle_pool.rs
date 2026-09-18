use std::collections::{HashMap, hash_map::Entry};
use std::time::{Duration, Instant};

use sandbox::{DeviceRateLimits, SandboxId};
use tokio::sync::watch;

use crate::ids::RunId;
use crate::status::{BlankSandbox, IdleSandbox};
use crate::types::{HeldSandboxState, ReusableSandboxState};

mod entry;
mod park_transition;
mod parking_gate;

pub(crate) use entry::{
    DestroyOutcome, FinalizingHandoffCandidate, IdleDestroyPayload, IdleDestroyResult,
};
pub use entry::{
    IdleDestroyJob, IdleEntry, IdleSandboxIdentity, IdleSandboxKind, IdleUnparkResult,
    ParkedIdleCandidate, RejectedParkedIdleCandidate, ReservedIdleSandbox,
    RestoreReservedIdleResult, ReusableIdleSandbox, ReusableIdleSandboxParts,
};
pub(crate) use entry::{SpeculativeIdleSandbox, SpeculativeIdleUnparkResult};
pub(crate) use park_transition::{
    IdleParkActiveParts, IdleParkCandidate, IdleParkFailureParts, IdleParkRequest,
    IdleParkRequestParts, SpeculativeReparkResult,
};
pub(crate) use parking_gate::ParkingGate;
#[cfg(test)]
pub(crate) use parking_gate::ParkingState;

#[cfg(test)]
pub(crate) mod test_support;

/// Configuration for the idle sandbox pool.
#[derive(Debug, Clone, Default)]
pub struct IdlePoolConfig {
    /// Maximum number of idle sandboxes (0 = unlimited).
    pub max_idle: usize,
}

/// Idle pool status snapshot paired with a monotonic mutation revision.
///
/// Status writes happen after dropping the pool lock, so an older snapshot can
/// otherwise complete after a newer drain/evict write and reintroduce stale
/// entries in either parked collection in status.json.
#[derive(Clone, Debug, Default)]
pub struct IdlePoolSnapshot {
    pub revision: u64,
    pub idle_sandboxes: Vec<IdleSandbox>,
    pub blank_sandboxes: Vec<BlankSandbox>,
}

/// Shared parked inventory with separate exact reuse-key and blank sandbox-ID indexes.
///
/// After a job reaches a terminal state that is proven reusable, its sandbox
/// can be parked here instead of being destroyed. A subsequent job for the same
/// reuse key can reuse the parked sandbox, skipping sandbox creation and startup.
pub struct IdlePool {
    exact_entries: HashMap<String, IdleEntry>,
    blank_entries: HashMap<SandboxId, IdleEntry>,
    config: IdlePoolConfig,
    revision: u64,
    changes: watch::Sender<u64>,
    /// Shared lifecycle gate. The signal/main-loop lifecycle controller updates
    /// this before publishing externally visible mode transitions.
    parking_gate: ParkingGate,
}

/// Why an exact idle reservation could not use the entry observed for its reuse key.
///
/// The classification is produced while the pool lock is held, so it describes the same
/// observation that made the reservation decision without a racy follow-up lookup.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ExactIdleReservationMiss {
    Absent,
    ProfileMismatch,
    DeviceLimitMismatch,
    HistoryGenerationMismatch,
}

impl ExactIdleReservationMiss {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::ProfileMismatch => "profile_mismatch",
            Self::DeviceLimitMismatch => "device_limit_mismatch",
            Self::HistoryGenerationMismatch => "history_generation_mismatch",
        }
    }
}

impl IdlePool {
    #[cfg(test)]
    pub fn new(config: IdlePoolConfig) -> Self {
        Self::new_with_parking_gate(config, ParkingGate::new_open())
    }

    pub(crate) fn new_with_parking_gate(config: IdlePoolConfig, parking_gate: ParkingGate) -> Self {
        let (changes, _changes_rx) = watch::channel(0);
        Self {
            exact_entries: HashMap::new(),
            blank_entries: HashMap::new(),
            config,
            revision: 0,
            changes,
            parking_gate,
        }
    }

    /// Park a sandbox in the shared exact/blank inventory. Exact entries are
    /// identified by reuse key; blanks by sandbox ID.
    ///
    /// When parking is open, an existing identity can be replaced even at
    /// `max_idle`, which limits the combined inventory (0 means unlimited).
    /// At capacity, a new exact entry can evict the oldest blank, but a new
    /// blank cannot evict an entry to gain admission.
    ///
    /// Returns `ParkResult::Replaced` with a destroy job for either the previous
    /// entry with the same identity or the capacity-evicted blank. The caller
    /// must execute this job. Returns `ParkResult::Parked` when no entry is
    /// displaced, or `ParkResult::Rejected` with the candidate if parking is
    /// closed/soft-draining or capacity cannot be made available by these rules.
    pub fn park(&mut self, candidate: ParkedIdleCandidate) -> ParkResult {
        self.park_at(candidate, Instant::now())
    }

    #[cfg(test)]
    pub fn park_at_for_test(
        &mut self,
        candidate: ParkedIdleCandidate,
        parked_at: Instant,
    ) -> ParkResult {
        self.park_at(candidate, parked_at)
    }

    fn park_at(&mut self, candidate: ParkedIdleCandidate, parked_at: Instant) -> ParkResult {
        let identity = &candidate.metadata.identity;
        if !self.parking_gate.is_open() {
            return ParkResult::Rejected(candidate.into_rejected());
        }
        let mut capacity_evicted = None;
        if self.config.max_idle > 0 && self.len() >= self.config.max_idle {
            // At capacity and this identity has no existing entry to replace.
            if !self.contains_identity(identity) {
                if candidate.is_blank() {
                    return ParkResult::Rejected(candidate.into_rejected());
                }
                let Some(blank_key) = self.oldest_blank_key() else {
                    return ParkResult::Rejected(candidate.into_rejected());
                };
                capacity_evicted = self.blank_entries.remove(&blank_key);
            }
        }
        let entry = candidate.into_idle_entry(parked_at);
        let replaced = self.insert_entry(entry).or(capacity_evicted);
        let result = match replaced {
            Some(entry) => ParkResult::Replaced(entry.into_destroy_job()),
            None => ParkResult::Parked,
        };
        self.bump_revision();
        result
    }

    pub fn take(&mut self, reuse_key: &str) -> Option<IdleEntry> {
        let entry = self.exact_entries.remove(reuse_key);
        if entry.is_some() {
            self.bump_revision();
        }
        entry
    }

    pub(crate) fn take_reserved(&mut self, reuse_key: &str) -> Option<ReservedIdleSandbox> {
        self.take(reuse_key).map(ReservedIdleSandbox::parked)
    }

    pub fn has_reusable(
        &self,
        reuse_key: &str,
        profile_name: &str,
        device_rate_limits: &Option<DeviceRateLimits>,
    ) -> bool {
        self.exact_entries.get(reuse_key).is_some_and(|entry| {
            entry.profile_name() == profile_name && entry.device_rate_limits() == device_rate_limits
        })
    }

    pub fn reserve_reusable(
        &mut self,
        reuse_key: &str,
        profile_name: &str,
        device_rate_limits: &Option<DeviceRateLimits>,
    ) -> Option<ReservedIdleSandbox> {
        if !self.has_reusable(reuse_key, profile_name, device_rate_limits) {
            return None;
        }
        let entry = self.exact_entries.remove(reuse_key)?;
        self.bump_revision();
        Some(ReservedIdleSandbox::parked(entry))
    }

    pub fn reserve_reusable_generation(
        &mut self,
        reuse_key: &str,
        profile_name: &str,
        device_rate_limits: &Option<DeviceRateLimits>,
        history_generation_run_id: RunId,
    ) -> Option<ReservedIdleSandbox> {
        self.reserve_reusable_generation_with_reason(
            reuse_key,
            profile_name,
            device_rate_limits,
            history_generation_run_id,
        )
        .ok()
    }

    pub(crate) fn reserve_reusable_generation_with_reason(
        &mut self,
        reuse_key: &str,
        profile_name: &str,
        device_rate_limits: &Option<DeviceRateLimits>,
        history_generation_run_id: RunId,
    ) -> Result<ReservedIdleSandbox, ExactIdleReservationMiss> {
        let entry = match self.exact_entries.entry(reuse_key.to_owned()) {
            Entry::Vacant(_) => return Err(ExactIdleReservationMiss::Absent),
            Entry::Occupied(entry) => {
                if entry.get().profile_name() != profile_name {
                    return Err(ExactIdleReservationMiss::ProfileMismatch);
                }
                if entry.get().device_rate_limits() != device_rate_limits {
                    return Err(ExactIdleReservationMiss::DeviceLimitMismatch);
                }
                if entry.get().metadata.history_generation_run_id != Some(history_generation_run_id)
                {
                    return Err(ExactIdleReservationMiss::HistoryGenerationMismatch);
                }
                entry.remove()
            }
        };
        self.bump_revision();
        Ok(ReservedIdleSandbox::parked(entry))
    }

    /// Reserve a matching idle entry before pressure eviction begins.
    pub(crate) fn reserve_reusable_for_pressure(
        &mut self,
        reuse_key: Option<&str>,
        profile_name: &str,
        device_rate_limits: &Option<DeviceRateLimits>,
        history_generation_run_id: Option<RunId>,
    ) -> Option<ReservedIdleSandbox> {
        reuse_key.and_then(|reuse_key| match history_generation_run_id {
            Some(history_generation_run_id) => self.reserve_reusable_generation(
                reuse_key,
                profile_name,
                device_rate_limits,
                history_generation_run_id,
            ),
            None => self.reserve_reusable(reuse_key, profile_name, device_rate_limits),
        })
    }

    /// Order all current entries for pressure eviction without mutating them.
    pub(crate) fn oldest_first_pressure_keys(&self) -> Vec<IdleSandboxIdentity> {
        let mut ordered_entries: Vec<_> = self
            .entries()
            .map(|entry| {
                (
                    !entry.is_blank(),
                    entry.parked_at,
                    entry.metadata.identity.clone(),
                )
            })
            .collect();
        ordered_entries.sort_unstable();
        ordered_entries
            .into_iter()
            .map(|(_, _, reuse_key)| reuse_key)
            .collect()
    }

    pub(crate) fn reserve_blank(
        &mut self,
        profile_name: &str,
        device_rate_limits: &Option<DeviceRateLimits>,
    ) -> Option<ReservedIdleSandbox> {
        let key = self
            .blank_entries
            .iter()
            .filter(|(_, entry)| {
                entry.profile_name() == profile_name
                    && entry.device_rate_limits() == device_rate_limits
            })
            .min_by_key(|(_, entry)| entry.parked_at)
            .map(|(key, _)| *key)?;
        let entry = self.blank_entries.remove(&key)?;
        self.bump_revision();
        Some(ReservedIdleSandbox::parked(entry))
    }

    pub(crate) fn blank_len(&self) -> usize {
        self.blank_entries.len()
    }

    /// Remove the oldest compatible exact entry that has been idle long enough
    /// to yield its capacity to a blank sandbox.
    ///
    /// Requiring the same profile, device limits, and resource reservation lets
    /// the replenisher retain the entry's existing budget lease through physical
    /// cleanup and transfer it to the replacement without changing admission.
    pub(crate) fn evict_oldest_exact_for_blank(
        &mut self,
        now: Instant,
        min_idle_age: Duration,
        profile_name: &str,
        device_rate_limits: &Option<DeviceRateLimits>,
        vcpu: u32,
        memory_mb: u32,
    ) -> Option<(IdleDestroyJob, Duration)> {
        let (reuse_key, parked_at) = self
            .exact_entries
            .iter()
            .filter(|(_, entry)| {
                entry.profile_name() == profile_name
                    && entry.device_rate_limits() == device_rate_limits
                    && entry.budget_lease.vcpu() == vcpu
                    && entry.budget_lease.memory_mb() == memory_mb
                    && now.saturating_duration_since(entry.parked_at) >= min_idle_age
            })
            .min_by_key(|(reuse_key, entry)| (entry.parked_at, reuse_key.as_str()))
            .map(|(reuse_key, entry)| (reuse_key.clone(), entry.parked_at))?;
        let entry = self.exact_entries.remove(&reuse_key)?;
        self.bump_revision();
        Some((
            entry.into_destroy_job(),
            now.saturating_duration_since(parked_at),
        ))
    }

    pub fn restore_reserved(
        &mut self,
        reservation: ReservedIdleSandbox,
    ) -> RestoreReservedIdleResult {
        let entry = match reservation.into_restore_entry() {
            Ok(entry) => entry,
            Err(destroy_job) => return RestoreReservedIdleResult::Rejected(destroy_job),
        };
        let identity = &entry.metadata.identity;
        if !self.parking_gate.is_open() || self.contains_identity(identity) {
            return RestoreReservedIdleResult::Rejected(Box::new(entry.into_destroy_job()));
        }

        let mut displaced_blank = None;
        if self.config.max_idle > 0 && self.len() >= self.config.max_idle {
            let blank_key = (!entry.is_blank())
                .then(|| self.oldest_blank_key())
                .flatten();
            let Some(blank_key) = blank_key else {
                return RestoreReservedIdleResult::Rejected(Box::new(entry.into_destroy_job()));
            };
            displaced_blank = self.blank_entries.remove(&blank_key);
        }

        // Restore the original entry, including its idle age, while giving exact
        // reservations the same priority over blank inventory as newly parked runs.
        self.insert_entry(entry);
        self.bump_revision();
        match displaced_blank {
            Some(blank) => RestoreReservedIdleResult::Replaced(Box::new(blank.into_destroy_job())),
            None => RestoreReservedIdleResult::Restored,
        }
    }

    /// Evict an entry selected by a pressure ordering captured under the same
    /// exclusive pool access.
    pub(crate) fn evict_for_pressure(
        &mut self,
        identity: &IdleSandboxIdentity,
    ) -> Option<IdleDestroyJob> {
        let entry = match identity {
            IdleSandboxIdentity::Exact(reuse_key) => self.exact_entries.remove(reuse_key),
            IdleSandboxIdentity::Blank(sandbox_id) => self.blank_entries.remove(sandbox_id),
        };
        let job = entry.map(IdleEntry::into_destroy_job);
        if job.is_some() {
            self.bump_revision();
        }
        job
    }

    /// Capture both parked inventories under the same pool revision.
    ///
    /// Exact entries are sorted by reuse key and blanks by sandbox ID. The
    /// shared pool borrow keeps both projections consistent with the revision.
    pub fn status_snapshot(&self) -> IdlePoolSnapshot {
        let mut sandboxes: Vec<IdleSandbox> = self
            .exact_entries
            .iter()
            .map(|(reuse_key, entry)| IdleSandbox {
                reuse_key: reuse_key.clone(),
                sandbox_id: entry.metadata.sandbox_id,
            })
            .collect();
        let mut blank_sandboxes: Vec<_> = self
            .blank_entries
            .keys()
            .map(|sandbox_id| BlankSandbox {
                sandbox_id: *sandbox_id,
            })
            .collect();
        blank_sandboxes.sort_unstable_by_key(|blank| blank.sandbox_id);
        sandboxes.sort_unstable_by(|a, b| a.reuse_key.cmp(&b.reuse_key));
        IdlePoolSnapshot {
            revision: self.revision,
            idle_sandboxes: sandboxes,
            blank_sandboxes,
        }
    }

    /// Return true when the idle pool currently owns `sandbox_id`.
    pub fn contains_sandbox_id(&self, sandbox_id: SandboxId) -> bool {
        self.entries()
            .any(|entry| entry.metadata.sandbox_id == sandbox_id)
    }

    /// Return a reuse-key-sorted snapshot of the idle pool suitable
    /// for status.json. Produced in a single iteration so `reuse_key` and
    /// `sandbox_id` can never drift out of pairing.
    #[cfg(test)]
    pub fn held_snapshot(&self) -> Vec<IdleSandbox> {
        self.status_snapshot().idle_sandboxes
    }

    /// Return every reusable sandbox currently held in the pool, sorted by
    /// reuse key for deterministic heartbeat output.
    ///
    /// Prefer [`status_snapshot`](Self::status_snapshot) when pairing with
    /// sandbox IDs — it produces both views from a single iteration.
    pub fn held_sandbox_states(&self) -> Vec<HeldSandboxState> {
        let mut states: Vec<HeldSandboxState> = self
            .exact_entries
            .iter()
            .filter_map(|(reuse_key, entry)| {
                entry
                    .metadata
                    .last_completed_at
                    .as_ref()
                    .map(|last_completed_at| HeldSandboxState {
                        reuse_key: reuse_key.clone(),
                        last_completed_at: last_completed_at.clone(),
                        reusable_sandbox: ReusableSandboxState {
                            profile: entry.metadata.profile_name.clone(),
                            history_generation_run_id: entry.metadata.history_generation_run_id,
                        },
                    })
            })
            .collect();
        states.sort_unstable_by(|a, b| a.reuse_key.cmp(&b.reuse_key));
        states
    }

    #[cfg(test)]
    pub fn held_reuse_keys(&self) -> Vec<String> {
        let mut reuse_keys: Vec<String> = self.exact_entries.keys().cloned().collect();
        reuse_keys.sort_unstable();
        reuse_keys
    }

    /// Total exact and blank sandboxes owned by the pool.
    pub fn len(&self) -> usize {
        self.exact_entries.len() + self.blank_entries.len()
    }

    /// Subscribe to pool ownership mutations. The revision is durable for each
    /// receiver, so capacity waiters cannot miss an entry parked or restored
    /// between checking the pool and waiting for its next change.
    pub(crate) fn subscribe_changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    /// Current lifecycle parking state.
    #[cfg(test)]
    pub fn parking_state(&self) -> ParkingState {
        self.parking_gate.state()
    }

    /// Shared lifecycle parking gate.
    #[cfg(test)]
    pub fn parking_gate(&self) -> ParkingGate {
        self.parking_gate.clone()
    }

    /// Detach only the currently pool-owned exact entries. Reservations and
    /// blanks are not part of this one-shot operation; later parking stays open.
    pub(crate) fn drain_exact(&mut self) -> Vec<IdleDestroyJob> {
        let jobs: Vec<_> = self
            .exact_entries
            .drain()
            .map(|(_, entry)| entry.into_destroy_job())
            .collect();
        if !jobs.is_empty() {
            self.bump_revision();
        }
        jobs
    }

    /// Drain all entries from the pool. Parking permission is controlled by
    /// [`ParkingGate`] so soft-drain resume can reopen parking before
    /// [`crate::lifecycle::RunnerMode::Running`] becomes visible.
    pub fn drain(&mut self) -> Vec<IdleDestroyJob> {
        let jobs: Vec<IdleDestroyJob> = self
            .exact_entries
            .drain()
            .map(|(_, entry)| entry)
            .chain(self.blank_entries.drain().map(|(_, entry)| entry))
            .map(IdleEntry::into_destroy_job)
            .collect();
        if !jobs.is_empty() {
            self.bump_revision();
        }
        jobs
    }

    fn entries(&self) -> impl Iterator<Item = &IdleEntry> {
        self.exact_entries
            .values()
            .chain(self.blank_entries.values())
    }

    fn contains_identity(&self, identity: &IdleSandboxIdentity) -> bool {
        match identity {
            IdleSandboxIdentity::Exact(reuse_key) => self.exact_entries.contains_key(reuse_key),
            IdleSandboxIdentity::Blank(sandbox_id) => self.blank_entries.contains_key(sandbox_id),
        }
    }

    fn insert_entry(&mut self, entry: IdleEntry) -> Option<IdleEntry> {
        match &entry.metadata.identity {
            IdleSandboxIdentity::Exact(reuse_key) => {
                self.exact_entries.insert(reuse_key.clone(), entry)
            }
            IdleSandboxIdentity::Blank(sandbox_id) => self.blank_entries.insert(*sandbox_id, entry),
        }
    }

    fn bump_revision(&mut self) {
        self.revision = self.revision.saturating_add(1);
        self.changes.send_replace(self.revision);
    }

    fn oldest_blank_key(&self) -> Option<SandboxId> {
        self.blank_entries
            .iter()
            .min_by_key(|(_, entry)| entry.parked_at)
            .map(|(key, _)| *key)
    }
}

/// Result of a `park` operation.
#[must_use]
pub enum ParkResult {
    /// Successfully parked without displacing an exact or blank entry.
    Parked,
    /// Successfully parked, replacing the same identity or evicting the oldest
    /// blank to admit a new exact entry at capacity. The caller must execute
    /// the returned job to destroy the displaced sandbox.
    Replaced(IdleDestroyJob),
    /// Not parked because parking is closed/soft-draining, or the shared capacity
    /// limit cannot be satisfied by same-identity replacement or exact-over-blank
    /// eviction. The rejected candidate is returned to the caller.
    Rejected(RejectedParkedIdleCandidate),
}

#[cfg(test)]
mod destroy_tests;

#[cfg(test)]
mod reclamation_tests;

#[cfg(test)]
mod park_transition_tests;

#[cfg(test)]
mod pool_tests;
