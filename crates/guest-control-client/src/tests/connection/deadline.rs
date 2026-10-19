use std::future::Future;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::Poll;
use std::time::Duration;

use guest_contracts::file_write::WRITE_FILE_REQUEST_DEADLINE;
use sandbox::StorageManifestRequestTiming;
use tokio::net::UnixStream;

use crate::operation_tracker::NormalOperationReadiness;
use crate::tests::support::{
    assert_connection_accepts_exec_operation, is_connected, normal_operation_readiness,
    pending_request_count, setup_host_and_guest,
};
use crate::{FrameWriteObserver, GuestControlClient, RequestTimeoutError, RequestTimeoutStage};

#[derive(Clone, Copy)]
enum QueuedGate {
    Builder,
    Writer,
}

async fn assert_expired_request_leaves_connection_reusable<T>(
    host: &Arc<GuestControlClient>,
    guest: &mut UnixStream,
    gate: QueuedGate,
    timeout: Duration,
    overdue: Duration,
    request: impl Future<Output = io::Result<T>>,
) {
    // Finish real I/O readiness before pausing only the queued request's timer.
    host.shared.writer.lock().await.writable().await.unwrap();
    let builder_guard = match gate {
        QueuedGate::Builder => Some(host.shared.frame_builder.lock().await),
        QueuedGate::Writer => None,
    };
    let writer_guard = match gate {
        QueuedGate::Builder => None,
        QueuedGate::Writer => Some(host.shared.writer.lock().await),
    };
    tokio::time::pause();
    let started = tokio::time::Instant::now();
    tokio::pin!(request);
    std::future::poll_fn(|cx| {
        assert!(request.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    assert_eq!(pending_request_count(host), 1);

    // Keep the request unpolled until both its deadline and its lock are ready.
    tokio::time::advance(timeout + overdue).await;
    assert_eq!(started.elapsed(), timeout + overdue);
    tokio::time::resume();
    drop(builder_guard);
    drop(writer_guard);
    let error = match request.await {
        Ok(_) => panic!("an expired queued request must not succeed"),
        Err(error) => error,
    };
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    let timeout_error = error
        .get_ref()
        .unwrap()
        .downcast_ref::<RequestTimeoutError>()
        .expect("deadline errors must retain their directly downcastable type");
    assert_eq!(timeout_error.stage(), RequestTimeoutStage::BeforeFrameWrite);
    assert_eq!(timeout_error.timeout(), timeout);
    assert_eq!(pending_request_count(host), 0);
    assert_eq!(
        normal_operation_readiness(host),
        NormalOperationReadiness::Idle
    );
    assert!(is_connected(host));
    assert!(host.shared.frame_builder.try_lock().is_ok());
    assert!(host.shared.writer.try_lock().is_ok());
    assert_eq!(
        guest.try_read(&mut [0; 1]).unwrap_err().kind(),
        io::ErrorKind::WouldBlock,
        "expired requests must emit no frame bytes"
    );
    assert_connection_accepts_exec_operation(host, guest).await;
}

async fn expired_storage_request(gate: QueuedGate) {
    let timeout = Duration::from_millis(50);
    for overdue in [Duration::ZERO, Duration::from_millis(1)] {
        let (host, mut guest) = setup_host_and_guest().await;
        let host = Arc::new(host);
        let mut timing = StorageManifestRequestTiming::default();
        assert_expired_request_leaves_connection_reusable(
            &host,
            &mut guest,
            gate,
            timeout,
            overdue,
            host.guest_storage_manifest_with_timing(
                b"{}",
                "run-1",
                "/run/vm0/runs/run-1",
                300_000,
                timeout,
                &mut timing,
            ),
        )
        .await;
        assert!(timing.setup.is_some());
        assert!(timing.frame_builder_wait.is_some());
        assert_eq!(
            timing.frame_encode.is_some(),
            matches!(gate, QueuedGate::Writer)
        );
        assert!(timing.writer_wait.is_none());
        assert!(timing.frame_write.is_none());
        assert!(timing.response_wait.is_none());
        assert!(timing.result_decode.is_none());
    }
}

#[tokio::test]
async fn expired_storage_request_does_not_write_after_queued_writer_release() {
    expired_storage_request(QueuedGate::Writer).await;
}

#[tokio::test]
async fn expired_storage_request_does_not_write_after_queued_builder_release() {
    expired_storage_request(QueuedGate::Builder).await;
}

async fn expired_file_request(gate: QueuedGate) {
    // Exercise owned requests and the first request of a public composite write.
    let chunked_content = vec![b'a'; 16 * 1024 * 1024];
    for (content, overdue) in [b"hello".as_slice(), chunked_content.as_slice()]
        .into_iter()
        .flat_map(|content| {
            [Duration::ZERO, Duration::from_millis(1)]
                .into_iter()
                .map(move |overdue| (content, overdue))
        })
    {
        let (host, mut guest) = setup_host_and_guest().await;
        let host = Arc::new(host);
        let write_starts = Arc::new(AtomicUsize::new(0));
        let observer = FrameWriteObserver::new({
            let write_starts = Arc::clone(&write_starts);
            move || {
                write_starts.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        });
        assert_expired_request_leaves_connection_reusable(
            &host,
            &mut guest,
            gate,
            WRITE_FILE_REQUEST_DEADLINE,
            overdue,
            host.write_file_with_write_observer("/tmp/expired.txt", content, false, observer),
        )
        .await;
        assert_eq!(write_starts.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn expired_file_request_does_not_notify_or_write_after_queued_writer_release() {
    expired_file_request(QueuedGate::Writer).await;
}

#[tokio::test]
async fn expired_file_request_does_not_notify_or_write_after_queued_builder_release() {
    expired_file_request(QueuedGate::Builder).await;
}

#[tokio::test]
async fn expired_lifecycle_request_does_not_write_after_queued_writer_release() {
    let timeout = Duration::from_millis(50);
    for overdue in [Duration::ZERO, Duration::from_millis(1)] {
        let (host, mut guest) = setup_host_and_guest().await;
        let host = Arc::new(host);
        assert_expired_request_leaves_connection_reusable(
            &host,
            &mut guest,
            QueuedGate::Writer,
            timeout,
            overdue,
            host.shutdown(timeout),
        )
        .await;
    }
}
