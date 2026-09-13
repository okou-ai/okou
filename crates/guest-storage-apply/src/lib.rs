//! Apply guest storage/artifact manifests, including cleanup and normalization.
//!
//! Features:
//! - Parallel downloads using std::thread (max 4 concurrent)
//! - Streaming extraction (no temp files)
//! - Retry logic with 3 attempts
//!
//! ## Manifest application and failure semantics
//!
//! [`run`] and [`run_manifest_bytes`] apply valid manifests directly to the
//! filesystem without a transaction. Manifest-requested stale-path and
//! instruction-file cleanups are attempted before target preparation and
//! downloads, and a later failure does not restore their changes.
//!
//! Downloads whose targets do not overlap may run concurrently. A failed task
//! does not cancel its siblings, so a `false` result can coexist with targets
//! successfully materialized by other tasks. Archive attempts extract in place
//! and retries reuse the same target, so a failed task may also leave changes
//! written by an earlier entry or attempt.
//!
//! On preparation or aggregate download failure, the crate attempts to remove
//! staged sources used to normalize instruction storage. That targeted cleanup
//! does not roll back ordinary storage or artifact targets, empty artifact
//! directories already prepared, or earlier cleanup effects. Cleanup and
//! instruction normalization are best-effort operations, so the result
//! reports required target preparation and downloads rather than
//! transaction-wide success for every filesystem change.
//!
//! ## Archive metadata limits
//!
//! Each tar member has a 1 MiB budget for encoded metadata, including headers,
//! GNU/PAX extension bodies and padding, and GNU sparse maps. This is both an
//! individual-extension and combined metadata bound, enforced while tar parses
//! metadata, before it can buffer unbounded input. Vector capacity and parsed
//! descriptors add bounded overhead; the budget is not an exact heap/RSS cap.
//! Oversized metadata is a non-retriable archive error. Ordinary file payloads
//! and their padding are exempt, including unread payloads of skipped entries;
//! sparse files retain their physical-data streaming and hole-seeking behavior.
//! The budget resets between members and is independent for each attempt.

mod archive;
mod cleanup;
mod download;
mod error;
mod http_failure;
mod instructions;
mod manifest;
mod path;
mod plan;
mod source;
mod tar_metadata;
mod telemetry;

use guest_contracts::storage_manifest::Manifest;
use guest_telemetry::{log_error, log_info, telemetry::record_sandbox_op};
use manifest::ManifestLoadError;
use plan::{EmptyArtifactPreparation, RunPlan};
use std::fs;
use std::time::Instant;

const LOG_TAG: &str = "sandbox:guest-storage-apply";

/// Apply the manifest read from `manifest_path`.
///
/// Returns `true` when the manifest can be read and parsed and all required
/// target preparations and downloads succeed. Returns `false` otherwise. A
/// read or parse failure occurs before manifest application; once application
/// starts, `false` does not roll back completed filesystem changes. See the
/// manifest application section in the [`crate`] documentation for details.
pub fn run(manifest_path: &str) -> bool {
    let manifest = match manifest::load(manifest_path) {
        Ok(manifest) => manifest,
        Err(ManifestLoadError::Read(e)) => {
            log_error!(LOG_TAG, "Failed to read manifest: {e}");
            return false;
        }
        Err(ManifestLoadError::Parse(e)) => {
            log_error!(LOG_TAG, "Failed to parse manifest: {e}");
            return false;
        }
    };

    run_manifest(manifest)
}

/// Apply a manifest supplied as JSON bytes.
///
/// Returns `true` when the manifest parses and all required target preparations
/// and downloads succeed. Returns `false` otherwise. A parse failure occurs
/// before manifest application; once application starts, `false` does not roll
/// back completed filesystem changes. See the manifest application section in
/// the [`crate`] documentation for details.
pub fn run_manifest_bytes(manifest_json: &[u8]) -> bool {
    let manifest = match manifest::parse(manifest_json) {
        Ok(manifest) => manifest,
        Err(e) => {
            log_error!(LOG_TAG, "Failed to parse manifest: {e}");
            return false;
        }
    };

    run_manifest(manifest)
}

fn run_manifest(manifest: Manifest) -> bool {
    let plan_start = Instant::now();
    let plan = RunPlan::from_manifest(&manifest);
    record_sandbox_op(
        "guest_storage_apply_plan_build",
        plan_start.elapsed(),
        true,
        None,
    );
    let RunPlan {
        cleanup_paths,
        instruction_cleanups,
        preserved_paths,
        empty_artifacts,
        download_tasks,
        instruction_files,
    } = plan;

    // Clean stale files from changed/removed storages before downloading.
    // This must run before parallel downloads to avoid race conditions with
    // parent-child mount path overlaps.
    let cleanup_start = Instant::now();
    if !cleanup_paths.is_empty() {
        cleanup::cleanup_stale_paths(&cleanup_paths, &preserved_paths);
    }
    if !instruction_cleanups.is_empty() {
        instructions::cleanup_instruction_files(&instruction_cleanups);
    }
    record_sandbox_op(
        "guest_storage_apply_cleanup",
        cleanup_start.elapsed(),
        true,
        None,
    );

    // Resolve all logical and physical target identities before downloads.
    // The scheduler uses both identities to serialize overlapping extraction.
    let target_prepare_start = Instant::now();
    let download_tasks = match download::prepare_download_tasks(download_tasks) {
        Ok(download_tasks) => {
            record_sandbox_op(
                "guest_storage_apply_target_prepare",
                target_prepare_start.elapsed(),
                true,
                None,
            );
            download_tasks
        }
        Err(e) => {
            record_sandbox_op(
                "guest_storage_apply_target_prepare",
                target_prepare_start.elapsed(),
                false,
                None,
            );
            log_error!(LOG_TAG, "{e}");
            instructions::cleanup_staged_instruction_sources(&instruction_files);
            return false;
        }
    };
    if !prepare_empty_artifacts(&empty_artifacts) {
        instructions::cleanup_staged_instruction_sources(&instruction_files);
        return false;
    }

    let scheduler_start = Instant::now();
    let success = download::download_all_parallel(download_tasks);
    record_sandbox_op(
        "guest_storage_apply_archive_scheduler",
        scheduler_start.elapsed(),
        success,
        None,
    );
    if success {
        let normalize_start = Instant::now();
        instructions::normalize_instruction_files(&instruction_files);
        record_sandbox_op(
            "guest_storage_apply_instruction_normalize",
            normalize_start.elapsed(),
            true,
            None,
        );
    } else {
        instructions::cleanup_staged_instruction_sources(&instruction_files);
    }
    success
}

fn prepare_empty_artifacts(entries: &[EmptyArtifactPreparation]) -> bool {
    for entry in entries {
        let start = Instant::now();
        match fs::create_dir_all(&entry.mount_path) {
            Ok(()) => {
                record_sandbox_op("artifact_empty_prepare", start.elapsed(), true, None);
                log_info!(
                    LOG_TAG,
                    "{} prepared in {}ms",
                    entry.label,
                    start.elapsed().as_millis()
                );
            }
            Err(e) => {
                let failure_detail = format!(
                    "{} prepare failed: failed to create directory: {e}",
                    entry.label
                );
                record_sandbox_op(
                    "artifact_empty_prepare",
                    start.elapsed(),
                    false,
                    Some(&failure_detail),
                );
                log_error!(LOG_TAG, "{failure_detail}");
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn run_manifest_removes_staged_instruction_source_when_download_fails() {
        let dir = tempfile::tempdir().unwrap();
        let extract_path = dir
            .path()
            .join("runtime")
            .join("storage-instructions")
            .join("0");
        let extract_parent = extract_path.parent().unwrap().to_path_buf();
        let missing_archive = dir.path().join("missing.tar.gz");
        let manifest = json!({
            "storageMounts": [{
                "mountPath": dir.path().join(".codex"),
                "extractPath": extract_path,
                "archiveUrl": format!("file://{}", missing_archive.display()),
                "instructionsTargetFilename": "AGENTS.md"
            }]
        });

        let success = super::run_manifest_bytes(&serde_json::to_vec(&manifest).unwrap());

        assert!(!success);
        assert!(!extract_path.exists());
        assert!(!extract_parent.exists());
    }

    #[test]
    fn run_manifest_prepares_explicit_empty_artifact_without_opening_archive() {
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("memory");
        let missing_archive = dir.path().join("missing-empty.tar.gz");
        let manifest = json!({
            "storageMounts": [{
                "mountPath": mount,
                "archiveUrl": format!("file://{}", missing_archive.display()),
                "empty": true,
                "name": "memory",
                "versionId": "empty-v1",
                "writeback": true
            }]
        });

        let success = super::run_manifest_bytes(&serde_json::to_vec(&manifest).unwrap());

        assert!(success);
        assert!(mount.is_dir());
    }

    #[test]
    fn run_manifest_prepares_explicit_empty_artifact_without_archive_url() {
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("memory");
        let manifest = json!({
            "storageMounts": [{
                "mountPath": mount,
                "empty": true,
                "name": "memory",
                "versionId": "empty-v1",
                "writeback": true
            }]
        });

        let success = super::run_manifest_bytes(&serde_json::to_vec(&manifest).unwrap());

        assert!(success);
        assert!(mount.is_dir());
    }

    #[test]
    fn run_manifest_removes_created_staged_instruction_sources_when_precreate_fails() {
        let dir = tempfile::tempdir().unwrap();
        let first_extract_path = dir
            .path()
            .join("runtime")
            .join("storage-instructions")
            .join("0");
        let first_extract_parent = first_extract_path.parent().unwrap().to_path_buf();
        let blocker = dir.path().join("blocker");
        let blocked_extract_path = blocker.join("storage-instructions").join("1");
        std::fs::write(&blocker, "not a directory").unwrap();
        let archive = dir.path().join("archive.tar.gz");
        let manifest = json!({
            "storageMounts": [
                {
                    "mountPath": dir.path().join(".codex"),
                    "extractPath": first_extract_path,
                    "archiveUrl": format!("file://{}", archive.display()),
                    "instructionsTargetFilename": "AGENTS.md"
                },
                {
                    "mountPath": dir.path().join(".claude"),
                    "extractPath": blocked_extract_path,
                    "archiveUrl": format!("file://{}", archive.display()),
                    "instructionsTargetFilename": "CLAUDE.md"
                }
            ]
        });

        let success = super::run_manifest_bytes(&serde_json::to_vec(&manifest).unwrap());

        assert!(!success);
        assert!(!first_extract_path.exists());
        assert!(!first_extract_parent.exists());
    }
}
