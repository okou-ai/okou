use crate::download::DownloadTask;
use crate::instructions::InstructionCleanup;
use crate::manifest::{ArtifactEntry, Manifest, StorageEntry};
use std::path::Path;

pub(crate) struct RunPlan {
    pub(crate) cleanup_paths: Vec<String>,
    pub(crate) instruction_cleanups: Vec<InstructionCleanup>,
    pub(crate) preserved_paths: Vec<String>,
    pub(crate) empty_artifacts: Vec<EmptyArtifactPreparation>,
    pub(crate) download_tasks: Vec<DownloadTask>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EmptyArtifactPreparation {
    pub(crate) label: String,
    pub(crate) mount_path: String,
}

#[derive(Clone, Copy)]
enum ManifestEntryKind {
    Storage,
    Artifact,
}

struct EntryLabel<'a> {
    mount_path: &'a str,
    storage_name: Option<&'a str>,
    version_id: Option<&'a str>,
    cached: bool,
    missing_root_policy: Option<&'a str>,
    archive_url: &'a str,
}

impl<'a> EntryLabel<'a> {
    fn storage(entry: &'a StorageEntry, archive_url: &'a str) -> Self {
        Self {
            mount_path: &entry.mount_path,
            storage_name: entry.vas_storage_name.as_deref(),
            version_id: entry.vas_version_id.as_deref(),
            cached: entry.cached,
            missing_root_policy: None,
            archive_url,
        }
    }

    fn artifact(entry: &'a ArtifactEntry, archive_url: &'a str) -> Self {
        Self {
            mount_path: &entry.mount_path,
            storage_name: entry.vas_storage_name.as_deref(),
            version_id: entry.vas_version_id.as_deref(),
            cached: entry.cached,
            missing_root_policy: entry.missing_root_policy.as_deref(),
            archive_url,
        }
    }
}

impl ManifestEntryKind {
    fn label_prefix(self) -> &'static str {
        match self {
            Self::Storage => "storage",
            Self::Artifact => "artifact",
        }
    }

    fn include_missing_root_policy(self) -> bool {
        matches!(self, Self::Artifact)
    }
}

impl RunPlan {
    pub(crate) fn from_manifest(manifest: &Manifest) -> Self {
        let mut preserved_paths = Vec::new();
        preserved_paths.extend(
            manifest
                .storages
                .iter()
                .filter(|entry| entry.cached)
                .map(|entry| entry.mount_path.clone()),
        );
        preserved_paths.extend(
            manifest
                .artifacts
                .iter()
                .filter(|a| a.cached)
                .map(|a| a.mount_path.clone()),
        );

        // Build unified task list: storages + artifact + memory, all downloaded in parallel.
        let mut download_tasks = Vec::new();

        // Storages: 404 is fatal.
        append_storage_download_tasks(&mut download_tasks, &manifest.storages);

        // Artifacts with archives must download successfully; explicit empty
        // artifacts are prepared separately below and do not create tasks.
        append_artifact_download_tasks(&mut download_tasks, &manifest.artifacts);
        let empty_artifacts = manifest
            .artifacts
            .iter()
            .enumerate()
            .filter(|(_, entry)| entry.empty)
            .map(|(index, entry)| EmptyArtifactPreparation {
                label: format_empty_artifact_label(entry, index + 1),
                mount_path: entry.mount_path.clone(),
            })
            .collect();

        Self {
            cleanup_paths: manifest.cleanup_paths.clone(),
            instruction_cleanups: manifest
                .instruction_cleanups
                .iter()
                .map(|entry| {
                    InstructionCleanup::new(entry.mount_path.clone(), entry.target_filename.clone())
                })
                .collect(),
            preserved_paths,
            empty_artifacts,
            download_tasks,
        }
    }
}

/// Check if archive URL is valid (not None and not string "null").
fn is_valid_url(url: &Option<String>) -> bool {
    matches!(url, Some(u) if u != "null")
}

fn append_storage_download_tasks(tasks: &mut Vec<DownloadTask>, entries: &[StorageEntry]) {
    for (idx, entry) in entries.iter().enumerate() {
        if !is_valid_url(&entry.archive_url) {
            continue;
        }
        let Some(url) = entry.archive_url.as_ref() else {
            continue;
        };
        tasks.push(DownloadTask::storage(
            format_entry_label(
                ManifestEntryKind::Storage,
                idx + 1,
                EntryLabel::storage(entry, url),
            ),
            url.clone(),
            entry.mount_path.clone(),
            false,
        ));
    }
}

fn append_artifact_download_tasks(tasks: &mut Vec<DownloadTask>, entries: &[ArtifactEntry]) {
    for (idx, entry) in entries.iter().enumerate() {
        if entry.empty || entry.cached && Path::new(&entry.mount_path).is_dir() {
            continue;
        }
        if !is_valid_url(&entry.archive_url) {
            continue;
        }
        let Some(url) = entry.archive_url.as_ref() else {
            continue;
        };
        tasks.push(DownloadTask::artifact(
            format_entry_label(
                ManifestEntryKind::Artifact,
                idx + 1,
                EntryLabel::artifact(entry, url),
            ),
            url.clone(),
            entry.mount_path.clone(),
        ));
    }
}

fn format_empty_artifact_label(entry: &ArtifactEntry, index: usize) -> String {
    let storage_name = entry.vas_storage_name.as_deref().unwrap_or("unknown");
    let version_id = entry.vas_version_id.as_deref().unwrap_or("unknown");
    let missing_root_policy = entry.missing_root_policy.as_deref().unwrap_or("fail");
    format!(
        "artifact {index} mountPath={} vasStorageName={} vasVersionId={} empty=true cached={} missingRootPolicy={}",
        entry.mount_path, storage_name, version_id, entry.cached, missing_root_policy
    )
}

fn format_entry_label(kind: ManifestEntryKind, index: usize, entry: EntryLabel<'_>) -> String {
    let storage_name = entry.storage_name.unwrap_or("unknown");
    let version_id = entry.version_id.unwrap_or("unknown");
    let url_scheme = entry
        .archive_url
        .split_once("://")
        .map(|(scheme, _)| scheme)
        .unwrap_or("unknown");
    let missing_root_policy = if kind.include_missing_root_policy() {
        format!(
            " missingRootPolicy={}",
            entry.missing_root_policy.unwrap_or("fail")
        )
    } else {
        String::new()
    };

    format!(
        "{} {} mountPath={} vasStorageName={} vasVersionId={} urlScheme={} cached={}{}",
        kind.label_prefix(),
        index,
        entry.mount_path,
        storage_name,
        version_id,
        url_scheme,
        entry.cached,
        missing_root_policy
    )
}

#[cfg(test)]
mod tests;
