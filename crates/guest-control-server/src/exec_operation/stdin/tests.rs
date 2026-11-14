use super::*;
use crate::threading::{SystemThreadSpawner, ThreadTask};
use std::cell::Cell;
use std::fs::File;
use std::time::Duration;

thread_local! {
    pub(super) static STDIN_POLL_READY: Cell<Option<mpsc::Sender<()>>> = const { Cell::new(None) };
}

#[derive(Clone)]
struct StdinPollReadySpawner {
    ready: mpsc::Sender<()>,
}

impl ThreadSpawner for StdinPollReadySpawner {
    fn spawn<T: Send + 'static>(
        &self,
        name: &'static str,
        task: ThreadTask<T>,
    ) -> io::Result<JoinHandle<T>> {
        let ready = self.ready.clone();
        SystemThreadSpawner.spawn(
            name,
            Box::new(move || {
                STDIN_POLL_READY.set(Some(ready));
                task()
            }),
        )
    }
}

#[test]
fn stdin_writer_cancel_unblocks_full_pipe() {
    // The exec protocol cannot synchronize on this private worker's final
    // pre-poll check, and child cleanup can independently release stdin.
    // Keep the actual writer, full pipe, poll, and cancellation wakeup here.
    let (read_fd, write_fd) = rustix::pipe::pipe().unwrap();
    let mut write_file = File::from(write_fd);
    set_nonblocking(write_file.as_fd()).unwrap();

    let fill = [0u8; 4096];
    loop {
        match write_file.write(&fill) {
            Ok(0) => panic!("pipe write returned zero while filling"),
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
            Err(e) => panic!("failed to fill pipe: {e}"),
        }
    }

    let (ready_tx, ready_rx) = mpsc::channel();
    let writer = StdinWriter::spawn(
        write_file,
        b"blocked".to_vec(),
        StdinPollReadySpawner { ready: ready_tx },
    )
    .unwrap();
    let ready = ready_rx.recv_timeout(Duration::from_secs(5));
    writer.request_cancel();
    let completed = writer.done_rx.recv_timeout(Duration::from_secs(5));

    // Record completion while the peer is still open and undrained. Release
    // it and join before asserting, including readiness and wakeup failures.
    drop(read_fd);
    let result = writer
        .handle
        .join()
        .unwrap_or_else(|panic| std::panic::resume_unwind(panic));
    ready.expect("stdin writer did not reach its blocking poll");
    completed.expect("stdin writer cancel did not wake blocked writer");
    assert!(is_stdin_write_cancelled(&result.unwrap_err()));
}

#[test]
fn write_stdin_rejects_pre_cancelled_input() {
    let mut stdin = tempfile::tempfile().unwrap();
    let (cancel_reader, _cancel_writer) = stdin_cancel_pipe().unwrap();
    let cancel = AtomicBool::new(true);

    let result = write_stdin_cancellable(&mut stdin, b"input", &cancel, cancel_reader.as_raw_fd());

    assert!(is_stdin_write_cancelled(&result.unwrap_err()));
    assert_eq!(stdin.metadata().unwrap().len(), 0);
}

#[test]
fn stdin_cancel_pipe_is_nonblocking_and_close_on_exec() {
    let (read_fd, write_fd) = stdin_cancel_pipe().unwrap();

    for fd in [read_fd.as_raw_fd(), write_fd.as_raw_fd()] {
        // SAFETY: fd is open for the duration of this assertion.
        let status_flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        assert!(status_flags >= 0);
        assert_ne!(status_flags & libc::O_NONBLOCK, 0);

        // SAFETY: fd is open for the duration of this assertion.
        let descriptor_flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        assert!(descriptor_flags >= 0);
        assert_ne!(descriptor_flags & libc::FD_CLOEXEC, 0);
    }
}
