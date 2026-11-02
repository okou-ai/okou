use super::*;
use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;
use httpmock::prelude::*;
use serde_json::json;
#[cfg(target_os = "linux")]
use std::ffi::CString;
#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStrExt;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const REQUEST_OVERLAP_TIMEOUT: Duration = Duration::from_secs(5);

fn assert_artifact_hash_failure(telemetry_path: &std::path::Path, expected_error: &str) {
    let expected_error = expected_error
        .strip_prefix("finalization: ")
        .unwrap_or(expected_error);
    let telemetry_entries = std::fs::read_to_string(telemetry_path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    let matching_failure = telemetry_entries.iter().any(|entry| {
        entry.get("action_type").and_then(serde_json::Value::as_str)
            == Some("artifact_hash_compute")
            && entry.get("success").and_then(serde_json::Value::as_bool) == Some(false)
            && entry.get("error").and_then(serde_json::Value::as_str) == Some(expected_error)
    });
    assert!(
        matching_failure,
        "missing failed artifact_hash_compute telemetry for {expected_error:?}"
    );
}

#[cfg(target_os = "linux")]
fn make_fifo(path: &std::path::Path) -> std::io::Result<()> {
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    // SAFETY: `path` is a NUL-terminated filesystem path owned for the call.
    let result = unsafe { libc::mkfifo(path.as_ptr(), 0o600) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
async fn artifact_snapshot_preflight_error(mount: &std::path::Path) -> String {
    let telemetry_dir = tempfile::tempdir().unwrap();
    let telemetry_path = telemetry_dir.path().join("sandbox-ops.jsonl");
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::with_override(&telemetry_path).await;
    let server = MockServer::start();
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
    let upload = server.mock(|when, then| {
        when.method(PUT);
        then.status(200);
    });
    let http = HttpClient::with_api_config(
        server.base_url(),
        "test-token",
        "",
        "test-run-001",
        Duration::ZERO,
    )
    .unwrap();
    let entries = vec![env::ArtifactEnv {
        name: "workspace".to_string(),
        mount_path: mount.to_string_lossy().into_owned(),
        storage_id: "storage-id".to_string(),
        version_id: "parent-version".to_string(),
        missing_root_policy: None,
    }];

    let error = snapshot_artifact_entries_for_test(&http, "test-run", &entries)
        .await
        .unwrap_err();
    let message = error.to_string();
    prepare.assert_calls(0);
    upload.assert_calls(0);
    commit.assert_calls(0);
    assert_artifact_hash_failure(&telemetry_path, &message);
    message
}

async fn start_artifact_finalization_test_server(
    artifact_count: usize,
) -> (String, tokio::task::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        let mut prepare_requests = Vec::with_capacity(artifact_count);
        for _ in 0..artifact_count {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (path, payload) = read_test_json_request(&mut socket).await;
            assert_eq!(path, "/api/webhooks/agent/storages/prepare");
            let storage_id = payload["storageId"].as_str().unwrap().to_string();
            prepare_requests.push((socket, storage_id));
        }
        let prepare_storage_ids = prepare_requests
            .iter()
            .map(|(_, storage_id)| storage_id.clone())
            .collect();
        for (mut socket, storage_id) in prepare_requests {
            let logical_name = storage_id
                .strip_suffix("-storage-id")
                .unwrap_or(&storage_id);
            write_test_json_response(
                &mut socket,
                &json!({
                    "versionId": format!("snapshot-{logical_name}"),
                    "existing": true,
                }),
            )
            .await;
        }
        for _ in 0..artifact_count {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (path, _) = read_test_json_request(&mut socket).await;
            assert_eq!(path, "/api/webhooks/agent/storages/commit");
            write_test_json_response(
                &mut socket,
                &json!({
                    "success": true,
                    "versionId": "ignored",
                    "storageName": "ignored",
                    "size": 0,
                    "fileCount": 0,
                }),
            )
            .await;
        }
        prepare_storage_ids
    });
    (format!("http://{address}"), handle)
}

async fn read_test_json_request(socket: &mut TcpStream) -> (String, serde_json::Value) {
    let mut request = Vec::new();
    let header_end = loop {
        if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break index;
        }
        let mut chunk = [0_u8; 1024];
        let read = socket.read(&mut chunk).await.unwrap();
        assert!(read > 0, "connection closed before request headers");
        request.extend_from_slice(&chunk[..read]);
    };
    let headers = std::str::from_utf8(&request[..header_end]).unwrap();
    let path = headers
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .to_string();
    let content_length = headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value.trim().parse::<usize>().unwrap())
        .unwrap_or_default();
    let body_start = header_end + 4;
    while request.len() < body_start + content_length {
        let mut chunk = [0_u8; 1024];
        let read = socket.read(&mut chunk).await.unwrap();
        assert!(read > 0, "connection closed before request body");
        request.extend_from_slice(&chunk[..read]);
    }
    let payload =
        serde_json::from_slice(&request[body_start..body_start + content_length]).unwrap();
    (path, payload)
}

async fn write_test_json_response(socket: &mut TcpStream, body: &serde_json::Value) {
    let body = serde_json::to_vec(body).unwrap();
    let headers = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    socket.write_all(headers.as_bytes()).await.unwrap();
    socket.write_all(&body).await.unwrap();
    socket.shutdown().await.unwrap();
}

#[test]
fn artifact_snapshot_entry_shape_matches_receiver_schema() {
    let entry = build_artifact_snapshot_entry("workspace", "v-abc-123", "/workspace", None);
    let value = serde_json::to_value(entry).unwrap();
    assert_eq!(
        value,
        json!({
            "name": "workspace",
            "version": "v-abc-123",
            "mountPath": "/workspace",
        })
    );
}

#[tokio::test]
async fn artifact_snapshot_missing_mount_fails_before_storage_api_calls() {
    let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
    let server = MockServer::start();
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
    let upload = server.mock(|when, then| {
        when.method(PUT);
        then.status(200);
    });
    let http = HttpClient::with_api_config(
        server.base_url(),
        "test-token",
        "",
        "test-run-001",
        Duration::ZERO,
    )
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let missing_mount = dir.path().join("missing");
    let entries = vec![env::ArtifactEnv {
        name: "workspace".to_string(),
        mount_path: missing_mount.to_string_lossy().into_owned(),
        storage_id: "storage-id".to_string(),
        version_id: "parent-version".to_string(),
        missing_root_policy: None,
    }];

    let err = snapshot_artifact_entries_for_test(&http, "test-run", &entries)
        .await
        .unwrap_err();

    assert!(
        err.to_string().contains("Failed to walk artifact files"),
        "got: {err}"
    );
    prepare.assert_calls(0);
    upload.assert_calls(0);
    commit.assert_calls(0);
}

#[tokio::test]
async fn artifact_snapshot_enforces_manifest_boundaries_before_storage_api_calls() {
    use api_contracts::generated::constants::storages::{
        STORAGE_MANIFEST_MAX_FILES, STORAGE_MANIFEST_MAX_PATH_BYTES,
    };

    let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
    let mut sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
    guest_telemetry::log::clear_system_log_file();

    let dir = tempfile::tempdir().unwrap();
    let first_prefix = "a".repeat(200);
    let second_prefix = "b".repeat(200);
    let mount = dir
        .path()
        .join(first_prefix)
        .join(second_prefix)
        .join("files");
    std::fs::create_dir_all(&mount).unwrap();
    let max_files = usize::try_from(STORAGE_MANIFEST_MAX_FILES).unwrap();
    for index in 0..max_files {
        std::fs::File::create(mount.join(format!("{index:05}"))).unwrap();
    }

    let exact_files = vas::walk_files_for_snapshot(mount.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(exact_files.len(), max_files);
    drop(exact_files);

    let over_limit_path = mount.join("over-limit");
    std::fs::File::create(&over_limit_path).unwrap();

    let telemetry_dir = tempfile::tempdir().unwrap();
    let telemetry_path = telemetry_dir.path().join("sandbox-ops.jsonl");
    sandbox_ops_guard.install_override(&telemetry_path);
    let server = MockServer::start();
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
    let upload = server.mock(|when, then| {
        when.method(PUT);
        then.status(200);
    });
    let http = HttpClient::with_api_config(
        server.base_url(),
        "test-token",
        "",
        "test-run-001",
        Duration::ZERO,
    )
    .unwrap();
    let entries = vec![env::ArtifactEnv {
        name: "workspace".to_string(),
        mount_path: mount.to_string_lossy().into_owned(),
        storage_id: "storage-id".to_string(),
        version_id: "parent-version".to_string(),
        missing_root_policy: None,
    }];

    let count_error = snapshot_artifact_entries_for_test(&http, "test-run", &entries)
        .await
        .unwrap_err();
    let count_message = count_error.to_string();
    assert!(
        count_message.contains(&format!(
            "candidate files {}/{STORAGE_MANIFEST_MAX_FILES}",
            STORAGE_MANIFEST_MAX_FILES + 1
        )),
        "got: {count_message}"
    );
    assert!(
        count_message.contains("candidate UTF-8 path bytes"),
        "got: {count_message}"
    );
    assert!(
        count_message.contains(&format!("/{STORAGE_MANIFEST_MAX_PATH_BYTES}")),
        "got: {count_message}"
    );
    prepare.assert_calls(0);
    upload.assert_calls(0);
    commit.assert_calls(0);

    assert_artifact_hash_failure(&telemetry_path, &count_message);

    std::fs::remove_file(over_limit_path).unwrap();
    let path_error = vas::walk_files_for_snapshot(dir.path().to_str().unwrap())
        .await
        .unwrap_err()
        .into_agent_error();
    let path_message = path_error.to_string();
    assert!(
        path_message.contains("candidate UTF-8 path bytes"),
        "got: {path_message}"
    );
    assert!(
        path_message.contains(&format!("/{STORAGE_MANIFEST_MAX_PATH_BYTES}")),
        "got: {path_message}"
    );
    assert!(
        !path_message.contains(&format!(
            "candidate files {}/{STORAGE_MANIFEST_MAX_FILES}",
            STORAGE_MANIFEST_MAX_FILES + 1
        )),
        "path-byte limit must fail before the file-count limit: {path_message}"
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn artifact_snapshot_enforces_traversal_entry_limit_before_storage_api_calls() {
    const PARENT_COUNT: usize = 2;

    let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
    guest_telemetry::log::clear_system_log_file();

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("wide");
    std::fs::create_dir(&mount).unwrap();
    std::fs::create_dir(mount.join(".git")).unwrap();
    let max_entries = usize::try_from(vas::ARTIFACT_TRAVERSAL_MAX_ENTRIES).unwrap();
    let links_per_parent = (max_entries - PARENT_COUNT) / PARENT_COUNT - 1;
    assert_eq!(
        PARENT_COUNT * (links_per_parent + 2),
        max_entries,
        "fixture must contain exactly the traversal limit before .git"
    );
    for parent_index in 0..PARENT_COUNT {
        let parent = mount.join(format!("p{parent_index:03}"));
        std::fs::create_dir(&parent).unwrap();
        let source = parent.join("source");
        make_fifo(&source).unwrap();
        for link_index in 0..links_per_parent {
            std::fs::hard_link(&source, parent.join(format!("l{link_index:05}"))).unwrap();
        }
    }

    let message = artifact_snapshot_preflight_error(&mount).await;
    assert!(
        message.contains(&format!(
            "observed entries {}/{}",
            vas::ARTIFACT_TRAVERSAL_MAX_ENTRIES + 1,
            vas::ARTIFACT_TRAVERSAL_MAX_ENTRIES
        )),
        "got: {message}"
    );
    assert!(
        message.contains(&format!("/{}", vas::ARTIFACT_TRAVERSAL_MAX_DEPTH)),
        "got: {message}"
    );
    assert!(
        message.contains(&format!("/{}", vas::ARTIFACT_TRAVERSAL_MAX_PATH_BYTES)),
        "got: {message}"
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn artifact_snapshot_enforces_traversal_depth_before_storage_api_calls() {
    use std::os::unix::ffi::OsStringExt;

    let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
    guest_telemetry::log::clear_system_log_file();

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("deep");
    std::fs::create_dir(&mount).unwrap();
    let mut deepest = mount.clone();
    for _ in 0..=vas::ARTIFACT_TRAVERSAL_MAX_DEPTH {
        deepest.push("d");
        std::fs::create_dir(&deepest).unwrap();
    }
    std::fs::File::create(deepest.join(std::ffi::OsString::from_vec(vec![0xff]))).unwrap();

    let message = artifact_snapshot_preflight_error(&mount).await;
    assert!(
        message.contains(&format!(
            "directory depth {}/{}",
            vas::ARTIFACT_TRAVERSAL_MAX_DEPTH + 1,
            vas::ARTIFACT_TRAVERSAL_MAX_DEPTH
        )),
        "got: {message}"
    );
    assert!(
        message.contains(&format!(
            "active UTF-8 path bytes {}/{}",
            2 * vas::ARTIFACT_TRAVERSAL_MAX_DEPTH + 1,
            vas::ARTIFACT_TRAVERSAL_MAX_PATH_BYTES
        )),
        "got: {message}"
    );
}

#[tokio::test]
async fn artifact_snapshot_explicit_fail_policy_missing_mount_fails() {
    let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
    let server = MockServer::start();
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
    let dir = tempfile::tempdir().unwrap();
    let missing_mount = dir.path().join("missing");
    let entries = vec![env::ArtifactEnv {
        name: "workspace".to_string(),
        mount_path: missing_mount.to_string_lossy().into_owned(),
        storage_id: "storage-id".to_string(),
        version_id: "parent-version".to_string(),
        missing_root_policy: Some(ArtifactEntryMissingRootPolicy::Fail),
    }];

    let err = snapshot_artifact_entries_for_test(&http, "test-run", &entries)
        .await
        .unwrap_err();

    assert!(
        err.to_string().contains("Failed to walk artifact files"),
        "got: {err}"
    );
    prepare.assert_calls(0);
    commit.assert_calls(0);
}

#[tokio::test]
async fn artifact_snapshot_later_missing_mount_fails_before_any_storage_api_calls() {
    let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
    let server = MockServer::start();
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
    let dir = tempfile::tempdir().unwrap();
    let valid_mount = dir.path().join("valid");
    std::fs::create_dir(&valid_mount).unwrap();
    std::fs::write(valid_mount.join("changed.txt"), "changed").unwrap();
    let missing_mount = dir.path().join("missing");
    let entries = vec![
        env::ArtifactEnv {
            name: "workspace".to_string(),
            mount_path: valid_mount.to_string_lossy().into_owned(),
            storage_id: "workspace-storage-id".to_string(),
            version_id: "old-workspace-version".to_string(),
            missing_root_policy: None,
        },
        env::ArtifactEnv {
            name: "memory".to_string(),
            mount_path: missing_mount.to_string_lossy().into_owned(),
            storage_id: "memory-storage-id".to_string(),
            version_id: "old-memory-version".to_string(),
            missing_root_policy: None,
        },
    ];

    let err = snapshot_artifact_entries_for_test(&http, "test-run", &entries)
        .await
        .unwrap_err();

    assert!(
        err.to_string().contains("Failed to walk artifact files"),
        "got: {err}"
    );
    prepare.assert_calls(0);
    commit.assert_calls(0);
}

#[tokio::test]
async fn artifact_snapshot_pipelines_overlap_and_preserve_result_order() {
    let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
    let dir = tempfile::tempdir().unwrap();
    let workspace_mount = dir.path().join("workspace");
    let memory_mount = dir.path().join("memory");
    std::fs::create_dir(&workspace_mount).unwrap();
    std::fs::create_dir(&memory_mount).unwrap();
    std::fs::write(workspace_mount.join("workspace.txt"), "workspace").unwrap();
    std::fs::write(memory_mount.join("memory.txt"), "memory").unwrap();
    let entries = vec![
        env::ArtifactEnv {
            name: "workspace".to_string(),
            mount_path: workspace_mount.to_string_lossy().into_owned(),
            storage_id: "workspace-storage-id".to_string(),
            version_id: "old-workspace-version".to_string(),
            missing_root_policy: None,
        },
        env::ArtifactEnv {
            name: "memory".to_string(),
            mount_path: memory_mount.to_string_lossy().into_owned(),
            storage_id: "memory-storage-id".to_string(),
            version_id: "old-memory-version".to_string(),
            missing_root_policy: None,
        },
    ];
    let (base_url, server) = start_artifact_finalization_test_server(entries.len()).await;
    let http =
        HttpClient::with_api_config(base_url, "test-token", "", "test-run-001", Duration::ZERO)
            .unwrap();

    let snapshots = tokio::time::timeout(
        REQUEST_OVERLAP_TIMEOUT,
        snapshot_artifact_entries_for_test(&http, "test-run", &entries),
    )
    .await
    .expect("both artifact pipelines must reach prepare concurrently")
    .unwrap()
    .unwrap();
    let mut prepare_storage_ids = server.await.unwrap();
    prepare_storage_ids.sort_unstable();
    assert_eq!(
        prepare_storage_ids,
        ["memory-storage-id", "workspace-storage-id"]
    );
    assert_eq!(
        serde_json::to_value(snapshots).unwrap(),
        json!([
            {
                "name": "workspace",
                "version": "snapshot-workspace",
                "mountPath": workspace_mount.to_string_lossy(),
            },
            {
                "name": "memory",
                "version": "snapshot-memory",
                "mountPath": memory_mount.to_string_lossy(),
            },
        ])
    );
}

#[tokio::test]
async fn artifact_snapshot_preserve_policy_missing_mount_preserves_parent_version() {
    let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
    let server = MockServer::start();
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
    let dir = tempfile::tempdir().unwrap();
    let missing_mount = dir.path().join("memory");
    let entries = vec![env::ArtifactEnv {
        name: "memory".to_string(),
        mount_path: missing_mount.to_string_lossy().into_owned(),
        storage_id: "memory-storage-id".to_string(),
        version_id: "old-memory-version".to_string(),
        missing_root_policy: Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion),
    }];

    let snapshots = snapshot_artifact_entries_for_test(&http, "test-run", &entries)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(
        serde_json::to_value(snapshots).unwrap(),
        json!([
            {
                "name": "memory",
                "version": "old-memory-version",
                "mountPath": missing_mount.to_string_lossy(),
                "missingRootPolicy": "preserveParentVersion",
            }
        ])
    );
    prepare.assert_calls(0);
    commit.assert_calls(0);
}

#[tokio::test]
async fn artifact_snapshot_policy_still_fails_on_non_not_found_root_error() {
    let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
    let server = MockServer::start();
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
    let dir = tempfile::tempdir().unwrap();
    let file_mount = dir.path().join("memory");
    std::fs::write(&file_mount, "not a directory").unwrap();
    let entries = vec![env::ArtifactEnv {
        name: "memory".to_string(),
        mount_path: file_mount.to_string_lossy().into_owned(),
        storage_id: "memory-storage-id".to_string(),
        version_id: "old-memory-version".to_string(),
        missing_root_policy: Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion),
    }];

    let err = snapshot_artifact_entries_for_test(&http, "test-run", &entries)
        .await
        .unwrap_err();

    assert!(
        err.to_string().contains("Failed to walk artifact files"),
        "got: {err}"
    );
    prepare.assert_calls(0);
    commit.assert_calls(0);
}
