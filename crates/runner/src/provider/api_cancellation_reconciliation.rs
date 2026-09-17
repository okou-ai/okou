//! Claim-scoped cancellation observation, independent of Ably and heartbeats.
//!
//! Each live registration owns one observer containing separate read and
//! delivery futures. Tokio's FIFO semaphore bounds reads across the provider;
//! each observer queues only one acquisition and retains one strongest intent.
//! No transfer-gate wait owns an HTTP permit. Retirement and provider shutdown
//! cancel the entire observer and join it through both lifetime owners.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use api_contracts::generated::{
    routes::runners::runs::by_run_id::cancellation as route,
    types::runners::runs::cancellation::{Response, ResponsePresentMode},
};
use reqwest::StatusCode;
use tokio::sync::{Semaphore, watch};
use tokio::time::{Instant, sleep_until, timeout};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use tracing::{info, warn};

use crate::http::HttpClient;
use crate::ids::RunId;
use crate::run_cancellation::{RunCancellationHandle, RunCancellationMode as Mode};
use crate::runner_process_identity::RunnerProcessIdentity;

const INTERVAL: Duration = Duration::from_secs(30);
const REQUEST_DEADLINE: Duration = Duration::from_secs(10);
const MAX_CONCURRENT_READS: usize = 8;
const MAX_RESPONSE_BYTES: usize = 4096;

pub(super) struct CancellationReconciliation {
    client: Arc<ReadClient>,
    permits: Arc<Semaphore>,
    tasks: TaskTracker,
    stopping: Mutex<bool>,
    cancel: CancellationToken,
}

struct ReadClient {
    http: HttpClient,
    group: String,
    identity: RunnerProcessIdentity,
}

/// Deliberately content-free: never retain response bodies or bearer tokens in
/// diagnostics, including errors returned by an old API or a proxy.
#[derive(Debug, Eq, PartialEq)]
enum ReadError {
    Transport,
    Status(StatusCode),
    Body,
    Oversized,
    Contract,
    Identity,
    Redirect,
    Deadline,
}

impl CancellationReconciliation {
    pub(super) fn new(http: HttpClient, group: String, identity: RunnerProcessIdentity) -> Self {
        Self {
            client: Arc::new(ReadClient {
                http,
                group,
                identity,
            }),
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT_READS)),
            tasks: TaskTracker::new(),
            stopping: Mutex::new(false),
            cancel: CancellationToken::new(),
        }
    }

    /// Called only after ClaimedJob validates a successful claim. Attachment is
    /// serialized with both exact registration retirement and provider shutdown.
    pub(super) fn observe(
        &self,
        run_id: RunId,
        handle: RunCancellationHandle,
        sandbox_token: String,
    ) -> bool {
        let stopping = self.stopping.lock().unwrap_or_else(|p| p.into_inner());
        if *stopping {
            return false;
        }
        let retirement = handle.retirement();
        let cancel = self.cancel.clone();
        let client = self.client.clone();
        let permits = self.permits.clone();
        let delivery_handle = handle.clone();
        handle.start_reconciliation(&self.tasks, async move {
            let (intent, pending) = watch::channel(None);
            tokio::select! {
                biased;
                () = retirement.cancelled() => {}
                () = cancel.cancelled() => {}
                _ = async {
                    tokio::join!(
                        read_loop(client, permits, run_id, sandbox_token, intent),
                        deliver_loop(run_id, delivery_handle, pending),
                    );
                } => {}
            }
        })
    }

    pub(super) async fn shutdown(&self) {
        {
            let mut stopping = self.stopping.lock().unwrap_or_else(|p| p.into_inner());
            *stopping = true;
            self.cancel.cancel();
            self.tasks.close();
        }
        self.tasks.wait().await;
    }
}

impl Drop for CancellationReconciliation {
    fn drop(&mut self) {
        // The explicit provider shutdown joins work. An abnormal owner drop
        // must still release queued requests, delivery waits and credentials.
        self.cancel.cancel();
        self.tasks.close();
    }
}

async fn read_loop(
    client: Arc<ReadClient>,
    permits: Arc<Semaphore>,
    run_id: RunId,
    sandbox_token: String,
    intent: watch::Sender<Option<Mode>>,
) {
    let mut due = Instant::now();
    loop {
        sleep_until(due).await;
        // Semaphore acquisitions retain FIFO position, including under new
        // arrivals. There is at most one queued/in-flight read per observer.
        let Ok(permit) = permits.acquire().await else {
            return;
        };
        let dispatched = Instant::now();
        let queue_wait = dispatched.saturating_duration_since(due);
        due = dispatched + INTERVAL;
        let result = timeout(REQUEST_DEADLINE, client.read(run_id, &sandbox_token))
            .await
            .unwrap_or(Err(ReadError::Deadline));
        drop(permit);
        match result {
            Ok(Some(mode)) => {
                let changed = intent.send_if_modified(|pending| {
                    if pending.is_none_or(|previous| mode > previous) {
                        *pending = Some(mode);
                        true
                    } else {
                        false
                    }
                });
                if changed {
                    info!(%run_id, ?mode, queue_wait_ms = queue_wait.as_millis(),
                        observation_ms = dispatched.elapsed().as_millis(),
                        "cancellation reconciliation observed stop intent");
                }
            }
            Ok(None) => {}
            Err(error) => {
                warn!(%run_id, ?error, "cancellation reconciliation inconclusive");
            }
        }
    }
}

async fn deliver_loop(
    run_id: RunId,
    handle: RunCancellationHandle,
    mut pending: watch::Receiver<Option<Mode>>,
) {
    while pending.changed().await.is_ok() {
        let mode = *pending.borrow_and_update();
        let Some(mut mode) = mode else { continue };
        let waiting = Instant::now();
        loop {
            let delivery_mode = mode;
            let delivered = handle.request_reconciled_cancellation(delivery_mode);
            tokio::select! {
                biased;
                changed = pending.changed() => {
                    if changed.is_err() { return; }
                    // Restart a blocked gate wait with the strongest observed
                    // mode, rather than accumulating delivery tasks.
                    if let Some(stronger) = *pending.borrow_and_update() {
                        mode = stronger;
                    }
                }
                changed = delivered => {
                    if changed {
                        info!(%run_id, ?mode, gate_wait_ms = waiting.elapsed().as_millis(),
                            "cancellation reconciliation applied stop intent");
                    }
                    break;
                }
            }
        }
    }
}

impl ReadClient {
    async fn read(&self, run_id: RunId, sandbox_token: &str) -> Result<Option<Mode>, ReadError> {
        let expected_run_id = run_id.to_string();
        let runner_id = self.identity.runner_id().to_string();
        let generation = self.identity.heartbeat_generation().to_string();
        let request = self
            .http
            .request_resolved_route(
                route::route(route::Params {
                    run_id: &expected_run_id,
                }),
                sandbox_token,
            )
            .timeout(REQUEST_DEADLINE)
            .prepare("run cancellation reconciliation")
            .map_err(|_| ReadError::Transport)?
            .query(&[
                ("runnerGroup", &self.group),
                ("runnerId", &runner_id),
                ("heartbeatGeneration", &generation),
            ]);
        let requested_url = request.url().clone();
        let mut response = request.send().await.map_err(|_| ReadError::Transport)?;
        if response.url() != &requested_url {
            return Err(ReadError::Redirect);
        }
        if response.status() != StatusCode::OK {
            return Err(ReadError::Status(response.status()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(ReadError::Oversized);
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ReadError::Body)? {
            if chunk.len() > MAX_RESPONSE_BYTES - body.len() {
                return Err(ReadError::Oversized);
            }
            body.extend_from_slice(&chunk);
        }
        decode(&body, &expected_run_id)
    }
}

fn decode(body: &[u8], expected_run_id: &str) -> Result<Option<Mode>, ReadError> {
    // Generated nullable fields intentionally support ordinary serde behavior.
    // This authoritative stop protocol additionally requires exact v1 shape.
    let value: serde_json::Value = serde_json::from_slice(body).map_err(|_| ReadError::Contract)?;
    let object = value.as_object().ok_or(ReadError::Contract)?;
    let fields: &[&str] = match object.get("state").and_then(|state| state.as_str()) {
        Some("present") => &["state", "protocolVersion", "runId", "mode"],
        Some("gone" | "unavailable") => &["state", "protocolVersion", "runId"],
        _ => return Err(ReadError::Contract),
    };
    if object.len() != fields.len() || fields.iter().any(|field| !object.contains_key(*field)) {
        return Err(ReadError::Contract);
    }
    let response: Response = serde_json::from_slice(body).map_err(|_| ReadError::Contract)?;
    let (version, run_id, mode) = match response {
        Response::Present {
            protocol_version,
            run_id,
            mode,
        } => (
            protocol_version,
            run_id,
            mode.map(|mode| match mode {
                ResponsePresentMode::Cooperative => Mode::Cooperative,
                ResponsePresentMode::Hard => Mode::Hard,
            }),
        ),
        Response::Gone {
            protocol_version,
            run_id,
        } => (protocol_version, run_id, Some(Mode::Hard)),
        Response::Unavailable {
            protocol_version,
            run_id,
        } => (protocol_version, run_id, None),
    };
    if version != 1 || run_id != expected_run_id {
        return Err(ReadError::Identity);
    }
    Ok(mode)
}

#[cfg(test)]
mod tests;
