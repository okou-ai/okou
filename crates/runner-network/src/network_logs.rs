use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, BufReader};
use tokio::time::{Instant, timeout_at};
use tracing::{error, info, warn};

use crate::network_log_transport::{
    NetworkLogHttpClient, NetworkLogRequestContext, NetworkLogTransportFailure,
};
use runner_types::ids::RunId;

mod line;

use line::{BoundedLogLine, LineContent};

/// Network log entry from the per-run JSONL file.
///
/// `NETWORK_LOG_FIELDS` — shared schema boundary is api-contracts; producers
/// include mitmproxy plus Rust-side DNS/kmsg logging.
/// Uses a transparent `serde_json::Value` wrapper so all fields pass through
/// to Axiom without needing a struct field for each one. This avoids silently
/// dropping fields added by any producer.
#[derive(Serialize, Deserialize, Clone)]
#[serde(transparent)]
struct NetworkLog(serde_json::Value);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkLogPayload {
    pub run_id: String,
    network_logs: Vec<NetworkLog>,
}

const NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES: usize = 10_000;
const NETWORK_LOG_UPLOAD_INITIAL_BATCH_CAPACITY: usize = 500;
const NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES: usize = 1024 * 1024;
const NETWORK_LOG_UPLOAD_PAYLOAD_OVERHEAD_BYTES: usize = 64;
const NETWORK_LOG_UPLOAD_ENTRY_OVERHEAD_BYTES: usize = 1;
const NETWORK_LOG_UPLOAD_ERROR_BODY_MAX_BYTES: usize = 2048;
const NETWORK_LOG_UPLOAD_ERROR_FIELD_MAX_CHARS: usize = 512;
// Complement the per-request limits with finite per-run local, remote, and elapsed work.
const NETWORK_LOG_UPLOAD_MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const NETWORK_LOG_UPLOAD_MAX_BATCHES: usize = 64;
// Allow cumulative batch latency without extending HttpClient's per-request timeout.
const NETWORK_LOG_UPLOAD_MAX_DURATION: Duration = Duration::from_secs(30);
const NETWORK_LOG_UPLOAD_HEALTH_WINDOW: Duration = Duration::from_secs(5 * 60);
const NETWORK_LOG_UPLOAD_HEALTH_MIN_FAILURES: usize = 3;
const NETWORK_LOG_UPLOAD_HEALTH_FAILURE_PERCENT: usize = 20;

#[derive(Default)]
struct UploadRejectionDetails {
    error_code: Option<String>,
    error_message: Option<String>,
    body_truncated: bool,
    body_read_error: Option<String>,
}

#[derive(Deserialize)]
struct ApiErrorEnvelope {
    error: ApiErrorDetails,
}

#[derive(Deserialize)]
struct ApiErrorDetails {
    code: Option<String>,
    message: Option<String>,
}

#[derive(Clone, Copy)]
enum UploadOutcome {
    Missing,
    Complete,
    Truncated(UploadTruncationReason),
    Failed(UploadFailure),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum UploadFailure {
    Other,
    Transport { failure: NetworkLogTransportFailure },
}

#[derive(Clone, Copy)]
enum UploadTruncationReason {
    SourceBytes,
    BatchCount,
    Deadline,
    OversizedEntry,
}

impl UploadTruncationReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::SourceBytes => "source_bytes",
            Self::BatchCount => "batch_count",
            Self::Deadline => "deadline",
            Self::OversizedEntry => "oversized_entry",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BatchUploadOutcome {
    Continue,
    BatchLimit,
    Failed(UploadFailure),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetworkLogUploadSessionOutcome {
    Excluded,
    Success,
    TransportFailure { failure: NetworkLogTransportFailure },
}

#[derive(Clone, Copy)]
enum EligibleNetworkLogUploadOutcome {
    Success,
    TransportFailure { failure: NetworkLogTransportFailure },
}

struct TimedNetworkLogUploadOutcome {
    observed_at: Instant,
    outcome: EligibleNetworkLogUploadOutcome,
}

#[derive(Default)]
struct NetworkLogUploadHealthState {
    outcomes: VecDeque<TimedNetworkLogUploadOutcome>,
    successful_sessions: usize,
    transport_failures: usize,
    degradation_emitted: bool,
}

struct NetworkLogUploadDegradation {
    eligible_sessions: usize,
    successful_sessions: usize,
    transport_failures: usize,
    failure_rate_basis_points: u128,
    latest_failure: NetworkLogTransportFailure,
}

impl NetworkLogUploadHealthState {
    fn is_degraded(&self) -> bool {
        self.transport_failures >= NETWORK_LOG_UPLOAD_HEALTH_MIN_FAILURES
            && (self.transport_failures as u128) * 100
                >= (self.outcomes.len() as u128)
                    * (NETWORK_LOG_UPLOAD_HEALTH_FAILURE_PERCENT as u128)
    }

    fn observe(
        &mut self,
        now: Instant,
        outcome: EligibleNetworkLogUploadOutcome,
    ) -> Option<NetworkLogUploadDegradation> {
        while self.outcomes.front().is_some_and(|entry| {
            now.saturating_duration_since(entry.observed_at) > NETWORK_LOG_UPLOAD_HEALTH_WINDOW
        }) {
            let Some(expired) = self.outcomes.pop_front() else {
                break;
            };
            match expired.outcome {
                EligibleNetworkLogUploadOutcome::Success => {
                    self.successful_sessions -= 1;
                }
                EligibleNetworkLogUploadOutcome::TransportFailure { .. } => {
                    self.transport_failures -= 1;
                }
            }
        }
        if !self.is_degraded() {
            self.degradation_emitted = false;
        }

        self.outcomes.push_back(TimedNetworkLogUploadOutcome {
            observed_at: now,
            outcome,
        });
        match outcome {
            EligibleNetworkLogUploadOutcome::Success => {
                self.successful_sessions += 1;
            }
            EligibleNetworkLogUploadOutcome::TransportFailure { .. } => {
                self.transport_failures += 1;
            }
        }

        let eligible_sessions = self.outcomes.len();
        if !self.is_degraded() {
            self.degradation_emitted = false;
            return None;
        }
        if self.degradation_emitted {
            return None;
        }
        let latest_failure = self
            .outcomes
            .iter()
            .rev()
            .find_map(|entry| match entry.outcome {
                EligibleNetworkLogUploadOutcome::Success => None,
                EligibleNetworkLogUploadOutcome::TransportFailure { failure } => Some(failure),
            })?;
        self.degradation_emitted = true;
        let failure_rate_basis_points =
            (self.transport_failures as u128) * 10_000 / (eligible_sessions as u128);
        Some(NetworkLogUploadDegradation {
            eligible_sessions,
            successful_sessions: self.successful_sessions,
            transport_failures: self.transport_failures,
            failure_rate_basis_points,
            latest_failure,
        })
    }
}

#[derive(Clone, Default)]
pub struct NetworkLogUploadHealthTracker {
    state: Arc<Mutex<NetworkLogUploadHealthState>>,
}

impl NetworkLogUploadHealthTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn observe(&self, outcome: NetworkLogUploadSessionOutcome) {
        let Some(outcome) = eligible_upload_outcome(outcome) else {
            return;
        };
        let degradation = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .observe(Instant::now(), outcome);
        if let Some(degradation) = degradation {
            error!(
                window_seconds = NETWORK_LOG_UPLOAD_HEALTH_WINDOW.as_secs(),
                eligible_sessions = degradation.eligible_sessions,
                successful_sessions = degradation.successful_sessions,
                transport_failures = degradation.transport_failures,
                failure_rate_basis_points = degradation.failure_rate_basis_points,
                failure_kind = degradation.latest_failure.kind,
                failure_cause = degradation.latest_failure.cause,
                "network log uploads degraded"
            );
        }
    }

    #[cfg(test)]
    fn record_at(
        &self,
        now: Instant,
        outcome: EligibleNetworkLogUploadOutcome,
    ) -> Option<NetworkLogUploadDegradation> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .observe(now, outcome)
    }
}

fn eligible_upload_outcome(
    outcome: NetworkLogUploadSessionOutcome,
) -> Option<EligibleNetworkLogUploadOutcome> {
    match outcome {
        NetworkLogUploadSessionOutcome::Excluded => None,
        NetworkLogUploadSessionOutcome::Success => Some(EligibleNetworkLogUploadOutcome::Success),
        NetworkLogUploadSessionOutcome::TransportFailure { failure } => {
            Some(EligibleNetworkLogUploadOutcome::TransportFailure { failure })
        }
    }
}

#[derive(Clone, Copy)]
enum BatchRequestState {
    InFlight,
    ConfirmedSuccess,
    ConfirmedRejection,
    TransportFailure,
    OutcomeUnknown,
}

impl BatchRequestState {
    fn as_str(self) -> &'static str {
        match self {
            Self::InFlight => "in_flight",
            Self::ConfirmedSuccess => "confirmed_success",
            Self::ConfirmedRejection => "confirmed_rejection",
            Self::TransportFailure => "transport_failure",
            Self::OutcomeUnknown => "outcome_unknown",
        }
    }

    fn at_deadline(self) -> Self {
        match self {
            Self::InFlight => Self::OutcomeUnknown,
            state => state,
        }
    }
}

struct ActiveBatchRequest {
    batch_index: usize,
    context: NetworkLogRequestContext,
    state: BatchRequestState,
}

#[derive(Default)]
struct NetworkLogUploadProgress {
    source_file_bytes: Option<u64>,
    source_bytes_examined: u64,
    attempted_batches: usize,
    successful_batches: usize,
    attempted_entries: usize,
    uploaded_entries: usize,
    attempted_estimated_bytes: usize,
    uploaded_estimated_bytes: usize,
    unconfirmed_entries: usize,
    unconfirmed_estimated_bytes: usize,
    oversized_entries: usize,
    oversized_estimated_bytes: usize,
    observed_dropped_entries: usize,
    observed_dropped_estimated_bytes: usize,
    partial_source_line: bool,
    malformed_input: bool,
}

/// Upload network logs from the per-run JSONL file.
/// Reads the file at `path`, POSTs bounded batches to telemetry endpoint,
/// and keeps the local file for debugging/log GC. Delivery remains best-effort.
pub async fn upload_network_logs(
    http: &impl NetworkLogHttpClient,
    run_id: RunId,
    sandbox_token: &str,
    path: &Path,
) -> NetworkLogUploadSessionOutcome {
    let deadline = Instant::now() + NETWORK_LOG_UPLOAD_MAX_DURATION;
    let mut uploader = NetworkLogBatchUploader::new(http, run_id, sandbox_token);
    let outcome = match timeout_at(
        deadline,
        upload_network_logs_inner(path, deadline, &mut uploader),
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(_) => UploadOutcome::Truncated(UploadTruncationReason::Deadline),
    };

    let truncation_reason = match outcome {
        UploadOutcome::Truncated(reason) => Some(reason),
        UploadOutcome::Complete | UploadOutcome::Failed(_)
            if uploader.progress.oversized_entries > 0 =>
        {
            Some(UploadTruncationReason::OversizedEntry)
        }
        UploadOutcome::Missing | UploadOutcome::Complete | UploadOutcome::Failed(_) => None,
    };
    if let Some(reason) = truncation_reason {
        uploader.warn_truncated(reason);
    }

    if matches!(
        outcome,
        UploadOutcome::Complete | UploadOutcome::Truncated(_)
    ) && uploader.total_uploaded() > 0
    {
        info!(
            run_id = %run_id,
            batches = uploader.successful_batch_count(),
            count = uploader.total_uploaded(),
            "uploaded network logs"
        );
    }

    match outcome {
        UploadOutcome::Complete
            if uploader.progress.attempted_batches > 0
                && uploader.progress.attempted_batches == uploader.progress.successful_batches
                && uploader.progress.oversized_entries == 0
                && !uploader.progress.malformed_input =>
        {
            NetworkLogUploadSessionOutcome::Success
        }
        UploadOutcome::Failed(UploadFailure::Transport { failure }) => {
            NetworkLogUploadSessionOutcome::TransportFailure { failure }
        }
        UploadOutcome::Missing
        | UploadOutcome::Complete
        | UploadOutcome::Truncated(_)
        | UploadOutcome::Failed(UploadFailure::Other) => NetworkLogUploadSessionOutcome::Excluded,
    }
}

async fn upload_network_logs_inner(
    path: &Path,
    deadline: Instant,
    uploader: &mut NetworkLogBatchUploader<'_>,
) -> UploadOutcome {
    let file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return UploadOutcome::Missing,
        Err(e) => {
            warn!(run_id = %uploader.run_id, error = %e, "failed to read network logs");
            return UploadOutcome::Failed(UploadFailure::Other);
        }
    };

    let source_file_bytes = match file.metadata().await {
        Ok(metadata) => metadata.len(),
        Err(e) => {
            warn!(run_id = %uploader.run_id, error = %e, "failed to read network logs");
            return UploadOutcome::Failed(UploadFailure::Other);
        }
    };
    uploader.progress.source_file_bytes = Some(source_file_bytes);

    let source_is_larger_than_limit = source_file_bytes > NETWORK_LOG_UPLOAD_MAX_SOURCE_BYTES;
    let mut reader = BufReader::new(file.take(NETWORK_LOG_UPLOAD_MAX_SOURCE_BYTES));
    let max_record_bytes = NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES
        - empty_batch_estimated_bytes(&uploader.run_id)
        - NETWORK_LOG_UPLOAD_ENTRY_OVERHEAD_BYTES;
    let mut line = BoundedLogLine::new(max_record_bytes);
    let mut source_limit_reached = false;

    loop {
        if Instant::now() >= deadline {
            return UploadOutcome::Truncated(UploadTruncationReason::Deadline);
        }

        let bytes_read = match line.read(&mut reader).await {
            Ok(0) => break,
            Ok(bytes_read) => bytes_read,
            Err(e) => {
                warn!(run_id = %uploader.run_id, error = %e, "failed to read network logs");
                return UploadOutcome::Failed(UploadFailure::Other);
            }
        };
        uploader.progress.source_bytes_examined = uploader
            .progress
            .source_bytes_examined
            .saturating_add(bytes_read as u64);

        let reached_capped_source_end = source_is_larger_than_limit
            && uploader.progress.source_bytes_examined >= NETWORK_LOG_UPLOAD_MAX_SOURCE_BYTES;
        if reached_capped_source_end && !line.terminated() {
            uploader.progress.partial_source_line = true;
            source_limit_reached = true;
            break;
        }

        if Instant::now() >= deadline {
            return UploadOutcome::Truncated(UploadTruncationReason::Deadline);
        }

        // Apply the existing admission size before building a discarded JSON
        // tree. Whitespace-only padding was trimmed without retaining its body.
        let upload = match line.content() {
            LineContent::InvalidUtf8 => {
                uploader.progress.malformed_input = true;
                warn!(run_id = %uploader.run_id, error = "invalid UTF-8 in network log line", "malformed network log line");
                if reached_capped_source_end {
                    source_limit_reached = true;
                    break;
                }
                continue;
            }
            LineContent::Value("") => {
                if reached_capped_source_end {
                    source_limit_reached = true;
                    break;
                }
                continue;
            }
            LineContent::Oversized(bytes) => {
                uploader
                    .skip_oversized_entry(
                        bytes.saturating_add(NETWORK_LOG_UPLOAD_ENTRY_OVERHEAD_BYTES),
                    )
                    .await
            }
            LineContent::Value(value) => {
                let log = match serde_json::from_str(value) {
                    Ok(log) => log,
                    Err(e) => {
                        uploader.progress.malformed_input = true;
                        warn!(run_id = %uploader.run_id, error = %e, "malformed network log line");
                        if reached_capped_source_end {
                            source_limit_reached = true;
                            break;
                        }
                        continue;
                    }
                };
                if Instant::now() >= deadline {
                    return UploadOutcome::Truncated(UploadTruncationReason::Deadline);
                }
                uploader.push(log, estimated_entry_bytes(value)).await
            }
        };
        match upload {
            BatchUploadOutcome::Continue => {}
            BatchUploadOutcome::BatchLimit => {
                return UploadOutcome::Truncated(UploadTruncationReason::BatchCount);
            }
            BatchUploadOutcome::Failed(failure) => return UploadOutcome::Failed(failure),
        }

        if reached_capped_source_end {
            source_limit_reached = true;
            break;
        }

        if !uploader.can_attempt_more_batches() {
            if uploader.progress.source_bytes_examined < source_file_bytes {
                return UploadOutcome::Truncated(UploadTruncationReason::BatchCount);
            }
            break;
        }
    }

    if Instant::now() >= deadline {
        return UploadOutcome::Truncated(UploadTruncationReason::Deadline);
    }

    match uploader.finish().await {
        BatchUploadOutcome::Continue if source_limit_reached => {
            UploadOutcome::Truncated(UploadTruncationReason::SourceBytes)
        }
        BatchUploadOutcome::Continue => UploadOutcome::Complete,
        BatchUploadOutcome::BatchLimit => {
            uploader.discard_pending_batch();
            UploadOutcome::Truncated(UploadTruncationReason::BatchCount)
        }
        BatchUploadOutcome::Failed(failure) => UploadOutcome::Failed(failure),
    }
}

struct NetworkLogBatchUploader<'a> {
    http: &'a dyn NetworkLogHttpClient,
    run_id: RunId,
    sandbox_token: &'a str,
    batch: Vec<NetworkLog>,
    batch_bytes: usize,
    progress: NetworkLogUploadProgress,
    active_request: Option<ActiveBatchRequest>,
}

impl<'a> NetworkLogBatchUploader<'a> {
    fn new(http: &'a dyn NetworkLogHttpClient, run_id: RunId, sandbox_token: &'a str) -> Self {
        Self {
            http,
            run_id,
            sandbox_token,
            batch: Vec::with_capacity(NETWORK_LOG_UPLOAD_INITIAL_BATCH_CAPACITY),
            batch_bytes: empty_batch_estimated_bytes(&run_id),
            progress: NetworkLogUploadProgress::default(),
            active_request: None,
        }
    }

    async fn push(&mut self, log: NetworkLog, entry_bytes: usize) -> BatchUploadOutcome {
        if self.is_oversized_entry(entry_bytes) {
            return self.skip_oversized_entry(entry_bytes).await;
        }

        if !self.can_attempt_more_batches() {
            self.record_observed_dropped_entry(entry_bytes);
            return BatchUploadOutcome::BatchLimit;
        }

        if self.should_flush_before_push(entry_bytes) {
            let outcome = self.flush().await;
            if outcome != BatchUploadOutcome::Continue {
                return outcome;
            }
            if !self.can_attempt_more_batches() {
                self.record_observed_dropped_entry(entry_bytes);
                return BatchUploadOutcome::BatchLimit;
            }
        }

        self.batch.push(log);
        self.batch_bytes = self.batch_bytes.saturating_add(entry_bytes);

        if self.should_flush_after_push() {
            return self.flush().await;
        }

        BatchUploadOutcome::Continue
    }

    async fn skip_oversized_entry(&mut self, entry_bytes: usize) -> BatchUploadOutcome {
        self.progress.oversized_entries = self.progress.oversized_entries.saturating_add(1);
        self.progress.oversized_estimated_bytes = self
            .progress
            .oversized_estimated_bytes
            .saturating_add(entry_bytes);
        self.flush().await
    }

    async fn finish(&mut self) -> BatchUploadOutcome {
        self.flush().await
    }

    fn total_uploaded(&self) -> usize {
        self.progress.uploaded_entries
    }

    fn successful_batch_count(&self) -> usize {
        self.progress.successful_batches
    }

    fn can_attempt_more_batches(&self) -> bool {
        self.progress.attempted_batches < NETWORK_LOG_UPLOAD_MAX_BATCHES
    }

    fn should_flush_before_push(&self, entry_bytes: usize) -> bool {
        !self.batch.is_empty()
            && (self.batch.len() >= NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES
                || self.batch_bytes.saturating_add(entry_bytes)
                    > NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES)
    }

    fn should_flush_after_push(&self) -> bool {
        self.batch.len() >= NETWORK_LOG_UPLOAD_MAX_BATCH_ENTRIES
            || self.batch_bytes >= NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES
    }

    fn is_oversized_entry(&self, entry_bytes: usize) -> bool {
        empty_batch_estimated_bytes(&self.run_id).saturating_add(entry_bytes)
            > NETWORK_LOG_UPLOAD_MAX_BATCH_BYTES
    }

    fn record_observed_dropped_entry(&mut self, entry_bytes: usize) {
        self.progress.observed_dropped_entries =
            self.progress.observed_dropped_entries.saturating_add(1);
        self.progress.observed_dropped_estimated_bytes = self
            .progress
            .observed_dropped_estimated_bytes
            .saturating_add(entry_bytes);
    }

    fn discard_pending_batch(&mut self) {
        self.progress.observed_dropped_entries = self
            .progress
            .observed_dropped_entries
            .saturating_add(self.batch.len());
        self.progress.observed_dropped_estimated_bytes = self
            .progress
            .observed_dropped_estimated_bytes
            .saturating_add(
                self.batch_bytes
                    .saturating_sub(empty_batch_estimated_bytes(&self.run_id)),
            );
        self.batch.clear();
        self.batch_bytes = empty_batch_estimated_bytes(&self.run_id);
    }

    fn warn_truncated(&self, reason: UploadTruncationReason) {
        let source_file_bytes_known = self.progress.source_file_bytes.is_some();
        let source_file_bytes = self.progress.source_file_bytes.unwrap_or_default();
        let remaining_source_bytes =
            source_file_bytes.saturating_sub(self.progress.source_bytes_examined);
        let active_request = self.active_request.as_ref();
        let batch_index = active_request.map(|request| request.batch_index);
        let client_request_id =
            active_request.map(|request| request.context.client_request_id.as_str());
        let client_session_id =
            active_request.map(|request| request.context.client_session_id.as_str());
        let client_version = active_request.map(|request| request.context.client_version.as_str());
        let request_state = active_request.map(|request| request.state.at_deadline().as_str());

        warn!(
            run_id = %self.run_id,
            reason = reason.as_str(),
            batch_index,
            client_request_id,
            client_session_id,
            client_version,
            request_state,
            source_file_bytes,
            source_file_bytes_known,
            source_bytes_examined = self.progress.source_bytes_examined,
            remaining_source_bytes,
            remaining_source_bytes_known = source_file_bytes_known,
            attempted_batches = self.progress.attempted_batches,
            successful_batches = self.progress.successful_batches,
            attempted_entries = self.progress.attempted_entries,
            uploaded_entries = self.progress.uploaded_entries,
            unconfirmed_entries = self.progress.unconfirmed_entries,
            attempted_estimated_bytes = self.progress.attempted_estimated_bytes,
            uploaded_estimated_bytes = self.progress.uploaded_estimated_bytes,
            unconfirmed_estimated_bytes = self.progress.unconfirmed_estimated_bytes,
            oversized_entries = self.progress.oversized_entries,
            oversized_estimated_bytes = self.progress.oversized_estimated_bytes,
            observed_dropped_entries = self.progress.observed_dropped_entries,
            observed_dropped_estimated_bytes =
                self.progress.observed_dropped_estimated_bytes,
            partial_source_line = self.progress.partial_source_line,
            "network log upload truncated"
        );
    }

    async fn flush(&mut self) -> BatchUploadOutcome {
        if self.batch.is_empty() {
            return BatchUploadOutcome::Continue;
        }

        if !self.can_attempt_more_batches() {
            return BatchUploadOutcome::BatchLimit;
        }

        self.progress.attempted_batches = self.progress.attempted_batches.saturating_add(1);
        let batch_index = self.progress.attempted_batches;
        let logs = std::mem::replace(
            &mut self.batch,
            Vec::with_capacity(NETWORK_LOG_UPLOAD_INITIAL_BATCH_CAPACITY),
        );
        let batch_bytes = self.batch_bytes;
        self.batch_bytes = empty_batch_estimated_bytes(&self.run_id);
        let count = logs.len();
        self.progress.attempted_entries = self.progress.attempted_entries.saturating_add(count);
        self.progress.attempted_estimated_bytes = self
            .progress
            .attempted_estimated_bytes
            .saturating_add(batch_bytes);
        self.progress.unconfirmed_entries = count;
        self.progress.unconfirmed_estimated_bytes = batch_bytes;

        let payload = NetworkLogPayload {
            run_id: self.run_id.to_string(),
            network_logs: logs,
        };

        let request = match self
            .http
            .prepare_network_log_upload(self.sandbox_token, &payload)
        {
            Ok(request) => request,
            Err(e) => {
                warn!(
                    run_id = %self.run_id,
                    batch_index,
                    error = %e,
                    "network logs upload failed"
                );
                return BatchUploadOutcome::Failed(UploadFailure::Other);
            }
        };
        let request_context = request.context().clone();
        self.active_request = Some(ActiveBatchRequest {
            batch_index,
            context: request_context.clone(),
            state: BatchRequestState::InFlight,
        });
        info!(
            run_id = %self.run_id,
            batch_index,
            count,
            client_request_id = request_context.client_request_id.as_str(),
            client_session_id = request_context.client_session_id.as_str(),
            client_version = request_context.client_version.as_str(),
            request_state = BatchRequestState::InFlight.as_str(),
            "uploading network log batch"
        );

        let result = request.send().await;

        let outcome = match result {
            Ok(resp) if resp.status().is_success() => {
                let status = resp.status();
                // File is kept locally for debugging; gc_job_logs deletes after 7 days.
                self.progress.successful_batches =
                    self.progress.successful_batches.saturating_add(1);
                self.progress.uploaded_entries =
                    self.progress.uploaded_entries.saturating_add(count);
                self.progress.uploaded_estimated_bytes = self
                    .progress
                    .uploaded_estimated_bytes
                    .saturating_add(batch_bytes);
                self.progress.unconfirmed_entries = 0;
                self.progress.unconfirmed_estimated_bytes = 0;
                info!(
                    run_id = %self.run_id,
                    batch_index,
                    count,
                    status = %status,
                    client_request_id = request_context.client_request_id.as_str(),
                    client_session_id = request_context.client_session_id.as_str(),
                    client_version = request_context.client_version.as_str(),
                    request_state = BatchRequestState::ConfirmedSuccess.as_str(),
                    "network log batch uploaded"
                );
                BatchUploadOutcome::Continue
            }
            Ok(resp) => {
                let status = resp.status();
                self.progress.unconfirmed_entries = 0;
                self.progress.unconfirmed_estimated_bytes = 0;
                self.active_request = Some(ActiveBatchRequest {
                    batch_index,
                    context: request_context.clone(),
                    state: BatchRequestState::ConfirmedRejection,
                });
                let rejection = upload_rejection_details(resp).await;
                warn!(
                    run_id = %self.run_id,
                    batch_index,
                    status = %status,
                    client_request_id = request_context.client_request_id.as_str(),
                    client_session_id = request_context.client_session_id.as_str(),
                    client_version = request_context.client_version.as_str(),
                    request_state = BatchRequestState::ConfirmedRejection.as_str(),
                    response_error_code = rejection.error_code.as_deref().unwrap_or(""),
                    response_error_message = rejection.error_message.as_deref().unwrap_or(""),
                    response_body_truncated = rejection.body_truncated,
                    response_body_read_error = rejection.body_read_error.as_deref().unwrap_or(""),
                    "network logs upload rejected"
                );
                BatchUploadOutcome::Failed(UploadFailure::Other)
            }
            Err(e) => {
                let failure = match &e {
                    crate::network_log_transport::NetworkLogSendError {
                        transport: Some(failure),
                        ..
                    } => {
                        info!(
                            run_id = %self.run_id,
                            batch_index,
                            client_request_id = request_context.client_request_id.as_str(),
                            client_session_id = request_context.client_session_id.as_str(),
                            client_version = request_context.client_version.as_str(),
                            request_state = BatchRequestState::TransportFailure.as_str(),
                            failure_kind = failure.kind,
                            failure_cause = failure.cause,
                            error = %e,
                            "network logs upload failed"
                        );
                        UploadFailure::Transport { failure: *failure }
                    }
                    _ => {
                        warn!(
                            run_id = %self.run_id,
                            batch_index,
                            client_request_id = request_context.client_request_id.as_str(),
                            client_session_id = request_context.client_session_id.as_str(),
                            client_version = request_context.client_version.as_str(),
                            error = %e,
                            "network logs upload failed"
                        );
                        UploadFailure::Other
                    }
                };
                BatchUploadOutcome::Failed(failure)
            }
        };
        self.active_request = None;
        outcome
    }
}

fn empty_batch_estimated_bytes(run_id: &RunId) -> usize {
    NETWORK_LOG_UPLOAD_PAYLOAD_OVERHEAD_BYTES + run_id.to_string().len()
}

fn estimated_entry_bytes(line: &str) -> usize {
    line.len()
        .saturating_add(NETWORK_LOG_UPLOAD_ENTRY_OVERHEAD_BYTES)
}

async fn upload_rejection_details(mut resp: reqwest::Response) -> UploadRejectionDetails {
    let mut body = Vec::new();
    let mut body_truncated = false;

    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                let remaining = NETWORK_LOG_UPLOAD_ERROR_BODY_MAX_BYTES.saturating_sub(body.len());
                if chunk.len() > remaining {
                    if let Some(prefix) = chunk.get(..remaining) {
                        body.extend_from_slice(prefix);
                    }
                    body_truncated = true;
                    break;
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => {
                return UploadRejectionDetails {
                    body_read_error: Some(truncate_log_field(e.to_string())),
                    ..Default::default()
                };
            }
        }
    }

    parse_upload_rejection_body(&body, body_truncated)
}

fn parse_upload_rejection_body(body: &[u8], body_truncated: bool) -> UploadRejectionDetails {
    let Ok(api_error) = serde_json::from_slice::<ApiErrorEnvelope>(body) else {
        return UploadRejectionDetails {
            body_truncated,
            ..Default::default()
        };
    };

    UploadRejectionDetails {
        error_code: api_error.error.code.map(truncate_log_field),
        error_message: api_error.error.message.map(truncate_log_field),
        body_truncated,
        body_read_error: None,
    }
}

fn truncate_log_field(value: String) -> String {
    let mut truncated = String::new();
    for (index, ch) in value.chars().enumerate() {
        if index == NETWORK_LOG_UPLOAD_ERROR_FIELD_MAX_CHARS {
            truncated.push_str("...");
            return truncated;
        }
        truncated.push(ch);
    }
    value
}

#[cfg(test)]
mod test_http;

#[cfg(test)]
mod tests;
