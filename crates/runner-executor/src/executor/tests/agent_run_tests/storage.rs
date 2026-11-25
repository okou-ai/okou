use std::collections::HashMap;
use std::sync::Arc;

use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;
use guest_contracts::{storage_files, storage_manifest::Manifest};
use sandbox::{
    ExecResult, ExecTermination, SandboxError, SandboxOperation, SandboxOperationReason,
};
use sandbox_mock::MockLifecycleGate;
use sha2::{Digest, Sha256};

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
use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, http_response};
use runner_types::storage_manifest::StorageManifest;
use runner_types::types::SandboxReuseResult;

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

fn memory_archive(memory_id: &str, note: &[u8]) -> (Vec<u8>, String, [u8; 32]) {
    use guest_contracts::{memory_tree, storage_content_hash::compute_content_hash};

    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::none());
    let mut tar = tar::Builder::new(encoder);
    let mut tree = std::collections::BTreeMap::new();
    for (name, content) in [
        ("unchanged.bin", vec![0; 1024 * 1024]),
        ("note.md", note.to_vec()),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(content.len() as u64);
        header.set_mode(0o644);
        header.set_mtime(1234);
        tar.append_data(&mut header, name, content.as_slice())
            .unwrap();
        tree.insert(
            name.to_owned(),
            memory_tree::FileState {
                sha256: Sha256::digest(&content).into(),
                mode: 0o644,
                mtime: 1234,
            },
        );
    }
    let hashes: Vec<_> = tree
        .iter()
        .map(|(path, file)| (path.as_str(), hex::encode(file.sha256)))
        .collect();
    let version = compute_content_hash(
        memory_id,
        hashes.iter().map(|(path, hash)| (*path, hash.as_str())),
    );
    (
        tar.into_inner().unwrap().finish().unwrap(),
        version,
        memory_tree::digest(&tree),
    )
}

#[tokio::test]
async fn failed_memory_delta_uses_authoritative_full_restore_before_spawning() {
    run_memory_delta_failure(ExecResult::new(1, Vec::new(), Vec::new()), None).await;
}

#[tokio::test]
async fn memory_delta_with_uncertain_guest_stop_does_not_restore_or_spawn() {
    let failed = ExecResult {
        termination: ExecTermination::WaitFailed,
        diagnostic: "Failed to clean storage helper process containment".into(),
        ..ExecResult::new(1, Vec::new(), Vec::new())
    };
    run_memory_delta_failure(failed, Some("Memory delta failed (wait failed)")).await;
}

async fn run_memory_delta_failure(delta_result: ExecResult, expected_startup_error: Option<&str>) {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let owner = "member-memory";
    let mount = "/home/user/.codex/memories";
    let (parent, parent_version_id, digest) = memory_archive(owner, b"prior note");
    let (target, target_version, _) = memory_archive(owner, b"current note");
    for (version, bytes) in [(&parent_version_id, &parent), (&target_version, &target)] {
        let cache = config.home.storage_cache_dir("memory", version);
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("archive.tar.gz"), bytes).unwrap();
    }
    let (report_tx, mut reports) = tokio::sync::mpsc::unbounded_channel();
    let reporter = runner_storage::SandboxOpReporter::new(move |_| {
        let _ = report_tx.send(());
        std::future::ready(())
    });
    let url = "http://127.0.0.1:9/must-use-local-archive.tar.gz";
    config.background_fill.warm_committed_memory(
        config.home.clone(),
        &target_version,
        url,
        target.len() as u64,
        Some(runner_storage::memory_delta::MemoryDeltaBase {
            memory_id: owner.into(),
            parent_version_id: parent_version_id.clone(),
        }),
        reporter,
    );
    tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, reports.recv())
        .await
        .unwrap()
        .unwrap();
    let mut context = minimal_context();
    let mut target = api_artifact("memory", mount, owner, &target_version, url);
    target.missing_root_policy = Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion);
    context.storage_manifest = Some(StorageManifest {
        artifacts: vec![target],
        storages: vec![],
    });
    let previous = StorageFingerprints {
        artifacts: HashMap::from([(
            mount.into(),
            StorageFingerprint::new("memory", parent_version_id),
        )]),
        storages: HashMap::new(),
    };
    let proof = crate::home_image_cache::HomeMemoryProof {
        mount_path: mount.into(),
        storage_id: owner.into(),
        digest,
    };
    let mut telemetry = test_telemetry(&config, &context);
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut controls = RunControls::new(cancel.clone(), None);
    controls.prepared_storage = crate::executor::sandbox_run::prepare_storage(
        &context,
        Some(&previous),
        Some(&proof),
        &config,
        &cancel,
        &mut telemetry,
    )
    .await
    .unwrap();
    assert!(
        controls
            .prepared_storage
            .as_ref()
            .unwrap()
            .memory_delta
            .is_some()
    );
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_storage_manifest_result(Ok(delta_result));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let result = run_in_sandbox(
        sandbox.as_ref(),
        &context,
        &config,
        RunStart {
            sandbox_startup_path: runner_types::types::SandboxStartupPath::Home,
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            home_reuse_result: runner_types::types::HomeReuseResult::Reused,
            prev_storage: Some(&previous),
        },
        &mut telemetry,
        controls,
    )
    .await;

    let calls = overrides.storage_manifest_calls();
    let (manifest, _) = storage_files::split_input(&calls[0].manifest_json).unwrap();
    let delta: Manifest = serde_json::from_slice(manifest).unwrap();
    assert_eq!(
        delta.artifacts[0].archive_url.as_deref(),
        Some(storage_files::MEMORY_DELTA_URL)
    );
    if let Some(expected_error) = expected_startup_error {
        let error = result.err().expect("uncertain delta must fail startup");
        assert!(error.to_string().contains(expected_error), "{error}");
        assert_eq!(calls.len(), 1);
        assert!(overrides.start_agent_process_calls().is_empty());
    } else {
        result.unwrap();
        assert!(calls[1..].iter().any(|call| {
            let manifest = storage_files::split_input(&call.manifest_json)
                .map_or(call.manifest_json.as_slice(), |(json, _)| json);
            let full: Manifest = serde_json::from_slice(manifest).unwrap();
            full.cleanup_paths == [mount]
                && full
                    .artifacts
                    .iter()
                    .any(|artifact| artifact.vas_version_id.as_deref() == Some(&target_version))
        }));
        assert_eq!(overrides.start_agent_process_calls().len(), 1);
    }
    config.background_fill.shutdown().await;
}

#[tokio::test]
async fn run_in_sandbox_applies_decoded_artifact_before_agent_spawn() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let name = "artifact";
    let version = "v1";
    let archive_dir = config.home.storage_cache_dir(name, version);
    std::fs::create_dir_all(&archive_dir).unwrap();
    std::fs::write(archive_dir.join("archive.tar.gz"), extracted_archive()).unwrap();
    drop(runner_host::lock::open_lock_file(&config.home.storage_lock(name, version)).unwrap());
    config
        .decoded_cache
        .warm_from_archive(name, version)
        .await
        .unwrap();
    std::fs::remove_file(archive_dir.join("archive.tar.gz")).unwrap();

    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let start_process_gate = MockLifecycleGate::new();
    overrides.set_start_process_lifecycle_gate(start_process_gate.clone());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let mut ctx = minimal_context();
    let mount = "/home/user/workspace";
    let mut artifact = api_artifact(
        name,
        mount,
        "artifact-storage-id",
        version,
        "http://127.0.0.1:9/archive-must-not-open.tar.gz",
    );
    artifact.missing_root_policy = Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion);
    ctx.storage_manifest = Some(StorageManifest {
        storages: Vec::new(),
        artifacts: vec![artifact],
    });
    let fingerprints = StorageFingerprints::from_manifest(ctx.storage_manifest.as_ref().unwrap());
    assert!(
        fingerprints
            .artifacts
            .get(mount)
            .unwrap()
            .matches(name, version)
    );
    let mut telemetry = test_telemetry(&config, &ctx);

    {
        let run = run_in_sandbox(
            sandbox.as_ref(),
            &ctx,
            &config,
            RunStart {
                sandbox_startup_path: runner_types::types::SandboxStartupPath::Cold,
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(tokio_util::sync::CancellationToken::new(), None),
        );
        tokio::pin!(run);
        tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, async {
            tokio::select! {
                result = &mut run => {
                    let _ = result;
                    panic!("run finished before the agent start-process barrier");
                },
                entered = start_process_gate.wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT) => {
                    entered.expect("run should reach the agent start-process barrier");
                }
            }
        })
        .await
        .expect("run should reach the agent start-process barrier");

        let calls = overrides.storage_manifest_calls();
        assert_eq!(calls.len(), 1);
        let (json, payload) = storage_files::split_input(&calls[0].manifest_json).unwrap();
        let manifest: Manifest = serde_json::from_slice(json).unwrap();
        assert!(manifest.storages.is_empty());
        assert_eq!(manifest.artifacts.len(), 1);
        let applied = &manifest.artifacts[0];
        assert_eq!(applied.mount_path, mount);
        assert_eq!(applied.vas_storage_name.as_deref(), Some(name));
        assert_eq!(
            applied.vas_storage_id.as_deref(),
            Some("artifact-storage-id")
        );
        assert_eq!(applied.vas_version_id.as_deref(), Some(version));
        assert_eq!(
            applied.missing_root_policy.as_deref(),
            Some("preserveParentVersion")
        );
        let files = storage_files::decode(payload).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].mount_path, mount);
        assert_eq!(files[0].files[0].content, b"content");
        assert_eq!(files[0].files[0].mode, 0o755);
        assert_eq!(files[0].files[0].mtime, 1234);

        start_process_gate.release_one();
        tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, &mut run)
            .await
            .expect("decoded artifact run should complete after agent spawn")
            .unwrap();
    }

    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    assert_successful_action_once(
        &telemetry.pending_ops_snapshot(),
        "storage_cache_artifact_decoded",
    );
    config.background_fill.shutdown().await;
    config.decoded_cache.shutdown().await;
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
    let storage = api_storage("instructions", "/home/user/.codex", "v1", &archive_url);
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
                sandbox_startup_path: runner_types::types::SandboxStartupPath::Cold,
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
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
            sandbox_startup_path: runner_types::types::SandboxStartupPath::Cold,
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
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
            sandbox_startup_path: runner_types::types::SandboxStartupPath::Cold,
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
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
            sandbox_startup_path: runner_types::types::SandboxStartupPath::Sandbox,
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            home_reuse_result: runner_types::types::HomeReuseResult::SandboxReused,
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
    for guest_result in [
        Err(sandbox_exec_error("vsock exec failed")),
        Ok(ExecResult::new(
            1,
            Vec::new(),
            b"Required storage preparation failed".to_vec(),
        )),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.push_storage_manifest_result(guest_result);
        let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
        let mut ctx = minimal_context();
        let archive_server = spawn_storage_archive_server(&extracted_archive()).await;
        let archive_url = format!("{}/archive.tar.gz", archive_server.url());
        let storage = api_storage("ordinary", "/data", "v1", &archive_url);
        ctx.storage_manifest = Some(StorageManifest {
            storages: vec![storage],
            artifacts: vec![],
        });
        let prev_storage = StorageFingerprints {
            storages: HashMap::from([("/data".into(), StorageFingerprint::new("ordinary", "v0"))]),
            artifacts: HashMap::new(),
        };
        let mut telemetry = test_telemetry(&config, &ctx);

        let result = run_in_sandbox(
            sandbox.as_ref(),
            &ctx,
            &config,
            RunStart {
                sandbox_startup_path: runner_types::types::SandboxStartupPath::Sandbox,
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::Reused,
                home_reuse_result: runner_types::types::HomeReuseResult::SandboxReused,
                prev_storage: Some(&prev_storage),
            },
            &mut telemetry,
            RunControls::new(tokio_util::sync::CancellationToken::new(), None),
        )
        .await;

        archive_server.cancel_and_reap().await;

        assert!(
            result.is_err(),
            "guest-storage-apply failure should still fail the storage manifest phase"
        );
        assert!(overrides.start_agent_process_calls().is_empty());
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
            sandbox_startup_path: runner_types::types::SandboxStartupPath::Cold,
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
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
