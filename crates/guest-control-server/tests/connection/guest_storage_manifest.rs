use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use guest_control_proto::{
    ExecCapturedOutput, ExecTermination, GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES,
    MSG_GUEST_STORAGE_MANIFEST, MSG_GUEST_STORAGE_MANIFEST_RESULT, MSG_OPERATIONS_QUIESCED,
};

use super::support::*;

mod resources;

fn create_program(body: &str) -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("guest-storage-apply-test");
    std::fs::write(&path, format!("#!/bin/sh\nset -eu\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    (directory, path)
}

fn send_request(
    stream: &mut impl Write,
    seq: u32,
    timeout_ms: u32,
    run_id: &str,
    runtime_dir: &str,
    manifest_json: &[u8],
) {
    let payload = guest_control_proto::encode_guest_storage_manifest_request(
        timeout_ms,
        run_id,
        runtime_dir,
        manifest_json,
    )
    .unwrap();
    let frame = guest_control_proto::encode(MSG_GUEST_STORAGE_MANIFEST, seq, &payload).unwrap();
    stream.write_all(&frame).unwrap();
}

struct TestResult {
    resources: Vec<u8>,
    termination: ExecTermination,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_truncated: bool,
    stderr_truncated: bool,
    diagnostic: String,
}

fn read_result(stream: &mut impl std::io::Read, seq: u32) -> TestResult {
    let message = read_message(stream);
    assert_eq!(message.msg_type, MSG_GUEST_STORAGE_MANIFEST_RESULT);
    assert_eq!(message.seq, seq);
    let decoded =
        guest_control_proto::decode_guest_storage_manifest_result(&message.payload).unwrap();
    let resources = decoded.resource_summary.to_vec();
    let decoded = decoded.result;
    let (stdout, stdout_truncated) = captured(decoded.stdout);
    let (stderr, stderr_truncated) = captured(decoded.stderr);
    TestResult {
        resources,
        termination: decoded.termination,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
        diagnostic: decoded.diagnostic.to_owned(),
    }
}

fn captured(output: ExecCapturedOutput<'_>) -> (Vec<u8>, bool) {
    match output {
        ExecCapturedOutput::Captured { bytes, truncated } => (bytes.to_vec(), truncated),
        ExecCapturedOutput::Discarded => panic!("storage helper output must be captured"),
    }
}

fn slow_program(pid_path: &Path) -> String {
    format!(
        "cat >/dev/null; sleep 60 & printf '%s' \"$$\" > '{}'; wait",
        pid_path.display()
    )
}

fn start_with_timeout_gate(
    program: PathBuf,
    resource_path: Option<PathBuf>,
) -> (
    thread::JoinHandle<std::io::Result<()>>,
    UnixStream,
    mpsc::Receiver<u32>,
) {
    // The protocol cannot order helper readiness before its timeout. Gate only
    // the test executable; assertions still exercise the real timed wait and RPC.
    let (timeout_tx, timeout_rx) = mpsc::sync_channel(0);
    let (guest, mut host) = UnixStream::pair().unwrap();
    host.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let handle = thread::spawn(move || {
        guest_control_server::handle_connection_with_test_storage_manifest_timeout_gate(
            guest,
            program,
            resource_path,
            timeout_tx,
        )
    });
    read_guest_ready(&mut host);
    (handle, host, timeout_rx)
}

#[test]
fn guest_storage_manifest_runs_fixed_argv_env_and_stdin() {
    let (_directory, program) = create_program(
        r#"
[ "$1" = "--manifest-stdin" ]
[ "$OKOU_RUN_ID" = "run-1" ]
[ "$OKOU_GUEST_RUNTIME_DIR" = "/run/vm0/runs/run-1" ]
[ "$(cat)" = '{"storages":[]}' ]
printf 'applied\n'
printf 'helper stderr\n' >&2
"#,
    );
    let (handle, mut host_stream) = start_guest_connection_with_storage_manifest_program(program);

    send_request(
        &mut host_stream,
        401,
        1_000,
        "run-1",
        "/run/vm0/runs/run-1",
        br#"{"storages":[]}"#,
    );
    let result = read_result(&mut host_stream, 401);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, b"applied\n");
    assert_eq!(result.stderr, b"helper stderr\n");
    assert!(!result.stdout_truncated);
    assert!(!result.stderr_truncated);
    assert!(result.diagnostic.is_empty());
    finish_guest_connection(handle, host_stream);
}

#[test]
fn guest_storage_manifest_returns_nonzero_exit_and_captured_diagnostic_output() {
    let (_directory, program) = create_program(
        r#"
cat >/dev/null
printf 'manifest failed\n' >&2
exit 7
"#,
    );
    let (handle, mut host_stream) = start_guest_connection_with_storage_manifest_program(program);

    send_request(&mut host_stream, 411, 1_000, "run", "/run", b"{}");
    let result = read_result(&mut host_stream, 411);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 7 });
    assert!(result.stdout.is_empty());
    assert_eq!(result.stderr, b"manifest failed\n");
    assert!(!result.stdout_truncated);
    assert!(!result.stderr_truncated);
    assert!(result.diagnostic.is_empty());
    finish_guest_connection(handle, host_stream);
}

#[test]
fn guest_storage_manifest_bounds_both_output_streams() {
    let output_bytes = GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES + 1_024;
    let (_directory, program) = create_program(&format!(
        "cat >/dev/null; head -c {output_bytes} /dev/zero | tr '\\000' x; head -c {output_bytes} /dev/zero | tr '\\000' y >&2"
    ));
    let (handle, mut host_stream) = start_guest_connection_with_storage_manifest_program(program);

    send_request(&mut host_stream, 402, 5_000, "run", "/run", b"{}");
    let result = read_result(&mut host_stream, 402);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(
        result.stdout.len(),
        GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES
    );
    assert_eq!(
        result.stderr.len(),
        GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES
    );
    assert!(result.stdout_truncated);
    assert!(result.stderr_truncated);
    finish_guest_connection(handle, host_stream);
}

#[test]
fn guest_storage_manifest_timeout_kills_and_reaps_process_group() {
    let pid_path = unique_pid_path("storage-manifest-timeout");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&slow_program(Path::new(pid_path.as_str())));
    let (handle, mut host_stream, timeout_gate) = start_with_timeout_gate(program, None);

    send_request(&mut host_stream, 403, 20, "run", "/run", b"{}");
    let pid = process_guard.read_pid();
    assert_eq!(
        timeout_gate.recv_timeout(Duration::from_secs(3)).unwrap(),
        pid
    );
    let result = read_result(&mut host_stream, 403);

    assert_eq!(result.termination, ExecTermination::TimedOut);
    wait_for_pid_exit(pid, "guest storage manifest timeout");
    process_guard.disarm();
    finish_guest_connection(handle, host_stream);
}

#[test]
fn decoded_storage_timeout_reaps_helper_without_reading_blocked_bulk_stdin() {
    use guest_contracts::storage_files::{self, StorageFile};
    let pid_path = unique_pid_path("storage-files-timeout");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&format!(
        "[ \"$1\" = --storage-files-stdin ]; sleep 60 & printf '%s' \"$$\" > '{}'; wait",
        pid_path.as_str()
    ));
    let (handle, mut host, timeout_gate) = start_with_timeout_gate(program, None);
    let files = vec![StorageFile {
        path: "file".into(),
        mode: 0o644,
        mtime: 1,
        content: vec![42; 256 * 1024],
    }];
    let input = storage_files::encode_input(b"{}", &[("/mount", &files)]).unwrap();
    send_request(&mut host, 414, 20, "run", "/run", &input);
    let pid = process_guard.read_pid();
    assert_eq!(
        timeout_gate.recv_timeout(Duration::from_secs(3)).unwrap(),
        pid
    );
    let result = read_result(&mut host, 414);
    assert_eq!(result.termination, ExecTermination::TimedOut);
    wait_for_pid_exit(pid, "decoded storage blocked input timeout");
    process_guard.disarm();
    finish_guest_connection(handle, host);
}

#[test]
fn guest_storage_manifest_can_timeout_before_helper_readiness() {
    let fifo = unique_tmp_path("storage-manifest-not-ready", ".fifo");
    let (_directory, program) = create_program(&format!(
        "mkfifo '{}'; read -r ready < '{}'; printf ready",
        fifo.as_str(),
        fifo.as_str(),
    ));
    let (handle, mut host, timeout_gate) = start_with_timeout_gate(program, None);

    send_request(&mut host, 412, 20, "run", "/run", b"{}");
    // No FIFO writer exists: readiness is impossible even if the shell starts.
    // Observe the server-owned identity without relying on a helper PID file.
    let pid = timeout_gate.recv_timeout(Duration::from_secs(3)).unwrap();
    let result = read_result(&mut host, 412);
    wait_for_pid_exit(pid, "storage timeout before helper readiness");
    assert_eq!(result.termination, ExecTermination::TimedOut);
    assert!(result.stdout.is_empty());
    finish_guest_connection(handle, host);
}

#[test]
fn guest_storage_manifest_abandoned_timeout_gate_allows_connection_cleanup() {
    let pid_path = unique_pid_path("storage-manifest-abandoned-gate");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&slow_program(Path::new(pid_path.as_str())));
    let (handle, mut host, timeout_gate) = start_with_timeout_gate(program, None);

    send_request(&mut host, 413, 60_000, "run", "/run", b"{}");
    let pid = process_guard.read_pid();
    drop(timeout_gate);
    drop(host);
    join_guest_connection(handle);

    wait_for_pid_exit(pid, "abandoned storage timeout gate");
    process_guard.disarm();
}

#[test]
fn guest_storage_manifest_natural_exit_cleans_remaining_process_group() {
    let pid_path = unique_pid_path("storage-manifest-natural-exit");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&format!(
        "cat >/dev/null; sleep 60 & printf '%s' \"$!\" > '{}'; printf 'applied\\n'",
        pid_path.as_str()
    ));
    let (handle, mut host_stream) = start_guest_connection_with_storage_manifest_program(program);

    send_request(&mut host_stream, 408, 1_000, "run", "/run", b"{}");
    let pid = process_guard.read_pid();
    let result = read_result(&mut host_stream, 408);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, b"applied\n");
    wait_for_pid_exit(pid, "guest storage manifest natural exit");
    process_guard.disarm();
    finish_guest_connection(handle, host_stream);
}

#[test]
fn guest_storage_manifest_connection_close_kills_and_reaps_process_group() {
    let pid_path = unique_pid_path("storage-manifest-disconnect");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&slow_program(Path::new(pid_path.as_str())));
    let (handle, mut host_stream) = start_guest_connection_with_storage_manifest_program(program);

    send_request(&mut host_stream, 404, 60_000, "run", "/run", b"{}");
    let pid = process_guard.read_pid();
    drop(host_stream);
    join_guest_connection(handle);

    wait_for_pid_exit(pid, "guest storage manifest connection close");
    process_guard.disarm();
}

#[test]
fn guest_storage_manifest_rejects_concurrent_request_and_cleans_active_process() {
    let pid_path = unique_pid_path("storage-manifest-busy");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&slow_program(Path::new(pid_path.as_str())));
    let (handle, mut host_stream) = start_guest_connection_with_storage_manifest_program(program);

    send_request(&mut host_stream, 409, 60_000, "run", "/run", b"{}");
    let pid = process_guard.read_pid();
    send_request(&mut host_stream, 410, 1_000, "run", "/run", b"{}");
    let error = read_error_response(&mut host_stream, 410);
    assert!(error.contains("already active"));

    drop(host_stream);
    join_guest_connection(handle);
    wait_for_pid_exit(pid, "guest storage manifest busy connection close");
    process_guard.disarm();
}

#[test]
fn guest_storage_manifest_validates_request_and_obeys_quiesce_gate() {
    let marker = unique_tmp_path("storage-manifest-quiesce", ".marker");
    let (_directory, program) = create_program(&format!("touch '{}'; exit 0", marker.as_str()));
    let (handle, mut host_stream) = start_guest_connection_with_storage_manifest_program(program);

    let malformed = guest_control_proto::encode(MSG_GUEST_STORAGE_MANIFEST, 405, b"bad").unwrap();
    host_stream.write_all(&malformed).unwrap();
    let malformed_error = read_error_response(&mut host_stream, 405);
    assert!(malformed_error.contains("timeout_ms truncated"));

    send_quiesce_operations(&mut host_stream, 406);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);
    send_request(&mut host_stream, 407, 1_000, "run", "/run", b"{}");
    let quiesce_error = read_error_response(&mut host_stream, 407);
    assert!(quiesce_error.contains("operations are quiescing"));
    assert!(!Path::new(marker.as_str()).exists());

    finish_guest_connection(handle, host_stream);
}
