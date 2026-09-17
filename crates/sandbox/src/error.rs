//! Error and result types for sandbox runtime, factory, and sandbox operations.
//!
//! [`SandboxError`] is the public error boundary for the sandbox crate. The
//! variants keep backend-specific details in human-readable messages while
//! exposing structured categories for initialization phases, lifecycle state
//! errors, running operations, and idle transitions.

use std::fmt;

/// Error type returned by the sandbox crate's public APIs.
#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    /// Required backend prerequisites are unavailable.
    #[error("backend unavailable: {message}")]
    BackendUnavailable { message: String },

    /// Runtime, factory, or sandbox configuration was rejected.
    #[error("invalid configuration: {message}")]
    Configuration { message: String },

    /// Runtime, factory, or sandbox allocation initialization failed.
    #[error("sandbox {phase} initialization failed: {message}")]
    Initialization {
        phase: SandboxInitializationPhase,
        message: String,
    },

    /// A created sandbox failed while booting or becoming ready.
    #[error("sandbox start failed: {message}")]
    Start { message: String },

    /// A created sandbox failed the guest-path DNS readiness admission check.
    #[error("sandbox start failed: {message}")]
    GuestDnsReadiness {
        reason: SandboxGuestDnsReadinessReason,
        message: String,
    },

    /// The requested action is invalid for the current runtime, factory, or
    /// sandbox state.
    #[error("invalid state for {context} (state: {state}): {message}")]
    InvalidState {
        context: SandboxInvalidStateContext,
        state: String,
        message: String,
    },

    /// A running sandbox operation failed after state validation.
    #[error("sandbox {operation} failed ({reason}): {message}")]
    Operation {
        operation: SandboxOperation,
        reason: SandboxOperationReason,
        message: String,
    },

    /// A running sandbox operation exhausted a typed request deadline.
    #[error("sandbox {operation} failed (timeout {stage} after {timeout_ms} ms)")]
    OperationTimeout {
        /// Operation whose request timed out.
        operation: SandboxOperation,
        /// Host-observed request stage at timeout.
        stage: SandboxOperationTimeoutStage,
        /// Configured end-to-end request budget in milliseconds.
        timeout_ms: u64,
    },

    /// An ordinary guarded request-frame write failed, independently of its deadline.
    #[error("sandbox {operation} failed ({stage}): {source}")]
    OperationWrite {
        /// Operation whose request could not be written.
        operation: SandboxOperation,
        /// Host-observed byte-emission boundary of the failed write.
        stage: SandboxOperationWriteStage,
        /// Original transport failure, including its I/O kind and cause.
        source: std::io::Error,
    },

    /// Parking or unparking an idle sandbox failed.
    #[error("sandbox {transition} failed: {message}")]
    IdleTransition {
        transition: SandboxIdleTransition,
        message: String,
    },

    /// An underlying host I/O operation failed.
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

/// Initialization phase that produced a [`SandboxError::Initialization`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxInitializationPhase {
    /// Runtime-wide shared resource initialization.
    Runtime,
    /// Factory-level initialization.
    Factory,
    /// Per-sandbox allocation before sandbox start.
    SandboxAllocation,
}

/// Root-cause category for a guest-path DNS readiness failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxGuestDnsReadinessReason {
    /// The guest readiness process reached its own timeout and terminated.
    ProcessTimeout,
    /// The host stopped waiting before receiving a terminal guest result.
    Deadline,
    /// The guest completed the probe but DNS resolution did not become ready.
    DnsPath,
    /// The readiness probe failed for another reason.
    Other,
}

impl fmt::Display for SandboxInitializationPhase {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Runtime => f.write_str("runtime"),
            Self::Factory => f.write_str("factory"),
            Self::SandboxAllocation => f.write_str("sandbox allocation"),
        }
    }
}

/// Public sandbox operation associated with an operation failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxOperation {
    /// [`Sandbox::exec`](crate::Sandbox::exec).
    Exec,
    /// [`Sandbox::read_file`](crate::Sandbox::read_file).
    ReadFile,
    /// [`Sandbox::copy_file`](crate::Sandbox::copy_file).
    CopyFile,
    /// [`Sandbox::write_file`](crate::Sandbox::write_file).
    WriteFile,
    /// [`Sandbox::start_process`](crate::Sandbox::start_process).
    StartProcess,
    /// [`Sandbox::start_agent_process`](crate::Sandbox::start_agent_process).
    StartAgentProcess,
    /// [`Sandbox::verify_session_history_identity`](crate::Sandbox::verify_session_history_identity).
    VerifySessionHistoryIdentity,
    /// [`Sandbox::cleanup_codex_session`](crate::Sandbox::cleanup_codex_session).
    CleanupCodexSession,
    /// [`Sandbox::mount_workspace_drive`](crate::Sandbox::mount_workspace_drive).
    MountWorkspaceDrive,
    /// Experimental replacement of an exclusively owned workspace drive.
    #[cfg(feature = "workspace-handoff-study")]
    ReplaceWorkspaceDrive,
    /// [`GuestProcessControlHandle::control`](crate::GuestProcessControlHandle::control).
    ProcessControl,
    /// [`Sandbox::wait_process`](crate::Sandbox::wait_process).
    WaitProcess,
}

impl fmt::Display for SandboxOperation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Exec => f.write_str("exec"),
            Self::ReadFile => f.write_str("read file"),
            Self::CopyFile => f.write_str("copy file"),
            Self::WriteFile => f.write_str("write file"),
            Self::StartProcess => f.write_str("start process"),
            Self::StartAgentProcess => f.write_str("start Agent process"),
            Self::VerifySessionHistoryIdentity => f.write_str("verify session history identity"),
            Self::CleanupCodexSession => f.write_str("clean up Codex session"),
            Self::MountWorkspaceDrive => f.write_str("mount workspace drive"),
            #[cfg(feature = "workspace-handoff-study")]
            Self::ReplaceWorkspaceDrive => f.write_str("replace workspace drive"),
            Self::ProcessControl => f.write_str("process control"),
            Self::WaitProcess => f.write_str("wait process"),
        }
    }
}

/// Root-cause category for a running sandbox operation failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxOperationReason {
    /// The guest-side operation or IPC call returned an error.
    Guest,
    /// Normal-operation admission rejected a permanently unusable guest connection.
    /// This does not classify transport errors or temporary operation fences.
    GuestConnectionUnavailable,
    /// The backend process crashed while the operation was in flight.
    BackendCrashed,
    /// The operation timed out.
    Timeout,
    /// The operation failed for another reason.
    Other,
}

/// Host-observed request stage for a typed sandbox operation timeout.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxOperationTimeoutStage {
    /// The request frame had not reached its write boundary.
    BeforeFrameWrite,
    /// The request frame write had started and may be partial.
    FrameWrite,
    /// The request frame completed but no terminal response arrived.
    AwaitingTerminalResponse,
}

impl fmt::Display for SandboxOperationTimeoutStage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BeforeFrameWrite => f.write_str("before frame write"),
            Self::FrameWrite => f.write_str("during frame write"),
            Self::AwaitingTerminalResponse => f.write_str("awaiting terminal response"),
        }
    }
}

/// Byte-emission boundary for an ordinary sandbox request-write failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxOperationWriteStage {
    /// This frame emitted no bytes; this does not assert connection health.
    BeforeFrameWrite,
    /// The frame write failed after admission and may be partial; retire the sandbox.
    FrameWrite,
}

impl fmt::Display for SandboxOperationWriteStage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BeforeFrameWrite => f.write_str("before frame write"),
            Self::FrameWrite => f.write_str("during frame write"),
        }
    }
}

impl fmt::Display for SandboxOperationReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Guest => f.write_str("guest"),
            Self::GuestConnectionUnavailable => f.write_str("guest connection unavailable"),
            Self::BackendCrashed => f.write_str("backend crashed"),
            Self::Timeout => f.write_str("timeout"),
            Self::Other => f.write_str("other"),
        }
    }
}

/// Idle transition associated with an idle-transition failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxIdleTransition {
    /// Parking an active sandbox for idle reuse.
    Park,
    /// Unparking an idle sandbox before reuse.
    Unpark,
}

impl fmt::Display for SandboxIdleTransition {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Park => f.write_str("park"),
            Self::Unpark => f.write_str("unpark"),
        }
    }
}

/// API context where an invalid state was observed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxInvalidStateContext {
    /// Runtime-level state.
    Runtime,
    /// Factory-level state.
    Factory,
    /// Sandbox lifecycle state.
    Sandbox,
    /// State required for a specific running sandbox operation.
    Operation(SandboxOperation),
}

impl fmt::Display for SandboxInvalidStateContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Runtime => f.write_str("runtime"),
            Self::Factory => f.write_str("factory"),
            Self::Sandbox => f.write_str("sandbox"),
            Self::Operation(operation) => write!(f, "{operation} operation"),
        }
    }
}

/// Convenient result alias for sandbox crate public APIs.
pub type Result<T> = std::result::Result<T, SandboxError>;
