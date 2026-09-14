use std::io::{self, Read};
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::Arc;
use std::sync::Once;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use guest_control_client::{ExecOperationResult, ExecOwnedCapturedOutput, GuestControlClient};
use guest_control_proto::ExecTermination;
use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
pub(crate) use shell_quote::quote_shell_arg as shell_quote;
use tokio::io::unix::AsyncFd;

static WRITE_FILE_HELPER: Once = Once::new();
const WRITE_FILE_HELPER_BIN: &str = env!("CARGO_BIN_EXE_guest-write-file-test-helper");
const BLOCKING_WRITE_SUFFIX: &str = ".vm0-guest-control-tests-block";
const GUEST_FINISH_TIMEOUT: Duration = Duration::from_secs(5);

fn install_write_file_helper() {
    WRITE_FILE_HELPER.call_once(|| {
        guest_control_server::set_debug_guest_write_file_path_for_tests(
            WRITE_FILE_HELPER_BIN.into(),
        );
    });
}

pub(crate) type RawGuestHandle = JoinHandle<io::Result<()>>;

pub(crate) fn start_raw_guest_connection() -> (RawGuestHandle, UnixStream) {
    install_write_file_helper();
    let (guest_stream, mut host_stream) = UnixStream::pair().expect("create raw guest stream pair");
    host_stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("set raw guest read timeout");
    let handle = thread::spawn(move || guest_control_server::handle_connection(guest_stream));
    let ready = read_raw_message(&mut host_stream);
    assert_eq!(ready.msg_type, guest_control_proto::MSG_READY);
    (handle, host_stream)
}

pub(crate) fn join_raw_guest_connection(handle: RawGuestHandle) {
    join_guest_with_timeout(handle)
        .expect("raw guest connection thread panicked")
        .expect("raw guest connection returned an error");
}

pub(crate) fn finish_raw_guest_connection(handle: RawGuestHandle, stream: UnixStream) {
    drop(stream);
    join_raw_guest_connection(handle);
}

pub(crate) fn read_raw_message(stream: &mut impl Read) -> guest_control_proto::RawMessage {
    let mut header = [0u8; 4];
    stream
        .read_exact(&mut header)
        .expect("read raw guest message header");
    let body_len = u32::from_be_bytes(header) as usize;
    let mut body = vec![0u8; body_len];
    stream
        .read_exact(&mut body)
        .expect("read raw guest message body");
    let mut frame = Vec::with_capacity(header.len() + body.len());
    frame.extend_from_slice(&header);
    frame.extend_from_slice(&body);
    let mut messages = guest_control_proto::Decoder::new()
        .decode(&frame)
        .expect("decode raw guest message");
    assert_eq!(messages.len(), 1);
    messages.remove(0)
}

pub(crate) fn blocking_write_path(dir: &Path, name: &str) -> std::path::PathBuf {
    dir.join(format!("{name}{BLOCKING_WRITE_SUFFIX}"))
}

fn blocking_write_started_path(path: &Path) -> std::path::PathBuf {
    path_with_suffix(path, ".started")
}

fn blocking_write_release_path(path: &Path) -> std::path::PathBuf {
    path_with_suffix(path, ".release")
}

pub(crate) fn release_blocking_write(path: &Path) {
    std::fs::write(blocking_write_release_path(path), b"").expect("release blocked write helper");
}

pub(crate) fn blocking_write_pid_path(path: &Path) -> std::path::PathBuf {
    path_with_suffix(path, ".pid")
}

fn blocking_write_failed_path(path: &Path) -> std::path::PathBuf {
    path_with_suffix(path, ".failed")
}

pub(crate) fn pid_alive(pid: u32) -> bool {
    // SAFETY: signal zero performs a process-existence check without sending a signal.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

fn path_with_suffix(path: &Path, suffix: &str) -> std::path::PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    std::path::PathBuf::from(value)
}

/// Spawn a guest agent in a background OS thread that connects to the given socket path.
fn start_guest(
    socket_path: &str,
    guest_agent_program: Option<std::path::PathBuf>,
) -> JoinHandle<io::Result<()>> {
    let path = socket_path.to_owned();
    thread::spawn(move || {
        let stream = guest_control_server::connect_unix(&path)?;
        match guest_agent_program {
            Some(program) => guest_control_server::handle_connection_with_test_guest_agent_program(
                stream, program,
            ),
            None => guest_control_server::handle_connection(stream),
        }
    })
}

fn cleanup_guest(guest: &mut Option<JoinHandle<io::Result<()>>>, timeout: Duration) {
    if let Some(g) = guest.take() {
        let _ = try_join_guest_with_timeout(g, timeout);
    }
}

fn join_guest_with_timeout(guest: JoinHandle<io::Result<()>>) -> thread::Result<io::Result<()>> {
    try_join_guest_with_timeout(guest, GUEST_FINISH_TIMEOUT).unwrap_or_else(|| {
        panic!(
            "guest thread did not terminate within {GUEST_FINISH_TIMEOUT:?} after host disconnect"
        )
    })
}

fn try_join_guest_with_timeout(
    guest: JoinHandle<io::Result<()>>,
    timeout: Duration,
) -> Option<thread::Result<io::Result<()>>> {
    let started = Instant::now();
    while !guest.is_finished() {
        if started.elapsed() >= timeout {
            return None;
        }
        thread::sleep(Duration::from_millis(10));
    }
    Some(guest.join())
}

fn create_temp_dir(prefix: &str) -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix(prefix)
        .tempdir()
        .expect("create temp dir")
}

pub(crate) fn shell_quote_path(path: &Path) -> String {
    shell_quote(path.to_str().expect("test path must be valid UTF-8"))
}

pub(crate) async fn wait_for_path(path: &Path, timeout: Duration) {
    wait_for_path_result(path, timeout)
        .await
        .unwrap_or_else(|error| panic!("timed out waiting for path {path:?}: {error}"));
}

pub(crate) async fn wait_for_blocking_write(path: &Path, timeout: Duration) -> io::Result<()> {
    let started_path = blocking_write_started_path(path);
    let failed_path = blocking_write_failed_path(path);
    tokio::time::timeout(timeout, async {
        tokio::select! {
            result = wait_for_path_event(&started_path) => result,
            result = wait_for_path_event(&failed_path) => {
                result?;
                let message = tokio::fs::read_to_string(&failed_path).await?;
                Err(io::Error::other(message))
            }
        }
    })
    .await
    .map_err(|_| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            "blocking write readiness timed out",
        )
    })?
}

pub(crate) async fn run_exec(
    host: &GuestControlClient,
    command: &str,
    timeout_ms: u32,
    env: &[(&str, &str)],
    sudo: bool,
) -> io::Result<ExecOperationResult> {
    host.exec_operation_capture_default(
        command,
        timeout_ms,
        env,
        sudo,
        "exec",
        Duration::from_millis(timeout_ms as u64 + 5000),
    )
    .await
}

pub(crate) fn exec_exit_code(result: &ExecOperationResult) -> Option<i32> {
    match result.termination {
        ExecTermination::Exited { exit_code } => Some(exit_code),
        ExecTermination::TimedOut
        | ExecTermination::Cancelled
        | ExecTermination::StartFailed
        | ExecTermination::WaitFailed => None,
    }
}

pub(crate) fn captured_output_bytes(output: &ExecOwnedCapturedOutput) -> &[u8] {
    match output {
        ExecOwnedCapturedOutput::Captured { bytes, .. } => bytes,
        ExecOwnedCapturedOutput::Discarded => panic!("expected captured output"),
    }
}

/// Test harness: creates temp dir, starts guest thread, connects host.
///
/// Implements `Drop` to clean up temp dirs and wait a bounded time for guest threads,
/// including during panic unwinding.
pub(crate) struct Harness {
    pub(crate) dir: std::path::PathBuf,
    _dir_guard: tempfile::TempDir,
    host: Option<GuestControlClient>,
    guest: Option<JoinHandle<io::Result<()>>>,
}

impl Harness {
    pub(crate) async fn new() -> Self {
        Self::new_with_program(None).await
    }

    pub(crate) async fn new_with_guest_agent_program(program: std::path::PathBuf) -> Self {
        Self::new_with_program(Some(program)).await
    }

    async fn new_with_program(guest_agent_program: Option<std::path::PathBuf>) -> Self {
        install_write_file_helper();

        let dir_guard = create_temp_dir("guest-control-tests");
        let dir = dir_guard.path().to_path_buf();
        let base_path = dir.join("vsock").to_string_lossy().to_string();
        let listener_path = format!("{base_path}_1000");
        let listener = std::path::PathBuf::from(&listener_path);

        let host_base_path = base_path.clone();
        let host_task = tokio::spawn(async move {
            GuestControlClient::wait_for_connection(&host_base_path, Duration::from_secs(5)).await
        });

        if let Err(err) = wait_for_path_result(&listener, Duration::from_secs(5)).await {
            host_task.abort();
            let _ = host_task.await;
            panic!("host listener did not become ready: {err}");
        }

        let mut guest = Some(start_guest(&listener_path, guest_agent_program));
        let host = match host_task.await {
            Ok(Ok(host)) => host,
            Ok(Err(err)) => {
                cleanup_guest(&mut guest, GUEST_FINISH_TIMEOUT);
                panic!("host connection failed: {err}");
            }
            Err(err) => {
                cleanup_guest(&mut guest, GUEST_FINISH_TIMEOUT);
                panic!("host listener task failed: {err}");
            }
        };

        Self {
            dir,
            _dir_guard: dir_guard,
            host: Some(host),
            guest,
        }
    }

    pub(crate) fn host(&self) -> &GuestControlClient {
        self.host
            .as_ref()
            .expect("Harness host should be available before finish/drop")
    }

    pub(crate) fn finish(mut self) {
        drop(self.host.take());
        if let Some(g) = self.guest.take() {
            join_guest_with_timeout(g)
                .expect("guest thread panicked")
                .expect("guest returned error");
        }
    }

    /// Finish without asserting the guest result after abandoning an in-flight operation.
    pub(crate) fn finish_ignore_guest(mut self) {
        drop(self.host.take());
        if let Some(g) = self.guest.take() {
            let _ = join_guest_with_timeout(g);
        }
    }
}

async fn wait_for_path_result(path: &Path, timeout: Duration) -> io::Result<()> {
    tokio::time::timeout(timeout, wait_for_path_event(path))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "path wait timed out"))?
}

async fn wait_for_path_event(path: &Path) -> io::Result<()> {
    if tokio::fs::try_exists(path).await? {
        return Ok(());
    }

    let dir = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("path has no parent directory: {}", path.display()),
        )
    })?;
    let inotify = Inotify::init(InitFlags::IN_NONBLOCK)
        .map_err(|error| io::Error::other(format!("inotify init: {error}")))?;
    inotify
        .add_watch(dir, AddWatchFlags::IN_CREATE | AddWatchFlags::IN_MOVED_TO)
        .map_err(|error| io::Error::other(format!("inotify watch: {error}")))?;

    if tokio::fs::try_exists(path).await? {
        return Ok(());
    }

    let async_fd = async_inotify_fd(inotify)?;
    loop {
        let mut guard = async_fd.readable().await?;
        drain_inotify_fd(async_fd.get_ref().as_fd());
        guard.clear_ready();

        if tokio::fs::try_exists(path).await? {
            return Ok(());
        }
    }
}

fn async_inotify_fd(inotify: Inotify) -> io::Result<AsyncFd<OwnedFd>> {
    let fd: OwnedFd = inotify.into();
    AsyncFd::new(fd).map_err(|error| io::Error::other(format!("AsyncFd: {error}")))
}

fn drain_inotify_fd(fd: std::os::fd::BorrowedFd<'_>) {
    let mut buf = [0u8; 4096];
    loop {
        // SAFETY: fd is a valid non-blocking inotify descriptor borrowed from
        // AsyncFd. The stack buffer is valid for the requested byte length.
        let result = unsafe { libc::read(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
        if result <= 0 {
            break;
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        // Drop host first to close the connection, then wait briefly for the guest thread.
        drop(self.host.take());
        cleanup_guest(&mut self.guest, GUEST_FINISH_TIMEOUT);
    }
}

#[test]
fn cleanup_guest_joins_guest() {
    let guest_finished = Arc::new(AtomicBool::new(false));
    let guest_finished_for_thread = Arc::clone(&guest_finished);
    let mut guest = Some(thread::spawn(move || {
        guest_finished_for_thread.store(true, Ordering::SeqCst);
        Ok(())
    }));

    cleanup_guest(&mut guest, GUEST_FINISH_TIMEOUT);

    assert!(guest.is_none());
    assert!(guest_finished.load(Ordering::SeqCst));
}

#[test]
fn cleanup_guest_returns_after_timeout_for_stalled_guest() {
    const CLEANUP_TIMEOUT: Duration = Duration::from_millis(20);
    const WATCHDOG_TIMEOUT: Duration = Duration::from_secs(5);

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

    let (cleanup_finished_tx, cleanup_finished_rx) = mpsc::channel();
    let cleanup_thread = thread::spawn(move || {
        let mut guest = Some(guest);
        cleanup_guest(&mut guest, CLEANUP_TIMEOUT);
        cleanup_finished_tx
            .send(guest.is_none())
            .expect("report cleanup completion");
    });

    let cleanup_result = cleanup_finished_rx.recv_timeout(WATCHDOG_TIMEOUT);
    release_guest_tx.send(()).expect("release stalled guest");
    guest_finished_rx
        .recv_timeout(WATCHDOG_TIMEOUT)
        .expect("guest should finish after release");
    if matches!(&cleanup_result, Err(mpsc::RecvTimeoutError::Timeout)) {
        cleanup_finished_rx
            .recv_timeout(WATCHDOG_TIMEOUT)
            .expect("cleanup should finish after guest release");
    }
    cleanup_thread
        .join()
        .expect("cleanup helper thread should not panic");

    assert!(
        matches!(cleanup_result, Ok(true)),
        "cleanup did not consume the guest handle before the watchdog: {cleanup_result:?}"
    );
}

#[test]
fn create_temp_dir_returns_distinct_direct_temp_children() {
    let first = create_temp_dir("guest-control-tests-unique");
    let second = create_temp_dir("guest-control-tests-unique");

    assert_ne!(first.path(), second.path());
    assert_eq!(first.path().parent(), Some(std::env::temp_dir().as_path()));
    assert_eq!(second.path().parent(), Some(std::env::temp_dir().as_path()));
}
