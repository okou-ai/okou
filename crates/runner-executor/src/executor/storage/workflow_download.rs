//! Download current Workflow content after claim under the execution owner.

use std::time::Instant;

use api_contracts::generated::routes;
use futures_util::{StreamExt, TryStreamExt, stream};
use runner_provider::http::HttpClient;
use runner_types::ids::RunId;
use runner_types::storage_manifest::{
    WorkflowSkillArchive, WorkflowSkillDocument, WorkflowSkillReference,
};
use runner_types::types::ExecutionContext;
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use super::super::{JobTelemetry, RunnerError, RunnerResult};

const DOWNLOAD_CONCURRENCY: usize = 4;
// The existing instruction limit is 5 Mi UTF-16 units. JSON can escape each
// unit to six bytes; this also admits bounded frontmatter and archive metadata.
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowDownload {
    workflow_id: uuid::Uuid,
    skill_md: String,
    #[serde(deserialize_with = "required_nullable_archive")]
    attachments: Option<WorkflowSkillArchive>,
}

fn required_nullable_archive<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<WorkflowSkillArchive>, D::Error> {
    Option::<WorkflowSkillArchive>::deserialize(deserializer)
}

async fn download(
    http: &HttpClient,
    run_id: RunId,
    token: &str,
    reference: &WorkflowSkillReference,
) -> RunnerResult<WorkflowSkillDocument> {
    let run_id = run_id.to_string();
    let workflow_id = reference.workflow_id.to_string();
    let mut response = http
        .request_resolved_route(
            routes::runners::runs::by_run_id::workflows::by_workflow_id::route(
                routes::runners::runs::by_run_id::workflows::by_workflow_id::Params {
                    run_id: &run_id,
                    workflow_id: &workflow_id,
                },
            ),
            token,
        )
        .send("workflow download")
        .await?;
    if !response.status().is_success() {
        return Err(RunnerError::Api(format!(
            "Workflow download failed ({})",
            response.status()
        )));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return Err(RunnerError::Api(
            "Workflow download exceeds response bound".into(),
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| RunnerError::Api("Workflow download body read failed".into()))?
    {
        if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(body.len()) {
            return Err(RunnerError::Api(
                "Workflow download exceeds response bound".into(),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    // Never include a body or a serde diagnostic carrying private text in errors.
    let content: WorkflowDownload = serde_json::from_slice(&body)
        .map_err(|_| RunnerError::Api("Invalid Workflow download response".into()))?;
    if content.workflow_id != reference.workflow_id {
        return Err(RunnerError::Api(
            "Workflow download identity mismatch".into(),
        ));
    }
    let document = WorkflowSkillDocument {
        workflow_id: reference.workflow_id,
        mount_path: reference.mount_path.clone(),
        skill_md: content.skill_md,
        attachments: content.attachments,
    };
    document.validate().map_err(RunnerError::Api)?;
    Ok(document)
}

pub(in crate::executor) async fn resolve_workflow_documents(
    context: &mut ExecutionContext,
    http: &HttpClient,
    cancel: &CancellationToken,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<()> {
    let Some(manifest) = &context.storage_manifest else {
        return Ok(());
    };
    if manifest.workflow_references.is_empty() {
        return Ok(());
    }
    if !manifest.workflow_skills.is_empty() {
        return Err(RunnerError::Internal(
            "Workflow inputs are already resolved".into(),
        ));
    }
    let started = Instant::now();
    let run_id = context.run_id;
    let token = context.sandbox_token.as_str();
    let downloads = stream::iter(manifest.workflow_references.clone())
        .map(|reference| async move { download(http, run_id, token, &reference).await })
        .buffered(DOWNLOAD_CONCURRENCY)
        .try_collect::<Vec<_>>();
    let result = tokio::select! {
        biased;
        () = cancel.cancelled() => Err(RunnerError::Cancelled),
        result = downloads => result,
    };
    telemetry.record(
        "runner_workflow_download",
        started.elapsed(),
        result.is_ok(),
        None,
    );
    let documents = result?;
    let manifest = context
        .storage_manifest
        .as_mut()
        .ok_or_else(|| RunnerError::Internal("Workflow manifest disappeared".into()))?;
    manifest
        .resolve_workflow_documents(documents)
        .map_err(RunnerError::Internal)
}
