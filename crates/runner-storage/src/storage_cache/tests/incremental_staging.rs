use super::phase_diagnostics::GatedResponse;
use super::*;
use std::sync::atomic::AtomicBool;

#[tokio::test]
async fn mixed_preparation_preserves_fresh_warming_when_the_background_queue_is_full() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let cache = decoded::DecodedCache::new(home.clone());
    let body = tarball_bytes();
    write_cached_archive(&home, "warm", "v1", &body);
    write_storage_lock(&home, "warm", "v1");
    let server = MockServer::start_async().await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET).path("/cold");
            then.status(200).body(body.clone());
        })
        .await;
    let mut plan = plan_from_entries(
        ["cold", "warm"]
            .into_iter()
            .map(|name| {
                storage_entry_with_archive_size(
                    format!("/mnt/{name}"),
                    server.url(format!("/{name}")),
                    name,
                    "v1",
                    Some(body.len() as u64),
                )
            })
            .collect(),
        Vec::new(),
        None,
    );
    let mut telemetry = new_telemetry();
    let mut delivery = prepare_fresh_archive_delivery(
        &mut plan,
        &home,
        &FreshArchiveDeliveryAdmission::new(),
        &CancellationToken::new(),
        &mut telemetry,
        Some(&cache),
    )
    .await
    .unwrap();
    let deferred = populate_cache_with_fresh_delivery(
        &mut plan,
        &MockSandbox::new("mixed-warming-admission"),
        &home,
        &mut telemetry,
        Some(&mut delivery),
        Some(&cache),
    )
    .await
    .unwrap()
    .unwrap();
    // One synchronous classification completion admits these two eligible
    // warmings to one queue slot, before the worker can consume that slot.
    let coordinator = StorageCacheBackgroundFillCoordinator::new_with_limits(1, 1).unwrap();
    deferred.start(&coordinator, &mut telemetry);
    coordinator.wait_idle_for_test().await;
    assert!(cache.get_ready("cold", "v1").await.unwrap().is_some());
    assert!(cache.get_ready("warm", "v1").await.unwrap().is_none());
    get.assert_calls_async(1).await;
    coordinator.shutdown().await;
    cache.shutdown().await;
}

#[tokio::test]
async fn mixed_cold_batches_progress_while_all_miss_inputs_retain_batching() {
    for warm in [false, true] {
        assert_incremental_staging(warm, "none").await;
    }
    assert_incremental_staging(true, "ineligible").await;
}

#[tokio::test]
async fn incremental_staging_failures_keep_the_producer_and_accepted_writes_owned() {
    for failure in [
        "publication",
        "ready-marker",
        "staging",
        "cancel",
        "cancel-staging",
    ] {
        assert_incremental_staging(true, failure).await;
    }
}

async fn assert_incremental_staging(warm: bool, failure: &str) {
    let incremental = warm && failure != "ineligible";
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let cache = decoded::DecodedCache::new(home.clone());
    let body = tarball_with_contents(b"verified cold contents\n");
    let first = GatedResponse::start(body.clone()).await;
    let last = GatedResponse::start(body.clone()).await;
    let mut storages = vec![
        storage_entry_with_archive_size(
            "/mnt/first".into(),
            first.url.clone(),
            "first",
            "v1",
            Some(body.len() as u64),
        ),
        storage_entry_with_archive_size(
            "/mnt/last".into(),
            last.url.clone(),
            "last",
            "v1",
            Some(body.len() as u64),
        ),
    ];
    if warm {
        write_cached_archive(&home, "warm", "v1", &body);
        storages.push(storage_entry(
            "/mnt/warm".into(),
            "https://example.test/warm".into(),
            "warm",
            "v1",
        ));
    }
    let mut plan = plan_from_entries(
        storages,
        vec![artifact_entry(
            "/mnt/alias".into(),
            first.url.clone(),
            "first",
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
    tokio::time::timeout(Duration::from_secs(5), first.requested)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), last.requested)
        .await
        .unwrap()
        .unwrap();
    first.headers.send(()).unwrap();
    last.headers.send(()).unwrap();
    let cancel = delivery.cancellation_token();
    let sandbox = Arc::new(MockSandbox::new("incremental-staging"));
    if failure == "ineligible" {
        sandbox.push_exec_result(Ok(sandbox::ExecResult::new(
            0,
            b"false\n".to_vec(),
            Vec::new(),
        )));
    }
    let gate = MockLifecycleGate::new();
    sandbox.set_write_file_lifecycle_gate(gate.clone());
    let failed = Arc::new(AtomicBool::new(false));
    let (send, mut receive) = oneshot::channel();
    let runtime = temp.path().join("runtime");
    let application = GuestApplication::new(
        send,
        runtime.clone(),
        "incremental".into(),
        Duration::from_secs(300),
        failed.clone(),
    )
    .unwrap();
    let task = tokio::spawn({
        let home = home.clone();
        let sandbox = sandbox.clone();
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
            (result, prepared.plan)
        }
    });
    let readiness = if warm {
        gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
        gate.release_one();
        if incremental {
            let input = tokio::time::timeout(Duration::from_secs(5), &mut receive)
                .await
                .unwrap()
                .unwrap();
            let readiness = input.initial.manifest.archive_readiness.unwrap();
            assert_eq!(readiness.sources.len(), 2, "aliases share one source");
            Some(readiness)
        } else {
            None
        }
    } else {
        None
    };
    if failure == "staging" {
        sandbox.push_write_file_result(Err(sandbox_write_file_error("incremental stage failed")));
    }
    if failure == "ready-marker" {
        sandbox.push_private_write_files_result(Err(sandbox_write_file_error(
            "incremental ready failed",
        )));
    }
    first.body.send(()).unwrap();
    if !incremental {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !home
                .storage_cache_dir("first", "v1")
                .join("archive.tar.gz")
                .exists()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(sandbox.write_files_calls().len(), usize::from(warm));
        assert_eq!(sandbox.storage_manifest_calls().len(), usize::from(warm));
        assert!(matches!(
            receive.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        last.body.send(()).unwrap();
        let stage_call = if warm { 2 } else { 1 };
        gate.wait_entered(stage_call, Duration::from_secs(5))
            .await
            .unwrap();
        let staged = sandbox.write_files_calls();
        assert_eq!(staged.len(), usize::from(warm) + 1);
        let cold = staged.last().unwrap();
        assert_eq!(cold.files.len(), 2);
        assert!(cold.files.iter().all(|file| file.content == body));
        gate.release_one();
        let input = tokio::time::timeout(Duration::from_secs(5), receive)
            .await
            .unwrap()
            .unwrap();
        assert!(input.initial.manifest.archive_readiness.is_none());
        let (result, plan) = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        drop(result.unwrap());
        assert!(!failed.load(Ordering::Acquire));
        assert_eq!(
            storage_archive_url(&plan, 0),
            artifact_archive_url(&plan, 0)
        );
        assert!(sandbox.private_write_files_calls().is_empty());
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT
        );
        first.task.finish().await;
        last.task.finish().await;
        admission.shutdown().await;
        return;
    }
    let first_call = 2;
    gate.wait_entered(first_call, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(sandbox.write_files_calls()[1].files[0].content, body);
    assert!(!home.storage_cache_dir("last", "v1").exists());
    assert!(!task.is_finished());
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT - 2
    );
    if failure == "cancel-staging" {
        cancel.cancel();
        assert!(!task.is_finished(), "accepted write remains awaited");
    }
    gate.release_one();
    if !matches!(failure, "staging" | "cancel-staging") {
        tokio::time::timeout(Duration::from_secs(5), async {
            while sandbox.private_write_files_calls().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let readiness = readiness.as_ref().unwrap();
        let index = readiness
            .sources
            .iter()
            .position(|url| url == &format!("file://{}", guest_archive_path("first", "v1")))
            .unwrap();
        let published = sandbox.private_write_files_calls();
        assert_eq!(published.len(), 1);
        assert_eq!(published[0].files.len(), 1);
        assert_eq!(
            published[0].files[0].path,
            readiness.ready_path(&runtime, index).to_str().unwrap()
        );
    }
    if failure == "none" {
        last.body.send(()).unwrap();
        gate.wait_entered(first_call + 1, Duration::from_secs(5))
            .await
            .unwrap();
        gate.release_one();
    } else if failure == "publication" {
        let path = home.storage_cache_dir("last", "v1");
        fs::create_dir_all(&path).await.unwrap();
        fs::write(path.join("retained"), b"publication conflict")
            .await
            .unwrap();
        last.body.send(()).unwrap();
    } else if failure == "cancel" {
        cancel.cancel();
    }
    let (result, plan) = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    if failure == "none" {
        drop(result.unwrap());
        assert!(!failed.load(Ordering::Acquire));
        assert_eq!(
            storage_archive_url(&plan, 0),
            artifact_archive_url(&plan, 0)
        );
        let published = sandbox.private_write_files_calls();
        assert_eq!(published.len(), 2);
        let paths = published
            .iter()
            .flat_map(|call| call.files.iter().map(|file| &file.path))
            .collect::<HashSet<_>>();
        assert_eq!(paths.len(), 2, "final success does not republish markers");
    } else {
        let error = result.err().expect("incremental failure is fatal");
        if failure == "ready-marker" {
            assert!(error.to_string().contains("incremental ready failed"));
        }
        if failure == "staging" {
            assert!(error.to_string().contains("incremental stage failed"));
        }
        if failure == "publication" {
            assert!(error.to_string().contains("rename"));
        }
        assert!(failed.load(Ordering::Acquire));
        assert_eq!(sandbox.private_write_file_calls().len(), 1);
    }
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
    for name in ["first", "last"] {
        assert!(matches!(
            lock::try_acquire_or_busy(home.storage_lock(name, "v1"))
                .await
                .unwrap(),
            lock::TryLock::Acquired(_)
        ));
        assert!(!staging_dir(&home.storage_cache_dir(name, "v1")).exists());
    }
    first.task.finish().await;
    last.task.finish().await;
    admission.shutdown().await;
}
