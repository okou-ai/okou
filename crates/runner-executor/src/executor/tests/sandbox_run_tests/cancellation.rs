use super::*;
use crate::executor::tests::support::{
    RUN_IN_SANDBOX_TEST_TIMEOUT, make_reusable_idle_sandbox_with_fingerprints,
};
use crate::executor::{
    ExecutionHooks, ReusedSandboxDispatch, SandboxReuseDisposition, SandboxReuseTerminal,
    execute_job_reuse_with_hooks,
};
use crate::storage_fingerprints::{StorageFingerprint, StorageFingerprints};
use httpmock::MockServer;
use runner_provider::RunCancellationHandle;

#[tokio::test]
async fn cancellation_before_storage_apply_reconciles_inputs_on_the_next_reused_run() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _startup_api) = test_executor_config_with_startup_api(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let restore_gate = MockLifecycleGate::new();
    overrides.set_guest_state_restore_lifecycle_gate(restore_gate.clone());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let source_ip = sandbox.source_ip().to_string();
    let previous = StorageFingerprints {
        storages: HashMap::from([
            (
                "/data".into(),
                StorageFingerprint::new("reused-archive", "v1"),
            ),
            (
                "/removed-storage".into(),
                StorageFingerprint::new("removed", "v1"),
            ),
        ]),
        artifacts: HashMap::from([(
            "/removed-artifact".into(),
            StorageFingerprint::new("old-output", "v1"),
        )]),
    };
    let (idle, _lease) =
        make_reusable_idle_sandbox_with_fingerprints(sandbox, source_ip, "test-session", previous)
            .await;

    let server = MockServer::start_async().await;
    let body = storage_archive(b"replacement contents");
    let archive_dir = config.home.storage_cache_dir("reused-archive", "v2");
    tokio::fs::create_dir_all(&archive_dir).await.unwrap();
    tokio::fs::write(archive_dir.join("archive.tar.gz"), &body)
        .await
        .unwrap();
    let mut context = minimal_context();
    let mut storage = api_storage("reused-archive", "/data", "v2", &server.url("/archive"));
    storage.archive_size = Some(body.len() as u64);
    context.storage_manifest = Some(StorageManifest {
        storages: vec![storage],
        artifacts: Vec::new(),
    });
    let mut next_context = minimal_context();
    next_context.run_id = RunId::new_v4();
    next_context.storage_manifest = context.storage_manifest.clone();
    let params = default_params();
    let cancellation = RunCancellationHandle::new();
    let execution = execute_job_reuse_with_hooks(
        ReusedSandboxDispatch {
            factory: &factory,
            idle_sandbox: idle,
            reuse_result: SandboxReuseResult::Reused,
        },
        context,
        &config,
        &params,
        cancellation.signals(),
        ExecutionHooks::none(),
    );
    tokio::pin!(execution);
    tokio::select! {
        _ = &mut execution => panic!("Run finished before guest-state restoration"),
        entered = restore_gate.wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT) => entered.unwrap(),
    };
    cancellation.request_cooperative_user_cancellation().await;
    restore_gate.release_one();
    let (mut cancelled, _) = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, execution)
        .await
        .unwrap();
    assert_eq!(cancelled.exit_code(), EXIT_SIGKILL);
    assert_eq!(
        cancelled.sandbox_reuse_disposition,
        SandboxReuseDisposition::Eligible(SandboxReuseTerminal::CooperativeCancellation)
    );
    assert!(overrides.storage_manifest_calls().is_empty());

    let (idle, _next_lease) = make_reusable_idle_sandbox_with_fingerprints(
        cancelled.sandbox.take().unwrap(),
        cancelled.source_ip,
        "test-session",
        cancelled.storage_fingerprints,
    )
    .await;
    restore_gate.release_one();
    let (next, _) = tokio::time::timeout(
        RUN_IN_SANDBOX_TEST_TIMEOUT,
        execute_job_reuse(
            idle,
            next_context,
            &config,
            &params,
            tokio_util::sync::CancellationToken::new(),
        ),
    )
    .await
    .unwrap();
    assert_eq!(next.exit_code(), 0, "{:?}", next.error());
    assert!(next.storage_fingerprints.storages["/data"].matches("reused-archive", "v2"));

    let calls = overrides.storage_manifest_calls();
    let mut cleanup_paths = Vec::new();
    let mut requested_storages = Vec::new();
    for call in &calls {
        let json = if call
            .manifest_json
            .starts_with(guest_contracts::storage_files::INPUT_MAGIC)
        {
            guest_contracts::storage_files::split_input(&call.manifest_json)
                .unwrap()
                .0
        } else {
            call.manifest_json.as_slice()
        };
        let manifest: guest_contracts::storage_manifest::Manifest =
            serde_json::from_slice(json).unwrap();
        cleanup_paths.extend(manifest.cleanup_paths);
        requested_storages.extend(manifest.storages);
    }
    let data = requested_storages
        .iter()
        .find(|storage| storage.mount_path == "/data")
        .expect("the next Run must deliver the unapplied version");
    assert!(!data.cached, "the previous Run never applied this version");
    assert_eq!(data.vas_version_id.as_deref(), Some("v2"));
    for path in ["/data", "/removed-storage", "/removed-artifact"] {
        assert!(
            cleanup_paths.iter().any(|p| p == path),
            "missing cleanup: {path}"
        );
    }
}
