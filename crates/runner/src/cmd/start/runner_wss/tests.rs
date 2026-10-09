use super::*;
use std::collections::HashSet;
use std::sync::Mutex;

use futures_util::{SinkExt, StreamExt};
use runner_lifecycle::active_runs::ActiveRunGuard;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio_tungstenite::tungstenite::protocol::Message;

struct MockTickets {
    run: RunId,
    seen: Mutex<HashSet<String>>,
}

#[async_trait]
impl TicketConsumer for MockTickets {
    async fn consume(&self, run_id: RunId, runner_id: Uuid, origin: &str, ticket: &str) -> bool {
        if run_id != self.run || runner_id.is_nil() || origin != "wss://runner.okou.ai:443" {
            return false;
        }
        self.seen.lock().unwrap().insert(ticket.to_owned())
    }
}

struct HeldTickets {
    started: tokio::sync::Notify,
    resume: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
}

#[async_trait]
impl TicketConsumer for HeldTickets {
    async fn consume(
        &self,
        _run_id: RunId,
        _runner_id: Uuid,
        _origin: &str,
        _ticket: &str,
    ) -> bool {
        let resume = self.resume.lock().unwrap().take().unwrap();
        self.started.notify_one();
        resume.await.is_ok()
    }
}

struct EchoGuest {
    run: RunId,
    sandbox: SandboxId,
}

#[async_trait]
impl GuestAttach for EchoGuest {
    async fn attach(
        &self,
        run: RunId,
        sandbox: SandboxId,
        max_queue_frames: usize,
    ) -> Option<GuestConnection> {
        if run != self.run || sandbox != self.sandbox || max_queue_frames != MAX_QUEUE_FRAMES {
            return None;
        }
        let (incoming, mut to_guest) = mpsc::channel(max_queue_frames);
        let (from_guest, outgoing) = mpsc::channel(max_queue_frames);
        tokio::spawn(async move {
            while let Some(frame) = to_guest.recv().await {
                if from_guest.send(frame).await.is_err() {
                    break;
                }
            }
        });
        Some(GuestConnection { incoming, outgoing })
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    runner: Uuid,
    run: RunId,
    sandbox: SandboxId,
    guard: ActiveRunGuard,
    ctx: ConnectionContext,
}

impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let runner = Uuid::new_v4();
        let run = RunId::new_v4();
        let sandbox = SandboxId::new_v4();
        let active_runs = ActiveRuns::new(Arc::new(tokio::sync::Notify::new()));
        let guard = active_runs.register(run, None, "test".to_owned());
        let status = Arc::new(StatusTracker::new(dir.path().join("status"), 1, None, None));
        status.add_run(run, sandbox).await.unwrap();
        let ctx = ConnectionContext {
            runner_id: runner,
            origin: canonical_origin("runner.okou.ai"),
            consumer: Arc::new(MockTickets {
                run,
                seen: Mutex::new(HashSet::new()),
            }),
            guest: Arc::new(EchoGuest { run, sandbox }),
            active_runs,
            status,
        };
        Self {
            dir,
            runner,
            run,
            sandbox,
            guard,
            ctx,
        }
    }

    async fn connect(
        &self,
        path: &str,
    ) -> (
        Result<
            tokio_tungstenite::WebSocketStream<UnixStream>,
            tokio_tungstenite::tungstenite::Error,
        >,
        tokio::task::JoinHandle<()>,
    ) {
        let socket = self.dir.path().join(format!("{}.sock", Uuid::new_v4()));
        let listener = UnixListener::bind(&socket).unwrap();
        let ctx = ConnectionContext {
            runner_id: self.ctx.runner_id,
            origin: self.ctx.origin.clone(),
            consumer: Arc::clone(&self.ctx.consumer),
            guest: Arc::clone(&self.ctx.guest),
            active_runs: self.ctx.active_runs.clone(),
            status: Arc::clone(&self.ctx.status),
        };
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let permit = Arc::new(Semaphore::new(1)).acquire_owned().await.unwrap();
            handle(stream, ctx, permit).await;
        });
        let stream = UnixStream::connect(&socket).await.unwrap();
        let request = format!("ws://localhost{path}");
        let client = tokio_tungstenite::client_async(request, stream)
            .await
            .map(|(ws, _)| ws);
        (client, task)
    }
}

fn first(run: RunId, ticket: &str) -> Message {
    Message::Text(
        serde_json::json!({"runId": run, "ticket": ticket})
            .to_string()
            .into(),
    )
}

async fn denied(ws: &mut tokio_tungstenite::WebSocketStream<UnixStream>) {
    let result = tokio::time::timeout(Duration::from_secs(2), ws.next())
        .await
        .expect("denied connection must close promptly");
    assert!(
        matches!(result, None | Some(Err(_)) | Some(Ok(Message::Close(_)))),
        "no auth.ok or Guest payload on failed admission: {result:?}"
    );
}

#[tokio::test]
async fn admission_echo_replay_cross_run_and_local_run_end() {
    let fixture = Fixture::new().await;
    let path = format!("/ws/{}", fixture.runner);
    let ticket = "A".repeat(43);
    let (client, task) = fixture.connect(&path).await;
    let mut ws = client.unwrap();
    ws.send(first(fixture.run, &ticket)).await.unwrap();
    assert_eq!(
        ws.next().await.unwrap().unwrap().into_text().unwrap(),
        r#"{"type":"auth.ok"}"#
    );
    ws.send(Message::Ping(vec![9].into())).await.unwrap();
    assert!(matches!(
        ws.next().await.unwrap().unwrap(),
        Message::Pong(_)
    ));
    ws.send(Message::Binary(vec![1, 2, 3].into()))
        .await
        .unwrap();
    assert_eq!(ws.next().await.unwrap().unwrap().into_data(), vec![1, 2, 3]);

    let (client, replay) = fixture.connect(&path).await;
    let mut duplicate = client.unwrap();
    duplicate.send(first(fixture.run, &ticket)).await.unwrap();
    denied(&mut duplicate).await;
    replay.await.unwrap();

    let (client, cross_run) = fixture.connect(&path).await;
    let mut wrong = client.unwrap();
    wrong
        .send(first(RunId::new_v4(), &"B".repeat(43)))
        .await
        .unwrap();
    denied(&mut wrong).await;
    cross_run.await.unwrap();
    drop(fixture.guard);
    assert!(
        tokio::time::timeout(Duration::from_secs(2), ws.next())
            .await
            .is_ok()
    );
    task.await.unwrap();
}

#[tokio::test]
async fn authenticated_peer_close_receives_a_graceful_ack() {
    let fixture = Fixture::new().await;
    let (client, task) = fixture.connect(&format!("/ws/{}", fixture.runner)).await;
    let mut ws = client.unwrap();
    ws.send(first(fixture.run, &"A".repeat(43))).await.unwrap();
    assert_eq!(
        ws.next().await.unwrap().unwrap().into_text().unwrap(),
        r#"{"type":"auth.ok"}"#
    );
    ws.close(None).await.unwrap();
    let response = tokio::time::timeout(Duration::from_secs(2), ws.next())
        .await
        .expect("normal peer close must receive its acknowledgement");
    assert!(
        matches!(response, Some(Ok(Message::Close(_)))),
        "normal close must be acknowledged: {response:?}"
    );
    task.await.unwrap();
}

#[tokio::test]
async fn run_release_during_ticket_consume_denies_auth() {
    let mut fixture = Fixture::new().await;
    let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
    let tickets = Arc::new(HeldTickets {
        started: tokio::sync::Notify::new(),
        resume: Mutex::new(Some(resume_rx)),
    });
    fixture.ctx.consumer = tickets.clone();
    let (client, task) = fixture.connect(&format!("/ws/{}", fixture.runner)).await;
    let mut ws = client.unwrap();
    ws.send(first(fixture.run, &"A".repeat(43))).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), tickets.started.notified())
        .await
        .expect("ticket consumption must start");
    drop(fixture.guard);
    resume_tx.send(()).unwrap();
    denied(&mut ws).await;
    task.await.unwrap();
}

#[tokio::test]
async fn sandbox_reassignment_during_ticket_consume_denies_auth() {
    let mut fixture = Fixture::new().await;
    let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
    let tickets = Arc::new(HeldTickets {
        started: tokio::sync::Notify::new(),
        resume: Mutex::new(Some(resume_rx)),
    });
    fixture.ctx.consumer = tickets.clone();
    let (client, task) = fixture.connect(&format!("/ws/{}", fixture.runner)).await;
    let mut ws = client.unwrap();
    ws.send(first(fixture.run, &"A".repeat(43))).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), tickets.started.notified())
        .await
        .expect("ticket consumption must start");
    fixture
        .ctx
        .status
        .remove_run_if_matching(fixture.run, fixture.sandbox)
        .await
        .unwrap();
    fixture
        .ctx
        .status
        .add_run(fixture.run, SandboxId::new_v4())
        .await
        .unwrap();
    resume_tx.send(()).unwrap();
    denied(&mut ws).await;
    task.await.unwrap();
}

#[tokio::test]
async fn rejects_wrong_path_malformed_handshake_and_bad_frames() {
    let fixture = Fixture::new().await;
    let (result, task) = fixture
        .connect(&format!("/ws/{}?ticket=wrong", fixture.runner))
        .await;
    assert!(result.is_err());
    task.await.unwrap();
    let (result, task) = fixture.connect("/ws/not-the-runner").await;
    assert!(result.is_err());
    task.await.unwrap();

    let path = format!("/ws/{}", fixture.runner);
    let (client, task) = fixture.connect(&path).await;
    let mut ws = client.unwrap();
    ws.send(Message::Binary(vec![1; 200].into())).await.unwrap();
    denied(&mut ws).await;
    task.await.unwrap();

    let (client, task) = fixture.connect(&path).await;
    let mut ws = client.unwrap();
    ws.send(first(fixture.run, "short")).await.unwrap();
    denied(&mut ws).await;
    task.await.unwrap();

    let (client, task) = fixture.connect(&path).await;
    let mut ws = client.unwrap();
    ws.send(Message::Text("x".repeat(MAX_FRAME + 1).into()))
        .await
        .unwrap();
    denied(&mut ws).await;
    task.await.unwrap();

    let socket = fixture.dir.path().join("ordinary.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let ctx = fixture.ctx;
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let permit = Arc::new(Semaphore::new(1)).acquire_owned().await.unwrap();
        handle(stream, ctx, permit).await;
    });
    let mut stream = UnixStream::connect(&socket).await.unwrap();
    stream
        .write_all(b"GET /ws/nope HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await
        .unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    assert!(!response.windows(3).any(|w| w == b"101"));
    task.await.unwrap();
}

#[tokio::test]
async fn absent_local_run_does_not_redeem_ticket() {
    let fixture = Fixture::new().await;
    fixture
        .ctx
        .status
        .remove_run_if_matching(fixture.run, fixture.sandbox)
        .await
        .unwrap();
    let (client, task) = fixture.connect(&format!("/ws/{}", fixture.runner)).await;
    let mut ws = client.unwrap();
    ws.send(first(fixture.run, &"A".repeat(43))).await.unwrap();
    denied(&mut ws).await;
    task.await.unwrap();
    assert!(
        fixture
            .ctx
            .consumer
            .consume(
                fixture.run,
                fixture.runner,
                "wss://runner.okou.ai:443",
                &"A".repeat(43)
            )
            .await
    );

    assert!(canonical_origin("localhost").is_none());
    assert!(canonical_origin("example.test").is_none());
    assert!(canonical_origin("127.1").is_none());
    assert!(canonical_origin("127.0.0.1").is_none());
}

#[tokio::test]
async fn unavailable_production_guest_rejects_before_consuming_ticket() {
    let mut fixture = Fixture::new().await;
    fixture.ctx.guest = Arc::new(UnavailableGuest);
    let ticket = "A".repeat(43);
    let (client, task) = fixture.connect(&format!("/ws/{}", fixture.runner)).await;
    let mut ws = client.unwrap();
    ws.send(first(fixture.run, &ticket)).await.unwrap();
    denied(&mut ws).await;
    task.await.unwrap();

    // The currently inert production adapter must not spend a one-use ticket.
    assert!(
        fixture
            .ctx
            .consumer
            .consume(
                fixture.run,
                fixture.runner,
                "wss://runner.okou.ai:443",
                &ticket
            )
            .await
    );
}

#[tokio::test]
async fn api_consumer_rejects_outage_and_wrong_audience() {
    let http = HttpClient::new(runner_provider::http::HttpClientConfig {
        api_url: "http://127.0.0.1:1".to_owned(),
        vercel_bypass: None,
        client_session_id: "wss-test".to_owned(),
        runner_version: env!("CARGO_PKG_VERSION"),
    })
    .unwrap();
    let consumer = ApiTicketConsumer::new(http, "test-official-token".to_owned());
    assert!(
        !consumer
            .consume(
                RunId::new_v4(),
                Uuid::new_v4(),
                "wss://runner.okou.ai:443",
                &"A".repeat(43)
            )
            .await
    );
}

#[tokio::test]
async fn consume_uses_official_credential_and_checks_complete_api_result() {
    use httpmock::prelude::*;
    let server = MockServer::start_async().await;
    let run = RunId::new_v4();
    let runner = Uuid::new_v4();
    let ticket = "A".repeat(43);
    let origin = "wss://runner.okou.ai:443";
    let http = HttpClient::new(runner_provider::http::HttpClientConfig {
        api_url: server.base_url(),
        vercel_bypass: None,
        client_session_id: "wss-test".to_owned(),
        runner_version: env!("CARGO_PKG_VERSION"),
    })
    .unwrap();
    let consumer = ApiTicketConsumer::new(http, "official-test-token".to_owned());
    let matching = serde_json::json!({
        "runId": run, "runnerId": runner, "origin": origin,
        "orgId": "org", "userId": "user"
    });
    for (label, change) in [
        ("matching", None),
        (
            "wrong run",
            Some(("runId", serde_json::json!(RunId::new_v4()))),
        ),
        (
            "wrong runner",
            Some(("runnerId", serde_json::json!(Uuid::new_v4()))),
        ),
        (
            "wrong origin",
            Some(("origin", serde_json::json!("wss://another.okou.ai:443"))),
        ),
        ("empty org", Some(("orgId", serde_json::json!("")))),
        ("empty user", Some(("userId", serde_json::json!("")))),
        ("invalid user", Some(("userId", serde_json::Value::Null))),
    ] {
        let expected = change.is_none();
        let mut response = matching.clone();
        if let Some((field, value)) = change {
            response[field] = value;
        }
        let request = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/api/runners/wss/tickets/consume")
                    .header("authorization", "Bearer official-test-token")
                    .json_body_obj(&serde_json::json!({
                        "runId": run, "runnerId": runner, "origin": origin, "ticket": ticket
                    }));
                then.status(200).json_body(response);
            })
            .await;
        assert_eq!(
            consumer.consume(run, runner, origin, &ticket).await,
            expected,
            "API consumption result: {label}"
        );
        request.assert_async().await;
        request.delete_async().await;
    }
}

#[tokio::test]
async fn same_id_replacement_never_accepts_previous_process_run() {
    let old = Fixture::new().await;
    let mut replacement = Fixture::new().await;
    replacement.runner = old.runner;
    replacement.ctx.runner_id = old.runner;
    replacement.ctx.consumer = Arc::clone(&old.ctx.consumer);
    drop(old.guard);
    let (client, task) = replacement.connect(&format!("/ws/{}", old.runner)).await;
    let mut ws = client.unwrap();
    ws.send(first(old.run, &"A".repeat(43))).await.unwrap();
    denied(&mut ws).await;
    task.await.unwrap();
    assert!(
        old.ctx
            .consumer
            .consume(
                old.run,
                old.runner,
                "wss://runner.okou.ai:443",
                &"A".repeat(43)
            )
            .await
    );
}

#[tokio::test]
async fn blocked_forward_observes_status_removal_without_run_guard_release() {
    let fixture = Fixture::new().await;
    let run = fixture.run;
    let sandbox = fixture.sandbox;
    let status = Arc::clone(&fixture.ctx.status);
    let mut live = fixture.ctx.active_runs.watch_live_run(run).unwrap();
    let ctx = fixture.ctx;
    let (sender, _held_receiver) = mpsc::channel(1);
    sender.send(vec![0]).await.unwrap();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let mut task = tokio::spawn(async move {
        let mut run_check = tokio::time::interval(Duration::from_millis(250));
        forward_while_live(
            async {
                started_tx.send(()).unwrap();
                sender.send(vec![1]).await
            },
            &ctx,
            run,
            sandbox,
            &mut live,
            &mut run_check,
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), started_rx)
        .await
        .expect("forwarding must enter the full channel send")
        .unwrap();
    // Keep the process-local guard alive; only the authoritative running
    // assignment disappears, as it can before job cleanup releases the guard.
    assert!(status.remove_run_if_matching(run, sandbox).await.unwrap());
    let result = tokio::time::timeout(Duration::from_secs(2), &mut task).await;
    if result.is_err() {
        task.abort();
        let _ = task.await;
    }
    assert!(
        !result
            .expect("status loss must cancel a blocked send without waiting 15 seconds")
            .unwrap()
    );
    drop(fixture.guard);
}

#[tokio::test]
async fn blocked_forward_keeps_its_frame_across_live_status_checks() {
    let fixture = Fixture::new().await;
    let run = fixture.run;
    let sandbox = fixture.sandbox;
    let mut live = fixture.ctx.active_runs.watch_live_run(run).unwrap();
    let ctx = fixture.ctx;
    let (sender, mut receiver) = mpsc::channel(1);
    sender.send(vec![0u8]).await.unwrap();
    let (checked_tx, checked_rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let mut send = Box::pin(sender.send(vec![1u8]));
        let mut pending_polls = 0;
        let mut checked_tx = Some(checked_tx);
        let forward = std::future::poll_fn(|cx| {
            let result = std::future::Future::poll(send.as_mut(), cx);
            if result.is_pending() {
                pending_polls += 1;
                if pending_polls == 2 {
                    checked_tx.take().unwrap().send(()).unwrap();
                }
            }
            result
        });
        let mut run_check = tokio::time::interval(Duration::from_millis(250));
        forward_while_live(forward, &ctx, run, sandbox, &mut live, &mut run_check).await
    });
    // No channel capacity or Run-watch event can wake this blocked send. Its
    // second poll follows the periodic status check; do not add an active sleep.
    let checked = tokio::time::timeout(Duration::from_secs(2), checked_rx).await;
    if checked.is_err() {
        task.abort();
        let _ = task.await;
        panic!("blocked IO must keep progressing through live status checks");
    }
    checked.unwrap().unwrap();
    assert_eq!(receiver.recv().await, Some(vec![0]));
    assert!(
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("the original queued send must resume after capacity is available")
            .unwrap()
    );
    assert_eq!(receiver.recv().await, Some(vec![1]));
    assert_eq!(receiver.recv().await, None);
    drop(fixture.guard);
}

#[tokio::test]
async fn handshake_capacity_and_pre_auth_deadline_are_bounded() {
    let fixture = Fixture::new().await;
    let mut admission = Admission::new(
        fixture.runner,
        Some("runner.okou.ai"),
        Arc::clone(&fixture.ctx.consumer),
        Arc::clone(&fixture.ctx.guest),
        fixture.ctx.active_runs.clone(),
        Arc::clone(&fixture.ctx.status),
    );
    let mut peers = Vec::new();
    for _ in 0..MAX_HANDSHAKES {
        let (peer, server) = UnixStream::pair().unwrap();
        admission.accept(server);
        peers.push(peer);
    }
    assert_eq!(admission.handshakes.available_permits(), 0);
    let (mut extra, server) = UnixStream::pair().unwrap();
    admission.accept(server);
    let mut buffer = [0; 1];
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), extra.read(&mut buffer))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    drop(peers);
    admission.stop().await;
    let (client, task) = fixture.connect(&format!("/ws/{}", fixture.runner)).await;
    let mut ws = client.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(7), ws.next())
        .await
        .expect("missing first frame must close within pre-auth deadline");
    assert!(
        matches!(result, None | Some(Err(_)) | Some(Ok(Message::Close(_)))),
        "never acknowledge an unauthenticated peer: {result:?}"
    );
    task.await.unwrap();
}
