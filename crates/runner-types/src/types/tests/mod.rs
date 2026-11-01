use super::*;
use serde_json::json;

#[test]
fn firewall_validation_rejects_aws_rule_without_aws_auth() {
    let firewall: Firewall = serde_json::from_value(serde_json::json!({
        "name": "aws",
        "apis": [{
            "base": "https://ec2.us-east-1.amazonaws.com",
            "auth": {"headers": {}},
            "permissions": [{
                "name": "ec2:AcceptAddressTransfer",
                "rules": ["GET / AWS sigv4=ec2 action=AcceptAddressTransfer"]
            }]
        }]
    }))
    .unwrap();

    let error = firewall.validate_for_cache().unwrap_err();

    assert!(
        error.contains("AWS predicates require api.auth.awsSigv4"),
        "unexpected error: {error}"
    );
}

#[test]
fn raw_url_path_does_not_treat_query_or_fragment_content_as_path() {
    assert_eq!(raw_url_path("https://api.example.com?next=/../"), "");
    assert_eq!(raw_url_path("https://api.example.com#next=/../"), "");
}

#[test]
fn firewall_auth_base_allows_path_syntax_in_query() {
    validate_auth_base_for_cache("https://api.example.com?next=/../").unwrap();
}

#[test]
fn poll_response_with_job() {
    let json = json!({
        "job": {
            "runId": "550e8400-e29b-41d4-a716-446655440000",
            "experimentalProfile": "browser",
            "cliAgentSessionId": "session-id",
            "runnerPreference": {
                "kind": "preference",
                "runnerIdentity": {
                    "runnerId": "b85bb257-21c1-4b8f-8676-a4051f35b7b0",
                    "heartbeatGeneration": 7
                },
                "tier": "reusableSandbox",
                "expiresAt": "2026-08-03T12:00:00.000Z"
            }
        }
    });
    let resp: PollResponse = serde_json::from_value(json).unwrap();
    let job = resp.job.unwrap();
    assert_eq!(
        job.run_id,
        "550e8400-e29b-41d4-a716-446655440000"
            .parse::<RunId>()
            .unwrap()
    );
    assert_eq!(job.experimental_profile, "browser");
    assert!(job.runner_preference.is_some());
    assert!(job.reuse_key().is_none());
}

#[test]
fn poll_response_no_job() {
    let json = json!({ "job": null });
    let resp: PollResponse = serde_json::from_value(json).unwrap();
    assert!(resp.job.is_none());
}

#[test]
fn job_requires_profile() {
    let json = json!({
        "runId": "550e8400-e29b-41d4-a716-446655440000"
    });
    assert!(serde_json::from_value::<Job>(json).is_err());
}

#[test]
fn execution_context_deserializes_pi_sandbox_resources() {
    let json = serde_json::json!({
        "runId": "11111111-1111-4111-8111-111111111111",
        "prompt": "hello",
        "sandboxToken": "tok",
        "cliAgentType": "pi",
        "piSessionId": "22222222-2222-4222-8222-222222222222",
        "piLaunchConfig": { "schemaVersion": 2 },
        "piModelConfig": {
            "schemaVersion": 5,
            "dialect": "openai-completions",
            "transport": "sse",
            "provider": "openrouter",
            "baseUrl": "https://openrouter.ai/api/v1",
            "model": "openai/gpt-6-luna",
            "credentialBindings": [{
                "kind": "api-key",
                "environment": "OPENAI_API_KEY",
                "secretName": "OPENROUTER_API_KEY"
            }]
        },
        "platformEnvironment": {},
        "contentBundles": {"format": "tar-gzip-v1", "skills": []},
        "connectorRuntimeTargets": []
    });

    let context: ExecutionContext = serde_json::from_value(json).unwrap();

    assert_eq!(context.is_first_run, None);

    assert_eq!(
        context.pi_session_id.as_deref(),
        Some("22222222-2222-4222-8222-222222222222")
    );
    assert_eq!(
        context.cli_agent_session_id(),
        Some("22222222-2222-4222-8222-222222222222")
    );
    assert_eq!(
        context
            .pi_launch_config
            .as_ref()
            .and_then(|config| config["schemaVersion"].as_u64()),
        Some(2)
    );
    assert_eq!(
        context
            .pi_model_config
            .as_ref()
            .and_then(|config| config["model"].as_str()),
        Some("openai/gpt-6-luna")
    );
}

#[test]
fn execution_context_preserves_optional_first_run_context() {
    for label in [None, Some(false), Some(true)] {
        let mut claim = json!({
            "runId": "11111111-1111-4111-8111-111111111111",
            "prompt": "hello",
            "sandboxToken": "tok",
            "cliAgentType": "claude-code",
            "platformEnvironment": {},
            "contentBundles": {"format": "tar-gzip-v1", "skills": []},
            "connectorRuntimeTargets": []
        });
        if let Some(label) = label {
            claim["isFirstRun"] = json!(label);
        }
        let context: ExecutionContext = serde_json::from_value(claim).unwrap();
        assert_eq!(context.is_first_run, label);
    }
}

#[test]
fn execution_context_rejects_legacy_expanded_firewall_entry() {
    let json = serde_json::json!({
        "runId": "11111111-1111-4111-8111-111111111111",
        "prompt": "hello",
        "sandboxToken": "tok",
        "cliAgentType": "claude-code",
        "platformEnvironment": {},
        "contentBundles": {"format": "tar-gzip-v1", "skills": []},
        "connectorRuntimeTargets": [],
        "firewalls": [{
            "name": "github",
            "apis": [{
                "base": "https://api.github.com",
                "auth": {"headers": {}},
                "permissions": [{
                    "name": "issues-read",
                    "rules": ["GET /repos/{owner}/{repo}/issues"]
                }]
            }]
        }]
    });

    let result = serde_json::from_value::<ExecutionContext>(json);
    assert!(result.is_err());
}

#[test]
fn execution_context_rejects_unknown_firewall_kind() {
    let json = serde_json::json!({
        "runId": "11111111-1111-4111-8111-111111111111",
        "prompt": "hello",
        "sandboxToken": "tok",
        "cliAgentType": "claude-code",
        "platformEnvironment": {},
        "contentBundles": {"format": "tar-gzip-v1", "skills": []},
        "connectorRuntimeTargets": [],
        "firewalls": [{
            "kind": "unknown",
            "name": "github",
            "apis": [{
                "base": "https://api.github.com",
                "auth": {"headers": {}}
            }]
        }]
    });

    let result = serde_json::from_value::<ExecutionContext>(json);
    assert!(result.is_err());
}

#[test]
fn firewall_round_trip() {
    let fw = Firewall {
        name: "github".into(),
        apis: vec![FirewallApi {
            id: "api-1".into(),
            base: "https://api.github.com".into(),
            auth: FirewallAuth {
                headers: [("Authorization".into(), "Bearer tok".into())]
                    .into_iter()
                    .collect(),
                base: None,
                query: None,
                aws_sigv4: None,
            },
            host_policy: None,
            permissions: Some(vec![FirewallPermission {
                name: "metadata:read".into(),
                description: Some("read repo metadata".into()),
                rules: vec!["GET /repos/{owner}/{repo}".into()],
            }]),
        }],
    };
    let json = serde_json::to_value(&fw).unwrap();
    assert_eq!(json["name"], "github");
    // round-trip
    let deserialized: Firewall = serde_json::from_value(json).unwrap();
    assert_eq!(deserialized.name, "github");
    assert_eq!(
        deserialized.apis[0].permissions.as_ref().unwrap()[0].name,
        "metadata:read"
    );
}

#[test]
fn firewall_auth_base_omitted_when_none() {
    let auth = FirewallAuth {
        headers: HashMap::new(),
        base: None,
        query: None,
        aws_sigv4: None,
    };
    let json = serde_json::to_value(&auth).unwrap();
    assert!(json.get("base").is_none());
}

#[test]
fn firewall_preserves_host_policy_and_aws_sigv4() {
    let json = serde_json::json!({
        "name": "aws",
        "apis": [{
            "base": "https://s3.amazonaws.com",
            "hostPolicy": {
                "kind": "providerOwned",
                "exactHosts": ["s3.amazonaws.com"],
                "allowNonDefaultPort": false
            },
            "auth": {
                "awsSigv4": {
                    "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                    "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                    "sessionToken": "${{ secrets.AWS_SESSION_TOKEN }}"
                }
            },
            "permissions": [{
                "name": "read",
                "rules": ["GET /{bucket}"]
            }]
        }]
    });

    let firewall: Firewall = serde_json::from_value(json).unwrap();
    firewall.validate_for_cache().unwrap();
    let round_trip = serde_json::to_value(&firewall).unwrap();

    assert_eq!(
        round_trip["apis"][0]["hostPolicy"]["exactHosts"][0],
        "s3.amazonaws.com"
    );
    assert_eq!(
        round_trip["apis"][0]["auth"]["awsSigv4"]["accessKeyId"],
        "${{ secrets.AWS_ACCESS_KEY_ID }}"
    );
}

#[test]
fn firewall_validation_rejects_aws_sigv4_with_headers() {
    let firewall: Firewall = serde_json::from_value(serde_json::json!({
        "name": "aws",
        "apis": [{
            "base": "https://s3.amazonaws.com",
            "auth": {
                "headers": {"Authorization": "Bearer token"},
                "awsSigv4": {
                    "accessKeyId": "key",
                    "secretAccessKey": "secret"
                }
            }
        }]
    }))
    .unwrap();

    let error = firewall.validate_for_cache().unwrap_err();

    assert!(
        error.contains("auth.headers cannot be combined with auth.awsSigv4"),
        "unexpected error: {error}"
    );
}

#[test]
fn firewall_validation_rejects_empty_provider_owned_host_policy() {
    let firewall: Firewall = serde_json::from_value(serde_json::json!({
        "name": "example",
        "apis": [{
            "base": "https://api.example.com",
            "hostPolicy": {"kind": "providerOwned"},
            "auth": {"headers": {}}
        }]
    }))
    .unwrap();

    let error = firewall.validate_for_cache().unwrap_err();

    assert!(
        error.contains("providerOwned hostPolicy requires exactHosts or suffixes"),
        "unexpected error: {error}"
    );
}

#[test]
fn firewall_validation_rejects_empty_apis() {
    let firewall: Firewall = serde_json::from_value(serde_json::json!({
        "name": "empty",
        "apis": []
    }))
    .unwrap();

    let error = firewall.validate_for_cache().unwrap_err();

    assert!(
        error.contains("must have at least one api"),
        "unexpected error: {error}"
    );
}

#[test]
fn firewall_deserialization_rejects_unsupported_host_policy_fields() {
    let error = serde_json::from_value::<Firewall>(serde_json::json!({
        "name": "example",
        "apis": [{
            "base": "https://api.example.com",
            "hostPolicy": {
                "kind": "providerOwned",
                "exactHosts": ["api.example.com"],
                "unexpected": true
            },
            "auth": {"headers": {}}
        }]
    }))
    .unwrap_err();

    assert!(
        error.to_string().contains("unknown field"),
        "unexpected error: {error}"
    );
}

#[test]
fn firewall_deserialization_rejects_unsupported_aws_sigv4_fields() {
    let error = serde_json::from_value::<Firewall>(serde_json::json!({
        "name": "aws",
        "apis": [{
            "base": "https://s3.amazonaws.com",
            "auth": {
                "awsSigv4": {
                    "accessKeyId": "key",
                    "secretAccessKey": "secret",
                    "unexpected": true
                }
            }
        }]
    }))
    .unwrap_err();

    assert!(
        error.to_string().contains("unknown field"),
        "unexpected error: {error}"
    );
}

#[test]
fn complete_request_camel_case() {
    let req = CompleteRequest {
        run_id: "550e8400-e29b-41d4-a716-446655440000"
            .parse::<RunId>()
            .unwrap(),
        exit_code: 0,
        failure_reason: None,
        error: None,
        sandbox_id: None,
    };
    let json = serde_json::to_value(&req).unwrap();
    assert!(json.get("runId").is_some());
    assert!(json.get("exitCode").is_some());
    // optionals omitted when None
    assert!(json.get("error").is_none());
    assert!(json.get("failureReason").is_none());
    assert!(json.get("sandboxId").is_none());
}

#[test]
fn complete_request_with_pre_sandbox_error_omits_sandbox_fields() {
    let req = CompleteRequest {
        run_id: "550e8400-e29b-41d4-a716-446655440000"
            .parse::<RunId>()
            .unwrap(),
        exit_code: 1,
        failure_reason: Some(RequestFailureReason::ProviderRateLimited),
        error: Some("timeout".into()),
        sandbox_id: None,
    };
    let json = serde_json::to_value(&req).unwrap();
    assert_eq!(json["error"], "timeout");
    assert_eq!(json["failureReason"], "provider_rate_limited");
    assert!(json.get("sandboxId").is_none());
}

#[test]
fn complete_request_serializes_input_too_large_failure_reason() {
    let req = CompleteRequest {
            run_id: "550e8400-e29b-41d4-a716-446655440000"
                .parse::<RunId>()
                .unwrap(),
            exit_code: 1,
            failure_reason: Some(RequestFailureReason::InputTooLarge),
            error: Some(
                "execution: Codex input is too large: 101 characters provided, maximum is 100 characters. Reduce the input and try again."
                    .into(),
            ),
            sandbox_id: None,
        };

    let json = serde_json::to_value(&req).unwrap();

    assert_eq!(json["failureReason"], "input_too_large");
}

#[test]
fn complete_request_with_sandbox_identity() {
    let sid: SandboxId = "11111111-2222-3333-4444-555555555555".parse().unwrap();
    let req = CompleteRequest {
        run_id: "550e8400-e29b-41d4-a716-446655440000"
            .parse::<RunId>()
            .unwrap(),
        exit_code: 0,
        failure_reason: None,
        error: None,
        sandbox_id: Some(sid),
    };
    let json = serde_json::to_value(&req).unwrap();
    assert_eq!(json["sandboxId"], "11111111-2222-3333-4444-555555555555");
}

#[test]
fn sandbox_reuse_result_serializes_camel_case() {
    assert_eq!(
        serde_json::to_value(SandboxReuseResult::NoReuseKey).unwrap(),
        serde_json::json!("noReuseKey"),
    );
    assert_eq!(
        serde_json::to_value(SandboxReuseResult::PoolMiss).unwrap(),
        serde_json::json!("poolMiss"),
    );
    assert_eq!(
        serde_json::to_value(SandboxReuseResult::ProfileMismatch).unwrap(),
        serde_json::json!("profileMismatch"),
    );
    assert_eq!(
        serde_json::to_value(SandboxReuseResult::DeviceLimitMismatch).unwrap(),
        serde_json::json!("deviceLimitMismatch"),
    );
    assert_eq!(
        serde_json::to_value(SandboxReuseResult::UnparkFailed).unwrap(),
        serde_json::json!("unparkFailed"),
    );
}

/// `as_wire` is hand-written; pin it to the serde derive so adding a
/// variant forces both sides to stay in sync.
#[test]
fn as_wire_matches_serde_serialization() {
    for variant in [
        SandboxReuseResult::Reused,
        SandboxReuseResult::NoReuseKey,
        SandboxReuseResult::PoolMiss,
        SandboxReuseResult::ProfileMismatch,
        SandboxReuseResult::DeviceLimitMismatch,
        SandboxReuseResult::UnparkFailed,
    ] {
        assert_eq!(
            serde_json::to_value(variant).unwrap(),
            serde_json::Value::String(variant.as_wire().to_string()),
        );
    }
    for variant in [
        HomeReuseResult::Reused,
        HomeReuseResult::SandboxReused,
        HomeReuseResult::CacheMiss,
        HomeReuseResult::NoReuseKey,
        HomeReuseResult::InvalidWorkingDir,
        HomeReuseResult::LockBusy,
        HomeReuseResult::InvalidMetadata,
        HomeReuseResult::DiskPressure,
        HomeReuseResult::NotConfigured,
        HomeReuseResult::SandboxPrepareFallback,
    ] {
        assert_eq!(
            serde_json::to_value(variant).unwrap(),
            serde_json::Value::String(variant.as_wire().to_string()),
        );
    }
}

#[test]
fn cli_agent_session_id_returns_none_without_supplied_id() {
    let json = json!({
        "runId": "550e8400-e29b-41d4-a716-446655440000",
        "prompt": "hello",
        "sandboxToken": "tok",
        "cliAgentType": "claude_code",
        "billableFirewalls": [],
        "platformEnvironment": {},
        "contentBundles": {"format": "tar-gzip-v1", "skills": []},
        "connectorRuntimeTargets": []
    });
    let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
    assert!(ctx.cli_agent_session_id().is_none());
}

#[test]
fn execution_context_requires_custom_connector_routing_values() {
    let execution_context = |target: serde_json::Value| {
        json!({
            "runId": "550e8400-e29b-41d4-a716-446655440000",
            "prompt": "hello",
            "sandboxToken": "tok",
            "cliAgentType": "claude_code",
            "billableFirewalls": [],
            "platformEnvironment": {},
            "contentBundles": {"format": "tar-gzip-v1", "skills": []},
            "connectorRuntimeTargets": [target]
        })
    };
    let custom_connector_id = "550e8400-e29b-41d4-a716-446655440001";

    assert!(
        serde_json::from_value::<ExecutionContext>(execution_context(json!({
            "kind": "custom",
            "customConnectorId": custom_connector_id
        })))
        .is_err()
    );

    let legacy_context = serde_json::from_value::<ExecutionContext>(execution_context(json!({
        "kind": "custom",
        "customConnectorId": custom_connector_id,
        "baseUrlVars": {}
    })))
    .expect("empty custom connector routing values should be accepted");
    assert_eq!(
        legacy_context
            .connector_runtime_targets
            .first()
            .and_then(ConnectorRuntimeTargetRegistration::source_id),
        None
    );
    let source_id = "550e8400-e29b-41d4-a716-446655440002";
    let context = serde_json::from_value::<ExecutionContext>(execution_context(json!({
        "kind": "custom",
        "customConnectorId": custom_connector_id,
        "baseUrlVars": {},
        "sourceId": source_id
    })))
    .expect("custom connector source identity should be accepted");
    assert_eq!(
        context.connector_runtime_targets,
        vec![ConnectorRuntimeTargetRegistration::Custom {
            custom_connector_id: custom_connector_id.to_string(),
            base_url_vars: HashMap::new(),
            source_id: Some(source_id.to_string()),
        }]
    );
}

#[test]
fn cli_agent_session_identity_uses_native_intent_and_local_submission() {
    let mut context: ExecutionContext = serde_json::from_value(json!({
            "runId": "550e8400-e29b-41d4-a716-446655440000", "prompt": "hello", "sandboxToken": "tok", "cliAgentType": "claude-code", "platformEnvironment": {},
            "contentBundles": {"format": "tar-gzip-v1", "skills": []}, "connectorRuntimeTargets": [],
            "nativeContinuation": { "sessionId": "native-session", "generationRunId": "550e8400-e29b-41d4-a716-446655440001", "recoveryPrompt": null }
        })).unwrap();
    assert_eq!(context.cli_agent_session_id(), Some("native-session"));
    context.native_continuation = None;
    context.local_resume_session_id = Some("local-session".into());
    assert_eq!(context.cli_agent_session_id(), Some("local-session"));
}

fn execution_context_with_storage_manifest(
    storage_manifest: serde_json::Value,
) -> serde_json::Value {
    json!({
        "runId": "550e8400-e29b-41d4-a716-446655440000",
        "prompt": "hello",
        "sandboxToken": "tok",
        "storageManifest": storage_manifest,
        "cliAgentType": "claude_code",
        "billableFirewalls": [],
        "platformEnvironment": {},
        "contentBundles": {"format": "tar-gzip-v1", "skills": []},
        "connectorRuntimeTargets": []
    })
}

#[test]
fn execution_context_accepts_canonical_storage_mounts() {
    let json = execution_context_with_storage_manifest(json!({
        "storageMounts": [
            {
                "name": "workflow",
                "storageId": "storage-read-only",
                "versionId": "version-1",
                "mountPath": "/home/user/.claude/skills/workflow",
                "archiveUrl": "https://example.com/workflow.tar.gz",
                "futureMountField": true
            },
            {
                "name": "memory",
                "storageId": "storage-writeback",
                "versionId": "version-2",
                "mountPath": "/memory",
                "empty": true,
                "missingRootPolicy": "preserveParentVersion",
                "writeback": true
            }
        ],
        "futureManifestField": true
    }));

    let context: ExecutionContext = serde_json::from_value(json).unwrap();
    let manifest = context.storage_manifest.unwrap();

    assert_eq!(manifest.storages.len(), 1);
    assert_eq!(manifest.storages[0].name, "workflow");
    assert_eq!(manifest.storages[0].vas_storage_name, "workflow");
    assert_eq!(manifest.storages[0].vas_version_id, "version-1");
    assert_eq!(manifest.artifacts.len(), 1);
    assert_eq!(manifest.artifacts[0].vas_storage_name, "memory");
    assert_eq!(manifest.artifacts[0].vas_storage_id, "storage-writeback");
    assert_eq!(manifest.artifacts[0].empty, Some(true));
}

#[test]
fn execution_context_rejects_legacy_storage_manifest_representations() {
    for storage_manifest in [
        json!({ "storages": [], "artifacts": [] }),
        json!({ "storages": [] }),
        json!({ "artifacts": [] }),
        json!({}),
    ] {
        let result = serde_json::from_value::<ExecutionContext>(
            execution_context_with_storage_manifest(storage_manifest),
        );
        assert!(result.is_err());
    }
}

#[test]
fn execution_context_rejects_duplicate_storage_mount_paths() {
    let result = serde_json::from_value::<ExecutionContext>(
        execution_context_with_storage_manifest(json!({
            "storageMounts": [
                {
                    "name": "workspace",
                    "storageId": "storage-read-only",
                    "versionId": "version-1",
                    "mountPath": "/workspace",
                    "archiveUrl": "https://example.com/workspace.tar.gz"
                },
                {
                    "name": "artifact",
                    "storageId": "storage-writeback",
                    "versionId": "version-2",
                    "mountPath": "/workspace",
                    "empty": true,
                    "writeback": true
                }
            ]
        })),
    );

    let error = result.unwrap_err().to_string();
    assert!(error.contains("duplicate mountPath \"/workspace\""));
}

#[test]
fn execution_context_rejects_invalid_canonical_storage_mount_behavior() {
    for mount in [
        json!({
            "name": "read-only",
            "storageId": "storage-1",
            "versionId": "version-1",
            "mountPath": "/read-only"
        }),
        json!({
            "name": "read-only-empty",
            "storageId": "storage-2",
            "versionId": "version-2",
            "mountPath": "/read-only-empty",
            "archiveUrl": "https://example.com/empty.tar.gz",
            "empty": true
        }),
        json!({
            "name": "read-only-missing-root-policy",
            "storageId": "storage-3",
            "versionId": "version-3",
            "mountPath": "/read-only-missing-root-policy",
            "archiveUrl": "https://example.com/read-only.tar.gz",
            "missingRootPolicy": "preserveParentVersion"
        }),
        json!({
            "name": "writeback-without-archive",
            "storageId": "storage-5",
            "versionId": "version-5",
            "mountPath": "/writeback-without-archive",
            "writeback": true
        }),
    ] {
        let result = serde_json::from_value::<ExecutionContext>(
            execution_context_with_storage_manifest(json!({
                "storageMounts": [mount]
            })),
        );
        assert!(result.is_err());
    }
}

#[test]
fn heartbeat_state_serializes_camel_case() {
    let state = HeartbeatState {
        runner_id: "550e8400-e29b-41d4-a716-446655440000".into(),
        runner_hostname: Some("prod-wire.example.test".into()),
        group: "vm0/production".into(),
        snapshot_generation: 7,
        snapshot_sequence: 42,
        total_vcpu: 16,
        total_memory_mb: 32768,
        max_concurrent: 8,
        allocated_vcpu: 6,
        allocated_memory_mb: 6144,
        running_count: 2,
        admittable_profiles: vec!["vm0/default".into()],
        held_sandbox_states: vec![HeldSandboxState {
            reuse_key: "thread:thread-abc".into(),
            last_completed_at: "2026-05-28T00:00:00.000Z".into(),
            reusable_sandbox: ReusableSandboxState {
                source_run_id: "33333333-3333-4333-8333-333333333333".parse().unwrap(),
                profile: "vm0/default".into(),
            },
        }],
        held_home_states: vec![HeldHomeState {
            reuse_key: "thread:thread-abc".into(),
            last_completed_at: "2026-05-28T00:00:00.000Z".into(),
            home_caches: vec![HomeCacheCapability {
                source_run_id: "33333333-3333-4333-8333-333333333333".parse().unwrap(),
                profile: "vm0/large".into(),
                home_affinity_version: HOME_AFFINITY_VERSION,
            }],
        }],
        active_reuse_producers: vec![ActiveReuseProducer {
            run_id: "22222222-2222-4222-8222-222222222222".parse().unwrap(),
            reuse_key: "thread:thread-abc".into(),
            profile: "vm0/default".into(),
        }],
        mode: "running".into(),
    };
    let json: serde_json::Value = serde_json::to_value(&state).unwrap();
    assert_eq!(
        json,
        json!({
            "runnerId": "550e8400-e29b-41d4-a716-446655440000",
            "runnerHostname": "prod-wire.example.test",
            "group": "vm0/production",
            "snapshotGeneration": 7,
            "snapshotSequence": 42,
            "totalVcpu": 16,
            "totalMemoryMb": 32768,
            "maxConcurrent": 8,
            "allocatedVcpu": 6,
            "allocatedMemoryMb": 6144,
            "runningCount": 2,
            "admittableProfiles": ["vm0/default"],
            "heldSandboxStates": [{
                "reuseKey": "thread:thread-abc",
                "lastCompletedAt": "2026-05-28T00:00:00.000Z",
                "reusableSandbox": {
                    "sourceRunId": "33333333-3333-4333-8333-333333333333",
                    "profile": "vm0/default"
                }
            }],
            "heldHomeStates": [{
                "reuseKey": "thread:thread-abc",
                "lastCompletedAt": "2026-05-28T00:00:00.000Z",
                "homeCaches": [{
                    "sourceRunId": "33333333-3333-4333-8333-333333333333",
                    "profile": "vm0/large",
                    "homeAffinityVersion": 1
                }]
            }],
            "activeReuseProducers": [{
                "runId": "22222222-2222-4222-8222-222222222222",
                "reuseKey": "thread:thread-abc",
                "profile": "vm0/default"
            }],
            "mode": "running"
        })
    );
}

#[test]
fn heartbeat_state_serializes_empty_held_state_arrays() {
    let state = HeartbeatState {
        runner_id: "550e8400-e29b-41d4-a716-446655440000".into(),
        runner_hostname: None,
        group: "vm0/production".into(),
        snapshot_generation: 7,
        snapshot_sequence: 42,
        total_vcpu: 16,
        total_memory_mb: 32768,
        max_concurrent: 8,
        allocated_vcpu: 0,
        allocated_memory_mb: 0,
        running_count: 0,
        admittable_profiles: vec!["vm0/default".into()],
        held_sandbox_states: Vec::new(),
        held_home_states: Vec::new(),
        active_reuse_producers: Vec::new(),
        mode: "running".into(),
    };

    let serialized = serde_json::to_value(state).unwrap();
    assert!(serialized.get("runnerHostname").is_none());
    assert_eq!(serialized["heldSandboxStates"], json!([]));
    assert_eq!(serialized["heldHomeStates"], json!([]));
    assert_eq!(serialized["activeReuseProducers"], json!([]));
}
