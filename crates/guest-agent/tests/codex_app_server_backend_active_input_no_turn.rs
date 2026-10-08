//! No-active-turn coverage for Codex app-server execution.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

mod common;

use guest_agent::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::json;
use std::time::Duration;

const RUN_ID: &str = "codex-app-server-backend-active-input-no-turn-test";
const EVENT_ID: &str = "34919e72-7fb3-4b8f-b2ad-9a5e2e1ba0a6";

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn codex_app_server_backend_fails_visible_when_no_active_turn()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let server = MockServer::start();

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: RUN_ID,
                prompt: "drive the app-server backend no active turn path",
                scenario: Some("no-active-turn"),
                resume_session_id: None,
            },
        )?;
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let steered = server.mock(|when, then| {
        when.method(POST).path(format!(
            "/api/runners/runs/{RUN_ID}/steerable-inputs/{EVENT_ID}/steered"
        ));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({ "outcome": "steered" }));
    });
    let active_input = ActiveInputRuntime::new_enabled(
        &runtime.config.run_id,
        &runtime.config.prompt,
        HttpClient::with_api_config(server.base_url(), "test-token", "", RUN_ID, Duration::ZERO)?,
    );
    let payload = guest_contracts::active_input::encode_active_input(
        EVENT_ID,
        "no-active-turn follow-up prompt",
    )?;
    assert_eq!(
        active_input.controller().handle_control_payload(&payload),
        ActiveInputControlOutcome::Accepted
    );

    let masker = SecretMasker::from_raw("");
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_with_active_input_for_runtime(
            &runtime,
            &masker,
            common::spawn_dummy_heartbeat(),
            active_input.into_writer(),
        ),
    )
    .await
    .expect("execute_cli_with_active_input should return promptly");

    let error = result.expect_err("no active turn should fail the app-server backend");
    let message = error.to_string();
    assert!(
        message.contains("active input steer failed") && message.contains("no active turn"),
        "unexpected error: {message}"
    );
    steered.assert_calls(0);

    Ok(())
}
