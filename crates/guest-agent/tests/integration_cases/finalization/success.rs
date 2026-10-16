use super::support::*;
use crate::support::*;
use httpmock::prelude::*;
use serde_json::json;

#[tokio::test]
async fn pi_finalization_reports_full_combined_completion_payload() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = finalization_runtime().unwrap();
    runtime.config.framework = guest_agent::env::Framework::Pi;
    let _files_guard = SessionFinalizationFilesGuard::new();
    let session_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    guest_agent::paths::write_private(session_id_file(), session_id).unwrap();

    let complete = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(
                json!({
                    "runId": "test-run-001",
                    "exitCode": 0,
                    "lastEventSequence": 42,
                    "sandboxId": "00000000-0000-4000-8000-000000000abc",
                    "completion": {
                        "cliAgentType": "pi",
                        "cliAgentSessionId": session_id,
                        "cliAgentSessionHistoryDisposition": "native_only"
                    }
                })
                .to_string(),
            );
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "completed"}));
    });

    let session_metadata =
        guest_agent::session_metadata::CapturedSessionMetadata::for_test(session_id, None);
    let finalization =
        guest_agent::finalization::prepare_finalization_for_runtime(&runtime, &session_metadata)
            .await
            .unwrap();
    guest_agent::complete::report_finalization_for_run(
        &runtime,
        0,
        None,
        None,
        Some(42),
        finalization,
    )
    .await
    .unwrap();

    complete.assert_calls_async(1).await;
}

#[tokio::test]
async fn combined_finalization_accepts_terminal_acknowledgement_without_finalization_identity() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let mut runtime = finalization_runtime().unwrap();
    runtime.config.framework = guest_agent::env::Framework::Codex;
    let _files_guard = SessionFinalizationFilesGuard::new();
    let session_id = "acacacac-acac-4cac-8cac-acacacacacac";
    let home = tempfile::tempdir().unwrap();
    use_test_codex_home(&mut runtime, home.path());
    guest_agent::paths::write_private(session_id_file(), session_id).unwrap();
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(
                r#"{"completion":{"cliAgentSessionHistoryDisposition":"native_only"}}"#,
            );
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "completed"}));
    });

    create_native_finalization(&runtime).await.unwrap();
    complete_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn success_finalization_uses_explicit_runtime_with_conflicting_process_env() {
    let tmp = tempfile::tempdir().unwrap();
    let mut command = finalization_child_command(
        "integration_cases::finalization::success::explicit_runtime_with_conflicting_process_env_child",
    )
    .unwrap();
    command
        .env("TMPDIR", tmp.path())
        .env(guest_contracts::env::RUN_ID_ENV, "stale-run")
        .env(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            tmp.path().join("stale-runtime"),
        );
    run_finalization_child(&mut command).await.unwrap();
}

#[tokio::test]
#[ignore = "launched by the parent with conflicting startup environment"]
async fn explicit_runtime_with_conflicting_process_env_child() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let tmp = tempfile::tempdir().unwrap();
    let runtime_dir = tmp.path().join("captured-runtime");
    let stale_runtime_dir = std::path::PathBuf::from(
        std::env::var_os(guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV).unwrap(),
    );
    assert_eq!(
        std::env::var(guest_contracts::env::RUN_ID_ENV).unwrap(),
        "stale-run"
    );
    let home_dir = tmp.path().join("home");
    let paths = guest_agent::paths::GuestPaths::from_runtime_dir(&runtime_dir);
    let run_payload_file = crate::common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload::default(),
    )
    .unwrap();
    let config = guest_agent::env::GuestConfig::from_raw(guest_agent::env::GuestConfigRaw {
        run_id: "captured-run".to_string(),
        api_url: server.base_url(),
        api_token: "test-token-abc123".to_string(),
        cli_agent_type: "claude-code".to_string(),
        home: Some(home_dir.to_string_lossy().into_owned()),
        test_claude_config_dir: Some(home_dir.join(".claude")),
        run_payload_file: run_payload_file.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(runtime_dir.clone()),
        ..guest_agent::env::GuestConfigRaw::default()
    })
    .unwrap();
    let final_identity_file = paths.final_session_history_identity_file().to_string();
    let stale_paths = guest_agent::paths::GuestPaths::from_runtime_dir(&stale_runtime_dir);

    let history = r#"{"type":"system"}"#.to_string() + "\n";
    let history_path = claude_history_path(&home_dir.join(".claude"), "captured-session");
    std::fs::create_dir_all(history_path.parent().unwrap()).unwrap();
    std::fs::write(&history_path, &history).unwrap();
    guest_agent::paths::write_private(paths.session_id_file(), "captured-session").unwrap();

    let runtime = guest_agent::run_context::GuestRuntime {
        config,
        paths,
        http: http_client!(),
        workload_containment: None,
        process_control_endpoint: None,
    };

    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(r#"{"runId":"captured-run"}"#)
            .json_body_includes(r#"{"completion":{"cliAgentType":"claude-code"}}"#)
            .json_body_includes(r#"{"completion":{"cliAgentSessionId":"captured-session"}}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "completed"}));
    });

    let result = guest_agent::finalization::prepare_finalization_for_runtime(
        &runtime,
        &finalization_session_metadata(&runtime),
    )
    .await;

    let finalization = result.unwrap();
    report_prepared_finalization(&runtime, 0, finalization)
        .await
        .unwrap();
    complete_mock.assert_calls_async(1).await;
    assert!(
        std::path::Path::new(&final_identity_file).exists(),
        "final identity should be written under explicit runtime paths"
    );
    assert!(
        !std::path::Path::new(stale_paths.final_session_history_identity_file()).exists(),
        "stale process env runtime path must not receive final identity"
    );
}
