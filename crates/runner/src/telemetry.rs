use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use api_contracts::generated::routes;
use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::task::JoinHandle;
use tracing::warn;

use crate::duration::duration_ms;
use crate::error::{ApiFailureKind, RunnerError};
use crate::http::HttpClient;
use crate::ids::RunId;
use crate::resource_budget::ResourceBudget;
use crate::types::SandboxReuseResult;
pub(crate) use session_history::{
    SessionHistoryCacheProbeMetadata, SessionHistoryContentEncodingState,
    SessionHistoryContentLengthState, SessionHistoryResponseTelemetryMetadata,
    SessionHistoryTelemetryFields, SessionHistoryTelemetryMetadata,
    SessionHistoryTransferEncodingState, session_history_prefix_extension_action_type,
};

mod archive_size_mismatch;
mod dns_readiness;
mod history_transfer;
mod session_history;
mod workspace_session_history;

pub(crate) use archive_size_mismatch::ArchiveSizeMismatch;
pub(crate) use history_transfer::{
    HistoryCodecDecision, HistoryTransferMeasurements, HistoryTransferSource,
};
pub(crate) use workspace_session_history::WorkspaceSessionHistoryTelemetry;

/// How long before we auto-flush pending ops (matching TS: 30s).
const FLUSH_THRESHOLD: Duration = Duration::from_secs(30);

/// Timeout for telemetry HTTP requests, including API cold starts.
const TELEMETRY_TIMEOUT: Duration = Duration::from_secs(10);
const RUNNER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Why one bounded OOM evidence upload was not acknowledged.
///
/// Only fixed stage names and an HTTP status are reported. Evidence payloads
/// and response bodies stay out of the log.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OomEvidenceUploadFailure {
    Timeout,
    Transport,
    HttpStatus(u16),
    BodyOversize,
    InvalidBody,
    MissingAck,
}

impl OomEvidenceUploadFailure {
    fn from_request_error(error: &RunnerError) -> Self {
        match error {
            RunnerError::ApiTransport(error) => Self::from_api_failure_kind(error.failure_kind),
            _ => Self::Transport,
        }
    }

    fn from_api_failure_kind(failure_kind: ApiFailureKind) -> Self {
        if failure_kind == ApiFailureKind::Timeout {
            Self::Timeout
        } else {
            Self::Transport
        }
    }

    fn from_response_body_error(error: &reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::Timeout
        } else {
            Self::Transport
        }
    }

    fn reason(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Transport => "transport",
            Self::HttpStatus(_) => "http_status",
            Self::BodyOversize => "body_oversize",
            Self::InvalidBody => "invalid_body",
            Self::MissingAck => "missing_ack",
        }
    }

    fn http_status(self) -> Option<u16> {
        match self {
            Self::HttpStatus(status) => Some(status),
            _ => None,
        }
    }
}

/// Effective resource path once the guest process has spawned.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RunnerStartupPath {
    Sandbox,
    Workspace,
    Cold,
}

/// Inclusive number of Runner jobs in post-claim work before guest process spawn.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(crate) enum RunnerPreSpawnConcurrencyBucket {
    #[serde(rename = "1")]
    One,
    #[serde(rename = "2")]
    Two,
    #[serde(rename = "3_4")]
    ThreeToFour,
    #[serde(rename = "5_8")]
    FiveToEight,
    #[serde(rename = "9_plus")]
    NinePlus,
}

/// Allocated resources as a bounded share of the effective Runner budget.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(crate) enum RunnerResourceBudgetUtilizationBucket {
    #[serde(rename = "0_25")]
    ZeroToTwentyFive,
    #[serde(rename = "26_50")]
    TwentySixToFifty,
    #[serde(rename = "51_75")]
    FiftyOneToSeventyFive,
    #[serde(rename = "76_100")]
    SeventySixToOneHundred,
    #[serde(rename = "over_100")]
    OverOneHundred,
}

impl RunnerResourceBudgetUtilizationBucket {
    fn from_allocation(allocated: u32, effective: u32) -> Self {
        let allocated = u64::from(allocated);
        let effective = u64::from(effective);
        if allocated * 4 <= effective {
            Self::ZeroToTwentyFive
        } else if allocated * 2 <= effective {
            Self::TwentySixToFifty
        } else if allocated * 4 <= effective * 3 {
            Self::FiftyOneToSeventyFive
        } else if allocated <= effective {
            Self::SeventySixToOneHundred
        } else {
            Self::OverOneHundred
        }
    }
}

/// Number of leases represented by the Runner resource-budget snapshot.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(crate) enum RunnerResourceBudgetLeaseCountBucket {
    #[serde(rename = "0")]
    Zero,
    #[serde(rename = "1")]
    One,
    #[serde(rename = "2")]
    Two,
    #[serde(rename = "3_4")]
    ThreeToFour,
    #[serde(rename = "5_8")]
    FiveToEight,
    #[serde(rename = "9_plus")]
    NinePlus,
}

impl RunnerResourceBudgetLeaseCountBucket {
    fn from_count(count: usize) -> Self {
        match count {
            0 => Self::Zero,
            1 => Self::One,
            2 => Self::Two,
            3..=4 => Self::ThreeToFour,
            5..=8 => Self::FiveToEight,
            _ => Self::NinePlus,
        }
    }
}

/// One immutable view of Runner-owned resource-budget occupancy.
#[derive(Clone, Copy)]
pub(crate) struct RunnerResourceBudgetOccupancy {
    vcpu_utilization: RunnerResourceBudgetUtilizationBucket,
    memory_utilization: RunnerResourceBudgetUtilizationBucket,
    lease_count: RunnerResourceBudgetLeaseCountBucket,
}

impl RunnerResourceBudgetOccupancy {
    pub(crate) fn capture(budget: &ResourceBudget) -> Self {
        let (allocated_vcpu, allocated_memory_mb, lease_count) = budget.allocated();
        Self {
            vcpu_utilization: RunnerResourceBudgetUtilizationBucket::from_allocation(
                allocated_vcpu,
                budget.effective_vcpu(),
            ),
            memory_utilization: RunnerResourceBudgetUtilizationBucket::from_allocation(
                allocated_memory_mb,
                budget.effective_memory_mb(),
            ),
            lease_count: RunnerResourceBudgetLeaseCountBucket::from_count(lease_count),
        }
    }
}

/// Shared cohort label that becomes inactive when startup terminates before spawn.
#[derive(Clone)]
pub(crate) struct RunnerPreSpawnAttribution {
    bucket: RunnerPreSpawnConcurrencyBucket,
    resource_budget_occupancy: Option<RunnerResourceBudgetOccupancy>,
    active: Arc<AtomicBool>,
}

impl RunnerPreSpawnAttribution {
    pub(crate) fn new(bucket: RunnerPreSpawnConcurrencyBucket) -> Self {
        Self {
            bucket,
            resource_budget_occupancy: None,
            active: Arc::new(AtomicBool::new(true)),
        }
    }

    pub(crate) fn set_resource_budget_occupancy(
        &mut self,
        occupancy: RunnerResourceBudgetOccupancy,
    ) {
        self.resource_budget_occupancy = Some(occupancy);
    }

    pub(crate) fn deactivate(&self) {
        self.active.store(false, Ordering::Relaxed);
    }

    fn active(&self) -> Option<&Self> {
        self.active.load(Ordering::Relaxed).then_some(self)
    }
}

/// Per-job telemetry collector. Buffers sandbox operations and flushes them
/// periodically (auto on 30 s threshold) and at job end.
///
/// Owns its state — passed as `&mut` through the call chain, no `Mutex` needed.
#[must_use = "JobTelemetry owns pending and in-flight ops until `flush()` is awaited; dropping it loses them"]
pub struct JobTelemetry {
    http: HttpClient,
    run_id: RunId,
    sandbox_token: String,
    runner_hostname: Option<String>,
    runner_pre_spawn_attribution: Option<RunnerPreSpawnAttribution>,
    pending_ops: Vec<SandboxOp>,
    oldest_pending: Option<Instant>,
    in_flight_flushes: Vec<JoinHandle<()>>,
}

#[derive(Serialize, Clone)]
struct SandboxOp {
    ts: String,
    action_type: String,
    duration_ms: u64,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runner_startup_path: Option<RunnerStartupPath>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sandbox_reuse_result: Option<SandboxReuseResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runner_pre_spawn_concurrency_bucket: Option<RunnerPreSpawnConcurrencyBucket>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runner_resource_budget_vcpu_utilization_bucket: Option<RunnerResourceBudgetUtilizationBucket>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runner_resource_budget_memory_utilization_bucket: Option<RunnerResourceBudgetUtilizationBucket>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runner_resource_budget_lease_count_bucket: Option<RunnerResourceBudgetLeaseCountBucket>,
    #[serde(flatten)]
    session_history: Option<SessionHistoryTelemetryFields>,
    #[serde(flatten)]
    workspace_session_history: Option<WorkspaceSessionHistoryTelemetry>,
    #[serde(flatten)]
    history_transfer: Option<history_transfer::HistoryTransferTelemetry>,
    #[serde(flatten)]
    dns_readiness: Option<dns_readiness::DnsReadinessTelemetryFields>,
    #[serde(skip_serializing_if = "Option::is_none")]
    archive_size_mismatch: Option<ArchiveSizeMismatch>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TelemetryPayload {
    run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    runner_hostname: Option<String>,
    runner_version: &'static str,
    sandbox_operations: Vec<SandboxOp>,
}

impl JobTelemetry {
    /// Create a per-job telemetry collector for the runner that owns the job.
    ///
    pub(crate) fn new(
        http: HttpClient,
        run_id: RunId,
        sandbox_token: String,
        runner_hostname: Option<String>,
    ) -> Self {
        Self {
            http,
            run_id,
            sandbox_token,
            runner_hostname,
            runner_pre_spawn_attribution: None,
            pending_ops: Vec::new(),
            oldest_pending: None,
            in_flight_flushes: Vec::new(),
        }
    }

    pub(crate) fn start_runner_pre_spawn_attribution(
        &mut self,
        attribution: RunnerPreSpawnAttribution,
    ) {
        self.runner_pre_spawn_attribution = Some(attribution);
    }

    /// Stop decorating operations after the success-only Agent-ready boundary.
    pub(crate) fn finish_runner_pre_spawn_attribution(&mut self) {
        self.runner_pre_spawn_attribution = None;
    }

    /// Record a timed operation. Starts an owned auto-flush if the oldest
    /// pending op exceeds the 30 s threshold.
    pub fn record(
        &mut self,
        action_type: &str,
        duration: Duration,
        success: bool,
        error: Option<&str>,
    ) {
        self.record_inner(action_type, duration, success, error, None, None);
    }

    /// Record a timed operation with an optional bounded terminal outcome.
    pub(crate) fn record_with_outcome(
        &mut self,
        action_type: &str,
        duration: Duration,
        success: bool,
        error: Option<&str>,
        outcome: Option<&str>,
    ) {
        self.record_inner(action_type, duration, success, error, outcome, None);
    }

    /// Record a timed operation using the timestamp captured when it completed.
    ///
    /// This preserves event timing when a concurrently polled operation cannot
    /// be added to this mutable buffer until another operation also finishes.
    pub(crate) fn record_at(
        &mut self,
        action_type: &str,
        duration: Duration,
        success: bool,
        error: Option<&str>,
        completed_at: DateTime<Utc>,
    ) {
        self.push_operation(sandbox_op_at(
            action_type,
            duration,
            success,
            error,
            None,
            None,
            completed_at,
        ));
    }

    pub(crate) fn record_archive_phase_at(
        &mut self,
        record: SandboxOpRecord,
        completed_at: DateTime<Utc>,
        mismatch: Option<ArchiveSizeMismatch>,
    ) {
        let mut operation = sandbox_op_at(
            record.action_type,
            record.duration,
            record.success,
            record.error,
            None,
            None,
            completed_at,
        );
        operation.archive_size_mismatch = mismatch;
        self.push_operation(operation);
    }

    pub(crate) fn record_api_to_spawn(
        &mut self,
        duration: Duration,
        runner_startup_path: RunnerStartupPath,
        sandbox_reuse_result: SandboxReuseResult,
    ) {
        self.record_api_startup_boundary(
            "api_to_spawn",
            duration,
            runner_startup_path,
            sandbox_reuse_result,
        );
    }

    pub(crate) fn record_api_to_agent_ready(
        &mut self,
        duration: Duration,
        runner_startup_path: RunnerStartupPath,
        sandbox_reuse_result: SandboxReuseResult,
    ) {
        self.record_api_startup_boundary(
            "api_to_agent_ready",
            duration,
            runner_startup_path,
            sandbox_reuse_result,
        );
    }

    fn record_api_startup_boundary(
        &mut self,
        action_type: &'static str,
        duration: Duration,
        runner_startup_path: RunnerStartupPath,
        sandbox_reuse_result: SandboxReuseResult,
    ) {
        let mut op = sandbox_op(action_type, duration, true, None, None, None);
        op.runner_startup_path = Some(runner_startup_path);
        op.sandbox_reuse_result = Some(sandbox_reuse_result);
        self.push_operation(op);
    }

    /// Record a zero-duration operation with fixed low-cardinality outcome dimensions.
    pub(crate) fn record_bounded_outcome(
        &mut self,
        action_type: &'static str,
        success: bool,
        outcome: &'static str,
        reason: Option<&'static str>,
    ) {
        self.record_bounded_outcome_with_error(action_type, success, None, outcome, reason);
    }

    pub(crate) fn record_bounded_outcome_with_error(
        &mut self,
        action_type: &'static str,
        success: bool,
        error: Option<&'static str>,
        outcome: &'static str,
        reason: Option<&'static str>,
    ) {
        let mut op = sandbox_op(action_type, Duration::ZERO, success, error, None, None);
        op.outcome = Some(outcome.to_string());
        op.reason = reason.map(str::to_string);
        self.push_operation(op);
    }

    /// Record a timed operation with low-cardinality session-history transport
    /// dimensions derived from the hash-backed resume history ref.
    pub fn record_with_session_history_metadata(
        &mut self,
        action_type: &str,
        duration: Duration,
        success: bool,
        error: Option<&str>,
        metadata: Option<SessionHistoryTelemetryMetadata>,
    ) {
        self.record_inner(action_type, duration, success, error, None, metadata);
    }

    pub(crate) fn reporter(&self) -> SandboxOpReporter {
        SandboxOpReporter {
            http: self.http.clone(),
            run_id: self.run_id,
            sandbox_token: self.sandbox_token.clone(),
            runner_hostname: self.runner_hostname.clone(),
        }
    }

    /// Record the existing local restore interval with validated payload
    /// measurements. Only successful restores report completed guest bytes.
    pub(crate) fn record_workspace_session_history_restore(
        &mut self,
        duration: Duration,
        success: bool,
        error: Option<&str>,
        metadata: WorkspaceSessionHistoryTelemetry,
    ) {
        let mut op = sandbox_op(
            "session_history_workspace_cache_guest_restore",
            duration,
            success,
            error,
            None,
            None,
        );
        op.workspace_session_history = Some(metadata.with_restore_outcome(success));
        self.push_operation(op);
    }

    pub(crate) fn record_history_transfer(
        &mut self,
        duration: Duration,
        source: HistoryTransferSource,
        framework: &'static str,
        measurements: Option<HistoryTransferMeasurements>,
    ) {
        let success = measurements.is_some();
        let mut op = sandbox_op(
            "session_history_transfer",
            duration,
            success,
            (!success).then_some("restore_error"),
            None,
            None,
        );
        op.history_transfer = Some(history_transfer::HistoryTransferTelemetry {
            session_history_transfer_source: source,
            session_history_framework: framework,
            measurements,
        });
        self.push_operation(op);
    }

    pub(crate) async fn upload_oom_evidence(
        &self,
        evidence: &guest_contracts::oom_evidence::OomEvidence,
        sandbox_id: &str,
    ) {
        let payload = serde_json::json!({
            "runId": self.run_id.to_string(), "sandboxId": sandbox_id,
            "oomEvidence": evidence.telemetry_evidence(),
        });
        let send = async {
            let mut response = match self
                .http
                .request_route(
                    routes::webhooks::agent::telemetry::SEND,
                    &self.sandbox_token,
                )
                .timeout(Duration::from_secs(2))
                .json(&payload)
                .send("oom-evidence")
                .await
            {
                Ok(response) => response,
                Err(error) => return Err(OomEvidenceUploadFailure::from_request_error(&error)),
            };
            let status = response.status();
            if !status.is_success() {
                return Err(OomEvidenceUploadFailure::HttpStatus(status.as_u16()));
            }
            let mut bytes = Vec::new();
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => {
                        if bytes.len() + chunk.len() > 1024 {
                            return Err(OomEvidenceUploadFailure::BodyOversize);
                        }
                        bytes.extend_from_slice(&chunk);
                    }
                    Ok(None) => break,
                    Err(error) => {
                        return Err(OomEvidenceUploadFailure::from_response_body_error(&error));
                    }
                }
            }
            let Ok(body) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                return Err(OomEvidenceUploadFailure::InvalidBody);
            };
            if body
                .get("oomEvidenceVersion")
                .and_then(serde_json::Value::as_u64)
                != Some(1)
            {
                return Err(OomEvidenceUploadFailure::MissingAck);
            }
            Ok(())
        };
        // Report which delivery stage failed. A bare warning cannot distinguish
        // a rejected payload from an unconfigured receiver or a slow response.
        let failure = match tokio::time::timeout(Duration::from_secs(2), send).await {
            Ok(Ok(())) => return,
            Ok(Err(failure)) => failure,
            Err(_) => OomEvidenceUploadFailure::Timeout,
        };
        warn!(
            run_id = %self.run_id,
            reason = failure.reason(),
            http_status = failure.http_status(),
            "guest oom evidence upload unacknowledged; host evidence retained"
        );
    }

    fn record_inner(
        &mut self,
        action_type: &str,
        duration: Duration,
        success: bool,
        error: Option<&str>,
        outcome: Option<&str>,
        metadata: Option<SessionHistoryTelemetryMetadata>,
    ) {
        self.push_operation(sandbox_op(
            action_type,
            duration,
            success,
            error,
            outcome,
            metadata,
        ));
    }

    fn push_operation(&mut self, mut operation: SandboxOp) {
        if let Some(attribution) = self
            .runner_pre_spawn_attribution
            .as_ref()
            .and_then(RunnerPreSpawnAttribution::active)
        {
            operation.runner_pre_spawn_concurrency_bucket = Some(attribution.bucket);
            if let Some(occupancy) = attribution.resource_budget_occupancy {
                operation.runner_resource_budget_vcpu_utilization_bucket =
                    Some(occupancy.vcpu_utilization);
                operation.runner_resource_budget_memory_utilization_bucket =
                    Some(occupancy.memory_utilization);
                operation.runner_resource_budget_lease_count_bucket = Some(occupancy.lease_count);
            }
        }
        self.pending_ops.push(operation);
        if self.oldest_pending.is_none() {
            self.oldest_pending = Some(Instant::now());
        }

        if let Some(oldest) = self.oldest_pending
            && oldest.elapsed() >= FLUSH_THRESHOLD
        {
            self.start_auto_flush();
        }
    }

    /// Final flush — awaits buffered and already-started HTTP requests.
    /// Consumes self so callers can't accidentally record after flushing.
    pub async fn flush(mut self) {
        if self.pending_ops.is_empty() && self.in_flight_flushes.is_empty() {
            return;
        }
        let ops = std::mem::take(&mut self.pending_ops);
        let in_flight_flushes = std::mem::take(&mut self.in_flight_flushes);
        let run_id = self.run_id;
        let runner_hostname = self.runner_hostname.clone();

        tokio::join!(
            send_telemetry(
                &self.http,
                run_id,
                &self.sandbox_token,
                runner_hostname,
                ops,
            ),
            drain_in_flight_flushes(run_id, in_flight_flushes),
        );
    }

    /// Snapshot of buffered ops for tests. Returns `(action_type, success, error)`
    /// tuples in insertion order.
    #[cfg(test)]
    pub(crate) fn pending_ops_snapshot(&self) -> Vec<(String, bool, Option<String>)> {
        self.pending_ops
            .iter()
            .map(|op| (op.action_type.clone(), op.success, op.error.clone()))
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn pending_workspace_history_restore_payloads(&self) -> Vec<serde_json::Value> {
        self.pending_ops
            .iter()
            .filter(|op| op.workspace_session_history.is_some())
            .map(|op| serde_json::to_value(op).expect("serialize workspace restore operation"))
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn pending_history_transfer_payloads(&self) -> Vec<serde_json::Value> {
        self.pending_ops
            .iter()
            .filter(|op| op.history_transfer.is_some())
            .map(|op| serde_json::to_value(op).expect("serialize history transfer operation"))
            .collect()
    }

    /// Snapshot of buffered ops for tests that need to assert duration semantics.
    #[cfg(test)]
    pub(crate) fn pending_ops_with_duration_snapshot(
        &self,
    ) -> Vec<(String, u64, bool, Option<String>)> {
        self.pending_ops
            .iter()
            .map(|op| {
                (
                    op.action_type.clone(),
                    op.duration_ms,
                    op.success,
                    op.error.clone(),
                )
            })
            .collect()
    }

    /// Snapshot of buffered low-cardinality outcome dimensions for tests.
    #[cfg(test)]
    pub(crate) fn pending_ops_with_outcome_snapshot(
        &self,
    ) -> Vec<(String, bool, Option<String>, Option<String>)> {
        self.pending_ops
            .iter()
            .map(|op| {
                (
                    op.action_type.clone(),
                    op.success,
                    op.outcome.clone(),
                    op.reason.clone(),
                )
            })
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn pending_ops_with_session_history_metadata_snapshot(
        &self,
    ) -> Vec<SessionHistoryTelemetrySnapshot> {
        self.pending_ops
            .iter()
            .map(|op| SessionHistoryTelemetrySnapshot {
                action_type: op.action_type.clone(),
                success: op.success,
                error: op.error.clone(),
                session_history: op.session_history,
            })
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn pending_ops_with_runner_startup_snapshot(
        &self,
    ) -> Vec<RunnerStartupTelemetrySnapshot> {
        self.pending_ops
            .iter()
            .map(|op| RunnerStartupTelemetrySnapshot {
                action_type: op.action_type.clone(),
                runner_startup_path: op.runner_startup_path,
                sandbox_reuse_result: op.sandbox_reuse_result,
                runner_pre_spawn_concurrency_bucket: op.runner_pre_spawn_concurrency_bucket,
                runner_resource_budget_vcpu_utilization_bucket: op
                    .runner_resource_budget_vcpu_utilization_bucket,
                runner_resource_budget_memory_utilization_bucket: op
                    .runner_resource_budget_memory_utilization_bucket,
                runner_resource_budget_lease_count_bucket: op
                    .runner_resource_budget_lease_count_bucket,
            })
            .collect()
    }

    /// Rewind the oldest-pending marker to simulate a buffered op that has
    /// aged past the auto-flush threshold, without needing a real sleep or a
    /// paused tokio clock.
    #[cfg(test)]
    pub(crate) fn rewind_oldest_pending_for_test(&mut self, by: Duration) {
        if let Some(instant) = self.oldest_pending {
            self.oldest_pending = Some(instant - by);
        }
    }

    /// Start an owned flush for auto-threshold flushes.
    fn start_auto_flush(&mut self) {
        let ops = std::mem::take(&mut self.pending_ops);
        self.oldest_pending = None;

        let http = self.http.clone();
        let run_id = self.run_id;
        let sandbox_token = self.sandbox_token.clone();
        let runner_hostname = self.runner_hostname.clone();

        let handle = tokio::spawn(async move {
            send_telemetry(&http, run_id, &sandbox_token, runner_hostname, ops).await;
        });
        self.in_flight_flushes.push(handle);
    }
}

#[derive(Clone)]
pub(crate) struct SandboxOpReporter {
    http: HttpClient,
    run_id: RunId,
    sandbox_token: String,
    runner_hostname: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SandboxOpRecord {
    pub(crate) action_type: &'static str,
    pub(crate) duration: Duration,
    pub(crate) success: bool,
    pub(crate) error: Option<&'static str>,
}

impl SandboxOpRecord {
    pub(crate) const fn new(
        action_type: &'static str,
        duration: Duration,
        success: bool,
        error: Option<&'static str>,
    ) -> Self {
        Self {
            action_type,
            duration,
            success,
            error,
        }
    }
}

impl SandboxOpReporter {
    pub(crate) async fn report(&self, records: Vec<SandboxOpRecord>) {
        let ops = records
            .into_iter()
            .map(|record| {
                sandbox_op(
                    record.action_type,
                    record.duration,
                    record.success,
                    record.error,
                    None,
                    None,
                )
            })
            .collect();
        send_telemetry(
            &self.http,
            self.run_id,
            &self.sandbox_token,
            self.runner_hostname.clone(),
            ops,
        )
        .await;
    }
}

#[cfg(test)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionHistoryTelemetrySnapshot {
    pub(crate) action_type: String,
    pub(crate) success: bool,
    pub(crate) error: Option<String>,
    pub(crate) session_history: Option<SessionHistoryTelemetryFields>,
}

#[cfg(test)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RunnerStartupTelemetrySnapshot {
    pub(crate) action_type: String,
    pub(crate) runner_startup_path: Option<RunnerStartupPath>,
    pub(crate) sandbox_reuse_result: Option<SandboxReuseResult>,
    pub(crate) runner_pre_spawn_concurrency_bucket: Option<RunnerPreSpawnConcurrencyBucket>,
    pub(crate) runner_resource_budget_vcpu_utilization_bucket:
        Option<RunnerResourceBudgetUtilizationBucket>,
    pub(crate) runner_resource_budget_memory_utilization_bucket:
        Option<RunnerResourceBudgetUtilizationBucket>,
    pub(crate) runner_resource_budget_lease_count_bucket:
        Option<RunnerResourceBudgetLeaseCountBucket>,
}

fn sandbox_op(
    action_type: &str,
    duration: Duration,
    success: bool,
    error: Option<&str>,
    outcome: Option<&str>,
    metadata: Option<SessionHistoryTelemetryMetadata>,
) -> SandboxOp {
    sandbox_op_at(
        action_type,
        duration,
        success,
        error,
        outcome,
        metadata,
        Utc::now(),
    )
}

fn sandbox_op_at(
    action_type: &str,
    duration: Duration,
    success: bool,
    error: Option<&str>,
    outcome: Option<&str>,
    metadata: Option<SessionHistoryTelemetryMetadata>,
    completed_at: DateTime<Utc>,
) -> SandboxOp {
    SandboxOp {
        ts: completed_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        action_type: action_type.to_string(),
        duration_ms: duration_ms(duration),
        success,
        error: error.map(String::from),
        outcome: outcome.map(String::from),
        reason: None,
        runner_startup_path: None,
        sandbox_reuse_result: None,
        runner_pre_spawn_concurrency_bucket: None,
        runner_resource_budget_vcpu_utilization_bucket: None,
        runner_resource_budget_memory_utilization_bucket: None,
        runner_resource_budget_lease_count_bucket: None,
        session_history: metadata.map(SessionHistoryTelemetryFields::from),
        workspace_session_history: None,
        history_transfer: None,
        dns_readiness: None,
        archive_size_mismatch: None,
    }
}

async fn drain_in_flight_flushes(run_id: RunId, in_flight_flushes: Vec<JoinHandle<()>>) {
    for handle in in_flight_flushes {
        if let Err(e) = handle.await {
            warn!(run_id = %run_id, error = %e, "telemetry auto-flush task failed");
        }
    }
}

async fn send_telemetry(
    http: &HttpClient,
    run_id: RunId,
    sandbox_token: &str,
    runner_hostname: Option<String>,
    ops: Vec<SandboxOp>,
) {
    if ops.is_empty() {
        return;
    }

    let payload = TelemetryPayload {
        run_id: run_id.to_string(),
        runner_hostname,
        runner_version: RUNNER_VERSION,
        sandbox_operations: ops,
    };

    let req = http
        .request_route(routes::webhooks::agent::telemetry::SEND, sandbox_token)
        .timeout(TELEMETRY_TIMEOUT)
        .json(&payload);

    match req.send("telemetry").await {
        Ok(resp) if !resp.status().is_success() => {
            warn!(run_id = %run_id, status = %resp.status(), "telemetry flush rejected");
        }
        Err(error) => match &error {
            RunnerError::ApiTransport(api_error) => warn!(
                run_id = %run_id,
                error = %error,
                endpoint = api_error.request.endpoint_label,
                method = %api_error.request.method,
                host = %api_error.request.host,
                path = %api_error.request.path,
                client_request_id = %api_error.request.client_request_id,
                client_session_id = %api_error.request.client_session_id,
                client_version = %api_error.request.client_version,
                failure_kind = api_error.failure_kind.as_str(),
                failure_cause = api_error.failure_cause.as_str(),
                error_summary = %api_error.summary,
                "telemetry flush failed"
            ),
            _ => warn!(run_id = %run_id, error = %error, "telemetry flush failed"),
        },
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing::{Level, instrument::WithSubscriber};
    use tracing_subscriber::prelude::*;
    use tracing_test_support::CapturedEvents;

    use crate::http::HttpClientConfig;
    use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, json_response};
    use crate::types::{
        ResumeSessionHistoryDownloadSource, ResumeSessionHistoryEncoding, ResumeSessionHistoryRef,
        ResumeSessionHistoryRefKind,
    };

    fn http_client() -> HttpClient {
        http_client_for_api_url("http://localhost")
    }

    pub(super) fn http_client_for_api_url(api_url: &str) -> HttpClient {
        HttpClient::new(HttpClientConfig {
            api_url: api_url.to_string(),
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
        })
        .unwrap()
    }

    fn session_history_metadata() -> SessionHistoryTelemetryMetadata {
        SessionHistoryTelemetryMetadata::from_ref(&ResumeSessionHistoryRef {
            kind: ResumeSessionHistoryRefKind::Blob,
            hash: "hash".to_string(),
            url: "https://example.com/history".to_string(),
            encoding: ResumeSessionHistoryEncoding::Gzip,
            raw_size: 128 * 1024,
            encoded_size: 16 * 1024,
            download_source: Some(ResumeSessionHistoryDownloadSource::ConfiguredPublicEndpoint),
        })
    }

    fn oom_evidence_for_test() -> guest_contracts::oom_evidence::OomEvidence {
        serde_json::from_str(include_str!(
            "../../guest-contracts/tests/fixtures/oom-evidence-v1.json"
        ))
        .unwrap()
    }

    #[test]
    fn oom_evidence_upload_failure_keeps_timeout_distinct_from_transport() {
        assert_eq!(
            OomEvidenceUploadFailure::from_api_failure_kind(crate::error::ApiFailureKind::Timeout,),
            OomEvidenceUploadFailure::Timeout
        );
        assert_eq!(
            OomEvidenceUploadFailure::from_api_failure_kind(crate::error::ApiFailureKind::Request,),
            OomEvidenceUploadFailure::Transport
        );
    }

    #[test]
    fn sandbox_op_omits_optional_fields_without_session_history() {
        let op = SandboxOp {
            ts: "2026-01-15T10:00:00+00:00".to_string(),
            action_type: "sandbox_create".to_string(),
            duration_ms: 1500,
            success: true,
            error: None,
            outcome: None,
            reason: None,
            runner_startup_path: None,
            sandbox_reuse_result: None,
            runner_pre_spawn_concurrency_bucket: None,
            runner_resource_budget_vcpu_utilization_bucket: None,
            runner_resource_budget_memory_utilization_bucket: None,
            runner_resource_budget_lease_count_bucket: None,
            session_history: None,
            workspace_session_history: None,
            history_transfer: None,
            dns_readiness: None,
            archive_size_mismatch: None,
        };
        let json = serde_json::to_value(&op).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "ts": "2026-01-15T10:00:00+00:00",
                "action_type": "sandbox_create",
                "duration_ms": 1500,
                "success": true,
            })
        );
    }

    #[test]
    fn bounded_outcome_serializes_fixed_dimensions() {
        let mut telemetry = JobTelemetry::new(http_client(), RunId::nil(), "tok".to_string(), None);
        telemetry.record_bounded_outcome(
            "storage_cache_fresh_delivery_scan_groups",
            true,
            "17_plus",
            Some("prepared"),
        );

        assert_eq!(
            serde_json::to_value(&telemetry.pending_ops[0]).unwrap(),
            serde_json::json!({
                "ts": telemetry.pending_ops[0].ts.clone(),
                "action_type": "storage_cache_fresh_delivery_scan_groups",
                "duration_ms": 0,
                "success": true,
                "outcome": "17_plus",
                "reason": "prepared",
            })
        );
    }

    #[tokio::test]
    async fn record_with_outcome_is_sent_in_flush_payload() {
        use httpmock::prelude::*;

        let server = MockServer::start_async().await;
        let telemetry_mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/api/webhooks/agent/telemetry")
                    .body_includes(r#""action_type":"runner_host_physical_park_balloon_settle""#)
                    .body_includes(r#""duration_ms":125"#)
                    .body_includes(r#""success":true"#)
                    .body_includes(r#""outcome":"target_reached""#);
                then.status(200)
                    .header("content-type", "application/json")
                    .body(r#"{"success":true,"id":"ok"}"#);
            })
            .await;
        let mut telemetry = JobTelemetry::new(
            http_client_for_api_url(&server.base_url()),
            RunId::nil(),
            "tok".to_string(),
            None,
        );
        telemetry.record_with_outcome(
            "runner_host_physical_park_balloon_settle",
            Duration::from_millis(125),
            true,
            None,
            Some("target_reached"),
        );
        telemetry.flush().await;

        telemetry_mock.assert_calls_async(1).await;
    }

    #[test]
    fn api_startup_boundaries_serialize_bounded_startup_metadata() {
        let mut telemetry = JobTelemetry::new(http_client(), RunId::nil(), "tok".to_string(), None);
        let budget = Arc::new(ResourceBudget::new(4, 400, 1.0, 0));
        let _lease = ResourceBudget::try_reserve_lease(&budget, 2, 300).unwrap();
        let mut attribution =
            RunnerPreSpawnAttribution::new(RunnerPreSpawnConcurrencyBucket::ThreeToFour);
        attribution.set_resource_budget_occupancy(RunnerResourceBudgetOccupancy::capture(&budget));
        telemetry.start_runner_pre_spawn_attribution(attribution);
        telemetry.record_api_to_spawn(
            Duration::from_millis(125),
            RunnerStartupPath::Workspace,
            SandboxReuseResult::PoolMiss,
        );
        telemetry.record_api_to_agent_ready(
            Duration::from_millis(150),
            RunnerStartupPath::Workspace,
            SandboxReuseResult::PoolMiss,
        );

        assert_eq!(
            serde_json::to_value(&telemetry.pending_ops[0]).unwrap(),
            serde_json::json!({
                "ts": telemetry.pending_ops[0].ts.clone(),
                "action_type": "api_to_spawn",
                "duration_ms": 125,
                "success": true,
                "runner_startup_path": "workspace",
                "sandbox_reuse_result": "poolMiss",
                "runner_pre_spawn_concurrency_bucket": "3_4",
                "runner_resource_budget_vcpu_utilization_bucket": "51_75",
                "runner_resource_budget_memory_utilization_bucket": "51_75",
                "runner_resource_budget_lease_count_bucket": "1",
            })
        );
        assert_eq!(
            serde_json::to_value(&telemetry.pending_ops[1]).unwrap(),
            serde_json::json!({
                "ts": telemetry.pending_ops[1].ts.clone(),
                "action_type": "api_to_agent_ready",
                "duration_ms": 150,
                "success": true,
                "runner_startup_path": "workspace",
                "sandbox_reuse_result": "poolMiss",
                "runner_pre_spawn_concurrency_bucket": "3_4",
                "runner_resource_budget_vcpu_utilization_bucket": "51_75",
                "runner_resource_budget_memory_utilization_bucket": "51_75",
                "runner_resource_budget_lease_count_bucket": "1",
            })
        );
    }

    #[tokio::test]
    async fn history_transfer_measurements_reach_the_webhook_without_rounding_away_zero_fields() {
        use httpmock::prelude::*;
        use sandbox::{FileCompression, FileWriteMeasurements};

        let server = MockServer::start_async().await;
        let telemetry_mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/api/webhooks/agent/telemetry")
                    .body_includes(r#""action_type":"session_history_transfer""#)
                    .body_includes(r#""session_history_transfer_source":"workspace_cache""#)
                    .body_includes(r#""session_history_framework":"codex""#)
                    .body_includes(r#""session_history_wire_codec":"zstd""#)
                    .body_includes(r#""session_history_codec_decision":"above_threshold""#)
                    .body_includes(r#""session_history_restore_representation":"raw""#)
                    .body_includes(r#""session_history_transfer_bytes":17825792"#)
                    .body_includes(r#""session_history_wire_bytes":2048"#)
                    .body_includes(r#""session_history_write_requests":2"#)
                    .body_includes(r#""session_history_selection_ms":1"#)
                    .body_includes(r#""session_history_file_gate_wait_ms":0"#)
                    .body_includes(r#""session_history_requests_ms":4"#)
                    .body_includes(r#""session_history_encoder_pipeline_ms":3"#)
                    .body_includes(r#""session_history_publication_ms":2"#);
                then.status(200)
                    .json_body(serde_json::json!({"success": true, "id": "ok"}));
            })
            .await;
        let mut telemetry = JobTelemetry::new(
            http_client_for_api_url(&server.base_url()),
            RunId::nil(),
            "tok".into(),
            None,
        );
        telemetry.record_history_transfer(
            Duration::from_millis(10),
            HistoryTransferSource::WorkspaceCache,
            "codex",
            Some(HistoryTransferMeasurements::new(
                FileCompression::Zstd,
                HistoryCodecDecision::AboveThreshold,
                Duration::from_millis(1),
                17 * 1024 * 1024,
                false,
                Some(FileWriteMeasurements {
                    wire_payload_bytes: 2048,
                    requests: 2,
                    file_gate_wait: Duration::from_micros(999),
                    requests_elapsed: Duration::from_millis(4),
                    encoder_pipeline_elapsed: Duration::from_millis(3),
                    publication_elapsed: Duration::from_millis(2),
                }),
            )),
        );
        telemetry.flush().await;
        telemetry_mock.assert_calls_async(1).await;
    }

    #[test]
    fn resource_budget_occupancy_uses_fixed_buckets() {
        for (allocated, effective, expected) in [
            (
                0,
                0,
                RunnerResourceBudgetUtilizationBucket::ZeroToTwentyFive,
            ),
            (1, 0, RunnerResourceBudgetUtilizationBucket::OverOneHundred),
            (
                25,
                100,
                RunnerResourceBudgetUtilizationBucket::ZeroToTwentyFive,
            ),
            (
                26,
                100,
                RunnerResourceBudgetUtilizationBucket::TwentySixToFifty,
            ),
            (
                50,
                100,
                RunnerResourceBudgetUtilizationBucket::TwentySixToFifty,
            ),
            (
                51,
                100,
                RunnerResourceBudgetUtilizationBucket::FiftyOneToSeventyFive,
            ),
            (
                75,
                100,
                RunnerResourceBudgetUtilizationBucket::FiftyOneToSeventyFive,
            ),
            (
                76,
                100,
                RunnerResourceBudgetUtilizationBucket::SeventySixToOneHundred,
            ),
            (
                100,
                100,
                RunnerResourceBudgetUtilizationBucket::SeventySixToOneHundred,
            ),
            (
                101,
                100,
                RunnerResourceBudgetUtilizationBucket::OverOneHundred,
            ),
        ] {
            assert_eq!(
                RunnerResourceBudgetUtilizationBucket::from_allocation(allocated, effective),
                expected,
            );
        }

        for (count, expected) in [
            (0, RunnerResourceBudgetLeaseCountBucket::Zero),
            (1, RunnerResourceBudgetLeaseCountBucket::One),
            (2, RunnerResourceBudgetLeaseCountBucket::Two),
            (3, RunnerResourceBudgetLeaseCountBucket::ThreeToFour),
            (4, RunnerResourceBudgetLeaseCountBucket::ThreeToFour),
            (5, RunnerResourceBudgetLeaseCountBucket::FiveToEight),
            (8, RunnerResourceBudgetLeaseCountBucket::FiveToEight),
            (9, RunnerResourceBudgetLeaseCountBucket::NinePlus),
        ] {
            assert_eq!(
                RunnerResourceBudgetLeaseCountBucket::from_count(count),
                expected,
            );
        }
    }

    #[test]
    fn telemetry_payload_flattens_session_history_fields() {
        let metadata = session_history_metadata()
            .with_cache_probe(SessionHistoryCacheProbeMetadata::new(true, false))
            .with_response(SessionHistoryResponseTelemetryMetadata::new(
                SessionHistoryContentLengthState::MatchesExpected,
                SessionHistoryContentEncodingState::Absent,
                SessionHistoryTransferEncodingState::Absent,
            ));
        let payload = TelemetryPayload {
            run_id: "abc-123".to_string(),
            runner_hostname: None,
            runner_version: RUNNER_VERSION,
            sandbox_operations: vec![SandboxOp {
                ts: "2026-01-15T10:00:00+00:00".to_string(),
                action_type: "test".to_string(),
                duration_ms: 100,
                success: true,
                error: None,
                outcome: None,
                reason: None,
                runner_startup_path: None,
                sandbox_reuse_result: None,
                runner_pre_spawn_concurrency_bucket: None,
                runner_resource_budget_vcpu_utilization_bucket: None,
                runner_resource_budget_memory_utilization_bucket: None,
                runner_resource_budget_lease_count_bucket: None,
                session_history: Some(metadata.into()),
                workspace_session_history: None,
                history_transfer: None,
                dns_readiness: None,
                archive_size_mismatch: None,
            }],
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "runId": "abc-123",
                "runnerVersion": RUNNER_VERSION,
                "sandboxOperations": [{
                    "ts": "2026-01-15T10:00:00+00:00",
                    "action_type": "test",
                    "duration_ms": 100,
                    "success": true,
                    "encoding": "gzip",
                    "session_history_raw_size_bucket": "64_256_kib",
                    "session_history_encoded_size_bucket": "lt_64_kib",
                    "session_history_compression_ratio_bucket": "lt_0_25",
                    "session_history_ref_seen_recently": "true",
                    "session_history_ref_download_inflight": "false",
                    "session_history_content_length_state": "matches_expected",
                    "session_history_content_encoding_state": "absent",
                    "session_history_transfer_encoding_state": "absent",
                    "session_history_download_source": "configured_public_endpoint",
                }],
            })
        );
    }

    #[test]
    fn telemetry_payload_includes_canonical_attribution() {
        let payload = TelemetryPayload {
            run_id: "abc-123".to_string(),
            runner_hostname: Some("prod-1.aws.vm3.ai".to_string()),
            runner_version: RUNNER_VERSION,
            sandbox_operations: vec![],
        };

        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            serde_json::json!({
                "runId": "abc-123",
                "runnerHostname": "prod-1.aws.vm3.ai",
                "runnerVersion": RUNNER_VERSION,
                "sandboxOperations": [],
            })
        );
    }

    #[test]
    fn new_creates_empty_telemetry() {
        let http = http_client();
        let telemetry = JobTelemetry::new(http, RunId::nil(), "tok".to_string(), None);
        assert!(telemetry.pending_ops.is_empty());
        assert!(telemetry.oldest_pending.is_none());
        assert!(telemetry.in_flight_flushes.is_empty());
    }

    #[test]
    fn record_buffers_ops() {
        let http = http_client();
        let mut telemetry = JobTelemetry::new(http, RunId::nil(), "tok".to_string(), None);

        telemetry.record("sandbox_create", Duration::from_millis(500), true, None);
        telemetry.record(
            "agent_execute",
            Duration::from_secs(10),
            false,
            Some("timeout"),
        );

        assert_eq!(telemetry.pending_ops.len(), 2);
        assert_eq!(telemetry.pending_ops[0].action_type, "sandbox_create");
        assert_eq!(telemetry.pending_ops[0].duration_ms, 500);
        assert!(telemetry.pending_ops[0].success);
        assert!(telemetry.pending_ops[0].error.is_none());
        assert_eq!(telemetry.pending_ops[1].action_type, "agent_execute");
        assert!(!telemetry.pending_ops[1].success);
        assert_eq!(telemetry.pending_ops[1].error.as_deref(), Some("timeout"));
        assert!(telemetry.oldest_pending.is_some());
    }

    #[test]
    fn record_with_session_history_metadata_buffers_low_cardinality_buckets() {
        let http = http_client();
        let mut telemetry = JobTelemetry::new(http, RunId::nil(), "tok".to_string(), None);
        let metadata = session_history_metadata()
            .with_cache_probe(SessionHistoryCacheProbeMetadata::new(false, true))
            .with_response(SessionHistoryResponseTelemetryMetadata::new(
                SessionHistoryContentLengthState::MatchesExpected,
                SessionHistoryContentEncodingState::Absent,
                SessionHistoryTransferEncodingState::Chunked,
            ));

        telemetry.record_with_session_history_metadata(
            "session_history_download",
            Duration::from_millis(500),
            true,
            None,
            Some(metadata),
        );

        assert_eq!(
            telemetry.pending_ops_with_session_history_metadata_snapshot(),
            vec![SessionHistoryTelemetrySnapshot {
                action_type: "session_history_download".to_string(),
                success: true,
                error: None,
                session_history: Some(metadata.into()),
            }]
        );
    }

    #[test]
    fn record_saturates_large_duration() {
        let http = http_client();
        let mut telemetry = JobTelemetry::new(http, RunId::nil(), "tok".to_string(), None);

        telemetry.record("huge_op", Duration::MAX, true, None);

        assert_eq!(telemetry.pending_ops.len(), 1);
        assert_eq!(telemetry.pending_ops[0].duration_ms, u64::MAX);
    }

    #[tokio::test]
    async fn record_within_threshold_does_not_flush() {
        let http = http_client();
        let mut telemetry = JobTelemetry::new(http, RunId::nil(), "tok".to_string(), None);

        telemetry.record("op1", Duration::from_millis(10), true, None);
        telemetry.record("op2", Duration::from_millis(10), true, None);

        assert_eq!(telemetry.pending_ops_snapshot().len(), 2);
        assert!(telemetry.oldest_pending.is_some());
    }

    #[tokio::test]
    async fn telemetry_flush_preserves_captured_operation_timestamp() {
        use httpmock::prelude::*;

        let server = MockServer::start_async().await;
        let telemetry_mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/api/webhooks/agent/telemetry")
                    .body_includes(r#""ts":"2026-08-11T10:20:30.456Z""#)
                    .body_includes(r#""action_type":"concurrent_operation""#)
                    .body_includes(r#""runnerHostname":"prod-1.aws.vm3.ai""#)
                    .body_includes(format!(r#""runnerVersion":"{RUNNER_VERSION}""#));
                then.status(200)
                    .header("content-type", "application/json")
                    .body(r#"{"success":true,"id":"ok"}"#);
            })
            .await;
        let mut telemetry = JobTelemetry::new(
            http_client_for_api_url(&server.base_url()),
            RunId::nil(),
            "tok".to_string(),
            Some("prod-1.aws.vm3.ai".to_string()),
        );
        let completed_at = DateTime::parse_from_rfc3339("2026-08-11T10:20:30.456Z")
            .unwrap()
            .with_timezone(&Utc);

        telemetry.record_at(
            "concurrent_operation",
            Duration::from_millis(25),
            true,
            None,
            completed_at,
        );
        telemetry.flush().await;

        telemetry_mock.assert_calls_async(1).await;
    }

    #[tokio::test]
    async fn archive_mismatch_keeps_exact_u64_text_and_completion_time_through_auto_flush() {
        let receiver = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
            "200 OK",
            r#"{"success":true}"#,
        ))])
        .await;
        let mut telemetry = JobTelemetry::new(
            http_client_for_api_url(&receiver.url()),
            RunId::nil(),
            "tok".to_string(),
            None,
        );
        telemetry.record("previous_operation", Duration::ZERO, true, None);
        telemetry.rewind_oldest_pending_for_test(FLUSH_THRESHOLD + Duration::from_millis(1));
        let completed_at = DateTime::parse_from_rfc3339("2026-09-18T02:03:04.567Z")
            .unwrap()
            .with_timezone(&Utc);
        telemetry.record_archive_phase_at(
            SandboxOpRecord::new(
                "storage_cache_fresh_delivery_headers",
                Duration::from_millis(7),
                false,
                Some("response-size-mismatch"),
            ),
            completed_at,
            Some(ArchiveSizeMismatch::new(
                5,
                u64::MAX,
                crate::storage_plan::ArchiveHandle::artifact(0),
                &reqwest::header::HeaderMap::new(),
            )),
        );
        telemetry.flush().await;
        let requests = receiver.assert_finished_with_requests().await;
        assert_eq!(requests.len(), 1);
        let (_, body) = requests[0].split_once("\r\n\r\n").unwrap();
        let payload: serde_json::Value = serde_json::from_str(body).unwrap();
        let operations = payload["sandboxOperations"].as_array().unwrap();
        assert_eq!(operations.len(), 2);
        assert!(operations[0].get("archive_size_mismatch").is_none());
        assert_eq!(
            operations[1],
            serde_json::json!({
                "ts": "2026-09-18T02:03:04.567Z",
                "action_type": "storage_cache_fresh_delivery_headers",
                "duration_ms": 7,
                "success": false,
                "error": "response-size-mismatch",
                "archive_size_mismatch": {
                    "expected_bytes": "5",
                    "response_bytes": "18446744073709551615",
                    "source_kind": "artifact",
                    "source_index": 0,
                    "content_encoding": "absent",
                },
            })
        );
    }

    #[tokio::test]
    async fn auto_flush_triggers_after_threshold() {
        let http = http_client();
        let mut telemetry = JobTelemetry::new(http, RunId::nil(), "tok".to_string(), None);

        telemetry.record("op1", Duration::from_millis(10), true, None);
        assert_eq!(telemetry.pending_ops_snapshot().len(), 1);

        // Age the oldest-pending marker past the threshold so the next record
        // starts an owned auto flush.
        telemetry.rewind_oldest_pending_for_test(FLUSH_THRESHOLD + Duration::from_millis(1));
        telemetry.record("op2", Duration::from_millis(10), true, None);

        // start_auto_flush drains the buffer (including the op that
        // tripped the threshold) and resets the oldest-pending marker so the
        // next record re-seeds it.
        assert!(telemetry.pending_ops_snapshot().is_empty());
        assert!(telemetry.oldest_pending.is_none());
        assert_eq!(telemetry.in_flight_flushes.len(), 1);

        for handle in telemetry.in_flight_flushes.drain(..) {
            handle.abort();
            let _ = handle.await;
        }
    }

    #[tokio::test]
    async fn flush_waits_for_in_flight_auto_flush_after_buffer_is_drained() {
        use futures_util::FutureExt;

        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitThenRespond {
            release: release_rx,
            response: json_response("200 OK", r#"{"success":true}"#),
        }])
        .await;
        let api_url = server.url();

        let http = http_client_for_api_url(&api_url);
        let mut telemetry = JobTelemetry::new(
            http,
            RunId::nil(),
            "tok".to_string(),
            Some("prod-1.aws.vm3.ai".to_string()),
        );

        telemetry.record("op1", Duration::from_millis(10), true, None);
        telemetry.rewind_oldest_pending_for_test(FLUSH_THRESHOLD + Duration::from_millis(1));
        telemetry.record("op2", Duration::from_millis(10), true, None);

        assert!(telemetry.pending_ops_snapshot().is_empty());
        assert_eq!(telemetry.in_flight_flushes.len(), 1);

        let request = server.next_request("auto flush request").await;
        assert!(request.starts_with("POST /api/webhooks/agent/telemetry "));
        assert!(
            request
                .to_ascii_lowercase()
                .contains("authorization: bearer tok")
        );
        assert!(request.contains(r#""action_type":"op1""#));
        assert!(request.contains(r#""action_type":"op2""#));
        assert!(!request.contains(r#""runnerName""#));
        assert!(request.contains(r#""runnerHostname":"prod-1.aws.vm3.ai""#));
        assert!(request.contains(&format!(r#""runnerVersion":"{RUNNER_VERSION}""#)));

        let mut flush = Box::pin(telemetry.flush());
        assert!(
            flush.as_mut().now_or_never().is_none(),
            "flush returned before the held auto-flush response completed"
        );

        // API cold starts can exceed the previous five-second request deadline.
        tokio::select! {
            biased;
            () = flush.as_mut() => {
                panic!("flush timed out before the delayed API response was released");
            }
            () = tokio::time::sleep(Duration::from_secs(6)) => {}
        }

        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), flush)
            .await
            .expect("flush should complete after the response is released");
        server.assert_finished().await;
    }

    #[tokio::test]
    async fn detached_reporter_sends_sandbox_operations_payload() {
        let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
            "200 OK",
            r#"{"success":true}"#,
        ))])
        .await;
        let api_url = server.url();

        let telemetry = JobTelemetry::new(
            http_client_for_api_url(&api_url),
            RunId::nil(),
            "tok".to_string(),
            None,
        );
        let reporter = telemetry.reporter();

        reporter
            .report(vec![SandboxOpRecord::new(
                "storage_cache_background_fill_filled",
                Duration::from_millis(42),
                true,
                None,
            )])
            .await;

        let requests = server.assert_finished_with_requests().await;
        let request = &requests[0];
        assert!(request.starts_with("POST /api/webhooks/agent/telemetry "));
        assert!(
            request
                .to_ascii_lowercase()
                .contains("authorization: bearer tok")
        );
        assert!(request.contains(r#""runId":"00000000-0000-0000-0000-000000000000""#));
        assert!(request.contains(r#""action_type":"storage_cache_background_fill_filled""#));
        assert!(request.contains(r#""duration_ms":42"#));
        assert!(request.contains(r#""success":true"#));
    }

    #[tokio::test]
    async fn oom_evidence_upload_logs_http_status_without_sensitive_data() {
        const RESPONSE_BODY_SECRET: &str = "oom-evidence-response-secret";
        const SANDBOX_ID: &str = "oom-evidence-sandbox-secret";
        let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
            "400 Bad Request",
            r#"{"error":"oom-evidence-response-secret"}"#,
        ))])
        .await;
        let evidence = oom_evidence_for_test();
        let telemetry = JobTelemetry::new(
            http_client_for_api_url(&server.url()),
            RunId::nil(),
            "oom-evidence-token-secret".to_string(),
            None,
        );
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());

        telemetry
            .upload_oom_evidence(&evidence, SANDBOX_ID)
            .with_subscriber(subscriber)
            .await;
        server.assert_finished().await;

        let event = captured
            .entries()
            .into_iter()
            .find(|event| {
                event.fields.get("message").is_some_and(|message| {
                    message == "guest oom evidence upload unacknowledged; host evidence retained"
                })
            })
            .expect("oom evidence upload failure should be logged");
        assert_eq!(event.level, Level::WARN);
        assert_eq!(event.fields["reason"], "http_status");
        assert_eq!(event.fields["http_status"], "400");
        let event_debug = format!("{event:#?}");
        assert!(!event_debug.contains(RESPONSE_BODY_SECRET));
        assert!(!event_debug.contains(SANDBOX_ID));
        assert!(!event_debug.contains("oom-evidence-token-secret"));
        assert!(!event_debug.contains(&evidence.operation_id));
    }

    #[tokio::test]
    async fn transport_failure_logs_stable_cause_and_safe_request_context() {
        let server = RawHttpTestServer::spawn(vec![RawHttpAction::Disconnect]).await;
        let api_url = server.url();
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());

        send_telemetry(
            &http_client_for_api_url(&api_url),
            RunId::nil(),
            "telemetry-sensitive-token",
            None,
            vec![sandbox_op(
                "telemetry-sensitive-action",
                Duration::from_millis(1),
                true,
                None,
                None,
                None,
            )],
        )
        .with_subscriber(subscriber)
        .await;
        server.assert_finished().await;

        let event = captured
            .entries()
            .into_iter()
            .find(|event| {
                event
                    .fields
                    .get("message")
                    .is_some_and(|message| message == "telemetry flush failed")
            })
            .expect("telemetry transport failure should be logged");
        assert_eq!(event.level, Level::WARN);
        assert_eq!(event.fields["endpoint"], "telemetry");
        assert!(event.fields["error"].starts_with("api error: "));
        assert_eq!(event.fields["failure_kind"], "request");
        assert_eq!(event.fields["failure_cause"], "http_incomplete_message");
        let event_debug = format!("{event:#?}");
        assert!(!event_debug.contains("telemetry-sensitive-token"));
        assert!(!event_debug.contains("telemetry-sensitive-action"));
        assert!(!event_debug.contains(&api_url));
    }

    #[tokio::test]
    async fn canonical_attribution_is_sent_by_direct_reporter() {
        let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
            "200 OK",
            r#"{"success":true}"#,
        ))])
        .await;
        let api_url = server.url();

        let telemetry = JobTelemetry::new(
            http_client_for_api_url(&api_url),
            RunId::nil(),
            "tok".to_string(),
            Some("prod-1.aws.vm3.ai".to_string()),
        );
        telemetry
            .reporter()
            .report(vec![SandboxOpRecord::new(
                "runner_attribution_test",
                Duration::from_millis(1),
                true,
                None,
            )])
            .await;

        let requests = server.assert_finished_with_requests().await;
        let request = &requests[0];
        assert!(!request.contains(r#""runnerName""#));
        assert!(request.contains(r#""runnerHostname":"prod-1.aws.vm3.ai""#));
        assert!(request.contains(&format!(r#""runnerVersion":"{RUNNER_VERSION}""#)));
    }
}
