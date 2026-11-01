use std::io;
use std::sync::Arc;
use std::time::Duration;

use guest_control_proto::{
    FileWriteStatus, MSG_ERROR, MSG_FILE_WRITE_STATUS, MSG_FILE_WRITE_STATUS_RESULT,
    MSG_MEMORY_SNAPSHOT, MSG_MEMORY_SNAPSHOT_RESULT, MSG_OPERATIONS_QUIESCED,
    MSG_OPERATIONS_RESUMED, MSG_QUIESCE_OPERATIONS, MSG_RESUME_OPERATIONS, MSG_SHUTDOWN,
    MSG_SHUTDOWN_ACK, MemorySnapshot, RawMessage,
};
use sandbox::StorageManifestRequestTiming;
use tokio::sync::oneshot;
use tokio::time::{self, Instant};

use crate::operation_tracker::{
    NormalOperationRejection, NormalOperationToken, NormalOperationTransitionError,
    NormalOperationTransitionHandle,
};
use crate::request_progress::RequestWriteProgress;
use crate::{FrameWriteObserver, GuestControlClient, RequestTimeoutError, RequestTimeoutStage};

use super::{
    ConnectionState, FrameWriteDecision, PendingNormalOperation, PendingResponse, RouteId, Shared,
};

struct PendingRequestGuard {
    shared: Arc<Shared>,
    route_id: RouteId,
}

struct RequestBudget {
    deadline: Instant,
    timeout: Duration,
}

impl RequestBudget {
    fn is_expired(&self) -> bool {
        Instant::now() >= self.deadline
    }

    fn before_write_timeout(&self) -> io::Error {
        request_timeout_error(RequestTimeoutStage::BeforeFrameWrite, self.timeout)
    }
}

impl GuestControlClient {
    /// Read the latest guest file-write stage without changing operation gates.
    ///
    /// This control query remains usable after normal writes become uncertain
    /// and while quiescing. It provides no terminal proof and never re-enables
    /// normal operations. The caller's budget covers frame write and response.
    pub async fn file_write_status(&self, timeout: Duration) -> io::Result<FileWriteStatus> {
        let response = request_on_shared(&self.shared, MSG_FILE_WRITE_STATUS, &[], timeout).await?;
        if response.msg_type != MSG_FILE_WRITE_STATUS_RESULT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unexpected file-write status response",
            ));
        }
        FileWriteStatus::decode_payload(&response.payload)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }
}

impl Drop for PendingRequestGuard {
    fn drop(&mut self) {
        self.shared.remove_pending(self.route_id);
    }
}

pub(crate) struct CompositeNormalOperation {
    normal_operation: NormalOperationToken,
}

impl CompositeNormalOperation {
    pub(crate) fn from_token(normal_operation: NormalOperationToken) -> Self {
        Self { normal_operation }
    }

    pub(crate) fn reserve(shared: &Arc<Shared>) -> io::Result<Self> {
        Ok(Self::from_token(shared.reserve_normal_operation()?))
    }

    pub(crate) fn transition_handle(&self) -> NormalOperationTransitionHandle {
        self.normal_operation.transition_handle()
    }

    pub(crate) fn complete(self) -> io::Result<()> {
        // Terminal proof can race with connection close, which clears tracker
        // operations. Completion is idempotent for the composite owner.
        match self.normal_operation.complete() {
            Ok(()) | Err(NormalOperationTransitionError::UnknownOperation { .. }) => Ok(()),
            Err(error) => Err(normal_operation_transition_error(error)),
        }
    }
}

/// Send a request and wait for a response with matching sequence number.
pub(crate) async fn request_on_shared(
    shared: &Arc<Shared>,
    msg_type: u8,
    payload: &[u8],
    timeout: Duration,
) -> io::Result<RawMessage> {
    if timeout.is_zero() {
        return Err(request_timeout_error(
            RequestTimeoutStage::BeforeFrameWrite,
            timeout,
        ));
    }
    let deadline = deadline_after(timeout, "request timeout overflowed")?;
    request_raw_on_shared(shared, msg_type, payload, deadline, timeout).await
}

async fn write_request_frame(
    shared: &Arc<Shared>,
    data: &[u8],
    budget: &RequestBudget,
    before_write: impl FnOnce() -> io::Result<()>,
    progress: &RequestWriteProgress,
    timing: Option<&mut StorageManifestRequestTiming>,
) -> io::Result<()> {
    let decision = shared
        .write_frame(
            data,
            || {
                // A ready lock can be polled before timeout_at notices expiry.
                // Reject before tracker/observer side effects or partial writes.
                if budget.is_expired() {
                    return Ok(FrameWriteDecision::Skip);
                }
                before_write()?;
                progress.mark_frame_write();
                Ok(FrameWriteDecision::Write)
            },
            |observed, _| {
                if let Some(timing) = timing {
                    timing.writer_wait = Some(observed.wait);
                    timing.frame_write = Some(observed.write);
                }
            },
        )
        .await?;
    if decision == FrameWriteDecision::Skip {
        // Keep deadline errors distinct from ordinary admission/write errors.
        return Err(budget.before_write_timeout());
    }
    progress.mark_awaiting_terminal_response();
    Ok(())
}

#[cfg(test)]
pub(crate) async fn write_request_frame_with_builder(
    shared: &Arc<Shared>,
    seq: u32,
    timeout: Duration,
    build_frame: impl FnOnce(u32, &mut Vec<u8>) -> io::Result<()>,
    before_write: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    let progress = RequestWriteProgress::default();
    let budget = RequestBudget {
        deadline: deadline_after(timeout, "request timeout overflowed")?,
        timeout,
    };
    write_request_frame_with_builder_and_progress(
        shared,
        seq,
        build_frame,
        &budget,
        before_write,
        &progress,
        None,
    )
    .await
}

async fn write_request_frame_with_builder_and_progress(
    shared: &Arc<Shared>,
    seq: u32,
    build_frame: impl FnOnce(u32, &mut Vec<u8>) -> io::Result<()>,
    budget: &RequestBudget,
    before_write: impl FnOnce() -> io::Result<()>,
    progress: &RequestWriteProgress,
    mut timing: Option<&mut StorageManifestRequestTiming>,
) -> io::Result<()> {
    let wait_started = timing.as_ref().map(|_| Instant::now());
    let frame_builder_guard = shared.frame_builder.lock().await;
    if let (Some(timing), Some(started)) = (timing.as_deref_mut(), wait_started) {
        timing.frame_builder_wait = Some(started.elapsed());
    }
    if budget.is_expired() {
        return Err(budget.before_write_timeout());
    }
    let mut frame = Vec::new();
    let encode_started = timing.as_ref().map(|_| Instant::now());
    let encoded = build_frame(seq, &mut frame);
    if let (Some(timing), Some(started)) = (timing.as_deref_mut(), encode_started) {
        timing.frame_encode = Some(started.elapsed());
    }
    encoded?;
    let result = write_request_frame(shared, &frame, budget, before_write, progress, timing).await;
    drop(frame);
    drop(frame_builder_guard);
    result
}

fn encode_request_frame(msg_type: u8, seq: u32, payload: &[u8]) -> io::Result<Vec<u8>> {
    guest_control_proto::encode(msg_type, seq, payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))
}

fn register_pending_response(
    shared: &Arc<Shared>,
    build_pending: impl FnOnce(RouteId, oneshot::Sender<RawMessage>) -> io::Result<PendingResponse>,
) -> io::Result<(oneshot::Receiver<RawMessage>, PendingRequestGuard)> {
    // Register under the state lock: `Closed` short-circuits to an
    // immediate error, and insertion into `pending` is serialised with
    // the `Connected -> Closed` transition in `close()`. There is no
    // post-write `is_closed` check because close is observed via the
    // oneshot receiver becoming `Closed` when `close()` drops the map.
    let (tx, rx) = oneshot::channel();
    let (route_id, ()) = shared.register_route(|route_id, state| {
        let ConnectionState::Connected { pending, .. } = state else {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "connection closed",
            ));
        };
        let pending_response = build_pending(route_id, tx)?;
        assert!(
            pending
                .insert(route_id.wire_seq(), pending_response)
                .is_none(),
            "pending response route must be vacant"
        );
        Ok(())
    })?;
    Ok((
        rx,
        PendingRequestGuard {
            shared: Arc::clone(shared),
            route_id,
        },
    ))
}

async fn write_registered_request_and_wait(
    shared: &Arc<Shared>,
    data: &[u8],
    deadline: Instant,
    timeout: Duration,
    before_write: impl FnOnce() -> io::Result<()>,
    rx: oneshot::Receiver<RawMessage>,
) -> io::Result<RawMessage> {
    // The pending guard removes the pending entry on write failure, timeout,
    // or cancellation before reader_loop dispatches a response. The write
    // helper separately poisons the connection if cancellation interrupts an
    // in-progress frame write.
    let progress = RequestWriteProgress::default();
    let budget = RequestBudget { deadline, timeout };
    time::timeout_at(
        deadline,
        write_request_frame(shared, data, &budget, before_write, &progress, None),
    )
    .await
    .map_err(|_| request_timeout_error(progress.timeout_stage(), timeout))??;

    await_pending_response(rx, deadline, timeout).await
}

async fn write_registered_request_and_wait_with_frame_builder(
    shared: &Arc<Shared>,
    seq: u32,
    build_frame: impl FnOnce(u32, &mut Vec<u8>) -> io::Result<()>,
    budget: RequestBudget,
    before_write: impl FnOnce() -> io::Result<()>,
    rx: oneshot::Receiver<RawMessage>,
    mut timing: Option<&mut StorageManifestRequestTiming>,
) -> io::Result<RawMessage> {
    let progress = RequestWriteProgress::default();
    time::timeout_at(
        budget.deadline,
        write_request_frame_with_builder_and_progress(
            shared,
            seq,
            build_frame,
            &budget,
            before_write,
            &progress,
            timing.as_deref_mut(),
        ),
    )
    .await
    .map_err(|_| request_timeout_error(progress.timeout_stage(), budget.timeout))??;

    let wait_started = timing.as_ref().map(|_| Instant::now());
    let response = await_pending_response(rx, budget.deadline, budget.timeout).await;
    if let (Some(timing), Some(started)) = (timing, wait_started) {
        timing.response_wait = Some(started.elapsed());
    }
    response
}

async fn await_pending_response(
    rx: oneshot::Receiver<RawMessage>,
    deadline: Instant,
    timeout: Duration,
) -> io::Result<RawMessage> {
    // `rx` returns `Ok(msg)` when the reader dispatches a response and
    // `Err(RecvError)` when `close()` drops the `Connected` variant. The
    // timeout arm is the only other way out.
    tokio::select! {
        biased;
        result = rx => {
            result.map_err(|_| io::Error::new(
                io::ErrorKind::ConnectionReset,
                "connection closed",
            ))
        }
        _ = time::sleep_until(deadline) => {
            Err(request_timeout_error(
                RequestTimeoutStage::AwaitingTerminalResponse,
                timeout,
            ))
        }
    }
}

fn request_timeout_error(stage: RequestTimeoutStage, timeout: Duration) -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        RequestTimeoutError::new(stage, timeout),
    )
}

async fn request_raw_on_shared(
    shared: &Arc<Shared>,
    msg_type: u8,
    payload: &[u8],
    deadline: Instant,
    timeout: Duration,
) -> io::Result<RawMessage> {
    let (rx, pending_guard) = register_pending_response(shared, |route_id, tx| {
        Ok(PendingResponse {
            route_id,
            response_tx: tx,
            normal_operation: None,
            normal_terminal_msg_types: &[],
        })
    })?;
    let route_id = pending_guard.route_id;
    let seq = route_id.wire_seq();
    let data = encode_request_frame(msg_type, seq, payload)?;

    write_registered_request_and_wait(shared, &data, deadline, timeout, || Ok(()), rx).await
}

pub(crate) async fn normal_request_on_shared_with_write_observer_frame_builder(
    shared: &Arc<Shared>,
    terminal_msg_types: &'static [u8],
    timeout: Duration,
    write_observer: FrameWriteObserver,
    build_frame: impl FnOnce(u32, &mut Vec<u8>) -> io::Result<()>,
) -> io::Result<RawMessage> {
    normal_request_on_shared_with_timing_frame_builder(
        shared,
        terminal_msg_types,
        timeout,
        write_observer,
        build_frame,
        None,
    )
    .await
}

pub(crate) async fn normal_request_on_shared_with_timing_frame_builder(
    shared: &Arc<Shared>,
    terminal_msg_types: &'static [u8],
    timeout: Duration,
    write_observer: FrameWriteObserver,
    build_frame: impl FnOnce(u32, &mut Vec<u8>) -> io::Result<()>,
    mut timing: Option<&mut StorageManifestRequestTiming>,
) -> io::Result<RawMessage> {
    if timeout.is_zero() {
        return Err(request_timeout_error(
            RequestTimeoutStage::BeforeFrameWrite,
            timeout,
        ));
    }
    let deadline = deadline_after(timeout, "request timeout overflowed")?;
    let setup_started = timing.as_ref().map(|_| Instant::now());
    let registration = (|| {
        let normal_operation = shared.reserve_normal_operation()?;
        register_pending_response(shared, |route_id, tx| {
            Ok(PendingResponse {
                route_id,
                response_tx: tx,
                normal_operation: Some(PendingNormalOperation::Owned(normal_operation)),
                normal_terminal_msg_types: terminal_msg_types,
            })
        })
    })();
    if let (Some(timing), Some(started)) = (timing.as_deref_mut(), setup_started) {
        timing.setup = Some(started.elapsed());
    }
    let (rx, pending_guard) = registration?;
    let route_id = pending_guard.route_id;
    let seq = route_id.wire_seq();

    write_registered_request_and_wait_with_frame_builder(
        shared,
        seq,
        build_frame,
        RequestBudget { deadline, timeout },
        || {
            mark_pending_normal_operation_possible_guest_write(shared, route_id, |_| Ok(()))?;
            write_observer.record_write_start()
        },
        rx,
        timing,
    )
    .await
}

pub(crate) async fn request_on_shared_with_composite_operation_and_observer_frame_builder(
    shared: &Arc<Shared>,
    terminal_msg_types: &'static [u8],
    timeout: Duration,
    normal_operation: &mut CompositeNormalOperation,
    write_observer: FrameWriteObserver,
    build_frame: impl FnOnce(u32, &mut Vec<u8>) -> io::Result<()>,
) -> io::Result<RawMessage> {
    if timeout.is_zero() {
        return Err(request_timeout_error(
            RequestTimeoutStage::BeforeFrameWrite,
            timeout,
        ));
    }
    let deadline = deadline_after(timeout, "request timeout overflowed")?;
    let (rx, pending_guard) = register_pending_response(shared, |route_id, tx| {
        Ok(PendingResponse {
            route_id,
            response_tx: tx,
            normal_operation: Some(PendingNormalOperation::Composite(
                normal_operation.transition_handle(),
            )),
            normal_terminal_msg_types: terminal_msg_types,
        })
    })?;
    let route_id = pending_guard.route_id;
    let seq = route_id.wire_seq();

    write_registered_request_and_wait_with_frame_builder(
        shared,
        seq,
        build_frame,
        RequestBudget { deadline, timeout },
        || {
            mark_pending_normal_operation_possible_guest_write(shared, route_id, |_| Ok(()))?;
            write_observer.record_write_start()
        },
        rx,
        None,
    )
    .await
}

fn mark_pending_normal_operation_possible_guest_write(
    shared: &Arc<Shared>,
    route_id: RouteId,
    pre_write: impl FnOnce(&mut ConnectionState) -> io::Result<()>,
) -> io::Result<()> {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    pre_write(&mut guard)?;
    match &mut *guard {
        ConnectionState::Connected { pending, .. } => {
            let seq = route_id.wire_seq();
            let Some(pending_response) = pending.get_mut(&seq) else {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "normal request closed before frame write",
                ));
            };
            if pending_response.route_id != route_id {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "normal request route was replaced before frame write",
                ));
            }
            let Some(normal_operation) = pending_response.normal_operation.as_mut() else {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "normal request missing operation token",
                ));
            };
            mark_pending_normal_operation_possible_guest_write_started(normal_operation)
        }
        ConnectionState::Closed(_) => Err(io::Error::new(
            io::ErrorKind::ConnectionReset,
            "connection closed",
        )),
    }
}

fn mark_pending_normal_operation_possible_guest_write_started(
    normal_operation: &mut PendingNormalOperation,
) -> io::Result<()> {
    match normal_operation {
        PendingNormalOperation::Owned(normal_operation) => normal_operation
            .mark_possible_guest_write_started()
            .map_err(normal_operation_transition_error),
        PendingNormalOperation::Composite(normal_operation) => normal_operation
            .mark_possible_guest_write_started()
            .map_err(normal_operation_transition_error),
    }
}

pub(super) fn complete_pending_normal_operation(
    normal_operation: PendingNormalOperation,
) -> io::Result<()> {
    match normal_operation {
        PendingNormalOperation::Owned(normal_operation) => normal_operation
            .complete()
            .map_err(normal_operation_transition_error),
        PendingNormalOperation::Composite(normal_operation) => normal_operation
            .mark_possible_guest_write_completed()
            .map_err(normal_operation_transition_error),
    }
}

pub(super) fn normal_operation_rejection_error(error: NormalOperationRejection) -> io::Error {
    let kind = match error {
        NormalOperationRejection::Fenced => io::ErrorKind::WouldBlock,
        NormalOperationRejection::NotParkable | NormalOperationRejection::Closed => {
            io::ErrorKind::ConnectionReset
        }
    };
    io::Error::new(kind, error)
}

pub(crate) fn normal_operation_transition_error(
    error: NormalOperationTransitionError,
) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("normal operation transition failed: {error:?}"),
    )
}

fn protocol_invalid_data(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}

fn lifecycle_error_from_response(response: &RawMessage) -> io::Error {
    match guest_control_proto::decode_error(&response.payload) {
        Ok(message) => io::Error::other(message.to_owned()),
        Err(error) => protocol_invalid_data(error),
    }
}

fn validate_empty_lifecycle_response(
    response: &RawMessage,
    payload_name: &'static str,
) -> io::Result<()> {
    guest_control_proto::decode_empty_payload(payload_name, &response.payload)
        .map_err(protocol_invalid_data)
}

pub(super) fn deadline_after(
    timeout: Duration,
    overflow_message: &'static str,
) -> io::Result<Instant> {
    Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, overflow_message))
}

impl GuestControlClient {
    /// Send a request and wait for a response with matching sequence number.
    async fn request(
        &self,
        msg_type: u8,
        payload: &[u8],
        timeout: Duration,
    ) -> io::Result<RawMessage> {
        request_on_shared(&self.shared, msg_type, payload, timeout).await
    }

    async fn lifecycle_request(
        &self,
        request_type: u8,
        expected_response_type: u8,
        response_payload_name: &'static str,
        timeout: Duration,
    ) -> io::Result<()> {
        let response = self.request(request_type, &[], timeout).await?;
        if response.msg_type == MSG_ERROR {
            return Err(lifecycle_error_from_response(&response));
        }
        if response.msg_type != expected_response_type {
            return Err(protocol_invalid_data(format!(
                "unexpected lifecycle response type: expected 0x{expected_response_type:02X}, got 0x{:02X}",
                response.msg_type,
            )));
        }
        validate_empty_lifecycle_response(&response, response_payload_name)
    }

    /// Ask the guest to quiesce its own operation dispatcher.
    ///
    /// On receipt, the guest atomically fences new operations before checking
    /// its pending-operation count. If the guest reports that operations are
    /// still pending, this method returns an error but guest admission remains
    /// fenced. Those operations finish independently; the guest does not wait
    /// or send a later acknowledgement. The caller must either retry this
    /// method after they drain or call [`Self::resume_operations`] to abandon
    /// the attempt and reopen guest admission.
    ///
    /// This does not fence host-side normal operations. Callers that need a
    /// no-new-normal-operation boundary must hold a
    /// [`crate::NormalOperationFence`] before sending this lifecycle request.
    /// A transport error or timeout does not reveal whether the guest received
    /// the request. A caller that keeps using the guest after such an uncertain
    /// attempt must explicitly resume guest operations before releasing its
    /// host-side fence.
    ///
    /// The timeout covers waiting for the shared writer, writing the request,
    /// and waiting for the response.
    ///
    /// # Errors
    ///
    /// Returns the request error if the guest cannot be reached, does not
    /// respond before the deadline, or reports pending operations or another
    /// lifecycle error. An unexpected response type or non-empty
    /// acknowledgement returns [`io::ErrorKind::InvalidData`].
    pub async fn quiesce_operations(&self, timeout: Duration) -> io::Result<()> {
        self.lifecycle_request(
            MSG_QUIESCE_OPERATIONS,
            MSG_OPERATIONS_QUIESCED,
            "operations_quiesced payload must be empty",
            timeout,
        )
        .await
    }

    /// Read aggregate guest memory counters after operations are fully quiesced.
    ///
    /// This is a lifecycle request, so it remains available while a
    /// [`NormalOperationFence`](crate::NormalOperationFence) is held. The
    /// guest rejects it unless operation admission is fenced and no operations
    /// remain pending.
    pub async fn memory_snapshot(&self, timeout: Duration) -> io::Result<MemorySnapshot> {
        let response = self.request(MSG_MEMORY_SNAPSHOT, &[], timeout).await?;
        if response.msg_type == MSG_ERROR {
            return Err(lifecycle_error_from_response(&response));
        }
        if response.msg_type != MSG_MEMORY_SNAPSHOT_RESULT {
            return Err(protocol_invalid_data(format!(
                "unexpected lifecycle response type: expected 0x{MSG_MEMORY_SNAPSHOT_RESULT:02X}, got 0x{:02X}",
                response.msg_type,
            )));
        }
        guest_control_proto::decode_memory_snapshot(&response.payload)
            .map_err(protocol_invalid_data)
    }

    /// Resume guest operations after a failed or aborted quiesce attempt.
    ///
    /// Resume reopens guest admission immediately without waiting for
    /// previously admitted operations to finish. The transition is idempotent,
    /// so callers may use it after a guest-reported busy result or a
    /// delivery-uncertain quiesce failure. This does not release a held
    /// [`crate::NormalOperationFence`]; the caller retains ownership of that
    /// host-side boundary.
    ///
    /// The timeout covers waiting for the shared writer, writing the request,
    /// and waiting for the response.
    ///
    /// # Errors
    ///
    /// Returns the request error if the guest cannot be reached, does not
    /// respond before the deadline, or reports a lifecycle error. An unexpected
    /// response type or non-empty acknowledgement returns
    /// [`io::ErrorKind::InvalidData`].
    pub async fn resume_operations(&self, timeout: Duration) -> io::Result<()> {
        self.lifecycle_request(
            MSG_RESUME_OPERATIONS,
            MSG_OPERATIONS_RESUMED,
            "operations_resumed payload must be empty",
            timeout,
        )
        .await
    }

    /// Request graceful shutdown from guest.
    ///
    /// Once the guest receives a valid shutdown request, its connection loop
    /// is terminal: after attempting to write `MSG_SHUTDOWN_ACK`, it stops
    /// dispatching later frames and waits for the host to disconnect. This
    /// remains true when the acknowledgement write fails and the host cannot
    /// observe it.
    ///
    /// A transport error, timeout, or cancellation after the request may have
    /// been written does not reveal whether the guest received it. This method
    /// does not expose which side of that boundary a failure or cancellation
    /// occurred on. Unless other synchronization proves that no frame started
    /// writing, treat the guest lifecycle state as uncertain and do not attempt
    /// later operations on this connection.
    ///
    /// `Ok(())` confirms that the host received a matching, valid
    /// `MSG_SHUTDOWN_ACK`. It does not wait for or prove guest connection-loop
    /// exit, guest-process termination, or VM termination.
    ///
    /// The timeout covers waiting for the shared writer, writing the request,
    /// and waiting for the acknowledgement.
    ///
    /// # Errors
    ///
    /// Returns the request error if the guest cannot be reached or does not
    /// acknowledge before the deadline. An unexpected response type or a
    /// non-empty acknowledgement returns [`io::ErrorKind::InvalidData`].
    /// When initial request registration finds an already-closed transport,
    /// the error's source is [`crate::ConnectionClosedAtAdmission`], retaining
    /// the first close facts. Failures after registration do not use that marker.
    pub async fn shutdown(&self, timeout: Duration) -> io::Result<()> {
        self.lifecycle_request(
            MSG_SHUTDOWN,
            MSG_SHUTDOWN_ACK,
            "shutdown_ack payload must be empty",
            timeout,
        )
        .await
    }
}
