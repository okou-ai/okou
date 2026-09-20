mod native;

use std::collections::HashMap;

use api_contracts::generated::constants::model_provider_env::placeholders as model_provider_placeholders;
use api_contracts::generated::constants::runners::{
    PI_MODEL_CONFIG_CURRENT_GENERATION, PI_MODEL_CONFIG_DIALECT_TIER_GENERATION,
    PI_MODEL_CONFIG_NATIVE_GENERATION,
};
use api_contracts::generated::types::runners::{
    runs::{CodexRuntimeConfig, PiLaunchConfig, PiModelConfig, PiModelConfigV2, PiModelConfigV3},
    storage::ArtifactEntryMissingRootPolicy,
};
use guest_contracts::cli_agent_session_id::is_valid_cli_agent_session_id;
use guest_contracts::codex_thread_id::canonical_codex_thread_id;
use guest_contracts::connector_account_context::{
    RunConnectorAccountContext, RunConnectorAccountTarget,
};
use sandbox::{Sandbox, WriteFileEntry};

use super::cli_framework::{
    EffectiveCliFramework, effective_cli_framework, normalized_cli_agent_type,
};
use super::{JOB_TIMEOUT, RunnerError, RunnerResult, guest_runtime_dir, guest_runtime_path};
use crate::ids::RunId;
use crate::types::{
    ConnectorRuntimeTargetRegistration, ExecutionContext, SandboxReuseResult, WorkspaceReuseResult,
};

pub(super) struct ProtectedModelProviderEnvKey {
    name: &'static str,
    placeholder: Option<&'static str>,
}

pub(super) const CLAUDE_MODEL_PROVIDER_PLACEHOLDER_ENV_KEYS: &[ProtectedModelProviderEnvKey] = &[
    ProtectedModelProviderEnvKey {
        name: "ANTHROPIC_API_KEY",
        placeholder: Some(model_provider_placeholders::ANTHROPIC_API_KEY),
    },
    ProtectedModelProviderEnvKey {
        name: "ANTHROPIC_AUTH_TOKEN",
        placeholder: Some(model_provider_placeholders::ANTHROPIC_AUTH_TOKEN),
    },
    ProtectedModelProviderEnvKey {
        name: "CLAUDE_CODE_OAUTH_TOKEN",
        placeholder: Some(model_provider_placeholders::CLAUDE_CODE_OAUTH_TOKEN),
    },
];

pub(super) const CODEX_MODEL_PROVIDER_PLACEHOLDER_ENV_KEYS: &[ProtectedModelProviderEnvKey] = &[
    ProtectedModelProviderEnvKey {
        name: "OPENAI_API_KEY",
        placeholder: Some(model_provider_placeholders::OPENAI_API_KEY),
    },
    ProtectedModelProviderEnvKey {
        name: "CHATGPT_ACCESS_TOKEN",
        placeholder: Some(model_provider_placeholders::CHATGPT_ACCESS_TOKEN),
    },
    ProtectedModelProviderEnvKey {
        name: "CHATGPT_ACCOUNT_ID",
        placeholder: Some(model_provider_placeholders::CHATGPT_ACCOUNT_ID),
    },
    ProtectedModelProviderEnvKey {
        name: "CHATGPT_REFRESH_TOKEN",
        placeholder: Some(model_provider_placeholders::CHATGPT_REFRESH_TOKEN),
    },
    ProtectedModelProviderEnvKey {
        name: "CHATGPT_ID_TOKEN",
        placeholder: None,
    },
];

pub(super) const MODEL_PROVIDER_PLACEHOLDER_ENV_KEYS: &[&[ProtectedModelProviderEnvKey]] = &[
    CLAUDE_MODEL_PROVIDER_PLACEHOLDER_ENV_KEYS,
    CODEX_MODEL_PROVIDER_PLACEHOLDER_ENV_KEYS,
];

pub(super) fn validate_model_provider_env_placeholders(
    context: &ExecutionContext,
) -> Result<(), String> {
    let Some(environment) = &context.environment else {
        return Ok(());
    };

    let invalid_keys: Vec<&str> = MODEL_PROVIDER_PLACEHOLDER_ENV_KEYS
        .iter()
        .flat_map(|protected_keys| protected_keys.iter())
        .filter_map(|protected_key| {
            let value = environment.get(protected_key.name)?;
            if value.is_empty()
                || protected_key
                    .placeholder
                    .is_some_and(|placeholder| value == placeholder)
                || context
                    .local_secret_env_keys
                    .as_ref()
                    .is_some_and(|keys| keys.contains(protected_key.name))
            {
                None
            } else {
                Some(protected_key.name)
            }
        })
        .collect();

    if invalid_keys.is_empty() {
        return Ok(());
    }

    Err(format!(
        "model provider environment contains non-placeholder values for: {}",
        invalid_keys.join(", ")
    ))
}

pub(super) fn validate_execution_context_before_sandbox(
    context: &ExecutionContext,
    api_url: &str,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
) -> Result<PreparedRunPayload, String> {
    let host_env = HostEnv::from_process();
    validate_execution_context_before_sandbox_with_host_env(
        context,
        api_url,
        sandbox_id,
        reuse_result,
        &host_env,
    )
}

pub(super) fn validate_execution_context_before_sandbox_with_host_env(
    context: &ExecutionContext,
    api_url: &str,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
    host_env: &HostEnv,
) -> Result<PreparedRunPayload, String> {
    validate_resume_session_id(context)?;
    validate_model_provider_env_placeholders(context)?;
    validate_pi_execution_context(context)?;
    native::validate_environment(context)?;
    validate_user_environment_for_guest(context)?;
    let prepared_run_payload =
        prepare_run_payload_for_run(context).map_err(|error| match error {
            RunnerError::Internal(message) => message,
            error => error.to_string(),
        })?;
    let bootstrap_env =
        build_env_json_with_host_env(context, api_url, sandbox_id, reuse_result, host_env)
            .map_err(|error| error.to_string())?;
    validate_bootstrap_environment_for_guest(&bootstrap_env)?;
    Ok(prepared_run_payload)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

// Generated enums and explicit versions intentionally fail closed. A future
// enum value or schema version must reach runners before the API emits it;
// unknown additive object fields remain safe because the original JSON is
// forwarded after this validation view is discarded.
fn validate_pi_launch_config(value: &serde_json::Value, session_id: &str) -> Result<(), String> {
    let launch: PiLaunchConfig = serde_json::from_value(value.clone())
        .map_err(|error| format!("Pi launch config v2 is invalid: {error}"))?;
    if value.pointer("/apiFirstTurn/baseSession/sha256").is_none() {
        return Err("Pi H0 sha256 must be present".to_string());
    }
    if launch.schema_version != 2 {
        return Err("Pi launch config schemaVersion must be 2".to_string());
    }
    let slot = launch.api_first_turn;
    if slot.schema_version != 1 {
        return Err("Pi API first-turn schemaVersion must be 1".to_string());
    }
    if !is_sha256(&slot.resource_snapshot_digest) {
        return Err("Pi resource snapshot digest is invalid".to_string());
    }
    for (name, raw) in [
        ("manifestUrl", &slot.manifest_url),
        ("sessionUrl", &slot.session_url),
    ] {
        let parsed =
            url::Url::parse(raw).map_err(|_| format!("Pi API first-turn {name} is invalid"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(format!("Pi API first-turn {name} must use HTTP or HTTPS"));
        }
    }
    if slot.deadline_at <= 0 {
        return Err("Pi API first-turn deadlineAt must be positive".to_string());
    }
    if !(1..=i32::MAX as u64).contains(&slot.sandbox_event_sequence_start) {
        return Err("Pi Sandbox event sequence start must be between 1 and 2147483647".to_string());
    }
    if slot.base_session.session_id != session_id {
        return Err("Pi H0 session id does not match pi_session_id".to_string());
    }
    if let Some(hash) = slot.base_session.sha256
        && !is_sha256(&hash)
    {
        return Err("Pi H0 sha256 must be null or a lowercase SHA-256".to_string());
    }
    Ok(())
}

fn is_pi_credential_secret_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z' | b'_'))
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

enum PiModelConfigCommonError {
    InvalidBaseUrl,
    EmptyModel,
    InvalidCatalogModel,
}

fn validate_pi_model_config_common(
    base_url: &str,
    model: &str,
    catalog_model: Option<&serde_json::Value>,
) -> Result<(), PiModelConfigCommonError> {
    let parsed = url::Url::parse(base_url).map_err(|_| PiModelConfigCommonError::InvalidBaseUrl)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(PiModelConfigCommonError::InvalidBaseUrl);
    }
    if model.is_empty() {
        return Err(PiModelConfigCommonError::EmptyModel);
    }
    if catalog_model.is_some_and(|value| value.as_str().is_none_or(str::is_empty)) {
        return Err(PiModelConfigCommonError::InvalidCatalogModel);
    }
    Ok(())
}

fn validate_legacy_pi_model_config(value: &serde_json::Value) -> Result<(), String> {
    let model: PiModelConfig = serde_json::from_value(value.clone())
        .map_err(|error| format!("Pi legacy model config is invalid: {error}"))?;
    validate_pi_model_config_common(&model.base_url, &model.model, value.get("catalogModel"))
        .map_err(|error| match error {
            PiModelConfigCommonError::InvalidBaseUrl => {
                "Pi model config baseUrl is invalid".to_string()
            }
            PiModelConfigCommonError::EmptyModel => {
                "Pi model config model must not be empty".to_string()
            }
            PiModelConfigCommonError::InvalidCatalogModel => {
                "Pi model config catalogModel is invalid".to_string()
            }
        })?;
    if !is_pi_credential_secret_name(&model.credential_secret_name) {
        return Err("Pi model config credentialSecretName is invalid".to_string());
    }
    if value
        .get("credentialHeader")
        .is_some_and(|header| !is_valid_pi_credential_header(header))
    {
        return Err("Pi model config credentialHeader is invalid".to_string());
    }
    Ok(())
}

fn has_exact_object_fields(
    object: &serde_json::Map<String, serde_json::Value>,
    required: &[&str],
    allowed: &[&str],
) -> bool {
    required.iter().all(|field| object.contains_key(*field))
        && object
            .keys()
            .all(|field| allowed.iter().any(|allowed_field| field == allowed_field))
}

fn is_valid_pi_credential_header(value: &serde_json::Value) -> bool {
    let Some(header) = value.as_object() else {
        return false;
    };
    if !has_exact_object_fields(
        header,
        &["name", "valueTemplate"],
        &["name", "valueTemplate"],
    ) {
        return false;
    }
    let Some(name) = header.get("name").and_then(serde_json::Value::as_str) else {
        return false;
    };
    let mut name_bytes = name.bytes();
    if name.is_empty()
        || name.len() > 128
        || !name_bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic())
        || !name_bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return false;
    }
    let Some(template) = header
        .get("valueTemplate")
        .and_then(serde_json::Value::as_str)
    else {
        return false;
    };
    if template.is_empty()
        || template.encode_utf16().count() > 1024
        || template.contains('\r')
        || template.contains('\n')
        || template.match_indices("{{secret}}").count() != 1
    {
        return false;
    }
    let static_template = template.replacen("{{secret}}", "", 1);
    !static_template.contains("{{") && !static_template.contains("}}")
}

fn validate_pi_v2_credential_bindings(
    value: &serde_json::Value,
    dialect: &str,
) -> Result<(), String> {
    let Some(bindings) = value.as_array() else {
        return Err("Pi model config credentialBindings is invalid".to_string());
    };
    if !(1..=2).contains(&bindings.len()) {
        return Err("Pi model config credentialBindings count is invalid".to_string());
    }
    let mut kinds: Vec<&str> = Vec::with_capacity(bindings.len());
    for binding in bindings {
        let Some(object) = binding.as_object() else {
            return Err("Pi model config credential binding is invalid".to_string());
        };
        let Some(kind) = object.get("kind").and_then(serde_json::Value::as_str) else {
            return Err("Pi model config credential binding kind is invalid".to_string());
        };
        if kinds.contains(&kind) {
            return Err("Pi model config credential binding kind is duplicated".to_string());
        }
        kinds.push(kind);
        match kind {
            "api-key" => {
                if !has_exact_object_fields(
                    object,
                    &["kind", "environment", "secretName"],
                    &["kind", "environment", "secretName", "credentialHeader"],
                ) || object
                    .get("environment")
                    .and_then(serde_json::Value::as_str)
                    != Some("OPENAI_API_KEY")
                {
                    return Err("Pi API-key binding is invalid".to_string());
                }
                let known_secret = matches!(
                    object.get("secretName").and_then(serde_json::Value::as_str),
                    Some(
                        "DEEPSEEK_API_KEY"
                            | "OPENAI_API_KEY"
                            | "OPENROUTER_API_KEY"
                            | "VERCEL_AI_GATEWAY_API_KEY"
                            | "OKOU_MODEL_PROVIDER_API_KEY"
                    )
                );
                if !known_secret
                    || object
                        .get("credentialHeader")
                        .is_some_and(|header| !is_valid_pi_credential_header(header))
                {
                    return Err("Pi API-key binding is invalid".to_string());
                }
            }
            "access-token" => {
                if !has_exact_object_fields(
                    object,
                    &["kind", "environment", "secretName"],
                    &["kind", "environment", "secretName"],
                ) || object
                    .get("environment")
                    .and_then(serde_json::Value::as_str)
                    != Some("CHATGPT_ACCESS_TOKEN")
                    || object.get("secretName").and_then(serde_json::Value::as_str)
                        != Some("CHATGPT_ACCESS_TOKEN")
                {
                    return Err("Pi access-token binding is invalid".to_string());
                }
            }
            "account-id" => {
                if !has_exact_object_fields(
                    object,
                    &["kind", "environment", "secretName"],
                    &["kind", "environment", "secretName"],
                ) || object
                    .get("environment")
                    .and_then(serde_json::Value::as_str)
                    != Some("CHATGPT_ACCOUNT_ID")
                    || object.get("secretName").and_then(serde_json::Value::as_str)
                        != Some("CHATGPT_ACCOUNT_ID")
                {
                    return Err("Pi account-ID binding is invalid".to_string());
                }
            }
            _ => return Err("Pi credential binding kind is unsupported".to_string()),
        }
    }
    let valid_dialect_bindings = match dialect {
        "openai-responses" => kinds.as_slice() == ["api-key"],
        "openai-codex-responses" => {
            kinds.len() == 2 && kinds.contains(&"access-token") && kinds.contains(&"account-id")
        }
        _ => false,
    };
    if !valid_dialect_bindings {
        return Err("Pi credential bindings do not match the route dialect".to_string());
    }
    Ok(())
}

fn validate_pi_model_config_v2(value: &serde_json::Value) -> Result<(), String> {
    let model: PiModelConfigV2 = serde_json::from_value(value.clone())
        .map_err(|error| format!("Pi model config v2 is invalid: {error}"))?;
    validate_pi_versioned_model_config(
        value,
        &model.base_url,
        &model.model,
        PI_MODEL_CONFIG_CURRENT_GENERATION,
    )
}

fn validate_pi_model_config_v3(value: &serde_json::Value) -> Result<(), String> {
    let model: PiModelConfigV3 = serde_json::from_value(value.clone())
        .map_err(|error| format!("Pi model config v3 is invalid: {error}"))?;
    let (base_url, model_name) = match &model {
        PiModelConfigV3::OpenaiResponses {
            base_url, model, ..
        }
        | PiModelConfigV3::OpenaiCodexResponses {
            base_url, model, ..
        } => (base_url, model),
    };
    validate_pi_versioned_model_config(
        value,
        base_url,
        model_name,
        PI_MODEL_CONFIG_DIALECT_TIER_GENERATION,
    )
}

fn validate_pi_versioned_model_config(
    value: &serde_json::Value,
    base_url: &str,
    model: &str,
    generation: u32,
) -> Result<(), String> {
    validate_pi_model_config_common(base_url, model, value.get("catalogModel")).map_err(
        |error| match error {
            PiModelConfigCommonError::InvalidBaseUrl => {
                "Pi model config baseUrl is invalid".to_string()
            }
            PiModelConfigCommonError::EmptyModel => "Pi model config model is invalid".to_string(),
            PiModelConfigCommonError::InvalidCatalogModel => {
                "Pi model config catalogModel is invalid".to_string()
            }
        },
    )?;
    if model.encode_utf16().count() > 512 {
        return Err("Pi model config model is invalid".to_string());
    }
    let Some(object) = value.as_object() else {
        return Err(format!("Pi model config v{generation} is invalid"));
    };
    if !has_exact_object_fields(
        object,
        &[
            "schemaVersion",
            "dialect",
            "transport",
            "provider",
            "baseUrl",
            "model",
            "credentialBindings",
        ],
        &[
            "schemaVersion",
            "dialect",
            "transport",
            "provider",
            "baseUrl",
            "model",
            "catalogModel",
            "thinkingLevel",
            "serviceTier",
            "credentialBindings",
        ],
    ) {
        return Err(format!("Pi model config v{generation} fields are invalid"));
    }
    if object.get("transport").and_then(serde_json::Value::as_str) != Some("sse") {
        return Err("Pi model config transport must be sse".to_string());
    }
    if object
        .get("catalogModel")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|catalog_model| catalog_model.encode_utf16().count() > 512)
    {
        return Err("Pi model config catalogModel is invalid".to_string());
    }
    validate_pi_model_config_dialect(object, generation)
}

fn validate_pi_model_config_dialect(
    object: &serde_json::Map<String, serde_json::Value>,
    generation: u32,
) -> Result<(), String> {
    let dialect = object
        .get("dialect")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Pi model config dialect is invalid".to_string())?;
    let provider = object
        .get("provider")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Pi model config provider is invalid".to_string())?;
    match dialect {
        "openai-responses" if provider == "openai-codex" => {
            return Err("Pi public Responses provider is invalid".to_string());
        }
        "openai-codex-responses"
            if provider != "openai-codex"
                || object.contains_key("catalogModel")
                || (generation == PI_MODEL_CONFIG_CURRENT_GENERATION
                    && object.contains_key("serviceTier")) =>
        {
            return Err("Pi Codex Responses route is invalid".to_string());
        }
        "openai-responses" | "openai-codex-responses" => {}
        _ => return Err("Pi model config dialect is unsupported".to_string()),
    }
    // Serde Option accepts null; the new wire contract permits omission only.
    if generation == PI_MODEL_CONFIG_DIALECT_TIER_GENERATION {
        for field in ["thinkingLevel", "serviceTier"] {
            if object.get(field).is_some_and(serde_json::Value::is_null) {
                return Err(format!("Pi model config {field} is invalid"));
            }
        }
    }
    validate_pi_v2_credential_bindings(
        object
            .get("credentialBindings")
            .ok_or_else(|| "Pi model config credentialBindings is missing".to_string())?,
        dialect,
    )
}

fn validate_pi_model_config(value: &serde_json::Value) -> Result<(), String> {
    match value.get("schemaVersion") {
        None => validate_legacy_pi_model_config(value),
        Some(serde_json::Value::Number(generation))
            if generation.as_u64() == Some(u64::from(PI_MODEL_CONFIG_CURRENT_GENERATION)) =>
        {
            validate_pi_model_config_v2(value)
        }
        Some(serde_json::Value::Number(generation))
            if generation.as_u64() == Some(u64::from(PI_MODEL_CONFIG_DIALECT_TIER_GENERATION)) =>
        {
            validate_pi_model_config_v3(value)
        }
        Some(serde_json::Value::Number(generation))
            if generation.as_u64() == Some(u64::from(PI_MODEL_CONFIG_NATIVE_GENERATION)) =>
        {
            native::validate(value)
        }
        Some(_) => Err("Pi model config generation is unsupported".to_string()),
    }
}

fn validate_pi_execution_context(context: &ExecutionContext) -> Result<(), String> {
    if effective_cli_framework(&context.cli_agent_type) != EffectiveCliFramework::Pi {
        return Ok(());
    }
    let session_id = context
        .pi_session_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Pi execution context is missing pi_session_id".to_string())?;
    uuid::Uuid::parse_str(session_id)
        .map_err(|_| "Pi execution context has invalid pi_session_id".to_string())?;
    let launch_config = context
        .pi_launch_config
        .as_ref()
        .ok_or_else(|| "Pi execution context is missing pi_launch_config".to_string())?;
    validate_pi_launch_config(launch_config, session_id)?;
    let model_config = context
        .pi_model_config
        .as_ref()
        .ok_or_else(|| "Pi execution context is missing pi_model_config".to_string())?;
    validate_pi_model_config(model_config)?;
    if let Some(resume) = &context.resume_session
        && resume.cli_agent_session_id != session_id
    {
        return Err("Pi resume session id does not match pi_session_id".to_string());
    }
    Ok(())
}

fn validate_user_environment_for_guest(context: &ExecutionContext) -> Result<(), String> {
    let mut entries: Vec<(&str, &str)> = Vec::new();
    for_each_guest_user_env_entry(context, |key, value| entries.push((key, value)));
    entries.sort_by_key(|(key, _)| *key);

    for (key, value) in entries {
        if !guest_contracts::env::is_shell_identifier_env_key(key) {
            return Err(format!(
                "user environment contains invalid env key {:?}",
                guest_contracts::env::sanitize_env_key_for_diagnostic(key)
            ));
        }
        if value.contains('\0') {
            return Err(format!(
                "user environment contains NUL byte for env key {:?}",
                guest_contracts::env::sanitize_env_key_for_diagnostic(key)
            ));
        }
    }

    Ok(())
}

fn validate_run_payload_field(name: &str, value: &str) -> Result<(), String> {
    if value.contains('\0') {
        return Err(format!("run payload contains NUL byte for {name}"));
    }
    Ok(())
}

fn validate_codex_runtime_config_field(config: &CodexRuntimeConfig) -> Result<(), String> {
    for value in [
        config.provider_id.as_str(),
        config.name.as_str(),
        config.base_url.as_str(),
        config.env_key.as_str(),
        config.wire_api.as_str(),
    ] {
        validate_run_payload_field(
            guest_contracts::env::CODEX_RUNTIME_CONFIG_RUN_PAYLOAD_FIELD,
            value,
        )?;
    }
    for (name, value) in config.http_headers.iter().flatten() {
        validate_run_payload_field(
            guest_contracts::env::CODEX_RUNTIME_CONFIG_RUN_PAYLOAD_FIELD,
            name,
        )?;
        validate_run_payload_field(
            guest_contracts::env::CODEX_RUNTIME_CONFIG_RUN_PAYLOAD_FIELD,
            value,
        )?;
    }
    if let Some(model_catalog) = &config.model_catalog
        && json_value_contains_nul_string(model_catalog)
    {
        return Err(format!(
            "run payload contains NUL byte for {}",
            guest_contracts::env::CODEX_RUNTIME_CONFIG_RUN_PAYLOAD_FIELD
        ));
    }
    Ok(())
}

fn json_value_contains_nul_string(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(value) => value.contains('\0'),
        serde_json::Value::Array(values) => values.iter().any(json_value_contains_nul_string),
        serde_json::Value::Object(values) => values.values().any(json_value_contains_nul_string),
        serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => {
            false
        }
    }
}

fn validate_bootstrap_environment_for_guest(
    environment: &HashMap<String, String>,
) -> Result<(), String> {
    let mut entries: Vec<(&String, &String)> = environment.iter().collect();
    entries.sort_by_key(|(key, _)| *key);

    for (key, value) in entries {
        if !guest_contracts::env::is_shell_identifier_env_key(key) {
            return Err(format!(
                "bootstrap environment contains invalid env key {:?}",
                guest_contracts::env::sanitize_env_key_for_diagnostic(key)
            ));
        }
        if value.contains('\0') {
            return Err(format!(
                "bootstrap environment contains NUL byte for env key {:?}",
                guest_contracts::env::sanitize_env_key_for_diagnostic(key)
            ));
        }
    }

    Ok(())
}

pub(crate) fn validate_resume_session_id(context: &ExecutionContext) -> Result<(), String> {
    let Some(session) = &context.resume_session else {
        return Ok(());
    };
    match effective_cli_framework(&context.cli_agent_type) {
        EffectiveCliFramework::Codex => canonical_codex_thread_id(&session.cli_agent_session_id)
            .map(|_| ())
            .ok_or_else(|| "invalid codex session_id".to_string()),
        EffectiveCliFramework::ClaudeCode => {
            if is_valid_cli_agent_session_id(&session.cli_agent_session_id) {
                Ok(())
            } else {
                Err("invalid session_id".to_string())
            }
        }
        EffectiveCliFramework::Pi => {
            if is_valid_cli_agent_session_id(&session.cli_agent_session_id) {
                Ok(())
            } else {
                Err("invalid pi session_id".to_string())
            }
        }
    }
}

pub(super) fn build_user_env_json(context: &ExecutionContext) -> HashMap<String, String> {
    let mut env = HashMap::new();

    for_each_guest_user_env_entry(context, |key, value| {
        env.insert(key.to_string(), value.to_string());
    });

    env
}

fn for_each_guest_user_env_entry<'a>(
    context: &'a ExecutionContext,
    mut visit: impl FnMut(&'a str, &'a str),
) {
    for_each_filtered_environment_entry(
        context.environment.as_ref(),
        is_runner_owned_env_key,
        &mut visit,
    );

    if let Some(tz) = &context.user_timezone {
        let has_tz = context
            .environment
            .as_ref()
            .is_some_and(|env| env.contains_key("TZ"));
        if !has_tz {
            visit("TZ", tz);
        }
    }

    for (key, value) in &context.platform_environment {
        visit(key, value);
    }
}

fn for_each_filtered_environment_entry<'a>(
    environment: Option<&'a HashMap<String, String>>,
    is_runner_owned: fn(&str) -> bool,
    visit: &mut impl FnMut(&'a str, &'a str),
) {
    if let Some(environment) = environment {
        for (key, value) in environment {
            if !is_runner_owned(key) {
                visit(key, value);
            }
        }
    }
}

pub(super) fn guest_user_env_file_path(run_id: RunId) -> RunnerResult<String> {
    guest_runtime_path(run_id, |dir| {
        dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME)
            .join(guest_contracts::env::USER_ENV_FILENAME)
    })
}

pub(super) fn guest_run_payload_file_path(run_id: RunId) -> RunnerResult<String> {
    guest_runtime_path(run_id, |dir| {
        dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME)
            .join(guest_contracts::env::RUN_PAYLOAD_FILENAME)
    })
}

pub(super) fn guest_connector_account_context_file_path(run_id: RunId) -> RunnerResult<String> {
    guest_runtime_path(run_id, |dir| {
        dir.join(guest_contracts::env::CONNECTOR_ACCOUNT_CONTEXT_PRIVATE_DIR_NAME)
            .join(guest_contracts::env::CONNECTOR_ACCOUNT_CONTEXT_FILENAME)
    })
}

fn build_connector_account_context(context: &ExecutionContext) -> RunConnectorAccountContext {
    let targets = context
        .connector_runtime_targets
        .iter()
        .map(|target| match target {
            ConnectorRuntimeTargetRegistration::Builtin {
                connector_slug,
                source_id,
                ..
            } => RunConnectorAccountTarget::Builtin {
                connector_slug: connector_slug.clone(),
                connection_id: source_id.clone(),
            },
            ConnectorRuntimeTargetRegistration::Custom {
                custom_connector_id,
                source_id,
                ..
            } => RunConnectorAccountTarget::Custom {
                custom_connector_id: custom_connector_id.clone(),
                connection_id: source_id.clone(),
            },
        })
        .collect();
    RunConnectorAccountContext {
        schema_version: guest_contracts::connector_account_context::SCHEMA_VERSION,
        targets,
    }
}

pub(super) struct RequiredAgentFiles {
    pub(super) user_env_file: String,
    pub(super) run_payload_file: String,
}

pub(super) async fn write_required_agent_files(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    user_env: &mut HashMap<String, String>,
    run_payload: &guest_contracts::env::RunPayload,
) -> RunnerResult<RequiredAgentFiles> {
    let connector_context_file = guest_connector_account_context_file_path(context.run_id)?;
    let connector_context_bytes = serde_json::to_vec(&build_connector_account_context(context))
        .map_err(|e| RunnerError::Internal(format!("serialize connector account context: {e}")))?;
    user_env.insert(
        guest_contracts::env::CONNECTOR_ACCOUNT_CONTEXT_FILE_ENV.to_string(),
        connector_context_file.clone(),
    );
    let user_env_file = guest_user_env_file_path(context.run_id)?;
    let user_env_bytes = serde_json::to_vec(user_env)
        .map_err(|e| RunnerError::Internal(format!("serialize user env: {e}")))?;
    let run_payload_file = guest_run_payload_file_path(context.run_id)?;
    let run_payload_bytes = serde_json::to_vec(run_payload)
        .map_err(|e| RunnerError::Internal(format!("serialize run payload: {e}")))?;

    // All bootstrap inputs are required. Keep context first so a failed account
    // projection write prevents later writes, including in oversized fallback.
    sandbox
        .write_private_files(&[
            WriteFileEntry {
                path: &connector_context_file,
                content: &connector_context_bytes,
            },
            WriteFileEntry {
                path: &user_env_file,
                content: &user_env_bytes,
            },
            WriteFileEntry {
                path: &run_payload_file,
                content: &run_payload_bytes,
            },
        ])
        .await?;

    Ok(RequiredAgentFiles {
        user_env_file,
        run_payload_file,
    })
}

pub(super) fn build_env_json_with_host_env(
    context: &ExecutionContext,
    api_url: &str,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
    host_env: &HostEnv,
) -> RunnerResult<HashMap<String, String>> {
    build_env_json_with_host_env_inner(context, api_url, sandbox_id, reuse_result, None, host_env)
}

/// Build the guest-agent bootstrap environment.
///
/// This intentionally excludes `context.environment`. User/model/connector
/// environment is transferred separately and injected only into the CLI child.
pub(super) fn build_env_json_for_run(
    context: &ExecutionContext,
    api_url: &str,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
    workspace_reuse_result: WorkspaceReuseResult,
) -> RunnerResult<HashMap<String, String>> {
    let host_env = HostEnv::from_process();
    build_env_json_with_host_env_for_run(
        context,
        api_url,
        sandbox_id,
        reuse_result,
        workspace_reuse_result,
        &host_env,
    )
}

pub(super) fn build_env_json_with_host_env_for_run(
    context: &ExecutionContext,
    api_url: &str,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
    workspace_reuse_result: WorkspaceReuseResult,
    host_env: &HostEnv,
) -> RunnerResult<HashMap<String, String>> {
    build_env_json_with_host_env_inner(
        context,
        api_url,
        sandbox_id,
        reuse_result,
        Some(workspace_reuse_result),
        host_env,
    )
}

fn build_env_json_with_host_env_inner(
    context: &ExecutionContext,
    api_url: &str,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
    workspace_reuse_result: Option<WorkspaceReuseResult>,
    host_env: &HostEnv,
) -> RunnerResult<HashMap<String, String>> {
    let mut env = HashMap::new();

    env.insert(
        guest_contracts::env::CANONICAL_API_URL_ENV.into(),
        api_url.into(),
    );
    env.insert(
        guest_contracts::env::RUN_ID_ENV.into(),
        context.run_id.to_string(),
    );
    env.insert(
        guest_contracts::env::CANONICAL_API_TOKEN_ENV.into(),
        context.sandbox_token.clone(),
    );
    env.insert(
        guest_contracts::env::CANONICAL_SANDBOX_ID_ENV.into(),
        sandbox_id.into(),
    );
    env.insert(
        guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV.into(),
        guest_runtime_dir(context.run_id)?,
    );
    env.insert(
        guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV.into(),
        reuse_result.as_wire().into(),
    );
    if let Some(workspace_reuse_result) = workspace_reuse_result {
        env.insert(
            guest_contracts::env::CANONICAL_WORKSPACE_REUSE_RESULT_ENV.into(),
            workspace_reuse_result.as_wire().into(),
        );
    }
    env.insert(
        guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV.into(),
        JOB_TIMEOUT.as_secs().to_string(),
    );
    env.insert(
        guest_contracts::env::CANONICAL_API_START_TIME_ENV.into(),
        context
            .api_start_time
            .map(|t| t.to_string())
            .unwrap_or_default(),
    );
    // The API omits cli_agent_type for claude-code agents (the default).
    env.insert(
        guest_contracts::env::CLI_AGENT_TYPE_ENV.into(),
        normalized_cli_agent_type(&context.cli_agent_type).into(),
    );

    // Vercel bypass
    if let Some(bypass) = &host_env.vercel_automation_bypass_secret {
        env.insert(
            guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV.into(),
            bypass.clone(),
        );
    }

    // Resume session ID
    if let Some(session) = &context.resume_session {
        let session_id =
            if effective_cli_framework(&context.cli_agent_type) == EffectiveCliFramework::Codex {
                canonical_codex_thread_id(&session.cli_agent_session_id)
                    .ok_or_else(|| RunnerError::Internal("invalid codex session_id".into()))?
            } else {
                session.cli_agent_session_id.clone()
            };
        env.insert(
            guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV.into(),
            session_id,
        );
    }

    // Note: Connector placeholder env vars (e.g., GITHUB_TOKEN=gho_CoffeeSafeLocal...)
    // are injected by the web API into `context.environment` directly.

    match effective_cli_framework(&context.cli_agent_type) {
        EffectiveCliFramework::ClaudeCode => insert_claude_code_env(&mut env, context, host_env),
        EffectiveCliFramework::Codex => insert_codex_env(&mut env, context, host_env),
        EffectiveCliFramework::Pi => {}
    }

    Ok(env)
}

pub(super) struct PreparedRunPayload {
    payload: guest_contracts::env::RunPayload,
}

impl PreparedRunPayload {
    pub(super) fn into_run_payload(
        mut self,
        context: &ExecutionContext,
    ) -> RunnerResult<guest_contracts::env::RunPayload> {
        self.payload.secret_values = serialize_secret_values(context);
        validate_run_payload_for_guest(&self.payload).map_err(RunnerError::Internal)?;
        Ok(self.payload)
    }
}

pub(super) fn prepare_run_payload_for_run(
    context: &ExecutionContext,
) -> RunnerResult<PreparedRunPayload> {
    if let Some(config) = &context.codex_runtime_config {
        validate_codex_runtime_config_field(config).map_err(RunnerError::Internal)?;
    }

    let mut disallowed_tools = String::new();
    let mut tools = String::new();
    let mut settings = String::new();
    if effective_cli_framework(&context.cli_agent_type) == EffectiveCliFramework::ClaudeCode {
        if let Some(values) = &context.disallowed_tools {
            disallowed_tools = serialize_claude_tool_env(
                guest_contracts::env::DISALLOWED_TOOLS_RUN_PAYLOAD_FIELD,
                values,
            )?
            .unwrap_or_default();
        }
        if let Some(values) = &context.tools {
            tools =
                serialize_claude_tool_env(guest_contracts::env::TOOLS_RUN_PAYLOAD_FIELD, values)?
                    .unwrap_or_default();
        }
        if let Some(value) = &context.settings
            && !value.is_empty()
        {
            settings = value.clone();
        }
    }

    let payload = guest_contracts::env::RunPayload {
        prompt: context.prompt.clone(),
        append_system_prompt: context.append_system_prompt.clone().unwrap_or_default(),
        secret_values: String::new(),
        disallowed_tools,
        tools,
        settings,
        artifacts: serialize_artifacts_payload(context)?,
        feature_flags: serialize_feature_flags_payload(context)?,
        codex_runtime_config: serialize_codex_runtime_config_payload(context)?,
        pi_launch_config: serialize_pi_launch_config_payload(context)?,
        pi_model_config: serialize_pi_model_config_payload(context)?,
        pi_session_id: context.pi_session_id.clone().unwrap_or_default(),
    };

    validate_run_payload_for_guest(&payload).map_err(RunnerError::Internal)?;
    Ok(PreparedRunPayload { payload })
}

#[cfg(test)]
pub(super) fn build_run_payload_for_run(
    context: &ExecutionContext,
) -> RunnerResult<guest_contracts::env::RunPayload> {
    prepare_run_payload_for_run(context)?.into_run_payload(context)
}

fn serialize_secret_values(context: &ExecutionContext) -> String {
    use base64::Engine as _;
    let mut encoded: Vec<String> =
        vec![base64::engine::general_purpose::STANDARD.encode(&context.sandbox_token)];
    if let Some(secret_values) = &context.secret_values {
        encoded.extend(
            secret_values
                .iter()
                .map(|s| base64::engine::general_purpose::STANDARD.encode(s)),
        );
    }
    encoded.join(",")
}

fn serialize_artifacts_payload(context: &ExecutionContext) -> RunnerResult<String> {
    let Some(manifest) = &context.storage_manifest else {
        return Ok(String::new());
    };
    if manifest.artifacts.is_empty() {
        return Ok(String::new());
    }

    let payload: Vec<guest_contracts::env::RunArtifact> = manifest
        .artifacts
        .iter()
        .map(|artifact| guest_contracts::env::RunArtifact {
            name: artifact.vas_storage_name.clone(),
            mount_path: artifact.mount_path.clone(),
            storage_id: artifact.vas_storage_id.clone(),
            version_id: artifact.vas_version_id.clone(),
            missing_root_policy: artifact
                .missing_root_policy
                .map(run_artifact_missing_root_policy),
        })
        .collect();

    serde_json::to_string(&payload)
        .map_err(|e| RunnerError::Internal(format!("serialize artifact payload: {e}")))
}

fn run_artifact_missing_root_policy(
    policy: ArtifactEntryMissingRootPolicy,
) -> guest_contracts::env::RunArtifactMissingRootPolicy {
    match policy {
        ArtifactEntryMissingRootPolicy::Fail => {
            guest_contracts::env::RunArtifactMissingRootPolicy::Fail
        }
        ArtifactEntryMissingRootPolicy::PreserveParentVersion => {
            guest_contracts::env::RunArtifactMissingRootPolicy::PreserveParentVersion
        }
    }
}

fn serialize_feature_flags_payload(context: &ExecutionContext) -> RunnerResult<String> {
    let Some(flags) = &context.feature_flags else {
        return Ok(String::new());
    };
    if flags.is_empty() {
        return Ok(String::new());
    }
    serde_json::to_string(flags)
        .map_err(|e| RunnerError::Internal(format!("serialize feature flags payload: {e}")))
}

fn serialize_codex_runtime_config_payload(context: &ExecutionContext) -> RunnerResult<String> {
    let Some(config) = &context.codex_runtime_config else {
        return Ok(String::new());
    };
    serde_json::to_string(config)
        .map_err(|e| RunnerError::Internal(format!("serialize Codex runtime config: {e}")))
}

fn serialize_pi_launch_config_payload(context: &ExecutionContext) -> RunnerResult<String> {
    let Some(config) = &context.pi_launch_config else {
        return Ok(String::new());
    };
    serde_json::to_string(config)
        .map_err(|e| RunnerError::Internal(format!("serialize Pi launch config: {e}")))
}

fn serialize_pi_model_config_payload(context: &ExecutionContext) -> RunnerResult<String> {
    let Some(config) = &context.pi_model_config else {
        return Ok(String::new());
    };
    serde_json::to_string(config)
        .map_err(|e| RunnerError::Internal(format!("serialize Pi model config: {e}")))
}

fn validate_run_payload_for_guest(
    payload: &guest_contracts::env::RunPayload,
) -> Result<(), String> {
    if let Some(name) = payload.first_nul_field() {
        return Err(format!("run payload contains NUL byte for {name}"));
    }

    Ok(())
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct HostEnv {
    pub(super) vercel_automation_bypass_secret: Option<String>,
    pub(super) use_mock_claude: Option<String>,
    pub(super) use_mock_codex: Option<String>,
}

impl HostEnv {
    pub(super) fn from_process() -> Self {
        Self {
            vercel_automation_bypass_secret: std::env::var("VERCEL_AUTOMATION_BYPASS_SECRET").ok(),
            use_mock_claude: std::env::var(guest_contracts::env::USE_MOCK_CLAUDE_ENV).ok(),
            use_mock_codex: std::env::var(guest_contracts::env::USE_MOCK_CODEX_ENV).ok(),
        }
    }
}

pub(super) fn is_runner_owned_env_key(key: &str) -> bool {
    // The entire OKOU_ namespace and the exact retained local timing inputs are
    // runner-owned. Bootstrap keys outside that namespace must stay explicit.
    guest_contracts::env::is_runner_owned_env_key(key)
}

pub(super) fn insert_claude_code_env(
    env: &mut HashMap<String, String>,
    context: &ExecutionContext,
    host_env: &HostEnv,
) {
    // Pass USE_MOCK_CLAUDE from host environment for testing unless preview
    // evaluation explicitly asks for the real agent runtime.
    if let Some(val) = &host_env.use_mock_claude
        && !context.real_agent_in_preview.unwrap_or(false)
    {
        env.insert(
            guest_contracts::env::USE_MOCK_CLAUDE_ENV.into(),
            val.clone(),
        );
    }
}

pub(super) fn serialize_claude_tool_env(
    env_name: &str,
    tools: &[String],
) -> RunnerResult<Option<String>> {
    if tools.is_empty() {
        return Ok(None);
    }

    validate_claude_tool_env_entries(env_name, tools).map_err(RunnerError::Internal)?;

    Ok(Some(tools.join(",")))
}

pub(super) fn validate_claude_tool_env_entries(
    env_name: &str,
    tools: &[String],
) -> Result<(), String> {
    for (index, tool) in tools.iter().enumerate() {
        if tool.trim().is_empty() {
            return Err(format!(
                "{env_name} entry at index {index} must not be empty"
            ));
        }
        if tool.contains(',') {
            return Err(format!(
                "{env_name} entry at index {index} must not contain commas"
            ));
        }
        if tool.contains('\0') {
            return Err(format!(
                "{env_name} entry at index {index} must not contain NUL bytes"
            ));
        }
        if tool.trim_start().starts_with('-') {
            return Err(format!(
                "{env_name} entry at index {index} must not start with a hyphen"
            ));
        }
    }

    Ok(())
}

pub(super) fn insert_codex_env(
    env: &mut HashMap<String, String>,
    context: &ExecutionContext,
    host_env: &HostEnv,
) {
    // Pass USE_MOCK_CODEX from host environment for testing unless preview
    // evaluation explicitly asks for the real agent runtime.
    if let Some(val) = &host_env.use_mock_codex
        && !context.real_agent_in_preview.unwrap_or(false)
    {
        env.insert(guest_contracts::env::USE_MOCK_CODEX_ENV.into(), val.clone());
    }
}
