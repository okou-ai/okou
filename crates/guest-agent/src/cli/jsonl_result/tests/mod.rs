use super::*;

#[test]
fn result_summary_captures_terminal_metadata() {
    let event = serde_json::json!({
        "type": "result",
        "num_turns": 0,
        "is_error": false,
        "result": "done"
    });

    assert_eq!(
        JsonlResultSummary::from_event(&event),
        JsonlResultSummary {
            num_turns: Some(0),
            status: JsonlResultStatus::Success,
            model_request: None,
        }
    );
}

#[test]
fn result_summary_marks_is_error_result_as_error() {
    let event = serde_json::json!({
        "type": "result",
        "num_turns": 1,
        "is_error": true,
        "result": "Error."
    });

    assert_eq!(
        JsonlResultSummary::from_event(&event).status,
        JsonlResultStatus::Error
    );
}

#[test]
fn result_summary_marks_error_subtype_as_error() {
    let event = serde_json::json!({
        "type": "result",
        "num_turns": 1,
        "subtype": "error",
        "result": "Error."
    });

    assert_eq!(
        JsonlResultSummary::from_event(&event).status,
        JsonlResultStatus::Error
    );
}

#[test]
fn result_summary_marks_ambiguous_result_as_unknown() {
    let event = serde_json::json!({
        "type": "result",
        "num_turns": 1,
        "result": "Done."
    });

    assert_eq!(
        JsonlResultSummary::from_event(&event).status,
        JsonlResultStatus::Unknown
    );
}
