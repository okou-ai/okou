use std::num::NonZeroUsize;
use std::time::Duration;

use runner_host::test_fixtures::ignored_child::{
    ignored_child_test_env_guard_enabled, run_ignored_child_test,
};

use super::super::{MEMORY_PREFETCH_CHUNK_BYTES, MemoryPrefetchCandidate};
use super::*;

mod bounds;

const FIFO_CHILD_PATH_ENV: &str = "OKOU_STARTUP_PREFETCH_FIFO_CHILD_PATH";

#[tokio::test]
async fn startup_entry_reports_complete_real_file_and_joins_its_workers() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("memory.bin");
    let bytes = vec![37; MEMORY_PREFETCH_CHUNK_BYTES + 17];
    std::fs::write(&path, &bytes).unwrap();
    let mut tasks = MemoryPrefetchTasks::spawn(
        [MemoryPrefetchCandidate {
            path: path.clone(),
            memory_mb: 2,
        }],
        2,
    );
    tasks.drain().await;
    let report = tasks.startup_snapshot().unwrap();
    assert_eq!(
        (
            report.accepted,
            report.completed,
            report.cancelled,
            report.failed
        ),
        (1, 1, 0, 0)
    );
    assert_eq!(report.read_bytes, bytes.len() as u64);
    assert!(report.last_error.is_none());
    assert_eq!(tasks.task_count(), 0);
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[tokio::test]
async fn joined_startup_open_and_read_failures_are_not_complete_reads() {
    let directory = tempfile::tempdir().unwrap();
    for path in [directory.path().join("absent"), directory.path().to_owned()] {
        let mut tasks =
            MemoryPrefetchTasks::spawn([MemoryPrefetchCandidate { path, memory_mb: 1 }], 1);
        tasks.drain().await;
        let report = tasks.startup_snapshot().unwrap();
        assert_eq!(
            (
                report.accepted,
                report.completed,
                report.cancelled,
                report.failed
            ),
            (1, 0, 0, 1)
        );
        assert_eq!(report.read_bytes, 0);
        assert!(report.last_error.is_some());
        assert_eq!(tasks.task_count(), 0);
    }
}

#[tokio::test]
async fn cancellation_after_external_open_is_observed_and_joined() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("memory.fifo");
    // A reader regression can strand a thread in FIFO open/read. An async
    // timeout alone cannot bound Tokio's blocking-thread shutdown.
    run_ignored_child_test(
        "prefetch::startup_observation::tests::cancellation_after_external_open_is_observed_and_joined_child",
        (FIFO_CHILD_PATH_ENV, path.to_str().unwrap()),
        &[],
        Duration::from_secs(5),
    )
    .await;
}

#[tokio::test]
#[ignore = "spawned by cancellation_after_external_open_is_observed_and_joined"]
async fn cancellation_after_external_open_is_observed_and_joined_child() {
    use nix::sys::stat::Mode;
    use nix::unistd::mkfifo;
    use std::io::Write;

    let Ok(path) = std::env::var(FIFO_CHILD_PATH_ENV) else {
        return;
    };
    if !ignored_child_test_env_guard_enabled((FIFO_CHILD_PATH_ENV, &path)) {
        return;
    }
    let path = std::path::PathBuf::from(path);
    mkfifo(&path, Mode::S_IRUSR | Mode::S_IWUSR).unwrap();
    let (opened, receiver) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let writer_path = path.clone();
    let writer = tokio::task::spawn_blocking(move || {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .open(writer_path)
            .unwrap();
        opened.send(()).unwrap();
        released.recv().unwrap();
        // Cancellation may already have closed the read end; that is a real
        // cancelled owner, while a blocked read is released by these bytes.
        let _ = file.write_all(&[1]);
    });
    let mut tasks = MemoryPrefetchTasks::spawn([MemoryPrefetchCandidate { path, memory_mb: 1 }], 1);
    receiver.await.unwrap();
    tasks.cancel();
    release.send(()).unwrap();
    tasks.drain().await;
    writer.await.unwrap();
    let report = tasks.startup_snapshot().unwrap();
    assert_eq!(
        (
            report.accepted,
            report.completed,
            report.cancelled,
            report.failed
        ),
        (1, 0, 1, 0)
    );
    assert!(report.read_bytes <= 1);
    assert!(report.last_error.is_none());
    assert_eq!(tasks.task_count(), 0);
}

#[tokio::test]
async fn non_startup_owners_cannot_supply_startup_success() {
    let mut owner = MemoryPrefetchTasks::spawn_with([], 0, NonZeroUsize::MIN, |_, _, _| {});
    owner.drain().await;
    assert!(owner.startup_snapshot().is_err());
}
