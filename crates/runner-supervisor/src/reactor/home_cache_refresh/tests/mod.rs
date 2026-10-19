use super::*;
use runner_host::paths::{HomePaths, RunnerPaths, home_image_cache_lock_path};

fn fixture() -> (
    tempfile::TempDir,
    HomePaths,
    HomeCacheRefresh,
    HomeImageCache,
) {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let cache = HomeImageCache::shared(RunnerPaths::new(dir.path().join("runner")), &home, "group");
    let snapshot = HomeCacheStateSnapshot::new();
    snapshot.finish_home_cache_refresh(
        snapshot.begin_home_cache_refresh(),
        HomeCacheInventory::default(),
    );
    let profiles = BTreeMap::from([(
        "vm0/default".into(),
        HeartbeatProfile {
            vcpu: 2,
            memory_mb: 4096,
            rootfs_hash: "a".repeat(64),
            home_disk_mb: 1,
        },
    )]);
    let refresh = HomeCacheRefresh::new(Some(cache.clone()), snapshot, profiles);
    (dir, home, refresh, cache)
}

async fn step(refresh: &mut HomeCacheRefresh) -> Option<HomeCacheChange> {
    tokio::time::timeout(Duration::from_secs(5), refresh.wait())
        .await
        .unwrap()
        .unwrap()
}

async fn publish(cache: &HomeImageCache, paths: &RunnerPaths, reuse_key: &str) -> String {
    use crate::home_image_cache::{
        HomeCacheTerminalStatus, HomeImageLeaseIdentity, HomeImagePrepareRequest,
    };
    use crate::storage_fingerprints::StorageFingerprints;
    let run_id = runner_types::ids::RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                rootfs_hash: &"a".repeat(64),
                reuse_key: Some(reuse_key),
                working_dir: "/home/user/workspace",
                image_size_bytes: 1024 * 1024,
            },
            home_drive_required: true,
        })
        .await;
    let active = paths.active_home_image(&sandbox_id);
    tokio::fs::create_dir_all(active.parent().unwrap())
        .await
        .unwrap();
    let image = tokio::fs::File::create(active).await.unwrap();
    image.set_len(1024 * 1024).await.unwrap();
    drop(image);
    assert!(
        lease
            .promote(
                run_id,
                HomeCacheTerminalStatus::Success,
                "2026-10-19T10:00:00Z".into(),
                &StorageFingerprints::default()
            )
            .await
            .unwrap()
    );
    runner_host::paths::scoped_home_image_cache_key("group", "vm0/default", reuse_key, 1024 * 1024)
}

async fn retry_round(refresh: &mut HomeCacheRefresh) -> Option<HomeCacheChange> {
    if refresh.task.is_some() {
        return step(refresh).await;
    }
    let deadline = refresh
        .retry_deadline()
        .expect("unresolved work must retain a wakeup");
    let now = Instant::now();
    if deadline <= now {
        return step(refresh).await;
    }
    // Only the in-process timer is paused; canonical flock/metadata IO runs
    // after resuming. Cancelling and rebuilding wait cannot renew this deadline.
    tokio::time::pause();
    {
        let wait = refresh.wait();
        tokio::pin!(wait);
        assert!(futures_util::poll!(&mut wait).is_pending());
    }
    assert_eq!(refresh.retry_deadline(), Some(deadline));
    tokio::time::advance(deadline.saturating_duration_since(Instant::now())).await;
    tokio::time::resume();
    step(refresh).await
}

#[tokio::test]
async fn home_cache_retries_bound_physical_probes_and_service_later_keys_fairly() {
    let (_dir, home, mut refresh, cache) = fixture();
    let keys = (0..40)
        .map(|index| format!("{index:064x}"))
        .collect::<Vec<_>>();
    let mut locks = Vec::new();
    for key in &keys {
        locks.push(
            runner_host::lock::acquire(home_image_cache_lock_path(&home.locks_dir(), key))
                .await
                .unwrap(),
        );
    }
    refresh.request(HomeCacheChange {
        observed_at: Instant::now(),
        dirty_cache_keys: keys.iter().cloned().collect(),
        requires_full_reconcile: false,
    });
    assert!(step(&mut refresh).await.is_none());
    assert_eq!(cache.inventory_key_probe_count(), keys.len());
    drop(locks.pop());
    cache.reset_inventory_key_probe_count();
    let mut previous = 0;
    let mut prior_start = None;
    for _ in 0..3 {
        assert!(retry_round(&mut refresh).await.is_none());
        let probes = cache.inventory_key_probe_count();
        assert!(probes - previous <= RETRY_KEYS_PER_ROUND);
        previous = probes;
        let start = refresh.retry_not_before - RETRY_ROUND_INTERVAL;
        if let Some(prior) = prior_start {
            assert!(
                start >= prior + RETRY_ROUND_INTERVAL,
                "round limits must also bound aggregate probe rate"
            );
        }
        prior_start = Some(start);
    }
    assert!(
        !refresh.busy_keys.contains_key(keys.last().unwrap()),
        "a later due key must be checked despite persistent earlier holders"
    );
    assert_eq!(cache.held_state_root_scan_count(), 0);
    let first = &keys[0];
    let previous_deadline = refresh.busy_keys[first].retry_at;
    let previous_delay = refresh.busy_keys[first].delay;
    refresh.request(HomeCacheChange {
        observed_at: Instant::now(),
        dirty_cache_keys: BTreeSet::from(["f".repeat(64)]),
        requires_full_reconcile: false,
    });
    assert_eq!(refresh.busy_keys[first].retry_at, previous_deadline);
    assert_eq!(
        refresh.busy_keys[first].delay, previous_delay,
        "unrelated traffic cannot reset a cold key's backoff"
    );
    refresh.drain().await.unwrap();
    assert!(refresh.retry_deadline().is_none());
    drop(locks);
}

#[tokio::test]
async fn busy_home_cache_retries_do_not_refill_a_truncated_snapshot_or_emit_changes() {
    let (_dir, home, mut refresh, cache) = fixture();
    let snapshot = &refresh.context.snapshot;
    let mut inventory = HomeCacheInventory::default();
    inventory.truncated = true;
    snapshot.finish_home_cache_refresh(snapshot.begin_home_cache_refresh(), inventory);
    let key = "a".repeat(64);
    let _lock = runner_host::lock::acquire(home_image_cache_lock_path(&home.locks_dir(), &key))
        .await
        .unwrap();
    // Model a busy hint already withdrawn by the preceding accepted full scan.
    let now = Instant::now();
    refresh.busy_keys.insert(
        key,
        BusyKey {
            observed_at: now,
            retry_at: now + RETRY_INITIAL_DELAY,
            delay: RETRY_INITIAL_DELAY,
        },
    );
    for _ in 0..3 {
        assert!(retry_round(&mut refresh).await.is_none());
    }
    assert_eq!(cache.inventory_key_probe_count(), 3);
    assert_eq!(cache.held_state_root_scan_count(), 0);
    assert!(!refresh.full_refresh_in_flight);
    refresh.drain().await.unwrap();
}

#[tokio::test]
async fn repeated_home_cache_events_stay_inside_the_contention_probe_budget() {
    let (_dir, home, mut refresh, cache) = fixture();
    let key = "b".repeat(64);
    let _lock = runner_host::lock::acquire(home_image_cache_lock_path(&home.locks_dir(), &key))
        .await
        .unwrap();
    let change = HomeCacheChange {
        observed_at: Instant::now(),
        dirty_cache_keys: BTreeSet::from([key.clone()]),
        requires_full_reconcile: false,
    };
    refresh.request(change.clone());
    // Deliver another event before the initial busy result is joined. The
    // newer mutation must remain pending without losing contention ownership.
    refresh.request(change.clone());
    assert!(step(&mut refresh).await.is_none());
    assert!(refresh.busy_keys.contains_key(&key));
    assert!(refresh.task.is_none());
    assert_eq!(cache.inventory_key_probe_count(), 1);
    tokio::time::pause();
    let deadline = refresh.retry_deadline().unwrap();
    for _ in 0..1000 {
        refresh.request(change.clone());
    }
    assert!(refresh.task.is_none());
    assert_eq!(refresh.retry_deadline(), Some(deadline));
    assert_eq!(cache.inventory_key_probe_count(), 1);
    tokio::time::resume();
    assert!(retry_round(&mut refresh).await.is_none());
    assert_eq!(cache.inventory_key_probe_count(), 2);
    assert_eq!(cache.held_state_root_scan_count(), 0);
    refresh.drain().await.unwrap();
}

#[tokio::test]
async fn home_cache_retry_saturation_reconciles_once_and_retires_stale_history() {
    use crate::home_image_cache::HomeImagePrepareLockTestGate;
    let (dir, home, mut refresh, cache) = fixture();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let key = publish(&cache, &paths, "still-busy").await;
    let blocker = runner_host::lock::acquire(home_image_cache_lock_path(&home.locks_dir(), &key))
        .await
        .unwrap();
    // Retained hints can outlive their external holders. Seed the saturated
    // receipt state directly so the setup does not depend on racing retry ticks
    // or holding 1,024 kernel descriptors open simultaneously.
    let now = Instant::now();
    for index in 0..MAX_HELD_HOME_STATES {
        refresh.busy_keys.insert(
            format!("{index:064x}"),
            BusyKey {
                observed_at: now,
                retry_at: now + RETRY_MAX_DELAY,
                delay: RETRY_MAX_DELAY,
            },
        );
    }
    let gate = HomeImagePrepareLockTestGate::default();
    refresh.context.cache = Some(cache.clone().with_inventory_test_gate(gate.clone()));
    refresh.request(HomeCacheChange {
        observed_at: now,
        dirty_cache_keys: BTreeSet::from([key.clone()]),
        requires_full_reconcile: false,
    });
    assert!(step(&mut refresh).await.is_none());
    gate.wait_entered(Duration::from_secs(5)).await;
    gate.release();
    assert!(step(&mut refresh).await.is_none());
    assert_eq!(refresh.busy_keys.len(), 1);
    assert!(refresh.busy_keys.contains_key(&key));
    assert_eq!(cache.held_state_root_scan_count(), 1);
    drop(blocker);
    assert!(retry_round(&mut refresh).await.is_some());
    assert_eq!(
        refresh.context.snapshot.loaded_home_cache_snapshot().states[0].reuse_key,
        "still-busy"
    );
    assert_eq!(cache.held_state_root_scan_count(), 1);
    assert!(refresh.retry_deadline().is_none());
    refresh.drain().await.unwrap();
}

#[tokio::test]
async fn incomplete_home_cache_scan_keeps_known_publications_owned_for_retry() {
    use crate::home_image_cache::HomeImagePrepareLockTestGate;
    for loaded in [false, true] {
        let (dir, home, mut refresh, cache) = fixture();
        if !loaded {
            refresh.context.snapshot = HomeCacheStateSnapshot::new();
        }
        let paths = RunnerPaths::new(dir.path().join("runner"));
        let key = publish(&cache, &paths, "incomplete-scan").await;
        let gate = HomeImagePrepareLockTestGate::default();
        refresh.context.cache = Some(cache.clone().with_inventory_test_gate(gate.clone()));
        refresh.request(HomeCacheChange {
            observed_at: Instant::now(),
            dirty_cache_keys: BTreeSet::from([key.clone()]),
            requires_full_reconcile: true,
        });
        gate.wait_entered(Duration::from_secs(5)).await;
        let root = home.home_image_cache_dir();
        let retained = root.with_extension("retained");
        tokio::fs::rename(&root, &retained).await.unwrap();
        tokio::fs::write(&root, b"not a directory").await.unwrap();
        gate.release();
        assert!(step(&mut refresh).await.is_none());
        assert!(
            refresh.busy_keys.contains_key(&key),
            "a positive read rejected with an incomplete scan must not lose its retry owner"
        );
        assert!(
            refresh
                .context
                .snapshot
                .loaded_home_cache_snapshot()
                .states
                .is_empty()
        );
        tokio::fs::remove_file(&root).await.unwrap();
        tokio::fs::rename(&retained, &root).await.unwrap();
        assert!(retry_round(&mut refresh).await.is_some());
        assert_eq!(
            refresh.context.snapshot.loaded_home_cache_snapshot().states[0].reuse_key,
            "incomplete-scan"
        );
        assert_eq!(cache.held_state_root_scan_count(), 1);
        assert_eq!(
            refresh.context.snapshot.home_cache_loaded(),
            loaded,
            "a targeted retry must not invent completeness for an unknown global view"
        );
        assert!(refresh.retry_deadline().is_none());
        refresh.drain().await.unwrap();
    }
}
