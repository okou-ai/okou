use std::path::PathBuf;
use std::time::Duration;

use crate::error::RunnerResult;

use super::target::RunnerServiceUnit;

/// Read systemd's selected unit content and extract the runner `--config` path.
pub(crate) async fn read_unit_config_path(
    unit: &RunnerServiceUnit,
) -> RunnerResult<Option<PathBuf>> {
    let content = super::systemctl::cat_unit_content(unit).await?;
    Ok(parse_unit_config_path(&content))
}

pub(super) async fn read_unit_config_path_bounded(
    unit: &RunnerServiceUnit,
    duration: Duration,
) -> RunnerResult<super::systemctl::BoundedSystemctlQuery<Option<PathBuf>>> {
    match super::systemctl::cat_unit_content_bounded(unit, duration).await? {
        super::systemctl::BoundedSystemctlQuery::Completed(content) => Ok(
            super::systemctl::BoundedSystemctlQuery::Completed(parse_unit_config_path(&content)),
        ),
        super::systemctl::BoundedSystemctlQuery::TimedOut => {
            Ok(super::systemctl::BoundedSystemctlQuery::TimedOut)
        }
    }
}

pub(crate) fn parse_unit_config_path(content: &str) -> Option<PathBuf> {
    let mut config_path = None;
    let mut in_service_section = false;
    for line in logical_unit_lines(content) {
        let trimmed = line.trim();
        if let Some(section) = unit_section_name(trimmed) {
            in_service_section = section == "Service";
            continue;
        }
        if !in_service_section {
            continue;
        }
        let Some((key, rest)) = trimmed.split_once('=') else {
            continue;
        };
        if key.trim() != "ExecStart" {
            continue;
        }
        if rest.trim().is_empty() {
            config_path = None;
            continue;
        }
        if let Some(next_config_path) = parse_exec_start_config(rest) {
            config_path = Some(next_config_path);
        }
    }
    config_path
}

fn unit_section_name(line: &str) -> Option<&str> {
    let section = line.strip_prefix('[')?.strip_suffix(']')?;
    Some(section.trim())
}

fn logical_unit_lines(content: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut continued = String::new();
    for raw_line in content.lines() {
        let line = raw_line.trim_end();
        let trimmed_start = line.trim_start();
        // Full-line comments must neither start nor end a continuation.
        if trimmed_start.is_empty()
            || trimmed_start.starts_with('#')
            || trimmed_start.starts_with(';')
        {
            continue;
        }
        if let Some(prefix) = line.strip_suffix('\\') {
            continued.push_str(prefix);
            continued.push(' ');
            continue;
        }

        if continued.is_empty() {
            lines.push(line.to_string());
        } else {
            continued.push_str(line.trim_start());
            lines.push(std::mem::take(&mut continued));
        }
    }

    if !continued.is_empty() {
        lines.push(continued);
    }

    lines
}

/// Extract the value following `--config` or `-c` from an `ExecStart` line body.
///
/// Handles both quoted (`--config "/path with spaces/f.yaml"`) and unquoted
/// (`--config /simple/path.yaml`) forms. Only the argument value is extracted.
pub(crate) fn parse_exec_start_config(line: &str) -> Option<PathBuf> {
    let tokens = tokenize_systemd_exec_start(line)?;
    for (idx, token) in tokens.iter().enumerate() {
        if token == "--config" || token == "-c" {
            if let Some(config_path) = tokens
                .get(idx + 1)
                .and_then(|value| config_path_from_arg(value))
            {
                return Some(config_path);
            }
            continue;
        }
        if let Some(value) = token
            .strip_prefix("--config=")
            .or_else(|| token.strip_prefix("-c="))
            .and_then(config_path_from_arg)
        {
            return Some(value);
        }
    }
    None
}

fn config_path_from_arg(value: &str) -> Option<PathBuf> {
    if value.is_empty() || value.starts_with('-') {
        return None;
    }
    Some(PathBuf::from(value))
}

fn tokenize_systemd_exec_start(input: &str) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut chars = input.chars().peekable();
    let mut quote = None;
    let mut has_token = false;
    while let Some(ch) = chars.next() {
        if let Some(quote_char) = quote {
            match ch {
                ch if ch == quote_char => quote = None,
                '\\' => match chars.next() {
                    Some(next @ ('\\' | '"' | '\'')) => token.push(next),
                    Some(next) => {
                        token.push('\\');
                        token.push(next);
                    }
                    None => return None,
                },
                '%' if chars.peek() == Some(&'%') => {
                    chars.next();
                    token.push('%');
                }
                '%' => token.push('%'),
                _ => token.push(ch),
            }
        } else {
            match ch {
                ch if ch.is_ascii_whitespace() => {
                    if has_token {
                        tokens.push(std::mem::take(&mut token));
                        has_token = false;
                    }
                }
                '"' | '\'' => {
                    quote = Some(ch);
                    has_token = true;
                }
                '\\' => {
                    has_token = true;
                    match chars.next() {
                        Some(next @ ('\\' | '"' | '\'')) => token.push(next),
                        Some(next) => {
                            token.push('\\');
                            token.push(next);
                        }
                        None => token.push('\\'),
                    }
                }
                '%' if chars.peek() == Some(&'%') => {
                    chars.next();
                    token.push('%');
                    has_token = true;
                }
                '%' => {
                    token.push('%');
                    has_token = true;
                }
                _ => {
                    token.push(ch);
                    has_token = true;
                }
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    if has_token {
        tokens.push(token);
    }
    Some(tokens)
}

runner_test_group!(cmd_service; #[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_config_plain_path() {
        let line = r#""/usr/bin/runner" start --config /data/runner.yaml"#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/data/runner.yaml"))
        );
    }

    #[test]
    fn parse_config_quoted_path_with_spaces() {
        let line = r#""/opt/my runner/vm0-runner" start --config "/opt/my config/runner.yaml""#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/opt/my config/runner.yaml"))
        );
    }

    #[test]
    fn parse_config_single_quoted_path_with_spaces() {
        let line = r#""/usr/bin/runner" start --config '/opt/my config/runner.yaml'"#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/opt/my config/runner.yaml"))
        );
    }

    #[test]
    fn parse_config_quoted_path_with_escaped_characters() {
        let line = r#""/usr/bin/runner" start --config "/tmp/a\"b\\c%%d.yaml""#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from(r#"/tmp/a"b\c%d.yaml"#))
        );
    }

    #[test]
    fn parse_config_quoted_path_without_spaces() {
        let line = r#""/usr/bin/runner" start --config "/etc/runner.yaml" --local"#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/etc/runner.yaml"))
        );
    }

    #[test]
    fn parse_config_short_flag() {
        let line = r#""/usr/bin/runner" start -c "/data/runner.yaml""#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/data/runner.yaml"))
        );
    }

    #[test]
    fn parse_config_missing_flag() {
        let line = r#""/usr/bin/runner" start --local"#;
        assert_eq!(parse_exec_start_config(line), None);
    }

    #[test]
    fn parse_config_flag_at_end_without_value() {
        let line = r#""/usr/bin/runner" start --config"#;
        assert_eq!(parse_exec_start_config(line), None);
    }

    #[test]
    fn parse_config_skips_flag_value_before_valid_config() {
        let line = r#""/usr/bin/runner" start --config --local --config "/data/runner.yaml""#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/data/runner.yaml"))
        );
    }

    #[test]
    fn parse_config_equals_form() {
        let line = r#""/usr/bin/runner" start --config=/data/runner.yaml"#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/data/runner.yaml"))
        );
    }

    #[test]
    fn parse_config_equals_form_quoted() {
        let line = r#""/usr/bin/runner" start --config="/data/my config/runner.yaml""#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/data/my config/runner.yaml"))
        );
    }

    #[test]
    fn parse_config_equals_form_unescapes_percent() {
        let line = r#""/usr/bin/runner" start --config=/data/runner%%config.yaml"#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/data/runner%config.yaml"))
        );
    }

    #[test]
    fn parse_config_ignores_flag_substring_in_exe_path() {
        let line = r#""/opt/nice-cli/runner" start -c "/data/runner.yaml""#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/data/runner.yaml"))
        );
    }

    #[test]
    fn parse_config_ignores_flag_token_inside_quoted_exe_path() {
        let line = r#""/opt/my --config fake/runner" start --config "/data/runner.yaml""#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/data/runner.yaml"))
        );
    }

    #[test]
    fn parse_config_unclosed_quote_returns_none() {
        let line = r#""/usr/bin/runner" start --config "/data/no-close"#;
        assert_eq!(parse_exec_start_config(line), None);
    }

    #[test]
    fn parse_config_tab_separated() {
        let line = "\"/usr/bin/runner\" start --config\t/data/runner.yaml";
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/data/runner.yaml"))
        );
    }

    #[test]
    fn parse_config_short_flag_equals_form() {
        let line = r#""/usr/bin/runner" start -c=/data/runner.yaml"#;
        assert_eq!(
            parse_exec_start_config(line),
            Some(PathBuf::from("/data/runner.yaml"))
        );
    }

    #[test]
    fn parse_unit_config_path_reads_first_exec_start() {
        let content = r#"
[Unit]
Description=runner

[Service]
ExecStart="/usr/bin/runner" start --config "/etc/runner.yaml"
"#;

        assert_eq!(
            parse_unit_config_path(content),
            Some(PathBuf::from("/etc/runner.yaml"))
        );
    }

    #[test]
    fn parse_unit_config_path_allows_space_before_equals() {
        let content = r#"
[Service]
ExecStart = "/usr/bin/runner" start --config "/etc/runner.yaml"
"#;

        assert_eq!(
            parse_unit_config_path(content),
            Some(PathBuf::from("/etc/runner.yaml"))
        );
    }

    #[test]
    fn parse_unit_config_path_ignores_standalone_comments_ending_in_backslash() {
        for marker in ['#', ';'] {
            for indent in ["", " \t"] {
                let content = format!(
                    r#"[Service]
{indent}{marker} runner config example \
ExecStart=/usr/bin/runner start --config /etc/runner.yaml
"#
                );

                assert_eq!(
                    parse_unit_config_path(&content),
                    Some(PathBuf::from("/etc/runner.yaml")),
                    "comment marker {marker:?} with indent {indent:?}"
                );
            }
        }
    }

    #[test]
    fn parse_unit_config_path_comment_does_not_hide_service_section() {
        for marker in ['#', ';'] {
            let content = format!(
                r#"[Unit]
Description=runner
  {marker} service settings \
[Service]
ExecStart=/usr/bin/runner start --config /etc/runner.yaml
"#
            );

            assert_eq!(
                parse_unit_config_path(&content),
                Some(PathBuf::from("/etc/runner.yaml")),
                "comment marker {marker:?}"
            );
        }
    }

    #[test]
    fn parse_unit_config_path_comment_does_not_hide_leaving_service_section() {
        for marker in ['#', ';'] {
            let content = format!(
                r#"[Service]
ExecStart=/usr/bin/runner start --config /etc/runner.yaml
  {marker} install settings \
[Install]
ExecStart=/usr/bin/runner start --config /etc/wrong-runner.yaml
"#
            );

            assert_eq!(
                parse_unit_config_path(&content),
                Some(PathBuf::from("/etc/runner.yaml")),
                "comment marker {marker:?}"
            );
        }
    }

    #[test]
    fn parse_unit_config_path_preserves_comment_markers_inside_arguments() {
        let content = r#"[Service]
ExecStart=/usr/bin/runner start --config "/etc/#runner;config.yaml"
"#;

        assert_eq!(
            parse_unit_config_path(content),
            Some(PathBuf::from("/etc/#runner;config.yaml"))
        );
    }

    #[test]
    fn parse_unit_config_path_ignores_exec_start_outside_service_section() {
        let content = r#"
[Service]
ExecStart="/usr/bin/runner" start --config "/etc/runner.yaml"

[Unit]
ExecStart="/usr/bin/runner" start --config "/etc/wrong-runner.yaml"
"#;

        assert_eq!(
            parse_unit_config_path(content),
            Some(PathBuf::from("/etc/runner.yaml"))
        );
    }

    #[test]
    fn parse_unit_config_path_handles_continued_exec_start() {
        let content = r#"
[Service]
ExecStart="/usr/bin/runner" start \
  --config "/etc/runner.yaml" \
  --local
"#;

        assert_eq!(
            parse_unit_config_path(content),
            Some(PathBuf::from("/etc/runner.yaml"))
        );
    }

    #[test]
    fn parse_unit_config_path_continues_past_comment_lines() {
        let content = r#"
[Service]
ExecStart="/usr/bin/runner" start \
  # comment between continued lines \

  ; another comment \
  --config "/etc/runner.yaml"
"#;

        assert_eq!(
            parse_unit_config_path(content),
            Some(PathBuf::from("/etc/runner.yaml"))
        );
    }

    #[test]
    fn parse_unit_config_path_honors_exec_start_reset() {
        let content = r#"
[Service]
ExecStart="/usr/bin/runner" start --config "/etc/old-runner.yaml"
ExecStart=
ExecStart="/usr/bin/runner" start --config "/etc/new-runner.yaml"
"#;

        assert_eq!(
            parse_unit_config_path(content),
            Some(PathBuf::from("/etc/new-runner.yaml"))
        );
    }

    #[test]
    fn parse_unit_config_path_reset_without_replacement_returns_none() {
        let content = r#"
[Service]
ExecStart="/usr/bin/runner" start --config "/etc/old-runner.yaml"
ExecStart=
"#;

        assert_eq!(parse_unit_config_path(content), None);
    }

    #[test]
    fn parse_unit_config_path_comments_preserve_drop_in_reset_and_replacement() {
        for marker in ['#', ';'] {
            for (replacement, expected) in [
                (
                    "/usr/bin/runner start --config /etc/new-runner.yaml",
                    Some("/etc/new-runner.yaml"),
                ),
                ("/usr/bin/true", None),
            ] {
                let content = format!(
                    r#"# /etc/systemd/system/vm0-runner-test.service
[Service]
ExecStart=/usr/bin/runner start --config /etc/old-runner.yaml

# /run/systemd/system/vm0-runner-test.service.d/override.conf
[Service]
  {marker} reset original command \
ExecStart=
  {marker} replacement command \
ExecStart={replacement}
"#
                );

                assert_eq!(
                    parse_unit_config_path(&content),
                    expected.map(PathBuf::from),
                    "comment marker {marker:?}, replacement {replacement:?}"
                );
            }
        }
    }

    #[test]
    fn parse_unit_config_path_skips_unparseable_exec_start() {
        let content = r#"
[Service]
ExecStart=
ExecStart="/usr/bin/runner" start --config "/etc/runner.yaml"
"#;

        assert_eq!(
            parse_unit_config_path(content),
            Some(PathBuf::from("/etc/runner.yaml"))
        );
    }

    #[test]
    fn parse_unit_config_path_applies_systemd_selected_content_in_order() {
        let content = r#"
# /etc/systemd/system/vm0-runner-v1.0.0.service
[Service]
ExecStart="/usr/bin/runner" start --config "/etc/base-runner.yaml"

# /usr/lib/systemd/system/vm0-runner-.service.d/10-vendor.conf
[Service]
ExecStart=
ExecStart="/usr/bin/runner" start --config "/etc/vendor-runner.yaml"

# /run/systemd/system/vm0-runner-v1.0.0.service.d/20-runtime.conf
[Service]
ExecStart=
ExecStart="/usr/bin/runner" start --config "/etc/runtime-runner.yaml"
"#;

        assert_eq!(
            parse_unit_config_path(content),
            Some(PathBuf::from("/etc/runtime-runner.yaml"))
        );
    }
});
