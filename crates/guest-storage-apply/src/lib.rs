//! Apply guest storage/artifact manifests and replace claim-time Agent instructions.
//!
//! Features:
//! - Parallel downloads using std::thread (max 4 concurrent)
//! - Streaming extraction (no temp files)
//!
//! ## Manifest application and failure semantics
//!
//! [`run`] and [`run_manifest_bytes`] apply valid manifests directly to the
//! filesystem without a transaction. Manifest-requested stale-path and instruction-file
//! cleanups must succeed before target preparation and
//! downloads. A failure stops later phases; a later failure does not restore
//! completed filesystem changes.
//!
//! Downloads whose targets do not overlap may run concurrently. A failed task
//! does not cancel its siblings, so a `false` result can coexist with targets
//! successfully materialized by other tasks. Archives extract in place, so a
//! failed task may also leave changes written by an earlier entry.
//!
//! Required cleanup, target preparation, or download failure returns `false`,
//! preventing launch with incomplete inputs. Earlier filesystem effects are not
//! rolled back. Missing stale paths count as already cleaned.
//!
//! Cached storages and artifacts preserve their mount roots. Empty artifacts
//! retain root identity and ownership while clearing stale contents, including
//! when a containing directory is also cleaned. Claim-time Agent instructions
//! are applied separately after Storage reconciliation through `apply_agent_instructions`.
//!
//! ## Archive metadata limits
//!
//! Each tar member has a 1 MiB budget for encoded metadata, including headers,
//! GNU/PAX extension bodies and padding, and GNU sparse maps. This is both an
//! individual-extension and combined metadata bound, enforced while tar parses
//! metadata, before it can buffer unbounded input. Vector capacity and parsed
//! descriptors add bounded overhead; the budget is not an exact heap/RSS cap.
//! Oversized metadata is an archive error. Ordinary file payloads
//! and their padding are exempt, including unread payloads of skipped entries;
//! sparse files retain their physical-data streaming and hole-seeking behavior.
//! The budget resets between members.
//!
//! ## Skipped archive entry diagnostics
//!
//! Each archive attempt logs at most 32 examples across its path/link rejection
//! checks, followed by one total skipped/suppressed-count summary when any entry
//! was skipped. Entry, link and archive-target paths in these diagnostics are
//! escaped and limited to 256 UTF8 bytes, including a truncation marker. No list
//! of rejected paths is retained, and concurrent attempts have separate budgets.
//! The summary is also emitted on an extraction error; it does not imply success
//! or roll back accepted entries. Diagnostic truncation never changes the paths
//! used for safety checks or extraction, and exhaustion continues safe skipping.

mod archive;
mod cleanup;
mod cleanup_directory;
mod connection_observation;
mod download;
mod error;
mod files;
mod http_failure;
pub mod input_telemetry;
mod instructions;
pub use instructions::apply_agent_instructions;
pub use instructions::apply_workflow_skill;
pub use instructions::apply_workflow_skill_documents;
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
/// cleanups, target preparations, and downloads
/// succeed. Returns `false` otherwise. A read or parse failure occurs before
/// manifest application; once application
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
/// Returns `true` when the manifest parses and all required cleanups, target
/// preparations and downloads succeed. Returns
/// `false` otherwise. A parse failure occurs
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

/// Apply bounded binary storage input after validating all mount bindings and files.
pub fn run_storage_files_bytes(input: &[u8]) -> bool {
    use input_telemetry::{InputPhase, measure_phase, record_payload_size};

    let parsed = (|| {
        let framed = measure_phase(InputPhase::Frame, || {
            guest_contracts::storage_files::split_input(input)
        });
        // Framing returns the actual binary payload slice; an invalid frame
        // cannot be treated as a zero-byte payload.
        record_payload_size(framed.as_ref().ok().map(|(_, payload)| payload.len()));
        let (json, payload) = framed?;
        let manifest = measure_phase(InputPhase::Parse, || {
            manifest::parse(json)
                .map_err(|_| std::io::Error::other("invalid storage manifest JSON"))
        })?;
        let files = measure_phase(InputPhase::DecodeValidate, || {
            guest_contracts::storage_files::decode(payload)
        })?;
        measure_phase(InputPhase::Bindings, || {
            guest_contracts::storage_files::validate_bindings(
                &manifest,
                files.iter().map(|group| group.mount_path.as_str()),
            )
        })?;
        Ok::<_, std::io::Error>((manifest, files))
    })();
    match parsed {
        Ok((manifest, files)) => run_manifest_with_files(manifest, files),
        Err(error) => {
            log_error!(LOG_TAG, "Invalid decoded storage input: {error}");
            false
        }
    }
}

fn run_manifest(manifest: Manifest) -> bool {
    run_manifest_with_files(manifest, Vec::new())
}

fn run_manifest_with_files(
    manifest: Manifest,
    files: Vec<guest_contracts::storage_files::StorageFiles>,
) -> bool {
    let plan_start = Instant::now();
    let mut plan = RunPlan::from_manifest(&manifest);
    for group in files {
        let Some(task) = plan
            .download_tasks
            .iter_mut()
            .find(|task| task.mount_path() == group.mount_path)
        else {
            log_error!(
                LOG_TAG,
                "Decoded storage target missing from execution plan"
            );
            return false;
        };
        task.set_files(group.files);
    }
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
    } = plan;

    // Clean stale files from changed/removed storages before downloading.
    // This must run before parallel downloads to avoid race conditions with
    // parent-child mount path overlaps.
    let cleanup_start = Instant::now();
    // Empty artifact reset must clear stale data without replacing the existing
    // mount-root inode and its sandbox-account ownership with a root-owned mkdir.
    let retained_roots = empty_artifacts
        .iter()
        .map(|entry| entry.mount_path.clone())
        .collect::<Vec<_>>();
    let cleanup_success =
        cleanup::cleanup_stale_paths(&cleanup_paths, &preserved_paths, &retained_roots)
            && instructions::cleanup_instruction_files(&instruction_cleanups);
    record_sandbox_op(
        "guest_storage_apply_cleanup",
        cleanup_start.elapsed(),
        cleanup_success,
        None,
    );
    if !cleanup_success {
        log_error!(LOG_TAG, "Required storage cleanup failed");
        return false;
    }

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
            return false;
        }
    };
    if !prepare_empty_artifacts(&empty_artifacts) {
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
    if !success {
        return false;
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
    fn empty_artifact_reset_preserves_directory_identity_and_permissions() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("workspace");
        std::fs::create_dir(&mount).unwrap();
        std::fs::set_permissions(&mount, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(mount.join("stale"), b"previous failed run data").unwrap();
        std::fs::create_dir(mount.join("lost+found")).unwrap();
        let before = mount.metadata().unwrap();
        let manifest = json!({
            "cleanupPaths": [dir.path()],
            "storageMounts": [{"mountPath": mount, "empty": true,
                "name": "workspace", "versionId": "empty-v1", "writeback": true}]
        });
        assert!(super::run_manifest_bytes(
            &serde_json::to_vec(&manifest).unwrap()
        ));
        let after = mount.metadata().unwrap();
        assert_eq!((after.dev(), after.ino()), (before.dev(), before.ino()));
        assert_eq!(
            (after.uid(), after.gid(), after.mode()),
            (before.uid(), before.gid(), before.mode())
        );
        assert_eq!(std::fs::read_dir(&mount).unwrap().count(), 0);
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
}

mod content_bundle;
pub use content_bundle::apply_content_bundle;
