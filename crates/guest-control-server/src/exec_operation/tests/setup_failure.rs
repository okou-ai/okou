use super::*;
use crate::test_support::{kill_pidfd_and_wait, open_pidfd};
use crate::threading::ThreadTask;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixDatagram;
use std::sync::Condvar;

const CHILD_SOCKET_ENV: &str = "OKOU_EXEC_SETUP_CHILD_SOCKET";
const CHILD_TEST: &str = "exec_operation::tests::setup_failure::child_process";
const TEST_BOUND: Duration = Duration::from_secs(3);

// Re-executed through the real workload command. `exec` preserves the direct
// child identity and this fixture creates no descendants or shell background jobs.
#[test]
#[ignore = "exact subprocess fixture, requires its private readiness socket"]
fn child_process() {
    let path = std::env::var_os(CHILD_SOCKET_ENV).expect("subprocess fixture socket");
    let socket = UnixDatagram::unbound().unwrap();
    socket.connect(path).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    socket.send(&std::process::id().to_ne_bytes()).unwrap();
    // Independent fail-safe if the parent aborts before binding/cleaning our PID.
    // Normal tests kill us at the gated failure, without waiting for this timeout.
    let error = socket.recv(&mut [0]).unwrap_err();
    assert!(matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
    ));
}

pub(super) struct SetupFailureChild {
    directory: tempfile::TempDir,
    ready: Arc<UnixDatagram>,
    child: Arc<Mutex<Option<ObservedChild>>>,
    worker_done: Arc<(Mutex<bool>, Condvar)>,
}

impl SetupFailureChild {
    pub(super) fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let ready = UnixDatagram::bind(directory.path().join("ready.sock")).unwrap();
        ready.set_read_timeout(Some(TEST_BOUND)).unwrap();
        Self {
            directory,
            ready: Arc::new(ready),
            child: Arc::new(Mutex::new(None)),
            worker_done: Arc::new((Mutex::new(false), Condvar::new())),
        }
    }

    pub(super) fn request(
        &self,
        mut request: ExecOperationWorkerRequest,
    ) -> ExecOperationWorkerRequest {
        request.command = format!(
            "exec {} --exact {CHILD_TEST} --ignored --nocapture",
            shell_quote::quote_shell_arg(std::env::current_exe().unwrap().to_str().unwrap())
        );
        request.env.push((
            CHILD_SOCKET_ENV.to_string(),
            self.directory
                .path()
                .join("ready.sock")
                .to_str()
                .unwrap()
                .to_string(),
        ));
        request.process_containment_mode = ProcessContainmentMode::TestNoop;
        request
    }

    pub(super) fn failing_spawner(&self, name: &'static str) -> ReadyFailingSpawner {
        ReadyFailingSpawner {
            name,
            ready: self.ready.clone(),
            child: self.child.clone(),
            failure: FailingThreadSpawner::fail_once(name),
            worker_done: self.worker_done.clone(),
        }
    }

    pub(super) fn fail_started_send(
        &self,
        writer: &GuestWriter,
        socket: &UnixStream,
        run: impl FnOnce() + Send + 'static,
    ) {
        let (done_tx, done_rx) = mpsc::channel();
        let worker_done = self.worker_done.clone();
        let mut worker = None;
        writer
            .write_frame_after_lock(b"", || {
                // The worker cannot send exec_started or clean up the child
                // until this lock is released after readiness and shutdown.
                worker = Some(std::thread::spawn(move || {
                    let _completion = WorkerCompletion(worker_done);
                    run();
                    let _ = done_tx.send(());
                }));
                observe_ready_child(&self.ready, &self.child);
                socket.shutdown(Shutdown::Write).unwrap();
            })
            .unwrap();
        done_rx.recv_timeout(TEST_BOUND).unwrap();
        worker.unwrap().join().unwrap();
    }

    pub(super) fn assert_reaped(&self) {
        let child = self.child.lock().unwrap_or_else(|e| e.into_inner());
        let child = child.as_ref().expect("failure must follow child readiness");
        let outcome = child.wait_without_reaping();
        assert!(
            matches!(&outcome, Err(error) if error.raw_os_error() == Some(libc::ECHILD)),
            "setup child must already be reaped at failure completion; \
             waitid returned {outcome:?} (0 means live; a PID means zombie)"
        );
    }
}

impl Drop for SetupFailureChild {
    fn drop(&mut self) {
        // The test owns cleanup even if a worker still holds the shared gate.
        let child = self.child.lock().unwrap_or_else(|e| e.into_inner()).take();
        let Some(child) = child else { return };
        if let Err(error) = kill_pidfd_and_wait(&child.pidfd) {
            eprintln!("failed to retire exec setup fixture: {error}");
            return;
        }
        // Signaling through the pidfd is safe while the production owner is
        // active, but reaping must wait until it can no longer use the PID/PGID.
        let (done, changed) = &*self.worker_done;
        let done = done.lock().unwrap_or_else(|e| e.into_inner());
        let (done, _) = changed
            .wait_timeout_while(done, TEST_BOUND, |done| !*done)
            .unwrap_or_else(|e| e.into_inner());
        if *done {
            child.reap();
        } else {
            eprintln!(
                "exec setup worker did not release its killed child within the cleanup bound"
            );
        }
    }
}

struct WorkerCompletion(Arc<(Mutex<bool>, Condvar)>);

impl Drop for WorkerCompletion {
    fn drop(&mut self) {
        let (done, changed) = &*self.0;
        *done.lock().unwrap_or_else(|e| e.into_inner()) = true;
        changed.notify_all();
    }
}

#[derive(Clone)]
pub(super) struct ReadyFailingSpawner {
    name: &'static str,
    ready: Arc<UnixDatagram>,
    child: Arc<Mutex<Option<ObservedChild>>>,
    failure: FailingThreadSpawner,
    worker_done: Arc<(Mutex<bool>, Condvar)>,
}

impl ThreadSpawner for ReadyFailingSpawner {
    fn spawn<T: Send + 'static>(
        &self,
        name: &'static str,
        task: ThreadTask<T>,
    ) -> io::Result<JoinHandle<T>> {
        if name == self.name {
            observe_ready_child(&self.ready, &self.child);
        }
        if name == THREAD_EXEC_OPERATION_WORKER {
            let worker_done = self.worker_done.clone();
            self.failure.spawn(
                name,
                Box::new(move || {
                    let _completion = WorkerCompletion(worker_done);
                    task()
                }),
            )
        } else {
            self.failure.spawn(name, task)
        }
    }
}

fn observe_ready_child(ready: &UnixDatagram, child: &Mutex<Option<ObservedChild>>) {
    let mut child = child.lock().unwrap_or_else(|e| e.into_inner());
    assert!(child.is_none(), "readiness gate must run once");
    let mut bytes = [0; 4];
    assert_eq!(ready.recv(&mut bytes).unwrap(), bytes.len());
    let pid = libc::pid_t::try_from(u32::from_ne_bytes(bytes)).unwrap();
    *child = Some(ObservedChild {
        pidfd: open_pidfd(pid).unwrap(),
    });
    let observed = child.as_ref().unwrap();
    // The fixture is blocked on its private socket, so cleanup cannot win
    // the pidfd-open race. Verify parentage without consuming any wait status.
    assert_eq!(observed.wait_without_reaping().unwrap(), 0);
    // SAFETY: getpgid only observes the live child identified by the fixture.
    assert_eq!(unsafe { libc::getpgid(pid) }, pid);
}

struct ObservedChild {
    pidfd: OwnedFd,
}

impl ObservedChild {
    fn wait_without_reaping(&self) -> io::Result<libc::pid_t> {
        loop {
            let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
            // SAFETY: info is writable and the pidfd stays owned throughout
            // the call. WNOWAIT observes but does not repair missing reaping.
            let result = unsafe {
                libc::waitid(
                    libc::P_PIDFD,
                    self.pidfd.as_raw_fd() as libc::id_t,
                    info.as_mut_ptr(),
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result == 0 {
                // SAFETY: successful waitid initialized the siginfo fields.
                return Ok(unsafe { info.assume_init().si_pid() });
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}

impl ObservedChild {
    fn reap(self) {
        loop {
            let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
            // SAFETY: pidfd binds this nonblocking reap to the original child.
            let result = unsafe {
                libc::waitid(
                    libc::P_PIDFD,
                    self.pidfd.as_raw_fd() as libc::id_t,
                    info.as_mut_ptr(),
                    libc::WEXITED | libc::WNOHANG,
                )
            };
            if result == 0 {
                break;
            }
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            if error.raw_os_error() != Some(libc::ECHILD) {
                eprintln!("failed to reap exec setup fixture: {error}");
            }
            break;
        }
    }
}
