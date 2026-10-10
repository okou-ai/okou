//! Error types for the guest agent.

/// Agent error type covering all failure modes.
#[derive(thiserror::Error, Debug)]
pub enum AgentError {
    /// HTTP helper boundary failure: request send/retry exhaustion, non-2xx
    /// status, response body read, or response JSON parsing for webhook/S3 calls.
    #[error("http: {0}")]
    Http(String),

    /// HTTP helper boundary failure with a concrete non-retriable response
    /// status. This is used when callers need to distinguish compatibility
    /// rejections from auth/not-found failures.
    #[error("http: {message}")]
    HttpStatus { status: u16, message: String },

    /// Local OS I/O failure outside the HTTP helper, such as filesystem access,
    /// temporary directory creation, or child-process stdout/stderr pipes.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    /// JSON parse/serialize failure outside HTTP response handling.
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    /// Guest CLI or child-process lifecycle failure, including command setup,
    /// missing pipes, timeout/termination, heartbeat fatal errors, and task panics.
    #[error("execution: {0}")]
    Execution(String),

    /// Codex rejected an app-server turn because its text input exceeded the
    /// authoritative character limit reported in the structured RPC response.
    #[error(
        "execution: Codex input is too large: {actual_chars} characters provided, maximum is {max_chars} characters. Reduce the input and try again."
    )]
    CodexInputTooLarge {
        /// Aggregate Unicode scalar count reported by Codex.
        actual_chars: u64,
        /// Maximum Unicode scalar count reported by Codex.
        max_chars: u64,
    },

    /// Finalization, session-history, or artifact snapshot workflow failure inside
    /// the guest-agent; this does not refer to Firecracker/rootfs snapshots.
    #[error("finalization: {0}")]
    Finalization(String),

    /// Session history exceeded the native-history upload size limit.
    #[error("finalization: Session history exceeds maximum size of {max_bytes} bytes")]
    SessionHistoryTooLarge { max_bytes: u64 },

    /// Pi H2 needs a bounded native history; an unavailable hash cannot complete it.
    #[error("finalization: Pi history has no safe bounded compact generation ({reason})")]
    PiCompactGenerationUnavailable { reason: &'static str },

    /// Telemetry flush channel is unavailable because the uploader task was not
    /// initialized, has exited, or dropped the per-flush response channel.
    #[error("telemetry uploader unavailable")]
    TelemetryUnavailable,
}
