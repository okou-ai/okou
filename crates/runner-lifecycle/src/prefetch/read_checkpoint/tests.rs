use std::sync::{Condvar, Mutex};
use std::time::Duration;

use super::*;

#[tokio::test]
async fn actual_startup_checkpoint_preserves_complete_file_and_reports_io_failure() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("memory.bin");
    let bytes = vec![7; MEMORY_PREFETCH_CHUNK_BYTES + 17];
    std::fs::write(&path, &bytes).unwrap();
    for fail in [false, true] {
        let observed = Arc::new(Mutex::new(Vec::new()));
        let record = observed.clone();
        let mut owner = MemoryPrefetchTasks::spawn_with_read_checkpoint_for_test(
            [MemoryPrefetchCandidate {
                path: path.clone(),
                memory_mb: 2,
            }],
            2,
            Arc::new(move |count| {
                record.lock().unwrap().push(count);
                if fail {
                    Err(io::Error::other("checkpoint IO failed"))
                } else {
                    Ok(())
                }
            }),
        );
        owner.drain().await;
        let result = owner.startup_snapshot().unwrap();
        assert_eq!(result.accepted, 1);
        assert_eq!(result.completed, usize::from(!fail));
        assert_eq!(result.failed, usize::from(fail));
        assert_eq!(result.cancelled, 0);
        assert_eq!(
            result.read_bytes,
            if fail {
                1024 * 1024
            } else {
                bytes.len() as u64
            }
        );
        assert_eq!(result.last_error.is_some(), fail);
        assert_eq!(
            *observed.lock().unwrap(),
            if fail {
                vec![1024 * 1024]
            } else {
                vec![1024 * 1024, bytes.len() as u64]
            }
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
}

struct Gate {
    entered: tokio::sync::Notify,
    released: Mutex<bool>,
    changed: Condvar,
}

impl Gate {
    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.changed.notify_all();
    }
}

struct Release(Arc<Gate>);

impl Drop for Release {
    fn drop(&mut self) {
        self.0.release();
    }
}

#[tokio::test]
async fn cancelled_actual_startup_read_retains_physical_io_after_dropped_drain() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("memory.bin");
    let bytes = vec![7; MEMORY_PREFETCH_CHUNK_BYTES + 17];
    std::fs::write(&path, &bytes).unwrap();
    let gate = Arc::new(Gate {
        entered: tokio::sync::Notify::new(),
        released: Mutex::new(false),
        changed: Condvar::new(),
    });
    let release = Release(gate.clone());
    let held = gate.clone();
    let mut owner = MemoryPrefetchTasks::spawn_with_read_checkpoint_for_test(
        [MemoryPrefetchCandidate {
            path: path.clone(),
            memory_mb: 2,
        }],
        2,
        Arc::new(move |count| {
            assert_eq!(count, 1024 * 1024);
            held.entered.notify_one();
            let mut open = held.released.lock().unwrap();
            while !*open {
                open = held.changed.wait(open).unwrap();
            }
            Ok(())
        }),
    );
    tokio::time::timeout(Duration::from_secs(5), gate.entered.notified())
        .await
        .unwrap();
    owner.cancel();
    {
        let first = owner.drain();
        tokio::pin!(first);
        assert!(futures_util::poll!(&mut first).is_pending());
    }
    {
        let second = owner.drain();
        tokio::pin!(second);
        assert!(futures_util::poll!(&mut second).is_pending());
        gate.release();
        tokio::time::timeout(Duration::from_secs(5), second)
            .await
            .unwrap();
    }
    let result = owner.startup_snapshot().unwrap();
    assert_eq!(
        (
            result.accepted,
            result.cancelled,
            result.completed,
            result.failed
        ),
        (1, 1, 0, 0)
    );
    assert_eq!(result.read_bytes, 1024 * 1024);
    assert!(result.last_error.is_none());
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    drop(release);
}
