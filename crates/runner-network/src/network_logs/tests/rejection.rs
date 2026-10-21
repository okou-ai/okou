use super::*;

#[tokio::test]
async fn upload_network_logs_keeps_rejection_after_body_read_failure() {
    let dir = tempfile::tempdir().unwrap();
    let path = network_log_file(&dir);
    let content = network_log_content(&[json!({"host": "rejected.example"})]);
    tokio::fs::write(&path, &content).await.unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let http = HttpClient::new(HttpClientConfig {
        api_url: format!("http://{}", listener.local_addr().unwrap()),
        vercel_bypass: None,
        client_session_id: "runner-session-test".to_string(),
    })
    .unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = read_http_request(&mut stream).await;
        stream
            .write_all(
                b"HTTP/1.1 429 Too Many Requests\r\nContent-Length: 64\r\nConnection: close\r\n\r\n{",
            )
            .await
            .unwrap();
        stream.shutdown().await.unwrap();
        (request, listener)
    });

    let (outcome, events) = capture_async_log_events(upload_network_logs(
        &http,
        RunId::from(uuid::Uuid::nil()),
        SANDBOX_TOKEN,
        &path,
    ))
    .await;
    let (request, listener) = server.await.unwrap();

    assert_eq!(outcome, NetworkLogUploadSessionOutcome::Excluded);
    let started = captured_batch_event(&events, "uploading network log batch", 1);
    let rejected = captured_batch_event(&events, "network logs upload rejected", 1);
    assert_batch_request_event(rejected, 1, "confirmed_rejection");
    assert_same_request_correlation(started, rejected);
    assert_eq!(
        event_field(rejected, "client_request_id"),
        request.header(CLIENT_REQUEST_ID_HEADER)
    );
    assert_event_field(rejected, "status", "429 Too Many Requests");
    assert!(!event_field(rejected, "response_body_read_error").is_empty());
    assert!(!has_captured_event(&events, "network logs upload failed"));
    assert!(
        tokio::time::timeout(Duration::from_millis(1), listener.accept())
            .await
            .is_err()
    );
    assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), content);
}
