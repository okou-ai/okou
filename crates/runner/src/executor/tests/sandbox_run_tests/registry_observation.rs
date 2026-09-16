use std::os::unix::fs::PermissionsExt;

use tokio::io::AsyncReadExt;
use tokio::net::{UnixListener, UnixStream};
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;

use super::*;
use crate::idle_pool::IdleSandboxKind;
use crate::types::WorkspaceReuseResult;

const WAIT: Duration = Duration::from_secs(2);

async fn accept_application(listener: &UnixListener) -> UnixStream {
    tokio::time::timeout(WAIT, async {
        let (mut stream, _) = listener.accept().await.unwrap();
        let size = stream.read_u32().await.unwrap();
        let mut bytes = vec![0; size as usize];
        stream.read_exact(&mut bytes).await.unwrap();
        let request: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(request["method"], "registry.apply");
        stream
    })
    .await
    .expect("registry application request")
}

async fn assert_spawn_before_receipt(kind: Option<IdleSandboxKind>) {
    let dir = tempfile::tempdir().unwrap();
    let control_dir = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let listener = UnixListener::bind(control_dir.path().join("control.sock")).unwrap();
    let mut config = test_executor_config(dir.path()).await;
    config
        .registry
        .set_control_target_for_test(control_dir.path().to_path_buf(), "generation-1".into());
    let mut context = minimal_context();
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    if kind.is_none() {
        let runner_paths = RunnerPaths::new(dir.path().join("runner"));
        let cache = WorkspaceImageCache::new(runner_paths.clone());
        let session_id = "registry-observation-workspace";
        context.reuse_key = Some(format!("thread:workspace-cache-{session_id}"));
        context.resume_session = Some(ResumeSession::inline(
            session_id.into(),
            r#"{"type":"init"}"#.into(),
        ));
        seed_workspace_image_cache(&cache, &runner_paths, session_id, params.workspace_disk_mb)
            .await;
        config.workspace_cache = Some(cache);
    }
    let config = Arc::new(config);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let wait = MockLifecycleGate::new();
    overrides.set_wait_process_lifecycle_gate(wait.clone());
    let task = AbortOnDropHandle::new(tokio::spawn({
        let config = Arc::clone(&config);
        let overrides = Arc::clone(&overrides);
        async move {
            let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
            let mut telemetry = test_telemetry(&config, &context);
            if let Some(kind) = kind {
                let sandbox = create_overridden_sandbox(overrides).await;
                execute_reused_sandbox(
                    ReusedSandboxRun {
                        sandbox_id: sandbox.id().parse().unwrap(),
                        factory: &factory,
                        params: &params,
                        source_ip: sandbox.source_ip().to_string(),
                        sandbox,
                        workspace_image: None,
                        kind,
                    },
                    &context,
                    &config,
                    RunStart {
                        restore_guest_state: true,
                        reuse_result: SandboxReuseResult::Reused,
                        workspace_reuse_result: WorkspaceReuseResult::SandboxReused,
                        prev_storage: None,
                    },
                    &mut telemetry,
                    PreparedRunInputs::new(
                        RunControls::new(CancellationToken::new(), None),
                        prepare_run_payload_for_run(&context).unwrap(),
                    ),
                )
                .await
            } else {
                execute_new_sandbox(
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
                .unwrap()
            }
        }
    }));

    let mut registration = accept_application(&listener).await;
    wait.wait_entered(1, WAIT)
        .await
        .expect("guest process must start before the registration receipt");
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    assert!(
        registration.read(&mut [0]).now_or_never().is_none(),
        "spawn must not depend on the receipt exchange timing out"
    );

    // Cleanup keeps its existing synchronous observation; finish it independently.
    drop(registration);
    wait.release_one();
    drop(accept_application(&listener).await);
    let outcome = tokio::time::timeout(WAIT, task).await.unwrap().unwrap();
    assert_eq!(outcome.exit_code(), 0);
    if kind.is_none() {
        assert_eq!(
            outcome.workspace_reuse_result,
            Some(WorkspaceReuseResult::Reused)
        );
    }
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn exact_reuse_spawns_before_registry_receipt() {
    assert_spawn_before_receipt(Some(IdleSandboxKind::Exact)).await;
}

#[tokio::test]
async fn blank_reuse_spawns_before_registry_receipt() {
    assert_spawn_before_receipt(Some(IdleSandboxKind::Blank)).await;
}

#[tokio::test]
async fn workspace_restore_spawns_before_registry_receipt() {
    assert_spawn_before_receipt(None).await;
}
