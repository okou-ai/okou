use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use nix::fcntl::Flock;
use tokio::fs;
use tracing::{info, warn};

use crate::duration::duration_ms;
use crate::error::{RunnerError, RunnerResult};
use crate::storage_fingerprints::StorageFingerprints;
use runner_types::ids::RunId;
use runner_types::types::{
    HeldWorkspaceState, MAX_HELD_WORKSPACE_STATES, MAX_WORKSPACE_CACHES_PER_HEARTBEAT,
    MAX_WORKSPACE_CACHES_PER_REUSE_KEY, WORKSPACE_AFFINITY_VERSION, WorkspaceCacheCapability,
};

use super::entry::is_cache_key_name;
use super::fs::{
    allocated_bytes, has_copy_headroom, local_timestamp,
    remove_non_directory_workspace_cache_entry, remove_workspace_cache_path_if_exists,
    secure_workspace_cache_publication_file, sparse_copy,
};
use super::metadata::{
    WorkspaceCacheMetadata, WorkspaceCacheScopeClassification,
    WorkspaceCacheState as WorkspaceCacheEntryState, WorkspaceImageFileIdentity, WorkspaceTrust,
};
use super::path_safety::{
    filter_storage_fingerprints_for_working_dir, is_safe_guest_working_dir,
    normalize_safe_guest_working_dir,
};
use super::types::{
    CacheBudget, WorkspaceCacheCheckoutResult, WorkspaceCacheLockDecision, WorkspaceCacheLockOwner,
    WorkspaceCacheTerminalStatus, WorkspaceImageActiveLeaseRequest, WorkspaceImageLeaseIdentity,
    WorkspaceImagePrepareLockPolicy, WorkspaceImagePrepareRequest, WorkspaceImagePromotionIdentity,
    WorkspaceImagePromotionIdentityMismatch, WorkspaceImagePromotionIdentityRequest,
    WorkspaceImagePromotionRequest, WorkspaceSessionHistorySidecar,
    WorkspaceSessionHistorySidecarMiss, WorkspaceSessionHistorySidecarPromotionSource,
    WorkspaceSessionHistorySidecarPublication,
};
use super::{
    CACHE_FORMAT_VERSION, WORKSPACE_DRIVE_LAYOUT, WorkspaceCacheLockRegistration,
    WorkspaceImageCache, WorkspaceImageCacheInner,
};

const WORKSPACE_IMAGE_PREPARE_LOCK_TIMEOUT: Duration = Duration::from_millis(50);

pub(crate) struct WorkspaceImageLease {
    cache: WorkspaceImageCache,
    pub(super) cache_key: Option<String>,
    profile_name: String,
    reuse_key: Option<String>,
    working_dir: String,
    active_image: PathBuf,
    pub(super) source_image: Option<PathBuf>,
    pub(super) consumed_cache_hit: bool,
    image_size_bytes: u64,
    workspace_drive_enabled: bool,
    result: WorkspaceCacheCheckoutResult,
    previous_storage: Option<StorageFingerprints>,
    entry_lock: Option<WorkspaceEntryLock>,
    lock_decision: Option<WorkspaceCacheLockDecision>,
}

pub(crate) struct WorkspaceImagePromotionContext {
    cache: WorkspaceImageCache,
    cache_key: String,
    entry_lock: Option<WorkspaceEntryLock>,
    run_id: RunId,
    sandbox_id: sandbox::SandboxId,
    profile_name: String,
    reuse_key: String,
    working_dir: String,
    active_image: PathBuf,
    image_size_bytes: u64,
    consumed_cache_hit: bool,
    terminal_status: WorkspaceCacheTerminalStatus,
    completed_at: String,
    storage_fingerprints: StorageFingerprints,
    restored_session_identity: Option<crate::restored_session_identity::RestoredSessionIdentity>,
}

pub(crate) struct WorkspaceSessionHistorySidecarEntryGuard {
    cache: WorkspaceImageCache,
    cache_key: String,
    run_id: RunId,
    restored_session_identity: crate::restored_session_identity::RestoredSessionIdentity,
    _late_entry_lock: Option<WorkspaceEntryLock>,
}

pub(crate) struct WorkspaceImagePromotionIdentityFailure {
    pub(crate) promotion: WorkspaceImagePromotionContext,
    pub(crate) mismatch: WorkspaceImagePromotionIdentityMismatch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkspaceImagePromotionOutcome {
    Promoted,
    PreservedExisting,
    SkippedUnpublished,
}

struct WorkspaceImagePromotionInput<'a> {
    run_id: RunId,
    cache_key: &'a str,
    profile_name: &'a str,
    reuse_key: &'a str,
    working_dir: &'a str,
    active_image: &'a Path,
    image_size_bytes: u64,
    terminal_status: WorkspaceCacheTerminalStatus,
    completed_at: &'a str,
    storage_fingerprints: &'a StorageFingerprints,
    session_history_sidecar: WorkspaceSessionHistorySidecarPublication<'a>,
}

struct WorkspaceImagePromotionTarget {
    cache_key: String,
    reuse_key: String,
}

struct WorkspaceImageLeaseCommon<'a> {
    run_id: RunId,
    profile_name: &'a str,
    reuse_key: Option<&'a str>,
    raw_working_dir: &'a str,
    normalized_working_dir: Option<String>,
    active_image: PathBuf,
    image_size_bytes: u64,
}

struct WorkspaceImageLeaseBase {
    cache: WorkspaceImageCache,
    profile_name: String,
    reuse_key: Option<String>,
    working_dir: String,
    active_image: PathBuf,
    image_size_bytes: u64,
}

struct WorkspaceImageLeaseState {
    cache_key: Option<String>,
    source_image: Option<PathBuf>,
    consumed_cache_hit: bool,
    previous_storage: Option<StorageFingerprints>,
    entry_lock: Option<WorkspaceEntryLock>,
    workspace_drive_enabled: bool,
    result: WorkspaceCacheCheckoutResult,
    lock_decision: Option<WorkspaceCacheLockDecision>,
}

/// Couples a locally provable lifecycle phase to the flock that establishes ownership.
///
/// Separate cache instances and processes do not share the registry, so their busy locks remain
/// explicitly `unknown` rather than being inferred from other runner state.
struct WorkspaceEntryLock {
    inner: Arc<WorkspaceImageCacheInner>,
    cache_key: String,
    identity: Arc<()>,
    lock: Option<Flock<std::fs::File>>,
}

impl WorkspaceEntryLock {
    fn new(
        cache: &WorkspaceImageCache,
        cache_key: &str,
        lock: Flock<std::fs::File>,
        owner: WorkspaceCacheLockOwner,
    ) -> Self {
        let identity = Arc::new(());
        let mut owners = cache
            .inner
            .entry_lock_owners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let registration = owners.entry(cache_key.to_owned());
        assert!(
            matches!(&registration, std::collections::hash_map::Entry::Vacant(_)),
            "workspace entry lock acquired while a local owner remains registered"
        );
        if let std::collections::hash_map::Entry::Vacant(registration) = registration {
            registration.insert(WorkspaceCacheLockRegistration {
                identity: Arc::clone(&identity),
                owner,
            });
        }
        drop(owners);
        Self {
            inner: Arc::clone(&cache.inner),
            cache_key: cache_key.to_owned(),
            identity,
            lock: Some(lock),
        }
    }

    fn set_owner(&mut self, owner: WorkspaceCacheLockOwner) {
        let mut owners = self
            .inner
            .entry_lock_owners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let registered = owners.get_mut(&self.cache_key);
        assert!(
            registered
                .as_ref()
                .is_some_and(|registered| Arc::ptr_eq(&registered.identity, &self.identity)),
            "workspace entry lock ownership transition requires the original registration"
        );
        if let Some(registered) = registered {
            registered.owner = owner;
        }
    }
}

impl Drop for WorkspaceEntryLock {
    fn drop(&mut self) {
        let mut owners = self
            .inner
            .entry_lock_owners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let owns_registration = owners
            .get(&self.cache_key)
            .is_some_and(|registered| Arc::ptr_eq(&registered.identity, &self.identity));
        debug_assert!(owns_registration);
        if owns_registration {
            owners.remove(&self.cache_key);
        }
        drop(owners);
        drop(self.lock.take());
    }
}

fn workspace_image_size_mb(image_size_bytes: u64) -> u32 {
    let mib = 1024 * 1024;
    image_size_bytes.div_ceil(mib).min(u64::from(u32::MAX)) as u32
}

impl<'a> WorkspaceImageLeaseCommon<'a> {
    fn new(cache: &WorkspaceImageCache, identity: WorkspaceImageLeaseIdentity<'a>) -> Self {
        Self {
            run_id: identity.run_id,
            profile_name: identity.profile_name,
            reuse_key: identity.reuse_key,
            raw_working_dir: identity.working_dir,
            normalized_working_dir: normalize_safe_guest_working_dir(identity.working_dir),
            active_image: cache.paths().active_workspace_image(&identity.sandbox_id),
            image_size_bytes: identity.image_size_bytes,
        }
    }

    fn safe_working_dir(&self) -> Option<&str> {
        self.normalized_working_dir.as_deref()
    }

    fn lease_working_dir(&self) -> &str {
        self.safe_working_dir().unwrap_or(self.raw_working_dir)
    }

    fn cache_key(&self, cache: &WorkspaceImageCache, reuse_key: &str, working_dir: &str) -> String {
        cache.scoped_cache_key(
            self.profile_name,
            reuse_key,
            working_dir,
            self.image_size_bytes,
        )
    }

    fn lease_base(&self, cache: &WorkspaceImageCache) -> WorkspaceImageLeaseBase {
        WorkspaceImageLeaseBase {
            cache: cache.clone(),
            profile_name: self.profile_name.to_owned(),
            reuse_key: self.reuse_key.map(str::to_owned),
            working_dir: self.lease_working_dir().to_owned(),
            active_image: self.active_image.clone(),
            image_size_bytes: self.image_size_bytes,
        }
    }
}

impl WorkspaceImageLease {
    fn from_parts(base: WorkspaceImageLeaseBase, state: WorkspaceImageLeaseState) -> Self {
        Self {
            cache: base.cache,
            cache_key: state.cache_key,
            profile_name: base.profile_name,
            reuse_key: base.reuse_key,
            working_dir: base.working_dir,
            active_image: base.active_image,
            source_image: state.source_image,
            consumed_cache_hit: state.consumed_cache_hit,
            image_size_bytes: base.image_size_bytes,
            workspace_drive_enabled: state.workspace_drive_enabled,
            result: state.result,
            previous_storage: state.previous_storage,
            entry_lock: state.entry_lock,
            lock_decision: state.lock_decision,
        }
    }
}

impl WorkspaceImageCache {
    fn local_entry_lock_observation(
        &self,
        cache_key: &str,
    ) -> Option<WorkspaceCacheLockRegistration> {
        self.inner
            .entry_lock_owners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(cache_key)
            .cloned()
    }

    fn stable_local_entry_lock_owner(
        &self,
        cache_key: &str,
        before: Option<&WorkspaceCacheLockRegistration>,
    ) -> WorkspaceCacheLockOwner {
        let after = self.local_entry_lock_observation(cache_key);
        match (before, after) {
            (Some(before), Some(after)) if Arc::ptr_eq(&before.identity, &after.identity) => {
                after.owner
            }
            _ => WorkspaceCacheLockOwner::Unknown,
        }
    }

    async fn acquire_prepare_lock(
        &self,
        lock_path: PathBuf,
        lock_policy: WorkspaceImagePrepareLockPolicy,
    ) -> RunnerResult<runner_host::lock::TryLock> {
        if lock_policy == WorkspaceImagePrepareLockPolicy::ImmediateFallback {
            return Ok(runner_host::lock::try_acquire_or_busy(lock_path).await?);
        }

        #[cfg(test)]
        if let Some(gate) = &self.prepare_lock_test_gate {
            match runner_host::lock::try_acquire_or_busy(lock_path.clone()).await? {
                runner_host::lock::TryLock::Acquired(lock) => {
                    return Ok(runner_host::lock::TryLock::Acquired(lock));
                }
                runner_host::lock::TryLock::Busy => gate.enter_and_wait().await,
            }
        }

        Ok(runner_host::lock::acquire_with_contention_timeout(
            lock_path,
            WORKSPACE_IMAGE_PREPARE_LOCK_TIMEOUT,
        )
        .await?)
    }

    pub(crate) fn expected_promotion_identity(
        &self,
        request: WorkspaceImagePromotionIdentityRequest<'_>,
    ) -> Result<WorkspaceImagePromotionIdentity, WorkspaceImagePromotionIdentityMismatch> {
        let Some(working_dir) = normalize_safe_guest_working_dir(request.working_dir) else {
            return Err(WorkspaceImagePromotionIdentityMismatch::UnsafeWorkingDir);
        };
        let cache_key = self.scoped_cache_key(
            request.profile_name,
            request.reuse_key,
            &working_dir,
            request.image_size_bytes,
        );

        Ok(WorkspaceImagePromotionIdentity {
            sandbox_id: request.sandbox_id,
            profile_name: request.profile_name.to_owned(),
            reuse_key: request.reuse_key.to_owned(),
            working_dir,
            image_size_bytes: request.image_size_bytes,
            active_image: self.paths().active_workspace_image(&request.sandbox_id),
            cache_key,
        })
    }

    pub(crate) async fn lease_active(
        &self,
        request: WorkspaceImageActiveLeaseRequest<'_>,
    ) -> WorkspaceImageLease {
        let common = WorkspaceImageLeaseCommon::new(self, request.identity);
        let active_lease = |result, entry_lock, cache_key, lock_decision| {
            WorkspaceImageLease::from_parts(
                common.lease_base(self),
                WorkspaceImageLeaseState {
                    cache_key,
                    source_image: None,
                    consumed_cache_hit: false,
                    previous_storage: None,
                    entry_lock,
                    workspace_drive_enabled: request.workspace_drive_available,
                    result,
                    lock_decision,
                },
            )
        };

        let Some(working_dir) = common.safe_working_dir() else {
            warn!(
                run_id = %common.run_id,
                working_dir = %common.raw_working_dir,
                "workspace image cache active lease disabled for unsafe working directory"
            );
            return active_lease(
                WorkspaceCacheCheckoutResult::InvalidWorkingDir,
                None,
                None,
                None,
            );
        };
        let Some(reuse_key) = common.reuse_key else {
            return active_lease(WorkspaceCacheCheckoutResult::NoReuseKey, None, None, None);
        };

        let cache_key = common.cache_key(self, reuse_key, working_dir);
        let owner_before = self.local_entry_lock_observation(&cache_key);
        match runner_host::lock::try_acquire_or_busy(self.entry_lock_path(&cache_key)).await {
            Ok(runner_host::lock::TryLock::Acquired(lock)) => active_lease(
                WorkspaceCacheCheckoutResult::Miss,
                Some(WorkspaceEntryLock::new(
                    self,
                    &cache_key,
                    lock,
                    WorkspaceCacheLockOwner::Active,
                )),
                Some(cache_key),
                None,
            ),
            Ok(runner_host::lock::TryLock::Busy) => {
                let owner = self.stable_local_entry_lock_owner(&cache_key, owner_before.as_ref());
                info!(
                    run_id = %common.run_id,
                    cache_key,
                    owner = owner.as_str(),
                    "workspace image cache active lease lock busy; promotion disabled"
                );
                active_lease(
                    WorkspaceCacheCheckoutResult::LockBusy,
                    None,
                    None,
                    Some(WorkspaceCacheLockDecision::Busy(owner)),
                )
            }
            Err(e) => {
                info!(
                    run_id = %common.run_id,
                    cache_key,
                    error = %e,
                    "workspace image cache active lease lock unavailable; promotion disabled"
                );
                active_lease(
                    WorkspaceCacheCheckoutResult::LockBusy,
                    None,
                    None,
                    Some(WorkspaceCacheLockDecision::Unavailable),
                )
            }
        }
    }

    pub(crate) async fn prepare(
        &self,
        request: WorkspaceImagePrepareRequest<'_>,
    ) -> WorkspaceImageLease {
        self.prepare_with_lock_policy(
            request,
            WorkspaceImagePrepareLockPolicy::WaitForTransientContention,
        )
        .await
    }

    pub(crate) async fn prepare_with_lock_policy(
        &self,
        request: WorkspaceImagePrepareRequest<'_>,
        lock_policy: WorkspaceImagePrepareLockPolicy,
    ) -> WorkspaceImageLease {
        let common = WorkspaceImageLeaseCommon::new(self, request.identity);
        let workspace_drive = |result,
                               source_image: Option<PathBuf>,
                               previous_storage: Option<StorageFingerprints>,
                               entry_lock,
                               cache_key,
                               workspace_drive_enabled,
                               lock_decision| {
            let consumed_cache_hit =
                result == WorkspaceCacheCheckoutResult::Hit && source_image.is_some();
            WorkspaceImageLease::from_parts(
                common.lease_base(self),
                WorkspaceImageLeaseState {
                    cache_key,
                    source_image,
                    consumed_cache_hit,
                    previous_storage,
                    entry_lock,
                    workspace_drive_enabled,
                    result,
                    lock_decision,
                },
            )
        };

        let Some(working_dir) = common.safe_working_dir() else {
            warn!(
                run_id = %common.run_id,
                working_dir = %common.raw_working_dir,
                "workspace image cache disabled for unsafe working directory"
            );
            return workspace_drive(
                WorkspaceCacheCheckoutResult::InvalidWorkingDir,
                None,
                None,
                None,
                None,
                request.workspace_drive_required,
                None,
            );
        };
        let Some(reuse_key) = common.reuse_key else {
            return workspace_drive(
                WorkspaceCacheCheckoutResult::NoReuseKey,
                None,
                None,
                None,
                None,
                true,
                None,
            );
        };
        let Ok(mut stats) = self.fs_stats().await else {
            warn!(
                run_id = %common.run_id,
                "workspace image cache disabled because filesystem stats are unavailable"
            );
            return workspace_drive(
                WorkspaceCacheCheckoutResult::DiskPressure,
                None,
                None,
                None,
                None,
                true,
                None,
            );
        };
        let mut budget = CacheBudget::from_fs_stats(stats);
        if stats.available_bytes < budget.min_free_bytes {
            match self.gc(false).await {
                Ok(freed) if freed > 0 => match self.fs_stats().await {
                    Ok(updated) => {
                        stats = updated;
                        budget = CacheBudget::from_fs_stats(stats);
                    }
                    Err(e) => warn!(
                        run_id = %common.run_id,
                        error = %e,
                        "workspace image cache stats refresh failed after GC"
                    ),
                },
                Ok(_) => {}
                Err(e) => warn!(
                    run_id = %common.run_id,
                    error = %e,
                    "workspace image cache GC failed before checkout"
                ),
            }
        }
        if stats.available_bytes < budget.min_free_bytes {
            info!(
                run_id = %common.run_id,
                available_bytes = stats.available_bytes,
                min_free_bytes = budget.min_free_bytes,
                "workspace image cache skipped due to free-space pressure"
            );
            return workspace_drive(
                WorkspaceCacheCheckoutResult::DiskPressure,
                None,
                None,
                None,
                None,
                true,
                None,
            );
        }

        let cache_key = common.cache_key(self, reuse_key, working_dir);
        let lock_path = self.entry_lock_path(&cache_key);
        let owner_before = self.local_entry_lock_observation(&cache_key);
        let lock = match self.acquire_prepare_lock(lock_path, lock_policy).await {
            Ok(runner_host::lock::TryLock::Acquired(lock)) => lock,
            Ok(runner_host::lock::TryLock::Busy) => {
                let owner = self.stable_local_entry_lock_owner(&cache_key, owner_before.as_ref());
                match lock_policy {
                    WorkspaceImagePrepareLockPolicy::WaitForTransientContention => info!(
                        run_id = %common.run_id,
                        cache_key,
                        owner = owner.as_str(),
                        wait_ms = duration_ms(WORKSPACE_IMAGE_PREPARE_LOCK_TIMEOUT),
                        "workspace image cache lock remained busy; using fresh workspace image"
                    ),
                    WorkspaceImagePrepareLockPolicy::ImmediateFallback => info!(
                        run_id = %common.run_id,
                        cache_key,
                        owner = owner.as_str(),
                        wait_ms = 0,
                        "workspace image cache lock busy without retry; using fresh workspace image"
                    ),
                }
                return workspace_drive(
                    WorkspaceCacheCheckoutResult::LockBusy,
                    None,
                    None,
                    None,
                    None,
                    true,
                    Some(WorkspaceCacheLockDecision::Busy(owner)),
                );
            }
            Err(e) => {
                info!(
                    run_id = %common.run_id,
                    cache_key,
                    error = %e,
                    "workspace image cache lock unavailable; using fresh workspace image"
                );
                return workspace_drive(
                    WorkspaceCacheCheckoutResult::LockBusy,
                    None,
                    None,
                    None,
                    None,
                    true,
                    Some(WorkspaceCacheLockDecision::Unavailable),
                );
            }
        };
        let lock = WorkspaceEntryLock::new(self, &cache_key, lock, WorkspaceCacheLockOwner::Active);

        let entry_dir = self.workspace_image_cache_entry_dir(&cache_key);
        match remove_non_directory_workspace_cache_entry(&entry_dir).await {
            Ok(true) => {
                info!(
                    run_id = %common.run_id,
                    cache_key,
                    path = %entry_dir.display(),
                    "removed non-directory workspace image cache entry before checkout"
                );
                return workspace_drive(
                    WorkspaceCacheCheckoutResult::Miss,
                    None,
                    None,
                    Some(lock),
                    Some(cache_key),
                    true,
                    None,
                );
            }
            Ok(false) => {}
            Err(e) => {
                warn!(
                    run_id = %common.run_id,
                    cache_key,
                    path = %entry_dir.display(),
                    error = %e,
                    "failed to remove non-directory workspace image cache entry before checkout"
                );
                return workspace_drive(
                    WorkspaceCacheCheckoutResult::InvalidMetadata,
                    None,
                    None,
                    Some(lock),
                    Some(cache_key),
                    true,
                    None,
                );
            }
        }

        let metadata_path = self.workspace_image_cache_metadata(&cache_key);
        let current_path = self.workspace_image_cache_current_image(&cache_key);
        let hit = match self
            .read_valid_metadata(
                &metadata_path,
                common.profile_name,
                reuse_key,
                working_dir,
                common.image_size_bytes,
            )
            .await
        {
            Ok(Some(metadata)) => {
                let previous = metadata.storage_fingerprints.clone();
                match fs::remove_file(&metadata_path).await {
                    Ok(()) => {
                        info!(
                            run_id = %common.run_id,
                            cache_key,
                            "workspace image cache hit checked out with move seed"
                        );
                    }
                    Err(e) => {
                        warn!(
                            run_id = %common.run_id,
                            cache_key,
                            error = %e,
                            "failed to remove workspace image cache metadata before move checkout; using fresh workspace image"
                        );
                        return workspace_drive(
                            WorkspaceCacheCheckoutResult::Miss,
                            None,
                            None,
                            Some(lock),
                            Some(cache_key),
                            true,
                            None,
                        );
                    }
                }
                Some((current_path, previous))
            }
            Ok(None) => None,
            Err(e) => {
                warn!(
                    run_id = %common.run_id,
                    cache_key,
                    error = %e,
                    "workspace image cache metadata invalid; using fresh workspace image"
                );
                let entry_dir = self.workspace_image_cache_entry_dir(&cache_key);
                match fs::remove_dir_all(&entry_dir).await {
                    Ok(()) => {
                        info!(
                            run_id = %common.run_id,
                            cache_key,
                            "removed invalid workspace image cache entry before fresh checkout"
                        );
                        return workspace_drive(
                            WorkspaceCacheCheckoutResult::Miss,
                            None,
                            None,
                            Some(lock),
                            Some(cache_key),
                            true,
                            None,
                        );
                    }
                    Err(remove_error) if remove_error.kind() == std::io::ErrorKind::NotFound => {
                        return workspace_drive(
                            WorkspaceCacheCheckoutResult::Miss,
                            None,
                            None,
                            Some(lock),
                            Some(cache_key),
                            true,
                            None,
                        );
                    }
                    Err(remove_error) => {
                        warn!(
                            run_id = %common.run_id,
                            cache_key,
                            error = %remove_error,
                            "failed to remove invalid workspace image cache entry"
                        );
                    }
                }
                return workspace_drive(
                    WorkspaceCacheCheckoutResult::InvalidMetadata,
                    None,
                    None,
                    Some(lock),
                    Some(cache_key),
                    true,
                    None,
                );
            }
        };

        match hit {
            Some((source, previous)) => workspace_drive(
                WorkspaceCacheCheckoutResult::Hit,
                Some(source),
                Some(previous),
                Some(lock),
                Some(cache_key),
                true,
                None,
            ),
            None => workspace_drive(
                WorkspaceCacheCheckoutResult::Miss,
                None,
                None,
                Some(lock),
                Some(cache_key),
                true,
                None,
            ),
        }
    }

    pub(crate) async fn held_workspace_states_for_profiles(
        &self,
        profile_image_sizes_bytes: &BTreeMap<&str, u64>,
    ) -> Vec<HeldWorkspaceState> {
        self.held_workspace_states_matching_profiles(Some(profile_image_sizes_bytes), None, false)
            .await
            .states
    }

    /// Performs the startup scan and returns the loaded and locked cache keys
    /// needed to connect subscribe-before-scan watcher state.
    pub(crate) async fn initial_held_workspace_states_for_profiles(
        &self,
        profile_image_sizes_bytes: &BTreeMap<&str, u64>,
    ) -> (Vec<HeldWorkspaceState>, BTreeSet<String>, BTreeSet<String>) {
        let scan = self
            .held_workspace_states_matching_profiles(Some(profile_image_sizes_bytes), None, true)
            .await;
        // The heartbeat projection omits cache keys, but startup needs the
        // deterministic keys for the watcher handoff before publishing it.
        let loaded_cache_keys = scan
            .states
            .iter()
            .flat_map(|state| {
                state.workspace_caches.iter().filter_map(|workspace| {
                    profile_image_sizes_bytes
                        .get(workspace.profile.as_str())
                        .map(|image_size_bytes| {
                            self.scoped_cache_key(
                                &workspace.profile,
                                &state.reuse_key,
                                CANONICAL_WORKING_DIR,
                                *image_size_bytes,
                            )
                        })
                })
            })
            .collect();
        (scan.states, scan.locked_commit_keys, loaded_cache_keys)
    }

    /// Waits for metadata-commit entry locks before performing the complete scan.
    ///
    /// The event-provided keys select locks only. Each hinted entry is validated
    /// under its acquired guard with the same rules as the complete scan, and
    /// the validated observation is merged into that scan's bounded result.
    pub(crate) async fn held_workspace_states_for_profiles_after_commits(
        &self,
        profile_image_sizes_bytes: &BTreeMap<&str, u64>,
        committed_cache_keys: &BTreeSet<String>,
        deadline: tokio::time::Instant,
    ) -> Vec<HeldWorkspaceState> {
        self.held_workspace_states_matching_profiles(
            Some(profile_image_sizes_bytes),
            Some((committed_cache_keys, deadline)),
            false,
        )
        .await
        .states
    }

    /// Inspect cache state without a running profile configuration in tests.
    #[cfg(test)]
    pub(crate) async fn held_workspace_states(&self) -> Vec<HeldWorkspaceState> {
        self.held_workspace_states_matching_profiles(None, None, false)
            .await
            .states
    }

    async fn held_workspace_states_matching_profiles(
        &self,
        profile_image_sizes_bytes: Option<&BTreeMap<&str, u64>>,
        committed_cache_keys: Option<(&BTreeSet<String>, tokio::time::Instant)>,
        collect_locked_commits: bool,
    ) -> HeldWorkspaceStateScan {
        let mut states = Vec::new();
        let mut validated_cache_keys = BTreeSet::new();
        if let Some((committed_cache_keys, deadline)) = committed_cache_keys {
            for cache_key in committed_cache_keys {
                if !is_cache_key_name(cache_key) {
                    continue;
                }
                let lock = match tokio::time::timeout_at(
                    deadline,
                    runner_host::lock::acquire(self.entry_lock_path(cache_key)),
                )
                .await
                {
                    Ok(Ok(lock)) => lock,
                    Ok(Err(_)) => continue,
                    Err(_) => {
                        info!(
                            commit_keys = committed_cache_keys.len(),
                            "workspace cache commit lock wait timed out"
                        );
                        break;
                    }
                };
                if let Some(state) = self
                    .publishable_held_workspace_state(cache_key, profile_image_sizes_bytes, &lock)
                    .await
                {
                    states.push(state);
                    validated_cache_keys.insert(cache_key.clone());
                }
                drop(lock);
            }
        }

        let mut locked_commit_keys = BTreeSet::new();
        #[cfg(test)]
        self.inner
            .held_state_root_scan_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        #[cfg(test)]
        self.inner.held_state_root_scan_notify.notify_waiters();
        let root = self.workspace_image_cache_dir().to_path_buf();
        let mut entries = match fs::read_dir(&root).await {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return HeldWorkspaceStateScan {
                    states: cap_held_workspace_states(states),
                    locked_commit_keys,
                };
            }
            Err(e) => {
                warn!(error = %e, "failed to scan workspace image cache");
                return HeldWorkspaceStateScan {
                    states: cap_held_workspace_states(states),
                    locked_commit_keys,
                };
            }
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let Ok(file_type) = entry.file_type().await else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let Some(cache_key) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !is_cache_key_name(cache_key) {
                continue;
            }
            if validated_cache_keys.contains(cache_key) {
                continue;
            }
            let lock = match runner_host::lock::try_acquire_or_busy(self.entry_lock_path(cache_key))
                .await
            {
                Ok(runner_host::lock::TryLock::Acquired(lock)) => lock,
                Ok(runner_host::lock::TryLock::Busy) => {
                    if collect_locked_commits
                        && locked_commit_keys.len() < MAX_HELD_WORKSPACE_STATES
                    {
                        let metadata_path = self.workspace_image_cache_metadata(cache_key);
                        if self
                            .classify_metadata_scope(cache_key, &metadata_path)
                            .await
                            == WorkspaceCacheScopeClassification::Relevant
                        {
                            locked_commit_keys.insert(cache_key.to_owned());
                        }
                    }
                    continue;
                }
                Err(_) => continue,
            };
            if let Some(state) = self
                .publishable_held_workspace_state(cache_key, profile_image_sizes_bytes, &lock)
                .await
            {
                states.push(state);
            }
            drop(lock);
        }
        let observed_workspace_caches = states
            .iter()
            .map(|state| state.workspace_caches.len())
            .sum::<usize>();
        let states = cap_held_workspace_states(states);
        let retained_workspace_caches = states
            .iter()
            .map(|state| state.workspace_caches.len())
            .sum::<usize>();
        if retained_workspace_caches < observed_workspace_caches {
            info!(
                observed_workspace_caches,
                retained_workspace_states = states.len(),
                retained_workspace_caches,
                "workspace cache state truncated"
            );
        }
        HeldWorkspaceStateScan {
            states,
            locked_commit_keys,
        }
    }

    #[cfg(test)]
    pub(crate) fn reset_held_state_root_scan_count(&self) {
        self.inner
            .held_state_root_scan_count
            .store(0, std::sync::atomic::Ordering::Relaxed);
    }

    #[cfg(test)]
    pub(crate) fn held_state_root_scan_count(&self) -> usize {
        self.inner
            .held_state_root_scan_count
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    #[cfg(test)]
    pub(crate) async fn wait_for_held_state_root_scan_after(
        &self,
        previous_count: usize,
        timeout: Duration,
    ) -> usize {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.inner.held_state_root_scan_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            let count = self.held_state_root_scan_count();
            if count > previous_count {
                return count;
            }

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            assert!(
                !remaining.is_zero(),
                "workspace cache did not start a held-state root scan within {timeout:?}"
            );
            tokio::time::timeout(remaining, notified)
                .await
                .unwrap_or_else(|_| {
                    panic!(
                        "workspace cache did not start a held-state root scan within {timeout:?}"
                    )
                });
        }
    }

    async fn publishable_held_workspace_state(
        &self,
        cache_key: &str,
        profile_image_sizes_bytes: Option<&BTreeMap<&str, u64>>,
        _lock: &Flock<std::fs::File>,
    ) -> Option<HeldWorkspaceState> {
        let metadata = self
            .read_metadata_file(&self.workspace_image_cache_metadata(cache_key))
            .await
            .ok()?;
        self.metadata_is_publishable_held_workspace_state(
            cache_key,
            &metadata,
            profile_image_sizes_bytes,
        )
        .await
        .then(|| HeldWorkspaceState {
            reuse_key: metadata.reuse_key,
            last_completed_at: metadata.last_completed_at,
            workspace_caches: vec![WorkspaceCacheCapability {
                profile: metadata.profile_name,
                workspace_affinity_version: WORKSPACE_AFFINITY_VERSION,
            }],
        })
    }

    async fn metadata_is_publishable_held_workspace_state(
        &self,
        cache_key: &str,
        metadata: &WorkspaceCacheMetadata,
        profile_image_sizes_bytes: Option<&BTreeMap<&str, u64>>,
    ) -> bool {
        metadata.format_version == CACHE_FORMAT_VERSION
            && metadata.cache_scope == self.inner.cache_scope
            && metadata.drive_layout == WORKSPACE_DRIVE_LAYOUT
            && metadata.state == WorkspaceCacheEntryState::Current
            && metadata.workspace_trust == WorkspaceTrust::Clean
            && is_safe_guest_working_dir(&metadata.working_dir)
            && profile_image_sizes_bytes.is_none_or(|profile_image_sizes_bytes| {
                metadata.working_dir == CANONICAL_WORKING_DIR
                    && profile_image_sizes_bytes
                        .get(metadata.profile_name.as_str())
                        .is_some_and(|image_size| *image_size == metadata.logical_image_size_bytes)
            })
            && self.metadata_matches_cache_key(cache_key, metadata)
            && self
                .metadata_matches_current_image(cache_key, metadata)
                .await
    }

    async fn invalidate_cache_entry(
        &self,
        run_id: RunId,
        cache_key: &str,
        reason: &str,
    ) -> RunnerResult<bool> {
        let entry_dir = self.workspace_image_cache_entry_dir(cache_key);
        match remove_workspace_cache_path_if_exists(&entry_dir).await {
            Ok(removed) => {
                if removed {
                    info!(
                        run_id = %run_id,
                        cache_key,
                        reason,
                        "workspace image cache entry invalidated"
                    );
                }
                Ok(removed)
            }
            Err(e) => Err(e.into()),
        }
    }

    async fn promote_locked(
        &self,
        input: WorkspaceImagePromotionInput<'_>,
    ) -> RunnerResult<WorkspaceImagePromotionOutcome> {
        let promotion_started = Instant::now();
        let entry_paths = self.entry_paths(input.cache_key);
        let cache_dir = entry_paths.entry_dir();
        if remove_non_directory_workspace_cache_entry(cache_dir).await? {
            info!(
                run_id = %input.run_id,
                cache_key = input.cache_key,
                path = %cache_dir.display(),
                "removed non-directory workspace image cache entry before promotion"
            );
        }
        let metadata_path = entry_paths.metadata();
        match self
            .read_valid_metadata(
                metadata_path,
                input.profile_name,
                input.reuse_key,
                input.working_dir,
                input.image_size_bytes,
            )
            .await
        {
            Ok(Some(metadata)) if metadata.last_completed_at.as_str() >= input.completed_at => {
                info!(
                    run_id = %input.run_id,
                    cache_key = input.cache_key,
                    existing_last_completed_at = %metadata.last_completed_at,
                    promotion_completed_at = %input.completed_at,
                    "workspace image cache promotion skipped because existing cache is newer"
                );
                return Ok(WorkspaceImagePromotionOutcome::PreservedExisting);
            }
            Ok(_) => {}
            Err(e) => warn!(
                run_id = %input.run_id,
                cache_key = input.cache_key,
                error = %e,
                "workspace image cache existing metadata invalid during promotion; overwriting"
            ),
        }

        let _capacity_lock =
            match runner_host::lock::try_acquire_or_busy(self.capacity_lock_path()).await {
                Ok(runner_host::lock::TryLock::Acquired(lock)) => lock,
                Ok(runner_host::lock::TryLock::Busy) => {
                    info!(
                        run_id = %input.run_id,
                        cache_key = input.cache_key,
                        "workspace image cache promotion skipped: capacity lock busy"
                    );
                    return Ok(WorkspaceImagePromotionOutcome::SkippedUnpublished);
                }
                Err(e) => {
                    warn!(
                        run_id = %input.run_id,
                        cache_key = input.cache_key,
                        error = %e,
                        "workspace image cache promotion skipped: capacity lock unavailable"
                    );
                    return Ok(WorkspaceImagePromotionOutcome::SkippedUnpublished);
                }
            };

        let mut stats = self.fs_stats().await?;
        let mut budget = CacheBudget::from_fs_stats(stats);
        if stats.available_bytes < budget.min_free_bytes {
            match self.gc_locked(false).await {
                Ok(freed) if freed > 0 => {
                    stats = self.fs_stats().await?;
                    budget = CacheBudget::from_fs_stats(stats);
                }
                Ok(_) => {}
                Err(e) => warn!(
                    run_id = %input.run_id,
                    cache_key = input.cache_key,
                    error = %e,
                    "workspace image cache GC failed before promotion"
                ),
            }
        }
        if stats.available_bytes < budget.min_free_bytes {
            info!(
                run_id = %input.run_id,
                cache_key = input.cache_key,
                available_bytes = stats.available_bytes,
                min_free_bytes = budget.min_free_bytes,
                "workspace image cache promotion skipped due to free-space pressure"
            );
            return Ok(WorkspaceImagePromotionOutcome::SkippedUnpublished);
        }
        let image_metadata = fs::symlink_metadata(input.active_image).await?;
        if !image_metadata.is_file() {
            info!(
                run_id = %input.run_id,
                cache_key = input.cache_key,
                active_image = %input.active_image.display(),
                "workspace image cache promotion skipped because active image is not a file"
            );
            return Ok(WorkspaceImagePromotionOutcome::SkippedUnpublished);
        }
        let active_allocated = allocated_bytes(&image_metadata);
        if active_allocated > budget.max_entry_bytes {
            info!(
                run_id = %input.run_id,
                cache_key = input.cache_key,
                allocated_bytes = active_allocated,
                max_entry_bytes = budget.max_entry_bytes,
                "workspace image cache promotion skipped because image is too large"
            );
            return Ok(WorkspaceImagePromotionOutcome::SkippedUnpublished);
        }
        self.ensure_workspace_cache_entry_dir(input.cache_key)
            .await?;
        secure_workspace_cache_publication_file(input.active_image)?;
        let tmp = entry_paths.tmp_image(input.run_id);
        let _ = remove_workspace_cache_path_if_exists(&tmp).await;
        let rename_started = Instant::now();
        let (transfer_mode, transfer_duration) = match fs::rename(input.active_image, &tmp).await {
            Ok(()) => ("rename", rename_started.elapsed()),
            Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
                if !has_copy_headroom(stats, budget, active_allocated) {
                    match self.gc_locked(false).await {
                        Ok(freed) if freed > 0 => {
                            stats = self.fs_stats().await?;
                            budget = CacheBudget::from_fs_stats(stats);
                        }
                        Ok(_) => {}
                        Err(e) => warn!(
                            run_id = %input.run_id,
                            cache_key = input.cache_key,
                            error = %e,
                            "workspace image cache GC failed before promotion copy"
                        ),
                    }
                }
                if !has_copy_headroom(stats, budget, active_allocated) {
                    info!(
                        run_id = %input.run_id,
                        cache_key = input.cache_key,
                        allocated_bytes = active_allocated,
                        available_bytes = stats.available_bytes,
                        min_free_bytes = budget.min_free_bytes,
                        "workspace image cache promotion skipped due to copy free-space pressure"
                    );
                    return Ok(WorkspaceImagePromotionOutcome::SkippedUnpublished);
                }

                let copy_started = Instant::now();
                if let Err(e) = sparse_copy(input.active_image, &tmp).await {
                    let _ = remove_workspace_cache_path_if_exists(&tmp).await;
                    return Err(e);
                }
                ("sparse_copy", copy_started.elapsed())
            }
            Err(e) => {
                let _ = remove_workspace_cache_path_if_exists(&tmp).await;
                return Err(e.into());
            }
        };
        if let Err(e) = secure_workspace_cache_publication_file(&tmp) {
            let _ = remove_workspace_cache_path_if_exists(&tmp).await;
            return Err(e);
        }
        let tmp_metadata = match fs::symlink_metadata(&tmp).await {
            Ok(metadata) => metadata,
            Err(e) => {
                let _ = remove_workspace_cache_path_if_exists(&tmp).await;
                return Err(e.into());
            }
        };
        if !tmp_metadata.is_file() {
            let _ = remove_workspace_cache_path_if_exists(&tmp).await;
            return Err(RunnerError::Internal(format!(
                "workspace image cache temporary image is not a file: {}",
                tmp.display()
            )));
        }
        let logical_image_size_bytes = tmp_metadata.len();
        if logical_image_size_bytes != input.image_size_bytes {
            let _ = remove_workspace_cache_path_if_exists(&tmp).await;
            info!(
                run_id = %input.run_id,
                cache_key = input.cache_key,
                actual_image_size_bytes = logical_image_size_bytes,
                expected_image_size_bytes = input.image_size_bytes,
                "workspace image cache promotion skipped because transferred image size does not match cache key"
            );
            return Ok(WorkspaceImagePromotionOutcome::SkippedUnpublished);
        }
        let tmp_allocated = allocated_bytes(&tmp_metadata);
        if tmp_allocated > budget.max_entry_bytes {
            let _ = remove_workspace_cache_path_if_exists(&tmp).await;
            info!(
                run_id = %input.run_id,
                cache_key = input.cache_key,
                allocated_bytes = tmp_allocated,
                max_entry_bytes = budget.max_entry_bytes,
                "workspace image cache promotion skipped because transferred image is too large"
            );
            return Ok(WorkspaceImagePromotionOutcome::SkippedUnpublished);
        }
        let current = entry_paths.current_image();
        match fs::symlink_metadata(current).await {
            Ok(metadata) if metadata.is_dir() => {
                remove_workspace_cache_path_if_exists(current).await?;
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        if let Err(e) = fs::rename(&tmp, current).await {
            let _ = remove_workspace_cache_path_if_exists(&tmp).await;
            return Err(e.into());
        }
        let current_metadata = match fs::symlink_metadata(current).await {
            Ok(metadata) => metadata,
            Err(e) => {
                let _ = remove_workspace_cache_path_if_exists(current).await;
                return Err(e.into());
            }
        };
        if !current_metadata.is_file() {
            let _ = remove_workspace_cache_path_if_exists(current).await;
            return Err(RunnerError::Internal(format!(
                "workspace image cache current image is not a file: {}",
                current.display()
            )));
        }
        if let Err(e) = self
            .publish_session_history_sidecar(
                input.cache_key,
                input.run_id,
                input.session_history_sidecar,
            )
            .await
        {
            warn!(
                run_id = %input.run_id,
                cache_key = input.cache_key,
                error = %e,
                "workspace image cache session history sidecar publish failed"
            );
        }
        let allocated = allocated_bytes(&current_metadata);
        let metadata = WorkspaceCacheMetadata {
            format_version: CACHE_FORMAT_VERSION,
            cache_scope: self.inner.cache_scope.clone(),
            profile_name: input.profile_name.to_owned(),
            reuse_key: input.reuse_key.to_owned(),
            working_dir: input.working_dir.to_owned(),
            last_completed_at: input.completed_at.to_owned(),
            last_used_at: local_timestamp(),
            last_terminal_status: input.terminal_status,
            workspace_trust: WorkspaceTrust::Clean,
            logical_image_size_bytes,
            allocated_bytes: allocated,
            current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
            drive_layout: WORKSPACE_DRIVE_LAYOUT.to_owned(),
            storage_fingerprints: filter_storage_fingerprints_for_working_dir(
                input.storage_fingerprints,
                input.working_dir,
            ),
            state: WorkspaceCacheEntryState::Current,
        };
        if let Err(e) = self
            .write_metadata(input.cache_key, input.run_id, metadata)
            .await
        {
            let _ = remove_workspace_cache_path_if_exists(current).await;
            let _ = self.prune_session_history_sidecar(input.cache_key).await;
            return Err(e);
        }
        info!(
            run_id = %input.run_id,
            cache_key = input.cache_key,
            outcome = "promoted",
            transfer_mode,
            transfer_ms = duration_ms(transfer_duration),
            promotion_ms = duration_ms(promotion_started.elapsed()),
            logical_image_size_bytes,
            source_allocated_bytes = active_allocated,
            allocated_bytes = allocated,
            "workspace image cache promoted"
        );
        Ok(WorkspaceImagePromotionOutcome::Promoted)
    }
}

struct HeldWorkspaceStateScan {
    states: Vec<HeldWorkspaceState>,
    locked_commit_keys: BTreeSet<String>,
}

impl WorkspaceImageLease {
    #[cfg(test)]
    pub(crate) fn working_dir(&self) -> &str {
        &self.working_dir
    }

    pub(crate) fn result(&self) -> WorkspaceCacheCheckoutResult {
        self.result
    }

    pub(crate) fn lock_outcome_and_reason(&self) -> Option<(&'static str, Option<&'static str>)> {
        self.lock_decision
            .map(|decision| (decision.outcome(), decision.reason()))
    }

    pub(crate) fn is_cache_hit(&self) -> bool {
        self.result == WorkspaceCacheCheckoutResult::Hit
    }

    pub(crate) async fn probe_session_history_sidecar(
        &self,
        expected: &crate::restored_session_identity::RestoredSessionIdentity,
    ) -> Result<WorkspaceSessionHistorySidecar, WorkspaceSessionHistorySidecarMiss> {
        if !self.is_cache_hit() {
            return Err(WorkspaceSessionHistorySidecarMiss::NoCacheHit);
        }
        let cache_key = self
            .cache_key
            .as_deref()
            .ok_or(WorkspaceSessionHistorySidecarMiss::Missing)?;
        self.cache
            .probe_session_history_sidecar(cache_key, expected)
            .await
    }

    pub(crate) fn previous_storage(&self) -> Option<&StorageFingerprints> {
        self.previous_storage.as_ref()
    }

    pub(crate) fn workspace_drive_config(&self) -> Option<sandbox::WorkspaceDriveConfig> {
        self.workspace_drive_enabled
            .then(|| sandbox::WorkspaceDriveConfig {
                size_mb: workspace_image_size_mb(self.image_size_bytes),
                seed_image: self.source_image.as_ref().map(|source_image| {
                    if self.consumed_cache_hit {
                        sandbox::WorkspaceDriveSeedImage::Move(source_image.clone())
                    } else {
                        sandbox::WorkspaceDriveSeedImage::Copy(source_image.clone())
                    }
                }),
            })
    }

    pub(crate) async fn invalidate(&self, run_id: RunId, reason: &str) -> RunnerResult<bool> {
        let Some(cache_key) = self.cache_key.as_deref() else {
            return Ok(false);
        };
        if self.consumed_cache_hit {
            return self
                .cache
                .invalidate_cache_entry(run_id, cache_key, reason)
                .await;
        }
        let current = self.cache.workspace_image_cache_current_image(cache_key);
        self.cache
            .invalidate_current_image(run_id, cache_key, &current, reason)
            .await
    }

    #[cfg(test)]
    pub(crate) async fn promote(
        self,
        run_id: RunId,
        terminal_status: WorkspaceCacheTerminalStatus,
        completed_at: String,
        storage_fingerprints: &StorageFingerprints,
    ) -> RunnerResult<bool> {
        let Some(promotion) = self.into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id: sandbox::SandboxId::new_v4(),
            restored_session_identity: None,
            terminal_status,
            completed_at,
            storage_fingerprints: storage_fingerprints.clone(),
        }) else {
            return Ok(false);
        };
        let outcome = promotion.promote().await?;
        Ok(matches!(outcome, WorkspaceImagePromotionOutcome::Promoted))
    }

    fn promotion_target(&self) -> Option<WorkspaceImagePromotionTarget> {
        if !self.workspace_drive_enabled || !is_safe_guest_working_dir(&self.working_dir) {
            return None;
        }

        match self.result {
            WorkspaceCacheCheckoutResult::Hit | WorkspaceCacheCheckoutResult::Miss => {
                Some(WorkspaceImagePromotionTarget {
                    cache_key: self.cache_key.clone()?,
                    reuse_key: self.reuse_key.clone()?,
                })
            }
            WorkspaceCacheCheckoutResult::NoReuseKey => None,
            WorkspaceCacheCheckoutResult::InvalidWorkingDir
            | WorkspaceCacheCheckoutResult::LockBusy
            | WorkspaceCacheCheckoutResult::InvalidMetadata
            | WorkspaceCacheCheckoutResult::DiskPressure => None,
        }
    }

    pub(crate) fn into_promotion_context(
        mut self,
        request: WorkspaceImagePromotionRequest<'_>,
    ) -> Option<WorkspaceImagePromotionContext> {
        let WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            restored_session_identity,
            terminal_status,
            completed_at,
            storage_fingerprints,
        } = request;
        let target = self.promotion_target()?;
        let storage_fingerprints = match terminal_status {
            WorkspaceCacheTerminalStatus::Success => storage_fingerprints,
            WorkspaceCacheTerminalStatus::NonzeroExit | WorkspaceCacheTerminalStatus::Cancelled => {
                storage_fingerprints.tainted_paths_including(self.previous_storage.as_ref())
            }
        };

        let mut entry_lock = self.entry_lock.take();
        if let Some(entry_lock) = entry_lock.as_mut() {
            entry_lock.set_owner(WorkspaceCacheLockOwner::Finalizing);
        }

        Some(WorkspaceImagePromotionContext {
            cache: self.cache.clone(),
            cache_key: target.cache_key,
            entry_lock,
            run_id,
            sandbox_id,
            profile_name: self.profile_name.clone(),
            reuse_key: target.reuse_key,
            working_dir: self.working_dir.clone(),
            active_image: self.active_image.clone(),
            image_size_bytes: self.image_size_bytes,
            consumed_cache_hit: self.consumed_cache_hit,
            terminal_status,
            completed_at,
            storage_fingerprints,
            restored_session_identity: restored_session_identity.cloned(),
        })
    }
}

impl WorkspaceImagePromotionContext {
    pub(crate) async fn acquire_idle_workspace_reclamation_permit(
        &self,
    ) -> RunnerResult<tokio::sync::OwnedSemaphorePermit> {
        self.cache.acquire_idle_workspace_reclamation_permit().await
    }

    pub(crate) async fn acquire_session_history_sidecar_export_permit(
        &self,
    ) -> RunnerResult<tokio::sync::OwnedSemaphorePermit> {
        self.cache
            .acquire_session_history_sidecar_export_permit()
            .await
    }

    pub(crate) fn run_id(&self) -> RunId {
        self.run_id
    }

    pub(crate) fn terminal_status(&self) -> WorkspaceCacheTerminalStatus {
        self.terminal_status
    }

    pub(crate) fn sandbox_id(&self) -> sandbox::SandboxId {
        self.sandbox_id
    }

    pub(crate) fn profile_name(&self) -> &str {
        &self.profile_name
    }

    pub(crate) fn reuse_key(&self) -> &str {
        &self.reuse_key
    }

    pub(crate) fn restored_session_identity(
        &self,
    ) -> Option<&crate::restored_session_identity::RestoredSessionIdentity> {
        self.restored_session_identity.as_ref()
    }

    pub(crate) fn validate_identity(
        &self,
        expected: &WorkspaceImagePromotionIdentity,
    ) -> Result<(), WorkspaceImagePromotionIdentityMismatch> {
        if self.sandbox_id != expected.sandbox_id {
            return Err(WorkspaceImagePromotionIdentityMismatch::SandboxId);
        }
        if self.profile_name != expected.profile_name {
            return Err(WorkspaceImagePromotionIdentityMismatch::ProfileName);
        }
        if self.reuse_key != expected.reuse_key {
            return Err(WorkspaceImagePromotionIdentityMismatch::ReuseKey);
        }
        if self.working_dir != expected.working_dir {
            return Err(WorkspaceImagePromotionIdentityMismatch::WorkingDir);
        }
        if self.image_size_bytes != expected.image_size_bytes {
            return Err(WorkspaceImagePromotionIdentityMismatch::ImageSizeBytes);
        }
        if self.active_image != expected.active_image {
            return Err(WorkspaceImagePromotionIdentityMismatch::ActiveImage);
        }
        if self.cache_key != expected.cache_key {
            return Err(WorkspaceImagePromotionIdentityMismatch::CacheKey);
        }
        Ok(())
    }

    pub(crate) fn validate_expected_identity(
        &self,
        cache: &WorkspaceImageCache,
        request: WorkspaceImagePromotionIdentityRequest<'_>,
    ) -> Result<(), WorkspaceImagePromotionIdentityMismatch> {
        let expected = cache.expected_promotion_identity(request)?;
        self.validate_identity(&expected)
    }

    pub(crate) fn validate_stored_cache_identity(
        &self,
        request: WorkspaceImagePromotionIdentityRequest<'_>,
    ) -> Result<(), WorkspaceImagePromotionIdentityMismatch> {
        self.validate_expected_identity(&self.cache, request)
    }

    #[cfg(test)]
    pub(crate) async fn promote(&self) -> RunnerResult<WorkspaceImagePromotionOutcome> {
        self.promote_without_session_history_sidecar().await
    }

    pub(crate) async fn try_acquire_session_history_sidecar_entry_guard(
        &self,
    ) -> Option<WorkspaceSessionHistorySidecarEntryGuard> {
        let restored_session_identity = self.restored_session_identity.clone()?;
        let late_entry_lock = match self.entry_lock.as_ref() {
            Some(_) => None,
            None => {
                match runner_host::lock::try_acquire(self.cache.entry_lock_path(&self.cache_key))
                    .await
                {
                    Ok(lock) => Some(WorkspaceEntryLock::new(
                        &self.cache,
                        &self.cache_key,
                        lock,
                        WorkspaceCacheLockOwner::Finalizing,
                    )),
                    Err(e) => {
                        info!(
                            run_id = %self.run_id,
                            cache_key = self.cache_key,
                            error = %e,
                            "workspace image cache sidecar staging skipped: late entry lock unavailable"
                        );
                        return None;
                    }
                }
            }
        };
        if let Err(e) = self
            .cache
            .ensure_workspace_cache_entry_dir(&self.cache_key)
            .await
        {
            info!(
                run_id = %self.run_id,
                cache_key = self.cache_key,
                error = %e,
                "workspace image cache sidecar staging skipped: cache entry permission setup failed"
            );
            return None;
        }
        Some(WorkspaceSessionHistorySidecarEntryGuard {
            cache: self.cache.clone(),
            cache_key: self.cache_key.clone(),
            run_id: self.run_id,
            restored_session_identity,
            _late_entry_lock: late_entry_lock,
        })
    }

    pub(crate) async fn promote_without_session_history_sidecar(
        &self,
    ) -> RunnerResult<WorkspaceImagePromotionOutcome> {
        let _late_entry_lock_guard = match self.entry_lock.as_ref() {
            Some(_) => None,
            None => {
                match runner_host::lock::try_acquire(self.cache.entry_lock_path(&self.cache_key))
                    .await
                {
                    Ok(lock) => Some(WorkspaceEntryLock::new(
                        &self.cache,
                        &self.cache_key,
                        lock,
                        WorkspaceCacheLockOwner::Finalizing,
                    )),
                    Err(e) => {
                        info!(
                            run_id = %self.run_id,
                            cache_key = self.cache_key,
                            error = %e,
                            "workspace image cache promotion skipped: late entry lock unavailable"
                        );
                        return Ok(WorkspaceImagePromotionOutcome::SkippedUnpublished);
                    }
                }
            }
        };

        let publication = if self.consumed_cache_hit {
            WorkspaceSessionHistorySidecarPublication::PreserveExisting
        } else {
            WorkspaceSessionHistorySidecarPublication::Prune
        };
        self.promote_locked(publication).await
    }

    async fn promote_locked(
        &self,
        session_history_sidecar: WorkspaceSessionHistorySidecarPublication<'_>,
    ) -> RunnerResult<WorkspaceImagePromotionOutcome> {
        self.cache
            .promote_locked(WorkspaceImagePromotionInput {
                run_id: self.run_id,
                cache_key: &self.cache_key,
                profile_name: &self.profile_name,
                reuse_key: &self.reuse_key,
                working_dir: &self.working_dir,
                active_image: &self.active_image,
                image_size_bytes: self.image_size_bytes,
                terminal_status: self.terminal_status,
                completed_at: &self.completed_at,
                storage_fingerprints: &self.storage_fingerprints,
                session_history_sidecar,
            })
            .await
    }

    pub(crate) async fn abandon_unpublished(self, reason: &str) -> RunnerResult<bool> {
        let Self {
            cache,
            cache_key,
            entry_lock,
            run_id,
            sandbox_id,
            profile_name,
            reuse_key,
            consumed_cache_hit,
            ..
        } = self;
        let Some(_entry_lock) = entry_lock else {
            info!(
                run_id = %run_id,
                sandbox_id = %sandbox_id,
                profile_name,
                reuse_key_fingerprint = %runner_host::paths::short_digest(&reuse_key),
                reuse_key_kind = runner_types::types::reuse_key_kind(&reuse_key),
                cache_key,
                reason,
                "workspace image cache promotion context abandoned without entry lock"
            );
            return Ok(false);
        };
        if consumed_cache_hit {
            return cache
                .invalidate_cache_entry(run_id, &cache_key, reason)
                .await;
        }
        let current = cache.workspace_image_cache_current_image(&cache_key);
        cache
            .invalidate_current_image(run_id, &cache_key, &current, reason)
            .await
    }

    pub(crate) async fn invalidate_current(self, reason: &str) -> RunnerResult<bool> {
        let Self {
            cache,
            cache_key,
            entry_lock,
            run_id,
            consumed_cache_hit,
            ..
        } = self;
        let _late_entry_lock_guard = match entry_lock.as_ref() {
            Some(_) => None,
            None => match runner_host::lock::try_acquire(cache.entry_lock_path(&cache_key)).await {
                Ok(lock) => Some(WorkspaceEntryLock::new(
                    &cache,
                    &cache_key,
                    lock,
                    WorkspaceCacheLockOwner::Finalizing,
                )),
                Err(e) => {
                    warn!(
                        run_id = %run_id,
                        cache_key,
                        reason,
                        error = %e,
                        "workspace image cache baseline invalidation failed: late entry lock unavailable"
                    );
                    return Err(RunnerError::Internal(format!(
                        "workspace image cache baseline invalidation lock unavailable: {e}"
                    )));
                }
            },
        };
        if consumed_cache_hit {
            return cache
                .invalidate_cache_entry(run_id, &cache_key, reason)
                .await;
        }
        let current = cache.workspace_image_cache_current_image(&cache_key);
        cache
            .invalidate_current_image(run_id, &cache_key, &current, reason)
            .await
    }

    #[cfg(test)]
    pub(crate) fn try_into_active_lease(
        self,
        expected: &WorkspaceImagePromotionIdentity,
        workspace_drive_available: bool,
    ) -> Result<WorkspaceImageLease, WorkspaceImagePromotionIdentityMismatch> {
        self.validate_identity(expected)?;
        Ok(self.into_active_lease_unchecked(workspace_drive_available))
    }

    pub(crate) fn try_into_active_lease_preserving_context(
        self,
        expected: &WorkspaceImagePromotionIdentity,
        workspace_drive_available: bool,
    ) -> Result<WorkspaceImageLease, Box<WorkspaceImagePromotionIdentityFailure>> {
        if let Err(mismatch) = self.validate_identity(expected) {
            return Err(Box::new(WorkspaceImagePromotionIdentityFailure {
                promotion: self,
                mismatch,
            }));
        }
        Ok(self.into_active_lease_unchecked(workspace_drive_available))
    }

    fn into_active_lease_unchecked(self, workspace_drive_available: bool) -> WorkspaceImageLease {
        let Self {
            cache,
            cache_key,
            mut entry_lock,
            run_id: _,
            sandbox_id: _,
            profile_name,
            reuse_key,
            working_dir,
            active_image,
            image_size_bytes,
            consumed_cache_hit,
            terminal_status: _,
            completed_at: _,
            storage_fingerprints,
            restored_session_identity: _,
        } = self;
        if let Some(entry_lock) = entry_lock.as_mut() {
            entry_lock.set_owner(WorkspaceCacheLockOwner::Active);
        }
        let base = WorkspaceImageLeaseBase {
            cache,
            profile_name,
            reuse_key: Some(reuse_key),
            working_dir,
            active_image,
            image_size_bytes,
        };
        WorkspaceImageLease::from_parts(
            base,
            WorkspaceImageLeaseState {
                cache_key: Some(cache_key),
                source_image: None,
                consumed_cache_hit,
                previous_storage: Some(storage_fingerprints),
                entry_lock,
                workspace_drive_enabled: workspace_drive_available,
                result: WorkspaceCacheCheckoutResult::Miss,
                lock_decision: None,
            },
        )
    }
}

impl WorkspaceSessionHistorySidecarEntryGuard {
    pub(crate) fn session_history_sidecar_tmp_path(&self) -> PathBuf {
        self.cache
            .workspace_image_cache_tmp_sidecar(&self.cache_key, self.run_id)
    }

    pub(crate) fn session_history_sidecar_source(
        &self,
        tmp_path: PathBuf,
        representation: super::types::WorkspaceSessionHistorySidecarRepresentation,
        encoded_size: u64,
    ) -> WorkspaceSessionHistorySidecarPromotionSource {
        WorkspaceSessionHistorySidecarPromotionSource {
            tmp_path,
            representation,
            encoded_size,
            restored_session_identity: self.restored_session_identity.clone(),
        }
    }

    pub(crate) async fn discard_session_history_sidecar_source(
        &self,
        source: &WorkspaceSessionHistorySidecarPromotionSource,
    ) {
        self.cache
            .discard_session_history_sidecar_source(source)
            .await;
    }

    pub(crate) async fn promote_with_session_history_sidecar(
        &self,
        promotion: &WorkspaceImagePromotionContext,
        source: &WorkspaceSessionHistorySidecarPromotionSource,
    ) -> RunnerResult<WorkspaceImagePromotionOutcome> {
        if self.cache_key != promotion.cache_key || self.run_id != promotion.run_id {
            return Err(RunnerError::Internal(
                "workspace session history sidecar guard does not match promotion context".into(),
            ));
        }
        promotion
            .promote_locked(WorkspaceSessionHistorySidecarPublication::Replace(source))
            .await
    }
}

pub(crate) fn cap_held_workspace_states(
    states: Vec<HeldWorkspaceState>,
) -> Vec<HeldWorkspaceState> {
    struct ObservedWorkspaceState {
        last_completed_at: String,
        workspace_caches: BTreeMap<String, (String, WorkspaceCacheCapability)>,
    }

    let mut by_reuse_key = BTreeMap::<String, ObservedWorkspaceState>::new();
    for state in states {
        let reuse_key = state.reuse_key.clone();
        let observed = by_reuse_key
            .entry(reuse_key)
            .or_insert_with(|| ObservedWorkspaceState {
                last_completed_at: state.last_completed_at.clone(),
                workspace_caches: BTreeMap::new(),
            });
        if state.last_completed_at > observed.last_completed_at {
            observed.last_completed_at = state.last_completed_at.clone();
        }
        for workspace_cache in state.workspace_caches {
            match observed
                .workspace_caches
                .entry(workspace_cache.profile.clone())
            {
                std::collections::btree_map::Entry::Vacant(entry) => {
                    entry.insert((state.last_completed_at.clone(), workspace_cache));
                }
                std::collections::btree_map::Entry::Occupied(mut entry) => {
                    let (existing_completed_at, existing) = entry.get_mut();
                    let capability_order = workspace_cache
                        .workspace_affinity_version
                        .cmp(&existing.workspace_affinity_version);
                    if capability_order.is_gt()
                        || (capability_order.is_eq()
                            && state.last_completed_at > *existing_completed_at)
                    {
                        *existing_completed_at = state.last_completed_at.clone();
                        *existing = workspace_cache;
                    }
                }
            }
        }
    }

    let mut states: Vec<HeldWorkspaceState> = by_reuse_key
        .into_iter()
        .map(|(reuse_key, state)| HeldWorkspaceState {
            reuse_key,
            last_completed_at: state.last_completed_at,
            workspace_caches: state
                .workspace_caches
                .into_values()
                .map(|(_, workspace_cache)| workspace_cache)
                .take(MAX_WORKSPACE_CACHES_PER_REUSE_KEY)
                .collect(),
        })
        .collect();
    states.sort_unstable_by(|a, b| {
        b.last_completed_at
            .cmp(&a.last_completed_at)
            .then_with(|| a.reuse_key.cmp(&b.reuse_key))
    });

    let mut retained = Vec::new();
    let mut retained_workspace_caches = 0;
    for mut state in states {
        if retained.len() == MAX_HELD_WORKSPACE_STATES
            || retained_workspace_caches == MAX_WORKSPACE_CACHES_PER_HEARTBEAT
        {
            break;
        }
        let remaining = MAX_WORKSPACE_CACHES_PER_HEARTBEAT - retained_workspace_caches;
        state.workspace_caches.truncate(remaining);
        if state.workspace_caches.is_empty() {
            continue;
        }
        retained_workspace_caches += state.workspace_caches.len();
        retained.push(state);
    }
    retained.sort_unstable_by(|a, b| a.reuse_key.cmp(&b.reuse_key));
    retained
}
