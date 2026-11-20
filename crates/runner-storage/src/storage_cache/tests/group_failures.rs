use super::*;

#[tokio::test]
async fn empty_optional_archive_is_skipped_once_and_the_next_run_can_fetch_it() {
    for prepare_prefetch in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let server = MockServer::start_async().await;
        let bytes = tarball_bytes();
        let archive = server
            .mock_async(|when, then| {
                when.method(GET).path("/optional");
                then.status(200).body(bytes.clone());
            })
            .await;
        let name = guest_contracts::storage_manifest::WORKFLOW_STORAGE_NAME;
        let mut entry = storage_entry_with_archive_size(
            "/skills/optional".into(),
            server.url("/optional"),
            name,
            "v1",
            Some(bytes.len() as u64),
        );
        entry.optional = true;
        write_cached_archive(&home, name, "v1", &[]);

        let admission = FreshArchiveDeliveryAdmission::new();
        let cancel = CancellationToken::new();
        let mut telemetry = new_telemetry();
        let sandbox = MockSandbox::new("optional-empty-cache");
        let mut failing = plan_from_entries(vec![entry.clone()], Vec::new(), None);
        let mut prepared = if prepare_prefetch {
            Some(
                prepare_fresh_archive_delivery(
                    &mut failing,
                    &home,
                    &admission,
                    &cancel,
                    &mut telemetry,
                    None,
                )
                .await
                .unwrap(),
            )
        } else {
            None
        };
        let deferred = populate_cache_with_fresh_delivery(
            &mut failing,
            &sandbox,
            &home,
            &mut telemetry,
            prepared.as_mut(),
            None,
        )
        .await
        .unwrap();
        assert!(deferred.is_none());
        assert_eq!(storage_archive_url(&failing, 0), None);
        archive.assert_calls_async(0).await;
        let cached = home.storage_cache_dir(name, "v1").join("archive.tar.gz");
        assert!(!cached.exists());

        let mut next = plan_from_entries(vec![entry], Vec::new(), None);
        let mut prepared = prepare_fresh_archive_delivery(
            &mut next,
            &home,
            &admission,
            &cancel,
            &mut telemetry,
            None,
        )
        .await
        .unwrap();
        assert!(prepared.has_owned_sources(&mut telemetry).await.unwrap());
        populate_cache_with_fresh_delivery(
            &mut next,
            &sandbox,
            &home,
            &mut telemetry,
            Some(&mut prepared),
            None,
        )
        .await
        .unwrap();
        archive.assert_calls_async(1).await;
        assert_eq!(std::fs::read(cached).unwrap(), bytes);
        admission.shutdown().await;
    }
}

#[tokio::test]
async fn optional_runner_prefetch_reports_a_failed_object_without_retrying() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let server = MockServer::start_async().await;
    let failure = server
        .mock_async(|when, then| {
            when.method(GET).path("/optional");
            then.status(503);
        })
        .await;
    let mut entry = storage_entry_with_archive_size(
        "/skills/optional".into(),
        server.url("/optional"),
        guest_contracts::storage_manifest::WORKFLOW_STORAGE_NAME,
        "v1",
        Some(300),
    );
    entry.optional = true;
    let mut plan = plan_from_entries(vec![entry], Vec::new(), None);
    let admission = FreshArchiveDeliveryAdmission::new();
    let mut telemetry = new_telemetry();
    let mut delivery = prepare_fresh_archive_delivery(
        &mut plan,
        &home,
        &admission,
        &CancellationToken::new(),
        &mut telemetry,
        None,
    )
    .await
    .unwrap();
    assert!(delivery.has_owned_sources(&mut telemetry).await.unwrap());
    let sandbox = MockSandbox::new("failed-optional-prefetch");
    let fills = populate_cache_with_fresh_delivery(
        &mut plan,
        &sandbox,
        &home,
        &mut telemetry,
        Some(&mut delivery),
        None,
    )
    .await
    .unwrap();
    assert!(fills.is_none());
    failure.assert_calls_async(1).await;
    let manifest = plan.into_guest_manifest();
    assert!(manifest.storages[0].optional);
    assert!(!manifest.storages[0].cached);
    assert!(manifest.storages[0].archive_url.is_none());
    assert!(sandbox.write_files_calls().is_empty());
    admission.shutdown().await;
}

#[tokio::test]
async fn replacing_a_plan_keeps_an_already_failed_optional_prefetch_terminal() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let server = MockServer::start_async().await;
    let failure = server
        .mock_async(|when, then| {
            when.method(GET).path("/optional");
            then.status(503);
        })
        .await;
    let mount = "/skills/optional";
    let mut entry = storage_entry_with_archive_size(
        mount.into(),
        server.url("/optional"),
        guest_contracts::storage_manifest::WORKFLOW_STORAGE_NAME,
        "v1",
        Some(300),
    );
    entry.optional = true;
    let mut plan = plan_from_entries(vec![entry.clone()], Vec::new(), None);
    let admission = FreshArchiveDeliveryAdmission::new();
    let cancel = CancellationToken::new();
    let mut telemetry = new_telemetry();
    let mut delivery =
        prepare_fresh_archive_delivery(&mut plan, &home, &admission, &cancel, &mut telemetry, None)
            .await
            .unwrap();
    assert!(delivery.has_owned_sources(&mut telemetry).await.unwrap());
    // The failed fetch releases its body permit without accepting application.
    // Wait for that retirement before discarding its original plan.
    drop(
        tokio::time::timeout(
            Duration::from_secs(5),
            admission
                .permits
                .acquire_many(FRESH_DELIVERY_RUNNER_LIMIT as u32),
        )
        .await
        .unwrap()
        .unwrap(),
    );
    let mut skipped = HashSet::new();
    PreparedStorage { plan, delivery }
        .cancel_and_keep_skips(&mut telemetry, &mut skipped)
        .await;
    assert_eq!(skipped, HashSet::from([mount.to_owned()]));

    let mut replacement = plan_from_entries(vec![entry], Vec::new(), None);
    replacement.skip_optional_mounts(&skipped);
    let mut delivery = prepare_fresh_archive_delivery(
        &mut replacement,
        &home,
        &admission,
        &cancel,
        &mut telemetry,
        None,
    )
    .await
    .unwrap();
    assert!(!delivery.has_owned_sources(&mut telemetry).await.unwrap());
    assert!(
        replacement.into_guest_manifest().storages[0]
            .archive_url
            .is_none()
    );
    failure.assert_calls_async(1).await;
    admission.shutdown().await;
}

#[tokio::test]
async fn optional_decoded_lookup_error_skips_its_group_unless_shared_with_required_mount() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let name = runner_types::storage_manifest::WORKFLOW_STORAGE_NAME;
    let version = "v1";
    let decoded_path = home
        .storages_dir()
        .join(short_digest(name))
        .join(format!("decoded-v2-{}", short_digest(version)));
    std::fs::create_dir_all(decoded_path.parent().unwrap()).unwrap();
    std::fs::write(&decoded_path, "bad decoded entry").unwrap();
    write_cached_archive(&home, name, version, &tarball_bytes());
    let cache = decoded::DecodedCache::new(home.clone());
    let sandbox = MockSandbox::new("optional-decoded-error");
    let url = "https://r2.example.com/optional.tar.gz";
    for shared in [false, true] {
        let mut optional = storage_entry("/skills/optional".into(), url.into(), name, version);
        optional.optional = true;
        let mut entries = vec![optional];
        if shared {
            entries.push(storage_entry(
                "/skills/required".into(),
                url.into(),
                name,
                version,
            ));
        }
        let mut plan = plan_from_entries(entries, Vec::new(), None);
        let mut telemetry = new_telemetry();
        let result = populate_cache_with_fresh_delivery(
            &mut plan,
            &sandbox,
            &home,
            &mut telemetry,
            None,
            Some(&cache),
        )
        .await;
        if shared {
            let error = result.err().expect("required consumer of a failed group");
            assert!(
                error
                    .to_string()
                    .contains("decoded cache target is not a directory")
            );
        } else {
            assert!(result.unwrap().is_none());
            let manifest = plan.into_guest_manifest();
            assert!(manifest.storages[0].optional);
            assert!(!manifest.storages[0].cached);
            assert!(manifest.storages[0].archive_url.is_none());
        }
        assert!(
            sandbox.write_file_calls().is_empty(),
            "do not retry via the compressed cache"
        );
    }
    cache.shutdown().await;
}

#[tokio::test]
async fn group_processing_lock_error_preserves_source_and_cache() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("group-lock-error");
    let name = runner_types::storage_manifest::WORKFLOW_STORAGE_NAME;
    let body = tarball_bytes();
    write_cached_archive(&home, name, "v1", &body);

    let retained = temp.path().join("retained");
    std::fs::write(&retained, b"unrelated contents").unwrap();
    let lock_path = home.storage_lock(name, "v1");
    std::fs::create_dir_all(lock_path.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&retained, &lock_path).unwrap();
    let original = "https://r2.example.com/rejected-lock.tar.gz";
    for shared in [false, true] {
        let mut optional = storage_entry("/skills/optional".into(), original.into(), name, "v1");
        optional.optional = true;
        let mut entries = vec![optional];
        if shared {
            entries.push(storage_entry(
                "/skills/required".into(),
                original.into(),
                name,
                "v1",
            ));
        }
        let mut plan = plan_from_entries(entries, Vec::new(), None);
        let mut telemetry = new_telemetry();
        let result = populate_cache_with_fresh_delivery(
            &mut plan,
            &sandbox,
            &home,
            &mut telemetry,
            None,
            None,
        )
        .await;

        if shared {
            let error = result.err().expect("required consumer of a failed group");
            assert!(matches!(&error, RunnerError::Io(_)), "got: {error}");
            let message = error.to_string();
            assert!(message.contains("open lock"), "{message}");
            assert!(
                message.contains(&lock_path.display().to_string()),
                "{message}"
            );
            assert_eq!(storage_archive_url(&plan, 0), Some(original));
            assert_eq!(storage_archive_url(&plan, 1), Some(original));
        } else {
            assert!(result.unwrap().is_none());
            assert_eq!(storage_archive_url(&plan, 0), None);
        }
        assert!(sandbox.write_file_calls().is_empty());
    }
    assert_eq!(std::fs::read(&retained).unwrap(), b"unrelated contents");
    assert_eq!(std::fs::read_link(&lock_path).unwrap(), retained);
    assert_eq!(
        std::fs::read(home.storage_cache_dir(name, "v1").join("archive.tar.gz")).unwrap(),
        body
    );
}

#[tokio::test]
async fn optional_lookup_failure_survives_a_later_guest_staging_error() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let sandbox = MockSandbox::new("stage-failure-after-optional-lookup");
    sandbox.push_write_file_result(Err(sandbox_write_file_error("Guest rejected staging")));
    let mut optional = storage_entry(
        "/skills/optional".into(),
        "https://storage.example/optional.tar.gz".into(),
        "optional",
        "v1",
    );
    optional.optional = true;
    let required = storage_entry(
        "/skills/required".into(),
        "https://storage.example/required.tar.gz".into(),
        "required",
        "v1",
    );
    let body = tarball_bytes();
    write_cached_archive(&home, "optional", "v1", &body);
    write_cached_archive(&home, "required", "v1", &body);
    let lock = home.storage_lock("optional", "v1");
    std::fs::create_dir_all(lock.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(temp.path(), &lock).unwrap();

    let mut plan = plan_from_entries(vec![optional, required], Vec::new(), None);
    let mut telemetry = new_telemetry();
    let error = populate_cache(&mut plan, &sandbox, &home, &mut telemetry)
        .await
        .err()
        .expect("a Guest staging error remains fatal to this sandbox");
    assert!(error.to_string().contains("Guest rejected staging"));
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, guest_archive_path("required", "v1"));

    let mut skipped = HashSet::new();
    let manifest = plan.into_guest_manifest_retaining_skips(&mut skipped);
    assert_eq!(skipped, HashSet::from(["/skills/optional".to_owned()]));
    assert!(manifest.storages[0].archive_url.is_none());
    assert_eq!(
        manifest.storages[1].archive_url.as_deref(),
        Some("https://storage.example/required.tar.gz")
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
    let observations = telemetry.pending_stage_write_payloads();
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0]["success"], false);
    assert_eq!(observations[0]["error"], STORAGE_CACHE_STAGE_FAILED);
    let stage = &observations[0]["storage_stage_write"];
    assert_eq!(stage["file_count"], 64);
    assert_eq!(stage["content_bytes"], 64 * body.len());
    assert_eq!(stage["host_timing"], "unavailable");
}
