//! Invocation-owned synthetic history/storage/finalization peer for real Guests.

use std::{
    collections::HashMap,
    convert::Infallible,
    io::Read,
    net::Ipv4Addr,
    sync::{Arc, Mutex},
};

use api_contracts::generated::types::webhooks::agent::{
    session_history::prepare as history, storages,
};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Method, Request, Response, StatusCode, body::Incoming, service::service_fn};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use super::{TestResult, io};

pub const TOKEN: &str = "native-continuation-synthetic-token";
const MAX_HISTORY: u64 = 4 * 1024 * 1024;

#[derive(Default)]
struct Ledger {
    histories: HashMap<String, Vec<u8>>,
    history_preparations: HashMap<String, history::Request>,
    storage_preparations: HashMap<String, storages::prepare::Request>,
    uploads: HashMap<String, Vec<u8>>,
    completions: HashMap<String, Value>,
    history_reads: usize,
    errors: Vec<String>,
}

enum Reply {
    Json(Value),
    Raw(Vec<u8>),
    Empty,
}

pub struct Api {
    pub url: String,
    pub host_url: String,
    ledger: Arc<Mutex<Ledger>>,
    cancel: CancellationToken,
    connections: TaskTracker,
    listener: tokio::task::JoinHandle<io::Result<()>>,
}

impl Api {
    pub async fn start() -> TestResult<Self> {
        let address: Ipv4Addr = std::env::var("OKOU_TEST_NATIVE_API_HOST")?.parse()?;
        if !address.is_private() {
            return Err(
                io::Error::other("native API requires the supplied private host address").into(),
            );
        }
        Self::bind(address).await
    }

    pub async fn bind(address: Ipv4Addr) -> TestResult<Self> {
        let socket = TcpListener::bind((address, 0)).await?;
        let url = format!("http://{}", socket.local_addr()?);
        let local = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let host_url = format!("http://{}", local.local_addr()?);
        let ledger = Arc::new(Mutex::new(Ledger::default()));
        let cancel = CancellationToken::new();
        let connections = TaskTracker::new();
        let tasks = connections.clone();
        let stop = cancel.clone();
        let state = ledger.clone();
        let base = url.clone();
        let listener = tokio::spawn(async move {
            loop {
                let (stream, _) = tokio::select! {
                    () = stop.cancelled() => return Ok(()),
                    stream = socket.accept() => stream?,
                    stream = local.accept() => stream?,
                };
                let state = state.clone();
                let base = base.clone();
                tasks.spawn(async move {
                    let record = state.clone();
                    let service =
                        service_fn(move |request| respond(request, state.clone(), base.clone()));
                    if let Err(error) = hyper::server::conn::http1::Builder::new()
                        .keep_alive(false)
                        .serve_connection(TokioIo::new(stream), service)
                        .await
                        && let Ok(mut ledger) = record.lock()
                    {
                        ledger.errors.push(error.to_string());
                    }
                });
            }
        });
        Ok(Self {
            url,
            host_url,
            ledger,
            cancel,
            connections,
            listener,
        })
    }

    pub fn history_url(&self, bytes: &[u8]) -> TestResult<String> {
        let hash = hex::encode(Sha256::digest(bytes));
        self.ledger
            .lock()
            .map_err(|_| io::Error::other("native API ledger poisoned"))?
            .histories
            .insert(hash.clone(), bytes.to_vec());
        Ok(format!("{}/history/{hash}", self.url))
    }

    pub fn finalized_history(&self, run: &str, thread: &str) -> TestResult<Vec<u8>> {
        let state = self
            .ledger
            .lock()
            .map_err(|_| io::Error::other("native API ledger poisoned"))?;
        if !state.errors.is_empty() || state.history_reads == 0 {
            return Err(io::Error::other(format!(
                "native service did not complete real history work: {:?}",
                state.errors
            ))
            .into());
        }
        let complete = state
            .completions
            .get(run)
            .ok_or_else(|| io::Error::other("native completion was not acknowledged"))?;
        let completion = complete
            .get("completion")
            .ok_or_else(|| io::Error::other("native completion has no session"))?;
        if completion.get("cliAgentSessionId").and_then(Value::as_str) != Some(thread) {
            return Err(io::Error::other("native completion changed the original thread").into());
        }
        let hash = completion
            .get("cliAgentSessionHistoryHash")
            .and_then(Value::as_str)
            .ok_or_else(|| io::Error::other("native completion has no complete history hash"))?;
        state
            .histories
            .get(hash)
            .cloned()
            .ok_or_else(|| io::Error::other("complete native history was not uploaded").into())
    }

    pub async fn finish(self) -> TestResult<()> {
        self.cancel.cancel();
        self.listener.await??;
        self.connections.close();
        self.connections.wait().await;
        let state = self
            .ledger
            .lock()
            .map_err(|_| io::Error::other("native API ledger poisoned"))?;
        if !state.errors.is_empty() {
            return Err(
                io::Error::other(format!("native service errors: {:?}", state.errors)).into(),
            );
        }
        Ok(())
    }
}

async fn respond(
    request: Request<Incoming>,
    ledger: Arc<Mutex<Ledger>>,
    base: String,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let (parts, body) = request.into_parts();
    let result: TestResult<Reply> = async {
        let bytes = body.collect().await?.to_bytes();
        if bytes.len() > MAX_HISTORY as usize {
            return Err(io::Error::other("synthetic native request exceeds its fixture bound").into());
        }
        let path = parts.uri.path();
        let mut state = ledger.lock().map_err(|_| io::Error::other("native API ledger poisoned"))?;
        if parts.method == Method::GET && let Some(hash) = path.strip_prefix("/history/") {
            let bytes = state.histories.get(hash).cloned().ok_or_else(|| io::Error::other("unknown original history"))?;
            state.history_reads += 1;
            return Ok(Reply::Raw(bytes));
        }
        if parts.method == Method::PUT && let Some(run) = path.strip_prefix("/history-upload/") {
            let prepared = state.history_preparations.get(run).ok_or_else(|| io::Error::other("history upload was not prepared"))?;
            let mut raw = Vec::new();
            match prepared.encoding {
                None | Some(history::SessionHistoryEncoding::Identity) => raw.extend_from_slice(&bytes),
                Some(history::SessionHistoryEncoding::Gzip) => { flate2::read::GzDecoder::new(bytes.as_ref()).take(MAX_HISTORY + 1).read_to_end(&mut raw)?; }
                Some(history::SessionHistoryEncoding::Zstd) => { zstd::stream::read::Decoder::new(bytes.as_ref())?.take(MAX_HISTORY + 1).read_to_end(&mut raw)?; }
            }
            let hash = hex::encode(Sha256::digest(&raw));
            if prepared.hash != hash || prepared.raw_size != raw.len() as u64
                || prepared.encoded_size != bytes.len() as u64
            { return Err(io::Error::other("complete uploaded history differs from preparation").into()); }
            state.histories.insert(hash, raw);
            return Ok(Reply::Json(json!({})));
        }
        if parts.method == Method::PUT && let Some(key) = path.strip_prefix("/storage-upload/") {
            state.uploads.insert(key.to_string(), bytes.to_vec());
            return Ok(Reply::Json(json!({})));
        }
        if parts.method == Method::PUT && path.starts_with("/api/runners/runs/") && path.ends_with("/startup") {
            return Ok(Reply::Empty);
        }
        let value: Value = serde_json::from_slice(&bytes)?;
        let run = value.get("runId").and_then(Value::as_str).ok_or_else(|| io::Error::other("native request has no original run"))?.to_string();
        uuid::Uuid::parse_str(&run)?;
        if parts.method != Method::POST || parts.headers.get("authorization").and_then(|h| h.to_str().ok()) != Some(format!("Bearer {TOKEN}").as_str()) {
            return Err(io::Error::other("native synthetic peer rejected method or token").into());
        }
        match path {
            "/api/webhooks/agent/session-history/prepare" => {
                let typed: history::Request = serde_json::from_value(value)?;
                if typed.raw_size == 0 || typed.raw_size > MAX_HISTORY || typed.hash.len() != 64 {
                    return Err(io::Error::other("invalid native history preparation").into());
                }
                let response = serde_json::to_value(history::Response {
                    existing: false, presigned_url: Some(format!("{base}/history-upload/{run}")), encoding: typed.encoding,
                })?;
                state.history_preparations.insert(run, typed);
                Ok(Reply::Json(response))
            }
            "/api/webhooks/agent/complete" => {
                let hash = value.pointer("/completion/cliAgentSessionHistoryHash").and_then(Value::as_str)
                    .ok_or_else(|| io::Error::other("native completion has no history identity"))?;
                if !state.histories.contains_key(hash) || !value.get("exitCode").is_some_and(Value::is_i64) {
                    return Err(io::Error::other("native completion precedes complete history upload").into());
                }
                let status = if value.get("exitCode").and_then(Value::as_i64) == Some(0) {"completed"} else {"failed"};
                state.completions.insert(run, value);
                Ok(Reply::Json(json!({"success": true, "status": status})))
            }
            "/api/webhooks/agent/storages/prepare" => {
                let typed: storages::prepare::Request = serde_json::from_value(value)?;
                let version = hex::encode(Sha256::digest(serde_json::to_vec(&typed.files)?));
                state.storage_preparations.insert(run.clone(), typed);
                Ok(Reply::Json(json!({"versionId": version, "existing": false, "uploads": {
                    "archive": {"key": "archive", "presignedUrl": format!("{base}/storage-upload/{run}-archive")},
                    "manifest": {"key": "manifest", "presignedUrl": format!("{base}/storage-upload/{run}-manifest")}
                }})))
            }
            "/api/webhooks/agent/storages/commit" => {
                let typed: storages::commit::Request = serde_json::from_value(value)?;
                let prepared = state.storage_preparations.get(&run).ok_or_else(|| io::Error::other("native storage commit was not prepared"))?;
                if prepared.files != typed.files
                    || !state.uploads.contains_key(&format!("{run}-archive"))
                    || !state.uploads.contains_key(&format!("{run}-manifest")) {
                    return Err(io::Error::other("native storage commit precedes its original uploads").into());
                }
                Ok(Reply::Json(json!({"success": true, "versionId": typed.version_id, "storageName": "workspace", "size": typed.files.iter().map(|f| f.size).sum::<u64>(), "fileCount": typed.files.len()})))
            }
            "/api/webhooks/agent/events" | "/api/webhooks/agent/heartbeat" | "/api/webhooks/agent/telemetry" => Ok(Reply::Json(json!({}))),
            _ => Err(io::Error::other(format!("unexpected native synthetic route: {path}")).into()),
        }
    }.await;
    let encoded = match result {
        Ok(Reply::Raw(bytes)) => Ok((StatusCode::OK, bytes)),
        Ok(Reply::Empty) => Ok((StatusCode::NO_CONTENT, Vec::new())),
        Ok(Reply::Json(value)) => serde_json::to_vec(&value)
            .map(|bytes| (StatusCode::OK, bytes))
            .map_err(|e| e.to_string()),
        Err(error) => Err(error.to_string()),
    };
    let (status, bytes) = match encoded {
        Ok(reply) => reply,
        Err(error) => {
            if let Ok(mut state) = ledger.lock() {
                state.errors.push(error.clone());
            }
            (StatusCode::BAD_REQUEST, error.into_bytes())
        }
    };
    let mut response = Response::new(Full::new(Bytes::from(bytes)));
    *response.status_mut() = status;
    Ok(response)
}
