//! Workflow Storage inputs and private Agent instruction package installation.
use super::super::{
    DEFAULT_EXEC_TIMEOUT, ExecutorConfig, JobTelemetry, RunnerError, RunnerResult,
    guest_runtime_dir,
};
use super::{format_helper_exec_failure, guest_storage_apply_env, helper_exec_succeeded};
use guest_contracts::content_bundle::{BundleApplication, BundleArchiveSource};
use guest_contracts::guest_binary::STORAGE_APPLY_PATH;
use runner_types::{
    content_bundle::{PreparedBundle, WORKFLOW_BUNDLE_STORAGE_NAME},
    storage_manifest::{StorageEntry, StorageManifest},
    types::ExecutionContext,
};
use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox, WriteFileEntry};
use std::{collections::HashSet, time::Instant};
use tokio_util::sync::CancellationToken;

const _: () = assert!(
    guest_contracts::content_bundle::MAX_METADATA_BYTES
        <= guest_control_proto::MAX_EXEC_STDIN_BYTES
);

pub(in crate::executor) async fn prepare_content_bundles(
    context: &mut ExecutionContext,
    config: &ExecutorConfig,
    cancel: &CancellationToken,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<()> {
    let started = Instant::now();
    let budget = runner_storage::ObjectDownloadRetryBudget::default();
    let result = tokio::select! {
        biased;
        () = cancel.cancelled() => Err(RunnerError::Cancelled),
        result = budget.run_attempt(prepare(context, config, cancel)) =>
            result.map_err(|_| RunnerError::Internal("Content bundle preparation budget expired".into()))?,
    };
    let error = result.as_ref().err().map(ToString::to_string);
    telemetry.record(
        "runner_content_bundle_prepare",
        started.elapsed(),
        result.is_ok(),
        error.as_deref(),
    );
    result
}
async fn prepare(
    context: &mut ExecutionContext,
    config: &ExecutorConfig,
    cancel: &CancellationToken,
) -> RunnerResult<()> {
    let bundles = &context.content_bundles;
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
    let mut workflows = Vec::with_capacity(bundles.skills.len());
    for skill in &bundles.skills {
        skill.reference().validate().map_err(RunnerError::Api)?;
        runner_types::storage_manifest::validate_workflow_mount(&skill.mount_path)
            .map_err(RunnerError::Api)?;
        if !paths.insert(skill.mount_path.clone()) {
            return Err(RunnerError::Api("Conflicting content bundle mount".into()));
        }
        workflows.push(StorageEntry {
            name: WORKFLOW_BUNDLE_STORAGE_NAME.into(),
            mount_path: skill.mount_path.clone(),
            vas_storage_name: WORKFLOW_BUNDLE_STORAGE_NAME.into(),
            vas_version_id: skill.sha256.clone(),
            archive_url: skill.download_url.clone(),
            archive_size: Some(skill.archive_bytes),
        });
    }
    context
        .storage_manifest
        .get_or_insert_with(|| StorageManifest {
            storages: Vec::new(),
            artifacts: Vec::new(),
        })
        .storages
        .extend(workflows);

    let mut prepared = Vec::new();
    if let Some(reference) = &bundles.instructions {
        let archive = config.content_bundle_cache.get(reference, cancel).await?;
        prepared.push(PreparedBundle {
            sha256: reference.sha256.clone(),
            archive,
        });
    }
    context.prepared_bundles = prepared;
    Ok(())
}
pub(in crate::executor) async fn apply_content_bundles(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<()> {
    let started = Instant::now();
    let result = apply(sandbox, context).await;
    let error = result.as_ref().err().map(ToString::to_string);
    telemetry.record(
        "runner_content_bundle_apply",
        started.elapsed(),
        result.is_ok(),
        error.as_deref(),
    );
    result
}
async fn apply(sandbox: &dyn Sandbox, context: &ExecutionContext) -> RunnerResult<()> {
    let runtime = guest_runtime_dir(context.run_id)?;
    for (index, bundle) in context.prepared_bundles.iter().enumerate() {
        let source = format!("{runtime}/bundle-{index}.tar.gz");
        // The private file transport chunks large archives independently of exec stdin.
        sandbox
            .write_private_files(&[WriteFileEntry {
                path: &source,
                content: &bundle.archive,
            }])
            .await?;
        let archive = BundleArchiveSource {
            source,
            sha256: bundle.sha256.clone(),
            archive_bytes: bundle.archive.len() as u64,
        };
        let application = BundleApplication::Instructions {
            framework: super::super::cli_framework::normalized_cli_agent_type(
                &context.cli_agent_type,
            )
            .into(),
            archive,
        };
        let metadata = serde_json::to_vec(&application)
            .map_err(|_| RunnerError::Internal("Bundle metadata encoding failed".into()))?;
        if metadata.len() > guest_contracts::content_bundle::MAX_METADATA_BYTES {
            return Err(RunnerError::Internal(
                "Bundle metadata exceeds bound".into(),
            ));
        }
        let command = format!("{STORAGE_APPLY_PATH} --bundle-stdin");
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
                "content-bundle",
            )
            .await?;
        if !helper_exec_succeeded(&result) {
            return Err(RunnerError::Internal(format_helper_exec_failure(
                "content bundle application",
                &result,
            )));
        }
    }
    Ok(())
}
