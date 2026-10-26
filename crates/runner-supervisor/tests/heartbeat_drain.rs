use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use api_contracts::generated::routes::runners::heartbeat::HEARTBEAT;
use raw_http_test_support::raw_http::{RawHttpAction, RawHttpTestServer, http_response};
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_lifecycle::active_runs::ActiveRuns;
use runner_lifecycle::home_image_cache::snapshot::HomeCacheStateSnapshot;
use runner_lifecycle::idle_pool::{IdlePool, IdlePoolConfig};
use runner_lifecycle::lifecycle::RunnerMode;
use runner_lifecycle::resource_budget::ResourceBudget;
use runner_provider::{
    ApiProvider, ApiProviderConfig, BuiltinFirewallCatalogCachePaths, HttpClient, HttpClientConfig,
    JobProvider, RunCancellationRegistry,
};
use runner_supervisor::heartbeat::{HeartbeatContext, HeartbeatContextInit, HeartbeatController};
use tokio_util::sync::CancellationToken;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

struct Harness {
    controller: HeartbeatController,
    provider: Arc<ApiProvider>,
    server: RawHttpTestServer,
    directory: tempfile::TempDir,
    identity: RunnerProcessIdentity,
}

impl Harness {
    async fn new(actions: Vec<RawHttpAction>) -> TestResult<Self> {
        let directory = tempfile::tempdir()?;
        let server = RawHttpTestServer::spawn(actions).await;
        let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 7)?;
        let provider = ApiProvider::new(
            HttpClient::new(HttpClientConfig {
                api_url: server.url(),
                vercel_bypass: None,
                client_session_id: "heartbeat-drain-test".into(),
                runner_version: env!("CARGO_PKG_VERSION"),
            })?,
            "synthetic-runner-token".into(),
            ApiProviderConfig {
                ably_side_message_handler: None,
                runner_identity: identity,
                runner_hostname: None,
                group: "drain-test".into(),
                supported_profiles: vec![],
                installed_okou_cli: None,
            },
            BuiltinFirewallCatalogCachePaths {
                cache_path: directory.path().join("catalog.json"),
                lock_path: directory.path().join("catalog.lock"),
            },
            CancellationToken::new(),
            RunCancellationRegistry::new(),
        );
        let controller = HeartbeatController::new(HeartbeatContext::new(HeartbeatContextInit {
            idle_pool: &Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
                max_idle: 0,
            }))),
            runner_identity: identity,
            runner_hostname: None,
            group: "drain-test",
            profiles: &BTreeMap::new(),
            budget: &Arc::new(ResourceBudget::new(8, 32768, 1.0, 4)),
            provider: provider.clone(),
            active_runs: &ActiveRuns::new(Arc::new(tokio::sync::Notify::new())),
            home_cache_snapshot: HomeCacheStateSnapshot::new(),
            sandbox_op_reporter: None,
        }));
        Ok(Self {
            controller,
            provider,
            server,
            directory,
            identity,
        })
    }

    async fn next_send_and_finish(mut self) -> TestResult {
        self.controller.request(RunnerMode::Stopping)?;
        observe(&mut self.server, self.identity, 2, "stopping").await?;
        tokio::time::timeout(Duration::from_secs(2), self.controller.drain()).await??;
        tokio::time::timeout(Duration::from_secs(2), self.controller.drain()).await??;
        self.provider.shutdown().await;
        self.server.assert_finished().await;
        drop(self.directory);
        Ok(())
    }
}

async fn observe(
    server: &mut RawHttpTestServer,
    identity: RunnerProcessIdentity,
    sequence: u64,
    mode: &str,
) -> TestResult {
    let request = server.next_request("heartbeat delivery").await;
    assert!(request.starts_with(&format!("POST {} ", HEARTBEAT.path)));
    let (_, body) = request
        .split_once("\r\n\r\n")
        .ok_or_else(|| std::io::Error::other("missing HTTP body"))?;
    let state: serde_json::Value = serde_json::from_str(body)?;
    assert_eq!(
        state.get("runnerId").and_then(serde_json::Value::as_str),
        Some(identity.runner_id().to_string().as_str())
    );
    assert_eq!(
        state
            .get("snapshotGeneration")
            .and_then(serde_json::Value::as_u64),
        Some(7)
    );
    assert_eq!(
        state
            .get("snapshotSequence")
            .and_then(serde_json::Value::as_u64),
        Some(sequence)
    );
    assert_eq!(
        state.get("mode").and_then(serde_json::Value::as_str),
        Some(mode)
    );
    Ok(())
}

async fn cancelled_drain(after_http_admission: bool) -> TestResult {
    let (release, receiver) = tokio::sync::oneshot::channel();
    let mut harness = Harness::new(vec![
        RawHttpAction::WaitThenRespond {
            release: receiver,
            response: http_response("204 No Content", b""),
        },
        RawHttpAction::Respond(http_response("204 No Content", b"")),
    ])
    .await?;
    harness.controller.request(RunnerMode::Running)?;
    harness.controller.request(RunnerMode::Draining)?;
    if after_http_admission {
        observe(&mut harness.server, harness.identity, 1, "running").await?;
    }
    let mut first = Box::pin(harness.controller.drain());
    assert!(futures_util::poll!(first.as_mut()).is_pending());
    drop(first);
    let mut retry = Box::pin(harness.controller.drain());
    assert!(
        futures_util::poll!(retry.as_mut()).is_pending(),
        "cancelled drain must retain the active heartbeat send"
    );
    if !after_http_admission {
        observe(&mut harness.server, harness.identity, 1, "running").await?;
    }
    release
        .send(())
        .map_err(|()| std::io::Error::other("heartbeat response receiver dropped"))?;
    tokio::time::timeout(Duration::from_secs(2), retry).await??;
    harness.next_send_and_finish().await
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_drain_before_send_poll_retains_delivery() -> TestResult {
    cancelled_drain(false).await
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_drain_after_http_admission_retains_delivery() -> TestResult {
    cancelled_drain(true).await
}

#[tokio::test(flavor = "current_thread")]
async fn drain_keeps_provider_failure_best_effort_and_sequence() -> TestResult {
    let mut harness = Harness::new(vec![
        RawHttpAction::Respond(http_response("503 Service Unavailable", b"unavailable")),
        RawHttpAction::Respond(http_response("204 No Content", b"")),
    ])
    .await?;
    harness.controller.request(RunnerMode::Running)?;
    observe(&mut harness.server, harness.identity, 1, "running").await?;
    tokio::time::timeout(Duration::from_secs(2), harness.controller.drain()).await??;
    harness.next_send_and_finish().await
}

#[tokio::test(flavor = "current_thread")]
async fn controller_drop_still_aborts_pending_http_delivery() -> TestResult {
    let Harness {
        mut controller,
        provider,
        mut server,
        directory,
        identity,
    } = Harness::new(vec![RawHttpAction::WaitForDisconnect]).await?;
    controller.request(RunnerMode::Running)?;
    observe(&mut server, identity, 1, "running").await?;
    drop(controller);
    server.assert_finished().await;
    provider.shutdown().await;
    drop(directory);
    Ok(())
}
