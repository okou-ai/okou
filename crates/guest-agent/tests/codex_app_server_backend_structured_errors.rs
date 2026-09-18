//! Structured Codex app-server failure classification integration coverage.
//!
//! All cases run sequentially in one test because setup mutates process env and
//! the current directory.

mod common;

use guest_agent::error::AgentError;
use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::{FailureClass, FailureReason};
use serde_json::Value;
use std::time::Duration;

struct StructuredErrorCase {
    scenario: &'static str,
    expected_reason: Option<FailureReason>,
}

struct TurnStartErrorCase {
    scenario: &'static str,
    expected_input_too_large: bool,
}

#[tokio::test]
async fn codex_app_server_classifies_supported_structured_errors()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let original_directory = std::env::current_dir()?;
    let cases = [
        StructuredErrorCase {
            scenario: "runtime-turn-failed-output-token-limit",
            expected_reason: Some(FailureReason::OutputTokenLimit),
        },
        StructuredErrorCase {
            scenario: "runtime-output-token-limit-error",
            expected_reason: Some(FailureReason::OutputTokenLimit),
        },
        StructuredErrorCase {
            scenario: "runtime-turn-failed-context-window-exceeded",
            expected_reason: Some(FailureReason::ContextWindowExceeded),
        },
        StructuredErrorCase {
            scenario: "runtime-turn-failed-response-stream-connection-failed",
            expected_reason: Some(FailureReason::ResponseConnectionLost),
        },
        StructuredErrorCase {
            scenario: "runtime-turn-failed-response-stream-disconnected",
            expected_reason: Some(FailureReason::ResponseConnectionLost),
        },
        StructuredErrorCase {
            scenario: "runtime-turn-failed-internal-server-error",
            expected_reason: Some(FailureReason::ProviderServerError),
        },
        StructuredErrorCase {
            scenario: "runtime-turn-failed-response-too-many-failed-attempts",
            expected_reason: None,
        },
        StructuredErrorCase {
            scenario: "runtime-turn-failed-unauthorized",
            expected_reason: Some(FailureReason::InvalidCredentials),
        },
        StructuredErrorCase {
            scenario: "runtime-turn-failed-unknown",
            expected_reason: None,
        },
        StructuredErrorCase {
            scenario: "runtime-turn-failed-content-policy-rejection",
            expected_reason: Some(FailureReason::SafetyPolicyRefusal),
        },
        StructuredErrorCase {
            scenario: "runtime-turn-failed-biological-risk-rejection",
            expected_reason: Some(FailureReason::SafetyPolicyRefusal),
        },
        StructuredErrorCase {
            scenario: "runtime-turn-failed-biological-risk-internal-server-error",
            expected_reason: Some(FailureReason::ProviderServerError),
        },
        StructuredErrorCase {
            scenario: "runtime-turn-failed-invalid-request-format",
            expected_reason: None,
        },
    ];

    for (index, case) in cases.iter().enumerate() {
        let tmp = tempfile::tempdir()?;
        let run_id = format!("codex-structured-error-{index}");
        unsafe {
            common::setup_codex_app_server_env(
                &mock,
                tmp.path(),
                common::CodexAppServerEnvConfig {
                    run_id: &run_id,
                    prompt: "exercise structured Codex error classification",
                    scenario: Some(case.scenario),
                    resume_session_id: None,
                },
            )?;
        }
        let runtime = common::guest_runtime_from_process_env()?;
        let run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            common::execute_cli_for_runtime(
                &runtime,
                &SecretMasker::from_raw(""),
                common::spawn_dummy_heartbeat(),
            ),
        )
        .await
        .expect("execute_cli should return promptly")?;

        assert_eq!(result.exit_code, 1, "scenario: {}", case.scenario);
        let diagnostic = result
            .failure_diagnostic
            .as_ref()
            .unwrap_or_else(|| panic!("missing diagnostic for scenario: {}", case.scenario));
        assert_eq!(
            diagnostic.failure_reason, case.expected_reason,
            "scenario: {}",
            case.scenario
        );
        let terminal_failure = guest_agent::failure_diagnostics::cli_nonzero_failure_for_config(
            &runtime.config,
            None,
            &result,
        );
        assert_eq!(
            terminal_failure.diagnostic.failure_class,
            FailureClass::CliNonzero,
            "scenario: {}",
            case.scenario
        );
        assert_eq!(
            terminal_failure.diagnostic.failure_reason, case.expected_reason,
            "scenario: {}",
            case.scenario
        );
        assert_eq!(
            terminal_failure.message, diagnostic.message,
            "scenario: {}",
            case.scenario
        );

        if case.expected_reason == Some(FailureReason::OutputTokenLimit) {
            assert_eq!(
                diagnostic.message,
                "stream disconnected before completion: Incomplete response returned, reason: max_output_tokens"
            );
            let log = std::fs::read_to_string(runtime.paths.agent_log_file())?;
            let events = log
                .lines()
                .map(serde_json::from_str::<Value>)
                .collect::<Result<Vec<_>, _>>()?;
            assert_eq!(
                events
                    .iter()
                    .filter(|event| event["type"] == "turn.started")
                    .count(),
                1
            );
            assert_eq!(
                events
                    .iter()
                    .filter(|event| event.pointer("/item/text").and_then(Value::as_str)
                        == Some("Partial answer before output limit"))
                    .count(),
                1
            );
            // Native non-retrying errors end the backend immediately, before
            // a subsequent turn/completed notification needs to be consumed.
            if case.scenario == "runtime-output-token-limit-error" {
                assert!(events.iter().any(|event| event["type"] == "error"));
            } else {
                let completed = events
                    .iter()
                    .find(|event| event["type"] == "turn.completed")
                    .ok_or("missing failed completion")?;
                assert_eq!(completed["turn"]["status"], "failed");
                assert_eq!(completed["usage"], common::expected_codex_turn_usage());
            }
        }

        drop(run_files);
        std::env::set_current_dir(&original_directory)?;
    }

    assert_exact_oversized_turn_start_classification().await?;

    Ok(())
}

async fn assert_exact_oversized_turn_start_classification() -> Result<(), Box<dyn std::error::Error>>
{
    const PROMPT_SENTINEL: &str = "do-not-expose-oversized-prompt";
    const UPSTREAM_ERROR_SENTINEL: &str = "do-not-expose-upstream-input-limit-message";

    let mock = common::build_and_locate_mock_codex()?;
    let original_directory = std::env::current_dir()?;
    let cases = [
        TurnStartErrorCase {
            scenario: "turn-start-input-too-large",
            expected_input_too_large: true,
        },
        TurnStartErrorCase {
            scenario: "thread-start-input-too-large",
            expected_input_too_large: false,
        },
        TurnStartErrorCase {
            scenario: "turn-start-input-too-large-wrong-code",
            expected_input_too_large: false,
        },
        TurnStartErrorCase {
            scenario: "turn-start-input-too-large-wrong-discriminator",
            expected_input_too_large: false,
        },
        TurnStartErrorCase {
            scenario: "turn-start-input-too-large-missing-data",
            expected_input_too_large: false,
        },
        TurnStartErrorCase {
            scenario: "turn-start-input-too-large-missing-max-chars",
            expected_input_too_large: false,
        },
        TurnStartErrorCase {
            scenario: "turn-start-input-too-large-missing-actual-chars",
            expected_input_too_large: false,
        },
        TurnStartErrorCase {
            scenario: "turn-start-input-too-large-string-actual-chars",
            expected_input_too_large: false,
        },
        TurnStartErrorCase {
            scenario: "turn-start-input-too-large-fractional-actual-chars",
            expected_input_too_large: false,
        },
        TurnStartErrorCase {
            scenario: "turn-start-input-too-large-negative-max-chars",
            expected_input_too_large: false,
        },
        TurnStartErrorCase {
            scenario: "turn-start-input-too-large-zero-max-chars",
            expected_input_too_large: false,
        },
        TurnStartErrorCase {
            scenario: "turn-start-input-too-large-not-exceeded",
            expected_input_too_large: false,
        },
    ];

    for (index, case) in cases.iter().enumerate() {
        let tmp = tempfile::tempdir()?;
        let run_id = format!("codex-turn-start-error-{index}");
        unsafe {
            common::setup_codex_app_server_env(
                &mock,
                tmp.path(),
                common::CodexAppServerEnvConfig {
                    run_id: &run_id,
                    prompt: PROMPT_SENTINEL,
                    scenario: Some(case.scenario),
                    resume_session_id: None,
                },
            )?;
        }
        let runtime = common::guest_runtime_from_process_env()?;
        let run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
        let error = tokio::time::timeout(
            Duration::from_secs(5),
            common::execute_cli_for_runtime(
                &runtime,
                &SecretMasker::from_raw(""),
                common::spawn_dummy_heartbeat(),
            ),
        )
        .await?;
        let error = match error {
            Ok(result) => {
                return Err(std::io::Error::other(format!(
                    "turn/start RPC rejection returned exit code {} for scenario {}",
                    result.exit_code, case.scenario
                ))
                .into());
            }
            Err(error) => error,
        };

        match (&error, case.expected_input_too_large) {
            (
                AgentError::CodexInputTooLarge {
                    actual_chars,
                    max_chars,
                },
                true,
            ) => {
                assert_eq!((*actual_chars, *max_chars), (101, 100));
                let message = error.to_string();
                assert!(message.contains("101 characters provided"));
                assert!(message.contains("maximum is 100 characters"));
                assert!(!message.contains(PROMPT_SENTINEL));
                assert!(!message.contains(UPSTREAM_ERROR_SENTINEL));
            }
            (AgentError::Execution(_), false) => {}
            _ => {
                return Err(std::io::Error::other(format!(
                    "unexpected classification for scenario {}: {error:?}",
                    case.scenario
                ))
                .into());
            }
        }

        drop(run_files);
        std::env::set_current_dir(&original_directory)?;
    }

    Ok(())
}
