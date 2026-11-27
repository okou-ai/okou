//! Translate the API's publication protocol into normalized execution inputs.

use api_contracts::generated::constants::runners::paths::{
    CANONICAL_CLAUDE_CONFIG_DIR, CANONICAL_CODEX_HOME_DIR, CANONICAL_GUEST_HOME_DIR, PI_AGENT_DIR,
};
use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;
use guest_contracts::{
    agent_instructions::instruction_paths,
    env::{CliAgentTypeSelection, CliFramework},
    storage_manifest::{MEMORY_STORAGE_NAME, member_memory_mount},
};
use runner_types::{
    storage_manifest::{
        ArtifactEntry, INSTRUCTION_STORAGE_NAME, InstructionFile, StorageEntry, StorageManifest,
        WORKFLOW_STORAGE_NAME, validate_workflow_skill_name,
    },
    types::ExecutionContext,
};
use serde::Deserialize;
use std::{collections::HashSet, path::Path};

mod publication;

#[derive(Deserialize)]
struct ContentBundles {
    #[serde(rename = "format")]
    _format: BundleFormat,
    #[serde(default, deserialize_with = "instruction_reference")]
    instructions: Option<BundleReference>,
    skills: Vec<NamedSkillBundle>,
    #[serde(default)]
    templates: Vec<TemplateBundle>,
}

#[derive(Deserialize)]
enum BundleFormat {
    #[serde(rename = "tar-gzip-v1")]
    TarGzipV1,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleReference {
    sha256: String,
    archive_bytes: u64,
    download_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NamedSkillBundle {
    name: String,
    bundle: BundleReference,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartupInputs {
    memory: Option<MemoryInput>,
    content_bundles: ContentBundles,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryInput {
    storage_id: String,
    version_id: String,
    archive_url: Option<String>,
    archive_size: Option<u64>,
    empty: Option<bool>,
    missing_root_policy: Option<ArtifactEntryMissingRootPolicy>,
}

impl MemoryInput {
    fn bind(self, mount_path: &str) -> Result<ArtifactEntry, String> {
        if self.archive_url.is_none() && self.empty != Some(true) {
            return Err("Nonempty Memory requires an archive URL".into());
        }
        Ok(ArtifactEntry {
            mount_path: mount_path.into(),
            vas_storage_name: MEMORY_STORAGE_NAME.into(),
            vas_storage_id: self.storage_id,
            vas_version_id: self.version_id,
            archive_url: self.archive_url,
            archive_size: self.archive_size,
            empty: self.empty,
            missing_root_policy: self.missing_root_policy,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum TemplateOwnerKind {
    UserTemplate,
    PresentationTemplate,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateBundle {
    sha256: String,
    archive_bytes: u64,
    download_url: String,
    owner_kind: TemplateOwnerKind,
    template_id: String,
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

/// Normalize a complete execution publication for the local executor.
/// Decode errors intentionally contain no supplied values or secret field paths.
pub fn decode_execution_publication(body: &[u8]) -> Result<ExecutionContext, String> {
    let publication =
        serde_json::from_slice::<publication::ExecutionPublication>(body).map_err(|_| {
            // Revisit only rejected bytes to retain context-before-bundle errors,
            // independent of member order. No parser details leave this boundary.
            if super::decode_api_json_bytes::<ExecutionContext>(body).is_err() {
                "Invalid execution context"
            } else {
                "Invalid startup inputs"
            }
        })?;
    normalize(publication.context, publication.startup_inputs)
}

fn normalize(
    mut context: ExecutionContext,
    inputs: StartupInputs,
) -> Result<ExecutionContext, String> {
    let framework = CliAgentTypeSelection::parse(&context.cli_agent_type);
    let config_dir = match framework.framework() {
        CliFramework::ClaudeCode | CliFramework::Antigravity => CANONICAL_CLAUDE_CONFIG_DIR,
        CliFramework::Codex => CANONICAL_CODEX_HOME_DIR,
        CliFramework::Pi => PI_AGENT_DIR,
    };
    let packages = inputs.content_bundles;
    let memory = inputs
        .memory
        .map(|memory| memory.bind(member_memory_mount(framework.framework())))
        .transpose()?;
    let mut paths: HashSet<_> = memory
        .iter()
        .map(|entry| entry.mount_path.clone())
        .collect();
    let mut manifest = StorageManifest {
        storages: Vec::with_capacity(packages.skills.len() + 1 + packages.templates.len()),
        artifacts: memory.into_iter().collect(),
    };
    let skill_prefix = format!("{config_dir}/skills/");
    for skill in packages.skills {
        validate_workflow_skill_name(&skill.name)?;
        let mount_path = format!("{skill_prefix}{}", skill.name);
        if !paths.insert(mount_path.clone()) {
            return Err("Conflicting content bundle mount".into());
        }
        manifest
            .storages
            .push(skill.bundle.storage(WORKFLOW_STORAGE_NAME, mount_path)?);
    }
    let instruction_file = if let Some(reference) = packages.instructions {
        let mount = instruction_paths(
            Path::new(CANONICAL_GUEST_HOME_DIR),
            framework.normalized_cli_agent_type(),
        )
        .ok_or("Unsupported instruction framework")?
        .staging
        .to_string_lossy()
        .into_owned();
        if !paths.insert(mount.clone()) {
            return Err("Conflicting content bundle mount".into());
        }
        manifest
            .storages
            .push(reference.storage(INSTRUCTION_STORAGE_NAME, mount.clone())?);
        Some(InstructionFile {
            storage_mount: mount,
        })
    } else {
        None
    };
    for template in packages.templates {
        let mount_path = template.mount_path()?;
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
        manifest.storages.push(entry);
    }
    context.storage_manifest = Some(manifest);
    context.instruction_file = instruction_file;
    Ok(context)
}
