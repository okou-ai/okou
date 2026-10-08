use runner_types::storage_manifest::{ArtifactEntry, StorageEntry};

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
        baseline_candidate: false,
        instructions_target_filename: None,
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
