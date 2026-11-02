use super::*;
use crate::diagnostics::ModelRequestDiagnostic;
use serde_json::json;

#[test]
fn shared_pi_transport_evidence_round_trips_without_requiring_it_on_semantic_errors() {
    let message: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../turbo/packages/pi-agent-runtime/src/test/fixtures/codex-stream-terminated.json"
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
