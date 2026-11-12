use super::*;
use runner_types::types::{HOME_AFFINITY_VERSION, HomeCacheCapability};

fn observation(reuse_key: &str, profile: usize, completed_at: &str) -> (String, HeldHomeState) {
    let profile = format!("vm0/profile-{profile:02}");
    (
        format!("{reuse_key}:{profile}"),
        HeldHomeState {
            reuse_key: reuse_key.into(),
            last_completed_at: completed_at.into(),
            home_caches: vec![HomeCacheCapability {
                source_run_id: "33333333-3333-4333-8333-333333333333".parse().unwrap(),
                profile,
                home_affinity_version: HOME_AFFINITY_VERSION,
            }],
        },
    )
}

#[test]
fn bounded_selection_matches_complete_projection_across_orders_and_refill() {
    let mut inputs = (0..MAX_HOME_CACHES_PER_REUSE_KEY)
        .map(|profile| observation("reentered", profile, "2026-01-01T00:00:00Z"))
        .collect::<Vec<_>>();
    for profile in 0..=MAX_HOME_CACHES_PER_REUSE_KEY {
        inputs.push(observation(
            "zz-updated",
            profile,
            if profile == MAX_HOME_CACHES_PER_REUSE_KEY {
                "2026-03-01T00:00:00Z"
            } else {
                "2026-01-01T00:00:00Z"
            },
        ));
    }
    for index in 0..MAX_HELD_HOME_STATES + 32 {
        for profile in 0..2 {
            inputs.push(observation(
                &format!("group-{index:04}"),
                profile,
                "2026-02-01T00:00:00Z",
            ));
        }
    }
    // The early profiles have been evicted before a later one moves the group
    // back ahead of the boundary. Its maximum survives that profile's omission.
    inputs.push(observation(
        "reentered",
        MAX_HOME_CACHES_PER_REUSE_KEY,
        "2026-04-01T00:00:00Z",
    ));
    let expected = cap_held_home_states(inputs.iter().map(|(_, state)| state.clone()).collect());

    for order in 0..3 {
        let mut ordered = inputs.iter().enumerate().collect::<Vec<_>>();
        match order {
            1 => ordered.reverse(),
            2 => ordered.sort_unstable_by_key(|(index, _)| (index * 7919) % inputs.len()),
            _ => {}
        }
        let mut builder = HomeCacheInventoryBuilder::default();
        for (_, (key, state)) in &ordered {
            builder.insert(key.clone(), state.clone());
            assert!(builder.groups.len() <= MAX_HELD_HOME_STATES);
            assert_eq!(builder.completion_order.len(), builder.groups.len());
            if let Some(group) = builder.groups.get(&state.reuse_key) {
                assert!(group.entries.len() <= MAX_HOME_CACHES_PER_REUSE_KEY);
            }
        }
        assert!(builder.omitted_groups);
        let selected = builder.selected_groups();
        let mut refill = builder.refill();
        for (_, (key, state)) in ordered {
            if selected.contains(&state.reuse_key) {
                refill.insert(key.clone(), state.clone());
            }
        }
        assert!(!refill.omitted_groups);
        let inventory = refill.finish();
        assert_eq!(inventory.states(), expected, "order {order}");
        assert!(inventory.truncated);
        assert!(inventory.completion_times.len() <= MAX_HELD_HOME_STATES);
        assert!(inventory.entries.len() <= MAX_HELD_HOME_STATES * MAX_HOME_CACHES_PER_REUSE_KEY);
        assert_eq!(inventory.projected_cache_keys().len(), MAX_HELD_HOME_STATES);
    }
}

#[test]
fn inventory_truncation_includes_the_total_capability_boundary() {
    for extra_profile in [false, true] {
        let mut builder = HomeCacheInventoryBuilder::default();
        let mut expected = Vec::new();
        for index in 0..MAX_HELD_HOME_STATES {
            let (key, state) = observation(
                &format!("group-{index:04}"),
                0,
                &format!(
                    "2026-02-01T{:02}:{:02}:00Z",
                    index / 3600,
                    (index / 60) % 60
                ),
            );
            expected.push(state.clone());
            builder.insert(key, state);
        }
        if extra_profile {
            let (key, state) = observation("group-0000", 1, "2026-03-01T00:00:00Z");
            expected.push(state.clone());
            builder.insert(key, state);
        }
        assert!(!builder.omitted_groups);
        let inventory = builder.finish();
        assert_eq!(inventory.truncated, extra_profile);
        assert_eq!(inventory.states(), cap_held_home_states(expected));
        assert_eq!(
            inventory.entries.len(),
            MAX_HELD_HOME_STATES + usize::from(extra_profile)
        );
    }
}
