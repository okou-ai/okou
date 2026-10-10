use super::super::super::*;
use super::super::support::{
    assert_run_exits_within, mock_run_config, mock_run_config_with_runtime, shutdown,
    test_profiles, wait_status_mode,
};
use crate::test_support::ShutdownRecordingRuntime;
use async_trait::async_trait;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

struct FactoryFailingRuntime {
    create_calls: Arc<AtomicUsize>,
    shutdowns: Arc<AtomicUsize>,
}

#[async_trait]
impl sandbox::SandboxRuntime for FactoryFailingRuntime {
    async fn create_factory(
        &self,
        _config: sandbox::FactoryConfig,
    ) -> sandbox::Result<Box<dyn sandbox::SandboxFactory>> {
        self.create_calls.fetch_add(1, Ordering::SeqCst);
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
    let (config, env) =
        mock_run_config_with_runtime(test_profiles(), 8, 32768, 4, Box::new(runtime));
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    tokio::time::timeout(Duration::from_secs(2), entered_rx)
        .await
        .expect("factory startup should be entered")
        .expect("factory startup should report entry");
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
    let runtime = FactoryFailingRuntime {
        create_calls: Arc::clone(&create_calls),
        shutdowns: Arc::clone(&runtime_shutdowns),
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
