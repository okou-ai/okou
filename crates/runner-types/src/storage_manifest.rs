use std::collections::HashSet;

use api_contracts::generated::types::runners::storage::{
    ArtifactEntryMissingRootPolicy, StorageMountEntry,
};
use serde::Deserialize;

#[derive(Clone, Debug, PartialEq)]
pub struct StorageManifest {
    pub storages: Vec<StorageEntry>,
    pub artifacts: Vec<ArtifactEntry>,
    /// Claim-selected documents; attachments use the ordinary read-only cache.
    pub workflow_skills: Vec<WorkflowSkillDocument>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSkillDocument {
    pub workflow_id: uuid::Uuid,
    pub mount_path: String,
    pub skill_md: String,
    #[serde(deserialize_with = "required_nullable_archive")]
    pub attachments: Option<WorkflowSkillArchive>,
}

fn required_nullable_archive<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<WorkflowSkillArchive>, D::Error> {
    Option::<WorkflowSkillArchive>::deserialize(deserializer)
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSkillArchive {
    pub archive_url: String,
    pub archive_size: u64,
    pub archive_sha256: String,
}

impl WorkflowSkillDocument {
    pub fn identity(&self) -> String {
        format!("workflow:{}", self.workflow_id)
    }
    pub fn version(&self) -> &str {
        self.attachments
            .as_ref()
            .map_or("empty", |a| a.archive_sha256.as_str())
    }

    fn validate(&self) -> Result<(), String> {
        let name = [
            "/home/user/.claude/skills/",
            "/home/user/.codex/skills/",
            "/home/user/.pi/agent/skills/",
        ]
        .iter()
        .find_map(|prefix| self.mount_path.strip_prefix(prefix))
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
        if let Some(archive) = &self.attachments {
            let url = url::Url::parse(&archive.archive_url)
                .map_err(|_| "Invalid Workflow attachment URL")?;
            if url.scheme() != "https"
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || archive.archive_size == 0
                || archive.archive_sha256.len() != 64
                || !archive
                    .archive_sha256
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            {
                return Err("Invalid Workflow attachment archive".into());
            }
        }
        Ok(())
    }
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
    #[serde(default)]
    workflow_skills: Vec<WorkflowSkillDocument>,
}

impl<'de> Deserialize<'de> for StorageManifest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let canonical = CanonicalStorageManifest::deserialize(deserializer)?;
        let mut manifest =
            normalize_storage_mounts(canonical.storage_mounts).map_err(serde::de::Error::custom)?;
        let mut paths: HashSet<String> = manifest
            .storages
            .iter()
            .map(|s| s.mount_path.clone())
            .chain(manifest.artifacts.iter().map(|a| a.mount_path.clone()))
            .collect();
        for skill in &canonical.workflow_skills {
            skill.validate().map_err(serde::de::Error::custom)?;
            if !paths.insert(skill.mount_path.clone()) {
                return Err(serde::de::Error::custom(
                    "Duplicate Workflow skill mount path",
                ));
            }
            if let Some(archive) = &skill.attachments {
                manifest.storages.push(StorageEntry {
                    name: skill.identity(),
                    mount_path: skill.mount_path.clone(),
                    vas_storage_name: skill.identity(),
                    vas_version_id: skill.version().to_owned(),
                    archive_url: archive.archive_url.clone(),
                    archive_size: Some(archive.archive_size),
                });
            }
        }
        manifest.workflow_skills = canonical.workflow_skills;
        Ok(manifest)
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
        workflow_skills: Vec::new(),
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

#[cfg(test)]
mod workflow_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claim_documents_select_readonly_archives_and_empty_directory_identity() {
        let workflow_id = uuid::Uuid::new_v4();
        let manifest: StorageManifest = serde_json::from_value(json!({
            "storageMounts": [], "workflowSkills": [
                {"workflowId":workflow_id,"mountPath":"/home/user/.codex/skills/with-files","skillMd":"body","attachments":{"archiveUrl":"https://objects.example/archive.tar.gz","archiveSize":100,"archiveSha256":"a".repeat(64)}},
                {"workflowId":uuid::Uuid::new_v4(),"mountPath":"/home/user/.codex/skills/no-files","skillMd":"empty","attachments":null}
            ]
        })).unwrap();
        assert_eq!(manifest.storages.len(), 1);
        assert!(manifest.artifacts.is_empty());
        assert_eq!(
            manifest.storages[0].vas_storage_name,
            format!("workflow:{workflow_id}")
        );
        let fingerprints =
            crate::storage_fingerprints::StorageFingerprints::from_manifest(&manifest);
        assert!(
            fingerprints.storages["/home/user/.codex/skills/no-files"].vas_version_id()
                == Some("empty")
        );
    }
}
