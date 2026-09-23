//! Claude Code command construction.
//!
//! This module owns argv shape and mock binary selection. Runtime process
//! spawning stays in the shared CLI execution path.

use guest_telemetry::log_info;

#[cfg(test)]
use crate::env;

use super::{CliRuntimeConfig, LOG_TAG};

pub(super) fn build_claude_command_for_runtime(
    runtime: &CliRuntimeConfig<'_>,
    replay_user_messages: bool,
) -> Vec<String> {
    build_claude_command_with_config(
        runtime.use_mock_claude,
        runtime.mock_claude_path.as_ref(),
        ClaudeArgsConfig {
            model: runtime.anthropic_model.as_ref(),
            effort: runtime.reasoning_effort,
            resume_id: runtime.resume_session_id.as_ref(),
            append_system_prompt_file: (!runtime.append_system_prompt.is_empty())
                .then_some(runtime.claude_append_system_prompt_file.as_ref()),
            disallowed_tools: runtime.disallowed_tools.as_ref(),
            tools: runtime.tools.as_ref(),
            settings: runtime.settings.as_ref(),
            replay_user_messages,
        },
    )
}

fn push_comma_separated_flag_values(args: &mut Vec<String>, flag: &str, values: &str) {
    let mut has_values = false;

    for value in values
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !has_values {
            args.push(flag.to_string());
            has_values = true;
        }
        args.push(value.to_string());
    }
}

/// Build the argument list from explicit parameters (testable).
struct ClaudeArgsConfig<'a> {
    model: &'a str,
    effort: Option<&'a str>,
    resume_id: &'a str,
    append_system_prompt_file: Option<&'a str>,
    disallowed_tools: &'a str,
    tools: &'a str,
    settings: &'a str,
    replay_user_messages: bool,
}

fn build_claude_args(config: ClaudeArgsConfig<'_>) -> Vec<String> {
    let mut args = vec![
        "--print".to_string(),
        "--verbose".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ];
    if config.replay_user_messages {
        args.push("--replay-user-messages".to_string());
    }

    if !config.resume_id.is_empty() {
        log_info!(LOG_TAG, "Resuming session");
        args.push("--resume".to_string());
        args.push(config.resume_id.to_string());
    } else {
        log_info!(LOG_TAG, "Starting new session");
    }

    if let Some(path) = config.append_system_prompt_file {
        args.push("--append-system-prompt-file".to_string());
        args.push(path.to_string());
    }

    push_comma_separated_flag_values(&mut args, "--disallowed-tools", config.disallowed_tools);
    push_comma_separated_flag_values(&mut args, "--tools", config.tools);

    if !config.settings.is_empty() {
        args.push("--settings".to_string());
        args.push(config.settings.to_string());
    }

    if let Some(effort) = config
        .effort
        .or_else(|| default_claude_effort_for_model(config.model))
    {
        args.push("--effort".to_string());
        args.push(effort.to_string());
    }

    args
}

/// Per-model default for Claude Code's `--effort` flag.
fn default_claude_effort_for_model(model: &str) -> Option<&'static str> {
    let bare = model.strip_prefix("anthropic/").unwrap_or(model);
    match bare {
        "claude-fable-5-1" | "claude-fable-5.1" | "fable" => Some("max"),
        "claude-opus-5-5" | "claude-opus-5.5" => Some("medium"),
        _ => None,
    }
}

fn build_claude_command_with_config(
    use_mock: bool,
    mock_claude_path: &str,
    config: ClaudeArgsConfig<'_>,
) -> Vec<String> {
    let args = build_claude_args(config);
    let bin = if use_mock {
        log_info!(LOG_TAG, "Using mock-claude for testing");
        // Tests can override the path so they target a cargo-built
        // artifact rather than the sandbox's baked-in `/usr/local/bin`.
        mock_claude_path.to_string()
    } else {
        "claude".to_string()
    };

    let mut cmd = vec![bin];
    cmd.extend(args);
    cmd
}

#[cfg(test)]
mod tests {
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
    fn build_claude_args_with_append_system_prompt() {
        let args = build_claude_args_for_test("", "Your name is Aria.", "", "", "");
        let asp_idx = args
            .iter()
            .position(|a| a == "--append-system-prompt-file")
            .unwrap();
        assert_eq!(args[asp_idx + 1], TEST_APPEND_SYSTEM_PROMPT_FILE);
        assert!(!args.iter().any(|arg| arg == "Your name is Aria."));
        assert_claude_prompt_is_not_positional(&args, "analyze this");
    }

    #[test]
    fn build_claude_args_empty_append_system_prompt_omitted() {
        let args = build_claude_args_for_test("", "", "", "", "");
        assert!(!args.contains(&"--append-system-prompt".to_string()));
        assert!(!args.contains(&"--append-system-prompt-file".to_string()));
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
    fn build_claude_args_with_resume_and_append() {
        let args = build_claude_args_for_test("sess-123", "Be helpful.", "", "", "");
        assert!(args.contains(&"--resume".to_string()));
        assert!(args.contains(&"--append-system-prompt-file".to_string()));
        assert_claude_prompt_is_not_positional(&args, "prompt");
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
    fn build_claude_args_empty_disallowed_tools_omitted() {
        let args = build_claude_args_for_test("", "", "", "", "");
        assert!(!args.contains(&"--disallowed-tools".to_string()));
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
    fn build_claude_args_empty_tools_omitted() {
        let args = build_claude_args_for_test("", "", "", "", "");
        assert!(!args.contains(&"--tools".to_string()));
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
    fn build_claude_args_fable_defaults_effort_max() {
        for model in [
            "claude-fable-5-1",
            "claude-fable-5.1",
            "anthropic/claude-fable-5-1",
            "anthropic/claude-fable-5.1",
            "fable",
        ] {
            let args = build_claude_args_for_model_test(model);
            let effort_idx = args.iter().position(|arg| arg == "--effort").unwrap();
            assert_eq!(args[effort_idx + 1], "max");
        }
    }

    #[test]
    fn build_claude_args_opus_5_5_defaults_effort_medium() {
        for model in [
            "claude-opus-5-5",
            "claude-opus-5.5",
            "anthropic/claude-opus-5-5",
            "anthropic/claude-opus-5.5",
        ] {
            let args = build_claude_args_for_model_test(model);
            let effort_idx = args.iter().position(|arg| arg == "--effort").unwrap();
            assert_eq!(args[effort_idx + 1], "medium");
        }
    }

    #[test]
    fn build_claude_args_other_models_omit_effort() {
        for model in [
            "",
            "claude-sonnet-5",
            "claude-sonnet-4-6",
            "anthropic/claude-sonnet-5",
            "claude-opus-4-8",
        ] {
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

    #[test]
    fn build_claude_args_prompt_never_appears_in_argv() {
        let args = build_claude_args_for_test("", "", "", "", "");
        assert_claude_prompt_is_not_positional(&args, "my prompt");
    }
}
