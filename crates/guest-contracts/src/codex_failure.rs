//! Content-free evidence retained from one selected native Codex terminal error.

use serde::{Deserialize, Serialize};

/// Native evidence does not establish socket cause, attempt count, or accepted work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexFailureEvidence {
    /// Stage reported by the native kind or a supported terminal message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reported_stage: Option<CodexFailureStage>,
    /// Allowlisted native transport kind; never an arbitrary external string.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_kind: Option<CodexNativeFailureKind>,
    /// Valid HTTP status supplied by that same native error, when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
}

/// Reported failure stage, without inferring whether the model accepted work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexFailureStage {
    /// The exact native terminal message reports request sending failure.
    RequestSend,
    /// Native HTTP connection failure, which can include an unexpected response.
    HttpConnection,
    /// Native failure establishing the response stream.
    ResponseConnection,
    /// Native response stream disconnection.
    ResponseStream,
    /// An explicit native prefix identifies the remote-compaction task.
    RemoteCompaction,
}

impl CodexFailureStage {
    /// Fixed telemetry spelling of the reported stage.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RequestSend => "request_send",
            Self::HttpConnection => "http_connection",
            Self::ResponseConnection => "response_connection",
            Self::ResponseStream => "response_stream",
            Self::RemoteCompaction => "remote_compaction",
        }
    }
}

/// Supported native transport variants, including the producer's coarse Other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexNativeFailureKind {
    /// Native HttpConnectionFailed, not proof that no response was received.
    HttpConnectionFailed,
    /// Native ResponseStreamConnectionFailed.
    ResponseStreamConnectionFailed,
    /// Native ResponseStreamDisconnected.
    ResponseStreamDisconnected,
    /// Native retry exhaustion, without an observed retry count.
    ResponseTooManyFailedAttempts,
    /// Native Other; the original cause is unavailable at this boundary.
    Other,
}

impl CodexNativeFailureKind {
    /// Fixed telemetry spelling of the native kind.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::HttpConnectionFailed => "http_connection_failed",
            Self::ResponseStreamConnectionFailed => "response_stream_connection_failed",
            Self::ResponseStreamDisconnected => "response_stream_disconnected",
            Self::ResponseTooManyFailedAttempts => "response_too_many_failed_attempts",
            Self::Other => "other",
        }
    }
}

#[cfg(test)]
mod tests;
