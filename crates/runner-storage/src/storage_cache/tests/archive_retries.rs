use super::*;

#[derive(Clone)]
struct Reply {
    bytes: Vec<u8>,
    stall: bool,
}

impl Reply {
    fn response(status: &str, body: &[u8]) -> Self {
        Self {
            bytes: http_response(status, body),
            stall: false,
        }
    }

    fn declared(body: &[u8], length: u64) -> Self {
        let mut bytes =
            format!("HTTP/1.1 200 OK\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n")
                .into_bytes();
        bytes.extend_from_slice(body);
        Self {
            bytes,
            stall: false,
        }
    }

    fn retry_after(value: &str) -> Self {
        Self::retry_after_values(&[value])
    }

    fn retry_after_values(values: &[&str]) -> Self {
        let headers: String = values
            .iter()
            .map(|value| format!("Retry-After: {value}\r\n"))
            .collect();
        Self {
            bytes: format!(
                "HTTP/1.1 429 Too Many Requests\r\n{headers}Content-Length: 1\r\nConnection: close\r\n\r\n"
            )
            .into_bytes(),
            stall: true,
        }
    }

    fn stalled(length: u64) -> Self {
        Self {
            stall: true,
            ..Self::declared(b"", length)
        }
    }
}

/// Real HTTP and peer-closure observations synchronize the production timers.
struct RetryServer {
    url: String,
    task: Option<JoinHandle<io::Result<usize>>>,
    requests: Arc<AtomicUsize>,
    response_sent: Arc<Notify>,
    client_closed: Arc<Notify>,
    delays: Arc<Mutex<Vec<Duration>>>,
}

impl RetryServer {
    async fn start(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/archive?secret=synthetic",
            listener.local_addr().unwrap()
        );
        let requests = Arc::new(AtomicUsize::new(0));
        let response_sent = Arc::new(Notify::new());
        let client_closed = Arc::new(Notify::new());
        let delays = Arc::new(Mutex::new(Vec::new()));
        let count = Arc::clone(&requests);
        let sent = Arc::clone(&response_sent);
        let closed = Arc::clone(&client_closed);
        let observed_delays = Arc::clone(&delays);
        let task = tokio::spawn(async move {
            let mut previous_response: Option<Instant> = None;
            for reply in replies {
                let (mut socket, _) = listener.accept().await?;
                let request = read_http_request(&mut socket).await?;
                assert!(request.starts_with("GET /archive?secret=synthetic HTTP/1.1\r\n"));
                assert!(!request.to_ascii_lowercase().contains("\r\nrange:"));
                if let Some(previous) = previous_response {
                    observed_delays.lock().unwrap().push(previous.elapsed());
                }
                previous_response = Some(Instant::now());
                socket.write_all(&reply.bytes).await?;
                count.fetch_add(1, Ordering::SeqCst);
                sent.notify_one();
                if reply.stall {
                    let mut byte = [0];
                    match socket.read(&mut byte).await {
                        Ok(0) => {}
                        Err(error)
                            if matches!(
                                error.kind(),
                                io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted
                            ) => {}
                        Ok(_) => {
                            return Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                "unexpected bytes after complete GET",
                            ));
                        }
                        Err(error) => return Err(error),
                    }
                    closed.notify_one();
                } else {
                    socket.shutdown().await?;
                }
            }
            Ok(count.load(Ordering::SeqCst))
        });
        Self {
            url,
            task: Some(task),
            requests,
            response_sent,
            client_closed,
            delays,
        }
    }

    async fn wait_for_response(&self, expected: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let notified = self.response_sent.notified();
                if self.requests.load(Ordering::SeqCst) >= expected {
                    return;
                }
                notified.await;
            }
        })
        .await
        .expect("the archive server must send the expected response");
    }

    async fn wait_for_client_close(&self) {
        tokio::time::timeout(Duration::from_secs(5), self.client_closed.notified())
            .await
            .expect("the rejected response must be dropped before backoff");
    }

    async fn finish(mut self, expected: usize) {
        let count = join_raw_http_task(self.task.take().unwrap(), "archive retry server")
            .await
            .unwrap();
        assert_eq!(count, expected);
    }

    async fn stop(mut self, expected: usize) {
        let task = self.task.take().unwrap();
        task.abort();
        let _ = task.await;
        assert_eq!(self.requests.load(Ordering::SeqCst), expected);
    }
}

impl Drop for RetryServer {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

async fn assert_staged_archive(
    home: &HomePaths,
    sandbox: &MockSandbox,
    plan: &StoragePlan,
    body: &[u8],
) {
    assert_eq!(
        fs::read(home.storage_cache_dir("retry", "v1").join("archive.tar.gz"))
            .await
            .unwrap(),
        body
    );
    let batches = sandbox.write_files_calls();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].files.len(), 1);
    assert_eq!(batches[0].files[0].path, guest_archive_path("retry", "v1"));
    assert_eq!(batches[0].files[0].content, body);
    let staged = format!("file://{}", guest_archive_path("retry", "v1"));
    assert!(
        storage_archive_url(plan, 0) == Some(staged.as_str())
            || artifact_archive_url(plan, 0) == Some(staged.as_str())
    );
}

fn header_count(telemetry: &JobTelemetry) -> usize {
    telemetry
        .pending_ops_snapshot()
        .iter()
        .filter(|(action, _, _)| action == STORAGE_CACHE_FRESH_DELIVERY_HEADERS)
        .count()
}

#[tokio::test]
async fn archive_retry_recovers_from_transient_http_for_storage_and_artifact() {
    for (status, artifact) in [
        ("429 Too Many Requests", false),
        ("500 Internal Server Error", false),
        ("502 Bad Gateway", false),
        ("503 Service Unavailable", true),
        ("504 Gateway Timeout", false),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let body = tarball_bytes();
        let server = RetryServer::start(vec![
            Reply::response(status, b"bad"),
            Reply::response("200 OK", &body),
        ])
        .await;
        let mut plan = if artifact {
            let mut entry =
                artifact_entry("/mnt/artifact".into(), server.url.clone(), "retry", "v1");
            entry.archive_size = Some(body.len() as u64);
            plan_from_entries(Vec::new(), vec![entry], None)
        } else {
            fresh_storage_plan_with_archive_size(
                server.url.clone(),
                "retry",
                "v1",
                body.len() as u64,
            )
        };
        let sandbox = MockSandbox::new("archive-retry");
        let mut telemetry = new_telemetry();
        assert!(
            populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
                .await
                .unwrap()
                .is_none()
        );
        server.finish(2).await;
        assert_staged_archive(&home, &sandbox, &plan, &body).await;
        assert_eq!(header_count(&telemetry), 2);
        let ops = telemetry.pending_ops_snapshot();
        assert_op_error(&ops, STORAGE_CACHE_FRESH_DELIVERY_HEADERS, "http-status");
        assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_PUBLISHED, true);
        assert_no_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_FAILED);
    }
}

#[tokio::test]
async fn archive_retry_restarts_an_interrupted_body_without_publishing_partial_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let body = tarball_bytes();
    let server = RetryServer::start(vec![
        Reply::declared(&body[..body.len() - 1], body.len() as u64),
        Reply::response("200 OK", &body),
    ])
    .await;
    let mut plan =
        fresh_storage_plan_with_archive_size(server.url.clone(), "retry", "v1", body.len() as u64);
    let sandbox = MockSandbox::new("archive-retry-body");
    let mut telemetry = new_telemetry();
    populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
        .await
        .unwrap();
    server.finish(2).await;
    assert_staged_archive(&home, &sandbox, &plan, &body).await;
    let ops = telemetry.pending_ops_snapshot();
    assert_op_error(&ops, STORAGE_CACHE_FRESH_DELIVERY_BODY, "body");
    assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_BODY, true);
    assert_eq!(header_count(&telemetry), 2);
}

#[tokio::test]
async fn archive_retry_exhaustion_keeps_status_and_never_stages_or_publishes() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let body = tarball_bytes();
    let mut replies = vec![Reply::response("503 Service Unavailable", b"bad"); 3];
    replies.push(Reply::response("200 OK", &body));
    let server = RetryServer::start(replies).await;
    let mut plan =
        fresh_storage_plan_with_archive_size(server.url.clone(), "retry", "v1", body.len() as u64);
    let sandbox = MockSandbox::new("archive-retry-exhausted");
    let mut telemetry = new_telemetry();
    let error = populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
        .await
        .err()
        .unwrap();
    assert!(error.to_string().contains("http-status (status=503)"));
    assert!(!error.to_string().contains("synthetic"));
    assert!(!error.to_string().contains(&server.url));
    server.stop(3).await;
    assert_eq!(header_count(&telemetry), 3);
    assert!(sandbox.write_files_calls().is_empty());
    assert!(!home.storage_cache_dir("retry", "v1").exists());
    assert!(
        storage_archive_url(&plan, 0)
            .unwrap()
            .starts_with("http://")
    );
    assert_no_op(
        &telemetry.pending_ops_snapshot(),
        STORAGE_CACHE_FRESH_DELIVERY_PUBLISHED,
    );
}

#[tokio::test]
async fn archive_retry_phase_records_are_bounded_and_drained_once_for_four_archives() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let body = tarball_bytes();
    let mut servers = Vec::new();
    let mut entries = Vec::new();
    for index in 0..FRESH_DELIVERY_PER_RUN_LIMIT {
        let server = RetryServer::start(vec![
            Reply::declared(&body[..body.len() - 1], body.len() as u64),
            Reply::declared(&body[..body.len() - 1], body.len() as u64),
            Reply::response("200 OK", &body),
        ])
        .await;
        let mut entry = storage_entry(
            format!("/mnt/retry-{index}"),
            server.url.clone(),
            &format!("retry-{index}"),
            "v1",
        );
        entry.archive_size = Some(body.len() as u64);
        entries.push(entry);
        servers.push(server);
    }
    let mut plan = plan_from_entries(entries, Vec::new(), None);
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
    let sandbox = MockSandbox::new("archive-retry-phase-bound");
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
    for server in servers {
        server.finish(3).await;
    }
    for index in 0..FRESH_DELIVERY_PER_RUN_LIMIT {
        assert_eq!(
            fs::read(
                home.storage_cache_dir(&format!("retry-{index}"), "v1")
                    .join("archive.tar.gz")
            )
            .await
            .unwrap(),
            body,
        );
    }
    let batches = sandbox.write_files_calls();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].files.len(), FRESH_DELIVERY_PER_RUN_LIMIT);
    assert!(batches[0].files.iter().all(|file| file.content == body));
    let ops = telemetry.pending_ops_snapshot();
    let phases: Vec<_> = ops
        .iter()
        .filter(|(action, _, _)| {
            matches!(
                action.as_str(),
                STORAGE_CACHE_FRESH_DELIVERY_HEADERS
                    | STORAGE_CACHE_FRESH_DELIVERY_BODY
                    | STORAGE_CACHE_FRESH_DELIVERY_APPLY_WAIT
                    | STORAGE_CACHE_FRESH_DELIVERY_PUBLICATION
            )
        })
        .collect();
    assert_eq!(phases.len(), 32);
    assert_eq!(header_count(&telemetry), 12);
    assert_eq!(phases.iter().filter(|(_, success, _)| !success).count(), 8);
    delivery.cancel_and_drain(&mut telemetry).await;
    delivery.cancel_and_drain(&mut telemetry).await;
    assert_eq!(telemetry.pending_ops_snapshot(), ops);
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
}

#[tokio::test]
async fn archive_retry_rejects_permanent_statuses_without_another_get() {
    for status in [
        "401 Unauthorized",
        "403 Forbidden",
        "404 Not Found",
        "501 Not Implemented",
        "302 Found",
        "206 Partial Content",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let body = tarball_bytes();
        let server = RetryServer::start(vec![
            Reply::response(status, b"bad"),
            Reply::response("200 OK", &body),
        ])
        .await;
        let mut plan = fresh_storage_plan_with_archive_size(
            server.url.clone(),
            "retry",
            "v1",
            body.len() as u64,
        );
        let sandbox = MockSandbox::new("archive-retry-permanent");
        let mut telemetry = new_telemetry();
        let error =
            populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
                .await
                .err()
                .unwrap();
        assert!(
            error
                .to_string()
                .contains(&format!("status={}", &status[..3]))
        );
        server.stop(1).await;
        assert_eq!(header_count(&telemetry), 1);
        assert!(sandbox.write_files_calls().is_empty());
        assert!(!home.storage_cache_dir("retry", "v1").exists());
    }
}

#[tokio::test]
async fn archive_retry_respects_retry_after_before_recovery() {
    for (hint, minimum_delay) in [
        ("1", Duration::from_secs(1)),
        // A comma within one HTTP-date is valid; it is not multiple hints.
        ("Thu, 01 Jan 1970 00:00:00 GMT", OBJECT_DOWNLOAD_RETRY_DELAY),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let body = tarball_bytes();
        let server = RetryServer::start(vec![
            Reply::retry_after(hint),
            Reply::response("200 OK", &body),
        ])
        .await;
        let mut plan = fresh_storage_plan_with_archive_size(
            server.url.clone(),
            "retry",
            "v1",
            body.len() as u64,
        );
        let sandbox = MockSandbox::new("archive-retry-provider-delay");
        let mut telemetry = new_telemetry();
        populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();
        // Observe spacing between actual HTTP requests, not unrelated whole-run time.
        assert!(server.delays.lock().unwrap()[0] >= minimum_delay);
        server.finish(2).await;
        assert_staged_archive(&home, &sandbox, &plan, &body).await;
    }
}

#[tokio::test]
async fn archive_retry_does_not_ignore_invalid_or_over_budget_retry_after() {
    for value in [
        "120",
        "Fri, 01 Jan 2100 00:00:00 GMT",
        "invalid",
        "18446744073709551616",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let body = tarball_bytes();
        let server = RetryServer::start(vec![
            Reply::retry_after(value),
            Reply::response("200 OK", &body),
        ])
        .await;
        let mut plan = fresh_storage_plan_with_archive_size(
            server.url.clone(),
            "retry",
            "v1",
            body.len() as u64,
        );
        let sandbox = MockSandbox::new("archive-retry-provider-rejection");
        let mut telemetry = new_telemetry();
        let error =
            populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
                .await
                .err()
                .unwrap();
        assert!(error.to_string().contains("status=429"));
        server.stop(1).await;
        assert!(sandbox.write_files_calls().is_empty());
        assert!(!home.storage_cache_dir("retry", "v1").exists());
    }
}

#[tokio::test]
async fn archive_retry_rejects_duplicate_retry_after_without_another_get() {
    for values in [["0", "120"], ["0", "invalid"], ["0", "0"], ["invalid", "0"]] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let body = tarball_bytes();
        let server = RetryServer::start(vec![
            Reply::retry_after_values(&values),
            Reply::response("200 OK", &body),
        ])
        .await;
        let mut plan = fresh_storage_plan_with_archive_size(
            server.url.clone(),
            "retry",
            "v1",
            body.len() as u64,
        );
        let sandbox = MockSandbox::new("archive-retry-ambiguous-delay");
        let mut telemetry = new_telemetry();
        let error =
            populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
                .await
                .err()
                .expect(
                    "duplicate Retry-After must be terminal rather than ignoring another value",
                );
        assert!(error.to_string().contains("status=429"));
        server.stop(1).await;
        assert_eq!(header_count(&telemetry), 1);
        assert!(sandbox.write_files_calls().is_empty());
        assert!(!home.storage_cache_dir("retry", "v1").exists());
    }
}

#[tokio::test]
async fn archive_retry_never_retries_size_contract_failures() {
    for (reply, reason) in [
        (Reply::declared(b"", 0), "response-size-zero"),
        (Reply::declared(b"", CACHE_MAX_SIZE + 1), "response-size-oversized"),
        (Reply { bytes: b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nabc\r\n0\r\n\r\n".to_vec(), stall: false }, "body-size-mismatch"),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let server = RetryServer::start(vec![reply, Reply::response("200 OK", b"abcde")]).await;
        let mut plan = fresh_storage_plan_with_archive_size(server.url.clone(), "retry", "v1", 5);
        let sandbox = MockSandbox::new("archive-retry-invalid-body");
        let mut telemetry = new_telemetry();
        let error = populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry).await.err().unwrap();
        assert!(error.to_string().contains(reason));
        server.stop(1).await;
        assert!(sandbox.write_files_calls().is_empty());
        assert!(!home.storage_cache_dir("retry", "v1").exists());
    }
}

#[tokio::test]
async fn archive_retry_cancellation_during_backoff_releases_owner_and_drains_once() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let body = tarball_bytes();
    let server = RetryServer::start(vec![
        Reply::retry_after("60"),
        Reply::response("200 OK", &body),
    ])
    .await;
    let mut plan =
        fresh_storage_plan_with_archive_size(server.url.clone(), "retry", "v1", body.len() as u64);
    let admission = FreshArchiveDeliveryAdmission::new();
    let cancel = CancellationToken::new();
    let mut telemetry = new_telemetry();
    let mut delivery =
        prepare_fresh_archive_delivery(&mut plan, &home, &admission, &cancel, &mut telemetry, None)
            .await
            .unwrap();
    server.wait_for_client_close().await;
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT - 1
    );
    assert!(matches!(
        lock::try_acquire_or_busy(home.storage_lock("retry", "v1"))
            .await
            .unwrap(),
        lock::TryLock::Busy
    ));
    cancel.cancel();
    let sandbox = MockSandbox::new("archive-retry-cancel");
    let result = populate_cache_with_fresh_delivery(
        &mut plan,
        &sandbox,
        &home,
        &mut telemetry,
        Some(&mut delivery),
        None,
    )
    .await;
    assert!(matches!(result, Err(RunnerError::Cancelled)));
    delivery.cancel_and_drain(&mut telemetry).await;
    let recorded = telemetry.pending_ops_snapshot();
    delivery.cancel_and_drain(&mut telemetry).await;
    assert_eq!(telemetry.pending_ops_snapshot(), recorded);
    server.stop(1).await;
    assert_eq!(header_count(&telemetry), 1);
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
    assert!(matches!(
        lock::try_acquire_or_busy(home.storage_lock("retry", "v1"))
            .await
            .unwrap(),
        lock::TryLock::Acquired(_)
    ));
    assert!(sandbox.write_files_calls().is_empty());
    assert!(!home.storage_cache_dir("retry", "v1").exists());
}

#[tokio::test]
async fn archive_retry_does_not_start_an_attempt_after_backoff_expires_the_budget() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let body = tarball_bytes();
    let server = RetryServer::start(vec![
        Reply::retry_after("60"),
        Reply::response("200 OK", &body),
    ])
    .await;
    let mut plan =
        fresh_storage_plan_with_archive_size(server.url.clone(), "retry", "v1", body.len() as u64);
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
    // Peer closure proves the rejected response has reached its backoff timer.
    server.wait_for_client_close().await;
    tokio::time::pause();
    tokio::time::advance(OBJECT_DOWNLOAD_BUDGET + Duration::from_secs(1)).await;
    tokio::time::resume();
    let sandbox = MockSandbox::new("archive-retry-expired-backoff");
    let error = populate_cache_with_fresh_delivery(
        &mut plan,
        &sandbox,
        &home,
        &mut telemetry,
        Some(&mut delivery),
        None,
    )
    .await
    .err()
    .unwrap();
    assert!(error.to_string().contains("timeout"));
    assert_eq!(
        header_count(&telemetry),
        1,
        "an expired budget must not enter another GET attempt"
    );
    server.stop(1).await;
    assert!(sandbox.write_files_calls().is_empty());
    assert!(!home.storage_cache_dir("retry", "v1").exists());
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
}

#[tokio::test]
async fn archive_retry_recovers_after_request_timeout() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let body = tarball_bytes();
    let server = RetryServer::start(vec![
        Reply::stalled(body.len() as u64),
        Reply::response("200 OK", &body),
    ])
    .await;
    let mut plan =
        fresh_storage_plan_with_archive_size(server.url.clone(), "retry", "v1", body.len() as u64);
    let task_home = home_at(&temp);
    let download = tokio::spawn(async move {
        let sandbox = MockSandbox::new("archive-retry-timeout");
        let mut telemetry = new_telemetry();
        let result =
            populate_cache_through_fresh_delivery(&mut plan, &sandbox, &task_home, &mut telemetry)
                .await;
        (result, plan, sandbox, telemetry)
    });
    server.wait_for_response(1).await;
    tokio::time::pause();
    tokio::time::advance(OBJECT_DOWNLOAD_TIMEOUT).await;
    tokio::time::resume();
    let (result, plan, sandbox, telemetry) =
        join_raw_http_task(download, "archive timeout recovery").await;
    result.unwrap();
    server.finish(2).await;
    assert_staged_archive(&home, &sandbox, &plan, &body).await;
    assert_eq!(header_count(&telemetry), 2);
}

#[tokio::test]
async fn archive_retry_overall_deadline_bounds_stalled_requests() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let body = tarball_bytes();
    let server = RetryServer::start(vec![Reply::stalled(body.len() as u64); 3]).await;
    let mut plan =
        fresh_storage_plan_with_archive_size(server.url.clone(), "retry", "v1", body.len() as u64);
    let task_home = home_at(&temp);
    let download = tokio::spawn(async move {
        let sandbox = MockSandbox::new("archive-retry-budget");
        let mut telemetry = new_telemetry();
        let result =
            populate_cache_through_fresh_delivery(&mut plan, &sandbox, &task_home, &mut telemetry)
                .await;
        (result, sandbox, telemetry)
    });
    server.wait_for_response(1).await;
    let observed_start = tokio::time::Instant::now();
    for attempt in 1..=3 {
        if attempt > 1 {
            server.wait_for_response(attempt).await;
        }
        tokio::time::pause();
        let advance = if attempt < 3 {
            OBJECT_DOWNLOAD_TIMEOUT
        } else {
            OBJECT_DOWNLOAD_BUDGET.saturating_sub(observed_start.elapsed())
        };
        tokio::time::advance(advance).await;
        tokio::time::resume();
    }
    let (result, sandbox, telemetry) =
        join_raw_http_task(download, "archive overall deadline").await;
    assert!(result.err().unwrap().to_string().contains("timeout"));
    server.finish(3).await;
    assert_eq!(header_count(&telemetry), 3);
    assert!(sandbox.write_files_calls().is_empty());
    assert!(!home.storage_cache_dir("retry", "v1").exists());
}
