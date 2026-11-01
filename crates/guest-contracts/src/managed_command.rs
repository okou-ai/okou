//! Versioned transport for commands rewritten by the managed shell hook.
//!
//! The hook replaces a Bash command with one deterministic executor invocation.
//! Its envelope uses only shell-safe ASCII, so provider event normalization can
//! recover the original command without parsing or evaluating shell quoting.

use std::error::Error;
use std::fmt;

use base64::Engine as _;

use crate::guest_binary::TOOL_EXEC_PATH;

/// Prefix of the executor argument carrying one managed command envelope.
pub const COMMAND_ENVELOPE_ARGUMENT_PREFIX: &str = "--command-envelope=";

const COMMAND_ENVELOPE_PREFIX: &str = "vm0.command.";
const COMMAND_ENVELOPE_VERSION: &str = "v1";
const MANAGED_SHELL_SEPARATOR: &str = " --shell ";
const OUTER_SHELL_PREFIXES: [&str; 2] = ["/bin/bash -c ", "/bin/bash -lc "];

/// Failure to encode or decode the managed command transport.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManagedCommandError {
    /// The command contains a NUL byte that cannot cross the process boundary.
    ContainsNul,
    /// The managed executor invocation does not match the deterministic contract.
    InvalidInvocation,
    /// The command envelope is malformed or truncated.
    InvalidEnvelope,
    /// The command envelope names an unsupported protocol version.
    UnsupportedVersion,
    /// The decoded command length differs from the envelope's declared length.
    LengthMismatch,
    /// The decoded command is not valid UTF-8.
    InvalidUtf8,
}

impl fmt::Display for ManagedCommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::ContainsNul => "managed command contains a null byte",
            Self::InvalidInvocation => "managed command invocation is invalid",
            Self::InvalidEnvelope => "managed command envelope is invalid",
            Self::UnsupportedVersion => "managed command envelope version is unsupported",
            Self::LengthMismatch => "managed command envelope length does not match its payload",
            Self::InvalidUtf8 => "managed command envelope payload is not valid UTF-8",
        };
        formatter.write_str(message)
    }
}

impl Error for ManagedCommandError {}

/// Encode one original command as the current deterministic envelope version.
///
/// The encoded value contains only ASCII letters, digits, dots, hyphens, and
/// underscores. Its declared byte length makes truncated payloads detectable.
///
/// # Errors
///
/// Returns [`ManagedCommandError::ContainsNul`] when `command` contains NUL.
pub fn encode_command_envelope(command: &str) -> Result<String, ManagedCommandError> {
    if command.contains('\0') {
        return Err(ManagedCommandError::ContainsNul);
    }
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(command.as_bytes());
    Ok(format!(
        "{COMMAND_ENVELOPE_PREFIX}{COMMAND_ENVELOPE_VERSION}.{}.{payload}",
        command.len()
    ))
}

/// Decode one exact managed command envelope without evaluating its contents.
///
/// # Errors
///
/// Returns an error for malformed, truncated, non-canonical, unknown-version,
/// non-UTF-8, length-mismatched, or NUL-containing envelopes.
pub fn decode_command_envelope(envelope: &str) -> Result<String, ManagedCommandError> {
    let version_and_payload = envelope
        .strip_prefix(COMMAND_ENVELOPE_PREFIX)
        .ok_or(ManagedCommandError::InvalidEnvelope)?;
    let (version, length_and_payload) = version_and_payload
        .split_once('.')
        .ok_or(ManagedCommandError::InvalidEnvelope)?;
    if version != COMMAND_ENVELOPE_VERSION {
        return Err(ManagedCommandError::UnsupportedVersion);
    }
    let (declared_length, payload) = length_and_payload
        .split_once('.')
        .ok_or(ManagedCommandError::InvalidEnvelope)?;
    if declared_length.is_empty()
        || payload.contains('.')
        || (declared_length.len() > 1 && declared_length.starts_with('0'))
        || !payload
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ManagedCommandError::InvalidEnvelope);
    }
    let declared_length = declared_length
        .parse::<usize>()
        .map_err(|_| ManagedCommandError::InvalidEnvelope)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| ManagedCommandError::InvalidEnvelope)?;
    if base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&decoded) != payload {
        return Err(ManagedCommandError::InvalidEnvelope);
    }
    if decoded.len() != declared_length {
        return Err(ManagedCommandError::LengthMismatch);
    }
    let command = String::from_utf8(decoded).map_err(|_| ManagedCommandError::InvalidUtf8)?;
    if command.contains('\0') {
        return Err(ManagedCommandError::ContainsNul);
    }
    Ok(command)
}

/// Render the deterministic shell command installed by the managed Bash hook.
///
/// # Errors
///
/// Returns [`ManagedCommandError::ContainsNul`] when `command` contains NUL.
pub fn render_managed_shell_command(command: &str) -> Result<String, ManagedCommandError> {
    let envelope = encode_command_envelope(command)?;
    Ok(format!(
        "exec {TOOL_EXEC_PATH} {COMMAND_ENVELOPE_ARGUMENT_PREFIX}{envelope} --shell \"$0\""
    ))
}

/// Recover an original command from a managed provider command representation.
///
/// Direct Claude Code hook output and Codex's outer `/bin/bash -c` or
/// `/bin/bash -lc` display form use the same embedded envelope. Commands that
/// do not begin with a managed executor invocation return `Ok(None)` unchanged.
/// No shell syntax is parsed or evaluated.
///
/// # Errors
///
/// Returns an error when a recognized managed invocation has a malformed,
/// truncated, ambiguous, or unsupported envelope.
pub fn decode_managed_shell_command(
    provider_command: &str,
) -> Result<Option<String>, ManagedCommandError> {
    let executable = format!("exec {TOOL_EXEC_PATH}");
    let legacy_executable = format!("exec '{TOOL_EXEC_PATH}'");
    let candidate = provider_command_candidate(provider_command);
    let Some(after_executable) = candidate.strip_prefix(&executable) else {
        if candidate.starts_with(&legacy_executable)
            || (candidate.starts_with("exec ")
                && (candidate.contains(COMMAND_ENVELOPE_ARGUMENT_PREFIX)
                    || candidate.contains(COMMAND_ENVELOPE_PREFIX)))
        {
            return Err(ManagedCommandError::InvalidInvocation);
        }
        return Ok(None);
    };
    let envelope_prefix = format!(" {COMMAND_ENVELOPE_ARGUMENT_PREFIX}");
    let after_envelope_prefix = after_executable
        .strip_prefix(&envelope_prefix)
        .ok_or(ManagedCommandError::InvalidInvocation)?;
    let envelope_end = after_envelope_prefix
        .find(MANAGED_SHELL_SEPARATOR)
        .ok_or(ManagedCommandError::InvalidInvocation)?;
    let envelope = &after_envelope_prefix[..envelope_end];
    let shell = &after_envelope_prefix[envelope_end + MANAGED_SHELL_SEPARATOR.len()..];
    if shell.is_empty()
        || shell.contains(&executable)
        || shell.contains(COMMAND_ENVELOPE_ARGUMENT_PREFIX)
        || shell.contains(COMMAND_ENVELOPE_PREFIX)
    {
        return Err(ManagedCommandError::InvalidInvocation);
    }
    decode_command_envelope(envelope).map(Some)
}

fn provider_command_candidate(provider_command: &str) -> &str {
    for outer_prefix in OUTER_SHELL_PREFIXES {
        let Some(outer_command) = provider_command.strip_prefix(outer_prefix) else {
            continue;
        };
        if matches!(outer_command.as_bytes().first(), Some(b'\'' | b'"')) {
            return &outer_command[1..];
        }
        return outer_command;
    }
    provider_command
}

#[cfg(test)]
mod tests;
