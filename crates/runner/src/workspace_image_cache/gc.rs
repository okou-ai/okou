use std::fs::File;
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::time::{Duration, SystemTime};

use nix::fcntl::Flock;
use tokio::fs;
use tracing::{info, warn};

use crate::error::{RunnerError, RunnerResult};
use runner_types::types::MAX_HELD_WORKSPACE_STATES;

use super::entry::{CacheEntryPaths, is_cache_key_name};
use super::fs::{
    allocated_bytes, cache_entry_dir_is_dir, entry_file_type_is_dir,
    fs_stats_with_additional_available, is_workspace_tmp_path_name,
    remove_workspace_cache_path_if_exists, workspace_cache_path_allocated_bytes,
};
use super::metadata::{
    WorkspaceCacheMetadata, WorkspaceCacheState, WorkspaceTrust, validate_current_image_identity,
};
use super::path_safety::is_safe_guest_working_dir;
use super::types::{CacheBudget, FsStats};
use super::{CACHE_FORMAT_VERSION, WORKSPACE_DRIVE_LAYOUT, WorkspaceImageCache};

pub(super) struct GcCandidate {
    pub(super) cache_key: String,
    pub(super) allocated_bytes: u64,
    file_dev: u64,
    file_ino: u64,
    pub(super) last_used_at: String,
}

struct GcCacheEntry {
    cache_key: String,
    paths: CacheEntryPaths,
}

#[derive(Default)]
struct GcInventory {
    pre_cleanup_freed_bytes: u64,
    candidates: Vec<GcCandidate>,
}

#[derive(Default)]
struct GcEntryInventory {
    pre_cleanup_freed_bytes: u64,
    candidate: Option<GcCandidate>,
}

enum GcWholeEntryReason {
    Stale,
    Unusable(String),
}

impl GcCandidate {
    pub(super) fn same_current_image(&self, other: &Self) -> bool {
        self.file_dev == other.file_dev
            && self.file_ino == other.file_ino
            && self.last_used_at == other.last_used_at
    }
}

pub(super) fn gc_budget_satisfied(
    needs_budget_gc: bool,
    total_cache_bytes: u64,
    entry_count: usize,
    stats_after_pre_cleanup: FsStats,
    budget: CacheBudget,
    candidate_freed_bytes: u64,
) -> bool {
    if entry_count > MAX_HELD_WORKSPACE_STATES {
        return false;
    }
    !needs_budget_gc
        || (total_cache_bytes <= budget.target_after_gc_bytes
            && stats_after_pre_cleanup
                .available_bytes
                .saturating_add(candidate_freed_bytes)
                >= budget.min_free_bytes)
}

impl WorkspaceImageCache {
    pub(crate) async fn gc(&self, dry_run: bool) -> RunnerResult<u64> {
        let _capacity_lock = runner_host::lock::acquire(self.capacity_lock_path()).await?;
        self.gc_locked(dry_run).await
    }

    pub(crate) async fn try_routine_gc(
        &self,
        minimum_interval: Duration,
    ) -> RunnerResult<Option<u64>> {
        let mut capacity_lock =
            match runner_host::lock::try_acquire_or_busy(self.capacity_lock_path()).await? {
                runner_host::lock::TryLock::Acquired(lock) => lock,
                runner_host::lock::TryLock::Busy => return Ok(None),
            };
        // The persistent lock file doubles as an opaque completion marker. Old
        // runners ignore its contents and preserve them when opening the lock.
        let marker = capacity_lock.metadata()?;
        if marker.len() > 0
            && SystemTime::now()
                .duration_since(marker.modified()?)
                .unwrap_or_default()
                < minimum_interval
        {
            return Ok(None);
        }

        #[cfg(test)]
        if let Some((entered, release)) = &self.routine_gc_test_gate {
            entered.notify_one();
            release
                .acquire()
                .await
                .expect("routine GC gate closed")
                .forget();
        }
        let freed_bytes = self.gc_locked(false).await?;
        capacity_lock.write_all(b"\0")?;
        Ok(Some(freed_bytes))
    }

    pub(super) async fn gc_locked(&self, dry_run: bool) -> RunnerResult<u64> {
        let inventory = self.gc_inventory(dry_run).await?;
        let stats = self.fs_stats().await?;
        let pre_cleanup_freed = inventory.pre_cleanup_freed_bytes;
        let stats_after_pre_cleanup = if dry_run {
            fs_stats_with_additional_available(stats, pre_cleanup_freed)
        } else {
            stats
        };
        let budget = CacheBudget::from_fs_stats(stats_after_pre_cleanup);
        let mut candidates = inventory.candidates;
        let mut entry_count = candidates.len();
        let mut total: u64 = candidates
            .iter()
            .map(|candidate| candidate.allocated_bytes)
            .sum();
        let needs_budget_gc = total > budget.max_cache_bytes
            || stats_after_pre_cleanup.available_bytes < budget.min_free_bytes;
        if !needs_budget_gc && entry_count <= MAX_HELD_WORKSPACE_STATES {
            return Ok(pre_cleanup_freed);
        }
        candidates.sort_by(|left, right| {
            left.last_used_at
                .cmp(&right.last_used_at)
                .then_with(|| left.cache_key.cmp(&right.cache_key))
        });
        let mut freed = pre_cleanup_freed;
        let mut candidate_freed: u64 = 0;
        for candidate in candidates {
            if gc_budget_satisfied(
                needs_budget_gc,
                total,
                entry_count,
                stats_after_pre_cleanup,
                budget,
                candidate_freed,
            ) {
                break;
            }
            let Ok(lock) =
                runner_host::lock::try_acquire(self.entry_lock_path(&candidate.cache_key)).await
            else {
                continue;
            };
            let Some(refreshed) = self.gc_candidate(candidate.cache_key.clone()).await else {
                drop(lock);
                continue;
            };
            if !refreshed.same_current_image(&candidate) {
                drop(lock);
                continue;
            }
            if dry_run {
                info!(
                    cache_key = candidate.cache_key,
                    allocated_bytes = refreshed.allocated_bytes,
                    "[dry-run] would delete workspace image cache entry"
                );
            } else if let Err(e) =
                fs::remove_dir_all(self.workspace_image_cache_entry_dir(&candidate.cache_key)).await
            {
                warn!(
                    cache_key = candidate.cache_key,
                    error = %e,
                    "failed to delete workspace image cache entry"
                );
                drop(lock);
                continue;
            } else {
                info!(
                    cache_key = candidate.cache_key,
                    allocated_bytes = refreshed.allocated_bytes,
                    "deleted workspace image cache entry"
                );
            }
            total = total.saturating_sub(refreshed.allocated_bytes);
            entry_count = entry_count.saturating_sub(1);
            freed = freed.saturating_add(refreshed.allocated_bytes);
            candidate_freed = candidate_freed.saturating_add(refreshed.allocated_bytes);
            drop(lock);
        }
        Ok(freed)
    }

    async fn gc_inventory(&self, dry_run: bool) -> RunnerResult<GcInventory> {
        let Some(mut entries) = self.gc_cache_entry_reader().await? else {
            return Ok(GcInventory::default());
        };
        let mut inventory = GcInventory::default();
        while let Some(entry) = Self::next_gc_cache_entry(&mut entries).await? {
            let entry_inventory = match self.try_lock_gc_cache_entry(&entry).await? {
                Some(lock) => {
                    let result = self.gc_locked_cache_entry(&entry, dry_run).await;
                    drop(lock);
                    result?
                }
                None => GcEntryInventory {
                    candidate: self.gc_candidate_for_entry(&entry).await,
                    ..GcEntryInventory::default()
                },
            };
            inventory.pre_cleanup_freed_bytes = inventory
                .pre_cleanup_freed_bytes
                .saturating_add(entry_inventory.pre_cleanup_freed_bytes);
            if let Some(candidate) = entry_inventory.candidate {
                inventory.candidates.push(candidate);
            }
        }
        Ok(inventory)
    }

    async fn gc_locked_cache_entry(
        &self,
        entry: &GcCacheEntry,
        dry_run: bool,
    ) -> RunnerResult<GcEntryInventory> {
        let current = entry.paths.current_image();
        let current_metadata = match fs::symlink_metadata(current).await {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return self
                    .gc_whole_cache_entry(entry, dry_run, GcWholeEntryReason::Stale)
                    .await;
            }
            Err(e) => return Err(e.into()),
        };
        let metadata_path = entry.paths.metadata();
        let metadata = match self.read_metadata_file(metadata_path).await {
            Ok(metadata) => metadata,
            Err(RunnerError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                return self
                    .gc_whole_cache_entry(
                        entry,
                        dry_run,
                        GcWholeEntryReason::Unusable("missing metadata".into()),
                    )
                    .await;
            }
            Err(RunnerError::Internal(_)) => {
                return self
                    .gc_whole_cache_entry(
                        entry,
                        dry_run,
                        GcWholeEntryReason::Unusable("invalid metadata".into()),
                    )
                    .await;
            }
            Err(e) => {
                return self
                    .gc_whole_cache_entry(
                        entry,
                        dry_run,
                        GcWholeEntryReason::Unusable(format!("metadata read failed: {e}")),
                    )
                    .await;
            }
        };
        if let Some(reason) =
            self.unusable_current_entry_reason(&entry.cache_key, &metadata, &current_metadata)
        {
            return self
                .gc_whole_cache_entry(entry, dry_run, GcWholeEntryReason::Unusable(reason.into()))
                .await;
        }

        let pre_cleanup_freed_bytes = self.gc_temporary_paths(entry, dry_run).await?;
        let candidate = self
            .gc_candidate_from_observation(
                entry.cache_key.clone(),
                &entry.paths,
                current_metadata,
                metadata.last_used_at,
            )
            .await;
        Ok(GcEntryInventory {
            pre_cleanup_freed_bytes,
            candidate: Some(candidate),
        })
    }

    async fn gc_whole_cache_entry(
        &self,
        entry: &GcCacheEntry,
        dry_run: bool,
        reason: GcWholeEntryReason,
    ) -> RunnerResult<GcEntryInventory> {
        let allocated = workspace_cache_path_allocated_bytes(entry.paths.entry_dir()).await;
        if dry_run {
            match &reason {
                GcWholeEntryReason::Stale => info!(
                    cache_key = entry.cache_key,
                    allocated_bytes = allocated,
                    "[dry-run] would delete stale workspace image cache entry"
                ),
                GcWholeEntryReason::Unusable(reason) => info!(
                    cache_key = entry.cache_key,
                    reason,
                    allocated_bytes = allocated,
                    "[dry-run] would delete unusable workspace image cache entry"
                ),
            }
            return Ok(GcEntryInventory {
                pre_cleanup_freed_bytes: allocated,
                candidate: None,
            });
        }

        match fs::remove_dir_all(entry.paths.entry_dir()).await {
            Ok(()) => {
                match &reason {
                    GcWholeEntryReason::Stale => info!(
                        cache_key = entry.cache_key,
                        allocated_bytes = allocated,
                        "deleted stale workspace image cache entry"
                    ),
                    GcWholeEntryReason::Unusable(reason) => info!(
                        cache_key = entry.cache_key,
                        reason,
                        allocated_bytes = allocated,
                        "deleted unusable workspace image cache entry"
                    ),
                }
                return Ok(GcEntryInventory {
                    pre_cleanup_freed_bytes: allocated,
                    candidate: None,
                });
            }
            Err(e) => match &reason {
                GcWholeEntryReason::Stale => warn!(
                    cache_key = entry.cache_key,
                    path = %entry.paths.entry_dir().display(),
                    error = %e,
                    "failed to delete stale workspace image cache entry"
                ),
                GcWholeEntryReason::Unusable(reason) => warn!(
                    cache_key = entry.cache_key,
                    reason,
                    path = %entry.paths.entry_dir().display(),
                    error = %e,
                    "failed to delete unusable workspace image cache entry"
                ),
            },
        }

        let pre_cleanup_freed_bytes = self.gc_temporary_paths(entry, false).await?;
        let candidate = self.gc_candidate_for_entry(entry).await;
        Ok(GcEntryInventory {
            pre_cleanup_freed_bytes,
            candidate,
        })
    }

    async fn gc_cache_entry_reader(&self) -> RunnerResult<Option<fs::ReadDir>> {
        #[cfg(test)]
        self.inner
            .gc_root_scan_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root = self.workspace_image_cache_dir().to_path_buf();
        match fs::read_dir(&root).await {
            Ok(entries) => Ok(Some(entries)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    #[cfg(test)]
    pub(super) fn reset_gc_root_scan_count(&self) {
        self.inner
            .gc_root_scan_count
            .store(0, std::sync::atomic::Ordering::Relaxed);
    }

    #[cfg(test)]
    pub(super) fn gc_root_scan_count(&self) -> usize {
        self.inner
            .gc_root_scan_count
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    async fn next_gc_cache_entry(entries: &mut fs::ReadDir) -> RunnerResult<Option<GcCacheEntry>> {
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
            return Ok(Some(GcCacheEntry {
                cache_key,
                paths: CacheEntryPaths::from_entry_dir(entry.path()),
            }));
        }
        Ok(None)
    }

    async fn try_lock_gc_cache_entry(
        &self,
        entry: &GcCacheEntry,
    ) -> RunnerResult<Option<Flock<File>>> {
        let Ok(lock) = runner_host::lock::try_acquire(self.entry_lock_path(&entry.cache_key)).await
        else {
            return Ok(None);
        };
        if !cache_entry_dir_is_dir(entry.paths.entry_dir()).await? {
            return Ok(None);
        }
        Ok(Some(lock))
    }

    pub(super) fn unusable_current_entry_reason(
        &self,
        cache_key: &str,
        metadata: &WorkspaceCacheMetadata,
        current_metadata: &std::fs::Metadata,
    ) -> Option<&'static str> {
        if metadata.format_version != CACHE_FORMAT_VERSION {
            return Some("metadata format version mismatch");
        }
        if metadata.drive_layout != WORKSPACE_DRIVE_LAYOUT {
            return Some("drive layout mismatch");
        }
        if metadata.state != WorkspaceCacheState::Current
            || metadata.workspace_trust != WorkspaceTrust::Clean
        {
            return Some("metadata is not reusable");
        }
        if !is_safe_guest_working_dir(&metadata.working_dir) {
            return Some("unsafe working dir");
        }
        if !current_metadata.is_file() {
            return Some("current image is not a file");
        }
        if !self.metadata_matches_cache_key(cache_key, metadata) {
            return Some("cache key mismatch");
        }
        if validate_current_image_identity(metadata, current_metadata).is_err() {
            return Some("current image identity mismatch");
        }
        None
    }

    async fn gc_temporary_paths(&self, entry: &GcCacheEntry, dry_run: bool) -> RunnerResult<u64> {
        let mut freed: u64 = 0;
        let mut files = match fs::read_dir(entry.paths.entry_dir()).await {
            Ok(files) => files,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e.into()),
        };
        while let Some(file) = files.next_entry().await? {
            let file_name = file.file_name();
            let Some(file_name) = file_name.to_str() else {
                continue;
            };
            if !is_workspace_tmp_path_name(file_name) {
                continue;
            }
            let path = file.path();
            let allocated = workspace_cache_path_allocated_bytes(&path).await;
            if dry_run {
                info!(
                    cache_key = entry.cache_key,
                    path = %path.display(),
                    allocated_bytes = allocated,
                    "[dry-run] would delete temporary workspace image cache path"
                );
            } else {
                match remove_workspace_cache_path_if_exists(&path).await {
                    Ok(true) => info!(
                        cache_key = entry.cache_key,
                        path = %path.display(),
                        allocated_bytes = allocated,
                        "deleted temporary workspace image cache path"
                    ),
                    Ok(false) => continue,
                    Err(e) => {
                        warn!(
                            cache_key = entry.cache_key,
                            path = %path.display(),
                            error = %e,
                            "failed to delete temporary workspace image cache path"
                        );
                        continue;
                    }
                }
            }
            freed = freed.saturating_add(allocated);
        }
        Ok(freed)
    }

    #[cfg(test)]
    pub(super) async fn gc_candidates(&self) -> RunnerResult<Vec<GcCandidate>> {
        let Some(mut entries) = self.gc_cache_entry_reader().await? else {
            return Ok(Vec::new());
        };
        let mut candidates = Vec::new();
        while let Some(entry) = Self::next_gc_cache_entry(&mut entries).await? {
            let Some(candidate) = self.gc_candidate_for_entry(&entry).await else {
                continue;
            };
            candidates.push(candidate);
        }
        Ok(candidates)
    }

    async fn gc_candidate_from_observation(
        &self,
        cache_key: String,
        paths: &CacheEntryPaths,
        file_metadata: std::fs::Metadata,
        last_used_at: String,
    ) -> GcCandidate {
        let sidecar_allocated = self.session_history_sidecar_allocated_bytes(paths).await;
        GcCandidate {
            cache_key,
            allocated_bytes: allocated_bytes(&file_metadata).saturating_add(sidecar_allocated),
            file_dev: file_metadata.dev(),
            file_ino: file_metadata.ino(),
            last_used_at,
        }
    }

    async fn gc_candidate_for_entry(&self, entry: &GcCacheEntry) -> Option<GcCandidate> {
        if !cache_entry_dir_is_dir(entry.paths.entry_dir()).await.ok()? {
            return None;
        }
        let file_metadata = fs::symlink_metadata(entry.paths.current_image())
            .await
            .ok()?;
        if !file_metadata.is_file() {
            return None;
        }
        let last_used_at = match self.read_metadata_file(entry.paths.metadata()).await {
            Ok(metadata) => metadata.last_used_at,
            Err(_) if self.inner.cache_scope.is_empty() => String::new(),
            Err(_) => return None,
        };
        Some(
            self.gc_candidate_from_observation(
                entry.cache_key.clone(),
                &entry.paths,
                file_metadata,
                last_used_at,
            )
            .await,
        )
    }

    pub(super) async fn gc_candidate(&self, cache_key: String) -> Option<GcCandidate> {
        let entry = GcCacheEntry {
            paths: self.entry_paths(&cache_key),
            cache_key,
        };
        self.gc_candidate_for_entry(&entry).await
    }
}
