//! Reuse or apply the managed file supplied by a normalized Storage input.

use super::super::{
    DEFAULT_EXEC_TIMEOUT, JobTelemetry, RunnerError, RunnerResult, guest_runtime_dir,
};
use super::{format_helper_exec_failure, helper_exec_succeeded, storage_helper_failure};
use guest_contracts::agent_instructions::{
    InstructionApplication, InstructionCheck, InstructionCheckResult, InstructionOperation,
    MAX_METADATA_BYTES, instruction_paths,
};
use guest_contracts::env::CliAgentTypeSelection;
use guest_contracts::home_mount::HOME_DIR;
use guest_contracts::storage_manifest::member_memory_mount;
use runner_storage::storage_plan::{StoragePlan, build_storage_plan};
use runner_types::{storage_fingerprints::StorageFingerprints, types::ExecutionContext};
use sandbox::{AgentInstructionsRequest, ExecResult, Sandbox};
use std::{path::Path, time::Instant};

const _: () = assert!(MAX_METADATA_BYTES <= guest_control_proto::MAX_EXEC_STDIN_BYTES);

pub(in crate::executor) enum InstructionReuse {
    Apply,
    Reused {
        memory_root_present: bool,
    },
    /// Missing or replaced final files invalidate only this input's prior knowledge.
    Repair(StorageFingerprints),
}

pub(in crate::executor) struct CompletedInstructionCheck {
    pub(in crate::executor) input: InstructionCheck,
    pub(in crate::executor) result: RunnerResult<InstructionCheckResult>,
}

pub(in crate::executor) enum InstructionReusePlan<'a> {
    Decided(InstructionReuse),
    Check {
        input: InstructionCheck,
        previous: &'a StorageFingerprints,
        mount: &'a str,
    },
}

pub(in crate::executor) fn plan_instruction_reuse<'a>(
    context: &'a ExecutionContext,
    previous: Option<&'a StorageFingerprints>,
    prepared_plan: Option<&StoragePlan>,
) -> RunnerResult<InstructionReusePlan<'a>> {
    let Some(instruction) = &context.instruction_file else {
        return Ok(InstructionReusePlan::Decided(InstructionReuse::Apply));
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
        return Ok(InstructionReusePlan::Decided(InstructionReuse::Apply));
    };
    if !previous
        .storages
        .get(&instruction.storage_mount)
        .is_some_and(|fingerprint| {
            fingerprint.matches(&entry.vas_storage_name, &entry.vas_version_id)
        })
    {
        return Ok(InstructionReusePlan::Decided(InstructionReuse::Apply));
    }
    let selection = CliAgentTypeSelection::parse(&context.cli_agent_type);
    let framework = selection.normalized_cli_agent_type();
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
        return Ok(InstructionReusePlan::Decided(repair(
            previous,
            &instruction.storage_mount,
        )));
    }
    let memory_mount = member_memory_mount(selection.framework());
    Ok(InstructionReusePlan::Check {
        input: InstructionCheck {
            framework: framework.into(),
            check_memory_root: plan.needs_only_memory_root_check(memory_mount),
        },
        previous,
        mount: &instruction.storage_mount,
    })
}

pub(in crate::executor) async fn check_instruction_reuse(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    previous: Option<&StorageFingerprints>,
    prepared_plan: Option<&StoragePlan>,
    completed_check: Option<CompletedInstructionCheck>,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<InstructionReuse> {
    let (input, previous, mount) = match plan_instruction_reuse(context, previous, prepared_plan)? {
        InstructionReusePlan::Decided(reuse) => return Ok(reuse),
        InstructionReusePlan::Check {
            input,
            previous,
            mount,
        } => (input, previous, mount),
    };
    let checked = if let Some(completed) = completed_check.filter(|checked| checked.input == input)
    {
        completed.result?
    } else {
        let started = Instant::now();
        let checked = check_instruction_target(sandbox, context, &input).await;
        telemetry.record(
            "runner_agent_instructions_check",
            started.elapsed(),
            checked.is_ok(),
            checked
                .as_ref()
                .err()
                .map(|_| "instruction_file_check_failed"),
        );
        checked?
    };
    if checked.instructions_current {
        Ok(InstructionReuse::Reused {
            memory_root_present: input.check_memory_root && checked.memory_root_present,
        })
    } else {
        Ok(repair(previous, mount))
    }
}

fn repair(previous: &StorageFingerprints, mount: &str) -> InstructionReuse {
    let mut repaired = previous.clone();
    repaired.storages.remove(mount);
    InstructionReuse::Repair(repaired)
}

async fn check_instruction_target(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    input: &InstructionCheck,
) -> RunnerResult<InstructionCheckResult> {
    let result = exec(sandbox, context, InstructionOperation::Check, input).await?;
    if !helper_exec_succeeded(&result) {
        return Err(storage_helper_failure(
            format_helper_exec_failure("instruction file check", &result),
            &result,
        ));
    }
    serde_json::from_slice(&result.stdout)
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
        let result = exec(sandbox, context, InstructionOperation::Apply, &input).await?;
        if !helper_exec_succeeded(&result) {
            return Err(storage_helper_failure(
                format_helper_exec_failure("Agent instruction application", &result),
                &result,
            ));
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
) -> RunnerResult<ExecResult> {
    let runtime = guest_runtime_dir(context.run_id)?;
    let metadata = serde_json::to_vec(input)
        .map_err(|_| RunnerError::Internal("Instruction metadata encoding failed".into()))?;
    if metadata.len() > MAX_METADATA_BYTES {
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
