use super::support::*;
use crate::support::*;
use httpmock::prelude::*;
use serde_json::json;

#[tokio::test]
async fn success_checkpoint_uses_captured_startup_environment() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let tmp = tempfile::tempdir().unwrap();
    let runtime_dir = tmp.path().join("runtime");
    let paths = guest_agent::paths::GuestPaths::from_runtime_dir(&runtime_dir);
    let history_dir = tmp.path().join("claude");
    let history_path = claude_history_path(&history_dir, "startup-session");
    let history = "{\"type\":\"system\"}\n";
    std::fs::create_dir_all(history_path.parent().unwrap()).unwrap();
    std::fs::write(&history_path, history).unwrap();
    guest_agent::paths::write_private(paths.session_id_file(), "startup-session").unwrap();
    let payload_file = crate::common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "startup checkpoint prompt".to_string(),
            ..Default::default()
        },
    )
    .unwrap();

    let prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .header("authorization", "Bearer startup-token")
            .header("x-vercel-protection-bypass", "startup-bypass")
            .json_body_includes(r#"{"runId":"startup-run"}"#);
        then.status(200).json_body(json!({
            "presignedUrl": server.url("/test/startup-history"),
            "existing": false
        }));
    });
    let upload = server.mock(|when, then| {
        when.method(PUT).path("/test/startup-history").body(history);
        then.status(200);
    });
    let complete = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(r#"{"runId":"startup-run"}"#)
            .json_body_includes(r#"{"checkpoint":{"cliAgentType":"claude-code"}}"#)
            .json_body_includes(r#"{"checkpoint":{"cliAgentSessionId":"startup-session"}}"#);
        then.status(200)
            .json_body(json!({"success": true, "status": "completed"}));
    });

    let mut command = checkpoint_child_command(
        "integration_cases::checkpoint::process_env::captured_startup_environment_child",
    )
    .unwrap();
    command
        .env(guest_contracts::env::RUN_ID_ENV, "startup-run")
        .env(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            server.base_url(),
        )
        .env(
            guest_contracts::env::CANONICAL_API_TOKEN_ENV,
            "startup-token",
        )
        .env(
            guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV,
            "startup-bypass",
        )
        .env(guest_contracts::env::CLI_AGENT_TYPE_ENV, "claude-code")
        .env(
            guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
            &payload_file,
        )
        .env(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            &runtime_dir,
        )
        .env("HOME", tmp.path().join("home"))
        .env("OKOU_TEST_CLAUDE_CONFIG_DIR", &history_dir);
    run_checkpoint_child(&mut command).await.unwrap();

    prepare.assert_calls_async(1).await;
    upload.assert_calls_async(1).await;
    complete.assert_calls_async(1).await;
    assert!(std::path::Path::new(paths.final_session_history_identity_file()).exists());
    assert!(std::path::Path::new(paths.system_log_file()).exists());
    assert!(std::path::Path::new(paths.sandbox_ops_file()).exists());
    assert!(
        !payload_file.exists(),
        "bootstrap must consume the startup payload"
    );
}

#[tokio::test]
#[ignore = "launched by the parent with the complete startup environment"]
async fn captured_startup_environment_child() {
    let runtime = guest_agent::run_context::GuestRuntime::from_process_env().unwrap();
    assert_eq!(runtime.config.prompt, "startup checkpoint prompt");
    let checkpoint = guest_agent::checkpoint::prepare_checkpoint_for_runtime(
        &runtime,
        &checkpoint_session_metadata(&runtime),
    )
    .await
    .unwrap();
    report_prepared_checkpoint(&runtime, 0, checkpoint)
        .await
        .unwrap();
}
