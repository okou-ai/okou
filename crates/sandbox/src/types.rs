use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Serialize};

/// Default host deadline for starting a supervised guest process.
pub const DEFAULT_PROCESS_START_TIMEOUT: Duration = Duration::from_secs(30);

/// Capture budgets for stdout/stderr returned by [`ExecRequest`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExecOutputLimits {
    /// Maximum stdout bytes to retain in [`ExecResult::stdout`].
    pub stdout_limit_bytes: u32,
    /// Maximum stderr bytes to retain in [`ExecResult::stderr`].
    pub stderr_limit_bytes: u32,
}

impl ExecOutputLimits {
    /// Use the same capture budget for stdout and stderr.
    pub const fn same(limit_bytes: u32) -> Self {
        Self {
            stdout_limit_bytes: limit_bytes,
            stderr_limit_bytes: limit_bytes,
        }
    }

    /// Use separate stdout and stderr capture budgets.
    pub const fn separate(stdout_limit_bytes: u32, stderr_limit_bytes: u32) -> Self {
        Self {
            stdout_limit_bytes,
            stderr_limit_bytes,
        }
    }
}

/// Small diagnostic output budget for helper commands.
pub const EXEC_OUTPUT_LIMIT_64_KIB: ExecOutputLimits = ExecOutputLimits::same(64 * 1024);
/// Default output budget for ordinary bounded guest commands.
pub const EXEC_OUTPUT_LIMIT_1_MIB: ExecOutputLimits = ExecOutputLimits::same(1024 * 1024);
/// Larger output budget used by interactive runner exec-style tooling.
pub const EXEC_OUTPUT_LIMIT_7_MIB: ExecOutputLimits = ExecOutputLimits::same(7 * 1024 * 1024);

/// One guest file entry for a typed multi-file write operation.
///
/// The selected [`crate::Sandbox`] method defines whether entries use ordinary
/// or private runtime-file semantics.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WriteFileEntry<'a> {
    /// Guest path to create or replace.
    pub path: &'a str,
    /// Bytes to write to the guest path.
    pub content: &'a [u8],
}

/// Request for a bounded command whose output is captured in memory.
pub struct ExecRequest<'a> {
    /// Shell command to run inside the guest.
    pub cmd: &'a str,
    /// Guest-side command timeout.
    pub timeout: Duration,
    /// Environment variables passed to the command. Keys must satisfy the guest
    /// shell exec env key contract.
    pub env: &'a [(&'a str, &'a str)],
    /// Run the command with guest-side sudo privileges.
    pub sudo: bool,
    /// Additional ordinary exit codes expected by guest-side diagnostics.
    ///
    /// Exit code zero is always expected. Listed codes remain unchanged in
    /// the returned [`ExecTermination`].
    pub expected_exit_codes: &'a [i32],
    /// Optional bounded stdin payload written to the child and then closed.
    pub stdin_bytes: Option<&'a [u8]>,
    /// Maximum captured stdout/stderr bytes.
    pub output_limits: ExecOutputLimits,
}

/// Request to apply one bounded storage manifest inside the guest.
///
/// The provider selects the fixed guest helper and argument contract. Callers
/// supply only the canonical manifest bytes and the run-scoped context needed
/// by that helper. Manifests outside the provider's bounded transport belong
/// on the caller's established fallback path.
pub struct StorageManifestRequest<'a> {
    /// Canonical JSON or `guest_contracts::storage_files::encode_input` output
    /// passed to the fixed guest helper. Binary input has its own bounded section;
    /// it does not increase the generic exec-stdin limit.
    pub manifest_json: &'a [u8],
    /// Run identity exposed to the helper through the guest run-id contract.
    pub run_id: &'a str,
    /// Absolute guest runtime directory exposed to the helper.
    pub runtime_dir: &'a str,
    /// Guest-side helper timeout.
    pub timeout: Duration,
}

/// Request for the fixed live session-history identity verifier.
///
/// The provider selects the executable, subcommand, process identity,
/// containment, output bounds, and transport lifecycle. Callers supply only
/// the identity values consumed by that helper.
pub struct SessionHistoryIdentityVerifyRequest<'a> {
    /// Absolute path to the final identity metadata inside the guest.
    pub metadata_path: &'a str,
    /// Absolute canonical runtime directory exposed to the helper.
    pub runtime_dir: &'a str,
    /// Stable CLI framework spelling expected by the helper.
    pub framework: &'a str,
    /// SHA-256 hash of the expected normalized session identifier.
    pub session_id_hash: &'a str,
    /// Stable history-reference-kind spelling expected by the helper.
    pub history_ref_kind: &'a str,
    /// SHA-256 hash of the expected final session-history bytes.
    pub history_hash: &'a str,
    /// Exact expected final session-history byte length.
    pub history_size_bytes: u64,
    /// Guest-side helper timeout.
    pub timeout: Duration,
}

/// Request for the fixed reused-Codex session cleanup helper.
///
/// The provider selects the executable, subcommand, process identity,
/// containment, output bounds, and transport lifecycle. Callers supply only
/// the canonical session identity and fallback logical rollout path.
pub struct CodexSessionCleanupRequest<'a> {
    /// Canonical lowercase hyphenated Codex thread identifier.
    pub session_id: &'a str,
    /// Canonical logical rollout path relative to the fixed Codex home.
    pub fallback_relative_path: &'a str,
    /// Guest-side helper timeout.
    pub timeout: Duration,
}

/// Timezone behavior for a fixed guest-state restore operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GuestStateRestoreTimezone<'a> {
    /// Leave the guest timezone unchanged.
    None,
    /// Attempt timezone synchronization without failing the restore.
    BestEffort(&'a str),
    /// Require timezone synchronization to succeed.
    Required(&'a str),
}

/// Request to restore snapshot-sensitive guest state through a fixed helper.
///
/// The provider selects the executable, root identity, arguments, containment,
/// and output bounds. Callers supply only the state values consumed by that
/// operation.
pub struct GuestStateRestoreRequest<'a> {
    /// Whole Unix timestamp seconds applied to the guest realtime clock.
    pub unix_seconds: u64,
    /// Nanoseconds within the Unix timestamp second.
    pub unix_nanoseconds: u32,
    /// Exact host entropy payload mixed into the guest CRNG.
    pub entropy: &'a [u8; 256],
    /// Optional guest timezone behavior.
    pub timezone: GuestStateRestoreTimezone<'a>,
    /// Guest-side helper timeout.
    pub timeout: Duration,
}

impl GuestStateRestoreRequest<'_> {
    /// Return the timeout as milliseconds, saturating at `u32::MAX`.
    ///
    /// Non-zero sub-millisecond durations round up to 1ms so callers do not
    /// accidentally turn a bounded operation into a zero-timeout request.
    pub fn timeout_ms(&self) -> u32 {
        duration_ms(self.timeout)
    }
}

impl StorageManifestRequest<'_> {
    /// Return the timeout as milliseconds, saturating at `u32::MAX`.
    ///
    /// Non-zero sub-millisecond durations round up to 1ms so callers do not
    /// accidentally turn a bounded operation into a zero-timeout request.
    pub fn timeout_ms(&self) -> u32 {
        duration_ms(self.timeout)
    }
}

impl SessionHistoryIdentityVerifyRequest<'_> {
    /// Return the timeout as milliseconds, saturating at `u32::MAX`.
    ///
    /// Non-zero sub-millisecond durations round up to 1ms so callers do not
    /// accidentally turn a bounded operation into a zero-timeout request.
    pub fn timeout_ms(&self) -> u32 {
        duration_ms(self.timeout)
    }
}

impl CodexSessionCleanupRequest<'_> {
    /// Return the timeout as milliseconds, saturating at `u32::MAX`.
    ///
    /// Non-zero sub-millisecond durations round up to 1ms so callers do not
    /// accidentally turn a bounded operation into a zero-timeout request.
    pub fn timeout_ms(&self) -> u32 {
        duration_ms(self.timeout)
    }
}

impl ExecRequest<'_> {
    /// Return the timeout as milliseconds, saturating at `u32::MAX`.
    ///
    /// Non-zero sub-millisecond durations round up to 1ms so callers do not
    /// accidentally turn a bounded operation into a zero-timeout request.
    pub fn timeout_ms(&self) -> u32 {
        duration_ms(self.timeout)
    }
}

/// Request for a guest process that can outlive the initial start request and
/// is supervised through [`GuestProcessHandle`].
pub struct StartProcessRequest<'a> {
    /// Shell command to run inside the guest.
    pub cmd: &'a str,
    /// Guest-side process timeout.
    pub timeout: Duration,
    /// Whether a clean guest execution timeout is an expected best-effort outcome.
    ///
    /// Only changes host terminal logging to info. The timeout result, deadlines,
    /// start/wait errors, and warnings for additional diagnostics or output loss
    /// are unchanged.
    pub timeout_is_expected: bool,
    /// Host deadline for writing the start request and receiving the guest
    /// process-start acknowledgement.
    pub start_timeout: Duration,
    /// Environment variables passed to the command. Keys must satisfy the guest
    /// shell exec env key contract.
    pub env: &'a [(&'a str, &'a str)],
    /// Run the command with guest-side sudo privileges.
    pub sudo: bool,
    /// Buffered or streamed stdout behavior.
    pub output: ProcessOutputMode,
}

impl StartProcessRequest<'_> {
    /// Return the timeout as milliseconds, saturating at `u32::MAX`.
    ///
    /// Non-zero sub-millisecond durations round up to 1ms so callers do not
    /// accidentally turn a bounded process into an unbounded one.
    pub fn timeout_ms(&self) -> u32 {
        duration_ms(self.timeout)
    }
}

/// Request for the controlled guest Agent process.
///
/// Agent startup is intentionally separate from ordinary supervised process
/// startup so generic callers cannot select the controlled Agent topology.
pub struct StartAgentProcessRequest<'a> {
    /// Guest-side Agent supervisor timeout.
    pub timeout: Duration,
    /// Environment variables passed to the fixed Guest Agent executable.
    pub env: &'a [(&'a str, &'a str)],
    /// Buffered or streamed Agent output behavior.
    pub output: ProcessOutputMode,
}

impl StartAgentProcessRequest<'_> {
    /// Return the timeout as milliseconds, saturating at `u32::MAX`.
    pub fn timeout_ms(&self) -> u32 {
        duration_ms(self.timeout)
    }
}

fn duration_ms(timeout: Duration) -> u32 {
    if timeout.is_zero() {
        0
    } else {
        u32::try_from(timeout.as_millis())
            .unwrap_or(u32::MAX)
            .max(1)
    }
}

/// Terminal state for a sandbox exec command.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExecTermination {
    /// The process exited with an ordinary exit code.
    Exited {
        /// Signed process exit code reported by the sandbox provider.
        exit_code: i32,
    },
    /// The provider timed the process out.
    TimedOut,
    /// The provider cancelled the process.
    Cancelled,
    /// The provider failed to start the process.
    StartFailed,
    /// The provider failed while waiting for the process.
    WaitFailed,
}

impl<'de> Deserialize<'de> for ExecTermination {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // Internally tagged unit variants ignore unknown fields by default, so
        // parse the map manually to keep terminal states mutually exclusive.
        const FIELDS: &[&str] = &["kind", "exit_code"];

        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case")]
        enum TerminationKind {
            Exited,
            TimedOut,
            Cancelled,
            StartFailed,
            WaitFailed,
        }

        enum Field {
            Kind,
            ExitCode,
        }

        impl<'de> Deserialize<'de> for Field {
            fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct FieldVisitor;

                impl Visitor<'_> for FieldVisitor {
                    type Value = Field;

                    fn expecting(
                        &self,
                        formatter: &mut std::fmt::Formatter<'_>,
                    ) -> std::fmt::Result {
                        formatter.write_str("a sandbox exec termination field")
                    }

                    fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
                    where
                        E: de::Error,
                    {
                        match value {
                            "kind" => Ok(Field::Kind),
                            "exit_code" => Ok(Field::ExitCode),
                            _ => Err(de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }

                deserializer.deserialize_identifier(FieldVisitor)
            }
        }

        struct TerminationVisitor;

        impl<'de> Visitor<'de> for TerminationVisitor {
            type Value = ExecTermination;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a sandbox exec termination object")
            }

            fn visit_map<M>(self, mut map: M) -> std::result::Result<Self::Value, M::Error>
            where
                M: MapAccess<'de>,
            {
                let mut kind = None;
                let mut exit_code = None;

                while let Some(field) = map.next_key()? {
                    match field {
                        Field::Kind => {
                            if kind.is_some() {
                                return Err(de::Error::duplicate_field("kind"));
                            }
                            kind = Some(map.next_value()?);
                        }
                        Field::ExitCode => {
                            if exit_code.is_some() {
                                return Err(de::Error::duplicate_field("exit_code"));
                            }
                            exit_code = Some(map.next_value::<Option<i32>>()?);
                        }
                    }
                }

                let kind = kind.ok_or_else(|| de::Error::missing_field("kind"))?;
                match kind {
                    TerminationKind::Exited => match exit_code {
                        Some(Some(exit_code)) => Ok(ExecTermination::Exited { exit_code }),
                        Some(None) | None => Err(de::Error::missing_field("exit_code")),
                    },
                    TerminationKind::TimedOut => {
                        non_exited_termination(exit_code, ExecTermination::TimedOut)
                    }
                    TerminationKind::Cancelled => {
                        non_exited_termination(exit_code, ExecTermination::Cancelled)
                    }
                    TerminationKind::StartFailed => {
                        non_exited_termination(exit_code, ExecTermination::StartFailed)
                    }
                    TerminationKind::WaitFailed => {
                        non_exited_termination(exit_code, ExecTermination::WaitFailed)
                    }
                }
            }
        }

        deserializer.deserialize_map(TerminationVisitor)
    }
}

fn non_exited_termination<E>(
    exit_code: Option<Option<i32>>,
    termination: ExecTermination,
) -> std::result::Result<ExecTermination, E>
where
    E: de::Error,
{
    if exit_code.is_some() {
        return Err(E::custom("exit_code is only valid for exited termination"));
    }

    Ok(termination)
}

/// Result of a bounded command execution.
pub struct ExecResult {
    /// Structured terminal state reported by the provider.
    pub termination: ExecTermination,
    /// Guest-reported wall-clock duration in milliseconds, when the provider has
    /// terminal duration metadata.
    pub guest_duration_ms: Option<u32>,
    /// Captured stdout bytes, capped by the requested output limit.
    pub stdout: Vec<u8>,
    /// Captured stderr bytes, capped by the requested output limit.
    pub stderr: Vec<u8>,
    /// Provider diagnostic text associated with the terminal state.
    pub diagnostic: String,
    /// True when stdout exceeded the requested output limit.
    pub stdout_truncated: bool,
    /// True when stderr exceeded the requested output limit.
    pub stderr_truncated: bool,
}

impl ExecResult {
    /// Construct an ordinary exited-process result.
    ///
    /// The returned value has no guest duration, diagnostic, or truncation
    /// metadata.
    pub fn new(exit_code: i32, stdout: Vec<u8>, stderr: Vec<u8>) -> Self {
        Self {
            termination: ExecTermination::Exited { exit_code },
            guest_duration_ms: None,
            stdout,
            stderr,
            diagnostic: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        }
    }
}

/// Options for copying a guest file to a host path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CopyFileOptions {
    /// Maximum bytes to copy before failing.
    ///
    /// This value must be positive and is subject to the backend copy limit.
    pub max_bytes: u64,
    /// Guest-side copy command timeout.
    ///
    /// This value must be non-zero.
    pub timeout: Duration,
    /// Treat a backend result that reports the path does not resolve to a
    /// regular file as a successful copy result.
    ///
    /// When such a backend result is treated as success, the operation returns
    /// `bytes_copied == 0` without creating an empty host file or replacing an
    /// existing host file.
    pub missing_ok: bool,
}

impl CopyFileOptions {
    /// Return the timeout as milliseconds, saturating at `u32::MAX`.
    ///
    /// Non-zero sub-millisecond durations round up to 1ms so callers do not
    /// accidentally turn a bounded copy into a zero-timeout request.
    pub fn timeout_ms(&self) -> u32 {
        duration_ms(self.timeout)
    }
}

/// Result of copying a guest file to a host path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CopyFileResult {
    /// Number of bytes copied from the guest file.
    ///
    /// This is `0` for a present empty guest file, which still publishes an
    /// empty host file. It is also `0` when `missing_ok` turns a backend
    /// result that reports the path does not resolve to a regular file into
    /// success; in that case no host file is published.
    pub bytes_copied: u64,
}

/// Process stdout stream event delivered to sandbox callers.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ProcessOutputChunk {
    /// Output bytes from the guest process stdout stream.
    pub bytes: Vec<u8>,
    /// True when this chunk was truncated by the guest stream budget.
    pub truncated: bool,
}

/// Bounded receiver for process stdout chunks.
pub type ProcessOutputReceiver = tokio::sync::mpsc::Receiver<ProcessOutputChunk>;

/// Backend-owned future that resolves when a started process exits.
///
/// Sandbox implementations store this in [`GuestProcessHandle`] so
/// [`Sandbox::wait_process`](crate::Sandbox::wait_process) can consume the exact
/// backend operation created by [`Sandbox::start_process`](crate::Sandbox::start_process).
pub type GuestProcessWaitFuture =
    Pin<Box<dyn Future<Output = std::io::Result<ProcessExit>> + Send + 'static>>;

type GuestProcessWaitFn = dyn FnOnce(Duration) -> GuestProcessWaitFuture + Send + 'static;

/// Backend-owned process waiter that accepts the host-side wait timeout.
pub struct GuestProcessWaiter {
    wait: Box<GuestProcessWaitFn>,
}

impl GuestProcessWaiter {
    /// Construct a one-shot waiter from provider-owned exit-observation logic.
    ///
    /// `wait` must own the backend state needed to observe the terminal
    /// [`ProcessExit`]. The closure receives the host-side timeout when
    /// [`Self::wait`] consumes this waiter.
    pub fn new<F>(wait: F) -> Self
    where
        F: FnOnce(Duration) -> GuestProcessWaitFuture + Send + 'static,
    {
        Self {
            wait: Box::new(wait),
        }
    }

    /// Consume this waiter and start the provider's exit-observation operation.
    ///
    /// `timeout` bounds how long the provider should wait for the terminal
    /// [`ProcessExit`]. Consuming `self` ensures that the provider operation can
    /// be started at most once.
    ///
    /// Sandbox callers should normally pass the containing
    /// [`GuestProcessHandle`] to
    /// [`Sandbox::wait_process`](crate::Sandbox::wait_process) instead of
    /// invoking the waiter directly.
    pub fn wait(self, timeout: Duration) -> GuestProcessWaitFuture {
        (self.wait)(timeout)
    }
}

/// Backend-owned future that resolves after a best-effort process cancel request
/// has been sent to the guest.
pub type GuestProcessCancelFuture =
    Pin<Box<dyn Future<Output = std::io::Result<()>> + Send + 'static>>;

type GuestProcessCancelFn = dyn FnOnce(Duration) -> GuestProcessCancelFuture + Send + 'static;

/// One-shot handle for asking the backend to cancel a started guest process.
pub struct GuestProcessCancelHandle {
    cancel: Box<GuestProcessCancelFn>,
}

impl GuestProcessCancelHandle {
    /// Construct a one-shot handle from provider-owned cancellation logic.
    ///
    /// `cancel` must own the backend state needed to send a best-effort
    /// cancellation request. The closure receives the host-side timeout when
    /// [`Self::cancel`] consumes this handle; its completion does not observe
    /// the terminal [`ProcessExit`].
    pub fn new<F>(cancel: F) -> Self
    where
        F: FnOnce(Duration) -> GuestProcessCancelFuture + Send + 'static,
    {
        Self {
            cancel: Box::new(cancel),
        }
    }

    /// Consume this handle and run the provider's cancellation operation.
    ///
    /// `timeout` bounds how long the provider should spend sending the
    /// best-effort cancellation request. Consuming `self` ensures that the
    /// provider operation can run at most once.
    ///
    /// A successful result only confirms that the cancellation request was
    /// sent; it does not report process termination. Observe the terminal
    /// result separately by passing the containing [`GuestProcessHandle`] to
    /// [`Sandbox::wait_process`](crate::Sandbox::wait_process).
    pub async fn cancel(self, timeout: Duration) -> std::io::Result<()> {
        (self.cancel)(timeout).await
    }
}

/// Backend-owned future that resolves when a process-control message is acknowledged.
pub type GuestProcessControlFuture =
    Pin<Box<dyn Future<Output = io::Result<ProcessControlAck>> + Send + 'static>>;

/// Backend-owned future that preserves a process-control delivery outcome.
pub type GuestProcessControlOutcomeFuture =
    Pin<Box<dyn Future<Output = ProcessControlOutcome> + Send + 'static>>;

type GuestProcessControlFn =
    dyn Fn(String, Vec<u8>, Duration) -> GuestProcessControlOutcomeFuture + Send + Sync + 'static;

/// Acknowledgement returned by an operation-bound process-control sink.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ProcessControlAck {
    /// Message id acknowledged by the provider for the submitted control
    /// payload.
    pub message_id: String,
}

/// Matched non-delivered status returned by a guest process-control sink.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessControlGuestStatus {
    /// The supervised guest process is no longer active.
    Inactive,
    /// The request did not match the operation's control nonce.
    NonceMismatch,
    /// The supervised operation does not support process control.
    Unsupported,
    /// The guest rejected the control request.
    Rejected,
    /// The guest process-control sink is not connected.
    SinkUnavailable,
    /// The guest process-control sink timed out.
    SinkTimeout,
    /// The guest process-control queue is full.
    QueueFull,
    /// The guest process-control sink returned an error.
    SinkError,
    /// The connected guest process-control sink closed during request I/O.
    SinkClosed,
}

impl ProcessControlGuestStatus {
    fn error_kind(self) -> io::ErrorKind {
        match self {
            Self::Inactive => io::ErrorKind::NotFound,
            Self::NonceMismatch | Self::Rejected => io::ErrorKind::PermissionDenied,
            Self::Unsupported => io::ErrorKind::Unsupported,
            Self::SinkUnavailable => io::ErrorKind::NotConnected,
            Self::SinkTimeout => io::ErrorKind::TimedOut,
            Self::QueueFull => io::ErrorKind::WouldBlock,
            Self::SinkError | Self::SinkClosed => io::ErrorKind::BrokenPipe,
        }
    }

    fn default_error_message(self) -> &'static str {
        match self {
            Self::Inactive => "exec operation is not active",
            Self::NonceMismatch => "exec operation nonce mismatch",
            Self::Unsupported => "exec control is not supported by this operation",
            Self::Rejected => "exec control request rejected",
            Self::SinkUnavailable => "exec control sink is not connected",
            Self::SinkTimeout => "exec control sink timed out",
            Self::QueueFull => "exec control queue is full",
            Self::SinkError => "exec control sink error",
            Self::SinkClosed => "exec control sink closed",
        }
    }
}

/// Root cause for an unmatched process-control failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessControlFailureKind {
    /// The provider operation failed without a confirmed backend crash.
    Operation,
    /// The provider backend crashed while the operation was in flight.
    BackendCrashed,
}

/// Provider evidence about whether a failed request reached its write boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessControlWriteState {
    /// The provider knows that the request did not reach its write boundary.
    NotWritten,
    /// The request reached its write boundary and may have reached the Guest.
    PossiblyWritten,
}

/// Provider-neutral terminal outcome for one process-control request.
#[derive(Debug)]
pub enum ProcessControlOutcome {
    /// The Guest delivered the request to the process-control sink.
    Delivered(ProcessControlAck),
    /// The Guest returned a matched non-delivered status.
    GuestStatus {
        /// Structured Guest status.
        status: ProcessControlGuestStatus,
        /// Guest-provided diagnostic text, which may be empty.
        diagnostic: String,
    },
    /// The Guest returned a generic matched error response.
    GuestError(String),
    /// The provider failed without receiving a matched Guest response.
    Failed {
        /// Root cause for the provider failure.
        kind: ProcessControlFailureKind,
        /// Whether the request may have crossed the provider write boundary.
        write_state: ProcessControlWriteState,
        /// Original provider error retained for acknowledgement compatibility.
        error: io::Error,
    },
}

impl ProcessControlOutcome {
    /// Return the delivered acknowledgement or convert other outcomes to legacy errors.
    pub fn into_ack(self) -> io::Result<ProcessControlAck> {
        match self {
            Self::Delivered(ack) => Ok(ack),
            Self::GuestStatus { status, diagnostic } => {
                let message = if diagnostic.is_empty() {
                    status.default_error_message().to_owned()
                } else {
                    diagnostic
                };
                Err(io::Error::new(status.error_kind(), message))
            }
            Self::GuestError(message) => Err(io::Error::other(message)),
            Self::Failed { error, .. } => Err(error),
        }
    }
}

/// Cloneable handle for sending opaque control payloads to a live guest process.
#[derive(Clone)]
pub struct GuestProcessControlHandle {
    control: Arc<GuestProcessControlFn>,
}

impl GuestProcessControlHandle {
    /// Construct a process-control handle from provider-owned send logic.
    ///
    /// The `sandbox` crate treats control payloads as opaque bytes. The
    /// provider and guest process define the payload schema and acknowledgement
    /// semantics for a given started process.
    ///
    /// Provider errors are conservatively exposed by the outcome methods as
    /// [`ProcessControlWriteState::PossiblyWritten`]. Providers with precise
    /// delivery evidence should use [`Self::new_with_outcome`].
    pub fn new<F>(control: F) -> Self
    where
        F: Fn(String, Vec<u8>, Duration) -> GuestProcessControlFuture + Send + Sync + 'static,
    {
        let control = Arc::new(control);
        Self::new_with_outcome(move |message_id, payload, timeout| {
            let control = Arc::clone(&control);
            Box::pin(async move {
                match control(message_id, payload, timeout).await {
                    Ok(ack) => ProcessControlOutcome::Delivered(ack),
                    Err(error) => ProcessControlOutcome::Failed {
                        kind: ProcessControlFailureKind::Operation,
                        write_state: ProcessControlWriteState::PossiblyWritten,
                        error,
                    },
                }
            })
        })
    }

    /// Construct a handle from provider logic that preserves delivery outcomes.
    ///
    /// The provider must classify unmatched failures relative to its write
    /// boundary and retain matched guest responses as structured outcomes.
    pub fn new_with_outcome<F>(control: F) -> Self
    where
        F: Fn(String, Vec<u8>, Duration) -> GuestProcessControlOutcomeFuture
            + Send
            + Sync
            + 'static,
    {
        Self {
            control: Arc::new(control),
        }
    }

    /// Send an opaque control payload to the live guest process.
    ///
    /// `message_id` identifies the control message for provider
    /// acknowledgement. `timeout` bounds how long the provider should wait for
    /// the control sink to acknowledge the payload. Providers may add a bounded
    /// response allowance to retain the sink's deadline result: Firecracker
    /// waits for the wire-normalized Guest budget plus 250 ms after writing the
    /// request. This is not an end-to-end deadline covering write queuing.
    pub async fn control(
        &self,
        message_id: &str,
        payload: &[u8],
        timeout: Duration,
    ) -> io::Result<ProcessControlAck> {
        self.control_outcome(message_id, payload, timeout)
            .await
            .into_ack()
    }

    /// Send an owned opaque control payload to the live guest process.
    ///
    /// This has the same behavior as [`Self::control`] but transfers ownership
    /// of `message_id` and `payload` so callers that already own large request
    /// data do not need to clone it for the provider callback.
    pub async fn control_owned(
        &self,
        message_id: String,
        payload: Vec<u8>,
        timeout: Duration,
    ) -> io::Result<ProcessControlAck> {
        self.control_owned_outcome(message_id, payload, timeout)
            .await
            .into_ack()
    }

    /// Send an opaque control payload and preserve its terminal delivery outcome.
    ///
    /// Cancelling this future yields no outcome. A caller that needs to decide
    /// whether retry is safe must retain ownership until the future resolves.
    pub async fn control_outcome(
        &self,
        message_id: &str,
        payload: &[u8],
        timeout: Duration,
    ) -> ProcessControlOutcome {
        self.control_owned_outcome(message_id.to_owned(), payload.to_vec(), timeout)
            .await
    }

    /// Send owned control data and preserve its terminal delivery outcome.
    ///
    /// This has the same behavior as [`Self::control_outcome`] but transfers
    /// ownership of `message_id` and `payload` to the provider callback.
    pub async fn control_owned_outcome(
        &self,
        message_id: String,
        payload: Vec<u8>,
        timeout: Duration,
    ) -> ProcessControlOutcome {
        (self.control)(message_id, payload, timeout).await
    }
}

/// Handle returned by [`Sandbox::start_process`](crate::Sandbox::start_process).
///
/// The handle owns backend-specific exit state and must be consumed by
/// [`Sandbox::wait_process`](crate::Sandbox::wait_process). When stdout streaming is
/// enabled, callers may use [`take_stdout_receiver`](Self::take_stdout_receiver)
/// before waiting; if they do, they must drain it while the process runs.
#[must_use = "retain this process handle and complete supervision with Sandbox::wait_process"]
pub struct GuestProcessHandle {
    /// Guest process id reported by the provider.
    ///
    /// This is distinct from the host-side sandbox backing process id returned
    /// by [`Sandbox::host_process_pid`](crate::Sandbox::host_process_pid).
    pub guest_pid: u32,
    /// Receives stdout chunks in real-time when the guest streams them.
    /// `None` when the backend does not support streaming.
    stdout_rx: Option<ProcessOutputReceiver>,
    control: Option<GuestProcessControlHandle>,
    cancel: Option<GuestProcessCancelHandle>,
    wait: Option<GuestProcessWaiter>,
    close_unclaimed_stdout: Option<Box<dyn FnOnce() + Send + 'static>>,
}

impl GuestProcessHandle {
    /// Construct a guest process handle from backend-owned process state.
    pub fn new(
        guest_pid: u32,
        stdout_rx: Option<ProcessOutputReceiver>,
        control: Option<GuestProcessControlHandle>,
        wait: GuestProcessWaiter,
    ) -> Self {
        Self {
            guest_pid,
            stdout_rx,
            control,
            cancel: None,
            wait: Some(wait),
            close_unclaimed_stdout: None,
        }
    }

    /// Return whether this handle currently owns a stdout receiver.
    pub fn has_stdout_receiver(&self) -> bool {
        self.stdout_rx.is_some()
    }

    /// Take the stdout receiver so the caller can drain streamed output.
    pub fn take_stdout_receiver(&mut self) -> Option<ProcessOutputReceiver> {
        self.stdout_rx.take()
    }

    /// Register backend cleanup for an unclaimed stdout receiver.
    pub fn with_unclaimed_stdout_cleanup<F>(mut self, close: F) -> Self
    where
        F: FnOnce() + Send + 'static,
    {
        self.close_unclaimed_stdout = Some(Box::new(close));
        self
    }

    /// Attach a one-shot process cancel handle provided by the backend.
    pub fn with_cancel_handle(mut self, cancel: GuestProcessCancelHandle) -> Self {
        self.cancel = Some(cancel);
        self
    }

    /// Return a cloneable control handle when this process was started with a
    /// control sink.
    pub fn control_handle(&self) -> Option<GuestProcessControlHandle> {
        self.control.clone()
    }

    /// Consume the backend process waiter.
    ///
    /// This is intended for sandbox backend implementations of
    /// [`Sandbox::wait_process`](crate::Sandbox::wait_process); ordinary callers should
    /// pass the handle to that trait method instead.
    pub fn take_waiter(&mut self) -> Option<GuestProcessWaiter> {
        self.wait.take()
    }

    /// Consume the backend process cancel handle, if supported.
    pub fn take_cancel_handle(&mut self) -> Option<GuestProcessCancelHandle> {
        self.cancel.take()
    }

    /// Drop a stdout receiver that the caller did not take before waiting.
    pub fn drop_unclaimed_stdout(&mut self) {
        if self.stdout_rx.take().is_some()
            && let Some(close) = self.close_unclaimed_stdout.take()
        {
            close();
        }
    }
}

/// Handle returned by
/// [`Sandbox::start_agent_process`](crate::Sandbox::start_agent_process).
///
/// A successful Agent start always includes the process-control capability.
/// The process handle remains the sole owner of wait, cancellation, stdout,
/// and drop cleanup state.
#[must_use = "retain this Agent process handle and complete supervision with Sandbox::wait_process"]
pub struct GuestAgentProcessHandle {
    process: GuestProcessHandle,
    control: GuestProcessControlHandle,
    start_timing: GuestAgentStartTiming,
}

/// Provider-neutral timing captured at the controlled Agent readiness boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GuestAgentStartTiming {
    /// Host monotonic instant when the guest controlled process was spawned.
    pub shell_started_at: Instant,
    /// Host monotonic instant when Agent runtime placement was confirmed.
    pub ready_at: Instant,
    /// Guest time spent creating the per-exec process containment hierarchy.
    pub containment_create: Duration,
    /// Guest time spent creating workload and tool placement brokers.
    pub placement_broker_setup: Duration,
    /// Guest time spent launching the controlled process.
    ///
    /// The `shell_spawn` name remains stable for timing-series compatibility;
    /// direct Agent launch does not execute a shell.
    pub shell_spawn: Duration,
    /// Guest time from controlled-process launch through confirmed placement.
    pub bootstrap_ready_wait: Duration,
}

impl GuestAgentProcessHandle {
    /// Convert a provider process handle into a controlled Agent handle.
    pub fn try_from_process(
        mut process: GuestProcessHandle,
        start_timing: GuestAgentStartTiming,
    ) -> crate::Result<Self> {
        let Some(control) = process.control.take() else {
            return Err(crate::SandboxError::Operation {
                operation: crate::SandboxOperation::StartAgentProcess,
                reason: crate::SandboxOperationReason::Other,
                message: "provider returned an Agent process without process control".into(),
            });
        };
        Ok(Self {
            process,
            control,
            start_timing,
        })
    }

    /// Return timing captured while the controlled Agent became ready.
    pub fn start_timing(&self) -> GuestAgentStartTiming {
        self.start_timing
    }

    /// Consume the Agent handle into its process owner and control capability.
    pub fn into_parts(self) -> (GuestProcessHandle, GuestProcessControlHandle) {
        (self.process, self.control)
    }
}

impl Drop for GuestProcessHandle {
    fn drop(&mut self) {
        self.drop_unclaimed_stdout();
    }
}

/// Output handling mode for a process started with
/// [`Sandbox::start_process`](crate::Sandbox::start_process).
///
/// Buffered mode returns captured output in [`ProcessExit`]. Stream mode
/// requests real-time stdout delivery through
/// [`GuestProcessHandle::take_stdout_receiver`] when the provider returns a
/// receiver. Callers must handle providers that return no receiver and must
/// drain a returned receiver while the process runs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessOutputMode {
    /// Capture stdout and stderr into the final [`ProcessExit`].
    Buffered {
        /// Capture limits for stdout and stderr bytes retained in
        /// [`ProcessExit`].
        output_limits: ExecOutputLimits,
    },
    /// Request real-time stdout delivery through a bounded host receiver.
    ///
    /// By default this mode requests stdout streaming only. Callers that need
    /// startup diagnostics can request a small captured stderr tail without
    /// changing stdout streaming behavior.
    Stream {
        /// Maximum stdout bytes the guest should emit as stream chunks.
        ///
        /// This is a guest-side stream budget. It is separate from captured
        /// output truncation and from host queue overflow.
        stream_limit_bytes: u32,
        /// Maximum bytes in a single stdout stream chunk.
        chunk_limit_bytes: u32,
        /// Capacity of the host-side stdout delivery queue.
        ///
        /// This must be positive and no larger than
        /// [`MAX_QUEUE_CAPACITY`](ProcessOutputMode::MAX_QUEUE_CAPACITY).
        ///
        /// This bounds host buffering for delivered chunks. It is not a
        /// guarantee that a slow caller applies backpressure to the guest; host
        /// delivery overflow is reported through [`ProcessExit::stream_overflowed`].
        /// The queue retains at most this many chunks; the next valid chunk
        /// closes delivery and marks the process exit as overflowed.
        queue_capacity: usize,
        /// Optional captured stderr byte limit retained in [`ProcessExit`].
        ///
        /// When unset, providers may discard stderr in stream mode.
        stderr_capture_limit_bytes: Option<u32>,
    },
}

impl ProcessOutputMode {
    /// Default stream byte budget for long-running process logs.
    pub const DEFAULT_STREAM_LIMIT_BYTES: u32 = 64 * 1024 * 1024;
    /// Default maximum size of each streamed process stdout chunk.
    pub const DEFAULT_CHUNK_LIMIT_BYTES: u32 = 64 * 1024;
    /// Maximum supported host queue capacity for process stdout chunks.
    pub const MAX_QUEUE_CAPACITY: usize = 8192;
    /// Default bounded host queue capacity for process stdout chunks.
    pub const DEFAULT_QUEUE_CAPACITY: usize = Self::MAX_QUEUE_CAPACITY;

    /// Return buffered output mode with the supplied capture limits.
    pub const fn buffered(output_limits: ExecOutputLimits) -> Self {
        Self::Buffered { output_limits }
    }

    /// Return stdout stream mode with bounded defaults.
    ///
    /// The defaults are [`DEFAULT_STREAM_LIMIT_BYTES`](Self::DEFAULT_STREAM_LIMIT_BYTES),
    /// [`DEFAULT_CHUNK_LIMIT_BYTES`](Self::DEFAULT_CHUNK_LIMIT_BYTES), and
    /// [`DEFAULT_QUEUE_CAPACITY`](Self::DEFAULT_QUEUE_CAPACITY).
    pub const fn stream() -> Self {
        Self::Stream {
            stream_limit_bytes: Self::DEFAULT_STREAM_LIMIT_BYTES,
            chunk_limit_bytes: Self::DEFAULT_CHUNK_LIMIT_BYTES,
            queue_capacity: Self::DEFAULT_QUEUE_CAPACITY,
            stderr_capture_limit_bytes: None,
        }
    }

    /// Return stdout stream mode with bounded defaults and captured stderr.
    pub const fn stream_with_stderr_capture(stderr_capture_limit_bytes: u32) -> Self {
        Self::Stream {
            stream_limit_bytes: Self::DEFAULT_STREAM_LIMIT_BYTES,
            chunk_limit_bytes: Self::DEFAULT_CHUNK_LIMIT_BYTES,
            queue_capacity: Self::DEFAULT_QUEUE_CAPACITY,
            stderr_capture_limit_bytes: Some(stderr_capture_limit_bytes),
        }
    }

    /// Validate this mode for [`Sandbox::start_process`](crate::Sandbox::start_process).
    ///
    /// Stream chunk limits and queue capacities must be positive, and queue
    /// capacities must not exceed [`MAX_QUEUE_CAPACITY`](Self::MAX_QUEUE_CAPACITY).
    pub fn validate(self, operation: crate::SandboxOperation) -> crate::Result<()> {
        match self {
            Self::Stream {
                chunk_limit_bytes: 0,
                ..
            } => Err(crate::SandboxError::Operation {
                operation,
                reason: crate::SandboxOperationReason::Other,
                message: "process stream chunk limit must be positive".into(),
            }),
            Self::Stream {
                queue_capacity: 0, ..
            } => Err(crate::SandboxError::Operation {
                operation,
                reason: crate::SandboxOperationReason::Other,
                message: "process stream queue capacity must be positive".into(),
            }),
            Self::Stream { queue_capacity, .. } if queue_capacity > Self::MAX_QUEUE_CAPACITY => {
                Err(crate::SandboxError::Operation {
                    operation,
                    reason: crate::SandboxOperationReason::Other,
                    message: format!(
                        "process stream queue capacity must be at most {}",
                        Self::MAX_QUEUE_CAPACITY
                    ),
                })
            }
            Self::Buffered { .. } | Self::Stream { .. } => Ok(()),
        }
    }

    /// Return whether this mode requests stdout streaming.
    ///
    /// A `true` return value does not guarantee the provider will return a
    /// receiver. Callers should inspect
    /// [`GuestProcessHandle::take_stdout_receiver`] on the started process
    /// handle.
    pub fn streams_stdout(self) -> bool {
        matches!(self, Self::Stream { .. })
    }
}

/// Terminal status and output metadata for a started guest process.
pub struct ProcessExit {
    /// Guest process id reported by the provider.
    pub guest_pid: u32,
    /// Structured terminal state reported by the provider.
    pub termination: ExecTermination,
    /// Guest-reported wall-clock duration in milliseconds, when the provider has
    /// terminal duration metadata.
    pub guest_duration_ms: Option<u32>,
    /// Captured stdout bytes.
    ///
    /// In stream mode, callers should read streamed stdout from
    /// [`GuestProcessHandle::take_stdout_receiver`] when a receiver is
    /// available instead of treating this field as a complete copy of stdout.
    pub stdout: Vec<u8>,
    /// Captured stderr bytes.
    pub stderr: Vec<u8>,
    /// True when captured stdout exceeded the requested capture limit.
    pub stdout_truncated: bool,
    /// True when captured stderr exceeded the requested capture limit.
    pub stderr_truncated: bool,
    /// Provider or supervision diagnostic text.
    ///
    /// This is separate from ordinary process stderr.
    pub diagnostic: String,
    /// True when streamed output overflowed the host delivery queue.
    ///
    /// This is separate from captured-output truncation and from the
    /// per-chunk `truncated` flag on [`ProcessOutputChunk`].
    pub stream_overflowed: bool,
}

impl ProcessExit {
    /// Construct a process exit result with no truncation or stream metadata.
    ///
    /// The returned value sets `termination` to
    /// [`ExecTermination::Exited`], `guest_duration_ms` to `None`,
    /// `stdout_truncated` and `stderr_truncated` to `false`, `diagnostic` to an
    /// empty string, and `stream_overflowed` to `false`.
    pub fn new(guest_pid: u32, exit_code: i32, stdout: Vec<u8>, stderr: Vec<u8>) -> Self {
        Self {
            guest_pid,
            termination: ExecTermination::Exited { exit_code },
            guest_duration_ms: None,
            stdout,
            stderr,
            stdout_truncated: false,
            stderr_truncated: false,
            diagnostic: String::new(),
            stream_overflowed: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn guest_agent_start_timing() -> GuestAgentStartTiming {
        let ready_at = Instant::now();
        GuestAgentStartTiming {
            shell_started_at: ready_at,
            ready_at,
            containment_create: Duration::ZERO,
            placement_broker_setup: Duration::ZERO,
            shell_spawn: Duration::ZERO,
            bootstrap_ready_wait: Duration::ZERO,
        }
    }

    #[test]
    fn timeout_ms_normal() {
        let req = ExecRequest {
            cmd: "echo hi",
            timeout: Duration::from_millis(5000),
            env: &[],
            sudo: false,
            expected_exit_codes: &[],
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
        };
        assert_eq!(req.timeout_ms(), 5000);
    }

    #[test]
    fn timeout_ms_zero() {
        let req = ExecRequest {
            cmd: "true",
            timeout: Duration::ZERO,
            env: &[],
            sudo: false,
            expected_exit_codes: &[],
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
        };
        assert_eq!(req.timeout_ms(), 0);
    }

    #[test]
    fn timeout_ms_rounds_nonzero_submillisecond_up() {
        let req = ExecRequest {
            cmd: "true",
            timeout: Duration::from_nanos(1),
            env: &[],
            sudo: false,
            expected_exit_codes: &[],
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
        };
        assert_eq!(req.timeout_ms(), 1);
    }

    #[test]
    fn start_process_timeout_ms_rounds_nonzero_submillisecond_up() {
        let req = StartProcessRequest {
            timeout_is_expected: false,
            cmd: "true",
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            timeout: Duration::from_nanos(1),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        };
        assert_eq!(req.timeout_ms(), 1);
    }

    #[test]
    fn start_agent_process_timeout_rounds_nonzero_submillisecond_up() {
        let req = StartAgentProcessRequest {
            timeout: Duration::from_nanos(1),
            env: &[],
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        };
        assert_eq!(req.timeout_ms(), 1);
    }

    #[test]
    fn copy_file_timeout_ms_rounds_nonzero_submillisecond_up() {
        let options = CopyFileOptions {
            max_bytes: 1024,
            timeout: Duration::from_nanos(1),
            missing_ok: false,
        };
        assert_eq!(options.timeout_ms(), 1);
    }

    #[test]
    fn timeout_ms_saturates_at_u32_max() {
        let req = ExecRequest {
            cmd: "sleep infinity",
            timeout: Duration::from_secs(u64::MAX / 1000),
            env: &[],
            sudo: false,
            expected_exit_codes: &[],
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
        };
        assert_eq!(req.timeout_ms(), u32::MAX);
    }

    #[test]
    fn timeout_ms_exact_u32_max() {
        let req = ExecRequest {
            cmd: "cmd",
            timeout: Duration::from_millis(u32::MAX as u64),
            env: &[],
            sudo: false,
            expected_exit_codes: &[],
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
        };
        assert_eq!(req.timeout_ms(), u32::MAX);
    }

    #[test]
    fn process_output_mode_stream_uses_bounded_defaults() {
        assert_eq!(
            ProcessOutputMode::stream(),
            ProcessOutputMode::Stream {
                stream_limit_bytes: ProcessOutputMode::DEFAULT_STREAM_LIMIT_BYTES,
                chunk_limit_bytes: 64 * 1024,
                queue_capacity: ProcessOutputMode::DEFAULT_QUEUE_CAPACITY,
                stderr_capture_limit_bytes: None,
            }
        );
    }

    #[test]
    fn process_output_mode_stream_with_stderr_capture_uses_bounded_defaults() {
        assert_eq!(
            ProcessOutputMode::stream_with_stderr_capture(4096),
            ProcessOutputMode::Stream {
                stream_limit_bytes: ProcessOutputMode::DEFAULT_STREAM_LIMIT_BYTES,
                chunk_limit_bytes: 64 * 1024,
                queue_capacity: ProcessOutputMode::DEFAULT_QUEUE_CAPACITY,
                stderr_capture_limit_bytes: Some(4096),
            }
        );
    }

    #[test]
    fn exec_termination_deserializes_valid_shapes() {
        for (value, expected) in [
            (
                serde_json::json!({
                    "kind": "exited",
                    "exit_code": 0,
                }),
                ExecTermination::Exited { exit_code: 0 },
            ),
            (
                serde_json::json!({
                    "kind": "exited",
                    "exit_code": -1,
                }),
                ExecTermination::Exited { exit_code: -1 },
            ),
            (
                serde_json::json!({
                    "kind": "exited",
                    "exit_code": i32::MIN,
                }),
                ExecTermination::Exited {
                    exit_code: i32::MIN,
                },
            ),
            (
                serde_json::json!({
                    "kind": "exited",
                    "exit_code": i32::MAX,
                }),
                ExecTermination::Exited {
                    exit_code: i32::MAX,
                },
            ),
            (
                serde_json::json!({
                    "kind": "timed_out",
                }),
                ExecTermination::TimedOut,
            ),
            (
                serde_json::json!({
                    "kind": "cancelled",
                }),
                ExecTermination::Cancelled,
            ),
            (
                serde_json::json!({
                    "kind": "start_failed",
                }),
                ExecTermination::StartFailed,
            ),
            (
                serde_json::json!({
                    "kind": "wait_failed",
                }),
                ExecTermination::WaitFailed,
            ),
        ] {
            let decoded = serde_json::from_value::<ExecTermination>(value).unwrap();
            assert_eq!(decoded, expected);
        }
    }

    #[test]
    fn exec_termination_deserializes_exited_fields_in_any_order() {
        let decoded =
            serde_json::from_str::<ExecTermination>(r#"{"exit_code":0,"kind":"exited"}"#).unwrap();

        assert_eq!(decoded, ExecTermination::Exited { exit_code: 0 });
    }

    #[test]
    fn exec_termination_rejects_invalid_shapes() {
        for value in [
            serde_json::json!({
                "exit_code": 0,
            }),
            serde_json::json!({
                "kind": "unknown",
                "exit_code": 0,
            }),
            serde_json::json!({
                "kind": "exited",
            }),
            serde_json::json!({
                "kind": "exited",
                "exit_code": null,
            }),
            serde_json::json!({
                "kind": "exited",
                "exit_code": 0,
                "signal": 9,
            }),
        ] {
            assert!(serde_json::from_value::<ExecTermination>(value).is_err());
        }
    }

    #[test]
    fn exec_termination_rejects_out_of_range_exit_code() {
        for value in [
            serde_json::json!({
                "kind": "exited",
                "exit_code": 2_147_483_648_i64,
            }),
            serde_json::json!({
                "kind": "exited",
                "exit_code": -2_147_483_649_i64,
            }),
        ] {
            assert!(serde_json::from_value::<ExecTermination>(value).is_err());
        }
    }

    #[test]
    fn exec_termination_rejects_non_object_shapes() {
        for value in [
            serde_json::Value::Null,
            serde_json::json!("exited"),
            serde_json::json!(0),
            serde_json::json!(["exited"]),
        ] {
            assert!(serde_json::from_value::<ExecTermination>(value).is_err());
        }
    }

    #[test]
    fn exec_termination_rejects_non_exited_exit_code() {
        for kind in ["timed_out", "cancelled", "start_failed", "wait_failed"] {
            for exit_code in [serde_json::json!(124), serde_json::Value::Null] {
                let value = serde_json::json!({
                    "kind": kind,
                    "exit_code": exit_code,
                });

                assert!(serde_json::from_value::<ExecTermination>(value).is_err());
            }
        }
    }

    #[test]
    fn exec_termination_rejects_non_exited_unknown_fields() {
        for kind in ["timed_out", "cancelled", "start_failed", "wait_failed"] {
            let value = serde_json::json!({
                "kind": kind,
                "signal": 9,
            });

            assert!(serde_json::from_value::<ExecTermination>(value).is_err());
        }
    }

    #[test]
    fn exec_termination_rejects_duplicate_fields() {
        for value in [
            r#"{"kind":"exited","kind":"timed_out","exit_code":0}"#,
            r#"{"kind":"exited","kind":"exited","exit_code":0}"#,
            r#"{"kind":"exited","exit_code":0,"exit_code":1}"#,
            r#"{"kind":"exited","exit_code":0,"exit_code":0}"#,
        ] {
            assert!(serde_json::from_str::<ExecTermination>(value).is_err());
        }
    }

    #[test]
    fn exec_result_new_defaults_to_exited() {
        let result = ExecResult::new(7, b"out".to_vec(), b"err".to_vec());

        assert_eq!(result.termination, ExecTermination::Exited { exit_code: 7 });
        assert_eq!(result.guest_duration_ms, None);
        assert_eq!(result.stdout, b"out");
        assert_eq!(result.stderr, b"err");
        assert!(result.diagnostic.is_empty());
        assert!(!result.stdout_truncated);
        assert!(!result.stderr_truncated);
    }

    #[test]
    fn process_exit_new_defaults_supervised_metadata() {
        let exit = ProcessExit::new(42, 7, b"out".to_vec(), b"err".to_vec());

        assert_eq!(exit.guest_pid, 42);
        assert_eq!(exit.termination, ExecTermination::Exited { exit_code: 7 });
        assert_eq!(exit.guest_duration_ms, None);
        assert_eq!(exit.stdout, b"out");
        assert_eq!(exit.stderr, b"err");
        assert!(!exit.stdout_truncated);
        assert!(!exit.stderr_truncated);
        assert!(exit.diagnostic.is_empty());
        assert!(!exit.stream_overflowed);
    }

    #[test]
    fn guest_process_handle_closes_only_unclaimed_stdout() {
        let (_tx, stdout_rx) = tokio::sync::mpsc::channel(1);
        let closed = Arc::new(AtomicBool::new(false));
        let close_observed = Arc::clone(&closed);
        let mut handle = GuestProcessHandle::new(
            42,
            Some(stdout_rx),
            None,
            GuestProcessWaiter::new(|_| {
                Box::pin(async { Ok(ProcessExit::new(42, 0, Vec::new(), Vec::new())) })
            }),
        )
        .with_unclaimed_stdout_cleanup(move || {
            close_observed.store(true, Ordering::SeqCst);
        });

        let _claimed_stdout = handle.take_stdout_receiver();
        handle.drop_unclaimed_stdout();

        assert!(!closed.load(Ordering::SeqCst));
    }

    #[test]
    fn guest_agent_process_handle_requires_control() {
        let process = GuestProcessHandle::new(
            42,
            None,
            None,
            GuestProcessWaiter::new(|_| {
                Box::pin(async { Ok(ProcessExit::new(42, 0, Vec::new(), Vec::new())) })
            }),
        );

        let error =
            match GuestAgentProcessHandle::try_from_process(process, guest_agent_start_timing()) {
                Ok(_) => panic!("Agent handle unexpectedly accepted missing control"),
                Err(error) => error,
            };
        assert!(matches!(
            error,
            crate::SandboxError::Operation {
                operation: crate::SandboxOperation::StartAgentProcess,
                reason: crate::SandboxOperationReason::Other,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn guest_agent_process_handle_transfers_process_and_control() {
        let control = GuestProcessControlHandle::new(|message_id, _, _| {
            Box::pin(async move { Ok(ProcessControlAck { message_id }) })
        });
        let process = GuestProcessHandle::new(
            42,
            None,
            Some(control),
            GuestProcessWaiter::new(|_| {
                Box::pin(async { Ok(ProcessExit::new(42, 0, Vec::new(), Vec::new())) })
            }),
        );

        let agent =
            GuestAgentProcessHandle::try_from_process(process, guest_agent_start_timing()).unwrap();
        let (process, control) = agent.into_parts();
        assert_eq!(process.guest_pid, 42);
        let ack = control
            .control("message", b"payload", Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(ack.message_id, "message");
    }

    #[test]
    fn guest_process_handle_closes_unclaimed_stdout() {
        let (_tx, stdout_rx) = tokio::sync::mpsc::channel(1);
        let closed = Arc::new(AtomicBool::new(false));
        let close_observed = Arc::clone(&closed);
        let mut handle = GuestProcessHandle::new(
            42,
            Some(stdout_rx),
            None,
            GuestProcessWaiter::new(|_| {
                Box::pin(async { Ok(ProcessExit::new(42, 0, Vec::new(), Vec::new())) })
            }),
        )
        .with_unclaimed_stdout_cleanup(move || {
            close_observed.store(true, Ordering::SeqCst);
        });

        handle.drop_unclaimed_stdout();

        assert!(closed.load(Ordering::SeqCst));
    }

    #[test]
    fn guest_process_handle_drop_closes_unclaimed_stdout() {
        let (_tx, stdout_rx) = tokio::sync::mpsc::channel(1);
        let closed = Arc::new(AtomicBool::new(false));
        let close_observed = Arc::clone(&closed);
        let handle = GuestProcessHandle::new(
            42,
            Some(stdout_rx),
            None,
            GuestProcessWaiter::new(|_| {
                Box::pin(async { Ok(ProcessExit::new(42, 0, Vec::new(), Vec::new())) })
            }),
        )
        .with_unclaimed_stdout_cleanup(move || {
            close_observed.store(true, Ordering::SeqCst);
        });

        drop(handle);

        assert!(closed.load(Ordering::SeqCst));
    }

    #[test]
    fn guest_process_handle_takes_cancel_handle_once() {
        let mut handle = GuestProcessHandle::new(
            42,
            None,
            None,
            GuestProcessWaiter::new(|_| {
                Box::pin(async { Ok(ProcessExit::new(42, 0, Vec::new(), Vec::new())) })
            }),
        )
        .with_cancel_handle(GuestProcessCancelHandle::new(|_| {
            Box::pin(async { Ok(()) })
        }));

        assert!(handle.take_cancel_handle().is_some());
        assert!(handle.take_cancel_handle().is_none());
    }
}
