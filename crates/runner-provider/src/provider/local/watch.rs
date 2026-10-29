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
mod tests {
    use super::*;

    fn watcher(path: &Path, kind: QueueFileKind) -> LocalQueueWatcher {
        let mut watcher = LocalQueueWatcher::new(vec![path.to_path_buf()], kind).unwrap();
        watcher.reconcile().unwrap();
        watcher
    }

    fn kernel_watch_count(watcher: &LocalQueueWatcher) -> usize {
        std::fs::read_to_string(format!("/proc/self/fdinfo/{}", watcher.inotify.as_raw_fd()))
            .unwrap()
            .lines()
            .filter(|line| line.starts_with("inotify wd:"))
            .count()
    }

    #[tokio::test]
    async fn job_watcher_ignores_temporary_file_until_final_rename() {
        let dir = tempfile::tempdir().unwrap();
        let mut watcher = watcher(dir.path(), QueueFileKind::Job);
        let temporary_path = dir.path().join("run.job.tmp");
        let job_path = dir.path().join("run.job");
        std::fs::write(&temporary_path, b"job").unwrap();
        std::fs::write(dir.path().join("noise.txt"), b"noise").unwrap();

        let mut next_change = Box::pin(watcher.next_change());
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut next_change)
                .await
                .is_err(),
            "temporary and unrelated files must not wake job discovery"
        );

        std::fs::rename(temporary_path, job_path).unwrap();
        tokio::time::timeout(Duration::from_secs(2), &mut next_change)
            .await
            .expect("final job rename should wake watcher")
            .unwrap();
    }

    #[tokio::test]
    async fn cancel_watcher_reports_close_written_marker() {
        let dir = tempfile::tempdir().unwrap();
        let mut watcher = watcher(dir.path(), QueueFileKind::Cancel);

        std::fs::write(dir.path().join("run.cancel"), b"").unwrap();

        tokio::time::timeout(Duration::from_secs(2), watcher.next_change())
            .await
            .expect("closed cancel marker should wake watcher")
            .unwrap();
    }

    #[tokio::test]
    async fn invalidated_directory_can_be_reconciled_after_recreation() {
        let root = tempfile::tempdir().unwrap();
        let watched_dir = root.path().join("jobs");
        std::fs::create_dir(&watched_dir).unwrap();
        let mut watcher = watcher(&watched_dir, QueueFileKind::Job);

        std::fs::remove_dir(&watched_dir).unwrap();
        tokio::time::timeout(Duration::from_secs(2), watcher.next_change())
            .await
            .expect("directory invalidation should request reconciliation")
            .unwrap();
        watcher.reconcile().unwrap();

        std::fs::create_dir(&watched_dir).unwrap();
        watcher.reconcile().unwrap();
        std::fs::write(watched_dir.join("run.job"), b"job").unwrap();

        tokio::time::timeout(Duration::from_secs(2), watcher.next_change())
            .await
            .expect("recreated directory should be watched again")
            .unwrap();
    }

    #[tokio::test]
    async fn moved_directories_retire_kernel_watches_before_reconciliation() {
        let root = tempfile::tempdir().unwrap();
        let watched_dir = root.path().join("jobs");
        let other_dir = root.path().join("other-jobs");
        std::fs::create_dir(&watched_dir).unwrap();
        std::fs::create_dir(&other_dir).unwrap();
        let mut watcher = LocalQueueWatcher::new(
            vec![watched_dir.clone(), other_dir.clone()],
            QueueFileKind::Job,
        )
        .unwrap();
        watcher.reconcile().unwrap();
        assert_eq!(kernel_watch_count(&watcher), 2);

        for cycle in 0..8 {
            let retired_dir = root.path().join(format!("retired-{cycle}"));
            std::fs::rename(&watched_dir, &retired_dir).unwrap();
            tokio::time::timeout(Duration::from_secs(2), watcher.next_change())
                .await
                .expect("directory move should request reconciliation")
                .unwrap();
            assert_eq!(
                kernel_watch_count(&watcher),
                1,
                "moved inode must lose its watch while the other watch stays live"
            );

            std::fs::create_dir(&watched_dir).unwrap();
            watcher.reconcile().unwrap();
            assert_eq!(kernel_watch_count(&watcher), 2);

            // rm_watch queues IN_IGNORED. Wait for actual readiness before
            // checking that next_change drains it and waits for a live event.
            tokio::time::timeout(Duration::from_secs(2), watcher.inotify.readable())
                .await
                .expect("watch retirement should queue IN_IGNORED")
                .unwrap()
                .retain_ready();
            assert!(futures_util::poll!(std::pin::pin!(watcher.next_change())).is_pending());

            std::fs::write(retired_dir.join("retired.job"), b"job").unwrap();
            std::fs::rename(&retired_dir, root.path().join(format!("kept-{cycle}"))).unwrap();
            assert!(matches!(
                watcher.inotify.get_ref().0.read_events(),
                Err(Errno::EAGAIN)
            ));

            std::fs::write(watched_dir.join("replacement.job"), b"job").unwrap();
            tokio::time::timeout(Duration::from_secs(2), watcher.next_change())
                .await
                .expect("replacement directory publication should wake watcher")
                .unwrap();
        }

        std::fs::write(other_dir.join("unaffected.job"), b"job").unwrap();
        tokio::time::timeout(Duration::from_secs(2), watcher.next_change())
            .await
            .expect("unaffected directory publication should wake watcher")
            .unwrap();
    }
}
