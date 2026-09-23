use super::*;

const VERSION: &str = "v1";

fn entry_dir(home: &HomePaths, name: &str, rejected: bool) -> PathBuf {
    home.storages_dir().join(short_digest(name)).join(format!(
        "decoded-v1-{}{}",
        if rejected { "rejected-" } else { "" },
        short_digest(VERSION),
    ))
}

async fn seed_rejection(home: &HomePaths, cache: &decoded::DecodedCache, name: &str) -> Vec<u8> {
    let bytes = tarball_with_contents(&vec![
        b'x';
        guest_contracts::storage_files::MAX_FILE_BYTES + 1
    ]);
    write_cached_archive(home, name, VERSION, &bytes);
    write_storage_lock(home, name, VERSION);
    cache.warm_from_archive(name, VERSION).await.unwrap();
    assert!(entry_dir(home, name, true).join("index.json").exists());
    bytes
}

async fn prepare(
    home: &HomePaths,
    cache: &decoded::DecodedCache,
    names: &[&str],
    url: &str,
    size: usize,
    telemetry: &mut JobTelemetry,
) -> DeferredBackgroundFill {
    let entries = names
        .iter()
        .enumerate()
        .map(|(index, name)| {
            storage_entry_with_archive_size(
                format!("/mnt/{index}"),
                url.to_owned(),
                name,
                VERSION,
                Some(size as u64),
            )
        })
        .collect();
    let mut plan = plan_from_entries(entries, Vec::new(), None);
    populate_cache_with_fresh_delivery(
        &mut plan,
        &MockSandbox::new("rejected-observation"),
        home,
        telemetry,
        None,
        Some(cache),
    )
    .await
    .unwrap()
    .expect("archive hits or misses select optional background work")
}

async fn idle(coordinator: &StorageCacheBackgroundFillCoordinator) {
    tokio::time::timeout(Duration::from_secs(5), coordinator.wait_idle_for_test())
        .await
        .expect("all owned background work should finish");
}

async fn telemetry_server() -> MockServer {
    let server = MockServer::start_async().await;
    server
        .mock_async(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/api/webhooks/agent/telemetry");
            then.status(200)
                .json_body(serde_json::json!({"success": true}));
        })
        .await;
    server
}

#[tokio::test]
async fn rejected_prefix_leaves_room_for_useful_first_warming() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let cache = decoded::DecodedCache::new(home.clone());
    let rejected = (0..40)
        .map(|index| format!("rejected-prefix-{index}"))
        .collect::<Vec<_>>();
    for name in &rejected {
        seed_rejection(&home, &cache, name).await;
    }
    let api = telemetry_server().await;
    let bytes = tarball_bytes();
    let mut server = gated_archive_server(bytes.clone(), 8).await;
    let coordinator = StorageCacheBackgroundFillCoordinator::new().unwrap();
    for pass in 0..2 {
        let mut telemetry = new_telemetry_for_api_url(&api.base_url());
        for index in 0..4 {
            let name = format!("active-{pass}-{index}");
            prepare(
                &home,
                &cache,
                &[&name],
                &server.url,
                bytes.len(),
                &mut telemetry,
            )
            .await
            .start(&coordinator, &mut telemetry);
            tokio::time::timeout(Duration::from_secs(5), server.requests.recv())
                .await
                .unwrap()
                .unwrap();
        }
        let useful = format!("useful-tail-{pass}");
        write_cached_archive(&home, &useful, VERSION, &bytes);
        write_storage_lock(&home, &useful, VERSION);
        let mut names = rejected.iter().map(String::as_str).collect::<Vec<_>>();
        names.push(&useful);
        let mut deferred = prepare(
            &home,
            &cache,
            &names,
            &server.url,
            bytes.len(),
            &mut telemetry,
        )
        .await;
        // Preparation completes groups concurrently. Set this workload's
        // rejected-prefix order at the actual post-spawn admission boundary.
        deferred
            .groups
            .sort_by_key(|(group, _)| group.targets[0].name == useful);
        deferred.start(&coordinator, &mut telemetry);
        // Leave three network workers occupied. One maintenance worker then
        // proves useful admission without racing the optional decoder budget.
        server.release.add_permits(1);
        tokio::time::timeout(Duration::from_secs(5), async {
            while !entry_dir(&home, &useful, false).join("index.json").exists() {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("rejected prefixes must not repeatedly starve useful warming");
        server.release.add_permits(3);
        idle(&coordinator).await;
        let ready = cache.get_ready(&useful, VERSION).await.unwrap().unwrap();
        assert_eq!(ready.files[0].content, b"storage cache test file\n");
    }
    coordinator.shutdown().await;
    join_raw_http_task(server.task, "released missing archives")
        .await
        .unwrap();
    assert!(server.max_active.load(Ordering::SeqCst) <= 4);
    cache.shutdown().await;
}

#[tokio::test]
async fn eviction_after_warm_selection_preserves_missing_and_same_key_archive_demand() {
    for same_key_consumer in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let cache = decoded::DecodedCache::new(home.clone());
        let name = "evicted-rejected-source";
        let bytes = seed_rejection(&home, &cache, name).await;
        let server = MockServer::start_async().await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET).path("/archive");
                then.status(200).body(bytes.clone());
            })
            .await;
        let api = telemetry_server().await;
        let mut telemetry = new_telemetry_for_api_url(&api.base_url());
        let warm = prepare(
            &home,
            &cache,
            &[name],
            &server.url("/archive"),
            bytes.len(),
            &mut telemetry,
        )
        .await;
        let archive = home.storage_cache_dir(name, VERSION).join("archive.tar.gz");
        std::fs::remove_file(&archive).unwrap();
        let coordinator = StorageCacheBackgroundFillCoordinator::new().unwrap();
        if same_key_consumer {
            // This second plan observes a real compressed miss. Its demand
            // remains independent of the earlier plan's rejected decoded form.
            prepare(
                &home,
                &cache,
                &[name],
                &server.url("/archive"),
                bytes.len(),
                &mut telemetry,
            )
            .await
            .start(&coordinator, &mut telemetry);
        }
        warm.start(&coordinator, &mut telemetry);
        idle(&coordinator).await;
        coordinator.shutdown().await;
        assert_eq!(std::fs::read(archive).unwrap(), bytes);
        get.assert_calls_async(1).await;
        assert!(cache.get_ready(name, VERSION).await.unwrap().is_none());
        cache.shutdown().await;
    }
}

#[tokio::test]
async fn evicted_rejections_are_recreated_with_current_and_restarted_cache_owners() {
    for restart in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let mut cache = decoded::DecodedCache::new(home.clone());
        let name = "recreated-rejection";
        let bytes = seed_rejection(&home, &cache, name).await;
        let api = telemetry_server().await;
        let mut telemetry = new_telemetry_for_api_url(&api.base_url());
        let coordinator = StorageCacheBackgroundFillCoordinator::new().unwrap();
        prepare(
            &home,
            &cache,
            &[name],
            "https://storage.example/unused",
            bytes.len(),
            &mut telemetry,
        )
        .await
        .start(&coordinator, &mut telemetry);
        idle(&coordinator).await;
        if restart {
            cache.shutdown().await;
            cache = decoded::DecodedCache::new(home.clone());
        }
        std::fs::remove_dir_all(entry_dir(&home, name, true)).unwrap();
        prepare(
            &home,
            &cache,
            &[name],
            "https://storage.example/unused",
            bytes.len(),
            &mut telemetry,
        )
        .await
        .start(&coordinator, &mut telemetry);
        idle(&coordinator).await;
        let record: serde_json::Value = serde_json::from_slice(
            &std::fs::read(entry_dir(&home, name, true).join("index.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(record["name"], name);
        assert_eq!(record["version"], VERSION);
        assert!(record["files"].is_null());
        assert_eq!(
            std::fs::read(home.storage_cache_dir(name, VERSION).join("archive.tar.gz")).unwrap(),
            bytes
        );
        coordinator.shutdown().await;
        cache.shutdown().await;
    }
}

#[tokio::test]
async fn missing_source_lock_is_recreated_and_busy_source_keeps_its_background_outcome() {
    for busy in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let cache = decoded::DecodedCache::new(home.clone());
        let name = "rejection-source-lock";
        let bytes = seed_rejection(&home, &cache, name).await;
        let (api_url, api) = telemetry_capture_server(2).await;
        let mut telemetry = new_telemetry_for_api_url(&api_url);
        let deferred = prepare(
            &home,
            &cache,
            &[name],
            "https://storage.example/unused",
            bytes.len(),
            &mut telemetry,
        )
        .await;
        let writer = if busy {
            Some(
                lock::acquire(home.storage_lock(name, VERSION))
                    .await
                    .unwrap(),
            )
        } else {
            std::fs::remove_file(home.storage_lock(name, VERSION)).unwrap();
            None
        };
        let coordinator = StorageCacheBackgroundFillCoordinator::new().unwrap();
        deferred.start(&coordinator, &mut telemetry);
        idle(&coordinator).await;
        coordinator.shutdown().await;
        let requests = api.assert_finished_with_requests().await;
        let outcome = if busy {
            STORAGE_CACHE_BACKGROUND_FILL_BUSY
        } else {
            STORAGE_CACHE_BACKGROUND_FILL_ALREADY_CACHED
        };
        assert!(requests.iter().any(|request| request.contains(outcome)));
        assert!(home.storage_lock(name, VERSION).exists());
        assert_eq!(
            std::fs::read(home.storage_cache_dir(name, VERSION).join("archive.tar.gz")).unwrap(),
            bytes
        );
        drop(writer);
        cache.shutdown().await;
    }
}

#[tokio::test]
async fn malformed_rejection_fails_background_work_without_failing_archive_preparation() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let cache = decoded::DecodedCache::new(home.clone());
    let name = "malformed-rejection";
    let bytes = seed_rejection(&home, &cache, name).await;
    std::fs::write(entry_dir(&home, name, true).join("index.json"), b"{").unwrap();
    let (api_url, api) = telemetry_capture_server(2).await;
    let mut telemetry = new_telemetry_for_api_url(&api_url);
    let deferred = prepare(
        &home,
        &cache,
        &[name],
        "https://storage.example/unused",
        bytes.len(),
        &mut telemetry,
    )
    .await;
    let coordinator = StorageCacheBackgroundFillCoordinator::new().unwrap();
    deferred.start(&coordinator, &mut telemetry);
    idle(&coordinator).await;
    coordinator.shutdown().await;
    let requests = api.assert_finished_with_requests().await;
    assert!(
        requests
            .iter()
            .any(|request| request.contains(STORAGE_CACHE_BACKGROUND_FILL_FAILED))
    );
    assert_eq!(
        std::fs::read(home.storage_cache_dir(name, VERSION).join("archive.tar.gz")).unwrap(),
        bytes
    );
    assert!(cache.get_ready(name, VERSION).await.unwrap().is_none());
    cache.shutdown().await;
}

#[tokio::test]
async fn shutdown_joins_classified_work_and_reporting_before_rejecting_later_warming() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let cache = decoded::DecodedCache::new(home.clone());
    let bytes = tarball_bytes();
    for name in ["first-warm", "after-shutdown"] {
        write_cached_archive(&home, name, VERSION, &bytes);
        write_storage_lock(&home, name, VERSION);
    }
    let (release, released) = tokio::sync::oneshot::channel();
    let mut api = RawHttpTestServer::spawn(vec![
        RawHttpAction::WaitThenRespond {
            release: released,
            response: json_response("200 OK", r#"{"success":true}"#),
        },
        RawHttpAction::Respond(json_response("200 OK", r#"{"success":true}"#)),
    ])
    .await;
    let mut telemetry = new_telemetry_for_api_url(&api.url());
    let first = prepare(
        &home,
        &cache,
        &["first-warm"],
        "https://storage.example/unused",
        bytes.len(),
        &mut telemetry,
    )
    .await;
    let later = prepare(
        &home,
        &cache,
        &["after-shutdown"],
        "https://storage.example/unused",
        bytes.len(),
        &mut telemetry,
    )
    .await;
    // A positive publication after preparation must remain valid when the
    // delayed classification/worker observes it.
    cache
        .warm_from_archive("first-warm", VERSION)
        .await
        .unwrap();
    let coordinator = StorageCacheBackgroundFillCoordinator::new().unwrap();
    first.start(&coordinator, &mut telemetry);
    api.next_request("background result awaiting telemetry response")
        .await;
    let shutdown = coordinator.shutdown();
    tokio::pin!(shutdown);
    assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), shutdown)
        .await
        .unwrap();
    api.assert_finished().await;
    later.start(&coordinator, &mut telemetry);
    let files = cache
        .get_ready("first-warm", VERSION)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(files.files[0].content, b"storage cache test file\n");
    cache.shutdown().await;
    assert!(!entry_dir(&home, "after-shutdown", false).exists());
}

#[tokio::test]
async fn dropping_last_coordinator_owner_does_not_schedule_classified_work() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let cache = decoded::DecodedCache::new(home.clone());
    let name = "owner-dropped-before-classification";
    let bytes = tarball_bytes();
    write_cached_archive(&home, name, VERSION, &bytes);
    write_storage_lock(&home, name, VERSION);
    let (api_url, api) = telemetry_capture_server(1).await;
    let mut telemetry = new_telemetry_for_api_url(&api_url);
    let deferred = prepare(
        &home,
        &cache,
        &[name],
        "https://storage.example/unused",
        bytes.len(),
        &mut telemetry,
    )
    .await;
    let coordinator = StorageCacheBackgroundFillCoordinator::new().unwrap();
    let classified_work = coordinator.lifecycle.inner.classifiers.clone();
    // This current-thread runtime cannot poll either async callback between
    // synchronous start and drop, even if the blocking disk probe completes.
    deferred.start(&coordinator, &mut telemetry);
    drop(coordinator);
    let requests = api.assert_finished_with_requests().await;
    tokio::time::timeout(Duration::from_secs(5), classified_work.wait())
        .await
        .expect("owner drop closes and releases all classifier ownership");
    cache.shutdown().await;
    assert!(requests[0].contains(STORAGE_CACHE_BACKGROUND_FILL_SHUTDOWN_CANCELLED));
    assert!(!requests[0].contains("storage_cache_background_fill_scheduled_count"));
    assert!(!entry_dir(&home, name, false).exists());
    assert_eq!(
        std::fs::read(home.storage_cache_dir(name, VERSION).join("archive.tar.gz")).unwrap(),
        bytes,
    );
}
