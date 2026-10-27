//! Pi CLI children receive canonical launch inputs and complete the official
//! RPC lifecycle through independently sequenced public content blocks.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use serde_json::Value;
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

#[tokio::test]
async fn guest_projects_pi_blocks_with_canonical_sequences_and_run_id()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;
    let bin_dir = tmp.path().join("bin");
    std::fs::create_dir_all(&bin_dir)?;
    let capture_path = tmp.path().join("canonical-run-id.txt");
    let payload_capture_path = tmp.path().join("pi-launch-payload-path.txt");
    let final_assistant_event_path = tmp.path().join("pi-final-assistant-event.jsonl");
    let large_tool_payload = "x".repeat(1024 * 1024);
    std::fs::write(
        &final_assistant_event_path,
        format!(
            "{}\n",
            serde_json::json!({
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "text",
                            "text": "official rpc projection 界<div>",
                        },
                        {
                            "type": "toolCall",
                            "id": "tool-4",
                            "name": "large_payload",
                            "arguments": { "payload": large_tool_payload },
                        },
                        {
                            "type": "text",
                            "text": "界🙂",
                        },
                        {
                            "type": "text",
                            "text": "完成</div>",
                        },
                    ],
                    "model": "deepseek-v4-flash",
                    "responseId": "response-3",
                    "usage": {
                        "input": 13,
                        "output": 7,
                        "cacheRead": 2,
                        "cacheWrite": 1,
                    },
                    "stopReason": "stop",
                    "timestamp": 6,
                },
            })
        ),
    )?;
    let okou = bin_dir.join("okou");
    std::fs::write(
        &okou,
        r#"#!/bin/sh
set -eu
test "$#" -eq 1
test "$1" = "__agent-loop"
test -n "${OKOU_RUN_ID:-}"
test -z "${OKOU_PI_LAUNCH_CONFIG:-}"
test -n "${OKOU_PI_LAUNCH_PAYLOAD_FILE:-}"
test -n "${PI_FINAL_ASSISTANT_EVENT_PATH:-}"
test -n "${HOME:-}"
printf '%s' "$OKOU_RUN_ID" > "$RUN_ID_CAPTURE_PATH"
printf '%s' "$OKOU_PI_LAUNCH_PAYLOAD_FILE" > "$PI_PAYLOAD_CAPTURE_PATH"
IFS= read -r state_command
case "$state_command" in
  *'"type":"get_state"'*) ;;
  *) exit 21 ;;
esac
printf '%s\n' '{"id":"00000000-0000-4000-8000-000000000123:pi:get-state","type":"response","command":"get_state","success":true,"data":{"sessionId":"11111111-1111-4111-8111-111111111111","sessionFile":"/home/user/.pi/agent/sessions/--home-user-workspace--/2026-08-14T00-00-00_11111111-1111-4111-8111-111111111111.jsonl"}}'
IFS= read -r prompt_command
case "$prompt_command" in
  *'"type":"prompt"'*) ;;
  *) exit 22 ;;
esac
case "$prompt_command" in
  *'"message":"verify canonical Pi run identity"'*) ;;
  *) exit 24 ;;
esac
printf '%s\n' '{"id":"00000000-0000-4000-8000-000000000123:pi:initial-prompt","type":"response","command":"prompt","success":true}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tool-1","name":"web_search","arguments":{"query":"find supersecret"}}],"model":"deepseek-v4-flash","responseId":"response-1","usage":{"input":5,"output":3,"cacheRead":2,"cacheWrite":1},"stopReason":"toolUse","timestamp":1}}'
printf '%s\n' '{"type":"message_end","message":{"role":"toolResult","toolCallId":"tool-1","toolName":"web_search","content":[{"type":"text","text":"result supersecret"}],"isError":false,"timestamp":2}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"text A supersecret"},{"type":"toolCall","id":"tool-2","name":"read_file","arguments":{"path":"supersecret/README.md"}},{"type":"toolCall","id":"tool-3","name":"render_image","arguments":{"format":"png"}},{"type":"text","text":"text B"}],"model":"deepseek-v4-flash","responseId":"response-2","usage":{"input":8,"output":5,"cacheRead":2,"cacheWrite":1},"stopReason":"toolUse","timestamp":3}}'
printf '%s\n' '{"type":"message_end","message":{"role":"toolResult","toolCallId":"tool-2","toolName":"read_file","content":[{"type":"text","text":"file contents"}],"isError":false,"timestamp":4}}'
printf '%s\n' '{"type":"message_end","message":{"role":"toolResult","toolCallId":"tool-3","toolName":"render_image","content":[{"type":"text","text":"render failed supersecret"},{"type":"image","data":"aW1hZ2U=","mimeType":"image/png"}],"isError":true,"timestamp":5}}'
cat "$PI_FINAL_ASSISTANT_EVENT_PATH"
printf '%s\n' '{"type":"agent_settled"}'
if IFS= read -r unexpected; then
  exit 23
fi
"#,
    )?;
    let mut permissions = std::fs::metadata(&okou)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&okou, permissions)?;

    let run_id = "00000000-0000-4000-8000-000000000123";
    let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), run_id)?;
    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var(guest_contracts::env::CLI_AGENT_TYPE_ENV, "pi");
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, run_id);
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            &server.base_url,
        );
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token");
        std::env::set_var(
            guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
        );
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("OKOU_TEST_PI_CLI_PATH", &okou);
        common::set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: "verify canonical Pi run identity".to_string(),
                append_system_prompt: "Your name is Okou.".to_string(),
                pi_launch_config: r#"{"schemaVersion":2}"#.to_string(),
                pi_model_config: "{}".to_string(),
                pi_session_id: "11111111-1111-4111-8111-111111111111".to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )?;
        common::set_user_env_file_env_for_test(
            &runtime_dir,
            &HashMap::from([
                // A user PATH without the installed launcher must not change
                // which Pi runtime executes this run.
                ("PATH".to_string(), "/usr/bin:/bin".to_string()),
                (
                    "RUN_ID_CAPTURE_PATH".to_string(),
                    capture_path.to_string_lossy().into_owned(),
                ),
                (
                    "PI_PAYLOAD_CAPTURE_PATH".to_string(),
                    payload_capture_path.to_string_lossy().into_owned(),
                ),
                (
                    "PI_FINAL_ASSISTANT_EVENT_PATH".to_string(),
                    final_assistant_event_path.to_string_lossy().into_owned(),
                ),
            ]),
        )?;
    }
    common::ensure_canonical_workspace_for_test()?;
    std::env::set_current_dir(tmp.path())?;

    let runtime = common::guest_runtime_from_process_env()?;
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(
            &runtime,
            &SecretMasker::from_raw("c3VwZXJzZWNyZXQ="),
            common::spawn_dummy_heartbeat(),
        ),
    )
    .await
    .expect("canonical Pi CLI process should finish")?;

    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert_eq!(result.last_event_sequence, Some(14));
    assert_eq!(
        result.jsonl_result.map(|summary| summary.status),
        Some(guest_agent::cli::JsonlResultStatus::Success)
    );
    let mut delivered_events = Vec::new();
    for request in server.requests()? {
        assert_eq!(request.path, "/api/webhooks/agent/events");
        assert_eq!(request.authorization.as_deref(), Some("Bearer test-token"));
        let body: Value = serde_json::from_str(&request.body)?;
        delivered_events.extend(
            body.get("events")
                .and_then(Value::as_array)
                .expect("Pi event request should contain an events array")
                .iter()
                .cloned(),
        );
    }
    delivered_events.sort_by_key(|event| {
        event
            .get("sequenceNumber")
            .and_then(Value::as_u64)
            .unwrap_or(u64::MAX)
    });
    assert_eq!(delivered_events.len(), 14);
    assert_eq!(
        delivered_events
            .iter()
            .map(|event| event["sequenceNumber"].as_u64())
            .collect::<Vec<_>>(),
        (1..15).map(Some).collect::<Vec<_>>()
    );
    assert!(delivered_events.iter().all(|event| {
        let serialized = event.to_string();
        !serialized.contains("supersecret")
    }));
    assert_eq!(delivered_events[0]["type"], "system");
    assert_eq!(delivered_events[0]["subtype"], "init");
    assert_eq!(
        delivered_events[0]["session_id"],
        "11111111-1111-4111-8111-111111111111"
    );
    assert_eq!(delivered_events[1]["type"], "assistant");
    assert_eq!(
        delivered_events[1].pointer("/message/content/0/type"),
        Some(&Value::String("tool_use".to_string()))
    );
    assert_eq!(delivered_events[1]["message"]["content"][0]["id"], "tool-1");
    assert_eq!(
        delivered_events[1]["message"]["content"][0]["name"],
        "web_search"
    );
    assert_eq!(
        delivered_events[1]["message"]["content"][0]["input"]["query"],
        "find ***"
    );

    assert_eq!(delivered_events[2]["type"], "user");
    assert_eq!(
        delivered_events[2].pointer("/message/content/0/type"),
        Some(&Value::String("tool_result".to_string()))
    );
    assert_eq!(
        delivered_events[2]["message"]["content"][0]["tool_use_id"],
        "tool-1"
    );
    assert_eq!(
        delivered_events[2]["message"]["content"][0]["content"][0]["text"],
        "result ***"
    );
    assert_eq!(
        delivered_events[2]["message"]["content"][0]["is_error"],
        false
    );

    assert_eq!(delivered_events[3]["type"], "assistant");
    assert_eq!(
        delivered_events[1..=12]
            .iter()
            .map(|event| event
                .pointer("/message/content")
                .and_then(Value::as_array)
                .map(Vec::len))
            .collect::<Vec<_>>(),
        vec![Some(1); 12]
    );
    assert_eq!(
        delivered_events[1..=12]
            .iter()
            .map(|event| event
                .pointer("/message/content/0/type")
                .and_then(Value::as_str))
            .collect::<Vec<_>>(),
        vec![
            Some("tool_use"),
            Some("tool_result"),
            Some("text"),
            Some("tool_use"),
            Some("tool_use"),
            Some("text"),
            Some("tool_result"),
            Some("tool_result"),
            Some("text"),
            Some("tool_use"),
            Some("text"),
            Some("text"),
        ]
    );
    assert!(delivered_events[3..=6].iter().all(|event| {
        event.pointer("/message/id").and_then(Value::as_str) == Some("response-2")
            && event.pointer("/message/model").and_then(Value::as_str) == Some("deepseek-v4-flash")
    }));
    assert_eq!(
        delivered_events[3].pointer("/message/content/0/text"),
        Some(&Value::String("text A ***".to_string()))
    );
    assert_eq!(delivered_events[4]["message"]["content"][0]["id"], "tool-2");
    assert_eq!(
        delivered_events[4]["message"]["content"][0]["input"]["path"],
        "***/README.md"
    );
    assert_eq!(delivered_events[5]["message"]["content"][0]["id"], "tool-3");
    assert_eq!(
        delivered_events[6].pointer("/message/content/0/text"),
        Some(&Value::String("text B".to_string()))
    );

    assert_eq!(delivered_events[7]["type"], "user");
    assert_eq!(
        delivered_events[7]["message"]["content"][0]["tool_use_id"],
        "tool-2"
    );
    assert_eq!(
        delivered_events[7]["message"]["content"][0]["content"][0]["text"],
        "file contents"
    );
    assert_eq!(
        delivered_events[7]["message"]["content"][0]["is_error"],
        false
    );

    assert_eq!(delivered_events[8]["type"], "user");
    assert_eq!(
        delivered_events[8]["message"]["content"][0]["tool_use_id"],
        "tool-3"
    );
    assert_eq!(
        delivered_events[8]["message"]["content"][0]["is_error"],
        true
    );
    assert_eq!(
        delivered_events[8].pointer("/message/content/0/content/0/text"),
        Some(&Value::String("render failed ***".to_string()))
    );
    assert_eq!(
        delivered_events[8].pointer("/message/content/0/content/1/source"),
        Some(&serde_json::json!({
            "type": "base64",
            "media_type": "image/png",
            "data": "aW1hZ2U=",
        }))
    );

    assert_eq!(delivered_events[9]["type"], "assistant");
    assert_eq!(
        delivered_events[9].pointer("/message/content/0/text"),
        Some(&Value::String(
            "official rpc projection 界<div>".to_string()
        ))
    );
    assert_eq!(
        delivered_events[10].pointer("/message/content/0/type"),
        Some(&Value::String("tool_use".to_string()))
    );
    assert_eq!(
        delivered_events[10]["message"]["content"][0]["id"],
        "tool-4"
    );
    assert_eq!(
        delivered_events[10]["message"]["content"][0]["name"],
        "large_payload"
    );
    assert_eq!(
        delivered_events[10]["message"]["content"][0]["input"]["payload"]
            .as_str()
            .map(str::len),
        Some(1024 * 1024)
    );
    assert_eq!(
        delivered_events[11].pointer("/message/content/0/text"),
        Some(&Value::String("界🙂".to_string()))
    );
    assert_eq!(
        delivered_events[12].pointer("/message/content/0/text"),
        Some(&Value::String("完成</div>".to_string()))
    );
    for assistant in &delivered_events[9..=12] {
        assert_eq!(assistant["message"]["id"], "response-3");
        assert_eq!(
            assistant["message"]["usage"],
            serde_json::json!({
                "input_tokens": 13,
                "output_tokens": 7,
                "cache_read_input_tokens": 2,
                "cache_creation_input_tokens": 1,
            })
        );
    }
    assert_eq!(delivered_events[13]["type"], "result");
    assert_eq!(delivered_events[13]["subtype"], "success");
    assert_eq!(
        delivered_events[13]["result"],
        "official rpc projection 界<div>\n\n界🙂\n\n完成</div>"
    );
    assert_eq!(std::fs::read_to_string(capture_path)?, run_id);

    let payload_path = std::fs::read_to_string(payload_capture_path)?;
    assert_eq!(
        payload_path,
        guest_contracts::runtime_paths::pi_launch_payload_file(&runtime_dir).to_string_lossy()
    );
    let payload: serde_json::Value = serde_json::from_slice(&std::fs::read(&payload_path)?)?;
    assert_eq!(payload["schemaVersion"], 1);
    assert_eq!(payload["appendSystemPrompt"], "Your name is Okou.");
    assert_eq!(payload["launchConfig"]["schemaVersion"], 2);
    assert_eq!(
        std::fs::metadata(&payload_path)?.permissions().mode() & 0o777,
        0o600
    );
    Ok(())
}
