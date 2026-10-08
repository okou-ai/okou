//! Shared, bounded view of reusable workspaces backed by the workspace cache.
//!
//! Heartbeats refresh this state from an asynchronous cache scan, while
//! finalization immediately upserts successful workspace-cache promotions.
//! A refresh token prevents a scan that started earlier from replacing a
//! promotion committed while that scan was in flight.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use tracing::info;

use crate::active_runs::ActiveRuns;
use runner_types::types::HeldWorkspaceState;

use super::{WorkspaceCacheInventory, cap_held_workspace_states};

/// In-memory cache state shared by heartbeat, discovery, and finalization.
///
/// The mutex protects only states and refresh metadata; cache scans run
/// without it. Active reuse keys are filtered when assembling a current view.
#[derive(Clone, Default)]
pub struct WorkspaceCacheStateSnapshot {
    inner: Arc<Mutex<WorkspaceCacheStateSnapshotInner>>,
}

#[derive(Default)]
struct WorkspaceCacheStateSnapshotInner {
    workspace_cache_states: Vec<HeldWorkspaceState>,
    workspace_cache_loaded: bool,
    workspace_cache_complete: bool,
    workspace_cache_revision: u64,
}

/// Opaque revision captured before an asynchronous cache scan.
#[derive(Clone, Copy)]
pub struct WorkspaceCacheSnapshotRefresh {
    revision: u64,
}

/// Committed bounded states and whether the visible cache snapshot changed.
pub struct WorkspaceCacheRefreshOutcome {
    pub states: Vec<HeldWorkspaceState>,
    pub changed: bool,
}

impl WorkspaceCacheStateSnapshot {
    /// Creates a snapshot whose cache contents are not yet known.
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether a refresh or promotion has established cache state.
    /// A completed empty refresh still counts as loaded.
    pub fn workspace_cache_loaded(&self) -> bool {
        self.lock_inner().workspace_cache_loaded
    }

    /// Captures a revision before scanning without retaining the mutex.
    pub fn begin_workspace_cache_refresh(&self) -> WorkspaceCacheSnapshotRefresh {
        WorkspaceCacheSnapshotRefresh {
            revision: self.lock_inner().workspace_cache_revision,
        }
    }

    /// Commits scanned state, merging if an upsert occurred during the scan.
    ///
    /// A scan with the same revision replaces the previous view. A concurrent
    /// promotion advances the revision, so its state survives the older scan.
    /// Only an untruncated scan without concurrent updates can restore complete
    /// negative lookups after cap loss. Active-key filtering is deferred until
    /// a current view is assembled.
    pub fn finish_workspace_cache_refresh(
        &self,
        refresh: WorkspaceCacheSnapshotRefresh,
        inventory: WorkspaceCacheInventory,
    ) -> WorkspaceCacheRefreshOutcome {
        let mut inner = self.lock_inner();
        let unchanged_revision = inner.workspace_cache_revision == refresh.revision;
        let mut complete =
            !inventory.truncated && (unchanged_revision || inner.workspace_cache_complete);
        let mut next = if unchanged_revision {
            inventory.states
        } else {
            merge_workspace_cache_snapshot_states(
                inner.workspace_cache_states.clone(),
                inventory.states,
            )
        };
        complete &= !cap_workspace_cache_snapshot_states(&mut next);
        let changed = inner.workspace_cache_states != next;
        inner.workspace_cache_states = next;
        inner.workspace_cache_loaded = true;
        inner.workspace_cache_complete = complete;
        inner.workspace_cache_revision = inner.workspace_cache_revision.wrapping_add(1);
        WorkspaceCacheRefreshOutcome {
            changed,
            states: inner.workspace_cache_states.clone(),
        }
    }

    /// Incorporates a successful promotion into the snapshot.
    /// An in-flight refresh will merge this update rather than replace it.
    pub fn upsert_workspace_cache_state(&self, state: HeldWorkspaceState) {
        let mut inner = self.lock_inner();
        inner.workspace_cache_loaded = true;
        match inner
            .workspace_cache_states
            .iter_mut()
            .find(|existing| existing.reuse_key == state.reuse_key)
        {
            Some(existing) => merge_held_workspace_state(existing, state),
            None => inner.workspace_cache_states.push(state),
        }
        let truncated = cap_workspace_cache_snapshot_states(&mut inner.workspace_cache_states);
        inner.workspace_cache_complete &= !truncated;
        inner.workspace_cache_revision = inner.workspace_cache_revision.wrapping_add(1);
    }

    /// Only absence from a complete inventory proves a cache key unavailable.
    /// Before a complete scan, or after cap loss, omitted keys remain possible.
    pub fn might_contain_workspace_cache_reuse_key(&self, reuse_key: &str) -> bool {
        let inner = self.lock_inner();
        !inner.workspace_cache_complete
            || inner
                .workspace_cache_states
                .iter()
                .any(|state| state.reuse_key == reuse_key)
    }

    /// Builds a current view without removing active keys from stored state.
    pub fn current_held_workspace_states(
        &self,
        active_runs: &ActiveRuns,
        extra_active_reuse_key: Option<&str>,
    ) -> Vec<HeldWorkspaceState> {
        let workspace_cache_states = self.lock_inner().workspace_cache_states.clone();
        filter_current_held_workspace_states(
            workspace_cache_states,
            active_runs,
            extra_active_reuse_key,
        )
    }

    /// Returns the stored view for a sender that did not request a refresh.
    pub fn loaded_workspace_cache_states(&self) -> Vec<HeldWorkspaceState> {
        self.lock_inner().workspace_cache_states.clone()
    }

    fn lock_inner(&self) -> MutexGuard<'_, WorkspaceCacheStateSnapshotInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Filter a completed refresh result using current active-run ownership.
pub fn filter_current_held_workspace_states(
    states: Vec<HeldWorkspaceState>,
    active_runs: &ActiveRuns,
    extra_active_reuse_key: Option<&str>,
) -> Vec<HeldWorkspaceState> {
    let mut active_reuse_keys = active_runs.reuse_keys();
    if let Some(reuse_key) = extra_active_reuse_key {
        active_reuse_keys.insert(reuse_key.to_owned());
    }
    let mut states = states
        .into_iter()
        .filter(|state| !active_reuse_keys.contains(&state.reuse_key))
        .collect::<Vec<_>>();
    let observed_workspace_states = states.len();
    let observed_workspace_caches = states
        .iter()
        .map(|state| state.workspace_caches.len())
        .sum::<usize>();
    states.sort_unstable_by(|a, b| {
        b.last_completed_at
            .cmp(&a.last_completed_at)
            .then_with(|| a.reuse_key.cmp(&b.reuse_key))
    });
    states = cap_held_workspace_states(states);
    let retained_workspace_caches = states
        .iter()
        .map(|state| state.workspace_caches.len())
        .sum::<usize>();
    if states.len() < observed_workspace_states
        || retained_workspace_caches < observed_workspace_caches
    {
        info!(
            observed_workspace_states,
            retained_workspace_states = states.len(),
            observed_workspace_caches,
            retained_workspace_caches,
            "heartbeat held workspace state truncated"
        );
    }
    states.sort_unstable_by(|a, b| a.reuse_key.cmp(&b.reuse_key));
    states
}

fn merge_held_workspace_state(existing: &mut HeldWorkspaceState, mut incoming: HeldWorkspaceState) {
    if incoming.last_completed_at > existing.last_completed_at {
        existing.last_completed_at = incoming.last_completed_at;
    }
    for incoming_workspace in incoming.workspace_caches.drain(..) {
        match existing
            .workspace_caches
            .iter_mut()
            .find(|workspace| workspace.profile == incoming_workspace.profile)
        {
            Some(existing_workspace)
                if incoming_workspace.workspace_affinity_version
                    >= existing_workspace.workspace_affinity_version =>
            {
                *existing_workspace = incoming_workspace;
            }
            Some(_) => {}
            None => existing.workspace_caches.push(incoming_workspace),
        }
    }
    existing
        .workspace_caches
        .sort_unstable_by(|a, b| a.profile.cmp(&b.profile));
    // The caller caps the merged inventory and records any profile loss.
}

fn merge_workspace_cache_snapshot_states(
    existing_states: Vec<HeldWorkspaceState>,
    refreshed_states: Vec<HeldWorkspaceState>,
) -> Vec<HeldWorkspaceState> {
    let mut by_reuse_key = BTreeMap::<String, HeldWorkspaceState>::new();
    for state in refreshed_states.into_iter().chain(existing_states) {
        match by_reuse_key.get_mut(&state.reuse_key) {
            Some(existing) => merge_held_workspace_state(existing, state),
            None => {
                by_reuse_key.insert(state.reuse_key.clone(), state);
            }
        }
    }
    by_reuse_key.into_values().collect()
}

fn cap_workspace_cache_snapshot_states(states: &mut Vec<HeldWorkspaceState>) -> bool {
    let observed_workspace_states = states.len();
    let observed_workspace_caches = states
        .iter()
        .map(|state| state.workspace_caches.len())
        .sum::<usize>();
    let inventory = WorkspaceCacheInventory::bounded(std::mem::take(states));
    *states = inventory.states;
    let retained_workspace_caches = states
        .iter()
        .map(|state| state.workspace_caches.len())
        .sum::<usize>();
    if states.len() < observed_workspace_states
        || retained_workspace_caches < observed_workspace_caches
    {
        info!(
            observed_workspace_states,
            retained_workspace_states = states.len(),
            observed_workspace_caches,
            retained_workspace_caches,
            "workspace cache snapshot truncated"
        );
    }
    inventory.truncated
}

#[cfg(test)]
mod tests {
    use super::*;
    use runner_types::types::{
        MAX_HELD_WORKSPACE_STATES, MAX_WORKSPACE_CACHES_PER_HEARTBEAT,
        MAX_WORKSPACE_CACHES_PER_REUSE_KEY, WORKSPACE_AFFINITY_VERSION, WorkspaceCacheCapability,
    };

    fn test_active_runs() -> ActiveRuns {
        ActiveRuns::new(Arc::new(tokio::sync::Notify::new()))
    }

    fn workspace_cache(profile: &str) -> WorkspaceCacheCapability {
        WorkspaceCacheCapability {
            profile: profile.to_owned(),
            workspace_affinity_version: WORKSPACE_AFFINITY_VERSION,
        }
    }

    fn held_workspace_state(
        reuse_key: &str,
        last_completed_at: &str,
        profiles: &[&str],
    ) -> HeldWorkspaceState {
        HeldWorkspaceState {
            reuse_key: reuse_key.to_owned(),
            last_completed_at: last_completed_at.to_owned(),
            workspace_caches: profiles
                .iter()
                .map(|profile| workspace_cache(profile))
                .collect(),
        }
    }

    fn refresh_snapshot(snapshot: &WorkspaceCacheStateSnapshot, states: Vec<HeldWorkspaceState>) {
        let refresh = snapshot.begin_workspace_cache_refresh();
        snapshot.finish_workspace_cache_refresh(refresh, WorkspaceCacheInventory::bounded(states));
    }

    fn timestamp_for_index(index: usize) -> String {
        format!("2026-06-01T00:{:02}:{:02}.000Z", index / 60, index % 60)
    }

    #[tokio::test]
    async fn workspace_cache_snapshot_filters_active_reuse_keys() {
        let snapshot = WorkspaceCacheStateSnapshot::new();
        refresh_snapshot(
            &snapshot,
            vec![
                held_workspace_state("sess-cache", "2026-06-01T00:00:02.000Z", &["vm0/default"]),
                held_workspace_state("sess-claimed", "2026-06-01T00:00:03.000Z", &["vm0/default"]),
                held_workspace_state("sess-active", "2026-06-01T00:00:04.000Z", &["vm0/default"]),
            ],
        );
        let active_runs = test_active_runs();
        let active_guard = active_runs.register(
            runner_types::ids::RunId::new_v4(),
            Some("sess-active".into()),
            "vm0/default".into(),
        );
        let states = snapshot.current_held_workspace_states(&active_runs, Some("sess-claimed"));

        assert_eq!(
            states,
            vec![held_workspace_state(
                "sess-cache",
                "2026-06-01T00:00:02.000Z",
                &["vm0/default"],
            )]
        );

        assert!(active_guard.reuse_publisher().publish_no_exact_sandbox());
        let states = snapshot.current_held_workspace_states(&active_runs, Some("sess-claimed"));
        assert_eq!(
            states,
            vec![
                held_workspace_state("sess-active", "2026-06-01T00:00:04.000Z", &["vm0/default"]),
                held_workspace_state("sess-cache", "2026-06-01T00:00:02.000Z", &["vm0/default"]),
            ]
        );
    }

    #[test]
    fn workspace_cache_snapshot_treats_unloaded_cache_as_unknown() {
        let snapshot = WorkspaceCacheStateSnapshot::new();
        assert!(!snapshot.workspace_cache_loaded());
        assert!(snapshot.might_contain_workspace_cache_reuse_key("sess-cache"));

        refresh_snapshot(&snapshot, Vec::new());
        assert!(snapshot.workspace_cache_loaded());
        assert!(!snapshot.might_contain_workspace_cache_reuse_key("sess-cache"));

        refresh_snapshot(
            &snapshot,
            vec![held_workspace_state(
                "sess-cache",
                "2026-06-01T00:00:02.000Z",
                &["vm0/default"],
            )],
        );
        assert!(snapshot.might_contain_workspace_cache_reuse_key("sess-cache"));
    }

    #[test]
    fn workspace_cache_snapshot_upsert_caps_states() {
        let snapshot = WorkspaceCacheStateSnapshot::new();
        refresh_snapshot(&snapshot, Vec::new());
        assert!(!snapshot.might_contain_workspace_cache_reuse_key("sess-0000"));
        for index in 0..=MAX_HELD_WORKSPACE_STATES {
            snapshot.upsert_workspace_cache_state(HeldWorkspaceState {
                reuse_key: format!("sess-{index:04}"),
                last_completed_at: timestamp_for_index(index),
                workspace_caches: vec![workspace_cache("vm0/default")],
            });
        }

        let active_runs = test_active_runs();
        let states = snapshot.current_held_workspace_states(&active_runs, None);

        assert_eq!(states.len(), MAX_HELD_WORKSPACE_STATES);
        assert!(!states.iter().any(|state| state.reuse_key == "sess-0000"));
        assert!(
            states
                .iter()
                .any(|state| state.reuse_key == format!("sess-{MAX_HELD_WORKSPACE_STATES:04}"))
        );
        assert!(snapshot.might_contain_workspace_cache_reuse_key("sess-0000"));
    }

    #[test]
    fn workspace_cache_snapshot_refresh_keeps_omitted_keys_possible() {
        let snapshot = WorkspaceCacheStateSnapshot::new();
        let states = (0..=MAX_HELD_WORKSPACE_STATES)
            .map(|index| {
                held_workspace_state(
                    &format!("sess-{index:04}"),
                    &timestamp_for_index(index),
                    &["vm0/default"],
                )
            })
            .collect();
        refresh_snapshot(&snapshot, states);

        assert_eq!(
            snapshot.loaded_workspace_cache_states().len(),
            MAX_HELD_WORKSPACE_STATES,
        );
        assert!(
            !snapshot
                .loaded_workspace_cache_states()
                .iter()
                .any(|state| state.reuse_key == "sess-0000"),
        );
        assert!(snapshot.might_contain_workspace_cache_reuse_key("sess-0000"));

        refresh_snapshot(&snapshot, Vec::new());
        assert!(!snapshot.might_contain_workspace_cache_reuse_key("sess-0000"));
    }

    #[test]
    fn workspace_cache_snapshot_promotion_alone_does_not_prove_absence() {
        let snapshot = WorkspaceCacheStateSnapshot::new();
        snapshot.upsert_workspace_cache_state(held_workspace_state(
            "sess-promoted",
            "2026-06-01T00:00:02.000Z",
            &["vm0/default"],
        ));
        assert!(snapshot.workspace_cache_loaded());
        assert!(snapshot.might_contain_workspace_cache_reuse_key("sess-on-disk"));
    }

    #[test]
    fn workspace_cache_snapshot_complete_inventory_at_limit_proves_absence() {
        let snapshot = WorkspaceCacheStateSnapshot::new();
        let mut states: Vec<_> = (0..MAX_HELD_WORKSPACE_STATES)
            .map(|index| {
                held_workspace_state(
                    &format!("sess-{index:04}"),
                    &timestamp_for_index(index),
                    &["vm0/default"],
                )
            })
            .collect();
        states.push(states[0].clone());
        refresh_snapshot(&snapshot, states);

        assert_eq!(
            snapshot.loaded_workspace_cache_states().len(),
            MAX_HELD_WORKSPACE_STATES,
        );
        assert!(snapshot.might_contain_workspace_cache_reuse_key("sess-0000"));
        assert!(!snapshot.might_contain_workspace_cache_reuse_key("sess-absent"));
    }

    #[test]
    fn workspace_cache_snapshot_global_cap_keeps_omitted_keys_possible() {
        let snapshot = WorkspaceCacheStateSnapshot::new();
        let profiles = ["vm0/default", "vm0/large"];
        let states = (0..=MAX_WORKSPACE_CACHES_PER_HEARTBEAT / profiles.len())
            .map(|index| {
                held_workspace_state(
                    &format!("sess-{index:04}"),
                    &timestamp_for_index(index),
                    &profiles,
                )
            })
            .collect();
        refresh_snapshot(&snapshot, states);
        let states = snapshot.loaded_workspace_cache_states();
        assert!(states.len() < MAX_HELD_WORKSPACE_STATES);
        assert_eq!(
            states
                .iter()
                .map(|state| state.workspace_caches.len())
                .sum::<usize>(),
            MAX_WORKSPACE_CACHES_PER_HEARTBEAT,
        );
        assert!(!states.iter().any(|state| state.reuse_key == "sess-0000"));
        assert!(snapshot.might_contain_workspace_cache_reuse_key("sess-0000"));
    }

    #[test]
    fn workspace_cache_snapshot_profile_upsert_loss_is_not_hidden_by_merge() {
        let snapshot = WorkspaceCacheStateSnapshot::new();
        refresh_snapshot(&snapshot, Vec::new());
        for index in 0..=MAX_WORKSPACE_CACHES_PER_REUSE_KEY {
            snapshot.upsert_workspace_cache_state(held_workspace_state(
                "sess-shared",
                &timestamp_for_index(index),
                &[&format!("vm0/profile-{index}")],
            ));
        }

        let states = snapshot.loaded_workspace_cache_states();
        assert_eq!(states.len(), 1);
        assert_eq!(
            states[0].workspace_caches.len(),
            MAX_WORKSPACE_CACHES_PER_REUSE_KEY
        );
        assert!(snapshot.might_contain_workspace_cache_reuse_key("sess-absent"));
    }

    #[test]
    fn workspace_cache_snapshot_racing_refresh_cannot_clear_prior_truncation() {
        let snapshot = WorkspaceCacheStateSnapshot::new();
        let states = (0..MAX_HELD_WORKSPACE_STATES)
            .map(|index| {
                held_workspace_state(
                    &format!("sess-{index:04}"),
                    &timestamp_for_index(index),
                    &["vm0/default"],
                )
            })
            .collect();
        refresh_snapshot(&snapshot, states);
        let refresh = snapshot.begin_workspace_cache_refresh();
        snapshot.upsert_workspace_cache_state(held_workspace_state(
            "sess-new",
            &timestamp_for_index(MAX_HELD_WORKSPACE_STATES),
            &["vm0/default"],
        ));
        snapshot.finish_workspace_cache_refresh(refresh, WorkspaceCacheInventory::default());

        assert!(snapshot.might_contain_workspace_cache_reuse_key("sess-0000"));
        assert!(snapshot.might_contain_workspace_cache_reuse_key("sess-new"));
        refresh_snapshot(&snapshot, Vec::new());
        assert!(!snapshot.might_contain_workspace_cache_reuse_key("sess-0000"));
    }

    #[test]
    fn workspace_cache_snapshot_concurrent_merge_records_new_truncation() {
        let snapshot = WorkspaceCacheStateSnapshot::new();
        refresh_snapshot(&snapshot, Vec::new());
        let refresh = snapshot.begin_workspace_cache_refresh();
        snapshot.upsert_workspace_cache_state(held_workspace_state(
            "sess-new",
            &timestamp_for_index(MAX_HELD_WORKSPACE_STATES),
            &["vm0/default"],
        ));
        let inventory = WorkspaceCacheInventory::bounded(
            (0..MAX_HELD_WORKSPACE_STATES)
                .map(|index| {
                    held_workspace_state(
                        &format!("sess-{index:04}"),
                        &timestamp_for_index(index),
                        &["vm0/default"],
                    )
                })
                .collect(),
        );
        assert!(!inventory.truncated);
        snapshot.finish_workspace_cache_refresh(refresh, inventory);

        let states = snapshot.loaded_workspace_cache_states();
        assert_eq!(states.len(), MAX_HELD_WORKSPACE_STATES);
        assert!(!states.iter().any(|state| state.reuse_key == "sess-0000"));
        assert!(snapshot.might_contain_workspace_cache_reuse_key("sess-0000"));
        assert!(snapshot.might_contain_workspace_cache_reuse_key("sess-new"));
    }

    #[test]
    fn workspace_cache_snapshot_refresh_preserves_concurrent_upsert() {
        let snapshot = WorkspaceCacheStateSnapshot::new();
        let original =
            held_workspace_state("sess-shared", "2026-06-01T00:00:01.000Z", &["vm0/default"]);
        let promoted =
            held_workspace_state("sess-shared", "2026-06-01T00:00:02.000Z", &["vm0/large"]);
        refresh_snapshot(&snapshot, vec![original.clone()]);

        let refresh = snapshot.begin_workspace_cache_refresh();
        snapshot.upsert_workspace_cache_state(promoted);
        let refreshed = snapshot.finish_workspace_cache_refresh(
            refresh,
            WorkspaceCacheInventory::bounded(vec![original.clone()]),
        );
        let merged = held_workspace_state(
            "sess-shared",
            "2026-06-01T00:00:02.000Z",
            &["vm0/default", "vm0/large"],
        );
        assert_eq!(refreshed.states, vec![merged.clone()]);
        assert!(!refreshed.changed);

        let active_runs = test_active_runs();
        assert_eq!(
            snapshot.current_held_workspace_states(&active_runs, None),
            vec![merged]
        );

        let refresh = snapshot.begin_workspace_cache_refresh();
        snapshot.finish_workspace_cache_refresh(
            refresh,
            WorkspaceCacheInventory::bounded(vec![original.clone()]),
        );
        assert_eq!(
            snapshot.current_held_workspace_states(&active_runs, None),
            vec![original]
        );
    }

    #[test]
    fn merge_held_workspace_state_keeps_newest_timestamp_and_merges_profiles() {
        let mut existing =
            held_workspace_state("thread-1", "2026-06-01T00:00:02.000Z", &["vm0/default"]);
        let incoming = held_workspace_state(
            "thread-1",
            "2026-06-01T00:00:01.000Z",
            &["vm0/default", "vm0/large"],
        );

        merge_held_workspace_state(&mut existing, incoming);
        assert_eq!(existing.last_completed_at, "2026-06-01T00:00:02.000Z");
        assert_eq!(
            existing.workspace_caches,
            vec![workspace_cache("vm0/default"), workspace_cache("vm0/large")]
        );
    }
}
