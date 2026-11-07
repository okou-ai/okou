use super::phase_diagnostics::GatedResponse;
use super::*;
use std::sync::atomic::AtomicBool;

#[tokio::test]
async fn complete_ready_inputs_are_handed_off_before_cold_delivery_with_joined_failures() {
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
    ] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let cache = decoded::DecodedCache::new(home.clone());
        let bytes = tarball_with_contents(b"complete cold bytes\n");
        let warm = tarball_with_contents(b"complete ready bytes\n");
        write_cached_archive(&home, "ready", "v1", &warm);
        let server = GatedResponse::start(bytes.clone()).await;
        let mut plan = plan_from_entries(
            vec![
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
            ],
            vec![artifact_entry(
                "/mnt/alias".into(),
                server.url.clone(),
                "pending",
                "v1",
            )],
            None,
        );
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
                assert!(input.manifest.archive_readiness.is_none());
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
        let readiness = input
            .manifest
            .archive_readiness
            .as_ref()
            .expect("real pending source");
        readiness.validate(&input.manifest).unwrap();
        assert_eq!(
            readiness.sources.len(),
            1,
            "one source serves aliased targets"
        );
        assert_eq!(
            input.manifest.storages[0].archive_url,
            input.manifest.artifacts[0].archive_url
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
