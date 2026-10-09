use super::super::*;
use super::support::*;

#[tokio::test]
async fn locked_inspection_is_unavailable_while_fresh_capacity_accounting_is_not_zero() {
    let f = Fixture::new().await;
    f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    let lock = runner_host::lock::acquire(f.cache.entry_lock_path(&f.key("thread")))
        .await
        .unwrap();
    let unavailable = f.cache.inspect().await.unwrap();
    assert_eq!(unavailable.summary.locked_entries, 1);
    assert_eq!(
        unavailable.entries[0].status,
        HomeImageCacheInspectionStatus::Locked
    );
    assert!(unavailable.entries[0].rootfs_hash.is_none());
    assert!(
        unavailable.entries[0]
            .reason
            .as_ref()
            .unwrap()
            .contains("held")
    );
    assert!(f.cache.total_cache_allocated_bytes().await.unwrap() > 0);
    drop(lock);
    let available = f.cache.inspect().await.unwrap();
    assert_eq!(available.summary.reusable_entries, 1);
    assert_eq!(available.entries[0].rootfs_hash.as_deref(), Some(ROOTFS));
    assert!(available.summary.total_allocated_bytes > 0);
    assert_eq!(available.summary.total_logical_image_bytes, SIZE);
}

#[tokio::test]
async fn inspection_reports_orphan_and_staging_without_double_counting_metadata() {
    let f = Fixture::new().await;
    f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    let paths = f.cache.entry_paths(&f.key("thread"));
    write_image(
        &paths.image(&uuid::Uuid::new_v4().to_string()).unwrap(),
        b"orphan",
        SIZE,
    );
    write_image(
        &paths.tmp_image(runner_types::ids::RunId::new_v4()),
        b"staged",
        SIZE,
    );
    let inspection = f.cache.inspect().await.unwrap();
    assert_eq!(inspection.summary.temporary_paths, 2);
    assert!(inspection.summary.temporary_allocated_bytes > 0);
    assert_eq!(
        inspection.summary.total_allocated_bytes,
        super::super::fs::measured_entry_bytes(paths.entry_dir())
            .await
            .unwrap()
    );
    assert_eq!(inspection.summary.reusable_entries, 1);
}
