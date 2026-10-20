use super::*;

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
