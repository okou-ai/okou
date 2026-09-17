use super::support::*;
use crate::support::*;
use httpmock::prelude::*;
use serde_json::json;

#[tokio::test]
async fn recovery_checkpoint_uploads_valid_session_history() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = checkpoint_runtime().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant"}"# + "\n";
    let _history_dir =
        write_literal_session_history(&mut runtime, "recovery-session", history.as_bytes())
            .unwrap();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/recovery-history-upload"),
                "existing": false
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/recovery-history-upload")
            .header("Content-Type", "application/octet-stream")
            .body(history.as_str());
        then.status(200);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(r#"{"checkpoint":{"cliAgentSessionId":"recovery-session"}}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "failed"}));
    });

    let result = guest_agent::checkpoint::prepare_recovery_checkpoint_for_runtime(
        &runtime,
        &checkpoint_session_metadata(&runtime),
    )
    .await;

    let checkpoint = result.unwrap();
    report_prepared_checkpoint(&runtime, 1, checkpoint)
        .await
        .unwrap();
    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    complete_mock.assert_calls_async(1).await;
    assert!(
        !std::path::Path::new(runtime.paths.final_session_history_identity_file()).exists(),
        "recovery checkpoint must not write final session history identity metadata"
    );
}

#[tokio::test]
async fn recovery_checkpoint_does_not_prune_eligible_claude_history() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = checkpoint_runtime().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (history_dir, _) = write_prunable_claude_history(&mut runtime, session_id).unwrap();
    let history_path = claude_history_path(history_dir.path(), session_id);
    let source_size = std::fs::metadata(&history_path).unwrap().len();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(
                r#"{"checkpoint":{"cliAgentSessionHistoryDisposition":"unavailable"}}"#,
            );
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "failed"}));
    });

    create_bounded_recovery_checkpoint(&runtime).await.unwrap();
    assert_eq!(std::fs::metadata(&history_path).unwrap().len(), source_size);
    assert!(!std::path::Path::new(runtime.paths.final_session_history_identity_file()).exists());
    prepare_mock.assert_calls_async(0).await;
    complete_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn recovery_checkpoint_does_not_prune_eligible_codex_history() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = checkpoint_runtime().unwrap();
    runtime.config.framework = guest_agent::env::Framework::Codex;
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (history_dir, history_path, _) = write_prunable_codex_history(session_id).unwrap();
    use_test_codex_home(&mut runtime, history_dir.path());
    let source_size = std::fs::metadata(&history_path).unwrap().len();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(
                r#"{"checkpoint":{"cliAgentSessionHistoryDisposition":"unavailable"}}"#,
            );
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "failed"}));
    });

    create_bounded_recovery_checkpoint(&runtime).await.unwrap();
    assert_eq!(std::fs::metadata(&history_path).unwrap().len(), source_size);
    assert!(!std::path::Path::new(runtime.paths.final_session_history_identity_file()).exists());
    prepare_mock.assert_calls_async(0).await;
    complete_mock.assert_calls_async(1).await;

    let source_history = std::fs::read(&history_path).unwrap();
    let encoded_history = zstd_session_history_for_test(&source_history).unwrap();
    let encoded_history_path = history_path.with_extension("jsonl.zst");
    std::fs::write(&encoded_history_path, &encoded_history).unwrap();
    std::fs::remove_file(&history_path).unwrap();

    create_bounded_recovery_checkpoint(&runtime).await.unwrap();
    assert_eq!(
        std::fs::read(&encoded_history_path).unwrap(),
        encoded_history
    );
    assert!(!std::path::Path::new(runtime.paths.final_session_history_identity_file()).exists());
    prepare_mock.assert_calls_async(0).await;
    complete_mock.assert_calls_async(2).await;
}

async fn assert_recovery_checkpoint_ignores_legacy_history_marker(
    upload_path: &str,
) -> Result<(), String> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = checkpoint_runtime()?;
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "derived-history-session";
    let history = r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant"}"# + "\n";
    let legacy_marker =
        std::path::Path::new(runtime.paths.runtime_dir()).join("session-history-marker");
    guest_agent::paths::write_private(&legacy_marker, "/proc/self/environ")
        .map_err(|e| format!("write adversarial legacy history marker: {e}"))?;
    let _history_dir = write_literal_session_history(&mut runtime, session_id, history.as_bytes())?;

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url(upload_path),
                "existing": false
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path(upload_path)
            .header("Content-Type", "application/octet-stream")
            .body(history.as_str());
        then.status(200);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(format!(
                r#"{{"checkpoint":{{"cliAgentSessionId":"{session_id}"}}}}"#
            ));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "failed"}));
    });

    let result = guest_agent::checkpoint::prepare_recovery_checkpoint_for_runtime(
        &runtime,
        &checkpoint_session_metadata(&runtime),
    )
    .await;

    let checkpoint = result.map_err(|error| error.to_string())?;
    report_prepared_checkpoint(&runtime, 1, checkpoint)
        .await
        .map_err(|error| error.to_string())?;
    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    complete_mock.assert_calls_async(1).await;
    assert_eq!(
        std::fs::read_to_string(legacy_marker)
            .map_err(|e| format!("read adversarial legacy marker: {e}"))?,
        "/proc/self/environ"
    );
    Ok(())
}

#[tokio::test]
async fn recovery_checkpoint_ignores_workload_owned_legacy_history_marker() {
    assert_recovery_checkpoint_ignores_legacy_history_marker("/test/derived-history-upload")
        .await
        .unwrap();
}

#[tokio::test]
async fn recovery_checkpoint_continues_without_partial_jsonl_history() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = checkpoint_runtime().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let _history_dir = write_literal_session_history(
        &mut runtime,
        "partial-session",
        (r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant""#).as_bytes(),
    )
    .unwrap();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(
                r#"{"checkpoint":{"cliAgentSessionHistoryDisposition":"unavailable"}}"#,
            );
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "failed"}));
    });

    let result = guest_agent::checkpoint::prepare_recovery_checkpoint_for_runtime(
        &runtime,
        &checkpoint_session_metadata(&runtime),
    )
    .await;

    let checkpoint = result.unwrap();
    report_prepared_checkpoint(&runtime, 1, checkpoint)
        .await
        .unwrap();
    assert!(
        !std::path::Path::new(runtime.paths.checkpoint_error_file()).exists(),
        "recovery checkpoint must not write the success-path checkpoint error file"
    );
    prepare_mock.assert_calls_async(0).await;
    complete_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn recovery_checkpoint_continues_without_non_utf8_session_history() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = checkpoint_runtime().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let _history_dir = write_literal_session_history(
        &mut runtime,
        "recovery-non-utf8-session",
        b"{\"type\":\"system\"}\nnon-utf8:\xC3(\n",
    )
    .unwrap();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(
                r#"{"checkpoint":{"cliAgentSessionHistoryDisposition":"unavailable"}}"#,
            );
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "failed"}));
    });

    let result = guest_agent::checkpoint::prepare_recovery_checkpoint_for_runtime(
        &runtime,
        &checkpoint_session_metadata(&runtime),
    )
    .await;

    let checkpoint = result.unwrap();
    report_prepared_checkpoint(&runtime, 1, checkpoint)
        .await
        .unwrap();
    assert!(
        !std::path::Path::new(runtime.paths.checkpoint_error_file()).exists(),
        "recovery checkpoint must not write the success-path checkpoint error file"
    );
    prepare_mock.assert_calls_async(0).await;
    complete_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn recovery_checkpoint_skips_when_session_id_is_missing() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = checkpoint_runtime().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/complete");
        then.status(200);
    });

    let result = guest_agent::checkpoint::prepare_recovery_checkpoint_for_runtime(
        &runtime,
        &checkpoint_session_metadata(&runtime),
    )
    .await;

    let err = result
        .err()
        .expect("missing session ID should fail recovery preparation");
    assert!(
        err.to_string().contains("Session ID is empty"),
        "expected recovery checkpoint to fail on missing session ID, got: {err}"
    );
    assert!(
        !std::path::Path::new(runtime.paths.checkpoint_error_file()).exists(),
        "recovery checkpoint must not write the success-path checkpoint error file"
    );
    prepare_mock.assert_calls_async(0).await;
    complete_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn recovery_checkpoint_continues_when_derived_history_is_missing() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = checkpoint_runtime().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    guest_agent::paths::write_private(session_id_file(), "missing-history").unwrap();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(
                r#"{"checkpoint":{"cliAgentSessionHistoryDisposition":"unavailable"}}"#,
            );
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "failed"}));
    });

    let result = guest_agent::checkpoint::prepare_recovery_checkpoint_for_runtime(
        &runtime,
        &checkpoint_session_metadata(&runtime),
    )
    .await;

    let checkpoint = result.unwrap();
    report_prepared_checkpoint(&runtime, 1, checkpoint)
        .await
        .unwrap();
    assert!(
        !std::path::Path::new(runtime.paths.checkpoint_error_file()).exists(),
        "recovery checkpoint must not write the success-path checkpoint error file"
    );
    prepare_mock.assert_calls_async(0).await;
    complete_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn recovery_checkpoint_continues_without_invalid_history_source() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = checkpoint_runtime().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    guest_agent::paths::write_private(session_id_file(), "../unsafe-session").unwrap();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(
                r#"{"checkpoint":{"cliAgentSessionHistoryDisposition":"unavailable"}}"#,
            );
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "failed"}));
    });

    let result = guest_agent::checkpoint::prepare_recovery_checkpoint_for_runtime(
        &runtime,
        &checkpoint_session_metadata(&runtime),
    )
    .await;

    let checkpoint = result.unwrap();
    report_prepared_checkpoint(&runtime, 1, checkpoint)
        .await
        .unwrap();
    assert!(
        !std::path::Path::new(runtime.paths.checkpoint_error_file()).exists(),
        "recovery checkpoint must not write the success-path checkpoint error file"
    );
    prepare_mock.assert_calls_async(0).await;
    complete_mock.assert_calls_async(1).await;
}
