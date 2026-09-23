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
async fn same_key_storage_and_artifact_share_decoded_files_without_archive_fill() {
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
    .unwrap();
    assert!(deferred.is_none());
    let files = plan.take_decoded();
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].1.files[0].content, b"storage cache test file\n");
    assert!(std::sync::Arc::ptr_eq(&files[0].1, &files[1].1));
    assert!(!archive.exists());
    probe.assert_calls_async(0).await;
    get.assert_calls_async(0).await;
    cache.shutdown().await;
}

#[tokio::test]
async fn archive_required_instruction_does_not_exclude_same_key_decoded_targets() {
    for use_fresh_delivery in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let cache = decoded::DecodedCache::new(home.clone());
        warm_positive(&home, &cache).await;
        let url = "https://storage.example/unused";
        let mut instruction = storage_entry("/mnt/instructions".into(), url.into(), NAME, VERSION);
        instruction.instructions_target_filename = Some("AGENTS.md".into());
        let mut plan = plan_from_entries(
            vec![
                instruction,
                storage_entry("/mnt/storage".into(), url.into(), NAME, VERSION),
            ],
            vec![artifact_entry(
                "/mnt/artifact".into(),
                url.into(),
                NAME,
                VERSION,
            )],
            None,
        );
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
            &MockSandbox::new("mixed-key-instruction"),
            &home,
            &mut telemetry,
            fresh.as_mut(),
            Some(&cache),
        )
        .await
        .unwrap();
        assert!(deferred.is_none());
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_ARTIFACT_DECODED, true);
        assert!(ops.iter().all(|(action, _, _)| {
            action != STORAGE_CACHE_ARTIFACT_ARCHIVE_HIT
                && action != STORAGE_CACHE_ARTIFACT_DECODED_INELIGIBLE
        }));
        let files = plan.take_decoded();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].0, "/mnt/storage");
        assert_eq!(files[1].0, "/mnt/artifact");
        assert!(std::sync::Arc::ptr_eq(&files[0].1, &files[1].1));
        let manifest = plan.into_guest_manifest();
        assert!(
            manifest.storages[0]
                .archive_url
                .as_deref()
                .unwrap()
                .starts_with("file://")
        );
        assert_eq!(manifest.storages[1].archive_url.as_deref(), Some(url));
        assert_eq!(manifest.artifacts[0].archive_url.as_deref(), Some(url));
        guest_contracts::storage_files::validate_bindings(
            &manifest,
            files.iter().map(|(mount, _)| mount.as_str()),
        )
        .unwrap();
        cache.shutdown().await;
    }
}

#[tokio::test]
async fn missing_decoded_files_do_not_mark_same_key_artifact_ineligible() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let cache = decoded::DecodedCache::new(home);
    let url = "https://storage.example/unused";
    let mut instruction = storage_entry("/mnt/instructions".into(), url.into(), NAME, VERSION);
    instruction.instructions_target_filename = Some("AGENTS.md".into());
    let mut plan = plan_from_entries(
        vec![instruction],
        vec![artifact_entry(
            "/mnt/artifact".into(),
            url.into(),
            NAME,
            VERSION,
        )],
        None,
    );
    let mut groups = group_targets(collect_targets(plan.cache_candidates()));
    let mut telemetry = new_telemetry();

    prepare_decoded_storage(&mut plan, &mut groups, &cache, &mut telemetry)
        .await
        .unwrap();

    assert!(plan.take_decoded().is_empty());
    assert!(
        telemetry
            .pending_ops_snapshot()
            .iter()
            .all(|(action, _, _)| action != STORAGE_CACHE_ARTIFACT_DECODED_INELIGIBLE)
    );
    cache.shutdown().await;
}

#[tokio::test]
async fn archive_required_group_warms_decoded_files_for_later_eligible_targets() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let cache = decoded::DecodedCache::new(home.clone());
    write_cached_archive(&home, NAME, VERSION, &tarball_bytes());
    write_storage_lock(&home, NAME, VERSION);
    let archive = home.storage_cache_dir(NAME, VERSION).join("archive.tar.gz");
    let url = "https://storage.example/unused";
    let mut instruction = storage_entry("/mnt/instructions".into(), url.into(), NAME, VERSION);
    instruction.instructions_target_filename = Some("AGENTS.md".into());
    let mut plan = plan_from_entries(
        vec![
            instruction,
            storage_entry("/mnt/storage".into(), url.into(), NAME, VERSION),
        ],
        vec![artifact_entry(
            "/mnt/artifact".into(),
            url.into(),
            NAME,
            VERSION,
        )],
        None,
    );

    let deferred = populate_cache_with_fresh_delivery(
        &mut plan,
        &MockSandbox::new("mixed-key-warm"),
        &home,
        &mut new_telemetry(),
        None,
        Some(&cache),
    )
    .await
    .unwrap()
    .expect("archive hit should schedule decoded warming for eligible targets");
    assert!(plan.take_decoded().is_empty());
    deferred.run().await;

    assert!(cache.get_ready(NAME, VERSION).await.unwrap().is_some());
    assert!(
        archive.exists(),
        "instruction consumers still need the archive"
    );
    cache.shutdown().await;
}

#[tokio::test]
async fn mixed_key_does_not_hide_corrupt_decoded_files_from_eligible_targets() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let cache = decoded::DecodedCache::new(home.clone());
    warm_positive(&home, &cache).await;
    std::fs::write(positive_dir(&home).join("index.json"), b"{").unwrap();
    let url = "https://storage.example/unused";
    let mut instruction = storage_entry("/mnt/instructions".into(), url.into(), NAME, VERSION);
    instruction.instructions_target_filename = Some("AGENTS.md".into());
    let mut plan = plan_from_entries(
        vec![
            instruction,
            storage_entry("/mnt/storage".into(), url.into(), NAME, VERSION),
        ],
        Vec::new(),
        None,
    );
    let result = populate_cache_with_fresh_delivery(
        &mut plan,
        &MockSandbox::new("mixed-key-corrupt"),
        &home,
        &mut new_telemetry(),
        None,
        Some(&cache),
    )
    .await;
    assert!(result.is_err());
    cache.shutdown().await;
}
