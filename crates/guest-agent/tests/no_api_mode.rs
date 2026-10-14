//! No-API mode is used by local/reap tests and skips all webhook calls.
//!
//! This test captures an explicit runtime from process env, then exercises
//! disabled-HTTP users through explicit runtime/config/path entry points.

mod common;

use common::SystemLogOverrideGuard;
use guest_agent::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
use guest_agent::error::AgentError;
use guest_agent::masker::SecretMasker;
use guest_agent::run_context::GuestRuntime;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn no_api_mode_drains_background_webhook_users_without_network_client()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_env(&mock, tmp.path(), "@exit-after-result", 3, 1)?;
    }

    let runtime = GuestRuntime::from_process_env()?;
    let http = runtime.http.clone();
    let run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let ops_file = run_files.sandbox_ops_file();

    let disabled = http
        .post_json("http://127.0.0.1:1/should-not-send", &json!({}), 1)
        .await;
    let Err(AgentError::Http(message)) = disabled else {
        return Err("direct HTTP use should fail when no API token is configured".into());
    };
    assert!(message.contains("HTTP client is disabled"));

    let masker = Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        runtime.config.run_id.clone(),
        &runtime.paths,
        Arc::clone(&masker),
        http.clone(),
    );
    tokio::time::timeout(
        Duration::from_secs(5),
        telemetry.final_flush_and_shutdown(),
    )
    .await
    .expect(
        "no-API final-flush reply and uploader task termination should complete within 5 seconds",
    )?;

    let shutdown = CancellationToken::new();
    let heartbeat = tokio::spawn(guest_agent::heartbeat::heartbeat_loop_for_run(
        runtime.config.run_id.clone(),
        http.clone(),
        shutdown.clone(),
    ));
    shutdown.cancel();
    tokio::time::timeout(Duration::from_secs(1), heartbeat)
        .await
        .expect("heartbeat should exit promptly after shutdown in no-API mode")
        .expect("heartbeat task should not panic")?;

    let event = json!({
        "type": "system",
        "subtype": "init",
        "session_id": "session-no-api",
        "cwd": tmp.path().to_string_lossy(),
    });
    guest_agent::events::send_event_for_config(
        &http,
        event,
        1,
        &masker,
        &runtime.config,
        &runtime.paths,
    )
    .await?;
    assert_eq!(
        std::fs::read_to_string(runtime.paths.session_id_file())?,
        "session-no-api"
    );
    let _ = std::fs::remove_file(runtime.paths.session_id_file());

    let complete_log_path = tmp.path().join("complete-system.log");
    let complete_log_guard = SystemLogOverrideGuard::set(&complete_log_path);
    guest_agent::complete::report_user_cancellation_for_run(
        &http,
        &runtime.config.run_id,
        "sandbox-no-api",
        "reused",
        "sandboxReused",
        Some(1),
    )
    .await;
    drop(complete_log_guard);
    let complete_log = std::fs::read_to_string(&complete_log_path).unwrap_or_default();
    assert!(
        !complete_log.contains("Complete webhook failed"),
        "no-API complete path must return before touching the disabled HTTP client: {complete_log}"
    );

    let event_id = "60fca608-d174-4c1a-a1b2-57607b3adf46";
    let steered_log_path = tmp.path().join("active-input-steered-system.log");
    let steered_log_guard = SystemLogOverrideGuard::set(&steered_log_path);
    let active_input = ActiveInputRuntime::new_enabled(
        &runtime.config.run_id,
        &runtime.config.prompt,
        http.clone(),
    );
    let active_input_controller = active_input.controller();
    let mut active_input_writer = active_input.into_writer();
    assert_eq!(
        active_input_controller.handle_control_payload(
            &guest_contracts::active_input::encode_active_input(event_id, "local follow-up")?,
        ),
        ActiveInputControlOutcome::Accepted,
    );
    let active_input_frame = active_input_writer
        .next_frame()
        .await
        .expect("local active input should reach the CLI writer");
    active_input_writer.mark_writing(&active_input_frame.uuid);
    active_input_writer.mark_backend_accepted_without_replay(&active_input_frame)?;
    active_input_controller.close_terminal();
    active_input_controller
        .finalize_steered_declarations()
        .await?;
    drop(steered_log_guard);
    let steered_log = std::fs::read_to_string(&steered_log_path).unwrap_or_default();
    assert!(
        !steered_log.contains("Steered declaration failed"),
        "local active input must not attempt a steered declaration: {steered_log}",
    );

    let active_input =
        ActiveInputRuntime::new_disabled(&runtime.config.run_id, &runtime.config.prompt);
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        guest_agent::cli::execute_cli_with_active_input_for_config(
            &masker,
            common::spawn_dummy_heartbeat(),
            http.clone(),
            active_input.into_writer(),
            &runtime.config,
            &runtime.paths,
        ),
    )
    .await
    .expect("no-API execute_cli should return promptly with disabled HTTP client")?;
    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);
    assert_eq!(
        cli_result.last_event_sequence, None,
        "no-API execute_cli must not enqueue webhook events"
    );
    assert!(cli_result.event_delivery.is_none());
    let cli_session_id = std::fs::read_to_string(runtime.paths.session_id_file())?;
    assert!(
        cli_session_id.starts_with("mock-"),
        "no-API execute_cli should capture session metadata from stdout events, got {cli_session_id}"
    );
    let cli_history_path = common::claude_history_path_for_home(
        std::path::Path::new(&runtime.config.home_dir),
        cli_session_id.trim(),
    );
    assert!(
        cli_history_path.exists(),
        "CLI history should exist at the path derived from launch metadata: {}",
        cli_history_path.display()
    );
    assert!(
        cli_history_path.ends_with(format!("{}.jsonl", cli_session_id.trim())),
        "derived history path should use the captured CLI session id: {}",
        cli_history_path.display()
    );
    let ops = std::fs::read_to_string(ops_file)?;
    let cli_exit_metric_count = ops
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|entry| {
            entry["action_type"] == "last_read_event_to_cli_exit"
                && entry["success"] == true
                && entry["duration_ms"].as_u64().is_some()
        })
        .count();
    assert_eq!(
        cli_exit_metric_count, 1,
        "execute_cli should record exactly one last-read-event to CLI-exit sandbox op: {ops}"
    );

    Ok(())
}
