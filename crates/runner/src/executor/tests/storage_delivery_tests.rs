use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::sync::Arc;

use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;
use guest_contracts::storage_files;
use guest_contracts::storage_manifest::{Manifest, StorageEntry};
use sandbox::ExecResult;
use sandbox_mock::{MockLifecycleGate, MockSandbox, MockSandboxOverrides};

use super::super::storage::download_storages_with_files;
use super::super::{ExecutorConfig, RunnerResult, guest_runtime_dir};
use super::support::{
    RUN_IN_SANDBOX_TEST_TIMEOUT, api_artifact, api_storage, create_overridden_sandbox,
    minimal_context, spawn_run_in_sandbox_test, test_executor_config, test_telemetry,
};
use crate::storage_cache::decoded::CachedFiles;
use crate::storage_cache::{populate_cache_with_fresh_delivery, prepare_fresh_archive_delivery};
use crate::storage_plan::build_storage_plan;
use guest_contracts::runtime_paths::STORAGE_MANIFEST_PATH;
use runner_types::storage_manifest::StorageManifest;

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
            drop(
                runner_host::lock::open_lock_file(&config.home.storage_lock(&name, &version))
                    .unwrap(),
            );
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

    async fn artifacts(count: usize, ready: usize, url_bytes: usize) -> Self {
        let root = tempfile::tempdir().unwrap();
        let config = test_executor_config(root.path()).await;
        let archive = archive_bytes();
        let mut artifacts = Vec::new();
        for index in 0..count {
            let name = format!("artifact-{index:03}-{}", "n".repeat(40));
            let version = "v".repeat(64);
            let mount = root
                .path()
                .join("guest")
                .join(format!("artifact-{index:03}"));
            let prefix = format!("http://127.0.0.1:9/artifact-{index:03}?signature=");
            let url = format!("{prefix}{}", "x".repeat(url_bytes - prefix.len()));
            let archive_dir = config.home.storage_cache_dir(&name, &version);
            std::fs::create_dir_all(&archive_dir).unwrap();
            std::fs::write(archive_dir.join("archive.tar.gz"), &archive).unwrap();
            drop(
                runner_host::lock::open_lock_file(&config.home.storage_lock(&name, &version))
                    .unwrap(),
            );
            if index < ready {
                config
                    .decoded_cache
                    .warm_from_archive(&name, &version)
                    .await
                    .unwrap();
                std::fs::remove_file(archive_dir.join("archive.tar.gz")).unwrap();
            }
            let mut artifact = api_artifact(
                &name,
                mount.to_str().unwrap(),
                &format!("artifact-id-{index:03}"),
                &version,
                &url,
            );
            artifact.missing_root_policy =
                Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion);
            artifacts.push(artifact);
        }
        Self {
            root,
            config,
            manifest: StorageManifest {
                storages: Vec::new(),
                artifacts,
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

async fn apply_with_telemetry(
    fixture: &DeliveryFixture,
    sandbox: &MockSandbox,
    manifest: Manifest,
    files: &[(String, Arc<CachedFiles>)],
) -> RunnerResult<()> {
    let context = minimal_context();
    let mut telemetry = test_telemetry(&fixture.config, &context);
    download_storages_with_files(sandbox, &context, manifest, files, &mut telemetry).await
}

#[tokio::test]
async fn guest_apply_telemetry_attributes_one_and_three_batches() {
    for (count, url_bytes, expected_count, expected_size, expected_positions) in [
        (1, 604, "one", "at_most_4_kib", vec!["dedicated_only"]),
        (
            3,
            35_000,
            "three",
            "32_to_64_kib",
            vec!["dedicated_first", "dedicated_middle", "dedicated_last"],
        ),
    ] {
        let fixture = DeliveryFixture::new(count, count, url_bytes).await;
        let sandbox = MockSandbox::new("storage-batch-attribution");
        let (manifest, files) = fixture.prepare(&sandbox).await;
        let context = minimal_context();
        let mut telemetry = test_telemetry(&fixture.config, &context);
        download_storages_with_files(&sandbox, &context, manifest, &files, &mut telemetry)
            .await
            .unwrap();

        let observations = telemetry.pending_ops_with_outcome_snapshot();
        assert!(observations.iter().any(|(action, success, _, _)| {
            action == "runner_storage_manifest_batch_encode" && *success
        }));
        assert!(observations.iter().any(|(action, success, outcome, _)| {
            action == "runner_storage_manifest_batch_count"
                && *success
                && outcome.as_deref() == Some(expected_count)
        }));
        let batches = observations
            .iter()
            .filter(|(action, _, _, _)| action == "runner_storage_manifest_batch_apply")
            .collect::<Vec<_>>();
        assert_eq!(batches.len(), count);
        assert_eq!(sandbox.storage_manifest_calls().len(), count);
        for (batch, expected_position) in batches.iter().zip(expected_positions) {
            assert!(batch.1);
            assert_eq!(batch.2.as_deref(), Some(expected_position));
            assert_eq!(batch.3.as_deref(), Some(expected_size));
        }
        fixture.shutdown().await;
    }
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
        apply_with_telemetry(&fixture, &sandbox, manifest, &files)
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
async fn fresh_artifact_hit_retains_identity_and_delivers_decoded_files() {
    let fixture = DeliveryFixture::artifacts(1, 1, 604).await;
    let sandbox = MockSandbox::new("decoded-artifact");
    let (manifest, files) = fixture.prepare(&sandbox).await;
    assert_eq!(files.len(), 1);
    assert_eq!(manifest.artifacts.len(), 1);
    let artifact = &manifest.artifacts[0];
    let source = &fixture.manifest.artifacts[0];
    assert!(!artifact.cached);
    assert!(!artifact.empty);
    assert_eq!(
        artifact.vas_storage_name.as_deref(),
        Some(source.vas_storage_name.as_str())
    );
    assert_eq!(
        artifact.vas_storage_id.as_deref(),
        Some(source.vas_storage_id.as_str())
    );
    assert_eq!(
        artifact.vas_version_id.as_deref(),
        Some(source.vas_version_id.as_str())
    );
    assert!(
        artifact
            .archive_url
            .as_deref()
            .unwrap()
            .starts_with("http://")
    );
    assert_eq!(
        artifact.missing_root_policy.as_deref(),
        Some("preserveParentVersion")
    );
    apply_with_telemetry(&fixture, &sandbox, manifest, &files)
        .await
        .unwrap();
    assert_binary_calls(&sandbox, 1);
    fixture.shutdown().await;
}

#[tokio::test]
async fn oversized_artifact_manifest_uses_preencoded_decoded_batches() {
    let fixture = DeliveryFixture::artifacts(3, 3, 35_000).await;
    let sandbox = MockSandbox::new("decoded-large-artifacts");
    let (manifest, files) = fixture.prepare(&sandbox).await;
    assert_eq!(files.len(), 3);
    apply_with_telemetry(&fixture, &sandbox, manifest, &files)
        .await
        .unwrap();
    assert_eq!(sandbox.storage_manifest_calls().len(), 3);
    for call in sandbox.storage_manifest_calls() {
        let (json, _) = storage_files::split_input(&call.manifest_json).unwrap();
        let batch: Manifest = serde_json::from_slice(json).unwrap();
        assert!(batch.storages.is_empty());
        assert_eq!(batch.artifacts.len(), 1);
        assert!(batch.cleanup_paths.is_empty());
    }
    assert_binary_calls(&sandbox, 3);
    fixture.shutdown().await;
}

#[tokio::test]
async fn oversized_mixed_manifest_preserves_decoded_entry_kinds() {
    let fixture = DeliveryFixture::artifacts(2, 2, 35_000).await;
    let sandbox = MockSandbox::new("decoded-large-mixed");
    let (mut manifest, mut files) = fixture.prepare(&sandbox).await;
    let storage_mount = fixture.root.path().join("guest/storage");
    let prefix = "http://127.0.0.1:9/storage?signature=";
    manifest.storages.push(StorageEntry {
        mount_path: storage_mount.to_str().unwrap().into(),
        extract_path: None,
        archive_url: Some(format!("{prefix}{}", "x".repeat(35_000 - prefix.len()))),
        instructions_target_filename: None,
        cached: false,
        vas_storage_name: Some("mixed-storage".into()),
        vas_version_id: Some("v1".into()),
    });
    let storage_files = Arc::clone(&files[0].1);
    files.push((storage_mount.to_str().unwrap().into(), storage_files));

    apply_with_telemetry(&fixture, &sandbox, manifest, &files)
        .await
        .unwrap();
    let mut storage_entries = 0;
    let mut artifact_entries = 0;
    for call in sandbox.storage_manifest_calls() {
        let (json, _) = storage_files::split_input(&call.manifest_json).unwrap();
        let batch: Manifest = serde_json::from_slice(json).unwrap();
        assert_eq!(batch.storages.len() + batch.artifacts.len(), 1);
        assert!(batch.cleanup_paths.is_empty());
        storage_entries += batch.storages.len();
        artifact_entries += batch.artifacts.len();
    }
    assert_eq!(storage_entries, 1);
    assert_eq!(artifact_entries, 2);
    assert_binary_calls(&sandbox, 3);
    fixture.shutdown().await;
}

#[tokio::test]
async fn mixed_decoded_batch_uses_exact_per_array_comma_accounting() {
    let fixture = DeliveryFixture::artifacts(1, 1, 604).await;
    let sandbox = MockSandbox::new("decoded-mixed-boundary");
    let (mut manifest, mut files) = fixture.prepare(&sandbox).await;
    let storage_mount = fixture.root.path().join("guest/storage-boundary");
    let mut storage = StorageEntry {
        mount_path: storage_mount.to_str().unwrap().into(),
        extract_path: None,
        archive_url: Some("https://archive.invalid/storage?signature=".into()),
        instructions_target_filename: None,
        cached: false,
        vas_storage_name: Some("boundary-storage".into()),
        vas_version_id: Some("v1".into()),
    };
    let decoded_manifest = |storage: StorageEntry| Manifest {
        storages: vec![storage],
        artifacts: manifest.artifacts.clone(),
        cleanup_paths: Vec::new(),
        instruction_cleanups: Vec::new(),
    };
    let base_len = serde_json::to_vec(&decoded_manifest(storage.clone()))
        .unwrap()
        .len();
    storage
        .archive_url
        .as_mut()
        .unwrap()
        .push_str(&"x".repeat(storage_files::MAX_MANIFEST_BYTES - base_len));
    assert_eq!(
        serde_json::to_vec(&decoded_manifest(storage.clone()))
            .unwrap()
            .len(),
        storage_files::MAX_MANIFEST_BYTES
    );
    manifest.storages.push(storage);
    files.push((
        storage_mount.to_str().unwrap().into(),
        Arc::clone(&files[0].1),
    ));
    manifest.storages.push(StorageEntry {
        mount_path: fixture
            .root
            .path()
            .join("guest/ordinary")
            .to_str()
            .unwrap()
            .into(),
        extract_path: None,
        archive_url: Some(format!("https://archive.invalid/{}", "o".repeat(70_000))),
        instructions_target_filename: None,
        cached: false,
        vas_storage_name: Some("ordinary".into()),
        vas_version_id: Some("v1".into()),
    });

    apply_with_telemetry(&fixture, &sandbox, manifest, &files)
        .await
        .unwrap();
    let binary_calls = sandbox
        .storage_manifest_calls()
        .into_iter()
        .filter(|call| call.manifest_json.starts_with(storage_files::INPUT_MAGIC))
        .collect::<Vec<_>>();
    assert_eq!(binary_calls.len(), 1);
    let (json, _) = storage_files::split_input(&binary_calls[0].manifest_json).unwrap();
    let batch: Manifest = serde_json::from_slice(json).unwrap();
    assert_eq!(batch.storages.len(), 1);
    assert_eq!(batch.artifacts.len(), 1);
    assert_binary_calls(&sandbox, 2);
    fixture.shutdown().await;
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
    apply_with_telemetry(&fixture, &sandbox, manifest, &files)
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
    apply_with_telemetry(&fixture, &sandbox, manifest, &files)
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
    apply_with_telemetry(&fixture, &sandbox, manifest, &files)
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
        let context = minimal_context();
        let mut telemetry = test_telemetry(&fixture.config, &context);
        let error =
            download_storages_with_files(&sandbox, &context, manifest, &files, &mut telemetry)
                .await
                .unwrap_err();
        assert!(error.to_string().contains("storage download failed"));
        assert_eq!(sandbox.storage_manifest_calls().len(), failed_batch + 1);
        let batches = telemetry
            .pending_ops_with_outcome_snapshot()
            .into_iter()
            .filter(|(action, _, _, _)| action == "runner_storage_manifest_batch_apply")
            .collect::<Vec<_>>();
        assert_eq!(batches.len(), failed_batch + 1);
        assert!(!batches.last().unwrap().1);
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
        let context = minimal_context();
        let mut telemetry = test_telemetry(&fixture.config, &context);
        let error =
            download_storages_with_files(&sandbox, &context, manifest, &files, &mut telemetry)
                .await
                .unwrap_err();
        assert!(error.to_string().contains("storage files bindings"));
        assert!(sandbox.storage_manifest_calls().is_empty());
        assert!(sandbox.write_file_calls().is_empty());
        let observations = telemetry.pending_ops_with_outcome_snapshot();
        assert!(observations.iter().any(|(action, success, _, _)| {
            action == "runner_storage_manifest_batch_encode" && !success
        }));
        assert!(
            observations
                .iter()
                .all(|(action, _, _, _)| action != "runner_storage_manifest_batch_apply")
        );
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
    let context = minimal_context();
    let mut telemetry = test_telemetry(&fixture.config, &context);
    download_storages_with_files(&sandbox, &context, manifest, &files, &mut telemetry)
        .await
        .unwrap();
    let observations = telemetry.pending_ops_with_outcome_snapshot();
    assert!(observations.iter().any(|(action, success, outcome, _)| {
        action == "runner_storage_manifest_batch_count"
            && *success
            && outcome.as_deref() == Some("two")
    }));
    let batches = observations
        .iter()
        .filter(|(action, _, _, _)| action == "runner_storage_manifest_batch_apply")
        .collect::<Vec<_>>();
    assert_eq!(batches.len(), 2);
    assert_eq!(batches[0].2.as_deref(), Some("fallback_first"));
    assert_eq!(batches[0].3.as_deref(), Some("over_64_kib"));
    assert_eq!(batches[1].2.as_deref(), Some("dedicated_last"));
    assert_eq!(batches[1].3.as_deref(), Some("at_most_4_kib"));
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, STORAGE_MANIFEST_PATH);
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
        apply_with_telemetry(&fixture, &sandbox, manifest, &files)
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
            reuse_result: runner_types::types::SandboxReuseResult::PoolMiss,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::NotConfigured,
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
