use std::io::{self, Read};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use guest_control_proto::{
    ExecCapturedOutput, ExecOutputPolicy, ExecOutputStream, ExecTermination, MSG_ERROR,
    MSG_EXEC_CANCEL, MSG_EXEC_START,
};
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::task::JoinHandle;

use super::super::support::{
    assert_connection_accepts_exec_operation, normal_operation_readiness, operation_count,
    read_guest_message, send_exec_output, send_raw_exec_result, send_stream_exec_result,
    setup_host_and_guest,
};
use super::support::{
    ExecStartFrame, HostTempDir, HostTempPath, copy_options, default_copy_options,
    expect_exec_start, send_guest_error, spawn_copy_file,
};
use crate::file as file_impl;
use crate::operation_tracker::NormalOperationReadiness;
use crate::{CopyFileOptions, CopyFileResult, GuestControlClient};

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

struct CopyFileFixture {
    host: Arc<GuestControlClient>,
    guest: UnixStream,
    temp_dir: HostTempDir,
    host_path: PathBuf,
}

impl CopyFileFixture {
    async fn new(prefix: &str, file_name: &str) -> Self {
        let (host, guest) = setup_host_and_guest().await;
        let temp_dir = HostTempDir::new(prefix);
        let host_path = temp_dir.join(file_name);
        Self {
            host: Arc::new(host),
            guest,
            temp_dir,
            host_path,
        }
    }

    fn spawn_copy(
        &self,
        guest_path: &'static str,
        options: CopyFileOptions,
    ) -> JoinHandle<io::Result<CopyFileResult>> {
        spawn_copy_file(
            Arc::clone(&self.host),
            guest_path,
            self.host_path.clone(),
            options,
        )
    }

    async fn expect_start(&mut self) -> ExecStartFrame {
        expect_exec_start(&mut self.guest).await
    }

    fn write_host_bytes(&self, bytes: &[u8]) {
        std::fs::write(&self.host_path, bytes).unwrap();
    }

    fn assert_readiness(&self, expected: NormalOperationReadiness) {
        assert_eq!(normal_operation_readiness(&self.host), expected);
    }

    fn assert_host_bytes(&self, expected: &[u8]) {
        assert_eq!(std::fs::read(&self.host_path).unwrap(), expected);
    }

    fn assert_host_missing(&self) {
        assert!(!self.host_path.exists());
    }

    fn assert_temp_file_count(&self, expected: usize) {
        let actual = std::fs::read_dir(self.temp_dir.path())
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains("vm0tmp")
            })
            .count();
        assert_eq!(actual, expected);
    }

    fn assert_no_temp_files(&self) {
        self.temp_dir.assert_no_vm0tmp_files();
    }
}

async fn assert_copy_terminal_failures(
    stderr: &[u8],
    stderr_truncated: bool,
    diagnostic: &str,
    existing_destination: bool,
) {
    for (termination, expected_kind, expected_reason) in [
        (
            ExecTermination::TimedOut,
            io::ErrorKind::TimedOut,
            "timed out",
        ),
        (
            ExecTermination::Cancelled,
            io::ErrorKind::Other,
            "was cancelled",
        ),
        (
            ExecTermination::StartFailed,
            io::ErrorKind::Other,
            "exec start failed",
        ),
        (
            ExecTermination::WaitFailed,
            io::ErrorKind::Other,
            "exec wait failed",
        ),
    ] {
        let mut fixture =
            CopyFileFixture::new("guest-control-client-copy-terminal", "system.log").await;
        if existing_destination {
            fixture.write_host_bytes(b"original host log");
        }
        let copy_task = fixture.spawn_copy("/tmp/system.log", default_copy_options());
        let start = fixture.expect_start().await;
        if !matches!(termination, ExecTermination::StartFailed) {
            send_exec_output(
                &mut fixture.guest,
                start.seq(),
                0,
                ExecOutputStream::Stdout,
                b"incomplete guest log",
                false,
            )
            .await;
        }
        let payload = guest_control_proto::encode_exec_result(
            termination,
            12,
            ExecCapturedOutput::Discarded,
            ExecCapturedOutput::Captured {
                bytes: stderr,
                truncated: stderr_truncated,
            },
            diagnostic,
        )
        .unwrap();
        send_raw_exec_result(&mut fixture.guest, start.seq(), payload).await;

        let error = copy_task.await.unwrap().unwrap_err();
        assert_eq!(error.kind(), expected_kind);
        if existing_destination {
            fixture.assert_host_bytes(b"original host log");
        } else {
            fixture.assert_host_missing();
        }
        fixture.assert_no_temp_files();

        let message = error.to_string();
        let prefix = format!("copy_file {expected_reason} for /tmp/system.log");
        assert!(message.starts_with(&prefix), "{message}");
        if !stderr.is_empty() {
            let expected_stderr = format!("stderr: {}", String::from_utf8_lossy(stderr));
            assert!(message.contains(&expected_stderr), "{message}");
        }
        if stderr_truncated {
            assert!(message.contains("stderr truncated"), "{message}");
        }
        if !diagnostic.is_empty() {
            assert!(
                message.contains(&format!("diagnostic: {diagnostic}")),
                "{message}"
            );
        }
        if stderr.is_empty() && !stderr_truncated && diagnostic.is_empty() {
            assert_eq!(message, prefix);
        }
        assert_connection_accepts_exec_operation(&fixture.host, &mut fixture.guest).await;
    }
}

#[tokio::test]
async fn copy_file_reports_terminal_failures() {
    assert_copy_terminal_failures(b"helper stderr", false, "guest diagnostic", true).await;
}

#[tokio::test]
async fn copy_file_reports_terminal_failures_with_truncated_stderr() {
    assert_copy_terminal_failures(b"helper stderr", true, "guest diagnostic", true).await;
}

#[tokio::test]
async fn copy_file_reports_terminal_failures_without_details() {
    assert_copy_terminal_failures(b"", false, "", false).await;
}

#[tokio::test]
async fn copy_file_rejects_max_bytes_above_stream_budget() {
    let (host, _guest) = setup_host_and_guest().await;
    let err = host
        .copy_file(
            "/tmp/large.log",
            Path::new("/tmp/large.log"),
            copy_options(
                file_impl::test_support::COPY_FILE_STREAM_MAX_BYTES + 1,
                5000,
                false,
            ),
        )
        .await
        .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(err.to_string().contains("copy_file max_bytes"));
}

#[tokio::test]
async fn copy_file_streams_to_temp_then_renames() {
    let mut fixture = CopyFileFixture::new("guest-control-client-copy", "system.log").await;
    fixture.write_host_bytes(b"old host log");
    std::fs::set_permissions(&fixture.host_path, std::fs::Permissions::from_mode(0o640)).unwrap();
    let mut old_file = std::fs::File::open(&fixture.host_path).unwrap();
    let old_metadata = old_file.metadata().unwrap();
    let copy_task = fixture.spawn_copy(
        "/tmp/vm0-system-run.log",
        copy_options(
            file_impl::test_support::COPY_FILE_STREAM_MAX_BYTES,
            5000,
            false,
        ),
    );

    let start = fixture.expect_start().await;
    fixture.assert_readiness(NormalOperationReadiness::Busy);
    assert_eq!(start.label, "copy-file");
    assert_eq!(
        start.stdout,
        ExecOutputPolicy::Stream {
            limit_bytes: u32::try_from(file_impl::test_support::COPY_FILE_STREAM_MAX_BYTES)
                .unwrap(),
            chunk_limit_bytes: file_impl::test_support::COPY_FILE_STREAM_CHUNK_LIMIT,
        }
    );
    assert_eq!(
        start.command,
        "if test -f '/tmp/vm0-system-run.log'; then cat 2>/dev/null < '/tmp/vm0-system-run.log' || { test -f '/tmp/vm0-system-run.log' || exit 66; printf '%s\\n' 'failed to read file' >&2; exit 1; }; else exit 66; fi"
    );
    send_exec_output(
        &mut fixture.guest,
        start.seq(),
        0,
        ExecOutputStream::Stdout,
        b"line 1\n",
        false,
    )
    .await;
    send_exec_output(
        &mut fixture.guest,
        start.seq(),
        1,
        ExecOutputStream::Stdout,
        b"line 2\n",
        false,
    )
    .await;
    send_stream_exec_result(
        &mut fixture.guest,
        start.seq(),
        ExecTermination::Exited { exit_code: 0 },
        b"",
    )
    .await;

    let result = copy_task.await.unwrap().unwrap();
    assert_eq!(result.bytes_copied, 14);
    fixture.assert_readiness(NormalOperationReadiness::Idle);
    fixture.assert_host_bytes(b"line 1\nline 2\n");
    assert_eq!(mode(&fixture.host_path), 0o600);
    let new_metadata = std::fs::symlink_metadata(&fixture.host_path).unwrap();
    assert!(new_metadata.is_file());
    assert_ne!(
        (old_metadata.dev(), old_metadata.ino()),
        (new_metadata.dev(), new_metadata.ino())
    );
    let mut old_bytes = Vec::new();
    old_file.read_to_end(&mut old_bytes).unwrap();
    assert_eq!(old_bytes, b"old host log");
    fixture.assert_no_temp_files();
}

#[tokio::test]
async fn copy_file_empty_guest_file_publishes_empty_host_file() {
    let mut fixture = CopyFileFixture::new("guest-control-client-copy-empty", "empty.log").await;
    let copy_task = fixture.spawn_copy("/tmp/empty.log", default_copy_options());

    let start = fixture.expect_start().await;
    send_stream_exec_result(
        &mut fixture.guest,
        start.seq(),
        ExecTermination::Exited { exit_code: 0 },
        b"",
    )
    .await;

    let result = copy_task.await.unwrap().unwrap();
    assert_eq!(result.bytes_copied, 0);
    fixture.assert_host_bytes(b"");
    assert_eq!(mode(&fixture.host_path), 0o600);
    fixture.assert_no_temp_files();
}

#[tokio::test]
async fn copy_file_allows_exact_max_bytes() {
    let mut fixture =
        CopyFileFixture::new("guest-control-client-copy-exact-max", "exact.log").await;
    let copy_task = fixture.spawn_copy("/tmp/exact.log", copy_options(4, 5000, false));

    let start = fixture.expect_start().await;
    assert_eq!(
        start.stdout,
        ExecOutputPolicy::Stream {
            limit_bytes: 4,
            chunk_limit_bytes: file_impl::test_support::COPY_FILE_STREAM_CHUNK_LIMIT,
        }
    );
    send_exec_output(
        &mut fixture.guest,
        start.seq(),
        0,
        ExecOutputStream::Stdout,
        b"1234",
        false,
    )
    .await;
    send_stream_exec_result(
        &mut fixture.guest,
        start.seq(),
        ExecTermination::Exited { exit_code: 0 },
        b"",
    )
    .await;

    let result = copy_task.await.unwrap().unwrap();
    assert_eq!(result.bytes_copied, 4);
    fixture.assert_host_bytes(b"1234");
    fixture.assert_no_temp_files();
}

#[tokio::test]
async fn copy_file_rejects_invalid_options_without_sending_frame_or_creating_parent() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let temp_path = HostTempPath::new("guest-control-client-copy-invalid");
    let host_path = temp_path.join("nested/system.log");

    let err = host
        .copy_file("", &host_path, copy_options(1024, 5000, true))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(!temp_path.path().exists());

    let err = host
        .copy_file(
            "/tmp/bad\0path.log",
            &host_path,
            copy_options(1024, 5000, false),
        )
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(!temp_path.path().exists());

    for invalid_host_path in ["", ".", "/tmp/", "/tmp/.", "/tmp/bad\0host.log"] {
        let err = host
            .copy_file(
                "/tmp/system.log",
                Path::new(invalid_host_path),
                copy_options(1024, 5000, false),
            )
            .await
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(operation_count(&host), 0);
        assert!(!temp_path.path().exists());
    }

    let err = host
        .copy_file("/tmp/system.log", &host_path, copy_options(0, 5000, false))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(!temp_path.path().exists());

    let err = host
        .copy_file("/tmp/system.log", &host_path, copy_options(1024, 0, false))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(!temp_path.path().exists());
    assert_eq!(operation_count(&host), 0);

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn copy_file_creates_parent_and_quotes_guest_path_with_single_quote() {
    let (host, mut guest) = setup_host_and_guest().await;
    let temp_path = HostTempPath::new("guest-control-client-copy-parent-quote");
    let host_path = temp_path.join("nested/system.log");
    let copy_path = host_path.clone();

    let copy_task = tokio::spawn(async move {
        host.copy_file(
            "/tmp/vm0-system-run's.log",
            &copy_path,
            default_copy_options(),
        )
        .await
    });

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    let decoded = guest_control_proto::decode_exec_start(&msg.payload).unwrap();
    assert_eq!(
        decoded.command,
        "if test -f '/tmp/vm0-system-run'\\''s.log'; then cat 2>/dev/null < '/tmp/vm0-system-run'\\''s.log' || { test -f '/tmp/vm0-system-run'\\''s.log' || exit 66; printf '%s\\n' 'failed to read file' >&2; exit 1; }; else exit 66; fi"
    );
    send_exec_output(
        &mut guest,
        msg.seq,
        0,
        ExecOutputStream::Stdout,
        b"quoted path\n",
        false,
    )
    .await;
    send_stream_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
    )
    .await;

    let result = copy_task.await.unwrap().unwrap();
    assert_eq!(result.bytes_copied, 12);
    assert_eq!(std::fs::read(&host_path).unwrap(), b"quoted path\n");
}

#[tokio::test]
async fn copy_file_removes_temp_without_publishing_on_stream_truncation() {
    let mut fixture =
        CopyFileFixture::new("guest-control-client-copy-truncated", "system.log").await;
    fixture.write_host_bytes(b"old host log");
    let copy_task = fixture.spawn_copy("/tmp/vm0-system-run.log", default_copy_options());

    let start = fixture.expect_start().await;
    send_exec_output(
        &mut fixture.guest,
        start.seq(),
        0,
        ExecOutputStream::Stdout,
        b"partial",
        true,
    )
    .await;

    let cancel = read_guest_message(&mut fixture.guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq());
    send_stream_exec_result(
        &mut fixture.guest,
        start.seq(),
        ExecTermination::Cancelled,
        b"",
    )
    .await;

    let err = copy_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("truncated"));
    fixture.assert_host_bytes(b"old host log");
    fixture.assert_no_temp_files();
}

#[tokio::test]
async fn copy_file_stream_error_releases_tracker_when_cancel_sees_terminal_result() {
    let mut fixture =
        CopyFileFixture::new("guest-control-client-copy-cancel-terminal", "system.log").await;
    fixture.write_host_bytes(b"old host log");
    let copy_task = fixture.spawn_copy("/tmp/vm0-system-run.log", default_copy_options());

    let start = fixture.expect_start().await;
    fixture.assert_readiness(NormalOperationReadiness::Busy);
    send_exec_output(
        &mut fixture.guest,
        start.seq(),
        0,
        ExecOutputStream::Stdout,
        b"partial",
        true,
    )
    .await;

    let cancel = read_guest_message(&mut fixture.guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq());
    send_stream_exec_result(
        &mut fixture.guest,
        start.seq(),
        ExecTermination::Exited { exit_code: 0 },
        b"",
    )
    .await;

    let err = copy_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("truncated"));
    fixture.assert_readiness(NormalOperationReadiness::Idle);
    fixture.assert_host_bytes(b"old host log");
    fixture.assert_no_temp_files();
}

#[tokio::test]
async fn copy_file_stream_error_releases_tracker_when_cancel_sees_guest_error() {
    let mut fixture =
        CopyFileFixture::new("guest-control-client-copy-cancel-guest-error", "system.log").await;
    fixture.write_host_bytes(b"old host log");
    let copy_task = fixture.spawn_copy("/tmp/vm0-system-run.log", default_copy_options());

    let start = fixture.expect_start().await;
    fixture.assert_readiness(NormalOperationReadiness::Busy);
    send_exec_output(
        &mut fixture.guest,
        start.seq(),
        0,
        ExecOutputStream::Stdout,
        b"partial",
        true,
    )
    .await;

    let cancel = read_guest_message(&mut fixture.guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq());
    send_guest_error(
        &mut fixture.guest,
        start.seq(),
        "guest rejected cancellation",
    )
    .await;

    let err = copy_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("truncated"));
    fixture.assert_readiness(NormalOperationReadiness::Idle);
    fixture.assert_host_bytes(b"old host log");
    fixture.assert_no_temp_files();
}

#[tokio::test]
async fn copy_file_stream_error_keeps_tracker_fail_closed_when_cancel_loses_connection() {
    let mut fixture = CopyFileFixture::new(
        "guest-control-client-copy-cancel-connection-close",
        "system.log",
    )
    .await;
    fixture.write_host_bytes(b"old host log");
    let copy_task = fixture.spawn_copy("/tmp/vm0-system-run.log", default_copy_options());

    let start = fixture.expect_start().await;
    send_exec_output(
        &mut fixture.guest,
        start.seq(),
        0,
        ExecOutputStream::Stdout,
        b"partial",
        true,
    )
    .await;
    let cancel = read_guest_message(&mut fixture.guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq());

    fixture.guest.shutdown().await.unwrap();

    let err = copy_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("truncated"));
    fixture.assert_readiness(NormalOperationReadiness::NotParkable);
    fixture.assert_host_bytes(b"old host log");
    fixture.assert_no_temp_files();
}

#[tokio::test]
async fn copy_file_malformed_error_removes_temp_and_keeps_tracker_fail_closed() {
    let mut fixture =
        CopyFileFixture::new("guest-control-client-copy-malformed-error", "system.log").await;
    fixture.write_host_bytes(b"old host log");
    let copy_task = fixture.spawn_copy("/tmp/vm0-system-run.log", default_copy_options());

    let start = fixture.expect_start().await;
    fixture
        .guest
        .write_all(&guest_control_proto::encode(MSG_ERROR, start.seq(), &[0]).unwrap())
        .await
        .unwrap();

    let err = copy_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    fixture.assert_readiness(NormalOperationReadiness::NotParkable);
    fixture.assert_host_bytes(b"old host log");
    fixture.assert_no_temp_files();
}

#[tokio::test]
async fn copy_file_error_response_releases_tracker_after_temp_cleanup() {
    let mut fixture =
        CopyFileFixture::new("guest-control-client-copy-error-response", "system.log").await;
    fixture.write_host_bytes(b"old host log");
    let copy_task = fixture.spawn_copy("/tmp/vm0-system-run.log", default_copy_options());

    let start = fixture.expect_start().await;
    fixture.assert_readiness(NormalOperationReadiness::Busy);

    send_guest_error(&mut fixture.guest, start.seq(), "guest copy failed").await;

    let err = copy_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("guest copy failed"));
    fixture.assert_readiness(NormalOperationReadiness::Idle);
    fixture.assert_host_bytes(b"old host log");
    fixture.assert_no_temp_files();
}

#[tokio::test]
async fn copy_file_connection_close_after_request_removes_temp_and_marks_not_parkable() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let temp_dir = HostTempDir::new("guest-control-client-copy-connection-close");
    let host_path = temp_dir.join("system.log");
    let copy_path = host_path.clone();

    let copy_task = spawn_copy_file(
        Arc::clone(&host),
        "/tmp/vm0-system-run.log",
        copy_path,
        default_copy_options(),
    );

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    drop(guest);
    let err = copy_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    assert!(!host_path.exists());
    temp_dir.assert_no_vm0tmp_files();
}

#[tokio::test]
async fn copy_file_terminal_result_before_connection_close_keeps_tracker_closed() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let temp_dir = HostTempDir::new("guest-control-client-copy-terminal-close");
    let host_path = temp_dir.join("system.log");
    let copy_path = host_path.clone();

    let copy_task = spawn_copy_file(
        Arc::clone(&host),
        "/tmp/vm0-system-run.log",
        copy_path,
        default_copy_options(),
    );

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    send_exec_output(
        &mut guest,
        msg.seq,
        0,
        ExecOutputStream::Stdout,
        b"complete\n",
        false,
    )
    .await;
    send_stream_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
    )
    .await;
    drop(guest);
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();

    let result = copy_task.await.unwrap().unwrap();
    assert_eq!(result.bytes_copied, 9);
    assert_eq!(std::fs::read(&host_path).unwrap(), b"complete\n");
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Closed
    );
}

#[tokio::test]
async fn copy_file_rename_failure_removes_temp_and_releases_tracker() {
    let mut fixture =
        CopyFileFixture::new("guest-control-client-copy-rename-failure", "system.log").await;
    std::fs::create_dir_all(&fixture.host_path).unwrap();
    let copy_task = fixture.spawn_copy("/tmp/vm0-system-run.log", default_copy_options());

    let start = fixture.expect_start().await;
    send_exec_output(
        &mut fixture.guest,
        start.seq(),
        0,
        ExecOutputStream::Stdout,
        b"complete\n",
        false,
    )
    .await;
    send_stream_exec_result(
        &mut fixture.guest,
        start.seq(),
        ExecTermination::Exited { exit_code: 0 },
        b"",
    )
    .await;

    copy_task.await.unwrap().unwrap_err();
    assert!(fixture.host_path.is_dir());
    fixture.assert_readiness(NormalOperationReadiness::Idle);
    fixture.assert_no_temp_files();
}

#[tokio::test]
async fn copy_file_nonzero_exit_removes_temp_without_publishing_partial_output() {
    let mut fixture = CopyFileFixture::new("guest-control-client-copy-nonzero", "system.log").await;
    fixture.write_host_bytes(b"old host log");
    let copy_task = fixture.spawn_copy("/tmp/vm0-system-run.log", default_copy_options());

    let msg = read_guest_message(&mut fixture.guest).await;
    send_exec_output(
        &mut fixture.guest,
        msg.seq,
        0,
        ExecOutputStream::Stdout,
        b"partial",
        false,
    )
    .await;
    send_stream_exec_result(
        &mut fixture.guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 1 },
        b"read error",
    )
    .await;

    let err = copy_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("read error"));
    fixture.assert_host_bytes(b"old host log");
    fixture.assert_no_temp_files();
}

#[tokio::test]
async fn copy_file_rejects_success_result_with_stderr() {
    let mut fixture =
        CopyFileFixture::new("guest-control-client-copy-success-stderr", "system.log").await;
    fixture.write_host_bytes(b"old host log");
    let copy_task = fixture.spawn_copy("/tmp/vm0-system-run.log", default_copy_options());

    let msg = read_guest_message(&mut fixture.guest).await;
    send_exec_output(
        &mut fixture.guest,
        msg.seq,
        0,
        ExecOutputStream::Stdout,
        b"new host log",
        false,
    )
    .await;
    send_stream_exec_result(
        &mut fixture.guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"unexpected stderr",
    )
    .await;

    let err = copy_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(err.to_string().contains("included stderr"));
    fixture.assert_readiness(NormalOperationReadiness::Idle);
    fixture.assert_host_bytes(b"old host log");
    fixture.assert_no_temp_files();
}

#[tokio::test]
async fn copy_file_missing_ok_leaves_no_final_or_temp_file() {
    let mut fixture = CopyFileFixture::new("guest-control-client-copy-missing", "system.log").await;
    let copy_task = fixture.spawn_copy("/tmp/missing.log", copy_options(1024, 5000, true));

    let msg = read_guest_message(&mut fixture.guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    fixture.assert_readiness(NormalOperationReadiness::Busy);
    let decoded = guest_control_proto::decode_exec_start(&msg.payload).unwrap();
    assert_eq!(decoded.expected_exit_codes, vec![66]);
    send_stream_exec_result(
        &mut fixture.guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 66 },
        b"",
    )
    .await;

    let result = copy_task.await.unwrap().unwrap();
    assert_eq!(result.bytes_copied, 0);
    fixture.assert_readiness(NormalOperationReadiness::Idle);
    fixture.assert_host_missing();
    fixture.assert_no_temp_files();
}

#[tokio::test]
async fn copy_file_missing_ok_preserves_existing_host_file() {
    let mut fixture =
        CopyFileFixture::new("guest-control-client-copy-missing-existing", "system.log").await;
    fixture.write_host_bytes(b"old host log");
    let copy_task = fixture.spawn_copy("/tmp/missing.log", copy_options(1024, 5000, true));

    let msg = read_guest_message(&mut fixture.guest).await;
    send_stream_exec_result(
        &mut fixture.guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 66 },
        b"",
    )
    .await;

    let result = copy_task.await.unwrap().unwrap();
    assert_eq!(result.bytes_copied, 0);
    fixture.assert_host_bytes(b"old host log");
    fixture.assert_no_temp_files();
}

#[tokio::test]
async fn copy_file_rejects_missing_ok_result_with_streamed_output() {
    let mut fixture =
        CopyFileFixture::new("guest-control-client-copy-missing-output", "system.log").await;
    fixture.write_host_bytes(b"old host log");
    let copy_task = fixture.spawn_copy("/tmp/missing.log", copy_options(1024, 5000, true));

    let msg = read_guest_message(&mut fixture.guest).await;
    send_exec_output(
        &mut fixture.guest,
        msg.seq,
        0,
        ExecOutputStream::Stdout,
        b"unexpected partial output",
        false,
    )
    .await;
    send_stream_exec_result(
        &mut fixture.guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 66 },
        b"",
    )
    .await;

    let err = copy_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(err.to_string().contains("missing result"));
    fixture.assert_readiness(NormalOperationReadiness::Idle);
    fixture.assert_host_bytes(b"old host log");
    fixture.assert_no_temp_files();
}

#[tokio::test]
async fn copy_file_rejects_missing_ok_result_with_stderr() {
    let mut fixture =
        CopyFileFixture::new("guest-control-client-copy-missing-stderr", "system.log").await;
    fixture.write_host_bytes(b"old host log");
    let copy_task = fixture.spawn_copy("/tmp/missing.log", copy_options(1024, 5000, true));

    let msg = read_guest_message(&mut fixture.guest).await;
    send_stream_exec_result(
        &mut fixture.guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 66 },
        b"unexpected stderr",
    )
    .await;

    let err = copy_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(err.to_string().contains("included stderr"));
    fixture.assert_readiness(NormalOperationReadiness::Idle);
    fixture.assert_host_bytes(b"old host log");
    fixture.assert_no_temp_files();
}

#[tokio::test]
async fn copy_file_missing_without_missing_ok_preserves_existing_file_and_removes_temp() {
    let mut fixture =
        CopyFileFixture::new("guest-control-client-copy-missing-error", "system.log").await;
    fixture.write_host_bytes(b"old host log");
    let copy_task = fixture.spawn_copy("/tmp/missing.log", default_copy_options());

    let msg = read_guest_message(&mut fixture.guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    let decoded = guest_control_proto::decode_exec_start(&msg.payload).unwrap();
    assert!(decoded.expected_exit_codes.is_empty());
    send_stream_exec_result(
        &mut fixture.guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 66 },
        b"",
    )
    .await;

    let err = copy_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::NotFound);
    fixture.assert_host_bytes(b"old host log");
    fixture.assert_no_temp_files();
}

#[tokio::test]
async fn copy_file_rejects_missing_without_missing_ok_after_streamed_output() {
    let mut fixture = CopyFileFixture::new(
        "guest-control-client-copy-missing-error-output",
        "system.log",
    )
    .await;
    fixture.write_host_bytes(b"old host log");
    let copy_task = fixture.spawn_copy("/tmp/missing.log", default_copy_options());

    let msg = read_guest_message(&mut fixture.guest).await;
    send_exec_output(
        &mut fixture.guest,
        msg.seq,
        0,
        ExecOutputStream::Stdout,
        b"unexpected output",
        false,
    )
    .await;
    send_stream_exec_result(
        &mut fixture.guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 66 },
        b"",
    )
    .await;

    let err = copy_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(err.to_string().contains("missing result"));
    fixture.assert_readiness(NormalOperationReadiness::Idle);
    fixture.assert_host_bytes(b"old host log");
    fixture.assert_no_temp_files();
}

#[tokio::test]
async fn copy_file_rejects_missing_without_missing_ok_with_stderr() {
    let mut fixture = CopyFileFixture::new(
        "guest-control-client-copy-missing-error-stderr",
        "system.log",
    )
    .await;
    fixture.write_host_bytes(b"old host log");
    let copy_task = fixture.spawn_copy("/tmp/missing.log", default_copy_options());

    let msg = read_guest_message(&mut fixture.guest).await;
    send_stream_exec_result(
        &mut fixture.guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 66 },
        b"unexpected stderr",
    )
    .await;

    let err = copy_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(err.to_string().contains("included stderr"));
    fixture.assert_readiness(NormalOperationReadiness::Idle);
    fixture.assert_host_bytes(b"old host log");
    fixture.assert_no_temp_files();
}

#[tokio::test]
async fn copy_file_cancellation_cancels_guest_exec_operation_and_removes_temp() {
    let mut fixture = CopyFileFixture::new("guest-control-client-copy-cancel", "system.log").await;
    let copy_task = fixture.spawn_copy("/tmp/vm0-system-run.log", default_copy_options());

    let start = fixture.expect_start().await;
    fixture.assert_readiness(NormalOperationReadiness::Busy);
    fixture.assert_temp_file_count(1);

    copy_task.abort();
    assert!(copy_task.await.unwrap_err().is_cancelled());
    fixture.assert_readiness(NormalOperationReadiness::NotParkable);

    let cancel = read_guest_message(&mut fixture.guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq());
    fixture.assert_host_missing();
    fixture.assert_no_temp_files();
}
