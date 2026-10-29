//! Terminal Pi diagnostics must be masked in both the guest error file and
//! the completion request produced by recovery finalization.

use crate::common;

use base64::Engine;
use guest_contracts::diagnostics::{CliTerminationReason, FailureClass, FailureDiagnostic};
use httpmock::prelude::*;
use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;
use tokio::process::Command;

const RUN_ID: &str = "pi-extension-failure-masking";
const SESSION_ID: &str = "11111111-1111-4111-8111-111111111179";
const SECRET: &str = "synthetic-pi-extension-secret";
const MASKED_ERROR: &str = "execution: Pi RPC extension failed: request failed with token=***";

#[tokio::test]
async fn pi_extension_failure_masks_error_file_and_recovery_completion()
-> Result<(), Box<dyn std::error::Error>> {
    common::ensure_canonical_workspace_for_test()?;
    let server = MockServer::start();
    let tmp = tempfile::tempdir()?;
    let runtime_dir = tmp.path().join("runtime");
    let run_payload = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "exercise an extension failure".to_string(),
            secret_values: base64::engine::general_purpose::STANDARD.encode(SECRET),
            pi_launch_config: r#"{"schemaVersion":2}"#.to_string(),
            pi_model_config: "{}".to_string(),
            pi_session_id: SESSION_ID.to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;

    let state_response = json!({
        "id": format!("{RUN_ID}:pi:get-state"),
        "type": "response",
        "command": "get_state",
        "success": true,
        "data": {
            "sessionId": SESSION_ID,
            "sessionFile": format!(
                "{}/{SESSION_ID}.jsonl",
                api_contracts::generated::constants::runners::paths::CANONICAL_PI_SESSION_DIR
            ),
        },
    });
    let prompt_response = json!({
        "id": format!("{RUN_ID}:pi:initial-prompt"),
        "type": "response",
        "command": "prompt",
        "success": true,
    });
    let extension_error = json!({
        "type": "extension_error",
        "error": format!("request failed with token={SECRET}"),
    });
    let host = tmp.path().join("pi-host");
    std::fs::write(
        &host,
        format!(
            "#!/bin/sh\nset -eu\n\
             IFS= read -r state_command\n\
             printf '%s\\n' '{state_response}'\n\
             IFS= read -r prompt_command\n\
             printf '%s\\n' '{prompt_response}'\n\
             printf '%s\\n' '{extension_error}'\n\
             while IFS= read -r command; do :; done\n"
        ),
    )?;
    std::fs::set_permissions(&host, std::fs::Permissions::from_mode(0o700))?;

    let _background = ["heartbeat", "events", "telemetry"].map(|endpoint| {
        server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/webhooks/agent/{endpoint}"));
            then.status(200).json_body(json!({}));
        })
    });
    let complete = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(
                json!({
                    "runId": RUN_ID,
                    "exitCode": 1,
                    "error": MASKED_ERROR,
                    "completion": {
                        "cliAgentType": "pi",
                        "cliAgentSessionId": SESSION_ID,
                        "cliAgentSessionHistoryDisposition": "native_only",
                    },
                })
                .to_string(),
            );
        then.status(200)
            .json_body(json!({"success": true, "status": "failed"}));
    });

    let output = common::command_output_with_timeout(
        Command::new(env!("CARGO_BIN_EXE_guest-agent"))
            .env_clear()
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("HOME", tmp.path())
            .env(guest_contracts::env::RUN_ID_ENV, RUN_ID)
            .env(guest_contracts::env::CLI_AGENT_TYPE_ENV, "pi")
            .env("OKOU_TEST_PI_CLI_PATH", &host)
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
                guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
                &run_payload,
            )
            .env(
                guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
                &runtime_dir,
            ),
        Duration::from_secs(20),
        "guest-agent did not finish Pi failure recovery within its budget",
    )
    .await?;

    assert_eq!(
        output.status.code(),
        Some(1),
        "guest-agent stderr:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let paths = guest_agent::paths::GuestPaths::from_runtime_dir(runtime_dir);
    assert_eq!(
        std::fs::read_to_string(paths.finalization_error_file())?,
        MASKED_ERROR
    );
    complete.assert_calls_async(1).await;
    let diagnostic: FailureDiagnostic =
        serde_json::from_slice(&std::fs::read(paths.failure_diagnostic_file())?)?;
    assert_eq!(diagnostic.failure_class, FailureClass::CliExecutionError);
    assert_eq!(
        diagnostic
            .cli_termination
            .expect("extension failure should terminate the Pi host")
            .reason,
        CliTerminationReason::StdoutIngestion
    );
    Ok(())
}
