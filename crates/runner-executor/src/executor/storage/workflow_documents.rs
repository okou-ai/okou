//! Required Workflow publication/application under the bootstrap cancellation owner.

use std::time::{Duration, Instant};

use guest_contracts::file_write::{WRITE_FILES_BATCH_CONTENT_LIMIT, WRITE_FILES_BATCH_FILE_LIMIT};
use guest_contracts::guest_binary::STORAGE_APPLY_PATH;
use guest_contracts::workflow_documents::{MAX_METADATA_BYTES, WorkflowDocumentSource};
use runner_types::storage_manifest::WorkflowSkillDocument;
use runner_types::types::ExecutionContext;
use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox, WriteFileEntry};

use super::{
    DEFAULT_EXEC_TIMEOUT, JobTelemetry, RunnerError, RunnerResult, guest_runtime_dir,
    guest_storage_apply_env, helper_exec_succeeded,
};

#[derive(Default)]
struct Timings {
    preparation: Option<(Duration, bool)>,
    publication: Option<(Duration, bool)>,
    application: Option<(Duration, bool)>,
}

fn accumulate(phase: &mut Option<(Duration, bool)>, duration: Duration, success: bool) {
    let (total, all_succeeded) = phase.get_or_insert((Duration::ZERO, true));
    *total += duration;
    *all_succeeded &= success;
}

pub(in crate::executor) async fn apply_workflow_skill_documents(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<()> {
    let documents = context
        .storage_manifest
        .as_ref()
        .map_or(&[][..], |manifest| manifest.workflow_skills.as_slice());
    let bytes = documents.iter().fold(0usize, |total, document| {
        total.saturating_add(document.skill_md.len())
    });
    let count_bucket = match documents.len() {
        0 => "runner_workflow_document_count_0",
        1 => "runner_workflow_document_count_1",
        2..=8 => "runner_workflow_document_count_2_8",
        9..=32 => "runner_workflow_document_count_9_32",
        33..=64 => "runner_workflow_document_count_33_64",
        _ => "runner_workflow_document_count_65_plus",
    };
    let bytes_bucket = match bytes {
        0 => "runner_workflow_document_bytes_0",
        1..=65536 => "runner_workflow_document_bytes_le_64_kib",
        65537..=1048576 => "runner_workflow_document_bytes_le_1_mib",
        1048577..=15728640 => "runner_workflow_document_bytes_le_15_mib",
        _ => "runner_workflow_document_bytes_gt_15_mib",
    };
    telemetry.record(count_bucket, Duration::ZERO, true, None);
    telemetry.record(bytes_bucket, Duration::ZERO, true, None);
    if documents.is_empty() {
        return Ok(());
    }
    let mut timings = Timings::default();
    let result = apply_documents(sandbox, context, documents, &mut timings).await;
    for (name, timing) in [
        ("runner_workflow_document_prepare", timings.preparation),
        ("runner_workflow_document_publish", timings.publication),
        ("runner_workflow_document_apply", timings.application),
    ] {
        if let Some((duration, success)) = timing {
            telemetry.record(name, duration, success, None);
        }
    }
    result
}

async fn apply_documents(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    documents: &[WorkflowSkillDocument],
    timings: &mut Timings,
) -> RunnerResult<()> {
    let runtime_dir = guest_runtime_dir(context.run_id)?;
    let mut remaining = documents;
    while !remaining.is_empty() {
        let started = Instant::now();
        let group = prepare_group(remaining, &runtime_dir);
        accumulate(&mut timings.preparation, started.elapsed(), group.is_ok());
        let (sources, metadata) = group?;
        let entries = sources
            .iter()
            .zip(remaining)
            .map(|(source, document)| WriteFileEntry {
                path: &source.source,
                content: document.skill_md.as_bytes(),
            })
            .collect::<Vec<_>>();
        // Admit before any mutation. Publication may leave a prefix on failure;
        // never retry it using a different group or apply an unpublished source.
        let started = Instant::now();
        let published = sandbox.write_private_files(&entries).await;
        accumulate(
            &mut timings.publication,
            started.elapsed(),
            published.is_ok(),
        );
        published?;
        let command = if let [source] = sources.as_slice() {
            format!(
                "{STORAGE_APPLY_PATH} --skill {} {}",
                source.mount_path, source.source
            )
        } else {
            format!("{STORAGE_APPLY_PATH} --skills-stdin")
        };
        let run_id = context.run_id.to_string();
        let env = guest_storage_apply_env(&run_id, &runtime_dir);
        let started = Instant::now();
        let applied = sandbox
            .exec_with_diagnostic_label(
                &ExecRequest {
                    cmd: &command,
                    timeout: DEFAULT_EXEC_TIMEOUT,
                    env: &env,
                    sudo: false,
                    expected_exit_codes: &[],
                    stdin_bytes: (sources.len() > 1).then_some(metadata.as_slice()),
                    output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
                },
                "workflow-skill",
            )
            .await;
        accumulate(
            &mut timings.application,
            started.elapsed(),
            applied.as_ref().is_ok_and(helper_exec_succeeded),
        );
        if !helper_exec_succeeded(&applied?) {
            return Err(RunnerError::Internal(
                "required Workflow skill document write failed".into(),
            ));
        }
        remaining = remaining
            .get(sources.len()..)
            .ok_or_else(|| RunnerError::Internal("invalid Workflow document group".into()))?;
    }
    Ok(())
}

fn prepare_group(
    documents: &[WorkflowSkillDocument],
    runtime_dir: &str,
) -> RunnerResult<(Vec<WorkflowDocumentSource>, Vec<u8>)> {
    let mut sources = Vec::new();
    let mut content_bytes = 0usize;
    let mut metadata = Vec::new();
    for document in documents.iter().take(WRITE_FILES_BATCH_FILE_LIMIT) {
        let source = format!("{runtime_dir}/workflow-{}", document.workflow_id);
        // Reusing an identity at another mount is representable by the captured
        // manifest. Keep those publications ordered rather than overwrite a
        // still-unconsumed source inside the same batch.
        if sources
            .iter()
            .any(|entry: &WorkflowDocumentSource| entry.source == source)
        {
            break;
        }
        let candidate_bytes = content_bytes.saturating_add(document.skill_md.len());
        sources.push(WorkflowDocumentSource {
            mount_path: document.mount_path.clone(),
            source,
        });
        let candidate_metadata = serde_json::to_vec(&sources)
            .map_err(|error| RunnerError::Internal(error.to_string()))?;
        let entries = sources
            .iter()
            .zip(documents)
            .map(
                |(source, document)| guest_control_proto::WriteFileBatchEntry {
                    path: &source.source,
                    content: document.skill_md.as_bytes(),
                },
            )
            .collect::<Vec<_>>();
        let fits = candidate_bytes <= WRITE_FILES_BATCH_CONTENT_LIMIT
            && candidate_metadata.len() <= MAX_METADATA_BYTES
            && guest_control_proto::validate_write_files(&entries).is_ok();
        if !fits {
            if sources.len() > 1 {
                sources.pop();
            }
            // An individual non-fitting document retains the existing private
            // transport's chunking and the original single application helper.
            break;
        }
        content_bytes = candidate_bytes;
        metadata = candidate_metadata;
    }
    Ok((sources, metadata))
}
