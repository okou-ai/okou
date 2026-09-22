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
use tracing::{Level, info};

use crate::duration::duration_ms;
use crate::error::{
    ApiFailureKind, ApiRequestContext, ApiTransportCause, ApiTransportError, RunnerError,
};
use crate::http::{HttpClient, api_transport_cause};
use crate::run_cancellation::{RunCancellationHandle, RunCancellationMode as Mode};
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_types::ids::RunId;

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
    Prepare,
    Send,
    Transport(Box<ApiTransportError>),
    Status(StatusCode),
    Body(ApiTransportCause),
    Oversized,
    Contract,
    Identity,
    Redirect,
    Deadline(Box<ApiRequestContext>),
}

#[derive(Default)]
struct ReadFailures {
    episode: Option<ReadFailureEpisode>,
}

struct ReadFailureEpisode {
    started_at: Instant,
    consecutive_failures: u64,
    warned: bool,
}

struct ReadFailureDiagnostic<'a> {
    endpoint: &'a str,
    method: &'a str,
    host: &'a str,
    path: &'a str,
    client_request_id: &'a str,
    client_session_id: &'a str,
    client_version: &'a str,
    status: u16,
    stage: &'static str,
    kind: &'static str,
    cause: &'static str,
}

impl ReadError {
    fn is_transient(&self) -> bool {
        match self {
            Self::Deadline(_) => true,
            Self::Transport(error) => matches!(
                error.failure_cause,
                ApiTransportCause::Timeout | ApiTransportCause::ConnectionReset
            ),
            _ => false,
        }
    }

    fn diagnostic(&self) -> ReadFailureDiagnostic<'_> {
        match self {
            Self::Deadline(context) => ReadFailureDiagnostic {
                endpoint: context.endpoint_label,
                method: &context.method,
                host: &context.host,
                path: &context.path,
                client_request_id: &context.client_request_id,
                client_session_id: &context.client_session_id,
                client_version: &context.client_version,
                status: 0,
                stage: "deadline",
                kind: ApiFailureKind::Timeout.as_str(),
                cause: ApiTransportCause::Timeout.as_str(),
            },
            Self::Transport(error) => ReadFailureDiagnostic {
                endpoint: error.request.endpoint_label,
                method: &error.request.method,
                host: &error.request.host,
                path: &error.request.path,
                client_request_id: &error.request.client_request_id,
                client_session_id: &error.request.client_session_id,
                client_version: &error.request.client_version,
                status: 0,
                stage: "send",
                kind: error.failure_kind.as_str(),
                cause: error.failure_cause.as_str(),
            },
            Self::Status(status) => ReadFailureDiagnostic {
                status: status.as_u16(),
                stage: "status",
                kind: "http_status",
                ..ReadFailureDiagnostic::empty()
            },
            Self::Body(cause) => ReadFailureDiagnostic {
                status: StatusCode::OK.as_u16(),
                stage: "body",
                kind: ApiFailureKind::Body.as_str(),
                cause: cause.as_str(),
                ..ReadFailureDiagnostic::empty()
            },
            Self::Prepare => ReadFailureDiagnostic {
                stage: "prepare",
                kind: "local",
                ..ReadFailureDiagnostic::empty()
            },
            Self::Send => ReadFailureDiagnostic {
                stage: "send",
                kind: "local",
                ..ReadFailureDiagnostic::empty()
            },
            Self::Oversized => ReadFailureDiagnostic {
                stage: "body",
                kind: "oversized",
                ..ReadFailureDiagnostic::empty()
            },
            Self::Contract => ReadFailureDiagnostic {
                stage: "decode",
                kind: "contract",
                ..ReadFailureDiagnostic::empty()
            },
            Self::Identity => ReadFailureDiagnostic {
                stage: "decode",
                kind: "identity",
                ..ReadFailureDiagnostic::empty()
            },
            Self::Redirect => ReadFailureDiagnostic {
                stage: "response",
                kind: "redirect",
                ..ReadFailureDiagnostic::empty()
            },
        }
    }
}

impl ReadFailureDiagnostic<'_> {
    fn empty() -> Self {
        Self {
            endpoint: "",
            method: "",
            host: "",
            path: "",
            client_request_id: "",
            client_session_id: "",
            client_version: "",
            status: 0,
            stage: "",
            kind: "",
            cause: "",
        }
    }
}

impl ReadFailures {
    fn record(&mut self, run_id: RunId, error: &ReadError) {
        let episode = self.episode.get_or_insert_with(|| ReadFailureEpisode {
            started_at: Instant::now(),
            consecutive_failures: 0,
            warned: false,
        });
        episode.consecutive_failures = episode.consecutive_failures.saturating_add(1);
        let elapsed = episode.started_at.elapsed();
        let transient = error.is_transient();
        let warn = !episode.warned && (!transient || elapsed >= INTERVAL);
        if episode.consecutive_failures > 1 && !warn {
            return;
        }
        episode.warned |= warn;
        let diagnostic = error.diagnostic();

        macro_rules! emit {
            ($level:expr, $message:literal) => {
                tracing::event!(
                    target: "runner::provider::api_cancellation_reconciliation",
                    $level,
                    run_id = %run_id,
                    endpoint = diagnostic.endpoint,
                    method = diagnostic.method,
                    host = diagnostic.host,
                    path = diagnostic.path,
                    client_request_id = diagnostic.client_request_id,
                    client_session_id = diagnostic.client_session_id,
                    client_version = diagnostic.client_version,
                    status = diagnostic.status,
                    failure_stage = diagnostic.stage,
                    failure_kind = diagnostic.kind,
                    failure_cause = diagnostic.cause,
                    consecutive_failures = episode.consecutive_failures,
                    failure_elapsed_ms = duration_ms(elapsed),
                    degraded = episode.warned,
                    will_retry = true,
                    $message
                )
            };
        }

        if warn && transient {
            emit!(
                Level::WARN,
                "cancellation reconciliation reads degraded; will retry"
            );
        } else if warn {
            emit!(
                Level::WARN,
                "cancellation reconciliation read failed; will retry"
            );
        } else {
            emit!(
                Level::INFO,
                "cancellation reconciliation read failed; will retry"
            );
        }
    }

    fn recover(&mut self, run_id: RunId) {
        let Some(episode) = self.episode.take() else {
            return;
        };
        info!(
            target: "runner::provider::api_cancellation_reconciliation",
            run_id = %run_id,
            recovered_after_failures = episode.consecutive_failures,
            failure_elapsed_ms = duration_ms(episode.started_at.elapsed()),
            was_degraded = episode.warned,
            "cancellation reconciliation read recovered"
        );
    }
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
    let mut failures = ReadFailures::default();
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
        let result = client.read(run_id, &sandbox_token).await;
        drop(permit);
        let mode = match result {
            Ok(mode) => {
                failures.recover(run_id);
                mode
            }
            Err(error) => {
                failures.record(run_id, &error);
                continue;
            }
        };
        if let Some(mode) = mode {
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
            .map_err(|_| ReadError::Prepare)?
            .query(&[
                ("runnerGroup", &self.group),
                ("runnerId", &runner_id),
                ("heartbeatGeneration", &generation),
            ]);
        let request_context = request.context().clone();
        let requested_url = request.url().clone();
        let read = timeout(REQUEST_DEADLINE, async move {
            let mut response = request.send().await.map_err(|error| match error {
                RunnerError::ApiTransport(error) => ReadError::Transport(error),
                _ => ReadError::Send,
            })?;
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
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|error| ReadError::Body(api_transport_cause(&error)))?
            {
                if chunk.len() > MAX_RESPONSE_BYTES - body.len() {
                    return Err(ReadError::Oversized);
                }
                body.extend_from_slice(&chunk);
            }
            decode(&body, &expected_run_id)
        })
        .await;

        match read {
            Err(_) => Err(ReadError::Deadline(Box::new(request_context))),
            Ok(Err(ReadError::Transport(error)))
                if error.failure_kind == ApiFailureKind::Timeout
                    || error.failure_cause == ApiTransportCause::Timeout =>
            {
                Err(ReadError::Deadline(Box::new(request_context)))
            }
            Ok(Err(ReadError::Body(ApiTransportCause::Timeout))) => {
                Err(ReadError::Deadline(Box::new(request_context)))
            }
            Ok(result) => result,
        }
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
