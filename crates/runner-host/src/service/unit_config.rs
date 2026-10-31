use std::path::PathBuf;
use std::time::Duration;

use crate::error::HostResult;

use super::target::RunnerServiceUnit;

/// Read systemd's selected unit content and extract the runner `--config` path.
pub async fn read_unit_config_path(unit: &RunnerServiceUnit) -> HostResult<Option<PathBuf>> {
    let content = super::systemctl::cat_unit_content(unit).await?;
    Ok(parse_unit_config_path(&content))
}

pub async fn read_unit_config_path_bounded(
    unit: &RunnerServiceUnit,
    duration: Duration,
) -> HostResult<super::systemctl::BoundedSystemctlQuery<Option<PathBuf>>> {
    match super::systemctl::cat_unit_content_bounded(unit, duration).await? {
        super::systemctl::BoundedSystemctlQuery::Completed(content) => Ok(
            super::systemctl::BoundedSystemctlQuery::Completed(parse_unit_config_path(&content)),
        ),
        super::systemctl::BoundedSystemctlQuery::TimedOut => {
            Ok(super::systemctl::BoundedSystemctlQuery::TimedOut)
        }
    }
}

pub fn parse_unit_config_path(content: &str) -> Option<PathBuf> {
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
fn parse_exec_start_config(line: &str) -> Option<PathBuf> {
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

#[cfg(test)]
mod tests;
