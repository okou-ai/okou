use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use std::time::Instant;

use guest_control_proto::{
    ExecControlNonce, ExecControlStatus, ExecOutputPolicy, ExecProcessRole, ExecTermination,
};
use sandbox::{ProcessOutputChunk, ProcessOutputReceiver};
use tokio::sync::{mpsc, oneshot};

use crate::{
    CompositeNormalOperation, ConnectionState, RouteId, Shared, normal_operation_transition_error,
    operation_tracker::{NormalOperationToken, NormalOperationTransitionHandle},
};

use super::diagnostics::{
    ExecOperationCloseSnapshot, ExecOperationDiagnostic, ExecTerminalLogLifecycle,
    exec_terminal_log_lifecycle,
};
use super::frame::remove_pending_exec_control;
use super::types::{
    ExecControlOutcome, ExecOperationResult, ExecOutputEvent, SupervisedExecStartTiming,
    exec_control_status_error,
};
use super::{
    DEFAULT_EXEC_STREAM_CAPACITY, EXEC_OPERATION_CLOSE_ACTIVE_LOG_LIMIT, MAX_EXEC_STREAM_CAPACITY,
    exec_operation_protocol_error,
};

pub(crate) struct Operations {
    operations: HashMap<u32, ExecOperation>,
    control_targets: HashMap<u32, RouteId>,
}

impl Operations {
    pub(crate) fn new() -> Self {
        Self {
            operations: HashMap::new(),
            control_targets: HashMap::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.operations.len()
    }

    #[cfg(test)]
    pub(crate) fn pending_control_count(&self) -> usize {
        self.control_targets.len()
    }

    pub(crate) fn contains_route_seq(&self, seq: u32) -> bool {
        self.operations.contains_key(&seq) || self.control_targets.contains_key(&seq)
    }

    pub(crate) fn contains_route(&self, route_id: RouteId) -> bool {
        self.operations
            .get(&route_id.wire_seq())
            .is_some_and(|operation| operation.route_id == route_id)
    }

    pub(in crate::exec_operation) fn insert(
        &mut self,
        route_id: RouteId,
        operation: ExecOperation,
    ) {
        assert!(
            self.operations
                .insert(route_id.wire_seq(), operation)
                .is_none(),
            "exec operation route must be vacant"
        );
    }

    pub(crate) fn remove(&mut self, route_id: RouteId) {
        let seq = route_id.wire_seq();
        if self
            .operations
            .get(&seq)
            .is_some_and(|operation| operation.route_id == route_id)
        {
            self.take_by_seq(seq);
        }
    }

    pub(in crate::exec_operation) fn take_by_seq(&mut self, seq: u32) -> Option<ExecOperation> {
        let operation = self.operations.remove(&seq)?;
        for request_seq in operation.pending_controls.keys() {
            self.control_targets.remove(request_seq);
        }
        Some(operation)
    }

    #[cfg(test)]
    pub(crate) fn remove_by_seq(&mut self, seq: u32) -> bool {
        self.take_by_seq(seq).is_some()
    }

    pub(in crate::exec_operation) fn take_terminal_exec_operation(
        &mut self,
        seq: u32,
    ) -> io::Result<Option<TerminalExecOperation>> {
        self.take_by_seq(seq)
            .map(ExecOperation::into_terminal)
            .transpose()
    }

    pub(in crate::exec_operation) fn contains_seq(&self, seq: u32) -> bool {
        self.operations.contains_key(&seq)
    }

    pub(in crate::exec_operation) fn get_mut_by_seq(
        &mut self,
        seq: u32,
    ) -> Option<&mut ExecOperation> {
        self.operations.get_mut(&seq)
    }

    pub(in crate::exec_operation) fn get_mut(
        &mut self,
        route_id: RouteId,
    ) -> Option<&mut ExecOperation> {
        self.operations
            .get_mut(&route_id.wire_seq())
            .filter(|operation| operation.route_id == route_id)
    }

    pub(in crate::exec_operation) fn mark_host_cancel_requested(
        &mut self,
        route_id: RouteId,
    ) -> bool {
        if let Some(operation) = self.get_mut(route_id) {
            operation.host_cancel_requested = true;
            true
        } else {
            false
        }
    }

    pub(in crate::exec_operation) fn insert_pending_control(
        &mut self,
        target_route_id: RouteId,
        request_route_id: RouteId,
        pending: PendingExecControl,
    ) -> io::Result<()> {
        let Some(operation) = self.get_mut(target_route_id) else {
            return Err(exec_control_status_error(
                ExecControlStatus::Inactive,
                "exec operation is not active",
            ));
        };
        operation.validate_control_nonce(pending.control_nonce)?;
        let request_seq = request_route_id.wire_seq();
        assert!(
            operation
                .pending_controls
                .insert(request_seq, pending)
                .is_none(),
            "exec control route must be vacant"
        );
        assert!(
            self.control_targets
                .insert(request_seq, target_route_id)
                .is_none(),
            "exec control target route must be vacant"
        );
        Ok(())
    }

    pub(in crate::exec_operation) fn remove_pending_control(&mut self, request_route_id: RouteId) {
        let request_seq = request_route_id.wire_seq();
        let Some(target_route_id) = self.control_targets.get(&request_seq).copied() else {
            return;
        };
        let request_matches = self
            .get_mut(target_route_id)
            .and_then(|operation| operation.pending_controls.get(&request_seq))
            .is_some_and(|pending| pending.route_id == request_route_id);
        if request_matches {
            self.control_targets.remove(&request_seq);
            if let Some(operation) = self.get_mut(target_route_id) {
                operation.pending_controls.remove(&request_seq);
            }
        }
    }

    pub(in crate::exec_operation) fn take_pending_control(
        &mut self,
        request_seq: u32,
    ) -> Option<PendingExecControl> {
        let target_route_id = self.control_targets.remove(&request_seq)?;
        self.get_mut(target_route_id)?
            .pending_controls
            .remove(&request_seq)
    }

    pub(crate) fn close_snapshot(&self) -> ExecOperationCloseSnapshot {
        let active_count = self.operations.len();
        let operations = self
            .operations
            .values()
            .take(EXEC_OPERATION_CLOSE_ACTIVE_LOG_LIMIT)
            .map(|operation| operation.diagnostic.snapshot())
            .collect();
        ExecOperationCloseSnapshot {
            active_count,
            operations,
        }
    }
}

impl Default for Operations {
    fn default() -> Self {
        Self::new()
    }
}

pub(in crate::exec_operation) struct ExecOperation {
    pub(in crate::exec_operation) route_id: RouteId,
    pub(in crate::exec_operation) normal_operation: Option<ExecOperationNormalTracking>,
    pub(in crate::exec_operation) lifecycle: ExecOperationLifecycle,
    pub(in crate::exec_operation) diagnostic: ExecOperationDiagnostic,
    pub(in crate::exec_operation) result_tx: oneshot::Sender<io::Result<ExecOperationResult>>,
    pub(in crate::exec_operation) stream_tx: Option<ExecStreamSender>,
    pub(in crate::exec_operation) stdout_capture: ExecCaptureState,
    pub(in crate::exec_operation) stderr_capture: ExecCaptureState,
    pub(in crate::exec_operation) stdout_stream: Option<ExecStreamState>,
    pub(in crate::exec_operation) stderr_stream: Option<ExecStreamState>,
    pub(in crate::exec_operation) expected_output_seq: u32,
    pub(in crate::exec_operation) stream_overflowed: bool,
    pub(in crate::exec_operation) host_cancel_requested: bool,
    pub(in crate::exec_operation) pending_controls: HashMap<u32, PendingExecControl>,
}

pub(in crate::exec_operation) enum ExecOperationLifecycle {
    OneShot,
    SupervisedAwaitingStart {
        start_tx: Option<oneshot::Sender<io::Result<(u32, SupervisedExecStartTiming)>>>,
        role: ExecProcessRole,
        control_nonce: Option<ExecControlNonce>,
    },
    SupervisedAwaitingAgentReady {
        start_tx: Option<oneshot::Sender<io::Result<(u32, SupervisedExecStartTiming)>>>,
        pid: u32,
        shell_started_at: Instant,
        control_nonce: Option<ExecControlNonce>,
    },
    SupervisedStarted {
        pid: u32,
        control_nonce: Option<ExecControlNonce>,
    },
}

pub(in crate::exec_operation) struct PendingExecControl {
    pub(in crate::exec_operation) route_id: RouteId,
    pub(in crate::exec_operation) target_route_id: RouteId,
    pub(in crate::exec_operation) message_id: String,
    pub(in crate::exec_operation) control_nonce: ExecControlNonce,
    pub(in crate::exec_operation) response_tx: oneshot::Sender<io::Result<ExecControlOutcome>>,
    pub(in crate::exec_operation) normal_operation: NormalOperationToken,
}

pub(in crate::exec_operation) enum ExecOperationNormalTracking {
    Owned(NormalOperationToken),
    Composite(NormalOperationTransitionHandle),
}

pub(in crate::exec_operation) struct TerminalExecOperation {
    pub(in crate::exec_operation) diagnostic: ExecOperationDiagnostic,
    pub(in crate::exec_operation) result_tx: oneshot::Sender<io::Result<ExecOperationResult>>,
    pub(in crate::exec_operation) start_tx:
        Option<oneshot::Sender<io::Result<(u32, SupervisedExecStartTiming)>>>,
    pub(in crate::exec_operation) log_lifecycle: ExecTerminalLogLifecycle,
    pub(in crate::exec_operation) stream_overflowed: bool,
    pub(in crate::exec_operation) host_cancel_requested: bool,
}

impl ExecOperation {
    pub(in crate::exec_operation) fn allows_output(&self) -> bool {
        matches!(
            self.lifecycle,
            ExecOperationLifecycle::OneShot
                | ExecOperationLifecycle::SupervisedAwaitingAgentReady { .. }
                | ExecOperationLifecycle::SupervisedStarted { .. }
        )
    }

    pub(in crate::exec_operation) fn validates_result_before_start(
        &self,
        result: &guest_control_proto::DecodedExecResult<'_>,
    ) -> io::Result<()> {
        if matches!(
            self.lifecycle,
            ExecOperationLifecycle::SupervisedAwaitingStart { .. }
        ) && result.termination != ExecTermination::StartFailed
        {
            return Err(exec_operation_protocol_error(
                "supervised exec result before exec_started must be StartFailed",
            ));
        }
        Ok(())
    }

    pub(in crate::exec_operation) fn validate_control_nonce(
        &self,
        control_nonce: ExecControlNonce,
    ) -> io::Result<()> {
        match self.lifecycle {
            ExecOperationLifecycle::SupervisedStarted {
                control_nonce: Some(expected),
                ..
            } if expected == control_nonce => Ok(()),
            ExecOperationLifecycle::SupervisedStarted {
                control_nonce: Some(_),
                ..
            } => Err(exec_control_status_error(
                ExecControlStatus::NonceMismatch,
                "exec operation nonce mismatch",
            )),
            ExecOperationLifecycle::SupervisedStarted {
                control_nonce: None,
                ..
            } => Err(exec_control_status_error(
                ExecControlStatus::Unsupported,
                "exec control is not supported by this operation",
            )),
            ExecOperationLifecycle::OneShot
            | ExecOperationLifecycle::SupervisedAwaitingStart { .. }
            | ExecOperationLifecycle::SupervisedAwaitingAgentReady { .. } => {
                Err(exec_control_status_error(
                    ExecControlStatus::Inactive,
                    "exec operation is not active",
                ))
            }
        }
    }

    fn into_terminal(self) -> io::Result<TerminalExecOperation> {
        let ExecOperation {
            normal_operation,
            lifecycle,
            diagnostic,
            result_tx,
            stream_overflowed,
            host_cancel_requested,
            ..
        } = self;
        let log_lifecycle = exec_terminal_log_lifecycle(&lifecycle);
        let start_tx = match lifecycle {
            ExecOperationLifecycle::SupervisedAwaitingStart { start_tx, .. }
            | ExecOperationLifecycle::SupervisedAwaitingAgentReady { start_tx, .. } => start_tx,
            ExecOperationLifecycle::OneShot | ExecOperationLifecycle::SupervisedStarted { .. } => {
                None
            }
        };
        if let Some(normal_operation) = normal_operation {
            normal_operation.complete()?;
        }
        Ok(TerminalExecOperation {
            diagnostic,
            result_tx,
            start_tx,
            log_lifecycle,
            stream_overflowed,
            host_cancel_requested,
        })
    }
}

impl ExecOperationNormalTracking {
    pub(in crate::exec_operation) fn mark_possible_guest_write_started(
        &mut self,
    ) -> io::Result<()> {
        match self {
            ExecOperationNormalTracking::Owned(normal_operation) => normal_operation
                .mark_possible_guest_write_started()
                .map_err(normal_operation_transition_error),
            ExecOperationNormalTracking::Composite(normal_operation) => normal_operation
                .mark_possible_guest_write_started()
                .map_err(normal_operation_transition_error),
        }
    }

    pub(in crate::exec_operation) fn complete(self) -> io::Result<()> {
        match self {
            ExecOperationNormalTracking::Owned(normal_operation) => normal_operation
                .complete()
                .map_err(normal_operation_transition_error),
            ExecOperationNormalTracking::Composite(normal_operation) => normal_operation
                .mark_possible_guest_write_completed()
                .map_err(normal_operation_transition_error),
        }
    }
}

pub(in crate::exec_operation) enum ExecOperationTracking<'a> {
    Tracked,
    Composite(&'a CompositeNormalOperation),
    Untracked,
}

#[derive(Clone, Copy)]
pub(in crate::exec_operation) enum ExecStreamQueueKind {
    Events,
    ProcessOutput,
}

#[derive(Clone)]
pub(in crate::exec_operation) enum ExecStreamSender {
    Events(mpsc::Sender<ExecOutputEvent>),
    ProcessOutput(mpsc::Sender<ProcessOutputChunk>),
}

pub(in crate::exec_operation) enum ExecStreamPermit {
    Events(mpsc::OwnedPermit<ExecOutputEvent>),
    ProcessOutput(mpsc::OwnedPermit<ProcessOutputChunk>),
}

pub(in crate::exec_operation) enum ExecStreamTryReserveError {
    Full(ExecStreamSender),
    Closed(ExecStreamSender),
}

impl ExecStreamSender {
    pub(in crate::exec_operation) fn try_reserve_owned(
        self,
    ) -> Result<ExecStreamPermit, ExecStreamTryReserveError> {
        match self {
            Self::Events(sender) => sender
                .try_reserve_owned()
                .map(ExecStreamPermit::Events)
                .map_err(|error| match error {
                    mpsc::error::TrySendError::Full(sender) => {
                        ExecStreamTryReserveError::Full(Self::Events(sender))
                    }
                    mpsc::error::TrySendError::Closed(sender) => {
                        ExecStreamTryReserveError::Closed(Self::Events(sender))
                    }
                }),
            Self::ProcessOutput(sender) => sender
                .try_reserve_owned()
                .map(ExecStreamPermit::ProcessOutput)
                .map_err(|error| match error {
                    mpsc::error::TrySendError::Full(sender) => {
                        ExecStreamTryReserveError::Full(Self::ProcessOutput(sender))
                    }
                    mpsc::error::TrySendError::Closed(sender) => {
                        ExecStreamTryReserveError::Closed(Self::ProcessOutput(sender))
                    }
                }),
        }
    }
}

impl ExecStreamPermit {
    pub(in crate::exec_operation) fn same_channel_as_sender(
        &self,
        sender: &ExecStreamSender,
    ) -> bool {
        match (self, sender) {
            (Self::Events(permit), ExecStreamSender::Events(sender)) => {
                permit.same_channel_as_sender(sender)
            }
            (Self::ProcessOutput(permit), ExecStreamSender::ProcessOutput(sender)) => {
                permit.same_channel_as_sender(sender)
            }
            (Self::Events(_), ExecStreamSender::ProcessOutput(_))
            | (Self::ProcessOutput(_), ExecStreamSender::Events(_)) => false,
        }
    }

    pub(in crate::exec_operation) fn send(self, output: ExecOutputEvent) -> ExecStreamSender {
        match self {
            Self::Events(permit) => ExecStreamSender::Events(permit.send(output)),
            Self::ProcessOutput(permit) => {
                ExecStreamSender::ProcessOutput(permit.send(ProcessOutputChunk {
                    bytes: output.chunk,
                    truncated: output.truncated,
                }))
            }
        }
    }
}

pub(in crate::exec_operation) struct ExecOperationRegistrationInput<'a> {
    pub(in crate::exec_operation) label: &'a str,
    pub(in crate::exec_operation) timeout_is_expected: bool,
    pub(in crate::exec_operation) stdout: ExecOutputPolicy,
    pub(in crate::exec_operation) stderr: ExecOutputPolicy,
    pub(in crate::exec_operation) stream_queue_capacity: Option<usize>,
    pub(in crate::exec_operation) stream_queue_kind: ExecStreamQueueKind,
    pub(in crate::exec_operation) lifecycle: ExecOperationLifecycle,
    pub(in crate::exec_operation) role: ExecProcessRole,
    pub(in crate::exec_operation) tracking: ExecOperationTracking<'a>,
}

pub(in crate::exec_operation) struct ExecOperationRegistration {
    pub(in crate::exec_operation) route_id: RouteId,
    pub(in crate::exec_operation) diagnostic: ExecOperationDiagnostic,
    pub(in crate::exec_operation) result_rx: oneshot::Receiver<io::Result<ExecOperationResult>>,
    pub(in crate::exec_operation) stream_rx: Option<mpsc::Receiver<ExecOutputEvent>>,
    pub(in crate::exec_operation) process_output_rx: Option<ProcessOutputReceiver>,
    pub(in crate::exec_operation) registration_guard: ExecOperationRegistrationGuard,
    pub(in crate::exec_operation) tracks_normal_operation: bool,
}

pub(in crate::exec_operation) enum ExecCaptureState {
    Discard,
    Capture { limit_bytes: usize },
}

pub(in crate::exec_operation) struct ExecStreamState {
    pub(in crate::exec_operation) limit_bytes: usize,
    pub(in crate::exec_operation) chunk_limit_bytes: usize,
    pub(in crate::exec_operation) emitted_bytes: usize,
    pub(in crate::exec_operation) truncated: bool,
}

pub(in crate::exec_operation) struct ExecOperationRegistrationGuard {
    pub(in crate::exec_operation) shared: Arc<Shared>,
    pub(in crate::exec_operation) route_id: RouteId,
    pub(in crate::exec_operation) disarmed: bool,
}

pub(in crate::exec_operation) struct PendingExecControlGuard {
    pub(in crate::exec_operation) shared: Arc<Shared>,
    pub(in crate::exec_operation) request_route_id: RouteId,
}

impl ExecOperationRegistrationGuard {
    pub(in crate::exec_operation) fn new(shared: Arc<Shared>, route_id: RouteId) -> Self {
        Self {
            shared,
            route_id,
            disarmed: false,
        }
    }

    pub(in crate::exec_operation) fn disarm(&mut self) {
        self.disarmed = true;
    }
}

impl Drop for ExecOperationRegistrationGuard {
    fn drop(&mut self) {
        if !self.disarmed {
            self.shared.remove_operation(self.route_id);
        }
    }
}

impl PendingExecControlGuard {
    pub(in crate::exec_operation) fn new(shared: Arc<Shared>, request_route_id: RouteId) -> Self {
        Self {
            shared,
            request_route_id,
        }
    }
}

impl Drop for PendingExecControlGuard {
    fn drop(&mut self) {
        remove_pending_exec_control(&self.shared, self.request_route_id);
    }
}

pub(in crate::exec_operation) fn output_policy_streams(policy: ExecOutputPolicy) -> bool {
    matches!(
        policy,
        ExecOutputPolicy::Stream { .. } | ExecOutputPolicy::CaptureAndStream { .. }
    )
}

pub(in crate::exec_operation) fn stream_queue_capacity_for(
    stdout: ExecOutputPolicy,
    stderr: ExecOutputPolicy,
    requested: Option<usize>,
) -> io::Result<Option<usize>> {
    if matches!(requested, Some(0)) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "exec stream queue capacity must be positive",
        ));
    }
    if let Some(capacity) = requested
        && capacity > MAX_EXEC_STREAM_CAPACITY
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("exec stream queue capacity must be at most {MAX_EXEC_STREAM_CAPACITY}"),
        ));
    }
    let streams_output = output_policy_streams(stdout) || output_policy_streams(stderr);
    if !streams_output && requested.is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "exec stream queue capacity requires a streaming output policy",
        ));
    }
    if streams_output {
        Ok(Some(requested.unwrap_or(DEFAULT_EXEC_STREAM_CAPACITY)))
    } else {
        Ok(None)
    }
}

pub(in crate::exec_operation) fn capture_state(policy: ExecOutputPolicy) -> ExecCaptureState {
    match policy {
        ExecOutputPolicy::Discard | ExecOutputPolicy::Stream { .. } => ExecCaptureState::Discard,
        ExecOutputPolicy::Capture { limit_bytes }
        | ExecOutputPolicy::CaptureAndStream {
            capture_limit_bytes: limit_bytes,
            ..
        } => ExecCaptureState::Capture {
            limit_bytes: limit_bytes as usize,
        },
    }
}

pub(in crate::exec_operation) fn stream_state(policy: ExecOutputPolicy) -> Option<ExecStreamState> {
    match policy {
        ExecOutputPolicy::Stream {
            limit_bytes,
            chunk_limit_bytes,
        }
        | ExecOutputPolicy::CaptureAndStream {
            stream_limit_bytes: limit_bytes,
            chunk_limit_bytes,
            ..
        } => Some(ExecStreamState {
            limit_bytes: limit_bytes as usize,
            chunk_limit_bytes: chunk_limit_bytes as usize,
            emitted_bytes: 0,
            truncated: false,
        }),
        ExecOutputPolicy::Discard | ExecOutputPolicy::Capture { .. } => None,
    }
}

pub(in crate::exec_operation) fn register_exec_operation_start(
    shared: &Arc<Shared>,
    input: ExecOperationRegistrationInput<'_>,
) -> io::Result<ExecOperationRegistration> {
    let ExecOperationRegistrationInput {
        label,
        timeout_is_expected,
        stdout,
        stderr,
        stream_queue_capacity,
        stream_queue_kind,
        lifecycle,
        role,
        tracking,
    } = input;
    let (stream_tx, stream_rx, process_output_rx) = match (stream_queue_capacity, stream_queue_kind)
    {
        (Some(capacity), ExecStreamQueueKind::Events) => {
            let (tx, rx) = mpsc::channel(capacity);
            (Some(ExecStreamSender::Events(tx)), Some(rx), None)
        }
        (Some(capacity), ExecStreamQueueKind::ProcessOutput) => {
            let (tx, rx) = mpsc::channel(capacity);
            (Some(ExecStreamSender::ProcessOutput(tx)), None, Some(rx))
        }
        (None, _) => (None, None, None),
    };
    let (result_tx, result_rx) = oneshot::channel();
    let normal_operation = match tracking {
        ExecOperationTracking::Tracked => Some(ExecOperationNormalTracking::Owned(
            shared.reserve_normal_operation()?,
        )),
        ExecOperationTracking::Composite(normal_operation) => Some(
            ExecOperationNormalTracking::Composite(normal_operation.transition_handle()),
        ),
        ExecOperationTracking::Untracked => None,
    };
    let tracks_normal_operation = normal_operation.is_some();
    let (route_id, diagnostic) = shared.register_route(|route_id, state| {
        let supervised = matches!(
            lifecycle,
            ExecOperationLifecycle::SupervisedAwaitingStart { .. }
        );
        let diagnostic = ExecOperationDiagnostic::new(
            route_id.wire_seq(),
            label,
            role,
            supervised,
            timeout_is_expected,
        );
        let operation = ExecOperation {
            route_id,
            normal_operation,
            lifecycle,
            diagnostic: diagnostic.clone(),
            result_tx,
            stream_tx,
            stdout_capture: capture_state(stdout),
            stderr_capture: capture_state(stderr),
            stdout_stream: stream_state(stdout),
            stderr_stream: stream_state(stderr),
            expected_output_seq: 0,
            stream_overflowed: false,
            host_cancel_requested: false,
            pending_controls: HashMap::new(),
        };
        let ConnectionState::Connected { operations, .. } = state else {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "connection closed",
            ));
        };
        operations.insert(route_id, operation);
        Ok(diagnostic)
    })?;

    Ok(ExecOperationRegistration {
        route_id,
        diagnostic,
        result_rx,
        stream_rx,
        process_output_rx,
        registration_guard: ExecOperationRegistrationGuard::new(Arc::clone(shared), route_id),
        tracks_normal_operation,
    })
}
