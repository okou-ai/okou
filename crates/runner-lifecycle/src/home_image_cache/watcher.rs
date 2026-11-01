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
mod tests;
