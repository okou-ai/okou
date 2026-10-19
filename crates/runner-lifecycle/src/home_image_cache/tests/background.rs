use std::os::unix::fs::MetadataExt;
use std::sync::Arc;
use std::time::Duration;

use super::super::*;
use super::support::*;
use crate::idle_pool::ParkingGate;
use crate::lifecycle::{LifecycleController, RunnerMode};

fn lifecycle() -> (
    LifecycleController,
    tokio::sync::watch::Receiver<RunnerMode>,
) {
    let (mode, receiver) = tokio::sync::watch::channel(RunnerMode::Running);
    (
        LifecycleController::new(mode, ParkingGate::new_open()),
        receiver,
    )
}

#[tokio::test]
async fn draining_stops_queued_routine_inventory_without_a_completion_marker() {
    let f = Fixture::new().await;
    let committed = f.commit("home", b"home", "2026-10-09T09:00:00Z").await;
    let paths = f.cache.entry_paths(&f.key("home"));
    let orphan = paths.tmp_image(runner_types::ids::RunId::new_v4());
    write_image(&orphan, b"unfinished-staging", SIZE);
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let (lifecycle, mode) = lifecycle();
    let cache = f
        .cache
        .clone()
        .with_background_gc_lifecycle(mode)
        .with_routine_gc_test_gate(entered.clone(), release.clone());
    let gc = tokio::spawn(async move { cache.try_routine_gc(Duration::ZERO).await });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    lifecycle.enter_soft_drain();
    release.add_permits(1);
    assert!(gc.await.unwrap().unwrap().is_none());
    assert!(
        orphan.exists(),
        "draining must not begin queued entry cleanup"
    );
    assert!(f.image("home", &committed).exists());
    assert_eq!(
        std::fs::metadata(f.cache.routine_gc_lock_path())
            .unwrap()
            .len(),
        0,
        "an interrupted pass is not completed maintenance"
    );
}

#[tokio::test]
async fn drain_resume_does_not_revive_pressure_work_from_an_old_running_generation() {
    let f = Fixture::new().await;
    let committed = f.commit("home", b"home", "2026-10-09T09:00:00Z").await;
    f.cache.set_fs_stats_for_test(FsStats {
        total_bytes: 100 * GIB,
        available_bytes: 1,
        ..FsStats::default()
    });
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let (lifecycle, mode) = lifecycle();
    let cache = f
        .cache
        .clone()
        .with_background_gc_lifecycle(mode.clone())
        .with_gc_inventory_test_gate(1, entered.clone(), release.clone());
    let gc = tokio::spawn(async move { cache.probe_home_cache_pressure().await });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    lifecycle.enter_soft_drain();
    assert!(lifecycle.resume_from_soft_drain());
    release.add_permits(1);
    gc.await.unwrap().unwrap();
    assert!(
        f.image("home", &committed).exists(),
        "a stale pre-drain pressure request cannot evict after resume"
    );
    f.cache
        .clone()
        .with_background_gc_lifecycle(mode)
        .probe_home_cache_pressure()
        .await
        .unwrap();
    f.cache.drain_pressure_reclamation().await;
    assert!(
        !f.image("home", &committed).exists(),
        "a fresh resumed request must regain background collection"
    );
}

#[tokio::test]
async fn draining_stops_partial_routine_inventory_between_entries() {
    let f = Fixture::new().await;
    let mut images = Vec::new();
    let mut orphans = Vec::new();
    for key in ["first", "second"] {
        let committed = f.commit(key, b"home", "2026-10-09T09:00:00Z").await;
        images.push(f.image(key, &committed));
        let paths = f.cache.entry_paths(&f.key(key));
        let orphan = paths.tmp_image(runner_types::ids::RunId::new_v4());
        write_image(&orphan, b"unfinished-staging", SIZE);
        orphans.push(orphan);
    }
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let (lifecycle, mode) = lifecycle();
    let cache = f
        .cache
        .clone()
        .with_background_gc_lifecycle(mode)
        .with_gc_inventory_test_gate(1, entered.clone(), release.clone());
    let gc = tokio::spawn(async move { cache.try_routine_gc(Duration::ZERO).await });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    lifecycle.enter_soft_drain();
    release.add_permits(1);
    assert!(gc.await.unwrap().unwrap().is_none());
    assert_eq!(orphans.iter().filter(|path| path.exists()).count(), 1);
    assert!(images.iter().all(|path| path.exists()));
    assert_eq!(
        std::fs::metadata(f.cache.routine_gc_lock_path())
            .unwrap()
            .len(),
        0
    );
}

#[tokio::test]
async fn draining_stops_a_pressure_turn_without_abandoning_its_held_lock() {
    let f = Fixture::new().await;
    let committed = f.commit("home", b"home", "2026-10-09T09:00:00Z").await;
    f.cache.set_fs_stats_for_test(FsStats {
        total_bytes: 100 * GIB,
        available_bytes: 1,
        ..FsStats::default()
    });
    let gate = HomeImagePrepareLockTestGate::default();
    let (lifecycle, mode) = lifecycle();
    let cache = f
        .cache
        .clone()
        .with_background_gc_lifecycle(mode)
        .with_pressure_turn_test_gate(gate.clone());
    let worker = tokio::spawn(async move { cache.probe_home_cache_pressure().await });
    gate.wait_entered(Duration::from_secs(5)).await;
    lifecycle.enter_soft_drain();
    let joined = f.cache.drain_pressure_reclamation();
    tokio::pin!(joined);
    assert!(futures_util::poll!(&mut joined).is_pending());
    assert!(matches!(
        runner_host::lock::try_acquire_or_busy(f.cache.routine_gc_lock_path())
            .await
            .unwrap(),
        runner_host::lock::TryLock::Busy
    ));
    gate.release();
    worker.await.unwrap().unwrap();
    joined.await;
    assert!(f.image("home", &committed).exists());
    let _collector = runner_host::lock::try_acquire(f.cache.routine_gc_lock_path())
        .await
        .unwrap();
}

#[tokio::test]
async fn merged_foreground_demand_does_not_inherit_a_drained_background_watermark() {
    let f = Fixture::new().await;
    let committed = f.commit("home", b"home", "2026-10-09T09:00:00Z").await;
    f.cache.set_fs_stats_for_test(FsStats {
        total_bytes: 100 * GIB,
        available_bytes: 55 * GIB,
        ..FsStats::default()
    });
    let gate = HomeImagePrepareLockTestGate::default();
    let (lifecycle, mode) = lifecycle();
    let cache = f
        .cache
        .clone()
        .with_background_gc_lifecycle(mode)
        .with_pressure_turn_test_gate(gate.clone());
    let worker = tokio::spawn(async move { cache.probe_home_cache_pressure().await });
    gate.wait_entered(Duration::from_secs(5)).await;
    let device = std::fs::metadata(f.cache.home_image_cache_dir())
        .unwrap()
        .dev();
    let foreground_cache = f.cache.clone();
    let foreground = tokio::spawn(async move {
        foreground_cache
            .reclaim_home_image_headroom(device, 51 * GIB, reclamation_deadline())
            .await
    });
    tokio::time::timeout(
        Duration::from_secs(5),
        f.cache.inner.pressure_demand_accepted.notified(),
    )
    .await
    .unwrap();
    lifecycle.enter_soft_drain();
    gate.release();
    worker.await.unwrap().unwrap();
    let outcome = foreground.await.unwrap().unwrap();
    f.cache.drain_pressure_reclamation().await;
    assert!(matches!(
        outcome.status,
        HomeCacheReclaimStatus::TargetSatisfied | HomeCacheReclaimStatus::ObserverTimedOut
    ));
    assert!(
        f.image("home", &committed).exists(),
        "51 GiB demand is already satisfied; the expired 75 GiB target cannot evict"
    );
}

#[tokio::test]
async fn foreground_accepted_while_background_retires_is_not_lost() {
    let f = Fixture::new().await;
    let committed = f.commit("home", b"home", "2026-10-09T09:00:00Z").await;
    f.cache.set_fs_stats_for_test(FsStats {
        total_bytes: 100 * GIB,
        available_bytes: 1,
        ..FsStats::default()
    });
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let completion = HomeImagePrepareLockTestGate::default();
    let (lifecycle, mode) = lifecycle();
    let mut cache = f
        .cache
        .clone()
        .with_background_gc_lifecycle(mode)
        .with_gc_inventory_test_gate(1, entered.clone(), release.clone());
    cache.pressure_completion_test_gate = Some(completion.clone());
    let worker = tokio::spawn(async move { cache.probe_home_cache_pressure().await });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    lifecycle.enter_soft_drain();
    release.add_permits(1);
    completion.wait_entered(Duration::from_secs(5)).await;
    assert!(f.image("home", &committed).exists());
    let device = std::fs::metadata(f.cache.home_image_cache_dir())
        .unwrap()
        .dev();
    let foreground_cache = f.cache.clone();
    let foreground = tokio::spawn(async move {
        foreground_cache
            .reclaim_home_image_headroom(device, 60 * GIB, reclamation_deadline())
            .await
    });
    tokio::time::timeout(
        Duration::from_secs(5),
        f.cache.inner.pressure_demand_accepted.notified(),
    )
    .await
    .unwrap();
    completion.release();
    completion.wait_entered(Duration::from_secs(5)).await;
    completion.release();
    worker.await.unwrap().unwrap();
    let outcome = foreground.await.unwrap().unwrap();
    f.cache.drain_pressure_reclamation().await;
    assert_ne!(outcome.status, HomeCacheReclaimStatus::BackgroundStopped);
    assert!(
        !f.image("home", &committed).exists(),
        "accepted foreground demand must survive background retirement"
    );
}

#[tokio::test]
async fn draining_does_not_disable_foreground_reclamation_on_a_bound_clone() {
    let f = Fixture::new().await;
    let committed = f.commit("home", b"home", "2026-10-09T09:00:00Z").await;
    f.cache.set_fs_stats_for_test(FsStats {
        total_bytes: 100 * GIB,
        available_bytes: 1,
        ..FsStats::default()
    });
    let (lifecycle, mode) = lifecycle();
    let cache = f.cache.clone().with_background_gc_lifecycle(mode);
    lifecycle.enter_soft_drain();
    let device = std::fs::metadata(f.cache.home_image_cache_dir())
        .unwrap()
        .dev();
    cache
        .reclaim_home_image_headroom(device, 60 * GIB, reclamation_deadline())
        .await
        .unwrap();
    cache.drain_pressure_reclamation().await;
    assert!(!f.image("home", &committed).exists());
}

#[tokio::test]
async fn foreground_arriving_during_interrupted_discovery_restarts_the_complete_inventory() {
    let f = Fixture::new().await;
    let mut images = Vec::new();
    for key in ["old", "middle", "new"] {
        let committed = f.commit(key, b"home", "2026-10-09T09:00:00Z").await;
        images.push(f.image(key, &committed));
    }
    f.cache.set_fs_stats_for_test(FsStats {
        total_bytes: 100 * GIB,
        available_bytes: 1,
        ..FsStats::default()
    });
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let stopped = HomeImagePrepareLockTestGate::default();
    let (lifecycle, mode) = lifecycle();
    let mut cache = f
        .cache
        .clone()
        .with_background_gc_lifecycle(mode)
        .with_gc_inventory_test_gate(1, entered.clone(), release.clone());
    cache.pressure_inventory_stopped_test_gate = Some(stopped.clone());
    let worker = tokio::spawn(async move { cache.probe_home_cache_pressure().await });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    lifecycle.enter_soft_drain();
    release.add_permits(1);
    stopped.wait_entered(Duration::from_secs(5)).await;
    let device = std::fs::metadata(f.cache.home_image_cache_dir())
        .unwrap()
        .dev();
    let foreground_cache = f.cache.clone();
    let foreground = tokio::spawn(async move {
        foreground_cache
            .reclaim_home_image_headroom(device, 60 * GIB, reclamation_deadline())
            .await
    });
    tokio::time::timeout(
        Duration::from_secs(5),
        f.cache.inner.pressure_demand_accepted.notified(),
    )
    .await
    .unwrap();
    stopped.release();
    worker.await.unwrap().unwrap();
    foreground.await.unwrap().unwrap();
    f.cache.drain_pressure_reclamation().await;
    assert!(
        images.iter().all(|image| !image.exists()),
        "accepted demand must see every eligible victim, including entries beyond the interrupted scan"
    );
}
