use super::*;
use crate::http::HttpClientConfig;
use crate::run_cancellation::{RunCancellationRegistration, RunCancellationRegistry};
use crate::test_fixtures::raw_http::read_http_request;
use std::future::Future;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

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
        CancellationReconciliation::new(
            HttpClient::new(HttpClientConfig {
                api_url: self.url.clone(),
                vercel_bypass: None,
                client_session_id: "cancellation-test".into(),
            })
            .unwrap(),
            "test/group".into(),
            RunnerProcessIdentity::new(uuid::Uuid::from_u128(42), 7).unwrap(),
        )
    }

    async fn next(&mut self) -> Request {
        bounded(self.requests.recv()).await.unwrap()
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
