use guest_agent::env::{GuestConfig, GuestConfigRaw};
use guest_agent::http::HttpClient;
use guest_agent::paths::GuestPaths;
use guest_agent::run_context::GuestRuntime;
use httpmock::prelude::*;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

const RUN_ID: &str = "artifact-finalization-content-hash";
const STORAGE_ID: &str = "01234567-89ab-cdef-0123-456789abcdef";

fn sha256_hex(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}

fn content_hash_for_single_file(storage_id: &str, path: &str, content: &str) -> String {
    let file_hash = sha256_hex(content.as_bytes());
    sha256_hex(format!("storage:{storage_id}\n{path}:{file_hash}"))
}

fn finalization_request_has_artifact_snapshot(
    req: &HttpMockRequest,
    expected_version: &str,
    expected_mount_path: &str,
    expected_missing_mount_path: &str,
) -> bool {
    let Ok(body) = serde_json::from_slice::<serde_json::Value>(req.body_ref()) else {
        return false;
    };
    let Some(snapshots) = body
        .get("completion")
        .and_then(|finalization| finalization.get("artifactSnapshots"))
        .and_then(|value| value.as_array())
    else {
        return false;
    };

    let unchanged_snapshot_matches = snapshots.iter().any(|snapshot| {
        snapshot.get("name").and_then(|value| value.as_str()) == Some("workspace")
            && snapshot.get("version").and_then(|value| value.as_str()) == Some(expected_version)
            && snapshot.get("mountPath").and_then(|value| value.as_str())
                == Some(expected_mount_path)
            && snapshot
                .get("missingRootPolicy")
                .and_then(|value| value.as_str())
                == Some("fail")
    });
    let preserved_snapshot_matches = snapshots.iter().any(|snapshot| {
        snapshot.get("name").and_then(|value| value.as_str()) == Some("memory")
            && snapshot.get("version").and_then(|value| value.as_str())
                == Some("preserved-memory-version")
            && snapshot.get("mountPath").and_then(|value| value.as_str())
                == Some(expected_missing_mount_path)
            && snapshot
                .get("missingRootPolicy")
                .and_then(|value| value.as_str())
                == Some("preserveParentVersion")
    });
    unchanged_snapshot_matches && preserved_snapshot_matches
}

struct SandboxOpsOverrideGuard;

impl SandboxOpsOverrideGuard {
    fn set(path: &str) -> Self {
        guest_telemetry::telemetry::set_sandbox_ops_log_file(path);
        Self
    }
}

impl Drop for SandboxOpsOverrideGuard {
    fn drop(&mut self) {
        guest_telemetry::telemetry::clear_sandbox_ops_log_file();
    }
}

fn write_run_payload(
    runtime_dir: &Path,
    payload: &guest_contracts::env::RunPayload,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::write(&path, serde_json::to_vec(payload)?)?;
    Ok(path)
}

fn test_runtime(
    temp_dir: &Path,
    mount_path: &Path,
    version_id: &str,
    api_url: &str,
) -> Result<GuestRuntime, Box<dyn std::error::Error>> {
    let runtime_dir = temp_dir.join("runtime");
    let missing_mount_path = temp_dir.join("missing-memory");
    let paths = GuestPaths::from_runtime_dir(&runtime_dir);
    let run_payload_file = write_run_payload(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            artifacts: json!([
                {
                    "name": "workspace",
                    "mountPath": mount_path.to_string_lossy(),
                    "storageId": STORAGE_ID,
                    "versionId": version_id,
                    "missingRootPolicy": "fail",
                },
                {
                    "name": "memory",
                    "mountPath": missing_mount_path.to_string_lossy(),
                    "storageId": "memory-storage-id",
                    "versionId": "preserved-memory-version",
                    "missingRootPolicy": "preserveParentVersion",
                }
            ])
            .to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;
    let config = GuestConfig::from_raw(GuestConfigRaw {
        run_id: RUN_ID.to_string(),
        api_url: api_url.to_string(),
        api_token: "test-token".to_string(),
        cli_agent_type: "claude-code".to_string(),
        home: Some(temp_dir.join("home").to_string_lossy().into_owned()),
        run_payload_file: run_payload_file.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(runtime_dir),
        ..GuestConfigRaw::default()
    })?;
    let http =
        HttpClient::with_api_config(api_url, "test-token", "", "test-run-001", Duration::ZERO)?;
    Ok(GuestRuntime {
        config,
        paths,
        http,
        workload_containment: None,
        process_control_endpoint: None,
    })
}

#[tokio::test(flavor = "current_thread")]
async fn unchanged_artifact_finalization_records_content_hash_timing()
-> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = tempfile::tempdir()?;
    let mount_path = temp_dir.path().join("workspace");
    std::fs::create_dir(&mount_path)?;
    std::fs::write(mount_path.join("a.txt"), "hello")?;
    let version_id = content_hash_for_single_file(STORAGE_ID, "a.txt", "hello");

    let server = MockServer::start();
    let runtime = test_runtime(
        temp_dir.path(),
        &mount_path,
        &version_id,
        &server.base_url(),
    )?;
    let _sandbox_ops_guard = SandboxOpsOverrideGuard::set(runtime.paths.sandbox_ops_file());

    let session_id = "session-abc";
    let config_dir = Path::new(&runtime.config.home_dir).join(".claude");
    let history_path = config_dir
        .join("projects/-home-user-workspace")
        .join(format!("{session_id}.jsonl"));
    std::fs::create_dir_all(history_path.parent().unwrap())?;
    std::fs::write(&history_path, r#"{"type":"system"}"#)?;
    let session_metadata = guest_agent::session_metadata::CapturedSessionMetadata::for_test(
        session_id,
        Some(
            guest_contracts::session_history_identity::SessionHistorySourceRef::ClaudeCode {
                config_dir: config_dir.to_string_lossy().into_owned(),
                working_dir: guest_agent::paths::CANONICAL_WORKING_DIR.to_string(),
                session_id: session_id.to_string(),
            },
        ),
    );

    let history_prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/session-history/prepare")
            .json_body_includes(format!(r#"{{"runId":"{RUN_ID}"}}"#));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"existing": true}));
    });
    let storage_prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/prepare");
        then.status(200).json_body(json!({"unreachable": true}));
    });
    let storage_commit = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/commit");
        then.status(200).json_body(json!({"unreachable": true}));
    });
    let expected_version = version_id.clone();
    let expected_mount_path = mount_path.to_string_lossy().into_owned();
    let expected_missing_mount_path = temp_dir
        .path()
        .join("missing-memory")
        .to_string_lossy()
        .into_owned();
    let complete = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .is_true(move |req| {
                finalization_request_has_artifact_snapshot(
                    req,
                    &expected_version,
                    &expected_mount_path,
                    &expected_missing_mount_path,
                )
            });
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"success": true, "status": "completed"}));
    });

    let finalization =
        guest_agent::finalization::prepare_finalization_for_runtime(&runtime, &session_metadata)
            .await?;
    guest_agent::complete::report_finalization_for_run(&runtime, 0, None, None, None, finalization)
        .await?;

    history_prepare.assert_calls_async(1).await;
    storage_prepare.assert_calls_async(0).await;
    storage_commit.assert_calls_async(0).await;
    complete.assert_calls_async(1).await;

    let sandbox_ops = std::fs::read_to_string(runtime.paths.sandbox_ops_file())?;
    assert!(sandbox_ops.contains(r#""action_type":"artifact_content_hash_compute""#));
    assert!(sandbox_ops.contains(r#""action_type":"artifact_snapshot_skipped""#));

    Ok(())
}
