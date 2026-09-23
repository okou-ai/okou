use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use guest_control_proto::{
    ExecCapturedOutput, ExecTermination, MSG_OPERATIONS_QUIESCED, MSG_WORKSPACE_DRIVE_MOUNT,
    MSG_WORKSPACE_DRIVE_MOUNT_RESULT, WORKSPACE_DRIVE_MOUNT_OUTPUT_LIMIT_BYTES,
};

use super::support::*;

fn create_program(body: &str) -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace-mount-test");
    std::fs::write(&path, format!("#!/bin/sh\nset -eu\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    (directory, path)
}

fn send_request(stream: &mut impl Write, seq: u32) {
    let mut frame = Vec::new();
    guest_control_proto::encode_workspace_drive_mount_request_frame_into(&mut frame, seq).unwrap();
    stream.write_all(&frame).unwrap();
}

struct TestResult {
    termination: ExecTermination,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_truncated: bool,
    stderr_truncated: bool,
    diagnostic: String,
}

fn read_result(stream: &mut impl std::io::Read, seq: u32) -> TestResult {
    let message = read_message(stream);
    assert_eq!(message.msg_type, MSG_WORKSPACE_DRIVE_MOUNT_RESULT);
    assert_eq!(message.seq, seq);
    let decoded =
        guest_control_proto::decode_workspace_drive_mount_result(&message.payload).unwrap();
    let (stdout, stdout_truncated) = captured(decoded.stdout);
    let (stderr, stderr_truncated) = captured(decoded.stderr);
    TestResult {
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
        ExecCapturedOutput::Discarded => panic!("workspace mount output must be captured"),
    }
}

fn slow_program(pid_path: &Path) -> String {
    format!("printf '%s' \"$$\" > '{}'; sleep 60", pid_path.display())
}

#[test]
fn workspace_drive_mount_runs_only_the_fixed_command() {
    let (_directory, program) = create_program(
        r#"
[ "$#" -eq 0 ]
printf 'mounted\n'
printf 'helper stderr\n' >&2
"#,
    );
    let (handle, mut host_stream) =
        start_guest_connection_with_workspace_drive_mount_program(program, 1_000);

    send_request(&mut host_stream, 501);
    let result = read_result(&mut host_stream, 501);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, b"mounted\n");
    assert_eq!(result.stderr, b"helper stderr\n");
    assert!(!result.stdout_truncated);
    assert!(!result.stderr_truncated);
    assert!(result.diagnostic.is_empty());
    finish_guest_connection(handle, host_stream);
}

#[test]
fn workspace_drive_mount_accepts_second_request_on_same_connection() {
    let runs = unique_tmp_path("workspace-mount-sequential-runs", ".txt");
    let (_directory, program) =
        create_program(&format!("printf 'mounted\\n' >> '{}'", runs.as_str()));
    let (handle, mut host_stream) =
        start_guest_connection_with_workspace_drive_mount_program(program, 1_000);

    send_request(&mut host_stream, 513);
    let first = read_result(&mut host_stream, 513);
    assert_eq!(first.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(std::fs::read(runs.as_str()).unwrap(), b"mounted\n");

    send_request(&mut host_stream, 514);
    let second = read_result(&mut host_stream, 514);
    assert_eq!(second.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(std::fs::read(runs.as_str()).unwrap(), b"mounted\nmounted\n");

    finish_guest_connection(handle, host_stream);
}

#[test]
fn workspace_drive_mount_returns_nonzero_exit_and_output() {
    let (_directory, program) = create_program(
        r#"
printf 'mount failed\n' >&2
exit 64
"#,
    );
    let (handle, mut host_stream) =
        start_guest_connection_with_workspace_drive_mount_program(program, 1_000);

    send_request(&mut host_stream, 502);
    let result = read_result(&mut host_stream, 502);

    assert_eq!(
        result.termination,
        ExecTermination::Exited { exit_code: 64 }
    );
    assert!(result.stdout.is_empty());
    assert_eq!(result.stderr, b"mount failed\n");
    assert!(result.diagnostic.is_empty());
    finish_guest_connection(handle, host_stream);
}

#[test]
fn workspace_drive_mount_reports_start_failure() {
    let missing_program = unique_tmp_path("workspace-mount-missing-program", ".sh");
    let (handle, mut host_stream) = start_guest_connection_with_workspace_drive_mount_program(
        PathBuf::from(missing_program.as_str()),
        1_000,
    );

    send_request(&mut host_stream, 512);
    let result = read_result(&mut host_stream, 512);

    assert_eq!(result.termination, ExecTermination::StartFailed);
    assert!(result.stdout.is_empty());
    assert!(result.stderr.is_empty());
    assert!(
        result
            .diagnostic
            .contains("Failed to start workspace mount helper")
    );
    finish_guest_connection(handle, host_stream);
}

#[test]
fn workspace_drive_mount_bounds_both_output_streams() {
    let output_bytes = WORKSPACE_DRIVE_MOUNT_OUTPUT_LIMIT_BYTES + 1_024;
    let (_directory, program) = create_program(&format!(
        "head -c {output_bytes} /dev/zero | tr '\\000' x; head -c {output_bytes} /dev/zero | tr '\\000' y >&2"
    ));
    let (handle, mut host_stream) =
        start_guest_connection_with_workspace_drive_mount_program(program, 5_000);

    send_request(&mut host_stream, 503);
    let result = read_result(&mut host_stream, 503);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(
        result.stdout.len(),
        WORKSPACE_DRIVE_MOUNT_OUTPUT_LIMIT_BYTES
    );
    assert_eq!(
        result.stderr.len(),
        WORKSPACE_DRIVE_MOUNT_OUTPUT_LIMIT_BYTES
    );
    assert!(result.stdout_truncated);
    assert!(result.stderr_truncated);
    finish_guest_connection(handle, host_stream);
}

#[test]
fn workspace_drive_mount_timeout_kills_and_reaps_process_group() {
    let pid_path = unique_pid_path("workspace-mount-timeout");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&slow_program(Path::new(pid_path.as_str())));
    let (handle, mut host_stream) =
        start_guest_connection_with_workspace_drive_mount_program(program, 20);

    send_request(&mut host_stream, 504);
    let pid = process_guard.read_pid();
    let result = read_result(&mut host_stream, 504);

    assert_eq!(result.termination, ExecTermination::TimedOut);
    wait_for_pid_exit(pid, "workspace mount timeout");
    process_guard.disarm();
    finish_guest_connection(handle, host_stream);
}

#[test]
fn workspace_drive_mount_natural_exit_cleans_remaining_process_group() {
    let pid_path = unique_pid_path("workspace-mount-natural-exit");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&format!(
        "sleep 60 & printf '%s' \"$!\" > '{}'; printf 'mounted\\n'",
        pid_path.as_str()
    ));
    let (handle, mut host_stream) =
        start_guest_connection_with_workspace_drive_mount_program(program, 1_000);

    send_request(&mut host_stream, 505);
    let pid = process_guard.read_pid();
    let result = read_result(&mut host_stream, 505);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, b"mounted\n");
    wait_for_pid_exit(pid, "workspace mount natural exit");
    process_guard.disarm();
    finish_guest_connection(handle, host_stream);
}

#[test]
fn workspace_drive_mount_connection_close_kills_and_reaps_process_group() {
    let pid_path = unique_pid_path("workspace-mount-disconnect");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&slow_program(Path::new(pid_path.as_str())));
    let (handle, mut host_stream) =
        start_guest_connection_with_workspace_drive_mount_program(program, 60_000);

    send_request(&mut host_stream, 506);
    let pid = process_guard.read_pid();
    drop(host_stream);
    join_guest_connection(handle);

    wait_for_pid_exit(pid, "workspace mount connection close");
    process_guard.disarm();
}

#[test]
fn workspace_drive_mount_rejects_concurrent_request_and_cleans_active_process() {
    let pid_path = unique_pid_path("workspace-mount-busy");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&slow_program(Path::new(pid_path.as_str())));
    let (handle, mut host_stream) =
        start_guest_connection_with_workspace_drive_mount_program(program, 60_000);

    send_request(&mut host_stream, 507);
    let pid = process_guard.read_pid();
    send_request(&mut host_stream, 508);
    let error = read_error_response(&mut host_stream, 508);
    assert!(error.contains("already active"));

    drop(host_stream);
    join_guest_connection(handle);
    wait_for_pid_exit(pid, "workspace mount concurrent request");
    process_guard.disarm();
}

#[test]
fn workspace_drive_mount_validates_empty_request_and_obeys_quiesce_gate() {
    let marker = unique_tmp_path("workspace-mount-quiesce", ".marker");
    let (_directory, program) = create_program(&format!("touch '{}'; exit 0", marker.as_str()));
    let (handle, mut host_stream) =
        start_guest_connection_with_workspace_drive_mount_program(program, 1_000);

    let malformed =
        guest_control_proto::encode(MSG_WORKSPACE_DRIVE_MOUNT, 509, b"unexpected").unwrap();
    host_stream.write_all(&malformed).unwrap();
    let malformed_error = read_error_response(&mut host_stream, 509);
    assert!(malformed_error.contains("payload must be empty"));

    send_quiesce_operations(&mut host_stream, 510);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);
    send_request(&mut host_stream, 511);
    let quiesce_error = read_error_response(&mut host_stream, 511);
    assert!(quiesce_error.contains("operations are quiescing"));
    assert!(!Path::new(marker.as_str()).exists());

    finish_guest_connection(handle, host_stream);
}
