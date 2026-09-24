use std::collections::BTreeMap;
use std::io::Read;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

const MEMORY_PREFETCH_CHUNK_BYTES: usize = 1024 * 1024;
const MEMORY_PREFETCH_CONCURRENCY: NonZeroUsize = NonZeroUsize::MIN;

#[derive(Debug)]
enum PrefetchOutcome {
    Complete { bytes: u64 },
    Cancelled { bytes: u64 },
    OpenFailed { error: std::io::Error },
    ReadFailed { bytes: u64, error: std::io::Error },
}

pub struct MemoryPrefetchCandidate {
    pub path: PathBuf,
    pub memory_mb: u32,
}

pub struct MemoryPrefetchTasks {
    cancel: CancellationToken,
    handles: Vec<JoinHandle<()>>,
}

impl MemoryPrefetchTasks {
    pub fn spawn(
        candidates: impl IntoIterator<Item = MemoryPrefetchCandidate>,
        budget_mb: u64,
    ) -> Self {
        Self::spawn_with(
            candidates,
            budget_mb,
            MEMORY_PREFETCH_CONCURRENCY,
            |path, cancel| {
                let _ = prefetch_memory_with_cancel(path, cancel);
            },
        )
    }

    fn spawn_with<F>(
        candidates: impl IntoIterator<Item = MemoryPrefetchCandidate>,
        budget_mb: u64,
        concurrency: NonZeroUsize,
        prefetch: F,
    ) -> Self
    where
        F: Fn(&Path, &CancellationToken) + Send + Sync + 'static,
    {
        let cancel = CancellationToken::new();
        let mut unique_candidates = BTreeMap::new();
        for candidate in candidates {
            unique_candidates
                .entry(candidate.path)
                .and_modify(|memory_mb: &mut u32| {
                    *memory_mb = (*memory_mb).max(candidate.memory_mb);
                })
                .or_insert(candidate.memory_mb);
        }

        let unique_count = unique_candidates.len();
        let mut candidates: Vec<_> = unique_candidates
            .into_iter()
            .map(|(path, memory_mb)| MemoryPrefetchCandidate { path, memory_mb })
            .collect();
        candidates.sort_by(|left, right| {
            left.memory_mb
                .cmp(&right.memory_mb)
                .then_with(|| left.path.cmp(&right.path))
        });

        let mut selected = Vec::new();
        let mut selected_memory_mb = 0_u64;
        for candidate in candidates {
            let candidate_memory_mb = u64::from(candidate.memory_mb);
            if candidate_memory_mb <= budget_mb.saturating_sub(selected_memory_mb) {
                selected_memory_mb += candidate_memory_mb;
                selected.push(candidate);
            } else {
                info!(
                    path = %candidate.path.display(),
                    memory_mb = candidate.memory_mb,
                    budget_mb,
                    "memory prefetch deferred by startup budget"
                );
            }
        }

        let selected_count = selected.len();
        let deferred_count = unique_count - selected_count;
        info!(
            unique = unique_count,
            selected = selected_count,
            deferred = deferred_count,
            selected_memory_mb,
            budget_mb,
            concurrency = concurrency.get(),
            "memory prefetch schedule initialized"
        );

        let handles = if selected.is_empty() {
            Vec::new()
        } else {
            let task_cancel = cancel.clone();
            vec![tokio::spawn(run_prefetches(
                selected,
                task_cancel,
                concurrency,
                Arc::new(prefetch),
            ))]
        };

        Self { cancel, handles }
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn empty() -> Self {
        Self {
            cancel: CancellationToken::new(),
            handles: Vec::new(),
        }
    }

    pub fn cancel(&self) {
        self.cancel.cancel();
    }

    pub async fn drain(&mut self) {
        for handle in self.handles.drain(..) {
            if let Err(error) = handle.await {
                warn!(error = %error, "memory prefetch task failed");
            }
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn task_count(&self) -> usize {
        self.handles.len()
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn from_test_handle(cancel: CancellationToken, handle: JoinHandle<()>) -> Self {
        Self {
            cancel,
            handles: vec![handle],
        }
    }
}

async fn run_prefetches<F>(
    candidates: Vec<MemoryPrefetchCandidate>,
    cancel: CancellationToken,
    concurrency: NonZeroUsize,
    prefetch: Arc<F>,
) where
    F: Fn(&Path, &CancellationToken) + Send + Sync + 'static,
{
    let mut candidates = candidates.into_iter();
    let mut active = JoinSet::new();

    loop {
        while active.len() < concurrency.get() && !cancel.is_cancelled() {
            let Some(candidate) = candidates.next() else {
                break;
            };
            let task_cancel = cancel.clone();
            let task_prefetch = Arc::clone(&prefetch);
            active.spawn_blocking(move || {
                task_prefetch(&candidate.path, &task_cancel);
            });
        }

        if active.is_empty() {
            break;
        }

        if let Some(Err(error)) = active.join_next().await {
            warn!(error = %error, "memory prefetch task failed");
        }
    }
}

impl Drop for MemoryPrefetchTasks {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// Read a file sequentially to populate the host page cache.
///
/// Firecracker mmaps `memory.bin` on snapshot restore; without the file in
/// page cache, guest memory accesses trigger host-side demand paging.
/// This performs blocking I/O — callers should use `spawn_blocking`.
pub fn prefetch_memory(path: &Path) {
    let _ = prefetch_memory_with_cancel(path, &CancellationToken::new());
}

fn prefetch_memory_with_cancel(path: &Path, cancel: &CancellationToken) -> PrefetchOutcome {
    let outcome = if cancel.is_cancelled() {
        PrefetchOutcome::Cancelled { bytes: 0 }
    } else {
        match std::fs::File::open(path) {
            Ok(mut file) => prefetch_reader(&mut file, cancel),
            Err(error) => PrefetchOutcome::OpenFailed { error },
        }
    };

    match &outcome {
        PrefetchOutcome::Complete { bytes } => {
            info!(bytes = *bytes, path = %path.display(), "memory prefetch complete");
        }
        PrefetchOutcome::Cancelled { bytes } => {
            info!(bytes = *bytes, path = %path.display(), "memory prefetch cancelled");
        }
        PrefetchOutcome::OpenFailed { error } => {
            warn!(error = %error, path = %path.display(), "memory prefetch: open failed");
        }
        PrefetchOutcome::ReadFailed { bytes, error } => {
            warn!(error = %error, bytes = *bytes, path = %path.display(), "memory prefetch: read failed");
        }
    }

    outcome
}

fn prefetch_reader<R: Read>(reader: &mut R, cancel: &CancellationToken) -> PrefetchOutcome {
    let mut buf = vec![0u8; MEMORY_PREFETCH_CHUNK_BYTES];
    let mut total: u64 = 0;
    loop {
        if cancel.is_cancelled() {
            return PrefetchOutcome::Cancelled { bytes: total };
        }

        let n = match reader.read(&mut buf) {
            Ok(n) => n,
            Err(error) => {
                return PrefetchOutcome::ReadFailed {
                    bytes: total,
                    error,
                };
            }
        };
        if n == 0 {
            return PrefetchOutcome::Complete { bytes: total };
        }
        total += n as u64;

        if cancel.is_cancelled() {
            return PrefetchOutcome::Cancelled { bytes: total };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Condvar, Mutex};
    use std::time::Duration;
    use tokio::sync::{mpsc, oneshot};

    #[test]
    fn prefetch_memory_reports_completed_bytes_for_multi_chunk_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memory.bin");
        let contents = vec![0u8; MEMORY_PREFETCH_CHUNK_BYTES + 17];
        std::fs::write(&path, &contents).unwrap();

        let outcome = prefetch_memory_with_cancel(&path, &CancellationToken::new());

        match outcome {
            PrefetchOutcome::Complete { bytes } => {
                assert_eq!(bytes, contents.len() as u64);
            }
            other => panic!("expected completed prefetch, got {other:?}"),
        }
    }

    #[test]
    fn prefetch_memory_reports_open_failure_for_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.bin");

        let outcome = prefetch_memory_with_cancel(&path, &CancellationToken::new());

        assert!(matches!(outcome, PrefetchOutcome::OpenFailed { .. }));
    }

    #[test]
    fn prefetch_memory_reports_zero_bytes_for_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.bin");
        std::fs::write(&path, b"").unwrap();

        let outcome = prefetch_memory_with_cancel(&path, &CancellationToken::new());

        assert!(matches!(outcome, PrefetchOutcome::Complete { bytes: 0 }));
    }

    #[test]
    fn prefetch_reader_stops_before_read_when_cancelled() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let mut reader = TestReader::new(3, None, cancel.clone());

        let outcome = prefetch_reader(&mut reader, &cancel);

        assert!(matches!(outcome, PrefetchOutcome::Cancelled { bytes: 0 }));
        assert_eq!(reader.reads, 0);
    }

    #[test]
    fn prefetch_reader_stops_between_chunks_when_cancelled() {
        let cancel = CancellationToken::new();
        let mut reader = TestReader::new(3, Some(1), cancel.clone());

        let outcome = prefetch_reader(&mut reader, &cancel);

        assert!(matches!(outcome, PrefetchOutcome::Cancelled { bytes: 1 }));
        assert_eq!(reader.reads, 1);
    }

    #[test]
    fn prefetch_reader_reports_bytes_read_before_failure() {
        let cancel = CancellationToken::new();
        let mut reader = FailingReader { reads: 0 };

        let outcome = prefetch_reader(&mut reader, &cancel);

        assert!(matches!(
            outcome,
            PrefetchOutcome::ReadFailed { bytes: 1, .. }
        ));
    }

    #[tokio::test]
    async fn memory_prefetch_tasks_select_smallest_unique_paths_within_budget() {
        let path_a = PathBuf::from("/snapshots/a/memory.bin");
        let path_b = PathBuf::from("/snapshots/b/memory.bin");
        let path_c = PathBuf::from("/snapshots/c/memory.bin");
        let path_d = PathBuf::from("/snapshots/d/memory.bin");
        let (started_tx, mut started_rx) = mpsc::unbounded_channel();
        let mut tasks = MemoryPrefetchTasks::spawn_with(
            [
                candidate(&path_a, 2),
                candidate(&path_b, 2),
                candidate(&path_c, 4),
                candidate(&path_d, 1),
                candidate(&path_a, 5),
                candidate(&path_b, 2),
            ],
            7,
            NonZeroUsize::MIN,
            move |path, _| {
                started_tx.send(path.to_path_buf()).unwrap();
            },
        );

        assert_eq!(tasks.task_count(), 1);
        tasks.drain().await;
        assert_eq!(tasks.task_count(), 0);

        let mut started = Vec::new();
        while let Ok(path) = started_rx.try_recv() {
            started.push(path);
        }
        assert_eq!(started, [path_d, path_b, path_c]);
    }

    #[tokio::test]
    async fn memory_prefetch_tasks_bound_active_blocking_work() {
        let (started_tx, mut started_rx) = mpsc::unbounded_channel();
        let gate = Arc::new(BlockingGate::new(started_tx));
        let task_gate = Arc::clone(&gate);
        let mut tasks = MemoryPrefetchTasks::spawn_with(
            [
                candidate("/snapshots/a/memory.bin", 1),
                candidate("/snapshots/b/memory.bin", 2),
                candidate("/snapshots/c/memory.bin", 3),
                candidate("/snapshots/d/memory.bin", 4),
            ],
            10,
            NonZeroUsize::new(2).unwrap(),
            move |path, _| task_gate.run(path),
        );

        tokio::time::timeout(Duration::from_secs(5), async {
            started_rx.recv().await.unwrap();
            started_rx.recv().await.unwrap();
        })
        .await
        .expect("two prefetch tasks should enter the gate");
        gate.release_all();
        tasks.drain().await;

        let state = gate.state();
        assert_eq!(state.started.len(), 4);
        assert_eq!(state.max_active, 2);
        assert_eq!(state.active, 0);
    }

    #[tokio::test]
    async fn memory_prefetch_tasks_cancel_queued_work_before_blocking_submission() {
        let first_path = PathBuf::from("/snapshots/first/memory.bin");
        let (started_tx, mut started_rx) = mpsc::unbounded_channel();
        let gate = Arc::new(BlockingGate::new(started_tx));
        let task_gate = Arc::clone(&gate);
        let mut tasks = MemoryPrefetchTasks::spawn_with(
            [
                candidate(&first_path, 1),
                candidate("/snapshots/second/memory.bin", 2),
                candidate("/snapshots/third/memory.bin", 3),
            ],
            6,
            NonZeroUsize::MIN,
            move |path, _| task_gate.run(path),
        );

        let started = tokio::time::timeout(Duration::from_secs(5), started_rx.recv())
            .await
            .expect("first prefetch should enter the gate")
            .expect("prefetch gate should report the first path");
        assert_eq!(started, first_path);

        tasks.cancel();
        gate.release_all();
        tasks.drain().await;

        let state = gate.state();
        assert_eq!(state.started, [first_path]);
        assert_eq!(state.max_active, 1);
        assert_eq!(state.active, 0);
    }

    #[tokio::test]
    async fn memory_prefetch_tasks_cancel_and_drain() {
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let (cancelled_tx, cancelled_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let handle = tokio::spawn(async move {
            task_cancel.cancelled().await;
            let _ = cancelled_tx.send(());
            let _ = release_rx.await;
        });
        let mut tasks = MemoryPrefetchTasks::from_test_handle(cancel, handle);

        tasks.cancel();
        tokio::time::timeout(Duration::from_secs(5), cancelled_rx)
            .await
            .expect("prefetch task should observe cancellation")
            .expect("prefetch task should report cancellation");
        release_tx
            .send(())
            .expect("prefetch task should wait for release");
        tasks.drain().await;

        assert_eq!(tasks.task_count(), 0);
    }

    #[tokio::test]
    async fn memory_prefetch_tasks_drop_cancels() {
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let (cancelled_tx, cancelled_rx) = oneshot::channel();
        let handle = tokio::spawn(async move {
            task_cancel.cancelled().await;
            let _ = cancelled_tx.send(());
        });

        let tasks = MemoryPrefetchTasks::from_test_handle(cancel, handle);
        drop(tasks);

        tokio::time::timeout(Duration::from_secs(5), cancelled_rx)
            .await
            .expect("dropped prefetch owner should cancel task")
            .expect("prefetch task should report cancellation");
    }

    fn candidate(path: impl Into<PathBuf>, memory_mb: u32) -> MemoryPrefetchCandidate {
        MemoryPrefetchCandidate {
            path: path.into(),
            memory_mb,
        }
    }

    struct BlockingGate {
        state: Mutex<BlockingGateState>,
        release: Condvar,
        started_tx: mpsc::UnboundedSender<PathBuf>,
    }

    #[derive(Clone)]
    struct BlockingGateState {
        released: bool,
        active: usize,
        max_active: usize,
        started: Vec<PathBuf>,
    }

    impl BlockingGate {
        fn new(started_tx: mpsc::UnboundedSender<PathBuf>) -> Self {
            Self {
                state: Mutex::new(BlockingGateState {
                    released: false,
                    active: 0,
                    max_active: 0,
                    started: Vec::new(),
                }),
                release: Condvar::new(),
                started_tx,
            }
        }

        fn run(&self, path: &Path) {
            let mut state = self.state.lock().unwrap();
            state.active += 1;
            state.max_active = state.max_active.max(state.active);
            state.started.push(path.to_path_buf());
            self.started_tx.send(path.to_path_buf()).unwrap();

            while !state.released {
                state = self.release.wait(state).unwrap();
            }
            state.active -= 1;
        }

        fn release_all(&self) {
            self.state.lock().unwrap().released = true;
            self.release.notify_all();
        }

        fn state(&self) -> BlockingGateState {
            self.state.lock().unwrap().clone()
        }
    }

    struct TestReader {
        remaining_reads: usize,
        cancel_after_read: Option<usize>,
        cancel: CancellationToken,
        reads: usize,
    }

    impl TestReader {
        fn new(
            remaining_reads: usize,
            cancel_after_read: Option<usize>,
            cancel: CancellationToken,
        ) -> Self {
            Self {
                remaining_reads,
                cancel_after_read,
                cancel,
                reads: 0,
            }
        }
    }

    impl Read for TestReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.remaining_reads == 0 {
                return Ok(0);
            }

            self.remaining_reads -= 1;
            self.reads += 1;
            buf[0] = 0;

            if self.cancel_after_read == Some(self.reads) {
                self.cancel.cancel();
            }

            Ok(1)
        }
    }

    struct FailingReader {
        reads: usize,
    }

    impl Read for FailingReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.reads == 1 {
                return Err(std::io::Error::other("boom"));
            }
            self.reads += 1;
            buf[0] = 0;
            Ok(1)
        }
    }
}
