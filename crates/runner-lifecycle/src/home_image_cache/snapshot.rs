//! Bounded physical-key observations shared by discovery and heartbeat.
//!
//! Entry revisions include negatives, so an older scan cannot resurrect a
//! removed key. Losing bounded change history invalidates older scan tokens.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::sync::watch;

use tracing::info;

use crate::active_runs::ActiveRuns;
use runner_types::types::{HeldHomeState, MAX_HELD_HOME_STATES};

use super::inventory::{cap_inventory_entries, project_inventory_entries};
use super::{HomeCacheChange, HomeCacheInventory, HomeCacheKeyUpdates, cap_held_home_states};

#[derive(Clone)]
pub struct HomeCacheStateSnapshot {
    inner: Arc<Mutex<HomeCacheStateSnapshotInner>>,
    committed: watch::Sender<()>,
}

impl Default for HomeCacheStateSnapshot {
    fn default() -> Self {
        Self {
            inner: Arc::default(),
            committed: watch::channel(()).0,
        }
    }
}

#[derive(Default)]
struct HomeCacheStateSnapshotInner {
    entries: BTreeMap<String, HeldHomeState>,
    completion_times: BTreeMap<String, String>,
    // Derived at commit time so ordinary readers keep their snapshot-only cost.
    states: Vec<HeldHomeState>,
    loaded: bool,
    revision: u64,
    epoch: u64,
    revisions: BTreeMap<String, u64>,
    truncated: bool,
}

#[derive(Clone, Copy)]
pub struct HomeCacheSnapshotRefresh {
    revision: u64,
    epoch: u64,
}

pub struct HomeCacheRefreshOutcome {
    pub states: Vec<HeldHomeState>,
    pub changed: bool,
    pub loaded: bool,
    pub needs_reconcile: bool,
}

impl HomeCacheStateSnapshotInner {
    fn touch(&mut self, key: &str) {
        if (self.revisions.len() == MAX_HELD_HOME_STATES && !self.revisions.contains_key(key))
            || self.revision == u64::MAX
        {
            self.epoch = self.epoch.wrapping_add(1);
            self.revisions.clear();
            self.revision = 0;
        }
        self.revision += 1;
        self.revisions.insert(key.to_owned(), self.revision);
    }

    fn states(&self) -> Vec<HeldHomeState> {
        self.states.clone()
    }

    fn reproject(&mut self) {
        self.states = project_inventory_entries(&self.entries, &self.completion_times);
    }

    fn cap_entries(&mut self) -> bool {
        if !self.truncated {
            self.completion_times.clear();
        }
        cap_inventory_entries(&mut self.entries, &mut self.completion_times)
    }

    fn outcome(&self, before: &[HeldHomeState], needs_reconcile: bool) -> HomeCacheRefreshOutcome {
        let states = self.states();
        HomeCacheRefreshOutcome {
            changed: before != states,
            states,
            loaded: self.loaded,
            needs_reconcile,
        }
    }
}

impl HomeCacheStateSnapshot {
    pub fn new() -> Self {
        Self::default()
    }

    /// Subscribe before inspecting readiness so a concurrent commit cannot be lost.
    pub fn subscribe_committed(&self) -> watch::Receiver<()> {
        self.committed.subscribe()
    }

    /// Validated local readiness, independent of advertised caps/active-key filtering.
    /// Checkout must recheck the immutable generation under its entry lock.
    pub fn has_source_home_hint(
        &self,
        reuse_key: &str,
        profile: &str,
        source: runner_types::ids::RunId,
    ) -> bool {
        self.lock_inner().entries.values().any(|state| {
            state.reuse_key == reuse_key
                && state.home_caches.iter().any(|home| {
                    home.profile == profile
                        && home.home_affinity_version == runner_types::types::HOME_AFFINITY_VERSION
                        && home.source_run_id == source
                })
        })
    }

    pub fn home_cache_loaded(&self) -> bool {
        self.lock_inner().loaded
    }

    /// Mark observed changes before admitting asynchronous work. Hints change
    /// revision authority, but only disk validation produces positive state.
    pub fn note_home_cache_change(&self, change: &HomeCacheChange) {
        let mut inner = self.lock_inner();
        if change.requires_full_reconcile {
            inner.epoch = inner.epoch.wrapping_add(1);
            inner.revisions.clear();
        }
        for key in &change.dirty_cache_keys {
            inner.touch(key);
        }
    }

    pub fn begin_home_cache_refresh(&self) -> HomeCacheSnapshotRefresh {
        let inner = self.lock_inner();
        HomeCacheSnapshotRefresh {
            revision: inner.revision,
            epoch: inner.epoch,
        }
    }

    pub fn finish_home_cache_refresh(
        &self,
        refresh: HomeCacheSnapshotRefresh,
        inventory: HomeCacheInventory,
    ) -> HomeCacheRefreshOutcome {
        let mut inner = self.lock_inner();
        let before = inner.states();
        if inventory.incomplete {
            return inner.outcome(&before, false);
        }
        // A capped newer publication can advance group completion without
        // retaining its physical key, so per-key merging cannot preserve it.
        if inner.epoch != refresh.epoch
            || ((inventory.truncated || inner.truncated) && inner.revision != refresh.revision)
        {
            return inner.outcome(&before, true);
        }
        let mut completion_times = if inventory.truncated {
            inventory.completion_times
        } else {
            BTreeMap::new()
        };
        let mut next = inventory.entries;
        for (key, revision) in &inner.revisions {
            if *revision > refresh.revision {
                next.remove(key);
                if let Some(state) = inner.entries.get(key) {
                    next.insert(key.clone(), state.clone());
                }
            }
        }
        inner.truncated =
            inventory.truncated | cap_inventory_entries(&mut next, &mut completion_times);
        let changed_keys = inner
            .entries
            .keys()
            .chain(next.keys())
            .filter(|key| inner.entries.get(*key) != next.get(*key))
            .cloned()
            .collect::<BTreeSet<_>>();
        inner.entries = next;
        inner.completion_times = completion_times;
        inner.loaded = true;
        for key in changed_keys {
            inner.touch(&key);
        }
        inner.reproject();
        let outcome = inner.outcome(&before, false);
        drop(inner);
        self.committed.send_replace(());
        outcome
    }

    pub fn finish_home_cache_key_updates(
        &self,
        refresh: HomeCacheSnapshotRefresh,
        updates: HomeCacheKeyUpdates,
    ) -> HomeCacheRefreshOutcome {
        let mut inner = self.lock_inner();
        let before = inner.states();
        if updates.incomplete || inner.epoch != refresh.epoch {
            return inner.outcome(&before, true);
        }
        // Omitted profiles may carry the group's newest completion or become
        // visible after this update. Reconcile instead of guessing that history.
        let needs_reconcile = inner.truncated && !updates.entries.is_empty();
        let mut applied_keys = Vec::new();
        for (key, state) in updates.entries {
            if inner
                .revisions
                .get(&key)
                .is_some_and(|revision| *revision > refresh.revision)
            {
                continue;
            }
            match state {
                Some(state) => {
                    inner.entries.insert(key.clone(), state);
                }
                None => {
                    inner.entries.remove(&key);
                }
            }
            applied_keys.push(key);
        }
        // Touching can roll the epoch and clear the journal. Preserve that
        // history until every key has been checked for a newer publication.
        for key in applied_keys {
            inner.touch(&key);
        }
        let truncated = inner.cap_entries();
        inner.truncated |= truncated;
        inner.reproject();
        let outcome = inner.outcome(&before, needs_reconcile);
        drop(inner);
        self.committed.send_replace(());
        outcome
    }

    /// Called only after generation-owned publication has succeeded.
    pub fn upsert_home_cache_state(&self, cache_key: String, state: HeldHomeState) {
        let mut inner = self.lock_inner();
        inner.entries.insert(cache_key.clone(), state);
        inner.loaded = true;
        inner.touch(&cache_key);
        let truncated = inner.cap_entries();
        inner.truncated |= truncated;
        inner.reproject();
        drop(inner);
        self.committed.send_replace(());
    }

    /// Positive observed evidence, including entries omitted from the wire projection.
    /// Unloaded state alone grants no hint.
    pub fn has_compatible_home_hint(&self, reuse_key: &str, profile: &str) -> bool {
        let inner = self.lock_inner();
        inner.entries.values().any(|state| {
            state.reuse_key == reuse_key
                && state.home_caches.iter().any(|home| {
                    home.profile == profile
                        && home.home_affinity_version == runner_types::types::HOME_AFFINITY_VERSION
                })
        })
    }

    pub fn current_held_home_states(
        &self,
        active_runs: &ActiveRuns,
        extra_active_reuse_key: Option<&str>,
    ) -> Vec<HeldHomeState> {
        let states = self.lock_inner().states();
        filter_current_held_home_states(states, active_runs, extra_active_reuse_key)
    }

    pub fn loaded_home_cache_snapshot(&self) -> HomeCacheRefreshOutcome {
        let inner = self.lock_inner();
        HomeCacheRefreshOutcome {
            states: inner.states(),
            changed: false,
            loaded: inner.loaded,
            needs_reconcile: false,
        }
    }

    fn lock_inner(&self) -> MutexGuard<'_, HomeCacheStateSnapshotInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Filter a completed refresh result using current active-run ownership.
pub fn filter_current_held_home_states(
    states: Vec<HeldHomeState>,
    active_runs: &ActiveRuns,
    extra_active_reuse_key: Option<&str>,
) -> Vec<HeldHomeState> {
    let mut active_reuse_keys = active_runs.reuse_keys();
    if let Some(reuse_key) = extra_active_reuse_key {
        active_reuse_keys.insert(reuse_key.to_owned());
    }
    let mut states = states
        .into_iter()
        .filter(|state| !active_reuse_keys.contains(&state.reuse_key))
        .collect::<Vec<_>>();
    let observed_home_states = states.len();
    let observed_home_caches = states
        .iter()
        .map(|state| state.home_caches.len())
        .sum::<usize>();
    states.sort_unstable_by(|a, b| {
        b.last_completed_at
            .cmp(&a.last_completed_at)
            .then_with(|| a.reuse_key.cmp(&b.reuse_key))
    });
    states = cap_held_home_states(states);
    let retained_home_caches = states
        .iter()
        .map(|state| state.home_caches.len())
        .sum::<usize>();
    if states.len() < observed_home_states || retained_home_caches < observed_home_caches {
        info!(
            observed_home_states,
            retained_home_states = states.len(),
            observed_home_caches,
            retained_home_caches,
            "heartbeat held home state truncated"
        );
    }
    states.sort_unstable_by(|a, b| a.reuse_key.cmp(&b.reuse_key));
    states
}

#[cfg(test)]
mod tests;
