use super::*;
use async_trait::async_trait;
use httpmock::prelude::*;
use sha2::{Digest, Sha256};

use crate::executor::session_history_cpu::{SessionHistoryCpuPool, SessionHistoryCpuTestGate};
use crate::executor::tests::support::RUN_IN_SANDBOX_TEST_TIMEOUT;
use crate::executor::{SessionHistoryRestoreFallback, SessionHistoryRestorePlan};
use crate::telemetry::{JobTelemetry, RunnerStartupPath};
use crate::types::{
    ResumeSessionHistory, ResumeSessionHistoryEncoding, ResumeSessionHistoryRef,
    ResumeSessionHistoryRefKind, WorkspaceReuseResult,
};
use crate::workspace_image_cache::{
    WorkspaceImagePrepareLockPolicy, WorkspaceImagePrepareLockTestGate,
    WorkspaceSessionHistorySidecarRepresentation,
};

fn enable_api_start_telemetry(context: &mut crate::types::ExecutionContext) {
    context.api_start_time = Some(chrono::Utc::now().timestamp_millis().max(0) as u64);
}

fn assert_api_to_spawn_path(
    telemetry: &JobTelemetry,
    expected_path: RunnerStartupPath,
    expected_reuse_result: SandboxReuseResult,
) {
    let operations = telemetry.pending_ops_with_runner_startup_snapshot();
    let startup_operations: Vec<_> = operations
        .iter()
        .filter(|operation| operation.action_type == "api_to_spawn")
        .collect();
    let [operation] = startup_operations.as_slice() else {
        panic!("expected one api_to_spawn operation, got {operations:?}");
    };
    assert_eq!(operation.runner_startup_path, Some(expected_path));
    assert_eq!(operation.sandbox_reuse_result, Some(expected_reuse_result));
}

struct MaterializationObservedFactory {
    inner: MockSandboxFactory,
    materialization_gate: SessionHistoryCpuTestGate,
    release_after_create: bool,
}

#[async_trait]
impl SandboxFactory for MaterializationObservedFactory {
    fn name(&self) -> &str {
        self.inner.name()
    }

    fn config_hash(&self) -> String {
        self.inner.config_hash()
    }

    async fn create(&self, config: sandbox::SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
        tokio::time::timeout(
            RUN_IN_SANDBOX_TEST_TIMEOUT,
            self.materialization_gate.wait_entered(),
        )
        .await
        .expect("sidecar CPU materialization should start before sandbox creation");
        let result = self.inner.create(config).await;
        if self.release_after_create {
            self.materialization_gate.release_one();
        }
        result
    }

    async fn destroy(&self, sandbox: Box<dyn Sandbox>) {
        self.inner.destroy(sandbox).await;
    }

    async fn shutdown(&mut self) {
        self.inner.shutdown().await;
    }
}

#[tokio::test]
async fn workspace_sidecar_materialization_overlaps_sandbox_creation() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let materialization_gate = SessionHistoryCpuTestGate::at_entry(1);
    config.session_history_cpu =
        SessionHistoryCpuPool::with_test_gates(1, Some(materialization_gate.clone()), None);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MaterializationObservedFactory {
        inner: MockSandboxFactory::with_overrides(Arc::clone(&overrides)),
        materialization_gate,
        release_after_create: true,
    };
    let server = MockServer::start_async().await;
    let history = br#"{"type":"init"}"#;
    let history_mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/history.blob");
            then.status(200).body(history);
        })
        .await;
    let mut ctx = minimal_context();
    enable_api_start_telemetry(&mut ctx);
    set_reuse_and_session_history_ref(
        &mut ctx,
        "sess-cache-sidecar-overlap",
        history,
        server.url("/history.blob?token=secret"),
    );
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    seed_workspace_image_cache_with_sidecar(
        &cache,
        &runner_paths,
        &ctx,
        params.workspace_disk_mb,
        history,
        WorkspaceSessionHistorySidecarRepresentation::Raw,
    )
    .await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = tokio::time::timeout(
        RUN_IN_SANDBOX_TEST_TIMEOUT,
        execute_new_sandbox_with_prepared_notifier(
            &factory,
            &ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &params,
            &mut telemetry,
            NewSandboxHooks {
                preparation: crate::executor::sandbox_run::FreshPreparation::Initial,
                controls: RunControls::new(tokio_util::sync::CancellationToken::new(), None)
                    .with_session_history_restore_plan(
                        SessionHistoryRestorePlan::DeferredHashBacked {
                            fallback: Some(SessionHistoryRestoreFallback::NonReuse),
                        },
                    ),
                prepared_run_payload: prepare_run_payload_for_run(&ctx).unwrap(),
                sandbox_prepared: None,
            },
        ),
    )
    .await
    .expect("sandbox creation and sidecar materialization should complete")
    .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.workspace_image.is_some());
    assert_eq!(
        outcome.workspace_reuse_result,
        Some(WorkspaceReuseResult::Reused),
    );
    assert_api_to_spawn_path(
        &telemetry,
        RunnerStartupPath::Workspace,
        SandboxReuseResult::PoolMiss,
    );
    assert_eq!(overrides.create_configs().len(), 1);
    let writes = overrides.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].content, history);
    history_mock.assert_calls_async(0).await;
    for action in [
        "session_history_workspace_cache_file_read",
        "session_history_workspace_cache_cpu_pool_wait",
        "session_history_workspace_cache_materialization",
        "session_history_workspace_cache_materialization_wait",
        "session_history_workspace_cache_guest_restore",
        "session_history_workspace_cache_restore",
    ] {
        assert_telemetry_action(&telemetry, action, true, None);
    }
}

#[tokio::test]
async fn workspace_sidecar_probe_miss_falls_back_and_records_reason() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let server = MockServer::start_async().await;
    let history = br#"{"type":"init"}"#;
    let history_mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/history.blob");
            then.status(200).body(history);
        })
        .await;
    let mut ctx = minimal_context();
    set_reuse_and_session_history_ref(
        &mut ctx,
        "sess-cache-sidecar-missing-metadata",
        history,
        server.url("/history.blob?token=secret"),
    );
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    seed_workspace_image_cache_with_sidecar(
        &cache,
        &runner_paths,
        &ctx,
        params.workspace_disk_mb,
        history,
        WorkspaceSessionHistorySidecarRepresentation::Raw,
    )
    .await;
    let cache_key = scoped_workspace_image_cache_key(
        "",
        "vm0/default",
        ctx.reuse_key.as_deref().unwrap(),
        CANONICAL_WORKING_DIR,
        u64::from(params.workspace_disk_mb) * 1024 * 1024,
    );
    tokio::fs::remove_file(
        cache
            .entry_paths(&cache_key)
            .session_history_sidecar_metadata(),
    )
    .await
    .unwrap();
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = tokio::time::timeout(
        RUN_IN_SANDBOX_TEST_TIMEOUT,
        execute_new_sandbox_with_prepared_notifier(
            &factory,
            &ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &params,
            &mut telemetry,
            NewSandboxHooks {
                preparation: crate::executor::sandbox_run::FreshPreparation::Initial,
                controls: RunControls::new(tokio_util::sync::CancellationToken::new(), None)
                    .with_session_history_restore_plan(
                        SessionHistoryRestorePlan::DeferredHashBacked {
                            fallback: Some(SessionHistoryRestoreFallback::NonReuse),
                        },
                    ),
                prepared_run_payload: prepare_run_payload_for_run(&ctx).unwrap(),
                sandbox_prepared: None,
            },
        ),
    )
    .await
    .expect("sandbox creation should fall back from the missing sidecar metadata")
    .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.workspace_image.is_some());
    assert_eq!(
        outcome.workspace_reuse_result,
        Some(WorkspaceReuseResult::Reused),
    );
    assert_eq!(overrides.create_configs().len(), 1);
    let writes = overrides.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].content, history);
    history_mock.assert_calls_async(1).await;
    assert_telemetry_action(
        &telemetry,
        "session_history_workspace_cache_probe",
        true,
        None,
    );
    assert_telemetry_action(
        &telemetry,
        "session_history_workspace_cache_miss",
        true,
        Some("missing"),
    );
}

#[tokio::test]
async fn workspace_retry_cancels_sidecar_materialization_before_cache_invalidation() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let materialization_gate = SessionHistoryCpuTestGate::at_entry(1);
    config.session_history_cpu =
        SessionHistoryCpuPool::with_test_gates(1, Some(materialization_gate.clone()), None);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_create_result(Err(sandbox_create_error("bad seed image")));
    let factory = MaterializationObservedFactory {
        inner: MockSandboxFactory::with_overrides(Arc::clone(&overrides)),
        materialization_gate: materialization_gate.clone(),
        release_after_create: false,
    };
    let server = MockServer::start_async().await;
    let history = br#"{"type":"init"}"#;
    let history_mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/history.blob");
            then.status(200).body(history);
        })
        .await;
    let mut ctx = minimal_context();
    enable_api_start_telemetry(&mut ctx);
    set_reuse_and_session_history_ref(
        &mut ctx,
        "sess-cache-sidecar-retry",
        history,
        server.url("/history.blob?token=secret"),
    );
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let expected_seed = seed_workspace_image_cache_with_sidecar(
        &cache,
        &runner_paths,
        &ctx,
        params.workspace_disk_mb,
        history,
        WorkspaceSessionHistorySidecarRepresentation::Raw,
    )
    .await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = tokio::time::timeout(
        RUN_IN_SANDBOX_TEST_TIMEOUT,
        execute_new_sandbox_with_prepared_notifier(
            &factory,
            &ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &params,
            &mut telemetry,
            NewSandboxHooks {
                preparation: crate::executor::sandbox_run::FreshPreparation::Initial,
                controls: RunControls::new(tokio_util::sync::CancellationToken::new(), None)
                    .with_session_history_restore_plan(
                        SessionHistoryRestorePlan::DeferredHashBacked {
                            fallback: Some(SessionHistoryRestoreFallback::NonReuse),
                        },
                    ),
                prepared_run_payload: prepare_run_payload_for_run(&ctx).unwrap(),
                sandbox_prepared: None,
            },
        ),
    )
    .await
    .expect("workspace retry should cancel and join sidecar materialization")
    .unwrap();

    tokio::time::timeout(
        RUN_IN_SANDBOX_TEST_TIMEOUT,
        materialization_gate.wait_completed(),
    )
    .await
    .expect("cancelled sidecar CPU work should finish");
    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.workspace_image.is_none());
    assert_eq!(
        outcome.workspace_reuse_result,
        Some(WorkspaceReuseResult::SandboxPrepareFallback),
    );
    assert_api_to_spawn_path(
        &telemetry,
        RunnerStartupPath::Cold,
        SandboxReuseResult::PoolMiss,
    );
    assert_eq!(overrides.create_configs().len(), 2);
    assert!(!expected_seed.exists());
    let writes = overrides.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].content, history);
    history_mock.assert_calls_async(1).await;
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_retry_without_workspace_image",
        true,
        None,
    );
    assert_telemetry_action(
        &telemetry,
        "session_history_workspace_cache_miss",
        true,
        Some("sandbox_retry_without_workspace_image"),
    );
}

fn set_reuse_and_session_identity(
    context: &mut crate::types::ExecutionContext,
    session_id: &str,
    session_history: &str,
) {
    context.reuse_key = Some(format!("thread:workspace-cache-{session_id}"));
    context.resume_session = Some(ResumeSession::inline(
        session_id.into(),
        session_history.into(),
    ));
}

fn set_reuse_and_session_history_ref(
    context: &mut crate::types::ExecutionContext,
    session_id: &str,
    history: &[u8],
    url: String,
) {
    context.reuse_key = Some(format!("thread:workspace-cache-{session_id}"));
    context.resume_session = Some(ResumeSession {
        cli_agent_session_id: session_id.into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url,
                encoding: ResumeSessionHistoryEncoding::Identity,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
                download_source: None,
            },
        },
    });
}

#[tokio::test]
async fn workspace_mount_retry_starts_a_new_codex_catalog_prefetch_owner() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_workspace_drive_mount_result(Ok(ExecResult::new(
        64,
        Vec::new(),
        b"cached mount denied".to_vec(),
    )));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = codex_oauth_context();
    let session_id = "00000000-0000-4000-8000-000000023425";
    set_reuse_and_session_identity(&mut ctx, session_id, r#"{"type":"init"}"#);
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    seed_workspace_image_cache(&cache, &runner_paths, session_id, 16).await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.workspace_image.is_none());
    assert_eq!(overrides.create_configs().len(), 2);
    assert_eq!(overrides.destroy_call_count(), 1);
    let start_calls = overrides.start_process_calls();
    assert_eq!(start_calls.len(), 2);
    assert!(start_calls[0].cmd.contains("codex --version"));
    assert!(start_calls[1].cmd.contains("codex --version"));
    let agent_calls = overrides.start_agent_process_calls();
    assert_eq!(agent_calls.len(), 1);
    assert_eq!(
        telemetry
            .pending_ops_snapshot()
            .iter()
            .filter(|(action, _, _)| action == "runner_codex_model_catalog_prefetch")
            .count(),
        2
    );
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn post_write_prefetch_failure_replaces_consumed_cache_hit_with_fresh_workspace() {
    for start_error in [
        SandboxError::OperationTimeout {
            operation: sandbox::SandboxOperation::StartProcess,
            stage: sandbox::SandboxOperationTimeoutStage::AwaitingTerminalResponse,
            timeout_ms: 1_000,
        },
        SandboxError::OperationWrite {
            operation: sandbox::SandboxOperation::StartProcess,
            stage: sandbox::SandboxOperationWriteStage::FrameWrite,
            source: std::io::Error::new(std::io::ErrorKind::BrokenPipe, "partial write"),
        },
    ] {
        let dir = tempfile::tempdir().unwrap();
        let runner_paths = RunnerPaths::new(dir.path().join("runner"));
        let cache = WorkspaceImageCache::new(runner_paths.clone());
        let mut config = test_executor_config(dir.path()).await;
        config.workspace_cache = Some(cache.clone());
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.push_start_process_error(start_error);
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let mut context = codex_oauth_context();
        let session_id = "00000000-0000-4000-8000-000000032219";
        set_reuse_and_session_identity(&mut context, session_id, r#"{"type":"init"}"#);
        let params = JobParams {
            workspace_disk_mb: 16,
            ..default_params()
        };
        let expected_seed = seed_workspace_image_cache(&cache, &runner_paths, session_id, 16).await;
        let mut telemetry = test_telemetry(&config, &context);

        let outcome = execute_new_sandbox(
            &factory,
            &context,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &params,
            &mut telemetry,
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(outcome.exit_code(), 0);
        assert!(outcome.workspace_image.is_none());
        let configs = overrides.create_configs();
        assert_eq!(configs.len(), 2);
        assert_eq!(
            configs[0].workspace_drive,
            Some(sandbox::WorkspaceDriveConfig {
                size_mb: 16,
                seed_image: Some(sandbox::WorkspaceDriveSeedImage::Move(
                    expected_seed.clone(),
                )),
            })
        );
        assert_eq!(
            configs[1].workspace_drive,
            Some(sandbox::WorkspaceDriveConfig {
                size_mb: 16,
                seed_image: None,
            })
        );
        assert!(!expected_seed.exists());
        assert_eq!(overrides.destroy_call_count(), 1);
        assert_eq!(overrides.start_process_calls().len(), 1);
        assert_eq!(overrides.start_agent_process_calls().len(), 1);
        assert_eq!(
            telemetry
                .pending_ops_snapshot()
                .iter()
                .filter(|(action, _, _)| action == "runner_codex_model_catalog_prefetch")
                .count(),
            1
        );
        assert_telemetry_action(
            &telemetry,
            "runner_fresh_sandbox_retry_without_codex_prefetch",
            true,
            None,
        );
        assert_telemetry_action(
            &telemetry,
            "runner_fresh_sandbox_retry_without_workspace_image",
            true,
            None,
        );
        assert_proxy_registry_empty(dir.path()).await;
    }
}

#[tokio::test]
async fn execute_inner_retries_fresh_after_workspace_cache_hit_create_failure() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_create_result(Err(sandbox_create_error("bad seed image")));
    let create_gate = MockLifecycleGate::new();
    overrides.set_create_lifecycle_gate(create_gate.clone());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let server = httpmock::MockServer::start_async().await;
    let body = storage_archive(b"workspace retry archive");
    let full_get = server
        .mock_async(|when, then| {
            when.method(httpmock::Method::GET)
                .path("/workspace-retry.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;
    let mut ctx = minimal_context();
    let mut storage = api_storage(
        "workspace-retry",
        "/data",
        "v1",
        &server.url("/workspace-retry.tar.gz"),
    );
    storage.archive_size = Some(body.len() as u64);
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![storage],
        artifacts: Vec::new(),
    });
    set_reuse_and_session_identity(&mut ctx, "sess-cache-hit", r#"{"type":"init"}"#);
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let expected_seed =
        seed_workspace_image_cache(&cache, &runner_paths, "sess-cache-hit", 16).await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let execution = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    );
    let admission = async {
        create_gate
            .wait_entered(1, Duration::from_secs(5))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while full_get.calls_async().await == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("first archive owner should request before create failure");
        create_gate.release_one();
        create_gate
            .wait_entered(2, Duration::from_secs(5))
            .await
            .unwrap();
        create_gate.release_one();
    };
    let (outcome, ()) = tokio::join!(execution, admission);
    let outcome = outcome.unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.workspace_image.is_none());
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 2);
    assert_eq!(
        configs[0].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 16,
            seed_image: Some(sandbox::WorkspaceDriveSeedImage::Move(
                expected_seed.clone(),
            )),
        })
    );
    assert_eq!(
        configs[1].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 16,
            seed_image: None,
        })
    );
    assert!(
        !expected_seed.exists(),
        "failed cache hit should invalidate the unusable baseline"
    );

    assert_telemetry_action(
        &telemetry,
        "runner_fresh_workspace_image_prepare",
        true,
        None,
    );
    assert_telemetry_action(&telemetry, "workspace_image_cache_hit", true, None);
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_retry_without_workspace_image",
        true,
        None,
    );
    let factory_create_outcomes =
        telemetry_action_outcomes(&telemetry, "runner_fresh_sandbox_factory_create");
    assert_eq!(
        factory_create_outcomes,
        vec![
            (false, Some("sandbox_factory_create_failed".into())),
            (true, None)
        ]
    );
    assert!(
        (1..=2).contains(&full_get.calls_async().await),
        "the cancelled owner may be stopped before its request reaches the fixture"
    );
    let ops = telemetry.pending_ops_snapshot();
    assert_eq!(
        ops.iter()
            .filter(|(action, _, _)| action == "storage_cache_fresh_delivery_single_request")
            .count(),
        2,
        "workspace fallback must replace, not retain, the old owner: {ops:?}"
    );
    assert!(ops.iter().any(|(action, success, _)| {
        action == "storage_cache_fresh_delivery_drained" && *success
    }));
}

#[tokio::test]
async fn execute_inner_dns_readiness_retry_replaces_consumed_workspace_cache_hit() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(SandboxError::GuestDnsReadiness {
        reason: SandboxGuestDnsReadinessReason::DnsPath,
        message: "first attachment failed".into(),
    }));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    set_reuse_and_session_identity(&mut ctx, "sess-cache-dns-retry", r#"{"type":"init"}"#);
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let expected_seed =
        seed_workspace_image_cache(&cache, &runner_paths, "sess-cache-dns-retry", 16).await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let (outcome, events) = capture_sandbox_run_events(execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    ))
    .await;
    let outcome = outcome.unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.workspace_image.is_none());
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 2);
    assert_eq!(
        configs[0].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 16,
            seed_image: Some(sandbox::WorkspaceDriveSeedImage::Move(
                expected_seed.clone(),
            )),
        })
    );
    assert_eq!(
        configs[1].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 16,
            seed_image: None,
        })
    );
    assert!(!expected_seed.exists());
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_dns_readiness_retry",
        true,
        None,
    );
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_retry_without_workspace_image",
        true,
        None,
    );
    let completion = captured_events_named(&events, "guest DNS readiness replacement completed");
    assert_eq!(completion.len(), 1, "events={events:#?}");
    assert_captured_field(completion[0], "success", "true");
    assert_captured_field(completion[0], "workspace_fallback", "true");
}

#[tokio::test]
async fn process_timeout_invalidates_consumed_workspace_cache_without_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(SandboxError::GuestDnsReadiness {
        reason: SandboxGuestDnsReadinessReason::ProcessTimeout,
        message: "guest process timed out".into(),
    }));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let session_id = "sess-cache-dns-process-timeout";
    let mut ctx = minimal_context();
    set_reuse_and_session_identity(&mut ctx, session_id, r#"{"type":"init"}"#);
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let expected_seed =
        seed_workspace_image_cache(&cache, &runner_paths, session_id, params.workspace_disk_mb)
            .await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    let error = result
        .err()
        .expect("guest process timeout must be returned");
    assert!(
        error.to_string().contains("guest process timed out"),
        "got: {error}"
    );
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 1);
    assert_eq!(
        configs[0].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: params.workspace_disk_mb,
            seed_image: Some(sandbox::WorkspaceDriveSeedImage::Move(
                expected_seed.clone(),
            )),
        })
    );
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(overrides.start_process_calls().is_empty());
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(!expected_seed.exists());
    assert_no_telemetry_action(&telemetry, "runner_fresh_sandbox_dns_readiness_retry");
    assert_no_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_retry_without_workspace_image",
    );

    let checkout = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: &params.profile_name,
                reuse_key: Some(&format!("thread:workspace-cache-{session_id}")),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(checkout.result(), WorkspaceCacheCheckoutResult::Miss);
}

#[tokio::test]
async fn dns_replacement_storage_classification_failure_prevents_agent_start() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(SandboxError::GuestDnsReadiness {
        reason: SandboxGuestDnsReadinessReason::DnsPath,
        message: "first attachment failed".into(),
    }));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    let mount_path = format!("{CANONICAL_WORKING_DIR}/data");
    let mut manifest = StorageManifest {
        storages: vec![api_storage(
            "dns-retry-storage",
            &mount_path,
            "v1",
            "https://storage.example/archive.tar.gz",
        )],
        artifacts: Vec::new(),
    };
    manifest.storages[0].archive_size = Some(1);
    let storage_fingerprints =
        crate::storage_fingerprints::StorageFingerprints::from_manifest(&manifest);
    ctx.storage_manifest = Some(manifest);
    set_reuse_and_session_identity(
        &mut ctx,
        "sess-cache-dns-prepare-failure",
        r#"{"type":"init"}"#,
    );
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    seed_workspace_image_cache_with_fingerprints(
        &cache,
        &runner_paths,
        "sess-cache-dns-prepare-failure",
        16,
        &storage_fingerprints,
    )
    .await;
    tokio::fs::write(config.home.locks_dir(), b"not a directory")
        .await
        .unwrap();
    let mut telemetry = test_telemetry(&config, &ctx);

    let (result, events) = capture_sandbox_run_events(execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    ))
    .await;

    let outcome = result.unwrap();
    assert_eq!(outcome.exit_code(), 1);
    assert!(outcome.failure.unwrap().error.contains("lock dir"));
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_eq!(overrides.create_configs().len(), 2,);
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_dns_readiness_retry",
        true,
        None,
    );
    let completion = captured_events_named(&events, "guest DNS readiness replacement completed");
    assert_eq!(completion.len(), 1, "events={events:#?}");
    assert_captured_field(completion[0], "success", "true");
    assert_captured_field(completion[0], "workspace_fallback", "true");
}

#[tokio::test]
async fn execute_inner_cache_hit_retry_requires_completed_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(SandboxError::Start {
        message: "start failed".into(),
    }));
    overrides.push_destroy_panic("simulated destroy panic");
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    set_reuse_and_session_identity(
        &mut ctx,
        "sess-cache-cleanup-uncertain",
        r#"{"type":"init"}"#,
    );
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let _seed =
        seed_workspace_image_cache(&cache, &runner_paths, "sess-cache-cleanup-uncertain", 16).await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    let error = result
        .err()
        .expect("uncertain cleanup must preserve the first preparation failure");
    assert!(error.to_string().contains("start failed"));
    assert_eq!(overrides.create_configs().len(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_retry_without_workspace_image",
        false,
        Some("cleanup_uncertain"),
    );
}

#[tokio::test]
async fn execute_inner_waits_for_transient_workspace_cache_lock() {
    const LOCK_CONTENTION_WATCHDOG: Duration = Duration::from_secs(1);

    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths.clone());
    let prepare_lock_gate = WorkspaceImagePrepareLockTestGate::default();
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(
        cache
            .clone()
            .with_prepare_lock_test_gate(prepare_lock_gate.clone()),
    );
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    let session_id = "sess-cache-transient-lock";
    set_reuse_and_session_identity(&mut ctx, session_id, r#"{"type":"init"}"#);
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let seeded_cache = seed_workspace_image_cache(&cache, &runner_paths, session_id, 16).await;
    let cache_key = scoped_workspace_image_cache_key(
        "",
        &params.profile_name,
        &format!("thread:workspace-cache-{session_id}"),
        CANONICAL_WORKING_DIR,
        u64::from(params.workspace_disk_mb) * 1024 * 1024,
    );
    let held_lock = crate::lock::acquire(crate::paths::workspace_image_cache_lock_path(
        &runner_paths.base_dir().join("locks"),
        &cache_key,
    ))
    .await
    .unwrap();
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = {
        let outcome = tokio::time::timeout(
            RUN_IN_SANDBOX_TEST_TIMEOUT,
            execute_new_sandbox(
                &factory,
                &ctx,
                NewSandboxDispatch {
                    id: SandboxId::new_v4(),
                    reuse_result: SandboxReuseResult::PoolMiss,
                },
                &config,
                &params,
                &mut telemetry,
                tokio_util::sync::CancellationToken::new(),
            ),
        );
        tokio::pin!(outcome);
        tokio::select! {
            () = prepare_lock_gate.wait_entered(LOCK_CONTENTION_WATCHDOG) => {}
            _ = &mut outcome => panic!("sandbox execution ended before workspace cache lock contention"),
        }
        drop(held_lock);
        prepare_lock_gate.release();
        outcome
            .await
            .expect("transient workspace lock wait should remain bounded")
            .unwrap()
    };

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.workspace_image.is_some());
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 1);
    assert_eq!(
        configs[0].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 16,
            seed_image: Some(sandbox::WorkspaceDriveSeedImage::Move(seeded_cache)),
        })
    );

    assert_telemetry_action(
        &telemetry,
        "runner_fresh_workspace_image_prepare",
        true,
        None,
    );
    assert_telemetry_action(&telemetry, "workspace_image_cache_hit", true, None);
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_factory_create",
        true,
        None,
    );
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_proxy_register",
        true,
        None,
    );
    assert_telemetry_action(&telemetry, "runner_fresh_sandbox_start", true, None);
}

#[tokio::test]
async fn execute_inner_immediate_lock_policy_still_consumes_available_cache() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    let session_id = "sess-cache-immediate-lock-policy";
    set_reuse_and_session_identity(&mut ctx, session_id, r#"{"type":"init"}"#);
    let params = JobParams {
        workspace_disk_mb: 16,
        workspace_image_prepare_lock_policy: WorkspaceImagePrepareLockPolicy::ImmediateFallback,
        ..default_params()
    };
    let seeded_cache = seed_workspace_image_cache(&cache, &runner_paths, session_id, 16).await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert_eq!(
        outcome.workspace_reuse_result,
        Some(WorkspaceReuseResult::Reused),
    );
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 1);
    assert_eq!(
        configs[0].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 16,
            seed_image: Some(sandbox::WorkspaceDriveSeedImage::Move(seeded_cache)),
        })
    );
    assert_telemetry_action(&telemetry, "workspace_image_cache_hit", true, None);
}

#[tokio::test]
async fn execute_inner_records_workspace_cache_lock_busy_prepare_telemetry() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    let session_id = "sess-cache-lock-busy-prepare";
    set_reuse_and_session_identity(&mut ctx, session_id, r#"{"type":"init"}"#);
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let cache_key = scoped_workspace_image_cache_key(
        "",
        &params.profile_name,
        &format!("thread:workspace-cache-{session_id}"),
        CANONICAL_WORKING_DIR,
        u64::from(params.workspace_disk_mb) * 1024 * 1024,
    );
    let _held_lock = crate::lock::acquire(crate::paths::workspace_image_cache_lock_path(
        &runner_paths.base_dir().join("locks"),
        &cache_key,
    ))
    .await
    .unwrap();
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = tokio::time::timeout(
        RUN_IN_SANDBOX_TEST_TIMEOUT,
        execute_new_sandbox(
            &factory,
            &ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &params,
            &mut telemetry,
            tokio_util::sync::CancellationToken::new(),
        ),
    )
    .await
    .expect("persistent workspace lock wait should remain bounded")
    .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    let configs = overrides.create_configs();
    assert_eq!(
        outcome.workspace_reuse_result,
        Some(WorkspaceReuseResult::LockBusy),
    );
    assert_eq!(configs.len(), 1);
    assert_eq!(
        configs[0].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 16,
            seed_image: None,
        })
    );
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_workspace_image_prepare",
        false,
        Some("workspace_image_prepare_lock_busy"),
    );
    assert_telemetry_action(&telemetry, "workspace_image_cache_lock_busy", true, None);
    assert!(telemetry.pending_ops_with_outcome_snapshot().contains(&(
        "workspace_image_cache_lock_busy".into(),
        true,
        Some("busy".into()),
        Some("unknown".into()),
    )));
}

#[tokio::test]
async fn execute_inner_logs_workspace_cache_lock_error_separately() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    let session_id = "sess-cache-lock-error-prepare";
    set_reuse_and_session_identity(&mut ctx, session_id, r#"{"type":"init"}"#);
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let cache_key = scoped_workspace_image_cache_key(
        "",
        &params.profile_name,
        &format!("thread:workspace-cache-{session_id}"),
        CANONICAL_WORKING_DIR,
        u64::from(params.workspace_disk_mb) * 1024 * 1024,
    );
    let lock_path = crate::paths::workspace_image_cache_lock_path(
        &runner_paths.base_dir().join("locks"),
        &cache_key,
    );
    tokio::fs::create_dir_all(lock_path.parent().unwrap())
        .await
        .unwrap();
    let lock_target = dir.path().join("lock-target");
    tokio::fs::write(&lock_target, b"not a lock").await.unwrap();
    std::os::unix::fs::symlink(lock_target, lock_path).unwrap();
    let mut telemetry = test_telemetry(&config, &ctx);

    let (outcome, events) = capture_sandbox_run_events(tokio::time::timeout(
        RUN_IN_SANDBOX_TEST_TIMEOUT,
        execute_new_sandbox(
            &factory,
            &ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &params,
            &mut telemetry,
            tokio_util::sync::CancellationToken::new(),
        ),
    ))
    .await;
    let outcome = outcome
        .expect("workspace lock errors should return without waiting for the contention timeout")
        .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 1);
    assert_eq!(
        configs[0].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 16,
            seed_image: None,
        })
    );
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_workspace_image_prepare",
        false,
        Some("workspace_image_prepare_lock_busy"),
    );
    assert!(telemetry.pending_ops_with_outcome_snapshot().contains(&(
        "workspace_image_cache_lock_busy".into(),
        true,
        Some("unavailable".into()),
        None,
    )));
    let errors = captured_events_named(
        &events,
        "workspace image cache lock unavailable; using fresh workspace image",
    );
    assert_eq!(errors.len(), 1, "events={events:#?}");
    assert!(errors[0].fields.contains_key("error"));
    assert!(
        captured_events_named(
            &events,
            "workspace image cache lock remained busy; using fresh workspace image",
        )
        .is_empty(),
        "events={events:#?}"
    );
}

#[tokio::test]
async fn execute_inner_does_not_retry_workspace_cache_hit_after_proxy_register_failure() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let materialization_gate = SessionHistoryCpuTestGate::at_entry(1);
    config.session_history_cpu =
        SessionHistoryCpuPool::with_test_gates(1, Some(materialization_gate.clone()), None);
    tokio::fs::remove_file(dir.path().join("proxy-registry.json"))
        .await
        .unwrap();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MaterializationObservedFactory {
        inner: MockSandboxFactory::with_overrides(Arc::clone(&overrides)),
        materialization_gate: materialization_gate.clone(),
        release_after_create: false,
    };
    let server = MockServer::start_async().await;
    let history = br#"{"type":"init"}"#;
    let history_mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/history.blob");
            then.status(200).body(history);
        })
        .await;
    let mut ctx = minimal_context();
    set_reuse_and_session_history_ref(
        &mut ctx,
        "sess-register-fail",
        history,
        server.url("/history.blob?token=secret"),
    );
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let expected_seed = seed_workspace_image_cache_with_sidecar(
        &cache,
        &runner_paths,
        &ctx,
        params.workspace_disk_mb,
        history,
        WorkspaceSessionHistorySidecarRepresentation::Raw,
    )
    .await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = tokio::time::timeout(
        RUN_IN_SANDBOX_TEST_TIMEOUT,
        execute_new_sandbox_with_prepared_notifier(
            &factory,
            &ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &params,
            &mut telemetry,
            NewSandboxHooks {
                preparation: crate::executor::sandbox_run::FreshPreparation::Initial,
                controls: RunControls::new(tokio_util::sync::CancellationToken::new(), None)
                    .with_session_history_restore_plan(
                        SessionHistoryRestorePlan::DeferredHashBacked {
                            fallback: Some(SessionHistoryRestoreFallback::NonReuse),
                        },
                    ),
                prepared_run_payload: prepare_run_payload_for_run(&ctx).unwrap(),
                sandbox_prepared: None,
            },
        ),
    )
    .await
    .expect("proxy registration failure should drop the local materializer");

    tokio::time::timeout(
        RUN_IN_SANDBOX_TEST_TIMEOUT,
        materialization_gate.wait_completed(),
    )
    .await
    .expect("restore-plan drop should cancel blocked sidecar CPU work");

    assert!(
        result.is_err(),
        "proxy registration failure must return an error"
    );
    let err = result.err().unwrap();
    assert!(
        err.to_string()
            .contains("register sandbox in proxy registry"),
        "got: {err}"
    );
    assert_eq!(
        overrides.create_configs().len(),
        1,
        "proxy registration failure must not retry with a fresh workspace image"
    );
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(
        overrides.start_agent_process_calls().is_empty(),
        "agent must not start when proxy registry registration fails"
    );
    assert!(
        expected_seed.exists(),
        "proxy registration failure must not invalidate the unrelated workspace cache hit"
    );
    history_mock.assert_calls_async(0).await;
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_factory_create",
        true,
        None,
    );
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_proxy_register",
        false,
        Some("sandbox_proxy_register_failed"),
    );
    assert_no_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_retry_without_workspace_image",
    );
}

#[tokio::test]
async fn execute_job_reuse_uses_workspace_cache_when_configured() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths);
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-reuse-default";
    let factory = MockSandboxFactory::new();
    let sandbox = factory
        .create(sandbox::SandboxConfig {
            id: SandboxId::new_v4(),
            resources: sandbox::ResourceLimits {
                cpu_count: params.vcpu,
                memory_mb: params.memory_mb,
            },
            device_rate_limits: params.device_rate_limits.clone(),
            workspace_drive: None,
        })
        .await
        .expect("create sandbox");
    let source_ip = sandbox.source_ip().to_owned();
    let (idle_sandbox, _lease) = make_reusable_idle_sandbox(sandbox, source_ip, session_id).await;

    let mut ctx = minimal_context();
    enable_api_start_telemetry(&mut ctx);
    set_reuse_and_session_identity(&mut ctx, session_id, r#"{"type":"init"}"#);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 0);
    assert!(reuse_outcome.workspace_image.is_some());
    assert_eq!(
        reuse_outcome.workspace_reuse_result,
        Some(WorkspaceReuseResult::SandboxReused),
    );
    assert_api_to_spawn_path(
        &telemetry,
        RunnerStartupPath::Sandbox,
        SandboxReuseResult::Reused,
    );

    let checkout = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: &params.profile_name,
                reuse_key: Some(&format!("thread:workspace-cache-{session_id}")),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(checkout.result(), WorkspaceCacheCheckoutResult::LockBusy);
}

#[tokio::test]
async fn cached_reuse_workspace_promotion_identity_mismatch_stops_before_agent() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let promotion_params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let current_params = JobParams {
        workspace_disk_mb: 32,
        ..default_params()
    };
    let session_id = "sess-cache-reuse-identity-mismatch";
    let (idle_sandbox, current_image, overrides) = reusable_idle_sandbox_with_workspace_promotion(
        &cache,
        &runner_paths,
        &promotion_params,
        session_id,
    )
    .await;

    let mut ctx = minimal_context();
    set_reuse_and_session_identity(&mut ctx, session_id, r#"{"type":"init"}"#);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &current_params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.workspace_image.is_none());
    let error = reuse_outcome.error().expect("error should be set");
    assert!(error.contains("workspace promotion identity mismatch"));
    assert!(!error.contains(session_id));
    assert!(
        overrides.start_agent_process_calls().is_empty(),
        "agent must not start after workspace promotion identity mismatch"
    );
    assert!(
        !current_image.exists(),
        "identity mismatch must explicitly abandon the consumed cache hit"
    );
    let checkout = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: &promotion_params.profile_name,
                reuse_key: Some(&format!("thread:workspace-cache-{session_id}")),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(promotion_params.workspace_disk_mb) * 1024 * 1024,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(checkout.result(), WorkspaceCacheCheckoutResult::Miss);
}

#[tokio::test]
async fn execute_job_reuse_without_workspace_cache_config_invalidates_held_cache_entry() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths.clone());
    let config = test_executor_config(dir.path()).await;
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-unconfigured-reuse";
    let (idle_sandbox, _current_image, _overrides) =
        reusable_idle_sandbox_with_workspace_promotion(&cache, &runner_paths, &params, session_id)
            .await;

    let mut ctx = minimal_context();
    set_reuse_and_session_identity(&mut ctx, session_id, r#"{"type":"init"}"#);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;
    assert_eq!(reuse_outcome.exit_code(), 0);

    let checkout = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: &params.profile_name,
                reuse_key: Some(&format!("thread:workspace-cache-{session_id}")),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(checkout.result(), WorkspaceCacheCheckoutResult::Miss);
}

#[tokio::test]
async fn unconfigured_cache_reuse_stops_when_cache_invalidation_fails() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths.clone());
    let config = test_executor_config(dir.path()).await;
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-unconfigured-reuse-invalidate-error";
    let (idle_sandbox, overrides) = reusable_idle_sandbox_with_fresh_workspace_promotion(
        &cache,
        &runner_paths,
        &params,
        session_id,
    )
    .await;
    let cache_key = scoped_workspace_image_cache_key(
        "",
        &params.profile_name,
        &format!("thread:workspace-cache-{session_id}"),
        CANONICAL_WORKING_DIR,
        u64::from(params.workspace_disk_mb) * 1024 * 1024,
    );
    let current_image = cache.entry_paths(&cache_key).current_image().to_path_buf();
    tokio::fs::create_dir_all(current_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::create_dir(&current_image).await.unwrap();

    let mut ctx = minimal_context();
    set_reuse_and_session_identity(&mut ctx, session_id, r#"{"type":"init"}"#);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    assert!(reuse_outcome.sandbox.is_some());
    assert!(
        reuse_outcome
            .error()
            .unwrap()
            .contains("failed to invalidate workspace image cache before unconfigured-cache reuse")
    );
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| call.cmd.contains("prepare-for-reuse")),
        "reused sandbox must not run after stale cache invalidation fails"
    );
}

#[tokio::test]
async fn cached_reuse_validation_failure_keeps_workspace_cache_hidden() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-reuse-validation-failure";
    let (idle_sandbox, _current_image, overrides) =
        reusable_idle_sandbox_with_workspace_promotion(&cache, &runner_paths, &params, session_id)
            .await;

    let mut ctx = minimal_context();
    set_reuse_and_session_identity(&mut ctx, session_id, r#"{"type":"init"}"#);
    ctx.environment = Some(HashMap::from([(
        "OPENAI_API_KEY".into(),
        "sk-proj-real-openai-secret".into(),
    )]));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.workspace_image.is_some());
    assert!(
        overrides.start_agent_process_calls().is_empty(),
        "reused sandbox must not start a process after env validation failure"
    );

    let checkout = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: &params.profile_name,
                reuse_key: Some(&format!("thread:workspace-cache-{session_id}")),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(
        checkout.result(),
        WorkspaceCacheCheckoutResult::LockBusy,
        "pre-run validation failure must not release the hidden cache baseline before finalization can promote or invalidate the live workspace"
    );
}

#[tokio::test]
async fn cached_reuse_invalid_resume_session_keeps_existing_workspace_cache_hidden() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-reuse-invalid-resume";
    let (idle_sandbox, _current_image, overrides) =
        reusable_idle_sandbox_with_workspace_promotion(&cache, &runner_paths, &params, session_id)
            .await;

    let raw_session_id = "../invalid-resume";
    let mut ctx = minimal_context();
    set_reuse_and_session_identity(&mut ctx, raw_session_id, r#"{"type":"init"}"#);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    let error = reuse_outcome.error().unwrap();
    assert!(error.contains("invalid session_id"));
    assert!(!error.contains(raw_session_id));
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.workspace_image.is_some());
    assert!(
        overrides.start_agent_process_calls().is_empty(),
        "reused sandbox must not start a process after resume session validation failure"
    );

    let checkout = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: &params.profile_name,
                reuse_key: Some(&format!("thread:workspace-cache-{session_id}")),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(
        checkout.result(),
        WorkspaceCacheCheckoutResult::LockBusy,
        "invalid resume sessions must not release the hidden cache baseline before finalization can promote or invalidate the live workspace"
    );
}

#[tokio::test]
async fn cached_reuse_invalid_resume_session_without_promotion_skips_workspace_lease() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(runner_paths);
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache);
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-reuse-invalid-resume-no-promotion";
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let sandbox = factory
        .create(sandbox::SandboxConfig {
            id: SandboxId::new_v4(),
            resources: sandbox::ResourceLimits {
                cpu_count: params.vcpu,
                memory_mb: params.memory_mb,
            },
            device_rate_limits: params.device_rate_limits.clone(),
            workspace_drive: None,
        })
        .await
        .expect("create sandbox");
    let source_ip = sandbox.source_ip().to_owned();
    let (idle_sandbox, _lease) = make_reusable_idle_sandbox(sandbox, source_ip, session_id).await;

    let raw_session_id = "../invalid-resume";
    let mut ctx = minimal_context();
    set_reuse_and_session_identity(&mut ctx, raw_session_id, r#"{"type":"init"}"#);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    let error = reuse_outcome.error().unwrap();
    assert!(error.contains("invalid session_id"));
    assert!(!error.contains(raw_session_id));
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.workspace_image.is_none());
    assert!(
        overrides.start_agent_process_calls().is_empty(),
        "reused sandbox must not start a process after resume session validation failure"
    );
}

async fn reusable_idle_sandbox_with_workspace_promotion(
    cache: &WorkspaceImageCache,
    runner_paths: &RunnerPaths,
    params: &JobParams,
    session_id: &str,
) -> (
    crate::idle_pool::ReusableIdleSandbox,
    PathBuf,
    Arc<sandbox_mock::MockSandboxOverrides>,
) {
    use crate::idle_pool::{
        IdleParkRequest, IdleParkRequestParts, IdlePool, IdlePoolConfig, IdleUnparkResult,
        ParkResult,
    };
    use crate::storage_fingerprints::StorageFingerprints;

    let reuse_key = format!("thread:workspace-cache-{session_id}");
    let current_image =
        seed_workspace_image_cache(cache, runner_paths, session_id, params.workspace_disk_mb).await;

    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: &params.profile_name,
                reuse_key: Some(&reuse_key),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            },
            workspace_drive_required: true,
        })
        .await;
    assert!(lease.is_cache_hit());
    let promotion = lease
        .into_promotion_context(
            crate::workspace_image_cache::WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                restored_session_identity: None,
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: "2026-06-01T00:00:01.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
            },
        )
        .unwrap();

    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher(&overrides);
    let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
        MockSandboxFactory::with_overrides(Arc::clone(&overrides)),
    ));
    let sandbox = factory
        .create(sandbox::SandboxConfig {
            id: sandbox_id,
            resources: sandbox::ResourceLimits {
                cpu_count: params.vcpu,
                memory_mb: params.memory_mb,
            },
            device_rate_limits: params.device_rate_limits.clone(),
            workspace_drive: None,
        })
        .await
        .expect("create sandbox");
    let source_ip = sandbox.source_ip().to_owned();
    let candidate = IdleParkRequest::new(IdleParkRequestParts {
        run_id,
        sandbox,
        factory,
        reuse_key: reuse_key.clone(),
        sandbox_id,
        profile_name: params.profile_name.clone(),
        device_rate_limits: params.device_rate_limits.clone(),
        budget_lease: test_budget_lease(),
        source_ip,
        storage_fingerprints: StorageFingerprints::default(),
        restored_session_identity: None,
        history_generation_run_id: None,
        guest_timezone_intent: crate::guest_timezone::GuestTimezoneIntent::Unknown,
        workspace_image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
        workspace_promotion: Some(promotion),
        handoff: None,
    })
    .park_for_idle()
    .await
    .unwrap_or_else(|failure| {
        let error = failure.into_error();
        panic!("test sandbox should park: {error}");
    })
    .expect_reusable()
    .with_last_completed_at("2026-06-01T00:00:01.000Z".into());

    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let entry = pool.take(&reuse_key).expect("idle entry should exist");
    let idle_sandbox = match entry.try_unpark_for_run(crate::ids::RunId::new_v4()).await {
        IdleUnparkResult::Reused { sandbox, .. } => *sandbox,
        IdleUnparkResult::Failed { error, .. } => {
            panic!("test idle entry should unpark: {error}");
        }
    };

    (idle_sandbox, current_image, overrides)
}

async fn reusable_idle_sandbox_with_fresh_workspace_promotion(
    cache: &WorkspaceImageCache,
    runner_paths: &RunnerPaths,
    params: &JobParams,
    session_id: &str,
) -> (
    crate::idle_pool::ReusableIdleSandbox,
    Arc<sandbox_mock::MockSandboxOverrides>,
) {
    use crate::idle_pool::{
        IdleParkRequest, IdleParkRequestParts, IdlePool, IdlePoolConfig, IdleUnparkResult,
        ParkResult,
    };
    use crate::storage_fingerprints::StorageFingerprints;

    let reuse_key = format!("thread:workspace-cache-{session_id}");
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: &params.profile_name,
                reuse_key: Some(&reuse_key),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
    let active_image = runner_paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&active_image, b"active image")
        .await
        .unwrap();
    let promotion = lease
        .into_promotion_context(
            crate::workspace_image_cache::WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                restored_session_identity: None,
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: "2026-06-01T00:00:01.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
            },
        )
        .unwrap();

    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher(&overrides);
    let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
        MockSandboxFactory::with_overrides(Arc::clone(&overrides)),
    ));
    let sandbox = factory
        .create(sandbox::SandboxConfig {
            id: sandbox_id,
            resources: sandbox::ResourceLimits {
                cpu_count: params.vcpu,
                memory_mb: params.memory_mb,
            },
            device_rate_limits: params.device_rate_limits.clone(),
            workspace_drive: None,
        })
        .await
        .expect("create sandbox");
    let source_ip = sandbox.source_ip().to_owned();
    let candidate = IdleParkRequest::new(IdleParkRequestParts {
        run_id,
        sandbox,
        factory,
        reuse_key: reuse_key.clone(),
        sandbox_id,
        profile_name: params.profile_name.clone(),
        device_rate_limits: params.device_rate_limits.clone(),
        budget_lease: test_budget_lease(),
        source_ip,
        storage_fingerprints: StorageFingerprints::default(),
        restored_session_identity: None,
        history_generation_run_id: None,
        guest_timezone_intent: crate::guest_timezone::GuestTimezoneIntent::Unknown,
        workspace_image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
        workspace_promotion: Some(promotion),
        handoff: None,
    })
    .park_for_idle()
    .await
    .unwrap_or_else(|failure| {
        let error = failure.into_error();
        panic!("test sandbox should park: {error}");
    })
    .expect_reusable()
    .with_last_completed_at("2026-06-01T00:00:01.000Z".into());

    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let entry = pool.take(&reuse_key).expect("idle entry should exist");
    let idle_sandbox = match entry.try_unpark_for_run(crate::ids::RunId::new_v4()).await {
        IdleUnparkResult::Reused { sandbox, .. } => *sandbox,
        IdleUnparkResult::Failed { error, .. } => {
            panic!("test idle entry should unpark: {error}");
        }
    };

    (idle_sandbox, overrides)
}
