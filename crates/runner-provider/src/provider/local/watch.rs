use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::os::fd::{AsFd, AsRawFd, RawFd};
use std::path::{Path, PathBuf};
use std::time::Duration;

use nix::errno::Errno;
use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify, WatchDescriptor};
use tokio::io::unix::AsyncFd;

use crate::error::{ProviderError, ProviderResult};

pub(super) const RECONCILE_INTERVAL: Duration = Duration::from_secs(5);

const PUBLICATION_FLAGS: AddWatchFlags =
    AddWatchFlags::IN_MOVED_TO.union(AddWatchFlags::IN_CLOSE_WRITE);
const INVALIDATION_FLAGS: AddWatchFlags = AddWatchFlags::IN_DELETE_SELF
    .union(AddWatchFlags::IN_MOVE_SELF)
    .union(AddWatchFlags::IN_UNMOUNT)
    .union(AddWatchFlags::IN_IGNORED);
const WATCH_FLAGS: AddWatchFlags = PUBLICATION_FLAGS
    .union(AddWatchFlags::IN_DELETE_SELF)
    .union(AddWatchFlags::IN_MOVE_SELF)
    .union(AddWatchFlags::IN_UNMOUNT)
    .union(AddWatchFlags::IN_ONLYDIR)
    .union(AddWatchFlags::IN_DONT_FOLLOW);
const MAX_EVENT_READ_BATCHES_PER_CHANGE: usize = 16;

#[derive(Clone, Copy)]
pub(super) enum QueueFileKind {
    Job,
    Cancel,
}

impl QueueFileKind {
    fn extension(self) -> &'static OsStr {
        match self {
            Self::Job => OsStr::new("job"),
            Self::Cancel => OsStr::new("cancel"),
        }
    }
}

/// Advisory inotify waiter for local queue leaf directories.
pub(super) struct LocalQueueWatcher {
    inotify: AsyncFd<AsyncInotify>,
    desired_paths: Vec<PathBuf>,
    path_by_watch: BTreeMap<WatchDescriptor, PathBuf>,
    watch_by_path: BTreeMap<PathBuf, WatchDescriptor>,
    kind: QueueFileKind,
}

struct AsyncInotify(Inotify);

impl AsRawFd for AsyncInotify {
    fn as_raw_fd(&self) -> RawFd {
        self.0.as_fd().as_raw_fd()
    }
}

impl LocalQueueWatcher {
    pub(super) fn new(
        mut desired_paths: Vec<PathBuf>,
        kind: QueueFileKind,
    ) -> ProviderResult<Self> {
        desired_paths.sort();
        desired_paths.dedup();
        let inotify = Inotify::init(InitFlags::IN_CLOEXEC | InitFlags::IN_NONBLOCK)
            .map_err(|error| watcher_error("initialize", error))?;
        // SAFETY: AsyncInotify owns inotify and exposes the same live descriptor until drop.
        let inotify = unsafe { AsyncFd::register(AsyncInotify(inotify)) }.map_err(|error| {
            watcher_io_error("register descriptor", std::io::Error::from(error).kind())
        })?;
        Ok(Self {
            inotify,
            desired_paths,
            path_by_watch: BTreeMap::new(),
            watch_by_path: BTreeMap::new(),
            kind,
        })
    }

    /// Install watches that are currently missing.
    pub(super) fn reconcile(&mut self) -> ProviderResult<()> {
        let missing_paths: Vec<PathBuf> = self
            .desired_paths
            .iter()
            .filter(|path| !self.watch_by_path.contains_key(*path))
            .cloned()
            .collect();
        let mut first_error = None;
        for path in missing_paths {
            match self.inotify.get_ref().0.add_watch(&path, WATCH_FLAGS) {
                Ok(watch) => {
                    self.path_by_watch.insert(watch, path.clone());
                    self.watch_by_path.insert(path, watch);
                }
                Err(Errno::ENOENT | Errno::ENOTDIR | Errno::ELOOP) => {}
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(watcher_error("watch queue directory", error));
                    }
                }
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// Wait for a matching publication or a condition requiring reconciliation.
    pub(super) async fn next_change(&mut self) -> ProviderResult<()> {
        loop {
            let mut ready = self
                .inotify
                .readable()
                .await
                .map_err(|error| watcher_io_error("wait for events", error.kind()))?;

            let mut changed = false;
            let mut drained_all_events = false;
            let mut invalidated_watches = Vec::new();
            for _ in 0..MAX_EVENT_READ_BATCHES_PER_CHANGE {
                match self.inotify.get_ref().0.read_events() {
                    Ok(events) => {
                        for event in events {
                            if event.mask.contains(AddWatchFlags::IN_Q_OVERFLOW) {
                                changed = true;
                                continue;
                            }
                            if !self.path_by_watch.contains_key(&event.wd) {
                                continue;
                            }
                            if event.mask.intersects(INVALIDATION_FLAGS) {
                                invalidated_watches.push(event.wd);
                                changed = true;
                                continue;
                            }
                            if !event.mask.intersects(PUBLICATION_FLAGS) {
                                continue;
                            }
                            if event.name.as_deref().is_some_and(|name| {
                                Path::new(name).extension() == Some(self.kind.extension())
                            }) {
                                changed = true;
                            }
                        }
                    }
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
            for watch in invalidated_watches {
                self.retire_watch(watch)?;
            }

            if changed || !drained_all_events {
                return Ok(());
            }
        }
    }

    fn retire_watch(&mut self, watch: WatchDescriptor) -> ProviderResult<()> {
        let Some(path) = self.path_by_watch.get(&watch) else {
            return Ok(());
        };
        // Moving an inode keeps its watch; deletion may already have removed it.
        match self.inotify.get_ref().0.rm_watch(watch) {
            Ok(()) | Err(Errno::EINVAL) => {}
            Err(error) => return Err(watcher_error("remove queue directory watch", error)),
        }
        self.watch_by_path.remove(path);
        self.path_by_watch.remove(&watch);
        Ok(())
    }
}

pub(super) fn ensure_watcher(
    watcher: &mut Option<LocalQueueWatcher>,
    desired_paths: &[PathBuf],
    kind: QueueFileKind,
) -> ProviderResult<()> {
    match watcher {
        Some(watcher) => watcher.reconcile(),
        None => {
            let mut created = LocalQueueWatcher::new(desired_paths.to_vec(), kind)?;
            let result = created.reconcile();
            *watcher = Some(created);
            result
        }
    }
}

pub(super) async fn next_change_or_pending(
    watcher: &mut Option<LocalQueueWatcher>,
) -> ProviderResult<()> {
    match watcher {
        Some(watcher) => watcher.next_change().await,
        None => std::future::pending().await,
    }
}

fn watcher_error(action: &str, error: Errno) -> ProviderError {
    ProviderError::Internal(format!("local queue watcher {action}: {error}"))
}

fn watcher_io_error(action: &str, kind: std::io::ErrorKind) -> ProviderError {
    ProviderError::Internal(format!("local queue watcher {action}: {kind:?}"))
}

#[cfg(test)]
mod tests;
