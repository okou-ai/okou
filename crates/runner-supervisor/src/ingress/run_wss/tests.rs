use std::path::Path;

use serde_json::{Value, json};
use tokio::net::UnixStream;
use tokio::sync::Notify;
use tokio_tungstenite::{client_async, tungstenite::Error};
use uuid::Uuid;

use super::*;
use crate::ingress::IngressRuntime;
use crate::ingress::test_support::{HOST, RUNNER_VERSION, TOKEN};
use crate::ingress::tests::{namespace, request};
use runner_host::runner_process_identity::RunnerProcessIdentity;

async fn connect(socket: &Path, path: &str) -> WebSocketStream<UnixStream> {
    let stream = UnixStream::connect(socket).await.unwrap();
    let (ws, _) = timeout(
        HANDSHAKE_TIMEOUT,
        client_async(format!("ws://{HOST}{path}"), stream),
    )
    .await
    .unwrap()
    .unwrap();
    ws
}

async fn next(ws: &mut WebSocketStream<UnixStream>) -> Option<Result<Message, Error>> {
    timeout(HANDSHAKE_TIMEOUT, ws.next()).await.unwrap()
}

#[tokio::test]
async fn active_run_websocket_uses_a_single_ticket_on_the_exact_path_and_closes_on_release() {
    let (_root, directory) = namespace();
    let runner = RunnerProcessIdentity::new(Uuid::new_v4(), 7).unwrap();
    let runtime = IngressRuntime::start(
        directory.clone(),
        runner,
        HOST.into(),
        TOKEN,
        RUNNER_VERSION,
    )
    .await
    .unwrap();
    let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
    let cancellations = RunCancellationRegistry::new();
    let run = RunId::new_v4();
    let active = active_runs.register(run, None, "vm0/default".into());
    let registration = cancellations.register(run).await.unwrap();
    runtime.enable_run_wss(active_runs, cancellations);

    let socket = directory.join(format!("{}.sock", runner.runner_id()));
    let runner_path = format!("/runners/{}", runner.runner_id());
    let ticket_request = format!(
        "POST {runner_path}/control/runs/{run}/wss-ticket HTTP/1.1\r\nHost: {HOST}\r\nAuthorization: Bearer {TOKEN}\r\n{GENERATION_HEADER}: 7\r\nContent-Length: 0\r\n\r\n"
    );
    assert_eq!(
        request(&socket, &ticket_request.replace(TOKEN, "unauthorized"))
            .await
            .0,
        401
    );
    assert_eq!(
        request(&socket, &ticket_request.replace(": 7\r\n", ": 8\r\n"))
            .await
            .0,
        404
    );
    let (status, body, headers) = request(&socket, &ticket_request).await;
    assert_eq!(status, 200);
    assert!(headers.contains("cache-control: no-store"));
    let ticket: Value = serde_json::from_str(&body).unwrap();
    let first = Message::Text(
        json!({"runId": run, "ticket": ticket["ticket"]})
            .to_string()
            .into(),
    );

    let other_run = RunId::new_v4();
    let other_path = format!("{runner_path}/runs/{other_run}");
    let mut wrong_run = connect(&socket, &other_path).await;
    wrong_run
        .send(Message::Text(
            json!({"runId": other_run, "ticket": ticket["ticket"]})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    assert!(
        next(&mut wrong_run)
            .await
            .is_none_or(|message| message.is_err())
    );

    let run_path = format!("{runner_path}/runs/{run}");
    assert_eq!(
        request(
            &socket,
            &format!("GET {run_path}/ HTTP/1.1\r\nHost: {HOST}\r\n\r\n")
        )
        .await
        .0,
        404
    );
    let mut ws = connect(&socket, &run_path).await;
    ws.send(first.clone()).await.unwrap();
    assert_eq!(
        next(&mut ws).await.unwrap().unwrap(),
        Message::Text(r#"{"type":"auth.ok"}"#.into())
    );
    ws.send(Message::Ping(Bytes::from_static(b"ping")))
        .await
        .unwrap();
    assert_eq!(
        next(&mut ws).await.unwrap().unwrap(),
        Message::Pong(Bytes::from_static(b"ping"))
    );

    let mut replay = connect(&socket, &run_path).await;
    replay.send(first).await.unwrap();
    assert!(
        next(&mut replay)
            .await
            .is_none_or(|message| message.is_err())
    );

    drop(active);
    assert!(next(&mut ws).await.is_none_or(|message| message.is_err()));
    assert_eq!(request(&socket, &ticket_request).await.0, 404);
    registration.unregister().await;
    runtime.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn issued_ticket_expires_and_does_not_survive_run_cancellation() {
    let run = RunId::new_v4();
    let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
    let _active = active_runs.register(run, None, "vm0/default".into());
    let cancellations = RunCancellationRegistry::new();
    let registration = cancellations.register(run).await.unwrap();
    let server = RunWebSocket::new(active_runs, cancellations, CancellationToken::new());

    let ticket = server.issue(run).await.unwrap();
    tokio::time::advance(TICKET_LIFETIME).await;
    assert!(
        server
            .redeem(
                run,
                &json!({"runId": run, "ticket": ticket.ticket}).to_string()
            )
            .is_none()
    );

    let ticket = server.issue(run).await.unwrap();
    assert!(registration.request_hard_cancellation().await);
    assert!(
        server
            .redeem(
                run,
                &json!({"runId": run, "ticket": ticket.ticket}).to_string()
            )
            .is_none()
    );
    assert!(matches!(
        server.issue(run).await,
        Err(StatusCode::NOT_FOUND)
    ));
    registration.unregister().await;
}
