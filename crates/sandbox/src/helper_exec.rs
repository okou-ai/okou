use crate::{ExecResult, ExecTermination};

pub(crate) const HELPER_EXEC_OUTPUT_EXCERPT_BYTES: usize = 8 * 1024;

pub fn helper_exec_succeeded(result: &ExecResult) -> bool {
    matches!(result.termination, ExecTermination::Exited { exit_code: 0 })
}

pub fn helper_exec_termination_label(result: &ExecResult) -> &'static str {
    match result.termination {
        ExecTermination::Exited { .. } => "exited",
        ExecTermination::TimedOut => "timed_out",
        ExecTermination::Cancelled => "cancelled",
        ExecTermination::StartFailed => "start_failed",
        ExecTermination::WaitFailed => "wait_failed",
    }
}

pub fn format_helper_exec_failure(operation: &str, result: &ExecResult) -> String {
    let mut message = match result.termination {
        ExecTermination::Exited { exit_code } => {
            format!("{operation} failed (exit code {exit_code})")
        }
        ExecTermination::TimedOut => format!("{operation} failed (timed out)"),
        ExecTermination::Cancelled => format!("{operation} failed (cancelled)"),
        ExecTermination::StartFailed => format!("{operation} failed (start failed)"),
        ExecTermination::WaitFailed => format!("{operation} failed (wait failed)"),
    };

    if let Some(diagnostic) =
        format_command_output_excerpt("diagnostic", result.diagnostic.as_bytes(), false)
    {
        message.push_str("; ");
        message.push_str(&diagnostic);
    }
    if let Some(stderr) =
        format_command_output_excerpt("stderr", &result.stderr, result.stderr_truncated)
    {
        message.push_str("; ");
        message.push_str(&stderr);
    }
    if let Some(stdout) =
        format_command_output_excerpt("stdout", &result.stdout, result.stdout_truncated)
    {
        message.push_str("; ");
        message.push_str(&stdout);
    }

    message
}

pub fn format_command_output_excerpt(
    label: &str,
    bytes: &[u8],
    sandbox_truncated: bool,
) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }

    // Redact before excerpting so a suffix cannot start inside a URL query and expose it.
    let output = String::from_utf8_lossy(bytes);
    let output = sanitize_command_output_for_diagnostic(output.trim());
    let output = output.trim();
    let (excerpt, omitted_prefix) = diagnostic_output_excerpt(output);
    let excerpt = excerpt.trim();
    if excerpt.is_empty() {
        return None;
    }

    let mut qualifiers = Vec::new();
    if omitted_prefix {
        qualifiers.push("last 8192 bytes");
    } else {
        qualifiers.push("captured");
    }
    if sandbox_truncated {
        qualifiers.push("sandbox-truncated");
    }

    Some(format!("{label} ({}): {excerpt}", qualifiers.join(", ")))
}

fn diagnostic_output_excerpt(input: &str) -> (&str, bool) {
    if input.len() <= HELPER_EXEC_OUTPUT_EXCERPT_BYTES {
        return (input, false);
    }

    let start = input.ceil_char_boundary(input.len() - HELPER_EXEC_OUTPUT_EXCERPT_BYTES);
    (&input[start..], true)
}

fn sanitize_command_output_for_diagnostic(input: &str) -> String {
    redact_url_query_strings(input)
}

fn redact_url_query_strings(input: &str) -> String {
    let mut redacted = String::with_capacity(input.len());
    let mut cursor = 0;

    while cursor < input.len() {
        let Some(scheme) = url_scheme_at(input, cursor) else {
            let Some(ch) = input[cursor..].chars().next() else {
                break;
            };
            redacted.push(ch);
            cursor += ch.len_utf8();
            continue;
        };

        let url_start = cursor;
        let url_body_start = url_start + scheme.len();
        let url_end = find_url_token_end(input, url_body_start);
        let Some(query_offset) = input[url_body_start..url_end].find('?') else {
            redacted.push_str(&input[url_start..url_end]);
            cursor = url_end;
            continue;
        };

        let query_start = url_body_start + query_offset;
        let query_value_start = query_start + '?'.len_utf8();
        redacted.push_str(&input[url_start..query_value_start]);
        redacted.push_str("<redacted>");
        cursor = url_end;
    }

    redacted.push_str(&input[cursor..]);
    redacted
}

fn url_scheme_at(input: &str, index: usize) -> Option<&'static str> {
    ["https://", "http://"].into_iter().find(|scheme| {
        input[index..]
            .get(..scheme.len())
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(scheme))
    })
}

fn find_url_token_end(input: &str, start: usize) -> usize {
    input[start..]
        .char_indices()
        .find_map(|(index, ch)| ch.is_whitespace().then_some(start + index))
        .unwrap_or(input.len())
}

#[cfg(test)]
mod tests;
