use super::*;

#[test]
fn payload_uses_the_generated_failure_reason_contract() {
    let payload = CompletePayload {
        run_id: "run-123",
        exit_code: 1,
        failure_reason: Some(FailureReason::InputTooLarge.into()),
        error: Some("Codex input exceeded the app-server limit"),
        last_event_sequence: None,
        sandbox_id: None,
        completion: None,
    };

    let json = serde_json::to_value(&payload).unwrap();
    assert_eq!(json["failureReason"], "input_too_large");
}
