use super::support::*;
use crate::support::*;
use cli_test_support::tar_fixture::{TarEntry, create_tar_gz_entries};
use httpmock::prelude::*;
use serde_json::json;
use sha2::{Digest, Sha256};

const STORAGE: &str = "00000000-0000-4000-8000-000000000001";

fn file(path: &str, content: &str) -> serde_json::Value {
    json!({"path": path, "hash": hex::encode(Sha256::digest(content.as_bytes())), "size": content.len()})
}

fn version(files: &[serde_json::Value]) -> std::io::Result<String> {
    let mut lines: Vec<_> = files
        .iter()
        .map(|file| {
            let path = file
                .get("path")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| std::io::Error::other("test file path is missing"))?;
            let hash = file
                .get("hash")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| std::io::Error::other("test file hash is missing"))?;
            Ok(format!("{path}:{hash}"))
        })
        .collect::<std::io::Result<_>>()?;
    lines.sort();
    Ok(hex::encode(Sha256::digest(format!(
        "storage:{STORAGE}\n{}",
        lines.join("\n")
    ))))
}

#[tokio::test]
async fn memory_conflict_completion_acknowledges_the_merged_archive_version() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let mut runtime = finalization_runtime().unwrap();
    runtime.config.framework = guest_agent::env::Framework::Pi;
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(mount.path().join("ours.md"), "our change").unwrap();
    let own_file = file("ours.md", "our change");
    let head_file = file("theirs.md", "their change");
    let base = version(&[]).unwrap();
    let ours = version(std::slice::from_ref(&own_file)).unwrap();
    let head = version(std::slice::from_ref(&head_file)).unwrap();
    let merged = version(&[own_file.clone(), head_file.clone()]).unwrap();
    runtime
        .config
        .artifacts
        .push(guest_agent::env::ArtifactEnv {
            name: "memory".to_string(),
            mount_path: mount.path().to_str().unwrap().to_string(),
            storage_id: STORAGE.to_string(),
            version_id: base.clone(),
            missing_root_policy: None,
        });
    server.mock(|when, then| {
        when.method(GET).path("/merge-head-manifest");
        then.json_body(json!({"files": [head_file]}));
    });
    server.mock(|when, then| {
        when.method(GET).path("/merge-head-archive");
        then.body(create_tar_gz_entries(&[TarEntry::File("theirs.md", b"their change")]).unwrap());
    });
    let origin = server.base_url();
    let prepare_base = base.clone();
    let prepare_head = head.clone();
    let prepare_ours = ours.clone();
    let prepare_merged = merged.clone();
    server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/storages/prepare");
        then.respond_with(move |request| {
            let body: serde_json::Value = serde_json::from_slice(request.body_ref()).unwrap();
            let files = body["files"].as_array().unwrap();
            let response = if body["includeMemoryMerge"] == true {
                json!({"versionId": prepare_ours, "existing": true, "memoryMerge": {
                    "base": {"versionId": prepare_base, "empty": true},
                    "head": {"versionId": prepare_head, "empty": false,
                        "manifestUrl": format!("{origin}/merge-head-manifest"),
                        "archiveUrl": format!("{origin}/merge-head-archive")}
                }})
            } else {
                json!({"versionId": if files.len() == 1 { &prepare_ours } else { &prepare_merged }, "existing": true})
            };
            HttpMockResponse::builder().status(200).body(response.to_string()).build()
        });
    });
    let conflict = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/commit")
            .json_body_includes(json!({"parentVersionId": base, "versionId": ours}).to_string());
        then.status(409)
            .json_body(json!({"error": {"code": "CONFLICT", "message": "HEAD moved"}}));
    });
    let commit = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/storages/commit")
            .json_body_includes(
                json!({"parentVersionId": head, "versionId": merged,
                "files": [own_file, head_file]})
                .to_string(),
            );
        then.status(200)
            .json_body(json!({"success": true, "versionId": merged,
            "storageName": "memory", "size": 22, "fileCount": 2}));
    });
    let complete = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(
                json!({"exitCode": 0, "completion": {"storageOutputs": [{
                    "name": "memory", "mountPath": mount.path().to_str().unwrap(), "version": merged
                }]}})
                .to_string(),
            );
        then.status(200)
            .json_body(json!({"success": true, "status": "completed"}));
    });
    let metadata = guest_agent::session_metadata::CapturedSessionMetadata::for_test(
        "memory-merge-session",
        None,
    );
    let result = guest_agent::finalization::prepare_finalization_for_runtime(&runtime, &metadata)
        .await
        .unwrap();
    report_prepared_finalization(&runtime, 0, result)
        .await
        .unwrap();
    conflict.assert_calls_async(1).await;
    commit.assert_calls_async(1).await;
    complete.assert_calls_async(1).await;
}
