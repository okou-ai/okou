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
    match model {
        "claude-fable-5-1" => Some("max"),
        "claude-opus-5-5" => Some("medium"),
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
mod tests;
