use super::phase_diagnostics::GatedResponse;
use super::*;
use std::sync::atomic::AtomicBool;

#[tokio::test]
async fn saturated_delivery_overlaps_only_untouched_ordinary_cache_slots() {
    for cache_state in ["missing", "warm", "lock", "abort"] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let cache = decoded::DecodedCache::new(home.clone());
        let archive = tarball_with_contents(b"fresh archive bytes\n");
        let ready = tarball_with_contents(b"ready decoded bytes\n");
        write_cached_archive(&home, "ready-decoded", "v1", &ready);
        write_storage_lock(&home, "ready-decoded", "v1");
        cache
            .warm_from_archive("ready-decoded", "v1")
            .await
            .unwrap();

        let ordinary_url = "https://example.test/ordinary";
        if cache_state == "warm" {
            write_cached_archive(&home, "ordinary", "v1", &archive);
        }
        if cache_state == "lock" {
            write_storage_lock(&home, "ordinary", "v1");
        }
        let mut storages = Vec::new();
        let mut requests = Vec::new();
        for index in 0..FRESH_DELIVERY_PER_RUN_LIMIT {
            let server = GatedResponse::start(archive.clone()).await;
            storages.push(storage_entry_with_archive_size(
                format!("/mnt/fresh-{index}"),
                server.url.clone(),
                &format!("fresh-{index}"),
                "v1",
                Some(archive.len() as u64),
            ));
            requests.push(server);
        }
        storages.push(storage_entry(
            "/mnt/ordinary".into(),
            ordinary_url.into(),
            "ordinary",
            "v1",
        ));
        storages.push(storage_entry(
            "/mnt/ready-decoded".into(),
            "https://example.test/decoded".into(),
            "ready-decoded",
            "v1",
        ));
        let mut plan = plan_from_entries(storages, Vec::new(), None);
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
        assert_eq!(plan.decoded_mount_count(), 1);
        let cancel = delivery.cancellation_token();
        let mut held_bodies = Vec::new();
        let mut servers = Vec::new();
        for response in requests {
            tokio::time::timeout(Duration::from_secs(5), response.requested)
                .await
                .unwrap()
                .unwrap();
            response.headers.send(()).unwrap();
            held_bodies.push(response.body);
            servers.push(response.task);
        }
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT - FRESH_DELIVERY_PER_RUN_LIMIT
        );

        let runtime = temp.path().join("runtime");
        let sandbox = Arc::new(MockSandbox::new("saturated-archive-delivery"));
        let (send, receive) = oneshot::channel();
        let application = GuestApplication::new(
            send,
            runtime.clone(),
            "saturated-archive-delivery".into(),
            Duration::from_secs(300),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        let task = tokio::spawn({
            let sandbox = sandbox.clone();
            let home = home.clone();
            async move {
                let mut prepared = PreparedStorage { plan, delivery };
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

        let early = matches!(cache_state, "missing" | "abort");
        if early {
            held_bodies.remove(0).send(()).unwrap();
        } else {
            for body in held_bodies.drain(..) {
                body.send(()).unwrap();
            }
        }
        let input = tokio::time::timeout(Duration::from_secs(5), receive)
            .await
            .unwrap()
            .unwrap();
        assert!(input.decoded_tail.is_none());
        assert_eq!(input.initial.files.len(), 1);
        let ordinary = input
            .initial
            .manifest
            .storages
            .iter()
            .find(|entry| entry.mount_path == "/mnt/ordinary")
            .unwrap();
        let expected_url = if cache_state == "warm" {
            format!("file://{}", guest_archive_path("ordinary", "v1"))
        } else {
            ordinary_url.into()
        };
        assert_eq!(ordinary.archive_url.as_deref(), Some(expected_url.as_str()));
        let readiness = input.initial.manifest.archive_readiness;
        assert_eq!(readiness.is_some(), early);
        if let Some(readiness) = &readiness {
            assert_eq!(readiness.sources.len(), FRESH_DELIVERY_PER_RUN_LIMIT);
            assert!(sandbox.write_files_calls().len() <= 1);
            assert!(sandbox.private_write_files_calls().len() <= 1);
            assert!(!task.is_finished());
        }
        if cache_state == "abort" {
            cancel.cancel();
        } else {
            for body in held_bodies.drain(..) {
                body.send(()).unwrap();
            }
        }

        let result = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        if cache_state == "abort" {
            assert!(matches!(result, Err(RunnerError::Cancelled)));
            let abort = sandbox.private_write_file_calls();
            assert_eq!(abort.len(), 1);
            assert_eq!(
                Path::new(&abort[0].path),
                readiness.as_ref().unwrap().failed_path(&runtime)
            );
            assert!(sandbox.private_write_files_calls().len() <= 1);
        } else {
            drop(result.unwrap());
            let staged = sandbox.write_files_calls();
            let files = staged
                .iter()
                .flat_map(|batch| &batch.files)
                .collect::<Vec<_>>();
            assert_eq!(
                files.len(),
                FRESH_DELIVERY_PER_RUN_LIMIT + usize::from(cache_state == "warm"),
            );
            assert!(files.iter().all(|file| file.content == archive));
            if let Some(readiness) = readiness {
                let mut published = sandbox
                    .private_write_files_calls()
                    .into_iter()
                    .flat_map(|batch| batch.files)
                    .map(|file| {
                        assert!(file.content.is_empty());
                        PathBuf::from(file.path)
                    })
                    .collect::<Vec<_>>();
                published.sort();
                let expected = (0..FRESH_DELIVERY_PER_RUN_LIMIT)
                    .map(|index| readiness.ready_path(&runtime, index))
                    .collect::<Vec<_>>();
                assert_eq!(published, expected);
            } else {
                assert!(sandbox.storage_manifest_calls().is_empty());
            }
        }
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT
        );
        for server in servers {
            server.finish().await;
        }
        admission.shutdown().await;
    }
}

#[tokio::test]
async fn complete_ready_inputs_are_handed_off_before_cold_delivery_with_joined_failures() {
    assert_ready_input_lifecycle(false).await;
}

#[tokio::test]
async fn split_ready_inputs_preserve_order_and_join_publication_failures() {
    assert_ready_input_lifecycle(true).await;
}

#[tokio::test]
async fn optional_prefetch_overlaps_large_decoded_application_and_publishes_its_failure() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let cache = decoded::DecodedCache::new(home.clone());
    let bytes = tarball_with_contents(b"archive bytes\n");
    let server = GatedResponse::start(bytes.clone()).await;
    let name = guest_contracts::storage_manifest::WORKFLOW_STORAGE_NAME;
    let mut optional = storage_entry_with_archive_size(
        "/mnt/optional".into(),
        server.url,
        name,
        "v1",
        Some(bytes.len() as u64),
    );
    optional.optional = true;
    write_cached_archive(&home, "ready", "v1", &bytes);
    write_storage_lock(&home, "ready", "v1");
    cache.warm_from_archive("ready", "v1").await.unwrap();
    let ready = storage_entry(
        "/mnt/ready".into(),
        format!(
            "https://example.test/ready?{}",
            "p".repeat(
                guest_contracts::storage_files::MAX_COMPLETE_MANIFEST_BYTES
                    - guest_contracts::storage_files::MAX_PAYLOAD_BYTES
            )
        ),
        "ready",
        "v1",
    );
    write_cached_archive(&home, "compressed", "v1", &bytes);
    let compressed = storage_entry(
        "/mnt/compressed".into(),
        "https://example.test/zip".into(),
        "compressed",
        "v1",
    );
    let mut plan = plan_from_entries(vec![optional, ready, compressed], Vec::new(), None);
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

    // The request must begin before the Guest storage owner starts.
    tokio::time::timeout(Duration::from_secs(5), server.requested)
        .await
        .unwrap()
        .unwrap();
    server.headers.send(()).unwrap();
    let mut prepared = PreparedStorage { plan, delivery };
    let sandbox = Arc::new(MockSandbox::new("optional-early-application"));
    let (send, receive) = oneshot::channel();
    let runtime = temp.path().join("runtime");
    let application = GuestApplication::new(
        send,
        runtime.clone(),
        "optional-early".into(),
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
    let input = tokio::time::timeout(Duration::from_secs(5), receive)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(input.initial.files.len(), 1, "keep the warm decoded hit");
    assert!(input.decoded_tail.is_none(), "Guest must see all mounts");
    let readiness = input.initial.manifest.archive_readiness.unwrap();
    assert!(
        !task.is_finished(),
        "Guest application starts before cold response completes"
    );
    let cache_dir = home_at(&temp).storage_cache_dir(name, "v1");
    fs::create_dir_all(&cache_dir).await.unwrap();
    fs::write(cache_dir.join("existing"), b"force publication failure")
        .await
        .unwrap();
    server.body.send(()).unwrap();
    drop(
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
    );

    let published = sandbox.private_write_files_calls();
    assert_eq!(published.len(), 1);
    assert_eq!(
        published[0].files[0].path,
        readiness.unavailable_path(&runtime, 0).to_str().unwrap()
    );
    assert_eq!(
        sandbox.write_files_calls().len(),
        1,
        "only the warm archive is staged"
    );
    assert!(
        sandbox.private_write_file_calls().is_empty(),
        "other mounts can continue"
    );
    server.task.finish().await;
    admission.shutdown().await;
}

async fn assert_ready_input_lifecycle(split: bool) {
    // Every case reaches the same causal handoff before releasing the HTTP
    // body. Failure cases keep the original accepted population owner.
    for failure in [
        "none",
        "publication",
        "ready-marker",
        "abort-marker",
        "consumer",
        "consumer-staging",
        "ineligible",
        "check-failed",
        "ordinary-over-limit",
    ] {
        if failure == "ordinary-over-limit" && !split {
            continue;
        }
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let cache = decoded::DecodedCache::new(home.clone());
        let bytes = tarball_with_contents(b"complete cold bytes\n");
        let warm = tarball_with_contents(b"complete ready bytes\n");
        write_cached_archive(&home, "ready", "v1", &warm);
        let server = GatedResponse::start(bytes.clone()).await;
        let mut storages = vec![
            storage_entry_with_archive_size(
                "/mnt/pending".into(),
                server.url.clone(),
                "pending",
                "v1",
                Some(bytes.len() as u64),
            ),
            storage_entry(
                "/mnt/ready".into(),
                "https://example.test/ready".into(),
                "ready",
                "v1",
            ),
        ];
        if split {
            let decoded = tarball_with_contents(b"decoded continuation\n");
            write_cached_archive(&home, "decoded", "v1", &decoded);
            write_storage_lock(&home, "decoded", "v1");
            cache.warm_from_archive("decoded", "v1").await.unwrap();
            assert!(cache.get_ready("decoded", "v1").await.unwrap().is_some());
            storages.extend((0..3).map(|index| {
                storage_entry(
                    format!("/mnt/decoded-{index}"),
                    format!("https://example.test/decoded?{}", "q".repeat(70_000)),
                    "decoded",
                    "v1",
                )
            }));
            if failure == "ordinary-over-limit" {
                storages.extend((0..400).map(|index| {
                    storage_entry(
                        format!("/mnt/ordinary/{index}/{}", "p".repeat(80)),
                        "https://example.test/ready".into(),
                        "ready",
                        "v1",
                    )
                }));
            }
        }
        let mut plan = plan_from_entries(
            storages,
            vec![artifact_entry(
                "/mnt/alias".into(),
                server.url.clone(),
                "pending",
                "v1",
            )],
            None,
        );
        if split {
            assert!(
                serde_json::to_vec(&plan.clone().into_guest_manifest())
                    .unwrap()
                    .len()
                    > guest_contracts::storage_files::MAX_MANIFEST_BYTES
            );
        }
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
        tokio::time::timeout(Duration::from_secs(5), server.requested)
            .await
            .unwrap()
            .unwrap();
        server.headers.send(()).unwrap();
        let mut prepared = PreparedStorage { plan, delivery };
        assert_eq!(
            prepared.plan.decoded_mount_count(),
            if split { 3 } else { 0 }
        );
        let cancel = prepared.delivery.cancellation_token();
        let sandbox = Arc::new(MockSandbox::new("early-application"));
        if failure == "ineligible" {
            sandbox.push_exec_result(Ok(sandbox::ExecResult::new(
                0,
                b"false\n".to_vec(),
                Vec::new(),
            )));
        }
        if failure == "check-failed" {
            sandbox.push_exec_result(Ok(sandbox::ExecResult::new(
                1,
                Vec::new(),
                b"check error".to_vec(),
            )));
        }
        let staging = (failure == "consumer-staging").then(MockLifecycleGate::new);
        if let Some(gate) = &staging {
            sandbox.set_write_file_lifecycle_gate(gate.clone());
            gate.release_one();
        }
        if failure == "ready-marker" {
            sandbox
                .push_private_write_files_result(Err(sandbox_write_file_error("ready rejected")));
        }
        if failure == "abort-marker" {
            sandbox.push_private_write_file_result(Err(sandbox_write_file_error("abort rejected")));
        }
        let host_failed = Arc::new(AtomicBool::new(false));
        let (send, receive) = oneshot::channel();
        let runtime = temp.path().join("runtime");
        let application = GuestApplication::new(
            send,
            runtime.clone(),
            "early-application".into(),
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
                (result, telemetry)
            }
        });
        if failure == "ordinary-over-limit" {
            server.body.send(()).unwrap();
            let input = tokio::time::timeout(Duration::from_secs(5), receive)
                .await
                .unwrap()
                .unwrap();
            assert!(input.initial.manifest.archive_readiness.is_none());
            assert_eq!(input.initial.files.len(), 3);
            assert!(input.decoded_tail.is_none());
            let (result, _) = task.await.unwrap();
            drop(result.unwrap());
            assert!(sandbox.storage_manifest_calls().is_empty());
            server.task.finish().await;
            admission.shutdown().await;
            continue;
        }
        if matches!(failure, "ineligible" | "check-failed") {
            tokio::time::timeout(Duration::from_secs(5), async {
                while sandbox.storage_manifest_calls().is_empty() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            if failure == "ineligible" {
                server.body.send(()).unwrap();
                let input = tokio::time::timeout(Duration::from_secs(5), receive)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(input.initial.manifest.archive_readiness.is_none());
                assert!(input.decoded_tail.is_none());
            } else {
                assert!(
                    tokio::time::timeout(Duration::from_secs(5), receive)
                        .await
                        .unwrap()
                        .is_err()
                );
            }
            let (result, _) = tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(result.is_ok(), failure == "ineligible");
            assert!(sandbox.private_write_files_calls().is_empty());
            assert!(sandbox.private_write_file_calls().is_empty());
            assert_eq!(
                admission.permits.available_permits(),
                FRESH_DELIVERY_RUNNER_LIMIT
            );
            server.task.finish().await;
            admission.shutdown().await;
            continue;
        }
        let input = tokio::time::timeout(Duration::from_secs(5), receive)
            .await
            .unwrap()
            .unwrap();
        if split {
            let tail = input.decoded_tail.as_ref().expect("decoded continuation");
            assert_eq!(tail.files.len(), 3);
            assert_eq!(tail.manifest.storages.len(), 3);
            assert!(tail.manifest.cleanup_paths.is_empty());
            assert!(tail.manifest.instruction_cleanups.is_empty());
            assert!(tail.manifest.archive_readiness.is_none());
            assert!(input.initial.files.is_empty());
        } else {
            assert!(input.decoded_tail.is_none());
        }
        let readiness = input
            .initial
            .manifest
            .archive_readiness
            .as_ref()
            .expect("real pending source");
        readiness.validate(&input.initial.manifest).unwrap();
        assert_eq!(
            readiness.sources.len(),
            1,
            "one source serves aliased targets"
        );
        assert_eq!(
            input.initial.manifest.storages[0].archive_url,
            input.initial.manifest.artifacts[0].archive_url
        );
        assert_eq!(readiness.wait_timeout(), Duration::from_secs(300));
        let staged = sandbox.write_files_calls();
        assert_eq!(staged.len(), 1);
        assert_eq!(staged[0].files[0].content, warm);
        assert!(
            !task.is_finished(),
            "handoff must not finish the pending owner"
        );
        assert!(sandbox.private_write_files_calls().is_empty());
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT - 1
        );

        if matches!(failure, "publication" | "abort-marker") {
            let cache_dir = home.storage_cache_dir("pending", "v1");
            fs::create_dir_all(&cache_dir).await.unwrap();
            fs::write(cache_dir.join("retained"), b"publication conflict")
                .await
                .unwrap();
        }
        if failure == "consumer" {
            cancel.cancel();
        } else {
            server.body.send(()).unwrap();
        }
        if let Some(gate) = staging {
            gate.wait_entered(2, Duration::from_secs(5)).await.unwrap();
            cancel.cancel();
            assert!(!task.is_finished(), "accepted staging must remain owned");
            assert_eq!(
                admission.permits.available_permits(),
                FRESH_DELIVERY_RUNNER_LIMIT - 1
            );
            gate.release_one();
        }
        let (result, telemetry) = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        if failure == "none" {
            drop(result.unwrap());
            let published = sandbox.private_write_files_calls();
            assert_eq!(published.len(), 1);
            assert_eq!(
                published[0].files[0].path,
                readiness.ready_path(&runtime, 0).to_str().unwrap()
            );
            assert!(published[0].files[0].content.is_empty());
            assert_eq!(sandbox.write_files_calls()[1].files[0].content, bytes);
            assert_eq!(
                fs::read(
                    home.storage_cache_dir("pending", "v1")
                        .join("archive.tar.gz")
                )
                .await
                .unwrap(),
                bytes
            );
        } else {
            let error = result
                .err()
                .expect("producer/consumer failure must fail the handoff");
            if failure == "ready-marker" {
                assert!(error.to_string().contains("ready rejected"));
            }
            if failure == "abort-marker" {
                assert!(
                    error.to_string().contains("rename"),
                    "preserve original failure: {error}"
                );
                assert_op(
                    &telemetry.pending_ops_snapshot(),
                    "storage_cache_guest_abort_publish",
                    false,
                );
            }
            assert!(host_failed.load(Ordering::Acquire));
            if failure == "consumer-staging" {
                assert!(sandbox.private_write_files_calls().is_empty());
            }
            let aborted = sandbox.private_write_file_calls();
            assert_eq!(aborted.len(), 1);
            assert_eq!(
                aborted[0].path,
                readiness.failed_path(&runtime).to_str().unwrap()
            );
        }
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT
        );
        server.task.finish().await;
        admission.shutdown().await;
    }
}
