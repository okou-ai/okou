//! Guest storage-manifest transport.

use std::collections::HashMap;
use std::io::{self, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};

use guest_contracts::storage_files::{self, StorageFile};
use guest_contracts::storage_manifest::Manifest;
use sandbox::{
    EXEC_OUTPUT_LIMIT_1_MIB, EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox,
    StorageManifestRequest, StorageManifestTiming,
};
use tracing::{info, warn};

use super::{DEFAULT_EXEC_TIMEOUT, RunnerError, RunnerResult, guest_runtime_dir};
use crate::helper_exec::{format_helper_exec_failure, helper_exec_succeeded};
use crate::storage_cache::PendingGuestArchives;
use crate::storage_cache::decoded::CachedFiles;
use crate::telemetry::{JobTelemetry, StorageBatchDimensions};
use guest_contracts::guest_binary::STORAGE_APPLY_PATH;
use guest_contracts::runtime_paths::STORAGE_MANIFEST_PATH;
use runner_types::types::ExecutionContext;

const STORAGE_MANIFEST_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RECORDED_STORAGE_BATCHES: usize = 16;

mod agent_instructions;
pub(super) use agent_instructions::{
    CompletedInstructionCheck, InstructionReuse, InstructionReusePlan, apply_agent_instructions,
    check_instruction_reuse, plan_instruction_reuse,
};

fn storage_helper_failure(failure: String, result: &sandbox::ExecResult) -> RunnerError {
    if matches!(
        result.termination,
        sandbox::ExecTermination::Exited {
            exit_code: guest_contracts::storage_manifest::TARGET_UNAVAILABLE_EXIT_CODE
        }
    ) {
        RunnerError::StorageTargetUnavailable(failure)
    } else {
        RunnerError::Internal(failure)
    }
}
pub(super) async fn publish_bootstrap_files(
    sandbox: &dyn Sandbox,
    files: &[sandbox::WriteFileEntry<'_>],
    telemetry: &mut JobTelemetry,
) -> RunnerResult<()> {
    let started = Instant::now();
    let result = sandbox.write_private_files(files).await;
    telemetry.record(
        "runner_bootstrap_private_publish",
        started.elapsed(),
        result.is_ok(),
        None,
    );
    result.map_err(Into::into)
}

// Runner-local INFO only. Keep API keys when cache delivery uses file://;
// this source list does not claim every source was downloaded in this batch.
fn r2_storage_sources(
    manifest: Option<&runner_types::storage_manifest::StorageManifest>,
) -> serde_json::Value {
    let sources = manifest
        .into_iter()
        .flat_map(|manifest| {
            manifest
                .storages
                .iter()
                .map(|entry| {
                    (
                        Some(entry.archive_url.as_str()),
                        entry.vas_storage_name.as_str(),
                        entry.vas_version_id.as_str(),
                        entry.mount_path.as_str(),
                    )
                })
                .chain(
                    manifest
                        .artifacts
                        .iter()
                        .filter(|entry| entry.empty != Some(true))
                        .map(|entry| {
                            (
                                entry.archive_url.as_deref(),
                                entry.vas_storage_name.as_str(),
                                entry.vas_version_id.as_str(),
                                entry.mount_path.as_str(),
                            )
                        }),
                )
        })
        .filter_map(|(url, name, version_id, mount_path)| {
            let key = runner_storage::r2_download::key_from_url(url?)?;
            Some(serde_json::json!({
                "name": name,
                "version_id": version_id,
                "mount_path": mount_path,
                "r2_key": key,
            }))
        })
        .collect();
    serde_json::Value::Array(sources)
}

pub(super) fn guest_storage_apply_command() -> String {
    format!("{STORAGE_APPLY_PATH} {STORAGE_MANIFEST_PATH}")
}

pub(super) fn guest_storage_manifest_cleanup_command() -> String {
    format!("rm -f -- {STORAGE_MANIFEST_PATH}")
}

pub(super) fn guest_storage_apply_env<'a>(
    run_id: &'a str,
    runtime_dir: &'a str,
) -> [(&'static str, &'a str); 2] {
    [
        (guest_contracts::env::RUN_ID_ENV, run_id),
        (
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            runtime_dir,
        ),
    ]
}

#[cfg(test)]
pub(super) async fn download_storages(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    manifest: &Manifest,
) -> RunnerResult<()> {
    let input = StorageInput::Json(manifest_json(manifest)?);
    let mut guest_duration_ms = None;
    let mut host_timing = StorageManifestTiming::default();
    apply_storage_input(
        sandbox,
        context,
        &input,
        &mut guest_duration_ms,
        &mut host_timing,
    )
    .await
}

#[cfg(test)]
pub(super) async fn download_storages_with_files(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    manifest: Manifest,
    files: &[(String, Arc<CachedFiles>)],
    telemetry: &mut JobTelemetry,
) -> RunnerResult<()> {
    download_storages_sequential(
        sandbox,
        context,
        manifest,
        files,
        telemetry,
        PendingGuestArchives::default(),
    )
    .await
}

pub(super) async fn download_storages_sequential(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    manifest: Manifest,
    files: &[(String, Arc<CachedFiles>)],
    telemetry: &mut JobTelemetry,
    pending_archives: PendingGuestArchives,
) -> RunnerResult<()> {
    download_storages_with_files_inner(
        sandbox,
        context,
        manifest,
        files,
        telemetry,
        None,
        pending_archives,
    )
    .await
}

/// Stop later batches on a sibling failure without abandoning accepted Guest IO.
pub(super) async fn download_storages_with_files_until_cancelled(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    manifest: Manifest,
    files: &[(String, Arc<CachedFiles>)],
    telemetry: &mut JobTelemetry,
    cancel: &tokio_util::sync::CancellationToken,
    pending_archives: PendingGuestArchives,
) -> RunnerResult<()> {
    download_storages_with_files_inner(
        sandbox,
        context,
        manifest,
        files,
        telemetry,
        Some(cancel),
        pending_archives,
    )
    .await
}

async fn download_storages_with_files_inner(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    manifest: Manifest,
    files: &[(String, Arc<CachedFiles>)],
    telemetry: &mut JobTelemetry,
    cancel: Option<&tokio_util::sync::CancellationToken>,
    pending_archives: PendingGuestArchives,
) -> RunnerResult<()> {
    // Complete all fallible preparation before the first Guest mutation.
    let prepare_started = Instant::now();
    let allow_inline =
        !pending_archives.is_empty() && PendingGuestArchives::mounts_allow_inline(&manifest);
    let inputs = storage_inputs(manifest, files);
    telemetry.record(
        "runner_storage_manifest_batch_prepare",
        prepare_started.elapsed(),
        inputs.is_ok(),
        inputs
            .as_ref()
            .err()
            .map(|_| "storage_batch_prepare_failed"),
    );
    let mut inputs = match inputs {
        Ok(inputs) => inputs,
        Err(error) => {
            pending_archives.finish_without_staging(telemetry);
            return Err(error);
        }
    };
    if !pending_archives.is_empty() {
        if cancel.is_some_and(tokio_util::sync::CancellationToken::is_cancelled) {
            pending_archives.finish_without_staging(telemetry);
            return Err(RunnerError::Cancelled);
        }
        if allow_inline
            && let Some(first) = inputs.first_mut()
            && first.attach_archives(&pending_archives)
        {
            let action = if pending_archives.is_fresh() {
                "storage_cache_fresh_delivery_inlined"
            } else {
                "storage_cache_warm_archives_inlined"
            };
            pending_archives.finish_without_staging(telemetry);
            telemetry.record(action, Duration::ZERO, true, None);
        } else {
            pending_archives.stage(sandbox, telemetry).await?;
        }
    }
    let batch_count = inputs.len();
    telemetry.record_bounded_outcome(
        "runner_storage_manifest_batch_count",
        true,
        batch_count_bucket(batch_count),
        None,
    );
    // Only the current transport buffer is materialized across Guest IO.
    for (index, prepared) in inputs.into_iter().enumerate() {
        if cancel.is_some_and(tokio_util::sync::CancellationToken::is_cancelled) {
            return Err(RunnerError::Cancelled);
        }
        let started = Instant::now();
        let input = prepared.into_input();
        let mut guest_duration_ms = None;
        let mut host_timing = StorageManifestTiming::default();
        let result = apply_storage_input(
            sandbox,
            context,
            &input,
            &mut guest_duration_ms,
            &mut host_timing,
        )
        .await;
        // Keep telemetry bounded for an unusually large manifest. Always retain
        // the final or failing batch in addition to the first observed batches.
        if index < MAX_RECORDED_STORAGE_BATCHES || index + 1 == batch_count || result.is_err() {
            telemetry.record_storage_apply_batch(
                started.elapsed(),
                result.is_ok(),
                guest_duration_ms,
                &host_timing,
                StorageBatchDimensions {
                    transport_position: batch_outcome(&input, index, batch_count),
                    manifest_size_bucket: manifest_size_bucket(input.manifest_bytes()),
                    payload_size_bucket: input.payload_size_bucket(),
                },
            );
        }
        result?;
    }
    Ok(())
}

enum PreparedStorageInput<'a> {
    Json(Vec<u8>),
    Files(storage_files::PreparedInput<'a>),
    Archives {
        bytes: Vec<u8>,
        manifest_bytes: usize,
    },
}

impl PreparedStorageInput<'_> {
    fn attach_archives(&mut self, archives: &PendingGuestArchives) -> bool {
        let Self::Json(json) = self else {
            return false;
        };
        let Some(bytes) = archives.inline_input(json) else {
            return false;
        };
        *self = Self::Archives {
            bytes,
            manifest_bytes: json.len(),
        };
        true
    }

    fn into_input(self) -> StorageInput {
        match self {
            Self::Json(bytes) => StorageInput::Json(bytes),
            Self::Files(input) => {
                let manifest_bytes = input.manifest_len();
                let payload_size_bucket = binary_payload_size_bucket(input.payload_len());
                StorageInput::Files {
                    bytes: input.into_bytes(),
                    manifest_bytes,
                    payload_size_bucket,
                }
            }
            Self::Archives {
                bytes,
                manifest_bytes,
            } => StorageInput::Files {
                payload_size_bucket: binary_payload_size_bucket(bytes.len() - manifest_bytes - 16),
                bytes,
                manifest_bytes,
            },
        }
    }
}

enum StorageInput {
    Json(Vec<u8>),
    Files {
        bytes: Vec<u8>,
        manifest_bytes: usize,
        payload_size_bucket: &'static str,
    },
}

impl StorageInput {
    fn payload_size_bucket(&self) -> &'static str {
        match self {
            Self::Json(_) => "none",
            Self::Files {
                payload_size_bucket,
                ..
            } => payload_size_bucket,
        }
    }

    fn manifest_bytes(&self) -> usize {
        match self {
            Self::Json(bytes) => bytes.len(),
            Self::Files { manifest_bytes, .. } => *manifest_bytes,
        }
    }

    fn uses_dedicated_transport(&self) -> bool {
        matches!(self, Self::Files { .. })
            || self.manifest_bytes() <= guest_control_proto::MAX_EXEC_STDIN_BYTES
    }
}

fn binary_payload_size_bucket(bytes: usize) -> &'static str {
    if bytes <= 4 * 1024 {
        "up_to_4_kib"
    } else if bytes <= 16 * 1024 {
        "4_to_16_kib"
    } else if bytes <= 64 * 1024 {
        "16_to_64_kib"
    } else if bytes <= 256 * 1024 {
        "64_to_256_kib"
    } else if bytes <= 1024 * 1024 {
        "256_kib_to_1_mib"
    } else if bytes <= 4 * 1024 * 1024 {
        "1_to_4_mib"
    } else {
        // The constructor has already enforced MAX_PAYLOAD_BYTES.
        "4_to_15_mib"
    }
}

fn batch_count_bucket(count: usize) -> &'static str {
    match count {
        0 => "zero",
        1 => "one",
        2 => "two",
        3 => "three",
        4..=8 => "four_to_eight",
        9..=16 => "nine_to_sixteen",
        _ => "seventeen_plus",
    }
}

fn manifest_size_bucket(bytes: usize) -> &'static str {
    match bytes {
        0..=4_096 => "at_most_4_kib",
        4_097..=16_384 => "4_to_16_kib",
        16_385..=32_768 => "16_to_32_kib",
        32_769..=65_536 => "32_to_64_kib",
        _ => "over_64_kib",
    }
}

fn batch_outcome(input: &StorageInput, index: usize, count: usize) -> &'static str {
    let position = if count == 1 {
        BatchPosition::Only
    } else if index == 0 {
        BatchPosition::First
    } else if index + 1 == count {
        BatchPosition::Last
    } else {
        BatchPosition::Middle
    };
    match (input.uses_dedicated_transport(), position) {
        (true, BatchPosition::Only) => "dedicated_only",
        (true, BatchPosition::First) => "dedicated_first",
        (true, BatchPosition::Middle) => "dedicated_middle",
        (true, BatchPosition::Last) => "dedicated_last",
        (false, BatchPosition::Only) => "fallback_only",
        (false, BatchPosition::First) => "fallback_first",
        (false, BatchPosition::Middle) => "fallback_middle",
        (false, BatchPosition::Last) => "fallback_last",
    }
}

enum BatchPosition {
    Only,
    First,
    Middle,
    Last,
}

fn manifest_json(manifest: &Manifest) -> RunnerResult<Vec<u8>> {
    serde_json::to_vec(manifest).map_err(|e| RunnerError::Internal(format!("manifest json: {e}")))
}

#[derive(Default)]
struct ManifestSize(usize);

impl Write for ManifestSize {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::other("manifest JSON size overflow"))?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// Probe exact canonical bytes without retaining output that would be discarded
// when decoded input must split. Actual transport serialization remains below.
fn manifest_json_size(manifest: &Manifest) -> RunnerResult<usize> {
    let mut size = ManifestSize::default();
    serde_json::to_writer(&mut size, manifest)
        .map_err(|e| RunnerError::Internal(format!("manifest json: {e}")))?;
    Ok(size.0)
}

fn files_input<'a>(
    json: Vec<u8>,
    groups: Vec<(&'a str, &'a [StorageFile])>,
) -> RunnerResult<PreparedStorageInput<'a>> {
    storage_files::PreparedInput::new(json, groups)
        .map(PreparedStorageInput::Files)
        .map_err(|e| RunnerError::Internal(format!("storage files input: {e}")))
}

fn empty_storage_manifest() -> Manifest {
    Manifest {
        archive_readiness: None,
        storages: Vec::new(),
        artifacts: Vec::new(),
        cleanup_paths: Vec::new(),
        instruction_cleanups: Vec::new(),
    }
}

fn storage_inputs(
    mut manifest: Manifest,
    files: &[(String, Arc<CachedFiles>)],
) -> RunnerResult<Vec<PreparedStorageInput<'_>>> {
    if files.is_empty() {
        return Ok(vec![PreparedStorageInput::Json(manifest_json(&manifest)?)]);
    }
    let groups = files
        .iter()
        .map(|(mount, files)| (mount.as_str(), files.files.as_slice()))
        .collect::<Vec<_>>();
    storage_files::validate_bindings(&manifest, groups.iter().map(|(mount, _)| *mount))
        .map_err(|e| RunnerError::Internal(format!("storage files bindings: {e}")))?;
    if manifest_json_size(&manifest)? <= storage_files::MAX_MANIFEST_BYTES {
        return Ok(vec![files_input(manifest_json(&manifest)?, groups)?]);
    }
    // A split request alone cannot see conflicts with entries in another batch.
    // Validate the aggregate selected-file and mount budget without copying the
    // complete payload. Each emitted batch is prepared and checked below.
    storage_files::encoded_payload_len(&groups)
        .map_err(|e| RunnerError::Internal(format!("storage files payload: {e}")))?;
    let files_by_mount = groups.into_iter().collect::<HashMap<_, _>>();
    let (decoded_storages, ordinary_storages) = std::mem::take(&mut manifest.storages)
        .into_iter()
        .partition(|entry| files_by_mount.contains_key(entry.mount_path.as_str()));
    let (decoded_artifacts, ordinary_artifacts) = std::mem::take(&mut manifest.artifacts)
        .into_iter()
        .partition(|entry| files_by_mount.contains_key(entry.mount_path.as_str()));
    manifest.storages = ordinary_storages;
    manifest.artifacts = ordinary_artifacts;
    let mut inputs = Vec::new();
    // All cleanup, reused paths, instructions and unselected artifacts stay
    // together and run before any decoded writes. Subsequent batches never
    // repeat cleanup.
    if !manifest.storages.is_empty()
        || !manifest.artifacts.is_empty()
        || !manifest.cleanup_paths.is_empty()
        || !manifest.instruction_cleanups.is_empty()
    {
        inputs.push(PreparedStorageInput::Json(manifest_json(&manifest)?));
    }
    let mut batch = empty_storage_manifest();
    let mut decoded_batches = Vec::new();
    let empty_bytes = manifest_json_size(&batch)?;
    let mut batch_bytes = empty_bytes;
    let decoded = decoded_storages
        .into_iter()
        .map(DecodedManifestEntry::Storage)
        .chain(
            decoded_artifacts
                .into_iter()
                .map(DecodedManifestEntry::Artifact),
        );
    for entry in decoded {
        let mut single = entry.single_manifest();
        let single_bytes = manifest_json_size(&single)?;
        if single_bytes > storage_files::MAX_MANIFEST_BYTES {
            return Err(RunnerError::Internal(
                "decoded manifest entry exceeds manifest limit".into(),
            ));
        }
        // Exact canonical array accounting, including escaped field contents.
        // The codec revalidates each final serialized batch against the cap.
        let entry_bytes = single_bytes - empty_bytes;
        let comma_bytes = usize::from(manifest_entry_count(&batch) > 0);
        if batch_bytes + comma_bytes + entry_bytes > storage_files::MAX_MANIFEST_BYTES {
            decoded_batches.push(batch);
            batch = empty_storage_manifest();
            batch_bytes = empty_bytes;
        }
        batch_bytes += usize::from(manifest_entry_count(&batch) > 0) + entry_bytes;
        batch.storages.append(&mut single.storages);
        batch.artifacts.append(&mut single.artifacts);
    }
    if manifest_entry_count(&batch) > 0 {
        decoded_batches.push(batch);
    }
    for batch in pack_decoded_batches(decoded_batches, empty_bytes)? {
        inputs.push(prepare_decoded_batch(&batch, &files_by_mount)?);
    }
    Ok(inputs)
}

enum DecodedManifestEntry {
    Storage(guest_contracts::storage_manifest::StorageEntry),
    Artifact(guest_contracts::storage_manifest::ArtifactEntry),
}

impl DecodedManifestEntry {
    fn single_manifest(self) -> Manifest {
        match self {
            Self::Storage(entry) => Manifest {
                storages: vec![entry],
                ..empty_storage_manifest()
            },
            Self::Artifact(entry) => Manifest {
                artifacts: vec![entry],
                ..empty_storage_manifest()
            },
        }
    }
}

fn pack_decoded_batches(
    mut batches: Vec<Manifest>,
    empty_bytes: usize,
) -> RunnerResult<Vec<Manifest>> {
    // Packing must never enlarge an individual batch that already fits the cap.
    if batches.len() < 2
        || batches
            .iter_mut()
            .flat_map(decoded_archive_urls)
            .any(|url| {
                url.as_ref()
                    .is_none_or(|url| url.len() < storage_files::PACKED_BATCH_START_URL.len())
            })
    {
        return Ok(batches);
    }

    let mut packed = Vec::new();
    let mut combined = empty_storage_manifest();
    let mut combined_bytes = empty_bytes;
    for mut batch in batches {
        let mut urls = decoded_archive_urls(&mut batch);
        if let Some(first) = urls.next() {
            *first = Some(storage_files::PACKED_BATCH_START_URL.into());
        }
        for url in urls {
            *url = Some(storage_files::PACKED_BATCH_FILE_URL.into());
        }
        let entry_bytes = manifest_json_size(&batch)? - empty_bytes;
        let comma_bytes = usize::from(manifest_entry_count(&combined) > 0);
        if combined_bytes + comma_bytes + entry_bytes > storage_files::MAX_MANIFEST_BYTES {
            packed.push(combined);
            combined = empty_storage_manifest();
            combined_bytes = empty_bytes;
        }
        // Each original batch stays whole. Its directory preparation must
        // follow the previous batch's writes, since guest paths can be aliases.
        combined_bytes += usize::from(manifest_entry_count(&combined) > 0) + entry_bytes;
        combined.storages.append(&mut batch.storages);
        combined.artifacts.append(&mut batch.artifacts);
    }
    packed.push(combined);
    Ok(packed)
}

fn decoded_archive_urls(manifest: &mut Manifest) -> impl Iterator<Item = &mut Option<String>> {
    manifest
        .storages
        .iter_mut()
        .map(|entry| &mut entry.archive_url)
        .chain(
            manifest
                .artifacts
                .iter_mut()
                .map(|entry| &mut entry.archive_url),
        )
}

fn manifest_entry_count(manifest: &Manifest) -> usize {
    manifest.storages.len() + manifest.artifacts.len()
}

fn prepare_decoded_batch<'a>(
    manifest: &Manifest,
    files: &HashMap<&'a str, &'a [StorageFile]>,
) -> RunnerResult<PreparedStorageInput<'a>> {
    let groups = manifest
        .storages
        .iter()
        .map(|entry| entry.mount_path.as_str())
        .chain(
            manifest
                .artifacts
                .iter()
                .map(|entry| entry.mount_path.as_str()),
        )
        .map(|entry| {
            files
                .get_key_value(entry)
                .map(|(mount, files)| (*mount, *files))
                .ok_or_else(|| RunnerError::Internal("decoded files absent".into()))
        })
        .collect::<RunnerResult<Vec<_>>>()?;
    files_input(manifest_json(manifest)?, groups)
}

async fn apply_storage_input(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    input: &StorageInput,
    guest_duration_ms: &mut Option<u32>,
    host_timing: &mut StorageManifestTiming,
) -> RunnerResult<()> {
    let manifest_json = match input {
        StorageInput::Json(bytes) => bytes,
        StorageInput::Files { bytes, .. } => bytes,
    };
    let run_id = context.run_id.to_string();
    let runtime_dir = guest_runtime_dir(context.run_id)?;
    let use_dedicated = input.uses_dedicated_transport();
    let transport = if use_dedicated {
        "dedicated"
    } else {
        "fallback"
    };

    info!(
        run_id = %context.run_id,
        transport,
        r2_storage_sources = %r2_storage_sources(context.storage_manifest.as_ref()),
        "downloading storages"
    );
    // Stale-file removal must succeed before this attempt can write a manifest.
    if !use_dedicated {
        remove_fallback_storage_manifest(sandbox).await?;
    }
    let result: RunnerResult<()> = async {
        let result = if use_dedicated {
            sandbox
                .apply_storage_manifest_with_timing(
                    &StorageManifestRequest {
                        manifest_json,
                        run_id: &run_id,
                        runtime_dir: &runtime_dir,
                        timeout: DEFAULT_EXEC_TIMEOUT,
                    },
                    host_timing,
                )
                .await?
        } else {
            sandbox
                .write_file(STORAGE_MANIFEST_PATH, manifest_json)
                .await?;
            let download_cmd = guest_storage_apply_command();
            let download_env = guest_storage_apply_env(&run_id, &runtime_dir);
            sandbox
                .exec_with_diagnostic_label(
                    &ExecRequest {
                        cmd: &download_cmd,
                        timeout: DEFAULT_EXEC_TIMEOUT,
                        env: &download_env,
                        sudo: false,
                        expected_exit_codes: &[],
                        stdin_bytes: None,
                        output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
                    },
                    "storage-download",
                )
                .await?
        };

        *guest_duration_ms = result.guest_duration_ms;

        if !helper_exec_succeeded(&result) {
            return Err(storage_helper_failure(
                format_guest_storage_apply_failure(&result),
                &result,
            ));
        }
        Ok(())
    }
    .await;
    if !use_dedicated && result.is_err() {
        cleanup_fallback_storage_manifest_after_failure(sandbox, context).await;
    }
    result
}

async fn cleanup_fallback_storage_manifest_after_failure(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
) {
    match remove_fallback_storage_manifest(sandbox).await {
        Ok(()) => {}
        Err(error) => {
            warn!(
                run_id = %context.run_id,
                error = %error,
                "failed to remove fallback storage manifest after fallback failure"
            );
        }
    }
}

async fn remove_fallback_storage_manifest(sandbox: &dyn Sandbox) -> RunnerResult<()> {
    let cleanup_cmd = guest_storage_manifest_cleanup_command();
    let result = sandbox
        .exec_with_diagnostic_label(
            &ExecRequest {
                cmd: &cleanup_cmd,
                timeout: STORAGE_MANIFEST_CLEANUP_TIMEOUT,
                env: &[],
                sudo: false,
                expected_exit_codes: &[],
                stdin_bytes: None,
                output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
            },
            "storage-manifest-cleanup",
        )
        .await?;

    if !helper_exec_succeeded(&result) {
        return Err(RunnerError::Internal(format_helper_exec_failure(
            "storage manifest cleanup",
            &result,
        )));
    }

    Ok(())
}

pub(super) fn format_guest_storage_apply_failure(result: &sandbox::ExecResult) -> String {
    format_helper_exec_failure("storage download", result)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod r2_log_tests;
