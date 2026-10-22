use std::future::Future;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::Poll;
use std::time::Duration;

use guest_control_proto::{ExecOutputPolicy, ExecProcessRole, ExecTimeoutPolicy};

use crate::exec_operation::test_support::start_supervised_exec_with_write_observer;
use crate::operation_tracker::NormalOperationReadiness;
use crate::tests::support::{
    assert_connection_accepts_exec_operation, exec_capture_with_write_observer, is_connected,
    normal_operation_readiness, operation_count, setup_host_and_guest,
};
use crate::{
    ExecCaptureRequest, ExecOperationRequest, ExecStreamRequest, FrameWriteObserver,
    GuestControlClient, RequestTimeoutError, RequestTimeoutStage, SupervisedExecControl,
    SupervisedExecRequest,
};

const START_TIMEOUT: Duration = Duration::from_millis(50);

#[derive(Clone, Copy, Debug)]
enum StartApi {
    Operation,
    Stream,
    Capture,
    CaptureAdmission,
    CaptureObserver,
    Supervised,
    SupervisedProcess,
    SupervisedObserver,
}

async fn start_request(
    host: &GuestControlClient,
    api: StartApi,
    observer: FrameWriteObserver,
) -> io::Result<()> {
    let capture = ExecCaptureRequest {
        timeout_ms: 5000,
        command: "expired start",
        env: &[],
        sudo: false,
        label: "expired-start",
        stdout_limit_bytes: 1024,
        stderr_limit_bytes: 1024,
        expected_exit_codes: &[],
        stdin_bytes: None,
        wait_timeout: START_TIMEOUT,
    };
    let supervised = SupervisedExecRequest {
        timeout_is_expected: false,
        role: ExecProcessRole::Workload,
        timeout: ExecTimeoutPolicy::None,
        command: "expired start",
        env: &[],
        sudo: false,
        label: "expired-start",
        stdout: ExecOutputPolicy::Stream {
            limit_bytes: 1024,
            chunk_limit_bytes: 16,
        },
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: SupervisedExecControl::Disabled,
        stdin_bytes: None,
        stream_queue_capacity: Some(1),
        start_timeout: START_TIMEOUT,
    };
    match api {
        StartApi::Operation => host
            .start_exec_operation(ExecOperationRequest {
                timeout_ms: 5000,
                command: "expired start",
                env: &[],
                sudo: false,
                label: "expired-start",
                stdout: ExecOutputPolicy::Discard,
                stderr: ExecOutputPolicy::Discard,
                expected_exit_codes: &[],
                stdin_bytes: None,
                stream_queue_capacity: None,
                start_write_timeout: START_TIMEOUT,
            })
            .await
            .map(|_| ()),
        StartApi::Stream => host
            .exec_operation_stream(ExecStreamRequest {
                timeout_ms: 5000,
                command: "expired start",
                env: &[],
                sudo: false,
                label: "expired-start",
                stdout: supervised.stdout,
                stderr: ExecOutputPolicy::Discard,
                expected_exit_codes: &[],
                stdin_bytes: None,
                stream_queue_capacity: Some(1),
                start_write_timeout: START_TIMEOUT,
            })
            .await
            .map(|_| ()),
        StartApi::Capture => host.exec_operation_capture(capture).await.map(|_| ()),
        StartApi::CaptureAdmission => host
            .exec_operation_capture_with_write_admission(capture, observer)
            .await
            .map(|_| ()),
        StartApi::CaptureObserver => exec_capture_with_write_observer(host, capture, observer)
            .await
            .map(|_| ()),
        StartApi::Supervised => host.start_supervised_exec(supervised).await.map(|_| ()),
        StartApi::SupervisedProcess => host.start_supervised_process(supervised).await.map(|_| ()),
        StartApi::SupervisedObserver => {
            start_supervised_exec_with_write_observer(&host.shared, supervised, observer)
                .await
                .map(|_| ())
        }
    }
}

async fn assert_expired_start(api: StartApi, overdue: Duration, release_before_repoll: bool) {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    // Complete real I/O readiness before freezing the request's clock.
    let writer_guard = host.shared.writer.lock().await;
    writer_guard.writable().await.unwrap();
    let mut writer_guard = Some(writer_guard);
    let observer_calls = Arc::new(AtomicUsize::new(0));
    let observer = FrameWriteObserver::new({
        let observer_calls = Arc::clone(&observer_calls);
        move || {
            observer_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    });

    tokio::time::pause();
    let started = tokio::time::Instant::now();
    let request = start_request(&host, api, observer);
    tokio::pin!(request);
    std::future::poll_fn(|cx| {
        assert!(request.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    assert_eq!(operation_count(&host), 1);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    // The request stays unpolled while its timer and then its lock become ready.
    tokio::time::advance(START_TIMEOUT + overdue).await;
    if release_before_repoll {
        drop(writer_guard.take());
    }
    // Poll once at the exact paused instant: resuming first would make equality
    // slightly overdue and fail to detect an incorrect strict `>` comparison.
    let outcome = std::future::poll_fn(|cx| Poll::Ready(request.as_mut().poll(cx))).await;
    assert_eq!(started.elapsed(), START_TIMEOUT + overdue);
    tokio::time::resume();
    let result = match outcome {
        Poll::Ready(result) => result,
        Poll::Pending => request.await,
    };
    drop(writer_guard.take());

    let error = result.expect_err("an expired queued start must not succeed");
    assert_eq!(error.kind(), io::ErrorKind::TimedOut, "{api:?}");
    if matches!(
        api,
        StartApi::Supervised | StartApi::SupervisedProcess | StartApi::SupervisedObserver
    ) {
        let timeout = error
            .get_ref()
            .unwrap()
            .downcast_ref::<RequestTimeoutError>()
            .expect("supervised timeout must retain its directly downcastable type");
        assert_eq!(timeout.stage(), RequestTimeoutStage::BeforeFrameWrite);
        assert_eq!(timeout.timeout(), START_TIMEOUT);
    } else {
        assert_eq!(error.to_string(), "exec start timeout");
    }
    assert_eq!(observer_calls.load(Ordering::SeqCst), 0);
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    assert!(is_connected(&host));
    assert_eq!(
        guest.try_read(&mut [0; 1]).unwrap_err().kind(),
        io::ErrorKind::WouldBlock,
        "expired starts must emit neither START nor CANCEL bytes"
    );
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

async fn expired_after_writer_release(api: StartApi) {
    for overdue in [Duration::ZERO, Duration::from_millis(1)] {
        assert_expired_start(api, overdue, true).await;
    }
}

#[tokio::test]
async fn expired_one_shot_start_does_not_write_after_queued_writer_release() {
    expired_after_writer_release(StartApi::Operation).await;
}

#[tokio::test]
async fn expired_stream_start_does_not_write_after_queued_writer_release() {
    expired_after_writer_release(StartApi::Stream).await;
}

#[tokio::test]
async fn expired_capture_start_does_not_write_after_queued_writer_release() {
    expired_after_writer_release(StartApi::Capture).await;
}

#[tokio::test]
async fn expired_capture_start_does_not_invoke_admission_after_queued_writer_release() {
    expired_after_writer_release(StartApi::CaptureAdmission).await;
}

#[tokio::test]
async fn expired_capture_start_does_not_notify_after_queued_writer_release() {
    expired_after_writer_release(StartApi::CaptureObserver).await;
}

#[tokio::test]
async fn expired_supervised_start_does_not_write_after_queued_writer_release() {
    expired_after_writer_release(StartApi::Supervised).await;
}

#[tokio::test]
async fn expired_supervised_process_start_does_not_write_after_queued_writer_release() {
    expired_after_writer_release(StartApi::SupervisedProcess).await;
}

#[tokio::test]
async fn expired_supervised_start_does_not_notify_after_queued_writer_release() {
    expired_after_writer_release(StartApi::SupervisedObserver).await;
}

#[tokio::test]
async fn expired_starts_with_writer_still_held_preserve_connection() {
    for api in [
        StartApi::Operation,
        StartApi::Stream,
        StartApi::Capture,
        StartApi::CaptureAdmission,
        StartApi::CaptureObserver,
        StartApi::Supervised,
        StartApi::SupervisedProcess,
        StartApi::SupervisedObserver,
    ] {
        assert_expired_start(api, Duration::from_millis(1), false).await;
    }
}
