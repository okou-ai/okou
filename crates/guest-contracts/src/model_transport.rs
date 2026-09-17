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
mod tests {
    use super::*;
    use crate::diagnostics::ModelRequestDiagnostic;
    use serde_json::json;

    #[test]
    fn shared_pi_transport_evidence_round_trips_without_requiring_it_on_semantic_errors() {
        let message: serde_json::Value = serde_json::from_str(include_str!(
            "../../../turbo/packages/pi-agent-runtime/src/test/fixtures/codex-stream-terminated.json"
        ))
        .unwrap();
        let details = &message["diagnostics"][0]["details"];
        let request: ModelRequestDiagnostic = serde_json::from_value(details.clone()).unwrap();
        let evidence = request.transport_failure.unwrap();
        assert_eq!(evidence.phase, ModelTransportPhase::ResponseBody);
        assert_eq!(
            evidence.cause_code,
            Some(ModelTransportErrorCode::UndErrResContentLengthMismatch)
        );
        assert!(!evidence.signal_aborted);
        assert_eq!(
            serde_json::to_value(evidence).unwrap(),
            details["transportFailure"]
        );

        let semantic: ModelRequestDiagnostic = serde_json::from_value(json!({
            "httpStatus": 429, "transportAttempts": 1
        }))
        .unwrap();
        assert_eq!(semantic.transport_failure, None);
        assert!(
            serde_json::to_value(semantic)
                .unwrap()
                .get("transportFailure")
                .is_none()
        );
    }

    #[test]
    fn unknown_external_values_cannot_become_telemetry_or_hide_known_http_evidence() {
        let request: ModelRequestDiagnostic = serde_json::from_value(json!({
            "httpStatus": 200, "transportAttempts": 1,
            "transportFailure": {
                "phase": "response_body", "signalAborted": false,
                "errorName": "private-name", "errorCode": "private-code",
                "causeCode": "UND_ERR_SOCKET", "message": "private-message"
            }
        }))
        .unwrap();
        assert_eq!(request.http_status, Some(200));
        let evidence = request.transport_failure.unwrap();
        assert_eq!(
            evidence
                .error_name
                .and_then(ModelTransportErrorName::as_str),
            None
        );
        assert_eq!(
            evidence
                .error_code
                .and_then(ModelTransportErrorCode::as_str),
            None
        );
        assert_eq!(
            evidence
                .cause_code
                .and_then(ModelTransportErrorCode::as_str),
            Some("UND_ERR_SOCKET")
        );
        assert!(!serde_json::to_string(&request).unwrap().contains("private"));
    }
}
