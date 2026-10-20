//! Projection of native terminal evidence, without reconstructing transport causes.

use guest_contracts::codex_failure::{
    CodexFailureEvidence, CodexFailureStage, CodexNativeFailureKind,
};
use serde_json::Value;

const REQUEST_SEND_MESSAGE: &str = "stream disconnected before completion: error sending request";
const REMOTE_COMPACTION_PREFIX: &str = "Error running remote compact task: ";

/// Call only for one native Codex terminal event. The optional top-level message
/// belongs to that same event, never stderr, tool output, or an assistant answer.
pub(crate) fn terminal_evidence(
    error: Option<&Value>,
    fallback_message: Option<&str>,
) -> Option<CodexFailureEvidence> {
    let info = error
        .and_then(|error| error.get("codex_error_info"))
        .filter(|info| !info.is_null());
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

    if let Some(message) = error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .or(fallback_message)
    {
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
mod tests {
    use super::*;
    use crate::{events::masked_codex_failure_diagnostic, masker::SecretMasker};
    use serde_json::json;

    #[test]
    fn owned_terminal_signature_reports_send_stage_without_inventing_cause() {
        for event in [
            json!({"type":"error", "message":REQUEST_SEND_MESSAGE}),
            json!({"type":"error", "message":REQUEST_SEND_MESSAGE, "error":{
                "message":REQUEST_SEND_MESSAGE, "codex_error_info":null
            }}),
            json!({"type":"error", "message":REQUEST_SEND_MESSAGE, "error":{
                "message":REQUEST_SEND_MESSAGE, "codex_error_info":"other"
            }}),
            json!({"type":"turn.completed", "turn":{"status":"failed", "error":{
                "message":REQUEST_SEND_MESSAGE, "codex_error_info":"other"
            }}}),
        ] {
            let diagnostic =
                masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")).unwrap();
            assert_eq!(diagnostic.message, REQUEST_SEND_MESSAGE);
            assert_eq!(diagnostic.failure_reason, None);
            let evidence = diagnostic.evidence.unwrap();
            assert_eq!(
                evidence.reported_stage,
                Some(CodexFailureStage::RequestSend)
            );
            assert_eq!(evidence.http_status, None);
        }
    }

    #[test]
    fn native_details_remain_masked_without_becoming_telemetry() {
        let event = json!({"type":"error", "message":format!("{REQUEST_SEND_MESSAGE} (private-secret)"),
            "error":{"message":REQUEST_SEND_MESSAGE, "additional_details":"private-secret", "codex_error_info":"other"}});
        let masker = SecretMasker::from_raw("cHJpdmF0ZS1zZWNyZXQ=");
        let diagnostic = masked_codex_failure_diagnostic(&event, &masker).unwrap();
        assert!(diagnostic.message.starts_with(REQUEST_SEND_MESSAGE));
        assert!(!diagnostic.message.contains("private-secret"));
        let evidence = diagnostic.evidence.unwrap();
        assert_eq!(
            evidence.reported_stage,
            Some(CodexFailureStage::RequestSend)
        );
        assert!(
            !serde_json::to_string(&evidence)
                .unwrap()
                .contains("private")
        );
    }

    #[test]
    fn native_transport_kind_and_status_belong_to_the_same_error() {
        for (variant, expected) in [
            (
                "httpConnectionFailed",
                Some(CodexFailureStage::HttpConnection),
            ),
            (
                "responseStreamConnectionFailed",
                Some(CodexFailureStage::ResponseConnection),
            ),
            (
                "responseStreamDisconnected",
                Some(CodexFailureStage::ResponseStream),
            ),
            ("responseTooManyFailedAttempts", None),
        ] {
            for status in [100, 200, 401, 429, 503, 599] {
                let error = json!({"message":REQUEST_SEND_MESSAGE, "codex_error_info":{
                    variant:{"httpStatusCode":status}
                }});
                let evidence = terminal_evidence(Some(&error), None).unwrap();
                assert_eq!(evidence.reported_stage, expected, "{variant}");
                assert_eq!(evidence.http_status, Some(status));
            }
        }
        let error = json!({"message":format!("{REMOTE_COMPACTION_PREFIX}{REQUEST_SEND_MESSAGE}"),
            "codex_error_info":{"responseStreamDisconnected":{"httpStatusCode":200}}});
        let evidence = terminal_evidence(Some(&error), None).unwrap();
        assert_eq!(
            evidence.reported_stage,
            Some(CodexFailureStage::RemoteCompaction)
        );
        assert_eq!(
            evidence.native_kind,
            Some(CodexNativeFailureKind::ResponseStreamDisconnected)
        );
        assert_eq!(evidence.http_status, Some(200));
    }

    #[test]
    fn arbitrary_metadata_and_invalid_status_are_not_exported() {
        for status in [
            json!(null),
            json!("private-status"),
            json!(-1),
            json!(99),
            json!(600),
            json!(65536),
            json!(503.5),
        ] {
            let error = json!({"message":"private body", "codex_error_info":{
                "httpConnectionFailed":{"httpStatusCode":status,"body":"private-body"}
            }});
            let evidence = terminal_evidence(Some(&error), None).unwrap();
            assert_eq!(evidence.http_status, None);
            assert!(
                !serde_json::to_string(&evidence)
                    .unwrap()
                    .contains("private")
            );
        }
        for info in [
            json!("private-kind"),
            json!(7),
            json!({"httpConnectionFailed":null}),
            json!({"httpConnectionFailed":{"httpStatusCode":503},"other":{}}),
            json!({"private-kind":{"httpStatusCode":503}}),
        ] {
            let error = json!({"message":REQUEST_SEND_MESSAGE,"codex_error_info":info});
            assert_eq!(terminal_evidence(Some(&error), None), None, "{info}");
        }
    }

    #[test]
    fn nonterminal_output_and_near_matches_cannot_supply_send_evidence() {
        for event in [
            json!({"type":"warning","message":REQUEST_SEND_MESSAGE}),
            json!({"type":"error","will_retry":true,"message":REQUEST_SEND_MESSAGE}),
            json!({"type":"item.completed","item":{"type":"agent_message","text":REQUEST_SEND_MESSAGE}}),
            json!({"type":"item.completed","item":{"type":"command_execution","aggregated_output":REQUEST_SEND_MESSAGE}}),
            json!({"type":"turn.completed","turn":{"status":"completed","error":{"message":REQUEST_SEND_MESSAGE}}}),
        ] {
            assert!(masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")).is_none());
        }
        for message in [
            format!("Tool output: {REQUEST_SEND_MESSAGE}"),
            format!("{REQUEST_SEND_MESSAGE}; additional output"),
            "stream disconnected before completion: connection reset by peer".to_string(),
            REMOTE_COMPACTION_PREFIX.to_string(),
        ] {
            assert_eq!(
                terminal_evidence(Some(&json!({"message":message})), None),
                None
            );
        }
        let event = json!({"type":"error","message":REQUEST_SEND_MESSAGE,"error":{
            "message":REQUEST_SEND_MESSAGE,"codex_error_info":"unauthorized"
        }});
        let diagnostic =
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")).unwrap();
        assert_eq!(
            diagnostic.failure_reason,
            Some(guest_contracts::diagnostics::FailureReason::InvalidCredentials)
        );
        assert_eq!(diagnostic.evidence, None);
    }
}
