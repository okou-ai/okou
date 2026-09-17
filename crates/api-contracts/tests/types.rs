use std::collections::BTreeMap;

use api_contracts::generated::types::{
    runners::{
        jobs::pi_handoff,
        runs::{
            CodexRuntimeConfig, PiLaunchConfig, PiLaunchConfigApiFirstTurn,
            PiLaunchConfigApiFirstTurnBaseSession, PiLaunchConfigMemoryRecall, PiModelConfig,
            PiModelConfigApiKeyEnv, PiModelConfigProvider, PiModelConfigServiceTier,
            PiModelConfigV2, PiModelConfigV3, cancellation, model_provider_failures,
        },
        storage as runner_storage,
    },
    webhooks::agent::{
        checkpoints::{self, prepare_history},
        complete,
        storages::{FileEntryWithHash, commit, prepare},
    },
};
use serde_json::json;

#[test]
fn deferred_handoff_response_is_strict_and_deserialize_only() {
    let response: pi_handoff::Response = serde_json::from_value(json!({
        "chunk": "YWJj",
        "nextOffset": 3,
    }))
    .unwrap();
    assert_eq!(response.chunk, "YWJj");
    assert_eq!(response.next_offset, Some(3));
    assert!(
        serde_json::from_value::<pi_handoff::Response>(json!({
            "chunk": "YWJj",
            "nextOffset": null,
            "unexpected": true,
        }))
        .is_err()
    );
}

#[test]
fn generated_run_cancellation_response_preserves_absence_and_nullable_intent() {
    for state in [
        json!({ "state": "present", "mode": null }),
        json!({ "state": "present", "mode": "cooperative" }),
        json!({ "state": "present", "mode": "hard" }),
        json!({ "state": "gone" }),
        json!({ "state": "unavailable" }),
    ] {
        let mut value = state;
        value["protocolVersion"] = json!(1);
        value["runId"] = json!("00000000-0000-4000-8000-000000000001");
        let response: cancellation::Response = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(response).unwrap(), value);
    }

    assert!(
        serde_json::from_value::<cancellation::Response>(json!({
            "protocolVersion": 1,
            "runId": "00000000-0000-4000-8000-000000000001",
            "state": "present",
            "mode": "unknown-mode",
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<cancellation::Response>(json!({
            "protocolVersion": 1,
            "state": "gone",
        }))
        .is_err()
    );
}

#[test]
fn generated_completion_failure_reason_tokens_preserve_the_wire_contract() {
    let failure_reasons = [
        "session_history_limit",
        "execution_timeout",
        "insufficient_credits",
        "provider_insufficient_credits",
        "invalid_api_key",
        "invalid_credentials",
        "terms_acceptance_required",
        "context_window_exceeded",
        "input_too_large",
        "output_token_limit",
        "provider_rate_limited",
        "provider_overloaded",
        "provider_stream_timeout",
        "provider_server_error",
        "response_connection_lost",
        "safety_policy_refusal",
        "reconnect_required",
        "unsupported_model",
        "usage_limit",
    ];

    for failure_reason in failure_reasons {
        let value = json!({
            "runId": "run-1",
            "exitCode": 1,
            "failureReason": failure_reason,
        });
        let request: complete::Request = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), value);
    }

    let omitted = json!({
        "runId": "run-1",
        "exitCode": 1,
    });
    let legacy_request: complete::Request = serde_json::from_value(omitted.clone()).unwrap();
    assert_eq!(legacy_request.failure_reason, None);
    assert_eq!(serde_json::to_value(legacy_request).unwrap(), omitted);

    let future = json!({
        "runId": "run-1",
        "exitCode": 1,
        "failureReason": "future_reason",
    });
    let future_request: complete::Request = serde_json::from_value(future.clone()).unwrap();
    assert_eq!(serde_json::to_value(future_request).unwrap(), future);
}

#[test]
fn generated_model_provider_failure_request_requires_connection_source() {
    let request = model_provider_failures::Request::Connection {
        connection_source: model_provider_failures::RequestConnectionSource::UpstreamTransport,
        retry_after_seconds: None,
    };

    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "failureKind": "connection",
            "connectionSource": "upstream_transport",
        })
    );
    assert!(
        serde_json::from_value::<model_provider_failures::Request>(json!({
            "failureKind": "connection",
        }))
        .is_err()
    );
}

#[test]
fn generated_codex_runtime_config_round_trips_full_wire_shape() {
    let config = CodexRuntimeConfig {
        provider_id: "gateway".to_string(),
        name: "Gateway".to_string(),
        base_url: "https://gateway.example.test/v1".to_string(),
        env_key: "OPENAI_API_KEY".to_string(),
        http_headers: Some(BTreeMap::from([(
            "x-api-key".to_string(),
            "__VM0_OPENAI_API_KEY_PLACEHOLDER__".to_string(),
        )])),
        requires_openai_auth: Some(false),
        wire_api: "responses".to_string(),
        supports_websockets: false,
        model_catalog: Some(json!({
            "models": [{
                "slug": "upstream-model",
                "input_modalities": ["text"],
            }],
        })),
    };

    let value = serde_json::to_value(&config).unwrap();
    assert_eq!(
        value,
        json!({
            "providerId": "gateway",
            "name": "Gateway",
            "baseUrl": "https://gateway.example.test/v1",
            "envKey": "OPENAI_API_KEY",
            "httpHeaders": {
                "x-api-key": "__VM0_OPENAI_API_KEY_PLACEHOLDER__",
            },
            "requiresOpenaiAuth": false,
            "wireApi": "responses",
            "supportsWebsockets": false,
            "modelCatalog": {
                "models": [{
                    "slug": "upstream-model",
                    "input_modalities": ["text"],
                }],
            },
        })
    );

    let round_trip: CodexRuntimeConfig = serde_json::from_value(value).unwrap();
    assert_eq!(round_trip, config);
}

#[test]
fn generated_codex_runtime_config_omits_absent_options_and_accepts_legacy_null() {
    let canonical = json!({
        "providerId": "deepseek",
        "name": "DeepSeek",
        "baseUrl": "https://api.deepseek.com/",
        "envKey": "OPENAI_API_KEY",
        "wireApi": "responses",
        "supportsWebsockets": false,
    });
    let config = CodexRuntimeConfig {
        provider_id: "deepseek".to_string(),
        name: "DeepSeek".to_string(),
        base_url: "https://api.deepseek.com/".to_string(),
        env_key: "OPENAI_API_KEY".to_string(),
        http_headers: None,
        requires_openai_auth: None,
        wire_api: "responses".to_string(),
        supports_websockets: false,
        model_catalog: None,
    };

    assert_eq!(serde_json::to_value(&config).unwrap(), canonical);

    let legacy: CodexRuntimeConfig = serde_json::from_value(json!({
        "providerId": "deepseek",
        "name": "DeepSeek",
        "baseUrl": "https://api.deepseek.com/",
        "envKey": "OPENAI_API_KEY",
        "wireApi": "responses",
        "supportsWebsockets": false,
        "modelCatalog": null,
    }))
    .unwrap();
    assert_eq!(legacy.model_catalog, None);
    assert_eq!(serde_json::to_value(legacy).unwrap(), canonical);
}

#[test]
fn generated_pi_runtime_configs_round_trip_full_wire_shapes() {
    let session_id = "22222222-2222-4222-8222-222222222222";
    let launch = PiLaunchConfig {
        schema_version: 2,
        api_first_turn: PiLaunchConfigApiFirstTurn {
            schema_version: 1,
            resource_snapshot_digest: "a".repeat(64),
            manifest_url: "https://storage.example/manifest.json".to_string(),
            session_url: "https://storage.example/session.jsonl".to_string(),
            deadline_at: 2_000_000_000_000,
            base_session: PiLaunchConfigApiFirstTurnBaseSession {
                session_id: session_id.to_string(),
                sha256: Some("b".repeat(64)),
            },
            sandbox_event_sequence_start: 1,
        },
        memory_recall: None,
        maintenance: None,
    };
    let model = PiModelConfig {
        provider: PiModelConfigProvider::Deepseek,
        base_url: "https://api.deepseek.com/".to_string(),
        model: "deepseek-v4-flash".to_string(),
        catalog_model: None,
        thinking_level: None,
        service_tier: None,
        api_key_env: PiModelConfigApiKeyEnv::OPENAIAPIKEY,
        credential_secret_name: "DEEPSEEK_API_KEY".to_string(),
        credential_header: None,
    };

    let launch_value = serde_json::to_value(&launch).unwrap();
    assert_eq!(
        launch_value,
        json!({
            "schemaVersion": 2,
            "apiFirstTurn": {
                "schemaVersion": 1,
                "resourceSnapshotDigest": "a".repeat(64),
                "manifestUrl": "https://storage.example/manifest.json",
                "sessionUrl": "https://storage.example/session.jsonl",
                "deadlineAt": 2_000_000_000_000_i64,
                "baseSession": {
                    "sessionId": session_id,
                    "sha256": "b".repeat(64),
                },
                "sandboxEventSequenceStart": 1,
            },
        })
    );
    assert_eq!(
        serde_json::from_value::<PiLaunchConfig>(launch_value).unwrap(),
        launch
    );

    let model_value = serde_json::to_value(&model).unwrap();
    assert_eq!(
        model_value,
        json!({
            "provider": "deepseek",
            "baseUrl": "https://api.deepseek.com/",
            "model": "deepseek-v4-flash",
            "apiKeyEnv": "OPENAI_API_KEY",
            "credentialSecretName": "DEEPSEEK_API_KEY",
        })
    );
    assert_eq!(
        serde_json::from_value::<PiModelConfig>(model_value).unwrap(),
        model
    );

    // Unknown wire fields keep serde's existing policy: discard them on decode.
    for api in [
        "openai-responses",
        "openai-completions",
        "openai-codex-responses",
    ] {
        let mut legacy_value = serde_json::to_value(&model).unwrap();
        legacy_value["api"] = json!(api);
        let decoded: PiModelConfig = serde_json::from_value(legacy_value).unwrap();
        assert_eq!(decoded, model);
        assert_eq!(
            serde_json::to_value(decoded).unwrap(),
            serde_json::to_value(&model).unwrap()
        );
    }

    let priority_model_value = json!({
        "provider": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "model": "gpt-5.6-terra",
        "thinkingLevel": "low",
        "serviceTier": "priority",
        "apiKeyEnv": "OPENAI_API_KEY",
        "credentialSecretName": "OPENAI_API_KEY",
    });
    let priority_model: PiModelConfig =
        serde_json::from_value(priority_model_value.clone()).unwrap();
    assert_eq!(
        priority_model.service_tier,
        Some(PiModelConfigServiceTier::Priority)
    );
    assert_eq!(
        serde_json::to_value(priority_model).unwrap(),
        priority_model_value
    );
}

#[test]
fn generated_pi_launch_config_round_trips_null_base_hash() {
    let value = json!({
        "schemaVersion": 2,
        "apiFirstTurn": {
            "schemaVersion": 1,
            "resourceSnapshotDigest": "a".repeat(64),
            "manifestUrl": "https://storage.example/manifest.json",
            "sessionUrl": "https://storage.example/session.jsonl",
            "deadlineAt": 2_000_000_000_000_i64,
            "baseSession": {
                "sessionId": "22222222-2222-4222-8222-222222222222",
                "sha256": null,
            },
            "sandboxEventSequenceStart": 1,
        },
    });

    let launch: PiLaunchConfig = serde_json::from_value(value.clone()).unwrap();

    assert_eq!(launch.api_first_turn.base_session.sha256, None);
    assert_eq!(serde_json::to_value(launch).unwrap(), value);
}

#[test]
fn generated_pi_launch_config_round_trips_frozen_memory() {
    let value = json!({
        "schemaVersion": 2,
        "apiFirstTurn": {
            "schemaVersion": 1,
            "resourceSnapshotDigest": "a".repeat(64),
            "manifestUrl": "https://storage.example/manifest.json",
            "sessionUrl": "https://storage.example/session.jsonl",
            "deadlineAt": 2_000_000_000_000_i64,
            "baseSession": {
                "sessionId": "22222222-2222-4222-8222-222222222222",
                "sha256": null,
            },
            "sandboxEventSequenceStart": 1,
        },
        "memoryRecall": {
            "status": "ready",
            "memoryStorageId": "memory-storage",
            "storageVersionId": "memory-version-a",
            "content": "bounded memory",
            "sourceHash": "b".repeat(64),
            "sourceSize": 14,
            "tokenCount": 2,
        },
    });

    let launch: PiLaunchConfig = serde_json::from_value(value.clone()).unwrap();
    assert!(matches!(
        launch.memory_recall.as_ref(),
        Some(PiLaunchConfigMemoryRecall::Ready {
            memory_storage_id,
            storage_version_id,
            content,
            ..
        }) if memory_storage_id == "memory-storage"
            && storage_version_id == "memory-version-a"
            && content == "bounded memory"
    ));
    assert_eq!(serde_json::to_value(launch).unwrap(), value);
}

#[test]
fn generated_pi_model_config_rejects_unknown_enums() {
    for (field, value) in [
        ("provider", "future-provider"),
        ("apiKeyEnv", "FUTURE_API_KEY"),
        ("serviceTier", "fast"),
    ] {
        let mut config = json!({
            "provider": "deepseek",
            "baseUrl": "https://api.deepseek.com/",
            "model": "deepseek-v4-flash",
            "apiKeyEnv": "OPENAI_API_KEY",
            "credentialSecretName": "DEEPSEEK_API_KEY",
        });
        config[field] = json!(value);

        assert!(
            serde_json::from_value::<PiModelConfig>(config).is_err(),
            "{field} should reject {value}"
        );
    }
}

#[test]
fn generated_pi_model_config_v2_round_trips_both_dialects() {
    let public_responses = json!({
        "schemaVersion": 2,
        "dialect": "openai-responses",
        "transport": "sse",
        "provider": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "model": "gpt-5.6-terra",
        "thinkingLevel": "low",
        "credentialBindings": [{
            "kind": "api-key",
            "environment": "OPENAI_API_KEY",
            "secretName": "OPENAI_API_KEY",
        }],
    });
    let codex_responses = json!({
        "schemaVersion": 2,
        "dialect": "openai-codex-responses",
        "transport": "sse",
        "provider": "openai-codex",
        "baseUrl": "https://chatgpt.com/backend-api",
        "model": "gpt-5.6-terra",
        "thinkingLevel": "low",
        "credentialBindings": [
            {
                "kind": "access-token",
                "environment": "CHATGPT_ACCESS_TOKEN",
                "secretName": "CHATGPT_ACCESS_TOKEN",
            },
            {
                "kind": "account-id",
                "environment": "CHATGPT_ACCOUNT_ID",
                "secretName": "CHATGPT_ACCOUNT_ID",
            },
        ],
    });

    for value in [public_responses, codex_responses] {
        let decoded: PiModelConfigV2 = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), value);
        assert!(serde_json::from_value::<PiModelConfig>(value).is_err());
    }
}

#[test]
fn generated_checkpoint_request_omits_absent_snapshots() {
    let history_hash = "a".repeat(64);
    let request = checkpoints::Request {
        run_id: "run-1".to_string(),
        cli_agent_type: "claude-code".to_string(),
        cli_agent_session_id: "session-1".to_string(),
        cli_agent_session_history_hash: Some(history_hash.clone()),
        cli_agent_session_history_disposition: None,
        artifact_snapshots: None,
        volume_versions_snapshot: None,
    };

    let value = serde_json::to_value(request).unwrap();
    assert_eq!(
        value,
        json!({
            "runId": "run-1",
            "cliAgentType": "claude-code",
            "cliAgentSessionId": "session-1",
            "cliAgentSessionHistoryHash": history_hash,
        })
    );
    assert!(value.get("artifactSnapshots").is_none());
    assert!(value.get("volumeVersionsSnapshot").is_none());
}

#[test]
fn generated_checkpoint_request_round_trips_preserve_parent_snapshot() {
    let request = checkpoints::Request {
        run_id: "run-1".to_string(),
        cli_agent_type: "codex".to_string(),
        cli_agent_session_id: "session-1".to_string(),
        cli_agent_session_history_hash: Some("b".repeat(64)),
        cli_agent_session_history_disposition: None,
        artifact_snapshots: Some(vec![checkpoints::ArtifactSnapshot {
            name: "memory".to_string(),
            version: "version-1".to_string(),
            mount_path: "/memory".to_string(),
            missing_root_policy: Some(
                runner_storage::ArtifactEntryMissingRootPolicy::PreserveParentVersion,
            ),
        }]),
        volume_versions_snapshot: None,
    };

    let value = serde_json::to_value(&request).unwrap();
    assert_eq!(
        value,
        json!({
            "runId": "run-1",
            "cliAgentType": "codex",
            "cliAgentSessionId": "session-1",
            "cliAgentSessionHistoryHash": "b".repeat(64),
            "artifactSnapshots": [{
                "name": "memory",
                "version": "version-1",
                "mountPath": "/memory",
                "missingRootPolicy": "preserveParentVersion",
            }],
        })
    );

    let round_trip: checkpoints::Request = serde_json::from_value(value).unwrap();
    assert_eq!(round_trip, request);
}

#[test]
fn generated_checkpoint_request_serializes_discarded_oversized_history() {
    let request = checkpoints::Request {
        run_id: "run-1".to_string(),
        cli_agent_type: "codex".to_string(),
        cli_agent_session_id: "session-1".to_string(),
        cli_agent_session_history_hash: None,
        cli_agent_session_history_disposition: Some(
            checkpoints::RequestCliAgentSessionHistoryDisposition::DiscardedOversized,
        ),
        artifact_snapshots: None,
        volume_versions_snapshot: None,
    };

    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "runId": "run-1",
            "cliAgentType": "codex",
            "cliAgentSessionId": "session-1",
            "cliAgentSessionHistoryDisposition": "discarded_oversized",
        })
    );
}

#[test]
fn generated_checkpoint_request_serializes_unavailable_history() {
    let request = checkpoints::Request {
        run_id: "run-1".to_string(),
        cli_agent_type: "claude-code".to_string(),
        cli_agent_session_id: "session-1".to_string(),
        cli_agent_session_history_hash: None,
        cli_agent_session_history_disposition: Some(
            checkpoints::RequestCliAgentSessionHistoryDisposition::Unavailable,
        ),
        artifact_snapshots: None,
        volume_versions_snapshot: None,
    };

    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "runId": "run-1",
            "cliAgentType": "claude-code",
            "cliAgentSessionId": "session-1",
            "cliAgentSessionHistoryDisposition": "unavailable",
        })
    );
}

#[test]
fn generated_checkpoint_response_deserializes_canonical_shapes() {
    let minimal: checkpoints::Response = serde_json::from_value(json!({
        "checkpointId": "checkpoint-1",
        "agentSessionId": "agent-session-1",
        "conversationId": "conversation-1",
    }))
    .unwrap();
    assert_eq!(minimal.checkpoint_id, "checkpoint-1");
    assert_eq!(minimal.agent_session_id, "agent-session-1");
    assert_eq!(minimal.conversation_id, "conversation-1");
    assert!(minimal.artifacts.is_none());
    assert!(minimal.volumes.is_none());

    let full: checkpoints::Response = serde_json::from_value(json!({
        "checkpointId": "checkpoint-2",
        "agentSessionId": "agent-session-2",
        "conversationId": "conversation-2",
        "artifacts": [{
            "name": "memory",
            "version": "version-2",
            "mountPath": "/memory",
            "missingRootPolicy": "preserveParentVersion",
        }],
        "volumes": {
            "workspace": "volume-version-2",
        },
    }))
    .unwrap();
    assert_eq!(
        full.artifacts.unwrap(),
        vec![checkpoints::ArtifactSnapshot {
            name: "memory".to_string(),
            version: "version-2".to_string(),
            mount_path: "/memory".to_string(),
            missing_root_policy: Some(
                runner_storage::ArtifactEntryMissingRootPolicy::PreserveParentVersion,
            ),
        }]
    );
    assert_eq!(
        full.volumes.unwrap(),
        BTreeMap::from([("workspace".to_string(), "volume-version-2".to_string())])
    );
}

#[test]
fn generated_checkpoint_response_rejects_invalid_required_fields() {
    for response in [
        json!({
            "checkpointId": "checkpoint-1",
            "conversationId": "conversation-1",
        }),
        json!({
            "checkpointId": "checkpoint-1",
            "agentSessionId": false,
            "conversationId": "conversation-1",
        }),
    ] {
        assert!(serde_json::from_value::<checkpoints::Response>(response).is_err());
    }
}

#[test]
fn generated_checkpoint_prepare_request_serializes_wire_shape() {
    let request = prepare_history::Request {
        run_id: "run-1".to_string(),
        hash: "a".repeat(64),
        raw_size: 4096,
        encoded_size: 1024,
        encoding: Some(prepare_history::SessionHistoryEncoding::Zstd),
    };
    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "runId": "run-1",
            "hash": "a".repeat(64),
            "rawSize": 4096,
            "encodedSize": 1024,
            "encoding": "zstd",
        })
    );

    let request_without_encoding = prepare_history::Request {
        run_id: "run-2".to_string(),
        hash: "b".repeat(64),
        raw_size: 64,
        encoded_size: 64,
        encoding: None,
    };
    let value = serde_json::to_value(request_without_encoding).unwrap();
    assert!(value.get("encoding").is_none());
}

#[test]
fn generated_checkpoint_prepare_encoding_serializes_wire_values() {
    for (encoding, wire_value) in [
        (
            prepare_history::SessionHistoryEncoding::Identity,
            "identity",
        ),
        (prepare_history::SessionHistoryEncoding::Gzip, "gzip"),
        (prepare_history::SessionHistoryEncoding::Zstd, "zstd"),
    ] {
        assert_eq!(serde_json::to_value(encoding).unwrap(), json!(wire_value));
        assert_eq!(
            serde_json::from_value::<prepare_history::SessionHistoryEncoding>(json!(wire_value))
                .unwrap(),
            encoding
        );
    }
}

#[test]
fn generated_checkpoint_prepare_response_deserializes_canonical_shapes() {
    let existing: prepare_history::Response = serde_json::from_value(json!({
        "existing": true,
        "encoding": "gzip",
    }))
    .unwrap();
    assert!(existing.existing);
    assert!(existing.presigned_url.is_none());
    assert_eq!(
        existing.encoding,
        Some(prepare_history::SessionHistoryEncoding::Gzip)
    );

    let upload: prepare_history::Response = serde_json::from_value(json!({
        "presignedUrl": "https://storage.example.test/session-history",
        "existing": false,
        "encoding": "zstd",
    }))
    .unwrap();
    assert!(!upload.existing);
    assert_eq!(
        upload.presigned_url.as_deref(),
        Some("https://storage.example.test/session-history")
    );
    assert_eq!(
        upload.encoding,
        Some(prepare_history::SessionHistoryEncoding::Zstd)
    );
}

#[test]
fn generated_checkpoint_prepare_response_rejects_invalid_existing() {
    for response in [
        json!({"presignedUrl": "https://storage.example.test/session-history"}),
        json!({"existing": "false"}),
    ] {
        assert!(serde_json::from_value::<prepare_history::Response>(response).is_err());
    }
}

#[test]
fn generated_prepare_request_serializes_wire_shape() {
    let hash = "a".repeat(64);
    let request = prepare::Request {
        run_id: "run-1".to_string(),
        storage_id: "00000000-0000-4000-8000-000000000001".to_string(),
        files: vec![FileEntryWithHash {
            path: "file.txt".to_string(),
            hash: hash.clone(),
            size: 12,
        }],
        parent_version_id: None,
        force: None,
        base_version: None,
        changes: None,
        maintenance_attestation: None,
    };

    let value = serde_json::to_value(request).unwrap();
    assert_eq!(
        value,
        json!({
            "runId": "run-1",
            "storageId": "00000000-0000-4000-8000-000000000001",
            "files": [{
                "path": "file.txt",
                "hash": hash,
                "size": 12,
            }],
        })
    );
    assert!(value.get("parentVersionId").is_none());
    assert!(value.get("force").is_none());
    assert!(value.get("baseVersion").is_none());
    assert!(value.get("changes").is_none());
}

#[test]
fn generated_prepare_request_serializes_optional_fields() {
    let request = prepare::Request {
        run_id: "run-1".to_string(),
        storage_id: "00000000-0000-4000-8000-000000000001".to_string(),
        files: vec![],
        parent_version_id: Some("parent-1".to_string()),
        force: Some(true),
        base_version: Some("base-1".to_string()),
        changes: Some(prepare::RequestChanges {
            added: vec!["new.txt".to_string()],
            modified: vec!["changed.txt".to_string()],
            deleted: vec!["old.txt".to_string()],
        }),
        maintenance_attestation: None,
    };

    let value = serde_json::to_value(request).unwrap();
    assert_eq!(value["storageId"], "00000000-0000-4000-8000-000000000001");
    assert_eq!(value["parentVersionId"], "parent-1");
    assert_eq!(value["force"], true);
    assert_eq!(value["baseVersion"], "base-1");
    assert_eq!(value["changes"]["added"], json!(["new.txt"]));
}

#[test]
fn generated_prepare_response_deserializes_deduplicated_shape() {
    let response: prepare::Response = serde_json::from_value(json!({
        "versionId": "version-1",
        "existing": true,
    }))
    .unwrap();

    assert_eq!(response.version_id, "version-1");
    assert!(response.existing);
    assert!(response.uploads.is_none());
}

#[test]
fn generated_prepare_response_deserializes_upload_shape() {
    let response: prepare::Response = serde_json::from_value(json!({
        "versionId": "version-1",
        "existing": false,
        "uploads": {
            "archive": {
                "key": "archive-key",
                "presignedUrl": "https://example.test/archive",
            },
            "manifest": {
                "key": "manifest-key",
                "presignedUrl": "https://example.test/manifest",
            },
        },
    }))
    .unwrap();

    let uploads = response.uploads.unwrap();
    assert_eq!(uploads.archive.key, "archive-key");
    assert_eq!(
        uploads.archive.presigned_url,
        "https://example.test/archive"
    );
    assert_eq!(uploads.manifest.key, "manifest-key");
    assert_eq!(
        uploads.manifest.presigned_url,
        "https://example.test/manifest"
    );
}

#[test]
fn generated_commit_request_serializes_wire_shape() {
    let hash = "b".repeat(64);
    let request = commit::Request {
        run_id: "run-1".to_string(),
        storage_id: "00000000-0000-4000-8000-000000000001".to_string(),
        version_id: "version-1".to_string(),
        parent_version_id: None,
        files: vec![FileEntryWithHash {
            path: "file.txt".to_string(),
            hash: hash.clone(),
            size: 34,
        }],
        message: Some("checkpoint".to_string()),
        maintenance_attestation: None,
    };

    let value = serde_json::to_value(request).unwrap();
    assert_eq!(
        value,
        json!({
            "runId": "run-1",
            "storageId": "00000000-0000-4000-8000-000000000001",
            "versionId": "version-1",
            "files": [{
                "path": "file.txt",
                "hash": hash,
                "size": 34,
            }],
            "message": "checkpoint",
        })
    );
    assert!(value.get("parentVersionId").is_none());
}

#[test]
fn generated_commit_request_preserves_empty_message() {
    let request = commit::Request {
        run_id: "run-1".to_string(),
        storage_id: "00000000-0000-4000-8000-000000000001".to_string(),
        version_id: "version-1".to_string(),
        parent_version_id: None,
        files: vec![],
        message: Some(String::new()),
        maintenance_attestation: None,
    };

    let value = serde_json::to_value(request).unwrap();
    assert_eq!(value["storageId"], "00000000-0000-4000-8000-000000000001");
    assert_eq!(value["message"], "");
}

#[test]
fn generated_commit_response_deserializes_success_shape() {
    let response: commit::Response = serde_json::from_value(json!({
        "success": true,
        "versionId": "version-1",
        "storageName": "memory",
        "size": 42,
        "fileCount": 3,
        "deduplicated": true,
    }))
    .unwrap();

    assert!(response.success);
    assert_eq!(response.version_id, "version-1");
    assert_eq!(response.storage_name, "memory");
    assert_eq!(response.size, 42.0);
    assert_eq!(response.file_count, 3.0);
    assert_eq!(response.deduplicated, Some(true));
}

#[test]
fn generated_storage_mount_entry_preserves_canonical_shape() {
    let mount: runner_storage::StorageMountEntry = serde_json::from_value(json!({
        "name": "memory",
        "storageId": "storage-id-1",
        "versionId": "version-1",
        "mountPath": "/memory",
        "empty": true,
        "missingRootPolicy": "preserveParentVersion",
        "writeback": true,
    }))
    .unwrap();

    assert_eq!(mount.name, "memory");
    assert_eq!(mount.storage_id, "storage-id-1");
    assert_eq!(mount.version_id, "version-1");
    assert_eq!(mount.empty, Some(true));
    assert_eq!(mount.writeback, Some(true));
    assert_eq!(
        mount.missing_root_policy,
        Some(runner_storage::ArtifactEntryMissingRootPolicy::PreserveParentVersion)
    );
}

#[test]
fn generated_pi_model_config_v3_preserves_native_fast() {
    let value = serde_json::json!({
        "schemaVersion": 3,
        "dialect": "openai-codex-responses",
        "transport": "sse",
        "provider": "openai-codex",
        "baseUrl": "https://chatgpt.com/backend-api",
        "model": "gpt-5.6-terra",
        "serviceTier": "fast",
        "credentialBindings": [
            { "kind": "access-token", "environment": "CHATGPT_ACCESS_TOKEN", "secretName": "CHATGPT_ACCESS_TOKEN" },
            { "kind": "account-id", "environment": "CHATGPT_ACCOUNT_ID", "secretName": "CHATGPT_ACCOUNT_ID" }
        ]
    });
    let decoded: PiModelConfigV3 = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    assert!(serde_json::from_value::<PiModelConfigV2>(value.clone()).is_err());
    for dialect in ["openai-responses", "openai-codex-responses"] {
        for tier in [None, Some("priority"), Some("fast"), Some("unknown")] {
            let mut candidate = value.clone();
            candidate["dialect"] = serde_json::json!(dialect);
            if dialect == "openai-responses" {
                candidate["provider"] = serde_json::json!("openai");
                candidate["credentialBindings"] = serde_json::json!([
                    { "kind": "api-key", "environment": "OPENAI_API_KEY", "secretName": "OPENAI_API_KEY" }
                ]);
            }
            if let Some(tier) = tier {
                candidate["serviceTier"] = serde_json::json!(tier);
            } else {
                candidate.as_object_mut().unwrap().remove("serviceTier");
            }
            let supported = tier.is_none()
                || (dialect == "openai-responses" && tier == Some("priority"))
                || (dialect == "openai-codex-responses" && tier == Some("fast"));
            let decoded = serde_json::from_value::<PiModelConfigV3>(candidate.clone());
            assert_eq!(decoded.is_ok(), supported, "{candidate}");
            if let Ok(decoded) = decoded {
                assert_eq!(serde_json::to_value(decoded).unwrap(), candidate);
            }
        }
    }
}
