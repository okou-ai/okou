//! Reuse or apply the managed file supplied by a normalized Storage input.

use super::super::{
    DEFAULT_EXEC_TIMEOUT, JobTelemetry, RunnerError, RunnerResult, guest_runtime_dir,
};
use super::{format_helper_exec_failure, guest_storage_apply_env, helper_exec_succeeded};
use guest_contracts::agent_instructions::{
    InstructionApplication, MAX_METADATA_BYTES, instruction_paths,
};
use guest_contracts::guest_binary::STORAGE_APPLY_PATH;
use runner_storage::storage_plan::{StoragePlan, build_storage_plan};
use runner_types::{storage_fingerprints::StorageFingerprints, types::ExecutionContext};
use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ExecResult, Sandbox};
use std::{path::Path, time::Instant};

const _: () = assert!(MAX_METADATA_BYTES <= guest_control_proto::MAX_EXEC_STDIN_BYTES);

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
    let target = instruction_paths(Path::new("/home/user"), framework)
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
    if plan.replaces_existing_file(&target) {
        let mut repaired = previous.clone();
        repaired.storages.remove(&instruction.storage_mount);
        return Ok(InstructionReuse::Repair(repaired));
    }
    let started = Instant::now();
    let checked = async {
        let result = exec(
            sandbox,
            context,
            "--instructions-check-stdin",
            "instruction-file-check",
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

pub(in crate::executor) async fn apply_agent_instructions(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<()> {
    let started = Instant::now();
    let result = async {
        let result = exec(
            sandbox,
            context,
            "--instructions-stdin",
            "agent-instructions",
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
    flag: &str,
    label: &'static str,
) -> RunnerResult<ExecResult> {
    let runtime = guest_runtime_dir(context.run_id)?;
    let input = InstructionApplication {
        framework: super::super::cli_framework::normalized_cli_agent_type(&context.cli_agent_type)
            .into(),
    };
    let metadata = serde_json::to_vec(&input)
        .map_err(|_| RunnerError::Internal("Instruction metadata encoding failed".into()))?;
    if metadata.len() > MAX_METADATA_BYTES {
        return Err(RunnerError::Internal(
            "Instruction metadata exceeds bound".into(),
        ));
    }
    let command = format!("{STORAGE_APPLY_PATH} {flag}");
    Ok(sandbox
        .exec_with_diagnostic_label(
            &ExecRequest {
                cmd: &command,
                timeout: DEFAULT_EXEC_TIMEOUT,
                env: &guest_storage_apply_env(&context.run_id.to_string(), &runtime),
                sudo: false,
                expected_exit_codes: &[],
                stdin_bytes: Some(&metadata),
                output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
            },
            label,
        )
        .await?)
}
