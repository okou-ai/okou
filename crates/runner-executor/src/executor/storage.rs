//! Guest storage-manifest transport.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use guest_contracts::storage_files::{self, StorageFile};
use guest_contracts::storage_manifest::Manifest;
use sandbox::{
    EXEC_OUTPUT_LIMIT_1_MIB, EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox, StorageManifestRequest,
};
use tracing::{info, warn};

use super::{DEFAULT_EXEC_TIMEOUT, RunnerError, RunnerResult, guest_runtime_dir};
use crate::helper_exec::{format_helper_exec_failure, helper_exec_succeeded};
use crate::storage_cache::decoded::CachedFiles;
use crate::telemetry::JobTelemetry;
use guest_contracts::guest_binary::STORAGE_APPLY_PATH;
use guest_contracts::runtime_paths::STORAGE_MANIFEST_PATH;
use runner_types::types::ExecutionContext;

const STORAGE_MANIFEST_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RECORDED_STORAGE_BATCHES: usize = 16;

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
    apply_storage_input(sandbox, context, &input, &mut guest_duration_ms).await
}

pub(super) async fn download_storages_with_files(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    manifest: Manifest,
    files: &[(String, Arc<CachedFiles>)],
    telemetry: &mut JobTelemetry,
) -> RunnerResult<()> {
    // Validate and encode every batch before the first storage-apply operation.
    let encode_started = Instant::now();
    let inputs = storage_inputs(manifest, files);
    telemetry.record(
        "runner_storage_manifest_batch_encode",
        encode_started.elapsed(),
        inputs.is_ok(),
        inputs.as_ref().err().map(|_| "storage_batch_encode_failed"),
    );
    let inputs = inputs?;
    let batch_count = inputs.len();
    telemetry.record_bounded_outcome(
        "runner_storage_manifest_batch_count",
        true,
        batch_count_bucket(batch_count),
        None,
    );
    for (index, input) in inputs.iter().enumerate() {
        let started = Instant::now();
        let mut guest_duration_ms = None;
        let result = apply_storage_input(sandbox, context, input, &mut guest_duration_ms).await;
        // Keep telemetry bounded for an unusually large manifest. Always retain
        // the final or failing batch in addition to the first observed batches.
        if index < MAX_RECORDED_STORAGE_BATCHES || index + 1 == batch_count || result.is_err() {
            telemetry.record_storage_apply_batch(
                started.elapsed(),
                result.is_ok(),
                guest_duration_ms,
                batch_outcome(input, index, batch_count),
                manifest_size_bucket(input.manifest_bytes()),
            );
        }
        result?;
    }
    Ok(())
}

enum StorageInput {
    Json(Vec<u8>),
    Files {
        bytes: Vec<u8>,
        manifest_bytes: usize,
    },
}

impl StorageInput {
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

fn files_input(json: &[u8], groups: &[(&str, &[StorageFile])]) -> RunnerResult<StorageInput> {
    storage_files::encode_input(json, groups)
        .map(|bytes| StorageInput::Files {
            bytes,
            manifest_bytes: json.len(),
        })
        .map_err(|e| RunnerError::Internal(format!("storage files input: {e}")))
}

fn empty_storage_manifest() -> Manifest {
    Manifest {
        storages: Vec::new(),
        artifacts: Vec::new(),
        cleanup_paths: Vec::new(),
        instruction_cleanups: Vec::new(),
    }
}

fn storage_inputs(
    mut manifest: Manifest,
    files: &[(String, Arc<CachedFiles>)],
) -> RunnerResult<Vec<StorageInput>> {
    let json = manifest_json(&manifest)?;
    if files.is_empty() {
        return Ok(vec![StorageInput::Json(json)]);
    }
    let groups = files
        .iter()
        .map(|(mount, files)| (mount.as_str(), files.files.as_slice()))
        .collect::<Vec<_>>();
    storage_files::validate_bindings(&manifest, groups.iter().map(|(mount, _)| *mount))
        .map_err(|e| RunnerError::Internal(format!("storage files bindings: {e}")))?;
    if json.len() <= storage_files::MAX_MANIFEST_BYTES {
        return Ok(vec![files_input(&json, &groups)?]);
    }
    // A split request alone cannot see conflicts with entries in another batch.
    drop(json);
    // Validate the aggregate selected-file and mount budget without copying the
    // complete payload. Each emitted batch is encoded and checked below.
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
        inputs.push(StorageInput::Json(manifest_json(&manifest)?));
    }
    let mut batch = empty_storage_manifest();
    let empty_bytes = manifest_json(&batch)?.len();
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
        let single = entry.single_manifest();
        let single_bytes = manifest_json(&single)?.len();
        if single_bytes > storage_files::MAX_MANIFEST_BYTES {
            return Err(RunnerError::Internal(
                "decoded manifest entry exceeds manifest limit".into(),
            ));
        }
        // Exact canonical array accounting, including escaped field contents.
        // The codec revalidates each final serialized batch against the cap.
        let entry_bytes = single_bytes - empty_bytes;
        let comma_bytes = entry.comma_bytes(&batch);
        if batch_bytes + comma_bytes + entry_bytes > storage_files::MAX_MANIFEST_BYTES {
            inputs.push(encode_decoded_batch(&batch, &files_by_mount)?);
            batch = empty_storage_manifest();
            batch_bytes = empty_bytes;
        }
        batch_bytes += entry.comma_bytes(&batch) + entry_bytes;
        entry.push_into(&mut batch);
    }
    if manifest_entry_count(&batch) > 0 {
        inputs.push(encode_decoded_batch(&batch, &files_by_mount)?);
    }
    Ok(inputs)
}

enum DecodedManifestEntry {
    Storage(guest_contracts::storage_manifest::StorageEntry),
    Artifact(guest_contracts::storage_manifest::ArtifactEntry),
}

impl DecodedManifestEntry {
    fn single_manifest(&self) -> Manifest {
        match self {
            Self::Storage(entry) => Manifest {
                storages: vec![entry.clone()],
                ..empty_storage_manifest()
            },
            Self::Artifact(entry) => Manifest {
                artifacts: vec![entry.clone()],
                ..empty_storage_manifest()
            },
        }
    }

    fn push_into(self, manifest: &mut Manifest) {
        match self {
            Self::Storage(entry) => manifest.storages.push(entry),
            Self::Artifact(entry) => manifest.artifacts.push(entry),
        }
    }

    fn comma_bytes(&self, manifest: &Manifest) -> usize {
        match self {
            Self::Storage(_) => usize::from(!manifest.storages.is_empty()),
            Self::Artifact(_) => usize::from(!manifest.artifacts.is_empty()),
        }
    }
}

fn manifest_entry_count(manifest: &Manifest) -> usize {
    manifest.storages.len() + manifest.artifacts.len()
}

fn encode_decoded_batch(
    manifest: &Manifest,
    files: &HashMap<&str, &[StorageFile]>,
) -> RunnerResult<StorageInput> {
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
                .get(entry)
                .map(|files| (entry, *files))
                .ok_or_else(|| RunnerError::Internal("decoded files absent".into()))
        })
        .collect::<RunnerResult<Vec<_>>>()?;
    files_input(&manifest_json(manifest)?, &groups)
}

async fn apply_storage_input(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    input: &StorageInput,
    guest_duration_ms: &mut Option<u32>,
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

    info!(run_id = %context.run_id, transport, "downloading storages");
    let result = if use_dedicated {
        sandbox
            .apply_storage_manifest(&StorageManifestRequest {
                manifest_json,
                run_id: &run_id,
                runtime_dir: &runtime_dir,
                timeout: DEFAULT_EXEC_TIMEOUT,
            })
            .await
    } else {
        remove_fallback_storage_manifest(sandbox).await?;
        if let Err(error) = sandbox
            .write_file(STORAGE_MANIFEST_PATH, manifest_json)
            .await
        {
            cleanup_fallback_storage_manifest_after_failure(sandbox, context).await;
            return Err(error.into());
        }
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
            .await
    };
    let result = match result {
        Ok(result) => result,
        Err(e) => {
            if !use_dedicated {
                cleanup_fallback_storage_manifest_after_failure(sandbox, context).await;
            }
            return Err(e.into());
        }
    };

    *guest_duration_ms = result.guest_duration_ms;

    if !helper_exec_succeeded(&result) {
        if !use_dedicated {
            cleanup_fallback_storage_manifest_after_failure(sandbox, context).await;
        }
        return Err(RunnerError::Internal(format_guest_storage_apply_failure(
            &result,
        )));
    }
    Ok(())
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
