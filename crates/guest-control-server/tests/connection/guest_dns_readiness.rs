use std::io::Write;
use std::net::Shutdown;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use guest_control_proto::{
    GuestDnsReadinessTermination, MSG_GUEST_DNS_READINESS, MSG_GUEST_DNS_READINESS_RESULT,
    MSG_OPERATIONS_QUIESCED,
};

use super::support::*;

fn create_program(body: &str) -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("getent-test");
    std::fs::write(&path, format!("#!/bin/sh\nset -eu\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    (directory, path)
}

fn send_request(stream: &mut impl Write, seq: u32, timeout_ms: u32, hostname: &str) {
    let payload =
        guest_control_proto::encode_guest_dns_readiness_request(timeout_ms, hostname).unwrap();
    let frame = guest_control_proto::encode(MSG_GUEST_DNS_READINESS, seq, &payload).unwrap();
    stream.write_all(&frame).unwrap();
}

struct TestResult {
    termination: GuestDnsReadinessTermination,
    answer: Vec<u8>,
    output_truncated: bool,
    diagnostic: String,
}

fn read_result(stream: &mut impl std::io::Read, seq: u32) -> TestResult {
    let message = read_message(stream);
    assert_eq!(message.msg_type, MSG_GUEST_DNS_READINESS_RESULT);
    assert_eq!(message.seq, seq);
    let decoded = guest_control_proto::decode_guest_dns_readiness_result(&message.payload).unwrap();
    TestResult {
        termination: decoded.termination,
        answer: decoded.answer.to_vec(),
        output_truncated: decoded.output_truncated,
        diagnostic: decoded.diagnostic.to_owned(),
    }
}

fn slow_program(pid_path: &Path) -> String {
    format!("printf '%s' \"$$\" > '{}'; sleep 60", pid_path.display())
}

fn start_with_timeout_gate(
    program: PathBuf,
) -> (
    thread::JoinHandle<std::io::Result<()>>,
    UnixStream,
    mpsc::Receiver<u32>,
) {
    let (timeout_tx, timeout_rx) = mpsc::sync_channel(0);
    let (guest, mut host) = UnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        guest_control_server::handle_connection_with_test_dns_readiness_timeout_gate(
            guest, program, timeout_tx,
        )
    });
    read_guest_ready(&mut host);
    (handle, host, timeout_rx)
}

fn assert_helper_reaped(pid: u32) {
    assert!(
        !Path::new(&format!("/proc/{pid}")).exists(),
        "guest DNS readiness helper {pid} must be reaped before completion"
    );
}

#[test]
fn guest_dns_readiness_runs_fixed_argv_and_resolver_options() {
    let (_directory, program) = create_program(
        r#"
[ "$1" = "ahostsv4" ]
[ "$2" = "success.invalid" ]
[ "$RES_OPTIONS" = "attempts:1 timeout:1" ]
printf '192.0.2.1 STREAM success.invalid\n'
"#,
    );
    let (handle, mut host_stream) = start_guest_connection_with_dns_readiness_program(program);

    send_request(&mut host_stream, 301, 1_100, "success.invalid");
    let result = read_result(&mut host_stream, 301);

    assert_eq!(
        result.termination,
        GuestDnsReadinessTermination::Exited { exit_code: 0 }
    );
    assert_eq!(result.answer, b"192.0.2.1 STREAM success.invalid\n");
    assert!(!result.output_truncated);
    assert!(result.diagnostic.is_empty());
    finish_guest_connection(handle, host_stream);
}

#[test]
fn guest_dns_readiness_worker_failure_closes_connection() {
    let (_directory, program) = create_program(
        r#"
printf '192.0.2.1 STREAM success.invalid\n'
"#,
    );
    let (handle, mut host_stream) = start_guest_connection_with_dns_readiness_program(program);

    host_stream.shutdown(Shutdown::Read).unwrap();
    send_request(&mut host_stream, 312, 1_100, "success.invalid");

    join_guest_connection(handle);
}

#[test]
fn guest_dns_readiness_returns_exit_diagnostic_and_bounded_output() {
    let (_directory, program) = create_program(
        r#"
if [ "$2" = "failure.invalid" ]; then
  printf 'resolver failed\n' >&2
  exit 2
fi
head -c 1100 /dev/zero | tr '\000' x
"#,
    );
    let (handle, mut host_stream) = start_guest_connection_with_dns_readiness_program(program);

    send_request(&mut host_stream, 302, 1_100, "failure.invalid");
    let failed = read_result(&mut host_stream, 302);
    assert_eq!(
        failed.termination,
        GuestDnsReadinessTermination::Exited { exit_code: 2 }
    );
    assert_eq!(failed.diagnostic, "resolver failed\n");

    send_request(&mut host_stream, 303, 1_100, "large.invalid");
    let large = read_result(&mut host_stream, 303);
    assert_eq!(
        large.termination,
        GuestDnsReadinessTermination::Exited { exit_code: 0 }
    );
    assert_eq!(large.answer.len(), 1_024);
    assert!(large.output_truncated);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn guest_dns_readiness_timeout_kills_and_reaps_process_group() {
    let pid_path = unique_pid_path("dns-readiness-timeout");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&format!(
        "sleep 60 & printf '%s' \"$$\" > '{}'; wait",
        pid_path.as_str()
    ));
    let (handle, mut host_stream, timeout_gate) = start_with_timeout_gate(program);

    send_request(&mut host_stream, 304, 20, "timeout.invalid");
    let pid = process_guard.read_pid();
    assert_eq!(
        timeout_gate.recv_timeout(Duration::from_secs(3)).unwrap(),
        pid
    );
    let result = read_result(&mut host_stream, 304);

    assert_eq!(result.termination, GuestDnsReadinessTermination::TimedOut);
    wait_for_pid_exit(pid, "guest DNS readiness timeout");
    assert_helper_reaped(pid);
    process_guard.disarm();
    finish_guest_connection(handle, host_stream);
}

#[test]
fn guest_dns_readiness_timeout_before_helper_readiness_kills_and_reaps_process_group() {
    let pid_path = unique_pid_path("dns-readiness-not-ready");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let fifo = unique_tmp_path("dns-readiness-not-ready", ".fifo");
    let (_directory, program) = create_program(&format!(
        "mkfifo '{}'; read -r ready < '{}'; {}",
        fifo.as_str(),
        fifo.as_str(),
        slow_program(Path::new(pid_path.as_str()))
    ));
    let (handle, mut host_stream, timeout_gate) = start_with_timeout_gate(program);

    send_request(&mut host_stream, 313, 20, "not-ready.invalid");
    // No FIFO writer exists, so the helper cannot publish readiness even if
    // scheduled immediately. Observe the owned PID independently of its body.
    let pid = timeout_gate.recv_timeout(Duration::from_secs(3)).unwrap();
    process_guard.observe_pid(pid);
    let result = read_result(&mut host_stream, 313);

    assert_eq!(result.termination, GuestDnsReadinessTermination::TimedOut);
    assert!(!Path::new(pid_path.as_str()).exists());
    wait_for_pid_exit(pid, "guest DNS readiness timeout before helper readiness");
    assert_helper_reaped(pid);
    process_guard.disarm();
    finish_guest_connection(handle, host_stream);
}

#[test]
fn guest_dns_readiness_abandoned_timeout_gate_allows_connection_cleanup() {
    let pid_path = unique_pid_path("dns-readiness-abandoned-gate");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&format!(
        "sleep 60 & printf '%s' \"$$\" > '{}'; wait",
        pid_path.as_str()
    ));
    let (handle, mut host_stream, timeout_gate) = start_with_timeout_gate(program);

    send_request(&mut host_stream, 314, 60_000, "abandoned.invalid");
    let pid = process_guard.read_pid();
    drop(timeout_gate);
    drop(host_stream);
    join_guest_connection(handle);

    wait_for_pid_exit(pid, "abandoned guest DNS readiness timeout gate");
    assert_helper_reaped(pid);
    process_guard.disarm();
}

#[test]
fn guest_dns_readiness_natural_exit_cleans_remaining_process_group() {
    let pid_path = unique_pid_path("dns-readiness-natural-exit");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&format!(
        "sleep 60 & printf '%s' \"$!\" > '{}'; printf '192.0.2.1 STREAM success.invalid\\n'",
        pid_path.as_str()
    ));
    let (handle, mut host_stream) = start_guest_connection_with_dns_readiness_program(program);

    send_request(&mut host_stream, 311, 1_100, "success.invalid");
    let pid = process_guard.read_pid();
    let result = read_result(&mut host_stream, 311);

    assert_eq!(
        result.termination,
        GuestDnsReadinessTermination::Exited { exit_code: 0 }
    );
    wait_for_pid_exit(pid, "guest DNS readiness natural exit");
    process_guard.disarm();
    finish_guest_connection(handle, host_stream);
}

#[test]
fn guest_dns_readiness_connection_close_kills_and_reaps_process_group() {
    let pid_path = unique_pid_path("dns-readiness-disconnect");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&slow_program(Path::new(pid_path.as_str())));
    let (handle, mut host_stream) = start_guest_connection_with_dns_readiness_program(program);

    send_request(&mut host_stream, 305, 60_000, "disconnect.invalid");
    let pid = process_guard.read_pid();
    drop(host_stream);
    join_guest_connection(handle);

    wait_for_pid_exit(pid, "guest DNS readiness connection close");
    process_guard.disarm();
}

#[test]
fn guest_dns_readiness_rejects_concurrent_request_and_cleans_active_process() {
    let pid_path = unique_pid_path("dns-readiness-busy");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&slow_program(Path::new(pid_path.as_str())));
    let (handle, mut host_stream) = start_guest_connection_with_dns_readiness_program(program);

    send_request(&mut host_stream, 306, 60_000, "first.invalid");
    let pid = process_guard.read_pid();
    send_request(&mut host_stream, 307, 1_100, "second.invalid");
    let error = read_error_response(&mut host_stream, 307);
    assert!(error.contains("already active"));

    drop(host_stream);
    join_guest_connection(handle);
    wait_for_pid_exit(pid, "guest DNS readiness busy connection close");
    process_guard.disarm();
}

#[test]
fn guest_dns_readiness_validates_request_and_obeys_quiesce_gate() {
    let marker = unique_tmp_path("dns-readiness-quiesce", ".marker");
    let (_directory, program) = create_program(&format!("touch '{}'; exit 0", marker.as_str()));
    let (handle, mut host_stream) = start_guest_connection_with_dns_readiness_program(program);

    let malformed = guest_control_proto::encode(MSG_GUEST_DNS_READINESS, 308, b"bad").unwrap();
    host_stream.write_all(&malformed).unwrap();
    let malformed_error = read_error_response(&mut host_stream, 308);
    assert!(malformed_error.contains("timeout_ms truncated"));

    send_quiesce_operations(&mut host_stream, 309);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);
    send_request(&mut host_stream, 310, 1_100, "quiesced.invalid");
    let quiesce_error = read_error_response(&mut host_stream, 310);
    assert!(quiesce_error.contains("operations are quiescing"));
    assert!(!Path::new(marker.as_str()).exists());

    finish_guest_connection(handle, host_stream);
}
