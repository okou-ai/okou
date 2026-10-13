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
        lease.home_drive_config().unwrap().seed_image
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
    assert!(!f.cache.entry_paths(&f.key("thread-a")).metadata().exists());
    assert!(f.cache.held_home_states().await.is_empty());
    assert!(lease.source_pin.is_some());
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
    let config = lease.home_drive_config().unwrap();
    assert!(config.seed_image.is_none());
    assert_eq!(config.space_reserve, HOME_IMAGE_SPACE_RESERVE);
    assert!(!lease.is_cache_hit());
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
    assert_eq!(
        second.lock_outcome_and_reason(),
        Some(("busy", Some("active")))
    );
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
        HomeCacheCheckoutResult::Miss
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
async fn pressured_hit_ignores_busy_capacity_and_remains_owned_during_gc() {
    use std::time::Duration;
    let mut f = Fixture::new().await;
    let selected = f
        .commit("selected", b"selected-bytes", "2026-10-09T09:00:00Z")
        .await;
    let other = f
        .commit("other", b"other-bytes", "2026-10-09T09:00:01Z")
        .await;
    f.cache = f.cache_under_pressure();
    let capacity = runner_host::lock::acquire(f.cache.capacity_lock_path())
        .await
        .unwrap();
    let mut lease = tokio::time::timeout(Duration::from_secs(10), f.lease("selected"))
        .await
        .unwrap();
    assert!(lease.is_cache_hit());
    let config = lease.home_drive_config().unwrap();
    assert_eq!(config.space_reserve, HOME_IMAGE_SPACE_RESERVE);
    let Some(sandbox::HomeDriveSeedImage::Move(source)) = config.seed_image else {
        panic!("pressured hit must expose its owned Move seed");
    };
    let expected = tokio::fs::read(&source).await.unwrap();
    assert_eq!(&expected[4096..4110], b"selected-bytes");
    assert_eq!(f.cache.gc_root_scan_count(), 0);
    drop(capacity);
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
async fn pressured_miss_does_not_wait_for_capacity_or_start_reclamation() {
    use std::time::Duration;
    let mut f = Fixture::new().await;
    let unrelated = f
        .commit("other", b"keep-other", "2026-10-09T09:00:00Z")
        .await;
    f.cache = f.cache_under_pressure();
    let capacity = runner_host::lock::acquire(f.cache.capacity_lock_path())
        .await
        .unwrap();
    let mut lease = tokio::time::timeout(Duration::from_secs(10), f.lease("missing"))
        .await
        .unwrap();
    assert_eq!(lease.result(), HomeCacheCheckoutResult::DiskPressure);
    let config = lease.home_drive_config().unwrap();
    assert!(config.seed_image.is_none());
    assert_eq!(config.space_reserve, HOME_IMAGE_SPACE_RESERVE);
    assert_eq!(f.cache.gc_root_scan_count(), 0);
    assert!(f.image("other", &unrelated).exists());
    assert!(matches!(
        runner_host::lock::try_acquire_or_busy(f.cache.capacity_lock_path())
            .await
            .unwrap(),
        runner_host::lock::TryLock::Busy
    ));
    drop(capacity);
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
    let capacity = runner_host::lock::acquire(f.cache.capacity_lock_path())
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
    drop(capacity);
}
