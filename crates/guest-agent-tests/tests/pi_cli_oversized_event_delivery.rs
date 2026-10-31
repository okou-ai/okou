//! Real RPC stdout -> projection -> canonical
//! sequencing/masking -> bounded sender/HTTP. The official session is immutable.
use common::delivery_image;
use guest_agent_tests as common;

use base64::Engine as _;
use guest_agent::env::{GuestConfig, GuestConfigRaw};
use guest_agent::masker::SecretMasker;
use guest_agent::paths::GuestPaths;
use guest_agent::run_context::GuestRuntime;
use serde_json::{Value, json};
use std::io::{BufWriter, Write};
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

const LIMIT: usize = 4 * 1024 * 1024;
const SECRET: &str = "delivery-secret-value";
const NOTICE: &str = "[event content truncated for delivery]";

fn message_end(message: serde_json::Map<String, Value>) -> Value {
    Value::Object(serde_json::Map::from_iter([
        ("type".into(), "message_end".into()),
        ("message".into(), Value::Object(message)),
    ]))
}

fn assistant(id: &str, content: Value, failed: bool) -> Value {
    let mut message = serde_json::Map::from_iter([
        ("role".into(), "assistant".into()),
        ("responseId".into(), id.into()),
        ("content".into(), content),
        ("model".into(), "test-model".into()),
        (
            "usage".into(),
            json!({"input":11,"output":7,"cacheRead":3,"cacheWrite":2}),
        ),
        (
            "stopReason".into(),
            if failed { "error" } else { "stop" }.into(),
        ),
        ("timestamp".into(), 1.into()),
    ]);
    if failed {
        message.insert("errorMessage".into(), "API Error: Overloaded".into());
    }
    message_end(message)
}

fn tool_result(id: &str, content: Value, failed: bool) -> Value {
    message_end(serde_json::Map::from_iter([
        ("role".into(), "toolResult".into()),
        ("toolCallId".into(), id.into()),
        ("toolName".into(), "read".into()),
        ("isError".into(), failed.into()),
        ("content".into(), content),
        ("timestamp".into(), 2.into()),
    ]))
}

#[test]
fn owned_pi_message_fixtures_preserve_canonical_bytes() {
    for content in [
        json!([]),
        json!([{"type":"text","text":"你好\"\\\n\0"}]),
        json!([
            {"type":"toolCall","id":"nested","arguments":{"values":[null,true,19]}},
            {"type":"image","mimeType":"image/png","data":"synthetic"}
        ]),
    ] {
        for failed in [false, true] {
            let mut original_message = json!({
                "role":"assistant", "responseId":"message", "content":content,
                "model":"test-model", "usage":{"input":11,"output":7,"cacheRead":3,"cacheWrite":2},
                "stopReason":if failed {"error"} else {"stop"}, "timestamp":1
            });
            if failed {
                original_message["errorMessage"] = json!("API Error: Overloaded");
            }
            let expected = json!({"type":"message_end", "message":original_message});
            assert_eq!(
                assistant("message", content.clone(), failed).to_string(),
                expected.to_string()
            );
            let expected = json!({"type":"message_end", "message":{
                "role":"toolResult", "toolCallId":"tool", "toolName":"read", "isError":failed,
                "content":content, "timestamp":2
            }});
            assert_eq!(
                tool_result("tool", content.clone(), failed).to_string(),
                expected.to_string()
            );
        }
    }
}

#[derive(serde::Serialize)]
struct PiImage<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(rename = "mimeType")]
    mime_type: &'static str,
    data: &'a str,
}

fn image(data: &str) -> PiImage<'_> {
    PiImage {
        kind: "image",
        mime_type: "image/png",
        data,
    }
}

#[test]
fn borrowed_pi_image_fixture_preserves_canonical_bytes() {
    for data in ["", "AA==", "你好\"\\\n\0"] {
        assert_eq!(
            json!([image(data), image(data)]).to_string(),
            json!([
                {"type":"image", "mimeType":"image/png", "data":data},
                {"type":"image", "mimeType":"image/png", "data":data}
            ])
            .to_string()
        );
    }
}

fn tool_call_content(id: &str, arguments: Value) -> Value {
    Value::Array(vec![Value::Object(serde_json::Map::from_iter([
        ("type".into(), "toolCall".into()),
        ("id".into(), id.into()),
        ("name".into(), "read".into()),
        ("arguments".into(), arguments),
    ]))])
}

#[test]
fn owned_pi_tool_call_fixture_preserves_canonical_bytes() {
    for arguments in [
        Value::Null,
        json!({}),
        json!({"path":"你好\"\\\n\0", "values":[0, "", null]}),
        json!({"z-field":"last", "a-field":{"nested":[true, 7]}}),
    ] {
        for id in ["", "tool-input-id", "你好\"\\\n\0"] {
            let expected = json!([{
                "type":"toolCall", "id":id, "name":"read", "arguments":arguments
            }]);
            assert_eq!(
                tool_call_content(id, arguments.clone()).to_string(),
                expected.to_string()
            );
        }
    }
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
    // Numeric values reach the traversal bound without becoming reduction
    // candidates. The final string makes the event oversized after that bound.
    let mut structure_values = vec![json!(0); 4_100];
    structure_values.push(json!("x".repeat(LIMIT)));
    let messages = vec![
        assistant(
            "small",
            json!([{"type":"text","text":"unchanged small event"}]),
            false,
        ),
        assistant("large", json!([{"type":"text","text":text}]), false),
        assistant(
            "split-text",
            json!([
                {"type":"text","text":"first block"}, {"type":"text","text":"last block"}
            ]),
            false,
        ),
        assistant(
            "tool-input",
            tool_call_content("tool-input-id", json!({"path":input})),
            false,
        ),
        assistant(
            "aggregate",
            tool_call_content(
                "aggregate-id",
                Value::Object(
                    (0..32)
                        .map(|i| (format!("field-{i:02}"), Value::String("a".repeat(140_000))))
                        .collect(),
                ),
            ),
            false,
        ),
        assistant(
            "structure",
            tool_call_content(
                "structure-id",
                Value::Object(serde_json::Map::from_iter([(
                    "values".into(),
                    Value::Array(structure_values),
                )])),
            ),
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
            log,
        } = deliver_pi_rpc(messages, &[SECRET]).await?;
        assert!(result.control_error.is_none(), "{:?}", result.control_error);
        assert_eq!(result.exit_code, if failed { 1 } else { 0 });
        let terminal = delivered.last().ok_or("missing terminal")?;
        assert_eq!(terminal["type"], "result");
        assert_eq!(terminal["is_error"], failed);
        assert!(
            !delivered
                .iter()
                .any(|event| common::contains_json_text(event, SECRET))
        );
        let reductions = log
            .lines()
            .filter(|line| line.contains("Pi event reduced for delivery"))
            .collect::<Vec<_>>();
        assert_eq!(
            reductions.len(),
            delivered
                .iter()
                .filter(|event| common::contains_json_text(event, "for delivery"))
                .count()
        );
        assert!(reductions.iter().all(|line| line.contains("[INFO]")
            && !line.contains("[WARN]")
            && !line.contains("[ERROR]")));
        for sentinel in [SECRET, "text-head", "input-head", "base64", "image/png"] {
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
            .filter(|e| e["message"]["id"] == "split-text")
            .collect::<Vec<_>>();
        assert_eq!(split.len(), 2);
        assert_eq!(split[0]["message"]["content"][0]["text"], "first block");
        assert_eq!(split[1]["message"]["content"][0]["text"], "last block");
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

#[tokio::test]
async fn pi_rpc_skips_irreducible_events_and_delivers_later_output()
-> Result<(), Box<dyn std::error::Error>> {
    let messages = [
        assistant(
            "large",
            json!([{"type":"text","text":"x".repeat(LIMIT)}]),
            false,
        ),
        assistant(
            "later",
            json!([{"type":"text","text":"later output"}]),
            false,
        ),
    ];
    let delivery = deliver_pi_rpc_with_skips(&messages, &["message"], &[2]).await?;
    assert_eq!(delivery.result.exit_code, common::CLEAN_EXIT);
    assert!(delivery.result.control_error.is_none());
    assert_eq!(
        delivery.delivered[1]["***"]["content"][0]["text"],
        "later output"
    );
    assert_eq!(delivery.result.last_event_sequence, Some(4));
    assert!(
        delivery
            .log
            .contains("Discarding oversized Pi event at sequence 2")
    );
    Ok(())
}

struct PiDelivery {
    result: guest_agent::cli::CliExecutionResult,
    config: GuestConfig,
    delivered: Vec<Value>,
    log: String,
}

// Follow serde_json's map order, including workspace preserve_order builds,
// while borrowing the large message instead of cloning it into a fixture Value.
struct SessionRecord<'a> {
    fields: &'a serde_json::Map<String, Value>,
    message: &'a Value,
}

impl serde::Serialize for SessionRecord<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap as _;
        let mut map = serializer.serialize_map(Some(self.fields.len()))?;
        for (name, value) in self.fields {
            map.serialize_entry(
                name,
                if name == "message" {
                    self.message
                } else {
                    value
                },
            )?;
        }
        map.end()
    }
}

fn write_session_record(
    output: impl Write,
    index: usize,
    message: &Value,
) -> serde_json::Result<()> {
    let mut fields = serde_json::Map::new();
    fields.insert("type".into(), json!("message"));
    fields.insert("id".into(), json!(format!("message-{index}")));
    fields.insert(
        "parentId".into(),
        json!((index > 0).then(|| format!("message-{}", index - 1))),
    );
    fields.insert("timestamp".into(), json!("2026-09-11T00:00:00Z"));
    fields.insert("message".into(), Value::Null);
    serde_json::to_writer(
        output,
        &SessionRecord {
            fields: &fields,
            message,
        },
    )
}

#[test]
fn borrowed_session_record_preserves_canonical_bytes() -> Result<(), serde_json::Error> {
    let message = json!({"role":"assistant", "content":[{"text":"你好\"\\\n"}]});
    for index in [0, 1] {
        let original = json!({"type":"message","id":format!("message-{index}"),"parentId":if index == 0 {None} else {Some(format!("message-{}",index-1))},"timestamp":"2026-09-11T00:00:00Z","message":message});
        let mut actual = Vec::new();
        write_session_record(&mut actual, index, &message)?;
        assert_eq!(actual, original.to_string().as_bytes());
    }
    Ok(())
}

#[test]
fn streamed_session_records_preserve_every_canonical_line() -> Result<(), serde_json::Error> {
    for messages in [
        vec![],
        vec![Value::Null],
        vec![
            json!({}),
            json!({"role":"assistant", "content":[{"text":"你好\"\\\n\0"}]}),
        ],
    ] {
        let mut actual = b"existing-header\n".to_vec();
        let mut expected = String::from("existing-header\n");
        for (index, message) in messages.iter().enumerate() {
            write_session_record(&mut actual, index, message)?;
            actual.push(b'\n');
            let original = json!({"type":"message","id":format!("message-{index}"),"parentId":if index == 0 {None} else {Some(format!("message-{}",index-1))},"timestamp":"2026-09-11T00:00:00Z","message":message});
            expected.push_str(&original.to_string());
            expected.push('\n');
        }
        assert_eq!(actual, expected.as_bytes());
    }
    Ok(())
}

// The guest system-log override is process-global Rust state.
static DELIVERY_FIXTURE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn deliver_pi_rpc(
    messages: &[Value],
    secrets: &[&str],
) -> Result<PiDelivery, Box<dyn std::error::Error>> {
    deliver_pi_rpc_with_skips(messages, secrets, &[]).await
}

async fn deliver_pi_rpc_with_skips(
    messages: &[Value],
    secrets: &[&str],
    skipped: &[u32],
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
    // Batch the serializers' small escaped-string writes into unchanged JSONL.
    let mut original = BufWriter::new(Vec::new());
    for event in messages {
        serde_json::to_writer(&mut original, event)?;
        original.write_all(b"\n")?;
    }
    let original = String::from_utf8(original.into_inner()?)?;
    assert!(original.lines().all(
        |line| line.len() < guest_contracts::stdout_framing::ORDINARY_CLI_STDOUT_MAX_LINE_BYTES
    ));
    std::fs::write(&events_path, &original)?;
    let mut session = BufWriter::new(serde_json::to_vec(
        &json!({"type":"session","version":3,"id":session_id,"timestamp":"2026-09-11T00:00:00Z","cwd":"/home/user/workspace"}),
    )?);
    session.write_all(b"\n")?;
    for (index, event) in messages.iter().enumerate() {
        write_session_record(&mut session, index, &event["message"])?;
        session.write_all(b"\n")?;
    }
    let session = String::from_utf8(session.into_inner()?)?;
    std::fs::write(session_path, &session)?;
    let commands_path = tmp.path().join("commands.jsonl");
    let okou = bin.join("okou");
    std::fs::write(&okou, include_str!("fixtures/pi_rpc_delivery.py"))?;
    std::fs::set_permissions(&okou, std::fs::Permissions::from_mode(0o700))?;
    let run_id = "00000000-0000-4000-8000-000000000124";
    let paths = GuestPaths::from_home(tmp.path(), run_id)?;
    let payload_path = common::write_run_payload_file_for_test(
        paths.runtime_dir(),
        &guest_contracts::env::RunPayload {
            prompt: "test bounded Pi delivery".into(),
            pi_launch_config: r#"{"schemaVersion":2}"#.into(),
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
        test_pi_cli_path: Some(okou.to_string_lossy().into_owned()),
        home: Some(tmp.path().to_string_lossy().into_owned()),
        run_payload_file: payload_path.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(paths.runtime_dir().into()),
        ..Default::default()
    })?;
    config.user_env.extend([
        ("PATH".into(), format!("{}:/usr/bin:/bin", bin.display())),
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
            while let Some(end) = ends.get(next).filter(|end| skipped.contains(end)) {
                // A deliberate size skip has no HTTP response to release this
                // producer gate. Its warning is the documented loss receipt.
                common::wait_for_file_contains(
                    std::path::Path::new(runtime.paths.system_log_file()),
                    &format!("Discarding oversized Pi event at sequence {end}"),
                    Duration::from_secs(5),
                )
                .await?;
                gate.write_all(b"x").await?;
                next += 1;
            }
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
    for request in &requests {
        assert!(request.body.len() <= LIMIT);
        let mut payload: Value = serde_json::from_str(&request.body)?;
        delivered.append(
            payload
                .get_mut("events")
                .and_then(Value::as_array_mut)
                .ok_or("missing events")?,
        );
    }
    assert_eq!(
        delivered
            .iter()
            .map(|e| e["sequenceNumber"].as_u64())
            .collect::<Vec<_>>(),
        (1..=sequence + 1)
            .filter(|sequence| !skipped.contains(sequence))
            .map(|sequence| Some(u64::from(sequence)))
            .collect::<Vec<_>>()
    );
    if result.control_error.is_none() {
        assert_eq!(
            result.last_event_sequence,
            delivered
                .last()
                .and_then(|event| event["sequenceNumber"].as_u64())
                .map(|sequence| sequence as u32)
        );
    } else {
        // Abort can win after HTTP receipt but before its response is observed.
        assert!(
            result.last_event_sequence
                <= delivered
                    .last()
                    .and_then(|event| event["sequenceNumber"].as_u64())
                    .map(|sequence| sequence as u32)
        );
    }
    assert_eq!(std::fs::read_to_string(&events_path)?, original);
    assert_eq!(std::fs::read_to_string(session_path)?, session);
    let local = std::fs::read_to_string(runtime.paths.agent_log_file())?;
    for expected in original.lines() {
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
        log,
    })
}
