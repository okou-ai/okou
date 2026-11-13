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
struct ExecutionInputs {
    #[serde(rename = "contentBundles")]
    packages: ContentBundles,
}

impl super::ApiDecodePath for ExecutionInputs {
    const DECODE_PATH_SCHEMA: &'static api_contracts::DecodePathSchema =
        &api_contracts::generated::decode_paths::runners::execution_publication::CONTEXT;
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContentBundles {
    #[serde(rename = "format")]
    _format: BundleFormat,
    #[serde(default, deserialize_with = "instruction_reference")]
    instructions: Option<BundleReference>,
    skills: Vec<SkillBundle>,
    #[serde(default)]
    templates: Vec<TemplateBundle>,
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

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum TemplateOwnerKind {
    UserTemplate,
    PresentationTemplate,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TemplateBundle {
    sha256: String,
    archive_bytes: u64,
    download_url: String,
    owner_kind: TemplateOwnerKind,
    template_id: String,
    before_mount_paths: Vec<String>,
}

impl TemplateBundle {
    fn mount_path(&self) -> Result<String, String> {
        let id = self.template_id.as_bytes();
        if id.len() != 36
            || !id.iter().enumerate().all(|(index, c)| {
                if [8, 13, 18, 23].contains(&index) {
                    *c == b'-'
                } else {
                    c.is_ascii_hexdigit()
                }
            })
        {
            return Err("Invalid template guidance owner ID".into());
        }
        let directory = match self.owner_kind {
            TemplateOwnerKind::UserTemplate => "user-template",
            TemplateOwnerKind::PresentationTemplate => "presentation-template",
        };
        Ok(format!(
            "/home/user/workspace/generated/{directory}/{}",
            self.template_id
        ))
    }
}

impl BundleReference {
    fn storage(self, name: &str, mount_path: String) -> Result<StorageEntry, String> {
        self.storage_with_limit(name, mount_path, 32 * 1024 * 1024)
    }

    fn storage_with_limit(
        self,
        name: &str,
        mount_path: String,
        max_bytes: u64,
    ) -> Result<StorageEntry, String> {
        if self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || self.archive_bytes == 0
            || self.archive_bytes > max_bytes
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
            template_guidance: None,
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

/// Normalize the same complete publication without a Claim transport or timing.
/// Decode errors intentionally contain no supplied values or secret field paths.
pub fn decode_execution_publication(body: &[u8]) -> Result<ExecutionContext, String> {
    let context = super::decode_api_json_bytes(body).map_err(|_| "Invalid execution context")?;
    let inputs = super::decode_api_json_bytes(body).map_err(|_| "Invalid content bundles")?;
    normalize(context, inputs)
}

fn normalize(
    mut context: ExecutionContext,
    inputs: ExecutionInputs,
) -> Result<ExecutionContext, String> {
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
    let manifest = context
        .storage_manifest
        .get_or_insert_with(|| StorageManifest {
            storages: Vec::new(),
            artifacts: Vec::new(),
        });
    manifest.storages.extend(entries);
    for template in inputs.packages.templates {
        let mount_path = template.mount_path()?;
        // Ancestor/descendant overlays are valid; a second destination is not.
        if paths
            .iter()
            .any(|path| Path::new(path) == Path::new(&mount_path))
        {
            return Err("Conflicting template guidance mount".into());
        }
        paths.insert(mount_path.clone());
        let integrity = guest_contracts::storage_manifest::TemplateGuidanceReference {
            sha256: template.sha256.clone(),
            archive_bytes: template.archive_bytes,
        };
        let mut entry = BundleReference {
            sha256: template.sha256,
            archive_bytes: template.archive_bytes,
            download_url: template.download_url,
        }
        .storage_with_limit(
            guest_contracts::storage_manifest::TEMPLATE_GUIDANCE_STORAGE_NAME,
            mount_path,
            guest_contracts::storage_manifest::MAX_TEMPLATE_ARCHIVE_BYTES,
        )?;
        entry.template_guidance = Some(integrity);
        // Missing optional Storage mounts have no entry. Use the first surviving
        // anchor to preserve the API's winning order across both transports.
        let position = template
            .before_mount_paths
            .iter()
            .find_map(|path| {
                manifest
                    .storages
                    .iter()
                    .position(|storage| Path::new(&storage.mount_path) == Path::new(path))
            })
            .unwrap_or(manifest.storages.len());
        manifest.storages.insert(position, entry);
    }
    context.instruction_file = instruction_file;
    Ok(context)
}
