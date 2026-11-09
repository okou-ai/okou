use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use guest_control_proto::{
    DecodedExecStart, ExecOutputPolicy, MSG_ERROR, MSG_EXEC_START, MSG_WRITE_FILE,
    MSG_WRITE_FILE_RESULT, MSG_WRITE_FILES, MSG_WRITE_FILES_RESULT, MSG_WRITE_PRIVATE_FILES,
    RawMessage,
};
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::task::JoinHandle;
use uuid::Uuid;

use super::super::support::read_guest_message;
use crate::{CopyFileOptions, CopyFileResult, GuestControlClient, WriteFileEntry};

pub(super) struct HostTempDir {
    directory: tempfile::TempDir,
}

pub(super) fn unique_temp_path(prefix: &str) -> PathBuf {
    std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()))
}

pub(super) struct HostTempPath {
    path: PathBuf,
}

impl HostTempPath {
    pub(super) fn new(prefix: &str) -> Self {
        Self {
            path: unique_temp_path(prefix),
        }
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn join(&self, path: impl AsRef<Path>) -> PathBuf {
        self.path.join(path)
    }
}

impl Drop for HostTempPath {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

impl HostTempDir {
    pub(super) fn new(prefix: &str) -> Self {
        let directory = tempfile::Builder::new()
            .prefix(&format!("{prefix}-"))
            .tempdir()
            .unwrap();
        Self { directory }
    }

    pub(super) fn path(&self) -> &Path {
        self.directory.path()
    }

    pub(super) fn join(&self, path: impl AsRef<Path>) -> PathBuf {
        self.path().join(path)
    }

    pub(super) fn assert_no_vm0tmp_files(&self) {
        assert_no_vm0tmp_files(self.path());
    }
}

pub(super) fn assert_no_vm0tmp_files(dir: &Path) {
    assert!(
        std::fs::read_dir(dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("vm0tmp")),
        "file operation temp file should not remain"
    );
}

pub(super) fn default_copy_options() -> CopyFileOptions {
    CopyFileOptions {
        max_bytes: 1024,
        timeout_ms: 5000,
        missing_ok: false,
    }
}

pub(super) fn copy_options(max_bytes: u64, timeout_ms: u32, missing_ok: bool) -> CopyFileOptions {
    CopyFileOptions {
        max_bytes,
        timeout_ms,
        missing_ok,
    }
}

pub(super) fn spawn_copy_file(
    host: Arc<GuestControlClient>,
    guest_path: &'static str,
    host_path: PathBuf,
    options: CopyFileOptions,
) -> JoinHandle<io::Result<CopyFileResult>> {
    tokio::spawn(async move { host.copy_file(guest_path, &host_path, options).await })
}

pub(super) fn spawn_write_file(
    host: Arc<GuestControlClient>,
    path: &'static str,
    content: Vec<u8>,
    sudo: bool,
) -> JoinHandle<io::Result<()>> {
    tokio::spawn(async move { host.write_file(path, &content, sudo).await })
}

pub(super) fn spawn_write_private_file(
    host: Arc<GuestControlClient>,
    path: &'static str,
    content: Vec<u8>,
) -> JoinHandle<io::Result<()>> {
    tokio::spawn(async move { host.write_private_file(path, &content).await })
}

pub(super) fn spawn_write_files(
    host: Arc<GuestControlClient>,
    files: Vec<(&'static str, Vec<u8>)>,
) -> JoinHandle<io::Result<()>> {
    tokio::spawn(async move {
        let entries = files
            .iter()
            .map(|(path, content)| WriteFileEntry {
                path,
                content: content.as_slice(),
            })
            .collect::<Vec<_>>();
        host.write_files(&entries).await
    })
}

pub(super) fn spawn_write_private_files(
    host: Arc<GuestControlClient>,
    files: Vec<(&'static str, Vec<u8>)>,
) -> JoinHandle<io::Result<()>> {
    tokio::spawn(async move {
        let entries = files
            .iter()
            .map(|(path, content)| WriteFileEntry {
                path,
                content: content.as_slice(),
            })
            .collect::<Vec<_>>();
        host.write_private_files(&entries).await
    })
}

pub(super) struct ExecStartFrame {
    pub(super) msg: RawMessage,
    pub(super) command: String,
    pub(super) label: String,
    pub(super) sudo: bool,
    pub(super) stdout: ExecOutputPolicy,
    pub(super) stderr: ExecOutputPolicy,
    pub(super) expected_exit_codes: Vec<i32>,
}

impl ExecStartFrame {
    pub(super) fn seq(&self) -> u32 {
        self.msg.seq
    }
}

pub(super) async fn expect_exec_start(guest: &mut UnixStream) -> ExecStartFrame {
    let msg = read_guest_message(guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    let (command, label, sudo, stdout, stderr, expected_exit_codes) = {
        let decoded = guest_control_proto::decode_exec_start(&msg.payload).unwrap();
        exec_start_frame_fields(decoded)
    };
    ExecStartFrame {
        msg,
        command,
        label,
        sudo,
        stdout,
        stderr,
        expected_exit_codes,
    }
}

fn exec_start_frame_fields(
    decoded: DecodedExecStart<'_>,
) -> (
    String,
    String,
    bool,
    ExecOutputPolicy,
    ExecOutputPolicy,
    Vec<i32>,
) {
    (
        decoded.command.to_string(),
        decoded.label.to_string(),
        decoded.sudo,
        decoded.stdout,
        decoded.stderr,
        decoded.expected_exit_codes,
    )
}

pub(super) struct WriteFileFrame {
    pub(super) msg: RawMessage,
    pub(super) path: String,
    pub(super) content: Vec<u8>,
    pub(super) sudo: bool,
    pub(super) append: bool,
    pub(super) private: bool,
}

impl WriteFileFrame {
    pub(super) fn seq(&self) -> u32 {
        self.msg.seq
    }
}

pub(super) struct WriteFilesFrame {
    pub(super) msg: RawMessage,
    pub(super) files: Vec<(String, Vec<u8>)>,
}

impl WriteFilesFrame {
    pub(super) fn seq(&self) -> u32 {
        self.msg.seq
    }
}

pub(super) async fn expect_write_file(guest: &mut UnixStream) -> WriteFileFrame {
    let msg = read_guest_message(guest).await;
    assert_eq!(msg.msg_type, MSG_WRITE_FILE);
    let (path, content, sudo, append, private) = {
        let (path, content, sudo, append, private) =
            guest_control_proto::decode_write_file(&msg.payload).unwrap();
        (path.to_string(), content.to_vec(), sudo, append, private)
    };
    WriteFileFrame {
        msg,
        path,
        content,
        sudo,
        append,
        private,
    }
}

pub(super) async fn expect_write_files(guest: &mut UnixStream) -> WriteFilesFrame {
    expect_write_files_message(guest, MSG_WRITE_FILES).await
}

pub(super) async fn expect_write_private_files(guest: &mut UnixStream) -> WriteFilesFrame {
    expect_write_files_message(guest, MSG_WRITE_PRIVATE_FILES).await
}

async fn expect_write_files_message(
    guest: &mut UnixStream,
    expected_msg_type: u8,
) -> WriteFilesFrame {
    let msg = read_guest_message(guest).await;
    assert_eq!(msg.msg_type, expected_msg_type);
    let files = guest_control_proto::decode_write_files(&msg.payload)
        .unwrap()
        .into_iter()
        .map(|file| (file.path.to_string(), file.content.to_vec()))
        .collect();
    WriteFilesFrame { msg, files }
}

pub(super) async fn send_write_file_success(guest: &mut UnixStream, seq: u32) {
    send_write_file_result(guest, seq, true, "").await;
}

pub(super) async fn send_write_file_failure(guest: &mut UnixStream, seq: u32, message: &str) {
    send_write_file_result(guest, seq, false, message).await;
}

pub(super) async fn send_write_file_result(
    guest: &mut UnixStream,
    seq: u32,
    success: bool,
    message: &str,
) {
    let payload = guest_control_proto::encode_write_file_result(success, message);
    guest
        .write_all(&guest_control_proto::encode(MSG_WRITE_FILE_RESULT, seq, &payload).unwrap())
        .await
        .unwrap();
}

pub(super) async fn send_write_files_success(guest: &mut UnixStream, seq: u32) {
    send_write_files_result(guest, seq, true, "").await;
}

pub(super) async fn send_write_files_failure(guest: &mut UnixStream, seq: u32, message: &str) {
    send_write_files_result(guest, seq, false, message).await;
}

pub(super) async fn send_write_files_result(
    guest: &mut UnixStream,
    seq: u32,
    success: bool,
    message: &str,
) {
    let payload = guest_control_proto::encode_write_files_result(success, message);
    guest
        .write_all(&guest_control_proto::encode(MSG_WRITE_FILES_RESULT, seq, &payload).unwrap())
        .await
        .unwrap();
}

pub(super) async fn send_guest_error(guest: &mut UnixStream, seq: u32, message: &str) {
    let payload = guest_control_proto::encode_error(message);
    guest
        .write_all(&guest_control_proto::encode(MSG_ERROR, seq, &payload).unwrap())
        .await
        .unwrap();
}
