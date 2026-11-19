use std::fs::File;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
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
    stats: WriteFilesStats,
}

pub(crate) struct WriteFilesStats {
    file_count: usize,
    content_bytes: usize,
}

enum BatchInput<'a> {
    Buffered(&'a [u8]),
    #[cfg(target_os = "linux")]
    Sealed(File),
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
    input: BatchInput<'_>,
    stats: WriteFilesStats,
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
    let WriteFilesStats {
        file_count,
        content_bytes,
    } = stats;
    log(
        "INFO",
        &format!("{operation}: files={file_count} content_bytes={content_bytes}"),
    );

    let payload = match input {
        BatchInput::Buffered(payload) => payload,
        #[cfg(target_os = "linux")]
        BatchInput::Sealed(input) => {
            return run_sealed_batch(input, batch_deadline(), connection_cancel, progress);
        }
    };

    let child = match spawn_write_files_command(private, None) {
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

#[cfg(target_os = "linux")]
pub(crate) fn create_batch_input() -> io::Result<File> {
    use rustix::fs::{MemfdFlags, memfd_create};

    let flags = MemfdFlags::CLOEXEC | MemfdFlags::ALLOW_SEALING | MemfdFlags::NOEXEC_SEAL;
    Ok(File::from(memfd_create(c"guest-write-files", flags)?))
}

#[cfg(target_os = "linux")]
fn seal_batch_input(file: &File) -> io::Result<()> {
    use rustix::fs::{SealFlags, fcntl_add_seals};

    let seals = SealFlags::WRITE | SealFlags::SHRINK | SealFlags::GROW | SealFlags::SEAL;
    Ok(fcntl_add_seals(file, seals)?)
}

#[cfg(target_os = "linux")]
fn batch_deadline() -> std::time::Instant {
    use std::time::{Duration, Instant};

    Instant::now() + Duration::from_millis(u64::from(WRITE_FILE_HELPER_TIMEOUT_MS))
}

#[cfg(target_os = "linux")]
fn check_sealed_write(
    connection_cancel: &AtomicBool,
    deadline: std::time::Instant,
) -> Result<(), &'static str> {
    use std::sync::atomic::Ordering;
    use std::time::Instant;

    if connection_cancel.load(Ordering::Acquire) {
        Err("write cancelled")
    } else if Instant::now() >= deadline {
        Err("write timed out")
    } else {
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn run_sealed_batch(
    file: File,
    deadline: std::time::Instant,
    connection_cancel: &AtomicBool,
    progress: &FileWriteRequestProgress,
) -> (bool, String) {
    if let Err(error) = check_sealed_write(connection_cancel, deadline) {
        return (false, error.to_string());
    }
    let child = match spawn_write_files_command(false, Some(file)) {
        Ok(child) => child,
        Err(error) => {
            return (
                false,
                format!("Failed to spawn batch write command: {error}"),
            );
        }
    };
    if let Err(error) = check_sealed_write(connection_cancel, deadline) {
        kill_and_reap_child(child);
        return (false, error.to_string());
    }
    let remaining = deadline
        .saturating_duration_since(std::time::Instant::now())
        .as_millis();
    let timeout_ms = u32::try_from(remaining)
        .unwrap_or(WRITE_FILE_HELPER_TIMEOUT_MS)
        .max(1);
    wait_write_file_child_with_timeout(
        child,
        None,
        timeout_ms,
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
        Some(content),
        WRITE_FILE_HELPER_TIMEOUT_MS,
        connection_cancel,
        progress,
        spawner,
    )
}

fn wait_write_file_child_with_timeout<S: ThreadSpawner>(
    mut child: Child,
    pipe_content: Option<&[u8]>,
    timeout_ms: u32,
    connection_cancel: &AtomicBool,
    progress: &FileWriteRequestProgress,
    spawner: S,
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
    let pipe_input = match pipe_content {
        Some(content) => match child.stdin.take() {
            Some(pipe) => Some((pipe, content)),
            None => {
                kill_and_reap_child(child);
                return (false, "missing stdin pipe".to_string());
            }
        },
        None => None,
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
        match spawner.spawn(
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
                drop(pipe_input);
                kill_and_reap_child(child);
                return (false, format!("Failed to spawn stderr drain thread: {e}"));
            }
        }
    };

    std::thread::scope(|scope| {
        let (stdin_done_tx, stdin_done_rx) = std::sync::mpsc::channel::<()>();
        let stdin_handle = if let Some((mut pipe, content)) = pipe_input {
            match spawn_scoped_named(scope, THREAD_WRITE_STDIN, move || {
                let result = pipe.write_all(content);
                let _ = stdin_done_tx.send(());
                result
            }) {
                Ok(handle) => Some(handle),
                Err(e) => {
                    cancel.cancel();
                    kill_and_reap_child(child);
                    let _ = await_drain_deadline(&done_rx, 1, &cancel, EXEC_OUTPUT_DRAIN_DEADLINE);
                    let _ = stderr_handle.join();
                    return (false, format!("Failed to spawn stdin writer thread: {e}"));
                }
            }
        } else {
            None
        };

        let outcome = wait_with_kill_timeout_or_connection_cancelled(
            child,
            timeout_ms,
            connection_cancel,
            || {
                stdin_handle.is_some()
                    && matches!(
                        stdin_done_rx.try_recv(),
                        Err(std::sync::mpsc::TryRecvError::Empty)
                    )
            },
        );
        let stdin_result = stdin_handle.map_or(Ok(()), |handle| {
            progress.mark(FileWriteStage::JoiningStdin);
            handle
                .join()
                .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
        });

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

fn spawn_write_files_command(private: bool, sealed_input: Option<File>) -> io::Result<Child> {
    let mut command = Command::new(guest_write_file_path());
    if let Some(file) = sealed_input {
        command.arg("--sealed-batch").stdin(Stdio::from(file));
    } else {
        command.arg("--batch").stdin(Stdio::piped());
        if private {
            command.arg("--private");
        }
    }
    command.stdout(Stdio::null()).stderr(Stdio::piped());
    apply_command_identity(&mut command, false)?;
    spawn_in_own_process_group(&mut command)
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
        stats: WriteFilesStats {
            file_count: files.len(),
            content_bytes,
        },
    })
}

#[cfg(target_os = "linux")]
pub(crate) fn seal_and_validate_batch_input(file: &File) -> io::Result<WriteFilesStats> {
    use std::os::fd::AsFd;

    use guest_contracts::file_write::sealed_input::SealedInput;
    use guest_control_proto::{MAX_MESSAGE_SIZE, MIN_BODY_SIZE};

    seal_batch_input(file)?;
    let mapping = SealedInput::map(file.as_fd(), MAX_MESSAGE_SIZE - MIN_BODY_SIZE)?;
    decode_write_files_message(mapping.as_bytes())
        .map(|decoded| decoded.stats)
        .map_err(to_io_error)
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
    handle_batch_input(
        seq,
        BatchInput::Buffered(decoded.payload),
        decoded.stats,
        private,
        connection_cancel,
        progress,
    )
}

#[cfg(target_os = "linux")]
pub(crate) fn handle_sealed_write_files_message(
    seq: u32,
    file: File,
    stats: WriteFilesStats,
    connection_cancel: &AtomicBool,
    progress: &FileWriteRequestProgress,
) -> io::Result<Vec<u8>> {
    handle_batch_input(
        seq,
        BatchInput::Sealed(file),
        stats,
        false,
        connection_cancel,
        progress,
    )
}

fn handle_batch_input(
    seq: u32,
    input: BatchInput<'_>,
    stats: WriteFilesStats,
    private: bool,
    connection_cancel: &AtomicBool,
    progress: &FileWriteRequestProgress,
) -> io::Result<Vec<u8>> {
    let (success, error) = handle_write_files(input, stats, private, connection_cancel, progress);
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
mod tests;
