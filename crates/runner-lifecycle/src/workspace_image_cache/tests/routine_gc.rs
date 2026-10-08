use std::io::Write;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{Notify, Semaphore};
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

use super::super::{
    CacheBudget, FsStats, TEST_FS_AVAILABLE_BYTES, TEST_FS_TOTAL_BYTES,
    WorkspaceCacheCheckoutResult, WorkspaceCacheTerminalStatus, WorkspaceImageCache,
    WorkspaceImageLeaseIdentity, WorkspaceImagePrepareRequest, WorkspaceImagePromotionOutcome,
    WorkspaceImagePromotionRequest,
};
use super::support::{
    TEST_PROFILE_NAME, local_cache, promote_current_cache_entry, timestamp_for_index,
    write_current_cache_entry,
};
use crate::storage_fingerprints::StorageFingerprints;
use runner_host::paths::{HomePaths, RunnerPaths};
use runner_types::ids::RunId;
use runner_types::types::MAX_HELD_WORKSPACE_STATES;

const DEADLINE: Duration = Duration::from_secs(10);
const INTERVAL: Duration = Duration::from_secs(60);

struct GcGate {
    entered: Arc<Notify>,
    release: Arc<Semaphore>,
}

impl GcGate {
    fn new() -> Self {
        Self {
            entered: Arc::new(Notify::new()),
            release: Arc::new(Semaphore::new(0)),
        }
    }

    fn during_inventory(
        &self,
        cache: WorkspaceImageCache,
        after_entries: usize,
    ) -> WorkspaceImageCache {
        cache.with_gc_inventory_test_gate(
            after_entries,
            Arc::clone(&self.entered),
            Arc::clone(&self.release),
        )
    }

    async fn wait(&self) {
        tokio::time::timeout(DEADLINE, self.entered.notified())
            .await
            .expect("routine GC must reach its inventory gate");
    }

    fn resume(&self) {
        self.release.add_permits(1);
    }
}

fn start_gc(cache: WorkspaceImageCache) -> tokio::task::JoinHandle<Option<u64>> {
    tokio::spawn(async move { cache.try_routine_gc(INTERVAL).await.unwrap() })
}

async fn finish_gc(task: tokio::task::JoinHandle<Option<u64>>) -> Option<u64> {
    tokio::time::timeout(DEADLINE, task)
        .await
        .expect("routine GC must finish")
        .unwrap()
}

#[tokio::test]
async fn promotion_publishes_during_many_entry_inventory_and_survives_cleanup() {
    let (_dir, paths, cache) = local_cache().await;
    for index in 0..64 {
        write_current_cache_entry(
            &cache,
            RunId::new_v4(),
            &format!("inventory-{index}"),
            "/workspace",
            &timestamp_for_index(index),
            &timestamp_for_index(index),
        )
        .await;
    }
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let reuse_key = "finishing-during-inventory";
    let key = cache.scoped_cache_key(TEST_PROFILE_NAME, reuse_key, "/workspace", 5);
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
        .await
        .unwrap();
    tokio::fs::create_dir_all(cache.entry_paths(&key).entry_dir())
        .await
        .unwrap();
    let staging = cache.entry_paths(&key).tmp_image(RunId::new_v4());
    tokio::fs::write(&staging, b"active staging").await.unwrap();
    let promotion = lease
        .into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            restored_session_identity: None,
            terminal_status: WorkspaceCacheTerminalStatus::Success,
            completed_at: "2026-05-01T01:00:00.000Z".into(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .unwrap();

    // Pause halfway through a many-entry inventory. Finalization keeps the
    // target entry locked throughout the scan, so its staging cannot be
    // classified as orphaned either before or after publication.
    let gate = GcGate::new();
    let scanner = gate.during_inventory(cache.clone(), 32);
    let task = start_gc(scanner);
    gate.wait().await;
    assert!(staging.exists());
    let outcome = tokio::time::timeout(
        DEADLINE,
        promotion.promote_without_session_history_sidecar(),
    )
    .await
    .expect("publication must not await the routine scan")
    .unwrap();
    assert_eq!(outcome, WorkspaceImagePromotionOutcome::Promoted);
    assert_eq!(
        tokio::fs::read(cache.entry_paths(&key).current_image())
            .await
            .unwrap(),
        b"image"
    );
    gate.resume();
    assert_eq!(finish_gc(task).await, Some(0));
    assert!(
        staging.exists(),
        "the busy target was not cleaned during inventory"
    );
    drop(promotion);
    assert!(
        cache
            .held_workspace_states()
            .await
            .iter()
            .any(|state| state.reuse_key == reuse_key)
    );
    assert!(cache.try_routine_gc(Duration::ZERO).await.unwrap().unwrap() > 0);
    assert!(
        !staging.exists(),
        "unowned staging must be cleaned on a later pass"
    );
    let next = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(next.result(), WorkspaceCacheCheckoutResult::Hit);
}

#[tokio::test]
async fn in_flight_routine_gc_excludes_other_groups_without_holding_capacity() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let cache_a = WorkspaceImageCache::shared(RunnerPaths::new(dir.path().join("a")), &home, "a");
    let cache_b = WorkspaceImageCache::shared(RunnerPaths::new(dir.path().join("b")), &home, "b");
    let gate = GcGate::new();
    let scanner = cache_a
        .clone()
        .with_routine_gc_test_gate(Arc::clone(&gate.entered), Arc::clone(&gate.release));
    let task = start_gc(scanner);
    gate.wait().await;

    let capacity = runner_host::lock::try_acquire(cache_b.capacity_lock_path())
        .await
        .unwrap();
    drop(capacity);
    assert_eq!(cache_b.try_routine_gc(INTERVAL).await.unwrap(), None);
    gate.resume();
    assert_eq!(finish_gc(task).await, Some(0));
    assert_eq!(cache_b.try_routine_gc(INTERVAL).await.unwrap(), None);
}

#[tokio::test]
async fn busy_capacity_after_inventory_leaves_completion_retryable() {
    let (_dir, _paths, cache) = local_cache().await;
    let key = write_current_cache_entry(
        &cache,
        RunId::new_v4(),
        "busy-after-scan",
        "/workspace",
        &timestamp_for_index(0),
        &timestamp_for_index(0),
    )
    .await;
    let gate = GcGate::new();
    let task = start_gc(gate.during_inventory(cache.clone(), 1));
    gate.wait().await;
    let capacity = runner_host::lock::acquire(cache.capacity_lock_path())
        .await
        .unwrap();
    gate.resume();
    assert_eq!(finish_gc(task).await, None);
    assert_eq!(capacity.metadata().unwrap().len(), 0);
    drop(capacity);

    assert_eq!(cache.try_routine_gc(INTERVAL).await.unwrap(), Some(0));
    assert!(cache.entry_paths(&key).current_image().exists());
    assert_eq!(cache.held_workspace_states().await.len(), 1);
    assert!(std::fs::metadata(cache.capacity_lock_path()).unwrap().len() > 0);
}

#[tokio::test]
async fn old_runner_completion_during_inventory_preserves_shared_cadence() {
    let (_dir, _paths, cache) = local_cache().await;
    let key = write_current_cache_entry(
        &cache,
        RunId::new_v4(),
        "old-runner-marker",
        "/workspace",
        &timestamp_for_index(0),
        &timestamp_for_index(0),
    )
    .await;
    let gate = GcGate::new();
    let task = start_gc(gate.during_inventory(cache.clone(), 1));
    gate.wait().await;
    let mut old_capacity = runner_host::lock::acquire(cache.capacity_lock_path())
        .await
        .unwrap();
    old_capacity.write_all(b"old opaque marker").unwrap();
    let completion = old_capacity.metadata().unwrap().modified().unwrap();
    drop(old_capacity);
    gate.resume();

    assert_eq!(finish_gc(task).await, None);
    assert_eq!(
        std::fs::metadata(cache.capacity_lock_path())
            .unwrap()
            .modified()
            .unwrap(),
        completion
    );
    assert_eq!(cache.try_routine_gc(INTERVAL).await.unwrap(), None);
    assert!(cache.entry_paths(&key).current_image().exists());
    assert_eq!(cache.held_workspace_states().await.len(), 1);
}

#[tokio::test]
async fn pressure_rescan_preserves_an_image_replaced_during_inventory() {
    let (_dir, paths, healthy) = local_cache().await;
    let budget = CacheBudget::from_fs_stats(FsStats {
        total_bytes: TEST_FS_TOTAL_BYTES,
        available_bytes: TEST_FS_AVAILABLE_BYTES,
    });
    let pressure = WorkspaceImageCache::with_cache_dirs_and_fs_stats(
        paths.clone(),
        healthy.inner.cache_dir.clone(),
        healthy.inner.lock_dir.clone(),
        "",
        FsStats {
            total_bytes: TEST_FS_TOTAL_BYTES,
            available_bytes: budget.min_free_bytes - 1,
        },
    );
    let replaced = write_current_cache_entry(
        &healthy,
        RunId::new_v4(),
        "replaced",
        "/workspace",
        &timestamp_for_index(0),
        &timestamp_for_index(0),
    )
    .await;
    let evicted = write_current_cache_entry(
        &healthy,
        RunId::new_v4(),
        "evicted",
        "/workspace",
        &timestamp_for_index(1),
        &timestamp_for_index(1),
    )
    .await;
    let gate = GcGate::new();
    let task = start_gc(gate.during_inventory(pressure, 2));
    gate.wait().await;
    let replacement = b"image-replaced";
    let key = promote_current_cache_entry(
        &healthy,
        &paths,
        "replaced",
        replacement,
        "2026-05-01T01:00:00.000Z",
    )
    .await;
    assert_eq!(key, replaced);
    gate.resume();

    assert!(finish_gc(task).await.unwrap() > 0);
    assert_eq!(
        tokio::fs::read(healthy.entry_paths(&replaced).current_image())
            .await
            .unwrap(),
        replacement
    );
    assert!(!healthy.entry_paths(&evicted).current_image().exists());
    let held = healthy.held_workspace_states().await;
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].reuse_key, "replaced");
}

#[tokio::test]
async fn entry_limit_rescan_accounts_for_promotions_after_inventory() {
    let (_dir, paths, cache) = local_cache().await;
    let mut keys = Vec::new();
    for index in 0..=MAX_HELD_WORKSPACE_STATES {
        keys.push(
            write_current_cache_entry(
                &cache,
                RunId::new_v4(),
                &format!("limit-{index}"),
                "/workspace",
                &timestamp_for_index(index),
                &timestamp_for_index(index),
            )
            .await,
        );
    }
    let gate = GcGate::new();
    let task = start_gc(gate.during_inventory(cache.clone(), MAX_HELD_WORKSPACE_STATES + 1));
    gate.wait().await;
    let published = promote_current_cache_entry(
        &cache,
        &paths,
        "added-after-inventory",
        b"new image",
        "2026-05-01T01:00:00.000Z",
    )
    .await;
    gate.resume();

    assert!(finish_gc(task).await.unwrap() > 0);
    assert!(!cache.entry_paths(&keys[0]).current_image().exists());
    assert!(
        !cache.entry_paths(&keys[1]).current_image().exists(),
        "fresh inventory must count the concurrent addition and evict two entries"
    );
    assert!(cache.entry_paths(&keys[2]).current_image().exists());
    assert!(cache.entry_paths(&published).current_image().exists());
    let held = cache.held_workspace_states().await;
    assert_eq!(held.len(), MAX_HELD_WORKSPACE_STATES);
    assert!(
        held.iter()
            .any(|state| state.reuse_key == "added-after-inventory")
    );
}

#[tokio::test]
#[ignore = "manual representative GC scan/capacity-held measurement, no timing thresholds"]
async fn measure_routine_gc_inventory_and_capacity_hold() {
    println!(
        "entries,baseline_capacity_held_us,inventory_us,routine_capacity_held_us,routine_total_us"
    );
    for entry_count in [1, 64, 256, MAX_HELD_WORKSPACE_STATES - 1] {
        let (_dir, _paths, cache) = local_cache().await;
        for index in 0..entry_count {
            write_current_cache_entry(
                &cache,
                RunId::new_v4(),
                &format!("measurement-{index}"),
                "/workspace",
                &timestamp_for_index(index),
                &timestamp_for_index(index),
            )
            .await;
        }
        let capacity = runner_host::lock::acquire(cache.capacity_lock_path())
            .await
            .unwrap();
        let baseline_started = Instant::now();
        assert_eq!(cache.gc_locked(false).await.unwrap(), 0);
        let baseline_capacity_held = baseline_started.elapsed();
        drop(capacity);

        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let guard = tracing::subscriber::set_default(subscriber);
        tracing::callsite::rebuild_interest_cache();
        let started = Instant::now();
        assert_eq!(cache.try_routine_gc(Duration::ZERO).await.unwrap(), Some(0));
        let elapsed = started.elapsed();
        drop(guard);
        let events = captured.entries();
        let completed = events
            .iter()
            .find(|event| {
                event
                    .fields
                    .get("message")
                    .is_some_and(|message| message == "workspace image cache routine GC completed")
            })
            .unwrap();
        println!(
            "{entry_count},{},{},{},{}",
            baseline_capacity_held.as_micros(),
            completed.fields.get("inventory_us").unwrap(),
            completed.fields.get("capacity_lock_held_us").unwrap(),
            elapsed.as_micros()
        );
        assert_eq!(cache.held_workspace_states().await.len(), entry_count);
    }
}
