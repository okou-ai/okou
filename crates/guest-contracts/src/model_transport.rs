//! Content-free transport evidence captured before model SDK error normalization.

use serde::{Deserialize, Serialize};

/// Evidence from one failed request or response-body read, never provider prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTransportFailure {
    /// Boundary that observed the original exception.
    pub phase: ModelTransportPhase,
    /// Whether the model caller's signal was aborted when the exception was observed.
    pub signal_aborted: bool,
    /// Allowlisted outer exception name, if available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_name: Option<ModelTransportErrorName>,
    /// Allowlisted code on the original exception, if available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<ModelTransportErrorCode>,
    /// First allowlisted code within at most four nested causes, if available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause_code: Option<ModelTransportErrorCode>,
}

/// Authoritative location of a transport failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelTransportPhase {
    /// Fetch rejected before returning a response.
    Request,
    /// Reading the returned response body rejected.
    ResponseBody,
    /// Unrecognized external metadata; never copied into telemetry.
    #[serde(other)]
    Unknown,
}

impl ModelTransportPhase {
    /// Return only a recognized, content-free telemetry value.
    #[must_use]
    pub const fn as_str(self) -> Option<&'static str> {
        match self {
            Self::Request => Some("request"),
            Self::ResponseBody => Some("response_body"),
            Self::Unknown => None,
        }
    }
}

/// Allowed JavaScript transport exception names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModelTransportErrorName {
    /// A generic JavaScript error.
    Error,
    /// Fetch commonly wraps transport errors in TypeError.
    TypeError,
    /// A native abort exception; does not identify the cancellation owner.
    AbortError,
    /// A native timeout exception.
    TimeoutError,
    /// Unrecognized external metadata; never copied into telemetry.
    #[serde(other)]
    Unknown,
}

impl ModelTransportErrorName {
    /// Return only a recognized, content-free telemetry value.
    #[must_use]
    pub const fn as_str(self) -> Option<&'static str> {
        match self {
            Self::Error => Some("Error"),
            Self::TypeError => Some("TypeError"),
            Self::AbortError => Some("AbortError"),
            Self::TimeoutError => Some("TimeoutError"),
            Self::Unknown => None,
        }
    }
}

/// Allowed Node/Undici transport codes, with no dynamic provider strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ModelTransportErrorCode {
    /// Undici socket failure.
    UndErrSocket,
    /// Undici connection timeout.
    UndErrConnectTimeout,
    /// Undici response-header timeout.
    UndErrHeadersTimeout,
    /// Undici response-body timeout.
    UndErrBodyTimeout,
    /// Response ended before its declared content length.
    UndErrResContentLengthMismatch,
    /// Undici request abort.
    UndErrAborted,
    /// Connection reset.
    Econnreset,
    /// Connection refused.
    Econnrefused,
    /// Broken pipe.
    Epipe,
    /// Operating-system timeout.
    Etimedout,
    /// DNS name not found.
    Enotfound,
    /// Temporary DNS failure.
    EaiAgain,
    /// Stream closed before completion.
    ErrStreamPrematureClose,
    /// Unrecognized external metadata; never copied into telemetry.
    #[serde(other)]
    Unknown,
}

impl ModelTransportErrorCode {
    /// Return only a recognized, content-free telemetry value.
    #[must_use]
    pub const fn as_str(self) -> Option<&'static str> {
        match self {
            Self::UndErrSocket => Some("UND_ERR_SOCKET"),
            Self::UndErrConnectTimeout => Some("UND_ERR_CONNECT_TIMEOUT"),
            Self::UndErrHeadersTimeout => Some("UND_ERR_HEADERS_TIMEOUT"),
            Self::UndErrBodyTimeout => Some("UND_ERR_BODY_TIMEOUT"),
            Self::UndErrResContentLengthMismatch => Some("UND_ERR_RES_CONTENT_LENGTH_MISMATCH"),
            Self::UndErrAborted => Some("UND_ERR_ABORTED"),
            Self::Econnreset => Some("ECONNRESET"),
            Self::Econnrefused => Some("ECONNREFUSED"),
            Self::Epipe => Some("EPIPE"),
            Self::Etimedout => Some("ETIMEDOUT"),
            Self::Enotfound => Some("ENOTFOUND"),
            Self::EaiAgain => Some("EAI_AGAIN"),
            Self::ErrStreamPrematureClose => Some("ERR_STREAM_PREMATURE_CLOSE"),
            Self::Unknown => None,
        }
    }
}

#[cfg(test)]
mod tests;
