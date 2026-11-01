use std::future::{Future, ready};
use std::io;
use std::sync::Arc;
use std::time::Duration;

use guest_contracts::session_history_identity::{
    SESSION_HISTORY_IDENTITY_VERIFY_DIAGNOSTIC_LABEL,
    SESSION_HISTORY_IDENTITY_VERIFY_OUTPUT_LIMIT_BYTES, SessionHistoryFramework,
    SessionHistoryIdentityExpectation,
    SessionHistoryIdentityVerifyRequest as GuestSessionHistoryIdentityVerifyRequest,
    SessionHistoryRefKind,
};
use guest_control_proto::{
    ExecControlPolicy, ExecLifecyclePolicy, ExecOutputPolicy, ExecProcessRole, ExecTimeoutPolicy,
    MSG_EXEC_CANCEL,
};
use tokio::sync::oneshot;
use tokio::time::{self, Instant};

use crate::connection::FrameWriteDecision;
use crate::request_progress::RequestWriteProgress;
use crate::{
    CompositeNormalOperation, FrameWriteObserver, RequestTimeoutError, RequestTimeoutStage, Shared,
};

use super::frame::{
    ExecStartWriteAdmission, admit_exec_cancel_frame, write_exec_start_frame, write_frame,
};
use super::handle::{
    ExecControlHandle, ExecOperationCancelOnDropGuard, ExecOperationHandle,
    ExecOperationWaitOutcome, ExecWaitCore, SupervisedExecHandle,
};
use super::state::{
    ExecOperationLifecycle, ExecOperationRegistration, ExecOperationRegistrationInput,
    ExecOperationTracking, ExecStreamQueueKind, output_policy_streams,
    register_exec_operation_start, stream_queue_capacity_for,
};
use super::types::{
    ExecCaptureRequest, ExecOperationRequest, ExecOperationResult, ExecStreamRequest,
    SessionHistoryIdentityVerifyRequest, SupervisedExecControl, SupervisedExecRequest,
};
use super::{EXEC_OPERATION_START_TIMEOUT_CANCEL_WRITE_TIMEOUT, SMALL_EXEC_CAPTURE_LIMIT_BYTES};

fn exec_start_timeout_error() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "exec start timeout")
}

fn supervised_start_timeout_error(stage: RequestTimeoutStage, timeout: Duration) -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        RequestTimeoutError::new(stage, timeout),
    )
}

fn exec_start_deadline(timeout: Duration) -> io::Result<Instant> {
    if timeout.is_zero() {
        return Err(exec_start_timeout_error());
    }
    Instant::now().checked_add(timeout).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "exec start timeout is too large",
        )
    })
}

pub(crate) fn append_diagnostic(stderr: &mut Vec<u8>, diagnostic: &str) {
    if diagnostic.is_empty() {
        return;
    }
    if !stderr.is_empty() && !stderr.ends_with(b"\n") {
        stderr.push(b'\n');
    }
    stderr.extend_from_slice(diagnostic.as_bytes());
}

pub(crate) async fn start_exec_operation_on_shared(
    shared: &Arc<Shared>,
    request: ExecOperationRequest<'_>,
) -> io::Result<ExecOperationHandle> {
    let (handle, _) = start_exec_operation_on_shared_with_tracking(
        shared,
        request,
        ExecOperationTracking::Tracked,
        FrameWriteObserver::default(),
    )
    .await?;
    Ok(handle)
}

async fn start_exec_operation_on_shared_with_tracking(
    shared: &Arc<Shared>,
    request: ExecOperationRequest<'_>,
    tracking: ExecOperationTracking<'_>,
    write_observer: FrameWriteObserver,
) -> io::Result<(ExecOperationHandle, Instant)> {
    start_exec_operation_on_shared_with_tracking_and_admission(
        shared,
        request,
        ExecProcessRole::Workload,
        tracking,
        FrameWriteObserver::default(),
        write_observer,
    )
    .await
}

async fn start_exec_operation_on_shared_with_tracking_and_admission(
    shared: &Arc<Shared>,
    request: ExecOperationRequest<'_>,
    role: ExecProcessRole,
    tracking: ExecOperationTracking<'_>,
    write_admission: FrameWriteObserver,
    write_observer: FrameWriteObserver,
) -> io::Result<(ExecOperationHandle, Instant)> {
    if request.timeout_ms == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "exec operation requires a positive timeout; use supervised exec for unbounded commands",
        ));
    }
    let stream_queue_capacity = stream_queue_capacity_for(
        request.stdout,
        request.stderr,
        request.stream_queue_capacity,
    )?;

    let payload = guest_control_proto::encode_exec_start_with_expected_exit_codes(
        guest_control_proto::ExecStartEncodeRequest {
            lifecycle: ExecLifecyclePolicy::OneShot,
            role,
            timeout: ExecTimeoutPolicy::Duration {
                timeout_ms: request.timeout_ms,
            },
            command: request.command,
            env: request.env,
            sudo: request.sudo,
            label: request.label,
            stdout: request.stdout,
            stderr: request.stderr,
            expected_exit_codes: request.expected_exit_codes,
            control: ExecControlPolicy::Disabled,
            stdin_bytes: request.stdin_bytes,
        },
    )
    .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
    let deadline = exec_start_deadline(request.start_write_timeout)?;

    let ExecOperationRegistration {
        route_id,
        diagnostic,
        result_rx,
        stream_rx,
        process_output_rx: _,
        mut registration_guard,
        tracks_normal_operation,
    } = register_exec_operation_start(
        shared,
        ExecOperationRegistrationInput {
            label: request.label,
            stdout: request.stdout,
            stderr: request.stderr,
            stream_queue_capacity,
            stream_queue_kind: ExecStreamQueueKind::Events,
            lifecycle: ExecOperationLifecycle::OneShot,
            timeout_is_expected: false,
            role,
            tracking,
        },
    )?;
    let decision = time::timeout_at(
        deadline,
        write_exec_start_frame(
            shared,
            route_id,
            &payload,
            &diagnostic,
            tracks_normal_operation,
            ExecStartWriteAdmission {
                deadline,
                observer: write_admission,
            },
            write_observer,
        ),
    )
    .await
    .map_err(|_| exec_start_timeout_error())??;
    if decision == FrameWriteDecision::Skip {
        return Err(exec_start_timeout_error());
    }
    registration_guard.disarm();

    Ok((
        ExecOperationHandle {
            wait_core: ExecWaitCore::new(Arc::clone(shared), route_id, diagnostic, result_rx),
            stream_rx,
        },
        deadline,
    ))
}

pub(crate) async fn start_supervised_exec_on_shared(
    shared: &Arc<Shared>,
    request: SupervisedExecRequest<'_>,
) -> io::Result<SupervisedExecHandle> {
    start_supervised_exec_on_shared_with_after_start_write(shared, request, ready(())).await
}

pub(crate) async fn start_supervised_process_on_shared(
    shared: &Arc<Shared>,
    request: SupervisedExecRequest<'_>,
) -> io::Result<SupervisedExecHandle> {
    if output_policy_streams(request.stderr) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "supervised process output requires non-streaming stderr",
        ));
    }
    start_supervised_exec_on_shared_with_stream_queue_kind(
        shared,
        request,
        ready(()),
        EXEC_OPERATION_START_TIMEOUT_CANCEL_WRITE_TIMEOUT,
        ExecStreamQueueKind::ProcessOutput,
        FrameWriteObserver::default(),
    )
    .await
}

pub(in crate::exec_operation) async fn start_supervised_exec_on_shared_with_after_start_write<F>(
    shared: &Arc<Shared>,
    request: SupervisedExecRequest<'_>,
    after_start_write: F,
) -> io::Result<SupervisedExecHandle>
where
    F: Future<Output = ()>,
{
    start_supervised_exec_on_shared_with_after_start_write_and_cancel_timeout(
        shared,
        request,
        after_start_write,
        EXEC_OPERATION_START_TIMEOUT_CANCEL_WRITE_TIMEOUT,
        FrameWriteObserver::default(),
    )
    .await
}

pub(in crate::exec_operation) async fn start_supervised_exec_on_shared_with_after_start_write_and_cancel_timeout<
    F,
>(
    shared: &Arc<Shared>,
    request: SupervisedExecRequest<'_>,
    after_start_write: F,
    start_timeout_cancel_write_timeout: Duration,
    start_write_observer: FrameWriteObserver,
) -> io::Result<SupervisedExecHandle>
where
    F: Future<Output = ()>,
{
    start_supervised_exec_on_shared_with_stream_queue_kind(
        shared,
        request,
        after_start_write,
        start_timeout_cancel_write_timeout,
        ExecStreamQueueKind::Events,
        start_write_observer,
    )
    .await
}

async fn start_supervised_exec_on_shared_with_stream_queue_kind<F>(
    shared: &Arc<Shared>,
    request: SupervisedExecRequest<'_>,
    after_start_write: F,
    start_timeout_cancel_write_timeout: Duration,
    stream_queue_kind: ExecStreamQueueKind,
    start_write_observer: FrameWriteObserver,
) -> io::Result<SupervisedExecHandle>
where
    F: Future<Output = ()>,
{
    let stream_queue_capacity = stream_queue_capacity_for(
        request.stdout,
        request.stderr,
        request.stream_queue_capacity,
    )?;
    let (control, control_nonce) = match request.control {
        SupervisedExecControl::Disabled => (ExecControlPolicy::Disabled, None),
        SupervisedExecControl::Enabled { sink } => {
            let control_nonce = *uuid::Uuid::new_v4().as_bytes();
            (
                ExecControlPolicy::Enabled {
                    control_nonce,
                    sink,
                },
                Some(control_nonce),
            )
        }
    };
    let payload = guest_control_proto::encode_exec_start_with_expected_exit_codes(
        guest_control_proto::ExecStartEncodeRequest {
            lifecycle: ExecLifecyclePolicy::Supervised,
            role: request.role,
            timeout: request.timeout,
            command: request.command,
            env: request.env,
            sudo: request.sudo,
            label: request.label,
            stdout: request.stdout,
            stderr: request.stderr,
            expected_exit_codes: request.expected_exit_codes,
            control,
            stdin_bytes: request.stdin_bytes,
        },
    )
    .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
    if request.start_timeout.is_zero() {
        return Err(supervised_start_timeout_error(
            RequestTimeoutStage::BeforeFrameWrite,
            request.start_timeout,
        ));
    }
    let deadline = exec_start_deadline(request.start_timeout)?;
    let start_progress = Arc::new(RequestWriteProgress::default());

    let (start_tx, start_rx) = oneshot::channel();
    let ExecOperationRegistration {
        route_id,
        diagnostic,
        result_rx,
        stream_rx,
        process_output_rx,
        mut registration_guard,
        tracks_normal_operation,
    } = register_exec_operation_start(
        shared,
        ExecOperationRegistrationInput {
            label: request.label,
            stdout: request.stdout,
            stderr: request.stderr,
            stream_queue_capacity,
            stream_queue_kind,
            lifecycle: ExecOperationLifecycle::SupervisedAwaitingStart {
                start_tx: Some(start_tx),
                role: request.role,
                control_nonce,
            },
            role: request.role,
            tracking: ExecOperationTracking::Tracked,
            timeout_is_expected: request.timeout_is_expected,
        },
    )?;
    let mut start_cancel_on_drop = ExecOperationCancelOnDropGuard::new_for_route(
        Arc::clone(shared),
        route_id,
        diagnostic.clone(),
    );
    let write_progress = Arc::clone(&start_progress);
    let start_write_result = time::timeout_at(
        deadline,
        write_exec_start_frame(
            shared,
            route_id,
            &payload,
            &diagnostic,
            tracks_normal_operation,
            ExecStartWriteAdmission {
                deadline,
                observer: FrameWriteObserver::default(),
            },
            FrameWriteObserver::new(move || {
                write_progress.mark_frame_write();
                start_write_observer.record_write_start()
            }),
        ),
    )
    .await
    .map_err(|_| {
        supervised_start_timeout_error(start_progress.timeout_stage(), request.start_timeout)
    })
    .and_then(|result| result)
    .and_then(|decision| match decision {
        FrameWriteDecision::Write => Ok(()),
        FrameWriteDecision::Skip => Err(supervised_start_timeout_error(
            RequestTimeoutStage::BeforeFrameWrite,
            request.start_timeout,
        )),
    });
    if let Err(error) = start_write_result {
        start_cancel_on_drop.disarm();
        return Err(error);
    }
    start_progress.mark_awaiting_terminal_response();
    after_start_write.await;

    let (pid, start_timing) = tokio::select! {
        biased;
        result = start_rx => {
            match result {
                Ok(Ok(start)) => start,
                Ok(Err(error)) => {
                    start_cancel_on_drop.disarm();
                    return Err(error);
                }
                Err(_) => {
                    start_cancel_on_drop.disarm();
                    return Err(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        "connection closed",
                    ));
                }
            }
        }
        _ = time::sleep_until(deadline) => {
            let seq = route_id.wire_seq();
            let cancel_result = async {
                let Some(_reservation) = admit_exec_cancel_frame(shared, route_id)? else {
                    return Err(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        "supervised exec route was replaced before start-timeout cancel",
                    ));
                };
                shared.remove_operation(route_id);
                registration_guard.disarm();
                let payload = guest_control_proto::encode_exec_cancel();
                tokio::time::timeout(
                    start_timeout_cancel_write_timeout,
                    write_frame(
                        shared,
                        MSG_EXEC_CANCEL,
                        seq,
                        &payload,
                        Some(diagnostic.frame("start-timeout-cancel")),
                        None,
                        FrameWriteObserver::default(),
                    ),
                )
                .await
                .unwrap_or_else(|_| {
                    shared.poison_connection(crate::ConnectionCloseReason::StartCancelWriteTimeout, None);
                    Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "supervised exec start timeout cancel write timed out",
                    ))
                })
            }
            .await;
            start_cancel_on_drop.disarm();
            // Cleanup failure must not erase the post-write timeout classification.
            if let Err(error) = cancel_result {
                tracing::warn!(
                    seq = seq,
                    label = %diagnostic.label_log,
                    process_class = diagnostic.process_class,
                    operation_kind = diagnostic.operation_kind,
                    elapsed_ms = diagnostic.elapsed_ms(),
                    error = %error,
                    "supervised exec start timeout cancellation failed"
                );
            }
            return Err(supervised_start_timeout_error(
                RequestTimeoutStage::AwaitingTerminalResponse,
                request.start_timeout,
            ));
        }
    };
    start_cancel_on_drop.disarm();
    registration_guard.disarm();

    Ok(SupervisedExecHandle {
        wait_core: ExecWaitCore::new(Arc::clone(shared), route_id, diagnostic, result_rx),
        pid,
        start_timing,
        cancel_handle_taken: false,
        stream_rx,
        process_output_rx,
        control: control_nonce.map(|control_nonce| ExecControlHandle {
            shared: Arc::clone(shared),
            target_route_id: route_id,
            control_nonce,
        }),
    })
}

pub(crate) async fn exec_operation_capture_on_shared(
    shared: &Arc<Shared>,
    request: ExecCaptureRequest<'_>,
) -> io::Result<ExecOperationResult> {
    exec_operation_capture_on_shared_with_tracking(
        shared,
        request,
        ExecOperationTracking::Tracked,
        FrameWriteObserver::default(),
    )
    .await
}

pub(crate) async fn session_history_identity_verify_on_shared(
    shared: &Arc<Shared>,
    request: SessionHistoryIdentityVerifyRequest<'_>,
) -> io::Result<ExecOperationResult> {
    let framework = SessionHistoryFramework::parse_cli_arg(request.framework)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
    let history_ref_kind = SessionHistoryRefKind::parse_cli_arg(request.history_ref_kind)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
    let expectation = SessionHistoryIdentityExpectation::new(
        framework,
        request.session_id_hash,
        history_ref_kind,
        request.history_hash,
        request.history_size_bytes,
    )
    .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
    let guest_request = GuestSessionHistoryIdentityVerifyRequest {
        metadata_path: request.metadata_path.to_owned(),
        runtime_dir: request.runtime_dir.to_owned(),
        expectation,
    };
    guest_request
        .validate()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
    let payload = serde_json::to_string(&guest_request)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;

    let start_result = start_exec_operation_on_shared_with_tracking_and_admission(
        shared,
        ExecOperationRequest {
            timeout_ms: request.timeout_ms,
            command: &payload,
            env: &[],
            sudo: false,
            label: SESSION_HISTORY_IDENTITY_VERIFY_DIAGNOSTIC_LABEL,
            stdout: ExecOutputPolicy::Capture {
                limit_bytes: SESSION_HISTORY_IDENTITY_VERIFY_OUTPUT_LIMIT_BYTES,
            },
            stderr: ExecOutputPolicy::Capture {
                limit_bytes: SESSION_HISTORY_IDENTITY_VERIFY_OUTPUT_LIMIT_BYTES,
            },
            expected_exit_codes: &[],
            stdin_bytes: None,
            stream_queue_capacity: None,
            start_write_timeout: request.wait_timeout,
        },
        ExecProcessRole::SessionHistoryIdentityVerifier,
        ExecOperationTracking::Tracked,
        FrameWriteObserver::default(),
        FrameWriteObserver::default(),
    )
    .await;
    let (handle, deadline) = start_result?;
    handle.wait_until_outcome(deadline).await.into_result()
}

pub(crate) async fn exec_operation_capture_on_shared_with_write_observer(
    shared: &Arc<Shared>,
    request: ExecCaptureRequest<'_>,
    write_observer: FrameWriteObserver,
) -> io::Result<ExecOperationResult> {
    exec_operation_capture_on_shared_with_tracking(
        shared,
        request,
        ExecOperationTracking::Tracked,
        write_observer,
    )
    .await
}

pub(crate) async fn exec_operation_capture_on_shared_with_write_admission(
    shared: &Arc<Shared>,
    request: ExecCaptureRequest<'_>,
    write_admission: FrameWriteObserver,
) -> io::Result<ExecOperationResult> {
    exec_operation_capture_on_shared_with_tracking_and_admission(
        shared,
        request,
        ExecOperationTracking::Tracked,
        write_admission,
        FrameWriteObserver::default(),
    )
    .await
}

async fn exec_operation_capture_on_shared_with_tracking(
    shared: &Arc<Shared>,
    request: ExecCaptureRequest<'_>,
    tracking: ExecOperationTracking<'_>,
    write_observer: FrameWriteObserver,
) -> io::Result<ExecOperationResult> {
    exec_operation_capture_on_shared_with_tracking_and_admission(
        shared,
        request,
        tracking,
        FrameWriteObserver::default(),
        write_observer,
    )
    .await
}

async fn exec_operation_capture_on_shared_with_tracking_and_admission(
    shared: &Arc<Shared>,
    request: ExecCaptureRequest<'_>,
    tracking: ExecOperationTracking<'_>,
    write_admission: FrameWriteObserver,
    write_observer: FrameWriteObserver,
) -> io::Result<ExecOperationResult> {
    exec_operation_capture_on_shared_with_tracking_and_admission_outcome(
        shared,
        request,
        tracking,
        write_admission,
        write_observer,
    )
    .await
    .into_result()
}

async fn exec_operation_capture_on_shared_with_tracking_and_admission_outcome(
    shared: &Arc<Shared>,
    request: ExecCaptureRequest<'_>,
    tracking: ExecOperationTracking<'_>,
    write_admission: FrameWriteObserver,
    write_observer: FrameWriteObserver,
) -> ExecOperationWaitOutcome<ExecOperationResult> {
    let start_result = start_exec_operation_on_shared_with_tracking_and_admission(
        shared,
        ExecOperationRequest {
            timeout_ms: request.timeout_ms,
            command: request.command,
            env: request.env,
            sudo: request.sudo,
            label: request.label,
            stdout: ExecOutputPolicy::Capture {
                limit_bytes: request.stdout_limit_bytes,
            },
            stderr: ExecOutputPolicy::Capture {
                limit_bytes: request.stderr_limit_bytes,
            },
            expected_exit_codes: request.expected_exit_codes,
            stdin_bytes: request.stdin_bytes,
            stream_queue_capacity: None,
            start_write_timeout: request.wait_timeout,
        },
        ExecProcessRole::Workload,
        tracking,
        write_admission,
        write_observer,
    )
    .await;
    let (handle, deadline) = match start_result {
        Ok(started) => started,
        Err(error) => return ExecOperationWaitOutcome::unproven(error),
    };
    handle.wait_until_outcome(deadline).await
}

pub(crate) async fn exec_operation_stream_on_shared(
    shared: &Arc<Shared>,
    request: ExecStreamRequest<'_>,
) -> io::Result<ExecOperationHandle> {
    exec_operation_stream_on_shared_with_tracking(
        shared,
        request,
        ExecOperationTracking::Tracked,
        FrameWriteObserver::default(),
    )
    .await
}

async fn exec_operation_stream_on_shared_with_tracking(
    shared: &Arc<Shared>,
    request: ExecStreamRequest<'_>,
    tracking: ExecOperationTracking<'_>,
    write_observer: FrameWriteObserver,
) -> io::Result<ExecOperationHandle> {
    if !output_policy_streams(request.stdout) && !output_policy_streams(request.stderr) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "exec_operation_stream requires a streaming output policy",
        ));
    }

    let (handle, _) = start_exec_operation_on_shared_with_tracking(
        shared,
        ExecOperationRequest {
            timeout_ms: request.timeout_ms,
            command: request.command,
            env: request.env,
            sudo: request.sudo,
            label: request.label,
            stdout: request.stdout,
            stderr: request.stderr,
            expected_exit_codes: request.expected_exit_codes,
            stdin_bytes: request.stdin_bytes,
            stream_queue_capacity: request.stream_queue_capacity,
            start_write_timeout: request.start_write_timeout,
        },
        tracking,
        write_observer,
    )
    .await?;
    Ok(handle)
}

pub(crate) async fn exec_operation_stream_with_composite_on_shared_and_observer(
    shared: &Arc<Shared>,
    request: ExecStreamRequest<'_>,
    normal_operation: &mut CompositeNormalOperation,
    write_observer: FrameWriteObserver,
) -> io::Result<ExecOperationHandle> {
    exec_operation_stream_on_shared_with_tracking(
        shared,
        request,
        ExecOperationTracking::Composite(normal_operation),
        write_observer,
    )
    .await
}

pub(crate) async fn exec_operation_cleanup_untracked_on_shared_with_write_observer(
    shared: &Arc<Shared>,
    command: &str,
    timeout_ms: u32,
    env: &[(&str, &str)],
    sudo: bool,
    write_observer: FrameWriteObserver,
) -> io::Result<ExecOperationResult> {
    exec_operation_cleanup_on_shared_with_tracking(
        shared,
        command,
        timeout_ms,
        env,
        sudo,
        ExecOperationTracking::Untracked,
        write_observer,
    )
    .await
}

async fn exec_operation_cleanup_on_shared_with_tracking(
    shared: &Arc<Shared>,
    command: &str,
    timeout_ms: u32,
    env: &[(&str, &str)],
    sudo: bool,
    tracking: ExecOperationTracking<'_>,
    write_observer: FrameWriteObserver,
) -> io::Result<ExecOperationResult> {
    exec_operation_cleanup_on_shared_with_tracking_outcome(
        shared,
        command,
        timeout_ms,
        env,
        sudo,
        tracking,
        write_observer,
    )
    .await
    .into_result()
}

async fn exec_operation_cleanup_on_shared_with_tracking_outcome(
    shared: &Arc<Shared>,
    command: &str,
    timeout_ms: u32,
    env: &[(&str, &str)],
    sudo: bool,
    tracking: ExecOperationTracking<'_>,
    write_observer: FrameWriteObserver,
) -> ExecOperationWaitOutcome<ExecOperationResult> {
    exec_operation_capture_on_shared_with_tracking_and_admission_outcome(
        shared,
        ExecCaptureRequest {
            timeout_ms,
            command,
            env,
            sudo,
            label: "exec-cleanup",
            stdout_limit_bytes: SMALL_EXEC_CAPTURE_LIMIT_BYTES,
            stderr_limit_bytes: SMALL_EXEC_CAPTURE_LIMIT_BYTES,
            expected_exit_codes: &[],
            stdin_bytes: None,
            wait_timeout: Duration::from_millis(timeout_ms as u64),
        },
        tracking,
        FrameWriteObserver::default(),
        write_observer,
    )
    .await
}

pub(crate) async fn exec_operation_cleanup_with_composite_on_shared_and_observer(
    shared: &Arc<Shared>,
    command: &str,
    timeout_ms: u32,
    env: &[(&str, &str)],
    sudo: bool,
    normal_operation: &mut CompositeNormalOperation,
    write_observer: FrameWriteObserver,
) -> ExecOperationWaitOutcome<ExecOperationResult> {
    exec_operation_cleanup_on_shared_with_tracking_outcome(
        shared,
        command,
        timeout_ms,
        env,
        sudo,
        ExecOperationTracking::Composite(normal_operation),
        write_observer,
    )
    .await
}

pub(crate) async fn exec_operation_capture_with_composite_on_shared_and_observer(
    shared: &Arc<Shared>,
    request: ExecCaptureRequest<'_>,
    normal_operation: &mut CompositeNormalOperation,
    write_observer: FrameWriteObserver,
) -> ExecOperationWaitOutcome<ExecOperationResult> {
    exec_operation_capture_on_shared_with_tracking_and_admission_outcome(
        shared,
        request,
        ExecOperationTracking::Composite(normal_operation),
        FrameWriteObserver::default(),
        write_observer,
    )
    .await
}
