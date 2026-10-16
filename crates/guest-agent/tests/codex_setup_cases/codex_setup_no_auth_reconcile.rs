//! Codex setup should remove stale auth.json when no auth is configured.
//!
use guest_agent::masker::SecretMasker;
use std::time::Duration;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn codex_setup_no_auth_removes_stale_auth_json() -> TestResult {
    let tmp = tempfile::tempdir()?;
    let runtime_dir = tmp.path().join("runtime");
    let user_env_dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    let user_env_path = user_env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
    let run_payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let run_payload_path = run_payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    let child_home = tmp.path().join("child-home");
    let codex_home = tmp.path().join("codex-home");
    let auth_path = codex_home.join("auth.json");

    std::fs::create_dir_all(&user_env_dir)?;
    std::fs::create_dir_all(&run_payload_dir)?;
    std::fs::write(&user_env_path, "{}")?;
    std::fs::write(
        &run_payload_path,
        serde_json::to_vec(&guest_contracts::env::RunPayload::default())?,
    )?;
    std::fs::create_dir_all(&codex_home)?;
    std::fs::write(
        &auth_path,
        r#"{"auth_mode":"apikey","OPENAI_API_KEY":"stale"}"#,
    )?;

    let mut config = guest_agent::env::GuestConfig::from_raw(guest_agent::env::GuestConfigRaw {
        run_id: "codex-setup-no-auth".to_string(),
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

    let err = std::fs::symlink_metadata(&auth_path).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
    assert!(!child_home.join(".codex").exists());

    Ok(())
}
