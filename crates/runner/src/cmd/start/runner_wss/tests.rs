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
async fn absent_local_run_and_unavailable_guest_do_not_redeem_ticket() {
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
async fn consume_uses_official_credential_and_rejects_mismatched_api_result() {
    use httpmock::prelude::*;
    let server = MockServer::start_async().await;
    let run = RunId::new_v4();
    let runner = Uuid::new_v4();
    let ticket = "A".repeat(43);
    let request = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/runners/wss/tickets/consume")
                .header("authorization", "Bearer official-test-token")
                .body_includes(run.to_string())
                .body_includes(runner.to_string())
                .body_includes(ticket.clone());
            then.status(200).json_body(serde_json::json!({
                "runId": run, "runnerId": Uuid::new_v4(),
                "origin": "wss://runner.okou.ai:443", "orgId": "org", "userId": "user"
            }));
        })
        .await;
    let http = HttpClient::new(runner_provider::http::HttpClientConfig {
        api_url: server.base_url(),
        vercel_bypass: None,
        client_session_id: "wss-test".to_owned(),
        runner_version: env!("CARGO_PKG_VERSION"),
    })
    .unwrap();
    let consumer = ApiTicketConsumer::new(http, "official-test-token".to_owned());
    assert!(
        !consumer
            .consume(run, runner, "wss://runner.okou.ai:443", &ticket)
            .await
    );
    request.assert_async().await;
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
    admission.stop();
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
