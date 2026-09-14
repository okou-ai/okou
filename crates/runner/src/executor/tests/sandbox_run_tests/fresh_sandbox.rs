use super::*;
use crate::error::RunnerError;
use crate::executor::{SandboxReuseDisposition, SandboxReuseTerminal};

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

use async_trait::async_trait;
use sandbox::SandboxConfig;
use tokio_util::sync::CancellationToken;

fn assert_future_pending<T>(future: Pin<&mut impl Future<Output = T>>) {
    let waker = futures_util::task::noop_waker();
    let mut context = Context::from_waker(&waker);
    assert!(matches!(future.poll(&mut context), Poll::Pending));
}

struct CreateGateFactory {
    inner: MockSandboxFactory,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
    create_calls: AtomicUsize,
}

impl CreateGateFactory {
    fn new() -> Self {
        Self {
            inner: MockSandboxFactory::new(),
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
            create_calls: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl SandboxFactory for CreateGateFactory {
    fn name(&self) -> &str {
        self.inner.name()
    }

    fn config_hash(&self) -> String {
        self.inner.config_hash()
    }

    async fn create(&self, config: SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
        self.create_calls.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        self.release.notified().await;
        self.inner.create(config).await
    }

    async fn destroy(&self, sandbox: Box<dyn Sandbox>) {
        self.inner.destroy(sandbox).await;
    }

    async fn shutdown(&mut self) {
        self.inner.shutdown().await;
    }
}

#[tokio::test]
async fn fresh_pre_spawn_admission_cancels_before_factory_create() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let holder_cancel = CancellationToken::new();
    let holder = config
        .pre_spawn_admission
        .acquire(2, &holder_cancel)
        .await
        .unwrap();
    let factory = CreateGateFactory::new();
    let cancel = CancellationToken::new();
    let context = minimal_context();
    let params = default_params();
    let mut telemetry = test_telemetry(&config, &context);
    let mut task = Box::pin(execute_new_sandbox(
        &factory,
        &context,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        cancel.clone(),
    ));

    assert_future_pending(task.as_mut());
    cancel.cancel();
    let result = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap();

    assert!(matches!(result, Err(RunnerError::Cancelled)));
    assert_eq!(factory.create_calls.load(Ordering::SeqCst), 0);
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_pre_spawn_admission_wait",
        false,
        Some("cancelled"),
    );
    drop(holder);
}

#[tokio::test]
async fn fresh_pre_spawn_admission_releases_after_agent_ready() {
    let dir = tempfile::tempdir().unwrap();
    let config = Arc::new(test_executor_config(dir.path()).await);
    let total_tokens = config.pre_spawn_admission.total_tokens();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let start_gate = MockLifecycleGate::new();
    let wait_gate = MockLifecycleGate::new();
    overrides.set_start_process_lifecycle_gate(start_gate.clone());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let task = tokio::spawn({
        let config = Arc::clone(&config);
        async move {
            let context = minimal_context();
            let mut telemetry = test_telemetry(&config, &context);
            let result = execute_new_sandbox(
                &factory,
                &context,
                NewSandboxDispatch {
                    id: SandboxId::new_v4(),
                    reuse_result: SandboxReuseResult::PoolMiss,
                },
                &config,
                &default_params(),
                &mut telemetry,
                CancellationToken::new(),
            )
            .await;
            (result, telemetry)
        }
    });

    start_gate
        .wait_entered(1, Duration::from_secs(2))
        .await
        .unwrap();
    let probe_cancel = CancellationToken::new();
    let mut admission_probe = Box::pin(
        config
            .pre_spawn_admission
            .acquire(total_tokens, &probe_cancel),
    );
    assert_future_pending(admission_probe.as_mut());

    start_gate.release_one();
    wait_gate
        .wait_entered(1, Duration::from_secs(2))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), admission_probe)
        .await
        .expect("fresh admission remained held after Agent ready")
        .unwrap();
    wait_gate.release_one();

    let (result, telemetry) = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.unwrap().exit_code(), 0);
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_pre_spawn_admission_wait",
        true,
        None,
    );
}

fn guest_dns_readiness_failure(
    reason: SandboxGuestDnsReadinessReason,
    message: &str,
) -> SandboxError {
    SandboxError::GuestDnsReadiness {
        reason,
        message: message.to_string(),
    }
}

fn process_start_timeout(stage: sandbox::SandboxOperationTimeoutStage) -> SandboxError {
    SandboxError::OperationTimeout {
        operation: sandbox::SandboxOperation::StartProcess,
        stage,
        timeout_ms: 1_000,
    }
}

#[tokio::test]
async fn execute_inner_happy_path() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let (exit_code, error_msg) =
        run_new_sandbox_status(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();
    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_inner_binds_run_control_before_sandbox_start() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let context = minimal_context();
    let run_id = context.run_id.to_string();

    let (exit_code, error_msg) =
        run_new_sandbox_status(&factory, &context, &config, &default_params())
            .await
            .unwrap();

    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());
    assert_eq!(overrides.run_control_bind_calls(), vec![run_id.clone()]);
    assert_eq!(overrides.start_run_control_ids(), vec![Some(run_id)]);
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_inner_carries_early_codex_catalog_prefetch_into_agent_run() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let (exit_code, error_msg) =
        run_new_sandbox_status(&factory, &codex_oauth_context(), &config, &default_params())
            .await
            .unwrap();

    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());
    let start_calls = overrides.start_process_calls();
    assert_eq!(start_calls.len(), 1);
    assert!(start_calls[0].cmd.contains("codex --version"));
    let agent_calls = overrides.start_agent_process_calls();
    assert_eq!(agent_calls.len(), 1);
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_inner_does_not_prefetch_after_early_guest_state_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_guest_state_restore_result(Ok(sandbox::ExecResult::new(
        64,
        Vec::new(),
        b"restore denied".to_vec(),
    )));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let params = JobParams {
        restore_guest_state: true,
        ..default_params()
    };

    let (exit_code, error_msg) =
        run_new_sandbox_status(&factory, &codex_oauth_context(), &config, &params)
            .await
            .unwrap();

    assert_eq!(exit_code, 1);
    let error = error_msg.expect("guest state failure should fail the run");
    assert!(error.contains("guest state restore failed"), "got: {error}");
    assert!(error.contains("restore denied"), "got: {error}");
    assert!(
        overrides.start_process_calls().is_empty(),
        "neither prefetch nor agent may start after guest state failure"
    );
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn fresh_archive_download_overlaps_blocked_sandbox_create() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = Arc::new(CreateGateFactory::new());
    let server = httpmock::MockServer::start_async().await;
    let body = b"fresh archive".to_vec();
    let full_get = server
        .mock_async(|when, then| {
            when.method(httpmock::Method::GET)
                .path("/fresh-overlap.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;
    let mut ctx = minimal_context();
    let mut storage = api_storage(
        "fresh-overlap",
        "/data",
        "v1",
        &server.url("/fresh-overlap.tar.gz"),
    );
    storage.archive_size = Some(body.len() as u64);
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![storage],
        artifacts: Vec::new(),
    });

    let task = tokio::spawn({
        let factory = Arc::clone(&factory);
        async move {
            let mut telemetry = test_telemetry(&config, &ctx);
            let outcome = execute_new_sandbox(
                factory.as_ref(),
                &ctx,
                NewSandboxDispatch {
                    id: SandboxId::new_v4(),
                    reuse_result: SandboxReuseResult::PoolMiss,
                },
                &config,
                &default_params(),
                &mut telemetry,
                tokio_util::sync::CancellationToken::new(),
            )
            .await;
            (outcome, telemetry)
        }
    });

    tokio::time::timeout(Duration::from_secs(5), factory.entered.notified())
        .await
        .expect("sandbox create should start");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if full_get.calls_async().await == 1 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("runner archive GET should start while sandbox create is blocked");
    assert!(
        !task.is_finished(),
        "sandbox create gate should keep the run from reaching guest download"
    );

    factory.release.notify_one();
    let (outcome, telemetry) = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("run should finish after sandbox create is released")
        .expect("run task should not panic");
    assert_eq!(outcome.unwrap().exit_code(), 0);
    full_get.assert_calls_async(1).await;
    assert_telemetry_action(
        &telemetry,
        "storage_cache_fresh_delivery_staged",
        true,
        None,
    );
}

#[tokio::test]
async fn fresh_archive_planning_failure_records_apply_and_prepare_failures() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
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
        storages: Vec::new(),
        artifacts: vec![artifact],
    });
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    let error = match result {
        Ok(_) => panic!("invalid fresh storage plan should fail"),
        Err(error) => error,
    };
    let error = error.to_string();
    assert!(
        error.contains("storage manifest artifact memory version version-2 is missing archiveUrl"),
        "got: {error}"
    );
    assert!(
        overrides.create_configs().is_empty(),
        "invalid fresh storage plan should fail before sandbox creation"
    );
    assert_telemetry_action(
        &telemetry,
        "runner_storage_manifest_apply",
        false,
        Some(&error),
    );
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_prepare",
        false,
        Some(&error),
    );
}

#[tokio::test]
async fn execute_new_sandbox_notifies_after_successful_prepare() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();
    let ctx = minimal_context();
    let sandbox_id = SandboxId::new_v4();
    let notifications = Arc::new(AtomicUsize::new(0));
    let notifications_for_callback = Arc::clone(&notifications);
    let expected_run_id = ctx.run_id;
    let notifier = SandboxPreparedNotifier::new(move |run_id, prepared_sandbox_id| {
        let notifications = Arc::clone(&notifications_for_callback);
        async move {
            assert_eq!(run_id, expected_run_id);
            assert_eq!(prepared_sandbox_id, sandbox_id);
            notifications.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        .boxed()
    });
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = execute_new_sandbox_with_prepared_notifier(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: sandbox_id,
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        NewSandboxHooks {
            preparation: crate::executor::sandbox_run::FreshPreparation::Initial,
            controls: RunControls::new(tokio_util::sync::CancellationToken::new(), None),
            prepared_run_payload: prepare_run_payload_for_run(&ctx).unwrap(),
            sandbox_prepared: Some(&notifier),
        },
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert_eq!(notifications.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn execute_new_sandbox_replaces_post_write_prefetch_timeout_before_workload() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_error(process_start_timeout(
        sandbox::SandboxOperationTimeoutStage::AwaitingTerminalResponse,
    ));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let context = codex_oauth_context();
    let params = JobParams {
        restore_guest_state: true,
        ..default_params()
    };
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
        CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert_eq!(overrides.create_configs().len(), 2);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(overrides.start_process_calls().len(), 1);
    assert_eq!(overrides.guest_state_restore_calls().len(), 2);
    assert_eq!(overrides.workspace_drive_mount_calls(), 1);
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    assert_telemetry_action(
        &telemetry,
        "runner_codex_model_catalog_prefetch",
        false,
        Some("start_timed_out"),
    );
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_retry_without_codex_prefetch",
        true,
        None,
    );
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_new_sandbox_suppresses_prefetch_replacement_after_uncertain_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_error(process_start_timeout(
        sandbox::SandboxOperationTimeoutStage::FrameWrite,
    ));
    overrides.push_destroy_panic("destroy failed");
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let context = codex_oauth_context();
    let mut telemetry = test_telemetry(&config, &context);

    let error = execute_new_sandbox(
        &factory,
        &context,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        CancellationToken::new(),
    )
    .await
    .err()
    .expect("uncertain cleanup must suppress replacement");

    assert!(matches!(
        error,
        RunnerError::Sandbox(SandboxError::OperationTimeout {
            operation: sandbox::SandboxOperation::StartProcess,
            stage: sandbox::SandboxOperationTimeoutStage::FrameWrite,
            ..
        })
    ));
    assert_eq!(overrides.create_configs().len(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(overrides.workspace_drive_mount_calls(), 0);
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_retry_without_codex_prefetch",
        false,
        Some("cleanup_uncertain"),
    );
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_new_sandbox_handles_ordinary_prefetch_write_failures() {
    use sandbox::SandboxOperationWriteStage;
    use std::io;

    for (stage, kind, cleanup_uncertain) in [
        (
            SandboxOperationWriteStage::BeforeFrameWrite,
            io::ErrorKind::PermissionDenied,
            false,
        ),
        (
            SandboxOperationWriteStage::FrameWrite,
            io::ErrorKind::BrokenPipe,
            false,
        ),
        (
            SandboxOperationWriteStage::FrameWrite,
            io::ErrorKind::TimedOut,
            false,
        ),
        (
            SandboxOperationWriteStage::FrameWrite,
            io::ErrorKind::BrokenPipe,
            true,
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.push_start_process_error(SandboxError::OperationWrite {
            operation: sandbox::SandboxOperation::StartProcess,
            stage,
            source: io::Error::new(kind, "prefetch write failed"),
        });
        if cleanup_uncertain {
            overrides.push_destroy_panic("destroy failed");
        }
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let context = codex_oauth_context();
        let mut telemetry = test_telemetry(&config, &context);
        let result = execute_new_sandbox(
            &factory,
            &context,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &default_params(),
            &mut telemetry,
            CancellationToken::new(),
        )
        .await;

        assert_eq!(
            overrides.start_process_calls().len(),
            1,
            "replacement must not prefetch again"
        );
        let unsafe_write = stage == SandboxOperationWriteStage::FrameWrite;
        assert_eq!(overrides.destroy_call_count(), u32::from(unsafe_write));
        assert_eq!(
            overrides.create_configs().len(),
            1 + usize::from(unsafe_write && !cleanup_uncertain)
        );
        if cleanup_uncertain {
            assert!(matches!(
                result,
                Err(RunnerError::Sandbox(SandboxError::OperationWrite {
                    stage: SandboxOperationWriteStage::FrameWrite,
                    ..
                }))
            ));
            assert_eq!(overrides.workspace_drive_mount_calls(), 0);
            assert!(overrides.storage_manifest_calls().is_empty());
            assert!(overrides.start_agent_process_calls().is_empty());
        } else {
            assert_eq!(result.unwrap().exit_code(), 0);
            assert_eq!(overrides.workspace_drive_mount_calls(), 1);
            assert_eq!(overrides.start_agent_process_calls().len(), 1);
        }
        assert_telemetry_action(
            &telemetry,
            "runner_codex_model_catalog_prefetch",
            false,
            Some("start_failed"),
        );
        if unsafe_write {
            assert_telemetry_action(
                &telemetry,
                "runner_fresh_sandbox_retry_without_codex_prefetch",
                !cleanup_uncertain,
                cleanup_uncertain.then_some("cleanup_uncertain"),
            );
        }
        assert_proxy_registry_empty(dir.path()).await;
    }
}

#[tokio::test]
async fn execute_new_sandbox_destroys_before_workload_when_prepared_notification_fails() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let ctx = minimal_context();
    let notifier = SandboxPreparedNotifier::new(move |_run_id, _sandbox_id| {
        async move {
            Err(RunnerError::Internal(
                "status publication failed".to_owned(),
            ))
        }
        .boxed()
    });
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = execute_new_sandbox_with_prepared_notifier(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        NewSandboxHooks {
            preparation: crate::executor::sandbox_run::FreshPreparation::Initial,
            controls: RunControls::new(tokio_util::sync::CancellationToken::new(), None),
            prepared_run_payload: prepare_run_payload_for_run(&ctx).unwrap(),
            sandbox_prepared: Some(&notifier),
        },
    )
    .await;
    let error = match result {
        Ok(_) => panic!("prepared notification failure should stop sandbox execution"),
        Err(error) => error,
    };

    assert!(error.to_string().contains("status publication failed"));
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn prefetch_partial_write_cannot_spend_a_second_preparation_retry() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(guest_dns_readiness_failure(
        SandboxGuestDnsReadinessReason::DnsPath,
        "first attachment failed",
    )));
    overrides.push_start_process_error(SandboxError::OperationWrite {
        operation: sandbox::SandboxOperation::StartProcess,
        stage: sandbox::SandboxOperationWriteStage::FrameWrite,
        source: std::io::Error::new(std::io::ErrorKind::BrokenPipe, "partial write"),
    });
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let context = codex_oauth_context();
    let mut telemetry = test_telemetry(&config, &context);
    let result = execute_new_sandbox(
        &factory,
        &context,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        CancellationToken::new(),
    )
    .await;

    assert!(matches!(
        result,
        Err(RunnerError::Sandbox(SandboxError::OperationWrite { .. }))
    ));
    assert_eq!(overrides.create_configs().len(), 2);
    assert_eq!(overrides.destroy_call_count(), 2);
    assert_eq!(overrides.start_process_calls().len(), 1);
    assert_eq!(overrides.workspace_drive_mount_calls(), 0);
    assert!(overrides.storage_manifest_calls().is_empty());
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_telemetry_action(
        &telemetry,
        "runner_codex_model_catalog_prefetch",
        false,
        Some("start_failed"),
    );
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_new_sandbox_replaces_one_dns_unready_attachment_before_workload() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(guest_dns_readiness_failure(
        SandboxGuestDnsReadinessReason::DnsPath,
        "first attachment failed",
    )));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let ctx = minimal_context();
    let sandbox_id = SandboxId::new_v4();
    let notifications = Arc::new(AtomicUsize::new(0));
    let notifications_for_callback = Arc::clone(&notifications);
    let notifier = SandboxPreparedNotifier::new(move |_run_id, prepared_sandbox_id| {
        let notifications = Arc::clone(&notifications_for_callback);
        async move {
            assert_eq!(prepared_sandbox_id, sandbox_id);
            notifications.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        .boxed()
    });
    let mut telemetry = test_telemetry(&config, &ctx);

    let (outcome, events) = capture_sandbox_run_events(execute_new_sandbox_with_prepared_notifier(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: sandbox_id,
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        NewSandboxHooks {
            preparation: crate::executor::sandbox_run::FreshPreparation::Initial,
            controls: RunControls::new(tokio_util::sync::CancellationToken::new(), None),
            prepared_run_payload: prepare_run_payload_for_run(&ctx).unwrap(),
            sandbox_prepared: Some(&notifier),
        },
    ))
    .await;
    let outcome = outcome.unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert_eq!(overrides.create_configs().len(), 2);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    assert_eq!(notifications.load(Ordering::SeqCst), 1);
    assert_proxy_registry_empty(dir.path()).await;
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_dns_readiness_retry",
        true,
        None,
    );
    let completion = captured_events_named(&events, "guest DNS readiness replacement completed");
    assert_eq!(completion.len(), 1, "events={events:#?}");
    assert_eq!(completion[0].level, Level::WARN);
    assert_captured_field(completion[0], "success", "true");
    assert_captured_field(completion[0], "workspace_fallback", "false");

    let observation = captured_events_named(&events, "guest DNS readiness network log observation");
    assert_eq!(observation.len(), 1, "events={events:#?}");
    assert_captured_field(observation[0], "dns_drain_status", "not_configured");
    assert_captured_field(observation[0], "kmsg_drain_status", "not_configured");
    assert_captured_field(observation[0], "writer_backpressure_observed", "false");
}

#[tokio::test]
async fn execute_new_sandbox_does_not_replace_guest_exec_timing_failures() {
    for (reason, message) in [
        (
            SandboxGuestDnsReadinessReason::ProcessTimeout,
            "guest process timed out",
        ),
        (
            SandboxGuestDnsReadinessReason::Deadline,
            "host deadline expired",
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.push_start_result(Err(guest_dns_readiness_failure(reason, message)));
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let ctx = minimal_context();
        let mut telemetry = test_telemetry(&config, &ctx);

        let result = execute_new_sandbox(
            &factory,
            &ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &default_params(),
            &mut telemetry,
            tokio_util::sync::CancellationToken::new(),
        )
        .await;

        let error = result
            .err()
            .expect("guest exec timing failure must be returned");
        assert!(error.to_string().contains(message), "got: {error}");
        assert_eq!(overrides.create_configs().len(), 1);
        assert_eq!(overrides.destroy_call_count(), 1);
        assert!(overrides.start_process_calls().is_empty());
        assert!(overrides.start_agent_process_calls().is_empty());
        assert_proxy_registry_empty(dir.path()).await;
        assert_no_telemetry_action(&telemetry, "runner_fresh_sandbox_dns_readiness_retry");
    }
}

#[tokio::test]
async fn dns_readiness_retry_keeps_one_fresh_archive_owner() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(guest_dns_readiness_failure(
        SandboxGuestDnsReadinessReason::DnsPath,
        "first attachment failed",
    )));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let server = httpmock::MockServer::start_async().await;
    let body = b"fresh archive across DNS retry".to_vec();
    let full_get = server
        .mock_async(|when, then| {
            when.method(httpmock::Method::GET)
                .path("/fresh-dns-retry.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;
    let mut ctx = minimal_context();
    let mut storage = api_storage(
        "fresh-dns-retry",
        "/data",
        "v1",
        &server.url("/fresh-dns-retry.tar.gz"),
    );
    storage.archive_size = Some(body.len() as u64);
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![storage],
        artifacts: Vec::new(),
    });
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert_eq!(overrides.create_configs().len(), 2);
    full_get.assert_calls_async(1).await;
    assert_telemetry_action(
        &telemetry,
        "storage_cache_fresh_delivery_single_request",
        true,
        None,
    );
}

#[tokio::test]
async fn execute_new_sandbox_stops_after_two_dns_unready_attachments() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(guest_dns_readiness_failure(
        SandboxGuestDnsReadinessReason::DnsPath,
        "first attachment failed",
    )));
    overrides.push_start_result(Err(guest_dns_readiness_failure(
        SandboxGuestDnsReadinessReason::DnsPath,
        "second attachment failed",
    )));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let ctx = minimal_context();
    let mut telemetry = test_telemetry(&config, &ctx);

    let (result, events) = capture_sandbox_run_events(execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    ))
    .await;

    let error = result.err().expect("second DNS failure must be returned");
    assert!(error.to_string().contains("second attachment failed"));
    assert_eq!(overrides.create_configs().len(), 2);
    assert_eq!(overrides.destroy_call_count(), 2);
    assert!(overrides.start_process_calls().is_empty());
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_proxy_registry_empty(dir.path()).await;
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_dns_readiness_retry",
        false,
        Some("replacement_prepare_failed"),
    );
    let completion = captured_events_named(&events, "guest DNS readiness replacement completed");
    assert_eq!(completion.len(), 1, "events={events:#?}");
    assert_captured_field(completion[0], "success", "false");
    assert_captured_field(completion[0], "workspace_fallback", "false");
}

#[tokio::test]
async fn execute_new_sandbox_does_not_retry_an_unrelated_start_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(SandboxError::Start {
        message: "boot failed".into(),
    }));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let ctx = minimal_context();
    let mut telemetry = test_telemetry(&config, &ctx);

    let (result, events) = capture_sandbox_run_events(execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    ))
    .await;

    let error = result
        .err()
        .expect("ordinary start failure must be returned");
    assert!(error.to_string().contains("boot failed"));
    assert_eq!(overrides.create_configs().len(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_no_telemetry_action(&telemetry, "runner_fresh_sandbox_dns_readiness_retry");
    assert!(
        captured_events_named(&events, "guest DNS readiness replacement completed").is_empty(),
        "events={events:#?}"
    );
    tokio::time::timeout(
        Duration::from_secs(2),
        config
            .pre_spawn_admission
            .acquire(2, &CancellationToken::new()),
    )
    .await
    .unwrap()
    .unwrap();
}

#[tokio::test]
async fn execute_new_sandbox_suppresses_dns_retry_after_uncertain_destroy() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(guest_dns_readiness_failure(
        SandboxGuestDnsReadinessReason::DnsPath,
        "attachment failed",
    )));
    overrides.push_destroy_panic("simulated destroy panic");
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let ctx = minimal_context();
    let mut telemetry = test_telemetry(&config, &ctx);

    let (result, events) = capture_sandbox_run_events(execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    ))
    .await;

    let error = result
        .err()
        .expect("uncertain cleanup must preserve the readiness error");
    assert!(error.to_string().contains("attachment failed"));
    assert_eq!(overrides.create_configs().len(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(overrides.start_process_calls().is_empty());
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_dns_readiness_retry",
        false,
        Some("cleanup_uncertain"),
    );
    assert!(
        captured_events_named(&events, "guest DNS readiness replacement completed").is_empty(),
        "events={events:#?}"
    );
}

#[tokio::test]
async fn execute_new_sandbox_waits_for_destroy_before_dns_retry_create() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(guest_dns_readiness_failure(
        SandboxGuestDnsReadinessReason::DnsPath,
        "attachment failed",
    )));
    overrides.set_destroy_lifecycle_gate(gate.clone());
    let factory = Arc::new(MockSandboxFactory::with_overrides(Arc::clone(&overrides)));
    let ctx = minimal_context();
    let sandbox_id = SandboxId::new_v4();
    let task = tokio::spawn({
        let factory = Arc::clone(&factory);
        async move {
            let mut telemetry = test_telemetry(&config, &ctx);
            let result = execute_new_sandbox(
                factory.as_ref(),
                &ctx,
                NewSandboxDispatch {
                    id: sandbox_id,
                    reuse_result: SandboxReuseResult::PoolMiss,
                },
                &config,
                &default_params(),
                &mut telemetry,
                tokio_util::sync::CancellationToken::new(),
            )
            .await;
            (result, telemetry)
        }
    });

    gate.wait_entered(1, Duration::from_secs(5))
        .await
        .expect("first failed sandbox should enter explicit destroy");
    assert_eq!(
        overrides.create_configs().len(),
        1,
        "replacement create must wait for failed-sandbox destroy"
    );

    gate.release_one();
    let (result, telemetry) = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("replacement should finish after destroy release")
        .expect("replacement task should not panic");
    assert_eq!(result.unwrap().exit_code(), 0);
    assert_eq!(overrides.create_configs().len(), 2);
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_dns_readiness_retry",
        true,
        None,
    );
}

#[tokio::test]
async fn execute_new_sandbox_does_not_notify_before_start_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    tokio::fs::remove_file(dir.path().join("proxy-registry.json"))
        .await
        .unwrap();
    let factory = MockSandboxFactory::new();
    let ctx = minimal_context();
    let notifications = Arc::new(AtomicUsize::new(0));
    let notifications_for_callback = Arc::clone(&notifications);
    let notifier = SandboxPreparedNotifier::new(move |_run_id, _sandbox_id| {
        let notifications = Arc::clone(&notifications_for_callback);
        async move {
            notifications.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        .boxed()
    });
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = execute_new_sandbox_with_prepared_notifier(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        NewSandboxHooks {
            preparation: crate::executor::sandbox_run::FreshPreparation::Initial,
            controls: RunControls::new(tokio_util::sync::CancellationToken::new(), None),
            prepared_run_payload: prepare_run_payload_for_run(&ctx).unwrap(),
            sandbox_prepared: Some(&notifier),
        },
    )
    .await;

    assert!(result.is_err());
    assert_eq!(notifications.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn execute_new_sandbox_does_not_notify_after_post_start_prepare_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let mut mount_result = ExecResult::new(64, Vec::new(), b"mount denied".to_vec());
    mount_result.guest_duration_ms = Some(31);
    overrides.push_workspace_drive_mount_result(Ok(mount_result));
    let factory = MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let notifications = Arc::new(AtomicUsize::new(0));
    let notifications_for_callback = Arc::clone(&notifications);
    let notifier = SandboxPreparedNotifier::new(move |_run_id, _sandbox_id| {
        let notifications = Arc::clone(&notifications_for_callback);
        async move {
            notifications.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        .boxed()
    });
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = execute_new_sandbox_with_prepared_notifier(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        NewSandboxHooks {
            preparation: crate::executor::sandbox_run::FreshPreparation::Initial,
            controls: RunControls::new(tokio_util::sync::CancellationToken::new(), None),
            prepared_run_payload: prepare_run_payload_for_run(&ctx).unwrap(),
            sandbox_prepared: Some(&notifier),
        },
    )
    .await;

    assert!(result.is_err());
    assert_eq!(notifications.load(Ordering::SeqCst), 0);
    let operations = telemetry.pending_ops_with_duration_snapshot();
    let guest_exec = operations
        .iter()
        .find(|operation| operation.0 == "workspace_drive_mount_guest_exec")
        .unwrap_or_else(|| panic!("missing mount guest duration: {operations:?}"));
    assert_eq!(guest_exec.1, 31);
    assert!(!guest_exec.2);
}

#[tokio::test]
async fn execute_job_workspace_mount_failure_drains_early_prefetch_before_destroy() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let wait_gate = MockLifecycleGate::new();
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.set_process_cancel_releases_wait_gate(false);
    overrides.push_workspace_drive_mount_result(Ok(ExecResult::new(
        64,
        Vec::new(),
        b"mount denied".to_vec(),
    )));
    let factory = Arc::new(MockSandboxFactory::with_overrides(Arc::clone(&overrides)));

    let task = tokio::spawn({
        let factory = Arc::clone(&factory);
        async move {
            execute_job(
                factory.as_ref(),
                codex_oauth_context(),
                NewSandboxDispatch {
                    id: SandboxId::new_v4(),
                    reuse_result: SandboxReuseResult::PoolMiss,
                },
                &config,
                &default_params(),
                tokio_util::sync::CancellationToken::new(),
            )
            .await
        }
    });

    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("prefetch wait should start before sandbox destruction");
    assert!(
        overrides
            .wait_for_process_cancel_calls(1, Duration::from_secs(5))
            .await,
        "mount failure should cancel the prefetch before destruction"
    );
    assert_eq!(
        overrides.destroy_call_count(),
        0,
        "sandbox must remain alive until the prefetch wait is drained"
    );
    wait_gate.release_one();

    let (outcome, telemetry) = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("mount-failure cleanup should finish after the prefetch wait is released")
        .expect("mount-failure task should not panic");

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(
        error.contains("mount workspace drive failed"),
        "got: {error}"
    );
    assert!(error.contains("mount denied"), "got: {error}");
    let operations = telemetry.pending_ops_with_outcome_snapshot();
    let unavailable = operations
        .iter()
        .find(|operation| operation.0 == "workspace_drive_mount_guest_exec_unavailable")
        .unwrap_or_else(|| panic!("missing unavailable mount guest duration: {operations:?}"));
    assert!(!unavailable.1);
    assert_eq!(unavailable.2.as_deref(), Some("unavailable"));
    assert!(
        operations
            .iter()
            .all(|operation| operation.0 != "workspace_drive_mount_guest_exec")
    );
    assert!(
        outcome.sandbox.is_none(),
        "fresh mount failure should be destroyed inline"
    );
    assert!(
        outcome.network_log_session.is_none(),
        "network log session should be closed before returning"
    );
    assert_eq!(overrides.destroy_call_count(), 1);
    let start_calls = overrides.start_process_calls();
    assert_eq!(start_calls.len(), 1);
    assert!(start_calls[0].cmd.contains("codex --version"));
    let wait_calls = overrides.wait_process_calls();
    assert_eq!(wait_calls.len(), 1);
    assert!(
        wait_calls[0].timeout < Duration::from_secs(18),
        "workspace mount time must reduce the original prefetch wait deadline"
    );
    assert_eq!(overrides.process_cancel_calls().len(), 1);
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_inner_writes_user_env_file_and_starts_agent_with_bootstrap_env_only() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    ctx.prompt = "p".repeat(guest_control_proto::MAX_EXEC_STDIN_BYTES);
    ctx.user_timezone = Some("Asia/Shanghai".into());
    ctx.environment = Some(HashMap::from([
        ("CUSTOM_USER_ENV".into(), "visible-to-cli".into()),
        (
            "LARGE_USER_ENV".into(),
            "x".repeat(guest_control_proto::MAX_EXEC_STDIN_BYTES),
        ),
        (
            "OKOU_APP_URL".into(),
            "https://app.runner-env.example.test/path".into(),
        ),
        (
            "CUSTOM_APP_URL".into(),
            "https://app.runner-env.example.test/path".into(),
        ),
        (
            "CUSTOM_FUTURE_KEY".into(),
            "https://ordinary.runner-env.example.test".into(),
        ),
        ("BASH_ENV".into(), "/tmp/user-bash-env".into()),
        ("NODE_OPTIONS".into(), "--require /tmp/user-node.js".into()),
        ("CUSTOM_PROMPT".into(), "hostile-user-prompt".into()),
        ("CUSTOM_API_TOKEN".into(), "user-token".into()),
        (
            guest_contracts::env::CONNECTOR_ACCOUNT_CONTEXT_FILE_ENV.into(),
            "/tmp/evil-connector-account-context.json".into(),
        ),
    ]));
    ctx.platform_environment = HashMap::from([
        (
            "OKOU_APP_URL".into(),
            "https://app.runner-env.example.test/path".into(),
        ),
        (
            "CUSTOM_APP_URL".into(),
            "https://app.runner-env.example.test/path".into(),
        ),
    ]);
    ctx.connector_runtime_targets = vec![
        ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "github".into(),
            base_url_vars: Some(HashMap::from([(
                "API_ORIGIN".into(),
                "https://api.github.com".into(),
            )])),
            source_id: Some("550e8400-e29b-41d4-a716-446655440000".into()),
        },
        ConnectorRuntimeTargetRegistration::Custom {
            custom_connector_id: "550e8400-e29b-41d4-a716-446655440001".into(),
            base_url_vars: HashMap::from([(
                "CUSTOM_ORIGIN".into(),
                "https://custom.example.test".into(),
            )]),
            source_id: None,
        },
    ];

    let (exit_code, error_msg) = run_new_sandbox_status(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());

    let start_calls = overrides.start_agent_process_calls();
    assert_eq!(start_calls.len(), 1);
    let start_env: BTreeMap<String, String> = start_calls[0].env.iter().cloned().collect();
    let expected_user_env_file = guest_user_env_file_path(ctx.run_id).unwrap();
    let expected_run_payload_file = guest_run_payload_file_path(ctx.run_id).unwrap();
    let expected_connector_account_context_file =
        guest_connector_account_context_file_path(ctx.run_id).unwrap();
    assert_eq!(
        start_env
            .get(guest_contracts::env::CANONICAL_API_TOKEN_ENV)
            .unwrap(),
        "tok"
    );
    assert_eq!(
        start_env
            .get(guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV)
            .map(String::as_str),
        Some(expected_user_env_file.as_str())
    );
    assert_eq!(
        start_env
            .get(guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV)
            .map(String::as_str),
        Some(expected_run_payload_file.as_str())
    );
    for key in [
        guest_contracts::env::PROMPT_RUN_PAYLOAD_FIELD,
        guest_contracts::env::APPEND_SYSTEM_PROMPT_RUN_PAYLOAD_FIELD,
        guest_contracts::env::SECRET_VALUES_RUN_PAYLOAD_FIELD,
        guest_contracts::env::DISALLOWED_TOOLS_RUN_PAYLOAD_FIELD,
        guest_contracts::env::TOOLS_RUN_PAYLOAD_FIELD,
        guest_contracts::env::SETTINGS_RUN_PAYLOAD_FIELD,
        guest_contracts::env::ARTIFACTS_RUN_PAYLOAD_FIELD,
        guest_contracts::env::FEATURE_FLAGS_RUN_PAYLOAD_FIELD,
    ] {
        assert!(
            !start_env.contains_key(key),
            "{key} should be passed through the run payload file"
        );
    }
    for key in [
        "CUSTOM_USER_ENV",
        "LARGE_USER_ENV",
        "OKOU_APP_URL",
        "CUSTOM_APP_URL",
        "CUSTOM_FUTURE_KEY",
        "CUSTOM_API_TOKEN",
        "BASH_ENV",
        "NODE_OPTIONS",
        "TZ",
    ] {
        assert!(
            !start_env.contains_key(key),
            "{key} should not be passed to guest-agent bootstrap"
        );
    }

    assert!(overrides.write_file_calls().is_empty());
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains(&expected_user_env_file)),
        "user env file should not be written through shell exec"
    );
    assert!(overrides.private_write_file_calls().is_empty());
    let private_batches = overrides.private_write_files_calls();
    assert_eq!(private_batches.len(), 1);
    assert_eq!(private_batches[0].files.len(), 3);
    let connector_account_context_write = &private_batches[0].files[0];
    assert_eq!(
        connector_account_context_write.path,
        expected_connector_account_context_file
    );
    let user_env_write = &private_batches[0].files[1];
    assert_eq!(user_env_write.path, expected_user_env_file);
    let run_payload_write = &private_batches[0].files[2];
    assert_eq!(run_payload_write.path, expected_run_payload_file);
    let user_env: HashMap<String, String> =
        serde_json::from_slice(&user_env_write.content).unwrap();
    assert_eq!(user_env.get("CUSTOM_USER_ENV").unwrap(), "visible-to-cli");
    assert_eq!(
        user_env.get("LARGE_USER_ENV").unwrap().len(),
        guest_control_proto::MAX_EXEC_STDIN_BYTES
    );
    assert_eq!(
        user_env.get("OKOU_APP_URL").unwrap(),
        "https://app.runner-env.example.test/path"
    );
    assert_eq!(
        user_env.get("CUSTOM_APP_URL").unwrap(),
        "https://app.runner-env.example.test/path"
    );
    assert_eq!(user_env.get("BASH_ENV").unwrap(), "/tmp/user-bash-env");
    assert_eq!(
        user_env.get("NODE_OPTIONS").unwrap(),
        "--require /tmp/user-node.js"
    );
    assert_eq!(user_env.get("TZ").unwrap(), "Asia/Shanghai");
    assert_eq!(
        user_env.get("CUSTOM_FUTURE_KEY").map(String::as_str),
        Some("https://ordinary.runner-env.example.test")
    );
    assert_eq!(
        user_env.get("CUSTOM_PROMPT").map(String::as_str),
        Some("hostile-user-prompt")
    );
    assert_eq!(
        user_env.get("CUSTOM_API_TOKEN").map(String::as_str),
        Some("user-token")
    );
    assert!(!user_env.contains_key(guest_contracts::env::CANONICAL_API_TOKEN_ENV));
    assert_eq!(
        user_env
            .get(guest_contracts::env::CONNECTOR_ACCOUNT_CONTEXT_FILE_ENV)
            .map(String::as_str),
        Some(expected_connector_account_context_file.as_str())
    );
    let connector_account_context: guest_contracts::connector_account_context::RunConnectorAccountContext =
        serde_json::from_slice(&connector_account_context_write.content).unwrap();
    assert_eq!(
        connector_account_context,
        guest_contracts::connector_account_context::RunConnectorAccountContext {
            schema_version: guest_contracts::connector_account_context::SCHEMA_VERSION,
            targets: vec![
                guest_contracts::connector_account_context::RunConnectorAccountTarget::Builtin {
                    connector_slug: "github".into(),
                    connection_id: Some("550e8400-e29b-41d4-a716-446655440000".into()),
                },
                guest_contracts::connector_account_context::RunConnectorAccountTarget::Custom {
                    custom_connector_id: "550e8400-e29b-41d4-a716-446655440001".into(),
                    connection_id: None,
                },
            ],
        }
    );
    let run_payload: guest_contracts::env::RunPayload =
        serde_json::from_slice(&run_payload_write.content).unwrap();
    assert_eq!(run_payload.prompt, ctx.prompt);
}

#[tokio::test]
async fn execute_inner_stops_when_required_private_batch_fails() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_private_write_files_result(Err(sandbox_write_file_error(
        "connector account context write failed",
    )));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let context = minimal_context();

    let (exit_code, error_msg) =
        run_new_sandbox_status(&factory, &context, &config, &default_params())
            .await
            .unwrap();

    assert_eq!(exit_code, 1);
    assert!(
        error_msg
            .expect("connector account context write failure should fail the run")
            .contains("connector account context write failed")
    );
    assert!(overrides.private_write_file_calls().is_empty());
    let private_batches = overrides.private_write_files_calls();
    assert_eq!(private_batches.len(), 1);
    assert_eq!(private_batches[0].files.len(), 3);
    assert_eq!(
        private_batches[0].files[0].path,
        guest_connector_account_context_file_path(context.run_id).unwrap()
    );
    assert!(overrides.start_agent_process_calls().is_empty());
}

#[tokio::test]
async fn execute_inner_rejects_invalid_run_payload_before_private_writes() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut context = minimal_context();
    context.prompt = "invalid\0prompt".into();

    let error = run_new_sandbox_outcome(&factory, &context, &config, &default_params())
        .await
        .err()
        .expect("invalid payload must fail before execution");

    assert!(error.to_string().contains("run payload contains NUL byte"));
    assert!(overrides.private_write_file_calls().is_empty());
    assert!(overrides.private_write_files_calls().is_empty());
    assert!(overrides.start_agent_process_calls().is_empty());
}

#[tokio::test]
async fn execute_inner_run_payload_enospc_collects_resources_without_starting_agent() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_private_write_files_result(Err(sandbox_write_file_error(
        "No space left on device (os error 28)",
    )));
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "guest-agent-binary".into(),
        exit_code: 0,
        stdout: b"VM0_DF_BLOCKS_V1\n/dev/root 8388608 8388608 0 100% /\nVM0_DF_INODES_V1\n/dev/root 524288 524280 8 100% /\n".to_vec(),
        stderr: Vec::new(),
    });
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let outcome = run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
        .await
        .unwrap();

    assert_eq!(outcome.exit_code(), 1);
    let failure = outcome.failure.as_ref().expect("expected failure");
    assert!(
        failure
            .error
            .contains("No space left on device (os error 28)"),
        "got: {failure:?}"
    );
    assert_eq!(
        failure
            .resource_diagnostics
            .expect("expected resource diagnostics")
            .failure_kind,
        Some(ResourceFailureKind::GuestRootFilesystemFull)
    );
    assert!(overrides.private_write_file_calls().is_empty());
    let private_batches = overrides.private_write_files_calls();
    assert_eq!(private_batches.len(), 1);
    assert_eq!(private_batches[0].files.len(), 3);
    assert!(
        private_batches[0].files[0]
            .path
            .ends_with("/connector-account-context/context.json"),
        "got: {}",
        private_batches[0].files[0].path
    );
    assert!(
        private_batches[0].files[2]
            .path
            .ends_with("/run-payload/payload.json"),
        "got: {}",
        private_batches[0].files[2].path
    );
    assert!(
        overrides.start_agent_process_calls().is_empty(),
        "agent must not start after run payload write failure"
    );
    assert_eq!(
        overrides
            .exec_calls()
            .iter()
            .filter(|call| call.cmd.contains("guest-agent-binary"))
            .count(),
        1
    );
}

#[tokio::test]
async fn execute_inner_passes_device_rate_limits_to_sandbox_create() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let limits = test_device_rate_limits();
    let params = JobParams {
        workspace_disk_mb: 512,
        device_rate_limits: Some(limits.clone()),
        ..default_params()
    };

    let (exit_code, error_msg) =
        run_new_sandbox_status(&factory, &minimal_context(), &config, &params)
            .await
            .unwrap();

    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 1);
    assert_eq!(configs[0].device_rate_limits, Some(limits));
    assert_eq!(
        configs[0].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 512,
            seed_image: None,
        })
    );
}

#[tokio::test]
async fn execute_inner_launches_agent_stream_only_without_guest_log_tee() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides.clone());

    let (exit_code, error_msg) =
        run_new_sandbox_status(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();
    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());

    let calls = overrides.start_agent_process_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].output,
        ProcessOutputMode::stream_with_stderr_capture(64 * 1024)
    );
}

#[tokio::test]
async fn execute_inner_with_snapshot_runs_clock_fix_and_reseed() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let params = JobParams {
        restore_guest_state: true,
        ..default_params()
    };
    let (exit_code, _) = run_new_sandbox_status(&factory, &minimal_context(), &config, &params)
        .await
        .unwrap();
    assert_eq!(exit_code, 0);
}

#[tokio::test]
async fn execute_inner_with_storage_manifest() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();
    let server = httpmock::MockServer::start_async().await;
    let full_get = server
        .mock_async(|when, then| {
            when.method(httpmock::Method::GET)
                .path("/data.tar.gz")
                .header_missing("range");
            then.status(200).body(b"storage archive");
        })
        .await;

    let mut ctx = minimal_context();
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![api_storage(
            "data",
            "/data",
            "v1",
            &server.url("/data.tar.gz"),
        )],
        artifacts: vec![],
    });
    let (exit_code, error_msg) = run_new_sandbox_status(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();
    assert_eq!(exit_code, 0, "error={error_msg:?}");
    full_get.assert_async().await;
}

#[tokio::test]
async fn execute_inner_with_resume_session() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession::inline(
        "sess-abc-123".into(),
        r#"{"type":"init"}"#.into(),
    ));
    let (exit_code, _) = run_new_sandbox_status(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();
    assert_eq!(exit_code, 0);
}

#[tokio::test]
async fn execute_inner_create_failure_returns_error() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();
    factory.push_create_result(Err(sandbox_create_error("no free devices")));

    let err = run_new_sandbox_status(&factory, &minimal_context(), &config, &default_params())
        .await
        .unwrap_err();
    assert!(err.to_string().contains("no free devices"), "got: {err}");
}

#[tokio::test]
async fn execute_inner_start_failure_destroy_panic_returns_start_error() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(SandboxError::Start {
        message: "boot failed".into(),
    }));
    let factory = DestroyPanicFactory {
        inner: MockSandboxFactory::with_overrides(overrides),
    };

    let ctx = minimal_context();
    let mut telemetry = test_telemetry(&config, &ctx);
    let cancel = tokio_util::sync::CancellationToken::new();
    let result = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        cancel,
    )
    .await;

    assert!(result.is_err(), "start failure must return an error");
    let err = result.err().unwrap();
    assert!(err.to_string().contains("boot failed"), "got: {err}");
    assert_proxy_registry_empty(dir.path()).await;
    assert!(
        !config
            .network_log_manager
            .append_for_ip(
                "10.0.0.1",
                serde_json::json!({"type":"dns","host":"after-start-failure.test"})
            )
            .await,
        "start failure should close inline network-log attribution",
    );
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
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_start",
        false,
        Some("sandbox_start_failed"),
    );
}

#[tokio::test]
async fn execute_job_wraps_execute_inner() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoReuseKey,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.error().is_none());
    assert!(outcome.sandbox.is_some());
}

#[tokio::test]
async fn execute_job_create_failure_returns_exit_1() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();
    factory.push_create_result(Err(sandbox_create_error("boom")));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoReuseKey,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(outcome.exit_code(), 1);
    assert!(outcome.error().unwrap().contains("boom"));
    assert!(outcome.sandbox.is_none());
}

#[tokio::test]
async fn execute_job_model_provider_env_validation_failure_returns_run_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let secret = "sk-proj-real-openai-secret";
    let mut ctx = minimal_context();
    ctx.environment = Some(HashMap::from([("OPENAI_API_KEY".into(), secret.into())]));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoReuseKey,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(error.contains("OPENAI_API_KEY"));
    assert!(!error.contains(secret));
    assert!(outcome.sandbox.is_none());
    assert!(
        overrides.create_configs().is_empty(),
        "fresh sandbox must not be created after env validation failure"
    );
}

#[tokio::test]
async fn execute_job_claude_tool_validation_failure_skips_sandbox_create() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    ctx.tools = Some(vec!["Bash,Read".into()]);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoReuseKey,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(error.contains("OKOU_TOOLS"));
    assert!(error.contains("must not contain commas"));
    assert!(outcome.sandbox.is_none());
    assert!(
        overrides.create_configs().is_empty(),
        "fresh sandbox must not be created after tool validation failure"
    );
}

#[tokio::test]
async fn execute_job_codex_ignores_claude_tool_validation() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.disallowed_tools = Some(vec!["".into()]);
    ctx.tools = Some(vec!["Bash,Read".into()]);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoReuseKey,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.error().is_none());
    assert!(outcome.sandbox.is_some());
    assert_eq!(overrides.create_configs().len(), 1);
}

#[tokio::test]
async fn execute_job_nonzero_exit_still_returns_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_code(
        7,
    ));
    let factory = MockSandboxFactory::with_overrides(overrides);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoReuseKey,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;

    let failure = outcome
        .failure
        .as_ref()
        .expect("non-zero exit must produce a failure");
    assert_eq!(failure.exit_code, 7);
    assert!(!failure.error.is_empty(), "failure must include an error");
    assert_eq!(
        outcome.sandbox_reuse_disposition,
        SandboxReuseDisposition::Eligible(SandboxReuseTerminal::NonzeroExit),
    );
    // A healthy non-zero exit is reuse-eligible. Returning ownership lets
    // caller finalization park it when policy permits or destroy it otherwise.
    assert!(
        outcome.sandbox.is_some(),
        "sandbox must be returned for caller finalization"
    );
}
