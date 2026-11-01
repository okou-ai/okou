//! Codex runtime provider configuration owned by vm0.
//!
//! The API resolves provider capability metadata before dispatch. The guest
//! only translates that structured payload into Codex startup configuration.

use std::path::{Path, PathBuf};
use std::time::Instant;

use api_contracts::generated::types::runners::runs::CodexRuntimeConfig;
use guest_contracts::runtime_paths::{self, PrivateFileReplacementTarget};
use guest_telemetry::telemetry::record_sandbox_op;

use crate::error::AgentError;

const MODEL_CATALOG_FILENAME: &str = "models.json";
const MODEL_CATALOG_PREPARE_ACTION: &str = "codex_model_catalog_prepare";

/// Per-model default for Codex app-server's turn reasoning effort.
pub(super) fn default_reasoning_effort_for_model(model: &str) -> Option<&'static str> {
    let bare = model.strip_prefix("openai/").unwrap_or(model);
    match bare {
        "gpt-6-astra" => Some("max"),
        "gpt-6.1-sol" => Some("medium"),
        "gpt-6-sol" => Some("max"),
        "gpt-6-luna" => Some("max"),
        "gpt-5.6-sol" => Some("max"),
        "gpt-5.6-luna" => Some("max"),
        "gpt-5.5" => Some("xhigh"),
        _ => None,
    }
}

pub(super) fn parse_raw(raw: &str) -> Result<Option<CodexRuntimeConfig>, AgentError> {
    if raw.is_empty() {
        return Ok(None);
    }
    let config: CodexRuntimeConfig = serde_json::from_str(raw)?;
    validate_config(&config)?;
    Ok(Some(config))
}

fn validate_config(config: &CodexRuntimeConfig) -> Result<(), AgentError> {
    if !is_codex_config_key_segment(&config.provider_id) {
        return Err(AgentError::Execution(
            "invalid Codex runtime provider id".to_string(),
        ));
    }
    if !is_env_var_name(&config.env_key) {
        return Err(AgentError::Execution(
            "invalid Codex runtime auth env key".to_string(),
        ));
    }
    Ok(())
}

fn is_codex_config_key_segment(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn is_env_var_name(value: &str) -> bool {
    let Some(first) = value.bytes().next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == b'_')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

pub(super) fn write_model_catalog_from_raw(
    codex_home_dir: &str,
    raw: &str,
) -> Result<(), AgentError> {
    let Some(config) = parse_raw(raw)? else {
        return Ok(());
    };
    write_model_catalog(Path::new(codex_home_dir), &config)
}

pub(super) fn model_catalog_path(codex_home: &Path) -> PathBuf {
    codex_home.join(MODEL_CATALOG_FILENAME)
}

pub(super) fn write_model_catalog(
    codex_home: &Path,
    config: &CodexRuntimeConfig,
) -> Result<(), AgentError> {
    let Some(model_catalog) = &config.model_catalog else {
        return Ok(());
    };
    record_catalog_operation(MODEL_CATALOG_PREPARE_ACTION, || {
        let path = model_catalog_path(codex_home);
        runtime_paths::replace_private_atomic(
            path,
            serde_json::to_vec(model_catalog)?,
            PrivateFileReplacementTarget::ReplaceFinalEntry,
        )?;
        Ok(())
    })
}

fn record_catalog_operation<T>(
    action_type: &str,
    operation: impl FnOnce() -> Result<T, AgentError>,
) -> Result<T, AgentError> {
    let started_at = Instant::now();
    let result = operation();
    record_sandbox_op(action_type, started_at.elapsed(), result.is_ok(), None);
    result
}

pub(super) fn startup_config_overrides(
    config: Option<&CodexRuntimeConfig>,
    codex_home: &Path,
) -> Vec<String> {
    let Some(config) = config else {
        return Vec::new();
    };
    let provider_prefix = format!("model_providers.{}", config.provider_id);
    let mut overrides = vec![
        format!(
            "model_provider={}",
            quote_toml_basic_string(&config.provider_id)
        ),
        format!(
            "{provider_prefix}.name={}",
            quote_toml_basic_string(&config.name)
        ),
        format!(
            "{provider_prefix}.base_url={}",
            quote_toml_basic_string(&config.base_url)
        ),
        format!(
            "{provider_prefix}.env_key={}",
            quote_toml_basic_string(&config.env_key)
        ),
        format!(
            "{provider_prefix}.wire_api={}",
            quote_toml_basic_string(&config.wire_api)
        ),
        format!(
            "{provider_prefix}.supports_websockets={}",
            config.supports_websockets
        ),
    ];
    if let Some(requires_openai_auth) = config.requires_openai_auth {
        overrides.push(format!(
            "{provider_prefix}.requires_openai_auth={requires_openai_auth}"
        ));
    }
    if config.model_catalog.is_some() {
        overrides.push(format!(
            "model_catalog_json={}",
            quote_toml_basic_string(&model_catalog_path(codex_home).to_string_lossy())
        ));
    }
    overrides
}

fn quote_toml_basic_string(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for ch in value.chars() {
        match ch {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\n' => quoted.push_str("\\n"),
            '\t' => quoted.push_str("\\t"),
            '\u{08}' => quoted.push_str("\\b"),
            '\u{0C}' => quoted.push_str("\\f"),
            '\r' => quoted.push_str("\\r"),
            ch if ch.is_control() => quoted.push_str(&format!("\\u{:04X}", u32::from(ch))),
            ch => quoted.push(ch),
        }
    }
    quoted.push('"');
    quoted
}

#[cfg(test)]
mod tests;
