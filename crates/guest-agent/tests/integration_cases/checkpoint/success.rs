use super::support::*;
use crate::support::*;
use guest_contracts::session_history_identity::{
    SessionHistoryFramework, SessionHistoryIdentity, SessionHistoryRefKind,
};
use httpmock::prelude::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn assert_session_history_prune_operation(
    runtime: &guest_agent::run_context::GuestRuntime,
    expected_outcome: &str,
    expected_reason: Option<&str>,
    expected_success: bool,
) -> Result<(), String> {
    let content = std::fs::read_to_string(runtime.paths.sandbox_ops_file())
        .map_err(|error| format!("read checkpoint telemetry: {error}"))?;
    let operations = content
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("parse checkpoint telemetry: {error}"))?
        .into_iter()
        .filter(|operation| operation["action_type"] == "session_history_prune")
        .collect::<Vec<_>>();
    if operations.len() != 1 {
        return Err(format!("unexpected prune operations: {operations:?}"));
    }
    let Some(operation) = operations.first() else {
        return Err("missing prune operation".into());
    };
    assert_eq!(operation["outcome"], expected_outcome);
    assert_eq!(operation["success"], expected_success);
    match expected_reason {
        Some(reason) => assert_eq!(operation["reason"], reason),
        None => assert!(operation.get("reason").is_none()),
    }
    if expected_success {
        assert!(operation.get("error").is_none());
    } else {
        assert_eq!(operation["error"], "selector_io");
    }
    Ok(())
}

#[tokio::test]
async fn pi_checkpoint_reports_full_combined_completion_payload() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    runtime.config.framework = guest_agent::env::Framework::Pi;
    runtime.config.workspace_reuse_result = "sandboxReused".to_string();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    guest_agent::paths::write_private(session_id_file(), session_id).unwrap();
    let active_input_delivery_ids = vec!["11111111-1111-4111-8111-111111111111".to_string()];

    let standalone_checkpoint = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200);
    });
    let complete = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(
                json!({
                    "runId": "test-run-001",
                    "exitCode": 0,
                    "lastEventSequence": 42,
                    "sandboxId": "00000000-0000-4000-8000-000000000abc",
                    "sandboxReuseResult": "reused",
                    "workspaceReuseResult": "sandboxReused",
                    "activeInputDeliveryIds": ["11111111-1111-4111-8111-111111111111"],
                    "checkpoint": {
                        "cliAgentType": "pi",
                        "cliAgentSessionId": session_id,
                        "cliAgentSessionHistoryDisposition": "unavailable"
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
    let checkpoint =
        guest_agent::checkpoint::prepare_checkpoint_for_runtime(&runtime, &session_metadata)
            .await
            .unwrap();
    guest_agent::complete::report_checkpoint_for_run(
        &runtime,
        0,
        None,
        None,
        Some(42),
        &active_input_delivery_ids,
        checkpoint,
    )
    .await
    .unwrap();

    standalone_checkpoint.assert_calls_async(0).await;
    complete.assert_calls_async(1).await;
}

#[tokio::test]
async fn success_checkpoint_preserves_small_codex_history() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    runtime.config.framework = guest_agent::env::Framework::Codex;
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (history_dir, history_path, history) = write_prunable_codex_history(session_id).unwrap();
    std::fs::write(&history_path, &history).unwrap();
    use_test_codex_home(&mut runtime, history_dir.path());

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(r#"{"encoding":"identity"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"existing": true}));
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(format!(
                r#"{{"checkpoint":{{"cliAgentSessionHistoryHash":"{history_hash}"}}}}"#
            ));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "completed"}));
    });

    let checkpoint = guest_agent::checkpoint::prepare_checkpoint_for_runtime(
        &runtime,
        &checkpoint_session_metadata(&runtime),
    )
    .await
    .unwrap();
    report_prepared_checkpoint(&runtime, 0, checkpoint)
        .await
        .unwrap();

    prepare_mock.assert_calls_async(1).await;
    complete_mock.assert_calls_async(1).await;
    assert_eq!(std::fs::read(&history_path).unwrap(), history);
    assert_session_history_prune_operation(
        &runtime,
        "ineligible",
        Some("source_within_guard"),
        true,
    )
    .unwrap();
}

#[tokio::test]
async fn checkpoint_rejects_mistyped_prepare_response_before_upload() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    runtime.config.framework = guest_agent::env::Framework::Codex;
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "abababab-abab-4bab-8bab-abababababab";
    let (history_dir, history_path, history) = write_prunable_codex_history(session_id).unwrap();
    std::fs::write(&history_path, &history).unwrap();
    use_test_codex_home(&mut runtime, history_dir.path());

    let upload_path = "/test/invalid-prepare-history-upload";
    let sensitive_response_value = "sensitive-prepare-response-value";
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url(upload_path),
                "existing": sensitive_response_value,
                "encoding": "identity",
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT).path(upload_path);
        then.status(200);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/complete");
        then.status(200)
            .json_body(json!({"success": true, "status": "completed"}));
    });

    let error = guest_agent::checkpoint::prepare_checkpoint_for_runtime(
        &runtime,
        &checkpoint_session_metadata(&runtime),
    )
    .await
    .err()
    .expect("mistyped prepare response should fail checkpoint preparation");

    let message = error.to_string();
    assert!(message.contains("Invalid prepare-history response"));
    assert!(!message.contains(sensitive_response_value));
    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(0).await;
    complete_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn checkpoint_rejects_prepare_response_without_upload_url() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    runtime.config.framework = guest_agent::env::Framework::Codex;
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "adadadad-adad-4dad-8dad-adadadadadad";
    let (history_dir, history_path, history) = write_prunable_codex_history(session_id).unwrap();
    std::fs::write(&history_path, &history).unwrap();
    use_test_codex_home(&mut runtime, history_dir.path());

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "existing": false,
                "encoding": "identity",
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT);
        then.status(200);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/complete");
        then.status(200)
            .json_body(json!({"success": true, "status": "completed"}));
    });

    let error = guest_agent::checkpoint::prepare_checkpoint_for_runtime(
        &runtime,
        &checkpoint_session_metadata(&runtime),
    )
    .await
    .err()
    .expect("missing upload URL should fail checkpoint preparation");

    assert!(
        error
            .to_string()
            .contains("No presignedUrl in prepare-history response")
    );
    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(0).await;
    complete_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn checkpoint_reports_failed_session_history_upload_as_unavailable() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    runtime.config.framework = guest_agent::env::Framework::Codex;
    let _system_log_guard = SystemLogOverrideGuard::set(runtime.paths.system_log_file());
    let _files_guard = SessionCheckpointFilesGuard::new();
    let artifact_dir = tempfile::tempdir().unwrap();
    let missing_artifact_mount = artifact_dir.path().join("missing-memory");
    runtime.config.artifacts = vec![guest_agent::env::ArtifactEnv {
        name: "memory".to_string(),
        mount_path: missing_artifact_mount.to_string_lossy().into_owned(),
        storage_id: "memory-storage-id".to_string(),
        version_id: "preserved-memory-version".to_string(),
        missing_root_policy: Some(
            api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy::PreserveParentVersion,
        ),
    }];
    let session_id = "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae";
    let (history_dir, history_path, history) = write_prunable_codex_history(session_id).unwrap();
    std::fs::write(&history_path, &history).unwrap();
    use_test_codex_home(&mut runtime, history_dir.path());

    let upload_path = "/test/failed-session-history-upload";
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url(upload_path),
                "existing": false,
                "encoding": "identity",
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT).path(upload_path);
        then.status(502);
    });
    let artifact_snapshot = json!({
        "checkpoint": {
            "artifactSnapshots": [{
                "name": "memory",
                "version": "preserved-memory-version",
                "mountPath": missing_artifact_mount,
                "missingRootPolicy": "preserveParentVersion",
            }],
        },
    })
    .to_string();
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(r#"{"exitCode":0}"#)
            .json_body_includes(
                r#"{"checkpoint":{"cliAgentSessionHistoryDisposition":"unavailable"}}"#,
            )
            .json_body_includes(artifact_snapshot);
        then.status(200)
            .json_body(json!({"success": true, "status": "completed"}));
    });

    create_bounded_checkpoint(&runtime).await.unwrap();

    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    complete_mock.assert_calls_async(1).await;

    let operations = std::fs::read_to_string(runtime.paths.sandbox_ops_file()).unwrap();
    let upload_operation = operations
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
        .into_iter()
        .find(|operation| operation["action_type"] == "session_history_s3_upload")
        .expect("session history upload operation");
    assert_eq!(upload_operation["success"], false);
    assert_eq!(
        upload_operation["error"],
        "http: PUT presigned: HTTP 502 Bad Gateway"
    );

    let system_log = std::fs::read_to_string(runtime.paths.system_log_file()).unwrap();
    assert!(system_log.contains(
        "[ERROR] [sandbox:guest-agent] Session history upload failed; continuing checkpoint \
         without history: http: PUT presigned: HTTP 502 Bad Gateway"
    ));
    assert!(!system_log.contains(upload_path));
    assert!(!std::path::Path::new(runtime.paths.final_session_history_identity_file()).exists());
}

#[tokio::test]
async fn success_checkpoint_discards_oversized_claude_history_without_compact_boundary() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let line =
        b"{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":\"ordinary\"}}\n";
    let mut history = Vec::new();
    while history.len() <= CHECKPOINT_TEST_CANDIDATE_MAX_BYTES as usize {
        history.extend_from_slice(line);
    }
    let history_dir = write_literal_session_history(&mut runtime, session_id, &history).unwrap();
    let history_path = claude_history_path(history_dir.path(), session_id);

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(500);
    });
    let expected_session_id = session_id.to_string();
    let complete_mock = server.mock(move |when, then| {
        when.method(POST).path("/api/webhooks/agent/complete");
        then.respond_with(move |request| {
            let body = serde_json::from_slice::<Value>(request.body_ref()).unwrap();
            if body["checkpoint"]["cliAgentSessionId"] == expected_session_id
                && body["checkpoint"]["cliAgentSessionHistoryDisposition"] == "discarded_oversized"
                && body["checkpoint"]
                    .get("cliAgentSessionHistoryHash")
                    .is_none()
            {
                json_http_response(200, json!({"success": true, "status": "completed"}))
            } else {
                http_status(400)
            }
        });
    });

    create_bounded_checkpoint(&runtime).await.unwrap();

    prepare_mock.assert_calls_async(0).await;
    complete_mock.assert_calls_async(1).await;
    assert_eq!(std::fs::read(history_path).unwrap(), history);
    assert_session_history_prune_operation(
        &runtime,
        "ineligible",
        Some("no_compact_boundary"),
        true,
    )
    .unwrap();
    assert!(!std::path::Path::new(runtime.paths.final_session_history_identity_file()).exists());
}

#[tokio::test]
async fn success_checkpoint_discards_codex_history_that_jumps_past_hard_limit() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    runtime.config.framework = guest_agent::env::Framework::Codex;
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let (history_dir, history_path, history) =
        write_codex_history_without_compact(session_id, None, CHECKPOINT_TEST_MAX_BYTES as usize)
            .unwrap();
    use_test_codex_home(&mut runtime, history_dir.path());

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(500);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(r#"{"checkpoint":{"cliAgentType":"codex"}}"#)
            .json_body_includes(
                r#"{"checkpoint":{"cliAgentSessionHistoryDisposition":"discarded_oversized"}}"#,
            );
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "completed"}));
    });

    create_bounded_checkpoint(&runtime).await.unwrap();

    prepare_mock.assert_calls_async(0).await;
    complete_mock.assert_calls_async(1).await;
    assert_eq!(std::fs::read(history_path).unwrap(), history);
    assert_session_history_prune_operation(
        &runtime,
        "ineligible",
        Some("no_compact_boundary"),
        true,
    )
    .unwrap();
    assert!(!std::path::Path::new(runtime.paths.final_session_history_identity_file()).exists());
}

#[tokio::test]
async fn success_checkpoint_discards_codex_history_with_oversized_canonical_candidate() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    runtime.config.framework = guest_agent::env::Framework::Codex;
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let (history_dir, history_path, history) = write_codex_history_without_compact(
        session_id,
        Some(CHECKPOINT_TEST_CANDIDATE_MAX_BYTES as usize),
        CHECKPOINT_TEST_CANDIDATE_MAX_BYTES as usize,
    )
    .unwrap();
    use_test_codex_home(&mut runtime, history_dir.path());

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(500);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(
                r#"{"checkpoint":{"cliAgentSessionHistoryDisposition":"discarded_oversized"}}"#,
            );
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "completed"}));
    });

    create_bounded_checkpoint(&runtime).await.unwrap();

    prepare_mock.assert_calls_async(0).await;
    complete_mock.assert_calls_async(1).await;
    assert_eq!(std::fs::read(history_path).unwrap(), history);
    assert_session_history_prune_operation(
        &runtime,
        "ineligible",
        Some("candidate_too_large"),
        true,
    )
    .unwrap();
}

#[tokio::test]
async fn checkpoint_continues_when_codex_history_is_missing() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let mut runtime = runtime_from_process_env().unwrap();
    runtime.config.framework = guest_agent::env::Framework::Codex;
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let home = tempfile::tempdir().unwrap();
    use_test_codex_home(&mut runtime, home.path());
    guest_agent::paths::write_private(session_id_file(), session_id).unwrap();
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(
                r#"{"checkpoint":{"cliAgentSessionHistoryDisposition":"unavailable"}}"#,
            );
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "completed"}));
    });

    create_bounded_checkpoint(&runtime).await.unwrap();

    complete_mock.assert_calls_async(1).await;
    let operations = std::fs::read_to_string(runtime.paths.sandbox_ops_file()).unwrap();
    assert!(operations.lines().any(|line| {
        let operation: Value = serde_json::from_str(line).unwrap();
        operation["action_type"] == "session_history_read" && operation["success"] == false
    }));
    assert!(!operations.contains("\"action_type\":\"session_history_prune\""));
}

#[tokio::test]
async fn combined_checkpoint_accepts_terminal_acknowledgement_without_checkpoint_identity() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let mut runtime = runtime_from_process_env().unwrap();
    runtime.config.framework = guest_agent::env::Framework::Codex;
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "acacacac-acac-4cac-8cac-acacacacacac";
    let home = tempfile::tempdir().unwrap();
    use_test_codex_home(&mut runtime, home.path());
    guest_agent::paths::write_private(session_id_file(), session_id).unwrap();
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(
                r#"{"checkpoint":{"cliAgentSessionHistoryDisposition":"unavailable"}}"#,
            );
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "completed"}));
    });

    create_bounded_checkpoint(&runtime).await.unwrap();
    complete_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn success_checkpoint_reports_invalid_local_history_as_unavailable() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let mut runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(400);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(
                r#"{"checkpoint":{"cliAgentSessionHistoryDisposition":"unavailable"}}"#,
            );
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "completed"}));
    });

    let cases: [(&str, &[u8]); 2] = [
        (
            "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            b"{\"type\":\"assistant\"}\n\xff\n",
        ),
        (
            "ffffffff-ffff-4fff-8fff-ffffffffffff",
            b"{\"type\":\"assistant\"\n",
        ),
    ];
    for (session_id, history) in cases {
        let _history_dir =
            write_literal_session_history(&mut runtime, session_id, history).unwrap();

        create_bounded_checkpoint(&runtime).await.unwrap();

        assert!(
            !std::path::Path::new(runtime.paths.final_session_history_identity_file()).exists()
        );
    }

    prepare_mock.assert_calls_async(0).await;
    complete_mock.assert_calls_async(2).await;
}

#[tokio::test]
async fn success_checkpoint_reports_invalid_reused_zstd_history_as_unavailable() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let mut runtime = runtime_from_process_env().unwrap();
    runtime.config.framework = guest_agent::env::Framework::Codex;
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let home = tempfile::tempdir().unwrap();
    let day_dir = home.path().join(".codex/sessions/2026/08/15");
    std::fs::create_dir_all(&day_dir).unwrap();
    let encoded = zstd_session_history_for_test(b"{\"type\":\"assistant\"\n").unwrap();
    std::fs::write(
        day_dir.join(format!("rollout-{session_id}.jsonl.zst")),
        encoded,
    )
    .unwrap();
    use_test_codex_home(&mut runtime, home.path());
    guest_agent::paths::write_private(session_id_file(), session_id).unwrap();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(400);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(
                r#"{"checkpoint":{"cliAgentSessionHistoryDisposition":"unavailable"}}"#,
            );
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "completed"}));
    });

    create_bounded_checkpoint(&runtime).await.unwrap();

    prepare_mock.assert_calls_async(0).await;
    complete_mock.assert_calls_async(1).await;
    assert!(!std::path::Path::new(runtime.paths.final_session_history_identity_file()).exists());
}

#[tokio::test]
async fn success_checkpoint_reconciles_claude_compact_generation_after_commit() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (history_dir, candidate) = write_prunable_claude_history(&mut runtime, session_id).unwrap();
    let history_path = claude_history_path(history_dir.path(), session_id);
    let source_size = std::fs::metadata(&history_path).unwrap().len();

    let history_hash = hex::encode(Sha256::digest(&candidate));
    let history_size = candidate.len();
    let upload_url = server.url("/test/pruned-claude-history-upload");
    let prepare_history_path = history_path.clone();
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(format!(r#"{{"encodedSize":{history_size}}}"#))
            .json_body_includes(r#"{"encoding":"identity"}"#);
        then.respond_with(move |_| {
            if std::fs::metadata(&prepare_history_path)
                .is_ok_and(|metadata| metadata.len() == source_size)
            {
                json_http_response(
                    200,
                    json!({
                        "presignedUrl": upload_url.clone(),
                        "existing": false
                    }),
                )
            } else {
                http_status(500)
            }
        });
    });
    let upload_len = history_size.to_string();
    let upload_body = candidate.clone();
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/pruned-claude-history-upload")
            .header("Content-Type", "application/octet-stream");
        then.respond_with(move |req| upload_validation_response(req, &upload_body, &upload_len));
    });
    let checkpoint_history_path = history_path.clone();
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(format!(
                r#"{{"checkpoint":{{"cliAgentSessionId":"{session_id}"}}}}"#
            ))
            .json_body_includes(format!(
                r#"{{"checkpoint":{{"cliAgentSessionHistoryHash":"{history_hash}"}}}}"#
            ));
        then.respond_with(move |_| {
            if std::fs::metadata(&checkpoint_history_path)
                .is_ok_and(|metadata| metadata.len() == source_size)
            {
                json_http_response(200, json!({"success": true, "status": "completed"}))
            } else {
                http_status(500)
            }
        });
    });

    create_bounded_checkpoint(&runtime).await.unwrap();

    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    complete_mock.assert_calls_async(1).await;
    assert_eq!(std::fs::read(&history_path).unwrap(), candidate);

    let identity_bytes =
        std::fs::read(runtime.paths.final_session_history_identity_file()).unwrap();
    let identity = SessionHistoryIdentity::from_json_slice(&identity_bytes).unwrap();
    assert_eq!(identity.framework, SessionHistoryFramework::ClaudeCode);
    assert_eq!(identity.history_size_bytes, history_size as u64);
    assert_eq!(identity.history_hash, history_hash);
    assert_eq!(
        identity.history_source,
        checkpoint_session_metadata(&runtime)
            .history_source()
            .cloned()
            .expect("checkpoint history source")
    );
}

#[tokio::test]
async fn success_checkpoint_reconciles_codex_compact_generation_after_commit() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    runtime.config.framework = guest_agent::env::Framework::Codex;
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (history_dir, history_path, candidate) = write_prunable_codex_history(session_id).unwrap();
    use_test_codex_home(&mut runtime, history_dir.path());
    let source_size = std::fs::metadata(&history_path).unwrap().len();

    let history_hash = hex::encode(Sha256::digest(&candidate));
    let history_size = candidate.len();
    let upload_url = server.url("/test/pruned-codex-history-upload");
    let prepare_history_path = history_path.clone();
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(format!(r#"{{"encodedSize":{history_size}}}"#))
            .json_body_includes(r#"{"encoding":"identity"}"#);
        then.respond_with(move |_| {
            if std::fs::metadata(&prepare_history_path)
                .is_ok_and(|metadata| metadata.len() == source_size)
            {
                json_http_response(
                    200,
                    json!({
                        "presignedUrl": upload_url.clone(),
                        "existing": false,
                    }),
                )
            } else {
                http_status(500)
            }
        });
    });
    let upload_len = history_size.to_string();
    let upload_body = candidate.clone();
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/pruned-codex-history-upload")
            .header("Content-Type", "application/octet-stream");
        then.respond_with(move |request| {
            upload_validation_response(request, &upload_body, &upload_len)
        });
    });
    let checkpoint_history_path = history_path.clone();
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(format!(
                r#"{{"checkpoint":{{"cliAgentSessionId":"{session_id}"}}}}"#
            ))
            .json_body_includes(r#"{"checkpoint":{"cliAgentType":"codex"}}"#)
            .json_body_includes(format!(
                r#"{{"checkpoint":{{"cliAgentSessionHistoryHash":"{history_hash}"}}}}"#
            ));
        then.respond_with(move |_| {
            if std::fs::metadata(&checkpoint_history_path)
                .is_ok_and(|metadata| metadata.len() == source_size)
            {
                json_http_response(200, json!({"success": true, "status": "completed"}))
            } else {
                http_status(500)
            }
        });
    });

    create_bounded_checkpoint(&runtime).await.unwrap();

    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    complete_mock.assert_calls_async(1).await;
    assert_eq!(std::fs::read(&history_path).unwrap(), candidate);

    let identity_bytes =
        std::fs::read(runtime.paths.final_session_history_identity_file()).unwrap();
    let identity = SessionHistoryIdentity::from_json_slice(&identity_bytes).unwrap();
    assert_eq!(identity.framework, SessionHistoryFramework::Codex);
    assert_eq!(identity.history_size_bytes, history_size as u64);
    assert_eq!(identity.history_hash, history_hash);
    assert!(matches!(
        identity.history_source,
        guest_contracts::session_history_identity::SessionHistorySourceRef::Codex {
            ref thread_id,
            ..
        } if thread_id == session_id
    ));
    assert_session_history_prune_operation(&runtime, "selected", None, true).unwrap();
}

#[tokio::test]
async fn success_checkpoint_omits_identity_when_live_history_replacement_fails() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (history_dir, candidate) = write_prunable_claude_history(&mut runtime, session_id).unwrap();
    let history_path = claude_history_path(history_dir.path(), session_id);
    let source_size = std::fs::metadata(&history_path).unwrap().len();
    let moved_history_dir = history_dir.path().with_extension("replacement-source");

    let history_hash = hex::encode(Sha256::digest(&candidate));
    let history_size = candidate.len();
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"existing": true}));
    });
    let replacement_history_path = history_path.clone();
    let replacement_moved_dir = moved_history_dir.clone();
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(format!(
                r#"{{"checkpoint":{{"cliAgentSessionHistoryHash":"{history_hash}"}}}}"#
            ));
        then.respond_with(move |_| {
            let history_parent = replacement_history_path.parent().unwrap();
            std::fs::rename(history_parent, &replacement_moved_dir).unwrap();
            std::fs::create_dir(history_parent).unwrap();
            std::fs::rename(
                replacement_moved_dir.join(replacement_history_path.file_name().unwrap()),
                &replacement_history_path,
            )
            .unwrap();
            json_http_response(200, json!({"success": true, "status": "completed"}))
        });
    });

    create_bounded_checkpoint(&runtime).await.unwrap();

    prepare_mock.assert_calls_async(1).await;
    complete_mock.assert_calls_async(1).await;
    assert_eq!(std::fs::metadata(&history_path).unwrap().len(), source_size);
    assert!(!std::path::Path::new(runtime.paths.final_session_history_identity_file()).exists());
    std::fs::remove_dir_all(moved_history_dir).unwrap();
}

#[tokio::test]
async fn success_checkpoint_keeps_live_history_when_compact_commit_fails() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (history_dir, candidate) = write_prunable_claude_history(&mut runtime, session_id).unwrap();
    let history_path = claude_history_path(history_dir.path(), session_id);
    let source_size = std::fs::metadata(&history_path).unwrap().len();

    let history_hash = hex::encode(Sha256::digest(&candidate));
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"existing": true}));
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(format!(
                r#"{{"checkpoint":{{"cliAgentSessionHistoryHash":"{history_hash}"}}}}"#
            ));
        then.status(500).header("Content-Type", "application/json");
    });

    let error = create_bounded_checkpoint(&runtime).await.unwrap_err();

    assert!(error.to_string().contains("POST failed after 3 attempts"));
    prepare_mock.assert_calls_async(1).await;
    complete_mock.assert_calls_async(3).await;
    assert_eq!(std::fs::metadata(&history_path).unwrap().len(), source_size);
    assert!(!std::path::Path::new(runtime.paths.final_session_history_identity_file()).exists());
}

#[tokio::test]
async fn success_checkpoint_writes_large_final_identity_metadata()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = large_session_history();
    let _history_dir =
        write_literal_session_history(&mut runtime, "success-large-session", &history).unwrap();

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let zstd_history = zstd_session_history_for_test(&history)?;
    let zstd_size = zstd_history.len();
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(format!(r#"{{"encodedSize":{zstd_size}}}"#))
            .json_body_includes(r#"{"encoding":"zstd"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/success-large-history-upload"),
                "existing": false,
                "encoding": "zstd"
            }));
    });
    let upload_body = history.clone();
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/success-large-history-upload")
            .header("Content-Type", "application/octet-stream");
        then.respond_with(move |req| upload_zstd_validation_response(req, &upload_body));
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(r#"{"checkpoint":{"cliAgentSessionId":"success-large-session"}}"#)
            .json_body_includes(format!(
                r#"{{"checkpoint":{{"cliAgentSessionHistoryHash":"{history_hash}"}}}}"#
            ));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "completed"}));
    });

    let result = guest_agent::checkpoint::prepare_checkpoint_for_runtime(
        &runtime,
        &checkpoint_session_metadata(&runtime),
    )
    .await;

    let checkpoint = result.unwrap();
    report_prepared_checkpoint(&runtime, 0, checkpoint).await?;
    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    complete_mock.assert_calls_async(1).await;

    let identity_bytes =
        std::fs::read(runtime.paths.final_session_history_identity_file()).unwrap();
    let identity = SessionHistoryIdentity::from_json_slice(&identity_bytes).unwrap();
    assert_eq!(identity.framework, SessionHistoryFramework::ClaudeCode);
    assert_eq!(identity.history_ref_kind, SessionHistoryRefKind::Blob);
    assert_eq!(
        identity.session_id_hash,
        hex::encode(Sha256::digest(b"success-large-session"))
    );
    assert_eq!(identity.history_hash, history_hash);
    assert_eq!(identity.history_size_bytes, history_size as u64);
    assert_eq!(
        std::fs::read(claude_history_path(
            _history_dir.path(),
            "success-large-session",
        ))
        .unwrap(),
        history
    );
    Ok(())
}

#[tokio::test]
async fn success_checkpoint_propagates_zstd_prepare_bad_request()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = large_session_history();
    let _history_dir =
        write_literal_session_history(&mut runtime, "zstd-bad-request-session", &history).unwrap();

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let zstd_size = zstd_session_history_for_test(&history)?.len();
    let zstd_prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(format!(r#"{{"encodedSize":{zstd_size}}}"#))
            .json_body_includes(r#"{"encoding":"zstd"}"#);
        then.status(400)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "error": {
                    "message": "Session history encoded size does not match the existing blob"
                }
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT);
        then.status(200);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/complete");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "completed"}));
    });

    let result = guest_agent::checkpoint::prepare_checkpoint_for_runtime(
        &runtime,
        &checkpoint_session_metadata(&runtime),
    )
    .await;

    let err = result
        .err()
        .expect("mismatched existing blob should fail checkpoint preparation");
    assert!(
        err.to_string()
            .contains("Session history encoded size does not match the existing blob"),
        "expected prepare-history error to propagate, got: {err}"
    );
    zstd_prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(0).await;
    complete_mock.assert_calls_async(0).await;
    Ok(())
}

#[tokio::test]
async fn success_checkpoint_rejects_missing_zstd_encoding_acknowledgement()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = large_session_history();
    let _history_dir =
        write_literal_session_history(&mut runtime, "zstd-unack-session", &history).unwrap();

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let zstd_size = zstd_session_history_for_test(&history)?.len();
    let zstd_prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(format!(r#"{{"encodedSize":{zstd_size}}}"#))
            .json_body_includes(r#"{"encoding":"zstd"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/zstd-unack-history-upload"),
                "existing": false
            }));
    });
    let zstd_upload_mock = server.mock(|when, then| {
        when.method(PUT).path("/test/zstd-unack-history-upload");
        then.status(200);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/complete");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "completed"}));
    });

    let result = guest_agent::checkpoint::prepare_checkpoint_for_runtime(
        &runtime,
        &checkpoint_session_metadata(&runtime),
    )
    .await;

    let err = result
        .err()
        .expect("missing zstd acknowledgement should fail checkpoint preparation");
    assert!(
        err.to_string()
            .contains("Prepare-history response did not acknowledge zstd"),
        "expected zstd acknowledgement failure, got: {err}"
    );
    zstd_prepare_mock.assert_calls_async(1).await;
    zstd_upload_mock.assert_calls_async(0).await;
    complete_mock.assert_calls_async(0).await;
    Ok(())
}

#[tokio::test]
async fn success_checkpoint_rejects_new_zstd_with_mismatched_encoding_acknowledgement()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = large_session_history();
    let _history_dir =
        write_literal_session_history(&mut runtime, "zstd-new-mismatched-ack-session", &history)
            .unwrap();

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let zstd_size = zstd_session_history_for_test(&history)?.len();
    let zstd_prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(format!(r#"{{"encodedSize":{zstd_size}}}"#))
            .json_body_includes(r#"{"encoding":"zstd"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/zstd-new-mismatched-ack-upload"),
                "existing": false,
                "encoding": "identity"
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/zstd-new-mismatched-ack-upload");
        then.status(200);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/complete");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "completed"}));
    });

    let result = guest_agent::checkpoint::prepare_checkpoint_for_runtime(
        &runtime,
        &checkpoint_session_metadata(&runtime),
    )
    .await;

    let err = result
        .err()
        .expect("mismatched zstd acknowledgement should fail checkpoint preparation");
    assert!(
        err.to_string()
            .contains("Prepare-history response did not acknowledge zstd"),
        "expected zstd acknowledgement failure, got: {err}"
    );
    zstd_prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(0).await;
    complete_mock.assert_calls_async(0).await;
    Ok(())
}

#[tokio::test]
async fn success_checkpoint_accepts_existing_gzip_for_zstd_history()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = large_session_history();
    let _history_dir =
        write_literal_session_history(&mut runtime, "zstd-existing-gzip-session", &history)
            .unwrap();

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let zstd_size = zstd_session_history_for_test(&history)?.len();
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(format!(r#"{{"encodedSize":{zstd_size}}}"#))
            .json_body_includes(r#"{"encoding":"zstd"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "existing": true,
                "encoding": "gzip"
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT);
        then.status(200);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(
                r#"{"checkpoint":{"cliAgentSessionId":"zstd-existing-gzip-session"}}"#,
            )
            .json_body_includes(format!(
                r#"{{"checkpoint":{{"cliAgentSessionHistoryHash":"{history_hash}"}}}}"#
            ));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "completed"}));
    });

    let result = guest_agent::checkpoint::prepare_checkpoint_for_runtime(
        &runtime,
        &checkpoint_session_metadata(&runtime),
    )
    .await;

    let checkpoint = result.unwrap();
    report_prepared_checkpoint(&runtime, 0, checkpoint).await?;
    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(0).await;
    complete_mock.assert_calls_async(1).await;
    Ok(())
}

#[tokio::test]
async fn success_checkpoint_propagates_zstd_auth_failure() -> Result<(), Box<dyn std::error::Error>>
{
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = large_session_history();
    let _history_dir =
        write_literal_session_history(&mut runtime, "zstd-auth-failure-session", &history).unwrap();

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let zstd_size = zstd_session_history_for_test(&history)?.len();
    let zstd_prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(format!(r#"{{"encodedSize":{zstd_size}}}"#))
            .json_body_includes(r#"{"encoding":"zstd"}"#);
        then.status(401)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "error": {
                    "message": "unauthorized checkpoint history prepare"
                }
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT);
        then.status(200);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/complete");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "completed"}));
    });

    let result = guest_agent::checkpoint::prepare_checkpoint_for_runtime(
        &runtime,
        &checkpoint_session_metadata(&runtime),
    )
    .await;

    let err = result
        .err()
        .expect("authorization failure should fail checkpoint preparation");
    assert!(
        err.to_string()
            .contains("unauthorized checkpoint history prepare"),
        "expected auth failure to propagate, got: {err}"
    );
    zstd_prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(0).await;
    complete_mock.assert_calls_async(0).await;
    Ok(())
}

#[tokio::test]
async fn success_checkpoint_uses_explicit_runtime_after_process_env_changes() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let _run_id_guard = EnvVarRestore::capture(guest_contracts::env::RUN_ID_ENV);
    let _runtime_dir_guard =
        EnvVarRestore::capture(guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV);

    let tmp = tempfile::tempdir().unwrap();
    let runtime_dir = tmp.path().join("captured-runtime");
    let stale_runtime_dir = tmp.path().join("stale-runtime");
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

    unsafe {
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, "stale-run-after-runtime");
        std::env::set_var(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            &stale_runtime_dir,
        );
    }

    let history_hash = hex::encode(Sha256::digest(history.as_bytes()));
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"captured-run"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{}}}"#, history.len()))
            .json_body_includes(format!(r#"{{"encodedSize":{}}}"#, history.len()))
            .json_body_includes(r#"{"encoding":"identity"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/explicit-runtime-history-upload"),
                "existing": false
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/explicit-runtime-history-upload")
            .body(history.as_str());
        then.status(200);
    });
    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(r#"{"runId":"captured-run"}"#)
            .json_body_includes(r#"{"checkpoint":{"cliAgentType":"claude-code"}}"#)
            .json_body_includes(r#"{"checkpoint":{"cliAgentSessionId":"captured-session"}}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "completed"}));
    });

    let result = guest_agent::checkpoint::prepare_checkpoint_for_runtime(
        &runtime,
        &checkpoint_session_metadata(&runtime),
    )
    .await;

    let checkpoint = result.unwrap();
    report_prepared_checkpoint(&runtime, 0, checkpoint)
        .await
        .unwrap();
    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
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
