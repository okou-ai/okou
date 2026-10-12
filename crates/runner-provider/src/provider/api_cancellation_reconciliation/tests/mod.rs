use super::*;
use crate::axiom_layer::{init_with_base_url, with_ingest_filter};
use crate::http::{HttpClient, HttpClientConfig};
use crate::run_cancellation::{RunCancellationRegistration, RunCancellationRegistry};
use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, read_http_request};
use httpmock::{HttpMockRequest, HttpMockResponse, MockServer};
use serde_json::Value;
use std::future::Future;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::Level;
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

const FAILURE: &str = "cancellation reconciliation read failed; will retry";
const DEGRADED: &str = "cancellation reconciliation reads degraded; will retry";
const RECOVERED: &str = "cancellation reconciliation read recovered";

struct Request {
    text: String,
    socket: TcpStream,
    at: Instant,
}

impl Request {
    fn run_id(&self) -> RunId {
        self.text
            .split_whitespace()
            .nth(1)
            .unwrap()
            .split('/')
            .nth(4)
            .unwrap()
            .parse()
            .unwrap()
    }

    async fn respond(mut self, status: &str, body: &str) {
        self.socket
            .write_all(
                format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len(),
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        self.socket.shutdown().await.unwrap();
    }

    async fn mode(self, run_id: RunId, mode: Option<&str>) {
        self.respond(
            "200 OK",
            &serde_json::json!({
                "protocolVersion": 1, "runId": run_id, "state": "present", "mode": mode,
            })
            .to_string(),
        )
        .await;
    }

    async fn disconnected(mut self) {
        let mut byte = [0];
        assert_eq!(bounded(self.socket.read(&mut byte)).await.unwrap(), 0);
    }
}

struct Server {
    url: String,
    requests: mpsc::Receiver<Request>,
    task: JoinHandle<()>,
}

impl Server {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (tx, requests) = mpsc::channel(128);
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let text = read_http_request(&mut socket).await.unwrap();
                if tx
                    .send(Request {
                        text,
                        socket,
                        at: Instant::now(),
                    })
                    .await
                    .is_err()
                {
                    return;
                }
            }
        });
        Self {
            url,
            requests,
            task,
        }
    }

    fn controller(&self) -> CancellationReconciliation {
        controller_for_url(self.url.clone())
    }

    async fn next(&mut self) -> Request {
        bounded(self.requests.recv()).await.unwrap()
    }
}

fn controller_for_url(api_url: String) -> CancellationReconciliation {
    CancellationReconciliation::new(
        HttpClient::new(HttpClientConfig {
            api_url,
            vercel_bypass: None,
            client_session_id: "cancellation-test".into(),
            runner_version: env!("CARGO_PKG_VERSION"),
        })
        .unwrap(),
        "test/group".into(),
        RunnerProcessIdentity::new(uuid::Uuid::from_u128(42), 7).unwrap(),
    )
}

fn events(captured: &CapturedEvents, message: &str) -> Vec<CapturedEvent> {
    captured
        .entries()
        .into_iter()
        .filter(|event| event.fields.get("message").map(String::as_str) == Some(message))
        .collect()
}

fn request_context() -> ApiRequestContext {
    ApiRequestContext {
        endpoint_label: "run cancellation reconciliation",
        method: "GET".into(),
        host: "api.example.test".into(),
        path: "/api/runners/runs/test/cancellation".into(),
        client_request_id: "request-test".into(),
        client_session_id: "session-test".into(),
        client_version: "runner-test".into(),
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Keep paused-clock HTTP tests driven by explicit advances. Polling this
/// bounded future also keeps Tokio from auto-advancing past pending socket I/O.
async fn bounded<T>(future: impl Future<Output = T>) -> T {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    tokio::pin!(future);
    loop {
        tokio::select! {
            biased;
            result = &mut future => return result,
            () = tokio::task::yield_now() => {
                assert!(std::time::Instant::now() < deadline, "observable operation timed out");
            }
        }
    }
}

async fn observe(
    controller: &CancellationReconciliation,
    registry: &RunCancellationRegistry,
    run_id: RunId,
) -> RunCancellationRegistration {
    let registration = registry.register(run_id).await.unwrap();
    assert!(controller.observe(run_id, registration.handle(), "sandbox-test-token".into()));
    registration
}

#[tokio::test]
async fn real_connection_reset_keeps_typed_safe_request_context() {
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::ResetConnection]).await;
    let controller = controller_for_url(server.url());
    let run_id = RunId::new_v4();

    let result = controller.client.read(run_id, "sandbox-test-token").await;
    let Err(ReadError::Transport(error)) = result else {
        panic!("expected a typed transport error, got {result:?}");
    };
    assert_eq!(error.failure_cause, ApiTransportCause::ConnectionReset);
    assert_eq!(
        error.request.endpoint_label,
        "run cancellation reconciliation"
    );
    assert_eq!(error.request.method, "GET");
    assert_eq!(
        error.request.path,
        format!("/api/runners/runs/{run_id}/cancellation")
    );
    assert!(!error.request.client_request_id.is_empty());
    assert_eq!(error.request.client_session_id, "cancellation-test");
    assert!(!error.request.client_version.is_empty());
    assert!(!format!("{error:?}").contains("sandbox-test-token"));

    server.assert_finished().await;
    controller.shutdown().await;
}

#[tokio::test]
async fn truncated_body_keeps_typed_cause_and_secret_free_diagnostics() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(
        b"HTTP/1.1 200 OK\r\nContent-Length: 256\r\nConnection: close\r\n\r\nprivate-response-body"
            .to_vec(),
    )])
    .await;
    let controller = controller_for_url(server.url());
    let run_id = RunId::new_v4();

    let result = controller.client.read(run_id, "sandbox-test-token").await;
    let Err(error @ ReadError::Body(cause)) = result else {
        panic!("expected a typed response-body error, got {result:?}");
    };
    assert_eq!(cause, ApiTransportCause::UnexpectedEof);

    let mut failures = ReadFailures::default();
    failures.record(run_id, &error);
    let events = events(&captured, FAILURE);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].level, Level::WARN);
    assert_eq!(events[0].fields["status"], "200");
    assert_eq!(events[0].fields["failure_stage"], "body");
    assert_eq!(events[0].fields["failure_kind"], "body");
    assert_eq!(events[0].fields["failure_cause"], "unexpected_eof");
    let diagnostic = format!("{:?}", captured.entries());
    assert!(!diagnostic.contains("private-response-body"));
    assert!(!diagnostic.contains("sandbox-test-token"));

    server.assert_finished().await;
    controller.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn transient_episode_warns_once_after_one_interval_and_reports_recovery() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let run_id = RunId::new_v4();
    let reset = ReadError::Transport(Box::new(ApiTransportError {
        request: request_context(),
        failure_kind: ApiFailureKind::Request,
        failure_cause: ApiTransportCause::ConnectionReset,
        summary: "connection reset without a URL or credential".into(),
    }));
    let mut failures = ReadFailures::default();

    failures.record(run_id, &reset);
    let first = events(&captured, FAILURE);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].level, Level::INFO);
    assert_eq!(first[0].fields["failure_kind"], "request");
    assert_eq!(first[0].fields["failure_cause"], "connection_reset");
    assert_eq!(first[0].fields["degraded"], "false");
    assert_eq!(first[0].fields["will_retry"], "true");

    tokio::time::advance(INTERVAL).await;
    failures.record(run_id, &reset);
    failures.record(run_id, &reset);
    let degraded = events(&captured, DEGRADED);
    assert_eq!(degraded.len(), 1);
    assert_eq!(degraded[0].level, Level::WARN);
    assert_eq!(degraded[0].fields["consecutive_failures"], "2");
    assert_eq!(degraded[0].fields["failure_elapsed_ms"], "30000");
    assert_eq!(degraded[0].fields["degraded"], "true");

    failures.recover(run_id);
    let recovered = events(&captured, RECOVERED);
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].level, Level::INFO);
    assert_eq!(recovered[0].fields["recovered_after_failures"], "3");
    assert_eq!(recovered[0].fields["was_degraded"], "true");
    let debug = format!("{:?}", captured.entries());
    assert!(!debug.contains("sandbox-test-token"));
    assert!(!debug.contains("connection reset without a URL or credential"));
}

#[tokio::test]
async fn genuine_failure_is_the_only_axiom_ingested_event_in_an_episode() {
    let axiom = MockServer::start_async().await;
    let ingested = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sink = Arc::clone(&ingested);
    let ingest = axiom
        .mock_async(move |when, then| {
            when.method(httpmock::Method::POST)
                .path("/v1/datasets/vm0-web-logs-test/ingest");
            then.respond_with(move |request: &HttpMockRequest| {
                let batch: Vec<Value> = serde_json::from_slice(request.body_ref()).unwrap();
                sink.lock().unwrap().extend(batch);
                HttpMockResponse::builder().status(200).build()
            });
        })
        .await;
    let (layer, guard) = init_with_base_url(&axiom.base_url(), "test", "test").unwrap();
    let captured = CapturedEvents::default();
    let _subscriber = tracing::subscriber::set_default(
        tracing_subscriber::registry()
            .with(captured.clone())
            .with(with_ingest_filter(layer)),
    );
    let run_id = RunId::new_v4();
    let mut failures = ReadFailures::default();

    failures.record(run_id, &ReadError::Deadline(Box::new(request_context())));
    failures.record(run_id, &ReadError::Status(StatusCode::SERVICE_UNAVAILABLE));
    failures.record(run_id, &ReadError::Status(StatusCode::BAD_GATEWAY));
    guard.shutdown().await;

    assert_eq!(events(&captured, FAILURE).len(), 2);
    assert_eq!(events(&captured, DEGRADED).len(), 0);
    assert!(ingest.calls_async().await > 0);
    let ingested = ingested.lock().unwrap();
    assert_eq!(ingested.len(), 1);
    assert_eq!(ingested[0]["message"], FAILURE);
    assert_eq!(ingested[0]["level"], "warn");
    assert_eq!(ingested[0]["status"], 503);
    assert_eq!(ingested[0]["failure_stage"], "status");
    assert_eq!(ingested[0]["consecutive_failures"], 2);
}

#[tokio::test]
async fn retirement_does_not_claim_recovery_after_a_real_reset() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::ResetConnection]).await;
    let controller = controller_for_url(server.url());
    let registry = RunCancellationRegistry::new();
    let run_id = RunId::new_v4();
    let registration = observe(&controller, &registry, run_id).await;

    server
        .next_request("cancellation reconciliation read")
        .await;
    server.assert_finished().await;
    bounded(async {
        while events(&captured, FAILURE).is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert!(registration.unregister().await);
    controller.shutdown().await;

    assert_eq!(events(&captured, FAILURE).len(), 1);
    assert!(events(&captured, RECOVERED).is_empty());
}

#[tokio::test(start_paused = true)]
async fn real_reset_then_present_null_reports_local_recovery_without_cancellation() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let run_id = RunId::new_v4();
    let response = serde_json::json!({
        "protocolVersion": 1,
        "runId": run_id,
        "state": "present",
        "mode": null,
    })
    .to_string();
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::ResetConnection,
        RawHttpAction::Respond(crate::test_fixtures::raw_http::json_response(
            "200 OK", &response,
        )),
    ])
    .await;
    let controller = controller_for_url(server.url());
    let registry = RunCancellationRegistry::new();
    let registration = observe(&controller, &registry, run_id).await;

    server
        .next_request("initial cancellation reconciliation read")
        .await;
    bounded(async {
        while events(&captured, FAILURE).is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await;
    tokio::time::advance(INTERVAL).await;
    server
        .next_request("cancellation reconciliation retry")
        .await;
    bounded(async {
        while events(&captured, RECOVERED).is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await;

    assert!(!registration.is_cancelled());
    assert!(registration.unregister().await);
    controller.shutdown().await;
    server.assert_finished().await;

    let failures = events(&captured, FAILURE);
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].level, Level::INFO);
    assert_eq!(failures[0].fields["failure_cause"], "connection_reset");
    assert!(events(&captured, DEGRADED).is_empty());
    let recoveries = events(&captured, RECOVERED);
    assert_eq!(recoveries.len(), 1);
    assert_eq!(recoveries[0].level, Level::INFO);
    assert_eq!(recoveries[0].fields["recovered_after_failures"], "1");
    assert_eq!(recoveries[0].fields["was_degraded"], "false");
}

#[tokio::test]
async fn authenticated_read_accepts_only_explicit_complete_matching_v1_results() {
    let mut server = Server::new().await;
    let controller = server.controller();
    let run_id = RunId::new_v4();
    let expected = run_id.to_string();
    let cases = [
        (
            serde_json::json!({"protocolVersion":1,"runId":run_id,"state":"present","mode":"cooperative"}),
            Ok(Some(Mode::Cooperative)),
        ),
        (
            serde_json::json!({"protocolVersion":1,"runId":run_id,"state":"present","mode":"hard"}),
            Ok(Some(Mode::Hard)),
        ),
        (
            serde_json::json!({"protocolVersion":1,"runId":run_id,"state":"gone"}),
            Ok(Some(Mode::Hard)),
        ),
        (
            serde_json::json!({"protocolVersion":1,"runId":run_id,"state":"present","mode":null}),
            Ok(None),
        ),
        (
            serde_json::json!({"protocolVersion":1,"runId":run_id,"state":"unavailable"}),
            Ok(None),
        ),
        (
            serde_json::json!({"protocolVersion":2,"runId":run_id,"state":"gone"}),
            Err(ReadError::Identity),
        ),
        (
            serde_json::json!({"protocolVersion":1,"runId":RunId::new_v4(),"state":"gone"}),
            Err(ReadError::Identity),
        ),
        (
            serde_json::json!({"protocolVersion":1,"runId":run_id,"state":"present"}),
            Err(ReadError::Contract),
        ),
        (
            serde_json::json!({"protocolVersion":1,"runId":run_id,"state":"present","mode":"timeout"}),
            Err(ReadError::Contract),
        ),
        (
            serde_json::json!({"protocolVersion":1,"runId":run_id,"state":"deleted"}),
            Err(ReadError::Contract),
        ),
        (
            serde_json::json!({"protocolVersion":1,"runId":run_id,"state":"gone","mode":"hard"}),
            Err(ReadError::Contract),
        ),
        (
            serde_json::json!({"protocolVersion":1,"runId":run_id,"state":"gone","extra":true}),
            Err(ReadError::Contract),
        ),
    ];
    for (body, expected_result) in cases {
        let client = controller.client.clone();
        let read = tokio::spawn(async move { client.read(run_id, "sandbox-test-token").await });
        let request = server.next().await;
        assert!(
            request
                .text
                .starts_with(&format!("GET /api/runners/runs/{expected}/cancellation?"))
        );
        assert!(request.text.contains("runnerGroup=test%2Fgroup"));
        assert!(
            request
                .text
                .contains("runnerId=00000000-0000-0000-0000-00000000002a")
        );
        assert!(request.text.contains("heartbeatGeneration=7"));
        assert!(
            request
                .text
                .contains("authorization: Bearer sandbox-test-token")
        );
        request.respond("200 OK", &body.to_string()).await;
        assert_eq!(read.await.unwrap(), expected_result);
    }
    for status in [
        "401 Unauthorized",
        "403 Forbidden",
        "404 Not Found",
        "429 Too Many Requests",
        "500 Internal Server Error",
        "503 Service Unavailable",
    ] {
        let client = controller.client.clone();
        let read = tokio::spawn(async move { client.read(run_id, "sandbox-test-token").await });
        server
            .next()
            .await
            .respond(
                status,
                &serde_json::json!({
                    "protocolVersion":1,"runId":run_id,"state":"gone"
                })
                .to_string(),
            )
            .await;
        assert!(matches!(read.await.unwrap(), Err(ReadError::Status(_))));
    }
    for body in ["not json".into(), "x".repeat(MAX_RESPONSE_BYTES + 1)] {
        let client = controller.client.clone();
        let read = tokio::spawn(async move { client.read(run_id, "sandbox-test-token").await });
        server.next().await.respond("200 OK", &body).await;
        assert!(read.await.unwrap().is_err());
    }
    controller.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn cooperative_keeps_observing_and_dispatch_cadence_excludes_response_time() {
    let mut server = Server::new().await;
    let controller = server.controller();
    let registry = RunCancellationRegistry::new();
    let run_id = RunId::new_v4();
    let registration = observe(&controller, &registry, run_id).await;
    let first = server.next().await;
    let initial_dispatch = first.at;
    tokio::time::advance(Duration::from_secs(9)).await;
    first.mode(run_id, Some("cooperative")).await;
    bounded(
        registration
            .handle()
            .signals()
            .cooperative_user()
            .cancelled(),
    )
    .await;
    assert!(!registration.handle().is_hard_cancelled());
    tokio::time::advance(Duration::from_secs(21)).await;
    let second = server.next().await;
    assert_eq!(second.at - initial_dispatch, INTERVAL);
    second.mode(run_id, Some("hard")).await;
    bounded(registration.handle().signals().hard().cancelled()).await;
    assert!(registration.unregister().await);
    controller.shutdown().await;
    assert!(controller.tasks.is_empty());
}

#[tokio::test(start_paused = true)]
async fn old_api_and_invalid_results_recover_on_normal_ticks_without_stopping() {
    let mut server = Server::new().await;
    let controller = server.controller();
    let registry = RunCancellationRegistry::new();
    let run_id = RunId::new_v4();
    let registration = observe(&controller, &registry, run_id).await;
    let mut request = server.next().await;
    let mut dispatched = request.at;
    for (status, body) in [
        ("404 Not Found", "missing endpoint".to_string()),
        ("401 Unauthorized", "expired credential".to_string()),
        (
            "200 OK",
            serde_json::json!({"protocolVersion":1,"runId":run_id,"state":"present","mode":null})
                .to_string(),
        ),
        (
            "200 OK",
            serde_json::json!({"protocolVersion":1,"runId":run_id,"state":"unavailable"})
                .to_string(),
        ),
        (
            "200 OK",
            serde_json::json!({"protocolVersion":2,"runId":run_id,"state":"gone"}).to_string(),
        ),
        ("200 OK", "malformed".to_string()),
    ] {
        request.respond(status, &body).await;
        tokio::time::advance(INTERVAL).await;
        request = server.next().await;
        assert_eq!(request.at - dispatched, INTERVAL);
        dispatched = request.at;
        assert!(!registration.is_cancelled());
    }
    request
        .respond(
            "200 OK",
            &serde_json::json!({"protocolVersion":1,"runId":run_id,"state":"gone"}).to_string(),
        )
        .await;
    bounded(registration.handle().signals().hard().cancelled()).await;
    registration.unregister().await;
    controller.shutdown().await;
}

#[tokio::test]
async fn retirement_joins_an_inflight_read_and_cannot_target_replacement() {
    let mut server = Server::new().await;
    let controller = server.controller();
    let registry = RunCancellationRegistry::new();
    let run_id = RunId::new_v4();
    let old = observe(&controller, &registry, run_id).await;
    let request = server.next().await;
    assert!(bounded(old.unregister()).await);
    request.disconnected().await;
    let successor = registry.register(run_id).await.unwrap();
    assert!(!controller.observe(run_id, old.handle(), "stale-token".into()));
    assert!(
        !old.handle()
            .request_reconciled_cancellation(Mode::Hard)
            .await
    );
    assert!(!successor.is_cancelled());
    assert!(!old.unregister().await);
    assert!(registry.contains(run_id).await);
    successor.unregister().await;
    controller.shutdown().await;
    assert!(controller.tasks.is_empty());
}

#[tokio::test(start_paused = true)]
async fn blocked_gate_does_not_hold_http_capacity_and_hard_coalesces() {
    let mut server = Server::new().await;
    let controller = server.controller();
    let registry = RunCancellationRegistry::new();
    let blocked_id = RunId::new_v4();
    let blocked = registry.register(blocked_id).await.unwrap();
    let gate = blocked.handle().transfer_guard().await;
    assert!(controller.observe(blocked_id, blocked.handle(), "blocked-token".into()));
    server
        .next()
        .await
        .mode(blocked_id, Some("cooperative"))
        .await;
    let control_id = RunId::new_v4();
    let control = observe(&controller, &registry, control_id).await;
    server.next().await.mode(control_id, Some("hard")).await;
    bounded(control.handle().signals().hard().cancelled()).await;
    assert!(!blocked.is_cancelled());
    tokio::time::advance(INTERVAL).await;
    for _ in 0..2 {
        let request = server.next().await;
        let id = if request.text.contains(&blocked_id.to_string()) {
            blocked_id
        } else {
            control_id
        };
        request.mode(id, Some("hard")).await;
    }
    // A third Run's applied result synchronizes progress while the first gate
    // remains held; no observer has to await its delivery to issue other reads.
    let third_id = RunId::new_v4();
    let third = observe(&controller, &registry, third_id).await;
    server.next().await.mode(third_id, Some("hard")).await;
    bounded(third.handle().signals().hard().cancelled()).await;
    drop(gate);
    bounded(blocked.handle().signals().hard().cancelled()).await;
    assert!(!blocked.handle().signals().cooperative_user().is_cancelled());
    for registration in [&blocked, &control, &third] {
        registration.unregister().await;
    }
    controller.shutdown().await;
}

#[tokio::test]
async fn retirement_and_shutdown_cancel_gate_waits_without_acquiring_the_gate() {
    let mut server = Server::new().await;
    let controller = server.controller();
    let registry = RunCancellationRegistry::new();
    let run_id = RunId::new_v4();
    let registration = registry.register(run_id).await.unwrap();
    let gate = registration.handle().transfer_guard().await;
    assert!(controller.observe(run_id, registration.handle(), "sandbox-test-token".into()));
    server.next().await.mode(run_id, Some("hard")).await;
    bounded(registration.unregister()).await;
    bounded(controller.shutdown()).await;
    assert!(controller.tasks.is_empty());
    assert!(!registration.is_cancelled());
    assert!(!controller.observe(run_id, RunCancellationHandle::new(), "late-token".into()));
    drop(gate);
}

#[tokio::test]
async fn dropping_provider_owner_cancels_reads_and_releases_tracked_credentials() {
    let mut server = Server::new().await;
    let controller = server.controller();
    let registry = RunCancellationRegistry::new();
    let registration = observe(&controller, &registry, RunId::new_v4()).await;
    let request = server.next().await;
    let tasks = controller.tasks.clone();
    drop(controller);
    bounded(tasks.wait()).await;
    request.disconnected().await;
    registration.unregister().await;
    assert!(tasks.is_empty());
}

#[tokio::test(start_paused = true)]
async fn whole_body_deadline_releases_capacity_without_an_immediate_retry() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let mut server = Server::new().await;
    let controller = server.controller();
    let registry = RunCancellationRegistry::new();
    let run_id = RunId::new_v4();
    let registration = observe(&controller, &registry, run_id).await;
    let mut request = server.next().await;
    let dispatched = request.at;
    request
        .socket
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 200\r\n\r\n{\"state\":")
        .await
        .unwrap();
    tokio::time::advance(REQUEST_DEADLINE).await;
    request.disconnected().await;
    assert!(!registration.is_cancelled());
    assert_eq!(controller.permits.available_permits(), MAX_CONCURRENT_READS);
    tokio::time::advance(INTERVAL - REQUEST_DEADLINE).await;
    let retry = server.next().await;
    assert_eq!(retry.at - dispatched, INTERVAL);
    retry.mode(run_id, Some("hard")).await;
    bounded(registration.handle().signals().hard().cancelled()).await;
    registration.unregister().await;
    controller.shutdown().await;

    let entries = captured.entries();
    let failures: Vec<_> = entries
        .iter()
        .enumerate()
        .filter(|(_, event)| event.fields.get("message").map(String::as_str) == Some(FAILURE))
        .collect();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].1.level, Level::INFO);
    assert_eq!(failures[0].1.fields["failure_stage"], "deadline");
    assert_eq!(failures[0].1.fields["failure_kind"], "timeout");
    assert_eq!(failures[0].1.fields["failure_cause"], "timeout");
    let recoveries: Vec<_> = entries
        .iter()
        .enumerate()
        .filter(|(_, event)| event.fields.get("message").map(String::as_str) == Some(RECOVERED))
        .collect();
    assert_eq!(recoveries.len(), 1);
    let observed = entries
        .iter()
        .position(|event| {
            event.fields.get("message").map(String::as_str)
                == Some("cancellation reconciliation observed stop intent")
        })
        .unwrap();
    assert!(failures[0].0 < recoveries[0].0);
    assert!(recoveries[0].0 < observed);
}

#[tokio::test]
async fn chunked_body_bound_is_enforced_without_content_length() {
    let mut server = Server::new().await;
    let controller = server.controller();
    let run_id = RunId::new_v4();
    let client = controller.client.clone();
    let read = tokio::spawn(async move { client.read(run_id, "sandbox-test-token").await });
    let mut request = server.next().await;
    let body = "x".repeat(MAX_RESPONSE_BYTES + 1);
    request
        .socket
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n",
                body.len(),
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    assert_eq!(bounded(read).await.unwrap(), Err(ReadError::Oversized));
    controller.shutdown().await;
}

#[tokio::test]
async fn redirected_response_cannot_authorize_disappearance() {
    let mut server = Server::new().await;
    let mut redirect = Server::new().await;
    let controller = server.controller();
    let run_id = RunId::new_v4();
    let client = controller.client.clone();
    let read = tokio::spawn(async move { client.read(run_id, "sandbox-test-token").await });
    let mut request = server.next().await;
    request.socket.write_all(format!(
        "HTTP/1.1 302 Found\r\nLocation: {}/other\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        redirect.url,
    ).as_bytes()).await.unwrap();
    request.socket.shutdown().await.unwrap();
    redirect
        .next()
        .await
        .respond(
            "200 OK",
            &serde_json::json!({
                "protocolVersion": 1, "runId": run_id, "state": "gone",
            })
            .to_string(),
        )
        .await;
    assert_eq!(bounded(read).await.unwrap(), Err(ReadError::Redirect));
    controller.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn eight_reads_bound_capacity_fifo_and_observation_under_continuous_arrivals() {
    let mut server = Server::new().await;
    let controller = server.controller();
    let registry = RunCancellationRegistry::new();
    let mut registrations = Vec::new();
    let mut held = Vec::new();
    for _ in 0..MAX_CONCURRENT_READS {
        let run_id = RunId::new_v4();
        registrations.push((run_id, observe(&controller, &registry, run_id).await));
        held.push(server.next().await);
    }
    let started = Instant::now();
    assert_eq!(controller.permits.available_permits(), 0);

    // Poll these real read futures once while all permits are held. This
    // establishes FIFO queue position explicitly instead of hoping spawned
    // tasks happened to run before the next arrival.
    let mut queued = Vec::new();
    let mut intents = Vec::new();
    let mut ids = Vec::new();
    for _ in 0..24 {
        let id = RunId::new_v4();
        let (intent, pending) = watch::channel(None);
        intents.push(pending);
        ids.push(id);
        let mut reader = Box::pin(read_loop(
            controller.client.clone(),
            controller.permits.clone(),
            id,
            "queued-token".into(),
            intent,
        ));
        assert!(futures_util::poll!(&mut reader).is_pending());
        // sleep_until(now) may first yield once; explicitly poll again to
        // enqueue the acquisition before advancing the clock.
        assert!(futures_util::poll!(&mut reader).is_pending());
        queued.push(reader);
    }
    let reader_tasks = TaskTracker::new();
    let stop = CancellationToken::new();
    for reader in queued {
        let cancel = stop.clone();
        reader_tasks.spawn(async move {
            tokio::select! { () = cancel.cancelled() => {}, () = reader => {} }
        });
    }
    reader_tasks.close();

    // Each healthy response takes nine seconds. New arrivals join behind
    // already-due work, while old observers also become due again at t=30.
    let mut next_id = 0;
    for batch in 0..3 {
        tokio::time::advance(Duration::from_secs(9)).await;
        for request in held.drain(..) {
            let id = request.run_id();
            request.mode(id, Some("hard")).await;
        }
        let expected: std::collections::HashSet<_> = ids
            .iter()
            .skip(next_id)
            .take(MAX_CONCURRENT_READS)
            .copied()
            .collect();
        let mut received = std::collections::HashSet::new();
        for _ in 0..MAX_CONCURRENT_READS {
            let request = server.next().await;
            received.insert(request.run_id());
            next_id += 1;
            held.push(request);
        }
        assert_eq!(
            received, expected,
            "already-queued batch {batch} precedes later arrivals"
        );
        let newcomer = RunId::new_v4();
        registrations.push((newcomer, observe(&controller, &registry, newcomer).await));
        assert_eq!(controller.permits.available_permits(), 0);
    }
    tokio::time::advance(Duration::from_secs(9)).await;
    for request in held.drain(..) {
        let id = request.run_id();
        request.mode(id, Some("hard")).await;
    }
    for pending in &mut intents {
        bounded(pending.wait_for(|mode| *mode == Some(Mode::Hard)))
            .await
            .unwrap();
    }
    // All original 32 observers saw their explicit stop inside the conservative
    // 30 + ceil(N/8)*10 bound, including occupancy and three later arrivals.
    let peak = 32_usize + 3;
    let bound = INTERVAL + REQUEST_DEADLINE * peak.div_ceil(MAX_CONCURRENT_READS) as u32;
    assert!(Instant::now() - started <= bound);
    stop.cancel();
    bounded(reader_tasks.wait()).await;
    bounded(controller.shutdown()).await;
    for (_, registration) in registrations {
        registration.unregister().await;
    }
    assert_eq!(controller.permits.available_permits(), MAX_CONCURRENT_READS);
    assert!(controller.tasks.is_empty());
}
