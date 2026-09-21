//! Identity contracts for session history already restored in a sandbox.
//!
//! An incoming hash-backed resume request produces a requested
//! [`RestoredSessionIdentity`] without verifier provenance. Final metadata read
//! after a successful checkpoint produces a retained identity with the history
//! size and paths needed to verify the parked sandbox's current history.
//!
//! The comparison layers intentionally answer different questions. Structural
//! equality compares the framework and content identity while ignoring optional
//! size and verifier state. [`RestoredSessionIdentity::is_verified_match_for_request`]
//! additionally requires usable final-metadata provenance and enforces a
//! requested size when present. Even that match only authorizes the runner to
//! attempt the live guest verification required before restore can be skipped.
//!
//! Identity hashes and verifier paths are sensitive operational data. The
//! custom [`Debug`](std::fmt::Debug) implementation keeps them redacted.

use std::cmp::Ordering;
use std::fmt;

use api_contracts::generated::constants::runners::RESUME_SESSION_HISTORY_MAX_BYTES;
use guest_contracts::session_history_identity::{
    FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES, SessionHistoryFramework, SessionHistoryIdentity,
    SessionHistoryRefKind,
};
use sha2::{Digest, Sha256};

/// Reason a resume request cannot use a retained identity.
///
/// [`RestoredSessionIdentity::mismatch_reason_for_request`] defines the stable
/// precedence used when more than one field differs.
/// [`Self::MissingRequestedIdentity`] is instead used when no requested
/// identity can be constructed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RestoredSessionIdentityMismatchReason {
    Framework,
    SessionIdentity,
    HistoryRefKind,
    HistoryHash(RestoredSessionHistoryHashSizeRelationship),
    HistorySize,
    MissingRequestedIdentity,
}

impl RestoredSessionIdentityMismatchReason {
    pub(crate) const fn action_type(self) -> &'static str {
        match self {
            Self::Framework => "session_history_identity_mismatch_framework",
            Self::SessionIdentity => "session_history_identity_mismatch_session_identity",
            Self::HistoryRefKind => "session_history_identity_mismatch_history_ref_kind",
            Self::HistoryHash(_) => "session_history_identity_mismatch_history_hash",
            Self::HistorySize => "session_history_identity_mismatch_history_size",
            Self::MissingRequestedIdentity => {
                "session_history_identity_mismatch_missing_requested_identity"
            }
        }
    }

    pub(crate) const fn history_hash_size_relationship_action_type(self) -> Option<&'static str> {
        match self {
            Self::HistoryHash(relationship) => Some(relationship.action_type()),
            _ => None,
        }
    }
}

/// Requested history size relative to a retained size backed by usable
/// final-metadata verifier provenance.
///
/// [`Self::SizeUnknown`] means either the retained identity cannot supply a
/// usable final-metadata verification or the requested size is absent or
/// outside the accepted session-history range.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RestoredSessionHistoryHashSizeRelationship {
    RequestedSmaller,
    RequestedEqual,
    RequestedLarger,
    SizeUnknown,
}

impl RestoredSessionHistoryHashSizeRelationship {
    const fn action_type(self) -> &'static str {
        match self {
            Self::RequestedSmaller => {
                "session_history_identity_mismatch_history_hash_requested_smaller"
            }
            Self::RequestedEqual => {
                "session_history_identity_mismatch_history_hash_requested_equal"
            }
            Self::RequestedLarger => {
                "session_history_identity_mismatch_history_hash_requested_larger"
            }
            Self::SizeUnknown => "session_history_identity_mismatch_history_hash_size_unknown",
        }
    }
}

/// Framework and history identity shared by resume requests and retained state.
///
/// Requested identities carry the optional size supplied by the request but no
/// verifier. Identities accepted from final metadata carry a final size and
/// verifier paths. Structural equality deliberately excludes both fields so
/// callers can compare the common content identity independently of evidence
/// availability; use [`Self::is_verified_match_for_request`] for a decision
/// that requires retained verification provenance.
#[derive(Clone, Eq)]
pub(crate) struct RestoredSessionIdentity {
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
pub(crate) struct RestoredSessionFinalMetadataVerification<'a> {
    pub(crate) metadata_path: &'a str,
    pub(crate) runtime_dir: &'a str,
    pub(crate) framework: SessionHistoryFramework,
    pub(crate) session_id_hash: &'a str,
    pub(crate) history_ref_kind: SessionHistoryRefKind,
    pub(crate) history_hash: &'a str,
    pub(crate) history_size_bytes: u64,
}

/// Size-bearing identity fields used by workspace-cache sidecars.
///
/// This projection requires a stored history size but does not require
/// final-metadata verifier provenance.
pub(crate) struct RestoredSessionIdentityFields<'a> {
    pub(crate) framework: SessionHistoryFramework,
    pub(crate) session_id_hash: &'a str,
    pub(crate) history_ref_kind: SessionHistoryRefKind,
    pub(crate) history_hash: &'a str,
    pub(crate) history_size_bytes: u64,
}

/// Retained history hash and size offered for later prefix verification.
///
/// These fields identify the possible prefix; they are not proof that the
/// requested history actually starts with the retained bytes.
#[derive(Clone)]
pub(crate) struct RestoredSessionHistoryPrefixAttribution {
    history_hash: String,
    history_size_bytes: u64,
}

impl RestoredSessionIdentity {
    /// Builds an unverified identity from a framework-normalized session id.
    ///
    /// Claude Code callers supply the raw session id, while Codex callers
    /// supply the canonical thread id. The id is stored only as a SHA-256 hash.
    /// This constructor never attaches final-metadata verifier provenance.
    pub(crate) fn new(
        framework: SessionHistoryFramework,
        identity_session_id: &str,
        history_ref_kind: SessionHistoryRefKind,
        history_hash: impl Into<String>,
        history_size_bytes: Option<u64>,
    ) -> Self {
        Self {
            framework,
            session_id_hash: hex::encode(Sha256::digest(identity_session_id.as_bytes())),
            history_ref_kind,
            history_hash: history_hash.into(),
            history_size_bytes,
            verifier: None,
        }
    }

    /// Builds a retained identity from validated final checkpoint metadata.
    ///
    /// Returns `None` when the metadata is invalid or the supplied metadata
    /// path and runtime directory cannot form a usable verification
    /// projection.
    pub(crate) fn from_final_metadata(
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

    runner_test_support!(shared; #[cfg(test)]
    pub(crate) fn claude_code_for_test(history_hash: impl Into<String>) -> Self {
        Self::new(
            SessionHistoryFramework::ClaudeCode,
            "sess-restore-plan",
            SessionHistoryRefKind::Blob,
            history_hash,
            None,
        )
    });

    runner_test_support!(shared; #[cfg(test)]
    pub(crate) fn history_hash(&self) -> &str {
        &self.history_hash
    });

    runner_test_support!(shared; #[cfg(test)]
    pub(crate) fn history_size_bytes(&self) -> Option<u64> {
        self.history_size_bytes
    });

    runner_test_support!(shared; #[cfg(test)]
    pub(crate) fn final_metadata_path(&self) -> Option<&str> {
        match &self.verifier {
            Some(RestoredSessionIdentityVerifier::FinalIdentityMetadata {
                metadata_path, ..
            }) => Some(metadata_path),
            _ => None,
        }
    });

    /// Returns the inputs needed to verify final metadata inside the guest.
    ///
    /// The identity must contain a history size and final-metadata verifier,
    /// and both the metadata path and runtime directory must be absolute. This
    /// method only exposes verification inputs; the executor separately runs
    /// and evaluates the live guest verification.
    pub(crate) fn final_metadata_verification(
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

    /// Returns the size-bearing fields used to publish or validate a sidecar.
    ///
    /// Unlike [`Self::final_metadata_verification`], this does not require
    /// verifier provenance or retained guest paths.
    pub(crate) fn cache_fields(&self) -> Option<RestoredSessionIdentityFields<'_>> {
        Some(RestoredSessionIdentityFields {
            framework: self.framework,
            session_id_hash: &self.session_id_hash,
            history_ref_kind: self.history_ref_kind,
            history_hash: &self.history_hash,
            history_size_bytes: self.history_size_bytes?,
        })
    }

    /// Returns whether final-metadata verification inputs are available.
    pub(crate) fn has_final_metadata_verification(&self) -> bool {
        self.final_metadata_verification().is_some()
    }

    /// Returns the first request mismatch and any eligible prefix evidence.
    ///
    /// Prefix attribution is available only when the first mismatch is
    /// `HistoryHash(RequestedLarger)` and this retained identity has usable
    /// final-metadata verification. The returned hash and size remain inputs
    /// for later byte-prefix verification.
    pub(crate) fn mismatch_reason_and_prefix_attribution(
        &self,
        requested: &Self,
    ) -> (
        Option<RestoredSessionIdentityMismatchReason>,
        Option<RestoredSessionHistoryPrefixAttribution>,
    ) {
        let reason = self.mismatch_reason_for_request(requested);
        let prefix_attribution = match reason {
            Some(RestoredSessionIdentityMismatchReason::HistoryHash(
                RestoredSessionHistoryHashSizeRelationship::RequestedLarger,
            )) => self.final_metadata_verification().map(|verification| {
                RestoredSessionHistoryPrefixAttribution {
                    history_hash: verification.history_hash.to_owned(),
                    history_size_bytes: verification.history_size_bytes,
                }
            }),
            _ => None,
        };
        (reason, prefix_attribution)
    }

    /// Returns whether this retained identity is eligible for live verification.
    ///
    /// Eligibility requires structural equality, usable final-metadata
    /// provenance on `self`, and an exact size match when `requested` supplies
    /// a size. A missing requested size adds no size constraint. The caller
    /// must still perform live guest verification before skipping restore.
    pub(crate) fn is_verified_match_for_request(&self, requested: &Self) -> bool {
        self == requested
            && self.has_final_metadata_verification()
            && requested
                .history_size_bytes
                .is_none_or(|requested_size| self.history_size_bytes == Some(requested_size))
    }

    /// Returns the first identity difference relevant to a resume request.
    ///
    /// Mismatches take precedence in this order: framework, session identity,
    /// history ref kind, history hash, then history size. History size is a
    /// constraint only when `requested` supplies one, so `None` can describe a
    /// structural match that is still not eligible for a verified restore skip.
    pub(crate) fn mismatch_reason_for_request(
        &self,
        requested: &Self,
    ) -> Option<RestoredSessionIdentityMismatchReason> {
        if self.framework != requested.framework {
            return Some(RestoredSessionIdentityMismatchReason::Framework);
        }
        if self.session_id_hash != requested.session_id_hash {
            return Some(RestoredSessionIdentityMismatchReason::SessionIdentity);
        }
        if self.history_ref_kind != requested.history_ref_kind {
            return Some(RestoredSessionIdentityMismatchReason::HistoryRefKind);
        }
        if self.history_hash != requested.history_hash {
            return Some(RestoredSessionIdentityMismatchReason::HistoryHash(
                self.history_hash_size_relationship_for_request(requested),
            ));
        }
        if let Some(requested_size) = requested.history_size_bytes
            && self.history_size_bytes != Some(requested_size)
        {
            return Some(RestoredSessionIdentityMismatchReason::HistorySize);
        }
        None
    }

    fn history_hash_size_relationship_for_request(
        &self,
        requested: &Self,
    ) -> RestoredSessionHistoryHashSizeRelationship {
        let Some(restored_size) = self
            .final_metadata_verification()
            .map(|verification| verification.history_size_bytes)
        else {
            return RestoredSessionHistoryHashSizeRelationship::SizeUnknown;
        };
        let Some(requested_size) = requested
            .history_size_bytes
            .filter(|size| (1..=RESUME_SESSION_HISTORY_MAX_BYTES).contains(size))
        else {
            return RestoredSessionHistoryHashSizeRelationship::SizeUnknown;
        };

        match requested_size.cmp(&restored_size) {
            Ordering::Less => RestoredSessionHistoryHashSizeRelationship::RequestedSmaller,
            Ordering::Equal => RestoredSessionHistoryHashSizeRelationship::RequestedEqual,
            Ordering::Greater => RestoredSessionHistoryHashSizeRelationship::RequestedLarger,
        }
    }
}

impl RestoredSessionHistoryPrefixAttribution {
    runner_test_group!(executor; #[cfg(test)]
    pub(crate) fn for_test(history_hash: String, history_size_bytes: u64) -> Self {
        Self {
            history_hash,
            history_size_bytes,
        }
    });

    /// Consumes the attribution into the possible prefix hash and size.
    pub(crate) fn into_parts(self) -> (String, u64) {
        (self.history_hash, self.history_size_bytes)
    }
}

/// Compares the structural content identity only.
///
/// Equality includes framework, hashed normalized session identity, history
/// ref kind, and history hash. It intentionally excludes history size and
/// verifier provenance. Equality alone therefore cannot authorize a verified
/// restore skip; use
/// [`RestoredSessionIdentity::is_verified_match_for_request`] at that boundary.
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
pub(crate) const FINAL_SESSION_HISTORY_IDENTITY_READ_LIMIT: u64 =
    FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES + 1;
