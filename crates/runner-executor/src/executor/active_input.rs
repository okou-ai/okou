//! Active-input forwarding from a Runner source to Guest control.
//!
//! The API source reads the next prompt or time-budget warning targeted at the
//! run. Both use the same event identity and materialized text. The Guest declares
//! an accepted input steered; the Runner only forwards it once.

use std::time::Duration;

use api_contracts::generated::types::runners::runs::steerable_inputs::next::ResponseInput;
use guest_contracts::active_input::{ACTIVE_INPUT_CLOSED_DIAGNOSTIC, encode_active_input};
use sandbox::{
    GuestProcessControlHandle, ProcessControlFailureKind, ProcessControlGuestStatus,
    ProcessControlOutcome, ProcessControlWriteState,
};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use runner_provider::{
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES, ActiveInputBatch, ActiveInputSource,
    local_active_input_event_id,
};
use runner_types::ids::RunId;

mod read_failures;

#[cfg(test)]
mod tests;

use read_failures::ReadFailures;

const ACTIVE_INPUT_CONTROL_TIMEOUT: Duration = Duration::from_secs(1);
pub(super) const ACTIVE_INPUT_CONTROL_RETRY_INITIAL_INTERVAL: Duration = Duration::from_millis(250);
pub(super) const ACTIVE_INPUT_CONTROL_RETRY_MAX_INTERVAL: Duration = Duration::from_secs(4);
const FIRST_ACTIVE_INPUT_SEQUENCE: u64 = 1;

pub(super) struct ActiveInputForwarder {
    stop: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl ActiveInputForwarder {
    pub(super) fn start(
        run_id: RunId,
        source: Option<ActiveInputSource>,
        control: Option<GuestProcessControlHandle>,
        job_cancel: CancellationToken,
    ) -> Option<Self> {
        let (Some(source), Some(control)) = (source, control) else {
            return None;
        };
        let stop = CancellationToken::new();
        let stop_for_task = stop.clone();
        let task = tokio::spawn(async move {
            run_forwarder(run_id, source, control, job_cancel, stop_for_task).await;
        });
        Some(Self { stop, task })
    }

    /// Stop live forwarding while the caller still owns the live sandbox.
    pub(super) async fn stop(self) {
        self.stop.cancel();
        // A cancelled process-control future has an unknown write outcome. The
        // provider already bounds each control call, so retain ownership until
        // it resolves.
        if let Err(error) = self.task.await {
            warn!(error = %error, "active-input forwarder task failed");
        }
    }
}

#[derive(Clone, Copy)]
enum DeliveryMode {
    Api,
    Local,
}

enum ForwardDisposition {
    Accepted,
    Retry,
    Suppress,
    Stop,
}

struct PreparedActiveInput {
    event_id: String,
    payload: Vec<u8>,
}

async fn run_forwarder(
    run_id: RunId,
    mut source: ActiveInputSource,
    control: GuestProcessControlHandle,
    job_cancel: CancellationToken,
    stop: CancellationToken,
) {
    let mut next_local_sequence = FIRST_ACTIVE_INPUT_SEQUENCE;
    // The API keeps returning a forwarded input until the Guest declares it
    // steered; an uncertain forward is never sent again.
    let mut forwarded_api_event_id: Option<String> = None;
    let mut read_failures = ReadFailures::default();
    loop {
        let batch = tokio::select! {
            biased;
            () = stop.cancelled() => return,
            () = job_cancel.cancelled() => return,
            batch = source.read(next_local_sequence) => batch,
        };
        if let Ok(batch) = &batch {
            read_failures.recover(run_id, batch);
        }
        let retry_after_read_error = match batch {
            Ok(ActiveInputBatch::Local(entries)) => {
                for entry in entries {
                    if entry.sequence < next_local_sequence {
                        continue;
                    }
                    if entry.sequence > next_local_sequence {
                        break;
                    }
                    let event_id = local_active_input_event_id(run_id, entry.sequence);
                    let disposition = forward_with_retry(
                        run_id,
                        event_id,
                        entry.text,
                        DeliveryMode::Local,
                        &control,
                        &job_cancel,
                        &stop,
                    )
                    .await;
                    match disposition {
                        ForwardDisposition::Accepted => {
                            next_local_sequence = next_local_sequence.saturating_add(1);
                        }
                        ForwardDisposition::Suppress
                        | ForwardDisposition::Retry
                        | ForwardDisposition::Stop => return,
                    }
                }
                false
            }
            Ok(ActiveInputBatch::Api(response)) => match response.input {
                Some(ResponseInput { event_id, prompt }) => {
                    if forwarded_api_event_id.as_deref() != Some(&event_id) {
                        let disposition = forward_with_retry(
                            run_id,
                            event_id.clone(),
                            prompt,
                            DeliveryMode::Api,
                            &control,
                            &job_cancel,
                            &stop,
                        )
                        .await;
                        match disposition {
                            ForwardDisposition::Accepted | ForwardDisposition::Suppress => {
                                forwarded_api_event_id = Some(event_id);
                            }
                            ForwardDisposition::Retry | ForwardDisposition::Stop => return,
                        }
                    }
                    false
                }
                None => {
                    forwarded_api_event_id = None;
                    false
                }
            },
            Err(error) => {
                read_failures.record(run_id, &error);
                true
            }
        };

        tokio::select! {
            biased;
            () = stop.cancelled() => return,
            () = job_cancel.cancelled() => return,
            () = async {
                if retry_after_read_error {
                    source.wait_after_read_error().await;
                } else {
                    source.wait_until_next_read().await;
                }
            } => {}
        }
    }
}

async fn forward_with_retry(
    run_id: RunId,
    event_id: String,
    text: String,
    mode: DeliveryMode,
    control: &GuestProcessControlHandle,
    job_cancel: &CancellationToken,
    stop: &CancellationToken,
) -> ForwardDisposition {
    let payload = match encode_active_input(&event_id, &text) {
        Ok(payload) if payload.len() <= ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES => payload,
        Ok(_) => {
            warn!(
                run_id = %run_id,
                outcome = "payload_too_large",
                "active-input control payload exceeds frame limit"
            );
            return ForwardDisposition::Stop;
        }
        Err(error) => {
            warn!(
                run_id = %run_id,
                outcome = "serialization_error",
                error = %error,
                "failed to serialize active input"
            );
            return ForwardDisposition::Stop;
        }
    };
    drop(text);
    let prepared = PreparedActiveInput { event_id, payload };
    let mut warn_retryable_failure = true;
    let mut retry_interval = ACTIVE_INPUT_CONTROL_RETRY_INITIAL_INTERVAL;
    loop {
        if stop.is_cancelled() || job_cancel.is_cancelled() {
            return ForwardDisposition::Stop;
        }
        // Once started, retain the control future until its write outcome is known.
        let disposition =
            forward_once(run_id, &prepared, mode, control, warn_retryable_failure).await;
        if !matches!(disposition, ForwardDisposition::Retry) {
            return disposition;
        }
        warn_retryable_failure = false;
        tokio::select! {
            biased;
            () = stop.cancelled() => return ForwardDisposition::Stop,
            () = job_cancel.cancelled() => return ForwardDisposition::Stop,
            () = tokio::time::sleep(retry_interval) => {}
        }
        retry_interval = (retry_interval * 2).min(ACTIVE_INPUT_CONTROL_RETRY_MAX_INTERVAL);
    }
}

async fn forward_once(
    run_id: RunId,
    prepared: &PreparedActiveInput,
    mode: DeliveryMode,
    control: &GuestProcessControlHandle,
    warn_retryable_failure: bool,
) -> ForwardDisposition {
    let outcome = control
        .control_owned_outcome(
            prepared.event_id.clone(),
            prepared.payload.clone(),
            ACTIVE_INPUT_CONTROL_TIMEOUT,
        )
        .await;
    classify_control_outcome(run_id, mode, outcome, warn_retryable_failure)
}

fn classify_control_outcome(
    run_id: RunId,
    mode: DeliveryMode,
    outcome: ProcessControlOutcome,
    warn_retryable_failure: bool,
) -> ForwardDisposition {
    match outcome {
        ProcessControlOutcome::Delivered(_) => ForwardDisposition::Accepted,
        ProcessControlOutcome::GuestStatus { status, diagnostic } => match status {
            ProcessControlGuestStatus::QueueFull | ProcessControlGuestStatus::SinkUnavailable => {
                if warn_retryable_failure {
                    warn!(
                        run_id = %run_id,
                        outcome = guest_status_label(status),
                        diagnostic = %diagnostic,
                        "active-input control will retry"
                    );
                }
                ForwardDisposition::Retry
            }
            ProcessControlGuestStatus::SinkTimeout
            | ProcessControlGuestStatus::SinkError
            | ProcessControlGuestStatus::SinkClosed => {
                if warn_retryable_failure {
                    warn!(
                        run_id = %run_id,
                        outcome = guest_status_label(status),
                        diagnostic = %diagnostic,
                        "active-input control acknowledgement is unknown"
                    );
                }
                uncertain_disposition(mode)
            }
            ProcessControlGuestStatus::Inactive => ForwardDisposition::Stop,
            ProcessControlGuestStatus::Rejected if diagnostic == ACTIVE_INPUT_CLOSED_DIAGNOSTIC => {
                info!(
                    run_id = %run_id,
                    outcome = "closed",
                    diagnostic = %diagnostic,
                    "active-input control stopped"
                );
                ForwardDisposition::Stop
            }
            ProcessControlGuestStatus::NonceMismatch
            | ProcessControlGuestStatus::Unsupported
            | ProcessControlGuestStatus::Rejected => {
                warn!(
                    run_id = %run_id,
                    outcome = guest_status_label(status),
                    diagnostic = %diagnostic,
                    "active-input control stopped"
                );
                ForwardDisposition::Stop
            }
        },
        ProcessControlOutcome::GuestError(error) => {
            if warn_retryable_failure {
                warn!(
                    run_id = %run_id,
                    outcome = "guest_error",
                    error = %error,
                    "active-input control acknowledgement is unknown"
                );
            }
            uncertain_disposition(mode)
        }
        ProcessControlOutcome::Failed {
            kind,
            write_state,
            error,
        } => {
            let outcome = match (kind, write_state) {
                (ProcessControlFailureKind::Operation, ProcessControlWriteState::NotWritten) => {
                    "operation_not_written"
                }
                (
                    ProcessControlFailureKind::Operation,
                    ProcessControlWriteState::PossiblyWritten,
                ) => "operation_possibly_written",
                (
                    ProcessControlFailureKind::BackendCrashed,
                    ProcessControlWriteState::NotWritten,
                ) => "backend_crashed_not_written",
                (
                    ProcessControlFailureKind::BackendCrashed,
                    ProcessControlWriteState::PossiblyWritten,
                ) => "backend_crashed_possibly_written",
            };
            if warn_retryable_failure {
                warn!(
                    run_id = %run_id,
                    outcome,
                    error = %error,
                    "active-input control failed"
                );
            }
            match (kind, write_state) {
                (ProcessControlFailureKind::Operation, ProcessControlWriteState::NotWritten) => {
                    ForwardDisposition::Retry
                }
                (
                    ProcessControlFailureKind::Operation,
                    ProcessControlWriteState::PossiblyWritten,
                ) => uncertain_disposition(mode),
                (ProcessControlFailureKind::BackendCrashed, _) => {
                    if matches!(
                        (mode, write_state),
                        (DeliveryMode::Api, ProcessControlWriteState::PossiblyWritten)
                    ) {
                        ForwardDisposition::Suppress
                    } else {
                        ForwardDisposition::Stop
                    }
                }
            }
        }
    }
}

fn uncertain_disposition(mode: DeliveryMode) -> ForwardDisposition {
    match mode {
        DeliveryMode::Api => ForwardDisposition::Suppress,
        DeliveryMode::Local => ForwardDisposition::Retry,
    }
}

fn guest_status_label(status: ProcessControlGuestStatus) -> &'static str {
    match status {
        ProcessControlGuestStatus::Inactive => "inactive",
        ProcessControlGuestStatus::NonceMismatch => "nonce_mismatch",
        ProcessControlGuestStatus::Unsupported => "unsupported",
        ProcessControlGuestStatus::Rejected => "rejected",
        ProcessControlGuestStatus::SinkUnavailable => "sink_unavailable",
        ProcessControlGuestStatus::SinkTimeout => "sink_timeout",
        ProcessControlGuestStatus::QueueFull => "queue_full",
        ProcessControlGuestStatus::SinkError => "sink_error",
        ProcessControlGuestStatus::SinkClosed => "sink_closed",
    }
}
