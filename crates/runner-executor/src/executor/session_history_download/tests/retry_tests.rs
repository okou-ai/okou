use super::*;

#[tokio::test]
async fn materializer_retries_interrupted_zstd_body_without_reusing_partial_bytes() {
    let body = b"{\"type\":\"init\"}\n{\"type\":\"user\",\"message\":\"hello\"}\n";
    let compressed = zstd_bytes(body);
    let encoded_size = compressed.len() as u64;
    let hash = hex::encode(Sha256::digest(body));
    let server = MultiShotSessionHistoryServer::respond_many(vec![
        MultiShotSessionHistoryResponse::ok(
            compressed[..compressed.len() - 1].to_vec(),
            Some(encoded_size),
        ),
        MultiShotSessionHistoryResponse::ok(compressed, Some(encoded_size)),
    ])
    .await;
    let session = zstd_ref_session(server.url(), hash, body.len() as u64, encoded_size);

    match start_materializer(&session)
        .finish(&CancellationToken::new())
        .await
    {
        SessionHistoryMaterialization::Downloaded {
            session, timings, ..
        } => {
            assert_eq!(session.history_bytes(), body);
            assert_phase_failure(timings.body_read());
            assert_phase_success(timings.decompression());
            assert_phase_success(timings.hash_verification());
        }
        _ => panic!("expected verified history after retry"),
    }
    server.assert_served(2).await;
}

#[tokio::test]
async fn materializer_recovers_from_temporary_http_failures() {
    for status in [
        "429 Too Many Requests",
        "500 Internal Server Error",
        "502 Bad Gateway",
        "503 Service Unavailable",
        "504 Gateway Timeout",
    ] {
        let body = b"{\"type\":\"init\"}\n";
        let hash = hex::encode(Sha256::digest(body));
        let server = MultiShotSessionHistoryServer::respond_many(vec![
            MultiShotSessionHistoryResponse::status(status).with_retry_after("0"),
            MultiShotSessionHistoryResponse::ok(body, Some(body.len() as u64)),
        ])
        .await;
        let session = ref_session(server.url(), hash, body.len() as u64, body.len() as u64);

        match start_materializer(&session)
            .finish(&CancellationToken::new())
            .await
        {
            SessionHistoryMaterialization::Downloaded {
                session, timings, ..
            } => {
                assert_eq!(session.history_bytes(), body);
                assert_phase_failure(timings.request_status());
                assert_phase_success(timings.hash_verification());
            }
            _ => panic!("expected verified history after {status}"),
        }
        server.assert_served(2).await;
    }
}

#[tokio::test]
async fn materializer_respects_provider_delay_then_recovers() {
    let body = b"{\"type\":\"init\"}\n";
    let hash = hex::encode(Sha256::digest(body));
    let server = MultiShotSessionHistoryServer::respond_many(vec![
        MultiShotSessionHistoryResponse::new("429 Too Many Requests", Vec::new(), Some(1))
            .with_retry_after("1")
            .stalled(),
        MultiShotSessionHistoryResponse::ok(body, Some(body.len() as u64)),
    ])
    .await;
    let session = ref_session(server.url(), hash, body.len() as u64, body.len() as u64);
    let materializer = start_materializer(&session);
    let download =
        tokio::spawn(async move { materializer.finish(&CancellationToken::new()).await });
    // Dropping the incomplete error body closes the connection only after the
    // caller rejects 429. Its retry timer is then armed in the same poll.
    server.wait_for_client_close().await;

    match finish_download(download).await {
        SessionHistoryMaterialization::Downloaded { session, .. } => {
            assert_eq!(session.history_bytes(), body);
        }
        _ => panic!("expected recovery after the provider's delay"),
    }
    // This is the provider-observed request spacing, not whole-run wall time.
    // Kernel IO is observed under a real bounded deadline, not a paused clock.
    assert!(server.observed_retry_delay() >= Duration::from_secs(1));
    server.assert_served(2).await;
}

#[tokio::test]
async fn materializer_stops_after_three_transient_failures() {
    let body = b"{\"type\":\"init\"}\n";
    let hash = hex::encode(Sha256::digest(body));
    let server = MultiShotSessionHistoryServer::respond_many(vec![
        MultiShotSessionHistoryResponse::status("503 Service Unavailable");
        3
    ])
    .await;
    let session = ref_session(server.url(), hash, body.len() as u64, body.len() as u64);

    match start_materializer(&session)
        .finish(&CancellationToken::new())
        .await
    {
        SessionHistoryMaterialization::Failed { error, timings, .. } => {
            assert!(error.to_string().contains("503"), "{error}");
            assert_phase_failure(timings.request_status());
            assert_no_phase(timings.hash_verification());
        }
        _ => panic!("expected exhausted download to fail"),
    }
    server.assert_served(3).await;
}

#[tokio::test]
async fn materializer_does_not_retry_permanent_http_failures() {
    for status in [
        "401 Unauthorized",
        "403 Forbidden",
        "404 Not Found",
        "501 Not Implemented",
    ] {
        let body = b"{\"type\":\"init\"}\n";
        let hash = hex::encode(Sha256::digest(body));
        let server = MultiShotSessionHistoryServer::respond_many(vec![
            MultiShotSessionHistoryResponse::status(status),
            MultiShotSessionHistoryResponse::ok(body, Some(body.len() as u64)),
        ])
        .await;
        let session = ref_session(server.url(), hash, body.len() as u64, body.len() as u64);

        match start_materializer(&session)
            .finish(&CancellationToken::new())
            .await
        {
            SessionHistoryMaterialization::Failed { error, .. } => {
                assert!(error.to_string().contains(&status[..3]), "{error}");
            }
            _ => panic!("expected {status} to fail without recovery"),
        }
        server.stop_and_assert_requests(1).await;
    }
}

#[tokio::test]
async fn materializer_does_not_ignore_retry_after_or_exceed_its_budget() {
    for retry_after in ["120", "Fri, 01 Jan 2100 00:00:00 GMT", "invalid"] {
        let body = b"{\"type\":\"init\"}\n";
        let hash = hex::encode(Sha256::digest(body));
        let server = MultiShotSessionHistoryServer::respond_many(vec![
            MultiShotSessionHistoryResponse::status("429 Too Many Requests")
                .with_retry_after(retry_after),
            MultiShotSessionHistoryResponse::ok(body, Some(body.len() as u64)),
        ])
        .await;
        let session = ref_session(server.url(), hash, body.len() as u64, body.len() as u64);

        match start_materializer(&session)
            .finish(&CancellationToken::new())
            .await
        {
            SessionHistoryMaterialization::Failed { error, .. } => {
                assert!(error.to_string().contains("429"), "{error}");
            }
            _ => panic!("expected provider delay to prevent an early retry"),
        }
        server.stop_and_assert_requests(1).await;
    }
}

#[tokio::test]
async fn materializer_recovers_after_download_timeout() {
    let body = b"{\"type\":\"init\"}\n";
    let hash = hex::encode(Sha256::digest(body));
    let server = MultiShotSessionHistoryServer::respond_many(vec![
        MultiShotSessionHistoryResponse::ok(Vec::new(), Some(body.len() as u64)).stalled(),
        MultiShotSessionHistoryResponse::ok(body, Some(body.len() as u64)),
    ])
    .await;
    let session = ref_session(server.url(), hash, body.len() as u64, body.len() as u64);
    let materializer = start_materializer(&session);
    let download =
        tokio::spawn(async move { materializer.finish(&CancellationToken::new()).await });
    server.wait_for_response(1).await;
    tokio::time::pause();
    tokio::time::advance(OBJECT_DOWNLOAD_TIMEOUT).await;
    tokio::time::resume();

    match download.await.unwrap() {
        SessionHistoryMaterialization::Downloaded { session, .. } => {
            assert_eq!(session.history_bytes(), body);
        }
        _ => panic!("expected timed-out GET to recover"),
    }
    server.assert_served(2).await;
}

#[tokio::test]
async fn materializer_limits_total_time_spent_on_stalled_downloads() {
    let body = b"{\"type\":\"init\"}\n";
    let hash = hex::encode(Sha256::digest(body));
    let server = MultiShotSessionHistoryServer::respond_many(vec![
        MultiShotSessionHistoryResponse::ok(Vec::new(), Some(body.len() as u64)).stalled();
        3
    ])
    .await;
    let session = ref_session(server.url(), hash, body.len() as u64, body.len() as u64);
    let materializer = start_materializer(&session);
    let download =
        tokio::spawn(async move { materializer.finish(&CancellationToken::new()).await });
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
            // Expire the total budget before the third per-request deadline;
            // jumping a full 30 seconds would make both timers ready at once.
            SESSION_HISTORY_DOWNLOAD_BUDGET.saturating_sub(observed_start.elapsed())
        };
        tokio::time::advance(advance).await;
        tokio::time::resume();
    }

    match download.await.unwrap() {
        SessionHistoryMaterialization::Failed { error, .. } => {
            assert!(error.to_string().contains("retry budget"), "{error}");
        }
        _ => panic!("expected total download budget to expire"),
    }
    server.assert_served(3).await;
}

#[tokio::test]
async fn cancelling_materializer_stops_provider_backoff_without_another_get() {
    let body = b"{\"type\":\"init\"}\n";
    let hash = hex::encode(Sha256::digest(body));
    let server = MultiShotSessionHistoryServer::respond_many(vec![
        MultiShotSessionHistoryResponse::new("429 Too Many Requests", Vec::new(), Some(1))
            .with_retry_after("60")
            .stalled(),
        MultiShotSessionHistoryResponse::ok(body, Some(body.len() as u64)),
    ])
    .await;
    let session = ref_session(server.url(), hash, body.len() as u64, body.len() as u64);
    let cancel = CancellationToken::new();
    let download_cancel = cancel.clone();
    let materializer = start_materializer(&session);
    let download = tokio::spawn(async move { materializer.finish(&download_cancel).await });
    // Observe rejection of the unfinished 429 body, not just its headers being
    // sent, so cancellation occurs in the already-armed provider backoff.
    server.wait_for_client_close().await;
    cancel.cancel();

    assert!(matches!(
        finish_download(download).await,
        SessionHistoryMaterialization::Failed {
            error: RunnerError::Cancelled,
            ..
        }
    ));
    server.stop_and_assert_requests(1).await;
}

async fn finish_download(
    mut download: JoinHandle<SessionHistoryMaterialization>,
) -> SessionHistoryMaterialization {
    match tokio::time::timeout(Duration::from_secs(5), &mut download).await {
        Ok(result) => result.expect("session history download task should not panic"),
        Err(_) => {
            download.abort();
            let _ = download.await;
            panic!("session history recovery or cancellation should finish promptly");
        }
    }
}
