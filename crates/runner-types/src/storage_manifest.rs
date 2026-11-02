use std::collections::HashSet;

use api_contracts::generated::types::runners::storage::{
    ArtifactEntryMissingRootPolicy, StorageMountEntry,
};
use serde::Deserialize;

#[derive(Clone, Debug, PartialEq)]
pub struct StorageManifest {
    pub storages: Vec<StorageEntry>,
    pub artifacts: Vec<ArtifactEntry>,
}

pub fn validate_workflow_mount(mount_path: &str) -> Result<(), String> {
    let name = [
        "/home/user/.claude/skills/",
        "/home/user/.codex/skills/",
        "/home/user/.pi/agent/skills/",
    ]
    .iter()
    .find_map(|prefix| mount_path.strip_prefix(prefix))
    .ok_or("Workflow skill path is outside a framework skill directory")?;
    if name.len() < 2
        || name.len() > 64
        || !name
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        || name.starts_with('-')
        || name.ends_with('-')
    {
        return Err("Invalid Workflow skill name".into());
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq)]
pub struct StorageEntry {
    pub name: String,
    pub mount_path: String,
    pub vas_storage_name: String,
    pub vas_version_id: String,
    pub archive_url: String,
    pub archive_size: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ArtifactEntry {
    pub mount_path: String,
    pub vas_storage_name: String,
    pub vas_storage_id: String,
    pub vas_version_id: String,
    pub archive_url: Option<String>,
    pub archive_size: Option<u64>,
    pub empty: Option<bool>,
    pub missing_root_policy: Option<ArtifactEntryMissingRootPolicy>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalStorageManifest {
    storage_mounts: Vec<StorageMountEntry>,
}

impl<'de> Deserialize<'de> for StorageManifest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let canonical = CanonicalStorageManifest::deserialize(deserializer)?;
        normalize_storage_mounts(canonical.storage_mounts).map_err(serde::de::Error::custom)
    }
}

fn normalize_storage_mounts(
    storage_mounts: Vec<StorageMountEntry>,
) -> Result<StorageManifest, String> {
    validate_unique_mount_paths(&storage_mounts)?;

    let mut storages = Vec::new();
    let mut artifacts = Vec::new();

    for mount in storage_mounts {
        let writeback = mount.writeback.unwrap_or(false);
        if writeback {
            if mount.empty != Some(true) && mount.archive_url.is_none() {
                return Err(
                    "storage manifest writeback mount requires archiveUrl unless empty is true"
                        .to_string(),
                );
            }
            artifacts.push(ArtifactEntry {
                mount_path: mount.mount_path,
                vas_storage_name: mount.name,
                vas_storage_id: mount.storage_id,
                vas_version_id: mount.version_id,
                archive_url: mount.archive_url,
                archive_size: mount.archive_size,
                empty: mount.empty,
                missing_root_policy: mount.missing_root_policy,
            });
            continue;
        }

        if mount.empty == Some(true) {
            return Err("storage manifest read-only mount cannot be empty".to_string());
        }
        if mount.missing_root_policy.is_some() {
            return Err(
                "storage manifest read-only mount cannot contain missingRootPolicy".to_string(),
            );
        }
        let archive_url = mount
            .archive_url
            .ok_or_else(|| "storage manifest read-only mount requires archiveUrl".to_string())?;
        storages.push(StorageEntry {
            name: mount.name.clone(),
            mount_path: mount.mount_path,
            vas_storage_name: mount.name,
            vas_version_id: mount.version_id,
            archive_url,
            archive_size: mount.archive_size,
        });
    }

    Ok(StorageManifest {
        storages,
        artifacts,
    })
}

fn validate_unique_mount_paths(storage_mounts: &[StorageMountEntry]) -> Result<(), String> {
    let mut mount_paths = HashSet::with_capacity(storage_mounts.len());
    for mount in storage_mounts {
        if !mount_paths.insert(mount.mount_path.as_str()) {
            return Err(format!(
                "storage manifest contains duplicate mountPath \"{}\"",
                mount.mount_path
            ));
        }
    }
    Ok(())
}
