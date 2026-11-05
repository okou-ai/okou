use std::future::Future;
use std::sync::{Arc, mpsc};
use std::task::{Context, Waker};
use std::time::Duration;

use tokio::runtime::Builder;
use tokio_util::sync::CancellationToken;

use super::run_cancellable_blocking;
use crate::test_fixtures::blocking_worker::BlockingWorkerRelease;

const WAIT: Duration = Duration::from_secs(5);

#[test]
fn queued_worker_observes_cancellation_after_awaiter_drop() {
    let runtime = Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    let (release, wait) = mpsc::channel();
    let gate = BlockingWorkerRelease::new(release);
    let (started, ready) = mpsc::sync_channel(0);
    let blocker = runtime.spawn_blocking(move || {
        started.send(()).unwrap();
        wait.recv().unwrap();
    });
    ready.recv_timeout(WAIT).unwrap();

    let cancel = CancellationToken::new();
    let (observed, observation) = mpsc::channel();
    let mut operation = Box::pin(run_cancellable_blocking(
        cancel.clone(),
        move |worker_cancel| observed.send(worker_cancel.is_cancelled()).unwrap(),
        None,
    ));
    let entered = runtime.enter();
    assert!(
        operation
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    drop(entered);
    drop(operation);
    let awaiter_cancelled = cancel.is_cancelled();

    drop(gate);
    let worker_observed_cancellation = observation.recv_timeout(WAIT).unwrap();
    runtime.block_on(async {
        blocker.await.unwrap();
        tokio::time::timeout(WAIT, runtime.spawn_blocking(|| ()))
            .await
            .unwrap()
            .unwrap();
    });

    assert!(awaiter_cancelled);
    assert!(worker_observed_cancellation);
}

#[tokio::test]
async fn joined_worker_panic_preserves_payload_and_disarms_drop_cancellation() {
    use futures_util::FutureExt;

    let cancel = CancellationToken::new();
    let expected = Arc::new(17_usize);
    let payload = Arc::clone(&expected);
    let operation = run_cancellable_blocking::<_, ()>(
        cancel.clone(),
        move |_| std::panic::panic_any(payload),
        None,
    );

    let panic = std::panic::AssertUnwindSafe(operation)
        .catch_unwind()
        .await
        .expect_err("the worker panic must propagate to its awaiter");

    assert!(Arc::ptr_eq(
        panic.downcast_ref::<Arc<usize>>().unwrap(),
        &expected
    ));
    assert!(
        !cancel.is_cancelled(),
        "a completed join must disarm observer-drop cancellation before resuming its panic"
    );
}
