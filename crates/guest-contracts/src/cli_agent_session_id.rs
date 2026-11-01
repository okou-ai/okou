//! Shared base CLI agent session ID lexical contract.
//!
//! Session IDs cross the guest/runner boundary and can become guest filenames.
//! This base contract therefore keeps them short and restricts them to a
//! conservative ASCII set. Frameworks may impose stricter rules; for example,
//! Codex additionally requires a UUID through [`crate::codex_thread_id`].

/// Maximum accepted base CLI agent session ID length in bytes.
pub const MAX_CLI_AGENT_SESSION_ID_BYTES: usize = 128;

/// Returns whether a CLI agent session ID satisfies the shared base lexical contract.
pub fn is_valid_cli_agent_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_CLI_AGENT_SESSION_ID_BYTES
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[cfg(test)]
mod tests;
