//! Bounded observation only; no byte ownership, transport policy or retry logic.
//! Windows and aggregate durations are exported at millisecond precision;
//! measured sub-millisecond work can therefore round down to zero.

use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use runner_storage::OBJECT_DOWNLOAD_MAX_ATTEMPTS;

use super::session_history_download::SessionHistoryDownloadTimings;
use crate::duration::duration_ms;
use crate::telemetry::{
    JobTelemetry, SessionHistoryDownloadFields, SessionHistoryDownloadRecord,
    SessionHistoryObservationStage, SessionHistoryResponseTelemetryMetadata,
};

#[derive(Clone, Copy, Debug)]
pub(super) struct HistoryTimingWindow {
    pub start: Instant,
    pub end: Instant,
}

impl HistoryTimingWindow {
    pub fn new(start: Instant, end: Instant) -> Self {
        Self { start, end }
    }

    pub fn elapsed(self) -> Duration {
        self.end.saturating_duration_since(self.start)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum HistoryAttemptOutcome {
    Succeeded,
    Failed,
    Interrupted,
}

impl HistoryAttemptOutcome {
    fn value(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
        }
    }
}

#[derive(Clone, Copy)]
pub(super) enum HistoryMaterializationOutcome {
    Succeeded,
    Failed,
    Cancelled,
}

impl HistoryMaterializationOutcome {
    fn value(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) struct HistoryAttemptTiming {
    pub window: HistoryTimingWindow,
    pub request: Option<HistoryTimingWindow>,
    pub body: Option<HistoryTimingWindow>,
    pub outcome: HistoryAttemptOutcome,
    pub chunk_wait: Duration,
    pub chunk_wait_max: Duration,
    pub chunks: u32,
    pub copy: Duration,
    pub allocation: Option<Duration>,
    pub response: Option<SessionHistoryResponseTelemetryMetadata>,
}

impl HistoryAttemptTiming {
    pub fn new(start: Instant) -> Self {
        Self {
            window: HistoryTimingWindow::new(start, start),
            request: None,
            body: None,
            outcome: HistoryAttemptOutcome::Interrupted,
            chunk_wait: Duration::ZERO,
            chunk_wait_max: Duration::ZERO,
            chunks: 0,
            copy: Duration::ZERO,
            allocation: None,
            response: None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) struct SessionHistoryDownloadAttribution {
    pub origin: Instant,
    wall_origin: DateTime<Utc>,
    pub attempts: [Option<HistoryAttemptTiming>; OBJECT_DOWNLOAD_MAX_ATTEMPTS],
    pub backoff: Duration,
    pub cpu_admission: Option<HistoryTimingWindow>,
    pub cpu_queue: Option<HistoryTimingWindow>,
}

impl SessionHistoryDownloadAttribution {
    pub fn new(origin: Instant) -> Self {
        Self {
            origin,
            wall_origin: Utc::now(),
            attempts: [None; OBJECT_DOWNLOAD_MAX_ATTEMPTS],
            backoff: Duration::ZERO,
            cpu_admission: None,
            cpu_queue: None,
        }
    }

    fn offset(self, at: Instant) -> u64 {
        duration_ms(at.saturating_duration_since(self.origin))
    }

    fn completed_at(self, at: Instant) -> Option<DateTime<Utc>> {
        let elapsed = at.saturating_duration_since(self.origin);
        chrono::Duration::from_std(elapsed)
            .ok()
            .and_then(|elapsed| self.wall_origin.checked_add_signed(elapsed))
    }

    fn fields(self) -> Option<SessionHistoryDownloadFields> {
        Some(SessionHistoryDownloadFields {
            session_history_timing_origin_unix_ms: u64::try_from(
                self.wall_origin.timestamp_millis(),
            )
            .ok()?,
            ..Default::default()
        })
    }

    pub fn attempt_record(
        self,
        index: usize,
        attempt: HistoryAttemptTiming,
    ) -> Option<SessionHistoryDownloadRecord> {
        let mut fields = self.fields()?;
        fields.session_history_download_attempt = Some(index as u32 + 1);
        if let Some(request) = attempt.request {
            fields.session_history_request_start_offset_ms = Some(self.offset(request.start));
            fields.session_history_request_end_offset_ms = Some(self.offset(request.end));
        }
        if let Some(body) = attempt.body {
            fields.session_history_body_start_offset_ms = Some(self.offset(body.start));
            fields.session_history_body_end_offset_ms = Some(self.offset(body.end));
            // Wait includes the terminal EOF/error/interrupted await; chunk
            // count includes only data chunks actually copied into the buffer.
            fields.session_history_chunk_wait_ms = Some(duration_ms(attempt.chunk_wait));
            fields.session_history_chunk_wait_max_ms = Some(duration_ms(attempt.chunk_wait_max));
            fields.session_history_chunk_count = Some(attempt.chunks);
            fields.session_history_body_copy_ms = Some(duration_ms(attempt.copy));
        }
        fields.session_history_body_allocation_ms = attempt.allocation.map(duration_ms);
        Some(SessionHistoryDownloadRecord {
            action_type: "session_history_download_attempt",
            duration: attempt.window.elapsed(),
            success: attempt.outcome == HistoryAttemptOutcome::Succeeded,
            outcome: attempt.outcome.value(),
            completed_at: self.completed_at(attempt.window.end)?,
            fields,
        })
    }

    pub fn summary_record(
        self,
        observation: HistoryMaterializationObservation,
    ) -> Option<SessionHistoryDownloadRecord> {
        let mut fields = self.fields()?;
        fields.session_history_observation_stage = Some(observation.stage);
        let attempts = self.attempts.iter().flatten().count() as u32;
        fields.session_history_attempt_count = Some(attempts);
        fields.session_history_failed_attempt_count = Some(
            self.attempts
                .iter()
                .flatten()
                .filter(|attempt| attempt.outcome == HistoryAttemptOutcome::Failed)
                .count() as u32,
        );
        fields.session_history_interrupted_attempt_count = Some(
            self.attempts
                .iter()
                .flatten()
                .filter(|attempt| attempt.outcome == HistoryAttemptOutcome::Interrupted)
                .count() as u32,
        );
        fields.session_history_retry_count = Some(attempts.saturating_sub(1));
        fields.session_history_retry_backoff_ms = Some(duration_ms(self.backoff));
        if let Some(window) = self.cpu_admission {
            fields.session_history_cpu_admission_start_offset_ms = Some(self.offset(window.start));
            fields.session_history_cpu_admission_end_offset_ms = Some(self.offset(window.end));
        }
        if let Some(window) = self.cpu_queue {
            fields.session_history_cpu_queue_start_offset_ms = Some(self.offset(window.start));
            fields.session_history_cpu_queue_end_offset_ms = Some(self.offset(window.end));
        }
        if observation.stage == SessionHistoryObservationStage::Restore {
            fields.session_history_restore_wait_start_offset_ms =
                Some(self.offset(observation.window.start));
            fields.session_history_restore_wait_end_offset_ms =
                Some(self.offset(observation.window.end));
        }
        Some(SessionHistoryDownloadRecord {
            action_type: "session_history_download_attribution",
            // Materializer lifetime through the restore barrier, including
            // overlapped preparation; this is not additional startup cost.
            duration: observation
                .window
                .end
                .saturating_duration_since(self.origin),
            success: matches!(
                observation.outcome,
                HistoryMaterializationOutcome::Succeeded
            ),
            outcome: observation.outcome.value(),
            completed_at: self.completed_at(observation.window.end)?,
            fields,
        })
    }
}

pub(super) struct HistoryMaterializationObservation {
    pub window: HistoryTimingWindow,
    pub stage: SessionHistoryObservationStage,
    pub outcome: HistoryMaterializationOutcome,
}

pub(super) fn record_download_attribution(
    telemetry: &mut JobTelemetry,
    timings: &SessionHistoryDownloadTimings,
    observation: HistoryMaterializationObservation,
) {
    let Some(attribution) = timings.attribution() else {
        return;
    };
    for (index, attempt) in attribution.attempts.iter().enumerate() {
        if let Some(attempt) = attempt
            && let Some(record) = attribution.attempt_record(index, *attempt)
        {
            let metadata = timings.metadata().map(|metadata| {
                let metadata = metadata.without_response();
                match attempt.response {
                    Some(response) => metadata.with_response(response),
                    None => metadata,
                }
            });
            telemetry.record_session_history_download_attribution(record, metadata);
        }
    }
    if let Some(record) = attribution.summary_record(observation) {
        telemetry.record_session_history_download_attribution(record, timings.metadata());
    }
}
