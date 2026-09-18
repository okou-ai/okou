//! Exact failure predicates shared by structured event extraction and final
//! diagnostic classification.

use serde_json::Value;

pub(crate) const CODEX_OAUTH_TOKEN_CONNECTOR: &str = "codex-oauth-token";
const CODEX_MODEL_CAPACITY_MESSAGE: &str =
    "selected model is at capacity. please try a different model.";
const CODEX_CONTEXT_WINDOW_EXHAUSTED_PREFIX: &str =
    "codex ran out of room in the model's context window.";
const CODEX_RATE_LIMIT_RETRY_EXHAUSTED_MESSAGE: &str =
    "exceeded retry limit, last status: 429 too many requests";
const CODEX_OUTPUT_TOKEN_LIMIT_MESSAGE: &str = "stream disconnected before completion: Incomplete response returned, reason: max_output_tokens";
const CODEX_UNSUPPORTED_MODEL_MESSAGE_SUFFIX: &str =
    "' model is not supported when using Codex with a ChatGPT account.";
const CONTENT_POLICY_REJECTION_ERROR_TYPE: &str = "invalid_request_error";
const CONTENT_POLICY_REJECTION_MESSAGE: &str = "Content Exists Risk";

pub(crate) fn is_generic_codex_failure_diagnostic(message: &str) -> bool {
    let message = message.trim().to_ascii_lowercase();
    let message = message.trim_end_matches(['.', ':', '!', '?']).trim_end();
    matches!(
        message,
        "error" | "turn failed" | "turn interrupted" | "unknown error" | "codex error"
    )
}

pub(crate) fn is_codex_model_capacity_message(message: &str) -> bool {
    message
        .to_ascii_lowercase()
        .contains(CODEX_MODEL_CAPACITY_MESSAGE)
}

/// Match only the native Codex terminal error for an incomplete provider response.
/// Callers must establish that this is model failure text, not normal output.
pub(crate) fn is_codex_output_token_limit_message(message: &str) -> bool {
    message
        .trim()
        .eq_ignore_ascii_case(CODEX_OUTPUT_TOKEN_LIMIT_MESSAGE)
}

pub(crate) fn is_codex_context_window_exceeded_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains(CODEX_CONTEXT_WINDOW_EXHAUSTED_PREFIX)
        && (message.contains("start a new thread") || message.contains("start a new conversation"))
        && message.contains("clear earlier history")
        && message.contains("before retrying")
}

pub(crate) fn is_codex_rate_limit_retry_exhausted_message(message: &str) -> bool {
    let normalized = message.trim().to_ascii_lowercase();
    let normalized = normalized
        .strip_prefix("codex failed:")
        .unwrap_or(&normalized)
        .trim();
    let Some(suffix) = normalized.strip_prefix(CODEX_RATE_LIMIT_RETRY_EXHAUSTED_MESSAGE) else {
        return false;
    };
    suffix.is_empty()
        || suffix
            .strip_prefix(", request id: ")
            .is_some_and(|request_id| {
                !request_id.is_empty()
                    && request_id
                        .chars()
                        .all(|character| !character.is_ascii_whitespace())
            })
}

pub(crate) fn is_codex_chatgpt_account_unsupported_model_message(message: &str) -> bool {
    let Some(model) = message
        .strip_prefix("The '")
        .and_then(|message| message.strip_suffix(CODEX_UNSUPPORTED_MODEL_MESSAGE_SUFFIX))
    else {
        return false;
    };
    !model.is_empty() && !model.contains('\'')
}

/// Whether a failure message carries an exact content-policy rejection envelope.
///
/// Codex passes the upstream provider response through as the failure message,
/// sometimes wrapped in its own prose, so scan every embedded JSON object
/// instead of comparing the whole message.
pub(crate) fn is_content_policy_rejection_message(message: &str) -> bool {
    let mut search_start = 0;
    while let Some((value, end_index)) = parse_next_json_object(message, search_start) {
        if value
            .as_ref()
            .is_some_and(is_content_policy_rejection_envelope)
        {
            return true;
        }
        search_start = end_index;
    }
    false
}

/// Exact OpenAI-compatible content-policy rejection envelope.
///
/// Providers behind the OpenAI-compatible surface report a content-safety
/// rejection as an `invalid_request_error` whose message is a fixed phrase
/// rather than a request-shape complaint. Match the message, type, and code
/// together so a genuine malformed request, which shares the same error type,
/// keeps its unclassified actionable failure.
fn is_content_policy_rejection_envelope(value: &Value) -> bool {
    value.get("error").is_some_and(|error| {
        error.get("type").and_then(Value::as_str) == Some(CONTENT_POLICY_REJECTION_ERROR_TYPE)
            && error.get("code").and_then(Value::as_str)
                == Some(CONTENT_POLICY_REJECTION_ERROR_TYPE)
            && error
                .get("message")
                .and_then(Value::as_str)
                .is_some_and(|message| message.trim() == CONTENT_POLICY_REJECTION_MESSAGE)
    })
}

/// Parse the next embedded JSON object, returning the value when it decodes and
/// the offset to resume scanning from.
pub(crate) fn parse_next_json_object(
    message: &str,
    search_start: usize,
) -> Option<(Option<Value>, usize)> {
    let body_start = message[search_start.min(message.len())..]
        .find('{')
        .map(|offset| search_start + offset)?;
    let mut stream = serde_json::Deserializer::from_str(&message[body_start..]).into_iter();

    match stream.next() {
        Some(Ok(value)) => Some((Some(value), body_start + stream.byte_offset())),
        Some(Err(_)) | None => Some((None, body_start + 1)),
    }
}

pub(crate) fn has_exact_codex_oauth_connector(value: &Value) -> bool {
    value
        .get("connectors")
        .and_then(Value::as_array)
        .is_some_and(|connectors| {
            connectors.len() == 1
                && connectors.first().and_then(Value::as_str) == Some(CODEX_OAUTH_TOKEN_CONNECTOR)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_generic_failure_diagnostic_matcher_is_case_insensitive() {
        for message in [
            "error",
            "error:",
            "error :",
            "Turn failed",
            "Turn failed.",
            "Turn failed .",
            " turn interrupted ",
            "UNKNOWN ERROR",
            "unknown error!",
            "codex error",
            "codex error?",
        ] {
            assert!(
                is_generic_codex_failure_diagnostic(message),
                "message should be generic: {message}"
            );
        }

        assert!(!is_generic_codex_failure_diagnostic(
            "Selected model is at capacity. Please try a different model."
        ));
    }

    #[test]
    fn codex_model_capacity_matcher_accepts_wrapped_case_insensitive_message() {
        assert!(is_codex_model_capacity_message(
            "Codex failed: SELECTED MODEL IS AT CAPACITY. PLEASE TRY A DIFFERENT MODEL."
        ));
    }

    #[test]
    fn codex_model_capacity_matcher_ignores_generic_overload_text() {
        assert!(!is_codex_model_capacity_message(
            "API Error: 529 Overloaded. This is a server-side issue, usually temporary - try again in a moment."
        ));
    }

    #[test]
    fn codex_context_window_matcher_accepts_thread_and_conversation_variants() {
        for message in [
            "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
            "Codex ran out of room in the model's context window. Start a new conversation or clear earlier history before retrying.",
        ] {
            assert!(
                is_codex_context_window_exceeded_message(message),
                "message: {message}"
            );
        }
    }

    #[test]
    fn codex_context_window_matcher_ignores_generic_context_window_text() {
        assert!(!is_codex_context_window_exceeded_message(
            "The prompt mentions the model context window but did not fail."
        ));
    }

    #[test]
    fn codex_rate_limit_retry_exhausted_matcher_accepts_known_shapes() {
        for message in [
            "exceeded retry limit, last status: 429 Too Many Requests",
            "exceeded retry limit, last status: 429 Too Many Requests, request id: req_123-abc",
            " Codex failed: EXCEEDED RETRY LIMIT, LAST STATUS: 429 TOO MANY REQUESTS, REQUEST ID: req_123 ",
        ] {
            assert!(
                is_codex_rate_limit_retry_exhausted_message(message),
                "message: {message}"
            );
        }
    }

    #[test]
    fn codex_rate_limit_retry_exhausted_matcher_rejects_near_misses() {
        for message in [
            "429 Too Many Requests",
            "exceeded retry limit, last status: 503 Service Unavailable",
            "exceeded retry limit, last status: 429 Too Many Requests; try later",
            "exceeded retry limit, last status: 429 Too Many Requests, request id: ",
            "the log says exceeded retry limit, last status: 429 Too Many Requests",
        ] {
            assert!(
                !is_codex_rate_limit_retry_exhausted_message(message),
                "message: {message}"
            );
        }
    }

    #[test]
    fn content_policy_rejection_matcher_accepts_the_exact_envelope() {
        for message in [
            r#"{"error":{"message":"Content Exists Risk","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}"#,
            r#"stream error: {"error":{"message":"Content Exists Risk","type":"invalid_request_error","code":"invalid_request_error"}} (retrying)"#,
            r#"{"not":"json-object-first"} {"error":{"message":"Content Exists Risk","type":"invalid_request_error","code":"invalid_request_error"}}"#,
        ] {
            assert!(
                is_content_policy_rejection_message(message),
                "message: {message}"
            );
        }
    }

    #[test]
    fn content_policy_rejection_matcher_rejects_other_invalid_requests() {
        for message in [
            r#"{"error":{"message":"Invalid Format","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}"#,
            r#"{"error":{"message":"Content Exists Risk","type":"invalid_request_error"}}"#,
            r#"{"error":{"message":"Content Exists Risk","code":"invalid_request_error"}}"#,
            r#"{"error":{"message":"Content Exists Risk","type":"content_filter","code":"content_filter"}}"#,
            r#"{"error":{"message":"Content Exists Risk detected in input","type":"invalid_request_error","code":"invalid_request_error"}}"#,
            r#"{"detail":"Content Exists Risk"}"#,
            "Content Exists Risk",
            "{not valid json",
            "",
        ] {
            assert!(
                !is_content_policy_rejection_message(message),
                "message: {message}"
            );
        }
    }

    #[test]
    fn codex_unsupported_model_matcher_requires_the_exact_message() {
        assert!(is_codex_chatgpt_account_unsupported_model_message(
            "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."
        ));

        for message in [
            "The '' model is not supported when using Codex with a ChatGPT account.",
            "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account",
            "the 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
            "The 'gpt-5.6-sol' model is not supported with this account.",
            "The 'gpt'5.6-sol' model is not supported when using Codex with a ChatGPT account.",
        ] {
            assert!(
                !is_codex_chatgpt_account_unsupported_model_message(message),
                "message: {message}"
            );
        }
    }
}
