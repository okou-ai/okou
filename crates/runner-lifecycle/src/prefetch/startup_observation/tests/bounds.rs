use std::io::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};

use super::*;

const PROFILE_BYTES: usize = 1024 * 1024;

#[tokio::test]
async fn startup_byte_budget_applies_to_actual_file_reads() {
    let directory = tempfile::tempdir().unwrap();
    let limit = PROFILE_BYTES;
    for size in [limit - 17, limit, limit + 17] {
        let path = directory.path().join(format!("memory-{size}.bin"));
        let original = vec![37; size];
        std::fs::write(&path, &original).unwrap();
        let mut tasks = MemoryPrefetchTasks::spawn(
            [MemoryPrefetchCandidate {
                path: path.clone(),
                memory_mb: 1,
            }],
            1,
        );
        tokio::time::timeout(Duration::from_secs(5), tasks.drain())
            .await
            .unwrap();
        let report = tasks.startup_snapshot().unwrap();
        let fits = size <= limit;
        assert_eq!(report.accepted, 1);
        assert_eq!(report.read_bytes, if fits { size as u64 } else { 0 });
        assert_eq!(report.completed, usize::from(fits));
        assert_eq!(report.failed, usize::from(!fits));
        assert_eq!(report.cancelled, 0);
        assert_eq!(report.last_error.is_some(), !fits);
        assert_eq!(tasks.task_count(), 0);
        assert_eq!(std::fs::read(path).unwrap(), original);
    }
}

#[tokio::test]
async fn startup_byte_budget_survives_growth_of_the_opened_file() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("memory.bin");
    let original = vec![37; PROFILE_BYTES];
    let appended = [91; 17];
    std::fs::write(&path, &original).unwrap();
    let extended = Arc::new(AtomicBool::new(false));
    let extend_once = Arc::clone(&extended);
    let growing_path = path.clone();
    let mut tasks = MemoryPrefetchTasks::spawn_with_read_checkpoint_for_test(
        [MemoryPrefetchCandidate {
            path: path.clone(),
            memory_mb: 1,
        }],
        1,
        Arc::new(move |_| {
            if !extend_once.swap(true, Ordering::SeqCst) {
                std::fs::OpenOptions::new()
                    .append(true)
                    .open(&growing_path)?
                    .write_all(&appended)?;
            }
            Ok(())
        }),
    );
    tokio::time::timeout(Duration::from_secs(5), tasks.drain())
        .await
        .unwrap();
    assert!(extended.load(Ordering::SeqCst));
    let report = tasks.startup_snapshot().unwrap();
    assert_eq!(report.accepted, 1);
    assert_eq!(report.read_bytes, PROFILE_BYTES as u64);
    assert_eq!(
        (report.completed, report.cancelled, report.failed),
        (0, 0, 1)
    );
    assert!(report.last_error.is_some());
    assert_eq!(tasks.task_count(), 0);
    let mut expected = original;
    expected.extend_from_slice(&appended);
    assert_eq!(std::fs::read(path).unwrap(), expected);
}
