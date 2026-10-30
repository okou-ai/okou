//! Prepared claim reader for immutable hash-addressed input packages.
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleReference {
    pub sha256: String,
    pub archive_bytes: u64,
    pub download_url: String,
}
impl BundleReference {
    pub fn validate(&self) -> Result<(), String> {
        if self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || self.archive_bytes == 0
            || self.archive_bytes > 32 * 1024 * 1024
        {
            return Err("Invalid content bundle identity or size".into());
        }
        let url = url::Url::parse(&self.download_url).map_err(|_| "Invalid content bundle URL")?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("Invalid content bundle URL".into());
        }
        Ok(())
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillBundle {
    pub sha256: String,
    pub archive_bytes: u64,
    pub download_url: String,
    #[serde(deserialize_with = "deserialize_skill_mount")]
    pub mount_path: String,
}
impl SkillBundle {
    pub fn reference(&self) -> BundleReference {
        BundleReference {
            sha256: self.sha256.clone(),
            archive_bytes: self.archive_bytes,
            download_url: self.download_url.clone(),
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaimedContentBundles {
    pub format: BundleFormat,
    #[serde(default, deserialize_with = "deserialize_instruction_reference")]
    pub instructions: Option<BundleReference>,
    pub skills: Vec<SkillBundle>,
}
#[derive(Debug, Deserialize)]
pub enum BundleFormat {
    #[serde(rename = "tar-gzip-v1")]
    TarGzipV1,
}
#[derive(Debug)]
pub struct PreparedBundleFile {
    pub path: String,
    pub content: Vec<u8>,
}
#[derive(Debug)]
pub struct PreparedBundle {
    pub mount_path: Option<String>,
    pub files: Vec<PreparedBundleFile>,
}

/// Track managed bundle mounts for cleanup, never as Storage download inputs.
pub fn fingerprints(
    context: &crate::types::ExecutionContext,
) -> crate::storage_fingerprints::StorageFingerprints {
    let mut result = context
        .storage_manifest
        .as_ref()
        .map(crate::storage_fingerprints::StorageFingerprints::from_manifest)
        .unwrap_or_default();
    if let Some(bundles) = &context.content_bundles {
        for skill in &bundles.skills {
            result.storages.insert(
                skill.mount_path.clone(),
                crate::storage_fingerprints::StorageFingerprint::new(
                    "content-bundle",
                    &skill.sha256,
                ),
            );
        }
    }
    result
}

fn deserialize_skill_mount<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    let path = String::deserialize(deserializer)?;
    crate::storage_manifest::validate_workflow_mount(&path).map_err(serde::de::Error::custom)?;
    Ok(path)
}

fn deserialize_instruction_reference<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<BundleReference>, D::Error> {
    BundleReference::deserialize(deserializer).map(Some)
}
