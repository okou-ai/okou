//! Native history identity retained in disposable sandbox/home state.
//!
//! Final metadata supplies the content identity and verifier paths needed for
//! live guest verification. Hashes and paths stay redacted in Debug output.

use std::fmt;

use guest_contracts::session_history_identity::{
    FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES, SessionHistoryFramework, SessionHistoryIdentity,
    SessionHistoryRefKind,
};

/// Content identity and verifier provenance for retained native history.
#[derive(Clone, Eq)]
pub struct RestoredSessionIdentity {
    framework: SessionHistoryFramework,
    session_id_hash: String,
    history_ref_kind: SessionHistoryRefKind,
    history_hash: String,
    history_size_bytes: Option<u64>,
    verifier: Option<RestoredSessionIdentityVerifier>,
}

#[derive(Clone, Eq, PartialEq)]
enum RestoredSessionIdentityVerifier {
    FinalIdentityMetadata {
        metadata_path: String,
        runtime_dir: String,
    },
}

/// Borrowed final-metadata inputs for live verification in a retained sandbox.
///
/// Presence of this projection means the identity has usable verifier
/// provenance. It does not mean the guest's current metadata and history have
/// already passed live verification.
pub struct RestoredSessionFinalMetadataVerification<'a> {
    pub metadata_path: &'a str,
    pub runtime_dir: &'a str,
    pub framework: SessionHistoryFramework,
    pub session_id_hash: &'a str,
    pub history_ref_kind: SessionHistoryRefKind,
    pub history_hash: &'a str,
    pub history_size_bytes: u64,
}

impl RestoredSessionIdentity {
    /// Builds a retained identity from validated final session-history metadata.
    ///
    /// Returns `None` when the metadata is invalid or the supplied metadata
    /// path and runtime directory cannot form a usable verification
    /// projection.
    pub fn from_final_metadata(
        metadata: SessionHistoryIdentity,
        metadata_path: impl Into<String>,
        runtime_dir: impl Into<String>,
    ) -> Option<Self> {
        metadata.validate().ok()?;
        let identity = Self {
            framework: metadata.framework,
            session_id_hash: metadata.session_id_hash,
            history_ref_kind: metadata.history_ref_kind,
            history_hash: metadata.history_hash,
            history_size_bytes: Some(metadata.history_size_bytes),
            verifier: Some(RestoredSessionIdentityVerifier::FinalIdentityMetadata {
                metadata_path: metadata_path.into(),
                runtime_dir: runtime_dir.into(),
            }),
        };
        identity
            .has_final_metadata_verification()
            .then_some(identity)
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn claude_code_for_test(history_hash: impl Into<String>) -> Self {
        use sha2::{Digest, Sha256};

        Self {
            framework: SessionHistoryFramework::ClaudeCode,
            session_id_hash: hex::encode(Sha256::digest(b"sess-restore-plan")),
            history_ref_kind: SessionHistoryRefKind::Blob,
            history_hash: history_hash.into(),
            history_size_bytes: None,
            verifier: None,
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn history_hash(&self) -> &str {
        &self.history_hash
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn history_size_bytes(&self) -> Option<u64> {
        self.history_size_bytes
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn final_metadata_path(&self) -> Option<&str> {
        match &self.verifier {
            Some(RestoredSessionIdentityVerifier::FinalIdentityMetadata {
                metadata_path, ..
            }) => Some(metadata_path),
            _ => None,
        }
    }

    /// Returns the inputs needed to verify final metadata inside the guest.
    ///
    /// The identity must contain a history size and final-metadata verifier,
    /// and both the metadata path and runtime directory must be absolute. This
    /// method only exposes verification inputs; the executor separately runs
    /// and evaluates the live guest verification.
    pub fn final_metadata_verification(
        &self,
    ) -> Option<RestoredSessionFinalMetadataVerification<'_>> {
        let expected_size = self.history_size_bytes?;
        match self.verifier.as_ref()? {
            RestoredSessionIdentityVerifier::FinalIdentityMetadata {
                metadata_path,
                runtime_dir,
            } => {
                if !metadata_path.starts_with('/') || !runtime_dir.starts_with('/') {
                    return None;
                }
                Some(RestoredSessionFinalMetadataVerification {
                    metadata_path,
                    runtime_dir,
                    framework: self.framework,
                    session_id_hash: &self.session_id_hash,
                    history_ref_kind: self.history_ref_kind,
                    history_hash: &self.history_hash,
                    history_size_bytes: expected_size,
                })
            }
        }
    }

    /// Returns whether final-metadata verification inputs are available.
    pub fn has_final_metadata_verification(&self) -> bool {
        self.final_metadata_verification().is_some()
    }
}

/// Compares the structural content identity only.
///
/// Equality includes framework, hashed normalized session identity, history
/// ref kind, and history hash. It intentionally excludes history size and
/// verifier provenance. Live guest verification remains required for reuse.
impl PartialEq for RestoredSessionIdentity {
    fn eq(&self, other: &Self) -> bool {
        self.framework == other.framework
            && self.session_id_hash == other.session_id_hash
            && self.history_ref_kind == other.history_ref_kind
            && self.history_hash == other.history_hash
    }
}

/// Formats non-sensitive classification fields while redacting identity hashes
/// and final-metadata verifier paths.
impl fmt::Debug for RestoredSessionIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RestoredSessionIdentity")
            .field("framework", &self.framework)
            .field("session_id_hash", &"[redacted]")
            .field("history_ref_kind", &self.history_ref_kind)
            .field("history_hash", &"[redacted]")
            .field("history_size_bytes", &self.history_size_bytes)
            .field(
                "verifier",
                &self.verifier.as_ref().map(|verifier| match verifier {
                    RestoredSessionIdentityVerifier::FinalIdentityMetadata { .. } => {
                        "[redacted-final-identity-metadata]"
                    }
                }),
            )
            .finish()
    }
}

/// Read cap used to reject oversized final-identity metadata.
pub const FINAL_SESSION_HISTORY_IDENTITY_READ_LIMIT: u64 =
    FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES + 1;
