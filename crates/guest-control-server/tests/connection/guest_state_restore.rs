use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use guest_contracts::agent_instructions::RestoredInstructionCheck;
use guest_control_proto::{
    DecodedGuestStateRestoreRequest, ExecCapturedOutput, ExecTermination,
    GuestStateRestoreTimezone, MSG_GUEST_STATE_RESTORE, MSG_GUEST_STATE_RESTORE_RESULT,
    MSG_OPERATIONS_QUIESCED,
};

use super::support::*;

fn create_program(body: &str) -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("guest-state-restore-test");
    std::fs::write(&path, format!("#!/bin/sh\nset -eu\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    (directory, path)
}

fn entropy() -> [u8; 256] {
    [b'x'; 256]
}

fn send_request(
    stream: &mut impl Write,
    seq: u32,
    timeout_ms: u32,
    timezone: GuestStateRestoreTimezone<'_>,
) {
    let payload = guest_control_proto::encode_guest_state_restore_request(
        timeout_ms,
        1_778_000_000,
        123_000_000,
        &entropy(),
        timezone,
    )
    .unwrap();
    let frame = guest_control_proto::encode(MSG_GUEST_STATE_RESTORE, seq, &payload).unwrap();
    stream.write_all(&frame).unwrap();
}

struct TestResult {
    termination: ExecTermination,
    stderr: Vec<u8>,
    stderr_truncated: bool,
    diagnostic: String,
}

fn read_result(stream: &mut impl std::io::Read, seq: u32) -> TestResult {
    let message = read_message(stream);
    assert_eq!(message.msg_type, MSG_GUEST_STATE_RESTORE_RESULT);
    assert_eq!(message.seq, seq);
    let decoded = guest_control_proto::decode_guest_state_restore_result(&message.payload).unwrap();
    let (stderr, stderr_truncated) = match decoded.stderr {
        ExecCapturedOutput::Captured { bytes, truncated } => (bytes.to_vec(), truncated),
        ExecCapturedOutput::Discarded => panic!("guest state stderr must be captured"),
    };
    TestResult {
        termination: decoded.termination,
        stderr,
        stderr_truncated,
        diagnostic: decoded.diagnostic.to_owned(),
    }
}

fn slow_program(pid_path: &Path) -> String {
    format!(
        "printf '%s' \"$$\" > '{}'; cat >/dev/null; sleep 60",
        pid_path.display()
    )
}

#[test]
fn guest_state_restore_runs_fixed_root_helper_argv_and_entropy_stdin() {
    let (_directory, program) = create_program(
        r#"
[ "$1" = "--restore-state" ]
[ "$2" = "1778000000" ]
[ "$3" = "123000000" ]
[ "$4" = "required" ]
[ "$5" = "Asia/Shanghai" ]
[ "$(wc -c)" = "256" ]
printf 'helper stderr\n' >&2
"#,
    );
    let (handle, mut host_stream) =
        start_guest_connection_with_guest_state_restore_program(program);

    send_request(
        &mut host_stream,
        501,
        1_000,
        GuestStateRestoreTimezone::Required("Asia/Shanghai"),
    );
    let result = read_result(&mut host_stream, 501);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stderr, b"helper stderr\n");
    assert!(!result.stderr_truncated);
    assert!(result.diagnostic.is_empty());
    finish_guest_connection(handle, host_stream);
}

#[test]
fn guest_state_restore_passes_instruction_check_to_the_fixed_helper() {
    let (_directory, program) = create_program(
        r#"
[ "$#" = "6" ]
[ "$1" = "--check-instructions" ]
[ "$2" = '{"framework":"codex","check_memory_root":true}' ]
[ "$3" = "--restore-state" ]
[ "$4" = "1778000000" ]
[ "$5" = "123000000" ]
[ "$6" = "none" ]
[ "$(wc -c)" = "256" ]
exit 12
"#,
    );
    let (handle, mut host_stream) =
        start_guest_connection_with_guest_state_restore_program(program);
    let mut frame = Vec::new();
    guest_control_proto::encode_guest_state_restore_frame(
        &mut frame,
        510,
        DecodedGuestStateRestoreRequest {
            timeout_ms: 1_000,
            unix_seconds: 1_778_000_000,
            unix_nanoseconds: 123_000_000,
            entropy: &entropy(),
            timezone: GuestStateRestoreTimezone::None,
            instruction_check: Some(r#"{"framework":"codex","check_memory_root":true}"#),
        },
    )
    .unwrap();
    host_stream.write_all(&frame).unwrap();

    let result = read_result(&mut host_stream, 510);
    assert_eq!(
        result.termination,
        ExecTermination::Exited {
            exit_code: RestoredInstructionCheck::CurrentWithMemory as i32,
        }
    );
    assert!(result.stderr.is_empty());
    assert!(result.diagnostic.is_empty());
    finish_guest_connection(handle, host_stream);
}

#[test]
fn guest_state_restore_returns_nonzero_exit_and_bounded_stderr() {
    let output_bytes = guest_control_proto::GUEST_STATE_RESTORE_OUTPUT_LIMIT_BYTES + 1_024;
    let (_directory, program) = create_program(&format!(
        "cat >/dev/null; head -c {output_bytes} /dev/zero | tr '\\000' y >&2; exit 7"
    ));
    let (handle, mut host_stream) =
        start_guest_connection_with_guest_state_restore_program(program);

    send_request(
        &mut host_stream,
        502,
        5_000,
        GuestStateRestoreTimezone::None,
    );
    let result = read_result(&mut host_stream, 502);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 7 });
    assert_eq!(
        result.stderr.len(),
        guest_control_proto::GUEST_STATE_RESTORE_OUTPUT_LIMIT_BYTES
    );
    assert!(result.stderr_truncated);
    finish_guest_connection(handle, host_stream);
}

#[test]
fn guest_state_restore_timeout_kills_and_reaps_process_group() {
    let pid_path = unique_pid_path("guest-state-timeout");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&slow_program(Path::new(pid_path.as_str())));
    let (handle, mut host_stream) =
        start_guest_connection_with_guest_state_restore_program(program);

    send_request(&mut host_stream, 503, 20, GuestStateRestoreTimezone::None);
    let pid = process_guard.read_pid();
    let result = read_result(&mut host_stream, 503);

    assert_eq!(result.termination, ExecTermination::TimedOut);
    wait_for_pid_exit(pid, "guest state restore timeout");
    process_guard.disarm();
    finish_guest_connection(handle, host_stream);
}

#[test]
fn guest_state_restore_natural_exit_cleans_descendants() {
    let pid_path = unique_pid_path("guest-state-natural-exit");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&format!(
        "cat >/dev/null; sleep 60 & printf '%s' \"$!\" > '{}'",
        pid_path.as_str()
    ));
    let (handle, mut host_stream) =
        start_guest_connection_with_guest_state_restore_program(program);

    send_request(
        &mut host_stream,
        504,
        1_000,
        GuestStateRestoreTimezone::None,
    );
    let pid = process_guard.read_pid();
    let result = read_result(&mut host_stream, 504);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    wait_for_pid_exit(pid, "guest state restore natural exit");
    process_guard.disarm();
    finish_guest_connection(handle, host_stream);
}

#[test]
fn guest_state_restore_disconnect_and_busy_rejection_clean_active_process() {
    let pid_path = unique_pid_path("guest-state-disconnect");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&slow_program(Path::new(pid_path.as_str())));
    let (handle, mut host_stream) =
        start_guest_connection_with_guest_state_restore_program(program);

    send_request(
        &mut host_stream,
        505,
        60_000,
        GuestStateRestoreTimezone::None,
    );
    let pid = process_guard.read_pid();
    send_request(
        &mut host_stream,
        506,
        1_000,
        GuestStateRestoreTimezone::None,
    );
    let error = read_error_response(&mut host_stream, 506);
    assert!(error.contains("already active"));

    drop(host_stream);
    join_guest_connection(handle);
    wait_for_pid_exit(pid, "guest state restore disconnect");
    process_guard.disarm();
}

#[test]
fn guest_state_restore_validates_request_and_obeys_quiesce_gate() {
    let marker = unique_tmp_path("guest-state-quiesce", ".marker");
    let (_directory, program) = create_program(&format!("touch '{}'; exit 0", marker.as_str()));
    let (handle, mut host_stream) =
        start_guest_connection_with_guest_state_restore_program(program);

    let malformed = guest_control_proto::encode(MSG_GUEST_STATE_RESTORE, 507, b"bad").unwrap();
    host_stream.write_all(&malformed).unwrap();
    let malformed_error = read_error_response(&mut host_stream, 507);
    assert!(malformed_error.contains("timeout_ms truncated"));

    send_quiesce_operations(&mut host_stream, 508);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);
    send_request(
        &mut host_stream,
        509,
        1_000,
        GuestStateRestoreTimezone::None,
    );
    let quiesce_error = read_error_response(&mut host_stream, 509);
    assert!(quiesce_error.contains("operations are quiescing"));
    assert!(!Path::new(marker.as_str()).exists());

    finish_guest_connection(handle, host_stream);
}
