use crate::diagnostics::ModelRequestDiagnostic;
use serde_json::json;

#[test]
fn optional_request_evidence_round_trips_and_old_records_remain_absent() {
    let details = json!({
        "httpStatus": 400, "transportAttempts": 1,
        "request": {
            "api": "openai-codex-responses", "inputItems": 7, "tools": 0,
            "instructionsBytes": 12, "wireBodyBytes": 348, "contentEncoding": "zstd",
            "reasoningEffort": "xhigh"
        },
        "response": {
            "requestId": "req_0123456789abcdef0123456789abcdef",
            "cfRay": "0123456789abcdef-SJC"
        }
    });
    for request_id in [
        "req_0123456789abcdef0123456789abcdef",
        "11111111-2222-4333-8444-555555555555",
    ] {
        let mut details = details.clone();
        details["response"]["requestId"] = json!(request_id);
        let request: ModelRequestDiagnostic = serde_json::from_value(details.clone()).unwrap();
        let serialized = serde_json::to_value(request).unwrap();
        assert_eq!(serialized["request"], details["request"]);
        assert_eq!(serialized["response"], details["response"]);
    }

    let old: ModelRequestDiagnostic = serde_json::from_value(json!({
        "httpStatus": 400, "transportAttempts": 1
    }))
    .unwrap();
    assert_eq!(old.request, None);
    assert_eq!(old.response, None);
}

#[test]
fn external_metadata_cannot_export_prose_or_erase_existing_http_evidence() {
    let diagnostic: ModelRequestDiagnostic = serde_json::from_value(json!({
        "httpStatus": 400, "transportAttempts": 1,
        "request": {"api":"private-url", "reasoningEffort":"private-value", "contentEncoding":"private-value"},
        "response": {"requestId":"private-token", "cfRay":"private-header"}
    })).unwrap();
    assert_eq!(diagnostic.http_status, Some(400));
    assert!(
        !serde_json::to_string(&diagnostic)
            .unwrap()
            .contains("private")
    );
    let request = diagnostic.request.unwrap();
    assert_eq!(request.api.and_then(|api| api.as_str()), None);
    assert_eq!(
        request.reasoning_effort.and_then(|effort| effort.as_str()),
        None
    );
    assert_eq!(
        request
            .content_encoding
            .and_then(|encoding| encoding.as_str()),
        None
    );
}
