//! Integration coverage for Codex app-server execution.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

mod codex_app_server_startup_policy;
mod common;

use guest_agent::masker::SecretMasker;
use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[tokio::test]
async fn codex_app_server_backend_runs_initial_turn_and_synthesizes_thread_started()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let argv_path = tmp.path().join("codex-argv");
    let recording_mock =
        codex_app_server_startup_policy::recording_codex(tmp.path(), &mock, &argv_path)?;
    let run_id = "codex-app-server-backend-test";
    let prompt = "drive the app-server backend";

    unsafe {
        common::setup_codex_app_server_env(
            &recording_mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id,
                prompt,
                scenario: Some("runtime-turn-complete-without-thread-started"),
                resume_session_id: None,
            },
        )?;
        let api_start_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_millis()
            .saturating_sub(10_000);
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_START_TIME_ENV,
            api_start_time.to_string(),
        );
        let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), run_id)
            .map_err(|error| format!("resolve runtime dir: {error}"))?;
        common::set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: prompt.to_string(),
                codex_runtime_config: r#"{
                    "providerId": "openrouter-codex",
                    "name": "OpenRouter (Codex)",
                    "baseUrl": "https://openrouter.ai/api/v1",
                    "envKey": "OPENAI_API_KEY",
                    "wireApi": "responses",
                    "supportsWebsockets": false
                }"#
                .to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )?;
        common::set_user_env_file_env_for_test(
            &runtime_dir,
            &HashMap::from([
                ("OPENAI_API_KEY".to_string(), "sk-test".to_string()),
                ("OPENAI_MODEL".to_string(), "deepseek-v4-flash".to_string()),
                (
                    "OPENAI_BASE_URL".to_string(),
                    "https://api.should-not-win.test/v1".to_string(),
                ),
            ]),
        )?;
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let masker = SecretMasker::from_raw("");
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("execute_cli should return promptly")?;

    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);
    assert!(cli_result.failure_diagnostic.is_none());
    assert!(cli_result.last_event_sequence.is_none());
    codex_app_server_startup_policy::assert_startup_policy(&argv_path, false)?;

    let events = read_agent_log_events(&runtime.paths)?;
    assert_event_type_sequence(
        &events,
        &[
            "thread.started",
            "turn.started",
            "item.completed",
            "turn.completed",
        ],
    );
    assert_eq!(
        events[2].pointer("/item/text").and_then(Value::as_str),
        Some("codex-mock app-server response: drive the app-server backend")
    );
    assert_eq!(events[3]["usage"], common::expected_codex_turn_usage());

    let sandbox_ops = read_sandbox_ops(&runtime.paths)?;
    let output_item_started = sandbox_ops
        .iter()
        .filter(|event| {
            event.get("action_type").and_then(Value::as_str)
                == Some("api_to_codex_output_item_started")
        })
        .collect::<Vec<_>>();
    let agent_message_item_started = sandbox_ops
        .iter()
        .filter(|event| {
            event.get("action_type").and_then(Value::as_str)
                == Some("api_to_codex_agent_message_item_started")
        })
        .collect::<Vec<_>>();
    assert_eq!(output_item_started.len(), 1);
    assert_eq!(agent_message_item_started.len(), 1);
    let output_duration = output_item_started[0]["duration_ms"]
        .as_u64()
        .ok_or("output item timing missing duration_ms")?;
    let agent_message_duration = agent_message_item_started[0]["duration_ms"]
        .as_u64()
        .ok_or("agent message item timing missing duration_ms")?;
    assert!(output_duration <= agent_message_duration);

    let thread_id = events[0]
        .get("thread_id")
        .and_then(Value::as_str)
        .ok_or("thread.started missing thread_id")?;
    let serialized_timings =
        serde_json::to_string(&[output_item_started[0], agent_message_item_started[0]])?;
    for excluded in [
        thread_id,
        "mock-reasoning-item-0",
        "mock-reasoning-item-1",
        "mock-agent-message-item-0",
        "mock-agent-message-item-1",
        "mock reasoning content must not enter timing telemetry",
    ] {
        assert!(
            !serialized_timings.contains(excluded),
            "timing telemetry must not contain {excluded:?}: {serialized_timings}"
        );
    }
    let stored_id = std::fs::read_to_string(runtime.paths.session_id_file())?;
    assert_eq!(stored_id, thread_id);
    assert_eq!(masker.mask_string(thread_id), thread_id);

    let session_events = read_codex_session_history_events(&runtime, thread_id)?;
    let input_event = session_events
        .iter()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("mock.app_server.input"))
        .ok_or("missing mock app-server input event")?;
    assert_eq!(
        input_event
            .get("thread_request_has_runtime_workspace_roots")
            .and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        input_event
            .get("thread_request_model")
            .and_then(Value::as_str),
        Some("deepseek-v4-flash")
    );
    assert_eq!(
        input_event
            .get("thread_request_model_provider")
            .and_then(Value::as_str),
        Some("openrouter-codex")
    );
    assert!(
        input_event
            .get("child_env_openai_base_url")
            .is_some_and(Value::is_null)
    );
    assert_eq!(
        input_event
            .get("turn_request_has_runtime_workspace_roots")
            .and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        input_event.get("turn_request_cwd").and_then(Value::as_str),
        Some(guest_agent::paths::CANONICAL_WORKING_DIR)
    );
    assert_eq!(
        input_event
            .get("turn_request_approval_policy")
            .and_then(Value::as_str),
        Some("never")
    );
    assert_eq!(
        input_event
            .get("turn_request_approvals_reviewer")
            .and_then(Value::as_str),
        Some("user")
    );
    assert_eq!(
        input_event
            .pointer("/turn_request_sandbox_policy/type")
            .and_then(Value::as_str),
        Some("dangerFullAccess")
    );

    Ok(())
}

fn read_sandbox_ops(
    paths: &guest_agent::paths::GuestPaths,
) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let log = std::fs::read_to_string(paths.sandbox_ops_file())?;
    log.lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}

fn read_agent_log_events(
    paths: &guest_agent::paths::GuestPaths,
) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let log = std::fs::read_to_string(paths.agent_log_file())?;
    log.lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}

fn read_codex_session_history_events(
    runtime: &guest_agent::run_context::GuestRuntime,
    thread_id: &str,
) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let root = std::path::Path::new(&runtime.config.codex_home_dir).join("sessions");
    let filename_key = thread_id.replace('-', "");
    let history_path = find_file(&root, &|name| {
        name.replace('-', "").contains(&filename_key)
            && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"))
    })
    .ok_or("missing Codex session history")?;
    let history = std::fs::read(history_path)?;
    let history = String::from_utf8(history)?;
    history
        .lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}

fn find_file(
    directory: &std::path::Path,
    matches: &impl Fn(&str) -> bool,
) -> Option<std::path::PathBuf> {
    for entry in std::fs::read_dir(directory).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file(&path, matches) {
                return Some(found);
            }
        } else if entry.file_name().to_str().is_some_and(matches) {
            return Some(path);
        }
    }
    None
}

fn assert_event_type_sequence(events: &[Value], expected: &[&str]) {
    let actual = events
        .iter()
        .map(|event| event.get("type").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let expected = expected
        .iter()
        .map(|value| Some(*value))
        .collect::<Vec<_>>();
    assert_eq!(actual, expected);
}
