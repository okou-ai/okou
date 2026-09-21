use guest_contracts::storage_manifest::{Manifest, StorageEntry};
use sandbox::{ExecResult, ExecTermination};
use sandbox_mock::MockSandbox;

use super::super::storage::{
    download_storages, guest_storage_apply_command, guest_storage_apply_env,
    guest_storage_manifest_cleanup_command,
};
use super::super::{DEFAULT_EXEC_TIMEOUT, guest_runtime_dir};
use super::support::{minimal_context, sandbox_exec_error, sandbox_write_file_error};
use crate::paths::guest;

fn empty_manifest() -> Manifest {
    Manifest {
        storages: Vec::new(),
        artifacts: Vec::new(),
        cleanup_paths: Vec::new(),
        instruction_cleanups: Vec::new(),
    }
}

fn storage_manifest() -> Manifest {
    Manifest {
        storages: vec![StorageEntry {
            mount_path: "/data".into(),
            extract_path: None,
            archive_url: Some("https://s3/archive.tar.gz".into()),
            instructions_target_filename: None,
            cached: false,
            vas_storage_name: Some("data".into()),
            vas_version_id: Some("v1".into()),
        }],
        ..empty_manifest()
    }
}

fn manifest_with_serialized_len(len: usize) -> Manifest {
    let mut manifest = Manifest {
        cleanup_paths: vec![String::new()],
        ..empty_manifest()
    };
    let empty_len = serde_json::to_vec(&manifest).unwrap().len();
    assert!(len >= empty_len);
    manifest.cleanup_paths[0] = "x".repeat(len - empty_len);
    assert_eq!(serde_json::to_vec(&manifest).unwrap().len(), len);
    manifest
}

#[tokio::test]
async fn download_storages_uses_fixed_manifest_operation() {
    let sandbox = MockSandbox::new("test");
    let context = minimal_context();
    let manifest = storage_manifest();
    let manifest_json = serde_json::to_vec(&manifest).unwrap();

    download_storages(&sandbox, &context, &manifest)
        .await
        .unwrap();

    assert!(sandbox.write_file_calls().is_empty());
    assert!(sandbox.exec_calls().is_empty());
    let calls = sandbox.storage_manifest_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].manifest_json, manifest_json);
    assert_eq!(calls[0].run_id, context.run_id.to_string());
    assert_eq!(
        calls[0].runtime_dir,
        guest_runtime_dir(context.run_id).unwrap()
    );
    assert_eq!(calls[0].timeout, DEFAULT_EXEC_TIMEOUT);
}

#[test]
fn guest_storage_apply_env_contains_run_identity_values() {
    let context = minimal_context();
    let run_id = context.run_id.to_string();
    let runtime_dir = guest_runtime_dir(context.run_id).unwrap();
    let env = guest_storage_apply_env(&run_id, &runtime_dir);

    assert_eq!(
        env,
        [
            (guest_contracts::env::RUN_ID_ENV, run_id.as_str()),
            (
                guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
                runtime_dir.as_str(),
            ),
        ]
    );
}

#[tokio::test]
async fn exact_manifest_limit_uses_dedicated_transport() {
    let sandbox = MockSandbox::new("test");
    let context = minimal_context();
    let manifest = manifest_with_serialized_len(guest_control_proto::MAX_EXEC_STDIN_BYTES);

    download_storages(&sandbox, &context, &manifest)
        .await
        .unwrap();

    assert!(sandbox.write_file_calls().is_empty());
    assert!(sandbox.exec_calls().is_empty());
    assert_eq!(sandbox.storage_manifest_calls().len(), 1);
}

#[tokio::test]
async fn oversized_manifest_uses_shared_fallback_path() {
    let sandbox = MockSandbox::new("test");
    let context = minimal_context();
    let manifest = manifest_with_serialized_len(guest_control_proto::MAX_EXEC_STDIN_BYTES + 1);
    let manifest_json = serde_json::to_vec(&manifest).unwrap();

    download_storages(&sandbox, &context, &manifest)
        .await
        .unwrap();

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        guest_contracts::runtime_paths::STORAGE_MANIFEST_PATH
    );
    assert_eq!(writes[0].content, manifest_json);
    let calls = sandbox.exec_calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].cmd, guest_storage_manifest_cleanup_command());
    assert_eq!(calls[1].cmd, guest_storage_apply_command());
    assert!(calls.iter().all(|call| call.stdin_bytes.is_none()));
}

#[tokio::test]
async fn stale_fallback_cleanup_failure_prevents_write() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult::new(
        1,
        Vec::new(),
        b"rm: cannot remove storage manifest".to_vec(),
    )));
    let context = minimal_context();
    let manifest = manifest_with_serialized_len(guest_control_proto::MAX_EXEC_STDIN_BYTES + 1);

    let error = download_storages(&sandbox, &context, &manifest)
        .await
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("storage manifest cleanup failed")
    );
    assert!(sandbox.write_file_calls().is_empty());
    assert_eq!(sandbox.exec_calls().len(), 1);
    assert!(sandbox.storage_manifest_calls().is_empty());
}

#[tokio::test]
async fn fallback_exec_error_triggers_cleanup() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult::new(0, Vec::new(), Vec::new())));
    sandbox.push_exec_result(Err(sandbox_exec_error("vsock exec failed")));
    let context = minimal_context();
    let manifest = manifest_with_serialized_len(guest_control_proto::MAX_EXEC_STDIN_BYTES + 1);

    let error = download_storages(&sandbox, &context, &manifest)
        .await
        .unwrap_err();

    assert!(error.to_string().contains("vsock exec failed"));
    let calls = sandbox.exec_calls();
    assert_eq!(calls.len(), 3);
    assert_eq!(calls[0].cmd, guest_storage_manifest_cleanup_command());
    assert_eq!(calls[1].cmd, guest_storage_apply_command());
    assert_eq!(calls[2].cmd, guest_storage_manifest_cleanup_command());
}

#[tokio::test]
async fn dedicated_operation_error_does_not_run_fallback_cleanup() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Err(sandbox_exec_error("vsock exec failed")));
    let context = minimal_context();
    let manifest = empty_manifest();

    let error = download_storages(&sandbox, &context, &manifest)
        .await
        .unwrap_err();

    assert!(error.to_string().contains("vsock exec failed"));
    assert!(sandbox.exec_calls().is_empty());
    assert_eq!(sandbox.storage_manifest_calls().len(), 1);
}

#[tokio::test]
async fn fallback_helper_failure_triggers_cleanup() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult::new(0, Vec::new(), Vec::new())));
    sandbox.push_exec_result(Ok(ExecResult::new(
        127,
        Vec::new(),
        b"guest-storage-apply: not found".to_vec(),
    )));
    let context = minimal_context();
    let manifest = manifest_with_serialized_len(guest_control_proto::MAX_EXEC_STDIN_BYTES + 1);

    let error = download_storages(&sandbox, &context, &manifest)
        .await
        .unwrap_err();

    assert!(error.to_string().contains("storage download failed"));
    assert_eq!(sandbox.exec_calls().len(), 3);
}

#[tokio::test]
async fn helper_failure_redacts_archive_url_query() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult::new(
        1,
        Vec::new(),
        b"archiveUrl=https://storage.example/archive.tar.gz?X-Amz-Signature=secret".to_vec(),
    )));
    let context = minimal_context();

    let error = download_storages(&sandbox, &context, &empty_manifest())
        .await
        .unwrap_err();
    let message = error.to_string();

    assert!(message.contains("storage download failed (exit code 1)"));
    assert!(message.contains("archive.tar.gz?<redacted>"));
    assert!(!message.contains("secret"));
}

#[tokio::test]
async fn non_exited_helper_result_is_failure() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult {
        termination: ExecTermination::TimedOut,
        guest_duration_ms: None,
        stdout: b"partial stdout".to_vec(),
        stderr: b"Timeout".to_vec(),
        diagnostic: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    }));
    let context = minimal_context();

    let error = download_storages(&sandbox, &context, &empty_manifest())
        .await
        .unwrap_err();
    let message = error.to_string();

    assert!(message.contains("storage download failed (timed out)"));
    assert!(message.contains("stderr (captured): Timeout"));
    assert!(message.contains("stdout (captured): partial stdout"));
}

#[tokio::test]
async fn fallback_write_error_triggers_cleanup() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_write_file_result(Err(sandbox_write_file_error("vsock write failed")));
    let context = minimal_context();
    let manifest = manifest_with_serialized_len(guest_control_proto::MAX_EXEC_STDIN_BYTES + 1);

    let error = download_storages(&sandbox, &context, &manifest)
        .await
        .unwrap_err();

    assert!(error.to_string().contains("vsock write failed"));
    let calls = sandbox.exec_calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].cmd, guest_storage_manifest_cleanup_command());
    assert_eq!(calls[1].cmd, guest_storage_manifest_cleanup_command());
}

#[tokio::test]
async fn fallback_cleanup_failure_preserves_write_error() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult::new(0, Vec::new(), Vec::new())));
    sandbox.push_exec_result(Ok(ExecResult::new(
        1,
        Vec::new(),
        b"rm: cannot remove manifest".to_vec(),
    )));
    sandbox.push_write_file_result(Err(sandbox_write_file_error("vsock write failed")));
    let context = minimal_context();
    let manifest = manifest_with_serialized_len(guest_control_proto::MAX_EXEC_STDIN_BYTES + 1);

    let error = download_storages(&sandbox, &context, &manifest)
        .await
        .unwrap_err();

    assert!(error.to_string().contains("vsock write failed"));
    assert_eq!(sandbox.exec_calls().len(), 2);
    assert_eq!(
        guest::STORAGE_MANIFEST,
        guest_contracts::runtime_paths::STORAGE_MANIFEST_PATH
    );
}
