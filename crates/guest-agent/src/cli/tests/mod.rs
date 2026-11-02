use super::termination::{CliTerminationRuntime, PostResultCleanupPolicy};
use super::{
    CliExitObservation, CliFailureDiagnostic, CliRuntimeConfig, child_env,
    claude_initial_prompt_frame, cli_exit_summary_from_status, command, exec_boundary,
    pi_child_env_values, record_cli_exit, select_failure_diagnostic, set_cli_current_dir,
    with_carried_failure_reason, write_pi_launch_payload_file,
};
use crate::active_input::ActiveInputRuntime;
use crate::paths;
use crate::session_metadata::SessionHistoryLaunchSource;
use crate::{constants, env};
use api_contracts::generated::types::runners::runs::CodexRuntimeConfig;
use guest_contracts::diagnostics::{FailureDetailSource, FailureReason};
use std::borrow::Cow;
use std::collections::HashMap;
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::time::{Duration, Instant};

struct SystemLogOverrideGuard;

impl SystemLogOverrideGuard {
    fn set(path: &Path) -> Self {
        guest_telemetry::log::set_system_log_file(path);
        Self
    }
}

impl Drop for SystemLogOverrideGuard {
    fn drop(&mut self) {
        guest_telemetry::log::clear_system_log_file();
    }
}

fn guest_config_for_agent_context(user_env: HashMap<String, String>) -> env::GuestConfig {
    env::GuestConfig {
        sandbox_startup_path: None,
        run_id: "run-okou-env-test".to_string(),
        api_url: "https://runner.example".to_string(),
        api_token: "test-token".to_string(),
        sandbox_id: String::new(),
        prompt: "prompt".to_string(),
        append_system_prompt: String::new(),
        native_continuation: None,
        vercel_bypass: String::new(),
        resume_session_id: String::new(),
        api_start_time: String::new(),
        agent_execution_timeout: None,
        secret_values: String::new(),
        disallowed_tools: String::new(),
        tools: String::new(),
        settings: String::new(),
        use_mock_claude: false,
        mock_claude_path: String::new(),
        cli_agent_type: "codex".to_string(),
        framework: env::Framework::Codex,
        user_env,
        use_mock_codex: false,
        mock_codex_path: String::new(),
        home_dir: "/tmp/home".to_string(),
        claude_config_dir: "/tmp/claude-config".to_string(),
        codex_home_dir: "/tmp/codex-home".to_string(),
        artifacts: Vec::new(),
        feature_flags: HashMap::new(),
        codex_runtime_config: String::new(),
        pi_launch_config: String::new(),
        pi_model_config: String::new(),
        pi_session_id: String::new(),
        #[cfg(debug_assertions)]
        test_pi_cli_path: None,
        stuck_tool_timeout_secs: constants::STUCK_TOOL_TIMEOUT_SECS,
        post_result_sigterm_grace: Duration::from_secs(constants::POST_RESULT_SIGTERM_GRACE_SECS),
        post_result_total_cap: Duration::from_secs(constants::POST_RESULT_TOTAL_CAP_SECS),
        post_result_sigkill_grace: Duration::from_secs(constants::POST_RESULT_SIGKILL_GRACE_SECS),
    }
}

fn assert_codex_service_tier_fast_mode(
    user_env: HashMap<String, String>,
    expected_fast_mode: bool,
) {
    let config = guest_config_for_agent_context(user_env);
    let paths =
        crate::paths::GuestPaths::from_runtime_dir("/tmp/codex-service-tier-resolution-test");
    let runtime = CliRuntimeConfig::from_config(&config, &paths, Instant::now()).unwrap();

    assert_eq!(runtime.codex_fast_mode, expected_fast_mode);
    let startup_configs = runtime.codex_startup_config_overrides();
    for config in super::CODEX_FAST_MODE_STARTUP_CONFIGS {
        assert_eq!(
            startup_configs.contains(&config.to_string()),
            expected_fast_mode
        );
    }
}

fn runtime_for_command_test<'a>(
    framework: env::Framework,
    prompt: &'a str,
    append_system_prompt: &'a str,
    user_env: &'a HashMap<String, String>,
) -> CliRuntimeConfig<'a> {
    CliRuntimeConfig {
        framework,
        run_id: Cow::Borrowed("run-exec-boundary-test"),
        prompt: Cow::Borrowed(prompt),
        resume_session_id: Cow::Borrowed(""),
        append_system_prompt: Cow::Borrowed(append_system_prompt),
        native_continuation: None,
        disallowed_tools: Cow::Borrowed(""),
        tools: Cow::Borrowed(""),
        settings: Cow::Borrowed(""),
        use_mock_claude: false,
        mock_claude_path: Cow::Borrowed(""),
        use_mock_codex: false,
        mock_codex_path: Cow::Borrowed(""),
        home_dir: Cow::Borrowed("/tmp/home"),
        claude_config_dir: Cow::Borrowed("/tmp/claude-config"),
        codex_home_dir: Cow::Borrowed("/tmp/codex-home"),
        api_url: Cow::Borrowed(""),
        api_start_time: Cow::Borrowed(""),
        anthropic_model: Cow::Borrowed(""),
        openai_model: Cow::Borrowed(""),
        codex_runtime_config: None,
        codex_oauth_mode: false,
        codex_fast_mode: false,
        reasoning_effort: None,
        disable_builtin_web_search: false,
        agent_execution_deadline: None,
        stuck_tool_timeout_secs: constants::STUCK_TOOL_TIMEOUT_SECS,
        post_result_cleanup_policy: PostResultCleanupPolicy::new(
            Duration::from_secs(constants::POST_RESULT_SIGTERM_GRACE_SECS),
            Duration::from_secs(constants::POST_RESULT_TOTAL_CAP_SECS),
            Duration::from_secs(constants::POST_RESULT_SIGKILL_GRACE_SECS),
        ),
        agent_log_file: Cow::Borrowed("/tmp/agent.log"),
        session_id_file: Cow::Borrowed("/tmp/session-id"),
        session_history_launch_source: match framework {
            env::Framework::ClaudeCode => SessionHistoryLaunchSource::ClaudeCode {
                config_dir: Some("/tmp/home/.claude".to_string()),
                working_dir: paths::CANONICAL_WORKING_DIR.to_string(),
            },
            env::Framework::Codex => SessionHistoryLaunchSource::Codex {
                sessions_dir: Some("/tmp/codex-home/sessions".to_string()),
            },
            env::Framework::Pi => SessionHistoryLaunchSource::Pi,
        },
        claude_append_system_prompt_file: Cow::Borrowed("/tmp/claude-append-system-prompt"),
        pi_session_id: Cow::Borrowed(""),
        pi_launch_config: Cow::Borrowed(""),
        pi_launch_payload_file: Cow::Borrowed("/tmp/pi-launch-payload/payload.json"),
        pi_model_config: Cow::Borrowed(""),
        #[cfg(debug_assertions)]
        test_pi_cli_path: None,
        user_env,
    }
}

#[test]
fn explicit_claude_effort_overrides_user_env_without_mutating_it() {
    let user_env = HashMap::from([
        ("CLAUDE_CODE_EFFORT_LEVEL".to_string(), "low".to_string()),
        ("CUSTOM_USER_ENV".to_string(), "keep".to_string()),
    ]);
    let mut runtime = runtime_for_command_test(env::Framework::ClaudeCode, "prompt", "", &user_env);
    assert_eq!(
        runtime.child_user_env().get("CLAUDE_CODE_EFFORT_LEVEL"),
        Some(&"low".to_string())
    );
    runtime.reasoning_effort = Some("ultracode");
    assert!(
        !runtime
            .child_user_env()
            .contains_key("CLAUDE_CODE_EFFORT_LEVEL")
    );
    assert_eq!(
        runtime.child_user_env().get("CUSTOM_USER_ENV"),
        Some(&"keep".to_string())
    );
    assert_eq!(
        user_env.get("CLAUDE_CODE_EFFORT_LEVEL"),
        Some(&"low".to_string())
    );
}

#[test]
fn pi_child_env_passes_v2_model_config_with_canonical_run_id() {
    let user_env = HashMap::new();
    let mut runtime = runtime_for_command_test(env::Framework::Pi, "prompt", "", &user_env);
    runtime.pi_session_id = Cow::Borrowed("22222222-2222-4222-8222-222222222222");
    runtime.pi_launch_config = Cow::Borrowed(r#"{"schemaVersion":2}"#);
    runtime.pi_model_config = Cow::Borrowed(
        r#"{"schemaVersion":2,"dialect":"openai-codex-responses","transport":"sse","provider":"openai-codex","baseUrl":"https://chatgpt.com/backend-api/codex","model":"gpt-5.3-codex","credentialBindings":[{"kind":"access-token","environment":"CHATGPT_ACCESS_TOKEN","secretName":"CHATGPT_ACCESS_TOKEN"},{"kind":"account-id","environment":"CHATGPT_ACCOUNT_ID","secretName":"CHATGPT_ACCOUNT_ID"}]}"#,
    );
    let mut values = child_env::values_for_runtime(&runtime);
    values.extend(pi_child_env_values(&runtime));
    let values = child_env::normalize_values(values);

    let canonical_run_id = values
        .iter()
        .find(|(key, _)| key == guest_contracts::env::RUN_ID_ENV)
        .map(|(_, value)| value.as_str());
    assert_eq!(canonical_run_id, Some(runtime.run_id.as_ref()));
    for (key, expected) in [
        (
            guest_contracts::env::PI_SESSION_ID_ENV,
            runtime.pi_session_id.as_ref(),
        ),
        (
            guest_contracts::env::PI_LAUNCH_PAYLOAD_FILE_ENV,
            runtime.pi_launch_payload_file.as_ref(),
        ),
        (
            guest_contracts::env::PI_MODEL_CONFIG_ENV,
            runtime.pi_model_config.as_ref(),
        ),
    ] {
        assert_eq!(
            values
                .iter()
                .find(|(candidate, _)| candidate == key)
                .map(|(_, value)| value.as_str()),
            Some(expected)
        );
    }
}

#[test]
fn pi_launch_payload_file_merges_append_system_prompt_privately() {
    let dir = tempfile::tempdir().unwrap();
    let paths = crate::paths::GuestPaths::from_runtime_dir(dir.path());
    let user_env = HashMap::new();
    let mut runtime = runtime_for_command_test(
        env::Framework::Pi,
        "prompt",
        "Your name is Okou.",
        &user_env,
    );
    runtime.pi_launch_config = Cow::Borrowed(r#"{"schemaVersion":2}"#);
    runtime.pi_launch_payload_file = Cow::Borrowed(paths.pi_launch_payload_file());

    write_pi_launch_payload_file(&runtime).unwrap();

    let path = Path::new(paths.pi_launch_payload_file());
    let payload: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(payload["schemaVersion"], 1);
    assert_eq!(payload["appendSystemPrompt"], "Your name is Okou.");
    assert_eq!(payload["launchConfig"]["schemaVersion"], 2);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[test]
fn pi_launch_payload_file_uses_null_for_absent_append_system_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let paths = crate::paths::GuestPaths::from_runtime_dir(dir.path());
    let user_env = HashMap::new();
    let mut runtime = runtime_for_command_test(env::Framework::Pi, "prompt", "", &user_env);
    runtime.pi_launch_config = Cow::Borrowed(r#"{"schemaVersion":2}"#);
    runtime.pi_launch_payload_file = Cow::Borrowed(paths.pi_launch_payload_file());

    write_pi_launch_payload_file(&runtime).unwrap();

    let raw = std::fs::read(paths.pi_launch_payload_file()).unwrap();
    let payload: serde_json::Value = serde_json::from_slice(&raw).unwrap();
    assert!(payload["appendSystemPrompt"].is_null());
}

#[test]
fn framework_web_search_requires_exact_positive_opt_in() {
    for (value, expected_disabled) in [
        ("true", false),
        ("false", true),
        ("TRUE", true),
        ("1", true),
        ("", true),
    ] {
        let config = guest_config_for_agent_context(HashMap::from([
            (
                super::OKOU_AGENT_ID_ENV_KEY.to_string(),
                "agent-test".to_string(),
            ),
            (
                super::ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR.to_string(),
                value.to_string(),
            ),
        ]));
        let paths = crate::paths::GuestPaths::from_runtime_dir("/tmp/okou-env-test");

        let runtime = CliRuntimeConfig::from_config(&config, &paths, Instant::now()).unwrap();

        assert_eq!(runtime.disable_builtin_web_search, expected_disabled);
    }
}

#[test]
fn codex_image_generation_requires_exact_positive_opt_in() {
    for (value, expected_enabled) in [
        ("true", true),
        ("false", false),
        ("TRUE", false),
        ("1", false),
        ("", false),
    ] {
        let user_env = HashMap::from([(
            super::ENABLE_FRAMEWORK_IMAGE_GENERATION_ENV_VAR.to_string(),
            value.to_string(),
        )]);
        let runtime = runtime_for_command_test(env::Framework::Codex, "prompt", "", &user_env);

        assert!(
            runtime
                .codex_startup_config_overrides()
                .contains(&format!("features.image_generation={expected_enabled}"))
        );
    }
}

#[test]
fn codex_service_tier_preserves_canonical_semantics() {
    assert_codex_service_tier_fast_mode(HashMap::new(), false);
    for (value, expected_fast_mode) in [("fast", true), ("", false), ("priority", false)] {
        assert_codex_service_tier_fast_mode(
            HashMap::from([(
                super::CODEX_SERVICE_TIER_CANONICAL_ENV.to_string(),
                value.to_string(),
            )]),
            expected_fast_mode,
        );
    }
}

#[test]
fn codex_service_tier_value_is_not_logged() {
    let _system_log_state_guard = crate::lock_system_log_test_state();
    let tmp = tempfile::tempdir().unwrap();
    let system_log_path = tmp.path().join("system.log");
    std::fs::File::create(&system_log_path).unwrap();
    let system_log_guard = SystemLogOverrideGuard::set(&system_log_path);
    let paths = crate::paths::GuestPaths::from_runtime_dir(tmp.path());
    let value = "canonical-value-must-not-log";
    let config = guest_config_for_agent_context(HashMap::from([(
        super::CODEX_SERVICE_TIER_CANONICAL_ENV.to_string(),
        value.to_string(),
    )]));
    CliRuntimeConfig::from_config(&config, &paths, Instant::now()).unwrap();

    drop(system_log_guard);
    let system_log = std::fs::read_to_string(&system_log_path).unwrap();
    assert!(!system_log.contains(value));
}

#[test]
fn codex_web_search_override_composes_with_provider_config() {
    let user_env = HashMap::new();
    let mut runtime = runtime_for_command_test(env::Framework::Codex, "prompt", "", &user_env);
    runtime.disable_builtin_web_search = true;
    runtime.codex_runtime_config = Some(CodexRuntimeConfig {
        provider_id: "openrouter-codex".to_string(),
        name: "OpenRouter (Codex)".to_string(),
        base_url: "https://openrouter.ai/api/v1".to_string(),
        env_key: "OPENAI_API_KEY".to_string(),
        requires_openai_auth: None,
        wire_api: "responses".to_string(),
        supports_websockets: false,
        model_catalog: None,
    });

    let overrides = runtime.codex_startup_config_overrides();

    assert!(overrides.contains(&r#"model_provider="openrouter-codex""#.to_string()));
    assert!(overrides.contains(&super::CODEX_WEB_SEARCH_DISABLED_CONFIG.to_string()));
}

#[test]
fn claude_large_prompt_is_not_rejected_by_process_argv_guard() {
    let user_env = HashMap::new();
    let prompt = "x".repeat(guest_contracts::exec_limits::EXECVE_STRING_MAX_BYTES + 1);
    let runtime = runtime_for_command_test(env::Framework::ClaudeCode, &prompt, "", &user_env);

    let cmd = command::build_claude_command_for_runtime(&runtime, false);
    let (bin, args) = cmd.split_first().unwrap();
    let env_values = child_env::values_for_runtime(&runtime);

    exec_boundary::validate_process_argv_env(
        "test cli child",
        bin,
        args.iter().map(String::as_str),
        &env_values,
    )
    .unwrap();
}

#[test]
fn codex_app_server_large_prompt_is_not_part_of_process_argv_guard() {
    let user_env = HashMap::new();
    let prompt = "x".repeat(guest_contracts::exec_limits::EXECVE_STRING_MAX_BYTES + 1);
    let runtime = runtime_for_command_test(env::Framework::Codex, &prompt, "", &user_env);
    let mut env_values = child_env::values_for_runtime(&runtime);
    env_values.push(("CODEX_HOME".to_string(), runtime.codex_home().to_string()));

    exec_boundary::validate_process_argv_env(
        "test codex app-server",
        "codex",
        ["app-server", "--listen", "stdio://"],
        &env_values,
    )
    .unwrap();
}

#[test]
fn codex_child_env_keeps_openai_base_url_without_structured_runtime_config() {
    let user_env = HashMap::from([
        ("OPENAI_API_KEY".to_string(), "sk-test".to_string()),
        ("OPENAI_MODEL".to_string(), "gpt-5".to_string()),
        (
            "OPENAI_BASE_URL".to_string(),
            "https://api.legacy-provider.test/v1".to_string(),
        ),
    ]);
    let runtime = runtime_for_command_test(env::Framework::Codex, "prompt", "", &user_env);

    let env_values = child_env::values_for_runtime(&runtime);

    assert!(env_values.iter().any(|(key, value)| {
        key == "OPENAI_BASE_URL" && value == "https://api.legacy-provider.test/v1"
    }));
}

#[test]
fn structured_codex_runtime_config_omits_stale_openai_base_url_from_child_env() {
    let user_env = HashMap::from([
        ("OPENAI_API_KEY".to_string(), "sk-test".to_string()),
        ("OPENAI_MODEL".to_string(), "deepseek-v4-flash".to_string()),
        (
            "OPENAI_BASE_URL".to_string(),
            "https://api.should-not-win.test/v1".to_string(),
        ),
    ]);
    let mut runtime = runtime_for_command_test(env::Framework::Codex, "prompt", "", &user_env);
    runtime.codex_runtime_config = Some(CodexRuntimeConfig {
        provider_id: "openrouter-codex".to_string(),
        name: "OpenRouter (Codex)".to_string(),
        base_url: "https://openrouter.ai/api/v1".to_string(),
        env_key: "OPENAI_API_KEY".to_string(),
        requires_openai_auth: None,
        wire_api: "responses".to_string(),
        supports_websockets: false,
        model_catalog: None,
    });

    let env_values = child_env::values_for_runtime(&runtime);

    assert!(
        env_values
            .iter()
            .any(|(key, value)| { key == "OPENAI_API_KEY" && value == "sk-test" })
    );
    assert!(
        env_values
            .iter()
            .any(|(key, value)| { key == "OPENAI_MODEL" && value == "deepseek-v4-flash" })
    );
    assert!(!env_values.iter().any(|(key, _)| key == "OPENAI_BASE_URL"));
}

#[test]
fn claude_initial_prompt_frame_matches_stream_json_user_shape() {
    let frame = serde_json::to_value(claude_initial_prompt_frame("run_123", "hello stdin"))
        .expect("serialize prompt frame");

    assert_eq!(
        frame.get("type").and_then(serde_json::Value::as_str),
        Some("user")
    );
    assert_eq!(
        frame
            .pointer("/message/role")
            .and_then(serde_json::Value::as_str),
        Some("user")
    );
    assert_eq!(
        frame
            .pointer("/message/content")
            .and_then(serde_json::Value::as_str),
        Some("hello stdin")
    );
    assert!(
        frame
            .get("parent_tool_use_id")
            .is_some_and(serde_json::Value::is_null)
    );
    let uuid = frame
        .get("uuid")
        .and_then(serde_json::Value::as_str)
        .expect("uuid");
    uuid::Uuid::parse_str(uuid).expect("valid uuid");
}

#[test]
fn codex_home_is_independent_of_child_home() {
    let user_env = HashMap::new();
    let runtime = runtime_for_command_test(env::Framework::Codex, "prompt", "", &user_env);

    assert_eq!(runtime.home_dir, "/tmp/home");
    assert_eq!(runtime.codex_home(), "/tmp/codex-home");
    let SessionHistoryLaunchSource::Codex { sessions_dir } = &runtime.session_history_launch_source
    else {
        panic!("expected Codex session-history source");
    };
    assert_eq!(sessions_dir.as_deref(), Some("/tmp/codex-home/sessions"));
}

#[tokio::test]
async fn cli_current_dir_helper_sets_child_working_directory() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut cmd = tokio::process::Command::new("pwd");
    cmd.stdout(std::process::Stdio::piped());

    set_cli_current_dir(&mut cmd, dir.path().to_str().expect("utf8 temp path")).expect("set cwd");
    let output = cmd.output().await.expect("pwd");

    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        dir.path().to_string_lossy()
    );
}

#[cfg(unix)]
#[test]
fn cli_exit_summary_preserves_normal_exit_137() {
    let status = std::process::ExitStatus::from_raw(137 << 8);

    let (exit_code, observed_exit) = cli_exit_summary_from_status(&status);

    let observed_exit = observed_exit.expect("normal exit should be observed");
    assert_eq!(exit_code, 137);
    assert_eq!(
        observed_exit,
        guest_contracts::diagnostics::CliObservedExitDiagnostic::from_exit_code(137)
    );
    assert!(!observed_exit.is_sigkill());
}

#[cfg(unix)]
#[test]
fn cli_exit_summary_preserves_signal_exit_before_mapping() {
    let status = std::process::ExitStatus::from_raw(libc::SIGKILL);

    let (exit_code, observed_exit) = cli_exit_summary_from_status(&status);

    let observed_exit = observed_exit.expect("signal exit should be observed");
    assert_eq!(exit_code, 137);
    assert_eq!(
        observed_exit,
        guest_contracts::diagnostics::CliObservedExitDiagnostic::from_signal(libc::SIGKILL)
    );
    assert!(observed_exit.is_sigkill());
}

#[cfg(unix)]
#[tokio::test]
async fn cli_exit_observation_distinguishes_stdout_drain_from_loop_completion() {
    let active_input = ActiveInputRuntime::new_disabled("run-exit-observation", "");
    let controller = active_input.controller();
    let termination_deadline = tokio::time::sleep(Duration::MAX);
    tokio::pin!(termination_deadline);
    let drain_deadline = tokio::time::sleep(Duration::MAX);
    tokio::pin!(drain_deadline);
    let mut runtime = CliTerminationRuntime::new(
        None,
        PostResultCleanupPolicy::new(
            Duration::from_secs(3),
            Duration::from_secs(60),
            Duration::from_secs(1),
        ),
    );
    assert!(runtime.arm_post_result_cleanup(false, termination_deadline.as_mut()));

    let mut cli_status = None;
    let mut cli_exit_at = None;
    let observation = record_cli_exit(
        std::process::ExitStatus::from_raw(0),
        &mut cli_status,
        &mut cli_exit_at,
        &controller,
        &mut runtime,
        false,
        drain_deadline.as_mut(),
    );

    assert_eq!(observation, CliExitObservation::ExitedDrainingStdout);
    assert!(cli_status.is_some());
    assert!(cli_exit_at.is_some());
    assert!(!runtime.has_pending_deadline());
    assert!(!runtime.has_post_result_cleanup());
    assert!(!runtime.arm_post_result_cleanup(false, termination_deadline.as_mut()));
}

#[test]
fn cli_current_dir_helper_errors_for_missing_directory() {
    let dir = tempfile::tempdir().expect("tempdir");
    let missing = dir.path().join("missing");
    let mut cmd = tokio::process::Command::new("pwd");

    let err = set_cli_current_dir(&mut cmd, missing.to_str().expect("utf8 temp path"))
        .expect_err("missing cwd should fail");

    assert!(
        err.to_string()
            .contains("canonical working directory unavailable")
    );
}

#[test]
fn cli_current_dir_helper_errors_for_non_directory() {
    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join("workspace-file");
    std::fs::write(&file, b"not a directory").expect("write file");
    let mut cmd = tokio::process::Command::new("pwd");

    let err = set_cli_current_dir(&mut cmd, file.to_str().expect("utf8 temp path"))
        .expect_err("non-directory cwd should fail");

    assert!(err.to_string().contains("is not a directory"));
}

#[test]
fn specific_codex_failure_diagnostic_survives_later_generic_event() {
    for generic_message in [
        "turn failed",
        "Turn failed.",
        "Unknown error",
        "codex error",
    ] {
        assert_eq!(
            select_failure_diagnostic(
                Some(&CliFailureDiagnostic {
                    message: "You've hit your usage limit.".to_string(),
                    source: FailureDetailSource::CodexJsonl,
                    failure_reason: None,
                    codex_failure: None,
                }),
                CliFailureDiagnostic {
                    message: generic_message.to_string(),
                    source: FailureDetailSource::CodexJsonl,
                    failure_reason: None,
                    codex_failure: None,
                },
            ),
            None,
            "generic message should not replace specific diagnostic: {generic_message}"
        );
    }
}

#[test]
fn codex_native_evidence_follows_the_selected_error_without_cross_event_status() {
    use guest_contracts::codex_failure::{
        CodexFailureEvidence, CodexFailureStage, CodexNativeFailureKind,
    };
    let original = CliFailureDiagnostic {
        message: "stream disconnected before completion: error sending request".to_string(),
        source: FailureDetailSource::CodexJsonl,
        failure_reason: None,
        codex_failure: Some(CodexFailureEvidence {
            reported_stage: Some(CodexFailureStage::RequestSend),
            native_kind: Some(CodexNativeFailureKind::Other),
            http_status: None,
        }),
    };
    let response = CliFailureDiagnostic {
        message: "response disconnected".to_string(),
        source: FailureDetailSource::CodexJsonl,
        failure_reason: Some(FailureReason::ResponseConnectionLost),
        codex_failure: Some(CodexFailureEvidence {
            reported_stage: Some(CodexFailureStage::ResponseStream),
            native_kind: Some(CodexNativeFailureKind::ResponseStreamDisconnected),
            http_status: Some(200),
        }),
    };
    let generic = CliFailureDiagnostic {
        message: "turn failed".to_string(),
        source: FailureDetailSource::CodexJsonl,
        failure_reason: None,
        codex_failure: None,
    };
    assert_eq!(
        select_failure_diagnostic(Some(&original), generic.clone()),
        None
    );
    let native_generic = CliFailureDiagnostic {
        message: "turn failed".to_string(),
        failure_reason: None,
        ..response.clone()
    };
    let exhausted_generic = CliFailureDiagnostic {
        codex_failure: Some(CodexFailureEvidence {
            reported_stage: None,
            native_kind: Some(CodexNativeFailureKind::ResponseTooManyFailedAttempts),
            http_status: None,
        }),
        ..native_generic.clone()
    };
    assert_eq!(
        select_failure_diagnostic(Some(&exhausted_generic), generic.clone()),
        None,
        "native retry exhaustion must survive even when its status/count are unavailable"
    );
    assert_eq!(
        select_failure_diagnostic(Some(&native_generic), generic.clone()),
        None,
        "a generic follow-up must not erase retained native status"
    );
    assert_eq!(
        select_failure_diagnostic(Some(&original), response.clone()),
        Some(response.clone())
    );
    assert_eq!(
        select_failure_diagnostic(Some(&response), original.clone())
            .unwrap()
            .codex_failure,
        original.codex_failure
    );

    let authoritative = CliFailureDiagnostic {
        failure_reason: Some(FailureReason::InvalidCredentials),
        ..generic
    };
    let selected = select_failure_diagnostic(Some(&response), authoritative).unwrap();
    assert_eq!(
        selected.failure_reason,
        Some(FailureReason::InvalidCredentials)
    );
    assert_eq!(
        selected.codex_failure, None,
        "do not retain an earlier response status for a new native cause"
    );
}

#[test]
fn generic_codex_failure_diagnostic_replaces_prior_generic_event() {
    let selected = select_failure_diagnostic(
        Some(&CliFailureDiagnostic {
            message: "error".to_string(),
            source: FailureDetailSource::CodexJsonl,
            failure_reason: None,
            codex_failure: None,
        }),
        CliFailureDiagnostic {
            message: "Unknown error".to_string(),
            source: FailureDetailSource::CodexJsonl,
            failure_reason: None,
            codex_failure: None,
        },
    );

    assert_eq!(
        selected,
        Some(CliFailureDiagnostic {
            message: "Unknown error".to_string(),
            source: FailureDetailSource::CodexJsonl,
            failure_reason: None,
            codex_failure: None,
        })
    );
}

#[test]
fn generic_codex_failure_diagnostic_does_not_replace_specific_claude_result() {
    assert_eq!(
        select_failure_diagnostic(
            Some(&CliFailureDiagnostic {
                message: "Claude result failure".to_string(),
                source: FailureDetailSource::ClaudeResult,
                failure_reason: None,
                codex_failure: None,
            }),
            CliFailureDiagnostic {
                message: "Unknown error".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: None,
                codex_failure: None,
            },
        ),
        None,
    );
}

#[test]
fn specific_codex_failure_diagnostic_replaces_generic_event() {
    let selected = select_failure_diagnostic(
        Some(&CliFailureDiagnostic {
            message: "error".to_string(),
            source: FailureDetailSource::CodexJsonl,
            failure_reason: None,
            codex_failure: None,
        }),
        CliFailureDiagnostic {
            message: "You've hit your usage limit.".to_string(),
            source: FailureDetailSource::CodexJsonl,
            failure_reason: None,
            codex_failure: None,
        },
    );

    assert_eq!(
        selected.map(|diagnostic| diagnostic.message),
        Some("You've hit your usage limit.".to_string())
    );
}

#[test]
fn codex_failure_reason_replaces_generic_diagnostic() {
    let selected = select_failure_diagnostic(
        Some(&CliFailureDiagnostic {
            message: "error".to_string(),
            source: FailureDetailSource::CodexJsonl,
            failure_reason: None,
            codex_failure: None,
        }),
        CliFailureDiagnostic {
            message: "turn failed".to_string(),
            source: FailureDetailSource::CodexJsonl,
            failure_reason: Some(FailureReason::InvalidApiKey),
            codex_failure: None,
        },
    );

    assert_eq!(
        selected.map(|diagnostic| diagnostic.failure_reason),
        Some(Some(FailureReason::InvalidApiKey))
    );
}

#[test]
fn generic_codex_reason_preserves_existing_specific_message() {
    let selected = select_failure_diagnostic(
        Some(&CliFailureDiagnostic {
            message: "request failed before shutdown".to_string(),
            source: FailureDetailSource::CodexJsonl,
            failure_reason: None,
            codex_failure: None,
        }),
        CliFailureDiagnostic {
            message: "turn failed".to_string(),
            source: FailureDetailSource::CodexJsonl,
            failure_reason: Some(FailureReason::InvalidApiKey),
            codex_failure: None,
        },
    )
    .expect("reason-bearing generic diagnostic should update existing diagnostic");

    assert_eq!(selected.message, "request failed before shutdown");
    assert_eq!(selected.failure_reason, Some(FailureReason::InvalidApiKey));
}

#[test]
fn carried_failure_reason_survives_message_replacement() {
    let candidate = with_carried_failure_reason(
        Some(&CliFailureDiagnostic {
            message: "turn failed".to_string(),
            source: FailureDetailSource::CodexJsonl,
            failure_reason: Some(FailureReason::InvalidApiKey),
            codex_failure: None,
        }),
        CliFailureDiagnostic {
            message: "request failed".to_string(),
            source: FailureDetailSource::CodexJsonl,
            failure_reason: None,
            codex_failure: None,
        },
    );

    assert_eq!(candidate.message, "request failed");
    assert_eq!(candidate.failure_reason, Some(FailureReason::InvalidApiKey));
}
