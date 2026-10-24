use std::io;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Instant;

use guest_control_proto::{ExecControlNonce, ExecControlStatus, MSG_EXEC_CONTROL_RESULT};
use process_control_ipc::{ControlRequest, ControlResponseStatus};

use crate::error::to_io_error;
use crate::log::log;
use crate::threading::{SystemThreadSpawner, ThreadSpawner};
use crate::writer::GuestWriter;

use super::deadline_io::DeadlineStream;
use super::sink::{
    ControlSinkFailure, ControlSinkState, ControlStreamLockError, PendingControlSlot,
};
use super::{
    EXEC_CONTROL_LOG_NAME, EXEC_CONTROL_MESSAGE_ID_MISMATCH_PREFIX,
    EXEC_CONTROL_WORKER_START_ERROR_PREFIX, EXEC_OPERATION_INACTIVE_MESSAGE,
    EXEC_REQUEST_TIMEOUT_DIAGNOSTIC, THREAD_EXEC_CONTROL_FORWARD, duration_until, is_timeout,
    request_timeout_error,
};

const _: () = assert!(
    guest_control_proto::EXEC_CONTROL_MAX_PAYLOAD_BYTES
        == process_control_ipc::MAX_CONTROL_PAYLOAD_BYTES,
    "guest-control exec-control payload limit must match process-control IPC at the guest bridge",
);

pub(super) struct OwnedExecControlRequest {
    pub(super) response_seq: u32,
    pub(super) target_seq: u32,
    pub(super) deadline: Instant,
    pub(super) control_nonce: ExecControlNonce,
    pub(super) message_id: String,
    pub(super) payload: Vec<u8>,
}

struct ControlForwardOutcome {
    status: ExecControlStatus,
    diagnostic: String,
    sink_disposition: ControlSinkDisposition,
}

enum ControlSinkDisposition {
    Keep,
    Fail,
}

pub(super) fn try_forward(
    sink: Arc<ControlSinkState>,
    request: OwnedExecControlRequest,
    writer: GuestWriter,
) -> Option<(ExecControlStatus, String)> {
    try_forward_with_spawner(sink, request, writer, SystemThreadSpawner)
}

pub(super) fn try_forward_with_spawner<S>(
    sink: Arc<ControlSinkState>,
    request: OwnedExecControlRequest,
    writer: GuestWriter,
    spawner: S,
) -> Option<(ExecControlStatus, String)>
where
    S: ThreadSpawner,
{
    let pending_slot = match sink.reserve_pending_slot() {
        Ok(pending_slot) => pending_slot,
        Err(error) => return Some(error),
    };

    match spawner.spawn(
        THREAD_EXEC_CONTROL_FORWARD,
        Box::new(move || forward_control_request(sink, pending_slot, request, writer)),
    ) {
        Ok(_) => None,
        Err(error) => Some((
            ExecControlStatus::SinkError,
            format!("{}: {error}", EXEC_CONTROL_WORKER_START_ERROR_PREFIX),
        )),
    }
}

pub(super) fn forward_control_request(
    sink: Arc<ControlSinkState>,
    _pending_slot: PendingControlSlot,
    request: OwnedExecControlRequest,
    writer: GuestWriter,
) {
    let OwnedExecControlRequest {
        response_seq,
        target_seq,
        deadline,
        control_nonce,
        message_id,
        payload,
    } = request;
    let outcome = {
        match sink.wait_for_stream(deadline) {
            Ok(stream) => match stream.lock_until(deadline, &sink.active) {
                Ok(mut stream) => {
                    let outcome = if !sink.active.load(Ordering::Acquire) {
                        ControlForwardOutcome {
                            status: ExecControlStatus::Inactive,
                            diagnostic: EXEC_OPERATION_INACTIVE_MESSAGE.to_owned(),
                            sink_disposition: ControlSinkDisposition::Keep,
                        }
                    } else if request_expired(deadline) {
                        ControlForwardOutcome {
                            status: ExecControlStatus::SinkTimeout,
                            diagnostic: EXEC_REQUEST_TIMEOUT_DIAGNOSTIC.to_owned(),
                            sink_disposition: ControlSinkDisposition::Keep,
                        }
                    } else {
                        forward_to_connected_sink(&mut stream, &message_id, payload, deadline)
                    };
                    if matches!(outcome.sink_disposition, ControlSinkDisposition::Fail) {
                        sink.fail(if outcome.status == ExecControlStatus::SinkClosed {
                            ControlSinkFailure::Closed(outcome.diagnostic.clone())
                        } else {
                            ControlSinkFailure::Other(outcome.diagnostic.clone())
                        });
                    }
                    outcome
                }
                Err(ControlStreamLockError::Inactive) => ControlForwardOutcome {
                    status: ExecControlStatus::Inactive,
                    diagnostic: EXEC_OPERATION_INACTIVE_MESSAGE.to_owned(),
                    sink_disposition: ControlSinkDisposition::Keep,
                },
                Err(ControlStreamLockError::Timeout) => ControlForwardOutcome {
                    status: ExecControlStatus::SinkTimeout,
                    diagnostic: EXEC_REQUEST_TIMEOUT_DIAGNOSTIC.to_owned(),
                    sink_disposition: ControlSinkDisposition::Keep,
                },
                Err(ControlStreamLockError::SinkError(failure)) => ControlForwardOutcome {
                    status: failure.status(),
                    diagnostic: failure.diagnostic().to_owned(),
                    sink_disposition: ControlSinkDisposition::Keep,
                },
            },
            Err((status, diagnostic)) => ControlForwardOutcome {
                status,
                diagnostic,
                sink_disposition: ControlSinkDisposition::Keep,
            },
        }
    };

    let ControlForwardOutcome {
        status, diagnostic, ..
    } = outcome;

    let result = writer.write_generated_frame_after_lock(|| {
        let (status, diagnostic) = if sink.active.load(Ordering::Acquire) {
            (status, diagnostic.as_str())
        } else {
            (ExecControlStatus::Inactive, EXEC_OPERATION_INACTIVE_MESSAGE)
        };
        let result_payload =
            encode_control_result(target_seq, control_nonce, &message_id, status, diagnostic)
                .map_err(to_io_error)?;
        guest_control_proto::encode(MSG_EXEC_CONTROL_RESULT, response_seq, &result_payload)
            .map_err(to_io_error)
    });
    if let Err(error) = result {
        log(
            "WARN",
            &format!("{EXEC_CONTROL_LOG_NAME}: failed to send control result: {error}"),
        );
    }
}

fn forward_to_connected_sink(
    stream: &mut UnixStream,
    message_id: &str,
    payload: Vec<u8>,
    deadline: Instant,
) -> ControlForwardOutcome {
    let request_frame = ControlRequest {
        message_id: message_id.to_owned(),
        payload,
    };
    let mut stream = DeadlineStream::new(stream, deadline);
    if let Err(error) = process_control_ipc::write_request(&mut stream, &request_frame) {
        return if is_timeout(&error) {
            control_forward_io_error(
                ExecControlStatus::SinkTimeout,
                error,
                if stream.io_started {
                    ControlSinkDisposition::Fail
                } else {
                    ControlSinkDisposition::Keep
                },
            )
        } else {
            control_forward_io_error(
                ExecControlStatus::SinkError,
                error,
                ControlSinkDisposition::Fail,
            )
        };
    }

    match process_control_ipc::read_response(&mut stream) {
        // Socket timeout rounding and scheduling can complete the final read
        // after its budget. Never turn that late response into an acceptance.
        Ok(_) if request_expired(deadline) => control_forward_io_error(
            ExecControlStatus::SinkTimeout,
            request_timeout_error(),
            ControlSinkDisposition::Fail,
        ),
        Ok(response) if response.message_id != message_id => ControlForwardOutcome {
            status: ExecControlStatus::SinkError,
            diagnostic: format!(
                "{}: expected {}, got {}",
                EXEC_CONTROL_MESSAGE_ID_MISMATCH_PREFIX, message_id, response.message_id
            ),
            sink_disposition: ControlSinkDisposition::Fail,
        },
        Ok(response) => match response.status {
            ControlResponseStatus::Accepted => ControlForwardOutcome {
                status: ExecControlStatus::Delivered,
                diagnostic: response.diagnostic,
                sink_disposition: ControlSinkDisposition::Keep,
            },
            ControlResponseStatus::Rejected => ControlForwardOutcome {
                status: ExecControlStatus::Rejected,
                diagnostic: response.diagnostic,
                sink_disposition: ControlSinkDisposition::Keep,
            },
            ControlResponseStatus::QueueFull => ControlForwardOutcome {
                status: ExecControlStatus::QueueFull,
                diagnostic: response.diagnostic,
                sink_disposition: ControlSinkDisposition::Keep,
            },
            ControlResponseStatus::Error => ControlForwardOutcome {
                status: ExecControlStatus::SinkError,
                diagnostic: response.diagnostic,
                sink_disposition: ControlSinkDisposition::Keep,
            },
        },
        Err(error) if is_timeout(&error) => control_forward_io_error(
            ExecControlStatus::SinkTimeout,
            error,
            ControlSinkDisposition::Fail,
        ),
        Err(error) => control_forward_io_error(
            ExecControlStatus::SinkError,
            error,
            ControlSinkDisposition::Fail,
        ),
    }
}

fn control_forward_io_error(
    status: ExecControlStatus,
    error: io::Error,
    sink_disposition: ControlSinkDisposition,
) -> ControlForwardOutcome {
    let status = if status == ExecControlStatus::SinkError
        && matches!(
            error.kind(),
            io::ErrorKind::BrokenPipe
                | io::ErrorKind::ConnectionReset
                | io::ErrorKind::UnexpectedEof
        ) {
        ExecControlStatus::SinkClosed
    } else {
        status
    };
    ControlForwardOutcome {
        status,
        diagnostic: error.to_string(),
        sink_disposition,
    }
}

fn request_expired(deadline: Instant) -> bool {
    duration_until(deadline).is_none()
}

pub(super) fn encode_control_result(
    target_seq: u32,
    control_nonce: ExecControlNonce,
    message_id: &str,
    status: ExecControlStatus,
    diagnostic: &str,
) -> Result<Vec<u8>, guest_control_proto::ProtocolError> {
    guest_control_proto::encode_exec_control_result(
        target_seq,
        control_nonce,
        message_id,
        status,
        diagnostic,
    )
}
