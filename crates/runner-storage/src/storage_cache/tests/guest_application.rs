use super::phase_diagnostics::GatedResponse;
use super::*;
use sandbox_mock::MockSandboxOverrides;
use std::sync::atomic::AtomicBool;

#[tokio::test]
async fn late_blank_handoff_carries_only_a_small_fresh_artifact_and_its_permit() {
    let mut state = 24301_u32;
    let content = (0..96 * 1024)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as u8
        })
        .collect::<Vec<_>>();
    let oversized = tarball_with_contents(&content);
    assert!(oversized.len() > 64 * 1024);
    let small = tarball_bytes();

    for (blank, archive, retain, fail_staging) in [
        (true, &small, true, false),
        (true, &small, true, true),
        (false, &small, false, false),
        (true, &oversized, false, false),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let cache = decoded::DecodedCache::new(home.clone());
        let admission = FreshArchiveDeliveryAdmission::new();
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET).path("/fresh.tar.gz");
                then.status(200).body(archive.clone());
            })
            .await;
        write_cached_archive(&home, "ordinary", "v1", &small);
        let mut fresh = artifact_entry(
            "/home/user/artifact".into(),
            server.url("/fresh.tar.gz"),
            "fresh",
            "v1",
        );
        fresh.archive_size = Some(archive.len() as u64);
        let mut plan = plan_from_entries(
            vec![storage_entry(
                "/home/user/ordinary".into(),
                "https://example.test/ordinary".into(),
                "ordinary",
                "v1",
            )],
            vec![fresh],
            None,
        );
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
        let sandbox = MockSandbox::new("late-artifact");
        // If ordinary staging wins the race with publication, the Guest
        // declines early application. Either ordering uses the late handoff.
        sandbox.push_exec_result(Ok(sandbox::ExecResult::new(
            0,
            b"false\n".to_vec(),
            Vec::new(),
        )));
        let (send, receive) = oneshot::channel();
        let application = GuestApplication::new(
            send,
            temp.path().join("runtime"),
            "late-artifact".into(),
            Duration::from_secs(5),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        let application = if blank {
            application.with_blank_startup()
        } else {
            application
        };
        populate_cache_for_guest(
            &mut prepared,
            &sandbox,
            &home,
            &mut telemetry,
            &cache,
            application,
        )
        .await
        .unwrap();
        get.assert_calls_async(1).await;

        let input = receive.await.unwrap();
        assert!(input.initial.manifest.archive_readiness.is_none());
        let fresh_path = guest_archive_path("fresh", "v1");
        assert_eq!(
            input.initial.manifest.artifacts[0].archive_url.as_deref(),
            Some(format!("file://{fresh_path}").as_str()),
        );
        let paths = |sandbox: &MockSandbox| {
            sandbox
                .write_files_calls()
                .into_iter()
                .flat_map(|call| call.files.into_iter().map(|file| file.path))
                .collect::<Vec<_>>()
        };
        let ordinary_path = guest_archive_path("ordinary", "v1");
        assert_eq!(input.pending_archives.is_fresh(), retain);
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT - usize::from(retain),
        );
        if retain {
            assert_eq!(paths(&sandbox), std::slice::from_ref(&ordinary_path));
            let manifest = serde_json::to_vec(&input.initial.manifest).unwrap();
            let encoded = input.pending_archives.inline_input(&manifest).unwrap();
            let (_, payload) = guest_contracts::storage_files::split_input(&encoded).unwrap();
            let sources = guest_contracts::storage_files::inline_archives::decode(payload).unwrap();
            assert_eq!(sources.get(fresh_path.as_str()), Some(&archive.as_slice()));
            // Exercise the same owner when the executor needs the staged path.
            if fail_staging {
                sandbox.push_write_file_result(Err(sandbox_write_file_error("late stage failed")));
            }
            let stage_result = input.pending_archives.stage(&sandbox, &mut telemetry).await;
            if fail_staging {
                let error = stage_result.expect_err("the late stage failure must be returned");
                assert!(error.to_string().contains("late stage failed"));
            } else {
                stage_result.unwrap();
            }
        } else {
            assert!(input.pending_archives.is_empty());
        }
        assert_eq!(paths(&sandbox), [ordinary_path, fresh_path]);
        let ops = telemetry.pending_ops_snapshot();
        assert_op_count(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE, 2);
        assert_op_count(&ops, STORAGE_CACHE_STAGE_TOTAL, 1);
        assert_op(&ops, STORAGE_CACHE_STAGE_TOTAL, !fail_staging);
        assert_op_count(
            &ops,
            STORAGE_CACHE_FRESH_DELIVERY_STAGED,
            usize::from(!fail_staging),
        );
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT
        );
        cache.shutdown().await;
        admission.shutdown().await;
    }
}

#[tokio::test]
async fn saturated_delivery_reuses_staged_slots_before_remaining_fresh_bodies() {
    for (cache_state, guest_eligible, abort) in [
        ("missing", true, false),
        ("warm", true, false),
        ("locked", true, false),
        ("missing", true, true),
        ("warm", true, true),
        ("warm", false, false),
    ] {
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
        if matches!(cache_state, "warm" | "locked") {
            write_cached_archive(&home, "ordinary", "v1", &archive);
        }
        let _writer = if cache_state == "locked" {
            let lock::TryLock::Acquired(writer) =
                lock::try_acquire_or_busy(home.storage_lock("ordinary", "v1"))
                    .await
                    .unwrap()
            else {
                panic!("ordinary writer is already held");
            };
            Some(writer)
        } else {
            None
        };
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
        if cache_state != "missing" {
            // Seed the observed header delay without sleeping in this test.
            let mut phase = FreshArchivePhaseGuard::new(
                &delivery.phase_records,
                STORAGE_CACHE_FRESH_DELIVERY_HEADERS,
            );
            phase.started_at -= FRESH_DELIVERY_SLOW_HEADERS;
            phase.finish(Ok(()));
        }
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
        let marker_gate = MockLifecycleGate::new();
        let overrides = Arc::new(MockSandboxOverrides::new());
        if cache_state == "warm" && guest_eligible {
            overrides.set_private_write_file_lifecycle_gate(marker_gate.clone());
        }
        let sandbox = Arc::new(MockSandbox::with_overrides(
            "saturated-archive-delivery",
            overrides.clone(),
        ));
        if !guest_eligible {
            sandbox.push_exec_result(Ok(sandbox::ExecResult::new(
                0,
                b"false\n".to_vec(),
                Vec::new(),
            )));
        }
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

        held_bodies.remove(0).send(()).unwrap();
        if !guest_eligible {
            tokio::time::timeout(Duration::from_secs(5), async {
                while sandbox.storage_manifest_calls().is_empty() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
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
        assert_eq!(readiness.is_some(), guest_eligible);
        if let Some(readiness) = &readiness {
            assert_eq!(readiness.sources.len(), FRESH_DELIVERY_PER_RUN_LIMIT);
            if cache_state == "warm" {
                let paths = sandbox
                    .write_files_calls()
                    .into_iter()
                    .flat_map(|batch| batch.files)
                    .map(|file| file.path)
                    .collect::<Vec<_>>();
                assert_eq!(
                    paths,
                    [
                        guest_archive_path("fresh-0", "v1"),
                        guest_archive_path("ordinary", "v1"),
                    ]
                );
                assert_eq!(
                    admission.permits.available_permits(),
                    FRESH_DELIVERY_RUNNER_LIMIT - FRESH_DELIVERY_PER_RUN_LIMIT + 1
                );
                marker_gate
                    .wait_entered(1, Duration::from_secs(5))
                    .await
                    .unwrap();
                marker_gate.release_one();
                overrides.clear_private_write_file_lifecycle_gate();
            } else {
                assert!(sandbox.write_files_calls().len() <= 1);
            }
            assert!(sandbox.private_write_files_calls().len() <= 1);
            assert!(!task.is_finished());
        }
        if abort {
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
        if cache_state == "warm"
            && let Some(readiness) = &readiness
        {
            let staged_url = format!("file://{}", guest_archive_path("fresh-0", "v1"));
            let index = readiness
                .sources
                .iter()
                .position(|url| *url == staged_url)
                .unwrap();
            let batches = sandbox.private_write_files_calls();
            let [notice] = batches.first().unwrap().files.as_slice() else {
                panic!("the first notice must publish the pre-staged body only");
            };
            assert_eq!(
                Path::new(&notice.path),
                readiness.ready_path(&runtime, index)
            );
        }
        if abort {
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
                assert_eq!(sandbox.storage_manifest_calls().len(), 1);
                assert!(sandbox.private_write_files_calls().is_empty());
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
async fn saturated_cold_failure_cancels_delivery_during_a_cached_write() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let cache = decoded::DecodedCache::new(home.clone());
    let archive = tarball_bytes();
    write_cached_archive(&home, "decoded", "v1", &archive);
    write_storage_lock(&home, "decoded", "v1");
    cache.warm_from_archive("decoded", "v1").await.unwrap();
    write_cached_archive(&home, "warm", "v1", &archive);

    let (reject, release) = oneshot::channel();
    let mut rejecting_peer = RawHttpTestServer::spawn(vec![RawHttpAction::WaitThenRespond {
        release,
        response: http_response("404 Not Found", b""),
    }])
    .await;
    let mut storages = vec![storage_entry_with_archive_size(
        "/mnt/rejected".into(),
        format!("{}/archive", rejecting_peer.url()),
        "rejected",
        "v1",
        Some(archive.len() as u64),
    )];
    let mut cold_peers = Vec::new();
    for index in 1..FRESH_DELIVERY_PER_RUN_LIMIT {
        let peer = GatedResponse::start(archive.clone()).await;
        let name = format!("cold-{index}");
        storages.push(storage_entry_with_archive_size(
            format!("/mnt/{name}"),
            peer.url.clone(),
            &name,
            "v1",
            Some(archive.len() as u64),
        ));
        cold_peers.push(peer);
    }
    for name in ["warm", "decoded"] {
        storages.push(storage_entry(
            format!("/mnt/{name}"),
            format!("https://example.test/{name}"),
            name,
            "v1",
        ));
    }
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
    let mut phase = FreshArchivePhaseGuard::new(
        &delivery.phase_records,
        STORAGE_CACHE_FRESH_DELIVERY_HEADERS,
    );
    phase.started_at -= FRESH_DELIVERY_SLOW_HEADERS;
    phase.finish(Ok(()));
    let cancel = delivery.cancellation_token();

    assert!(
        rejecting_peer
            .next_request("cold archive GET")
            .await
            .starts_with("GET /archive HTTP/1.1\r\n")
    );
    let mut pending_bodies = Vec::new();
    let mut servers = Vec::new();
    for peer in cold_peers {
        tokio::time::timeout(Duration::from_secs(5), peer.requested)
            .await
            .unwrap()
            .unwrap();
        peer.headers.send(()).unwrap();
        pending_bodies.push(peer.body);
        servers.push(peer.task);
    }
    let sandbox = Arc::new(MockSandbox::new("saturated-cold-failure"));
    let gate = MockLifecycleGate::new();
    sandbox.set_write_file_lifecycle_gate(gate.clone());
    let (send, receive) = oneshot::channel();
    let application = GuestApplication::new(
        send,
        temp.path().join("runtime"),
        "saturated-cold-failure".into(),
        Duration::from_secs(300),
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    let task = tokio::spawn({
        let sandbox = Arc::clone(&sandbox);
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

    pending_bodies.remove(0).send(()).unwrap();
    gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
    gate.release_one();
    gate.wait_entered(2, Duration::from_secs(5)).await.unwrap();
    let writes = sandbox.write_files_calls();
    assert_eq!(writes[1].files[0].path, guest_archive_path("warm", "v1"));
    reject.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), cancel.cancelled())
        .await
        .expect("cold failure must cancel delivery before the cached write settles");
    assert!(!task.is_finished());
    gate.release_one();

    let error = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .err()
        .expect("cold failure must fail population");
    assert!(
        error.to_string().contains("http-status (status=404)"),
        "got: {error}"
    );
    assert!(receive.await.is_err());
    assert_eq!(sandbox.write_files_calls().len(), 2);
    assert!(sandbox.storage_manifest_calls().is_empty());
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
    rejecting_peer.assert_finished().await;
    for server in servers {
        server.finish().await;
    }
    admission.shutdown().await;
}

#[tokio::test]
async fn blank_handoff_inlines_warm_archives_and_keeps_the_decoded_tail_ordered() {
    assert_ready_input_lifecycle(true, true).await;
}

#[tokio::test]
async fn complete_ready_inputs_are_handed_off_before_cold_delivery_with_joined_failures() {
    assert_ready_input_lifecycle(false, false).await;
}

#[tokio::test]
async fn split_ready_inputs_preserve_order_and_join_publication_failures() {
    assert_ready_input_lifecycle(true, false).await;
}

async fn assert_ready_input_lifecycle(split: bool, inline: bool) {
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
        if inline && !matches!(failure, "none" | "publication" | "ineligible") {
            continue;
        }
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let cache = decoded::DecodedCache::new(home.clone());
        let bytes = tarball_with_contents(b"complete cold bytes\n");
        let warm = if inline {
            vec![42; 1024 * 1024]
        } else {
            tarball_with_contents(b"complete ready bytes\n")
        };
        write_cached_archive(&home, "ready", "v1", &warm);
        let root = if inline { "/home/user" } else { "/mnt" };
        let server = GatedResponse::start(bytes.clone()).await;
        let mut storages = vec![
            storage_entry_with_archive_size(
                format!("{root}/pending"),
                server.url.clone(),
                "pending",
                "v1",
                Some(bytes.len() as u64),
            ),
            storage_entry(
                format!("{root}/ready"),
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
                    format!("{root}/decoded-{index}"),
                    format!("https://example.test/decoded?{}", "q".repeat(35_000)),
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
                format!("{root}/alias"),
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
        let application = if inline {
            application.with_blank_startup()
        } else {
            application
        };
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
                assert!(input.pending_archives.is_empty());
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
            if failure == "ineligible" {
                let calls = sandbox.write_files_calls();
                assert_eq!(calls.len(), 2);
                assert_eq!(calls[0].files[0].content, warm);
                assert_eq!(calls[1].files[0].content, bytes);
            }
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
        if inline {
            assert!(staged.is_empty());
            let manifest = serde_json::to_vec(&input.initial.manifest).unwrap();
            let encoded = input.pending_archives.inline_input(&manifest).unwrap();
            let (_, payload) = guest_contracts::storage_files::split_input(&encoded).unwrap();
            let sources = guest_contracts::storage_files::inline_archives::decode(payload).unwrap();
            assert_eq!(
                sources,
                HashMap::from([(guest_archive_path("ready", "v1").as_str(), warm.as_slice())])
            );
        } else {
            assert_eq!(staged.len(), 1);
            assert_eq!(staged[0].files[0].content, warm);
        }
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
            assert_eq!(
                sandbox.write_files_calls()[usize::from(!inline)].files[0].content,
                bytes
            );
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
