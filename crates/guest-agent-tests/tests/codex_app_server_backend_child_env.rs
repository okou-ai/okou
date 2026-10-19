//! Child-env snapshot coverage for Codex app-server execution.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use guest_agent::run_context::GuestRuntime;
use serde_json::{Value, json};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_uses_runtime_snapshot_and_preserves_large_prompt()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let run_id = "codex-app-server-backend-child-env-test";
    let prompt_prefix = " \n--option-looking user text\n中文 and emoji 🚀\n";
    let prompt = format!(
        "{prompt_prefix}{}",
        "x".repeat(guest_contracts::exec_limits::EXECVE_STRING_MAX_BYTES + 1 - prompt_prefix.len())
    );
    assert_eq!(
        prompt.len(),
        guest_contracts::exec_limits::EXECVE_STRING_MAX_BYTES + 1
    );

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id,
                prompt: &prompt,
                scenario: Some("runtime-turn-complete-without-thread-started"),
                resume_session_id: None,
            },
        )?;
    }

    let runtime_dir = guest_contracts::runtime_paths::run_dir_from_env(run_id)?;
    let user_env_dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&user_env_dir)?;
    let user_env_path = user_env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
    std::fs::write(
        &user_env_path,
        serde_json::to_vec(&json!({
            "CUSTOM_USER_ENV": "visible-to-app-server",
            "OPENAI_MODEL": "gpt-runtime-model",
            "OKOU_API_BACKEND_URL": "https://canonical-user-env.example.invalid"
        }))?,
    )?;
    unsafe {
        std::env::set_var(
            guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
            &user_env_path,
        );
    }

    let runtime = GuestRuntime::from_process_env()?;
    assert!(!user_env_path.exists());
    assert!(!user_env_dir.exists());

    unsafe {
        std::env::set_var("HOME", tmp.path().join("stale-home"));
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            "https://stale-canonical-api.example.invalid",
        );
        std::env::set_var("CUSTOM_USER_ENV", "stale-process-user-env");
    }

    let active_input = guest_agent::active_input::ActiveInputRuntime::new_disabled(
        &runtime.config.run_id,
        &runtime.config.prompt,
    );
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        guest_agent::cli::execute_cli_with_active_input_for_config(
            &SecretMasker::from_config(&runtime.config),
            common::spawn_dummy_heartbeat(),
            runtime.http.clone(),
            active_input.into_writer(),
            &runtime.config,
            &runtime.paths,
        ),
    )
    .await
    .expect("execute_cli should return promptly")?;
    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);
    let stored_session_id = std::fs::read_to_string(runtime.paths.session_id_file())?;
    assert!(!stored_session_id.trim().is_empty());
    assert!(
        session_jsonl_files(&Path::new(&runtime.config.codex_home_dir).join("sessions"))?
            .iter()
            .any(|path| path.to_string_lossy().contains(stored_session_id.trim())),
        "Codex should write history below the launch-owned sessions root"
    );
    let stale_paths = guest_agent::paths::GuestPaths::from_home(
        tmp.path().join("stale-home"),
        &runtime.config.run_id,
    )?;
    assert!(!Path::new(stale_paths.session_id_file()).exists());

    let input_event = find_mock_input_event(Path::new(&runtime.config.codex_home_dir))?;
    assert_eq!(
        input_event.get("text").and_then(Value::as_str),
        Some(prompt.as_str())
    );
    assert_eq!(
        input_event.get("child_env_home").and_then(Value::as_str),
        Some(runtime.config.home_dir.as_str())
    );
    assert_eq!(
        input_event.get("child_env_api_url").and_then(Value::as_str),
        Some(runtime.config.api_url.as_str())
    );
    assert_eq!(
        input_event
            .get("child_env_custom_user_env")
            .and_then(Value::as_str),
        Some("visible-to-app-server")
    );
    assert_eq!(
        input_event
            .get("child_env_openai_model")
            .and_then(Value::as_str),
        Some("gpt-runtime-model")
    );
    for key in [
        "child_env_has_pi_session_id",
        "child_env_has_pi_launch_config",
        "child_env_has_pi_launch_payload_file",
        "child_env_has_pi_model_config",
    ] {
        assert_eq!(input_event.get(key).and_then(Value::as_bool), Some(false));
    }

    Ok(())
}

fn find_mock_input_event(codex_home: &Path) -> Result<Value, Box<dyn std::error::Error>> {
    for path in session_jsonl_files(&codex_home.join("sessions"))? {
        let decoded = std::fs::read_to_string(path)?;
        for line in decoded.lines().filter(|line| !line.is_empty()) {
            let event: Value = serde_json::from_str(line)?;
            if event.get("type").and_then(Value::as_str) == Some("mock.app_server.input") {
                return Ok(event);
            }
        }
    }
    Err("missing mock app-server input event".into())
}

fn session_jsonl_files(root: &Path) -> Result<Vec<PathBuf>, Box<dyn std::error::Error>> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension() == Some(OsStr::new("jsonl")) {
                files.push(path);
            }
        }
    }
    Ok(files)
}
