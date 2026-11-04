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
