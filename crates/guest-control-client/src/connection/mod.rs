mod frame;
mod listener;
mod request;
mod timing;

pub use timing::GuestConnectionTiming;

use std::collections::HashMap;
use std::io;
use std::os::unix::io::RawFd;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
#[cfg(test)]
use std::time::Duration;

use guest_control_proto::{BorrowedRawMessage, DecodeWithError, Decoder, RawMessage};
use tokio::io::AsyncReadExt;
use tokio::sync::{Notify, oneshot};

use crate::operation_tracker::{
    NormalOperationToken, NormalOperationTracker, NormalOperationTransitionHandle,
};
use crate::{GuestControlClient, exec_operation};

pub(crate) use frame::{FrameWriteDecision, FrameWriteTiming};
pub(super) use request::{
    CompositeNormalOperation, normal_operation_transition_error,
    normal_request_on_shared_with_write_observer_frame_builder,
    request_on_shared_with_composite_operation_and_observer_frame_builder,
};
#[cfg(test)]
pub(super) use request::{request_on_shared, write_request_frame_with_builder};

const READ_BUF_SIZE: usize = 64 * 1024;

/// Connection lifecycle, expressed as data rather than a separate atomic flag.
///
/// Pending requests, active exec operations, queued-frame route reservations,
/// and connected process state live inside the `Connected` variant so new
/// registrations are structurally unreachable once the reader task has exited.
///
/// The invariant "connection is closed ⇔ registrations are impossible" is
/// enforced by the type: every code path that cares about liveness must
/// `match`, which precludes the old footgun of reading a stale close flag
/// without taking the corresponding lock.
pub(super) enum ConnectionState {
    Connected {
        /// Next logical route identity. Its low 32 bits are used on the wire.
        next_route_id: u64,
        /// Routes held by frames admitted for a future write.
        route_reservations: HashMap<u32, RouteReservationEntry>,
        /// Pending request responses: seq → response route.
        pending: HashMap<u32, PendingResponse>,
        /// Active exec-operation state owned by the exec_operation module.
        operations: exec_operation::Operations,
    },
    Closed,
}

/// Shared state between the reader task and public API methods.
pub(super) struct Shared {
    pub(crate) file_stream: crate::file_stream::State,
    /// Serialises writes to the stream.
    pub(super) writer: tokio::sync::Mutex<tokio::net::unix::OwnedWriteHalf>,
    /// Serialises memory-heavy encoded frame construction without blocking
    /// ordinary writer-lock users such as lifecycle and control frames.
    pub(super) frame_builder: tokio::sync::Mutex<()>,
    /// Serialises file-write request lifecycles through their terminal
    /// responses while allowing control and lifecycle frames to bypass them.
    pub(super) file_write_gate: tokio::sync::Mutex<()>,
    /// Raw fd of the underlying socket, used to poison a corrupted stream.
    pub(super) fd: RawFd,
    /// Counter used only to distinguish temporary file names.
    pub(super) temp_seq: AtomicU32,
    /// Single source of truth for connection liveness plus all per-connection
    /// registration tables. See [`ConnectionState`].
    pub(super) state: std::sync::Mutex<ConnectionState>,
    /// Connection-local tracker for logical normal guest operations.
    ///
    /// Routing maps stay inside [`ConnectionState`]; this tracker records the
    /// neutral operation-readiness facts that sandbox policy can consume later.
    pub(super) normal_operations: NormalOperationTracker,
    /// Notified when the connection closes. Pure signalling — all state is in
    /// `state`.
    pub(super) close_notify: Notify,
    /// One-shot test hook at the unlocked exec-output payload-copy boundary.
    #[cfg(test)]
    pub(super) exec_output_before_copy_hook: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

pub(super) struct PendingResponse {
    route_id: RouteId,
    response_tx: oneshot::Sender<RawMessage>,
    normal_operation: Option<PendingNormalOperation>,
    normal_terminal_msg_types: &'static [u8],
}

pub(super) struct RouteReservationEntry {
    route_id: RouteId,
    holders: usize,
}

pub(super) struct RouteReservation {
    shared: Arc<Shared>,
    route_id: RouteId,
}

enum PendingNormalOperation {
    Owned(NormalOperationToken),
    Composite(NormalOperationTransitionHandle),
}

/// Connection-local registration identity.
///
/// The guest protocol carries only [`Self::wire_seq`]. The complete value
/// distinguishes owners after that wire sequence wraps and is reused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct RouteId(u64);

impl RouteId {
    pub(super) fn wire_seq(self) -> u32 {
        self.0 as u32
    }

    #[cfg(test)]
    pub(crate) fn from_raw(value: u64) -> Self {
        Self(value)
    }
}

impl Shared {
    /// Register one response route while holding the connection-state lock.
    ///
    /// Candidate selection spans ordinary requests, exec operations, and exec
    /// controls so a wire sequence has exactly one live owner. The callback
    /// must insert that owner before returning.
    pub(super) fn register_route<T>(
        &self,
        register: impl FnOnce(RouteId, &mut ConnectionState) -> io::Result<T>,
    ) -> io::Result<(RouteId, T)> {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let route_id = match &mut *guard {
            ConnectionState::Connected {
                next_route_id,
                route_reservations,
                pending,
                operations,
            } => loop {
                let route_id = RouteId(*next_route_id);
                *next_route_id = next_route_id
                    .checked_add(1)
                    .ok_or_else(|| io::Error::other("guest-control route identity exhausted"))?;
                let seq = route_id.wire_seq();
                if seq != 0
                    && !route_reservations.contains_key(&seq)
                    && !pending.contains_key(&seq)
                    && !operations.contains_route_seq(seq)
                {
                    break route_id;
                }
            },
            ConnectionState::Closed => {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ));
            }
        };
        let value = register(route_id, &mut guard)?;
        Ok((route_id, value))
    }

    /// Reserve a route while a frame waits to acquire the writer lock.
    ///
    /// A free route may be reserved for an earlier owner whose frame is still
    /// queued. A route owned by a newer generation cannot be reserved.
    pub(super) fn reserve_exec_route_for_frame(
        self: &Arc<Self>,
        route_id: RouteId,
    ) -> io::Result<Option<RouteReservation>> {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let ConnectionState::Connected {
            route_reservations,
            pending,
            operations,
            ..
        } = &mut *guard
        else {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "connection closed",
            ));
        };
        let seq = route_id.wire_seq();
        if route_reservations
            .get(&seq)
            .is_some_and(|reservation| reservation.route_id != route_id)
        {
            return Ok(None);
        }
        let owns_exec_route = operations.contains_route(route_id);
        if !owns_exec_route && (pending.contains_key(&seq) || operations.contains_route_seq(seq)) {
            return Ok(None);
        }
        match route_reservations.entry(seq) {
            std::collections::hash_map::Entry::Occupied(mut entry) => {
                entry.get_mut().holders += 1;
            }
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(RouteReservationEntry {
                    route_id,
                    holders: 1,
                });
            }
        }
        Ok(Some(RouteReservation {
            shared: Arc::clone(self),
            route_id,
        }))
    }

    /// Get the next temporary-file suffix, skipping zero.
    pub(super) fn next_temp_seq(&self) -> u32 {
        loop {
            let seq = self.temp_seq.fetch_add(1, Ordering::Relaxed);
            if seq != 0 {
                return seq;
            }
        }
    }

    /// Transition `Connected → Closed`, dropping registration maps outside the
    /// state lock so sender drops (which wake their receivers) run without the
    /// lock held. Idempotent: a second call leaves the existing closed state
    /// untouched.
    ///
    /// `mem::replace` writes a placeholder `Closed` state so the old variant
    /// can be moved out for destructuring. The already-`Closed` arm uses an `@`
    /// binding to write the whole variant back unchanged, so double-close is a
    /// structural no-op rather than a convention.
    fn close(&self) {
        self.close_with_reason("connection closed", ConnectionCloseKind::Closed);
    }

    fn close_with_reason(&self, reason: &'static str, kind: ConnectionCloseKind) {
        let maps_to_drop = {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            match std::mem::replace(&mut *guard, ConnectionState::Closed) {
                ConnectionState::Connected {
                    pending,
                    operations,
                    ..
                } => {
                    // Serialize tracker close/poison with terminal dispatch,
                    // which completes tracker tokens under this same state lock.
                    match kind {
                        ConnectionCloseKind::Closed => self.normal_operations.mark_closed(),
                        ConnectionCloseKind::Poisoned => self.normal_operations.mark_not_parkable(),
                    }
                    let exec_operation_snapshot = operations.close_snapshot();
                    *guard = ConnectionState::Closed;
                    Some((pending, operations, exec_operation_snapshot))
                }
                closed @ ConnectionState::Closed => {
                    // Reassign the whole variant by binding rather than by
                    // convention.
                    *guard = closed;
                    None
                }
            }
        };
        if let Some((pending, operations, exec_operation_snapshot)) = maps_to_drop {
            let maps = (pending, operations);
            drop(maps);
            self.close_notify.notify_waiters();
            exec_operation::log_operations_closed(reason, &exec_operation_snapshot);
        }
    }

    pub(super) fn poison_connection(&self) {
        self.close_with_reason("connection poisoned", ConnectionCloseKind::Poisoned);
        let _ = nix::sys::socket::shutdown(self.fd, nix::sys::socket::Shutdown::Both);
    }

    fn remove_pending(&self, route_id: RouteId) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let ConnectionState::Connected { pending, .. } = &mut *guard {
            let seq = route_id.wire_seq();
            if pending
                .get(&seq)
                .is_some_and(|pending| pending.route_id == route_id)
            {
                pending.remove(&seq);
            }
        }
    }

    pub(super) fn remove_operation(&self, route_id: RouteId) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let ConnectionState::Connected { operations, .. } = &mut *guard {
            operations.remove(route_id);
        }
    }

    fn release_route_reservation(&self, route_id: RouteId) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let ConnectionState::Connected {
            route_reservations, ..
        } = &mut *guard
        else {
            return;
        };
        let seq = route_id.wire_seq();
        let Some(reservation) = route_reservations.get_mut(&seq) else {
            return;
        };
        if reservation.route_id != route_id {
            return;
        }
        reservation.holders -= 1;
        if reservation.holders == 0 {
            route_reservations.remove(&seq);
        }
    }

    pub(super) fn reserve_normal_operation(&self) -> io::Result<NormalOperationToken> {
        self.normal_operations
            .reserve()
            .map_err(request::normal_operation_rejection_error)
    }
}

impl Drop for RouteReservation {
    fn drop(&mut self) {
        self.shared.release_route_reservation(self.route_id);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConnectionCloseKind {
    Closed,
    Poisoned,
}

impl Drop for GuestControlClient {
    fn drop(&mut self) {
        // Drop registration state synchronously. The shutdown below normally
        // lets `reader_loop` observe EOF and call `close()`, but aborting the
        // reader task can win that race. Closing here makes active exec
        // handles and stream receivers release immediately when the host is
        // dropped.
        self.shared.close();
        // Signal EOF on the socket so the reader_loop's `read()` and the
        // remote peer's blocking `read()` return immediately. Without this,
        // the split stream halves keep the fd alive until the reader task is
        // cancelled, which requires an async yield — not possible in Drop.
        let _ = nix::sys::socket::shutdown(self.fd, nix::sys::socket::Shutdown::Both);
        self._reader.abort();
    }
}

/// Background reader task: owns the read half and decoder exclusively.
///
/// Dispatches responses and exec operation lifecycle frames by seq number.
async fn reader_loop(
    mut reader: tokio::net::unix::OwnedReadHalf,
    mut decoder: Decoder,
    shared: Arc<Shared>,
) {
    let mut buf = Box::new([0u8; READ_BUF_SIZE]);
    loop {
        let n = match reader.read(buf.as_mut()).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        // n <= READ_BUF_SIZE guaranteed by read()
        match decoder.decode_with(buf.get(..n).unwrap_or_default(), |msg| {
            dispatch_reader_frame(&shared, msg)
        }) {
            Ok(()) => {}
            Err(DecodeWithError::Protocol(_)) => break,
            Err(DecodeWithError::Visitor(_)) => {
                shared.poison_connection();
                return;
            }
        }
    }
    // Connection lost — transition state to Closed. `close()` drops all
    // registration maps outside the lock (waking every pending receiver
    // with `RecvError`) and fires `close_notify` so test helpers wake.
    shared.close();
}

fn dispatch_reader_frame(shared: &Arc<Shared>, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
    if crate::file_stream::dispatch_credit(shared, msg)? {
        return Ok(());
    }
    match exec_operation::dispatch_incoming_frame(shared, msg) {
        Ok(true) => {
            return Ok(());
        }
        Ok(false) => {}
        Err(error) => {
            return Err(error);
        }
    }

    let pending_response = {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { pending, .. } => {
                if let Some(mut pending_response) = pending.remove(&msg.seq) {
                    if pending_response
                        .normal_terminal_msg_types
                        .contains(&msg.msg_type)
                        && let Some(normal_operation) = pending_response.normal_operation.take()
                    {
                        request::complete_pending_normal_operation(normal_operation)?;
                    }
                    Some(pending_response)
                } else {
                    None
                }
            }
            ConnectionState::Closed => None,
        }
    };
    if let Some(pending_response) = pending_response {
        let _ = pending_response.response_tx.send(msg.to_owned_message());
    }
    Ok(())
}

#[cfg(test)]
impl GuestControlClient {
    /// Test-only: deterministically await the `Connected → Closed` transition
    /// without relying on a wall-clock sleep. Subscribes to the same
    /// `close_notify` signal that [`Shared::close`] fires on exit, and re-checks
    /// state under the same lock that `close` holds, so no transition is
    /// missed.
    pub(crate) async fn wait_until_closed(&self, timeout: Duration) -> io::Result<()> {
        let deadline = request::deadline_after(timeout, "wait_until_closed timeout overflowed")?;
        loop {
            let notified = self.shared.close_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            if matches!(
                &*self.shared.state.lock().unwrap_or_else(|e| e.into_inner()),
                ConnectionState::Closed
            ) {
                return Ok(());
            }

            tokio::select! {
                biased;
                _ = notified => {}
                _ = tokio::time::sleep_until(deadline) => {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "wait_until_closed: reader did not transition to Closed in time",
                    ));
                }
            }
        }
    }
}
