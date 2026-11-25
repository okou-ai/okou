//! Run-owned, single-use WebSocket admission on the shared ingress socket.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::header::{CACHE_CONTROL, CONTENT_TYPE, HeaderValue, UPGRADE};
use hyper::upgrade::OnUpgrade;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use runner_lifecycle::active_runs::{ActiveRunReuseState, ActiveRuns};
use runner_provider::RunCancellationRegistry;
use runner_types::ids::RunId;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use tokio::time::{Instant, timeout};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::server::create_response;
use tokio_tungstenite::tungstenite::{Message, protocol::Role, protocol::WebSocketConfig};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use super::{IngressHandler, has_empty_body, response};

const TICKET_LIFETIME: Duration = Duration::from_secs(30);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PENDING_TICKETS: usize = 256;
const MAX_PENDING_TICKETS_PER_RUN: usize = 16;
const MAX_HANDSHAKES: usize = 16;
const MAX_CONNECTIONS: usize = 32;
const MAX_MESSAGE_BYTES: usize = 256;
const GENERATION_HEADER: &str = "x-okou-runner-heartbeat-generation";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FirstFrame {
    run_id: RunId,
    ticket: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IssuedTicket {
    ticket: String,
    expires_at: String,
}

struct LiveRun {
    state: watch::Receiver<ActiveRunReuseState>,
    cancel: CancellationToken,
}

impl LiveRun {
    fn is_live(&self) -> bool {
        !self.cancel.is_cancelled() && *self.state.borrow() == ActiveRunReuseState::Pending
    }

    async fn ended(&mut self) {
        tokio::select! {
            () = self.cancel.cancelled() => {},
            _ = self.state.wait_for(|state| *state != ActiveRunReuseState::Pending) => {},
        }
    }
}

struct PendingTicket {
    run_id: RunId,
    expires: Instant,
    run: LiveRun,
}

impl PendingTicket {
    fn is_redeemable(&self, now: Instant) -> bool {
        now < self.expires && self.run.is_live()
    }
}

type TicketDigest = [u8; 32];

pub(super) struct RunWebSocket {
    active_runs: ActiveRuns,
    cancellations: RunCancellationRegistry,
    tickets: Mutex<HashMap<TicketDigest, PendingTicket>>,
    handshakes: Arc<Semaphore>,
    connections: Arc<Semaphore>,
    cancel: CancellationToken,
    tasks: TaskTracker,
}

impl RunWebSocket {
    pub(super) fn new(
        active_runs: ActiveRuns,
        cancellations: RunCancellationRegistry,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            active_runs,
            cancellations,
            tickets: Mutex::default(),
            handshakes: Arc::new(Semaphore::new(MAX_HANDSHAKES)),
            connections: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
            cancel,
            tasks: TaskTracker::new(),
        }
    }

    pub(super) async fn join(&self) {
        // The ingress owner has cancelled this token and joined its HTTP tasks.
        self.tasks.close();
        self.tasks.wait().await;
    }

    async fn issue(&self, run_id: RunId) -> Result<IssuedTicket, StatusCode> {
        let state = self
            .active_runs
            .watch_live_run(run_id)
            .ok_or(StatusCode::NOT_FOUND)?;
        let cancel = self
            .cancellations
            .handle(run_id)
            .await
            .ok_or(StatusCode::NOT_FOUND)?
            .token();
        let run = LiveRun { state, cancel };
        if !run.is_live() {
            return Err(StatusCode::NOT_FOUND);
        }
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret).map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        let ticket = URL_SAFE_NO_PAD.encode(secret);
        let digest = Sha256::digest(ticket.as_bytes()).into();
        let mut tickets = self
            .tickets
            .lock()
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        let now = Instant::now();
        tickets.retain(|_, pending| pending.is_redeemable(now));
        if tickets.len() >= MAX_PENDING_TICKETS
            || tickets
                .values()
                .filter(|pending| pending.run_id == run_id)
                .count()
                >= MAX_PENDING_TICKETS_PER_RUN
        {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        let std::collections::hash_map::Entry::Vacant(entry) = tickets.entry(digest) else {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        };
        entry.insert(PendingTicket {
            run_id,
            expires: now + TICKET_LIFETIME,
            run,
        });
        let expires_at = (chrono::Utc::now() + TICKET_LIFETIME)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        Ok(IssuedTicket { ticket, expires_at })
    }

    fn redeem(&self, run_id: RunId, frame: &str) -> Option<LiveRun> {
        let first = serde_json::from_str::<FirstFrame>(frame).ok()?;
        if first.run_id != run_id
            || URL_SAFE_NO_PAD.decode(first.ticket.as_bytes()).ok()?.len() != 32
        {
            return None;
        }
        let digest: TicketDigest = Sha256::digest(first.ticket.as_bytes()).into();
        let mut tickets = self.tickets.lock().ok()?;
        let pending = tickets.get(&digest)?;
        if pending.run_id != run_id || !pending.is_redeemable(Instant::now()) {
            return None;
        }
        tickets.remove(&digest).map(|pending| pending.run)
    }

    fn upgrade(
        self: &Arc<Self>,
        request: Request<Incoming>,
        run_id: RunId,
    ) -> Response<Full<Bytes>> {
        let mut request = request.map(|_| ());
        let Ok(reply) = create_response(&request) else {
            return response(StatusCode::BAD_REQUEST, "");
        };
        let (Ok(connection), Ok(handshake)) = (
            self.connections.clone().try_acquire_owned(),
            self.handshakes.clone().try_acquire_owned(),
        ) else {
            return response(StatusCode::TOO_MANY_REQUESTS, "");
        };
        let upgraded = hyper::upgrade::on(&mut request);
        let server = self.clone();
        self.tasks.spawn(async move {
            let _connection = connection;
            tokio::select! {
                biased;
                () = server.cancel.cancelled() => {},
                () = server.serve(upgraded, run_id, handshake) => {},
            }
        });
        reply.map(|_| Full::default())
    }

    async fn serve(&self, upgraded: OnUpgrade, run_id: RunId, handshake: OwnedSemaphorePermit) {
        let admitted = timeout(HANDSHAKE_TIMEOUT, async {
            let stream = TokioIo::new(upgraded.await.ok()?);
            let config = WebSocketConfig::default()
                .read_buffer_size(1024)
                .write_buffer_size(0)
                .max_write_buffer_size(1024)
                .max_frame_size(Some(MAX_MESSAGE_BYTES))
                .max_message_size(Some(MAX_MESSAGE_BYTES));
            let mut ws = WebSocketStream::from_raw_socket(stream, Role::Server, Some(config)).await;
            let Some(Ok(Message::Text(first))) = ws.next().await else {
                return None;
            };
            let mut run = self.redeem(run_id, &first)?;
            tokio::select! {
                biased;
                () = run.ended() => return None,
                result = ws.send(Message::Text(r#"{"type":"auth.ok"}"#.into())) => result.ok()?,
            }
            Some((ws, run))
        })
        .await;
        drop(handshake);
        let Ok(Some((mut ws, mut run))) = admitted else {
            return;
        };
        tokio::select! {
            biased;
            () = run.ended() => {},
            () = async {
                while let Some(Ok(message)) = ws.next().await {
                    match message {
                        Message::Pong(_) => continue,
                        Message::Ping(_) => {
                            if !matches!(timeout(HANDSHAKE_TIMEOUT, ws.flush()).await, Ok(Ok(()))) {
                                break;
                            }
                        }
                        Message::Close(_) => {
                            let _ = timeout(HANDSHAKE_TIMEOUT, ws.flush()).await;
                            break;
                        }
                        _ => break,
                    }
                }
            } => {},
        }
    }
}

impl IngressHandler {
    pub(super) async fn handle_run_wss(&self, request: Request<Incoming>) -> Response<Full<Bytes>> {
        let Some(run_wss) = self.run_wss.get() else {
            return response(StatusCode::NOT_FOUND, "");
        };
        let runner_path = format!("/runners/{}/", self.identity.runner_id());
        let Some(path) = request.uri().path().strip_prefix(&runner_path) else {
            return response(StatusCode::NOT_FOUND, "");
        };
        if !self.matches_host(&request) {
            return response(StatusCode::NOT_FOUND, "");
        }
        if let Some(run_id) = path.strip_prefix("runs/").and_then(canonical_run_id) {
            if request.method() != Method::GET {
                return response(StatusCode::METHOD_NOT_ALLOWED, "");
            }
            if !has_empty_body(&request) {
                return response(StatusCode::BAD_REQUEST, "");
            }
            return run_wss.upgrade(request, run_id);
        }
        let Some(run_id) = path
            .strip_prefix("control/runs/")
            .and_then(|run| run.strip_suffix("/wss-ticket"))
            .and_then(canonical_run_id)
        else {
            return response(StatusCode::NOT_FOUND, "");
        };
        if !self.has_service_auth(&request) {
            return response(StatusCode::UNAUTHORIZED, "");
        }
        if request.method() != Method::POST {
            return response(StatusCode::METHOD_NOT_ALLOWED, "");
        }
        if request.headers().contains_key(UPGRADE) || !has_empty_body(&request) {
            return response(StatusCode::BAD_REQUEST, "");
        }
        let mut generations = request.headers().get_all(GENERATION_HEADER).iter();
        if !matches!((generations.next(), generations.next()), (Some(value), None) if value == &self.identity.heartbeat_generation().to_string())
        {
            return response(StatusCode::NOT_FOUND, "");
        }
        let ticket = match run_wss.issue(run_id).await {
            Ok(ticket) => ticket,
            Err(status) => return response(status, ""),
        };
        let Ok(body) = serde_json::to_string(&ticket) else {
            return response(StatusCode::INTERNAL_SERVER_ERROR, "");
        };
        let mut reply = response(StatusCode::OK, &body);
        reply
            .headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        reply
            .headers_mut()
            .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        reply
    }
}

fn canonical_run_id(segment: &str) -> Option<RunId> {
    segment
        .parse::<RunId>()
        .ok()
        .filter(|id| id.to_string() == segment)
}

#[cfg(test)]
mod tests;
