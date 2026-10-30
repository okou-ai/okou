use std::io;
use std::sync::Arc;
use std::time::Instant;

use guest_control_proto::{
    BorrowedRawMessage, ExecCapturedOutput, ExecControlStatus, ExecOutputStream, MSG_ERROR,
    MSG_EXEC_AGENT_READY, MSG_EXEC_CONTROL_RESULT, MSG_EXEC_OUTPUT, MSG_EXEC_RESULT,
    MSG_EXEC_STARTED,
};

use crate::{ConnectionState, Shared, normal_operation_transition_error};

use super::state::{
    ExecCaptureState, ExecOperation, ExecOperationLifecycle, ExecStreamTryReserveError,
};
use super::types::{
    ExecControlAck, ExecControlGuestStatus, ExecControlOutcome, ExecOperationResult,
    ExecOutputEvent, ExecOwnedCapturedOutput, SupervisedExecStartTiming,
};
use super::{exec_operation_guest_error, exec_operation_protocol_error};

fn validate_output(
    operation: &mut ExecOperation,
    output: &guest_control_proto::DecodedExecOutput<'_>,
) -> io::Result<()> {
    if output.output_seq != operation.expected_output_seq {
        return Err(exec_operation_protocol_error(format!(
            "exec output seq mismatch: {} != {}",
            output.output_seq, operation.expected_output_seq
        )));
    }
    let stream = match output.stream {
        ExecOutputStream::Stdout => &mut operation.stdout_stream,
        ExecOutputStream::Stderr => &mut operation.stderr_stream,
    };
    let Some(stream) = stream else {
        return Err(exec_operation_protocol_error(
            "exec output received for non-streaming output policy",
        ));
    };
    if stream.truncated {
        return Err(exec_operation_protocol_error(
            "exec output received after stream truncation",
        ));
    }
    if output.chunk.is_empty() && !output.truncated {
        return Err(exec_operation_protocol_error(
            "exec output empty chunk must mark stream truncation",
        ));
    }
    if output.chunk.len() > stream.chunk_limit_bytes {
        return Err(exec_operation_protocol_error(
            "exec output chunk exceeds requested chunk limit",
        ));
    }
    let emitted_bytes = stream
        .emitted_bytes
        .checked_add(output.chunk.len())
        .ok_or_else(|| exec_operation_protocol_error("exec output stream byte count overflow"))?;
    if emitted_bytes > stream.limit_bytes {
        return Err(exec_operation_protocol_error(
            "exec output exceeds requested stream limit",
        ));
    }
    stream.emitted_bytes = emitted_bytes;
    if output.truncated {
        stream.truncated = true;
    }
    operation.expected_output_seq = operation.expected_output_seq.wrapping_add(1);
    Ok(())
}

fn validate_result_output(
    name: &str,
    state: &ExecCaptureState,
    output: ExecCapturedOutput<'_>,
) -> io::Result<()> {
    match (state, output) {
        (ExecCaptureState::Discard, ExecCapturedOutput::Discarded) => Ok(()),
        (ExecCaptureState::Discard, ExecCapturedOutput::Captured { .. }) => {
            Err(exec_operation_protocol_error(format!(
                "exec result {name} captured output for non-capturing policy",
            )))
        }
        (ExecCaptureState::Capture { limit_bytes }, ExecCapturedOutput::Captured { bytes, .. })
            if bytes.len() <= *limit_bytes =>
        {
            Ok(())
        }
        (ExecCaptureState::Capture { limit_bytes }, ExecCapturedOutput::Captured { bytes, .. }) => {
            Err(exec_operation_protocol_error(format!(
                "exec result {name} exceeds requested capture limit: {} > {limit_bytes}",
                bytes.len()
            )))
        }
        (ExecCaptureState::Capture { .. }, ExecCapturedOutput::Discarded) => {
            Err(exec_operation_protocol_error(format!(
                "exec result {name} discarded output for capturing policy",
            )))
        }
    }
}

fn validate_result(
    operation: &ExecOperation,
    result: &guest_control_proto::DecodedExecResult<'_>,
) -> io::Result<()> {
    validate_result_output("stdout", &operation.stdout_capture, result.stdout)?;
    validate_result_output("stderr", &operation.stderr_capture, result.stderr)
}

fn owned_captured_output(output: ExecCapturedOutput<'_>) -> ExecOwnedCapturedOutput {
    match output {
        ExecCapturedOutput::Discarded => ExecOwnedCapturedOutput::Discarded,
        ExecCapturedOutput::Captured { bytes, truncated } => ExecOwnedCapturedOutput::Captured {
            bytes: bytes.to_vec(),
            truncated,
        },
    }
}

fn owned_output_event(
    output: guest_control_proto::DecodedExecOutput<'_>,
    before_copy: impl FnOnce(),
) -> ExecOutputEvent {
    before_copy();
    ExecOutputEvent {
        stream: output.stream,
        output_seq: output.output_seq,
        chunk: output.chunk.to_vec(),
        truncated: output.truncated,
    }
}

#[cfg(test)]
fn run_exec_output_before_copy_hook(shared: &Arc<Shared>) {
    let hook = shared
        .exec_output_before_copy_hook
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take();
    if let Some(hook) = hook {
        hook();
    }
}

fn owned_result(
    result: guest_control_proto::DecodedExecResult<'_>,
    stream_overflowed: bool,
) -> ExecOperationResult {
    ExecOperationResult {
        termination: result.termination,
        duration_ms: result.duration_ms,
        stdout: owned_captured_output(result.stdout),
        stderr: owned_captured_output(result.stderr),
        diagnostic: result.diagnostic.to_string(),
        stream_overflowed,
    }
}

fn supervised_start_failure_message(result: &ExecOperationResult) -> String {
    if !result.diagnostic.is_empty() {
        return result.diagnostic.clone();
    }
    if let ExecOwnedCapturedOutput::Captured { bytes, .. } = &result.stderr {
        let stderr = String::from_utf8_lossy(bytes);
        let stderr = stderr.trim();
        if !stderr.is_empty() {
            return stderr.to_owned();
        }
    }
    "supervised exec start failed".to_owned()
}

/// Returns true when exec handling consumed the frame; false lets the normal
/// pending-response dispatcher handle it.
pub(crate) fn dispatch_incoming_frame(
    shared: &Arc<Shared>,
    msg: BorrowedRawMessage<'_>,
) -> io::Result<bool> {
    match msg.msg_type {
        MSG_ERROR => dispatch_error(shared, msg),
        MSG_EXEC_OUTPUT => dispatch_output(shared, msg).map(|_| true),
        MSG_EXEC_STARTED => dispatch_started(shared, msg).map(|_| true),
        MSG_EXEC_AGENT_READY => dispatch_agent_ready(shared, msg).map(|_| true),
        MSG_EXEC_RESULT => dispatch_result(shared, msg).map(|_| true),
        MSG_EXEC_CONTROL_RESULT => dispatch_control_result(shared, msg).map(|_| true),
        _ => Ok(false),
    }
}

fn dispatch_output(shared: &Arc<Shared>, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
    let mut first_output_slow = None;
    let mut senders_to_drop = None;
    let prepared_output = {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if let ConnectionState::Connected { operations, .. } = &mut *guard
            && let Some(operation) = operations.get_mut_by_seq(msg.seq)
        {
            let decoded = guest_control_proto::decode_exec_output(msg.payload)
                .map_err(exec_operation_protocol_error)?;
            if !operation.allows_output() {
                return Err(exec_operation_protocol_error(
                    "exec output arrived before exec_started",
                ));
            }
            validate_output(operation, &decoded)?;
            first_output_slow = operation.diagnostic.mark_first_output();
            // Keep the registered sender in state so teardown can clear it
            // while payload ownership happens outside the lock.
            if let Some(tx) = operation.stream_tx.clone() {
                match tx.try_reserve_owned() {
                    Ok(permit) => Some((permit, decoded)),
                    Err(ExecStreamTryReserveError::Full(tx)) => {
                        operation.stream_overflowed = true;
                        senders_to_drop = Some((operation.stream_tx.take(), tx));
                        None
                    }
                    Err(ExecStreamTryReserveError::Closed(tx)) => {
                        senders_to_drop = Some((operation.stream_tx.take(), tx));
                        None
                    }
                }
            } else {
                None
            }
        } else {
            None
        }
    };
    drop(senders_to_drop);

    let returned_sender = if let Some((permit, decoded)) = prepared_output {
        let event = owned_output_event(decoded, || {
            #[cfg(test)]
            run_exec_output_before_copy_hook(shared);
        });

        {
            let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            // Channel identity rejects a replacement operation after sequence
            // wrap; holding state makes the check and delivery atomic with teardown.
            let sender_matches = if let ConnectionState::Connected { operations, .. } = &mut *guard
                && let Some(operation) = operations.get_mut_by_seq(msg.seq)
                && let Some(tx) = operation.stream_tx.as_ref()
            {
                permit.same_channel_as_sender(tx)
            } else {
                false
            };
            if sender_matches {
                Some(permit.send(event))
            } else {
                None
            }
        }
    } else {
        None
    };
    drop(returned_sender);

    if let Some(snapshot) = first_output_slow {
        tracing::warn!(
            seq = snapshot.seq,
            label = %snapshot.label_log,
            elapsed_ms = snapshot.elapsed_ms,
            process_class = snapshot.process_class,
            operation_kind = snapshot.operation_kind,
            "slow exec operation first output"
        );
    }

    Ok(())
}

fn dispatch_started(shared: &Arc<Shared>, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
    let start = {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { operations, .. } => {
                let Some(operation) = operations.get_mut_by_seq(msg.seq) else {
                    return Ok(());
                };
                let decoded = guest_control_proto::decode_exec_started(msg.payload)
                    .map_err(exec_operation_protocol_error)?;
                let lifecycle =
                    std::mem::replace(&mut operation.lifecycle, ExecOperationLifecycle::OneShot);
                match lifecycle {
                    ExecOperationLifecycle::SupervisedAwaitingStart {
                        mut start_tx,
                        role,
                        control_nonce,
                    } => {
                        let start_tx = start_tx.take();
                        let shell_started_at = Instant::now();
                        match role {
                            guest_control_proto::ExecProcessRole::Workload => {
                                operation.lifecycle = ExecOperationLifecycle::SupervisedStarted {
                                    pid: decoded.pid,
                                    control_nonce,
                                };
                                start_tx.map(|start_tx| {
                                    (
                                        start_tx,
                                        decoded.pid,
                                        SupervisedExecStartTiming {
                                            shell_started_at,
                                            agent_ready_at: None,
                                            agent_ready: None,
                                        },
                                    )
                                })
                            }
                            guest_control_proto::ExecProcessRole::Agent => {
                                operation.lifecycle =
                                    ExecOperationLifecycle::SupervisedAwaitingAgentReady {
                                        start_tx,
                                        pid: decoded.pid,
                                        shell_started_at,
                                        control_nonce,
                                    };
                                None
                            }
                            guest_control_proto::ExecProcessRole::SessionHistoryIdentityVerifier => {
                                return Err(exec_operation_protocol_error(
                                    "supervised start cannot use session history identity verifier role",
                                ));
                            }
                        }
                    }
                    lifecycle @ ExecOperationLifecycle::SupervisedAwaitingAgentReady {
                        pid, ..
                    } => {
                        operation.lifecycle = lifecycle;
                        return Err(exec_operation_protocol_error(format!(
                            "duplicate exec_started for Agent pid {pid}",
                        )));
                    }
                    lifecycle @ ExecOperationLifecycle::SupervisedStarted { pid, .. } => {
                        operation.lifecycle = lifecycle;
                        return Err(exec_operation_protocol_error(format!(
                            "duplicate exec_started for pid {pid}",
                        )));
                    }
                    ExecOperationLifecycle::OneShot => {
                        return Err(exec_operation_protocol_error(
                            "exec_started received for one-shot exec operation",
                        ));
                    }
                }
            }
            ConnectionState::Closed(_) => None,
        }
    };

    if let Some((start_tx, pid, timing)) = start {
        let _ = start_tx.send(Ok((pid, timing)));
    }

    Ok(())
}

fn dispatch_agent_ready(shared: &Arc<Shared>, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
    let start = {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { operations, .. } => {
                let Some(operation) = operations.get_mut_by_seq(msg.seq) else {
                    return Ok(());
                };
                let decoded = guest_control_proto::decode_exec_agent_ready(msg.payload)
                    .map_err(exec_operation_protocol_error)?;
                let lifecycle =
                    std::mem::replace(&mut operation.lifecycle, ExecOperationLifecycle::OneShot);
                match lifecycle {
                    ExecOperationLifecycle::SupervisedAwaitingAgentReady {
                        mut start_tx,
                        pid,
                        shell_started_at,
                        control_nonce,
                    } => {
                        let start_tx = start_tx.take();
                        let agent_ready_at = Instant::now();
                        operation.lifecycle =
                            ExecOperationLifecycle::SupervisedStarted { pid, control_nonce };
                        start_tx.map(|start_tx| {
                            (
                                start_tx,
                                pid,
                                SupervisedExecStartTiming {
                                    shell_started_at,
                                    agent_ready_at: Some(agent_ready_at),
                                    agent_ready: Some(decoded),
                                },
                            )
                        })
                    }
                    lifecycle @ ExecOperationLifecycle::SupervisedAwaitingStart { .. } => {
                        operation.lifecycle = lifecycle;
                        return Err(exec_operation_protocol_error(
                            "exec_agent_ready received before exec_started",
                        ));
                    }
                    lifecycle @ ExecOperationLifecycle::SupervisedStarted { pid, .. } => {
                        operation.lifecycle = lifecycle;
                        return Err(exec_operation_protocol_error(format!(
                            "unexpected exec_agent_ready for started pid {pid}",
                        )));
                    }
                    ExecOperationLifecycle::OneShot => {
                        return Err(exec_operation_protocol_error(
                            "exec_agent_ready received for one-shot exec operation",
                        ));
                    }
                }
            }
            ConnectionState::Closed(_) => None,
        }
    };

    if let Some((start_tx, pid, timing)) = start {
        let _ = start_tx.send(Ok((pid, timing)));
    }

    Ok(())
}

pub(in crate::exec_operation) fn dispatch_result(
    shared: &Arc<Shared>,
    msg: BorrowedRawMessage<'_>,
) -> io::Result<()> {
    let Some((terminal, decoded)) = ({
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { operations, .. } if operations.contains_seq(msg.seq) => {
                let decoded = guest_control_proto::decode_exec_result(msg.payload)
                    .map_err(exec_operation_protocol_error)?;
                let Some(operation) = operations.get_mut_by_seq(msg.seq) else {
                    return Ok(());
                };
                operation.validates_result_before_start(&decoded)?;
                validate_result(operation, &decoded)?;
                operations
                    .take_terminal_exec_operation(msg.seq)?
                    .map(|terminal| (terminal, decoded))
            }
            ConnectionState::Connected { .. } | ConnectionState::Closed(_) => None,
        }
    }) else {
        return Ok(());
    };

    terminal.diagnostic.log_terminal(
        terminal.log_lifecycle,
        &decoded,
        terminal.stream_overflowed,
        terminal.host_cancel_requested,
    );
    let result = owned_result(decoded, terminal.stream_overflowed);
    if let Some(start_tx) = terminal.start_tx {
        let message = supervised_start_failure_message(&result);
        let _ = start_tx.send(Err(io::Error::other(message)));
    }
    let _ = terminal.result_tx.send(Ok(result));

    Ok(())
}

fn dispatch_control_result(shared: &Arc<Shared>, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
    let Some(pending) = ({
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { operations, .. } => {
                operations.take_pending_control(msg.seq)
            }
            ConnectionState::Closed(_) => None,
        }
    }) else {
        return Ok(());
    };
    let decoded = guest_control_proto::decode_exec_control_result(msg.payload)
        .map_err(exec_operation_protocol_error)?;

    if decoded.control_nonce != pending.control_nonce {
        return Err(exec_operation_protocol_error(
            "exec_control_result nonce mismatch",
        ));
    }
    if decoded.target_seq != pending.target_route_id.wire_seq() {
        return Err(exec_operation_protocol_error(format!(
            "exec_control_result target seq mismatch: expected {}, got {}",
            pending.target_route_id.wire_seq(),
            decoded.target_seq
        )));
    }
    if decoded.message_id != pending.message_id {
        return Err(exec_operation_protocol_error(format!(
            "exec_control_result message_id mismatch: expected {}, got {}",
            pending.message_id, decoded.message_id
        )));
    }
    pending
        .normal_operation
        .complete()
        .map_err(normal_operation_transition_error)?;
    let outcome = match decoded.status {
        ExecControlStatus::Delivered => ExecControlOutcome::Delivered(ExecControlAck {
            target_seq: decoded.target_seq,
            message_id: decoded.message_id.to_owned(),
        }),
        status => ExecControlOutcome::GuestStatus(ExecControlGuestStatus {
            status,
            diagnostic: decoded.diagnostic.to_owned(),
        }),
    };
    let _ = pending.response_tx.send(Ok(outcome));
    Ok(())
}

fn dispatch_error(shared: &Arc<Shared>, msg: BorrowedRawMessage<'_>) -> io::Result<bool> {
    let Some((terminal, err)) = ({
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { operations, .. } if operations.contains_seq(msg.seq) => {
                let err = guest_control_proto::decode_error(msg.payload)
                    .map(|message| exec_operation_guest_error(message.to_string()))
                    .map_err(exec_operation_protocol_error)?;
                operations
                    .take_terminal_exec_operation(msg.seq)?
                    .map(|terminal| (terminal, err))
            }
            ConnectionState::Connected { .. } | ConnectionState::Closed(_) => None,
        }
    }) else {
        return dispatch_control_error(shared, msg);
    };

    terminal.diagnostic.log_error_response(&err);
    if let Some(start_tx) = terminal.start_tx {
        let _ = start_tx.send(Err(io::Error::new(err.kind(), err.to_string())));
    }
    let _ = terminal.result_tx.send(Err(err));
    Ok(true)
}

fn dispatch_control_error(shared: &Arc<Shared>, msg: BorrowedRawMessage<'_>) -> io::Result<bool> {
    let Some(pending) = ({
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { operations, .. } => {
                operations.take_pending_control(msg.seq)
            }
            ConnectionState::Closed(_) => None,
        }
    }) else {
        return Ok(false);
    };
    let message = guest_control_proto::decode_error(msg.payload)
        .map(|message| message.to_owned())
        .map_err(exec_operation_protocol_error)?;
    pending
        .normal_operation
        .complete()
        .map_err(normal_operation_transition_error)?;
    let _ = pending
        .response_tx
        .send(Ok(ExecControlOutcome::GuestError(message)));
    Ok(true)
}
