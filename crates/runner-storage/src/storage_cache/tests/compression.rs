use super::*;

#[tokio::test]
async fn fresh_archive_delivery_preserves_content_encoded_archive_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let server = MockServer::start_async().await;
    let bytes = tarball_with_contents(b"original gzip archive for the guest\n");
    let archive = server
        .mock_async(|when, then| {
            when.method(GET).path("/archive.tar.gz");
            then.status(200)
                .header("content-encoding", "gzip")
                .body(bytes.clone());
        })
        .await;
    let mut plan = fresh_storage_plan_with_archive_size(
        server.url("/archive.tar.gz"),
        "encoded",
        "v1",
        bytes.len() as u64,
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
    let sandbox = MockSandbox::new("content-encoded-archive");

    assert!(
        populate_cache_with_fresh_delivery(
            &mut plan,
            &sandbox,
            &home,
            &mut telemetry,
            Some(&mut delivery),
            None,
        )
        .await
        .unwrap()
        .is_none()
    );
    delivery.cancel_and_drain(&mut telemetry).await;
    admission.shutdown().await;

    assert!(
        sandbox
            .write_files_calls()
            .iter()
            .flat_map(|call| &call.files)
            .any(|file| {
                file.path == guest_archive_path("encoded", "v1") && file.content == bytes
            })
    );
    assert_eq!(
        fs::read(
            home.storage_cache_dir("encoded", "v1")
                .join("archive.tar.gz")
        )
        .await
        .unwrap(),
        bytes,
    );
    archive.assert_calls_async(1).await;
}

#[tokio::test]
async fn background_fill_publishes_original_content_encoded_archive_and_warms_decoded_cache() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let server = MockServer::start_async().await;
    let bytes = tarball_with_contents(b"background archive contents\n");
    let archive = server
        .mock_async(|when, then| {
            when.method(GET).path("/archive.tar.gz");
            then.status(200)
                .header("content-encoding", "gzip")
                .body(bytes.clone());
        })
        .await;
    let (telemetry_url, mut telemetry_server) = telemetry_capture_server(1).await;
    let coordinator = StorageCacheBackgroundFillCoordinator::new().unwrap();
    let decoded = decoded::DecodedCache::new(home.clone());

    assert_eq!(
        coordinator.submit(
            background_fill_group(
                server.url("/archive.tar.gz"),
                "encoded",
                "v1",
                Some(bytes.len() as u64)
            ),
            home.clone(),
            new_telemetry_for_api_url(&telemetry_url).reporter(),
            BackgroundFillAction::Fill(Some(decoded.clone())),
        ),
        BackgroundFillAdmission::Accepted
    );
    // Publication and optional extraction finish before their terminal report.
    // A newly created cache lock alone does not prove the worker has started.
    let report = telemetry_server
        .next_request("completed archive fill")
        .await;
    coordinator.shutdown().await;
    assert_eq!(wait_cached_archive(&home, "encoded", "v1").await, bytes);
    let cached = decoded.get_ready("encoded", "v1").await.unwrap().unwrap();
    assert_eq!(cached.files.len(), 1);
    assert_eq!(
        cached.files[0].content.as_slice(),
        b"background archive contents\n"
    );
    decoded.shutdown().await;

    assert!(report.contains(r#""action_type":"storage_cache_background_fill_filled""#));
    telemetry_server.assert_finished().await;
    archive.assert_calls_async(1).await;
}
