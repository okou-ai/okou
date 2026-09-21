use std::collections::HashMap;
use std::sync::Arc;

use sandbox::{SandboxError, SandboxOperation, SandboxOperationReason};
use sandbox_mock::MockLifecycleGate;

use super::support::{
    assert_failed_action_error_once, assert_no_action, assert_successful_action_once,
};
use crate::executor::agent_run::{RunControls, RunStart, run_in_sandbox};
use crate::executor::telemetry::RunnerSpawnTiming;
use crate::executor::tests::support::{
    RUN_IN_SANDBOX_TEST_TIMEOUT, api_artifact, api_storage, create_overridden_sandbox,
    minimal_context, sandbox_exec_error, test_executor_config, test_telemetry,
};
use crate::storage_fingerprints::{StorageFingerprint, StorageFingerprints};
use crate::storage_manifest::StorageManifest;
use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, http_response};
use crate::types::SandboxReuseResult;

async fn spawn_storage_archive_server(body: &[u8]) -> RawHttpTestServer {
    let probe_response = format!(
        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{}\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx",
        body.len()
    )
    .into_bytes();
    let full_response = http_response("200 OK", body);

    RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(probe_response),
        RawHttpAction::Respond(full_response),
    ])
    .await
}

fn extracted_archive() -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::none());
    let mut builder = tar::Builder::new(encoder);
    let mut header = tar::Header::new_ustar();
    header.set_size(7);
    header.set_mode(0o755);
    header.set_mtime(1234);
    header.set_cksum();
    builder
        .append_data(&mut header, "file", &b"content"[..])
        .unwrap();
    builder.into_inner().unwrap().finish().unwrap()
}

#[tokio::test]
async fn run_in_sandbox_runs_guest_storage_apply_for_cached_instruction_normalization() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let mut ctx = minimal_context();
    let mut storage = api_storage(
        "instructions",
        "/home/user/.codex",
        "v1",
        "https://example.com/instructions.tar.gz",
    );
    storage.instructions_target_filename = Some("AGENTS.md".into());
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![storage],
        artifacts: vec![],
    });
    let prev_storage = StorageFingerprints {
        storages: HashMap::from([(
            "/home/user/.codex".into(),
            StorageFingerprint::new("instructions", "v1"),
        )]),
        artifacts: HashMap::new(),
    };
    let mut telemetry = test_telemetry(&config, &ctx);

    run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            workspace_reuse_result: crate::types::WorkspaceReuseResult::SandboxReused,
            prev_storage: Some(&prev_storage),
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await
    .unwrap();

    assert_eq!(sandbox.storage_manifest_calls().len(), 1);
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action_once(&ops, "runner_storage_manifest_fingerprint_reuse");
    assert_successful_action_once(&ops, "runner_storage_manifest_has_work");
    assert_successful_action_once(&ops, "runner_storage_manifest_cache_populate");
    assert_successful_action_once(&ops, "runner_storage_manifest_guest_storage_apply");
    assert_successful_action_once(&ops, "runner_storage_manifest_apply");
    assert!(
        ops.iter()
            .all(|(action, _, _)| action != "storage_download"),
        "runner telemetry should not use the guest-storage-apply per-entry metric name: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_starts_deferred_cache_fill_after_agent_spawn() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let start_process_gate = MockLifecycleGate::new();
    overrides.set_start_process_lifecycle_gate(start_process_gate.clone());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let mut ctx = minimal_context();
    let mut archive_server = spawn_storage_archive_server(&extracted_archive()).await;
    let archive_url = format!("{}/archive.tar.gz", archive_server.url());
    let mut storage = api_storage("instructions", "/home/user/.codex", "v1", &archive_url);
    storage.baseline_candidate = true;
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![storage],
        artifacts: vec![],
    });
    let mut telemetry = test_telemetry(&config, &ctx);

    {
        let run = run_in_sandbox(
            sandbox.as_ref(),
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(tokio_util::sync::CancellationToken::new(), None)
                .with_spawn_timing(RunnerSpawnTiming::start(None)),
        );
        tokio::pin!(run);

        tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, async {
            tokio::select! {
                result = &mut run => {
                    let _ = result;
                    panic!("run finished before the start-process barrier");
                },
                entered = start_process_gate.wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT) => {
                    entered.expect("run should reach the start-process barrier");
                }
            }
        })
        .await
        .expect("run should reach the start-process barrier");

        assert!(matches!(
            archive_server.try_next_request(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
        assert_eq!(overrides.storage_manifest_calls().len(), 1);
        assert!(
            config
                .decoded_cache
                .get_ready("instructions", "v1")
                .await
                .unwrap()
                .is_none()
        );

        start_process_gate.release_one();
        tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, &mut run)
            .await
            .expect("deferred storage run should complete after process spawn")
            .unwrap();
    }

    archive_server
        .next_request("deferred cache fill archive request after spawn")
        .await;
    archive_server.assert_finished().await;
    // Waiting for the ready entry observes completion, not an arbitrary delay.
    let files = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, async {
        loop {
            if let Some(files) = config
                .decoded_cache
                .get_ready("instructions", "v1")
                .await
                .unwrap()
            {
                break files;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("post-spawn owner must publish extracted files");
    assert_eq!(files.files[0].content, b"content");
    assert_eq!(files.files[0].mode, 0o755);
    tokio::time::timeout(
        RUN_IN_SANDBOX_TEST_TIMEOUT,
        config.background_fill.wait_idle_for_test(),
    )
    .await
    .unwrap();
    config.background_fill.shutdown().await;
    config.decoded_cache.shutdown().await;
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action_once(&ops, "runner_storage_manifest_has_work");
    assert_successful_action_once(&ops, "runner_storage_manifest_cache_populate");
    assert_successful_action_once(&ops, "runner_storage_manifest_guest_storage_apply");
    assert_successful_action_once(&ops, "runner_storage_manifest_apply");
    assert_successful_action_once(&ops, "storage_cache_miss_passthrough");
    assert_successful_action_once(&ops, "storage_cache_background_fill_deferred_count_1");
    assert_successful_action_once(&ops, "storage_cache_background_fill_deferred_delay");
    assert_successful_action_once(&ops, "storage_cache_background_fill_scheduled_count_1");
    assert_successful_action_once(&ops, "runner_agent_start_process");
    assert_successful_action_once(&ops, "runner_executor_start_to_spawn");
    assert_no_action(&ops, "storage_cache_miss");
    assert_no_action(&ops, "storage_cache_download");

    let spawn_index = ops
        .iter()
        .position(|op| op.0 == "runner_executor_start_to_spawn")
        .unwrap();
    let deferred_start_index = ops
        .iter()
        .position(|op| op.0 == "storage_cache_background_fill_deferred_delay")
        .unwrap();
    let scheduled_index = ops
        .iter()
        .position(|op| op.0 == "storage_cache_background_fill_scheduled_count_1")
        .unwrap();
    assert!(spawn_index < deferred_start_index);
    assert!(deferred_start_index < scheduled_index);
}

#[tokio::test]
async fn run_in_sandbox_drops_deferred_cache_fill_when_agent_spawn_fails() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_error(SandboxError::Operation {
        operation: SandboxOperation::StartProcess,
        reason: SandboxOperationReason::Guest,
        message: "agent spawn failed".into(),
    });
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let mut ctx = minimal_context();
    let mut archive_server = spawn_storage_archive_server(b"cache-archive").await;
    let archive_url = format!("{}/archive.tar.gz", archive_server.url());
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![api_storage(
            "instructions",
            "/home/user/.codex",
            "v1",
            &archive_url,
        )],
        artifacts: vec![],
    });
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        sandbox.as_ref(),
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_spawn_timing(RunnerSpawnTiming::start(None)),
    )
    .await;
    assert!(result.is_err());
    tokio::task::yield_now().await;

    assert!(matches!(
        archive_server.try_next_request(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action_once(&ops, "storage_cache_background_fill_deferred_count_1");
    assert!(
        ops.iter()
            .any(|op| op.0 == "runner_agent_start_process" && !op.1),
        "expected failed process spawn telemetry, got: {ops:?}"
    );
    assert_no_action(&ops, "storage_cache_background_fill_deferred_delay");
    assert_no_action(&ops, "storage_cache_background_fill_scheduled_count_1");
    assert_no_action(&ops, "runner_executor_start_to_spawn");

    archive_server.cancel_and_reap().await;
}

#[tokio::test]
async fn run_in_sandbox_drops_deferred_cache_fill_when_guest_storage_apply_fails() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    sandbox.push_exec_result(Err(sandbox_exec_error("vsock exec failed")));
    let mut ctx = minimal_context();
    let mut archive_server = spawn_storage_archive_server(b"cache-archive").await;
    let archive_url = format!("{}/archive.tar.gz", archive_server.url());
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![api_storage(
            "instructions",
            "/home/user/.codex",
            "v1",
            &archive_url,
        )],
        artifacts: vec![],
    });
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await;
    assert!(result.is_err());
    tokio::task::yield_now().await;

    assert!(matches!(
        archive_server.try_next_request(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action_once(&ops, "storage_cache_background_fill_deferred_count_1");
    assert_no_action(&ops, "storage_cache_background_fill_deferred_delay");
    assert_no_action(&ops, "storage_cache_background_fill_scheduled_count_1");
    assert_no_action(&ops, "runner_agent_start_process");
    assert_failed_action_error_once(
        &ops,
        "runner_storage_manifest_guest_storage_apply",
        "storage-download-failed",
    );

    archive_server.cancel_and_reap().await;
}

#[tokio::test]
async fn run_in_sandbox_records_storage_manifest_no_work_timing_without_guest_storage_apply() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![api_storage(
            "instructions",
            "/home/user/.codex",
            "v1",
            "https://example.com/instructions.tar.gz",
        )],
        artifacts: vec![],
    });
    let prev_storage = StorageFingerprints {
        storages: HashMap::from([(
            "/home/user/.codex".into(),
            StorageFingerprint::new("instructions", "v1"),
        )]),
        artifacts: HashMap::new(),
    };
    let mut telemetry = test_telemetry(&config, &ctx);

    run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            workspace_reuse_result: crate::types::WorkspaceReuseResult::SandboxReused,
            prev_storage: Some(&prev_storage),
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await
    .unwrap();

    assert!(sandbox.storage_manifest_calls().is_empty());
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action_once(&ops, "runner_storage_manifest_fingerprint_reuse");
    assert_successful_action_once(&ops, "runner_storage_manifest_has_work");
    assert_successful_action_once(&ops, "runner_storage_manifest_apply");
    assert_no_action(&ops, "runner_storage_manifest_cache_populate");
    assert_no_action(&ops, "runner_storage_manifest_guest_storage_apply");
}

#[tokio::test]
async fn run_in_sandbox_records_storage_manifest_guest_storage_apply_failure_timing() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    sandbox.push_exec_result(Err(sandbox_exec_error("vsock exec failed")));
    let mut ctx = minimal_context();
    let mut storage = api_storage(
        "instructions",
        "/home/user/.codex",
        "v1",
        "https://example.com/instructions.tar.gz",
    );
    storage.instructions_target_filename = Some("AGENTS.md".into());
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![storage],
        artifacts: vec![],
    });
    let prev_storage = StorageFingerprints {
        storages: HashMap::from([(
            "/home/user/.codex".into(),
            StorageFingerprint::new("instructions", "v1"),
        )]),
        artifacts: HashMap::new(),
    };
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            workspace_reuse_result: crate::types::WorkspaceReuseResult::SandboxReused,
            prev_storage: Some(&prev_storage),
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await;

    assert!(
        result.is_err(),
        "guest-storage-apply failure should still fail the storage manifest phase"
    );
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action_once(&ops, "runner_storage_manifest_fingerprint_reuse");
    assert_successful_action_once(&ops, "runner_storage_manifest_has_work");
    assert_successful_action_once(&ops, "runner_storage_manifest_cache_populate");
    assert_failed_action_error_once(
        &ops,
        "runner_storage_manifest_guest_storage_apply",
        "storage-download-failed",
    );
    let apply_failures = ops
        .iter()
        .filter(|op| op.0 == "runner_storage_manifest_apply" && !op.1)
        .count();
    assert_eq!(
        apply_failures, 1,
        "top-level storage manifest apply failure should still be recorded once, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_rejects_non_empty_artifact_without_archive_url() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let mut ctx = minimal_context();
    let mut artifact = api_artifact(
        "memory",
        "/home/user/.claude/projects/project",
        "storage-id-1",
        "version-2",
        "https://storage.example/artifact.tar.gz",
    );
    artifact.archive_url = None;
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![],
        artifacts: vec![artifact],
    });
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await;

    let error = match result {
        Ok(_) => panic!("invalid storage manifest should fail"),
        Err(error) => error,
    };
    assert!(
        error
            .to_string()
            .contains("storage manifest artifact memory version version-2 is missing archiveUrl"),
        "got: {error}"
    );
    assert!(sandbox.storage_manifest_calls().is_empty());
    let ops = telemetry.pending_ops_snapshot();
    assert_failed_action_error_once(
        &ops,
        "runner_storage_manifest_apply",
        "internal error: storage manifest artifact memory version version-2 is missing archiveUrl",
    );
    assert_no_action(&ops, "runner_storage_manifest_has_work");
    assert_no_action(&ops, "runner_storage_manifest_guest_storage_apply");
}
