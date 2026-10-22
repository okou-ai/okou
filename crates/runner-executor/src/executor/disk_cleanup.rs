//! One bounded cache-reclamation cycle before the agent process boundary.
//!
//! Each full filesystem is cleaned at most once, sequentially. The single
//! bootstrap retry requires adequate measured capacity on every selected target.

use std::time::{Duration, Instant};

use guest_contracts::disk_cleanup::{DiskCleanupFilesystem, DiskCleanupReport};
use guest_contracts::guest_binary::AGENT_PATH;
use sandbox::{
    EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox, SandboxError, SandboxOperation,
    SandboxOperationReason,
};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::diagnostics::{
    collect_agent_abnormal_exit_diagnostics, explicit_enospc_evidence, home_is_clearly_full,
    rootfs_is_clearly_full,
};
use super::{ResourceFailureDiagnostics, RunnerError, SandboxReuseResult};
use crate::helper_exec::helper_exec_succeeded;
use crate::telemetry::JobTelemetry;
use runner_types::types::ExecutionContext;

pub(super) fn is_disk_write_error(error: &RunnerError) -> bool {
    matches!(
        error,
        RunnerError::Sandbox(SandboxError::Operation {
            operation: SandboxOperation::WriteFile,
            reason: SandboxOperationReason::Guest,
            message,
        }) if explicit_enospc_evidence([message.as_str()])
    )
}

pub(super) struct DiskCleanupOutcome {
    pub(super) retry: bool,
    pub(super) diagnostics: Option<ResourceFailureDiagnostics>,
}

pub(super) async fn recover(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    reuse_result: SandboxReuseResult,
    cancel: &CancellationToken,
    telemetry: &mut JobTelemetry,
) -> DiskCleanupOutcome {
    let diagnostics = collect_agent_abnormal_exit_diagnostics(
        sandbox,
        context.run_id,
        sandbox.id(),
        reuse_result,
        1,
    )
    .await;
    let Some(usage) = diagnostics.as_ref() else {
        return DiskCleanupOutcome {
            retry: false,
            diagnostics,
        };
    };
    let filesystems = [
        home_is_clearly_full(usage).then_some(DiskCleanupFilesystem::Home),
        rootfs_is_clearly_full(usage).then_some(DiskCleanupFilesystem::Rootfs),
    ];
    let mut retry = filesystems.iter().any(Option::is_some);
    for filesystem in filesystems.into_iter().flatten() {
        if cancel.is_cancelled() {
            return DiskCleanupOutcome {
                retry: false,
                diagnostics,
            };
        }
        let Some(report) = cleanup_filesystem(sandbox, context, filesystem, telemetry).await else {
            return DiskCleanupOutcome {
                retry: false,
                diagnostics,
            };
        };
        // Insufficient space must not skip another selected filesystem.
        retry &= report.permits_retry();
    }
    DiskCleanupOutcome { retry, diagnostics }
}

async fn cleanup_filesystem(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    filesystem: DiskCleanupFilesystem,
    telemetry: &mut JobTelemetry,
) -> Option<DiskCleanupReport> {
    let command = format!("{AGENT_PATH} recover-disk-space {}", filesystem.as_str());
    let started = Instant::now();
    let result = sandbox
        .exec(&ExecRequest {
            cmd: &command,
            timeout: Duration::from_secs(30),
            env: &[],
            sudo: true,
            expected_exit_codes: &[],
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
        })
        .await;
    let report = match result {
        Ok(result)
            if helper_exec_succeeded(&result)
                && !result.stdout_truncated
                && !result.stderr_truncated =>
        {
            serde_json::from_slice::<DiskCleanupReport>(&result.stdout)
                .ok()
                .filter(|report| report.filesystem == filesystem)
        }
        Ok(_) => None,
        Err(error) => {
            warn!(run_id = %context.run_id, error = %error, "guest disk cleanup execution failed");
            None
        }
    };
    let retry = report
        .as_ref()
        .is_some_and(DiskCleanupReport::permits_retry);
    telemetry.record_with_outcome(
        "runner_bootstrap_disk_cleanup",
        started.elapsed(),
        retry,
        (!retry).then_some("cleanup_unavailable_or_insufficient"),
        Some(filesystem.as_str()),
    );
    if let Some(report) = report.as_ref() {
        info!(
            run_id = %context.run_id,
            filesystem = filesystem.as_str(),
            available_bytes_before = report.available_bytes_before,
            available_bytes_after = report.available_bytes_after,
            available_inodes_before = report.available_inodes_before,
            available_inodes_after = report.available_inodes_after,
            removed_entries = report.removed_entries,
            retry,
            "guest bootstrap disk cleanup completed"
        );
    }
    report
}
