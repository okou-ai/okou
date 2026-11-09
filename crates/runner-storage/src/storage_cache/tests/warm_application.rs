use super::*;
use sha2::{Digest, Sha256};
use std::sync::atomic::AtomicBool;

#[tokio::test]
async fn warm_handoff_owns_pending_bytes_and_joins_staging_before_publication() {
    for failure in [
        "none",
        "staging",
        "ready",
        "abort",
        "consumer",
        "partly-decoded",
    ] {
        let root = tempfile::tempdir().unwrap();
        let home = home_at(&root);
        let cache = decoded::DecodedCache::new(home.clone());
        let ready = tarball_with_contents(b"decoded ready bytes");
        let warm = tarball_with_contents(b"pending compressed bytes");
        write_cached_archive(&home, "ready", "v1", &ready);
        write_storage_lock(&home, "ready", "v1");
        cache.warm_from_archive("ready", "v1").await.unwrap();
        write_cached_archive(&home, "warm", "v1", &warm);
        let mut warm_entry = storage_entry(
            "/mnt/warm".into(),
            "https://unused/warm".into(),
            "warm",
            "v1",
        );
        let storages = if failure == "partly-decoded" {
            write_storage_lock(&home, "warm", "v1");
            cache.warm_from_archive("warm", "v1").await.unwrap();
            warm_entry.template_guidance = Some(
                guest_contracts::storage_manifest::TemplateGuidanceReference {
                    sha256: hex::encode(Sha256::digest(&warm)),
                    archive_bytes: warm.len() as u64,
                },
            );
            // One group needs compressed template verification while its
            // Artifact target already owns decoded bytes. No fully decoded
            // group exists to act as an incidental readiness signal.
            vec![warm_entry]
        } else {
            vec![
                storage_entry(
                    "/mnt/ready".into(),
                    "https://unused/ready".into(),
                    "ready",
                    "v1",
                ),
                warm_entry,
            ]
        };
        let mut plan = plan_from_entries(
            storages,
            vec![artifact_entry(
                "/mnt/artifact".into(),
                "https://unused/artifact".into(),
                "warm",
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
            Some(&cache),
        )
        .await
        .unwrap();
        assert!(!delivery.has_owned_sources(&mut telemetry).await.unwrap());
        let mut prepared = PreparedStorage { plan, delivery };
        assert!(prepared.may_overlap_warm_staging());
        let cancel = prepared.delivery.cancellation_token();
        let sandbox = Arc::new(MockSandbox::new("warm-application"));
        let staging = MockLifecycleGate::new();
        sandbox.set_write_file_lifecycle_gate(staging.clone());
        if matches!(failure, "staging" | "abort") {
            sandbox.push_write_file_result(Err(sandbox_write_file_error("stage rejected")));
        }
        if failure == "ready" {
            sandbox
                .push_private_write_files_result(Err(sandbox_write_file_error("ready rejected")));
        }
        if failure == "abort" {
            sandbox.push_private_write_file_result(Err(sandbox_write_file_error("abort rejected")));
        }
        let host_failed = Arc::new(AtomicBool::new(false));
        let (send, receive) = oneshot::channel();
        let runtime = root.path().join("runtime");
        let application = GuestApplication::new(
            send,
            runtime.clone(),
            "warm-application".into(),
            Duration::from_secs(300),
            host_failed.clone(),
        )
        .unwrap();
        let task = tokio::spawn({
            let home = home.clone();
            let sandbox = sandbox.clone();
            async move {
                let result = populate_cache_for_guest(
                    &mut prepared,
                    sandbox.as_ref(),
                    &home,
                    &mut telemetry,
                    &cache,
                    application,
                )
                .await;
                cache.shutdown().await;
                result
            }
        });
        // This receive must complete while the first archive write is blocked.
        let input = tokio::time::timeout(Duration::from_secs(5), receive)
            .await
            .unwrap()
            .unwrap();
        staging
            .wait_entered(1, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(input.files.len(), 1);
        assert_eq!(
            input.files[0].1.files[0].content,
            if failure == "partly-decoded" {
                &b"pending compressed bytes"[..]
            } else {
                &b"decoded ready bytes"[..]
            }
        );
        let readiness = input.manifest.archive_readiness.unwrap();
        assert_eq!(
            readiness.sources,
            vec![format!("file://{}", guest_archive_path("warm", "v1"))]
        );
        if failure == "partly-decoded" {
            assert_eq!(
                input.manifest.storages[0].archive_url.as_ref(),
                readiness.sources.first()
            );
            assert_eq!(
                input.manifest.artifacts[0].archive_url.as_deref(),
                Some("https://unused/artifact")
            );
        } else {
            assert_eq!(
                input.manifest.storages[1].archive_url,
                input.manifest.artifacts[0].archive_url
            );
        }
        assert_eq!(sandbox.write_files_calls()[0].files[0].content, warm);
        assert!(sandbox.private_write_files_calls().is_empty());
        assert!(!task.is_finished());
        if failure == "consumer" {
            cancel.cancel();
            assert!(
                !task.is_finished(),
                "consumer cancellation cannot drop an accepted write"
            );
        }
        staging.release_one();
        let result = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        if matches!(failure, "none" | "partly-decoded") {
            drop(result.unwrap());
            let markers = sandbox.private_write_files_calls();
            assert_eq!(markers.len(), 1);
            assert_eq!(
                markers[0].files[0].path,
                readiness.ready_path(&runtime, 0).to_str().unwrap()
            );
            assert!(!host_failed.load(Ordering::Acquire));
        } else {
            assert!(result.is_err());
            assert!(host_failed.load(Ordering::Acquire));
            assert_eq!(
                sandbox.private_write_file_calls()[0].path,
                readiness.failed_path(&runtime).to_str().unwrap()
            );
            if failure != "ready" {
                assert!(sandbox.private_write_files_calls().is_empty());
            }
        }
        admission.shutdown().await;
    }
}

#[tokio::test]
async fn warm_controls_do_not_confuse_buffered_hits_with_readable_sources() {
    for case in [
        "single",
        "two-buffered",
        "all-decoded",
        "split",
        "ineligible",
    ] {
        let root = tempfile::tempdir().unwrap();
        let home = home_at(&root);
        let cache = decoded::DecodedCache::new(home.clone());
        let mut entries = Vec::new();
        for index in 0..2 {
            if case == "single" && index == 1 {
                break;
            }
            let name = format!("source-{index}");
            write_cached_archive(&home, &name, "v1", &tarball_bytes());
            write_storage_lock(&home, &name, "v1");
            if case == "all-decoded" || (matches!(case, "split" | "ineligible") && index == 0) {
                cache.warm_from_archive(&name, "v1").await.unwrap();
            }
            let url = if case == "split" && index == 0 {
                format!(
                    "https://unused/{}",
                    "x".repeat(guest_contracts::storage_files::MAX_MANIFEST_BYTES)
                )
            } else {
                format!("https://unused/{name}")
            };
            entries.push(storage_entry(format!("/mnt/{name}"), url, &name, "v1"));
        }
        let mut plan = plan_from_entries(entries, Vec::new(), None);
        let admission = FreshArchiveDeliveryAdmission::new();
        let mut telemetry = new_telemetry();
        let delivery = prepare_fresh_archive_delivery(
            &mut plan,
            &home,
            &admission,
            &CancellationToken::new(),
            &mut telemetry,
            Some(&cache),
        )
        .await
        .unwrap();
        let mut prepared = PreparedStorage { plan, delivery };
        assert_eq!(
            prepared.may_overlap_warm_staging(),
            !matches!(case, "single" | "all-decoded")
        );
        let sandbox = MockSandbox::new(case);
        if case == "ineligible" {
            sandbox.push_exec_result(Ok(sandbox::ExecResult::new(
                0,
                b"false\n".to_vec(),
                Vec::new(),
            )));
        }
        let (send, receive) = oneshot::channel();
        let application = GuestApplication::new(
            send,
            root.path().join("runtime"),
            case.into(),
            Duration::from_secs(300),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        drop(
            populate_cache_for_guest(
                &mut prepared,
                &sandbox,
                &home,
                &mut telemetry,
                &cache,
                application,
            )
            .await
            .unwrap(),
        );
        assert!(receive.await.unwrap().manifest.archive_readiness.is_none());
        assert_eq!(
            sandbox.storage_manifest_calls().len(),
            usize::from(case == "ineligible")
        );
        assert!(sandbox.private_write_files_calls().is_empty());
        cache.shutdown().await;
        admission.shutdown().await;
    }
}

#[tokio::test]
async fn warm_archive_only_overlap_waits_only_for_the_actual_remaining_batch() {
    let root = tempfile::tempdir().unwrap();
    let home = home_at(&root);
    let cache = decoded::DecodedCache::new(home.clone());
    let mut entries = Vec::new();
    for index in 0..=GUEST_STAGE_BATCH_MAX_FILES {
        let name = format!("source-{index}");
        write_cached_archive(&home, &name, "v1", &tarball_bytes());
        entries.push(storage_entry(
            format!("/mnt/{name}"),
            format!("https://unused/{name}"),
            &name,
            "v1",
        ));
    }
    let mut plan = plan_from_entries(entries, Vec::new(), None);
    let admission = FreshArchiveDeliveryAdmission::new();
    let mut telemetry = new_telemetry();
    let delivery = prepare_fresh_archive_delivery(
        &mut plan,
        &home,
        &admission,
        &CancellationToken::new(),
        &mut telemetry,
        Some(&cache),
    )
    .await
    .unwrap();
    let mut prepared = PreparedStorage { plan, delivery };
    let sandbox = Arc::new(MockSandbox::new("archive-only"));
    let staging = MockLifecycleGate::new();
    sandbox.set_write_file_lifecycle_gate(staging.clone());
    let (send, receive) = oneshot::channel();
    let application = GuestApplication::new(
        send,
        root.path().join("runtime"),
        "archive-only".into(),
        Duration::from_secs(300),
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    let task = tokio::spawn({
        let sandbox = sandbox.clone();
        async move {
            let result = populate_cache_for_guest(
                &mut prepared,
                sandbox.as_ref(),
                &home,
                &mut telemetry,
                &cache,
                application,
            )
            .await;
            cache.shutdown().await;
            result
        }
    });
    staging
        .wait_entered(1, Duration::from_secs(5))
        .await
        .unwrap();
    staging.release_one();
    let input = tokio::time::timeout(Duration::from_secs(5), receive)
        .await
        .unwrap()
        .unwrap();
    staging
        .wait_entered(2, Duration::from_secs(5))
        .await
        .unwrap();
    let readiness = input.manifest.archive_readiness.unwrap();
    assert_eq!(readiness.sources.len(), 1);
    let writes = sandbox.write_files_calls();
    assert_eq!(writes[0].files.len(), GUEST_STAGE_BATCH_MAX_FILES);
    assert_eq!(
        readiness.sources[0],
        format!("file://{}", writes[1].files[0].path)
    );
    assert!(sandbox.private_write_files_calls().is_empty());
    staging.release_one();
    drop(
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
    );
    admission.shutdown().await;
}
