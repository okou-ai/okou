use super::super::super::*;
use super::super::support::{
    assert_run_exits_within, mock_run_config, mock_run_config_with_runtime, shutdown,
    test_profiles, wait_status_mode,
};
use crate::ingress::{IngressConfig, test_support::PublicIngress};
use crate::test_support::ShutdownRecordingRuntime;
use async_trait::async_trait;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

struct StartupRecordingRuntime {
    create_calls: Arc<AtomicUsize>,
    shutdowns: Arc<AtomicUsize>,
    fail_factory: bool,
}

#[async_trait]
impl sandbox::SandboxRuntime for StartupRecordingRuntime {
    async fn create_factory(
        &self,
        _config: sandbox::FactoryConfig,
    ) -> sandbox::Result<Box<dyn sandbox::SandboxFactory>> {
        self.create_calls.fetch_add(1, Ordering::SeqCst);
        if !self.fail_factory {
            return Ok(Box::new(sandbox_mock::MockSandboxFactory::new()));
        }
        Err(sandbox::SandboxError::Initialization {
            phase: sandbox::SandboxInitializationPhase::Factory,
            message: "factory failed".into(),
        })
    }

    async fn shutdown(&mut self) {
        self.shutdowns.fetch_add(1, Ordering::SeqCst);
    }
}

struct BlockingFactoryRuntime {
    entered: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    release: tokio::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
}

impl BlockingFactoryRuntime {
    fn new(
        entered: tokio::sync::oneshot::Sender<()>,
        release: tokio::sync::oneshot::Receiver<()>,
    ) -> Self {
        Self {
            entered: Mutex::new(Some(entered)),
            release: tokio::sync::Mutex::new(Some(release)),
        }
    }
}

#[async_trait]
impl sandbox::SandboxRuntime for BlockingFactoryRuntime {
    async fn create_factory(
        &self,
        _config: sandbox::FactoryConfig,
    ) -> sandbox::Result<Box<dyn sandbox::SandboxFactory>> {
        if let Some(entered) = self
            .entered
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let _ = entered.send(());
        }
        let release = {
            let mut guard = self.release.lock().await;
            guard.take().expect("factory release should be configured")
        };
        let _ = release.await;
        Ok(Box::new(sandbox_mock::MockSandboxFactory::new()))
    }

    async fn shutdown(&mut self) {}
}

async fn status_mode_if_exists(status_path: &std::path::Path) -> Option<String> {
    let raw = match tokio::fs::read_to_string(status_path).await {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => panic!("failed to read status file {}: {e}", status_path.display()),
    };
    let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
    status
        .get("mode")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

#[tokio::test]
async fn startup_does_not_publish_running_before_factories_are_ready() {
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let runtime = BlockingFactoryRuntime::new(entered_tx, release_rx);
    let (mut config, env) =
        mock_run_config_with_runtime(test_profiles(), 8, 32768, 4, Box::new(runtime));
    let scan = StartLoopTestGate::default();
    config.test_hooks.after_initial_home_cache_scan = Some(scan.clone());
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    tokio::time::timeout(Duration::from_secs(2), entered_rx)
        .await
        .expect("factory startup should be entered")
        .expect("factory startup should report entry");
    scan.wait_entered(
        Duration::from_secs(5),
        "cache scan must overlap factory startup",
    )
    .await;
    assert_ne!(
        status_mode_if_exists(&status_path).await.as_deref(),
        Some("running"),
        "runner must not publish running before factories are ready",
    );
    assert_eq!(
        status_mode_if_exists(&status_path).await.as_deref(),
        Some("starting"),
        "runner should publish startup progress while factories are not ready",
    );

    release_tx
        .send(())
        .expect("runner should still be waiting for factory release");
    assert_eq!(
        status_mode_if_exists(&status_path).await.as_deref(),
        Some("starting")
    );
    scan.release();
    wait_status_mode(&status_path, "running", Duration::from_secs(5)).await;
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn startup_readiness_blocks_running_and_discovery() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    env.handle.block_startup_readiness();
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    assert!(
        env.handle
            .wait_startup_readiness_entered(Duration::from_secs(2))
            .await,
        "startup readiness should be entered",
    );
    assert_eq!(
        status_mode_if_exists(&status_path).await.as_deref(),
        Some("starting"),
        "runner should publish starting while provider readiness is blocked",
    );
    assert_eq!(env.handle.startup_readiness_calls(), 1);
    assert_eq!(
        env.handle.discover_started_count(),
        0,
        "provider discovery must not start before startup readiness completes",
    );

    env.handle.release_startup_readiness();
    wait_status_mode(&status_path, "running", Duration::from_secs(5)).await;
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn stop_during_startup_readiness_exits_without_running() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    env.handle.block_startup_readiness();
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    assert!(
        env.handle
            .wait_startup_readiness_entered(Duration::from_secs(2))
            .await,
        "startup readiness should be entered",
    );
    assert_eq!(
        status_mode_if_exists(&status_path).await.as_deref(),
        Some("starting"),
        "runner should publish starting while provider readiness is blocked",
    );

    env.trigger_stopping().await;
    assert_eq!(
        *env.mode_tx.borrow(),
        RunnerMode::Stopping,
        "startup stop must not be lost while provider readiness is blocked",
    );

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "startup readiness stop should exit without entering Running",
    )
    .await;
    wait_status_mode(&status_path, "stopped", Duration::from_secs(5)).await;
}

#[tokio::test]
async fn startup_readiness_failure_stops_status_and_cleans_startup_resources() {
    let runtime_shutdowns = Arc::new(AtomicUsize::new(0));
    let factory_creates = Arc::new(AtomicUsize::new(0));
    let runtime =
        ShutdownRecordingRuntime::new(Arc::clone(&runtime_shutdowns), Arc::clone(&factory_creates));
    let (config, env) =
        mock_run_config_with_runtime(test_profiles(), 8, 32768, 4, Box::new(runtime));
    env.handle
        .fail_startup_readiness("provider readiness failed");
    let status_path = env._temp_dir.path().join("status.json");

    let error = run(config)
        .await
        .expect_err("provider startup readiness should fail");

    assert!(
        error.to_string().contains("provider readiness failed"),
        "unexpected error: {error}"
    );
    assert_eq!(env.handle.startup_readiness_calls(), 1);
    assert_eq!(
        env.handle.discover_started_count(),
        0,
        "provider discovery must not start after startup readiness failure",
    );
    assert_eq!(runtime_shutdowns.load(Ordering::SeqCst), 1);
    assert_eq!(factory_creates.load(Ordering::SeqCst), 0);
    wait_status_mode(&status_path, "stopped", Duration::from_secs(5)).await;
}

#[tokio::test]
async fn drain_during_startup_exits_after_readiness_without_running() {
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let runtime = BlockingFactoryRuntime::new(entered_tx, release_rx);
    let (config, env) =
        mock_run_config_with_runtime(test_profiles(), 8, 32768, 4, Box::new(runtime));
    let run_handle = tokio::spawn(run(config));

    tokio::time::timeout(Duration::from_secs(2), entered_rx)
        .await
        .expect("factory startup should be entered")
        .expect("factory startup should report entry");

    env.drain();
    env.resume();
    assert_eq!(
        *env.mode_tx.borrow(),
        RunnerMode::Draining,
        "resume before startup readiness must not open admission",
    );

    release_tx
        .send(())
        .expect("runner should still be waiting for factory release");
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "startup drain should exit without entering Running",
    )
    .await;
}

#[tokio::test]
async fn stop_during_startup_exits_after_readiness_without_running() {
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let runtime = BlockingFactoryRuntime::new(entered_tx, release_rx);
    let (config, env) =
        mock_run_config_with_runtime(test_profiles(), 8, 32768, 4, Box::new(runtime));
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    tokio::time::timeout(Duration::from_secs(2), entered_rx)
        .await
        .expect("factory startup should be entered")
        .expect("factory startup should report entry");

    env.trigger_stopping().await;
    assert_eq!(
        *env.mode_tx.borrow(),
        RunnerMode::Stopping,
        "startup stop must not be lost before factories become ready",
    );

    release_tx
        .send(())
        .expect("runner should still be waiting for factory release");
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "startup stop should exit without entering Running",
    )
    .await;
    wait_status_mode(&status_path, "stopped", Duration::from_secs(5)).await;
}

#[tokio::test]
async fn factory_startup_failure_stops_status_and_cleans_startup_resources() {
    let create_calls = Arc::new(AtomicUsize::new(0));
    let runtime_shutdowns = Arc::new(AtomicUsize::new(0));
    let runtime = StartupRecordingRuntime {
        create_calls: Arc::clone(&create_calls),
        shutdowns: Arc::clone(&runtime_shutdowns),
        fail_factory: true,
    };
    let (config, env) =
        mock_run_config_with_runtime(test_profiles(), 8, 32768, 4, Box::new(runtime));
    let status_path = env._temp_dir.path().join("status.json");

    let error = run(config).await.expect_err("factory startup should fail");

    assert!(
        error.to_string().contains("factory failed"),
        "unexpected error: {error}"
    );
    assert_eq!(create_calls.load(Ordering::SeqCst), 1);
    assert_eq!(runtime_shutdowns.load(Ordering::SeqCst), 1);
    wait_status_mode(&status_path, "stopped", Duration::from_secs(5)).await;
}

async fn configure_public_ingress(config: &mut RunConfig) -> PublicIngress {
    use std::os::unix::fs::PermissionsExt;
    let directory = config.paths.home.ingress_dir();
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o710)).unwrap();
    let path = directory.join(format!("{}.sock", config.runner.identity.runner_id()));
    let peer = PublicIngress::start(path).await;
    config.ingress = Some(IngressConfig {
        directory,
        hostname: crate::ingress::test_support::HOST.into(),
        token: crate::ingress::test_support::TOKEN.into(),
    });
    config.test_hooks.ingress_client = Some(peer.client.clone());
    peer
}

#[tokio::test]
async fn public_ingress_gates_running_but_later_loss_does_not_stop_runs() {
    use super::super::support::{minimal_context, push_job};
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let peer = configure_public_ingress(&mut config).await;
    let socket = config
        .paths
        .home
        .ingress_dir()
        .join(format!("{}.sock", config.runner.identity.runner_id()));
    let status = env._temp_dir.path().join("status.json");
    let runner = tokio::spawn(run(config));
    peer.wait_connected().await;
    assert_eq!(
        status_mode_if_exists(&status).await.as_deref(),
        Some("starting")
    );
    assert_eq!(env.handle.heartbeat_count(), 0);
    assert_eq!(env.handle.discover_started_count(), 0);
    peer.allow_health();
    wait_status_mode(&status, "running", Duration::from_secs(5)).await;
    peer.shutdown().await;

    // The public TLS peer is gone, but the same Runner still executes work.
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let completed = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(completed.exit_code, 0);
    shutdown(&env, runner).await;
    assert!(!socket.exists(), "joined shutdown removes its listener");
}

#[tokio::test]
async fn public_ingress_startup_failure_and_cancellation_roll_back() {
    for cancelled in [false, true] {
        let shutdowns = Arc::new(AtomicUsize::new(0));
        let creates = Arc::new(AtomicUsize::new(0));
        let runtime = StartupRecordingRuntime {
            create_calls: creates,
            shutdowns: shutdowns.clone(),
            fail_factory: false,
        };
        let (mut config, env) =
            mock_run_config_with_runtime(test_profiles(), 8, 32768, 4, Box::new(runtime));
        let peer = configure_public_ingress(&mut config).await;
        let socket = config
            .paths
            .home
            .ingress_dir()
            .join(format!("{}.sock", config.runner.identity.runner_id()));
        let status = env._temp_dir.path().join("status.json");
        let runner = tokio::spawn(run(config));
        peer.wait_connected().await;
        assert_eq!(
            status_mode_if_exists(&status).await.as_deref(),
            Some("starting")
        );
        let mut peer = Some(peer);
        if cancelled {
            env.trigger_stopping().await;
        } else {
            peer.take().unwrap().shutdown().await;
        }
        let result = tokio::time::timeout(Duration::from_secs(5), runner)
            .await
            .unwrap()
            .unwrap();
        if cancelled {
            result.unwrap();
        } else {
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("verify public Runner ingress")
            );
        }
        if let Some(peer) = peer {
            peer.shutdown().await;
        }
        assert_eq!(
            status_mode_if_exists(&status).await.as_deref(),
            Some("stopped")
        );
        assert_eq!(env.handle.heartbeat_count(), 0);
        assert_eq!(env.handle.discover_started_count(), 0);
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
        assert!(!socket.exists(), "startup rollback joins listener cleanup");
        env.shutdown_startup_api().await;
    }
}
