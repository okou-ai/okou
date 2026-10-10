use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use nix::fcntl::Flock;
use tokio::fs;
use tracing::{info, warn};

use crate::duration::duration_ms;
use crate::error::{LifecycleError, LifecycleResult};
use crate::storage_fingerprints::StorageFingerprints;
use runner_types::ids::RunId;
use runner_types::types::{
    HOME_AFFINITY_VERSION, HeldHomeState, HomeCacheCapability, MAX_HELD_HOME_STATES,
    MAX_HOME_CACHES_PER_HEARTBEAT, MAX_HOME_CACHES_PER_REUSE_KEY,
};

use super::entry::is_cache_key_name;
use super::fs::{
    allocated_bytes, has_copy_headroom, local_timestamp, remove_home_cache_path_if_exists,
    remove_non_directory_home_cache_entry,
};
use super::metadata::{
    HomeCacheMetadata, HomeCacheScopeClassification, HomeCacheState as HomeCacheEntryState,
    HomeTrust,
};
use super::path_safety::{
    filter_storage_fingerprints_for_home, is_safe_guest_working_dir,
    normalize_safe_guest_working_dir,
};
use super::types::{
    CacheBudget, HomeCacheCheckoutResult, HomeCacheLockDecision, HomeCacheLockOwner,
    HomeCacheTerminalStatus, HomeImageLeaseIdentity, HomeImageLeaseRequest,
    HomeImagePrepareLockPolicy, HomeImagePrepareRequest, HomeImageProfileIdentity,
    HomeImagePromotionIdentity, HomeImagePromotionIdentityMismatch,
    HomeImagePromotionIdentityRequest, HomeImagePromotionRequest,
};
use super::{
    CACHE_FORMAT_VERSION, HOME_DRIVE_LAYOUT, HomeCacheLockRegistration, HomeImageCache,
    HomeImageCacheInner,
};
use guest_contracts::home_cache_history::HomeCacheHistoryProofBinding;

const HOME_IMAGE_PREPARE_LOCK_TIMEOUT: Duration = Duration::from_millis(50);

pub struct HomeImageLease {
    cache: HomeImageCache,
    pub(super) cache_key: Option<String>,
    profile_name: String,
    rootfs_hash: String,
    reuse_key: Option<String>,
    working_dir: String,
    active_image: PathBuf,
    pub(super) source_image: Option<PathBuf>,
    pub(super) consumed_cache_hit: bool,
    image_size_bytes: u64,
    home_drive_enabled: bool,
    result: HomeCacheCheckoutResult,
    previous_storage: Option<StorageFingerprints>,
    history_proof: Option<HomeCacheHistoryProofBinding>,
    pub(super) source_pin: Option<super::fs::PinnedImage>,
    entry_lock: Option<HomeEntryLock>,
    lock_decision: Option<HomeCacheLockDecision>,
}

pub struct HomeImagePromotionContext {
    cache: HomeImageCache,
    cache_key: String,
    entry_lock: Option<HomeEntryLock>,
    run_id: RunId,
    sandbox_id: sandbox::SandboxId,
    profile_name: String,
    rootfs_hash: String,
    reuse_key: String,
    working_dir: String,
    active_image: PathBuf,
    image_size_bytes: u64,
    consumed_cache_hit: bool,
    terminal_status: HomeCacheTerminalStatus,
    completed_at: String,
    storage_fingerprints: StorageFingerprints,
    restored_session_identity: Option<crate::restored_session_identity::RestoredSessionIdentity>,
    history_proof: Option<HomeCacheHistoryProofBinding>,
}

pub struct HomeImagePromotionIdentityFailure {
    pub promotion: HomeImagePromotionContext,
    pub mismatch: HomeImagePromotionIdentityMismatch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HomeImagePromotionOutcome {
    Promoted,
    PreservedExisting,
    SkippedUnpublished,
}

struct HomeImagePromotionInput<'a> {
    run_id: RunId,
    cache_key: &'a str,
    profile_name: &'a str,
    rootfs_hash: &'a str,
    reuse_key: &'a str,
    working_dir: &'a str,
    active_image: &'a Path,
    image_size_bytes: u64,
    terminal_status: HomeCacheTerminalStatus,
    completed_at: &'a str,
    storage_fingerprints: &'a StorageFingerprints,
    history_proof: Option<&'a HomeCacheHistoryProofBinding>,
}

struct HomeImagePromotionTarget {
    cache_key: String,
    reuse_key: String,
}

struct HomeImageLeaseCommon<'a> {
    run_id: RunId,
    profile_name: &'a str,
    rootfs_hash: &'a str,
    reuse_key: Option<&'a str>,
    raw_working_dir: &'a str,
    normalized_working_dir: Option<String>,
    active_image: PathBuf,
    image_size_bytes: u64,
}

struct HomeImageLeaseBase {
    cache: HomeImageCache,
    profile_name: String,
    rootfs_hash: String,
    reuse_key: Option<String>,
    working_dir: String,
    active_image: PathBuf,
    image_size_bytes: u64,
}

struct HomeImageLeaseState {
    cache_key: Option<String>,
    source_image: Option<PathBuf>,
    consumed_cache_hit: bool,
    previous_storage: Option<StorageFingerprints>,
    history_proof: Option<HomeCacheHistoryProofBinding>,
    entry_lock: Option<HomeEntryLock>,
    home_drive_enabled: bool,
    result: HomeCacheCheckoutResult,
    lock_decision: Option<HomeCacheLockDecision>,
}

/// Couples a locally provable lifecycle phase to the flock that establishes ownership.
///
/// Separate cache instances and processes do not share the registry, so their busy locks remain
/// explicitly `unknown` rather than being inferred from other runner state.
struct HomeEntryLock {
    inner: Arc<HomeImageCacheInner>,
    cache_key: String,
    identity: Arc<()>,
    lock: Option<Flock<std::fs::File>>,
}

impl HomeEntryLock {
    fn new(
        cache: &HomeImageCache,
        cache_key: &str,
        lock: Flock<std::fs::File>,
        owner: HomeCacheLockOwner,
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
            registration.insert(HomeCacheLockRegistration {
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

    fn set_owner(&mut self, owner: HomeCacheLockOwner) {
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

impl Drop for HomeEntryLock {
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

fn home_image_size_mb(image_size_bytes: u64) -> u32 {
    let mib = 1024 * 1024;
    image_size_bytes.div_ceil(mib).min(u64::from(u32::MAX)) as u32
}

impl<'a> HomeImageLeaseCommon<'a> {
    fn new(cache: &HomeImageCache, identity: HomeImageLeaseIdentity<'a>) -> Self {
        Self {
            run_id: identity.run_id,
            profile_name: identity.profile_name,
            rootfs_hash: identity.rootfs_hash,
            reuse_key: identity.reuse_key,
            raw_working_dir: identity.working_dir,
            normalized_working_dir: normalize_safe_guest_working_dir(identity.working_dir),
            active_image: cache.paths().active_home_image(&identity.sandbox_id),
            image_size_bytes: identity.image_size_bytes,
        }
    }

    fn safe_working_dir(&self) -> Option<&str> {
        self.normalized_working_dir.as_deref()
    }

    fn lease_working_dir(&self) -> &str {
        self.safe_working_dir().unwrap_or(self.raw_working_dir)
    }

    fn cache_key(&self, cache: &HomeImageCache, reuse_key: &str, working_dir: &str) -> String {
        cache.scoped_cache_key(
            self.profile_name,
            self.rootfs_hash,
            reuse_key,
            working_dir,
            self.image_size_bytes,
        )
    }

    fn lease_base(&self, cache: &HomeImageCache) -> HomeImageLeaseBase {
        HomeImageLeaseBase {
            cache: cache.clone(),
            profile_name: self.profile_name.to_owned(),
            rootfs_hash: self.rootfs_hash.to_owned(),
            reuse_key: self.reuse_key.map(str::to_owned),
            working_dir: self.lease_working_dir().to_owned(),
            active_image: self.active_image.clone(),
            image_size_bytes: self.image_size_bytes,
        }
    }
}

impl HomeImageLease {
    fn from_parts(base: HomeImageLeaseBase, state: HomeImageLeaseState) -> Self {
        Self {
            cache: base.cache,
            cache_key: state.cache_key,
            profile_name: base.profile_name,
            rootfs_hash: base.rootfs_hash,
            reuse_key: base.reuse_key,
            working_dir: base.working_dir,
            active_image: base.active_image,
            source_image: state.source_image,
            consumed_cache_hit: state.consumed_cache_hit,
            image_size_bytes: base.image_size_bytes,
            home_drive_enabled: state.home_drive_enabled,
            result: state.result,
            previous_storage: state.previous_storage,
            history_proof: state.history_proof,
            source_pin: None,
            entry_lock: state.entry_lock,
            lock_decision: state.lock_decision,
        }
    }
}

impl HomeImageCache {
    fn local_entry_lock_observation(&self, cache_key: &str) -> Option<HomeCacheLockRegistration> {
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
        before: Option<&HomeCacheLockRegistration>,
    ) -> HomeCacheLockOwner {
        let after = self.local_entry_lock_observation(cache_key);
        match (before, after) {
            (Some(before), Some(after)) if Arc::ptr_eq(&before.identity, &after.identity) => {
                after.owner
            }
            _ => HomeCacheLockOwner::Unknown,
        }
    }

    async fn acquire_prepare_lock(
        &self,
        lock_path: PathBuf,
        lock_policy: HomeImagePrepareLockPolicy,
    ) -> LifecycleResult<runner_host::lock::TryLock> {
        if lock_policy == HomeImagePrepareLockPolicy::ImmediateFallback {
            return Ok(runner_host::lock::try_acquire_or_busy(lock_path).await?);
        }

        #[cfg(any(test, feature = "test-support"))]
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
            HOME_IMAGE_PREPARE_LOCK_TIMEOUT,
        )
        .await?)
    }

    pub fn expected_promotion_identity(
        &self,
        request: HomeImagePromotionIdentityRequest<'_>,
    ) -> Result<HomeImagePromotionIdentity, HomeImagePromotionIdentityMismatch> {
        if request.rootfs_hash.is_empty()
            || request.image_size_bytes == 0
            || !request.image_size_bytes.is_multiple_of(1024 * 1024)
        {
            return Err(HomeImagePromotionIdentityMismatch::RootfsHash);
        }
        let Some(working_dir) = normalize_safe_guest_working_dir(request.working_dir) else {
            return Err(HomeImagePromotionIdentityMismatch::UnsafeWorkingDir);
        };
        let cache_key = self.scoped_cache_key(
            request.profile_name,
            request.rootfs_hash,
            request.reuse_key,
            &working_dir,
            request.image_size_bytes,
        );

        Ok(HomeImagePromotionIdentity {
            sandbox_id: request.sandbox_id,
            profile_name: request.profile_name.to_owned(),
            rootfs_hash: request.rootfs_hash.to_owned(),
            reuse_key: request.reuse_key.to_owned(),
            working_dir,
            image_size_bytes: request.image_size_bytes,
            active_image: self.paths().active_home_image(&request.sandbox_id),
            cache_key,
        })
    }

    pub async fn lease_active(&self, request: HomeImageLeaseRequest<'_>) -> HomeImageLease {
        let common = HomeImageLeaseCommon::new(self, request.identity);
        let active_lease = |result, entry_lock, cache_key, lock_decision| {
            HomeImageLease::from_parts(
                common.lease_base(self),
                HomeImageLeaseState {
                    cache_key,
                    source_image: None,
                    consumed_cache_hit: false,
                    previous_storage: None,
                    history_proof: None,
                    entry_lock,
                    home_drive_enabled: request.home_drive_available,
                    result,
                    lock_decision,
                },
            )
        };

        if common.rootfs_hash.is_empty() || common.image_size_bytes == 0 {
            return active_lease(HomeCacheCheckoutResult::InvalidMetadata, None, None, None);
        }
        let Some(working_dir) = common.safe_working_dir() else {
            warn!(
                run_id = %common.run_id,
                working_dir = %common.raw_working_dir,
                "home image cache active lease disabled for unsafe working directory"
            );
            return active_lease(HomeCacheCheckoutResult::InvalidWorkingDir, None, None, None);
        };
        let Some(reuse_key) = common.reuse_key else {
            return active_lease(HomeCacheCheckoutResult::NoReuseKey, None, None, None);
        };

        let cache_key = common.cache_key(self, reuse_key, working_dir);
        let owner_before = self.local_entry_lock_observation(&cache_key);
        match runner_host::lock::try_acquire_or_busy(self.entry_lock_path(&cache_key)).await {
            Ok(runner_host::lock::TryLock::Acquired(lock)) => active_lease(
                HomeCacheCheckoutResult::Miss,
                Some(HomeEntryLock::new(
                    self,
                    &cache_key,
                    lock,
                    HomeCacheLockOwner::Active,
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
                    "home image cache active lease lock busy; promotion disabled"
                );
                active_lease(
                    HomeCacheCheckoutResult::LockBusy,
                    None,
                    None,
                    Some(HomeCacheLockDecision::Busy(owner)),
                )
            }
            Err(e) => {
                info!(
                    run_id = %common.run_id,
                    cache_key,
                    error = %e,
                    "home image cache active lease lock unavailable; promotion disabled"
                );
                active_lease(
                    HomeCacheCheckoutResult::LockBusy,
                    None,
                    None,
                    Some(HomeCacheLockDecision::Unavailable),
                )
            }
        }
    }

    pub async fn prepare(&self, request: HomeImagePrepareRequest<'_>) -> HomeImageLease {
        self.prepare_with_lock_policy(
            request,
            HomeImagePrepareLockPolicy::WaitForTransientContention,
        )
        .await
    }

    pub async fn prepare_with_lock_policy(
        &self,
        request: HomeImagePrepareRequest<'_>,
        lock_policy: HomeImagePrepareLockPolicy,
    ) -> HomeImageLease {
        let common = HomeImageLeaseCommon::new(self, request.identity);
        let home_drive = |result,
                          source_image: Option<PathBuf>,
                          previous_storage: Option<StorageFingerprints>,
                          entry_lock,
                          cache_key,
                          home_drive_enabled,
                          lock_decision| {
            let consumed_cache_hit =
                result == HomeCacheCheckoutResult::Hit && source_image.is_some();
            HomeImageLease::from_parts(
                common.lease_base(self),
                HomeImageLeaseState {
                    cache_key,
                    source_image,
                    consumed_cache_hit,
                    previous_storage,
                    history_proof: None,
                    entry_lock,
                    home_drive_enabled,
                    result,
                    lock_decision,
                },
            )
        };

        if common.rootfs_hash.is_empty() || common.image_size_bytes == 0 {
            return home_drive(
                HomeCacheCheckoutResult::InvalidMetadata,
                None,
                None,
                None,
                None,
                true,
                None,
            );
        }
        let Some(working_dir) = common.safe_working_dir() else {
            warn!(
                run_id = %common.run_id,
                working_dir = %common.raw_working_dir,
                "home image cache disabled for unsafe working directory"
            );
            return home_drive(
                HomeCacheCheckoutResult::InvalidWorkingDir,
                None,
                None,
                None,
                None,
                request.home_drive_required,
                None,
            );
        };
        let Some(reuse_key) = common.reuse_key else {
            return home_drive(
                HomeCacheCheckoutResult::NoReuseKey,
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
                "home image cache disabled because filesystem stats are unavailable"
            );
            return home_drive(
                HomeCacheCheckoutResult::DiskPressure,
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
                        "home image cache stats refresh failed after GC"
                    ),
                },
                Ok(_) => {}
                Err(e) => warn!(
                    run_id = %common.run_id,
                    error = %e,
                    "home image cache GC failed before checkout"
                ),
            }
        }
        if stats.available_bytes < budget.min_free_bytes {
            info!(
                run_id = %common.run_id,
                available_bytes = stats.available_bytes,
                min_free_bytes = budget.min_free_bytes,
                "home image cache skipped due to free-space pressure"
            );
            return home_drive(
                HomeCacheCheckoutResult::DiskPressure,
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
                    HomeImagePrepareLockPolicy::WaitForTransientContention => info!(
                        run_id = %common.run_id,
                        cache_key,
                        owner = owner.as_str(),
                        wait_ms = duration_ms(HOME_IMAGE_PREPARE_LOCK_TIMEOUT),
                        "home image cache lock remained busy; using fresh home image"
                    ),
                    HomeImagePrepareLockPolicy::ImmediateFallback => info!(
                        run_id = %common.run_id,
                        cache_key,
                        owner = owner.as_str(),
                        wait_ms = 0,
                        "home image cache lock busy without retry; using fresh home image"
                    ),
                }
                return home_drive(
                    HomeCacheCheckoutResult::LockBusy,
                    None,
                    None,
                    None,
                    None,
                    true,
                    Some(HomeCacheLockDecision::Busy(owner)),
                );
            }
            Err(e) => {
                info!(
                    run_id = %common.run_id,
                    cache_key,
                    error = %e,
                    "home image cache lock unavailable; using fresh home image"
                );
                return home_drive(
                    HomeCacheCheckoutResult::LockBusy,
                    None,
                    None,
                    None,
                    None,
                    true,
                    Some(HomeCacheLockDecision::Unavailable),
                );
            }
        };
        let lock = HomeEntryLock::new(self, &cache_key, lock, HomeCacheLockOwner::Active);

        let entry_dir = self.home_image_cache_entry_dir(&cache_key);
        match remove_non_directory_home_cache_entry(&entry_dir).await {
            Ok(true) => {
                info!(
                    run_id = %common.run_id,
                    cache_key,
                    path = %entry_dir.display(),
                    "removed non-directory home image cache entry before checkout"
                );
                return home_drive(
                    HomeCacheCheckoutResult::Miss,
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
                    "failed to remove non-directory home image cache entry before checkout"
                );
                return home_drive(
                    HomeCacheCheckoutResult::InvalidMetadata,
                    None,
                    None,
                    Some(lock),
                    Some(cache_key),
                    true,
                    None,
                );
            }
        }

        let metadata_path = self.home_image_cache_metadata(&cache_key);
        let hit = match self
            .read_valid_metadata(
                &metadata_path,
                common.profile_name,
                common.rootfs_hash,
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
                            "home image cache hit checked out with move seed"
                        );
                    }
                    Err(e) => {
                        warn!(
                            run_id = %common.run_id,
                            cache_key,
                            error = %e,
                            "failed to remove home image cache metadata before move checkout; using fresh home image"
                        );
                        return home_drive(
                            HomeCacheCheckoutResult::Miss,
                            None,
                            None,
                            Some(lock),
                            Some(cache_key),
                            true,
                            None,
                        );
                    }
                }
                let source = self
                    .entry_paths(&cache_key)
                    .image(&metadata.image_generation)
                    .ok_or_else(|| LifecycleError::Internal("invalid home generation".into()));
                match source {
                    Ok(source) => Some((
                        source,
                        previous,
                        metadata.history_proof,
                        metadata.current_image,
                    )),
                    Err(_) => None,
                }
            }
            Ok(None) => None,
            Err(e) => {
                warn!(
                    run_id = %common.run_id,
                    cache_key,
                    error = %e,
                    "home image cache metadata invalid; using fresh home image"
                );
                let entry_dir = self.home_image_cache_entry_dir(&cache_key);
                match fs::remove_dir_all(&entry_dir).await {
                    Ok(()) => {
                        info!(
                            run_id = %common.run_id,
                            cache_key,
                            "removed invalid home image cache entry before fresh checkout"
                        );
                        return home_drive(
                            HomeCacheCheckoutResult::Miss,
                            None,
                            None,
                            Some(lock),
                            Some(cache_key),
                            true,
                            None,
                        );
                    }
                    Err(remove_error) if remove_error.kind() == std::io::ErrorKind::NotFound => {
                        return home_drive(
                            HomeCacheCheckoutResult::Miss,
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
                            "failed to remove invalid home image cache entry"
                        );
                    }
                }
                return home_drive(
                    HomeCacheCheckoutResult::InvalidMetadata,
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
            Some((source, previous, binding, expected_image)) => {
                let pin = super::fs::PinnedImage::open(&source, common.image_size_bytes);
                if !pin
                    .as_ref()
                    .is_ok_and(|pin| pin.identity() == expected_image)
                {
                    return home_drive(
                        HomeCacheCheckoutResult::Miss,
                        None,
                        None,
                        Some(lock),
                        Some(cache_key),
                        true,
                        None,
                    );
                }
                let mut lease = home_drive(
                    HomeCacheCheckoutResult::Hit,
                    Some(source),
                    Some(previous),
                    Some(lock),
                    Some(cache_key),
                    true,
                    None,
                );
                lease.history_proof = binding;
                lease.source_pin = pin.ok();
                lease
            }
            None => home_drive(
                HomeCacheCheckoutResult::Miss,
                None,
                None,
                Some(lock),
                Some(cache_key),
                true,
                None,
            ),
        }
    }

    pub async fn held_home_states_for_profiles(
        &self,
        profile_image_sizes_bytes: &BTreeMap<&str, HomeImageProfileIdentity<'_>>,
    ) -> Vec<HeldHomeState> {
        self.held_home_states_matching_profiles(Some(profile_image_sizes_bytes), None, false)
            .await
            .states
    }

    /// Performs the startup scan and returns the loaded and locked cache keys
    /// needed to connect subscribe-before-scan watcher state.
    pub async fn initial_held_home_states_for_profiles(
        &self,
        profile_image_sizes_bytes: &BTreeMap<&str, HomeImageProfileIdentity<'_>>,
    ) -> (Vec<HeldHomeState>, BTreeSet<String>, BTreeSet<String>) {
        let scan = self
            .held_home_states_matching_profiles(Some(profile_image_sizes_bytes), None, true)
            .await;
        // The heartbeat projection omits cache keys, but startup needs the
        // deterministic keys for the watcher handoff before publishing it.
        let loaded_cache_keys = scan
            .states
            .iter()
            .flat_map(|state| {
                state.home_caches.iter().filter_map(|workspace| {
                    profile_image_sizes_bytes
                        .get(workspace.profile.as_str())
                        .map(|image_size_bytes| {
                            self.scoped_cache_key(
                                &workspace.profile,
                                image_size_bytes.rootfs_hash,
                                &state.reuse_key,
                                CANONICAL_WORKING_DIR,
                                image_size_bytes.image_size_bytes,
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
    pub async fn held_home_states_for_profiles_after_commits(
        &self,
        profile_image_sizes_bytes: &BTreeMap<&str, HomeImageProfileIdentity<'_>>,
        committed_cache_keys: &BTreeSet<String>,
        deadline: tokio::time::Instant,
    ) -> Vec<HeldHomeState> {
        self.held_home_states_matching_profiles(
            Some(profile_image_sizes_bytes),
            Some((committed_cache_keys, deadline)),
            false,
        )
        .await
        .states
    }

    /// Inspect cache state without a running profile configuration in tests.
    #[cfg(any(test, feature = "test-support"))]
    pub async fn held_home_states(&self) -> Vec<HeldHomeState> {
        self.held_home_states_matching_profiles(None, None, false)
            .await
            .states
    }

    async fn held_home_states_matching_profiles(
        &self,
        profile_image_sizes_bytes: Option<&BTreeMap<&str, HomeImageProfileIdentity<'_>>>,
        committed_cache_keys: Option<(&BTreeSet<String>, tokio::time::Instant)>,
        collect_locked_commits: bool,
    ) -> HeldHomeStateScan {
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
                            "home cache commit lock wait timed out"
                        );
                        break;
                    }
                };
                if let Some(state) = self
                    .publishable_held_home_state(cache_key, profile_image_sizes_bytes, &lock)
                    .await
                {
                    states.push(state);
                    validated_cache_keys.insert(cache_key.clone());
                }
                drop(lock);
            }
        }

        let mut locked_commit_keys = BTreeSet::new();
        #[cfg(any(test, feature = "test-support"))]
        self.inner
            .held_state_root_scan_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        #[cfg(any(test, feature = "test-support"))]
        self.inner.held_state_root_scan_notify.notify_waiters();
        let root = self.home_image_cache_dir().to_path_buf();
        let mut entries = match fs::read_dir(&root).await {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return HeldHomeStateScan {
                    states: cap_held_home_states(states),
                    locked_commit_keys,
                };
            }
            Err(e) => {
                warn!(error = %e, "failed to scan home image cache");
                return HeldHomeStateScan {
                    states: cap_held_home_states(states),
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
                    if collect_locked_commits && locked_commit_keys.len() < MAX_HELD_HOME_STATES {
                        let metadata_path = self.home_image_cache_metadata(cache_key);
                        if self
                            .classify_metadata_scope(cache_key, &metadata_path)
                            .await
                            == HomeCacheScopeClassification::Relevant
                        {
                            locked_commit_keys.insert(cache_key.to_owned());
                        }
                    }
                    continue;
                }
                Err(_) => continue,
            };
            if let Some(state) = self
                .publishable_held_home_state(cache_key, profile_image_sizes_bytes, &lock)
                .await
            {
                states.push(state);
            }
            drop(lock);
        }
        let observed_home_caches = states
            .iter()
            .map(|state| state.home_caches.len())
            .sum::<usize>();
        let states = cap_held_home_states(states);
        let retained_home_caches = states
            .iter()
            .map(|state| state.home_caches.len())
            .sum::<usize>();
        if retained_home_caches < observed_home_caches {
            info!(
                observed_home_caches,
                retained_home_states = states.len(),
                retained_home_caches,
                "home cache state truncated"
            );
        }
        HeldHomeStateScan {
            states,
            locked_commit_keys,
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn reset_held_state_root_scan_count(&self) {
        self.inner
            .held_state_root_scan_count
            .store(0, std::sync::atomic::Ordering::Relaxed);
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn held_state_root_scan_count(&self) -> usize {
        self.inner
            .held_state_root_scan_count
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    #[cfg(any(test, feature = "test-support"))]
    pub async fn wait_for_held_state_root_scan_after(
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
                "home cache did not start a held-state root scan within {timeout:?}"
            );
            tokio::time::timeout(remaining, notified)
                .await
                .unwrap_or_else(|_| {
                    panic!("home cache did not start a held-state root scan within {timeout:?}")
                });
        }
    }

    async fn publishable_held_home_state(
        &self,
        cache_key: &str,
        profile_image_sizes_bytes: Option<&BTreeMap<&str, HomeImageProfileIdentity<'_>>>,
        _lock: &Flock<std::fs::File>,
    ) -> Option<HeldHomeState> {
        let metadata = self
            .read_metadata_file(&self.home_image_cache_metadata(cache_key))
            .await
            .ok()?;
        self.metadata_is_publishable_held_home_state(
            cache_key,
            &metadata,
            profile_image_sizes_bytes,
        )
        .await
        .then(|| HeldHomeState {
            reuse_key: metadata.reuse_key,
            last_completed_at: metadata.last_completed_at,
            home_caches: vec![HomeCacheCapability {
                profile: metadata.profile_name,
                home_affinity_version: HOME_AFFINITY_VERSION,
            }],
        })
    }

    async fn metadata_is_publishable_held_home_state(
        &self,
        cache_key: &str,
        metadata: &HomeCacheMetadata,
        profile_image_sizes_bytes: Option<&BTreeMap<&str, HomeImageProfileIdentity<'_>>>,
    ) -> bool {
        metadata.format_version == CACHE_FORMAT_VERSION
            && metadata.cache_scope == self.inner.cache_scope
            && metadata.drive_layout == HOME_DRIVE_LAYOUT
            && metadata.state == HomeCacheEntryState::Current
            && metadata.home_trust == HomeTrust::Clean
            && is_safe_guest_working_dir(&metadata.working_dir)
            && profile_image_sizes_bytes.is_none_or(|profile_image_sizes_bytes| {
                profile_image_sizes_bytes
                    .get(metadata.profile_name.as_str())
                    .is_some_and(|identity| {
                        identity.image_size_bytes == metadata.logical_image_size_bytes
                            && identity.rootfs_hash == metadata.rootfs_hash
                    })
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
    ) -> LifecycleResult<bool> {
        let entry_dir = self.home_image_cache_entry_dir(cache_key);
        match remove_home_cache_path_if_exists(&entry_dir).await {
            Ok(removed) => {
                if removed {
                    info!(
                        run_id = %run_id,
                        cache_key,
                        reason,
                        "home image cache entry invalidated"
                    );
                }
                Ok(removed)
            }
            Err(e) => Err(e.into()),
        }
    }

    async fn promote_locked(
        &self,
        input: HomeImagePromotionInput<'_>,
    ) -> LifecycleResult<HomeImagePromotionOutcome> {
        use super::fs::{PinnedImage, move_noreplace, sparse_copy_pinned, sync_directory};
        let paths = self.entry_paths(input.cache_key);
        let generation = input.run_id.to_string();
        if let Some(binding) = input.history_proof {
            super::metadata::validate_history_binding(binding, &generation)?;
        }
        if input.rootfs_hash.is_empty()
            || input.image_size_bytes == 0
            || !input.image_size_bytes.is_multiple_of(1024 * 1024)
        {
            return Ok(HomeImagePromotionOutcome::SkippedUnpublished);
        }
        let previous = self
            .read_valid_metadata(
                &paths.metadata(),
                input.profile_name,
                input.rootfs_hash,
                input.reuse_key,
                input.working_dir,
                input.image_size_bytes,
            )
            .await
            .ok()
            .flatten();
        if previous
            .as_ref()
            .is_some_and(|m| m.last_completed_at.as_str() >= input.completed_at)
        {
            return Ok(HomeImagePromotionOutcome::PreservedExisting);
        }
        let _capacity =
            match runner_host::lock::try_acquire_or_busy(self.capacity_lock_path()).await {
                Ok(runner_host::lock::TryLock::Acquired(lock)) => lock,
                Ok(runner_host::lock::TryLock::Busy) => {
                    info!(run_id = %input.run_id, cache_key = input.cache_key,
                        "home image cache promotion skipped: capacity lock busy");
                    return Ok(HomeImagePromotionOutcome::SkippedUnpublished);
                }
                Err(error) => {
                    warn!(run_id = %input.run_id, cache_key = input.cache_key, %error,
                        "home image cache promotion skipped: capacity lock unavailable");
                    return Ok(HomeImagePromotionOutcome::SkippedUnpublished);
                }
            };
        let stats = self.fs_stats().await?;
        let budget = CacheBudget::from_fs_stats(stats);
        // Metadata staging and new directory blocks also need reserve. Never use
        // an unavailable scan as zero or assume another locked image is reclaimable.
        let metadata_peak = runner_host::state_file::HOME_METADATA_MAX_BYTES.saturating_add(8192);
        if !has_copy_headroom(stats, budget, metadata_peak) {
            return Ok(HomeImagePromotionOutcome::SkippedUnpublished);
        }
        let source = match PinnedImage::open(input.active_image, input.image_size_bytes) {
            Ok(source) => source,
            Err(error) => {
                info!(%error, "home publication source unavailable");
                return Ok(HomeImagePromotionOutcome::SkippedUnpublished);
            }
        };
        let source_identity = source.identity();
        let active_allocated = allocated_bytes(&source.validate_path(input.active_image)?);
        let total = self.total_cache_allocated_bytes().await?;
        if total
            .saturating_add(active_allocated)
            .saturating_add(metadata_peak)
            > budget.max_cache_bytes
        {
            self.gc_locked(false).await?;
            if self
                .total_cache_allocated_bytes()
                .await?
                .saturating_add(active_allocated)
                .saturating_add(metadata_peak)
                > budget.max_cache_bytes
            {
                return Ok(HomeImagePromotionOutcome::SkippedUnpublished);
            }
        }
        self.ensure_home_cache_entry_dir(input.cache_key).await?;
        sync_directory(self.home_image_cache_dir()).await?;
        if let Some(parent) = self.home_image_cache_dir().parent() {
            sync_directory(parent).await?;
        }
        let staging = paths.tmp_image(input.run_id);
        let candidate = paths
            .image(&generation)
            .ok_or_else(|| LifecycleError::Internal("invalid publication generation".into()))?;
        // The generation is never reused, even after an interrupted attempt.
        if fs::symlink_metadata(&candidate).await.is_ok()
            || fs::symlink_metadata(&staging).await.is_ok()
        {
            return Ok(HomeImagePromotionOutcome::SkippedUnpublished);
        }
        source.validate_path(input.active_image)?;
        let (pinned, copied) = match move_noreplace(input.active_image, &staging) {
            Ok(()) => {
                source.validate_path(&staging)?;
                (source, false)
            }
            Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
                let fresh_stats = self.fs_stats().await?;
                if !has_copy_headroom(
                    fresh_stats,
                    budget,
                    active_allocated.saturating_add(metadata_peak),
                ) {
                    return Ok(HomeImagePromotionOutcome::SkippedUnpublished);
                }
                let copied = sparse_copy_pinned(&source, &staging, input.image_size_bytes).await?;
                source.validate_path(input.active_image)?;
                (copied, true)
            }
            Err(e) => return Err(e.into()),
        };
        pinned.validate_path(&staging)?;
        #[cfg(test)]
        self.publication_fault(super::PublicationFault::BeforeImageSync)?;
        pinned.sync()?;
        sync_directory(paths.entry_dir()).await?;
        if !copied && let Some(parent) = input.active_image.parent() {
            sync_directory(parent).await?;
        }
        #[cfg(test)]
        self.publication_fault(super::PublicationFault::AfterImageSync)?;
        move_noreplace(&staging, &candidate)?;
        let observed = pinned.validate_path(&candidate)?;
        sync_directory(paths.entry_dir()).await?;
        // Fresh block counts include old commit, candidates, orphans, staging and
        // metadata. Cross-device source allocation still exists until commit.
        let fresh_stats = self.fs_stats().await?;
        if fresh_stats.available_bytes < budget.min_free_bytes.saturating_add(metadata_peak)
            || self
                .total_cache_allocated_bytes()
                .await?
                .saturating_add(metadata_peak)
                > budget.max_cache_bytes
        {
            return Ok(HomeImagePromotionOutcome::SkippedUnpublished);
        }
        let metadata = HomeCacheMetadata {
            format_version: CACHE_FORMAT_VERSION,
            cache_scope: self.inner.cache_scope.clone(),
            profile_name: input.profile_name.to_owned(),
            rootfs_hash: input.rootfs_hash.to_owned(),
            reuse_key: input.reuse_key.to_owned(),
            working_dir: input.working_dir.to_owned(),
            fingerprint_scope: "/home/user".to_owned(),
            image_generation: generation,
            history_proof: input.history_proof.cloned(),
            last_completed_at: input.completed_at.to_owned(),
            last_used_at: local_timestamp(),
            last_terminal_status: input.terminal_status,
            home_trust: HomeTrust::Clean,
            logical_image_size_bytes: input.image_size_bytes,
            allocated_bytes: allocated_bytes(&observed),
            current_image: pinned.identity(),
            drive_layout: HOME_DRIVE_LAYOUT.to_owned(),
            storage_fingerprints: filter_storage_fingerprints_for_home(input.storage_fingerprints),
            state: HomeCacheEntryState::Current,
        };
        pinned.validate_path(&candidate)?;
        self.write_metadata(input.cache_key, input.run_id, metadata)
            .await?;
        // Only a successful synced commit grants deletion authority. A late
        // metadata error leaves the new image intact, never mixed-generation.
        if let Some(previous) = previous
            && let Some(old) = paths.image(&previous.image_generation)
            && old != candidate
            && let Ok(old_pin) = PinnedImage::open(&old, previous.logical_image_size_bytes)
            && old_pin.identity() == previous.current_image
            && old_pin.validate_path(&old).is_ok()
        {
            let _ = fs::remove_file(&old).await;
            let _ = sync_directory(paths.entry_dir()).await;
        }
        if copied
            && let Ok(source_pin) = PinnedImage::open(input.active_image, input.image_size_bytes)
            && source_pin.validate_path(input.active_image).is_ok()
        {
            // The active source may have been replaced since transfer. Deletion
            // requires the original observed identity, not merely matching size.
            if source_pin.identity() == source_identity {
                let _ = fs::remove_file(input.active_image).await;
                if let Some(parent) = input.active_image.parent() {
                    let _ = sync_directory(parent).await;
                }
            }
        }
        // Native acceptance and operational readers use this as a completion
        // receipt, never as preparation or a candidate-image write acknowledgement.
        info!(run_id = %input.run_id, cache_key = input.cache_key,
            image_generation = %input.run_id, image_size_bytes = input.image_size_bytes,
            "home image cache promoted");
        Ok(HomeImagePromotionOutcome::Promoted)
    }
}

struct HeldHomeStateScan {
    states: Vec<HeldHomeState>,
    locked_commit_keys: BTreeSet<String>,
}

impl HomeImageLease {
    #[cfg(any(test, feature = "test-support"))]
    pub fn working_dir(&self) -> &str {
        &self.working_dir
    }

    pub fn result(&self) -> HomeCacheCheckoutResult {
        self.result
    }

    pub fn lock_outcome_and_reason(&self) -> Option<(&'static str, Option<&'static str>)> {
        self.lock_decision
            .map(|decision| (decision.outcome(), decision.reason()))
    }

    pub fn is_cache_hit(&self) -> bool {
        self.result == HomeCacheCheckoutResult::Hit
    }

    pub fn history_proof_binding(&self) -> Option<&HomeCacheHistoryProofBinding> {
        self.history_proof.as_ref()
    }

    /// Invalidate all image-dependent candidates when preparation chooses a pristine retry.
    pub fn discard_cached_image(&mut self) {
        self.source_image = None;
        self.source_pin = None;
        self.history_proof = None;
        self.previous_storage = None;
        self.result = HomeCacheCheckoutResult::Miss;
    }

    pub fn previous_storage(&self) -> Option<&StorageFingerprints> {
        self.previous_storage.as_ref()
    }

    pub fn home_drive_config(&mut self) -> Option<sandbox::HomeDriveConfig> {
        if self.source_image.as_ref().is_some_and(|source| {
            self.source_pin
                .as_ref()
                .is_none_or(|pin| pin.validate_path(source).is_err())
        }) {
            self.discard_cached_image();
        }
        self.home_drive_enabled.then(|| sandbox::HomeDriveConfig {
            size_mb: home_image_size_mb(self.image_size_bytes),
            seed_image: self.source_image.as_ref().map(|source_image| {
                if self.consumed_cache_hit {
                    sandbox::HomeDriveSeedImage::Move(source_image.clone())
                } else {
                    sandbox::HomeDriveSeedImage::Copy(source_image.clone())
                }
            }),
        })
    }

    pub async fn invalidate(&self, run_id: RunId, reason: &str) -> LifecycleResult<bool> {
        let Some(cache_key) = self.cache_key.as_deref() else {
            return Ok(false);
        };
        self.cache
            .invalidate_cache_entry(run_id, cache_key, reason)
            .await
    }

    #[cfg(any(test, feature = "test-support"))]
    pub async fn promote(
        self,
        run_id: RunId,
        terminal_status: HomeCacheTerminalStatus,
        completed_at: String,
        storage_fingerprints: &StorageFingerprints,
    ) -> LifecycleResult<bool> {
        let Some(promotion) = self.into_promotion_context(HomeImagePromotionRequest {
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
        Ok(matches!(outcome, HomeImagePromotionOutcome::Promoted))
    }

    fn promotion_target(&self) -> Option<HomeImagePromotionTarget> {
        if !self.home_drive_enabled
            || !is_safe_guest_working_dir(&self.working_dir)
            || self.rootfs_hash.is_empty()
            || self.image_size_bytes == 0
            || !self.image_size_bytes.is_multiple_of(1024 * 1024)
        {
            return None;
        }

        match self.result {
            HomeCacheCheckoutResult::Hit | HomeCacheCheckoutResult::Miss => {
                Some(HomeImagePromotionTarget {
                    cache_key: self.cache_key.clone()?,
                    reuse_key: self.reuse_key.clone()?,
                })
            }
            HomeCacheCheckoutResult::NoReuseKey => None,
            HomeCacheCheckoutResult::InvalidWorkingDir
            | HomeCacheCheckoutResult::LockBusy
            | HomeCacheCheckoutResult::InvalidMetadata
            | HomeCacheCheckoutResult::DiskPressure => None,
        }
    }

    pub fn into_promotion_context(
        mut self,
        request: HomeImagePromotionRequest<'_>,
    ) -> Option<HomeImagePromotionContext> {
        let HomeImagePromotionRequest {
            run_id,
            sandbox_id,
            restored_session_identity,
            terminal_status,
            completed_at,
            storage_fingerprints,
        } = request;
        let target = self.promotion_target()?;
        let storage_fingerprints = match terminal_status {
            HomeCacheTerminalStatus::Success => storage_fingerprints,
            HomeCacheTerminalStatus::NonzeroExit | HomeCacheTerminalStatus::Cancelled => {
                storage_fingerprints.tainted_paths_including(self.previous_storage.as_ref())
            }
        };

        let mut entry_lock = self.entry_lock.take();
        if let Some(entry_lock) = entry_lock.as_mut() {
            entry_lock.set_owner(HomeCacheLockOwner::Finalizing);
        }

        Some(HomeImagePromotionContext {
            cache: self.cache.clone(),
            cache_key: target.cache_key,
            entry_lock,
            run_id,
            sandbox_id,
            profile_name: self.profile_name.clone(),
            rootfs_hash: self.rootfs_hash.clone(),
            reuse_key: target.reuse_key,
            working_dir: self.working_dir.clone(),
            active_image: self.active_image.clone(),
            image_size_bytes: self.image_size_bytes,
            consumed_cache_hit: self.consumed_cache_hit,
            terminal_status,
            completed_at,
            storage_fingerprints,
            restored_session_identity: restored_session_identity.cloned(),
            history_proof: None,
        })
    }
}

impl HomeImagePromotionContext {
    pub async fn acquire_idle_home_reclamation_permit(
        &self,
    ) -> LifecycleResult<tokio::sync::OwnedSemaphorePermit> {
        self.cache.acquire_idle_home_reclamation_permit().await
    }

    pub fn publication_generation(&self) -> String {
        self.run_id.to_string()
    }

    pub fn set_home_history_proof(
        &mut self,
        binding: Option<HomeCacheHistoryProofBinding>,
    ) -> LifecycleResult<()> {
        self.history_proof = None;
        if let Some(binding) = binding {
            super::metadata::validate_history_binding(&binding, &self.publication_generation())?;
            self.history_proof = Some(binding);
        }
        Ok(())
    }

    pub fn rootfs_hash(&self) -> &str {
        &self.rootfs_hash
    }

    pub fn run_id(&self) -> RunId {
        self.run_id
    }

    pub fn terminal_status(&self) -> HomeCacheTerminalStatus {
        self.terminal_status
    }

    pub fn sandbox_id(&self) -> sandbox::SandboxId {
        self.sandbox_id
    }

    pub fn profile_name(&self) -> &str {
        &self.profile_name
    }

    pub fn reuse_key(&self) -> &str {
        &self.reuse_key
    }

    pub fn restored_session_identity(
        &self,
    ) -> Option<&crate::restored_session_identity::RestoredSessionIdentity> {
        self.restored_session_identity.as_ref()
    }

    pub fn validate_identity(
        &self,
        expected: &HomeImagePromotionIdentity,
    ) -> Result<(), HomeImagePromotionIdentityMismatch> {
        if self.sandbox_id != expected.sandbox_id {
            return Err(HomeImagePromotionIdentityMismatch::SandboxId);
        }
        if self.profile_name != expected.profile_name {
            return Err(HomeImagePromotionIdentityMismatch::ProfileName);
        }
        if self.rootfs_hash != expected.rootfs_hash {
            return Err(HomeImagePromotionIdentityMismatch::RootfsHash);
        }
        if self.reuse_key != expected.reuse_key {
            return Err(HomeImagePromotionIdentityMismatch::ReuseKey);
        }
        if self.working_dir != expected.working_dir {
            return Err(HomeImagePromotionIdentityMismatch::WorkingDir);
        }
        if self.image_size_bytes != expected.image_size_bytes {
            return Err(HomeImagePromotionIdentityMismatch::ImageSizeBytes);
        }
        if self.active_image != expected.active_image {
            return Err(HomeImagePromotionIdentityMismatch::ActiveImage);
        }
        if self.cache_key != expected.cache_key {
            return Err(HomeImagePromotionIdentityMismatch::CacheKey);
        }
        Ok(())
    }

    pub fn validate_expected_identity(
        &self,
        cache: &HomeImageCache,
        request: HomeImagePromotionIdentityRequest<'_>,
    ) -> Result<(), HomeImagePromotionIdentityMismatch> {
        let expected = cache.expected_promotion_identity(request)?;
        self.validate_identity(&expected)
    }

    pub fn validate_stored_cache_identity(
        &self,
        request: HomeImagePromotionIdentityRequest<'_>,
    ) -> Result<(), HomeImagePromotionIdentityMismatch> {
        self.validate_expected_identity(&self.cache, request)
    }

    pub async fn promote(&self) -> LifecycleResult<HomeImagePromotionOutcome> {
        let _late_entry_lock_guard = match self.entry_lock.as_ref() {
            Some(_) => None,
            None => {
                match runner_host::lock::try_acquire(self.cache.entry_lock_path(&self.cache_key))
                    .await
                {
                    Ok(lock) => Some(HomeEntryLock::new(
                        &self.cache,
                        &self.cache_key,
                        lock,
                        HomeCacheLockOwner::Finalizing,
                    )),
                    Err(e) => {
                        info!(
                            run_id = %self.run_id,
                            cache_key = self.cache_key,
                            error = %e,
                            "home image cache promotion skipped: late entry lock unavailable"
                        );
                        return Ok(HomeImagePromotionOutcome::SkippedUnpublished);
                    }
                }
            }
        };

        self.cache
            .promote_locked(HomeImagePromotionInput {
                run_id: self.run_id,
                cache_key: &self.cache_key,
                profile_name: &self.profile_name,
                rootfs_hash: &self.rootfs_hash,
                reuse_key: &self.reuse_key,
                working_dir: &self.working_dir,
                active_image: &self.active_image,
                image_size_bytes: self.image_size_bytes,
                terminal_status: self.terminal_status,
                completed_at: &self.completed_at,
                storage_fingerprints: &self.storage_fingerprints,
                history_proof: self.history_proof.as_ref(),
            })
            .await
    }

    pub async fn abandon_unpublished(self, reason: &str) -> LifecycleResult<bool> {
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
                "home image cache promotion context abandoned without entry lock"
            );
            return Ok(false);
        };
        if consumed_cache_hit {
            return cache
                .invalidate_cache_entry(run_id, &cache_key, reason)
                .await;
        }
        // A miss did not consume the older committed baseline. Preserve it.
        Ok(false)
    }

    pub async fn invalidate_current(self, reason: &str) -> LifecycleResult<bool> {
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
                Ok(lock) => Some(HomeEntryLock::new(
                    &cache,
                    &cache_key,
                    lock,
                    HomeCacheLockOwner::Finalizing,
                )),
                Err(e) => {
                    warn!(
                        run_id = %run_id,
                        cache_key,
                        reason,
                        error = %e,
                        "home image cache baseline invalidation failed: late entry lock unavailable"
                    );
                    return Err(LifecycleError::Internal(format!(
                        "home image cache baseline invalidation lock unavailable: {e}"
                    )));
                }
            },
        };
        if consumed_cache_hit {
            return cache
                .invalidate_cache_entry(run_id, &cache_key, reason)
                .await;
        }
        // A miss did not consume the older committed baseline. Preserve it.
        Ok(false)
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn try_into_active_lease(
        self,
        expected: &HomeImagePromotionIdentity,
        home_drive_available: bool,
    ) -> Result<HomeImageLease, HomeImagePromotionIdentityMismatch> {
        self.validate_identity(expected)?;
        Ok(self.into_active_lease_unchecked(home_drive_available))
    }

    pub fn try_into_active_lease_preserving_context(
        self,
        expected: &HomeImagePromotionIdentity,
        home_drive_available: bool,
    ) -> Result<HomeImageLease, Box<HomeImagePromotionIdentityFailure>> {
        if let Err(mismatch) = self.validate_identity(expected) {
            return Err(Box::new(HomeImagePromotionIdentityFailure {
                promotion: self,
                mismatch,
            }));
        }
        Ok(self.into_active_lease_unchecked(home_drive_available))
    }

    fn into_active_lease_unchecked(self, home_drive_available: bool) -> HomeImageLease {
        let Self {
            cache,
            cache_key,
            mut entry_lock,
            run_id: _,
            sandbox_id: _,
            profile_name,
            rootfs_hash,
            reuse_key,
            working_dir,
            active_image,
            image_size_bytes,
            consumed_cache_hit,
            terminal_status: _,
            completed_at: _,
            storage_fingerprints,
            restored_session_identity: _,
            history_proof: _,
        } = self;
        if let Some(entry_lock) = entry_lock.as_mut() {
            entry_lock.set_owner(HomeCacheLockOwner::Active);
        }
        let base = HomeImageLeaseBase {
            cache,
            profile_name,
            rootfs_hash,
            reuse_key: Some(reuse_key),
            working_dir,
            active_image,
            image_size_bytes,
        };
        HomeImageLease::from_parts(
            base,
            HomeImageLeaseState {
                cache_key: Some(cache_key),
                source_image: None,
                consumed_cache_hit,
                previous_storage: Some(storage_fingerprints),
                history_proof: None,
                entry_lock,
                home_drive_enabled: home_drive_available,
                result: HomeCacheCheckoutResult::Miss,
                lock_decision: None,
            },
        )
    }
}

pub fn cap_held_home_states(states: Vec<HeldHomeState>) -> Vec<HeldHomeState> {
    struct ObservedHomeState {
        last_completed_at: String,
        home_caches: BTreeMap<String, (String, HomeCacheCapability)>,
    }

    let mut by_reuse_key = BTreeMap::<String, ObservedHomeState>::new();
    for state in states {
        let reuse_key = state.reuse_key.clone();
        let observed = by_reuse_key
            .entry(reuse_key)
            .or_insert_with(|| ObservedHomeState {
                last_completed_at: state.last_completed_at.clone(),
                home_caches: BTreeMap::new(),
            });
        if state.last_completed_at > observed.last_completed_at {
            observed.last_completed_at = state.last_completed_at.clone();
        }
        for home_cache in state.home_caches {
            match observed.home_caches.entry(home_cache.profile.clone()) {
                std::collections::btree_map::Entry::Vacant(entry) => {
                    entry.insert((state.last_completed_at.clone(), home_cache));
                }
                std::collections::btree_map::Entry::Occupied(mut entry) => {
                    let (existing_completed_at, existing) = entry.get_mut();
                    let capability_order = home_cache
                        .home_affinity_version
                        .cmp(&existing.home_affinity_version);
                    if capability_order.is_gt()
                        || (capability_order.is_eq()
                            && state.last_completed_at > *existing_completed_at)
                    {
                        *existing_completed_at = state.last_completed_at.clone();
                        *existing = home_cache;
                    }
                }
            }
        }
    }

    let mut states: Vec<HeldHomeState> = by_reuse_key
        .into_iter()
        .map(|(reuse_key, state)| HeldHomeState {
            reuse_key,
            last_completed_at: state.last_completed_at,
            home_caches: state
                .home_caches
                .into_values()
                .map(|(_, home_cache)| home_cache)
                .take(MAX_HOME_CACHES_PER_REUSE_KEY)
                .collect(),
        })
        .collect();
    states.sort_unstable_by(|a, b| {
        b.last_completed_at
            .cmp(&a.last_completed_at)
            .then_with(|| a.reuse_key.cmp(&b.reuse_key))
    });

    let mut retained = Vec::new();
    let mut retained_home_caches = 0;
    for mut state in states {
        if retained.len() == MAX_HELD_HOME_STATES
            || retained_home_caches == MAX_HOME_CACHES_PER_HEARTBEAT
        {
            break;
        }
        let remaining = MAX_HOME_CACHES_PER_HEARTBEAT - retained_home_caches;
        state.home_caches.truncate(remaining);
        if state.home_caches.is_empty() {
            continue;
        }
        retained_home_caches += state.home_caches.len();
        retained.push(state);
    }
    retained.sort_unstable_by(|a, b| a.reuse_key.cmp(&b.reuse_key));
    retained
}
