use std::io::{self, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
#[cfg(any(debug_assertions, feature = "test-support"))]
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;

use guest_contracts::exec_terminal::EXEC_OUTPUT_DRAIN_DEADLINE;
use guest_contracts::file_write::WRITE_FILE_HELPER_TIMEOUT_MS;
use guest_control_proto::{
    self, BorrowedRawMessage, FileWriteStage, MSG_ERROR, MSG_PING, MSG_PONG, MSG_SHUTDOWN,
    MSG_WRITE_FILE_RESULT, MSG_WRITE_FILES_RESULT,
};

use crate::drain::{DrainCancellation, drain_into_vec_cancellable};
use crate::error::to_io_error;
use crate::file_write_progress::FileWriteRequestProgress;
use crate::log::log;
use crate::process::{extract_exit_code, kill_and_reap_child, spawn_in_own_process_group};
use crate::shutdown::handle_shutdown;
use crate::threading::{SystemThreadSpawner, ThreadSpawner, spawn_scoped_named};
use crate::user::apply_command_identity;
use crate::wait::{
    WaitOutcome, await_drain_deadline, wait_with_kill_timeout_or_connection_cancelled,
};

const THREAD_WRITE_STDERR: &str = "gctl-write-err";
const THREAD_WRITE_STDIN: &str = "gctl-write-in";
#[cfg(any(debug_assertions, feature = "test-support"))]
static DEBUG_GUEST_WRITE_FILE_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

pub(crate) enum MessageOutcome {
    Response(Vec<u8>),
    Shutdown(Vec<u8>),
}

pub(crate) struct DecodedWriteFileMessage<'a> {
    path: &'a str,
    content: &'a [u8],
    use_sudo: bool,
    append: bool,
    private: bool,
}

pub(crate) struct DecodedWriteFilesMessage<'a> {
    payload: &'a [u8],
    file_count: usize,
    content_bytes: usize,
}

/// Handle write_file message
fn handle_write_file(
    path: &str,
    content: &[u8],
    use_sudo: bool,
    append: bool,
    private: bool,
    connection_cancel: &AtomicBool,
    progress: &FileWriteRequestProgress,
) -> (bool, String) {
    progress.mark(FileWriteStage::StartingHelper);
    log(
        "INFO",
        &format!(
            "write_file: path={} size={} sudo={} append={} private={}",
            path,
            content.len(),
            use_sudo,
            append,
            private,
        ),
    );

    let child = match spawn_write_file_command(path, use_sudo, append, private) {
        Ok(c) => c,
        Err(e) => return (false, format!("Failed to spawn write command: {e}")),
    };

    wait_write_file_child(
        child,
        content,
        connection_cancel,
        progress,
        SystemThreadSpawner,
    )
}

fn handle_write_files(
    payload: &[u8],
    file_count: usize,
    content_bytes: usize,
    private: bool,
    connection_cancel: &AtomicBool,
    progress: &FileWriteRequestProgress,
) -> (bool, String) {
    progress.mark(FileWriteStage::StartingHelper);
    let operation = if private {
        "write_private_files"
    } else {
        "write_files"
    };
    log(
        "INFO",
        &format!("{operation}: files={file_count} content_bytes={content_bytes}"),
    );

    let child = match spawn_write_files_command(private) {
        Ok(c) => c,
        Err(e) => return (false, format!("Failed to spawn batch write command: {e}")),
    };

    wait_write_file_child(
        child,
        payload,
        connection_cancel,
        progress,
        SystemThreadSpawner,
    )
}

fn wait_write_file_child<S>(
    child: Child,
    content: &[u8],
    connection_cancel: &AtomicBool,
    progress: &FileWriteRequestProgress,
    spawner: S,
) -> (bool, String)
where
    S: ThreadSpawner,
{
    wait_write_file_child_with_timeout(
        child,
        content,
        WRITE_FILE_HELPER_TIMEOUT_MS,
        connection_cancel,
        progress,
        spawner,
    )
}

fn wait_write_file_child_with_timeout<S>(
    child: Child,
    content: &[u8],
    timeout_ms: u32,
    connection_cancel: &AtomicBool,
    progress: &FileWriteRequestProgress,
    spawner: S,
) -> (bool, String)
where
    S: ThreadSpawner,
{
    wait_write_input(
        child,
        move |mut stdin| stdin.write_all(content),
        timeout_ms,
        connection_cancel,
        progress,
        spawner,
        None,
    )
}

fn wait_write_input<S: ThreadSpawner>(
    mut child: Child,
    copy_input: impl FnOnce(ChildStdin) -> io::Result<()> + Send,
    timeout_ms: u32,
    connection_cancel: &AtomicBool,
    progress: &FileWriteRequestProgress,
    spawner: S,
    input_cancel: Option<Arc<AtomicBool>>,
) -> (bool, String) {
    progress.mark(FileWriteStage::WaitingForHelper);
    let cancel = match DrainCancellation::new() {
        Ok(cancel) => Arc::new(cancel),
        Err(error) => {
            kill_and_reap_child(child);
            return (
                false,
                format!("Failed to initialize stderr drain cancellation: {error}"),
            );
        }
    };
    let stdin_pipe = match child.stdin.take() {
        Some(p) => p,
        None => {
            kill_and_reap_child(child);
            return (false, "missing stdin pipe".to_string());
        }
    };
    // Drain stderr concurrently with wait via the cancellable helper. Stdout
    // is `Stdio::null()` so there's no orphan-fd hazard there. Stdin is also
    // written from a helper thread so a child that stalls before reading stdin
    // cannot block the connection loop before timeout enforcement starts.
    // After the child exits, the drain thread either reaches EOF naturally or
    // — if a grandchild somehow still holds stderr — is cut at the deadline so
    // its last write returns EPIPE.
    // Defensive: same invariant as the shared drain helper — reap the child if
    // its stderr is somehow already gone, so we don't leave a zombie.
    let stderr_pipe = match child.stderr.take() {
        Some(p) => p,
        None => {
            kill_and_reap_child(child);
            return (false, "missing stderr pipe".to_string());
        }
    };
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let stderr_handle = {
        let drain_cancel = cancel.clone();
        match spawner.spawn_vec(
            THREAD_WRITE_STDERR,
            Box::new(move || {
                let buf = drain_into_vec_cancellable(stderr_pipe, &drain_cancel);
                let _ = done_tx.send(());
                buf
            }),
        ) {
            Ok(handle) => handle,
            Err(e) => {
                cancel.cancel();
                drop(stdin_pipe);
                kill_and_reap_child(child);
                return (false, format!("Failed to spawn stderr drain thread: {e}"));
            }
        }
    };

    std::thread::scope(|scope| {
        let (stdin_done_tx, stdin_done_rx) = std::sync::mpsc::channel::<()>();
        let stdin_handle = match spawn_scoped_named(scope, THREAD_WRITE_STDIN, move || {
            let result = copy_input(stdin_pipe);
            let _ = stdin_done_tx.send(());
            result
        }) {
            Ok(handle) => handle,
            Err(e) => {
                cancel.cancel();
                kill_and_reap_child(child);
                let _ = await_drain_deadline(&done_rx, 1, &cancel, EXEC_OUTPUT_DRAIN_DEADLINE);
                let _ = stderr_handle.join();
                return (false, format!("Failed to spawn stdin writer thread: {e}"));
            }
        };

        let outcome = wait_with_kill_timeout_or_connection_cancelled(
            child,
            timeout_ms,
            connection_cancel,
            || {
                matches!(
                    stdin_done_rx.try_recv(),
                    Err(std::sync::mpsc::TryRecvError::Empty)
                )
            },
        );
        progress.mark(FileWriteStage::JoiningStdin);
        if let Some(stop) = input_cancel {
            stop.store(true, std::sync::atomic::Ordering::Release);
        }
        let stdin_result = match stdin_handle.join() {
            Ok(result) => result,
            Err(panic) => std::panic::resume_unwind(panic),
        };

        progress.mark(FileWriteStage::DrainingStderr);
        let _ = await_drain_deadline(&done_rx, 1, &cancel, EXEC_OUTPUT_DRAIN_DEADLINE);
        let stderr = stderr_handle.join().unwrap_or_default();

        match outcome {
            WaitOutcome::TimedOut => (false, "write timed out".to_string()),
            WaitOutcome::Cancelled => (false, "write cancelled".to_string()),
            WaitOutcome::WaitFailed(msg) => (false, format!("write wait failed: {msg}")),
            WaitOutcome::Exited(s) => {
                let exit_code = extract_exit_code(s);
                if exit_code != 0 {
                    let stderr_str = String::from_utf8_lossy(&stderr);
                    return (false, format!("write failed: {stderr_str}"));
                }
                if let Err(e) = stdin_result {
                    return (false, format!("Failed to write to stdin: {e}"));
                }
                (true, String::new())
            }
        }
    })
}

fn write_file_command_args(
    use_sudo: bool,
    append: bool,
    private: bool,
) -> io::Result<Vec<&'static str>> {
    if private && use_sudo {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "private write_file cannot use sudo",
        ));
    }

    let mut args = Vec::new();
    if private {
        args.push("--private");
    }
    if append {
        args.push("--append");
    } else if !use_sudo && !private {
        args.push("--create-parents");
    }
    Ok(args)
}

fn spawn_write_file_command(
    path: &str,
    use_sudo: bool,
    append: bool,
    private: bool,
) -> io::Result<Child> {
    let mut command = Command::new(guest_write_file_path());
    for arg in write_file_command_args(use_sudo, append, private)? {
        command.arg(arg);
    }
    command
        .arg("--")
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    apply_command_identity(&mut command, use_sudo)?;
    spawn_in_own_process_group(&mut command)
}

fn spawn_write_files_command(private: bool) -> io::Result<Child> {
    let mut command = Command::new(guest_write_file_path());
    command.arg("--batch");
    if private {
        command.arg("--private");
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    apply_command_identity(&mut command, false)?;
    spawn_in_own_process_group(&mut command)
}

pub(crate) fn handle_file_stream(
    seq: u32,
    payload: &[u8],
    mut input: crate::file_stream::Input,
    connection_cancel: &AtomicBool,
    progress: &FileWriteRequestProgress,
) -> io::Result<Vec<u8>> {
    let (size, path, sudo, append) =
        crate::file_stream::decode_begin(payload).map_err(to_io_error)?;
    progress.mark(FileWriteStage::StartingHelper);
    let mut command = Command::new(guest_write_file_path());
    command.args(["--zstd", &size.to_string()]);
    command.args(write_file_command_args(sudo, append, false)?);
    command
        .arg("--")
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    apply_command_identity(&mut command, sudo)?;
    let child = spawn_in_own_process_group(&mut command)?;
    if let Err(error) = input.grant_initial() {
        kill_and_reap_child(child);
        return Err(error);
    }
    let stop = Arc::clone(&input.stop);
    let (success, error) = wait_write_input(
        child,
        move |mut stdin| io::copy(&mut input, &mut stdin).map(|_| ()),
        WRITE_FILE_HELPER_TIMEOUT_MS,
        connection_cancel,
        progress,
        SystemThreadSpawner,
        Some(stop),
    );
    let payload = guest_control_proto::encode_write_file_result(success, &error);
    guest_control_proto::encode(MSG_WRITE_FILE_RESULT, seq, &payload).map_err(to_io_error)
}

fn guest_write_file_path() -> PathBuf {
    #[cfg(any(debug_assertions, feature = "test-support"))]
    {
        DEBUG_GUEST_WRITE_FILE_PATH
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .unwrap_or_else(|| PathBuf::from(guest_contracts::guest_binary::WRITE_FILE_PATH))
    }

    #[cfg(not(any(debug_assertions, feature = "test-support")))]
    {
        PathBuf::from(guest_contracts::guest_binary::WRITE_FILE_PATH)
    }
}

#[cfg(any(debug_assertions, feature = "test-support"))]
pub(crate) fn set_debug_guest_write_file_path(path: PathBuf) {
    *DEBUG_GUEST_WRITE_FILE_PATH
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(path);
}

pub(crate) fn decode_write_file_message(
    payload: &[u8],
) -> Result<DecodedWriteFileMessage<'_>, guest_control_proto::ProtocolError> {
    let (path, content, use_sudo, append, private) =
        guest_control_proto::decode_write_file(payload)?;
    Ok(DecodedWriteFileMessage {
        path,
        content,
        use_sudo,
        append,
        private,
    })
}

pub(crate) fn decode_write_files_message(
    payload: &[u8],
) -> Result<DecodedWriteFilesMessage<'_>, guest_control_proto::ProtocolError> {
    let files = guest_control_proto::decode_write_files(payload)?;
    let content_bytes = files.iter().map(|file| file.content.len()).sum();
    Ok(DecodedWriteFilesMessage {
        payload,
        file_count: files.len(),
        content_bytes,
    })
}

pub(crate) fn handle_decoded_write_file_message(
    seq: u32,
    decoded: DecodedWriteFileMessage<'_>,
    connection_cancel: &AtomicBool,
    progress: &FileWriteRequestProgress,
) -> io::Result<Vec<u8>> {
    let (success, error) = handle_write_file(
        decoded.path,
        decoded.content,
        decoded.use_sudo,
        decoded.append,
        decoded.private,
        connection_cancel,
        progress,
    );
    let payload = guest_control_proto::encode_write_file_result(success, &error);
    guest_control_proto::encode(MSG_WRITE_FILE_RESULT, seq, &payload).map_err(to_io_error)
}

pub(crate) fn handle_decoded_write_files_message(
    seq: u32,
    decoded: DecodedWriteFilesMessage<'_>,
    private: bool,
    connection_cancel: &AtomicBool,
    progress: &FileWriteRequestProgress,
) -> io::Result<Vec<u8>> {
    let (success, error) = handle_write_files(
        decoded.payload,
        decoded.file_count,
        decoded.content_bytes,
        private,
        connection_cancel,
        progress,
    );
    let payload = guest_control_proto::encode_write_files_result(success, &error);
    guest_control_proto::encode(MSG_WRITE_FILES_RESULT, seq, &payload).map_err(to_io_error)
}

/// Handle basic incoming messages and return the connection-loop outcome.
///
/// Exec operation and guarded write-file operations are handled separately by
/// the connection dispatcher.
pub(crate) fn handle_basic_message(msg: BorrowedRawMessage<'_>) -> io::Result<MessageOutcome> {
    log(
        "INFO",
        &format!("Received: type=0x{:02X} seq={}", msg.msg_type, msg.seq),
    );

    match msg.msg_type {
        MSG_PING => Ok(MessageOutcome::Response(
            guest_control_proto::encode(MSG_PONG, msg.seq, &[]).map_err(to_io_error)?,
        )),
        MSG_SHUTDOWN => {
            if let Err(error) = guest_control_proto::decode_empty_payload(
                "shutdown payload must be empty",
                msg.payload,
            ) {
                return encode_error_response(msg.seq, &error.to_string());
            }
            Ok(MessageOutcome::Shutdown(handle_shutdown(msg.seq)?))
        }
        _ => encode_error_response(
            msg.seq,
            &format!("Unknown message type: 0x{:02X}", msg.msg_type),
        ),
    }
}

fn encode_error_response(seq: u32, message: &str) -> io::Result<MessageOutcome> {
    let payload = guest_control_proto::encode_error(message);
    Ok(MessageOutcome::Response(
        guest_control_proto::encode(MSG_ERROR, seq, &payload).map_err(to_io_error)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    use std::io::{BufRead, BufReader};
    #[cfg(target_os = "linux")]
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[cfg(target_os = "linux")]
    use crate::test_support::{kill_pidfd_and_wait, open_pidfd, wait_for_pidfd_exit};
    use crate::threading::test_support::FailingThreadSpawner;
    use std::sync::Mutex;

    static WRITE_FILE_CHILD_TESTS: Mutex<()> = Mutex::new(());

    fn spawn_write_file_test_child(script: &str) -> Child {
        // Use a stable shell binary instead of a freshly written temp
        // executable; some CI filesystems can transiently reject immediate exec
        // of a just-created file with ETXTBSY.
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        spawn_in_own_process_group(&mut command).unwrap()
    }

    fn pid_alive(pid: u32) -> bool {
        // SAFETY: kill(pid, 0) is the standard process-existence check.
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    #[cfg(unix)]
    #[test]
    fn write_file_child_starts_as_process_group_leader() {
        let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
        let child = spawn_write_file_test_child("sleep 60");
        let pid = child.id();

        let pgid = unsafe { libc::getpgid(pid as libc::pid_t) };
        kill_and_reap_child(child);

        assert_eq!(pgid, pid as libc::pid_t);
    }

    #[test]
    fn write_file_stderr_drain_spawn_failure_kills_and_reaps_child() {
        let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
        let child = spawn_write_file_test_child("sleep 60");
        let pid = child.id();
        let connection_cancel = AtomicBool::new(false);

        let (success, error) = wait_write_file_child(
            child,
            b"",
            &connection_cancel,
            &crate::file_write_progress::FileWriteProgress::default().start(1),
            FailingThreadSpawner::fail_once(THREAD_WRITE_STDERR),
        );

        assert!(!success);
        assert!(error.contains("stderr drain thread"));
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
    }

    #[test]
    fn write_file_command_args_use_private_mode_without_create_parents() {
        let args = write_file_command_args(false, false, true).unwrap();

        assert_eq!(args, vec!["--private"]);
    }

    #[test]
    fn write_file_command_args_use_private_append_mode() {
        let args = write_file_command_args(false, true, true).unwrap();

        assert_eq!(args, vec!["--private", "--append"]);
    }

    #[test]
    fn write_file_command_args_reject_private_sudo() {
        let error = write_file_command_args(true, false, true).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn write_file_timeout_kills_child_while_stdin_writer_is_blocked() {
        let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
        let child = spawn_write_file_test_child("sleep 60; cat >/dev/null");
        let pid = child.id();
        let content = vec![b'x'; 1024 * 1024];
        let connection_cancel = AtomicBool::new(false);

        let (success, error) = wait_write_file_child_with_timeout(
            child,
            &content,
            10,
            &connection_cancel,
            &crate::file_write_progress::FileWriteProgress::default().start(1),
            SystemThreadSpawner,
        );

        assert!(!success);
        assert_eq!(error, "write timed out");
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn write_file_kills_lingering_process_group_after_parent_exit() {
        let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
        let fifo_path = std::env::temp_dir().join(format!(
            "guest-control-write-file-stdin-{}-{}.fifo",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(
                "mkfifo \"$FIFO\"; \
                 exec 3<&0; \
                 sleep 60 <&3 >/dev/null 2>/dev/null & \
                 printf '%s\\n' \"$!\"; \
                 exec 3<&-; \
                 read _ < \"$FIFO\"; \
                 rm -f \"$FIFO\"; \
                 exit 0",
            )
            .env("FIFO", &fifo_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = spawn_in_own_process_group(&mut command).unwrap();
        let pid = child.id();
        let stdout = child.stdout.take().unwrap();
        let mut descendant_pid = String::new();
        BufReader::new(stdout)
            .read_line(&mut descendant_pid)
            .unwrap();
        let descendant_pid = descendant_pid.trim().parse::<libc::pid_t>().unwrap();
        let descendant_pidfd = open_pidfd(descendant_pid).unwrap();
        let mut fifo = std::fs::OpenOptions::new()
            .write(true)
            .open(&fifo_path)
            .unwrap();
        writeln!(fifo, "exit").unwrap();
        drop(fifo);
        let content = vec![b'x'; 1024 * 1024];
        let connection_cancel = AtomicBool::new(false);

        let (success, error) = wait_write_file_child_with_timeout(
            child,
            &content,
            1_000,
            &connection_cancel,
            &crate::file_write_progress::FileWriteProgress::default().start(1),
            SystemThreadSpawner,
        );
        let _ = std::fs::remove_file(&fifo_path);

        assert!(!success);
        assert!(error.contains("Failed to write to stdin"), "got: {error}");
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
        match wait_for_pidfd_exit(&descendant_pidfd, Duration::from_secs(2)) {
            Ok(true) => {}
            Ok(false) => {
                kill_pidfd_and_wait(&descendant_pidfd).unwrap_or_else(|cleanup| {
                    panic!(
                        "failed to clean up lingering descendant pid {descendant_pid}: {cleanup}"
                    )
                });
                panic!("lingering descendant pid {descendant_pid} should be terminated");
            }
            Err(error) => {
                let cleanup = kill_pidfd_and_wait(&descendant_pidfd);
                panic!(
                    "failed to wait for lingering descendant pid {descendant_pid}: {error}; cleanup={cleanup:?}"
                );
            }
        }
    }
}
