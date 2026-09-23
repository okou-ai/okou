use super::*;

const PHASES: [&str; 4] = [
    STORAGE_CACHE_FRESH_DELIVERY_HEADERS,
    STORAGE_CACHE_FRESH_DELIVERY_BODY,
    STORAGE_CACHE_FRESH_DELIVERY_APPLY_WAIT,
    STORAGE_CACHE_FRESH_DELIVERY_PUBLICATION,
];

fn phase_ops(telemetry: &JobTelemetry) -> Vec<(String, bool, Option<String>)> {
    telemetry
        .pending_ops_snapshot()
        .into_iter()
        .filter(|(action, _, _)| PHASES.contains(&action.as_str()))
        .collect()
}

async fn observe_phase(
    delivery: &FreshArchiveDelivery,
    telemetry: &mut JobTelemetry,
    action: &str,
) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            delivery.phase_records.record_to(telemetry);
            if phase_ops(telemetry)
                .iter()
                .any(|(name, _, _)| name == action)
            {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the released HTTP phase must complete");
}

struct GatedResponse {
    url: String,
    requested: oneshot::Receiver<()>,
    headers: oneshot::Sender<()>,
    body: oneshot::Sender<()>,
    task: ResponseTask,
}

struct ResponseTask(Option<JoinHandle<()>>);

impl ResponseTask {
    async fn finish(mut self) {
        join_raw_http_task(self.0.take().unwrap(), "gated phase response").await;
    }
}

impl Drop for ResponseTask {
    fn drop(&mut self) {
        if let Some(task) = &self.0 {
            task.abort();
        }
    }
}

impl GatedResponse {
    async fn start(bytes: Vec<u8>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/archive?secret=synthetic",
            listener.local_addr().unwrap()
        );
        let (requested_tx, requested) = oneshot::channel();
        let (headers, headers_rx) = oneshot::channel();
        let (body, body_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_http_request(&mut socket).await.unwrap();
            requested_tx.send(()).unwrap();
            let mut eof = [0; 1];
            tokio::select! {
                released = headers_rx => released.unwrap(),
                read = socket.read(&mut eof) => {
                    assert_eq!(read.unwrap(), 0);
                    return;
                }
            }
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        bytes.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            tokio::select! {
                released = body_rx => released.unwrap(),
                read = socket.read(&mut eof) => {
                    assert_eq!(read.unwrap(), 0);
                    return;
                }
            }
            socket.write_all(&bytes).await.unwrap();
        });
        Self {
            url,
            requested,
            headers,
            body,
            task: ResponseTask(Some(task)),
        }
    }
}

#[tokio::test]
async fn phase_records_follow_http_and_apply_boundaries_once() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let body = tarball_bytes();
    let server = GatedResponse::start(body.clone()).await;
    let mut plan =
        fresh_storage_plan_with_archive_size(server.url, "phase-success", "v1", body.len() as u64);
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
    delivery.phase_records.record_to(&mut telemetry);
    assert!(phase_ops(&telemetry).is_empty());

    server.headers.send(()).unwrap();
    observe_phase(&delivery, &mut telemetry, PHASES[0]).await;
    assert_eq!(phase_ops(&telemetry), vec![(PHASES[0].into(), true, None)]);
    server.body.send(()).unwrap();
    observe_phase(&delivery, &mut telemetry, PHASES[1]).await;
    assert_eq!(phase_ops(&telemetry).len(), 2);
    assert!(!home.storage_cache_dir("phase-success", "v1").exists());

    let sandbox = MockSandbox::new("phase-success");
    populate_cache_with_fresh_delivery(
        &mut plan,
        &sandbox,
        &home,
        &mut telemetry,
        Some(&mut delivery),
        None,
    )
    .await
    .unwrap();
    server.task.finish().await;
    assert_eq!(
        phase_ops(&telemetry),
        PHASES.map(|name| (name.into(), true, None))
    );
    let recorded = phase_ops(&telemetry);
    delivery.cancel_and_drain(&mut telemetry).await;
    delivery.cancel_and_drain(&mut telemetry).await;
    assert_eq!(phase_ops(&telemetry), recorded);
    assert_eq!(
        fs::read(
            home.storage_cache_dir("phase-success", "v1")
                .join("archive.tar.gz")
        )
        .await
        .unwrap(),
        body
    );
    assert_eq!(sandbox.write_files_calls().len(), 1);
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
}

#[tokio::test]
async fn delayed_collection_preserves_the_measured_header_phase() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let body = tarball_bytes();
    let server = GatedResponse::start(body.clone()).await;
    let api = MockServer::start_async().await;
    let mut telemetry = new_telemetry_for_api_url(&api.base_url());
    let mut plan =
        fresh_storage_plan_with_archive_size(server.url, "phase-timing", "v1", body.len() as u64);
    let admission = FreshArchiveDeliveryAdmission::new();
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

    // This observable interval is entirely inside the request's header phase.
    // Set up the telemetry receiver while headers are held instead of relying
    // on a sleep or a machine-dependent minimum duration.
    let held_since = Instant::now();
    let payloads = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let sink = Arc::clone(&payloads);
    let ingest = api
        .mock_async(move |when, then| {
            when.method(httpmock::Method::POST)
                .path("/api/webhooks/agent/telemetry");
            then.respond_with(move |request: &httpmock::HttpMockRequest| {
                let payload = serde_json::from_slice(request.body_ref()).unwrap();
                sink.lock().unwrap().push(payload);
                httpmock::HttpMockResponse::builder()
                    .status(200)
                    .body(r#"{"success":true,"id":"ok"}"#)
                    .build()
            });
        })
        .await;
    let held_duration = held_since.elapsed();
    let before_headers = Utc::now();
    server.headers.send(()).unwrap();
    let (operation, completed_at) = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let header = delivery
                .phase_records
                .records
                .lock()
                .unwrap()
                .iter()
                .find(|record| record.operation.action_type == PHASES[0])
                .map(|record| (record.operation, record.completed_at));
            if let Some(header) = header {
                return header;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("headers must finish while the response body remains held");
    assert!(operation.duration >= held_duration);
    assert!(completed_at >= before_headers && completed_at <= Utc::now());
    assert!(phase_ops(&telemetry).is_empty());

    // Leave the observed record buffered until normal resolution. The emitted
    // operation must retain this phase boundary rather than collection time.
    server.body.send(()).unwrap();
    let sandbox = MockSandbox::new("phase-timing");
    populate_cache_with_fresh_delivery(
        &mut plan,
        &sandbox,
        &home,
        &mut telemetry,
        Some(&mut delivery),
        None,
    )
    .await
    .unwrap();
    server.task.finish().await;
    delivery.cancel_and_drain(&mut telemetry).await;
    tokio::time::timeout(Duration::from_secs(5), telemetry.flush())
        .await
        .expect("the local telemetry receiver must acknowledge the batch");
    ingest.assert_calls_async(1).await;

    let payloads = payloads.lock().unwrap();
    let header_ops = payloads
        .iter()
        .flat_map(|payload| payload["sandboxOperations"].as_array().unwrap())
        .filter(|record| record["action_type"] == PHASES[0])
        .collect::<Vec<_>>();
    assert_eq!(header_ops.len(), 1);
    let header = header_ops[0];
    assert_eq!(
        header["duration_ms"],
        u64::try_from(operation.duration.as_millis()).unwrap()
    );
    assert_eq!(
        header["ts"],
        completed_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    );
    assert_eq!(header["success"], true);
    assert!(header.get("error").is_none());
    assert!(payloads.iter().all(|payload| {
        payload["sandboxOperations"]
            .as_array()
            .unwrap()
            .iter()
            .all(|operation| operation.get("archive_size_mismatch").is_none())
    }));
}

async fn mismatch_telemetry_receiver() -> (JobTelemetry, RawHttpTestServer) {
    let receiver = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
        "200 OK",
        r#"{"success":true}"#,
    ))])
    .await;
    (new_telemetry_for_api_url(&receiver.url()), receiver)
}

async fn flush_telemetry_payload(
    telemetry: JobTelemetry,
    receiver: RawHttpTestServer,
) -> serde_json::Value {
    tokio::time::timeout(Duration::from_secs(5), telemetry.flush())
        .await
        .expect("telemetry should flush to the local receiver");
    let requests = receiver.assert_finished_with_requests().await;
    assert_eq!(requests.len(), 1);
    let (_, body) = requests[0].split_once("\r\n\r\n").unwrap();
    serde_json::from_str(body).unwrap()
}

fn mismatch_header(payload: &serde_json::Value) -> &serde_json::Value {
    let operations = payload["sandboxOperations"].as_array().unwrap();
    let diagnostics = operations
        .iter()
        .filter(|operation| operation.get("archive_size_mismatch").is_some())
        .collect::<Vec<_>>();
    assert_eq!(diagnostics.len(), 1);
    let header = diagnostics[0];
    assert_eq!(header["action_type"], PHASES[0]);
    assert_eq!(header["success"], false);
    assert_eq!(header["error"], "response-size-mismatch");
    assert!(operations.iter().all(|operation| {
        !PHASES[1..]
            .iter()
            .any(|phase| operation["action_type"] == *phase)
    }));
    header
}

#[tokio::test]
async fn rejected_header_payload_preserves_exact_lengths_and_bounded_encodings() {
    for (length, encoding_headers, expected_encoding) in [
        (0, b"".as_slice(), "absent"),
        (
            3,
            b"Content-Encoding: \tIdEnTiTy \t\r\n".as_slice(),
            "identity",
        ),
        (7, b"Content-Encoding: GzIp\r\n".as_slice(), "gzip"),
        (
            // Hyper reserves the two largest u64 values for body framing.
            u64::MAX - 2,
            b"Content-Encoding: private-encoding-secret\r\n".as_slice(),
            "other",
        ),
        (
            7,
            b"Content-Encoding: gzip\r\nContent-Encoding: identity\r\n".as_slice(),
            "other",
        ),
        (7, b"Content-Encoding: gzip, br\r\n".as_slice(), "other"),
        (7, b"Content-Encoding: \xff\r\n".as_slice(), "other"),
        (7, b"Content-Encoding: \t\r\n".as_slice(), "other"),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let mut response = format!("HTTP/1.1 200 OK\r\nContent-Length: {length}\r\n").into_bytes();
        response.extend_from_slice(encoding_headers);
        response.extend_from_slice(b"Connection: close\r\n\r\n");
        // No response body is supplied, even when a nonzero length is declared.
        let (origin, server) = raw_http_url(response).await;
        let url = format!("{origin}/private-object-secret?signature=private-query-secret");
        let mut plan = fresh_storage_plan_with_archive_size(
            url.clone(),
            "private-storage-secret",
            "private-version-secret",
            5,
        );
        let (mut telemetry, receiver) = mismatch_telemetry_receiver().await;
        let sandbox = MockSandbox::new("header-mismatch");
        let error =
            populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
                .await
                .err()
                .expect("the mismatched response must fail storage delivery");
        assert!(error.to_string().contains("response-size-mismatch"));
        let requests = server.assert_finished_with_requests().await;
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("GET "));
        assert_eq!(storage_archive_url(&plan, 0), Some(url.as_str()));
        assert!(sandbox.write_files_calls().is_empty());
        assert!(
            !home
                .storage_cache_dir("private-storage-secret", "private-version-secret")
                .exists()
        );
        let operations = telemetry.pending_ops_snapshot();
        assert_op_count(&operations, STORAGE_CACHE_FRESH_DELIVERY_SINGLE_REQUEST, 1);
        assert_no_op(&operations, STORAGE_CACHE_FRESH_DELIVERY_PUBLISHED);
        let payload = flush_telemetry_payload(telemetry, receiver).await;
        assert_eq!(
            mismatch_header(&payload)["archive_size_mismatch"],
            serde_json::json!({
                "expected_bytes": "5",
                "response_bytes": length.to_string(),
                "source_kind": "storage",
                "source_index": 0,
                "content_encoding": expected_encoding,
            }),
        );
        let serialized = payload.to_string();
        for private in [
            "private-object-secret",
            "private-query-secret",
            "private-storage-secret",
            "private-version-secret",
            "private-encoding-secret",
        ] {
            assert!(!serialized.contains(private));
        }
    }
}

#[tokio::test]
async fn grouped_mismatch_reports_the_first_normalized_source_not_admission_order() {
    for source_kind in ["storage", "artifact"] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let (url, server) = raw_http_url(http_response("200 OK", b"abc")).await;
        let mut previous = StorageFingerprints::default();
        let mut storages = Vec::new();
        let mut artifacts = Vec::new();
        for index in 0..5 {
            let name = format!("unchanged-{index}");
            let mount = format!("/mnt/{name}");
            if source_kind == "storage" {
                previous
                    .storages
                    .insert(mount.clone(), StorageFingerprint::new(&name, "v1"));
                storages.push(storage_entry(mount, url.clone(), &name, "v1"));
            } else {
                let mut entry = artifact_entry(mount, url.clone(), &name, "v1");
                entry.empty = Some(true);
                entry.archive_url = None;
                artifacts.push(entry);
            }
        }
        // The representative has no size. Another member supplies the group's
        // reconciled expected size, and only the representative URL is fetched.
        if source_kind == "storage" {
            storages.push(storage_entry(
                "/mnt/representative".into(),
                url.clone(),
                "shared",
                "v1",
            ));
            let mut duplicate = artifact_entry(
                "/mnt/duplicate".into(),
                "http://localhost:0/never".into(),
                "shared",
                "v1",
            );
            duplicate.archive_size = Some(5);
            artifacts.push(duplicate);
        } else {
            artifacts.push(artifact_entry(
                "/mnt/representative".into(),
                url.clone(),
                "shared",
                "v1",
            ));
            let mut duplicate = artifact_entry(
                "/mnt/duplicate".into(),
                "http://localhost:0/never".into(),
                "shared",
                "v1",
            );
            duplicate.archive_size = Some(5);
            artifacts.push(duplicate);
        }
        let mut plan = plan_from_entries(storages, artifacts, Some(&previous));
        let (mut telemetry, receiver) = mismatch_telemetry_receiver().await;
        let sandbox = MockSandbox::new("grouped-header-mismatch");
        let error =
            populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
                .await
                .err()
                .expect("the grouped mismatched response must fail storage delivery");
        assert!(error.to_string().contains("response-size-mismatch"));
        assert_eq!(server.assert_finished_with_requests().await.len(), 1);
        assert!(sandbox.write_files_calls().is_empty());
        assert!(!home.storage_cache_dir("shared", "v1").exists());
        let payload = flush_telemetry_payload(telemetry, receiver).await;
        assert_eq!(
            mismatch_header(&payload)["archive_size_mismatch"],
            serde_json::json!({
                "expected_bytes": "5", "response_bytes": "3",
                "source_kind": source_kind, "source_index": 5, "content_encoding": "absent",
            }),
        );
    }
}

#[tokio::test]
async fn completed_mismatch_survives_cancellation_and_repeated_drain() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let (url, server) = raw_http_url(http_response("200 OK", b"abc")).await;
    let mut plan = fresh_storage_plan_with_archive_size(url, "cancel-mismatch", "v1", 5);
    let (mut telemetry, receiver) = mismatch_telemetry_receiver().await;
    let admission = FreshArchiveDeliveryAdmission::new();
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
    let (duration, completed_at) = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let recorded = delivery
                .phase_records
                .records
                .lock()
                .unwrap()
                .iter()
                .find(|record| record.operation.action_type == PHASES[0])
                .map(|record| (record.operation.duration, record.completed_at));
            if let Some(recorded) = recorded {
                return recorded;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the mismatch must complete before cancelling the delivery");
    delivery.cancel_and_drain(&mut telemetry).await;
    delivery.cancel_and_drain(&mut telemetry).await;
    assert_eq!(server.assert_finished_with_requests().await.len(), 1);
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
    assert!(!home.storage_cache_dir("cancel-mismatch", "v1").exists());
    assert!(matches!(
        lock::try_acquire_or_busy(home.storage_lock("cancel-mismatch", "v1"))
            .await
            .unwrap(),
        lock::TryLock::Acquired(_),
    ));
    let payload = flush_telemetry_payload(telemetry, receiver).await;
    let header = mismatch_header(&payload);
    assert_eq!(
        header["duration_ms"],
        u64::try_from(duration.as_millis()).unwrap()
    );
    assert_eq!(
        header["ts"],
        completed_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    );
    assert_eq!(header["archive_size_mismatch"]["response_bytes"], "3");
    assert_eq!(
        payload["sandboxOperations"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|operation| operation["action_type"] == PHASES[0])
            .count(),
        1
    );
}

#[tokio::test]
async fn cancellation_preserves_completed_phases_and_marks_only_active_phase() {
    for completed in 0..=2 {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let body = tarball_bytes();
        let server = GatedResponse::start(body.clone()).await;
        let mut plan = fresh_storage_plan_with_archive_size(
            server.url,
            "phase-cancel",
            "v1",
            body.len() as u64,
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
        if completed >= 1 {
            server.headers.send(()).unwrap();
            observe_phase(&delivery, &mut telemetry, PHASES[0]).await;
        }
        if completed >= 2 {
            server.body.send(()).unwrap();
            observe_phase(&delivery, &mut telemetry, PHASES[1]).await;
        }
        delivery.cancel_and_drain(&mut telemetry).await;
        server.task.finish().await;
        let ops = phase_ops(&telemetry);
        assert_eq!(ops.len(), completed + 1);
        for (index, op) in ops.iter().enumerate() {
            assert_eq!(op.0, PHASES[index]);
            assert_eq!(op.1, index < completed);
            if index < completed {
                assert!(op.2.is_none());
            } else {
                assert!(matches!(op.2.as_deref(), Some("interrupted" | "cancelled")));
            }
        }
        delivery.cancel_and_drain(&mut telemetry).await;
        assert_eq!(phase_ops(&telemetry), ops);
        assert!(!home.storage_cache_dir("phase-cancel", "v1").exists());
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT
        );
        assert!(matches!(
            lock::try_acquire_or_busy(home.storage_lock("phase-cancel", "v1"))
                .await
                .unwrap(),
            lock::TryLock::Acquired(_)
        ));
    }
}

#[tokio::test]
async fn rejected_headers_and_body_report_the_failed_phase_without_later_phases() {
    for (response, expected_phase, reason) in [
        (http_response("503 Service Unavailable", b"bad"), 0, "http-status"),
        // Hyper rejects this declared length before exposing response headers.
        // It must keep the original HTTP error rather than fabricate a mismatch.
        (format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", u64::MAX).into_bytes(), 0, "http"),
        (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nabc\r\n0\r\n\r\n".to_vec(), 1, "body-size-mismatch"),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let (url, server) = raw_http_url(response).await;
        let mut plan = fresh_storage_plan_with_archive_size(url, "phase-error", "v1", 5);
        let (mut telemetry, receiver) = mismatch_telemetry_receiver().await;
        let sandbox = MockSandbox::new("phase-error");
        assert!(populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry).await.is_err());
        server.assert_finished().await;
        let ops = phase_ops(&telemetry);
        assert_eq!(ops.len(), expected_phase + 1);
        assert_eq!(ops[expected_phase], (PHASES[expected_phase].into(), false, Some(reason.into())));
        assert!(ops[..expected_phase].iter().all(|(_, success, error)| *success && error.is_none()));
        assert!(sandbox.write_files_calls().is_empty());
        let payload = flush_telemetry_payload(telemetry, receiver).await;
        assert!(payload["sandboxOperations"].as_array().unwrap().iter()
            .all(|operation| operation.get("archive_size_mismatch").is_none()));
    }
}

#[tokio::test]
async fn publication_failure_is_timed_and_does_not_stage_the_archive() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let body = tarball_bytes();
    let (url, server) = raw_http_url(http_response("200 OK", &body)).await;
    let mut plan =
        fresh_storage_plan_with_archive_size(url, "phase-publish", "v1", body.len() as u64);
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
    observe_phase(&delivery, &mut telemetry, PHASES[1]).await;
    let cache_dir = home.storage_cache_dir("phase-publish", "v1");
    fs::create_dir_all(cache_dir.parent().unwrap())
        .await
        .unwrap();
    fs::write(&cache_dir, b"not-a-cache-directory")
        .await
        .unwrap();
    let sandbox = MockSandbox::new("phase-publish");
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
        .is_err()
    );
    server.assert_finished().await;
    let ops = phase_ops(&telemetry);
    assert_eq!(ops.len(), 4);
    assert_eq!(
        ops[3],
        (PHASES[3].into(), false, Some("publication".into()))
    );
    assert!(sandbox.write_files_calls().is_empty());
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
}

#[tokio::test]
async fn full_admission_has_sixteen_phase_records_and_warm_delivery_has_none() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let body = tarball_bytes();
    let server = MockServer::start_async().await;
    let get = server
        .mock_async(|when, then| {
            when.method(GET).path("/archive");
            then.status(200).body(body.clone());
        })
        .await;
    let entries = (0..FRESH_DELIVERY_PER_RUN_LIMIT)
        .map(|index| {
            let mut entry = storage_entry(
                format!("/mnt/phase-{index}"),
                server.url("/archive"),
                &format!("phase-{index}"),
                "v1",
            );
            entry.archive_size = Some(body.len() as u64);
            entry
        })
        .collect::<Vec<_>>();
    for cold in [true, false] {
        let mut plan = plan_from_entries(entries.clone(), Vec::new(), None);
        let mut telemetry = new_telemetry();
        let sandbox = MockSandbox::new("phase-capacity");
        populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();
        let ops = phase_ops(&telemetry);
        if cold {
            assert_eq!(ops.len(), 16);
            for phase in PHASES {
                assert_eq!(
                    ops.iter()
                        .filter(|(name, success, error)| name == phase
                            && *success
                            && error.is_none())
                        .count(),
                    4
                );
            }
        } else {
            assert!(ops.is_empty());
        }
        assert_eq!(
            sandbox
                .write_files_calls()
                .iter()
                .map(|call| call.files.len())
                .sum::<usize>(),
            4
        );
    }
    get.assert_calls_async(4).await;
}
