//! Ticket admission on the owning Runner. Caddy's URL chooses a process; only
//! the API ticket AND an exact local live run-to-sandbox assignment grant data.
//! The executor's shared registry supplies the exact live Guest attachment;
//! unavailable or cancelled assignments fail closed before any acknowledgement.

use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
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
use sha2::{Digest, Sha256};
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
const MAX_AUTHORITY_RESPONSE_BYTES: usize = 4 * 1024;

fn digest_of(ticket: &str) -> String {
    hex::encode(Sha256::digest(ticket.as_bytes()))
}

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

#[async_trait]
pub(super) trait TicketConsumer: Send + Sync {
    async fn consume(
        &self,
        run_id: RunId,
        runner_id: Uuid,
        origin: &str,
        ticket: &str,
    ) -> Option<()>;
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
    ) -> Option<()> {
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
        let body: ConsumeResponse =
            read_authority_result(response, MAX_AUTHORITY_RESPONSE_BYTES).await?;
        (body.run_id.parse::<RunId>().ok() == Some(run_id)
            && body.runner_id.parse::<Uuid>().ok() == Some(runner_id)
            && body.origin == origin
            && !body.org_id.is_empty()
            && !body.user_id.is_empty()
            && body.digest == digest_of(ticket))
        .then_some(())
    }
}

async fn read_authority_result<T: serde::de::DeserializeOwned>(
    mut response: reqwest::Response,
    limit: usize,
) -> Option<T> {
    if response.status() != reqwest::StatusCode::OK {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if chunk.len() > limit - bytes.len() {
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
    }
}

pub(super) struct StartedListener {
    pub task: AcceptTask,
    pub started: tokio::sync::oneshot::Receiver<()>,
}

/// Start only from the owning reactor, using its exact executor registry.
/// This one supervised task owns both accepting and bounded admission before
/// startup readiness; no raw-socket queue or caller-instantiated reactor exists.
pub(super) fn start(
    config: super::WssConfig,
    runner_id: Uuid,
    guest: RunGuestChannels,
    shared: &super::RunnerSharedState,
    provider: &super::ProviderState,
    lifecycle: &super::LifecycleController,
) -> io::Result<StartedListener> {
    let socket =
        runner_host::runner_wss_socket::RunnerWssSocket::bind(&config.socket_dir, runner_id)?;
    let download_socket =
        runner_host::runner_wss_socket::RunnerWssSocket::bind(&config.download_dir, runner_id)?;
    #[cfg(test)]
    let mut fail_accept = config.fail_accept;
    let mut admission = Admission::new(
        runner_id,
        config.hostname.as_deref(),
        config.consumer,
        guest,
        shared.active_runs.clone(),
        Arc::clone(&shared.status),
    );
    let mut downloads = super::runner_download::Admission::new(
        runner_id,
        admission
            .origin
            .as_ref()
            .map(|origin| origin.replacen("wss:", "https:", 1)),
        config.download_consumer,
        admission.guest.clone(),
        shared.active_runs.clone(),
        Arc::clone(&shared.status),
    );
    let (started_tx, started) = tokio::sync::oneshot::channel();
    let stop = CancellationToken::new();
    let stop_in_task = stop.clone();
    let failed = Arc::new(AtomicBool::new(false));
    let failed_in_task = Arc::clone(&failed);
    let download_ready = Arc::new(AtomicBool::new(false));
    let ready_in_task = Arc::clone(&download_ready);
    let failure_cancel = provider.cancel.clone();
    let failure_tokens = provider.cancel_tokens.clone();
    let failure_lifecycle = lifecycle.clone();
    let task = tokio::spawn(async move {
        struct ReadyGuard(Arc<AtomicBool>);
        impl Drop for ReadyGuard {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _ready = ReadyGuard(Arc::clone(&ready_in_task));
        ready_in_task.store(true, Ordering::SeqCst);
        let _ = started_tx.send(());
        let result = loop {
            let event = tokio::select! {
                biased;
                _ = stop_in_task.cancelled() => break Ok(()),
                result = admission.reap(), if admission.has_tasks() => {
                    result.map(|()| None).map_err(io::Error::other)
                }
                result = downloads.reap(), if downloads.has_tasks() => {
                    result.map(|()| None).map_err(io::Error::other)
                }
                result = async {
                    // Keep shutdown/reaping priority above, but fairly poll the
                    // two public ingress listeners so download load cannot
                    // permanently outrank an already-waiting WSS connection.
                    tokio::select! {
                        result = download_socket.accept() => result.map(|stream| Some((true, stream))),
                        result = async {
                            #[cfg(not(test))]
                            { socket.accept().await }
                            #[cfg(test)]
                            {
                                if let Some(fail) = fail_accept.as_mut() {
                                    tokio::select! {
                                        result = socket.accept() => result,
                                        _ = fail => Err(io::Error::other("injected WSS accept failure")),
                                    }
                                } else {
                                    socket.accept().await
                                }
                            }
                        } => result.map(|stream| Some((false, stream))),
                    }
                } => result,
            };
            match event {
                Ok(Some((true, stream))) => downloads.accept(stream),
                Ok(Some((false, stream))) => admission.accept(stream),
                Ok(None) => {}
                Err(error) => {
                    ready_in_task.store(false, Ordering::SeqCst);
                    failed_in_task.store(true, Ordering::SeqCst);
                    super::signals::handle_stopping_signal(
                        "wss-accept-failure",
                        &failure_cancel,
                        &failure_tokens,
                        &failure_lifecycle,
                    )
                    .await;
                    break Err(error);
                }
            }
        };
        ready_in_task.store(false, Ordering::SeqCst);
        downloads.stop().await;
        admission.stop().await;
        result
    });
    Ok(StartedListener {
        task: AcceptTask::new(task, stop, failed, download_ready),
        started,
    })
}

/// Own the supervised listener through startup and teardown. Normal stop
/// cancels admission and joins its connections before releasing the socket;
/// the drop guard prevents an unexpected return from detaching the task.
pub(super) struct AcceptTask {
    task: tokio::task::JoinHandle<io::Result<()>>,
    stop: CancellationToken,
    failed: Arc<AtomicBool>,
    download_ready: Arc<AtomicBool>,
    joined: bool,
}

impl AcceptTask {
    pub fn new(
        task: tokio::task::JoinHandle<io::Result<()>>,
        stop: CancellationToken,
        failed: Arc<AtomicBool>,
        download_ready: Arc<AtomicBool>,
    ) -> Self {
        Self {
            task,
            stop,
            failed,
            download_ready,
            joined: false,
        }
    }
    /// Failure is published before the task finishes joining its connections.
    pub fn download_readiness(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.download_ready)
    }
    pub fn has_failed(&self) -> bool {
        self.failed.load(Ordering::SeqCst)
    }
    /// Startup cannot publish readiness after any listener exit.
    pub fn failed_or_finished(&self) -> bool {
        self.has_failed() || self.task.is_finished()
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
        ctx.consumer
            .consume(first.run_id, ctx.runner_id, origin, &first.ticket)
            .await?;
        // The pre-auth timeout bounds all activation. Run release and Guest
        // cancellation remain observable through activation and blocked writes.
        let mut admission_live = live.clone();
        let guest = tokio::select! {
            biased;
            () = async {
                loop {
                    let released = *admission_live.borrow_and_update() == ActiveRunReuseState::Released;
                    if released || admission_live.changed().await.is_err() { return; }
                }
            } => return None,
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
        Some((ws, first.run_id, sandbox_id, live, guest))
    })
    .await;
    let Ok(Some((mut ws, run_id, sandbox_id, mut live, guest))) = admitted else {
        return;
    };
    drop(handshake);
    let observer = guest.cancellation();
    let mut guest_cancelled = Box::pin(observer.cancelled());
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
