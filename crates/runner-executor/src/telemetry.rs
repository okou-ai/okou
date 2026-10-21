use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use api_contracts::generated::routes;
use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::task::JoinHandle;
use tracing::warn;

use crate::duration::duration_ms;
use crate::error::ApiFailureKind;
use crate::resource_budget::ResourceBudget;
use runner_host::home_observation::{
    HomeObservation, HomeObservationLocalDetails, HomeObservationOutcome,
};
use runner_lifecycle::home_image_cache::HomeImageSourceIdentity;
use runner_provider::http::HttpClient;
use runner_storage::ArchiveConnectionAttempt;
use runner_types::ids::RunId;
use runner_types::types::{HomeReuseResult, SandboxReuseResult};

mod dns_readiness;
mod rejection;
mod storage_batch;

pub(crate) use storage_batch::StorageBatchDimensions;

pub(crate) use runner_storage::ArchiveSizeMismatch;
pub(crate) use runner_storage::SandboxOpRecord;

/// How long before we auto-flush pending ops (matching TS: 30s).
const FLUSH_THRESHOLD: Duration = Duration::from_secs(30);
const HOST_BATCH_SIZE: usize = 50;
const HOST_PENDING_LIMIT: usize = 1024;
const HOST_IN_FLIGHT_LIMIT: usize = 4;
const HOST_FLUSH_DEADLINE: Duration = Duration::from_secs(15);

/// Timeout for telemetry HTTP requests, including API cold starts.
const TELEMETRY_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(test)]
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
    fn from_request_error(error: &runner_provider::ProviderError) -> Self {
        match error {
            runner_provider::ProviderError::ApiTransport(error) => {
                Self::from_api_failure_kind(error.failure_kind)
            }
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

/// Actual startup resource after preparation settles.
pub(crate) use runner_types::types::SandboxStartupPath as RunnerStartupPath;

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
    run_id: Option<RunId>,
    sandbox_token: String,
    runner_hostname: Option<String>,
    sandbox_startup_path: Option<RunnerStartupPath>,
    is_first_run: Option<bool>,
    home_startup_source: Option<HomeStartupSource>,
    runner_pre_spawn_attribution: Option<RunnerPreSpawnAttribution>,
    pending: PendingOperations,
    in_flight_flushes: Vec<JoinHandle<()>>,
}

#[derive(Clone)]
struct HomeStartupSource {
    cache_key: String,
    profile_name: String,
    image_generation: String,
}

fn bounded_home_identity(value: &str) -> String {
    let mut end = value.len().min(4096);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
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
    is_first_run: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reuse_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    home_reuse_result: Option<HomeReuseResult>,
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
    dns_readiness: Option<dns_readiness::DnsReadinessTelemetryFields>,
    #[serde(flatten)]
    storage_batch: Option<StorageBatchTelemetryFields>,
    #[serde(skip_serializing_if = "Option::is_none")]
    archive_size_mismatch: Option<ArchiveSizeMismatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    archive_connection_attempt: Option<ArchiveConnectionAttempt>,
    #[serde(flatten)]
    home: Option<HomeObservation>,
}

#[derive(Default)]
struct PendingOperations {
    batch: Option<PendingBatch>,
}

struct PendingBatch {
    operations: Vec<SandboxOp>,
    oldest: Instant,
}

impl PendingOperations {
    fn operations(&self) -> &[SandboxOp] {
        self.batch
            .as_ref()
            .map_or(&[], |batch| batch.operations.as_slice())
    }

    fn len(&self) -> usize {
        self.operations().len()
    }

    fn is_empty(&self) -> bool {
        self.batch.is_none()
    }

    fn age(&self) -> Option<Duration> {
        self.batch.as_ref().map(|batch| batch.oldest.elapsed())
    }

    fn push(&mut self, operation: SandboxOp) {
        if let Some(batch) = &mut self.batch {
            batch.operations.push(operation);
        } else {
            self.batch = Some(PendingBatch {
                operations: vec![operation],
                oldest: Instant::now(),
            });
        }
    }

    fn append(&mut self, other: Self) {
        let Some(mut other) = other.batch else {
            return;
        };
        if let Some(batch) = &mut self.batch {
            batch.oldest = batch.oldest.min(other.oldest);
            batch.operations.append(&mut other.operations);
        } else {
            self.batch = Some(other);
        }
    }

    fn take_up_to(&mut self, count: usize) -> Vec<SandboxOp> {
        match self.batch.as_mut() {
            Some(batch) if batch.operations.len() > count => {
                // A surviving suffix keeps the original pending age.
                batch.operations.drain(..count).collect()
            }
            _ => self.take_all(),
        }
    }

    fn take_all(&mut self) -> Vec<SandboxOp> {
        self.batch
            .take()
            .map_or_else(Vec::new, |batch| batch.operations)
    }

    #[cfg(test)]
    fn rewind_for_test(&mut self, by: Duration) {
        if let Some(batch) = &mut self.batch {
            batch.oldest -= by;
        }
    }
}

/// Shared buffering for host-owned operations that outlive any one Run.
/// Resource callbacks only hold this lock while appending to JobTelemetry.
pub struct SharedJobTelemetry {
    collector: Arc<Mutex<Option<JobTelemetry>>>,
}

impl SharedJobTelemetry {
    pub fn reporter(&self) -> runner_storage::SandboxOpReporter {
        let collector = Arc::clone(&self.collector);
        let reporter = self
            .collector
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(JobTelemetry::reporter);
        runner_storage::SandboxOpReporter::new(move |records| {
            let reporter = reporter.clone();
            async move {
                if let Some(reporter) = reporter {
                    reporter.report(records).await;
                }
            }
        })
        .with_record(move |record| {
            if let Some(telemetry) = collector
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_mut()
            {
                telemetry.push_record(record);
            }
        })
    }

    pub async fn flush(self) {
        let collector = self
            .collector
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(collector) = collector {
            let _ = tokio::time::timeout(HOST_FLUSH_DEADLINE, collector.flush()).await;
        }
    }
}

#[derive(Clone, Serialize)]
struct StorageBatchTelemetryFields {
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_guest_duration_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_outer_residual_ms: Option<u64>,
    storage_batch_timing: &'static str,
    storage_batch_payload_size_bucket: &'static str,
    #[serde(flatten)]
    host: storage_batch::HostTimingFields,
    #[serde(flatten)]
    guest: storage_batch::GuestEvidenceFields,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TelemetryPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runner_hostname: Option<String>,
    runner_version: &'static str,
    sandbox_operations: Vec<SandboxOp>,
}

impl JobTelemetry {
    /// Create a per-job telemetry collector for the runner that owns the job.
    ///
    pub fn new(
        http: HttpClient,
        run_id: RunId,
        sandbox_token: String,
        runner_hostname: Option<String>,
    ) -> Self {
        Self {
            http,
            run_id: Some(run_id),
            sandbox_token,
            runner_hostname,
            sandbox_startup_path: None,
            is_first_run: None,
            home_startup_source: None,
            runner_pre_spawn_attribution: None,
            pending: PendingOperations::default(),
            in_flight_flushes: Vec::new(),
        }
    }

    pub(crate) fn start_runner_pre_spawn_attribution(
        &mut self,
        attribution: RunnerPreSpawnAttribution,
    ) {
        self.runner_pre_spawn_attribution = Some(attribution);
    }

    /// Decorate subsequent observations only after preparation has settled.
    pub(crate) fn set_sandbox_startup_path(&mut self, path: RunnerStartupPath) {
        self.sandbox_startup_path = Some(path);
    }

    pub(crate) fn set_first_run(&mut self, is_first_run: Option<bool>) {
        self.is_first_run = is_first_run;
    }

    pub(crate) fn set_home_startup_source(&mut self, source: Option<HomeImageSourceIdentity<'_>>) {
        self.home_startup_source = source.map(|source| HomeStartupSource {
            cache_key: bounded_home_identity(source.cache_key),
            profile_name: bounded_home_identity(source.profile_name),
            image_generation: bounded_home_identity(source.image_generation),
        });
    }

    pub fn new_runner(
        http: HttpClient,
        token: String,
        hostname: Option<String>,
    ) -> SharedJobTelemetry {
        let telemetry = Self {
            http,
            run_id: None,
            sandbox_token: token,
            runner_hostname: hostname,
            sandbox_startup_path: None,
            is_first_run: None,
            home_startup_source: None,
            runner_pre_spawn_attribution: None,
            pending: PendingOperations::default(),
            in_flight_flushes: Vec::new(),
        };
        SharedJobTelemetry {
            collector: Arc::new(Mutex::new(Some(telemetry))),
        }
    }

    pub fn observe_home(&mut self, mut observation: HomeObservation) {
        observation.is_first_run = self.is_first_run.or(observation.is_first_run);
        observation.log_local(HomeObservationLocalDetails::default());
        let mut record = SandboxOpRecord::new("home", Duration::ZERO, true, None);
        record.home = Some(observation);
        self.push_record(record);
    }

    fn push_record(&mut self, record: SandboxOpRecord) {
        self.push_operation(sandbox_op_from_record(record, self.run_id));
    }

    /// Publish one actual-start fact promptly without changing the batching
    /// cadence of preparation/timing observations. The parent owns its send.
    pub(crate) fn record_sandbox_startup(
        &mut self,
        path: RunnerStartupPath,
        sandbox_reuse_result: SandboxReuseResult,
        home_reuse_result: HomeReuseResult,
        reuse_key: Option<&str>,
    ) {
        let mut phase = self.fork_concurrent_phase();
        let mut op = sandbox_op("runner_sandbox_startup", Duration::ZERO, true, None, None);
        op.runner_startup_path = Some(path);
        op.sandbox_reuse_result = Some(sandbox_reuse_result);
        op.home_reuse_result = Some(home_reuse_result);
        op.reuse_key = reuse_key.map(str::to_owned);
        if path == RunnerStartupPath::Home
            && let Some(source) = &self.home_startup_source
        {
            op.cache_key = Some(source.cache_key.clone());
            op.profile_name = Some(source.profile_name.clone());
            op.image_generation = Some(source.image_generation.clone());
        }
        phase.push_operation(op);
        phase.start_auto_flush();
        self.merge_concurrent_phase(phase);
    }

    /// Create an empty collector for one concurrently owned job phase.
    ///
    /// The fork carries the same job identity and attribution but owns its own
    /// pending operations and flush tasks. Callers must merge it back before
    /// dropping it so no telemetry ownership is lost.
    pub(crate) fn fork_concurrent_phase(&self) -> Self {
        Self {
            http: self.http.clone(),
            run_id: self.run_id,
            sandbox_token: self.sandbox_token.clone(),
            runner_hostname: self.runner_hostname.clone(),
            sandbox_startup_path: self.sandbox_startup_path,
            is_first_run: self.is_first_run,
            home_startup_source: self.home_startup_source.clone(),
            runner_pre_spawn_attribution: self.runner_pre_spawn_attribution.clone(),
            pending: PendingOperations::default(),
            in_flight_flushes: Vec::new(),
        }
    }

    /// Reclaim every pending or in-flight operation from a concurrent phase.
    pub(crate) fn merge_concurrent_phase(&mut self, mut phase: Self) {
        self.pending.append(phase.pending);
        self.in_flight_flushes.append(&mut phase.in_flight_flushes);
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
        self.record_inner(action_type, duration, success, error, None);
    }

    /// Record a timed operation with an optional bounded terminal outcome.
    pub fn record_with_outcome(
        &mut self,
        action_type: &str,
        duration: Duration,
        success: bool,
        error: Option<&str>,
        outcome: Option<&str>,
    ) {
        self.record_inner(action_type, duration, success, error, outcome);
    }

    /// Record a timed operation using the timestamp captured when it completed.
    ///
    /// This preserves event timing when a concurrently polled operation cannot
    /// be added to this mutable buffer until another operation also finishes.
    pub fn record_at(
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
            completed_at,
        ));
    }

    pub(crate) fn record_archive_phase_at(
        &mut self,
        record: SandboxOpRecord,
        completed_at: DateTime<Utc>,
        mismatch: Option<ArchiveSizeMismatch>,
        connection_attempt: Option<ArchiveConnectionAttempt>,
    ) {
        let mut operation = sandbox_op_at(
            record.action_type,
            record.duration,
            record.success,
            record.error,
            None,
            completed_at,
        );
        operation.archive_size_mismatch = mismatch;
        operation.archive_connection_attempt = connection_attempt;
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
        let mut op = sandbox_op(action_type, duration, true, None, None);
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
        let mut op = sandbox_op(action_type, Duration::ZERO, success, error, None);
        op.outcome = Some(outcome.to_string());
        op.reason = reason.map(str::to_string);
        self.push_operation(op);
    }

    /// Record a storage-apply call using only fixed transport/position and
    /// serialized-manifest/payload-size labels. The manifest and its identifiers never
    /// enter this operation. The outer residual includes work outside the
    /// Guest-server timer on both sides of the connection, not pure transport.
    pub(crate) fn record_storage_apply_batch(
        &mut self,
        duration: Duration,
        success: bool,
        guest_duration_ms: Option<u32>,
        host_timing: &sandbox::StorageManifestTiming,
        dimensions: StorageBatchDimensions,
    ) {
        let mut op = sandbox_op(
            "runner_storage_manifest_batch_apply",
            duration,
            success,
            (!success).then_some("storage_batch_apply_failed"),
            Some(dimensions.transport_position),
        );
        op.reason = Some(dimensions.manifest_size_bucket.to_string());
        let residual =
            guest_duration_ms.and_then(|guest| op.duration_ms.checked_sub(u64::from(guest)));
        let timing = match (guest_duration_ms, residual) {
            (None, _) => "unavailable",
            (Some(_), None) => "inconsistent",
            (Some(_), Some(_)) => "paired",
        };
        op.storage_batch = Some(StorageBatchTelemetryFields {
            storage_batch_guest_duration_ms: guest_duration_ms,
            storage_batch_outer_residual_ms: residual,
            storage_batch_timing: timing,
            storage_batch_payload_size_bucket: dimensions.payload_size_bucket,
            host: storage_batch::HostTimingFields::new(host_timing),
            guest: storage_batch::GuestEvidenceFields::new(host_timing),
        });
        self.push_operation(op);
    }

    pub(crate) fn reporter(&self) -> SandboxOpReporter {
        SandboxOpReporter {
            http: self.http.clone(),
            run_id: self.run_id,
            sandbox_token: self.sandbox_token.clone(),
            runner_hostname: self.runner_hostname.clone(),
            sandbox_startup_path: self.sandbox_startup_path,
            is_first_run: self.is_first_run,
        }
    }

    pub(crate) async fn upload_oom_evidence(
        &self,
        evidence: &guest_contracts::oom_evidence::OomEvidence,
        sandbox_id: &str,
    ) {
        let payload = serde_json::json!({
            "runId": self.run_id.map(|run| run.to_string()), "sandboxId": sandbox_id,
            "oomEvidence": evidence,
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
            run_id = self.run_id.as_ref().map(tracing::field::display),
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
    ) {
        self.push_operation(sandbox_op(action_type, duration, success, error, outcome));
    }

    fn push_operation(&mut self, mut operation: SandboxOp) {
        if self.is_first_run.is_some() {
            operation.is_first_run = self.is_first_run;
        }
        // Host collectors live for the Runner lifetime; keep their optional
        // records bounded while outstanding API sends are slow.
        if self.run_id.is_none() && self.pending.len() >= HOST_PENDING_LIMIT {
            // A completed send may have opened capacity since the last callback.
            // Try draining before dropping a new record from a full buffer.
            self.start_auto_flush();
            if self.pending.len() >= HOST_PENDING_LIMIT {
                return;
            }
        }
        if operation.runner_startup_path.is_none() {
            operation.runner_startup_path = self.sandbox_startup_path;
        }
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
        self.pending.push(operation);

        if let Some(age) = self.pending.age()
            && (age >= FLUSH_THRESHOLD
                || (self.run_id.is_none() && self.pending.len() >= HOST_BATCH_SIZE))
        {
            self.start_auto_flush();
        }
    }

    /// Final flush — awaits buffered and already-started HTTP requests.
    /// Consumes self so callers can't accidentally record after flushing.
    pub async fn flush(mut self) {
        if self.pending.is_empty() && self.in_flight_flushes.is_empty() {
            return;
        }
        let ops = self.pending.take_all();
        let in_flight_flushes = std::mem::take(&mut self.in_flight_flushes);
        let run_id = self.run_id;
        let runner_hostname = self.runner_hostname.clone();

        tokio::join!(
            async {
                if run_id.is_none() {
                    let mut ops = ops.into_iter();
                    loop {
                        let batch: Vec<_> = ops.by_ref().take(HOST_BATCH_SIZE).collect();
                        if batch.is_empty() {
                            break;
                        }
                        send_telemetry(
                            &self.http,
                            run_id,
                            &self.sandbox_token,
                            runner_hostname.clone(),
                            batch,
                        )
                        .await;
                    }
                } else {
                    send_telemetry(
                        &self.http,
                        run_id,
                        &self.sandbox_token,
                        runner_hostname,
                        ops,
                    )
                    .await;
                }
            },
            drain_in_flight_flushes(run_id, in_flight_flushes),
        );
    }

    /// Snapshot of buffered ops for tests. Returns `(action_type, success, error)`
    /// tuples in insertion order.
    #[cfg(any(test, feature = "test-support"))]
    pub fn pending_ops_snapshot(&self) -> Vec<(String, bool, Option<String>)> {
        self.pending
            .operations()
            .iter()
            .map(|op| (op.action_type.clone(), op.success, op.error.clone()))
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn pending_storage_batch_payloads(&self) -> Vec<serde_json::Value> {
        self.pending
            .operations()
            .iter()
            .filter(|op| op.storage_batch.is_some())
            .map(|op| serde_json::to_value(op).expect("serialize storage batch operation"))
            .collect()
    }

    /// Snapshot of buffered ops for tests that need to assert duration semantics.
    #[cfg(test)]
    pub(crate) fn pending_ops_with_duration_snapshot(
        &self,
    ) -> Vec<(String, u64, bool, Option<String>)> {
        self.pending
            .operations()
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
    #[cfg(any(test, feature = "test-support"))]
    pub fn pending_ops_with_outcome_snapshot(
        &self,
    ) -> Vec<(String, bool, Option<String>, Option<String>)> {
        self.pending
            .operations()
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

    #[cfg(any(test, feature = "test-support"))]
    pub fn pending_home_snapshot(&self) -> Vec<HomeObservation> {
        self.pending
            .operations()
            .iter()
            .filter_map(|op| {
                op.home.clone().map(|mut home| {
                    home.run_id = self.run_id.or(home.run_id);
                    home.is_first_run = op.is_first_run;
                    home.reuse_key = op.reuse_key.clone();
                    home.cache_key = op.cache_key.clone();
                    home.profile_name = op.profile_name.clone();
                    home.image_generation = op.image_generation.clone();
                    home.reason = op.reason.clone();
                    home
                })
            })
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn pending_ops_with_runner_startup_snapshot(
        &self,
    ) -> Vec<RunnerStartupTelemetrySnapshot> {
        self.pending
            .operations()
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
        self.pending.rewind_for_test(by);
    }

    /// Start an owned flush for auto-threshold flushes.
    fn start_auto_flush(&mut self) {
        if self.run_id.is_none() {
            self.in_flight_flushes
                .retain(|handle| !handle.is_finished());
            if self.in_flight_flushes.len() >= HOST_IN_FLIGHT_LIMIT {
                return;
            }
        }
        let ops = if self.run_id.is_none() {
            self.pending.take_up_to(HOST_BATCH_SIZE)
        } else {
            self.pending.take_all()
        };

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
    run_id: Option<RunId>,
    sandbox_token: String,
    runner_hostname: Option<String>,
    sandbox_startup_path: Option<RunnerStartupPath>,
    is_first_run: Option<bool>,
}

impl SandboxOpReporter {
    pub(crate) async fn report(&self, records: Vec<SandboxOpRecord>) {
        let ops = records
            .into_iter()
            .map(|record| {
                let mut operation = sandbox_op_from_record(record, self.run_id);
                operation.runner_startup_path = self.sandbox_startup_path;
                operation.is_first_run = self.is_first_run.or(operation.is_first_run);
                operation
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

impl runner_storage::StorageTelemetry for JobTelemetry {
    fn record(
        &mut self,
        action_type: &str,
        duration: Duration,
        success: bool,
        error: Option<&str>,
    ) {
        JobTelemetry::record(self, action_type, duration, success, error);
    }

    fn record_bounded_outcome(
        &mut self,
        action_type: &'static str,
        success: bool,
        outcome: &'static str,
        reason: Option<&'static str>,
    ) {
        JobTelemetry::record_bounded_outcome(self, action_type, success, outcome, reason);
    }

    fn record_archive_phase_at(
        &mut self,
        record: SandboxOpRecord,
        completed_at: DateTime<Utc>,
        mismatch: Option<ArchiveSizeMismatch>,
        connection_attempt: Option<ArchiveConnectionAttempt>,
    ) {
        JobTelemetry::record_archive_phase_at(
            self,
            record,
            completed_at,
            mismatch,
            connection_attempt,
        );
    }

    fn reporter(&self) -> runner_storage::SandboxOpReporter {
        let reporter = JobTelemetry::reporter(self);
        runner_storage::SandboxOpReporter::new(move |records| {
            let reporter = reporter.clone();
            async move { reporter.report(records).await }
        })
    }
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
) -> SandboxOp {
    sandbox_op_at(action_type, duration, success, error, outcome, Utc::now())
}

fn sandbox_op_from_record(record: SandboxOpRecord, run_id: Option<RunId>) -> SandboxOp {
    let mut operation = sandbox_op(
        record.action_type,
        record.duration,
        record.success,
        record.error,
        None,
    );
    if let Some(mut home) = record.home {
        operation.action_type = home.kind.to_string();
        operation.success = home.outcome != HomeObservationOutcome::Failed;
        operation.outcome = Some(home.outcome.to_string());
        operation.reason = home.reason.take();
        operation.reuse_key = home.reuse_key.take();
        operation.cache_key = home.cache_key.take();
        operation.profile_name = home.profile_name.take();
        operation.image_generation = home.image_generation.take();
        operation.is_first_run = home.is_first_run;
        if run_id.is_some() {
            home.run_id = None;
        }
        // API contract bounds only metadata introduced by resource records.
        for (field, limit) in [
            (&mut operation.reuse_key, 4096),
            (&mut operation.cache_key, 4096),
            (&mut operation.profile_name, 4096),
            (&mut operation.image_generation, 4096),
            (&mut operation.reason, 64),
            (&mut home.handoff_path, 64),
        ] {
            if let Some(field) = field {
                let mut end = field.len().min(limit);
                while !field.is_char_boundary(end) {
                    end -= 1;
                }
                field.truncate(end);
            }
        }
        operation.home = Some(home);
    }
    operation
}

fn sandbox_op_at(
    action_type: &str,
    duration: Duration,
    success: bool,
    error: Option<&str>,
    outcome: Option<&str>,
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
        is_first_run: None,
        reuse_key: None,
        cache_key: None,
        profile_name: None,
        image_generation: None,
        home_reuse_result: None,
        sandbox_reuse_result: None,
        runner_pre_spawn_concurrency_bucket: None,
        runner_resource_budget_vcpu_utilization_bucket: None,
        runner_resource_budget_memory_utilization_bucket: None,
        runner_resource_budget_lease_count_bucket: None,
        dns_readiness: None,
        storage_batch: None,
        archive_size_mismatch: None,
        archive_connection_attempt: None,
        home: None,
    }
}

async fn drain_in_flight_flushes(run_id: Option<RunId>, in_flight_flushes: Vec<JoinHandle<()>>) {
    for handle in in_flight_flushes {
        if let Err(e) = handle.await {
            warn!(run_id = run_id.as_ref().map(tracing::field::display), error = %e, "telemetry auto-flush task failed");
        }
    }
}

async fn send_telemetry(
    http: &HttpClient,
    run_id: Option<RunId>,
    sandbox_token: &str,
    runner_hostname: Option<String>,
    ops: Vec<SandboxOp>,
) {
    if ops.is_empty() {
        return;
    }

    let payload = TelemetryPayload {
        run_id: run_id.map(|run| run.to_string()),
        runner_hostname,
        runner_version: http.runner_version(),
        sandbox_operations: ops,
    };

    let req = http
        .request_route(routes::webhooks::agent::telemetry::SEND, sandbox_token)
        .timeout(TELEMETRY_TIMEOUT)
        .json(&payload);

    match req.send("telemetry").await {
        Ok(resp) if !resp.status().is_success() => {
            let status = resp.status();
            let diagnostic = if status == reqwest::StatusCode::BAD_REQUEST {
                rejection::read(resp, &payload).await
            } else {
                None
            };
            warn!(
                run_id = run_id.as_ref().map(tracing::field::display),
                status = %status,
                runner_version = payload.runner_version,
                operation_count = payload.sandbox_operations.len(),
                rejection_field = diagnostic.as_ref().map(|value| value.schema_field.as_str()),
                rejection_operation_index = diagnostic.as_ref().and_then(|value| value.operation_index),
                rejection_operation = diagnostic.as_ref().and_then(|value| value.operation),
                "telemetry flush rejected"
            );
        }
        Err(error) => match &error {
            runner_provider::ProviderError::ApiTransport(api_error) => warn!(
                run_id = run_id.as_ref().map(tracing::field::display),
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
            _ => {
                warn!(run_id = run_id.as_ref().map(tracing::field::display), error = %error, "telemetry flush failed")
            }
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

    use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, json_response};
    use runner_provider::http::HttpClientConfig;

    fn http_client() -> HttpClient {
        http_client_for_api_url("http://localhost")
    }

    pub(super) fn http_client_for_api_url(api_url: &str) -> HttpClient {
        HttpClient::new(HttpClientConfig {
            api_url: api_url.to_string(),
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
            runner_version: env!("CARGO_PKG_VERSION"),
        })
        .unwrap()
    }

    #[tokio::test]
    async fn home_operations_use_the_existing_run_payload_and_first_run_context() {
        use runner_host::home_observation::{
            HomeObservationKind as Kind, HomeObservationOutcome as Outcome,
        };
        let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
            "200 OK",
            r#"{"success":true}"#,
        ))])
        .await;
        let run_id = RunId::new_v4();
        let mut telemetry = JobTelemetry::new(
            http_client_for_api_url(&server.url()),
            run_id,
            "sandbox-operation-token".into(),
            Some("runner.example.test".into()),
        );
        telemetry.set_first_run(Some(false));
        let mut home = HomeObservation::new(Kind::Publication, Outcome::Published);
        home.run_id = Some(run_id);
        home.reuse_key = Some("thread:known".into());
        home.image_generation = Some(run_id.to_string());
        home.allocated_bytes = Some(0);
        home.reason = Some("synced_commit".into());
        telemetry.observe_home(home);
        telemetry.flush().await;
        let requests = server.assert_finished_with_requests().await;
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("POST /api/webhooks/agent/telemetry "));
        let body: serde_json::Value =
            serde_json::from_str(requests[0].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["runId"], run_id.to_string());
        let op = &body["sandboxOperations"][0];
        assert_eq!(op["action_type"], "runner_home_image_publication");
        assert_eq!(op["outcome"], "published");
        assert_eq!(op["reason"], "synced_commit");
        assert_eq!(op["reuse_key"], "thread:known");
        assert_eq!(op["image_generation"], run_id.to_string());
        assert_eq!(op["is_first_run"], false);
        assert_eq!(op["allocated_bytes"], 0);
        assert!(op.get("run_id").is_none());
    }

    #[tokio::test]
    async fn home_gc_operations_use_runner_credentials_and_omit_unknown_run_context() {
        use runner_host::home_observation::{
            HomeObservationKind as Kind, HomeObservationOutcome as Outcome,
        };
        let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
            "200 OK",
            r#"{"success":true}"#,
        ))])
        .await;
        let telemetry = JobTelemetry::new_runner(
            http_client_for_api_url(&server.url()),
            "host-operation-token".into(),
            None,
        );
        let reporter = telemetry.reporter();
        let mut record = SandboxOpRecord::new("home", Duration::ZERO, true, None);
        record.home = Some(HomeObservation::new(Kind::Removal, Outcome::Deleted));
        reporter.record(record);
        telemetry.flush().await;
        let requests = server.assert_finished_with_requests().await;
        assert_eq!(requests.len(), 1);
        assert!(
            requests[0]
                .to_lowercase()
                .contains("authorization: bearer host-operation-token")
        );
        let body: serde_json::Value =
            serde_json::from_str(requests[0].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert!(body.get("runId").is_none());
        let op = &body["sandboxOperations"][0];
        assert_eq!(op["action_type"], "runner_home_image_removal");
        assert_eq!(op["outcome"], "deleted");
        assert!(op.get("run_id").is_none());
        assert!(op.get("is_first_run").is_none());
    }

    #[tokio::test]
    async fn home_inventory_and_admission_fields_survive_the_existing_host_http_path() {
        use runner_host::home_observation::{
            HomeObservationKind as Kind, HomeObservationOutcome as Outcome,
        };
        let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
            "200 OK",
            r#"{"success":true}"#,
        ))])
        .await;
        let telemetry = JobTelemetry::new_runner(
            http_client_for_api_url(&server.url()),
            "host-operation-token".into(),
            None,
        );
        let reporter = telemetry.reporter();
        let runner_id = uuid::Uuid::new_v4().to_string();
        let run_id = RunId::new_v4();
        let mut loading = HomeObservation::new(Kind::Inventory, Outcome::Loading);
        loading.runner_id = Some(runner_id.clone());
        loading.runner_heartbeat_generation = Some(7);
        loading.inventory_loaded = Some(false);
        let mut record = SandboxOpRecord::new("runner_home_inventory", Duration::ZERO, true, None);
        record.home = Some(loading);
        reporter.record(record);
        let mut inventory = HomeObservation::new(Kind::Inventory, Outcome::Assembled);
        inventory.runner_id = Some(runner_id.clone());
        inventory.runner_heartbeat_generation = Some(7);
        inventory.inventory_loaded = Some(true);
        inventory.inventory_observed_states = Some(0);
        inventory.inventory_output_states = Some(0);
        inventory.inventory_omitted_states = Some(0);
        let mut record = SandboxOpRecord::new("runner_home_inventory", Duration::ZERO, true, None);
        record.home = Some(inventory);
        reporter.record(record);
        let mut admission = HomeObservation::new(Kind::Admission, Outcome::Deferred);
        admission.runner_id = Some(runner_id.clone());
        admission.runner_heartbeat_generation = Some(7);
        admission.run_id = Some(run_id);
        admission.reuse_key = Some("thread:known".into());
        admission.profile_name = Some("vm0/default".into());
        admission.reason = Some("capacity_exhausted".into());
        let mut record = SandboxOpRecord::new("runner_home_admission", Duration::ZERO, true, None);
        record.home = Some(admission);
        reporter.record(record);
        telemetry.flush().await;
        let requests = server.assert_finished_with_requests().await;
        assert_eq!(requests.len(), 1);
        let body: serde_json::Value =
            serde_json::from_str(requests[0].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert!(body.get("runId").is_none());
        let ops = body["sandboxOperations"].as_array().unwrap();
        assert_eq!(ops.len(), 3);
        assert_eq!(ops[0]["action_type"], "runner_home_inventory");
        assert_eq!(ops[0]["outcome"], "loading");
        assert_eq!(ops[0]["inventory_loaded"], false);
        assert_eq!(ops[1]["action_type"], "runner_home_inventory");
        assert_eq!(ops[1]["outcome"], "assembled");
        assert_eq!(ops[1]["inventory_loaded"], true);
        for field in [
            "inventory_observed_states",
            "inventory_output_states",
            "inventory_omitted_states",
        ] {
            assert!(ops[0].get(field).is_none());
            assert_eq!(ops[1][field], 0);
        }
        assert_eq!(ops[2]["action_type"], "runner_home_admission");
        assert_eq!(ops[2]["outcome"], "deferred");
        assert_eq!(ops[2]["reason"], "capacity_exhausted");
        assert_eq!(ops[2]["run_id"], run_id.to_string());
        assert_eq!(ops[2]["reuse_key"], "thread:known");
        for op in ops {
            assert_eq!(op["runner_id"], runner_id);
            assert_eq!(op["runner_heartbeat_generation"], 7);
            assert!(op.get("is_first_run").is_none());
        }
        assert!(ops[0].get("run_id").is_none());
        assert!(ops[1].get("run_id").is_none());
        assert!(ops[2].get("inventory_loaded").is_none());
    }

    #[tokio::test]
    async fn home_operations_buffer_while_the_existing_api_transport_is_held() {
        use runner_host::home_observation::{
            HomeObservationKind as Kind, HomeObservationOutcome as Outcome,
        };
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let mut server = RawHttpTestServer::spawn(vec![
            RawHttpAction::WaitThenRespond {
                release: release_rx,
                response: json_response("200 OK", r#"{"success":true}"#),
            },
            RawHttpAction::Respond(json_response("200 OK", r#"{"success":true}"#)),
        ])
        .await;
        let telemetry = JobTelemetry::new_runner(
            http_client_for_api_url(&server.url()),
            "host-operation-token".into(),
            None,
        );
        let reporter = telemetry.reporter();
        for _ in 0..50 {
            let mut record = SandboxOpRecord::new("home", Duration::ZERO, true, None);
            record.home = Some(HomeObservation::new(Kind::Publication, Outcome::Published));
            reporter.record(record);
        }
        let first = server.next_request("host operation batch").await;
        let mut record = SandboxOpRecord::new("home", Duration::ZERO, true, None);
        record.home = Some(HomeObservation::new(Kind::Preservation, Outcome::Retained));
        reporter.record(record);
        release_tx.send(()).unwrap();
        telemetry.flush().await;
        let second = server
            .next_request("operation buffered behind the held request")
            .await;
        let first: serde_json::Value =
            serde_json::from_str(first.split_once("\r\n\r\n").unwrap().1).unwrap();
        let second: serde_json::Value =
            serde_json::from_str(second.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(first["sandboxOperations"].as_array().unwrap().len(), 50);
        assert_eq!(second["sandboxOperations"].as_array().unwrap().len(), 1);
        assert_eq!(second["sandboxOperations"][0]["outcome"], "retained");
        server.assert_finished().await;
    }

    #[tokio::test]
    async fn host_operations_resume_after_a_full_buffer_and_completed_api_sends() {
        use runner_host::home_observation::{
            HomeObservationKind as Kind, HomeObservationOutcome as Outcome,
        };
        let expected = HOST_IN_FLIGHT_LIMIT * HOST_BATCH_SIZE + HOST_PENDING_LIMIT + 1;
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let mut actions = vec![RawHttpAction::WaitThenRespond {
            release: release_rx,
            response: json_response("200 OK", r#"{"success":true}"#),
        }];
        actions.extend(
            (1..expected.div_ceil(HOST_BATCH_SIZE))
                .map(|_| RawHttpAction::Respond(json_response("200 OK", r#"{"success":true}"#))),
        );
        let mut server = RawHttpTestServer::spawn(actions).await;
        let telemetry = JobTelemetry::new_runner(
            http_client_for_api_url(&server.url()),
            "host-operation-token".into(),
            None,
        );
        let reporter = telemetry.reporter();
        let record = || {
            let mut record = SandboxOpRecord::new("home", Duration::ZERO, true, None);
            record.home = Some(HomeObservation::new(Kind::Removal, Outcome::Deleted));
            record
        };
        for _ in 0..HOST_IN_FLIGHT_LIMIT * HOST_BATCH_SIZE {
            reporter.record(record());
        }
        let first = server.next_request("held host operations").await;
        for _ in 0..HOST_PENDING_LIMIT + 2 {
            reporter.record(record());
        }
        // Await the actual outstanding sends without closing the collector, so
        // the next callback exercises recovery from a full bounded buffer.
        let in_flight = {
            let mut collector = telemetry.collector.lock().unwrap();
            std::mem::take(&mut collector.as_mut().unwrap().in_flight_flushes)
        };
        release_tx.send(()).unwrap();
        drain_in_flight_flushes(None, in_flight).await;
        let mut resumed = record();
        resumed.home.as_mut().unwrap().reason = Some("resumed_after_backpressure".into());
        reporter.record(resumed);
        telemetry.flush().await;
        let mut requests = vec![first];
        requests.extend(server.assert_finished_with_requests().await);
        let operations: Vec<serde_json::Value> = requests
            .iter()
            .flat_map(|request| {
                let body: serde_json::Value =
                    serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
                let ops = body["sandboxOperations"].as_array().unwrap();
                assert!(ops.len() <= HOST_BATCH_SIZE);
                ops.clone()
            })
            .collect();
        assert_eq!(operations.len(), expected);
        assert_eq!(
            operations
                .iter()
                .filter(|op| op["reason"] == "resumed_after_backpressure")
                .count(),
            1
        );
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
    fn sandbox_op_serializes_base_observations() {
        let op = SandboxOp {
            ts: "2026-01-15T10:00:00+00:00".to_string(),
            action_type: "sandbox_create".to_string(),
            duration_ms: 1500,
            success: true,
            error: None,
            outcome: None,
            reason: None,
            runner_startup_path: None,
            is_first_run: None,
            reuse_key: None,
            cache_key: None,
            profile_name: None,
            image_generation: None,
            home_reuse_result: None,
            sandbox_reuse_result: None,
            runner_pre_spawn_concurrency_bucket: None,
            runner_resource_budget_vcpu_utilization_bucket: None,
            runner_resource_budget_memory_utilization_bucket: None,
            runner_resource_budget_lease_count_bucket: None,
            dns_readiness: None,
            storage_batch: None,
            archive_size_mismatch: None,
            archive_connection_attempt: None,
            home: None,
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
        let mut telemetry = JobTelemetry::new(
            http_client(),
            RunId::from(uuid::Uuid::nil()),
            "tok".to_string(),
            None,
        );
        telemetry.record_bounded_outcome(
            "storage_cache_fresh_delivery_scan_groups",
            true,
            "17_plus",
            Some("prepared"),
        );

        assert_eq!(
            serde_json::to_value(&telemetry.pending.operations()[0]).unwrap(),
            serde_json::json!({
                "ts": telemetry.pending.operations()[0].ts.clone(),
                "action_type": "storage_cache_fresh_delivery_scan_groups",
                "duration_ms": 0,
                "success": true,
                "outcome": "17_plus",
                "reason": "prepared",
            })
        );
    }

    #[test]
    fn storage_batch_telemetry_subtracts_guest_server_duration() {
        let mut telemetry = JobTelemetry::new(
            http_client(),
            RunId::from(uuid::Uuid::nil()),
            "tok".to_string(),
            None,
        );
        telemetry.record_storage_apply_batch(
            Duration::from_millis(42),
            true,
            Some(31),
            &sandbox::StorageManifestTiming::default(),
            StorageBatchDimensions {
                transport_position: "dedicated_middle",
                manifest_size_bucket: "32_to_64_kib",
                payload_size_bucket: "none",
            },
        );

        let batches = telemetry.pending_storage_batch_payloads();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0]["duration_ms"], 42);
        assert_eq!(batches[0]["storage_batch_guest_duration_ms"], 31);
        assert_eq!(batches[0]["storage_batch_outer_residual_ms"], 11);
        assert_eq!(batches[0]["storage_batch_timing"], "paired");
    }

    #[test]
    fn storage_host_telemetry_preserves_coverage_units_and_missing_phases() {
        use sandbox::{StorageManifestRequestTiming, StorageManifestTiming};
        let mut telemetry = JobTelemetry::new(
            http_client(),
            RunId::from(uuid::Uuid::nil()),
            "tok".to_string(),
            None,
        );
        let dimensions = || StorageBatchDimensions {
            transport_position: "dedicated_middle",
            manifest_size_bucket: "32_to_64_kib",
            payload_size_bucket: "64_to_256_kib",
        };
        let full = StorageManifestTiming {
            admission: Some(Duration::from_millis(1)),
            request: StorageManifestRequestTiming {
                setup: Some(Duration::from_millis(2)),
                frame_builder_wait: Some(Duration::from_millis(3)),
                frame_encode: Some(Duration::from_millis(4)),
                writer_wait: Some(Duration::from_millis(5)),
                frame_write: Some(Duration::from_millis(6)),
                response_wait: Some(Duration::from_millis(7)),
                result_decode: Some(Duration::from_millis(8)),
                guest: sandbox::StorageManifestGuestTiming {
                    request_ownership_us: Some(0),
                    worker_wait_us: Some(9_007_199_254_740_991),
                    response_prepare_us: Some(42),
                },
                resources: sandbox::StorageManifestResources {
                    containment_wall_us: Some(1),
                    collection_us: Some(0),
                    cpu_usage_us: Some(2),
                    cpu_throttled_us: Some(0),
                    memory_peak_bytes: Some(9_007_199_254_740_991),
                    memory_events_oom: Some(0),
                    memory_events_oom_kill: Some(0),
                    memory_events_oom_group_kill: Some(0),
                    pids_events_max: Some(0),
                },
            },
            resource_log: Some(Duration::from_millis(9)),
        };
        telemetry.record_storage_apply_batch(
            Duration::from_millis(100),
            true,
            Some(0),
            &full,
            dimensions(),
        );
        let partial = StorageManifestTiming {
            admission: Some(Duration::ZERO),
            request: StorageManifestRequestTiming {
                setup: Some(Duration::from_nanos(1)),
                guest: sandbox::StorageManifestGuestTiming {
                    request_ownership_us: Some(9_007_199_254_740_992),
                    worker_wait_us: Some(0),
                    ..sandbox::StorageManifestGuestTiming::default()
                },
                resources: sandbox::StorageManifestResources {
                    cpu_usage_us: Some(0),
                    memory_peak_bytes: Some(u64::MAX),
                    ..sandbox::StorageManifestResources::default()
                },
                result_decode: Some(Duration::from_millis(u64::from(u32::MAX) + 1)),
                ..StorageManifestRequestTiming::default()
            },
            ..StorageManifestTiming::default()
        };
        telemetry.record_storage_apply_batch(
            Duration::from_millis(100),
            false,
            None,
            &partial,
            dimensions(),
        );
        telemetry.record_storage_apply_batch(
            Duration::ZERO,
            true,
            None,
            &StorageManifestTiming::default(),
            dimensions(),
        );
        let batches = telemetry.pending_storage_batch_payloads();
        assert_eq!(batches[0]["storage_batch_host_timing"], "complete");
        assert_eq!(batches[0]["storage_batch_guest_timing"], "complete");
        assert_eq!(batches[0]["storage_batch_resources"], "complete");
        assert_eq!(batches[0]["storage_batch_guest_request_ownership_us"], 0);
        assert_eq!(
            batches[0]["storage_batch_guest_worker_wait_us"],
            9_007_199_254_740_991_u64
        );
        assert_eq!(batches[0]["storage_batch_guest_response_prepare_us"], 42);
        assert_eq!(batches[0]["storage_batch_resource_collection_us"], 0);
        assert_eq!(
            batches[0]["storage_batch_memory_peak_bytes"],
            9_007_199_254_740_991_u64
        );
        for (field, value) in [
            ("storage_batch_admission_ms", 1),
            ("storage_batch_request_setup_ms", 2),
            ("storage_batch_frame_builder_wait_ms", 3),
            ("storage_batch_frame_encode_ms", 4),
            ("storage_batch_writer_wait_ms", 5),
            ("storage_batch_frame_write_ms", 6),
            ("storage_batch_response_wait_ms", 7),
            ("storage_batch_result_decode_ms", 8),
            ("storage_batch_resource_log_ms", 9),
        ] {
            assert_eq!(batches[0][field], value);
        }
        assert_eq!(
            batches[0]["storage_batch_payload_size_bucket"],
            "64_to_256_kib"
        );
        assert_eq!(batches[1]["storage_batch_host_timing"], "partial");
        assert_eq!(batches[1]["storage_batch_guest_timing"], "partial");
        assert_eq!(batches[1]["storage_batch_resources"], "partial");
        assert_eq!(batches[1]["storage_batch_guest_worker_wait_us"], 0);
        assert_eq!(batches[1]["storage_batch_cpu_usage_us"], 0);
        assert!(
            batches[1]
                .get("storage_batch_guest_request_ownership_us")
                .is_none()
        );
        assert!(batches[1].get("storage_batch_memory_peak_bytes").is_none());
        assert_eq!(batches[1]["success"], false);
        assert_eq!(batches[1]["storage_batch_admission_ms"], 0);
        assert_eq!(batches[1]["storage_batch_request_setup_ms"], 0);
        assert!(batches[1].get("storage_batch_frame_write_ms").is_none());
        assert!(batches[1].get("storage_batch_result_decode_ms").is_none());
        assert!(batches[1].get("storage_batch_resource_log_ms").is_none());
        assert_eq!(batches[2]["storage_batch_host_timing"], "unavailable");
        assert_eq!(batches[2]["storage_batch_guest_timing"], "unavailable");
        assert_eq!(batches[2]["storage_batch_resources"], "unavailable");
        assert!(batches[2].get("storage_batch_admission_ms").is_none());
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
            RunId::from(uuid::Uuid::nil()),
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

    #[tokio::test]
    async fn telemetry_uses_the_callers_runner_version() {
        use httpmock::prelude::*;

        let server = MockServer::start_async().await;
        let telemetry_mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/api/webhooks/agent/telemetry")
                    .body_includes(r#""runnerVersion":"9.8.7""#);
                then.status(200);
            })
            .await;
        let http = HttpClient::new(HttpClientConfig {
            api_url: server.base_url(),
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
            runner_version: "9.8.7",
        })
        .unwrap();
        let mut telemetry = JobTelemetry::new(
            http,
            RunId::from(uuid::Uuid::nil()),
            "tok".to_string(),
            None,
        );
        telemetry.record("version_probe", Duration::ZERO, true, None);
        telemetry.flush().await;

        telemetry_mock.assert_calls_async(1).await;
    }

    #[test]
    fn api_startup_boundaries_serialize_bounded_startup_metadata() {
        let mut telemetry = JobTelemetry::new(
            http_client(),
            RunId::from(uuid::Uuid::nil()),
            "tok".to_string(),
            None,
        );
        let budget = Arc::new(ResourceBudget::new(4, 400, 1.0, 0));
        let _lease = ResourceBudget::try_reserve_lease(&budget, 2, 300).unwrap();
        let mut attribution =
            RunnerPreSpawnAttribution::new(RunnerPreSpawnConcurrencyBucket::ThreeToFour);
        attribution.set_resource_budget_occupancy(RunnerResourceBudgetOccupancy::capture(&budget));
        telemetry.start_runner_pre_spawn_attribution(attribution);
        telemetry.record_api_to_spawn(
            Duration::from_millis(125),
            RunnerStartupPath::Home,
            SandboxReuseResult::PoolMiss,
        );
        telemetry.record_api_to_agent_ready(
            Duration::from_millis(150),
            RunnerStartupPath::Home,
            SandboxReuseResult::PoolMiss,
        );

        assert_eq!(
            serde_json::to_value(&telemetry.pending.operations()[0]).unwrap(),
            serde_json::json!({
                "ts": telemetry.pending.operations()[0].ts.clone(),
                "action_type": "api_to_spawn",
                "duration_ms": 125,
                "success": true,
                "runner_startup_path": "home",
                "sandbox_reuse_result": "poolMiss",
                "runner_pre_spawn_concurrency_bucket": "3_4",
                "runner_resource_budget_vcpu_utilization_bucket": "51_75",
                "runner_resource_budget_memory_utilization_bucket": "51_75",
                "runner_resource_budget_lease_count_bucket": "1",
            })
        );
        assert_eq!(
            serde_json::to_value(&telemetry.pending.operations()[1]).unwrap(),
            serde_json::json!({
                "ts": telemetry.pending.operations()[1].ts.clone(),
                "action_type": "api_to_agent_ready",
                "duration_ms": 150,
                "success": true,
                "runner_startup_path": "home",
                "sandbox_reuse_result": "poolMiss",
                "runner_pre_spawn_concurrency_bucket": "3_4",
                "runner_resource_budget_vcpu_utilization_bucket": "51_75",
                "runner_resource_budget_memory_utilization_bucket": "51_75",
                "runner_resource_budget_lease_count_bucket": "1",
            })
        );
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
    fn telemetry_payload_includes_canonical_attribution() {
        let payload = TelemetryPayload {
            run_id: Some("abc-123".to_string()),
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
        let telemetry = JobTelemetry::new(
            http,
            RunId::from(uuid::Uuid::nil()),
            "tok".to_string(),
            None,
        );
        assert!(telemetry.pending.is_empty());
        assert!(telemetry.pending.age().is_none());
        assert!(telemetry.in_flight_flushes.is_empty());
    }

    #[test]
    fn record_buffers_ops() {
        let http = http_client();
        let mut telemetry = JobTelemetry::new(
            http,
            RunId::from(uuid::Uuid::nil()),
            "tok".to_string(),
            None,
        );

        telemetry.record("sandbox_create", Duration::from_millis(500), true, None);
        telemetry.record(
            "agent_execute",
            Duration::from_secs(10),
            false,
            Some("timeout"),
        );

        assert_eq!(telemetry.pending.len(), 2);
        assert_eq!(
            telemetry.pending.operations()[0].action_type,
            "sandbox_create"
        );
        assert_eq!(telemetry.pending.operations()[0].duration_ms, 500);
        assert!(telemetry.pending.operations()[0].success);
        assert!(telemetry.pending.operations()[0].error.is_none());
        assert_eq!(
            telemetry.pending.operations()[1].action_type,
            "agent_execute"
        );
        assert!(!telemetry.pending.operations()[1].success);
        assert_eq!(
            telemetry.pending.operations()[1].error.as_deref(),
            Some("timeout")
        );
        assert!(telemetry.pending.age().is_some());
    }

    #[test]
    fn record_saturates_large_duration() {
        let http = http_client();
        let mut telemetry = JobTelemetry::new(
            http,
            RunId::from(uuid::Uuid::nil()),
            "tok".to_string(),
            None,
        );

        telemetry.record("huge_op", Duration::MAX, true, None);

        assert_eq!(telemetry.pending.len(), 1);
        assert_eq!(telemetry.pending.operations()[0].duration_ms, u64::MAX);
    }

    #[tokio::test]
    async fn record_within_threshold_does_not_flush() {
        let http = http_client();
        let mut telemetry = JobTelemetry::new(
            http,
            RunId::from(uuid::Uuid::nil()),
            "tok".to_string(),
            None,
        );

        telemetry.record("op1", Duration::from_millis(10), true, None);
        telemetry.record("op2", Duration::from_millis(10), true, None);

        assert_eq!(telemetry.pending_ops_snapshot().len(), 2);
        assert!(telemetry.pending.age().is_some());
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
            RunId::from(uuid::Uuid::nil()),
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
            RunId::from(uuid::Uuid::nil()),
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
            None,
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
        let mut server = RawHttpTestServer::spawn(vec![
            RawHttpAction::Respond(json_response("200 OK", r#"{"success":true}"#)),
            RawHttpAction::Respond(json_response("200 OK", r#"{"success":true}"#)),
        ])
        .await;
        let mut telemetry = JobTelemetry::new(
            http_client_for_api_url(&server.url()),
            RunId::from(uuid::Uuid::nil()),
            "tok".to_string(),
            None,
        );

        telemetry.record("op1", Duration::from_millis(10), true, None);
        telemetry.rewind_oldest_pending_for_test(FLUSH_THRESHOLD + Duration::from_millis(1));
        telemetry.record("op2", Duration::from_millis(10), true, None);

        let first = server.next_request("threshold-triggered batch").await;
        let first: serde_json::Value =
            serde_json::from_str(first.split_once("\r\n\r\n").unwrap().1).unwrap();
        let operations = first["sandboxOperations"].as_array().unwrap();
        assert_eq!(operations.len(), 2);
        assert_eq!(operations[0]["action_type"], "op1");
        assert_eq!(operations[1]["action_type"], "op2");

        // A full drain seeds a fresh age, so both new records share the final
        // batch instead of inheriting the previous threshold-triggered age.
        telemetry.record("op3", Duration::from_millis(10), true, None);
        telemetry.record("op4", Duration::from_millis(10), true, None);
        telemetry.flush().await;
        let second = server
            .next_request("fresh pending batch at final flush")
            .await;
        let second: serde_json::Value =
            serde_json::from_str(second.split_once("\r\n\r\n").unwrap().1).unwrap();
        let operations = second["sandboxOperations"].as_array().unwrap();
        assert_eq!(operations.len(), 2);
        assert_eq!(operations[0]["action_type"], "op3");
        assert_eq!(operations[1]["action_type"], "op4");
        server.assert_finished().await;
    }

    #[tokio::test]
    async fn partial_host_drain_preserves_the_pending_age_for_the_short_suffix() {
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let mut actions = vec![RawHttpAction::WaitThenRespond {
            release: release_rx,
            response: json_response("200 OK", r#"{"success":true}"#),
        }];
        actions.extend(
            (1..HOST_IN_FLIGHT_LIMIT + 2)
                .map(|_| RawHttpAction::Respond(json_response("200 OK", r#"{"success":true}"#))),
        );
        let mut server = RawHttpTestServer::spawn(actions).await;
        let telemetry = JobTelemetry::new_runner(
            http_client_for_api_url(&server.url()),
            "host-operation-token".into(),
            None,
        );
        let reporter = telemetry.reporter();
        let record = |index| {
            SandboxOpRecord::new(
                "host_operation",
                Duration::from_millis(index as u64),
                true,
                None,
            )
        };
        let sent = HOST_IN_FLIGHT_LIMIT * HOST_BATCH_SIZE;
        let buffered = HOST_BATCH_SIZE + 10;
        for index in 0..sent {
            reporter.record(record(index));
        }
        server.next_request("held host batch").await;
        for index in sent..sent + buffered {
            reporter.record(record(index));
        }
        let in_flight = {
            let mut collector = telemetry.collector.lock().unwrap();
            let collector = collector.as_mut().unwrap();
            collector.rewind_oldest_pending_for_test(FLUSH_THRESHOLD + Duration::from_millis(1));
            std::mem::take(&mut collector.in_flight_flushes)
        };
        release_tx.send(()).unwrap();
        drain_in_flight_flushes(None, in_flight).await;
        for _ in 1..HOST_IN_FLIGHT_LIMIT {
            server.next_request("completed host batch").await;
        }

        reporter.record(record(sent + buffered));
        let prefix = server
            .next_request("bounded prefix after send capacity returns")
            .await;
        let prefix: serde_json::Value =
            serde_json::from_str(prefix.split_once("\r\n\r\n").unwrap().1).unwrap();
        let operations = prefix["sandboxOperations"].as_array().unwrap();
        assert_eq!(operations.len(), HOST_BATCH_SIZE);
        assert_eq!(
            operations
                .iter()
                .map(|op| op["duration_ms"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            (sent as u64..(sent + HOST_BATCH_SIZE) as u64).collect::<Vec<_>>()
        );

        // This suffix is smaller than HOST_BATCH_SIZE. Its original age must
        // still trigger an HTTP request before consuming the final collector.
        reporter.record(record(sent + buffered + 1));
        let suffix = server
            .next_request("aged short suffix before final flush")
            .await;
        let suffix: serde_json::Value =
            serde_json::from_str(suffix.split_once("\r\n\r\n").unwrap().1).unwrap();
        let operations = suffix["sandboxOperations"].as_array().unwrap();
        assert_eq!(operations.len(), buffered + 2 - HOST_BATCH_SIZE);
        assert_eq!(
            operations
                .iter()
                .map(|op| op["duration_ms"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            ((sent + HOST_BATCH_SIZE) as u64..(sent + buffered + 2) as u64).collect::<Vec<_>>()
        );
        telemetry.flush().await;
        server.assert_finished().await;
    }

    #[tokio::test]
    async fn merged_pending_phases_keep_the_earliest_age_and_insertion_order() {
        for older_phase in [false, true] {
            let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
                "200 OK",
                r#"{"success":true}"#,
            ))])
            .await;
            let mut telemetry = JobTelemetry::new(
                http_client_for_api_url(&server.url()),
                RunId::new_v4(),
                "tok".into(),
                None,
            );
            let mut phase = telemetry.fork_concurrent_phase();
            telemetry.record("parent", Duration::ZERO, true, None);
            phase.record("phase", Duration::ZERO, true, None);
            let older = if older_phase {
                &mut phase
            } else {
                &mut telemetry
            };
            older.rewind_oldest_pending_for_test(FLUSH_THRESHOLD + Duration::from_millis(1));
            telemetry.merge_concurrent_phase(phase);
            telemetry.record("trigger", Duration::ZERO, true, None);

            let request = server
                .next_request("merged aged batch before final flush")
                .await;
            let payload: serde_json::Value =
                serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
            let operations = payload["sandboxOperations"].as_array().unwrap();
            assert_eq!(operations.len(), 3);
            assert_eq!(operations[0]["action_type"], "parent");
            assert_eq!(operations[1]["action_type"], "phase");
            assert_eq!(operations[2]["action_type"], "trigger");
            telemetry.flush().await;
            server.assert_finished().await;
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
            RunId::from(uuid::Uuid::nil()),
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

        // Advance past the previous five-second request deadline without a
        // wall-clock wait. The held response must still own the pending flush.
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(6)).await;
        assert!(
            flush.as_mut().now_or_never().is_none(),
            "flush timed out before the delayed API response was released"
        );
        tokio::time::resume();

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
            RunId::from(uuid::Uuid::nil()),
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
    async fn oom_evidence_upload_payload_is_unchanged_by_the_removed_progress_field() {
        // The v1 payload never carried `runtime_progress_at`: the field was
        // `skip_serializing_if = "Option::is_none"` and the upload forced it to
        // `None` first. An old producer's value must still not reach the API.
        let legacy: guest_contracts::oom_evidence::OomEvidence =
            serde_json::from_str(include_str!(
                "../../guest-contracts/tests/fixtures/oom-evidence-v1-legacy-runtime-progress.json"
            ))
            .unwrap();
        let expected = serde_json::to_value(
            serde_json::from_str::<guest_contracts::oom_evidence::OomEvidence>(include_str!(
                "../../guest-contracts/tests/fixtures/contained-tool-oom.json"
            ))
            .unwrap(),
        )
        .unwrap();
        let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
            "200 OK",
            r#"{"success":true,"oomEvidenceVersion":1}"#,
        ))])
        .await;
        let telemetry = JobTelemetry::new(
            http_client_for_api_url(&server.url()),
            RunId::from(uuid::Uuid::nil()),
            "tok".to_string(),
            None,
        );

        telemetry.upload_oom_evidence(&legacy, "sandbox").await;

        let requests = server.assert_finished_with_requests().await;
        let (_, body) = requests[0].split_once("\r\n\r\n").unwrap();
        let actual: serde_json::Value = serde_json::from_str(body).unwrap();
        assert!(!body.contains("runtime_progress_at"));
        assert_eq!(actual["oomEvidence"], expected);
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
            RunId::from(uuid::Uuid::nil()),
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
    async fn home_startup_http_payload_matches_shared_contract_fixture() {
        let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
            "200 OK",
            r#"{"success":true}"#,
        ))])
        .await;
        let mut telemetry = JobTelemetry::new(
            http_client_for_api_url(&server.url()),
            RunId::from(uuid::Uuid::nil()),
            "startup-token".to_owned(),
            None,
        );
        telemetry.record_api_to_spawn(
            Duration::from_millis(125),
            RunnerStartupPath::Home,
            SandboxReuseResult::PoolMiss,
        );
        telemetry.record_api_to_agent_ready(
            Duration::from_millis(150),
            RunnerStartupPath::Home,
            SandboxReuseResult::PoolMiss,
        );
        telemetry.flush().await;
        let requests = server.assert_finished_with_requests().await;
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("POST /api/webhooks/agent/telemetry "));
        let (_, body) = requests[0].split_once("\r\n\r\n").unwrap();
        let actual: serde_json::Value = serde_json::from_str(body).unwrap();
        let mut expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../../turbo/packages/api-contracts/src/contracts/__tests__/fixtures/runner-home-startup-telemetry.json"
        ))
        .unwrap();
        expected["runnerVersion"] = serde_json::json!(RUNNER_VERSION);
        for (expected_op, actual_op) in expected["sandboxOperations"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .zip(actual["sandboxOperations"].as_array().unwrap())
        {
            DateTime::parse_from_rfc3339(actual_op["ts"].as_str().unwrap()).unwrap();
            expected_op["ts"] = actual_op["ts"].clone();
        }
        assert_eq!(actual, expected);
    }

    #[tokio::test]
    async fn telemetry_rejection_attributes_schema_operation_and_version_without_values() {
        let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
            "400 Bad Request",
            r#"{"error":{"code":"BAD_REQUEST","message":"sandboxOperations.1.runner_startup_path: response-private-value"}}"#,
        ))])
        .await;
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let mut telemetry = JobTelemetry::new(
            http_client_for_api_url(&server.url()),
            RunId::from(uuid::Uuid::nil()),
            "telemetry-private-token".to_owned(),
            None,
        );
        telemetry.record(
            "telemetry-private-action",
            Duration::ZERO,
            false,
            Some("telemetry-private-error"),
        );
        telemetry.record_api_to_spawn(
            Duration::from_millis(125),
            RunnerStartupPath::Home,
            SandboxReuseResult::PoolMiss,
        );
        telemetry.flush().with_subscriber(subscriber).await;
        let requests = server.assert_finished_with_requests().await;
        assert_eq!(requests.len(), 1);
        let event = captured
            .entries()
            .into_iter()
            .find(|event| {
                event
                    .fields
                    .get("message")
                    .is_some_and(|message| message == "telemetry flush rejected")
            })
            .expect("telemetry rejection should be logged");
        assert_eq!(event.level, Level::WARN);
        assert_eq!(event.fields["runner_version"], RUNNER_VERSION);
        assert_eq!(event.fields["operation_count"], "2");
        assert_eq!(event.fields["rejection_field"], "runner_startup_path");
        assert_eq!(event.fields["rejection_operation_index"], "1");
        assert_eq!(event.fields["rejection_operation"], "api_to_spawn");
        let event_debug = format!("{event:#?}");
        for secret in [
            "response-private-value",
            "telemetry-private-token",
            "telemetry-private-action",
            "telemetry-private-error",
        ] {
            assert!(!event_debug.contains(secret));
        }
    }

    #[tokio::test]
    async fn telemetry_rejection_keeps_unusable_responses_unattributed() {
        let valid = r#"{"error":{"code":"BAD_REQUEST","message":"sandboxOperations.0.runner_startup_path: response-private-value"}}"#;
        for (status, body) in [
            ("400 Bad Request", "{"),
            (
                "400 Bad Request",
                r#"{"error":{"code":"BAD_REQUEST","message":"Invalid JSON in request body"}}"#,
            ),
            (
                "400 Bad Request",
                r#"{"error":{"code":"PRIVATE_CODE","message":"sandboxOperations.0.runner_startup_path: response-private-value"}}"#,
            ),
            (
                "400 Bad Request",
                r#"{"error":{"code":"BAD_REQUEST","message":"sandboxOperations.0.response-private-key: response-private-value"}}"#,
            ),
            (
                "400 Bad Request",
                r#"{"error":{"code":"BAD_REQUEST","message":"sandboxOperations.1.runner_startup_path: response-private-value"}}"#,
            ),
            ("500 Internal Server Error", valid),
        ] {
            let server =
                RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(status, body))])
                    .await;
            let captured = CapturedEvents::default();
            let subscriber = tracing_subscriber::registry().with(captured.clone());
            let mut telemetry = JobTelemetry::new(
                http_client_for_api_url(&server.url()),
                RunId::from(uuid::Uuid::nil()),
                "telemetry-private-token".to_owned(),
                None,
            );
            telemetry.record_api_to_spawn(
                Duration::ZERO,
                RunnerStartupPath::Home,
                SandboxReuseResult::PoolMiss,
            );
            telemetry.flush().with_subscriber(subscriber).await;
            server.assert_finished().await;
            let event = captured
                .entries()
                .into_iter()
                .find(|event| {
                    event
                        .fields
                        .get("message")
                        .is_some_and(|message| message == "telemetry flush rejected")
                })
                .expect("unattributed rejection should still be logged");
            assert!(!event.fields.contains_key("rejection_field"));
            assert!(!event.fields.contains_key("rejection_operation_index"));
            assert!(!event.fields.contains_key("rejection_operation"));
            assert!(!format!("{event:#?}").contains("private"));
        }
    }

    #[tokio::test]
    async fn telemetry_rejection_bounds_response_bytes_and_arbitrary_action_names() {
        for size in [4096, 4097] {
            let mut body = serde_json::json!({
                "error": {
                    "code": "BAD_REQUEST",
                    "message": "sandboxOperations.0.action_type: response-private-value",
                },
                "padding": "",
            });
            let padding = size - serde_json::to_vec(&body).unwrap().len();
            body["padding"] = serde_json::json!("x".repeat(padding));
            let body = serde_json::to_string(&body).unwrap();
            assert_eq!(body.len(), size);
            let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
                "400 Bad Request",
                &body,
            ))])
            .await;
            let captured = CapturedEvents::default();
            let subscriber = tracing_subscriber::registry().with(captured.clone());
            let mut telemetry = JobTelemetry::new(
                http_client_for_api_url(&server.url()),
                RunId::from(uuid::Uuid::nil()),
                "telemetry-private-token".to_owned(),
                None,
            );
            telemetry.record("telemetry-private-action", Duration::ZERO, true, None);
            telemetry.flush().with_subscriber(subscriber).await;
            server.assert_finished().await;
            let event = captured
                .entries()
                .into_iter()
                .find(|event| {
                    event
                        .fields
                        .get("message")
                        .is_some_and(|message| message == "telemetry flush rejected")
                })
                .expect("oversize and attributed rejections should be logged");
            if size == 4096 {
                assert_eq!(event.fields["rejection_field"], "action_type");
                assert_eq!(event.fields["rejection_operation_index"], "0");
            } else {
                assert!(!event.fields.contains_key("rejection_field"));
                assert!(!event.fields.contains_key("rejection_operation_index"));
            }
            assert!(!event.fields.contains_key("rejection_operation"));
            assert!(!format!("{event:#?}").contains("private"));
        }
    }

    #[tokio::test]
    async fn transport_failure_logs_stable_cause_and_safe_request_context() {
        let server = RawHttpTestServer::spawn(vec![RawHttpAction::Disconnect]).await;
        let api_url = server.url();
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());

        send_telemetry(
            &http_client_for_api_url(&api_url),
            Some(RunId::from(uuid::Uuid::nil())),
            "telemetry-sensitive-token",
            None,
            vec![sandbox_op(
                "telemetry-sensitive-action",
                Duration::from_millis(1),
                true,
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

        let mut telemetry = JobTelemetry::new(
            http_client_for_api_url(&api_url),
            RunId::from(uuid::Uuid::nil()),
            "tok".to_string(),
            Some("prod-1.aws.vm3.ai".to_string()),
        );
        telemetry.set_sandbox_startup_path(RunnerStartupPath::Blank);
        telemetry.set_first_run(Some(false));
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
        let (_, body) = request.split_once("\r\n\r\n").unwrap();
        let payload: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(
            payload["sandboxOperations"][0]["runner_startup_path"],
            "blank"
        );
        assert_eq!(payload["sandboxOperations"][0]["is_first_run"], false);
    }

    #[tokio::test]
    async fn sandbox_startup_fact_is_published_before_final_flush_without_flushing_preparation() {
        for (path, wire_path, sandbox_result, home_result) in [
            (
                RunnerStartupPath::Sandbox,
                "sandbox",
                SandboxReuseResult::Reused,
                HomeReuseResult::SandboxReused,
            ),
            (
                RunnerStartupPath::Home,
                "home",
                SandboxReuseResult::PoolMiss,
                HomeReuseResult::Reused,
            ),
            (
                RunnerStartupPath::Blank,
                "blank",
                SandboxReuseResult::PoolMiss,
                HomeReuseResult::CacheMiss,
            ),
            (
                RunnerStartupPath::Cold,
                "cold",
                SandboxReuseResult::PoolMiss,
                HomeReuseResult::CacheMiss,
            ),
        ] {
            let (release_tx, release_rx) = tokio::sync::oneshot::channel();
            let mut server = RawHttpTestServer::spawn(vec![
                RawHttpAction::WaitThenRespond {
                    release: release_rx,
                    response: json_response("200 OK", r#"{"success":true}"#),
                },
                RawHttpAction::Respond(json_response("200 OK", r#"{"success":true}"#)),
            ])
            .await;
            let mut telemetry = JobTelemetry::new(
                http_client_for_api_url(&server.url()),
                RunId::new_v4(),
                "tok".into(),
                None,
            );
            telemetry.set_first_run(Some(false));
            telemetry.set_sandbox_startup_path(path);
            let generation = uuid::Uuid::new_v4().to_string();
            telemetry.set_home_startup_source(Some(HomeImageSourceIdentity {
                cache_key: "selected-cache",
                profile_name: "vm0/default",
                image_generation: &generation,
            }));
            let mut phase = telemetry.fork_concurrent_phase();
            telemetry.record("preparation", Duration::ZERO, true, None);
            phase.record_sandbox_startup(path, sandbox_result, home_result, Some("thread:tracked"));
            telemetry.merge_concurrent_phase(phase);

            let request = server.next_request("startup fact before final flush").await;
            let (_, body) = request.split_once("\r\n\r\n").unwrap();
            let payload: serde_json::Value = serde_json::from_str(body).unwrap();
            let operations = payload["sandboxOperations"].as_array().unwrap();
            assert_eq!(operations.len(), 1);
            let operation = &operations[0];
            assert_eq!(operation["action_type"], "runner_sandbox_startup");
            assert_eq!(operation["runner_startup_path"], wire_path);
            assert_eq!(operation["is_first_run"], false);
            assert_eq!(operation["success"], true);
            assert_eq!(operation["reuse_key"], "thread:tracked");
            if path == RunnerStartupPath::Home {
                assert_eq!(operation["cache_key"], "selected-cache");
                assert_eq!(operation["profile_name"], "vm0/default");
                assert_eq!(operation["image_generation"], generation);
            } else {
                for field in ["cache_key", "profile_name", "image_generation"] {
                    assert!(operation.get(field).is_none(), "{wire_path}: {field}");
                }
            }
            assert_eq!(
                operation["home_reuse_result"],
                serde_json::to_value(home_result).unwrap()
            );
            assert_eq!(
                operation["sandbox_reuse_result"],
                serde_json::to_value(sandbox_result).unwrap()
            );

            // Recording continues while the startup request's response is held.
            telemetry.record("after_start", Duration::ZERO, true, None);
            release_tx.send(()).unwrap();
            telemetry.flush().await;
            let request = server.next_request("ordinary batch at final flush").await;
            let (_, body) = request.split_once("\r\n\r\n").unwrap();
            let payload: serde_json::Value = serde_json::from_str(body).unwrap();
            let operations = payload["sandboxOperations"].as_array().unwrap();
            assert_eq!(operations.len(), 2);
            assert_eq!(operations[0]["action_type"], "preparation");
            assert_eq!(operations[1]["action_type"], "after_start");
            assert!(operations.iter().all(|op| op["is_first_run"] == false));
            server.assert_finished().await;
        }
    }

    #[tokio::test]
    async fn sandbox_startup_without_first_context_omits_it_and_keeps_the_send_owned() {
        use futures_util::FutureExt;

        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitThenRespond {
            release: release_rx,
            response: json_response("200 OK", r#"{"success":true}"#),
        }])
        .await;
        let mut telemetry = JobTelemetry::new(
            http_client_for_api_url(&server.url()),
            RunId::new_v4(),
            "tok".into(),
            None,
        );
        telemetry.record_sandbox_startup(
            RunnerStartupPath::Cold,
            SandboxReuseResult::NoReuseKey,
            HomeReuseResult::NoReuseKey,
            None,
        );
        let request = server.next_request("startup without context").await;
        let (_, body) = request.split_once("\r\n\r\n").unwrap();
        let payload: serde_json::Value = serde_json::from_str(body).unwrap();
        let operation = &payload["sandboxOperations"][0];
        assert!(operation.get("is_first_run").is_none());
        assert!(operation.get("reuse_key").is_none());
        assert_eq!(operation["runner_startup_path"], "cold");
        let mut flush = Box::pin(telemetry.flush());
        assert!(flush.as_mut().now_or_never().is_none());
        release_tx.send(()).unwrap();
        flush.await;
        server.assert_finished().await;
    }

    #[tokio::test]
    async fn first_run_context_survives_concurrent_phase_ownership() {
        let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
            "200 OK",
            r#"{"success":true}"#,
        ))])
        .await;
        let mut telemetry = JobTelemetry::new(
            http_client_for_api_url(&server.url()),
            RunId::new_v4(),
            "tok".into(),
            None,
        );
        telemetry.set_first_run(Some(true));
        let mut phase = telemetry.fork_concurrent_phase();
        phase.record("concurrent", Duration::ZERO, true, None);
        telemetry.merge_concurrent_phase(phase);
        telemetry.record("continued", Duration::ZERO, true, None);
        telemetry.flush().await;
        let requests = server.assert_finished_with_requests().await;
        let (_, body) = requests[0].split_once("\r\n\r\n").unwrap();
        let payload: serde_json::Value = serde_json::from_str(body).unwrap();
        let operations = payload["sandboxOperations"].as_array().unwrap();
        assert_eq!(operations.len(), 2);
        assert!(operations.iter().all(|op| op["is_first_run"] == true));
    }
}
