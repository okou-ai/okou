use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;

pub use guest_contracts::storage_manifest::WORKFLOW_STORAGE_NAME;
/// Business cache namespace for complete Agent instruction packages.
pub const INSTRUCTION_STORAGE_NAME: &str = "instruction";

/// Apply a managed instruction file from an ordinary Storage input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstructionFile {
    /// Stable framework-specific staging mount in the normalized manifest.
    pub storage_mount: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StorageManifest {
    pub storages: Vec<StorageEntry>,
    pub artifacts: Vec<ArtifactEntry>,
}

/// A Workflow or Skill name occupies exactly one directory component.
pub fn validate_workflow_skill_name(name: &str) -> Result<(), String> {
    if name.is_empty()
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
    /// Present only for an explicitly captured immutable template bundle.
    pub template_guidance: Option<guest_contracts::storage_manifest::TemplateGuidanceReference>,
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
