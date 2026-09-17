//! Shared final session-history identity metadata.
//!
//! The guest-agent writes this run-private metadata after a successful
//! checkpoint. Runner consumes it to decide whether a parked idle sandbox can
//! safely skip session-history restore on a later same-session run.

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
/// Guest helper exit code for sidecar output create or write failure.
///
/// Exit code 10 previously represented sidecar export unavailability and
/// remains reserved for that historical meaning.
pub const SESSION_HISTORY_SIDECAR_EXPORT_EXIT_WRITE_FAILURE: i32 = 11;
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

/// Native on-disk representation used for cached session-history sidecars.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionHistorySidecarRepresentation {
    /// Uncompressed session-history bytes.
    Raw,
    /// Codex zstd session-history bytes.
    CodexZstd,
}

/// Metadata printed by the guest sidecar export helper.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistorySidecarExportMetadata {
    /// Representation written to the exported sidecar file.
    pub representation: SessionHistorySidecarRepresentation,
    /// Exact byte length of the exported sidecar file.
    pub encoded_size: u64,
    /// Guest helper timings, not persisted in workspace-cache metadata.
    pub timings: SessionHistorySidecarExportTimings,
}

/// Monotonic wall-clock durations and thread resources for one successful sidecar export.
///
/// Runner and the helper ship together. These fields are private helper output,
/// not a workspace-cache format or independently deployed API contract.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistorySidecarExportTimings {
    /// Read and validate final identity metadata and its size/identity constraints.
    pub metadata_us: u64,
    /// Locate and safely open the unique history source.
    pub resolve_us: u64,
    /// Read, optionally decode, buffer and hash the source, then verify its digest.
    pub read_verify_us: u64,
    /// Create and write the verified export file; does not include host copying.
    pub write_us: u64,
    /// Total helper work; excludes process startup, result serialization and exit.
    pub total_us: u64,
    /// Read/verify thread resources, or unavailable if either snapshot failed.
    pub read_verify_resources: Option<SessionHistorySidecarResourceUsage>,
    /// Write thread resources, or unavailable if either snapshot failed.
    pub write_resources: Option<SessionHistorySidecarResourceUsage>,
}

/// Per-stage deltas from Linux `getrusage(RUSAGE_THREAD)` on the synchronous exporter.
///
/// These exclude other threads. Zero is a measured value, not missing data. Faults
/// include allocation effects; block counters are accounting operations, not bytes
/// or disk latency. Wall time minus CPU time is not a measurement of disk wait.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistorySidecarResourceUsage {
    /// User CPU time in microseconds.
    pub user_cpu_us: u64,
    /// System CPU time in microseconds.
    pub system_cpu_us: u64,
    /// Page faults serviced without I/O.
    pub minor_faults: u64,
    /// Page faults requiring I/O.
    pub major_faults: u64,
    /// Filesystem input operations counted by `ru_inblock`.
    pub input_blocks: u64,
    /// Filesystem output operations counted by `ru_oublock`.
    pub output_blocks: u64,
    /// Voluntary context switches.
    pub voluntary_context_switches: u64,
    /// Involuntary context switches.
    pub involuntary_context_switches: u64,
}

/// Safe low-cardinality I/O class emitted for a sidecar output failure.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionHistorySidecarIoErrorClass {
    /// A required filesystem object was not found.
    NotFound,
    /// Filesystem permissions rejected the operation.
    PermissionDenied,
    /// The filesystem had no storage space available.
    StorageFull,
    /// The filesystem quota was exhausted.
    QuotaExceeded,
    /// The I/O failure has no more specific safe class.
    Unknown,
}

impl SessionHistorySidecarIoErrorClass {
    /// Return the stable telemetry label for this class.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotFound => "not-found",
            Self::PermissionDenied => "permission-denied",
            Self::StorageFull => "storage-full",
            Self::QuotaExceeded => "quota-exceeded",
            Self::Unknown => "unknown",
        }
    }
}

/// Safe metadata printed when sidecar output creation or writing fails.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistorySidecarExportFailure {
    /// Low-cardinality class of the output I/O failure.
    pub io_error_class: SessionHistorySidecarIoErrorClass,
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
        }
    }

    /// Parse the stable CLI argument spelling used by runner and guest-agent.
    pub fn parse_cli_arg(value: &str) -> Result<Self, SessionHistoryIdentityError> {
        match value {
            "blob" => Ok(Self::Blob),
            _ => Err(SessionHistoryIdentityError::InvalidHistoryRefKind),
        }
    }
}

/// Expected final identity fields supplied by runner when verifying a parked
/// sandbox's checkpointed metadata.
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
mod tests {
    use super::*;

    #[test]
    fn cli_framework_projects_to_session_history_wire_values() {
        for (framework, expected, wire_value) in [
            (
                crate::env::CliFramework::ClaudeCode,
                SessionHistoryFramework::ClaudeCode,
                "claude-code",
            ),
            (
                crate::env::CliFramework::Codex,
                SessionHistoryFramework::Codex,
                "codex",
            ),
            (
                crate::env::CliFramework::Pi,
                SessionHistoryFramework::Pi,
                "pi",
            ),
        ] {
            let projected = SessionHistoryFramework::from(framework);

            assert_eq!(projected, expected);
            assert_eq!(projected.as_str(), wire_value);
        }
    }

    fn valid_source() -> SessionHistorySourceRef {
        SessionHistorySourceRef::ClaudeCode {
            config_dir: "/home/user/.claude".to_string(),
            working_dir: "/home/user/workspace".to_string(),
            session_id: "session".to_string(),
        }
    }

    #[test]
    fn session_history_identity_verify_exit_codes_are_stable() {
        assert_eq!(
            [
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS,
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FAILURE,
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS,
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ,
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_METADATA,
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FRAMEWORK_MISMATCH,
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_EXPECTED_MISMATCH,
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ,
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH,
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE,
                SESSION_HISTORY_SIDECAR_EXPORT_EXIT_WRITE_FAILURE,
            ],
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11]
        );
    }

    #[test]
    fn sidecar_export_failure_round_trips_json() {
        let failure = SessionHistorySidecarExportFailure {
            io_error_class: SessionHistorySidecarIoErrorClass::StorageFull,
        };

        let json = serde_json::to_vec(&failure).unwrap();

        assert_eq!(
            serde_json::from_slice::<SessionHistorySidecarExportFailure>(&json).unwrap(),
            failure
        );
        assert_eq!(failure.io_error_class.as_str(), "storage-full");
    }

    #[test]
    fn sidecar_export_resources_round_trip_with_bounded_payload() {
        let maximum = SessionHistorySidecarResourceUsage {
            user_cpu_us: u64::MAX,
            system_cpu_us: u64::MAX,
            minor_faults: u64::MAX,
            major_faults: u64::MAX,
            input_blocks: u64::MAX,
            output_blocks: u64::MAX,
            voluntary_context_switches: u64::MAX,
            involuntary_context_switches: u64::MAX,
        };
        for read_verify_resources in [Some(maximum), Some(Default::default()), None] {
            for write_resources in [Some(maximum), Some(Default::default()), None] {
                let metadata = SessionHistorySidecarExportMetadata {
                    representation: SessionHistorySidecarRepresentation::CodexZstd,
                    encoded_size: u64::MAX,
                    timings: SessionHistorySidecarExportTimings {
                        metadata_us: u64::MAX,
                        resolve_us: u64::MAX,
                        read_verify_us: u64::MAX,
                        write_us: u64::MAX,
                        total_us: u64::MAX,
                        read_verify_resources,
                        write_resources,
                    },
                };
                let json = serde_json::to_vec(&metadata).unwrap();
                assert!(json.len() < 2048, "helper summary must stay bounded");
                assert_eq!(
                    serde_json::from_slice::<SessionHistorySidecarExportMetadata>(&json).unwrap(),
                    metadata
                );
            }
        }
    }

    fn valid_identity() -> SessionHistoryIdentity {
        SessionHistoryIdentity::new(
            SessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            SessionHistoryRefKind::Blob,
            "b".repeat(64),
            12,
            valid_source(),
        )
        .unwrap()
    }

    #[test]
    fn final_identity_round_trips_json() {
        let identity = valid_identity();
        let bytes = identity.to_json_vec().unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

        assert_eq!(
            SessionHistoryIdentity::from_json_slice(&bytes).unwrap(),
            identity
        );
        assert_eq!(value["framework"], "claude-code");
        assert_eq!(value["historyRefKind"], "blob");
        assert!(value.get("version").is_none());
        assert!(value.get("historySource").is_some());
        assert!(value.get("historyMarkerPayload").is_none());
    }

    #[test]
    fn final_identity_rejects_invalid_hashes() {
        let err = SessionHistoryIdentity::new(
            SessionHistoryFramework::ClaudeCode,
            "not-a-hash",
            SessionHistoryRefKind::Blob,
            "b".repeat(64),
            12,
            valid_source(),
        )
        .unwrap_err();
        assert_eq!(err, SessionHistoryIdentityError::InvalidSessionIdHash);

        let err = SessionHistoryIdentity::new(
            SessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            SessionHistoryRefKind::Blob,
            "not-a-hash",
            12,
            valid_source(),
        )
        .unwrap_err();
        assert_eq!(err, SessionHistoryIdentityError::InvalidHistoryHash);
    }

    #[test]
    fn final_identity_rejects_zero_history() {
        let err = SessionHistoryIdentity::new(
            SessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            SessionHistoryRefKind::Blob,
            "b".repeat(64),
            0,
            valid_source(),
        )
        .unwrap_err();
        assert_eq!(err, SessionHistoryIdentityError::InvalidHistorySize);
    }

    #[test]
    fn final_identity_accepts_large_history_size() {
        let identity = SessionHistoryIdentity::new(
            SessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            SessionHistoryRefKind::Blob,
            "b".repeat(64),
            u64::MAX,
            valid_source(),
        )
        .unwrap();

        assert_eq!(identity.history_size_bytes, u64::MAX);
        assert_eq!(
            SessionHistoryIdentity::from_json_slice(&identity.to_json_vec().unwrap()).unwrap(),
            identity
        );
    }

    #[test]
    fn final_identity_rejects_invalid_history_source() {
        let err = SessionHistoryIdentity::new(
            SessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            SessionHistoryRefKind::Blob,
            "b".repeat(64),
            12,
            SessionHistorySourceRef::ClaudeCode {
                config_dir: String::new(),
                working_dir: "/home/user/workspace".to_string(),
                session_id: "session".to_string(),
            },
        )
        .unwrap_err();
        assert_eq!(err, SessionHistoryIdentityError::InvalidHistorySource);
    }

    #[test]
    fn final_identity_rejects_history_source_from_another_framework() {
        let err = SessionHistoryIdentity::new(
            SessionHistoryFramework::Codex,
            "a".repeat(64),
            SessionHistoryRefKind::Blob,
            "b".repeat(64),
            12,
            valid_source(),
        )
        .unwrap_err();

        assert_eq!(err, SessionHistoryIdentityError::InvalidHistorySource);
    }

    #[test]
    fn final_identity_debug_redacts_sensitive_fields() {
        let identity = valid_identity();
        let debug = format!("{identity:?}");

        assert!(debug.contains("[redacted]"));
        assert!(!debug.contains(&identity.session_id_hash));
        assert!(!debug.contains(&identity.history_hash));
        assert!(!debug.contains("/home/user/.claude"));
        assert!(!debug.contains("/home/user/workspace"));
    }

    #[test]
    fn verify_request_round_trips_and_rejects_unknown_fields() {
        let request = SessionHistoryIdentityVerifyRequest {
            metadata_path: "/runtime/final.json".to_string(),
            runtime_dir: "/runtime".to_string(),
            expectation: SessionHistoryIdentityExpectation::new(
                SessionHistoryFramework::ClaudeCode,
                "a".repeat(64),
                SessionHistoryRefKind::Blob,
                "b".repeat(64),
                12,
            )
            .unwrap(),
        };
        request.validate().unwrap();
        let json = serde_json::to_string(&request).unwrap();
        assert_eq!(
            serde_json::from_str::<SessionHistoryIdentityVerifyRequest>(&json).unwrap(),
            request
        );

        let json = json.strip_suffix('}').unwrap().to_string() + ",\"command\":\"sh\"}";
        assert!(serde_json::from_str::<SessionHistoryIdentityVerifyRequest>(&json).is_err());

        let nested_json = serde_json::to_string(&request).unwrap().replace(
            "\"historySizeBytes\":12",
            "\"historySizeBytes\":12,\"command\":\"sh\"",
        );
        assert!(serde_json::from_str::<SessionHistoryIdentityVerifyRequest>(&nested_json).is_err());
    }

    #[test]
    fn verify_request_validation_rejects_non_absolute_paths() {
        let request = SessionHistoryIdentityVerifyRequest {
            metadata_path: String::new(),
            runtime_dir: "/runtime".to_string(),
            expectation: SessionHistoryIdentityExpectation::new(
                SessionHistoryFramework::ClaudeCode,
                "a".repeat(64),
                SessionHistoryRefKind::Blob,
                "b".repeat(64),
                12,
            )
            .unwrap(),
        };

        assert_eq!(
            request.validate(),
            Err(SessionHistoryIdentityVerifyRequestError::InvalidPath)
        );

        let request = SessionHistoryIdentityVerifyRequest {
            metadata_path: "runtime/final.json".to_string(),
            runtime_dir: "/runtime".to_string(),
            expectation: SessionHistoryIdentityExpectation::new(
                SessionHistoryFramework::ClaudeCode,
                "a".repeat(64),
                SessionHistoryRefKind::Blob,
                "b".repeat(64),
                12,
            )
            .unwrap(),
        };
        assert_eq!(
            request.validate(),
            Err(SessionHistoryIdentityVerifyRequestError::InvalidPath)
        );
    }

    #[test]
    fn final_identity_expectation_parses_cli_args_and_matches_identity() {
        let identity = valid_identity();
        assert_eq!(identity.framework.as_str(), "claude-code");
        assert_eq!(identity.history_ref_kind.as_str(), "blob");
        let expectation = SessionHistoryIdentityExpectation::from_cli_args([
            identity.framework.as_str(),
            &identity.session_id_hash,
            identity.history_ref_kind.as_str(),
            &identity.history_hash,
            &identity.history_size_bytes.to_string(),
        ])
        .unwrap();

        assert!(expectation.matches_identity(&identity));
    }

    #[test]
    fn final_identity_expectation_accepts_large_history_size() {
        let expectation = SessionHistoryIdentityExpectation::new(
            SessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            SessionHistoryRefKind::Blob,
            "b".repeat(64),
            u64::MAX,
        )
        .unwrap();

        assert_eq!(expectation.history_size_bytes, u64::MAX);
    }

    #[test]
    fn final_identity_expectation_detects_mismatch() {
        let identity = valid_identity();
        let expectation = SessionHistoryIdentityExpectation::new(
            identity.framework,
            identity.session_id_hash.clone(),
            identity.history_ref_kind,
            "c".repeat(64),
            identity.history_size_bytes,
        )
        .unwrap();

        assert!(!expectation.matches_identity(&identity));
    }

    #[test]
    fn final_identity_expectation_debug_redacts_sensitive_fields() {
        let identity = valid_identity();
        let expectation = SessionHistoryIdentityExpectation::new(
            identity.framework,
            identity.session_id_hash.clone(),
            identity.history_ref_kind,
            identity.history_hash.clone(),
            identity.history_size_bytes,
        )
        .unwrap();
        let debug = format!("{expectation:?}");

        assert!(debug.contains("[redacted]"));
        assert!(!debug.contains(&identity.session_id_hash));
        assert!(!debug.contains(&identity.history_hash));
    }
}
