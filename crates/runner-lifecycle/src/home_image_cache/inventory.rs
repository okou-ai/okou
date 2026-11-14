//! Bounded observations of physical cache keys; disk metadata remains authority.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, btree_map::Entry};

use runner_types::types::{HeldHomeState, MAX_HELD_HOME_STATES, MAX_HOME_CACHES_PER_REUSE_KEY};

use super::{HomeImageCache, cap_held_home_states, entry::is_cache_key_name};

#[cfg(test)]
mod tests;

#[derive(Default)]
pub struct HomeCacheInventory {
    pub entries: BTreeMap<String, HeldHomeState>,
    /// Retain the group's maximum even when its newest profile is omitted.
    pub completion_times: BTreeMap<String, String>,
    pub locked_keys: BTreeSet<String>,
    /// Valid entries were omitted by the bounded projection's limits.
    pub truncated: bool,
    /// Root enumeration failed; the result cannot replace a known snapshot.
    pub incomplete: bool,
}

impl HomeCacheInventory {
    pub fn states(&self) -> Vec<HeldHomeState> {
        project_inventory_entries(&self.entries, &self.completion_times)
    }

    /// Bootstrap only hands advertised entries to the bounded watcher.
    pub fn projected_cache_keys(&self) -> BTreeSet<String> {
        let pairs = self
            .states()
            .into_iter()
            .flat_map(|state| {
                state
                    .home_caches
                    .into_iter()
                    .map(move |home| (state.reuse_key.clone(), home.profile))
            })
            .collect::<BTreeSet<_>>();
        self.entries
            .iter()
            .filter(|(_, state)| {
                state
                    .home_caches
                    .iter()
                    .any(|home| pairs.contains(&(state.reuse_key.clone(), home.profile.clone())))
            })
            .map(|(key, _)| key.clone())
            .collect()
    }
}

struct InventoryGroup {
    completed_at: String,
    entries: BTreeMap<String, HeldHomeState>,
}

/// Scan-owned selection; the published inventory has no mutable derived index.
#[derive(Default)]
pub(super) struct HomeCacheInventoryBuilder {
    groups: BTreeMap<String, InventoryGroup>,
    // The last tuple is the worst group, including the reuse-key tie break.
    completion_order: BTreeSet<(Reverse<String>, String)>,
    pub(super) omitted_groups: bool,
    pub(super) locked_keys: BTreeSet<String>,
    pub(super) truncated: bool,
    pub(super) incomplete: bool,
}

impl HomeCacheInventoryBuilder {
    pub(super) fn insert(&mut self, key: String, state: HeldHomeState) {
        let reuse_key = state.reuse_key.clone();
        match self.groups.entry(reuse_key.clone()) {
            Entry::Vacant(entry) => {
                self.completion_order
                    .insert((Reverse(state.last_completed_at.clone()), reuse_key.clone()));
                entry.insert(InventoryGroup {
                    completed_at: state.last_completed_at.clone(),
                    entries: BTreeMap::new(),
                });
            }
            Entry::Occupied(mut entry) => {
                let group = entry.get_mut();
                if state.last_completed_at > group.completed_at {
                    self.completion_order
                        .remove(&(Reverse(group.completed_at.clone()), reuse_key.clone()));
                    group.completed_at.clone_from(&state.last_completed_at);
                    self.completion_order
                        .insert((Reverse(group.completed_at.clone()), reuse_key.clone()));
                }
            }
        }
        if self.groups.len() > MAX_HELD_HOME_STATES {
            if let Some((_, evicted)) = self.completion_order.pop_last() {
                self.groups.remove(&evicted);
            }
            self.omitted_groups = true;
            self.truncated = true;
        }
        if let Some(group) = self.groups.get_mut(&reuse_key) {
            group.entries.insert(key, state);
            if group.entries.len() > MAX_HOME_CACHES_PER_REUSE_KEY {
                let profiles = group
                    .entries
                    .values()
                    .flat_map(|state| state.home_caches.iter().map(|home| home.profile.as_str()))
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .take(MAX_HOME_CACHES_PER_REUSE_KEY)
                    .map(str::to_owned)
                    .collect::<BTreeSet<_>>();
                let before = group.entries.len();
                group.entries.retain(|_, state| {
                    state
                        .home_caches
                        .iter()
                        .any(|home| profiles.contains(&home.profile))
                });
                self.truncated |= group.entries.len() != before;
            }
        }
    }

    pub(super) fn selected_groups(&self) -> BTreeSet<String> {
        self.groups.keys().cloned().collect()
    }

    /// Recover earlier profiles of groups that re-entered late in the first scan.
    pub(super) fn refill(mut self) -> Self {
        for group in self.groups.values_mut() {
            group.entries.clear();
        }
        self.omitted_groups = false;
        self.truncated = true;
        self
    }

    pub(super) fn finish(self) -> HomeCacheInventory {
        let mut entries = BTreeMap::new();
        let mut completion_times = BTreeMap::new();
        for (reuse_key, group) in self.groups {
            completion_times.insert(reuse_key, group.completed_at);
            entries.extend(group.entries);
        }
        HomeCacheInventory {
            truncated: self.truncated || entries.len() > MAX_HELD_HOME_STATES,
            entries,
            completion_times,
            locked_keys: self.locked_keys,
            incomplete: self.incomplete,
        }
    }
}

pub(super) fn project_inventory_entries(
    entries: &BTreeMap<String, HeldHomeState>,
    completion_times: &BTreeMap<String, String>,
) -> Vec<HeldHomeState> {
    cap_held_home_states(
        entries
            .values()
            .cloned()
            .map(|mut state| {
                if let Some(completed_at) = completion_times.get(&state.reuse_key) {
                    state.last_completed_at.clone_from(completed_at);
                }
                state
            })
            .collect(),
    )
}

/// Keep up to 4,096 groups and eight profiles per group, before applying the
/// wire's total capability cap. Retaining the boundary group's other profiles
/// preserves ordering if a later entry moves that group ahead of the boundary.
pub(super) fn cap_inventory_entries(
    entries: &mut BTreeMap<String, HeldHomeState>,
    completion_times: &mut BTreeMap<String, String>,
) -> bool {
    let present_groups = entries
        .values()
        .map(|state| state.reuse_key.as_str())
        .collect::<BTreeSet<_>>();
    completion_times.retain(|key, _| present_groups.contains(key.as_str()));
    for state in entries.values() {
        let completed_at = completion_times.entry(state.reuse_key.clone()).or_default();
        if state.last_completed_at > *completed_at {
            completed_at.clone_from(&state.last_completed_at);
        }
    }
    let mut groups = completion_times.iter().collect::<Vec<_>>();
    groups.sort_unstable_by(|(a_key, a_time), (b_key, b_time)| {
        b_time.cmp(a_time).then_with(|| a_key.cmp(b_key))
    });
    let retained_groups = groups
        .into_iter()
        .take(MAX_HELD_HOME_STATES)
        .map(|(key, _)| key.clone())
        .collect::<BTreeSet<_>>();
    let mut profiles_by_group = BTreeMap::<String, BTreeSet<String>>::new();
    for state in entries.values() {
        if retained_groups.contains(&state.reuse_key) {
            for home in &state.home_caches {
                profiles_by_group
                    .entry(state.reuse_key.clone())
                    .or_default()
                    .insert(home.profile.clone());
            }
        }
    }
    let retained = profiles_by_group
        .into_iter()
        .flat_map(|(key, profiles)| {
            profiles
                .into_iter()
                .take(MAX_HOME_CACHES_PER_REUSE_KEY)
                .map(move |profile| (key.clone(), profile))
        })
        .collect::<BTreeSet<_>>();
    let before = entries.len();
    entries.retain(|_, state| {
        state
            .home_caches
            .iter()
            .any(|home| retained.contains(&(state.reuse_key.clone(), home.profile.clone())))
    });
    let present_groups = entries
        .values()
        .map(|state| state.reuse_key.as_str())
        .collect::<BTreeSet<_>>();
    completion_times.retain(|key, _| present_groups.contains(key.as_str()));
    before != entries.len() || entries.len() > MAX_HELD_HOME_STATES
}

#[derive(Default)]
pub struct HomeCacheKeyUpdates {
    pub entries: BTreeMap<String, Option<HeldHomeState>>,
    pub busy_keys: BTreeSet<String>,
    pub incomplete: bool,
}

impl HomeImageCache {
    /// Inspect each hint once. The observer owns retries, so one busy entry
    /// never delays publishing independently validated keys.
    pub async fn revalidate_home_cache_keys(
        &self,
        profiles: &BTreeMap<&str, u64>,
        keys: &BTreeSet<String>,
    ) -> HomeCacheKeyUpdates {
        let mut updates = HomeCacheKeyUpdates {
            incomplete: keys.len() > MAX_HELD_HOME_STATES,
            ..Default::default()
        };
        if updates.incomplete {
            return updates;
        }
        for key in keys {
            updates.entries.insert(key.clone(), None);
            if !is_cache_key_name(key) {
                continue;
            }
            match self.try_inventory_entry_lock(key).await {
                Ok(runner_host::lock::TryLock::Acquired(lock)) => {
                    let state = self
                        .publishable_held_home_state(key, Some(profiles), &lock)
                        .await;
                    updates.entries.insert(key.clone(), state);
                }
                Ok(runner_host::lock::TryLock::Busy) => {
                    updates.busy_keys.insert(key.clone());
                }
                Err(_) => {}
            }
        }
        updates
    }

    pub(super) async fn try_inventory_entry_lock(
        &self,
        key: &str,
    ) -> runner_host::error::HostResult<runner_host::lock::TryLock> {
        #[cfg(any(test, feature = "test-support"))]
        self.inner
            .inventory_key_probe_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        runner_host::lock::try_acquire_or_busy(self.entry_lock_path(key)).await
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn inventory_key_probe_count(&self) -> usize {
        self.inner
            .inventory_key_probe_count
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn reset_inventory_key_probe_count(&self) {
        self.inner
            .inventory_key_probe_count
            .store(0, std::sync::atomic::Ordering::Relaxed);
    }

    pub async fn home_cache_inventory_for_profiles(
        &self,
        profiles: &BTreeMap<&str, u64>,
    ) -> HomeCacheInventory {
        self.held_home_states_matching_profiles(Some(profiles), None, true)
            .await
    }

    pub async fn home_cache_inventory_after_change(
        &self,
        profiles: &BTreeMap<&str, u64>,
        keys: &BTreeSet<String>,
    ) -> HomeCacheInventory {
        self.held_home_states_matching_profiles(Some(profiles), Some(keys), true)
            .await
    }
}
