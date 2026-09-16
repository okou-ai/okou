use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use guest_control_proto::{ExecOutputPolicy, ExecOutputStream, ExecTermination};
use tokio::io::AsyncWriteExt;

use crate::{
    CompositeNormalOperation, ExecOperationResult, ExecOutputEvent, ExecOwnedCapturedOutput,
    ExecStreamRequest, FrameWriteObserver, GuestControlClient, exec_operation,
    exec_operation::ExecOperationWaitOutcome,
};

use super::{
    MISSING_FILE_EXIT_CODE, normalize_file_exec_stderr, read_regular_file_command,
    validate_guest_file_path,
};

const COPY_TEMP_CREATE_ATTEMPTS: usize = 16;
const COPY_TEMP_FILE_MODE: u32 = 0o600;
const GROUP_OR_OTHER_WRITE_BITS: u32 = 0o022;
pub(super) const COPY_FILE_STREAM_CHUNK_LIMIT: u32 = 64 * 1024;

/// Inclusive maximum number of bytes accepted by the guest-to-host copy
/// operation.
///
/// The current limit is 128 MiB (`134_217_728` bytes). A larger
/// [`CopyFileOptions::max_bytes`] value is rejected with
/// `io::ErrorKind::InvalidInput` before guest work starts.
pub const COPY_FILE_STREAM_MAX_BYTES: u64 = 128 * 1024 * 1024;
// Copying is the one built-in streaming consumer that must tolerate the host
// reader briefly outrunning the temp-file writer without failing the exec operation.
const COPY_FILE_STREAM_QUEUE_CAPACITY: usize = exec_operation::MAX_EXEC_STREAM_CAPACITY;
static COPY_TEMP_NONCE: AtomicU64 = AtomicU64::new(1);

/// Request parameters for copying a guest file to a host path through exec
/// operation streaming.
#[derive(Debug, Clone, Copy)]
pub struct CopyFileOptions {
    /// Maximum bytes to stream from the guest before the copy fails.
    ///
    /// This value must be positive and no larger than the inclusive
    /// [`crate::COPY_FILE_STREAM_MAX_BYTES`] limit (128 MiB, or
    /// `134_217_728` bytes). A value above the limit returns
    /// `io::ErrorKind::InvalidInput` before guest work starts. The copy also
    /// fails if the streamed file contents exceed this byte count.
    pub max_bytes: u64,
    /// Guest-side copy exec timeout in milliseconds.
    ///
    /// This value must be positive.
    pub timeout_ms: u32,
    /// Treat a guest helper result that reports the path does not resolve to a
    /// regular file as a successful copy result.
    ///
    /// When such a helper result is treated as success, the operation returns
    /// `bytes_copied == 0` without creating an empty host file or replacing an
    /// existing host file.
    pub missing_ok: bool,
}

/// Result of copying a guest file to a host path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CopyFileResult {
    /// Number of bytes copied from the guest file.
    ///
    /// This is `0` for a present empty guest file, which still publishes an
    /// empty host file. It is also `0` when `missing_ok` turns a guest helper
    /// result that reports the path does not resolve to a regular file into
    /// success; in that case no host file is published.
    pub bytes_copied: u64,
}

enum CopyFileExecStatus {
    Present,
    Missing,
}

enum CopyFileOutcome {
    Copied { bytes_copied: u64 },
    Missing,
}

struct CopyFileToTempRequest<'a> {
    path: &'a str,
    stream_limit_bytes: u32,
    timeout_ms: u32,
    missing_ok: bool,
    write_observer: FrameWriteObserver,
}

struct HostTempFileGuard {
    path: PathBuf,
    active: bool,
}

impl HostTempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, active: true }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    async fn remove_now(&mut self) {
        if self.active {
            remove_temp_file(&self.path).await;
            self.active = false;
        }
    }

    fn disarm(&mut self) {
        self.active = false;
    }
}

impl Drop for HostTempFileGuard {
    fn drop(&mut self) {
        if self.active {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn copy_temp_path(host_path: &Path, process_id: u32, seq: u32, nonce: u64) -> PathBuf {
    let file_name = host_path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| "copy".into());
    host_path.with_file_name(format!(".{file_name}.vm0tmp-{process_id}-{seq}-{nonce}"))
}

fn validate_copy_host_path(host_path: &Path) -> io::Result<()> {
    let path_bytes = host_path.as_os_str().as_bytes();
    if path_bytes.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "copy_file host path must not be empty",
        ));
    }
    if path_bytes.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "copy_file host path contains NUL bytes",
        ));
    }
    if host_path.file_name().is_none() || path_bytes.ends_with(b"/") || path_bytes.ends_with(b"/.")
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "copy_file host path must name a file",
        ));
    }
    Ok(())
}

async fn remove_temp_file(path: &Path) {
    match tokio::fs::remove_file(path).await {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(_) => {}
    }
}

async fn create_copy_temp_file(
    host_path: &Path,
    seq: u32,
) -> io::Result<(HostTempFileGuard, tokio::fs::File)> {
    create_copy_temp_file_with_validator(host_path, seq, secure_copy_temp_file).await
}

async fn create_copy_temp_file_with_validator(
    host_path: &Path,
    seq: u32,
    validate: impl FnOnce(&tokio::fs::File, &Path) -> io::Result<()> + Send + 'static,
) -> io::Result<(HostTempFileGuard, tokio::fs::File)> {
    let host_path = host_path.to_owned();
    tokio::task::spawn_blocking(move || {
        for _ in 0..COPY_TEMP_CREATE_ATTEMPTS {
            let nonce = COPY_TEMP_NONCE.fetch_add(1, Ordering::Relaxed);
            let temp_path = copy_temp_path(&host_path, std::process::id(), seq, nonce);
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(COPY_TEMP_FILE_MODE)
                .custom_flags(
                    nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC | nix::libc::O_NONBLOCK,
                )
                .open(&temp_path)
            {
                Ok(file) => {
                    let guard = HostTempFileGuard::new(temp_path);
                    let file = tokio::fs::File::from_std(file);
                    validate(&file, guard.path())?;
                    return Ok((guard, file));
                }
                Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(err) => return Err(err),
            }
        }

        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "copy_file could not create a unique temp file after {COPY_TEMP_CREATE_ATTEMPTS} attempts"
            ),
        ))
    })
    .await
    .map_err(|_| io::Error::other("background task failed"))?
}

fn secure_copy_temp_file(file: &tokio::fs::File, path: &Path) -> io::Result<()> {
    let stat = fstat_copy_temp_file(file, path)?;
    let file_type = stat.st_mode & nix::libc::S_IFMT;
    if file_type != nix::libc::S_IFREG {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("copy temp file {} is not a regular file", path.display()),
        ));
    }
    let expected_uid = unsafe { nix::libc::geteuid() };
    if stat.st_uid != expected_uid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "copy temp file {} is owned by uid {}, but euid is {expected_uid}",
                path.display(),
                stat.st_uid
            ),
        ));
    }
    if stat.st_mode & GROUP_OR_OTHER_WRITE_BITS != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("copy temp file {} is group/other writable", path.display()),
        ));
    }
    // SAFETY: `fchmod` operates on the live fd and does not affect Rust aliasing.
    let result =
        unsafe { nix::libc::fchmod(file.as_raw_fd(), COPY_TEMP_FILE_MODE as nix::libc::mode_t) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "chmod copy temp file {}: {}",
            path.display(),
            io::Error::last_os_error()
        )))
    }
}

fn fstat_copy_temp_file(file: &tokio::fs::File, path: &Path) -> io::Result<nix::libc::stat> {
    let mut stat = std::mem::MaybeUninit::<nix::libc::stat>::uninit();
    // SAFETY: `stat` points to writable memory and `file` owns a live fd.
    let result = unsafe { nix::libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) };
    if result != 0 {
        return Err(io::Error::other(format!(
            "stat copy temp file {}: {}",
            path.display(),
            io::Error::last_os_error()
        )));
    }
    // SAFETY: successful `fstat` initialized the full struct.
    Ok(unsafe { stat.assume_init() })
}

async fn write_copy_stream_event(
    temp_file: &mut tokio::fs::File,
    bytes_copied: &mut u64,
    max_bytes: u64,
    event: ExecOutputEvent,
) -> io::Result<()> {
    if event.stream != ExecOutputStream::Stdout {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "copy_file received stderr stream event",
        ));
    }
    if event.truncated {
        return Err(io::Error::other("copy_file stdout stream was truncated"));
    }
    *bytes_copied = bytes_copied
        .checked_add(event.chunk.len() as u64)
        .ok_or_else(|| io::Error::other("copy_file byte count overflow"))?;
    if *bytes_copied > max_bytes {
        return Err(io::Error::other(format!(
            "copy_file exceeded {max_bytes} bytes"
        )));
    }
    temp_file.write_all(&event.chunk).await
}

fn copy_exec_stderr(result: &ExecOperationResult) -> io::Result<(Vec<u8>, bool)> {
    match &result.stderr {
        ExecOwnedCapturedOutput::Captured { bytes, truncated } => Ok((bytes.clone(), *truncated)),
        ExecOwnedCapturedOutput::Discarded => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "copy_file exec operation discarded stderr capture",
        )),
    }
}

fn validate_copy_exec_result(
    path: &str,
    result: ExecOperationResult,
) -> io::Result<CopyFileExecStatus> {
    if result.stream_overflowed {
        return Err(io::Error::other(
            "copy_file stream queue overflowed before all chunks were written",
        ));
    }
    if !matches!(&result.stdout, ExecOwnedCapturedOutput::Discarded) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "copy_file exec operation unexpectedly captured stdout",
        ));
    }
    let (stderr, stderr_truncated) = copy_exec_stderr(&result)?;
    let stderr = normalize_file_exec_stderr(stderr, stderr_truncated);
    match result.termination {
        ExecTermination::Exited { exit_code: 0 } if stderr.is_empty() => {
            Ok(CopyFileExecStatus::Present)
        }
        ExecTermination::Exited { exit_code: 0 } => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "copy_file result for {path} included stderr: {}",
                String::from_utf8_lossy(&stderr)
            ),
        )),
        ExecTermination::Exited {
            exit_code: MISSING_FILE_EXIT_CODE,
        } if stderr.is_empty() => Ok(CopyFileExecStatus::Missing),
        ExecTermination::Exited {
            exit_code: MISSING_FILE_EXIT_CODE,
        } => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "copy_file missing result for {path} included stderr: {}",
                String::from_utf8_lossy(&stderr)
            ),
        )),
        ExecTermination::Exited { exit_code } => Err(io::Error::other(format!(
            "copy_file failed for {path} with exit code {exit_code}: {}",
            String::from_utf8_lossy(&stderr)
        ))),
        ExecTermination::TimedOut => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!("copy_file timed out for {path}"),
        )),
        ExecTermination::Cancelled => Err(io::Error::other(format!(
            "copy_file was cancelled for {path}: {}",
            result.diagnostic
        ))),
        ExecTermination::StartFailed | ExecTermination::WaitFailed => {
            Err(io::Error::other(format!(
                "copy_file exec operation failed for {path}: {}",
                result.diagnostic
            )))
        }
    }
}

impl GuestControlClient {
    /// Stream a guest file to a host path and atomically rename it into place
    /// after the exec operation exits successfully.
    ///
    /// A successful copy creates missing host parent directories as needed and
    /// replaces an existing non-directory destination with a newly created
    /// regular file owned by the host process's effective user. The published
    /// file has mode `0o600`; metadata from an existing destination is not
    /// preserved.
    ///
    /// Options are validated before guest work starts. When `missing_ok` is
    /// enabled, a guest helper result that reports the path does not resolve
    /// to a regular file is treated as success with `bytes_copied == 0`
    /// without publishing a host file. Host-side setup and validation errors
    /// can still fail the operation, and setup may leave newly created parent
    /// directories behind.
    ///
    /// Failures before the final rename leave an existing destination
    /// unchanged. An error reported after the rename does not roll back the
    /// published destination.
    ///
    /// The guest path must be non-empty and must not contain NUL bytes.
    ///
    /// The host path must name a file destination. Empty host paths, paths
    /// containing NUL bytes, and paths that end in a directory marker are
    /// rejected before guest work starts.
    pub async fn copy_file(
        &self,
        path: &str,
        host_path: &Path,
        options: CopyFileOptions,
    ) -> io::Result<CopyFileResult> {
        self.copy_file_with_write_observer(path, host_path, options, FrameWriteObserver::default())
            .await
    }

    /// Stream a guest file to a host path and report when the helper exec
    /// frame is about to be written to the guest.
    ///
    /// This has the same copy semantics as [`copy_file`](Self::copy_file),
    /// including option validation and `missing_ok` handling.
    pub async fn copy_file_with_write_observer(
        &self,
        path: &str,
        host_path: &Path,
        options: CopyFileOptions,
        write_observer: FrameWriteObserver,
    ) -> io::Result<CopyFileResult> {
        validate_guest_file_path(path)?;
        validate_copy_host_path(host_path)?;
        if options.max_bytes == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "copy_file max_bytes must be positive",
            ));
        }
        if options.max_bytes > COPY_FILE_STREAM_MAX_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("copy_file max_bytes must be at most {COPY_FILE_STREAM_MAX_BYTES}"),
            ));
        }
        let stream_limit_bytes = u32::try_from(options.max_bytes).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "copy_file max_bytes exceeds exec stream limit",
            )
        })?;
        if options.timeout_ms == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "copy_file timeout must be positive",
            ));
        }

        if let Some(parent) = host_path.parent()
            && !parent.as_os_str().is_empty()
        {
            tokio::fs::create_dir_all(parent).await?;
        }

        let (mut temp_guard, temp_file) =
            create_copy_temp_file(host_path, self.shared.next_temp_seq()).await?;
        let mut normal_operation = CompositeNormalOperation::reserve(&self.shared)?;
        let copy_result = self
            .copy_file_to_temp(
                CopyFileToTempRequest {
                    path,
                    stream_limit_bytes,
                    timeout_ms: options.timeout_ms,
                    missing_ok: options.missing_ok,
                    write_observer,
                },
                temp_file,
                &mut normal_operation,
            )
            .await;
        match copy_result {
            ExecOperationWaitOutcome::Terminal(Ok(CopyFileOutcome::Copied { bytes_copied })) => {
                match tokio::fs::rename(temp_guard.path(), host_path).await {
                    Ok(()) => {
                        temp_guard.disarm();
                        normal_operation.complete()?;
                        Ok(CopyFileResult { bytes_copied })
                    }
                    Err(err) => {
                        temp_guard.remove_now().await;
                        normal_operation.complete()?;
                        Err(err)
                    }
                }
            }
            ExecOperationWaitOutcome::Terminal(Ok(CopyFileOutcome::Missing)) => {
                temp_guard.remove_now().await;
                normal_operation.complete()?;
                Ok(CopyFileResult { bytes_copied: 0 })
            }
            ExecOperationWaitOutcome::Terminal(Err(error)) => {
                temp_guard.remove_now().await;
                normal_operation.complete()?;
                Err(error)
            }
            ExecOperationWaitOutcome::Unproven(error) => {
                temp_guard.remove_now().await;
                Err(error)
            }
        }
    }

    async fn copy_file_to_temp(
        &self,
        request: CopyFileToTempRequest<'_>,
        mut temp_file: tokio::fs::File,
        normal_operation: &mut CompositeNormalOperation,
    ) -> ExecOperationWaitOutcome<CopyFileOutcome> {
        let CopyFileToTempRequest {
            path,
            stream_limit_bytes,
            timeout_ms,
            missing_ok,
            write_observer,
        } = request;
        let command = read_regular_file_command(path, MISSING_FILE_EXIT_CODE, None);
        let expected_exit_codes: &[i32] = if missing_ok {
            &[MISSING_FILE_EXIT_CODE]
        } else {
            &[]
        };
        let wait_timeout = Duration::from_millis(timeout_ms as u64 + 5000);
        let start_result =
            exec_operation::exec_operation_stream_with_composite_on_shared_and_observer(
                &self.shared,
                ExecStreamRequest {
                    timeout_ms,
                    start_write_timeout: wait_timeout,
                    command: &command,
                    env: &[],
                    sudo: false,
                    label: "copy-file",
                    stdout: ExecOutputPolicy::Stream {
                        limit_bytes: stream_limit_bytes,
                        chunk_limit_bytes: COPY_FILE_STREAM_CHUNK_LIMIT,
                    },
                    stderr: ExecOutputPolicy::Capture {
                        limit_bytes: exec_operation::SMALL_EXEC_CAPTURE_LIMIT_BYTES,
                    },
                    expected_exit_codes,
                    stdin_bytes: None,
                    stream_queue_capacity: Some(COPY_FILE_STREAM_QUEUE_CAPACITY),
                },
                normal_operation,
                write_observer,
            )
            .await;
        let mut handle = match start_result {
            Ok(handle) => handle,
            Err(error) => return ExecOperationWaitOutcome::unproven(error),
        };
        let mut cancel_on_drop = exec_operation::ExecOperationCancelOnDropGuard::new(&handle);
        let Some(mut stream_rx) = handle.take_stream_receiver() else {
            return ExecOperationWaitOutcome::unproven(io::Error::new(
                io::ErrorKind::InvalidData,
                "copy_file exec operation did not create a stream receiver",
            ));
        };
        let mut bytes_copied = 0u64;

        let drain_result = tokio::time::timeout(wait_timeout, async {
            while let Some(event) = stream_rx.recv().await {
                write_copy_stream_event(
                    &mut temp_file,
                    &mut bytes_copied,
                    stream_limit_bytes as u64,
                    event,
                )
                .await?;
            }
            io::Result::Ok(())
        })
        .await;
        match drain_result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                let cancel_result = handle
                    .cancel_and_wait_for_terminal(Duration::from_secs(1))
                    .await;
                if let Some(cancel_on_drop) = &mut cancel_on_drop {
                    cancel_on_drop.disarm();
                }
                return if cancel_result.terminal_observed() {
                    ExecOperationWaitOutcome::terminal(Err(err))
                } else {
                    ExecOperationWaitOutcome::unproven(err)
                };
            }
            Err(_) => {
                let cancel_result = handle
                    .cancel_and_wait_for_terminal(Duration::from_secs(1))
                    .await;
                if let Some(cancel_on_drop) = &mut cancel_on_drop {
                    cancel_on_drop.disarm();
                }
                let error = io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("copy_file stream drain timed out for {path}"),
                );
                return if cancel_result.terminal_observed() {
                    ExecOperationWaitOutcome::terminal(Err(error))
                } else {
                    ExecOperationWaitOutcome::unproven(error)
                };
            }
        };

        let wait_outcome = handle.wait_for_outcome(Duration::from_secs(5)).await;
        if wait_outcome.terminal_observed()
            && let Some(cancel_on_drop) = &mut cancel_on_drop
        {
            cancel_on_drop.disarm();
        }
        let result = match wait_outcome {
            ExecOperationWaitOutcome::Terminal(Ok(result)) => result,
            ExecOperationWaitOutcome::Terminal(Err(error)) => {
                return ExecOperationWaitOutcome::terminal(Err(error));
            }
            ExecOperationWaitOutcome::Unproven(error) => {
                return ExecOperationWaitOutcome::unproven(error);
            }
        };
        let status = match validate_copy_exec_result(path, result) {
            Ok(status) => status,
            Err(error) => return ExecOperationWaitOutcome::terminal(Err(error)),
        };
        match status {
            CopyFileExecStatus::Present => {}
            CopyFileExecStatus::Missing => {
                if bytes_copied != 0 {
                    return ExecOperationWaitOutcome::terminal(Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!(
                            "copy_file missing result for {path} streamed {bytes_copied} bytes"
                        ),
                    )));
                }
                if missing_ok {
                    return ExecOperationWaitOutcome::terminal(Ok(CopyFileOutcome::Missing));
                }
                return ExecOperationWaitOutcome::terminal(Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("guest file not found: {path}"),
                )));
            }
        }
        if let Err(error) = temp_file.flush().await {
            return ExecOperationWaitOutcome::terminal(Err(error));
        }

        ExecOperationWaitOutcome::terminal(Ok(CopyFileOutcome::Copied { bytes_copied }))
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn copy_temp_path_distinguishes_process_seq_and_nonce() {
        let host_path = PathBuf::from("/tmp/system.log");

        let base = copy_temp_path(&host_path, 101, 7, 1);
        assert_ne!(base, copy_temp_path(&host_path, 102, 7, 1));
        assert_ne!(base, copy_temp_path(&host_path, 101, 8, 1));
        assert_ne!(base, copy_temp_path(&host_path, 101, 7, 2));
        assert_eq!(
            base.file_name().and_then(|name| name.to_str()),
            Some(".system.log.vm0tmp-101-7-1")
        );
    }

    #[tokio::test]
    async fn create_copy_temp_file_uses_unique_paths_for_same_seq() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "guest-control-client-copy-temp-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let host_path = dir.join("system.log");

        let (first_guard, first_file) = create_copy_temp_file(&host_path, 7).await.unwrap();
        let (second_guard, second_file) = create_copy_temp_file(&host_path, 7).await.unwrap();
        let first_path = first_guard.path().to_owned();
        let second_path = second_guard.path().to_owned();

        assert_ne!(first_path, second_path);
        assert!(first_path.exists());
        assert!(second_path.exists());
        drop(first_file);
        drop(second_file);
        drop(first_guard);
        drop(second_guard);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_copy_temp_file_removes_temp_when_async_waiter_is_cancelled() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "guest-control-client-copy-temp-cancellation-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let host_path = dir.join("system.log");

        runtime.block_on(async {
            let (created_tx, created_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let create_task = tokio::spawn(async move {
                create_copy_temp_file_with_validator(&host_path, 7, move |_file, path| {
                    created_tx.send(path.to_owned()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                })
                .await
            });

            let temp_path = created_rx.await.unwrap();
            assert!(temp_path.exists());

            create_task.abort();
            match create_task.await {
                Ok(_) => panic!("temp creation task completed before cancellation"),
                Err(error) => assert!(error.is_cancelled()),
            }
            release_tx.send(()).unwrap();
            tokio::task::spawn_blocking(|| {}).await.unwrap();

            assert!(!temp_path.exists());
        });

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn create_copy_temp_file_removes_temp_when_validation_fails() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "guest-control-client-copy-temp-validation-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let host_path = dir.join("system.log");

        let result = create_copy_temp_file_with_validator(&host_path, 7, |_file, _path| {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "forced validation failure",
            ))
        })
        .await;
        let error = match result {
            Ok(_) => panic!("temp file validation unexpectedly succeeded"),
            Err(error) => error,
        };

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(std::fs::read_dir(&dir).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("vm0tmp")
        }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn host_temp_file_guard_removes_temp_on_drop() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "guest-control-client-temp-guard-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".system.log.vm0tmp-guard");
        std::fs::write(&path, b"partial").unwrap();

        {
            let _guard = HostTempFileGuard::new(path.clone());
        }

        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_file_stream_settings_keep_configured_chunk_headroom() {
        // Actual guest reads may produce smaller frames, so bounded runtime
        // overflow handling remains the correctness guard.
        let configured_max_chunks =
            COPY_FILE_STREAM_MAX_BYTES.div_ceil(COPY_FILE_STREAM_CHUNK_LIMIT as u64);
        assert!(configured_max_chunks < COPY_FILE_STREAM_QUEUE_CAPACITY as u64);
        assert_eq!(
            COPY_FILE_STREAM_QUEUE_CAPACITY,
            exec_operation::test_support::MAX_STREAM_CAPACITY
        );
    }
}
