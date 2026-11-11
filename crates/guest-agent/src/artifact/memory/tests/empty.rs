use super::*;

#[tokio::test]
async fn memory_delete_publishes_empty_content_and_supported_download_failures_propagate() {
    let _log_guard = crate::lock_system_log_test_state_async().await;
    let _ops_guard = crate::SandboxOpsTestGuard::lock().await;
    guest_telemetry::log::clear_system_log_file();
    for unavailable in [false, true] {
        let server = MockServer::start();
        let mount = tempfile::tempdir().unwrap();
        let empty = version(&[]);
        let base_files = entries(&[("delete.md", "original")]);
        let head_files = entries(&[("delete.md", "concurrent edit")]);
        let base = version(&base_files);
        let head = version(&head_files);
        let origin = server.base_url();
        server.mock(|when, then| {
            when.method(GET).path("/base-manifest");
            then.json_body(json!({"files": base_files}));
        });
        server.mock(|when, then| {
            when.method(GET).path("/head-manifest");
            if unavailable {
                then.status(403);
            } else {
                then.json_body(json!({"files": head_files}));
            }
        });
        server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/storages/prepare");
            then.json_body(json!({"versionId": empty, "existing": true, "memoryMerge": {
                "base": {"versionId": base, "empty": false, "manifestUrl": format!("{origin}/base-manifest")},
                "head": {"versionId": head, "empty": false, "manifestUrl": format!("{origin}/head-manifest")}
            }}));
        });
        let original_mount = mount.path().to_owned();
        server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/commit")
                .json_body_includes(json!({"parentVersionId": base}).to_string());
            then.respond_with(move |_| {
                // The validated deletion-only candidate needs no local bytes.
                fs::remove_dir(&original_mount).unwrap();
                HttpMockResponse::builder()
                    .status(409)
                    .body(
                        json!({"error": {"code": "CONFLICT", "message": "HEAD moved"}}).to_string(),
                    )
                    .build()
            });
        });
        let published = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/storages/commit")
                .json_body_includes(json!({"parentVersionId": head, "versionId": empty, "files": []}).to_string());
            then.json_body(json!({"success": true, "versionId": empty, "storageName": "memory", "size": 0, "fileCount": 0}));
        });
        let http =
            HttpClient::with_api_config(origin, "token", "", "delete-run", Duration::ZERO).unwrap();
        let result = create_memory_snapshot(
            &http,
            CreateSnapshotRequest {
                mount_path: mount.path().to_str().unwrap(),
                files: Vec::new(),
                storage_id: STORAGE,
                run_id: "delete-run",
                message: "Delete Memory file",
                parent_version_id: &base,
            },
        )
        .await;
        if unavailable {
            let error = result
                .err()
                .expect("a supported merge cannot silently retain a failed download");
            assert!(matches!(error, AgentError::Http(message) if message.contains("403")));
        } else {
            let snapshot = result.unwrap();
            assert!(matches!(
                snapshot.publication,
                SnapshotPublication::Published
            ));
            assert_eq!(snapshot.version_id, empty);
            published.assert_calls(1);
        }
    }
}
