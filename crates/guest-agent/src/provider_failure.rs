//! Provider evidence shared by the three terminal model-result boundaries.

use guest_contracts::diagnostics::FailureReason;
use serde_json::Value;

use crate::failure_patterns;

pub(crate) fn http_failure_reason(status: u16) -> Option<FailureReason> {
    match status {
        429 => Some(FailureReason::ProviderRateLimited),
        529 => Some(FailureReason::ProviderOverloaded),
        500..=599 => Some(FailureReason::ProviderServerError),
        _ => None,
    }
}

/// Only use on a terminal model error, not stderr, tool output, or assistant text.
pub(crate) fn provider_failure_reason(message: &str) -> Option<FailureReason> {
    let message = message.trim();
    envelope_failure_reason(message)
        .or_else(|| text_failure_reason(message))
        .or_else(|| {
            let normalized = message.to_ascii_lowercase();
            let detail = normalized
                .strip_prefix("api error: ")
                .or_else(|| normalized.strip_prefix("unexpected status "))?;
            let status = detail.split_whitespace().next()?.parse::<u16>().ok()?;
            http_failure_reason(status)
        })
}

fn text_failure_reason(message: &str) -> Option<FailureReason> {
    let normalized = message.trim().to_ascii_lowercase();
    let normalized = normalized
        .strip_prefix("codex error: ")
        .unwrap_or(&normalized);
    if normalized == "our servers are currently overloaded. please try again later."
        || normalized == "selected model is at capacity. please try a different model."
    {
        return Some(FailureReason::ProviderOverloaded);
    }
    if normalized == "terminated" {
        return Some(FailureReason::ResponseConnectionLost);
    }
    if normalized
        .strip_prefix("codex sse response ")
        .and_then(|detail| {
            detail
                .strip_prefix("headers timed out after ")
                .or_else(|| detail.strip_prefix("body timed out after "))
        })
        .and_then(|duration| duration.strip_suffix("ms"))
        .is_some_and(|duration| {
            !duration.is_empty() && duration.bytes().all(|byte| byte.is_ascii_digit())
        })
    {
        return Some(FailureReason::ProviderStreamTimeout);
    }

    let key_detail = normalized
        .split_once(' ')
        .filter(|(status, _)| status.len() == 3 && status.bytes().all(|byte| byte.is_ascii_digit()))
        .map_or(normalized, |(_, detail)| detail);
    if key_detail
        .strip_prefix("invalid_api_key")
        .is_some_and(|suffix| {
            suffix
                .chars()
                .next()
                .is_none_or(|c| !c.is_ascii_alphanumeric() && c != '_')
        })
        || normalized.starts_with("incorrect api key provided")
    {
        return Some(FailureReason::InvalidApiKey);
    }
    if normalized.starts_with("codex ran out of room in the model's context window.")
        && failure_patterns::is_codex_context_window_exceeded_message(normalized)
    {
        return Some(FailureReason::ContextWindowExceeded);
    }
    None
}

fn envelope_failure_reason(message: &str) -> Option<FailureReason> {
    // The CLIs render upstream envelopes with a fixed error/status prefix.
    // Reject JSON quoted in unrelated prose and nested debug payloads.
    let start = message.find('{')?;
    let prefix = message[..start].trim().to_ascii_lowercase();
    if !(prefix.is_empty()
        || prefix == "codex error:"
        || prefix.starts_with("api error: ")
        || prefix.starts_with("unexpected status ")
        || prefix.split_whitespace().next().is_some_and(|status| {
            status.len() == 3 && status.bytes().all(|byte| byte.is_ascii_digit())
        }))
    {
        return None;
    }
    let (Some(value), _) = failure_patterns::parse_next_json_object(message, start)? else {
        return None;
    };
    provider_error_reason(&value)
}

/// Classify a provider's error object before a CLI projection drops its code.
pub(crate) fn provider_error_reason(value: &Value) -> Option<FailureReason> {
    let error = value
        .get("error")
        .filter(|error| error.is_object())
        .unwrap_or(value);
    if error.get("error").and_then(Value::as_str) == Some("insufficient_credits") {
        return Some(FailureReason::InsufficientCredits);
    }
    if (error.get("error").and_then(Value::as_str) == Some("TOKEN_REFRESH_FAILED")
        || error.get("code").and_then(Value::as_str) == Some("TOKEN_REFRESH_FAILED"))
        && error.get("failureReason").and_then(Value::as_str) == Some("reconnect_required")
        && failure_patterns::has_exact_codex_oauth_connector(error)
    {
        return Some(FailureReason::ReconnectRequired);
    }
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .or_else(|| error.get("type").and_then(Value::as_str));
    match code {
        Some("invalid_api_key") => Some(FailureReason::InvalidApiKey),
        Some("authentication_error") => Some(FailureReason::InvalidCredentials),
        Some("context_length_exceeded" | "context_window_exceeded" | "prompt_too_long") => {
            Some(FailureReason::ContextWindowExceeded)
        }
        Some("rate_limit_exceeded" | "rate_limit_error") => {
            Some(FailureReason::ProviderRateLimited)
        }
        Some("overloaded_error" | "server_overloaded") => Some(FailureReason::ProviderOverloaded),
        Some("server_error" | "internal_server_error") => Some(FailureReason::ProviderServerError),
        Some(
            "insufficient_quota"
            | "usage_limit_reached"
            | "usage_not_included"
            | "billing_hard_limit_reached",
        ) => Some(FailureReason::UsageLimit),
        Some("insufficient_credits") => Some(FailureReason::InsufficientCredits),
        Some("content_policy_violation") => Some(FailureReason::SafetyPolicyRefusal),
        Some("model_not_found" | "unsupported_model") => Some(FailureReason::UnsupportedModel),
        Some("invalid_request_error")
            if error
                .get("message")
                .and_then(Value::as_str)
                .is_some_and(is_prompt_too_long) =>
        {
            Some(FailureReason::ContextWindowExceeded)
        }
        Some("invalid_request_error")
            if error.get("type").and_then(Value::as_str) == Some("invalid_request_error")
                && error.get("code").and_then(Value::as_str) == Some("invalid_request_error")
                && error.get("message").and_then(Value::as_str) == Some("Content Exists Risk") =>
        {
            Some(FailureReason::SafetyPolicyRefusal)
        }
        _ => error
            .get("message")
            .and_then(Value::as_str)
            .and_then(text_failure_reason),
    }
}

fn is_prompt_too_long(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    let Some(counts) = message
        .strip_prefix("prompt is too long: ")
        .and_then(|s| s.strip_suffix(" maximum"))
    else {
        return false;
    };
    counts
        .split_once(" tokens > ")
        .or_else(|| counts.split_once(" token > "))
        .is_some_and(|(actual, maximum)| {
            !actual.is_empty()
                && !maximum.is_empty()
                && actual
                    .bytes()
                    .chain(maximum.bytes())
                    .all(|byte| byte.is_ascii_digit())
        })
}
