use std::any::Any;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::panic;
use std::thread;
use std::time::{Duration, Instant};

use guest_control_server::{
    handle_connection_with_test_dns_readiness_program,
    handle_connection_with_test_guest_agent_program,
    handle_connection_with_test_guest_state_restore_program,
    handle_connection_with_test_home_drive_mount_program,
    handle_connection_with_test_memory_snapshot_path,
    handle_connection_with_test_process_containment,
    handle_connection_with_test_process_containment_and_exec_drain_deadline,
    handle_connection_with_test_storage_manifest_program,
};

use super::protocol::read_message_with_context;

const GUEST_CONNECTION_TIMEOUT: Duration = Duration::from_secs(5);
const GUEST_COMPLETION_POLL_INTERVAL: Duration = Duration::from_millis(10);
const LISTENER_POLL_INTERVAL: Duration = Duration::from_millis(100);

pub(crate) type GuestConnectionHandle = thread::JoinHandle<std::io::Result<()>>;

enum GuestConnectionWait {
    Completed(thread::Result<io::Result<()>>),
    TimedOut,
}

pub(crate) fn start_guest_connection() -> (GuestConnectionHandle, UnixStream) {
    start_guest_connection_with_handler(handle_connection_with_test_process_containment)
}

pub(crate) fn start_guest_connection_with_exec_drain_deadline(
    exec_drain_deadline: Duration,
) -> (GuestConnectionHandle, UnixStream) {
    start_guest_connection_with_handler(move |stream| {
        handle_connection_with_test_process_containment_and_exec_drain_deadline(
            stream,
            exec_drain_deadline,
        )
    })
}

pub(crate) fn start_guest_connection_with_memory_snapshot_path(
    path: std::path::PathBuf,
) -> (GuestConnectionHandle, UnixStream) {
    start_guest_connection_with_handler(move |stream| {
        handle_connection_with_test_memory_snapshot_path(stream, path)
    })
}

pub(crate) fn start_guest_connection_with_dns_readiness_program(
    program: std::path::PathBuf,
) -> (GuestConnectionHandle, UnixStream) {
    start_guest_connection_with_handler(move |stream| {
        handle_connection_with_test_dns_readiness_program(stream, program)
    })
}

pub(crate) fn start_guest_connection_with_storage_manifest_program(
    program: std::path::PathBuf,
) -> (GuestConnectionHandle, UnixStream) {
    start_guest_connection_with_handler(move |stream| {
        handle_connection_with_test_storage_manifest_program(stream, program)
    })
}

pub(crate) fn start_guest_connection_with_home_drive_mount_program(
    program: std::path::PathBuf,
    timeout_ms: u32,
) -> (GuestConnectionHandle, UnixStream) {
    start_guest_connection_with_handler(move |stream| {
        handle_connection_with_test_home_drive_mount_program(stream, program, timeout_ms)
    })
}

pub(crate) fn start_guest_connection_with_guest_state_restore_program(
    program: std::path::PathBuf,
) -> (GuestConnectionHandle, UnixStream) {
    start_guest_connection_with_handler(move |stream| {
        handle_connection_with_test_guest_state_restore_program(stream, program)
    })
}

pub(crate) fn start_guest_connection_with_guest_agent_program(
    program: std::path::PathBuf,
) -> (GuestConnectionHandle, UnixStream) {
    start_guest_connection_with_handler(move |stream| {
        handle_connection_with_test_guest_agent_program(stream, program)
    })
}

fn start_guest_connection_with_handler(
    handler: impl FnOnce(UnixStream) -> std::io::Result<()> + Send + 'static,
) -> (GuestConnectionHandle, UnixStream) {
    start_guest_connection_with_handler_and_timeout(handler, GUEST_CONNECTION_TIMEOUT)
}

fn start_guest_connection_with_handler_and_timeout(
    handler: impl FnOnce(UnixStream) -> std::io::Result<()> + Send + 'static,
    readiness_timeout: Duration,
) -> (GuestConnectionHandle, UnixStream) {
    let (guest_stream, mut host_stream) = UnixStream::pair().unwrap();
    let handle = thread::spawn(move || handler(guest_stream));
    read_guest_ready_with_timeout(&mut host_stream, readiness_timeout);
    (handle, host_stream)
}

pub(crate) fn accept_guest_connection(listener: &UnixListener) -> UnixStream {
    accept_guest_connection_with_timeout(listener, GUEST_CONNECTION_TIMEOUT).unwrap_or_else(
        |error| panic!("guest connection readiness failed during listener accept: {error}"),
    )
}

fn accept_guest_connection_with_timeout(
    listener: &UnixListener,
    timeout: Duration,
) -> io::Result<UnixStream> {
    let deadline = Instant::now()
        .checked_add(timeout)
        .expect("guest connection accept timeout overflowed");

    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("listener accept timed out after {timeout:?}"),
            ));
        }

        if listener_has_pending_connection(listener, deadline.saturating_duration_since(now))? {
            return listener.accept().map(|(stream, _)| stream);
        }
    }
}

pub(crate) fn listener_has_pending_connection(
    listener: &UnixListener,
    remaining: Duration,
) -> io::Result<bool> {
    let timeout = std::cmp::min(remaining, LISTENER_POLL_INTERVAL)
        .as_millis()
        .max(1) as libc::c_int;
    let mut pollfd = libc::pollfd {
        fd: listener.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: pollfd points to one initialized listener descriptor entry, and
    // the timeout is a bounded non-negative millisecond value.
    let result = unsafe { libc::poll(&mut pollfd, 1 as libc::nfds_t, timeout) };
    if result < 0 {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            return Ok(false);
        }
        return Err(error);
    }
    if result == 0 {
        return Ok(false);
    }
    if pollfd.revents & libc::POLLNVAL != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "listener fd is invalid",
        ));
    }
    if pollfd.revents & (libc::POLLERR | libc::POLLHUP) != 0 {
        return Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "listener is no longer accepting connections",
        ));
    }
    Ok(pollfd.revents & libc::POLLIN != 0)
}

pub(crate) fn read_guest_ready(stream: &mut UnixStream) {
    read_guest_ready_with_timeout(stream, GUEST_CONNECTION_TIMEOUT);
}

fn read_guest_ready_with_timeout(stream: &mut UnixStream, timeout: Duration) {
    stream
        .set_read_timeout(Some(timeout))
        .expect("set guest connection readiness read timeout");
    let context = format!("guest connection readiness failed before {timeout:?} deadline");
    let ready = read_message_with_context(stream, &context);
    assert_eq!(ready.msg_type, guest_control_proto::MSG_READY);
}

pub(crate) fn finish_guest_connection(handle: GuestConnectionHandle, host_stream: UnixStream) {
    drop(host_stream);
    join_guest_connection(handle);
}

pub(crate) fn join_guest_connection(handle: GuestConnectionHandle) {
    wait_for_guest_connection(handle).expect("guest connection handler returned an error");
}

pub(crate) fn wait_for_guest_connection(handle: GuestConnectionHandle) -> io::Result<()> {
    wait_for_guest_connection_with_timeout(handle, GUEST_CONNECTION_TIMEOUT)
}

fn wait_for_guest_connection_with_timeout(
    handle: GuestConnectionHandle,
    timeout: Duration,
) -> io::Result<()> {
    match observe_guest_connection_with_timeout(handle, timeout) {
        GuestConnectionWait::Completed(Ok(result)) => result,
        GuestConnectionWait::Completed(Err(payload)) => panic::resume_unwind(payload),
        GuestConnectionWait::TimedOut => {
            panic!("guest connection teardown timed out after {timeout:?}")
        }
    }
}

pub(crate) fn guest_connection_completion_diagnostic(handle: GuestConnectionHandle) -> String {
    match observe_guest_connection_with_timeout(handle, GUEST_CONNECTION_TIMEOUT) {
        GuestConnectionWait::Completed(Ok(result)) => format!("completed with {result:?}"),
        GuestConnectionWait::Completed(Err(payload)) => {
            format!(
                "thread panicked: {}",
                panic_payload_message(payload.as_ref())
            )
        }
        GuestConnectionWait::TimedOut => {
            format!("timed out after {GUEST_CONNECTION_TIMEOUT:?}")
        }
    }
}

fn observe_guest_connection_with_timeout(
    handle: GuestConnectionHandle,
    timeout: Duration,
) -> GuestConnectionWait {
    let deadline = Instant::now()
        .checked_add(timeout)
        .expect("guest connection teardown timeout overflowed");
    while !handle.is_finished() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return GuestConnectionWait::TimedOut;
        }
        thread::sleep(std::cmp::min(remaining, GUEST_COMPLETION_POLL_INTERVAL));
    }
    GuestConnectionWait::Completed(handle.join())
}

fn panic_payload_message(payload: &(dyn Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "non-string panic payload".to_owned()
    }
}

#[cfg(test)]
mod tests {
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
}
