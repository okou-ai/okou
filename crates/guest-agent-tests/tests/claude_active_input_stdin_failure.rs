//! A failed Claude follow-up write must not consume active input at the API.
//!
//! Keep process environment and cwd setup isolated from the successful-delivery
//! test, including when ordinary Cargo runs integration executables.

use guest_agent_tests as common;

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use guest_agent::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
use guest_agent::cli::{CliExecutionControls, execute_cli_with_controls_for_config_started_at};
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

const EVENT_ID: &str = "09065b04-cb85-4dd3-8cde-965e61ab8bfa";
const PROMPT: &str = "initial prompt reaches Claude before stdin closes";

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn claude_failed_follow_up_write_is_not_declared_steered()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let mock = tmp.path().join("closed-follow-up-stdin-claude");
    let initial_frame_path = tmp.path().join("initial-frame.json");
    let child_pid_path = tmp.path().join("claude.pid");
    std::fs::write(
        &mock,
        r#"#!/bin/sh
set -eu
printf '%s\n' "$$" > "$CLAUDE_CHILD_PID_PATH"
IFS= read -r initial_frame
exec 0<&-
printf '%s\n' "$initial_frame" > "$CLAUDE_INITIAL_FRAME_PATH"
exec sleep 60
"#,
    )?;
    let mut permissions = std::fs::metadata(&mock)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&mock, permissions)?;

    unsafe {
        common::setup_env(&mock, tmp.path(), PROMPT, 3, 1)?;
    }
    let mut runtime = common::guest_runtime_from_process_env()?;
    runtime.config.user_env.extend([
        (
            "CLAUDE_INITIAL_FRAME_PATH".to_string(),
            initial_frame_path.to_string_lossy().into_owned(),
        ),
        (
            "CLAUDE_CHILD_PID_PATH".to_string(),
            child_pid_path.to_string_lossy().into_owned(),
        ),
    ]);
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let server = MockServer::start();
    let run_id = runtime.config.run_id.as_str();
    let steered = server.mock(|when, then| {
        when.method(POST).path(format!(
            "/api/runners/runs/{run_id}/steerable-inputs/{EVENT_ID}/steered"
        ));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({ "outcome": "steered" }));
    });
    let steer_http =
        HttpClient::with_api_config(server.base_url(), "test-token", "", run_id, Duration::ZERO)?;
    let active_input = ActiveInputRuntime::new_enabled(run_id, PROMPT, steer_http);
    let controller = active_input.controller();
    let payload = guest_contracts::active_input::encode_active_input(EVENT_ID, "follow-up prompt")?;
    let cancellation = CancellationToken::new();
    let masker = SecretMasker::from_raw("");
    let execution = execute_cli_with_controls_for_config_started_at(
        &masker,
        common::spawn_dummy_heartbeat(),
        runtime.http.clone(),
        CliExecutionControls::new(active_input.into_writer(), cancellation.clone(), None),
        &runtime.config,
        &runtime.paths,
        Instant::now(),
    );
    let delivery = async {
        // This complete line is published only after the initial frame is read
        // and fd 0 is closed. The next frame must therefore hit a broken pipe.
        let ready =
            common::wait_for_file_contains(&initial_frame_path, "\n", Duration::from_secs(5)).await;
        if let Err(error) = ready {
            cancellation.cancel();
            return Err(error);
        }
        Ok(controller.handle_control_payload(&payload))
    };
    // Join both futures before assertions so even a readiness failure goes
    // through production cancellation and child/worker cleanup.
    let (result, delivery) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(execution, delivery)
    })
    .await
    .expect("Claude follow-up failure should quiesce and reap its child");
    controller.finalize_steered_declarations().await?;
    let result = result?;
    assert_eq!(delivery?, ActiveInputControlOutcome::Accepted);

    let initial_frame: Value = serde_json::from_slice(&std::fs::read(&initial_frame_path)?)?;
    assert_eq!(initial_frame["type"], "user");
    assert_eq!(initial_frame["message"]["content"], PROMPT);
    let error = result
        .control_error
        .as_ref()
        .expect("the follow-up write should fail through the real Claude writer");
    assert!(
        error.to_string().contains("Broken pipe"),
        "expected a failed follow-up stdin write, got {error}"
    );
    assert_eq!(result.exit_code, common::SIGTERM_EXIT);
    let child_pid = std::fs::read_to_string(&child_pid_path)?
        .trim()
        .parse::<u32>()?;
    assert!(
        !PathBuf::from(format!("/proc/{child_pid}")).exists(),
        "Claude must be reaped before execution returns"
    );
    assert_eq!(
        controller.handle_control_payload(&payload),
        ActiveInputControlOutcome::Rejected {
            diagnostic: "active input delivery previously failed",
        }
    );
    // Finalization above drains even an incorrectly queued early declaration.
    steered.assert_calls(0);
    Ok(())
}
