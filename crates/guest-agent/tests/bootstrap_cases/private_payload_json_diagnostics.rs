//! Malformed private startup files must not disclose values before masking exists.

use crate::common;

use base64::Engine as _;
use guest_contracts::env::{
    CANONICAL_RUN_PAYLOAD_FILE_ENV, CANONICAL_USER_ENV_FILE_ENV, RUN_ID_ENV, RunPayload,
    USER_ENV_FILENAME, USER_ENV_PRIVATE_DIR_NAME,
};
use std::time::Duration;
use tokio::process::Command;

#[tokio::test]
async fn runtime_bootstrap_keeps_private_json_values_out_of_logs()
-> Result<(), Box<dyn std::error::Error>> {
    let private_token = "startup-private-token-must-not-leak";
    let encoded_token = base64::engine::general_purpose::STANDARD.encode(private_token);
    let payload = RunPayload {
        prompt: "startup-private-prompt-must-not-leak".repeat(1024),
        secret_values: encoded_token.clone(),
        ..RunPayload::default()
    };
    let user_env = serde_json::json!({ "SERVICE_TOKEN": private_token });

    for (key, json) in [
        (
            CANONICAL_RUN_PAYLOAD_FILE_ENV,
            serde_json::to_string(&payload)?,
        ),
        (
            CANONICAL_USER_ENV_FILE_ENV,
            serde_json::to_string(&user_env)?,
        ),
    ] {
        let tmp = tempfile::tempdir()?;
        let runtime_dir = tmp.path().join("runtime");
        let run_payload_path = common::write_run_payload_file_for_test(&runtime_dir, &payload)?;
        let user_env_dir = runtime_dir.join(USER_ENV_PRIVATE_DIR_NAME);
        let user_env_path = user_env_dir.join(USER_ENV_FILENAME);
        std::fs::create_dir_all(&user_env_dir)?;
        std::fs::write(&user_env_path, serde_json::to_vec(&user_env)?)?;
        let is_run_payload = key == CANONICAL_RUN_PAYLOAD_FILE_ENV;
        let malformed_path = if is_run_payload {
            &run_payload_path
        } else {
            &user_env_path
        };
        let double_encoded = serde_json::to_string(&json)?;
        std::fs::write(malformed_path, &double_encoded)?;

        let mut command = Command::new(env!("CARGO_BIN_EXE_guest-agent"));
        command
            .env_clear()
            .env(RUN_ID_ENV, "private-json-startup")
            .env("HOME", tmp.path().join("home"))
            .env(
                guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
                &runtime_dir,
            )
            .env(CANONICAL_RUN_PAYLOAD_FILE_ENV, &run_payload_path)
            .env(CANONICAL_USER_ENV_FILE_ENV, &user_env_path);
        if let Some(profile) = std::env::var_os("LLVM_PROFILE_FILE") {
            command.env("LLVM_PROFILE_FILE", profile);
        }
        let output = common::command_output_with_timeout(
            &mut command,
            Duration::from_secs(30),
            "private JSON startup failure did not finish",
        )
        .await?;

        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        let stderr = String::from_utf8(output.stderr)?;
        let system_log = std::fs::read_to_string(guest_contracts::runtime_paths::system_log_file(
            &runtime_dir,
        ))?;
        let expected = format!(
            "Fatal: parse {key} JSON: category=Data line=1 column={}",
            double_encoded.len()
        );
        for log in [&stderr, &system_log] {
            assert!(log.contains(&expected), "missing safe diagnostic for {key}");
            assert!(log.len() < 1024, "unbounded startup diagnostic for {key}");
            for sentinel in [
                "startup-private-prompt-must-not-leak",
                private_token,
                encoded_token.as_str(),
            ] {
                assert!(!log.contains(sentinel), "private value in {key} diagnostic");
            }
        }
        assert!(!run_payload_path.exists());
        assert!(
            !run_payload_path
                .parent()
                .ok_or("missing payload parent")?
                .exists()
        );
        assert_eq!(user_env_path.exists(), is_run_payload);
        assert_eq!(user_env_dir.exists(), is_run_payload);
    }
    Ok(())
}
