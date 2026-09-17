//! Shared terminal `type=result` parsing for JSONL CLI backends.

use guest_contracts::diagnostics::ModelRequestDiagnostic;

/// Summary of a terminal JSONL `type=result` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JsonlResultSummary {
    /// Reported turn count for the run, when present.
    pub num_turns: Option<u64>,

    /// Semantic status of the terminal result event.
    pub status: JsonlResultStatus,
    /// Structured model evidence supplied by the Pi RPC projection on failure.
    pub model_request: Option<ModelRequestDiagnostic>,
}

/// Semantic status derived from a terminal JSONL `type=result` event.
///
/// This describes only the event's recognized semantic evidence. It is
/// independent of the CLI process exit status and the outcome of any later
/// post-result cleanup. When the event contains conflicting evidence,
/// recognized error evidence takes precedence over recognized success evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsonlResultStatus {
    /// The event contains recognized success evidence (`is_error` is `false` or
    /// `subtype` is `"success"`) and no recognized error evidence.
    Success,

    /// The event contains recognized error evidence (`is_error` is `true` or
    /// `subtype` is `"error"`).
    ///
    /// This status takes precedence over [`Self::Success`] when both kinds of
    /// evidence are present.
    Error,

    /// The event contains neither recognized success nor recognized error
    /// evidence.
    ///
    /// This status does not assert either success or failure.
    Unknown,
}

impl JsonlResultSummary {
    pub(super) fn from_event(event: &serde_json::Value) -> Self {
        let status = JsonlResultStatus::from_event(event);
        Self {
            num_turns: event.get("num_turns").and_then(|value| value.as_u64()),
            status,
            model_request: if status == JsonlResultStatus::Error {
                event
                    .get("modelRequest")
                    .and_then(|value| serde_json::from_value(value.clone()).ok())
            } else {
                None
            },
        }
    }
}

impl JsonlResultStatus {
    fn from_event(event: &serde_json::Value) -> Self {
        let is_error = event.get("is_error").and_then(|value| value.as_bool());
        let subtype = event.get("subtype").and_then(|value| value.as_str());

        if is_error == Some(true) || subtype == Some("error") {
            return Self::Error;
        }
        if is_error == Some(false) || subtype == Some("success") {
            return Self::Success;
        }

        Self::Unknown
    }
}

#[cfg(test)]
mod tests {
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
}
