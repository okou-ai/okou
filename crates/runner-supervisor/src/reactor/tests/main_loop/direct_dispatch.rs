mod continuation;
mod fallback;
mod finalizing_failures;

use super::super::super::*;
use super::super::support::{
    minimal_context, mock_run_config, mock_run_config_with_overrides, push_job, seed_idle_pool,
    shutdown, test_profiles, wait_budget_count, wait_cancel_token_removed, wait_status_mode,
};
use crate::ingress::test_support::{HOST, PublicIngress, TOKEN};
use serde_json::{Value, json};
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// A reporting/control provider with no local discovery capability.
struct SuppliedProvider(Arc<dyn JobProvider>, Option<StartLoopTestGate>);

#[async_trait::async_trait]
impl JobProvider for SuppliedProvider {
    async fn prepare_startup_readiness(&self) -> runner_provider::ProviderResult<()> {
        self.0.prepare_startup_readiness().await
    }

    async fn bind_supplied(
        &self,
        context: runner_types::types::ExecutionContext,
    ) -> runner_provider::ProviderResult<runner_provider::ExecutionJob> {
        if let Some(gate) = &self.1 {
            gate.enter_and_wait().await;
        }
        self.0.bind_supplied(context).await
    }

    fn completion_report_timing(&self) -> runner_provider::CompletionReportTiming {
        self.0.completion_report_timing()
    }

    async fn complete(
        &self,
        request: runner_types::types::CompleteRequest,
        auth: runner_provider::CompletionAuth,
    ) {
        self.0.complete(request, auth).await;
    }

    async fn heartbeat(
        &self,
        state: &runner_types::types::HeartbeatState,
    ) -> runner_provider::ProviderResult<()> {
        self.0.heartbeat(state).await
    }

    async fn shutdown(&self) {
        self.0.shutdown().await;
    }
}

fn envelope(identity: RunnerProcessIdentity, run_id: RunId) -> Value {
    json!({
        "runnerId": identity.runner_id(), "heartbeatGeneration": identity.heartbeat_generation(),
        "profile": "vm0/default", "notAfter": crate::ingress::dispatch::now_ms() + 60_000,
        "executionContext": {
            "runId": run_id, "prompt": "supplied complete input", "sandboxToken": "run-scoped-token",
            "cliAgentType": "claude-code", "platformEnvironment": {}, "connectorRuntimeTargets": [],
            "contentBundles": { "format": "tar-gzip-v1", "skills": [] }
        }
    })
}

#[tokio::test]
async fn supplied_http_caller_disconnect_does_not_cancel_accepted_execution() {
    let gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(gate.clone());
    let (mut config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    config.provider.provider = Arc::new(SuppliedProvider(config.provider.provider.clone(), None));
    let peer = super::startup::configure_public_ingress(&mut config).await;
    let identity = config.runner.identity;
    let socket = config
        .paths
        .home
        .ingress_dir()
        .join(format!("{}.sock", identity.runner_id()));
    let runner = tokio::spawn(run(config));
    peer.wait_connected().await;
    peer.allow_health();
    wait_status_mode(
        &env._temp_dir.path().join("status.json"),
        "running",
        Duration::from_secs(5),
    )
    .await;
    let run_id = RunId::new_v4();
    let body = envelope(identity, run_id).to_string();
    let mut stream = tokio::net::UnixStream::connect(&socket).await.unwrap();
    stream.write_all(format!("POST /runners/{}/control/runs/{run_id}/dispatch HTTP/1.1\r\nHost: {HOST}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", identity.runner_id(), body.len()).as_bytes()).await.unwrap();
    // Observe real executor entry, then discard the unread HTTP response.
    gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
    drop(stream);
    assert_eq!(
        client(&socket, identity, run_id, &body).await.2["disposition"],
        "accepted"
    );
    assert!(
        !env.cancel_tokens
            .handle(run_id)
            .await
            .unwrap()
            .is_cancelled()
    );
    gate.release_one();
    assert_eq!(
        env.handle
            .wait_completion(run_id, Duration::from_secs(10))
            .await
            .unwrap()
            .exit_code,
        0
    );
    assert_eq!(env.handle.completions.lock().unwrap().len(), 1);
    assert!(env.handle.claim_candidates().is_empty());
    assert_eq!(env.handle.discover_started_count(), 0);
    peer.shutdown().await;
    shutdown(&env, runner).await;
}

#[tokio::test]
async fn supplied_http_activation_panic_uses_existing_terminal_recovery() {
    assert_supplied_panic(OuterJobPanicPoint::JobActivation).await;
}

#[tokio::test]
async fn supplied_http_finalizing_preparation_panic_completes_once_without_a_sandbox() {
    assert_supplied_panic(OuterJobPanicPoint::AcceptedWithoutSandbox).await;
}

async fn assert_supplied_panic(point: OuterJobPanicPoint) {
    let (mut config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    config.test_hooks.outer_job_panic = Some(point);
    config.provider.provider = Arc::new(SuppliedProvider(config.provider.provider.clone(), None));
    let source = RunId::new_v4();
    let producer = (point == OuterJobPanicPoint::AcceptedWithoutSandbox).then(|| {
        env.active_runs.register(
            source,
            Some("thread:finalizing-panic".into()),
            "vm0/default".into(),
        )
    });
    let budget = config.capacity.budget.clone();
    let peer = super::startup::configure_public_ingress(&mut config).await;
    let identity = config.runner.identity;
    let socket = config
        .paths
        .home
        .ingress_dir()
        .join(format!("{}.sock", identity.runner_id()));
    let runner = tokio::spawn(run(config));
    peer.wait_connected().await;
    peer.allow_health();
    wait_status_mode(
        &env._temp_dir.path().join("status.json"),
        "running",
        Duration::from_secs(5),
    )
    .await;
    let run_id = RunId::new_v4();
    let mut supplied = envelope(identity, run_id);
    if producer.is_some() {
        supplied["executionContext"]["reuseKey"] = json!("thread:finalizing-panic");
        supplied["executionContext"]["nativeContinuation"] = json!({
            "sessionId": RunId::new_v4(), "generationRunId": source, "recoveryPrompt": null
        });
    }
    let body = supplied.to_string();
    let mut stream = tokio::net::UnixStream::connect(&socket).await.unwrap();
    stream.write_all(format!("POST /runners/{}/control/runs/{run_id}/dispatch HTTP/1.1\r\nHost: {HOST}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", identity.runner_id(), body.len()).as_bytes()).await.unwrap();
    let live_runner = if producer.is_some() {
        // Finalizing preparation runs in its own task. Its panic must settle
        // the original Run while the reactor keeps serving other work.
        Some(runner)
    } else {
        assert!(
            tokio::time::timeout(Duration::from_secs(10), runner)
                .await
                .unwrap()
                .unwrap_err()
                .is_panic()
        );
        None
    };
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(
        completion.error.as_deref(),
        Some(if producer.is_some() {
            "runner panicked while preparing a finalizing successor"
        } else {
            "job activation setup panicked"
        })
    );
    assert_eq!(completion.sandbox_id, None);
    assert_eq!(env.handle.completions.lock().unwrap().len(), 1);
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    assert!(env.handle.claim_candidates().is_empty());
    assert_eq!(env.handle.discover_started_count(), 0);
    peer.shutdown().await;
    if let Some(runner) = live_runner {
        assert!(!runner.is_finished());
        shutdown(&env, runner).await;
    } else {
        env.shutdown_startup_api().await;
    }
}

#[tokio::test]
async fn supplied_http_returns_429_before_body_intake_and_retries_after_slot_recovery() {
    let (mut config, env) = mock_run_config(test_profiles(), 32, 65536, 16);
    let peer = super::startup::configure_public_ingress(&mut config).await;
    let identity = config.runner.identity;
    let socket = config
        .paths
        .home
        .ingress_dir()
        .join(format!("{}.sock", identity.runner_id()));
    env.handle.block_claims();
    let runner = tokio::spawn(run(config));
    peer.wait_connected().await;
    peer.allow_health();
    wait_status_mode(
        &env._temp_dir.path().join("status.json"),
        "running",
        Duration::from_secs(5),
    )
    .await;
    let legacy: Vec<_> = (0..4).map(|_| RunId::new_v4()).collect();
    for &id in &legacy {
        push_job(&env, id, "vm0/default", Some(minimal_context(id)));
    }
    assert!(
        env.handle
            .wait_claim_in_flight(4, Duration::from_secs(5))
            .await
    );
    let run_id = RunId::new_v4();
    let body = envelope(identity, run_id).to_string();
    let mut stream = tokio::net::UnixStream::connect(&socket).await.unwrap();
    // Withhold the body: a busy receiver must answer from headers alone,
    // without waiting for either an acceptance slot or the upload deadline.
    stream.write_all(format!("POST /runners/{}/control/runs/{run_id}/dispatch HTTP/1.1\r\nHost: {HOST}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n", identity.runner_id(), body.len()).as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(1), stream.read_to_end(&mut bytes))
        .await
        .expect("full intake must answer without waiting for a slot or request body")
        .unwrap();
    let response = String::from_utf8(bytes).unwrap();
    let (head, response_body) = response.split_once("\r\n\r\n").unwrap();
    assert!(head.starts_with("HTTP/1.1 429 "));
    assert!(!head.to_ascii_lowercase().contains("retry-after:"));
    assert_eq!(
        serde_json::from_str::<Value>(response_body).unwrap()["disposition"],
        "busy"
    );
    assert!(env.cancel_tokens.handle(run_id).await.is_none());
    env.handle.unblock_claims();
    for id in legacy {
        assert_eq!(
            env.handle
                .wait_completion(id, Duration::from_secs(10))
                .await
                .unwrap()
                .exit_code,
            0
        );
    }
    // Identical retry becomes admissible; 429 did not install a permanent rejection.
    assert_eq!(
        client(&socket, identity, run_id, &body).await.2["disposition"],
        "accepted"
    );
    assert_eq!(
        env.handle
            .wait_completion(run_id, Duration::from_secs(10))
            .await
            .unwrap()
            .exit_code,
        0
    );
    assert_eq!(env.handle.claim_candidates().len(), 4);
    peer.shutdown().await;
    shutdown(&env, runner).await;
}

#[tokio::test]
async fn supplied_http_reclaims_idle_budget_and_keeps_cancellation_through_drain() {
    let gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(gate.clone());
    let (mut config, env) = mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, overrides);
    let budget = config.capacity.budget.clone();
    seed_idle_pool(
        &env.idle_pool,
        &budget,
        "unrelated-idle",
        "vm0/default",
        2,
        4096,
    )
    .await;
    let peer = super::startup::configure_public_ingress(&mut config).await;
    let identity = config.runner.identity;
    let socket = config
        .paths
        .home
        .ingress_dir()
        .join(format!("{}.sock", identity.runner_id()));
    let runner = tokio::spawn(run(config));
    peer.wait_connected().await;
    peer.allow_health();
    wait_status_mode(
        &env._temp_dir.path().join("status.json"),
        "running",
        Duration::from_secs(5),
    )
    .await;
    let run_id = RunId::new_v4();
    let body = envelope(identity, run_id).to_string();
    assert_eq!(
        client(&socket, identity, run_id, &body).await.2["disposition"],
        "accepted"
    );
    gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
    env.drain();
    wait_status_mode(
        &env._temp_dir.path().join("status.json"),
        "draining",
        Duration::from_secs(5),
    )
    .await;
    let rejected = RunId::new_v4();
    assert_eq!(
        client(
            &socket,
            identity,
            rejected,
            &envelope(identity, rejected).to_string()
        )
        .await
        .2["disposition"],
        "rejected"
    );
    let handle = env.cancel_tokens.handle(run_id).await.unwrap();
    handle.request_hard_cancellation().await;
    gate.release_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(10))
        .await
        .unwrap();
    assert_ne!(completion.exit_code, 0);
    assert!(env.handle.claim_candidates().is_empty());
    peer.shutdown().await;
    shutdown(&env, runner).await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
}

async fn client(
    socket: &Path,
    identity: RunnerProcessIdentity,
    run_id: RunId,
    body: &str,
) -> (u16, String, Value) {
    let mut stream = tokio::net::UnixStream::connect(socket).await.unwrap();
    stream.write_all(format!("POST /runners/{}/control/runs/{run_id}/dispatch HTTP/1.1\r\nHost: {HOST}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", identity.runner_id(), body.len()).as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(15), stream.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    let response = String::from_utf8(bytes).unwrap();
    let (head, body) = response.split_once("\r\n\r\n").unwrap();
    (
        head.split_whitespace().nth(1).unwrap().parse().unwrap(),
        head.to_owned(),
        serde_json::from_str(body).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn supplied_http_executes_once_and_survives_caddy_loss_and_changed_replays() {
    let gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(gate.clone());
    let (mut config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let budget = config.capacity.budget.clone();
    let peer = super::startup::configure_public_ingress(&mut config).await;
    let identity = config.runner.identity;
    let socket = config
        .paths
        .home
        .ingress_dir()
        .join(format!("{}.sock", identity.runner_id()));
    let runner = tokio::spawn(run(config));
    peer.wait_connected().await;
    peer.allow_health();
    wait_status_mode(
        &env._temp_dir.path().join("status.json"),
        "running",
        Duration::from_secs(5),
    )
    .await;

    let run_id = RunId::new_v4();
    let body = envelope(identity, run_id).to_string();
    let (first, second) = tokio::join!(
        client(&socket, identity, run_id, &body),
        client(&socket, identity, run_id, &body)
    );
    for response in [first, second] {
        assert_eq!(response.0, 200);
        assert_eq!(response.2["disposition"], "accepted");
        assert_eq!(response.2["runId"], run_id.to_string());
        assert_eq!(response.2["runnerId"], identity.runner_id().to_string());
    }
    gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
    peer.shutdown().await;
    let handle = env.cancel_tokens.handle(run_id).await.unwrap();
    assert!(!handle.is_cancelled());
    let mut changed: Value = serde_json::from_str(&body).unwrap();
    changed["executionContext"]["prompt"] = json!("replacement input");
    assert_eq!(
        client(&socket, identity, run_id, &changed.to_string())
            .await
            .2["disposition"],
        "conflict"
    );
    // A replacement TLS proxy reaches the unchanged process and replays custody.
    let peer = PublicIngress::start(socket.clone()).await;
    peer.allow_health();
    let response = peer
        .client
        .post(format!(
            "https://{HOST}/runners/{}/control/runs/{run_id}/dispatch",
            identity.runner_id()
        ))
        .bearer_auth(TOKEN)
        .header("content-type", "application/json")
        .body(body.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.json::<Value>().await.unwrap()["disposition"],
        "accepted"
    );
    gate.release_one();
    assert_eq!(
        env.handle
            .wait_completion(run_id, Duration::from_secs(10))
            .await
            .unwrap()
            .exit_code,
        0
    );
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    assert_eq!(
        client(&socket, identity, run_id, &body).await.2["disposition"],
        "accepted"
    );
    assert!(
        env.handle.claim_candidates().is_empty(),
        "direct work never invokes Claim"
    );
    assert_eq!(env.handle.completions.lock().unwrap().len(), 1);
    peer.shutdown().await;
    shutdown(&env, runner).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
}

#[tokio::test]
async fn supplied_http_rejects_profile_and_resource_refusal_without_leaking_ownership() {
    let (mut config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = config.capacity.budget.clone();
    let peer = super::startup::configure_public_ingress(&mut config).await;
    let identity = config.runner.identity;
    let socket = config
        .paths
        .home
        .ingress_dir()
        .join(format!("{}.sock", identity.runner_id()));
    let runner = tokio::spawn(run(config));
    peer.wait_connected().await;
    peer.allow_health();
    wait_status_mode(
        &env._temp_dir.path().join("status.json"),
        "running",
        Duration::from_secs(5),
    )
    .await;
    let run_id = RunId::new_v4();
    let mut body = envelope(identity, run_id);
    body["profile"] = json!("unknown-profile");
    let body = body.to_string();
    assert_eq!(
        client(&socket, identity, run_id, &body).await.2["disposition"],
        "rejected"
    );
    assert_eq!(
        client(&socket, identity, run_id, &body).await.2["disposition"],
        "rejected"
    );
    assert!(env.cancel_tokens.handle(run_id).await.is_none());
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let full_run = RunId::new_v4();
    let body = envelope(identity, full_run).to_string();
    assert_eq!(
        client(&socket, identity, full_run, &body).await.2["disposition"],
        "rejected"
    );
    drop(lease);
    assert_eq!(
        client(&socket, identity, full_run, &body).await.2["disposition"],
        "rejected",
        "resource recovery does not alter a recorded rejection"
    );
    assert!(env.cancel_tokens.handle(full_run).await.is_none());
    assert!(env.handle.completions.lock().unwrap().is_empty());
    assert!(env.handle.claim_candidates().is_empty());
    peer.shutdown().await;
    shutdown(&env, runner).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
}
