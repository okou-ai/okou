//! Oversized upload copies must preserve successful execution and native history.

use crate::common;

use base64::Engine as _;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::process::Command;

const LIMIT: usize = 4 * 1024 * 1024;
const SESSION_ID: &str = "00000000-0000-4000-8000-000000000042";
const SECRET: &str = "oversized-delivery-secret";

fn large_text(label: &str) -> Value {
    Value::String(format!(
        "head-{label}-{SECRET}-{}-tail-{label}",
        "你\"\\\n".repeat(LIMIT / 6)
    ))
}

#[tokio::test]
async fn oversized_claude_events_are_reduced_or_skipped_while_run_completes()
-> Result<(), Box<dyn std::error::Error>> {
    common::ensure_canonical_workspace_for_test()?;
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let home = tmp.path().join("home");
    let runtime_dir = tmp.path().join("runtime");
    std::fs::create_dir_all(&home)?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;
    let mut text = json!({"type":"assistant","message":{"id":"text","role":"assistant","usage":{"input_tokens":7},"content":[{"type":"text","text":null}]}});
    text["message"]["content"][0]["text"] = large_text("text");
    let mut input = json!({"type":"assistant","message":{"id":"input","role":"assistant","content":[{"type":"tool_use","id":"tool-1","name":"Read","input":{"path":null}}]}});
    input["message"]["content"][0]["input"]["path"] = large_text("input");
    let mut output = json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","is_error":true,"content":null}]}});
    output["message"]["content"][0]["content"] = large_text("output");
    let mut image = json!({"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":null}}]}});
    image["message"]["content"][0]["source"]["data"] =
        Value::String(common::delivery_image::png_base64(1024, 1024)?);
    let mut irreducible = json!({"type":"assistant","message":{"id":null,"role":"assistant","content":[{"type":"text","text":"protected identity cannot be truncated"}]}});
    irreducible["message"]["id"] = Value::String("protected-identity-".repeat(LIMIT / 16));
    let mut result = json!({"type":"result","subtype":"success","session_id":SESSION_ID,"is_error":false,"usage":{"input_tokens":7,"output_tokens":9},"result":null});
    result["result"] = large_text("result");
    let mut tail = json!({"type":"result","subtype":"success","session_id":SESSION_ID,"is_error":false,"result":"final native result","protectedMetadata":null});
    tail["protectedMetadata"] = Value::String("protected-tail-".repeat(LIMIT / 12));
    let mut source = Vec::new();
    for event in [
        json!({"type":"system","subtype":"init","session_id":SESSION_ID,"model":"mock-claude"}),
        json!({"type":"assistant","message":{"id":"ordinary","role":"assistant","content":[{"type":"text","text":"ordinary text"}]}}),
        text,
        input,
        output,
        image,
        irreducible,
        json!({"type":"assistant","message":{"id":"latest","role":"assistant","content":[{"type":"text","text":"later output survives the gap"}]}}),
        result,
        tail,
    ] {
        serde_json::to_writer(&mut source, &event)?;
        source.push(b'\n');
    }
    let source_path = tmp.path().join("original.jsonl");
    std::fs::write(&source_path, &source)?;
    let mut prompt = b"@ECHO@\n".to_vec();
    prompt.extend(source);
    let payload = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: String::from_utf8(prompt)?,
            secret_values: base64::engine::general_purpose::STANDARD.encode(SECRET),
            ..Default::default()
        },
    )?;
    let run_id = "claude-oversized-success";
    let paths = guest_agent::paths::GuestPaths::from_runtime_dir(runtime_dir.clone());
    let output = common::command_output_with_timeout(
        Command::new(env!("CARGO_BIN_EXE_guest-agent"))
            .env_clear()
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("SHELL", "/bin/sh")
            .env("HOME", &home)
            .env("OKOU_TEST_CLAUDE_CONFIG_DIR", home.join(".claude"))
            .env(guest_contracts::env::CLI_AGENT_TYPE_ENV, "claude-code")
            .env(guest_contracts::env::USE_MOCK_CLAUDE_ENV, "true")
            .env(guest_contracts::env::CANONICAL_MOCK_CLAUDE_PATH_ENV, mock)
            .env(guest_contracts::env::RUN_ID_ENV, run_id)
            .env(
                guest_contracts::env::CANONICAL_API_URL_ENV,
                &server.base_url,
            )
            .env(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token")
            .env(
                guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
                "00000000-0000-4000-8000-000000000abc",
            )
            .env(
                guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
                payload,
            )
            .env(
                guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
                runtime_dir,
            ),
        Duration::from_secs(30),
        "oversized event delivery prevented successful completion",
    )
    .await?;
    let stderr = String::from_utf8(output.stderr)?;
    assert_eq!(output.status.code(), Some(0), "{stderr}");
    for sequence in [6, 9] {
        assert!(
            stderr.contains(&format!(
                "Discarding oversized Claude Code event at sequence {sequence}"
            )),
            "{stderr}"
        );
    }
    assert!(!stderr.contains(SECRET));
    assert!(!stderr.contains("protected-identity-"));
    assert!(!stderr.contains("protected-tail-"));

    let requests = server
        .wait_for_quiet(Duration::from_millis(50), Duration::from_secs(5))
        .await?;
    let mut delivered = Vec::new();
    let mut completions = Vec::new();
    for request in requests.into_iter().filter_map(|record| match record {
        common::RecordedHttpEvent::Request(request) => Some(request),
        _ => None,
    }) {
        if request.path == "/api/webhooks/agent/events" {
            assert!(request.body.len() <= LIMIT);
            assert!(!request.body.contains(SECRET));
            let mut body: Value = serde_json::from_str(&request.body)?;
            delivered.append(body["events"].as_array_mut().ok_or("missing events")?);
        } else if request.path == "/api/webhooks/agent/complete" {
            completions.push(serde_json::from_str::<Value>(&request.body)?);
        }
    }
    assert_eq!(
        delivered
            .iter()
            .map(|event| event["sequenceNumber"].as_u64())
            .collect::<Vec<_>>(),
        [0, 1, 2, 3, 4, 5, 7, 8].map(Some)
    );
    assert_eq!(
        delivered[1]["message"]["content"][0]["text"],
        "ordinary text"
    );
    for (index, path, label) in [
        (2, "/message/content/0/text", "text"),
        (3, "/message/content/0/input/path", "input"),
        (4, "/message/content/0/content", "output"),
        (7, "/result", "result"),
    ] {
        let text = delivered[index]
            .pointer(path)
            .and_then(Value::as_str)
            .ok_or("reduced content missing")?;
        assert!(text.starts_with(&format!("head-{label}-***-")));
        assert!(text.ends_with(&format!("-tail-{label}")));
        assert!(text.contains("bytes truncated for delivery"));
    }
    assert_eq!(delivered[3]["message"]["content"][0]["id"], "tool-1");
    assert_eq!(delivered[3]["message"]["content"][0]["name"], "Read");
    assert_eq!(
        delivered[4]["message"]["content"][0]["tool_use_id"],
        "tool-1"
    );
    assert_eq!(delivered[4]["message"]["content"][0]["is_error"], true);
    assert_eq!(
        delivered[5]["message"]["content"][0],
        json!({"type":"text","text":"[image omitted for delivery]"})
    );
    assert_eq!(
        delivered[6]["message"]["content"][0]["text"],
        "later output survives the gap"
    );
    assert_eq!(delivered[7]["is_error"], false);
    assert_eq!(
        delivered[7]["usage"],
        json!({"input_tokens":7,"output_tokens":9})
    );
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0]["exitCode"], 0);
    assert_eq!(completions[0]["lastEventSequence"], 8);
    assert_eq!(
        completions[0]["completion"]["cliAgentSessionId"],
        SESSION_ID
    );
    let source = std::fs::read_to_string(source_path)?;
    let native = home
        .join(".claude/projects/-home-user-workspace")
        .join(format!("{SESSION_ID}.jsonl"));
    assert_eq!(std::fs::read_to_string(native)?, source);
    let log = std::fs::read_to_string(paths.agent_log_file())?;
    assert!(
        source
            .lines()
            .all(|line| log.lines().any(|actual| actual == line))
    );
    Ok(())
}
