use super::*;
use serde_json::json;

#[test]
fn default_reasoning_effort_matches_supported_models() {
    for (model, effort) in [
        ("gpt-6-astra", "max"),
        ("openai/gpt-6-astra", "max"),
        ("gpt-6-sol", "max"),
        ("openai/gpt-6-sol", "max"),
        ("gpt-6-luna", "max"),
        ("openai/gpt-6-luna", "max"),
        ("gpt-5.5", "xhigh"),
        ("openai/gpt-5.5", "xhigh"),
        ("gpt-5.6-sol", "max"),
        ("openai/gpt-5.6-sol", "max"),
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
        provider_id: "openrouter-codex".to_string(),
        name: "OpenRouter (Codex)".to_string(),
        base_url: "https://openrouter.ai/api/v1".to_string(),
        env_key: "OPENAI_API_KEY".to_string(),
        requires_openai_auth: None,
        wire_api: "responses".to_string(),
        supports_websockets: false,
        model_catalog: Some(json!({ "models": [{ "slug": "deepseek-v4-flash" }] })),
    };

    let overrides = startup_config_overrides(Some(&config), codex_home);

    assert_eq!(overrides[0], r#"model_provider="openrouter-codex""#);
    assert!(
        overrides
            .contains(&r#"model_providers.openrouter-codex.name="OpenRouter (Codex)""#.to_string())
    );
    assert!(overrides.contains(
        &r#"model_providers.openrouter-codex.base_url="https://openrouter.ai/api/v1""#.to_string()
    ));
    assert!(
        overrides
            .contains(&r#"model_providers.openrouter-codex.env_key="OPENAI_API_KEY""#.to_string())
    );
    assert!(
        overrides.contains(&r#"model_providers.openrouter-codex.wire_api="responses""#.to_string())
    );
    assert!(
        overrides
            .contains(&r#"model_providers.openrouter-codex.supports_websockets=false"#.to_string())
    );
    assert!(overrides.contains(&r#"model_catalog_json="/tmp/codex-home/models.json""#.to_string()));
}

#[test]
fn startup_config_overrides_disable_openai_auth_when_requested() {
    let config = CodexRuntimeConfig {
        provider_id: "openrouter-codex".to_string(),
        name: "OpenRouter (Codex)".to_string(),
        base_url: "https://openrouter.ai/api/v1".to_string(),
        env_key: "OPENAI_API_KEY".to_string(),
        requires_openai_auth: Some(false),
        wire_api: "responses".to_string(),
        supports_websockets: false,
        model_catalog: None,
    };

    let overrides = startup_config_overrides(Some(&config), Path::new("/tmp/codex-home"));

    assert!(
        overrides
            .contains(&"model_providers.openrouter-codex.requires_openai_auth=false".to_string())
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
        provider_id: "openrouter-codex".to_string(),
        name: "OpenRouter (Codex)".to_string(),
        base_url: "https://openrouter.ai/api/v1".to_string(),
        env_key: "OPENAI_API_KEY".to_string(),
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
        provider_id: "openrouter-codex".to_string(),
        name: "OpenRouter (Codex)".to_string(),
        base_url: "https://openrouter.ai/api/v1".to_string(),
        env_key: "OPENAI_API_KEY".to_string(),
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
