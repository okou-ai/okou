use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use guest_contracts::{storage_files, storage_manifest::Manifest};
use runner_types::{
    content_bundle::WORKFLOW_BUNDLE_STORAGE_NAME,
    types::{ExecutionContext, SandboxReuseResult},
};
use sandbox::SandboxId;
use sandbox_mock::{MockSandboxFactory, MockSandboxOverrides};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::super::{NewSandboxDispatch, execute_job, execute_job_reuse};
use super::support::{
    api_artifact, default_params, make_reusable_idle_sandbox_with_fingerprints, minimal_context,
    seed_home_image_cache_with_fingerprints, test_executor_config_with_startup_api,
};

fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::none());
    let mut tar = tar::Builder::new(encoder);
    for (path, content) in files {
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o600);
        header.set_size(content.len() as u64);
        header.set_cksum();
        tar.append_data(&mut header, path, *content).unwrap();
    }
    tar.into_inner().unwrap().finish().unwrap()
}

fn context(hash: &str, bytes: u64, mount: &str, suffix: &str) -> ExecutionContext {
    let mut context = minimal_context();
    context.content_bundles = serde_json::from_value(serde_json::json!({
        "format": "tar-gzip-v1", "skills": [{
            "sha256": hash, "archiveBytes": bytes,
            "downloadUrl": format!("https://unreachable.invalid/{suffix}"),
            "mountPath": mount,
        }],
    }))
    .unwrap();
    context
}

fn guest_path(root: &Path, path: &str) -> PathBuf {
    root.join(Path::new(path).strip_prefix("/").unwrap())
}

/// Execute the captured production Storage input with the real Guest helper.
/// Remap only the sandbox filesystem root and optional external archive fixture URL.
fn apply_guest_storage(
    overrides: &MockSandboxOverrides,
    root: &Path,
    first_call: usize,
    remote: Option<&str>,
) {
    for file in overrides.write_file_calls() {
        if file.path.starts_with("/tmp/vm0-storage-cache/") {
            let path = guest_path(root, &file.path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, file.content).unwrap();
        }
    }
    for call in overrides.storage_manifest_calls().iter().skip(first_call) {
        let (json, mut files) = if call.manifest_json.starts_with(storage_files::INPUT_MAGIC) {
            let (json, payload) = storage_files::split_input(&call.manifest_json).unwrap();
            (json, storage_files::decode(payload).unwrap())
        } else {
            (call.manifest_json.as_slice(), Vec::new())
        };
        let mut manifest: Manifest = serde_json::from_slice(json).unwrap();
        for entry in &mut manifest.storages {
            entry.mount_path = guest_path(root, &entry.mount_path).to_str().unwrap().into();
            if let Some(url) = &mut entry.archive_url {
                if let Some(path) = url.strip_prefix("file://") {
                    *url = format!("file://{}", guest_path(root, path).display());
                } else if let Some(remote) = remote {
                    *url = remote.into();
                }
            }
        }
        for path in &mut manifest.cleanup_paths {
            *path = guest_path(root, path).to_str().unwrap().into();
        }
        for group in &mut files {
            group.mount_path = guest_path(root, &group.mount_path).to_str().unwrap().into();
        }
        let json = serde_json::to_vec(&manifest).unwrap();
        let success = if files.is_empty() {
            guest_storage_apply::run_manifest_bytes(&json)
        } else {
            let groups = files
                .iter()
                .map(|group| (group.mount_path.as_str(), group.files.as_slice()))
                .collect::<Vec<_>>();
            guest_storage_apply::run_storage_files_bytes(
                &storage_files::encode_input(&json, &groups).unwrap(),
            )
        };
        assert!(
            success,
            "Guest must apply the actual resolved Workflow Storage input"
        );
    }
}

#[tokio::test]
async fn workflow_storage_reuses_local_changes_and_reconciles_versions_names_and_removal() {
    for root in [".claude", ".codex", ".pi/agent"] {
        for decoded in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let (config, _api) = test_executor_config_with_startup_api(directory.path()).await;
            let guest = tempfile::tempdir().unwrap();
            let first = archive(&[
                ("SKILL.md", b"published first"),
                ("references/目录/原始.bin", &[0, 255, 128]),
                ("removed.md", b"old attachment"),
            ]);
            let next = archive(&[
                ("SKILL.md", b"published next"),
                ("references/目录/原始.bin", &[1, 0, 255]),
            ]);
            let hashes = [
                hex::encode(Sha256::digest(&first)),
                hex::encode(Sha256::digest(&next)),
            ];
            for (bytes, hash) in [(&first, &hashes[0]), (&next, &hashes[1])] {
                let cache = config
                    .home
                    .storage_cache_dir(WORKFLOW_BUNDLE_STORAGE_NAME, hash);
                fs::create_dir_all(&cache).unwrap();
                fs::write(cache.join("archive.tar.gz"), bytes).unwrap();
                drop(
                    runner_host::lock::open_lock_file(
                        &config.home.storage_lock(WORKFLOW_BUNDLE_STORAGE_NAME, hash),
                    )
                    .unwrap(),
                );
                if decoded {
                    config
                        .decoded_cache
                        .warm_from_archive(WORKFLOW_BUNDLE_STORAGE_NAME, hash)
                        .await
                        .unwrap();
                    assert!(
                        config
                            .decoded_cache
                            .get_ready(WORKFLOW_BUNDLE_STORAGE_NAME, hash)
                            .await
                            .unwrap()
                            .is_some()
                    );
                    fs::remove_file(cache.join("archive.tar.gz")).unwrap();
                }
            }
            let overrides = Arc::new(MockSandboxOverrides::new());
            let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
            let original_mount = format!("/home/user/{root}/skills/example");
            let renamed_mount = format!("/home/user/{root}/skills/renamed");
            let target = guest_path(guest.path(), &original_mount);
            let renamed = guest_path(guest.path(), &renamed_mount);
            let history = guest_path(guest.path(), &format!("/home/user/{root}/native-history"));
            fs::create_dir_all(history.parent().unwrap()).unwrap();
            fs::write(&history, b"preserved").unwrap();
            let mut idle = None;
            let mut leases = Vec::new();
            for step in 0..5 {
                let mut current = match step {
                    0 | 1 => context(
                        &hashes[0],
                        first.len() as u64,
                        &original_mount,
                        if step == 0 {
                            "first-signature"
                        } else {
                            "changed-signature"
                        },
                    ),
                    2 => context(
                        &hashes[1],
                        next.len() as u64,
                        &original_mount,
                        "next-version",
                    ),
                    3 => context(&hashes[1], next.len() as u64, &renamed_mount, "renamed"),
                    _ => minimal_context(),
                };
                current.run_id = runner_types::ids::RunId::new_v4();
                let first_call = overrides.storage_manifest_calls().len();
                let (mut outcome, _) = if let Some(idle) = idle.take() {
                    execute_job_reuse(
                        idle,
                        current,
                        &config,
                        &default_params(),
                        CancellationToken::new(),
                    )
                    .await
                } else {
                    execute_job(
                        &factory,
                        current,
                        NewSandboxDispatch {
                            id: SandboxId::new_v4(),
                            reuse_result: SandboxReuseResult::NoReuseKey,
                        },
                        &config,
                        &default_params(),
                        CancellationToken::new(),
                    )
                    .await
                };
                assert_eq!(outcome.exit_code(), 0, "{:?}", outcome.error());
                if let Some(report) = outcome.startup_report.take() {
                    report.finish().await;
                }
                apply_guest_storage(&overrides, guest.path(), first_call, None);
                match step {
                    0 => {
                        assert_eq!(
                            fs::read(target.join("SKILL.md")).unwrap(),
                            b"published first"
                        );
                        assert_eq!(
                            fs::read(target.join("references/目录/原始.bin")).unwrap(),
                            [0, 255, 128]
                        );
                        fs::write(target.join("SKILL.md"), b"agent edit").unwrap();
                        fs::remove_file(target.join("references/目录/原始.bin")).unwrap();
                        fs::write(target.join("agent-created.md"), b"local").unwrap();
                    }
                    1 => {
                        assert_eq!(fs::read(target.join("SKILL.md")).unwrap(), b"agent edit");
                        assert!(!target.join("references/目录/原始.bin").exists());
                        assert_eq!(fs::read(target.join("agent-created.md")).unwrap(), b"local");
                    }
                    2 => {
                        assert_eq!(
                            fs::read(target.join("SKILL.md")).unwrap(),
                            b"published next"
                        );
                        assert_eq!(
                            fs::read(target.join("references/目录/原始.bin")).unwrap(),
                            [1, 0, 255]
                        );
                        assert!(!target.join("removed.md").exists());
                        assert!(!target.join("agent-created.md").exists());
                    }
                    3 => {
                        assert!(!target.exists());
                        assert_eq!(
                            fs::read(renamed.join("SKILL.md")).unwrap(),
                            b"published next"
                        );
                    }
                    _ => assert!(!renamed.exists()),
                }
                assert_eq!(fs::read(&history).unwrap(), b"preserved");
                if step < 4 {
                    let fingerprints = outcome.storage_fingerprints.clone();
                    let (sandbox, lease) = make_reusable_idle_sandbox_with_fingerprints(
                        outcome.sandbox.take().unwrap(),
                        outcome.source_ip,
                        "workflow-session",
                        fingerprints,
                    )
                    .await;
                    idle = Some(sandbox);
                    leases.push(lease);
                }
            }
            config.background_fill.shutdown().await;
            config.decoded_cache.shutdown().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn large_workflow_archive_downloads_through_ordinary_guest_passthrough() {
    let directory = tempfile::tempdir().unwrap();
    let (config, _api) = test_executor_config_with_startup_api(directory.path()).await;
    let guest = tempfile::tempdir().unwrap();
    let paths = std::iter::once("SKILL.md".into())
        .chain(
            (0..500)
                .map(|index| format!("references/{0}/{0}/{0}/{index:03}.bin", "目录".repeat(30))),
        )
        .collect::<Vec<_>>();
    let content = (0..32 * 1024)
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    let files = paths
        .iter()
        .map(|path| (path.as_str(), content.as_slice()))
        .collect::<Vec<_>>();
    let bytes = archive(&files);
    assert!(bytes.len() > 15 * 1024 * 1024);
    let server = httpmock::MockServer::start();
    let download = server.mock(|when, then| {
        when.method(httpmock::Method::GET).path("/complete.tar.gz");
        then.status(200).body(bytes.clone());
    });
    let overrides = Arc::new(MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mount = "/home/user/.codex/skills/example";
    let hash = hex::encode(Sha256::digest(&bytes));
    let (mut outcome, _) = execute_job(
        &factory,
        context(&hash, bytes.len() as u64, mount, "large"),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoReuseKey,
        },
        &config,
        &default_params(),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(outcome.exit_code(), 0, "{:?}", outcome.error());
    if let Some(report) = outcome.startup_report.take() {
        report.finish().await;
    }
    apply_guest_storage(
        &overrides,
        guest.path(),
        0,
        Some(&server.url("/complete.tar.gz")),
    );
    download.assert_calls(1);
    for path in paths {
        assert_eq!(
            fs::read(guest_path(guest.path(), mount).join(path)).unwrap(),
            content
        );
    }
    config.background_fill.shutdown().await;
}

#[tokio::test]
async fn home_restored_workflow_storage_preserves_matching_local_content() {
    use crate::home_image_cache::HomeImageCache;
    use runner_host::paths::RunnerPaths;
    use runner_types::storage_fingerprints::{StorageFingerprint, StorageFingerprints};

    let directory = tempfile::tempdir().unwrap();
    let (mut config, _api) = test_executor_config_with_startup_api(directory.path()).await;
    let paths = RunnerPaths::new(directory.path().join("runner"));
    let home = HomeImageCache::new(paths.clone());
    config.home_cache = Some(home.clone());
    let mount = "/home/user/.claude/skills/example";
    let hash = "a".repeat(64);
    let mut current = context(&hash, 10, mount, "same-content-new-signature");
    let session = "workflow-home";
    current.reuse_key = Some(format!("thread:home-cache-{session}"));
    current.native_continuation = Some(guest_contracts::env::NativeContinuation {
        session_id: Some(session.into()),
        generation_run_id: Some(current.run_id.to_string()),
        recovery_prompt: None,
    });
    let mut fingerprints = StorageFingerprints::default();
    fingerprints.storages.insert(
        mount.into(),
        StorageFingerprint::new(WORKFLOW_BUNDLE_STORAGE_NAME, &hash),
    );
    seed_home_image_cache_with_fingerprints(&home, &paths, session, 16, &fingerprints).await;
    let guest = tempfile::tempdir().unwrap();
    let target = guest_path(guest.path(), mount);
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("SKILL.md"), b"local Home edit").unwrap();
    let overrides = Arc::new(MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let params = super::super::JobParams {
        home_disk_mb: 16,
        ..default_params()
    };
    let (mut outcome, _) = execute_job(
        &factory,
        current,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        CancellationToken::new(),
    )
    .await;
    assert_eq!(outcome.exit_code(), 0, "{:?}", outcome.error());
    assert_eq!(
        outcome.home_reuse_result,
        Some(runner_types::types::HomeReuseResult::Reused)
    );
    apply_guest_storage(&overrides, guest.path(), 0, None);
    assert_eq!(
        fs::read(target.join("SKILL.md")).unwrap(),
        b"local Home edit"
    );
    if let Some(report) = outcome.startup_report.take() {
        report.finish().await;
    }
}

#[tokio::test]
async fn invalid_or_conflicting_workflow_input_prevents_sandbox_creation() {
    for kind in ["reference", "workflow", "artifact"] {
        let directory = tempfile::tempdir().unwrap();
        let (config, _api) = test_executor_config_with_startup_api(directory.path()).await;
        let mut current = context(
            &"a".repeat(64),
            10,
            "/home/user/.codex/skills/example",
            "invalid",
        );
        if kind == "workflow" {
            current.content_bundles.skills.push(serde_json::from_value(serde_json::json!({"sha256": "b".repeat(64), "archiveBytes": 10, "downloadUrl": "https://unreachable.invalid/duplicate", "mountPath": "/home/user/.codex/skills/example"})).unwrap());
        } else if kind == "artifact" {
            current.storage_manifest = Some(runner_types::storage_manifest::StorageManifest {
                storages: Vec::new(),
                artifacts: vec![api_artifact(
                    "artifact",
                    "/home/user/.codex/skills/example",
                    "id",
                    "v1",
                    "https://unreachable.invalid/artifact",
                )],
            });
        } else {
            current.content_bundles.skills[0].sha256 = "invalid".into();
        }
        let overrides = Arc::new(MockSandboxOverrides::new());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let (mut outcome, _) = execute_job(
            &factory,
            current,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::NoReuseKey,
            },
            &config,
            &default_params(),
            CancellationToken::new(),
        )
        .await;
        assert_ne!(outcome.exit_code(), 0);
        assert!(overrides.create_configs().is_empty());
        assert!(overrides.start_agent_process_calls().is_empty());
        if let Some(report) = outcome.startup_report.take() {
            report.finish().await;
        }
    }
}

#[tokio::test]
async fn failed_workflow_storage_application_prevents_agent_spawn() {
    let directory = tempfile::tempdir().unwrap();
    let (config, _api) = test_executor_config_with_startup_api(directory.path()).await;
    let bytes = archive(&[("SKILL.md", b"current")]);
    let hash = hex::encode(Sha256::digest(&bytes));
    let cache = config
        .home
        .storage_cache_dir(WORKFLOW_BUNDLE_STORAGE_NAME, &hash);
    fs::create_dir_all(&cache).unwrap();
    fs::write(cache.join("archive.tar.gz"), &bytes).unwrap();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_storage_manifest_result(Ok(sandbox::ExecResult::new(
        1,
        Vec::new(),
        b"archive extraction failed".to_vec(),
    )));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let (mut outcome, _) = execute_job(
        &factory,
        context(
            &hash,
            bytes.len() as u64,
            "/home/user/.codex/skills/example",
            "cached",
        ),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoReuseKey,
        },
        &config,
        &default_params(),
        CancellationToken::new(),
    )
    .await;
    assert_ne!(outcome.exit_code(), 0);
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(!outcome.sandbox_reuse_disposition.is_eligible());
    if let Some(report) = outcome.startup_report.take() {
        report.finish().await;
    }
}
