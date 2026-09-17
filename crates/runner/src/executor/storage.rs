//! Guest storage-manifest transport.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use guest_contracts::storage_files::{self, StorageFile};
use guest_contracts::storage_manifest::Manifest;
use sandbox::{
    EXEC_OUTPUT_LIMIT_1_MIB, EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox, StorageManifestRequest,
};
use tracing::{info, warn};

use super::{DEFAULT_EXEC_TIMEOUT, RunnerError, RunnerResult, guest_runtime_dir};
use crate::helper_exec::{format_helper_exec_failure, helper_exec_succeeded};
use crate::paths::guest;
use crate::storage_cache::decoded::CachedFiles;
use crate::types::ExecutionContext;

const STORAGE_MANIFEST_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) fn guest_storage_apply_command() -> String {
    format!("{} {}", guest::STORAGE_APPLY_BIN, guest::STORAGE_MANIFEST)
}

pub(super) fn guest_storage_manifest_cleanup_command() -> String {
    format!("rm -f -- {}", guest::STORAGE_MANIFEST)
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
    apply_storage_input(sandbox, context, &input).await
}

pub(super) async fn download_storages_with_files(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    manifest: Manifest,
    files: &[(String, Arc<CachedFiles>)],
) -> RunnerResult<()> {
    // Validate and encode every batch before the first storage-apply operation.
    for input in storage_inputs(manifest, files)? {
        apply_storage_input(sandbox, context, &input).await?;
    }
    Ok(())
}

enum StorageInput {
    Json(Vec<u8>),
    Files(Vec<u8>),
}

fn manifest_json(manifest: &Manifest) -> RunnerResult<Vec<u8>> {
    serde_json::to_vec(manifest).map_err(|e| RunnerError::Internal(format!("manifest json: {e}")))
}

fn files_input(json: &[u8], groups: &[(&str, &[StorageFile])]) -> RunnerResult<StorageInput> {
    storage_files::encode_input(json, groups)
        .map(StorageInput::Files)
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
    if json.len() <= storage_files::MAX_MANIFEST_BYTES {
        return Ok(vec![files_input(&json, &groups)?]);
    }
    // A split request alone cannot see conflicts with entries in another batch.
    storage_files::validate_bindings(&manifest, groups.iter().map(|(mount, _)| *mount))
        .map_err(|e| RunnerError::Internal(format!("storage files bindings: {e}")))?;
    drop(json);
    // Batching does not increase the aggregate selected-file or mount budget.
    drop(
        storage_files::encode(&groups)
            .map_err(|e| RunnerError::Internal(format!("storage files payload: {e}")))?,
    );
    let files_by_mount = groups.into_iter().collect::<HashMap<_, _>>();
    let (decoded, ordinary) = std::mem::take(&mut manifest.storages)
        .into_iter()
        .partition(|entry| files_by_mount.contains_key(entry.mount_path.as_str()));
    manifest.storages = ordinary;
    let mut inputs = Vec::new();
    // All cleanup, reused paths, instructions and artifacts stay together and
    // run before any decoded writes. Subsequent batches never repeat cleanup.
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
    for entry in decoded {
        let single = Manifest {
            storages: vec![entry.clone()],
            ..empty_storage_manifest()
        };
        let single_bytes = manifest_json(&single)?.len();
        if single_bytes > storage_files::MAX_MANIFEST_BYTES {
            return Err(RunnerError::Internal(
                "decoded storage entry exceeds manifest limit".into(),
            ));
        }
        // Exact canonical array accounting, including escaped field contents.
        // The codec revalidates each final serialized batch against the cap.
        let entry_bytes = single_bytes - empty_bytes;
        let comma_bytes = usize::from(!batch.storages.is_empty());
        if batch_bytes + comma_bytes + entry_bytes > storage_files::MAX_MANIFEST_BYTES {
            inputs.push(encode_storage_batch(&batch, &files_by_mount)?);
            batch.storages.clear();
            batch_bytes = empty_bytes;
        }
        batch_bytes += usize::from(!batch.storages.is_empty()) + entry_bytes;
        batch.storages.push(entry);
    }
    if !batch.storages.is_empty() {
        inputs.push(encode_storage_batch(&batch, &files_by_mount)?);
    }
    Ok(inputs)
}

fn encode_storage_batch(
    manifest: &Manifest,
    files: &HashMap<&str, &[StorageFile]>,
) -> RunnerResult<StorageInput> {
    let groups = manifest
        .storages
        .iter()
        .map(|entry| {
            files
                .get(entry.mount_path.as_str())
                .map(|files| (entry.mount_path.as_str(), *files))
                .ok_or_else(|| RunnerError::Internal("decoded storage files absent".into()))
        })
        .collect::<RunnerResult<Vec<_>>>()?;
    files_input(&manifest_json(manifest)?, &groups)
}

async fn apply_storage_input(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    input: &StorageInput,
) -> RunnerResult<()> {
    let (manifest_json, has_files) = match input {
        StorageInput::Json(bytes) => (bytes, false),
        StorageInput::Files(bytes) => (bytes, true),
    };
    let run_id = context.run_id.to_string();
    let runtime_dir = guest_runtime_dir(context.run_id)?;
    let use_dedicated =
        has_files || manifest_json.len() <= guest_control_proto::MAX_EXEC_STDIN_BYTES;
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
            .write_file(guest::STORAGE_MANIFEST, manifest_json)
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
