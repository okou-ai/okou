//! Observe transient text at the real guest HTTP boundary before message_end.

mod common;

use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use base64::Engine;
use guest_agent::env::{GuestConfig, GuestConfigRaw};
use guest_agent::masker::SecretMasker;
use guest_agent::paths::GuestPaths;
use guest_agent::run_context::GuestRuntime;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;

const RUN_ID: &str = "00000000-0000-4000-8000-000000038132";
const PLAIN: &str = "audit-secret-12345";
const ENCODED_SECRET: &str = "audit/+secret π";
const HIDDEN: &str = "<oai-mem-citation><citation_entries>memory.md:1-1|note=[test]</citation_entries></oai-mem-citation>";

#[tokio::test]
async fn pi_masks_live_http_text_across_deltas_chunks_and_completion()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let mut server = common::ControlledHttpServer::start().await?;
    let gate_path = tmp.path().join("stream.sock");
    let listener = tokio::net::UnixListener::bind(&gate_path)?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let session_dir = api_contracts::generated::constants::runners::paths::CANONICAL_PI_SESSION_DIR;
    std::fs::create_dir_all(session_dir)?;
    let session_file = tempfile::Builder::new()
        .prefix("masking-")
        .suffix(&format!("_{session_id}.jsonl"))
        .tempfile_in(session_dir)?;
    let paths = GuestPaths::from_home(tmp.path(), RUN_ID)?;
    let payload_path = common::write_run_payload_file_for_test(
        paths.runtime_dir(),
        &guest_contracts::env::RunPayload {
            prompt: "test synthetic Pi live masking".into(),
            pi_launch_config: r#"{"schemaVersion":2}"#.into(),
            pi_model_config: "{}".into(),
            pi_session_id: session_id.clone(),
            secret_values: [PLAIN, ENCODED_SECRET, "abcde", "cdefg", "aaaaa", "<oai-"]
                .iter()
                .map(|secret| base64::engine::general_purpose::STANDARD.encode(secret))
                .collect::<Vec<_>>()
                .join(","),
            ..Default::default()
        },
    )?;
    let mut config = GuestConfig::from_raw(GuestConfigRaw {
        run_id: RUN_ID.into(),
        api_url: server.base_url.clone(),
        api_token: "test-token".into(),
        cli_agent_type: "pi".into(),
        home: Some(tmp.path().to_string_lossy().into_owned()),
        run_payload_file: payload_path.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(paths.runtime_dir().into()),
        ..Default::default()
    })?;
    let masker = SecretMasker::from_config(&config);
    let variants = [
        PLAIN.to_string(),
        base64::engine::general_purpose::STANDARD.encode(PLAIN),
        "audit%2F%2Bsecret%20%CF%80".into(),
        "audit%2f%2bsecret%20%cf%80".into(),
        "audit%2F%2bsecret%20%cF%80".into(),
    ];
    let forbidden = variants
        .iter()
        .map(String::as_str)
        .chain([ENCODED_SECRET, "abcde", "cdefg", "aaaaa", "<oai-"])
        .collect::<Vec<_>>();
    let mut expected = Vec::new();
    let mut stages = Vec::new();
    let mut session = format!(
        "{}\n",
        json!({"type":"session","version":3,"id":session_id,"timestamp":"2026-10-09T00:00:00Z","cwd":"/home/user/workspace"})
    );
    for (stage, variant) in variants.iter().enumerate() {
        let prefix = format!("stage-{stage}-0:");
        // The unmasked value straddles a 4096-byte transport chunk boundary.
        let padding = "z".repeat(4096 - prefix.len() - variant.len() / 2);
        let prefix = format!("{prefix}{padding}");
        let variant = if stage == 0 {
            format!("audit-sec{HIDDEN}ret-12345")
        } else {
            variant.clone()
        };
        let tail = format!(" [live-{stage}-0] {} done", "🦀".repeat(20));
        let final_tail = if stage == variants.len() - 1 {
            "<oai-"
        } else {
            ""
        };
        let first = format!("{prefix}{variant}{tail}{final_tail}");
        let second_prefix = format!("stage-{stage}-1: audit-sec");
        let second_tail = format!(
            "ret-12345 abcdefg aaaaaaa [live-{stage}-1] {} done",
            "é".repeat(50)
        );
        let second = format!("{second_prefix}{second_tail}");
        expected.push([
            masker.mask_string(&first.replace(HIDDEN, "")),
            masker.mask_string(&second),
        ]);
        let updates = if stage == 1 {
            // A single large delta also puts a complete Base64 value across
            // output chunks; masking each already-split chunk is insufficient.
            vec![
                json!([0, first]),
                json!([1, second_prefix]),
                json!([1, second_tail]),
            ]
        } else {
            let mut updates = vec![json!([0, prefix]), json!([1, second_prefix])];
            // Every scalar is its own provider delta, including percent escapes
            // and the citation delimiter inserted inside the configured value.
            updates.extend(variant.chars().map(|ch| json!([0, ch.to_string()])));
            updates.push(json!([1, second_tail]));
            updates.push(json!([0, format!("{tail}{final_tail}")]));
            updates
        };
        let message = json!({
            "role":"assistant", "content":[{"type":"text","text":first},{"type":"text","text":second}],
            "model":"synthetic", "timestamp":stage + 1, "usage":{}, "stopReason":"stop"
        });
        session.push_str(&format!(
            "{}\n",
            json!({"type":"message","id":format!("message-{stage}"),"parentId":stage.checked_sub(1).map(|index| format!("message-{index}")),"timestamp":"2026-10-09T00:00:00Z","message":message})
        ));
        stages.push(json!({"message":message,"updates":updates}));
    }
    std::fs::write(session_file.path(), session)?;
    let stages_path = tmp.path().join("stages.json");
    std::fs::write(&stages_path, serde_json::to_vec(&stages)?)?;
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin)?;
    let npx = bin.join("npx");
    std::fs::write(&npx, include_str!("fixtures/pi_rpc_streaming.py"))?;
    std::fs::set_permissions(&npx, std::fs::Permissions::from_mode(0o700))?;
    config.user_env.extend([
        ("PATH".into(), format!("{}:/usr/bin:/bin", bin.display())),
        (
            "CLI_PKG_URL".into(),
            "https://example.invalid/cli.tgz".into(),
        ),
        ("PI_SESSION_ID".into(), session_id.clone()),
        (
            "PI_SESSION_PATH".into(),
            session_file.path().to_string_lossy().into_owned(),
        ),
        (
            "PI_STAGES_PATH".into(),
            stages_path.to_string_lossy().into_owned(),
        ),
        (
            "PI_STREAM_GATE".into(),
            gate_path.to_string_lossy().into_owned(),
        ),
    ]);
    let runtime = GuestRuntime {
        http: guest_agent::http::HttpClient::with_api_config(
            &server.base_url,
            "test-token",
            "",
            RUN_ID,
            Duration::ZERO,
        )?,
        config,
        paths,
        workload_containment: None,
        process_control_endpoint: None,
    };
    let _system_log = common::SystemLogOverrideGuard::set(runtime.paths.system_log_file());
    common::ensure_canonical_workspace_for_test()?;
    let serving = async {
        let (mut gate, _) = listener.accept().await?;
        let mut previews = BTreeMap::<String, String>::new();
        let mut indices = BTreeMap::<String, u64>::new();
        let mut durable = BTreeMap::<String, String>::new();
        let mut stage = 0;
        let mut released_live = false;
        let mut saw_full_chunk = false;
        let mut sequences = Vec::new();
        loop {
            let request = server.next_request(Duration::from_secs(10)).await?;
            let body: Value = serde_json::from_str(&request.request.body)?;
            let mut settled = false;
            match request.request.path.as_str() {
                "/api/webhooks/agent/session-output" => {
                    assert_eq!(body["runId"], RUN_ID);
                    assert_eq!(body["threadId"], session_id);
                    let id = body["runEventId"].as_str().ok_or("missing preview id")?;
                    let delta = body["delta"].as_str().ok_or("missing preview text")?;
                    assert!(delta.len() <= 4096);
                    saw_full_chunk |= delta.len() == 4096;
                    assert_eq!(
                        body["chunkIndex"],
                        *indices.entry(id.to_string()).or_default()
                    );
                    *indices.get_mut(id).ok_or("missing index")? += 1;
                    let preview = previews.entry(id.to_string()).or_default();
                    preview.push_str(delta);
                    for secret in &forbidden {
                        assert!(!delta.contains(secret), "unmasked value in HTTP delta");
                        assert!(
                            !preview.contains(secret),
                            "unmasked value across HTTP chunks"
                        );
                    }
                    assert!(!preview.contains("memory.md"));
                }
                "/api/webhooks/agent/events" => {
                    let events = body["events"].as_array().ok_or("missing events")?;
                    for event in events {
                        sequences.push(event["sequenceNumber"].as_u64().ok_or("missing sequence")?);
                        let data = event;
                        if data["type"] == "assistant" {
                            let id = data["runEventId"]
                                .as_str()
                                .ok_or("missing reconciliation id")?;
                            let text = data
                                .pointer("/message/content/0/text")
                                .and_then(Value::as_str)
                                .ok_or("missing durable text")?;
                            for secret in &forbidden {
                                assert!(!text.contains(secret), "unmasked durable text");
                            }
                            durable.insert(id.to_string(), text.to_string());
                        }
                        settled |= data["type"] == "result";
                    }
                }
                path => return Err(format!("unexpected HTTP path: {path}").into()),
            }
            request.respond(200)?;
            if settled {
                assert_eq!(stage, expected.len());
                assert_eq!(sequences, (1..=sequences.len() as u64).collect::<Vec<_>>());
                break;
            }
            if stage < expected.len() {
                let ids = (0..2)
                    .map(|source| {
                        previews
                            .iter()
                            .find(|(_, text)| text.contains(&format!("[live-{stage}-{source}]")))
                            .map(|(id, _)| id.clone())
                    })
                    .collect::<Vec<_>>();
                if ids.iter().all(Option::is_some) {
                    if !released_live {
                        // The peer cannot emit message_end until this write.
                        for id in ids.iter().flatten() {
                            assert!(!durable.contains_key(id));
                        }
                        gate.write_all(b"x").await?;
                        released_live = true;
                    }
                    if ids.iter().enumerate().all(|(source, id)| {
                        id.as_ref().is_some_and(|id| {
                            previews.get(id) == Some(&expected[stage][source])
                                && durable.get(id) == Some(&expected[stage][source])
                        })
                    }) {
                        for (source, id) in ids.iter().enumerate() {
                            assert!(
                                id.as_ref()
                                    .ok_or("missing id")?
                                    .ends_with(&format!(":{source}"))
                            );
                        }
                        gate.write_all(b"x").await?;
                        stage += 1;
                        released_live = false;
                    }
                }
            }
        }
        assert!(saw_full_chunk, "exercise the transport chunk boundary");
        assert_eq!(previews.len(), expected.len() * 2);
        assert_eq!(previews, durable);
        Ok::<_, Box<dyn std::error::Error>>(())
    };
    let execution = common::execute_cli_for_runtime(&runtime, &masker, None);
    let (result, ()) = tokio::time::timeout(Duration::from_secs(30), async {
        tokio::try_join!(
            async { Ok::<_, Box<dyn std::error::Error>>(execution.await?) },
            serving,
        )
    })
    .await??;
    assert!(result.control_error.is_none(), "{:?}", result.control_error);
    assert_eq!(result.exit_code, 0);
    Ok(())
}
