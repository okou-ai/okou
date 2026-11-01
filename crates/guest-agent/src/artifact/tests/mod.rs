use super::*;
use httpmock::prelude::*;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::sync::LazyLock;
use std::time::Duration;

static SNAPSHOT_MOCK_SERVER: LazyLock<httpmock::MockServer> =
    LazyLock::new(httpmock::MockServer::start);
const SNAPSHOT_STORAGE_ID: &str = "00000000-0000-4000-8000-000000000001";

fn disable_system_log() {
    guest_telemetry::log::clear_system_log_file();
}

fn test_http_client(server: &httpmock::MockServer) -> Result<HttpClient, AgentError> {
    HttpClient::with_api_config(
        server.base_url(),
        "test-token",
        "",
        "test-run-001",
        Duration::ZERO,
    )
}

fn file_json_values(files: &[FileEntry]) -> Vec<serde_json::Value> {
    files
        .iter()
        .map(|file| {
            serde_json::json!({
                "path": file.path,
                "hash": file.hash,
                "size": file.size,
            })
        })
        .collect()
}

fn http_status(status: u16) -> HttpMockResponse {
    HttpMockResponse::builder().status(status).build()
}

fn request_header_eq(req: &HttpMockRequest, name: &str, expected: &str) -> bool {
    req.headers_vec()
        .iter()
        .any(|(key, value)| key.eq_ignore_ascii_case(name) && value == expected)
}

fn manifest_upload_response(
    req: &HttpMockRequest,
    expected_files: &[serde_json::Value],
) -> HttpMockResponse {
    let Ok(body) = serde_json::from_slice::<serde_json::Value>(req.body_ref()) else {
        return http_status(400);
    };
    let compact_body_len = body.to_string().len();
    let expected_files = serde_json::Value::Array(expected_files.to_vec());
    if request_header_eq(req, "content-type", "application/json")
        && req.body_ref().len() == compact_body_len
        && body.get("version") == Some(&serde_json::json!(1))
        && body.get("files") == Some(&expected_files)
        && body
            .get("createdAt")
            .and_then(serde_json::Value::as_str)
            .is_some()
    {
        http_status(200)
    } else {
        http_status(400)
    }
}

fn sandbox_op_successes(path: &Path, action_type: &str) -> Result<Vec<bool>, AgentError> {
    let contents = std::fs::read_to_string(path)?;
    let mut successes = Vec::new();
    for line in contents.lines() {
        let entry = serde_json::from_str::<serde_json::Value>(line)?;
        if entry.get("action_type").and_then(serde_json::Value::as_str) != Some(action_type) {
            continue;
        }
        let Some(success) = entry.get("success").and_then(serde_json::Value::as_bool) else {
            return Err(AgentError::Execution(format!(
                "{action_type} telemetry omitted boolean success"
            )));
        };
        successes.push(success);
    }
    Ok(successes)
}

#[tokio::test]
async fn snapshot_rejects_empty_prepare_response_before_upload_or_commit() -> Result<(), AgentError>
{
    let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
    disable_system_log();
    let server = MockServer::start();

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("alpha.txt"), "alpha").unwrap();
    let files = archive::collect_file_metadata(root.to_str().unwrap()).unwrap();

    let prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/prepare");
        then.status(200);
    });
    let upload = server.mock(|when, then| {
        when.method(PUT);
        then.status(200);
    });
    let commit = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/commit");
        then.status(200)
            .json_body(serde_json::json!({ "success": true }));
    });

    let http = test_http_client(&server)?;
    let result = create_snapshot(
        &http,
        CreateSnapshotRequest {
            mount_path: root.to_str().unwrap(),
            files,
            storage_id: SNAPSHOT_STORAGE_ID,
            run_id: "run-empty-prepare",
            message: "snapshot message",
            parent_version_id: "parent-v1",
        },
    )
    .await;

    let Err(err) = result else {
        panic!("create_snapshot unexpectedly succeeded");
    };
    assert!(
        matches!(
            &err,
            AgentError::Finalization(message) if message == "Empty prepare response"
        ),
        "got: {err}"
    );
    prepare.assert_calls(1);
    upload.assert_calls(0);
    commit.assert_calls(0);
    Ok(())
}

#[tokio::test]
async fn snapshot_rejects_shape_invalid_prepare_response_before_upload_or_commit()
-> Result<(), AgentError> {
    let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
    disable_system_log();
    let server = MockServer::start();

    let artifact_dir = tempfile::tempdir().unwrap();
    let root = artifact_dir.path();
    std::fs::write(root.join("alpha.txt"), "alpha").unwrap();
    let files = archive::collect_file_metadata(root.to_str().unwrap()).unwrap();
    let archive_url = format!("{}/test/unreachable-archive", server.base_url());
    let manifest_url = format!("{}/test/unreachable-manifest", server.base_url());

    let telemetry_dir = tempfile::tempdir().unwrap();
    let telemetry_path = telemetry_dir.path().join("sandbox-ops.jsonl");
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::with_override(&telemetry_path).await;

    let prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/prepare");
        then.status(200).json_body(serde_json::json!({
            "existing": false,
            "uploads": {
                "archive": {
                    "key": "archive-key",
                    "presignedUrl": archive_url,
                },
                "manifest": {
                    "key": "manifest-key",
                    "presignedUrl": manifest_url,
                },
            },
        }));
    });
    let archive_upload = server.mock(|when, then| {
        when.method(PUT).path("/test/unreachable-archive");
        then.status(200);
    });
    let manifest_upload = server.mock(|when, then| {
        when.method(PUT).path("/test/unreachable-manifest");
        then.status(200);
    });
    let commit = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/commit");
        then.status(200)
            .json_body(serde_json::json!({ "success": true }));
    });

    let http = test_http_client(&server)?;
    let result = create_snapshot(
        &http,
        CreateSnapshotRequest {
            mount_path: root.to_str().unwrap(),
            files,
            storage_id: SNAPSHOT_STORAGE_ID,
            run_id: "run-shape-invalid-prepare",
            message: "snapshot message",
            parent_version_id: "parent-v1",
        },
    )
    .await;

    let Err(err) = result else {
        panic!("create_snapshot unexpectedly succeeded");
    };
    let AgentError::Finalization(finalization_message) = &err else {
        panic!("expected finalization error, got: {err}");
    };
    assert!(
        finalization_message.contains("versionId"),
        "got: {finalization_message}"
    );
    prepare.assert_calls(1);
    archive_upload.assert_calls(0);
    manifest_upload.assert_calls(0);
    commit.assert_calls(0);

    let entries = std::fs::read_to_string(&telemetry_path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    let prepare_failure = entries
        .iter()
        .find(|entry| {
            entry.get("action_type").and_then(serde_json::Value::as_str)
                == Some("artifact_prepare_api")
                && entry.get("success").and_then(serde_json::Value::as_bool) == Some(false)
        })
        .expect("failed artifact_prepare_api telemetry entry");
    let telemetry_error = prepare_failure
        .get("error")
        .and_then(serde_json::Value::as_str)
        .expect("artifact_prepare_api telemetry error");
    assert_eq!(telemetry_error, finalization_message);
    assert!(telemetry_error.contains("versionId"));
    Ok(())
}

#[tokio::test]
async fn dedup_snapshot_posts_file_payloads_before_validation_failure_blocks_commit()
-> Result<(), AgentError> {
    let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
    disable_system_log();
    let server = &*SNAPSHOT_MOCK_SERVER;

    let telemetry_dir = tempfile::tempdir().unwrap();
    let telemetry_path = telemetry_dir.path().join("sandbox-ops.jsonl");
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::with_override(&telemetry_path).await;

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("alpha.txt"), "alpha").unwrap();
    std::fs::write(root.join("target.txt"), "content").unwrap();
    let mut files = archive::collect_file_metadata(root.to_str().unwrap()).unwrap();
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let expected_files = file_json_values(&files);
    let total_size: u64 = files.iter().map(|file| file.size).sum();

    let prepare = server.mock(|when, then| {
        when.method(httpmock::Method::POST)
            .path("/api/webhooks/agent/storages/prepare")
            .json_body(serde_json::json!({
                "runId": "run-id",
                "storageId": SNAPSHOT_STORAGE_ID,
                "files": expected_files,
                "parentVersionId": "parent-v1",
            }));
        then.status(200).json_body(serde_json::json!({
            "versionId": "v-existing",
            "existing": true
        }));
    });
    let commit = server.mock(|when, then| {
        when.method(httpmock::Method::POST)
            .path("/api/webhooks/agent/storages/commit")
            .json_body(serde_json::json!({
                "runId": "run-id",
                "storageId": SNAPSHOT_STORAGE_ID,
                "versionId": "v-existing",
                "parentVersionId": "parent-v1",
                "files": expected_files,
            }));
        then.status(200).json_body(serde_json::json!({
            "success": true,
            "versionId": "v-existing",
            "storageName": "storage",
            "size": total_size,
            "fileCount": expected_files.len(),
        }));
    });

    let http = test_http_client(server)?;
    let result = create_snapshot(
        &http,
        CreateSnapshotRequest {
            mount_path: root.to_str().unwrap(),
            files: files.clone(),
            storage_id: SNAPSHOT_STORAGE_ID,
            run_id: "run-id",
            message: "message",
            parent_version_id: "parent-v1",
        },
    )
    .await
    .unwrap();

    assert_eq!(result.version_id, "v-existing");
    prepare.assert_calls(1);
    commit.assert_calls(1);
    assert_eq!(
        sandbox_op_successes(&telemetry_path, "artifact_commit_api")?,
        vec![true]
    );
    prepare.delete_async().await;
    commit.delete_async().await;

    std::fs::write(root.join("target.txt"), "changed").unwrap();
    let prepare = server.mock(|when, then| {
        when.method(httpmock::Method::POST)
            .path("/api/webhooks/agent/storages/prepare")
            .json_body(serde_json::json!({
                "runId": "run-id",
                "storageId": SNAPSHOT_STORAGE_ID,
                "files": expected_files,
            }));
        then.status(200).json_body(serde_json::json!({
            "versionId": "v-existing",
            "existing": true
        }));
    });
    let commit = server.mock(|when, then| {
        when.method(httpmock::Method::POST)
            .path("/api/webhooks/agent/storages/commit");
        then.status(200)
            .json_body(serde_json::json!({ "success": true }));
    });

    let http = test_http_client(server)?;
    let result = create_snapshot(
        &http,
        CreateSnapshotRequest {
            mount_path: root.to_str().unwrap(),
            files,
            storage_id: SNAPSHOT_STORAGE_ID,
            run_id: "run-id",
            message: "message",
            parent_version_id: "",
        },
    )
    .await;

    let Err(err) = result else {
        panic!("create_snapshot unexpectedly succeeded");
    };
    assert!(
        err.to_string()
            .contains("Failed to validate archive inputs")
    );
    prepare.assert_calls(1);
    commit.assert_calls(0);
    assert_eq!(
        sandbox_op_successes(&telemetry_path, "artifact_commit_api")?,
        vec![true]
    );
    prepare.delete_async().await;
    commit.delete_async().await;
    Ok(())
}

#[tokio::test]
async fn snapshot_uploads_archive_manifest_and_commits_new_version() -> Result<(), AgentError> {
    let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
    disable_system_log();
    let server = MockServer::start();

    let telemetry_dir = tempfile::tempdir().unwrap();
    let telemetry_path = telemetry_dir.path().join("sandbox-ops.jsonl");
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::with_override(&telemetry_path).await;

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("alpha.txt"), "alpha").unwrap();
    let mut files = archive::collect_file_metadata(root.to_str().unwrap()).unwrap();
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let expected_files = file_json_values(&files);
    let archive_url = format!("{}/test/artifact-archive-upload", server.base_url());
    let manifest_url = format!("{}/test/artifact-manifest-upload", server.base_url());

    let prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/prepare")
            .json_body(serde_json::json!({
                "runId": "run-upload",
                "storageId": SNAPSHOT_STORAGE_ID,
                "files": expected_files,
                "parentVersionId": "parent-v1",
            }));
        then.status(200).json_body(serde_json::json!({
            "versionId": "v-uploaded",
            "existing": false,
            "uploads": {
                "archive": {
                    "key": "archive-key",
                    "presignedUrl": archive_url,
                },
                "manifest": {
                    "key": "manifest-key",
                    "presignedUrl": manifest_url,
                },
            },
        }));
    });
    let (archive_body_tx, archive_body_rx) = std::sync::mpsc::channel();
    let archive_upload = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/artifact-archive-upload")
            .header("Content-Type", "application/gzip");
        then.respond_with(move |req| {
            archive_body_tx.send(req.body_ref().to_vec()).unwrap();
            http_status(200)
        });
    });
    let manifest_files = expected_files.clone();
    let manifest_upload = server.mock(|when, then| {
        when.method(PUT).path("/test/artifact-manifest-upload");
        then.respond_with(move |req| manifest_upload_response(req, &manifest_files));
    });
    let commit = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/commit")
            .json_body(serde_json::json!({
                "runId": "run-upload",
                "storageId": SNAPSHOT_STORAGE_ID,
                "versionId": "v-uploaded",
                "parentVersionId": "parent-v1",
                "files": expected_files,
                "message": "snapshot message",
            }));
        then.status(200).json_body(serde_json::json!({
            "success": true,
            "versionId": "v-uploaded",
            "storageName": "storage-upload",
            "size": 5,
            "fileCount": 1,
        }));
    });

    let http = test_http_client(&server)?;
    let result = create_snapshot(
        &http,
        CreateSnapshotRequest {
            mount_path: root.to_str().unwrap(),
            files,
            storage_id: SNAPSHOT_STORAGE_ID,
            run_id: "run-upload",
            message: "snapshot message",
            parent_version_id: "parent-v1",
        },
    )
    .await?;

    assert_eq!(result.version_id, "v-uploaded");
    prepare.assert_calls(1);
    archive_upload.assert_calls(1);
    manifest_upload.assert_calls(1);
    commit.assert_calls(1);

    let archive_body = archive_body_rx
        .try_recv()
        .expect("captured archive PUT body");
    // Consume the whole gzip stream to validate its checksum and trailer.
    let mut tar_bytes = Vec::new();
    flate2::read::GzDecoder::new(archive_body.as_slice())
        .read_to_end(&mut tar_bytes)
        .expect("archive PUT body must be valid gzip");
    let mut archive = tar::Archive::new(tar_bytes.as_slice());
    let mut entries = archive
        .entries()
        .expect("archive PUT body must contain tar");
    let mut entry = entries.next().expect("alpha.txt entry").unwrap();
    let path = entry.path().unwrap().into_owned();
    assert_eq!(path, Path::new("alpha.txt"));
    assert!(entry.header().entry_type().is_file());
    let mut contents = Vec::new();
    entry.read_to_end(&mut contents).unwrap();
    assert_eq!(contents, b"alpha");
    assert_eq!(
        vec![serde_json::json!({
            "path": path,
            "hash": hex::encode(Sha256::digest(&contents)),
            "size": contents.len(),
        })],
        expected_files
    );
    assert!(entries.next().is_none(), "unexpected extra archive entry");

    assert_eq!(
        sandbox_op_successes(&telemetry_path, "artifact_commit_api")?,
        vec![true]
    );
    prepare.delete_async().await;
    archive_upload.delete_async().await;
    manifest_upload.delete_async().await;
    commit.delete_async().await;
    Ok(())
}

#[tokio::test]
async fn snapshot_archive_upload_failure_skips_manifest_and_commit() -> Result<(), AgentError> {
    let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
    disable_system_log();
    let server = MockServer::start();

    let artifact_dir = tempfile::tempdir().unwrap();
    let root = artifact_dir.path();
    std::fs::write(root.join("alpha.txt"), "alpha").unwrap();
    let mut files = archive::collect_file_metadata(root.to_str().unwrap()).unwrap();
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let expected_files = file_json_values(&files);
    let archive_url = format!("{}/test/failed-artifact-archive-upload", server.base_url());
    let manifest_url = format!(
        "{}/test/skipped-artifact-manifest-upload",
        server.base_url()
    );

    let telemetry_dir = tempfile::tempdir().unwrap();
    let telemetry_path = telemetry_dir.path().join("sandbox-ops.jsonl");
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::with_override(&telemetry_path).await;

    let prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/prepare")
            .json_body(serde_json::json!({
                "runId": "run-failed-archive-upload",
                "storageId": SNAPSHOT_STORAGE_ID,
                "files": expected_files,
                "parentVersionId": "parent-v1",
            }));
        then.status(200).json_body(serde_json::json!({
            "versionId": "v-failed-archive-upload",
            "existing": false,
            "uploads": {
                "archive": {
                    "key": "archive-key",
                    "presignedUrl": archive_url,
                },
                "manifest": {
                    "key": "manifest-key",
                    "presignedUrl": manifest_url,
                },
            },
        }));
    });
    let archive_upload = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/failed-artifact-archive-upload");
        then.status(500);
    });
    let manifest_upload = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/skipped-artifact-manifest-upload");
        then.status(200);
    });
    let commit = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/commit");
        then.status(200)
            .json_body(serde_json::json!({ "success": true }));
    });

    let http = test_http_client(&server)?;
    let result = create_snapshot(
        &http,
        CreateSnapshotRequest {
            mount_path: root.to_str().unwrap(),
            files,
            storage_id: SNAPSHOT_STORAGE_ID,
            run_id: "run-failed-archive-upload",
            message: "snapshot message",
            parent_version_id: "parent-v1",
        },
    )
    .await;

    let Err(AgentError::Finalization(message)) = result else {
        panic!("expected archive upload finalization error");
    };
    assert_eq!(
        message,
        "artifact archive upload failed: http: PUT presigned: HTTP 500 Internal Server Error"
    );
    prepare.assert_calls(1);
    archive_upload.assert_calls(1);
    manifest_upload.assert_calls(0);
    commit.assert_calls(0);
    assert_eq!(
        sandbox_op_successes(&telemetry_path, "artifact_s3_upload")?,
        vec![false]
    );
    prepare.delete_async().await;
    archive_upload.delete_async().await;
    manifest_upload.delete_async().await;
    commit.delete_async().await;
    Ok(())
}

#[tokio::test]
async fn snapshot_manifest_upload_failure_skips_commit() -> Result<(), AgentError> {
    let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
    disable_system_log();
    let server = MockServer::start();

    let artifact_dir = tempfile::tempdir().unwrap();
    let root = artifact_dir.path();
    std::fs::write(root.join("alpha.txt"), "alpha").unwrap();
    let mut files = archive::collect_file_metadata(root.to_str().unwrap()).unwrap();
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let expected_files = file_json_values(&files);
    let archive_url = format!(
        "{}/test/successful-artifact-archive-upload",
        server.base_url()
    );
    let manifest_url = format!("{}/test/failed-artifact-manifest-upload", server.base_url());

    let telemetry_dir = tempfile::tempdir().unwrap();
    let telemetry_path = telemetry_dir.path().join("sandbox-ops.jsonl");
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::with_override(&telemetry_path).await;

    let prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/prepare")
            .json_body(serde_json::json!({
                "runId": "run-failed-manifest-upload",
                "storageId": SNAPSHOT_STORAGE_ID,
                "files": expected_files,
                "parentVersionId": "parent-v1",
            }));
        then.status(200).json_body(serde_json::json!({
            "versionId": "v-failed-manifest-upload",
            "existing": false,
            "uploads": {
                "archive": {
                    "key": "archive-key",
                    "presignedUrl": archive_url,
                },
                "manifest": {
                    "key": "manifest-key",
                    "presignedUrl": manifest_url,
                },
            },
        }));
    });
    let archive_upload = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/successful-artifact-archive-upload");
        then.status(200);
    });
    let manifest_upload = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/failed-artifact-manifest-upload");
        then.status(403);
    });
    let commit = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/commit");
        then.status(200)
            .json_body(serde_json::json!({ "success": true }));
    });

    let http = test_http_client(&server)?;
    let result = create_snapshot(
        &http,
        CreateSnapshotRequest {
            mount_path: root.to_str().unwrap(),
            files,
            storage_id: SNAPSHOT_STORAGE_ID,
            run_id: "run-failed-manifest-upload",
            message: "snapshot message",
            parent_version_id: "parent-v1",
        },
    )
    .await;

    let Err(AgentError::Finalization(message)) = result else {
        panic!("expected manifest upload finalization error");
    };
    assert_eq!(
        message,
        "artifact manifest upload failed: http: PUT presigned: HTTP 403 Forbidden"
    );
    prepare.assert_calls(1);
    archive_upload.assert_calls(1);
    manifest_upload.assert_calls(1);
    commit.assert_calls(0);
    assert_eq!(
        sandbox_op_successes(&telemetry_path, "artifact_s3_upload")?,
        vec![false]
    );
    prepare.delete_async().await;
    archive_upload.delete_async().await;
    manifest_upload.delete_async().await;
    commit.delete_async().await;
    Ok(())
}

#[tokio::test]
async fn uploaded_snapshot_fails_when_commit_reports_failure() -> Result<(), AgentError> {
    let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
    disable_system_log();
    let server = MockServer::start();

    let telemetry_dir = tempfile::tempdir().unwrap();
    let telemetry_path = telemetry_dir.path().join("sandbox-ops.jsonl");
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::with_override(&telemetry_path).await;

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("alpha.txt"), "alpha").unwrap();
    let mut files = archive::collect_file_metadata(root.to_str().unwrap()).unwrap();
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let expected_files = file_json_values(&files);
    let total_size: u64 = files.iter().map(|file| file.size).sum();
    let archive_url = format!("{}/test/artifact-archive-upload", server.base_url());
    let manifest_url = format!("{}/test/artifact-manifest-upload", server.base_url());

    let prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/prepare")
            .json_body(serde_json::json!({
                "runId": "run-upload-failed-commit",
                "storageId": SNAPSHOT_STORAGE_ID,
                "files": expected_files,
                "parentVersionId": "parent-v1",
            }));
        then.status(200).json_body(serde_json::json!({
            "versionId": "v-uploaded-failed-commit",
            "existing": false,
            "uploads": {
                "archive": {
                    "key": "archive-key",
                    "presignedUrl": archive_url,
                },
                "manifest": {
                    "key": "manifest-key",
                    "presignedUrl": manifest_url,
                },
            },
        }));
    });
    let archive_upload = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/artifact-archive-upload")
            .header("Content-Type", "application/gzip");
        then.status(200);
    });
    let manifest_files = expected_files.clone();
    let manifest_upload = server.mock(|when, then| {
        when.method(PUT).path("/test/artifact-manifest-upload");
        then.respond_with(move |req| manifest_upload_response(req, &manifest_files));
    });
    let commit = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/commit")
            .json_body(serde_json::json!({
                "runId": "run-upload-failed-commit",
                "storageId": SNAPSHOT_STORAGE_ID,
                "versionId": "v-uploaded-failed-commit",
                "parentVersionId": "parent-v1",
                "files": expected_files,
                "message": "snapshot message",
            }));
        then.status(200).json_body(serde_json::json!({
            "success": false,
            "versionId": "v-uploaded-failed-commit",
            "storageName": "storage-upload",
            "size": total_size,
            "fileCount": expected_files.len(),
        }));
    });

    let http = test_http_client(&server)?;
    let result = create_snapshot(
        &http,
        CreateSnapshotRequest {
            mount_path: root.to_str().unwrap(),
            files,
            storage_id: SNAPSHOT_STORAGE_ID,
            run_id: "run-upload-failed-commit",
            message: "snapshot message",
            parent_version_id: "parent-v1",
        },
    )
    .await;

    let Err(err) = result else {
        panic!("create_snapshot unexpectedly succeeded");
    };
    assert!(err.to_string().contains("Commit failed"));
    prepare.assert_calls(1);
    archive_upload.assert_calls(1);
    manifest_upload.assert_calls(1);
    commit.assert_calls(1);
    assert_eq!(
        sandbox_op_successes(&telemetry_path, "artifact_commit_api")?,
        vec![false]
    );
    prepare.delete_async().await;
    archive_upload.delete_async().await;
    manifest_upload.delete_async().await;
    commit.delete_async().await;
    Ok(())
}

#[tokio::test]
async fn dedup_snapshot_fails_when_commit_response_is_malformed() -> Result<(), AgentError> {
    let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
    disable_system_log();
    let server = MockServer::start();

    let telemetry_dir = tempfile::tempdir().unwrap();
    let telemetry_path = telemetry_dir.path().join("sandbox-ops.jsonl");
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::with_override(&telemetry_path).await;

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("alpha.txt"), "alpha").unwrap();
    let mut files = archive::collect_file_metadata(root.to_str().unwrap()).unwrap();
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let expected_files = file_json_values(&files);

    let prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/prepare")
            .json_body(serde_json::json!({
                "runId": "run-dedup-malformed-commit",
                "storageId": SNAPSHOT_STORAGE_ID,
                "files": expected_files,
                "parentVersionId": "parent-v1",
            }));
        then.status(200).json_body(serde_json::json!({
            "versionId": "v-dedup-malformed-commit",
            "existing": true
        }));
    });
    let commit = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/commit")
            .json_body(serde_json::json!({
                "runId": "run-dedup-malformed-commit",
                "storageId": SNAPSHOT_STORAGE_ID,
                "versionId": "v-dedup-malformed-commit",
                "parentVersionId": "parent-v1",
                "files": expected_files,
            }));
        then.status(200)
            .json_body(serde_json::json!({ "success": true }));
    });

    let http = test_http_client(&server)?;
    let result = create_snapshot(
        &http,
        CreateSnapshotRequest {
            mount_path: root.to_str().unwrap(),
            files,
            storage_id: SNAPSHOT_STORAGE_ID,
            run_id: "run-dedup-malformed-commit",
            message: "snapshot message",
            parent_version_id: "parent-v1",
        },
    )
    .await;

    let Err(err) = result else {
        panic!("create_snapshot unexpectedly succeeded");
    };
    assert!(err.to_string().contains("Commit failed"));
    prepare.assert_calls(1);
    commit.assert_calls(1);
    assert_eq!(
        sandbox_op_successes(&telemetry_path, "artifact_commit_api")?,
        vec![false]
    );
    prepare.delete_async().await;
    commit.delete_async().await;
    Ok(())
}

#[tokio::test]
async fn dedup_snapshot_records_commit_http_failure() -> Result<(), AgentError> {
    let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
    disable_system_log();
    let server = MockServer::start();

    let telemetry_dir = tempfile::tempdir().unwrap();
    let telemetry_path = telemetry_dir.path().join("sandbox-ops.jsonl");
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::with_override(&telemetry_path).await;

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("alpha.txt"), "alpha").unwrap();
    let mut files = archive::collect_file_metadata(root.to_str().unwrap()).unwrap();
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let expected_files = file_json_values(&files);

    let prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/prepare")
            .json_body(serde_json::json!({
                "runId": "run-dedup-http-failed-commit",
                "storageId": SNAPSHOT_STORAGE_ID,
                "files": expected_files,
                "parentVersionId": "parent-v1",
            }));
        then.status(200).json_body(serde_json::json!({
            "versionId": "v-dedup-http-failed-commit",
            "existing": true
        }));
    });
    let commit = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/commit")
            .json_body(serde_json::json!({
                "runId": "run-dedup-http-failed-commit",
                "storageId": SNAPSHOT_STORAGE_ID,
                "versionId": "v-dedup-http-failed-commit",
                "parentVersionId": "parent-v1",
                "files": expected_files,
            }));
        then.status(400);
    });

    let http = test_http_client(&server)?;
    let result = create_snapshot(
        &http,
        CreateSnapshotRequest {
            mount_path: root.to_str().unwrap(),
            files,
            storage_id: SNAPSHOT_STORAGE_ID,
            run_id: "run-dedup-http-failed-commit",
            message: "snapshot message",
            parent_version_id: "parent-v1",
        },
    )
    .await;

    let Err(AgentError::HttpStatus { status, .. }) = result else {
        panic!("expected commit HTTP status error");
    };
    assert_eq!(status, 400);
    prepare.assert_calls(1);
    commit.assert_calls(1);
    assert_eq!(
        sandbox_op_successes(&telemetry_path, "artifact_commit_api")?,
        vec![false]
    );
    prepare.delete_async().await;
    commit.delete_async().await;
    Ok(())
}

#[tokio::test]
async fn snapshot_requires_upload_urls_for_new_version() -> Result<(), AgentError> {
    let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
    disable_system_log();
    let server = MockServer::start();

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("alpha.txt"), "alpha").unwrap();
    let mut files = archive::collect_file_metadata(root.to_str().unwrap()).unwrap();
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let expected_files = file_json_values(&files);

    let prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/prepare")
            .json_body(serde_json::json!({
                "runId": "run-missing-uploads",
                "storageId": SNAPSHOT_STORAGE_ID,
                "files": expected_files,
                "parentVersionId": "parent-v1",
            }));
        then.status(200).json_body(serde_json::json!({
            "versionId": "v-missing-uploads",
            "existing": false,
        }));
    });
    let commit = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/commit");
        then.status(200)
            .json_body(serde_json::json!({ "success": true }));
    });

    let http = test_http_client(&server)?;
    let result = create_snapshot(
        &http,
        CreateSnapshotRequest {
            mount_path: root.to_str().unwrap(),
            files,
            storage_id: SNAPSHOT_STORAGE_ID,
            run_id: "run-missing-uploads",
            message: "snapshot message",
            parent_version_id: "parent-v1",
        },
    )
    .await;

    let Err(err) = result else {
        panic!("create_snapshot unexpectedly succeeded");
    };
    assert!(
        err.to_string()
            .contains("No upload URLs in prepare response")
    );
    prepare.assert_calls(1);
    commit.assert_calls(0);
    prepare.delete_async().await;
    commit.delete_async().await;
    Ok(())
}
