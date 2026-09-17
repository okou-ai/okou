//! Shared CLI event delivery worker and acknowledgement state.
//!
//! Event schema transformation stays in `events`, while HTTP retry policy stays
//! in `http`. This module owns bounded non-blocking admission, serial FIFO
//! batching, and the bounded progress snapshot shared by CLI backends. A batch
//! is one retry/failure unit, and acknowledgement remains the highest
//! contiguous successful sequence.

use crate::error::AgentError;
use crate::events;
use crate::http::{HttpAttemptFinished, HttpAttemptObserver, HttpAttemptStarted, HttpClient};
use crate::masker::SecretMasker;
use bytes::Bytes;
use guest_contracts::diagnostics::{
    EventDeliveryAcceptanceOutcome, EventDeliveryActiveAttemptDiagnostic,
    EventDeliveryActiveBatchDiagnostic, EventDeliveryDiagnostic,
    EventDeliveryDrainTimeoutDiagnostic, EventDeliveryFailedBatchDiagnostic,
    HttpAttemptFailureKind, HttpCompletedAttemptDiagnostic,
};
use guest_telemetry::{log_info, log_warn};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use tokio::task::JoinHandle;

use super::LOG_TAG;

const EVENT_DELIVERY_QUEUE_CAPACITY: usize = 512;
const EVENT_DELIVERY_MAX_BYTES: usize = 16 * 1024 * 1024;
const EVENT_DELIVERY_MAX_REQUEST_EVENTS: usize = 32;
const EVENT_DELIVERY_MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const EVENT_DELIVERY_DRAIN_TIMEOUT: Duration = Duration::from_secs(120);

struct PreparedEvent {
    sequence: u32,
    event: Bytes,
    private_citation: Option<Bytes>,
    conservative_bytes: usize,
    byte_budget: OwnedSemaphorePermit,
}

pub(super) struct EventDeliverySender {
    tx: mpsc::Sender<PreparedEvent>,
    byte_budget: Arc<Semaphore>,
    pressure: Arc<DeliveryPressure>,
    payload_envelope: Arc<events::EventPayloadEnvelope>,
}

impl EventDeliverySender {
    /// Admit a canonical event, separating private metadata before masking keys.
    pub(super) fn try_send_for_framework(
        &self,
        sequence: u32,
        mut event: serde_json::Value,
        framework: crate::env::Framework,
        masker: &SecretMasker,
    ) -> Result<(), AgentError> {
        let private_citation = self
            .payload_envelope
            .take_private_citation(sequence, &mut event, masker)?;
        let event = events::prepare_event_for_delivery(event, sequence, masker);
        let framework = match framework {
            crate::env::Framework::ClaudeCode => {
                let serialized_event = serde_json::to_vec(&event)?;
                drop(event);
                return self.try_send_prepared(sequence, serialized_event, private_citation);
            }
            crate::env::Framework::Pi => super::bounded_event_delivery::Framework::Pi,
            crate::env::Framework::Codex => super::bounded_event_delivery::Framework::Codex,
        };
        let envelope_bytes = self
            .payload_envelope
            .singleton_bytes(0, private_citation.as_ref().map_or(0, Bytes::len));
        let budget = EVENT_DELIVERY_MAX_REQUEST_BYTES.saturating_sub(envelope_bytes);
        let prepared =
            super::bounded_event_delivery::prepare_for_delivery(event, budget, framework)?;
        self.try_send_prepared(sequence, prepared.serialized, private_citation)?;
        if let Some(reduction) = prepared.reduction {
            let framework = match framework {
                super::bounded_event_delivery::Framework::Pi => "Pi",
                super::bounded_event_delivery::Framework::Codex => "Codex",
            };
            log_info!(
                LOG_TAG,
                "{} event reduced for delivery: seq={} event_type={} item_type={} original_event_bytes={} delivered_event_bytes={} original_request_bytes={} delivered_request_bytes={} fields={} fallback={}",
                framework,
                sequence,
                reduction.event_type,
                reduction.item_type,
                reduction.original_bytes,
                reduction.delivered_bytes,
                envelope_bytes.saturating_add(reduction.original_bytes),
                envelope_bytes.saturating_add(reduction.delivered_bytes),
                reduction.fields.join(","),
                reduction.fallback,
            );
        }
        Ok(())
    }

    fn try_send_prepared(
        &self,
        sequence: u32,
        serialized_event: Vec<u8>,
        private_citation: Option<Bytes>,
    ) -> Result<(), AgentError> {
        let event = Bytes::from(serialized_event.into_boxed_slice());
        let conservative_bytes = self
            .payload_envelope
            .singleton_bytes(event.len(), private_citation.as_ref().map_or(0, Bytes::len));
        if conservative_bytes > EVENT_DELIVERY_MAX_REQUEST_BYTES {
            return Err(AgentError::Execution(format!(
                "CLI event delivery payload at sequence {sequence} is {conservative_bytes} bytes, exceeding the {EVENT_DELIVERY_MAX_REQUEST_BYTES}-byte request limit"
            )));
        }

        let available_bytes = self.byte_budget.available_permits();
        let byte_budget = Arc::clone(&self.byte_budget)
            .try_acquire_many_owned(conservative_bytes as u32)
            .map_err(|_| {
                AgentError::Execution(format!(
                    "CLI event delivery byte buffer exhausted at sequence {sequence}: payload is {conservative_bytes} bytes, {available_bytes} of {EVENT_DELIVERY_MAX_BYTES} bytes available, {} events pending",
                    self.pressure.pending_events()
                ))
            })?;
        let admission = self.pressure.begin_admission(conservative_bytes);
        let prepared = PreparedEvent {
            sequence,
            event,
            private_citation,
            conservative_bytes,
            byte_budget,
        };

        match self.tx.try_send(prepared) {
            Ok(()) => {
                self.pressure.confirm_admission(admission);
                Ok(())
            }
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.pressure.reject_admission(conservative_bytes);
                Err(AgentError::Execution(format!(
                    "CLI event delivery queue exceeded {EVENT_DELIVERY_QUEUE_CAPACITY} pending events at sequence {sequence}; {} bytes buffered",
                    self.pressure.buffered_bytes()
                )))
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.pressure.reject_admission(conservative_bytes);
                Err(AgentError::Execution(format!(
                    "CLI event delivery worker stopped before sequence {sequence} could be queued"
                )))
            }
        }
    }
}

#[derive(Debug)]
pub(super) struct EventDeliveryReport {
    pub(super) last_acknowledged_sequence: Option<u32>,
    pub(super) diagnostic: Option<EventDeliveryDiagnostic>,
}

pub(super) struct EventDeliveryRuntime {
    sender: EventDeliverySender,
    worker: JoinHandle<Result<(), AgentError>>,
    pressure: Arc<DeliveryPressure>,
    progress: Arc<Mutex<DeliveryProgress>>,
}

impl EventDeliveryRuntime {
    pub(super) fn start(
        http: HttpClient,
        run_id: &str,
        first_sequence: u32,
        pi_memory_citation_transport: bool,
    ) -> Result<Self, AgentError> {
        let (tx, event_rx) = mpsc::channel(EVENT_DELIVERY_QUEUE_CAPACITY);
        let pressure = Arc::new(DeliveryPressure::default());
        let progress = Arc::new(Mutex::new(DeliveryProgress::new(first_sequence)));
        let payload_envelope = Arc::new(events::EventPayloadEnvelope::new(
            run_id,
            pi_memory_citation_transport,
        )?);
        let sender = EventDeliverySender {
            tx,
            byte_budget: Arc::new(Semaphore::new(EVENT_DELIVERY_MAX_BYTES)),
            pressure: Arc::clone(&pressure),
            payload_envelope: Arc::clone(&payload_envelope),
        };
        let worker = tokio::spawn(run_event_sender(
            event_rx,
            http,
            payload_envelope,
            Arc::clone(&pressure),
            Arc::clone(&progress),
        ));
        Ok(Self {
            sender,
            worker,
            pressure,
            progress,
        })
    }

    pub(super) fn sender(&self) -> &EventDeliverySender {
        &self.sender
    }

    pub(super) async fn finish(self) -> Result<EventDeliveryReport, AgentError> {
        let Self {
            sender,
            mut worker,
            pressure,
            progress,
        } = self;
        drop(sender);
        let drain_start = pressure.snapshot();
        log_info!(
            LOG_TAG,
            "Event delivery drain started: pending_events={} queued_bytes={} buffered_bytes={}",
            drain_start.pending_events,
            drain_start.queued_bytes,
            drain_start.buffered_bytes
        );

        match tokio::time::timeout(EVENT_DELIVERY_DRAIN_TIMEOUT, &mut worker).await {
            Ok(Ok(Ok(()))) => Ok(progress_report(&progress, None)),
            Ok(Ok(Err(error))) => Err(AgentError::Execution(format!(
                "CLI event delivery worker failed: {error}"
            ))),
            Ok(Err(error)) => Err(AgentError::Execution(format!(
                "CLI event delivery worker failed: {error}"
            ))),
            Err(_) => {
                // Freeze both independently updated state holders before
                // composing one deadline snapshot. The active request context
                // lives in shared progress and survives cancellation.
                worker.abort();
                let _ = worker.await;
                let pressure_snapshot = pressure.snapshot();
                let report = progress_report(&progress, Some(pressure_snapshot));
                log_warn!(
                    LOG_TAG,
                    "CLI event delivery did not drain within {} seconds: {} events queued, {} queued bytes, {} bytes buffered",
                    EVENT_DELIVERY_DRAIN_TIMEOUT.as_secs(),
                    pressure_snapshot.pending_events,
                    pressure_snapshot.queued_bytes,
                    pressure_snapshot.buffered_bytes
                );
                Ok(report)
            }
        }
    }

    pub(super) async fn abort(self) -> EventDeliveryReport {
        let Self {
            sender,
            worker,
            pressure: _,
            progress,
        } = self;
        drop(sender);
        worker.abort();
        let _ = worker.await;
        progress_report(&progress, None)
    }
}

#[derive(Clone, Copy)]
struct AdmissionPressure {
    pending_events: usize,
    buffered_bytes: usize,
}

#[derive(Clone, Copy)]
struct DeliveryPressureSnapshot {
    pending_events: usize,
    queued_bytes: usize,
    buffered_bytes: usize,
    max_pending_events: usize,
    max_buffered_bytes: usize,
}

#[derive(Default)]
struct DeliveryPressure {
    pending_events: AtomicUsize,
    queued_bytes: AtomicUsize,
    buffered_bytes: AtomicUsize,
    max_pending_events: AtomicUsize,
    max_buffered_bytes: AtomicUsize,
}

impl DeliveryPressure {
    fn begin_admission(&self, bytes: usize) -> AdmissionPressure {
        self.queued_bytes.fetch_add(bytes, Ordering::Relaxed);
        AdmissionPressure {
            pending_events: self.pending_events.fetch_add(1, Ordering::Relaxed) + 1,
            buffered_bytes: self.buffered_bytes.fetch_add(bytes, Ordering::Relaxed) + bytes,
        }
    }

    fn confirm_admission(&self, admission: AdmissionPressure) {
        self.max_pending_events
            .fetch_max(admission.pending_events, Ordering::Relaxed);
        self.max_buffered_bytes
            .fetch_max(admission.buffered_bytes, Ordering::Relaxed);
    }

    fn reject_admission(&self, bytes: usize) {
        self.pending_events.fetch_sub(1, Ordering::Relaxed);
        self.queued_bytes.fetch_sub(bytes, Ordering::Relaxed);
        self.buffered_bytes.fetch_sub(bytes, Ordering::Relaxed);
    }

    fn mark_dequeued(&self, bytes: usize) {
        self.pending_events.fetch_sub(1, Ordering::Relaxed);
        self.queued_bytes.fetch_sub(bytes, Ordering::Relaxed);
    }

    fn release_bytes(&self, bytes: usize) {
        self.buffered_bytes.fetch_sub(bytes, Ordering::Relaxed);
    }

    fn pending_events(&self) -> usize {
        self.pending_events.load(Ordering::Relaxed)
    }

    fn buffered_bytes(&self) -> usize {
        self.buffered_bytes.load(Ordering::Relaxed)
    }

    fn snapshot(&self) -> DeliveryPressureSnapshot {
        DeliveryPressureSnapshot {
            pending_events: self.pending_events(),
            queued_bytes: self.queued_bytes.load(Ordering::Relaxed),
            buffered_bytes: self.buffered_bytes(),
            max_pending_events: self.max_pending_events.load(Ordering::Relaxed),
            max_buffered_bytes: self.max_buffered_bytes.load(Ordering::Relaxed),
        }
    }
}

#[derive(Default)]
struct AckedEventPrefix {
    next_expected: u32,
    last_contiguous: Option<u32>,
    prefix_broken: bool,
}

impl AckedEventPrefix {
    fn new(next_expected: u32) -> Self {
        Self {
            next_expected,
            last_contiguous: next_expected.checked_sub(1),
            prefix_broken: false,
        }
    }

    fn record_success(&mut self, sequence: u32) {
        if self.prefix_broken {
            return;
        }

        if sequence == self.next_expected {
            self.last_contiguous = Some(sequence);
            self.next_expected = sequence.saturating_add(1);
        } else if sequence > self.next_expected {
            self.prefix_broken = true;
        }
    }

    fn record_failure(&mut self, sequence: u32) {
        if sequence >= self.next_expected {
            self.prefix_broken = true;
        }
    }

    fn last_contiguous(&self) -> Option<u32> {
        self.last_contiguous
    }
}

#[derive(Default)]
struct DeliveryProgress {
    acked_prefix: AckedEventPrefix,
    total_events: u64,
    total_batches: u64,
    failed_batches: u64,
    max_batch_events: usize,
    max_batch_bytes: usize,
    first_failed_batch: Option<EventDeliveryFailedBatchDiagnostic>,
    active_batch: Option<ActiveBatchProgress>,
    carried_event_bytes: Option<usize>,
}

impl DeliveryProgress {
    fn new(first_sequence: u32) -> Self {
        Self {
            acked_prefix: AckedEventPrefix::new(first_sequence),
            ..Self::default()
        }
    }

    fn begin_batch(
        &mut self,
        sequences: Vec<u32>,
        first_sequence: u32,
        last_sequence: u32,
        conservative_bytes: usize,
        carried_event_bytes: Option<usize>,
    ) {
        let event_count = sequences.len();
        self.total_events = self.total_events.saturating_add(usize_to_u64(event_count));
        self.total_batches = self.total_batches.saturating_add(1);
        self.max_batch_events = self.max_batch_events.max(event_count);
        self.max_batch_bytes = self.max_batch_bytes.max(conservative_bytes);
        self.active_batch = Some(ActiveBatchProgress {
            sequences,
            first_sequence,
            last_sequence,
            conservative_bytes,
            completed_attempts: Vec::new(),
            active_attempt: None,
        });
        self.carried_event_bytes = carried_event_bytes;
    }

    fn finish_batch(&mut self, succeeded: bool) -> Result<(), AgentError> {
        let active_batch = self.active_batch.take().ok_or_else(|| {
            AgentError::Execution(
                "event delivery batch state disappeared before completion".to_string(),
            )
        })?;
        if succeeded {
            for sequence in active_batch.sequences {
                self.acked_prefix.record_success(sequence);
            }
            return Ok(());
        }

        self.acked_prefix
            .record_failure(active_batch.first_sequence);
        self.failed_batches = self.failed_batches.saturating_add(1);
        if self.first_failed_batch.is_none() {
            let event_count = usize_to_u32(active_batch.sequences.len());
            let conservative_bytes = usize_to_u64(active_batch.conservative_bytes);
            let attempts = active_batch.completed_attempts;
            let outcome = acceptance_outcome(&attempts);
            self.first_failed_batch = Some(EventDeliveryFailedBatchDiagnostic {
                first_sequence: active_batch.first_sequence,
                last_sequence: active_batch.last_sequence,
                event_count,
                conservative_bytes,
                outcome,
                attempts,
            });
        }
        Ok(())
    }
}

struct ActiveBatchProgress {
    sequences: Vec<u32>,
    first_sequence: u32,
    last_sequence: u32,
    conservative_bytes: usize,
    completed_attempts: Vec<HttpCompletedAttemptDiagnostic>,
    active_attempt: Option<HttpAttemptStarted>,
}

struct DeliveryAttemptObserver {
    progress: Arc<Mutex<DeliveryProgress>>,
}

impl HttpAttemptObserver for DeliveryAttemptObserver {
    fn attempt_started(&self, attempt: HttpAttemptStarted) -> Result<(), AgentError> {
        let mut progress = progress_guard(&self.progress);
        let active_batch = progress.active_batch.as_mut().ok_or_else(|| {
            AgentError::Execution(
                "event delivery batch state missing before HTTP attempt".to_string(),
            )
        })?;
        active_batch.active_attempt = Some(attempt);
        Ok(())
    }

    fn attempt_finished(&self, attempt: HttpAttemptFinished) -> Result<(), AgentError> {
        let mut progress = progress_guard(&self.progress);
        let active_batch = progress.active_batch.as_mut().ok_or_else(|| {
            AgentError::Execution(
                "event delivery batch state missing after HTTP attempt".to_string(),
            )
        })?;
        active_batch.active_attempt = None;
        if let Some(diagnostic) = attempt.into_failure_diagnostic() {
            active_batch.completed_attempts.push(diagnostic);
        }
        Ok(())
    }
}

async fn run_event_sender(
    mut event_rx: mpsc::Receiver<PreparedEvent>,
    http: HttpClient,
    payload_envelope: Arc<events::EventPayloadEnvelope>,
    pressure: Arc<DeliveryPressure>,
    progress: Arc<Mutex<DeliveryProgress>>,
) -> Result<(), AgentError> {
    let observer = DeliveryAttemptObserver {
        progress: Arc::clone(&progress),
    };
    let mut carried_event = None;

    loop {
        let first_event = match carried_event.take() {
            Some(event) => event,
            None => {
                let Some(event) = event_rx.recv().await else {
                    break;
                };
                pressure.mark_dequeued(event.conservative_bytes);
                event
            }
        };
        let first_sequence = first_event.sequence;
        let (batch, next_carried_event) = collect_batch(first_event, &mut event_rx, &pressure);
        let last_sequence = batch.last().map_or(first_sequence, |event| event.sequence);
        carried_event = next_carried_event;
        let EventBatch {
            sequences,
            payload,
            conservative_bytes,
            byte_budgets,
        } = EventBatch::new(batch, &payload_envelope);
        let event_count = sequences.len();
        progress_guard(&progress).begin_batch(
            sequences.clone(),
            first_sequence,
            last_sequence,
            conservative_bytes,
            carried_event.as_ref().map(|event| event.conservative_bytes),
        );

        let send_result = events::post_serialized_event(&http, payload, &observer).await;
        drop(byte_budgets);
        pressure.release_bytes(conservative_bytes);
        progress_guard(&progress).finish_batch(send_result.is_ok())?;

        let succeeded = send_result.is_ok();
        log_info!(
            LOG_TAG,
            "Event delivery request: first_sequence={first_sequence} last_sequence={last_sequence} events={event_count} conservative_bytes={conservative_bytes} result={} queued_events_remaining={}",
            if succeeded { "success" } else { "failure" },
            pressure.pending_events() + usize::from(carried_event.is_some())
        );

        if let Err(error) = send_result {
            log_warn!(
                LOG_TAG,
                "Event send failed for sequences {first_sequence}-{last_sequence}: {error}"
            );
        }
    }

    let pressure = pressure.snapshot();
    let progress = progress_guard(&progress);
    log_info!(
        LOG_TAG,
        "Event delivery complete: events={} requests={} failed_requests={} max_batch_events={} max_batch_bytes={} max_pending_events={} max_buffered_bytes={} last_contiguous_sequence={:?}",
        progress.total_events,
        progress.total_batches,
        progress.failed_batches,
        progress.max_batch_events,
        progress.max_batch_bytes,
        pressure.max_pending_events,
        pressure.max_buffered_bytes,
        progress.acked_prefix.last_contiguous()
    );
    Ok(())
}

fn collect_batch(
    first_event: PreparedEvent,
    event_rx: &mut mpsc::Receiver<PreparedEvent>,
    pressure: &DeliveryPressure,
) -> (Vec<PreparedEvent>, Option<PreparedEvent>) {
    let mut conservative_bytes = first_event.conservative_bytes;
    let mut batch = Vec::with_capacity(EVENT_DELIVERY_MAX_REQUEST_EVENTS);
    batch.push(first_event);

    while batch.len() < EVENT_DELIVERY_MAX_REQUEST_EVENTS {
        let next_event = match event_rx.try_recv() {
            Ok(event) => {
                pressure.mark_dequeued(event.conservative_bytes);
                event
            }
            Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected) => {
                break;
            }
        };
        if next_event.conservative_bytes > EVENT_DELIVERY_MAX_REQUEST_BYTES - conservative_bytes {
            return (batch, Some(next_event));
        }
        conservative_bytes += next_event.conservative_bytes;
        batch.push(next_event);
    }

    (batch, None)
}

struct EventBatch {
    sequences: Vec<u32>,
    payload: Bytes,
    conservative_bytes: usize,
    byte_budgets: Vec<OwnedSemaphorePermit>,
}

impl EventBatch {
    fn new(events: Vec<PreparedEvent>, payload_envelope: &events::EventPayloadEnvelope) -> Self {
        let mut sequences = Vec::with_capacity(events.len());
        let mut event_bytes = Vec::with_capacity(events.len());
        let mut private_citations = Vec::new();
        let mut conservative_bytes = 0usize;
        let mut byte_budgets = Vec::with_capacity(events.len());

        for event in events {
            sequences.push(event.sequence);
            event_bytes.push(event.event);
            if let Some(citation) = event.private_citation {
                private_citations.push(citation);
            }
            conservative_bytes += event.conservative_bytes;
            byte_budgets.push(event.byte_budget);
        }

        Self {
            sequences,
            payload: payload_envelope.payload(&event_bytes, &private_citations),
            conservative_bytes,
            byte_budgets,
        }
    }
}

fn progress_report(
    progress: &Arc<Mutex<DeliveryProgress>>,
    drain_pressure: Option<DeliveryPressureSnapshot>,
) -> EventDeliveryReport {
    let progress = progress_guard(progress);
    let last_acknowledged_sequence = progress.acked_prefix.last_contiguous();
    let drain_timeout = drain_pressure.map(|pressure| EventDeliveryDrainTimeoutDiagnostic {
        queued_events: usize_to_u32(pressure.pending_events),
        queued_bytes: usize_to_u64(pressure.queued_bytes),
        carried_events: u32::from(progress.carried_event_bytes.is_some()),
        carried_bytes: progress.carried_event_bytes.map_or(0, usize_to_u64),
        active_batch: progress.active_batch.as_ref().map(active_batch_diagnostic),
    });
    let has_failure = progress.first_failed_batch.is_some() || drain_timeout.is_some();
    let diagnostic = has_failure.then(|| EventDeliveryDiagnostic {
        total_events: progress.total_events,
        total_batches: progress.total_batches,
        failed_batches: progress.failed_batches,
        last_acknowledged_sequence,
        first_failed_batch: progress.first_failed_batch.clone(),
        drain_timeout,
    });
    EventDeliveryReport {
        last_acknowledged_sequence,
        diagnostic,
    }
}

fn active_batch_diagnostic(active: &ActiveBatchProgress) -> EventDeliveryActiveBatchDiagnostic {
    EventDeliveryActiveBatchDiagnostic {
        first_sequence: active.first_sequence,
        last_sequence: active.last_sequence,
        event_count: usize_to_u32(active.sequences.len()),
        conservative_bytes: usize_to_u64(active.conservative_bytes),
        completed_attempts: active.completed_attempts.clone(),
        active_attempt: active.active_attempt.as_ref().map(|attempt| {
            EventDeliveryActiveAttemptDiagnostic {
                attempt: attempt.attempt,
                client_request_id: attempt.client_request_id.clone(),
                elapsed_ms: u64::try_from(attempt.started_at.elapsed().as_millis())
                    .unwrap_or(u64::MAX),
            }
        }),
        outcome: EventDeliveryAcceptanceOutcome::OutcomeUnknown,
    }
}

fn acceptance_outcome(
    attempts: &[HttpCompletedAttemptDiagnostic],
) -> EventDeliveryAcceptanceOutcome {
    if !attempts.is_empty()
        && attempts
            .iter()
            .all(|attempt| attempt.failure_kind == HttpAttemptFailureKind::HttpStatus)
    {
        EventDeliveryAcceptanceOutcome::ConfirmedRejection
    } else {
        EventDeliveryAcceptanceOutcome::OutcomeUnknown
    }
}

fn progress_guard(
    progress: &Arc<Mutex<DeliveryProgress>>,
) -> std::sync::MutexGuard<'_, DeliveryProgress> {
    progress
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn usize_to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn usize_to_u64(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acked_event_prefix_advances_on_contiguous_successes() {
        let mut prefix = AckedEventPrefix::default();

        prefix.record_success(0);
        prefix.record_success(1);
        prefix.record_success(2);

        assert_eq!(prefix.last_contiguous(), Some(2));
    }

    #[test]
    fn acked_event_prefix_stops_at_first_failed_event() {
        let mut prefix = AckedEventPrefix::default();

        prefix.record_success(0);
        prefix.record_failure(1);
        prefix.record_success(2);

        assert_eq!(prefix.last_contiguous(), Some(0));
    }

    #[test]
    fn acked_event_prefix_has_no_watermark_when_first_event_fails() {
        let mut prefix = AckedEventPrefix::default();

        prefix.record_failure(0);
        prefix.record_success(1);

        assert_eq!(prefix.last_contiguous(), None);
    }

    #[test]
    fn acked_event_prefix_rejects_success_gap() {
        let mut prefix = AckedEventPrefix::default();

        prefix.record_success(0);
        prefix.record_success(2);
        prefix.record_success(3);

        assert_eq!(prefix.last_contiguous(), Some(0));
    }
}
