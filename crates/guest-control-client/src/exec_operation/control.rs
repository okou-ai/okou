//! Exec-control requests own an acknowledgement lifetime independent of exec waits.

use std::io;
use std::sync::Arc;
use std::time::Duration;

use guest_control_proto::ExecControlNonce;
use tokio::sync::oneshot;

use crate::{ConnectionState, FrameWriteObserver, RouteId, Shared};

use super::frame::{
    mark_pending_exec_control_possible_guest_write, write_encoded_frame_with_pre_write,
};
use super::state::{PendingExecControl, PendingExecControlGuard};
use super::types::{ExecControlAck, ExecControlOutcome};

// Leave time for dispatch and transport of the Guest's deadline result without
// extending the Guest-local sink delivery budget.
const EXEC_CONTROL_RESPONSE_ALLOWANCE: Duration = Duration::from_millis(250);

/// Cloneable handle for sending control messages to a supervised exec operation.
#[derive(Clone)]
pub struct ExecControlHandle {
    pub(in crate::exec_operation) shared: Arc<Shared>,
    pub(in crate::exec_operation) target_route_id: RouteId,
    pub(in crate::exec_operation) control_nonce: ExecControlNonce,
}

impl ExecControlHandle {
    /// Send an exec-control request and require a delivered acknowledgement.
    ///
    /// `message_id` must be non-empty and fit the protocol string length
    /// bound. `payload` must fit the exec-control payload limit. Invalid
    /// inputs fail before the request frame is written. `timeout` is the
    /// Guest-local control delivery budget, encoded in whole milliseconds:
    /// zero stays zero, positive sub-millisecond values become 1 ms, and large
    /// values saturate at `u32::MAX` ms. After writing the request frame, the
    /// Host waits for this encoded budget plus a 250 ms response allowance so
    /// it can retain the Guest's deadline result. This does not bound earlier
    /// write queuing or the frame write itself.
    ///
    /// Only [`ExecControlOutcome::Delivered`] is returned as an
    /// [`ExecControlAck`]. Guest statuses and guest error responses are
    /// converted into `io::Error` values.
    ///
    /// # Response abandonment
    ///
    /// If the host response wait expires after the request frame is written,
    /// or this future is cancelled after the frame may have been written, the
    /// guest may have received the request without the host retaining proof of
    /// its response. The connection is then unsafe for later normal operations
    /// or pooling and must be discarded. A late control result or the
    /// supervised exec's eventual terminal result does not restore reusability.
    /// Cancelling this future before the frame may have been written does not
    /// have this consequence.
    ///
    /// A guest-reported [`guest_control_proto::ExecControlStatus::SinkTimeout`] is
    /// different: it is a matched response and does not by itself make the
    /// connection unsafe. This method converts both that guest status and a
    /// host response timeout to `io::ErrorKind::TimedOut`. Call
    /// [`ExecControlHandle::control_with_write_observer`] when the distinction
    /// matters; it returns matched guest statuses as
    /// [`ExecControlOutcome::GuestStatus`].
    pub async fn control(
        &self,
        message_id: &str,
        payload: &[u8],
        timeout: Duration,
    ) -> io::Result<ExecControlAck> {
        self.control_with_write_observer(
            message_id,
            payload,
            timeout,
            FrameWriteObserver::default(),
        )
        .await?
        .into_ack()
    }

    /// Send an owned exec-control request and require a delivered acknowledgement.
    ///
    /// This has the same behavior as [`Self::control`] but transfers ownership
    /// of `message_id` and `payload` so callers that already own large request
    /// data do not need to clone it before frame encoding.
    pub async fn control_owned(
        &self,
        message_id: String,
        payload: Vec<u8>,
        timeout: Duration,
    ) -> io::Result<ExecControlAck> {
        self.control_owned_with_write_observer(
            message_id,
            payload,
            timeout,
            FrameWriteObserver::default(),
        )
        .await?
        .into_ack()
    }

    /// Send an exec-control request and return the raw guest outcome.
    ///
    /// This has the same input, timeout, cancellation, and connection-lifecycle
    /// contract as [`ExecControlHandle::control`], but returns
    /// [`ExecControlOutcome`] so callers can distinguish delivered requests,
    /// non-delivered guest statuses, and guest error responses.
    pub async fn control_with_write_observer(
        &self,
        message_id: &str,
        payload: &[u8],
        timeout: Duration,
        write_observer: FrameWriteObserver,
    ) -> io::Result<ExecControlOutcome> {
        let request_timeout_ms = duration_to_request_timeout_ms(timeout);
        guest_control_proto::validate_exec_control(
            self.target_route_id.wire_seq(),
            self.control_nonce,
            message_id,
            payload,
            request_timeout_ms,
        )
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
        self.control_owned_with_write_observer(
            message_id.to_owned(),
            payload.to_vec(),
            timeout,
            write_observer,
        )
        .await
    }

    /// Send owned exec-control data and return the raw outcome.
    ///
    /// This is the owned-data counterpart to
    /// [`Self::control_with_write_observer`].
    pub async fn control_owned_with_write_observer(
        &self,
        message_id: String,
        payload: Vec<u8>,
        timeout: Duration,
        write_observer: FrameWriteObserver,
    ) -> io::Result<ExecControlOutcome> {
        exec_control_on_shared(
            &self.shared,
            self.target_route_id,
            self.control_nonce,
            message_id,
            payload,
            timeout,
            write_observer,
        )
        .await
    }
}

pub(in crate::exec_operation) fn duration_to_request_timeout_ms(timeout: Duration) -> u32 {
    if timeout.is_zero() {
        return 0;
    }

    u32::try_from(timeout.as_millis())
        .unwrap_or(u32::MAX)
        .max(1)
}

pub(in crate::exec_operation) async fn exec_control_on_shared(
    shared: &Arc<Shared>,
    target_route_id: RouteId,
    control_nonce: ExecControlNonce,
    message_id: String,
    control_payload: Vec<u8>,
    timeout: Duration,
    write_observer: FrameWriteObserver,
) -> io::Result<ExecControlOutcome> {
    let request_timeout_ms = duration_to_request_timeout_ms(timeout);
    let response_timeout =
        Duration::from_millis(u64::from(request_timeout_ms)) + EXEC_CONTROL_RESPONSE_ALLOWANCE;
    let target_seq = target_route_id.wire_seq();
    guest_control_proto::validate_exec_control(
        target_seq,
        control_nonce,
        &message_id,
        &control_payload,
        request_timeout_ms,
    )
    .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
    let normal_operation = shared.reserve_normal_operation()?;
    let (response_tx, response_rx) = oneshot::channel();
    let (request_route_id, ()) = shared.register_route(|request_route_id, state| {
        let ConnectionState::Connected { operations, .. } = state else {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "connection closed",
            ));
        };
        operations.insert_pending_control(
            target_route_id,
            request_route_id,
            PendingExecControl {
                route_id: request_route_id,
                target_route_id,
                message_id: message_id.clone(),
                control_nonce,
                response_tx,
                normal_operation,
            },
        )
    })?;
    let _pending_guard = PendingExecControlGuard::new(Arc::clone(shared), request_route_id);
    let request_seq = request_route_id.wire_seq();
    let mut frame = Vec::new();
    guest_control_proto::encode_exec_control_frame_into(
        &mut frame,
        request_seq,
        target_seq,
        control_nonce,
        &message_id,
        &control_payload,
        request_timeout_ms,
    )
    .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
    drop(control_payload);
    drop(message_id);
    write_encoded_frame_with_pre_write(shared, &frame, None, || {
        mark_pending_exec_control_possible_guest_write(shared, target_route_id, request_route_id)?;
        write_observer.record_write_start()
    })
    .await?;
    drop(frame);

    tokio::select! {
        biased;
        result = response_rx => {
            result.map_err(|_| io::Error::new(
                io::ErrorKind::ConnectionReset,
                "connection closed",
            ))?
        }
        _ = tokio::time::sleep(response_timeout) => {
            Err(io::Error::new(io::ErrorKind::TimedOut, "request timeout"))
        }
    }
}
