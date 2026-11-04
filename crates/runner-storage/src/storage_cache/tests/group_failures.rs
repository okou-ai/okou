use super::*;
use std::future::Future as _;

#[tokio::test]
async fn failed_group_joins_started_host_io_before_returning() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let body = tarball_bytes();
    write_cached_archive(&home, "reading", "v1", &body);
    write_storage_lock(&home, "reading", "v1");
    let plan = fresh_storage_plan("https://r2.example.com/reading".into(), "reading", "v1");
    let group = group_targets(collect_targets(plan.cache_candidates()))
        .pop()
        .unwrap();
    let lock_path = home.storage_lock("reading", "v1");
    let mut groups = JoinSet::new();
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    groups.spawn_blocking({
        let group = group.clone();
        let lock_path = lock_path.clone();
        move || {
            let reader = lock::try_acquire_shared_or_busy_blocking(&lock_path).unwrap();
            assert!(matches!(reader, lock::TryLock::Acquired(_)));
            entered_tx.send(()).unwrap();
            // Model accepted physical IO that cannot be interrupted by abort.
            release_rx.recv().unwrap();
            let mut metrics = CacheProcessMetrics::default();
            let processed = process_group_hit_or_passthrough(&group, &home, &mut metrics, None);
            drop(reader);
            ProcessedGroupTask {
                group,
                metrics,
                processed,
            }
        }
    });
    entered_rx.await.unwrap();
    let sandbox = MockSandbox::new("failed-while-reading");
    let guest_writes = GuestWriteLocks::default();
    let mut telemetry = new_telemetry();
    let mut metrics = StorageCacheStageMetrics::start();
    let mut stage = GuestStageRecorder {
        sandbox: &sandbox,
        guest_writes: &guest_writes,
        telemetry: &mut telemetry,
        metrics: &mut metrics,
    };
    let failed_plan = fresh_storage_plan("https://r2.example.com/failed".into(), "failed", "v1");
    let failed_group = group_targets(collect_targets(failed_plan.cache_candidates()))
        .pop()
        .unwrap();
    let failed = ProcessedGroupTask {
        group: failed_group,
        metrics: CacheProcessMetrics::default(),
        processed: Err(RunnerError::Internal("original read failure".into())),
    };
    let mut outcomes = Vec::new();
    let mut batch = GuestStageBatch::default();
    let mut failure = Box::pin(stage_joined_processed_group(
        &mut groups,
        failed,
        &mut outcomes,
        &mut batch,
        &mut stage,
    ));
    std::future::poll_fn(|cx| {
        assert!(failure.as_mut().poll(cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    assert!(matches!(
        lock::try_acquire_or_busy_blocking(&lock_path).unwrap(),
        lock::TryLock::Busy
    ));
    release_tx.send(()).unwrap();
    let error = failure.await.unwrap_err();
    assert!(error.to_string().contains("original read failure"));
    assert!(groups.is_empty());
    assert!(matches!(
        lock::try_acquire_or_busy_blocking(&lock_path).unwrap(),
        lock::TryLock::Acquired(_)
    ));
    assert!(sandbox.write_files_calls().is_empty());
}

#[tokio::test]
async fn group_processing_lock_error_preserves_source_and_cache() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("group-lock-error");
    let mut telemetry = new_telemetry();
    let name = "rejected-lock";
    let body = tarball_bytes();
    write_cached_archive(&home, name, "v1", &body);

    let retained = temp.path().join("retained");
    std::fs::write(&retained, b"unrelated contents").unwrap();
    let lock_path = home.storage_lock(name, "v1");
    std::fs::create_dir_all(lock_path.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&retained, &lock_path).unwrap();
    let original = "https://r2.example.com/rejected-lock.tar.gz";
    let mut plan = fresh_storage_plan(original.into(), name, "v1");

    let error =
        populate_cache_with_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry, None, None)
            .await
            .err()
            .expect("an unsafe cache lock must fail population");

    assert!(
        matches!(&error, RunnerError::Internal(message) if message.contains("open lock") && message.contains(&lock_path.display().to_string())),
        "got: {error}"
    );
    assert_eq!(storage_archive_url(&plan, 0), Some(original));
    assert_eq!(std::fs::read(&retained).unwrap(), b"unrelated contents");
    assert_eq!(std::fs::read_link(&lock_path).unwrap(), retained);
    assert_eq!(
        std::fs::read(home.storage_cache_dir(name, "v1").join("archive.tar.gz")).unwrap(),
        body
    );
}

#[tokio::test]
async fn full_warm_batch_failure_preserves_sources_and_cache() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("full-batch-error");
    sandbox.push_write_file_result(Err(sandbox_write_file_error("full batch write failed")));
    let mut telemetry = new_telemetry();
    let body = tarball_bytes();
    let entries = (0..68)
        .map(|index| {
            let name = format!("full-batch-{index}");
            write_cached_archive(&home, &name, "v1", &body);
            storage_entry(
                format!("/mnt/{index}"),
                format!("https://r2.example.com/{index}.tar.gz"),
                &name,
                "v1",
            )
        })
        .collect();
    let mut plan = plan_from_entries(entries, Vec::new(), None);

    let error =
        populate_cache_with_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry, None, None)
            .await
            .err()
            .expect("a full Guest batch write failure must fail population");

    assert!(
        error.to_string().contains("full batch write failed"),
        "got: {error}"
    );
    for index in 0..68 {
        let original = format!("https://r2.example.com/{index}.tar.gz");
        assert_eq!(storage_archive_url(&plan, index), Some(original.as_str()));
        assert_eq!(
            std::fs::read(
                home.storage_cache_dir(&format!("full-batch-{index}"), "v1")
                    .join("archive.tar.gz")
            )
            .unwrap(),
            body
        );
    }
    let ops = telemetry.pending_ops_snapshot();
    assert_op(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE, false);
    assert_op(&ops, STORAGE_CACHE_STAGE_TOTAL, false);
}
