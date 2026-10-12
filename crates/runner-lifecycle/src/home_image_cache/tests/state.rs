use super::super::*;
use super::support::*;
use runner_types::types::{
    HOME_AFFINITY_VERSION, HeldHomeState, HomeCacheCapability, MAX_HELD_HOME_STATES,
};
use std::collections::BTreeMap;

#[tokio::test]
async fn inventory_requires_captured_full_rootfs_profile_and_exact_home_shape() {
    let f = Fixture::new().await;
    f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    for (rootfs, size, expected) in [
        (ROOTFS, SIZE, 1),
        ("wrong-rootfs", SIZE, 0),
        (ROOTFS, SIZE * 2, 0),
    ] {
        let profiles = BTreeMap::from([(
            PROFILE,
            HomeImageProfileIdentity {
                rootfs_hash: rootfs,
                image_size_bytes: size,
            },
        )]);
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
