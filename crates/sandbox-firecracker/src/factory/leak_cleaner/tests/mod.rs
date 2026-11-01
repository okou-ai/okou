use super::*;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

use crate::cow_cleanup::cow_destroy_retry_policy;
use crate::network::NetnsPool;
use crate::process::ProcessExitCompletion;
use tracing_subscriber::prelude::*;

fn test_leaked_resource(sandbox_id: &str) -> LeakedResources {
    LeakedResources {
        sandbox_id: sandbox_id.into(),
        create_custody: None,
        process_exit: None,
        cow_device: None,
        network: None,
        sock_dir: PathBuf::from("/nonexistent"),
        workspace: PathBuf::from("/nonexistent"),
        delete_workspace: true,
    }
}

async fn leaked_resource_with_paths(
    delete_workspace: bool,
) -> (tempfile::TempDir, LeakedResources) {
    let tmp = tempfile::tempdir().unwrap();
    let sock_dir = tmp.path().join("sock");
    let workspace = tmp.path().join("workspace");
    tokio::fs::create_dir_all(&sock_dir).await.unwrap();
    tokio::fs::create_dir_all(&workspace).await.unwrap();

    (
        tmp,
        LeakedResources {
            sandbox_id: "sandbox".into(),
            create_custody: None,
            process_exit: None,
            cow_device: None,
            network: None,
            sock_dir,
            workspace,
            delete_workspace,
        },
    )
}

fn attach_reusable_network(leaked: &mut LeakedResources) -> NetnsPoolHandle {
    let mut pool = NetnsPool::active_at_capacity_for_test();
    let network = pool.lease_for_test("test-leaked-netns");
    pool.track_lease_for_test(&network);
    leaked.network = Some(network);
    NetnsPoolHandle::new_for_test(pool)
}

async fn assert_network_unavailable(pool: &NetnsPoolHandle) {
    assert!(pool.acquire().await.is_err());
}

async fn assert_network_recycled(pool: &NetnsPoolHandle) {
    let network = pool.acquire().await.unwrap();
    assert_eq!(network.name(), "test-leaked-netns");
    let mut network = Some(network);
    assert!(pool.release(&mut network).await.invalid_message().is_none());
    pool.cleanup().await.unwrap();
}

#[tokio::test]
async fn leaked_cleanup_waits_for_process_exit_before_recycling_network() {
    let (tmp, mut leaked) = leaked_resource_with_paths(true).await;
    let pool = attach_reusable_network(&mut leaked);
    let (exit_tx, exit) = ProcessExitCompletion::channel();
    leaked.process_exit = Some(exit);
    let cleanup = cleanup_leaked_resource(leaked, &pool);
    tokio::pin!(cleanup);

    assert!(futures_util::poll!(&mut cleanup).is_pending());
    assert_network_unavailable(&pool).await;
    assert!(tmp.path().join("sock").exists());
    assert!(tmp.path().join("workspace").exists());

    exit_tx.send(true).unwrap();
    cleanup.await;

    assert_network_recycled(&pool).await;
    assert!(!tmp.path().join("sock").exists());
    assert!(!tmp.path().join("workspace").exists());
}

#[tokio::test]
async fn leaked_cleanup_preserves_resources_when_process_exit_is_unconfirmed() {
    for completion in [Some(false), None] {
        let (tmp, mut leaked) = leaked_resource_with_paths(true).await;
        let pool = attach_reusable_network(&mut leaked);
        let (exit_tx, exit) = ProcessExitCompletion::channel();
        leaked.process_exit = Some(exit);
        if let Some(confirmed) = completion {
            exit_tx.send(confirmed).unwrap();
        } else {
            drop(exit_tx);
        }

        cleanup_leaked_resource(leaked, &pool).await;

        assert_network_unavailable(&pool).await;
        assert!(tmp.path().join("sock").exists());
        assert!(tmp.path().join("workspace").exists());
        pool.cleanup().await.unwrap();
    }
}

#[tokio::test]
async fn cancelled_leaked_cleanup_does_not_recycle_network_before_exit() {
    let (tmp, mut leaked) = leaked_resource_with_paths(true).await;
    let pool = attach_reusable_network(&mut leaked);
    let (exit_tx, exit) = ProcessExitCompletion::channel();
    leaked.process_exit = Some(exit);
    let mut cleanup = Box::pin(cleanup_leaked_resource(leaked, &pool));

    assert!(futures_util::poll!(&mut cleanup).is_pending());
    drop(cleanup);
    let _ = exit_tx.send(true);

    assert_network_unavailable(&pool).await;
    assert!(tmp.path().join("sock").exists());
    assert!(tmp.path().join("workspace").exists());
    pool.cleanup().await.unwrap();
}

#[tokio::test]
async fn leaked_cleanup_recycles_network_without_a_launched_process() {
    let (tmp, mut leaked) = leaked_resource_with_paths(true).await;
    let pool = attach_reusable_network(&mut leaked);

    cleanup_leaked_resource(leaked, &pool).await;

    assert_network_recycled(&pool).await;
    assert!(!tmp.path().join("sock").exists());
    assert!(!tmp.path().join("workspace").exists());
}

#[tokio::test]
async fn safe_cow_cleanup_deletes_workspace() {
    let (tmp, leaked) = leaked_resource_with_paths(true).await;
    let netns_pool = NetnsPoolHandle::new_for_test(NetnsPool::inactive_for_test());

    cleanup_leaked_resource(leaked, &netns_pool).await;

    assert!(!tmp.path().join("sock").exists());
    assert!(!tmp.path().join("workspace").exists());
}

#[tokio::test]
async fn unsafe_cow_cleanup_preserves_workspace() {
    let (tmp, leaked) = leaked_resource_with_paths(true).await;
    let netns_pool = NetnsPoolHandle::new_for_test(NetnsPool::inactive_for_test());

    cleanup_leaked_resource_after_cow_cleanup(
        leaked,
        &netns_pool,
        CowCleanupOutcome::DeviceMayStillReferenceBackingFiles,
    )
    .await;

    assert!(!tmp.path().join("sock").exists());
    assert!(tmp.path().join("workspace").exists());
}

#[tokio::test]
async fn disabled_workspace_deletion_preserves_workspace_after_safe_cow_cleanup() {
    let (tmp, leaked) = leaked_resource_with_paths(false).await;
    let netns_pool = NetnsPoolHandle::new_for_test(NetnsPool::inactive_for_test());

    cleanup_leaked_resource_after_cow_cleanup(
        leaked,
        &netns_pool,
        CowCleanupOutcome::BackingFilesSafeToDelete,
    )
    .await;

    assert!(!tmp.path().join("sock").exists());
    assert!(tmp.path().join("workspace").exists());
}

#[tokio::test]
async fn drain_leaked_resources_shutdown_closes_receiver_and_drains_buffer() {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
    let live_sender_clone = tx.clone();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();

    for index in 0..64 {
        tx.send(test_leaked_resource(&format!("leaked-{index}")))
            .unwrap();
    }

    let cleaned = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let cleaned_clone = Arc::clone(&cleaned);
    let (completed_cleanup_count_tx, _completed_cleanup_count_rx) = tokio::sync::watch::channel(0);
    let handle = tokio::spawn(drain_leaked_resources_with_cleanup(
        rx,
        shutdown_rx,
        completed_cleanup_count_tx,
        move |leaked| {
            let cleaned = Arc::clone(&cleaned_clone);
            async move {
                cleaned.lock().await.push(leaked.sandbox_id);
            }
        },
    ));

    shutdown_tx.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(1), handle)
        .await
        .unwrap()
        .unwrap();

    let mut expected: Vec<String> = (0..64).map(|index| format!("leaked-{index}")).collect();
    expected.sort();
    let mut actual = cleaned.lock().await.clone();
    actual.sort();
    assert_eq!(actual, expected);
    assert!(matches!(
        live_sender_clone.send(test_leaked_resource("late")),
        Err(tokio::sync::mpsc::error::SendError(_))
    ));
}

#[tokio::test]
async fn drain_leaked_resources_starts_later_cleanup_while_first_is_blocked() {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
    let (_shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let release_first = Arc::new(tokio::sync::Semaphore::new(0));
    let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
    let (completed_tx, mut completed_rx) = tokio::sync::mpsc::unbounded_channel();

    tx.send(test_leaked_resource("first")).unwrap();
    tx.send(test_leaked_resource("second")).unwrap();
    drop(tx);

    let cleanup_release_first = Arc::clone(&release_first);
    let (completed_cleanup_count_tx, _completed_cleanup_count_rx) = tokio::sync::watch::channel(0);
    let handle = tokio::spawn(drain_leaked_resources_with_cleanup(
        rx,
        shutdown_rx,
        completed_cleanup_count_tx,
        move |leaked| {
            let release_first = Arc::clone(&cleanup_release_first);
            let started_tx = started_tx.clone();
            let completed_tx = completed_tx.clone();
            async move {
                let sandbox_id = leaked.sandbox_id;
                started_tx.send(sandbox_id.clone()).unwrap();
                if sandbox_id == "first" {
                    release_first.acquire().await.unwrap().forget();
                }
                completed_tx.send(sandbox_id).unwrap();
            }
        },
    ));

    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(1), started_rx.recv())
            .await
            .unwrap()
            .unwrap(),
        "first"
    );
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(1), started_rx.recv())
            .await
            .unwrap()
            .unwrap(),
        "second"
    );
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(1), completed_rx.recv())
            .await
            .unwrap()
            .unwrap(),
        "second"
    );
    assert!(!handle.is_finished());

    release_first.add_permits(1);
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(1), completed_rx.recv())
            .await
            .unwrap()
            .unwrap(),
        "first"
    );
    handle.await.unwrap();
}

#[tokio::test]
async fn drain_leaked_resources_bounds_active_cleanup_and_refills_capacity() {
    let report_count = LEAK_CLEANUP_CONCURRENCY + 2;
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
    let (_shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();

    for index in 0..report_count {
        tx.send(test_leaked_resource(&format!("leaked-{index}")))
            .unwrap();
    }
    drop(tx);

    let cleanup_release = Arc::clone(&release);
    let cleanup_active = Arc::clone(&active);
    let cleanup_peak = Arc::clone(&peak);
    let (completed_cleanup_count_tx, _completed_cleanup_count_rx) = tokio::sync::watch::channel(0);
    let handle = tokio::spawn(drain_leaked_resources_with_cleanup(
        rx,
        shutdown_rx,
        completed_cleanup_count_tx,
        move |leaked| {
            let release = Arc::clone(&cleanup_release);
            let active = Arc::clone(&cleanup_active);
            let peak = Arc::clone(&cleanup_peak);
            let started_tx = started_tx.clone();
            async move {
                let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(current, Ordering::SeqCst);
                started_tx.send(leaked.sandbox_id).unwrap();
                release.acquire().await.unwrap().forget();
                active.fetch_sub(1, Ordering::SeqCst);
            }
        },
    ));

    for _ in 0..LEAK_CLEANUP_CONCURRENCY {
        tokio::time::timeout(std::time::Duration::from_secs(1), started_rx.recv())
            .await
            .unwrap()
            .unwrap();
    }
    assert_eq!(active.load(Ordering::SeqCst), LEAK_CLEANUP_CONCURRENCY);
    assert_eq!(peak.load(Ordering::SeqCst), LEAK_CLEANUP_CONCURRENCY);
    assert!(matches!(
        started_rx.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));

    release.add_permits(1);
    tokio::time::timeout(std::time::Duration::from_secs(1), started_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(active.load(Ordering::SeqCst), LEAK_CLEANUP_CONCURRENCY);
    assert_eq!(peak.load(Ordering::SeqCst), LEAK_CLEANUP_CONCURRENCY);

    release.add_permits(report_count);
    handle.await.unwrap();
    assert_eq!(active.load(Ordering::SeqCst), 0);
    assert_eq!(peak.load(Ordering::SeqCst), LEAK_CLEANUP_CONCURRENCY);
}

#[tokio::test]
async fn drain_leaked_resources_shutdown_closes_intake_and_waits_for_active_cleanup() {
    let report_count = LEAK_CLEANUP_CONCURRENCY + 2;
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
    let live_sender_clone = tx.clone();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let completed = Arc::new(AtomicUsize::new(0));
    let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();

    for index in 0..report_count {
        tx.send(test_leaked_resource(&format!("leaked-{index}")))
            .unwrap();
    }
    drop(tx);

    let cleanup_release = Arc::clone(&release);
    let cleanup_completed = Arc::clone(&completed);
    let (completed_cleanup_count_tx, _completed_cleanup_count_rx) = tokio::sync::watch::channel(0);
    let handle = tokio::spawn(drain_leaked_resources_with_cleanup(
        rx,
        shutdown_rx,
        completed_cleanup_count_tx,
        move |leaked| {
            let release = Arc::clone(&cleanup_release);
            let completed = Arc::clone(&cleanup_completed);
            let started_tx = started_tx.clone();
            async move {
                started_tx.send(leaked.sandbox_id).unwrap();
                release.acquire().await.unwrap().forget();
                completed.fetch_add(1, Ordering::SeqCst);
            }
        },
    ));

    for _ in 0..LEAK_CLEANUP_CONCURRENCY {
        tokio::time::timeout(std::time::Duration::from_secs(1), started_rx.recv())
            .await
            .unwrap()
            .unwrap();
    }
    shutdown_tx.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while !live_sender_clone.is_closed() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    assert!(!handle.is_finished());
    assert!(matches!(
        live_sender_clone.send(test_leaked_resource("late")),
        Err(tokio::sync::mpsc::error::SendError(_))
    ));

    release.add_permits(report_count);
    handle.await.unwrap();
    assert_eq!(completed.load(Ordering::SeqCst), report_count);
}

#[tokio::test]
async fn drain_leaked_resources_reports_backlog_and_active_cleanup_fields() {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
    let (_shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    tx.send(test_leaked_resource("first")).unwrap();
    tx.send(test_leaked_resource("second")).unwrap();
    drop(tx);

    let captured = tracing_test_support::CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    let (completed_cleanup_count_tx, _completed_cleanup_count_rx) = tokio::sync::watch::channel(0);
    drain_leaked_resources_with_cleanup(rx, shutdown_rx, completed_cleanup_count_tx, |_| async {})
        .await;
    drop(guard);

    let events = captured.entries();
    let event = events
        .iter()
        .find(|event| {
            event.fields.get("message").map(String::as_str)
                == Some("cleaning up leaked sandbox resources")
                && event.fields.get("queued_reports").map(String::as_str) == Some("1")
        })
        .unwrap_or_else(|| panic!("missing cleanup backlog event; events={events:#?}"));
    assert_eq!(
        event.fields.get("active_cleanups").map(String::as_str),
        Some("1")
    );
    assert_eq!(
        event.fields.get("concurrency_limit").map(String::as_str),
        Some("4")
    );
    assert_eq!(
        event.field_kinds.get("queued_reports").copied(),
        Some("u64")
    );
    assert_eq!(
        event.field_kinds.get("active_cleanups").copied(),
        Some("u64")
    );
    assert_eq!(
        event.field_kinds.get("concurrency_limit").copied(),
        Some("u64")
    );
}

#[tokio::test]
async fn drain_leaked_resources_exits_after_sender_close() {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
    let (_shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();

    tx.send(test_leaked_resource("first")).unwrap();
    tx.send(test_leaked_resource("second")).unwrap();
    drop(tx);

    let cleaned = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let cleaned_clone = Arc::clone(&cleaned);
    let (completed_cleanup_count_tx, _completed_cleanup_count_rx) = tokio::sync::watch::channel(0);
    drain_leaked_resources_with_cleanup(
        rx,
        shutdown_rx,
        completed_cleanup_count_tx,
        move |leaked| {
            let cleaned = Arc::clone(&cleaned_clone);
            async move {
                cleaned.lock().await.push(leaked.sandbox_id);
            }
        },
    )
    .await;

    assert_eq!(
        *cleaned.lock().await,
        vec!["first".to_string(), "second".to_string()]
    );
}

#[tokio::test]
async fn leak_cleaner_shutdown_signals_drain_with_live_sender_clone() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
    let _live_sender_clone = tx.clone();
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel();
    let (_completed_cleanup_count_tx, completed_cleanup_count_rx) = tokio::sync::watch::channel(0);
    let drained = Arc::new(AtomicBool::new(false));
    let drained_clone = Arc::clone(&drained);
    let handle = tokio::spawn(async move {
        tokio::select! {
            _ = &mut shutdown_rx => {
                rx.close();
                while rx.recv().await.is_some() {}
                drained_clone.store(true, Ordering::SeqCst);
            }
            _ = rx.recv() => {
                panic!("leak cleaner did not signal shutdown before receiver completion");
            }
        }
    });

    let cleaner = LeakCleaner {
        tx: Some(tx),
        shutdown_tx: Some(shutdown_tx),
        completed_cleanup_count_rx,
        handle: Some(handle),
    };
    cleaner.shutdown().await;

    assert!(drained.load(Ordering::SeqCst));
}

#[tokio::test(start_paused = true)]
async fn leak_cleaner_shutdown_drains_progressing_backlog_past_inactivity_timeout() {
    const CLEANUP_DURATION: std::time::Duration = std::time::Duration::from_secs(2);
    const CLEANUP_WAVES: usize = 16;

    let report_count = LEAK_CLEANUP_CONCURRENCY * CLEANUP_WAVES;
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let (completed_cleanup_count_tx, completed_cleanup_count_rx) = tokio::sync::watch::channel(0);
    let post_cow_cleanup_count = Arc::new(AtomicUsize::new(0));

    for index in 0..report_count {
        tx.send(test_leaked_resource(&format!("leaked-{index}")))
            .unwrap();
    }

    let cleanup_count = Arc::clone(&post_cow_cleanup_count);
    let handle = tokio::spawn(drain_leaked_resources_with_cleanup(
        rx,
        shutdown_rx,
        completed_cleanup_count_tx,
        move |_| {
            let cleanup_count = Arc::clone(&cleanup_count);
            async move {
                tokio::time::sleep(CLEANUP_DURATION).await;
                cleanup_count.fetch_add(1, Ordering::SeqCst);
            }
        },
    ));
    let cleaner = LeakCleaner {
        tx: Some(tx),
        shutdown_tx: Some(shutdown_tx),
        completed_cleanup_count_rx,
        handle: Some(handle),
    };

    let shutdown_started_at = tokio::time::Instant::now();
    cleaner.shutdown().await;

    assert!(
        tokio::time::Instant::now().duration_since(shutdown_started_at)
            > LEAK_CLEANUP_INACTIVITY_TIMEOUT,
        "regression backlog must exceed the old whole-drain timeout"
    );
    assert_eq!(post_cow_cleanup_count.load(Ordering::SeqCst), report_count);
}

#[tokio::test(start_paused = true)]
async fn leak_cleaner_shutdown_aborts_after_inactivity_timeout() {
    struct AbortFlag(Arc<AtomicBool>);

    impl Drop for AbortFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
    let (shutdown_tx, _shutdown_rx) = tokio::sync::oneshot::channel();
    let (_completed_cleanup_count_tx, completed_cleanup_count_rx) = tokio::sync::watch::channel(0);
    let aborted = Arc::new(AtomicBool::new(false));
    let aborted_clone = Arc::clone(&aborted);
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        let _flag = AbortFlag(aborted_clone);
        let _ = started_tx.send(());
        std::future::pending::<()>().await;
    });
    let cleaner = LeakCleaner {
        tx: Some(tx),
        shutdown_tx: Some(shutdown_tx),
        completed_cleanup_count_rx,
        handle: Some(handle),
    };

    started_rx.await.unwrap();
    let shutdown = cleaner.shutdown();
    tokio::pin!(shutdown);
    tokio::task::yield_now().await;
    tokio::time::advance(LEAK_CLEANUP_INACTIVITY_TIMEOUT).await;
    shutdown.await;

    assert!(aborted.load(Ordering::SeqCst));
}

#[tokio::test]
async fn leak_cleaner_drop_detaches_drain_and_keeps_live_senders_usable() {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
    let live_sender_clone = tx.clone();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let cleaned = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let cleaned_clone = Arc::clone(&cleaned);
    let (completed_cleanup_count_tx, completed_cleanup_count_rx) = tokio::sync::watch::channel(0);
    let handle = tokio::spawn(async move {
        drain_leaked_resources_with_cleanup(
            rx,
            shutdown_rx,
            completed_cleanup_count_tx,
            move |leaked| {
                let cleaned = Arc::clone(&cleaned_clone);
                async move {
                    cleaned.lock().await.push(leaked.sandbox_id);
                }
            },
        )
        .await;
        done_tx.send(()).unwrap();
    });
    let cleaner = LeakCleaner {
        tx: Some(tx),
        shutdown_tx: Some(shutdown_tx),
        completed_cleanup_count_rx,
        handle: Some(handle),
    };

    live_sender_clone
        .send(test_leaked_resource("queued"))
        .unwrap();
    drop(cleaner);
    live_sender_clone
        .send(test_leaked_resource("late"))
        .unwrap();
    drop(live_sender_clone);

    tokio::time::timeout(std::time::Duration::from_secs(1), done_rx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        *cleaned.lock().await,
        vec!["queued".to_string(), "late".to_string()]
    );
}

#[tokio::test]
async fn leak_cleaner_drop_without_sender_clones_lets_drain_exit() {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let cleaned = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let cleaned_clone = Arc::clone(&cleaned);
    let (completed_cleanup_count_tx, completed_cleanup_count_rx) = tokio::sync::watch::channel(0);
    let handle = tokio::spawn(async move {
        drain_leaked_resources_with_cleanup(
            rx,
            shutdown_rx,
            completed_cleanup_count_tx,
            move |leaked| {
                let cleaned = Arc::clone(&cleaned_clone);
                async move {
                    cleaned.lock().await.push(leaked.sandbox_id);
                }
            },
        )
        .await;
        done_tx.send(()).unwrap();
    });
    let cleaner = LeakCleaner {
        tx: Some(tx),
        shutdown_tx: Some(shutdown_tx),
        completed_cleanup_count_rx,
        handle: Some(handle),
    };

    drop(cleaner);

    tokio::time::timeout(std::time::Duration::from_secs(1), done_rx)
        .await
        .unwrap()
        .unwrap();
    assert!(cleaned.lock().await.is_empty());
}

#[test]
fn leak_cleaner_inactivity_timeout_covers_cow_destroy_retry_budget() {
    let retry_policy = cow_destroy_retry_policy();
    let retry_budget = retry_policy
        .delay
        .checked_mul(retry_policy.attempts)
        .expect("destroy retry budget should fit in Duration");

    assert!(
        LEAK_CLEANUP_INACTIVITY_TIMEOUT > retry_budget,
        "leak cleaner inactivity timeout must allow one COW finalizer to finish"
    );
}
