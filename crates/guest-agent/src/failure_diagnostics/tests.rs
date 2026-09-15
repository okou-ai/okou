use super::*;
use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};

struct SystemLogOverrideGuard;

impl SystemLogOverrideGuard {
    fn set(path: &std::path::Path) -> Self {
        guest_telemetry::log::set_system_log_file(path.to_string_lossy().as_ref());
        Self
    }
}

impl Drop for SystemLogOverrideGuard {
    fn drop(&mut self) {
        guest_telemetry::log::clear_system_log_file();
    }
}

fn cli_diagnostic(message: &str, source: FailureDetailSource) -> cli::CliFailureDiagnostic {
    cli::CliFailureDiagnostic {
        message: message.to_string(),
        source,
        failure_reason: None,
    }
}

fn selected_failure_message(
    message: &str,
    source: FailureDetailSource,
    failure_reason: Option<FailureReason>,
) -> CliFailureMessage {
    CliFailureMessage {
        message: message.to_string(),
        source,
        failure_reason,
    }
}

fn classify_cli_failure_reason(
    framework: AgentFramework,
    failure_message: &str,
) -> Option<FailureReason> {
    // Existing direct classifier tests model messages selected from stderr.
    super::classify_cli_failure_reason(framework, FailureDetailSource::Stderr, failure_message)
}

const CLAUDE_PROVIDER_SERVER_ERROR_MESSAGE: &str = "API Error: 500 Internal server error. This is a server-side issue, usually temporary - try again in a moment. If it persists, check https://status.claude.com.";
const CLAUDE_MID_RESPONSE_SERVER_ERROR_MESSAGE: &str =
    "API Error: Server error mid-response. The response above may be incomplete.";
const CLAUDE_MID_RESPONSE_CONNECTION_LOST_MESSAGE: &str =
    "API Error: Connection lost mid-response. The response above may be incomplete.";

#[test]
fn cli_failure_message_logs_stderr_to_system_log() {
    let _system_log_state_guard = crate::lock_system_log_test_state();
    let tmp = tempfile::tempdir().unwrap();
    let system_log_path = tmp.path().join("system.log");
    let _system_log_guard = SystemLogOverrideGuard::set(&system_log_path);

    let long_line = format!("{}tail", "x".repeat(MAX_LOGGED_CLI_STDERR_LINE_BYTES + 1));
    let stderr_lines = ["prefix line 0".to_string(), "prefix line 1".to_string()]
        .into_iter()
        .chain(std::iter::once("codex stderr includes ***".to_string()))
        .chain(std::iter::once(long_line.clone()))
        .chain((0..(MAX_LOGGED_CLI_STDERR_LINES - 2)).map(|i| format!("extra line {i}")))
        .collect::<Vec<_>>();
    let msg = cli_failure_message(1, &stderr_lines, None);
    assert_eq!(msg.source, FailureDetailSource::Stderr);
    assert!(
        !msg.message.contains("prefix line"),
        "returned error message should omit older stderr lines"
    );
    assert!(
        msg.message.contains("codex stderr includes ***"),
        "returned error message should preserve stderr"
    );
    assert!(
        msg.message.contains("...[truncated]"),
        "returned error message should truncate long stderr lines"
    );
    assert!(
        !msg.message.contains("tail"),
        "returned error message should not include bytes after the truncation boundary"
    );
    assert!(
        msg.message
            .contains("...[omitted 2 earlier stderr line(s)]"),
        "returned error message should report omitted earlier stderr lines"
    );

    let system_log = std::fs::read_to_string(&system_log_path).unwrap();
    assert!(
        system_log.contains("Captured 22 stderr lines"),
        "system log should include stderr count, got: {system_log}"
    );
    assert!(
        !system_log.contains("prefix line"),
        "system log should omit older stderr lines"
    );
    assert!(
        system_log.contains("CLI stderr: codex stderr includes ***"),
        "system log should include CLI stderr, got: {system_log}"
    );
    assert!(
        system_log.contains("...[truncated]"),
        "system log should truncate long stderr lines, got: {system_log}"
    );
    assert!(
        !system_log.contains("tail"),
        "system log should not include bytes after the truncation boundary"
    );
    assert!(
        system_log.contains("CLI stderr: omitted 2 earlier line(s)"),
        "system log should report omitted earlier stderr lines, got: {system_log}"
    );
}

#[test]
fn cli_failure_message_preserves_exact_limits_without_omission() {
    let _system_log_state_guard = crate::lock_system_log_test_state();
    let tmp = tempfile::tempdir().unwrap();
    let system_log_path = tmp.path().join("system.log");
    let _system_log_guard = SystemLogOverrideGuard::set(&system_log_path);

    let exact_limit_line = "x".repeat(MAX_LOGGED_CLI_STDERR_LINE_BYTES);
    let stderr_lines = std::iter::once(exact_limit_line.clone())
        .chain((1..MAX_LOGGED_CLI_STDERR_LINES).map(|i| format!("line {i}")))
        .collect::<Vec<_>>();

    let msg = cli_failure_message(1, &stderr_lines, None);
    assert_eq!(msg.source, FailureDetailSource::Stderr);
    assert!(
        msg.message.contains(&exact_limit_line),
        "returned error message should preserve line at exact size limit"
    );
    assert!(
        !msg.message.contains("...[truncated]"),
        "returned error message should not truncate line at exact size limit"
    );
    assert!(
        !msg.message.contains("omitted"),
        "returned error message should not report omitted lines at exact line limit"
    );

    let system_log = std::fs::read_to_string(&system_log_path).unwrap();
    assert!(
        system_log.contains("Captured 20 stderr lines"),
        "system log should include stderr count, got: {system_log}"
    );
    assert!(
        !system_log.contains("omitted"),
        "system log should not report omitted lines at exact line limit"
    );
}

#[test]
fn cli_failure_message_truncates_on_utf8_boundary() {
    let _system_log_state_guard = crate::lock_system_log_test_state();
    let tmp = tempfile::tempdir().unwrap();
    let system_log_path = tmp.path().join("system.log");
    let _system_log_guard = SystemLogOverrideGuard::set(&system_log_path);

    let prefix = "x".repeat(MAX_LOGGED_CLI_STDERR_LINE_BYTES - 1);
    let stderr_line = format!("{prefix}é-tail");
    let msg = cli_failure_message(1, &[stderr_line], None);
    assert_eq!(msg.source, FailureDetailSource::Stderr);

    assert!(
        msg.message.contains(&prefix),
        "returned error message should preserve bytes before the truncation boundary"
    );
    assert!(
        msg.message.contains("...[truncated]"),
        "returned error message should indicate truncation"
    );
    assert!(
        !msg.message.contains("é-tail"),
        "returned error message should not split or include the over-boundary character"
    );

    let system_log = std::fs::read_to_string(&system_log_path).unwrap();
    assert!(
        system_log.contains("...[truncated]"),
        "system log should indicate truncation, got: {system_log}"
    );
    assert!(
        !system_log.contains("é-tail"),
        "system log should not split or include the over-boundary character"
    );
}

#[test]
fn cli_failure_message_prefers_codex_failure_diagnostic() {
    let stderr_lines = vec!["background task noise".to_string()];
    let msg = cli_failure_message(
        1,
        &stderr_lines,
        Some(&cli_diagnostic(
            "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.",
            FailureDetailSource::CodexJsonl,
        )),
    );

    assert_eq!(msg.source, FailureDetailSource::CodexJsonl);
    assert_eq!(
        msg.message,
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits."
    );
}

#[test]
fn cli_failure_message_uses_stderr_over_generic_codex_failure_diagnostic() {
    let stderr_lines = vec!["specific stderr failure".to_string()];
    for diagnostic_message in [
        "turn failed",
        "Turn failed.",
        "Unknown error",
        "codex error",
    ] {
        let diagnostic = cli_diagnostic(diagnostic_message, FailureDetailSource::CodexJsonl);
        let msg = cli_failure_message(1, &stderr_lines, Some(&diagnostic));

        assert_eq!(
            msg.source,
            FailureDetailSource::Stderr,
            "diagnostic message: {diagnostic_message}"
        );
        assert_eq!(msg.message, "specific stderr failure");
    }
}

#[test]
fn cli_failure_message_preserves_structured_reason_with_stderr_message() {
    let stderr_lines = vec!["specific stderr failure".to_string()];
    let diagnostic = cli::CliFailureDiagnostic {
        message: "turn failed".to_string(),
        source: FailureDetailSource::CodexJsonl,
        failure_reason: Some(FailureReason::InvalidApiKey),
    };
    let msg = cli_failure_message(1, &stderr_lines, Some(&diagnostic));

    assert_eq!(msg.source, FailureDetailSource::Stderr);
    assert_eq!(msg.message, "specific stderr failure");
    assert_eq!(msg.failure_reason, Some(FailureReason::InvalidApiKey));
}

#[test]
fn cli_failure_reason_uses_selected_stderr_over_generic_diagnostic() {
    let _system_log_state_guard = crate::lock_system_log_test_state();
    let tmp = tempfile::tempdir().unwrap();
    let system_log_path = tmp.path().join("system.log");
    let _system_log_guard = SystemLogOverrideGuard::set(&system_log_path);
    let stderr_lines = vec![
        "API Error: 402 Insufficient credits. Add credits or configure your own API key to continue."
            .to_string(),
    ];
    let generic_diagnostic = cli_diagnostic("turn failed", FailureDetailSource::CodexJsonl);
    let msg = cli_failure_message(1, &stderr_lines, Some(&generic_diagnostic));
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(msg.source);
    let diagnostic = with_cli_failure_reason(diagnostic, &msg);

    assert_eq!(msg.source, FailureDetailSource::Stderr);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::InsufficientCredits)
    );
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::Stderr)
    );
}

#[test]
fn cli_failure_message_uses_generic_codex_failure_diagnostic_without_stderr() {
    let diagnostic = cli_diagnostic("turn failed", FailureDetailSource::CodexJsonl);
    let msg = cli_failure_message(1, &[], Some(&diagnostic));

    assert_eq!(msg.source, FailureDetailSource::CodexJsonl);
    assert_eq!(msg.message, "turn failed");
}

#[test]
fn cli_failure_message_prefers_claude_result_diagnostic() {
    let stderr_lines = vec!["background task noise".to_string()];
    let diagnostic = cli_diagnostic(
        "permission denied while running command",
        FailureDetailSource::ClaudeResult,
    );
    let msg = cli_failure_message(1, &stderr_lines, Some(&diagnostic));

    assert_eq!(msg.source, FailureDetailSource::ClaudeResult);
    assert_eq!(msg.message, "permission denied while running command");
}

#[test]
fn cli_failure_message_uses_stderr_over_generic_claude_result() {
    let stderr_lines = vec!["specific stderr failure".to_string()];
    let diagnostic = cli_diagnostic("error", FailureDetailSource::ClaudeResult);
    let msg = cli_failure_message(1, &stderr_lines, Some(&diagnostic));

    assert_eq!(msg.source, FailureDetailSource::Stderr);
    assert_eq!(msg.message, "specific stderr failure");
}

#[test]
fn cli_failure_message_does_not_apply_codex_generic_messages_to_claude_result() {
    let stderr_lines = vec!["background task noise".to_string()];
    let diagnostic = cli_diagnostic("Unknown error", FailureDetailSource::ClaudeResult);
    let msg = cli_failure_message(1, &stderr_lines, Some(&diagnostic));

    assert_eq!(msg.source, FailureDetailSource::ClaudeResult);
    assert_eq!(msg.message, "Unknown error");
}

#[test]
fn cli_failure_message_marks_exit_code_fallback_source() {
    let msg = cli_failure_message(7, &[], None);

    assert_eq!(msg.source, FailureDetailSource::FallbackExitCode);
    assert_eq!(msg.message, "Agent exited with code 7");
}

#[test]
fn cli_failure_reason_classifies_insufficient_credits() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "API Error: 402 Insufficient credits. Add credits or configure your own API key to continue.",
    );

    assert_eq!(reason, Some(FailureReason::InsufficientCredits));
}

#[test]
fn cli_failure_reason_classifies_provider_credit_affordability_error() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "API Error: 402 This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 1600. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account",
    );

    assert_eq!(reason, Some(FailureReason::ProviderInsufficientCredits));
}

#[test]
fn cli_failure_reason_classifies_claude_result_credit_affordability_diagnostic() {
    let message = "API Error: 402 This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 1600. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account";
    let msg = cli_failure_message(
        1,
        &["background stderr noise".to_string()],
        Some(&cli_diagnostic(message, FailureDetailSource::ClaudeResult)),
    );
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(msg.source);
    let diagnostic = with_cli_failure_reason(diagnostic, &msg);

    assert_eq!(msg.source, FailureDetailSource::ClaudeResult);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::ProviderInsufficientCredits)
    );
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::ClaudeResult)
    );
}

#[test]
fn claude_balance_message_requires_exact_failed_result_source() {
    for (framework, source, message, expected) in [
        (
            AgentFramework::ClaudeCode,
            FailureDetailSource::ClaudeResult,
            "Credit balance is too low",
            Some(FailureReason::ProviderInsufficientCredits),
        ),
        (
            AgentFramework::ClaudeCode,
            FailureDetailSource::Stderr,
            "Credit balance is too low",
            None,
        ),
        (
            AgentFramework::Codex,
            FailureDetailSource::CodexJsonl,
            "Credit balance is too low",
            None,
        ),
        (
            AgentFramework::ClaudeCode,
            FailureDetailSource::ClaudeResult,
            "The tool printed Credit balance is too low",
            None,
        ),
        (
            AgentFramework::ClaudeCode,
            FailureDetailSource::ClaudeResult,
            "Credit balance is too low to explain this different error",
            None,
        ),
    ] {
        assert_eq!(
            super::classify_cli_failure_reason(framework, source, message),
            expected
        );
    }
}

#[test]
fn provider_billing_envelopes_require_terminal_api_error_evidence() {
    let bodies = [
        r#"{"error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please purchase credits."}}"#,
        r#"{"error":{"code":"insufficient_quota"}}"#,
        r#"{"error":{"code":402,"message":"Payment required"}}"#,
    ];
    for body in bodies {
        let message = format!("API Error: 400 {body}");
        for (framework, source) in [
            (
                AgentFramework::ClaudeCode,
                FailureDetailSource::ClaudeResult,
            ),
            (AgentFramework::Codex, FailureDetailSource::CodexJsonl),
            (AgentFramework::Pi, FailureDetailSource::PiResult),
        ] {
            assert_eq!(
                super::classify_cli_failure_reason(framework, source, &message),
                Some(FailureReason::ProviderInsufficientCredits),
            );
        }
        for (source, text) in [
            (FailureDetailSource::Stderr, message.clone()),
            (
                FailureDetailSource::ClaudeResult,
                format!("The tool printed: {message}"),
            ),
            (FailureDetailSource::ClaudeResult, body.to_owned()),
        ] {
            assert_eq!(
                super::classify_cli_failure_reason(AgentFramework::ClaudeCode, source, &text),
                None
            );
        }
    }
}

#[test]
fn cli_failure_reason_classifies_deepseek_insufficient_credits_envelope() {
    let message = r#"unexpected status 402 Payment Required: {"error": "insufficient_credits", "message": "Insufficient credits. Add credits or configure your own API key to continue.", "permission": "model-provider:deepseek", "base": "https://api.deepseek.com/responses"}, url: https://api.deepseek.com/responses"#;
    let failure_message = selected_failure_message(message, FailureDetailSource::CodexJsonl, None);
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(failure_message.source);
    let diagnostic = with_cli_failure_reason(diagnostic, &failure_message);

    assert_eq!(failure_message.message, message);
    assert_eq!(diagnostic.failure_class, FailureClass::CliNonzero);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::InsufficientCredits)
    );
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::CodexJsonl)
    );
}

#[test]
fn cli_failure_reason_ignores_generic_402_error() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "API Error: 402 Payment Required",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_unverified_insufficient_credits_envelopes() {
    for message in [
        r#"unexpected status 402 Payment Required: {"error":"payment_required","message":"insufficient_credits"}"#,
        r#"unexpected status 402 Payment Required: {"debug":{"error":"insufficient_credits"}}"#,
        r#"provider response: {"error":"insufficient_credits"}"#,
        r#"provider response: {"error":"insufficient_credits"}; later request returned 402 Payment Required"#,
        r#"unexpected status 402 Payment Required: {"error":"payment_required"}; trailing {"error":"insufficient_credits"}"#,
        r#"unexpected status 402 Payment Required: {invalid {"error":"insufficient_credits"}"#,
    ] {
        let reason = classify_cli_failure_reason(AgentFramework::Codex, message);

        assert_eq!(reason, None, "message: {message}");
    }
}

#[test]
fn cli_failure_reason_classifies_claude_invalid_credentials() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "Failed to authenticate. API Error: 401 Invalid authentication credentials",
    );

    assert_eq!(reason, Some(FailureReason::InvalidCredentials));
}

#[test]
fn cli_failure_reason_ignores_generic_claude_401() {
    let reason = classify_cli_failure_reason(AgentFramework::ClaudeCode, "401 unauthorized");

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_classifies_claude_terms_acceptance_required() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "API Error: 400 We've updated our Consumer Terms and Privacy Policy. You'll need to accept them in claude.ai with the email in /status to continue.",
    );

    assert_eq!(reason, Some(FailureReason::TermsAcceptanceRequired));
}

#[test]
fn cli_failure_reason_classifies_claude_terms_acceptance_wording_variant() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "api error: 400 PLEASE ACCEPT the updated PRIVACY POLICY and CONSUMER TERMS at CLAUDE.AI before continuing.",
    );

    assert_eq!(reason, Some(FailureReason::TermsAcceptanceRequired));
}

#[test]
fn cli_failure_reason_ignores_claude_terms_message_for_other_frameworks() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "API Error: 400 We've updated our Consumer Terms and Privacy Policy. Accept them in claude.ai to continue.",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_incomplete_claude_terms_messages() {
    for message in [
        "We've updated our Consumer Terms and Privacy Policy. Accept them in claude.ai.",
        "API Error: 400 We've updated our Service Terms and Privacy Policy. Accept them in claude.ai.",
        "API Error: 400 We've updated our Consumer Terms. Accept them in claude.ai.",
        "API Error: 400 We've updated our Consumer Terms and Privacy Policy. Review them in claude.ai.",
        "API Error: 400 We've updated our Consumer Terms and Privacy Policy. Accept them to continue.",
        "API Error: 400 request rejected by the provider",
        "API Error: 400-error Consumer Terms and Privacy Policy must be accepted at claude.ai.",
        "API Error: 4000 Consumer Terms and Privacy Policy must be accepted at claude.ai.",
    ] {
        let reason = classify_cli_failure_reason(AgentFramework::ClaudeCode, message);

        assert_eq!(reason, None, "message: {message}");
    }
}

#[test]
fn cli_failure_reason_classifies_claude_result_terms_acceptance_diagnostic() {
    let message = "API Error: 400 We've updated our Consumer Terms and Privacy Policy. You'll need to accept them in claude.ai with the email in /status to continue.";
    let msg = cli_failure_message(
        1,
        &["background stderr noise".to_string()],
        Some(&cli_diagnostic(message, FailureDetailSource::ClaudeResult)),
    );
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(msg.source);
    let diagnostic = with_cli_failure_reason(diagnostic, &msg);

    assert_eq!(msg.source, FailureDetailSource::ClaudeResult);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::TermsAcceptanceRequired)
    );
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::ClaudeResult)
    );
}

#[test]
fn cli_failure_reason_classifies_claude_provider_overloaded() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "API Error: 529 Overloaded. This is a server-side issue, usually temporary - try again in a moment.",
    );

    assert_eq!(reason, Some(FailureReason::ProviderOverloaded));
}

#[test]
fn cli_failure_reason_classifies_claude_repeated_529_provider_overloaded() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "API Error: Repeated 529 Overloaded errors. The API is at capacity - this is usually temporary.",
    );

    assert_eq!(reason, Some(FailureReason::ProviderOverloaded));
}

#[test]
fn cli_failure_reason_classifies_claude_result_provider_overloaded_diagnostic() {
    let message = "API Error: 529 Overloaded. This is a server-side issue, usually temporary - try again in a moment.";
    let msg = cli_failure_message(
        1,
        &["background stderr noise".to_string()],
        Some(&cli_diagnostic(message, FailureDetailSource::ClaudeResult)),
    );
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(msg.source);
    let diagnostic = with_cli_failure_reason(diagnostic, &msg);

    assert_eq!(msg.source, FailureDetailSource::ClaudeResult);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::ProviderOverloaded)
    );
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::ClaudeResult)
    );
}

#[test]
fn cli_failure_reason_classifies_claude_result_repeated_529_provider_overloaded_diagnostic() {
    let message = "API Error: Repeated 529 Overloaded errors. The API is at capacity - this is usually temporary.";
    let msg = cli_failure_message(
        1,
        &["background stderr noise".to_string()],
        Some(&cli_diagnostic(message, FailureDetailSource::ClaudeResult)),
    );
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(msg.source);
    let diagnostic = with_cli_failure_reason(diagnostic, &msg);

    assert_eq!(msg.source, FailureDetailSource::ClaudeResult);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::ProviderOverloaded)
    );
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::ClaudeResult)
    );
}

#[test]
fn cli_failure_reason_classifies_claude_result_simple_provider_overloaded() {
    let reason = super::classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        FailureDetailSource::ClaudeResult,
        "API Error: Overloaded",
    );

    assert_eq!(reason, Some(FailureReason::ProviderOverloaded));
}

#[test]
fn cli_failure_reason_classifies_claude_result_simple_provider_overloaded_diagnostic() {
    let message = "API Error: Overloaded";
    let msg = cli_failure_message(
        1,
        &["background stderr noise".to_string()],
        Some(&cli_diagnostic(message, FailureDetailSource::ClaudeResult)),
    );
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(msg.source);
    let diagnostic = with_cli_failure_reason(diagnostic, &msg);

    assert_eq!(msg.source, FailureDetailSource::ClaudeResult);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::ProviderOverloaded)
    );
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::ClaudeResult)
    );
}

#[test]
fn cli_failure_reason_ignores_simple_claude_overloaded_from_stderr() {
    let reason = super::classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        FailureDetailSource::Stderr,
        "API Error: Overloaded",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_classifies_claude_result_stream_idle_timeouts() {
    for message in [
        "API Error: Stream idle timeout - partial response received",
        "API Error: Stream idle timeout - no chunks received",
    ] {
        let reason = super::classify_cli_failure_reason(
            AgentFramework::ClaudeCode,
            FailureDetailSource::ClaudeResult,
            message,
        );

        assert_eq!(
            reason,
            Some(FailureReason::ProviderStreamTimeout),
            "message: {message}"
        );
    }
}

#[test]
fn cli_failure_reason_classifies_claude_result_stalled_mid_stream() {
    let reason = super::classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        FailureDetailSource::ClaudeResult,
        "API Error: Response stalled mid-stream. The response above may be incomplete.",
    );

    assert_eq!(reason, Some(FailureReason::ProviderStreamTimeout));
}

#[test]
fn cli_failure_reason_classifies_claude_result_stream_timeout_diagnostics() {
    for message in [
        "API Error: Stream idle timeout - partial response received",
        "API Error: Stream idle timeout - no chunks received",
        "API Error: Response stalled mid-stream. The response above may be incomplete.",
    ] {
        let msg = cli_failure_message(
            1,
            &["background stderr noise".to_string()],
            Some(&cli_diagnostic(message, FailureDetailSource::ClaudeResult)),
        );
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_cli_exit_code(1)
        .with_failure_detail_source(msg.source);
        let diagnostic = with_cli_failure_reason(diagnostic, &msg);

        assert_eq!(
            msg.source,
            FailureDetailSource::ClaudeResult,
            "message: {message}"
        );
        assert_eq!(
            diagnostic.failure_reason,
            Some(FailureReason::ProviderStreamTimeout),
            "message: {message}"
        );
        assert_eq!(
            diagnostic.failure_detail_source,
            Some(FailureDetailSource::ClaudeResult),
            "message: {message}"
        );
    }
}

#[test]
fn cli_failure_reason_ignores_claude_result_stream_timeout_messages_from_stderr() {
    for message in [
        "API Error: Stream idle timeout - partial response received",
        "API Error: Stream idle timeout - no chunks received",
        "API Error: Response stalled mid-stream. The response above may be incomplete.",
    ] {
        let reason = super::classify_cli_failure_reason(
            AgentFramework::ClaudeCode,
            FailureDetailSource::Stderr,
            message,
        );

        assert_eq!(reason, None, "message: {message}");
    }
}

#[test]
fn cli_failure_reason_ignores_non_claude_stream_timeout_messages() {
    for message in [
        "API Error: Stream idle timeout - partial response received",
        "API Error: Stream idle timeout - no chunks received",
        "API Error: Response stalled mid-stream. The response above may be incomplete.",
    ] {
        let reason = super::classify_cli_failure_reason(
            AgentFramework::Codex,
            FailureDetailSource::ClaudeResult,
            message,
        );

        assert_eq!(reason, None, "message: {message}");
    }
}

#[test]
fn cli_failure_reason_ignores_unrecognized_claude_timeouts() {
    for message in [
        "API Error: request timed out",
        "API Error: Stream idle timeout - connection reset",
    ] {
        let reason = super::classify_cli_failure_reason(
            AgentFramework::ClaudeCode,
            FailureDetailSource::ClaudeResult,
            message,
        );

        assert_eq!(reason, None, "message: {message}");
    }
}

#[test]
fn cli_failure_reason_ignores_explanatory_stream_timeout_text() {
    for message in [
        "Observed API Error: Stream idle timeout - partial response received in an earlier run",
        "Observed API Error: Stream idle timeout - no chunks received in an earlier run",
        "Observed API Error: Response stalled mid-stream. The response above may be incomplete in an earlier run",
    ] {
        let reason = super::classify_cli_failure_reason(
            AgentFramework::ClaudeCode,
            FailureDetailSource::ClaudeResult,
            message,
        );

        assert_eq!(reason, None, "message: {message}");
    }
}

#[test]
fn cli_failure_reason_classifies_claude_result_provider_server_error() {
    let reason = super::classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        FailureDetailSource::ClaudeResult,
        CLAUDE_PROVIDER_SERVER_ERROR_MESSAGE,
    );

    assert_eq!(reason, Some(FailureReason::ProviderServerError));
}

#[test]
fn cli_failure_reason_ignores_claude_provider_server_error_from_stderr() {
    let reason = super::classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        FailureDetailSource::Stderr,
        CLAUDE_PROVIDER_SERVER_ERROR_MESSAGE,
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_claude_provider_server_error_status_prefix() {
    let reason = super::classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        FailureDetailSource::ClaudeResult,
        "API Error: 5000 Internal server error. This is a server-side issue, usually temporary - try again in a moment.",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_classifies_claude_result_provider_server_error_diagnostic() {
    let msg = cli_failure_message(
        1,
        &["background stderr noise".to_string()],
        Some(&cli_diagnostic(
            CLAUDE_PROVIDER_SERVER_ERROR_MESSAGE,
            FailureDetailSource::ClaudeResult,
        )),
    );
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(msg.source);
    let diagnostic = with_cli_failure_reason(diagnostic, &msg);

    assert_eq!(msg.source, FailureDetailSource::ClaudeResult);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::ProviderServerError)
    );
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::ClaudeResult)
    );
}

#[test]
fn cli_failure_reason_classifies_claude_result_mid_response_failures() {
    for (message, expected_reason) in [
        (
            CLAUDE_MID_RESPONSE_SERVER_ERROR_MESSAGE,
            FailureReason::ProviderServerError,
        ),
        (
            CLAUDE_MID_RESPONSE_CONNECTION_LOST_MESSAGE,
            FailureReason::ResponseConnectionLost,
        ),
    ] {
        let reason = super::classify_cli_failure_reason(
            AgentFramework::ClaudeCode,
            FailureDetailSource::ClaudeResult,
            message,
        );

        assert_eq!(reason, Some(expected_reason), "message: {message}");
    }
}

#[test]
fn cli_failure_reason_classifies_claude_result_mid_response_diagnostics() {
    for (message, expected_reason) in [
        (
            CLAUDE_MID_RESPONSE_SERVER_ERROR_MESSAGE,
            FailureReason::ProviderServerError,
        ),
        (
            CLAUDE_MID_RESPONSE_CONNECTION_LOST_MESSAGE,
            FailureReason::ResponseConnectionLost,
        ),
    ] {
        let msg = cli_failure_message(
            1,
            &["background stderr noise".to_string()],
            Some(&cli_diagnostic(message, FailureDetailSource::ClaudeResult)),
        );
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_cli_exit_code(1)
        .with_failure_detail_source(msg.source);
        let diagnostic = with_cli_failure_reason(diagnostic, &msg);

        assert_eq!(msg.source, FailureDetailSource::ClaudeResult);
        assert_eq!(diagnostic.failure_reason, Some(expected_reason));
        assert_eq!(
            diagnostic.failure_detail_source,
            Some(FailureDetailSource::ClaudeResult)
        );
    }
}

#[test]
fn cli_failure_reason_rejects_untrusted_mid_response_failure_contexts() {
    for message in [
        CLAUDE_MID_RESPONSE_SERVER_ERROR_MESSAGE,
        CLAUDE_MID_RESPONSE_CONNECTION_LOST_MESSAGE,
    ] {
        for (framework, source) in [
            (AgentFramework::ClaudeCode, FailureDetailSource::Stderr),
            (AgentFramework::Codex, FailureDetailSource::ClaudeResult),
            (AgentFramework::Pi, FailureDetailSource::PiResult),
        ] {
            let reason = super::classify_cli_failure_reason(framework, source, message);

            assert_eq!(reason, None, "message: {message}");
        }

        let explanatory_message = format!("Observed {message} in an earlier run");
        let reason = super::classify_cli_failure_reason(
            AgentFramework::ClaudeCode,
            FailureDetailSource::ClaudeResult,
            &explanatory_message,
        );

        assert_eq!(reason, None, "message: {explanatory_message}");
    }
}

#[test]
fn cli_failure_reason_classifies_pi_provider_http_unavailability() {
    for (message, expected_reason) in [
        (
            "provider HTTP 503: no healthy upstream",
            FailureReason::ProviderServerError,
        ),
        (
            "provider HTTP 502: Service Unavailable",
            FailureReason::ProviderServerError,
        ),
        ("provider HTTP 500", FailureReason::ProviderServerError),
        (
            "provider HTTP 504: upstream request timeout",
            FailureReason::ProviderServerError,
        ),
        (
            "provider HTTP 529: overloaded",
            FailureReason::ProviderOverloaded,
        ),
        // The public Responses route prefixes the SDK status before the marker.
        (
            "503 provider HTTP 503: no healthy upstream",
            FailureReason::ProviderServerError,
        ),
    ] {
        let reason = super::classify_cli_failure_reason(
            AgentFramework::Pi,
            FailureDetailSource::PiResult,
            message,
        );

        assert_eq!(reason, Some(expected_reason), "message: {message}");
    }
}

#[test]
fn cli_failure_reason_classifies_pi_upstream_non_api_response_by_observed_status() {
    for (status, expected_reason) in [
        (429, Some(FailureReason::ProviderRateLimited)),
        (500, Some(FailureReason::ProviderServerError)),
        (502, Some(FailureReason::ProviderServerError)),
        (529, Some(FailureReason::ProviderOverloaded)),
        // A client-side status is not an expected upstream condition, so it
        // stays unclassified and keeps its error-level report.
        (403, None),
        (404, None),
    ] {
        let message = format!(
            "upstream_non_api_response status={status} content_type=html bytes=4711 digest=1a2b3c4d"
        );

        let reason = super::classify_cli_failure_reason(
            AgentFramework::Pi,
            FailureDetailSource::PiResult,
            &message,
        );

        assert_eq!(reason, expected_reason, "message: {message}");
    }
}

#[test]
fn cli_failure_reason_rejects_untrusted_pi_provider_http_contexts() {
    const MESSAGE: &str = "provider HTTP 503: no healthy upstream";

    for (framework, source) in [
        (AgentFramework::Pi, FailureDetailSource::Stderr),
        (AgentFramework::ClaudeCode, FailureDetailSource::PiResult),
        (AgentFramework::Codex, FailureDetailSource::PiResult),
    ] {
        let reason = super::classify_cli_failure_reason(framework, source, MESSAGE);

        assert_eq!(reason, None, "framework: {framework:?} source: {source:?}");
    }

    for message in [
        // A status this boundary deliberately leaves to message-shaped rules.
        "provider HTTP 401: unauthorized",
        "provider HTTP 402: payment required",
        "provider HTTP 429: slow down",
        // Malformed or embedded markers must not be read as a status.
        "provider HTTP 5031: no healthy upstream",
        "provider HTTP 503_beta: no healthy upstream",
        "provider HTTP : no healthy upstream",
        "the tool printed provider HTTP",
        "xprovider HTTP 503: no healthy upstream",
        "no healthy upstream",
    ] {
        let reason = super::classify_cli_failure_reason(
            AgentFramework::Pi,
            FailureDetailSource::PiResult,
            message,
        );

        assert_eq!(reason, None, "message: {message}");
    }
}

#[test]
fn cli_failure_reason_rejects_pi_upstream_status_without_runtime_evidence() {
    for message in [
        // The guest-side fallback never observed the transport.
        "upstream_non_api_response status=unknown content_type=unknown bytes=4711 digest=1a2b3c4d",
        // Model prose must never be read as a transport status.
        "The upstream returned status=502 to my request",
        "API Error: Overloaded",
    ] {
        let reason = super::classify_cli_failure_reason(
            AgentFramework::Pi,
            FailureDetailSource::PiResult,
            message,
        );

        assert_eq!(reason, None, "message: {message}");
    }

    // Only the Pi result boundary produces this marker.
    let marker =
        "upstream_non_api_response status=502 content_type=html bytes=4711 digest=1a2b3c4d";
    for (framework, source) in [
        (AgentFramework::Pi, FailureDetailSource::Stderr),
        (
            AgentFramework::ClaudeCode,
            FailureDetailSource::ClaudeResult,
        ),
        (AgentFramework::Codex, FailureDetailSource::CodexJsonl),
    ] {
        assert_eq!(
            super::classify_cli_failure_reason(framework, source, marker),
            None
        );
    }
}

#[test]
fn cli_failure_reason_keeps_quota_wording_authoritative_over_pi_provider_http() {
    let reason = super::classify_cli_failure_reason(
        AgentFramework::Pi,
        FailureDetailSource::PiResult,
        "provider HTTP 503: You have hit your ChatGPT usage limit.",
    );

    assert_eq!(reason, Some(FailureReason::UsageLimit));
}

#[test]
fn pi_provider_http_failure_reaches_the_structured_diagnostic() {
    let msg = cli_failure_message(
        1,
        &["background stderr noise".to_string()],
        Some(&cli_diagnostic(
            "provider HTTP 503: no healthy upstream",
            FailureDetailSource::PiResult,
        )),
    );
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Pi,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(msg.source);
    let diagnostic = with_cli_failure_reason(diagnostic, &msg);

    assert_eq!(msg.source, FailureDetailSource::PiResult);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::ProviderServerError)
    );
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::PiResult)
    );
}

#[test]
fn cli_failure_reason_classifies_claude_output_token_limit() {
    for message in [
        "API Error: Claude's response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.",
        "API Error: Claude's response exceeded the 64000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.",
        "API Error: Claude's response exceeded the maximum output tokens for this model.",
        "API Error: Claude's response exceeded the maximum output token limit for this model.",
        "API Error: Claude's response exceeds the output token limit for this model.",
        "API Error: Claude's response has exceeded the max output token budget.",
    ] {
        let reason = classify_cli_failure_reason(AgentFramework::ClaudeCode, message);

        assert_eq!(
            reason,
            Some(FailureReason::OutputTokenLimit),
            "message: {message}"
        );
    }
}

#[test]
fn cli_failure_reason_classifies_claude_result_output_token_limit_diagnostic() {
    let message = "API Error: Claude's response exceeded the 64000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.";
    let msg = cli_failure_message(
        1,
        &["background stderr noise".to_string()],
        Some(&cli_diagnostic(message, FailureDetailSource::ClaudeResult)),
    );
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(msg.source);
    let diagnostic = with_cli_failure_reason(diagnostic, &msg);

    assert_eq!(msg.source, FailureDetailSource::ClaudeResult);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::OutputTokenLimit)
    );
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::ClaudeResult)
    );
}

#[test]
fn cli_failure_reason_ignores_non_claude_output_token_limit() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "API Error: Claude's response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_unrelated_claude_output_token_limit_text() {
    for message in [
        "API Error: Claude's context window exceeded the available token budget.",
        "API Error: Claude's response used 32000 tokens before the request completed.",
        "Set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable to configure responses.",
    ] {
        let reason = classify_cli_failure_reason(AgentFramework::ClaudeCode, message);

        assert_eq!(reason, None, "message: {message}");
    }
}

#[test]
fn cli_failure_reason_ignores_codex_provider_overloaded_text() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "API Error: 529 Overloaded. This is a server-side issue, usually temporary - try again in a moment.",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_classifies_trusted_codex_rate_limit_retry_exhaustion() {
    for message in [
        "exceeded retry limit, last status: 429 Too Many Requests",
        "Codex failed: exceeded retry limit, last status: 429 Too Many Requests, request id: req_123",
    ] {
        let reason = super::classify_cli_failure_reason(
            AgentFramework::Codex,
            FailureDetailSource::CodexJsonl,
            message,
        );

        assert_eq!(
            reason,
            Some(FailureReason::ProviderRateLimited),
            "message: {message}"
        );
    }
}

#[test]
fn cli_failure_reason_rejects_untrusted_codex_rate_limit_retry_exhaustion() {
    let signature = "exceeded retry limit, last status: 429 Too Many Requests";

    for (framework, source) in [
        (AgentFramework::Codex, FailureDetailSource::Stderr),
        (AgentFramework::ClaudeCode, FailureDetailSource::CodexJsonl),
    ] {
        let reason = super::classify_cli_failure_reason(framework, source, signature);

        assert_eq!(reason, None, "framework: {framework:?}, source: {source:?}");
    }
}

#[test]
fn codex_rate_limit_reason_is_attached_without_changing_failure_class() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(FailureDetailSource::CodexJsonl);
    let failure_message = selected_failure_message(
        "exceeded retry limit, last status: 429 Too Many Requests, request id: req_123",
        FailureDetailSource::CodexJsonl,
        None,
    );

    let diagnostic = with_cli_failure_reason(diagnostic, &failure_message);

    assert_eq!(diagnostic.failure_class, FailureClass::CliNonzero);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::ProviderRateLimited)
    );
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::CodexJsonl)
    );
}

#[test]
fn cli_failure_reason_classifies_exact_codex_unsupported_model_envelope() {
    let message = r#"Codex failed: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."}}"#;

    assert_eq!(
        super::classify_cli_failure_reason(
            AgentFramework::Codex,
            FailureDetailSource::Stderr,
            message,
        ),
        Some(FailureReason::UnsupportedModel)
    );
}

#[test]
fn cli_failure_reason_rejects_untrusted_or_near_miss_unsupported_model_envelopes() {
    const EXACT_MESSAGE: &str =
        "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.";
    let cases = [
        (
            AgentFramework::ClaudeCode,
            FailureDetailSource::Stderr,
            format!(
                r#"{{"type":"error","status":400,"error":{{"type":"invalid_request_error","message":"{EXACT_MESSAGE}"}}}}"#
            ),
        ),
        (
            AgentFramework::Codex,
            FailureDetailSource::CodexJsonl,
            format!(
                r#"{{"type":"error","status":400,"error":{{"type":"invalid_request_error","message":"{EXACT_MESSAGE}"}}}}"#
            ),
        ),
        (
            AgentFramework::Codex,
            FailureDetailSource::Stderr,
            format!(
                r#"{{"type":"error","status":401,"error":{{"type":"invalid_request_error","message":"{EXACT_MESSAGE}"}}}}"#
            ),
        ),
        (
            AgentFramework::Codex,
            FailureDetailSource::Stderr,
            format!(
                r#"{{"type":"error","status":400,"error":{{"type":"unsupported_model","message":"{EXACT_MESSAGE}"}}}}"#
            ),
        ),
        (
            AgentFramework::Codex,
            FailureDetailSource::Stderr,
            r#"{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account"}}"#.to_string(),
        ),
        (
            AgentFramework::Codex,
            FailureDetailSource::Stderr,
            EXACT_MESSAGE.to_string(),
        ),
        (
            AgentFramework::Codex,
            FailureDetailSource::Stderr,
            "{malformed".to_string(),
        ),
    ];

    for (framework, source, message) in cases {
        assert_eq!(
            super::classify_cli_failure_reason(framework, source, &message),
            None,
            "framework: {framework:?}, source: {source:?}, message: {message}"
        );
    }
}

#[test]
fn cli_failure_reason_classifies_codex_model_capacity() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "Selected model is at capacity. Please try a different model.",
    );

    assert_eq!(reason, Some(FailureReason::ProviderOverloaded));
}

#[test]
fn cli_failure_reason_classifies_wrapped_codex_model_capacity() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "Codex failed: Selected model is at capacity. Please try a different model.",
    );

    assert_eq!(reason, Some(FailureReason::ProviderOverloaded));
}

#[test]
fn cli_failure_reason_ignores_non_codex_model_capacity() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "Selected model is at capacity. Please try a different model.",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_classifies_codex_context_window_exceeded() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
    );

    assert_eq!(reason, Some(FailureReason::ContextWindowExceeded));
}

#[test]
fn cli_failure_reason_ignores_non_codex_context_window_exceeded() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_generic_claude_529() {
    let reason =
        classify_cli_failure_reason(AgentFramework::ClaudeCode, "API Error: 529 upstream failed");

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_classifies_later_claude_provider_overloaded() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "API Error: 529 upstream failed. Background retry failed: API Error: 529 Overloaded.",
    );

    assert_eq!(reason, Some(FailureReason::ProviderOverloaded));
}

#[test]
fn cli_failure_reason_classifies_claude_provider_overloaded_error_type() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        r#"API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"The service is overloaded"}}"#,
    );

    assert_eq!(reason, Some(FailureReason::ProviderOverloaded));
}

#[test]
fn cli_failure_reason_ignores_negated_claude_overloaded_text() {
    let reason =
        classify_cli_failure_reason(AgentFramework::ClaudeCode, "API Error: 529 not overloaded");

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_prefixed_claude_overloaded_error_type() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        r#"API Error: 529 {"type":"error","error":{"type":"not_overloaded_error"}}"#,
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_claude_overloaded_prefix_word() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "API Error: 529 overloadedness check failed",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_repeated_claude_529_false_overloaded_text() {
    for message in [
        "API Error: Repeated 529 not overloaded errors.",
        "API Error: Repeated 529 overloadedness check failed.",
    ] {
        let reason = classify_cli_failure_reason(AgentFramework::ClaudeCode, message);

        assert_eq!(reason, None, "message: {message}");
    }
}

#[test]
fn cli_failure_reason_ignores_claude_overloaded_without_529() {
    let reason =
        classify_cli_failure_reason(AgentFramework::ClaudeCode, "API Error: 503 Overloaded");

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_classifies_codex_usage_limit() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.",
    );

    assert_eq!(reason, Some(FailureReason::UsageLimit));
}

#[test]
fn cli_failure_reason_classifies_codex_quota_exceeded_as_usage_limit() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "Quota exceeded. Check your plan and billing details.",
    );

    assert_eq!(reason, Some(FailureReason::UsageLimit));
}

#[test]
fn cli_failure_reason_classifies_codex_session_limit() {
    for message in [
        "You've hit your session limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits. Resets 12:50pm (Asia/Shanghai).",
        "SESSION LIMIT reached. Please try again after the reset window.",
    ] {
        let reason = classify_cli_failure_reason(AgentFramework::Codex, message);

        assert_eq!(
            reason,
            Some(FailureReason::UsageLimit),
            "message: {message}"
        );
    }
}

#[test]
fn cli_failure_reason_classifies_codex_invalid_api_key_code() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "OpenAI API request failed: invalid_api_key",
    );

    assert_eq!(reason, Some(FailureReason::InvalidApiKey));
}

#[test]
fn cli_failure_reason_classifies_codex_incorrect_api_key_message() {
    let reason =
        classify_cli_failure_reason(AgentFramework::Codex, "Incorrect API key provided: sk-...");

    assert_eq!(reason, Some(FailureReason::InvalidApiKey));
}

#[test]
fn cli_failure_reason_ignores_generic_codex_401() {
    let reason = classify_cli_failure_reason(AgentFramework::Codex, "401 unauthorized");

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_classifies_exact_codex_safety_policy_refusal() {
    let reason = super::classify_cli_failure_reason(
        AgentFramework::Codex,
        FailureDetailSource::CodexJsonl,
        CODEX_SAFETY_POLICY_REFUSAL_MESSAGE,
    );

    assert_eq!(reason, Some(FailureReason::SafetyPolicyRefusal));
}

#[test]
fn cli_failure_reason_does_not_broadly_classify_safety_policy_text() {
    for message in [
        "policy violation",
        "security risk",
        "This content was flagged for possible cybersecurity risk.",
        "This request was refused by a content policy.",
    ] {
        let reason = super::classify_cli_failure_reason(
            AgentFramework::Codex,
            FailureDetailSource::CodexJsonl,
            message,
        );

        assert_eq!(reason, None, "message: {message}");
    }

    assert_eq!(
        super::classify_cli_failure_reason(
            AgentFramework::Codex,
            FailureDetailSource::Stderr,
            CODEX_SAFETY_POLICY_REFUSAL_MESSAGE,
        ),
        None
    );
    assert_eq!(
        super::classify_cli_failure_reason(
            AgentFramework::ClaudeCode,
            FailureDetailSource::CodexJsonl,
            CODEX_SAFETY_POLICY_REFUSAL_MESSAGE,
        ),
        None
    );
}

#[test]
fn cli_failure_reason_classifies_codex_content_policy_rejection_envelope() {
    for message in [
        r#"{"error":{"message":"Content Exists Risk","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}"#,
        r#"unexpected status 400 Bad Request: {"error":{"message":"Content Exists Risk","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}, url: https://api.example.com/responses"#,
        r#"{"error":{"message":"  Content Exists Risk  ","type":"invalid_request_error","code":"invalid_request_error"}}"#,
    ] {
        let reason = super::classify_cli_failure_reason(
            AgentFramework::Codex,
            FailureDetailSource::CodexJsonl,
            message,
        );

        assert_eq!(
            reason,
            Some(FailureReason::SafetyPolicyRefusal),
            "message: {message}"
        );
    }
}

#[test]
fn cli_failure_reason_keeps_other_invalid_request_errors_unclassified() {
    for message in [
        // Real request-shape defects share the `invalid_request_error` type and
        // must keep their actionable unclassified failure.
        r#"{"error":{"message":"Invalid Format","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}"#,
        r#"{"error":{"message":"Input token length too long","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}"#,
        // Same phrase, different envelope shape or missing fields.
        r#"{"error":{"message":"Content Exists Risk","type":"invalid_request_error"}}"#,
        r#"{"error":{"message":"Content Exists Risk","type":"content_filter","code":"content_filter"}}"#,
        r#"{"detail":"Content Exists Risk"}"#,
        "the provider reported Content Exists Risk for this request",
    ] {
        let reason = super::classify_cli_failure_reason(
            AgentFramework::Codex,
            FailureDetailSource::CodexJsonl,
            message,
        );

        assert_eq!(reason, None, "message: {message}");
    }
}

#[test]
fn cli_failure_reason_scopes_content_policy_rejection_to_codex_jsonl() {
    const ENVELOPE: &str = r#"{"error":{"message":"Content Exists Risk","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}"#;

    assert_eq!(
        super::classify_cli_failure_reason(
            AgentFramework::Codex,
            FailureDetailSource::Stderr,
            ENVELOPE,
        ),
        None
    );
    assert_eq!(
        super::classify_cli_failure_reason(
            AgentFramework::ClaudeCode,
            FailureDetailSource::CodexJsonl,
            ENVELOPE,
        ),
        None
    );
}

#[test]
fn cli_failure_reason_classifies_codex_oauth_reconnect_required() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        r#"unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token expired and refresh failed for: codex-oauth-token. The connector may need to be reconnected.","permission":"model-provider:codex-oauth-token","base":"https://chatgpt.com/backend-api/codex","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}, url: https://chatgpt.com/backend-api/codex/responses"#,
    );

    assert_eq!(reason, Some(FailureReason::ReconnectRequired));
}

#[test]
fn cli_failure_reason_classifies_codex_oauth_reconnect_required_envelope() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        r#"unexpected status 502 Bad Gateway: {"error":{"message":"Access token expired and refresh failed for: codex-oauth-token.","code":"TOKEN_REFRESH_FAILED","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}}"#,
    );

    assert_eq!(reason, Some(FailureReason::ReconnectRequired));
}

#[test]
fn cli_failure_reason_classifies_codex_oauth_reconnect_required_after_metadata() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        r#"request metadata {"traceId":"abc","status":502}: {"error":"TOKEN_REFRESH_FAILED","message":"Access token expired and refresh failed for: codex-oauth-token.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}, url: https://chatgpt.com/backend-api/codex/responses"#,
    );

    assert_eq!(reason, Some(FailureReason::ReconnectRequired));
}

#[test]
fn cli_failure_reason_classifies_codex_oauth_reconnect_required_after_template_brace() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        r#"request template {response_id: {"error":"TOKEN_REFRESH_FAILED","message":"Refresh failed for {codex} token.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}, url: https://chatgpt.com/backend-api/codex/responses"#,
    );

    assert_eq!(reason, Some(FailureReason::ReconnectRequired));
}

#[test]
fn cli_failure_reason_ignores_codex_oauth_upstream_provider() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        r#"unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token refresh failed for: codex-oauth-token after reconnect_required state.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"],"failureReason":"upstream_provider"}, url: https://chatgpt.com/backend-api/codex/responses"#,
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_codex_oauth_refresh_without_failure_reason() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        r#"unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token refresh failed for: codex-oauth-token.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"]}, url: https://chatgpt.com/backend-api/codex/responses"#,
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_non_codex_oauth_reconnect_required() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        r#"unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token expired and refresh failed for: zendesk.","permission":"connector:zendesk","connectors":["zendesk"],"failureReason":"reconnect_required"}, url: https://example.zendesk.com/api/v2/tickets"#,
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_codex_oauth_multi_connector_reconnect_required() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        r#"unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token expired and refresh failed for: notion, codex-oauth-token.","connectors":["notion","codex-oauth-token"],"failureReason":"reconnect_required"}, url: https://chatgpt.com/backend-api/codex/responses"#,
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_nested_codex_oauth_reconnect_required_payload() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        r#"unexpected status 502 Bad Gateway: {"debug":{"error":"TOKEN_REFRESH_FAILED","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}}"#,
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_prefers_message_classification_over_carried_reason() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("debug failure"),
    )
    .with_cli_exit_code(1);
    let failure_message = selected_failure_message(
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage.",
        FailureDetailSource::Stderr,
        Some(FailureReason::InvalidApiKey),
    );
    let diagnostic = with_cli_failure_reason(diagnostic, &failure_message);

    assert_eq!(diagnostic.failure_reason, Some(FailureReason::UsageLimit));
}

#[test]
fn cli_failure_reason_preserves_structured_safety_policy_refusal() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("debug failure"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(FailureDetailSource::CodexJsonl);
    let failure_message = selected_failure_message(
        "This request was refused by the provider.",
        FailureDetailSource::CodexJsonl,
        Some(FailureReason::SafetyPolicyRefusal),
    );
    let diagnostic = with_cli_failure_reason(diagnostic, &failure_message);

    assert_eq!(diagnostic.failure_class, FailureClass::CliNonzero);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::SafetyPolicyRefusal)
    );
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::CodexJsonl)
    );
}

#[test]
fn cli_failure_reason_ignores_non_codex_invalid_api_key_text() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "OpenAI API request failed: invalid_api_key",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_classifies_claude_usage_limit() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "Claude usage limit reached. Visit https://claude.ai/settings/usage.",
    );

    assert_eq!(reason, Some(FailureReason::UsageLimit));
}

#[test]
fn cli_failure_reason_classifies_claude_subscription_access_disabled_as_usage_limit() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access",
    );

    assert_eq!(reason, Some(FailureReason::UsageLimit));
}

#[test]
fn cli_failure_reason_classifies_claude_session_limit() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "You've hit your session limit · resets 12:50pm (Asia/Shanghai)",
    );

    assert_eq!(reason, Some(FailureReason::UsageLimit));
}

#[test]
fn cli_failure_reason_classifies_claude_weekly_limit() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "You've hit your weekly limit · resets 10am (Asia/Shanghai)",
    );

    assert_eq!(reason, Some(FailureReason::UsageLimit));
}

#[test]
fn cli_failure_reason_classifies_claude_monthly_spend_limit() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage",
    );

    assert_eq!(reason, Some(FailureReason::UsageLimit));
}

#[test]
fn cli_failure_reason_ignores_codex_monthly_spend_limit_text() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_unrelated_failures() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "permission denied while running command",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_leaves_unrelated_diagnostic_unchanged() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(2)
    .with_failure_detail_source(FailureDetailSource::Stderr);
    let failure_message = selected_failure_message(
        "permission denied while running command",
        FailureDetailSource::Stderr,
        None,
    );
    let unchanged = with_cli_failure_reason(diagnostic.clone(), &failure_message);

    assert_eq!(unchanged, diagnostic);
}

#[test]
fn cli_failure_reason_is_attached_without_changing_failure_class() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(FailureDetailSource::CodexJsonl);
    let failure_message = selected_failure_message(
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage.",
        FailureDetailSource::CodexJsonl,
        None,
    );
    let diagnostic = with_cli_failure_reason(diagnostic, &failure_message);

    assert_eq!(diagnostic.failure_class, FailureClass::CliNonzero);
    assert_eq!(diagnostic.failure_reason, Some(FailureReason::UsageLimit));
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::CodexJsonl)
    );
}

#[test]
fn cli_termination_is_attached_without_changing_failure_reason() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(143)
    .with_failure_reason(FailureReason::ProviderOverloaded);
    let termination = CliTerminationDiagnostic::new(CliTerminationReason::PostResultReap)
        .record_signal(CliTerminationSignal::Sigterm, Some(1401), Some(10_000))
        .with_observed_exit_code(143);

    let with_termination = with_cli_termination(diagnostic.clone(), Some(termination));
    let unchanged = with_cli_termination(diagnostic.clone(), None);

    assert_eq!(with_termination.failure_class, FailureClass::CliNonzero);
    assert_eq!(
        with_termination.failure_reason,
        Some(FailureReason::ProviderOverloaded)
    );
    assert_eq!(with_termination.cli_termination, Some(termination));
    assert_eq!(unchanged, diagnostic);
}

#[test]
fn execution_timeout_termination_sets_authoritative_failure_reason() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliExecutionError,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(124)
    .with_failure_reason(FailureReason::ProviderOverloaded);
    let termination = CliTerminationDiagnostic::new(CliTerminationReason::ExecutionTimeout);

    let with_termination = with_cli_termination(diagnostic, Some(termination));

    assert_eq!(
        with_termination.failure_class,
        FailureClass::CliExecutionError
    );
    assert_eq!(
        with_termination.failure_reason,
        Some(FailureReason::ExecutionTimeout)
    );
    assert_eq!(with_termination.cli_termination, Some(termination));
}

#[test]
fn cli_observed_exit_is_attached_without_changing_failure_reason() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(137)
    .with_failure_reason(FailureReason::ProviderOverloaded);
    let observed_exit = CliObservedExitDiagnostic::from_signal(libc::SIGKILL);

    let with_observed_exit =
        with_cli_observed_exit(diagnostic.clone(), Some(observed_exit.clone()));
    let unchanged = with_cli_observed_exit(diagnostic.clone(), None);

    assert_eq!(with_observed_exit.failure_class, FailureClass::CliNonzero);
    assert_eq!(
        with_observed_exit.failure_reason,
        Some(FailureReason::ProviderOverloaded)
    );
    assert_eq!(with_observed_exit.cli_observed_exit, Some(observed_exit));
    assert_eq!(unchanged, diagnostic);
}

#[test]
fn pi_memory_phase2_terminal_diagnostics_survive_guest_error_persistence() {
    let _system_log_state_guard = crate::lock_system_log_test_state();
    let tmp = tempfile::tempdir().unwrap();
    let system_log_path = tmp.path().join("system.log");
    let _system_log_guard = SystemLogOverrideGuard::set(&system_log_path);
    let fixtures: Vec<Value> = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/pi-memory-phase2-terminal.json"
    )))
    .unwrap();
    for fixture in fixtures {
        let stderr = fixture["stderr"].as_str().unwrap();
        let failure = cli_failure_message(1, &[stderr.to_owned()], None);
        assert_eq!(failure.message, stderr);
        assert_eq!(failure.source, FailureDetailSource::Stderr);
        assert_eq!(
            classify_cli_failure_reason(AgentFramework::Pi, &failure.message),
            None
        );
        let diagnostic = with_cli_failure_reason(
            FailureDiagnostic::new(
                FailureClass::CliNonzero,
                AgentFramework::Pi,
                PromptMetadata::from_prompt(""),
            )
            .with_cli_exit_code(1)
            .with_failure_detail_source(failure.source),
            &failure,
        );
        let encoded = serde_json::to_string(&diagnostic).unwrap();
        let decoded: FailureDiagnostic = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.failure_class, FailureClass::CliNonzero);
        assert_eq!(decoded.failure_reason, None);
        let error_path = tmp.path().join("guest-error.txt");
        write_guest_error_file(error_path.to_str().unwrap(), &failure.message);
        assert_eq!(std::fs::read_to_string(error_path).unwrap(), stderr);
        let log = std::fs::read_to_string(&system_log_path).unwrap();
        assert!(log.contains(stderr));
        assert!(!log.contains("PRIVATE_"));
    }
}

const PI_MEMORY_RECALL_DIAGNOSTIC_LINE: &str = concat!(
    r#"{"type":"pi_memory_recall_outcome","runId":"run-1","mode":"sandbox","#,
    r#""status":"miss","parity":"frozen-no-content","reason":"frozen-no-content","#,
    r#""injectedTokenCount":0}"#
);

#[test]
fn cli_failure_message_reports_the_termination_line_without_memory_diagnostics() {
    let _system_log_state_guard = crate::lock_system_log_test_state();
    let tmp = tempfile::tempdir().unwrap();
    let system_log_path = tmp.path().join("system.log");
    let _system_log_guard = SystemLogOverrideGuard::set(&system_log_path);

    let stderr_lines = vec![
        PI_MEMORY_RECALL_DIAGNOSTIC_LINE.to_string(),
        "Killed".to_string(),
    ];
    let msg = cli_failure_message(137, &stderr_lines, None);

    assert_eq!(msg.source, FailureDetailSource::Stderr);
    assert_eq!(msg.message, "Killed");
    assert!(!msg.message.contains("pi_memory_recall_outcome"));

    let system_log = std::fs::read_to_string(&system_log_path).unwrap();
    assert!(
        system_log.contains("pi_memory_recall_outcome"),
        "the structured diagnostic must stay in the guest log"
    );
}

#[test]
fn cli_failure_message_keeps_a_real_error_alongside_memory_diagnostics() {
    let stderr_lines = vec![
        PI_MEMORY_RECALL_DIAGNOSTIC_LINE.to_string(),
        "TypeError: cannot read properties of undefined".to_string(),
    ];
    let msg = cli_failure_message(1, &stderr_lines, None);

    assert_eq!(msg.source, FailureDetailSource::Stderr);
    assert_eq!(
        msg.message,
        "TypeError: cannot read properties of undefined"
    );
}

#[test]
fn cli_failure_message_falls_back_when_only_memory_diagnostics_remain() {
    let _system_log_state_guard = crate::lock_system_log_test_state();
    let tmp = tempfile::tempdir().unwrap();
    let system_log_path = tmp.path().join("system.log");
    let _system_log_guard = SystemLogOverrideGuard::set(&system_log_path);

    let stderr_lines = vec![
        PI_MEMORY_RECALL_DIAGNOSTIC_LINE.to_string(),
        r#"{"type":"pi_memory_tool_source_use","runId":"run-1","sessionId":"s-1"}"#.to_string(),
    ];
    let msg = cli_failure_message(137, &stderr_lines, None);

    assert_eq!(msg.source, FailureDetailSource::FallbackExitCode);
    assert_eq!(msg.message, "Agent exited with code 137");

    let system_log = std::fs::read_to_string(&system_log_path).unwrap();
    assert!(system_log.contains("pi_memory_tool_source_use"));
}

#[test]
fn cli_failure_message_preserves_agent_output_that_is_not_a_known_diagnostic() {
    for line in [
        r#"{"type":"user_output","message":"build failed"}"#,
        r#"{"error":"boom"}"#,
        r#"{"type":42}"#,
        "{not json}",
        r#"["pi_memory_recall_outcome"]"#,
        r#"prefix {"type":"pi_memory_recall_outcome"}"#,
    ] {
        let stderr_lines = vec![line.to_string()];
        let msg = cli_failure_message(1, &stderr_lines, None);

        assert_eq!(
            msg.source,
            FailureDetailSource::Stderr,
            "line must stay user visible: {line}"
        );
        assert_eq!(msg.message, line);
    }
}

#[test]
fn cli_failure_message_keeps_an_incomplete_diagnostic_envelope_visible() {
    // A cut-off envelope is no longer parseable. It must stay visible rather
    // than silently removing the only failure detail the user would see.
    let incomplete = r#"{"type":"pi_memory_recall_outcome","runId":"run-1""#;
    let stderr_lines = vec![incomplete.to_string()];
    let msg = cli_failure_message(137, &stderr_lines, None);

    assert_eq!(msg.source, FailureDetailSource::Stderr);
    assert_eq!(msg.message, incomplete);
}

#[test]
fn cli_failure_message_drops_a_long_diagnostic_envelope_before_display_truncation() {
    let long_diagnostic = format!(
        r#"{{"type":"pi_memory_recall_outcome","runId":"{}"}}"#,
        "x".repeat(MAX_LOGGED_CLI_STDERR_LINE_BYTES)
    );
    let stderr_lines = vec![long_diagnostic, "Killed".to_string()];
    let msg = cli_failure_message(137, &stderr_lines, None);

    assert_eq!(msg.source, FailureDetailSource::Stderr);
    assert_eq!(msg.message, "Killed");
}
