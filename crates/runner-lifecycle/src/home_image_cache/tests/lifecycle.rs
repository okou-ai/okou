use super::super::*;
use super::support::*;
use crate::storage_fingerprints::StorageFingerprints;
use runner_types::ids::RunId;

#[tokio::test]
async fn rootfs_update_reuses_one_physical_entry_and_preserves_current_vm_publication_identity() {
    let f = Fixture::new().await;
    let fingerprints = StorageFingerprints {
        storages: std::collections::HashMap::from([(
            "/home/user/.npm".into(),
            crate::storage_fingerprints::StorageFingerprint::new("npm", "v1"),
        )]),
        artifacts: Default::default(),
    };
    let mut original = f
        .context(
            "thread",
            b"retained-home",
            "2026-10-09T09:00:00Z",
            HomeCacheTerminalStatus::Success,
            fingerprints.clone(),
        )
        .await;
    let proof = binding(&original.publication_generation());
    original
        .set_home_history_proof(Some(proof.clone()))
        .unwrap();
    assert_eq!(
        original.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    drop(original);
    let committed = f.metadata("thread").await;
    let physical_image = f.image("thread", &committed);
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let mut lease = f
        .cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: PROFILE,
                rootfs_hash: "updated-rootfs",
                reuse_key: Some("thread"),
                working_dir: CWD,
                image_size_bytes: SIZE,
            },
            home_drive_required: true,
        })
        .await;
    assert!(lease.is_cache_hit());
    assert_eq!(lease.previous_storage(), Some(&fingerprints));
    assert_eq!(lease.history_proof_binding(), Some(&proof));
    let Some(sandbox::HomeDriveSeedImage::Move(source)) =
        lease.home_drive_config().await.unwrap().unwrap().seed_image
    else {
        panic!("checkout must use its pinned immutable move seed");
    };
    assert_eq!(source, physical_image);
    assert_eq!(
        &std::fs::read(&source).unwrap()[4096..4109],
        b"retained-home"
    );
    assert_eq!(
        f.lease_at_rootfs("thread", "next-rootfs").await.result(),
        HomeCacheCheckoutResult::LockBusy
    );
    assert_eq!(f.cache.gc(false).await.unwrap(), 0);
    assert!(source.exists());
    let active = f.paths.active_home_image(&sandbox_id);
    std::fs::create_dir_all(active.parent().unwrap()).unwrap();
    std::fs::rename(source, &active).unwrap();
    let promotion = lease
        .into_promotion_context(HomeImagePromotionRequest {
            run_id,
            sandbox_id,
            restored_session_identity: None,
            terminal_status: HomeCacheTerminalStatus::Success,
            completed_at: "2026-10-09T09:01:00Z".into(),
            storage_fingerprints: fingerprints,
        })
        .unwrap();
    let other_vm = f
        .cache
        .expected_promotion_identity(HomeImagePromotionIdentityRequest {
            sandbox_id,
            profile_name: PROFILE,
            rootfs_hash: ROOTFS,
            reuse_key: "thread",
            working_dir: CWD,
            image_size_bytes: SIZE,
        })
        .unwrap();
    assert_eq!(
        promotion.validate_identity(&other_vm),
        Err(HomeImagePromotionIdentityMismatch::RootfsHash)
    );
    assert_eq!(promotion.rootfs_hash(), "updated-rootfs");
    assert_eq!(
        promotion.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    drop(promotion);
    let republished = f.metadata("thread").await;
    assert_eq!(republished.rootfs_hash, "updated-rootfs");
    assert_eq!(
        f.image("thread", &republished).parent(),
        physical_image.parent()
    );
    let profiles = std::collections::BTreeMap::from([(PROFILE, SIZE)]);
    let (states, locked, loaded) = f
        .cache
        .initial_held_home_states_for_profiles(&profiles)
        .await;
    assert_eq!(states.len(), 1);
    assert!(locked.is_empty());
    assert_eq!(loaded, std::collections::BTreeSet::from([f.key("thread")]));
    assert!(
        f.lease_at_rootfs("thread", "next-rootfs")
            .await
            .is_cache_hit()
    );
}

#[tokio::test]
async fn checkout_selects_exact_committed_generation_and_pins_it() {
    let f = Fixture::new().await;
    let committed = f
        .commit("thread-a", b"home-content", "2026-10-09T09:00:00Z")
        .await;
    let lease = f.lease("thread-a").await;
    assert_eq!(lease.result(), HomeCacheCheckoutResult::Hit);
    assert_eq!(
        lease.source_image.as_ref(),
        Some(&f.image("thread-a", &committed))
    );
    assert_eq!(
        lease.previous_storage(),
        Some(&StorageFingerprints::default())
    );
    assert!(f.cache.entry_paths(&f.key("thread-a")).metadata().exists());
    assert!(!lease.consumed_cache_hit);
    assert!(f.cache.held_home_states().await.is_empty());
    assert!(lease.source_pin.is_some());
    let identity = lease.source_identity().expect("selected source is known");
    assert_eq!(identity.cache_key, f.key("thread-a"));
    assert_eq!(identity.profile_name, PROFILE);
    assert_eq!(identity.image_generation, committed.image_generation);
    let selected = lease.checkout_observation().unwrap();
    assert_eq!(
        selected.kind,
        runner_host::home_observation::HomeObservationKind::Consumption
    );
    assert_eq!(
        selected.outcome,
        runner_host::home_observation::HomeObservationOutcome::Selected
    );
    assert_eq!(selected.reason.as_deref(), Some("cache_hit"));
    assert_eq!(
        selected.image_generation.as_deref(),
        Some(committed.image_generation.as_str())
    );
}

#[tokio::test]
async fn replaced_seed_is_rejected_at_consumption_and_all_image_evidence_is_discarded() {
    let f = Fixture::new().await;
    let committed = f
        .commit("thread", b"original", "2026-10-09T09:00:00Z")
        .await;
    let mut lease = f.lease_at_rootfs("thread", "updated-rootfs").await;
    assert!(lease.is_cache_hit());
    let image = f.image("thread", &committed);
    let pinned_old = f.dir.path().join("pinned-original.ext4");
    std::fs::rename(&image, &pinned_old).unwrap();
    write_image(&image, b"replacement", SIZE);
    assert!(lease.home_drive_config().await.is_err());
    assert!(f.cache.entry_paths(&f.key("thread")).metadata().exists());
    lease.discard_cached_image();
    assert!(!lease.is_cache_hit());
    assert!(lease.source_identity().is_none());
    assert!(lease.history_proof_binding().is_none());
    assert!(lease.previous_storage().is_none());
    assert_eq!(&std::fs::read(pinned_old).unwrap()[4096..4104], b"original");
}

#[tokio::test]
async fn active_and_checkout_lock_owners_are_not_reusable_inventory() {
    let f = Fixture::new().await;
    f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    let first = f.lease("thread").await;
    let second = f.lease("thread").await;
    assert_eq!(second.result(), HomeCacheCheckoutResult::LockBusy);
    let observation = second.checkout_observation().unwrap();
    assert_eq!(
        observation.outcome,
        runner_host::home_observation::HomeObservationOutcome::Busy
    );
    assert_eq!(observation.reason.as_deref(), Some("active"));
    assert!(f.cache.held_home_states().await.is_empty());
    assert!(
        second
            .into_promotion_context(HomeImagePromotionRequest {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                restored_session_identity: None,
                terminal_status: HomeCacheTerminalStatus::Success,
                completed_at: "2026-10-09T09:01:00Z".into(),
                storage_fingerprints: StorageFingerprints::default()
            })
            .is_none()
    );
    drop(first);
    assert_eq!(
        f.lease("thread").await.result(),
        HomeCacheCheckoutResult::Hit
    );
}

#[tokio::test]
async fn unused_selection_release_revalidates_same_generation_without_a_root_scan() {
    let f = Fixture::new().await;
    let committed = f.commit("thread", b"unused", "2026-10-09T09:00:00Z").await;
    let metadata = f.cache.entry_paths(&f.key("thread")).metadata();
    let original = tokio::fs::read(&metadata).await.unwrap();
    let mut watcher = HomeCacheWatcher::new(f.cache.clone()).await.unwrap();
    let lease = f.lease("thread").await;
    assert!(lease.is_cache_hit());
    assert_eq!(f.cache.gc(false).await.unwrap(), 0);
    assert_eq!(
        f.lease("thread").await.result(),
        HomeCacheCheckoutResult::LockBusy
    );
    drop(lease);

    let change = tokio::time::timeout(std::time::Duration::from_secs(10), watcher.next_change())
        .await
        .unwrap()
        .unwrap();
    assert!(!change.requires_full_reconcile);
    assert_eq!(
        change.dirty_cache_keys,
        std::collections::BTreeSet::from([f.key("thread")])
    );
    f.cache.reset_held_state_root_scan_count();
    let states = f
        .cache
        .revalidate_home_cache_keys(
            &std::collections::BTreeMap::from([(PROFILE, SIZE)]),
            &change.dirty_cache_keys,
            tokio::time::Instant::now(),
        )
        .await
        .entries
        .into_values()
        .flatten()
        .collect::<Vec<_>>();
    assert_eq!(states.len(), 1);
    assert_eq!(states[0].reuse_key, "thread");
    assert_eq!(f.cache.held_state_root_scan_count(), 0);
    assert_eq!(tokio::fs::read(metadata).await.unwrap(), original);
    let next = f.lease("thread").await;
    assert!(next.is_cache_hit());
    assert_eq!(
        next.source_identity().unwrap().image_generation,
        committed.image_generation
    );
    assert_eq!(
        &tokio::fs::read(next.source_image.as_ref().unwrap())
            .await
            .unwrap()[4096..4102],
        b"unused"
    );
}

#[tokio::test]
async fn bounded_inventory_preserves_profile_caps_and_completion_order_across_root_refill() {
    use runner_types::types::{
        HOME_AFFINITY_VERSION, HeldHomeState, HomeCacheCapability, MAX_HELD_HOME_STATES,
        MAX_HOME_CACHES_PER_REUSE_KEY,
    };
    use std::collections::BTreeMap;

    let f = Fixture::new().await;
    let original = f.commit("template", b"home", "2026-01-01T00:00:00Z").await;
    let mut expected = vec![HeldHomeState {
        reuse_key: "template".into(),
        last_completed_at: original.last_completed_at.clone(),
        home_caches: vec![HomeCacheCapability {
            profile: PROFILE.into(),
            home_affinity_version: HOME_AFFINITY_VERSION,
        }],
    }];
    let profiles = (0..=MAX_HOME_CACHES_PER_REUSE_KEY)
        .map(|index| format!("vm0/profile-{index:02}"))
        .collect::<Vec<_>>();
    let mut seed = |reuse_key: &str, profile: &str, completed_at: &str| {
        let key = f.cache.scoped_cache_key(profile, reuse_key, SIZE);
        let paths = f.cache.entry_paths(&key);
        std::fs::create_dir_all(paths.entry_dir()).unwrap();
        // Real sparse images and metadata exercise the disk validator without
        // invoking unrelated publication capacity/GC policy for every fixture.
        let image = paths.image(&original.image_generation).unwrap();
        write_image(&image, b"home", SIZE);
        let mut metadata = original.clone();
        metadata.profile_name = profile.into();
        metadata.reuse_key = reuse_key.into();
        metadata.last_completed_at = completed_at.into();
        metadata.current_image = super::super::metadata::HomeImageFileIdentity::from_metadata(
            &std::fs::symlink_metadata(&image).unwrap(),
        );
        std::fs::write(paths.metadata(), serde_json::to_vec(&metadata).unwrap()).unwrap();
        expected.push(HeldHomeState {
            reuse_key: reuse_key.into(),
            last_completed_at: completed_at.into(),
            home_caches: vec![HomeCacheCapability {
                profile: profile.into(),
                home_affinity_version: HOME_AFFINITY_VERSION,
            }],
        });
    };
    for index in 0..=MAX_HELD_HOME_STATES {
        seed(
            &format!("group-{index:04}"),
            PROFILE,
            "2026-02-01T00:00:00Z",
        );
    }
    for (index, profile) in profiles.iter().enumerate() {
        seed(
            "shared",
            profile,
            if index == MAX_HOME_CACHES_PER_REUSE_KEY {
                "2026-04-01T00:00:00Z"
            } else {
                "2026-03-01T00:00:00Z"
            },
        );
    }
    let configured = profiles
        .iter()
        .map(|profile| (profile.as_str(), SIZE))
        .chain([(PROFILE, SIZE)])
        .collect::<BTreeMap<_, _>>();
    f.cache.reset_held_state_root_scan_count();
    let inventory = f.cache.home_cache_inventory_for_profiles(&configured).await;
    assert!(!inventory.incomplete);
    assert!(inventory.truncated);
    assert_eq!(inventory.states(), cap_held_home_states(expected));
    assert_eq!(f.cache.held_state_root_scan_count(), 2);
    assert!(inventory.completion_times.len() <= MAX_HELD_HOME_STATES);
    assert!(inventory.entries.len() <= MAX_HELD_HOME_STATES * MAX_HOME_CACHES_PER_REUSE_KEY);
    assert_eq!(inventory.projected_cache_keys().len(), MAX_HELD_HOME_STATES);
    let shared = inventory
        .states()
        .into_iter()
        .find(|state| state.reuse_key == "shared")
        .unwrap();
    assert_eq!(shared.last_completed_at, "2026-04-01T00:00:00Z");
    assert_eq!(shared.home_caches.len(), MAX_HOME_CACHES_PER_REUSE_KEY);
}

#[tokio::test]
async fn keyed_inventory_validates_current_authority_without_scanning_independent_entries() {
    use super::super::snapshot::HomeCacheStateSnapshot;
    use std::collections::{BTreeMap, BTreeSet};
    use std::time::Duration;

    #[derive(Debug, PartialEq, Eq)]
    enum Scenario {
        Removed,
        Malformed,
        Foreign,
        Replaced,
        SymlinkedEntry,
        Busy,
        OldGeneration,
    }
    for scenario in [
        Scenario::Removed,
        Scenario::Malformed,
        Scenario::Foreign,
        Scenario::Replaced,
        Scenario::SymlinkedEntry,
        Scenario::Busy,
        Scenario::OldGeneration,
    ] {
        let f = Fixture::new().await;
        let committed = f.commit("changed", b"home", "2026-10-09T09:00:00Z").await;
        f.commit("independent", b"other", "2026-10-09T09:01:00Z")
            .await;
        let profiles = BTreeMap::from([(PROFILE, SIZE)]);
        let snapshot = HomeCacheStateSnapshot::new();
        let token = snapshot.begin_home_cache_refresh();
        snapshot.finish_home_cache_refresh(
            token,
            f.cache.home_cache_inventory_for_profiles(&profiles).await,
        );
        let key = f.key("changed");
        let metadata = f.cache.entry_paths(&key).metadata();
        let mut watcher = HomeCacheWatcher::new(f.cache.clone()).await.unwrap();
        let mut busy_lease = None;
        match scenario {
            Scenario::Removed => tokio::fs::remove_file(&metadata).await.unwrap(),
            Scenario::Malformed => tokio::fs::write(&metadata, b"{broken").await.unwrap(),
            Scenario::Foreign => {
                let mut value = serde_json::to_value(&committed).unwrap();
                value["cacheScope"] = serde_json::json!("another-group");
                tokio::fs::write(&metadata, serde_json::to_vec(&value).unwrap())
                    .await
                    .unwrap();
            }
            Scenario::Replaced => {
                let image = f.image("changed", &committed);
                tokio::fs::rename(&image, f.dir.path().join("old-image"))
                    .await
                    .unwrap();
                write_image(&image, b"replacement", SIZE);
            }
            Scenario::SymlinkedEntry => {
                let entry = f.cache.entry_paths(&key).entry_dir().to_owned();
                let relocated = f.dir.path().join("relocated-entry");
                tokio::fs::rename(&entry, &relocated).await.unwrap();
                tokio::fs::symlink(&relocated, &entry).await.unwrap();
                let change = tokio::time::timeout(Duration::from_secs(5), watcher.next_change())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(change.dirty_cache_keys, BTreeSet::from([key.clone()]));
                assert!(!change.requires_full_reconcile);
                let full = f.cache.home_cache_inventory_for_profiles(&profiles).await;
                assert_eq!(full.states().len(), 1);
                assert_eq!(full.states()[0].reuse_key, "independent");
            }
            Scenario::Busy => busy_lease = Some(f.lease("changed").await),
            Scenario::OldGeneration => {
                let old = f
                    .cache
                    .entry_paths(&key)
                    .image(&RunId::new_v4().to_string())
                    .unwrap();
                write_image(&old, b"old", SIZE);
                tokio::fs::remove_file(old).await.unwrap();
                let change = tokio::time::timeout(Duration::from_secs(5), watcher.next_change())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(change.dirty_cache_keys, BTreeSet::from([key.clone()]));
                assert!(!change.requires_full_reconcile);
            }
        }
        let change = HomeCacheChange {
            observed_at: tokio::time::Instant::now(),
            dirty_cache_keys: BTreeSet::from([key.clone()]),
            requires_full_reconcile: false,
        };
        snapshot.note_home_cache_change(&change);
        let token = snapshot.begin_home_cache_refresh();
        f.cache.reset_held_state_root_scan_count();
        let updates = f
            .cache
            .revalidate_home_cache_keys(
                &profiles,
                &change.dirty_cache_keys,
                tokio::time::Instant::now(),
            )
            .await;
        assert_eq!(updates.busy_keys.contains(&key), scenario == Scenario::Busy);
        let result = snapshot.finish_home_cache_key_updates(token, updates);
        let keys = result
            .states
            .iter()
            .map(|state| state.reuse_key.as_str())
            .collect::<BTreeSet<_>>();
        let expected = if scenario == Scenario::OldGeneration {
            BTreeSet::from(["changed", "independent"])
        } else {
            BTreeSet::from(["independent"])
        };
        assert_eq!(keys, expected, "{scenario:?}");
        assert!(!result.needs_reconcile, "{scenario:?}");
        assert_eq!(f.cache.held_state_root_scan_count(), 0, "{scenario:?}");
        if let Some(lease) = busy_lease {
            drop(lease);
            let updates = f
                .cache
                .revalidate_home_cache_keys(
                    &profiles,
                    &change.dirty_cache_keys,
                    tokio::time::Instant::now(),
                )
                .await;
            assert!(updates.entries.get(&key).unwrap().is_some());
        }
    }
}

#[tokio::test]
async fn replacing_the_selecting_commit_rejects_handoff_without_deleting_its_replacement() {
    let f = Fixture::new().await;
    f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    let mut lease = f.lease("thread").await;
    let metadata = f.cache.entry_paths(&f.key("thread")).metadata();
    let bytes = tokio::fs::read(&metadata).await.unwrap();
    tokio::fs::rename(&metadata, f.dir.path().join("original-metadata"))
        .await
        .unwrap();
    tokio::fs::write(&metadata, &bytes).await.unwrap();
    assert!(lease.home_drive_config().await.is_err());
    assert!(
        lease.home_drive_config().await.is_err(),
        "a rejected handoff cannot silently become fresh"
    );
    assert!(
        !lease
            .invalidate(RunId::new_v4(), "handoff_rejected")
            .await
            .unwrap()
    );
    drop(lease);
    assert_eq!(tokio::fs::read(metadata).await.unwrap(), bytes);
    assert!(f.lease("thread").await.is_cache_hit());
}

#[tokio::test]
async fn accepted_revocation_keeps_entry_and_pins_after_observer_loss_and_is_joined() {
    use std::time::Duration;
    let mut f = Fixture::new().await;
    let original = f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    let gate = HomeImageHandoffTestGate::default();
    let _release = gate.release_on_drop();
    f.cache = f.cache.with_handoff_test_gate(gate.clone());
    let mut lease = f.lease("thread").await;
    let pending = tokio::spawn(async move { lease.home_drive_config().await });
    gate.wait_entered(Duration::from_secs(10)).await;
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    assert_eq!(
        f.lease("thread").await.result(),
        HomeCacheCheckoutResult::LockBusy
    );
    assert_eq!(f.cache.gc(false).await.unwrap(), 0);
    assert!(f.cache.entry_paths(&f.key("thread")).metadata().exists());
    assert!(f.image("thread", &original).exists());
    let drain = f.cache.drain_checkout_handoffs();
    tokio::pin!(drain);
    assert!(futures_util::poll!(&mut drain).is_pending());
    gate.release();
    tokio::time::timeout(Duration::from_secs(10), drain)
        .await
        .unwrap();
    assert!(!f.cache.entry_paths(&f.key("thread")).metadata().exists());
    // Wait for the completed result's custody to retire, then publish a later
    // generation. No accepted unlink may touch that new selecting commit.
    let lock = runner_host::lock::acquire(f.cache.entry_lock_path(&f.key("thread")))
        .await
        .unwrap();
    drop(lock);
    let newer = f
        .commit("thread", b"new-home", "2026-10-09T09:01:00Z")
        .await;
    assert_ne!(newer.image_generation, original.image_generation);
    assert_eq!(
        f.metadata("thread").await.image_generation,
        newer.image_generation
    );
}

#[tokio::test]
async fn identity_partitions_cannot_checkout_another_home() {
    let f = Fixture::new().await;
    f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    for (profile, rootfs, reuse, size) in [
        ("other", ROOTFS, "thread", SIZE),
        (PROFILE, ROOTFS, "other-thread", SIZE),
        (PROFILE, ROOTFS, "thread", SIZE * 2),
    ] {
        let lease = f
            .cache
            .prepare(HomeImagePrepareRequest {
                identity: HomeImageLeaseIdentity {
                    run_id: RunId::new_v4(),
                    sandbox_id: sandbox::SandboxId::new_v4(),
                    profile_name: profile,
                    rootfs_hash: rootfs,
                    reuse_key: Some(reuse),
                    working_dir: CWD,
                    image_size_bytes: size,
                },
                home_drive_required: true,
            })
            .await;
        assert_eq!(lease.result(), HomeCacheCheckoutResult::Miss);
        assert!(lease.previous_storage().is_none());
        assert!(lease.history_proof_binding().is_none());
    }
    let other = HomeImageCache::shared(
        f.paths.clone(),
        &runner_host::paths::HomePaths::with_root(f.dir.path().join("host")),
        "other-group",
    );
    let lease = other
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: PROFILE,
                rootfs_hash: ROOTFS,
                reuse_key: Some("thread"),
                working_dir: CWD,
                image_size_bytes: SIZE,
            },
            home_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), HomeCacheCheckoutResult::Miss);
}

#[tokio::test]
async fn no_key_unsafe_cwd_and_reserve_pressure_are_safe_nonfatal_misses() {
    let f = Fixture::new().await;
    for (cwd, reuse, expected) in [
        (CWD, None, HomeCacheCheckoutResult::NoReuseKey),
        (
            "/home/user/../other",
            Some("thread"),
            HomeCacheCheckoutResult::InvalidWorkingDir,
        ),
    ] {
        let lease = f
            .cache
            .prepare(HomeImagePrepareRequest {
                identity: HomeImageLeaseIdentity {
                    run_id: RunId::new_v4(),
                    sandbox_id: sandbox::SandboxId::new_v4(),
                    profile_name: PROFILE,
                    rootfs_hash: ROOTFS,
                    reuse_key: reuse,
                    working_dir: cwd,
                    image_size_bytes: SIZE,
                },
                home_drive_required: true,
            })
            .await;
        assert_eq!(lease.result(), expected);
        assert!(!lease.is_cache_hit());
    }
    let pressure = HomeImageCache::new_with_fs_stats(
        f.paths.clone(),
        FsStats {
            total_bytes: 100 * GIB,
            available_bytes: 1,
            ..FsStats::default()
        },
    );
    let lease = pressure
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: PROFILE,
                rootfs_hash: ROOTFS,
                reuse_key: Some("thread"),
                working_dir: CWD,
                image_size_bytes: SIZE,
            },
            home_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), HomeCacheCheckoutResult::DiskPressure);
}

#[tokio::test]
async fn pressured_hit_remains_owned_during_gc() {
    use std::time::Duration;
    let mut f = Fixture::new().await;
    let selected = f
        .commit("selected", b"selected-bytes", "2026-10-09T09:00:00Z")
        .await;
    let other = f
        .commit("other", b"other-bytes", "2026-10-09T09:00:01Z")
        .await;
    f.cache = f.cache_under_pressure();
    let mut lease = tokio::time::timeout(Duration::from_secs(10), f.lease("selected"))
        .await
        .unwrap();
    assert!(lease.is_cache_hit());
    let config = lease.home_drive_config().await.unwrap().unwrap();
    assert_eq!(config.space_reserve, HOME_IMAGE_SPACE_RESERVE);
    let Some(sandbox::HomeDriveSeedImage::Move(source)) = config.seed_image else {
        panic!("pressured hit must expose its owned Move seed");
    };
    let expected = tokio::fs::read(&source).await.unwrap();
    assert_eq!(&expected[4096..4110], b"selected-bytes");
    assert_eq!(f.cache.gc_root_scan_count(), 0);
    let cache = f.cache.clone();
    let gc = tokio::spawn(async move { cache.gc(false).await });
    assert!(
        tokio::time::timeout(Duration::from_secs(10), gc)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            > 0
    );
    assert!(!f.image("other", &other).exists());
    assert_eq!(source, f.image("selected", &selected));
    assert_eq!(tokio::fs::read(&source).await.unwrap(), expected);
    let active = f.dir.path().join("consumed/home.ext4");
    std::fs::create_dir_all(active.parent().unwrap()).unwrap();
    std::fs::rename(&source, &active).unwrap();
    assert_eq!(tokio::fs::read(active).await.unwrap(), expected);
}

#[tokio::test]
async fn pressured_miss_does_not_start_reclamation() {
    use std::time::Duration;
    let mut f = Fixture::new().await;
    let unrelated = f
        .commit("other", b"keep-other", "2026-10-09T09:00:00Z")
        .await;
    f.cache = f.cache_under_pressure();
    let mut lease = tokio::time::timeout(Duration::from_secs(10), f.lease("missing"))
        .await
        .unwrap();
    assert_eq!(lease.result(), HomeCacheCheckoutResult::DiskPressure);
    let config = lease.home_drive_config().await.unwrap().unwrap();
    assert!(config.seed_image.is_none());
    assert_eq!(config.space_reserve, HOME_IMAGE_SPACE_RESERVE);
    assert_eq!(f.cache.gc_root_scan_count(), 0);
    assert!(f.image("other", &unrelated).exists());
}

#[tokio::test]
async fn pressured_entry_wait_cancellation_preserves_commit_and_unlocks_for_retry() {
    use std::time::Duration;
    let mut f = Fixture::new().await;
    let committed = f
        .commit("thread", b"cancel-safe", "2026-10-09T09:00:00Z")
        .await;
    f.cache = f.cache_under_pressure();
    let entry = runner_host::lock::acquire(f.cache.entry_lock_path(&f.key("thread")))
        .await
        .unwrap();
    let gate = HomeImagePrepareLockTestGate::default();
    let immediate = tokio::time::timeout(
        Duration::from_secs(10),
        f.cache.prepare_with_lock_policy(
            HomeImagePrepareRequest {
                identity: HomeImageLeaseIdentity {
                    run_id: RunId::new_v4(),
                    sandbox_id: sandbox::SandboxId::new_v4(),
                    profile_name: PROFILE,
                    rootfs_hash: ROOTFS,
                    reuse_key: Some("thread"),
                    working_dir: CWD,
                    image_size_bytes: SIZE,
                },
                home_drive_required: true,
            },
            HomeImagePrepareLockPolicy::ImmediateFallback,
        ),
    )
    .await
    .unwrap();
    assert_eq!(immediate.result(), HomeCacheCheckoutResult::LockBusy);
    let cache = f.cache.clone().with_prepare_lock_test_gate(gate.clone());
    let pending = tokio::spawn(async move {
        cache
            .prepare(HomeImagePrepareRequest {
                identity: HomeImageLeaseIdentity {
                    run_id: RunId::new_v4(),
                    sandbox_id: sandbox::SandboxId::new_v4(),
                    profile_name: PROFILE,
                    rootfs_hash: ROOTFS,
                    reuse_key: Some("thread"),
                    working_dir: CWD,
                    image_size_bytes: SIZE,
                },
                home_drive_required: true,
            })
            .await
    });
    gate.wait_entered(Duration::from_secs(10)).await;
    pending.abort();
    assert!(matches!(pending.await, Err(error) if error.is_cancelled()));
    assert!(f.cache.entry_paths(&f.key("thread")).metadata().exists());
    assert_eq!(
        &tokio::fs::read(f.image("thread", &committed))
            .await
            .unwrap()[4096..4107],
        b"cancel-safe"
    );
    drop(entry);
    let lease = tokio::time::timeout(Duration::from_secs(10), f.lease("thread"))
        .await
        .unwrap();
    assert!(lease.is_cache_hit());
    drop(lease);
    assert!(matches!(
        runner_host::lock::try_acquire_or_busy(f.cache.entry_lock_path(&f.key("thread")))
            .await
            .unwrap(),
        runner_host::lock::TryLock::Acquired(_)
    ));
}
