//! Addon usage flush request/ack protocol.
//!
//! Blocking publication retains serialization and directory ownership through
//! caller cancellation. Publication has a five-second budget; acknowledgement
//! has a separate 30-second budget including state-file I/O. These bound callers,
//! not kernel I/O or runtime teardown. Network logs use the control socket.

mod publication;

use std::path::Path;
use std::sync::{Arc, Mutex};
#[cfg(test)]
use std::task::Poll;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use tokio::time::Instant;
use tracing::{error, warn};
use uuid::Uuid;

use crate::error::{RunnerError, RunnerResult};

use super::runtime::MitmdumpRuntime;
use publication::MarkerPublication;

/// Maximum time to wait for buffered work and pending reports before stopping.
///
/// The runner writes `{addon_dir}/usage-flush-request`, signals the Python
/// addon, then polls `{addon_dir}/usage-pending` until the addon acknowledges
/// the current request with zero counters or this timeout expires. 30 s covers
/// one webhook retry cycle (10 s timeout x 2 attempts plus 0.5 s backoff) with
/// headroom for request delivery and mitmproxy event-loop drain.
pub const USAGE_FLUSH_TIMEOUT: Duration = Duration::from_secs(30);

/// Marker publication budget, including usage lock admission and queued I/O.
const FLUSH_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// Poll interval when waiting for usage flush.
const USAGE_FLUSH_POLL: Duration = Duration::from_millis(200);

/// Minimum interval between repeated runner-triggered usage flush requests
/// while the addon is not ready.
const USAGE_FLUSH_REQUEST_INTERVAL: Duration = Duration::from_secs(1);

/// Tolerated wall-clock skew when validating addon timestamps.
const USAGE_PENDING_CLOCK_SKEW: Duration = Duration::from_secs(300);

#[derive(Clone)]
pub struct UsageFlushTarget {
    pub(super) expected_usage_state_id: String,
    pub(super) usage_state_started_at_ms: u64,
    usage_request_lock: Arc<AsyncMutex<()>>,
    runtime: Option<Arc<MitmdumpRuntime>>,
}

impl UsageFlushTarget {
    pub(super) fn new(
        expected_usage_state_id: String,
        usage_state_started_at_ms: u64,
        runtime: Option<Arc<MitmdumpRuntime>>,
    ) -> Self {
        Self {
            expected_usage_state_id,
            usage_state_started_at_ms,
            usage_request_lock: Arc::new(AsyncMutex::new(())),
            runtime,
        }
    }
}

#[derive(Debug, Clone)]
struct FlushRequestCore {
    expected_usage_state_id: String,
    usage_state_started_at_ms: u64,
    flush_request_id: String,
    requested_at_ms: u64,
}

#[derive(Debug, Clone)]
pub struct UsageFlushRequest {
    core: FlushRequestCore,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageFlushRequestMarker<'a> {
    usage_state_id: &'a str,
    flush_request_id: &'a str,
    requested_at_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UsagePendingState {
    pid: u32,
    usage_state_id: String,
    updated_at_ms: u64,
    flows: u32,
    buffered: u32,
    reports: u32,
    #[serde(default)]
    flush_request_id: Option<String>,
}

#[derive(Debug, Clone)]
struct UsagePendingSnapshot {
    pid: u32,
    usage_state_id: String,
    updated_at_ms: u64,
    flows: u32,
    buffered: u32,
    reports: u32,
    flush_request_id: Option<String>,
}

impl From<&UsagePendingState> for UsagePendingSnapshot {
    fn from(state: &UsagePendingState) -> Self {
        Self {
            pid: state.pid,
            usage_state_id: state.usage_state_id.clone(),
            updated_at_ms: state.updated_at_ms,
            flows: state.flows,
            buffered: state.buffered,
            reports: state.reports,
            flush_request_id: state.flush_request_id.clone(),
        }
    }
}

enum FlushReadiness<S> {
    Ready,
    NotReady {
        phase: &'static str,
        not_ready: String,
        snapshot: Option<S>,
    },
}

enum FlushWaitFailure<S> {
    RequestFailed {
        phase: &'static str,
        not_ready: String,
    },
    TimedOut {
        phase: &'static str,
        not_ready: String,
        snapshot: Option<S>,
    },
}

pub(super) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

pub(super) fn new_usage_state_id() -> (String, u64) {
    (Uuid::new_v4().to_string(), now_millis())
}

pub(super) fn usage_flush_state_guard(
    usage_state: &Arc<Mutex<UsageFlushTarget>>,
) -> std::sync::MutexGuard<'_, UsageFlushTarget> {
    match usage_state.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            warn!("usage flush state lock was poisoned, continuing with inner state");
            poisoned.into_inner()
        }
    }
}

impl FlushRequestCore {
    fn new(target: &UsageFlushTarget) -> Self {
        Self {
            expected_usage_state_id: target.expected_usage_state_id.clone(),
            usage_state_started_at_ms: target.usage_state_started_at_ms,
            flush_request_id: Uuid::new_v4().to_string(),
            requested_at_ms: now_millis(),
        }
    }
}

impl UsageFlushRequest {
    fn new(target: &UsageFlushTarget) -> Self {
        Self {
            core: FlushRequestCore::new(target),
        }
    }
}

pub async fn write_usage_flush_request(
    addon_dir: &Path,
    target: &UsageFlushTarget,
) -> RunnerResult<UsageFlushRequest> {
    let deadline = Instant::now() + FLUSH_REQUEST_TIMEOUT;
    let request_guard = tokio::time::timeout_at(
        deadline,
        Arc::clone(&target.usage_request_lock).lock_owned(),
    )
    .await
    .map_err(|_| RunnerError::Internal("usage flush publication lock timed out".to_string()))?;
    let request = UsageFlushRequest::new(target);
    let marker = UsageFlushRequestMarker {
        usage_state_id: &request.core.expected_usage_state_id,
        flush_request_id: &request.core.flush_request_id,
        requested_at_ms: request.core.requested_at_ms,
    };
    let _request_guard = write_flush_request_marker(
        addon_dir,
        "usage-flush-request",
        &marker,
        "usage flush request",
        request_guard,
        target.runtime.clone(),
        deadline,
    )
    .await?;
    Ok(request)
}

async fn write_flush_request_marker<T: Serialize>(
    addon_dir: &Path,
    file_name: &str,
    marker: &T,
    description: &str,
    request_guard: OwnedMutexGuard<()>,
    runtime: Option<Arc<MitmdumpRuntime>>,
    deadline: Instant,
) -> RunnerResult<OwnedMutexGuard<()>> {
    let path = addon_dir.join(file_name);
    let content = serde_json::to_vec(marker)
        .map_err(|e| RunnerError::Internal(format!("serialize {description}: {e}")))?;
    MarkerPublication {
        path,
        content,
        deadline,
        request_guard,
        runtime,
        #[cfg(test)]
        staged_gate: None,
    }
    .publish()
    .await
}

fn parse_usage_pending_state(content: &str) -> Result<UsagePendingState, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("state file is empty".to_string());
    }
    serde_json::from_str::<UsagePendingState>(trimmed)
        .map_err(|e| format!("state file is not valid usage-pending JSON: {e}"))
}

fn validate_usage_pending_state(
    state: &UsagePendingState,
    request: &UsageFlushRequest,
    now_ms: u64,
) -> Result<(), String> {
    validate_flush_state_core(
        &state.usage_state_id,
        state.updated_at_ms,
        state.flush_request_id.as_deref(),
        &request.core,
        "usage flush request id does not match current request",
        "usage flush request id is missing",
        now_ms,
    )
}

fn validate_flush_state_core(
    usage_state_id: &str,
    updated_at_ms: u64,
    flush_request_id: Option<&str>,
    request: &FlushRequestCore,
    request_id_mismatch_message: &str,
    missing_request_id_message: &str,
    now_ms: u64,
) -> Result<(), String> {
    if usage_state_id != request.expected_usage_state_id {
        return Err("usage state id does not match current mitmdump process".to_string());
    }

    let skew_ms = USAGE_PENDING_CLOCK_SKEW.as_millis() as u64;
    let min_updated_at = request.usage_state_started_at_ms.saturating_sub(skew_ms);
    if updated_at_ms < min_updated_at {
        return Err(format!(
            "updatedAtMs {} predates current usage state id start {}",
            updated_at_ms, request.usage_state_started_at_ms
        ));
    }
    if updated_at_ms > now_ms.saturating_add(skew_ms) {
        return Err(format!(
            "updatedAtMs {} is too far in the future",
            updated_at_ms
        ));
    }
    match flush_request_id {
        Some(id) if id == request.flush_request_id => Ok(()),
        Some(_) => Err(request_id_mismatch_message.to_string()),
        None => Err(missing_request_id_message.to_string()),
    }
}

/// Wait for all pending proxy webhook work to be delivered.
///
/// The runner writes a request marker, signals the Python addon, and then waits
/// for JSON in `{addon_dir}/usage-pending` that acknowledges that request with
/// the current mitmdump usage-state identity plus in-flight flow, buffered
/// work, and report counters. A successful drain requires current valid state
/// with the active `flushRequestId` and `flows == 0`, `buffered == 0`, and
/// `reports == 0`. Missing, unreadable, stale, wrong state id, wrong request
/// id, or invalid state is treated as not ready and waits until timeout. The
/// JSON `pid` is diagnostic only: mitmdump launchers can keep the runner's
/// direct child as a wrapper while the Python addon runs in a child process.
#[cfg(test)]
async fn wait_usage_flush(
    addon_dir: &Path,
    timeout: Duration,
    request: &UsageFlushRequest,
) -> bool {
    wait_usage_flush_requesting(addon_dir, timeout, request, || true).await
}

/// Wait for proxy usage drain while actively asking the addon for fresh snapshots.
pub async fn wait_usage_flush_requesting(
    addon_dir: &Path,
    timeout: Duration,
    request: &UsageFlushRequest,
    request_flush: impl FnMut() -> bool,
) -> bool {
    match wait_flush(
        addon_dir,
        "usage-pending",
        timeout,
        USAGE_FLUSH_POLL,
        |content| match parse_usage_pending_state(content) {
            Ok(state) => {
                let snapshot = Some(UsagePendingSnapshot::from(&state));
                match validate_usage_pending_state(&state, request, now_millis()) {
                    Ok(()) if state.flows == 0 && state.buffered == 0 && state.reports == 0 => {
                        FlushReadiness::Ready
                    }
                    Ok(()) => FlushReadiness::NotReady {
                        phase: "pending_delivery",
                        not_ready: format!(
                            "pending flows={} buffered={} reports={}",
                            state.flows, state.buffered, state.reports
                        ),
                        snapshot,
                    },
                    Err(not_ready) => FlushReadiness::NotReady {
                        phase: "state_validation",
                        not_ready,
                        snapshot,
                    },
                }
            }
            Err(not_ready) => FlushReadiness::NotReady {
                phase: "state_read",
                not_ready,
                snapshot: None,
            },
        },
        Some((USAGE_FLUSH_REQUEST_INTERVAL, request_flush)),
    )
    .await
    {
        Ok(()) => true,
        Err(FlushWaitFailure::RequestFailed { phase, not_ready }) => {
            error!(
                r#type = "usage_underbilling",
                reason = "usage_flush_request_failed",
                underbilling_class = "risk",
                component = "runner",
                phase,
                not_ready = %not_ready,
                request_usage_state_id = %request.core.expected_usage_state_id,
                request_id = %request.core.flush_request_id,
                "usage flush request failed, proceeding with proxy stop"
            );
            false
        }
        Err(FlushWaitFailure::TimedOut {
            phase,
            not_ready,
            snapshot,
        }) => {
            match snapshot {
                Some(snapshot) => {
                    error!(
                        r#type = "usage_underbilling",
                        reason = "usage_flush_timeout",
                        underbilling_class = "risk",
                        component = "runner",
                        phase,
                        timeout_secs = timeout.as_secs(),
                        not_ready = %not_ready,
                        pid = snapshot.pid,
                        usage_state_id = %snapshot.usage_state_id,
                        updated_at_ms = snapshot.updated_at_ms,
                        flows = snapshot.flows,
                        buffered = snapshot.buffered,
                        reports = snapshot.reports,
                        flush_request_id = snapshot.flush_request_id.as_deref().unwrap_or(""),
                        "usage flush timed out, proceeding with proxy stop"
                    );
                }
                None => {
                    error!(
                        r#type = "usage_underbilling",
                        reason = "usage_flush_timeout",
                        underbilling_class = "risk",
                        component = "runner",
                        phase,
                        timeout_secs = timeout.as_secs(),
                        not_ready = %not_ready,
                        request_usage_state_id = %request.core.expected_usage_state_id,
                        request_id = %request.core.flush_request_id,
                        "usage flush timed out, proceeding with proxy stop"
                    );
                }
            }
            false
        }
    }
}

async fn wait_flush<S, F>(
    addon_dir: &Path,
    state_file_name: &str,
    timeout: Duration,
    poll_interval: Duration,
    mut evaluate_state: impl FnMut(&str) -> FlushReadiness<S>,
    mut repeat_request: Option<(Duration, F)>,
) -> Result<(), FlushWaitFailure<S>>
where
    F: FnMut() -> bool,
{
    let path = addon_dir.join(state_file_name);
    let started_at = tokio::time::Instant::now();
    let deadline = started_at + timeout;
    let mut next_flush_request_at = repeat_request
        .as_ref()
        .map(|(repeat_request_interval, _)| started_at + *repeat_request_interval);
    let read_timed_out = || FlushWaitFailure::TimedOut {
        phase: "state_read",
        not_ready: format!(
            "read {} did not finish before the flush deadline",
            path.display()
        ),
        snapshot: None,
    };
    let mut last_failure = read_timed_out();
    loop {
        if Instant::now() >= deadline {
            return Err(last_failure);
        }
        let state = tokio::time::timeout_at(deadline, read_addon_state_file(&path))
            .await
            .map_err(|_| read_timed_out())?;
        if Instant::now() >= deadline {
            return Err(read_timed_out());
        }
        let (phase, not_ready, snapshot) = match state {
            Ok(Some(content)) => match evaluate_state(&content) {
                FlushReadiness::Ready => return Ok(()),
                FlushReadiness::NotReady {
                    phase,
                    not_ready,
                    snapshot,
                } => (phase, not_ready, snapshot),
            },
            Ok(None) => (
                "state_read",
                format!("cannot read {}: not found", path.display()),
                None,
            ),
            Err(e) => (
                "state_read",
                format!("cannot read {}: {e}", path.display()),
                None,
            ),
        };
        let now = tokio::time::Instant::now();
        if let Some(next_request_at) = next_flush_request_at.as_mut()
            && let Some((repeat_request_interval, request_flush)) = repeat_request.as_mut()
            && now >= *next_request_at
        {
            if !request_flush() {
                return Err(FlushWaitFailure::RequestFailed { phase, not_ready });
            }
            *next_request_at = now + *repeat_request_interval;
        }
        if now >= deadline {
            return Err(FlushWaitFailure::TimedOut {
                phase,
                not_ready,
                snapshot,
            });
        }
        last_failure = FlushWaitFailure::TimedOut {
            phase,
            not_ready,
            snapshot,
        };
        tokio::time::sleep(std::cmp::min(poll_interval, deadline - now)).await;
    }
}

async fn read_addon_state_file(path: &Path) -> RunnerResult<Option<String>> {
    crate::state_file::read_to_string(
        path,
        crate::state_file::USAGE_PENDING_MAX_BYTES,
        crate::state_file::OwnerCheck::None,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::MitmProxy;
    use std::sync::atomic::Ordering;
    use tracing::Level;
    use tracing_subscriber::prelude::*;
    use tracing_test_support::{CapturedEvent, CapturedEvents};

    struct BlockingPoolGate {
        release: std::sync::mpsc::Sender<()>,
        worker: tokio::task::JoinHandle<()>,
    }

    impl BlockingPoolGate {
        async fn occupy() -> Self {
            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            let (release, release_rx) = std::sync::mpsc::channel();
            let worker = tokio::task::spawn_blocking(move || {
                let _ = ready_tx.send(());
                // Dropping the sender also releases the worker on test failure.
                let _ = release_rx.recv_timeout(Duration::from_secs(10));
            });
            ready_rx.await.unwrap();
            Self { release, worker }
        }

        async fn release(self) {
            let _ = self.release.send(());
            self.worker.await.unwrap();
        }
    }

    fn filesystem_test_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .max_blocking_threads(1)
            .enable_all()
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn usage_publication_serialization_survives_proxy_restart() {
        let dir = tempfile::tempdir().unwrap();
        let (mut proxy, _crash_rx) = MitmProxy::noop();
        let usage_state = proxy.usage_flush_state_for_test();
        let previous = usage_flush_state_guard(&usage_state).clone();
        let previous_guard = Arc::clone(&previous.usage_request_lock).lock_owned().await;
        let _restart = proxy.begin_restart();
        let current = usage_flush_state_guard(&usage_state).clone();
        assert_ne!(
            previous.expected_usage_state_id,
            current.expected_usage_state_id
        );

        tokio::time::pause();
        assert!(
            write_usage_flush_request(dir.path(), &current)
                .await
                .is_err()
        );
        tokio::time::resume();
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);

        drop(previous_guard);
        let request = write_usage_flush_request(dir.path(), &current)
            .await
            .unwrap();
        let marker: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("usage-flush-request")).unwrap())
                .unwrap();
        assert_eq!(marker["usageStateId"], current.expected_usage_state_id);
        assert_eq!(marker["flushRequestId"], request.core.flush_request_id);
    }

    #[test]
    fn usage_flush_read_deadline_includes_blocking_pool_queueing() {
        filesystem_test_runtime().block_on(async {
            let dir = tempfile::tempdir().unwrap();
            let request = usage_request();
            let gate = BlockingPoolGate::occupy().await;
            tokio::time::pause();
            let wait =
                wait_usage_flush_requesting(dir.path(), USAGE_FLUSH_TIMEOUT, &request, || true);
            tokio::pin!(wait);
            assert!(futures_util::poll!(&mut wait).is_pending());
            tokio::time::advance(USAGE_FLUSH_TIMEOUT + Duration::from_secs(1)).await;
            let at_deadline = futures_util::poll!(&mut wait);
            tokio::time::resume();
            gate.release().await;
            if at_deadline.is_pending() {
                let _ = wait.await;
            }
            assert_eq!(at_deadline, Poll::Ready(false));
        });
    }

    #[test]
    fn usage_marker_deadline_includes_blocking_pool_queueing() {
        filesystem_test_runtime().block_on(async {
            let dir = tempfile::tempdir().unwrap();
            let target = usage_target();
            let gate = BlockingPoolGate::occupy().await;
            tokio::time::pause();
            let write = write_usage_flush_request(dir.path(), &target);
            tokio::pin!(write);
            assert!(futures_util::poll!(&mut write).is_pending());
            tokio::time::advance(Duration::from_secs(6)).await;
            let at_deadline = futures_util::poll!(&mut write);
            let timed_out = matches!(&at_deadline, Poll::Ready(Err(_)));
            tokio::time::resume();
            gate.release().await;
            if at_deadline.is_pending() {
                let _ = write.await;
            }
            // With one blocking worker, this also drains previously queued I/O.
            tokio::task::spawn_blocking(|| ()).await.unwrap();
            assert!(
                timed_out,
                "usage marker write exceeded its publication budget"
            );
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);

            let next = write_usage_flush_request(dir.path(), &target)
                .await
                .unwrap();
            let marker: serde_json::Value = serde_json::from_slice(
                &std::fs::read(dir.path().join("usage-flush-request")).unwrap(),
            )
            .unwrap();
            assert_eq!(marker["flushRequestId"], next.core.flush_request_id);
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        });
    }

    async fn capture_async_log_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
    where
        F: std::future::Future,
    {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let guard = tracing::subscriber::set_default(subscriber);
        tracing::callsite::rebuild_interest_cache();
        let output = future.await;
        drop(guard);
        (output, captured.entries())
    }

    fn event_field<'a>(event: &'a CapturedEvent, field: &str) -> &'a str {
        event
            .fields
            .get(field)
            .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"))
    }

    fn assert_event_field(event: &CapturedEvent, field: &str, expected: &str) {
        let actual = event_field(event, field);
        assert_eq!(actual, expected, "field {field} mismatch; event={event:#?}");
    }

    fn usage_target() -> UsageFlushTarget {
        UsageFlushTarget::new("state-test".to_string(), 1_770_000_000_000, None)
    }

    fn usage_request() -> UsageFlushRequest {
        UsageFlushRequest {
            core: FlushRequestCore {
                expected_usage_state_id: "state-test".to_string(),
                usage_state_started_at_ms: 1_770_000_000_000,
                flush_request_id: "request-test".to_string(),
                requested_at_ms: 1_770_000_000_000,
            },
        }
    }

    fn usage_state(flows: u32, buffered: u32, reports: u32) -> String {
        usage_state_with_request(flows, buffered, reports, Some("request-test"))
    }

    fn usage_state_with_request(
        flows: u32,
        buffered: u32,
        reports: u32,
        flush_request_id: Option<&str>,
    ) -> String {
        let mut state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "state-test",
            "updatedAtMs": 1_770_000_000_001u64,
            "flows": flows,
            "buffered": buffered,
            "reports": reports,
        });
        if let Some(flush_request_id) = flush_request_id {
            state["flushRequestId"] = serde_json::json!(flush_request_id);
        }
        state.to_string()
    }

    #[tokio::test]
    async fn write_usage_flush_request_writes_marker() {
        let dir = tempfile::tempdir().unwrap();
        let target = usage_target();

        let request = write_usage_flush_request(dir.path(), &target)
            .await
            .unwrap();

        let marker: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("usage-flush-request")).unwrap(),
        )
        .unwrap();
        assert_eq!(marker["usageStateId"], "state-test");
        assert_eq!(marker["flushRequestId"], request.core.flush_request_id);
        assert_eq!(marker["requestedAtMs"], request.core.requested_at_ms);
    }

    #[tokio::test]
    async fn write_usage_flush_request_removes_tmp_when_rename_fails() {
        let dir = tempfile::tempdir().unwrap();
        let target = usage_target();
        std::fs::create_dir(dir.path().join("usage-flush-request")).unwrap();

        let result = write_usage_flush_request(dir.path(), &target).await;

        assert!(result.is_err());
        let leaked_tmp = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name())
            .any(|name| name.to_string_lossy().ends_with(".tmp"));
        assert!(!leaked_tmp, "usage flush request tmp file leaked");
    }

    fn usage_state_without_request(flows: u32, buffered: u32, reports: u32) -> String {
        serde_json::json!({
            "pid": 1234,
            "usageStateId": "state-test",
            "updatedAtMs": 1_770_000_000_001u64,
            "flows": flows,
            "buffered": buffered,
            "reports": reports,
        })
        .to_string()
    }

    const USAGE_FLUSH_TEST_DELAY: Duration = Duration::from_millis(1);

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_returns_true_when_zero() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        std::fs::write(dir.path().join("usage-pending"), usage_state(0, 0, 0)).unwrap();
        assert!(wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_missing_request_id() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        std::fs::write(
            dir.path().join("usage-pending"),
            usage_state_without_request(0, 0, 0),
        )
        .unwrap();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_wrong_request_id() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        std::fs::write(
            dir.path().join("usage-pending"),
            usage_state_with_request(0, 0, 0, Some("old-request")),
        )
        .unwrap();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_state_symlink_without_following_it() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let outside = dir.path().join("outside-usage-pending");
        std::fs::write(&outside, usage_state(0, 0, 0)).unwrap();
        std::os::unix::fs::symlink(&outside, dir.path().join("usage-pending")).unwrap();

        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_oversized_state() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        std::fs::write(
            dir.path().join("usage-pending"),
            vec![b' '; crate::state_file::USAGE_PENDING_MAX_BYTES as usize + 1],
        )
        .unwrap();

        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_times_out_when_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_waits_for_state_file_to_appear() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let path = dir.path().join("usage-pending");

        let p = path.clone();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(USAGE_FLUSH_TEST_DELAY).await;
            std::fs::write(&p, usage_state(0, 0, 0)).unwrap();
        });

        let d = dir.path().to_path_buf();
        assert!(wait_usage_flush(&d, Duration::from_secs(5), &request).await);
        handle.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_waits_until_zero() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let path = dir.path().join("usage-pending");
        std::fs::write(&path, usage_state(2, 0, 1)).unwrap();

        let p = path.clone();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(USAGE_FLUSH_TEST_DELAY).await;
            std::fs::write(&p, usage_state(0, 0, 0)).unwrap();
        });

        let d = dir.path().to_path_buf();
        assert!(wait_usage_flush(&d, Duration::from_secs(5), &request).await);
        handle.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_waits_until_buffered_zero() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let path = dir.path().join("usage-pending");
        std::fs::write(&path, usage_state(0, 2, 0)).unwrap();

        let p = path.clone();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(USAGE_FLUSH_TEST_DELAY).await;
            std::fs::write(&p, usage_state(0, 0, 0)).unwrap();
        });

        let d = dir.path().to_path_buf();
        assert!(wait_usage_flush(&d, Duration::from_secs(5), &request).await);
        handle.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_requests_flush_when_buffered() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let path = dir.path().join("usage-pending");
        std::fs::write(&path, usage_state(0, 2, 0)).unwrap();
        let request_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let p = path.clone();
        let requests = std::sync::Arc::clone(&request_count);
        let d = dir.path().to_path_buf();
        let flushed = wait_usage_flush_requesting(&d, Duration::from_secs(5), &request, || {
            requests.fetch_add(1, Ordering::SeqCst);
            std::fs::write(&p, usage_state(0, 0, 0)).unwrap();
            true
        })
        .await;

        assert!(flushed);
        assert_eq!(request_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_requests_flush_when_reports_pending() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let path = dir.path().join("usage-pending");
        std::fs::write(&path, usage_state(0, 0, 1)).unwrap();
        let request_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let p = path.clone();
        let requests = std::sync::Arc::clone(&request_count);
        let d = dir.path().to_path_buf();
        let flushed = wait_usage_flush_requesting(&d, Duration::from_secs(5), &request, || {
            requests.fetch_add(1, Ordering::SeqCst);
            std::fs::write(&p, usage_state(0, 0, 0)).unwrap();
            true
        })
        .await;

        assert!(flushed);
        assert_eq!(request_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_requests_flush_when_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let path = dir.path().join("usage-pending");
        let request_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let p = path.clone();
        let requests = std::sync::Arc::clone(&request_count);
        let d = dir.path().to_path_buf();
        let flushed = wait_usage_flush_requesting(&d, Duration::from_secs(5), &request, || {
            requests.fetch_add(1, Ordering::SeqCst);
            std::fs::write(&p, usage_state(0, 0, 0)).unwrap();
            true
        })
        .await;

        assert!(flushed);
        assert_eq!(request_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_requests_flush_when_request_id_is_stale() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let path = dir.path().join("usage-pending");
        std::fs::write(
            &path,
            usage_state_with_request(0, 0, 0, Some("old-request")),
        )
        .unwrap();
        let request_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let p = path.clone();
        let requests = std::sync::Arc::clone(&request_count);
        let d = dir.path().to_path_buf();
        let flushed = wait_usage_flush_requesting(&d, Duration::from_secs(5), &request, || {
            requests.fetch_add(1, Ordering::SeqCst);
            std::fs::write(&p, usage_state(0, 0, 0)).unwrap();
            true
        })
        .await;

        assert!(flushed);
        assert_eq!(request_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_requests_flush_when_usage_state_id_is_stale() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let path = dir.path().join("usage-pending");
        let stale_state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "old-state",
            "updatedAtMs": 1_770_000_000_001u64,
            "flows": 0,
            "buffered": 0,
            "reports": 0,
            "flushRequestId": "request-test",
        });
        std::fs::write(&path, stale_state.to_string()).unwrap();
        let request_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let p = path.clone();
        let requests = std::sync::Arc::clone(&request_count);
        let d = dir.path().to_path_buf();
        let flushed = wait_usage_flush_requesting(&d, Duration::from_secs(5), &request, || {
            requests.fetch_add(1, Ordering::SeqCst);
            std::fs::write(&p, usage_state(0, 0, 0)).unwrap();
            true
        })
        .await;

        assert!(flushed);
        assert_eq!(request_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_requests_flush_when_state_file_is_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let path = dir.path().join("usage-pending");
        std::fs::write(&path, "garbage").unwrap();
        let request_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let p = path.clone();
        let requests = std::sync::Arc::clone(&request_count);
        let d = dir.path().to_path_buf();
        let flushed = wait_usage_flush_requesting(&d, Duration::from_secs(5), &request, || {
            requests.fetch_add(1, Ordering::SeqCst);
            std::fs::write(&p, usage_state(0, 0, 0)).unwrap();
            true
        })
        .await;

        assert!(flushed);
        assert_eq!(request_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_throttles_repeat_flush_requests() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        std::fs::write(dir.path().join("usage-pending"), usage_state(0, 2, 0)).unwrap();
        let request_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let requests = std::sync::Arc::clone(&request_count);
        let flushed = wait_usage_flush_requesting(
            dir.path(),
            USAGE_FLUSH_REQUEST_INTERVAL - Duration::from_millis(1),
            &request,
            || {
                requests.fetch_add(1, Ordering::SeqCst);
                true
            },
        )
        .await;

        assert!(!flushed);
        assert_eq!(request_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_returns_false_when_repeat_request_fails() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        std::fs::write(dir.path().join("usage-pending"), usage_state(0, 2, 0)).unwrap();
        let request_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let requests = std::sync::Arc::clone(&request_count);
        let (flushed, events) = capture_async_log_events(wait_usage_flush_requesting(
            dir.path(),
            Duration::from_secs(5),
            &request,
            || {
                requests.fetch_add(1, Ordering::SeqCst);
                false
            },
        ))
        .await;

        assert!(!flushed);
        assert_eq!(request_count.load(Ordering::SeqCst), 1);
        assert_eq!(events.len(), 1, "captured events: {events:#?}");
        let event = &events[0];
        assert_eq!(event.level, Level::ERROR);
        assert_event_field(
            event,
            "message",
            "usage flush request failed, proceeding with proxy stop",
        );
        assert_event_field(event, "type", "usage_underbilling");
        assert_event_field(event, "reason", "usage_flush_request_failed");
        assert_event_field(event, "underbilling_class", "risk");
        assert_event_field(event, "component", "runner");
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        std::fs::write(dir.path().join("usage-pending"), usage_state(1, 0, 3)).unwrap();
        // Very short timeout — should return false.
        let (flushed, events) = capture_async_log_events(wait_usage_flush(
            dir.path(),
            Duration::from_millis(50),
            &request,
        ))
        .await;

        assert!(!flushed);
        assert_eq!(events.len(), 1, "captured events: {events:#?}");
        let event = &events[0];
        assert_eq!(event.level, Level::ERROR);
        assert_event_field(
            event,
            "message",
            "usage flush timed out, proceeding with proxy stop",
        );
        assert_event_field(event, "type", "usage_underbilling");
        assert_event_field(event, "reason", "usage_flush_timeout");
        assert_event_field(event, "underbilling_class", "risk");
        assert_event_field(event, "component", "runner");
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_times_out_on_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        std::fs::write(dir.path().join("usage-pending"), "garbage").unwrap();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_times_out_on_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        std::fs::write(dir.path().join("usage-pending"), "").unwrap();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_unknown_field() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "state-test",
            "updatedAtMs": 1_770_000_000_001u64,
            "flows": 0,
            "buffered": 0,
            "reports": 0,
            "flushRequestId": "request-test",
            "extraField": "unexpected",
        });
        std::fs::write(dir.path().join("usage-pending"), state.to_string()).unwrap();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_legacy_state_without_buffered_count() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "state-test",
            "updatedAtMs": 1_770_000_000_001u64,
            "flows": 0,
            "reports": 0,
            "flushRequestId": "request-test",
        });
        std::fs::write(dir.path().join("usage-pending"), state.to_string()).unwrap();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_missing_required_field() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "state-test",
            "updatedAtMs": 1_770_000_000_001u64,
            "flows": 0,
            "buffered": 0,
            "flushRequestId": "request-test",
        });
        std::fs::write(dir.path().join("usage-pending"), state.to_string()).unwrap();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_wrong_usage_state_id() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "old-state",
            "updatedAtMs": 1_770_000_000_001u64,
            "flows": 0,
            "buffered": 0,
            "reports": 0,
            "flushRequestId": "request-test",
        });
        std::fs::write(dir.path().join("usage-pending"), state.to_string()).unwrap();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_allows_wrapper_pid_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let state = serde_json::json!({
            "pid": 5678,
            "usageStateId": "state-test",
            "updatedAtMs": 1_770_000_000_001u64,
            "flows": 0,
            "buffered": 0,
            "reports": 0,
            "flushRequestId": "request-test",
        });
        std::fs::write(dir.path().join("usage-pending"), state.to_string()).unwrap();
        assert!(wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_stale_state() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "state-test",
            "updatedAtMs": 1_769_000_000_000u64,
            "flows": 0,
            "buffered": 0,
            "reports": 0,
            "flushRequestId": "request-test",
        });
        std::fs::write(dir.path().join("usage-pending"), state.to_string()).unwrap();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_usage_flush_rejects_future_state() {
        let dir = tempfile::tempdir().unwrap();
        let request = usage_request();
        let state = serde_json::json!({
            "pid": 1234,
            "usageStateId": "state-test",
            "updatedAtMs": now_millis() + USAGE_PENDING_CLOCK_SKEW.as_millis() as u64 + 60_000,
            "flows": 0,
            "buffered": 0,
            "reports": 0,
            "flushRequestId": "request-test",
        });
        std::fs::write(dir.path().join("usage-pending"), state.to_string()).unwrap();
        assert!(!wait_usage_flush(dir.path(), Duration::from_millis(50), &request).await);
    }
}
