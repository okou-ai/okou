//! Real RPC stdout -> projection -> private citation isolation -> canonical
//! sequencing/masking -> bounded sender/HTTP. The official session is immutable.
mod common;
use common::delivery_image;

use base64::Engine as _;
use guest_agent::env::{GuestConfig, GuestConfigRaw};
use guest_agent::masker::SecretMasker;
use guest_agent::paths::GuestPaths;
use guest_agent::run_context::GuestRuntime;
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

const LIMIT: usize = 4 * 1024 * 1024;
const SECRET: &str = "delivery-secret-value";
const NOTICE: &str = "[event content truncated for delivery]";
const CITATION: &str = "<oai-mem-citation>\n<citation_entries>\nprivate-memory.md:1-2|note=[private-note]\n</citation_entries>\n<rollout_ids>\n11111111-1111-4111-8111-111111111111\n</rollout_ids>\n</oai-mem-citation>";

fn assistant(id: &str, content: Value, failed: bool) -> Value {
    let mut message = json!({
        "role":"assistant", "responseId":id, "content":content,
        "model":"test-model", "usage":{"input":11,"output":7,"cacheRead":3,"cacheWrite":2},
        "stopReason":if failed {"error"} else {"stop"}, "timestamp":1
    });
    if failed && let Some(message) = message.as_object_mut() {
        message.insert("errorMessage".into(), json!("API Error: Overloaded"));
    }
    json!({"type":"message_end", "message":message})
}

fn tool_result(id: &str, content: Value, failed: bool) -> Value {
    json!({"type":"message_end", "message":{
        "role":"toolResult", "toolCallId":id, "toolName":"read", "isError":failed,
        "content":content, "timestamp":2
    }})
}
fn image(data: &str) -> Value {
    json!({"type":"image", "mimeType":"image/png", "data":data})
}

#[tokio::test]
async fn pi_rpc_bounds_delivery_and_preserves_truth_and_originals()
-> Result<(), Box<dyn std::error::Error>> {
    let small_image = delivery_image::png_base64(1, 1)?;
    let half_image = delivery_image::png_base64(1024, 512)?;
    let large_image = delivery_image::png_base64(1024, 1024)?;
    assert!(large_image.len() > LIMIT);
    assert!(half_image.len() < LIMIT && half_image.len() * 2 > LIMIT);
    let text = format!(
        "text-head-{SECRET}-{}-text-tail",
        "你好\"\\\n".repeat(450_000)
    );
    let input = format!("input-head-{SECRET}-{}-input-tail", "x".repeat(LIMIT));
    let messages = vec![
        assistant(
            "small",
            json!([{"type":"text","text":"unchanged small event"}]),
            false,
        ),
        assistant(
            "large",
            json!([{"type":"text","text":format!("{text}{CITATION}")}]),
            false,
        ),
        assistant(
            "split-citation",
            json!([
                {"type":"text","text":"first block"}, {"type":"text","text":format!("last block{CITATION}")}
            ]),
            false,
        ),
        assistant(
            "tool-input",
            json!([{"type":"toolCall","id":"tool-input-id","name":"read","arguments":{"path":input}}]),
            false,
        ),
        assistant(
            "aggregate",
            json!([{"type":"toolCall","id":"aggregate-id","name":"read","arguments":
            (0..32).map(|i| (format!("field-{i:02}"), json!("a".repeat(140_000)))).collect::<serde_json::Map<_,_>>() }]),
            false,
        ),
        assistant(
            "structure",
            json!([{"type":"toolCall","id":"structure-id","name":"read","arguments":{"values":vec![0;2_200_000]}}]),
            false,
        ),
        tool_result("tool-input-id", json!([{"type":"text","text":text}]), true),
        tool_result("small-image", json!([image(&small_image)]), false),
        tool_result("large-image", json!([image(&large_image)]), true),
        tool_result(
            "aggregate-images",
            json!([image(&half_image), image(&half_image), image(&small_image)]),
            false,
        ),
        assistant("terminal", json!([{"type":"text","text":input}]), false),
    ];
    let failed = [assistant(
        "failed",
        json!([{"type":"text","text":input}]),
        true,
    )];
    let mut failed_terminal = assistant(
        "failed-terminal",
        json!([{"type":"text","text":input}]),
        true,
    );
    failed_terminal["message"]
        .as_object_mut()
        .unwrap()
        .remove("errorMessage");
    let failed_terminal = [failed_terminal];
    for (messages, failed) in [
        (messages.as_slice(), false),
        (failed.as_slice(), true),
        (failed_terminal.as_slice(), true),
    ] {
        let PiDelivery {
            result,
            config,
            delivered,
            citations,
            log,
        } = deliver_pi_rpc(messages, &[SECRET]).await?;
        assert!(result.control_error.is_none(), "{:?}", result.control_error);
        assert_eq!(result.exit_code, if failed { 1 } else { 0 });
        let terminal = delivered.last().ok_or("missing terminal")?;
        assert_eq!(terminal["type"], "result");
        assert_eq!(terminal["is_error"], failed);
        let public = serde_json::to_string(&delivered)?;
        assert!(!public.contains(SECRET));
        assert!(
            !public.contains("private-memory")
                && !public.contains("private-note")
                && !public.contains("memoryCitation")
        );
        let reductions = log
            .lines()
            .filter(|line| line.contains("Pi event reduced for delivery"))
            .collect::<Vec<_>>();
        assert_eq!(
            reductions.len(),
            delivered
                .iter()
                .filter(|e| e.to_string().contains("for delivery"))
                .count()
        );
        assert!(reductions.iter().all(|line| line.contains("[INFO]")
            && !line.contains("[WARN]")
            && !line.contains("[ERROR]")));
        for sentinel in [
            SECRET,
            "private-memory",
            "private-note",
            "text-head",
            "input-head",
            "base64",
            "image/png",
        ] {
            assert!(reductions.iter().all(|line| !line.contains(sentinel)));
        }
        if failed {
            assert!(log.contains("[WARN]") && log.contains("Pi JSONL failure result"));
            let failure = guest_agent::failure_diagnostics::cli_nonzero_failure_for_config(
                &config, None, &result,
            );
            assert_eq!(
                failure.diagnostic.failure_detail_source,
                Some(guest_contracts::diagnostics::FailureDetailSource::PiResult)
            );
            if messages[0]["message"].get("errorMessage").is_some() {
                assert_eq!(terminal["result"], "API Error: Overloaded");
            } else {
                assert!(
                    terminal["result"]
                        .as_str()
                        .is_some_and(|text| text.contains("bytes truncated for delivery"))
                );
            }
            continue;
        }
        assert_eq!(citations.len(), 2);
        for citation in &citations {
            assert_eq!(
                citation["citation"],
                json!({"entries":[{"path":"private-memory.md","lineStart":1,"lineEnd":2,"note":"private-note"}],"rolloutIds":["11111111-1111-4111-8111-111111111111"]})
            );
        }
        let find_message = |id: &str| {
            delivered
                .iter()
                .find(|e| e["message"]["id"] == id)
                .expect("message delivered")
        };
        let small = find_message("small");
        assert_eq!(
            small["message"],
            json!({"id":"small","role":"assistant","model":"test-model","usage":{"input_tokens":11,"output_tokens":7,"cache_read_input_tokens":3,"cache_creation_input_tokens":2},"content":[{"type":"text","text":"unchanged small event"}]})
        );
        let large = find_message("large");
        assert_eq!(large["message"]["usage"], small["message"]["usage"]);
        let large_text = large["message"]["content"][0]["text"]
            .as_str()
            .ok_or("missing text")?;
        assert!(
            large_text.starts_with("text-head-***-")
                && large_text.ends_with("-text-tail")
                && large_text.contains("bytes truncated for delivery")
        );
        let split = delivered
            .iter()
            .filter(|e| e["message"]["id"] == "split-citation")
            .collect::<Vec<_>>();
        assert_eq!(split.len(), 2);
        assert_eq!(citations[1]["sequenceNumber"], split[1]["sequenceNumber"]);
        let structure = &find_message("structure")["message"]["content"][0];
        assert_eq!(structure["id"], "structure-id");
        assert_eq!(structure["name"], "read");
        assert_eq!(structure["input"], json!({"_delivery_notice":NOTICE}));
        let tool = |id: &str| {
            &delivered
                .iter()
                .find(|e| e["message"]["content"][0]["tool_use_id"] == id)
                .expect("tool delivered")["message"]["content"][0]
        };
        assert_eq!(tool("tool-input-id")["is_error"], true);
        assert_eq!(
            tool("small-image")["content"][0]["source"]["data"],
            small_image
        );
        assert_eq!(tool("large-image")["is_error"], true);
        assert_eq!(
            tool("large-image")["content"],
            json!([{"type":"text","text":"[image omitted for delivery]"}])
        );
        assert_eq!(
            tool("aggregate-images")["content"][0],
            json!({"type":"text","text":"[image omitted for delivery]"})
        );
        assert_eq!(
            tool("aggregate-images")["content"][1]["source"]["data"],
            half_image
        );
        assert_eq!(
            tool("aggregate-images")["content"][2]["source"]["data"],
            small_image
        );
        assert!(
            terminal["result"]
                .as_str()
                .is_some_and(|s| s.contains("bytes truncated for delivery"))
        );
    }
    Ok(())
}

const REDACTED_ROLLOUT: &str = "22222222-2222-4222-8222-222222222222";
const RETAINED_ROLLOUT: &str = "11111111-1111-4111-8111-111111111111";

#[tokio::test]
async fn pi_rpc_isolates_citations_before_masking_field_names()
-> Result<(), Box<dyn std::error::Error>> {
    let citation = format!(
        "<oai-mem-citation>\n<citation_entries>\nprivate-memory-{SECRET}.md:17-23|note=[private-note-{SECRET}]\n</citation_entries>\n<rollout_ids>\n{RETAINED_ROLLOUT}\n{REDACTED_ROLLOUT}\n</rollout_ids>\n</oai-mem-citation>"
    );
    let id_only = format!(
        "<oai-mem-citation>\n<rollout_ids>\n{REDACTED_ROLLOUT}\n</rollout_ids>\n</oai-mem-citation>"
    );
    for collision_secrets in [
        vec!["memoryCitation"],
        vec!["message"],
        vec![
            "entries",
            "rolloutIds",
            "lineStart",
            "lineEnd",
            "sequenceNumber",
        ],
    ] {
        // Oversized parent-key collisions retain their existing admission
        // rejection, covered separately below. Other cases must fully drain.
        let oversized = !collision_secrets.contains(&"message");
        let mut messages = vec![assistant(
            "private-small",
            json!([{"type":"text","text":format!("visible-{SECRET}-{}{citation}", collision_secrets[0])}]),
            false,
        )];
        if oversized {
            messages.push(assistant(
                "private-large",
                json!([{"type":"text","text":format!("large-{SECRET}-{}{citation}", "x".repeat(LIMIT))}]),
                false,
            ));
        }
        messages.extend([
            assistant(
                "private-split",
                json!([
                    {"type":"text","text":"first block"},
                    {"type":"text","text":format!("last block{citation}")}
                ]),
                false,
            ),
            assistant(
                "private-id-only",
                json!([{"type":"text","text":format!("redacted citation only{id_only}")}]),
                false,
            ),
            assistant(
                "private-terminal",
                json!([{"type":"text","text":format!("done-{SECRET}")}]),
                false,
            ),
        ]);
        let mut secrets = collision_secrets.clone();
        secrets.extend([SECRET, REDACTED_ROLLOUT]);
        let delivery = deliver_pi_rpc(&messages, &secrets).await?;
        assert!(
            delivery.result.control_error.is_none(),
            "{:?}",
            delivery.result.control_error
        );
        assert_eq!(delivery.result.exit_code, 0);
        let expected_last = if oversized { 8 } else { 7 };
        assert_eq!(delivery.result.last_event_sequence, Some(expected_last));
        let terminal = delivery.delivered.last().ok_or("missing terminal")?;
        assert_eq!(terminal["type"], "result");
        assert_eq!(terminal["result"], "done-***");
        assert_public_citation_isolation(&delivery.delivered);
        let expected_citation = json!({
            "entries":[{"path":"private-memory-***.md","lineStart":17,"lineEnd":23,"note":"private-note-***"}],
            "rolloutIds":[RETAINED_ROLLOUT]
        });
        let expected_sequences = if oversized { vec![2, 3, 5] } else { vec![2, 4] };
        assert_eq!(
            delivery.citations,
            expected_sequences
                .iter()
                .map(|sequence| json!({"sequenceNumber":sequence,"citation":expected_citation}))
                .collect::<Vec<_>>()
        );
        let message_key = if oversized { "message" } else { "***" };
        assert_eq!(
            delivery.delivered[1][message_key]["content"][0]["text"],
            "visible-***-***"
        );
        if !oversized {
            assert!(delivery.delivered[1].get("message").is_none());
        } else {
            assert!(
                delivery.delivered[2]["message"]["content"][0]["text"]
                    .as_str()
                    .is_some_and(|text| text.contains("bytes truncated for delivery"))
            );
        }
        let split_last = if oversized { 4 } else { 3 };
        assert_eq!(
            delivery.delivered[split_last][message_key]["content"][0]["text"],
            "last block"
        );
        assert_eq!(
            delivery.delivered[split_last]["sequenceNumber"],
            *expected_sequences.last().unwrap()
        );
    }
    Ok(())
}

#[tokio::test]
async fn pi_rpc_rejects_oversized_masked_parent_without_publishing_private_citations()
-> Result<(), Box<dyn std::error::Error>> {
    let messages = [assistant(
        "private-large",
        json!([{"type":"text","text":format!("{}{CITATION}", "x".repeat(LIMIT))}]),
        false,
    )];
    let delivery = deliver_pi_rpc(&messages, &["message"]).await?;
    assert!(delivery.result.control_error.is_some());
    assert!(
        delivery
            .delivered
            .iter()
            .all(|event| event["type"] == "system")
    );
    assert!(delivery.citations.is_empty());
    assert!(
        delivery
            .result
            .last_event_sequence
            .is_none_or(|sequence| sequence < 2)
    );
    assert_public_citation_isolation(&delivery.delivered);
    Ok(())
}

fn assert_public_citation_isolation(events: &[Value]) {
    for event in events {
        let public = event.to_string();
        for private_value in [
            "private-memory",
            "private-note",
            RETAINED_ROLLOUT,
            REDACTED_ROLLOUT,
            "oai-mem-citation",
            SECRET,
        ] {
            assert!(
                !public.contains(private_value),
                "private data in public event"
            );
        }
    }
}

struct PiDelivery {
    result: guest_agent::cli::CliExecutionResult,
    config: GuestConfig,
    delivered: Vec<Value>,
    citations: Vec<Value>,
    log: String,
}

// The guest system-log override is process-global Rust state.
static DELIVERY_FIXTURE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn deliver_pi_rpc(
    messages: &[Value],
    secrets: &[&str],
) -> Result<PiDelivery, Box<dyn std::error::Error>> {
    let _fixture_lock = DELIVERY_FIXTURE_LOCK.lock().await;
    let tmp = tempfile::tempdir()?;
    let mut server = common::ControlledHttpServer::start().await?;
    let gate_path = tmp.path().join("delivery.sock");
    let gate = tokio::net::UnixListener::bind(&gate_path)?;
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin)?;
    let events_path = tmp.path().join("rpc-events.jsonl");
    let session_id = uuid::Uuid::new_v4().to_string();
    let session_dir = api_contracts::generated::constants::runners::paths::CANONICAL_PI_SESSION_DIR;
    std::fs::create_dir_all(session_dir)?;
    let session_file = tempfile::Builder::new()
        .prefix("delivery-")
        .suffix(&format!("_{session_id}.jsonl"))
        .tempfile_in(session_dir)?;
    let session_path = session_file.path();
    let original = messages
        .iter()
        .map(|event| format!("{event}\n"))
        .collect::<String>();
    assert!(original.lines().all(
        |line| line.len() < guest_contracts::stdout_framing::ORDINARY_CLI_STDOUT_MAX_LINE_BYTES
    ));
    std::fs::write(&events_path, &original)?;
    let mut session = format!(
        "{}\n",
        json!({"type":"session","version":3,"id":session_id,"timestamp":"2026-09-11T00:00:00Z","cwd":"/home/user/workspace"})
    );
    for (index, event) in messages.iter().enumerate() {
        session.push_str(&format!("{}\n",json!({"type":"message","id":format!("message-{index}"),"parentId":if index == 0 {None} else {Some(format!("message-{}",index-1))},"timestamp":"2026-09-11T00:00:00Z","message":event["message"]})));
    }
    std::fs::write(session_path, &session)?;
    let commands_path = tmp.path().join("commands.jsonl");
    let npx = bin.join("npx");
    std::fs::write(&npx, include_str!("fixtures/pi_rpc_delivery.py"))?;
    std::fs::set_permissions(&npx, std::fs::Permissions::from_mode(0o700))?;
    let run_id = "00000000-0000-4000-8000-000000000124";
    let paths = GuestPaths::from_home(tmp.path(), run_id)?;
    let payload_path = common::write_run_payload_file_for_test(
        paths.runtime_dir(),
        &guest_contracts::env::RunPayload {
            prompt: "test bounded Pi delivery".into(),
            pi_launch_config:
                r#"{"schemaVersion":2,"apiFirstTurn":{"sandboxEventSequenceStart":1}}"#.into(),
            pi_model_config: "{}".into(),
            pi_session_id: session_id.clone(),
            secret_values: secrets
                .iter()
                .map(|secret| base64::engine::general_purpose::STANDARD.encode(secret))
                .collect::<Vec<_>>()
                .join(","),
            ..Default::default()
        },
    )?;
    let mut config = GuestConfig::from_raw(GuestConfigRaw {
        run_id: run_id.into(),
        api_url: server.base_url.clone(),
        api_token: "test-token".into(),
        cli_agent_type: "pi".into(),
        home: Some(tmp.path().to_string_lossy().into_owned()),
        run_payload_file: payload_path.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(paths.runtime_dir().into()),
        ..Default::default()
    })?;
    config.user_env.extend([
        ("PATH".into(), format!("{}:/usr/bin:/bin", bin.display())),
        (
            "CLI_PKG_URL".into(),
            "https://example.invalid/cli.tgz".into(),
        ),
        (
            "PI_EVENTS_PATH".into(),
            events_path.to_string_lossy().into_owned(),
        ),
        ("PI_SESSION_ID".into(), session_id),
        (
            "PI_DELIVERY_GATE".into(),
            gate_path.to_string_lossy().into_owned(),
        ),
        (
            "PI_SESSION_PATH".into(),
            session_path.to_string_lossy().into_owned(),
        ),
        (
            "PI_COMMANDS_PATH".into(),
            commands_path.to_string_lossy().into_owned(),
        ),
    ]);
    let runtime = GuestRuntime {
        http: guest_agent::http::HttpClient::with_api_config(
            &server.base_url,
            "test-token",
            "",
            run_id,
            Duration::ZERO,
        )?,
        config,
        paths,
        workload_containment: None,
        process_control_endpoint: None,
    };
    let _system_log = common::SystemLogOverrideGuard::set(runtime.paths.system_log_file());
    common::ensure_canonical_workspace_for_test()?;
    let masker = SecretMasker::from_config(&runtime.config);
    let mut sequence = 1u32;
    let ends = messages
        .iter()
        .map(|event| {
            sequence +=
                if event.pointer("/message/role").and_then(Value::as_str) == Some("assistant") {
                    event
                        .pointer("/message/content")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len) as u32
                } else {
                    1
                };
            sequence
        })
        .collect::<Vec<_>>();
    let serving = async {
        use tokio::io::AsyncWriteExt;
        let (mut gate, _) = gate.accept().await?;
        let mut next = 0;
        loop {
            let request = server.next_request(Duration::from_secs(10)).await?;
            let last = common::event_request_sequences(&request.request)?
                .into_iter()
                .max()
                .ok_or("empty event request")?;
            request.respond(200)?;
            if ends.get(next).is_some_and(|end| last >= *end) {
                gate.write_all(b"x").await?;
                next += 1;
            }
            if last == sequence + 1 {
                break;
            }
        }
        Ok::<_, Box<dyn std::error::Error>>(())
    };
    let result = {
        let execution = common::execute_cli_for_runtime(&runtime, &masker, None);
        tokio::pin!(execution);
        tokio::time::timeout(Duration::from_secs(30), async {
            tokio::select! {
                result = &mut execution => Ok::<_,Box<dyn std::error::Error>>(result?),
                served = serving => { served?; Ok(execution.await?) }
            }
        })
        .await??
    };
    let requests = server.requests()?;
    let mut delivered = Vec::new();
    let mut citations = Vec::new();
    for request in &requests {
        assert!(request.body.len() <= LIMIT);
        let payload: Value = serde_json::from_str(&request.body)?;
        delivered.extend(
            payload
                .get("events")
                .and_then(Value::as_array)
                .ok_or("missing events")?
                .iter()
                .cloned(),
        );
        citations.extend(
            payload
                .pointer("/piMemoryCitationTransport/citations")
                .and_then(Value::as_array)
                .ok_or("missing private transport")?
                .iter()
                .cloned(),
        );
    }
    assert_eq!(
        delivered
            .iter()
            .map(|e| e["sequenceNumber"].as_u64())
            .collect::<Vec<_>>(),
        (1..=delivered.len() as u64).map(Some).collect::<Vec<_>>()
    );
    if result.control_error.is_none() {
        assert_eq!(
            result.last_event_sequence,
            (!delivered.is_empty()).then_some(delivered.len() as u32)
        );
    } else {
        // Abort can win after HTTP receipt but before its response is observed.
        assert!(result.last_event_sequence.unwrap_or(0) <= delivered.len() as u32);
    }
    assert_eq!(std::fs::read_to_string(&events_path)?, original);
    assert_eq!(std::fs::read_to_string(session_path)?, session);
    let local = std::fs::read_to_string(runtime.paths.agent_log_file())?;
    for event in messages {
        let expected = event.to_string();
        assert!(local.lines().any(|line| line == expected));
    }
    assert!(!local.contains("for delivery"));
    let commands = std::fs::read_to_string(commands_path)?;
    assert_eq!(commands.lines().count(), 2);
    assert!(!commands.contains("for delivery"));
    let log = std::fs::read_to_string(runtime.paths.system_log_file())?;
    Ok(PiDelivery {
        result,
        config: runtime.config,
        delivered,
        citations,
        log,
    })
}
