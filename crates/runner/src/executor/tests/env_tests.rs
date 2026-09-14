use std::collections::{BTreeMap, HashMap, HashSet};

use api_contracts::generated::constants::model_provider_env::placeholders as model_provider_placeholders;
use api_contracts::generated::types::runners::{
    runs::CodexRuntimeConfig, storage::ArtifactEntryMissingRootPolicy,
};
use guest_contracts::env::{RunArtifact, RunArtifactMissingRootPolicy};
use sandbox::SandboxId;
use serde_json::json;

use super::super::cli_framework::{
    EffectiveCliFramework, effective_cli_framework, normalized_cli_agent_type,
};
use super::super::env::{
    HostEnv, build_env_json_with_host_env, build_env_json_with_host_env_for_run,
    build_run_payload_for_run, build_user_env_json, is_runner_owned_env_key,
    validate_execution_context_before_sandbox, validate_model_provider_env_placeholders,
};
use super::super::guest_runtime_dir;
use super::support::{
    api_artifact, api_storage, build_env_for_test, build_env_for_test_result,
    build_env_for_test_with_host_env, context_with_env, minimal_context,
};
use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;
use crate::storage_manifest::StorageManifest;
use crate::types::{ExecutionContext, ResumeSession, SandboxReuseResult, WorkspaceReuseResult};

fn validate_context_for_test(ctx: &ExecutionContext) -> Result<(), String> {
    let sandbox_id = SandboxId::new_v4().to_string();
    validate_execution_context_before_sandbox(
        ctx,
        "http://localhost",
        &sandbox_id,
        SandboxReuseResult::Reused,
    )
    .map(drop)
}

fn codex_runtime_config_for_test(model_catalog: Option<serde_json::Value>) -> CodexRuntimeConfig {
    CodexRuntimeConfig {
        provider_id: "deepseek".into(),
        name: "DeepSeek".into(),
        base_url: "https://api.deepseek.com/".into(),
        env_key: "OPENAI_API_KEY".into(),
        http_headers: None,
        requires_openai_auth: None,
        wire_api: "responses".into(),
        supports_websockets: false,
        model_catalog,
    }
}

fn pi_launch_config_for_test(session_id: &str) -> serde_json::Value {
    json!({
        "schemaVersion": 2,
        "apiFirstTurn": {
            "schemaVersion": 1,
            "resourceSnapshotDigest": "a".repeat(64),
            "manifestUrl": "https://storage.example/manifest.json",
            "sessionUrl": "https://storage.example/session.jsonl",
            "deadlineAt": 2_000_000_000_000_u64,
            "baseSession": {
                "sessionId": session_id,
                "sha256": null
            },
            "sandboxEventSequenceStart": 1
        }
    })
}

fn pi_model_config_for_test() -> serde_json::Value {
    json!({
        "provider": "deepseek",
        "baseUrl": "https://api.deepseek.com/",
        "model": "deepseek-v4-flash",
        "apiKeyEnv": "OPENAI_API_KEY",
        "credentialSecretName": "DEEPSEEK_API_KEY"
    })
}

fn pi_model_config_v2_for_test(dialect: &str) -> serde_json::Value {
    if dialect == "openai-codex-responses" {
        return json!({
            "schemaVersion": 2,
            "dialect": dialect,
            "transport": "sse",
            "provider": "openai-codex",
            "baseUrl": "https://chatgpt.com/backend-api",
            "model": "gpt-5.6-terra",
            "thinkingLevel": "low",
            "credentialBindings": [
                {
                    "kind": "access-token",
                    "environment": "CHATGPT_ACCESS_TOKEN",
                    "secretName": "CHATGPT_ACCESS_TOKEN"
                },
                {
                    "kind": "account-id",
                    "environment": "CHATGPT_ACCOUNT_ID",
                    "secretName": "CHATGPT_ACCOUNT_ID"
                }
            ]
        });
    }
    json!({
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
            "secretName": "OPENAI_API_KEY"
        }]
    })
}

fn pi_context_for_test() -> ExecutionContext {
    let mut context = minimal_context();
    context.cli_agent_type = "pi".to_string();
    context.pi_session_id = Some("22222222-2222-4222-8222-222222222222".to_string());
    context.pi_launch_config = Some(pi_launch_config_for_test(
        "22222222-2222-4222-8222-222222222222",
    ));
    context.pi_model_config = Some(pi_model_config_for_test());
    context
}

fn native_pi_context_for_test(config: serde_json::Value) -> ExecutionContext {
    let mut context = pi_context_for_test();
    let environment = context.environment.get_or_insert_with(HashMap::new);
    for binding in config["credentialBindings"].as_array().unwrap() {
        environment.insert(
            binding["environment"].as_str().unwrap().into(),
            api_contracts::generated::constants::runners::PI_NATIVE_CREDENTIAL_PLACEHOLDER.into(),
        );
    }
    context.pi_model_config = Some(config);
    context
}

#[test]
fn effective_cli_framework_matches_guest_agent_fallback_semantics() {
    for (value, framework) in [
        ("claude-code", EffectiveCliFramework::ClaudeCode),
        ("codex", EffectiveCliFramework::Codex),
        ("pi", EffectiveCliFramework::Pi),
    ] {
        assert_eq!(normalized_cli_agent_type(value), value);
        assert_eq!(effective_cli_framework(value), framework);
    }

    assert_eq!(
        effective_cli_framework(""),
        EffectiveCliFramework::ClaudeCode
    );
    assert_eq!(normalized_cli_agent_type(""), "claude-code");

    assert_eq!(
        effective_cli_framework("custom-agent"),
        EffectiveCliFramework::ClaudeCode
    );
    assert_eq!(normalized_cli_agent_type("custom-agent"), "custom-agent");
}

#[test]
fn model_provider_env_placeholder_validation_accepts_env_without_protected_keys() {
    let ctx = context_with_env(HashMap::from([("PROJECT_ID".into(), "vm0".into())]));

    assert!(validate_model_provider_env_placeholders(&ctx).is_ok());
}

#[test]
fn model_provider_env_placeholder_validation_accepts_anthropic_api_key_placeholder() {
    let ctx = context_with_env(HashMap::from([(
        "ANTHROPIC_API_KEY".into(),
        model_provider_placeholders::ANTHROPIC_API_KEY.into(),
    )]));

    assert!(validate_model_provider_env_placeholders(&ctx).is_ok());
}

#[test]
fn model_provider_env_placeholder_validation_rejects_non_placeholder_values() {
    let protected_values = [
        ("ANTHROPIC_API_KEY", "sk-ant-api03-rejected-test-value"),
        ("ANTHROPIC_AUTH_TOKEN", "sk-rejected-anthropic-auth-token"),
        (
            "CLAUDE_CODE_OAUTH_TOKEN",
            "sk-ant-oat01-rejected-test-value",
        ),
        ("OPENAI_API_KEY", "sk-proj-rejected-test-value"),
        ("CHATGPT_ACCESS_TOKEN", "chatgpt-token-rejected-test-value"),
        ("CHATGPT_ACCOUNT_ID", "ws_rejected_test_account"),
        ("CHATGPT_REFRESH_TOKEN", "rt_rejected_test_refresh_token"),
        ("CHATGPT_ID_TOKEN", "hdr.rejected-test-id-token.sig"),
    ];

    for (key, value) in protected_values {
        let ctx = context_with_env(HashMap::from([(key.to_owned(), value.to_owned())]));

        let Err(error) = validate_context_for_test(&ctx) else {
            panic!("validation unexpectedly accepted {key}");
        };

        assert!(
            error.contains(key),
            "validation error did not identify {key}"
        );
        assert!(
            !error.contains(value),
            "validation error for {key} echoed its rejected value"
        );
    }
}

#[test]
fn model_provider_env_placeholder_validation_accepts_local_secret_env_key() {
    let secret = "sk-ant-api03-real-secret-value";
    let mut ctx = context_with_env(HashMap::from([("ANTHROPIC_API_KEY".into(), secret.into())]));
    ctx.local_secret_env_keys = Some(HashSet::from(["ANTHROPIC_API_KEY".into()]));

    assert!(validate_model_provider_env_placeholders(&ctx).is_ok());
}

#[test]
fn model_provider_env_placeholder_validation_rejects_unmarked_protected_key() {
    let anthropic_secret = "sk-ant-api03-real-secret-value";
    let openai_secret = "sk-proj-real-openai-secret";
    let mut ctx = context_with_env(HashMap::from([
        ("ANTHROPIC_API_KEY".into(), anthropic_secret.into()),
        ("OPENAI_API_KEY".into(), openai_secret.into()),
    ]));
    ctx.local_secret_env_keys = Some(HashSet::from(["ANTHROPIC_API_KEY".into()]));

    let error = validate_model_provider_env_placeholders(&ctx).unwrap_err();

    assert!(error.contains("OPENAI_API_KEY"));
    assert!(!error.contains("ANTHROPIC_API_KEY"));
    assert!(!error.contains(anthropic_secret));
    assert!(!error.contains(openai_secret));
}

#[test]
fn execution_context_validation_accepts_minimal_context() {
    let ctx = minimal_context();

    assert!(validate_context_for_test(&ctx).is_ok());
}

#[test]
fn execution_context_validation_rejects_invalid_user_env_key_before_sandbox() {
    let secret = "secret-value";
    let ctx = context_with_env(HashMap::from([("BAD-KEY".into(), secret.into())]));

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("invalid env key"));
    assert!(error.contains("BAD-KEY"));
    assert!(!error.contains(secret));
}

#[test]
fn execution_context_validation_rejects_user_env_nul_value_before_sandbox() {
    let secret = "secret\0value";
    let ctx = context_with_env(HashMap::from([("CUSTOM_ENV".into(), secret.into())]));

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("NUL byte"));
    assert!(error.contains("CUSTOM_ENV"));
    assert!(!error.contains(secret));
}

#[test]
fn execution_context_validation_rejects_user_timezone_nul_before_sandbox() {
    let secret = "Asia\0Shanghai";
    let mut ctx = minimal_context();
    ctx.user_timezone = Some(secret.into());

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("NUL byte"));
    assert!(error.contains("TZ"));
    assert!(!error.contains(secret));
}

#[test]
fn execution_context_validation_ignores_runner_owned_user_env_before_sandbox() {
    let mut ctx = minimal_context();
    ctx.environment = Some(HashMap::from([
        ("OKOU_FUTURE_PLATFORM_KEY".into(), "ignored\0secret".into()),
        (
            guest_contracts::env::RUN_ID_ENV.into(),
            "ignored\0run-identity".into(),
        ),
        (
            guest_contracts::env::PI_SESSION_ID_ENV.into(),
            "ignored\0pi-session".into(),
        ),
        (
            guest_contracts::env::PI_LAUNCH_CONFIG_ENV.into(),
            "ignored\0pi-prompt".into(),
        ),
        (
            guest_contracts::env::PI_MODEL_CONFIG_ENV.into(),
            "ignored\0pi-model".into(),
        ),
        ("CUSTOM_ENV".into(), "kept".into()),
    ]));

    assert!(validate_context_for_test(&ctx).is_ok());
    let user_env = build_user_env_json(&ctx);
    assert_eq!(user_env.get("CUSTOM_ENV").unwrap(), "kept");
    assert!(!user_env.contains_key("OKOU_FUTURE_PLATFORM_KEY"));
    assert!(!user_env.contains_key(guest_contracts::env::RUN_ID_ENV));
    assert!(!user_env.contains_key(guest_contracts::env::PI_SESSION_ID_ENV));
    assert!(!user_env.contains_key(guest_contracts::env::PI_LAUNCH_CONFIG_ENV));
    assert!(!user_env.contains_key(guest_contracts::env::PI_MODEL_CONFIG_ENV));
}

#[test]
fn execution_context_validation_checks_arbitrary_user_env_before_sandbox() {
    let secret = "ordinary\0user-secret";
    let ctx = context_with_env(HashMap::from([("CUSTOM_PROMPT".into(), secret.into())]));

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("user environment"));
    assert!(error.contains("NUL byte"));
    assert!(error.contains("CUSTOM_PROMPT"));
    assert!(!error.contains(secret));
}

#[test]
fn execution_context_validation_rejects_prompt_nul_before_sandbox() {
    let secret = "before\0after";
    let mut ctx = minimal_context();
    ctx.prompt = secret.into();

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("run payload"));
    assert!(error.contains("NUL byte"));
    assert!(error.contains("OKOU_PROMPT"));
    assert!(!error.contains(secret));
}

#[test]
fn execution_context_validation_rejects_append_system_prompt_nul_before_sandbox() {
    let secret = "system\0prompt";
    let mut ctx = minimal_context();
    ctx.append_system_prompt = Some(secret.into());

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("run payload"));
    assert!(error.contains("NUL byte"));
    assert!(error.contains("OKOU_APPEND_SYSTEM_PROMPT"));
    assert!(!error.contains(secret));
}

#[test]
fn execution_context_validation_rejects_claude_settings_nul_before_sandbox() {
    let secret = "{\"hooks\":\"bad\0value\"}";
    let mut ctx = minimal_context();
    ctx.settings = Some(secret.into());

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("run payload"));
    assert!(error.contains("NUL byte"));
    assert!(error.contains("OKOU_SETTINGS"));
    assert!(!error.contains(secret));
}

#[test]
fn execution_context_validation_ignores_codex_settings_nul_before_sandbox() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.settings = Some("{\"hooks\":\"bad\0value\"}".into());

    assert!(validate_context_for_test(&ctx).is_ok());
    assert!(build_run_payload_for_run(&ctx).unwrap().settings.is_empty());
}

#[test]
fn execution_context_validation_accepts_raw_secret_value_nul_before_sandbox() {
    let mut ctx = minimal_context();
    ctx.secret_values = Some(vec!["secret\0value".into()]);

    assert!(validate_context_for_test(&ctx).is_ok());
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(!payload.secret_values.contains('\0'));
}

#[test]
fn execution_context_validation_rejects_tool_nul_before_sandbox() {
    let mut ctx = minimal_context();
    ctx.tools = Some(vec!["Bash\0Read".into()]);

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("OKOU_TOOLS"));
    assert!(error.contains("NUL"));
}

#[test]
fn execution_context_validation_rejects_invalid_codex_resume_before_sandbox() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.resume_session = Some(ResumeSession::inline("not-a-thread-id".into(), "{}".into()));

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("invalid codex session_id"));
}

#[test]
fn model_provider_env_placeholder_validation_accepts_empty_anthropic_api_key_with_auth_token() {
    let ctx = context_with_env(HashMap::from([
        ("ANTHROPIC_API_KEY".into(), String::new()),
        (
            "ANTHROPIC_AUTH_TOKEN".into(),
            model_provider_placeholders::ANTHROPIC_AUTH_TOKEN.into(),
        ),
    ]));

    assert!(validate_model_provider_env_placeholders(&ctx).is_ok());
}

#[test]
fn model_provider_env_placeholder_validation_accepts_claude_oauth_placeholder() {
    let ctx = context_with_env(HashMap::from([(
        "CLAUDE_CODE_OAUTH_TOKEN".into(),
        model_provider_placeholders::CLAUDE_CODE_OAUTH_TOKEN.into(),
    )]));

    assert!(validate_model_provider_env_placeholders(&ctx).is_ok());
}

#[test]
fn model_provider_env_placeholder_validation_accepts_openai_api_key_placeholder() {
    let ctx = context_with_env(HashMap::from([(
        "OPENAI_API_KEY".into(),
        model_provider_placeholders::OPENAI_API_KEY.into(),
    )]));

    assert!(validate_model_provider_env_placeholders(&ctx).is_ok());
}

#[test]
fn model_provider_env_placeholder_validation_accepts_codex_oauth_placeholders() {
    let ctx = context_with_env(HashMap::from([
        (
            "CHATGPT_ACCESS_TOKEN".into(),
            model_provider_placeholders::CHATGPT_ACCESS_TOKEN.into(),
        ),
        (
            "CHATGPT_ACCOUNT_ID".into(),
            model_provider_placeholders::CHATGPT_ACCOUNT_ID.into(),
        ),
        (
            "CHATGPT_REFRESH_TOKEN".into(),
            model_provider_placeholders::CHATGPT_REFRESH_TOKEN.into(),
        ),
    ]));

    assert!(validate_model_provider_env_placeholders(&ctx).is_ok());
}

#[test]
fn build_env_json_required_keys() {
    let ctx = minimal_context();
    let sandbox_id = "00000000-0000-4000-8000-000000000abc";
    let env = build_env_json_with_host_env_for_run(
        &ctx,
        "https://api.example.com",
        sandbox_id,
        SandboxReuseResult::Reused,
        WorkspaceReuseResult::SandboxReused,
        &HostEnv::default(),
    )
    .expect("test env should build");

    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_API_URL_ENV)
            .unwrap(),
        "https://api.example.com"
    );
    assert_eq!(
        env.get(guest_contracts::env::RUN_ID_ENV).unwrap(),
        &RunId::nil().to_string()
    );
    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_API_TOKEN_ENV)
            .unwrap(),
        "tok"
    );
    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV)
            .unwrap(),
        "7200"
    );
    assert_eq!(
        env.get(guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV)
            .unwrap(),
        &guest_runtime_dir(ctx.run_id).unwrap()
    );
    // Guest-agent needs these to post /complete with full metadata when
    // checkpoint lands before sandbox teardown.
    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_SANDBOX_ID_ENV)
            .map(String::as_str),
        Some(sandbox_id)
    );
    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV)
            .map(String::as_str),
        Some("reused")
    );
    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_WORKSPACE_REUSE_RESULT_ENV)
            .map(String::as_str),
        Some("sandboxReused")
    );
    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_API_START_TIME_ENV)
            .unwrap(),
        ""
    );
}

#[test]
fn build_env_json_sandbox_reuse_result_wire_format() {
    let ctx = minimal_context();
    let sid = SandboxId::new_v4().to_string();
    for (variant, expected) in [
        (SandboxReuseResult::Reused, "reused"),
        (SandboxReuseResult::NoReuseKey, "noReuseKey"),
        (SandboxReuseResult::PoolMiss, "poolMiss"),
        (SandboxReuseResult::ProfileMismatch, "profileMismatch"),
        (
            SandboxReuseResult::DeviceLimitMismatch,
            "deviceLimitMismatch",
        ),
        (SandboxReuseResult::UnparkFailed, "unparkFailed"),
    ] {
        let env = build_env_json_with_host_env(
            &ctx,
            "http://localhost",
            &sid,
            variant,
            &HostEnv::default(),
        )
        .expect("test env should build");
        assert_eq!(
            env.get(guest_contracts::env::CANONICAL_SANDBOX_ID_ENV)
                .map(String::as_str),
            Some(sid.as_str())
        );
        assert_eq!(
            env.get(guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV)
                .map(String::as_str),
            Some(expected)
        );
        assert!(
            !env.contains_key(guest_contracts::env::CANONICAL_WORKSPACE_REUSE_RESULT_ENV),
            "no-workspace builder emitted canonical workspace reuse metadata"
        );
    }
}

#[test]
fn build_env_json_empty_cli_agent_type_defaults_to_claude_code() {
    let ctx = minimal_context();
    let env = build_env_for_test(&ctx, "http://localhost");
    assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "claude-code");
}

#[test]
fn build_env_json_custom_cli_agent_type() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "custom-agent".into();
    let env = build_env_for_test(&ctx, "http://localhost");
    assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "custom-agent");
}

#[test]
fn build_env_json_claude_code_gets_only_claude_framework_env() {
    let mut ctx = minimal_context();
    ctx.disallowed_tools = Some(vec!["CronCreate".into(), "CronDelete".into()]);
    ctx.tools = Some(vec!["Bash".into(), "Edit".into()]);
    ctx.settings = Some(r#"{"hooks":{}}"#.into());

    let env = build_env_for_test_with_host_env(
        &ctx,
        "http://localhost",
        &HostEnv {
            use_mock_claude: Some("true".into()),
            use_mock_codex: Some("1".into()),
            ..HostEnv::default()
        },
    );

    assert_eq!(env.get("USE_MOCK_CLAUDE").unwrap(), "true");
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert_eq!(payload.disallowed_tools, "CronCreate,CronDelete");
    assert_eq!(payload.tools, "Bash,Edit");
    assert_eq!(payload.settings, r#"{"hooks":{}}"#);
    assert!(!env.contains_key("USE_MOCK_CODEX"));
}

#[test]
fn build_env_json_codex_gets_only_codex_framework_env() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();

    let env = build_env_for_test_with_host_env(
        &ctx,
        "http://localhost",
        &HostEnv {
            use_mock_claude: Some("true".into()),
            use_mock_codex: Some("1".into()),
            ..HostEnv::default()
        },
    );

    assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "codex");
    assert_eq!(env.get("USE_MOCK_CODEX").unwrap(), "1");
    assert!(!env.contains_key("USE_MOCK_CLAUDE"));
}

#[test]
fn build_env_json_unknown_framework_preserves_claude_compatible_env() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "custom-agent".into();
    ctx.disallowed_tools = Some(vec!["CronCreate".into()]);
    ctx.tools = Some(vec!["Bash".into()]);
    ctx.settings = Some(r#"{"hooks":{}}"#.into());

    let env = build_env_for_test_with_host_env(
        &ctx,
        "http://localhost",
        &HostEnv {
            use_mock_claude: Some("true".into()),
            use_mock_codex: Some("1".into()),
            ..HostEnv::default()
        },
    );

    assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "custom-agent");
    assert_eq!(env.get("USE_MOCK_CLAUDE").unwrap(), "true");
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert_eq!(payload.disallowed_tools, "CronCreate");
    assert_eq!(payload.tools, "Bash");
    assert_eq!(payload.settings, r#"{"hooks":{}}"#);
    assert!(!env.contains_key("USE_MOCK_CODEX"));
}

#[test]
fn platform_environment_claim_filters_reserved_keys_and_applies_trusted_last() {
    let mut ctx = minimal_context();
    ctx.environment = Some(HashMap::from([
        ("CUSTOM_ENV".into(), "kept".into()),
        ("DUPLICATE".into(), "untrusted".into()),
        ("OKOU_TOKEN".into(), "untrusted-token".into()),
        ("OKOU_FUTURE_PLATFORM_KEY".into(), "untrusted".into()),
        ("CUSTOM_USER_KEY".into(), "untrusted".into()),
        (
            guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV.into(),
            "untrusted-bypass".into(),
        ),
    ]));
    ctx.platform_environment = HashMap::from([
        ("DUPLICATE".into(), "trusted".into()),
        ("OKOU_TOKEN".into(), "trusted-token".into()),
        ("OKOU_PLATFORM_ONLY".into(), "trusted-platform".into()),
        (
            guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV.into(),
            "trusted-bypass".into(),
        ),
    ]);

    assert_eq!(
        build_user_env_json(&ctx),
        HashMap::from([
            ("CUSTOM_ENV".into(), "kept".into()),
            ("DUPLICATE".into(), "trusted".into()),
            ("CUSTOM_USER_KEY".into(), "untrusted".into()),
            ("OKOU_TOKEN".into(), "trusted-token".into()),
            ("OKOU_PLATFORM_ONLY".into(), "trusted-platform".into()),
            (
                guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV.into(),
                "trusted-bypass".into(),
            ),
        ])
    );
}

#[test]
fn emitted_bootstrap_env_keys_classify_as_runner_owned() {
    let mut ctx = minimal_context();
    ctx.append_system_prompt = Some("Use terse answers.".into());
    ctx.resume_session = Some(ResumeSession::inline("sess-123".into(), "{}".into()));
    ctx.disallowed_tools = Some(vec!["CronCreate".into()]);
    ctx.tools = Some(vec!["Bash".into()]);
    ctx.settings = Some(r#"{"hooks":{}}"#.into());
    ctx.feature_flags = Some(HashMap::from([("runnerEnvKeyTest".into(), true)]));
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![],
        artifacts: vec![api_artifact(
            "artifact",
            "/workspace",
            "storage-id",
            "version-id",
            "https://example.com/artifact.tar.gz",
        )],
    });

    let env = build_env_for_test_with_host_env(
        &ctx,
        "http://localhost",
        &HostEnv {
            vercel_automation_bypass_secret: Some("bypass".into()),
            use_mock_claude: Some("true".into()),
            ..HostEnv::default()
        },
    );

    for key in env.keys() {
        assert!(
            is_runner_owned_env_key(key),
            "emitted bootstrap key {key} should be runner-owned"
        );
    }
    for key in [
        guest_contracts::env::RUN_ID_ENV,
        guest_contracts::env::PI_SESSION_ID_ENV,
        guest_contracts::env::PI_LAUNCH_CONFIG_ENV,
        guest_contracts::env::PI_MODEL_CONFIG_ENV,
        guest_contracts::env::CLI_AGENT_TYPE_ENV,
        guest_contracts::env::USE_MOCK_CLAUDE_ENV,
        guest_contracts::env::USE_MOCK_CODEX_ENV,
        guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV,
    ] {
        assert!(
            is_runner_owned_env_key(key),
            "explicit runner key {key} should be runner-owned"
        );
    }
    assert!(is_runner_owned_env_key("OKOU_TOKEN"));
    assert!(is_runner_owned_env_key("OKOU_UNRELATED"));
    assert!(!is_runner_owned_env_key("CUSTOM_ENV"));
}

#[test]
fn build_env_json_does_not_author_guest_agent_tuning_from_user_environment() {
    let canonical_keys = [
        guest_contracts::env::CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
        guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
        guest_contracts::env::CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
        guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
    ];
    let canonical_environment = canonical_keys
        .map(|key| (key.into(), "hostile-canonical-must-not-author".into()))
        .into_iter()
        .collect();

    for environment in [None, Some(canonical_environment)] {
        let mut ctx = minimal_context();
        ctx.environment = environment;
        let env = build_env_for_test(&ctx, "http://localhost");

        for key in canonical_keys {
            assert!(!env.contains_key(key));
        }
    }
}

#[test]
fn build_env_json_codex_keeps_shared_runner_env() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.append_system_prompt = Some("Use terse answers.".into());
    ctx.resume_session = Some(ResumeSession::inline(
        "019E9154C30470F0ADDE36EFB1BE1701".into(),
        "{}".into(),
    ));

    let env = build_env_for_test(&ctx, "http://localhost");
    let payload = build_run_payload_for_run(&ctx).unwrap();

    assert_eq!(payload.append_system_prompt, "Use terse answers.");
    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV)
            .unwrap(),
        "019e9154-c304-70f0-adde-36efb1be1701"
    );
}

#[test]
fn build_env_json_rejects_invalid_codex_resume_session_id() {
    for session_id in ["abc", "urn:uuid:019e9154-c304-70f0-adde-36efb1be1701"] {
        let mut ctx = minimal_context();
        ctx.cli_agent_type = "codex".into();
        ctx.resume_session = Some(ResumeSession::inline(session_id.into(), "{}".into()));

        let error = build_env_for_test_result(&ctx, "http://localhost").unwrap_err();
        let message = error.to_string();

        assert!(message.contains("invalid codex session_id"), "got: {error}");
        assert!(
            !message.contains(session_id),
            "invalid codex error must not echo raw session id: {message}"
        );
    }
}

#[test]
fn build_env_json_with_single_artifact() {
    let mut ctx = minimal_context();
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![api_storage(
            "data",
            "/data",
            "v1",
            "https://example.com/data.tar.gz",
        )],
        artifacts: vec![api_artifact(
            "my-vol",
            "/artifacts",
            "sid-1",
            "v1",
            "https://example.com/artifacts.tar.gz",
        )],
    });

    let payload = build_run_payload_for_run(&ctx).unwrap();
    let raw = &payload.artifacts;
    let parsed: Vec<RunArtifact> = serde_json::from_str(raw).unwrap();
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].name, "my-vol");
    assert_eq!(parsed[0].mount_path, "/artifacts");
    assert_eq!(parsed[0].storage_id, "sid-1");
    assert_eq!(parsed[0].version_id, "v1");
    assert_eq!(parsed[0].missing_root_policy, None);
}

#[test]
fn build_env_json_with_artifact_missing_root_policy() {
    let mut ctx = minimal_context();
    let mut artifact = api_artifact(
        "memory",
        "/home/user/.claude/projects/-home-user-workspace/memory",
        "sid-memory",
        "v1",
        "https://example.com/memory.tar.gz",
    );
    artifact.missing_root_policy = Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion);
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![],
        artifacts: vec![artifact],
    });

    let payload = build_run_payload_for_run(&ctx).unwrap();
    let raw = &payload.artifacts;
    let parsed: Vec<RunArtifact> = serde_json::from_str(raw).unwrap();

    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].name, "memory");
    assert_eq!(
        parsed[0].missing_root_policy,
        Some(RunArtifactMissingRootPolicy::PreserveParentVersion)
    );
}

#[test]
fn build_env_json_with_two_artifacts() {
    let mut ctx = minimal_context();
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![],
        artifacts: vec![
            api_artifact(
                "art-a",
                "/workspace",
                "sid-a",
                "v1",
                "https://example.com/art-a.tar.gz",
            ),
            api_artifact(
                "art-b",
                "/data",
                "sid-b",
                "v2",
                "https://example.com/art-b.tar.gz",
            ),
        ],
    });

    let payload = build_run_payload_for_run(&ctx).unwrap();
    let raw = &payload.artifacts;
    let parsed: Vec<RunArtifact> = serde_json::from_str(raw).unwrap();
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].name, "art-a");
    assert_eq!(parsed[0].mount_path, "/workspace");
    assert_eq!(parsed[0].storage_id, "sid-a");
    assert_eq!(parsed[1].name, "art-b");
    assert_eq!(parsed[1].mount_path, "/data");
    assert_eq!(parsed[1].storage_id, "sid-b");
}

#[test]
fn build_env_json_empty_artifacts_emits_no_env_var() {
    let mut ctx = minimal_context();
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![],
        artifacts: vec![],
    });

    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(payload.artifacts.is_empty());
}

#[test]
fn build_env_json_with_secrets() {
    let mut ctx = minimal_context();
    // Raw delimiters in secret values must survive base64 transport.
    ctx.secret_values = Some(vec!["secret1".into(), "secret,with\nnewline".into()]);

    let payload = build_run_payload_for_run(&ctx).unwrap();
    let val = &payload.secret_values;

    use base64::Engine as _;
    let parts: Vec<&str> = val.split(',').collect();
    assert_eq!(parts.len(), 3);
    let decoded: Vec<String> = parts
        .iter()
        .map(|part| {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(part)
                .unwrap();
            String::from_utf8(bytes).unwrap()
        })
        .collect();
    assert_eq!(
        decoded,
        vec![
            "tok".to_string(),
            "secret1".to_string(),
            "secret,with\nnewline".to_string(),
        ]
    );
}

#[test]
fn build_env_json_with_resume_session() {
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession::inline("sess-123".into(), "{}".into()));

    let env = build_env_for_test(&ctx, "http://localhost");
    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV)
            .unwrap(),
        "sess-123"
    );
}

#[test]
fn build_env_json_user_vars_cannot_override_system() {
    let mut ctx = minimal_context();
    // vars are expanded into environment at compose time, so test via environment
    ctx.environment = Some(HashMap::from([
        ("CUSTOM_PROMPT".into(), "overridden".into()),
        ("CUSTOM".into(), "value".into()),
    ]));

    let env = build_env_for_test(&ctx, "http://localhost");
    let payload = build_run_payload_for_run(&ctx).unwrap();
    let user_env = build_user_env_json(&ctx);
    // The private run payload remains authoritative while the same diagnostic
    // label remains visible as an ordinary user environment key.
    assert!(!env.contains_key("CUSTOM_PROMPT"));
    assert_eq!(payload.prompt, "test prompt");
    assert!(!env.contains_key("CUSTOM"));
    assert_eq!(user_env.get("CUSTOM").unwrap(), "value");
    assert_eq!(user_env.get("CUSTOM_PROMPT").unwrap(), "overridden");
}

#[test]
fn build_env_json_with_environment() {
    let mut ctx = minimal_context();
    ctx.environment = Some(HashMap::from([
        ("MY_VAR".into(), "123".into()),
        ("OTHER".into(), "abc".into()),
    ]));

    let env = build_env_for_test(&ctx, "http://localhost");
    let user_env = build_user_env_json(&ctx);
    assert!(!env.contains_key("MY_VAR"));
    assert!(!env.contains_key("OTHER"));
    assert_eq!(user_env.get("MY_VAR").unwrap(), "123");
    assert_eq!(user_env.get("OTHER").unwrap(), "abc");
}

#[test]
fn build_env_json_with_api_start_time() {
    let mut ctx = minimal_context();
    ctx.api_start_time = Some(1_700_000_000_500);

    let env = build_env_for_test(&ctx, "http://localhost");
    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_API_START_TIME_ENV)
            .unwrap(),
        "1700000000500"
    );
}

#[test]
fn build_env_json_empty_secrets_still_has_sandbox_token() {
    let mut ctx = minimal_context();
    ctx.secret_values = Some(vec![]);

    // The private run payload always includes the sandbox token for masking.
    let payload = build_run_payload_for_run(&ctx).unwrap();
    let val = &payload.secret_values;
    use base64::Engine as _;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(val)
        .unwrap();
    assert_eq!(decoded, b"tok");
}

#[test]
fn build_env_json_with_append_system_prompt() {
    let mut ctx = minimal_context();
    ctx.append_system_prompt = Some("Your name is Aria.".into());
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert_eq!(payload.append_system_prompt, "Your name is Aria.");
}

#[test]
fn build_run_payload_for_run_rejects_prompt_nul() {
    let secret = "before\0after";
    let mut ctx = minimal_context();
    ctx.prompt = secret.into();

    let error = match build_run_payload_for_run(&ctx) {
        Err(RunnerError::Internal(error)) => error,
        other => panic!("expected internal error, got {other:?}"),
    };

    assert!(error.contains("run payload"));
    assert!(error.contains("NUL byte"));
    assert!(error.contains("OKOU_PROMPT"));
    assert!(!error.contains(secret));
}

#[test]
fn build_run_payload_for_run_serializes_codex_runtime_config() {
    let mut ctx = minimal_context();
    let mut config = codex_runtime_config_for_test(Some(json!({
        "models": [{ "slug": "deepseek-v4-flash" }],
    })));
    config.http_headers = Some(BTreeMap::from([(
        "x-api-key".to_string(),
        "__VM0_OPENAI_API_KEY_PLACEHOLDER__".to_string(),
    )]));
    config.requires_openai_auth = Some(false);
    ctx.codex_runtime_config = Some(config);

    let payload = build_run_payload_for_run(&ctx).unwrap();
    let value: serde_json::Value = serde_json::from_str(&payload.codex_runtime_config).unwrap();

    assert_eq!(value["providerId"], "deepseek");
    assert_eq!(value["baseUrl"], "https://api.deepseek.com/");
    assert_eq!(value["envKey"], "OPENAI_API_KEY");
    assert_eq!(
        value["httpHeaders"]["x-api-key"],
        "__VM0_OPENAI_API_KEY_PLACEHOLDER__"
    );
    assert_eq!(value["requiresOpenaiAuth"], false);
    assert_eq!(value["wireApi"], "responses");
    assert_eq!(value["supportsWebsockets"], false);
    assert_eq!(
        value["modelCatalog"]["models"][0]["slug"],
        "deepseek-v4-flash"
    );
}

#[test]
fn build_run_payload_for_run_omits_absent_codex_runtime_config() {
    let ctx = minimal_context();

    let payload = build_run_payload_for_run(&ctx).unwrap();

    assert!(payload.codex_runtime_config.is_empty());
}

#[test]
fn non_pi_execution_contexts_do_not_require_pi_resources() {
    for framework in ["claude-code", "codex"] {
        let mut ctx = minimal_context();
        ctx.cli_agent_type = framework.to_string();
        ctx.pi_session_id = None;
        ctx.pi_launch_config = None;
        ctx.pi_model_config = None;

        assert!(
            validate_context_for_test(&ctx).is_ok(),
            "{framework} context should not require Pi resources"
        );
        let payload = build_run_payload_for_run(&ctx).unwrap();
        assert!(payload.pi_session_id.is_empty());
        assert!(payload.pi_launch_config.is_empty());
        assert!(payload.pi_model_config.is_empty());
    }
}

#[test]
fn pi_execution_context_preserves_additive_fields_in_run_payload() {
    let mut ctx = pi_context_for_test();
    ctx.pi_launch_config.as_mut().unwrap()["futureLaunchField"] = json!("launch-root");
    ctx.pi_launch_config.as_mut().unwrap()["apiFirstTurn"]["futureFirstTurnField"] =
        json!("first-turn");
    ctx.pi_launch_config.as_mut().unwrap()["apiFirstTurn"]["sandboxEventSequenceStart"] = json!(4);
    ctx.pi_model_config.as_mut().unwrap()["catalogModel"] = json!("deepseek-v4-flash");
    ctx.pi_model_config.as_mut().unwrap()["credentialHeader"] = json!({
        "name": "X-Api-Key",
        "valueTemplate": "Bearer {{secret}}"
    });
    ctx.pi_model_config.as_mut().unwrap()["futureModelField"] = json!("model-root");
    let sandbox_id = SandboxId::new_v4().to_string();
    let payload = validate_execution_context_before_sandbox(
        &ctx,
        "http://localhost",
        &sandbox_id,
        SandboxReuseResult::Reused,
    )
    .unwrap()
    .into_run_payload(&ctx)
    .unwrap();

    assert_eq!(
        payload.pi_session_id,
        "22222222-2222-4222-8222-222222222222"
    );
    let launch: serde_json::Value = serde_json::from_str(&payload.pi_launch_config).unwrap();
    assert_eq!(launch["schemaVersion"], 2);
    assert_eq!(launch["futureLaunchField"], "launch-root");
    assert_eq!(launch["apiFirstTurn"]["futureFirstTurnField"], "first-turn");
    assert_eq!(launch["apiFirstTurn"]["sandboxEventSequenceStart"], 4);
    let model: serde_json::Value = serde_json::from_str(&payload.pi_model_config).unwrap();
    assert_eq!(model["provider"], "deepseek");
    assert_eq!(model["apiKeyEnv"], "OPENAI_API_KEY");
    assert_eq!(model["credentialSecretName"], "DEEPSEEK_API_KEY");
    assert_eq!(model["catalogModel"], "deepseek-v4-flash");
    assert_eq!(model["credentialHeader"]["name"], "X-Api-Key");
    assert_eq!(
        model["credentialHeader"]["valueTemplate"],
        "Bearer {{secret}}"
    );
    assert_eq!(model["futureModelField"], "model-root");
}

#[test]
fn pi_maintenance_candidates_use_only_the_private_run_payload() {
    let mut context = pi_context_for_test();
    let candidate_secret = "PRIVATE_MAINTENANCE_CANDIDATE_31891";
    context.pi_launch_config.as_mut().unwrap()["maintenance"] = json!({
        "schemaVersion": 1,
        "memoryStorageId": "1d09f0c9-a5c6-4f21-9664-d80a3ca3ae63",
        "claimedRevision": 7,
        "claimedBaseVersionId": "b".repeat(64),
        "leaseToken": "44754115-d375-4c46-aea7-a55bd1b61ec7",
        "selectionDigest": "c".repeat(64),
        "selected": [{
            "piSessionId": "11111111-1111-4111-8111-111111111111",
            "sourceRunId": "22222222-2222-4222-8222-222222222222",
            "sourceHistoryHash": "d".repeat(64),
            "sourceCompletedAt": "2026-09-05T02:00:00.000Z",
            "rawMemory": candidate_secret,
            "rolloutSummary": "private rollout evidence",
            "rolloutSlug": null
        }]
    });
    let sandbox_id = SandboxId::new_v4().to_string();
    let payload = validate_execution_context_before_sandbox(
        &context,
        "http://localhost",
        &sandbox_id,
        SandboxReuseResult::Reused,
    )
    .unwrap()
    .into_run_payload(&context)
    .unwrap();

    let launch: serde_json::Value = serde_json::from_str(&payload.pi_launch_config).unwrap();
    assert_eq!(
        launch["maintenance"]["selected"][0]["rawMemory"],
        candidate_secret
    );
    assert!(
        !serde_json::to_string(&build_user_env_json(&context))
            .unwrap()
            .contains(candidate_secret)
    );
}

#[test]
fn pi_execution_context_rejects_missing_handoff_fields_before_sandbox() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "pi".to_string();
    ctx.pi_session_id = Some("22222222-2222-4222-8222-222222222222".to_string());
    ctx.pi_launch_config = Some(json!({ "schemaVersion": 2 }));
    ctx.pi_model_config = Some(pi_model_config_for_test());

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("apiFirstTurn"));
}

#[test]
fn pi_execution_context_rejects_mismatched_h0_before_sandbox() {
    let mut ctx = pi_context_for_test();
    ctx.pi_launch_config = Some(pi_launch_config_for_test(
        "33333333-3333-4333-8333-333333333333",
    ));

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("H0 session id"));
}

#[test]
fn pi_execution_context_rejects_missing_required_base_hash_before_sandbox() {
    let mut context = pi_context_for_test();
    context
        .pi_launch_config
        .as_mut()
        .unwrap()
        .pointer_mut("/apiFirstTurn/baseSession")
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("sha256");

    let error = validate_context_for_test(&context).unwrap_err();

    assert!(error.contains("H0 sha256 must be present"));
}

#[test]
fn pi_execution_context_rejects_invalid_launch_fields_before_sandbox() {
    let cases = [
        ("/schemaVersion", json!(3), "schemaVersion must be 2"),
        (
            "/apiFirstTurn/schemaVersion",
            json!(2),
            "schemaVersion must be 1",
        ),
        (
            "/apiFirstTurn/resourceSnapshotDigest",
            json!("not-a-digest"),
            "resource snapshot digest",
        ),
        (
            "/apiFirstTurn/manifestUrl",
            json!("ftp://storage.example/manifest.json"),
            "manifestUrl must use HTTP or HTTPS",
        ),
        (
            "/apiFirstTurn/sessionUrl",
            json!("not a URL"),
            "sessionUrl is invalid",
        ),
        (
            "/apiFirstTurn/deadlineAt",
            json!(-1),
            "deadlineAt must be positive",
        ),
        (
            "/apiFirstTurn/sandboxEventSequenceStart",
            json!(0),
            "event sequence start must be between 1 and 2147483647",
        ),
        (
            "/apiFirstTurn/sandboxEventSequenceStart",
            json!(i64::from(i32::MAX) + 1),
            "event sequence start must be between 1 and 2147483647",
        ),
        (
            "/apiFirstTurn/baseSession/sha256",
            json!("not-a-digest"),
            "H0 sha256",
        ),
    ];

    for (pointer, value, expected) in cases {
        let mut context = pi_context_for_test();
        *context
            .pi_launch_config
            .as_mut()
            .unwrap()
            .pointer_mut(pointer)
            .unwrap() = value;

        let error = validate_context_for_test(&context).unwrap_err();

        assert!(
            error.contains(expected),
            "{pointer} produced unexpected error: {error}"
        );
    }
}

#[test]
fn pi_execution_context_rejects_invalid_model_fields_before_sandbox() {
    let cases = [
        (
            "/provider",
            json!("future-provider"),
            "Pi legacy model config is invalid",
        ),
        (
            "/apiKeyEnv",
            json!("FUTURE_API_KEY"),
            "Pi legacy model config is invalid",
        ),
        ("/baseUrl", json!("not a URL"), "baseUrl is invalid"),
        ("/model", json!(""), "model must not be empty"),
        (
            "/credentialSecretName",
            json!("lowercase-secret"),
            "credentialSecretName is invalid",
        ),
    ];

    for (pointer, value, expected) in cases {
        let mut context = pi_context_for_test();
        *context
            .pi_model_config
            .as_mut()
            .unwrap()
            .pointer_mut(pointer)
            .unwrap() = value;

        let error = validate_context_for_test(&context).unwrap_err();

        assert!(
            error.contains(expected),
            "{pointer} produced unexpected error: {error}"
        );
    }

    let mut context = pi_context_for_test();
    context.pi_model_config.as_mut().unwrap()["serviceTier"] = json!("fast");
    let error = validate_context_for_test(&context).unwrap_err();
    assert!(
        error.contains("Pi legacy model config is invalid"),
        "serviceTier produced unexpected error: {error}"
    );
}

#[test]
fn pi_execution_context_rejects_invalid_legacy_shared_model_fields_before_sandbox() {
    let invalid_headers = [
        (
            "non-object",
            json!(null),
            "Pi model config credentialHeader",
        ),
        (
            "missing name",
            json!({ "valueTemplate": "Bearer {{secret}}" }),
            "Pi legacy model config is invalid",
        ),
        (
            "missing value template",
            json!({ "name": "X-Api-Key" }),
            "Pi legacy model config is invalid",
        ),
        (
            "invalid name",
            json!({
                "name": "1-Api-Key",
                "valueTemplate": "Bearer {{secret}}"
            }),
            "Pi model config credentialHeader",
        ),
        (
            "oversized name",
            json!({
                "name": "A".repeat(129),
                "valueTemplate": "Bearer {{secret}}"
            }),
            "Pi model config credentialHeader",
        ),
        (
            "missing placeholder",
            json!({ "name": "X-Api-Key", "valueTemplate": "Bearer token" }),
            "Pi model config credentialHeader",
        ),
        (
            "repeated placeholder",
            json!({
                "name": "X-Api-Key",
                "valueTemplate": "{{secret}} {{secret}}"
            }),
            "Pi model config credentialHeader",
        ),
        (
            "other template reference",
            json!({
                "name": "X-Api-Key",
                "valueTemplate": "{{secret}} {{future}}"
            }),
            "Pi model config credentialHeader",
        ),
        (
            "carriage return",
            json!({
                "name": "X-Api-Key",
                "valueTemplate": "Bearer {{secret}}\rSuffix"
            }),
            "Pi model config credentialHeader",
        ),
        (
            "line feed",
            json!({
                "name": "X-Api-Key",
                "valueTemplate": "Bearer {{secret}}\nSuffix"
            }),
            "Pi model config credentialHeader",
        ),
        (
            "oversized template",
            json!({
                "name": "X-Api-Key",
                "valueTemplate": format!("{}{{{{secret}}}}", "😀".repeat(508))
            }),
            "Pi model config credentialHeader",
        ),
        (
            "unknown nested field",
            json!({
                "name": "X-Api-Key",
                "valueTemplate": "Bearer {{secret}}",
                "futureField": true
            }),
            "Pi model config credentialHeader",
        ),
    ];

    for (case, header, expected) in invalid_headers {
        let mut context = pi_context_for_test();
        context.pi_model_config.as_mut().unwrap()["credentialHeader"] = header;

        let error = validate_context_for_test(&context).unwrap_err();

        assert!(
            error.contains(expected),
            "{case} produced unexpected error: {error}"
        );
    }

    for (case, catalog_model) in [("empty", json!("")), ("null", json!(null))] {
        let mut context = pi_context_for_test();
        context.pi_model_config.as_mut().unwrap()["catalogModel"] = catalog_model;

        let error = validate_context_for_test(&context).unwrap_err();

        assert!(
            error.contains("Pi model config catalogModel is invalid"),
            "{case} catalogModel produced unexpected error: {error}"
        );
    }
}

#[test]
fn pi_execution_context_restricts_model_base_url_schemes_before_sandbox() {
    let v2_public = pi_model_config_v2_for_test("openai-responses");
    let v2_codex = pi_model_config_v2_for_test("openai-codex-responses");
    let mut v3_public = v2_public.clone();
    v3_public["schemaVersion"] = json!(3);
    let mut v3_codex = v2_codex.clone();
    v3_codex["schemaVersion"] = json!(3);
    let configs = [
        pi_model_config_for_test(),
        v2_public,
        v2_codex,
        v3_public,
        v3_codex,
    ];

    for (base_url, supported) in [
        ("http://provider.example/v1", true),
        ("https://provider.example/v1", true),
        ("ftp://provider.example/v1", false),
        ("file:///tmp/model", false),
    ] {
        for original in &configs {
            let mut context = pi_context_for_test();
            let mut config = original.clone();
            config["baseUrl"] = json!(base_url);
            context.pi_model_config = Some(config.clone());

            let result = validate_context_for_test(&context);

            if supported {
                assert!(result.is_ok(), "{config}");
            } else {
                assert_eq!(
                    result.unwrap_err(),
                    "Pi model config baseUrl is invalid",
                    "{config}"
                );
            }
        }
    }
}

#[test]
fn pi_execution_context_accepts_and_preserves_versioned_dialect_tiers() {
    for generation in [2, 3] {
        for dialect in ["openai-responses", "openai-codex-responses"] {
            for tier in [None, Some("priority"), Some("fast"), Some("default")] {
                let mut context = pi_context_for_test();
                let mut config = pi_model_config_v2_for_test(dialect);
                config["schemaVersion"] = json!(generation);
                if let Some(tier) = tier {
                    config["serviceTier"] = json!(tier);
                }
                context.pi_model_config = Some(config.clone());
                let supported = tier.is_none()
                    || (dialect == "openai-responses" && tier == Some("priority"))
                    || (generation == 3
                        && dialect == "openai-codex-responses"
                        && tier == Some("fast"));
                assert_eq!(
                    validate_context_for_test(&context).is_ok(),
                    supported,
                    "{config}"
                );
                if supported {
                    let payload = build_run_payload_for_run(&context).unwrap();
                    let forwarded: serde_json::Value =
                        serde_json::from_str(&payload.pi_model_config).unwrap();
                    assert_eq!(forwarded, config);
                }
            }
        }
    }
}

#[test]
fn pi_execution_context_rejects_null_v3_optional_fields() {
    for field in ["thinkingLevel", "serviceTier", "catalogModel"] {
        let mut context = pi_context_for_test();
        let mut config = pi_model_config_v2_for_test("openai-responses");
        config["schemaVersion"] = json!(3);
        config[field] = json!(null);
        context.pi_model_config = Some(config);
        assert!(validate_context_for_test(&context).is_err(), "{field}");
    }
}

#[test]
fn pi_execution_context_rejects_invalid_or_future_v2_routes() {
    let invalid_configs = [
        (
            {
                let mut config = pi_model_config_v2_for_test("openai-responses");
                config["baseUrl"] = json!("not a URL");
                config
            },
            "Pi model config baseUrl is invalid",
        ),
        (
            {
                let mut config = pi_model_config_v2_for_test("openai-responses");
                config["model"] = json!("");
                config
            },
            "Pi model config model is invalid",
        ),
        (
            {
                let mut config = pi_model_config_v2_for_test("openai-responses");
                config["model"] = json!("😀".repeat(257));
                config
            },
            "Pi model config model is invalid",
        ),
        (
            {
                let mut config = pi_model_config_v2_for_test("openai-responses");
                config["catalogModel"] = json!("");
                config
            },
            "Pi model config catalogModel is invalid",
        ),
        (
            {
                let mut config = pi_model_config_v2_for_test("openai-responses");
                config["catalogModel"] = json!(null);
                config
            },
            "Pi model config catalogModel is invalid",
        ),
        (
            {
                let mut config = pi_model_config_v2_for_test("openai-responses");
                config["catalogModel"] = json!("😀".repeat(257));
                config
            },
            "Pi model config catalogModel is invalid",
        ),
        (
            {
                let mut config = pi_model_config_v2_for_test("openai-codex-responses");
                config["transport"] = json!("auto");
                config
            },
            "Pi model config transport must be sse",
        ),
        (
            {
                let mut config = pi_model_config_v2_for_test("openai-codex-responses");
                config["provider"] = json!("openai");
                config
            },
            "Pi Codex Responses route is invalid",
        ),
        (
            {
                let mut config = pi_model_config_v2_for_test("openai-codex-responses");
                config["credentialBindings"] = json!([{
                    "kind": "access-token",
                    "environment": "CHATGPT_ACCESS_TOKEN",
                    "secretName": "CHATGPT_ACCESS_TOKEN"
                }]);
                config
            },
            "Pi credential bindings do not match the route dialect",
        ),
        (
            {
                let mut config = pi_model_config_v2_for_test("openai-responses");
                config["credentialBindings"] = json!([{
                    "kind": "api-key",
                    "environment": "OPENAI_API_KEY",
                    "secretName": "CHATGPT_REFRESH_TOKEN"
                }]);
                config
            },
            "Pi API-key binding is invalid",
        ),
        (
            {
                let mut config = pi_model_config_v2_for_test("openai-responses");
                config["futureRouteField"] = json!(true);
                config
            },
            "Pi model config v2 fields are invalid",
        ),
        (
            {
                let mut config = pi_model_config_v2_for_test("openai-responses");
                config["schemaVersion"] = json!(5);
                config
            },
            "Pi model config generation is unsupported",
        ),
    ];

    for generation in [2, 3] {
        for (original, expected) in &invalid_configs {
            let mut config = original.clone();
            if config["schemaVersion"] == json!(2) {
                config["schemaVersion"] = json!(generation);
            }
            let mut context = pi_context_for_test();
            let expected = if generation == 3
                && (config["transport"] == json!("auto")
                    || (config["dialect"] == json!("openai-codex-responses")
                        && config["provider"] == json!("openai")))
            {
                "Pi model config v3 is invalid".to_string()
            } else {
                expected.replace("v2", &format!("v{generation}"))
            };
            context.pi_model_config = Some(config);
            let error = validate_context_for_test(&context).unwrap_err();
            assert!(
                error.contains(&expected),
                "expected {expected:?}, got unexpected error: {error}"
            );
        }
    }
}

#[test]
fn execution_context_validation_rejects_codex_runtime_config_nul() {
    let secret = "Mini\0Max";
    let mut ctx = minimal_context();
    let mut config = codex_runtime_config_for_test(None);
    config.name = secret.into();
    ctx.codex_runtime_config = Some(config);

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("run payload"));
    assert!(error.contains("NUL byte"));
    assert!(error.contains("OKOU_CODEX_RUNTIME_CONFIG"));
    assert!(!error.contains(secret));
}

#[test]
fn execution_context_validation_rejects_codex_runtime_config_catalog_nul() {
    let secret = "DeepSeek\0Flash";
    let mut ctx = minimal_context();
    ctx.codex_runtime_config = Some(codex_runtime_config_for_test(Some(json!({
        "models": [{ "slug": secret }],
    }))));

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("run payload"));
    assert!(error.contains("NUL byte"));
    assert!(error.contains("OKOU_CODEX_RUNTIME_CONFIG"));
    assert!(!error.contains(secret));
}

#[test]
fn build_env_json_with_user_timezone() {
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("Asia/Shanghai".into());

    let env = build_env_for_test(&ctx, "http://localhost");
    let user_env = build_user_env_json(&ctx);
    assert!(!env.contains_key("TZ"));
    assert_eq!(user_env.get("TZ").unwrap(), "Asia/Shanghai");
}

#[test]
fn build_env_json_user_timezone_not_override_environment() {
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("Asia/Shanghai".into());
    ctx.environment = Some(HashMap::from([("TZ".into(), "America/New_York".into())]));

    let env = build_env_for_test(&ctx, "http://localhost");
    let user_env = build_user_env_json(&ctx);
    // User environment TZ takes precedence
    assert!(!env.contains_key("TZ"));
    assert_eq!(user_env.get("TZ").unwrap(), "America/New_York");
}

#[test]
fn user_env_cannot_override_canonical_or_private_payload() {
    let mut ctx = minimal_context();
    ctx.environment = Some(HashMap::from([
        ("CUSTOM_PROMPT".into(), "hacked".into()),
        ("CUSTOM_API_TOKEN".into(), "user-token".into()),
        ("CUSTOM_ENV".into(), "kept".into()),
    ]));

    let env = build_env_for_test(&ctx, "http://localhost");
    let payload = build_run_payload_for_run(&ctx).unwrap();
    let user_env = build_user_env_json(&ctx);
    // Arbitrary user keys stay isolated from canonical bootstrap and the
    // private run payload while remaining visible as ordinary user env.
    assert!(!env.contains_key("CUSTOM_PROMPT"));
    assert_eq!(payload.prompt, "test prompt");
    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_API_TOKEN_ENV)
            .unwrap(),
        "tok"
    );
    assert!(!env.contains_key("CUSTOM_API_TOKEN"));
    assert!(!env.contains_key("CUSTOM_ENV"));
    assert_eq!(user_env.get("CUSTOM_ENV").unwrap(), "kept");
    assert_eq!(user_env.get("CUSTOM_PROMPT").unwrap(), "hacked");
    assert_eq!(user_env.get("CUSTOM_API_TOKEN").unwrap(), "user-token");
    assert!(!user_env.contains_key(guest_contracts::env::CANONICAL_API_TOKEN_ENV));
}

#[test]
fn build_env_json_vars_not_injected_directly() {
    let mut ctx = minimal_context();
    // vars should NOT be injected as env vars — they are expanded into
    // environment at compose time via ${{ vars.XXX }} templates.
    ctx.vars = Some(HashMap::from([("ONLY_VARS".into(), "vars-value".into())]));
    ctx.environment = Some(HashMap::from([("ONLY_ENV".into(), "env-value".into())]));

    let env = build_env_for_test(&ctx, "http://localhost");
    let user_env = build_user_env_json(&ctx);
    assert!(!env.contains_key("ONLY_VARS"));
    assert!(!env.contains_key("ONLY_ENV"));
    assert_eq!(user_env.get("ONLY_ENV").unwrap(), "env-value");
}

#[test]
fn build_env_json_with_mock_claude() {
    let ctx = minimal_context();
    let env = build_env_for_test_with_host_env(
        &ctx,
        "http://localhost",
        &HostEnv {
            use_mock_claude: Some("true".into()),
            ..HostEnv::default()
        },
    );
    assert_eq!(env.get("USE_MOCK_CLAUDE").unwrap(), "true");
    assert!(!env.contains_key("USE_MOCK_CODEX"));
}

#[test]
fn build_env_json_mock_claude_suppressed_by_real_agent_preview_flag() {
    let mut ctx = minimal_context();
    ctx.real_agent_in_preview = Some(true);
    let env = build_env_for_test_with_host_env(
        &ctx,
        "http://localhost",
        &HostEnv {
            use_mock_claude: Some("true".into()),
            ..HostEnv::default()
        },
    );
    assert!(!env.contains_key("USE_MOCK_CLAUDE"));
}

#[test]
fn build_env_json_with_mock_codex() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let env = build_env_for_test_with_host_env(
        &ctx,
        "http://localhost",
        &HostEnv {
            use_mock_codex: Some("1".into()),
            ..HostEnv::default()
        },
    );
    assert_eq!(env.get("USE_MOCK_CODEX").unwrap(), "1");
    assert!(!env.contains_key("USE_MOCK_CLAUDE"));
}

#[test]
fn build_env_json_mock_codex_suppressed_by_real_agent_preview_flag() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.real_agent_in_preview = Some(true);
    let env = build_env_for_test_with_host_env(
        &ctx,
        "http://localhost",
        &HostEnv {
            use_mock_codex: Some("1".into()),
            ..HostEnv::default()
        },
    );
    assert!(!env.contains_key("USE_MOCK_CODEX"));
}

#[test]
fn execution_context_deserializes_with_firewalls() {
    let json = serde_json::json!({
        "runId": "00000000-0000-0000-0000-000000000001",
        "prompt": "test",
        "sandboxToken": "tok",
        "cliAgentType": "claude-code",
        "billableFirewalls": [],
        "platformEnvironment": {},
        "connectorRuntimeTargets": [],
        "firewalls": [{
            "kind": "inline",
            "firewall": {
                "name": "github",
                "apis": [{
                    "base": "https://api.github.com",
                    "auth": {
                        "headers": {
                            "Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"
                        }
                    },
                    "permissions": [
                        {
                            "name": "issues-read",
                            "rules": [
                                "GET /repos/{owner}/{repo}/issues",
                                "GET /repos/{owner}/{repo}/issues/{issue_number}"
                            ]
                        }
                    ]
                }]
            }
        }]
    });
    let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
    let svcs = ctx.firewalls.unwrap();
    assert_eq!(svcs.len(), 1);
    let crate::types::FirewallEntry::Inline { firewall, .. } = &svcs[0] else {
        panic!("expected inline firewall entry");
    };
    assert_eq!(firewall.name, "github");
    assert_eq!(firewall.apis.len(), 1);
    assert_eq!(firewall.apis[0].base, "https://api.github.com");
    let perms = firewall.apis[0].permissions.as_ref().unwrap();
    assert_eq!(perms.len(), 1);
    assert_eq!(perms[0].name, "issues-read");
    assert_eq!(perms[0].rules.len(), 2);
    assert_eq!(perms[0].rules[0], "GET /repos/{owner}/{repo}/issues");
}

#[test]
fn execution_context_deserializes_without_firewalls() {
    let json = serde_json::json!({
        "runId": "00000000-0000-0000-0000-000000000001",
        "prompt": "test",
        "sandboxToken": "tok",
        "cliAgentType": "claude-code",
        "billableFirewalls": [],
        "platformEnvironment": {},
        "connectorRuntimeTargets": []
    });
    let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
    assert!(ctx.firewalls.is_none());
}

#[test]
fn build_env_json_with_disallowed_tools() {
    let mut ctx = minimal_context();
    ctx.disallowed_tools = Some(vec!["CronCreate".into(), "CronDelete".into()]);
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert_eq!(payload.disallowed_tools, "CronCreate,CronDelete");
}

#[test]
fn build_env_json_empty_disallowed_tools_omitted() {
    let mut ctx = minimal_context();
    ctx.disallowed_tools = Some(vec![]);
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(payload.disallowed_tools.is_empty());
}

#[test]
fn build_env_json_no_disallowed_tools() {
    let ctx = minimal_context();
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(payload.disallowed_tools.is_empty());
}

#[test]
fn build_env_json_with_tools() {
    let mut ctx = minimal_context();
    ctx.tools = Some(vec!["Bash".into(), "Edit".into()]);
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert_eq!(payload.tools, "Bash,Edit");
}

#[test]
fn build_env_json_empty_tools_omitted() {
    let mut ctx = minimal_context();
    ctx.tools = Some(vec![]);
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(payload.tools.is_empty());
}

#[test]
fn build_env_json_no_tools() {
    let ctx = minimal_context();
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(payload.tools.is_empty());
}

fn assert_tool_env_error<T: std::fmt::Debug>(
    result: RunnerResult<T>,
    env_name: &str,
    expected: &str,
) {
    let message = match result {
        Err(RunnerError::Internal(message)) => message,
        other => panic!("expected internal error, got {other:?}"),
    };
    assert!(message.contains(env_name), "message: {message}");
    assert!(message.contains(expected), "message: {message}");
}

#[test]
fn build_env_json_rejects_invalid_disallowed_tools_entries() {
    for (tool, expected) in [
        ("", "must not be empty"),
        ("   ", "must not be empty"),
        ("CronCreate,CronDelete", "must not contain commas"),
        ("CronCreate\0CronDelete", "must not contain NUL bytes"),
        ("--help", "must not start with a hyphen"),
        (" -v", "must not start with a hyphen"),
    ] {
        let mut ctx = minimal_context();
        ctx.disallowed_tools = Some(vec![tool.into()]);
        let result = build_run_payload_for_run(&ctx);
        assert_tool_env_error(result, "OKOU_DISALLOWED_TOOLS", expected);
    }
}

#[test]
fn build_env_json_rejects_invalid_tools_entries() {
    for (tool, expected) in [
        ("", "must not be empty"),
        ("   ", "must not be empty"),
        ("Bash,Read", "must not contain commas"),
        ("Bash\0Read", "must not contain NUL bytes"),
        ("--help", "must not start with a hyphen"),
        (" -x", "must not start with a hyphen"),
    ] {
        let mut ctx = minimal_context();
        ctx.tools = Some(vec![tool.into()]);
        let result = build_run_payload_for_run(&ctx);
        assert_tool_env_error(result, "OKOU_TOOLS", expected);
    }
}

#[test]
fn build_env_json_codex_ignores_claude_tool_lists() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.disallowed_tools = Some(vec!["".into()]);
    ctx.tools = Some(vec!["Bash,Read".into()]);
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(payload.disallowed_tools.is_empty());
    assert!(payload.tools.is_empty());
}

#[test]
fn build_env_json_with_settings() {
    let mut ctx = minimal_context();
    ctx.settings = Some(r#"{"hooks":{}}"#.into());
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert_eq!(payload.settings, r#"{"hooks":{}}"#);
}

#[test]
fn build_env_json_empty_settings_omitted() {
    let mut ctx = minimal_context();
    ctx.settings = Some("".into());
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(payload.settings.is_empty());
}

#[test]
fn build_env_json_no_settings() {
    let ctx = minimal_context();
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(payload.settings.is_empty());
}

#[test]
fn build_env_json_with_feature_flags() {
    let mut ctx = minimal_context();
    let mut flags = HashMap::new();
    flags.insert("computerUse".into(), true);
    flags.insert("audioOutput".into(), false);
    ctx.feature_flags = Some(flags);
    let payload = build_run_payload_for_run(&ctx).unwrap();
    let raw = &payload.feature_flags;
    let parsed: HashMap<String, bool> = serde_json::from_str(raw).unwrap();
    assert_eq!(parsed.get("computerUse"), Some(&true));
    assert_eq!(parsed.get("audioOutput"), Some(&false));
}

#[test]
fn build_env_json_empty_feature_flags_omitted() {
    let mut ctx = minimal_context();
    ctx.feature_flags = Some(HashMap::new());
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(payload.feature_flags.is_empty());
}

#[test]
fn build_env_json_no_feature_flags() {
    let ctx = minimal_context();
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(payload.feature_flags.is_empty());
}

#[tokio::test]
async fn build_env_json_with_memory_as_artifact() {
    // Memory is carried as an artifact in the private run payload.
    let mut ctx = minimal_context();
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![],
        artifacts: vec![api_artifact(
            "memory",
            "/memory",
            "",
            "v2",
            "https://example.com/memory.tar.gz",
        )],
    });
    let payload = build_run_payload_for_run(&ctx).unwrap();
    let artifacts = &payload.artifacts;
    assert!(artifacts.contains("\"memory\""));
    assert!(artifacts.contains("\"/memory\""));
    assert!(artifacts.contains("\"v2\""));
}

#[test]
fn native_pi_context_accepts_valid_fixtures_with_opaque_credentials() {
    let fixtures: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../../../../turbo/packages/api-contracts/src/contracts/__tests__/fixtures/pi-native.json"
    )).unwrap();
    for fixture in fixtures {
        let context = native_pi_context_for_test(fixture["config"].clone());
        let payload = validate_context_for_test(&context);
        assert!(payload.is_ok(), "{}: {:?}", fixture["name"], payload.err());
    }
}

#[test]
fn native_pi_context_rejects_wrong_dialects_credentials_and_regions() {
    let fixtures: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../../../../turbo/packages/api-contracts/src/contracts/__tests__/fixtures/pi-native.json"
    )).unwrap();
    for fixture in fixtures {
        for (field, invalid, expected_error) in [
            (
                "schemaVersion",
                json!(99),
                "Pi model config generation is unsupported",
            ),
            (
                "transport",
                json!("websocket"),
                "Pi native model config is invalid",
            ),
            (
                "catalogModel",
                json!("claude-fable-5"),
                "Pi native model config is invalid",
            ),
            (
                "api",
                json!("openai-responses"),
                "Pi native config fields are invalid",
            ),
            (
                "credentialOwner",
                json!("subscription"),
                "Pi native model config is invalid",
            ),
            (
                "requestPolicy",
                json!({"maxAttempts": 3, "cacheRetention": "short"}),
                "Pi native request or ownership policy is invalid",
            ),
        ] {
            let mut context = native_pi_context_for_test(fixture["config"].clone());
            assert_eq!(
                validate_context_for_test(&context),
                Ok(()),
                "{} {field} baseline",
                fixture["name"]
            );
            context.pi_model_config.as_mut().unwrap()[field] = invalid;
            assert_eq!(
                validate_context_for_test(&context),
                Err(expected_error.to_string()),
                "{} {field}",
                fixture["name"]
            );
        }
    }
}

#[test]
fn native_pi_context_rejects_missing_or_raw_credential_markers() {
    let fixtures: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../../../../turbo/packages/api-contracts/src/contracts/__tests__/fixtures/pi-native.json"
    )).unwrap();
    let expected_error = "Pi native environment must contain opaque firewall markers";
    for fixture in fixtures {
        let config = &fixture["config"];
        let mut context = native_pi_context_for_test(config.clone());
        assert_eq!(
            validate_context_for_test(&context),
            Ok(()),
            "{} baseline",
            fixture["name"]
        );
        context.environment = None;
        assert_eq!(
            validate_context_for_test(&context),
            Err(expected_error.to_string()),
            "{} missing environment",
            fixture["name"]
        );

        for binding in config["credentialBindings"].as_array().unwrap() {
            let key = binding["environment"].as_str().unwrap();
            for (case, invalid) in [("missing", None), ("raw", Some("real-secret"))] {
                let mut context = native_pi_context_for_test(config.clone());
                assert_eq!(
                    validate_context_for_test(&context),
                    Ok(()),
                    "{} {key} {case} baseline",
                    fixture["name"]
                );
                let environment = context.environment.as_mut().unwrap();
                match invalid {
                    Some(value) => {
                        environment.insert(key.into(), value.into());
                    }
                    None => {
                        environment.remove(key);
                    }
                }
                assert_eq!(
                    validate_context_for_test(&context),
                    Err(expected_error.to_string()),
                    "{} {key} {case}",
                    fixture["name"]
                );
            }
        }
    }
}

#[test]
fn native_pi_us_rejects_user_credentials_and_unsupported_models() {
    let fixtures: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../../../../turbo/packages/api-contracts/src/contracts/__tests__/fixtures/pi-native.json"
    )).unwrap();
    let fixture = fixtures
        .iter()
        .find(|fixture| fixture["name"] == "built-in US anthropic/claude-sonnet-4.6")
        .unwrap();
    let mut context = pi_context_for_test();
    context.pi_model_config = Some(fixture["config"].clone());
    context.environment.get_or_insert_with(HashMap::new).insert(
        "OKOU_PI_NATIVE_API_KEY".into(),
        api_contracts::generated::constants::runners::PI_NATIVE_CREDENTIAL_PLACEHOLDER.into(),
    );
    assert!(validate_context_for_test(&context).is_ok());
    for change in [
        json!({"credentialOwner": "organization", "billingOwner": "user"}),
        json!({"credentialOwner": "member", "billingOwner": "user"}),
        json!({"model": "anthropic/claude-fable-5.1", "catalogModel": "claude-fable-5-1"}),
        json!({"baseUrl": "https://us.openrouter.ai/api/v1"}),
    ] {
        let mut config = fixture["config"].clone();
        config
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        context.pi_model_config = Some(config);
        assert!(validate_context_for_test(&context).is_err());
    }
}
