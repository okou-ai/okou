use super::*;
use crate::executor::{ExecuteOutcome, ExecutorConfig};
use crate::idle_pool::IdleSandboxKind;
use crate::telemetry::JobTelemetry;
use sandbox::{SandboxOperation, SandboxOperationTimeoutStage, SandboxOperationWriteStage};
use sandbox_mock::MockSandboxOverrides;
use tokio_util::sync::CancellationToken;

const WAIT: Duration = Duration::from_secs(5);
const REPLACEMENT: &str = "runner_blank_sandbox_retry_without_codex_prefetch";

fn post_write_timeout() -> SandboxError {
    SandboxError::OperationTimeout {
        operation: SandboxOperation::StartProcess,
        stage: SandboxOperationTimeoutStage::AwaitingTerminalResponse,
        timeout_ms: 1_000,
    }
}

async fn execute_blank(
    config: ExecutorConfig,
    overrides: Arc<MockSandboxOverrides>,
    cancel: CancellationToken,
) -> (ExecuteOutcome, JobTelemetry) {
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let sandbox = create_overridden_sandbox(overrides).await;
    let mut context = codex_oauth_context();
    context.reuse_key = Some("thread:blank-prefetch-recovery".into());
    let sandbox_id = sandbox.id().parse().unwrap();
    let workspace_image = match &config.workspace_cache {
        Some(cache) => Some(
            cache
                .lease_active(
                    crate::workspace_image_cache::WorkspaceImageActiveLeaseRequest {
                        identity: WorkspaceImageLeaseIdentity {
                            run_id: context.run_id,
                            sandbox_id,
                            profile_name: "vm0/default",
                            reuse_key: context.reuse_key(),
                            working_dir: CANONICAL_WORKING_DIR,
                            image_size_bytes: u64::from(default_params().workspace_disk_mb)
                                * 1024
                                * 1024,
                        },
                        workspace_drive_available: true,
                    },
                )
                .await,
        ),
        None => None,
    };
    let mut telemetry = test_telemetry(&config, &context);
    let outcome = execute_reused_sandbox(
        ReusedSandboxRun {
            sandbox_id,
            factory: &factory,
            params: &JobParams {
                restore_guest_state: true,
                ..default_params()
            },
            source_ip: sandbox.source_ip().to_string(),
            sandbox,
            workspace_image,
            kind: IdleSandboxKind::Blank,
        },
        &context,
        &config,
        RunStart {
            restore_guest_state: true,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        PreparedRunInputs::new(
            RunControls::new(cancel, None).with_guest_state_prepared(true),
            prepare_run_payload_for_run(&context).unwrap(),
        ),
    )
    .await;
    (outcome, telemetry)
}

#[tokio::test]
async fn blank_prefetch_retires_before_one_replacement_and_one_agent() {
    for error in [
        post_write_timeout(),
        SandboxError::OperationTimeout {
            operation: SandboxOperation::StartProcess,
            stage: SandboxOperationTimeoutStage::FrameWrite,
            timeout_ms: 1_000,
        },
        SandboxError::OperationWrite {
            operation: SandboxOperation::StartProcess,
            stage: SandboxOperationWriteStage::FrameWrite,
            source: std::io::Error::new(std::io::ErrorKind::BrokenPipe, "partial frame"),
        },
    ] {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.push_start_process_error(error);
        let destroy = MockLifecycleGate::new();
        overrides.set_destroy_lifecycle_gate(destroy.clone());
        let task = tokio::spawn(execute_blank(
            config,
            Arc::clone(&overrides),
            CancellationToken::new(),
        ));
        destroy.wait_entered(1, WAIT).await.unwrap();
        assert_eq!(overrides.create_configs().len(), 1);
        assert!(overrides.copy_file_calls().is_empty());
        assert!(overrides.exec_calls().is_empty());
        assert!(overrides.private_write_files_calls().is_empty());
        assert!(overrides.start_agent_process_calls().is_empty());
        assert_proxy_registry_empty(dir.path()).await;
        assert!(!task.is_finished());
        destroy.release_one();
        let (outcome, telemetry) = tokio::time::timeout(WAIT, task).await.unwrap().unwrap();
        assert_eq!(outcome.exit_code(), 0, "{:?}", outcome.error());
        let creates = overrides.create_configs();
        assert_eq!(creates.len(), 2);
        assert_eq!(creates[0].id, creates[1].id);
        assert_eq!(
            outcome.sandbox.as_ref().unwrap().id(),
            creates[0].id.to_string()
        );
        assert_eq!(overrides.destroy_call_count(), 1);
        assert_eq!(overrides.start_process_calls().len(), 1);
        assert_eq!(overrides.start_agent_process_calls().len(), 1);
        assert_eq!(overrides.guest_state_restore_calls().len(), 1);
        assert_eq!(overrides.workspace_drive_mount_calls(), 1);
        assert_telemetry_action(&telemetry, REPLACEMENT, true, None);
        assert_telemetry_action(
            &telemetry,
            "runner_fresh_pre_spawn_admission_wait",
            true,
            None,
        );
        assert_proxy_registry_empty(dir.path()).await;
    }
}

#[tokio::test]
async fn blank_prefetch_success_and_safe_failure_bypass_fresh_admission() {
    for error in [
        None,
        Some(SandboxError::OperationWrite {
            operation: SandboxOperation::StartProcess,
            stage: SandboxOperationWriteStage::BeforeFrameWrite,
            source: std::io::Error::new(std::io::ErrorKind::PermissionDenied, "before frame"),
        }),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let holder = config
            .pre_spawn_admission
            .acquire(2, &CancellationToken::new())
            .await
            .unwrap();
        let overrides = Arc::new(MockSandboxOverrides::new());
        if let Some(error) = error {
            overrides.push_start_process_error(error);
        }
        let (outcome, telemetry) = tokio::time::timeout(
            WAIT,
            execute_blank(config, Arc::clone(&overrides), CancellationToken::new()),
        )
        .await
        .unwrap();
        assert_eq!(outcome.exit_code(), 0);
        assert_eq!(overrides.create_configs().len(), 1);
        assert_eq!(overrides.destroy_call_count(), 0);
        assert_eq!(overrides.start_process_calls().len(), 1);
        assert_eq!(overrides.start_agent_process_calls().len(), 1);
        assert!(overrides.guest_state_restore_calls().is_empty());
        assert_eq!(overrides.workspace_drive_mount_calls(), 0);
        assert_no_telemetry_action(&telemetry, REPLACEMENT);
        assert_no_telemetry_action(&telemetry, "runner_fresh_pre_spawn_admission_wait");
        drop(holder);
    }
}

#[tokio::test]
async fn blank_prefetch_uncertain_destroy_suppresses_replacement_and_guest_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_start_process_error(post_write_timeout());
    overrides.push_destroy_panic("uncertain destroy");
    let (outcome, telemetry) =
        execute_blank(config, Arc::clone(&overrides), CancellationToken::new()).await;
    assert_eq!(outcome.exit_code(), 1);
    assert!(outcome.sandbox.is_none());
    assert!(outcome.workspace_image.is_none());
    assert!(outcome.network_log_session.is_none());
    assert_eq!(overrides.create_configs().len(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(overrides.copy_file_calls().is_empty());
    assert!(overrides.exec_calls().is_empty());
    assert_telemetry_action(&telemetry, REPLACEMENT, false, Some("cleanup_uncertain"));
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn blank_prefetch_cancellation_drains_destroy_without_creating_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_start_process_error(post_write_timeout());
    let destroy = MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(destroy.clone());
    let cancel = CancellationToken::new();
    let task = tokio::spawn(execute_blank(
        config,
        Arc::clone(&overrides),
        cancel.clone(),
    ));
    destroy.wait_entered(1, WAIT).await.unwrap();
    cancel.cancel();
    assert!(!task.is_finished());
    destroy.release_one();
    let (outcome, telemetry) = tokio::time::timeout(WAIT, task).await.unwrap().unwrap();
    assert_eq!(outcome.exit_code(), 137);
    assert!(outcome.sandbox.is_none());
    assert_eq!(overrides.create_configs().len(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_telemetry_action(&telemetry, REPLACEMENT, false, Some("cancelled"));
}

#[tokio::test]
async fn blank_prefetch_replacement_failure_cannot_retry_again() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_start_process_error(post_write_timeout());
    overrides.push_start_result(Err(SandboxError::GuestDnsReadiness {
        reason: SandboxGuestDnsReadinessReason::DnsPath,
        message: "replacement DNS failed".into(),
    }));
    let (outcome, _) =
        execute_blank(config, Arc::clone(&overrides), CancellationToken::new()).await;
    assert_eq!(outcome.exit_code(), 1);
    assert_eq!(overrides.create_configs().len(), 2);
    assert_eq!(overrides.destroy_call_count(), 2);
    assert!(outcome.sandbox.is_none());
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_eq!(overrides.start_process_calls().len(), 1);
    assert!(overrides.copy_file_calls().is_empty());
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn blank_prefetch_replacement_releases_old_workspace_lease() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(WorkspaceImageCache::new(RunnerPaths::new(
        dir.path().join("runner"),
    )));
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_start_process_error(post_write_timeout());
    let (outcome, _) = execute_blank(config, overrides, CancellationToken::new()).await;
    assert_eq!(outcome.exit_code(), 0);
    assert_eq!(
        outcome.workspace_image.unwrap().result(),
        WorkspaceCacheCheckoutResult::Miss
    );
}

#[tokio::test]
async fn blank_prefetch_uncertain_proxy_cleanup_never_replaces() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let log_manager = config.network_log_manager.clone();
    let overrides = Arc::new(MockSandboxOverrides::new());
    let start = MockLifecycleGate::new();
    overrides.set_start_process_lifecycle_gate(start.clone());
    overrides.push_start_process_error(post_write_timeout());
    let task = tokio::spawn(execute_blank(
        config,
        Arc::clone(&overrides),
        CancellationToken::new(),
    ));
    start.wait_entered(1, WAIT).await.unwrap();
    tokio::fs::write(dir.path().join("proxy-registry.json"), b"invalid registry")
        .await
        .unwrap();
    start.release_one();
    let (outcome, telemetry) = tokio::time::timeout(WAIT, task).await.unwrap().unwrap();
    assert_eq!(outcome.exit_code(), 1);
    assert_eq!(overrides.create_configs().len(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(overrides.copy_file_calls().is_empty());
    assert!(
        !log_manager
            .append_for_ip("10.0.0.1", serde_json::json!({"message":"late row"}))
            .await
    );
    assert_telemetry_action(&telemetry, REPLACEMENT, false, Some("cleanup_uncertain"));
}

#[tokio::test]
async fn blank_prefetch_cancels_while_waiting_for_replacement_admission() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let admission = config.pre_spawn_admission.clone();
    let holder = admission
        .acquire(2, &CancellationToken::new())
        .await
        .unwrap();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_start_process_error(post_write_timeout());
    let cancel = CancellationToken::new();
    let task = tokio::spawn(execute_blank(
        config,
        Arc::clone(&overrides),
        cancel.clone(),
    ));
    tokio::time::timeout(WAIT, async {
        while overrides.destroy_call_count() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!task.is_finished());
    cancel.cancel();
    let (outcome, _) = tokio::time::timeout(WAIT, task).await.unwrap().unwrap();
    assert_eq!(outcome.exit_code(), 137);
    assert_eq!(overrides.create_configs().len(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
    drop(holder);
    assert!(
        admission
            .acquire(2, &CancellationToken::new())
            .await
            .is_ok()
    );
}
