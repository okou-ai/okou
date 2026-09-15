//! Guest storage-manifest transport.

use std::time::Duration;

use guest_contracts::storage_manifest::Manifest;
use sandbox::{
    EXEC_OUTPUT_LIMIT_1_MIB, EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox, StorageManifestRequest,
};
use tracing::{info, warn};

use super::{DEFAULT_EXEC_TIMEOUT, RunnerError, RunnerResult, guest_runtime_dir};
use crate::helper_exec::{format_helper_exec_failure, helper_exec_succeeded};
use crate::paths::guest;
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
    download_storages_with_files(sandbox, context, manifest, &[]).await
}

pub(super) async fn download_storages_with_files(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    manifest: &Manifest,
    files: &[(
        String,
        std::sync::Arc<crate::storage_cache::decoded::CachedFiles>,
    )],
) -> RunnerResult<()> {
    let manifest_json = serde_json::to_vec(manifest)
        .map_err(|e| RunnerError::Internal(format!("manifest json: {e}")))?;
    let manifest_json = if files.is_empty() {
        manifest_json
    } else {
        let groups = files
            .iter()
            .map(|(mount, files)| (mount.as_str(), files.files.as_slice()))
            .collect::<Vec<_>>();
        guest_contracts::storage_files::encode_input(&manifest_json, &groups)
            .map_err(|e| RunnerError::Internal(format!("storage files input: {e}")))?
    };
    let run_id = context.run_id.to_string();
    let runtime_dir = guest_runtime_dir(context.run_id)?;
    let use_dedicated =
        !files.is_empty() || manifest_json.len() <= guest_control_proto::MAX_EXEC_STDIN_BYTES;
    let transport = if use_dedicated {
        "dedicated"
    } else {
        "fallback"
    };

    info!(run_id = %context.run_id, transport, "downloading storages");
    let result = if use_dedicated {
        sandbox
            .apply_storage_manifest(&StorageManifestRequest {
                manifest_json: &manifest_json,
                run_id: &run_id,
                runtime_dir: &runtime_dir,
                timeout: DEFAULT_EXEC_TIMEOUT,
            })
            .await
    } else {
        remove_fallback_storage_manifest(sandbox).await?;
        if let Err(error) = sandbox
            .write_file(guest::STORAGE_MANIFEST, &manifest_json)
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
