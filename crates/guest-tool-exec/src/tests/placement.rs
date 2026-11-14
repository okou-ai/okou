use super::*;
use cli_test_support::child::KillAndWaitChild as TestChild;
use rustix::net::{AddressFamily, SocketFlags, SocketType, socket_with};
use std::mem::{MaybeUninit, size_of};
use std::os::fd::{AsFd, AsRawFd};
use std::os::unix::net::UnixListener;
use std::thread;
use std::time::Instant;

const QUEUE_TEST_CHILD_ENV: &str = "VM0_TEST_PLACEMENT_CONNECT_CHILD";

fn fill_accept_queue(listener: &UnixListener) -> Vec<OwnedFd> {
    // Read the bound address so fixture clients independently exercise the
    // kernel's nonblocking queue-full result, without using the timed API.
    let mut address = MaybeUninit::<libc::sockaddr_un>::uninit();
    let mut address_len = size_of::<libc::sockaddr_un>() as libc::socklen_t;
    // SAFETY: address and address_len point to writable, correctly sized storage.
    let result = unsafe {
        libc::getsockname(
            listener.as_raw_fd(),
            address.as_mut_ptr().cast(),
            &mut address_len,
        )
    };
    assert_eq!(result, 0);
    let mut queued = Vec::new();
    for _ in 0..1024 {
        let socket = socket_with(
            AddressFamily::UNIX,
            SocketType::STREAM,
            SocketFlags::CLOEXEC | SocketFlags::NONBLOCK,
            None,
        )
        .expect("create nonblocking queue socket");
        // SAFETY: getsockname initialized address_len bytes of the address and
        // socket owns a valid AF_UNIX descriptor for the entire call.
        let result =
            unsafe { libc::connect(socket.as_raw_fd(), address.as_ptr().cast(), address_len) };
        if result == 0 {
            queued.push(socket);
        } else {
            assert_eq!(io::Error::last_os_error().kind(), io::ErrorKind::WouldBlock);
            assert!(!queued.is_empty());
            return queued;
        }
    }
    panic!("fixture could not fill the listener's accept queue");
}

fn resource_counts() -> (usize, usize) {
    (
        std::fs::read_dir("/proc/self/fd").unwrap().count(),
        std::fs::read_dir("/proc/self/task").unwrap().count(),
    )
}

fn assert_queue_deadlines() {
    let endpoint = format!("vm0-test-tool-connect-full-{}", std::process::id());
    let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
    let queued = fill_accept_queue(&listener);
    // Only this test runs in the child, so parallel tests cannot perturb counts.
    let baseline = resource_counts();

    for timeout in [
        Duration::ZERO,
        Duration::from_millis(100),
        Duration::from_millis(100),
    ] {
        let started = Instant::now();
        let error = process_control_ipc::connect_abstract_with_timeout(&endpoint, timeout)
            .expect_err("a full accept queue must not report a connected stream");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() >= timeout);
        assert!(started.elapsed() < timeout + Duration::from_secs(1));
        assert_eq!(resource_counts(), baseline);
    }

    let started = Instant::now();
    let error = place_current_process(&endpoint)
        .expect_err("placement must time out without requiring the listener to close");
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert!(started.elapsed() >= PLACEMENT_TIMEOUT);
    assert!(started.elapsed() < PLACEMENT_TIMEOUT + Duration::from_secs(1));
    assert_eq!(resource_counts(), baseline);

    // Keep the listener and all queued clients alive through the assertions.
    // Freeing one slot must permit a later attempt to connect normally.
    let accepted =
        process_control_ipc::accept_with_timeout(&listener, Duration::from_secs(1)).unwrap();
    let recovered =
        process_control_ipc::connect_abstract_with_timeout(&endpoint, Duration::from_secs(1))
            .unwrap();
    drop(recovered);
    drop(accepted);
    assert_eq!(resource_counts(), baseline);
    drop(queued);
    drop(listener);
}

#[test]
fn placement_connect_deadline_bounds_full_accept_queue() {
    if env::var_os(QUEUE_TEST_CHILD_ENV).is_some() {
        assert_queue_deadlines();
        return;
    }

    let mut child = TestChild(
        Command::new(env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::placement::placement_connect_deadline_bounds_full_accept_queue",
                "--nocapture",
            ])
            .env(QUEUE_TEST_CHILD_ENV, "1")
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success(), "queue-deadline child failed: {status}");
            return;
        }
        assert!(
            Instant::now() < deadline,
            "queue-deadline child exceeded watchdog"
        );
        // Poll only the owned child's exit; the Drop guard kills and reaps it
        // even when a regressed blocking connect exceeds the watchdog.
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn placement_writes_descriptor_and_requires_broker_acknowledgement() {
    for acknowledge in [true, false] {
        let endpoint = format!("vm0-test-tool-ack-{}-{acknowledge}", std::process::id());
        let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
        let mut placement = tempfile::tempfile().unwrap();
        let broker_placement = placement.try_clone().unwrap();
        let broker = thread::spawn(move || {
            let stream =
                process_control_ipc::accept_with_timeout(&listener, Duration::from_secs(1))
                    .unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            process_control_ipc::send_tool_placement(&stream, broker_placement.as_fd()).unwrap();
            process_control_ipc::read_tool_placement_confirmation(&stream).unwrap();
            if acknowledge {
                process_control_ipc::write_tool_placement_ack(&stream).unwrap();
            }
        });

        let result = place_current_process(&endpoint);
        broker.join().unwrap();
        if acknowledge {
            result.unwrap();
        } else {
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
        }
        use std::io::{Seek, SeekFrom};
        placement.seek(SeekFrom::Start(0)).unwrap();
        let mut contents = String::new();
        placement.read_to_string(&mut contents).unwrap();
        assert_eq!(contents, "0");
    }
}

#[test]
fn placement_write_failure_never_confirms_to_broker() {
    let endpoint = format!("vm0-test-tool-write-failure-{}", std::process::id());
    let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
    let placement = std::fs::File::open("/dev/null").unwrap();
    let broker = thread::spawn(move || {
        let stream =
            process_control_ipc::accept_with_timeout(&listener, Duration::from_secs(1)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        process_control_ipc::send_tool_placement(&stream, placement.as_fd()).unwrap();
        process_control_ipc::read_tool_placement_confirmation(&stream)
    });

    let result = place_current_process(&endpoint);
    let confirmation = broker.join().unwrap();

    assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::EBADF));
    assert_eq!(
        confirmation.unwrap_err().kind(),
        io::ErrorKind::UnexpectedEof
    );
}
