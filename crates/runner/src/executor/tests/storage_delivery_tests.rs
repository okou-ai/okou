use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::sync::Arc;

use guest_contracts::storage_files;
use guest_contracts::storage_manifest::{Manifest, StorageEntry};
use sandbox::ExecResult;
use sandbox_mock::{MockLifecycleGate, MockSandbox, MockSandboxOverrides};

use super::super::storage::download_storages_with_files;
use super::super::{ExecutorConfig, guest_runtime_dir};
use super::support::{
    RUN_IN_SANDBOX_TEST_TIMEOUT, api_storage, create_overridden_sandbox, minimal_context,
    spawn_run_in_sandbox_test, test_executor_config, test_telemetry,
};
use crate::paths::guest;
use crate::storage_cache::decoded::CachedFiles;
use crate::storage_cache::{populate_cache_with_fresh_delivery, prepare_fresh_archive_delivery};
use crate::storage_manifest::StorageManifest;
use crate::storage_plan::build_storage_plan;

struct DeliveryFixture {
    root: tempfile::TempDir,
    config: ExecutorConfig,
    manifest: StorageManifest,
}

fn archive_bytes() -> Vec<u8> {
    archive_with_content(b"content")
}

fn archive_with_content(content: &[u8]) -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::none());
    let mut archive = tar::Builder::new(encoder);
    let mut header = tar::Header::new_ustar();
    header.set_size(content.len() as u64);
    header.set_mode(0o755);
    header.set_mtime(1234);
    header.set_cksum();
    archive.append_data(&mut header, "file", content).unwrap();
    archive.into_inner().unwrap().finish().unwrap()
}

impl DeliveryFixture {
    async fn new(count: usize, ready: usize, url_bytes: usize) -> Self {
        Self::with_archive(count, ready, url_bytes, archive_bytes()).await
    }

    async fn with_archive(count: usize, ready: usize, url_bytes: usize, archive: Vec<u8>) -> Self {
        let root = tempfile::tempdir().unwrap();
        let config = test_executor_config(root.path()).await;
        let mut storages = Vec::new();
        for index in 0..count {
            let name = format!("storage-{index:03}-{}", "n".repeat(40));
            let version = "v".repeat(64);
            let mount = root.path().join("guest").join(format!("mount-{index:03}"));
            let prefix = format!("http://127.0.0.1:9/archive-{index:03}?signature=");
            let url = format!("{prefix}{}", "x".repeat(url_bytes - prefix.len()));
            let archive_dir = config.home.storage_cache_dir(&name, &version);
            std::fs::create_dir_all(&archive_dir).unwrap();
            std::fs::write(archive_dir.join("archive.tar.gz"), &archive).unwrap();
            drop(crate::lock::open_lock_file(&config.home.storage_lock(&name, &version)).unwrap());
            if index < ready {
                config
                    .decoded_cache
                    .warm_from_archive(&name, &version)
                    .await
                    .unwrap();
                assert!(
                    config
                        .decoded_cache
                        .get_ready(&name, &version)
                        .await
                        .unwrap()
                        .is_some()
                );
                // A selected ready hit must work after use-driven archive retirement.
                std::fs::remove_file(archive_dir.join("archive.tar.gz")).unwrap();
            }
            storages.push(api_storage(&name, mount.to_str().unwrap(), &version, &url));
        }
        Self {
            root,
            config,
            manifest: StorageManifest {
                storages,
                artifacts: Vec::new(),
            },
        }
    }

    async fn prepare(&self, sandbox: &MockSandbox) -> (Manifest, Vec<(String, Arc<CachedFiles>)>) {
        let context = minimal_context();
        let runtime = guest_runtime_dir(context.run_id).unwrap();
        let mut plan = build_storage_plan(&self.manifest, &runtime, None).unwrap();
        let mut telemetry = test_telemetry(&self.config, &context);
        let cancel = tokio_util::sync::CancellationToken::new();
        let mut fresh = prepare_fresh_archive_delivery(
            &mut plan,
            &self.config.home,
            &self.config.fresh_archive_delivery,
            &cancel,
            &mut telemetry,
            Some(&self.config.decoded_cache),
        )
        .await
        .unwrap();
        let deferred = populate_cache_with_fresh_delivery(
            &mut plan,
            sandbox,
            &self.config.home,
            &mut telemetry,
            Some(&mut fresh),
            Some(&self.config.decoded_cache),
        )
        .await
        .unwrap();
        drop(deferred);
        let files = plan.take_decoded();
        (plan.into_guest_manifest(), files)
    }

    async fn shutdown(&self) {
        self.config.background_fill.shutdown().await;
        self.config.decoded_cache.shutdown().await;
    }
}

fn assert_binary_calls(sandbox: &MockSandbox, expected: usize) {
    let mut delivered = 0;
    for call in sandbox.storage_manifest_calls() {
        if !call.manifest_json.starts_with(storage_files::INPUT_MAGIC) {
            continue;
        }
        assert!(call.manifest_json.len() <= storage_files::MAX_INPUT_BYTES);
        let (json, payload) = storage_files::split_input(&call.manifest_json).unwrap();
        assert!(json.len() <= storage_files::MAX_MANIFEST_BYTES);
        let manifest: Manifest = serde_json::from_slice(json).unwrap();
        let groups = storage_files::decode(payload).unwrap();
        storage_files::validate_bindings(
            &manifest,
            groups.iter().map(|group| group.mount_path.as_str()),
        )
        .unwrap();
        delivered += groups.len();
    }
    assert_eq!(delivered, expected);
}

#[tokio::test]
async fn high_fanout_storage_plans_deliver_ready_files_without_refilling_archives() {
    for (count, ready) in [(7, 5), (64, 31), (122, 46), (143, 52)] {
        let fixture = DeliveryFixture::new(count, ready, 604).await;
        let sandbox = MockSandbox::new("decoded-fanout");
        let (manifest, files) = fixture.prepare(&sandbox).await;
        assert_eq!(files.len(), ready);
        assert_eq!(
            manifest
                .storages
                .iter()
                .filter(|entry| entry.archive_url.as_deref().unwrap().starts_with("file://"))
                .count(),
            count - ready
        );
        for entry in fixture.manifest.storages.iter().take(ready) {
            assert!(
                !fixture
                    .config
                    .home
                    .storage_cache_dir(&entry.name, &entry.vas_version_id)
                    .join("archive.tar.gz")
                    .exists()
            );
        }
        download_storages_with_files(&sandbox, &minimal_context(), manifest, &files)
            .await
            .unwrap();
        assert_binary_calls(&sandbox, ready);
        if count == 7 {
            assert_eq!(sandbox.storage_manifest_calls().len(), 1);
        }
        fixture.shutdown().await;
    }
}

#[tokio::test]
async fn decoded_selection_keeps_the_aggregate_mount_budget_across_batches() {
    let mut fixture = DeliveryFixture::new(2, 2, 604).await;
    let first = fixture.manifest.storages[0].clone();
    let last = fixture.manifest.storages[1].clone();
    fixture.manifest.storages = (0..storage_files::MAX_MOUNTS)
        .map(|index| {
            let mut entry = first.clone();
            entry.mount_path = fixture
                .root
                .path()
                .join(format!("mount-{index:04}"))
                .to_str()
                .unwrap()
                .into();
            entry
        })
        .chain(std::iter::once(last.clone()))
        .collect();
    // The remaining mount must use its real archive when the logical plan has
    // exhausted the aggregate budget, even though it could fit another batch.
    let dir = fixture
        .config
        .home
        .storage_cache_dir(&last.name, &last.vas_version_id);
    std::fs::write(dir.join("archive.tar.gz"), archive_bytes()).unwrap();
    let sandbox = MockSandbox::new("decoded-mount-budget");
    let (manifest, files) = fixture.prepare(&sandbox).await;
    assert_eq!(files.len(), storage_files::MAX_MOUNTS);
    assert!(
        manifest
            .storages
            .last()
            .unwrap()
            .archive_url
            .as_ref()
            .unwrap()
            .starts_with("file://")
    );
    download_storages_with_files(&sandbox, &minimal_context(), manifest, &files)
        .await
        .unwrap();
    assert_binary_calls(&sandbox, storage_files::MAX_MOUNTS);
    fixture.shutdown().await;
}

#[tokio::test]
async fn decoded_selection_keeps_payload_framing_inside_the_aggregate_budget() {
    let archive = archive_with_content(&vec![b'a'; storage_files::MAX_FILE_BYTES]);
    let mut fixture = DeliveryFixture::with_archive(2, 2, 604, archive.clone()).await;
    let first = fixture.manifest.storages[0].clone();
    let last = fixture.manifest.storages[1].clone();
    let selected = storage_files::MAX_PAYLOAD_BYTES / storage_files::MAX_FILE_BYTES - 1;
    fixture.manifest.storages = (0..selected)
        .map(|index| {
            let mut entry = first.clone();
            entry.mount_path = fixture
                .root
                .path()
                .join(format!("payload-{index:04}"))
                .to_str()
                .unwrap()
                .into();
            entry
        })
        .chain(std::iter::once(last.clone()))
        .collect();
    let dir = fixture
        .config
        .home
        .storage_cache_dir(&last.name, &last.vas_version_id);
    std::fs::write(dir.join("archive.tar.gz"), archive).unwrap();
    let sandbox = MockSandbox::new("decoded-payload-budget");
    let (manifest, files) = fixture.prepare(&sandbox).await;
    assert_eq!(files.len(), selected);
    assert!(
        manifest
            .storages
            .last()
            .unwrap()
            .archive_url
            .as_ref()
            .unwrap()
            .starts_with("file://")
    );
    download_storages_with_files(&sandbox, &minimal_context(), manifest, &files)
        .await
        .unwrap();
    assert_binary_calls(&sandbox, selected);
    fixture.shutdown().await;
}

#[tokio::test]
async fn split_decoded_batches_clean_once_and_preserve_real_files_and_metadata() {
    let fixture = DeliveryFixture::new(3, 3, 35_000).await;
    let sandbox = MockSandbox::new("decoded-cleanup");
    let (mut manifest, files) = fixture.prepare(&sandbox).await;
    let guest_root = fixture.root.path().join("guest");
    let preserved = guest_root.join("preserved");
    std::fs::create_dir_all(&preserved).unwrap();
    std::fs::write(preserved.join("keep"), b"keep").unwrap();
    std::fs::write(guest_root.join("stale"), b"stale").unwrap();
    manifest
        .cleanup_paths
        .push(guest_root.to_str().unwrap().into());
    manifest.storages.push(StorageEntry {
        mount_path: preserved.to_str().unwrap().into(),
        archive_url: None,
        extract_path: None,
        instructions_target_filename: None,
        cached: true,
        vas_storage_name: Some("preserved".into()),
        vas_version_id: Some("v1".into()),
    });
    download_storages_with_files(&sandbox, &minimal_context(), manifest, &files)
        .await
        .unwrap();
    let calls = sandbox.storage_manifest_calls();
    assert_eq!(calls.len(), 4);
    assert!(
        !calls[0]
            .manifest_json
            .starts_with(storage_files::INPUT_MAGIC)
    );
    for call in calls {
        if call.manifest_json.starts_with(storage_files::INPUT_MAGIC) {
            let (json, _) = storage_files::split_input(&call.manifest_json).unwrap();
            let batch: Manifest = serde_json::from_slice(json).unwrap();
            assert!(batch.cleanup_paths.is_empty());
            assert!(batch.instruction_cleanups.is_empty());
            assert!(guest_storage_apply::run_storage_files_bytes(
                &call.manifest_json
            ));
        } else {
            assert!(guest_storage_apply::run_manifest_bytes(&call.manifest_json));
        }
    }
    assert!(!guest_root.join("stale").exists());
    assert_eq!(std::fs::read(preserved.join("keep")).unwrap(), b"keep");
    for (mount, _) in &files {
        let path = std::path::Path::new(mount).join("file");
        assert_eq!(std::fs::read(&path).unwrap(), b"content");
        let metadata = std::fs::metadata(path).unwrap();
        assert_eq!(metadata.permissions().mode() & 0o777, 0o755);
        assert_eq!(metadata.mtime(), 1234);
    }
    assert_binary_calls(&sandbox, 3);
    fixture.shutdown().await;
}

#[tokio::test]
async fn split_decoded_delivery_stops_after_the_first_failed_helper() {
    for failed_batch in 0..3 {
        let fixture = DeliveryFixture::new(3, 3, 35_000).await;
        let sandbox = MockSandbox::new("decoded-failure");
        let (manifest, files) = fixture.prepare(&sandbox).await;
        for _ in 0..failed_batch {
            sandbox.push_exec_result(Ok(ExecResult::new(0, Vec::new(), Vec::new())));
        }
        sandbox.push_exec_result(Ok(ExecResult::new(
            1,
            Vec::new(),
            b"materialization failed".to_vec(),
        )));
        let error = download_storages_with_files(&sandbox, &minimal_context(), manifest, &files)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("storage download failed"));
        assert_eq!(sandbox.storage_manifest_calls().len(), failed_batch + 1);
        fixture.shutdown().await;
    }
}

#[tokio::test]
async fn split_delivery_rejects_cross_batch_ownership_conflicts_before_guest_work() {
    let fixture = DeliveryFixture::new(2, 2, 35_000).await;
    for conflict in [
        "ordinary",
        "reused",
        "instructions",
        "artifact",
        "duplicate",
    ] {
        let sandbox = MockSandbox::new("decoded-conflict");
        let (mut manifest, files) = fixture.prepare(&sandbox).await;
        let mount = format!("{}/child", files[0].0);
        match conflict {
            "artifact" => {
                manifest
                    .artifacts
                    .push(guest_contracts::storage_manifest::ArtifactEntry {
                        mount_path: mount,
                        archive_url: None,
                        empty: true,
                        cached: false,
                        vas_storage_name: None,
                        vas_storage_id: None,
                        vas_version_id: None,
                        missing_root_policy: None,
                    })
            }
            "duplicate" => manifest.storages.push(manifest.storages[0].clone()),
            _ => manifest.storages.push(StorageEntry {
                mount_path: mount,
                archive_url: (conflict != "reused")
                    .then(|| "https://archive.invalid/source".into()),
                extract_path: None,
                instructions_target_filename: (conflict == "instructions")
                    .then(|| "AGENTS.md".into()),
                cached: conflict == "reused",
                vas_storage_name: None,
                vas_version_id: None,
            }),
        }
        let error = download_storages_with_files(&sandbox, &minimal_context(), manifest, &files)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("storage files bindings"));
        assert!(sandbox.storage_manifest_calls().is_empty());
        assert!(sandbox.write_file_calls().is_empty());
    }
    fixture.shutdown().await;
}

#[tokio::test]
async fn oversized_ordinary_manifest_keeps_file_transport_before_decoded_batches() {
    let fixture = DeliveryFixture::new(1, 1, 604).await;
    let sandbox = MockSandbox::new("decoded-large-ordinary");
    let (mut manifest, files) = fixture.prepare(&sandbox).await;
    manifest.storages.push(StorageEntry {
        mount_path: fixture
            .root
            .path()
            .join("ordinary")
            .to_str()
            .unwrap()
            .into(),
        archive_url: Some(format!("https://archive.invalid/{}", "x".repeat(70_000))),
        extract_path: None,
        instructions_target_filename: None,
        cached: false,
        vas_storage_name: None,
        vas_version_id: None,
    });
    download_storages_with_files(&sandbox, &minimal_context(), manifest, &files)
        .await
        .unwrap();
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, guest::STORAGE_MANIFEST);
    let ordinary: Manifest = serde_json::from_slice(&writes[0].content).unwrap();
    assert_eq!(ordinary.storages.len(), 1);
    assert!(ordinary.storages[0].mount_path.ends_with("ordinary"));
    assert_eq!(sandbox.exec_calls().len(), 2);
    assert_binary_calls(&sandbox, 1);
    fixture.shutdown().await;
}

#[tokio::test]
async fn decoded_entry_admission_obeys_exact_canonical_json_boundary() {
    for extra in [0, 1] {
        let mut fixture = DeliveryFixture::new(2, 2, 604).await;
        let entry = &mut fixture.manifest.storages[0];
        entry.mount_path = fixture
            .root
            .path()
            .join("guest/escaped-\"-\\-文件")
            .to_str()
            .unwrap()
            .into();
        let single = StorageManifest {
            storages: vec![entry.clone()],
            artifacts: Vec::new(),
        };
        let single_wire = build_storage_plan(&single, "/tmp/runtime", None)
            .unwrap()
            .into_guest_manifest();
        let original_bytes = serde_json::to_vec(&single_wire).unwrap().len();
        entry
            .archive_url
            .push_str(&"x".repeat(storage_files::MAX_MANIFEST_BYTES + extra - original_bytes));
        // The oversized entry retains its legitimate archive fallback.
        let archive_dir = fixture
            .config
            .home
            .storage_cache_dir(&entry.name, &entry.vas_version_id);
        std::fs::write(archive_dir.join("archive.tar.gz"), archive_bytes()).unwrap();
        let sandbox = MockSandbox::new("decoded-boundary");
        let (manifest, files) = fixture.prepare(&sandbox).await;
        assert_eq!(files.len(), 2 - extra);
        download_storages_with_files(&sandbox, &minimal_context(), manifest, &files)
            .await
            .unwrap();
        assert_binary_calls(&sandbox, 2 - extra);
        if extra == 0 {
            let calls = sandbox.storage_manifest_calls();
            assert_eq!(calls.len(), 2);
            let (json, _) = storage_files::split_input(&calls[0].manifest_json).unwrap();
            assert_eq!(json.len(), storage_files::MAX_MANIFEST_BYTES);
        }
        fixture.shutdown().await;
    }
}

#[tokio::test]
async fn high_fanout_archive_hits_warm_decoded_files_only_after_agent_spawn() {
    let DeliveryFixture {
        root,
        config,
        manifest,
    } = DeliveryFixture::new(64, 63, 604).await;
    let last = manifest.storages.last().unwrap().clone();
    let cache = config.decoded_cache.clone();
    let background = config.background_fill.clone();
    let overrides = Arc::new(MockSandboxOverrides::new());
    let gate = MockLifecycleGate::new();
    overrides.set_start_process_lifecycle_gate(gate.clone());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let mut context = minimal_context();
    context.storage_manifest = Some(manifest);
    let run = spawn_run_in_sandbox_test(
        sandbox,
        context,
        config,
        tokio_util::sync::CancellationToken::new(),
    );
    gate.wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .unwrap();
    let before_spawn = cache
        .get_ready(&last.name, &last.vas_version_id)
        .await
        .unwrap();
    gate.release_one();
    let outcome = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, background.wait_idle_for_test())
        .await
        .unwrap();
    let after_spawn = cache
        .get_ready(&last.name, &last.vas_version_id)
        .await
        .unwrap();
    background.shutdown().await;
    cache.shutdown().await;
    assert!(outcome.failure.is_none());
    assert!(before_spawn.is_none());
    assert_eq!(after_spawn.unwrap().files[0].content, b"content");
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    drop(root);
}

#[tokio::test]
async fn decoded_batch_failure_prevents_agent_spawn() {
    let fixture = DeliveryFixture::new(3, 3, 35_000).await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_storage_manifest_result(Ok(ExecResult::new(0, Vec::new(), Vec::new())));
    overrides.push_storage_manifest_result(Ok(ExecResult::new(
        1,
        Vec::new(),
        b"second batch failed".to_vec(),
    )));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let mut context = minimal_context();
    context.storage_manifest = Some(fixture.manifest.clone());
    let mut telemetry = test_telemetry(&fixture.config, &context);
    let result = crate::executor::agent_run::run_in_sandbox(
        sandbox.as_ref(),
        &context,
        &fixture.config,
        crate::executor::agent_run::RunStart {
            restore_guest_state: false,
            reuse_result: crate::types::SandboxReuseResult::PoolMiss,
            workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        crate::executor::agent_run::RunControls::new(
            tokio_util::sync::CancellationToken::new(),
            None,
        ),
    )
    .await;
    let Err(error) = result else {
        panic!("failed decoded batch must fail the run before agent spawn");
    };
    assert!(error.to_string().contains("storage download failed"));
    assert_eq!(overrides.storage_manifest_calls().len(), 2);
    assert!(overrides.start_agent_process_calls().is_empty());
    fixture.shutdown().await;
}

#[tokio::test]
async fn cancelling_during_a_decoded_batch_prevents_later_batches_and_spawn() {
    let DeliveryFixture {
        root,
        config,
        manifest,
    } = DeliveryFixture::new(3, 3, 35_000).await;
    let cache = config.decoded_cache.clone();
    let background = config.background_fill.clone();
    let overrides = Arc::new(MockSandboxOverrides::new());
    let gate = MockLifecycleGate::new();
    overrides.set_storage_manifest_lifecycle_gate(gate.clone());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let mut context = minimal_context();
    context.storage_manifest = Some(manifest);
    let cancel = tokio_util::sync::CancellationToken::new();
    let run = spawn_run_in_sandbox_test(sandbox, context, config, cancel.clone());
    gate.wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .unwrap();
    gate.release_one();
    gate.wait_entered(2, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .unwrap();
    cancel.cancel();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(result.failure.unwrap().error, "cancelled by user");
    assert_eq!(overrides.storage_manifest_calls().len(), 2);
    assert!(overrides.start_agent_process_calls().is_empty());
    background.shutdown().await;
    cache.shutdown().await;
    drop(root);
}
