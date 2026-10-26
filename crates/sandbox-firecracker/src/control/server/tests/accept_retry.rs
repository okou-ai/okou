use super::*;

use std::io::Write;

use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

use crate::control::protocol::read_frame;

const FD_PRESSURE_CHILD: &str = "OKOU_CONTROL_ACCEPT_FD_PRESSURE_CHILD";

/// Process limits may only change in the exact, guarded child below.
struct ExhaustedDescriptors(libc::rlimit);

impl ExhaustedDescriptors {
    fn new() -> Self {
        let mut previous = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: initialized output storage in a single-test child process.
        assert_eq!(
            unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut previous) },
            0
        );
        let exhausted = libc::rlimit {
            rlim_cur: 0,
            rlim_max: previous.rlim_max,
        };
        // SAFETY: only the child's soft limit changes; existing FDs stay open.
        assert_eq!(
            unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &exhausted) },
            0
        );
        let guard = Self(previous);
        assert_eq!(
            std::fs::File::open("/dev/null").unwrap_err().raw_os_error(),
            Some(libc::EMFILE)
        );
        guard
    }
}

impl Drop for ExhaustedDescriptors {
    fn drop(&mut self) {
        // SAFETY: restore the unchanged hard limit and original soft limit.
        assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &self.0) }, 0);
    }
}

// Queue a complete real request without yielding to the accept task before
// its process runs out of descriptors.
fn queue_terminate(sock_path: &Path) -> UnixStream {
    let mut stream = std::os::unix::net::UnixStream::connect(sock_path).unwrap();
    let body = br#"{"action":"terminate"}"#;
    stream
        .write_all(&(body.len() as u32).to_be_bytes())
        .unwrap();
    stream.write_all(body).unwrap();
    stream.set_nonblocking(true).unwrap();
    UnixStream::from_std(stream).unwrap()
}

fn accept_warnings(captured: &CapturedEvents) -> Vec<CapturedEvent> {
    captured
        .entries()
        .into_iter()
        .filter(|event| {
            event.fields.get("message").map(String::as_str) == Some("control socket accept error")
        })
        .collect()
}

async fn wait_for_accept_warning(captured: &CapturedEvents) {
    tokio::time::timeout(Duration::from_secs(1), async {
        while accept_warnings(captured).is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the real listener must encounter EMFILE");
}

async fn settle_ready_tasks() {
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
}

// The clock is already paused. Resume before advance's yield lets an awakened
// task accept a real socket or perform cleanup after descriptors recover.
async fn advance_and_resume(duration: Duration) {
    let mut advance = std::pin::pin!(tokio::time::advance(duration));
    let advanced = futures_util::poll!(advance.as_mut());
    tokio::time::resume();
    if advanced.is_pending() {
        advance.await;
    }
}

async fn acknowledge_terminate(kill_rx: &mut mpsc::Receiver<ProcessTerminationRequest>) {
    tokio::time::timeout(Duration::from_millis(500), kill_rx.recv())
        .await
        .expect("termination must reach the owner after the retry deadline")
        .unwrap()
        .acknowledge();
}

async fn expect_accepted(stream: &mut UnixStream) {
    let bytes = tokio::time::timeout(Duration::from_secs(1), read_frame(stream))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<TerminateResponse>(&bytes).unwrap(),
        TerminateResponse::Status {
            status: TerminateStatus::Accepted,
        }
    );
}

async fn recovery_and_retry_reset(captured: &CapturedEvents) {
    let fixture = ControlServerFixture::new();
    let (kill_tx, mut kill_rx) = mpsc::channel(4);
    let mut handle = fixture
        .bind_with_termination(ProcessTerminationHandle::new(kill_tx))
        .unwrap()
        .spawn(CancellationToken::new());
    let mut stream = queue_terminate(&fixture.sock_path);
    let exhausted = ExhaustedDescriptors::new();
    wait_for_accept_warning(captured).await;
    assert_eq!(accept_warnings(captured).len(), 1);

    tokio::time::pause();
    // Repeated real EMFILE failures reach the cap, then cross the diagnostic
    // interval. No socket can be accepted during this timer-only phase.
    for delay_ms in [100, 200, 400, 800, 1000, 1000, 1000, 1000] {
        tokio::time::advance(Duration::from_millis(delay_ms + 1)).await;
        settle_ready_tasks().await;
    }
    let warnings = accept_warnings(captured);
    assert_eq!(
        warnings.len(),
        2,
        "persistent failures must throttle warnings"
    );
    assert_eq!(
        warnings
            .last()
            .unwrap()
            .fields
            .get("retry_ms")
            .map(String::as_str),
        Some("1000")
    );

    drop(exhausted);
    settle_ready_tasks().await;
    assert!(matches!(
        kill_rx.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
    tokio::time::advance(Duration::from_millis(900)).await;
    settle_ready_tasks().await;
    assert!(
        matches!(kill_rx.try_recv(), Err(mpsc::error::TryRecvError::Empty)),
        "restored descriptors must not bypass the pending retry delay"
    );
    advance_and_resume(Duration::from_millis(101)).await;
    acknowledge_terminate(&mut kill_rx).await;
    expect_accepted(&mut stream).await;

    // Let the warning interval elapse while healthy, then require a fresh
    // resource failure to use the initial delay rather than the previous cap.
    tokio::time::pause();
    advance_and_resume(Duration::from_secs(5)).await;
    captured.clear();
    let mut stream = queue_terminate(&fixture.sock_path);
    let exhausted = ExhaustedDescriptors::new();
    wait_for_accept_warning(captured).await;
    let warnings = accept_warnings(captured);
    assert_eq!(warnings.len(), 1);
    assert_eq!(
        warnings
            .first()
            .unwrap()
            .fields
            .get("retry_ms")
            .map(String::as_str),
        Some("100")
    );
    tokio::time::pause();
    drop(exhausted);
    advance_and_resume(Duration::from_millis(101)).await;
    acknowledge_terminate(&mut kill_rx).await;
    expect_accepted(&mut stream).await;
    handle.shutdown().await;
}

async fn cancellation_during_retry(captured: &CapturedEvents) {
    captured.clear();
    let fixture = ControlServerFixture::new();
    let shutdown = CancellationToken::new();
    let mut handle = fixture.spawn_default(shutdown.clone());
    let mut incomplete = UnixStream::connect(&fixture.sock_path).await.unwrap();
    incomplete.write_u32(1024).await.unwrap();
    // A later FIFO connection proves the incomplete handler was accepted.
    admission::expect_terminate_available(&fixture.sock_path).await;
    let _queued = queue_terminate(&fixture.sock_path);
    let exhausted = ExhaustedDescriptors::new();
    wait_for_accept_warning(captured).await;

    tokio::time::pause();
    shutdown.cancel();
    settle_ready_tasks().await;
    assert!(
        handle.task.as_ref().unwrap().is_finished(),
        "cancellation and handler cleanup must finish without advancing the retry clock"
    );
    drop(exhausted);
    tokio::time::resume();
    handle.shutdown().await;
    assert!(!fixture.sock_path.exists());
    admission::expect_closed(&mut incomplete, Duration::from_secs(1)).await;
}

#[tokio::test]
async fn descriptor_exhaustion_backs_off_recovers_and_cancels() {
    let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "control::server::tests::accept_retry::descriptor_exhaustion_child",
            "--ignored",
            "--nocapture",
        ])
        .env(FD_PRESSURE_CHILD, "1")
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(15), child.wait()).await;
    if result.is_err() {
        child.kill().await.unwrap();
    }
    assert!(
        result
            .expect("isolated accept regression must finish")
            .unwrap()
            .success()
    );
}

#[tokio::test]
#[ignore = "only the bounded parent may change process descriptor limits"]
async fn descriptor_exhaustion_child() {
    assert_eq!(std::env::var(FD_PRESSURE_CHILD).as_deref(), Ok("1"));
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let _guard = tracing::subscriber::set_default(subscriber);
    recovery_and_retry_reset(&captured).await;
    cancellation_during_retry(&captured).await;
}
