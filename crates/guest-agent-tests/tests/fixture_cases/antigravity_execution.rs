//! Exercise framework selection, pipes, event delivery and process cleanup with
//! an isolated peer for the pinned Antigravity stream-json protocol.

use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;

use guest_agent::cli::JsonlResultStatus;
use guest_agent::env::{Framework, GuestConfig, GuestConfigRaw};
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use guest_agent::paths::GuestPaths;
use guest_agent::run_context::GuestRuntime;
use guest_agent_tests as common;
use guest_contracts::diagnostics::CliTerminationReason;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

const RUN: &str = "cc8ec675-4a68-4bf1-af0d-a3be79807935";
const THREAD: &str = "61795dd2-782c-420a-9a17-7fe8773aa34d";
const RULE: &str = "Use the run-specific system rule.";
const PROMPT: &str = "First line\n\"Second\" line.";

fn runtime(
    root: &Path,
    server: &str,
    mode: &str,
) -> Result<GuestRuntime, Box<dyn std::error::Error>> {
    common::ensure_canonical_workspace_for_test()?;
    let dir = root.join(mode);
    let payload = common::write_run_payload_file_for_test(
        &dir,
        &guest_contracts::env::RunPayload {
            prompt: PROMPT.into(),
            append_system_prompt: RULE.into(),
            native_continuation: if mode == "recovery" {
                serde_json::to_string(&guest_contracts::env::NativeContinuation {
                    session_id: Some("old-provider-session".into()),
                    generation_run_id: Some(THREAD.into()),
                    recovery_prompt: Some("Previous chat messages go here.".into()),
                })?
            } else {
                String::new()
            },
            ..Default::default()
        },
    )?;
    let mut config = GuestConfig::from_raw(GuestConfigRaw {
        run_id: RUN.into(),
        cli_agent_type: "antigravity".into(),
        api_url: server.into(),
        api_token: "fixture-token".into(),
        sandbox_id: THREAD.into(),
        guest_runtime_dir: Some(dir.clone()),
        home: Some(root.display().to_string()),
        run_payload_file: payload.display().to_string(),
        ..Default::default()
    })?;
    assert_eq!(config.framework, Framework::Antigravity);
    config.test_antigravity_cli_path = Some(root.join("agy-peer").display().to_string());
    config.user_env = HashMap::from([
        ("OKOU_ANTIGRAVITY_MODEL".into(), "gemini-4-carbon".into()),
        ("OKOU_REASONING_EFFORT".into(), "high".into()),
        ("OKOU_CHAT_THREAD_ID".into(), THREAD.into()),
        ("GEMINI_API_KEY".into(), "must-not-reach-the-peer".into()),
        ("AGY_ADC_AUTH".into(), "true".into()),
        ("AGY_TEST_CASE".into(), mode.into()),
        ("AGY_TEST_DIR".into(), dir.display().to_string()),
    ]);
    Ok(GuestRuntime {
        http: HttpClient::for_config(&config)?,
        config,
        paths: GuestPaths::from_runtime_dir(dir),
        workload_containment: None,
        process_control_endpoint: None,
    })
}

#[tokio::test]
async fn antigravity_turn_delivery_failure_and_cancellation()
-> Result<(), Box<dyn std::error::Error>> {
    let root = tempfile::tempdir()?;
    let peer = root.path().join("agy-peer");
    fs::write(&peer, include_str!("../fixtures/antigravity-peer.py"))?;
    fs::set_permissions(&peer, fs::Permissions::from_mode(0o700))?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;
    let masker = SecretMasker::from_raw("Y29uZmlndXJlZC1zZWNyZXQ=");
    for mode in [
        "success",
        "auth",
        "missing",
        "malformed",
        "nonzero",
        "cancel",
        "recovery",
    ] {
        let runtime = runtime(root.path(), &server.base_url, mode)?;
        let dir = root.path().join(mode);
        let token = CancellationToken::new();
        let execute = common::execute_cli_with_cancellation_for_runtime(
            &runtime,
            &masker,
            common::spawn_dummy_heartbeat(),
            token.clone(),
        );
        let cancel = async {
            if mode == "cancel" {
                common::wait_for_path(&dir.join("ready"), Duration::from_secs(5)).await?;
                token.cancel();
            }
            Ok::<_, std::io::Error>(())
        };
        let (result, cancelled) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(execute, cancel)
        })
        .await?;
        cancelled?;
        if mode == "malformed" {
            match result {
                Err(err) => assert!(err.to_string().contains("Invalid Antigravity JSON record")),
                Ok(result) => assert!(
                    result
                        .control_error
                        .is_some_and(|e| e.to_string().contains("Invalid Antigravity JSON record"))
                ),
            }
        } else {
            let result = result?;
            assert!(result.stderr_lines.is_empty());
            match mode {
                "success" => {
                    assert_eq!(result.exit_code, 0);
                    assert_eq!(
                        result.jsonl_result.unwrap().status,
                        JsonlResultStatus::Success
                    );
                    assert!(result.control_error.is_none());
                    let event_requests = server.requests()?;
                    let mut events = Vec::new();
                    for req in event_requests
                        .iter()
                        .filter(|r| r.path.ends_with("/events"))
                    {
                        let body: Value = serde_json::from_str(&req.body)?;
                        events.extend_from_slice(body["events"].as_array().unwrap());
                    }
                    assert_eq!(
                        events
                            .iter()
                            .map(|e| e["type"].as_str().unwrap())
                            .collect::<Vec<_>>(),
                        ["system", "assistant", "user", "assistant", "result"]
                    );
                    for (i, e) in events.iter().enumerate() {
                        assert_eq!(e["sequenceNumber"], i as u64);
                    }
                    assert_eq!(
                        events[1]["message"]["content"][0]["id"],
                        events[2]["message"]["content"][0]["tool_use_id"]
                    );
                    assert_eq!(events[4]["usage"]["total_tokens"], 16);
                    assert!(
                        !events[3]["message"]["content"][0]["text"]
                            .as_str()
                            .unwrap()
                            .contains("configured-secret")
                    );
                    assert_eq!(
                        events[4]["result"],
                        events[3]["message"]["content"][0]["text"]
                    );
                    let preview: Vec<_> = event_requests
                        .iter()
                        .filter(|r| r.path.ends_with("/session-output"))
                        .collect();
                    // A preview is best effort. The durable message must carry the exact block ID to reconcile it.
                    for req in preview {
                        let body: Value = serde_json::from_str(&req.body)?;
                        assert_eq!(body["runEventId"], events[3]["runEventId"]);
                    }
                }
                "auth" => {
                    assert_ne!(result.exit_code, 0);
                    assert_eq!(
                        result.jsonl_result.unwrap().status,
                        JsonlResultStatus::Error
                    );
                    assert!(
                        result
                            .failure_diagnostic
                            .unwrap()
                            .message
                            .contains("signed-in Google account")
                    );
                }
                "recovery" => assert_eq!(result.exit_code, 0),
                "missing" => {
                    assert_ne!(result.exit_code, 0);
                    assert!(
                        result
                            .failure_diagnostic
                            .unwrap()
                            .message
                            .contains("without a terminal result")
                    );
                }
                "nonzero" => assert_eq!(result.exit_code, 23),
                "cancel" => {
                    assert_eq!(
                        result.cli_termination.unwrap().reason,
                        CliTerminationReason::UserCancellation
                    );
                    let pid = fs::read_to_string(dir.join("ready"))?;
                    assert!(!Path::new("/proc").join(pid.trim()).exists());
                }
                _ => return Err(format!("Unknown Antigravity fixture scenario: {mode}").into()),
            }
        }
        let log = fs::read_to_string(runtime.paths.agent_log_file())?;
        assert!(!log.contains("provider-private-marker"));
        assert!(!log.contains("configured-secret"));
        assert!(!Path::new(&fs::read_to_string(dir.join("rules-dir"))?).exists());
    }
    Ok(())
}
