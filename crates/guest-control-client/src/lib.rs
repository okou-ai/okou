//! Runner-side client for controlling guest operations.
//!
//! Accepts the guest control server's connection via Unix domain socket
//! (Firecracker forwards vsock connections to `{vsock_path}_{port}` UDS files).
//! Client/server describe application calling roles, not socket initiation.
//!
//! ## Connection Flow
//!
//! 1. Host creates UDS listener at `{vsock_path}_{port}`
//! 2. Guest boots and guest-control-server connects to CID=2
//! 3. Firecracker forwards connection to Host's UDS listener
//! 4. Host accepts, receives `ready`, sends `ping`, waits for `pong`
//! 5. Connection established — host can send commands
//!
//! ## Concurrency
//!
//! After connection, a background reader task owns the read half of the
//! stream exclusively. All public methods take `&self` and can be called
//! concurrently. Responses are dispatched to callers via oneshot channels
//! keyed by sequence number.
//!
//! ## Exec Operation Lifecycle
//!
//! [`GuestControlClient`] supports one-shot exec operations with
//! [`GuestControlClient::start_exec_operation`] and supervised exec operations with
//! [`GuestControlClient::start_supervised_exec`]. One-shot exec is request-scoped: the
//! guest sends a terminal result for the original request sequence.
//! Supervised exec first acknowledges a started guest process and then keeps a
//! lifecycle registration until a terminal result arrives, the connection
//! closes, or the host explicitly abandons the registration.
//!
//! [`ExecOperationHandle`] owns a one-shot terminal result registration.
//! Dropping it removes only host-side registration and never sends
//! `MSG_EXEC_CANCEL`; use [`ExecOperationHandle::wait`] to observe the
//! terminal result or [`ExecOperationHandle::cancel_and_wait`] to send
//! cancellation and wait for the cancelled terminal result. If the terminal
//! result is already available or dispatch wins the race before cancellation
//! reaches the write boundary, cancel-and-wait returns that original terminal
//! result instead. The `cancel_and_wait` timeout bounds both the cancel-frame
//! write and the terminal-result wait. A plain wait timeout does not cancel the
//! guest. If terminal proof is abandoned after a request may have reached the
//! guest, the connection can remain open while later normal operations become
//! unavailable on that connection. A timeout after an explicit cancel was sent
//! poisons the connection because the guest process state is no longer known.
//!
//! [`SupervisedExecHandle`] owns the terminal result for a supervised process.
//! Dropping it does not cancel the guest and does not remove the lifecycle
//! registration; the host keeps tracking the operation until terminal result
//! dispatch, connection close, or an explicit wait timeout. Use
//! [`SupervisedExecHandle::cancel_and_wait`] to send cancellation and consume
//! the terminal result under one total timeout covering cancel-frame write and
//! terminal-result wait. If the terminal result is already available or
//! dispatch wins the race before cancellation reaches the write boundary,
//! cancel-and-wait returns that original terminal result instead.
//! [`SupervisedExecCancelHandle::cancel`] sends only the cancel frame and
//! leaves terminal result ownership with the paired
//! [`SupervisedExecHandle`].
//!
//! Streaming exec operations expose a bounded receiver through
//! `take_stream_receiver`. Guest-side stream or capture truncation is reported
//! on individual output/captured-output values, while host-side bounded queue
//! overflow is reported on [`ExecOperationResult::stream_overflowed`].
//!
//! Supervised operations can opt into exec control with
//! [`SupervisedExecControl::Enabled`]. [`ExecControlHandle::control`] requires
//! a delivered acknowledgement, while
//! [`ExecControlHandle::control_with_write_observer`] exposes the raw
//! [`ExecControlOutcome`] so callers can distinguish delivered requests from
//! guest statuses and guest error responses.

mod connection;
mod exec_operation;
mod file;
mod file_stream;
mod guest_dns_readiness;
mod guest_state_restore;
mod guest_storage_manifest;
mod operation_tracker;
#[cfg(test)]
mod tests;
mod workspace_drive_mount;

use std::fmt;
use std::io;
use std::os::unix::io::RawFd;
use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinHandle;

use connection::{
    CompositeNormalOperation, ConnectionState, RouteId, RouteReservation, Shared,
    normal_operation_transition_error, normal_request_on_shared_with_write_observer_frame_builder,
    request_on_shared_with_composite_operation_and_observer_frame_builder,
};
#[cfg(test)]
use connection::{request_on_shared, write_request_frame_with_builder};
use operation_tracker::NormalOperationFenceRejection as TrackerNormalOperationFenceRejection;

pub use connection::GuestConnectionTiming;
pub use exec_operation::{
    CodexSessionCleanupRequest, ExecCaptureRequest, ExecControlAck, ExecControlGuestStatus,
    ExecControlHandle, ExecControlOutcome, ExecOperationHandle, ExecOperationRequest,
    ExecOperationResult, ExecOutputEvent, ExecOwnedCapturedOutput, ExecStreamRequest,
    SessionHistoryIdentityVerifyRequest, SupervisedExecCancelHandle, SupervisedExecControl,
    SupervisedExecHandle, SupervisedExecRequest, SupervisedExecStartTiming,
};
pub use file::{COPY_FILE_STREAM_MAX_BYTES, CopyFileOptions, CopyFileResult, WriteFileEntry};
pub use guest_dns_readiness::GuestDnsReadinessResult;
pub use guest_state_restore::GuestStateRestoreResult;
pub use guest_storage_manifest::GuestStorageManifestResult;
pub use operation_tracker::NormalOperationRejection;
pub use sandbox::FileCompression;
pub use workspace_drive_mount::WorkspaceDriveMountResult;

/// Host-observed stage at which a request deadline expired.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestTimeoutStage {
    /// The request frame had not reached its write boundary.
    BeforeFrameWrite,
    /// The request frame write had started and may be partial.
    FrameWrite,
    /// The request frame completed but no terminal response arrived.
    AwaitingTerminalResponse,
}

/// Typed request deadline error carried inside [`io::ErrorKind::TimedOut`].
#[derive(Debug)]
pub struct RequestTimeoutError {
    stage: RequestTimeoutStage,
    timeout: Duration,
    private_write_sequence: Option<u32>,
}

impl RequestTimeoutError {
    /// Create a timeout error for an observed request stage and total budget.
    pub const fn new(stage: RequestTimeoutStage, timeout: Duration) -> Self {
        Self {
            stage,
            timeout,
            private_write_sequence: None,
        }
    }

    /// Return the request stage observed when the deadline expired.
    pub const fn stage(&self) -> RequestTimeoutStage {
        self.stage
    }

    /// Return the configured end-to-end request timeout.
    pub const fn timeout(&self) -> Duration {
        self.timeout
    }

    /// Private-write request to correlate with a read-only guest diagnostic.
    ///
    /// Present only after a complete private-write frame has timed out waiting
    /// for its terminal response. It does not permit retrying the write.
    pub const fn private_write_sequence(&self) -> Option<u32> {
        self.private_write_sequence
    }
}

impl fmt::Display for RequestTimeoutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("request timeout")
    }
}

impl std::error::Error for RequestTimeoutError {}

/// Byte-emission boundary for an ordinary guarded request-write failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestWriteStage {
    /// This frame emitted no bytes; this does not assert connection health.
    BeforeFrameWrite,
    /// The frame write failed after admission and may be partial.
    FrameWrite,
}

/// Ordinary write failure carried inside an [`io::Error`] of the original kind.
///
/// Unlike [`RequestTimeoutError`], this does not represent a request deadline,
/// even when the underlying writer returns [`io::ErrorKind::TimedOut`].
#[derive(Debug)]
pub struct RequestWriteError {
    stage: RequestWriteStage,
    source: io::Error,
}

impl RequestWriteError {
    pub(crate) fn into_io_error(stage: RequestWriteStage, source: io::Error) -> io::Error {
        io::Error::new(source.kind(), Self { stage, source })
    }

    /// Return the stage observed by the serialized frame writer.
    pub const fn stage(&self) -> RequestWriteStage {
        self.stage
    }
}

impl fmt::Display for RequestWriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.source.fmt(f)
    }
}

impl std::error::Error for RequestWriteError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

/// Observer called when a request frame reaches the guest-write boundary.
///
/// The callback is synchronous because it runs while the shared writer lock is
/// held, immediately before frame bytes are written. Keep the callback fast and
/// do not call back into the same [`GuestControlClient`], because that can deadlock on
/// the writer lock. Multi-frame helper operations may invoke the same observer
/// more than once.
#[derive(Clone)]
pub struct FrameWriteObserver {
    record_write_start: Arc<dyn Fn() -> io::Result<()> + Send + Sync>,
}

impl FrameWriteObserver {
    pub fn new(record_write_start: impl Fn() -> io::Result<()> + Send + Sync + 'static) -> Self {
        Self {
            record_write_start: Arc::new(record_write_start),
        }
    }

    pub fn noop() -> Self {
        Self::new(|| Ok(()))
    }

    fn record_write_start(&self) -> io::Result<()> {
        (self.record_write_start)()
    }
}

impl Default for FrameWriteObserver {
    fn default() -> Self {
        Self::noop()
    }
}

/// Opaque guard that fences new normal guest operations on a [`GuestControlClient`].
///
/// While this guard is alive, normal operations such as exec and file transfer
/// requests are rejected by the host-side operation tracker.
/// Lifecycle requests such as quiesce/resume are not normal operations and can
/// still be sent while the guard is held.
#[must_use = "normal operations are fenced only while this guard is held"]
#[derive(Debug)]
pub struct NormalOperationFence {
    _inner: operation_tracker::NormalOperationFence,
}

/// Owned reservation for an operation on a separate provider-owned transport.
///
/// This shares the normal-operation tracker with generic guest operations, so
/// it prevents park for its whole lifetime. It sends no generic guest request
/// and releases on Drop without requiring a guest terminal response. The
/// provider must separately own transport cancellation on termination.
#[must_use = "hold this reservation for the complete external operation"]
pub struct ExternalOperationReservation {
    _inner: operation_tracker::NormalOperationToken,
}

/// Reason why [`GuestControlClient::try_fence_normal_operations`] or
/// [`GuestControlClient::exec_operation_capture_with_fence`] could not acquire a
/// [`NormalOperationFence`].
///
/// The variants identify caller-visible recovery paths for normal-operation
/// fencing without exposing the internal operation tracker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NormalOperationFenceRejection {
    /// A normal operation is currently in flight.
    ///
    /// Callers may retry after outstanding normal operations have drained.
    Busy,
    /// Another [`NormalOperationFence`] is already held.
    ///
    /// Coordinate with the holder of the existing fence instead of treating the
    /// connection as failed.
    AlreadyFenced,
    /// The connection is no longer safe to park or reuse for future normal
    /// operations.
    ///
    /// Callers should discard this connection instead of retrying normal
    /// operations on it.
    NotParkable,
    /// The connection has closed.
    Closed,
}

impl From<TrackerNormalOperationFenceRejection> for NormalOperationFenceRejection {
    fn from(error: TrackerNormalOperationFenceRejection) -> Self {
        match error {
            TrackerNormalOperationFenceRejection::Busy => Self::Busy,
            TrackerNormalOperationFenceRejection::AlreadyFenced => Self::AlreadyFenced,
            TrackerNormalOperationFenceRejection::NotParkable => Self::NotParkable,
            TrackerNormalOperationFenceRejection::Closed => Self::Closed,
        }
    }
}

/// Failure while atomically fencing normal operations and running one final
/// capture exec.
#[derive(Debug)]
pub enum FencedExecError {
    /// The connection could not enter the fenced final-operation state.
    FenceRejected(NormalOperationFenceRejection),
    /// The reserved capture exec did not produce a trustworthy terminal result.
    Operation(io::Error),
}

impl std::fmt::Display for FencedExecError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FenceRejected(reason) => {
                write!(formatter, "normal-operation fence rejected: {reason:?}")
            }
            Self::Operation(error) => write!(formatter, "fenced exec failed: {error}"),
        }
    }
}

impl std::error::Error for FencedExecError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::FenceRejected(_) => None,
            Self::Operation(error) => Some(error),
        }
    }
}

struct FencedNormalOperationGuard {
    normal_operation: Option<CompositeNormalOperation>,
    fence: Option<NormalOperationFence>,
}

impl FencedNormalOperationGuard {
    fn complete(mut self) -> io::Result<NormalOperationFence> {
        let normal_operation = self.normal_operation.take().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "fenced normal operation already completed",
            )
        })?;
        normal_operation.complete()?;
        self.fence.take().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "fenced normal operation is missing its fence",
            )
        })
    }
}

impl Drop for FencedNormalOperationGuard {
    fn drop(&mut self) {
        // Release the operation token before the fence. If a request may have
        // reached the guest, dropping the token first makes the tracker
        // NotParkable before the fence can consider reopening it.
        drop(self.normal_operation.take());
        drop(self.fence.take());
    }
}

/// Runner-side guest-control endpoint.
///
/// Maintains a persistent connection to the guest agent and provides
/// high-level methods for command execution, file operations, and
/// process lifecycle management.
///
/// All public methods take `&self` and can be called concurrently.
/// A background reader task dispatches incoming messages to the
/// appropriate caller.
pub struct GuestControlClient {
    shared: Arc<Shared>,
    file_write_path_locks: file::FileWritePathLocks,
    _reader: JoinHandle<()>,
    /// Raw fd of the underlying socket, used for shutdown on Drop.
    ///
    /// `shutdown(SHUT_RDWR)` does NOT close the fd — it only signals EOF,
    /// unblocking the reader_loop's async read and any remote peer's
    /// blocking read. The fd itself is still owned by the read/write halves
    /// and is closed normally when they are dropped.
    fd: RawFd,
}

impl GuestControlClient {
    /// Reserve the same operation lifetime used by the normal-operation fence.
    pub fn reserve_external_operation(&self) -> io::Result<ExternalOperationReservation> {
        Ok(ExternalOperationReservation {
            _inner: self.shared.reserve_normal_operation()?,
        })
    }

    /// Try to fence new normal guest operations on this connection.
    ///
    /// The returned guard keeps normal operations fenced until it is dropped.
    /// Bind it to a local variable for as long as the fence is needed; ignoring
    /// the guard releases the fence immediately.
    /// Lifecycle requests such as [`quiesce_operations`](Self::quiesce_operations)
    /// and [`resume_operations`](Self::resume_operations) remain available while
    /// the guard is held.
    ///
    /// If the fence cannot be acquired, [`NormalOperationFenceRejection`]
    /// describes whether the caller can retry later, should coordinate with an
    /// existing fence, or should discard/handle the connection.
    pub fn try_fence_normal_operations(
        &self,
    ) -> Result<NormalOperationFence, NormalOperationFenceRejection> {
        self.shared
            .normal_operations
            .try_fence()
            .map(|inner| NormalOperationFence { _inner: inner })
            .map_err(Into::into)
    }

    /// Start a request-scoped exec operation using the exec operation protocol.
    ///
    /// `request.start_write_timeout` bounds waiting for the shared writer and
    /// writing the complete start frame.
    pub async fn start_exec_operation(
        &self,
        request: ExecOperationRequest<'_>,
    ) -> io::Result<ExecOperationHandle> {
        exec_operation::start_exec_operation_on_shared(&self.shared, request).await
    }

    /// Start a supervised exec operation and wait for its PID acknowledgement.
    ///
    /// `request.start_timeout` bounds both start-frame writing and waiting for
    /// `MSG_EXEC_STARTED` for workloads or `MSG_EXEC_AGENT_READY` for Agents.
    /// If it elapses after the complete start frame is
    /// written, the host sends `MSG_EXEC_CANCEL` before returning a timeout
    /// error. If the bounded cancel write also times out, the connection is
    /// poisoned. If the cancel write succeeds, the connection remains open but
    /// should not be reused for later normal operations because terminal proof
    /// for the timed-out operation was abandoned.
    pub async fn start_supervised_exec(
        &self,
        request: SupervisedExecRequest<'_>,
    ) -> io::Result<SupervisedExecHandle> {
        exec_operation::start_supervised_exec_on_shared(&self.shared, request).await
    }

    /// Start a supervised process whose streamed stdout is delivered through
    /// the sandbox process-output queue.
    ///
    /// The request must not stream stderr. When stdout streams, the returned
    /// handle owns a bounded [`sandbox::ProcessOutputReceiver`] until it is
    /// taken with [`SupervisedExecHandle::take_process_output_receiver`].
    pub async fn start_supervised_process(
        &self,
        request: SupervisedExecRequest<'_>,
    ) -> io::Result<SupervisedExecHandle> {
        exec_operation::start_supervised_process_on_shared(&self.shared, request).await
    }

    /// Run a capture-only exec operation with default capture limits.
    pub async fn exec_operation_capture_default(
        &self,
        command: &str,
        timeout_ms: u32,
        env: &[(&str, &str)],
        sudo: bool,
        label: &str,
        wait_timeout: Duration,
    ) -> io::Result<ExecOperationResult> {
        self.exec_operation_capture(ExecCaptureRequest {
            timeout_ms,
            command,
            env,
            sudo,
            label,
            stdout_limit_bytes: exec_operation::DEFAULT_EXEC_CAPTURE_LIMIT_BYTES,
            stderr_limit_bytes: exec_operation::DEFAULT_EXEC_CAPTURE_LIMIT_BYTES,
            expected_exit_codes: &[],
            stdin_bytes: None,
            wait_timeout,
        })
        .await
    }

    /// Run a capture-only exec operation with explicit stdout/stderr limits.
    pub async fn exec_operation_capture(
        &self,
        request: ExecCaptureRequest<'_>,
    ) -> io::Result<ExecOperationResult> {
        exec_operation::exec_operation_capture_on_shared(&self.shared, request).await
    }

    /// Run the fixed live session-history identity verifier without a guest shell.
    pub async fn verify_session_history_identity(
        &self,
        request: SessionHistoryIdentityVerifyRequest<'_>,
    ) -> io::Result<ExecOperationResult> {
        exec_operation::session_history_identity_verify_on_shared(&self.shared, request).await
    }

    /// Run the fixed reused-Codex session cleanup helper.
    pub async fn cleanup_codex_session(
        &self,
        request: CodexSessionCleanupRequest<'_>,
    ) -> io::Result<ExecOperationResult> {
        exec_operation::codex_session_cleanup_on_shared(&self.shared, request).await
    }

    /// Run a capture-only exec operation with a synchronous admission check at
    /// the first guest-write boundary.
    ///
    /// The normal-operation token is reserved before the admission check runs.
    /// If the check rejects the request, no frame bytes are written and the
    /// unused reservation is released without making the connection
    /// unparkable.
    pub async fn exec_operation_capture_with_write_admission(
        &self,
        request: ExecCaptureRequest<'_>,
        write_admission: FrameWriteObserver,
    ) -> io::Result<ExecOperationResult> {
        exec_operation::exec_operation_capture_on_shared_with_write_admission(
            &self.shared,
            request,
            write_admission,
        )
        .await
    }

    /// Atomically reserve one final normal operation and fence every competing
    /// normal operation while running a capture exec.
    ///
    /// Reservation succeeds only when the normal-operation tracker is open and
    /// idle. The returned fence remains held after the exec reaches a terminal
    /// result, allowing a lifecycle owner to quiesce and pause the guest without
    /// reopening normal-operation admission in between.
    ///
    /// Dropping this future or losing terminal proof releases the operation
    /// token before the fence. If the request may have reached the guest, that
    /// ordering leaves the connection not parkable rather than reopening it.
    pub async fn exec_operation_capture_with_fence(
        &self,
        request: ExecCaptureRequest<'_>,
    ) -> Result<(ExecOperationResult, NormalOperationFence), FencedExecError> {
        let (normal_operation, fence) = self
            .shared
            .normal_operations
            .try_reserve_and_fence()
            .map_err(|error| FencedExecError::FenceRejected(error.into()))?;
        let mut guard = FencedNormalOperationGuard {
            normal_operation: Some(CompositeNormalOperation::from_token(normal_operation)),
            fence: Some(NormalOperationFence { _inner: fence }),
        };
        let normal_operation = guard.normal_operation.as_mut().ok_or_else(|| {
            FencedExecError::Operation(io::Error::new(
                io::ErrorKind::InvalidData,
                "fenced normal operation is unavailable",
            ))
        })?;
        let result = exec_operation::exec_operation_capture_with_composite_on_shared_and_observer(
            &self.shared,
            request,
            normal_operation,
            FrameWriteObserver::default(),
        )
        .await
        .into_result()
        .map_err(FencedExecError::Operation)?;
        let fence = guard.complete().map_err(FencedExecError::Operation)?;
        Ok((result, fence))
    }

    /// Start a streaming exec operation with a bounded output event receiver.
    ///
    /// `request.start_write_timeout` bounds waiting for the shared writer and
    /// writing the complete start frame.
    pub async fn exec_operation_stream(
        &self,
        request: ExecStreamRequest<'_>,
    ) -> io::Result<ExecOperationHandle> {
        exec_operation::exec_operation_stream_on_shared(&self.shared, request).await
    }
}
