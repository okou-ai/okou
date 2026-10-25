use super::support::*;
use crate::support::*;
use httpmock::prelude::*;
use serde_json::json;

#[tokio::test]
async fn memory_publication_conflict_completes_with_captured_parent_and_other_outputs() {
    for existing in [true, false] {
        let api = SharedApiMock::new().await;
        let server = api.server();
        let mut runtime = finalization_runtime().unwrap();
        runtime.config.framework = guest_agent::env::Framework::Pi;
        let dir = tempfile::tempdir().unwrap();
        let mut outputs = Vec::new();
        let mut commits = Vec::new();
        for (name, storage_id, parent, candidate) in [
            (
                "memory",
                "00000000-0000-4000-8000-000000000001",
                "captured-memory-parent",
                "retained-memory-candidate",
            ),
            (
                "workspace",
                "00000000-0000-4000-8000-000000000002",
                "captured-workspace-parent",
                "published-workspace-version",
            ),
            (
                "reports",
                "00000000-0000-4000-8000-000000000003",
                "captured-reports-parent",
                "published-reports-version",
            ),
        ] {
            let mount = dir.path().join(name);
            std::fs::create_dir(&mount).unwrap();
            std::fs::write(mount.join("notes.md"), "New candidate content").unwrap();
            let is_memory = name == "memory";
            let mount_path = mount.to_string_lossy().into_owned();
            runtime.config.artifacts.push(guest_agent::env::ArtifactEnv {
                name: name.to_string(),
                mount_path: mount_path.clone(),
                storage_id: storage_id.to_string(),
                version_id: parent.to_string(),
                missing_root_policy: is_memory.then_some(
                    api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy::PreserveParentVersion,
                ),
            });
            let mut output = json!({
                "name": name,
                "version": if is_memory { parent } else { candidate },
                "mountPath": mount_path,
            });
            if is_memory {
                output["missingRootPolicy"] = json!("preserveParentVersion");
            }
            outputs.push(output);

            server.mock(|when, then| {
                when.method(POST)
                    .path("/api/webhooks/agent/storages/prepare")
                    .json_body_includes(
                        json!({"storageId": storage_id, "parentVersionId": parent}).to_string(),
                    );
                let response = if is_memory && !existing {
                    json!({
                        "versionId": candidate,
                        "existing": false,
                        "uploads": {
                            "archive": {
                                "key": "archive.tar.gz",
                                "presignedUrl": format!("{}/memory-archive", server.base_url()),
                            },
                            "manifest": {
                                "key": "manifest.json",
                                "presignedUrl": format!("{}/memory-manifest", server.base_url()),
                            },
                        },
                    })
                } else {
                    json!({"versionId": candidate, "existing": true})
                };
                then.status(200).json_body(response);
            });
            commits.push(server.mock(|when, then| {
                when.method(POST)
                    .path("/api/webhooks/agent/storages/commit")
                    .json_body_includes(
                        json!({
                            "storageId": storage_id,
                            "parentVersionId": parent,
                            "versionId": candidate,
                        })
                        .to_string(),
                    );
                if is_memory {
                    then.status(409).json_body(json!({
                        "error": {
                            "code": "CONFLICT",
                            "message": "Memory changed during this Run. Candidate version retained-memory-candidate was retained; review the latest memory before publishing again.",
                        },
                    }));
                } else {
                    then.status(200).json_body(json!({
                        "success": true,
                        "storageName": name,
                        "versionId": candidate,
                        "size": 21,
                        "fileCount": 1,
                    }));
                }
            }));
        }
        let archive = server.mock(|when, then| {
            when.method(PUT).path("/memory-archive");
            then.status(200);
        });
        let manifest = server.mock(|when, then| {
            when.method(PUT).path("/memory-manifest");
            then.status(200);
        });
        let complete = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/complete")
                .json_body_includes(
                    json!({
                        "runId": "test-run-001",
                        "exitCode": 0,
                        "completion": {
                            "cliAgentType": "pi",
                            "cliAgentSessionId": "memory-conflict-session",
                            "cliAgentSessionHistoryDisposition": "native_only",
                            "storageOutputs": outputs,
                        },
                    })
                    .to_string(),
                );
            then.status(200)
                .json_body(json!({"success": true, "status": "completed"}));
        });
        let metadata = guest_agent::session_metadata::CapturedSessionMetadata::for_test(
            "memory-conflict-session",
            None,
        );
        let finalization =
            guest_agent::finalization::prepare_finalization_for_runtime(&runtime, &metadata)
                .await
                .unwrap();
        report_prepared_finalization(&runtime, 0, finalization)
            .await
            .unwrap();

        complete.assert_calls_async(1).await;
        for commit in commits {
            commit.assert_calls_async(1).await;
        }
        let uploads = usize::from(!existing);
        archive.assert_calls_async(uploads).await;
        manifest.assert_calls_async(uploads).await;
    }
}

#[tokio::test]
async fn other_artifact_and_memory_prepare_conflicts_still_fail_finalization() {
    for name in ["workspace", "memory"] {
        let api = SharedApiMock::new().await;
        let server = api.server();
        let mut runtime = finalization_runtime().unwrap();
        runtime.config.framework = guest_agent::env::Framework::Pi;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.md"), "Candidate content").unwrap();
        runtime
            .config
            .artifacts
            .push(guest_agent::env::ArtifactEnv {
                name: name.to_string(),
                mount_path: dir.path().to_string_lossy().into_owned(),
                storage_id: "00000000-0000-4000-8000-000000000001".to_string(),
                version_id: "captured-parent".to_string(),
                missing_root_policy: None,
            });
        server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/prepare");
            if name == "memory" {
                then.status(409).json_body(json!({
                    "error": {"code": "CONFLICT", "message": "Preparation conflict"},
                }));
            } else {
                then.status(200).json_body(json!({
                    "versionId": "candidate",
                    "existing": true,
                }));
            }
        });
        server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/commit");
            then.status(409).json_body(json!({
                "error": {"code": "CONFLICT", "message": "Artifact conflict"},
            }));
        });
        let metadata = guest_agent::session_metadata::CapturedSessionMetadata::for_test(
            "conflict-session",
            None,
        );
        let error =
            guest_agent::finalization::prepare_finalization_for_runtime(&runtime, &metadata)
                .await
                .err()
                .expect("only a retained Memory commit conflict can complete successfully");
        assert!(matches!(
            error,
            guest_agent::error::AgentError::HttpStatus { status: 409, .. }
        ));
    }
}

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
