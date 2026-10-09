//! Bounded, generation-owned evidence for history retained in a whole-home image.
//!
//! Path validation proves lexical membership only. Consumers must still open the
//! actual source without following symlinks and verify its current bytes.

use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

use crate::reuse_preparation::ReusePreparationReport;
use crate::session_history_identity::{
    SessionHistoryIdentity, SessionHistoryIdentityExpectation, SessionHistorySourceRef,
};

/// Fixed surviving proof location, outside managed per-run private state.
pub const HOME_CACHE_HISTORY_PROOF_PATH: &str =
    "/home/user/.vm0/home-cache/session-history-proof.json";
/// Maximum serialized proof size.
pub const HOME_CACHE_HISTORY_PROOF_MAX_BYTES: usize = 32 * 1024;
/// Maximum typed helper input or output size.
pub const HOME_CACHE_HISTORY_HELPER_MAX_BYTES: usize = 64 * 1024;
/// Fixed verifier command; no executable or environment comes from a request.
pub const HOME_CACHE_HISTORY_VERIFY_COMMAND: &str = "verify-home-cache-history";

/// Small proof captured from finalized metadata and verified live history.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HomeCacheHistoryProof {
    /// Current proof schema version (one).
    pub format_version: u32,
    /// Canonical UUID of the image publication generation.
    pub generation: String,
    /// Actual finalized identity, including its structured source.
    pub identity: SessionHistoryIdentity,
}

impl HomeCacheHistoryProof {
    /// Validate version, generation, identity and supported home membership.
    pub fn validate(&self) -> Result<(), HomeCacheHistoryError> {
        if self.format_version != 1 || !valid_generation(&self.generation) {
            return Err(HomeCacheHistoryError);
        }
        self.identity
            .validate()
            .map_err(|_| HomeCacheHistoryError)?;
        validate_home_source(&self.identity.history_source)?;
        Ok(())
    }

    /// Parse a bounded JSON proof and validate its complete structure.
    pub fn from_json_slice(bytes: &[u8]) -> Result<Self, HomeCacheHistoryError> {
        if bytes.len() > HOME_CACHE_HISTORY_PROOF_MAX_BYTES {
            return Err(HomeCacheHistoryError);
        }
        let proof: Self = serde_json::from_slice(bytes).map_err(|_| HomeCacheHistoryError)?;
        proof.validate()?;
        Ok(proof)
    }

    /// Serialize a validated proof within its byte budget.
    pub fn to_json_vec(&self) -> Result<Vec<u8>, HomeCacheHistoryError> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| HomeCacheHistoryError)?;
        if bytes.len() > HOME_CACHE_HISTORY_PROOF_MAX_BYTES {
            return Err(HomeCacheHistoryError);
        }
        Ok(bytes)
    }
}

/// Image metadata's binding to the exact canonical proof bytes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HomeCacheHistoryProofBinding {
    /// Generation-owned proof.
    pub proof: HomeCacheHistoryProof,
    /// Lowercase SHA-256 of the canonical serialized proof (not history bytes).
    pub sha256: String,
}

impl HomeCacheHistoryProofBinding {
    /// Validate structure; the producer/consumer owns cryptographic hashing.
    pub fn validate(&self) -> Result<(), HomeCacheHistoryError> {
        self.proof.to_json_vec()?;
        if self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(HomeCacheHistoryError);
        }
        Ok(())
    }
}

/// Terminal-only preparation after all private runtime readers have finished.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TerminalHomeCachePreparationRequest {
    /// Completed run's canonical runtime anchor.
    pub current_runtime_dir: String,
    /// Earlier runtime anchor still owning legitimate finalized metadata.
    pub retained_runtime_dir: Option<String>,
    /// Publication generation owned by the host image context.
    pub generation: String,
}

impl TerminalHomeCachePreparationRequest {
    /// Validate generation; the guest validates descriptor-owned runtime anchors.
    pub fn validate(&self) -> Result<(), HomeCacheHistoryError> {
        if !valid_generation(&self.generation) {
            return Err(HomeCacheHistoryError);
        }
        Ok(())
    }
}

/// Successful namespace cleanup plus optional captured surviving history proof.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TerminalHomeCachePreparationReport {
    /// Existing cleanup contract (not idle-capacity admission).
    pub cleanup: ReusePreparationReport,
    /// None is an advisory history miss, never a cleanup bypass.
    pub history_proof: Option<HomeCacheHistoryProofBinding>,
}

/// At-consumption verifier input captured from the current request and launch.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HomeCacheHistoryVerifyRequest {
    /// Candidate evidence from the locked image metadata.
    pub binding: HomeCacheHistoryProofBinding,
    /// Current requested history identity.
    pub expected: SessionHistoryIdentityExpectation,
    /// Source the current CLI launch actually consumes, not a requested hash alone.
    pub source: SessionHistorySourceRef,
}

impl HomeCacheHistoryVerifyRequest {
    /// Validate all fields and require exact current request/source agreement.
    pub fn validate(&self) -> Result<(), HomeCacheHistoryError> {
        self.binding.validate()?;
        self.expected
            .validate()
            .map_err(|_| HomeCacheHistoryError)?;
        validate_home_source(&self.source)?;
        if !self.expected.matches_identity(&self.binding.proof.identity)
            || self.source != self.binding.proof.identity.history_source
        {
            return Err(HomeCacheHistoryError);
        }
        Ok(())
    }
}

/// Fixed verifier output: absence or invalid evidence is an ordinary miss.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HomeCacheHistoryVerifyReport {
    /// True only after proof, current source and actual live bytes agree.
    pub verified: bool,
}

/// A bounded proof/helper contract was invalid. No private values are included.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HomeCacheHistoryError;

impl std::fmt::Display for HomeCacheHistoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("invalid home cache history evidence")
    }
}

impl std::error::Error for HomeCacheHistoryError {}

fn valid_generation(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.to_string() == value)
}

fn canonical_path(value: &str) -> bool {
    let path = Path::new(value);
    path.is_absolute()
        && !value.contains('\0')
        && !value.split('/').any(|part| part == "." || part == "..")
        && path
            .components()
            .all(|part| matches!(part, Component::RootDir | Component::Normal(_)))
}

fn in_home(value: &str) -> bool {
    canonical_path(value) && Path::new(value).starts_with("/home/user")
}

/// Validate supported structured sources retained by the home image.
///
/// This is not filesystem safety or byte verification; real readers own both.
pub fn validate_home_source(source: &SessionHistorySourceRef) -> Result<(), HomeCacheHistoryError> {
    let supported = match source {
        SessionHistorySourceRef::ClaudeCode {
            config_dir,
            working_dir,
            session_id,
        } => {
            in_home(config_dir)
                && canonical_path(working_dir)
                && crate::cli_agent_session_id::is_valid_cli_agent_session_id(session_id)
        }
        SessionHistorySourceRef::Codex {
            sessions_dir,
            thread_id,
        } => {
            sessions_dir == "/home/user/.codex/sessions"
                && crate::codex_thread_id::canonical_codex_thread_id(thread_id).as_deref()
                    == Some(thread_id.as_str())
        }
        SessionHistorySourceRef::Pi {
            session_path,
            session_id,
        } => canonical_path(session_path)
            && Path::new(session_path).parent()
                == Some(Path::new(
                    api_contracts::generated::constants::runners::paths::CANONICAL_PI_SESSION_DIR,
                ))
            && crate::cli_agent_session_id::is_valid_cli_agent_session_id(session_id)
            && Path::new(session_path)
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    let Some(stem) = name.strip_suffix(".jsonl") else {
                        return false;
                    };
                    stem == session_id
                        || stem
                            .strip_suffix(session_id)
                            .is_some_and(|prefix| prefix.ends_with('-') || prefix.ends_with('_'))
                }),
    };
    if supported {
        Ok(())
    } else {
        Err(HomeCacheHistoryError)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_history_identity::{SessionHistoryFramework, SessionHistoryRefKind};

    fn proof() -> HomeCacheHistoryProof {
        HomeCacheHistoryProof {
            format_version: 1,
            generation: "74b68da0-6e0a-4adc-a68e-65a04c4885c4".into(),
            identity: SessionHistoryIdentity::new(
                SessionHistoryFramework::ClaudeCode,
                "a".repeat(64),
                SessionHistoryRefKind::Blob,
                "b".repeat(64),
                10,
                SessionHistorySourceRef::ClaudeCode {
                    config_dir: "/home/user/.claude".into(),
                    working_dir: "/home/user/workspace".into(),
                    session_id: "session-1".into(),
                },
            )
            .unwrap(),
        }
    }

    #[test]
    fn bounded_current_proof_round_trips() {
        let p = proof();
        assert_eq!(
            HomeCacheHistoryProof::from_json_slice(&p.to_json_vec().unwrap()).unwrap(),
            p
        );
        assert!(
            HomeCacheHistoryProof::from_json_slice(&vec![
                b' ';
                HOME_CACHE_HISTORY_PROOF_MAX_BYTES + 1
            ])
            .is_err()
        );
        for generation in ["", "not-a-uuid", "00000000-0000-0000-0000-000000000000"] {
            let mut bad = p.clone();
            bad.generation = generation.into();
            assert!(bad.validate().is_err());
        }
    }

    #[test]
    fn current_source_and_request_are_required() {
        let p = proof();
        let expected = SessionHistoryIdentityExpectation::new(
            p.identity.framework,
            p.identity.session_id_hash.clone(),
            p.identity.history_ref_kind,
            p.identity.history_hash.clone(),
            p.identity.history_size_bytes,
        )
        .unwrap();
        let mut request = HomeCacheHistoryVerifyRequest {
            source: p.identity.history_source.clone(),
            expected,
            binding: HomeCacheHistoryProofBinding {
                proof: p,
                sha256: "c".repeat(64),
            },
        };
        assert!(request.validate().is_ok());
        request.expected.history_hash = "d".repeat(64);
        assert!(request.validate().is_err());
        request.expected.history_hash = "b".repeat(64);
        if let SessionHistorySourceRef::ClaudeCode { config_dir, .. } = &mut request.source {
            *config_dir = "/home/user/other".into();
        }
        assert!(request.validate().is_err());
    }

    #[test]
    fn membership_rejects_escape_and_out_of_home_sources() {
        for config_dir in [
            "/home/user/../other",
            "/home/user/.claude/./state",
            "/home/user2/.claude",
            "/tmp/.claude",
        ] {
            let source = SessionHistorySourceRef::ClaudeCode {
                config_dir: config_dir.into(),
                working_dir: "/home/user/workspace".into(),
                session_id: "session-1".into(),
            };
            assert!(validate_home_source(&source).is_err());
        }
    }
}
