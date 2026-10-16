//! Public-boundary coverage for reachable Codex thread-item semantics.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use serde_json::{Value, json};
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_preserves_reachable_thread_items()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-thread-items-test",
                prompt: "preserve reachable Codex thread item semantics",
                scenario: Some("runtime-thread-items"),
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

    let masker = SecretMasker::from_raw("");
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("execute_cli should return promptly")?;

    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);
    assert!(cli_result.failure_diagnostic.is_none());

    let events = read_jsonl(runtime.paths.agent_log_file())?;
    assert_eq!(
        event_types(&events),
        [
            "thread.started",
            "turn.started",
            "item.started",
            "item.completed",
            "item.completed",
            "item.completed",
            "item.completed",
            "item.completed",
            "item.started",
            "item.completed",
            "item.completed",
            "turn.completed",
        ]
    );

    let collab_events = item_events(&events, "collab_agent_tool_call");
    assert_eq!(collab_events.len(), 2);
    assert_eq!(collab_events[0]["type"], "item.started");
    assert_eq!(collab_events[0]["item"]["status"], "in_progress");
    assert_eq!(collab_events[1]["type"], "item.completed");
    assert_eq!(collab_events[1]["item"]["status"], "completed");
    for event in &collab_events {
        assert_eq!(event["item"]["id"], "mock-collab-agent-tool-call");
        assert_eq!(event["item"]["tool"], "spawn_agent");
        assert_eq!(
            event["item"]["receiver_thread_ids"],
            json!(["mock-subagent-thread"])
        );
        assert_eq!(event["item"]["prompt"], "inspect the adapter contract");
        assert_eq!(event["item"]["model"], "gpt-5");
        assert_eq!(event["item"]["reasoning_effort"], "high");
    }
    assert_eq!(
        collab_events[1]["item"]["agents_states"]["mock-subagent-thread"],
        json!({
            "status": "completed",
            "message": "adapter contract inspected",
        })
    );

    let activity_events = item_events(&events, "sub_agent_activity");
    assert_eq!(activity_events.len(), 4);
    assert_eq!(
        activity_events
            .iter()
            .map(|event| event["item"]["kind"].as_str())
            .collect::<Vec<_>>(),
        [
            Some("started"),
            Some("interacted"),
            Some("interrupted"),
            Some("completed"),
        ]
    );
    assert!(activity_events.iter().all(|event| {
        event["item"]["agent_thread_id"] == "mock-subagent-thread"
            && event["item"]["agent_path"] == "/root/researcher"
    }));

    let compaction_events = item_events(&events, "context_compaction");
    assert_eq!(compaction_events.len(), 2);
    assert_eq!(compaction_events[0]["type"], "item.started");
    assert_eq!(compaction_events[1]["type"], "item.completed");
    assert!(
        compaction_events
            .iter()
            .all(|event| { event["item"]["id"] == "mock-context-compaction" })
    );

    let future_item = item_events(&events, "future_operation")
        .into_iter()
        .next()
        .ok_or("missing generic future item")?;
    assert_eq!(future_item["item"]["status"], "completed");
    assert_eq!(future_item["item"]["label"], "future item remains generic");

    Ok(())
}

fn read_jsonl(path: &str) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    std::fs::read_to_string(path)?
        .lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}

fn event_types(events: &[Value]) -> Vec<&str> {
    events
        .iter()
        .filter_map(|event| event.get("type").and_then(Value::as_str))
        .collect()
}

fn item_events<'a>(events: &'a [Value], item_type: &str) -> Vec<&'a Value> {
    events
        .iter()
        .filter(|event| event.pointer("/item/type").and_then(Value::as_str) == Some(item_type))
        .collect()
}
