mod publication;

use super::*;
use runner_types::types::{Firewall, FirewallApi, FirewallAuth, FirewallEntry, FirewallPermission};
use std::os::unix::fs::{MetadataExt, PermissionsExt};

struct RegistryHarness {
    _dir: tempfile::TempDir,
    registry_path: PathBuf,
    handle: ProxyRegistryHandle,
}

#[derive(Debug, Eq, PartialEq)]
struct RegistryFileState {
    inode: u64,
    updated_at: i64,
}

impl RegistryHarness {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("proxy-registry.json");
        let lock_path = dir.path().join("proxy-registry.lock");
        write_empty_registry(&registry_path).await.unwrap();
        let handle = ProxyRegistryHandle::new(registry_path.clone(), lock_path);

        Self {
            _dir: dir,
            registry_path,
            handle,
        }
    }

    fn registry_path(&self) -> &Path {
        &self.registry_path
    }
}

async fn registry_file_state(path: &Path) -> RegistryFileState {
    RegistryFileState {
        inode: tokio::fs::metadata(path).await.unwrap().ino(),
        updated_at: read_registry(path).await.unwrap().updated_at,
    }
}

fn base_registration<'a>() -> SandboxRegistration<'a> {
    SandboxRegistration {
        run_id: "run-test",
        cli_agent_type: "claude-code",
        sandbox_token: "tok",
        network_log_path: Path::new("/tmp/network-run-test.jsonl"),
        proxy_log_path: Path::new("/tmp/proxy-run-test.jsonl"),
        firewalls: None,
        network_policies: None,
        connector_runtime_targets: None,
        encrypted_secrets: None,
        secret_connector_map: None,
        secret_connector_metadata_map: None,
        vars: None,
        capture_network_bodies: false,
        billable_firewalls: &[],
        model_usage_provider: None,
        model_usage_long_context_min_total_input_tokens: None,
        pi_model_config: None,
    }
}

#[tokio::test]
async fn registration_preserves_captured_pi_model_config() {
    let fixture = RegistryHarness::new().await;
    let captured = serde_json::json!({
        "schemaVersion": 5,
        "provider": "openrouter",
        "baseUrl": "https://openrouter.ai/api/v1",
        "dialect": "openai-completions",
        "transport": "sse",
        "model": "@preset/captured-org-preset"
    });
    let registration = SandboxRegistration {
        pi_model_config: Some(&captured),
        ..base_registration()
    };
    fixture
        .handle
        .register_sandbox("10.200.0.2", &registration)
        .await
        .unwrap();
    let stored = read_registry(fixture.registry_path()).await.unwrap();
    assert_eq!(
        stored.sandboxes["10.200.0.2"].pi_model_config.as_ref(),
        Some(&captured)
    );
}

#[tokio::test]
async fn registration_preserves_original_usage_generation_across_restart() {
    let fixture = RegistryHarness::new().await;
    fixture.handle.set_control_target_for_test(
        fixture.registry_path().parent().unwrap().to_path_buf(),
        "generation-1".into(),
    );
    fixture
        .handle
        .register_sandbox("10.200.0.2", &base_registration())
        .await
        .unwrap();
    let first: serde_json::Value = serde_json::from_str(
        &tokio::fs::read_to_string(fixture.registry_path())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        first["sandboxes"]["10.200.0.2"]["usageGeneration"],
        "generation-1"
    );
    fixture.handle.set_control_target_for_test(
        fixture.registry_path().parent().unwrap().to_path_buf(),
        "generation-2".into(),
    );
    fixture
        .handle
        .register_sandbox("10.200.0.2", &base_registration())
        .await
        .unwrap();
    let second: serde_json::Value = serde_json::from_str(
        &tokio::fs::read_to_string(fixture.registry_path())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        second["sandboxes"]["10.200.0.2"]["usageGeneration"],
        "generation-1"
    );
    let registration = SandboxRegistration {
        run_id: "new-run",
        ..base_registration()
    };
    fixture
        .handle
        .register_sandbox("10.200.0.2", &registration)
        .await
        .unwrap();
    let replacement: serde_json::Value = serde_json::from_str(
        &tokio::fs::read_to_string(fixture.registry_path())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        replacement["sandboxes"]["10.200.0.2"]["usageGeneration"],
        "generation-2"
    );
}

fn test_firewalls(connector_slugs: &[&str]) -> Vec<FirewallEntry> {
    connector_slugs
        .iter()
        .map(|connector_slug| FirewallEntry::Inline {
            firewall: Firewall {
                name: (*connector_slug).to_string(),
                apis: vec![FirewallApi {
                    id: format!("{connector_slug}-rest"),
                    base: format!("https://api.{connector_slug}.com"),
                    auth: FirewallAuth {
                        headers: HashMap::new(),
                        base: None,
                        query: None,
                        aws_sigv4: None,
                    },
                    host_policy: None,
                    permissions: Some(vec![
                        FirewallPermission {
                            name: "repos.read".to_string(),
                            description: None,
                            rules: vec!["GET /repos/{owner}/{repo}".to_string()],
                        },
                        FirewallPermission {
                            name: "issues.write".to_string(),
                            description: None,
                            rules: vec!["POST /repos/{owner}/{repo}/issues".to_string()],
                        },
                    ]),
                }],
            },
            custom_connector_id: None,
            source_id: None,
        })
        .collect()
}

fn builtin_runtime_targets(connector_slugs: &[&str]) -> Vec<ConnectorRuntimeTargetRegistration> {
    connector_slugs
        .iter()
        .map(
            |connector_slug| ConnectorRuntimeTargetRegistration::Builtin {
                connector_slug: (*connector_slug).to_string(),
                base_url_vars: None,
                source_id: None,
            },
        )
        .collect()
}

fn policy(allow: &[&str], deny: &[&str], ask: &[&str], unknown_policy: &str) -> NetworkPolicy {
    NetworkPolicy {
        allow: allow.iter().map(|value| (*value).to_string()).collect(),
        deny: deny.iter().map(|value| (*value).to_string()).collect(),
        ask: ask.iter().map(|value| (*value).to_string()).collect(),
        unknown_policy: unknown_policy.to_string(),
    }
}

fn custom_runtime_firewall(custom_connector_id: &str, name: &str) -> FirewallEntry {
    FirewallEntry::Inline {
        firewall: Firewall {
            name: name.to_string(),
            apis: vec![FirewallApi {
                id: format!("{name}:0"),
                base: "https://custom.example.test/api/".to_string(),
                auth: FirewallAuth {
                    headers: HashMap::from([(
                        "Authorization".to_string(),
                        "Bearer ${{ secrets.CUSTOM_TOKEN }}".to_string(),
                    )]),
                    base: None,
                    query: None,
                    aws_sigv4: None,
                },
                host_policy: None,
                permissions: None,
            }],
        },
        custom_connector_id: Some(custom_connector_id.to_string()),
        source_id: None,
    }
}

#[test]
fn runtime_firewall_replacement_preserves_the_first_matching_position() {
    let mut firewalls = vec![
        FirewallEntry::Builtin {
            name: "slack".to_string(),
            base_url_vars: None,
            source_id: None,
        },
        FirewallEntry::Builtin {
            name: "github".to_string(),
            base_url_vars: None,
            source_id: None,
        },
        FirewallEntry::Builtin {
            name: "slack".to_string(),
            base_url_vars: Some(HashMap::from([(
                "SLACK_HOST".to_string(),
                "stale.example.test".to_string(),
            )])),
            source_id: None,
        },
    ];

    replace_first_matching_firewall(
        &mut firewalls,
        FirewallEntry::Builtin {
            name: "slack".to_string(),
            base_url_vars: Some(HashMap::from([(
                "SLACK_HOST".to_string(),
                "current.example.test".to_string(),
            )])),
            source_id: None,
        },
        |entry| matches!(entry, FirewallEntry::Builtin { name, .. } if name == "slack"),
    );

    assert_eq!(firewalls.len(), 2);
    assert!(matches!(
        &firewalls[0],
        FirewallEntry::Builtin {
            name,
            base_url_vars: Some(vars),
            ..
        } if name == "slack"
            && vars.get("SLACK_HOST").is_some_and(|host| host == "current.example.test")
    ));
    assert!(matches!(
        &firewalls[1],
        FirewallEntry::Builtin { name, .. } if name == "github"
    ));
}

#[tokio::test]
async fn registry_register_and_unregister() {
    let dir = tempfile::tempdir().unwrap();
    let registry_path = dir.path().join("proxy-registry.json");
    let empty = ProxyRegistry {
        sandboxes: HashMap::new(),
        updated_at: 0,
    };
    write_registry(&registry_path, &empty).await.unwrap();

    // Register a sandbox.
    let mut registry = read_registry(&registry_path).await.unwrap();
    registry.sandboxes.insert(
        "10.200.0.2".to_string(),
        SandboxEntry {
            run_id: "test-run".to_string(),
            cli_agent_type: "claude-code".to_string(),
            sandbox_token: String::new(),
            registered_at: 1000,
            usage_generation: None,
            network_log_path: "/tmp/network-test-run.jsonl".to_string(),
            proxy_log_path: "/tmp/proxy-test-run.jsonl".to_string(),
            firewalls: None,
            network_policies: None,
            connector_runtime_targets: Vec::new(),
            omitted_builtin_firewalls: HashSet::new(),
            omitted_custom_connector_ids: HashSet::new(),
            connector_routing_variables: HashMap::new(),
            encrypted_secrets: None,
            secret_connector_map: None,
            secret_connector_metadata_map: None,
            vars: None,
            capture_network_bodies: false,
            billable_firewalls: vec![],
            model_usage_provider: None,
            model_usage_long_context_min_total_input_tokens: None,
            pi_model_config: None,
        },
    );
    write_registry(&registry_path, &registry).await.unwrap();

    // Verify registration.
    let loaded = read_registry(&registry_path).await.unwrap();
    let sandbox = loaded.sandboxes.get("10.200.0.2").unwrap();
    assert_eq!(sandbox.run_id, "test-run");

    // Unregister the sandbox.
    let mut registry = read_registry(&registry_path).await.unwrap();
    registry.sandboxes.remove("10.200.0.2");
    write_registry(&registry_path, &registry).await.unwrap();

    // Verify unregistration.
    let loaded = read_registry(&registry_path).await.unwrap();
    assert!(
        !loaded.sandboxes.contains_key("10.200.0.2"),
        "sandbox should be removed from registry"
    );
}

#[tokio::test]
async fn write_registry_writes_private_file() {
    let dir = tempfile::tempdir().unwrap();
    let registry_path = dir.path().join("proxy-registry.json");
    let empty = ProxyRegistry {
        sandboxes: HashMap::new(),
        updated_at: 0,
    };

    write_registry(&registry_path, &empty).await.unwrap();

    assert_eq!(
        std::fs::metadata(&registry_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[tokio::test]
async fn write_registry_repairs_existing_wide_file_mode() {
    let dir = tempfile::tempdir().unwrap();
    let registry_path = dir.path().join("proxy-registry.json");
    std::fs::write(&registry_path, r#"{"sandboxes":{},"updatedAt":0}"#).unwrap();
    let mut permissions = std::fs::metadata(&registry_path).unwrap().permissions();
    permissions.set_mode(0o644);
    std::fs::set_permissions(&registry_path, permissions).unwrap();
    let empty = ProxyRegistry {
        sandboxes: HashMap::new(),
        updated_at: 0,
    };

    write_registry(&registry_path, &empty).await.unwrap();

    assert_eq!(
        std::fs::metadata(&registry_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[tokio::test]
async fn read_registry_rejects_symlink_without_following_it() {
    let dir = tempfile::tempdir().unwrap();
    let registry_path = dir.path().join("proxy-registry.json");
    let outside = dir.path().join("outside-registry.json");
    std::fs::write(&outside, r#"{"sandboxes":{},"updatedAt":0}"#).unwrap();
    std::os::unix::fs::symlink(&outside, &registry_path).unwrap();

    let error = read_registry(&registry_path)
        .await
        .err()
        .expect("expected symlink registry rejection");

    assert!(
        error.to_string().contains("open state file"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn read_registry_rejects_directory() {
    let dir = tempfile::tempdir().unwrap();
    let registry_path = dir.path().join("proxy-registry.json");
    std::fs::create_dir(&registry_path).unwrap();

    let error = read_registry(&registry_path)
        .await
        .err()
        .expect("expected directory registry rejection");

    assert!(
        error.to_string().contains("not a regular state file"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn read_registry_rejects_oversized_file() {
    let dir = tempfile::tempdir().unwrap();
    let registry_path = dir.path().join("proxy-registry.json");
    std::fs::write(
        &registry_path,
        vec![b' '; runner_host::state_file::PROXY_REGISTRY_MAX_BYTES as usize + 1],
    )
    .unwrap();

    let error = read_registry(&registry_path)
        .await
        .err()
        .expect("expected oversized registry rejection");

    assert!(
        error.to_string().contains("exceeds"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn registry_handle_register_and_unregister() {
    let harness = RegistryHarness::new().await;

    // Register via handle.
    let registration = SandboxRegistration {
        run_id: "run-1",
        ..base_registration()
    };
    harness
        .handle
        .register_sandbox("10.200.0.2", &registration)
        .await
        .unwrap();

    let loaded = read_registry(harness.registry_path()).await.unwrap();
    let sandbox = loaded.sandboxes.get("10.200.0.2").unwrap();
    assert_eq!(sandbox.run_id, "run-1");

    // Re-register same IP overwrites the entry.
    let registration2 = SandboxRegistration {
        run_id: "run-2",
        cli_agent_type: "codex",
        ..base_registration()
    };
    harness
        .handle
        .register_sandbox("10.200.0.2", &registration2)
        .await
        .unwrap();
    let loaded = read_registry(harness.registry_path()).await.unwrap();
    let sandbox = loaded.sandboxes.get("10.200.0.2").unwrap();
    assert_eq!(sandbox.run_id, "run-2");
    assert_eq!(sandbox.cli_agent_type, "codex");

    // Unregister via handle.
    harness
        .handle
        .unregister_sandbox("10.200.0.2")
        .await
        .unwrap();

    let loaded = read_registry(harness.registry_path()).await.unwrap();
    assert!(!loaded.sandboxes.contains_key("10.200.0.2"));

    // Unregister non-existent IP is a no-op.
    harness
        .handle
        .unregister_sandbox("10.200.0.99")
        .await
        .unwrap();
}

#[tokio::test]
async fn registration_tracks_runtime_target_availability_and_routing_variables() {
    let harness = RegistryHarness::new().await;
    let available_custom_id = "550e8400-e29b-41d4-a716-446655440000";
    let omitted_custom_id = "550e8400-e29b-41d4-a716-446655440001";
    let firewalls = vec![
        FirewallEntry::Builtin {
            name: "slack".to_string(),
            base_url_vars: Some(HashMap::from([(
                "SLACK_HOST".to_string(),
                "xn--mnich-kva.example.test".to_string(),
            )])),
            source_id: None,
        },
        FirewallEntry::Builtin {
            name: "model-provider:openrouter-codex".to_string(),
            base_url_vars: None,
            source_id: None,
        },
        custom_runtime_firewall(available_custom_id, "custom_connector_available"),
    ];
    let vars = HashMap::from([("SLACK_HOST".to_string(), "münich.example.test".to_string())]);
    let targets = vec![
        ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "slack".to_string(),
            base_url_vars: None,
            source_id: None,
        },
        ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "github".to_string(),
            base_url_vars: None,
            source_id: None,
        },
        ConnectorRuntimeTargetRegistration::Custom {
            custom_connector_id: available_custom_id.to_string(),
            base_url_vars: HashMap::new(),
            source_id: None,
        },
        ConnectorRuntimeTargetRegistration::Custom {
            custom_connector_id: omitted_custom_id.to_string(),
            base_url_vars: HashMap::new(),
            source_id: None,
        },
    ];

    harness
        .handle
        .register_sandbox(
            "10.200.0.2",
            &SandboxRegistration {
                firewalls: Some(&firewalls),
                connector_runtime_targets: Some(&targets),
                vars: Some(&vars),
                ..base_registration()
            },
        )
        .await
        .unwrap();

    let registry = read_registry(harness.registry_path()).await.unwrap();
    let sandbox = &registry.sandboxes["10.200.0.2"];
    assert_eq!(
        sandbox.omitted_builtin_firewalls,
        HashSet::from(["github".to_string()])
    );
    assert_eq!(
        sandbox.omitted_custom_connector_ids,
        HashSet::from([omitted_custom_id.to_string()])
    );
    assert_eq!(
        sandbox.connector_routing_variables,
        HashMap::from([
            (
                "builtin:slack".to_string(),
                HashMap::from([("SLACK_HOST".to_string(), "münich.example.test".to_string(),)]),
            ),
            (format!("custom:{available_custom_id}"), HashMap::new(),),
        ])
    );
    assert_eq!(
        sandbox.connector_runtime_targets,
        vec![
            ConnectorRuntimeTarget::Builtin {
                connector_slug: "slack".to_string(),
            },
            ConnectorRuntimeTarget::Builtin {
                connector_slug: "github".to_string(),
            },
            ConnectorRuntimeTarget::Custom {
                custom_connector_id: available_custom_id.to_string(),
            },
            ConnectorRuntimeTarget::Custom {
                custom_connector_id: omitted_custom_id.to_string(),
            },
        ]
    );
}

#[tokio::test]
async fn registration_rejects_custom_firewall_name_owned_by_builtin() {
    let harness = RegistryHarness::new().await;
    let custom_connector_id = "550e8400-e29b-41d4-a716-446655440000";
    let firewalls = vec![
        FirewallEntry::Builtin {
            name: "slack".to_string(),
            base_url_vars: None,
            source_id: None,
        },
        custom_runtime_firewall(custom_connector_id, "slack"),
    ];

    let error = harness
        .handle
        .register_sandbox(
            "10.200.0.2",
            &SandboxRegistration {
                firewalls: Some(&firewalls),
                ..base_registration()
            },
        )
        .await
        .expect_err("custom firewall names must have exclusive owners");

    assert!(
        error
            .to_string()
            .contains("does not exclusively own firewall slack"),
        "unexpected error: {error}"
    );
    assert!(
        read_registry(harness.registry_path())
            .await
            .unwrap()
            .sandboxes
            .is_empty()
    );
}

#[tokio::test]
async fn idempotent_connector_runtime_updates_preserve_registry_file() {
    let harness = RegistryHarness::new().await;
    let custom_connector_id = "550e8400-e29b-41d4-a716-446655440000";
    let original_custom_name = "custom_connector_original";
    let current_custom_name = "custom_connector_current";
    let firewalls = vec![
        FirewallEntry::Builtin {
            name: "slack".to_string(),
            base_url_vars: None,
            source_id: None,
        },
        custom_runtime_firewall(custom_connector_id, original_custom_name),
    ];
    let network_policies = HashMap::from([
        (
            "slack".to_string(),
            policy(&["chat:write"], &[], &[], "allow"),
        ),
        (
            original_custom_name.to_string(),
            policy(&["custom.read"], &[], &[], "allow"),
        ),
    ]);
    let routing_variables = HashMap::from([("subdomain".to_string(), "pinned".to_string())]);
    let runtime_targets = vec![
        ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "slack".to_string(),
            base_url_vars: None,
            source_id: None,
        },
        ConnectorRuntimeTargetRegistration::Custom {
            custom_connector_id: custom_connector_id.to_string(),
            base_url_vars: routing_variables.clone(),
            source_id: None,
        },
    ];
    harness
        .handle
        .register_sandbox(
            "10.200.0.2",
            &SandboxRegistration {
                firewalls: Some(&firewalls),
                network_policies: Some(&network_policies),
                connector_runtime_targets: Some(&runtime_targets),
                ..base_registration()
            },
        )
        .await
        .unwrap();

    let available_updates = vec![
        ConnectorRuntimeRegistryUpdate::BuiltinAvailable {
            connector_slug: "slack".to_string(),
            network_policy: policy(&[], &["chat:write"], &[], "deny"),
        },
        ConnectorRuntimeRegistryUpdate::Custom {
            custom_connector_id: custom_connector_id.to_string(),
            state: CustomConnectorRuntimeRegistryState::Available {
                firewall: custom_runtime_firewall(custom_connector_id, current_custom_name),
                network_policy: Box::new(policy(&["custom.write"], &[], &[], "ask")),
                routing_variables: routing_variables.clone(),
            },
        },
    ];
    assert_eq!(
        harness
            .handle
            .apply_connector_runtime_updates_if_run_matches(
                "10.200.0.2",
                "run-test",
                &available_updates,
            )
            .await
            .unwrap(),
        Some(vec![true, true])
    );
    let available_file_state = registry_file_state(harness.registry_path()).await;

    assert_eq!(
        harness
            .handle
            .apply_connector_runtime_updates_if_run_matches(
                "10.200.0.2",
                "run-test",
                &available_updates,
            )
            .await
            .unwrap(),
        Some(vec![true, true])
    );
    assert_eq!(
        registry_file_state(harness.registry_path()).await,
        available_file_state,
        "an accepted unchanged Available batch must not replace the registry"
    );

    let absent_updates = [ConnectorRuntimeRegistryUpdate::Custom {
        custom_connector_id: custom_connector_id.to_string(),
        state: CustomConnectorRuntimeRegistryState::Absent,
    }];
    assert_eq!(
        harness
            .handle
            .apply_connector_runtime_updates_if_run_matches(
                "10.200.0.2",
                "run-test",
                &absent_updates,
            )
            .await
            .unwrap(),
        Some(vec![true])
    );
    let absent_file_state = registry_file_state(harness.registry_path()).await;

    assert_eq!(
        harness
            .handle
            .apply_connector_runtime_updates_if_run_matches(
                "10.200.0.2",
                "run-test",
                &absent_updates,
            )
            .await
            .unwrap(),
        Some(vec![true])
    );
    assert_eq!(
        registry_file_state(harness.registry_path()).await,
        absent_file_state,
        "an accepted unchanged Absent batch must not replace the registry"
    );
}

#[tokio::test]
async fn builtin_absence_omits_policy_and_later_available_restores_it() {
    let harness = RegistryHarness::new().await;
    let firewalls = vec![
        FirewallEntry::Builtin {
            name: "github".to_string(),
            base_url_vars: None,
            source_id: None,
        },
        FirewallEntry::Builtin {
            name: "slack".to_string(),
            base_url_vars: None,
            source_id: None,
        },
    ];
    let github_policy = policy(&["repos.read"], &[], &[], "ask");
    let network_policies = HashMap::from([
        ("github".to_string(), github_policy.clone()),
        (
            "slack".to_string(),
            policy(&["chat:write"], &[], &[], "allow"),
        ),
    ]);
    let runtime_targets = builtin_runtime_targets(&["github", "slack"]);
    harness
        .handle
        .register_sandbox(
            "10.200.0.2",
            &SandboxRegistration {
                firewalls: Some(&firewalls),
                network_policies: Some(&network_policies),
                connector_runtime_targets: Some(&runtime_targets),
                ..base_registration()
            },
        )
        .await
        .unwrap();

    let absent_update = [ConnectorRuntimeRegistryUpdate::BuiltinAbsent {
        connector_slug: "slack".to_string(),
    }];
    assert_eq!(
        harness
            .handle
            .apply_connector_runtime_updates_if_run_matches(
                "10.200.0.2",
                "run-test",
                &absent_update,
            )
            .await
            .unwrap(),
        Some(vec![true])
    );
    let absent = read_registry(harness.registry_path()).await.unwrap();
    let absent_sandbox = &absent.sandboxes["10.200.0.2"];
    assert_eq!(
        absent_sandbox.omitted_builtin_firewalls,
        HashSet::from(["slack".to_string()])
    );
    assert_eq!(
        absent_sandbox
            .firewalls
            .as_ref()
            .unwrap()
            .iter()
            .map(firewall_name)
            .collect::<Vec<_>>(),
        ["github", "slack"]
    );
    assert_eq!(
        absent_sandbox.network_policies.as_ref().unwrap(),
        &HashMap::from([("github".to_string(), github_policy.clone())])
    );
    let absent_file_state = registry_file_state(harness.registry_path()).await;

    assert_eq!(
        harness
            .handle
            .apply_connector_runtime_updates_if_run_matches(
                "10.200.0.2",
                "run-test",
                &absent_update,
            )
            .await
            .unwrap(),
        Some(vec![true])
    );
    assert_eq!(
        registry_file_state(harness.registry_path()).await,
        absent_file_state,
        "an unchanged built-in absence must not replace the registry"
    );

    let restored_policy = policy(&[], &["chat:write"], &[], "deny");
    assert_eq!(
        harness
            .handle
            .apply_connector_runtime_updates_if_run_matches(
                "10.200.0.2",
                "run-test",
                &[ConnectorRuntimeRegistryUpdate::BuiltinAvailable {
                    connector_slug: "slack".to_string(),
                    network_policy: restored_policy.clone(),
                }],
            )
            .await
            .unwrap(),
        Some(vec![true])
    );
    let restored = read_registry(harness.registry_path()).await.unwrap();
    let restored_sandbox = &restored.sandboxes["10.200.0.2"];
    assert!(restored_sandbox.omitted_builtin_firewalls.is_empty());
    assert_eq!(
        restored_sandbox.network_policies.as_ref().unwrap(),
        &HashMap::from([
            ("github".to_string(), github_policy),
            ("slack".to_string(), restored_policy),
        ])
    );
}

#[tokio::test]
async fn builtin_absence_persists_when_omission_is_the_only_change() {
    let harness = RegistryHarness::new().await;
    let firewalls = vec![FirewallEntry::Builtin {
        name: "slack".to_string(),
        base_url_vars: None,
        source_id: None,
    }];
    let runtime_targets = builtin_runtime_targets(&["slack"]);
    harness
        .handle
        .register_sandbox(
            "10.200.0.2",
            &SandboxRegistration {
                firewalls: Some(&firewalls),
                connector_runtime_targets: Some(&runtime_targets),
                ..base_registration()
            },
        )
        .await
        .unwrap();
    let before = registry_file_state(harness.registry_path()).await;

    assert_eq!(
        harness
            .handle
            .apply_connector_runtime_updates_if_run_matches(
                "10.200.0.2",
                "run-test",
                &[ConnectorRuntimeRegistryUpdate::BuiltinAbsent {
                    connector_slug: "slack".to_string(),
                }],
            )
            .await
            .unwrap(),
        Some(vec![true])
    );

    let after = registry_file_state(harness.registry_path()).await;
    assert_ne!(after.inode, before.inode);
    let registry = read_registry(harness.registry_path()).await.unwrap();
    let sandbox = &registry.sandboxes["10.200.0.2"];
    assert_eq!(
        sandbox.omitted_builtin_firewalls,
        HashSet::from(["slack".to_string()])
    );
    assert_eq!(
        sandbox
            .firewalls
            .as_ref()
            .unwrap()
            .iter()
            .map(firewall_name)
            .collect::<Vec<_>>(),
        ["slack"]
    );
}

#[tokio::test]
async fn mixed_connector_runtime_batch_persists_genuine_changes() {
    let harness = RegistryHarness::new().await;
    let firewalls = vec![
        FirewallEntry::Builtin {
            name: "github".to_string(),
            base_url_vars: None,
            source_id: None,
        },
        FirewallEntry::Builtin {
            name: "slack".to_string(),
            base_url_vars: None,
            source_id: None,
        },
    ];
    let github_policy = policy(&["repos.read"], &[], &[], "ask");
    let network_policies = HashMap::from([
        ("github".to_string(), github_policy.clone()),
        (
            "slack".to_string(),
            policy(&["chat:write"], &[], &[], "allow"),
        ),
    ]);
    let runtime_targets = builtin_runtime_targets(&["github", "slack"]);
    harness
        .handle
        .register_sandbox(
            "10.200.0.2",
            &SandboxRegistration {
                firewalls: Some(&firewalls),
                network_policies: Some(&network_policies),
                connector_runtime_targets: Some(&runtime_targets),
                ..base_registration()
            },
        )
        .await
        .unwrap();
    let before = registry_file_state(harness.registry_path()).await;

    assert_eq!(
        harness
            .handle
            .apply_connector_runtime_updates_if_run_matches(
                "10.200.0.2",
                "run-test",
                &[
                    ConnectorRuntimeRegistryUpdate::BuiltinAvailable {
                        connector_slug: "github".to_string(),
                        network_policy: github_policy,
                    },
                    ConnectorRuntimeRegistryUpdate::BuiltinAvailable {
                        connector_slug: "slack".to_string(),
                        network_policy: policy(&[], &["chat:write"], &[], "deny"),
                    },
                ],
            )
            .await
            .unwrap(),
        Some(vec![true, true])
    );

    let after = registry_file_state(harness.registry_path()).await;
    assert_ne!(after.inode, before.inode);
    let registry = read_registry(harness.registry_path()).await.unwrap();
    let policies = registry.sandboxes["10.200.0.2"]
        .network_policies
        .as_ref()
        .unwrap();
    assert_eq!(policies["github"], network_policies["github"]);
    assert!(policies["slack"].allow.is_empty());
    assert_eq!(policies["slack"].deny, ["chat:write"]);
    assert_eq!(policies["slack"].unknown_policy, "deny");
}

#[tokio::test]
async fn custom_runtime_update_cannot_claim_builtin_firewall_resources() {
    let harness = RegistryHarness::new().await;
    let custom_connector_id = "550e8400-e29b-41d4-a716-446655440000";
    let custom_name = "custom_connector_original";
    let firewalls = vec![
        custom_runtime_firewall(custom_connector_id, custom_name),
        FirewallEntry::Builtin {
            name: "slack".to_string(),
            base_url_vars: None,
            source_id: None,
        },
    ];
    let network_policies = HashMap::from([
        (
            custom_name.to_string(),
            policy(&["custom.read"], &[], &[], "deny"),
        ),
        (
            "slack".to_string(),
            policy(&["chat:write"], &[], &[], "allow"),
        ),
    ]);
    let runtime_targets = vec![
        ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "slack".to_string(),
            base_url_vars: None,
            source_id: None,
        },
        ConnectorRuntimeTargetRegistration::Custom {
            custom_connector_id: custom_connector_id.to_string(),
            base_url_vars: HashMap::new(),
            source_id: None,
        },
    ];
    harness
        .handle
        .register_sandbox(
            "10.200.0.2",
            &SandboxRegistration {
                firewalls: Some(&firewalls),
                network_policies: Some(&network_policies),
                connector_runtime_targets: Some(&runtime_targets),
                ..base_registration()
            },
        )
        .await
        .unwrap();
    let registry_before = tokio::fs::read(harness.registry_path()).await.unwrap();

    let error = harness
        .handle
        .apply_connector_runtime_updates_if_run_matches(
            "10.200.0.2",
            "run-test",
            &[
                ConnectorRuntimeRegistryUpdate::BuiltinAvailable {
                    connector_slug: "slack".to_string(),
                    network_policy: policy(&[], &["chat:write"], &[], "deny"),
                },
                ConnectorRuntimeRegistryUpdate::Custom {
                    custom_connector_id: custom_connector_id.to_string(),
                    state: CustomConnectorRuntimeRegistryState::Available {
                        firewall: custom_runtime_firewall(custom_connector_id, "slack"),
                        network_policy: Box::new(policy(&["custom.write"], &[], &[], "deny")),
                        routing_variables: HashMap::new(),
                    },
                },
            ],
        )
        .await
        .expect_err("custom connector must not overwrite builtin resources");

    assert!(
        error
            .to_string()
            .contains("cannot claim firewall slack owned by another connector"),
        "unexpected error: {error}"
    );
    assert_eq!(
        tokio::fs::read(harness.registry_path()).await.unwrap(),
        registry_before
    );
}

#[tokio::test]
async fn connector_runtime_target_absence_and_restore_are_atomic_and_scoped() {
    let harness = RegistryHarness::new().await;
    let custom_connector_id = "550e8400-e29b-41d4-a716-446655440000";
    let original_name = "custom_connector_original";
    let restored_name = "custom_connector_restored";
    let firewalls = vec![
        custom_runtime_firewall(custom_connector_id, original_name),
        FirewallEntry::Builtin {
            name: "slack".to_string(),
            base_url_vars: None,
            source_id: None,
        },
    ];
    let network_policies = HashMap::from([
        (
            original_name.to_string(),
            policy(&["custom.read"], &[], &[], "deny"),
        ),
        (
            "slack".to_string(),
            policy(&["chat:write"], &[], &[], "allow"),
        ),
    ]);
    let pinned_routing_variables = HashMap::from([("subdomain".to_string(), "pinned".to_string())]);
    let runtime_targets = vec![
        ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "slack".to_string(),
            base_url_vars: None,
            source_id: None,
        },
        ConnectorRuntimeTargetRegistration::Custom {
            custom_connector_id: custom_connector_id.to_string(),
            base_url_vars: pinned_routing_variables.clone(),
            source_id: None,
        },
    ];
    harness
        .handle
        .register_sandbox(
            "10.200.0.2",
            &SandboxRegistration {
                run_id: "run-test",
                firewalls: Some(&firewalls),
                network_policies: Some(&network_policies),
                connector_runtime_targets: Some(&runtime_targets),
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
                &[
                    ConnectorRuntimeRegistryUpdate::BuiltinAvailable {
                        connector_slug: "slack".to_string(),
                        network_policy: policy(&[], &["chat:write"], &[], "deny"),
                    },
                    ConnectorRuntimeRegistryUpdate::Custom {
                        custom_connector_id: custom_connector_id.to_string(),
                        state: CustomConnectorRuntimeRegistryState::Absent,
                    },
                ],
            )
            .await
            .unwrap(),
        Some(vec![true, true])
    );
    let absent = read_registry(harness.registry_path()).await.unwrap();
    let absent_sandbox = &absent.sandboxes["10.200.0.2"];
    assert!(
        absent_sandbox
            .omitted_custom_connector_ids
            .contains(custom_connector_id)
    );
    assert!(absent_sandbox.firewalls.as_ref().is_some_and(|entries| {
        entries
            .iter()
            .any(|entry| matches!(entry, FirewallEntry::Builtin { name, .. } if name == "slack"))
    }));
    assert!(
        !absent_sandbox
            .network_policies
            .as_ref()
            .unwrap()
            .contains_key(original_name)
    );
    assert!(
        absent_sandbox
            .network_policies
            .as_ref()
            .unwrap()
            .contains_key("slack")
    );
    let slack_policy = &absent_sandbox.network_policies.as_ref().unwrap()["slack"];
    assert!(slack_policy.allow.is_empty());
    assert_eq!(slack_policy.deny, ["chat:write"]);
    assert!(slack_policy.ask.is_empty());
    assert_eq!(slack_policy.unknown_policy, "deny");
    assert_eq!(
        absent_sandbox.connector_routing_variables
            [&custom_connector_routing_key(custom_connector_id)],
        pinned_routing_variables
    );

    let restored_firewall = custom_runtime_firewall(custom_connector_id, restored_name);
    assert!(
        harness
            .handle
            .replace_custom_connector_runtime_target_if_run_matches(
                "10.200.0.2",
                "run-test",
                custom_connector_id,
                CustomConnectorRuntimeRegistryState::Available {
                    firewall: restored_firewall,
                    network_policy: Box::new(policy(&["custom.write"], &[], &[], "ask",)),
                    routing_variables: pinned_routing_variables.clone(),
                },
            )
            .await
            .unwrap()
    );
    let restored = read_registry(harness.registry_path()).await.unwrap();
    let restored_sandbox = &restored.sandboxes["10.200.0.2"];
    assert!(
        !restored_sandbox
            .omitted_custom_connector_ids
            .contains(custom_connector_id)
    );
    assert_eq!(
        restored_sandbox.connector_routing_variables
            [&custom_connector_routing_key(custom_connector_id)],
        pinned_routing_variables
    );
    assert!(
        restored_sandbox
            .network_policies
            .as_ref()
            .unwrap()
            .contains_key(restored_name)
    );
    assert!(
        restored_sandbox
            .network_policies
            .as_ref()
            .unwrap()
            .contains_key("slack")
    );
    assert!(restored_sandbox.firewalls.as_ref().is_some_and(|entries| {
        entries.iter().any(|entry| {
            matches!(
                entry,
                FirewallEntry::Inline {
                    custom_connector_id: Some(entry_connector_id),
                    ..
                } if entry_connector_id == custom_connector_id
            )
        })
    }));
}

#[tokio::test]
async fn oversized_registration_preserves_readable_registry() {
    let harness = RegistryHarness::new().await;
    let existing = SandboxRegistration {
        run_id: "run-existing",
        ..base_registration()
    };
    harness
        .handle
        .register_sandbox("10.200.0.2", &existing)
        .await
        .unwrap();
    let previous_bytes = tokio::fs::read(harness.registry_path()).await.unwrap();

    let oversized_vars = HashMap::from([(
        "OVERSIZED".to_string(),
        "x".repeat(PROXY_REGISTRY_MAX_BYTES as usize),
    )]);
    let oversized = SandboxRegistration {
        run_id: "run-oversized",
        vars: Some(&oversized_vars),
        ..base_registration()
    };
    let error = harness
        .handle
        .register_sandbox("10.200.0.3", &oversized)
        .await
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains(&format!("exceeds {PROXY_REGISTRY_MAX_BYTES} bytes")),
        "unexpected error: {error}"
    );
    assert_eq!(
        tokio::fs::read(harness.registry_path()).await.unwrap(),
        previous_bytes,
        "a rejected registration must not replace the readable registry"
    );
    let loaded = read_registry(harness.registry_path()).await.unwrap();
    assert!(loaded.sandboxes.contains_key("10.200.0.2"));
    assert!(!loaded.sandboxes.contains_key("10.200.0.3"));

    harness
        .handle
        .unregister_sandbox("10.200.0.2")
        .await
        .unwrap();
    let later = SandboxRegistration {
        run_id: "run-later",
        ..base_registration()
    };
    harness
        .handle
        .register_sandbox("10.200.0.3", &later)
        .await
        .unwrap();
    harness
        .handle
        .unregister_sandbox("10.200.0.3")
        .await
        .unwrap();
    assert!(
        read_registry(harness.registry_path())
            .await
            .unwrap()
            .sandboxes
            .is_empty()
    );
}

#[tokio::test]
async fn near_limit_registry_preserves_fail_closed_capacity() {
    let harness = RegistryHarness::new().await;
    let firewalls = test_firewalls(&["github", "slack"]);
    let initial_policy = policy(
        &["allow.permission"],
        &["deny.permission"],
        &["ask.permission"],
        "ask",
    );
    let network_policies = HashMap::from([
        ("github".to_string(), initial_policy.clone()),
        ("slack".to_string(), initial_policy),
    ]);
    let runtime_targets = builtin_runtime_targets(&["github", "slack"]);
    let empty_padding = HashMap::from([("PADDING".to_string(), String::new())]);
    let measured = SandboxRegistration {
        run_id: "run-near-limit",
        firewalls: Some(&firewalls),
        network_policies: Some(&network_policies),
        connector_runtime_targets: Some(&runtime_targets),
        vars: Some(&empty_padding),
        ..base_registration()
    };
    harness
        .handle
        .register_sandbox("10.200.0.2", &measured)
        .await
        .unwrap();
    let normal_bytes = tokio::fs::read(harness.registry_path()).await.unwrap();
    let fail_close_targets = runtime_targets
        .iter()
        .map(ConnectorRuntimeTargetRegistration::target)
        .collect::<Vec<_>>();
    let outcomes = harness
        .handle
        .fail_closed_connector_runtime_targets_if_run_matches(
            "10.200.0.2",
            "run-near-limit",
            &fail_close_targets,
        )
        .await
        .unwrap();
    assert!(outcomes.is_some_and(|outcomes| {
        outcomes
            .iter()
            .all(|outcome| matches!(outcome, ConnectorRuntimeFailCloseOutcome::Applied))
    }));
    let after_all_fail_closed = tokio::fs::read(harness.registry_path()).await.unwrap();
    let total_fail_closed_growth = after_all_fail_closed
        .len()
        .checked_sub(normal_bytes.len())
        .expect("test policies should grow when failed closed");
    assert!(total_fail_closed_growth > 0);
    harness
        .handle
        .unregister_sandbox("10.200.0.2")
        .await
        .unwrap();

    let max_bytes = PROXY_REGISTRY_MAX_BYTES as usize;
    let padding_len = max_bytes
        .checked_sub(normal_bytes.len() + total_fail_closed_growth)
        .expect("measured registry should leave room for padding");
    let padding = HashMap::from([("PADDING".to_string(), "x".repeat(padding_len))]);
    let near_limit = SandboxRegistration {
        run_id: "run-near-limit",
        firewalls: Some(&firewalls),
        network_policies: Some(&network_policies),
        connector_runtime_targets: Some(&runtime_targets),
        vars: Some(&padding),
        ..base_registration()
    };
    harness
        .handle
        .register_sandbox("10.200.0.2", &near_limit)
        .await
        .unwrap();
    let before_patch = tokio::fs::read(harness.registry_path()).await.unwrap();
    assert_eq!(before_patch.len() + total_fail_closed_growth, max_bytes);

    let error = harness
        .handle
        .patch_network_policy_if_run_matches(
            "10.200.0.2",
            "run-near-limit",
            "github",
            policy(
                &["allow.permission", "additional.permission"],
                &["deny.permission"],
                &["ask.permission"],
                "ask",
            ),
        )
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains(&format!("exceeds {PROXY_REGISTRY_MAX_BYTES} bytes")),
        "unexpected error: {error}"
    );
    assert_eq!(
        tokio::fs::read(harness.registry_path()).await.unwrap(),
        before_patch,
        "a policy update that consumes fail-closed capacity must be rejected"
    );

    let outcomes = harness
        .handle
        .fail_closed_connector_runtime_targets_if_run_matches(
            "10.200.0.2",
            "run-near-limit",
            &fail_close_targets,
        )
        .await
        .unwrap();
    assert!(outcomes.is_some_and(|outcomes| {
        outcomes
            .iter()
            .all(|outcome| matches!(outcome, ConnectorRuntimeFailCloseOutcome::Applied))
    }));
    let final_bytes = tokio::fs::read(harness.registry_path()).await.unwrap();
    assert_eq!(final_bytes.len(), max_bytes);
    read_registry(harness.registry_path()).await.unwrap();
}

#[tokio::test]
async fn patch_network_policy_requires_matching_run_and_connector() {
    let harness = RegistryHarness::new().await;
    let firewalls = test_firewalls(&["github"]);
    let mut network_policies = HashMap::new();
    network_policies.insert(
        "github".to_string(),
        policy(&["repos.read"], &[], &[], "ask"),
    );
    let runtime_targets = builtin_runtime_targets(&["github"]);
    let registration = SandboxRegistration {
        run_id: "run-1",
        firewalls: Some(&firewalls),
        network_policies: Some(&network_policies),
        connector_runtime_targets: Some(&runtime_targets),
        ..base_registration()
    };
    harness
        .handle
        .register_sandbox("10.200.0.2", &registration)
        .await
        .unwrap();

    let updated = harness
        .handle
        .patch_network_policy_if_run_matches(
            "10.200.0.2",
            "run-2",
            "github",
            policy(&[], &["repos.read"], &[], "deny"),
        )
        .await
        .unwrap();
    assert!(!updated);

    let updated = harness
        .handle
        .patch_network_policy_if_run_matches(
            "10.200.0.2",
            "run-1",
            "slack",
            policy(&[], &["chat.write"], &[], "deny"),
        )
        .await
        .unwrap();
    assert!(!updated);

    let updated = harness
        .handle
        .patch_network_policy_if_run_matches(
            "10.200.0.2",
            "run-1",
            "github",
            policy(&[], &["repos.read"], &["issues.write"], "deny"),
        )
        .await
        .unwrap();
    assert!(updated);

    let loaded = read_registry(harness.registry_path()).await.unwrap();
    let policy = loaded
        .sandboxes
        .get("10.200.0.2")
        .and_then(|sandbox| sandbox.network_policies.as_ref())
        .and_then(|policies| policies.get("github"))
        .unwrap();
    assert_eq!(policy.allow, Vec::<String>::new());
    assert_eq!(policy.deny, vec!["repos.read"]);
    assert_eq!(policy.ask, vec!["issues.write"]);
    assert_eq!(policy.unknown_policy, "deny");
}

#[tokio::test]
async fn fail_closed_connector_runtime_targets_require_matching_run_and_existing_policy() {
    let harness = RegistryHarness::new().await;
    let firewalls = test_firewalls(&["github"]);
    let target = ConnectorRuntimeTarget::Builtin {
        connector_slug: "github".to_string(),
    };
    let without_policy = SandboxRegistration {
        run_id: "run-1",
        firewalls: Some(&firewalls),
        ..base_registration()
    };
    harness
        .handle
        .register_sandbox("10.200.0.2", &without_policy)
        .await
        .unwrap();
    let registry_before = tokio::fs::read(harness.registry_path()).await.unwrap();
    let outcomes = harness
        .handle
        .fail_closed_connector_runtime_targets_if_run_matches(
            "10.200.0.3",
            "run-1",
            std::slice::from_ref(&target),
        )
        .await
        .unwrap();
    assert!(outcomes.is_none());
    let outcomes = harness
        .handle
        .fail_closed_connector_runtime_targets_if_run_matches(
            "10.200.0.2",
            "run-2",
            std::slice::from_ref(&target),
        )
        .await
        .unwrap();
    assert!(outcomes.is_none());
    let outcomes = harness
        .handle
        .fail_closed_connector_runtime_targets_if_run_matches(
            "10.200.0.2",
            "run-1",
            std::slice::from_ref(&target),
        )
        .await
        .unwrap();
    assert!(outcomes.is_some_and(|outcomes| matches!(
        outcomes.as_slice(),
        [ConnectorRuntimeFailCloseOutcome::Unchanged]
    )));
    assert_eq!(
        tokio::fs::read(harness.registry_path()).await.unwrap(),
        registry_before,
        "an unchanged batch must not persist the registry"
    );

    let mut network_policies = HashMap::new();
    network_policies.insert(
        "github".to_string(),
        policy(&["repos.read"], &["issues.write"], &[], "allow"),
    );
    let registration = SandboxRegistration {
        run_id: "run-1",
        firewalls: Some(&firewalls),
        network_policies: Some(&network_policies),
        ..base_registration()
    };
    harness
        .handle
        .register_sandbox("10.200.0.2", &registration)
        .await
        .unwrap();

    let outcomes = harness
        .handle
        .fail_closed_connector_runtime_targets_if_run_matches(
            "10.200.0.2",
            "run-1",
            std::slice::from_ref(&target),
        )
        .await
        .unwrap();
    assert!(outcomes.is_some_and(|outcomes| matches!(
        outcomes.as_slice(),
        [ConnectorRuntimeFailCloseOutcome::Applied]
    )));

    let loaded = read_registry(harness.registry_path()).await.unwrap();
    let policy = loaded
        .sandboxes
        .get("10.200.0.2")
        .and_then(|sandbox| sandbox.network_policies.as_ref())
        .and_then(|policies| policies.get("github"))
        .unwrap();
    assert_eq!(policy.allow, Vec::<String>::new());
    assert_eq!(policy.deny, vec!["issues.write", "repos.read"]);
    assert_eq!(policy.ask, Vec::<String>::new());
    assert_eq!(policy.unknown_policy, "deny");
}

#[tokio::test]
async fn fail_closed_connector_runtime_targets_continue_after_custom_ownership_error() {
    let harness = RegistryHarness::new().await;
    let custom_connector_id = "550e8400-e29b-41d4-a716-446655440000";
    let custom_firewall_name = "custom_connector_conflict";
    let firewalls = vec![
        custom_runtime_firewall(custom_connector_id, custom_firewall_name),
        FirewallEntry::Builtin {
            name: "slack".to_string(),
            base_url_vars: None,
            source_id: None,
        },
    ];
    let network_policies = HashMap::from([
        (
            custom_firewall_name.to_string(),
            policy(&["custom.read"], &[], &[], "allow"),
        ),
        (
            "slack".to_string(),
            policy(&["chat:write"], &[], &[], "allow"),
        ),
    ]);
    let runtime_targets = vec![
        ConnectorRuntimeTargetRegistration::Custom {
            custom_connector_id: custom_connector_id.to_string(),
            base_url_vars: HashMap::new(),
            source_id: None,
        },
        ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "slack".to_string(),
            base_url_vars: None,
            source_id: None,
        },
    ];
    harness
        .handle
        .register_sandbox(
            "10.200.0.2",
            &SandboxRegistration {
                firewalls: Some(&firewalls),
                network_policies: Some(&network_policies),
                connector_runtime_targets: Some(&runtime_targets),
                ..base_registration()
            },
        )
        .await
        .unwrap();
    let mut registry = read_registry(harness.registry_path()).await.unwrap();
    registry
        .sandboxes
        .get_mut("10.200.0.2")
        .unwrap()
        .firewalls
        .as_mut()
        .unwrap()
        .push(FirewallEntry::Builtin {
            name: custom_firewall_name.to_string(),
            base_url_vars: None,
            source_id: None,
        });
    write_registry(harness.registry_path(), &registry)
        .await
        .unwrap();

    let outcomes = harness
        .handle
        .fail_closed_connector_runtime_targets_if_run_matches(
            "10.200.0.2",
            "run-test",
            &[
                ConnectorRuntimeTarget::Custom {
                    custom_connector_id: custom_connector_id.to_string(),
                },
                ConnectorRuntimeTarget::Builtin {
                    connector_slug: "slack".to_string(),
                },
            ],
        )
        .await
        .unwrap()
        .expect("the registered run should still match");
    assert!(matches!(
        outcomes.as_slice(),
        [
            ConnectorRuntimeFailCloseOutcome::Failed(_),
            ConnectorRuntimeFailCloseOutcome::Applied
        ]
    ));

    let loaded = read_registry(harness.registry_path()).await.unwrap();
    let policies = loaded.sandboxes["10.200.0.2"]
        .network_policies
        .as_ref()
        .unwrap();
    assert_eq!(policies[custom_firewall_name].allow, ["custom.read"]);
    assert_eq!(policies[custom_firewall_name].unknown_policy, "allow");
    assert!(policies["slack"].allow.is_empty());
    assert_eq!(policies["slack"].deny, ["chat:write"]);
    assert_eq!(policies["slack"].unknown_policy, "deny");
}

#[tokio::test]
async fn registry_handle_concurrent_access() {
    let harness = RegistryHarness::new().await;

    // Spawn 10 concurrent register tasks.
    let mut tasks = tokio::task::JoinSet::new();
    for i in 0..10 {
        let h = harness.handle.clone();
        let ip = format!("10.200.0.{}", i + 2);
        let run_id_owned = format!("run-{i}");
        tasks.spawn(async move {
            let log_path = std::path::PathBuf::from(format!("/tmp/network-{run_id_owned}.jsonl"));
            let proxy_path = std::path::PathBuf::from(format!("/tmp/proxy-{run_id_owned}.jsonl"));
            let registration = SandboxRegistration {
                run_id: &run_id_owned,
                network_log_path: &log_path,
                proxy_log_path: &proxy_path,
                ..base_registration()
            };
            h.register_sandbox(&ip, &registration).await.unwrap();
        });
    }
    while let Some(result) = tasks.join_next().await {
        result.unwrap();
    }

    // All 10 sandboxes should be registered (no lost updates).
    let loaded = read_registry(harness.registry_path()).await.unwrap();
    assert_eq!(loaded.sandboxes.len(), 10);
}

#[tokio::test]
async fn registry_with_firewalls() {
    let harness = RegistryHarness::new().await;
    let source_id = "550e8400-e29b-41d4-a716-446655440000";

    let firewall_entries = vec![FirewallEntry::Inline {
        firewall: Firewall {
            name: "gmail".to_string(),
            apis: vec![FirewallApi {
                id: String::new(),
                base: "https://gmail.googleapis.com/gmail/v1/users/me".to_string(),
                auth: FirewallAuth {
                    headers: std::collections::HashMap::from([(
                        "Authorization".to_string(),
                        "Bearer ${{ secrets.GMAIL_TOKEN }}".to_string(),
                    )]),
                    base: None,
                    query: None,
                    aws_sigv4: None,
                },
                host_policy: None,
                permissions: Some(vec![FirewallPermission {
                    name: "mail-read".to_string(),
                    description: None,
                    rules: vec![
                        "GET /messages".to_string(),
                        "GET /messages/{id}".to_string(),
                    ],
                }]),
            }],
        },
        custom_connector_id: None,
        source_id: Some(source_id.to_string()),
    }];

    let registration = SandboxRegistration {
        firewalls: Some(&firewall_entries),
        ..base_registration()
    };
    harness
        .handle
        .register_sandbox("10.200.0.5", &registration)
        .await
        .unwrap();

    // Verify firewall entries are stored in registry.
    let loaded = read_registry(harness.registry_path()).await.unwrap();
    let sandbox = loaded.sandboxes.get("10.200.0.5").unwrap();
    let stored = sandbox.firewalls.as_ref().unwrap();
    assert_eq!(stored.len(), 1);
    let FirewallEntry::Inline { firewall, .. } = &stored[0] else {
        panic!("expected inline firewall entry");
    };
    assert_eq!(firewall.apis.len(), 1);
    assert_eq!(
        firewall.apis[0].base,
        "https://gmail.googleapis.com/gmail/v1/users/me"
    );
    assert_eq!(firewall.apis[0].id, "");

    // Verify JSON shape matches what the Python addon expects.
    let raw = tokio::fs::read_to_string(harness.registry_path())
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let sandbox_json = &value["sandboxes"]["10.200.0.5"];
    let fw = &sandbox_json["firewalls"][0];
    assert_eq!(fw["kind"], "inline");
    assert_eq!(fw["sourceId"], source_id);
    assert_eq!(fw["firewall"]["name"], "gmail");
    assert_eq!(
        fw["firewall"]["apis"][0]["base"],
        "https://gmail.googleapis.com/gmail/v1/users/me"
    );
    assert_eq!(fw["firewall"]["apis"][0]["id"], "");

    // Verify permissions are preserved in JSON for the Python addon.
    let perms = &fw["firewall"]["apis"][0]["permissions"];
    assert_eq!(perms[0]["name"], "mail-read");
    assert_eq!(perms[0]["rules"][0], "GET /messages");
    assert_eq!(perms[0]["rules"][1], "GET /messages/{id}");

    // Empty billableFirewalls round-trips as [] (Python reads sandbox_info["billableFirewalls"]).
    assert_eq!(sandbox_json["billableFirewalls"], serde_json::json!([]));
}

#[tokio::test]
async fn registry_serializes_billable_firewalls() {
    let harness = RegistryHarness::new().await;
    let billable = ["model-provider:openrouter-codex".to_string()];
    let registration = SandboxRegistration {
        cli_agent_type: "codex",
        billable_firewalls: &billable,
        model_usage_provider: Some("claude-sonnet-4-6"),
        model_usage_long_context_min_total_input_tokens: Some(272_001),
        ..base_registration()
    };
    harness
        .handle
        .register_sandbox("10.200.0.9", &registration)
        .await
        .unwrap();

    // Guard the TS↔Rust↔Python wire contract: the camelCase key is what
    // mitm-addon reads via `sandbox_info["billableFirewalls"]`.
    let raw = tokio::fs::read_to_string(harness.registry_path())
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        value["sandboxes"]["10.200.0.9"]["billableFirewalls"],
        serde_json::json!(["model-provider:openrouter-codex"])
    );
    assert_eq!(
        value["sandboxes"]["10.200.0.9"]["cliAgentType"],
        serde_json::json!("codex")
    );
    assert_eq!(
        value["sandboxes"]["10.200.0.9"]["modelUsageProvider"],
        serde_json::json!("claude-sonnet-4-6")
    );
    assert_eq!(
        value["sandboxes"]["10.200.0.9"]["modelUsageLongContextMinTotalInputTokens"],
        serde_json::json!(272_001)
    );
}

#[tokio::test]
async fn register_sandbox_stores_encrypted_secrets() {
    let harness = RegistryHarness::new().await;

    let metadata = HashMap::from([(
        "CHATGPT_ACCESS_TOKEN".to_string(),
        SecretConnectorMetadata {
            source_type: "model-provider".to_string(),
            source_id: Some("550e8400-e29b-41d4-a716-446655440000".to_string()),
            source_user_id: Some("user-123".to_string()),
            metadata_key: Some("codex-oauth-token".to_string()),
        },
    )]);
    let registration = SandboxRegistration {
        encrypted_secrets: Some("iv_b64:tag_b64:data_b64"),
        secret_connector_metadata_map: Some(&metadata),
        ..base_registration()
    };
    harness
        .handle
        .register_sandbox("10.200.0.6", &registration)
        .await
        .unwrap();

    let loaded = read_registry(harness.registry_path()).await.unwrap();
    let sandbox = loaded.sandboxes.get("10.200.0.6").unwrap();
    assert_eq!(
        sandbox.encrypted_secrets.as_deref(),
        Some("iv_b64:tag_b64:data_b64")
    );

    // Verify JSON key name matches what the Python addon expects.
    let raw = tokio::fs::read_to_string(harness.registry_path())
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        value["sandboxes"]["10.200.0.6"]["encryptedSecrets"],
        "iv_b64:tag_b64:data_b64"
    );
    assert_eq!(
        value["sandboxes"]["10.200.0.6"]["secretConnectorMetadataMap"]["CHATGPT_ACCESS_TOKEN"]["sourceUserId"],
        "user-123"
    );
    assert_eq!(
        value["sandboxes"]["10.200.0.6"]["secretConnectorMetadataMap"]["CHATGPT_ACCESS_TOKEN"]["sourceId"],
        "550e8400-e29b-41d4-a716-446655440000"
    );
}

#[tokio::test]
async fn registry_firewall_auth_base_serialized() {
    let harness = RegistryHarness::new().await;

    let firewall_entries = vec![FirewallEntry::Inline {
        firewall: Firewall {
            name: "discord-webhook".to_string(),
            apis: vec![FirewallApi {
                id: String::new(),
                base: "https://firewall-placeholder.vm3.ai/discord-webhook/hook".to_string(),
                auth: FirewallAuth {
                    headers: std::collections::HashMap::new(),
                    base: Some("${{ secrets.DISCORD_WEBHOOK_URL }}".to_string()),
                    query: None,
                    aws_sigv4: None,
                },
                host_policy: None,
                permissions: None,
            }],
        },
        custom_connector_id: None,
        source_id: None,
    }];

    let registration = SandboxRegistration {
        firewalls: Some(&firewall_entries),
        encrypted_secrets: Some("enc_data"),
        ..base_registration()
    };
    harness
        .handle
        .register_sandbox("10.200.0.7", &registration)
        .await
        .unwrap();

    // Verify auth.base is preserved in the registry JSON.
    let raw = tokio::fs::read_to_string(harness.registry_path())
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let api = &value["sandboxes"]["10.200.0.7"]["firewalls"][0]["firewall"]["apis"][0];
    assert_eq!(api["auth"]["base"], "${{ secrets.DISCORD_WEBHOOK_URL }}");
    // headers should be empty object
    assert_eq!(api["auth"]["headers"], serde_json::json!({}));
}

#[tokio::test]
async fn registry_firewall_auth_query_serialized() {
    let harness = RegistryHarness::new().await;

    let firewall_entries = vec![FirewallEntry::Inline {
        firewall: Firewall {
            name: "serpapi".to_string(),
            apis: vec![FirewallApi {
                id: String::new(),
                base: "https://serpapi.com".to_string(),
                auth: FirewallAuth {
                    headers: std::collections::HashMap::new(),
                    base: None,
                    query: Some(
                        [(
                            "api_key".to_string(),
                            "${{ secrets.SERPAPI_TOKEN }}".to_string(),
                        )]
                        .into_iter()
                        .collect(),
                    ),
                    aws_sigv4: None,
                },
                host_policy: None,
                permissions: None,
            }],
        },
        custom_connector_id: None,
        source_id: None,
    }];

    let registration = SandboxRegistration {
        firewalls: Some(&firewall_entries),
        encrypted_secrets: Some("enc_data"),
        ..base_registration()
    };
    harness
        .handle
        .register_sandbox("10.200.0.8", &registration)
        .await
        .unwrap();

    // Verify auth.query is preserved in the registry JSON.
    let raw = tokio::fs::read_to_string(harness.registry_path())
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let api = &value["sandboxes"]["10.200.0.8"]["firewalls"][0]["firewall"]["apis"][0];
    assert_eq!(
        api["auth"]["query"],
        serde_json::json!({"api_key": "${{ secrets.SERPAPI_TOKEN }}"})
    );
    // headers should be empty object, base should be absent
    assert_eq!(api["auth"]["headers"], serde_json::json!({}));
    assert_eq!(api["auth"]["base"], serde_json::Value::Null);
}
