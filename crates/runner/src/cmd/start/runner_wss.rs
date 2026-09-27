//! Ticket admission on the owning Runner. Caddy's URL chooses a process; only
//! the API ticket AND an exact local live run-to-sandbox assignment grant data.
//! #37026 supplies the private Guest attachment; until then runtime attachment
//! deliberately fails closed rather than acknowledging a ticket without a Guest.

use std::io;
use std::sync::Arc;
use std::time::Duration;

use api_contracts::{Method, Route};
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use runner_lifecycle::active_runs::{ActiveRunReuseState, ActiveRuns};
use runner_lifecycle::status::StatusTracker;
use runner_provider::http::HttpClient;
use runner_types::ids::RunId;
use sandbox::SandboxId;
use serde::{Deserialize, Serialize};
use tokio::net::UnixStream;
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinSet;
use tokio_tungstenite::tungstenite::{
    handshake::server::{Callback, ErrorResponse, Request, Response},
    protocol::{Message, WebSocketConfig},
};
use uuid::Uuid;

const PRE_AUTH_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_FRAME: usize = 64 * 1024;
const MAX_CONNECTIONS: usize = 32;
const MAX_HANDSHAKES: usize = 16;
const MAX_QUEUE_FRAMES: usize = 16; // At most 1 MiB per direction.
const CONSUME_ROUTE: Route = Route::new(Method::Post, "/api/runners/wss/tickets/consume");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FirstFrame {
    run_id: RunId,
    ticket: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConsumeRequest<'a> {
    run_id: RunId,
    runner_id: Uuid,
    origin: &'a str,
    ticket: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsumeResponse {
    run_id: RunId,
    runner_id: Uuid,
    origin: String,
    org_id: String,
    user_id: String,
}

#[async_trait]
pub(super) trait TicketConsumer: Send + Sync {
    async fn consume(&self, run_id: RunId, runner_id: Uuid, origin: &str, ticket: &str) -> bool;
}

pub(super) struct ApiTicketConsumer {
    http: HttpClient,
    token: String,
}

impl ApiTicketConsumer {
    pub fn new(http: HttpClient, token: String) -> Self {
        Self { http, token }
    }
}

#[async_trait]
impl TicketConsumer for ApiTicketConsumer {
    async fn consume(&self, run_id: RunId, runner_id: Uuid, origin: &str, ticket: &str) -> bool {
        let payload = ConsumeRequest {
            run_id,
            runner_id,
            origin,
            ticket,
        };
        let response = self
            .http
            .request_route(CONSUME_ROUTE, &self.token)
            .json(&payload)
            .timeout(PRE_AUTH_TIMEOUT)
            .send("runner_wss_ticket_consume")
            .await;
        let Ok(mut response) = response else {
            return false;
        };
        if !response.status().is_success() {
            return false;
        }
        let mut bytes = Vec::new();
        loop {
            let Ok(chunk) = response.chunk().await else {
                return false;
            };
            let Some(chunk) = chunk else { break };
            if chunk.len() > 4096 - bytes.len() {
                return false;
            }
            bytes.extend_from_slice(&chunk);
        }
        let Ok(body) = serde_json::from_slice::<ConsumeResponse>(&bytes) else {
            return false;
        };
        body.run_id == run_id
            && body.runner_id == runner_id
            && body.origin == origin
            && !body.org_id.is_empty()
            && !body.user_id.is_empty()
    }
}

/// #37026 must provide a channel whose attachment atomically verifies the
/// same live sandbox; bounded channels retain per-direction frame ordering.
pub(super) struct GuestConnection {
    pub incoming: mpsc::Sender<Vec<u8>>,
    pub outgoing: mpsc::Receiver<Vec<u8>>,
}

#[async_trait]
pub(super) trait GuestAttach: Send + Sync {
    fn available(&self) -> bool {
        true
    }
    async fn attach(
        &self,
        run: RunId,
        sandbox: SandboxId,
        max_queue_frames: usize,
    ) -> Option<GuestConnection>;
}

pub(super) struct UnavailableGuest;

#[async_trait]
impl GuestAttach for UnavailableGuest {
    fn available(&self) -> bool {
        false
    }
    async fn attach(
        &self,
        _run: RunId,
        _sandbox: SandboxId,
        _max_queue_frames: usize,
    ) -> Option<GuestConnection> {
        None
    }
}

pub(super) struct Admission {
    pub runner_id: Uuid,
    pub origin: Option<String>,
    pub consumer: Arc<dyn TicketConsumer>,
    pub guest: Arc<dyn GuestAttach>,
    pub active_runs: ActiveRuns,
    pub status: Arc<StatusTracker>,
    connections: Arc<Semaphore>,
    handshakes: Arc<Semaphore>,
    tasks: JoinSet<()>,
}

impl Admission {
    pub fn new(
        runner_id: Uuid,
        hostname: Option<&str>,
        consumer: Arc<dyn TicketConsumer>,
        guest: Arc<dyn GuestAttach>,
        active_runs: ActiveRuns,
        status: Arc<StatusTracker>,
    ) -> Self {
        Self {
            runner_id,
            origin: hostname.and_then(canonical_origin),
            consumer,
            guest,
            active_runs,
            status,
            connections: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
            handshakes: Arc::new(Semaphore::new(MAX_HANDSHAKES)),
            tasks: JoinSet::new(),
        }
    }

    /// Never block the Runner reactor waiting for an unauthenticated peer.
    pub fn accept(&mut self, stream: UnixStream) {
        if self.tasks.len() >= MAX_CONNECTIONS {
            return;
        }
        let Ok(connection) = self.connections.clone().try_acquire_owned() else {
            return;
        };
        let Ok(handshake) = self.handshakes.clone().try_acquire_owned() else {
            return;
        };
        let ctx = ConnectionContext {
            runner_id: self.runner_id,
            origin: self.origin.clone(),
            consumer: Arc::clone(&self.consumer),
            guest: Arc::clone(&self.guest),
            active_runs: self.active_runs.clone(),
            status: Arc::clone(&self.status),
        };
        self.tasks.spawn(async move {
            let _connection = connection;
            handle(stream, ctx, handshake).await;
        });
    }

    pub fn has_tasks(&self) -> bool {
        !self.tasks.is_empty()
    }
    pub async fn reap(&mut self) -> Result<(), tokio::task::JoinError> {
        if let Some(result) = self.tasks.join_next().await {
            result?;
        }
        Ok(())
    }

    pub fn stop(&mut self) {
        self.tasks.abort_all();
    }
}

/// Abort the pre-readiness accept loop on any startup/teardown return path.
/// Dropping a bare JoinHandle would detach the listener and strand its socket.
pub(super) struct AcceptTask {
    task: tokio::task::JoinHandle<io::Result<()>>,
    joined: bool,
}

impl AcceptTask {
    pub fn new(task: tokio::task::JoinHandle<io::Result<()>>) -> Self {
        Self {
            task,
            joined: false,
        }
    }
    pub fn is_finished(&self) -> bool {
        self.task.is_finished()
    }
    pub async fn wait(&mut self) -> Result<io::Result<()>, tokio::task::JoinError> {
        let result = (&mut self.task).await;
        self.joined = true;
        result
    }
    pub async fn stop(mut self) {
        if !self.joined {
            self.task.abort();
            let _ = (&mut self.task).await;
            self.joined = true;
        }
    }
}

impl Drop for AcceptTask {
    fn drop(&mut self) {
        if !self.joined {
            self.task.abort();
        }
    }
}

struct ExactPath(String);

impl Callback for ExactPath {
    fn on_request(self, request: &Request, response: Response) -> Result<Response, ErrorResponse> {
        if request.uri().path() == self.0 && request.uri().query().is_none() {
            Ok(response)
        } else {
            let mut denied = ErrorResponse::new(Some("Not Found".into()));
            *denied.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::NOT_FOUND;
            Err(denied)
        }
    }
}

struct ConnectionContext {
    runner_id: Uuid,
    origin: Option<String>,
    consumer: Arc<dyn TicketConsumer>,
    guest: Arc<dyn GuestAttach>,
    active_runs: ActiveRuns,
    status: Arc<StatusTracker>,
}

fn canonical_origin(hostname: &str) -> Option<String> {
    if hostname.len() > 253
        || hostname.len() < 3
        || !hostname.is_ascii()
        || hostname != hostname.to_ascii_lowercase()
        || !hostname.contains('.')
        || [
            ".localhost",
            ".local",
            ".internal",
            ".home.arpa",
            ".invalid",
            ".test",
            ".example",
        ]
        .iter()
        .any(|suffix| hostname.ends_with(suffix))
        || hostname.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
    {
        return None;
    }
    let origin = format!("wss://{hostname}:443");
    let url = url::Url::parse(&origin).ok()?;
    (url.host_str() == Some(hostname)).then_some(origin)
}

async fn handle(
    stream: UnixStream,
    ctx: ConnectionContext,
    handshake: tokio::sync::OwnedSemaphorePermit,
) {
    let admitted = tokio::time::timeout(PRE_AUTH_TIMEOUT, async {
        let path = format!("/ws/{}", ctx.runner_id);
        let mut config = WebSocketConfig::default();
        config.max_frame_size = Some(MAX_FRAME);
        config.max_message_size = Some(MAX_FRAME);
        config.write_buffer_size = 16 * 1024;
        config.max_write_buffer_size = 2 * MAX_FRAME;
        let mut ws =
            tokio_tungstenite::accept_hdr_async_with_config(stream, ExactPath(path), Some(config))
                .await
                .ok()?;
        let Some(Ok(Message::Text(first))) = ws.next().await else {
            return None;
        };
        if first.len() > 256 {
            return None;
        }
        let first = serde_json::from_str::<FirstFrame>(&first).ok()?;
        if first.ticket.len() != 43
            || !first
                .ticket
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        {
            return None;
        }
        // Validate local ownership before spending a single-use ticket; repeat
        // immediately after consumption to close the run-end/API-call race.
        if !ctx.guest.available() {
            return None;
        }
        let live = ctx.active_runs.watch_live_run(first.run_id)?;
        let sandbox_id = ctx.status.running_sandbox(first.run_id).await?;
        let origin = ctx.origin.as_deref()?;
        if !ctx
            .consumer
            .consume(first.run_id, ctx.runner_id, origin, &first.ticket)
            .await
        {
            return None;
        }
        if *live.borrow() == ActiveRunReuseState::Released
            || ctx.status.running_sandbox(first.run_id).await != Some(sandbox_id)
        {
            return None;
        }
        let guest = ctx
            .guest
            .attach(first.run_id, sandbox_id, MAX_QUEUE_FRAMES)
            .await?;
        if *live.borrow() == ActiveRunReuseState::Released
            || ctx.status.running_sandbox(first.run_id).await != Some(sandbox_id)
        {
            return None;
        }
        if ws
            .send(Message::Text(r#"{"type":"auth.ok"}"#.into()))
            .await
            .is_err()
        {
            return None;
        }
        Some((ws, first.run_id, sandbox_id, live, guest))
    })
    .await;
    let Ok(Some((mut ws, run_id, sandbox_id, mut live, mut guest))) = admitted else {
        return;
    };
    drop(handshake);
    // No detached reader/writer tasks, no unbounded queue. The adapter owns
    // channels of MAX_QUEUE_FRAMES at most; a slow receiver backpressures both
    // directions rather than allocating while a peer stalls.
    let mut run_check = tokio::time::interval(Duration::from_millis(250));
    'connection: loop {
        tokio::select! {
            changed = live.changed() => {
                if changed.is_err() || *live.borrow() == ActiveRunReuseState::Released { break }
            }
            _ = run_check.tick() => {
                if ctx.status.running_sandbox(run_id).await != Some(sandbox_id) { break }
            }
            inbound = ws.next() => match inbound {
                Some(Ok(Message::Binary(bytes))) if bytes.len() <= MAX_FRAME => {
                    // Cancel a blocked channel send if the run is released.
                    // A state change while blocked closes rather than losing or
                    // reordering a frame mid-send.
                    tokio::select! {
                        result = guest.incoming.send(bytes.to_vec()) => if result.is_err() { break 'connection },
                        _ = live.changed() => break 'connection,
                        _ = tokio::time::sleep(Duration::from_secs(15)) => break 'connection,
                    }
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {},
                Some(Ok(Message::Close(_))) | None => break,
                _ => break,
            },
            outbound = guest.outgoing.recv() => match outbound {
                Some(bytes) if bytes.len() <= MAX_FRAME => {
                    tokio::select! {
                        result = ws.send(Message::Binary(bytes.into())) => if result.is_err() { break 'connection },
                        _ = live.changed() => break 'connection,
                        _ = tokio::time::sleep(Duration::from_secs(15)) => break 'connection,
                    }
                }
                _ => break,
            }
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(1), ws.close(None)).await;
}

#[cfg(test)]
mod tests;
