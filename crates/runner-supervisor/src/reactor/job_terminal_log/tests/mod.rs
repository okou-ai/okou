use super::*;
use std::time::Duration;

use guest_contracts::diagnostics::{
    AgentFramework, CliObservedExitKind, CliTerminationDiagnostic, CliTerminationReason,
    CliTerminationSignal, EventDeliveryActiveAttemptDiagnostic, EventDeliveryActiveBatchDiagnostic,
    EventDeliveryDiagnostic, EventDeliveryDrainTimeoutDiagnostic,
    EventDeliveryFailedBatchDiagnostic, EventDeliveryResponseState, FailureClass,
    FailureDetailSource, HeartbeatFailedCycleDiagnostic, HeartbeatFailureDiagnostic,
    HttpAttemptFailureKind, HttpCompletedAttemptDiagnostic, PromptMetadata, SessionHistoryStatus,
    WorkloadResourceLimitDiagnostic,
};
use tracing::Level;
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

fn job_failure_diagnostic(failure_reason: Option<FailureReason>) -> FailureDiagnostic {
    let mut diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(FailureDetailSource::CodexJsonl)
    .with_session_history_status(SessionHistoryStatus::NotApplicable);
    if let Some(reason) = failure_reason {
        diagnostic = diagnostic.with_failure_reason(reason);
    }
    diagnostic
}

#[test]
fn cli_terminal_diagnostics_remain_actionable() {
    let fixtures: Vec<String> = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/cli-terminal-stderr.json"
    )))
    .unwrap();
    for fixture in fixtures {
        let message = fixture.as_str();
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::Pi,
            PromptMetadata::from_prompt(""),
        )
        .with_cli_exit_code(1)
        .with_failure_detail_source(FailureDetailSource::Stderr);
        let wire = serde_json::to_vec(&diagnostic).unwrap();
        let decoded: FailureDiagnostic = serde_json::from_slice(&wire).unwrap();
        let failure = executor::ExecutionFailure::new(1, message, Some(decoded));
        let event = capture_job_failure_log(&failure);
        assert_eq!(event.level, Level::ERROR);
        assert_field_eq(&event, "message", "job execution failed");
        assert_field_eq(&event, "error", message);
        assert_field_eq(&event, "failure_framework", "pi");
        assert_field_eq(&event, "failure_class", "cli_nonzero");
        assert_field_eq(&event, "failure_detail_source", "stderr");
    }
}

fn post_result_cli_termination() -> CliTerminationDiagnostic {
    CliTerminationDiagnostic::new(CliTerminationReason::PostResultReap)
        .record_signal(CliTerminationSignal::Sigterm, Some(1401), Some(10_000))
        .with_observed_exit_code(143)
}

fn capture_terminal_job_log(
    exit_code: i32,
    reused: bool,
    cancelled: bool,
    failure: Option<&executor::ExecutionFailure>,
) -> CapturedEvent {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    tracing::subscriber::with_default(subscriber, || {
        log_terminal_job_outcome(
            RunId::from(uuid::Uuid::nil()),
            exit_code,
            reused,
            cancelled,
            failure,
            4096,
        );
    });
    let events = captured.entries();
    assert_eq!(events.len(), 1, "captured events: {events:#?}");
    events[0].clone()
}

fn capture_job_failure_log(failure: &executor::ExecutionFailure) -> CapturedEvent {
    capture_terminal_job_log(failure.exit_code, false, false, Some(failure))
}

fn assert_field_eq(event: &CapturedEvent, field: &str, expected: &str) {
    let value = event
        .fields
        .get(field)
        .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"));
    assert_eq!(value, expected, "field {field} mismatch; event={event:#?}");
}

fn assert_field_kind(event: &CapturedEvent, field: &str, expected: &str) {
    let kind = event
        .field_kinds
        .get(field)
        .unwrap_or_else(|| panic!("missing field kind {field}; event={event:#?}"));
    assert_eq!(
        kind, &expected,
        "field {field} kind mismatch; event={event:#?}"
    );
}

fn assert_shared_failure_log_fields(generic: &CapturedEvent, timeout: &CapturedEvent) {
    let mut generic_fields = generic.fields.clone();
    let mut timeout_fields = timeout.fields.clone();
    generic_fields.remove("message");
    timeout_fields.remove("message");

    let mut generic_field_kinds = generic.field_kinds.clone();
    let mut timeout_field_kinds = timeout.field_kinds.clone();
    generic_field_kinds.remove("message");
    timeout_field_kinds.remove("message");

    for timeout_field in ["timeout_ms", "elapsed_ms", "guest_duration_ms"] {
        assert!(!generic_fields.contains_key(timeout_field));
        assert!(!generic_field_kinds.contains_key(timeout_field));
        assert!(timeout_fields.remove(timeout_field).is_some());
        assert!(timeout_field_kinds.remove(timeout_field).is_some());
    }

    assert_eq!(generic_fields, timeout_fields);
    assert_eq!(generic_field_kinds, timeout_field_kinds);
}

#[test]
fn terminal_failure_emits_a_bounded_causal_tail_only_for_long_errors() {
    let cause = "HTTP status 403 s3_code=ExpiredRequest";
    let error = format!("{}\n{cause}", "中".repeat(3000));
    let failure = executor::ExecutionFailure::new(1, &error, None);

    let event = capture_job_failure_log(&failure);

    assert_field_eq(&event, "message", "job execution failed");
    assert_field_eq(&event, "error", &error);
    assert_field_kind(&event, "error_tail", "str");
    let tail = event.fields.get("error_tail").expect("missing causal tail");
    assert!(tail.len() <= 4096);
    assert!(tail.ends_with(cause));
    assert!(error.ends_with(tail));

    for error in ["short failure".to_owned(), "x".repeat(4096)] {
        let failure = executor::ExecutionFailure::new(1, &error, None);
        let event = capture_job_failure_log(&failure);
        assert_field_eq(&event, "error", &error);
        assert!(!event.fields.contains_key("error_tail"));
    }
}

#[test]
fn finished_and_cancelled_jobs_emit_one_terminal_event() {
    let finished = capture_terminal_job_log(0, true, false, None);

    assert_eq!(finished.level, Level::INFO);
    assert_eq!(
        finished.fields.get("message").map(String::as_str),
        Some("job finished")
    );
    assert_field_eq(
        &finished,
        "run_id",
        &RunId::from(uuid::Uuid::nil()).to_string(),
    );
    assert_field_eq(&finished, "exit_code", "0");
    assert_field_eq(&finished, "reused", "true");
    assert!(!finished.fields.contains_key("error"));

    let failure = executor::ExecutionFailure::new(1, "ignored failure", None);
    let cancelled = capture_terminal_job_log(130, false, true, Some(&failure));

    assert_eq!(cancelled.level, Level::INFO);
    assert_eq!(
        cancelled.fields.get("message").map(String::as_str),
        Some("job cancelled")
    );
    assert_field_eq(
        &cancelled,
        "run_id",
        &RunId::from(uuid::Uuid::nil()).to_string(),
    );
    assert_field_eq(&cancelled, "exit_code", "130");
    assert_field_eq(&cancelled, "reused", "false");
    assert!(!cancelled.fields.contains_key("error"));
}

#[test]
fn expected_cli_failure_reasons_log_job_execution_failed_at_info() {
    for reason in [
        FailureReason::InsufficientCredits,
        FailureReason::ProviderInsufficientCredits,
        FailureReason::InvalidApiKey,
        FailureReason::InvalidCredentials,
        FailureReason::TermsAcceptanceRequired,
        FailureReason::AccountVerificationRequired,
        FailureReason::ContextWindowExceeded,
        FailureReason::ProviderImageTooLarge,
        FailureReason::OutputTokenLimit,
        FailureReason::ProviderRateLimited,
        FailureReason::ProviderOverloaded,
        FailureReason::ProviderStreamTimeout,
        FailureReason::ProviderQueueTimeout,
        FailureReason::ProviderServerError,
        FailureReason::ResponseConnectionLost,
        FailureReason::SafetyPolicyRefusal,
        FailureReason::ReconnectRequired,
        FailureReason::CodexAccessProgramUnavailable,
        FailureReason::UnsupportedModel,
        FailureReason::UsageLimit,
    ] {
        let diagnostic = job_failure_diagnostic(Some(reason));
        let failure_error = format!("classified failure: {}", reason.as_str());
        let failure = executor::ExecutionFailure::new(1, failure_error.clone(), Some(diagnostic));

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::INFO);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("job execution failed")
        );
        assert_field_eq(&event, "error", &failure_error);
        assert_field_eq(
            &event,
            "run_id",
            &RunId::from(uuid::Uuid::nil()).to_string(),
        );
        assert_field_eq(&event, "exit_code", "1");
        assert_field_eq(&event, "failure_reason", reason.as_str());
        assert_field_eq(&event, "failure_class", "cli_nonzero");
        assert_field_eq(&event, "failure_framework", "codex");
        assert_field_eq(&event, "failure_detail_source", "codex_jsonl");
    }
}

#[test]
fn codex_content_policy_rejection_logs_job_execution_failed_at_info() {
    const ENVELOPE: &str = r#"{"error":{"message":"Content Exists Risk","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}"#;
    let diagnostic = job_failure_diagnostic(Some(FailureReason::SafetyPolicyRefusal));
    let failure = executor::ExecutionFailure::new(1, ENVELOPE, Some(diagnostic));

    let event = capture_job_failure_log(&failure);

    assert_eq!(event.level, Level::INFO);
    assert_field_eq(&event, "error", ENVELOPE);
    assert_field_eq(&event, "failure_reason", "safety_policy_refusal");
    assert_field_eq(&event, "failure_framework", "codex");
    assert_field_eq(&event, "failure_class", "cli_nonzero");
    assert_field_eq(&event, "failure_detail_source", "codex_jsonl");
}

#[test]
fn unclassified_codex_provider_envelope_stays_at_error() {
    let diagnostic = job_failure_diagnostic(None);
    let failure = executor::ExecutionFailure::new(
        1,
        r#"{"error":{"message":"Invalid Format","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}"#,
        Some(diagnostic),
    );

    let event = capture_job_failure_log(&failure);

    assert_eq!(event.level, Level::ERROR);
    assert!(!event.fields.contains_key("failure_reason"));
}

#[test]
fn codex_send_evidence_preserves_unknown_failure_severity_and_absent_transport_counts() {
    use guest_contracts::codex_failure::{
        CodexFailureEvidence, CodexFailureStage, CodexNativeFailureKind,
    };
    let mut diagnostic = job_failure_diagnostic(None);
    diagnostic.codex_failure = Some(CodexFailureEvidence {
        reported_stage: Some(CodexFailureStage::RequestSend),
        native_kind: Some(CodexNativeFailureKind::Other),
        http_status: None,
    });
    let failure = executor::ExecutionFailure::new(
        1,
        "stream disconnected before completion: error sending request",
        Some(diagnostic),
    );
    let event = capture_job_failure_log(&failure);
    assert_eq!(event.level, Level::ERROR);
    assert_field_eq(&event, "codex_reported_failure_stage", "request_send");
    assert_field_eq(&event, "codex_native_failure_kind", "other");
    for field in [
        "failure_reason",
        "codex_http_status",
        "model_http_status",
        "model_transport_attempts",
        "model_retry_attempts",
        "model_transport_cause_code",
    ] {
        assert!(!event.fields.contains_key(field), "{field}");
    }
}

#[test]
fn codex_native_response_evidence_logs_observed_status_without_inventing_attempts() {
    use guest_contracts::codex_failure::{
        CodexFailureEvidence, CodexFailureStage, CodexNativeFailureKind,
    };
    let mut diagnostic = job_failure_diagnostic(Some(FailureReason::ResponseConnectionLost));
    diagnostic.codex_failure = Some(CodexFailureEvidence {
        reported_stage: Some(CodexFailureStage::ResponseStream),
        native_kind: Some(CodexNativeFailureKind::ResponseStreamDisconnected),
        http_status: Some(200),
    });
    let failure =
        executor::ExecutionFailure::new(1, "response stream disconnected", Some(diagnostic));
    let event = capture_job_failure_log(&failure);
    assert_eq!(event.level, Level::INFO);
    assert_field_eq(&event, "failure_reason", "response_connection_lost");
    assert_field_eq(&event, "codex_reported_failure_stage", "response_stream");
    assert_field_eq(
        &event,
        "codex_native_failure_kind",
        "response_stream_disconnected",
    );
    assert_field_eq(&event, "codex_http_status", "200");
    assert!(!event.fields.contains_key("model_transport_attempts"));
    assert!(!event.fields.contains_key("model_retry_attempts"));
}

#[test]
fn oversized_codex_input_logs_cli_execution_failure_at_info() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliExecutionError,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("oversized prompt"),
    )
    .with_failure_reason(FailureReason::InputTooLarge)
    .with_session_history_status(SessionHistoryStatus::NotApplicable);
    let failure = executor::ExecutionFailure::new(
        1,
        "Codex input exceeded the app-server limit",
        Some(diagnostic),
    );

    let event = capture_job_failure_log(&failure);

    assert_eq!(event.level, Level::INFO);
    assert_field_eq(&event, "failure_class", "cli_execution_error");
    assert_field_eq(&event, "failure_framework", "codex");
    assert_field_eq(&event, "failure_reason", "input_too_large");
    assert!(!event.fields.contains_key("failure_detail_source"));
}

#[test]
fn oversized_input_near_misses_remain_error_level() {
    let diagnostics = [
        FailureDiagnostic::new(
            FailureClass::CliExecutionError,
            AgentFramework::Codex,
            PromptMetadata::from_prompt("plain prompt"),
        ),
        FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::Codex,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_failure_reason(FailureReason::InputTooLarge),
        FailureDiagnostic::new(
            FailureClass::CliExecutionError,
            AgentFramework::Codex,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_failure_reason(FailureReason::ContextWindowExceeded),
    ];

    for diagnostic in diagnostics {
        let failure =
            executor::ExecutionFailure::new(1, "unclassified execution failure", Some(diagnostic));
        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::ERROR);
    }
}

#[test]
fn pi_result_source_logs_pi_attribution() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Pi,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(FailureDetailSource::PiResult)
    .with_session_history_status(SessionHistoryStatus::NotApplicable);
    let failure = executor::ExecutionFailure::new(1, "provider failed", Some(diagnostic));

    let event = capture_job_failure_log(&failure);

    assert_eq!(event.level, Level::ERROR);
    assert_eq!(
        event.fields.get("message").map(String::as_str),
        Some("job execution failed")
    );
    assert_field_eq(&event, "failure_class", "cli_nonzero");
    assert_field_eq(&event, "failure_framework", "pi");
    assert_field_eq(&event, "failure_detail_source", "pi_result");
}

#[test]
fn pi_provider_rejections_remain_errors_with_original_request_evidence() {
    for (reason, status, error) in [
        (
            FailureReason::ProviderModelRestricted,
            404,
            "model policy refusal",
        ),
        (
            FailureReason::ProviderBadRequest,
            400,
            r#"{"detail":"Bad Request"}"#,
        ),
    ] {
        let mut diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::Pi,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_failure_reason(reason)
        .with_failure_detail_source(FailureDetailSource::PiResult)
        .with_cli_exit_code(1)
        .with_cli_observed_exit(CliObservedExitDiagnostic::from_exit_code(0));
        diagnostic.model_request = Some(guest_contracts::diagnostics::ModelRequestDiagnostic {
            http_status: Some(status),
            transport_attempts: 1,
            retry_attempts: 0,
            retry_limit: None,
            transport_failure: None,
        });
        let failure = executor::ExecutionFailure::new(1, error, Some(diagnostic));

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::ERROR);
        assert_field_eq(&event, "error", error);
        assert_field_eq(&event, "failure_reason", reason.as_str());
        assert_field_eq(&event, "failure_framework", "pi");
        assert_field_eq(&event, "exit_code", "1");
        assert_field_eq(&event, "failure_cli_exit_code", "1");
        assert_field_eq(&event, "cli_observed_exit_code", "0");
        assert_field_eq(&event, "model_http_status", &status.to_string());
        assert_field_eq(&event, "model_transport_attempts", "1");
        assert_field_eq(&event, "model_retry_attempts", "0");
    }
}

#[test]
fn pi_provider_failures_log_info_with_observed_request_and_retry_evidence() {
    for (reason, status, retries, retry_limit, message) in [
        (
            FailureReason::ProviderImageTooLarge,
            413,
            0,
            None,
            r#"413: {"message":"Downloaded image content cannot exceed 30MB","code":413,"metadata":{"provider_name":null}}"#,
        ),
        (
            FailureReason::ProviderRateLimited,
            429,
            3,
            Some(3),
            r#"{"detail":"Rate limit exceeded"}"#,
        ),
        (
            FailureReason::ProviderOverloaded,
            200,
            3,
            Some(3),
            "Codex error: Our servers are currently overloaded. Please try again later.",
        ),
        (
            FailureReason::SafetyPolicyRefusal,
            200,
            0,
            None,
            "Codex error: Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt: https://example.invalid/policy",
        ),
    ] {
        let mut diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::Pi,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_failure_reason(reason)
        .with_failure_detail_source(FailureDetailSource::PiResult)
        .with_cli_exit_code(1)
        .with_cli_observed_exit(CliObservedExitDiagnostic::from_exit_code(0));
        diagnostic.model_request = Some(guest_contracts::diagnostics::ModelRequestDiagnostic {
            http_status: Some(status),
            transport_attempts: 1,
            retry_attempts: retries,
            retry_limit,
            transport_failure: None,
        });
        let failure = executor::ExecutionFailure::new(1, message, Some(diagnostic));
        let event = capture_job_failure_log(&failure);
        assert_eq!(event.level, Level::INFO);
        assert_field_eq(&event, "failure_reason", reason.as_str());
        assert_field_eq(&event, "failure_framework", "pi");
        assert_field_eq(&event, "failure_class", "cli_nonzero");
        assert_field_eq(&event, "failure_detail_source", "pi_result");
        assert_field_eq(&event, "error", message);
        assert_field_eq(&event, "exit_code", "1");
        assert_field_eq(&event, "failure_cli_exit_code", "1");
        assert_field_eq(&event, "cli_observed_exit_code", "0");
        assert_field_eq(&event, "model_http_status", &status.to_string());
        assert_field_eq(&event, "model_transport_attempts", "1");
        assert_field_eq(&event, "model_retry_attempts", &retries.to_string());
        if let Some(limit) = retry_limit {
            assert_field_eq(&event, "model_retry_limit", &limit.to_string());
        } else {
            assert!(!event.fields.contains_key("model_retry_limit"));
        }
    }
}

#[test]
fn pi_disconnection_keeps_causal_evidence_in_the_existing_log_contract() {
    let message: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../../turbo/packages/pi-agent-runtime/src/test/fixtures/codex-stream-terminated.json"
        )).unwrap();
    let mut diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Pi,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_failure_reason(FailureReason::ResponseConnectionLost)
    .with_failure_detail_source(FailureDetailSource::PiResult);
    diagnostic.model_request =
        Some(serde_json::from_value(message["diagnostics"][0]["details"].clone()).unwrap());
    let failure = executor::ExecutionFailure::new(1, "terminated", Some(diagnostic));
    let event = capture_job_failure_log(&failure);
    assert_eq!(event.level, Level::INFO);
    assert_field_eq(&event, "model_http_status", "200");
    assert_field_eq(&event, "model_transport_failure_phase", "response_body");
    assert_field_eq(&event, "model_transport_signal_aborted", "false");
    assert_field_eq(&event, "model_transport_error_name", "TypeError");
    assert_field_eq(
        &event,
        "model_transport_cause_code",
        "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
    );
    assert!(!event.fields.contains_key("model_transport_error_code"));
}

#[test]
fn pi_result_upstream_server_error_logs_job_execution_failed_at_info() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Pi,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(FailureDetailSource::PiResult)
    .with_session_history_status(SessionHistoryStatus::NotApplicable)
    .with_failure_reason(FailureReason::ProviderServerError);
    let error = "upstream_non_api_response status=502 content_type=html bytes=4711 digest=1a2b3c4d";
    let failure = executor::ExecutionFailure::new(1, error, Some(diagnostic));

    let event = capture_job_failure_log(&failure);

    assert_eq!(event.level, Level::INFO);
    assert_field_eq(&event, "error", error);
    assert_field_eq(&event, "failure_reason", "provider_server_error");
    assert_field_eq(&event, "failure_framework", "pi");
    assert_field_eq(&event, "failure_detail_source", "pi_result");
}

#[test]
fn claude_result_provider_overloaded_logs_job_execution_failed_at_info() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(FailureDetailSource::ClaudeResult)
    .with_session_history_status(SessionHistoryStatus::Present)
    .with_failure_reason(FailureReason::ProviderOverloaded);
    let failure = executor::ExecutionFailure::new(1, "API Error: Overloaded", Some(diagnostic));

    let event = capture_job_failure_log(&failure);

    assert_eq!(event.level, Level::INFO);
    assert_eq!(
        event.fields.get("message").map(String::as_str),
        Some("job execution failed")
    );
    assert_field_eq(&event, "error", "API Error: Overloaded");
    assert_field_eq(&event, "failure_reason", "provider_overloaded");
    assert_field_eq(&event, "failure_class", "cli_nonzero");
    assert_field_eq(&event, "failure_framework", "claude_code");
    assert_field_eq(&event, "failure_detail_source", "claude_result");
}

#[test]
fn claude_result_provider_stream_timeout_logs_job_execution_failed_at_info() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(FailureDetailSource::ClaudeResult)
    .with_session_history_status(SessionHistoryStatus::Present)
    .with_failure_reason(FailureReason::ProviderStreamTimeout);
    let failure = executor::ExecutionFailure::new(
        1,
        "API Error: Stream idle timeout - no chunks received",
        Some(diagnostic),
    );

    let event = capture_job_failure_log(&failure);

    assert_eq!(event.level, Level::INFO);
    assert_eq!(
        event.fields.get("message").map(String::as_str),
        Some("job execution failed")
    );
    assert_field_eq(
        &event,
        "error",
        "API Error: Stream idle timeout - no chunks received",
    );
    assert_field_eq(&event, "failure_reason", "provider_stream_timeout");
    assert_field_eq(&event, "failure_class", "cli_nonzero");
    assert_field_eq(&event, "failure_framework", "claude_code");
    assert_field_eq(&event, "failure_detail_source", "claude_result");
}

#[test]
fn claude_result_mid_response_failures_log_structured_outcomes() {
    for (reason, error, expected_level) in [
        (
            FailureReason::ProviderServerError,
            "API Error: Server error mid-response. The response above may be incomplete.",
            Level::INFO,
        ),
        (
            FailureReason::ResponseConnectionLost,
            "API Error: Connection lost mid-response. The response above may be incomplete.",
            Level::INFO,
        ),
    ] {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_cli_exit_code(1)
        .with_cli_observed_exit(CliObservedExitDiagnostic::from_exit_code(1))
        .with_claude_num_turns(Some(48))
        .with_failure_detail_source(FailureDetailSource::ClaudeResult)
        .with_session_history_status(SessionHistoryStatus::Present)
        .with_failure_reason(reason);
        let failure = executor::ExecutionFailure::new(1, error, Some(diagnostic));

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, expected_level);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("job execution failed")
        );
        assert_field_eq(&event, "error", error);
        assert_field_eq(&event, "failure_reason", reason.as_str());
        assert_field_eq(&event, "failure_class", "cli_nonzero");
        assert_field_eq(&event, "failure_framework", "claude_code");
        assert_field_eq(&event, "failure_detail_source", "claude_result");
        assert_field_eq(&event, "failure_claude_num_turns", "48");
        assert_field_eq(&event, "cli_observed_exit_kind", "exit");
        assert_field_eq(&event, "cli_observed_exit_code", "1");
        assert!(!event.fields.contains_key("cli_termination_initiator"));
        assert!(!event.fields.contains_key("cli_termination_reason"));
        assert!(!event.fields.contains_key("cli_observed_signal_number"));
        assert!(!event.fields.contains_key("cli_observed_signal_name"));
    }
}

#[test]
fn claude_zero_turn_no_history_logs_job_execution_failed_at_info() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::ClaudeZeroTurnNoHistory,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("/help"),
    )
    .with_cli_exit_code(0)
    .with_claude_num_turns(Some(0))
    .with_session_history_status(SessionHistoryStatus::Missing);
    let failure = executor::ExecutionFailure::new(
        1,
        "Claude Code emitted a zero-turn result without creating session history; skipping history upload",
        Some(diagnostic),
    );

    let event = capture_job_failure_log(&failure);

    assert_eq!(event.level, Level::INFO);
    assert_eq!(
        event.fields.get("message").map(String::as_str),
        Some("job execution failed")
    );
    assert_field_eq(&event, "failure_class", "claude_zero_turn_no_history");
    assert_field_eq(&event, "session_history_status", "missing");
}

#[test]
fn info_level_reason_on_non_cli_failure_logs_job_execution_failed_at_error() {
    for reason in [
        FailureReason::ProviderImageTooLarge,
        FailureReason::InvalidApiKey,
        FailureReason::InvalidCredentials,
        FailureReason::TermsAcceptanceRequired,
        FailureReason::AccountVerificationRequired,
        FailureReason::ContextWindowExceeded,
        FailureReason::OutputTokenLimit,
        FailureReason::ProviderRateLimited,
        FailureReason::ProviderOverloaded,
        FailureReason::ProviderStreamTimeout,
        FailureReason::ProviderQueueTimeout,
        FailureReason::ProviderServerError,
        FailureReason::ResponseConnectionLost,
        FailureReason::SafetyPolicyRefusal,
        FailureReason::ReconnectRequired,
        FailureReason::CodexAccessProgramUnavailable,
        FailureReason::UnsupportedModel,
        FailureReason::UsageLimit,
    ] {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::FinalizationFailed,
            AgentFramework::Codex,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_failure_reason(reason);
        let failure = executor::ExecutionFailure::new(
            1,
            format!(
                "session history upload failed after {} event",
                reason.as_str()
            ),
            Some(diagnostic),
        );

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::ERROR);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("job execution failed")
        );
        assert_field_eq(&event, "failure_reason", reason.as_str());
        assert_field_eq(&event, "failure_class", "finalization_failed");
    }
}

#[test]
fn unclassified_diagnostic_failure_logs_job_execution_failed_at_error() {
    let diagnostic = job_failure_diagnostic(None);
    let failure = executor::ExecutionFailure::new(1, "permission denied", Some(diagnostic));

    let event = capture_job_failure_log(&failure);

    assert_eq!(event.level, Level::ERROR);
    assert_eq!(
        event.fields.get("message").map(String::as_str),
        Some("job execution failed")
    );
    assert!(!event.fields.contains_key("failure_reason"));
    assert!(!event.fields.contains_key("timeout_ms"));
    assert!(!event.fields.contains_key("cli_termination_reason"));
    assert!(!event.fields.contains_key("cli_observed_exit_kind"));
    assert!(!event.fields.contains_key("event_delivery_total_batches"));
}

#[test]
fn diagnostic_failure_logs_cli_termination_fields() {
    let diagnostic =
        job_failure_diagnostic(None).with_cli_termination(post_result_cli_termination());
    let failure =
        executor::ExecutionFailure::new(143, "Agent exited with code 143", Some(diagnostic));

    let event = capture_job_failure_log(&failure);

    assert_eq!(event.level, Level::ERROR);
    assert_eq!(
        event.fields.get("message").map(String::as_str),
        Some("job execution failed")
    );
    assert_field_eq(&event, "cli_termination_initiator", "guest_agent");
    assert_field_eq(&event, "cli_termination_reason", "post_result_reap");
    assert_field_eq(&event, "cli_termination_signal_sent", "sigterm");
    assert_field_eq(&event, "cli_termination_signal_pgid", "1401");
    assert_field_eq(&event, "cli_termination_signal_grace_ms", "10000");
    assert_field_eq(&event, "cli_termination_escalated", "false");
    assert_field_eq(&event, "cli_termination_observed_exit_code", "143");
}

#[test]
fn diagnostic_failure_logs_cli_observed_exit_fields() {
    let diagnostic = job_failure_diagnostic(None)
        .with_cli_exit_code(137)
        .with_cli_observed_exit(CliObservedExitDiagnostic::from_signal(libc::SIGKILL));
    let failure =
        executor::ExecutionFailure::new(137, "Agent exited with code 137", Some(diagnostic));

    let event = capture_job_failure_log(&failure);

    assert_eq!(event.level, Level::ERROR);
    assert_eq!(
        event.fields.get("message").map(String::as_str),
        Some("job execution failed")
    );
    assert_field_eq(&event, "failure_cli_exit_code", "137");
    assert_field_eq(&event, "cli_observed_exit_kind", "signal");
    assert!(!event.fields.contains_key("cli_observed_exit_code"));
    assert_field_eq(&event, "cli_observed_signal_number", "9");
    assert_field_eq(&event, "cli_observed_signal_name", "sigkill");
    assert_field_eq(&event, "cli_observed_mapped_exit_code", "137");
}

#[test]
fn diagnostic_failure_logs_cli_observed_normal_exit_fields() {
    let diagnostic = job_failure_diagnostic(None)
        .with_cli_exit_code(2)
        .with_cli_observed_exit(CliObservedExitDiagnostic::from_exit_code(2));
    let failure = executor::ExecutionFailure::new(2, "Agent exited with code 2", Some(diagnostic));

    let event = capture_job_failure_log(&failure);

    assert_field_eq(&event, "cli_observed_exit_kind", "exit");
    assert_field_eq(&event, "cli_observed_exit_code", "2");
    assert!(!event.fields.contains_key("cli_observed_signal_number"));
    assert!(!event.fields.contains_key("cli_observed_signal_name"));
    assert_field_eq(&event, "cli_observed_mapped_exit_code", "2");
}

#[test]
fn diagnostic_failure_logs_bounded_event_delivery_fields() {
    let failed_attempt = HttpCompletedAttemptDiagnostic {
        attempt: 4,
        client_request_id: "11111111-1111-4111-8111-111111111111".to_string(),
        elapsed_ms: 30_001,
        failure_kind: HttpAttemptFailureKind::HttpStatus,
        http_status: Some(500),
        timeout_observed: None,
        connect_observed: None,
    };
    let first_active_completed_attempt = HttpCompletedAttemptDiagnostic {
        attempt: 1,
        client_request_id: "33333333-3333-4333-8333-333333333333".to_string(),
        elapsed_ms: 1_001,
        ..failed_attempt.clone()
    };
    let second_active_completed_attempt = HttpCompletedAttemptDiagnostic {
        attempt: 2,
        client_request_id: "44444444-4444-4444-8444-444444444444".to_string(),
        elapsed_ms: 2_001,
        ..failed_attempt.clone()
    };
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("continue"),
    )
    .with_cli_exit_code(1)
    .with_event_delivery(EventDeliveryDiagnostic {
        total_events: 43,
        total_batches: 2,
        failed_batches: 1,
        last_acknowledged_sequence: Some(7),
        first_failed_batch: Some(EventDeliveryFailedBatchDiagnostic {
            first_sequence: 8,
            last_sequence: 18,
            event_count: 11,
            conservative_bytes: 2_048,
            response_state: EventDeliveryResponseState::AllHttpErrors,
            attempts: vec![failed_attempt.clone()],
        }),
        drain_timeout: Some(EventDeliveryDrainTimeoutDiagnostic {
            queued_events: 5,
            queued_bytes: 256,
            carried_events: 6,
            carried_bytes: 129,
            active_batch: Some(EventDeliveryActiveBatchDiagnostic {
                first_sequence: 19,
                last_sequence: 42,
                event_count: 24,
                conservative_bytes: 8_193,
                completed_attempts: vec![
                    first_active_completed_attempt,
                    second_active_completed_attempt,
                ],
                active_attempt: Some(EventDeliveryActiveAttemptDiagnostic {
                    attempt: 3,
                    client_request_id: "22222222-2222-4222-8222-222222222222".to_string(),
                    elapsed_ms: 4_001,
                }),
                response_state: EventDeliveryResponseState::Incomplete,
            }),
        }),
    });
    let failure = executor::ExecutionFailure::new(1, "Agent exited with code 1", Some(diagnostic));

    let event = capture_job_failure_log(&failure);

    assert_field_eq(&event, "event_delivery_total_events", "43");
    assert_field_eq(&event, "event_delivery_total_batches", "2");
    assert_field_eq(&event, "event_delivery_failed_batches", "1");
    assert_field_eq(&event, "event_delivery_last_acknowledged_sequence", "7");
    assert_field_eq(&event, "event_delivery_first_failure_first_sequence", "8");
    assert_field_eq(&event, "event_delivery_first_failure_last_sequence", "18");
    assert_field_eq(&event, "event_delivery_first_failure_event_count", "11");
    assert_field_eq(
        &event,
        "event_delivery_first_failure_conservative_bytes",
        "2048",
    );
    assert_field_eq(
        &event,
        "event_delivery_first_failure_response_state",
        "all_http_errors",
    );
    assert_field_eq(&event, "event_delivery_first_failure_attempt_count", "1");
    assert_field_eq(
        &event,
        "event_delivery_first_failure_final_attempt_number",
        "4",
    );
    assert_field_eq(
        &event,
        "event_delivery_first_failure_final_attempt_kind",
        "http_status",
    );
    assert!(
        !event
            .fields
            .contains_key("event_delivery_first_failure_final_attempt_timeout_observed")
    );
    assert!(
        !event
            .fields
            .contains_key("event_delivery_first_failure_final_attempt_connect_observed")
    );
    assert_field_eq(
        &event,
        "event_delivery_first_failure_final_attempt_http_status",
        "500",
    );
    assert_field_eq(
        &event,
        "event_delivery_first_failure_final_attempt_request_id",
        "11111111-1111-4111-8111-111111111111",
    );
    assert_field_eq(
        &event,
        "event_delivery_first_failure_final_attempt_elapsed_ms",
        "30001",
    );
    assert_field_eq(&event, "event_delivery_drain_timeout", "true");
    assert_field_eq(&event, "event_delivery_drain_queued_events", "5");
    assert_field_eq(&event, "event_delivery_drain_queued_bytes", "256");
    assert_field_eq(&event, "event_delivery_drain_carried_events", "6");
    assert_field_eq(&event, "event_delivery_drain_carried_bytes", "129");
    assert_field_eq(&event, "event_delivery_drain_active_first_sequence", "19");
    assert_field_eq(&event, "event_delivery_drain_active_last_sequence", "42");
    assert_field_eq(&event, "event_delivery_drain_active_event_count", "24");
    assert_field_eq(
        &event,
        "event_delivery_drain_active_conservative_bytes",
        "8193",
    );
    assert_field_eq(
        &event,
        "event_delivery_drain_active_completed_attempt_count",
        "2",
    );
    assert_field_eq(&event, "event_delivery_drain_active_attempt_number", "3");
    assert_field_eq(
        &event,
        "event_delivery_drain_active_attempt_request_id",
        "22222222-2222-4222-8222-222222222222",
    );
    assert_field_eq(
        &event,
        "event_delivery_drain_active_attempt_elapsed_ms",
        "4001",
    );
    assert_field_eq(
        &event,
        "event_delivery_drain_active_response_state",
        "incomplete",
    );
    for field in [
        "event_delivery_first_failure_event_count",
        "event_delivery_first_failure_attempt_count",
        "event_delivery_first_failure_final_attempt_number",
        "event_delivery_first_failure_final_attempt_elapsed_ms",
        "event_delivery_drain_queued_bytes",
        "event_delivery_drain_carried_bytes",
        "event_delivery_drain_active_last_sequence",
        "event_delivery_drain_active_event_count",
        "event_delivery_drain_active_conservative_bytes",
        "event_delivery_drain_active_completed_attempt_count",
        "event_delivery_drain_active_attempt_number",
    ] {
        assert_field_kind(&event, field, "u64");
    }
    assert!(!event.fields.contains_key("event_delivery_attempts"));
    assert!(!event.fields.contains_key("event_delivery_body"));
}

#[test]
fn diagnostic_failure_logs_bounded_heartbeat_fields() {
    let diagnostic = job_failure_diagnostic(None).with_heartbeat(HeartbeatFailureDiagnostic {
        failed_cycles: vec![
            HeartbeatFailedCycleDiagnostic {
                scheduled_lag_ms: 11,
                attempts: vec![HttpCompletedAttemptDiagnostic {
                    attempt: 1,
                    client_request_id: "11111111-1111-4111-8111-111111111111".to_string(),
                    elapsed_ms: 100,
                    failure_kind: HttpAttemptFailureKind::HttpStatus,
                    http_status: Some(503),
                    timeout_observed: None,
                    connect_observed: None,
                }],
            },
            HeartbeatFailedCycleDiagnostic {
                scheduled_lag_ms: 27,
                attempts: vec![
                    HttpCompletedAttemptDiagnostic {
                        attempt: 1,
                        client_request_id: "22222222-2222-4222-8222-222222222222".to_string(),
                        elapsed_ms: 30_000,
                        failure_kind: HttpAttemptFailureKind::Timeout,
                        http_status: None,
                        timeout_observed: Some(true),
                        connect_observed: Some(false),
                    },
                    HttpCompletedAttemptDiagnostic {
                        attempt: 2,
                        client_request_id: "33333333-3333-4333-8333-333333333333".to_string(),
                        elapsed_ms: 30_001,
                        failure_kind: HttpAttemptFailureKind::Timeout,
                        http_status: None,
                        timeout_observed: Some(true),
                        connect_observed: Some(false),
                    },
                ],
            },
        ],
    });
    let failure = executor::ExecutionFailure::new(1, "heartbeat failed", Some(diagnostic));

    let event = capture_job_failure_log(&failure);

    assert_field_eq(&event, "heartbeat_failed_cycle_count", "2");
    assert_field_eq(&event, "heartbeat_attempt_count", "3");
    assert_field_eq(&event, "heartbeat_final_scheduled_lag_ms", "27");
    assert_field_eq(&event, "heartbeat_final_attempt_number", "2");
    assert_field_eq(&event, "heartbeat_final_attempt_kind", "timeout");
    assert_field_eq(&event, "heartbeat_final_attempt_timeout_observed", "true");
    assert_field_eq(&event, "heartbeat_final_attempt_connect_observed", "false");
    assert!(
        !event
            .fields
            .contains_key("heartbeat_final_attempt_http_status")
    );
    assert_field_eq(
        &event,
        "heartbeat_final_attempt_request_id",
        "33333333-3333-4333-8333-333333333333",
    );
    assert_field_eq(&event, "heartbeat_final_attempt_elapsed_ms", "30001");
    assert!(!event.fields.contains_key("heartbeat_failed_cycles"));
}

#[test]
fn diagnostic_failure_logs_event_transport_observations() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("continue"),
    )
    .with_cli_exit_code(1)
    .with_event_delivery(EventDeliveryDiagnostic {
        total_events: 1,
        total_batches: 1,
        failed_batches: 1,
        last_acknowledged_sequence: None,
        first_failed_batch: Some(EventDeliveryFailedBatchDiagnostic {
            first_sequence: 0,
            last_sequence: 0,
            event_count: 1,
            conservative_bytes: 128,
            response_state: EventDeliveryResponseState::Incomplete,
            attempts: vec![HttpCompletedAttemptDiagnostic {
                attempt: 3,
                client_request_id: "11111111-1111-4111-8111-111111111111".to_string(),
                elapsed_ms: 10_000,
                failure_kind: HttpAttemptFailureKind::Timeout,
                http_status: None,
                timeout_observed: Some(true),
                connect_observed: Some(true),
            }],
        }),
        drain_timeout: None,
    });
    let failure = executor::ExecutionFailure::new(1, "Agent exited with code 1", Some(diagnostic));

    let event = capture_job_failure_log(&failure);

    assert_field_eq(
        &event,
        "event_delivery_first_failure_final_attempt_timeout_observed",
        "true",
    );
    assert_field_eq(
        &event,
        "event_delivery_first_failure_final_attempt_connect_observed",
        "true",
    );
}

#[test]
fn diagnostic_failure_logs_observed_signal_name_from_number() {
    let diagnostic = job_failure_diagnostic(None)
        .with_cli_exit_code(137)
        .with_cli_observed_exit(CliObservedExitDiagnostic {
            kind: CliObservedExitKind::Signal,
            exit_code: Some(137),
            signal_number: Some(libc::SIGKILL),
            signal_name: Some("tampered".to_string()),
            mapped_exit_code: 137,
        });
    let failure =
        executor::ExecutionFailure::new(137, "Agent exited with code 137", Some(diagnostic));

    let event = capture_job_failure_log(&failure);

    assert_field_eq(&event, "cli_observed_signal_name", "sigkill");
    assert!(!event.fields.contains_key("cli_observed_exit_code"));
}

#[test]
fn failure_without_diagnostic_logs_job_execution_failed_at_error() {
    let failure = executor::ExecutionFailure::new(1, "executor task panicked", None);

    let event = capture_job_failure_log(&failure);

    assert_eq!(event.level, Level::ERROR);
    assert_eq!(
        event.fields.get("message").map(String::as_str),
        Some("job execution failed")
    );
    assert!(!event.fields.contains_key("failure_class"));
    assert!(!event.fields.contains_key("failure_reason"));
    assert!(!event.fields.contains_key("prompt_shape"));
    assert!(!event.fields.contains_key("timeout_ms"));
}

#[test]
fn root_filesystem_full_logs_resource_fields_at_info() {
    let failure = executor::ExecutionFailure::new(137, "Agent exited with code 137", None)
        .with_resource_diagnostics(Some(executor::ResourceFailureDiagnostics {
            failure_kind: Some(executor::ResourceFailureKind::GuestRootFilesystemFull),
            guest_root_fs_used_percent: Some(100),
            guest_root_fs_available_kb: Some(20),
            guest_root_fs_inode_used_percent: Some(99),
            guest_root_fs_available_inodes: Some(42),
            guest_home_fs_used_percent: Some(1),
            guest_home_fs_available_kb: Some(10240),
            guest_home_fs_inode_used_percent: Some(2),
            guest_home_fs_available_inodes: Some(400),
            guest_memory_available_mb: Some(624),
        }));

    let event = capture_job_failure_log(&failure);

    assert_eq!(event.level, Level::INFO);
    assert_eq!(
        event.fields.get("message").map(String::as_str),
        Some("job execution failed")
    );
    assert_field_eq(&event, "exit_code", "137");
    assert_field_eq(&event, "reused", "false");
    assert_field_eq(&event, "error", "Agent exited with code 137");
    assert_field_eq(
        &event,
        "resource_failure_kind",
        "guest_root_filesystem_full",
    );
    assert_field_eq(&event, "guest_root_fs_used_percent", "100");
    assert_field_eq(&event, "guest_root_fs_available_kb", "20");
    assert_field_eq(&event, "guest_root_fs_inode_used_percent", "99");
    assert_field_eq(&event, "guest_root_fs_available_inodes", "42");
    assert_field_eq(&event, "guest_home_fs_used_percent", "1");
    assert_field_eq(&event, "guest_memory_available_mb", "624");
}

#[test]
fn home_filesystem_full_logs_and_completes_with_independent_counters() {
    let failure = executor::ExecutionFailure::new(1, "disk full", None).with_resource_diagnostics(
        Some(executor::ResourceFailureDiagnostics {
            failure_kind: Some(executor::ResourceFailureKind::GuestHomeFilesystemFull),
            guest_root_fs_used_percent: Some(40),
            guest_home_fs_used_percent: Some(100),
            guest_home_fs_available_kb: Some(0),
            guest_home_fs_inode_used_percent: Some(100),
            guest_home_fs_available_inodes: Some(0),
            ..Default::default()
        }),
    );
    let event = capture_job_failure_log(&failure);
    assert_eq!(event.level, Level::INFO);
    assert_field_eq(
        &event,
        "resource_failure_kind",
        "guest_home_filesystem_full",
    );
    assert_field_eq(&event, "guest_root_fs_used_percent", "40");
    assert_field_eq(&event, "guest_home_fs_used_percent", "100");
    assert_field_eq(&event, "guest_home_fs_available_kb", "0");
    assert_field_eq(&event, "guest_home_fs_inode_used_percent", "100");
    assert_field_eq(&event, "guest_home_fs_available_inodes", "0");
    assert_eq!(crate::job_lifecycle::completion_failure_reason(1, false, Some(&failure)),
            Some(api_contracts::generated::types::webhooks::agent::complete::RequestFailureReason::GuestHomeFilesystemFull));
    assert_eq!(
        crate::job_lifecycle::completion_failure_reason(1, true, Some(&failure)),
        None
    );
}

#[test]
fn workload_resource_limit_logs_structured_counters() {
    let diagnostic = job_failure_diagnostic(None).with_workload_resource_limit(
        WorkloadResourceLimitDiagnostic {
            memory_max_events: 5,
            memory_oom_events: 2,
            memory_oom_kill_events: 1,
            memory_oom_group_kill_events: 0,
            pids_max_events: 3,
        },
    );
    let failure = executor::ExecutionFailure::new(
        137,
        "Agent workload reached its memory limit",
        Some(diagnostic),
    );

    let event = capture_job_failure_log(&failure);

    assert_field_eq(&event, "workload_memory_max_events", "5");
    assert_field_eq(&event, "workload_memory_oom_events", "2");
    assert_field_eq(&event, "workload_memory_oom_kill_events", "1");
    assert_field_eq(&event, "workload_memory_oom_group_kill_events", "0");
    assert_field_eq(&event, "workload_pids_max_events", "3");
}

#[test]
fn oom_resource_failure_logs_resource_kind() {
    let failure = executor::ExecutionFailure::new(1, "Agent process killed by OOM killer", None)
        .with_resource_diagnostics(Some(
            executor::ResourceFailureDiagnostics::from_failure_kind(
                executor::ResourceFailureKind::GuestMemoryOomKilled,
            ),
        ));

    let event = capture_job_failure_log(&failure);

    assert_eq!(event.level, Level::ERROR);
    assert_eq!(
        event.fields.get("message").map(String::as_str),
        Some("job execution failed")
    );
    assert_field_eq(&event, "exit_code", "1");
    assert_field_eq(&event, "error", "Agent process killed by OOM killer");
    assert_field_eq(&event, "resource_failure_kind", "guest_memory_oom_killed");
}

#[test]
fn runner_job_timeout_logs_specific_terminal_message_and_fields() {
    let failure = executor::ExecutionFailure::runner_job_timeout(
        124,
        "Timeout",
        None,
        Duration::from_secs(7200),
        Duration::from_millis(7_199_949),
        Some(7_200_084),
    );

    let event = capture_job_failure_log(&failure);

    assert_eq!(event.level, Level::INFO);
    assert_eq!(
        event.fields.get("message").map(String::as_str),
        Some("runner job reached execution time limit")
    );
    assert_field_eq(&event, "exit_code", "124");
    assert_field_eq(&event, "reused", "false");
    assert_field_eq(&event, "error", "Timeout");
    assert_field_eq(&event, "timeout_ms", "7200000");
    assert_field_eq(&event, "elapsed_ms", "7199949");
    assert_field_eq(&event, "guest_duration_ms", "7200084");
    assert!(!event.fields.contains_key("failure_class"));
    assert!(!event.fields.contains_key("failure_reason"));
    assert!(!event.fields.contains_key("prompt_shape"));
}

#[test]
fn generic_and_timeout_failures_share_diagnostic_and_resource_fields() {
    let diagnostic = job_failure_diagnostic(Some(FailureReason::UsageLimit))
        .with_claude_num_turns(Some(2))
        .with_cli_termination(post_result_cli_termination())
        .with_cli_observed_exit(CliObservedExitDiagnostic::from_signal(libc::SIGKILL));
    let resource_diagnostics = executor::ResourceFailureDiagnostics {
        failure_kind: Some(executor::ResourceFailureKind::GuestRootFilesystemFull),
        guest_root_fs_used_percent: Some(100),
        guest_root_fs_available_kb: Some(20),
        guest_root_fs_inode_used_percent: Some(99),
        guest_root_fs_available_inodes: Some(42),
        guest_home_fs_used_percent: Some(1),
        guest_home_fs_available_kb: Some(10240),
        guest_home_fs_inode_used_percent: Some(2),
        guest_home_fs_available_inodes: Some(400),
        guest_memory_available_mb: Some(624),
    };
    let generic_failure = executor::ExecutionFailure::new(124, "Timeout", Some(diagnostic.clone()))
        .with_resource_diagnostics(Some(resource_diagnostics));
    let timeout_failure = executor::ExecutionFailure::runner_job_timeout(
        124,
        "Timeout",
        Some(diagnostic),
        Duration::from_secs(7200),
        Duration::from_millis(7_200_100),
        Some(7_200_000),
    )
    .with_resource_diagnostics(Some(resource_diagnostics));

    let generic_event = capture_job_failure_log(&generic_failure);
    let timeout_event = capture_job_failure_log(&timeout_failure);

    assert_eq!(generic_event.level, Level::INFO);
    assert_eq!(timeout_event.level, Level::INFO);
    assert_eq!(
        generic_event.fields.get("message").map(String::as_str),
        Some("job execution failed")
    );
    assert_eq!(
        timeout_event.fields.get("message").map(String::as_str),
        Some("runner job reached execution time limit")
    );
    assert_field_eq(&timeout_event, "timeout_ms", "7200000");
    assert_field_eq(&timeout_event, "elapsed_ms", "7200100");
    assert_field_eq(&timeout_event, "guest_duration_ms", "7200000");
    assert_field_kind(&timeout_event, "timeout_ms", "u128");
    assert_field_kind(&timeout_event, "elapsed_ms", "u128");
    assert_field_kind(&timeout_event, "guest_duration_ms", "u64");

    for event in [&generic_event, &timeout_event] {
        assert_field_eq(event, "run_id", &RunId::from(uuid::Uuid::nil()).to_string());
        assert_field_eq(event, "exit_code", "124");
        assert_field_eq(event, "reused", "false");
        assert_field_eq(event, "error", "Timeout");
        assert_field_eq(event, "failure_reason", "usage_limit");
        assert_field_eq(event, "failure_class", "cli_nonzero");
        assert_field_eq(event, "failure_framework", "codex");
        assert_field_eq(event, "failure_cli_exit_code", "1");
        assert_field_eq(event, "failure_claude_num_turns", "2");
        assert_field_eq(event, "failure_detail_source", "codex_jsonl");
        assert_field_eq(event, "session_history_status", "not_applicable");
        assert_field_eq(event, "prompt_shape", "plain");
        assert_field_eq(event, "prompt_bytes", "12");
        assert_field_eq(event, "first_line_bytes", "12");
        assert_field_eq(event, "cli_termination_initiator", "guest_agent");
        assert_field_eq(event, "cli_termination_reason", "post_result_reap");
        assert_field_eq(event, "cli_termination_signal_sent", "sigterm");
        assert_field_eq(event, "cli_termination_signal_pgid", "1401");
        assert_field_eq(event, "cli_termination_signal_grace_ms", "10000");
        assert_field_eq(event, "cli_termination_escalated", "false");
        assert_field_eq(event, "cli_termination_observed_exit_code", "143");
        assert_field_eq(event, "cli_observed_exit_kind", "signal");
        assert_field_eq(event, "cli_observed_signal_number", "9");
        assert_field_eq(event, "cli_observed_signal_name", "sigkill");
        assert_field_eq(event, "cli_observed_mapped_exit_code", "137");
        assert_field_eq(event, "resource_failure_kind", "guest_root_filesystem_full");
        assert_field_eq(event, "guest_root_fs_used_percent", "100");
        assert_field_eq(event, "guest_root_fs_available_kb", "20");
        assert_field_eq(event, "guest_home_fs_used_percent", "1");
        assert_field_eq(event, "guest_memory_available_mb", "624");

        assert_field_kind(event, "message", "debug");
        assert_field_kind(event, "run_id", "debug");
        assert_field_kind(event, "exit_code", "i64");
        assert_field_kind(event, "reused", "bool");
        assert_field_kind(event, "error", "debug");
        assert_field_kind(event, "failure_class", "str");
        assert_field_kind(event, "failure_cli_exit_code", "i64");
        assert_field_kind(event, "failure_claude_num_turns", "u64");
        assert_field_kind(event, "cli_termination_escalated", "bool");
        assert_field_kind(event, "prompt_bytes", "u64");
        assert_field_kind(event, "guest_root_fs_used_percent", "u64");
    }

    assert_shared_failure_log_fields(&generic_event, &timeout_event);
}
