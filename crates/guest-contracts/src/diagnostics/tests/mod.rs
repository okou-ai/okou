use super::*;

#[test]
fn cli_framework_projects_to_diagnostic_wire_values() {
    for (framework, expected, wire_value) in [
        (
            crate::env::CliFramework::ClaudeCode,
            AgentFramework::ClaudeCode,
            "claude_code",
        ),
        (
            crate::env::CliFramework::Codex,
            AgentFramework::Codex,
            "codex",
        ),
        (crate::env::CliFramework::Pi, AgentFramework::Pi, "pi"),
    ] {
        let projected = AgentFramework::from(framework);

        assert_eq!(projected, expected);
        assert_eq!(projected.as_str(), wire_value);
    }
}

#[test]
fn prompt_metadata_classifies_safe_shapes_without_content() {
    let empty = PromptMetadata::from_prompt(" \n\t");
    assert_eq!(empty.prompt_shape, PromptShape::Empty);
    assert_eq!(empty.prompt_bytes, 3);
    assert_eq!(empty.first_line_bytes, 1);

    let slash = PromptMetadata::from_prompt("  /help\nsecret second line");
    assert_eq!(slash.prompt_shape, PromptShape::SlashLike);
    assert_eq!(slash.prompt_bytes, 26);
    assert_eq!(slash.first_line_bytes, 7);

    let plain = PromptMetadata::from_prompt("éplain\r\nsecond");
    assert_eq!(plain.prompt_shape, PromptShape::Plain);
    assert_eq!(plain.prompt_bytes, 15);
    assert_eq!(plain.first_line_bytes, 7);
}

#[test]
fn failure_diagnostic_uses_camel_case_fields_and_snake_case_values() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::ClaudeZeroTurnNoHistory,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("/help"),
    )
    .with_cli_exit_code(0)
    .with_claude_num_turns(Some(0))
    .with_session_history_status(SessionHistoryStatus::Missing);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert!(json.get("schemaVersion").is_none());
    assert_eq!(json["failureClass"], "claude_zero_turn_no_history");
    assert_eq!(json["framework"], "claude_code");
    assert_eq!(json["cliExitCode"], 0);
    assert_eq!(json["claudeNumTurns"], 0);
    assert_eq!(json["failureDetailSource"], serde_json::Value::Null);
    assert_eq!(json["failureReason"], serde_json::Value::Null);
    assert_eq!(json["sessionHistoryStatus"], "missing");
    assert_eq!(json["promptShape"], "slash_like");
    assert_eq!(json["promptBytes"], 5);
    assert_eq!(json["firstLineBytes"], 5);

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn failure_diagnostic_serializes_optional_detail_source_and_reason() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("debug failure"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(FailureDetailSource::ClaudeResult)
    .with_failure_reason(FailureReason::InsufficientCredits);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(json["failureDetailSource"], "claude_result");
    assert_eq!(json["failureReason"], "insufficient_credits");

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn failure_diagnostic_serializes_pi_result_source() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Pi,
        PromptMetadata::from_prompt("debug Pi failure"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(FailureDetailSource::PiResult);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(json["failureDetailSource"], "pi_result");

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn failure_diagnostic_serializes_workload_resource_limit_counters() {
    let workload_resource_limit = WorkloadResourceLimitDiagnostic {
        memory_max_events: 5,
        memory_oom_events: 2,
        memory_oom_kill_events: 1,
        memory_oom_group_kill_events: 0,
        pids_max_events: 3,
    };
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("exhaust the workload"),
    )
    .with_cli_exit_code(137)
    .with_workload_resource_limit(workload_resource_limit);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(
        json["workloadResourceLimit"],
        serde_json::json!({
            "memoryMaxEvents": 5,
            "memoryOomEvents": 2,
            "memoryOomKillEvents": 1,
            "memoryOomGroupKillEvents": 0,
            "pidsMaxEvents": 3,
        })
    );

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn failure_diagnostic_serializes_cli_termination() {
    let cli_termination = CliTerminationDiagnostic::new(CliTerminationReason::PostResultReap)
        .record_signal(CliTerminationSignal::Sigterm, Some(1401), Some(10_000))
        .with_observed_exit_code(143);
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("debug failure"),
    )
    .with_cli_exit_code(143)
    .with_cli_termination(cli_termination);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(
        json["cliTermination"],
        serde_json::json!({
            "initiator": "guest_agent",
            "reason": "post_result_reap",
            "signalSent": "sigterm",
            "signalPgid": 1401,
            "signalGraceMs": 10_000,
            "escalated": false,
            "observedExitCode": 143
        })
    );

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn stdout_ingestion_termination_reason_has_stable_serialization() {
    let reason = CliTerminationReason::StdoutIngestion;
    assert_eq!(reason.as_str(), "stdout_ingestion");
    assert_eq!(
        serde_json::to_value(reason).unwrap(),
        serde_json::json!("stdout_ingestion")
    );
    assert_eq!(
        serde_json::from_value::<CliTerminationReason>(serde_json::json!("stdout_ingestion"))
            .unwrap(),
        reason
    );
}

#[test]
fn execution_timeout_reason_has_stable_serialization_and_exit_code() {
    let reason = CliTerminationReason::ExecutionTimeout;
    assert_eq!(AGENT_EXECUTION_TIMEOUT_EXIT_CODE, 124);
    assert_eq!(reason.as_str(), "execution_timeout");
    assert_eq!(
        serde_json::to_value(reason).unwrap(),
        serde_json::json!("execution_timeout")
    );
    assert_eq!(
        serde_json::from_value::<CliTerminationReason>(serde_json::json!("execution_timeout"))
            .unwrap(),
        reason
    );
}

#[test]
fn user_cancellation_reason_has_stable_serialization() {
    let reason = CliTerminationReason::UserCancellation;
    assert_eq!(reason.as_str(), "user_cancellation");
    assert_eq!(
        serde_json::to_value(reason).unwrap(),
        serde_json::json!("user_cancellation")
    );
    assert_eq!(
        serde_json::from_value::<CliTerminationReason>(serde_json::json!("user_cancellation"))
            .unwrap(),
        reason
    );
}

#[test]
fn failure_diagnostic_serializes_observed_signal_exit() {
    let observed_exit = CliObservedExitDiagnostic::from_signal(UNIX_SIGKILL_SIGNAL_NUMBER);
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("debug failure"),
    )
    .with_cli_exit_code(137)
    .with_cli_observed_exit(observed_exit);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(
        json["cliObservedExit"],
        serde_json::json!({
            "kind": "signal",
            "signalNumber": 9,
            "signalName": "sigkill",
            "mappedExitCode": 137
        })
    );

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
    assert!(round_trip.cli_observed_exit.unwrap().is_sigkill());
}

#[test]
fn observed_signal_exit_code_uses_shell_mapping_without_overflow() {
    assert_eq!(
        CliObservedExitDiagnostic::from_signal(UNIX_SIGKILL_SIGNAL_NUMBER).mapped_exit_code,
        137
    );
    assert_eq!(
        CliObservedExitDiagnostic::from_signal(i32::MAX).mapped_exit_code,
        i32::MAX
    );
}

#[test]
fn observed_signal_name_is_derived_from_signal_number() {
    let mut observed_exit = CliObservedExitDiagnostic::from_signal(UNIX_SIGKILL_SIGNAL_NUMBER);
    observed_exit.signal_name = Some("tampered".to_string());

    assert_eq!(observed_exit.known_signal_name(), Some("sigkill"));
}

#[test]
fn failure_diagnostic_serializes_observed_normal_exit() {
    let observed_exit = CliObservedExitDiagnostic::from_exit_code(137);
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("debug failure"),
    )
    .with_cli_exit_code(137)
    .with_cli_observed_exit(observed_exit);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(
        json["cliObservedExit"],
        serde_json::json!({
            "kind": "exit",
            "exitCode": 137,
            "mappedExitCode": 137
        })
    );

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
    assert!(!round_trip.cli_observed_exit.unwrap().is_sigkill());
}

#[test]
fn failure_diagnostic_deserializes_without_observed_exit() {
    let json = serde_json::json!({
        "failureClass": "cli_nonzero",
        "framework": "claude_code",
        "cliExitCode": 137,
        "cliTermination": null,
        "claudeNumTurns": null,
        "failureDetailSource": "fallback_exit_code",
        "failureReason": null,
        "sessionHistoryStatus": "present",
        "promptShape": "plain",
        "promptBytes": 5,
        "firstLineBytes": 5
    });

    let diagnostic: FailureDiagnostic = serde_json::from_value(json).unwrap();

    assert_eq!(diagnostic.cli_exit_code, Some(137));
    assert_eq!(diagnostic.cli_observed_exit, None);
}

#[test]
fn failure_reason_and_cli_termination_reason_are_independent() {
    let cli_termination = CliTerminationDiagnostic::new(CliTerminationReason::StuckToolWatchdog)
        .record_signal(CliTerminationSignal::Sigterm, Some(234), Some(10_000))
        .record_signal(CliTerminationSignal::Sigkill, Some(234), Some(1_000))
        .with_observed_exit_code(137);
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("debug failure"),
    )
    .with_cli_exit_code(137)
    .with_failure_reason(FailureReason::ProviderOverloaded)
    .with_cli_termination(cli_termination);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(json["failureReason"], "provider_overloaded");
    assert_eq!(json["cliTermination"]["reason"], "stuck_tool_watchdog");
    assert_eq!(json["cliTermination"]["signalSent"], "sigkill");
    assert_eq!(json["cliTermination"]["escalated"], true);

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn cli_termination_direct_sigkill_is_not_escalation() {
    let diagnostic = CliTerminationDiagnostic::new(CliTerminationReason::HeartbeatError)
        .record_signal(CliTerminationSignal::Sigkill, Some(42), Some(1_000));

    assert_eq!(diagnostic.signal_sent, Some(CliTerminationSignal::Sigkill));
    assert_eq!(diagnostic.signal_pgid, Some(42));
    assert_eq!(diagnostic.signal_grace_ms, Some(1_000));
    assert!(!diagnostic.escalated);

    let json = serde_json::to_value(diagnostic).unwrap();
    assert_eq!(json["signalSent"], "sigkill");
    assert_eq!(json["escalated"], false);
}

#[test]
fn cli_termination_repeated_sigterm_does_not_overwrite_original_signal() {
    let diagnostic = CliTerminationDiagnostic::new(CliTerminationReason::HeartbeatError)
        .record_signal(CliTerminationSignal::Sigterm, Some(42), Some(1_000))
        .record_signal(CliTerminationSignal::Sigterm, Some(42), Some(2_000));

    assert_eq!(diagnostic.signal_sent, Some(CliTerminationSignal::Sigterm));
    assert_eq!(diagnostic.signal_pgid, Some(42));
    assert_eq!(diagnostic.signal_grace_ms, Some(1_000));
    assert!(!diagnostic.escalated);
}

#[test]
fn cli_termination_sigkill_is_not_downgraded_by_late_sigterm() {
    let diagnostic = CliTerminationDiagnostic::new(CliTerminationReason::PostResultReap)
        .record_signal(CliTerminationSignal::Sigterm, Some(42), Some(10_000))
        .record_signal(CliTerminationSignal::Sigkill, Some(42), Some(1_000))
        .record_signal(CliTerminationSignal::Sigterm, Some(42), Some(10_000));

    assert_eq!(diagnostic.signal_sent, Some(CliTerminationSignal::Sigkill));
    assert_eq!(diagnostic.signal_pgid, Some(42));
    assert_eq!(diagnostic.signal_grace_ms, Some(1_000));
    assert!(diagnostic.escalated);
}

#[test]
fn cli_termination_repeated_sigkill_does_not_overwrite_escalation_signal() {
    let diagnostic = CliTerminationDiagnostic::new(CliTerminationReason::StuckToolWatchdog)
        .record_signal(CliTerminationSignal::Sigterm, Some(42), Some(10_000))
        .record_signal(CliTerminationSignal::Sigkill, Some(42), Some(1_000))
        .record_signal(CliTerminationSignal::Sigkill, Some(99), Some(2_000));

    assert_eq!(diagnostic.signal_sent, Some(CliTerminationSignal::Sigkill));
    assert_eq!(diagnostic.signal_pgid, Some(42));
    assert_eq!(diagnostic.signal_grace_ms, Some(1_000));
    assert!(diagnostic.escalated);
}

#[test]
fn failure_diagnostic_serializes_usage_limit_reason() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("debug failure"),
    )
    .with_cli_exit_code(1)
    .with_failure_reason(FailureReason::UsageLimit);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(json["failureReason"], "usage_limit");

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn failure_diagnostic_serializes_invalid_api_key_reason() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("debug failure"),
    )
    .with_cli_exit_code(1)
    .with_failure_reason(FailureReason::InvalidApiKey);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(json["failureReason"], "invalid_api_key");

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn failure_diagnostic_serializes_invalid_credentials_reason() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("debug failure"),
    )
    .with_cli_exit_code(1)
    .with_failure_reason(FailureReason::InvalidCredentials);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(json["failureReason"], "invalid_credentials");

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn failure_diagnostic_serializes_terms_acceptance_required_reason() {
    assert_eq!(
        FailureReason::TermsAcceptanceRequired.as_str(),
        "terms_acceptance_required"
    );

    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("debug failure"),
    )
    .with_cli_exit_code(1)
    .with_failure_reason(FailureReason::TermsAcceptanceRequired);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(json["failureReason"], "terms_acceptance_required");

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn failure_diagnostic_serializes_context_window_exceeded_reason() {
    assert_eq!(
        FailureReason::ContextWindowExceeded.as_str(),
        "context_window_exceeded"
    );

    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("debug failure"),
    )
    .with_cli_exit_code(1)
    .with_failure_reason(FailureReason::ContextWindowExceeded);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(json["failureReason"], "context_window_exceeded");

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn failure_diagnostic_serializes_finalization_class_and_history_limit_reason() {
    assert_eq!(
        FailureClass::FinalizationFailed.as_str(),
        "finalization_failed"
    );
    assert_eq!(
        FailureReason::SessionHistoryLimit.as_str(),
        "session_history_limit"
    );

    for framework in [AgentFramework::Codex, AgentFramework::ClaudeCode] {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::FinalizationFailed,
            framework,
            PromptMetadata::from_prompt("continue"),
        )
        .with_cli_exit_code(0)
        .with_failure_reason(FailureReason::SessionHistoryLimit);

        let json = serde_json::to_value(&diagnostic).unwrap();
        assert_eq!(json["failureClass"], "finalization_failed");
        assert_eq!(json["failureReason"], "session_history_limit");

        let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
        assert_eq!(round_trip, diagnostic);
    }
}

#[test]
fn failure_diagnostic_serializes_output_token_limit_reason() {
    assert_eq!(
        FailureReason::OutputTokenLimit.as_str(),
        "output_token_limit"
    );

    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("debug failure"),
    )
    .with_cli_exit_code(1)
    .with_failure_reason(FailureReason::OutputTokenLimit);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(json["failureReason"], "output_token_limit");

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn failure_reason_maps_exhaustively_to_the_public_completion_contract() {
    for (reason, expected) in [
        (FailureReason::SessionHistoryLimit, "session_history_limit"),
        (FailureReason::ExecutionTimeout, "execution_timeout"),
        (FailureReason::InsufficientCredits, "insufficient_credits"),
        (
            FailureReason::ProviderInsufficientCredits,
            "provider_insufficient_credits",
        ),
        (FailureReason::InvalidApiKey, "invalid_api_key"),
        (FailureReason::InvalidCredentials, "invalid_credentials"),
        (
            FailureReason::TermsAcceptanceRequired,
            "terms_acceptance_required",
        ),
        (
            FailureReason::AccountVerificationRequired,
            "account_verification_required",
        ),
        (
            FailureReason::ContextWindowExceeded,
            "context_window_exceeded",
        ),
        (FailureReason::InputTooLarge, "input_too_large"),
        (
            FailureReason::ProviderImageTooLarge,
            "provider_image_too_large",
        ),
        (FailureReason::OutputTokenLimit, "output_token_limit"),
        (FailureReason::ProviderRateLimited, "provider_rate_limited"),
        (FailureReason::ProviderOverloaded, "provider_overloaded"),
        (
            FailureReason::ProviderStreamTimeout,
            "provider_stream_timeout",
        ),
        (FailureReason::ProviderServerError, "provider_server_error"),
        (FailureReason::ProviderBadRequest, "provider_bad_request"),
        (
            FailureReason::ProviderQueueTimeout,
            "provider_queue_timeout",
        ),
        (
            FailureReason::ResponseConnectionLost,
            "response_connection_lost",
        ),
        (FailureReason::SafetyPolicyRefusal, "safety_policy_refusal"),
        (FailureReason::ReconnectRequired, "reconnect_required"),
        (
            FailureReason::CodexAccessProgramUnavailable,
            "codex_access_program_unavailable",
        ),
        (FailureReason::UnsupportedModel, "unsupported_model"),
        (
            FailureReason::ProviderModelRestricted,
            "provider_model_restricted",
        ),
        (FailureReason::UsageLimit, "usage_limit"),
    ] {
        let public_reason: api_contracts::generated::types::webhooks::agent::complete::RequestFailureReason =
                reason.into();

        assert_eq!(reason.as_str(), expected);
        assert_eq!(serde_json::to_value(reason).unwrap(), expected);
        assert_eq!(serde_json::to_value(public_reason).unwrap(), expected);
    }
}

#[test]
fn failure_diagnostic_serializes_provider_overloaded_reason() {
    assert_eq!(
        FailureReason::ProviderOverloaded.as_str(),
        "provider_overloaded"
    );

    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("debug failure"),
    )
    .with_cli_exit_code(1)
    .with_failure_reason(FailureReason::ProviderOverloaded);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(json["failureReason"], "provider_overloaded");

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn failure_diagnostic_serializes_provider_stream_timeout_reason() {
    assert_eq!(
        FailureReason::ProviderStreamTimeout.as_str(),
        "provider_stream_timeout"
    );

    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("debug failure"),
    )
    .with_cli_exit_code(1)
    .with_failure_reason(FailureReason::ProviderStreamTimeout);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(json["failureReason"], "provider_stream_timeout");

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn failure_diagnostic_serializes_provider_server_error_reason() {
    assert_eq!(
        FailureReason::ProviderServerError.as_str(),
        "provider_server_error"
    );

    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("debug failure"),
    )
    .with_cli_exit_code(1)
    .with_failure_reason(FailureReason::ProviderServerError);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(json["failureReason"], "provider_server_error");

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn failure_diagnostic_serializes_response_connection_lost_reason() {
    assert_eq!(
        FailureReason::ResponseConnectionLost.as_str(),
        "response_connection_lost"
    );

    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("debug failure"),
    )
    .with_cli_exit_code(1)
    .with_failure_reason(FailureReason::ResponseConnectionLost);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(json["failureReason"], "response_connection_lost");

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn failure_diagnostic_serializes_safety_policy_refusal_reason() {
    assert_eq!(
        FailureReason::SafetyPolicyRefusal.as_str(),
        "safety_policy_refusal"
    );

    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("debug failure"),
    )
    .with_cli_exit_code(1)
    .with_failure_reason(FailureReason::SafetyPolicyRefusal);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(json["failureReason"], "safety_policy_refusal");

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn failure_diagnostic_serializes_reconnect_required_reason() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("debug failure"),
    )
    .with_cli_exit_code(1)
    .with_failure_reason(FailureReason::ReconnectRequired);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(json["failureReason"], "reconnect_required");

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn failure_diagnostic_round_trips_bounded_event_delivery_details() {
    let first_attempt = HttpCompletedAttemptDiagnostic {
        attempt: 1,
        client_request_id: "11111111-1111-4111-8111-111111111111".to_string(),
        elapsed_ms: 30_000,
        failure_kind: HttpAttemptFailureKind::HttpStatus,
        http_status: Some(500),
        timeout_observed: None,
        connect_observed: None,
    };
    let combined_transport_attempt = HttpCompletedAttemptDiagnostic {
        attempt: 1,
        client_request_id: "33333333-3333-4333-8333-333333333333".to_string(),
        elapsed_ms: 10_000,
        failure_kind: HttpAttemptFailureKind::Timeout,
        http_status: None,
        timeout_observed: Some(true),
        connect_observed: Some(true),
    };
    let active_attempt = EventDeliveryActiveAttemptDiagnostic {
        attempt: 2,
        client_request_id: "22222222-2222-4222-8222-222222222222".to_string(),
        elapsed_ms: 4_000,
    };
    let event_delivery = EventDeliveryDiagnostic {
        total_events: 40,
        total_batches: 2,
        failed_batches: 1,
        last_acknowledged_sequence: Some(7),
        first_failed_batch: Some(EventDeliveryFailedBatchDiagnostic {
            first_sequence: 8,
            last_sequence: 15,
            event_count: 8,
            conservative_bytes: 2_048,
            response_state: EventDeliveryResponseState::AllHttpErrors,
            attempts: vec![first_attempt.clone()],
        }),
        drain_timeout: Some(EventDeliveryDrainTimeoutDiagnostic {
            queued_events: 0,
            queued_bytes: 0,
            carried_events: 0,
            carried_bytes: 0,
            active_batch: Some(EventDeliveryActiveBatchDiagnostic {
                first_sequence: 16,
                last_sequence: 39,
                event_count: 24,
                conservative_bytes: 8_192,
                completed_attempts: vec![combined_transport_attempt],
                active_attempt: Some(active_attempt),
                response_state: EventDeliveryResponseState::Incomplete,
            }),
        }),
    };
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("continue"),
    )
    .with_cli_exit_code(1)
    .with_event_delivery(event_delivery);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(
        json["eventDelivery"]["firstFailedBatch"]["responseState"],
        "all_http_errors"
    );
    assert_eq!(
        json["eventDelivery"]["firstFailedBatch"]["attempts"][0],
        serde_json::json!({
            "attempt": 1,
            "clientRequestId": "11111111-1111-4111-8111-111111111111",
            "elapsedMs": 30_000,
            "failureKind": "http_status",
            "httpStatus": 500
        })
    );
    assert_eq!(
        json["eventDelivery"]["drainTimeout"]["activeBatch"]["completedAttempts"][0]["timeoutObserved"],
        true
    );
    assert_eq!(
        json["eventDelivery"]["drainTimeout"]["activeBatch"]["completedAttempts"][0]["connectObserved"],
        true
    );
    assert_eq!(
        json["eventDelivery"]["drainTimeout"]["activeBatch"]["responseState"],
        "incomplete"
    );
    assert_eq!(
        EventDeliveryResponseState::AllHttpErrors.as_str(),
        "all_http_errors"
    );
    assert_eq!(HttpAttemptFailureKind::Transport.as_str(), "transport");

    let round_trip: FailureDiagnostic = serde_json::from_value(json.clone()).unwrap();
    assert_eq!(round_trip, diagnostic);

    let mut diagnostic = diagnostic;
    let active_batch = diagnostic
        .event_delivery
        .as_mut()
        .unwrap()
        .drain_timeout
        .as_mut()
        .unwrap()
        .active_batch
        .as_mut()
        .unwrap();
    active_batch.completed_attempts.clear();
    active_batch.active_attempt.as_mut().unwrap().attempt = 1;
    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(
        json["eventDelivery"]["drainTimeout"]["activeBatch"],
        serde_json::json!({
            "firstSequence": 16,
            "lastSequence": 39,
            "eventCount": 24,
            "conservativeBytes": 8_192,
            "completedAttempts": [],
            "activeAttempt": {
                "attempt": 1,
                "clientRequestId": "22222222-2222-4222-8222-222222222222",
                "elapsedMs": 4_000
            },
            "responseState": "incomplete"
        })
    );
    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn completed_http_attempt_deserializes_without_transport_observations() {
    let attempt: HttpCompletedAttemptDiagnostic = serde_json::from_value(serde_json::json!({
        "attempt": 3,
        "clientRequestId": "11111111-1111-4111-8111-111111111111",
        "elapsedMs": 12_000,
        "failureKind": "timeout"
    }))
    .unwrap();

    assert_eq!(attempt.http_status, None);
    assert_eq!(attempt.timeout_observed, None);
    assert_eq!(attempt.connect_observed, None);
}

#[test]
fn failure_diagnostic_round_trips_bounded_heartbeat_details() {
    let heartbeat = HeartbeatFailureDiagnostic {
        failed_cycles: vec![HeartbeatFailedCycleDiagnostic {
            scheduled_lag_ms: 25,
            attempts: vec![
                HttpCompletedAttemptDiagnostic {
                    attempt: 1,
                    client_request_id: "11111111-1111-4111-8111-111111111111".to_string(),
                    elapsed_ms: 10_000,
                    failure_kind: HttpAttemptFailureKind::Timeout,
                    http_status: None,
                    timeout_observed: Some(true),
                    connect_observed: Some(false),
                },
                HttpCompletedAttemptDiagnostic {
                    attempt: 2,
                    client_request_id: "22222222-2222-4222-8222-222222222222".to_string(),
                    elapsed_ms: 3,
                    failure_kind: HttpAttemptFailureKind::HttpStatus,
                    http_status: Some(503),
                    timeout_observed: None,
                    connect_observed: None,
                },
            ],
        }],
    };
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliExecutionError,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("continue"),
    )
    .with_cli_exit_code(1)
    .with_heartbeat(heartbeat);

    let json = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(json["heartbeat"]["failedCycles"][0]["scheduledLagMs"], 25);
    assert_eq!(
        json["heartbeat"]["failedCycles"][0]["attempts"][0]["failureKind"],
        "timeout"
    );
    assert_eq!(
        json["heartbeat"]["failedCycles"][0]["attempts"][1],
        serde_json::json!({
            "attempt": 2,
            "clientRequestId": "22222222-2222-4222-8222-222222222222",
            "elapsedMs": 3,
            "failureKind": "http_status",
            "httpStatus": 503
        })
    );
    assert_eq!(HttpAttemptFailureKind::Transport.as_str(), "transport");

    let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn failure_diagnostic_deserializes_without_optional_fields() {
    let json = serde_json::json!({
        "failureClass": "cli_nonzero",
        "framework": "claude_code",
        "cliExitCode": 1,
        "claudeNumTurns": 1,
        "sessionHistoryStatus": "present",
        "promptShape": "plain",
        "promptBytes": 13,
        "firstLineBytes": 13
    });

    let diagnostic: FailureDiagnostic = serde_json::from_value(json).unwrap();

    assert_eq!(diagnostic.failure_detail_source, None);
    assert_eq!(diagnostic.failure_reason, None);
    assert_eq!(diagnostic.cli_termination, None);
    assert_eq!(diagnostic.event_delivery, None);
    assert_eq!(diagnostic.heartbeat, None);
    assert_eq!(diagnostic.workload_resource_limit, None);
}
