use super::*;

const TEST_APPEND_SYSTEM_PROMPT_FILE: &str = "/tmp/claude-append-system-prompt";

fn disable_system_log() {
    guest_telemetry::log::clear_system_log_file();
}

fn build_claude_args_for_test(
    resume_id: &str,
    append_system_prompt: &str,
    disallowed_tools: &str,
    tools: &str,
    settings: &str,
) -> Vec<String> {
    build_claude_args_for_test_with_replay(
        resume_id,
        append_system_prompt,
        disallowed_tools,
        tools,
        settings,
        true,
    )
}

fn build_claude_args_for_test_with_replay(
    resume_id: &str,
    append_system_prompt: &str,
    disallowed_tools: &str,
    tools: &str,
    settings: &str,
    replay_user_messages: bool,
) -> Vec<String> {
    let _system_log_state_guard = crate::lock_system_log_test_state();
    disable_system_log();
    build_claude_args(ClaudeArgsConfig {
        model: "",
        effort: None,
        resume_id,
        append_system_prompt_file: (!append_system_prompt.is_empty())
            .then_some(TEST_APPEND_SYSTEM_PROMPT_FILE),
        disallowed_tools,
        tools,
        settings,
        replay_user_messages,
    })
}

fn build_claude_command_for_test(use_mock: bool) -> Vec<String> {
    let _system_log_state_guard = crate::lock_system_log_test_state();
    disable_system_log();
    build_claude_command_with_config(
        use_mock,
        if use_mock {
            env::DEFAULT_MOCK_CLAUDE_PATH
        } else {
            ""
        },
        ClaudeArgsConfig {
            model: "",
            effort: None,
            resume_id: "",
            append_system_prompt_file: None,
            disallowed_tools: "",
            tools: "",
            settings: "",
            replay_user_messages: true,
        },
    )
}

fn build_claude_args_for_model_test(model: &str) -> Vec<String> {
    let _system_log_state_guard = crate::lock_system_log_test_state();
    disable_system_log();
    build_claude_args(ClaudeArgsConfig {
        model,
        effort: None,
        resume_id: "",
        append_system_prompt_file: None,
        disallowed_tools: "",
        tools: "",
        settings: "",
        replay_user_messages: true,
    })
}

fn assert_claude_prompt_is_not_positional(args: &[String], prompt: &str) {
    assert!(!args.contains(&"--".to_string()), "unexpected --: {args:?}");
    assert!(
        !args.iter().any(|arg| arg == prompt),
        "prompt must be written to stdin, not argv: {args:?}"
    );
}

#[test]
fn build_claude_args_basic() {
    let args = build_claude_args_for_test("", "", "", "", "");
    assert!(args.contains(&"--print".to_string()));
    let input_idx = args
        .iter()
        .position(|arg| arg == "--input-format")
        .expect("input format flag should be present");
    assert_eq!(args[input_idx + 1], "stream-json");
    assert!(args.contains(&"--dangerously-skip-permissions".to_string()));
    assert_claude_prompt_is_not_positional(&args, "hello world");
    assert!(args.contains(&"--replay-user-messages".to_string()));
    assert!(!args.contains(&"--append-system-prompt".to_string()));
    assert!(!args.contains(&"--append-system-prompt-file".to_string()));
    assert!(!args.contains(&"--resume".to_string()));
}

#[test]
fn build_claude_args_omits_replay_user_messages_when_disabled() {
    let args = build_claude_args_for_test_with_replay("", "", "", "", "", false);
    assert!(!args.contains(&"--replay-user-messages".to_string()));
}

#[test]
fn build_claude_args_resume_log_omits_resume_id() {
    let _system_log_state_guard = crate::lock_system_log_test_state();
    let tmp = tempfile::tempdir().unwrap();
    let system_log_path = tmp.path().join("system.log");
    guest_telemetry::log::set_system_log_file(system_log_path.to_string_lossy().as_ref());

    let args = build_claude_args(ClaudeArgsConfig {
        model: "",
        effort: None,
        resume_id: "sess-secret-123",
        append_system_prompt_file: None,
        disallowed_tools: "",
        tools: "",
        settings: "",
        replay_user_messages: true,
    });
    guest_telemetry::log::clear_system_log_file();
    let system_log = std::fs::read_to_string(system_log_path).unwrap();

    assert!(args.contains(&"--resume".to_string()));
    assert!(args.contains(&"sess-secret-123".to_string()));
    assert!(system_log.contains("Resuming session"));
    assert!(!system_log.contains("sess-secret-123"));
}

#[test]
fn build_claude_command_uses_claude_binary() {
    let cmd = build_claude_command_for_test(false);
    assert_eq!(cmd[0], "claude");
}

#[test]
fn build_claude_command_uses_mock_binary() {
    // Unit tests run in the lib-test binary where
    // Asserting against the const catches regressions in the default path
    // itself.
    let cmd = build_claude_command_for_test(true);
    assert_eq!(cmd[0], env::DEFAULT_MOCK_CLAUDE_PATH);
}

#[test]
fn build_claude_args_with_disallowed_tools() {
    let args = build_claude_args_for_test("", "", "CronCreate,CronDelete,CronList", "", "");
    let dt_idx = args.iter().position(|a| a == "--disallowed-tools").unwrap();
    assert_eq!(args[dt_idx + 1], "CronCreate");
    assert_eq!(args[dt_idx + 2], "CronDelete");
    assert_eq!(args[dt_idx + 3], "CronList");
    assert_claude_prompt_is_not_positional(&args, "hello");
}

#[test]
fn build_claude_args_with_tools() {
    let args = build_claude_args_for_test("", "", "", "Bash,Edit,Read", "");
    let t_idx = args.iter().position(|a| a == "--tools").unwrap();
    assert_eq!(args[t_idx + 1], "Bash");
    assert_eq!(args[t_idx + 2], "Edit");
    assert_eq!(args[t_idx + 3], "Read");
    assert_claude_prompt_is_not_positional(&args, "hello");
}

#[test]
fn build_claude_args_with_settings() {
    let args = build_claude_args_for_test("", "", "", "", r#"{"hooks":{}}"#);
    let s_idx = args.iter().position(|a| a == "--settings").unwrap();
    assert_eq!(args[s_idx + 1], r#"{"hooks":{}}"#);
    assert_claude_prompt_is_not_positional(&args, "hello");
}

#[test]
fn build_claude_args_empty_settings_omitted() {
    let args = build_claude_args_for_test("", "", "", "", "");
    assert!(!args.contains(&"--settings".to_string()));
}

#[test]
fn build_claude_args_other_models_omit_effort() {
    for model in ["", "claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-5"] {
        let args = build_claude_args_for_model_test(model);
        assert!(
            !args.iter().any(|arg| arg == "--effort"),
            "unexpected effort default for model {model:?}: {args:?}"
        );
    }
}

#[test]
fn build_claude_args_all_options_combined() {
    let args = build_claude_args_for_test(
        "sess-abc",
        "Be concise.",
        "CronCreate,CronDelete",
        "Bash,Read",
        r#"{"hooks":{}}"#,
    );
    for expected in [
        "--resume",
        "sess-abc",
        "--append-system-prompt-file",
        TEST_APPEND_SYSTEM_PROMPT_FILE,
        "--disallowed-tools",
        "CronCreate",
        "CronDelete",
        "--tools",
        "Bash",
        "Read",
        "--settings",
        r#"{"hooks":{}}"#,
    ] {
        assert!(args.iter().any(|a| a == expected), "missing: {expected}");
    }
    assert_claude_prompt_is_not_positional(&args, "do something");
}

#[test]
fn build_claude_args_disallowed_tools_whitespace_trimmed() {
    let args = build_claude_args_for_test("", "", " CronCreate , CronDelete ", "", "");
    let dt_idx = args.iter().position(|a| a == "--disallowed-tools").unwrap();
    assert_eq!(args[dt_idx + 1], "CronCreate");
    assert_eq!(args[dt_idx + 2], "CronDelete");
}

#[test]
fn build_claude_args_tools_whitespace_trimmed() {
    let args = build_claude_args_for_test("", "", "", " Bash , Read ", "");
    let t_idx = args.iter().position(|a| a == "--tools").unwrap();
    assert_eq!(args[t_idx + 1], "Bash");
    assert_eq!(args[t_idx + 2], "Read");
}

#[test]
fn build_claude_args_disallowed_tools_empty_items_skipped() {
    // Trailing comma produces an empty token that should be skipped
    let args = build_claude_args_for_test("", "", "CronCreate,,CronDelete,", "", "");
    let dt_idx = args.iter().position(|a| a == "--disallowed-tools").unwrap();
    // Only non-empty tools should be present
    let tool_args: Vec<&str> = args[dt_idx + 1..]
        .iter()
        .take_while(|a| a.as_str() != "--" && !a.starts_with("--"))
        .map(|s| s.as_str())
        .collect();
    assert_eq!(tool_args, vec!["CronCreate", "CronDelete"]);
}

#[test]
fn build_claude_args_tools_empty_items_skipped() {
    let args = build_claude_args_for_test("", "", "", "Bash,,Read,", "");
    let t_idx = args.iter().position(|a| a == "--tools").unwrap();
    let tool_args: Vec<&str> = args[t_idx + 1..]
        .iter()
        .take_while(|a| a.as_str() != "--" && !a.starts_with("--"))
        .map(|s| s.as_str())
        .collect();
    assert_eq!(tool_args, vec!["Bash", "Read"]);
}

#[test]
fn build_claude_args_comma_only_tool_values_omitted() {
    let args = build_claude_args_for_test("", "", " , ,, ", ",,,", "");
    assert!(!args.contains(&"--disallowed-tools".to_string()));
    assert!(!args.contains(&"--tools".to_string()));
    assert_claude_prompt_is_not_positional(&args, "test");
}
