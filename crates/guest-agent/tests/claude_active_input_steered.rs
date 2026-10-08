//! Active-input steered declaration coverage for Claude stream-JSON stdin.
//!
//! This test lives in its own binary to isolate process environment and current
//! directory changes required by the mock Claude integration harness.

mod common;

use std::time::Duration;

use guest_agent::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::{Value, json};

const EVENT_ID: &str = "09065b04-cb85-4dd3-8cde-965e61ab8bfa";

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn claude_declares_steered_only_after_follow_up_reaches_stdin()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let server = MockServer::start();

    unsafe {
        common::setup_env(&mock, tmp.path(), "@active-input-smoke-ready:1", 3, 1)?;
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let run_id = runtime.config.run_id.as_str();
    let steered = server.mock(|when, then| {
        when.method(POST)
            .path(format!(
                "/api/runners/runs/{run_id}/steerable-inputs/{EVENT_ID}/steered"
            ))
            .header("Authorization", "Bearer test-token")
            .json_body(json!({}));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({ "outcome": "steered" }));
    });
    let steer_http =
        HttpClient::with_api_config(server.base_url(), "test-token", "", run_id, Duration::ZERO)?;
    let active_input = ActiveInputRuntime::new_enabled(run_id, &runtime.config.prompt, steer_http);
    let controller = active_input.controller();
    let payload = guest_contracts::active_input::encode_active_input(EVENT_ID, "follow-up prompt")?;
    assert_eq!(
        controller.handle_control_payload(&payload),
        ActiveInputControlOutcome::Accepted
    );
    assert_eq!(
        controller.handle_control_payload(&payload),
        ActiveInputControlOutcome::Accepted,
        "the same delivery must not create a second stdin frame"
    );

    let result = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_cli_with_active_input_for_runtime(
            &runtime,
            &SecretMasker::from_raw(""),
            common::spawn_dummy_heartbeat(),
            active_input.into_writer(),
        ),
    )
    .await
    .expect("Claude active-input execution should quiesce")?;

    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    steered.assert_calls(1);

    let session_id = std::fs::read_to_string(runtime.paths.session_id_file())?;
    let history_path = common::claude_history_path_for_home(
        std::path::Path::new(&runtime.config.home_dir),
        session_id.trim(),
    );
    let history = std::fs::read_to_string(history_path)?;
    let delivered_user_frames = history
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("user"))
        .filter(|event| event.get("uuid").and_then(Value::as_str) == Some(EVENT_ID))
        .collect::<Vec<_>>();
    assert_eq!(delivered_user_frames.len(), 1);
    assert_eq!(
        delivered_user_frames[0]
            .pointer("/message/content")
            .and_then(Value::as_str),
        Some("follow-up prompt")
    );

    Ok(())
}
