//! Capturing and consuming surviving history evidence, never history bodies.

use std::io::{self, Read};
use std::path::{Path, PathBuf};

use guest_contracts::home_cache_history::{
    HOME_CACHE_HISTORY_HELPER_MAX_BYTES, HOME_CACHE_HISTORY_PROOF_MAX_BYTES,
    HOME_CACHE_HISTORY_PROOF_PATH, HomeCacheHistoryProof, HomeCacheHistoryProofBinding,
    HomeCacheHistoryVerifyReport, HomeCacheHistoryVerifyRequest,
};
use sha2::{Digest, Sha256};

use crate::session_history_identity::{
    read_final_session_history_identity, verify_retained_home_identity,
};

fn proof_path() -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("OKOU_TEST_HOME_CACHE_HISTORY_PROOF_PATH") {
        return PathBuf::from(path);
    }
    PathBuf::from(HOME_CACHE_HISTORY_PROOF_PATH)
}

/// Read one fixed typed verifier request and return a bounded hit/miss report.
///
/// No request can select an executable, environment or proof-file path.
/// Invalid/missing/corrupt evidence is a miss. Host cancellation owns the helper
/// lifetime and must not be interpreted as this successful miss report.
pub fn verify_from_stdin() -> io::Result<HomeCacheHistoryVerifyReport> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(HOME_CACHE_HISTORY_HELPER_MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > HOME_CACHE_HISTORY_HELPER_MAX_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "history verifier request too large",
        ));
    }
    let request = serde_json::from_slice(&bytes).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid history verifier request",
        )
    })?;
    Ok(HomeCacheHistoryVerifyReport {
        verified: verify_at_path(&request, &proof_path()),
    })
}

fn verify_at_path(request: &HomeCacheHistoryVerifyRequest, path: &Path) -> bool {
    if request.validate().is_err() {
        return false;
    }
    let Ok(Some(bytes)) = guest_contracts::runtime_paths::read_private_bounded(
        path,
        HOME_CACHE_HISTORY_PROOF_MAX_BYTES,
    ) else {
        return false;
    };
    let Ok(proof) = HomeCacheHistoryProof::from_json_slice(&bytes) else {
        return false;
    };
    if proof != request.binding.proof
        || hex::encode(Sha256::digest(&bytes)) != request.binding.sha256
        || proof.to_json_vec().ok().as_deref() != Some(bytes.as_slice())
    {
        return false;
    }
    // Existing readers enforce source session identity, no-follow regular-file
    // resolution, bounded unique Codex raw/zstd lookup, decoded size and SHA-256.
    verify_retained_home_identity(&proof.identity).is_ok()
}

pub(crate) fn capture(
    current_runtime: &Path,
    retained_runtime: Option<&Path>,
    generation: &str,
) -> io::Result<Option<HomeCacheHistoryProofBinding>> {
    capture_at_path(current_runtime, retained_runtime, generation, &proof_path())
}

fn capture_at_path(
    current_runtime: &Path,
    retained_runtime: Option<&Path>,
    generation: &str,
    path: &Path,
) -> io::Result<Option<HomeCacheHistoryProofBinding>> {
    let current =
        guest_contracts::runtime_paths::final_session_history_identity_file(current_runtime);
    // Retained metadata is considered only when the current run produced none,
    // never to mask a malformed/changed current history identity.
    let current_missing = matches!(
        guest_contracts::runtime_paths::read_private_bounded(
            &current,
            HOME_CACHE_HISTORY_PROOF_MAX_BYTES
        ),
        Ok(None)
    );
    let metadata = if current_missing {
        retained_runtime.map(guest_contracts::runtime_paths::final_session_history_identity_file)
    } else {
        Some(current)
    };
    let candidate = metadata.and_then(|metadata| {
        let identity = read_final_session_history_identity(metadata).ok()?;
        verify_retained_home_identity(&identity).ok()?;
        let proof = HomeCacheHistoryProof {
            format_version: 1,
            generation: generation.into(),
            identity,
        };
        let bytes = proof.to_json_vec().ok()?;
        Some((proof, bytes))
    });
    let Some((proof, bytes)) = candidate else {
        clear_at_path(path)?;
        return Ok(None);
    };
    // write_private opens parents and the file descriptor-relatively, rejects
    // symlinks/nonregular entries, and enforces private owner permissions.
    guest_contracts::runtime_paths::write_private(path, &bytes)?;
    let binding = HomeCacheHistoryProofBinding {
        proof,
        sha256: hex::encode(Sha256::digest(&bytes)),
    };
    // Readback catches partial writes or a changed named entry before cleanup.
    let actual = guest_contracts::runtime_paths::read_private_bounded(
        path,
        HOME_CACHE_HISTORY_PROOF_MAX_BYTES,
    )?;
    if actual.as_deref() != Some(bytes.as_slice()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "history proof readback failed",
        ));
    }
    Ok(Some(binding))
}

fn clear_at_path(path: &Path) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::other("invalid proof parent"))?;
        let dir = match crate::nofollow_fs::Dir::open_absolute(parent) {
            Ok(dir) => dir,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let name = path
            .file_name()
            .ok_or_else(|| io::Error::other("invalid proof name"))?;
        match dir.unlink_child_file(name) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = path;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "home history proof requires no-follow filesystem",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use guest_contracts::session_history_identity::{
        SessionHistoryFramework, SessionHistoryIdentity, SessionHistoryIdentityExpectation,
        SessionHistoryRefKind, SessionHistorySourceRef,
    };

    fn owned_home_fixture() -> tempfile::TempDir {
        // The canonical Guest home need not exist in a host/CI test container.
        // Only the UUID-owned child is removed; concurrent tests never remove
        // the shared parent. Canonical history files are separately UUID-owned.
        std::fs::create_dir_all("/home/user").unwrap();
        tempfile::tempdir_in("/home/user").unwrap()
    }

    #[test]
    fn retained_codex_raw_and_zstd_use_real_bytes_and_reject_ambiguity_or_corruption() {
        let dir = owned_home_fixture();
        let runtime = dir.path().join("runtime/current");
        let proof_path = dir.path().join("cache/proof.json");
        let thread = uuid::Uuid::new_v4().to_string();
        let day = Path::new("/home/user/.codex/sessions/2026/10/09");
        std::fs::create_dir_all(day).unwrap();
        let raw = day.join(format!("rollout-{}.jsonl", thread.replace('-', "")));
        let encoded = raw.with_extension("jsonl.zst");
        struct OwnedHistories(Vec<PathBuf>);
        impl Drop for OwnedHistories {
            fn drop(&mut self) {
                for path in &self.0 {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
        let _owned = OwnedHistories(vec![raw.clone(), encoded.clone()]);
        let history = br#"{"type":"session_meta","timestamp":"2026-10-09T00:00:00Z"}"#;
        let identity = SessionHistoryIdentity::new(
            SessionHistoryFramework::Codex,
            hex::encode(Sha256::digest(thread.as_bytes())),
            SessionHistoryRefKind::Blob,
            hex::encode(Sha256::digest(history)),
            history.len() as u64,
            SessionHistorySourceRef::Codex {
                sessions_dir: "/home/user/.codex/sessions".into(),
                thread_id: thread,
            },
        )
        .unwrap();
        let metadata =
            guest_contracts::runtime_paths::final_session_history_identity_file(&runtime);
        guest_contracts::runtime_paths::write_private(&metadata, identity.to_json_vec().unwrap())
            .unwrap();
        for zstd in [false, true] {
            let _ = std::fs::remove_file(&raw);
            let _ = std::fs::remove_file(&encoded);
            if zstd {
                std::fs::write(&encoded, zstd::encode_all(history.as_slice(), 0).unwrap()).unwrap();
            } else {
                std::fs::write(&raw, history).unwrap();
            }
            let binding = capture_at_path(
                &runtime,
                None,
                "74b68da0-6e0a-4adc-a68e-65a04c4885c4",
                &proof_path,
            )
            .unwrap()
            .unwrap();
            let request = HomeCacheHistoryVerifyRequest {
                expected: SessionHistoryIdentityExpectation::new(
                    identity.framework,
                    identity.session_id_hash.clone(),
                    identity.history_ref_kind,
                    identity.history_hash.clone(),
                    identity.history_size_bytes,
                )
                .unwrap(),
                source: identity.history_source.clone(),
                binding,
            };
            assert!(verify_at_path(&request, &proof_path));
            if zstd {
                let mut corrupt = std::fs::read(&encoded).unwrap();
                corrupt.pop().unwrap();
                std::fs::write(&encoded, corrupt).unwrap();
                assert!(!verify_at_path(&request, &proof_path));
                std::fs::write(&encoded, zstd::encode_all(history.as_slice(), 0).unwrap()).unwrap();
            }
            std::fs::write(
                if zstd { &raw } else { &encoded },
                if zstd {
                    history.to_vec()
                } else {
                    zstd::encode_all(history.as_slice(), 0).unwrap()
                },
            )
            .unwrap();
            assert!(!verify_at_path(&request, &proof_path));
            assert!(
                capture_at_path(
                    &runtime,
                    None,
                    "74b68da0-6e0a-4adc-a68e-65a04c4885c4",
                    &proof_path
                )
                .unwrap()
                .is_none()
            );
            assert!(!proof_path.exists());
        }
    }

    #[test]
    fn captured_live_bytes_and_surviving_proof_are_both_required() {
        // A real home-contained temp tree, not an overridden source reader.
        let dir = owned_home_fixture();
        let config = dir.path().join("claude");
        let history = config.join("projects/-home-user-workspace/session-1.jsonl");
        std::fs::create_dir_all(history.parent().unwrap()).unwrap();
        std::fs::write(&history, b"history").unwrap();
        let runtime = dir.path().join("runtime/current");
        let metadata =
            guest_contracts::runtime_paths::final_session_history_identity_file(&runtime);
        let identity = SessionHistoryIdentity::new(
            SessionHistoryFramework::ClaudeCode,
            hex::encode(Sha256::digest(b"session-1")),
            SessionHistoryRefKind::Blob,
            hex::encode(Sha256::digest(b"history")),
            7,
            SessionHistorySourceRef::ClaudeCode {
                config_dir: config.to_string_lossy().into_owned(),
                working_dir: "/home/user/workspace".into(),
                session_id: "session-1".into(),
            },
        )
        .unwrap();
        guest_contracts::runtime_paths::write_private(&metadata, identity.to_json_vec().unwrap())
            .unwrap();
        let proof_path = dir.path().join("cache/proof.json");
        let binding = capture_at_path(
            &runtime,
            None,
            "74b68da0-6e0a-4adc-a68e-65a04c4885c4",
            &proof_path,
        )
        .unwrap()
        .unwrap();
        let mut request = HomeCacheHistoryVerifyRequest {
            expected: SessionHistoryIdentityExpectation::new(
                identity.framework,
                identity.session_id_hash,
                identity.history_ref_kind,
                identity.history_hash,
                7,
            )
            .unwrap(),
            source: identity.history_source,
            binding,
        };
        assert!(verify_at_path(&request, &proof_path));
        std::fs::remove_dir_all(&runtime).unwrap();
        assert!(verify_at_path(&request, &proof_path));
        request.binding.proof.generation = uuid::Uuid::new_v4().to_string();
        assert!(!verify_at_path(&request, &proof_path));
        request.binding = HomeCacheHistoryProofBinding {
            proof: HomeCacheHistoryProof::from_json_slice(&std::fs::read(&proof_path).unwrap())
                .unwrap(),
            sha256: hex::encode(Sha256::digest(std::fs::read(&proof_path).unwrap())),
        };
        request.binding.sha256 = "f".repeat(64);
        assert!(!verify_at_path(&request, &proof_path));
        request.binding.sha256 = hex::encode(Sha256::digest(std::fs::read(&proof_path).unwrap()));
        std::fs::write(&history, b"changed").unwrap();
        assert!(!verify_at_path(&request, &proof_path));
        std::fs::write(&proof_path, b"corrupt").unwrap();
        assert!(!verify_at_path(&request, &proof_path));
        assert!(
            capture_at_path(
                &runtime,
                None,
                "74b68da0-6e0a-4adc-a68e-65a04c4885c4",
                &proof_path
            )
            .unwrap()
            .is_none()
        );
        assert!(!proof_path.exists());
    }
}
