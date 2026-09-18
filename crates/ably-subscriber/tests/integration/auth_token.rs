use crate::support::*;
use ably_subscriber::protocol::{ProtocolMessage, action, encode_msg, error_code};
use ably_subscriber::{Error, Event, SubscribeConfig, Subscription, TimingConfig, subscribe};
use futures_util::SinkExt;
use httpmock::prelude::*;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio_tungstenite::tungstenite;

const TOKEN_EXCHANGE_RESPONSE_MAX_BYTES: usize = 64 * 1024;

fn token_response_limit_error(result: Result<Subscription, Error>) -> Result<String, String> {
    match result {
        Err(Error::Protocol { code, message }) => {
            assert_eq!(code, error_code::FAILED);
            assert_eq!(message, "Token exchange response body exceeds 64 KiB limit");
            Ok(message)
        }
        Err(other) => Err(format!(
            "expected token response limit error, got {other:?}"
        )),
        Ok(_) => Err("expected token response limit error, got subscription".to_string()),
    }
}

#[tokio::test]
async fn http_token_exchange_error() {
    let http = MockServer::start();
    // No WS server needed — we fail before connecting
    let path = "/keys/testKey.testId/requestToken";
    http.mock(|when, then| {
        when.method(POST).path(path);
        then.status(500).body("Internal Server Error");
    });

    let result = subscribe(test_config(19999, http.port(), "ch")).await;
    match result {
        Err(ably_subscriber::Error::Http(_)) => {}
        Err(other) => panic!("expected Http error, got {other:?}"),
        Ok(_) => panic!("expected error, got Ok"),
    }
}

#[tokio::test]
async fn token_exchange_encodes_key_name_as_path_segment() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();

    let now = now_ms();
    let token_mock = http.mock(|when, then| {
        when.method(POST)
            .path("/keys/a%2Fb%3Fc%23d%25%20e/requestToken");
        then.status(201)
            .header("content-type", "application/json")
            .json_body(serde_json::json!({
                "token": "mock-token-abc",
                "expires": now + 3_600_000,
                "issued": now,
            }));
    });

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let _conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
    });

    let mut sub = subscribe(test_config_with_key_name(
        ws_port,
        http.port(),
        "ch",
        "a/b?c#d% e",
    ))
    .await
    .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();
    assert_eq!(token_mock.calls(), 1);
    sub.close();
    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn token_exchange_invalid_json_response_is_protocol_error() {
    let http = MockServer::start();
    http.mock(|when, then| {
        when.method(POST).path("/keys/testKey.testId/requestToken");
        then.status(201)
            .header("content-type", "application/json")
            .body("{not-json");
    });

    let result = subscribe(test_config(19999, http.port(), "ch")).await;
    match result {
        Err(Error::Protocol { code, message }) => {
            assert_eq!(code, error_code::FAILED);
            assert!(
                message.starts_with("Token exchange response JSON decode failed:"),
                "got: {message}"
            );
        }
        Err(other) => panic!("expected Protocol error, got {other:?}"),
        Ok(_) => panic!("expected error, got Ok"),
    }
}

#[tokio::test]
async fn token_exchange_rejects_declared_response_over_limit_without_body() {
    let http = RawTokenServer::start().await.unwrap();
    let http_port = http.port();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let server_task = tokio::spawn(async move {
        let mut stream = http.accept_request().await.unwrap();
        stream
            .write_all(
                format!(
                    "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    TOKEN_EXCHANGE_RESPONSE_MAX_BYTES + 1
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let _ = release_rx.await;
    });

    let result = tokio::time::timeout(
        TEST_IO_TIMEOUT,
        subscribe(test_config(19999, http_port, "ch")),
    )
    .await
    .expect("token exchange waited for an oversized declared body");
    token_response_limit_error(result).unwrap();

    release_tx.send(()).unwrap();
    join_server_task(server_task, "declared oversized token response")
        .await
        .unwrap();
}

#[tokio::test]
async fn token_exchange_rejects_chunked_response_over_limit() {
    const RESPONSE_MARKER: &[u8] = b"token-response-secret-marker";

    let http = RawTokenServer::start().await.unwrap();
    let http_port = http.port();
    let server_task = tokio::spawn(async move {
        let mut stream = http.accept_request().await.unwrap();
        stream
            .write_all(
                b"HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();

        let mut first = vec![b'a'; TOKEN_EXCHANGE_RESPONSE_MAX_BYTES / 2];
        first[..RESPONSE_MARKER.len()].copy_from_slice(RESPONSE_MARKER);
        let second = vec![b'b'; TOKEN_EXCHANGE_RESPONSE_MAX_BYTES + 1 - first.len()];
        for chunk in [&first, &second] {
            stream
                .write_all(format!("{:X}\r\n", chunk.len()).as_bytes())
                .await
                .unwrap();
            stream.write_all(chunk).await.unwrap();
            stream.write_all(b"\r\n").await.unwrap();
        }
        let _ = stream.write_all(b"0\r\n\r\n").await;
    });

    let result = subscribe(test_config(19999, http_port, "ch")).await;
    let message = token_response_limit_error(result).unwrap();
    assert!(!message.contains("token-response-secret-marker"));

    join_server_task(server_task, "chunked oversized token response")
        .await
        .unwrap();
}

#[tokio::test]
async fn token_exchange_accepts_valid_response_at_limit() {
    let http = RawTokenServer::start().await.unwrap();
    let ws = MockAblyServer::start().await.unwrap();
    let now = now_ms();
    let token_body = |capability: &str| {
        serde_json::to_vec(&serde_json::json!({
            "token": "mock-token-abc",
            "expires": now + 3_600_000,
            "issued": now,
            "capability": capability,
        }))
        .unwrap()
    };
    let base_body = token_body("");
    let body = token_body(&"x".repeat(TOKEN_EXCHANGE_RESPONSE_MAX_BYTES - base_body.len()));
    assert_eq!(body.len(), TOKEN_EXCHANGE_RESPONSE_MAX_BYTES);

    let http_port = http.port();
    let token_server_task = tokio::spawn(async move {
        let mut stream = http.accept_request().await.unwrap();
        stream
            .write_all(
                format!(
                    "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        stream.write_all(&body).await.unwrap();
    });

    let ws_port = ws.port;
    let websocket_server_task = tokio::spawn(async move {
        let _conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
    });

    let mut sub = subscribe(test_config(ws_port, http_port, "ch"))
        .await
        .unwrap();
    expect_connected(&mut sub, "exact-limit token response")
        .await
        .unwrap();
    sub.close();

    join_server_task(token_server_task, "exact-limit token response")
        .await
        .unwrap();
    join_server_task(websocket_server_task, "exact-limit token websocket")
        .await
        .unwrap();
}

#[tokio::test]
async fn token_exchange_invalid_rest_host_fails_before_request() {
    let http = MockServer::start();
    let token_mock = http.mock(|when, then| {
        when.method(POST).path("/keys/testKey.testId/requestToken");
        then.status(201)
            .header("content-type", "application/json")
            .json_body(serde_json::json!({
                "token": "mock-token-abc",
                "expires": now_ms() + 3_600_000,
                "issued": now_ms(),
            }));
    });

    let mut config = test_config(19999, http.port(), "ch");
    config.rest_host = Some(format!("127.0.0.1:{}/path", http.port()));

    let result = subscribe(config).await;
    match result {
        Err(ably_subscriber::Error::Url(_)) => {}
        Err(other) => panic!("expected Url error, got {other:?}"),
        Ok(_) => panic!("expected error, got Ok"),
    }
    assert_eq!(token_mock.calls(), 0);
}

#[tokio::test]
async fn token_exchange_dot_segment_key_name_fails_before_request() {
    let http = MockServer::start();
    let token_mock = http.mock(|when, then| {
        when.method(POST).path("/keys/requestToken");
        then.status(201)
            .header("content-type", "application/json")
            .json_body(serde_json::json!({
                "token": "mock-token-abc",
                "expires": now_ms() + 3_600_000,
                "issued": now_ms(),
            }));
    });

    let result = subscribe(test_config_with_key_name(19999, http.port(), "ch", ".")).await;
    match result {
        Err(ably_subscriber::Error::Url(_)) => {}
        Err(other) => panic!("expected Url error, got {other:?}"),
        Ok(_) => panic!("expected error, got Ok"),
    }
    assert_eq!(token_mock.calls(), 0);
}

#[tokio::test]
async fn token_renewal() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();

    let now = now_ms();
    // First token: expires in 1 second. If it is still valid when installed,
    // the 300s margin is capped at half its remaining lifetime; if setup has
    // consumed that lifetime, renewal is immediately due. Second token: 1 hour
    // TTL, so the next renewal stays beyond the test's observation window.
    let short_body = serde_json::to_vec(&serde_json::json!({
        "token": "short-lived-token",
        "expires": now + 1_000,
        "issued": now,
    }))
    .unwrap();
    let renewed_body = serde_json::to_vec(&serde_json::json!({
        "token": "renewed-token",
        "expires": now + 3_600_000,
        "issued": now,
    }))
    .unwrap();

    // Single mock with stateful response: first call returns the short
    // token, subsequent calls return the renewed long-lived token.  This
    // lets us assert via `calls()` that renewal stabilises at exactly 2
    // calls — any more means the subscriber ignored the new TTL and kept
    // renewing in a loop.
    let path = "/keys/testKey.testId/requestToken";
    let call_count = std::sync::Mutex::new(0u32);
    let token_mock = http.mock(|when, then| {
        when.method(POST).path(path);
        then.respond_with(move |_req: &HttpMockRequest| {
            let mut n = call_count.lock().unwrap();
            let body = if *n == 0 { &short_body } else { &renewed_body };
            *n += 1;
            HttpMockResponse::builder()
                .status(201)
                .header("content-type", "application/json")
                .body(body.clone())
                .build()
        });
    });

    let ws_port = ws.port;
    tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        // Wait for AUTH message from client
        let auth_msg = expect_protocol_msg(&mut conn, "AUTH").await.unwrap();
        assert_eq!(auth_msg.action, action::AUTH);

        // Send a message after renewal
        send_message(&mut conn, "ch", "after-renewal", serde_json::json!("ok"))
            .await
            .unwrap();
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    // Should receive the message sent after token renewal
    let event =
        expect_event_with_timeout(&mut sub, RECONNECT_EVENT_TIMEOUT, "message after renewal")
            .await
            .unwrap();

    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-renewal"));
        }
        other => panic!("expected Message, got {other:?}"),
    }

    assert_value_stable_for(
        Duration::from_millis(500),
        || token_mock.calls(),
        2,
        "subscriber should stop renewing after receiving the long-lived token",
    )
    .await;
}

#[tokio::test]
async fn repeated_short_lived_tokens_are_spaced_without_starving_messages() {
    const SHORT_TOKEN_TTL_MS: i64 = 4_000;
    const PRE_EXPIRY_RENEWAL_TIMEOUT: Duration = Duration::from_secs(3);

    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();

    let call_count = std::sync::Mutex::new(0u32);
    let token_mock = http.mock(|when, then| {
        when.method(POST).path("/keys/testKey.testId/requestToken");
        then.respond_with(move |_req: &HttpMockRequest| {
            let mut calls = call_count.lock().unwrap();
            let call = *calls;
            *calls += 1;

            let now = now_ms();
            let expires = if call == 0 {
                now
            } else {
                now + SHORT_TOKEN_TTL_MS
            };
            let body = serde_json::to_vec(&serde_json::json!({
                "token": format!("short-lived-token-{call}"),
                "expires": expires,
                "issued": now,
            }))
            .unwrap();

            HttpMockResponse::builder()
                .status(201)
                .header("content-type", "application/json")
                .body(body)
                .build()
        });
    });

    let ws_port = ws.port;
    let (second_renewal_tx, second_renewal_rx) = tokio::sync::oneshot::channel::<()>();
    let (test_complete_tx, test_complete_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        let first_auth = expect_protocol_msg(&mut conn, "first short-token AUTH")
            .await
            .unwrap();
        assert_eq!(first_auth.action, action::AUTH);

        send_message(&mut conn, "ch", "between-renewals", serde_json::json!("ok"))
            .await
            .unwrap();

        let second_auth = expect_protocol_msg(&mut conn, "second short-token AUTH")
            .await
            .unwrap();
        assert_eq!(second_auth.action, action::AUTH);
        second_renewal_tx.send(()).unwrap();
        wait_for_test_observation(test_complete_rx, "short-token renewal assertions").await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();
    let event = expect_event_with_timeout(
        &mut sub,
        RECONNECT_EVENT_TIMEOUT,
        "message between short-token renewals",
    )
    .await
    .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("between-renewals"));
        }
        other => panic!("expected Message, got {other:?}"),
    }

    assert_value_stable_for(
        Duration::from_millis(250),
        || token_mock.calls(),
        2,
        "short-lived replacement token should schedule a future renewal",
    )
    .await;

    tokio::time::timeout(PRE_EXPIRY_RENEWAL_TIMEOUT, second_renewal_rx)
        .await
        .expect("short-lived replacement token should renew before expiry")
        .unwrap();
    assert_eq!(token_mock.calls(), 3);

    test_complete_tx.send(()).unwrap();
    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn close_during_pending_token_renewal_sends_close() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();

    let now = now_ms();
    let short_token = serde_json::json!({
        "token": "short-lived-token",
        "expires": now + 1_000,
        "issued": now,
    });
    let path = "/keys/testKey.testId/requestToken";
    http.mock(|when, then| {
        when.method(POST).path(path);
        then.status(201)
            .header("content-type", "application/json")
            .json_body(short_token);
    });

    let ws_port = ws.port;
    let (renewal_started_tx, renewal_started_rx) = tokio::sync::oneshot::channel::<()>();
    let (close_tx, close_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        let msg = expect_protocol_msg(&mut conn, "CLOSE during renewal")
            .await
            .unwrap();
        assert_eq!(msg.action, action::CLOSE);
        close_tx.send(()).unwrap();
    });

    let mut sub = subscribe(test_config_with_pending_renewal(
        ws_port,
        http.port(),
        "ch",
        renewal_started_tx,
    ))
    .await
    .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), renewal_started_rx)
        .await
        .expect("timed out waiting for token renewal to start")
        .unwrap();

    sub.close();

    tokio::time::timeout(Duration::from_secs(5), close_rx)
        .await
        .expect("timed out waiting for CLOSE during pending renewal")
        .unwrap();
    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn server_initiated_auth() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (after_auth_seen_tx, after_auth_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        // Server sends AUTH to request reauthentication
        let auth_request = ProtocolMessage {
            action: action::AUTH,
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&auth_request).unwrap().into(),
        ))
        .await
        .unwrap();

        // Client should respond with AUTH containing new token
        let msg = expect_protocol_msg(&mut conn, "client AUTH response")
            .await
            .unwrap();
        assert_eq!(msg.action, action::AUTH);
        assert!(
            msg.auth.is_some(),
            "AUTH message should contain auth details"
        );

        // Send a message to confirm the connection is still alive
        send_message(
            &mut conn,
            "ch",
            "after-server-auth",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(after_auth_seen_rx, "after-server-auth message").await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    let event = expect_event(&mut sub, "message after server AUTH")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-server-auth"));
            after_auth_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn close_during_server_requested_pending_token_renewal_sends_close() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (renewal_started_tx, renewal_started_rx) = tokio::sync::oneshot::channel::<()>();
    let (close_tx, close_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        let auth_request = ProtocolMessage {
            action: action::AUTH,
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&auth_request).unwrap().into(),
        ))
        .await
        .unwrap();

        let msg = expect_protocol_msg(&mut conn, "CLOSE during server-requested renewal")
            .await
            .unwrap();
        assert_eq!(msg.action, action::CLOSE);
        close_tx.send(()).unwrap();
    });

    let mut sub = subscribe(test_config_with_pending_renewal(
        ws_port,
        http.port(),
        "ch",
        renewal_started_tx,
    ))
    .await
    .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), renewal_started_rx)
        .await
        .expect("timed out waiting for server-requested token renewal to start")
        .unwrap();

    sub.close();

    tokio::time::timeout(Duration::from_secs(5), close_rx)
        .await
        .expect("timed out waiting for CLOSE during pending server-requested renewal")
        .unwrap();
    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn get_token_callback_error() {
    let mut config = SubscribeConfig::new(
        Box::new(|| Box::pin(async { Err("token fetch failed".into()) })),
        "ch",
    );
    config.host = Some("127.0.0.1:19999".into());
    config.rest_host = Some("127.0.0.1:19999".into());

    let result = subscribe(config).await;
    match result {
        Err(ably_subscriber::Error::TokenFetch(_)) => {}
        Err(other) => panic!("expected TokenFetch error, got {other:?}"),
        Ok(_) => panic!("expected error, got Ok"),
    }
}

#[tokio::test]
async fn token_renewal_failures_fatal() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();

    // Return a token that expires in 1 second. If it is still valid when
    // installed, the 300s margin is capped at half its remaining lifetime;
    // if setup has consumed that lifetime, renewal is immediately due.
    let now = now_ms();
    let short_token = serde_json::json!({
        "token": "short-lived-token",
        "expires": now + 1_000,
        "issued": now,
    });
    let path = "/keys/testKey.testId/requestToken";
    http.mock(|when, then| {
        when.method(POST).path(path);
        then.status(201)
            .header("content-type", "application/json")
            .json_body(short_token);
    });

    let ws_port = ws.port;
    let host = format!("127.0.0.1:{ws_port}");
    let rest_host = format!("127.0.0.1:{}", http.port());

    tokio::spawn(async move {
        let _conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        // Keep the socket open; the subscriber should close itself after
        // fatal token-renewal failures.
        std::future::pending::<()>().await;
    });

    // Use an atomic counter so get_token succeeds for the initial exchange
    // but fails for all subsequent renewal attempts.
    let call_count = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let cc = call_count.clone();
    let mut config = SubscribeConfig::new(
        Box::new(move || {
            let n = cc.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Box::pin(async move {
                if n > 0 {
                    return Err("simulated token fetch failure".into());
                }
                Ok(ably_subscriber::TokenRequest {
                    key_name: "testKey.testId".into(),
                    timestamp: now_ms(),
                    nonce: "nonce-1".into(),
                    mac: "fake-mac".into(),
                    capability: r#"{"*":["subscribe"]}"#.into(),
                    ttl: None,
                    client_id: None,
                })
            })
        }),
        "ch",
    );
    config.host = Some(host);
    config.rest_host = Some(rest_host);
    config.timing = Some({
        let mut t = TimingConfig::default();
        t.token_renewal_retry_delay = Duration::from_millis(10);
        t
    });
    let mut sub = subscribe(config).await.unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    // Should eventually get a fatal error after 3 consecutive renewal failures
    let event = expect_event_with_timeout(&mut sub, RECONNECT_EVENT_TIMEOUT, "Error")
        .await
        .unwrap();
    match event {
        Event::Error { message, .. } => {
            assert!(
                message.contains("renewal failed 3 consecutive"),
                "unexpected message: {message}"
            );
        }
        other => panic!("expected Error, got {other:?}"),
    }

    expect_subscription_closed(&mut sub, "subscription end")
        .await
        .unwrap();
}
