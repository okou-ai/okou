//! Shared CLI event delivery worker and acknowledgement state.
//!
//! Event schema transformation stays in `events`, while HTTP retry policy stays
//! in `http`. This module owns oldest-first eviction, serial FIFO batching,
//! continued retries during execution, and bounded final draining. Acknowledgement
//! records the highest successful sequence, allowing gaps after discarded events.

use crate::error::AgentError;
use crate::events;
use crate::http::{HttpAttemptFinished, HttpAttemptObserver, HttpAttemptStarted, HttpClient};
use crate::masker::SecretMasker;
use bytes::Bytes;
use guest_contracts::diagnostics::{
    EventDeliveryActiveAttemptDiagnostic, EventDeliveryActiveBatchDiagnostic,
    EventDeliveryDiagnostic, EventDeliveryDrainTimeoutDiagnostic,
    EventDeliveryFailedBatchDiagnostic, EventDeliveryResponseState, HttpAttemptFailureKind,
    HttpCompletedAttemptDiagnostic,
};
use guest_telemetry::{log_info, log_warn};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};
use tokio_util::task::AbortOnDropHandle;

use super::LOG_TAG;
use super::record_labels::EventLabels;

const EVENT_DELIVERY_QUEUE_CAPACITY: usize = 512;
const EVENT_DELIVERY_MAX_BYTES: usize = 32 * 1024 * 1024;
const EVENT_DELIVERY_MAX_REQUEST_EVENTS: usize = 32;
const EVENT_DELIVERY_MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const EVENT_DELIVERY_DRAIN_TIMEOUT: Duration = Duration::from_secs(120);
const EVENT_DELIVERY_MAX_RETRY_DELAY: Duration = Duration::from_secs(30);
const EVENT_DELIVERY_RETAINED_ATTEMPTS: usize = 3;

struct PreparedEvent {
    sequence: u32,
    event: Bytes,
    conservative_bytes: usize,
    labels: EventLabels,
    byte_budget: OwnedSemaphorePermit,
}

pub(super) struct EventDeliverySender {
    queue: Arc<EventQueue>,
    byte_budget: Arc<Semaphore>,
    pressure: Arc<DeliveryPressure>,
    payload_envelope: Arc<events::EventPayloadEnvelope>,
}

#[derive(Default)]
struct EventQueue {
    pending: Mutex<VecDeque<PreparedEvent>>,
    ready: Notify,
    closed: AtomicBool,
    dropped_events: AtomicUsize,
}

impl EventQueue {
    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.ready.notify_one();
    }

    async fn next(&self, pressure: &DeliveryPressure) -> Option<(PreparedEvent, usize)> {
        loop {
            let ready = self.ready.notified();
            {
                let mut pending = self
                    .pending
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(event) = pending.pop_front() {
                    pressure.mark_dequeued(event.conservative_bytes);
                    // Pair the retry generation with dequeue under the eviction lock.
                    return Some((event, self.dropped_events.load(Ordering::Relaxed)));
                }
                if self.closed.load(Ordering::Acquire) {
                    return None;
                }
            }
            ready.await;
        }
    }
}

impl EventDeliverySender {
    /// Mask and admit a canonical event within the delivery byte budget.
    pub(super) fn try_send_for_framework(
        &self,
        sequence: u32,
        event: serde_json::Value,
        framework: crate::env::Framework,
        masker: &SecretMasker,
    ) -> Result<(), AgentError> {
        let event = events::prepare_event_for_delivery(event, sequence, masker);
        let framework = match framework {
            crate::env::Framework::ClaudeCode => {
                super::bounded_event_delivery::Framework::ClaudeCode
            }
            crate::env::Framework::Pi => super::bounded_event_delivery::Framework::Pi,
            crate::env::Framework::Codex => super::bounded_event_delivery::Framework::Codex,
        };
        let envelope_bytes = self.payload_envelope.singleton_bytes(0);
        let budget = EVENT_DELIVERY_MAX_REQUEST_BYTES.saturating_sub(envelope_bytes);
        let prepared =
            super::bounded_event_delivery::prepare_for_delivery(event, budget, framework)?;
        let Some(super::bounded_event_delivery::PreparedEvent {
            serialized,
            labels,
            reduction,
        }) = prepared
        else {
            log_warn!(
                LOG_TAG,
                "Discarding oversized {} event at sequence {sequence}: no safe representation fits the {EVENT_DELIVERY_MAX_REQUEST_BYTES}-byte request limit",
                framework.label(),
            );
            return Ok(());
        };
        self.try_send_prepared(sequence, serialized, labels)?;
        if let Some(reduction) = reduction {
            log_info!(
                LOG_TAG,
                "{} event reduced for delivery: seq={} event_type={} item_type={} original_event_bytes={} delivered_event_bytes={} original_request_bytes={} delivered_request_bytes={} fields={} fallback={}",
                framework.label(),
                sequence,
                labels.event_type,
                labels.item_type,
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
        labels: EventLabels,
    ) -> Result<(), AgentError> {
        let event = Bytes::from(serialized_event.into_boxed_slice());
        let conservative_bytes = self.payload_envelope.singleton_bytes(event.len());
        if conservative_bytes > EVENT_DELIVERY_MAX_REQUEST_BYTES {
            log_warn!(
                LOG_TAG,
                "Discarding oversized CLI event at sequence {sequence}: {conservative_bytes} bytes exceeds the {EVENT_DELIVERY_MAX_REQUEST_BYTES}-byte request limit"
            );
            return Ok(());
        }

        let mut pending = self
            .queue
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.queue.closed.load(Ordering::Acquire) {
            return Err(AgentError::Execution(format!(
                "CLI event delivery worker stopped before sequence {sequence} could be queued"
            )));
        }
        let mut dropped_range = None;
        while pending.len() >= EVENT_DELIVERY_QUEUE_CAPACITY
            || self.byte_budget.available_permits() < conservative_bytes
        {
            let dropped = pending.pop_front().ok_or_else(|| {
                AgentError::Execution(
                    "CLI event delivery byte budget exhausted without queued events".to_string(),
                )
            })?;
            self.pressure.mark_dequeued(dropped.conservative_bytes);
            self.pressure.release_bytes(dropped.conservative_bytes);
            self.queue.dropped_events.fetch_add(1, Ordering::Relaxed);
            let (first, _) = dropped_range.get_or_insert((dropped.sequence, dropped.sequence));
            dropped_range = Some((*first, dropped.sequence));
            drop(dropped);
        }
        let byte_budget = Arc::clone(&self.byte_budget)
            .try_acquire_many_owned(conservative_bytes as u32)
            .map_err(|_| {
                AgentError::Execution("CLI event delivery byte reservation failed".to_string())
            })?;
        let admission = self.pressure.begin_admission(conservative_bytes);
        let prepared = PreparedEvent {
            sequence,
            event,
            conservative_bytes,
            labels,
            byte_budget,
        };

        pending.push_back(prepared);
        self.pressure.confirm_admission(admission);
        drop(pending);
        self.queue.ready.notify_one();
        if let Some((first, last)) = dropped_range {
            log_warn!(
                LOG_TAG,
                "Discarded oldest queued events {first}-{last} to admit sequence {sequence} within the event delivery memory limits"
            );
        }
        Ok(())
    }
}

#[derive(Debug)]
pub(super) struct EventDeliveryReport {
    pub(super) last_acknowledged_sequence: Option<u32>,
    pub(super) diagnostic: Option<EventDeliveryDiagnostic>,
}

pub(super) struct EventDeliveryRuntime {
    sender: EventDeliverySender,
    worker: AbortOnDropHandle<Result<(), AgentError>>,
    pressure: Arc<DeliveryPressure>,
    progress: Arc<Mutex<DeliveryProgress>>,
}

impl EventDeliveryRuntime {
    pub(super) fn start(http: HttpClient, run_id: &str) -> Result<Self, AgentError> {
        let queue = Arc::new(EventQueue::default());
        let pressure = Arc::new(DeliveryPressure::default());
        let progress = Arc::new(Mutex::new(DeliveryProgress::default()));
        let payload_envelope = Arc::new(events::EventPayloadEnvelope::new(run_id)?);
        let sender = EventDeliverySender {
            queue: Arc::clone(&queue),
            byte_budget: Arc::new(Semaphore::new(EVENT_DELIVERY_MAX_BYTES)),
            pressure: Arc::clone(&pressure),
            payload_envelope: Arc::clone(&payload_envelope),
        };
        let worker = AbortOnDropHandle::new(tokio::spawn(run_event_sender(
            queue,
            http,
            payload_envelope,
            Arc::clone(&pressure),
            Arc::clone(&progress),
        )));
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
        sender.queue.close();
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
        sender.queue.close();
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
struct DeliveryProgress {
    last_acknowledged_sequence: Option<u32>,
    total_events: u64,
    total_batches: u64,
    failed_batches: u64,
    max_batch_events: usize,
    max_batch_bytes: usize,
    first_failed_batch: Option<EventDeliveryFailedBatchDiagnostic>,
    active_batch: Option<ActiveBatchProgress>,
}

impl DeliveryProgress {
    fn begin_batch(
        &mut self,
        sequences: Vec<u32>,
        first_sequence: u32,
        last_sequence: u32,
        conservative_bytes: usize,
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
            attempt_count: 0,
            transport_failure: false,
        });
    }

    fn finish_batch(&mut self, succeeded: bool) -> Result<(), AgentError> {
        let active_batch = self.active_batch.take().ok_or_else(|| {
            AgentError::Execution(
                "event delivery batch state disappeared before completion".to_string(),
            )
        })?;
        if succeeded {
            self.last_acknowledged_sequence = Some(
                self.last_acknowledged_sequence
                    .map_or(active_batch.last_sequence, |previous| {
                        previous.max(active_batch.last_sequence)
                    }),
            );
            return Ok(());
        }

        self.failed_batches = self.failed_batches.saturating_add(1);
        if self.first_failed_batch.is_none() {
            let event_count = usize_to_u32(active_batch.sequences.len());
            let conservative_bytes = usize_to_u64(active_batch.conservative_bytes);
            let attempts = active_batch.completed_attempts;
            let response_state = if active_batch.transport_failure {
                EventDeliveryResponseState::Incomplete
            } else {
                response_state(&attempts)
            };
            self.first_failed_batch = Some(EventDeliveryFailedBatchDiagnostic {
                first_sequence: active_batch.first_sequence,
                last_sequence: active_batch.last_sequence,
                event_count,
                conservative_bytes,
                response_state,
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
    attempt_count: u32,
    transport_failure: bool,
}

struct DeliveryAttemptObserver {
    progress: Arc<Mutex<DeliveryProgress>>,
    queue: Arc<EventQueue>,
    drops_at_start: usize,
}

impl HttpAttemptObserver for DeliveryAttemptObserver {
    fn before_retry(&self) -> Result<(), AgentError> {
        if self.queue.dropped_events.load(Ordering::Relaxed) != self.drops_at_start {
            return Err(AgentError::Http(
                "event batch superseded after oldest-event eviction".to_string(),
            ));
        }
        Ok(())
    }

    fn attempt_started(&self, mut attempt: HttpAttemptStarted) -> Result<(), AgentError> {
        let mut progress = progress_guard(&self.progress);
        let active_batch = progress.active_batch.as_mut().ok_or_else(|| {
            AgentError::Execution(
                "event delivery batch state missing before HTTP attempt".to_string(),
            )
        })?;
        active_batch.attempt_count = active_batch.attempt_count.saturating_add(1);
        attempt.attempt = active_batch.attempt_count;
        active_batch.active_attempt = Some(attempt);
        Ok(())
    }

    fn attempt_finished(&self, mut attempt: HttpAttemptFinished) -> Result<(), AgentError> {
        let mut progress = progress_guard(&self.progress);
        let active_batch = progress.active_batch.as_mut().ok_or_else(|| {
            AgentError::Execution(
                "event delivery batch state missing after HTTP attempt".to_string(),
            )
        })?;
        active_batch.active_attempt = None;
        attempt.attempt = active_batch.attempt_count;
        if let Some(diagnostic) = attempt.into_failure_diagnostic() {
            active_batch.transport_failure |=
                diagnostic.failure_kind != HttpAttemptFailureKind::HttpStatus;
            if active_batch.completed_attempts.len() == EVENT_DELIVERY_RETAINED_ATTEMPTS {
                active_batch.completed_attempts.remove(0);
            }
            active_batch.completed_attempts.push(diagnostic);
        }
        Ok(())
    }
}

async fn run_event_sender(
    queue: Arc<EventQueue>,
    http: HttpClient,
    payload_envelope: Arc<events::EventPayloadEnvelope>,
    pressure: Arc<DeliveryPressure>,
    progress: Arc<Mutex<DeliveryProgress>>,
) -> Result<(), AgentError> {
    while let Some((first_event, drops_at_start)) = queue.next(&pressure).await {
        let first_sequence = first_event.sequence;
        let batch = collect_batch(first_event, &queue, &pressure);
        let last_sequence = batch.last().map_or(first_sequence, |event| event.sequence);
        let EventBatch {
            sequences,
            payload,
            conservative_bytes,
            labels,
            byte_budgets,
        } = EventBatch::new(batch, &payload_envelope);
        let event_count = sequences.len();
        progress_guard(&progress).begin_batch(
            sequences.clone(),
            first_sequence,
            last_sequence,
            conservative_bytes,
        );
        let observer = DeliveryAttemptObserver {
            progress: Arc::clone(&progress),
            queue: Arc::clone(&queue),
            drops_at_start,
        };

        let mut retry_cycle = 0u32;
        let send_result = loop {
            let result = events::post_serialized_event(&http, payload.clone(), &observer).await;
            let Err(error) = &result else {
                break result;
            };
            let terminal = matches!(error, AgentError::HttpStatus { status, .. } if (400..500).contains(status) && *status != 429);
            if terminal
                || queue.closed.load(Ordering::Acquire)
                || queue.dropped_events.load(Ordering::Relaxed) != drops_at_start
            {
                break result;
            }
            let delay = http
                .retry_delay()
                .saturating_mul(1u32 << retry_cycle.min(5))
                .min(EVENT_DELIVERY_MAX_RETRY_DELAY);
            retry_cycle = retry_cycle.saturating_add(1);
            log_warn!(
                LOG_TAG,
                "Retrying event batch {first_sequence}-{last_sequence} while CLI execution continues after upload failure: {error}"
            );
            tokio::time::sleep(delay).await;
            if queue.closed.load(Ordering::Acquire)
                || queue.dropped_events.load(Ordering::Relaxed) != drops_at_start
            {
                break result;
            }
        };
        {
            let _pending = queue
                .pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            drop(byte_budgets);
            pressure.release_bytes(conservative_bytes);
        }
        progress_guard(&progress).finish_batch(send_result.is_ok())?;

        let succeeded = send_result.is_ok();
        log_info!(
            LOG_TAG,
            "Event delivery request: first_sequence={first_sequence} last_sequence={last_sequence} events={event_count} conservative_bytes={conservative_bytes} event_type={} item_type={} result={} queued_events_remaining={}",
            labels.event_type,
            labels.item_type,
            if succeeded { "success" } else { "failure" },
            pressure.pending_events()
        );

        if let Err(error) = send_result {
            log_warn!(
                LOG_TAG,
                "Discarding event batch {first_sequence}-{last_sequence} after upload failure: {error}"
            );
        }
    }

    let pressure = pressure.snapshot();
    let progress = progress_guard(&progress);
    log_info!(
        LOG_TAG,
        "Event delivery complete: events={} requests={} failed_requests={} max_batch_events={} max_batch_bytes={} max_pending_events={} max_buffered_bytes={} last_acknowledged_sequence={:?} evicted_events={}",
        progress.total_events,
        progress.total_batches,
        progress.failed_batches,
        progress.max_batch_events,
        progress.max_batch_bytes,
        pressure.max_pending_events,
        pressure.max_buffered_bytes,
        progress.last_acknowledged_sequence,
        queue.dropped_events.load(Ordering::Relaxed)
    );
    Ok(())
}

fn collect_batch(
    first_event: PreparedEvent,
    queue: &EventQueue,
    pressure: &DeliveryPressure,
) -> Vec<PreparedEvent> {
    let mut conservative_bytes = first_event.conservative_bytes;
    let mut batch = Vec::with_capacity(EVENT_DELIVERY_MAX_REQUEST_EVENTS);
    batch.push(first_event);

    let mut pending = queue
        .pending
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    while batch.len() < EVENT_DELIVERY_MAX_REQUEST_EVENTS {
        let Some(next_event) = pending.pop_front() else {
            break;
        };
        if next_event.conservative_bytes > EVENT_DELIVERY_MAX_REQUEST_BYTES - conservative_bytes {
            pending.push_front(next_event);
            break;
        }
        pressure.mark_dequeued(next_event.conservative_bytes);
        conservative_bytes += next_event.conservative_bytes;
        batch.push(next_event);
    }

    batch
}

struct EventBatch {
    sequences: Vec<u32>,
    payload: Bytes,
    conservative_bytes: usize,
    /// Labels of the batch's largest event, which its bytes are dominated by.
    labels: EventLabels,
    byte_budgets: Vec<OwnedSemaphorePermit>,
}

impl EventBatch {
    fn new(events: Vec<PreparedEvent>, payload_envelope: &events::EventPayloadEnvelope) -> Self {
        let mut sequences = Vec::with_capacity(events.len());
        let mut event_bytes = Vec::with_capacity(events.len());
        let mut conservative_bytes = 0usize;
        let mut byte_budgets = Vec::with_capacity(events.len());
        let mut labels = EventLabels::UNKNOWN;
        let mut largest_event_bytes = 0usize;

        for event in events {
            sequences.push(event.sequence);
            event_bytes.push(event.event);
            conservative_bytes += event.conservative_bytes;
            if event.conservative_bytes > largest_event_bytes {
                largest_event_bytes = event.conservative_bytes;
                labels = event.labels;
            }
            byte_budgets.push(event.byte_budget);
        }

        Self {
            sequences,
            payload: payload_envelope.payload(&event_bytes),
            conservative_bytes,
            labels,
            byte_budgets,
        }
    }
}

fn progress_report(
    progress: &Arc<Mutex<DeliveryProgress>>,
    drain_pressure: Option<DeliveryPressureSnapshot>,
) -> EventDeliveryReport {
    let progress = progress_guard(progress);
    let last_acknowledged_sequence = progress.last_acknowledged_sequence;
    let drain_timeout = drain_pressure.map(|pressure| EventDeliveryDrainTimeoutDiagnostic {
        queued_events: usize_to_u32(pressure.pending_events),
        queued_bytes: usize_to_u64(pressure.queued_bytes),
        carried_events: 0,
        carried_bytes: 0,
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
        response_state: EventDeliveryResponseState::Incomplete,
    }
}

fn response_state(attempts: &[HttpCompletedAttemptDiagnostic]) -> EventDeliveryResponseState {
    if !attempts.is_empty()
        && attempts
            .iter()
            .all(|attempt| attempt.failure_kind == HttpAttemptFailureKind::HttpStatus)
    {
        EventDeliveryResponseState::AllHttpErrors
    } else {
        EventDeliveryResponseState::Incomplete
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
