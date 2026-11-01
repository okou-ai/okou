use super::*;
use std::{
    panic::AssertUnwindSafe,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use futures_util::FutureExt;

struct AbortFlag(Arc<AtomicBool>);

impl Drop for AbortFlag {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

struct SpawnLateCleanupOnDrop {
    group: Arc<FactoryCleanupGroup>,
    late_aborted: Arc<AtomicBool>,
}

struct BlockingPollCleanup {
    started_tx: Option<tokio::sync::oneshot::Sender<()>>,
    release: Arc<AtomicBool>,
}

impl Future for BlockingPollCleanup {
    type Output = ();

    fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        if let Some(started_tx) = this.started_tx.take() {
            let _ = started_tx.send(());
        }
        while !this.release.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        Poll::Ready(())
    }
}

impl Drop for SpawnLateCleanupOnDrop {
    fn drop(&mut self) {
        let late_flag = AbortFlag(Arc::clone(&self.late_aborted));
        let waiter = self.group.spawn(
            FactoryCleanupTaskKind::Destroy,
            "late-after-timeout",
            async move {
                let _flag = late_flag;
                std::future::pending::<()>().await;
            },
        );
        drop(waiter);
    }
}

#[tokio::test]
async fn factory_cleanup_group_returns_completion_to_waiter() {
    let group = FactoryCleanupGroup::new();
    let ran = Arc::new(AtomicBool::new(false));
    let ran_clone = Arc::clone(&ran);

    let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "sandbox", async move {
        ran_clone.store(true, Ordering::SeqCst);
    });

    waiter.wait_propagating_panic().await;
    group.shutdown().await;

    assert!(ran.load(Ordering::SeqCst));
}

#[tokio::test]
async fn factory_cleanup_group_keeps_task_after_waiter_abort() {
    let group = Arc::new(FactoryCleanupGroup::new());
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let completed = Arc::new(AtomicBool::new(false));
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();

    let completed_clone = Arc::clone(&completed);
    let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "sandbox", async move {
        let _ = started_tx.send(());
        let _ = release_rx.await;
        completed_clone.store(true, Ordering::SeqCst);
    });

    started_rx.await.unwrap();
    let waiter_task = tokio::spawn(waiter.wait_propagating_panic());
    waiter_task.abort();
    assert!(waiter_task.await.unwrap_err().is_cancelled());

    release_tx.send(()).unwrap();
    group.shutdown().await;

    assert!(completed.load(Ordering::SeqCst));
}

#[tokio::test]
async fn factory_cleanup_group_drains_task_after_waiter_drop_without_waiting() {
    let group = FactoryCleanupGroup::new();
    let completed = Arc::new(AtomicBool::new(false));
    let completed_clone = Arc::clone(&completed);

    let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "sandbox", async move {
        completed_clone.store(true, Ordering::SeqCst);
    });
    drop(waiter);

    group.shutdown().await;

    assert!(completed.load(Ordering::SeqCst));
}

#[tokio::test]
async fn factory_cleanup_group_shutdown_waits_for_running_task() {
    let group = Arc::new(FactoryCleanupGroup::new());
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let completed = Arc::new(AtomicBool::new(false));
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();

    let completed_clone = Arc::clone(&completed);
    let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "sandbox", async move {
        let _ = started_tx.send(());
        let _ = release_rx.await;
        completed_clone.store(true, Ordering::SeqCst);
    });
    drop(waiter);

    started_rx.await.unwrap();
    let shutdown_group = Arc::clone(&group);
    let shutdown_task = tokio::spawn(async move {
        shutdown_group.shutdown().await;
    });
    tokio::task::yield_now().await;
    assert!(!shutdown_task.is_finished());

    release_tx.send(()).unwrap();
    shutdown_task.await.unwrap();

    assert!(completed.load(Ordering::SeqCst));
}

#[tokio::test]
async fn factory_cleanup_group_shutdown_cancel_reinserts_running_and_late_tasks() {
    let group = Arc::new(FactoryCleanupGroup::new());
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let completed = Arc::new(AtomicBool::new(false));
    let late_completed = Arc::new(AtomicBool::new(false));
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();

    let completed_clone = Arc::clone(&completed);
    let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "sandbox", async move {
        let _ = started_tx.send(());
        let _ = release_rx.await;
        completed_clone.store(true, Ordering::SeqCst);
    });
    drop(waiter);

    started_rx.await.unwrap();
    let shutdown_group = Arc::clone(&group);
    let shutdown_task = tokio::spawn(async move {
        shutdown_group.shutdown().await;
    });
    tokio::task::yield_now().await;
    assert!(!shutdown_task.is_finished());

    shutdown_task.abort();
    assert!(shutdown_task.await.unwrap_err().is_cancelled());

    let late_completed_clone = Arc::clone(&late_completed);
    let late_waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "late", async move {
        late_completed_clone.store(true, Ordering::SeqCst);
    });
    drop(late_waiter);

    let retry_group = Arc::clone(&group);
    let retry_shutdown = tokio::spawn(async move {
        retry_group.shutdown().await;
    });
    tokio::task::yield_now().await;
    assert!(!retry_shutdown.is_finished());

    assert!(release_tx.send(()).is_ok());
    retry_shutdown.await.unwrap();

    assert!(completed.load(Ordering::SeqCst));
    assert!(late_completed.load(Ordering::SeqCst));
}

#[tokio::test]
async fn factory_cleanup_group_shutdown_drains_late_registered_task() {
    let group = Arc::new(FactoryCleanupGroup::new());
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let late_completed = Arc::new(AtomicBool::new(false));
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();

    let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "first", async move {
        let _ = started_tx.send(());
        let _ = release_rx.await;
    });
    drop(waiter);

    started_rx.await.unwrap();
    let shutdown_group = Arc::clone(&group);
    let shutdown_task = tokio::spawn(async move {
        shutdown_group.shutdown().await;
    });
    tokio::task::yield_now().await;
    assert!(!shutdown_task.is_finished());

    let late_completed_clone = Arc::clone(&late_completed);
    let late_waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "late", async move {
        late_completed_clone.store(true, Ordering::SeqCst);
    });
    drop(late_waiter);

    release_tx.send(()).unwrap();
    shutdown_task.await.unwrap();

    assert!(late_completed.load(Ordering::SeqCst));
}

#[tokio::test]
async fn factory_cleanup_group_closed_registration_runs_in_caller_task() {
    let group = FactoryCleanupGroup::new();
    group.shutdown().await;

    let ran = Arc::new(AtomicBool::new(false));
    let ran_clone = Arc::clone(&ran);
    let cleanup = group.spawn(FactoryCleanupTaskKind::Destroy, "closed", async move {
        ran_clone.store(true, Ordering::SeqCst);
    });

    assert!(!ran.load(Ordering::SeqCst));
    cleanup.wait_propagating_panic().await;

    assert!(ran.load(Ordering::SeqCst));
}

#[tokio::test]
async fn factory_cleanup_group_closed_logging_wait_suppresses_panic() {
    let group = FactoryCleanupGroup::new();
    group.shutdown().await;

    let cleanup = group.spawn(FactoryCleanupTaskKind::Rollback, "closed", async {
        panic!("rollback cleanup failed");
    });

    let result = AssertUnwindSafe(cleanup.wait_logging_panic())
        .catch_unwind()
        .await;

    assert!(result.is_ok());
}

#[tokio::test]
async fn factory_cleanup_group_drop_aborts_in_flight_task() {
    let group = FactoryCleanupGroup::new();
    let aborted = Arc::new(AtomicBool::new(false));
    let aborted_clone = Arc::clone(&aborted);
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();

    let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "drop-abort", async move {
        let _flag = AbortFlag(aborted_clone);
        let _ = started_tx.send(());
        std::future::pending::<()>().await;
    });
    drop(waiter);

    started_rx.await.unwrap();
    drop(group);

    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while !aborted.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn factory_cleanup_group_start_accepting_reopens_after_shutdown() {
    let group = Arc::new(FactoryCleanupGroup::new());
    group.shutdown().await;
    group.start_accepting();

    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let completed = Arc::new(AtomicBool::new(false));
    let completed_clone = Arc::clone(&completed);
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "restart", async move {
        let _ = started_tx.send(());
        let _ = release_rx.await;
        completed_clone.store(true, Ordering::SeqCst);
    });
    drop(waiter);

    started_rx.await.unwrap();
    let shutdown_group = Arc::clone(&group);
    let shutdown_task = tokio::spawn(async move {
        shutdown_group.shutdown().await;
    });
    tokio::task::yield_now().await;
    assert!(!shutdown_task.is_finished());

    release_tx.send(()).unwrap();
    shutdown_task.await.unwrap();

    assert!(completed.load(Ordering::SeqCst));
}

#[tokio::test(start_paused = true)]
async fn factory_cleanup_group_shutdown_aborts_stuck_task_after_timeout() {
    let group = FactoryCleanupGroup::new();
    let aborted = Arc::new(AtomicBool::new(false));
    let aborted_clone = Arc::clone(&aborted);
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();

    let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "sandbox", async move {
        let _flag = AbortFlag(aborted_clone);
        let _ = started_tx.send(());
        std::future::pending::<()>().await;
    });
    drop(waiter);

    started_rx.await.unwrap();
    let shutdown = group.shutdown();
    tokio::pin!(shutdown);
    tokio::task::yield_now().await;
    tokio::time::advance(FACTORY_CLEANUP_SHUTDOWN_TIMEOUT).await;
    shutdown.await;

    assert!(aborted.load(Ordering::SeqCst));
}

#[tokio::test(start_paused = true)]
async fn factory_cleanup_group_shutdown_aborts_task_registered_during_timeout_abort() {
    let group = Arc::new(FactoryCleanupGroup::new());
    let late_aborted = Arc::new(AtomicBool::new(false));
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();

    let on_drop = SpawnLateCleanupOnDrop {
        group: Arc::clone(&group),
        late_aborted: Arc::clone(&late_aborted),
    };
    let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "sandbox", async move {
        let _on_drop = on_drop;
        let _ = started_tx.send(());
        std::future::pending::<()>().await;
    });
    drop(waiter);

    started_rx.await.unwrap();
    let shutdown = group.shutdown();
    tokio::pin!(shutdown);
    tokio::task::yield_now().await;
    tokio::time::advance(FACTORY_CLEANUP_SHUTDOWN_TIMEOUT).await;
    shutdown.await;

    assert!(late_aborted.load(Ordering::SeqCst));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn factory_cleanup_group_shutdown_detaches_unfinished_aborted_task_after_timeout() {
    let group = Arc::new(FactoryCleanupGroup::new());
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let release = Arc::new(AtomicBool::new(false));
    let cleanup_release = Arc::clone(&release);

    let waiter = group.spawn(
        FactoryCleanupTaskKind::Destroy,
        "blocking-poll",
        BlockingPollCleanup {
            started_tx: Some(started_tx),
            release: cleanup_release,
        },
    );
    drop(waiter);

    tokio::time::timeout(std::time::Duration::from_secs(1), started_rx)
        .await
        .unwrap()
        .unwrap();
    let shutdown_group = Arc::clone(&group);
    let mut shutdown_task = tokio::spawn(async move {
        shutdown_group.shutdown().await;
    });

    let shutdown_result =
        tokio::time::timeout(std::time::Duration::from_secs(1), &mut shutdown_task).await;
    release.store(true, Ordering::SeqCst);

    match shutdown_result {
        Ok(result) => result.unwrap(),
        Err(_) => {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(1), shutdown_task).await;
            panic!("shutdown timed out waiting for an aborted cleanup task");
        }
    }
}

#[tokio::test]
async fn factory_cleanup_destroy_waiter_propagates_panic() {
    let group = FactoryCleanupGroup::new();
    let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "sandbox", async {
        panic!("destroy cleanup failed");
    });

    let result = AssertUnwindSafe(waiter.wait_propagating_panic())
        .catch_unwind()
        .await;
    group.shutdown().await;

    assert!(result.is_err());
}
