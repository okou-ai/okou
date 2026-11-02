use super::*;
use runner_types::types::{ConnectorRuntimeAccountBinding, SecretConnectorMetadata};

#[tokio::test]
async fn builtin_account_binding_cannot_replace_a_custom_owned_firewall() {
    let harness = RegistryHarness::new().await;
    let firewalls = [custom_runtime_firewall(
        "550e8400-e29b-41d4-a716-446655440000",
        "slack",
    )];
    let targets = [ConnectorRuntimeTargetRegistration::Builtin {
        connector_slug: "slack".into(),
        base_url_vars: None,
        source_id: None,
    }];
    harness
        .handle
        .register_sandbox(
            "10.200.0.2",
            &SandboxRegistration {
                firewalls: Some(&firewalls),
                connector_runtime_targets: Some(&targets),
                ..base_registration()
            },
        )
        .await
        .unwrap();
    let before = tokio::fs::read(harness.registry_path()).await.unwrap();
    assert!(
        harness
            .handle
            .apply_connector_runtime_updates_if_run_matches(
                "10.200.0.2",
                "run-test",
                &[ConnectorRuntimeRegistryUpdate::BuiltinAvailable {
                    connector_slug: "slack".into(),
                    network_policy: policy(&[], &[], &[], "ask"),
                    account_binding: Some(ConnectorRuntimeAccountBinding {
                        source_id: "550e8400-e29b-41d4-a716-446655440002".into(),
                        base_url_vars: HashMap::new(),
                    }),
                }]
            )
            .await
            .is_err()
    );
    assert_eq!(
        tokio::fs::read(harness.registry_path()).await.unwrap(),
        before
    );
}

#[tokio::test]
async fn account_binding_replaces_credential_alias_sources_for_its_connector() {
    let harness = RegistryHarness::new().await;
    let source_a = "550e8400-e29b-41d4-a716-446655440001";
    let source_b = "550e8400-e29b-41d4-a716-446655440002";
    let firewalls = [FirewallEntry::Builtin {
        name: "slack".into(),
        base_url_vars: None,
        source_id: Some(source_a.into()),
    }];
    let targets = [ConnectorRuntimeTargetRegistration::Builtin {
        connector_slug: "slack".into(),
        base_url_vars: None,
        source_id: Some(source_a.into()),
    }];
    let aliases = HashMap::from([
        ("SLACK_TOKEN".to_string(), "slack".to_string()),
        ("SLACK_LEGACY_TOKEN".to_string(), "slack".to_string()),
        ("GITHUB_TOKEN".to_string(), "github".to_string()),
    ]);
    let metadata = HashMap::from([
        (
            "SLACK_TOKEN".into(),
            SecretConnectorMetadata {
                source_type: "connector".into(),
                source_user_id: Some("member".into()),
                source_id: Some(source_a.into()),
                metadata_key: Some("accessToken".into()),
            },
        ),
        (
            "GITHUB_TOKEN".into(),
            SecretConnectorMetadata {
                source_type: "connector".into(),
                source_user_id: Some("member".into()),
                source_id: Some(source_a.into()),
                metadata_key: None,
            },
        ),
    ]);
    let shared_policy = policy(&["read"], &["delete"], &["write"], "ask");
    let policies = HashMap::from([("slack".to_string(), shared_policy.clone())]);
    harness
        .handle
        .register_sandbox(
            "10.200.0.2",
            &SandboxRegistration {
                firewalls: Some(&firewalls),
                connector_runtime_targets: Some(&targets),
                network_policies: Some(&policies),
                secret_connector_map: Some(&aliases),
                secret_connector_metadata_map: Some(&metadata),
                ..base_registration()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        harness
            .handle
            .apply_connector_runtime_updates_if_run_matches(
                "10.200.0.2",
                "run-test",
                &[ConnectorRuntimeRegistryUpdate::BuiltinAvailable {
                    connector_slug: "slack".into(),
                    network_policy: shared_policy.clone(),
                    account_binding: Some(ConnectorRuntimeAccountBinding {
                        source_id: source_b.into(),
                        base_url_vars: HashMap::new(),
                    }),
                }]
            )
            .await
            .unwrap(),
        Some(vec![true])
    );
    let value: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(harness.registry_path()).await.unwrap()).unwrap();
    let sandbox = &value["sandboxes"]["10.200.0.2"];
    let updated = &sandbox["secretConnectorMetadataMap"];
    assert_eq!(
        updated["SLACK_TOKEN"],
        serde_json::json!({
            "sourceType": "connector", "sourceUserId": "member", "sourceId": source_b, "metadataKey": "accessToken"
        })
    );
    assert_eq!(
        updated["SLACK_LEGACY_TOKEN"],
        serde_json::json!({"sourceType": "connector", "sourceId": source_b})
    );
    assert_eq!(
        updated["GITHUB_TOKEN"],
        serde_json::json!(metadata["GITHUB_TOKEN"])
    );
    assert_eq!(sandbox["secretConnectorMap"], serde_json::json!(aliases));
    assert_eq!(
        sandbox["networkPolicies"]["slack"],
        serde_json::json!(shared_policy)
    );
}
