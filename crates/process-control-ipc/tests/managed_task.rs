use std::io::{self, Write};
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use process_control_ipc::managed_task::{self as ipc, TaskReply, TaskRequest};

#[test]
fn partial_task_frames_cannot_renew_the_read_deadline() {
    for wait_for_writer in [false, true] {
        let mut frame = Vec::new();
        ipc::write_request(&mut frame, &TaskRequest::Launch {}).unwrap();
        let (server, mut client) = UnixStream::pair().unwrap();
        let budget = Duration::from_millis(100);
        let original = Some(Duration::from_secs(2));
        server.set_read_timeout(original).unwrap();
        let observer = server.try_clone().unwrap();
        let (finished, completion) = mpsc::channel::<()>();
        let (waiting, writer_waiting) = mpsc::channel();
        let writer = thread::spawn(move || -> io::Result<()> {
            let mut waiting = wait_for_writer.then_some(waiting);
            // The reader installs a distinct timeout after starting its frame
            // deadline. A pre-call barrier would still allow early delivery.
            while observer.read_timeout()? == original {
                if let Some(waiting) = waiting.take() {
                    let _ = waiting.send(());
                }
                // The read may finish and restore its timeout before this peer
                // observes it. Completion also releases that missed admission.
                match completion.recv_timeout(Duration::from_millis(1)) {
                    Err(RecvTimeoutError::Timeout) => {}
                    Ok(()) | Err(RecvTimeoutError::Disconnected) => return Ok(()),
                }
            }
            // Do not keep the reader's socket alive during writer teardown.
            drop(observer);
            // Each byte arrives inside the idle timeout, but the complete
            // frame exceeds the budget. Real socket deadlines are under test.
            for byte in frame {
                if client.write_all(&[byte]).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
            Ok(())
        });
        // Exercise delayed reader entry by waiting until the writer sees the
        // original socket timeout before calling the production reader.
        let entry = if wait_for_writer {
            writer_waiting.recv_timeout(Duration::from_secs(2))
        } else {
            Ok(())
        };
        let result = entry.map(|()| ipc::read_request_with_timeout(&server, budget));
        let restored = server.read_timeout();
        drop(finished);
        drop(server);
        writer.join().unwrap().unwrap();
        let result = result.expect("writer must observe the original timeout before reader entry");
        assert_eq!(restored.unwrap(), original);
        assert!(
            matches!(&result, Err(error) if error.kind() == io::ErrorKind::TimedOut),
            "partial input must exhaust one frame deadline (writer first: {wait_for_writer}): {result:?}"
        );
    }
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
