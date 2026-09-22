//! Channel-driven mock [`JobProvider`] for integration testing.
//!
//! Reproduces the key main-loop stress cases that previously came from
//! [`ApiProvider`]:
//!
//! - `discover()` can hold a resource for its entire duration and `shutdown()`
//!   can wait on that resource, preserving the shutdown regression shape.
//! - `discover()` has an optional pre-channel delay simulating the API provider's
//!   poll timer that restarts from scratch when the future is cancelled.
//! - `heartbeat()` can be blocked at the provider boundary while tests observe
//!   request entry, release, and maximum concurrency.
//!
//! This lets integration tests catch:
//! - **#8783**: heartbeat cancelling and recreating `discover()` each tick —
//!   the poll delay restarts from scratch, so jobs are never discovered.
//! - **#8898**: `shutdown()` deadlocking because `discover_fut` still holds
//!   the Mutex when `provider.shutdown()` is called.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use tokio::sync::{Mutex, Notify, mpsc};
use tokio_util::sync::CancellationToken;
use tracing::warn;

use super::{ClaimedJob, CompletionAuth, CompletionReportTiming, JobCandidate, JobProvider};
use crate::error::{RunnerError, RunnerResult};
use runner_types::ids::RunId;
use runner_types::types::{
    CompleteRequest, ExecutionContext, HeartbeatState, SandboxReuseResult, WorkspaceReuseResult,
};
use sandbox::SandboxId;

/// Recorded completion from [`JobProvider::complete`].
#[derive(Debug, Clone)]
pub struct Completion {
    pub run_id: RunId,
    pub exit_code: i32,
    pub error: Option<String>,
    pub sandbox_id: Option<SandboxId>,
    pub reuse_result: Option<SandboxReuseResult>,
    pub workspace_reuse_result: Option<WorkspaceReuseResult>,
}

/// Channel-driven mock provider.
///
/// `discover()` holds `discovery` Mutex for its entire duration. `shutdown()`
/// acquires the same Mutex, so omitting the
/// `drop(discover_fut)` before `shutdown()` causes a real deadlock.
pub struct MockJobProvider {
    startup_readiness: Arc<MockStartupReadiness>,
    /// Held by `discover()` for its entire lifetime and acquired by
    /// `shutdown()`. Reproduces the historical API-provider shutdown deadlock
    /// shape used by main-loop regression tests.
    discovery: Mutex<mpsc::UnboundedReceiver<JobCandidate>>,
    /// Optional delay before checking the channel, simulating the API provider's
    /// internal poll timer. If the future is cancelled and recreated (not
    /// pinned), this delay restarts from scratch — jobs pushed during the
    /// delay won't be discovered until it completes.
    poll_delay: Option<Duration>,
    ready_discovery: Arc<StdMutex<VecDeque<JobCandidate>>>,
    claim_results: StdMutex<HashMap<RunId, Option<ExecutionContext>>>,
    claim_candidates: Arc<StdMutex<Vec<JobCandidate>>>,
    completions: Arc<StdMutex<Vec<Completion>>>,
    heartbeats: Arc<StdMutex<Vec<HeartbeatState>>>,
    deferred_poll_deadlines: Arc<StdMutex<Vec<Instant>>>,
    cancel: CancellationToken,
    /// Fired each time `discover()` has reached its inner `select!` await
    /// point (lock + optional `poll_delay` complete, about to park on
    /// `rx.recv()`). Tests that need to order actions against that state —
    /// e.g. a silent `send_if_modified` that must land *after* the main loop
    /// has entered its `discover_fut` select — call
    /// [`MockProviderHandle::wait_discover_entered`] instead of sleeping.
    /// `notify_one` queues a permit, so a test that waits after the signal
    /// fired still wakes immediately.
    discover_entered: Arc<Notify>,
    /// Fired by `complete()` after a completion is appended to `completions`.
    /// `wait_completion` subscribes to this before checking the vec, so any
    /// completion that lands between the check and the wake is still observed.
    /// Event-driven waiting eliminates the polling loop whose wall-clock
    /// deadline was racing coverage-CI slowdown (see #10146).
    completion_notify: Arc<Notify>,
    /// Fired after `discover()` has been polled and its optional poll delay is
    /// about to start. Paused-time tests use this to avoid advancing virtual
    /// time before the discover timer exists.
    discover_poll_started: Arc<Notify>,
    discover_started_count: Arc<AtomicUsize>,
    /// Fired by `heartbeat()` after a state is appended to `heartbeats`.
    /// `wait_heartbeat_past` uses the same subscribe-then-check pattern as
    /// `wait_completion` so a heartbeat that lands mid-check is still observed.
    heartbeat_notify: Arc<Notify>,
    heartbeat_control: Arc<MockOperationControl>,
    heartbeat_max_in_flight: Arc<AtomicUsize>,
    panic_next_heartbeat: Arc<AtomicBool>,
    claim_control: Arc<MockOperationControl>,
    completion_control: Arc<MockOperationControl>,
    completion_after_finalization: Arc<AtomicBool>,
}

/// Test-side handle for driving the mock provider.
pub struct MockProviderHandle {
    startup_readiness: Arc<MockStartupReadiness>,
    pub discover_tx: mpsc::UnboundedSender<JobCandidate>,
    ready_discovery: Arc<StdMutex<VecDeque<JobCandidate>>>,
    claim_candidates: Arc<StdMutex<Vec<JobCandidate>>>,
    pub completions: Arc<StdMutex<Vec<Completion>>>,
    pub heartbeats: Arc<StdMutex<Vec<HeartbeatState>>>,
    deferred_poll_deadlines: Arc<StdMutex<Vec<Instant>>>,
    /// See [`Self::wait_discover_entered`].
    discover_entered: Arc<Notify>,
    /// See [`MockJobProvider::completion_notify`].
    completion_notify: Arc<Notify>,
    /// See [`MockJobProvider::discover_poll_started`].
    discover_poll_started: Arc<Notify>,
    discover_started_count: Arc<AtomicUsize>,
    /// See [`MockJobProvider::heartbeat_notify`].
    heartbeat_notify: Arc<Notify>,
    heartbeat_control: Arc<MockOperationControl>,
    heartbeat_max_in_flight: Arc<AtomicUsize>,
    panic_next_heartbeat: Arc<AtomicBool>,
    claim_control: Arc<MockOperationControl>,
    completion_control: Arc<MockOperationControl>,
    completion_after_finalization: Arc<AtomicBool>,
}

#[derive(Clone)]
enum MockStartupReadinessMode {
    Ready,
    Fail(String),
    WaitForRelease,
}

struct MockStartupReadiness {
    mode: StdMutex<MockStartupReadinessMode>,
    entered: Notify,
    release: Notify,
    released: AtomicBool,
    calls: AtomicUsize,
}

#[derive(Default)]
struct MockOperationControl {
    blocked: AtomicBool,
    in_flight: AtomicUsize,
    release: Notify,
    state_changed: Notify,
}

impl MockOperationControl {
    fn enter(&self) -> MockOperationInFlight<'_> {
        let in_flight = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.state_changed.notify_waiters();
        MockOperationInFlight {
            control: self,
            entered_count: in_flight,
        }
    }

    fn block(&self) {
        self.blocked.store(true, Ordering::SeqCst);
    }

    fn unblock(&self) {
        self.blocked.store(false, Ordering::SeqCst);
        self.release.notify_waiters();
    }

    fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::SeqCst)
    }

    async fn wait_in_flight(&self, expected: usize, timeout: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let changed = self.state_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();

            if self.in_flight() == expected {
                return true;
            }

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return false;
            }
            if tokio::time::timeout(remaining, changed).await.is_err() {
                return false;
            }
        }
    }

    async fn run_while_blocked(&self, on_enter: impl FnOnce(usize)) {
        // Subscribe before entering so an unblock during `on_enter` releases
        // this call even if a later block starts the next gate cycle.
        let release = self.release.notified();
        tokio::pin!(release);
        release.as_mut().enable();

        let in_flight = self.enter();
        on_enter(in_flight.entered_count);
        if self.blocked.load(Ordering::SeqCst) {
            release.await;
        }
    }
}

struct MockOperationInFlight<'a> {
    control: &'a MockOperationControl,
    entered_count: usize,
}

impl Drop for MockOperationInFlight<'_> {
    fn drop(&mut self) {
        self.control.in_flight.fetch_sub(1, Ordering::SeqCst);
        self.control.state_changed.notify_waiters();
    }
}

impl Default for MockStartupReadiness {
    fn default() -> Self {
        Self {
            mode: StdMutex::new(MockStartupReadinessMode::Ready),
            entered: Notify::new(),
            release: Notify::new(),
            released: AtomicBool::new(false),
            calls: AtomicUsize::new(0),
        }
    }
}

impl MockStartupReadiness {
    async fn prepare(&self, cancel: &CancellationToken) -> RunnerResult<()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_waiters();
        let mode = self.mode.lock().unwrap_or_else(|e| e.into_inner()).clone();

        match mode {
            MockStartupReadinessMode::Ready => Ok(()),
            MockStartupReadinessMode::Fail(message) => Err(RunnerError::Internal(message)),
            MockStartupReadinessMode::WaitForRelease => loop {
                if self.released.load(Ordering::SeqCst) {
                    return Ok(());
                }
                tokio::select! {
                    biased;
                    () = cancel.cancelled() => {
                        return Err(RunnerError::Internal(
                            "mock startup readiness cancelled".to_string(),
                        ));
                    }
                    () = self.release.notified() => {}
                }
            },
        }
    }

    fn set_failure(&self, message: impl Into<String>) {
        *self.mode.lock().unwrap_or_else(|e| e.into_inner()) =
            MockStartupReadinessMode::Fail(message.into());
        self.released.store(false, Ordering::SeqCst);
    }

    fn set_wait_for_release(&self) {
        *self.mode.lock().unwrap_or_else(|e| e.into_inner()) =
            MockStartupReadinessMode::WaitForRelease;
        self.released.store(false, Ordering::SeqCst);
    }

    fn release(&self) {
        self.released.store(true, Ordering::SeqCst);
        self.release.notify_waiters();
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl MockJobProvider {
    /// Create a new mock provider and its test-side handle.
    ///
    /// The `cancel` token should be shared with the `RunConfig` — when
    /// cancelled, `discover()` returns `None` to break the main loop.
    pub fn new(cancel: CancellationToken) -> (Arc<Self>, MockProviderHandle) {
        Self::with_poll_delay(cancel, None)
    }

    /// Create a mock provider with an explicit poll delay.
    ///
    /// When set, `discover()` sleeps for this duration before checking the
    /// channel. This simulates the API provider's HTTP poll timer — if the main
    /// loop cancels and recreates `discover()` (e.g. not pinned), the sleep
    /// restarts from scratch and jobs are never discovered.
    pub fn with_poll_delay(
        cancel: CancellationToken,
        poll_delay: Option<Duration>,
    ) -> (Arc<Self>, MockProviderHandle) {
        let (tx, rx) = mpsc::unbounded_channel();
        let ready_discovery = Arc::new(StdMutex::new(VecDeque::new()));
        let claim_candidates = Arc::new(StdMutex::new(Vec::new()));
        let completions = Arc::new(StdMutex::new(Vec::new()));
        let heartbeats = Arc::new(StdMutex::new(Vec::new()));
        let deferred_poll_deadlines = Arc::new(StdMutex::new(Vec::new()));
        let startup_readiness = Arc::new(MockStartupReadiness::default());
        let discover_entered = Arc::new(Notify::new());
        let completion_notify = Arc::new(Notify::new());
        let discover_poll_started = Arc::new(Notify::new());
        let discover_started_count = Arc::new(AtomicUsize::new(0));
        let heartbeat_notify = Arc::new(Notify::new());
        let heartbeat_control = Arc::new(MockOperationControl::default());
        let heartbeat_max_in_flight = Arc::new(AtomicUsize::new(0));
        let panic_next_heartbeat = Arc::new(AtomicBool::new(false));
        let claim_control = Arc::new(MockOperationControl::default());
        let completion_control = Arc::new(MockOperationControl::default());
        let completion_after_finalization = Arc::new(AtomicBool::new(false));
        let provider = Arc::new(Self {
            startup_readiness: Arc::clone(&startup_readiness),
            discovery: Mutex::new(rx),
            poll_delay,
            ready_discovery: Arc::clone(&ready_discovery),
            claim_results: StdMutex::new(HashMap::new()),
            claim_candidates: Arc::clone(&claim_candidates),
            completions: Arc::clone(&completions),
            heartbeats: Arc::clone(&heartbeats),
            deferred_poll_deadlines: Arc::clone(&deferred_poll_deadlines),
            cancel,
            discover_entered: Arc::clone(&discover_entered),
            completion_notify: Arc::clone(&completion_notify),
            discover_poll_started: Arc::clone(&discover_poll_started),
            discover_started_count: Arc::clone(&discover_started_count),
            heartbeat_notify: Arc::clone(&heartbeat_notify),
            heartbeat_control: Arc::clone(&heartbeat_control),
            heartbeat_max_in_flight: Arc::clone(&heartbeat_max_in_flight),
            panic_next_heartbeat: Arc::clone(&panic_next_heartbeat),
            claim_control: Arc::clone(&claim_control),
            completion_control: Arc::clone(&completion_control),
            completion_after_finalization: Arc::clone(&completion_after_finalization),
        });
        let handle = MockProviderHandle {
            startup_readiness,
            discover_tx: tx,
            ready_discovery,
            claim_candidates,
            completions,
            heartbeats,
            deferred_poll_deadlines,
            discover_entered,
            completion_notify,
            discover_poll_started,
            discover_started_count,
            heartbeat_notify,
            heartbeat_control,
            heartbeat_max_in_flight,
            panic_next_heartbeat,
            claim_control,
            completion_control,
            completion_after_finalization,
        };
        (provider, handle)
    }

    /// Pre-configure the result for a future `claim(run_id)` call.
    /// Pass `Some(ctx)` for success, `None` to simulate an unavailable claim.
    pub fn set_claim_result(&self, run_id: RunId, result: Option<ExecutionContext>) {
        self.claim_results
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(run_id, result);
    }
}

impl MockProviderHandle {
    pub fn fail_startup_readiness(&self, message: impl Into<String>) {
        self.startup_readiness.set_failure(message);
    }

    pub fn block_startup_readiness(&self) {
        self.startup_readiness.set_wait_for_release();
    }

    pub fn release_startup_readiness(&self) {
        self.startup_readiness.release();
    }

    pub async fn wait_startup_readiness_entered(&self, timeout: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.startup_readiness.entered.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            if self.startup_readiness_calls() > 0 {
                return true;
            }

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return false;
            }
            if tokio::time::timeout(remaining, notified).await.is_err() {
                return false;
            }
        }
    }

    pub fn startup_readiness_calls(&self) -> usize {
        self.startup_readiness.calls()
    }

    /// Block completion calls after recording their request payload.
    pub fn block_completions(&self) {
        self.completion_control.block();
    }

    /// Release blocked completion calls and allow later calls to return.
    pub fn unblock_completions(&self) {
        self.completion_control.unblock();
    }

    pub fn completion_in_flight(&self) -> usize {
        self.completion_control.in_flight()
    }

    pub fn require_finalization_before_completion(&self) {
        self.completion_after_finalization
            .store(true, Ordering::SeqCst);
    }

    pub fn discover_started_count(&self) -> usize {
        self.discover_started_count.load(Ordering::SeqCst)
    }

    /// Wait for a specific run's completion to appear, with timeout.
    ///
    /// Event-driven — see [`MockJobProvider::completion_notify`] for the
    /// full rationale. `timeout` is a diagnostic cap for genuine hangs,
    /// not a wall-clock work budget.
    pub async fn wait_completion(&self, run_id: RunId, timeout: Duration) -> Option<Completion> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.completion_notify.notified();
            tokio::pin!(notified);
            // Register interest before checking the vec — any notify_waiters
            // fired after this enable() will wake this future.
            notified.as_mut().enable();

            {
                let comps = self.completions.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(c) = comps.iter().find(|c| c.run_id == run_id) {
                    return Some(c.clone());
                }
            }

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return None;
            }
            if tokio::time::timeout(remaining, notified).await.is_err() {
                return None;
            }
        }
    }

    /// Wait until `discover()` has reached its inner await point.
    pub async fn wait_discover_entered(&self, timeout: Duration) -> bool {
        tokio::time::timeout(timeout, self.discover_entered.notified())
            .await
            .is_ok()
    }

    /// Wait until `discover()` has been polled at least once and its optional
    /// poll-delay timer has been created.
    pub async fn wait_discover_poll_started(&self, timeout: Duration) -> bool {
        tokio::time::timeout(timeout, self.discover_poll_started.notified())
            .await
            .is_ok()
    }

    /// Return the number of heartbeats recorded so far.
    pub fn heartbeat_count(&self) -> usize {
        self.heartbeats
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }

    /// Block heartbeat calls after recording their submitted state.
    pub fn block_heartbeats(&self) {
        self.heartbeat_control.block();
    }

    pub fn panic_next_heartbeat(&self) {
        self.panic_next_heartbeat.store(true, Ordering::SeqCst);
    }

    /// Release all currently blocked heartbeat calls and allow later calls.
    pub fn unblock_heartbeats(&self) {
        self.heartbeat_control.unblock();
    }

    pub fn heartbeat_in_flight(&self) -> usize {
        self.heartbeat_control.in_flight()
    }

    pub fn max_heartbeat_in_flight(&self) -> usize {
        self.heartbeat_max_in_flight.load(Ordering::SeqCst)
    }

    pub async fn wait_heartbeat_in_flight(&self, expected: usize, timeout: Duration) -> bool {
        self.heartbeat_control
            .wait_in_flight(expected, timeout)
            .await
    }

    pub fn claim_candidates(&self) -> Vec<JobCandidate> {
        self.claim_candidates
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn block_claims(&self) {
        self.claim_control.block();
    }

    pub fn unblock_claims(&self) {
        self.claim_control.unblock();
    }

    pub async fn wait_claim_in_flight(&self, expected: usize, timeout: Duration) -> bool {
        self.claim_control.wait_in_flight(expected, timeout).await
    }

    pub fn deferred_poll_deadlines(&self) -> Vec<Instant> {
        self.deferred_poll_deadlines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn push_ready_candidate(&self, candidate: JobCandidate) {
        self.ready_discovery
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push_back(candidate);
    }

    /// Wait until `heartbeat_count()` exceeds `baseline`, or return false on
    /// timeout. Uses the same subscribe-then-check pattern as
    /// [`wait_completion`](Self::wait_completion) — a heartbeat that lands
    /// between registering interest and reading the count still wakes the
    /// wait. `timeout` is a diagnostic cap; under `tokio::test(start_paused)`
    /// it's paused-clock time so the test does not wait wall-clock.
    pub async fn wait_heartbeat_past(&self, baseline: usize, timeout: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.heartbeat_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            if self.heartbeat_count() > baseline {
                return true;
            }

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return false;
            }
            if tokio::time::timeout(remaining, notified).await.is_err() {
                return false;
            }
        }
    }
}

#[async_trait]
impl JobProvider for MockJobProvider {
    async fn prepare_startup_readiness(&self) -> RunnerResult<()> {
        self.startup_readiness.prepare(&self.cancel).await
    }

    /// Block until a job is pushed or the token is cancelled.
    ///
    /// Holds `self.discovery` Mutex for the entire call. This keeps the
    /// historical API-provider deadlock shape available for regression tests:
    ///
    /// - If `poll_delay` is set, the delay must complete before checking
    ///   the channel. Without pinning (#8783), heartbeat ticks cancel and
    ///   recreate this future, restarting the delay from scratch.
    /// - If the caller fails to drop this future before `shutdown()` (#8898),
    ///   the Mutex deadlocks — exactly reproducing the production bug.
    async fn discover(&self) -> Option<JobCandidate> {
        self.discover_started_count.fetch_add(1, Ordering::SeqCst);
        let mut rx = self.discovery.lock().await;
        self.discover_poll_started.notify_one();
        if let Some(delay) = self.poll_delay {
            tokio::time::sleep(delay).await;
        }
        // Signal tests that the future has reached its await point — the
        // main loop has polled `discover_fut`, the discovery Mutex is held,
        // and we are about to park on `rx.recv()`. Tests ordering actions
        // against this state use `handle.wait_discover_entered(...)`.
        self.discover_entered.notify_one();
        tokio::select! {
            result = rx.recv() => result,
            () = self.cancel.cancelled() => None,
        }
    }

    async fn claim(&self, candidate: JobCandidate) -> Option<ClaimedJob> {
        let run_id = candidate.run_id();
        self.claim_candidates
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(candidate.clone());
        self.claim_control.run_while_blocked(|_| {}).await;
        let context = self
            .claim_results
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&run_id)
            .flatten()?;
        match ClaimedJob::local(run_id, context) {
            Ok(claimed) => Some(claimed),
            Err(err) => {
                warn!(
                    run_id = %err.expected_run_id,
                    context_run_id = %err.context_run_id,
                    "mock: claimed job run_id mismatch"
                );
                None
            }
        }
    }

    async fn try_discover_ready(&self) -> Option<JobCandidate> {
        self.ready_discovery
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pop_front()
    }

    fn completion_report_timing(&self) -> CompletionReportTiming {
        if self.completion_after_finalization.load(Ordering::SeqCst) {
            CompletionReportTiming::AfterFinalization
        } else {
            CompletionReportTiming::ConcurrentWithFinalization
        }
    }

    async fn complete(&self, request: CompleteRequest, _completion_auth: CompletionAuth) {
        self.completion_control
            .run_while_blocked(|_| {
                self.completions
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(Completion {
                        run_id: request.run_id,
                        exit_code: request.exit_code,
                        error: request.error,
                        sandbox_id: request.sandbox_id,
                        reuse_result: request.sandbox_reuse_result,
                        workspace_reuse_result: request.workspace_reuse_result,
                    });
                // Wake all pending `wait_completion` waiters — they re-scan the vec
                // and return if their run_id is now present.
                self.completion_notify.notify_waiters();
            })
            .await;
    }

    async fn heartbeat(&self, state: &HeartbeatState) {
        assert!(
            !self.panic_next_heartbeat.swap(false, Ordering::SeqCst),
            "injected heartbeat panic"
        );
        self.heartbeat_control
            .run_while_blocked(|in_flight| {
                self.heartbeat_max_in_flight
                    .fetch_max(in_flight, Ordering::SeqCst);
                self.heartbeats
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(state.clone());
                self.heartbeat_notify.notify_waiters();
            })
            .await;
    }

    async fn defer_poll_until(&self, deadline: Instant) {
        self.deferred_poll_deadlines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(deadline);
    }

    /// Acquire the discovery Mutex to preserve the shutdown deadlock regression shape.
    ///
    /// If `discover()` is still alive and holding the Mutex, this deadlocks.
    /// The main loop must `drop(discover_fut)` before calling this.
    async fn shutdown(&self) {
        let _lock = self.discovery.lock().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::execution_context::execution_context_for_test;

    fn minimal_context(run_id: RunId) -> ExecutionContext {
        execution_context_for_test(run_id)
    }

    fn complete_request(run_id: RunId) -> CompleteRequest {
        CompleteRequest {
            run_id,
            exit_code: 0,
            failure_reason: None,
            error: None,
            sandbox_id: None,
            sandbox_reuse_result: None,
            workspace_reuse_result: None,
            active_input_delivery_ids: Vec::new(),
        }
    }

    #[tokio::test]
    async fn claim_rejects_mismatched_context() {
        let candidate_run_id = RunId::from(uuid::Uuid::nil());
        let context_run_id = RunId::new_v4();
        let (provider, _handle) = MockJobProvider::new(CancellationToken::new());
        provider.set_claim_result(candidate_run_id, Some(minimal_context(context_run_id)));

        let claimed = provider
            .claim(JobCandidate::new(
                candidate_run_id,
                crate::profile::DEFAULT_PROFILE.to_owned(),
            ))
            .await;

        assert!(claimed.is_none());
    }

    #[tokio::test]
    async fn claim_accepts_matching_context() {
        let run_id = RunId::from(uuid::Uuid::nil());
        let (provider, _handle) = MockJobProvider::new(CancellationToken::new());
        provider.set_claim_result(run_id, Some(minimal_context(run_id)));

        let claimed = provider
            .claim(JobCandidate::new(
                run_id,
                crate::profile::DEFAULT_PROFILE.to_owned(),
            ))
            .await
            .expect("matching context should be claimed");

        assert_eq!(claimed.context().run_id, run_id);
    }

    #[tokio::test]
    async fn completion_gate_tracks_release_and_cancellation() {
        let (provider, handle) = MockJobProvider::new(CancellationToken::new());
        handle.block_completions();

        let released_run_id = RunId::new_v4();
        let released_provider = Arc::clone(&provider);
        let released = tokio::spawn(async move {
            released_provider
                .complete(complete_request(released_run_id), CompletionAuth::local())
                .await;
        });
        handle
            .wait_completion(released_run_id, Duration::from_secs(2))
            .await
            .expect("blocked completion should record its request");
        assert_eq!(handle.completion_in_flight(), 1);

        handle.unblock_completions();
        released.await.unwrap();
        assert_eq!(handle.completion_in_flight(), 0);

        handle.block_completions();
        let cancelled_run_id = RunId::new_v4();
        let cancelled_provider = Arc::clone(&provider);
        let cancelled = tokio::spawn(async move {
            cancelled_provider
                .complete(complete_request(cancelled_run_id), CompletionAuth::local())
                .await;
        });
        handle
            .wait_completion(cancelled_run_id, Duration::from_secs(2))
            .await
            .expect("cancelled completion should record its request");
        assert_eq!(handle.completion_in_flight(), 1);

        cancelled.abort();
        assert!(cancelled.await.unwrap_err().is_cancelled());
        assert_eq!(handle.completion_in_flight(), 0);
    }
}
