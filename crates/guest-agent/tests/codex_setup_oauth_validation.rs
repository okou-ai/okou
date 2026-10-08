//! Codex OAuth setup validates the selected workspace before publishing private files.

use api_contracts::generated::constants::codex_oauth_token::placeholders::CHATGPT_ACCOUNT_ID;
use api_contracts::generated::types::runners::runs::CodexRuntimeConfig;
use guest_agent::env::{GuestConfig, GuestConfigRaw};
use guest_agent::masker::SecretMasker;
use serde_json::json;
use std::collections::HashMap;
use std::path::Path;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn oauth_config(
    root: &Path,
    account_id: Option<&str>,
) -> Result<GuestConfig, Box<dyn std::error::Error>> {
    let runtime_dir = root.join("runtime");
    let user_env_dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    let user_env_path = user_env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
    let run_payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let run_payload_path = run_payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    let mut user_env = HashMap::from([
        ("CHATGPT_ACCOUNT_ID", CHATGPT_ACCOUNT_ID),
        ("OPENAI_API_KEY", "sk-test-must-not-replace-oauth"),
    ]);
    if let Some(value) = account_id {
        user_env.insert("CODEX_OAUTH_ACCOUNT_ID", value);
    }
    std::fs::create_dir_all(&user_env_dir)?;
    std::fs::create_dir_all(&run_payload_dir)?;
    std::fs::write(&user_env_path, serde_json::to_vec(&user_env)?)?;
    std::fs::write(
        &run_payload_path,
        serde_json::to_vec(&guest_contracts::env::RunPayload::default())?,
    )?;

    let mut config = GuestConfig::from_raw(GuestConfigRaw {
        run_id: "codex-oauth-validation".to_string(),
        cli_agent_type: "codex".to_string(),
        user_env_file: user_env_path.to_string_lossy().into_owned(),
        run_payload_file: run_payload_path.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(runtime_dir),
        home: Some(root.join("child-home").to_string_lossy().into_owned()),
        ..Default::default()
    })?;
    config.codex_home_dir = root.join("codex-home").to_string_lossy().into_owned();
    config.codex_runtime_config = serde_json::to_string(&CodexRuntimeConfig {
        provider_id: "codex".to_string(),
        name: "Codex".to_string(),
        base_url: "https://api.example.test/v1".to_string(),
        env_key: "OPENAI_API_KEY".to_string(),
        requires_openai_auth: Some(true),
        wire_api: "responses".to_string(),
        supports_websockets: false,
        model_catalog: Some(json!({ "models": [{ "slug": "test-model" }] })),
    })?;
    Ok(config)
}

#[tokio::test]
async fn oauth_setup_requires_workspace_id_before_creating_runtime_files() -> TestResult {
    for account_id in [None, Some(""), Some(" \t\n")] {
        let tmp = tempfile::tempdir()?;
        let config = oauth_config(tmp.path(), account_id)?;
        let error = guest_agent::cli::setup_codex_for_config(&SecretMasker::from_raw(""), &config)
            .await
            .expect_err("OAuth setup requires a selected workspace ID");
        assert!(
            error
                .to_string()
                .contains("requires a non-empty CODEX_OAUTH_ACCOUNT_ID"),
            "{error}",
        );
        assert!(!Path::new(&config.codex_home_dir).exists());
    }
    Ok(())
}

#[tokio::test]
async fn oauth_setup_requires_workspace_id_before_replacing_runtime_files() -> TestResult {
    for account_id in [None, Some(""), Some(" \t\n")] {
        let tmp = tempfile::tempdir()?;
        let config = oauth_config(tmp.path(), account_id)?;
        let codex_home = Path::new(&config.codex_home_dir);
        std::fs::create_dir_all(codex_home)?;
        let auth_path = codex_home.join("auth.json");
        let catalog_path = codex_home.join("models.json");
        std::fs::write(&auth_path, "AUTH_FROM_PREVIOUS_RUN")?;
        std::fs::write(&catalog_path, "CATALOG_FROM_PREVIOUS_RUN")?;

        guest_agent::cli::setup_codex_for_config(&SecretMasker::from_raw(""), &config)
            .await
            .expect_err("OAuth setup requires a selected workspace ID");

        assert_eq!(
            std::fs::read_to_string(auth_path)?,
            "AUTH_FROM_PREVIOUS_RUN"
        );
        assert_eq!(
            std::fs::read_to_string(catalog_path)?,
            "CATALOG_FROM_PREVIOUS_RUN",
        );
    }
    Ok(())
}
