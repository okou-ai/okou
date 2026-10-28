use runner_types::storage_manifest::{
    ArtifactEntry, StorageEntry, StorageManifest, WorkflowSkillDocument,
};

/// Existing application tests start at the post-download value boundary.
pub(in crate::executor::tests) fn downloaded_workflow_manifest(
    mut value: serde_json::Value,
) -> serde_json::Result<StorageManifest> {
    let documents: Vec<WorkflowSkillDocument> =
        serde_json::from_value(value["workflowSkills"].take())?;
    value["workflowSkills"] = serde_json::json!(
        documents
            .iter()
            .map(|document| serde_json::json!({
                "workflowId": document.workflow_id, "mountPath": document.mount_path,
            }))
            .collect::<Vec<_>>()
    );
    let mut manifest: StorageManifest = serde_json::from_value(value)?;
    manifest
        .resolve_workflow_documents(documents)
        .map_err(<serde_json::Error as serde::de::Error>::custom)?;
    Ok(manifest)
}

pub(in crate::executor::tests) fn api_storage(
    name: &str,
    mount_path: &str,
    version: &str,
    archive_url: &str,
) -> StorageEntry {
    StorageEntry {
        name: name.into(),
        mount_path: mount_path.into(),
        archive_url: archive_url.into(),
        vas_storage_name: name.into(),
        vas_version_id: version.into(),
        archive_size: None,
    }
}

pub(in crate::executor::tests) fn api_artifact(
    name: &str,
    mount_path: &str,
    storage_id: &str,
    version: &str,
    archive_url: &str,
) -> ArtifactEntry {
    ArtifactEntry {
        mount_path: mount_path.into(),
        archive_url: Some(archive_url.into()),
        vas_storage_name: name.into(),
        vas_storage_id: storage_id.into(),
        vas_version_id: version.into(),
        empty: None,
        missing_root_policy: None,
        archive_size: None,
    }
}
