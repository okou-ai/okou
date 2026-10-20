use super::super::super::*;
use super::super::support::{
    minimal_context, mock_run_config_with_overrides, push_job, shutdown, test_profiles,
    wait_discover_entered, wait_idle_pool_len,
};
use super::home_cache::wait_heartbeat_matching_after;
use crate::heartbeat::{HeartbeatProfile, refresh_initial_home_cache_snapshot};
use crate::home_image_cache::{
    HomeCacheChange, HomeCacheTerminalStatus, HomeCacheWatcher, HomeImageCache,
    HomeImageLeaseIdentity, HomeImagePrepareRequest, HomeImagePromotionContext,
    HomeImagePromotionOutcome, HomeImagePromotionRequest,
};
use crate::storage_fingerprints::StorageFingerprints;
use runner_host::paths::{
    HomePaths, RunnerPaths, home_image_cache_lock_path, scoped_home_image_cache_key,
};
use sandbox::SandboxId;
use std::collections::{BTreeMap, BTreeSet};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use super::super::super::home_cache_refresh::HomeCacheRefresh;

const SIZE: u64 = 1024 * 1024;
const PROFILE: &str = "vm0/default";
const ROOTFS: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MARKER: &[u8] = b"recovered-cache-image";

async fn publish_held(
    cache: &HomeImageCache,
    paths: &RunnerPaths,
    reuse_key: &str,
) -> HomeImagePromotionContext {
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let lease = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: PROFILE,
                rootfs_hash: ROOTFS,
                reuse_key: Some(reuse_key),
                working_dir: "/home/user/workspace",
                image_size_bytes: SIZE,
            },
            home_drive_required: true,
        })
        .await;
    let path = paths.active_home_image(&sandbox_id);
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .unwrap();
    let mut image = tokio::fs::File::create(path).await.unwrap();
    image.set_len(SIZE).await.unwrap();
    image.seek(std::io::SeekFrom::Start(4096)).await.unwrap();
    image.write_all(MARKER).await.unwrap();
    drop(image);
    let promotion = lease
        .into_promotion_context(HomeImagePromotionRequest {
            run_id,
            sandbox_id,
            restored_session_identity: None,
            terminal_status: HomeCacheTerminalStatus::Success,
            completed_at: "2026-10-19T10:00:00Z".into(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .unwrap();
    assert_eq!(
        promotion.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    promotion
}

struct Fixture {
    _dir: tempfile::TempDir,
    home: HomePaths,
    publisher_paths: RunnerPaths,
    publisher: HomeImageCache,
    cache: HomeImageCache,
    snapshot: HomeCacheStateSnapshot,
    profiles: BTreeMap<String, HeartbeatProfile>,
}

impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let observer_paths = RunnerPaths::new(dir.path().join("observer"));
        let publisher_paths = RunnerPaths::new(dir.path().join("publisher"));
        tokio::fs::create_dir_all(observer_paths.base_dir())
            .await
            .unwrap();
        tokio::fs::create_dir_all(publisher_paths.base_dir())
            .await
            .unwrap();
        let cache = HomeImageCache::shared(observer_paths, &home, "group-a");
        let publisher = HomeImageCache::shared(publisher_paths.clone(), &home, "group-a");
        let snapshot = HomeCacheStateSnapshot::new();
        let mut runtime_profiles = test_profiles();
        runtime_profiles.get_mut(PROFILE).unwrap().home_disk_mb = 1;
        let profiles = heartbeat_profiles(&runtime_profiles);
        refresh_initial_home_cache_snapshot(&snapshot, Some(&cache), &profiles).await;
        Self {
            _dir: dir,
            home,
            publisher_paths,
            publisher,
            cache,
            snapshot,
            profiles,
        }
    }

    fn key(&self, reuse_key: &str) -> String {
        scoped_home_image_cache_key("group-a", PROFILE, reuse_key, SIZE)
    }

    fn refresh(&self) -> HomeCacheRefresh {
        HomeCacheRefresh::new(
            Some(self.cache.clone()),
            self.snapshot.clone(),
            self.profiles.clone(),
        )
    }

    async fn step(refresh: &mut HomeCacheRefresh) -> Option<HomeCacheChange> {
        tokio::time::timeout(Duration::from_secs(5), refresh.wait())
            .await
            .unwrap()
            .unwrap()
    }
}

#[tokio::test]
async fn coalesced_home_cache_publication_recovers_while_an_earlier_key_stays_locked() {
    let f = Fixture::new().await;
    let mut reuse_keys = ["thread:coalesced-a", "thread:coalesced-b"];
    reuse_keys.sort_by_key(|key| f.key(key));
    let [a, b] = reuse_keys;
    drop(publish_held(&f.publisher, &f.publisher_paths, a).await);
    let initial =
        refresh_initial_home_cache_snapshot(&f.snapshot, Some(&f.cache), &f.profiles).await;
    let mut watcher = HomeCacheWatcher::new(f.cache.clone()).await.unwrap();
    watcher
        .reconcile_initial_relevant_entries(&initial.loaded_cache_keys)
        .await
        .unwrap();
    let a_key = f.key(a);
    let b_key = f.key(b);
    let a_lock =
        runner_host::lock::acquire(home_image_cache_lock_path(&f.home.locks_dir(), &a_key))
            .await
            .unwrap();
    tokio::fs::remove_file(
        f.home
            .home_image_cache_dir()
            .join(&a_key)
            .join("metadata.json"),
    )
    .await
    .unwrap();
    let promotion = publish_held(&f.publisher, &f.publisher_paths, b).await;
    let mut change = tokio::time::timeout(Duration::from_secs(5), watcher.next_change())
        .await
        .unwrap()
        .unwrap();
    while !change.dirty_cache_keys.contains(&a_key) || !change.dirty_cache_keys.contains(&b_key) {
        change.merge(
            tokio::time::timeout(Duration::from_secs(5), watcher.next_change())
                .await
                .unwrap()
                .unwrap(),
        );
    }
    assert!(!change.requires_full_reconcile);
    f.cache.reset_inventory_key_probe_count();
    f.cache.reset_held_state_root_scan_count();
    let mut refresh = f.refresh();
    refresh.request(change);
    Fixture::step(&mut refresh).await;
    assert!(f.snapshot.loaded_home_cache_snapshot().states.is_empty());
    assert_eq!(f.cache.inventory_key_probe_count(), 2);
    let unlocked_at = std::time::Instant::now();
    drop(promotion);
    assert!(
        tokio::time::timeout(Duration::from_millis(20), watcher.next_change())
            .await
            .is_err(),
        "used publication custody release must not be the recovery wakeup"
    );
    assert!(Fixture::step(&mut refresh).await.is_some());
    let states = f.snapshot.loaded_home_cache_snapshot().states;
    assert_eq!(states.len(), 1);
    assert_eq!(states[0].reuse_key, b);
    assert_eq!(f.cache.inventory_key_probe_count(), 4);
    assert_eq!(f.cache.held_state_root_scan_count(), 0);
    eprintln!(
        "home-cache fixture: unlock_to_snapshot_us={}, probes=4, root_scans=0",
        unlocked_at.elapsed().as_micros()
    );
    drop(a_lock);
    refresh.drain().await.unwrap();
}

#[tokio::test]
async fn overdue_home_cache_pending_batch_recovers_and_unlocked_pending_control_stays_valid() {
    use runner_lifecycle::home_image_cache::HomeImagePrepareLockTestGate;
    for remains_locked in [false, true] {
        let f = Fixture::new().await;
        let gate = HomeImagePrepareLockTestGate::default();
        let mut refresh = HomeCacheRefresh::new(
            Some(f.cache.clone().with_inventory_test_gate(gate.clone())),
            f.snapshot.clone(),
            f.profiles.clone(),
        );
        refresh.request_reconciliation();
        gate.wait_entered(Duration::from_secs(5)).await;
        refresh.request(HomeCacheChange {
            observed_at: tokio::time::Instant::now() - Duration::from_secs(3),
            dirty_cache_keys: BTreeSet::from(["0".repeat(64)]),
            requires_full_reconcile: false,
        });
        let b = "thread:pending-publication";
        let promotion = publish_held(&f.publisher, &f.publisher_paths, b).await;
        refresh.request(HomeCacheChange {
            observed_at: tokio::time::Instant::now(),
            dirty_cache_keys: BTreeSet::from([f.key(b)]),
            requires_full_reconcile: false,
        });
        let promotion = if remains_locked {
            Some(promotion)
        } else {
            drop(promotion);
            None
        };
        gate.release();
        Fixture::step(&mut refresh).await;
        Fixture::step(&mut refresh).await;
        if remains_locked {
            assert!(f.snapshot.loaded_home_cache_snapshot().states.is_empty());
            drop(promotion);
            assert!(Fixture::step(&mut refresh).await.is_some());
        }
        assert_eq!(
            f.snapshot.loaded_home_cache_snapshot().states[0].reuse_key,
            b
        );
        assert_eq!(
            f.cache.held_state_root_scan_count(),
            2,
            "only bootstrap and explicitly requested reconciliation may scan the root"
        );
        refresh.drain().await.unwrap();
    }
}

#[tokio::test]
async fn uncontended_home_cache_update_uses_one_probe_and_leaves_no_idle_polling() {
    let f = Fixture::new().await;
    let b = "thread:uncontended";
    drop(publish_held(&f.publisher, &f.publisher_paths, b).await);
    f.cache.reset_inventory_key_probe_count();
    f.cache.reset_held_state_root_scan_count();
    let mut refresh = f.refresh();
    refresh.request(HomeCacheChange {
        observed_at: tokio::time::Instant::now(),
        dirty_cache_keys: BTreeSet::from([f.key(b)]),
        requires_full_reconcile: false,
    });
    assert!(Fixture::step(&mut refresh).await.is_some());
    tokio::time::pause();
    {
        let wait = refresh.wait();
        tokio::pin!(wait);
        assert!(futures_util::poll!(&mut wait).is_pending());
        tokio::time::advance(Duration::from_secs(120)).await;
        assert!(futures_util::poll!(&mut wait).is_pending());
    }
    tokio::time::resume();
    assert_eq!(f.cache.inventory_key_probe_count(), 1);
    assert_eq!(f.cache.held_state_root_scan_count(), 0);
    refresh.drain().await.unwrap();
}

#[tokio::test]
async fn bootstrap_home_cache_recovery_supplies_the_image_instead_of_an_available_blank() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let mut profiles = test_profiles();
    profiles.get_mut(PROFILE).unwrap().home_disk_mb = 1;
    let (mut config, env) =
        mock_run_config_with_overrides(profiles, 16, 32768, 8, overrides.clone());
    let home = config.paths.home.clone();
    let group = config.runner.group.clone();
    let cache = HomeImageCache::shared(
        RunnerPaths::new(config.paths.base_dir.clone()),
        &home,
        &group,
    );
    Arc::get_mut(&mut config.exec_config).unwrap().home_cache = Some(cache.clone());
    let publisher_paths = RunnerPaths::new(env._temp_dir.path().join("publisher"));
    tokio::fs::create_dir_all(publisher_paths.base_dir())
        .await
        .unwrap();
    let publisher = HomeImageCache::shared(publisher_paths.clone(), &home, &group);
    let reuse_key = "thread:bootstrap-recovery";
    let promotion = publish_held(&publisher, &publisher_paths, reuse_key).await;
    let generation = promotion.publication_generation();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_idle_pool_len(&env.idle_pool, 1, Duration::from_secs(5)).await;
    let blank_id = env.idle_pool.lock().await.status_snapshot().blank_sandboxes[0].sandbox_id;
    let before = env.handle.heartbeat_count();
    let scans = cache.held_state_root_scan_count();
    drop(promotion);
    assert!(
        wait_heartbeat_matching_after(&env.handle, before, Duration::from_secs(5), |state| {
            state
                .held_home_states
                .iter()
                .any(|state| state.reuse_key == reuse_key)
        })
        .await,
        "bootstrap's unresolved publication must recover without a routine reconciliation"
    );
    assert_eq!(cache.held_state_root_scan_count(), scans);
    let gate = sandbox_mock::MockLifecycleGate::new();
    overrides.set_create_lifecycle_gate(gate.clone());
    let run_id = RunId::new_v4();
    let mut context = minimal_context(run_id);
    context.reuse_key = Some(reuse_key.into());
    push_job(&env, run_id, PROFILE, Some(context));
    gate.wait_entered(1, Duration::from_secs(5))
        .await
        .expect("the recovered home must use fresh creation instead of the blank");
    let configs = overrides.create_configs();
    let created = configs.last().unwrap();
    let Some(sandbox::HomeDriveSeedImage::Move(source)) =
        &created.home_drive.as_ref().unwrap().seed_image
    else {
        panic!("the new sandbox must receive the recovered immutable image");
    };
    assert_eq!(
        source.file_name().unwrap().to_str().unwrap(),
        format!("image-{generation}.ext4")
    );
    assert_eq!(
        &tokio::fs::read(source).await.unwrap()[4096..4096 + MARKER.len()],
        MARKER
    );
    let key = scoped_home_image_cache_key(&group, PROFILE, reuse_key, SIZE);
    assert!(
        !home
            .home_image_cache_dir()
            .join(key)
            .join("metadata.json")
            .exists(),
        "the real checkout must revoke the selected commit"
    );
    assert_ne!(created.id, blank_id);
    gate.release_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("cache-backed run must complete");
    assert_eq!(completion.exit_code, 0);
    assert_ne!(completion.sandbox_id, Some(blank_id));
    shutdown(&env, run_handle).await;
}
