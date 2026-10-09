use super::entry::is_cache_key_name;
use super::fs::{
    cache_entry_dir_is_dir, entry_file_type_is_dir, is_home_tmp_path_name, measured_entry_bytes,
};
use super::types::{
    CacheBudget, FsStats, HomeImageCacheInspection, HomeImageCacheInspectionEntry,
    HomeImageCacheInspectionStatus, HomeImageCacheInspectionSummary,
};
use super::{HomeImageCache, TemporaryPathStats};
use crate::error::{LifecycleError, LifecycleResult};
use std::path::{Path, PathBuf};
use tokio::fs;

impl HomeImageCache {
    pub async fn inspect(&self) -> LifecycleResult<HomeImageCacheInspection> {
        let stats = self.fs_stats().await?;
        let budget = CacheBudget::from_fs_stats(stats);
        let mut entries = Vec::new();
        let mut reader = match fs::read_dir(self.home_image_cache_dir()).await {
            Ok(reader) => reader,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(self.inspection_from_entries(stats, budget, entries));
            }
            Err(e) => return Err(e.into()),
        };
        while let Some(entry) = reader.next_entry().await? {
            if !entry_file_type_is_dir(&entry).await? {
                continue;
            }
            let Some(key) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !is_cache_key_name(&key) {
                continue;
            }
            if let Some(entry) = self.inspect_entry(key, entry.path()).await? {
                entries.push(entry);
            }
        }
        entries.sort_unstable_by(|a, b| a.cache_key.cmp(&b.cache_key));
        Ok(self.inspection_from_entries(stats, budget, entries))
    }
    fn inspection_from_entries(
        &self,
        stats: FsStats,
        budget: CacheBudget,
        entries: Vec<HomeImageCacheInspectionEntry>,
    ) -> HomeImageCacheInspection {
        let mut summary = HomeImageCacheInspectionSummary {
            total_entries: entries.len(),
            ..Default::default()
        };
        for entry in &entries {
            match entry.status {
                HomeImageCacheInspectionStatus::Reusable => summary.reusable_entries += 1,
                HomeImageCacheInspectionStatus::Invalid => summary.invalid_entries += 1,
                HomeImageCacheInspectionStatus::Stale => summary.stale_entries += 1,
                HomeImageCacheInspectionStatus::TemporaryOnly => summary.temporary_entries += 1,
                HomeImageCacheInspectionStatus::Locked => summary.locked_entries += 1,
            }
            summary.temporary_paths += entry.temporary_path_count;
            summary.total_allocated_bytes = summary
                .total_allocated_bytes
                .saturating_add(entry.allocated_bytes)
                .saturating_add(entry.temporary_allocated_bytes);
            summary.temporary_allocated_bytes = summary
                .temporary_allocated_bytes
                .saturating_add(entry.temporary_allocated_bytes);
            summary.total_logical_image_bytes = summary
                .total_logical_image_bytes
                .saturating_add(entry.logical_image_size_bytes);
        }
        HomeImageCacheInspection {
            cache_dir: self.home_image_cache_dir().display().to_string(),
            lock_dir: self.inner.lock_dir.display().to_string(),
            fs_stats: stats,
            budget,
            summary,
            entries,
        }
    }
    pub(super) async fn inspect_entry(
        &self,
        key: String,
        dir: PathBuf,
    ) -> LifecycleResult<Option<HomeImageCacheInspectionEntry>> {
        let guard = match runner_host::lock::try_acquire_or_busy(self.entry_lock_path(&key)).await {
            Ok(runner_host::lock::TryLock::Acquired(guard)) => guard,
            Ok(runner_host::lock::TryLock::Busy) => {
                return Ok(Some(unavailable_entry(key, "entry lock is held")));
            }
            Err(_) => return Ok(Some(unavailable_entry(key, "entry lock is unavailable"))),
        };
        if !cache_entry_dir_is_dir(&dir).await? {
            return Ok(None);
        }
        let metadata = match self.read_metadata_file(&dir.join("metadata.json")).await {
            Ok(value) => Some(value),
            Err(LifecycleError::Internal(_)) => None,
            Err(LifecycleError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        let paths = self.entry_paths(&key);
        let current = match metadata
            .as_ref()
            .and_then(|m| paths.image(&m.image_generation))
        {
            Some(path) => match fs::symlink_metadata(&path).await {
                Ok(value) => Some(value),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(e.into()),
            },
            None => None,
        };
        let temporary =
            inspect_temporary_paths(&dir, metadata.as_ref().map(|m| m.image_generation.as_str()))
                .await?;
        let total = measured_entry_bytes(&dir).await?;
        let reason = match (&metadata, &current) {
            (Some(metadata), Some(current)) => self
                .unusable_current_entry_reason(&key, metadata, current)
                .map(str::to_owned),
            (Some(_), None) => Some("missing committed generation image".into()),
            (None, _) => Some("missing or invalid canonical metadata".into()),
        };
        let status = if reason.is_none() {
            HomeImageCacheInspectionStatus::Reusable
        } else if metadata.is_none() && temporary.path_count > 0 {
            HomeImageCacheInspectionStatus::TemporaryOnly
        } else {
            HomeImageCacheInspectionStatus::Invalid
        };
        let mut result = unavailable_entry(key, "");
        result.status = status;
        result.reason = reason;
        result.cache_scope = metadata.as_ref().map(|m| m.cache_scope.clone());
        result.profile_name = metadata.as_ref().map(|m| m.profile_name.clone());
        result.rootfs_hash = metadata.as_ref().map(|m| m.rootfs_hash.clone());
        result.working_dir = metadata.as_ref().map(|m| m.working_dir.clone());
        result.last_completed_at = metadata.as_ref().map(|m| m.last_completed_at.clone());
        result.last_used_at = metadata.as_ref().map(|m| m.last_used_at.clone());
        result.last_terminal_status = metadata.as_ref().map(|m| m.last_terminal_status);
        result.allocated_bytes = total.saturating_sub(temporary.allocated_bytes);
        result.logical_image_size_bytes = current.as_ref().map(std::fs::Metadata::len).unwrap_or(0);
        result.temporary_path_count = temporary.path_count;
        result.temporary_allocated_bytes = temporary.allocated_bytes;
        result.storage_count = metadata
            .as_ref()
            .map(|m| m.storage_fingerprints.storages.len())
            .unwrap_or(0);
        result.artifact_count = metadata
            .as_ref()
            .map(|m| m.storage_fingerprints.artifacts.len())
            .unwrap_or(0);
        drop(guard);
        Ok(Some(result))
    }
}
fn unavailable_entry(key: String, reason: &str) -> HomeImageCacheInspectionEntry {
    HomeImageCacheInspectionEntry {
        cache_key: key,
        status: HomeImageCacheInspectionStatus::Locked,
        reason: Some(reason.into()),
        cache_scope: None,
        profile_name: None,
        rootfs_hash: None,
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
    }
}
pub(super) async fn inspect_temporary_paths(
    dir: &Path,
    committed: Option<&str>,
) -> LifecycleResult<TemporaryPathStats> {
    let mut reader = fs::read_dir(dir).await?;
    let mut stats = TemporaryPathStats::default();
    while let Some(entry) = reader.next_entry().await? {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let orphan = super::entry::image_generation(name).is_some_and(|g| committed != Some(g));
        if is_home_tmp_path_name(name) || orphan {
            stats.path_count += 1;
            stats.allocated_bytes = stats
                .allocated_bytes
                .saturating_add(measured_entry_bytes(&entry.path()).await?);
        }
    }
    Ok(stats)
}
