//! Entry-point coverage for oversized Codex app-server turn input failures.

mod common;

use guest_contracts::diagnostics::{
    AgentFramework, FailureClass, FailureDiagnostic, FailureReason,
};
use httpmock::prelude::*;
use serde_json::json;
use std::time::Duration;
use tokio::process::Command;

const PROMPT_SENTINEL: &str = "do-not-expose-oversized-prompt";
const UPSTREAM_ERROR_SENTINEL: &str = "do-not-expose-upstream-input-limit-message";

#[tokio::test]
async fn oversized_codex_input_writes_actionable_structured_failure()
-> Result<(), Box<dyn std::error::Error>> {
    common::ensure_canonical_workspace_for_test()?;
    let server = MockServer::start();
    let mock_codex = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let home = tmp.path().join("home");
    let runtime_dir = tmp.path().join("runtime");
    std::fs::create_dir_all(&home)?;
    let run_payload_file = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: PROMPT_SENTINEL.to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;
    let _heartbeat = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/heartbeat");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({}));
    });
    let _events = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({}));
    });
    let _telemetry = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({}));
    });
    let prepare_history = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/session-history/prepare");
        then.status(200);
    });
    let complete = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(
                r#"{"runId":"codex-input-too-large","exitCode":1,"failureReason":"input_too_large","error":"execution: Codex input is too large: 101 characters provided, maximum is 100 characters. Reduce the input and try again.","completion":{"cliAgentSessionHistoryDisposition":"unavailable"}}"#,
            );
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "failed"}));
    });

    let output = common::command_output_with_timeout(
        Command::new(env!("CARGO_BIN_EXE_guest-agent"))
            .env_clear()
            .env(
                "PATH",
                std::env::var("PATH")
                    .unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".to_string()),
            )
            .env("SHELL", "/bin/sh")
            .env("HOME", &home)
            .env(guest_contracts::env::RUN_ID_ENV, "codex-input-too-large")
            .env(
                guest_contracts::env::CANONICAL_API_URL_ENV,
                server.base_url(),
            )
            .env(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token")
            .env(
                guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
                "00000000-0000-4000-8000-000000000abc",
            )
            .env(
                guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
                "reused",
            )
            .env(guest_contracts::env::CLI_AGENT_TYPE_ENV, "codex")
            .env("OKOU_TEST_CODEX_HOME_DIR", home.join(".codex"))
            .env(guest_contracts::env::USE_MOCK_CODEX_ENV, "true")
            .env(
                guest_contracts::env::CANONICAL_MOCK_CODEX_PATH_ENV,
                &mock_codex,
            )
            .env(
                "MOCK_CODEX_APP_SERVER_SCENARIO",
                "turn-start-input-too-large",
            )
            .env(
                guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
                &run_payload_file,
            )
            .env(
                guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
                &runtime_dir,
            ),
        Duration::from_secs(20),
        "guest-agent did not finish an oversized-input rejection promptly",
    )
    .await?;

    assert_eq!(
        output.status.code(),
        Some(1),
        "guest-agent output:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    prepare_history.assert_calls_async(0).await;
    complete.assert_calls_async(1).await;

    let paths = guest_agent::paths::GuestPaths::from_runtime_dir(runtime_dir);
    let error = std::fs::read_to_string(paths.finalization_error_file())?;
    assert!(error.contains("101 characters provided"));
    assert!(error.contains("maximum is 100 characters"));
    assert!(error.contains("Reduce the input and try again"));
    assert!(!error.contains(PROMPT_SENTINEL));
    assert!(!error.contains(UPSTREAM_ERROR_SENTINEL));

    let diagnostic_bytes = std::fs::read(paths.failure_diagnostic_file())?;
    let diagnostic: FailureDiagnostic = serde_json::from_slice(&diagnostic_bytes)?;
    assert_eq!(diagnostic.failure_class, FailureClass::CliExecutionError);
    assert_eq!(diagnostic.framework, AgentFramework::Codex);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::InputTooLarge)
    );
    assert_eq!(diagnostic.failure_detail_source, None);

    for output_text in [
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&diagnostic_bytes),
    ] {
        assert!(!output_text.contains(PROMPT_SENTINEL));
        assert!(!output_text.contains(UPSTREAM_ERROR_SENTINEL));
    }

    Ok(())
}
