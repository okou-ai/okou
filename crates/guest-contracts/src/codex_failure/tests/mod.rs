use super::*;
use crate::diagnostics::{AgentFramework, FailureClass, FailureDiagnostic, PromptMetadata};
use serde_json::json;

#[test]
fn optional_native_evidence_round_trips_without_changing_legacy_diagnostics() {
    let mut diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("test"),
    );
    let legacy = serde_json::to_value(&diagnostic).unwrap();
    assert!(legacy.get("codexFailure").is_none());
    assert_eq!(
        serde_json::from_value::<FailureDiagnostic>(legacy.clone()).unwrap(),
        diagnostic
    );

    diagnostic.codex_failure = Some(CodexFailureEvidence {
        reported_stage: Some(CodexFailureStage::RequestSend),
        native_kind: Some(CodexNativeFailureKind::Other),
        http_status: None,
    });
    let mut extended = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(
        extended["codexFailure"],
        json!({
            "reportedStage": "request_send", "nativeKind": "other"
        })
    );
    assert_eq!(
        serde_json::from_value::<FailureDiagnostic>(extended.clone()).unwrap(),
        diagnostic
    );
    extended.as_object_mut().unwrap().remove("codexFailure");
    assert_eq!(extended, legacy);
}
