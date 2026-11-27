//! Apply guest storage/artifact manifests and replace claim-time Agent instructions.
//!
//! Features:
//! - Bounded parallel downloads using std::thread, with worker budgets selected
//!   for local extraction and remote response waits
//! - Streaming extraction; immutable template archives use bounded temporary verification
//!
//! ## Manifest application and failure semantics
//!
//! [`run`] and [`run_manifest_bytes`] apply valid manifests directly to the
//! filesystem without a transaction. Manifest-requested stale-path and instruction-file
//! cleanups must succeed before target preparation and
//! downloads. A failure stops later phases; a later failure does not restore
//! completed filesystem changes.
//!
//! The explicit runtime entry points may isolate discarded input directories
//! under the existing private runtime parent. Active paths are cleared
//! before replacement; existing post-Run preparation owns physical deletion
//! before reuse or Home publication. This retains old disk allocations until
//! cleanup; ordinary library entry points retain synchronous removal.
//!
//! Downloads whose targets do not overlap may run concurrently. A failed task
//! does not cancel its siblings, so a `false` result can coexist with targets
//! successfully materialized by other tasks. Archives extract in place, so a
//! failed task may also leave changes written by an earlier entry.
//! A packed decoded request finishes each batch before the next batch prepares
//! its targets. A failed batch stops later batches in the request.
//!
//! Required cleanup, target preparation, or download failure returns `false`,
//! preventing launch with incomplete inputs. Earlier filesystem effects are not
//! rolled back. Missing stale paths count as already cleaned.
//!
//! Cached storages and artifacts preserve their mount roots. Empty artifacts
//! retain root identity and ownership while clearing stale contents, including
//! when a containing directory is also cleaned. Instruction packages use the same
//! Storage delivery before managed instruction-file application.
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
mod manifest;
mod packed_files;
mod plan;
mod quarantine;
mod readiness;
mod source;
mod tar_metadata;
mod telemetry;
mod template_guidance;
mod workflow_document;

use guest_contracts::storage_manifest::Manifest;
use guest_telemetry::{log_error, log_info, telemetry::record_sandbox_op};
use manifest::ManifestLoadError;
use plan::{EmptyArtifactPreparation, RunPlan};
use std::fs;
use std::path::Path;
use std::time::Instant;

const LOG_TAG: &str = "sandbox:guest-storage-apply";

pub use guest_contracts::storage_manifest::TARGET_UNAVAILABLE_EXIT_CODE;

/// Terminal result of a Guest Storage operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApplyFailure {
    /// A local cleanup or write to a managed target could not be completed.
    TargetUnavailable,
    /// The input, its source, or the operation failed.
    Failed,
}

impl ApplyFailure {
    /// Classify an I/O error from a local destination operation.
    pub fn from_target_io(error: &std::io::Error) -> Self {
        use std::io::ErrorKind;
        if matches!(
            error.kind(),
            ErrorKind::PermissionDenied
                | ErrorKind::NotFound
                | ErrorKind::NotADirectory
                | ErrorKind::IsADirectory
                | ErrorKind::AlreadyExists
                | ErrorKind::DirectoryNotEmpty
        ) || error.raw_os_error() == Some(libc::ELOOP)
        {
            Self::TargetUnavailable
        } else {
            Self::Failed
        }
    }
}

/// Apply the manifest read from `manifest_path`.
///
/// Returns `true` when the manifest can be read and parsed and all required
/// cleanups, target preparations, and downloads
/// succeed. Returns `false` otherwise. A read or parse failure occurs before
/// manifest application; once application
/// starts, `false` does not roll back completed filesystem changes. See the
/// manifest application section in the [`crate`] documentation for details.
pub fn run(manifest_path: &str) -> bool {
    run_path_in_runtime(manifest_path, None).is_ok()
}

/// Apply a manifest with discarded inputs owned by the existing runtime cleanup.
/// Noncanonical runtime layouts retain synchronous cleanup.
pub fn run_in_runtime(manifest_path: &str, runtime_dir: &Path) -> Result<(), ApplyFailure> {
    run_path_in_runtime(manifest_path, Some(runtime_dir))
}

fn run_path_in_runtime(
    manifest_path: &str,
    runtime_dir: Option<&Path>,
) -> Result<(), ApplyFailure> {
    let manifest = match manifest::load(manifest_path) {
        Ok(manifest) => manifest,
        Err(ManifestLoadError::Read(e)) => {
            log_error!(LOG_TAG, "Failed to read manifest: {e}");
            return Err(ApplyFailure::Failed);
        }
        Err(ManifestLoadError::Parse(e)) => {
            log_error!(LOG_TAG, "Failed to parse manifest: {e}");
            return Err(ApplyFailure::Failed);
        }
    };

    run_manifest_with_files_in_runtime(manifest, Vec::new(), None, runtime_dir)
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
    run_manifest_bytes_in_context(manifest_json, None).is_ok()
}

/// Apply canonical manifest bytes with the captured per-Run cleanup lifetime.
pub fn run_manifest_bytes_in_runtime(
    manifest_json: &[u8],
    runtime_dir: &Path,
) -> Result<(), ApplyFailure> {
    run_manifest_bytes_in_context(manifest_json, Some(runtime_dir))
}

fn run_manifest_bytes_in_context(
    manifest_json: &[u8],
    runtime_dir: Option<&Path>,
) -> Result<(), ApplyFailure> {
    let manifest = match manifest::parse(manifest_json) {
        Ok(manifest) => manifest,
        Err(e) => {
            log_error!(LOG_TAG, "Failed to parse manifest: {e}");
            return Err(ApplyFailure::Failed);
        }
    };

    run_manifest_with_files_in_runtime(manifest, Vec::new(), None, runtime_dir)
}

/// Apply bounded binary storage input after validating all mount bindings and files.
pub fn run_storage_files_bytes(input: &[u8]) -> bool {
    run_storage_files_in_context(input, None).is_ok()
}

/// Apply a binary Storage input with the captured per-Run cleanup lifetime.
pub fn run_storage_files_bytes_in_runtime(
    input: &[u8],
    runtime_dir: &Path,
) -> Result<(), ApplyFailure> {
    run_storage_files_in_context(input, Some(runtime_dir))
}

fn run_storage_files_in_context(
    input: &[u8],
    runtime_dir: Option<&Path>,
) -> Result<(), ApplyFailure> {
    use guest_contracts::storage_files::inline_archives;
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
        if inline_archives::is_archive_payload(payload) {
            let archives = measure_phase(InputPhase::DecodeValidate, || {
                inline_archives::decode(payload)
            })?;
            return Ok((manifest, Vec::new(), Some(archives)));
        }
        let files = measure_phase(InputPhase::DecodeValidate, || {
            guest_contracts::storage_files::decode(payload)
        })?;
        measure_phase(InputPhase::Bindings, || {
            guest_contracts::storage_files::validate_bindings(
                &manifest,
                files.iter().map(|group| group.mount_path.as_str()),
            )
        })?;
        Ok::<_, std::io::Error>((manifest, files, None))
    })();
    match parsed {
        Ok((manifest, files, archives)) => {
            if archives.is_none() && packed_files::is_packed(&manifest) {
                packed_files::apply(manifest, files, runtime_dir)
            } else {
                run_manifest_with_files_in_runtime(manifest, files, archives, runtime_dir)
            }
        }
        Err(error) => {
            log_error!(LOG_TAG, "Invalid binary storage input: {error}");
            Err(ApplyFailure::Failed)
        }
    }
}

fn run_manifest_with_files_in_runtime(
    manifest: Manifest,
    files: Vec<guest_contracts::storage_files::StorageFiles<&[u8]>>,
    archives: Option<std::collections::HashMap<&str, &[u8]>>,
    runtime_dir: Option<&Path>,
) -> Result<(), ApplyFailure> {
    if let (Some(archives), Some(readiness)) = (&archives, &manifest.archive_readiness)
        && (readiness.check_only
            || readiness.sources.iter().any(|url| {
                url.strip_prefix("file://")
                    .is_some_and(|path| archives.contains_key(path))
            }))
    {
        log_error!(
            LOG_TAG,
            "Inline Storage archives must be ready application inputs"
        );
        return Err(ApplyFailure::Failed);
    }
    if manifest
        .archive_readiness
        .as_ref()
        .is_some_and(|value| value.check_only)
    {
        return match readiness::Readiness::eligible(&manifest, runtime_dir) {
            Ok(eligible) => {
                println!("{eligible}");
                Ok(())
            }
            Err(error) => {
                log_error!(LOG_TAG, "Archive readiness eligibility failed: {error}");
                Err(ApplyFailure::Failed)
            }
        };
    }
    // Validate and arm source publication before any input cleanup. Runtime
    // control files are private to this operation, never part of an input tree.
    let readiness = match readiness::Readiness::prepare(&manifest, runtime_dir) {
        Ok(readiness) => readiness,
        Err(error) => {
            log_error!(LOG_TAG, "Archive readiness preparation failed: {error}");
            return Err(ApplyFailure::Failed);
        }
    };
    let plan_start = Instant::now();
    let mut plan = RunPlan::from_manifest(&manifest);
    if let Some(archives) = archives {
        let started = Instant::now();
        let bound = bind_inline_archives(&mut plan.download_tasks, &archives);
        input_telemetry::record_phase(input_telemetry::InputPhase::Bindings, started, bound);
        if !bound {
            log_error!(
                LOG_TAG,
                "Inline Storage archive source missing from execution plan"
            );
            return Err(ApplyFailure::Failed);
        }
    }
    if !bind_decoded_files(&mut plan.download_tasks, files) {
        log_error!(
            LOG_TAG,
            "Decoded storage target missing from execution plan"
        );
        return Err(ApplyFailure::Failed);
    }
    let quarantine = match runtime_dir
        .map(|runtime| quarantine::Quarantine::for_manifest(&manifest, runtime))
        .transpose()
    {
        Ok(quarantine) => quarantine.flatten(),
        Err(error) => {
            log_error!(LOG_TAG, "Failed to prepare private input cleanup: {error}");
            return Err(ApplyFailure::Failed);
        }
    };
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
    let (stale_cleanup, stale_result) =
        telemetry::CleanupPhase::StalePaths.measure(cleanup_paths.len(), || {
            match quarantine.as_ref() {
                Some(quarantine) => cleanup::cleanup_stale_paths_with_quarantine(
                    &cleanup_paths,
                    &preserved_paths,
                    &retained_roots,
                    quarantine,
                ),
                None => {
                    cleanup::cleanup_stale_paths(&cleanup_paths, &preserved_paths, &retained_roots)
                }
            }
        });
    let (instruction_cleanup, cleanup_result) = match stale_result {
        Ok(()) => {
            let (observation, result) = telemetry::CleanupPhase::Instructions
                .measure(instruction_cleanups.len(), || {
                    instructions::cleanup_instruction_files(&instruction_cleanups)
                });
            (Some(observation), result)
        }
        Err(error) => (None, Err(error)),
    };
    record_sandbox_op(
        "guest_storage_apply_cleanup",
        cleanup_start.elapsed(),
        cleanup_result.is_ok(),
        None,
    );
    // Keep the new diagnostic writes outside the combined and phase timers.
    stale_cleanup.record();
    if let Some(observation) = instruction_cleanup {
        observation.record();
    }
    if let Err(error) = cleanup_result {
        log_error!(LOG_TAG, "Required storage cleanup failed: {error}");
        return Err(ApplyFailure::from_target_io(&error));
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
            return Err(e.failure);
        }
    };
    prepare_empty_artifacts(&empty_artifacts)?;

    let scheduler_start = Instant::now();
    let result = download::download_all_parallel(download_tasks, readiness);
    record_sandbox_op(
        "guest_storage_apply_archive_scheduler",
        scheduler_start.elapsed(),
        result.is_ok(),
        None,
    );
    result?;
    // Temporary migration reader: shared immutable packages retain their source
    // names/layout. Normalize only the materialized Workflow, never the cache.
    // Retire once staff and external copies declare their own names in SKILL.md
    // and old readers have drained.
    // https://github.com/okou-ai/okou/issues/46783
    match workflow_document::apply(&manifest.storages) {
        Ok(()) => Ok(()),
        Err(error) => {
            log_error!(LOG_TAG, "Workflow document materialization failed: {error}");
            Err(ApplyFailure::from_target_io(&error))
        }
    }
}

fn bind_inline_archives<'input>(
    tasks: &mut [download::DownloadTask<'input>],
    archives: &std::collections::HashMap<&str, &'input [u8]>,
) -> bool {
    let mut used = std::collections::HashSet::with_capacity(archives.len());
    for task in tasks {
        if let Some((source, &archive)) = task
            .local_archive_path()
            .and_then(|path| archives.get_key_value(path))
        {
            task.set_inline_archive(archive);
            used.insert(source);
        }
    }
    used.len() == archives.len()
}

fn bind_decoded_files<'input>(
    tasks: &mut [download::DownloadTask<'input>],
    files: Vec<guest_contracts::storage_files::StorageFiles<&'input [u8]>>,
) -> bool {
    let mut files = files.into_iter();
    let mut remaining_tasks = tasks.iter_mut();
    while let Some(group) = files.next() {
        let Some(task) = remaining_tasks.find(|task| task.mount_path() == group.mount_path) else {
            // Split inputs are emitted in manifest order, but the wire also
            // accepts groups in any order. Index only the unmatched groups.
            return bind_unordered_files(tasks, std::iter::once(group).chain(files));
        };
        task.set_files(group.files);
    }
    true
}

fn bind_unordered_files<'input>(
    tasks: &mut [download::DownloadTask<'input>],
    files: impl Iterator<Item = guest_contracts::storage_files::StorageFiles<&'input [u8]>>,
) -> bool {
    // Input validation already rejected duplicate exact mount paths.
    let mut by_mount: std::collections::HashMap<_, _> =
        files.map(|group| (group.mount_path, group.files)).collect();
    for task in tasks {
        if let Some(files) = by_mount.remove(task.mount_path()) {
            task.set_files(files);
            if by_mount.is_empty() {
                return true;
            }
        }
    }
    false
}

fn prepare_empty_artifacts(entries: &[EmptyArtifactPreparation]) -> Result<(), ApplyFailure> {
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
                return Err(ApplyFailure::from_target_io(&e));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;

mod agent_instructions;
pub use agent_instructions::{
    apply_agent_instructions, apply_agent_instructions_with_result, check_agent_instructions,
};
