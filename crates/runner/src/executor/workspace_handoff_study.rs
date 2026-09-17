//! Default-disabled, isolated API-to-spawn study integration.

use std::time::Instant;

use sandbox::WorkspaceDriveSeedImage;
use tracing::info;

use super::agent_run::PreparedRunInputs;
use super::reused_sandbox::ReusedSandboxRun;
use super::sandbox_run::{prepare_workspace_image, resolve_fresh_session_history_restore_plan};
use super::{ExecutorConfig, RunnerError, RunnerResult};
use crate::telemetry::JobTelemetry;
use crate::types::ExecutionContext;

pub(super) async fn prepare(
    run: &mut ReusedSandboxRun<'_>,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    telemetry: &mut JobTelemetry,
    inputs: &mut PreparedRunInputs,
) -> RunnerResult<()> {
    let started = Instant::now();
    let result = prepare_inner(run, context, config, telemetry, inputs).await;
    telemetry.record(
        "runner_workspace_handoff_study_prepare",
        started.elapsed(),
        result.is_ok(),
        result.as_ref().err().map(|_| "handoff_failed"),
    );
    result
}

async fn prepare_inner(
    run: &mut ReusedSandboxRun<'_>,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    telemetry: &mut JobTelemetry,
    inputs: &mut PreparedRunInputs,
) -> RunnerResult<()> {
    let admission_started = Instant::now();
    let lease = config
        .pre_spawn_admission
        .acquire(run.params.vcpu, &inputs.controls.cancel)
        .await?;
    telemetry.record(
        "runner_workspace_handoff_admission_wait",
        admission_started.elapsed(),
        true,
        None,
    );
    // Retain the same admission lease through the existing Agent-ready boundary.
    inputs.controls.pre_spawn_admission_lease = Some(lease);
    run.workspace_image = prepare_workspace_image(
        context,
        run.sandbox_id,
        config,
        &run.params.profile_name,
        run.params.workspace_disk_mb,
        run.params.workspace_image_prepare_lock_policy,
        telemetry,
    )
    .await;
    if inputs.controls.cancel.is_cancelled() {
        return Err(RunnerError::Cancelled);
    }
    if let Some(image) = run
        .workspace_image
        .as_ref()
        .filter(|image| image.is_cache_hit())
    {
        let seed = image
            .workspace_drive_config()
            .and_then(|drive| drive.seed_image)
            .ok_or_else(|| RunnerError::Internal("cached workspace handoff has no seed".into()))?;
        if !matches!(seed, WorkspaceDriveSeedImage::Move(_)) {
            return Err(RunnerError::Internal(
                "cached workspace handoff requires exclusive Move ownership".into(),
            ));
        }
        let handoff_started = Instant::now();
        // Do not drop a partially applied handoff future on cancellation: the backend
        // has bounded stages, then cancellation is observed before Agent preparation.
        let result = run.sandbox.replace_workspace_drive(seed).await;
        telemetry.record(
            "runner_workspace_handoff",
            handoff_started.elapsed(),
            result.is_ok(),
            result.as_ref().err().map(|_| "drive_handoff_failed"),
        );
        result?;
        if inputs.controls.cancel.is_cancelled() {
            return Err(RunnerError::Cancelled);
        }
        inputs.controls.require_guest_state_preparation();
        info!(run_id = %context.run_id, sandbox_id = %run.sandbox_id,
        "workspace handoff study activated cached image in Blank");
    }
    inputs.controls.session_history_restore_plan = resolve_fresh_session_history_restore_plan(
        std::mem::take(&mut inputs.controls.session_history_restore_plan),
        run.workspace_image.as_ref(),
        context,
        config,
        inputs.controls.cancel.clone(),
        telemetry,
    )
    .await;
    Ok(())
}
