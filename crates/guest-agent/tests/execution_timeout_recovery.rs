//! The guest-agent entry point must turn the runner-owned execution deadline
//! into a recovery checkpoint before exiting with the shared timeout code.

mod common;

use guest_contracts::diagnostics::{
    AGENT_EXECUTION_TIMEOUT_EXIT_CODE, CliTerminationReason, FailureDiagnostic,
};
use httpmock::prelude::*;
use serde_json::json;
use std::time::Duration;
use tokio::process::Command;

const RUN_ID: &str = "execution-timeout-recovery";
const THREAD_ID: &str = "019fac13-2355-74d3-8414-b467fbb80c60";

#[tokio::test]
async fn execution_timeout_checkpoints_the_resumable_session_before_exit()
-> Result<(), Box<dyn std::error::Error>> {
    common::ensure_canonical_workspace_for_test()?;
    let server = MockServer::start();
    let tmp = tempfile::tempdir()?;
    let home = tmp.path().join("home");
    let runtime_dir = tmp.path().join("runtime");
    std::fs::create_dir_all(&home)?;
    let mock_codex = common::build_and_locate_mock_codex()?;
    let run_payload_file = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "keep working until the execution deadline".to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;

    let _heartbeat = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/heartbeat")
            .json_body_includes(format!(r#"{{"runId":"{RUN_ID}"}}"#));
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
    let prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/session-history/prepare")
            .json_body_includes(format!(r#"{{"runId":"{RUN_ID}"}}"#));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/execution-timeout-history"),
                "existing": false
            }));
    });
    let upload = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/execution-timeout-history")
            .header("Content-Type", "application/octet-stream");
        then.status(200);
    });
    let complete = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(format!(
                r#"{{"exitCode":{},"completion":{{"cliAgentSessionId":"{THREAD_ID}"}}}}"#,
                AGENT_EXECUTION_TIMEOUT_EXIT_CODE
            ));
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
            .env(
                guest_contracts::env::CANONICAL_API_URL_ENV,
                server.base_url(),
            )
            .env(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token")
            .env(guest_contracts::env::RUN_ID_ENV, RUN_ID)
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
                guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV,
                THREAD_ID,
            )
            .env(
                "MOCK_CODEX_APP_SERVER_SCENARIO",
                "runtime-turn-started-before-steer",
            )
            .env(
                guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
                "1",
            )
            .env(
                guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
                "1",
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
        "guest-agent did not finish within its finalization budget",
    )
    .await?;

    assert_eq!(
        output.status.code(),
        Some(AGENT_EXECUTION_TIMEOUT_EXIT_CODE),
        "guest-agent output:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    prepare.assert_calls_async(1).await;
    upload.assert_calls_async(1).await;
    complete.assert_calls_async(1).await;

    let paths = guest_agent::paths::GuestPaths::from_runtime_dir(runtime_dir);
    let diagnostic: FailureDiagnostic =
        serde_json::from_slice(&std::fs::read(paths.failure_diagnostic_file())?)?;
    assert_eq!(
        diagnostic
            .cli_termination
            .expect("timeout diagnostic should record CLI termination")
            .reason,
        CliTerminationReason::ExecutionTimeout
    );
    assert_eq!(
        std::fs::read_to_string(paths.session_id_file())?.trim(),
        THREAD_ID
    );
    Ok(())
}
