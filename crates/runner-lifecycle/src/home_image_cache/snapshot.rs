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
    pub fn contains_source_home(
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
    pub fn has_compatible_home(&self, reuse_key: &str, profile: &str) -> bool {
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
mod tests {
    use super::*;
    use runner_types::types::{HOME_AFFINITY_VERSION, HomeCacheCapability, MAX_HELD_HOME_STATES};

    fn test_active_runs() -> ActiveRuns {
        ActiveRuns::new(Arc::new(tokio::sync::Notify::new()))
    }

    fn home_cache(profile: &str) -> HomeCacheCapability {
        HomeCacheCapability {
            source_run_id: "33333333-3333-4333-8333-333333333333".parse().unwrap(),
            profile: profile.to_owned(),
            home_affinity_version: HOME_AFFINITY_VERSION,
        }
    }

    fn held_home_state(
        reuse_key: &str,
        last_completed_at: &str,
        profiles: &[&str],
    ) -> HeldHomeState {
        HeldHomeState {
            reuse_key: reuse_key.to_owned(),
            last_completed_at: last_completed_at.to_owned(),
            home_caches: profiles.iter().map(|profile| home_cache(profile)).collect(),
        }
    }

    fn inventory(states: Vec<HeldHomeState>) -> HomeCacheInventory {
        let mut inventory = HomeCacheInventory::default();
        for state in states {
            for home in state.home_caches {
                let key = format!("{}:{}", state.reuse_key, home.profile);
                inventory.insert(
                    key,
                    HeldHomeState {
                        reuse_key: state.reuse_key.clone(),
                        last_completed_at: state.last_completed_at.clone(),
                        home_caches: vec![home],
                    },
                );
            }
        }
        inventory
    }

    fn refresh_snapshot(snapshot: &HomeCacheStateSnapshot, states: Vec<HeldHomeState>) {
        let refresh = snapshot.begin_home_cache_refresh();
        snapshot.finish_home_cache_refresh(refresh, inventory(states));
    }

    fn timestamp_for_index(index: usize) -> String {
        format!("2026-06-01T00:{:02}:{:02}.000Z", index / 60, index % 60)
    }

    #[tokio::test]
    async fn home_cache_snapshot_filters_active_reuse_keys() {
        let snapshot = HomeCacheStateSnapshot::new();
        refresh_snapshot(
            &snapshot,
            vec![
                held_home_state("sess-cache", "2026-06-01T00:00:02.000Z", &["vm0/default"]),
                held_home_state("sess-claimed", "2026-06-01T00:00:03.000Z", &["vm0/default"]),
                held_home_state("sess-active", "2026-06-01T00:00:04.000Z", &["vm0/default"]),
            ],
        );
        let active_runs = test_active_runs();
        let active_guard = active_runs.register(
            runner_types::ids::RunId::new_v4(),
            Some("sess-active".into()),
            "vm0/default".into(),
        );
        let states = snapshot.current_held_home_states(&active_runs, Some("sess-claimed"));

        assert_eq!(
            states,
            vec![held_home_state(
                "sess-cache",
                "2026-06-01T00:00:02.000Z",
                &["vm0/default"],
            )]
        );

        assert!(active_guard.reuse_publisher().publish_no_exact_sandbox());
        let states = snapshot.current_held_home_states(&active_runs, Some("sess-claimed"));
        assert_eq!(
            states,
            vec![
                held_home_state("sess-active", "2026-06-01T00:00:04.000Z", &["vm0/default"]),
                held_home_state("sess-cache", "2026-06-01T00:00:02.000Z", &["vm0/default"]),
            ]
        );
    }

    #[test]
    fn home_cache_snapshot_requires_positive_profile_evidence() {
        let snapshot = HomeCacheStateSnapshot::new();
        assert!(!snapshot.home_cache_loaded());
        assert!(!snapshot.has_compatible_home("sess-cache", "vm0/default"));

        refresh_snapshot(&snapshot, Vec::new());
        assert!(snapshot.home_cache_loaded());
        assert!(!snapshot.has_compatible_home("sess-cache", "vm0/default"));

        refresh_snapshot(
            &snapshot,
            vec![held_home_state(
                "sess-cache",
                "2026-06-01T00:00:02.000Z",
                &["vm0/default"],
            )],
        );
        assert!(snapshot.has_compatible_home("sess-cache", "vm0/default"));
        assert!(!snapshot.has_compatible_home("sess-cache", "vm0/other"));
    }

    #[test]
    fn home_cache_positive_hint_retains_observed_entries_beyond_wire_projection() {
        let snapshot = HomeCacheStateSnapshot::new();
        let scan = inventory(
            (0..MAX_HELD_HOME_STATES)
                .map(|index| {
                    held_home_state(
                        &format!("group-{index:04}"),
                        &timestamp_for_index(index),
                        &["vm0/default", "vm0/large"],
                    )
                })
                .collect(),
        );
        assert_eq!(scan.entries.len(), MAX_HELD_HOME_STATES * 2);
        let token = snapshot.begin_home_cache_refresh();
        let advertised = snapshot.finish_home_cache_refresh(token, scan).states;
        assert!(
            !advertised
                .iter()
                .any(|state| state.reuse_key == "group-0000")
        );
        assert!(snapshot.has_compatible_home("group-0000", "vm0/default"));
        assert!(snapshot.has_compatible_home(
            &format!("group-{:04}", MAX_HELD_HOME_STATES - 1),
            "vm0/default"
        ));
    }

    #[test]
    fn home_cache_snapshot_upsert_caps_states() {
        let snapshot = HomeCacheStateSnapshot::new();
        for index in 0..=MAX_HELD_HOME_STATES {
            snapshot.upsert_home_cache_state(
                format!("sess-{index:04}:vm0/default"),
                HeldHomeState {
                    reuse_key: format!("sess-{index:04}"),
                    last_completed_at: timestamp_for_index(index),
                    home_caches: vec![home_cache("vm0/default")],
                },
            );
        }

        // Observe stored state directly; the current view applies its own cap.
        let states = snapshot.loaded_home_cache_snapshot().states;

        assert_eq!(states.len(), MAX_HELD_HOME_STATES);
        assert!(!states.iter().any(|state| state.reuse_key == "sess-0000"));
        assert!(
            states
                .iter()
                .any(|state| state.reuse_key == format!("sess-{MAX_HELD_HOME_STATES:04}"))
        );
    }

    #[test]
    fn home_cache_snapshot_refresh_preserves_concurrent_upsert() {
        let snapshot = HomeCacheStateSnapshot::new();
        let original = held_home_state("sess-shared", "2026-06-01T00:00:01.000Z", &["vm0/default"]);
        let promoted = held_home_state("sess-shared", "2026-06-01T00:00:02.000Z", &["vm0/large"]);
        refresh_snapshot(&snapshot, vec![original.clone()]);

        let refresh = snapshot.begin_home_cache_refresh();
        snapshot.upsert_home_cache_state("sess-shared:vm0/large".into(), promoted);
        let refreshed =
            snapshot.finish_home_cache_refresh(refresh, inventory(vec![original.clone()]));
        let merged = held_home_state(
            "sess-shared",
            "2026-06-01T00:00:02.000Z",
            &["vm0/default", "vm0/large"],
        );
        assert_eq!(refreshed.states, vec![merged.clone()]);
        assert!(!refreshed.changed);

        let active_runs = test_active_runs();
        assert_eq!(
            snapshot.current_held_home_states(&active_runs, None),
            vec![merged]
        );

        let refresh = snapshot.begin_home_cache_refresh();
        snapshot.finish_home_cache_refresh(refresh, inventory(vec![original.clone()]));
        assert_eq!(
            snapshot.current_held_home_states(&active_runs, None),
            vec![original]
        );
    }

    fn change(keys: &[&str]) -> HomeCacheChange {
        HomeCacheChange {
            observed_at: tokio::time::Instant::now(),
            dirty_cache_keys: keys.iter().map(|key| (*key).to_owned()).collect(),
            requires_full_reconcile: false,
        }
    }

    #[test]
    fn full_scan_cannot_resurrect_a_key_removed_after_scan_start() {
        let snapshot = HomeCacheStateSnapshot::new();
        let original = held_home_state("removed", "2026-06-01T00:00:01.000Z", &["vm0/default"]);
        let independent =
            held_home_state("independent", "2026-06-01T00:00:02.000Z", &["vm0/default"]);
        refresh_snapshot(&snapshot, vec![original.clone(), independent.clone()]);
        let old_scan = snapshot.begin_home_cache_refresh();
        snapshot.note_home_cache_change(&change(&["removed:vm0/default"]));
        let current = snapshot.begin_home_cache_refresh();
        snapshot.finish_home_cache_key_updates(
            current,
            HomeCacheKeyUpdates {
                entries: BTreeMap::from([("removed:vm0/default".into(), None)]),
                busy_keys: BTreeSet::new(),
                incomplete: false,
            },
        );
        let finished = snapshot
            .finish_home_cache_refresh(old_scan, inventory(vec![original, independent.clone()]));
        assert_eq!(finished.states, vec![independent]);
        assert!(!finished.needs_reconcile);
    }

    #[test]
    fn delayed_negative_cannot_remove_a_newer_confirmed_publication() {
        let snapshot = HomeCacheStateSnapshot::new();
        refresh_snapshot(&snapshot, Vec::new());
        snapshot.note_home_cache_change(&change(&["home:vm0/default"]));
        let old_validation = snapshot.begin_home_cache_refresh();
        let published = held_home_state("home", "2026-06-01T00:00:02.000Z", &["vm0/default"]);
        snapshot.upsert_home_cache_state("home:vm0/default".into(), published.clone());
        let finished = snapshot.finish_home_cache_key_updates(
            old_validation,
            HomeCacheKeyUpdates {
                entries: BTreeMap::from([("home:vm0/default".into(), None)]),
                busy_keys: BTreeSet::new(),
                incomplete: false,
            },
        );
        assert_eq!(finished.states, vec![published]);
        assert!(!finished.changed);
    }

    #[test]
    fn keyed_commit_revision_rollover_preserves_newer_confirmed_publications() {
        let snapshot = HomeCacheStateSnapshot::new();
        refresh_snapshot(&snapshot, Vec::new());
        let previous_key = format!("{:064x}", MAX_HELD_HOME_STATES + 1);
        snapshot.note_home_cache_change(&change(&[&previous_key]));
        let keys = (0..MAX_HELD_HOME_STATES)
            .map(|index| format!("{index:064x}"))
            .collect::<Vec<_>>();
        snapshot.note_home_cache_change(&HomeCacheChange {
            observed_at: tokio::time::Instant::now(),
            dirty_cache_keys: keys.iter().cloned().collect(),
            requires_full_reconcile: false,
        });
        let pending = snapshot.begin_home_cache_refresh();
        let outside = held_home_state("outside", "2026-06-01T00:00:02.000Z", &["vm0/default"]);
        snapshot.upsert_home_cache_state(
            format!("{:064x}", MAX_HELD_HOME_STATES + 2),
            outside.clone(),
        );
        let published = held_home_state("published", "2026-06-01T00:00:03.000Z", &["vm0/default"]);
        snapshot.upsert_home_cache_state(keys.last().unwrap().clone(), published.clone());
        let finished = snapshot.finish_home_cache_key_updates(
            pending,
            HomeCacheKeyUpdates {
                entries: keys.into_iter().map(|key| (key, None)).collect(),
                busy_keys: BTreeSet::new(),
                incomplete: false,
            },
        );
        assert_eq!(
            finished.states,
            cap_held_home_states(vec![outside, published])
        );
        assert!(!finished.needs_reconcile);
        assert!(snapshot.lock_inner().revisions.len() <= MAX_HELD_HOME_STATES);
    }

    #[test]
    fn revision_saturation_rejects_an_old_scan_without_guessing_completeness() {
        let snapshot = HomeCacheStateSnapshot::new();
        let original = held_home_state("kept", "2026-06-01T00:00:01.000Z", &["vm0/default"]);
        refresh_snapshot(&snapshot, vec![original.clone()]);
        let old_scan = snapshot.begin_home_cache_refresh();
        for index in 0..=MAX_HELD_HOME_STATES {
            snapshot.note_home_cache_change(&change(&[&format!("{index:064x}")]));
        }
        let finished = snapshot.finish_home_cache_refresh(old_scan, HomeCacheInventory::default());
        assert_eq!(finished.states, vec![original]);
        assert!(finished.needs_reconcile);
        assert!(snapshot.lock_inner().revisions.len() <= MAX_HELD_HOME_STATES);
    }

    #[test]
    fn keyed_removal_preserves_other_profiles_and_refills_a_truncated_projection() {
        let snapshot = HomeCacheStateSnapshot::new();
        let shared = held_home_state(
            "shared",
            "2026-06-01T00:00:01.000Z",
            &["vm0/default", "vm0/large"],
        );
        refresh_snapshot(&snapshot, vec![shared]);
        let token = snapshot.begin_home_cache_refresh();
        let result = snapshot.finish_home_cache_key_updates(
            token,
            HomeCacheKeyUpdates {
                entries: BTreeMap::from([("shared:vm0/default".into(), None)]),
                busy_keys: BTreeSet::new(),
                incomplete: false,
            },
        );
        assert_eq!(result.states[0].home_caches, vec![home_cache("vm0/large")]);
        assert!(!result.needs_reconcile);

        let states = (0..=MAX_HELD_HOME_STATES)
            .map(|index| {
                held_home_state(
                    &format!("sess-{index:04}"),
                    &timestamp_for_index(index),
                    &["vm0/default"],
                )
            })
            .collect::<Vec<_>>();
        refresh_snapshot(&snapshot, states.clone());
        let token = snapshot.begin_home_cache_refresh();
        let result = snapshot.finish_home_cache_key_updates(
            token,
            HomeCacheKeyUpdates {
                entries: BTreeMap::from([("sess-0001:vm0/default".into(), None)]),
                busy_keys: BTreeSet::new(),
                incomplete: false,
            },
        );
        assert!(result.needs_reconcile);
        assert_eq!(result.states.len(), MAX_HELD_HOME_STATES - 1);
        refresh_snapshot(
            &snapshot,
            states
                .into_iter()
                .filter(|state| state.reuse_key != "sess-0001")
                .collect(),
        );
        let refilled = snapshot.loaded_home_cache_snapshot();
        assert_eq!(refilled.states.len(), MAX_HELD_HOME_STATES);
        assert!(
            refilled
                .states
                .iter()
                .any(|state| state.reuse_key == "sess-0000")
        );
    }

    #[test]
    fn truncated_scan_cannot_overwrite_newer_group_ordering() {
        let snapshot = HomeCacheStateSnapshot::new();
        refresh_snapshot(&snapshot, Vec::new());
        let stale_scan = snapshot.begin_home_cache_refresh();
        let scan = inventory(
            (0..=MAX_HELD_HOME_STATES)
                .map(|index| {
                    held_home_state(
                        &format!("group-{index:04}"),
                        &timestamp_for_index(index),
                        &["vm0/default"],
                    )
                })
                .collect(),
        );
        let published = held_home_state("newer", "2026-07-01T00:00:00Z", &["vm0/default"]);
        snapshot.upsert_home_cache_state("newer:vm0/default".into(), published.clone());
        let outcome = snapshot.finish_home_cache_refresh(stale_scan, scan);
        assert!(outcome.needs_reconcile);
        assert_eq!(outcome.states, vec![published]);
    }

    #[test]
    fn untruncated_scan_cannot_overwrite_a_newer_capped_profile_publication() {
        use runner_types::types::MAX_HOME_CACHES_PER_REUSE_KEY;

        let snapshot = HomeCacheStateSnapshot::new();
        let profiles = (0..MAX_HOME_CACHES_PER_REUSE_KEY)
            .map(|index| format!("vm0/profile-{index:02}"))
            .collect::<Vec<_>>();
        let original = held_home_state(
            "home",
            "2026-06-01T00:00:00Z",
            &profiles.iter().map(String::as_str).collect::<Vec<_>>(),
        );
        let independent = held_home_state("independent", "2026-06-02T00:00:00Z", &["vm0/default"]);
        refresh_snapshot(&snapshot, vec![original.clone(), independent.clone()]);
        let stale_scan = snapshot.begin_home_cache_refresh();
        let scan = inventory(vec![original.clone(), independent.clone()]);
        assert!(!scan.truncated);

        let published = held_home_state("home", "2026-06-03T00:00:00Z", &["vm0/zz"]);
        snapshot.upsert_home_cache_state("home:vm0/zz".into(), published.clone());
        let current = snapshot.loaded_home_cache_snapshot().states;
        assert_eq!(current[0].reuse_key, "home");
        assert_eq!(current[0].last_completed_at, published.last_completed_at);
        assert_eq!(current[0].home_caches.len(), MAX_HOME_CACHES_PER_REUSE_KEY);
        assert!(
            current[0]
                .home_caches
                .iter()
                .all(|home| home.profile != "vm0/zz")
        );

        let outcome = snapshot.finish_home_cache_refresh(stale_scan, scan);
        assert_eq!(outcome.states, current);
        assert!(outcome.needs_reconcile);

        let refresh = snapshot.begin_home_cache_refresh();
        let outcome = snapshot
            .finish_home_cache_refresh(refresh, inventory(vec![original, independent, published]));
        assert_eq!(outcome.states, current);
        assert!(!outcome.needs_reconcile);
    }

    #[test]
    fn incomplete_scan_preserves_known_state_and_does_not_turn_unknown_into_empty() {
        for loaded in [false, true] {
            let snapshot = HomeCacheStateSnapshot::new();
            let original = held_home_state("kept", "2026-06-01T00:00:01.000Z", &["vm0/default"]);
            if loaded {
                refresh_snapshot(&snapshot, vec![original.clone()]);
            }
            let token = snapshot.begin_home_cache_refresh();
            let result = snapshot.finish_home_cache_refresh(
                token,
                HomeCacheInventory {
                    incomplete: true,
                    ..Default::default()
                },
            );
            assert_eq!(result.loaded, loaded);
            assert_eq!(
                result.states,
                if loaded { vec![original] } else { Vec::new() }
            );
        }
    }

    #[test]
    fn merge_held_home_state_keeps_newest_timestamp_and_merges_profiles() {
        let existing = held_home_state("thread-1", "2026-06-01T00:00:02.000Z", &["vm0/default"]);
        let incoming = held_home_state(
            "thread-1",
            "2026-06-01T00:00:01.000Z",
            &["vm0/default", "vm0/large"],
        );

        let merged = cap_held_home_states(vec![existing, incoming]);
        let existing = &merged[0];
        assert_eq!(existing.last_completed_at, "2026-06-01T00:00:02.000Z");
        assert_eq!(
            existing.home_caches,
            vec![home_cache("vm0/default"), home_cache("vm0/large")]
        );
    }
}
