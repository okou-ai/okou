//! Normalize content packages into Storage inputs and apply managed instruction files.

use super::super::{
    DEFAULT_EXEC_TIMEOUT, JobTelemetry, RunnerError, RunnerResult, guest_runtime_dir,
};
use super::{format_helper_exec_failure, guest_storage_apply_env, helper_exec_succeeded};
use guest_contracts::agent_instructions::{
    InstructionApplication, MAX_METADATA_BYTES, STORAGE_DIR,
};
use guest_contracts::guest_binary::STORAGE_APPLY_PATH;
use runner_types::{
    content_bundle::{
        BundleReference, INSTRUCTION_BUNDLE_STORAGE_NAME, WORKFLOW_BUNDLE_STORAGE_NAME,
    },
    storage_manifest::{StorageEntry, StorageManifest},
    types::ExecutionContext,
};
use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox};
use std::{collections::HashSet, time::Instant};

const _: () = assert!(MAX_METADATA_BYTES <= guest_control_proto::MAX_EXEC_STDIN_BYTES);

pub(in crate::executor) fn prepare_content_bundles(
    context: &mut ExecutionContext,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<()> {
    let started = Instant::now();
    let result = normalize(context);
    let error = result.as_ref().err().map(ToString::to_string);
    telemetry.record(
        "runner_content_bundle_prepare",
        started.elapsed(),
        result.is_ok(),
        error.as_deref(),
    );
    result
}

fn normalize(context: &mut ExecutionContext) -> RunnerResult<()> {
    let mut paths: HashSet<String> = context
        .storage_manifest
        .iter()
        .flat_map(|m| {
            m.storages
                .iter()
                .map(|s| s.mount_path.clone())
                .chain(m.artifacts.iter().map(|a| a.mount_path.clone()))
        })
        .collect();
    let mut entries = Vec::with_capacity(context.content_bundles.skills.len() + 1);
    for skill in &context.content_bundles.skills {
        let reference = skill.reference();
        reference.validate().map_err(RunnerError::Api)?;
        runner_types::storage_manifest::validate_workflow_mount(&skill.mount_path)
            .map_err(RunnerError::Api)?;
        if !paths.insert(skill.mount_path.clone()) {
            return Err(RunnerError::Api("Conflicting content bundle mount".into()));
        }
        entries.push(storage_entry(
            WORKFLOW_BUNDLE_STORAGE_NAME,
            &reference,
            skill.mount_path.clone(),
        ));
    }
    if let Some(reference) = &context.content_bundles.instructions {
        reference.validate().map_err(RunnerError::Api)?;
        // Stage on every Run, including matching sandbox/Home reuse. Only the
        // shared cache key is stable; managed instruction files are reapplied.
        let mount = format!("{}/{STORAGE_DIR}", guest_runtime_dir(context.run_id)?);
        if !paths.insert(mount.clone()) {
            return Err(RunnerError::Api("Conflicting content bundle mount".into()));
        }
        entries.push(storage_entry(
            INSTRUCTION_BUNDLE_STORAGE_NAME,
            reference,
            mount,
        ));
    }
    context
        .storage_manifest
        .get_or_insert_with(|| StorageManifest {
            storages: Vec::new(),
            artifacts: Vec::new(),
        })
        .storages
        .extend(entries);
    Ok(())
}

fn storage_entry(name: &str, reference: &BundleReference, mount_path: String) -> StorageEntry {
    StorageEntry {
        name: name.into(),
        mount_path,
        vas_storage_name: name.into(),
        vas_version_id: reference.sha256.clone(),
        archive_url: reference.download_url.clone(),
        archive_size: Some(reference.archive_bytes),
    }
}

pub(in crate::executor) async fn apply_agent_instructions(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<()> {
    if context.content_bundles.instructions.is_none() {
        return Ok(());
    }
    let started = Instant::now();
    let result = apply(sandbox, context).await;
    let error = result.as_ref().err().map(ToString::to_string);
    telemetry.record(
        "runner_agent_instructions_apply",
        started.elapsed(),
        result.is_ok(),
        error.as_deref(),
    );
    result
}

async fn apply(sandbox: &dyn Sandbox, context: &ExecutionContext) -> RunnerResult<()> {
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
    let command = format!("{STORAGE_APPLY_PATH} --instructions-stdin");
    let result = sandbox
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
