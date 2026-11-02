use super::*;

const ACCOUNT_A: &str = "550e8400-e29b-41d4-a716-446655440001";
const ACCOUNT_B: &str = "550e8400-e29b-41d4-a716-446655440002";
const CUSTOM_ID: &str = "550e8400-e29b-41d4-a716-446655440000";

#[tokio::test]
async fn mismatched_custom_account_binding_keeps_the_published_account() {
    let server = MockServer::start();
    let run_id = RunId::new_v4();
    let (core, mut requests) = core_without_worker(&server);
    let registration = ConnectorRuntimeTargetRegistration::Custom {
        custom_connector_id: CUSTOM_ID.into(),
        source_id: Some(ACCOUNT_A.into()),
        base_url_vars: HashMap::new(),
    };
    let firewall = custom_runtime_firewall_with_source(CUSTOM_ID, Some(ACCOUNT_A));
    let reply = server.mock(|when, then| {
        when.method(POST)
            .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
        then.status(200).json_body(json!({"results": [{
            "target": registration.target(), "state": "available", "firewall": firewall,
            "networkPolicy": {"allow": [], "deny": [], "ask": [], "unknownPolicy": "ask"},
            "baseUrlVars": {}, "accountBinding": {"connectionId": ACCOUNT_B, "baseUrlVars": {}}
        }]}));
    });
    let (_dir, registry, path) = registered_runtime_registry_with_targets(
        run_id,
        &[firewall],
        &HashMap::new(),
        std::slice::from_ref(&registration),
    )
    .await;
    core.register_run(ConnectorRuntimeSyncRegistration {
        run_id,
        source_ip: "10.200.0.2",
        registry,
        targets: std::slice::from_ref(&registration),
        refreshes: None,
    })
    .await;
    let before = tokio::fs::read(&path).await.unwrap();
    let request = recv_sync_request(&mut requests).await;
    assert!(
        core.sync_connector_runtime_batch_now(run_id, &request.targets)
            .await
    );
    reply.assert_calls(1);
    assert_eq!(tokio::fs::read(&path).await.unwrap(), before);
    assert_eq!(
        core.inner.active_runs.lock().await[&run_id]
            .account_context
            .borrow()
            .targets,
        vec![registration.account_context_target()]
    );
    core.unregister_run(run_id).await;
}

#[tokio::test]
async fn builtin_account_binding_replaces_source_routing_and_refresh_registration() {
    assert_account_replacement(false).await;
}

#[tokio::test]
async fn custom_account_binding_replaces_auth_source_routing_and_refresh_registration() {
    assert_account_replacement(true).await;
}

async fn assert_account_replacement(custom: bool) {
    let server = MockServer::start();
    let run_id = RunId::new_v4();
    let vars_a = HashMap::from([("workspace".to_string(), "account-a".to_string())]);
    let vars_b = HashMap::from([("workspace".to_string(), "account-b".to_string())]);
    let registration = if custom {
        ConnectorRuntimeTargetRegistration::Custom {
            custom_connector_id: CUSTOM_ID.to_string(),
            source_id: Some(ACCOUNT_A.to_string()),
            base_url_vars: vars_a.clone(),
        }
    } else {
        ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "slack".to_string(),
            source_id: Some(ACCOUNT_A.to_string()),
            base_url_vars: Some(vars_a.clone()),
        }
    };
    let target = registration.target();
    let firewall_a = if custom {
        custom_runtime_firewall_with_source(CUSTOM_ID, Some(ACCOUNT_A))
    } else {
        FirewallEntry::Builtin {
            name: "slack".to_string(),
            source_id: Some(ACCOUNT_A.to_string()),
            base_url_vars: Some(vars_a.clone()),
        }
    };
    let mut firewall_b = if custom {
        custom_runtime_firewall_with_source(CUSTOM_ID, Some(ACCOUNT_B))
    } else {
        FirewallEntry::Builtin {
            name: "slack".to_string(),
            source_id: Some(ACCOUNT_B.to_string()),
            base_url_vars: Some(vars_b.clone()),
        }
    };
    if let FirewallEntry::Inline { firewall, .. } = &mut firewall_b {
        firewall.apis[0].auth.headers.insert(
            "Authorization".to_string(),
            "Bearer ${{ secrets.NEXT_TOKEN }}".to_string(),
        );
    }
    let name = match &firewall_a {
        FirewallEntry::Builtin { name, .. } => name.clone(),
        FirewallEntry::Inline { firewall, .. } => firewall.name.clone(),
    };
    let shared_policy = NetworkPolicy {
        allow: vec!["read".to_string()],
        deny: vec!["delete".to_string()],
        ask: vec!["write".to_string()],
        unknown_policy: "ask".to_string(),
    };
    let response = |firewall: &FirewallEntry, vars: &HashMap<String, String>, binding: bool| {
        let mut result = json!({
            "target": target,
            "state": "available",
            "networkPolicy": shared_policy,
        });
        if custom {
            result["firewall"] = json!(firewall);
            result["baseUrlVars"] = json!(vars);
        }
        if binding {
            result["accountBinding"] = json!({ "connectionId": ACCOUNT_B, "baseUrlVars": vars });
        }
        json!({ "results": [result] })
    };
    let initial_sync = server.mock(|when, then| {
        when.method(POST)
            .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
        then.status(200)
            .json_body(response(&firewall_a, &vars_a, false));
    });
    let (_dir, registry, path) = registered_runtime_registry_with_targets(
        run_id,
        &[firewall_a],
        &HashMap::from([(name.clone(), shared_policy.clone())]),
        std::slice::from_ref(&registration),
    )
    .await;
    let handle = ConnectorRuntimeSyncHandle::new(api_client_for_server(&server));
    handle
        .register_run(ConnectorRuntimeSyncRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            targets: std::slice::from_ref(&registration),
            refreshes: None,
        })
        .await;
    handle
        .notify_connector_runtime_sync(run_id, target.clone())
        .await;
    observe_current_successful_sync(&handle, run_id, target.clone())
        .await
        .wait()
        .await;
    let mut context = handle.subscribe_account_context(run_id).await.unwrap();
    assert_eq!(
        context.borrow_and_update().targets,
        vec![registration.account_context_target()]
    );
    initial_sync.delete_async().await;

    let switch = server.mock(|when, then| {
        let mut expected = json!(registration);
        if !custom {
            expected.as_object_mut().unwrap().remove("baseUrlVars");
        }
        when.method(POST)
            .json_body(json!({ "targets": [expected] }));
        then.status(200)
            .json_body(response(&firewall_b, &vars_b, true));
    });
    handle
        .notify_connector_runtime_sync(run_id, target.clone())
        .await;
    observe_current_successful_sync(&handle, run_id, target.clone())
        .await
        .wait()
        .await;
    switch.assert_calls(1);
    switch.delete_async().await;
    tokio::time::timeout(SYNC_PUBLICATION_TEST_TIMEOUT, context.changed())
        .await
        .unwrap()
        .unwrap();
    let current = context.borrow_and_update().clone();
    let expected_registration = if custom {
        ConnectorRuntimeTargetRegistration::Custom {
            custom_connector_id: CUSTOM_ID.to_string(),
            source_id: Some(ACCOUNT_B.to_string()),
            base_url_vars: vars_b.clone(),
        }
    } else {
        ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "slack".to_string(),
            source_id: Some(ACCOUNT_B.to_string()),
            base_url_vars: Some(vars_b.clone()),
        }
    };
    assert_eq!(
        current.targets,
        vec![expected_registration.account_context_target()]
    );
    let published: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
    let sandbox = &published["sandboxes"]["10.200.0.2"];
    assert_eq!(sandbox["firewalls"], json!([firewall_b]));
    assert_eq!(
        sandbox["connectorRoutingVariables"][target.log_identity()],
        json!(vars_b)
    );
    assert_eq!(sandbox["networkPolicies"][&name], json!(shared_policy));

    // A legacy policy refresh must now request and retain B, with no new binding.
    let refresh = server.mock(|when, then| {
        let mut expected = json!(expected_registration);
        if !custom {
            expected.as_object_mut().unwrap().remove("baseUrlVars");
        }
        when.method(POST)
            .json_body(json!({ "targets": [expected] }));
        then.status(200)
            .json_body(response(&firewall_b, &vars_b, false));
    });
    handle
        .notify_connector_runtime_sync(run_id, target.clone())
        .await;
    observe_current_successful_sync(&handle, run_id, target)
        .await
        .wait()
        .await;
    refresh.assert_calls(1);
    assert_eq!(*context.borrow(), current);
    assert!(!context.has_changed().unwrap());
    handle.shutdown().await;
}
