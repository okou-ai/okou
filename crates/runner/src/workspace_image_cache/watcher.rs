use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::os::fd::{AsFd, AsRawFd, RawFd};
use std::path::Path;

use nix::errno::Errno;
use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify, WatchDescriptor};
use tokio::io::unix::AsyncFd;

use crate::error::{RunnerError, RunnerResult};
use crate::host_file::{self, DirMode};
use runner_types::types::MAX_HELD_WORKSPACE_STATES;

use super::WorkspaceImageCache;
use super::entry::is_cache_key_name;
use super::metadata::WorkspaceCacheScopeClassification;

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

const ENTRY_WATCH_FLAGS: AddWatchFlags = AddWatchFlags::IN_MOVED_TO
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
/// Cache keys identify matching-scope metadata commits whose existing entry
/// locks should be awaited before authoritative validation. An empty set still
/// requests a full reconciliation for a relevant removal, invalidation, or
/// queue-overflow event.
#[derive(Debug)]
pub(crate) struct WorkspaceCacheChange {
    pub(crate) observed_at: tokio::time::Instant,
    pub(crate) committed_cache_keys: BTreeSet<String>,
}

impl WorkspaceCacheChange {
    pub(crate) fn merge(&mut self, other: Self) {
        self.observed_at = self.observed_at.min(other.observed_at);
        for cache_key in other.committed_cache_keys {
            if self.committed_cache_keys.len() == MAX_HELD_WORKSPACE_STATES {
                break;
            }
            self.committed_cache_keys.insert(cache_key);
        }
    }
}

/// Non-recursive inotify observer for one host-shared workspace cache.
pub(crate) struct WorkspaceCacheWatcher {
    inotify: AsyncFd<AsyncInotify>,
    root_watch: WatchDescriptor,
    entry_by_watch: BTreeMap<WatchDescriptor, WatchedEntry>,
    watch_by_cache_key: BTreeMap<String, WatchDescriptor>,
    cache: WorkspaceImageCache,
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

struct AsyncInotify(Inotify);

impl AsRawFd for AsyncInotify {
    fn as_raw_fd(&self) -> RawFd {
        self.0.as_fd().as_raw_fd()
    }
}

impl WorkspaceCacheWatcher {
    pub(crate) async fn new(cache: WorkspaceImageCache) -> RunnerResult<Self> {
        host_file::ensure_dir(
            cache.workspace_image_cache_dir(),
            DirMode::Private,
            "workspace image cache root",
        )
        .map_err(|error| watcher_io_error("prepare root", error.kind()))?;
        let inotify = Inotify::init(InitFlags::IN_CLOEXEC | InitFlags::IN_NONBLOCK)
            .map_err(|error| watcher_error("initialize", error))?;
        let root_watch = inotify
            .add_watch(cache.workspace_image_cache_dir(), ROOT_WATCH_FLAGS)
            .map_err(|error| watcher_error("watch root", error))?;
        let inotify = AsyncFd::new(AsyncInotify(inotify))
            .map_err(|error| watcher_io_error("register descriptor", error.kind()))?;
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
    pub(crate) async fn reconcile_initial_relevant_entries(
        &mut self,
        cache_keys: &BTreeSet<String>,
    ) -> RunnerResult<Option<WorkspaceCacheChange>> {
        let observed_at = tokio::time::Instant::now();
        let mut committed_cache_keys = BTreeSet::new();
        let mut requires_refresh = false;
        for cache_key in cache_keys {
            match self.entry_watch_state(cache_key) {
                Some(EntryWatchState::Relevant) => {}
                Some(EntryWatchState::Unclassified) => {
                    requires_refresh = true;
                    let metadata_path = self.cache.workspace_image_cache_metadata(cache_key);
                    self.classify_metadata_commit(
                        cache_key,
                        &metadata_path,
                        &mut committed_cache_keys,
                    )
                    .await;
                }
                None => {
                    requires_refresh = true;
                    self.add_entry_watch(cache_key.clone(), &mut committed_cache_keys)
                        .await?;
                }
            }
        }
        requires_refresh |= cache_keys
            .iter()
            .any(|cache_key| self.entry_watch_state(cache_key) != Some(EntryWatchState::Relevant));
        Ok(requires_refresh.then_some(WorkspaceCacheChange {
            observed_at,
            committed_cache_keys,
        }))
    }

    /// Waits for and coalesces all currently readable relevant mutations.
    pub(crate) async fn next_change(&mut self) -> RunnerResult<WorkspaceCacheChange> {
        loop {
            let mut ready = self
                .inotify
                .readable()
                .await
                .map_err(|error| watcher_io_error("wait for events", error.kind()))?;

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
            let mut reconcile_all_entry_watches = false;
            let mut committed_cache_keys = BTreeSet::new();
            let mut metadata_commit_keys = BTreeSet::new();
            let mut new_cache_keys = Vec::new();
            for event in pending_events {
                if event.mask.contains(AddWatchFlags::IN_Q_OVERFLOW) {
                    changed = true;
                    reconcile_all_entry_watches = true;
                    continue;
                }
                if event.wd == self.root_watch {
                    if event.mask.intersects(WATCH_INVALIDATION_FLAGS) {
                        return Err(RunnerError::Internal(
                            "workspace cache root watch invalidated".to_string(),
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
                        && new_cache_keys.len() < MAX_HELD_WORKSPACE_STATES
                    {
                        new_cache_keys.push(cache_key.to_owned());
                    }
                    if event
                        .mask
                        .intersects(AddWatchFlags::IN_DELETE | AddWatchFlags::IN_MOVED_FROM)
                    {
                        changed |=
                            self.forget_entry_watch(cache_key) == Some(EntryWatchState::Relevant);
                    }
                    continue;
                }

                let Some(entry) = self.entry_by_watch.get(&event.wd).cloned() else {
                    continue;
                };
                if event.mask.intersects(WATCH_INVALIDATION_FLAGS) {
                    changed |=
                        self.forget_watch_descriptor(event.wd) == Some(EntryWatchState::Relevant);
                    continue;
                }
                let Some(name) = event.name.as_deref() else {
                    continue;
                };
                if name == OsStr::new(METADATA_FILE_NAME)
                    && event.mask.contains(AddWatchFlags::IN_MOVED_TO)
                {
                    if metadata_commit_keys.len() < MAX_HELD_WORKSPACE_STATES {
                        metadata_commit_keys.insert(entry.cache_key);
                    }
                } else if (name == OsStr::new(METADATA_FILE_NAME)
                    || name == OsStr::new(CURRENT_IMAGE_FILE_NAME))
                    && event
                        .mask
                        .intersects(AddWatchFlags::IN_DELETE | AddWatchFlags::IN_MOVED_FROM)
                {
                    changed |= entry.state == EntryWatchState::Relevant;
                }
            }

            for cache_key in new_cache_keys {
                changed |= self
                    .add_entry_watch(cache_key, &mut committed_cache_keys)
                    .await?;
            }
            for cache_key in metadata_commit_keys {
                let metadata_path = self.cache.workspace_image_cache_metadata(&cache_key);
                changed |= self
                    .classify_metadata_commit(&cache_key, &metadata_path, &mut committed_cache_keys)
                    .await;
            }
            if reconcile_all_entry_watches {
                self.reconcile_all_entry_watches(&mut committed_cache_keys)
                    .await?;
            }
            if changed || !committed_cache_keys.is_empty() {
                return Ok(WorkspaceCacheChange {
                    observed_at,
                    committed_cache_keys,
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
        committed_cache_keys: &mut BTreeSet<String>,
    ) -> RunnerResult<()> {
        let stale_cache_keys = self
            .watch_by_cache_key
            .keys()
            .filter(|cache_key| {
                match std::fs::symlink_metadata(
                    self.cache.workspace_image_cache_entry_dir(cache_key),
                ) {
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
            let metadata_path = self.cache.workspace_image_cache_metadata(&cache_key);
            self.classify_metadata_commit(&cache_key, &metadata_path, committed_cache_keys)
                .await;
        }

        if self.watch_by_cache_key.len() == MAX_HELD_WORKSPACE_STATES {
            return Ok(());
        }
        let entries = std::fs::read_dir(self.cache.workspace_image_cache_dir())
            .map_err(|error| watcher_io_error("scan entries", error.kind()))?;
        self.reconcile_entry_watches(entries, committed_cache_keys)
            .await
    }

    async fn reconcile_entry_watches(
        &mut self,
        entries: impl Iterator<Item = std::io::Result<std::fs::DirEntry>>,
        committed_cache_keys: &mut BTreeSet<String>,
    ) -> RunnerResult<()> {
        for entry in entries {
            if self.watch_by_cache_key.len() == MAX_HELD_WORKSPACE_STATES {
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
            self.add_entry_watch(cache_key, committed_cache_keys)
                .await?;
        }
        Ok(())
    }

    fn entry_is_watchable(entry_dir: &Path) -> RunnerResult<bool> {
        match std::fs::symlink_metadata(entry_dir) {
            Ok(metadata) => Ok(metadata.is_dir()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(watcher_io_error("inspect entry", error.kind())),
        }
    }

    async fn add_entry_watch(
        &mut self,
        cache_key: String,
        committed_cache_keys: &mut BTreeSet<String>,
    ) -> RunnerResult<bool> {
        if self.watch_by_cache_key.contains_key(&cache_key) {
            return Ok(false);
        }
        let entry_dir = self.cache.workspace_image_cache_entry_dir(&cache_key);
        if !Self::entry_is_watchable(&entry_dir)? {
            return Ok(false);
        }
        let watch = match self
            .inotify
            .get_ref()
            .0
            .add_watch(&entry_dir, ENTRY_WATCH_FLAGS)
        {
            Ok(watch) => watch,
            Err(Errno::ENOENT | Errno::ENOTDIR | Errno::ELOOP) => return Ok(false),
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
        let metadata_path = self.cache.workspace_image_cache_metadata(&cache_key);
        let changed = self
            .classify_metadata_commit(&cache_key, &metadata_path, committed_cache_keys)
            .await;
        self.enforce_watch_limit(&cache_key);
        if !self.watch_by_cache_key.contains_key(&cache_key) {
            committed_cache_keys.remove(&cache_key);
        }
        Ok(changed && self.watch_by_cache_key.contains_key(&cache_key))
    }

    async fn classify_metadata_commit(
        &mut self,
        cache_key: &str,
        metadata_path: &Path,
        committed_cache_keys: &mut BTreeSet<String>,
    ) -> bool {
        let Some(previous_state) = self.entry_watch_state(cache_key) else {
            return false;
        };
        match self
            .cache
            .classify_metadata_scope(cache_key, metadata_path)
            .await
        {
            WorkspaceCacheScopeClassification::Relevant => {
                self.set_entry_watch_state(cache_key, EntryWatchState::Relevant);
                if committed_cache_keys.len() < MAX_HELD_WORKSPACE_STATES {
                    committed_cache_keys.insert(cache_key.to_owned());
                }
                true
            }
            WorkspaceCacheScopeClassification::Foreign => {
                self.forget_entry_watch(cache_key);
                previous_state == EntryWatchState::Relevant
            }
            WorkspaceCacheScopeClassification::Unclassified => {
                self.set_entry_watch_state(cache_key, EntryWatchState::Unclassified);
                previous_state == EntryWatchState::Relevant
            }
        }
    }

    fn enforce_watch_limit(&mut self, preferred_cache_key: &str) {
        while self.watch_by_cache_key.len() > MAX_HELD_WORKSPACE_STATES {
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

fn watcher_error(action: &str, error: Errno) -> RunnerError {
    RunnerError::Internal(format!("workspace cache watcher {action}: {error}"))
}

fn watcher_io_error(action: &str, kind: std::io::ErrorKind) -> RunnerError {
    RunnerError::Internal(format!("workspace cache watcher {action}: {kind:?}"))
}

#[cfg(test)]
mod tests {
    use super::super::fs::allocated_bytes;
    use super::super::metadata::{
        WorkspaceCacheMetadata, WorkspaceCacheState, WorkspaceImageFileIdentity, WorkspaceTrust,
    };
    use super::super::{
        CACHE_FORMAT_VERSION, WORKSPACE_DRIVE_LAYOUT, WorkspaceCacheTerminalStatus,
    };
    use super::*;
    use crate::paths::{HomePaths, RunnerPaths};
    use crate::storage_fingerprints::StorageFingerprints;
    use runner_types::ids::RunId;

    const TEST_PROFILE_NAME: &str = "vm0/default";
    const TEST_WORKING_DIR: &str = "/workspace";

    async fn commit_entry(cache: &WorkspaceImageCache, reuse_key: &str) -> String {
        let image = format!("image-{reuse_key}");
        let cache_key = cache.scoped_cache_key(
            TEST_PROFILE_NAME,
            reuse_key,
            TEST_WORKING_DIR,
            image.len() as u64,
        );
        cache
            .ensure_workspace_cache_entry_dir(&cache_key)
            .await
            .unwrap();
        let current_image = cache.workspace_image_cache_current_image(&cache_key);
        tokio::fs::write(&current_image, image).await.unwrap();
        let current_metadata = tokio::fs::metadata(&current_image).await.unwrap();
        cache
            .write_metadata(
                &cache_key,
                RunId::new_v4(),
                WorkspaceCacheMetadata {
                    format_version: CACHE_FORMAT_VERSION,
                    cache_scope: cache.inner.cache_scope.clone(),
                    profile_name: TEST_PROFILE_NAME.into(),
                    reuse_key: reuse_key.into(),
                    working_dir: TEST_WORKING_DIR.into(),
                    last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                    last_used_at: "2026-05-01T00:00:00.000Z".into(),
                    last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                    workspace_trust: WorkspaceTrust::Clean,
                    logical_image_size_bytes: current_metadata.len(),
                    allocated_bytes: allocated_bytes(&current_metadata),
                    current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                    drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                    storage_fingerprints: StorageFingerprints::default(),
                    state: WorkspaceCacheState::Current,
                },
            )
            .await
            .unwrap();
        cache_key
    }

    #[tokio::test]
    async fn reports_metadata_commit_and_removal_from_existing_entry() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(temp.path().join("runner"));
        let cache = WorkspaceImageCache::new(paths);
        let cache_key = cache.scoped_cache_key(
            TEST_PROFILE_NAME,
            "existing-entry",
            TEST_WORKING_DIR,
            b"image-existing-entry".len() as u64,
        );
        cache
            .ensure_workspace_cache_entry_dir(&cache_key)
            .await
            .unwrap();
        let mut watcher = WorkspaceCacheWatcher::new(cache.clone()).await.unwrap();

        assert_eq!(commit_entry(&cache, "existing-entry").await, cache_key);
        let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            change.committed_cache_keys,
            BTreeSet::from([cache_key.clone()])
        );

        tokio::fs::remove_file(cache.workspace_image_cache_metadata(&cache_key))
            .await
            .unwrap();
        let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
            .await
            .unwrap()
            .unwrap();
        assert!(change.committed_cache_keys.is_empty());
    }

    #[tokio::test]
    async fn newly_created_entry_with_committed_metadata_is_not_lost() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(temp.path().join("runner"));
        let cache = WorkspaceImageCache::new(paths);
        let mut watcher = WorkspaceCacheWatcher::new(cache.clone()).await.unwrap();
        let cache_key = commit_entry(&cache, "new-entry").await;

        let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(change.committed_cache_keys, BTreeSet::from([cache_key]));
    }

    #[tokio::test]
    async fn startup_reconciliation_preserves_matching_commit_key() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(temp.path().join("runner"));
        let cache = WorkspaceImageCache::new(paths);
        let mut watcher = WorkspaceCacheWatcher::new(cache.clone()).await.unwrap();
        let cache_key = commit_entry(&cache, "startup-reconciliation").await;

        let change = watcher
            .reconcile_initial_relevant_entries(&BTreeSet::from([cache_key.clone()]))
            .await
            .unwrap()
            .expect("newly classified startup entry should require reconciliation");

        assert_eq!(change.committed_cache_keys, BTreeSet::from([cache_key]));
    }

    #[tokio::test]
    async fn bounded_drain_preserves_readiness_for_remaining_events() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(temp.path().join("runner"));
        let cache = WorkspaceImageCache::new(paths);
        let cache_key = cache.scoped_cache_key(
            TEST_PROFILE_NAME,
            "bounded-drain",
            TEST_WORKING_DIR,
            b"image-bounded-drain".len() as u64,
        );
        cache
            .ensure_workspace_cache_entry_dir(&cache_key)
            .await
            .unwrap();
        let entry_dir = cache.workspace_image_cache_entry_dir(&cache_key);

        for index in 0..5_000 {
            tokio::fs::write(entry_dir.join(format!("noise-{index:04}")), b"")
                .await
                .unwrap();
        }
        let mut watcher = WorkspaceCacheWatcher::new(cache.clone()).await.unwrap();
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
        assert_eq!(change.committed_cache_keys, BTreeSet::from([cache_key]));
    }

    #[tokio::test]
    async fn newly_created_entry_replaces_an_existing_watch_at_the_limit() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(temp.path().join("runner"));
        let cache = WorkspaceImageCache::new(paths);
        for index in 0..MAX_HELD_WORKSPACE_STATES {
            cache
                .ensure_workspace_cache_entry_dir(&format!("{index:064x}"))
                .await
                .unwrap();
        }
        let mut watcher = WorkspaceCacheWatcher::new(cache.clone()).await.unwrap();
        assert_eq!(watcher.watch_by_cache_key.len(), MAX_HELD_WORKSPACE_STATES);

        let cache_key = commit_entry(&cache, "preferred-new-entry").await;

        let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            change.committed_cache_keys,
            BTreeSet::from([cache_key.clone()])
        );
        assert_eq!(watcher.watch_by_cache_key.len(), MAX_HELD_WORKSPACE_STATES);
        assert!(watcher.watch_by_cache_key.contains_key(&cache_key));
    }

    #[tokio::test]
    async fn create_and_remove_in_one_batch_does_not_leave_a_stale_watch() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(temp.path().join("runner"));
        let cache = WorkspaceImageCache::new(paths);
        let mut watcher = WorkspaceCacheWatcher::new(cache.clone()).await.unwrap();
        let cache_key = "e".repeat(64);
        let entry_dir = cache.workspace_image_cache_entry_dir(&cache_key);

        tokio::fs::create_dir_all(&entry_dir).await.unwrap();
        tokio::fs::remove_dir(&entry_dir).await.unwrap();
        let relevant_cache_key = commit_entry(&cache, "post-create-remove").await;

        let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            change.committed_cache_keys,
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
        let observer = WorkspaceImageCache::shared(observer_paths, &home, "group-a");
        let publisher = WorkspaceImageCache::shared(publisher_paths, &home, "group-b");
        let mut watcher = WorkspaceCacheWatcher::new(observer.clone()).await.unwrap();

        let foreign_cache_key = commit_entry(&publisher, "foreign-entry").await;
        let relevant_cache_key = commit_entry(&observer, "relevant-entry").await;

        let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            change.committed_cache_keys,
            BTreeSet::from([relevant_cache_key])
        );
        assert!(!watcher.watch_by_cache_key.contains_key(&foreign_cache_key));

        tokio::fs::remove_dir_all(publisher.workspace_image_cache_entry_dir(&foreign_cache_key))
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
        let observer = WorkspaceImageCache::shared(observer_paths, &home, "group-a");
        let publisher = WorkspaceImageCache::shared(publisher_paths, &home, "group-b");
        let mut watcher = WorkspaceCacheWatcher::new(observer.clone()).await.unwrap();

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
            change.committed_cache_keys,
            BTreeSet::from([relevant_cache_key])
        );
        drop(next_change);
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
        let observer = WorkspaceImageCache::shared(observer_paths, &home, "group-a");
        let publisher = WorkspaceImageCache::shared(publisher_paths, &home, "group-b");
        let foreign_cache_key = commit_entry(&publisher, "existing-foreign-entry").await;

        let watcher = WorkspaceCacheWatcher::new(observer).await.unwrap();

        assert!(!watcher.watch_by_cache_key.contains_key(&foreign_cache_key));
        assert!(watcher.watch_by_cache_key.is_empty());
    }

    #[tokio::test]
    async fn reconciliation_scans_past_irrelevant_raw_entry_limit() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(temp.path().join("runner"));
        let cache = WorkspaceImageCache::new(paths);
        let mut watcher = WorkspaceCacheWatcher::new(cache.clone()).await.unwrap();

        for index in 0..MAX_HELD_WORKSPACE_STATES {
            std::fs::create_dir(
                cache
                    .workspace_image_cache_dir()
                    .join(format!("irrelevant-{index:04}")),
            )
            .unwrap();
        }
        let relevant_cache_key = cache.scoped_cache_key(
            TEST_PROFILE_NAME,
            "relevant-after-raw-limit",
            TEST_WORKING_DIR,
            b"image-relevant-after-raw-limit".len() as u64,
        );
        cache
            .ensure_workspace_cache_entry_dir(&relevant_cache_key)
            .await
            .unwrap();

        let mut entries = std::fs::read_dir(cache.workspace_image_cache_dir())
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        entries.sort_by_key(|entry| entry.file_name() == OsStr::new(&relevant_cache_key));
        assert_eq!(entries.len(), MAX_HELD_WORKSPACE_STATES + 1);
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
            change.committed_cache_keys,
            BTreeSet::from([relevant_cache_key])
        );
    }

    #[tokio::test]
    async fn setup_error_does_not_expose_cache_path() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(temp.path().join("runner"));
        let cache = WorkspaceImageCache::new(paths);
        let cache_root = cache.workspace_image_cache_dir().to_path_buf();
        std::fs::create_dir_all(cache_root.parent().unwrap()).unwrap();
        std::fs::write(&cache_root, b"not a directory").unwrap();

        let error = match WorkspaceCacheWatcher::new(cache).await {
            Ok(_) => panic!("watcher setup should reject a non-directory cache root"),
            Err(error) => error,
        };
        let message = error.to_string();

        assert!(message.contains("workspace cache watcher prepare root"));
        assert!(!message.contains(&cache_root.display().to_string()));
    }
}
