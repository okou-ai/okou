//! Final CLI failure-message selection and structured diagnostic construction.
//!
//! Structured provider events are parsed by [`crate::events`]. This module
//! consumes the already masked CLI result, selects the final user-visible
//! failure message, applies source-sensitive text classification, and persists
//! the resulting guest failure artifacts.

use crate::cli;
use crate::env;
use crate::error::AgentError;
use crate::failure_patterns;
use crate::paths;
use crate::session_history;
use crate::session_metadata::CapturedSessionMetadata;
use crate::upstream_error_text::upstream_non_api_response_status;
use guest_contracts::diagnostics::{
    AgentFramework, CliObservedExitDiagnostic, CliTerminationDiagnostic, CliTerminationReason,
    EventDeliveryDiagnostic, FailureClass, FailureDetailSource, FailureDiagnostic, FailureReason,
    PromptMetadata, SessionHistoryStatus,
};
use guest_contracts::env::CliFramework;
use guest_telemetry::{log_info, log_warn};
use serde_json::Value;

const LOG_TAG: &str = "sandbox:guest-agent";
const MAX_LOGGED_CLI_STDERR_LINES: usize = 20;
const MAX_LOGGED_CLI_STDERR_LINE_BYTES: usize = 4096;
/// Lowercased marker the Pi model boundary writes before an observed status.
const PI_PROVIDER_HTTP_MARKER: &str = "provider http ";
const CODEX_SAFETY_POLICY_REFUSAL_MESSAGE: &str = concat!(
    "This content was flagged for possible cybersecurity risk. ",
    "If this seems wrong, try rephrasing your request. ",
    "To get authorized for security work, join the Trusted Access for Cyber program: ",
    "https://chatgpt.com/cyber",
);

/// Final message and structured diagnostic for a nonzero CLI result.
#[derive(Debug)]
pub struct CliNonzeroFailure {
    /// Selected user-visible failure message.
    pub message: String,
    /// Structured diagnostic containing the selected source and reason.
    pub diagnostic: FailureDiagnostic,
}

/// Build a base diagnostic from explicit run configuration.
pub fn base_failure_diagnostic_for_config(
    config: &env::GuestConfig,
    failure_class: FailureClass,
) -> FailureDiagnostic {
    let framework = AgentFramework::from(CliFramework::from(config.framework));
    FailureDiagnostic::new(
        failure_class,
        framework,
        PromptMetadata::from_prompt(&config.prompt),
    )
}

/// Build the diagnostic for a CLI execution boundary error.
pub fn cli_execution_error_for_config(
    config: &env::GuestConfig,
    error: &AgentError,
) -> FailureDiagnostic {
    let diagnostic = base_failure_diagnostic_for_config(config, FailureClass::CliExecutionError);
    if matches!(error, AgentError::CodexInputTooLarge { .. }) {
        diagnostic.with_failure_reason(FailureReason::InputTooLarge)
    } else {
        diagnostic
    }
}

/// Build the diagnostic for a CLI control-path failure.
pub fn cli_control_failure_for_config(
    config: &env::GuestConfig,
    session_metadata: Option<&CapturedSessionMetadata>,
    cli_result: &cli::CliExecutionResult,
) -> FailureDiagnostic {
    let diagnostic = cli_result_failure_diagnostic_for_config(
        config,
        session_metadata,
        FailureClass::CliExecutionError,
        cli_result.exit_code,
        cli_result.jsonl_result,
    );
    let diagnostic =
        with_cli_observed_exit(diagnostic, cli_result.cli_observed_exit.as_ref().cloned());
    let diagnostic = with_cli_termination(diagnostic, cli_result.cli_termination);
    if let Some(heartbeat) = cli_result.heartbeat.clone() {
        diagnostic.with_heartbeat(heartbeat)
    } else {
        diagnostic
    }
}

/// Build the primary diagnostic for terminal event delivery after a CLI result.
pub fn event_delivery_failure_for_config(
    config: &env::GuestConfig,
    session_metadata: Option<&CapturedSessionMetadata>,
    cli_result: &cli::CliExecutionResult,
    event_delivery: EventDeliveryDiagnostic,
) -> FailureDiagnostic {
    let diagnostic = cli_result_failure_diagnostic_for_config(
        config,
        session_metadata,
        FailureClass::EventUploadFailed,
        cli_result.exit_code,
        cli_result.jsonl_result,
    )
    .with_event_delivery(event_delivery);
    let diagnostic =
        with_cli_observed_exit(diagnostic, cli_result.cli_observed_exit.as_ref().cloned());
    with_cli_termination(diagnostic, cli_result.cli_termination)
}

/// Select the final message and build the diagnostic for a nonzero CLI result.
pub fn cli_nonzero_failure_for_config(
    config: &env::GuestConfig,
    session_metadata: Option<&CapturedSessionMetadata>,
    cli_result: &cli::CliExecutionResult,
) -> CliNonzeroFailure {
    let failure_message = cli_failure_message(
        cli_result.exit_code,
        &cli_result.stderr_lines,
        cli_result.failure_diagnostic.as_ref(),
    );
    let diagnostic = cli_result_failure_diagnostic_for_config(
        config,
        session_metadata,
        FailureClass::CliNonzero,
        cli_result.exit_code,
        cli_result.jsonl_result,
    )
    .with_failure_detail_source(failure_message.source);
    let diagnostic =
        with_cli_observed_exit(diagnostic, cli_result.cli_observed_exit.as_ref().cloned());
    let diagnostic = with_cli_termination(diagnostic, cli_result.cli_termination);
    let diagnostic = with_cli_failure_reason(diagnostic, &failure_message);

    CliNonzeroFailure {
        message: failure_message.message,
        diagnostic,
    }
}

/// Return the conservative session-history target probe for failure diagnostics.
///
/// For Claude Code, guest-owned captured metadata supplies the target. If no
/// valid session identity was captured, this returns `Missing`; an invalid
/// launch source or unreadable target returns `Unknown`.
///
/// A safely opened regular target is `Empty` only when it has zero bytes and is
/// otherwise `Present`. Resolution errors are `Unknown`. Codex returns
/// `NotApplicable` because this diagnostic probe does not apply to it.
pub fn diagnostic_session_history_status_for_config(
    config: &env::GuestConfig,
    session_metadata: Option<&CapturedSessionMetadata>,
) -> SessionHistoryStatus {
    match config.framework {
        env::Framework::ClaudeCode => claude_history_target_status(session_metadata),
        env::Framework::Codex => SessionHistoryStatus::NotApplicable,
        env::Framework::Pi => SessionHistoryStatus::NotApplicable,
    }
}

fn claude_history_target_status(
    session_metadata: Option<&CapturedSessionMetadata>,
) -> SessionHistoryStatus {
    let Some(session_metadata) = session_metadata else {
        return SessionHistoryStatus::Missing;
    };
    let Some(source) = session_metadata.history_source() else {
        return SessionHistoryStatus::Unknown;
    };
    match session_history::resolve_session_history_from_source(source) {
        Ok(history) if history.encoded_len().is_ok_and(|size| size == 0) => {
            SessionHistoryStatus::Empty
        }
        Ok(_) => SessionHistoryStatus::Present,
        Err(_) => SessionHistoryStatus::Unknown,
    }
}

/// Persist a nonempty guest error message with private file permissions.
pub fn write_guest_error_file(checkpoint_error_file: &str, message: &str) {
    let message = message.trim();
    if message.is_empty() {
        return;
    }

    if let Err(e) = paths::write_private(checkpoint_error_file, message) {
        log_warn!(LOG_TAG, "Failed to write guest error file: {e}");
    }
}

/// Serialize and persist a structured guest failure diagnostic.
pub fn write_guest_failure_diagnostic(
    failure_diagnostic_file: &str,
    diagnostic: &FailureDiagnostic,
) {
    let bytes = match serde_json::to_vec(diagnostic) {
        Ok(bytes) => bytes,
        Err(e) => {
            log_warn!(LOG_TAG, "Failed to serialize guest failure diagnostic: {e}");
            return;
        }
    };

    if let Err(e) = paths::write_private(failure_diagnostic_file, bytes) {
        log_warn!(
            LOG_TAG,
            "Failed to write guest failure diagnostic file: {e}"
        );
    }
}

fn with_cli_termination(
    mut diagnostic: FailureDiagnostic,
    cli_termination: Option<CliTerminationDiagnostic>,
) -> FailureDiagnostic {
    if let Some(cli_termination) = cli_termination {
        if cli_termination.reason == CliTerminationReason::ExecutionTimeout {
            diagnostic = diagnostic.with_failure_reason(FailureReason::ExecutionTimeout);
        }
        diagnostic.with_cli_termination(cli_termination)
    } else {
        diagnostic
    }
}

fn with_cli_observed_exit(
    diagnostic: FailureDiagnostic,
    cli_observed_exit: Option<CliObservedExitDiagnostic>,
) -> FailureDiagnostic {
    if let Some(cli_observed_exit) = cli_observed_exit {
        diagnostic.with_cli_observed_exit(cli_observed_exit)
    } else {
        diagnostic
    }
}

fn cli_result_failure_diagnostic_for_config(
    config: &env::GuestConfig,
    session_metadata: Option<&CapturedSessionMetadata>,
    failure_class: FailureClass,
    cli_exit_code: i32,
    jsonl_result: Option<cli::JsonlResultSummary>,
) -> FailureDiagnostic {
    let mut diagnostic = base_failure_diagnostic_for_config(config, failure_class)
        .with_cli_exit_code(cli_exit_code)
        .with_session_history_status(diagnostic_session_history_status_for_config(
            config,
            session_metadata,
        ));
    if matches!(config.framework, env::Framework::ClaudeCode)
        && let Some(result) = jsonl_result
    {
        diagnostic = diagnostic.with_claude_num_turns(result.num_turns);
    }
    if matches!(config.framework, env::Framework::Pi)
        && let Some(result) = jsonl_result
    {
        diagnostic.model_request = result.model_request;
    }
    diagnostic
}

fn with_cli_failure_reason(
    diagnostic: FailureDiagnostic,
    failure_message: &CliFailureMessage,
) -> FailureDiagnostic {
    // Prefer evidence owned by the selected terminal event over its display text.
    // The Pi SDK can rewrite ordinary HTTP 429 into ChatGPT usage-limit prose.
    // A later, selected stderr failure still keeps its existing text precedence.
    if matches!(
        (diagnostic.framework, failure_message.source),
        (AgentFramework::Pi, FailureDetailSource::PiResult)
            | (AgentFramework::Codex, FailureDetailSource::CodexJsonl)
    ) && let Some(reason) = failure_message.failure_reason
    {
        return diagnostic.with_failure_reason(reason);
    }
    if let Some(reason) = classify_cli_failure_reason(
        diagnostic.framework,
        failure_message.source,
        failure_message.message.as_str(),
    )
    .or(failure_message.failure_reason)
    .or_else(|| {
        (diagnostic.framework == AgentFramework::Pi)
            .then_some(diagnostic.model_request)
            .flatten()
            .and_then(|request| request.http_status)
            .and_then(crate::provider_failure::http_failure_reason)
    }) {
        diagnostic.with_failure_reason(reason)
    } else {
        diagnostic
    }
}

fn classify_cli_failure_reason(
    framework: AgentFramework,
    source: FailureDetailSource,
    failure_message: &str,
) -> Option<FailureReason> {
    if matches!(framework, AgentFramework::Codex)
        && is_codex_safety_policy_refusal(source, failure_message)
    {
        return Some(FailureReason::SafetyPolicyRefusal);
    }
    if matches!(framework, AgentFramework::Codex)
        && source == FailureDetailSource::CodexJsonl
        && failure_patterns::is_content_policy_rejection_message(failure_message)
    {
        return Some(FailureReason::SafetyPolicyRefusal);
    }
    if matches!(framework, AgentFramework::Codex)
        && source == FailureDetailSource::CodexJsonl
        && failure_patterns::is_codex_rate_limit_retry_exhausted_message(failure_message)
    {
        return Some(FailureReason::ProviderRateLimited);
    }
    if matches!(framework, AgentFramework::Codex)
        && source == FailureDetailSource::Stderr
        && is_codex_chatgpt_account_unsupported_model_run_error(failure_message)
    {
        return Some(FailureReason::UnsupportedModel);
    }
    if matches!(framework, AgentFramework::Pi)
        && source == FailureDetailSource::PiResult
        && let Some(reason) = pi_upstream_non_api_response_reason(failure_message)
    {
        return Some(reason);
    }

    let normalized = failure_message.to_ascii_lowercase();
    if framework == AgentFramework::ClaudeCode
        && source == FailureDetailSource::ClaudeResult
        && normalized.trim() == "credit balance is too low"
    {
        return Some(FailureReason::ProviderInsufficientCredits);
    }
    if normalized.starts_with("api error: 402 ")
        && normalized.contains("requires more credits")
        && normalized.contains("can only afford")
    {
        return Some(FailureReason::ProviderInsufficientCredits);
    }
    if matches!(
        source,
        FailureDetailSource::ClaudeResult
            | FailureDetailSource::CodexJsonl
            | FailureDetailSource::PiResult
    ) && is_provider_balance_response_error(&normalized)
    {
        return Some(FailureReason::ProviderInsufficientCredits);
    }
    if is_insufficient_credits_error(&normalized) {
        return Some(FailureReason::InsufficientCredits);
    }
    if matches!(framework, AgentFramework::ClaudeCode)
        && is_claude_terms_acceptance_required_error(&normalized)
    {
        return Some(FailureReason::TermsAcceptanceRequired);
    }
    if matches!(framework, AgentFramework::ClaudeCode)
        && is_claude_oauth_reconnect_required_error(&normalized)
    {
        return Some(FailureReason::ReconnectRequired);
    }
    if matches!(framework, AgentFramework::ClaudeCode)
        && is_claude_invalid_credentials_error(&normalized)
    {
        return Some(FailureReason::InvalidCredentials);
    }
    if matches!(framework, AgentFramework::ClaudeCode)
        && (is_claude_provider_overloaded_error(&normalized)
            || is_claude_result_simple_provider_overloaded_error(source, &normalized))
    {
        return Some(FailureReason::ProviderOverloaded);
    }
    if matches!(framework, AgentFramework::ClaudeCode)
        && is_claude_result_provider_stream_timeout(source, &normalized)
    {
        return Some(FailureReason::ProviderStreamTimeout);
    }
    if matches!(framework, AgentFramework::ClaudeCode)
        && is_claude_provider_server_error(source, &normalized)
    {
        return Some(FailureReason::ProviderServerError);
    }
    if matches!(framework, AgentFramework::ClaudeCode)
        && is_claude_result_response_connection_lost(source, &normalized)
    {
        return Some(FailureReason::ResponseConnectionLost);
    }
    if matches!(framework, AgentFramework::ClaudeCode)
        && is_claude_output_token_limit_error(&normalized)
    {
        return Some(FailureReason::OutputTokenLimit);
    }
    if matches!(framework, AgentFramework::Codex)
        && (normalized.contains("invalid_api_key")
            || normalized.contains("incorrect api key provided"))
    {
        return Some(FailureReason::InvalidApiKey);
    }
    if matches!(framework, AgentFramework::Codex)
        && is_codex_oauth_reconnect_required_run_error(failure_message)
    {
        return Some(FailureReason::ReconnectRequired);
    }
    if matches!(framework, AgentFramework::Codex)
        && failure_patterns::is_codex_model_capacity_message(failure_message)
    {
        return Some(FailureReason::ProviderOverloaded);
    }
    if matches!(framework, AgentFramework::Codex)
        && failure_patterns::is_codex_context_window_exceeded_message(failure_message)
    {
        return Some(FailureReason::ContextWindowExceeded);
    }
    if matches!(
        (framework, source),
        (AgentFramework::Pi, FailureDetailSource::PiResult)
            | (AgentFramework::Codex, FailureDetailSource::CodexJsonl)
            | (
                AgentFramework::ClaudeCode,
                FailureDetailSource::ClaudeResult
            )
    ) && let Some(reason) = crate::provider_failure::provider_failure_reason(failure_message)
    {
        return Some(reason);
    }
    // Subscription/usage limits are an expected quota state for both Codex
    // (ChatGPT plan "usage limit" or API billing "quota exceeded") and Claude
    // Code (Max plan "session limit" / "weekly limit" /
    // org monthly spend limit), so classify them regardless of framework where
    // the wording is shared. This lets the runner log these expected outcomes
    // at info instead of error.
    if normalized.contains("usage limit")
        || (matches!(framework, AgentFramework::Codex)
            && normalized.contains("quota exceeded. check your plan and billing details"))
        || normalized.contains("session limit")
        || normalized.contains("weekly limit")
        || (matches!(framework, AgentFramework::ClaudeCode)
            && (is_claude_subscription_access_disabled_error(&normalized)
                || is_claude_monthly_spend_limit_error(&normalized)))
    {
        return Some(FailureReason::UsageLimit);
    }
    // Quota and subscription wording above stays authoritative for the statuses
    // it also covers, so the observed provider status is read last.
    if matches!(framework, AgentFramework::Pi)
        && let Some(reason) = pi_provider_http_failure_reason(source, &normalized)
    {
        return Some(reason);
    }
    None
}

/// Classify the provider status the Pi runtime records for an opaque body.
///
/// The Pi model boundary restates a non-JSON provider error as
/// `provider HTTP <status>: <phrase>`, so an Envoy or edge reply that used to
/// arrive as bare prose now carries its stage. Only the server-unavailability
/// family is classified here; every other status keeps whatever message-shaped
/// classification already applies, or stays unknown.
fn pi_provider_http_failure_reason(
    source: FailureDetailSource,
    normalized: &str,
) -> Option<FailureReason> {
    if source != FailureDetailSource::PiResult {
        return None;
    }
    normalized
        .match_indices(PI_PROVIDER_HTTP_MARKER)
        .find_map(|(index, _)| {
            if normalized[..index]
                .chars()
                .next_back()
                .is_some_and(is_error_type_char)
            {
                return None;
            }
            let detail = &normalized[index + PI_PROVIDER_HTTP_MARKER.len()..];
            let status_len = detail
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(detail.len());
            let (status, remaining) = detail.split_at(status_len);
            if remaining.chars().next().is_some_and(is_error_type_char) {
                return None;
            }
            match status {
                "500" | "502" | "503" | "504" => Some(FailureReason::ProviderServerError),
                "529" => Some(FailureReason::ProviderOverloaded),
                _ => None,
            }
        })
}

/// Classify a Pi model error whose upstream answered with a document.
///
/// Only a status the Pi runtime actually observed is trusted. An unknown status
/// stays unclassified so the failure keeps its error-level report instead of
/// being presented as an expected upstream condition.
fn pi_upstream_non_api_response_reason(failure_message: &str) -> Option<FailureReason> {
    match upstream_non_api_response_status(failure_message)? {
        429 => Some(FailureReason::ProviderRateLimited),
        529 => Some(FailureReason::ProviderOverloaded),
        500..=599 => Some(FailureReason::ProviderServerError),
        _ => None,
    }
}

fn is_codex_safety_policy_refusal(source: FailureDetailSource, failure_message: &str) -> bool {
    source == FailureDetailSource::CodexJsonl
        && failure_message.trim() == CODEX_SAFETY_POLICY_REFUSAL_MESSAGE
}

fn is_insufficient_credits_error(normalized: &str) -> bool {
    normalized.trim()
        == "api error: 402 insufficient credits. add credits or configure your own api key to continue."
        || has_insufficient_credits_response_envelope(normalized)
}

fn is_provider_balance_response_error(normalized: &str) -> bool {
    if !normalized.starts_with("api error: ") && !normalized.starts_with("unexpected status ") {
        return false;
    }
    let Some((Some(body), _)) = failure_patterns::parse_next_json_object(normalized, 0) else {
        return false;
    };
    let Some(error) = body.get("error").and_then(Value::as_object) else {
        return false;
    };
    let code = error.get("code");
    let error_type = error.get("type").and_then(Value::as_str);
    matches!(
        code.and_then(Value::as_str),
        Some("billing" | "billing_error" | "insufficient_quota" | "payment_required")
    ) || code.and_then(Value::as_u64) == Some(402)
        || matches!(
            error_type,
            Some("billing" | "billing_error" | "insufficient_quota" | "payment_required")
        )
        || (error_type == Some("invalid_request_error")
            && error
                .get("message")
                .and_then(Value::as_str)
                .is_some_and(|message| {
                    message
                        .starts_with("your credit balance is too low to access the anthropic api.")
                }))
}

fn has_insufficient_credits_response_envelope(normalized: &str) -> bool {
    const STATUS_MARKER: &str = "402 payment required";

    let Some(status_index) = normalized.find(STATUS_MARKER) else {
        return false;
    };

    let Some((Some(value), _)) =
        failure_patterns::parse_next_json_object(normalized, status_index + STATUS_MARKER.len())
    else {
        return false;
    };

    value.get("error").and_then(Value::as_str) == Some("insufficient_credits")
}

fn is_claude_invalid_credentials_error(normalized: &str) -> bool {
    normalized.contains("failed to authenticate")
        && normalized.contains("api error: 401 invalid authentication credentials")
}

fn is_claude_oauth_reconnect_required_error(normalized: &str) -> bool {
    const INVALID_TOKEN: &str = "oauth access token is invalid";

    normalized.contains("failed to authenticate")
        && has_claude_api_status(normalized, "401")
        && normalized.contains("oauth access token")
        && (normalized.contains("revoked")
            || normalized.match_indices(INVALID_TOKEN).any(|(index, _)| {
                !normalized[..index]
                    .chars()
                    .next_back()
                    .is_some_and(is_error_type_char)
                    && strip_word_prefix(&normalized[index..], INVALID_TOKEN).is_some()
            }))
}

fn is_claude_terms_acceptance_required_error(normalized: &str) -> bool {
    has_claude_api_status(normalized, "400")
        && normalized.contains("consumer terms")
        && normalized.contains("privacy policy")
        && normalized.contains("accept")
        && normalized.contains("claude.ai")
}

fn is_claude_provider_overloaded_error(normalized: &str) -> bool {
    const MARKER: &str = "api error:";
    normalized.match_indices(MARKER).any(|(index, _)| {
        claude_529_error_detail(&normalized[index + MARKER.len()..]).is_some_and(|detail| {
            starts_with_overloaded_word(detail) || contains_overloaded_error_type(detail)
        })
    })
}

fn is_claude_result_simple_provider_overloaded_error(
    source: FailureDetailSource,
    normalized: &str,
) -> bool {
    source == FailureDetailSource::ClaudeResult && normalized.trim() == "api error: overloaded"
}

fn is_claude_result_provider_stream_timeout(source: FailureDetailSource, normalized: &str) -> bool {
    let trimmed = normalized.trim();
    source == FailureDetailSource::ClaudeResult
        && (is_claude_result_stream_idle_timeout(trimmed)
            || is_claude_result_stalled_mid_stream(trimmed))
}

fn is_claude_result_stream_idle_timeout(trimmed: &str) -> bool {
    trimmed.starts_with("api error: stream idle timeout")
        && (trimmed.contains("partial response received") || trimmed.contains("no chunks received"))
}

fn is_claude_result_stalled_mid_stream(trimmed: &str) -> bool {
    trimmed.starts_with("api error: response stalled mid-stream")
        && trimmed.contains("response above may be incomplete")
}

fn is_claude_provider_server_error(source: FailureDetailSource, normalized: &str) -> bool {
    source == FailureDetailSource::ClaudeResult
        && ((has_claude_api_status(normalized, "500")
            && normalized.contains("internal server error")
            && normalized.contains("server-side issue"))
            || normalized.trim()
                == "api error: server error mid-response. the response above may be incomplete.")
}

fn is_claude_result_response_connection_lost(
    source: FailureDetailSource,
    normalized: &str,
) -> bool {
    source == FailureDetailSource::ClaudeResult
        && normalized.trim()
            == "api error: connection lost mid-response. the response above may be incomplete."
}

fn is_claude_output_token_limit_error(normalized: &str) -> bool {
    let response_exceeded = normalized.contains("response exceeded")
        || normalized.contains("response has exceeded")
        || normalized.contains("response exceeds");
    let output_token_limit = normalized.contains("output token maximum")
        || normalized.contains("output token limit")
        || normalized.contains("maximum output token")
        || normalized.contains("max output token")
        || normalized.contains("claude_code_max_output_tokens");
    response_exceeded && output_token_limit
}

fn claude_529_error_detail(detail: &str) -> Option<&str> {
    let detail = trim_error_detail_start(detail);
    let detail = if let Some(remaining) = strip_word_prefix(detail, "repeated") {
        trim_error_detail_start(remaining)
    } else {
        detail
    };
    let detail = detail.strip_prefix("529")?;
    if detail.chars().next().is_some_and(is_error_type_char) {
        return None;
    }
    Some(trim_error_detail_start(detail))
}

fn has_claude_api_status(normalized: &str, status: &str) -> bool {
    const MARKER: &str = "api error:";
    normalized.match_indices(MARKER).any(|(index, _)| {
        let detail = trim_error_detail_start(&normalized[index + MARKER.len()..]);
        let Some(remaining) = detail.strip_prefix(status) else {
            return false;
        };
        !remaining.chars().next().is_some_and(is_error_type_char)
    })
}

fn trim_error_detail_start(detail: &str) -> &str {
    detail.trim_start_matches(|c: char| c.is_ascii_whitespace() || matches!(c, ':' | '-' | '.'))
}

fn starts_with_overloaded_word(detail: &str) -> bool {
    strip_word_prefix(detail, "overloaded").is_some()
}

fn contains_overloaded_error_type(detail: &str) -> bool {
    const TOKEN: &str = "overloaded_error";
    detail.match_indices(TOKEN).any(|(index, _)| {
        let before = detail[..index].chars().next_back();
        let after = detail[index + TOKEN.len()..].chars().next();
        !before.is_some_and(is_error_type_char) && !after.is_some_and(is_error_type_char)
    })
}

fn strip_word_prefix<'a>(text: &'a str, token: &str) -> Option<&'a str> {
    text.strip_prefix(token).filter(|remaining| {
        remaining
            .chars()
            .next()
            .is_none_or(|c| !is_error_type_char(c))
    })
}

fn is_error_type_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-')
}

fn is_claude_subscription_access_disabled_error(normalized: &str) -> bool {
    normalized.contains("disabled claude subscription access") && normalized.contains("claude code")
}

fn is_claude_monthly_spend_limit_error(normalized: &str) -> bool {
    normalized.contains("org's monthly spend limit")
        && normalized.contains("claude.ai/settings/usage")
}

fn is_codex_oauth_reconnect_required_run_error(error_message: &str) -> bool {
    if !error_message.contains("TOKEN_REFRESH_FAILED")
        || !error_message.contains(failure_patterns::CODEX_OAUTH_TOKEN_CONNECTOR)
        || !error_message.contains("reconnect_required")
    {
        return false;
    }

    let mut search_start = 0;
    while let Some((value, end_index)) =
        failure_patterns::parse_next_json_object(error_message, search_start)
    {
        if value
            .as_ref()
            .is_some_and(is_codex_oauth_reconnect_required_value)
        {
            return true;
        }
        search_start = end_index;
    }
    false
}

fn is_codex_chatgpt_account_unsupported_model_run_error(error_message: &str) -> bool {
    let mut search_start = 0;
    while let Some((value, end_index)) =
        failure_patterns::parse_next_json_object(error_message, search_start)
    {
        if value.as_ref().is_some_and(|value| {
            value.get("type").and_then(Value::as_str) == Some("error")
                && value.get("status").and_then(Value::as_u64) == Some(400)
                && value.get("error").is_some_and(|error| {
                    error.get("type").and_then(Value::as_str) == Some("invalid_request_error")
                        && error.get("message").and_then(Value::as_str).is_some_and(
                            failure_patterns::is_codex_chatgpt_account_unsupported_model_message,
                        )
                })
        }) {
            return true;
        }
        search_start = end_index;
    }
    false
}

fn is_codex_oauth_reconnect_required_value(value: &Value) -> bool {
    is_codex_oauth_reconnect_required_body(value)
        || value
            .get("error")
            .is_some_and(is_codex_oauth_reconnect_required_envelope)
}

fn is_codex_oauth_reconnect_required_body(value: &Value) -> bool {
    value.get("error").and_then(Value::as_str) == Some("TOKEN_REFRESH_FAILED")
        && has_reconnect_required_payload(value)
}

fn is_codex_oauth_reconnect_required_envelope(value: &Value) -> bool {
    value.get("code").and_then(Value::as_str) == Some("TOKEN_REFRESH_FAILED")
        && has_reconnect_required_payload(value)
}

fn has_reconnect_required_payload(value: &Value) -> bool {
    value.get("failureReason").and_then(Value::as_str) == Some("reconnect_required")
        && failure_patterns::has_exact_codex_oauth_connector(value)
}

struct CliFailureMessage {
    message: String,
    source: FailureDetailSource,
    failure_reason: Option<FailureReason>,
}

fn cli_failure_message(
    code: i32,
    stderr_lines: &[String],
    failure_diagnostic: Option<&cli::CliFailureDiagnostic>,
) -> CliFailureMessage {
    let stdout_failure_reason = failure_diagnostic.and_then(|diagnostic| diagnostic.failure_reason);
    if let Some((message, source, failure_reason)) = failure_diagnostic.and_then(|diagnostic| {
        let message = diagnostic.message.trim();
        if message.is_empty() {
            None
        } else {
            Some((message, diagnostic.source, diagnostic.failure_reason))
        }
    }) && (!is_generic_stdout_failure_diagnostic(source, message) || stderr_lines.is_empty())
    {
        return CliFailureMessage {
            message: message.to_string(),
            source,
            failure_reason,
        };
    }

    // Structured agent telemetry shares stderr with real failure output. It
    // stays in the guest log below, but must never become the user-visible
    // reason a run failed.
    let mut reported_lines = Vec::with_capacity(stderr_lines.len());
    for line in stderr_lines {
        if is_structured_agent_diagnostic_line(line) {
            log_info!(
                LOG_TAG,
                "CLI stderr diagnostic: {}",
                truncate_cli_stderr_line(line)
            );
        } else {
            reported_lines.push(line);
        }
    }

    if reported_lines.is_empty() {
        return CliFailureMessage {
            message: format!("Agent exited with code {code}"),
            source: FailureDetailSource::FallbackExitCode,
            failure_reason: None,
        };
    }

    log_info!(LOG_TAG, "Captured {} stderr lines", stderr_lines.len());
    let omitted_lines = reported_lines
        .len()
        .saturating_sub(MAX_LOGGED_CLI_STDERR_LINES);
    let mut message_lines = Vec::with_capacity(
        reported_lines.len().min(MAX_LOGGED_CLI_STDERR_LINES) + usize::from(omitted_lines > 0),
    );
    if omitted_lines > 0 {
        log_warn!(
            LOG_TAG,
            "CLI stderr: omitted {} earlier line(s)",
            omitted_lines
        );
        message_lines.push(format!(
            "...[omitted {omitted_lines} earlier stderr line(s)]"
        ));
    }
    for line in reported_lines.into_iter().skip(omitted_lines) {
        let line = truncate_cli_stderr_line(line);
        log_warn!(LOG_TAG, "CLI stderr: {line}");
        message_lines.push(line.into_owned());
    }
    CliFailureMessage {
        message: message_lines.join(" "),
        source: FailureDetailSource::Stderr,
        failure_reason: stdout_failure_reason,
    }
}

/// Structured agent telemetry envelopes that agent runtimes emit on stderr.
///
/// Only these exact `type` values are recognized. Any other JSON object, and
/// any line that is not a JSON object, remains user-visible failure output.
const STRUCTURED_AGENT_DIAGNOSTIC_TYPES: [&str; 2] =
    ["pi_memory_recall_outcome", "pi_memory_tool_source_use"];

fn is_structured_agent_diagnostic_line(line: &str) -> bool {
    let Ok(Value::Object(fields)) = serde_json::from_str::<Value>(line.trim()) else {
        return false;
    };
    fields
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|value| STRUCTURED_AGENT_DIAGNOSTIC_TYPES.contains(&value))
}

fn is_generic_stdout_failure_diagnostic(source: FailureDetailSource, message: &str) -> bool {
    if source == FailureDetailSource::CodexJsonl {
        return failure_patterns::is_generic_codex_failure_diagnostic(message);
    }

    matches!(message.trim(), "error" | "turn failed" | "turn interrupted")
}

fn truncate_cli_stderr_line(line: &str) -> std::borrow::Cow<'_, str> {
    if line.len() <= MAX_LOGGED_CLI_STDERR_LINE_BYTES {
        return std::borrow::Cow::Borrowed(line);
    }

    let mut cut = 0;
    for (idx, ch) in line.char_indices() {
        let next = idx + ch.len_utf8();
        if next > MAX_LOGGED_CLI_STDERR_LINE_BYTES {
            break;
        }
        cut = next;
    }

    let mut truncated = line[..cut].to_string();
    truncated.push_str("...[truncated]");
    std::borrow::Cow::Owned(truncated)
}

#[cfg(test)]
mod tests;
