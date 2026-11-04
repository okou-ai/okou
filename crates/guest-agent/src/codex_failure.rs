//! Projection of native terminal evidence, without reconstructing transport causes.

use guest_contracts::codex_failure::{
    CodexFailureEvidence, CodexFailureStage, CodexNativeFailureKind,
};
use serde_json::Value;

const REQUEST_SEND_MESSAGE: &str = "stream disconnected before completion: error sending request";
const REMOTE_COMPACTION_PREFIX: &str = "Error running remote compact task: ";

/// Call only for the error object selected from a native Codex terminal event.
pub(crate) fn terminal_evidence(error: &Value) -> Option<CodexFailureEvidence> {
    let info = error.get("codex_error_info").filter(|info| !info.is_null());
    let variant = match info {
        Some(Value::String(kind)) => Some(kind.as_str()),
        Some(Value::Object(object)) if object.len() == 1 => object
            .iter()
            .next()
            .filter(|(_, value)| value.is_object())
            .map(|(kind, _)| kind.as_str()),
        _ => None,
    };
    let (native_kind, mut reported_stage) = match variant {
        Some("httpConnectionFailed") => (
            Some(CodexNativeFailureKind::HttpConnectionFailed),
            Some(CodexFailureStage::HttpConnection),
        ),
        Some("responseStreamConnectionFailed") => (
            Some(CodexNativeFailureKind::ResponseStreamConnectionFailed),
            Some(CodexFailureStage::ResponseConnection),
        ),
        Some("responseStreamDisconnected") => (
            Some(CodexNativeFailureKind::ResponseStreamDisconnected),
            Some(CodexFailureStage::ResponseStream),
        ),
        Some("responseTooManyFailedAttempts") => (
            Some(CodexNativeFailureKind::ResponseTooManyFailedAttempts),
            None,
        ),
        Some("other") => (Some(CodexNativeFailureKind::Other), None),
        _ => (None, None),
    };
    let http_status = native_kind
        .filter(|kind| *kind != CodexNativeFailureKind::Other)
        .and_then(|_| info?.get(variant?)?.get("httpStatusCode"))
        .and_then(Value::as_u64)
        .and_then(|status| u16::try_from(status).ok())
        .filter(|status| (100..=599).contains(status));

    if let Some(message) = error.get("message").and_then(Value::as_str) {
        if message
            .strip_prefix(REMOTE_COMPACTION_PREFIX)
            .is_some_and(|detail| !detail.trim().is_empty())
        {
            reported_stage = Some(CodexFailureStage::RemoteCompaction);
        } else if (info.is_none() || variant == Some("other")) && message == REQUEST_SEND_MESSAGE {
            // This is the reported operation, not proof of a socket cause or
            // that an earlier attempt did not reach the model.
            reported_stage = Some(CodexFailureStage::RequestSend);
        }
    }

    (native_kind.is_some() || reported_stage.is_some()).then_some(CodexFailureEvidence {
        reported_stage,
        native_kind,
        http_status,
    })
}

#[cfg(test)]
mod tests;
