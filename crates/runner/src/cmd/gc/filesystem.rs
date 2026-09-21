use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::SystemTime;

use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::error::{RunnerError, RunnerResult};

fn warn_next_entry_error(label: &str, dir: &Path, error: &std::io::Error) {
    warn!("{label}: read entry in {}: {error}", dir.display());
}

/// Like `next_entry()`, but logs an I/O error before returning it.
pub(super) async fn next_entry_warn(
    entries: &mut tokio::fs::ReadDir,
    label: &str,
    dir: &Path,
) -> std::io::Result<Option<tokio::fs::DirEntry>> {
    match entries.next_entry().await {
        Ok(entry) => Ok(entry),
        Err(error) => {
            warn_next_entry_error(label, dir, &error);
            Err(error)
        }
    }
}

/// Stop a best-effort directory scan after logging an I/O error.
pub(super) async fn next_entry_warn_or_stop(
    entries: &mut tokio::fs::ReadDir,
    label: &str,
    dir: &Path,
) -> Option<tokio::fs::DirEntry> {
    next_entry_warn(entries, label, dir).await.ok().flatten()
}

/// Stateful directory reader for GC scans whose completeness authorizes deletion.
pub(super) struct GcDirEntryReader {
    #[cfg(test)]
    entries_before_error: Option<usize>,
}

impl GcDirEntryReader {
    pub(super) const fn new() -> Self {
        Self {
            #[cfg(test)]
            entries_before_error: None,
        }
    }

    runner_test_support!(cmd_gc_build; #[cfg(test)]
    pub(super) const fn failing_after(successful_entries: usize) -> Self {
        Self {
            entries_before_error: Some(successful_entries),
        }
    });

    pub(super) async fn next_entry_warn(
        &mut self,
        entries: &mut tokio::fs::ReadDir,
        label: &str,
        dir: &Path,
    ) -> std::io::Result<Option<tokio::fs::DirEntry>> {
        #[cfg(test)]
        if let Some(remaining) = &mut self.entries_before_error {
            if *remaining == 0 {
                self.entries_before_error = None;
                let error = std::io::Error::other("injected directory iteration failure");
                warn_next_entry_error(label, dir, &error);
                return Err(error);
            }
            *remaining -= 1;
        }

        next_entry_warn(entries, label, dir).await
    }
}

pub(super) async fn read_dir_or_missing(path: &Path) -> RunnerResult<Option<tokio::fs::ReadDir>> {
    match tokio::fs::read_dir(path).await {
        Ok(rd) => Ok(Some(rd)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(RunnerError::Internal(format!(
            "read {}: {e}",
            path.display()
        ))),
    }
}

pub(super) enum GcDirStatus {
    RealDir(std::fs::Metadata),
    Missing,
    NotDirectory,
}

pub(super) async fn gc_path_dir_status(path: &Path) -> std::io::Result<GcDirStatus> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(meta) if meta.file_type().is_dir() => Ok(GcDirStatus::RealDir(meta)),
        Ok(_) => Ok(GcDirStatus::NotDirectory),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(GcDirStatus::Missing),
        Err(e) => Err(e),
    }
}

pub(super) async fn gc_entry_is_real_dir(entry: &tokio::fs::DirEntry) -> std::io::Result<bool> {
    match entry.file_type().await {
        Ok(file_type) => Ok(file_type.is_dir()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Compute best-effort disk usage (`st_blocks * 512`) and last-used time for
/// `dir`.
///
/// For a directory, the returned size is the sum of the blocks for each
/// descendant encountered by the walk. It does not include the root
/// directory's own blocks. Symlink entries contribute their own blocks but
/// are not followed. If cancellation or a filesystem error prevents the walk
/// from completing, the size includes only the bytes accumulated before the
/// interruption.
/// A non-directory root contributes its own blocks instead.
///
/// Last-used time comes from the root directory's own mtime, which `touch_mtime`
/// updates on every cache hit and `runner start`. If the root cannot be
/// stat'ed, the returned size is zero and the mtime is `UNIX_EPOCH`; the mtime
/// also falls back to `UNIX_EPOCH` when root metadata is available but its
/// modified time cannot be read. This tuple does not indicate whether a
/// directory walk completed; use [`collect_dir_stats`] when completeness
/// affects a deletion or another safety decision.
pub(super) async fn dir_stats(dir: &Path) -> (u64, SystemTime) {
    let stats = collect_dir_stats(dir).await;
    (stats.size, stats.mtime)
}

/// Best-effort size and timestamp information collected for a filesystem path.
///
/// For a directory root, `size` is the sum of `st_blocks * 512` for each
/// encountered descendant. The root directory's own blocks are excluded, and
/// symlink entries are counted without following their targets. Filesystem
/// errors or cancellation can leave `size` partial while still returning the
/// bytes accumulated before the interruption. The root mtime is used for
/// `mtime`, with `UNIX_EPOCH` as the fallback when it is unavailable.
///
/// For directory inputs, `root_metadata.is_some()` is the signal that the full
/// walk completed. `None` means that the root could not be stat'ed or that the
/// walk was interrupted by cancellation or a filesystem error. A
/// non-directory root has `Some` metadata when its root stat succeeds because
/// no recursive walk is needed. Callers whose deletion or other safety
/// decision depends on a complete scan should inspect this result rather than
/// use the lossy [`dir_stats`] tuple.
pub(super) struct DirStats {
    pub(super) size: u64,
    pub(super) mtime: SystemTime,
    /// Root metadata when the root stat succeeded and, for a directory root,
    /// the full walk completed.
    pub(super) root_metadata: Option<std::fs::Metadata>,
}

struct DirStatsEntryReader {
    #[cfg(test)]
    after_entry: Option<Box<dyn FnMut() -> std::io::Result<()> + Send>>,
}

impl DirStatsEntryReader {
    const fn new() -> Self {
        Self {
            #[cfg(test)]
            after_entry: None,
        }
    }

    runner_test_support!(cmd_gc_build; #[cfg(test)]
    fn after_entry(after_entry: impl FnMut() -> std::io::Result<()> + Send + 'static) -> Self {
        Self {
            after_entry: Some(Box::new(after_entry)),
        }
    });

    fn next_entry_warn(
        &mut self,
        entries: &mut std::fs::ReadDir,
        label: &str,
        dir: &Path,
    ) -> std::io::Result<Option<std::fs::DirEntry>> {
        let entry = match entries.next().transpose() {
            Ok(entry) => entry,
            Err(error) => {
                warn_next_entry_error(label, dir, &error);
                return Err(error);
            }
        };

        #[cfg(test)]
        if entry.is_some()
            && let Some(after_entry) = &mut self.after_entry
            && let Err(error) = after_entry()
        {
            warn_next_entry_error(label, dir, &error);
            return Err(error);
        }

        Ok(entry)
    }
}

/// Compute best-effort directory stats while retaining the root metadata
/// fetched for the walk.
///
/// Unlike [`dir_stats`], this result preserves whether a directory walk
/// completed: for directory inputs, `root_metadata.is_some()` is the full-walk
/// completeness signal. Use this completeness-aware API when scan completeness
/// participates in a deletion or another safety decision.
pub(super) async fn collect_dir_stats(dir: &Path) -> DirStats {
    collect_dir_stats_with_reader(
        dir,
        DirStatsEntryReader::new(),
        #[cfg(test)]
        None,
    )
    .await
}

async fn collect_dir_stats_with_reader(
    dir: &Path,
    entry_reader: DirStatsEntryReader,
    #[cfg(test)] task_submissions: Option<&std::sync::atomic::AtomicUsize>,
) -> DirStats {
    let cancel = CancellationToken::new();
    collect_dir_stats_with_cancel(
        dir,
        entry_reader,
        cancel,
        #[cfg(test)]
        task_submissions,
    )
    .await
}

async fn collect_dir_stats_with_cancel(
    dir: &Path,
    entry_reader: DirStatsEntryReader,
    cancel: CancellationToken,
    #[cfg(test)] task_submissions: Option<&std::sync::atomic::AtomicUsize>,
) -> DirStats {
    let dir = dir.to_path_buf();
    let cancel_on_drop = cancel.clone().drop_guard();

    #[cfg(test)]
    if let Some(task_submissions) = task_submissions {
        task_submissions.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    let result = tokio::task::spawn_blocking(move || {
        collect_dir_stats_blocking(&dir, entry_reader, &cancel)
    })
    .await;
    let _cancel = cancel_on_drop.disarm();
    match result {
        Ok(stats) => stats,
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    }
}

fn collect_dir_stats_blocking(
    dir: &Path,
    mut entry_reader: DirStatsEntryReader,
    cancel: &CancellationToken,
) -> DirStats {
    const BYTES_PER_BLOCK: u64 = 512;

    if cancel.is_cancelled() {
        return DirStats {
            size: 0,
            mtime: SystemTime::UNIX_EPOCH,
            root_metadata: None,
        };
    }

    let root_meta = match std::fs::symlink_metadata(dir) {
        Ok(meta) => meta,
        Err(_) => {
            return DirStats {
                size: 0,
                mtime: SystemTime::UNIX_EPOCH,
                root_metadata: None,
            };
        }
    };
    let mtime = root_meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    if !root_meta.file_type().is_dir() {
        return DirStats {
            size: root_meta.blocks() * BYTES_PER_BLOCK,
            mtime,
            root_metadata: Some(root_meta),
        };
    }

    let mut total_bytes = 0u64;
    let mut complete = true;
    let mut stack = vec![dir.to_path_buf()];
    'walk: while let Some(current) = stack.pop() {
        if cancel.is_cancelled() {
            complete = false;
            break;
        }

        let current_meta = match std::fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        if !current_meta.file_type().is_dir() {
            complete = false;
            continue;
        }

        if cancel.is_cancelled() {
            complete = false;
            break;
        }

        let mut entries = match std::fs::read_dir(&current) {
            Ok(rd) => rd,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        loop {
            if cancel.is_cancelled() {
                complete = false;
                break 'walk;
            }

            let entry = match entry_reader.next_entry_warn(&mut entries, "dir_stats", &current) {
                Ok(Some(entry)) => entry,
                Ok(None) => break,
                Err(_) => {
                    complete = false;
                    break;
                }
            };

            if cancel.is_cancelled() {
                complete = false;
                break 'walk;
            }

            let path = entry.path();
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    complete = false;
                    continue;
                }
            };
            total_bytes += meta.blocks() * BYTES_PER_BLOCK;
            if meta.file_type().is_dir() {
                stack.push(path);
            }
        }
    }

    DirStats {
        size: total_bytes,
        mtime,
        root_metadata: complete.then_some(root_meta),
    }
}

runner_test_group!(cmd_gc_build; #[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn dir_stats_does_not_recurse_through_symlinked_child_dir() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        let normal_child = root.join("normal");
        std::fs::create_dir_all(&normal_child).unwrap();
        std::fs::write(normal_child.join("inside.bin"), vec![1u8; 4096]).unwrap();

        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("outside.bin"), vec![2u8; 1024 * 1024]).unwrap();
        let link = root.join("linked");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let symlink_bytes = std::fs::symlink_metadata(&link).unwrap().blocks() * 512;

        let (with_symlink, _) = dir_stats(&root).await;
        std::fs::remove_file(&link).unwrap();
        let (without_symlink, _) = dir_stats(&root).await;

        assert_eq!(
            with_symlink,
            without_symlink + symlink_bytes,
            "dir_stats should count the symlink itself but not recurse into its target"
        );
    }

    #[tokio::test]
    async fn collect_dir_stats_withholds_root_metadata_after_incomplete_walk() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("archive.tar.gz"), vec![1u8; 4096]).unwrap();
        let entry_reader = DirStatsEntryReader::after_entry(|| {
            Err(std::io::Error::other(
                "injected directory iteration failure",
            ))
        });

        let stats = collect_dir_stats_with_reader(&root, entry_reader, None).await;

        assert!(stats.root_metadata.is_none());
    }

    #[tokio::test]
    async fn collect_dir_stats_submits_one_blocking_task_for_high_entry_tree() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        const DIRECTORY_COUNT: usize = 8;
        const FILES_PER_DIRECTORY: usize = 128;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        for directory_index in 0..DIRECTORY_COUNT {
            let child = root.join(format!("dir-{directory_index}"));
            std::fs::create_dir_all(&child).unwrap();
            for file_index in 0..FILES_PER_DIRECTORY {
                std::fs::File::create(child.join(format!("file-{file_index}"))).unwrap();
            }
        }
        let expected_mtime = std::fs::symlink_metadata(&root)
            .unwrap()
            .modified()
            .unwrap();
        let task_submissions = AtomicUsize::new(0);

        let stats = collect_dir_stats_with_reader(
            &root,
            DirStatsEntryReader::new(),
            Some(&task_submissions),
        )
        .await;

        assert_eq!(task_submissions.load(Ordering::Relaxed), 1);
        assert_eq!(stats.mtime, expected_mtime);
        assert!(stats.root_metadata.is_some());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dropping_collect_dir_stats_stops_the_blocking_walk() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::mpsc;
        use std::time::Duration;

        struct Completion {
            entry_count: Arc<AtomicUsize>,
            finished: mpsc::Sender<usize>,
        }

        impl Drop for Completion {
            fn drop(&mut self) {
                let _ = self.finished.send(self.entry_count.load(Ordering::Relaxed));
            }
        }

        const WAIT_TIMEOUT: Duration = Duration::from_secs(5);

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("first.bin"), vec![1u8; 4096]).unwrap();
        std::fs::write(root.join("second.bin"), vec![2u8; 4096]).unwrap();

        let (reached_tx, reached_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let entry_count = Arc::new(AtomicUsize::new(0));
        let observed_entry_count = Arc::clone(&entry_count);
        let completion = Completion {
            entry_count,
            finished: finished_tx,
        };
        let mut pause = Some((reached_tx, resume_rx));
        let entry_reader = DirStatsEntryReader::after_entry(move || {
            let _completion = &completion;
            if observed_entry_count.fetch_add(1, Ordering::Relaxed) == 0
                && let Some((reached, resume)) = pause.take()
            {
                reached.send(()).unwrap();
                resume.recv().unwrap();
            }
            Ok(())
        });
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            collect_dir_stats_with_cancel(&root, entry_reader, task_cancel, None).await
        });

        reached_rx.recv_timeout(WAIT_TIMEOUT).unwrap();
        task.abort();
        assert!(matches!(task.await, Err(error) if error.is_cancelled()));
        assert!(cancel.is_cancelled());
        resume_tx.send(()).unwrap();
        assert_eq!(finished_rx.recv_timeout(WAIT_TIMEOUT).unwrap(), 1);
    }
});
