use super::*;

#[test]
fn parse_args_empty() {
    let args: Vec<String> = vec![];
    let result = parse_args(&args);
    assert_eq!(result.input_format, "text");
    assert_eq!(result.output_format, "text");
    assert!(!result.replay_user_messages);
    assert!(result.prompt.is_empty());
}

#[test]
fn parse_args_input_format() {
    let args: Vec<String> = vec!["--input-format", "stream-json"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args);
    assert_eq!(result.input_format, "stream-json");
    assert!(result.prompt.is_empty());
}

#[test]
fn parse_args_output_format() {
    let args: Vec<String> = vec!["--output-format", "stream-json"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args);
    assert_eq!(result.output_format, "stream-json");
}

#[test]
fn parse_args_all_options() {
    let args: Vec<String> = vec![
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--print",
        "--verbose",
        "--dangerously-skip-permissions",
        "--include-partial-messages",
        "--resume",
        "session-abc",
        "--append-system-prompt",
        "Your name is Aria.",
        "ls -la",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    let result = parse_args(&args);
    assert_eq!(result.input_format, "stream-json");
    assert_eq!(result.output_format, "stream-json");
    assert_eq!(result.prompt, "ls -la");
}

#[test]
fn parse_args_prompt_only() {
    let args: Vec<String> = vec!["echo hello".to_string()];
    let result = parse_args(&args);
    assert_eq!(result.prompt, "echo hello");
    assert_eq!(result.output_format, "text");
}

#[test]
fn parse_args_options_any_order() {
    let args: Vec<String> = vec![
        "--print",
        "--output-format",
        "stream-json",
        "my prompt",
        "--verbose",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    let result = parse_args(&args);
    assert_eq!(result.output_format, "stream-json");
    assert_eq!(result.prompt, "my prompt");
}

#[test]
fn parse_args_output_format_missing_value() {
    let args: Vec<String> = vec!["--output-format".to_string()];
    let result = parse_args(&args);
    assert_eq!(result.output_format, "text");
}

#[test]
fn parse_args_input_format_missing_value() {
    let args: Vec<String> = vec!["--input-format".to_string()];
    let result = parse_args(&args);
    assert_eq!(result.input_format, "text");
}

#[test]
fn parse_args_replay_user_messages_skipped() {
    let args: Vec<String> = vec!["--replay-user-messages", "echo hi"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args);
    assert_eq!(result.prompt, "echo hi");
    assert!(result.replay_user_messages);
}

#[test]
fn parse_args_resume_skipped() {
    let args: Vec<String> = vec!["--resume", "session-123", "echo hi"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args);
    // --resume and its value are consumed, not treated as prompt
    assert_eq!(result.prompt, "echo hi");
}

#[test]
fn parse_args_append_system_prompt_skipped() {
    let args: Vec<String> = vec!["--append-system-prompt", "Your name is Aria.", "echo hi"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args);
    assert_eq!(result.prompt, "echo hi");
}

#[test]
fn parse_args_settings_skipped() {
    let args: Vec<String> = vec!["--settings", r#"{"permissions":{}}"#, "echo hi"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args);
    assert_eq!(result.prompt, "echo hi");
}

#[test]
fn parse_args_effort_skipped() {
    let args: Vec<String> = vec!["--effort", "low", "echo hi"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args);
    assert_eq!(result.prompt, "echo hi");
}

#[test]
fn parse_args_settings_missing_value() {
    let args: Vec<String> = vec!["--settings".to_string()];
    let result = parse_args(&args);
    assert!(result.prompt.is_empty());
}

#[test]
fn parse_args_value_flag_consumes_flag_like_value() {
    let args: Vec<String> = vec!["--settings", "--print", "echo hi"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args);
    assert_eq!(result.prompt, "echo hi");
}

#[test]
fn parse_args_last_remaining_is_prompt() {
    let args: Vec<String> = vec!["first", "second", "third"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args);
    assert_eq!(result.prompt, "third");
}

#[test]
fn parse_args_tools_with_separator() {
    let args: Vec<String> = vec!["--tools", "Bash", "Read", "--", "echo hello"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args);
    assert_eq!(result.prompt, "echo hello");
}

#[test]
fn parse_args_disallowed_tools_with_separator() {
    let args: Vec<String> = vec![
        "--disallowed-tools",
        "CronCreate",
        "CronDelete",
        "--",
        "echo hello",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    let result = parse_args(&args);
    assert_eq!(result.prompt, "echo hello");
}

#[test]
fn parse_args_variadic_without_separator_swallows_prompt() {
    // Without "--", variadic --disallowed-tools consumes the prompt
    // (matches Commander.js behavior that caused the production bug)
    let args: Vec<String> = vec![
        "--disallowed-tools",
        "CronCreate",
        "CronDelete",
        "echo hello",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    let result = parse_args(&args);
    assert!(
        result.prompt.is_empty(),
        "prompt should be empty without '--' separator, got: {:?}",
        result.prompt,
    );
}

#[test]
fn parse_args_separator_after_option_flag() {
    // "--" after another --flag correctly separates prompt
    let args: Vec<String> = vec![
        "--disallowed-tools",
        "CronCreate",
        "--output-format",
        "stream-json",
        "--",
        "echo hello",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    let result = parse_args(&args);
    assert_eq!(result.output_format, "stream-json");
    assert_eq!(result.prompt, "echo hello");
}
