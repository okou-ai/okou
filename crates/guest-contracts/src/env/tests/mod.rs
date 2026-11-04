use super::*;

#[test]
fn cli_agent_type_selection_covers_known_empty_and_unknown_values() {
    for (value, framework) in [
        ("claude-code", CliFramework::ClaudeCode),
        ("codex", CliFramework::Codex),
        ("pi", CliFramework::Pi),
    ] {
        let selection = CliAgentTypeSelection::parse(value);

        assert_eq!(selection.framework(), framework);
        assert_eq!(selection.normalized_cli_agent_type(), value);
        assert!(!selection.is_unknown());
        assert_eq!(framework.as_cli_agent_type(), value);
    }

    let empty = CliAgentTypeSelection::parse("");
    assert_eq!(empty.framework(), CliFramework::ClaudeCode);
    assert_eq!(empty.normalized_cli_agent_type(), "claude-code");
    assert!(!empty.is_unknown());

    let unknown = CliAgentTypeSelection::parse("custom-agent");
    assert_eq!(unknown.framework(), CliFramework::ClaudeCode);
    assert_eq!(unknown.normalized_cli_agent_type(), "custom-agent");
    assert!(unknown.is_unknown());
}

#[test]
fn run_artifacts_round_trip_with_and_without_missing_root_policy() {
    let artifacts = vec![
        RunArtifact {
            name: "plain".to_string(),
            mount_path: "/plain".to_string(),
            storage_id: "storage-plain".to_string(),
            version_id: "version-plain".to_string(),
            missing_root_policy: None,
        },
        RunArtifact {
            name: "memory".to_string(),
            mount_path: "/memory".to_string(),
            storage_id: "storage-memory".to_string(),
            version_id: "version-memory".to_string(),
            missing_root_policy: Some(RunArtifactMissingRootPolicy::PreserveParentVersion),
        },
    ];

    let json = serde_json::to_value(&artifacts).unwrap();

    assert_eq!(
        json,
        serde_json::json!([
            {
                "name": "plain",
                "mountPath": "/plain",
                "storageId": "storage-plain",
                "versionId": "version-plain"
            },
            {
                "name": "memory",
                "mountPath": "/memory",
                "storageId": "storage-memory",
                "versionId": "version-memory",
                "missingRootPolicy": "preserveParentVersion"
            }
        ])
    );
    assert_eq!(
        serde_json::from_value::<Vec<RunArtifact>>(json).unwrap(),
        artifacts
    );
}

#[test]
fn run_artifact_requires_all_string_fields() {
    let artifact = serde_json::json!({
        "name": "artifact",
        "mountPath": "/artifact",
        "storageId": "storage",
        "versionId": "version"
    });

    for field in ["name", "mountPath", "storageId", "versionId"] {
        let mut missing = artifact.clone();
        missing.as_object_mut().unwrap().remove(field);

        assert!(serde_json::from_value::<RunArtifact>(missing).is_err());
    }
}

#[test]
fn contract_names_match_wire_values() {
    assert_eq!(CANONICAL_API_URL_ENV, "OKOU_API_BACKEND_URL");
    assert_eq!(RUN_ID_ENV, "OKOU_RUN_ID");
    assert_eq!(CANONICAL_API_TOKEN_ENV, "OKOU_API_TOKEN");
    assert_eq!(CANONICAL_SANDBOX_ID_ENV, "OKOU_SANDBOX_ID");
    assert_eq!(CANONICAL_RESUME_SESSION_ID_ENV, "OKOU_RESUME_SESSION_ID");
    assert_eq!(CANONICAL_API_START_TIME_ENV, "OKOU_API_START_TIME");
    assert_eq!(PI_SESSION_ID_ENV, "OKOU_PI_SESSION_ID");
    assert_eq!(PI_LAUNCH_CONFIG_ENV, "OKOU_PI_LAUNCH_CONFIG");
    assert_eq!(PI_LAUNCH_PAYLOAD_FILE_ENV, "OKOU_PI_LAUNCH_PAYLOAD_FILE");
    assert_eq!(PI_LAUNCH_PAYLOAD_PRIVATE_DIR_NAME, "pi-launch-payload");
    assert_eq!(PI_LAUNCH_PAYLOAD_FILENAME, "payload.json");
    assert_eq!(PI_MODEL_CONFIG_ENV, "OKOU_PI_MODEL_CONFIG");
    assert_eq!(PI_PREPARATION_TIMING_ENV, "OKOU_PI_PREPARATION_TIMING");
    assert_eq!(PI_PREPARATION_TIMING_ENABLED, "1");
    assert_eq!(CLI_AGENT_TYPE_ENV, "CLI_AGENT_TYPE");
    assert_eq!(
        CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
        "OKOU_AGENT_EXECUTION_TIMEOUT_SECS"
    );
    assert_eq!(CANONICAL_USER_ENV_FILE_ENV, "OKOU_USER_ENV_FILE");
    assert_eq!(USER_ENV_PRIVATE_DIR_NAME, "user-env");
    assert_eq!(USER_ENV_FILENAME, "env.json");
    assert_eq!(
        CONNECTOR_ACCOUNT_CONTEXT_FILE_ENV,
        "OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE"
    );
    assert_eq!(
        CONNECTOR_ACCOUNT_CONTEXT_PRIVATE_DIR_NAME,
        "connector-account-context"
    );
    assert_eq!(CONNECTOR_ACCOUNT_CONTEXT_FILENAME, "context.json");
    assert_eq!(CANONICAL_RUN_PAYLOAD_FILE_ENV, "OKOU_RUN_PAYLOAD_FILE");
    assert_eq!(RUN_PAYLOAD_PRIVATE_DIR_NAME, "run-payload");
    assert_eq!(RUN_PAYLOAD_FILENAME, "payload.json");
    assert_eq!(
        CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
        "OKOU_STUCK_TOOL_TIMEOUT_SECS"
    );
    assert_eq!(
        CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
        "OKOU_POST_RESULT_SIGTERM_GRACE_SECS"
    );
    assert_eq!(
        CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
        "OKOU_POST_RESULT_TOTAL_CAP_SECS"
    );
    assert_eq!(
        CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
        "OKOU_POST_RESULT_SIGKILL_GRACE_SECS"
    );
    assert_eq!(CANONICAL_MOCK_CLAUDE_PATH_ENV, "OKOU_MOCK_CLAUDE_PATH");
    assert_eq!(CANONICAL_MOCK_CODEX_PATH_ENV, "OKOU_MOCK_CODEX_PATH");
}

#[test]
fn run_payload_uses_camel_case_wire_keys() {
    let payload = RunPayload {
        prompt: "hello".to_string(),
        append_system_prompt: "system".to_string(),
        native_continuation: "{}".to_string(),
        secret_values: "secret".to_string(),
        disallowed_tools: "WebFetch".to_string(),
        tools: "Bash".to_string(),
        settings: "{}".to_string(),
        artifacts: "[]".to_string(),
        feature_flags: r#"{"flag":true}"#.to_string(),
        codex_runtime_config: r#"{"providerId":"openrouter-codex"}"#.to_string(),
        pi_launch_config: r#"{"schemaVersion":2}"#.to_string(),
        pi_model_config: r#"{"provider":"openrouter-codex"}"#.to_string(),
        pi_session_id: "22222222-2222-4222-8222-222222222222".to_string(),
    };

    let json = serde_json::to_value(&payload).unwrap();

    assert_eq!(json["prompt"], "hello");
    assert_eq!(json["appendSystemPrompt"], "system");
    assert_eq!(json["nativeContinuation"], "{}");
    assert_eq!(json["secretValues"], "secret");
    assert_eq!(json["disallowedTools"], "WebFetch");
    assert_eq!(json["featureFlags"], r#"{"flag":true}"#);
    assert_eq!(
        json["codexRuntimeConfig"],
        r#"{"providerId":"openrouter-codex"}"#
    );
    assert_eq!(json["piLaunchConfig"], r#"{"schemaVersion":2}"#);
    assert_eq!(json["piModelConfig"], r#"{"provider":"openrouter-codex"}"#);
    assert_eq!(json["piSessionId"], "22222222-2222-4222-8222-222222222222");
}

#[test]
fn run_payload_fields_returns_logical_names_and_values() {
    let payload = RunPayload {
        prompt: "prompt".to_string(),
        append_system_prompt: "system".to_string(),
        native_continuation: "{}".to_string(),
        secret_values: "secret".to_string(),
        disallowed_tools: "WebFetch".to_string(),
        tools: "Bash".to_string(),
        settings: "{}".to_string(),
        artifacts: "[]".to_string(),
        feature_flags: r#"{"flag":true}"#.to_string(),
        codex_runtime_config: r#"{"providerId":"openrouter-codex"}"#.to_string(),
        pi_launch_config: r#"{"schemaVersion":2}"#.to_string(),
        pi_model_config: r#"{"provider":"openrouter-codex"}"#.to_string(),
        pi_session_id: "22222222-2222-4222-8222-222222222222".to_string(),
    };

    let fields = payload.fields();

    assert_eq!(
        fields,
        [
            RunPayloadField {
                name: "nativeContinuation",
                value: "{}"
            },
            RunPayloadField {
                name: PROMPT_RUN_PAYLOAD_FIELD,
                value: "prompt"
            },
            RunPayloadField {
                name: APPEND_SYSTEM_PROMPT_RUN_PAYLOAD_FIELD,
                value: "system"
            },
            RunPayloadField {
                name: SECRET_VALUES_RUN_PAYLOAD_FIELD,
                value: "secret"
            },
            RunPayloadField {
                name: DISALLOWED_TOOLS_RUN_PAYLOAD_FIELD,
                value: "WebFetch"
            },
            RunPayloadField {
                name: TOOLS_RUN_PAYLOAD_FIELD,
                value: "Bash"
            },
            RunPayloadField {
                name: SETTINGS_RUN_PAYLOAD_FIELD,
                value: "{}"
            },
            RunPayloadField {
                name: ARTIFACTS_RUN_PAYLOAD_FIELD,
                value: "[]"
            },
            RunPayloadField {
                name: FEATURE_FLAGS_RUN_PAYLOAD_FIELD,
                value: r#"{"flag":true}"#
            },
            RunPayloadField {
                name: CODEX_RUNTIME_CONFIG_RUN_PAYLOAD_FIELD,
                value: r#"{"providerId":"openrouter-codex"}"#
            },
            RunPayloadField {
                name: PI_LAUNCH_CONFIG_RUN_PAYLOAD_FIELD,
                value: r#"{"schemaVersion":2}"#
            },
            RunPayloadField {
                name: PI_MODEL_CONFIG_RUN_PAYLOAD_FIELD,
                value: r#"{"provider":"openrouter-codex"}"#
            },
            RunPayloadField {
                name: PI_SESSION_ID_RUN_PAYLOAD_FIELD,
                value: "22222222-2222-4222-8222-222222222222"
            },
        ]
    );
}

#[test]
fn run_payload_first_nul_field_reports_logical_name() {
    let payload = RunPayload {
        settings: "bad\0settings".to_string(),
        ..RunPayload::default()
    };

    assert_eq!(payload.first_nul_field(), Some(SETTINGS_RUN_PAYLOAD_FIELD));
}

#[test]
fn run_payload_first_nul_field_accepts_clean_payload() {
    let payload = RunPayload {
        prompt: "prompt".to_string(),
        append_system_prompt: "system".to_string(),
        secret_values: "secret".to_string(),
        disallowed_tools: "WebFetch".to_string(),
        tools: "Bash".to_string(),
        settings: "{}".to_string(),
        artifacts: "[]".to_string(),
        feature_flags: r#"{"flag":true}"#.to_string(),
        codex_runtime_config: r#"{"providerId":"openrouter-codex"}"#.to_string(),
        ..RunPayload::default()
    };

    assert_eq!(payload.first_nul_field(), None);
}

#[test]
fn shell_identifier_env_key_accepts_supported_keys() {
    for key in ["FOO", "_FOO", "FOO_1", "_", "A1_B2"] {
        assert!(
            is_shell_identifier_env_key(key),
            "{key} should be a supported shell exec env key"
        );
    }
}

#[test]
fn shell_identifier_env_key_rejects_unsupported_keys() {
    for key in [
        "",
        "1BAD",
        "BAD-NAME",
        "BAD.NAME",
        "BAD NAME",
        "ÅKEY",
        "\u{00e9}clair",
    ] {
        assert!(
            !is_shell_identifier_env_key(key),
            "{key} should not be a supported shell exec env key"
        );
    }
}

#[test]
fn env_key_diagnostic_escapes_and_truncates() {
    let key = format!("BAD\n{}", "X".repeat(200));
    let diagnostic = sanitize_env_key_for_diagnostic(&key);

    assert!(diagnostic.starts_with(r"BAD\n"));
    assert!(diagnostic.ends_with("..."));
    assert!(!diagnostic.contains('\n'));
}

#[test]
fn runner_owned_key_detection_covers_terminal_contract() {
    for key in [
        CANONICAL_API_URL_ENV,
        RUN_ID_ENV,
        CANONICAL_API_TOKEN_ENV,
        CANONICAL_SANDBOX_ID_ENV,
        CANONICAL_RESUME_SESSION_ID_ENV,
        CANONICAL_API_START_TIME_ENV,
        PI_SESSION_ID_ENV,
        PI_LAUNCH_CONFIG_ENV,
        PI_LAUNCH_PAYLOAD_FILE_ENV,
        PI_MODEL_CONFIG_ENV,
        CONNECTOR_ACCOUNT_CONTEXT_FILE_ENV,
        CANONICAL_USER_ENV_FILE_ENV,
        CANONICAL_RUN_PAYLOAD_FILE_ENV,
        CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
        CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
        CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
        CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
        CLI_AGENT_TYPE_ENV,
        USE_MOCK_CLAUDE_ENV,
        USE_MOCK_CODEX_ENV,
        VERCEL_PROTECTION_BYPASS_ENV,
    ] {
        assert!(is_runner_owned_env_key(key), "{key} should be runner-owned");
    }
    assert!(is_runner_owned_env_key("OKOU_TOKEN"));
    assert!(is_runner_owned_env_key("OKOU_UNRELATED"));
    assert!(
        !is_runner_owned_env_key("CUSTOM_ENV"),
        "CUSTOM_ENV should be user-owned"
    );
}

/// Contract sources scanned for declared environment key constants.
///
/// Every module declaring a `*_ENV` bootstrap key must be listed here, or
/// its keys escape the protection check below.
const CONTRACT_ENV_SOURCES: &[(&str, &str)] = &[
    ("env.rs", include_str!("../../env.rs")),
    ("runtime_paths.rs", include_str!("../../runtime_paths.rs")),
    (
        "process_containment.rs",
        include_str!("../../process_containment.rs"),
    ),
];

/// Extracts every `pub const NAME_ENV: &str = "VALUE";` declaration from a
/// contract source as a `(name, value)` pair.
///
/// Reading declarations out of the source keeps the check exhaustive. A
/// hand-maintained list would only cover the keys someone remembered to
/// register, which is the failure this check exists to prevent.
///
/// Only declarations starting a line are matched, so prose mentioning the
/// pattern inside a comment is not treated as a declaration.
///
/// Rustfmt may keep the string literal on the declaration line or move it
/// to the immediately following line. A `_ENV` declaration this cannot
/// parse yields an empty value, which fails the protection check rather
/// than being skipped, so an unparsed declaration fails closed.
fn declared_env_key_constants(source: &str) -> Vec<(&str, &str)> {
    let lines = source.lines().collect::<Vec<_>>();
    lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            let declaration = line.trim_start().strip_prefix("pub const ")?;
            let (name, rest) = declaration.split_once(':')?;
            let name = name.trim();
            if !name.ends_with("_ENV") {
                return None;
            }
            let (_, rest) = rest.split_once('=')?;
            let literal_source = if rest.trim_start().starts_with('"') {
                rest
            } else {
                lines.get(index + 1).copied().unwrap_or("")
            };
            let value = literal_source
                .trim_start()
                .strip_prefix('"')
                .and_then(|literal| literal.split_once('"'))
                .map_or("", |(value, _)| value);
            Some((name, value))
        })
        .collect()
}

#[test]
fn every_declared_env_key_is_classified_for_user_env_protection() {
    let mut unprotected = Vec::new();
    let mut total = 0;

    for (file, source) in CONTRACT_ENV_SOURCES {
        let declared = declared_env_key_constants(source);
        assert!(
            !declared.is_empty(),
            "{file} yielded no *_ENV declarations; the source scan is broken"
        );
        total += declared.len();

        for (name, value) in declared {
            if !is_runner_owned_env_key(value) {
                unprotected.push(format!("{file}: {name} = {value:?}"));
            }
        }
    }

    assert!(
        total >= 29,
        "expected at least 29 declared *_ENV keys across the contract sources, found {total}; \
             lower this bound only when a key is deliberately removed"
    );
    assert!(
        unprotected.is_empty(),
        "these bootstrap env keys are not protected from user env injection. Add each to \
             EXPLICIT_RUNNER_OWNED_ENV_KEYS or keep an OKOU_ prefix:\n  {}",
        unprotected.join("\n  ")
    );
}
