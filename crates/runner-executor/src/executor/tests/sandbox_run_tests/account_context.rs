use super::*;
use runner_provider::{
    ApiProvider, ApiProviderConfig, BuiltinFirewallCatalogCachePaths, JobProvider,
    RunCancellationRegistry,
};
use runner_types::types::{ConnectorRuntimeTargetRegistration, FirewallEntry, NetworkPolicy};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn runtime_account_binding_updates_the_private_guest_context() {
    let dir = tempfile::tempdir().unwrap();
    let (mut config, server) = test_executor_config_with_startup_api(dir.path()).await;
    let provider = ApiProvider::new(
        config.http.clone(),
        "runner-token".into(),
        ApiProviderConfig {
            ably_side_message_handler: None,
            runner_identity: runner_host::runner_process_identity::RunnerProcessIdentity::new(
                uuid::Uuid::new_v4(),
                1,
            )
            .unwrap(),
            runner_hostname: None,
            group: "test".into(),
            supported_profiles: vec!["vm0/default".into()],
            installed_okou_cli: None,
        },
        BuiltinFirewallCatalogCachePaths {
            cache_path: dir.path().join("catalog.json"),
            lock_path: dir.path().join("catalog.lock"),
        },
        CancellationToken::new(),
        RunCancellationRegistry::new(),
    );
    let handle = provider.connector_runtime_sync_handle();
    config.connector_runtime_sync = Some(handle.clone());
    let mut context = minimal_context();
    let source_a = "550e8400-e29b-41d4-a716-446655440001";
    let source_b = "550e8400-e29b-41d4-a716-446655440002";
    let registration = ConnectorRuntimeTargetRegistration::Builtin {
        connector_slug: "slack".into(),
        base_url_vars: None,
        source_id: Some(source_a.into()),
    };
    let target = registration.target();
    context.connector_runtime_targets = vec![registration];
    context.firewalls = Some(vec![FirewallEntry::Builtin {
        name: "slack".into(),
        base_url_vars: None,
        source_id: Some(source_a.into()),
    }]);
    let policy = NetworkPolicy {
        allow: vec![],
        deny: vec![],
        ask: vec![],
        unknown_policy: "ask".into(),
    };
    context.network_policies = Some(HashMap::from([("slack".into(), policy.clone())]));
    let switch = server.mock(|when, then| {
        when.method(httpmock::Method::POST).path(format!(
            "/api/runners/runs/{}/connector-runtime/sync",
            context.run_id
        ));
        then.status(200).json_body(serde_json::json!({"results": [{
            "target": target,
            "state": "available",
            "networkPolicy": policy,
            "accountBinding": {"connectionId": source_b, "baseUrlVars": {}}
        }]}));
    });
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let wait_gate = MockLifecycleGate::new();
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let run_id = context.run_id;
    let path = guest_connector_account_context_file_path(run_id).unwrap();
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
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .unwrap();
    // The Guest boundary received A during ordinary bootstrap.
    let bootstrap = overrides.private_write_files_calls();
    let initial: serde_json::Value =
        serde_json::from_slice(&bootstrap[0].files[0].content).unwrap();
    assert_eq!(initial["targets"][0]["connectionId"], source_a);
    handle.notify_connector_runtime_sync(run_id, target).await;
    let published = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(write) = overrides
                .private_write_file_calls()
                .into_iter()
                .find(|write| write.path == path)
            {
                break write;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("published account should reach the Guest private-file boundary");
    let current: serde_json::Value = serde_json::from_slice(&published.content).unwrap();
    assert_eq!(
        current,
        serde_json::json!({
            "schemaVersion": 1,
            "targets": [{"kind": "builtin", "connectorSlug": "slack", "connectionId": source_b}]
        })
    );
    switch.assert_calls(1);
    wait_gate.release_one();
    let (outcome, _) = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(outcome.exit_code(), 0);
    provider.shutdown().await;
}
