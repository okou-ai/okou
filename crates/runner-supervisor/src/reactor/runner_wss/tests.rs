use super::*;
use std::collections::HashSet;
use std::sync::Mutex;

use futures_util::{SinkExt, StreamExt};
use runner_lifecycle::active_runs::ActiveRunGuard;
use runner_remote::guest_duplex::Registration;
use sandbox::{AcceptedGuestDuplex, GuestDuplexAcceptor, Sandbox};
use sandbox_mock::MockSandbox;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::Message;

struct MockTickets {
    run: RunId,
    seen: Mutex<HashSet<String>>,
    epoch: Mutex<Uuid>,
    available: std::sync::atomic::AtomicBool,
    checks: std::sync::atomic::AtomicUsize,
}

#[async_trait]
impl TicketConsumer for MockTickets {
    async fn consume(
        &self,
        run_id: RunId,
        runner_id: Uuid,
        origin: &str,
        ticket: &str,
    ) -> Option<Uuid> {
        if run_id != self.run || runner_id.is_nil() || origin != "wss://runner.okou.ai:443" {
            return None;
        }
        self.seen
            .lock()
            .unwrap()
            .insert(ticket.to_owned())
            .then(|| *self.epoch.lock().unwrap())
    }

    async fn authorized(
        &self,
        runner_id: Uuid,
        origin: &str,
        requested: &[Key],
    ) -> Option<Vec<Key>> {
        self.checks
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if !self.available.load(std::sync::atomic::Ordering::SeqCst)
            || runner_id.is_nil()
            || origin != "wss://runner.okou.ai:443"
        {
            return None;
        }
        let epoch = *self.epoch.lock().unwrap();
        Some(
            requested
                .iter()
                .copied()
                .filter(|key| key.run_id == self.run && key.authorization_epoch == epoch)
                .collect(),
        )
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
    ) -> Option<Uuid> {
        let resume = self.resume.lock().unwrap().take().unwrap();
        self.started.notify_one();
        resume.await.ok().map(|()| Uuid::from_u128(1))
    }

    async fn authorized(
        &self,
        _runner_id: Uuid,
        _origin: &str,
        requested: &[Key],
    ) -> Option<Vec<Key>> {
        Some(requested.to_vec())
    }
}

struct GuestBoundary {
    sandbox: SandboxId,
    echo: bool,
    peers: mpsc::Sender<DuplexStream>,
    cancelled: CancellationToken,
    tasks: Mutex<JoinSet<()>>,
}

#[async_trait]
impl GuestDuplexAcceptor for GuestBoundary {
    async fn accept(&self) -> io::Result<AcceptedGuestDuplex> {
        let (host, mut guest) = tokio::io::duplex(if self.echo { 128 * 1024 } else { 1 });
        if self.echo {
            self.tasks.lock().unwrap().spawn(async move {
                loop {
                    let mut header = [0; 4];
                    if guest.read_exact(&mut header).await.is_err() {
                        break;
                    }
                    let size = u32::from_be_bytes(header) as usize;
                    if size > MAX_FRAME {
                        break;
                    }
                    let mut bytes = vec![0; size];
                    if guest.read_exact(&mut bytes).await.is_err()
                        || guest.write_all(&header).await.is_err()
                        || guest.write_all(&bytes).await.is_err()
                    {
                        break;
                    }
                }
            });
        } else {
            self.peers
                .send(guest)
                .await
                .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "test Guest peer closed"))?;
        }
        Ok(AcceptedGuestDuplex {
            sandbox_id: self.sandbox.to_string(),
            stream: Box::new(host),
            cancelled: self.cancelled.clone(),
        })
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    runner: Uuid,
    run: RunId,
    sandbox: SandboxId,
    guard: ActiveRunGuard,
    registration: Option<Registration>,
    assignment_cancelled: CancellationToken,
    peers: tokio::sync::Mutex<mpsc::Receiver<DuplexStream>>,
    ctx: ConnectionContext,
    tickets: Arc<MockTickets>,
    _refresh: RefreshTask,
}

impl Fixture {
    async fn new() -> Self {
        Self::with_echo(true).await
    }

    async fn with_echo(echo: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let runner = Uuid::new_v4();
        let run = RunId::new_v4();
        let sandbox = SandboxId::new_v4();
        let active_runs = ActiveRuns::new(Arc::new(tokio::sync::Notify::new()));
        let guard = active_runs.register(run, None, "test".to_owned());
        let status = Arc::new(StatusTracker::new(dir.path().join("status"), 1, None, None));
        status.add_run(run, sandbox).await.unwrap();
        let guest = RunGuestChannels::default();
        let assignment_cancelled = CancellationToken::new();
        let (peers_tx, peers_rx) = mpsc::channel(8);
        let acceptor = Arc::new(GuestBoundary {
            sandbox,
            echo,
            peers: peers_tx,
            cancelled: assignment_cancelled.clone(),
            tasks: Mutex::new(JoinSet::new()),
        });
        let mut provider = MockSandbox::new(sandbox.to_string()).with_guest_duplex(acceptor);
        provider.bind_run_control(&run.to_string()).unwrap();
        let registration = guest.register(run, &provider, &CancellationToken::new());
        assert!(registration.is_some());
        let tickets = Arc::new(MockTickets {
            run,
            seen: Mutex::new(HashSet::new()),
            epoch: Mutex::new(Uuid::from_u128(1)),
            available: std::sync::atomic::AtomicBool::new(true),
            checks: std::sync::atomic::AtomicUsize::new(0),
        });
        let authorizations = Authorizations::default();
        let refresh =
            authorizations.start(runner, canonical_origin("runner.okou.ai"), tickets.clone());
        let ctx = ConnectionContext {
            runner_id: runner,
            origin: canonical_origin("runner.okou.ai"),
            consumer: tickets.clone(),
            guest,
            active_runs,
            status,
            authorizations,
        };
        Self {
            dir,
            runner,
            run,
            sandbox,
            guard,
            registration,
            assignment_cancelled,
            peers: tokio::sync::Mutex::new(peers_rx),
            ctx,
            tickets,
            _refresh: refresh,
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
            guest: self.ctx.guest.clone(),
            active_runs: self.ctx.active_runs.clone(),
            status: Arc::clone(&self.ctx.status),
            authorizations: self.ctx.authorizations.clone(),
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
            .is_some()
    );

    assert!(canonical_origin("localhost").is_none());
    assert!(canonical_origin("example.test").is_none());
    assert!(canonical_origin("127.1").is_none());
    assert!(canonical_origin("127.0.0.1").is_none());
}

#[tokio::test]
async fn absent_executor_registration_rejects_before_consuming_ticket() {
    let mut fixture = Fixture::new().await;
    drop(fixture.registration.take());
    let ticket = "A".repeat(43);
    let (client, task) = fixture.connect(&format!("/ws/{}", fixture.runner)).await;
    let mut ws = client.unwrap();
    ws.send(first(fixture.run, &ticket)).await.unwrap();
    denied(&mut ws).await;
    task.await.unwrap();

    // A Running status/guard alone must not spend a one-use ticket.
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
            .is_some()
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
        consumer
            .consume(
                RunId::new_v4(),
                Uuid::new_v4(),
                "wss://runner.okou.ai:443",
                &"A".repeat(43)
            )
            .await
            .is_none()
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
        "orgId": "org", "userId": "user", "authorizationEpoch": Uuid::from_u128(1)
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
        (
            "null epoch",
            Some(("authorizationEpoch", serde_json::Value::Null)),
        ),
        (
            "invalid epoch",
            Some(("authorizationEpoch", serde_json::json!("bad"))),
        ),
        (
            "nil epoch",
            Some(("authorizationEpoch", serde_json::json!(Uuid::nil()))),
        ),
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
            consumer
                .consume(run, runner, origin, &ticket)
                .await
                .is_some(),
            expected,
            "API consumption result: {label}"
        );
        request.assert_async().await;
        request.delete_async().await;
    }
    let mut old_api = matching.clone();
    old_api
        .as_object_mut()
        .unwrap()
        .remove("authorizationEpoch");
    let mut oversized = matching.clone();
    oversized["orgId"] = serde_json::json!("x".repeat(5000));
    for (status, response) in [(200, old_api), (201, matching), (200, oversized)] {
        let request = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/api/runners/wss/tickets/consume")
                    .header("authorization", "Bearer official-test-token");
                then.status(status).json_body(response);
            })
            .await;
        assert!(
            consumer
                .consume(run, runner, origin, &ticket)
                .await
                .is_none()
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
            .is_some()
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
            &mut std::future::pending(),
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
async fn blocked_forward_observes_native_guest_cancellation_with_live_run() {
    let fixture = Fixture::new().await;
    let mut channel = fixture
        .ctx
        .guest
        .open_for_sandbox(fixture.run, &fixture.sandbox.to_string())
        .await
        .unwrap();
    let observer = channel.cancellation();
    let ctx = fixture.ctx;
    let run = fixture.run;
    let sandbox = fixture.sandbox;
    let mut live = ctx.active_runs.watch_live_run(run).unwrap();
    let (sender, _held_receiver) = mpsc::channel(1);
    sender.send(vec![0]).await.unwrap();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let mut guest_cancelled = Box::pin(observer.cancelled());
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
            &mut guest_cancelled,
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), started_rx)
        .await
        .unwrap()
        .unwrap();
    fixture.assignment_cancelled.cancel();
    assert!(
        !tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
    );
    assert_eq!(
        channel.send(b"cancelled").await.err().unwrap().kind(),
        io::ErrorKind::NotConnected
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
        forward_while_live(
            forward,
            &ctx,
            run,
            sandbox,
            &mut live,
            &mut run_check,
            &mut std::future::pending(),
        )
        .await
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
async fn real_guest_partial_header_survives_interleaved_client_forwarding() {
    let fixture = Fixture::with_echo(false).await;
    let (client, task) = fixture.connect(&format!("/ws/{}", fixture.runner)).await;
    let mut ws = client.unwrap();
    ws.send(first(fixture.run, &"A".repeat(43))).await.unwrap();
    assert_eq!(
        ws.next().await.unwrap().unwrap().into_text().unwrap(),
        r#"{"type":"auth.ok"}"#
    );
    let mut peer = fixture.peers.lock().await.recv().await.unwrap();
    // Capacity one means the second byte can only be written after the first
    // was consumed. The native receive is now pending partway through a header.
    tokio::time::timeout(Duration::from_secs(2), peer.write_all(&[0, 0]))
        .await
        .unwrap()
        .unwrap();
    ws.send(Message::Binary(b"other".to_vec().into()))
        .await
        .unwrap();
    let mut sent = [0; 9];
    tokio::time::timeout(Duration::from_secs(2), peer.read_exact(&mut sent))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&sent, b"\0\0\0\x05other");
    tokio::time::timeout(Duration::from_secs(2), peer.write_all(b"\0\x03abc"))
        .await
        .unwrap()
        .unwrap();
    let received = tokio::time::timeout(Duration::from_secs(2), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(received.into_data(), b"abc".as_slice());
    ws.close(None).await.unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn real_guest_assignment_cancel_closes_idle_wss_without_run_status_loss() {
    let fixture = Fixture::new().await;
    let (client, task) = fixture.connect(&format!("/ws/{}", fixture.runner)).await;
    let mut ws = client.unwrap();
    ws.send(first(fixture.run, &"A".repeat(43))).await.unwrap();
    assert_eq!(
        ws.next().await.unwrap().unwrap().into_text().unwrap(),
        r#"{"type":"auth.ok"}"#
    );
    assert_eq!(
        fixture.ctx.status.running_sandbox(fixture.run).await,
        Some(fixture.sandbox)
    );
    assert!(
        fixture
            .ctx
            .active_runs
            .watch_live_run(fixture.run)
            .is_some()
    );
    fixture.assignment_cancelled.cancel();
    denied(&mut ws).await;
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        fixture.ctx.status.running_sandbox(fixture.run).await,
        Some(fixture.sandbox)
    );
}

#[tokio::test]
async fn running_sandbox_must_match_executor_assignment_before_consumption() {
    let fixture = Fixture::new().await;
    let replacement = SandboxId::new_v4();
    fixture
        .ctx
        .status
        .remove_run_if_matching(fixture.run, fixture.sandbox)
        .await
        .unwrap();
    fixture
        .ctx
        .status
        .add_run(fixture.run, replacement)
        .await
        .unwrap();
    let (client, task) = fixture.connect(&format!("/ws/{}", fixture.runner)).await;
    let mut ws = client.unwrap();
    let ticket = "A".repeat(43);
    ws.send(first(fixture.run, &ticket)).await.unwrap();
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
                &ticket
            )
            .await
            .is_some()
    );
}

#[tokio::test]
async fn real_registry_eight_stream_cap_and_close_release_are_preserved() {
    let fixture = Fixture::new().await;
    let mut clients = Vec::new();
    for token in b'A'..=b'H' {
        let (client, task) = fixture.connect(&format!("/ws/{}", fixture.runner)).await;
        let mut ws = client.unwrap();
        ws.send(first(fixture.run, &(token as char).to_string().repeat(43)))
            .await
            .unwrap();
        assert_eq!(
            ws.next().await.unwrap().unwrap().into_text().unwrap(),
            r#"{"type":"auth.ok"}"#
        );
        clients.push((ws, task));
    }
    let (client, task) = fixture.connect(&format!("/ws/{}", fixture.runner)).await;
    let mut ws = client.unwrap();
    ws.send(first(fixture.run, &"I".repeat(43))).await.unwrap();
    denied(&mut ws).await;
    task.await.unwrap();
    let (mut released, task) = clients.pop().unwrap();
    released.close(None).await.unwrap();
    task.await.unwrap();
    let (client, task) = fixture.connect(&format!("/ws/{}", fixture.runner)).await;
    let mut ws = client.unwrap();
    ws.send(first(fixture.run, &"J".repeat(43))).await.unwrap();
    assert_eq!(
        ws.next().await.unwrap().unwrap().into_text().unwrap(),
        r#"{"type":"auth.ok"}"#
    );
    ws.close(None).await.unwrap();
    task.await.unwrap();
    for (mut ws, task) in clients {
        ws.close(None).await.unwrap();
        task.await.unwrap();
    }
}

#[tokio::test]
async fn owner_revoke_closes_idle_wss_without_ending_run_and_fresh_ticket_reconnects() {
    let fixture = Fixture::new().await;
    let (client, task) = fixture.connect(&format!("/ws/{}", fixture.runner)).await;
    let mut ws = client.unwrap();
    ws.send(first(fixture.run, &"A".repeat(43))).await.unwrap();
    assert_eq!(
        ws.next().await.unwrap().unwrap().into_text().unwrap(),
        r#"{"type":"auth.ok"}"#
    );
    *fixture.tickets.epoch.lock().unwrap() = Uuid::from_u128(2);
    let closed = tokio::time::timeout(LEASE_WINDOW + Duration::from_secs(1), ws.next())
        .await
        .unwrap();
    assert!(matches!(
        closed,
        None | Some(Err(_)) | Some(Ok(Message::Close(_)))
    ));
    task.await.unwrap();
    assert_eq!(
        fixture.ctx.status.running_sandbox(fixture.run).await,
        Some(fixture.sandbox)
    );
    assert!(
        fixture
            .ctx
            .active_runs
            .watch_live_run(fixture.run)
            .is_some()
    );
    assert!(!fixture.assignment_cancelled.is_cancelled());
    let (client, task) = fixture.connect(&format!("/ws/{}", fixture.runner)).await;
    let mut fresh = client.unwrap();
    fresh
        .send(first(fixture.run, &"B".repeat(43)))
        .await
        .unwrap();
    assert_eq!(
        fresh.next().await.unwrap().unwrap().into_text().unwrap(),
        r#"{"type":"auth.ok"}"#
    );
    fresh
        .send(Message::Binary(b"still running".to_vec().into()))
        .await
        .unwrap();
    assert_eq!(
        fresh.next().await.unwrap().unwrap().into_data(),
        b"still running".as_slice()
    );
    fresh.close(None).await.unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn api_outage_expires_idle_and_blocked_guest_wss_only() {
    for blocked in [false, true] {
        let fixture = Fixture::with_echo(!blocked).await;
        let (client, task) = fixture.connect(&format!("/ws/{}", fixture.runner)).await;
        let mut ws = client.unwrap();
        ws.send(first(fixture.run, &"A".repeat(43))).await.unwrap();
        assert_eq!(
            ws.next().await.unwrap().unwrap().into_text().unwrap(),
            r#"{"type":"auth.ok"}"#
        );
        let held_peer = if blocked {
            let peer = fixture.peers.lock().await.recv().await.unwrap();
            ws.send(Message::Binary(vec![7; MAX_FRAME].into()))
                .await
                .unwrap();
            Some(peer) // One-byte native capacity keeps the real Guest write blocked.
        } else {
            None
        };
        fixture
            .tickets
            .available
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let closed = tokio::time::timeout(LEASE_WINDOW + Duration::from_secs(1), ws.next())
            .await
            .unwrap();
        assert!(matches!(
            closed,
            None | Some(Err(_)) | Some(Ok(Message::Close(_)))
        ));
        task.await.unwrap();
        assert_eq!(
            fixture.ctx.status.running_sandbox(fixture.run).await,
            Some(fixture.sandbox)
        );
        assert!(
            fixture
                .ctx
                .active_runs
                .watch_live_run(fixture.run)
                .is_some()
        );
        assert!(!fixture.assignment_cancelled.is_cancelled());
        assert!(
            fixture
                .tickets
                .checks
                .load(std::sync::atomic::Ordering::SeqCst)
                <= 4
        );
        drop(held_peer);
    }
}

#[tokio::test]
async fn http_control_failure_closes_real_guest_wss_without_cancelling_execution() {
    use httpmock::prelude::*;
    let server = MockServer::start_async().await;
    let mut fixture = Fixture::new().await;
    let epoch = Uuid::new_v4();
    let consume = server.mock_async(|when, then| {
        when.method(POST).path("/api/runners/wss/tickets/consume")
            .header("authorization", "Bearer official-test-token")
            .json_body_obj(&serde_json::json!({"runId": fixture.run, "runnerId": fixture.runner,
                "origin": fixture.ctx.origin, "ticket": "A".repeat(43)}));
        then.status(200).json_body(serde_json::json!({"runId": fixture.run, "runnerId": fixture.runner,
            "origin": fixture.ctx.origin, "orgId": "org-test", "userId": "owner-test", "authorizationEpoch": epoch}));
    }).await;
    let check = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/runners/wss/authorizations/check")
                .header("authorization", "Bearer official-test-token")
                .json_body_obj(
                    &serde_json::json!({"runnerId": fixture.runner, "origin": fixture.ctx.origin,
                "authorizations": [{"runId": fixture.run, "authorizationEpoch": epoch}]}),
                );
            then.status(503);
        })
        .await;
    fixture.ctx.consumer = Arc::new(ApiTicketConsumer::new(
        HttpClient::new(runner_provider::http::HttpClientConfig {
            api_url: server.base_url(),
            vercel_bypass: None,
            client_session_id: "wss-control-test".into(),
            runner_version: env!("CARGO_PKG_VERSION"),
        })
        .unwrap(),
        "official-test-token".into(),
    ));
    fixture._refresh = fixture.ctx.authorizations.start(
        fixture.runner,
        fixture.ctx.origin.clone(),
        fixture.ctx.consumer.clone(),
    );
    let (client, task) = fixture.connect(&format!("/ws/{}", fixture.runner)).await;
    let mut ws = client.unwrap();
    ws.send(first(fixture.run, &"A".repeat(43))).await.unwrap();
    assert_eq!(
        ws.next().await.unwrap().unwrap().into_text().unwrap(),
        r#"{"type":"auth.ok"}"#
    );
    let closed = tokio::time::timeout(LEASE_WINDOW + Duration::from_secs(1), ws.next())
        .await
        .unwrap();
    assert!(matches!(
        closed,
        None | Some(Err(_)) | Some(Ok(Message::Close(_)))
    ));
    task.await.unwrap();
    consume.assert_async().await;
    assert!((1..=3).contains(&check.calls_async().await));
    assert_eq!(
        fixture.ctx.status.running_sandbox(fixture.run).await,
        Some(fixture.sandbox)
    );
    assert!(
        fixture
            .ctx
            .active_runs
            .watch_live_run(fixture.run)
            .is_some()
    );
    assert!(!fixture.assignment_cancelled.is_cancelled());
}

#[tokio::test]
async fn check_uses_official_auth_and_rejects_unsolicited_duplicate_and_malformed_results() {
    use httpmock::prelude::*;
    let server = MockServer::start_async().await;
    let runner = Uuid::new_v4();
    let key = Key {
        run_id: RunId::new_v4(),
        authorization_epoch: Uuid::new_v4(),
    };
    let origin = "wss://runner.okou.ai:443";
    let consumer = ApiTicketConsumer::new(
        HttpClient::new(runner_provider::http::HttpClientConfig {
            api_url: server.base_url(),
            vercel_bypass: None,
            client_session_id: "wss-check-test".into(),
            runner_version: env!("CARGO_PKG_VERSION"),
        })
        .unwrap(),
        "official-test-token".into(),
    );
    for (response, valid) in [
        (serde_json::json!({"authorized": [key]}), true),
        (serde_json::json!({"authorized": []}), true),
        (serde_json::json!({"authorized": [key, key]}), false),
        (
            serde_json::json!({"authorized": [{"runId": key.run_id, "authorizationEpoch": Uuid::new_v4()}]}),
            false,
        ),
        (
            serde_json::json!({"authorized": [{"runId": RunId::new_v4(), "authorizationEpoch": key.authorization_epoch}]}),
            false,
        ),
        (serde_json::json!({"authorized": "invalid"}), false),
        (serde_json::json!({}), false),
    ] {
        let request = server.mock_async(|when, then| {
            when.method(POST).path("/api/runners/wss/authorizations/check")
                .header("authorization", "Bearer official-test-token")
                .json_body_obj(&serde_json::json!({"runnerId": runner, "origin": origin, "authorizations": [key]}));
            then.status(200).json_body(response);
        }).await;
        assert_eq!(
            consumer.authorized(runner, origin, &[key]).await.is_some(),
            valid
        );
        request.assert_async().await;
        request.delete_async().await;
    }
    assert!(consumer.authorized(runner, origin, &[]).await.is_none());
    assert!(
        consumer
            .authorized(runner, origin, &vec![key; MAX_CONNECTIONS + 1])
            .await
            .is_none()
    );
}

#[tokio::test]
async fn handshake_capacity_and_pre_auth_deadline_are_bounded() {
    let fixture = Fixture::new().await;
    let mut admission = Admission::new(
        fixture.runner,
        Some("runner.okou.ai"),
        Arc::clone(&fixture.ctx.consumer),
        fixture.ctx.guest.clone(),
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
