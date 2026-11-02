//! Storage materialization planning between canonical runner manifests and guest execution.
//!
//! [`build_storage_plan`] combines a canonical storage manifest and optional fingerprints from a
//! prior filesystem into an explicit [`StoragePlan`]. The plan is
//! crate-private and is not serialized: it preserves semantic actions while the runner decides
//! whether guest work is required and resolves eligible archive sources. Only then does
//! [`StoragePlan::into_guest_manifest`] consume it into the shared runner-to-guest wire format.
//!
//! The `previous` input distinguishes a fresh filesystem (`None`) from a reused filesystem
//! (`Some`). In particular, `Some(empty)` is not equivalent to `None`: both produce materialization
//! actions for every current entry, but the reused filesystem also requires cleanup of unmatched
//! paths before materialization.
//!
//! ## Action matrix
//!
//! | Entry | Matching fingerprint | Fresh or non-matching fingerprint |
//! | --- | --- | --- |
//! | Ordinary storage | `ReuseExisting`: keep the mount with no guest work | `Download`: extract an archive |
//! | Non-empty artifact | `ReuseOrRepair`: preserve an existing root or use the retained archive source to repair a missing root | `Download`: materialize the archive |
//! | Empty artifact | `PrepareEmpty { cached: true }` | `PrepareEmpty { cached: false }` |
//!
//! On a reused filesystem, changed and removed storage or artifact mounts are cleaned
//! before materializing their replacements. Removed tainted framework-home storage fingerprints
//! require managed-file-only cleanup, preserving the surrounding native framework home.
//!
//! ## Cache and guest boundary
//!
//! `StoragePlan::cache_candidates` exposes only remote archives required by download actions.
//! Cache handling may use `StoragePlan::stage_archive` to replace such a remote source with a
//! guest-staged source after validating the entry identity; it cannot change the storage or
//! artifact action. [`StoragePlan::requires_guest_work`] is evaluated before cache resolution, and
//! the resolved plan is finally converted to the guest manifest for execution.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::OnceLock;

use api_contracts::generated::{
    constants::runners::paths::{
        CANONICAL_CLAUDE_CONFIG_DIR, CANONICAL_CODEX_HOME_DIR, PI_AGENT_DIR,
    },
    types::runners::storage::ArtifactEntryMissingRootPolicy,
};
use guest_contracts::storage_manifest as wire;

use crate::error::{StorageError as RunnerError, StorageResult as RunnerResult};
use crate::storage_fingerprints::{StorageFingerprint, StorageFingerprints};

use runner_types::storage_manifest::StorageManifest;

/// The semantic actions required to apply one canonical storage manifest.
///
/// This type deliberately remains separate from the guest wire manifest so planning, cleanup, and
/// repair decisions stay explicit. Archive delivery may refine an eligible action's source from a
/// remote URL to a guest-staged URL, but it does not change the action itself.
#[derive(Debug, Clone)]
pub struct StoragePlan {
    storages: Vec<StoragePlanEntry>,
    artifacts: Vec<ArtifactPlanEntry>,
    cleanup_paths: Vec<String>,
    instruction_cleanups: Vec<InstructionCleanup>,
    reused_entries: usize,
    decoded_prepared: bool,
    decoded_mount_conflicts: OnceLock<HashSet<usize>>,
    decoded: Vec<(
        String,
        std::sync::Arc<crate::storage_cache::decoded::CachedFiles>,
    )>,
}

#[derive(Debug, Clone)]
struct StoragePlanEntry {
    mount_path: String,
    vas_storage_name: String,
    vas_version_id: String,
    archive_size: Option<u64>,
    action: StorageAction,
}

impl StoragePlanEntry {
    fn into_guest_entry(self) -> wire::StorageEntry {
        let (archive_url, cached) = match self.action {
            StorageAction::Download { source } => (Some(source.wire_url()), false),
            StorageAction::ReuseExisting => (None, true),
        };
        wire::StorageEntry {
            mount_path: self.mount_path,
            archive_url,
            cached,
            vas_storage_name: Some(self.vas_storage_name),
            vas_version_id: Some(self.vas_version_id),
        }
    }
}

#[derive(Debug, Clone)]
enum StorageAction {
    Download { source: ArchiveSource },
    ReuseExisting,
}

#[derive(Debug, Clone)]
struct ArtifactPlanEntry {
    mount_path: String,
    vas_storage_name: String,
    vas_storage_id: String,
    vas_version_id: String,
    archive_size: Option<u64>,
    missing_root_policy: Option<ArtifactEntryMissingRootPolicy>,
    action: ArtifactAction,
}

impl ArtifactPlanEntry {
    fn into_guest_entry(self) -> wire::ArtifactEntry {
        let (archive_url, empty, cached) = match self.action {
            ArtifactAction::Download { source } => (Some(source.wire_url()), false, false),
            ArtifactAction::ReuseOrRepair { source } => (Some(source.wire_url()), false, true),
            ArtifactAction::PrepareEmpty { cached } => (None, true, cached),
        };
        wire::ArtifactEntry {
            mount_path: self.mount_path,
            archive_url,
            empty,
            cached,
            vas_storage_name: Some(self.vas_storage_name),
            vas_storage_id: Some(self.vas_storage_id),
            vas_version_id: Some(self.vas_version_id),
            missing_root_policy: self.missing_root_policy.map(missing_root_policy_wire_value),
        }
    }

    fn is_decoded_download(&self) -> bool {
        !self.vas_storage_name.is_empty()
            && !self.vas_storage_id.is_empty()
            && !self.vas_version_id.is_empty()
            && matches!(
                &self.action,
                ArtifactAction::Download { source }
                    if source.remote_url().is_some_and(|url| !url.is_empty() && url != "null")
            )
    }
}

#[derive(Debug, Clone)]
enum ArtifactAction {
    Download { source: ArchiveSource },
    ReuseOrRepair { source: ArchiveSource },
    PrepareEmpty { cached: bool },
}

#[derive(Debug, Clone)]
enum ArchiveSource {
    Remote(String),
    GuestStaged(String),
}

impl ArchiveSource {
    fn wire_url(self) -> String {
        match self {
            Self::Remote(url) | Self::GuestStaged(url) => url,
        }
    }

    fn remote_url(&self) -> Option<&str> {
        match self {
            Self::Remote(url) => Some(url),
            Self::GuestStaged(_) => None,
        }
    }
}

#[derive(Debug, Clone)]
struct InstructionCleanup {
    mount_path: String,
    target_filename: Option<String>,
}

#[derive(Clone, Copy)]
pub struct ArchiveHandle {
    kind: ArchiveKind,
    index: usize,
}

impl ArchiveHandle {
    /// Representative source in the normalized per-kind prepared plan.
    /// This position is not an object identity or stable across plan replacements.
    pub(crate) const fn diagnostic_source(self) -> (&'static str, usize) {
        let kind = match self.kind {
            ArchiveKind::Storage => "storage",
            ArchiveKind::Artifact => "artifact",
        };
        (kind, self.index)
    }

    pub(crate) const fn is_artifact(self) -> bool {
        matches!(self.kind, ArchiveKind::Artifact)
    }

    #[cfg(test)]
    pub(crate) const fn storage(index: usize) -> Self {
        Self {
            kind: ArchiveKind::Storage,
            index,
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    pub const fn artifact(index: usize) -> Self {
        Self {
            kind: ArchiveKind::Artifact,
            index,
        }
    }
}

#[derive(Clone, Copy)]
enum ArchiveKind {
    Storage,
    Artifact,
}

pub(crate) struct CacheArchiveCandidate {
    pub(crate) handle: ArchiveHandle,
    pub(crate) name: String,
    pub(crate) version: String,
    pub(crate) archive_url: String,
    pub(crate) archive_size: Option<u64>,
}

/// Build the semantic plan for applying `manifest` to a guest filesystem.
///
/// `previous=None`
/// describes a fresh filesystem and schedules no replacement or removal cleanup.
/// `previous=Some(...)` describes a reused filesystem, so entries without matching fingerprints
/// and entries absent from the current manifest are cleaned before the planned actions run. This
/// makes `Some(empty)` intentionally different from `None`.
///
/// # Errors
///
/// Returns an internal error when a non-empty artifact has no archive source.
pub fn build_storage_plan(
    manifest: &StorageManifest,
    previous: Option<&StorageFingerprints>,
) -> RunnerResult<StoragePlan> {
    let mut cleanup_paths = Vec::new();
    let mut instruction_cleanups = Vec::new();
    let mut reused_entries = 0;
    let storages = manifest
        .storages
        .iter()
        .map(|storage| {
            let unchanged = previous.is_some_and(|fingerprints| {
                fingerprints
                    .storages
                    .get(&storage.mount_path)
                    .is_some_and(|fingerprint| {
                        fingerprint.matches(&storage.vas_storage_name, &storage.vas_version_id)
                    })
            });
            if unchanged {
                reused_entries += 1;
            } else if previous.is_some() {
                cleanup_paths.push(storage.mount_path.clone());
            }
            let action = if unchanged {
                StorageAction::ReuseExisting
            } else {
                StorageAction::Download {
                    source: ArchiveSource::Remote(storage.archive_url.clone()),
                }
            };

            StoragePlanEntry {
                mount_path: storage.mount_path.clone(),
                vas_storage_name: storage.vas_storage_name.clone(),
                vas_version_id: storage.vas_version_id.clone(),
                archive_size: storage.archive_size.filter(|size| *size > 0),
                action,
            }
        })
        .collect::<Vec<_>>();

    let artifacts = manifest
        .artifacts
        .iter()
        .map(|artifact| {
            let empty = artifact.empty.unwrap_or(false);
            let unchanged = previous.is_some_and(|fingerprints| {
                fingerprints
                    .artifacts
                    .get(&artifact.mount_path)
                    .is_some_and(|fingerprint| {
                        fingerprint.matches(&artifact.vas_storage_name, &artifact.vas_version_id)
                    })
            });
            if unchanged {
                reused_entries += 1;
            } else if previous.is_some() {
                cleanup_paths.push(artifact.mount_path.clone());
            }

            let action = if empty {
                ArtifactAction::PrepareEmpty { cached: unchanged }
            } else {
                let archive_url = artifact.archive_url.clone().ok_or_else(|| {
                    RunnerError::Internal(format!(
                        "storage manifest artifact {} version {} is missing archiveUrl",
                        artifact.vas_storage_name, artifact.vas_version_id
                    ))
                })?;
                if unchanged {
                    ArtifactAction::ReuseOrRepair {
                        source: ArchiveSource::Remote(archive_url),
                    }
                } else {
                    ArtifactAction::Download {
                        source: ArchiveSource::Remote(archive_url),
                    }
                }
            };

            Ok(ArtifactPlanEntry {
                mount_path: artifact.mount_path.clone(),
                vas_storage_name: artifact.vas_storage_name.clone(),
                vas_storage_id: artifact.vas_storage_id.clone(),
                vas_version_id: artifact.vas_version_id.clone(),
                archive_size: artifact.archive_size.filter(|size| *size > 0),
                missing_root_policy: artifact.missing_root_policy,
                action,
            })
        })
        .collect::<RunnerResult<Vec<_>>>()?;

    if let Some(previous) = previous {
        record_removed_storages(
            previous,
            manifest
                .storages
                .iter()
                .map(|entry| entry.mount_path.as_str()),
            &mut cleanup_paths,
            &mut instruction_cleanups,
        );
        record_removed_artifacts(
            previous,
            manifest
                .artifacts
                .iter()
                .map(|entry| entry.mount_path.as_str()),
            &mut cleanup_paths,
        );
    }

    Ok(StoragePlan {
        storages,
        artifacts,
        cleanup_paths,
        instruction_cleanups,
        reused_entries,
        decoded_prepared: false,
        decoded_mount_conflicts: OnceLock::new(),
        decoded: Vec::new(),
    })
}

impl StoragePlan {
    pub(crate) fn decoded_prepared(&self) -> bool {
        self.decoded_prepared
    }

    pub(crate) fn decoded_mount_count(&self) -> usize {
        self.decoded.len()
    }

    pub(crate) fn finish_decoded_preparation(&mut self) {
        self.decoded_prepared = true;
    }

    pub(crate) fn has_decoded(&self, handle: ArchiveHandle) -> bool {
        self.entry_mount(handle)
            .is_some_and(|entry_mount| self.decoded.iter().any(|(mount, _)| mount == entry_mount))
    }

    pub(crate) fn decoded_archive_retirement_candidate(&self, handle: ArchiveHandle) -> bool {
        self.entry_mount(handle).is_some_and(|entry_mount| {
            self.decoded
                .iter()
                .any(|(mount, files)| mount == entry_mount && files.archive_retirement_candidate)
        })
    }

    /// A ready mount must fit one bounded request before its archive is omitted.
    /// The executor batches larger combined manifests after source resolution.
    pub(crate) fn decoded_entry_fits(&self, handle: ArchiveHandle) -> RunnerResult<bool> {
        let manifest = match handle.kind {
            ArchiveKind::Storage => {
                let Some(entry) = self.storages.get(handle.index) else {
                    return Ok(false);
                };
                if !matches!(entry.action, StorageAction::Download { .. }) {
                    return Ok(false);
                }
                wire::Manifest {
                    storages: vec![entry.clone().into_guest_entry()],
                    artifacts: Vec::new(),
                    cleanup_paths: Vec::new(),
                    instruction_cleanups: Vec::new(),
                }
            }
            ArchiveKind::Artifact => {
                let Some(entry) = self.artifacts.get(handle.index) else {
                    return Ok(false);
                };
                if !entry.is_decoded_download() {
                    return Ok(false);
                }
                wire::Manifest {
                    storages: Vec::new(),
                    artifacts: vec![entry.clone().into_guest_entry()],
                    cleanup_paths: Vec::new(),
                    instruction_cleanups: Vec::new(),
                }
            }
        };
        let bytes = serde_json::to_vec(&manifest)
            .map_err(|error| RunnerError::Internal(format!("manifest JSON: {error}")))?;
        Ok(bytes.len() <= guest_contracts::storage_files::MAX_MANIFEST_BYTES)
    }

    pub(crate) fn is_decoded_download(&self, handle: ArchiveHandle) -> bool {
        match handle.kind {
            ArchiveKind::Storage => self
                .storages
                .get(handle.index)
                .is_some_and(|entry| matches!(entry.action, StorageAction::Download { .. })),
            ArchiveKind::Artifact => self
                .artifacts
                .get(handle.index)
                .is_some_and(ArtifactPlanEntry::is_decoded_download),
        }
    }

    pub(crate) fn decoded_mount(&self, handle: ArchiveHandle) -> Option<&str> {
        let (mount_path, position) = match handle.kind {
            ArchiveKind::Storage => {
                let entry = self.storages.get(handle.index)?;
                if !matches!(entry.action, StorageAction::Download { .. }) {
                    return None;
                }
                (entry.mount_path.as_str(), handle.index)
            }
            ArchiveKind::Artifact => {
                let entry = self.artifacts.get(handle.index)?;
                if !entry.is_decoded_download() {
                    return None;
                }
                (
                    entry.mount_path.as_str(),
                    self.storages.len() + handle.index,
                )
            }
        };
        let target = PathBuf::from(mount_path);
        if mount_path.len() > guest_contracts::storage_files::MAX_PATH_BYTES
            || !target.is_absolute()
            || target.components().any(|part| {
                !matches!(
                    part,
                    std::path::Component::RootDir | std::path::Component::Normal(_)
                )
            })
        {
            return None;
        }
        // Mount identities/order are immutable; archive staging only refines
        // source actions. Reused plans never pay for this derived lookup.
        let conflicts = self.decoded_mount_conflicts.get_or_init(|| {
            let mounts = self
                .storages
                .iter()
                .map(|entry| entry.mount_path.as_str())
                .chain(self.artifacts.iter().map(|entry| entry.mount_path.as_str()))
                .collect::<Vec<_>>();
            let conflicting =
                guest_contracts::storage_files::conflicting_mounts(mounts.iter().copied());
            mounts
                .into_iter()
                .enumerate()
                .filter_map(|(position, mount)| conflicting.contains(mount).then_some(position))
                .collect()
        });
        if conflicts.contains(&position) {
            return None;
        }
        Some(mount_path)
    }

    fn entry_mount(&self, handle: ArchiveHandle) -> Option<&str> {
        match handle.kind {
            ArchiveKind::Storage => self
                .storages
                .get(handle.index)
                .map(|entry| entry.mount_path.as_str()),
            ArchiveKind::Artifact => self
                .artifacts
                .get(handle.index)
                .map(|entry| entry.mount_path.as_str()),
        }
    }

    pub(crate) fn add_decoded(
        &mut self,
        mount: String,
        files: std::sync::Arc<crate::storage_cache::decoded::CachedFiles>,
    ) {
        self.decoded.push((mount, files));
    }

    pub fn take_decoded(
        &mut self,
    ) -> Vec<(
        String,
        std::sync::Arc<crate::storage_cache::decoded::CachedFiles>,
    )> {
        std::mem::take(&mut self.decoded)
    }

    pub(crate) fn decoded_file_count(&self) -> usize {
        self.decoded
            .iter()
            .map(|(_, files)| files.files.len())
            .sum()
    }

    pub(crate) fn decoded_bytes(&self) -> usize {
        self.decoded
            .iter()
            .map(|(mount, files)| {
                8 + mount.len()
                    + files
                        .files
                        .iter()
                        .map(|file| 20 + file.path.len() + file.content.len())
                        .sum::<usize>()
            })
            .sum()
    }

    /// Return whether applying this plan requires guest execution.
    ///
    /// The result is `false` only when there is no cleanup, every storage is
    /// `ReuseExisting`, and there are no artifacts. Artifact actions require the
    /// guest even when their fingerprints match.
    pub fn requires_guest_work(&self) -> bool {
        !self.cleanup_paths.is_empty()
            || !self.instruction_cleanups.is_empty()
            || self
                .storages
                .iter()
                .any(|entry| !matches!(entry.action, StorageAction::ReuseExisting))
            || !self.artifacts.is_empty()
    }

    pub fn reused_entries(&self) -> usize {
        self.reused_entries
    }

    pub fn entry_count(&self) -> usize {
        self.storages.len() + self.artifacts.len()
    }

    pub fn cleanup_path_count(&self) -> usize {
        self.cleanup_paths.len()
    }

    pub fn instruction_cleanup_count(&self) -> usize {
        self.instruction_cleanups.len()
    }

    /// Return remote archives eligible for runner-side delivery.
    ///
    /// Candidates are limited to storage `Download` actions and
    /// artifact `Download` actions. Reuse, repair, empty preparation, and
    /// sources that are already guest-staged are intentionally excluded.
    pub(crate) fn cache_candidates(&self) -> Vec<CacheArchiveCandidate> {
        let storage_candidates = self
            .storages
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| {
                let source = match &entry.action {
                    StorageAction::Download { source } => source,
                    StorageAction::ReuseExisting => return None,
                };
                Some(CacheArchiveCandidate {
                    handle: ArchiveHandle {
                        kind: ArchiveKind::Storage,
                        index,
                    },
                    name: entry.vas_storage_name.clone(),
                    version: entry.vas_version_id.clone(),
                    archive_url: source.remote_url()?.to_string(),
                    archive_size: entry.archive_size,
                })
            });
        let artifact_candidates = self
            .artifacts
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| {
                let ArtifactAction::Download { source } = &entry.action else {
                    return None;
                };
                Some(CacheArchiveCandidate {
                    handle: ArchiveHandle {
                        kind: ArchiveKind::Artifact,
                        index,
                    },
                    name: entry.vas_storage_name.clone(),
                    version: entry.vas_version_id.clone(),
                    archive_url: source.remote_url()?.to_string(),
                    archive_size: entry.archive_size,
                })
            });
        storage_candidates.chain(artifact_candidates).collect()
    }

    /// Replace one eligible remote archive source with a guest-staged source.
    ///
    /// The handle, entry name, version, and current remote URL must all match. A successful
    /// replacement changes only the action's source and preserves its semantic action. A mismatch
    /// returns `false` without modifying the plan.
    pub(crate) fn stage_archive(
        &mut self,
        handle: ArchiveHandle,
        expected_name: &str,
        expected_version: &str,
        expected_url: &str,
        guest_url: String,
    ) -> bool {
        let (name, version, source) = match handle.kind {
            ArchiveKind::Storage => {
                let Some(entry) = self.storages.get_mut(handle.index) else {
                    return false;
                };
                let source = match &mut entry.action {
                    StorageAction::Download { source } => source,
                    StorageAction::ReuseExisting => return false,
                };
                (&entry.vas_storage_name, &entry.vas_version_id, source)
            }
            ArchiveKind::Artifact => {
                let Some(entry) = self.artifacts.get_mut(handle.index) else {
                    return false;
                };
                let ArtifactAction::Download { source } = &mut entry.action else {
                    return false;
                };
                (&entry.vas_storage_name, &entry.vas_version_id, source)
            }
        };
        if name != expected_name
            || version != expected_version
            || source.remote_url() != Some(expected_url)
        {
            return false;
        }
        *source = ArchiveSource::GuestStaged(guest_url);
        true
    }

    /// Consume the resolved plan into the shared guest execution manifest.
    ///
    /// This conversion encodes the explicit actions as the wire format's archive URL, cached,
    /// empty and cleanup fields. The normal lifecycle calls it after guest-work
    /// detection and cache source resolution; the wire value is transport state, not a second
    /// planning representation.
    pub fn into_guest_manifest(self) -> wire::Manifest {
        wire::Manifest {
            storages: self
                .storages
                .into_iter()
                .map(StoragePlanEntry::into_guest_entry)
                .collect(),
            artifacts: self
                .artifacts
                .into_iter()
                .map(ArtifactPlanEntry::into_guest_entry)
                .collect(),
            cleanup_paths: self.cleanup_paths,
            instruction_cleanups: self
                .instruction_cleanups
                .into_iter()
                .map(|entry| wire::InstructionCleanupEntry {
                    mount_path: entry.mount_path,
                    target_filename: entry.target_filename,
                })
                .collect(),
        }
    }

    #[cfg(test)]
    pub(crate) fn archive_source_url_for_test(&self, handle: ArchiveHandle) -> Option<&str> {
        let source = match handle.kind {
            ArchiveKind::Storage => {
                let entry = self.storages.get(handle.index)?;
                match &entry.action {
                    StorageAction::Download { source } => source,
                    StorageAction::ReuseExisting => return None,
                }
            }
            ArchiveKind::Artifact => {
                let entry = self.artifacts.get(handle.index)?;
                match &entry.action {
                    ArtifactAction::Download { source }
                    | ArtifactAction::ReuseOrRepair { source } => source,
                    ArtifactAction::PrepareEmpty { .. } => return None,
                }
            }
        };
        Some(match source {
            ArchiveSource::Remote(url) | ArchiveSource::GuestStaged(url) => url,
        })
    }
}

fn record_removed_storages<'a>(
    previous: &StorageFingerprints,
    current_paths: impl IntoIterator<Item = &'a str>,
    cleanup_paths: &mut Vec<String>,
    instruction_cleanups: &mut Vec<InstructionCleanup>,
) {
    let current_paths = current_paths.into_iter().collect::<HashSet<_>>();
    for (path, fingerprint) in &previous.storages {
        if current_paths.contains(path.as_str()) {
            continue;
        }
        if is_tainted_framework_home(path, fingerprint) {
            instruction_cleanups.push(InstructionCleanup {
                mount_path: path.clone(),
                target_filename: None,
            });
        } else {
            cleanup_paths.push(path.clone());
        }
    }
}

fn record_removed_artifacts<'a>(
    previous: &StorageFingerprints,
    current_paths: impl IntoIterator<Item = &'a str>,
    cleanup_paths: &mut Vec<String>,
) {
    let current_paths = current_paths.into_iter().collect::<HashSet<_>>();
    for path in previous.artifacts.keys() {
        if !current_paths.contains(path.as_str()) {
            cleanup_paths.push(path.clone());
        }
    }
}

fn is_framework_home_path(path: &str) -> bool {
    matches!(
        path,
        CANONICAL_CLAUDE_CONFIG_DIR | CANONICAL_CODEX_HOME_DIR | PI_AGENT_DIR
    )
}
fn is_tainted_framework_home(path: &str, fingerprint: &StorageFingerprint) -> bool {
    is_framework_home_path(path) && fingerprint.is_tainted()
}

fn missing_root_policy_wire_value(policy: ArtifactEntryMissingRootPolicy) -> String {
    match policy {
        ArtifactEntryMissingRootPolicy::Fail => "fail",
        ArtifactEntryMissingRootPolicy::PreserveParentVersion => "preserveParentVersion",
    }
    .to_string()
}

#[cfg(test)]
mod contract_tests;
#[cfg(test)]
mod tests;
