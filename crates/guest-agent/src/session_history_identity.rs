//! Final session-history identity helpers for checkpoint and runner reuse.

use crate::env;
use crate::error::AgentError;
use crate::session_history;
use api_contracts::generated::constants::runners::RESUME_SESSION_HISTORY_MAX_BYTES;
use guest_contracts::codex_thread_id::canonical_codex_thread_id;
use guest_contracts::env::CliFramework;
use guest_contracts::session_history_identity::{
    FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_EXPECTED_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FRAMEWORK_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_METADATA,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ, SessionHistoryFramework,
    SessionHistoryIdentity, SessionHistoryIdentityError, SessionHistoryIdentityExpectation,
    SessionHistoryRefKind, SessionHistorySourceRef,
};
use sha2::{Digest, Sha256};
use std::fmt;
use std::io;
use std::path::Path;

/// Build final session-history identity metadata for a successful checkpoint.
pub(crate) fn build_final_session_history_identity(
    framework: env::Framework,
    cli_agent_session_id: &str,
    history_hash: &str,
    history_size_bytes: u64,
    history_source: &SessionHistorySourceRef,
) -> Result<SessionHistoryIdentity, SessionHistoryIdentityBuildError> {
    let session_id_hash = session_id_hash(framework, cli_agent_session_id)
        .ok_or(SessionHistoryIdentityBuildError::InvalidSessionId)?;
    let framework = final_framework(framework);
    SessionHistoryIdentity::new(
        framework,
        session_id_hash,
        SessionHistoryRefKind::Blob,
        history_hash,
        history_size_bytes,
        history_source.clone(),
    )
    .map_err(SessionHistoryIdentityBuildError::InvalidMetadata)
}

fn session_id_hash(framework: env::Framework, session_id: &str) -> Option<String> {
    let normalized = match framework {
        env::Framework::ClaudeCode => session_id.to_owned(),
        env::Framework::Codex => canonical_codex_thread_id(session_id)?,
        env::Framework::Pi => session_id.to_owned(),
    };
    Some(hex::encode(Sha256::digest(normalized.as_bytes())))
}

fn final_framework(framework: env::Framework) -> SessionHistoryFramework {
    SessionHistoryFramework::from(CliFramework::from(framework))
}

/// Verify the current guest session history matches final identity metadata.
pub fn verify_final_session_history_identity_file(
    metadata_path: impl AsRef<Path>,
    expected: Option<&SessionHistoryIdentityExpectation>,
) -> Result<(), SessionHistoryIdentityVerifyError> {
    let identity = read_final_session_history_identity(metadata_path)?;
    if let Some(expected) = expected
        && !expected.matches_identity(&identity)
    {
        return Err(SessionHistoryIdentityVerifyError::ExpectedIdentityMismatch);
    }
    verify_final_session_history_identity(&identity)
}

pub(crate) fn read_final_session_history_identity(
    metadata_path: impl AsRef<Path>,
) -> Result<SessionHistoryIdentity, SessionHistoryIdentityVerifyError> {
    let metadata_path = metadata_path.as_ref();
    let read_limit =
        usize::try_from(FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES + 1).map_err(|_| {
            SessionHistoryIdentityVerifyError::InvalidMetadata(
                SessionHistoryIdentityError::MetadataTooLarge,
            )
        })?;
    let bytes =
        match guest_contracts::runtime_paths::read_private_bounded(metadata_path, read_limit) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return Err(SessionHistoryIdentityVerifyError::MetadataRead),
            Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                return Err(SessionHistoryIdentityVerifyError::InvalidMetadata(
                    SessionHistoryIdentityError::MetadataTooLarge,
                ));
            }
            Err(_) => return Err(SessionHistoryIdentityVerifyError::MetadataRead),
        };
    if bytes.len() as u64 > FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES {
        return Err(SessionHistoryIdentityVerifyError::InvalidMetadata(
            SessionHistoryIdentityError::MetadataTooLarge,
        ));
    }
    SessionHistoryIdentity::from_json_slice(&bytes)
        .map_err(SessionHistoryIdentityVerifyError::InvalidMetadata)
}

pub(crate) fn verify_final_session_history_identity(
    identity: &SessionHistoryIdentity,
) -> Result<(), SessionHistoryIdentityVerifyError> {
    let history_source = validated_history_source(identity)?;
    verify_final_session_history_identity_constraints(identity)?;
    let digest = session_history::digest_session_history_from_source_bounded(
        history_source,
        identity.history_size_bytes,
    )
    .map_err(map_session_history_digest_error)?;
    verify_final_session_history_digest(identity, &digest)
}

/// Verify the actual named file belongs to the retained home mount, including
/// bounded Pi source uniqueness and inode/mtime revalidation after hashing.
pub(crate) fn verify_retained_home_identity(
    identity: &SessionHistoryIdentity,
) -> Result<(), SessionHistoryIdentityVerifyError> {
    let source = validated_history_source(identity)?;
    verify_final_session_history_identity_constraints(identity)?;
    if let SessionHistorySourceRef::Pi {
        session_path,
        session_id,
    } = source
    {
        verify_unique_pi_source(session_path, session_id)
            .map_err(SessionHistoryIdentityVerifyError::HistoryRead)?;
    }
    let digest = session_history::resolve_session_history_from_source(source)
        .map_err(SessionHistoryIdentityVerifyError::HistoryRead)?
        .digest_retained_home(identity.history_size_bytes)
        .map_err(map_session_history_digest_error)?;
    verify_final_session_history_digest(identity, &digest)
}

fn verify_unique_pi_source(path: &str, session_id: &str) -> Result<(), AgentError> {
    #[cfg(target_os = "linux")]
    {
        let source_path = Path::new(path);
        let parent = source_path
            .parent()
            .ok_or_else(|| AgentError::Checkpoint("invalid Pi history source".into()))?;
        let directory = crate::nofollow_fs::Dir::open_absolute(parent)
            .map_err(|_| AgentError::Checkpoint("unsafe Pi history source".into()))?;
        let mut count = 0usize;
        for (index, entry) in directory
            .read_dir()
            .map_err(|_| AgentError::Checkpoint("Pi history lookup failed".into()))?
            .enumerate()
        {
            if index >= 16_384 {
                return Err(AgentError::Checkpoint(
                    "Pi history lookup exceeds budget".into(),
                ));
            }
            let entry =
                entry.map_err(|_| AgentError::Checkpoint("Pi history lookup failed".into()))?;
            let candidate = parent.join(entry.file_name());
            if candidate.to_str().is_some_and(|candidate| {
                crate::session_metadata::is_pi_session_history_path(candidate, session_id)
            }) {
                // A competing symlink or nonregular entry is not silently ignored.
                let file = directory
                    .open_child_file(&entry.file_name())
                    .map_err(|_| AgentError::Checkpoint("unsafe Pi history candidate".into()))?;
                if !file.metadata().is_ok_and(|metadata| metadata.is_file()) {
                    return Err(AgentError::Checkpoint(
                        "invalid Pi history candidate".into(),
                    ));
                }
                count += 1;
                if candidate != source_path || count > 1 {
                    return Err(AgentError::Checkpoint("ambiguous Pi history source".into()));
                }
            }
        }
        if count == 1 {
            Ok(())
        } else {
            Err(AgentError::Checkpoint("Pi history source missing".into()))
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (path, session_id);
        Err(AgentError::Checkpoint(
            "Pi history verification requires descriptor safety".into(),
        ))
    }
}

fn verify_final_session_history_identity_constraints(
    identity: &SessionHistoryIdentity,
) -> Result<(), SessionHistoryIdentityVerifyError> {
    if identity.history_size_bytes > RESUME_SESSION_HISTORY_MAX_BYTES {
        return Err(SessionHistoryIdentityVerifyError::HistoryTooLarge);
    }
    Ok(())
}

fn validated_history_source(
    identity: &SessionHistoryIdentity,
) -> Result<&SessionHistorySourceRef, SessionHistoryIdentityVerifyError> {
    let source_session_id = match (&identity.framework, &identity.history_source) {
        (
            SessionHistoryFramework::ClaudeCode,
            SessionHistorySourceRef::ClaudeCode { session_id, .. },
        ) => session_id.as_str(),
        (SessionHistoryFramework::Codex, SessionHistorySourceRef::Codex { thread_id, .. }) => {
            thread_id.as_str()
        }
        (SessionHistoryFramework::Pi, SessionHistorySourceRef::Pi { session_id, .. }) => {
            session_id.as_str()
        }
        _ => return Err(SessionHistoryIdentityVerifyError::FrameworkMismatch),
    };
    let framework = match identity.framework {
        SessionHistoryFramework::ClaudeCode => env::Framework::ClaudeCode,
        SessionHistoryFramework::Codex => env::Framework::Codex,
        SessionHistoryFramework::Pi => env::Framework::Pi,
    };
    if session_id_hash(framework, source_session_id).as_deref() != Some(&identity.session_id_hash) {
        return Err(SessionHistoryIdentityVerifyError::FrameworkMismatch);
    }
    Ok(&identity.history_source)
}

fn verify_final_session_history_digest(
    identity: &SessionHistoryIdentity,
    digest: &session_history::SessionHistoryDigest,
) -> Result<(), SessionHistoryIdentityVerifyError> {
    if digest.size_bytes != identity.history_size_bytes {
        return Err(SessionHistoryIdentityVerifyError::HistoryMismatch);
    }
    if digest.sha256_hex != identity.history_hash {
        return Err(SessionHistoryIdentityVerifyError::HistoryMismatch);
    }
    Ok(())
}

fn map_session_history_digest_error(
    error: session_history::SessionHistoryDigestError,
) -> SessionHistoryIdentityVerifyError {
    match error {
        session_history::SessionHistoryDigestError::Read(error) => {
            SessionHistoryIdentityVerifyError::HistoryRead(error)
        }
        session_history::SessionHistoryDigestError::ExceedsMaxBytes => {
            SessionHistoryIdentityVerifyError::HistoryMismatch
        }
    }
}

/// Error returned while building final identity metadata.
#[derive(Debug)]
pub(crate) enum SessionHistoryIdentityBuildError {
    /// Session id cannot be normalized for the current framework.
    InvalidSessionId,
    /// Metadata violates the shared final identity contract.
    InvalidMetadata(SessionHistoryIdentityError),
}

impl fmt::Display for SessionHistoryIdentityBuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSessionId => {
                f.write_str("final session history identity session id is invalid")
            }
            Self::InvalidMetadata(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for SessionHistoryIdentityBuildError {}

/// Error returned while verifying final identity metadata.
#[derive(Debug)]
pub enum SessionHistoryIdentityVerifyError {
    /// Metadata file could not be read.
    MetadataRead,
    /// Metadata failed shared contract validation.
    InvalidMetadata(SessionHistoryIdentityError),
    /// Metadata framework does not match its history source.
    FrameworkMismatch,
    /// Metadata does not match the identity runner expected to verify.
    ExpectedIdentityMismatch,
    /// Session history could not be resolved, read, or decoded.
    HistoryRead(AgentError),
    /// Session history size or hash does not match metadata.
    HistoryMismatch,
    /// Session history exceeds the guest helper verification budget.
    HistoryTooLarge,
}

impl SessionHistoryIdentityVerifyError {
    /// Return the stable helper exit code for this verification failure.
    pub fn helper_exit_code(&self) -> i32 {
        match self {
            Self::MetadataRead => SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ,
            Self::InvalidMetadata(_) => SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_METADATA,
            Self::FrameworkMismatch => SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FRAMEWORK_MISMATCH,
            Self::ExpectedIdentityMismatch => {
                SESSION_HISTORY_IDENTITY_VERIFY_EXIT_EXPECTED_MISMATCH
            }
            Self::HistoryRead(_) => SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ,
            Self::HistoryMismatch => SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH,
            Self::HistoryTooLarge => SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE,
        }
    }
}

impl fmt::Display for SessionHistoryIdentityVerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MetadataRead => f.write_str("final session history identity could not be read"),
            Self::InvalidMetadata(error) => write!(f, "{error}"),
            Self::FrameworkMismatch => {
                f.write_str("final session history identity framework mismatch")
            }
            Self::ExpectedIdentityMismatch => {
                f.write_str("final session history identity did not match expected identity")
            }
            Self::HistoryRead(_) => f.write_str("final session history could not be read"),
            Self::HistoryMismatch => f.write_str("final session history did not match identity"),
            Self::HistoryTooLarge => {
                f.write_str("final session history exceeds verification budget")
            }
        }
    }
}

impl std::error::Error for SessionHistoryIdentityVerifyError {}

#[cfg(test)]
mod tests {
    use super::*;

    const LARGE_SESSION_HISTORY_SIZE_BYTES: usize = 1024 * 1024 + 1;
    const PREVIOUS_GUEST_VERIFY_CAP_BYTES: u64 = 32 * 1024 * 1024;
    const CLAUDE_SESSION_ID: &str = "session-identity-test";

    fn write_metadata(
        dir: &tempfile::TempDir,
        identity: &SessionHistoryIdentity,
    ) -> std::path::PathBuf {
        let path = dir.path().join("identity.json");
        crate::paths::write_private(&path, identity.to_json_vec().unwrap()).unwrap();
        path
    }

    fn repeated_byte_sha256(byte: u8, len: u64) -> String {
        let mut hasher = Sha256::new();
        let buffer = [byte; 8192];
        let mut remaining = len;
        while remaining > 0 {
            let chunk_len = remaining.min(buffer.len() as u64) as usize;
            hasher.update(&buffer[..chunk_len]);
            remaining -= chunk_len as u64;
        }
        hex::encode(hasher.finalize())
    }

    fn session_hash(session_id: &str) -> String {
        hex::encode(Sha256::digest(session_id.as_bytes()))
    }

    fn claude_history_source(
        dir: &tempfile::TempDir,
    ) -> (std::path::PathBuf, SessionHistorySourceRef) {
        let config_dir = dir.path().join("claude-config");
        let history_path = config_dir
            .join("projects")
            .join("-home-user-workspace")
            .join(format!("{CLAUDE_SESSION_ID}.jsonl"));
        std::fs::create_dir_all(history_path.parent().unwrap()).unwrap();
        (
            history_path,
            SessionHistorySourceRef::ClaudeCode {
                config_dir: config_dir.to_string_lossy().into_owned(),
                working_dir: crate::paths::CANONICAL_WORKING_DIR.to_string(),
                session_id: CLAUDE_SESSION_ID.to_string(),
            },
        )
    }

    fn claude_identity(
        source: SessionHistorySourceRef,
        history_hash: impl Into<String>,
        history_size: u64,
    ) -> SessionHistoryIdentity {
        SessionHistoryIdentity::new(
            SessionHistoryFramework::ClaudeCode,
            session_hash(CLAUDE_SESSION_ID),
            SessionHistoryRefKind::Blob,
            history_hash,
            history_size,
            source,
        )
        .unwrap()
    }

    #[test]
    fn verifies_claude_literal_history() {
        let dir = tempfile::tempdir().unwrap();
        let history = br#"{"type":"system"}"#;
        let (history_path, source) = claude_history_source(&dir);
        std::fs::write(&history_path, history).unwrap();
        let identity = claude_identity(
            source,
            hex::encode(Sha256::digest(history)),
            history.len() as u64,
        );
        let metadata_path = write_metadata(&dir, &identity);

        verify_final_session_history_identity_file(metadata_path, None).unwrap();
    }

    #[test]
    fn builds_pi_jsonl_history_identity() {
        let session_id = "00000000-0000-4000-8000-000000000001";
        let history = br#"{"type":"session","id":"00000000-0000-4000-8000-000000000001"}"#;
        let history_path = format!(
            "{}/restored-{session_id}.jsonl",
            api_contracts::generated::constants::runners::paths::CANONICAL_PI_SESSION_DIR,
        );
        let history_source = SessionHistorySourceRef::Pi {
            session_path: history_path,
            session_id: session_id.to_string(),
        };
        let identity = build_final_session_history_identity(
            env::Framework::Pi,
            session_id,
            &hex::encode(Sha256::digest(history)),
            history.len() as u64,
            &history_source,
        )
        .unwrap();

        assert_eq!(identity.framework, SessionHistoryFramework::Pi);
        assert_eq!(identity.history_source, history_source);
        assert_eq!(
            identity.session_id_hash,
            hex::encode(Sha256::digest(session_id.as_bytes()))
        );
    }

    #[test]
    fn verifies_codex_history_source() {
        let dir = tempfile::tempdir().unwrap();
        let sessions_dir = dir.path().join("sessions");
        let history_dir = sessions_dir.join("2026").join("06").join("29");
        std::fs::create_dir_all(&history_dir).unwrap();
        let thread_id = "00000000-0000-4000-8000-000000000001";
        let history = br#"{"type":"session_meta","timestamp":"2026-06-29T10:00:00Z"}"#;
        std::fs::write(
            history_dir.join("rollout-2026-06-29T10-00-00-00000000000040008000000000000001.jsonl"),
            history,
        )
        .unwrap();
        let source = SessionHistorySourceRef::Codex {
            sessions_dir: sessions_dir.to_string_lossy().into_owned(),
            thread_id: thread_id.to_string(),
        };
        let identity = SessionHistoryIdentity::new(
            SessionHistoryFramework::Codex,
            session_hash(thread_id),
            SessionHistoryRefKind::Blob,
            hex::encode(Sha256::digest(history)),
            history.len() as u64,
            source,
        )
        .unwrap();
        let metadata_path = write_metadata(&dir, &identity);

        verify_final_session_history_identity_file(metadata_path, None).unwrap();
    }

    #[test]
    fn verifies_codex_zstd_history_source() {
        let dir = tempfile::tempdir().unwrap();
        let sessions_dir = dir.path().join("sessions");
        let history_dir = sessions_dir.join("2026").join("06").join("29");
        std::fs::create_dir_all(&history_dir).unwrap();
        let thread_id = "00000000-0000-4000-8000-000000000001";
        let history = br#"{"type":"session_meta","timestamp":"2026-06-29T10:00:00Z"}"#;
        let compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
        std::fs::write(
            history_dir
                .join("rollout-2026-06-29T10-00-00-00000000000040008000000000000001.jsonl.zst"),
            compressed,
        )
        .unwrap();
        let source = SessionHistorySourceRef::Codex {
            sessions_dir: sessions_dir.to_string_lossy().into_owned(),
            thread_id: thread_id.to_string(),
        };
        let identity = SessionHistoryIdentity::new(
            SessionHistoryFramework::Codex,
            session_hash(thread_id),
            SessionHistoryRefKind::Blob,
            hex::encode(Sha256::digest(history)),
            history.len() as u64,
            source,
        )
        .unwrap();
        let metadata_path = write_metadata(&dir, &identity);

        verify_final_session_history_identity_file(metadata_path, None).unwrap();
    }

    #[test]
    fn rejects_history_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let (history_path, source) = claude_history_source(&dir);
        std::fs::write(&history_path, b"changed").unwrap();
        let identity = claude_identity(source, "b".repeat(64), 7);
        let metadata_path = write_metadata(&dir, &identity);

        let err = verify_final_session_history_identity_file(metadata_path, None).unwrap_err();
        assert!(matches!(
            err,
            SessionHistoryIdentityVerifyError::HistoryMismatch
        ));
    }

    #[test]
    fn rejects_oversized_metadata_file() {
        let dir = tempfile::tempdir().unwrap();
        let metadata_path = dir.path().join("identity.json");
        crate::paths::write_private(
            &metadata_path,
            vec![b'x'; FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES as usize + 1],
        )
        .unwrap();

        let err = verify_final_session_history_identity_file(metadata_path, None).unwrap_err();
        assert!(matches!(
            err,
            SessionHistoryIdentityVerifyError::InvalidMetadata(
                SessionHistoryIdentityError::MetadataTooLarge
            )
        ));
    }

    #[test]
    fn build_allows_large_history_metadata() {
        let identity = claude_identity(
            SessionHistorySourceRef::ClaudeCode {
                config_dir: "/claude-config".to_string(),
                working_dir: crate::paths::CANONICAL_WORKING_DIR.to_string(),
                session_id: CLAUDE_SESSION_ID.to_string(),
            },
            "b".repeat(64),
            LARGE_SESSION_HISTORY_SIZE_BYTES as u64,
        );

        assert_eq!(
            identity.history_size_bytes,
            LARGE_SESSION_HISTORY_SIZE_BYTES as u64
        );
    }

    #[test]
    fn verifies_large_claude_literal_history() {
        let dir = tempfile::tempdir().unwrap();
        let (history_path, source) = claude_history_source(&dir);
        let history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
        std::fs::write(&history_path, &history).unwrap();
        let identity = claude_identity(
            source,
            hex::encode(Sha256::digest(&history)),
            history.len() as u64,
        );
        let metadata_path = write_metadata(&dir, &identity);

        verify_final_session_history_identity_file(metadata_path, None).unwrap();
    }

    #[test]
    fn verifies_history_above_previous_guest_verify_cap() {
        let history_size = PREVIOUS_GUEST_VERIFY_CAP_BYTES + 1;
        assert!(history_size < RESUME_SESSION_HISTORY_MAX_BYTES);

        let dir = tempfile::tempdir().unwrap();
        let (history_path, source) = claude_history_source(&dir);
        std::fs::File::create(&history_path)
            .unwrap()
            .set_len(history_size)
            .unwrap();
        let identity = claude_identity(source, repeated_byte_sha256(0, history_size), history_size);
        let metadata_path = write_metadata(&dir, &identity);

        verify_final_session_history_identity_file(metadata_path, None).unwrap();
    }

    #[test]
    fn rejects_current_history_larger_than_identity_size() {
        let dir = tempfile::tempdir().unwrap();
        let (history_path, source) = claude_history_source(&dir);
        let expected_history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES - 1];
        let oversized_history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
        std::fs::write(&history_path, oversized_history).unwrap();
        let identity = claude_identity(
            source,
            hex::encode(Sha256::digest(&expected_history)),
            expected_history.len() as u64,
        );
        let metadata_path = write_metadata(&dir, &identity);

        let err = verify_final_session_history_identity_file(metadata_path, None).unwrap_err();
        assert!(matches!(
            err,
            SessionHistoryIdentityVerifyError::HistoryMismatch
        ));
    }

    #[test]
    fn rejects_history_above_resume_cap() {
        let dir = tempfile::tempdir().unwrap();
        let (history_path, source) = claude_history_source(&dir);
        std::fs::write(&history_path, b"small").unwrap();
        let identity =
            claude_identity(source, "b".repeat(64), RESUME_SESSION_HISTORY_MAX_BYTES + 1);
        let metadata_path = write_metadata(&dir, &identity);

        let err = verify_final_session_history_identity_file(metadata_path, None).unwrap_err();
        assert!(matches!(
            err,
            SessionHistoryIdentityVerifyError::HistoryTooLarge
        ));
    }

    #[test]
    fn rejects_expected_identity_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let history = br#"{"type":"system"}"#;
        let (history_path, source) = claude_history_source(&dir);
        std::fs::write(&history_path, history).unwrap();
        let identity = claude_identity(
            source,
            hex::encode(Sha256::digest(history)),
            history.len() as u64,
        );
        let expected = SessionHistoryIdentityExpectation::new(
            SessionHistoryFramework::ClaudeCode,
            session_hash(CLAUDE_SESSION_ID),
            SessionHistoryRefKind::Blob,
            "b".repeat(64),
            history.len() as u64,
        )
        .unwrap();
        let metadata_path = write_metadata(&dir, &identity);

        let err =
            verify_final_session_history_identity_file(metadata_path, Some(&expected)).unwrap_err();
        assert!(matches!(
            err,
            SessionHistoryIdentityVerifyError::ExpectedIdentityMismatch
        ));
    }
}
