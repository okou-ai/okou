//! Purpose-bound native HTTP downloads, independent of opaque WSS payload routing.
use api_contracts::generated::{
    routes::runners::files as routes, types::runners::files::ConsumeResponse,
};
use async_trait::async_trait;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, combinators::UnsyncBoxBody};
use hyper::{
    Request, Response, StatusCode, body::Incoming, server::conn::http1, service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use runner_lifecycle::{active_runs::ActiveRuns, status::StatusTracker};
use runner_provider::http::HttpClient;
use runner_remote::{file_reader::FileReader, guest_duplex::RunGuestChannels};
use runner_types::ids::RunId;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    convert::Infallible,
    io,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::{
    net::UnixStream,
    sync::{OwnedSemaphorePermit, Semaphore},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;
use uuid::Uuid;

mod transfer;
type Body = UnsyncBoxBody<Bytes, io::Error>;
const PREPARE_WAIT: Duration = Duration::from_secs(10);
const MAX_CONNECTIONS: usize = 32;
const MAX_DOWNLOADS: usize = 16;
const DOWNLOADS_PER_RUN: usize = 2;

#[async_trait]
pub(super) trait GrantConsumer: Send + Sync {
    async fn consume(
        &self,
        run: RunId,
        runner: Uuid,
        origin: &str,
        ticket: &str,
    ) -> io::Result<Option<ConsumeResponse>>;
}

pub(super) struct ApiGrantConsumer {
    http: HttpClient,
    token: String,
}
impl ApiGrantConsumer {
    pub fn new(http: HttpClient, token: String) -> Self {
        Self { http, token }
    }
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
impl GrantConsumer for ApiGrantConsumer {
    async fn consume(
        &self,
        run: RunId,
        runner: Uuid,
        origin: &str,
        ticket: &str,
    ) -> io::Result<Option<ConsumeResponse>> {
        let mut response = self
            .http
            .request_route(routes::CONSUME, &self.token)
            .json(&ConsumeRequest {
                run_id: run,
                runner_id: runner,
                origin,
                ticket,
            })
            .timeout(Duration::from_secs(5))
            .send("runner_file_download_consume")
            .await
            .map_err(|_| unavailable())?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if response.status() != reqwest::StatusCode::OK {
            return Err(unavailable());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
            if chunk.len() > 16 * 1024 - bytes.len() {
                return Err(unavailable());
            }
            bytes.extend_from_slice(&chunk);
        }
        let grant: ConsumeResponse = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
        if grant.run_id.parse::<RunId>().ok() != Some(run)
            || grant.runner_id.parse::<Uuid>().ok() != Some(runner)
            || grant.origin != origin
            || grant.org_id.is_empty()
            || grant.user_id.is_empty()
            || grant.digest != hex::encode(Sha256::digest(ticket.as_bytes()))
        {
            return Err(unavailable());
        }
        Ok(Some(grant))
    }
}

fn unavailable() -> io::Error {
    io::Error::other("file download unavailable")
}

#[derive(Clone)]
pub(super) struct Context {
    pub runner: Uuid,
    pub origin: Option<String>,
    pub consumer: Arc<dyn GrantConsumer>,
    pub guest: RunGuestChannels,
    pub active_runs: ActiveRuns,
    pub status: Arc<StatusTracker>,
    downloads: Arc<Semaphore>,
    per_run: Arc<Mutex<HashMap<RunId, Weak<Semaphore>>>>,
}
pub(super) struct Admission {
    context: Context,
    stop: CancellationToken,
    tasks: JoinSet<()>,
    connections: Arc<Semaphore>,
}
impl Admission {
    pub fn new(
        runner: Uuid,
        origin: Option<String>,
        consumer: Arc<dyn GrantConsumer>,
        guest: RunGuestChannels,
        active_runs: ActiveRuns,
        status: Arc<StatusTracker>,
    ) -> Self {
        Self {
            context: Context {
                runner,
                origin,
                consumer,
                guest,
                active_runs,
                status,
                downloads: Arc::new(Semaphore::new(MAX_DOWNLOADS)),
                per_run: Arc::new(Mutex::new(HashMap::new())),
            },
            stop: CancellationToken::new(),
            tasks: JoinSet::new(),
            connections: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
        }
    }
    pub fn accept(&mut self, stream: UnixStream) {
        if self.tasks.len() >= MAX_CONNECTIONS {
            return;
        }
        let Ok(permit) = self.connections.clone().try_acquire_owned() else {
            return;
        };
        let context = self.context.clone();
        let stop = self.stop.child_token();
        self.tasks.spawn(async move {
            let _connection = permit;
            serve(stream, context, stop).await;
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
        self.stop.cancel();
        while self.tasks.join_next().await.is_some() {}
    }
}

struct Connection {
    stop: CancellationToken,
    // Normal exit cancels and joins; unexpected owner drop also aborts the child.
    producer: Mutex<Option<AbortOnDropHandle<()>>>,
    // Retain admission through the actual HTTP connection, including its last write.
    permits: Mutex<Vec<OwnedSemaphorePermit>>,
}

async fn serve(stream: UnixStream, context: Context, stop: CancellationToken) {
    let connection = Arc::new(Connection {
        stop: stop.clone(),
        producer: Mutex::new(None),
        permits: Mutex::new(Vec::new()),
    });
    let service_connection = connection.clone();
    let service = service_fn(move |request| {
        let context = context.clone();
        let connection = service_connection.clone();
        async move {
            Ok::<_, Infallible>(
                tokio::time::timeout(PREPARE_WAIT, respond(request, context, connection))
                    .await
                    .unwrap_or_else(|_| empty(StatusCode::SERVICE_UNAVAILABLE)),
            )
        }
    });
    let mut http = http1::Builder::new();
    http.keep_alive(false)
        .max_headers(32)
        .max_buf_size(8192)
        .header_read_timeout(Duration::from_secs(5))
        .timer(TokioTimer::new());
    // Errors can contain the credential-bearing URI; never log the Hyper error.
    tokio::select! {
        biased;
        () = stop.cancelled() => (),
        _ = http.serve_connection(TokioIo::new(transfer::WriteDeadline::new(stream)), service) => (),
    }
    stop.cancel();
    // Even a panicking service must retire its already-published producer.
    let producer = match connection.producer.lock() {
        Ok(mut producer) => producer.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };
    if let Some(producer) = producer {
        let _ = producer.await;
    }
}

fn empty(status: StatusCode) -> Response<Body> {
    let body = Full::new(Bytes::new())
        .map_err(|never| match never {})
        .boxed_unsync();
    let mut response = Response::new(body);
    *response.status_mut() = status;
    response.headers_mut().insert(
        "cache-control",
        hyper::header::HeaderValue::from_static("no-store"),
    );
    response
}

fn requested_file(request: &Request<Incoming>, runner: Uuid) -> Option<(RunId, &str)> {
    if request.uri().query().is_some()
        || request.uri().path().len() > 160
        || request.headers().contains_key("range")
        || request.headers().contains_key("transfer-encoding")
        || request
            .headers()
            .get("content-length")
            .is_some_and(|v| v != "0")
    {
        return None;
    }
    let mut parts = request.uri().path().split('/');
    if !parts.next()?.is_empty()
        || parts.next()? != "downloads"
        || parts.next()? != runner.to_string()
    {
        return None;
    }
    let run_text = parts.next()?;
    let run = run_text.parse::<RunId>().ok()?;
    if run.to_string() != run_text {
        return None;
    }
    let ticket = parts.next()?;
    if parts.next().is_some()
        || ticket.len() != 43
        || !ticket
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return None;
    }
    Some((run, ticket))
}

async fn respond(
    request: Request<Incoming>,
    context: Context,
    connection: Arc<Connection>,
) -> Response<Body> {
    if request.method() != hyper::Method::GET {
        let mut response = empty(StatusCode::METHOD_NOT_ALLOWED);
        response
            .headers_mut()
            .insert("allow", hyper::header::HeaderValue::from_static("GET"));
        return response;
    }
    let Some((run, ticket)) = requested_file(&request, context.runner) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Some(origin) = context.origin.as_deref() else {
        return empty(StatusCode::SERVICE_UNAVAILABLE);
    };
    let Ok(download) = context.downloads.clone().try_acquire_owned() else {
        return empty(StatusCode::SERVICE_UNAVAILABLE);
    };
    let run_slots = {
        let Ok(mut entries) = context.per_run.lock() else {
            return empty(StatusCode::SERVICE_UNAVAILABLE);
        };
        entries.retain(|_, weak| weak.strong_count() > 0);
        let slots = entries
            .get(&run)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| Arc::new(Semaphore::new(DOWNLOADS_PER_RUN)));
        entries.insert(run, Arc::downgrade(&slots));
        slots
    };
    let Ok(run_permit) = run_slots.try_acquire_owned() else {
        return empty(StatusCode::SERVICE_UNAVAILABLE);
    };
    let Some(mut live) = context.active_runs.watch_live_run(run) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Some(sandbox) = context.status.running_sandbox(run).await else {
        return empty(StatusCode::NOT_FOUND);
    };
    let sandbox_key = sandbox.to_string();
    if !context.guest.contains_live_assignment(run, &sandbox_key) {
        return empty(StatusCode::NOT_FOUND);
    }
    let prepared = transfer::while_live(
        async {
            let grant = context
                .consumer
                .consume(run, context.runner, origin, ticket)
                .await?
                .ok_or_else(unavailable)?;
            if context.status.running_sandbox(run).await != Some(sandbox)
                || !context.guest.contains_live_assignment(run, &sandbox_key)
            {
                return Err(unavailable());
            }
            let channel = context.guest.open_for_sandbox(run, &sandbox_key).await?;
            let mut reader = FileReader::open(channel, grant.path).await?;
            if reader.size() == 0 {
                reader.next_chunk().await?;
            }
            Ok(reader)
        },
        transfer::Fence {
            context: &context,
            run,
            sandbox,
            live: &mut live,
            stop: &connection.stop,
            guest: None,
        },
    );
    let Ok(reader) = prepared.await else {
        return empty(StatusCode::SERVICE_UNAVAILABLE);
    };
    let size = reader.size();
    let disposition = disposition(reader.display_name());
    {
        let Ok(mut permits) = connection.permits.lock() else {
            return empty(StatusCode::SERVICE_UNAVAILABLE);
        };
        permits.extend([download, run_permit]);
    }
    let (sender, receiver) = tokio::sync::mpsc::channel::<Bytes>(1);
    let body = http_body_util::StreamBody::new(futures_util::stream::unfold(
        receiver,
        |mut receiver| async {
            receiver.recv().await.map(|chunk| {
                (
                    Ok::<_, io::Error>(hyper::body::Frame::data(chunk)),
                    receiver,
                )
            })
        },
    ))
    .boxed_unsync();
    let stop = connection.stop.clone();
    {
        let Ok(mut producer) = connection.producer.lock() else {
            return empty(StatusCode::SERVICE_UNAVAILABLE);
        };
        *producer = Some(AbortOnDropHandle::new(tokio::spawn(transfer::produce(
            reader, sender, context, run, sandbox, live, stop,
        ))));
    }
    let mut response = Response::new(body);
    let headers = response.headers_mut();
    for (key, value) in [
        ("content-type", "application/octet-stream"),
        ("cache-control", "no-store, no-transform"),
        ("x-content-type-options", "nosniff"),
        ("accept-ranges", "none"),
        ("referrer-policy", "no-referrer"),
    ] {
        headers.insert(key, hyper::header::HeaderValue::from_static(value));
    }
    let Ok(length) = size.to_string().parse() else {
        return empty(StatusCode::INTERNAL_SERVER_ERROR);
    };
    let Ok(filename) = disposition.parse() else {
        return empty(StatusCode::INTERNAL_SERVER_ERROR);
    };
    headers.insert("content-length", length);
    headers.insert("content-disposition", filename);
    response
}

fn disposition(name: &str) -> String {
    use std::fmt::Write;
    // The fs v3 result validator guarantees a nonempty, control-free label.
    let name: String = name.chars().take(120).collect();
    let fallback: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut encoded = String::new();
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}")
}

#[cfg(test)]
#[cfg(target_os = "linux")]
mod tests;
