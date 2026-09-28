//! Active-input forwarding from a Runner source to Guest control.
//!
//! The API source reads the next steerable input prompt of the run. The Guest
//! declares an accepted input steered; the Runner only forwards it once.
//!
//! An API source reads when the run starts and after each wakeup (an
//! `active-input` push for the run, or an Ably reconnect). A failed read or a
//! forward the Guest did not accept is not retried; the next wakeup reads
//! again, and an input no run steers is picked as the thread's next run.

use std::time::Duration;

use api_contracts::generated::types::runners::runs::steerable_inputs::next::ResponseInput;
use guest_contracts::active_input::{ACTIVE_INPUT_CLOSED_DIAGNOSTIC, encode_active_input};
use sandbox::{
    GuestProcessControlHandle, ProcessControlFailureKind, ProcessControlGuestStatus,
    ProcessControlOutcome, ProcessControlWriteState,
};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use runner_provider::{
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES, ActiveInputBatch, ActiveInputSource, ProviderError,
    local_active_input_event_id,
};
use runner_types::ids::RunId;

#[cfg(test)]
mod tests;

const ACTIVE_INPUT_CONTROL_TIMEOUT: Duration = Duration::from_secs(1);
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
    /// The Guest did not take the input; it stays unforwarded until a later read.
    NotForwarded,
    Suppress,
    Stop,
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
    // steered; an uncertain forward is never sent again. An input the Guest
    // did not take is not recorded, so a later read forwards it.
    let mut forwarded_api_event_id: Option<String> = None;
    loop {
        let batch = tokio::select! {
            biased;
            () = stop.cancelled() => return,
            () = job_cancel.cancelled() => return,
            batch = source.read(next_local_sequence) => batch,
        };
        match batch {
            Ok(ActiveInputBatch::Local(entries)) => {
                for entry in entries {
                    if entry.sequence < next_local_sequence {
                        continue;
                    }
                    if entry.sequence > next_local_sequence {
                        break;
                    }
                    let event_id = local_active_input_event_id(run_id, entry.sequence);
                    let disposition = forward(
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
                        // The next local poll reads this sequence again.
                        ForwardDisposition::NotForwarded => break,
                        ForwardDisposition::Suppress | ForwardDisposition::Stop => return,
                    }
                }
            }
            Ok(ActiveInputBatch::Api(response)) => match response.input {
                Some(ResponseInput { event_id, prompt }) => {
                    if forwarded_api_event_id.as_deref() != Some(&event_id) {
                        let disposition = forward(
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
                            ForwardDisposition::NotForwarded => {}
                            ForwardDisposition::Stop => return,
                        }
                    }
                }
                None => {
                    forwarded_api_event_id = None;
                }
            },
            Err(error) => log_read_error(run_id, &error),
        }

        tokio::select! {
            biased;
            () = stop.cancelled() => return,
            () = job_cancel.cancelled() => return,
            () = source.wait_until_next_read() => {}
        }
    }
}

fn log_read_error(run_id: RunId, error: &ProviderError) {
    const MESSAGE: &str = "active-input source read failed; waiting for the next wakeup";
    match error {
        ProviderError::ApiTransport(api_error) => error!(
            target: "runner::executor::active_input",
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
            "{MESSAGE}"
        ),
        _ => error!(
            target: "runner::executor::active_input",
            run_id = %run_id,
            error = %error,
            "{MESSAGE}"
        ),
    }
}

/// Offer one input to the Guest exactly once; the caller never resends it
/// before its next read.
async fn forward(
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
    if stop.is_cancelled() || job_cancel.is_cancelled() {
        return ForwardDisposition::Stop;
    }
    // Once started, retain the control future until its write outcome is known.
    let outcome = control
        .control_owned_outcome(event_id, payload, ACTIVE_INPUT_CONTROL_TIMEOUT)
        .await;
    classify_control_outcome(run_id, mode, outcome)
}

fn classify_control_outcome(
    run_id: RunId,
    mode: DeliveryMode,
    outcome: ProcessControlOutcome,
) -> ForwardDisposition {
    match outcome {
        ProcessControlOutcome::Delivered(_) => ForwardDisposition::Accepted,
        ProcessControlOutcome::GuestStatus { status, diagnostic } => match status {
            ProcessControlGuestStatus::QueueFull | ProcessControlGuestStatus::SinkUnavailable => {
                warn!(
                    run_id = %run_id,
                    outcome = guest_status_label(status),
                    diagnostic = %diagnostic,
                    "active-input control not accepted; waiting for the next read"
                );
                ForwardDisposition::NotForwarded
            }
            ProcessControlGuestStatus::SinkTimeout
            | ProcessControlGuestStatus::SinkError
            | ProcessControlGuestStatus::SinkClosed => {
                warn!(
                    run_id = %run_id,
                    outcome = guest_status_label(status),
                    diagnostic = %diagnostic,
                    "active-input control acknowledgement is unknown"
                );
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
            warn!(
                run_id = %run_id,
                outcome = "guest_error",
                error = %error,
                "active-input control acknowledgement is unknown"
            );
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
            warn!(
                run_id = %run_id,
                outcome,
                error = %error,
                "active-input control failed"
            );
            match (kind, write_state) {
                (ProcessControlFailureKind::Operation, ProcessControlWriteState::NotWritten) => {
                    ForwardDisposition::NotForwarded
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
        DeliveryMode::Local => ForwardDisposition::NotForwarded,
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
