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
        "gpt-6-sol" => Some("max"),
        "gpt-5.6-sol" => Some("max"),
        "gpt-5.6-terra" => Some("max"),
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
    if let Some(headers) = &config.http_headers {
        let entries = headers
            .iter()
            .map(|(name, value)| {
                format!(
                    "{}={}",
                    quote_toml_basic_string(name),
                    quote_toml_basic_string(value)
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        overrides.push(format!("{provider_prefix}.http_headers={{{entries}}}"));
    }
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

pub(super) fn quote_toml_basic_string(value: &str) -> String {
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
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use serde_json::json;

    #[test]
    fn default_reasoning_effort_matches_supported_models() {
        for (model, effort) in [
            ("gpt-6-astra", "max"),
            ("openai/gpt-6-astra", "max"),
            ("gpt-6-sol", "max"),
            ("openai/gpt-6-sol", "max"),
            ("gpt-5.5", "xhigh"),
            ("openai/gpt-5.5", "xhigh"),
            ("gpt-5.6-sol", "max"),
            ("openai/gpt-5.6-sol", "max"),
            ("gpt-5.6-terra", "max"),
            ("openai/gpt-5.6-terra", "max"),
            ("gpt-5.6-luna", "max"),
            ("openai/gpt-5.6-luna", "max"),
        ] {
            assert_eq!(default_reasoning_effort_for_model(model), Some(effort));
        }
        assert_eq!(default_reasoning_effort_for_model("custom-model"), None);
    }

    #[test]
    fn startup_config_overrides_include_provider_and_catalog_path() {
        let codex_home = Path::new("/tmp/codex-home");
        let config = CodexRuntimeConfig {
            provider_id: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            base_url: "https://api.deepseek.com/".to_string(),
            env_key: "OPENAI_API_KEY".to_string(),
            http_headers: None,
            requires_openai_auth: None,
            wire_api: "responses".to_string(),
            supports_websockets: false,
            model_catalog: Some(json!({ "models": [{ "slug": "deepseek-v4-flash" }] })),
        };

        let overrides = startup_config_overrides(Some(&config), codex_home);

        assert_eq!(overrides[0], r#"model_provider="deepseek""#);
        assert!(overrides.contains(&r#"model_providers.deepseek.name="DeepSeek""#.to_string()));
        assert!(overrides.contains(
            &r#"model_providers.deepseek.base_url="https://api.deepseek.com/""#.to_string()
        ));
        assert!(
            overrides.contains(&r#"model_providers.deepseek.env_key="OPENAI_API_KEY""#.to_string())
        );
        assert!(
            overrides.contains(&r#"model_providers.deepseek.wire_api="responses""#.to_string())
        );
        assert!(
            overrides
                .contains(&r#"model_providers.deepseek.supports_websockets=false"#.to_string())
        );
        assert!(
            overrides.contains(&r#"model_catalog_json="/tmp/codex-home/models.json""#.to_string())
        );
    }

    #[test]
    fn startup_config_overrides_support_custom_headers_without_openai_auth() {
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
            model_catalog: None,
        };

        let overrides = startup_config_overrides(Some(&config), Path::new("/tmp/codex-home"));

        assert!(overrides.contains(
            &r#"model_providers.gateway.http_headers={"x-api-key"="__VM0_OPENAI_API_KEY_PLACEHOLDER__"}"#.to_string()
        ));
        assert!(
            overrides.contains(&"model_providers.gateway.requires_openai_auth=false".to_string())
        );
    }

    #[test]
    fn parse_raw_rejects_unsafe_provider_key_segments() {
        let raw = r#"{
            "providerId": "provider.with.dot",
            "name": "Provider",
            "baseUrl": "https://example.test/v1",
            "envKey": "OPENAI_API_KEY",
            "wireApi": "responses",
            "supportsWebsockets": false
        }"#;

        let error = parse_raw(raw).unwrap_err().to_string();

        assert!(error.contains("invalid Codex runtime provider id"));
        assert!(!error.contains("provider.with.dot"));
    }

    #[test]
    fn parse_raw_rejects_invalid_auth_env_keys() {
        let raw = r#"{
            "providerId": "provider",
            "name": "Provider",
            "baseUrl": "https://example.test/v1",
            "envKey": "OPENAI-API-KEY",
            "wireApi": "responses",
            "supportsWebsockets": false
        }"#;

        let error = parse_raw(raw).unwrap_err().to_string();

        assert!(error.contains("invalid Codex runtime auth env key"));
        assert!(!error.contains("OPENAI-API-KEY"));
    }

    #[test]
    fn startup_config_overrides_use_codex_dotted_path_segments() {
        let config = CodexRuntimeConfig {
            provider_id: "provider-with-dash".to_string(),
            name: "Provider".to_string(),
            base_url: "https://example.test/v1".to_string(),
            env_key: "OPENAI_API_KEY".to_string(),
            http_headers: None,
            requires_openai_auth: None,
            wire_api: "responses".to_string(),
            supports_websockets: false,
            model_catalog: None,
        };

        let overrides = startup_config_overrides(Some(&config), Path::new("/tmp/codex-home"));

        assert!(overrides.contains(
            &r#"model_providers.provider-with-dash.base_url="https://example.test/v1""#.to_string()
        ));
        assert!(
            !overrides
                .iter()
                .any(|override_value| override_value.starts_with("model_catalog_json="))
        );
    }

    #[test]
    fn write_model_catalog_writes_json_when_present() {
        let tmp = tempfile::tempdir().unwrap();
        let config = CodexRuntimeConfig {
            provider_id: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            base_url: "https://api.deepseek.com/".to_string(),
            env_key: "OPENAI_API_KEY".to_string(),
            http_headers: None,
            requires_openai_auth: None,
            wire_api: "responses".to_string(),
            supports_websockets: false,
            model_catalog: Some(json!({ "models": [{ "slug": "deepseek-v4-flash" }] })),
        };

        write_model_catalog(tmp.path(), &config).unwrap();

        let written = std::fs::read_to_string(model_catalog_path(tmp.path())).unwrap();
        assert_eq!(written, r#"{"models":[{"slug":"deepseek-v4-flash"}]}"#);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mode = std::fs::metadata(model_catalog_path(tmp.path()))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o7777, 0o600);
        }
    }

    #[cfg(unix)]
    #[test]
    fn write_model_catalog_replaces_existing_symlink_without_touching_target() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().unwrap();
        let codex_home = tmp.path().join(".codex");
        std::fs::create_dir_all(&codex_home).unwrap();
        let symlink_target = tmp.path().join("target-catalog.json");
        std::fs::write(&symlink_target, b"TARGET_CONTENT_MUST_SURVIVE").unwrap();
        symlink(&symlink_target, model_catalog_path(&codex_home)).unwrap();
        let config = CodexRuntimeConfig {
            provider_id: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            base_url: "https://api.deepseek.com/".to_string(),
            env_key: "OPENAI_API_KEY".to_string(),
            http_headers: None,
            requires_openai_auth: None,
            wire_api: "responses".to_string(),
            supports_websockets: false,
            model_catalog: Some(json!({ "models": [{ "slug": "deepseek-v4-flash" }] })),
        };

        write_model_catalog(&codex_home, &config).unwrap();

        assert_eq!(
            std::fs::read_to_string(&symlink_target).unwrap(),
            "TARGET_CONTENT_MUST_SURVIVE",
            "model catalog replacement must not write through an existing symlink"
        );
        assert!(
            !std::fs::symlink_metadata(model_catalog_path(&codex_home))
                .unwrap()
                .file_type()
                .is_symlink(),
            "model catalog path should be a regular replacement file, not the old symlink"
        );
        let written = std::fs::read_to_string(model_catalog_path(&codex_home)).unwrap();
        assert_eq!(written, r#"{"models":[{"slug":"deepseek-v4-flash"}]}"#);
    }
}
