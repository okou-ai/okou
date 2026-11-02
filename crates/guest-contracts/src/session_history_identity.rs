//! Shared final session-history identity metadata.
//!
//! The guest-agent writes this run-private metadata after a successful
//! session-history upload. Runner consumes it to decide whether a parked idle
//! sandbox can safely skip session-history restore on a later same-session run.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::Path;

/// Maximum size of the serialized final identity metadata file.
pub const FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES: u64 = 16 * 1024;

/// Guest helper exit code for successful final identity verification.
pub const SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS: i32 = 0;
/// Guest helper exit code for uncategorized final identity verification failure.
pub const SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FAILURE: i32 = 1;
/// Guest helper exit code for invalid command arguments.
pub const SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS: i32 = 2;
/// Guest helper exit code for metadata read failure.
pub const SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ: i32 = 3;
/// Guest helper exit code for invalid metadata.
pub const SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_METADATA: i32 = 4;
/// Guest helper exit code for framework/source mismatch.
pub const SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FRAMEWORK_MISMATCH: i32 = 5;
/// Guest helper exit code for expected identity mismatch.
pub const SESSION_HISTORY_IDENTITY_VERIFY_EXIT_EXPECTED_MISMATCH: i32 = 6;
/// Guest helper exit code for local history read failure.
pub const SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ: i32 = 7;
/// Guest helper exit code for local history size/hash mismatch.
pub const SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH: i32 = 8;
/// Guest helper exit code for local history exceeding the guest verification budget.
pub const SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE: i32 = 9;
/// Fixed exec diagnostic label for direct live identity verification.
pub const SESSION_HISTORY_IDENTITY_VERIFY_DIAGNOSTIC_LABEL: &str =
    "session-history-identity-verify";
/// Fixed stdout/stderr capture bound for live identity verification.
pub const SESSION_HISTORY_IDENTITY_VERIFY_OUTPUT_LIMIT_BYTES: u32 = 64 * 1024;
/// Framework that owns session-history bytes.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionHistoryFramework {
    /// Claude Code session history.
    ClaudeCode,
    /// Codex session history.
    Codex,
    /// Pi official JSONL session history.
    Pi,
}

impl From<crate::env::CliFramework> for SessionHistoryFramework {
    fn from(framework: crate::env::CliFramework) -> Self {
        match framework {
            crate::env::CliFramework::ClaudeCode => Self::ClaudeCode,
            crate::env::CliFramework::Codex => Self::Codex,
            crate::env::CliFramework::Pi => Self::Pi,
        }
    }
}

/// Storage ref kind for session-history bytes.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionHistoryRefKind {
    /// Hash-backed blob storage.
    Blob,
    /// Integrity of disposable native bytes retained only in the local home.
    LocalHome,
}

/// Canonical framework-owned source for final session-history bytes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SessionHistorySourceRef {
    /// Claude Code history derived from its effective config directory and cwd.
    ClaudeCode {
        /// Effective Claude config directory from the finalized child environment.
        #[serde(rename = "configDir")]
        config_dir: String,
        /// Explicit working directory used to launch Claude Code.
        #[serde(rename = "workingDir")]
        working_dir: String,
        /// Validated Claude Code session identifier captured from the event stream.
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    /// Codex history discovered below its finalized sessions directory.
    Codex {
        /// Final guest-agent-controlled Codex sessions directory.
        #[serde(rename = "sessionsDir")]
        sessions_dir: String,
        /// Canonical Codex thread identifier captured from the event stream.
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    /// Pi official JSONL history reported for the captured session.
    Pi {
        /// Absolute path below the canonical Pi session directory.
        #[serde(rename = "sessionPath")]
        session_path: String,
        /// Session identifier bound to the reported filename.
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

impl SessionHistorySourceRef {
    fn validate(&self) -> Result<(), SessionHistoryIdentityError> {
        let valid = match self {
            Self::ClaudeCode {
                config_dir,
                working_dir,
                session_id,
            } => !config_dir.is_empty() && !working_dir.is_empty() && !session_id.is_empty(),
            Self::Codex {
                sessions_dir,
                thread_id,
            } => !sessions_dir.is_empty() && !thread_id.is_empty(),
            Self::Pi {
                session_path,
                session_id,
            } => !session_path.is_empty() && !session_id.is_empty(),
        };
        if valid {
            Ok(())
        } else {
            Err(SessionHistoryIdentityError::InvalidHistorySource)
        }
    }
}

/// Run-private final session-history identity metadata.
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryIdentity {
    /// CLI framework.
    pub framework: SessionHistoryFramework,
    /// SHA-256 hash of the framework-normalized CLI session id.
    pub session_id_hash: String,
    /// Server resume history ref kind.
    pub history_ref_kind: SessionHistoryRefKind,
    /// SHA-256 hash of final session-history bytes.
    pub history_hash: String,
    /// Exact final session-history byte length.
    pub history_size_bytes: u64,
    /// Canonical structured source used to read final framework history.
    pub history_source: SessionHistorySourceRef,
}

impl SessionHistoryIdentity {
    /// Build validated final identity metadata.
    pub fn new(
        framework: SessionHistoryFramework,
        session_id_hash: impl Into<String>,
        history_ref_kind: SessionHistoryRefKind,
        history_hash: impl Into<String>,
        history_size_bytes: u64,
        history_source: SessionHistorySourceRef,
    ) -> Result<Self, SessionHistoryIdentityError> {
        let identity = Self {
            framework,
            session_id_hash: session_id_hash.into(),
            history_ref_kind,
            history_hash: history_hash.into(),
            history_size_bytes,
            history_source,
        };
        identity.validate()?;
        Ok(identity)
    }

    /// Parse and validate final identity metadata from JSON bytes.
    pub fn from_json_slice(bytes: &[u8]) -> Result<Self, SessionHistoryIdentityError> {
        if bytes.len() as u64 > FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES {
            return Err(SessionHistoryIdentityError::MetadataTooLarge);
        }
        let identity: Self =
            serde_json::from_slice(bytes).map_err(|_| SessionHistoryIdentityError::InvalidJson)?;
        identity.validate()?;
        Ok(identity)
    }

    /// Serialize validated final identity metadata to JSON bytes.
    pub fn to_json_vec(&self) -> Result<Vec<u8>, SessionHistoryIdentityError> {
        self.validate()?;
        let bytes =
            serde_json::to_vec(self).map_err(|_| SessionHistoryIdentityError::InvalidJson)?;
        if bytes.len() as u64 > FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES {
            return Err(SessionHistoryIdentityError::MetadataTooLarge);
        }
        Ok(bytes)
    }

    /// Validate final identity metadata invariants.
    pub fn validate(&self) -> Result<(), SessionHistoryIdentityError> {
        if !is_sha256_hex(&self.session_id_hash) {
            return Err(SessionHistoryIdentityError::InvalidSessionIdHash);
        }
        if !is_sha256_hex(&self.history_hash) {
            return Err(SessionHistoryIdentityError::InvalidHistoryHash);
        }
        if self.history_size_bytes == 0 {
            return Err(SessionHistoryIdentityError::InvalidHistorySize);
        }
        self.history_source.validate()?;
        if !matches!(
            (self.framework, &self.history_source),
            (
                SessionHistoryFramework::ClaudeCode,
                SessionHistorySourceRef::ClaudeCode { .. }
            ) | (
                SessionHistoryFramework::Codex,
                SessionHistorySourceRef::Codex { .. }
            ) | (
                SessionHistoryFramework::Pi,
                SessionHistorySourceRef::Pi { .. }
            )
        ) {
            return Err(SessionHistoryIdentityError::InvalidHistorySource);
        }
        Ok(())
    }
}

impl SessionHistoryFramework {
    /// Return the stable CLI argument spelling used by runner and guest-agent.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::Pi => "pi",
        }
    }

    /// Parse the stable CLI argument spelling used by runner and guest-agent.
    pub fn parse_cli_arg(value: &str) -> Result<Self, SessionHistoryIdentityError> {
        match value {
            "claude-code" => Ok(Self::ClaudeCode),
            "codex" => Ok(Self::Codex),
            "pi" => Ok(Self::Pi),
            _ => Err(SessionHistoryIdentityError::InvalidFramework),
        }
    }
}

impl SessionHistoryRefKind {
    /// Return the stable CLI argument spelling used by runner and guest-agent.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Blob => "blob",
            Self::LocalHome => "local-home",
        }
    }

    /// Parse the stable CLI argument spelling used by runner and guest-agent.
    pub fn parse_cli_arg(value: &str) -> Result<Self, SessionHistoryIdentityError> {
        match value {
            "blob" => Ok(Self::Blob),
            "local-home" => Ok(Self::LocalHome),
            _ => Err(SessionHistoryIdentityError::InvalidHistoryRefKind),
        }
    }
}

/// Expected final identity fields supplied by runner when verifying a parked
/// sandbox's saved session-history metadata.
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SessionHistoryIdentityExpectation {
    /// CLI framework expected by runner.
    pub framework: SessionHistoryFramework,
    /// SHA-256 hash of the framework-normalized CLI session id expected by runner.
    pub session_id_hash: String,
    /// Server resume history ref kind expected by runner.
    pub history_ref_kind: SessionHistoryRefKind,
    /// SHA-256 hash of final session-history bytes expected by runner.
    pub history_hash: String,
    /// Exact final session-history byte length expected by runner.
    pub history_size_bytes: u64,
}

/// Structured fixed-helper request carried by the internal verifier process role.
///
/// Runner and the bundled guest are deployed atomically. This shape prevents
/// the fixed verifier launch from accepting an executable, arbitrary arguments,
/// sudo, stdin, or arbitrary environment variables.
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SessionHistoryIdentityVerifyRequest {
    /// Absolute path to the final identity metadata inside the guest.
    pub metadata_path: String,
    /// Absolute canonical runtime directory exposed to the helper.
    pub runtime_dir: String,
    /// Identity fields that the live guest metadata and history must match.
    pub expectation: SessionHistoryIdentityExpectation,
}

impl fmt::Debug for SessionHistoryIdentityVerifyRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionHistoryIdentityVerifyRequest")
            .field("metadata_path", &"[redacted]")
            .field("runtime_dir", &"[redacted]")
            .field("expectation", &self.expectation)
            .finish()
    }
}

impl SessionHistoryIdentityVerifyRequest {
    /// Validate fields before the guest constructs the fixed helper process.
    pub fn validate(&self) -> Result<(), SessionHistoryIdentityVerifyRequestError> {
        if !Path::new(&self.metadata_path).is_absolute()
            || !Path::new(&self.runtime_dir).is_absolute()
        {
            return Err(SessionHistoryIdentityVerifyRequestError::InvalidPath);
        }
        self.expectation
            .validate()
            .map_err(SessionHistoryIdentityVerifyRequestError::InvalidExpectation)
    }
}

/// Validation failure for the internal fixed verifier launch request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionHistoryIdentityVerifyRequestError {
    /// A required guest path is not absolute.
    InvalidPath,
    /// The expected identity fields violate the shared identity contract.
    InvalidExpectation(SessionHistoryIdentityError),
}

impl fmt::Display for SessionHistoryIdentityVerifyRequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath => {
                f.write_str("final session history identity verifier path is invalid")
            }
            Self::InvalidExpectation(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for SessionHistoryIdentityVerifyRequestError {}

impl fmt::Debug for SessionHistoryIdentityExpectation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionHistoryIdentityExpectation")
            .field("framework", &self.framework)
            .field("session_id_hash", &"[redacted]")
            .field("history_ref_kind", &self.history_ref_kind)
            .field("history_hash", &"[redacted]")
            .field("history_size_bytes", &self.history_size_bytes)
            .finish()
    }
}

impl SessionHistoryIdentityExpectation {
    /// Build validated expected final identity fields.
    pub fn new(
        framework: SessionHistoryFramework,
        session_id_hash: impl Into<String>,
        history_ref_kind: SessionHistoryRefKind,
        history_hash: impl Into<String>,
        history_size_bytes: u64,
    ) -> Result<Self, SessionHistoryIdentityError> {
        let expectation = Self {
            framework,
            session_id_hash: session_id_hash.into(),
            history_ref_kind,
            history_hash: history_hash.into(),
            history_size_bytes,
        };
        expectation.validate()?;
        Ok(expectation)
    }

    /// Parse expected final identity fields from helper CLI arguments.
    pub fn from_cli_args(args: [&str; 5]) -> Result<Self, SessionHistoryIdentityError> {
        let history_size_bytes = args[4]
            .parse::<u64>()
            .map_err(|_| SessionHistoryIdentityError::InvalidHistorySize)?;
        Self::new(
            SessionHistoryFramework::parse_cli_arg(args[0])?,
            args[1],
            SessionHistoryRefKind::parse_cli_arg(args[2])?,
            args[3],
            history_size_bytes,
        )
    }

    /// Validate expected final identity invariants.
    pub fn validate(&self) -> Result<(), SessionHistoryIdentityError> {
        if !is_sha256_hex(&self.session_id_hash) {
            return Err(SessionHistoryIdentityError::InvalidSessionIdHash);
        }
        if !is_sha256_hex(&self.history_hash) {
            return Err(SessionHistoryIdentityError::InvalidHistoryHash);
        }
        if self.history_size_bytes == 0 {
            return Err(SessionHistoryIdentityError::InvalidHistorySize);
        }
        Ok(())
    }

    /// Return whether metadata read from the guest still matches runner's expected identity.
    pub fn matches_identity(&self, identity: &SessionHistoryIdentity) -> bool {
        self.framework == identity.framework
            && self.session_id_hash == identity.session_id_hash
            && self.history_ref_kind == identity.history_ref_kind
            && self.history_hash == identity.history_hash
            && self.history_size_bytes == identity.history_size_bytes
    }
}

impl fmt::Debug for SessionHistoryIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionHistoryIdentity")
            .field("framework", &self.framework)
            .field("session_id_hash", &"[redacted]")
            .field("history_ref_kind", &self.history_ref_kind)
            .field("history_hash", &"[redacted]")
            .field("history_size_bytes", &self.history_size_bytes)
            .field("history_source", &"[redacted]")
            .finish()
    }
}

/// Final identity metadata validation error.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionHistoryIdentityError {
    /// Metadata file exceeds the metadata read cap.
    MetadataTooLarge,
    /// Metadata is not valid JSON.
    InvalidJson,
    /// Framework value is not recognized.
    InvalidFramework,
    /// History ref kind value is not recognized.
    InvalidHistoryRefKind,
    /// Session id hash is not a SHA-256 hex digest.
    InvalidSessionIdHash,
    /// History hash is not a SHA-256 hex digest.
    InvalidHistoryHash,
    /// History size is zero.
    InvalidHistorySize,
    /// Metadata contains an invalid structured history source.
    InvalidHistorySource,
}

impl fmt::Display for SessionHistoryIdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MetadataTooLarge => f.write_str("final session history identity is too large"),
            Self::InvalidJson => f.write_str("final session history identity is invalid JSON"),
            Self::InvalidFramework => {
                f.write_str("final session history identity framework is invalid")
            }
            Self::InvalidHistoryRefKind => {
                f.write_str("final session history identity ref kind is invalid")
            }
            Self::InvalidSessionIdHash => {
                f.write_str("final session history identity session id hash is invalid")
            }
            Self::InvalidHistoryHash => {
                f.write_str("final session history identity history hash is invalid")
            }
            Self::InvalidHistorySize => {
                f.write_str("final session history identity history size is invalid")
            }
            Self::InvalidHistorySource => {
                f.write_str("final session history identity source is invalid")
            }
        }
    }
}

impl std::error::Error for SessionHistoryIdentityError {}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

#[cfg(test)]
mod tests;
