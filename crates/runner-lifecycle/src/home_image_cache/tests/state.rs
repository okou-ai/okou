use super::super::snapshot::HomeCacheStateSnapshot;
use super::super::*;
use super::support::*;
use crate::active_runs::ActiveRuns;
use runner_types::types::{
    HOME_AFFINITY_VERSION, HeldHomeState, HomeCacheCapability, MAX_HELD_HOME_STATES,
};
use std::collections::BTreeMap;

#[tokio::test]
async fn inventory_requires_profile_and_exact_home_shape() {
    let f = Fixture::new().await;
    f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    for (profile, size, expected) in [
        (PROFILE, SIZE, 1),
        ("other-profile", SIZE, 0),
        (PROFILE, SIZE * 2, 0),
    ] {
        let profiles = BTreeMap::from([(profile, size)]);
        let states = f.cache.held_home_states_for_profiles(&profiles).await;
        assert_eq!(states.len(), expected);
        if expected == 1 {
            assert_eq!(states[0].reuse_key, "thread");
            assert_eq!(states[0].home_caches[0].profile, PROFILE);
            assert_eq!(
                states[0].home_caches[0].home_affinity_version,
                HOME_AFFINITY_VERSION
            );
            let (initial, locked, loaded) = f
                .cache
                .initial_held_home_states_for_profiles(&profiles)
                .await;
            assert_eq!(initial, states);
            assert!(locked.is_empty());
            assert!(loaded.contains(&f.key("thread")));
        }
    }
}

#[test]
fn bounded_home_inventory_preserves_newest_reuse_keys_and_profile_partitions() {
    let states = (0..=MAX_HELD_HOME_STATES)
        .map(|i| HeldHomeState {
            reuse_key: format!("thread-{i:04}"),
            last_completed_at: format!("2026-10-09T09:{i:04}:00Z"),
            home_caches: vec![HomeCacheCapability {
                profile: PROFILE.into(),
                home_affinity_version: HOME_AFFINITY_VERSION,
            }],
        })
        .collect();
    let capped = cap_held_home_states(states);
    assert_eq!(capped.len(), MAX_HELD_HOME_STATES);
    assert!(!capped.iter().any(|s| s.reuse_key == "thread-0000"));
    assert!(capped.iter().all(|s| s.home_caches.len() == 1));
}

#[tokio::test]
async fn validated_commit_wakes_every_subscriber_without_advertisement_authority() {
    let snapshot = HomeCacheStateSnapshot::new();
    let mut first = snapshot.subscribe_committed();
    let mut second = snapshot.subscribe_committed();
    assert!(!snapshot.contains_compatible_home("thread:peer", "vm0/default"));
    snapshot.upsert_home_cache_state(
        "physical-key".into(),
        HeldHomeState {
            reuse_key: "thread:peer".into(),
            last_completed_at: "2026-10-20T00:00:00Z".into(),
            home_caches: vec![HomeCacheCapability {
                profile: "vm0/default".into(),
                home_affinity_version: HOME_AFFINITY_VERSION,
            }],
        },
    );
    // Commit occurred before either await: both receivers must retain it.
    first.changed().await.unwrap();
    second.changed().await.unwrap();
    assert!(snapshot.contains_compatible_home("thread:peer", "vm0/default"));
    assert!(!snapshot.contains_compatible_home("thread:peer", "vm0/other"));
    let active_runs = ActiveRuns::new(Arc::new(tokio::sync::Notify::new()));
    let _guard = active_runs.register(
        runner_types::ids::RunId::new_v4(),
        Some("thread:peer".into()),
        "vm0/default".into(),
    );
    assert!(
        snapshot
            .current_held_home_states(&active_runs, None)
            .is_empty()
    );
    assert!(snapshot.contains_compatible_home("thread:peer", "vm0/default"));
}
