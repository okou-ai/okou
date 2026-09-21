use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::os::fd::{AsFd, AsRawFd, RawFd};
use std::path::{Path, PathBuf};
use std::time::Duration;

use nix::errno::Errno;
use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify, WatchDescriptor};
use tokio::io::unix::AsyncFd;

use crate::error::{RunnerError, RunnerResult};

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
    pub(super) fn new(mut desired_paths: Vec<PathBuf>, kind: QueueFileKind) -> RunnerResult<Self> {
        desired_paths.sort();
        desired_paths.dedup();
        let inotify = Inotify::init(InitFlags::IN_CLOEXEC | InitFlags::IN_NONBLOCK)
            .map_err(|error| watcher_error("initialize", error))?;
        let inotify = AsyncFd::new(AsyncInotify(inotify))
            .map_err(|error| watcher_io_error("register descriptor", error.kind()))?;
        Ok(Self {
            inotify,
            desired_paths,
            path_by_watch: BTreeMap::new(),
            watch_by_path: BTreeMap::new(),
            kind,
        })
    }

    /// Install watches that are currently missing.
    pub(super) fn reconcile(&mut self) -> RunnerResult<()> {
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
    pub(super) async fn next_change(&mut self) -> RunnerResult<()> {
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
                            if event.mask.intersects(INVALIDATION_FLAGS) {
                                invalidated_watches.push(event.wd);
                                changed = true;
                                continue;
                            }
                            if !event.mask.intersects(PUBLICATION_FLAGS)
                                || !self.path_by_watch.contains_key(&event.wd)
                            {
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
                self.forget_watch(watch);
            }

            if changed || !drained_all_events {
                return Ok(());
            }
        }
    }

    fn forget_watch(&mut self, watch: WatchDescriptor) {
        if let Some(path) = self.path_by_watch.remove(&watch) {
            self.watch_by_path.remove(&path);
        }
    }
}

pub(super) fn ensure_watcher(
    watcher: &mut Option<LocalQueueWatcher>,
    desired_paths: &[PathBuf],
    kind: QueueFileKind,
) -> RunnerResult<()> {
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
) -> RunnerResult<()> {
    match watcher {
        Some(watcher) => watcher.next_change().await,
        None => std::future::pending().await,
    }
}

fn watcher_error(action: &str, error: Errno) -> RunnerError {
    RunnerError::Internal(format!("local queue watcher {action}: {error}"))
}

fn watcher_io_error(action: &str, kind: std::io::ErrorKind) -> RunnerError {
    RunnerError::Internal(format!("local queue watcher {action}: {kind:?}"))
}

runner_test_group!(provider; #[cfg(test)]
mod tests {
    use super::*;

    fn watcher(path: &Path, kind: QueueFileKind) -> LocalQueueWatcher {
        let mut watcher = LocalQueueWatcher::new(vec![path.to_path_buf()], kind).unwrap();
        watcher.reconcile().unwrap();
        watcher
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
});
