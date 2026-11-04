use std::panic::AssertUnwindSafe;
use std::sync::mpsc;

use super::*;
use crate::support::temp_paths::unique_socket_path;

const SHORT_TIMEOUT: Duration = Duration::from_millis(20);
const WATCHDOG_TIMEOUT: Duration = Duration::from_secs(5);

#[test]
fn guest_ready_timeout_is_bounded() {
    let (handler_started_tx, handler_started_rx) = mpsc::channel();
    let (release_handler_tx, release_handler_rx) = mpsc::channel();
    let (handler_finished_tx, handler_finished_rx) = mpsc::channel();
    let (observer_finished_tx, observer_finished_rx) = mpsc::channel();

    let observer = thread::spawn(move || {
        let result = panic::catch_unwind(AssertUnwindSafe(|| {
            let _ = start_guest_connection_with_handler_and_timeout(
                move |_stream| {
                    handler_started_tx.send(()).expect("report handler start");
                    release_handler_rx.recv().expect("wait for handler release");
                    handler_finished_tx
                        .send(())
                        .expect("report handler completion");
                    Ok(())
                },
                SHORT_TIMEOUT,
            );
        }));
        observer_finished_tx
            .send(result)
            .expect("report readiness observer completion");
    });

    handler_started_rx
        .recv_timeout(WATCHDOG_TIMEOUT)
        .expect("handler should reach blocked state");
    let observed = observer_finished_rx.recv_timeout(WATCHDOG_TIMEOUT);
    release_handler_tx
        .send(())
        .expect("release stalled readiness handler");
    handler_finished_rx
        .recv_timeout(WATCHDOG_TIMEOUT)
        .expect("readiness handler should finish after release");
    if matches!(&observed, Err(mpsc::RecvTimeoutError::Timeout)) {
        let _ = observer_finished_rx
            .recv_timeout(WATCHDOG_TIMEOUT)
            .expect("readiness observer should finish after handler release");
    }
    observer
        .join()
        .expect("readiness observer thread should not panic");

    let result = observed.expect("readiness observer exceeded outer watchdog");
    let payload = result.expect_err("stalled readiness should fail");
    assert!(
        panic_payload_message(payload.as_ref()).contains("guest connection readiness"),
        "readiness timeout should identify its lifecycle phase"
    );
}

#[test]
fn guest_listener_accept_timeout_is_bounded() {
    let socket_path = unique_socket_path("bounded-listener-accept");
    let listener = UnixListener::bind(socket_path.as_str()).unwrap();
    let release_path = socket_path.as_str().to_owned();
    let (observer_finished_tx, observer_finished_rx) = mpsc::channel();

    let observer = thread::spawn(move || {
        let result = accept_guest_connection_with_timeout(&listener, SHORT_TIMEOUT).map(drop);
        observer_finished_tx
            .send(result)
            .expect("report listener observer completion");
    });

    let observed = observer_finished_rx.recv_timeout(WATCHDOG_TIMEOUT);
    if matches!(&observed, Err(mpsc::RecvTimeoutError::Timeout)) {
        let _ = UnixStream::connect(release_path);
        let _ = observer_finished_rx
            .recv_timeout(WATCHDOG_TIMEOUT)
            .expect("listener observer should finish after fallback connection");
    }
    observer
        .join()
        .expect("listener observer thread should not panic");

    let error = observed
        .expect("listener observer exceeded outer watchdog")
        .expect_err("listener accept without a connector should time out");
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert!(
        error.to_string().contains("listener accept"),
        "listener timeout should identify its lifecycle phase: {error}"
    );
}

#[test]
fn guest_teardown_timeout_is_bounded() {
    let (guest_started_tx, guest_started_rx) = mpsc::channel();
    let (release_guest_tx, release_guest_rx) = mpsc::channel();
    let (guest_finished_tx, guest_finished_rx) = mpsc::channel();
    let guest = thread::spawn(move || {
        guest_started_tx.send(()).expect("report guest start");
        release_guest_rx.recv().expect("wait for guest release");
        guest_finished_tx.send(()).expect("report guest completion");
        Ok(())
    });
    guest_started_rx
        .recv_timeout(WATCHDOG_TIMEOUT)
        .expect("guest should reach blocked state");

    let (observer_finished_tx, observer_finished_rx) = mpsc::channel();
    let observer = thread::spawn(move || {
        let result = panic::catch_unwind(AssertUnwindSafe(|| {
            wait_for_guest_connection_with_timeout(guest, SHORT_TIMEOUT)
        }));
        observer_finished_tx
            .send(result)
            .expect("report teardown observer completion");
    });

    let observed = observer_finished_rx.recv_timeout(WATCHDOG_TIMEOUT);
    release_guest_tx.send(()).expect("release stalled guest");
    guest_finished_rx
        .recv_timeout(WATCHDOG_TIMEOUT)
        .expect("guest should finish after release");
    if matches!(&observed, Err(mpsc::RecvTimeoutError::Timeout)) {
        let _ = observer_finished_rx
            .recv_timeout(WATCHDOG_TIMEOUT)
            .expect("teardown observer should finish after guest release");
    }
    observer
        .join()
        .expect("teardown observer thread should not panic");

    let result = observed.expect("teardown observer exceeded outer watchdog");
    let payload = result.expect_err("stalled guest teardown should fail");
    assert!(
        panic_payload_message(payload.as_ref()).contains("guest connection teardown"),
        "teardown timeout should identify its lifecycle phase"
    );
}

#[test]
fn bounded_guest_completion_preserves_completed_results() {
    wait_for_guest_connection_with_timeout(thread::spawn(|| Ok(())), WATCHDOG_TIMEOUT)
        .expect("completed guest should succeed");

    let error = wait_for_guest_connection_with_timeout(
        thread::spawn(|| Err(io::Error::other("guest error detail"))),
        WATCHDOG_TIMEOUT,
    )
    .expect_err("guest error should be preserved");
    assert_eq!(error.to_string(), "guest error detail");

    let panic = panic::catch_unwind(|| {
        wait_for_guest_connection_with_timeout(
            thread::spawn(|| -> io::Result<()> { panic!("guest panic detail") }),
            WATCHDOG_TIMEOUT,
        )
    })
    .expect_err("guest panic should be preserved");
    assert_eq!(panic_payload_message(panic.as_ref()), "guest panic detail");
}
