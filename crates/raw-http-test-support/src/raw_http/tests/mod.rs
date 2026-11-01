use super::*;

async fn connect(server: &RawHttpTestServer) -> TcpStream {
    let url = server.url();
    TcpStream::connect(url.strip_prefix("http://").unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn captures_complete_request_and_responds() {
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
        "200 OK",
        r#"{"success":true}"#,
    ))])
    .await;
    let mut socket = connect(&server).await;
    socket
        .write_all(b"POST /test HTTP/1.1\r\nContent-Length: 4\r\n\r\nbody")
        .await
        .unwrap();
    let mut response = Vec::new();
    socket.read_to_end(&mut response).await.unwrap();

    assert_eq!(
        server.next_request("complete fixture request").await,
        "POST /test HTTP/1.1\r\nContent-Length: 4\r\n\r\nbody"
    );
    assert!(
        String::from_utf8(response)
            .unwrap()
            .ends_with(r#"{"success":true}"#)
    );
    server.assert_finished().await;
}

#[tokio::test]
async fn rejects_premature_header_eof() {
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Disconnect]).await;
    let mut socket = connect(&server).await;
    socket.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
    socket.shutdown().await.unwrap();
    drop(socket);

    let error = server
        .finish_with_timeout(RAW_HTTP_FIXTURE_TIMEOUT)
        .await
        .unwrap_err();
    assert!(error.contains("connection closed before HTTP headers completed"));
}

#[tokio::test]
async fn rejects_premature_body_eof() {
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Disconnect]).await;
    let mut socket = connect(&server).await;
    socket
        .write_all(b"POST / HTTP/1.1\r\nContent-Length: 4\r\n\r\nab")
        .await
        .unwrap();
    socket.shutdown().await.unwrap();
    drop(socket);

    let error = server
        .finish_with_timeout(RAW_HTTP_FIXTURE_TIMEOUT)
        .await
        .unwrap_err();
    assert!(error.contains("connection closed before HTTP body completed"));
}

#[tokio::test]
async fn direct_reader_times_out_incomplete_request() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut client = TcpStream::connect(address).await.unwrap();
    let (mut socket, _) = listener.accept().await.unwrap();
    client.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();

    let error = read_http_request_with_timeout(&mut socket, Duration::from_millis(10))
        .await
        .unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert_eq!(error.to_string(), "timed out reading raw HTTP request");
}

#[tokio::test]
async fn rejects_malformed_content_length() {
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Disconnect]).await;
    let mut socket = connect(&server).await;
    socket
        .write_all(b"POST / HTTP/1.1\r\nContent-Length: +7\r\n\r\n")
        .await
        .unwrap();
    drop(socket);

    let error = server
        .finish_with_timeout(RAW_HTTP_FIXTURE_TIMEOUT)
        .await
        .unwrap_err();
    assert!(error.contains("invalid HTTP Content-Length"));
}

#[tokio::test]
async fn rejects_body_over_fixture_limit() {
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Disconnect]).await;
    let mut socket = connect(&server).await;
    socket
        .write_all(
            format!(
                "POST / HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
                MAX_REQUEST_BODY_BYTES + 1
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    drop(socket);

    let error = server
        .finish_with_timeout(RAW_HTTP_FIXTURE_TIMEOUT)
        .await
        .unwrap_err();
    assert!(error.contains("HTTP request body exceeds fixture limit"));
}

#[tokio::test]
async fn disconnects_after_capturing_request() {
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Disconnect]).await;
    let mut socket = connect(&server).await;
    socket.write_all(b"GET / HTTP/1.1\r\n\r\n").await.unwrap();
    let mut response = Vec::new();
    socket.read_to_end(&mut response).await.unwrap();

    assert!(response.is_empty());
    assert_eq!(
        server.next_request("disconnect request").await,
        "GET / HTTP/1.1\r\n\r\n"
    );
    server.assert_finished().await;
}

#[tokio::test]
async fn captures_request_before_delayed_response_is_released() {
    let (release_tx, release_rx) = oneshot::channel();
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitThenRespond {
        release: release_rx,
        response: http_response("204 No Content", b""),
    }])
    .await;
    let address = server.address;
    let client = tokio::spawn(async move {
        let mut socket = TcpStream::connect(address).await.unwrap();
        socket.write_all(b"GET / HTTP/1.1\r\n\r\n").await.unwrap();
        let mut response = Vec::new();
        socket.read_to_end(&mut response).await.unwrap();
        response
    });

    assert_eq!(
        server.next_request("delayed response request").await,
        "GET / HTTP/1.1\r\n\r\n"
    );
    assert!(!client.is_finished());
    release_tx.send(()).unwrap();
    let response = client.await.unwrap();
    assert!(
        String::from_utf8(response)
            .unwrap()
            .starts_with("HTTP/1.1 204 No Content")
    );
    server.assert_finished().await;
}

#[tokio::test]
async fn timeout_aborts_and_reaps_unfinished_accept() {
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Disconnect]).await;

    let error = server
        .finish_with_timeout(Duration::from_millis(10))
        .await
        .unwrap_err();

    assert_eq!(error, "timed out; task reaped after abort");
}

#[tokio::test]
async fn explicit_cancellation_reaps_stalled_action() {
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Stall]).await;
    let mut socket = connect(&server).await;
    socket.write_all(b"GET / HTTP/1.1\r\n\r\n").await.unwrap();
    assert_eq!(
        server.next_request("stalled request").await,
        "GET / HTTP/1.1\r\n\r\n"
    );

    server.cancel_and_reap().await;
}

#[tokio::test]
async fn sends_exact_json_and_binary_response_bytes() {
    let server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(json_response("200 OK", r#"{"ok":true}"#)),
        RawHttpAction::Respond(http_response("206 Partial Content", &[0, 255, 13, 10])),
    ])
    .await;
    let expected: [&[u8]; 2] = [
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
            b"HTTP/1.1 206 Partial Content\r\nContent-Length: 4\r\nConnection: close\r\n\r\n\x00\xff\r\n",
        ];

    for response in expected {
        let mut socket = connect(&server).await;
        socket.write_all(b"GET / HTTP/1.1\r\n\r\n").await.unwrap();
        let mut actual = Vec::new();
        socket.read_to_end(&mut actual).await.unwrap();
        assert_eq!(actual, response);
    }

    let requests = server.assert_finished_with_requests().await;
    assert_eq!(requests, vec!["GET / HTTP/1.1\r\n\r\n"; 2]);
}

#[tokio::test]
async fn rejects_duplicate_content_length_headers() {
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Disconnect]).await;
    let mut socket = connect(&server).await;
    socket
        .write_all(b"POST / HTTP/1.1\r\nContent-Length: 0\r\ncontent-length: 0\r\n\r\n")
        .await
        .unwrap();
    drop(socket);

    let error = server
        .finish_with_timeout(RAW_HTTP_FIXTURE_TIMEOUT)
        .await
        .unwrap_err();

    assert!(error.contains("duplicate HTTP Content-Length header"));
}

#[tokio::test]
async fn rejects_headers_over_fixture_limit() {
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Disconnect]).await;
    let mut socket = connect(&server).await;
    let request = format!(
        "GET / HTTP/1.1\r\nX-Padding: {}\r\n\r\n",
        "a".repeat(MAX_REQUEST_HEADER_BYTES)
    );
    socket.write_all(request.as_bytes()).await.unwrap();
    drop(socket);

    let error = server
        .finish_with_timeout(RAW_HTTP_FIXTURE_TIMEOUT)
        .await
        .unwrap_err();

    assert!(error.contains("HTTP request headers exceed fixture limit"));
}

#[tokio::test]
async fn observes_client_disconnect_after_capturing_request() {
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitForDisconnect]).await;
    let mut socket = connect(&server).await;
    socket.write_all(b"GET / HTTP/1.1\r\n\r\n").await.unwrap();

    assert_eq!(
        server
            .next_request("request before client disconnect")
            .await,
        "GET / HTTP/1.1\r\n\r\n"
    );
    socket.shutdown().await.unwrap();
    server.assert_finished().await;
}

#[tokio::test]
async fn custom_task_join_preserves_its_output() {
    let task = tokio::spawn(async { Ok::<_, io::Error>("custom fixture output") });

    assert_eq!(
        join_raw_http_task(task, "custom raw HTTP fixture")
            .await
            .unwrap(),
        "custom fixture output"
    );
}
