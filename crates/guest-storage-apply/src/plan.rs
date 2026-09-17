use crate::download::DownloadTask;
use crate::instructions::{InstructionCleanup, InstructionFilename, InstructionNormalization};
use crate::manifest::{ArtifactEntry, Manifest, StorageEntry};
use std::path::Path;

pub(crate) struct RunPlan {
    pub(crate) cleanup_paths: Vec<String>,
    pub(crate) instruction_cleanups: Vec<InstructionCleanup>,
    pub(crate) preserved_paths: Vec<String>,
    pub(crate) empty_artifacts: Vec<EmptyArtifactPreparation>,
    pub(crate) download_tasks: Vec<DownloadTask>,
    pub(crate) instruction_files: Vec<InstructionNormalization>,
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
        for entry in manifest.storages.iter().filter(|entry| entry.cached) {
            if entry.instructions_target_filename.is_some() {
                // Instructions own only their managed files, not the framework home:
                // changed or removed skill children still need stale-path cleanup.
                // Keep both names until normalization can select an alternate source.
                preserved_paths.extend(InstructionFilename::ALL.map(|filename| {
                    Path::new(&entry.mount_path)
                        .join(filename.as_str())
                        .to_string_lossy()
                        .into_owned()
                }));
            } else {
                preserved_paths.push(entry.mount_path.clone());
            }
        }
        preserved_paths.extend(
            manifest
                .artifacts
                .iter()
                .filter(|a| a.cached)
                .map(|a| a.mount_path.clone()),
        );

        let instruction_files = manifest
            .storages
            .iter()
            .filter_map(|entry| {
                entry
                    .instructions_target_filename
                    .as_ref()
                    .map(|target_filename| {
                        if is_valid_url(&entry.archive_url)
                            && let Some(extract_path) = entry.extract_path.clone()
                        {
                            InstructionNormalization::staged(
                                extract_path,
                                entry.mount_path.clone(),
                                target_filename.clone(),
                            )
                        } else {
                            InstructionNormalization::in_place(
                                entry.mount_path.clone(),
                                target_filename.clone(),
                            )
                        }
                    })
            })
            .collect();
        let instruction_cleanups = manifest
            .instruction_cleanups
            .iter()
            .map(|entry| {
                InstructionCleanup::new(entry.mount_path.clone(), entry.target_filename.clone())
            })
            .collect();

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
            instruction_cleanups,
            preserved_paths,
            empty_artifacts,
            download_tasks,
            instruction_files,
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
        let download_mount_path = if entry.instructions_target_filename.is_some() {
            entry
                .extract_path
                .as_deref()
                .unwrap_or(entry.mount_path.as_str())
        } else {
            entry.mount_path.as_str()
        };
        tasks.push(DownloadTask::storage(
            format_entry_label(
                ManifestEntryKind::Storage,
                idx + 1,
                EntryLabel::storage(entry, url),
            ),
            url.clone(),
            download_mount_path.to_string(),
            entry.instructions_target_filename.is_some(),
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
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn is_valid_url_none() {
        assert!(!is_valid_url(&None));
    }

    #[test]
    fn is_valid_url_null_string() {
        assert!(!is_valid_url(&Some("null".to_string())));
    }

    #[test]
    fn is_valid_url_valid() {
        assert!(is_valid_url(&Some(
            "https://example.com/archive.tar.gz".to_string()
        )));
    }

    #[test]
    fn is_valid_url_file_scheme() {
        assert!(is_valid_url(&Some(
            "file:///tmp/vm0-storage-cache/abc.tar.gz".to_string()
        )));
    }

    #[test]
    fn manifest_entries_yield_storage_and_artifact_tasks() {
        let json = r#"{
            "storageMounts": [
                {
                    "mountPath": "/data",
                    "archiveUrl": "https://s3/storage.tar.gz",
                    "name": "data",
                    "versionId": "storage-v1"
                },
                {
                    "mountPath": "/workspace/a",
                    "archiveUrl": "https://s3/a.tar.gz",
                    "name": "workspace-a",
                    "versionId": "artifact-v1",
                    "missingRootPolicy": "preserveParentVersion",
                    "writeback": true
                },
                {
                    "mountPath": "/workspace/b",
                    "archiveUrl": "file:///tmp/vm0-storage-cache/b.tar.gz",
                    "name": "workspace-b",
                    "versionId": "artifact-v2",
                    "writeback": true
                }
            ]
        }"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.storages.len(), 1);
        assert_eq!(manifest.artifacts.len(), 2);

        let plan = RunPlan::from_manifest(&manifest);

        assert_eq!(plan.download_tasks.len(), 3);
        assert_eq!(
            plan.download_tasks[0],
            DownloadTask::storage(
                "storage 1 mountPath=/data vasStorageName=data vasVersionId=storage-v1 urlScheme=https cached=false".into(),
                "https://s3/storage.tar.gz".into(),
                "/data".into(),
                false,
            )
        );
        assert_eq!(
            plan.download_tasks[1],
            DownloadTask::artifact(
                "artifact 1 mountPath=/workspace/a vasStorageName=workspace-a vasVersionId=artifact-v1 urlScheme=https cached=false missingRootPolicy=preserveParentVersion".into(),
                "https://s3/a.tar.gz".into(),
                "/workspace/a".into(),
            )
        );
        assert_eq!(
            plan.download_tasks[2],
            DownloadTask::artifact(
                "artifact 2 mountPath=/workspace/b vasStorageName=workspace-b vasVersionId=artifact-v2 urlScheme=file cached=false missingRootPolicy=fail".into(),
                "file:///tmp/vm0-storage-cache/b.tar.gz".into(),
                "/workspace/b".into(),
            )
        );
    }

    #[test]
    fn run_plan_prepares_explicit_empty_artifact_without_download_task() {
        let json = r#"{
            "storageMounts": [{
                "mountPath": "/workspace",
                "archiveUrl": "https://s3/compat-empty-artifact.tar.gz",
                "empty": true,
                "name": "memory",
                "versionId": "empty-v1",
                "missingRootPolicy": "preserveParentVersion",
                "writeback": true
            }]
        }"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();

        let plan = RunPlan::from_manifest(&manifest);

        assert!(plan.download_tasks.is_empty());
        assert_eq!(
            plan.empty_artifacts,
            [EmptyArtifactPreparation {
                label: "artifact 1 mountPath=/workspace vasStorageName=memory vasVersionId=empty-v1 empty=true cached=false missingRootPolicy=preserveParentVersion".into(),
                mount_path: "/workspace".into(),
            }]
        );
    }

    #[test]
    fn run_plan_collects_preserved_paths_and_instruction_targets() {
        let json = r#"{
            "storageMounts": [
                {
                    "mountPath": "/home/user/.codex",
                    "archiveUrl": null,
                    "cached": true,
                    "instructionsTargetFilename": "AGENTS.md"
                },
                {
                    "mountPath": "/home/user/new",
                    "archiveUrl": null,
                    "cached": false
                },
                {
                    "mountPath": "/workspace",
                    "archiveUrl": null,
                    "cached": true,
                    "writeback": true
                }
            ],
            "cleanupPaths": ["/home/user/.codex"]
        }"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();

        let plan = RunPlan::from_manifest(&manifest);

        assert_eq!(plan.cleanup_paths, ["/home/user/.codex"]);
        assert!(plan.instruction_cleanups.is_empty());
        assert_eq!(
            plan.preserved_paths,
            [
                "/home/user/.codex/CLAUDE.md",
                "/home/user/.codex/AGENTS.md",
                "/workspace"
            ]
        );
        assert_eq!(plan.instruction_files.len(), 1);
        assert_eq!(
            plan.instruction_files[0],
            InstructionNormalization::in_place("/home/user/.codex".into(), "AGENTS.md".into())
        );
    }

    #[test]
    fn run_plan_downloads_instruction_archive_to_extract_path() {
        let json = r#"{
            "storageMounts": [{
                "mountPath": "/home/user/.codex",
                "extractPath": "/home/user/.vm0/guest-agent/runs/run-1/storage-instructions/0",
                "archiveUrl": "https://s3/instructions.tar.gz",
                "instructionsTargetFilename": "AGENTS.md"
            }]
        }"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();

        let plan = RunPlan::from_manifest(&manifest);

        assert_eq!(
            plan.instruction_files,
            [InstructionNormalization::staged(
                "/home/user/.vm0/guest-agent/runs/run-1/storage-instructions/0".into(),
                "/home/user/.codex".into(),
                "AGENTS.md".into()
            )]
        );
        assert_eq!(plan.download_tasks.len(), 1);
        assert_eq!(
            plan.download_tasks[0],
            DownloadTask::storage(
                "storage 1 mountPath=/home/user/.codex vasStorageName=unknown vasVersionId=unknown urlScheme=https cached=false".into(),
                "https://s3/instructions.tar.gz".into(),
                "/home/user/.vm0/guest-agent/runs/run-1/storage-instructions/0".into(),
                true,
            )
        );
    }

    #[test]
    fn run_plan_ignores_extract_path_for_non_instruction_storage() {
        let json = r#"{
            "storageMounts": [{
                "mountPath": "/data",
                "extractPath": "/tmp/staged-data",
                "archiveUrl": "https://s3/data.tar.gz"
            }]
        }"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();

        let plan = RunPlan::from_manifest(&manifest);

        assert!(plan.instruction_files.is_empty());
        assert_eq!(plan.download_tasks.len(), 1);
        assert_eq!(
            plan.download_tasks[0],
            DownloadTask::storage(
                "storage 1 mountPath=/data vasStorageName=unknown vasVersionId=unknown urlScheme=https cached=false".into(),
                "https://s3/data.tar.gz".into(),
                "/data".into(),
                false,
            )
        );
    }

    #[test]
    fn run_plan_collects_instruction_cleanups() {
        let json = r#"{
            "storageMounts": [],
            "instructionCleanups": [{
                "mountPath": "/home/user/.codex",
                "targetFilename": "AGENTS.md"
            }, {
                "mountPath": "/home/user/.claude"
            }]
        }"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();

        let plan = RunPlan::from_manifest(&manifest);

        assert_eq!(
            plan.instruction_cleanups,
            [
                InstructionCleanup::new("/home/user/.codex".into(), Some("AGENTS.md".into())),
                InstructionCleanup::new("/home/user/.claude".into(), None),
            ]
        );
    }

    #[test]
    fn run_plan_skips_cached_artifact_when_mount_root_exists() {
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("workspace");
        fs::create_dir_all(&mount).unwrap();
        let mount_path = mount.to_string_lossy().into_owned();
        let manifest = Manifest {
            storages: vec![],
            artifacts: vec![ArtifactEntry {
                mount_path: mount_path.clone(),
                archive_url: Some("https://s3/artifact.tar.gz".into()),
                cached: true,
                empty: false,
                vas_storage_name: Some("artifact".into()),
                vas_storage_id: None,
                vas_version_id: Some("artifact-v1".into()),
                missing_root_policy: None,
            }],
            cleanup_paths: vec![],
            instruction_cleanups: Vec::new(),
        };

        let plan = RunPlan::from_manifest(&manifest);

        assert_eq!(plan.preserved_paths, [mount_path]);
        assert!(plan.download_tasks.is_empty());
    }

    #[test]
    fn run_plan_downloads_cached_storage_when_mount_root_exists() {
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("storage");
        fs::create_dir_all(&mount).unwrap();
        let mount_path = mount.to_string_lossy().into_owned();
        let manifest = Manifest {
            storages: vec![StorageEntry {
                mount_path: mount_path.clone(),
                extract_path: None,
                archive_url: Some("https://s3/storage.tar.gz".into()),
                instructions_target_filename: None,
                cached: true,
                vas_storage_name: Some("storage".into()),
                vas_version_id: Some("storage-v1".into()),
            }],
            artifacts: vec![],
            cleanup_paths: vec![],
            instruction_cleanups: Vec::new(),
        };

        let plan = RunPlan::from_manifest(&manifest);

        assert_eq!(plan.preserved_paths, std::slice::from_ref(&mount_path));
        assert_eq!(
            plan.download_tasks,
            [DownloadTask::storage(
                format!(
                    "storage 1 mountPath={mount_path} vasStorageName=storage vasVersionId=storage-v1 urlScheme=https cached=true"
                ),
                "https://s3/storage.tar.gz".into(),
                mount_path,
                false,
            )],
        );
    }

    #[test]
    fn run_plan_downloads_cached_artifact_when_mount_root_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let mount_path = dir
            .path()
            .join("missing-workspace")
            .to_string_lossy()
            .into_owned();
        let manifest = Manifest {
            storages: vec![],
            artifacts: vec![ArtifactEntry {
                mount_path: mount_path.clone(),
                archive_url: Some("https://s3/artifact.tar.gz".into()),
                cached: true,
                empty: false,
                vas_storage_name: Some("artifact".into()),
                vas_storage_id: None,
                vas_version_id: Some("artifact-v1".into()),
                missing_root_policy: None,
            }],
            cleanup_paths: vec![],
            instruction_cleanups: Vec::new(),
        };

        let plan = RunPlan::from_manifest(&manifest);

        assert_eq!(plan.preserved_paths, std::slice::from_ref(&mount_path));
        assert_eq!(
            plan.download_tasks,
            [DownloadTask::artifact(
                format!(
                    "artifact 1 mountPath={mount_path} vasStorageName=artifact vasVersionId=artifact-v1 urlScheme=https cached=true missingRootPolicy=fail"
                ),
                "https://s3/artifact.tar.gz".into(),
                mount_path,
            )],
        );
    }
}
