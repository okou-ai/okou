//! Claude content blocks receive independent canonical sequences while the
//! original JSONL record remains the unit of local logging and metadata capture.

use guest_agent_tests as common;

use base64::Engine as _;
use guest_agent::masker::SecretMasker;
use guest_contracts::managed_command::render_managed_shell_command;
use serde_json::{Value, json};
use std::time::Duration;

const SESSION_ID: &str = "00000000-0000-4000-8000-000000000041";
const SECRET: &str = "provider-normalization-secret";

#[tokio::test]
async fn claude_content_blocks_are_masked_and_sequenced_in_source_order()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;
    let encoded_secret = base64::engine::general_purpose::STANDARD.encode(SECRET);
    let original_command = format!("printf '%s' '{SECRET}' '{encoded_secret}'");
    let managed_command = render_managed_shell_command(&original_command)?;
    let source_events = [
        json!({
            "type": "system",
            "subtype": "init",
            "session_id": SESSION_ID,
            "model": "mock-claude"
        }),
        json!({
            "type": "assistant",
            "session_id": SESSION_ID,
            "message": {
                "id": "msg-provider-normalization",
                "model": "mock-claude",
                "role": "assistant",
                "content": [
                    { "type": "text", "text": format!("text A {SECRET}") },
                    {
                        "type": "tool_use",
                        "id": "tool-use-a",
                        "name": "Bash",
                        "input": {
                            "command": managed_command
                        }
                    },
                    {
                        "type": "tool_use",
                        "id": "tool-use-b",
                        "name": "Read",
                        "input": { "file_path": "README.md" }
                    },
                    { "type": "text", "text": "text B" },
                    { "type": "text", "text": "text C" }
                ]
            }
        }),
        json!({
            "type": "user",
            "session_id": SESSION_ID,
            "uuid": "user-provider-normalization",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "tool-use-a",
                        "content": format!("result A {SECRET}")
                    },
                    {
                        "type": "tool_result",
                        "tool_use_id": "tool-use-b",
                        "content": "result B"
                    }
                ]
            }
        }),
    ];
    let prompt = format!(
        "@ECHO@\n{}",
        source_events
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    );

    unsafe {
        common::setup_env(&mock, tmp.path(), &prompt, 3, 1)?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            &server.base_url,
        );
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token");
    }
    let mut runtime = common::guest_runtime_from_process_env()?;
    let run_id = runtime.config.run_id.clone();
    runtime.http = guest_agent::http::HttpClient::with_api_config(
        &server.base_url,
        "test-token",
        "",
        &run_id,
        Duration::ZERO,
    )?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = SecretMasker::from_raw(&encoded_secret);

    let result = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("Claude provider normalization should finish promptly")?;

    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert!(result.control_error.is_none());
    assert!(result.event_delivery.is_none());
    assert_eq!(result.last_event_sequence, Some(7));

    let delivered = server
        .requests()?
        .into_iter()
        .filter(|request| request.path == "/api/webhooks/agent/events")
        .map(|request| serde_json::from_str::<Value>(&request.body))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flat_map(|payload| {
            payload
                .get("events")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    assert_eq!(delivered.len(), 8);
    assert_eq!(
        delivered
            .iter()
            .map(|event| event["sequenceNumber"].as_u64())
            .collect::<Vec<_>>(),
        (0..8).map(Some).collect::<Vec<_>>()
    );
    assert_eq!(
        delivered
            .iter()
            .map(|event| event["type"].as_str())
            .collect::<Vec<_>>(),
        vec![
            Some("system"),
            Some("assistant"),
            Some("assistant"),
            Some("assistant"),
            Some("assistant"),
            Some("assistant"),
            Some("user"),
            Some("user"),
        ]
    );

    let semantic_events = &delivered[1..];
    assert!(semantic_events.iter().all(|event| {
        event
            .pointer("/message/content")
            .and_then(Value::as_array)
            .is_some_and(|content| content.len() == 1)
    }));
    assert_eq!(
        semantic_events
            .iter()
            .map(|event| event
                .pointer("/message/content/0/type")
                .and_then(Value::as_str))
            .collect::<Vec<_>>(),
        vec![
            Some("text"),
            Some("tool_use"),
            Some("tool_use"),
            Some("text"),
            Some("text"),
            Some("tool_result"),
            Some("tool_result"),
        ]
    );
    assert!(delivered[1..6].iter().all(|event| {
        event.pointer("/message/id").and_then(Value::as_str) == Some("msg-provider-normalization")
            && event.pointer("/message/model").and_then(Value::as_str) == Some("mock-claude")
    }));
    assert_eq!(
        delivered[2]
            .pointer("/message/content/0/id")
            .and_then(Value::as_str),
        Some("tool-use-a")
    );
    assert_eq!(
        delivered[2]
            .pointer("/message/content/0/input/command")
            .and_then(Value::as_str),
        Some("printf '%s' '***' '***'")
    );
    assert_eq!(
        delivered[3]
            .pointer("/message/content/0/id")
            .and_then(Value::as_str),
        Some("tool-use-b")
    );
    assert_eq!(
        delivered[6]
            .pointer("/message/content/0/tool_use_id")
            .and_then(Value::as_str),
        Some("tool-use-a")
    );
    assert_eq!(
        delivered[7]
            .pointer("/message/content/0/tool_use_id")
            .and_then(Value::as_str),
        Some("tool-use-b")
    );
    let delivered_json = serde_json::to_string(&delivered)?;
    assert!(!delivered_json.contains(SECRET));
    assert!(!delivered_json.contains(&encoded_secret));
    assert!(!delivered_json.contains("guest-tool-exec"));
    assert!(!delivered_json.contains("vm0.command"));
    assert!(delivered_json.contains("***"));

    let local_events = read_jsonl(runtime.paths.agent_log_file())?;
    assert_eq!(local_events, source_events.to_vec());
    assert_eq!(
        local_events[1]
            .pointer("/message/content")
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(5)
    );
    assert_eq!(
        local_events[2]
            .pointer("/message/content")
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(2)
    );
    assert!(serde_json::to_string(&local_events)?.contains(SECRET));
    assert_eq!(
        std::fs::read_to_string(runtime.paths.session_id_file())?,
        SESSION_ID
    );

    Ok(())
}

fn read_jsonl(path: &str) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    std::fs::read_to_string(path)?
        .lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}
