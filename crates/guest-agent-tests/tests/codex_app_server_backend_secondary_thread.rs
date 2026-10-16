//! Secondary-thread notification coverage for Codex app-server execution.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use guest_agent::active_input::ActiveInputControlOutcome;
use guest_agent::masker::SecretMasker;
use serde_json::Value;
use std::time::Duration;

const SECONDARY_THREAD_ID: &str = "00000000-0000-4000-8000-000000000def";
const SECONDARY_NOTIFICATION_LOG: &str =
    "Ignoring codex app-server notification for secondary thread";

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn codex_app_server_backend_ignores_secondary_thread_notifications()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-secondary-thread-test",
                prompt: "ignore multiplexed secondary thread notifications",
                scenario: Some("secondary-thread-notifications"),
                resume_session_id: None,
            },
        )?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_START_TIME_ENV,
            "1699999999000",
        );
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let active_input = common::active_input_runtime(&runtime)?;
    let payload = common::active_input_payload("must wait for the top-level turn")?;
    assert_eq!(
        active_input.controller().handle_control_payload(&payload),
        ActiveInputControlOutcome::Accepted
    );

    let masker = SecretMasker::from_raw("");
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_with_active_input_for_runtime(
            &runtime,
            &masker,
            common::spawn_dummy_heartbeat(),
            active_input.into_writer(),
        ),
    )
    .await
    .expect("execute_cli_with_active_input should return promptly")?;

    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);
    assert!(cli_result.failure_diagnostic.is_none());

    let input_events = common::read_codex_session_history_events_for_runtime(&runtime)?
        .into_iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("mock.app_server.input"))
        .collect::<Vec<_>>();
    assert_eq!(input_events.len(), 1);
    assert_eq!(input_events[0]["kind"], "initial");

    let events = read_jsonl(runtime.paths.agent_log_file())?;
    let event_types = events
        .iter()
        .filter_map(|event| event.get("type").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert_eq!(
        event_types,
        [
            "thread.started",
            "warning",
            "item.completed",
            "turn.completed"
        ]
    );
    assert!(events.iter().all(|event| {
        event.get("thread_id").and_then(Value::as_str) != Some(SECONDARY_THREAD_ID)
    }));
    assert_eq!(
        events.last().ok_or("missing terminal event")?["usage"],
        common::expected_codex_turn_usage()
    );

    let sandbox_ops = std::fs::read_to_string(runtime.paths.sandbox_ops_file()).unwrap_or_default();
    assert!(!sandbox_ops.contains("api_to_codex_output_item_started"));
    assert!(!sandbox_ops.contains("api_to_codex_agent_message_item_started"));

    let system_log = std::fs::read_to_string(runtime.paths.system_log_file())?;
    assert_eq!(system_log.matches(SECONDARY_NOTIFICATION_LOG).count(), 1);
    assert!(system_log.contains("method=thread/started"));
    assert!(system_log.contains(SECONDARY_THREAD_ID));

    Ok(())
}

fn read_jsonl(path: &str) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    std::fs::read_to_string(path)?
        .lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}
