//! Hash-addressed package bootstrap with verified bytes and private installation.
use super::super::{
    DEFAULT_EXEC_TIMEOUT, ExecutorConfig, JobTelemetry, RunnerError, RunnerResult,
    guest_runtime_dir,
};
use super::{guest_storage_apply_env, helper_exec_succeeded};
use guest_contracts::content_bundle::{BundleApplication, BundleFileSource};
use guest_contracts::guest_binary::STORAGE_APPLY_PATH;
use runner_types::{
    content_bundle::{PreparedBundle, PreparedBundleFile},
    types::ExecutionContext,
};
use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox, WriteFileEntry};
use std::{collections::HashSet, io::Read, time::Instant};
use tokio_util::sync::CancellationToken;

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
    telemetry.record(
        "runner_content_bundle_prepare",
        started.elapsed(),
        result.is_ok(),
        None,
    );
    result
}
async fn prepare(
    context: &mut ExecutionContext,
    config: &ExecutorConfig,
    cancel: &CancellationToken,
) -> RunnerResult<()> {
    let bundles = context
        .content_bundles
        .as_ref()
        .ok_or_else(|| RunnerError::Internal("Missing bundle manifest".into()))?;
    if context.agent_instructions.is_some()
        || context
            .storage_manifest
            .as_ref()
            .is_some_and(|m| !m.workflow_references.is_empty() || !m.workflow_skills.is_empty())
    {
        return Err(RunnerError::Api("Mixed content delivery protocols".into()));
    }
    let cache = &config.content_bundle_cache;
    let mut prepared = Vec::new();
    if let Some(reference) = &bundles.instructions {
        let bytes = cache.get(reference, cancel).await?;
        let files = decode(&bytes)?;
        if files.len() != 1
            || files
                .first()
                .is_none_or(|file| file.path != "instructions.md")
        {
            return Err(RunnerError::Api("Invalid instructions package".into()));
        }
        prepared.push(PreparedBundle {
            mount_path: None,
            files,
        });
    }
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
    for skill in &bundles.skills {
        runner_types::storage_manifest::validate_workflow_mount(&skill.mount_path)
            .map_err(RunnerError::Api)?;
        if !paths.insert(skill.mount_path.clone()) {
            return Err(RunnerError::Api("Conflicting content bundle mount".into()));
        }
        let bytes = cache.get(&skill.reference(), cancel).await?;
        let files = decode(&bytes)?;
        if !files.iter().any(|f| f.path == "SKILL.md") {
            return Err(RunnerError::Api("Workflow package missing SKILL.md".into()));
        }
        prepared.push(PreparedBundle {
            mount_path: Some(skill.mount_path.clone()),
            files,
        });
    }
    if context.storage_manifest.is_none() {
        context.storage_manifest = Some(runner_types::storage_manifest::StorageManifest {
            storages: Vec::new(),
            artifacts: Vec::new(),
            workflow_references: Vec::new(),
            workflow_skills: Vec::new(),
        });
    }
    context.prepared_bundles = prepared;
    Ok(())
}
fn decode(bytes: &[u8]) -> RunnerResult<Vec<PreparedBundleFile>> {
    let invalid = || RunnerError::Api("Invalid content bundle archive".into());
    // Bound decompression before tar parses extension metadata or allocates member buffers.
    let mut unpacked = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .take(34 * 1024 * 1024 + 1)
        .read_to_end(&mut unpacked)
        .map_err(|_| invalid())?;
    if unpacked.len() > 34 * 1024 * 1024 {
        return Err(invalid());
    }
    let mut archive = tar::Archive::new(unpacked.as_slice());
    let mut files = Vec::new();
    let mut paths = HashSet::new();
    let mut total = 0u64;
    for entry in archive.entries().map_err(|_| invalid())? {
        let mut entry = entry.map_err(|_| invalid())?;
        if !entry.header().entry_type().is_file() || files.len() >= 501 {
            return Err(invalid());
        }
        let path = entry
            .path()
            .map_err(|_| invalid())?
            .to_str()
            .ok_or_else(invalid)?
            .to_owned();
        if path.is_empty()
            || path.encode_utf16().count() > 256
            || path.contains(['\\', '\0'])
            || path
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
            || !paths.insert(path.clone())
        {
            return Err(invalid());
        }
        total = total.saturating_add(entry.size());
        if total > 32 * 1024 * 1024 {
            return Err(invalid());
        }
        let mut content = Vec::new();
        entry.read_to_end(&mut content).map_err(|_| invalid())?;
        files.push(PreparedBundleFile { path, content });
    }
    for path in &paths {
        let mut parts = path.split('/').collect::<Vec<_>>();
        parts.pop();
        while !parts.is_empty() {
            if paths.contains(&parts.join("/")) {
                return Err(invalid());
            }
            parts.pop();
        }
    }
    Ok(files)
}

pub(in crate::executor) async fn apply_content_bundles(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<()> {
    if context.content_bundles.is_none() {
        return Ok(());
    }
    let started = Instant::now();
    let result = apply(sandbox, context).await;
    telemetry.record(
        "runner_content_bundle_apply",
        started.elapsed(),
        result.is_ok(),
        None,
    );
    result
}
async fn apply(sandbox: &dyn Sandbox, context: &ExecutionContext) -> RunnerResult<()> {
    let runtime = guest_runtime_dir(context.run_id)?;
    for (index, bundle) in context.prepared_bundles.iter().enumerate() {
        let sources = bundle
            .files
            .iter()
            .enumerate()
            .map(|(file, data)| (format!("{runtime}/bundle-{index}-{file}"), data))
            .collect::<Vec<_>>();
        // Private transport owns size/count admission and large-single-file chunking.
        let entries = sources
            .iter()
            .map(|(source, data)| WriteFileEntry {
                path: source,
                content: &data.content,
            })
            .collect::<Vec<_>>();
        for batch in entries.chunks(guest_contracts::file_write::WRITE_FILES_BATCH_FILE_LIMIT) {
            sandbox.write_private_files(batch).await?;
        }
        let application = match &bundle.mount_path {
            Some(mount) => BundleApplication::Skill {
                mount: mount.clone(),
                files: sources
                    .iter()
                    .map(|(source, data)| BundleFileSource {
                        path: data.path.clone(),
                        source: source.clone(),
                    })
                    .collect(),
            },
            None => BundleApplication::Instructions {
                framework: super::super::cli_framework::normalized_cli_agent_type(
                    &context.cli_agent_type,
                )
                .into(),
                source: sources
                    .first()
                    .ok_or_else(|| {
                        RunnerError::Internal("Missing instruction bundle source".into())
                    })?
                    .0
                    .clone(),
            },
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
            return Err(RunnerError::Internal(
                "Required content bundle application failed".into(),
            ));
        }
    }
    Ok(())
}
