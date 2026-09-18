//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

mod common;

use guest_agent::cli;
use guest_agent::masker::SecretMasker;
use guest_agent::run_context::GuestRuntime;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

#[tokio::test]
async fn execute_cli_injects_user_env_without_runner_owned_bootstrap_env()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let cli_env_path = tmp.path().join("cli-env.json");
    let prompt = format!("@write-env-json:{}", cli_env_path.display());
    let user_home = tmp.path().join("user-home");
    let user_home_str = user_home
        .to_str()
        .ok_or("test user HOME path must be UTF-8")?
        .to_string();
    let rejected_config_dir = tmp.path().join("rejected-claude-config");
    let rejected_npm_cache = tmp.path().join("rejected-npm-cache");

    unsafe {
        common::setup_env(&mock, tmp.path(), &prompt, 3, 1)?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            "http://127.0.0.1:1",
        );
        std::env::set_var(
            guest_contracts::env::CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
            "300",
        );
        std::env::set_var(
            process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
            "runner-control-endpoint",
        );
        std::env::set_var("OKOU_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL", "true");
        std::env::set_var("NODE_EXTRA_CA_CERTS", "/rootfs/vm0-proxy-ca.crt");
        std::env::set_var("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt");
        std::env::set_var("REQUESTS_CA_BUNDLE", "/etc/ssl/certs/ca-certificates.crt");
        std::env::set_var("CARGO_HTTP_CAINFO", "/etc/ssl/certs/ca-certificates.crt");
        std::env::set_var("RUSTUP_HOME", "/usr/local/rustup");
        std::env::set_var("NPM_CONFIG_UPDATE_NOTIFIER", "false");
        std::env::set_var("CLI_AGENT_TYPE", "claude-code");
        std::env::set_var(
            guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            "60",
        );
    }

    let run_id = std::env::var(guest_contracts::env::RUN_ID_ENV)?;
    let configured_runtime_dir =
        guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), &run_id)?;
    unsafe {
        std::env::set_var(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            &configured_runtime_dir,
        );
    }
    let runtime_dir = guest_contracts::runtime_paths::run_dir_from_env(&run_id)?;
    let user_env_dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&user_env_dir)?;
    let user_env_path = user_env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
    std::fs::write(
        &user_env_path,
        serde_json::to_vec(&serde_json::json!({
            "CUSTOM_USER_ENV": "visible-to-cli",
            "CUSTOM_FUTURE_KEY": "ordinary-user-value",
            "CUSTOM_PROMPT": "ordinary-user-prompt",
            "CUSTOM_API_TOKEN": "ordinary-user-token",
            "BASH_ENV": "/tmp/user-bash-env",
            "OKOU_API_BACKEND_URL": "https://canonical-user-env.example.invalid",
            "OPENAI_API_KEY": "sk-user",
            "HOME": user_home_str,
            "CLAUDE_CONFIG_DIR": rejected_config_dir,
            "NODE_EXTRA_CA_CERTS": "/tmp/user-ca.pem",
            "npm_config_cache": rejected_npm_cache,
            "NPM_CONFIG_CACHE": "/tmp/rejected-uppercase-npm-cache",
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
    assert_eq!(runtime.config.prompt, prompt);
    assert_eq!(
        runtime.config.agent_execution_timeout,
        Some(std::time::Duration::from_secs(60))
    );
    assert_eq!(runtime.config.stuck_tool_timeout_secs, 300);
    assert_eq!(runtime.config.api_url, "http://127.0.0.1:1");
    assert_eq!(
        runtime.config.post_result_sigterm_grace,
        std::time::Duration::from_secs(3)
    );
    assert_eq!(
        runtime.config.post_result_total_cap,
        std::time::Duration::from_secs(60)
    );
    assert_eq!(
        runtime.config.post_result_sigkill_grace,
        std::time::Duration::from_secs(1)
    );
    assert_eq!(runtime.config.home_dir, user_home_str);
    assert_eq!(
        runtime.config.claude_config_dir,
        tmp.path().join(".claude").to_string_lossy()
    );
    assert_eq!(
        runtime
            .config
            .user_env
            .get("CLAUDE_CONFIG_DIR")
            .map(String::as_str),
        rejected_config_dir.to_str()
    );

    unsafe {
        std::env::set_var("CUSTOM_API_TOKEN", "stale token after runtime construction");
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            "https://stale-canonical-api.example.invalid",
        );
        std::env::set_var("HOME", tmp.path().join("stale-home"));
        for key in [
            guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
            guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
        ] {
            std::env::set_var(key, "/stale/private-file-pointer");
        }
        for key in [
            guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
            guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
            guest_contracts::env::CANONICAL_WORKSPACE_REUSE_RESULT_ENV,
            guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV,
            guest_contracts::env::CANONICAL_API_START_TIME_ENV,
        ] {
            std::env::set_var(key, "stale-run-metadata");
        }
    }

    let active_input = guest_agent::active_input::ActiveInputRuntime::new_disabled(
        &runtime.config.run_id,
        &runtime.config.prompt,
    );
    let result = cli::execute_cli_with_active_input_for_config(
        &SecretMasker::from_raw(""),
        common::spawn_dummy_heartbeat(),
        runtime.http.clone(),
        active_input.into_writer(),
        &runtime.config,
        &runtime.paths,
    )
    .await?;

    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    let cli_env: BTreeMap<String, String> = serde_json::from_slice(&std::fs::read(&cli_env_path)?)?;

    assert_eq!(
        cli_env.get("CUSTOM_USER_ENV").map(String::as_str),
        Some("visible-to-cli")
    );
    for (key, expected_value) in [
        ("CUSTOM_FUTURE_KEY", "ordinary-user-value"),
        ("CUSTOM_PROMPT", "ordinary-user-prompt"),
        ("CUSTOM_API_TOKEN", "ordinary-user-token"),
    ] {
        assert_eq!(cli_env.get(key).map(String::as_str), Some(expected_value));
    }
    assert_eq!(
        cli_env.get("BASH_ENV").map(String::as_str),
        Some("/tmp/user-bash-env")
    );
    assert_eq!(
        cli_env.get("OPENAI_API_KEY").map(String::as_str),
        Some("sk-user")
    );
    assert_eq!(
        cli_env
            .get(guest_contracts::env::CANONICAL_API_URL_ENV)
            .map(String::as_str),
        Some("http://127.0.0.1:1")
    );
    assert_eq!(
        cli_env.get("HOME").map(String::as_str),
        Some(user_home_str.as_str())
    );
    assert_eq!(
        cli_env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
        Some(runtime.config.claude_config_dir.as_str())
    );
    assert_eq!(
        cli_env.get("NODE_EXTRA_CA_CERTS").map(String::as_str),
        Some("/tmp/user-ca.pem")
    );
    assert_eq!(
        cli_env.get("SSL_CERT_FILE").map(String::as_str),
        Some("/etc/ssl/certs/ca-certificates.crt")
    );
    assert_eq!(
        cli_env.get("REQUESTS_CA_BUNDLE").map(String::as_str),
        Some("/etc/ssl/certs/ca-certificates.crt")
    );
    assert_eq!(
        cli_env.get("CARGO_HTTP_CAINFO").map(String::as_str),
        Some("/etc/ssl/certs/ca-certificates.crt")
    );
    assert_eq!(
        cli_env.get("RUSTUP_HOME").map(String::as_str),
        Some("/usr/local/rustup")
    );
    assert_eq!(
        cli_env
            .get("NPM_CONFIG_UPDATE_NOTIFIER")
            .map(String::as_str),
        Some("false")
    );
    assert!(cli_env.contains_key("PATH"));
    assert_eq!(
        cli_env.get("npm_config_cache").map(String::as_str),
        Some("/home/user/workspace/.vm0/cache/npm")
    );
    assert!(!cli_env.contains_key("NPM_CONFIG_CACHE"));

    for key in [
        guest_contracts::env::CANONICAL_API_TOKEN_ENV,
        guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV,
    ] {
        assert!(
            !cli_env.contains_key(key),
            "Claude child env contains sensitive bootstrap key {key}"
        );
    }
    for key in [
        guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
        guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
    ] {
        assert!(
            !cli_env.contains_key(key),
            "Claude child env contains {key}"
        );
    }
    assert!(!cli_env.contains_key(guest_contracts::env::RUN_ID_ENV));
    for key in [
        guest_contracts::env::PI_SESSION_ID_ENV,
        guest_contracts::env::PI_LAUNCH_CONFIG_ENV,
        guest_contracts::env::PI_LAUNCH_PAYLOAD_FILE_ENV,
        guest_contracts::env::PI_MODEL_CONFIG_ENV,
    ] {
        assert!(
            !cli_env.contains_key(key),
            "Claude child env contains {key}"
        );
    }
    for key in [
        guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
        guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
        guest_contracts::env::CANONICAL_WORKSPACE_REUSE_RESULT_ENV,
        guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV,
        guest_contracts::env::CANONICAL_API_START_TIME_ENV,
    ] {
        assert!(
            !cli_env.contains_key(key),
            "Claude child env contains run-metadata bootstrap key {key}"
        );
    }
    for key in [
        guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
        guest_contracts::env::CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
        guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
        guest_contracts::env::CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
        guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
    ] {
        assert!(
            !cli_env.contains_key(key),
            "Claude child env contains {key}"
        );
    }
    assert!(!cli_env.contains_key("CLI_AGENT_TYPE"));
    assert!(
        !cli_env.contains_key(process_control_ipc::CANONICAL_BOOTSTRAP_ENV),
        "Claude child env contains the process-control endpoint"
    );
    assert!(!cli_env.contains_key("OKOU_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL"));
    for key in [
        guest_contracts::process_containment::CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
        guest_contracts::process_containment::CANONICAL_TOOL_CGROUP_PROCS_ENV,
    ] {
        assert!(
            !cli_env.contains_key(key),
            "Claude child env contains {key}"
        );
    }

    let session_id = std::fs::read_to_string(runtime.paths.session_id_file())?;
    let canonical_history = Path::new(&runtime.config.claude_config_dir)
        .join("projects/-home-user-workspace")
        .join(format!("{}.jsonl", session_id.trim()));
    assert!(canonical_history.exists());
    assert!(!common::claude_history_path_for_home(&user_home, session_id.trim()).exists());
    assert!(
        !rejected_config_dir
            .join("projects/-home-user-workspace")
            .join(format!("{}.jsonl", session_id.trim()))
            .exists()
    );

    unsafe {
        // The remaining cases construct fresh runtimes and install their own
        // canonical-only snapshot through `common::setup_env`.
        std::env::remove_var(guest_contracts::env::CANONICAL_API_URL_ENV);
    }
    assert_user_runtime_env_reaches_claude(
        &mock,
        &tmp.path().join("relative-home-case"),
        "relative-home",
    )
    .await?;
    assert_user_runtime_env_reaches_claude(&mock, &tmp.path().join("empty-home-case"), "").await?;

    Ok(())
}

async fn assert_user_runtime_env_reaches_claude(
    mock: &Path,
    workdir: &Path,
    home: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let claude_config_dir = workdir.join(".claude");
    let rejected_config_dir = workdir.join("rejected-claude-config");
    let instructions_path = claude_config_dir.join("CLAUDE.md");
    let skill_path = claude_config_dir.join("skills/test-skill/SKILL.md");
    let memory_path = claude_config_dir
        .join("projects/-home-user-workspace/memory")
        .join("MEMORY.md");
    for path in [&instructions_path, &skill_path, &memory_path] {
        std::fs::create_dir_all(path.parent().ok_or("managed file must have a parent")?)?;
        std::fs::write(path, "managed")?;
    }

    let observed_home = workdir.join("observed-home");
    let observed_config_dir = workdir.join("observed-claude-config-dir");
    let observed_rustup_home = workdir.join("observed-rustup-home");
    let user_rustup_home = workdir.join("user-rustup");
    let prompt = format!(
        "test -f \"$CLAUDE_CONFIG_DIR/CLAUDE.md\" && test -f \"$CLAUDE_CONFIG_DIR/skills/test-skill/SKILL.md\" && test -f \"$CLAUDE_CONFIG_DIR/projects/-home-user-workspace/memory/MEMORY.md\" && printf '%s' \"$HOME\" > {} && printf '%s' \"$CLAUDE_CONFIG_DIR\" > {} && printf '%s' \"$RUSTUP_HOME\" > {}",
        observed_home.display(),
        observed_config_dir.display(),
        observed_rustup_home.display(),
    );

    unsafe {
        common::setup_env(mock, workdir, &prompt, 3, 1)?;
    }
    let run_id = std::env::var(guest_contracts::env::RUN_ID_ENV)?;
    let runtime_dir = guest_contracts::runtime_paths::run_dir_from_env(&run_id)?;
    let user_env = HashMap::from([
        ("HOME".to_string(), home.to_string()),
        (
            "RUSTUP_HOME".to_string(),
            user_rustup_home.to_string_lossy().into_owned(),
        ),
        (
            "CLAUDE_CONFIG_DIR".to_string(),
            rejected_config_dir.to_string_lossy().into_owned(),
        ),
    ]);
    unsafe {
        common::set_user_env_file_env_for_test(&runtime_dir, &user_env)?;
    }

    let runtime = GuestRuntime::from_process_env()?;
    let active_input = guest_agent::active_input::ActiveInputRuntime::new_disabled(
        &runtime.config.run_id,
        &runtime.config.prompt,
    );
    let result = cli::execute_cli_with_active_input_for_config(
        &SecretMasker::from_raw(""),
        common::spawn_dummy_heartbeat(),
        runtime.http.clone(),
        active_input.into_writer(),
        &runtime.config,
        &runtime.paths,
    )
    .await?;

    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert_eq!(std::fs::read_to_string(observed_home)?, home);
    assert_eq!(
        std::fs::read_to_string(observed_rustup_home)?,
        user_rustup_home.to_string_lossy()
    );
    assert_eq!(
        std::fs::read_to_string(observed_config_dir)?,
        claude_config_dir.to_string_lossy()
    );

    let session_id = std::fs::read_to_string(runtime.paths.session_id_file())?;
    let history_path = claude_config_dir
        .join("projects/-home-user-workspace")
        .join(format!("{}.jsonl", session_id.trim()));
    assert!(history_path.exists());
    assert!(
        !rejected_config_dir
            .join("projects/-home-user-workspace")
            .join(format!("{}.jsonl", session_id.trim()))
            .exists()
    );
    Ok(())
}
