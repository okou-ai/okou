use std::path::{Path, PathBuf};

use tokio::fs;

use crate::error::{LifecycleError, LifecycleResult};

use super::entry::is_cache_key_name;
use super::fs::{
    allocated_bytes, cache_entry_dir_is_dir, entry_file_type_is_dir, is_workspace_tmp_path_name,
    workspace_cache_existing_path_allocated_bytes, workspace_cache_path_allocated_bytes,
};
use super::metadata::WorkspaceCacheMetadata;
use super::types::{
    CacheBudget, FsStats, WorkspaceImageCacheInspection, WorkspaceImageCacheInspectionEntry,
    WorkspaceImageCacheInspectionStatus, WorkspaceImageCacheInspectionSummary,
};
use super::{TemporaryPathStats, WorkspaceImageCache};

impl WorkspaceImageCache {
    pub async fn inspect(&self) -> LifecycleResult<WorkspaceImageCacheInspection> {
        let fs_stats = self.fs_stats().await?;
        let budget = CacheBudget::from_fs_stats(fs_stats);
        let root = self.workspace_image_cache_dir().to_path_buf();
        let mut entries = match fs::read_dir(&root).await {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(self.inspection_from_entries(fs_stats, budget, Vec::new()));
            }
            Err(e) => return Err(e.into()),
        };
        let mut inspection_entries = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            if !entry_file_type_is_dir(&entry).await? {
                continue;
            }
            let Some(cache_key) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !is_cache_key_name(&cache_key) {
                continue;
            }
            if let Some(entry) = self.inspect_entry(cache_key, entry.path()).await? {
                inspection_entries.push(entry);
            }
        }
        inspection_entries.sort_unstable_by(|left, right| left.cache_key.cmp(&right.cache_key));
        Ok(self.inspection_from_entries(fs_stats, budget, inspection_entries))
    }

    fn inspection_from_entries(
        &self,
        fs_stats: FsStats,
        budget: CacheBudget,
        entries: Vec<WorkspaceImageCacheInspectionEntry>,
    ) -> WorkspaceImageCacheInspection {
        let mut summary = WorkspaceImageCacheInspectionSummary {
            total_entries: entries.len(),
            ..WorkspaceImageCacheInspectionSummary::default()
        };
        for entry in &entries {
            match entry.status {
                WorkspaceImageCacheInspectionStatus::Reusable => summary.reusable_entries += 1,
                WorkspaceImageCacheInspectionStatus::Invalid => summary.invalid_entries += 1,
                WorkspaceImageCacheInspectionStatus::Stale => summary.stale_entries += 1,
                WorkspaceImageCacheInspectionStatus::TemporaryOnly => {
                    summary.temporary_entries += 1;
                }
                WorkspaceImageCacheInspectionStatus::Locked => summary.locked_entries += 1,
            }
            summary.temporary_paths += entry.temporary_path_count;
            summary.total_allocated_bytes = summary
                .total_allocated_bytes
                .saturating_add(entry.allocated_bytes)
                .saturating_add(entry.temporary_allocated_bytes);
            summary.total_logical_image_bytes = summary
                .total_logical_image_bytes
                .saturating_add(entry.logical_image_size_bytes);
            summary.temporary_allocated_bytes = summary
                .temporary_allocated_bytes
                .saturating_add(entry.temporary_allocated_bytes);
        }
        WorkspaceImageCacheInspection {
            cache_dir: self.workspace_image_cache_dir().display().to_string(),
            lock_dir: self.inner.lock_dir.display().to_string(),
            fs_stats,
            budget,
            summary,
            entries,
        }
    }

    pub(super) async fn inspect_entry(
        &self,
        cache_key: String,
        entry_dir: PathBuf,
    ) -> LifecycleResult<Option<WorkspaceImageCacheInspectionEntry>> {
        let lock =
            match runner_host::lock::try_acquire_or_busy(self.entry_lock_path(&cache_key)).await? {
                runner_host::lock::TryLock::Acquired(lock) => lock,
                runner_host::lock::TryLock::Busy => {
                    return Ok(Some(WorkspaceImageCacheInspectionEntry {
                        cache_key,
                        status: WorkspaceImageCacheInspectionStatus::Locked,
                        reason: Some("entry lock is held".into()),
                        cache_scope: None,
                        profile_name: None,
                        working_dir: None,
                        last_completed_at: None,
                        last_used_at: None,
                        last_terminal_status: None,
                        allocated_bytes: 0,
                        logical_image_size_bytes: 0,
                        temporary_path_count: 0,
                        temporary_allocated_bytes: 0,
                        storage_count: 0,
                        artifact_count: 0,
                    }));
                }
            };
        let entry_paths = super::entry::CacheEntryPaths::from_entry_dir(entry_dir);
        if !cache_entry_dir_is_dir(entry_paths.entry_dir()).await? {
            drop(lock);
            return Ok(None);
        }
        let temporary = inspect_temporary_paths(entry_paths.entry_dir()).await?;

        let current = entry_paths.current_image();
        let current_metadata = match fs::symlink_metadata(current).await {
            Ok(metadata) => Some(metadata),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                drop(lock);
                return Err(e.into());
            }
        };
        let metadata_path = entry_paths.metadata();
        let (metadata, metadata_read_error) = match self.read_metadata_file(metadata_path).await {
            Ok(metadata) => (Some(metadata), None),
            Err(LifecycleError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => (None, None),
            Err(LifecycleError::Internal(_)) => (None, None),
            Err(e) => (None, Some(e.to_string())),
        };
        let current_allocated_bytes = match current_metadata.as_ref() {
            Some(metadata) if metadata.is_dir() => {
                workspace_cache_path_allocated_bytes(current).await
            }
            Some(metadata) => allocated_bytes(metadata),
            None => 0,
        };
        let persistent_allocated_bytes = current_allocated_bytes.saturating_add(
            self.session_history_sidecar_allocated_bytes(&entry_paths)
                .await,
        );

        let entry = match (current_metadata, metadata) {
            (None, metadata) => {
                let status = if temporary.path_count > 0 {
                    WorkspaceImageCacheInspectionStatus::TemporaryOnly
                } else {
                    WorkspaceImageCacheInspectionStatus::Stale
                };
                let reason = if temporary.path_count > 0 {
                    "missing current image; temporary paths present"
                } else {
                    "missing current image"
                };
                workspace_image_cache_inspection_entry(
                    cache_key,
                    status,
                    Some(reason.into()),
                    metadata.as_ref(),
                    None,
                    persistent_allocated_bytes,
                    temporary,
                )
            }
            (Some(current_metadata), None) => {
                let reason = metadata_read_error
                    .map(|error| format!("metadata read failed: {error}"))
                    .unwrap_or_else(|| "missing or invalid metadata".into());
                workspace_image_cache_inspection_entry(
                    cache_key,
                    WorkspaceImageCacheInspectionStatus::Invalid,
                    Some(reason),
                    None,
                    Some(&current_metadata),
                    persistent_allocated_bytes,
                    temporary,
                )
            }
            (Some(current_metadata), Some(metadata)) => {
                let reason = self
                    .unusable_current_entry_reason(&cache_key, &metadata, &current_metadata)
                    .map(str::to_owned);
                let status = if reason.is_some() {
                    WorkspaceImageCacheInspectionStatus::Invalid
                } else {
                    WorkspaceImageCacheInspectionStatus::Reusable
                };
                workspace_image_cache_inspection_entry(
                    cache_key,
                    status,
                    reason,
                    Some(&metadata),
                    Some(&current_metadata),
                    persistent_allocated_bytes,
                    temporary,
                )
            }
        };
        drop(lock);
        Ok(Some(entry))
    }
}

pub(super) fn workspace_image_cache_inspection_entry(
    cache_key: String,
    status: WorkspaceImageCacheInspectionStatus,
    reason: Option<String>,
    metadata: Option<&WorkspaceCacheMetadata>,
    current_metadata: Option<&std::fs::Metadata>,
    current_allocated_bytes: u64,
    temporary: TemporaryPathStats,
) -> WorkspaceImageCacheInspectionEntry {
    let logical_image_size_bytes = current_metadata.map(std::fs::Metadata::len).unwrap_or(0);
    WorkspaceImageCacheInspectionEntry {
        cache_key,
        status,
        reason,
        cache_scope: metadata.map(|metadata| metadata.cache_scope.clone()),
        profile_name: metadata.map(|metadata| metadata.profile_name.clone()),
        working_dir: metadata.map(|metadata| metadata.working_dir.clone()),
        last_completed_at: metadata.map(|metadata| metadata.last_completed_at.clone()),
        last_used_at: metadata.map(|metadata| metadata.last_used_at.clone()),
        last_terminal_status: metadata.map(|metadata| metadata.last_terminal_status),
        allocated_bytes: current_allocated_bytes,
        logical_image_size_bytes,
        temporary_path_count: temporary.path_count,
        temporary_allocated_bytes: temporary.allocated_bytes,
        storage_count: metadata
            .map(|metadata| metadata.storage_fingerprints.storages.len())
            .unwrap_or(0),
        artifact_count: metadata
            .map(|metadata| metadata.storage_fingerprints.artifacts.len())
            .unwrap_or(0),
    }
}

pub(super) async fn inspect_temporary_paths(
    entry_dir: &Path,
) -> LifecycleResult<TemporaryPathStats> {
    let mut files = match fs::read_dir(entry_dir).await {
        Ok(files) => files,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TemporaryPathStats::default());
        }
        Err(e) => return Err(e.into()),
    };
    let mut stats = TemporaryPathStats::default();
    while let Some(file) = files.next_entry().await? {
        let file_name = file.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if !is_workspace_tmp_path_name(file_name) {
            continue;
        }
        let path = file.path();
        let Some(allocated) = workspace_cache_existing_path_allocated_bytes(&path).await? else {
            continue;
        };
        stats.path_count += 1;
        stats.allocated_bytes = stats.allocated_bytes.saturating_add(allocated);
    }
    Ok(stats)
}
