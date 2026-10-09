//! Bounded best-effort transport for transient Pi assistant text.
//!
//! This path is deliberately independent from durable agent-event delivery:
//! it never allocates a public event sequence, never retries an uncertain HTTP
//! result, and never reports failure into the Run lifecycle. A failed block is
//! abandoned until its authoritative `message_end` event reconciles the UI.
//!
//! The Pi projection applies the configured normal secret policy after citation
//! normalization and before admitting chunks here. Each native text source
//! holds back at most the longest configured variant minus one bytes (plus UTF-8
//! boundary rounding) so a secret split across provider deltas cannot escape.
//! Completed messages flush their masked tail; interrupted/abandoned streams
//! discard it. With no eligible configured secrets, previews remain immediate.
//! The session-output and durable event wire formats are unchanged.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::mpsc;

use crate::error::AgentError;
use crate::http::HttpClient;
use crate::timing;
use guest_telemetry::log_warn;
use guest_telemetry::telemetry::record_sandbox_op;

use super::LOG_TAG;

const SESSION_OUTPUT_QUEUE_CAPACITY: usize = 256;
pub(super) const SESSION_OUTPUT_DELTA_MAX_BYTES: usize = 4096;
const SESSION_OUTPUT_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionOutputRequest<'a> {
    run_id: &'a str,
    thread_id: &'a str,
    run_event_id: &'a str,
    chunk_index: u32,
    delta: &'a str,
}

pub(super) struct SessionOutputChunk {
    pub(super) run_event_id: String,
    pub(super) delta: String,
}

/// Boundaries for the run's first published chunk: `pi_first_session_output`
/// from the Pi startup boundary, and `api_to_first_session_output` from the
/// API start time. See docs/chat-first-output-latency.md.
#[derive(Default)]
pub(super) struct FirstSessionOutputTiming {
    pub(super) pi_startup_succeeded_at: Option<Arc<OnceLock<Instant>>>,
    pub(super) api_start_time: String,
}

impl FirstSessionOutputTiming {
    fn record(&self, sent_at: Instant, sent_at_epoch_ms: u64, success: bool) {
        if let Some(startup) = self
            .pi_startup_succeeded_at
            .as_ref()
            .and_then(|boundary| boundary.get())
        {
            record_sandbox_op(
                "pi_first_session_output",
                sent_at.saturating_duration_since(*startup),
                success,
                None,
            );
        }
        timing::record_e2e_from_api_start_at(
            "api_to_first_session_output",
            &self.api_start_time,
            sent_at_epoch_ms,
        );
    }
}

#[derive(Default)]
struct SessionOutputState {
    disabled: AtomicBool,
    failed_blocks: Mutex<HashSet<String>>,
}

impl SessionOutputState {
    fn is_disabled(&self) -> bool {
        self.disabled.load(Ordering::Relaxed)
    }

    fn disable(&self) {
        self.disabled.store(true, Ordering::Relaxed);
    }

    fn block_failed(&self, run_event_id: &str) -> bool {
        self.failed_blocks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains(run_event_id)
    }

    fn fail_block(&self, run_event_id: &str) {
        self.failed_blocks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(run_event_id.to_string());
    }
}

#[derive(Clone)]
pub(super) struct PiSessionOutputSender {
    tx: mpsc::Sender<SessionOutputChunk>,
    state: Arc<SessionOutputState>,
    run_id: Arc<str>,
}

impl PiSessionOutputSender {
    /// Admit one already-bounded chunk without waiting for network or capacity.
    ///
    /// `false` permanently closes this block's preview. Durable projection is
    /// intentionally unaffected.
    pub(super) fn try_send(&self, run_event_id: &str, delta: String) -> bool {
        if delta.is_empty() {
            return true;
        }
        if self.state.is_disabled() || self.state.block_failed(run_event_id) {
            return false;
        }
        if delta.len() > SESSION_OUTPUT_DELTA_MAX_BYTES {
            self.state.fail_block(run_event_id);
            log_warn!(
                LOG_TAG,
                "Pi session output block exceeded its chunk bound: run_id={} run_event_id={run_event_id}",
                self.run_id
            );
            return false;
        }

        let chunk = SessionOutputChunk {
            run_event_id: run_event_id.to_string(),
            delta,
        };
        match self.tx.try_send(chunk) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.state.fail_block(run_event_id);
                log_warn!(
                    LOG_TAG,
                    "Pi session output queue full; stopped block preview: run_id={} run_event_id={run_event_id}",
                    self.run_id
                );
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.state.disable();
                log_warn!(
                    LOG_TAG,
                    "Pi session output worker unavailable; stopped run preview: run_id={}",
                    self.run_id
                );
                false
            }
        }
    }
}

#[cfg(test)]
pub(super) fn test_channel(
    capacity: usize,
    run_id: &str,
) -> (PiSessionOutputSender, mpsc::Receiver<SessionOutputChunk>) {
    let (tx, rx) = mpsc::channel(capacity);
    let state = Arc::new(SessionOutputState::default());
    (
        PiSessionOutputSender {
            tx,
            state,
            run_id: Arc::from(run_id),
        },
        rx,
    )
}

pub(super) fn start(
    http: HttpClient,
    run_id: &str,
    thread_id: &str,
    first_output: FirstSessionOutputTiming,
) -> Option<PiSessionOutputSender> {
    if !http.has_api()
        || uuid::Uuid::parse_str(run_id).is_err()
        || uuid::Uuid::parse_str(thread_id).is_err()
    {
        return None;
    }

    let (tx, rx) = mpsc::channel(SESSION_OUTPUT_QUEUE_CAPACITY);
    let state = Arc::new(SessionOutputState::default());
    let sender = PiSessionOutputSender {
        tx,
        state: Arc::clone(&state),
        run_id: Arc::from(run_id),
    };
    let run_id = run_id.to_string();
    let thread_id = thread_id.to_string();
    tokio::spawn(async move {
        run_worker(http, run_id, thread_id, rx, state, first_output).await;
    });
    Some(sender)
}

async fn run_worker(
    http: HttpClient,
    run_id: String,
    thread_id: String,
    mut rx: mpsc::Receiver<SessionOutputChunk>,
    state: Arc<SessionOutputState>,
    first_output: FirstSessionOutputTiming,
) {
    let mut first_output = Some(first_output);
    let mut carried = None;
    let mut next_chunk_indices = HashMap::<String, u32>::new();
    loop {
        let mut chunk = match carried.take() {
            Some(chunk) => chunk,
            None => match rx.recv().await {
                Some(chunk) => chunk,
                None => return,
            },
        };
        if state.is_disabled() {
            return;
        }
        if state.block_failed(&chunk.run_event_id) {
            continue;
        }

        while let Ok(next) = rx.try_recv() {
            if next.run_event_id == chunk.run_event_id
                && chunk.delta.len().saturating_add(next.delta.len())
                    <= SESSION_OUTPUT_DELTA_MAX_BYTES
            {
                chunk.delta.push_str(&next.delta);
            } else {
                carried = Some(next);
                break;
            }
        }

        if state.block_failed(&chunk.run_event_id) {
            continue;
        }
        let chunk_index = next_chunk_indices
            .get(&chunk.run_event_id)
            .copied()
            .unwrap_or(0);
        let body = SessionOutputRequest {
            run_id: &run_id,
            thread_id: &thread_id,
            run_event_id: &chunk.run_event_id,
            chunk_index,
            delta: &chunk.delta,
        };
        let sent_at = Instant::now();
        let sent_at_epoch_ms = timing::current_epoch_ms();
        let posted = http.post_session_output(&body).await;
        if let Some(first_output) = first_output.take() {
            first_output.record(sent_at, sent_at_epoch_ms, posted.is_ok());
        }
        if let Err(error) = posted {
            state.fail_block(&chunk.run_event_id);
            let status = match error {
                AgentError::HttpStatus { status, .. } => Some(status),
                _ => None,
            };
            if status.is_some_and(|status| (400..500).contains(&status)) {
                state.disable();
            }
            log_warn!(
                LOG_TAG,
                "Pi session output publication failed; stopped preview: run_id={run_id} run_event_id={} http_status={}",
                chunk.run_event_id,
                status.map_or_else(|| "unknown".to_string(), |status| status.to_string())
            );
            tokio::time::sleep(SESSION_OUTPUT_INTERVAL).await;
            continue;
        }
        if chunk_index == u32::MAX {
            state.fail_block(&chunk.run_event_id);
        } else {
            next_chunk_indices.insert(chunk.run_event_id.clone(), chunk_index + 1);
        }

        tokio::time::sleep(SESSION_OUTPUT_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use httpmock::Method::POST;
    use httpmock::MockServer;
    use serde_json::json;

    use super::*;

    const RUN_ID: &str = "00000000-0000-4000-8000-000000000001";
    const THREAD_ID: &str = "00000000-0000-4000-8000-000000000002";

    async fn wait_for_block_failure(sender: &PiSessionOutputSender, run_event_id: &str) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !sender.state.block_failed(run_event_id) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("session output worker should classify the failure");
    }

    #[test]
    fn queue_pressure_closes_only_the_overflowing_block() {
        let (sender, _rx) = test_channel(1, RUN_ID);
        assert!(sender.try_send("block-a", "first".to_string()));
        assert!(!sender.try_send("block-a", "overflow".to_string()));
        assert!(!sender.try_send("block-a", "later".to_string()));
        assert!(!sender.state.block_failed("block-b"));
    }

    #[tokio::test]
    async fn merged_requests_receive_contiguous_published_indices() {
        let server = MockServer::start();
        let first_delta = format!("{}{}", "a".repeat(2000), "b".repeat(2000));
        let second_delta = "c".repeat(200);
        let first = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/session-output")
                .json_body(json!({
                    "runId": RUN_ID,
                    "threadId": THREAD_ID,
                    "runEventId": "block-a",
                    "chunkIndex": 0,
                    "delta": first_delta,
                }));
            then.status(204);
        });
        let second = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/session-output")
                .json_body(json!({
                    "runId": RUN_ID,
                    "threadId": THREAD_ID,
                    "runEventId": "block-a",
                    "chunkIndex": 1,
                    "delta": second_delta,
                }));
            then.status(204);
        });
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            RUN_ID,
            Duration::ZERO,
        )
        .expect("HTTP client");
        let (sender, rx) = test_channel(4, RUN_ID);
        let state = Arc::clone(&sender.state);
        assert!(sender.try_send("block-a", "a".repeat(2000)));
        assert!(sender.try_send("block-a", "b".repeat(2000)));
        assert!(sender.try_send("block-a", "c".repeat(200)));
        drop(sender);

        run_worker(
            http,
            RUN_ID.to_string(),
            THREAD_ID.to_string(),
            rx,
            state,
            FirstSessionOutputTiming::default(),
        )
        .await;

        first.assert_calls(1);
        second.assert_calls(1);
    }

    #[tokio::test]
    async fn failed_request_is_never_retried_and_closes_the_block() {
        let server = MockServer::start();
        let endpoint = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/session-output");
            then.status(503);
        });
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            RUN_ID,
            Duration::ZERO,
        )
        .expect("HTTP client");
        let sender = start(http, RUN_ID, THREAD_ID, FirstSessionOutputTiming::default())
            .expect("session output sender");

        assert!(sender.try_send("block-a", "first".to_string()));
        assert!(sender.try_send("block-a", " second".to_string()));
        wait_for_block_failure(&sender, "block-a").await;
        assert!(!sender.try_send("block-a", " later".to_string()));
        tokio::time::sleep(Duration::from_millis(25)).await;

        endpoint.assert_calls(1);
    }

    #[tokio::test]
    async fn old_api_rejection_disables_future_blocks_without_affecting_the_caller() {
        let server = MockServer::start();
        let endpoint = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/session-output");
            then.status(404);
        });
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            RUN_ID,
            Duration::ZERO,
        )
        .expect("HTTP client");
        let sender = start(http, RUN_ID, THREAD_ID, FirstSessionOutputTiming::default())
            .expect("session output sender");

        assert!(sender.try_send("block-a", "first".to_string()));
        wait_for_block_failure(&sender, "block-a").await;
        assert!(!sender.try_send("block-b", "new response".to_string()));

        endpoint.assert_calls(1);
    }
    #[tokio::test]
    async fn only_the_first_published_chunk_records_first_output_timing() {
        let telemetry_dir = tempfile::tempdir().expect("telemetry dir");
        let telemetry_path = telemetry_dir.path().join("sandbox-ops.jsonl");
        let _sandbox_ops_guard = crate::SandboxOpsTestGuard::with_override(&telemetry_path).await;
        let server = MockServer::start();
        let endpoint = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/session-output");
            then.status(204);
        });
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            RUN_ID,
            Duration::ZERO,
        )
        .expect("HTTP client");
        let startup = Arc::new(OnceLock::new());
        startup
            .set(Instant::now())
            .expect("startup boundary is unset");
        let api_start_time = (timing::current_epoch_ms() - 1_000).to_string();
        let (sender, rx) = test_channel(4, RUN_ID);
        let state = Arc::clone(&sender.state);
        assert!(sender.try_send("block-a", "first".to_string()));
        assert!(sender.try_send("block-b", "second".to_string()));
        drop(sender);

        run_worker(
            http,
            RUN_ID.to_string(),
            THREAD_ID.to_string(),
            rx,
            state,
            FirstSessionOutputTiming {
                pi_startup_succeeded_at: Some(startup),
                api_start_time,
            },
        )
        .await;

        endpoint.assert_calls(2);
        let ops: Vec<serde_json::Value> = std::fs::read_to_string(&telemetry_path)
            .expect("sandbox ops")
            .lines()
            .map(|line| serde_json::from_str(line).expect("sandbox op JSON"))
            .collect();
        let named = |name: &str| {
            ops.iter()
                .filter(|op| op["action_type"] == name)
                .collect::<Vec<_>>()
        };
        let first_output = named("pi_first_session_output");
        assert_eq!(first_output.len(), 1);
        assert_eq!(first_output[0]["success"], true);
        let from_api = named("api_to_first_session_output");
        assert_eq!(from_api.len(), 1);
        assert!(from_api[0]["duration_ms"].as_u64().expect("duration") >= 1_000);
    }
}
