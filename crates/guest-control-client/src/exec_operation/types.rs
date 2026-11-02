use std::io;
use std::time::{Duration, Instant};

use guest_control_proto::{
    ExecAgentReadyTiming, ExecControlStatus, ExecOutputPolicy, ExecOutputStream, ExecProcessRole,
    ExecTermination, ExecTimeoutPolicy,
};

/// Host-observed shell and optional Agent-ready timing for a supervised start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SupervisedExecStartTiming {
    /// Monotonic host instant when `MSG_EXEC_STARTED` was received.
    pub shell_started_at: Instant,
    /// Monotonic host instant when `MSG_EXEC_AGENT_READY` was received.
    pub agent_ready_at: Option<Instant>,
    /// Guest-reported component timing at Agent ready.
    pub agent_ready: Option<ExecAgentReadyTiming>,
}

/// Owned terminal stdout or stderr representation selected by the requested
/// [`ExecOutputPolicy`](guest_control_proto::ExecOutputPolicy).
///
/// [`Discard`](guest_control_proto::ExecOutputPolicy::Discard) and
/// [`Stream`](guest_control_proto::ExecOutputPolicy::Stream) produce `Discarded`
/// because they do not retain bytes in the terminal result.
/// [`Capture`](guest_control_proto::ExecOutputPolicy::Capture) and
/// [`CaptureAndStream`](guest_control_proto::ExecOutputPolicy::CaptureAndStream)
/// produce `Captured`, including when the retained bytes are empty.
///
/// The `truncated` field of `Captured` reports guest-side capture-policy
/// truncation. Host-side loss from the bounded stream queue is reported
/// separately by [`ExecOperationResult::stream_overflowed`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecOwnedCapturedOutput {
    /// The stream was discarded by policy and therefore has no captured bytes.
    Discarded,
    /// The stream was captured, possibly with protocol-level truncation.
    Captured {
        /// Owned stdout or stderr bytes returned in the terminal exec result.
        bytes: Vec<u8>,
        /// Whether the guest truncated captured bytes to satisfy the requested
        /// capture output policy.
        truncated: bool,
    },
}

/// Terminal result for a host exec operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecOperationResult {
    /// Terminal process state reported by the guest.
    pub termination: ExecTermination,
    /// Guest-reported wall-clock duration in milliseconds.
    pub duration_ms: u32,
    /// Stdout output state according to the requested stdout output policy.
    pub stdout: ExecOwnedCapturedOutput,
    /// Stderr output state according to the requested stderr output policy.
    pub stderr: ExecOwnedCapturedOutput,
    /// Guest-provided terminal diagnostic text.
    ///
    /// This may be empty when the guest has no additional diagnostic to
    /// report for the terminal state.
    pub diagnostic: String,
    /// Whether the host-side bounded stream queue overflowed.
    ///
    /// This is separate from guest-side capture or stream truncation. When
    /// true, some streamed output events may have been dropped even though the
    /// terminal result was still received.
    pub stream_overflowed: bool,
}

/// Streamed output event for a host exec operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecOutputEvent {
    /// Output stream that produced this event.
    pub stream: ExecOutputStream,
    /// Per-operation output sequence number validated by the host.
    ///
    /// The sequence orders stdout and stderr events together for the exec
    /// operation.
    pub output_seq: u32,
    /// Output bytes emitted for this event.
    ///
    /// This may be empty only when the event marks stream truncation.
    pub chunk: Vec<u8>,
    /// Whether the guest truncated this stream to satisfy the requested stream
    /// output policy.
    ///
    /// Host-side stream queue overflow is reported separately on
    /// `ExecOperationResult::stream_overflowed`.
    pub truncated: bool,
}

/// Request parameters for starting an exec operation.
pub struct ExecOperationRequest<'a> {
    /// Positive guest-side process timeout in milliseconds.
    ///
    /// A zero timeout is rejected before the request is sent. Use supervised
    /// exec for operations that should not have a one-shot process timeout.
    pub timeout_ms: u32,
    /// Shell command to run in the guest.
    pub command: &'a str,
    /// Environment variables injected into the guest shell command.
    pub env: &'a [(&'a str, &'a str)],
    /// Whether to run the command with guest-side sudo handling.
    pub sudo: bool,
    /// Human-readable label used for diagnostics and logs.
    pub label: &'a str,
    /// Stdout output policy requested from the guest.
    pub stdout: ExecOutputPolicy,
    /// Stderr output policy requested from the guest.
    pub stderr: ExecOutputPolicy,
    /// Exit codes sent to the guest for expected-exit handling and diagnostics.
    ///
    /// The host still preserves the terminal state reported by the guest in
    /// `ExecOperationResult::termination`.
    pub expected_exit_codes: &'a [i32],
    /// Optional bounded stdin payload written to the child and then closed.
    pub stdin_bytes: Option<&'a [u8]>,
    /// Optional bounded host-side output event queue override.
    ///
    /// `None` uses the default queue capacity when either output policy
    /// streams, and creates no queue when neither output policy streams.
    /// `Some` is valid only when stdout or stderr streams; zero and oversized
    /// capacities are rejected.
    pub stream_queue_capacity: Option<usize>,
    /// Maximum host-side time to write the complete exec-start frame.
    ///
    /// This includes waiting for the shared writer and is separate from
    /// `timeout_ms`, which is the guest-side process timeout. A zero duration
    /// expires before the frame is sent.
    pub start_write_timeout: Duration,
}

/// Request parameters for a capture-only exec operation helper.
pub struct ExecCaptureRequest<'a> {
    /// Positive guest-side process timeout in milliseconds.
    ///
    /// A zero timeout is rejected before the request is sent.
    pub timeout_ms: u32,
    /// Shell command to run in the guest.
    pub command: &'a str,
    /// Environment variables injected into the guest shell command.
    pub env: &'a [(&'a str, &'a str)],
    /// Whether to run the command with guest-side sudo handling.
    pub sudo: bool,
    /// Human-readable label used for diagnostics and logs.
    pub label: &'a str,
    /// Maximum stdout bytes to retain in the terminal exec result.
    pub stdout_limit_bytes: u32,
    /// Maximum stderr bytes to retain in the terminal exec result.
    pub stderr_limit_bytes: u32,
    /// Exit codes sent to the guest for expected-exit handling and diagnostics.
    pub expected_exit_codes: &'a [i32],
    /// Optional bounded stdin payload written to the child and then closed.
    pub stdin_bytes: Option<&'a [u8]>,
    /// Maximum total host-side time to write the start frame and wait for the
    /// terminal result.
    ///
    /// This is separate from `timeout_ms`, which is the guest-side process
    /// timeout encoded in the exec request. A zero duration expires before the
    /// frame is sent.
    pub wait_timeout: Duration,
}

/// Fixed-purpose live session-history identity verifier request.
///
/// The host selects the executable, process role, label, output bounds, and
/// one-shot lifecycle. Callers can supply only values consumed by the verifier.
pub struct SessionHistoryIdentityVerifyRequest<'a> {
    /// Absolute final identity metadata path inside the guest.
    pub metadata_path: &'a str,
    /// Absolute canonical guest runtime directory.
    pub runtime_dir: &'a str,
    /// Stable CLI framework spelling.
    pub framework: &'a str,
    /// Expected normalized session-id SHA-256.
    pub session_id_hash: &'a str,
    /// Stable history-reference-kind spelling.
    pub history_ref_kind: &'a str,
    /// Expected final history SHA-256.
    pub history_hash: &'a str,
    /// Expected final history byte length.
    pub history_size_bytes: u64,
    /// Positive guest-side process timeout in milliseconds.
    pub timeout_ms: u32,
    /// Total host-side request deadline.
    pub wait_timeout: Duration,
}

/// Request parameters for a streaming exec operation helper.
pub struct ExecStreamRequest<'a> {
    /// Positive guest-side process timeout in milliseconds.
    ///
    /// A zero timeout is rejected before the request is sent.
    pub timeout_ms: u32,
    /// Shell command to run in the guest.
    pub command: &'a str,
    /// Environment variables injected into the guest shell command.
    pub env: &'a [(&'a str, &'a str)],
    /// Whether to run the command with guest-side sudo handling.
    pub sudo: bool,
    /// Human-readable label used for diagnostics and logs.
    pub label: &'a str,
    /// Stdout output policy requested from the guest.
    ///
    /// At least one of stdout or stderr must use a streaming output policy.
    pub stdout: ExecOutputPolicy,
    /// Stderr output policy requested from the guest.
    ///
    /// At least one of stdout or stderr must use a streaming output policy.
    pub stderr: ExecOutputPolicy,
    /// Exit codes sent to the guest for expected-exit handling and diagnostics.
    pub expected_exit_codes: &'a [i32],
    /// Optional bounded stdin payload written to the child and then closed.
    pub stdin_bytes: Option<&'a [u8]>,
    /// Optional host-side output event queue capacity override.
    ///
    /// `None` uses the default queue capacity. Zero and oversized capacities
    /// are rejected.
    pub stream_queue_capacity: Option<usize>,
    /// Maximum host-side time to write the complete exec-start frame.
    ///
    /// This includes waiting for the shared writer and is separate from
    /// `timeout_ms`, which is the guest-side process timeout. A zero duration
    /// expires before the frame is sent.
    pub start_write_timeout: Duration,
}

/// Exec control policy for supervised host operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisedExecControl {
    /// Do not register an exec-control route for the operation.
    Disabled,
    /// Register an exec-control route.
    ///
    /// When `sink` is true, the guest also exposes the bootstrap endpoint to
    /// the child process through the process-control environment variable.
    Enabled { sink: bool },
}

/// Request parameters for starting a supervised exec operation.
pub struct SupervisedExecRequest<'a> {
    /// Semantic role selected by the provider-level start entry point.
    pub role: ExecProcessRole,
    /// Guest-side process timeout policy.
    ///
    /// `ExecTimeoutPolicy::None` lets the process run until it exits, is
    /// cancelled, or the connection closes.
    pub timeout: ExecTimeoutPolicy,
    /// Whether a clean Workload execution timeout should be logged at info.
    ///
    /// Host-only diagnostic intent, registered before writing the start frame.
    /// Does not affect Agent timeouts, deadlines, start/wait errors, result
    /// semantics, or warnings for diagnostics, truncation, or output overflow.
    pub timeout_is_expected: bool,
    /// Shell command to run in the guest.
    pub command: &'a str,
    /// Environment variables injected into the guest shell command.
    pub env: &'a [(&'a str, &'a str)],
    /// Whether to run the command with guest-side sudo handling.
    pub sudo: bool,
    /// Human-readable label used for diagnostics and logs.
    pub label: &'a str,
    /// Stdout output policy requested from the guest.
    pub stdout: ExecOutputPolicy,
    /// Stderr output policy requested from the guest.
    pub stderr: ExecOutputPolicy,
    /// Exit codes that should be marked expected in the guest-side exec request.
    pub expected_exit_codes: &'a [i32],
    /// Optional bounded stdin payload written to the child and then closed.
    pub stdin_bytes: Option<&'a [u8]>,
    /// Optional exec-control route for this supervised operation.
    pub control: SupervisedExecControl,
    /// Optional bounded host-side output event queue override.
    ///
    /// `None` uses the default queue capacity when either output policy
    /// streams, and creates no queue when neither output policy streams.
    /// `Some` is valid only when stdout or stderr streams; zero and oversized
    /// capacities are rejected.
    pub stream_queue_capacity: Option<usize>,
    /// Maximum total host-side time to write the start frame and wait for
    /// `MSG_EXEC_STARTED` for Workloads or `MSG_EXEC_AGENT_READY` for Agents.
    ///
    /// An Agent first sends `MSG_EXEC_STARTED`, but that PID acknowledgement
    /// does not complete the start or restart the original deadline. The Agent
    /// must send `MSG_EXEC_AGENT_READY` before that deadline expires.
    ///
    /// If this elapses before the complete start frame is written, no cancel
    /// frame is sent. If it elapses while waiting for the role-specific start
    /// event after a complete write, the host sends `MSG_EXEC_CANCEL` for the
    /// operation before returning a timeout error. If that cancel frame cannot
    /// be written within the bounded fallback window, the connection is
    /// poisoned because the guest process state is no longer known.
    ///
    /// A successful start-timeout cancellation still abandons terminal proof
    /// for this operation, so the connection should not be reused for later
    /// normal operations. A zero duration expires before the start frame is
    /// sent.
    pub start_timeout: Duration,
}

/// Host-side acknowledgement for a delivered exec-control request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecControlAck {
    /// Sequence number of the supervised exec operation that received control.
    pub target_seq: u32,
    /// Control message identifier echoed by the guest.
    pub message_id: String,
}

/// Guest-side terminal status for an exec-control request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecControlGuestStatus {
    /// Guest-reported control status other than delivered.
    pub status: ExecControlStatus,
    /// Guest-provided diagnostic text for the status.
    ///
    /// This may be empty when the guest has no additional diagnostic to
    /// report.
    pub diagnostic: String,
}

/// Terminal guest response for an exec-control request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecControlOutcome {
    /// The guest delivered the request to the control sink and accepted it.
    Delivered(ExecControlAck),
    /// The guest responded with a control status other than delivered.
    GuestStatus(ExecControlGuestStatus),
    /// The guest returned an error response for the pending control request.
    GuestError(String),
}

impl ExecControlOutcome {
    /// Return the delivered acknowledgement or convert guest failures to an error.
    ///
    /// Only `ExecControlOutcome::Delivered` yields `Ok`. Guest statuses and
    /// guest error responses become `io::Error` values.
    pub fn into_ack(self) -> io::Result<ExecControlAck> {
        match self {
            Self::Delivered(ack) => Ok(ack),
            Self::GuestStatus(status) => {
                Err(exec_control_status_error(status.status, &status.diagnostic))
            }
            Self::GuestError(message) => Err(io::Error::other(message)),
        }
    }
}

pub(in crate::exec_operation) fn exec_control_status_error(
    status: ExecControlStatus,
    diagnostic: &str,
) -> io::Error {
    let message = if diagnostic.is_empty() {
        default_exec_control_status_message(status).to_owned()
    } else {
        diagnostic.to_owned()
    };
    io::Error::new(exec_control_status_error_kind(status), message)
}

fn exec_control_status_error_kind(status: ExecControlStatus) -> io::ErrorKind {
    match status {
        ExecControlStatus::Delivered => io::ErrorKind::Other,
        ExecControlStatus::Inactive => io::ErrorKind::NotFound,
        ExecControlStatus::NonceMismatch => io::ErrorKind::PermissionDenied,
        ExecControlStatus::Unsupported => io::ErrorKind::Unsupported,
        ExecControlStatus::Rejected => io::ErrorKind::PermissionDenied,
        ExecControlStatus::SinkUnavailable => io::ErrorKind::NotConnected,
        ExecControlStatus::SinkTimeout => io::ErrorKind::TimedOut,
        ExecControlStatus::QueueFull => io::ErrorKind::WouldBlock,
        ExecControlStatus::SinkError | ExecControlStatus::SinkClosed => io::ErrorKind::BrokenPipe,
    }
}

fn default_exec_control_status_message(status: ExecControlStatus) -> &'static str {
    match status {
        ExecControlStatus::Delivered => "exec control request delivered",
        ExecControlStatus::Inactive => "exec operation is not active",
        ExecControlStatus::NonceMismatch => "exec operation nonce mismatch",
        ExecControlStatus::Unsupported => "exec control is not supported by this operation",
        ExecControlStatus::Rejected => "exec control request rejected",
        ExecControlStatus::SinkUnavailable => "exec control sink is not connected",
        ExecControlStatus::SinkTimeout => "exec control sink timed out",
        ExecControlStatus::QueueFull => "exec control queue is full",
        ExecControlStatus::SinkError => "exec control sink error",
        ExecControlStatus::SinkClosed => "exec control sink closed",
    }
}
