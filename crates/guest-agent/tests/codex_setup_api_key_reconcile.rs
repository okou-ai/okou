//! Codex setup should reconcile managed auth without invoking external Codex.
//!
use guest_agent::masker::SecretMasker;
use serde_json::Value;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;
use std::time::Duration;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn api_key_setup_writes_auth_without_invoking_codex() -> TestResult {
    let tmp = tempfile::tempdir()?;
    let bin_dir = tmp.path().join("bin");
    let fake_codex = bin_dir.join("codex");
    let invoked_marker = tmp.path().join("codex-invoked");
    let child_home = tmp.path().join("child-home");
    let codex_home = tmp.path().join("codex-home");
    let runtime_dir = tmp.path().join("runtime");
    let user_env_dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    let user_env_path = user_env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
    let run_payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let run_payload_path = run_payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);

    std::fs::create_dir_all(&bin_dir)?;
    std::fs::create_dir_all(&user_env_dir)?;
    std::fs::create_dir_all(&run_payload_dir)?;
    std::fs::write(
        &user_env_path,
        serde_json::to_vec(&serde_json::json!({
            "OPENAI_API_KEY": "sk-test-api-key-reconcile",
        }))?,
    )?;
    std::fs::write(
        &run_payload_path,
        serde_json::to_vec(&guest_contracts::env::RunPayload::default())?,
    )?;
    write_fake_codex(&fake_codex, &invoked_marker)?;

    let original_path = std::env::var("PATH").unwrap_or_default();
    let path = format!("{}:{original_path}", bin_dir.display());

    unsafe {
        std::env::set_var("PATH", path);
    }

    let mut config = guest_agent::env::GuestConfig::from_raw(guest_agent::env::GuestConfigRaw {
        run_id: "codex-setup-api-key".to_string(),
        cli_agent_type: "codex".to_string(),
        user_env_file: user_env_path.to_string_lossy().into_owned(),
        run_payload_file: run_payload_path.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(runtime_dir),
        home: Some(child_home.to_string_lossy().into_owned()),
        ..Default::default()
    })?;
    config.codex_home_dir = codex_home.to_string_lossy().into_owned();

    let masker = SecretMasker::from_raw("");
    tokio::time::timeout(
        Duration::from_secs(2),
        guest_agent::cli::setup_codex_for_config(&masker, &config),
    )
    .await
    .expect("codex auth setup should return promptly")?;

    let auth_path = codex_home.join("auth.json");
    assert!(codex_home.is_dir(), "configured Codex home must be created");
    assert!(!child_home.join(".codex").exists());
    #[cfg(unix)]
    {
        let codex_home_mode = std::fs::metadata(&codex_home)?.permissions().mode() & 0o7777;
        assert_eq!(
            codex_home_mode, 0o700,
            ".codex must be mode 0o700 (got {codex_home_mode:o})"
        );
        let auth_mode = std::fs::metadata(&auth_path)?.permissions().mode() & 0o7777;
        assert_eq!(
            auth_mode, 0o600,
            "auth.json must be mode 0o600 (got {auth_mode:o})"
        );
    }

    let auth: Value = serde_json::from_str(&std::fs::read_to_string(auth_path)?)?;
    assert_eq!(auth["auth_mode"], "apikey");
    assert_eq!(auth["OPENAI_API_KEY"], "sk-test-api-key-reconcile");
    assert!(
        auth.get("tokens").is_none(),
        "API-key auth.json should not contain ChatGPT tokens: {auth}"
    );
    assert!(
        !invoked_marker.exists(),
        "setup must not invoke codex login or any external codex binary"
    );

    Ok(())
}

#[tokio::test]
async fn chatgpt_setup_writes_auth_outside_child_home() -> TestResult {
    let tmp = tempfile::tempdir()?;
    let child_home = tmp.path().join("child-home");
    let codex_home = tmp.path().join("codex-home");
    let runtime_dir = tmp.path().join("runtime");
    let user_env_dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    let user_env_path = user_env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
    let run_payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let run_payload_path = run_payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);

    std::fs::create_dir_all(&user_env_dir)?;
    std::fs::create_dir_all(&run_payload_dir)?;
    std::fs::write(
        &user_env_path,
        serde_json::to_vec(&serde_json::json!({
            "CHATGPT_ACCOUNT_ID": "account-test",
        }))?,
    )?;
    std::fs::write(
        &run_payload_path,
        serde_json::to_vec(&guest_contracts::env::RunPayload::default())?,
    )?;

    let mut config = guest_agent::env::GuestConfig::from_raw(guest_agent::env::GuestConfigRaw {
        run_id: "codex-setup-chatgpt".to_string(),
        cli_agent_type: "codex".to_string(),
        user_env_file: user_env_path.to_string_lossy().into_owned(),
        run_payload_file: run_payload_path.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(runtime_dir),
        home: Some(child_home.to_string_lossy().into_owned()),
        ..Default::default()
    })?;
    config.codex_home_dir = codex_home.to_string_lossy().into_owned();

    guest_agent::cli::setup_codex_for_config(&SecretMasker::from_raw(""), &config).await?;

    let auth: Value =
        serde_json::from_str(&std::fs::read_to_string(codex_home.join("auth.json"))?)?;
    assert_eq!(auth["auth_mode"], "chatgpt");
    assert!(auth["tokens"].is_object());
    assert!(auth["OPENAI_API_KEY"].is_null());
    assert!(!child_home.join(".codex").exists());

    Ok(())
}

fn write_fake_codex(path: &Path, marker: &Path) -> TestResult {
    std::fs::write(
        path,
        format!(
            "#!/bin/sh\nprintf invoked > {}\nexit 99\n",
            shell_quote(marker)
        ),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mut permissions = std::fs::metadata(path)?.permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

fn shell_quote(path: &Path) -> String {
    let raw = path.to_string_lossy();
    format!("'{}'", raw.replace('\'', "'\\''"))
}
