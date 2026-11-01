/// Parsed command-line arguments.
pub(crate) struct ParsedArgs {
    pub(crate) input_format: String,
    pub(crate) output_format: String,
    pub(crate) replay_user_messages: bool,
    pub(crate) prompt: String,
}

fn skip_flag_value(args: &[String], i: &mut usize) {
    if args.get(*i + 1).is_some() {
        *i += 2;
    } else {
        *i += 1;
    }
}

/// Parse command-line arguments (matching the real Claude CLI interface).
pub(crate) fn parse_args(args: &[String]) -> ParsedArgs {
    let mut input_format = "text".to_string();
    let mut output_format = "text".to_string();
    let mut replay_user_messages = false;
    let mut remaining: Vec<String> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        let arg = args.get(i).map(String::as_str).unwrap_or_default();

        match arg {
            "--input-format" => {
                if let Some(val) = args.get(i + 1) {
                    input_format = val.clone();
                    i += 2;
                } else {
                    i += 1;
                }
            }
            "--output-format" => {
                if let Some(val) = args.get(i + 1) {
                    output_format = val.clone();
                    i += 2;
                } else {
                    i += 1;
                }
            }
            "--resume" | "--append-system-prompt" | "--append-system-prompt-file" | "--effort" => {
                // Parsed for CLI compat but not used by mock-claude
                skip_flag_value(args, &mut i);
            }
            "--disallowed-tools" | "--tools" => {
                // Variadic: consume all following non-option args until "--"
                // or next "--flag". Matches Commander.js behavior where
                // <tools...> greedily consumes subsequent positional args.
                i += 1;
                while let Some(next) = args.get(i) {
                    if next == "--" || next.starts_with("--") {
                        break;
                    }
                    i += 1; // skip tool name
                }
            }
            "--settings" => {
                // Skip the flag and its single JSON value argument
                skip_flag_value(args, &mut i);
            }
            "--replay-user-messages" => {
                replay_user_messages = true;
                i += 1;
            }
            "--print"
            | "--verbose"
            | "--dangerously-skip-permissions"
            | "--include-partial-messages" => {
                i += 1;
            }
            "--" => {
                // End of options - everything after is positional
                i += 1;
                for trailing in args.get(i..).unwrap_or_default() {
                    remaining.push(trailing.clone());
                }
                break;
            }
            _ => {
                if !arg.is_empty() {
                    remaining.push(arg.to_string());
                }
                i += 1;
            }
        }
    }

    let prompt = remaining.into_iter().last().unwrap_or_default();

    ParsedArgs {
        input_format,
        output_format,
        replay_user_messages,
        prompt,
    }
}

#[cfg(test)]
mod tests;
