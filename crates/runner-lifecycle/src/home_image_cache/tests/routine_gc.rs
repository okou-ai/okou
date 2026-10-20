use super::super::{HomeCacheCheckoutResult, HomeCacheTerminalStatus, HomeImagePromotionOutcome};
use super::support::*;
use crate::storage_fingerprints::StorageFingerprints;
use runner_types::ids::RunId;
use std::sync::Arc;

use super::allocation_scan::wait_entered;
use std::time::Duration;

const CADENCE_CHILD_ROOT: &str = "OKOU_HOME_GC_CADENCE_CHILD_ROOT";

#[tokio::test]
async fn manual_and_pressure_collection_do_not_complete_or_postpone_routine_maintenance() {
    for completed in [false, true] {
        let f = Fixture::new().await;
        let committed = f.commit("home", b"home", "2026-10-09T09:00:00Z").await;
        f.cache.set_fs_stats_for_test(super::super::FsStats {
            total_bytes: 100 * super::super::GIB,
            available_bytes: 75 * super::super::GIB,
            ..super::super::FsStats::default()
        });
        if completed {
            assert!(
                f.cache
                    .try_routine_gc(Duration::ZERO)
                    .await
                    .unwrap()
                    .is_some()
            );
        }
        let collector = runner_host::lock::acquire(f.cache.routine_gc_lock_path())
            .await
            .unwrap();
        collector
            .set_times(
                std::fs::FileTimes::new()
                    .set_modified(std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1)),
            )
            .unwrap();
        let before = collector.metadata().unwrap();
        assert_eq!(before.len(), u64::from(completed));
        drop(collector);

        assert_eq!(f.cache.gc(true).await.unwrap(), 0);
        assert!(f.image("home", &committed).exists());
        let after_manual = std::fs::metadata(f.cache.routine_gc_lock_path()).unwrap();
        assert_eq!(after_manual.len(), before.len());
        assert_eq!(after_manual.modified().unwrap(), before.modified().unwrap());

        f.cache.set_fs_stats_for_test(super::super::FsStats {
            total_bytes: 100 * super::super::GIB,
            available_bytes: 1,
            ..super::super::FsStats::default()
        });
        f.cache.probe_home_cache_pressure().await.unwrap();
        f.cache.drain_pressure_reclamation().await;
        assert!(!f.image("home", &committed).exists());
        let after_pressure = std::fs::metadata(f.cache.routine_gc_lock_path()).unwrap();
        assert_eq!(after_pressure.len(), before.len());
        assert_eq!(
            after_pressure.modified().unwrap(),
            before.modified().unwrap()
        );
        assert!(
            f.cache
                .try_routine_gc(Duration::from_secs(3600))
                .await
                .unwrap()
                .is_some(),
            "other collectors must not postpone due routine maintenance"
        );
    }
}

#[tokio::test]
#[ignore = "invoked by routine_completion_cadence_is_shared_with_another_process"]
async fn routine_completion_cadence_child() {
    let root = std::env::var_os(CADENCE_CHILD_ROOT).expect("guarded cadence child root");
    let root = std::path::Path::new(&root);
    let cache = super::super::HomeImageCache::shared(
        runner_host::paths::RunnerPaths::new(root.join("runner")),
        &runner_host::paths::HomePaths::with_root(root.join("host")),
        "group-a",
    );
    assert!(
        cache
            .try_routine_gc(Duration::from_secs(3600))
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn routine_completion_cadence_is_shared_with_another_process() {
    let f = Fixture::new().await;
    f.commit("home", b"home", "2026-10-09T09:00:00Z").await;
    assert!(
        f.cache
            .try_routine_gc(Duration::ZERO)
            .await
            .unwrap()
            .is_some()
    );
    let orphan = f
        .cache
        .entry_paths(&f.key("home"))
        .tmp_image(RunId::new_v4());
    write_image(&orphan, b"not-due-for-maintenance", SIZE);
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "home_image_cache::tests::routine_gc::routine_completion_cadence_child",
                "--ignored",
                "--nocapture",
            ])
            .env(CADENCE_CHILD_ROOT, f.dir.path())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("cadence child must finish")
    .unwrap();
    assert!(
        output.status.success(),
        "cadence child failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    assert!(
        orphan.exists(),
        "another process must honor completed maintenance"
    );
}

#[tokio::test]
async fn routine_completion_marker_rejects_a_symlink_without_touching_its_target() {
    let f = Fixture::new().await;
    let target = f.dir.path().join("sentinel");
    std::fs::write(&target, b"sentinel").unwrap();
    std::fs::create_dir_all(&f.cache.inner.lock_dir).unwrap();
    std::os::unix::fs::symlink(&target, f.cache.routine_gc_lock_path()).unwrap();
    assert!(f.cache.try_routine_gc(Duration::ZERO).await.is_err());
    assert_eq!(std::fs::read(target).unwrap(), b"sentinel");
}

#[tokio::test]
async fn publication_progresses_while_unrelated_routine_cleanup_is_retained() {
    let f = Fixture::new().await;
    let committed = f
        .commit("gc-victim", b"committed-home", "2026-10-09T09:00:00Z")
        .await;
    let paths = f.cache.entry_paths(&f.key("gc-victim"));
    let metadata = tokio::fs::read(paths.metadata()).await.unwrap();
    let image = tokio::fs::read(f.image("gc-victim", &committed))
        .await
        .unwrap();
    let orphan = paths.tmp_image(RunId::new_v4());
    write_image(&orphan, b"orphaned-staging", SIZE);
    let publishing = f
        .context(
            "publishing-entry",
            b"new-home",
            "2026-10-09T10:00:00Z",
            HomeCacheTerminalStatus::Success,
            StorageFingerprints::default(),
        )
        .await;
    let expected = tokio::fs::read(f.paths.active_home_image(&publishing.sandbox_id()))
        .await
        .unwrap();
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let cache = f
        .cache
        .clone()
        .with_routine_gc_test_gate(entered.clone(), release.clone());
    let gc = tokio::spawn(async move { cache.try_routine_gc(Duration::ZERO).await });
    wait_entered(&entered).await;
    assert_eq!(
        publishing.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    drop(publishing);
    release.add_permits(1);
    assert!(gc.await.unwrap().unwrap().is_some());
    assert!(!orphan.exists());
    assert_eq!(tokio::fs::read(paths.metadata()).await.unwrap(), metadata);
    assert_eq!(
        tokio::fs::read(f.image("gc-victim", &committed))
            .await
            .unwrap(),
        image
    );
    let published = f.metadata("publishing-entry").await;
    assert_eq!(
        tokio::fs::read(f.image("publishing-entry", &published))
            .await
            .unwrap(),
        expected
    );
    assert_eq!(
        f.lease("publishing-entry").await.result(),
        HomeCacheCheckoutResult::Hit
    );
}

#[tokio::test]
async fn multi_entry_inventory_scans_once_under_the_collector_owner() {
    let fixture = Fixture::new().await;
    let first = fixture
        .commit("first", b"first-home", "2026-10-09T09:00:00Z")
        .await;
    let second = fixture
        .commit("second", b"second-home", "2026-10-09T09:00:01Z")
        .await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let cache =
        fixture
            .cache
            .clone()
            .with_gc_inventory_test_gate(1, entered.clone(), release.clone());
    fixture.cache.reset_gc_root_scan_count();
    let pending =
        tokio::spawn(async move { cache.try_routine_gc(std::time::Duration::ZERO).await });
    entered.notified().await;
    assert_eq!(fixture.cache.gc_root_scan_count(), 1);
    assert!(matches!(
        runner_host::lock::try_acquire_or_busy(fixture.cache.routine_gc_lock_path())
            .await
            .unwrap(),
        runner_host::lock::TryLock::Busy
    ));
    release.add_permits(1);
    assert!(pending.await.unwrap().unwrap().is_some());
    assert!(fixture.image("first", &first).exists());
    assert!(fixture.image("second", &second).exists());
    let candidates = fixture.cache.gc_candidates(|| true).await.unwrap().unwrap();
    assert_eq!(candidates.len(), 2);
    assert_eq!(fixture.cache.held_home_states().await.len(), 2);
}

#[tokio::test]
async fn routine_gc_respects_collector_contention_without_waiting_or_deleting() {
    let f = Fixture::new().await;
    let metadata = f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    let collector = runner_host::lock::acquire(f.cache.routine_gc_lock_path())
        .await
        .unwrap();
    assert!(
        f.cache
            .try_routine_gc(std::time::Duration::ZERO)
            .await
            .unwrap()
            .is_none()
    );
    assert!(f.image("thread", &metadata).exists());
    drop(collector);
}
