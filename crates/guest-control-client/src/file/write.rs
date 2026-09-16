use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;
use std::{fmt, io};

use guest_contracts::file_write::WRITE_FILE_REQUEST_DEADLINE;
use guest_control_proto::{
    ExecTermination, MSG_ERROR, MSG_WRITE_FILE_RESULT, MSG_WRITE_FILES_RESULT,
};
use shell_quote::quote_shell_arg;

use crate::{
    CompositeNormalOperation, ExecCaptureRequest, ExecOperationResult, ExecOwnedCapturedOutput,
    FrameWriteObserver, GuestControlClient, RequestTimeoutError, RequestTimeoutStage, Shared,
    exec_operation, exec_operation::ExecOperationWaitOutcome,
    normal_request_on_shared_with_write_observer_frame_builder,
    request_on_shared_with_composite_operation_and_observer_frame_builder,
};

use super::{file_exec_exit_code, normalize_file_exec_stderr, validate_guest_file_path};

/// Maximum content per write_file message. Leaves headroom below
/// [`guest_control_proto::MAX_MESSAGE_SIZE`] for the path and frame overhead.
pub(super) const WRITE_FILE_CHUNK_LIMIT: usize = 15 * 1024 * 1024;
const WRITE_FILE_TERMINAL_MSG_TYPES: &[u8] = &[MSG_ERROR, MSG_WRITE_FILE_RESULT];
const WRITE_FILES_TERMINAL_MSG_TYPES: &[u8] = &[MSG_ERROR, MSG_WRITE_FILES_RESULT];

/// Maximum number of files in one write_files request.
pub const WRITE_FILES_BATCH_FILE_LIMIT: usize = 64;

/// Maximum total file content bytes in one write_files request.
pub const WRITE_FILES_BATCH_CONTENT_LIMIT: usize = WRITE_FILE_CHUNK_LIMIT;

/// Timeout (ms) for short helper commands (mv, rm) used during chunked writes.
const HELPER_EXEC_TIMEOUT_MS: u32 = 5000;

/// Shorter timeout (ms) for best-effort cleanup when the connection may
/// already be broken. Avoids blocking for a full 5 s on a dead socket.
const CLEANUP_EXEC_TIMEOUT_MS: u32 = 1000;

enum WriteFileChunkTracking<'a> {
    Tracked,
    Composite(&'a mut CompositeNormalOperation),
}

#[derive(Clone, Copy)]
struct WriteFileChunkRequest<'a> {
    path: &'a str,
    content: &'a [u8],
    sudo: bool,
    append: bool,
    private: bool,
}

impl<'a> WriteFileChunkRequest<'a> {
    fn standard(path: &'a str, content: &'a [u8], sudo: bool, append: bool) -> Self {
        Self {
            path,
            content,
            sudo,
            append,
            private: false,
        }
    }

    fn private(path: &'a str, content: &'a [u8], append: bool) -> Self {
        Self {
            path,
            content,
            sudo: false,
            append,
            private: true,
        }
    }
}

/// One guest file entry for [`GuestControlClient::write_files`] or
/// [`GuestControlClient::write_private_files`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WriteFileEntry<'a> {
    /// Guest path to create or replace.
    pub path: &'a str,
    /// Bytes to write to the guest path.
    pub content: &'a [u8],
}

#[derive(Clone, Copy)]
enum WriteFilesMode {
    Ordinary,
    Private,
}

impl WriteFilesMode {
    const fn operation_name(self) -> &'static str {
        match self {
            Self::Ordinary => "write_files",
            Self::Private => "write_private_files",
        }
    }

    fn encode_frame(
        self,
        frame: &mut Vec<u8>,
        seq: u32,
        files: &[guest_control_proto::WriteFileBatchEntry<'_>],
    ) -> Result<(), guest_control_proto::ProtocolError> {
        match self {
            Self::Ordinary => guest_control_proto::encode_write_files_frame_into(frame, seq, files),
            Self::Private => {
                guest_control_proto::encode_private_write_files_frame_into(frame, seq, files)
            }
        }
    }
}

struct ValidatedWriteFiles<'a> {
    proto_entries: Vec<guest_control_proto::WriteFileBatchEntry<'a>>,
    total_content_len: usize,
}

#[derive(Debug)]
struct WriteFileGuestError(String);

impl fmt::Display for WriteFileGuestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for WriteFileGuestError {}

fn write_file_guest_error(message: impl Into<String>) -> io::Error {
    io::Error::other(WriteFileGuestError(message.into()))
}

fn protocol_invalid_input(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, error.to_string())
}

fn error_is_write_file_guest_error(error: &io::Error) -> bool {
    error
        .get_ref()
        .is_some_and(|error| error.is::<WriteFileGuestError>())
}

struct ChunkedWriteCleanupGuard {
    shared: Option<Arc<Shared>>,
    command: String,
    sudo: bool,
    write_observer: FrameWriteObserver,
    cleanup_armed: Arc<AtomicBool>,
}

impl ChunkedWriteCleanupGuard {
    fn new(
        shared: Arc<Shared>,
        command: String,
        sudo: bool,
        write_observer: FrameWriteObserver,
        cleanup_armed: Arc<AtomicBool>,
    ) -> Self {
        Self {
            shared: Some(shared),
            command,
            sudo,
            write_observer,
            cleanup_armed,
        }
    }

    fn disarm(&mut self) {
        self.shared = None;
    }

    async fn cleanup_now(
        &mut self,
        normal_operation: &mut CompositeNormalOperation,
    ) -> io::Result<()> {
        if !self.cleanup_armed.load(Ordering::Acquire) {
            self.disarm();
            return Ok(());
        }

        let result = if let Some(shared) = self.shared.as_ref() {
            cleanup_outcome_timeout(
                exec_operation::exec_operation_cleanup_with_composite_on_shared_and_observer(
                    shared,
                    &self.command,
                    CLEANUP_EXEC_TIMEOUT_MS,
                    &[],
                    self.sudo,
                    normal_operation,
                    self.write_observer.clone(),
                ),
                CLEANUP_EXEC_TIMEOUT_MS,
            )
            .await
            .and_then(validate_cleanup_result)
            .into_result()
        } else {
            Ok(())
        };
        if result.is_ok() {
            self.disarm();
        }
        result
    }
}

async fn cleanup_outcome_timeout<F>(
    cleanup: F,
    timeout_ms: u32,
) -> ExecOperationWaitOutcome<ExecOperationResult>
where
    F: Future<Output = ExecOperationWaitOutcome<ExecOperationResult>>,
{
    match tokio::time::timeout(Duration::from_millis(timeout_ms as u64), cleanup).await {
        Ok(outcome) => outcome,
        Err(_) => ExecOperationWaitOutcome::unproven(io::Error::new(
            io::ErrorKind::TimedOut,
            "cleanup command timed out",
        )),
    }
}

async fn cleanup_timeout<F>(cleanup: F, timeout_ms: u32) -> io::Result<ExecOperationResult>
where
    F: Future<Output = io::Result<ExecOperationResult>>,
{
    tokio::time::timeout(Duration::from_millis(timeout_ms as u64), cleanup)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "cleanup command timed out"))?
}

fn write_helper_exec_output(
    context: &str,
    result: ExecOperationResult,
) -> io::Result<(ExecTermination, Vec<u8>, String)> {
    if result.stream_overflowed {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{context} exec operation unexpectedly overflowed a stream queue"),
        ));
    }

    let ExecOperationResult {
        termination,
        stdout,
        stderr,
        diagnostic,
        ..
    } = result;
    let _stdout = write_helper_exec_captured_output(context, "stdout", stdout)?;
    let (stderr, stderr_truncated) = write_helper_exec_captured_output(context, "stderr", stderr)?;

    Ok((
        termination,
        normalize_file_exec_stderr(stderr, stderr_truncated),
        diagnostic,
    ))
}

fn write_helper_exec_captured_output(
    context: &str,
    name: &str,
    output: ExecOwnedCapturedOutput,
) -> io::Result<(Vec<u8>, bool)> {
    match output {
        ExecOwnedCapturedOutput::Captured { bytes, truncated } => Ok((bytes, truncated)),
        ExecOwnedCapturedOutput::Discarded => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{context} exec result discarded {name} for capture request"),
        )),
    }
}

fn validate_cleanup_result(result: ExecOperationResult) -> io::Result<()> {
    let (termination, stderr, diagnostic) = write_helper_exec_output("cleanup command", result)?;
    match file_exec_exit_code(termination, "cleanup command", "", &stderr, &diagnostic)? {
        0 => Ok(()),
        exit_code => Err(io::Error::other(format!(
            "cleanup command failed with exit code {exit_code}: {}",
            String::from_utf8_lossy(&stderr)
        ))),
    }
}

fn validate_rename_result(path: &str, result: ExecOperationResult) -> io::Result<()> {
    let (termination, stderr, diagnostic) = write_helper_exec_output("rename command", result)?;
    match file_exec_exit_code(
        termination,
        "rename command",
        format_args!(" while moving temp file to {path}"),
        &stderr,
        &diagnostic,
    )? {
        0 => Ok(()),
        exit_code => Err(io::Error::other(format!(
            "failed to rename temp file to {path} with exit code {exit_code}: {}",
            String::from_utf8_lossy(&stderr)
        ))),
    }
}

impl Drop for ChunkedWriteCleanupGuard {
    fn drop(&mut self) {
        let Some(shared) = self.shared.take() else {
            return;
        };
        if !self.cleanup_armed.load(Ordering::Acquire) {
            return;
        }

        let command = std::mem::take(&mut self.command);
        let sudo = self.sudo;
        let write_observer = FrameWriteObserver::default();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = cleanup_timeout(
                    exec_operation::exec_operation_cleanup_untracked_on_shared_with_write_observer(
                        &shared,
                        &command,
                        CLEANUP_EXEC_TIMEOUT_MS,
                        &[],
                        sudo,
                        write_observer,
                    ),
                    CLEANUP_EXEC_TIMEOUT_MS,
                )
                .await;
            });
        }
    }
}

fn write_observer_that_arms_cleanup(
    write_observer: FrameWriteObserver,
    cleanup_armed: Arc<AtomicBool>,
) -> FrameWriteObserver {
    FrameWriteObserver::new(move || {
        write_observer.record_write_start()?;
        cleanup_armed.store(true, Ordering::Release);
        Ok(())
    })
}

impl GuestControlClient {
    /// Write a file on the guest.
    ///
    /// Content larger than 15 MB is automatically split into multiple
    /// messages using the `WRITE_FILE_FLAG_APPEND` protocol flag. Chunks are written
    /// to a temporary file and atomically renamed to the target path after
    /// the last chunk succeeds, so a partial transfer never leaves a
    /// truncated file at the destination.
    ///
    /// Non-sudo writes create missing parent directories on the guest.
    ///
    /// # Cancellation
    ///
    /// This contract applies to every public file-write future on [`GuestControlClient`]:
    /// this method, [`write_files`](Self::write_files),
    /// [`write_private_file`](Self::write_private_file),
    /// [`write_private_files`](Self::write_private_files),
    /// [`write_file_with_write_observer`](Self::write_file_with_write_observer),
    /// [`write_files_with_write_observer`](Self::write_files_with_write_observer),
    /// [`write_private_file_with_write_observer`](Self::write_private_file_with_write_observer),
    /// and [`write_private_files_with_write_observer`](Self::write_private_files_with_write_observer).
    ///
    /// Dropping one of these futures before any request frame starts writing
    /// sends no file-write request and leaves the connection reusable for later
    /// normal operations. Once a frame starts writing, cancellation cannot prove
    /// the guest-side file outcome or safe connection reuse. An interrupted frame
    /// write poisons the connection because the guest may have received a partial
    /// frame. If a complete frame was written but its terminal response is
    /// abandoned, the socket may remain open while later normal operations become
    /// unavailable. In either post-boundary case, discard the connection instead
    /// of reusing it or returning it to a pool.
    ///
    /// The methods without a [`FrameWriteObserver`] do not generally reveal which
    /// side of that boundary cancellation occurred on. Unless other
    /// synchronization proves that no frame started writing, callers must
    /// conservatively discard the connection after cancelling one of those
    /// futures.
    ///
    /// Cancelling a large standard write after staging begins attempts
    /// best-effort removal of its temporary file. Cleanup is not guaranteed and
    /// does not prove the destination outcome or restore connection reuse. A
    /// chunked private write modifies the final path directly, can leave partial
    /// content, and has no rollback cleanup. The effects of a cancelled
    /// [`write_files`](Self::write_files) or
    /// [`write_private_files`](Self::write_private_files) batch are likewise
    /// unproven once its frame starts writing.
    pub async fn write_file(&self, path: &str, content: &[u8], sudo: bool) -> io::Result<()> {
        self.write_file_with_write_observer(path, content, sudo, FrameWriteObserver::default())
            .await
    }

    /// Write multiple ordinary files on the guest in one request.
    ///
    /// Every file uses non-sudo create-parent and truncate semantics. Use
    /// [`write_private_file`](Self::write_private_file) for private runtime
    /// files and [`write_file`](Self::write_file) for sudo or individual writes
    /// that exceed the batch content limit. No public [`GuestControlClient`] write method
    /// exposes caller-requested append semantics. Empty batches are accepted as
    /// a no-op to match the higher-level sandbox trait default.
    ///
    /// Cancellation follows the
    /// [shared file-write cancellation contract](Self::write_file).
    pub async fn write_files(&self, files: &[WriteFileEntry<'_>]) -> io::Result<()> {
        self.write_files_with_write_observer(files, FrameWriteObserver::default())
            .await
    }

    /// Write multiple private runtime files on the guest.
    ///
    /// A fitting multi-entry request uses one private batch helper. Empty input
    /// is a no-op, one entry uses [`write_private_file`](Self::write_private_file),
    /// and aggregate content above the batch limit falls back to sequential
    /// private writes so existing chunking behavior is preserved.
    ///
    /// All paths and the entry-count bound are validated before any fallback
    /// write begins. A later failure can leave earlier entries complete, but
    /// the operation still returns an error.
    ///
    /// Cancellation follows the
    /// [shared file-write cancellation contract](Self::write_file).
    pub async fn write_private_files(&self, files: &[WriteFileEntry<'_>]) -> io::Result<()> {
        self.write_private_files_with_write_observer(files, FrameWriteObserver::default())
            .await
    }

    /// Write a private runtime file on the guest.
    ///
    /// Content larger than 15 MB is split into multiple messages. The first
    /// chunk creates or truncates the final file through private runtime-file
    /// semantics; later chunks append to the same file. A failed chunk leaves
    /// the run failed and may leave a partial private runtime file behind.
    ///
    /// Within one [`GuestControlClient`], a chunked private write excludes other writes
    /// whose destinations compare equal as [`std::path::Path`] values until
    /// the call finishes. This does not coordinate guest processes, other
    /// connections, hard links, or aliases that depend on guest filesystem
    /// state.
    ///
    /// Cancellation follows the
    /// [shared file-write cancellation contract](Self::write_file).
    pub async fn write_private_file(&self, path: &str, content: &[u8]) -> io::Result<()> {
        self.write_private_file_with_write_observer(path, content, FrameWriteObserver::default())
            .await
    }

    /// Write a private runtime file on the guest and report before each
    /// helper frame is written to the guest.
    ///
    /// This uses the destination-isolation semantics documented on
    /// [`write_private_file`](Self::write_private_file).
    ///
    /// Cancellation follows the
    /// [shared file-write cancellation contract](Self::write_file); the observer
    /// reports the frame-write boundary described there.
    pub async fn write_private_file_with_write_observer(
        &self,
        path: &str,
        content: &[u8],
        write_observer: FrameWriteObserver,
    ) -> io::Result<()> {
        self.write_private_file_with_write_observer_and_chunk_limit(
            path,
            content,
            write_observer,
            WRITE_FILE_CHUNK_LIMIT,
        )
        .await
    }

    pub(super) async fn write_private_file_with_write_observer_and_chunk_limit(
        &self,
        path: &str,
        content: &[u8],
        write_observer: FrameWriteObserver,
        chunk_limit: usize,
    ) -> io::Result<()> {
        validate_guest_file_path(path)?;
        if content.len() <= chunk_limit {
            let request = WriteFileChunkRequest::private(path, content, false);
            validate_write_file_chunk_request(request)?;
            let _path_guard = self.file_write_path_locks.acquire_shared(path).await;
            return self
                .write_file_chunk(request, WriteFileChunkTracking::Tracked, write_observer)
                .await;
        }

        for (i, chunk) in content.chunks(chunk_limit).enumerate() {
            validate_write_file_chunk_request(WriteFileChunkRequest::private(path, chunk, i > 0))?;
        }
        let _path_guard = self.file_write_path_locks.acquire_exclusive(path).await;
        let mut normal_operation = CompositeNormalOperation::reserve(&self.shared)?;
        let result = async {
            for (i, chunk) in content.chunks(chunk_limit).enumerate() {
                self.write_file_chunk(
                    WriteFileChunkRequest::private(path, chunk, i > 0),
                    WriteFileChunkTracking::Composite(&mut normal_operation),
                    write_observer.clone(),
                )
                .await?;
            }
            io::Result::Ok(())
        }
        .await;

        if let Err(error) = result {
            if error_is_write_file_guest_error(&error) {
                normal_operation.complete()?;
            }
            return Err(error);
        }

        normal_operation.complete()
    }

    /// Write a file on the guest and report before each helper frame is
    /// written to the guest.
    ///
    /// Cancellation follows the
    /// [shared file-write cancellation contract](Self::write_file); the observer
    /// reports the frame-write boundary described there.
    pub async fn write_file_with_write_observer(
        &self,
        path: &str,
        content: &[u8],
        sudo: bool,
        write_observer: FrameWriteObserver,
    ) -> io::Result<()> {
        self.write_file_with_write_observer_and_chunk_limit(
            path,
            content,
            sudo,
            write_observer,
            WRITE_FILE_CHUNK_LIMIT,
        )
        .await
    }

    pub(super) async fn write_file_with_write_observer_and_chunk_limit(
        &self,
        path: &str,
        content: &[u8],
        sudo: bool,
        write_observer: FrameWriteObserver,
        chunk_limit: usize,
    ) -> io::Result<()> {
        validate_guest_file_path(path)?;
        if content.len() <= chunk_limit {
            let request = WriteFileChunkRequest::standard(path, content, sudo, false);
            validate_write_file_chunk_request(request)?;
            let _path_guard = self.file_write_path_locks.acquire_shared(path).await;
            return self
                .write_file_chunk(request, WriteFileChunkTracking::Tracked, write_observer)
                .await;
        }

        validate_write_file_chunk_request(WriteFileChunkRequest::standard(path, &[], sudo, false))?;
        let _path_guard = self.file_write_path_locks.acquire_shared(path).await;
        let mut normal_operation = CompositeNormalOperation::reserve(&self.shared)?;

        // Write chunks to a bounded per-call sibling, then atomic rename. The UUID
        // prevents concurrent writes from sharing or cleaning up a staging file.
        let tmp_path = std::path::Path::new(path)
            .with_file_name(format!(".vm0tmp-{}", uuid::Uuid::new_v4().simple()));
        let tmp = tmp_path.to_string_lossy();
        let quoted_tmp = quote_shell_arg(&tmp);
        let rm_tmp = format!("rm -f -- {quoted_tmp}");
        let cleanup_armed = Arc::new(AtomicBool::new(false));
        let write_observer =
            write_observer_that_arms_cleanup(write_observer, Arc::clone(&cleanup_armed));
        let mut cleanup_guard = ChunkedWriteCleanupGuard::new(
            Arc::clone(&self.shared),
            rm_tmp,
            sudo,
            write_observer.clone(),
            cleanup_armed,
        );

        let result = async {
            for (i, chunk) in content.chunks(chunk_limit).enumerate() {
                self.write_file_chunk(
                    WriteFileChunkRequest::standard(&tmp, chunk, sudo, i > 0),
                    WriteFileChunkTracking::Composite(&mut normal_operation),
                    write_observer.clone(),
                )
                .await?;
            }
            io::Result::Ok(())
        }
        .await;

        if let Err(error) = result {
            // Best-effort cleanup of the temp file.
            let terminal_error = error_is_write_file_guest_error(&error);
            let cleanup_result = cleanup_guard.cleanup_now(&mut normal_operation).await;
            if terminal_error && cleanup_result.is_ok() {
                normal_operation.complete()?;
            }
            return Err(error);
        }

        // `-T` keeps directory targets from being treated as destination directories.
        let mv_cmd = format!("mv -fT -- {quoted_tmp} {}", quote_shell_arg(path));
        let rename_result =
            exec_operation::exec_operation_capture_with_composite_on_shared_and_observer(
                &self.shared,
                ExecCaptureRequest {
                    command: &mv_cmd,
                    timeout_ms: HELPER_EXEC_TIMEOUT_MS,
                    env: &[],
                    sudo,
                    label: "write-file-rename",
                    stdout_limit_bytes: exec_operation::SMALL_EXEC_CAPTURE_LIMIT_BYTES,
                    stderr_limit_bytes: exec_operation::SMALL_EXEC_CAPTURE_LIMIT_BYTES,
                    expected_exit_codes: &[],
                    stdin_bytes: None,
                    wait_timeout: Duration::from_millis(HELPER_EXEC_TIMEOUT_MS as u64 + 5000),
                },
                &mut normal_operation,
                write_observer,
            )
            .await
            .and_then(|result| validate_rename_result(path, result));
        match rename_result {
            ExecOperationWaitOutcome::Terminal(Ok(())) => {
                cleanup_guard.disarm();
                normal_operation.complete()?;
                Ok(())
            }
            ExecOperationWaitOutcome::Terminal(Err(error)) => {
                // Terminal proof only releases the tracker after cleanup also
                // succeeds; unproven helper failures remain fail-closed.
                let cleanup_result = cleanup_guard.cleanup_now(&mut normal_operation).await;
                if cleanup_result.is_ok() {
                    normal_operation.complete()?;
                }
                Err(error)
            }
            ExecOperationWaitOutcome::Unproven(error) => {
                let _ = cleanup_guard.cleanup_now(&mut normal_operation).await;
                Err(error)
            }
        }
    }

    /// Write multiple ordinary files on the guest and report before the batch
    /// frame is written.
    ///
    /// Cancellation follows the
    /// [shared file-write cancellation contract](Self::write_file); the observer
    /// reports the frame-write boundary described there.
    pub async fn write_files_with_write_observer(
        &self,
        files: &[WriteFileEntry<'_>],
        write_observer: FrameWriteObserver,
    ) -> io::Result<()> {
        if files.is_empty() {
            return Ok(());
        }
        let validated = validate_write_files(files, WriteFilesMode::Ordinary)?;
        if validated.total_content_len > WRITE_FILES_BATCH_CONTENT_LIMIT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "write_files batch contains {} content bytes, limit is {WRITE_FILES_BATCH_CONTENT_LIMIT}",
                    validated.total_content_len
                ),
            ));
        }
        self.write_validated_files_batch(
            files,
            validated.proto_entries,
            WriteFilesMode::Ordinary,
            write_observer,
        )
        .await
    }

    /// Write multiple private runtime files and report before each request
    /// frame is written.
    ///
    /// Cancellation follows the
    /// [shared file-write cancellation contract](Self::write_file); the observer
    /// reports the frame-write boundaries described there.
    pub async fn write_private_files_with_write_observer(
        &self,
        files: &[WriteFileEntry<'_>],
        write_observer: FrameWriteObserver,
    ) -> io::Result<()> {
        self.write_private_files_with_write_observer_and_limits(
            files,
            write_observer,
            WRITE_FILES_BATCH_CONTENT_LIMIT,
            WRITE_FILE_CHUNK_LIMIT,
        )
        .await
    }

    pub(super) async fn write_private_files_with_write_observer_and_limits(
        &self,
        files: &[WriteFileEntry<'_>],
        write_observer: FrameWriteObserver,
        batch_content_limit: usize,
        chunk_limit: usize,
    ) -> io::Result<()> {
        if files.is_empty() {
            return Ok(());
        }

        let validated = validate_write_files(files, WriteFilesMode::Private)?;
        let batch_fits_protocol =
            guest_control_proto::validate_write_files(&validated.proto_entries).is_ok();
        if files.len() == 1
            || validated.total_content_len > batch_content_limit
            || !batch_fits_protocol
        {
            for file in files {
                self.write_private_file_with_write_observer_and_chunk_limit(
                    file.path,
                    file.content,
                    write_observer.clone(),
                    chunk_limit,
                )
                .await?;
            }
            return Ok(());
        }

        self.write_validated_files_batch(
            files,
            validated.proto_entries,
            WriteFilesMode::Private,
            write_observer,
        )
        .await
    }

    async fn write_validated_files_batch(
        &self,
        files: &[WriteFileEntry<'_>],
        proto_entries: Vec<guest_control_proto::WriteFileBatchEntry<'_>>,
        mode: WriteFilesMode,
        write_observer: FrameWriteObserver,
    ) -> io::Result<()> {
        guest_control_proto::validate_write_files(&proto_entries)
            .map_err(protocol_invalid_input)?;

        let _path_guards = self
            .file_write_path_locks
            .acquire_shared_many(files.iter().map(|file| file.path))
            .await;
        let _file_write_guard = self.shared.file_write_gate.lock().await;
        let timeout = WRITE_FILE_REQUEST_DEADLINE;
        let sequence = AtomicU32::new(0);
        let write_sequence = &sequence;
        let resp = normal_request_on_shared_with_write_observer_frame_builder(
            &self.shared,
            WRITE_FILES_TERMINAL_MSG_TYPES,
            timeout,
            write_observer,
            move |seq, frame| {
                write_sequence.store(seq, Ordering::Relaxed);
                mode.encode_frame(frame, seq, &proto_entries)
                    .map_err(protocol_invalid_input)
            },
        )
        .await
        .map_err(|error| {
            annotate_private_write_timeout(
                error,
                matches!(mode, WriteFilesMode::Private),
                &sequence,
            )
        })?;

        if resp.msg_type == MSG_ERROR {
            let msg = guest_control_proto::decode_error(&resp.payload)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
            return Err(write_file_guest_error(msg));
        }

        if resp.msg_type != MSG_WRITE_FILES_RESULT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unexpected response type: 0x{:02X}", resp.msg_type),
            ));
        }

        let (success, error) = guest_control_proto::decode_write_files_result(&resp.payload)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
        if !success {
            return Err(write_file_guest_error(error));
        }

        Ok(())
    }

    /// Send a single write_file message and validate the response.
    async fn write_file_chunk(
        &self,
        request: WriteFileChunkRequest<'_>,
        tracking: WriteFileChunkTracking<'_>,
        write_observer: FrameWriteObserver,
    ) -> io::Result<()> {
        validate_write_file_chunk_request(request)?;

        let _file_write_guard = self.shared.file_write_gate.lock().await;
        let timeout = WRITE_FILE_REQUEST_DEADLINE;
        let sequence = AtomicU32::new(0);
        let write_sequence = &sequence;
        let build_frame = move |seq, frame: &mut Vec<u8>| {
            write_sequence.store(seq, Ordering::Relaxed);
            encode_write_file_chunk_frame(frame, seq, request)
        };
        let resp = match tracking {
            WriteFileChunkTracking::Tracked => {
                normal_request_on_shared_with_write_observer_frame_builder(
                    &self.shared,
                    WRITE_FILE_TERMINAL_MSG_TYPES,
                    timeout,
                    write_observer,
                    build_frame,
                )
                .await
            }
            WriteFileChunkTracking::Composite(normal_operation) => {
                request_on_shared_with_composite_operation_and_observer_frame_builder(
                    &self.shared,
                    WRITE_FILE_TERMINAL_MSG_TYPES,
                    timeout,
                    normal_operation,
                    write_observer,
                    build_frame,
                )
                .await
            }
        }
        .map_err(|error| annotate_private_write_timeout(error, request.private, &sequence))?;

        if resp.msg_type == MSG_ERROR {
            let msg = guest_control_proto::decode_error(&resp.payload)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
            return Err(write_file_guest_error(msg));
        }

        if resp.msg_type != MSG_WRITE_FILE_RESULT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unexpected response type: 0x{:02X}", resp.msg_type),
            ));
        }

        let (success, error) = guest_control_proto::decode_write_file_result(&resp.payload)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;

        if !success {
            return Err(write_file_guest_error(error));
        }

        Ok(())
    }
}

fn annotate_private_write_timeout(
    mut error: io::Error,
    private: bool,
    sequence: &AtomicU32,
) -> io::Error {
    if private
        && let Some(timeout) = error
            .get_mut()
            .and_then(|source| source.downcast_mut::<RequestTimeoutError>())
        && timeout.stage() == RequestTimeoutStage::AwaitingTerminalResponse
    {
        timeout.private_write_sequence = Some(sequence.load(Ordering::Relaxed));
    }
    error
}

fn validate_write_files<'a>(
    files: &[WriteFileEntry<'a>],
    mode: WriteFilesMode,
) -> io::Result<ValidatedWriteFiles<'a>> {
    let operation_name = mode.operation_name();
    if files.len() > WRITE_FILES_BATCH_FILE_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{operation_name} batch contains {} files, limit is {WRITE_FILES_BATCH_FILE_LIMIT}",
                files.len()
            ),
        ));
    }

    let mut total_content_len = 0usize;
    let mut proto_entries = Vec::with_capacity(files.len());
    for file in files {
        validate_guest_file_path(file.path)?;
        guest_control_proto::validate_write_file(file.path, &[], false, false)
            .map_err(protocol_invalid_input)?;
        total_content_len = total_content_len
            .checked_add(file.content.len())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("{operation_name} content length overflow"),
                )
            })?;
        proto_entries.push(guest_control_proto::WriteFileBatchEntry {
            path: file.path,
            content: file.content,
        });
    }

    Ok(ValidatedWriteFiles {
        proto_entries,
        total_content_len,
    })
}

fn validate_write_file_chunk_request(request: WriteFileChunkRequest<'_>) -> io::Result<()> {
    if request.private {
        guest_control_proto::validate_private_write_file(
            request.path,
            request.content,
            request.append,
        )
    } else {
        guest_control_proto::validate_write_file(
            request.path,
            request.content,
            request.sudo,
            request.append,
        )
    }
    .map_err(protocol_invalid_input)
}

fn encode_write_file_chunk_frame(
    frame: &mut Vec<u8>,
    seq: u32,
    request: WriteFileChunkRequest<'_>,
) -> io::Result<()> {
    if request.private {
        guest_control_proto::encode_private_write_file_frame_into(
            frame,
            seq,
            request.path,
            request.content,
            request.append,
        )
    } else {
        guest_control_proto::encode_write_file_frame_into(
            frame,
            seq,
            request.path,
            request.content,
            request.sudo,
            request.append,
        )
    }
    .map_err(protocol_invalid_input)
}
