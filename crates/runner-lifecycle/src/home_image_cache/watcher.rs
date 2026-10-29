use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::os::fd::{AsFd, AsRawFd, RawFd};
use std::path::Path;

use nix::errno::Errno;
use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify, WatchDescriptor};
use tokio::io::unix::AsyncFd;

use crate::error::{LifecycleError, LifecycleResult};
use runner_host::host_file::{self, DirMode};
use runner_types::types::MAX_HELD_HOME_STATES;

use super::entry::is_cache_key_name;
use super::metadata::HomeCacheScopeClassification;
use super::{HomeImageCache, HomeImageCacheInner};

const METADATA_FILE_NAME: &str = "metadata.json";
const CURRENT_IMAGE_FILE_NAME: &str = "current.ext4";

const ROOT_WATCH_FLAGS: AddWatchFlags = AddWatchFlags::IN_CREATE
    .union(AddWatchFlags::IN_MOVED_TO)
    .union(AddWatchFlags::IN_DELETE)
    .union(AddWatchFlags::IN_MOVED_FROM)
    .union(AddWatchFlags::IN_DELETE_SELF)
    .union(AddWatchFlags::IN_MOVE_SELF)
    .union(AddWatchFlags::IN_UNMOUNT)
    .union(AddWatchFlags::IN_ONLYDIR)
    .union(AddWatchFlags::IN_DONT_FOLLOW);

const ENTRY_WATCH_FLAGS: AddWatchFlags = AddWatchFlags::IN_CREATE
    .union(AddWatchFlags::IN_CLOSE_WRITE)
    .union(AddWatchFlags::IN_ATTRIB)
    .union(AddWatchFlags::IN_MOVED_TO)
    .union(AddWatchFlags::IN_DELETE)
    .union(AddWatchFlags::IN_MOVED_FROM)
    .union(AddWatchFlags::IN_DELETE_SELF)
    .union(AddWatchFlags::IN_MOVE_SELF)
    .union(AddWatchFlags::IN_UNMOUNT)
    .union(AddWatchFlags::IN_ONLYDIR)
    .union(AddWatchFlags::IN_DONT_FOLLOW);

const WATCH_INVALIDATION_FLAGS: AddWatchFlags = AddWatchFlags::IN_DELETE_SELF
    .union(AddWatchFlags::IN_MOVE_SELF)
    .union(AddWatchFlags::IN_UNMOUNT)
    .union(AddWatchFlags::IN_IGNORED);
const MAX_EVENT_READ_BATCHES_PER_CHANGE: usize = 16;

/// Advisory cache mutation observed from the host-shared filesystem.
///
/// Named mutations select physical entries for authoritative revalidation;
/// a notification establishes neither scope nor generation availability.
/// The full-reconcile flag records lost completeness independently of hints.
#[derive(Clone, Debug)]
pub struct HomeCacheChange {
    pub observed_at: tokio::time::Instant,
    pub dirty_cache_keys: BTreeSet<String>,
    /// Completeness was lost (overflow, watch loss or saturation). A bounded
    /// keyed update alone cannot reconcile this observation.
    pub requires_full_reconcile: bool,
}

impl HomeCacheChange {
    pub fn merge(&mut self, other: Self) {
        self.observed_at = self.observed_at.min(other.observed_at);
        self.requires_full_reconcile |= other.requires_full_reconcile;
        for cache_key in other.dirty_cache_keys {
            if self.dirty_cache_keys.contains(&cache_key) {
                continue;
            }
            if self.dirty_cache_keys.len() == MAX_HELD_HOME_STATES {
                self.requires_full_reconcile = true;
                break;
            }
            self.dirty_cache_keys.insert(cache_key);
        }
    }
}

#[derive(Default)]
pub(super) struct SelectionReleases {
    pending: std::sync::Mutex<Option<HomeCacheChange>>,
    wake: tokio::sync::Notify,
}

impl HomeImageCacheInner {
    pub(super) fn record_selection_release(&self, key: &str) {
        let mut pending = self
            .selection_releases
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let change = pending.get_or_insert_with(|| HomeCacheChange {
            observed_at: tokio::time::Instant::now(),
            dirty_cache_keys: BTreeSet::new(),
            requires_full_reconcile: false,
        });
        if change.dirty_cache_keys.len() < MAX_HELD_HOME_STATES {
            change.dirty_cache_keys.insert(key.to_owned());
        } else if !change.dirty_cache_keys.contains(key) {
            change.requires_full_reconcile = true;
        }
        drop(pending);
        self.selection_releases.wake.notify_one();
    }

    async fn next_selection_release(&self) -> HomeCacheChange {
        loop {
            let wake = self.selection_releases.wake.notified();
            tokio::pin!(wake);
            wake.as_mut().enable();
            let change = self
                .selection_releases
                .pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            if let Some(change) = change {
                return change;
            }
            wake.await;
        }
    }
}

/// Non-recursive inotify observer for one host-shared home cache.
pub struct HomeCacheWatcher {
    inotify: AsyncFd<AsyncInotify>,
    root_watch: WatchDescriptor,
    entry_by_watch: BTreeMap<WatchDescriptor, WatchedEntry>,
    watch_by_cache_key: BTreeMap<String, WatchDescriptor>,
    cache: HomeImageCache,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EntryWatchState {
    Unclassified,
    Relevant,
}

#[derive(Clone, Debug)]
struct WatchedEntry {
    cache_key: String,
    state: EntryWatchState,
}

#[derive(Default)]
struct EntryWatchUpdate {
    changed: bool,
    requires_full_reconcile: bool,
}

struct AsyncInotify(Inotify);

impl AsRawFd for AsyncInotify {
    fn as_raw_fd(&self) -> RawFd {
        self.0.as_fd().as_raw_fd()
    }
}

impl HomeCacheWatcher {
    pub async fn new(cache: HomeImageCache) -> LifecycleResult<Self> {
        host_file::ensure_dir(
            cache.home_image_cache_dir(),
            DirMode::Private,
            "home image cache root",
        )
        .map_err(|error| watcher_io_error("prepare root", error.kind()))?;
        let inotify = Inotify::init(InitFlags::IN_CLOEXEC | InitFlags::IN_NONBLOCK)
            .map_err(|error| watcher_error("initialize", error))?;
        let root_watch = inotify
            .add_watch(cache.home_image_cache_dir(), ROOT_WATCH_FLAGS)
            .map_err(|error| watcher_error("watch root", error))?;
        // SAFETY: AsyncInotify owns inotify and exposes the same live descriptor until drop.
        let inotify = unsafe { AsyncFd::register(AsyncInotify(inotify)) }.map_err(|error| {
            watcher_io_error("register descriptor", std::io::Error::from(error).kind())
        })?;
        let mut watcher = Self {
            inotify,
            root_watch,
            entry_by_watch: BTreeMap::new(),
            watch_by_cache_key: BTreeMap::new(),
            cache,
        };
        watcher
            .reconcile_all_entry_watches(&mut BTreeSet::new())
            .await?;
        Ok(watcher)
    }

    /// Connects entries accepted by the subscribe-before-scan startup pass to
    /// watcher state before the loaded snapshot can be published. Entries that
    /// were not already relevant when the watcher subscribed return an
    /// advisory change so matching commits retain the existing lock-aware
    /// validation path after their entry watches are installed.
    pub async fn reconcile_initial_relevant_entries(
        &mut self,
        cache_keys: &BTreeSet<String>,
    ) -> LifecycleResult<Option<HomeCacheChange>> {
        let observed_at = tokio::time::Instant::now();
        let mut dirty_cache_keys = BTreeSet::new();
        let mut requires_refresh = false;
        let mut requires_full_reconcile = false;
        for cache_key in cache_keys {
            match self.entry_watch_state(cache_key) {
                Some(EntryWatchState::Relevant) => {}
                Some(EntryWatchState::Unclassified) => {
                    requires_refresh = true;
                    let metadata_path = self.cache.home_image_cache_metadata(cache_key);
                    self.classify_metadata_commit(cache_key, &metadata_path, &mut dirty_cache_keys)
                        .await;
                }
                None => {
                    requires_refresh = true;
                    let update = self
                        .add_entry_watch(cache_key.clone(), &mut dirty_cache_keys)
                        .await?;
                    requires_full_reconcile |= update.requires_full_reconcile;
                }
            }
        }
        let missing_watches = cache_keys
            .iter()
            .any(|cache_key| self.entry_watch_state(cache_key) != Some(EntryWatchState::Relevant));
        requires_refresh |= missing_watches;
        Ok(requires_refresh.then_some(HomeCacheChange {
            observed_at,
            requires_full_reconcile: requires_full_reconcile
                || missing_watches
                || dirty_cache_keys.is_empty(),
            dirty_cache_keys,
        }))
    }

    /// Waits for and coalesces all currently readable relevant mutations.
    pub async fn next_change(&mut self) -> LifecycleResult<HomeCacheChange> {
        loop {
            // Race only before draining kernel events. Cancelling asynchronous
            // classification after draining would lose an ordinary mutation.
            let mut ready = tokio::select! {
                change = self.cache.inner.next_selection_release() => return Ok(change),
                ready = self.inotify.readable() => ready
                    .map_err(|error| watcher_io_error("wait for events", error.kind()))?,
            };

            let observed_at = tokio::time::Instant::now();
            let mut pending_events = Vec::new();
            let mut drained_all_events = false;
            for _ in 0..MAX_EVENT_READ_BATCHES_PER_CHANGE {
                match self.inotify.get_ref().0.read_events() {
                    Ok(events) => pending_events.extend(events),
                    Err(Errno::EAGAIN) => {
                        drained_all_events = true;
                        break;
                    }
                    Err(error) => return Err(watcher_error("read events", error)),
                }
            }
            if drained_all_events {
                ready.clear_ready();
            }
            drop(ready);

            let mut changed = false;
            let mut requires_full_reconcile = false;
            let mut reconcile_all_entry_watches = false;
            let mut dirty_cache_keys = BTreeSet::new();
            let mut metadata_commit_keys = BTreeSet::new();
            let mut new_cache_keys = BTreeSet::new();
            for event in pending_events {
                if event.mask.contains(AddWatchFlags::IN_Q_OVERFLOW) {
                    changed = true;
                    requires_full_reconcile = true;
                    reconcile_all_entry_watches = true;
                    continue;
                }
                if event.wd == self.root_watch {
                    if event.mask.intersects(WATCH_INVALIDATION_FLAGS) {
                        return Err(LifecycleError::Internal(
                            "home cache root watch invalidated".to_string(),
                        ));
                    }
                    let Some(cache_key) = event
                        .name
                        .as_deref()
                        .and_then(OsStr::to_str)
                        .filter(|name| is_cache_key_name(name))
                    else {
                        continue;
                    };
                    if event
                        .mask
                        .intersects(AddWatchFlags::IN_CREATE | AddWatchFlags::IN_MOVED_TO)
                    {
                        if new_cache_keys.len() < MAX_HELD_HOME_STATES {
                            new_cache_keys.insert(cache_key.to_owned());
                        } else if !new_cache_keys.contains(cache_key) {
                            requires_full_reconcile = true;
                        }
                    }
                    if event
                        .mask
                        .intersects(AddWatchFlags::IN_DELETE | AddWatchFlags::IN_MOVED_FROM)
                        && self.forget_entry_watch(cache_key) == Some(EntryWatchState::Relevant)
                    {
                        changed = true;
                        if dirty_cache_keys.len() < MAX_HELD_HOME_STATES
                            || dirty_cache_keys.contains(cache_key)
                        {
                            dirty_cache_keys.insert(cache_key.to_owned());
                        } else {
                            requires_full_reconcile = true;
                        }
                    }
                    continue;
                }
                let Some(entry) = self.entry_by_watch.get(&event.wd).cloned() else {
                    continue;
                };
                if event.mask.intersects(WATCH_INVALIDATION_FLAGS) {
                    if self.forget_watch_descriptor(event.wd) == Some(EntryWatchState::Relevant) {
                        changed = true;
                        if dirty_cache_keys.len() < MAX_HELD_HOME_STATES
                            || dirty_cache_keys.contains(&entry.cache_key)
                        {
                            dirty_cache_keys.insert(entry.cache_key);
                        } else {
                            requires_full_reconcile = true;
                        }
                    }
                    requires_full_reconcile |= event
                        .mask
                        .intersects(AddWatchFlags::IN_UNMOUNT | AddWatchFlags::IN_IGNORED);
                    continue;
                }
                let Some(name) = event.name.as_deref().and_then(OsStr::to_str) else {
                    // Entry-directory attributes have no child name. Reclassify
                    // the known key instead of losing an access/authority change.
                    if metadata_commit_keys.len() < MAX_HELD_HOME_STATES
                        || metadata_commit_keys.contains(&entry.cache_key)
                    {
                        metadata_commit_keys.insert(entry.cache_key);
                    } else {
                        requires_full_reconcile = true;
                    }
                    continue;
                };
                if name == METADATA_FILE_NAME {
                    if metadata_commit_keys.len() < MAX_HELD_HOME_STATES
                        || metadata_commit_keys.contains(&entry.cache_key)
                    {
                        metadata_commit_keys.insert(entry.cache_key);
                    } else {
                        requires_full_reconcile = true;
                    }
                } else if (name == CURRENT_IMAGE_FILE_NAME
                    || super::entry::image_generation(name).is_some())
                    && entry.state == EntryWatchState::Relevant
                {
                    changed = true;
                    if dirty_cache_keys.len() < MAX_HELD_HOME_STATES
                        || dirty_cache_keys.contains(&entry.cache_key)
                    {
                        dirty_cache_keys.insert(entry.cache_key);
                    } else {
                        requires_full_reconcile = true;
                    }
                }
            }
            for cache_key in new_cache_keys {
                let update = self
                    .add_entry_watch(cache_key, &mut dirty_cache_keys)
                    .await?;
                changed |= update.changed;
                requires_full_reconcile |= update.requires_full_reconcile;
            }
            for cache_key in metadata_commit_keys {
                let previous = self.entry_watch_state(&cache_key);
                let metadata_path = self.cache.home_image_cache_metadata(&cache_key);
                let relevant = self
                    .classify_metadata_commit(&cache_key, &metadata_path, &mut dirty_cache_keys)
                    .await;
                changed |= relevant;
                if relevant || previous == Some(EntryWatchState::Relevant) {
                    if dirty_cache_keys.len() < MAX_HELD_HOME_STATES
                        || dirty_cache_keys.contains(&cache_key)
                    {
                        dirty_cache_keys.insert(cache_key);
                    } else {
                        requires_full_reconcile = true;
                    }
                }
            }
            if reconcile_all_entry_watches {
                self.reconcile_all_entry_watches(&mut dirty_cache_keys)
                    .await?;
            }
            if changed || requires_full_reconcile || !dirty_cache_keys.is_empty() {
                return Ok(HomeCacheChange {
                    observed_at,
                    dirty_cache_keys,
                    requires_full_reconcile,
                });
            }
            if !drained_all_events {
                // Preserve descriptor readiness for queued events while giving
                // the reactor a scheduling point between bounded read batches.
                tokio::task::yield_now().await;
            }
        }
    }

    async fn reconcile_all_entry_watches(
        &mut self,
        dirty_cache_keys: &mut BTreeSet<String>,
    ) -> LifecycleResult<()> {
        let stale_cache_keys = self
            .watch_by_cache_key
            .keys()
            .filter(|cache_key| {
                match std::fs::symlink_metadata(self.cache.home_image_cache_entry_dir(cache_key)) {
                    Ok(metadata) => !metadata.is_dir(),
                    Err(_) => true,
                }
            })
            .cloned()
            .collect::<Vec<_>>();
        for cache_key in stale_cache_keys {
            self.forget_entry_watch(&cache_key);
        }

        let watched_cache_keys = self.watch_by_cache_key.keys().cloned().collect::<Vec<_>>();
        for cache_key in watched_cache_keys {
            let metadata_path = self.cache.home_image_cache_metadata(&cache_key);
            self.classify_metadata_commit(&cache_key, &metadata_path, dirty_cache_keys)
                .await;
        }

        if self.watch_by_cache_key.len() == MAX_HELD_HOME_STATES {
            return Ok(());
        }
        let entries = std::fs::read_dir(self.cache.home_image_cache_dir())
            .map_err(|error| watcher_io_error("scan entries", error.kind()))?;
        self.reconcile_entry_watches(entries, dirty_cache_keys)
            .await
    }

    async fn reconcile_entry_watches(
        &mut self,
        entries: impl Iterator<Item = std::io::Result<std::fs::DirEntry>>,
        dirty_cache_keys: &mut BTreeSet<String>,
    ) -> LifecycleResult<()> {
        for entry in entries {
            if self.watch_by_cache_key.len() == MAX_HELD_HOME_STATES {
                break;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(watcher_io_error("read entry", error.kind())),
            };
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(watcher_io_error("read entry type", error.kind())),
            };
            if !file_type.is_dir() {
                continue;
            }
            let Some(cache_key) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !is_cache_key_name(&cache_key) {
                continue;
            }
            if self.watch_by_cache_key.contains_key(&cache_key) {
                continue;
            }
            self.add_entry_watch(cache_key, dirty_cache_keys).await?;
        }
        Ok(())
    }

    fn entry_is_watchable(entry_dir: &Path) -> LifecycleResult<bool> {
        match std::fs::symlink_metadata(entry_dir) {
            Ok(metadata) => Ok(metadata.is_dir()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(watcher_io_error("inspect entry", error.kind())),
        }
    }

    async fn add_entry_watch(
        &mut self,
        cache_key: String,
        dirty_cache_keys: &mut BTreeSet<String>,
    ) -> LifecycleResult<EntryWatchUpdate> {
        if self.watch_by_cache_key.contains_key(&cache_key) {
            return Ok(EntryWatchUpdate::default());
        }
        let entry_dir = self.cache.home_image_cache_entry_dir(&cache_key);
        if !Self::entry_is_watchable(&entry_dir)? {
            return Ok(EntryWatchUpdate::default());
        }
        let watch = match self
            .inotify
            .get_ref()
            .0
            .add_watch(&entry_dir, ENTRY_WATCH_FLAGS)
        {
            Ok(watch) => watch,
            Err(Errno::ENOENT | Errno::ENOTDIR | Errno::ELOOP) => {
                return Ok(EntryWatchUpdate::default());
            }
            Err(error) => return Err(watcher_error("watch entry", error)),
        };
        self.entry_by_watch.insert(
            watch,
            WatchedEntry {
                cache_key: cache_key.clone(),
                state: EntryWatchState::Unclassified,
            },
        );
        self.watch_by_cache_key.insert(cache_key.clone(), watch);
        let metadata_path = self.cache.home_image_cache_metadata(&cache_key);
        let changed = self
            .classify_metadata_commit(&cache_key, &metadata_path, dirty_cache_keys)
            .await;
        // Foreign entries consume neither watch nor dirty-key capacity. Track
        // actual eviction or dropped relevant hints after classification.
        let evicts_watch = self.watch_by_cache_key.len() > MAX_HELD_HOME_STATES;
        self.enforce_watch_limit(&cache_key);
        if !self.watch_by_cache_key.contains_key(&cache_key) {
            dirty_cache_keys.remove(&cache_key);
        }
        Ok(EntryWatchUpdate {
            changed: changed && self.watch_by_cache_key.contains_key(&cache_key),
            requires_full_reconcile: evicts_watch
                || (changed && !dirty_cache_keys.contains(&cache_key)),
        })
    }

    async fn classify_metadata_commit(
        &mut self,
        cache_key: &str,
        metadata_path: &Path,
        dirty_cache_keys: &mut BTreeSet<String>,
    ) -> bool {
        let Some(previous_state) = self.entry_watch_state(cache_key) else {
            return false;
        };
        match self
            .cache
            .classify_metadata_scope(cache_key, metadata_path)
            .await
        {
            HomeCacheScopeClassification::Relevant => {
                self.set_entry_watch_state(cache_key, EntryWatchState::Relevant);
                if dirty_cache_keys.len() < MAX_HELD_HOME_STATES {
                    dirty_cache_keys.insert(cache_key.to_owned());
                }
                true
            }
            HomeCacheScopeClassification::Foreign => {
                self.forget_entry_watch(cache_key);
                previous_state == EntryWatchState::Relevant
            }
            HomeCacheScopeClassification::Unclassified => {
                self.set_entry_watch_state(cache_key, EntryWatchState::Unclassified);
                previous_state == EntryWatchState::Relevant
            }
        }
    }

    fn enforce_watch_limit(&mut self, preferred_cache_key: &str) {
        while self.watch_by_cache_key.len() > MAX_HELD_HOME_STATES {
            let preferred_state = self.entry_watch_state(preferred_cache_key);
            let evicted_cache_key = self
                .watch_by_cache_key
                .keys()
                .find(|cache_key| {
                    cache_key.as_str() != preferred_cache_key
                        && self.entry_watch_state(cache_key) == Some(EntryWatchState::Unclassified)
                })
                .cloned()
                .or_else(|| {
                    (preferred_state == Some(EntryWatchState::Unclassified))
                        .then(|| preferred_cache_key.to_owned())
                })
                .or_else(|| {
                    self.watch_by_cache_key
                        .keys()
                        .find(|cache_key| cache_key.as_str() != preferred_cache_key)
                        .cloned()
                });
            let Some(evicted_cache_key) = evicted_cache_key else {
                break;
            };
            self.forget_entry_watch(&evicted_cache_key);
        }
    }

    fn entry_watch_state(&self, cache_key: &str) -> Option<EntryWatchState> {
        let watch = self.watch_by_cache_key.get(cache_key)?;
        self.entry_by_watch.get(watch).map(|entry| entry.state)
    }

    fn set_entry_watch_state(&mut self, cache_key: &str, state: EntryWatchState) {
        let Some(watch) = self.watch_by_cache_key.get(cache_key) else {
            return;
        };
        if let Some(entry) = self.entry_by_watch.get_mut(watch) {
            entry.state = state;
        }
    }

    fn forget_entry_watch(&mut self, cache_key: &str) -> Option<EntryWatchState> {
        if let Some(watch) = self.watch_by_cache_key.remove(cache_key) {
            let state = self.entry_by_watch.remove(&watch).map(|entry| entry.state);
            let _ = self.inotify.get_ref().0.rm_watch(watch);
            return state;
        }
        None
    }

    fn forget_watch_descriptor(&mut self, watch: WatchDescriptor) -> Option<EntryWatchState> {
        let state = if let Some(entry) = self.entry_by_watch.remove(&watch) {
            self.watch_by_cache_key.remove(&entry.cache_key);
            Some(entry.state)
        } else {
            None
        };
        let _ = self.inotify.get_ref().0.rm_watch(watch);
        state
    }
}

fn watcher_error(action: &str, error: Errno) -> LifecycleError {
    LifecycleError::Internal(format!("home cache watcher {action}: {error}"))
}

fn watcher_io_error(action: &str, kind: std::io::ErrorKind) -> LifecycleError {
    LifecycleError::Internal(format!("home cache watcher {action}: {kind:?}"))
}

#[cfg(test)]
mod tests {
    use super::super::fs::allocated_bytes;
    use super::super::metadata::{
        HomeCacheMetadata, HomeCacheState, HomeImageFileIdentity, HomeTrust,
    };
    use super::super::{CACHE_FORMAT_VERSION, HOME_DRIVE_LAYOUT, HomeCacheTerminalStatus};
    use super::*;
    use crate::storage_fingerprints::StorageFingerprints;
    use runner_host::paths::{HomePaths, RunnerPaths};
    use runner_types::ids::RunId;

    const TEST_PROFILE_NAME: &str = "vm0/default";
    const TEST_WORKING_DIR: &str = "/home/user/workspace";
    const TEST_ROOTFS: &str = "test-rootfs";

    async fn create_watch_limit_entries(cache: &HomeImageCache) {
        let root = cache.home_image_cache_dir().to_path_buf();
        // These fresh empty entries only fill the watch budget. Prepare them
        // before any watcher exists, without repeated recovery/path walks.
        tokio::task::spawn_blocking(move || {
            use runner_host::host_file::PRIVATE_DIR_MODE;
            use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

            host_file::ensure_dir(&root, DirMode::Private, "watch-limit fixture root").unwrap();
            for index in 0..MAX_HELD_HOME_STATES {
                let entry = root.join(format!("{index:064x}"));
                std::fs::DirBuilder::new()
                    .mode(PRIVATE_DIR_MODE)
                    .create(&entry)
                    .unwrap();
                std::fs::set_permissions(&entry, std::fs::Permissions::from_mode(PRIVATE_DIR_MODE))
                    .unwrap();
            }
        })
        .await
        .unwrap();
    }

    async fn commit_entry(cache: &HomeImageCache, reuse_key: &str) -> String {
        let image = format!("image-{reuse_key}");
        let cache_key = cache.scoped_cache_key(TEST_PROFILE_NAME, reuse_key, image.len() as u64);
        cache.ensure_home_cache_entry_dir(&cache_key).await.unwrap();
        let run_id = RunId::new_v4();
        let current_image = cache
            .entry_paths(&cache_key)
            .image(&run_id.to_string())
            .unwrap();
        tokio::fs::write(&current_image, image).await.unwrap();
        let current_metadata = tokio::fs::metadata(&current_image).await.unwrap();
        cache
            .write_metadata(
                &cache_key,
                run_id,
                HomeCacheMetadata {
                    format_version: CACHE_FORMAT_VERSION,
                    cache_scope: cache.inner.cache_scope.clone(),
                    profile_name: TEST_PROFILE_NAME.into(),
                    rootfs_hash: TEST_ROOTFS.into(),
                    fingerprint_scope: "/home/user".into(),
                    image_generation: run_id.to_string(),
                    history_proof: None,
                    reuse_key: reuse_key.into(),
                    working_dir: TEST_WORKING_DIR.into(),
                    last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                    last_used_at: "2026-05-01T00:00:00.000Z".into(),
                    last_terminal_status: HomeCacheTerminalStatus::Success,
                    home_trust: HomeTrust::Clean,
                    logical_image_size_bytes: current_metadata.len(),
                    allocated_bytes: allocated_bytes(&current_metadata),
                    current_image: HomeImageFileIdentity::from_metadata(&current_metadata),
                    drive_layout: HOME_DRIVE_LAYOUT.into(),
                    storage_fingerprints: StorageFingerprints::default(),
                    state: HomeCacheState::Current,
                },
            )
            .await
            .unwrap();
        cache_key
    }

    #[tokio::test]
    async fn entry_directory_attribute_changes_revalidate_the_known_key() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let cache = HomeImageCache::new(RunnerPaths::new(temp.path().join("runner")));
        let key = commit_entry(&cache, "directory-attributes").await;
        let mut watcher = HomeCacheWatcher::new(cache.clone()).await.unwrap();
        std::fs::set_permissions(
            cache.home_image_cache_entry_dir(&key),
            std::fs::Permissions::from_mode(0o750),
        )
        .unwrap();
        let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(change.dirty_cache_keys, BTreeSet::from([key]));
        assert!(!change.requires_full_reconcile);
    }

    #[tokio::test]
    async fn reports_metadata_commit_and_removal_from_existing_entry() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(temp.path().join("runner"));
        let cache = HomeImageCache::new(paths);
        let cache_key = cache.scoped_cache_key(
            TEST_PROFILE_NAME,
            "existing-entry",
            b"image-existing-entry".len() as u64,
        );
        cache.ensure_home_cache_entry_dir(&cache_key).await.unwrap();
        let mut watcher = HomeCacheWatcher::new(cache.clone()).await.unwrap();

        assert_eq!(commit_entry(&cache, "existing-entry").await, cache_key);
        let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(change.dirty_cache_keys, BTreeSet::from([cache_key.clone()]));

        tokio::fs::remove_file(cache.home_image_cache_metadata(&cache_key))
            .await
            .unwrap();
        let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(change.dirty_cache_keys, BTreeSet::from([cache_key]));
        assert!(!change.requires_full_reconcile);
    }

    #[tokio::test]
    async fn newly_created_entry_with_committed_metadata_is_not_lost() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(temp.path().join("runner"));
        let cache = HomeImageCache::new(paths);
        let mut watcher = HomeCacheWatcher::new(cache.clone()).await.unwrap();
        let cache_key = commit_entry(&cache, "new-entry").await;

        let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(change.dirty_cache_keys, BTreeSet::from([cache_key]));
    }

    #[tokio::test]
    async fn startup_reconciliation_preserves_matching_key_and_reports_missing_watch() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(temp.path().join("runner"));
        let cache = HomeImageCache::new(paths);
        let mut watcher = HomeCacheWatcher::new(cache.clone()).await.unwrap();
        let cache_key = commit_entry(&cache, "startup-reconciliation").await;

        let change = watcher
            .reconcile_initial_relevant_entries(&BTreeSet::from([
                cache_key.clone(),
                "a".repeat(64),
            ]))
            .await
            .unwrap()
            .expect("newly classified startup entry should require reconciliation");

        assert_eq!(change.dirty_cache_keys, BTreeSet::from([cache_key]));
        assert!(change.requires_full_reconcile);
    }

    #[tokio::test]
    async fn startup_reconciliation_reports_eviction_at_the_watch_limit() {
        let temp = tempfile::tempdir().unwrap();
        let cache = HomeImageCache::new(RunnerPaths::new(temp.path().join("runner")));
        create_watch_limit_entries(&cache).await;
        let mut watcher = HomeCacheWatcher::new(cache.clone()).await.unwrap();
        let cache_key = commit_entry(&cache, "startup-at-limit").await;
        let change = watcher
            .reconcile_initial_relevant_entries(&BTreeSet::from([cache_key.clone()]))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(change.dirty_cache_keys, BTreeSet::from([cache_key.clone()]));
        assert!(
            change.requires_full_reconcile,
            "startup handoff must preserve actual watch-eviction completeness loss"
        );
        assert_eq!(watcher.watch_by_cache_key.len(), MAX_HELD_HOME_STATES);
        assert!(watcher.watch_by_cache_key.contains_key(&cache_key));
    }

    #[tokio::test]
    async fn bounded_drain_preserves_readiness_for_remaining_events() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(temp.path().join("runner"));
        let cache = HomeImageCache::new(paths);
        let cache_key = cache.scoped_cache_key(
            TEST_PROFILE_NAME,
            "bounded-drain",
            b"image-bounded-drain".len() as u64,
        );
        cache.ensure_home_cache_entry_dir(&cache_key).await.unwrap();
        let entry_dir = cache.home_image_cache_entry_dir(&cache_key);

        for index in 0..5_000 {
            tokio::fs::write(entry_dir.join(format!("noise-{index:04}")), b"")
                .await
                .unwrap();
        }
        let mut watcher = HomeCacheWatcher::new(cache.clone()).await.unwrap();
        for index in 0..5_000 {
            tokio::fs::remove_file(entry_dir.join(format!("noise-{index:04}")))
                .await
                .unwrap();
        }
        assert_eq!(commit_entry(&cache, "bounded-drain").await, cache_key);

        let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(change.dirty_cache_keys, BTreeSet::from([cache_key]));
    }

    #[tokio::test]
    async fn newly_created_entry_replaces_an_existing_watch_at_the_limit() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(temp.path().join("runner"));
        let cache = HomeImageCache::new(paths);
        create_watch_limit_entries(&cache).await;
        let mut watcher = HomeCacheWatcher::new(cache.clone()).await.unwrap();
        assert_eq!(watcher.watch_by_cache_key.len(), MAX_HELD_HOME_STATES);

        let cache_key = commit_entry(&cache, "preferred-new-entry").await;

        let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(change.dirty_cache_keys, BTreeSet::from([cache_key.clone()]));
        assert_eq!(watcher.watch_by_cache_key.len(), MAX_HELD_HOME_STATES);
        assert!(watcher.watch_by_cache_key.contains_key(&cache_key));
    }

    #[tokio::test]
    async fn create_and_remove_in_one_batch_does_not_leave_a_stale_watch() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(temp.path().join("runner"));
        let cache = HomeImageCache::new(paths);
        let mut watcher = HomeCacheWatcher::new(cache.clone()).await.unwrap();
        let cache_key = "e".repeat(64);
        let entry_dir = cache.home_image_cache_entry_dir(&cache_key);

        tokio::fs::create_dir_all(&entry_dir).await.unwrap();
        tokio::fs::remove_dir(&entry_dir).await.unwrap();
        let relevant_cache_key = commit_entry(&cache, "post-create-remove").await;

        let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            change.dirty_cache_keys,
            BTreeSet::from([relevant_cache_key])
        );
        assert!(!watcher.watch_by_cache_key.contains_key(&cache_key));
    }

    #[tokio::test]
    async fn foreign_scope_commit_and_removal_do_not_report_changes() {
        let temp = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(temp.path().join("home"));
        let observer_paths = RunnerPaths::new(temp.path().join("observer"));
        let publisher_paths = RunnerPaths::new(temp.path().join("publisher"));
        tokio::fs::create_dir_all(observer_paths.base_dir())
            .await
            .unwrap();
        tokio::fs::create_dir_all(publisher_paths.base_dir())
            .await
            .unwrap();
        let observer = HomeImageCache::shared(observer_paths, &home, "group-a");
        let publisher = HomeImageCache::shared(publisher_paths, &home, "group-b");
        let mut watcher = HomeCacheWatcher::new(observer.clone()).await.unwrap();

        let foreign_cache_key = commit_entry(&publisher, "foreign-entry").await;
        let relevant_cache_key = commit_entry(&observer, "relevant-entry").await;

        let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            change.dirty_cache_keys,
            BTreeSet::from([relevant_cache_key])
        );
        assert!(!watcher.watch_by_cache_key.contains_key(&foreign_cache_key));

        tokio::fs::remove_dir_all(publisher.home_image_cache_entry_dir(&foreign_cache_key))
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), watcher.next_change())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn foreign_scope_commit_does_not_wake_observer() {
        let temp = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(temp.path().join("home"));
        let observer_paths = RunnerPaths::new(temp.path().join("observer"));
        let publisher_paths = RunnerPaths::new(temp.path().join("publisher"));
        tokio::fs::create_dir_all(observer_paths.base_dir())
            .await
            .unwrap();
        tokio::fs::create_dir_all(publisher_paths.base_dir())
            .await
            .unwrap();
        let observer = HomeImageCache::shared(observer_paths, &home, "group-a");
        let publisher = HomeImageCache::shared(publisher_paths, &home, "group-b");
        let mut watcher = HomeCacheWatcher::new(observer.clone()).await.unwrap();

        let foreign_cache_key = commit_entry(&publisher, "foreign-only-entry").await;

        let mut next_change = Box::pin(watcher.next_change());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut next_change)
                .await
                .is_err()
        );
        let relevant_cache_key = commit_entry(&observer, "relevant-entry").await;
        let change = tokio::time::timeout(std::time::Duration::from_secs(2), &mut next_change)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            change.dirty_cache_keys,
            BTreeSet::from([relevant_cache_key])
        );
        drop(next_change);
        assert!(!watcher.watch_by_cache_key.contains_key(&foreign_cache_key));
    }

    #[tokio::test]
    async fn foreign_scope_commit_does_not_request_reconciliation_at_the_watch_limit() {
        let temp = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(temp.path().join("home"));
        let observer_paths = RunnerPaths::new(temp.path().join("observer"));
        let publisher_paths = RunnerPaths::new(temp.path().join("publisher"));
        tokio::fs::create_dir_all(observer_paths.base_dir())
            .await
            .unwrap();
        tokio::fs::create_dir_all(publisher_paths.base_dir())
            .await
            .unwrap();
        let observer = HomeImageCache::shared(observer_paths, &home, "group-a");
        let publisher = HomeImageCache::shared(publisher_paths, &home, "group-b");
        create_watch_limit_entries(&observer).await;
        let mut watcher = HomeCacheWatcher::new(observer.clone()).await.unwrap();
        assert_eq!(watcher.watch_by_cache_key.len(), MAX_HELD_HOME_STATES);
        let foreign_cache_key = commit_entry(&publisher, "foreign-at-limit").await;

        let mut next_change = Box::pin(watcher.next_change());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut next_change)
                .await
                .is_err(),
            "a classified foreign entry does not lose relevant tracking completeness"
        );
        let relevant_cache_key = commit_entry(&observer, "relevant-at-limit").await;
        let change = tokio::time::timeout(std::time::Duration::from_secs(2), &mut next_change)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            change.dirty_cache_keys,
            BTreeSet::from([relevant_cache_key])
        );
        assert!(
            change.requires_full_reconcile,
            "a relevant entry replacing an existing watch still loses completeness"
        );
        drop(next_change);
        assert_eq!(watcher.watch_by_cache_key.len(), MAX_HELD_HOME_STATES);
        assert!(!watcher.watch_by_cache_key.contains_key(&foreign_cache_key));
    }

    #[tokio::test]
    async fn existing_foreign_entries_do_not_consume_watch_budget() {
        let temp = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(temp.path().join("home"));
        let observer_paths = RunnerPaths::new(temp.path().join("observer"));
        let publisher_paths = RunnerPaths::new(temp.path().join("publisher"));
        tokio::fs::create_dir_all(observer_paths.base_dir())
            .await
            .unwrap();
        tokio::fs::create_dir_all(publisher_paths.base_dir())
            .await
            .unwrap();
        let observer = HomeImageCache::shared(observer_paths, &home, "group-a");
        let publisher = HomeImageCache::shared(publisher_paths, &home, "group-b");
        let foreign_cache_key = commit_entry(&publisher, "existing-foreign-entry").await;

        let watcher = HomeCacheWatcher::new(observer).await.unwrap();

        assert!(!watcher.watch_by_cache_key.contains_key(&foreign_cache_key));
        assert!(watcher.watch_by_cache_key.is_empty());
    }

    #[tokio::test]
    async fn reconciliation_scans_past_irrelevant_raw_entry_limit() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(temp.path().join("runner"));
        let cache = HomeImageCache::new(paths);
        let mut watcher = HomeCacheWatcher::new(cache.clone()).await.unwrap();

        for index in 0..MAX_HELD_HOME_STATES {
            std::fs::create_dir(
                cache
                    .home_image_cache_dir()
                    .join(format!("irrelevant-{index:04}")),
            )
            .unwrap();
        }
        let relevant_cache_key = cache.scoped_cache_key(
            TEST_PROFILE_NAME,
            "relevant-after-raw-limit",
            b"image-relevant-after-raw-limit".len() as u64,
        );
        cache
            .ensure_home_cache_entry_dir(&relevant_cache_key)
            .await
            .unwrap();

        let mut entries = std::fs::read_dir(cache.home_image_cache_dir())
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        entries.sort_by_key(|entry| entry.file_name() == OsStr::new(&relevant_cache_key));
        assert_eq!(entries.len(), MAX_HELD_HOME_STATES + 1);
        assert_eq!(
            entries.last().unwrap().file_name(),
            OsStr::new(&relevant_cache_key)
        );

        watcher
            .reconcile_entry_watches(entries.into_iter().map(Ok), &mut BTreeSet::new())
            .await
            .unwrap();

        assert!(watcher.watch_by_cache_key.contains_key(&relevant_cache_key));
        assert_eq!(watcher.watch_by_cache_key.len(), 1);

        assert_eq!(
            commit_entry(&cache, "relevant-after-raw-limit").await,
            relevant_cache_key
        );
        let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            change.dirty_cache_keys,
            BTreeSet::from([relevant_cache_key])
        );
    }

    #[tokio::test]
    async fn setup_error_does_not_expose_cache_path() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(temp.path().join("runner"));
        let cache = HomeImageCache::new(paths);
        let cache_root = cache.home_image_cache_dir().to_path_buf();
        std::fs::create_dir_all(cache_root.parent().unwrap()).unwrap();
        std::fs::write(&cache_root, b"not a directory").unwrap();

        let error = match HomeCacheWatcher::new(cache).await {
            Ok(_) => panic!("watcher setup should reject a non-directory cache root"),
            Err(error) => error,
        };
        let message = error.to_string();

        assert!(message.contains("home cache watcher prepare root"));
        assert!(!message.contains(&cache_root.display().to_string()));
    }

    #[tokio::test]
    async fn unused_release_overflow_requests_full_reconciliation_with_bounded_hints() {
        let temp = tempfile::tempdir().unwrap();
        let cache = HomeImageCache::new(RunnerPaths::new(temp.path().join("runner")));
        let mut watcher = HomeCacheWatcher::new(cache.clone()).await.unwrap();
        for key in 0..=MAX_HELD_HOME_STATES {
            cache.inner.record_selection_release(&format!("{key:064x}"));
        }
        let change = watcher.next_change().await.unwrap();
        assert!(change.requires_full_reconcile);
        assert_eq!(change.dirty_cache_keys.len(), MAX_HELD_HOME_STATES);
        // Hints never advertise nonexistent commits, even after saturation.
        let updates = cache
            .revalidate_home_cache_keys(
                &BTreeMap::from([(TEST_PROFILE_NAME, 1024 * 1024)]),
                &change.dirty_cache_keys,
            )
            .await;
        assert!(updates.entries.values().all(Option::is_none));
        let oversized = (0..=MAX_HELD_HOME_STATES)
            .map(|key| format!("{key:064x}"))
            .collect();
        let updates = cache
            .revalidate_home_cache_keys(
                &BTreeMap::from([(TEST_PROFILE_NAME, 1024 * 1024)]),
                &oversized,
            )
            .await;
        assert!(
            updates.incomplete,
            "a capped validation cannot claim complete coverage"
        );
        assert!(updates.entries.is_empty());
        let snapshot = super::super::snapshot::HomeCacheStateSnapshot::new();
        let token = snapshot.begin_home_cache_refresh();
        assert!(
            snapshot
                .finish_home_cache_key_updates(token, updates)
                .needs_reconcile
        );
    }

    #[test]
    fn coalesced_batches_keep_first_observation_and_report_key_saturation() {
        let first_observation = tokio::time::Instant::now();
        let mut change = HomeCacheChange {
            observed_at: first_observation,
            dirty_cache_keys: (0..MAX_HELD_HOME_STATES)
                .map(|key| format!("{key:064x}"))
                .collect(),
            requires_full_reconcile: false,
        };
        change.merge(HomeCacheChange {
            observed_at: first_observation + std::time::Duration::from_secs(1),
            dirty_cache_keys: BTreeSet::from([format!("{:064x}", 0)]),
            requires_full_reconcile: false,
        });
        assert!(
            !change.requires_full_reconcile,
            "a duplicate does not lose completeness"
        );
        change.merge(HomeCacheChange {
            observed_at: first_observation + std::time::Duration::from_secs(3),
            dirty_cache_keys: BTreeSet::from([format!("{MAX_HELD_HOME_STATES:064x}")]),
            requires_full_reconcile: false,
        });
        assert_eq!(
            change.observed_at, first_observation,
            "coalescing must preserve the original observation for latency attribution"
        );
        assert!(change.requires_full_reconcile);
        assert_eq!(change.dirty_cache_keys.len(), MAX_HELD_HOME_STATES);
    }
}
