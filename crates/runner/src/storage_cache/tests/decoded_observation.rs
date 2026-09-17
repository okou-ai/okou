use super::*;

const NAME: &str = "decoded-observation";
const VERSION: &str = "v1";

fn positive_dir(home: &HomePaths) -> PathBuf {
    home.storages_dir()
        .join(short_digest(NAME))
        .join(format!("decoded-v1-{}", short_digest(VERSION)))
}

fn conflicting_plan(url: &str) -> StoragePlan {
    plan_from_entries(
        vec![
            storage_entry("/mnt/parent".into(), url.into(), NAME, VERSION),
            storage_entry("/mnt/parent/child".into(), url.into(), NAME, VERSION),
        ],
        Vec::new(),
        None,
    )
}

async fn warm_positive(home: &HomePaths, cache: &decoded::DecodedCache) {
    write_cached_archive(home, NAME, VERSION, &tarball_bytes());
    write_storage_lock(home, NAME, VERSION);
    cache.warm_from_archive(NAME, VERSION).await.unwrap();
}

#[tokio::test]
async fn repeated_mount_conflicts_stage_archives_without_optional_warming() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let cache = decoded::DecodedCache::new(home.clone());
    warm_positive(&home, &cache).await;

    for use_fresh_delivery in [false, true] {
        let mut plan = conflicting_plan("https://storage.example/unused");
        let mut telemetry = new_telemetry();
        let mut fresh = if use_fresh_delivery {
            Some(
                prepare_fresh_archive_delivery(
                    &mut plan,
                    &home,
                    &FreshArchiveDeliveryAdmission::new(),
                    &CancellationToken::new(),
                    &mut telemetry,
                    Some(&cache),
                )
                .await
                .unwrap(),
            )
        } else {
            None
        };
        let deferred = populate_cache_with_fresh_delivery(
            &mut plan,
            &MockSandbox::new("ready-conflict"),
            &home,
            &mut telemetry,
            fresh.as_mut(),
            Some(&cache),
        )
        .await
        .unwrap();
        assert!(deferred.is_none());
        assert!(plan.take_decoded().is_empty());
        for index in 0..2 {
            assert!(
                storage_archive_url(&plan, index)
                    .unwrap()
                    .starts_with("file://")
            );
        }
    }
    cache.shutdown().await;
}

#[tokio::test]
async fn positive_observation_does_not_suppress_an_archive_evicted_after_preparation() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let cache = decoded::DecodedCache::new(home.clone());
    warm_positive(&home, &cache).await;
    let body = tarball_bytes();
    let server = MockServer::start_async().await;
    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/archive")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", format!("bytes 0-0/{}", body.len()))
                .body(&body[..1]);
        })
        .await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET).path("/archive").header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;
    let mut plan = conflicting_plan(&server.url("/archive"));
    let mut telemetry = new_telemetry();
    let mut fresh = prepare_fresh_archive_delivery(
        &mut plan,
        &home,
        &FreshArchiveDeliveryAdmission::new(),
        &CancellationToken::new(),
        &mut telemetry,
        Some(&cache),
    )
    .await
    .unwrap();
    fresh.finish_classification(&mut telemetry).await.unwrap();
    let archive = home.storage_cache_dir(NAME, VERSION).join("archive.tar.gz");
    std::fs::remove_file(&archive).unwrap();
    let deferred = populate_cache_with_fresh_delivery(
        &mut plan,
        &MockSandbox::new("archive-eviction"),
        &home,
        &mut telemetry,
        Some(&mut fresh),
        Some(&cache),
    )
    .await
    .unwrap()
    .expect("a genuine archive miss still selects fill");
    deferred.run().await;
    assert_eq!(std::fs::read(archive).unwrap(), body);
    probe.assert_calls_async(1).await;
    get.assert_calls_async(1).await;
    cache.shutdown().await;
}

#[tokio::test]
async fn decoded_eviction_is_reconsidered_by_the_next_plan_after_owner_restart() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let cache = decoded::DecodedCache::new(home.clone());
    warm_positive(&home, &cache).await;
    let url = "https://storage.example/unused";
    let mut plan = conflicting_plan(url);
    let mut telemetry = new_telemetry();
    let mut fresh = prepare_fresh_archive_delivery(
        &mut plan,
        &home,
        &FreshArchiveDeliveryAdmission::new(),
        &CancellationToken::new(),
        &mut telemetry,
        Some(&cache),
    )
    .await
    .unwrap();
    std::fs::remove_dir_all(positive_dir(&home)).unwrap();
    assert!(
        populate_cache_with_fresh_delivery(
            &mut plan,
            &MockSandbox::new("decoded-eviction"),
            &home,
            &mut telemetry,
            Some(&mut fresh),
            Some(&cache),
        )
        .await
        .unwrap()
        .is_none()
    );
    cache.shutdown().await;

    let restarted = decoded::DecodedCache::new(home.clone());
    let mut next = conflicting_plan(url);
    let deferred = populate_cache_with_fresh_delivery(
        &mut next,
        &MockSandbox::new("next-plan"),
        &home,
        &mut new_telemetry(),
        None,
        Some(&restarted),
    )
    .await
    .unwrap()
    .expect("evicted decoded contents require useful warming on a later plan");
    deferred.run().await;
    let files = restarted.get_ready(NAME, VERSION).await.unwrap().unwrap();
    assert_eq!(files.files[0].content, b"storage cache test file\n");
    restarted.shutdown().await;
}

#[tokio::test]
async fn busy_or_later_published_positive_keeps_this_plans_warming() {
    for publish_after_lookup in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let cache = decoded::DecodedCache::new(home.clone());
        warm_positive(&home, &cache).await;
        let writer = if publish_after_lookup {
            std::fs::remove_dir_all(positive_dir(&home)).unwrap();
            None
        } else {
            Some(
                lock::acquire(home.storage_lock_for_cache_key(
                    &short_digest(NAME),
                    &format!("decoded-v1-{}", short_digest(VERSION)),
                ))
                .await
                .unwrap(),
            )
        };
        let mut plan = conflicting_plan("https://storage.example/unused");
        let mut telemetry = new_telemetry();
        let mut fresh = prepare_fresh_archive_delivery(
            &mut plan,
            &home,
            &FreshArchiveDeliveryAdmission::new(),
            &CancellationToken::new(),
            &mut telemetry,
            Some(&cache),
        )
        .await
        .unwrap();
        drop(writer);
        if publish_after_lookup {
            cache.warm_from_archive(NAME, VERSION).await.unwrap();
        }
        let deferred = populate_cache_with_fresh_delivery(
            &mut plan,
            &MockSandbox::new("unobserved-positive"),
            &home,
            &mut telemetry,
            Some(&mut fresh),
            Some(&cache),
        )
        .await
        .unwrap()
        .expect("an unvalidated observation cannot suppress warming");
        deferred.run().await;
        let files = cache.get_ready(NAME, VERSION).await.unwrap().unwrap();
        assert_eq!(files.files[0].content, b"storage cache test file\n");
        cache.shutdown().await;
    }
}

#[tokio::test]
async fn malformed_positive_metadata_still_fails_preparation() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let cache = decoded::DecodedCache::new(home.clone());
    warm_positive(&home, &cache).await;
    std::fs::write(positive_dir(&home).join("index.json"), b"{}").unwrap();
    let mut plan = conflicting_plan("https://storage.example/unused");
    let result = prepare_fresh_archive_delivery(
        &mut plan,
        &home,
        &FreshArchiveDeliveryAdmission::new(),
        &CancellationToken::new(),
        &mut new_telemetry(),
        Some(&cache),
    )
    .await;
    assert!(result.is_err());
    cache.shutdown().await;
}

#[tokio::test]
async fn same_key_artifact_consumer_keeps_required_archive_fill() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let cache = decoded::DecodedCache::new(home.clone());
    warm_positive(&home, &cache).await;
    let archive = home.storage_cache_dir(NAME, VERSION).join("archive.tar.gz");
    std::fs::remove_file(&archive).unwrap();
    let body = tarball_bytes();
    let server = MockServer::start_async().await;
    let probe = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/archive")
                .header("range", "bytes=0-0");
            then.status(206)
                .header("content-range", format!("bytes 0-0/{}", body.len()))
                .body(&body[..1]);
        })
        .await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET).path("/archive").header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;
    let mut plan = plan_from_entries(
        vec![storage_entry(
            "/mnt/storage".into(),
            server.url("/archive"),
            NAME,
            VERSION,
        )],
        vec![artifact_entry(
            "/mnt/artifact".into(),
            server.url("/archive"),
            NAME,
            VERSION,
        )],
        None,
    );
    let deferred = populate_cache_with_fresh_delivery(
        &mut plan,
        &MockSandbox::new("archive-consumer"),
        &home,
        &mut new_telemetry(),
        None,
        Some(&cache),
    )
    .await
    .unwrap()
    .expect("mixed archive demand still fills");
    assert!(plan.take_decoded().is_empty());
    deferred.run().await;
    assert_eq!(std::fs::read(archive).unwrap(), body);
    probe.assert_calls_async(1).await;
    get.assert_calls_async(1).await;
    cache.shutdown().await;
}
