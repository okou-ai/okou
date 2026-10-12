use std::io::{self, Write};
use std::os::unix::net::UnixStream;
use std::thread;
use std::time::Duration;

use process_control_ipc::managed_task::{self as ipc, TaskReply, TaskRequest};

#[test]
fn partial_task_frames_cannot_renew_the_read_deadline() {
    let mut frame = Vec::new();
    ipc::write_request(&mut frame, &TaskRequest::Launch {}).unwrap();
    let (server, mut client) = UnixStream::pair().unwrap();
    let budget = Duration::from_millis(100);
    server.set_read_timeout(Some(budget)).unwrap();
    let writer = thread::spawn(move || {
        // This external peer delivers each byte inside the idle timeout, but
        // the complete frame exceeds the budget. Real socket deadlines are
        // the behavior under test; no elapsed-time performance assertion.
        for byte in frame {
            if client.write_all(&[byte]).is_err() {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
    });
    let result = ipc::read_request_with_timeout(&server, budget);
    assert_eq!(server.read_timeout().unwrap(), Some(budget));
    drop(server);
    writer.join().unwrap();
    assert!(
        matches!(&result, Err(error) if error.kind() == io::ErrorKind::TimedOut),
        "partial input must exhaust one frame deadline: {result:?}"
    );
}

#[test]
fn complete_socket_frames_preserve_the_callers_read_timeout() {
    let (server, mut client) = UnixStream::pair().unwrap();
    let original = Some(Duration::from_secs(2));
    server.set_read_timeout(original).unwrap();
    ipc::write_request(&mut client, &TaskRequest::Launch {}).unwrap();
    assert!(matches!(
        ipc::read_request_with_timeout(&server, Duration::from_secs(1)).unwrap(),
        TaskRequest::Launch {}
    ));
    assert_eq!(server.read_timeout().unwrap(), original);

    ipc::write_reply(&mut client, &TaskReply::Stopped {}).unwrap();
    assert!(matches!(
        ipc::read_reply_with_timeout(&server, Duration::from_secs(1)).unwrap(),
        TaskReply::Stopped {}
    ));
    assert_eq!(server.read_timeout().unwrap(), original);
}

#[test]
fn zero_or_overflowing_frame_budgets_fail_before_reading() {
    let (server, mut client) = UnixStream::pair().unwrap();
    ipc::write_request(&mut client, &TaskRequest::Launch {}).unwrap();
    assert_eq!(
        ipc::read_request_with_timeout(&server, Duration::ZERO)
            .unwrap_err()
            .kind(),
        io::ErrorKind::TimedOut
    );
    assert_eq!(
        ipc::read_request_with_timeout(&server, Duration::MAX)
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidInput
    );
    assert!(matches!(
        ipc::read_request_with_timeout(&server, Duration::from_secs(1)).unwrap(),
        TaskRequest::Launch {}
    ));
    assert_eq!(server.read_timeout().unwrap(), None);
}
