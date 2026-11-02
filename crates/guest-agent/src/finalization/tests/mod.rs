use super::*;
use httpmock::prelude::*;
use serde_json::json;
use std::time::Duration;

struct FinalizationFilesGuard {
    guest_paths: crate::paths::GuestPaths,
}

impl FinalizationFilesGuard {
    fn new(guest_paths: &crate::paths::GuestPaths) -> Self {
        cleanup_finalization_files(guest_paths);
        Self {
            guest_paths: guest_paths.clone(),
        }
    }
}

impl Drop for FinalizationFilesGuard {
    fn drop(&mut self) {
        cleanup_finalization_files(&self.guest_paths);
    }
}

fn cleanup_finalization_files(guest_paths: &crate::paths::GuestPaths) {
    let _ = std::fs::remove_file(guest_paths.session_id_file());
}

#[tokio::test]
async fn finalization_reports_native_identity_for_success_and_recovery() {
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
    let server = MockServer::start();
    let http = HttpClient::with_api_config(
        server.base_url(),
        "test-token",
        "",
        "native-finalization",
        Duration::ZERO,
    )
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let guest_paths = crate::paths::GuestPaths::from_runtime_dir(dir.path().join("runtime"));
    let session_metadata = CapturedSessionMetadata::for_test("native-session", None);
    let inputs = FinalizationInputs {
        run_id: "native-finalization",
        framework: env::Framework::ClaudeCode,
        artifact_entries: &[],
        session_metadata: &session_metadata,
        final_session_history_identity_file: guest_paths
            .final_session_history_identity_file()
            .into(),
    };
    for mode in [FinalizationMode::Success, FinalizationMode::Recovery] {
        let prepared = prepare_finalization_impl(&http, mode, &inputs)
            .await
            .unwrap();
        assert_eq!(prepared.request.cli_agent_session_id, "native-session");
        assert_eq!(
            prepared.request.cli_agent_session_history_disposition,
            complete::RequestCompletionCliAgentSessionHistoryDisposition::NativeOnly
        );
    }
}

#[tokio::test]
async fn finalization_missing_mount_fails_before_final_completion() {
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
    let server = MockServer::start();
    let dir = tempfile::tempdir().unwrap();
    let guest_paths = crate::paths::GuestPaths::from_runtime_dir(dir.path().join("runtime"));
    let _files_guard = FinalizationFilesGuard::new(&guest_paths);

    let prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/prepare");
        then.status(200).json_body(json!({"unreachable": true}));
    });
    let commit = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/commit");
        then.status(200).json_body(json!({"unreachable": true}));
    });
    let http = HttpClient::with_api_config(
        server.base_url(),
        "test-token",
        "",
        "test-run-001",
        Duration::ZERO,
    )
    .unwrap();
    let missing_mount = dir.path().join("missing");
    let entries = vec![env::ArtifactEnv {
        name: "workspace".to_string(),
        mount_path: missing_mount.to_string_lossy().into_owned(),
        storage_id: "storage-id".to_string(),
        version_id: "parent-version".to_string(),
        missing_root_policy: None,
    }];
    let session_metadata =
        CapturedSessionMetadata::for_test("session-finalization-missing-mount", None);

    let inputs = FinalizationInputs {
        run_id: "finalization-missing-mount",
        framework: env::Framework::ClaudeCode,
        artifact_entries: &entries,
        session_metadata: &session_metadata,
        final_session_history_identity_file: guest_paths
            .final_session_history_identity_file()
            .into(),
    };

    let err = prepare_finalization_impl(&http, FinalizationMode::Success, &inputs)
        .await
        .err()
        .expect("missing artifact mount should fail finalization preparation");

    assert!(
        err.to_string().contains("Failed to walk artifact files"),
        "got: {err}"
    );
    prepare.assert_calls(0);
    commit.assert_calls(0);
}

#[tokio::test]
async fn ordinary_recovery_finalization_still_snapshots_changed_artifacts() {
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
    let server = MockServer::start();
    let prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/prepare");
        then.status(500);
    });
    let commit = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/commit");
        then.status(200).json_body(json!({"success": true}));
    });
    let http = HttpClient::with_api_config(
        server.base_url(),
        "test-token",
        "",
        "ordinary-recovery-run",
        Duration::ZERO,
    )
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let guest_paths = crate::paths::GuestPaths::from_runtime_dir(dir.path().join("runtime"));
    let _files_guard = FinalizationFilesGuard::new(&guest_paths);
    let workspace_root = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace_root).unwrap();
    std::fs::write(workspace_root.join("result.txt"), "recover me").unwrap();
    let entries = vec![env::ArtifactEnv {
        name: "workspace".to_string(),
        mount_path: workspace_root.to_string_lossy().into_owned(),
        storage_id: "1d09f0c9-a5c6-4f21-9664-d80a3ca3ae63".to_string(),
        version_id: "a".repeat(64),
        missing_root_policy: None,
    }];
    let session_metadata = CapturedSessionMetadata::for_test("ordinary-recovery-run", None);
    let inputs = FinalizationInputs {
        run_id: "ordinary-recovery-run",
        framework: env::Framework::ClaudeCode,
        artifact_entries: &entries,
        session_metadata: &session_metadata,
        final_session_history_identity_file: guest_paths
            .final_session_history_identity_file()
            .into(),
    };

    prepare_recovery_finalization_with_inputs(&http, &inputs)
        .await
        .err()
        .expect("fixture intentionally rejects the ordinary upload");

    assert!(prepare.calls() > 0);
    commit.assert_calls(0);
}
