use super::super::*;
use super::support::*;
use crate::storage_fingerprints::StorageFingerprints;
use runner_types::ids::RunId;

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
    let mut lease = f.lease("thread").await;
    assert!(lease.is_cache_hit());
    let image = f.image("thread", &committed);
    let pinned_old = f.dir.path().join("pinned-original.ext4");
    std::fs::rename(&image, &pinned_old).unwrap();
    write_image(&image, b"replacement", SIZE);
    let config = lease.home_drive_config().unwrap();
    assert!(config.seed_image.is_none());
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
        (PROFILE, "different-full-rootfs", "thread", SIZE),
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
