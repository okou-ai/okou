use std::fs::File;
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

use nix::fcntl::Flock;
use tokio::fs;
use tracing::{info, warn};

use crate::error::{LifecycleError, LifecycleResult};
use runner_host::home_observation::{
    HomeObservation, HomeObservationKind, HomeObservationLocalDetails, HomeObservationOutcome,
};
use runner_types::types::MAX_HELD_HOME_STATES;

use super::HomeImageCache;
use super::entry::{CacheEntryPaths, is_cache_key_name};
use super::fs::{
    cache_entry_dir_is_dir, entry_file_type_is_dir, is_home_tmp_path_name,
    remove_home_cache_path_if_exists,
};
use super::gc_metadata::read_gc_metadata_file;
use super::gc_pressure::{GcContinuation, GcTarget, HomeCacheReclaimStatus};
use super::io_context::with_path;

/// An identity/LRU observation; only selected victims need allocation accounting.
pub(super) struct GcCandidate {
    pub(super) cache_key: String,
    pub(super) image_generation: String,
    pub(super) prospective_cleanup_bytes: u64,
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

#[cfg(test)]
#[derive(Clone)]
pub(super) struct GcInventoryTestGate {
    after_entries: usize,
    armed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    entered: std::sync::Arc<tokio::sync::Notify>,
    release: std::sync::Arc<tokio::sync::Semaphore>,
}

fn routine_gc_is_due(
    completion_marker: &File,
    minimum_interval: Duration,
) -> std::io::Result<bool> {
    // The canonical file records successful maintenance across current processes.
    let marker = completion_marker.metadata()?;
    Ok(marker.len() == 0
        || SystemTime::now()
            .duration_since(marker.modified()?)
            .unwrap_or_default()
            >= minimum_interval)
}

impl GcCandidate {
    fn from_observation(
        cache_key: String,
        file_metadata: std::fs::Metadata,
        last_used_at: String,
        image_generation: String,
    ) -> Self {
        Self {
            cache_key,
            image_generation,
            prospective_cleanup_bytes: 0,
            file_dev: file_metadata.dev(),
            file_ino: file_metadata.ino(),
            last_used_at,
        }
    }

    pub(super) fn same_current_image(&self, other: &Self) -> bool {
        self.file_dev == other.file_dev
            && self.file_ino == other.file_ino
            && self.image_generation == other.image_generation
            && self.last_used_at == other.last_used_at
    }
}

fn removal_observation(
    key: &str,
    generation: Option<&str>,
    allocated: u64,
    outcome: HomeObservationOutcome,
    reason: &str,
) -> HomeObservation {
    let mut observation = HomeObservation::new(HomeObservationKind::Removal, outcome);
    observation.cache_key = Some(key.to_owned());
    observation.image_generation = generation.map(str::to_owned);
    observation.allocated_bytes = Some(allocated);
    observation.reason = Some(reason.to_owned());
    observation
}

impl HomeImageCache {
    pub(super) fn observe_removal(
        &self,
        key: &str,
        generation: Option<&str>,
        allocated: u64,
        outcome: HomeObservationOutcome,
        reason: &str,
    ) {
        self.observe_home(removal_observation(
            key, generation, allocated, outcome, reason,
        ));
    }

    #[cfg(any(test, feature = "test-support"))]
    pub(super) async fn total_cache_allocated_bytes(&self) -> LifecycleResult<u64> {
        super::fs::measured_entry_bytes(self.home_image_cache_dir()).await
    }

    pub async fn gc(&self, dry_run: bool) -> LifecycleResult<u64> {
        self.accept_collection(dry_run, 0).await.map_err(|error| {
            crate::error::LifecycleError::Internal(format!("home collection task failed: {error}"))
        })?
    }

    fn accept_collection(
        &self,
        dry_run: bool,
        additional_peak_bytes: u64,
    ) -> tokio::task::JoinHandle<LifecycleResult<u64>> {
        let cache = self.clone();
        self.inner.checkout_io.spawn(async move {
            let result = cache
                .collect_home_cache(dry_run, additional_peak_bytes)
                .await;
            if let Err(error) = &result {
                tracing::warn!(%error, dry_run, "accepted home cache collection failed");
            }
            result
        })
    }

    async fn collect_home_cache(
        &self,
        dry_run: bool,
        additional_peak_bytes: u64,
    ) -> LifecycleResult<u64> {
        let _routine =
            match runner_host::lock::try_acquire_or_busy(self.routine_gc_lock_path()).await? {
                runner_host::lock::TryLock::Acquired(lock) => lock,
                runner_host::lock::TryLock::Busy => return Ok(0),
            };
        self.gc_locked(dry_run, additional_peak_bytes).await
    }

    async fn routine_gc_completion_marker(&self) -> LifecycleResult<File> {
        // Keep the canonical path for current processes' size/mtime cadence.
        // The caller owns the routine singleton; this file needs no flock.
        let path = self.routine_gc_marker_path();
        tokio::task::spawn_blocking(move || runner_host::lock::open_lock_file(&path))
            .await
            .map_err(|error| {
                crate::error::LifecycleError::Internal(format!("open home GC marker: {error}"))
            })?
            .map_err(Into::into)
    }

    pub async fn try_routine_gc(&self, minimum_interval: Duration) -> LifecycleResult<Option<u64>> {
        if !self.background_gc.is_active() {
            return Ok(None);
        }
        let mut routine_lock =
            match runner_host::lock::try_acquire_or_busy(self.routine_gc_lock_path()).await? {
                runner_host::lock::TryLock::Acquired(lock) => lock,
                runner_host::lock::TryLock::Busy => return Ok(None),
            };
        let mut completion_marker = self.routine_gc_completion_marker().await?;
        if !routine_gc_is_due(&completion_marker, minimum_interval)? {
            return Ok(None);
        }

        #[cfg(any(test, feature = "test-support"))]
        if let Some((entered, release)) = &self.routine_gc_test_gate {
            entered.notify_one();
            release
                .acquire()
                .await
                .expect("routine GC gate closed")
                .forget();
        }
        let inventory_started = Instant::now();
        let inventory = self
            .gc_inventory(false, || self.background_gc.is_active())
            .await?;
        if !self.background_gc.is_active() {
            return Ok(None);
        }
        let inventory_duration = inventory_started.elapsed();
        let entry_count = inventory.candidates.len();
        let mut freed_bytes = inventory.pre_cleanup_freed_bytes;
        let mut continuation = GcContinuation::new(inventory.candidates, 0);

        // No entry lock survives inventory. Revalidate every candidate under
        // its entry owner before evicting an observation publication can replace.
        let stats = self.fs_stats().await?;
        let pressure = self.pressure_thresholds(stats);
        let budget_gc = entry_count > MAX_HELD_HOME_STATES
            || (pressure.reserve_feasible && stats.available_bytes < pressure.low_free_bytes);
        if budget_gc {
            let required = (pressure.reserve_feasible
                && stats.available_bytes < pressure.low_free_bytes)
                .then_some(pressure.high_free_bytes);
            let reason = if required.is_some() {
                "filesystem_pressure"
            } else {
                "entry_count"
            };
            loop {
                #[cfg(any(test, feature = "test-support"))]
                if let Some(gate) = &self.pressure_turn_test_gate {
                    gate.enter_and_wait().await;
                }
                // Inventory remains a hint. Every mutation revalidates current
                // generation/inode/last-use after try-only entry acquisition.
                let outcome = self
                    .reclaim_gc_turn(
                        &mut continuation,
                        || {
                            if self.background_gc.is_active() {
                                required.map_or(GcTarget::CountOnly, GcTarget::FreeBytes)
                            } else {
                                GcTarget::Inactive
                            }
                        },
                        false,
                        reason,
                    )
                    .await?;
                if outcome.status == HomeCacheReclaimStatus::BackgroundStopped {
                    return Ok(None);
                }
                freed_bytes = freed_bytes.saturating_add(outcome.removed_allocated_bytes);
                info!(reason, status = ?outcome.status,
                    available_before = outcome.available_before, available_after = outcome.available_after,
                    victim_attempts = outcome.victim_attempts, "home cache routine reclaim turn completed");
                if outcome.status != HomeCacheReclaimStatus::BudgetExhausted {
                    break;
                }
                drop(completion_marker);
                drop(routine_lock);
                #[cfg(any(test, feature = "test-support"))]
                if let Some(gate) = &self.pressure_turn_test_gate {
                    gate.enter_and_wait().await;
                }
                tokio::task::yield_now().await;
                if !self.background_gc.is_active() {
                    return Ok(None);
                }
                routine_lock =
                    match runner_host::lock::try_acquire_or_busy(self.routine_gc_lock_path())
                        .await?
                    {
                        runner_host::lock::TryLock::Acquired(lock) => lock,
                        runner_host::lock::TryLock::Busy => return Ok(None),
                    };
                completion_marker = self.routine_gc_completion_marker().await?;
                if !routine_gc_is_due(&completion_marker, minimum_interval)? {
                    return Ok(None);
                }
            }
        }
        if !self.background_gc.is_active() {
            return Ok(None);
        }
        completion_marker.write_all(b"\0")?;
        info!(
            entry_count,
            inventory_us = inventory_duration.as_micros() as u64,
            budget_gc,
            freed_bytes,
            "home image cache routine GC completed"
        );
        Ok(Some(freed_bytes))
    }

    #[cfg(test)]
    pub(super) fn with_gc_inventory_test_gate(
        mut self,
        after_entries: usize,
        entered: std::sync::Arc<tokio::sync::Notify>,
        release: std::sync::Arc<tokio::sync::Semaphore>,
    ) -> Self {
        self.gc_inventory_test_gate = Some(GcInventoryTestGate {
            after_entries,
            armed: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
            entered,
            release,
        });
        self
    }

    pub(super) async fn gc_locked(
        &self,
        dry_run: bool,
        additional_peak_bytes: u64,
    ) -> LifecycleResult<u64> {
        let inventory = self.gc_inventory(dry_run, || true).await?;
        let stats = self.fs_stats().await?;
        let pressure = self.pressure_thresholds(stats);
        let prospective = if dry_run {
            inventory.pre_cleanup_freed_bytes
        } else {
            0
        };
        // Preview the trigger after prospective cleanup too. Live decisions
        // still use only actual stats queried after physical cleanup.
        let decision_available = stats
            .available_bytes
            .saturating_add(prospective)
            .min(stats.total_bytes);
        let required = if additional_peak_bytes > 0 {
            Some(pressure.reserve_bytes.saturating_add(additional_peak_bytes))
        } else if pressure.reserve_feasible && decision_available < pressure.low_free_bytes {
            Some(pressure.high_free_bytes)
        } else {
            None
        };
        let reason = if additional_peak_bytes > 0 {
            "foreground_demand"
        } else if required.is_some() {
            "filesystem_pressure"
        } else {
            "entry_count"
        };
        let mut continuation = GcContinuation::new(inventory.candidates, prospective);
        let mut removed = inventory.pre_cleanup_freed_bytes;
        loop {
            let outcome = self
                .reclaim_gc_turn(
                    &mut continuation,
                    || required.map_or(GcTarget::CountOnly, GcTarget::FreeBytes),
                    dry_run,
                    reason,
                )
                .await?;
            removed = removed.saturating_add(outcome.removed_allocated_bytes);
            if required.is_some() || outcome.victim_attempts > 0 {
                tracing::info!(reason, status = ?outcome.status, dry_run,
                    available_before = outcome.available_before, available_after = outcome.available_after,
                    victim_attempts = outcome.victim_attempts, "home cache reclaim turn completed");
            }
            if outcome.status != HomeCacheReclaimStatus::BudgetExhausted {
                return Ok(removed);
            }
            // Manual/publication collectors retain the singleton. Never cancel
            // accepted physical deletion.
            tokio::task::yield_now().await;
        }
    }

    #[cfg(test)]
    async fn pause_gc_inventory_for_test(&self, entries_seen: usize) {
        if let Some(gate) = &self.gc_inventory_test_gate
            && entries_seen == gate.after_entries
            && gate.armed.swap(false, std::sync::atomic::Ordering::Relaxed)
        {
            gate.entered.notify_one();
            gate.release
                .acquire()
                .await
                .expect("GC inventory gate closed")
                .forget();
        }
    }

    async fn gc_inventory(
        &self,
        dry_run: bool,
        active: impl Fn() -> bool,
    ) -> LifecycleResult<GcInventory> {
        if !active() {
            return Ok(GcInventory::default());
        }
        let Some(mut entries) = self.gc_cache_entry_reader().await? else {
            return Ok(GcInventory::default());
        };
        let mut inventory = GcInventory::default();
        #[cfg(test)]
        let mut entries_seen = 0;
        while let Some(entry) =
            Self::next_gc_cache_entry(&mut entries, self.home_image_cache_dir()).await?
        {
            if !active() {
                break;
            }
            let entry_inventory = match self.try_lock_gc_cache_entry(&entry).await? {
                Some(lock) => {
                    if !active() {
                        break;
                    }
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
            if let Some(mut candidate) = entry_inventory.candidate {
                if dry_run {
                    candidate.prospective_cleanup_bytes = entry_inventory.pre_cleanup_freed_bytes;
                }
                inventory.candidates.push(candidate);
            }
            #[cfg(test)]
            {
                entries_seen += 1;
                self.pause_gc_inventory_for_test(entries_seen).await;
            }
        }
        Ok(inventory)
    }

    async fn gc_locked_cache_entry(
        &self,
        entry: &GcCacheEntry,
        dry_run: bool,
    ) -> LifecycleResult<GcEntryInventory> {
        let metadata = match read_gc_metadata_file(&entry.paths.metadata()).await {
            Ok(metadata) => metadata,
            Err(LifecycleError::Internal(error)) => {
                return self
                    .gc_whole_cache_entry(entry, dry_run, GcWholeEntryReason::Unusable(error), None)
                    .await;
            }
            Err(LifecycleError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                return self
                    .gc_whole_cache_entry(entry, dry_run, GcWholeEntryReason::Stale, None)
                    .await;
            }
            Err(error) => return Err(error),
        };
        let Some(current) = entry.paths.image(&metadata.image_generation) else {
            return self
                .gc_whole_cache_entry(
                    entry,
                    dry_run,
                    GcWholeEntryReason::Stale,
                    Some(&metadata.image_generation),
                )
                .await;
        };
        let current_metadata = match fs::symlink_metadata(&current).await {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return self
                    .gc_whole_cache_entry(
                        entry,
                        dry_run,
                        GcWholeEntryReason::Stale,
                        Some(&metadata.image_generation),
                    )
                    .await;
            }
            Err(e) => return Err(with_path(e, "symlink_metadata", &current).into()),
        };
        if let Err(error) = metadata.validate_current_image(&current_metadata) {
            return self
                .gc_whole_cache_entry(
                    entry,
                    dry_run,
                    GcWholeEntryReason::Unusable(error.to_string()),
                    Some(&metadata.image_generation),
                )
                .await;
        }

        let pre_cleanup_freed_bytes = self
            .gc_temporary_paths(entry, dry_run, Some(&metadata.image_generation))
            .await?;
        let candidate = GcCandidate::from_observation(
            entry.cache_key.clone(),
            current_metadata,
            metadata.last_used_at,
            metadata.image_generation,
        );
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
        image_generation: Option<&str>,
    ) -> LifecycleResult<GcEntryInventory> {
        let allocated = super::fs::measured_entry_bytes(entry.paths.entry_dir()).await?;
        if dry_run {
            match &reason {
                GcWholeEntryReason::Stale => info!(
                    cache_key = entry.cache_key,
                    allocated_bytes = allocated,
                    "[dry-run] would delete stale home image cache entry"
                ),
                GcWholeEntryReason::Unusable(reason) => info!(
                    cache_key = entry.cache_key,
                    reason,
                    allocated_bytes = allocated,
                    "[dry-run] would delete unusable home image cache entry"
                ),
            }
            return Ok(GcEntryInventory {
                pre_cleanup_freed_bytes: allocated,
                candidate: None,
            });
        }

        match fs::remove_dir_all(entry.paths.entry_dir()).await {
            Ok(()) => {
                self.observe_home_with_local_details(
                    removal_observation(
                        &entry.cache_key,
                        image_generation,
                        allocated,
                        HomeObservationOutcome::Deleted,
                        match &reason {
                            GcWholeEntryReason::Stale => "stale_entry",
                            GcWholeEntryReason::Unusable(_) => "unusable_entry",
                        },
                    ),
                    HomeObservationLocalDetails {
                        detail: match &reason {
                            GcWholeEntryReason::Stale => None,
                            GcWholeEntryReason::Unusable(reason) => Some(reason),
                        },
                        path: None,
                    },
                );
                return Ok(GcEntryInventory {
                    pre_cleanup_freed_bytes: allocated,
                    candidate: None,
                });
            }
            Err(e) => {
                self.observe_removal(
                    &entry.cache_key,
                    image_generation,
                    allocated,
                    HomeObservationOutcome::Failed,
                    match &reason {
                        GcWholeEntryReason::Stale => "stale_entry",
                        GcWholeEntryReason::Unusable(_) => "unusable_entry",
                    },
                );
                match &reason {
                    GcWholeEntryReason::Stale => warn!(
                        cache_key = entry.cache_key,
                        path = %entry.paths.entry_dir().display(),
                        error = %e,
                        "failed to delete stale home image cache entry"
                    ),
                    GcWholeEntryReason::Unusable(reason) => warn!(
                        cache_key = entry.cache_key,
                        reason,
                        path = %entry.paths.entry_dir().display(),
                        error = %e,
                        "failed to delete unusable home image cache entry"
                    ),
                }
            }
        }

        let pre_cleanup_freed_bytes = self.gc_temporary_paths(entry, false, None).await?;
        let candidate = self.gc_candidate_for_entry(entry).await;
        Ok(GcEntryInventory {
            pre_cleanup_freed_bytes,
            candidate,
        })
    }

    async fn gc_cache_entry_reader(&self) -> LifecycleResult<Option<fs::ReadDir>> {
        #[cfg(any(test, feature = "test-support"))]
        self.inner
            .gc_root_scan_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root = self.home_image_cache_dir().to_path_buf();
        match fs::read_dir(&root).await {
            Ok(entries) => Ok(Some(entries)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(with_path(e, "read_dir", &root).into()),
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    pub(super) fn reset_gc_root_scan_count(&self) {
        self.inner
            .gc_root_scan_count
            .store(0, std::sync::atomic::Ordering::Relaxed);
    }

    #[cfg(any(test, feature = "test-support"))]
    pub(super) fn gc_root_scan_count(&self) -> usize {
        self.inner
            .gc_root_scan_count
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    async fn next_gc_cache_entry(
        entries: &mut fs::ReadDir,
        root: &Path,
    ) -> LifecycleResult<Option<GcCacheEntry>> {
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| with_path(error, "ReadDir::next_entry", root))?
        {
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
    ) -> LifecycleResult<Option<Flock<File>>> {
        let Ok(lock) = runner_host::lock::try_acquire(self.entry_lock_path(&entry.cache_key)).await
        else {
            return Ok(None);
        };
        if !cache_entry_dir_is_dir(entry.paths.entry_dir()).await? {
            return Ok(None);
        }
        Ok(Some(lock))
    }

    async fn gc_temporary_paths(
        &self,
        entry: &GcCacheEntry,
        dry_run: bool,
        committed_generation: Option<&str>,
    ) -> LifecycleResult<u64> {
        let mut freed: u64 = 0;
        let mut files = match fs::read_dir(entry.paths.entry_dir()).await {
            Ok(files) => files,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(with_path(e, "read_dir", entry.paths.entry_dir()).into()),
        };
        while let Some(file) = files
            .next_entry()
            .await
            .map_err(|error| with_path(error, "ReadDir::next_entry", entry.paths.entry_dir()))?
        {
            let file_name = file.file_name();
            let Some(file_name) = file_name.to_str() else {
                continue;
            };
            // The caller read this commit once under the entry lock. Without
            // a known generation, clean staging paths and retain image files.
            let orphan = committed_generation.is_some_and(|committed| {
                super::entry::image_generation(file_name).is_some_and(|g| g != committed)
            });
            if !is_home_tmp_path_name(file_name) && !orphan {
                continue;
            }
            let path = file.path();
            let allocated = super::fs::measured_entry_bytes(&path).await?;
            if dry_run {
                info!(
                    cache_key = entry.cache_key,
                    path = %path.display(),
                    allocated_bytes = allocated,
                    "[dry-run] would delete temporary home image cache path"
                );
            } else {
                match remove_home_cache_path_if_exists(&path).await {
                    Ok(true) => {
                        self.observe_home_with_local_details(
                            removal_observation(
                                &entry.cache_key,
                                super::entry::image_generation(file_name),
                                allocated,
                                HomeObservationOutcome::Deleted,
                                if orphan {
                                    "orphan_generation"
                                } else {
                                    "temporary_path"
                                },
                            ),
                            HomeObservationLocalDetails {
                                detail: None,
                                path: Some(&path),
                            },
                        );
                    }
                    Ok(false) => continue,
                    Err(e) => {
                        warn!(
                            cache_key = entry.cache_key,
                            path = %path.display(),
                            error = %e,
                            "failed to delete temporary home image cache path"
                        );
                        self.observe_removal(
                            &entry.cache_key,
                            super::entry::image_generation(file_name),
                            allocated,
                            HomeObservationOutcome::Failed,
                            if orphan {
                                "orphan_generation"
                            } else {
                                "temporary_path"
                            },
                        );
                        continue;
                    }
                }
            }
            freed = freed.saturating_add(allocated);
        }
        Ok(freed)
    }

    pub(super) async fn gc_candidates(
        &self,
        active: impl Fn() -> bool,
    ) -> LifecycleResult<Option<Vec<GcCandidate>>> {
        if !active() {
            return Ok(None);
        }
        let Some(mut entries) = self.gc_cache_entry_reader().await? else {
            return Ok(Some(Vec::new()));
        };
        let mut candidates = Vec::new();
        #[cfg(test)]
        let mut entries_seen = 0;
        while let Some(entry) =
            Self::next_gc_cache_entry(&mut entries, self.home_image_cache_dir()).await?
        {
            if !active() {
                #[cfg(test)]
                if let Some(gate) = &self.pressure_inventory_stopped_test_gate {
                    gate.enter_and_wait().await;
                }
                return Ok(None);
            }
            if let Some(candidate) = self.gc_candidate_for_entry(&entry).await {
                candidates.push(candidate);
            }
            #[cfg(test)]
            {
                entries_seen += 1;
                self.pause_gc_inventory_for_test(entries_seen).await;
            }
        }
        Ok(Some(candidates))
    }

    async fn gc_candidate_for_entry(&self, entry: &GcCacheEntry) -> Option<GcCandidate> {
        if !cache_entry_dir_is_dir(entry.paths.entry_dir()).await.ok()? {
            return None;
        }
        let metadata = read_gc_metadata_file(&entry.paths.metadata()).await.ok()?;
        let image = entry.paths.image(&metadata.image_generation)?;
        let file_metadata = fs::symlink_metadata(&image).await.ok()?;
        if metadata.validate_current_image(&file_metadata).is_err() {
            return None;
        }
        Some(GcCandidate::from_observation(
            entry.cache_key.clone(),
            file_metadata,
            metadata.last_used_at,
            metadata.image_generation,
        ))
    }

    pub(super) async fn gc_candidate(&self, cache_key: String) -> Option<GcCandidate> {
        let entry = GcCacheEntry {
            paths: self.entry_paths(&cache_key),
            cache_key,
        };
        self.gc_candidate_for_entry(&entry).await
    }
}
