use std::sync::{Arc, Mutex};

use httpmock::{HttpMockRequest, HttpMockResponse, MockServer};
use serde_json::Value;
use tokio::sync::oneshot;

use super::*;
use crate::axiom_layer::{init_with_base_url, with_ingest_filter};

struct Refresh {
    handle: BuiltinFirewallCatalogRefreshHandle,
    cache_path: PathBuf,
    _dir: tempfile::TempDir,
}

impl Refresh {
    async fn start(server: &mut RawHttpTestServer) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let api = ApiClient::new(
            HttpClient::create(HttpClientConfig {
                api_url: server.url(),
                vercel_bypass: None,
                client_session_id: "catalog-send-timeout-test".to_string(),
            })
            .unwrap(),
            "private-runner-token".to_string(),
        );
        let handle = BuiltinFirewallCatalogRefreshHandle::start(
            api,
            cache_path.clone(),
            dir.path().join("catalog.lock"),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        server.next_request("initial catalog publication").await;
        // Let the spawned production task register its first periodic sleep.
        tokio::task::yield_now().await;
        Self {
            handle,
            cache_path,
            _dir: dir,
        }
    }
}

fn timeout_action() -> (RawHttpAction, oneshot::Sender<()>) {
    let (release, receiver) = oneshot::channel();
    (
        RawHttpAction::WaitThenRespond {
            release: receiver,
            // Release the timed-out connection without sending response bytes.
            response: Vec::new(),
        },
        release,
    )
}

async fn advance_interval(captured: &CapturedEvents) {
    captured.clear();
    tokio::time::pause();
    tokio::time::advance(BUILTIN_FIREWALL_CATALOG_REFRESH_INTERVAL).await;
    tokio::time::resume();
}

async fn outcome(captured: &CapturedEvents) -> CapturedEvent {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let events: Vec<_> = captured
            .entries()
            .into_iter()
            .filter(|event| {
                event.fields.get("message").is_some_and(|message| {
                    message.starts_with("periodic builtin firewall catalog refresh")
                        || message.starts_with("builtin firewall catalog refresh ")
                })
            })
            .collect();
        if !events.is_empty() {
            assert_eq!(events.len(), 1, "one refresh outcome: {events:?}");
            return events.into_iter().next().unwrap();
        }
        assert!(
            std::time::Instant::now() < deadline,
            "missing refresh outcome"
        );
        tokio::task::yield_now().await;
    }
}

async fn next_timeout(
    server: &mut RawHttpTestServer,
    captured: &CapturedEvents,
    release: oneshot::Sender<()>,
) -> (CapturedEvent, String) {
    advance_interval(captured).await;
    let request = server.next_request("catalog request to time out").await;
    // No response headers have been sent. Expire the production request's
    // ten-second budget only after the external server has received the request.
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(10) + Duration::from_millis(1)).await;
    tokio::time::resume();
    let event = outcome(captured).await;
    release.send(()).unwrap();
    (event, request)
}

async fn next_response(server: &mut RawHttpTestServer, captured: &CapturedEvents) -> CapturedEvent {
    advance_interval(captured).await;
    server.next_request("next periodic catalog refresh").await;
    outcome(captured).await
}

#[tokio::test]
async fn send_timeout_recovers_unchanged_cache_without_axiom_warning() {
    let axiom = MockServer::start_async().await;
    let ingest = axiom
        .mock_async(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/v1/datasets/vm0-web-logs-test/ingest");
            then.status(200);
        })
        .await;
    let (layer, guard) = init_with_base_url(&axiom.base_url(), "test", "test").unwrap();
    let captured = CapturedEvents::default();
    let _subscriber = tracing::subscriber::set_default(
        tracing_subscriber::registry()
            .with(captured.clone())
            .with(with_ingest_filter(layer)),
    );
    let (timeout, release) = timeout_action();
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(catalog_response()),
        timeout,
        RawHttpAction::Respond(catalog_response()),
    ])
    .await;
    let refresh = Refresh::start(&mut server).await;
    let original = tokio::fs::read(&refresh.cache_path).await.unwrap();
    #[cfg(unix)]
    let inode = {
        use std::os::unix::fs::MetadataExt;
        tokio::fs::metadata(&refresh.cache_path)
            .await
            .unwrap()
            .ino()
    };

    let (failure, request) = next_timeout(&mut server, &captured, release).await;
    assert_eq!(failure.level, Level::INFO, "{failure:?}");
    assert_eq!(failure.fields["failure_stage"], "send");
    assert_eq!(failure.fields["failure_cause"], "timeout");
    assert_eq!(failure.fields["failure_kind"], "timeout");
    assert_eq!(failure.fields["consecutive_failures"], "1");
    assert_eq!(failure.fields["degraded"], "false");
    assert_eq!(
        failure.fields["endpoint"],
        "builtin firewall catalog resolve"
    );
    assert_eq!(failure.fields["method"], "POST");
    assert_eq!(
        failure.fields["path"],
        "/api/runners/builtin-firewalls/resolve"
    );
    assert_eq!(
        failure.fields["client_session_id"],
        "catalog-send-timeout-test"
    );
    assert!(request.contains(&format!(
        "x-client-request-id: {}",
        failure.fields["client_request_id"]
    )));
    for absent in ["status", "content_type", "received_bytes", "summary"] {
        assert!(!failure.fields.contains_key(absent), "{failure:?}");
    }
    assert!(!format!("{failure:?}").contains("private-runner-token"));
    assert_eq!(
        tokio::fs::read(&refresh.cache_path).await.unwrap(),
        original
    );

    let recovery = next_response(&mut server, &captured).await;
    assert_eq!(recovery.level, Level::INFO);
    assert_eq!(
        recovery.fields["message"],
        "builtin firewall catalog refresh recovered"
    );
    assert_eq!(recovery.fields["recovered_after_failures"], "1");
    assert_eq!(recovery.fields["was_degraded"], "false");
    assert_eq!(
        tokio::fs::read(&refresh.cache_path).await.unwrap(),
        original
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(
            tokio::fs::metadata(&refresh.cache_path)
                .await
                .unwrap()
                .ino(),
            inode
        );
    }
    refresh.handle.shutdown().await;
    server.assert_finished().await;
    guard.shutdown().await;
    ingest.assert_calls_async(0).await;
}

#[tokio::test]
async fn send_timeout_shares_degradation_with_body_reads_and_preserves_genuine_warnings() {
    let axiom = MockServer::start_async().await;
    let ingested = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sink = Arc::clone(&ingested);
    let ingest = axiom
        .mock_async(move |when, then| {
            when.method(httpmock::Method::POST)
                .path("/v1/datasets/vm0-web-logs-test/ingest");
            then.respond_with(move |request: &HttpMockRequest| {
                let events: Vec<Value> = serde_json::from_slice(request.body_ref()).unwrap();
                sink.lock().unwrap().extend(events);
                HttpMockResponse::builder().status(200).build()
            });
        })
        .await;
    // Queue through the real production layer during the scenario, then drive
    // its HTTP dispatcher on an independent clock after all catalog time jumps.
    // Advancing the catalog clock must not expire a loopback ingest in flight.
    let axiom_runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (layer, guard) = {
        let _entered = axiom_runtime.enter();
        init_with_base_url(&axiom.base_url(), "test", "test").unwrap()
    };
    let (finish_export, finished) = oneshot::channel::<()>();
    let exporter = tokio::task::spawn_blocking(move || {
        // Dropping the sender on a test failure also releases the owned runtime.
        let _ = finished.blocking_recv();
        axiom_runtime.block_on(guard.shutdown());
    });
    let captured = CapturedEvents::default();
    let _subscriber = tracing::subscriber::set_default(
        tracing_subscriber::registry()
            .with(captured.clone())
            .with(with_ingest_filter(layer)),
    );
    let (first, first_release) = timeout_action();
    let (second, second_release) = timeout_action();
    let (reset_episode, reset_release) = timeout_action();
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(catalog_response()),
        first,
        second,
        RawHttpAction::Respond(truncated_response("application/json")),
        RawHttpAction::ResetConnection,
        RawHttpAction::Respond(json_response(
            "401 Unauthorized",
            r#"{"error":"unauthorized"}"#,
        )),
        RawHttpAction::Respond(json_response(
            "503 Service Unavailable",
            r#"{"error":"unavailable"}"#,
        )),
        RawHttpAction::Respond(json_response("200 OK", "not JSON")),
        RawHttpAction::Respond(catalog_response()),
        RawHttpAction::Respond(truncated_response("application/json")),
        reset_episode,
        RawHttpAction::Respond(catalog_response()),
    ])
    .await;
    let refresh = Refresh::start(&mut server).await;
    let (first, _) = next_timeout(&mut server, &captured, first_release).await;
    assert_eq!(first.level, Level::INFO);
    let (second, _) = next_timeout(&mut server, &captured, second_release).await;
    assert_eq!(second.level, Level::WARN);
    assert_eq!(
        second.fields["message"],
        "builtin firewall catalog refresh degraded"
    );
    assert_eq!(second.fields["consecutive_failures"], "2");
    assert!(second.fields["failure_elapsed_ms"].parse::<u64>().unwrap() >= 300_000);
    let body = next_response(&mut server, &captured).await;
    assert_eq!(body.level, Level::INFO);
    assert_eq!(body.fields["consecutive_failures"], "3");
    assert_eq!(body.fields["degraded"], "true");
    assert_eq!(body.fields["status"], "200");
    for _ in 0..4 {
        let genuine = next_response(&mut server, &captured).await;
        assert_eq!(genuine.level, Level::WARN, "{genuine:?}");
        assert_eq!(
            genuine.fields["message"],
            "periodic builtin firewall catalog refresh failed"
        );
    }
    let recovery = next_response(&mut server, &captured).await;
    assert_eq!(recovery.fields["recovered_after_failures"], "3");
    assert_eq!(recovery.fields["was_degraded"], "true");
    let body = next_response(&mut server, &captured).await;
    assert_eq!(body.level, Level::INFO);
    assert_eq!(body.fields["consecutive_failures"], "1");
    assert_eq!(body.fields["degraded"], "false");
    let (timeout, _) = next_timeout(&mut server, &captured, reset_release).await;
    assert_eq!(timeout.level, Level::WARN);
    assert_eq!(timeout.fields["consecutive_failures"], "2");
    let recovery = next_response(&mut server, &captured).await;
    assert_eq!(recovery.fields["recovered_after_failures"], "2");
    refresh.handle.shutdown().await;
    server.assert_finished().await;
    finish_export.send(()).unwrap();
    exporter.await.unwrap();
    assert!(ingest.calls_async().await > 0);
    let ingested = ingested.lock().unwrap();
    assert_eq!(ingested.len(), 6, "{ingested:?}");
    assert!(ingested.iter().all(|event| event["level"] == "warn"));
    assert_eq!(
        ingested
            .iter()
            .filter(|event| event["message"] == "builtin firewall catalog refresh degraded")
            .count(),
        2
    );
}

#[tokio::test]
async fn send_timeout_warns_immediately_when_published_cache_is_no_longer_usable() {
    #[derive(Debug)]
    enum CacheDamage {
        Missing,
        Corrupt,
        Untrusted,
    }
    for damage in [
        CacheDamage::Missing,
        CacheDamage::Corrupt,
        CacheDamage::Untrusted,
    ] {
        let captured = CapturedEvents::default();
        let _subscriber =
            tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
        let (timeout, release) = timeout_action();
        let mut server = RawHttpTestServer::spawn(vec![
            RawHttpAction::Respond(catalog_response()),
            timeout,
            RawHttpAction::Respond(catalog_response()),
        ])
        .await;
        let refresh = Refresh::start(&mut server).await;
        // Only host filesystem interference can damage an already published
        // cache; no catalog API response can construct these conditions.
        match damage {
            CacheDamage::Missing => tokio::fs::remove_file(&refresh.cache_path).await.unwrap(),
            CacheDamage::Corrupt => tokio::fs::write(&refresh.cache_path, "{}").await.unwrap(),
            CacheDamage::Untrusted => {
                use std::os::unix::fs::PermissionsExt;
                tokio::fs::set_permissions(
                    &refresh.cache_path,
                    std::fs::Permissions::from_mode(0o666),
                )
                .await
                .unwrap();
            }
        }
        let (failure, _) = next_timeout(&mut server, &captured, release).await;
        assert_eq!(failure.level, Level::WARN, "{damage:?}: {failure:?}");
        assert_eq!(
            failure.fields["message"],
            if matches!(damage, CacheDamage::Missing) {
                "periodic builtin firewall catalog refresh failed; cache is missing"
            } else {
                "periodic builtin firewall catalog refresh failed; cache is unusable"
            }
        );
        // Successful publication must still repair the unusable cache.
        advance_interval(&captured).await;
        server.next_request("catalog repair").await;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !captured.entries().iter().any(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|message| message == "builtin firewall catalog cache refreshed")
        }) {
            assert!(
                std::time::Instant::now() < deadline,
                "cache repair did not finish"
            );
            tokio::task::yield_now().await;
        }
        let cache: BuiltinFirewallCatalogCache =
            serde_json::from_slice(&tokio::fs::read(&refresh.cache_path).await.unwrap()).unwrap();
        assert_eq!(cache.firewalls, catalog("github").firewalls);
        refresh.handle.shutdown().await;
        server.assert_finished().await;
    }
}

#[tokio::test]
async fn cancellation_after_send_timeout_does_not_fabricate_recovery() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let (timeout, release) = timeout_action();
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(catalog_response()),
        timeout,
        RawHttpAction::WaitForDisconnect,
    ])
    .await;
    let refresh = Refresh::start(&mut server).await;
    let original = tokio::fs::read(&refresh.cache_path).await.unwrap();
    assert_eq!(
        next_timeout(&mut server, &captured, release).await.0.level,
        Level::INFO
    );
    advance_interval(&captured).await;
    server
        .next_request("refresh cancelled before response")
        .await;
    refresh.handle.shutdown().await;
    server.assert_finished().await;
    assert!(!captured.entries().iter().any(|event| {
        event
            .fields
            .get("message")
            .is_some_and(|message| message.contains("builtin firewall catalog refresh"))
    }));
    assert_eq!(
        tokio::fs::read(&refresh.cache_path).await.unwrap(),
        original
    );
}
