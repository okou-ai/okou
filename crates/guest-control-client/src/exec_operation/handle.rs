use std::future::Future;
use std::io;
use std::sync::Arc;
use std::time::Duration;

use guest_control_proto::{ExecControlNonce, ExecControlStatus, ExecTermination, MSG_EXEC_CANCEL};
use sandbox::ProcessOutputReceiver;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{self, Instant};

use crate::{ConnectionState, FrameWriteObserver, RouteId, Shared};

use super::EXEC_OPERATION_DROP_CANCEL_WRITE_TIMEOUT;
use super::diagnostics::ExecOperationDiagnostic;
use super::frame::{
    ExecCancelFrameWriteOutcome, admit_exec_cancel_frame, clear_exec_operation_stream_sender,
    exec_cancel_write_observer, mark_pending_exec_control_possible_guest_write,
    send_exec_cancel_frame_for_wait_with_write_start, write_encoded_frame_with_pre_write,
    write_frame,
};
use super::state::{PendingExecControl, PendingExecControlGuard};
use super::types::{
    ExecControlAck, ExecControlOutcome, ExecOperationResult, ExecOutputEvent,
    SupervisedExecStartTiming, exec_control_status_error,
};

// Leave time for dispatch and transport of the Guest's deadline result without
// extending the Guest-local sink delivery budget.
const EXEC_CONTROL_RESPONSE_ALLOWANCE: Duration = Duration::from_millis(250);

/// Handle for a host-side exec operation.
///
/// Dropping the handle removes the host-side registration only. It never sends
/// `MSG_EXEC_CANCEL`; callers that need remote cancellation must call
/// [`ExecOperationHandle::cancel_and_wait`]. See the Exec Operation Lifecycle
/// section in the [`crate`] docs for the cross-handle ownership contract.
#[must_use = "dropping this handle does not cancel the guest; call wait or cancel_and_wait"]
pub struct ExecOperationHandle {
    pub(in crate::exec_operation) wait_core: ExecWaitCore,
    pub(in crate::exec_operation) stream_rx: Option<mpsc::Receiver<ExecOutputEvent>>,
}

pub(in crate::exec_operation) struct ExecWaitCore {
    pub(in crate::exec_operation) shared: Arc<Shared>,
    pub(in crate::exec_operation) route_id: Option<RouteId>,
    pub(in crate::exec_operation) diagnostic: ExecOperationDiagnostic,
    pub(in crate::exec_operation) result_rx:
        Option<oneshot::Receiver<io::Result<ExecOperationResult>>>,
}

#[must_use = "exec operation wait outcomes contain terminal-proof state that must be handled"]
pub(crate) enum ExecOperationWaitOutcome<T> {
    Terminal(io::Result<T>),
    Unproven(io::Error),
}

impl<T> ExecOperationWaitOutcome<T> {
    pub(crate) fn terminal(result: io::Result<T>) -> Self {
        Self::Terminal(result)
    }

    pub(crate) fn unproven(error: io::Error) -> Self {
        Self::Unproven(error)
    }

    pub(crate) fn terminal_observed(&self) -> bool {
        matches!(self, Self::Terminal(_))
    }

    pub(crate) fn map<U>(self, map: impl FnOnce(T) -> U) -> ExecOperationWaitOutcome<U> {
        match self {
            Self::Terminal(result) => ExecOperationWaitOutcome::Terminal(result.map(map)),
            Self::Unproven(error) => ExecOperationWaitOutcome::Unproven(error),
        }
    }

    pub(crate) fn and_then<U>(
        self,
        map: impl FnOnce(T) -> io::Result<U>,
    ) -> ExecOperationWaitOutcome<U> {
        match self {
            Self::Terminal(result) => ExecOperationWaitOutcome::Terminal(result.and_then(map)),
            Self::Unproven(error) => ExecOperationWaitOutcome::Unproven(error),
        }
    }

    pub(crate) fn into_result(self) -> io::Result<T> {
        match self {
            Self::Terminal(result) => result,
            Self::Unproven(error) => Err(error),
        }
    }
}

#[derive(Clone, Copy)]
pub(in crate::exec_operation) enum ExecWaitLifecycle {
    OneShot,
    Supervised,
}

pub(in crate::exec_operation) struct ExecCancelWaitResult {
    pub(in crate::exec_operation) result: ExecOperationResult,
    pub(in crate::exec_operation) cancel_seq: Option<u32>,
}

enum ExecCancelWriteOutcome {
    Terminal(io::Result<ExecOperationResult>),
    CancelSent {
        route_id: RouteId,
        remaining: Duration,
    },
}

impl ExecWaitLifecycle {
    fn operation_closed_message(self) -> &'static str {
        match self {
            ExecWaitLifecycle::OneShot => "exec operation closed",
            ExecWaitLifecycle::Supervised => "supervised exec operation closed",
        }
    }

    fn timeout_error_message(self) -> &'static str {
        match self {
            ExecWaitLifecycle::OneShot => "exec operation timeout",
            ExecWaitLifecycle::Supervised => "supervised exec operation timeout",
        }
    }

    fn log_cancel_sent(self, seq: u32, diagnostic: &ExecOperationDiagnostic) {
        match self {
            ExecWaitLifecycle::OneShot => {
                tracing::info!(
                    seq = seq,
                    label = %diagnostic.label_log,
                    process_class = diagnostic.process_class,
                    operation_kind = diagnostic.operation_kind,
                    elapsed_ms = diagnostic.elapsed_ms(),
                    "exec operation cancel sent"
                );
            }
            ExecWaitLifecycle::Supervised => {
                tracing::info!(
                    seq = seq,
                    label = %diagnostic.label_log,
                    process_class = diagnostic.process_class,
                    operation_kind = diagnostic.operation_kind,
                    elapsed_ms = diagnostic.elapsed_ms(),
                    "supervised exec operation cancel sent"
                );
            }
        }
    }

    fn log_cancel_completed(self, seq: u32, label: &str, registered_at: Instant) {
        match self {
            ExecWaitLifecycle::OneShot => {
                tracing::info!(
                    seq = seq,
                    label = %label,
                    elapsed_ms = registered_at.elapsed().as_millis(),
                    "exec operation cancel completed"
                );
            }
            ExecWaitLifecycle::Supervised => {
                tracing::info!(
                    seq = seq,
                    label = %label,
                    elapsed_ms = registered_at.elapsed().as_millis(),
                    "supervised exec operation cancel completed"
                );
            }
        }
    }

    fn unexpected_cancel_terminal_state_message(self, termination: ExecTermination) -> String {
        match self {
            ExecWaitLifecycle::OneShot => {
                format!("exec cancel returned terminal state: {termination:?}")
            }
            ExecWaitLifecycle::Supervised => {
                format!("supervised exec cancel returned terminal state: {termination:?}")
            }
        }
    }
}

impl ExecCancelWaitResult {
    fn into_expected_cancel_result(
        self,
        lifecycle: ExecWaitLifecycle,
        cancel_label_log: &str,
        registered_at: Instant,
    ) -> io::Result<ExecOperationResult> {
        let Some(seq) = self.cancel_seq else {
            return Ok(self.result);
        };
        if self.result.termination == ExecTermination::Cancelled {
            lifecycle.log_cancel_completed(seq, cancel_label_log, registered_at);
            return Ok(self.result);
        }

        Err(io::Error::other(
            lifecycle.unexpected_cancel_terminal_state_message(self.result.termination),
        ))
    }
}

pub(in crate::exec_operation) async fn send_exec_cancel_frame(
    shared: &Arc<Shared>,
    route_id: RouteId,
    diagnostic: &ExecOperationDiagnostic,
    lifecycle: ExecWaitLifecycle,
) -> io::Result<()> {
    let Some(_reservation) = admit_exec_cancel_frame(shared, route_id)? else {
        return Ok(());
    };
    let payload = guest_control_proto::encode_exec_cancel();
    let seq = route_id.wire_seq();
    write_frame(
        shared,
        MSG_EXEC_CANCEL,
        seq,
        &payload,
        Some(diagnostic.frame("cancel")),
        None,
        exec_cancel_write_observer(shared, route_id),
    )
    .await?;
    lifecycle.log_cancel_sent(seq, diagnostic);
    Ok(())
}

impl ExecWaitCore {
    fn timeout_error(lifecycle: ExecWaitLifecycle) -> io::Error {
        io::Error::new(io::ErrorKind::TimedOut, lifecycle.timeout_error_message())
    }

    fn log_timeout(&self, seq: u32, poison_on_timeout: bool, lifecycle: ExecWaitLifecycle) {
        match lifecycle {
            ExecWaitLifecycle::OneShot => {
                tracing::warn!(
                    seq = seq,
                    label = %self.diagnostic.label_log,
                    process_class = self.diagnostic.process_class,
                    operation_kind = self.diagnostic.operation_kind,
                    elapsed_ms = self.diagnostic.elapsed_ms(),
                    poison_connection = poison_on_timeout,
                    "exec operation wait timeout"
                );
            }
            ExecWaitLifecycle::Supervised => {
                tracing::warn!(
                    seq = seq,
                    label = %self.diagnostic.label_log,
                    process_class = self.diagnostic.process_class,
                    operation_kind = self.diagnostic.operation_kind,
                    elapsed_ms = self.diagnostic.elapsed_ms(),
                    poison_connection = poison_on_timeout,
                    "supervised exec operation wait timeout"
                );
            }
        }
    }

    fn take_result_rx_or_closed(
        &mut self,
        lifecycle: ExecWaitLifecycle,
    ) -> io::Result<oneshot::Receiver<io::Result<ExecOperationResult>>> {
        self.result_rx.take().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::ConnectionReset,
                lifecycle.operation_closed_message(),
            )
        })
    }

    fn complete_taken_result(
        &mut self,
        result: Result<io::Result<ExecOperationResult>, oneshot::error::RecvError>,
    ) -> ExecOperationWaitOutcome<ExecOperationResult> {
        self.route_id = None;
        self.result_rx = None;
        match result {
            Ok(result) => ExecOperationWaitOutcome::terminal(result),
            Err(_) => ExecOperationWaitOutcome::unproven(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "connection closed",
            )),
        }
    }

    fn abandon_timed_out_operation(
        &mut self,
        route_id: RouteId,
        poison_on_timeout: bool,
        lifecycle: ExecWaitLifecycle,
    ) -> io::Error {
        self.shared.remove_operation(route_id);
        self.route_id = None;
        self.result_rx = None;
        self.log_timeout(route_id.wire_seq(), poison_on_timeout, lifecycle);
        if poison_on_timeout {
            self.shared.poison_connection();
        }
        Self::timeout_error(lifecycle)
    }

    pub(in crate::exec_operation) fn new(
        shared: Arc<Shared>,
        route_id: RouteId,
        diagnostic: ExecOperationDiagnostic,
        result_rx: oneshot::Receiver<io::Result<ExecOperationResult>>,
    ) -> Self {
        Self {
            shared,
            route_id: Some(route_id),
            diagnostic,
            result_rx: Some(result_rx),
        }
    }

    pub(in crate::exec_operation) fn shared(&self) -> &Arc<Shared> {
        &self.shared
    }

    pub(in crate::exec_operation) fn diagnostic(&self) -> &ExecOperationDiagnostic {
        &self.diagnostic
    }

    pub(in crate::exec_operation) fn active_route_id(&self) -> Option<RouteId> {
        self.route_id
    }

    pub(in crate::exec_operation) fn active_route_id_or_closed(
        &self,
        message: &'static str,
    ) -> io::Result<RouteId> {
        self.route_id
            .ok_or_else(|| io::Error::new(io::ErrorKind::ConnectionReset, message))
    }

    pub(in crate::exec_operation) fn remove_operation_if_active(&mut self) {
        if let Some(route_id) = self.route_id.take() {
            self.shared.remove_operation(route_id);
        }
    }

    pub(in crate::exec_operation) fn try_take_ready_result(
        &mut self,
    ) -> io::Result<Option<io::Result<ExecOperationResult>>> {
        let Some(rx) = self.result_rx.as_mut() else {
            return Ok(None);
        };

        match rx.try_recv() {
            Ok(result) => {
                self.route_id = None;
                self.result_rx = None;
                Ok(Some(result))
            }
            Err(oneshot::error::TryRecvError::Empty) => Ok(None),
            Err(oneshot::error::TryRecvError::Closed) => {
                self.route_id = None;
                self.result_rx = None;
                Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ))
            }
        }
    }

    async fn wait_with_timeout_future(
        &mut self,
        timeout: impl Future<Output = ()>,
        poison_on_timeout: bool,
        lifecycle: ExecWaitLifecycle,
    ) -> ExecOperationWaitOutcome<ExecOperationResult> {
        tokio::pin!(timeout);
        let route_id = match self.active_route_id_or_closed(lifecycle.operation_closed_message()) {
            Ok(route_id) => route_id,
            Err(error) => return ExecOperationWaitOutcome::unproven(error),
        };
        let Some(rx) = self.result_rx.as_mut() else {
            return ExecOperationWaitOutcome::unproven(io::Error::new(
                io::ErrorKind::ConnectionReset,
                lifecycle.operation_closed_message(),
            ));
        };

        tokio::select! {
            biased;
            result = rx => {
                self.route_id = None;
                self.result_rx = None;
                match result {
                    Ok(result) => ExecOperationWaitOutcome::terminal(result),
                    Err(_) => ExecOperationWaitOutcome::unproven(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        "connection closed",
                    )),
                }
            }
            _ = &mut timeout => {
                ExecOperationWaitOutcome::unproven(
                    self.abandon_timed_out_operation(route_id, poison_on_timeout, lifecycle),
                )
            }
        }
    }

    pub(in crate::exec_operation) async fn wait_with_timeout(
        &mut self,
        timeout: Duration,
        poison_on_timeout: bool,
        lifecycle: ExecWaitLifecycle,
    ) -> ExecOperationWaitOutcome<ExecOperationResult> {
        self.wait_with_timeout_future(tokio::time::sleep(timeout), poison_on_timeout, lifecycle)
            .await
    }

    pub(in crate::exec_operation) async fn wait_with_deadline(
        &mut self,
        deadline: Instant,
        poison_on_timeout: bool,
        lifecycle: ExecWaitLifecycle,
    ) -> ExecOperationWaitOutcome<ExecOperationResult> {
        self.wait_with_timeout_future(
            tokio::time::sleep_until(deadline),
            poison_on_timeout,
            lifecycle,
        )
        .await
    }

    async fn send_cancel_before_terminal_with_deadline(
        &mut self,
        timeout: Duration,
        lifecycle: ExecWaitLifecycle,
    ) -> io::Result<ExecCancelWriteOutcome> {
        if let Some(result) = self.try_take_ready_result()? {
            return Ok(ExecCancelWriteOutcome::Terminal(result));
        }

        let route_id = self.active_route_id_or_closed(lifecycle.operation_closed_message())?;
        let seq = route_id.wire_seq();
        if timeout.is_zero() {
            return Err(self.abandon_timed_out_operation(route_id, false, lifecycle));
        }
        let Some(deadline) = Instant::now().checked_add(timeout) else {
            self.shared.remove_operation(route_id);
            self.route_id = None;
            self.result_rx = None;
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "exec operation cancel timeout is too large",
            ));
        };
        let mut result_rx = self.take_result_rx_or_closed(lifecycle)?;
        let shared = Arc::clone(self.shared());
        let diagnostic = self.diagnostic().clone();
        let (write_started_tx, mut write_started_rx) = oneshot::channel();
        let mut cancel_write = Box::pin(send_exec_cancel_frame_for_wait_with_write_start(
            &shared,
            route_id,
            &diagnostic,
            Some(write_started_tx),
        ));

        let write_outcome = tokio::select! {
            biased;
            _ = &mut write_started_rx => {
                time::timeout_at(deadline, &mut cancel_write)
                    .await
                    .unwrap_or_else(|_| {
                        tracing::warn!(
                            seq = seq,
                            label = %diagnostic.label_log,
                            process_class = diagnostic.process_class,
                            operation_kind = diagnostic.operation_kind,
                            elapsed_ms = diagnostic.elapsed_ms(),
                            "{}",
                            match lifecycle {
                                ExecWaitLifecycle::OneShot => "exec operation cancel write timed out",
                                ExecWaitLifecycle::Supervised => {
                                    "supervised exec operation cancel write timed out"
                                }
                            }
                        );
                        Err(self.abandon_timed_out_operation(route_id, true, lifecycle))
                    })
            }
            result = &mut result_rx => {
                return match self.complete_taken_result(result) {
                    ExecOperationWaitOutcome::Terminal(result) => {
                        Ok(ExecCancelWriteOutcome::Terminal(result))
                    }
                    ExecOperationWaitOutcome::Unproven(error) => Err(error),
                };
            }
            _ = time::sleep_until(deadline) => {
                return Err(self.abandon_timed_out_operation(route_id, false, lifecycle));
            }
            result = &mut cancel_write => {
                result
            }
        };

        match write_outcome? {
            ExecCancelFrameWriteOutcome::AlreadyTerminal => {
                let result = result_rx.await;
                match self.complete_taken_result(result) {
                    ExecOperationWaitOutcome::Terminal(result) => {
                        Ok(ExecCancelWriteOutcome::Terminal(result))
                    }
                    ExecOperationWaitOutcome::Unproven(error) => Err(error),
                }
            }
            ExecCancelFrameWriteOutcome::Sent => {
                self.result_rx = Some(result_rx);
                lifecycle.log_cancel_sent(seq, &diagnostic);
                Ok(ExecCancelWriteOutcome::CancelSent {
                    route_id,
                    remaining: deadline.saturating_duration_since(Instant::now()),
                })
            }
        }
    }

    async fn wait_for_terminal_after_cancel_sent(
        &mut self,
        route_id: RouteId,
        remaining: Duration,
        lifecycle: ExecWaitLifecycle,
    ) -> ExecOperationWaitOutcome<ExecCancelWaitResult> {
        self.wait_with_timeout(remaining, true, lifecycle)
            .await
            .map(|result| ExecCancelWaitResult {
                result,
                cancel_seq: Some(route_id.wire_seq()),
            })
    }
}

impl ExecOperationHandle {
    /// Take the bounded output event receiver for streaming operations.
    pub fn take_stream_receiver(&mut self) -> Option<mpsc::Receiver<ExecOutputEvent>> {
        self.stream_rx.take()
    }

    /// Wait for the terminal exec result.
    ///
    /// On timeout, this removes the host-side operation registration but does
    /// not cancel the guest-side exec operation. If the request may have
    /// reached the guest, normal operations can become unavailable on this
    /// connection even though the connection itself may still be open.
    pub async fn wait(self, timeout: Duration) -> io::Result<ExecOperationResult> {
        self.wait_for_outcome(timeout).await.into_result()
    }

    pub(crate) async fn wait_for_outcome(
        mut self,
        timeout: Duration,
    ) -> ExecOperationWaitOutcome<ExecOperationResult> {
        self.wait_core
            .wait_with_timeout(timeout, false, ExecWaitLifecycle::OneShot)
            .await
    }

    pub(in crate::exec_operation) async fn wait_until_outcome(
        mut self,
        deadline: Instant,
    ) -> ExecOperationWaitOutcome<ExecOperationResult> {
        self.wait_core
            .wait_with_deadline(deadline, false, ExecWaitLifecycle::OneShot)
            .await
    }

    /// Send an explicit cancel request and wait for a cancelled terminal result.
    ///
    /// If the terminal result is already available or wins the race before
    /// cancel reaches the write boundary, this returns that result without
    /// sending a stale cancel frame. `timeout` bounds the full operation:
    /// waiting to write cancel, writing cancel, and waiting for terminal proof.
    /// If the timeout elapses before cancel frame writing starts, cancel did
    /// not reach the guest and the connection is not poisoned. If cancel is
    /// sent but the terminal result does not arrive before the remaining
    /// timeout, the connection is poisoned because guest process state is no
    /// longer known.
    pub async fn cancel_and_wait(self, timeout: Duration) -> io::Result<ExecOperationResult> {
        let cancel_label_log = self.wait_core.diagnostic().label_log.clone();
        let registered_at = self.wait_core.diagnostic().registered_at;
        self.cancel_and_wait_for_terminal_status(timeout)
            .await
            .and_then(|wait_result| {
                wait_result.into_expected_cancel_result(
                    ExecWaitLifecycle::OneShot,
                    &cancel_label_log,
                    registered_at,
                )
            })
            .into_result()
    }

    pub(crate) async fn cancel_and_wait_for_terminal(
        self,
        timeout: Duration,
    ) -> ExecOperationWaitOutcome<ExecOperationResult> {
        self.cancel_and_wait_for_terminal_status(timeout)
            .await
            .map(|wait_result| wait_result.result)
    }

    pub(in crate::exec_operation) async fn cancel_and_wait_for_terminal_status(
        mut self,
        timeout: Duration,
    ) -> ExecOperationWaitOutcome<ExecCancelWaitResult> {
        let (route_id, remaining) = match self
            .wait_core
            .send_cancel_before_terminal_with_deadline(timeout, ExecWaitLifecycle::OneShot)
            .await
        {
            Ok(ExecCancelWriteOutcome::Terminal(result)) => {
                return ExecOperationWaitOutcome::terminal(result).map(|result| {
                    ExecCancelWaitResult {
                        result,
                        cancel_seq: None,
                    }
                });
            }
            Ok(ExecCancelWriteOutcome::CancelSent {
                route_id,
                remaining,
            }) => (route_id, remaining),
            Err(error) => return ExecOperationWaitOutcome::unproven(error),
        };

        self.wait_core
            .wait_for_terminal_after_cancel_sent(route_id, remaining, ExecWaitLifecycle::OneShot)
            .await
    }
}

impl Drop for ExecOperationHandle {
    fn drop(&mut self) {
        self.wait_core.remove_operation_if_active();
    }
}

/// Handle for a host-side supervised exec operation.
///
/// Dropping this handle never sends `MSG_EXEC_CANCEL` and does not remove the
/// operation lifecycle registration. The host keeps the registration until a
/// terminal exec result arrives, the connection closes, or a caller explicitly
/// waits with a timeout that abandons the operation. See the Exec Operation
/// Lifecycle section in the [`crate`] docs for how supervised handles share
/// cancellation and terminal result ownership.
#[must_use = "dropping this handle does not cancel the guest or remove lifecycle registration"]
pub struct SupervisedExecHandle {
    pub(in crate::exec_operation) wait_core: ExecWaitCore,
    pub(in crate::exec_operation) pid: u32,
    pub(in crate::exec_operation) start_timing: SupervisedExecStartTiming,
    pub(in crate::exec_operation) cancel_handle_taken: bool,
    pub(in crate::exec_operation) stream_rx: Option<mpsc::Receiver<ExecOutputEvent>>,
    pub(in crate::exec_operation) process_output_rx: Option<ProcessOutputReceiver>,
    pub(in crate::exec_operation) control: Option<ExecControlHandle>,
}

/// One-shot handle that sends `MSG_EXEC_CANCEL` for a supervised exec operation.
///
/// Dropping this handle without calling [`SupervisedExecCancelHandle::cancel`]
/// does not send cancellation. The paired [`SupervisedExecHandle`] owns the
/// terminal result.
#[must_use = "dropping this cancel handle does not send MSG_EXEC_CANCEL"]
pub struct SupervisedExecCancelHandle {
    shared: Arc<Shared>,
    route_id: RouteId,
    diagnostic: ExecOperationDiagnostic,
}

impl SupervisedExecCancelHandle {
    /// Send the cancel frame without consuming the terminal exec result.
    ///
    /// The paired [`SupervisedExecHandle`] still owns the result receiver and must
    /// be waited or abandoned by its caller. If this times out before the
    /// cancel frame write starts, the paired handle can still observe the
    /// terminal result. If the original operation is already terminal and its
    /// wire sequence belongs to a newer operation, this returns successfully
    /// without sending a stale cancel frame.
    pub async fn cancel(self, timeout: Duration) -> io::Result<()> {
        tokio::time::timeout(
            timeout,
            send_exec_cancel_frame(
                &self.shared,
                self.route_id,
                &self.diagnostic,
                ExecWaitLifecycle::Supervised,
            ),
        )
        .await
        .unwrap_or_else(|_| {
            tracing::warn!(
                seq = self.route_id.wire_seq(),
                label = %self.diagnostic.label_log,
                process_class = self.diagnostic.process_class,
                operation_kind = self.diagnostic.operation_kind,
                elapsed_ms = self.diagnostic.elapsed_ms(),
                "supervised exec operation cancel write timed out"
            );
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "supervised exec cancel write timed out",
            ))
        })
    }
}

impl SupervisedExecHandle {
    /// Guest process id reported by the `exec_started` acknowledgement.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Host and guest timing captured while the supervised start completed.
    pub fn start_timing(&self) -> SupervisedExecStartTiming {
        self.start_timing
    }

    /// Return a cloneable exec-control handle when control was enabled.
    pub fn control_handle(&self) -> Option<ExecControlHandle> {
        self.control.clone()
    }

    /// Take a one-shot handle that can send `MSG_EXEC_CANCEL` without consuming
    /// this handle's terminal result receiver.
    pub fn take_cancel_handle(&mut self) -> Option<SupervisedExecCancelHandle> {
        if self.cancel_handle_taken {
            return None;
        }
        let route_id = self.wait_core.active_route_id()?;
        self.cancel_handle_taken = true;
        Some(SupervisedExecCancelHandle {
            shared: Arc::clone(self.wait_core.shared()),
            route_id,
            diagnostic: self.wait_core.diagnostic().clone(),
        })
    }

    /// Send an exec-control request for this supervised operation.
    ///
    /// This has the same input, timeout, cancellation, and connection-lifecycle
    /// contract as [`ExecControlHandle::control`].
    pub async fn control(
        &self,
        message_id: &str,
        payload: &[u8],
        timeout: Duration,
    ) -> io::Result<ExecControlAck> {
        self.control
            .as_ref()
            .ok_or_else(|| {
                exec_control_status_error(
                    ExecControlStatus::Unsupported,
                    "exec control is not supported by this operation",
                )
            })?
            .control(message_id, payload, timeout)
            .await
    }

    /// Take the bounded output event receiver for streaming operations.
    pub fn take_stream_receiver(&mut self) -> Option<mpsc::Receiver<ExecOutputEvent>> {
        self.stream_rx.take()
    }

    /// Take the bounded process stdout receiver for sandbox process operations.
    pub fn take_process_output_receiver(&mut self) -> Option<ProcessOutputReceiver> {
        self.process_output_rx.take()
    }

    fn clear_unclaimed_stream_sender(&mut self) {
        let Some(route_id) = self.wait_core.active_route_id() else {
            return;
        };
        let event_stream_unclaimed = self.stream_rx.take().is_some();
        let process_output_unclaimed = self.process_output_rx.take().is_some();
        if event_stream_unclaimed || process_output_unclaimed {
            clear_exec_operation_stream_sender(self.wait_core.shared(), route_id);
        }
    }

    /// Wait for the terminal exec result.
    ///
    /// On timeout, this abandons the host-side operation registration but does
    /// not send `MSG_EXEC_CANCEL`. Because the terminal proof is abandoned
    /// after a guest write, later normal operations become unavailable on this
    /// connection.
    pub async fn wait(mut self, timeout: Duration) -> io::Result<ExecOperationResult> {
        self.clear_unclaimed_stream_sender();
        self.wait_core
            .wait_with_timeout(timeout, false, ExecWaitLifecycle::Supervised)
            .await
            .into_result()
    }

    /// Send `MSG_EXEC_CANCEL` and wait for the terminal exec result.
    ///
    /// If the terminal result is already available or wins the race before
    /// cancel reaches the write boundary, this returns that result without
    /// sending a stale cancel frame. `timeout` bounds the full operation:
    /// waiting to write cancel, writing cancel, and waiting for terminal proof.
    /// If the timeout elapses before cancel frame writing starts, cancel did
    /// not reach the guest and the connection is not poisoned. If cancel is
    /// sent but the terminal result does not arrive before the remaining
    /// timeout, the connection is poisoned because guest process state is no
    /// longer known.
    pub async fn cancel_and_wait(self, timeout: Duration) -> io::Result<ExecOperationResult> {
        let cancel_label_log = self.wait_core.diagnostic().label_log.clone();
        let registered_at = self.wait_core.diagnostic().registered_at;
        self.cancel_and_wait_for_terminal_status(timeout)
            .await
            .and_then(|wait_result| {
                wait_result.into_expected_cancel_result(
                    ExecWaitLifecycle::Supervised,
                    &cancel_label_log,
                    registered_at,
                )
            })
            .into_result()
    }

    pub(in crate::exec_operation) async fn cancel_and_wait_for_terminal_status(
        mut self,
        timeout: Duration,
    ) -> ExecOperationWaitOutcome<ExecCancelWaitResult> {
        let (route_id, remaining) = match self
            .wait_core
            .send_cancel_before_terminal_with_deadline(timeout, ExecWaitLifecycle::Supervised)
            .await
        {
            Ok(ExecCancelWriteOutcome::Terminal(result)) => {
                return ExecOperationWaitOutcome::terminal(result).map(|result| {
                    ExecCancelWaitResult {
                        result,
                        cancel_seq: None,
                    }
                });
            }
            Ok(ExecCancelWriteOutcome::CancelSent {
                route_id,
                remaining,
            }) => (route_id, remaining),
            Err(error) => return ExecOperationWaitOutcome::unproven(error),
        };

        self.clear_unclaimed_stream_sender();
        self.wait_core
            .wait_for_terminal_after_cancel_sent(route_id, remaining, ExecWaitLifecycle::Supervised)
            .await
    }
}

impl Drop for SupervisedExecHandle {
    fn drop(&mut self) {
        self.clear_unclaimed_stream_sender();
    }
}

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

pub(crate) struct ExecOperationCancelOnDropGuard {
    pub(in crate::exec_operation) shared: Option<Arc<Shared>>,
    pub(in crate::exec_operation) route_id: RouteId,
    pub(in crate::exec_operation) diagnostic: ExecOperationDiagnostic,
}

impl ExecOperationCancelOnDropGuard {
    pub(in crate::exec_operation) fn new_for_route(
        shared: Arc<Shared>,
        route_id: RouteId,
        diagnostic: ExecOperationDiagnostic,
    ) -> Self {
        Self {
            shared: Some(shared),
            route_id,
            diagnostic,
        }
    }

    pub(crate) fn new(handle: &ExecOperationHandle) -> Option<Self> {
        Some(Self {
            shared: Some(Arc::clone(handle.wait_core.shared())),
            route_id: handle.wait_core.active_route_id()?,
            diagnostic: handle.wait_core.diagnostic().clone(),
        })
    }

    #[cfg(test)]
    pub(crate) fn new_supervised(handle: &SupervisedExecHandle) -> Option<Self> {
        Some(Self {
            shared: Some(Arc::clone(handle.wait_core.shared())),
            route_id: handle.wait_core.active_route_id()?,
            diagnostic: handle.wait_core.diagnostic().clone(),
        })
    }

    pub(crate) fn disarm(&mut self) {
        self.shared = None;
    }
}

impl Drop for ExecOperationCancelOnDropGuard {
    fn drop(&mut self) {
        let Some(shared) = self.shared.take() else {
            return;
        };
        let route_id = self.route_id;
        let seq = route_id.wire_seq();
        let diagnostic = self.diagnostic.clone();
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let reservation = match admit_exec_cancel_frame(&shared, route_id) {
            Ok(Some(reservation)) => reservation,
            Ok(None) => return,
            Err(err) => {
                tracing::warn!(
                    seq = seq,
                    label = %diagnostic.label_log,
                    process_class = diagnostic.process_class,
                    operation_kind = diagnostic.operation_kind,
                    elapsed_ms = diagnostic.elapsed_ms(),
                    error = %err,
                    "exec operation cancel on drop admission failed"
                );
                return;
            }
        };

        handle.spawn(async move {
            let _reservation = reservation;
            let payload = guest_control_proto::encode_exec_cancel();
            let result = tokio::time::timeout(
                EXEC_OPERATION_DROP_CANCEL_WRITE_TIMEOUT,
                write_frame(
                    &shared,
                    MSG_EXEC_CANCEL,
                    seq,
                    &payload,
                    Some(diagnostic.frame("drop-cancel")),
                    None,
                    exec_cancel_write_observer(&shared, route_id),
                ),
            )
            .await;
            match result {
                Ok(Ok(())) => {
                    tracing::info!(
                        seq = seq,
                        label = %diagnostic.label_log,
                        process_class = diagnostic.process_class,
                        operation_kind = diagnostic.operation_kind,
                        elapsed_ms = diagnostic.elapsed_ms(),
                        "exec operation cancel sent on drop"
                    );
                }
                Ok(Err(err)) => {
                    tracing::warn!(
                        seq = seq,
                        label = %diagnostic.label_log,
                        process_class = diagnostic.process_class,
                        operation_kind = diagnostic.operation_kind,
                        elapsed_ms = diagnostic.elapsed_ms(),
                        error = %err,
                        "exec operation cancel on drop failed"
                    );
                }
                Err(_) => {
                    tracing::warn!(
                        seq = seq,
                        label = %diagnostic.label_log,
                        process_class = diagnostic.process_class,
                        operation_kind = diagnostic.operation_kind,
                        elapsed_ms = diagnostic.elapsed_ms(),
                        "exec operation cancel on drop timed out"
                    );
                }
            }
        });
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
