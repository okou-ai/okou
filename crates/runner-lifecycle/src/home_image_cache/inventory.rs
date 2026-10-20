//! Bounded observations of physical cache keys; disk metadata remains authority.

use std::collections::{BTreeMap, BTreeSet};

use runner_types::types::{HeldHomeState, MAX_HELD_HOME_STATES, MAX_HOME_CACHES_PER_REUSE_KEY};

use super::{HomeImageCache, cap_held_home_states, entry::is_cache_key_name};

#[derive(Default)]
pub struct HomeCacheInventory {
    pub entries: BTreeMap<String, HeldHomeState>,
    /// Retain the group's maximum even when its newest profile is omitted.
    pub completion_times: BTreeMap<String, String>,
    pub(super) omitted_groups: bool,
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

    pub(super) fn insert(&mut self, key: String, state: HeldHomeState) {
        let reuse_key = state.reuse_key.clone();
        let completed_at = self.completion_times.entry(reuse_key.clone()).or_default();
        if state.last_completed_at > *completed_at {
            completed_at.clone_from(&state.last_completed_at);
        }
        self.entries.insert(key, state);
        self.omitted_groups |= self.completion_times.len() > MAX_HELD_HOME_STATES;
        if self.completion_times.len() > MAX_HELD_HOME_STATES
            || self
                .entries
                .values()
                .filter(|state| state.reuse_key == reuse_key)
                .count()
                > MAX_HOME_CACHES_PER_REUSE_KEY
        {
            self.truncated |= cap_inventory_entries(&mut self.entries, &mut self.completion_times);
        }
        self.truncated |= self.entries.len() > MAX_HELD_HOME_STATES;
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

/// Keep up to 1,024 groups and eight profiles per group, before applying the
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
