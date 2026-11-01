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

/// Inclusive post-claim startup concurrency captured when a job enters timing.
///
/// Each job remains a member until its timing is consumed after Agent readiness
/// or dropped on early exit, including time after its guest process has spawned.
/// The fixed cohort remains available for `api_to_spawn` and `api_to_agent_ready`
/// after live membership ends; it is not a continuously updated gauge.
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

/// Shared admission-time cohort label deactivated when startup timing drops early.
/// Successful Agent readiness preserves it for the startup-boundary rows.
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
    home_non_reuse_reason: Option<&'static str>,
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
    let end = value.floor_char_boundary(value.len().min(4096));
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
            home_non_reuse_reason: None,
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

    pub(crate) fn set_home_non_reuse_reason(&mut self, reason: &'static str) {
        self.home_non_reuse_reason = Some(reason);
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
            home_non_reuse_reason: None,
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
        if home_reuse_result != HomeReuseResult::Reused {
            op.reason = Some(
                self.home_non_reuse_reason
                    .unwrap_or(home_reuse_result.as_wire())
                    .to_owned(),
            );
        }
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
            home_non_reuse_reason: self.home_non_reuse_reason,
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
                let end = field.floor_char_boundary(field.len().min(limit));
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
mod tests;
