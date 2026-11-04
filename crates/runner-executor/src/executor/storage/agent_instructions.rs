//! Reuse or apply the managed file supplied by a normalized Storage input.

use super::super::{
    DEFAULT_EXEC_TIMEOUT, JobTelemetry, RunnerError, RunnerResult, guest_runtime_dir,
};
use super::{format_helper_exec_failure, helper_exec_succeeded};
use guest_contracts::agent_instructions::{
    InstructionApplication, InstructionCheck, InstructionOperation, MAX_CHECK_METADATA_BYTES,
    MAX_METADATA_BYTES, instruction_paths,
};
use guest_contracts::home_mount::HOME_DIR;
use runner_storage::storage_plan::{StoragePlan, build_storage_plan};
use runner_types::{storage_fingerprints::StorageFingerprints, types::ExecutionContext};
use sandbox::{AgentInstructionsRequest, ExecResult, Sandbox};
use std::{path::Path, time::Instant};

const _: () = assert!(MAX_METADATA_BYTES <= guest_control_proto::MAX_EXEC_STDIN_BYTES);
const _: () = assert!(MAX_CHECK_METADATA_BYTES <= guest_control_proto::MAX_EXEC_STDIN_BYTES);

pub(in crate::executor) enum InstructionReuse {
    Apply,
    Reused,
    /// Missing or replaced final files invalidate only this input's prior knowledge.
    Repair(StorageFingerprints),
}

pub(in crate::executor) async fn check_instruction_reuse(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    previous: Option<&StorageFingerprints>,
    prepared_plan: Option<&StoragePlan>,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<InstructionReuse> {
    let Some(instruction) = &context.instruction_file else {
        return Ok(InstructionReuse::Apply);
    };
    let entry = context
        .storage_manifest
        .as_ref()
        .and_then(|manifest| {
            manifest
                .storages
                .iter()
                .find(|entry| entry.mount_path == instruction.storage_mount)
        })
        .ok_or_else(|| RunnerError::Internal("Missing instruction Storage input".into()))?;
    let Some(previous) = previous else {
        return Ok(InstructionReuse::Apply);
    };
    if !previous
        .storages
        .get(&instruction.storage_mount)
        .is_some_and(|fingerprint| {
            fingerprint.matches(&entry.vas_storage_name, &entry.vas_version_id)
        })
    {
        return Ok(InstructionReuse::Apply);
    }
    let framework = super::super::cli_framework::normalized_cli_agent_type(&context.cli_agent_type);
    let target = instruction_paths(Path::new(HOME_DIR), framework)
        .ok_or_else(|| RunnerError::Internal("Unsupported instruction framework".into()))?
        .target;
    let owned_plan;
    let plan = if let Some(plan) = prepared_plan {
        plan
    } else {
        let manifest = context
            .storage_manifest
            .as_ref()
            .ok_or_else(|| RunnerError::Internal("Missing instruction Storage manifest".into()))?;
        owned_plan = build_storage_plan(manifest, Some(previous))?;
        &owned_plan
    };
    if plan.replaces_existing_file(&target, Path::new(HOME_DIR)) {
        let mut repaired = previous.clone();
        repaired.storages.remove(&instruction.storage_mount);
        return Ok(InstructionReuse::Repair(repaired));
    }
    let started = Instant::now();
    let checked = check_preserved_targets(
        sandbox,
        context,
        framework,
        plan.preserved_download_mounts(),
    )
    .await;
    telemetry.record(
        "runner_agent_instructions_check",
        started.elapsed(),
        checked.is_ok(),
        checked
            .as_ref()
            .err()
            .map(|_| "instruction_file_check_failed"),
    );
    if checked? {
        Ok(InstructionReuse::Reused)
    } else {
        let mut repaired = previous.clone();
        repaired.storages.remove(&instruction.storage_mount);
        Ok(InstructionReuse::Repair(repaired))
    }
}

async fn check_preserved_targets(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    framework: &str,
    mounts: Vec<String>,
) -> RunnerResult<bool> {
    let mut batch = InstructionCheck {
        framework: framework.into(),
        preserved_download_mounts: Vec::new(),
    };
    let empty_size = serde_json::to_vec(&batch)
        .map_err(|_| RunnerError::Internal("Instruction metadata encoding failed".into()))?
        .len();
    let mut size = empty_size;
    for mount in mounts {
        let encoded_size = serde_json::to_vec(&mount)
            .map_err(|_| RunnerError::Internal("Instruction path encoding failed".into()))?
            .len();
        if empty_size + encoded_size > MAX_CHECK_METADATA_BYTES {
            return Err(RunnerError::Internal(
                "Instruction check path exceeds bound".into(),
            ));
        }
        let comma = usize::from(!batch.preserved_download_mounts.is_empty());
        if size + encoded_size + comma > MAX_CHECK_METADATA_BYTES {
            if !check_batch(sandbox, context, &batch).await? {
                return Ok(false);
            }
            batch.preserved_download_mounts.clear();
            size = empty_size;
        }
        size += encoded_size + usize::from(!batch.preserved_download_mounts.is_empty());
        batch.preserved_download_mounts.push(mount);
    }
    check_batch(sandbox, context, &batch).await
}

async fn check_batch(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    input: &InstructionCheck,
) -> RunnerResult<bool> {
    let result = exec(
        sandbox,
        context,
        InstructionOperation::Check,
        input,
        MAX_CHECK_METADATA_BYTES,
    )
    .await?;
    if !helper_exec_succeeded(&result) {
        return Err(RunnerError::Internal(format_helper_exec_failure(
            "instruction file check",
            &result,
        )));
    }
    serde_json::from_slice::<bool>(&result.stdout)
        .map_err(|_| RunnerError::Internal("Invalid instruction file check response".into()))
}

pub(in crate::executor) async fn apply_agent_instructions(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<()> {
    let started = Instant::now();
    let result = async {
        let input = InstructionApplication {
            framework: super::super::cli_framework::normalized_cli_agent_type(
                &context.cli_agent_type,
            )
            .into(),
        };
        let result = exec(
            sandbox,
            context,
            InstructionOperation::Apply,
            &input,
            MAX_METADATA_BYTES,
        )
        .await?;
        if !helper_exec_succeeded(&result) {
            return Err(RunnerError::Internal(format_helper_exec_failure(
                "Agent instruction application",
                &result,
            )));
        }
        Ok(())
    }
    .await;
    let error = result.as_ref().err().map(ToString::to_string);
    telemetry.record(
        "runner_agent_instructions_apply",
        started.elapsed(),
        result.is_ok(),
        error.as_deref(),
    );
    result
}

async fn exec(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    operation: InstructionOperation,
    input: &impl serde::Serialize,
    metadata_limit: usize,
) -> RunnerResult<ExecResult> {
    let runtime = guest_runtime_dir(context.run_id)?;
    let metadata = serde_json::to_vec(input)
        .map_err(|_| RunnerError::Internal("Instruction metadata encoding failed".into()))?;
    if metadata.len() > metadata_limit {
        return Err(RunnerError::Internal(
            "Instruction metadata exceeds bound".into(),
        ));
    }
    Ok(sandbox
        .run_agent_instructions(&AgentInstructionsRequest {
            operation,
            timeout: DEFAULT_EXEC_TIMEOUT,
            run_id: &context.run_id.to_string(),
            runtime_dir: &runtime,
            metadata: &metadata,
        })
        .await?)
}
