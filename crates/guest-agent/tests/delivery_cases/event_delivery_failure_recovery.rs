//! Event delivery warnings preserve successful finalization and genuine CLI failures.

use crate::common;

use guest_contracts::diagnostics::{
    EventDeliveryResponseState, FailureClass, FailureDiagnostic, HttpAttemptFailureKind,
};
use httpmock::prelude::*;
use serde_json::json;
use std::io;
use std::time::Duration;
use tokio::process::Command;

const THREAD_ID: &str = "019fac13-2355-74d3-8414-b467fbb80c70";
const PRIMARY_CLI_ERROR: &str = "mock codex primary failure";

struct EventFailureRun {
    process_exit_code: Option<i32>,
    stderr: String,
    error_message: Option<String>,
    diagnostic: Option<FailureDiagnostic>,
}

#[tokio::test]
async fn successful_cli_with_exhausted_event_delivery_completes_successfully()
-> Result<(), Box<dyn std::error::Error>> {
    let run = run_event_failure_case("event-delivery-failure-recovery", 0, 500).await?;

    assert_eq!(
        run.process_exit_code,
        Some(0),
        "guest-agent stderr:\n{}",
        run.stderr
    );
    assert!(run.stderr.contains("▷ Finalization"));
    assert!(run.stderr.contains("Discarding event batch"));
    assert!(run.stderr.contains("retaining CLI outcome"));
    assert!(run.diagnostic.is_none());
    assert!(run.error_message.is_none());

    Ok(())
}

#[tokio::test]
async fn successful_cli_with_nonretryable_event_rejection_completes_successfully()
-> Result<(), Box<dyn std::error::Error>> {
    let run = run_event_failure_case("event-delivery-nonretryable-recovery", 0, 400).await?;

    assert_eq!(
        run.process_exit_code,
        Some(0),
        "guest-agent stderr:\n{}",
        run.stderr
    );
    assert!(run.stderr.contains("▷ Finalization"));
    assert!(run.stderr.contains("Discarding event batch"));
    assert!(run.diagnostic.is_none());
    assert!(run.error_message.is_none());

    Ok(())
}

#[tokio::test]
async fn nonzero_cli_remains_primary_when_event_delivery_also_fails()
-> Result<(), Box<dyn std::error::Error>> {
    let run = run_event_failure_case("event-delivery-secondary-failure", 1, 500).await?;

    assert_eq!(
        run.process_exit_code,
        Some(1),
        "guest-agent stderr:\n{}",
        run.stderr
    );
    assert!(run.stderr.contains(PRIMARY_CLI_ERROR));
    assert_eq!(run.error_message.as_deref(), Some(PRIMARY_CLI_ERROR));
    let diagnostic = run
        .diagnostic
        .as_ref()
        .ok_or("CLI failure omitted diagnostic")?;
    assert_eq!(diagnostic.failure_class, FailureClass::CliNonzero);
    assert_eq!(diagnostic.cli_exit_code, Some(1));
    assert_http_error_event_delivery(diagnostic, 500, 3)?;

    Ok(())
}

async fn run_event_failure_case(
    run_id: &str,
    cli_exit_code: i32,
    http_status: u16,
) -> Result<EventFailureRun, Box<dyn std::error::Error>> {
    common::ensure_canonical_workspace_for_test()?;
    let server = MockServer::start();
    let tmp = tempfile::tempdir()?;
    let home = tmp.path().join("home");
    let runtime_dir = tmp.path().join("runtime");
    std::fs::create_dir_all(&home)?;
    let mock_codex = common::build_and_locate_mock_codex()?;
    let mock_scenario = if cli_exit_code == 0 {
        "runtime-turn-complete"
    } else {
        "runtime-turn-failed"
    };
    let run_payload_file = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "finish CLI execution while event delivery fails".to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;

    let _heartbeat = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/heartbeat");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({}));
    });
    let events = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(http_status);
    });
    let _telemetry = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({}));
    });

    let complete = server.mock(|when, then| {
        let when = when
            .method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(format!(
                r#"{{"exitCode":{cli_exit_code},"completion":{{"cliAgentSessionId":"{THREAD_ID}"}}}}"#
            ));
        if cli_exit_code != 0 {
            when.json_body_includes(json!({"error": PRIMARY_CLI_ERROR}).to_string());
        }
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": if cli_exit_code == 0 { "completed" } else { "failed" }}));
    });

    let output = common::command_output_with_timeout(
        Command::new(env!("CARGO_BIN_EXE_guest-agent"))
            .env_clear()
            .env("OKOU_TEST_DISABLE_HTTP_RETRY_DELAY", "1")
            .env(
                "PATH",
                std::env::var("PATH")
                    .unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".to_string()),
            )
            .env("SHELL", "/bin/sh")
            .env("HOME", &home)
            .env(
                guest_contracts::env::CANONICAL_API_URL_ENV,
                server.base_url(),
            )
            .env(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token")
            .env(guest_contracts::env::RUN_ID_ENV, run_id)
            .env(
                guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
                "00000000-0000-4000-8000-000000000abc",
            )
            .env(guest_contracts::env::CLI_AGENT_TYPE_ENV, "codex")
            .env("OKOU_TEST_CODEX_HOME_DIR", home.join(".codex"))
            .env(guest_contracts::env::USE_MOCK_CODEX_ENV, "true")
            .env(
                guest_contracts::env::CANONICAL_MOCK_CODEX_PATH_ENV,
                &mock_codex,
            )
            .env(
                guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV,
                THREAD_ID,
            )
            .env("MOCK_CODEX_APP_SERVER_SCENARIO", mock_scenario)
            .env(
                guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
                &run_payload_file,
            )
            .env(
                guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
                &runtime_dir,
            ),
        Duration::from_secs(20),
        "guest-agent exceeded its finalization budget",
    )
    .await?;

    complete.assert_calls_async(1).await;

    let paths = guest_agent::paths::GuestPaths::from_runtime_dir(runtime_dir.clone());
    let diagnostic: Option<FailureDiagnostic> =
        if std::path::Path::new(paths.failure_diagnostic_file()).exists() {
            Some(serde_json::from_slice(&std::fs::read(
                paths.failure_diagnostic_file(),
            )?)?)
        } else {
            None
        };
    let attempts_per_batch = if http_status == 400 { 1 } else { 3 };
    assert!(events.calls_async().await >= attempts_per_batch);

    Ok(EventFailureRun {
        process_exit_code: output.status.code(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        error_message: if std::path::Path::new(paths.finalization_error_file()).exists() {
            Some(std::fs::read_to_string(paths.finalization_error_file())?)
        } else {
            None
        },
        diagnostic,
    })
}

fn assert_http_error_event_delivery(
    diagnostic: &FailureDiagnostic,
    http_status: u16,
    attempts_per_batch: usize,
) -> Result<(), Box<dyn std::error::Error>> {
    let event_delivery = diagnostic
        .event_delivery
        .as_ref()
        .ok_or_else(|| io::Error::other("failure omitted event delivery details"))?;
    assert!(event_delivery.failed_batches > 0);
    assert_eq!(
        event_delivery.failed_batches, event_delivery.total_batches,
        "the mock rejects every event delivery batch"
    );
    let failed_batch = event_delivery
        .first_failed_batch
        .as_ref()
        .ok_or_else(|| io::Error::other("failure omitted first failed batch"))?;
    assert_eq!(
        failed_batch.response_state,
        EventDeliveryResponseState::AllHttpErrors
    );
    assert_eq!(failed_batch.attempts.len(), attempts_per_batch);
    assert!(failed_batch.attempts.iter().all(|attempt| {
        attempt.failure_kind == HttpAttemptFailureKind::HttpStatus
            && attempt.http_status == Some(http_status)
    }));
    Ok(())
}
