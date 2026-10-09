//! Ticket admission on the owning Runner. Caddy's URL chooses a process; only
//! the API ticket AND an exact local live run-to-sandbox assignment grant data.
//! The executor's shared registry supplies the exact live Guest attachment;
//! unavailable or cancelled assignments fail closed before any acknowledgement.

use std::io;
use std::sync::Arc;
use std::time::Duration;

use api_contracts::generated::{
    routes::runners::wss as routes, types::runners::wss::ConsumeResponse,
};
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use runner_lifecycle::active_runs::{ActiveRunReuseState, ActiveRuns};
use runner_lifecycle::status::StatusTracker;
use runner_provider::http::HttpClient;
use runner_remote::guest_duplex::RunGuestChannels;
use runner_types::ids::RunId;
use sandbox::SandboxId;
use serde::{Deserialize, Serialize};
use tokio::net::UnixStream;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio_tungstenite::tungstenite::{
    handshake::server::{Callback, ErrorResponse, Request, Response},
    protocol::{Message, WebSocketConfig},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const PRE_AUTH_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_FRAME: usize = 64 * 1024;
const MAX_CONNECTIONS: usize = 32;
const MAX_HANDSHAKES: usize = 16;
mod authorization;
use authorization::{Authorizations, Key, LEASE_WINDOW, RefreshTask};

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckRequest<'a> {
    runner_id: Uuid,
    origin: &'a str,
    authorizations: &'a [Key],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckResponse {
    authorized: Vec<Key>,
}

#[async_trait]
pub(super) trait TicketConsumer: Send + Sync {
    async fn consume(
        &self,
        run_id: RunId,
        runner_id: Uuid,
        origin: &str,
        ticket: &str,
    ) -> Option<Uuid>;
    async fn authorized(
        &self,
        runner_id: Uuid,
        origin: &str,
        requested: &[Key],
    ) -> Option<Vec<Key>>;
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
    async fn consume(
        &self,
        run_id: RunId,
        runner_id: Uuid,
        origin: &str,
        ticket: &str,
    ) -> Option<Uuid> {
        let payload = ConsumeRequest {
            run_id,
            runner_id,
            origin,
            ticket,
        };
        let response = self
            .http
            .request_route(routes::CONSUME, &self.token)
            .json(&payload)
            .timeout(PRE_AUTH_TIMEOUT)
            .send("runner_wss_ticket_consume")
            .await
            .ok()?;
        let body: ConsumeResponse = read_authority_result(response).await?;
        let epoch = Uuid::parse_str(&body.authorization_epoch).ok()?;
        (body.run_id.parse::<RunId>().ok() == Some(run_id)
            && body.runner_id.parse::<Uuid>().ok() == Some(runner_id)
            && body.origin == origin
            && !body.org_id.is_empty()
            && !body.user_id.is_empty()
            && !epoch.is_nil())
        .then_some(epoch)
    }

    async fn authorized(
        &self,
        runner_id: Uuid,
        origin: &str,
        requested: &[Key],
    ) -> Option<Vec<Key>> {
        if requested.is_empty() || requested.len() > MAX_CONNECTIONS {
            return None;
        }
        let response = self
            .http
            .request_route(routes::CHECK, &self.token)
            .json(&CheckRequest {
                runner_id,
                origin,
                authorizations: requested,
            })
            .timeout(authorization::REQUEST_TIMEOUT)
            .send("runner_wss_authorizations_check")
            .await
            .ok()?;
        let body: CheckResponse = read_authority_result(response).await?;
        let unique: std::collections::HashSet<_> = body.authorized.iter().copied().collect();
        (unique.len() == body.authorized.len()
            && body.authorized.iter().all(|key| requested.contains(key)))
        .then_some(body.authorized)
    }
}

async fn read_authority_result<T: serde::de::DeserializeOwned>(
    mut response: reqwest::Response,
) -> Option<T> {
    if response.status() != reqwest::StatusCode::OK {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if chunk.len() > 4096 - bytes.len() {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).ok()
}

pub(super) struct Admission {
    pub runner_id: Uuid,
    pub origin: Option<String>,
    pub consumer: Arc<dyn TicketConsumer>,
    pub guest: RunGuestChannels,
    pub active_runs: ActiveRuns,
    pub status: Arc<StatusTracker>,
    connections: Arc<Semaphore>,
    handshakes: Arc<Semaphore>,
    tasks: JoinSet<()>,
    authorizations: Authorizations,
    refresh: Option<RefreshTask>,
}

impl Admission {
    pub fn new(
        runner_id: Uuid,
        hostname: Option<&str>,
        consumer: Arc<dyn TicketConsumer>,
        guest: RunGuestChannels,
        active_runs: ActiveRuns,
        status: Arc<StatusTracker>,
    ) -> Self {
        let origin = hostname.and_then(canonical_origin);
        let authorizations = Authorizations::default();
        let refresh = authorizations.start(runner_id, origin.clone(), Arc::clone(&consumer));
        Self {
            runner_id,
            origin,
            consumer,
            guest,
            active_runs,
            status,
            connections: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
            handshakes: Arc::new(Semaphore::new(MAX_HANDSHAKES)),
            tasks: JoinSet::new(),
            authorizations,
            refresh: Some(refresh),
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
            guest: self.guest.clone(),
            active_runs: self.active_runs.clone(),
            status: Arc::clone(&self.status),
            authorizations: self.authorizations.clone(),
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

    pub async fn stop(&mut self) {
        self.tasks.shutdown().await;
        if let Some(refresh) = self.refresh.take() {
            refresh.stop().await;
        }
    }
}

/// Own the supervised listener through startup and teardown. Normal stop
/// cancels admission and joins its connections before releasing the socket;
/// the drop guard prevents an unexpected return from detaching the task.
pub(super) struct AcceptTask {
    task: tokio::task::JoinHandle<io::Result<()>>,
    stop: CancellationToken,
    joined: bool,
}

impl AcceptTask {
    pub fn new(task: tokio::task::JoinHandle<io::Result<()>>, stop: CancellationToken) -> Self {
        Self {
            task,
            stop,
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
            self.stop.cancel();
            let _ = (&mut self.task).await;
            self.joined = true;
        }
    }
}

impl Drop for AcceptTask {
    fn drop(&mut self) {
        if !self.joined {
            self.stop.cancel();
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
    guest: RunGuestChannels,
    active_runs: ActiveRuns,
    status: Arc<StatusTracker>,
    authorizations: Authorizations,
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
    matches!(url.host(), Some(url::Host::Domain(domain)) if domain == hostname).then_some(origin)
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
        let live = ctx.active_runs.watch_live_run(first.run_id)?;
        let sandbox_id = ctx.status.running_sandbox(first.run_id).await?;
        let sandbox_key = sandbox_id.to_string();
        if !ctx
            .guest
            .contains_live_assignment(first.run_id, &sandbox_key)
        {
            return None;
        }
        let origin = ctx.origin.as_deref()?;
        let started = tokio::time::Instant::now();
        let authorization_epoch = ctx
            .consumer
            .consume(first.run_id, ctx.runner_id, origin, &first.ticket)
            .await?;
        let lease = ctx.authorizations.track(
            Key {
                run_id: first.run_id,
                authorization_epoch,
            },
            started + LEASE_WINDOW,
        )?;
        // Lease expiry remains observable even through Guest activation and a
        // status-lock await; a delayed consume never starts a new five seconds.
        let guest = tokio::select! {
            biased;
            () = lease.closed() => return None,
            result = async {
                if *live.borrow() == ActiveRunReuseState::Released
                    || ctx.status.running_sandbox(first.run_id).await != Some(sandbox_id) {
                    return None;
                }
                let guest = ctx.guest.open_for_sandbox(first.run_id, &sandbox_key).await.ok()?;
                let observer = guest.cancellation();
                tokio::select! {
                    biased;
                    () = observer.cancelled() => return None,
                    result = async {
                        if *live.borrow() == ActiveRunReuseState::Released
                            || ctx.status.running_sandbox(first.run_id).await != Some(sandbox_id) {
                            return None;
                        }
                        ws.send(Message::Text(r#"{"type":"auth.ok"}"#.into())).await.ok()?;
                        Some(())
                    } => result?,
                }
                Some(guest)
            } => result?,
        };
        Some((ws, first.run_id, sandbox_id, live, guest, lease))
    })
    .await;
    let Ok(Some((mut ws, run_id, sandbox_id, mut live, guest, lease))) = admitted else {
        return;
    };
    drop(handshake);
    let observer = guest.cancellation();
    let mut guest_cancelled = Box::pin(async {
        tokio::select! {
            biased;
            () = lease.closed() => (),
            () = observer.cancelled() => (),
        }
    });
    let (mut incoming, outgoing) = guest.split();
    // Native frame reads are not cancellation-safe partway through a header.
    // Unfold owns the in-flight receive across next() cancellations caused by
    // status ticks or client writes. Never resume a discarded partial read.
    let frames = futures_util::stream::unfold(outgoing, |mut receiver| async move {
        match receiver.recv().await {
            Ok(Some(frame)) => Some((Ok(frame), receiver)),
            Ok(None) => None,
            Err(error) => Some((Err(error), receiver)),
        }
    });
    tokio::pin!(frames);
    // No bridge tasks or application staging queues. Each direction owns at
    // most one bounded frame while native Unix/vsock IO applies backpressure.
    let mut run_check = tokio::time::interval(Duration::from_millis(250));
    let peer_closed = 'connection: loop {
        tokio::select! {
            biased;
            () = &mut guest_cancelled => break false,
            changed = live.changed() => {
                if changed.is_err() || *live.borrow() == ActiveRunReuseState::Released { break false }
            }
            _ = run_check.tick() => {
                if !tokio::select! {
                    biased;
                    () = &mut guest_cancelled => false,
                    _ = live.changed() => false,
                    result = ctx.status.running_sandbox(run_id) => result == Some(sandbox_id),
                } { break false }
            }
            inbound = ws.next() => match inbound {
                Some(Ok(Message::Binary(bytes))) if bytes.len() <= MAX_FRAME => {
                    if !forward_while_live(incoming.send(&bytes), &ctx,
                        run_id, sandbox_id, &mut live, &mut run_check, &mut guest_cancelled).await {
                        break 'connection false;
                    }
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {},
                Some(Ok(Message::Close(_))) => break true,
                None | Some(_) => break false,
            },
            outbound = frames.next() => match outbound {
                Some(Ok(bytes)) if bytes.len() <= MAX_FRAME => {
                    if !forward_while_live(ws.send(Message::Binary(bytes.into())), &ctx,
                        run_id, sandbox_id, &mut live, &mut run_check, &mut guest_cancelled).await {
                        break 'connection false;
                    }
                }
                _ => break false,
            }
        }
    };
    // Only a normal peer close gets a graceful acknowledgement. An interrupted
    // sink send can leave application bytes buffered; dropping the transport
    // at a liveness/deadline fence must not flush those bytes afterward.
    if peer_closed {
        // Tungstenite already queued the peer's close reply. Sending another
        // Close is rejected in this state; flush only that queued control reply.
        tokio::select! {
            biased;
            () = &mut guest_cancelled => (),
            _ = tokio::time::timeout(Duration::from_secs(1), ws.flush()) => (),
        }
    }
    drop(ws);
}

async fn forward_while_live<F, E, C>(
    forward: F,
    ctx: &ConnectionContext,
    run_id: RunId,
    sandbox_id: SandboxId,
    live: &mut tokio::sync::watch::Receiver<ActiveRunReuseState>,
    run_check: &mut tokio::time::Interval,
    guest_cancelled: &mut C,
) -> bool
where
    F: std::future::Future<Output = Result<(), E>>,
    C: std::future::Future<Output = ()> + Unpin,
{
    if *live.borrow() == ActiveRunReuseState::Released {
        return false;
    }
    // Keep the same IO future and deadline across status ticks: recreating
    // either would lose a queued frame or extend the stalled-write deadline.
    tokio::pin!(forward);
    let deadline = tokio::time::sleep(Duration::from_secs(15));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            biased;
            () = &mut *guest_cancelled => return false,
            _ = live.changed() => return false,
            _ = &mut deadline => return false,
            _ = run_check.tick() => {
                if !tokio::select! {
                    biased;
                    () = &mut *guest_cancelled => false,
                    _ = live.changed() => false,
                    _ = &mut deadline => false,
                    result = ctx.status.running_sandbox(run_id) => result == Some(sandbox_id),
                } { return false; }
            }
            result = &mut forward => return result.is_ok(),
        }
    }
}

#[cfg(test)]
mod tests;
