//! Invocation-owned storage and native completion peer for real Guests.

use std::{
    collections::HashMap,
    convert::Infallible,
    net::Ipv4Addr,
    sync::{Arc, Mutex},
};

use api_contracts::generated::types::webhooks::agent::storages;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
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
    claim: Option<Arc<super::claim_peer::Gate>>,
    storage_preparations: HashMap<String, storages::prepare::Request>,
    uploads: HashMap<String, Vec<u8>>,
    completions: HashMap<String, Value>,
    latest_run: Option<String>,
    runner_heartbeats: Vec<Value>,
    errors: Vec<String>,
}

enum Reply {
    Json(Value),
    Empty,
    Unavailable,
}

pub struct Api {
    pub url: String,
    pub host_url: String,
    ledger: Arc<Mutex<Ledger>>,
    cancel: CancellationToken,
    _stop_on_drop: tokio_util::sync::DropGuard,
    connections: TaskTracker,
    listener: tokio::task::JoinHandle<io::Result<()>>,
}

impl Api {
    pub fn hold_claim(
        &self,
        run: super::RunId,
        runner: runner_host::runner_process_identity::RunnerProcessIdentity,
    ) -> TestResult<Arc<super::claim_peer::Gate>> {
        let mut ledger = self
            .ledger
            .lock()
            .map_err(|_| io::Error::other("native API ledger poisoned"))?;
        if ledger.claim.is_some() {
            return Err(io::Error::other("native API claim already armed").into());
        }
        let claim = super::claim_peer::Gate::new(run, runner);
        ledger.claim = Some(claim.clone());
        Ok(claim)
    }

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
            _stop_on_drop: cancel.clone().drop_guard(),
            cancel,
            connections,
            listener,
        })
    }

    pub fn runner_heartbeats(&self) -> TestResult<Vec<Value>> {
        let state = self
            .ledger
            .lock()
            .map_err(|_| io::Error::other("native API ledger poisoned"))?;
        if !state.errors.is_empty() {
            return Err(io::Error::other("native heartbeat peer has errors").into());
        }
        Ok(state.runner_heartbeats.clone())
    }

    pub fn session(&self, run: Option<&str>) -> TestResult<(String, String)> {
        let state = self
            .ledger
            .lock()
            .map_err(|_| io::Error::other("native API ledger poisoned"))?;
        if !state.errors.is_empty() {
            return Err(io::Error::other("native API peer has errors").into());
        }
        let run = run
            .or(state.latest_run.as_deref())
            .ok_or_else(|| io::Error::other("native completion missing"))?;
        let id = state
            .completions
            .get(run)
            .and_then(|c| c.pointer("/completion/cliAgentSessionId"))
            .and_then(Value::as_str)
            .ok_or_else(|| io::Error::other("native completion session missing"))?;
        uuid::Uuid::parse_str(id)?;
        Ok((id.into(), run.into()))
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
        let bytes = Limited::new(body, MAX_HISTORY as usize).collect().await?.to_bytes();
        let path = parts.uri.path();
        if path.starts_with("/api/runners/jobs/") && path.ends_with("/claim") {
            let claim = ledger.lock().map_err(|_| io::Error::other("native API ledger poisoned"))?
                .claim.clone().ok_or_else(|| io::Error::other("unexpected native provider claim"))?;
            claim.reject(&parts, &bytes).await?;
            return Ok(Reply::Unavailable);
        }
        let mut state = ledger.lock().map_err(|_| io::Error::other("native API ledger poisoned"))?;
        if parts.method == Method::PUT && let Some(key) = path.strip_prefix("/storage-upload/") {
            state.uploads.insert(key.to_string(), bytes.to_vec());
            return Ok(Reply::Json(json!({})));
        }
        if parts.method == Method::PUT && path.starts_with("/api/runners/runs/") && path.ends_with("/startup") {
            return Ok(Reply::Empty);
        }
        let value: Value = serde_json::from_slice(&bytes)?;
        if parts.method != Method::POST || parts.headers.get("authorization").and_then(|h| h.to_str().ok()) != Some(format!("Bearer {TOKEN}").as_str()) {
            return Err(io::Error::other("native synthetic peer rejected method or token").into());
        }
        if path == "/api/runners/heartbeat" {
            if state.runner_heartbeats.len() >= 8 {
                return Err(io::Error::other("native heartbeat receipt limit exceeded").into());
            }
            let runner = value.get("runnerId").and_then(Value::as_str)
                .ok_or_else(|| io::Error::other("native heartbeat has no runner identity"))?;
            uuid::Uuid::parse_str(runner)?;
            if !value.get("snapshotGeneration").and_then(Value::as_u64).is_some_and(|n| n > 0)
                || !value.get("snapshotSequence").and_then(Value::as_u64).is_some_and(|n| n > 0)
            {
                return Err(io::Error::other("native heartbeat has no generation/sequence").into());
            }
            state.runner_heartbeats.push(json!({
                "received_ns": super::evidence::clocks()?.0,
                "acknowledgement_status": 204, "state": value,
            }));
            return Ok(Reply::Empty);
        }
        let run = value.get("runId").and_then(Value::as_str).ok_or_else(|| io::Error::other("native request has no original run"))?.to_string();
        uuid::Uuid::parse_str(&run)?;
        match path {
            "/api/webhooks/agent/complete" => {
                if value.pointer("/completion/cliAgentSessionHistoryDisposition").and_then(Value::as_str) != Some("native_only") || !value.get("exitCode").is_some_and(Value::is_i64) {
                    return Err(io::Error::other("native completion is missing current identity metadata").into());
                }
                state.latest_run = Some(run.clone());
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
        Ok(Reply::Unavailable) => Ok((StatusCode::NOT_FOUND, Vec::new())),
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
