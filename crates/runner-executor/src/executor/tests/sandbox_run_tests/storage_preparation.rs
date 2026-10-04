//! Production executor entry coverage with external Sandbox/registry boundaries.
use super::*;
use tokio_util::sync::CancellationToken;

async fn cached_context(
    config: &crate::executor::ExecutorConfig,
) -> runner_types::types::ExecutionContext {
    let archive = storage_archive(b"selected immutable content");
    let path = config.home.storage_cache_dir("overlap-storage", "v1");
    tokio::fs::create_dir_all(&path).await.unwrap();
    tokio::fs::write(path.join("archive.tar.gz"), &archive)
        .await
        .unwrap();
    drop(
        runner_host::lock::acquire(config.home.storage_lock("overlap-storage", "v1"))
            .await
            .unwrap(),
    );
    let mut context = minimal_context();
    let mut storage = api_storage(
        "overlap-storage",
        "/data",
        "v1",
        "http://127.0.0.1:9/unused.tar.gz",
    );
    storage.archive_size = Some(archive.len() as u64);
    context.storage_manifest = Some(StorageManifest {
        storages: vec![storage],
        artifacts: Vec::new(),
    });
    context
}

#[tokio::test]
async fn execute_job_reuse_stages_without_admitting_guest_apply_before_proxy() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let context = cached_context(&config).await;
    let registry = runner_host::lock::acquire(dir.path().join("proxy-registry.json.lock"))
        .await
        .unwrap();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let writes = MockLifecycleGate::new();
    overrides.set_write_file_lifecycle_gate(writes.clone());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ip = sandbox.source_ip().to_string();
    let (idle, _lease) = make_reusable_idle_sandbox(sandbox, ip, "overlap-session").await;
    let task = tokio::spawn(async move {
        execute_job_reuse(
            idle,
            context,
            &config,
            &default_params(),
            CancellationToken::new(),
        )
        .await
    });

    writes
        .wait_entered(1, super::super::support::RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .unwrap();
    assert!(overrides.storage_manifest_calls().is_empty());
    assert!(overrides.start_agent_process_calls().is_empty());
    writes.release_one();
    assert!(
        !task.is_finished(),
        "registration still owns the blocked proxy lock"
    );
    drop(registry);
    let (outcome, _) =
        tokio::time::timeout(super::super::support::RUN_IN_SANDBOX_TEST_TIMEOUT, task)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(outcome.exit_code(), 0, "{:?}", outcome.error());
    let staged = overrides.write_files_calls();
    assert_eq!(
        staged.len(),
        1,
        "the populated plan must not stage a second time"
    );
    assert_eq!(
        staged[0].files[0].content,
        storage_archive(b"selected immutable content")
    );
    let applied = overrides.storage_manifest_calls();
    assert_eq!(applied.len(), 1);
    let manifest: guest_contracts::storage_manifest::Manifest =
        serde_json::from_slice(&applied[0].manifest_json).unwrap();
    assert_eq!(manifest.storages[0].mount_path, "/data");
    assert_eq!(manifest.storages[0].vas_version_id.as_deref(), Some("v1"));
    assert_eq!(
        manifest.storages[0].archive_url.as_deref(),
        Some(format!("file://{}", staged[0].files[0].path).as_str())
    );
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_job_reuse_staging_failure_keeps_cleanup_and_never_starts_guest_apply() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let context = cached_context(&config).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_write_file_result(Err(sandbox_write_file_error("staging failed")));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ip = sandbox.source_ip().to_string();
    let (idle, _lease) = make_reusable_idle_sandbox(sandbox, ip, "failed-staging").await;
    let (outcome, _) = execute_job_reuse(
        idle,
        context,
        &config,
        &default_params(),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(outcome.exit_code(), 1);
    assert!(outcome.error().unwrap().contains("staging failed"));
    assert!(outcome.sandbox.is_some());
    assert!(overrides.storage_manifest_calls().is_empty());
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_job_reuse_proxy_failure_joins_staging_before_returning_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let context = cached_context(&config).await;
    tokio::fs::remove_file(dir.path().join("proxy-registry.json"))
        .await
        .unwrap();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let writes = MockLifecycleGate::new();
    overrides.set_write_file_lifecycle_gate(writes.clone());
    overrides.push_write_file_result(Err(sandbox_write_file_error("staging also failed")));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ip = sandbox.source_ip().to_string();
    let (idle, _lease) = make_reusable_idle_sandbox(sandbox, ip, "failed-proxy").await;
    let task = tokio::spawn(async move {
        execute_job_reuse(
            idle,
            context,
            &config,
            &default_params(),
            CancellationToken::new(),
        )
        .await
    });
    writes
        .wait_entered(1, super::super::support::RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .unwrap();
    assert!(
        !task.is_finished(),
        "a pending Guest write still owns this sandbox"
    );
    writes.release_one();
    let (outcome, _) =
        tokio::time::timeout(super::super::support::RUN_IN_SANDBOX_TEST_TIMEOUT, task)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(outcome.exit_code(), 1);
    assert!(
        outcome
            .error()
            .unwrap()
            .contains("register sandbox in proxy registry")
    );
    assert!(outcome.network_log_session.is_none());
    assert!(outcome.sandbox.is_some());
    assert!(overrides.storage_manifest_calls().is_empty());
    assert!(overrides.start_agent_process_calls().is_empty());
}

#[tokio::test]
async fn execute_job_reuse_cancelled_staging_never_admits_guest_apply() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let context = cached_context(&config).await;
    let registry = runner_host::lock::acquire(dir.path().join("proxy-registry.json.lock"))
        .await
        .unwrap();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let writes = MockLifecycleGate::new();
    overrides.set_write_file_lifecycle_gate(writes.clone());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ip = sandbox.source_ip().to_string();
    let (idle, _lease) = make_reusable_idle_sandbox(sandbox, ip, "cancel-staging").await;
    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();
    let task = tokio::spawn(async move {
        execute_job_reuse(idle, context, &config, &default_params(), task_cancel).await
    });
    writes
        .wait_entered(1, super::super::support::RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .unwrap();
    cancel.cancel();
    writes.release_one();
    drop(registry);
    let (outcome, _) =
        tokio::time::timeout(super::super::support::RUN_IN_SANDBOX_TEST_TIMEOUT, task)
            .await
            .unwrap()
            .unwrap();
    assert_ne!(outcome.exit_code(), 0);
    assert!(overrides.storage_manifest_calls().is_empty());
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_job_fresh_does_not_stage_until_proxy_and_vm_start_complete() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let context = cached_context(&config).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let start = MockLifecycleGate::new();
    let writes = MockLifecycleGate::new();
    overrides.set_start_lifecycle_gate(start.clone());
    overrides.set_write_file_lifecycle_gate(writes.clone());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let task = tokio::spawn(async move {
        execute_job(
            &factory,
            context,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &default_params(),
            CancellationToken::new(),
        )
        .await
    });
    start
        .wait_entered(1, super::super::support::RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .unwrap();
    let registered: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(dir.path().join("proxy-registry.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(registered["sandboxes"].as_object().unwrap().len(), 1);
    assert!(overrides.write_files_calls().is_empty());
    assert!(overrides.storage_manifest_calls().is_empty());
    start.release_one();
    writes
        .wait_entered(1, super::super::support::RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .unwrap();
    assert!(overrides.start_agent_process_calls().is_empty());
    writes.release_one();
    let (outcome, _) =
        tokio::time::timeout(super::super::support::RUN_IN_SANDBOX_TEST_TIMEOUT, task)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(outcome.exit_code(), 0, "{:?}", outcome.error());
    assert_eq!(overrides.write_files_calls().len(), 1);
    assert_eq!(overrides.storage_manifest_calls().len(), 1);
    assert_proxy_registry_empty(dir.path()).await;
}
