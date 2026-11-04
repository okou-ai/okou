//! Translate the API's publication protocol into normalized execution inputs.

use guest_contracts::agent_instructions::instruction_paths;
use runner_types::{
    storage_manifest::{
        INSTRUCTION_STORAGE_NAME, InstructionFile, StorageEntry, StorageManifest,
        WORKFLOW_STORAGE_NAME, validate_workflow_mount,
    },
    types::ExecutionContext,
};
use serde::Deserialize;
use std::{collections::HashSet, path::Path};

#[derive(Deserialize)]
struct ClaimInputs {
    #[serde(rename = "contentBundles")]
    packages: ContentBundles,
}

impl super::ApiDecodePath for ClaimInputs {
    const DECODE_PATH_SCHEMA: &'static api_contracts::DecodePathSchema =
        &api_contracts::generated::decode_paths::runners::jobs::by_id::claim::RESPONSE;
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContentBundles {
    #[serde(rename = "format")]
    _format: BundleFormat,
    #[serde(default, deserialize_with = "instruction_reference")]
    instructions: Option<BundleReference>,
    skills: Vec<SkillBundle>,
}

#[derive(Deserialize)]
enum BundleFormat {
    #[serde(rename = "tar-gzip-v1")]
    TarGzipV1,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BundleReference {
    sha256: String,
    archive_bytes: u64,
    download_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SkillBundle {
    sha256: String,
    archive_bytes: u64,
    download_url: String,
    mount_path: String,
}

impl BundleReference {
    fn storage(self, name: &str, mount_path: String) -> Result<StorageEntry, String> {
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
        Ok(StorageEntry {
            name: name.into(),
            mount_path,
            vas_storage_name: name.into(),
            vas_version_id: self.sha256,
            archive_url: self.download_url,
            archive_size: Some(self.archive_bytes),
        })
    }
}

fn instruction_reference<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<BundleReference>, D::Error> {
    BundleReference::deserialize(deserializer).map(Some)
}

pub(super) fn decode_claim(body: &[u8]) -> Result<ExecutionContext, String> {
    // Keep scalar decode paths intact: flattening the context into a publication
    // DTO would erase nested serde_path_to_error locations.
    let mut context: ExecutionContext = super::decode_api_json_bytes(body)?;
    let inputs: ClaimInputs = super::decode_api_json_bytes(body)?;
    let mut paths: HashSet<String> = context
        .storage_manifest
        .iter()
        .flat_map(|manifest| {
            manifest
                .storages
                .iter()
                .map(|s| s.mount_path.clone())
                .chain(manifest.artifacts.iter().map(|a| a.mount_path.clone()))
        })
        .collect();
    let mut entries = Vec::with_capacity(inputs.packages.skills.len() + 1);
    for skill in inputs.packages.skills {
        validate_workflow_mount(&skill.mount_path)?;
        if !paths.insert(skill.mount_path.clone()) {
            return Err("Conflicting content bundle mount".into());
        }
        entries.push(
            BundleReference {
                sha256: skill.sha256,
                archive_bytes: skill.archive_bytes,
                download_url: skill.download_url,
            }
            .storage(WORKFLOW_STORAGE_NAME, skill.mount_path)?,
        );
    }
    let instruction_file = if let Some(reference) = inputs.packages.instructions {
        let framework = guest_contracts::env::CliAgentTypeSelection::parse(&context.cli_agent_type);
        let mount = instruction_paths(
            Path::new("/home/user"),
            framework.normalized_cli_agent_type(),
        )
        .ok_or("Unsupported instruction framework")?
        .staging
        .to_string_lossy()
        .into_owned();
        if !paths.insert(mount.clone()) {
            return Err("Conflicting content bundle mount".into());
        }
        entries.push(reference.storage(INSTRUCTION_STORAGE_NAME, mount.clone())?);
        Some(InstructionFile {
            storage_mount: mount,
        })
    } else {
        None
    };
    context
        .storage_manifest
        .get_or_insert_with(|| StorageManifest {
            storages: Vec::new(),
            artifacts: Vec::new(),
        })
        .storages
        .extend(entries);
    context.instruction_file = instruction_file;
    Ok(context)
}
