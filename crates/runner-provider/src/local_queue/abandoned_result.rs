//! No-clobber terminal markers for abandoned local submissions.

use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;

use super::{JobResponse, LocalQueue};
use runner_types::ids::RunId;

/// Receipt for an abandoned-result marker at its original run's result path.
///
/// Dropping the receipt leaves the marker in place. The caller decides when
/// queue cleanup permits an explicit removal attempt.
pub struct AbandonedResultMarker {
    result_path: PathBuf,
    bytes: Vec<u8>,
    dev: u64,
    ino: u64,
}

impl AbandonedResultMarker {
    /// Best-effort removal of the original marker if its identity and bytes match.
    ///
    /// A replaced, mutated or non-regular result is preserved. These checks do
    /// not make the final unlink an atomic compare-and-remove operation.
    pub fn remove_if_unchanged(&self) {
        let Ok(metadata) = std::fs::symlink_metadata(&self.result_path) else {
            return;
        };
        if !metadata.file_type().is_file() {
            return;
        }
        if metadata.dev() != self.dev || metadata.ino() != self.ino {
            return;
        }
        if super::read_private_file(&self.result_path, "local result file")
            .map(|current| current == self.bytes)
            .unwrap_or(false)
        {
            let _ = std::fs::remove_file(&self.result_path);
        }
    }
}

impl LocalQueue {
    /// Publish an abandoned submission's terminal marker without replacing a result.
    ///
    /// The receipt retains the original run's result path for conditional cleanup.
    /// Publication is best-effort; an occupied path or any failure returns `None`.
    pub fn write_abandoned_result_marker_sync(
        &self,
        run_id: RunId,
        error: &str,
    ) -> Option<AbandonedResultMarker> {
        // The result file is the durable terminal marker observed by local
        // runners. Use it to prevent an abandoned job from being rediscovered
        // without creating a fake claim that could strand the job if submit exits.
        let result_path = super::result_path(self.group_dir(), run_id);
        if super::read_private_file(&result_path, "local result file")
            .is_ok_and(|bytes| !bytes.is_empty())
        {
            return None;
        }

        let response = JobResponse {
            run_id,
            exit_code: 1,
            error: Some(error.to_owned()),
        };
        let json = serde_json::to_vec(&response).ok()?;
        let result_dir = super::ensure_results_dir(self.group_dir()).ok()?;
        let tmp_path = result_dir.join(format!("{run_id}.{}.result.tmp", RunId::new_v4()));
        let mut file =
            super::open_private_new_file(&tmp_path, "local abandoned result marker temporary file")
                .ok()?;
        let _temporary_cleanup = super::fs::TemporaryFileCleanup::new(&tmp_path);
        file.write_all(&json).ok()?;
        let metadata = file.metadata().ok()?;
        drop(file);

        // A no-clobber hard link preserves a runner result that wins the race.
        // Ordinary runner results deliberately use their separate rename policy.
        std::fs::hard_link(&tmp_path, &result_path).ok()?;
        Some(AbandonedResultMarker {
            result_path,
            bytes: json,
            dev: metadata.dev(),
            ino: metadata.ino(),
        })
    }
}

#[cfg(test)]
mod tests;
