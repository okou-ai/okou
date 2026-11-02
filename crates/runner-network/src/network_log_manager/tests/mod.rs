use std::future::poll_fn;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::Path;
use std::task::Poll;
use std::time::Duration;

use serde_json::json;

use crate::network_log_drain::{NetworkLogDrainCoordinator, NetworkLogDrainProducer};
use runner_types::ids::RunId;

use super::*;

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn read_json_lines(path: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

async fn source_ip_registered(manager: &NetworkLogManager, source_ip: &str) -> bool {
    manager.inner.state.source_ip_registered(source_ip)
}

async fn wait_source_ip_unregistered(manager: &NetworkLogManager, source_ip: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        if !source_ip_registered(manager, source_ip).await {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "source IP {source_ip} stayed registered after session drop",
        );
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn writer_panic_does_not_strand_accepted_sessions_or_flush_waiters() {
    let dir = tempfile::tempdir().unwrap();
    let first_path = dir.path().join("first.jsonl");
    let second_path = dir.path().join("second.jsonl");
    let started = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let manager = NetworkLogManager::new_with_write_gate_and_config(
        Arc::clone(&started),
        Arc::clone(&release),
        WriterConfig {
            shards: 1,
            ..Default::default()
        },
    );
    let first = manager
        .register_source_ip("10.0.0.1", first_path.clone())
        .await;
    let second = manager
        .register_source_ip("10.0.0.2", second_path.clone())
        .await;
    assert!(manager.append_for_ip("10.0.0.1", json!({"row": 1})).await);
    started.notified().await;
    // The first batch is owned by the writer; these rows remain queued.
    assert!(manager.append_for_ip("10.0.0.1", json!({"row": 2})).await);
    assert!(manager.append_for_ip("10.0.0.2", json!({"row": 3})).await);
    release.close(); // Fail at the append boundary, unwinding the outer writer.
    let drain = NetworkLogDrainCoordinator::default();
    let (first_observation, second_observation, (), ()) =
        tokio::time::timeout(Duration::from_secs(2), async {
            tokio::join!(
                first.close_for_upload(RunId::new_v4(), &drain),
                second.close_for_upload(RunId::new_v4(), &drain),
                manager.flush_path(&first_path),
                manager.flush_path(&first_path),
            )
        })
        .await
        .expect("terminated writer must not strand accepted rows or concurrent flush waiters");
    assert!(first_observation.writer_failed());
    assert!(second_observation.writer_failed());
    assert!(!first_path.exists());
    assert!(!second_path.exists());
}

// Prevent a failing assertion from leaving a real blocking task held while
// the test runtime tries to shut down.
struct CloseWriteGateOnDrop(Arc<Semaphore>);

impl Drop for CloseWriteGateOnDrop {
    fn drop(&mut self) {
        self.0.close();
    }
}

#[tokio::test]
async fn cancelled_writer_keeps_blocking_append_owned_until_real_file_completion() {
    use tracing_subscriber::prelude::*;
    use tracing_test_support::CapturedEvents;

    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    tracing::callsite::rebuild_interest_cache();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let started = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let _release_on_drop = CloseWriteGateOnDrop(Arc::clone(&release));
    let manager = NetworkLogManager::new_for_test(
        Some(WriteGate {
            started: Arc::clone(&started),
            release: Arc::clone(&release),
            blocking: true,
        }),
        None,
        WriterConfig {
            shards: 1,
            ..Default::default()
        },
    );
    let session = manager.register_source_ip("10.0.0.1", path.clone()).await;
    assert!(manager.append_for_ip("10.0.0.1", json!({"row": 1})).await);
    tokio::time::timeout(Duration::from_secs(2), started.notified())
        .await
        .unwrap();
    assert!(manager.append_for_ip("10.0.0.1", json!({"row": 2})).await);
    let writer = &manager.writer_pool().tasks[0];
    writer.abort();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !writer.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let drain = NetworkLogDrainCoordinator::noop();
    let run_id = RunId::new_v4();
    let close = session.close_for_upload(run_id, &drain);
    tokio::pin!(close);
    tokio::select! {
        biased;
        _ = &mut close => panic!("outer writer cancellation discharged an active blocking append"),
        _ = tokio::task::yield_now() => {}
    }
    assert!(!path.exists());
    tokio::time::pause();
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(31)).await;
    tokio::task::yield_now().await;
    assert!(
        captured.entries().iter().any(|event| {
            event.fields.get("message").map(String::as_str)
                == Some("required cleanup still pending")
                && event.fields.get("phase").map(String::as_str) == Some("accepted_write_flush")
                && event.fields.get("run_id") == Some(&run_id.to_string())
        }),
        "delayed flush must identify its run without claiming completion"
    );
    tokio::time::resume();
    release.add_permits(1);
    let observation = tokio::time::timeout(Duration::from_secs(2), close)
        .await
        .unwrap();
    assert!(
        observation.writer_failed(),
        "the queued row was abandoned, not persisted"
    );
    assert_eq!(read_json_lines(&path), vec![json!({"row": 1})]);
}

#[tokio::test]
async fn blocking_append_failure_is_observed_after_source_mapping_is_removed() {
    for panic in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.jsonl");
        // A directory is rejected by the actual append boundary.
        std::fs::create_dir(&path).unwrap();
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let _release_on_drop = CloseWriteGateOnDrop(Arc::clone(&release));
        let manager = NetworkLogManager::new_for_test(
            Some(WriteGate {
                started: Arc::clone(&started),
                release: Arc::clone(&release),
                blocking: true,
            }),
            None,
            WriterConfig::default(),
        );
        let session = manager.register_source_ip("10.0.0.1", path.clone()).await;
        assert!(manager.append_for_ip("10.0.0.1", json!({"row": 1})).await);
        tokio::time::timeout(Duration::from_secs(2), started.notified())
            .await
            .unwrap();
        let drain = NetworkLogDrainCoordinator::noop();
        let close = session.close_for_upload(RunId::new_v4(), &drain);
        tokio::pin!(close);
        tokio::select! {
            biased;
            _ = &mut close => panic!("close completed before append result"),
            _ = tokio::task::yield_now() => {}
        }
        assert!(!source_ip_registered(&manager, "10.0.0.1").await);
        if panic {
            release.close();
        } else {
            release.add_permits(1);
        }
        let observation = tokio::time::timeout(Duration::from_secs(2), close)
            .await
            .unwrap();
        assert!(observation.writer_failed());
        assert!(path.is_dir());
    }
}

#[tokio::test]
async fn batched_append_settles_original_sessions_after_same_path_reregistration() {
    for write_fails in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let first_path = dir.path().join("first.jsonl");
        let shared_path = dir.path().join("shared.jsonl");
        let other_path = dir.path().join("other.jsonl");
        if write_fails {
            std::fs::create_dir(&shared_path).unwrap();
        }
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let _release_on_drop = CloseWriteGateOnDrop(Arc::clone(&release));
        let manager = NetworkLogManager::new_for_test(
            Some(WriteGate {
                started: Arc::clone(&started),
                release: Arc::clone(&release),
                blocking: true,
            }),
            None,
            WriterConfig {
                shards: 1,
                ..Default::default()
            },
        );
        let first = manager
            .register_source_ip("10.0.0.1", first_path.clone())
            .await;
        let old = manager
            .register_source_ip("10.0.0.2", shared_path.clone())
            .await;
        let other = manager
            .register_source_ip("10.0.0.3", other_path.clone())
            .await;
        assert!(manager.append_for_ip("10.0.0.1", json!({"row": 0})).await);
        tokio::time::timeout(Duration::from_secs(2), started.notified())
            .await
            .unwrap();

        // Hold the first append so both generations enter the next path batch.
        assert!(manager.append_for_ip("10.0.0.2", json!({"row": 1})).await);
        assert!(manager.append_for_ip("10.0.0.2", json!({"row": 2})).await);
        let new = manager
            .register_source_ip("10.0.0.2", shared_path.clone())
            .await;
        assert!(manager.append_for_ip("10.0.0.2", json!({"row": 3})).await);
        assert!(manager.append_for_ip("10.0.0.2", json!({"row": 4})).await);
        assert!(manager.append_for_ip("10.0.0.3", json!({"row": 5})).await);
        assert!(manager.append_for_ip("10.0.0.3", json!({"row": 6})).await);
        release.add_permits(1);
        tokio::time::timeout(Duration::from_secs(2), started.notified())
            .await
            .unwrap();

        let drain = NetworkLogDrainCoordinator::noop();
        let close = async {
            tokio::join!(
                old.close_for_upload(RunId::new_v4(), &drain),
                new.close_for_upload(RunId::new_v4(), &drain),
            )
        };
        tokio::pin!(close);
        assert!(poll_fn(|cx| Poll::Ready(close.as_mut().poll(cx).is_pending())).await);
        assert!(
            !manager
                .append_for_ip("10.0.0.2", json!({"row": "after-close"}))
                .await
        );
        if write_fails {
            assert!(shared_path.is_dir());
        } else {
            assert!(!shared_path.exists());
        }

        release.add_permits(1);
        // The other path remains held while both shared-path sessions finish.
        tokio::time::timeout(Duration::from_secs(2), started.notified())
            .await
            .unwrap();
        let (old_observation, new_observation) =
            tokio::time::timeout(Duration::from_secs(2), close)
                .await
                .unwrap();
        assert_eq!(old_observation.writer_failed(), write_fails);
        assert_eq!(new_observation.writer_failed(), write_fails);
        if write_fails {
            assert!(shared_path.is_dir());
        } else {
            assert_eq!(
                read_json_lines(&shared_path),
                vec![
                    json!({"row": 1}),
                    json!({"row": 2}),
                    json!({"row": 3}),
                    json!({"row": 4})
                ]
            );
        }
        let mut other_flush = std::pin::pin!(manager.flush_path(&other_path));
        assert!(poll_fn(|cx| Poll::Ready(other_flush.as_mut().poll(cx).is_pending())).await);
        assert!(!other_path.exists());
        release.add_permits(1);
        let ((), first_observation, other_observation) =
            tokio::time::timeout(Duration::from_secs(2), async {
                tokio::join!(
                    other_flush,
                    first.close_for_upload(RunId::new_v4(), &drain),
                    other.close_for_upload(RunId::new_v4(), &drain),
                )
            })
            .await
            .unwrap();
        assert!(!first_observation.writer_failed());
        assert!(!other_observation.writer_failed());
        assert_eq!(read_json_lines(&first_path), vec![json!({"row": 0})]);
        assert_eq!(
            read_json_lines(&other_path),
            vec![json!({"row": 5}), json!({"row": 6})]
        );
    }
}

#[tokio::test]
async fn append_for_ip_writes_json_line_to_registered_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let manager = NetworkLogManager::new();

    let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    assert!(
        manager
            .append_for_ip(
                "10.200.0.2",
                json!({"type":"dns","host":"example.com","port":53}),
            )
            .await
    );

    manager.flush_path(&path).await;

    let lines = read_json_lines(&path);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["type"], "dns");
    assert_eq!(lines[0]["host"], "example.com");
    assert_eq!(lines[0]["port"], 53);
    assert_eq!(mode(&path), 0o600);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_first_use_accepts_every_row() {
    const APPEND_COUNT: usize = 32;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let manager = NetworkLogManager::new();
    let barrier = Arc::new(Barrier::new(APPEND_COUNT));
    let mut sessions = Vec::with_capacity(APPEND_COUNT);
    let mut append_tasks = Vec::with_capacity(APPEND_COUNT);

    for index in 0..APPEND_COUNT {
        let source_ip = format!("10.200.0.{}", index + 1);
        sessions.push(
            manager
                .register_source_ip(source_ip.clone(), path.clone())
                .await,
        );

        let manager = manager.clone();
        let barrier = barrier.clone();
        append_tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            manager
                .append_for_ip(&source_ip, json!({"type":"dns","index":index}))
                .await
        }));
    }

    for task in append_tasks {
        assert!(task.await.unwrap());
    }
    manager.flush_path(&path).await;

    let mut indices: Vec<u64> = read_json_lines(&path)
        .iter()
        .map(|line| line["index"].as_u64().unwrap())
        .collect();
    indices.sort_unstable();
    assert_eq!(indices, (0..APPEND_COUNT as u64).collect::<Vec<_>>());
}

#[tokio::test]
async fn append_for_ip_flushes_after_rejecting_unsafe_path() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target.jsonl");
    let path = dir.path().join("network.jsonl");
    symlink(&target, &path).unwrap();
    let manager = NetworkLogManager::new();

    let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    assert!(
        manager
            .append_for_ip(
                "10.200.0.2",
                json!({"type":"dns","host":"example.com","port":53}),
            )
            .await
    );

    manager.flush_path(&path).await;

    assert!(!target.exists());
}

#[tokio::test]
async fn flush_path_waits_for_accepted_pending_writes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let started = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let manager = NetworkLogManager::new_with_write_gate(started.clone(), release.clone());

    let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    assert!(
        manager
            .append_for_ip("10.200.0.2", json!({"type":"dns","host":"held.test"}))
            .await
    );
    started.notified().await;

    let mut flush = std::pin::pin!(manager.flush_path(&path));
    let pending = poll_fn(|cx| match flush.as_mut().poll(cx) {
        Poll::Ready(()) => Poll::Ready(false),
        Poll::Pending => Poll::Ready(true),
    })
    .await;
    assert!(
        pending,
        "flush should wait while the accepted write is pending"
    );

    release.add_permits(1);
    flush.await;

    let lines = read_json_lines(&path);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["host"], "held.test");
}

#[tokio::test]
async fn flush_path_waits_for_all_pending_writes_for_same_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let started = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let manager = NetworkLogManager::new_with_write_gate(started.clone(), release.clone());

    let _session_a = manager.register_source_ip("10.200.0.2", path.clone()).await;
    let _session_b = manager.register_source_ip("10.200.0.3", path.clone()).await;

    let first_started = started.notified();
    assert!(
        manager
            .append_for_ip("10.200.0.2", json!({"type":"dns","host":"first.test"}))
            .await
    );
    first_started.await;

    assert!(
        manager
            .append_for_ip("10.200.0.3", json!({"type":"dns","host":"second.test"}))
            .await
    );

    let mut flush = std::pin::pin!(manager.flush_path(&path));
    let pending = poll_fn(|cx| match flush.as_mut().poll(cx) {
        Poll::Ready(()) => Poll::Ready(false),
        Poll::Pending => Poll::Ready(true),
    })
    .await;
    assert!(
        pending,
        "flush should wait while both accepted writes are pending"
    );

    let second_started = started.notified();
    release.add_permits(1);
    second_started.await;
    let still_pending = poll_fn(|cx| match flush.as_mut().poll(cx) {
        Poll::Ready(()) => Poll::Ready(false),
        Poll::Pending => Poll::Ready(true),
    })
    .await;
    assert!(
        still_pending,
        "flush should still wait after only one pending write is released"
    );

    release.add_permits(1);
    flush.await;

    let lines = read_json_lines(&path);
    let hosts: std::collections::HashSet<String> = lines
        .iter()
        .map(|line| line["host"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        hosts,
        ["first.test", "second.test"]
            .into_iter()
            .map(str::to_string)
            .collect()
    );
}

#[tokio::test]
async fn append_failure_decrements_pending_and_flush_completes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing").join("network.jsonl");
    let manager = NetworkLogManager::new();

    let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    assert!(
        manager
            .append_for_ip("10.200.0.2", json!({"type":"dns","host":"bad-path.test"}))
            .await
    );

    manager.flush_path(&path).await;
    assert!(!path.exists());
}

#[tokio::test]
async fn append_for_ip_preserves_same_path_order() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let manager = NetworkLogManager::new();

    let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    for index in 0..20 {
        assert!(
            manager
                .append_for_ip("10.200.0.2", json!({"type":"dns","index":index}))
                .await
        );
    }

    manager.flush_path(&path).await;

    let lines = read_json_lines(&path);
    let indices: Vec<u64> = lines
        .iter()
        .map(|line| line["index"].as_u64().unwrap())
        .collect();
    assert_eq!(indices, (0_u64..20).collect::<Vec<_>>());
}

#[tokio::test]
async fn append_after_unregister_is_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let manager = NetworkLogManager::new();

    let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    manager.unregister_source_ip("10.200.0.2").await;

    assert!(
        !manager
            .append_for_ip("10.200.0.2", json!({"type":"dns","host":"old.test"}))
            .await
    );
    manager.flush_path(&path).await;

    assert!(!path.exists());
}

#[tokio::test]
async fn accepted_write_lands_after_unregister() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let started = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let manager = NetworkLogManager::new_with_write_gate(started.clone(), release.clone());

    let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    assert!(
        manager
            .append_for_ip("10.200.0.2", json!({"type":"dns","host":"accepted.test"}))
            .await
    );
    started.notified().await;

    manager.unregister_source_ip("10.200.0.2").await;
    release.add_permits(1);
    manager.flush_path(&path).await;

    let lines = read_json_lines(&path);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["host"], "accepted.test");
}

#[tokio::test]
async fn repeated_appends_share_path_and_stay_on_old_path_after_reregister() {
    let dir = tempfile::tempdir().unwrap();
    let old_path = dir.path().join("old.jsonl");
    let new_path = dir.path().join("new.jsonl");
    let started = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let manager = NetworkLogManager::new_with_write_gate_and_config(
        started.clone(),
        release.clone(),
        WriterConfig {
            shards: 1,
            queue_capacity: 4,
            max_batch_rows: 1,
            max_batch_bytes: DEFAULT_MAX_BATCH_BYTES,
        },
    );

    let _old_session = manager
        .register_source_ip("10.200.0.2", old_path.clone())
        .await;
    let old_started = started.notified();
    assert!(
        manager
            .append_for_ip("10.200.0.2", json!({"type":"dns","host":"old-1.test"}))
            .await
    );
    old_started.await;
    assert!(
        manager
            .append_for_ip("10.200.0.2", json!({"type":"dns","host":"old-2.test"}))
            .await
    );
    assert!(
        manager
            .inner
            .state
            .source_and_pending_path_share_identity("10.200.0.2", &old_path),
        "repeated appends should reuse the registered path allocation"
    );

    manager.unregister_source_ip("10.200.0.2").await;
    let _new_session = manager
        .register_source_ip("10.200.0.2", new_path.clone())
        .await;
    assert!(
        manager
            .append_for_ip("10.200.0.2", json!({"type":"dns","host":"new.test"}))
            .await
    );
    assert!(
        manager
            .inner
            .state
            .source_and_pending_path_share_identity("10.200.0.2", &new_path),
        "re-registered source should share its new path allocation"
    );

    release.add_permits(3);
    manager.flush_path(&old_path).await;
    manager.flush_path(&new_path).await;

    let old_lines = read_json_lines(&old_path);
    let old_hosts: Vec<&str> = old_lines
        .iter()
        .map(|line| line["host"].as_str().unwrap())
        .collect();
    assert_eq!(old_hosts, ["old-1.test", "old-2.test"]);

    let new_lines = read_json_lines(&new_path);
    assert_eq!(new_lines.len(), 1);
    assert_eq!(new_lines[0]["host"], "new.test");
}

#[tokio::test]
async fn queue_full_waits_without_accepting_row_before_capacity() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let started = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let manager = NetworkLogManager::new_with_write_gate_and_config(
        started.clone(),
        release.clone(),
        WriterConfig {
            shards: 1,
            queue_capacity: 1,
            max_batch_rows: 1,
            max_batch_bytes: DEFAULT_MAX_BATCH_BYTES,
        },
    );

    let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    assert!(
        manager
            .append_for_ip("10.200.0.2", json!({"type":"dns","host":"first.test"}))
            .await
    );
    started.notified().await;
    assert!(
        manager
            .append_for_ip("10.200.0.2", json!({"type":"dns","host":"second.test"}))
            .await
    );

    let third = manager.append_for_ip("10.200.0.2", json!({"type":"dns","host":"third.test"}));
    let mut third = std::pin::pin!(third);
    let pending = poll_fn(|cx| match third.as_mut().poll(cx) {
        Poll::Ready(accepted) => Poll::Ready(Some(accepted)),
        Poll::Pending => Poll::Ready(None),
    })
    .await;
    assert_eq!(
        pending, None,
        "third append should wait for bounded queue capacity"
    );

    manager.unregister_source_ip("10.200.0.2").await;
    release.add_permits(2);
    assert!(
        !third.await,
        "append waiting for capacity must re-check source mapping before acceptance"
    );
    manager.flush_path(&path).await;

    let lines = read_json_lines(&path);
    let hosts: Vec<&str> = lines
        .iter()
        .map(|line| line["host"].as_str().unwrap())
        .collect();
    assert_eq!(hosts, ["first.test", "second.test"]);
}

#[tokio::test]
async fn queue_full_is_reported_without_losing_or_reordering_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let started = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let manager = NetworkLogManager::new_with_write_gate_and_config(
        started.clone(),
        release.clone(),
        WriterConfig {
            shards: 1,
            queue_capacity: 1,
            max_batch_rows: 1,
            max_batch_bytes: DEFAULT_MAX_BATCH_BYTES,
        },
    );
    let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    assert!(
        manager
            .append_for_ip("10.200.0.2", json!({"type":"dns","index":1}))
            .await
    );
    started.notified().await;
    assert!(
        manager
            .append_for_ip("10.200.0.2", json!({"type":"dns","index":2}))
            .await
    );

    let third = manager.append_for_ip("10.200.0.2", json!({"type":"dns","index":3}));
    let mut third = std::pin::pin!(third);
    assert!(
        poll_fn(|cx| match third.as_mut().poll(cx) {
            Poll::Ready(_) => Poll::Ready(false),
            Poll::Pending => Poll::Ready(true),
        })
        .await
    );

    release.add_permits(3);
    assert!(third.await);
    let observation = session
        .close_for_upload(
            RunId::from(uuid::Uuid::nil()),
            &NetworkLogDrainCoordinator::noop(),
        )
        .await;

    assert!(observation.writer_backpressure_observed());
    let indices: Vec<u64> = read_json_lines(&path)
        .iter()
        .map(|line| line["index"].as_u64().unwrap())
        .collect();
    assert_eq!(indices, [1, 2, 3]);
}

#[tokio::test]
async fn immediately_reserved_session_reports_no_writer_backpressure() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let manager = NetworkLogManager::new();
    let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    assert!(
        manager
            .append_for_ip("10.200.0.2", json!({"type":"dns","host":"ready.test"}))
            .await
    );

    let observation = session
        .close_for_upload(
            RunId::from(uuid::Uuid::nil()),
            &NetworkLogDrainCoordinator::noop(),
        )
        .await;

    assert!(!observation.writer_backpressure_observed());
    assert_eq!(observation.drain_status("dns"), "not_configured");
}

#[tokio::test]
async fn queue_full_rejects_row_after_source_reregister_same_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let started = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let manager = NetworkLogManager::new_with_write_gate_and_config(
        started.clone(),
        release.clone(),
        WriterConfig {
            shards: 1,
            queue_capacity: 1,
            max_batch_rows: 1,
            max_batch_bytes: DEFAULT_MAX_BATCH_BYTES,
        },
    );

    let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    assert!(
        manager
            .append_for_ip("10.200.0.2", json!({"type":"dns","host":"first.test"}))
            .await
    );
    started.notified().await;
    assert!(
        manager
            .append_for_ip("10.200.0.2", json!({"type":"dns","host":"second.test"}))
            .await
    );

    let third = manager.append_for_ip("10.200.0.2", json!({"type":"dns","host":"third.test"}));
    let mut third = std::pin::pin!(third);
    let pending = poll_fn(|cx| match third.as_mut().poll(cx) {
        Poll::Ready(accepted) => Poll::Ready(Some(accepted)),
        Poll::Pending => Poll::Ready(None),
    })
    .await;
    assert_eq!(
        pending, None,
        "third append should wait for bounded queue capacity"
    );

    manager.unregister_source_ip("10.200.0.2").await;
    let new_session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    release.add_permits(2);
    assert!(
        !third.await,
        "append waiting for capacity must not cross source generations"
    );
    manager.flush_path(&path).await;

    let lines = read_json_lines(&path);
    let hosts: Vec<&str> = lines
        .iter()
        .map(|line| line["host"].as_str().unwrap())
        .collect();
    assert_eq!(hosts, ["first.test", "second.test"]);
    let observation = new_session
        .close_for_upload(
            RunId::from(uuid::Uuid::nil()),
            &NetworkLogDrainCoordinator::noop(),
        )
        .await;
    assert!(
        !observation.writer_backpressure_observed(),
        "an old source generation must not mark its replacement"
    );
}

#[tokio::test]
async fn reregistered_source_ip_routes_to_new_path_only() {
    let dir = tempfile::tempdir().unwrap();
    let old_path = dir.path().join("old.jsonl");
    let new_path = dir.path().join("new.jsonl");
    let manager = NetworkLogManager::new();

    let _old_session = manager
        .register_source_ip("10.200.0.2", old_path.clone())
        .await;
    manager.unregister_source_ip("10.200.0.2").await;
    let _new_session = manager
        .register_source_ip("10.200.0.2", new_path.clone())
        .await;

    assert!(
        manager
            .append_for_ip("10.200.0.2", json!({"type":"dns","host":"new.test"}))
            .await
    );
    manager.flush_path(&new_path).await;

    assert!(!old_path.exists());
    let lines = read_json_lines(&new_path);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["host"], "new.test");
}

#[tokio::test]
async fn close_for_upload_preserves_replacement_during_producer_drain() {
    for same_path in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let old_path = dir.path().join("old.jsonl");
        let new_path = if same_path {
            old_path.clone()
        } else {
            dir.path().join("new.jsonl")
        };
        let manager = NetworkLogManager::new();
        let old = manager
            .register_source_ip("10.200.0.2", old_path.clone())
            .await;
        let (producer, mut drain_rx) = NetworkLogDrainProducer::channel("test");
        let drain = NetworkLogDrainCoordinator::new(vec![producer]);
        let close =
            tokio::spawn(async move { old.close_for_upload(RunId::new_v4(), &drain).await });
        let request = tokio::time::timeout(Duration::from_secs(2), drain_rx.recv())
            .await
            .expect("close must request producer drain")
            .expect("producer request");

        let late = json!({"type":"dns","host":"late.test"});
        assert!(manager.append_for_ip("10.200.0.2", late.clone()).await);
        let new = manager
            .register_source_ip("10.200.0.2", new_path.clone())
            .await;
        let replacement = json!({"type":"dns","host":"replacement.test"});
        assert!(
            manager
                .append_for_ip("10.200.0.2", replacement.clone())
                .await
        );
        request.ack();
        let observation = tokio::time::timeout(Duration::from_secs(2), close)
            .await
            .expect("old close must finish")
            .unwrap();
        assert_eq!(observation.drain_status("test"), "acknowledged");
        assert!(!observation.writer_failed());

        let after_close = json!({"type":"dns","host":"after-old-close.test"});
        assert!(
            manager
                .append_for_ip("10.200.0.2", after_close.clone())
                .await
        );
        let observation = new
            .close_for_upload(RunId::new_v4(), &NetworkLogDrainCoordinator::noop())
            .await;
        assert!(!observation.writer_failed());
        if same_path {
            assert_eq!(
                read_json_lines(&old_path),
                vec![late, replacement, after_close]
            );
        } else {
            assert_eq!(read_json_lines(&old_path), vec![late]);
            assert_eq!(read_json_lines(&new_path), vec![replacement, after_close]);
        }
        assert!(
            !manager
                .append_for_ip("10.200.0.2", json!({"host":"after-final-close.test"}))
                .await
        );
    }
}

#[tokio::test]
async fn stale_session_close_skips_producer_drain_and_preserves_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let old_path = dir.path().join("old.jsonl");
    let new_path = dir.path().join("new.jsonl");
    let manager = NetworkLogManager::new();
    let old = manager
        .register_source_ip("10.200.0.2", old_path.clone())
        .await;

    let new = manager
        .register_source_ip("10.200.0.2", new_path.clone())
        .await;
    let (producer, mut drain_rx) = NetworkLogDrainProducer::channel("test");
    let drain = NetworkLogDrainCoordinator::new(vec![producer]);
    let observation = tokio::time::timeout(
        Duration::from_secs(2),
        old.close_for_upload(RunId::new_v4(), &drain),
    )
    .await
    .expect("stale close must finish without a producer acknowledgement");
    assert_eq!(observation.drain_status("test"), "not_configured");
    assert!(matches!(
        drain_rx.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));

    assert!(
        manager
            .append_for_ip("10.200.0.2", json!({"type":"dns","host":"new.test"}))
            .await
    );
    new.close_for_upload(RunId::new_v4(), &NetworkLogDrainCoordinator::noop())
        .await;

    assert!(!old_path.exists());
    let lines = read_json_lines(&new_path);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["host"], "new.test");
}

#[tokio::test]
async fn dropped_unclosed_session_finalizes_mapping() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let manager = NetworkLogManager::new();
    let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    assert!(source_ip_registered(&manager, "10.200.0.2").await);

    drop(session);
    wait_source_ip_unregistered(&manager, "10.200.0.2").await;

    assert!(
        !manager
            .append_for_ip("10.200.0.2", json!({"type":"dns","host":"after-drop.test"}))
            .await
    );
    manager.flush_path(&path).await;
    assert!(!path.exists());
}

#[tokio::test]
async fn close_for_upload_waits_for_barrier_and_flushes_late_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let manager = NetworkLogManager::new();
    let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    let (producer, mut drain_rx) = NetworkLogDrainProducer::channel("test");
    let drain = NetworkLogDrainCoordinator::new(vec![producer]);

    let manager_for_barrier = manager.clone();
    let barrier = tokio::spawn(async move {
        let request = drain_rx.recv().await.expect("drain request");
        assert!(
            manager_for_barrier
                .append_for_ip(
                    "10.200.0.2",
                    json!({"type":"dns","host":"during-drain.test"}),
                )
                .await
        );
        request.ack();
    });

    session
        .close_for_upload(RunId::from(uuid::Uuid::nil()), &drain)
        .await;
    barrier.await.unwrap();

    let lines = read_json_lines(&path);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["host"], "during-drain.test");
    assert!(
        !manager
            .append_for_ip(
                "10.200.0.2",
                json!({"type":"dns","host":"after-close.test"})
            )
            .await
    );
}

#[tokio::test]
async fn close_for_upload_closes_source_before_final_flush() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let before_flush = Arc::new(Notify::new());
    let close_release = Arc::new(Semaphore::new(0));
    let manager =
        NetworkLogManager::new_with_close_gate(before_flush.clone(), close_release.clone());
    let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    let drain = NetworkLogDrainCoordinator::noop();

    let close = tokio::spawn(async move {
        session
            .close_for_upload(RunId::from(uuid::Uuid::nil()), &drain)
            .await;
    });
    // Pause at the upload-flush boundary and verify the mapping is already
    // closed, so no row can be accepted after the final flush begins.
    before_flush.notified().await;

    let registered_before_flush = source_ip_registered(&manager, "10.200.0.2").await;
    let accepted_after_close = manager
        .append_for_ip(
            "10.200.0.2",
            json!({"type":"dns","host":"after-close-before-flush.test"}),
        )
        .await;

    close_release.add_permits(1);
    close.await.unwrap();

    assert!(
        !registered_before_flush,
        "source mapping must be closed before the upload flush begins"
    );
    assert!(
        !accepted_after_close,
        "append_for_ip must reject rows once close_for_upload reaches the final flush"
    );
    assert!(!path.exists());
}

#[tokio::test]
async fn close_for_upload_with_unavailable_producer_finalizes_session() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let manager = NetworkLogManager::new();
    let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    let (producer, drain_rx) = NetworkLogDrainProducer::channel("closed");
    drop(drain_rx);
    let drain = NetworkLogDrainCoordinator::new(vec![producer]);

    let observation = session
        .close_for_upload(RunId::from(uuid::Uuid::nil()), &drain)
        .await;

    assert!(!source_ip_registered(&manager, "10.200.0.2").await);
    assert_eq!(observation.drain_status("closed"), "producer_unavailable");
    assert!(
        !manager
            .append_for_ip(
                "10.200.0.2",
                json!({"type":"dns","host":"after-close.test"})
            )
            .await
    );
}

#[tokio::test]
async fn close_for_upload_with_dropped_ack_finalizes_session() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let manager = NetworkLogManager::new();
    let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    let (producer, mut drain_rx) = NetworkLogDrainProducer::channel("dropped-ack");
    let drain = NetworkLogDrainCoordinator::new(vec![producer]);
    let receiver = tokio::spawn(async move {
        let request = drain_rx.recv().await.expect("drain request");
        drop(request);
    });

    let observation = session
        .close_for_upload(RunId::from(uuid::Uuid::nil()), &drain)
        .await;
    receiver.await.unwrap();

    assert!(!source_ip_registered(&manager, "10.200.0.2").await);
    assert_eq!(observation.drain_status("dropped-ack"), "ack_dropped");
    assert!(
        !manager
            .append_for_ip(
                "10.200.0.2",
                json!({"type":"dns","host":"after-close.test"})
            )
            .await
    );
}

#[tokio::test]
async fn close_for_upload_timeout_still_flushes_accepted_writes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let manager = NetworkLogManager::new();
    let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    assert!(
        manager
            .append_for_ip("10.200.0.2", json!({"type":"dns","host":"accepted.test"}),)
            .await
    );
    let (producer, _drain_rx) = NetworkLogDrainProducer::channel("held");
    let drain = NetworkLogDrainCoordinator::new_with_timeout_for_test(
        vec![producer],
        Duration::from_millis(1),
    );

    let observation = session
        .close_for_upload(RunId::from(uuid::Uuid::nil()), &drain)
        .await;

    let lines = read_json_lines(&path);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["host"], "accepted.test");
    assert_eq!(observation.drain_status("held"), "ack_timeout");
    assert!(
        !manager
            .append_for_ip(
                "10.200.0.2",
                json!({"type":"dns","host":"after-timeout.test"})
            )
            .await
    );
}
