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
    current_runtime: Option<&Path>,
    retained_runtime: Option<&Path>,
    generation: &str,
) -> CapturedHistoryProof {
    capture_at_path(current_runtime, retained_runtime, generation, &proof_path())
}

fn capture_at_path(
    current_runtime: Option<&Path>,
    retained_runtime: Option<&Path>,
    generation: &str,
    path: &Path,
) -> CapturedHistoryProof {
    let current =
        current_runtime.map(guest_contracts::runtime_paths::final_session_history_identity_file);
    // Retained metadata is considered only when the current run produced none,
    // never to mask a malformed/changed current history identity. Do not read
    // an unstarted runtime: the private reader would create its missing parents.
    let current_missing = current.as_ref().is_none_or(|current| {
        matches!(
            guest_contracts::runtime_paths::read_private_bounded(
                current,
                HOME_CACHE_HISTORY_PROOF_MAX_BYTES
            ),
            Ok(None)
        )
    });
    let metadata = if current_missing {
        retained_runtime.map(guest_contracts::runtime_paths::final_session_history_identity_file)
    } else {
        current
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
    CapturedHistoryProof {
        path: path.to_owned(),
        candidate,
    }
}

/// Finalized facts captured before runtime cleanup, without requiring home writes.
pub(crate) struct CapturedHistoryProof {
    path: PathBuf,
    candidate: Option<(HomeCacheHistoryProof, Vec<u8>)>,
}

impl CapturedHistoryProof {
    /// An unusable home must not retain an older generation's surviving proof.
    pub(crate) fn discard(self) -> io::Result<()> {
        clear_at_path(&self.path)
    }

    /// Persist only after managed cleanup and any home-space reclamation finish.
    pub(crate) fn persist(self) -> io::Result<Option<HomeCacheHistoryProofBinding>> {
        let Some((proof, bytes)) = self.candidate else {
            clear_at_path(&self.path)?;
            return Ok(None);
        };
        // Descriptor-relative private writes reject symlinks/nonregular entries.
        guest_contracts::runtime_paths::write_private(&self.path, &bytes)?;
        let binding = HomeCacheHistoryProofBinding {
            proof,
            sha256: hex::encode(Sha256::digest(&bytes)),
        };
        let actual = guest_contracts::runtime_paths::read_private_bounded(
            &self.path,
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
mod tests;
