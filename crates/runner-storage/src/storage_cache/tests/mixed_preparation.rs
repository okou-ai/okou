use super::phase_diagnostics::GatedResponse;
use super::*;

#[tokio::test]
async fn cached_storage_and_artifact_stage_before_the_cold_body_arrives() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let cold = tarball_with_contents(b"cold source\n");
    let warm = tarball_with_contents(b"cached storage\n");
    let artifact = tarball_with_contents(b"cached artifact\n");
    write_cached_archive(&home, "warm-storage", "v1", &warm);
    write_cached_archive(&home, "warm-artifact", "v1", &artifact);
    let server = GatedResponse::start(cold.clone()).await;
    let mut plan = plan_from_entries(
        vec![
            storage_entry_with_archive_size(
                "/mnt/cold".into(),
                server.url,
                "cold",
                "v1",
                Some(cold.len() as u64),
            ),
            storage_entry(
                "/mnt/warm".into(),
                "https://example.test/warm".into(),
                "warm-storage",
                "v1",
            ),
        ],
        vec![artifact_entry(
            "/mnt/artifact".into(),
            "https://example.test/artifact".into(),
            "warm-artifact",
            "v1",
        )],
        None,
    );
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
    tokio::time::timeout(Duration::from_secs(5), server.requested)
        .await
        .unwrap()
        .unwrap();
    server.headers.send(()).unwrap();
    let sandbox = Arc::new(MockSandbox::new("mixed-preparation"));
    let gate = MockLifecycleGate::new();
    sandbox.set_write_file_lifecycle_gate(gate.clone());
    let task = tokio::spawn({
        let home = home.clone();
        let sandbox = Arc::clone(&sandbox);
        async move {
            let result = populate_cache_with_fresh_delivery(
                &mut plan,
                sandbox.as_ref(),
                &home,
                &mut telemetry,
                Some(&mut delivery),
                None,
            )
            .await;
            (result, plan, telemetry)
        }
    });

    gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
    assert!(!home.storage_cache_dir("cold", "v1").exists());
    let batches = sandbox.write_files_calls();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].files.len(), 2);
    for (name, bytes) in [("warm-storage", &warm), ("warm-artifact", &artifact)] {
        let file = batches[0]
            .files
            .iter()
            .find(|file| file.path == guest_archive_path(name, "v1"))
            .unwrap();
        assert_eq!(&file.content, bytes);
    }
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT - 1
    );
    gate.release_one();
    server.body.send(()).unwrap();
    gate.wait_entered(2, Duration::from_secs(5)).await.unwrap();
    let batches = sandbox.write_files_calls();
    assert_eq!(batches[1].files.len(), 1);
    assert_eq!(batches[1].files[0].path, guest_archive_path("cold", "v1"));
    assert_eq!(batches[1].files[0].content, cold);
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT - 1
    );
    gate.release_one();
    let (result, plan, telemetry) = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    drop(result.unwrap());
    for (index, name) in ["cold", "warm-storage"].iter().enumerate() {
        assert_eq!(
            storage_archive_url(&plan, index),
            Some(format!("file://{}", guest_archive_path(name, "v1")).as_str())
        );
    }
    assert_eq!(
        artifact_archive_url(&plan, 0),
        Some(format!("file://{}", guest_archive_path("warm-artifact", "v1")).as_str())
    );
    assert_eq!(
        fs::read(home.storage_cache_dir("cold", "v1").join("archive.tar.gz"))
            .await
            .unwrap(),
        cold
    );
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
    assert_op(
        &telemetry.pending_ops_snapshot(),
        STORAGE_CACHE_STAGE_TOTAL,
        true,
    );
    server.task.finish().await;
    admission.shutdown().await;
}

#[tokio::test]
async fn cached_stage_failure_cancels_and_joins_the_cold_response() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let cold = tarball_bytes();
    let warm = tarball_with_contents(b"retained cache\n");
    write_cached_archive(&home, "warm", "v1", &warm);
    let server = GatedResponse::start(cold.clone()).await;
    let cold_url = server.url.clone();
    let warm_url = "https://example.test/warm";
    let mut plan = plan_from_entries(
        vec![
            storage_entry_with_archive_size(
                "/mnt/cold".into(),
                server.url,
                "cold",
                "v1",
                Some(cold.len() as u64),
            ),
            storage_entry("/mnt/warm".into(), warm_url.into(), "warm", "v1"),
        ],
        Vec::new(),
        None,
    );
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
    tokio::time::timeout(Duration::from_secs(5), server.requested)
        .await
        .unwrap()
        .unwrap();
    server.headers.send(()).unwrap();
    let sandbox = Arc::new(MockSandbox::new("mixed-stage-failure"));
    let gate = MockLifecycleGate::new();
    sandbox.set_write_file_lifecycle_gate(gate.clone());
    sandbox.push_write_file_result(Err(sandbox_write_file_error("cached stage failed")));
    let task = tokio::spawn({
        let home = home.clone();
        let sandbox = Arc::clone(&sandbox);
        async move {
            let result = populate_cache_with_fresh_delivery(
                &mut plan,
                sandbox.as_ref(),
                &home,
                &mut telemetry,
                Some(&mut delivery),
                None,
            )
            .await;
            (result, plan, telemetry)
        }
    });
    gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
    gate.release_one();
    let (result, plan, telemetry) = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    let error = result
        .err()
        .expect("cached staging failure must fail population");
    assert!(
        error.to_string().contains("cached stage failed"),
        "got: {error}"
    );
    assert_eq!(storage_archive_url(&plan, 0), Some(cold_url.as_str()));
    assert_eq!(storage_archive_url(&plan, 1), Some(warm_url));
    assert!(!home.storage_cache_dir("cold", "v1").exists());
    assert_eq!(
        fs::read(home.storage_cache_dir("warm", "v1").join("archive.tar.gz"))
            .await
            .unwrap(),
        warm
    );
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
    for name in ["cold", "warm"] {
        assert!(matches!(
            lock::try_acquire_or_busy(home.storage_lock(name, "v1"))
                .await
                .unwrap(),
            lock::TryLock::Acquired(_)
        ));
    }
    assert_op(
        &telemetry.pending_ops_snapshot(),
        STORAGE_CACHE_STAGE_TOTAL,
        false,
    );
    // The peer still withholds the body; completion proves delivery dropped
    // the response and retired its socket instead of leaving a detached fetch.
    server.task.finish().await;
    admission.shutdown().await;
}

#[tokio::test]
async fn cold_publication_failure_waits_for_the_accepted_cached_write() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let body = tarball_bytes();
    write_cached_archive(&home, "warm", "v1", &body);
    let server = GatedResponse::start(body.clone()).await;
    let cold_url = server.url.clone();
    let warm_url = "https://example.test/warm";
    let mut plan = plan_from_entries(
        vec![
            storage_entry_with_archive_size(
                "/mnt/cold".into(),
                server.url,
                "cold",
                "v1",
                Some(body.len() as u64),
            ),
            storage_entry("/mnt/warm".into(), warm_url.into(), "warm", "v1"),
        ],
        Vec::new(),
        None,
    );
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
    let failed_branch = delivery.cancel.clone();
    // A destination without a complete archive must reject publication. Create
    // it after classification so the cold request remains owned by delivery.
    let cache_dir = home.storage_cache_dir("cold", "v1");
    fs::create_dir_all(&cache_dir).await.unwrap();
    fs::write(cache_dir.join("retained"), b"existing contents")
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), server.requested)
        .await
        .unwrap()
        .unwrap();
    server.headers.send(()).unwrap();
    let sandbox = Arc::new(MockSandbox::new("mixed-publication-failure"));
    let gate = MockLifecycleGate::new();
    sandbox.set_write_file_lifecycle_gate(gate.clone());
    let task = tokio::spawn({
        let home = home.clone();
        let sandbox = Arc::clone(&sandbox);
        async move {
            let result = populate_cache_with_fresh_delivery(
                &mut plan,
                sandbox.as_ref(),
                &home,
                &mut telemetry,
                Some(&mut delivery),
                None,
            )
            .await;
            (result, plan, telemetry)
        }
    });
    gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
    server.body.send(()).unwrap();
    // Cancellation is emitted only after the fresh branch observes its error.
    tokio::time::timeout(Duration::from_secs(5), failed_branch.cancelled())
        .await
        .unwrap();
    assert!(
        !task.is_finished(),
        "an accepted Guest write must stay awaited"
    );
    gate.release_one();
    let (result, plan, telemetry) = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    let error = result
        .err()
        .expect("publication failure must fail population");
    assert!(error.to_string().contains("rename"), "got: {error}");
    assert_eq!(storage_archive_url(&plan, 0), Some(cold_url.as_str()));
    assert_eq!(storage_archive_url(&plan, 1), Some(warm_url));
    assert_eq!(sandbox.write_files_calls().len(), 1);
    assert_eq!(
        fs::read(cache_dir.join("retained")).await.unwrap(),
        b"existing contents"
    );
    assert!(!cache_dir.join("archive.tar.gz").exists());
    assert!(!staging_dir(&cache_dir).exists());
    assert!(matches!(
        lock::try_acquire_or_busy(home.storage_lock("cold", "v1"))
            .await
            .unwrap(),
        lock::TryLock::Acquired(_)
    ));
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
    assert_op(
        &telemetry.pending_ops_snapshot(),
        STORAGE_CACHE_FRESH_DELIVERY_PUBLICATION_FAILED,
        false,
    );
    server.task.finish().await;
    admission.shutdown().await;
}
