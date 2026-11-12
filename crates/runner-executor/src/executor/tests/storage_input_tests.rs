use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use guest_contracts::{
    agent_instructions::{
        InstructionCheck, InstructionOperation, SOURCE_FILENAME, instruction_paths,
    },
    storage_files,
    storage_manifest::Manifest,
};
use runner_types::{
    storage_manifest::{INSTRUCTION_STORAGE_NAME, WORKFLOW_STORAGE_NAME},
    types::SandboxReuseResult,
};
use sandbox::SandboxId;
use sandbox_mock::{MockLifecycleGate, MockSandboxFactory, MockSandboxOverrides};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::super::{
    ExecutionHooks, NewSandboxDispatch, ReusedSandboxDispatch, SandboxReuseDisposition,
    SandboxReuseTerminal, execute_job, execute_job_reuse, execute_job_reuse_with_hooks,
};
use super::support::{
    RUN_IN_SANDBOX_TEST_TIMEOUT, api_storage, create_overridden_sandbox, default_params,
    instruction_context, make_reusable_idle_sandbox_with_fingerprints, minimal_context,
    seed_home_image_cache_with_fingerprints, test_executor_config_with_startup_api,
    workflow_context as context,
};
use runner_provider::RunCancellationHandle;
use runner_types::storage_fingerprints::{StorageFingerprint, StorageFingerprints};

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
        for cleanup in &mut manifest.instruction_cleanups {
            cleanup.mount_path = guest_path(root, &cleanup.mount_path)
                .to_str()
                .unwrap()
                .into();
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
            "Guest must apply the actual resolved content package Storage input"
        );
    }
}

fn apply_guest_instructions(overrides: &MockSandboxOverrides, root: &Path, first_exec: usize) {
    for call in overrides.agent_instructions_calls().iter().skip(first_exec) {
        if call.operation == InstructionOperation::Apply {
            assert!(guest_storage_apply::apply_agent_instructions(
                &guest_path(root, "/home/user"),
                &call.metadata,
            ));
        }
    }
}

fn instruction_check(overrides: &MockSandboxOverrides, root: &Path, framework: &str) {
    instruction_check_with_mounts(overrides, root, framework, &[]);
}

fn instruction_check_with_mounts(
    overrides: &MockSandboxOverrides,
    root: &Path,
    framework: &str,
    mounts: &[&str],
) {
    let metadata = serde_json::to_vec(&InstructionCheck {
        framework: framework.into(),
        preserved_download_mounts: mounts
            .iter()
            .map(|path| guest_path(root, path).to_str().unwrap().into())
            .collect(),
    })
    .unwrap();
    let checked =
        guest_storage_apply::check_agent_instructions(&guest_path(root, "/home/user"), &metadata);
    let result = match checked {
        Ok(present) => {
            sandbox::ExecResult::new(0, serde_json::to_vec(&present).unwrap(), Vec::new())
        }
        Err(_) => sandbox::ExecResult::new(1, Vec::new(), Vec::new()),
    };
    overrides.add_exec_result_matcher(" --instructions-check-stdin", result);
}

#[tokio::test]
async fn instruction_storage_reuses_applied_files_and_refreshes_changed_versions() {
    for (framework, target_file) in [
        ("claude-code", ".claude/CLAUDE.md"),
        ("codex", ".codex/AGENTS.md"),
        ("pi", ".pi/agent/AGENTS.md"),
    ] {
        for decoded in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let (config, _api) = test_executor_config_with_startup_api(directory.path()).await;
            let guest = tempfile::tempdir().unwrap();
            let published: [&[u8]; 3] = [
                "\u{feff} exact\r\n目录 🦉\n".as_bytes(),
                "changed instructions\n".as_bytes(),
                b"",
            ];
            let archives = published
                .iter()
                .map(|content| archive(&[(SOURCE_FILENAME, *content)]))
                .collect::<Vec<_>>();
            let hashes = archives
                .iter()
                .map(|bytes| hex::encode(Sha256::digest(bytes)))
                .collect::<Vec<_>>();
            for (bytes, hash) in archives.iter().zip(&hashes) {
                let cache = config
                    .home
                    .storage_cache_dir(INSTRUCTION_STORAGE_NAME, hash);
                fs::create_dir_all(&cache).unwrap();
                fs::write(cache.join("archive.tar.gz"), bytes).unwrap();
                drop(
                    runner_host::lock::open_lock_file(
                        &config.home.storage_lock(INSTRUCTION_STORAGE_NAME, hash),
                    )
                    .unwrap(),
                );
                if decoded {
                    config
                        .decoded_cache
                        .warm_from_archive(INSTRUCTION_STORAGE_NAME, hash)
                        .await
                        .unwrap();
                    assert!(
                        config
                            .decoded_cache
                            .get_ready(INSTRUCTION_STORAGE_NAME, hash)
                            .await
                            .unwrap()
                            .is_some()
                    );
                    fs::remove_file(cache.join("archive.tar.gz")).unwrap();
                }
            }
            let target = guest_path(guest.path(), &format!("/home/user/{target_file}"));
            let history = target.parent().unwrap().join("native-history");
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(&history, b"preserved").unwrap();
            let overrides = Arc::new(MockSandboxOverrides::new());
            let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
            let mut idle = None;
            let mut leases = Vec::new();
            for (step, version) in [0, 0, 0, 1, 2].into_iter().enumerate() {
                fs::write(&target, b"Agent local edit").unwrap();
                if step == 2 {
                    fs::remove_file(&target).unwrap();
                }
                let mut current = instruction_context(
                    &hashes[version],
                    archives[version].len() as u64,
                    framework,
                    "instructions",
                );
                current.run_id = runner_types::ids::RunId::new_v4();
                if matches!(step, 1 | 2) {
                    instruction_check(&overrides, guest.path(), framework);
                }
                let first_storage = overrides.storage_manifest_calls().len();
                let first_exec = overrides.agent_instructions_calls().len();
                let (mut outcome, _) = if let Some(sandbox) = idle.take() {
                    execute_job_reuse(
                        sandbox,
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
                apply_guest_storage(&overrides, guest.path(), first_storage, None);
                apply_guest_instructions(&overrides, guest.path(), first_exec);
                let expected = if step == 1 {
                    b"Agent local edit".as_slice()
                } else {
                    published[version]
                };
                assert_eq!(fs::read(&target).unwrap(), expected);
                if step == 1 {
                    assert_eq!(overrides.storage_manifest_calls().len(), first_storage);
                    assert!(
                        !overrides
                            .agent_instructions_calls()
                            .iter()
                            .skip(first_exec)
                            .any(|call| call.operation == InstructionOperation::Apply)
                    );
                }
                assert_eq!(fs::read(&history).unwrap(), b"preserved");
                assert!(
                    !instruction_paths(&guest_path(guest.path(), "/home/user"), framework)
                        .unwrap()
                        .staging
                        .exists()
                );
                let fingerprints = outcome.storage_fingerprints.clone();
                let (sandbox, lease) = make_reusable_idle_sandbox_with_fingerprints(
                    outcome.sandbox.take().unwrap(),
                    outcome.source_ip,
                    "instruction-session",
                    fingerprints,
                )
                .await;
                idle = Some(sandbox);
                leases.push(lease);
            }
            config.background_fill.shutdown().await;
            config.decoded_cache.shutdown().await;
        }
    }
}

#[tokio::test]
async fn cancelled_preparation_reuses_only_instructions_applied_to_the_final_file() {
    for cancel_during_bootstrap in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let (config, _api) = test_executor_config_with_startup_api(directory.path()).await;
        let guest = tempfile::tempdir().unwrap();
        let paths = instruction_paths(Path::new("/home/user"), "claude-code").unwrap();
        let instruction_mount = paths.staging.to_str().unwrap();
        let target = guest_path(guest.path(), paths.target.to_str().unwrap());
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"previous instructions").unwrap();
        let workflow_mount = "/home/user/workflow";
        let workflow_file = guest_path(guest.path(), workflow_mount).join("SKILL.md");
        fs::create_dir_all(workflow_file.parent().unwrap()).unwrap();
        fs::write(&workflow_file, b"Agent local workflow edit").unwrap();

        let new_instructions = b"updated instructions";
        let instruction_archive = archive(&[(SOURCE_FILENAME, new_instructions)]);
        let instruction_version = hex::encode(Sha256::digest(&instruction_archive));
        let workflow_archive = archive(&[("SKILL.md", b"published workflow")]);
        for (name, version, bytes) in [
            (
                INSTRUCTION_STORAGE_NAME,
                instruction_version.as_str(),
                instruction_archive.as_slice(),
            ),
            (WORKFLOW_STORAGE_NAME, "v1", workflow_archive.as_slice()),
        ] {
            let cache = config.home.storage_cache_dir(name, version);
            fs::create_dir_all(&cache).unwrap();
            fs::write(cache.join("archive.tar.gz"), bytes).unwrap();
        }
        let mut current = instruction_context(
            &instruction_version,
            instruction_archive.len() as u64,
            "claude-code",
            "cancelled-preparation",
        );
        current
            .storage_manifest
            .as_mut()
            .unwrap()
            .storages
            .push(api_storage(
                WORKFLOW_STORAGE_NAME,
                workflow_mount,
                "v1",
                "https://unreachable.invalid/workflow",
            ));
        let mut next_context = instruction_context(
            &instruction_version,
            instruction_archive.len() as u64,
            "claude-code",
            "cancelled-preparation",
        );
        next_context.storage_manifest = current.storage_manifest.clone();
        next_context.run_id = runner_types::ids::RunId::new_v4();
        let previous = StorageFingerprints {
            storages: [
                (
                    instruction_mount.into(),
                    StorageFingerprint::new(INSTRUCTION_STORAGE_NAME, "previous"),
                ),
                (
                    workflow_mount.into(),
                    StorageFingerprint::new(WORKFLOW_STORAGE_NAME, "v1"),
                ),
            ]
            .into(),
            artifacts: Default::default(),
        };
        let overrides = Arc::new(MockSandboxOverrides::new());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
        let source_ip = sandbox.source_ip().to_string();
        let (idle, _lease) = make_reusable_idle_sandbox_with_fingerprints(
            sandbox,
            source_ip,
            "cancelled-instructions",
            previous,
        )
        .await;
        let gate = MockLifecycleGate::new();
        if cancel_during_bootstrap {
            overrides.set_private_write_file_lifecycle_gate(gate.clone());
        } else {
            overrides.set_storage_manifest_lifecycle_gate(gate.clone());
        }
        let params = default_params();
        let cancellation = RunCancellationHandle::new();
        let execution = execute_job_reuse_with_hooks(
            ReusedSandboxDispatch {
                factory: &factory,
                idle_sandbox: idle,
                reuse_result: SandboxReuseResult::Reused,
            },
            current,
            &config,
            &params,
            cancellation.signals(),
            ExecutionHooks::none(),
        );
        tokio::pin!(execution);
        tokio::select! {
            _ = &mut execution => panic!("Run completed before the preparation gate"),
            entered = gate.wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT) => entered.unwrap(),
        };
        cancellation.request_cooperative_user_cancellation().await;
        overrides.clear_private_write_file_lifecycle_gate();
        gate.release_many(usize::MAX);
        let (mut cancelled, _) = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, execution)
            .await
            .unwrap();
        assert_eq!(cancelled.exit_code(), super::super::EXIT_SIGKILL);
        assert_eq!(
            cancelled.sandbox_reuse_disposition,
            SandboxReuseDisposition::Eligible(SandboxReuseTerminal::CooperativeCancellation)
        );
        apply_guest_storage(&overrides, guest.path(), 0, None);
        apply_guest_instructions(&overrides, guest.path(), 0);
        if cancel_during_bootstrap {
            assert_eq!(fs::read(&target).unwrap(), new_instructions);
            fs::write(&target, b"Agent local instruction edit").unwrap();
        } else {
            assert_eq!(fs::read(&target).unwrap(), b"previous instructions");
        }

        let (idle, _next_lease) = make_reusable_idle_sandbox_with_fingerprints(
            cancelled.sandbox.take().unwrap(),
            cancelled.source_ip,
            "cancelled-instructions",
            cancelled.storage_fingerprints,
        )
        .await;
        instruction_check(&overrides, guest.path(), "claude-code");
        let first_storage = overrides.storage_manifest_calls().len();
        let first_exec = overrides.agent_instructions_calls().len();
        let (mut next, _) = execute_job_reuse(
            idle,
            next_context,
            &config,
            &params,
            CancellationToken::new(),
        )
        .await;
        assert_eq!(next.exit_code(), 0, "{:?}", next.error());
        if let Some(report) = next.startup_report.take() {
            report.finish().await;
        }
        apply_guest_storage(&overrides, guest.path(), first_storage, None);
        apply_guest_instructions(&overrides, guest.path(), first_exec);
        let expected = if cancel_during_bootstrap {
            b"Agent local instruction edit".as_slice()
        } else {
            new_instructions.as_slice()
        };
        assert_eq!(fs::read(&target).unwrap(), expected);
        assert_eq!(
            fs::read(&workflow_file).unwrap(),
            b"Agent local workflow edit"
        );
        config.background_fill.shutdown().await;
        config.decoded_cache.shutdown().await;
    }
}

#[tokio::test]
async fn storage_preparation_preserves_pre_start_cancellation() {
    for reused in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let (config, _api) = test_executor_config_with_startup_api(directory.path()).await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let (idle, _lease) = if reused {
            let (mut first, _) = execute_job(
                &factory,
                minimal_context(),
                NewSandboxDispatch {
                    id: SandboxId::new_v4(),
                    reuse_result: SandboxReuseResult::NoReuseKey,
                },
                &config,
                &default_params(),
                CancellationToken::new(),
            )
            .await;
            assert_eq!(first.exit_code(), 0, "{:?}", first.error());
            if let Some(report) = first.startup_report.take() {
                report.finish().await;
            }
            let (sandbox, lease) = make_reusable_idle_sandbox_with_fingerprints(
                first.sandbox.take().unwrap(),
                first.source_ip,
                "cancelled-instructions",
                first.storage_fingerprints,
            )
            .await;
            (Some(sandbox), Some(lease))
        } else {
            (None, None)
        };
        let started = overrides.start_agent_process_calls().len();
        let created = overrides.create_configs().len();
        let mut current = instruction_context(&"a".repeat(64), 10, "claude-code", "cancelled");
        current.run_id = runner_types::ids::RunId::new_v4();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let (outcome, _) = if let Some(idle) = idle {
            execute_job_reuse(idle, current, &config, &default_params(), cancel).await
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
                cancel,
            )
            .await
        };
        assert_eq!(outcome.exit_code(), super::super::EXIT_SIGKILL);
        assert_eq!(outcome.sandbox.is_some(), reused);
        assert_eq!(overrides.create_configs().len(), created);
        assert_eq!(overrides.start_agent_process_calls().len(), started);
    }
}

#[tokio::test]
async fn required_instruction_storage_or_application_failure_prevents_agent_spawn() {
    for stage in ["storage", "application"] {
        let directory = tempfile::tempdir().unwrap();
        let (config, _api) = test_executor_config_with_startup_api(directory.path()).await;
        let bytes = archive(&[(SOURCE_FILENAME, b"required instructions")]);
        let hash = hex::encode(Sha256::digest(&bytes));
        let cache = config
            .home
            .storage_cache_dir(INSTRUCTION_STORAGE_NAME, &hash);
        fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join("archive.tar.gz"), &bytes).unwrap();
        let current = instruction_context(&hash, bytes.len() as u64, "claude-code", "required");
        let overrides = Arc::new(MockSandboxOverrides::new());
        if stage == "storage" {
            overrides.push_storage_manifest_result(Ok(sandbox::ExecResult::new(
                1,
                Vec::new(),
                Vec::new(),
            )));
        } else {
            overrides.add_exec_result_matcher(
                " --instructions-stdin",
                sandbox::ExecResult::new(1, Vec::new(), Vec::new()),
            );
        }
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
        assert!(overrides.start_agent_process_calls().is_empty());
        assert!(!outcome.sandbox_reuse_disposition.is_eligible());
        if let Some(report) = outcome.startup_report.take() {
            report.finish().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn large_instruction_package_streams_and_applies_the_complete_file() {
    let directory = tempfile::tempdir().unwrap();
    let (config, _api) = test_executor_config_with_startup_api(directory.path()).await;
    let guest = tempfile::tempdir().unwrap();
    // Exactly the supported 5 Mi UTF-16 instruction limit. Stored gzip blocks
    // make the complete archive exceed the Guest batch bound without changing it.
    let content = "界".repeat(5 * 1024 * 1024);
    let bytes = archive(&[(SOURCE_FILENAME, content.as_bytes())]);
    assert!(bytes.len() > 15 * 1024 * 1024);
    let hash = hex::encode(Sha256::digest(&bytes));
    let archive_size = bytes.len() as u64;
    let server = httpmock::MockServer::start();
    let response = httpmock::HttpMockResponse::builder()
        .status(200)
        .body(bytes)
        .build();
    let download = server.mock(|when, then| {
        when.method(httpmock::Method::GET)
            .path("/instructions.tar.gz");
        then.respond_with(move |_| response.clone());
    });
    let current = instruction_context(&hash, archive_size, "codex", "large-instructions");
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
    assert_eq!(outcome.exit_code(), 0, "{:?}", outcome.error());
    if let Some(report) = outcome.startup_report.take() {
        report.finish().await;
    }
    apply_guest_storage(
        &overrides,
        guest.path(),
        0,
        Some(&server.url("/instructions.tar.gz")),
    );
    apply_guest_instructions(&overrides, guest.path(), 0);
    download.assert_calls(1);
    let actual = fs::read(guest_path(guest.path(), "/home/user/.codex/AGENTS.md")).unwrap();
    assert!(
        actual.as_slice() == content.as_bytes(),
        "fresh instructions must match the complete original content"
    );
    drop(actual);
    let target = guest_path(guest.path(), "/home/user/.codex/AGENTS.md");
    fs::remove_file(&target).unwrap();
    let (idle, _lease) = make_reusable_idle_sandbox_with_fingerprints(
        outcome.sandbox.take().unwrap(),
        outcome.source_ip,
        "large-instruction-repair",
        outcome.storage_fingerprints,
    )
    .await;
    instruction_check(&overrides, guest.path(), "codex");
    let mut next_context = instruction_context(
        &hash,
        archive_size,
        "codex",
        "large-instructions-next-signature",
    );
    next_context.run_id = runner_types::ids::RunId::new_v4();
    let first_storage = overrides.storage_manifest_calls().len();
    let first_exec = overrides.agent_instructions_calls().len();
    let (mut repaired, _) = execute_job_reuse(
        idle,
        next_context,
        &config,
        &default_params(),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(repaired.exit_code(), 0, "{:?}", repaired.error());
    if let Some(report) = repaired.startup_report.take() {
        report.finish().await;
    }
    apply_guest_storage(
        &overrides,
        guest.path(),
        first_storage,
        Some(&server.url("/instructions.tar.gz")),
    );
    apply_guest_instructions(&overrides, guest.path(), first_exec);
    download.assert_calls(2);
    assert!(
        fs::read(target).unwrap().as_slice() == content.as_bytes(),
        "reused instructions must match the complete original content"
    );
    config.background_fill.shutdown().await;
    // Release the shared archive after every consumer and content assertion.
    download.delete_async().await;
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
                let cache = config.home.storage_cache_dir(WORKFLOW_STORAGE_NAME, hash);
                fs::create_dir_all(&cache).unwrap();
                fs::write(cache.join("archive.tar.gz"), bytes).unwrap();
                drop(
                    runner_host::lock::open_lock_file(
                        &config.home.storage_lock(WORKFLOW_STORAGE_NAME, hash),
                    )
                    .unwrap(),
                );
                if decoded {
                    config
                        .decoded_cache
                        .warm_from_archive(WORKFLOW_STORAGE_NAME, hash)
                        .await
                        .unwrap();
                    assert!(
                        config
                            .decoded_cache
                            .get_ready(WORKFLOW_STORAGE_NAME, hash)
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
    let archive_size = bytes.len() as u64;
    let hash = hex::encode(Sha256::digest(&bytes));
    let server = httpmock::MockServer::start();
    let response = httpmock::HttpMockResponse::builder()
        .status(200)
        .body(bytes)
        .build();
    let download = server.mock(|when, then| {
        when.method(httpmock::Method::GET).path("/complete.tar.gz");
        then.respond_with(move |_| response.clone());
    });
    let overrides = Arc::new(MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mount = "/home/user/.codex/skills/example";
    let (mut outcome, _) = execute_job(
        &factory,
        context(&hash, archive_size, mount, "large"),
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
    // Release the shared archive after every consumer and content assertion.
    download.delete_async().await;
}

#[tokio::test]
async fn home_restored_instruction_reuse_checks_target_and_repairs_missing_or_tainted_files() {
    use crate::home_image_cache::HomeImageCache;
    use runner_host::paths::RunnerPaths;
    use runner_types::storage_fingerprints::StorageFingerprint;

    for state in [
        "present",
        "missing",
        "tainted",
        "other-framework",
        "unsafe",
        "invalid-probe",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let (mut config, _api) = test_executor_config_with_startup_api(directory.path()).await;
        let paths = RunnerPaths::new(directory.path().join("runner"));
        let home = HomeImageCache::new(paths.clone());
        config.home_cache = Some(home.clone());
        let bytes = archive(&[(SOURCE_FILENAME, b"published instructions")]);
        let hash = hex::encode(Sha256::digest(&bytes));
        let mut current =
            instruction_context(&hash, bytes.len() as u64, "codex", "home-instructions");
        current.run_id = runner_types::ids::RunId::new_v4();
        let session = "22222222-2222-4222-8222-222222222222";
        current.reuse_key = Some(format!("thread:home-cache-{session}"));
        current.native_continuation = Some(guest_contracts::env::NativeContinuation {
            session_id: Some(session.into()),
            generation_run_id: Some(current.run_id.to_string()),
            recovery_prompt: None,
        });
        let mut fingerprints = current.storage_fingerprints();
        if state == "other-framework" {
            fingerprints =
                instruction_context(&hash, bytes.len() as u64, "claude-code", "old-framework")
                    .storage_fingerprints();
        }
        if state == "tainted" {
            fingerprints.storages.insert(
                current
                    .instruction_file
                    .as_ref()
                    .unwrap()
                    .storage_mount
                    .clone(),
                StorageFingerprint::tainted(),
            );
        }
        seed_home_image_cache_with_fingerprints(&home, &paths, session, 16, &fingerprints).await;
        let guest = tempfile::tempdir().unwrap();
        let target = guest_path(guest.path(), "/home/user/.codex/AGENTS.md");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(
            target.parent().unwrap().join("native-history"),
            b"preserved",
        )
        .unwrap();
        if state == "unsafe" {
            let outside = guest.path().join("external.md");
            fs::write(&outside, b"outside").unwrap();
            std::os::unix::fs::symlink(outside, &target).unwrap();
        } else if state != "missing" {
            fs::write(&target, b"local Home edit").unwrap();
        }
        if matches!(state, "missing" | "tainted" | "other-framework") {
            let cache = config
                .home
                .storage_cache_dir(INSTRUCTION_STORAGE_NAME, &hash);
            fs::create_dir_all(&cache).unwrap();
            fs::write(cache.join("archive.tar.gz"), &bytes).unwrap();
        }
        let overrides = Arc::new(MockSandboxOverrides::new());
        if state == "invalid-probe" {
            overrides.add_exec_result_matcher(
                " --instructions-check-stdin",
                sandbox::ExecResult::new(0, b"invalid".to_vec(), Vec::new()),
            );
        } else if !matches!(state, "tainted" | "other-framework") {
            instruction_check(&overrides, guest.path(), "codex");
        }
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
        if let Some(report) = outcome.startup_report.take() {
            report.finish().await;
        }
        if matches!(state, "unsafe" | "invalid-probe") {
            assert_ne!(outcome.exit_code(), 0);
            assert!(overrides.start_agent_process_calls().is_empty());
            assert!(overrides.storage_manifest_calls().is_empty());
            if state == "unsafe" {
                assert_eq!(
                    fs::read(guest.path().join("external.md")).unwrap(),
                    b"outside"
                );
            }
        } else {
            assert_eq!(outcome.exit_code(), 0, "{:?}", outcome.error());
            assert_eq!(
                outcome.home_reuse_result,
                Some(runner_types::types::HomeReuseResult::Reused)
            );
            apply_guest_storage(&overrides, guest.path(), 0, None);
            apply_guest_instructions(&overrides, guest.path(), 0);
            if state == "present" {
                assert_eq!(fs::read(&target).unwrap(), b"local Home edit");
                assert!(overrides.storage_manifest_calls().is_empty());
                assert!(
                    !overrides
                        .agent_instructions_calls()
                        .iter()
                        .any(|call| call.operation == InstructionOperation::Apply)
                );
                assert!(
                    !config
                        .home
                        .storage_cache_dir(INSTRUCTION_STORAGE_NAME, &hash)
                        .join("archive.tar.gz")
                        .exists()
                );
            } else {
                assert_eq!(fs::read(&target).unwrap(), b"published instructions");
            }
        }
        assert_eq!(
            fs::read(target.parent().unwrap().join("native-history")).unwrap(),
            b"preserved"
        );
        config.background_fill.shutdown().await;
        config.decoded_cache.shutdown().await;
    }
}

#[tokio::test]
async fn instruction_reuse_reapplies_after_storage_reconciles_its_parent() {
    use runner_types::storage_fingerprints::StorageFingerprint;

    for changed_parent in [true, false] {
        let directory = tempfile::tempdir().unwrap();
        let (config, _api) = test_executor_config_with_startup_api(directory.path()).await;
        let guest = tempfile::tempdir().unwrap();
        let instructions = archive(&[(SOURCE_FILENAME, b"published instructions")]);
        let hash = hex::encode(Sha256::digest(&instructions));
        let settings = archive(&[
            ("config.toml", b"settings"),
            ("native-history", b"preserved"),
        ]);
        for (name, version, bytes) in [
            (INSTRUCTION_STORAGE_NAME, hash.as_str(), &instructions),
            ("framework-settings", "v1", &settings),
            ("framework-settings", "v2", &settings),
        ] {
            let cache = config.home.storage_cache_dir(name, version);
            fs::create_dir_all(&cache).unwrap();
            fs::write(cache.join("archive.tar.gz"), bytes).unwrap();
        }
        let make_context = |version: Option<&str>| {
            let mut current =
                instruction_context(&hash, instructions.len() as u64, "codex", "instructions");
            current.run_id = runner_types::ids::RunId::new_v4();
            if let Some(version) = version {
                current.storage_manifest.as_mut().unwrap().storages.push(
                    super::support::api_storage(
                        "framework-settings",
                        "/home/user/.codex",
                        version,
                        "https://unreachable.invalid/settings",
                    ),
                );
            }
            current
        };
        let overrides = Arc::new(MockSandboxOverrides::new());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let (mut first, _) = execute_job(
            &factory,
            make_context(Some("v1")),
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::NoReuseKey,
            },
            &config,
            &default_params(),
            CancellationToken::new(),
        )
        .await;
        assert_eq!(first.exit_code(), 0, "{:?}", first.error());
        if let Some(report) = first.startup_report.take() {
            report.finish().await;
        }
        apply_guest_storage(&overrides, guest.path(), 0, None);
        apply_guest_instructions(&overrides, guest.path(), 0);
        let target = guest_path(guest.path(), "/home/user/.codex/AGENTS.md");
        assert_eq!(fs::read(&target).unwrap(), b"published instructions");
        let mut previous = first.storage_fingerprints;
        if !changed_parent {
            previous
                .storages
                .insert("/home/user/.codex".into(), StorageFingerprint::tainted());
        }
        let (idle, _lease) = make_reusable_idle_sandbox_with_fingerprints(
            first.sandbox.take().unwrap(),
            first.source_ip,
            "instruction-parent-reconciliation",
            previous,
        )
        .await;
        instruction_check(&overrides, guest.path(), "codex");
        let first_storage = overrides.storage_manifest_calls().len();
        let first_exec = overrides.agent_instructions_calls().len();
        let (mut next, _) = execute_job_reuse(
            idle,
            make_context(changed_parent.then_some("v2")),
            &config,
            &default_params(),
            CancellationToken::new(),
        )
        .await;
        assert_eq!(next.exit_code(), 0, "{:?}", next.error());
        if let Some(report) = next.startup_report.take() {
            report.finish().await;
        }
        apply_guest_storage(&overrides, guest.path(), first_storage, None);
        apply_guest_instructions(&overrides, guest.path(), first_exec);
        assert_eq!(fs::read(&target).unwrap(), b"published instructions");
        assert_eq!(
            fs::read(target.parent().unwrap().join("native-history")).unwrap(),
            b"preserved"
        );
        config.background_fill.shutdown().await;
        config.decoded_cache.shutdown().await;
    }
}

#[tokio::test]
async fn instruction_reuse_repairs_equivalent_parent_paths() {
    instruction_reuse_with_parent_reconciliation(InstructionParentCase::ReplacedAlias).await;
}

#[tokio::test]
async fn instruction_reuse_repairs_preserved_symlink_alias_writes() {
    instruction_reuse_with_parent_reconciliation(InstructionParentCase::ReplacedSymlink).await;
}

#[tokio::test]
async fn instruction_reuse_checks_all_preserved_mounts_in_bounded_guest_requests() {
    let directory = tempfile::tempdir().unwrap();
    let (config, _api) = test_executor_config_with_startup_api(directory.path()).await;
    let guest = tempfile::tempdir().unwrap();
    let home = guest_path(guest.path(), "/home/user");
    let target = home.join(".codex/AGENTS.md");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(&target, b"local instruction edit").unwrap();
    let mut current = instruction_context(&"a".repeat(64), 10, "codex", "instructions");
    current
        .storage_manifest
        .as_mut()
        .unwrap()
        .storages
        .push(super::support::api_storage(
            "home",
            home.to_str().unwrap(),
            "v1",
            "https://unreachable.invalid/home",
        ));
    let previous = current.storage_fingerprints();
    let mounts = (0..128)
        .map(|index| {
            home.join(format!("check-{index}/{}/leaf", "long-prefix/".repeat(70)))
                .to_str()
                .unwrap()
                .to_owned()
        })
        .collect::<Vec<_>>();
    for mount in &mounts {
        current
            .storage_manifest
            .as_mut()
            .unwrap()
            .storages
            .push(super::support::api_storage(
                "settings",
                mount,
                "v2",
                "https://unreachable.invalid/settings",
            ));
    }
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.add_persistent_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: " --instructions-check-stdin".into(),
        exit_code: 0,
        stdout: b"true".to_vec(),
        stderr: Vec::new(),
    });
    let sandbox =
        sandbox_mock::MockSandbox::with_overrides("bounded-check", Arc::clone(&overrides));
    let mut telemetry = super::support::test_telemetry(&config, &current);
    let reused = super::super::storage::check_instruction_reuse(
        &sandbox,
        &current,
        Some(&previous),
        None,
        &mut telemetry,
    )
    .await
    .unwrap();
    assert!(matches!(
        reused,
        super::super::storage::InstructionReuse::Reused
    ));
    let calls = overrides.agent_instructions_calls();
    assert!(calls.len() > 1);
    let mut checked = Vec::new();
    for call in calls {
        let metadata = call.metadata;
        assert!(metadata.len() <= guest_control_proto::MAX_EXEC_STDIN_BYTES);
        assert!(guest_storage_apply::check_agent_instructions(&home, &metadata).unwrap());
        let input: InstructionCheck = serde_json::from_slice(&metadata).unwrap();
        checked.extend(input.preserved_download_mounts);
    }
    assert_eq!(checked, mounts);
    assert_eq!(fs::read(&target).unwrap(), b"local instruction edit");
    assert!(!home.join("check-0").exists());
    config.background_fill.shutdown().await;
    config.decoded_cache.shutdown().await;
}

#[tokio::test]
async fn instruction_reuse_preserves_edits_when_cleanup_replaces_a_symlink_mount() {
    instruction_reuse_with_parent_reconciliation(InstructionParentCase::ReplacedUnpreservedSymlink)
        .await;
}

#[tokio::test]
async fn instruction_reuse_preserves_files_under_cached_parent() {
    instruction_reuse_with_parent_reconciliation(InstructionParentCase::CachedRoot).await;
}

#[tokio::test]
async fn instruction_reuse_preserves_files_with_cached_sibling() {
    instruction_reuse_with_parent_reconciliation(InstructionParentCase::CachedChild).await;
}

enum InstructionParentCase {
    ReplacedAlias,
    ReplacedSymlink,
    ReplacedUnpreservedSymlink,
    CachedRoot,
    CachedChild,
}

async fn instruction_reuse_with_parent_reconciliation(case: InstructionParentCase) {
    let aliased_parent = matches!(&case, InstructionParentCase::ReplacedAlias);
    let preserved_symlink = matches!(&case, InstructionParentCase::ReplacedSymlink);
    let symlink_parent = matches!(
        &case,
        InstructionParentCase::ReplacedSymlink | InstructionParentCase::ReplacedUnpreservedSymlink
    );
    let changed_parent = aliased_parent || symlink_parent;
    let directory = tempfile::tempdir().unwrap();
    let (config, _api) = test_executor_config_with_startup_api(directory.path()).await;
    let guest = tempfile::tempdir().unwrap();
    fs::create_dir_all(guest_path(guest.path(), "/home/user/alias")).unwrap();
    let instructions = archive(&[(SOURCE_FILENAME, b"published instructions")]);
    let hash = hex::encode(Sha256::digest(&instructions));
    let mut settings_files: Vec<(&str, &[u8])> = vec![
        ("config.toml", b"settings"),
        ("native-history", b"preserved"),
    ];
    if symlink_parent {
        settings_files.push(("AGENTS.md", b"other Storage input"));
    }
    let settings = archive(&settings_files);
    let home = archive(&[("parent-data", b"other Storage input")]);
    for (name, version, bytes) in [
        (INSTRUCTION_STORAGE_NAME, hash.as_str(), &instructions),
        ("framework-settings", "v1", &settings),
        ("framework-settings", "v2", &settings),
        ("home-extra", "v1", &home),
    ] {
        let cache = config.home.storage_cache_dir(name, version);
        fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join("archive.tar.gz"), bytes).unwrap();
    }
    let make_context = |first: bool| {
        let mut current =
            instruction_context(&hash, instructions.len() as u64, "codex", "instructions");
        current.run_id = runner_types::ids::RunId::new_v4();
        let manifest = current.storage_manifest.as_mut().unwrap();
        manifest.storages.push(super::support::api_storage(
            "framework-settings",
            if matches!(&case, InstructionParentCase::CachedChild) {
                "/home/user/.codex/memories"
            } else if symlink_parent {
                "/home/user/settings-alias"
            } else if aliased_parent {
                "/home/user/alias/../.codex"
            } else {
                "/home/user/.codex"
            },
            if changed_parent && !first { "v2" } else { "v1" },
            "https://unreachable.invalid/settings",
        ));
        if preserved_symlink || !changed_parent && first {
            manifest.storages.push(super::support::api_storage(
                "home-extra",
                "/home/user",
                "v1",
                "https://unreachable.invalid/home",
            ));
        }
        current
    };
    let overrides = Arc::new(MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let (mut first, _) = execute_job(
        &factory,
        make_context(true),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoReuseKey,
        },
        &config,
        &default_params(),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(first.exit_code(), 0, "{:?}", first.error());
    if let Some(report) = first.startup_report.take() {
        report.finish().await;
    }
    apply_guest_storage(&overrides, guest.path(), 0, None);
    apply_guest_instructions(&overrides, guest.path(), 0);
    let target = guest_path(guest.path(), "/home/user/.codex/AGENTS.md");
    assert_eq!(fs::read(&target).unwrap(), b"published instructions");
    if symlink_parent {
        let alias = guest_path(guest.path(), "/home/user/settings-alias");
        fs::remove_dir_all(&alias).unwrap();
        std::os::unix::fs::symlink(target.parent().unwrap(), alias).unwrap();
    }
    fs::write(
        target.parent().unwrap().join("native-history"),
        b"preserved",
    )
    .unwrap();
    fs::write(&target, b"local instruction edit").unwrap();
    let (idle, _lease) = make_reusable_idle_sandbox_with_fingerprints(
        first.sandbox.take().unwrap(),
        first.source_ip,
        "instruction-effective-parent",
        first.storage_fingerprints,
    )
    .await;
    instruction_check_with_mounts(
        &overrides,
        guest.path(),
        "codex",
        if preserved_symlink {
            &["/home/user/settings-alias"]
        } else {
            &[]
        },
    );
    let first_storage = overrides.storage_manifest_calls().len();
    let first_exec = overrides.agent_instructions_calls().len();
    let (mut next, _) = execute_job_reuse(
        idle,
        make_context(false),
        &config,
        &default_params(),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(next.exit_code(), 0, "{:?}", next.error());
    if symlink_parent {
        let calls = overrides.agent_instructions_calls();
        let check = calls
            .iter()
            .skip(first_exec)
            .find(|call| call.operation == InstructionOperation::Check)
            .unwrap();
        let input: InstructionCheck = serde_json::from_slice(&check.metadata).unwrap();
        assert_eq!(
            input.preserved_download_mounts,
            if preserved_symlink {
                vec!["/home/user/settings-alias"]
            } else {
                Vec::<&str>::new()
            }
        );
    }
    if let Some(report) = next.startup_report.take() {
        report.finish().await;
    }
    apply_guest_storage(&overrides, guest.path(), first_storage, None);
    apply_guest_instructions(&overrides, guest.path(), first_exec);
    assert_eq!(
        fs::read(&target).expect("the final instruction file must remain available"),
        if aliased_parent || preserved_symlink {
            b"published instructions".as_slice()
        } else {
            b"local instruction edit".as_slice()
        }
    );
    assert_eq!(
        fs::read(target.parent().unwrap().join("native-history")).unwrap(),
        b"preserved"
    );
    config.background_fill.shutdown().await;
    config.decoded_cache.shutdown().await;
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
        StorageFingerprint::new(WORKFLOW_STORAGE_NAME, &hash),
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
async fn failed_workflow_storage_application_prevents_agent_spawn() {
    let directory = tempfile::tempdir().unwrap();
    let (config, _api) = test_executor_config_with_startup_api(directory.path()).await;
    let bytes = archive(&[("SKILL.md", b"current")]);
    let hash = hex::encode(Sha256::digest(&bytes));
    let cache = config.home.storage_cache_dir(WORKFLOW_STORAGE_NAME, &hash);
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
