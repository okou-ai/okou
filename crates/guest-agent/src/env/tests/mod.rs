use super::*;

const TEST_DEFAULT_SECS: u64 = 10;
const TEST_MAX_SECS: u64 = 60;

fn raw_config_fixture() -> GuestConfigRaw {
    GuestConfigRaw {
        run_id: "run-123".to_string(),
        home: Some("/home/vm0".to_string()),
        ..GuestConfigRaw::default()
    }
}

fn write_user_env_fixture(json: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp
        .path()
        .join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join(guest_contracts::env::USER_ENV_FILENAME);
    std::fs::write(&path, json).unwrap();
    (tmp, path)
}

fn write_run_payload_fixture(
    runtime_dir: &Path,
    payload: &guest_contracts::env::RunPayload,
) -> std::path::PathBuf {
    let dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::write(&path, serde_json::to_vec(payload).unwrap()).unwrap();
    path
}

fn raw_config_fixture_with_run_payload(
    payload: &guest_contracts::env::RunPayload,
) -> (tempfile::TempDir, GuestConfigRaw) {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_dir = tmp.path().join("runtime");
    let run_payload_file = write_run_payload_fixture(&runtime_dir, payload);
    let raw = GuestConfigRaw {
        run_payload_file: run_payload_file.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(runtime_dir),
        ..raw_config_fixture()
    };
    (tmp, raw)
}

fn raw_config_fixture_with_default_run_payload() -> (tempfile::TempDir, GuestConfigRaw) {
    raw_config_fixture_with_run_payload(&guest_contracts::env::RunPayload::default())
}

#[test]
fn bounded_duration_secs_value_defaults_when_unset() {
    assert_eq!(
        bounded_duration_secs_value_or("TEST_TIMEOUT", None, TEST_DEFAULT_SECS, TEST_MAX_SECS),
        Duration::from_secs(TEST_DEFAULT_SECS)
    );
}

#[test]
fn bounded_duration_secs_value_defaults_when_invalid() {
    assert_eq!(
        bounded_duration_secs_value_or(
            "TEST_TIMEOUT",
            Some("not-a-number"),
            TEST_DEFAULT_SECS,
            TEST_MAX_SECS,
        ),
        Duration::from_secs(TEST_DEFAULT_SECS)
    );
}

#[test]
fn bounded_duration_secs_value_defaults_when_above_max() {
    assert_eq!(
        bounded_duration_secs_value_or(
            "TEST_TIMEOUT",
            Some("61"),
            TEST_DEFAULT_SECS,
            TEST_MAX_SECS,
        ),
        Duration::from_secs(TEST_DEFAULT_SECS)
    );
}

#[test]
fn bounded_duration_secs_value_accepts_zero() {
    assert_eq!(
        bounded_duration_secs_value_or("TEST_TIMEOUT", Some("0"), TEST_DEFAULT_SECS, TEST_MAX_SECS,),
        Duration::ZERO
    );
}

#[test]
fn bounded_duration_secs_value_accepts_value_at_max() {
    assert_eq!(
        bounded_duration_secs_value_or(
            "TEST_TIMEOUT",
            Some("60"),
            TEST_DEFAULT_SECS,
            TEST_MAX_SECS,
        ),
        Duration::from_secs(TEST_MAX_SECS)
    );
}

#[test]
fn agent_execution_timeout_is_optional_and_strict() {
    assert_eq!(
        optional_positive_duration_secs(AGENT_EXECUTION_TIMEOUT_DIAGNOSTIC, None,).unwrap(),
        None
    );
    assert_eq!(
        optional_positive_duration_secs(AGENT_EXECUTION_TIMEOUT_DIAGNOSTIC, Some("7200"),).unwrap(),
        Some(Duration::from_secs(7200))
    );

    for invalid in ["0", "-1", "not-a-number", "18446744073709551615"] {
        let error =
            optional_positive_duration_secs(AGENT_EXECUTION_TIMEOUT_DIAGNOSTIC, Some(invalid))
                .unwrap_err();
        assert!(
            error.contains(AGENT_EXECUTION_TIMEOUT_DIAGNOSTIC),
            "{error}"
        );
        assert!(
            !error.contains(guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV),
            "{error}"
        );
    }
}

#[test]
fn framework_from_cli_agent_type_accepts_known_values_and_defaults_unknown() {
    assert_eq!(framework_from_cli_agent_type(""), Framework::ClaudeCode);
    assert_eq!(
        framework_from_cli_agent_type("claude-code"),
        Framework::ClaudeCode
    );
    assert_eq!(framework_from_cli_agent_type("codex"), Framework::Codex);
    assert_eq!(framework_from_cli_agent_type("pi"), Framework::Pi);
    assert_eq!(
        framework_from_cli_agent_type("unexpected"),
        Framework::ClaudeCode
    );
}

#[test]
fn guest_config_preserves_unknown_cli_agent_type_while_falling_back() {
    let (_tmp, raw) =
        raw_config_fixture_with_run_payload(&guest_contracts::env::RunPayload::default());
    let raw = GuestConfigRaw {
        cli_agent_type: "custom-agent".to_string(),
        ..raw
    };

    let config = GuestConfig::from_raw(raw).unwrap();

    assert_eq!(config.cli_agent_type, "custom-agent");
    assert_eq!(config.framework, Framework::ClaudeCode);
}

#[test]
fn guest_config_from_raw_builds_owned_config_without_process_env_mutation() {
    let payload = guest_contracts::env::RunPayload {
        prompt: "hello".to_string(),
        append_system_prompt: "extra system".to_string(),
        native_continuation: String::new(),
        secret_values: "encoded-secret".to_string(),
        disallowed_tools: "WebFetch".to_string(),
        tools: "Bash".to_string(),
        settings: "{}".to_string(),
        artifacts:
            r#"[{"name":"artifact","mountPath":"/mnt/a","storageId":"storage","versionId":"v1"}]"#
                .to_string(),
        ..guest_contracts::env::RunPayload::default()
    };
    let (_tmp, raw) = raw_config_fixture_with_run_payload(&payload);
    let raw = GuestConfigRaw {
        api_url: "https://api.example.test".to_string(),
        api_token: String::new(),
        sandbox_id: "sandbox-1".to_string(),
        sandbox_startup_path: "sandbox".to_string(),
        vercel_bypass: "bypass".to_string(),
        resume_session_id: "session-1".to_string(),
        api_start_time: "123".to_string(),
        agent_execution_timeout_secs: "11".to_string(),
        use_mock_claude: "true".to_string(),
        cli_agent_type: "codex".to_string(),
        use_mock_codex: "1".to_string(),
        stuck_tool_timeout_secs: "7".to_string(),
        post_result_sigterm_grace_secs: "8".to_string(),
        post_result_total_cap_secs: "9".to_string(),
        post_result_sigkill_grace_secs: "10".to_string(),
        ..raw
    };

    let config = GuestConfig::from_raw(raw).unwrap();

    assert_eq!(config.run_id, "run-123");
    assert_eq!(config.api_url, "https://api.example.test");
    assert_eq!(config.api_token, "");
    assert_eq!(config.sandbox_id, "sandbox-1");
    assert_eq!(
        config.sandbox_startup_path,
        Some(guest_contracts::sandbox_startup::SandboxStartupPath::Sandbox)
    );
    assert_eq!(config.prompt, "hello");
    assert_eq!(config.append_system_prompt, "extra system");
    assert_eq!(config.vercel_bypass, "bypass");
    assert_eq!(config.resume_session_id, "session-1");
    assert_eq!(config.api_start_time, "123");
    assert_eq!(
        config.agent_execution_timeout,
        Some(Duration::from_secs(11))
    );
    assert_eq!(config.secret_values, "encoded-secret");
    assert_eq!(config.disallowed_tools, "WebFetch");
    assert_eq!(config.tools, "Bash");
    assert_eq!(config.settings, "{}");
    assert!(config.use_mock_claude);
    assert_eq!(config.mock_claude_path, DEFAULT_MOCK_CLAUDE_PATH);
    assert_eq!(config.cli_agent_type, "codex");
    assert_eq!(config.framework, Framework::Codex);
    assert!(config.use_mock_codex);
    assert_eq!(config.mock_codex_path, DEFAULT_MOCK_CODEX_PATH);
    assert_eq!(config.home_dir, "/home/vm0");
    assert_eq!(config.claude_config_dir, CANONICAL_CLAUDE_CONFIG_DIR);
    assert_eq!(config.codex_home_dir, CANONICAL_CODEX_HOME_DIR);
    assert_eq!(config.stuck_tool_timeout_secs, 7);
    assert_eq!(config.post_result_sigterm_grace, Duration::from_secs(8));
    assert_eq!(config.post_result_total_cap, Duration::from_secs(9));
    assert_eq!(config.post_result_sigkill_grace, Duration::from_secs(10));
    let artifact = config.artifacts.first().unwrap();
    assert_eq!(artifact.name, "artifact");
    assert_eq!(artifact.mount_path, "/mnt/a");
    assert_eq!(artifact.storage_id, "storage");
    assert_eq!(artifact.version_id, "v1");
}

#[test]
fn guest_config_from_raw_loads_user_env_and_removes_private_file() {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_dir = tmp.path().join("runtime");
    let user_env_dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&user_env_dir).unwrap();
    let user_env_path = user_env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
    std::fs::write(
        &user_env_path,
        r#"{"HOME":"/home/from-user-env","OPENAI_MODEL":"gpt-test"}"#,
    )
    .unwrap();
    let run_payload_file =
        write_run_payload_fixture(&runtime_dir, &guest_contracts::env::RunPayload::default());

    let raw = GuestConfigRaw {
        user_env_file: user_env_path.to_string_lossy().into_owned(),
        run_payload_file: run_payload_file.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(runtime_dir),
        home: Some("/home/from-process".to_string()),
        ..raw_config_fixture()
    };

    let config = GuestConfig::from_raw(raw).unwrap();

    assert_eq!(config.home_dir, "/home/from-user-env");
    assert_eq!(config.claude_config_dir, CANONICAL_CLAUDE_CONFIG_DIR);
    assert_eq!(config.codex_home_dir, CANONICAL_CODEX_HOME_DIR);
    assert_eq!(
        config.user_env.get("OPENAI_MODEL").map(String::as_str),
        Some("gpt-test")
    );
    assert!(!user_env_path.exists());
    assert!(!user_env_dir.exists());
}

#[cfg(debug_assertions)]
#[test]
fn guest_config_from_raw_uses_captured_test_claude_config_dir() {
    let (_tmp, raw) = raw_config_fixture_with_default_run_payload();
    let raw = GuestConfigRaw {
        test_claude_config_dir: Some(PathBuf::from("/tmp/captured-claude-config")),
        ..raw
    };

    let config = GuestConfig::from_raw(raw).unwrap();

    assert_eq!(config.claude_config_dir, "/tmp/captured-claude-config");
}

#[cfg(debug_assertions)]
#[test]
fn guest_config_from_raw_uses_captured_test_codex_home() {
    let (_tmp, raw) = raw_config_fixture_with_default_run_payload();
    let raw = GuestConfigRaw {
        test_codex_home_dir: Some(PathBuf::from("/tmp/captured-codex-home")),
        ..raw
    };

    let config = GuestConfig::from_raw(raw).unwrap();

    assert_eq!(config.codex_home_dir, "/tmp/captured-codex-home");
}

#[test]
fn guest_config_from_raw_loads_run_payload_and_removes_private_file() {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_dir = tmp.path().join("runtime");
    let payload = guest_contracts::env::RunPayload {
        prompt: "payload prompt".to_string(),
        append_system_prompt: "payload system".to_string(),
        native_continuation: String::new(),
        secret_values: "payload-secret".to_string(),
        disallowed_tools: "WebFetch".to_string(),
        tools: "Bash".to_string(),
        settings: "{}".to_string(),
        artifacts:
            r#"[{"name":"artifact","mountPath":"/mnt/a","storageId":"storage","versionId":"v1"}]"#
                .to_string(),
        feature_flags: r#"{"flag":true}"#.to_string(),
        codex_runtime_config: r#"{"providerId":"openrouter-codex"}"#.to_string(),
        pi_launch_config: r#"{"schemaVersion":2}"#.to_string(),
        pi_model_config: r#"{"provider":"openrouter"}"#.to_string(),
        pi_session_id: "22222222-2222-4222-8222-222222222222".to_string(),
    };
    let path = write_run_payload_fixture(&runtime_dir, &payload);
    let parent = path.parent().unwrap().to_path_buf();

    let raw = GuestConfigRaw {
        run_payload_file: path.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(runtime_dir),
        ..raw_config_fixture()
    };

    let config = GuestConfig::from_raw(raw).unwrap();

    assert_eq!(config.prompt, "payload prompt");
    assert_eq!(config.append_system_prompt, "payload system");
    assert_eq!(config.secret_values, "payload-secret");
    assert_eq!(config.disallowed_tools, "WebFetch");
    assert_eq!(config.tools, "Bash");
    assert_eq!(config.settings, "{}");
    assert_eq!(config.artifacts.len(), 1);
    assert_eq!(config.feature_flags.get("flag"), Some(&true));
    assert_eq!(
        config.codex_runtime_config,
        r#"{"providerId":"openrouter-codex"}"#
    );
    assert_eq!(config.pi_launch_config, r#"{"schemaVersion":2}"#);
    assert_eq!(config.pi_model_config, r#"{"provider":"openrouter"}"#);
    assert_eq!(config.pi_session_id, "22222222-2222-4222-8222-222222222222");
    assert!(!path.exists());
    assert!(!parent.exists());
}

#[test]
fn guest_config_from_raw_rejects_run_payload_outside_runtime_dir_without_path_leak() {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_dir = tmp.path().join("runtime");
    let unexpected = tmp
        .path()
        .join("other")
        .join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME)
        .join(guest_contracts::env::RUN_PAYLOAD_FILENAME);

    let raw = GuestConfigRaw {
        run_payload_file: unexpected.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(runtime_dir),
        ..raw_config_fixture()
    };

    let err = GuestConfig::from_raw(raw).err().unwrap();

    assert!(err.contains("run-payload/payload.json"));
    assert!(!err.contains(unexpected.to_string_lossy().as_ref()));
}

#[test]
fn load_run_payload_from_path_rejects_nul_without_value_leak() {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_dir = tmp.path().join("runtime");
    let payload = guest_contracts::env::RunPayload {
        prompt: "secret\0prompt".to_string(),
        ..guest_contracts::env::RunPayload::default()
    };
    let path = write_run_payload_fixture(&runtime_dir, &payload);
    let parent = path.parent().unwrap().to_path_buf();

    let err = load_run_payload_from_path(&path).unwrap_err();

    assert!(err.contains(guest_contracts::env::PROMPT_RUN_PAYLOAD_FIELD));
    assert!(!err.contains("secret"));
    assert!(!err.contains("prompt"));
    assert!(!path.exists());
    assert!(!parent.exists());
}

#[test]
fn load_run_payload_from_path_removes_file_before_parse_error() {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_dir = tmp.path().join("runtime");
    let dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::write(&path, r#"{"prompt":"secret""#).unwrap();

    let err = load_run_payload_from_path(&path).unwrap_err();

    assert!(err.contains("parse"));
    assert!(!err.contains("secret"));
    assert!(!path.exists());
    assert!(!dir.exists());
}

#[test]
fn guest_config_from_raw_validates_user_env_with_runtime_home_when_home_string_missing() {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_home = tmp.path().join("home");
    let runtime_dir =
        guest_contracts::runtime_paths::run_dir_for_home(&runtime_home, "run-123").unwrap();
    let user_env_dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&user_env_dir).unwrap();
    let user_env_path = user_env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
    std::fs::write(
        &user_env_path,
        r#"{"HOME":"/home/from-user-env","OPENAI_MODEL":"gpt-runtime-home"}"#,
    )
    .unwrap();
    let run_payload_file =
        write_run_payload_fixture(&runtime_dir, &guest_contracts::env::RunPayload::default());

    let raw = GuestConfigRaw {
        user_env_file: user_env_path.to_string_lossy().into_owned(),
        run_payload_file: run_payload_file.to_string_lossy().into_owned(),
        home: None,
        runtime_home: Some(runtime_home),
        ..raw_config_fixture()
    };

    let config = GuestConfig::from_raw(raw).unwrap();

    assert_eq!(config.home_dir, "/home/from-user-env");
    assert_eq!(config.claude_config_dir, CANONICAL_CLAUDE_CONFIG_DIR);
    assert_eq!(
        config.user_env.get("OPENAI_MODEL").map(String::as_str),
        Some("gpt-runtime-home")
    );
    assert!(!user_env_path.exists());
    assert!(!user_env_dir.exists());
}

#[test]
fn guest_config_from_raw_preserves_empty_process_home() {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_dir = tmp.path().join("runtime");
    let run_payload_file =
        write_run_payload_fixture(&runtime_dir, &guest_contracts::env::RunPayload::default());
    let raw = GuestConfigRaw {
        home: Some(String::new()),
        run_payload_file: run_payload_file.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(runtime_dir),
        ..raw_config_fixture()
    };

    let config = GuestConfig::from_raw(raw).unwrap();

    assert_eq!(config.home_dir, "");
    assert_eq!(config.claude_config_dir, CANONICAL_CLAUDE_CONFIG_DIR);
    assert_eq!(config.codex_home_dir, CANONICAL_CODEX_HOME_DIR);
}

#[test]
fn guest_config_from_raw_preserves_explicit_empty_mock_paths() {
    let (_tmp, raw) = raw_config_fixture_with_default_run_payload();
    let raw = GuestConfigRaw {
        mock_claude_path: Some(String::new()),
        mock_codex_path: Some(String::new()),
        ..raw
    };

    let config = GuestConfig::from_raw(raw).unwrap();

    assert_eq!(config.mock_claude_path, "");
    assert_eq!(config.mock_codex_path, "");
}

#[test]
fn guest_config_from_raw_reports_invalid_artifacts() {
    let payload = guest_contracts::env::RunPayload {
        artifacts: "{not-json".to_string(),
        ..guest_contracts::env::RunPayload::default()
    };
    let (_tmp, raw) = raw_config_fixture_with_run_payload(&payload);

    let err = GuestConfig::from_raw(raw).err().unwrap();

    assert!(err.contains(guest_contracts::env::ARTIFACTS_RUN_PAYLOAD_FIELD));
}

#[test]
fn guest_config_from_raw_rejects_user_env_outside_runtime_dir_without_path_leak() {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_dir = tmp.path().join("runtime");
    let unexpected = tmp
        .path()
        .join("other")
        .join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME)
        .join(guest_contracts::env::USER_ENV_FILENAME);
    let run_payload_file =
        write_run_payload_fixture(&runtime_dir, &guest_contracts::env::RunPayload::default());

    let raw = GuestConfigRaw {
        user_env_file: unexpected.to_string_lossy().into_owned(),
        run_payload_file: run_payload_file.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(runtime_dir),
        ..raw_config_fixture()
    };

    let err = GuestConfig::from_raw(raw).err().unwrap();

    assert!(err.contains("user-env/env.json"));
    assert!(!err.contains(unexpected.to_string_lossy().as_ref()));
}

#[test]
fn load_user_env_from_path_loads_provider_values_and_removes_file() {
    let (_tmp, path) = write_user_env_fixture(
        r#"{"OPENAI_API_KEY":"sk-test","OPENAI_MODEL":"gpt-test","CHATGPT_ACCOUNT_ID":"acct"}"#,
    );
    let parent = path.parent().unwrap().to_path_buf();

    let user_env = load_user_env_from_path(&path).unwrap();

    assert_eq!(user_env.get("OPENAI_API_KEY").unwrap(), "sk-test");
    assert_eq!(user_env.get("OPENAI_MODEL").unwrap(), "gpt-test");
    assert_eq!(user_env.get("CHATGPT_ACCOUNT_ID").unwrap(), "acct");
    assert!(!path.exists());
    assert!(!parent.exists());
}

#[test]
fn load_user_env_from_path_rejects_invalid_key_without_value_leak() {
    let (_tmp, path) =
        write_user_env_fixture(r#"{"BAD-KEY":"secret-value","OPENAI_API_KEY":"sk-test"}"#);
    let parent = path.parent().unwrap().to_path_buf();

    let err = load_user_env_from_path(&path).unwrap_err();

    assert!(err.contains("BAD-KEY"));
    assert!(!err.contains("secret-value"));
    assert!(!err.contains("sk-test"));
    assert!(!path.exists());
    assert!(!parent.exists());
}

#[test]
fn load_user_env_from_path_removes_file_before_parse_error() {
    let (_tmp, path) = write_user_env_fixture(r#"{"OPENAI_API_KEY":"sk-test""#);
    let parent = path.parent().unwrap().to_path_buf();

    let err = load_user_env_from_path(&path).unwrap_err();

    assert!(err.contains("parse"));
    assert!(!err.contains("sk-test"));
    assert!(!path.exists());
    assert!(!parent.exists());
}

#[test]
fn load_user_env_from_path_keeps_unexpected_parent_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("unexpected-user-env-dir");
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join(guest_contracts::env::USER_ENV_FILENAME);
    std::fs::write(&path, r#"{"OPENAI_MODEL":"gpt-test"}"#).unwrap();

    let user_env = load_user_env_from_path(&path).unwrap();

    assert_eq!(user_env.get("OPENAI_MODEL").unwrap(), "gpt-test");
    assert!(!path.exists());
    assert!(dir.exists());
}

#[test]
fn load_run_payload_from_path_keeps_unexpected_parent_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("unexpected-run-payload-dir");
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    let payload = guest_contracts::env::RunPayload {
        prompt: "payload prompt".to_string(),
        ..guest_contracts::env::RunPayload::default()
    };
    std::fs::write(&path, serde_json::to_vec(&payload).unwrap()).unwrap();

    let loaded = load_run_payload_from_path(&path).unwrap();

    assert_eq!(loaded.prompt, "payload prompt");
    assert!(!path.exists());
    assert!(dir.exists());
}

#[test]
fn validate_user_env_file_path_rejects_unexpected_path() {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_dir = tmp.path().join("runtime");
    let unexpected = tmp
        .path()
        .join("other")
        .join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME)
        .join(guest_contracts::env::USER_ENV_FILENAME);

    let err = validate_private_runtime_file_path_for_runtime(
        &unexpected,
        &runtime_dir,
        USER_ENV_PRIVATE_FILE,
    )
    .unwrap_err();

    assert!(err.contains("user-env/env.json"));
    assert!(!err.contains(unexpected.to_string_lossy().as_ref()));
    assert!(
        validate_private_runtime_file_path_for_runtime(
            &private_runtime_file_path_for_runtime(&runtime_dir, USER_ENV_PRIVATE_FILE),
            &runtime_dir,
            USER_ENV_PRIVATE_FILE,
        )
        .is_ok()
    );
}

#[test]
fn guest_runtime_dir_for_user_env_returns_error_when_run_id_missing() {
    let err = guest_runtime_dir_for_private_file_values(
        USER_ENV_FILE_ENV_KEY,
        "",
        None,
        Some(Path::new("/home/vm0")),
    )
    .unwrap_err();

    assert!(err.contains("OKOU_RUN_ID is required"));
}

#[test]
fn load_user_env_from_path_rejects_nul_value_without_value_leak() {
    let (_tmp, path) = write_user_env_fixture("{\"OPENAI_API_KEY\":\"sk-test\\u0000secret\"}");
    let parent = path.parent().unwrap().to_path_buf();

    let err = load_user_env_from_path(&path).unwrap_err();

    assert!(err.contains("OPENAI_API_KEY"));
    assert!(!err.contains("sk-test"));
    assert!(!err.contains("secret"));
    assert!(!path.exists());
    assert!(!parent.exists());
}
