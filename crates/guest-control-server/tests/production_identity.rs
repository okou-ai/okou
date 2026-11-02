#![allow(clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::panic;
use std::path::{Path, PathBuf};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use guest_control_proto::{
    ExecCapturedOutput, ExecControlPolicy, ExecLifecyclePolicy, ExecOutputPolicy, ExecOutputStream,
    ExecStartEncodeRequest, ExecTermination, ExecTimeoutPolicy, MSG_ERROR, MSG_EXEC_CANCEL,
    MSG_EXEC_OUTPUT, MSG_EXEC_RESULT, MSG_EXEC_START, MSG_EXEC_STARTED, MSG_READY, MSG_WRITE_FILE,
    MSG_WRITE_FILE_RESULT, RawMessage,
};

const SANDBOX_UID: u32 = 42_420;
const SANDBOX_GID: u32 = 42_420;
const SANDBOX_SUPPLEMENTARY_GID: u32 = 42_421;
const SANDBOX_HOME: &str = "/home/user";
const PRIVILEGED_REPORT_DIR: &str = "/root";
const ENV_SCRIPT_ROOT: &str = "/run/vm0-exec";
const ENV_SCRIPT_PREFIX: &str = "vm0-env-";
const GUEST_CONNECTION_TIMEOUT: Duration = Duration::from_secs(5);
const GUEST_COMPLETION_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Debug, Eq, PartialEq)]
struct Identity {
    uid: u32,
    gid: u32,
    groups: BTreeSet<u32>,
    cwd: PathBuf,
    home: String,
    user: String,
    logname: String,
}

struct ReportFile {
    path: PathBuf,
}

impl ReportFile {
    fn new(path: PathBuf) -> Self {
        let _ = fs::remove_file(&path);
        Self { path }
    }

    fn read_identity(&self) -> Identity {
        parse_identity_report(
            &fs::read_to_string(&self.path)
                .unwrap_or_else(|error| panic!("read identity report {:?}: {error}", self.path)),
        )
    }
}

impl Drop for ReportFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[test]
#[ignore = "requires root and a production sandbox account; executed explicitly by Rust CI"]
fn production_write_file_identity_matches_sudo_policy() {
    require_production_configuration();

    let parent = current_identity();
    assert_eq!(parent.uid, 0, "test must run as root");
    assert_ne!(parent.user, "user", "parent USER must differ from sandbox");

    let (handle, mut stream) = start_guest_connection();
    let process_id = std::process::id();

    let sandbox_report_name = format!("vm0-production-identity-{process_id}.txt");
    let sandbox_report = ReportFile::new(Path::new(SANDBOX_HOME).join(&sandbox_report_name));
    send_write_file(&mut stream, 1, &sandbox_report_name, false);

    assert_eq!(
        sandbox_report.read_identity(),
        Identity {
            uid: SANDBOX_UID,
            gid: SANDBOX_GID,
            groups: BTreeSet::from([SANDBOX_GID, SANDBOX_SUPPLEMENTARY_GID]),
            cwd: PathBuf::from(SANDBOX_HOME),
            home: SANDBOX_HOME.to_string(),
            user: "user".to_string(),
            logname: "user".to_string(),
        }
    );

    let sudo_report = ReportFile::new(
        Path::new(PRIVILEGED_REPORT_DIR)
            .join(format!("vm0-production-identity-sudo-{process_id}.txt")),
    );
    let sudo_report_path = sudo_report.path.to_string_lossy().into_owned();
    send_write_file(&mut stream, 2, &sudo_report_path, true);

    assert_eq!(sudo_report.read_identity(), parent);

    drop(stream);
    join_guest_connection(handle);
}

#[test]
#[ignore = "requires root and a production sandbox account; executed explicitly by Rust CI"]
fn production_exec_identity_matches_sandbox_user() {
    require_production_configuration();
    assert_eq!(current_identity().uid, 0, "test must run as root");

    let (handle, mut stream) = start_guest_connection();
    let sequence = 2;
    let command = "printf 'uid=%s\\ngid=%s\\ngroups=%s\\ncwd=%s\\nhome=%s\\nuser=%s\\nlogname=%s\\n' \"$(id -u)\" \"$(id -g)\" \"$(id -G)\" \"$(pwd -P)\" \"${HOME-}\" \"${USER-}\" \"${LOGNAME-}\"";
    let payload =
        guest_control_proto::encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
            lifecycle: ExecLifecyclePolicy::OneShot,
            role: guest_control_proto::ExecProcessRole::Workload,
            timeout: ExecTimeoutPolicy::Duration { timeout_ms: 5_000 },
            command,
            env: &[],
            sudo: false,
            label: "production-exec-identity",
            stdout: ExecOutputPolicy::Capture { limit_bytes: 1_024 },
            stderr: ExecOutputPolicy::Capture { limit_bytes: 1_024 },
            expected_exit_codes: &[],
            control: ExecControlPolicy::Disabled,
            stdin_bytes: None,
        })
        .expect("encode exec-start payload");
    let frame =
        guest_control_proto::encode(MSG_EXEC_START, sequence, &payload).expect("frame exec start");
    stream.write_all(&frame).expect("send exec-start request");

    let response = read_message(&mut stream);
    assert_eq!(response.msg_type, MSG_EXEC_RESULT);
    assert_eq!(response.seq, sequence);
    let result =
        guest_control_proto::decode_exec_result(&response.payload).expect("decode exec result");
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.diagnostic, "");
    let ExecCapturedOutput::Captured {
        bytes: stdout,
        truncated: false,
    } = result.stdout
    else {
        panic!("production identity stdout was not fully captured");
    };
    assert_eq!(
        parse_identity_report(std::str::from_utf8(stdout).expect("identity output is UTF-8")),
        Identity {
            uid: SANDBOX_UID,
            gid: SANDBOX_GID,
            groups: BTreeSet::from([SANDBOX_GID, SANDBOX_SUPPLEMENTARY_GID]),
            cwd: PathBuf::from(SANDBOX_HOME),
            home: SANDBOX_HOME.to_string(),
            user: "user".to_string(),
            logname: "user".to_string(),
        }
    );

    drop(stream);
    join_guest_connection(handle);
}

#[test]
#[ignore = "requires root and a production sandbox account; executed explicitly by Rust CI"]
fn production_env_script_remains_until_operation_cleanup() {
    require_production_configuration();
    assert_eq!(current_identity().uid, 0, "test must run as root");

    let entries_before = env_script_entries();
    let (handle, mut stream) = start_guest_connection();
    send_supervised_env_exec(&mut stream, 3);

    let started = read_message(&mut stream);
    if started.msg_type == MSG_EXEC_RESULT {
        let result = guest_control_proto::decode_exec_result(&started.payload)
            .expect("decode exec result received before exec-started");
        panic!(
            "exec operation completed before exec-started: termination={:?}, diagnostic={:?}",
            result.termination, result.diagnostic
        );
    }
    assert_eq!(started.msg_type, MSG_EXEC_STARTED);
    assert_eq!(started.seq, 3);
    assert!(
        guest_control_proto::decode_exec_started(&started.payload)
            .expect("decode exec-started response")
            .pid
            > 0
    );

    let output = read_message(&mut stream);
    assert_eq!(output.msg_type, MSG_EXEC_OUTPUT);
    assert_eq!(output.seq, 3);
    let output =
        guest_control_proto::decode_exec_output(&output.payload).expect("decode exec output");
    assert_eq!(output.stream, ExecOutputStream::Stdout);
    assert_eq!(output.chunk, b"ready");
    assert!(!output.truncated);

    let entries_after = env_script_entries();
    let new_entries: Vec<PathBuf> = entries_after.difference(&entries_before).cloned().collect();
    assert_eq!(
        new_entries.len(),
        1,
        "expected one active production env-script directory: {new_entries:?}"
    );
    let script_dir = &new_entries[0];
    let script_path = script_dir.join("run.sh");
    let directory_metadata = fs::symlink_metadata(script_dir)
        .unwrap_or_else(|error| panic!("read env-script metadata {script_dir:?}: {error}"));
    assert!(directory_metadata.file_type().is_dir());
    assert_eq!(directory_metadata.uid(), 0);
    assert_eq!(directory_metadata.gid(), SANDBOX_GID);
    assert_eq!(directory_metadata.permissions().mode() & 0o777, 0o710);

    let script_metadata = fs::symlink_metadata(&script_path)
        .unwrap_or_else(|error| panic!("read env-script metadata {script_path:?}: {error}"));
    assert!(script_metadata.file_type().is_file());
    assert_eq!(script_metadata.uid(), 0);
    assert_eq!(script_metadata.gid(), SANDBOX_GID);
    assert_eq!(script_metadata.permissions().mode() & 0o777, 0o440);
    let script = fs::read_to_string(&script_path)
        .unwrap_or_else(|error| panic!("read active env script {script_path:?}: {error}"));
    assert!(script.contains("export OKOU_TEST_ENV_SCRIPT_READY='ready'"));

    send_exec_cancel(&mut stream, 3);
    let result = read_message(&mut stream);
    assert_eq!(result.msg_type, MSG_EXEC_RESULT);
    assert_eq!(result.seq, 3);
    let result =
        guest_control_proto::decode_exec_result(&result.payload).expect("decode exec result");
    assert_eq!(result.termination, ExecTermination::Cancelled);
    wait_for_path_removal(script_dir);

    drop(stream);
    join_guest_connection(handle);
}

fn require_production_configuration() {
    #[cfg(debug_assertions)]
    panic!("test requires debug assertions off");

    #[cfg(all(not(debug_assertions), feature = "test-support"))]
    panic!("test must exercise the production path without test-support");
}

fn start_guest_connection() -> (JoinHandle<std::io::Result<()>>, UnixStream) {
    let (guest_stream, mut host_stream) = UnixStream::pair().expect("create Unix stream pair");
    host_stream
        .set_read_timeout(Some(GUEST_CONNECTION_TIMEOUT))
        .expect("set host read timeout");
    let handle = thread::spawn(move || {
        guest_control_server::handle_connection_with_test_process_containment(guest_stream)
    });

    let ready = read_message(&mut host_stream);
    assert_eq!(ready.msg_type, MSG_READY);

    (handle, host_stream)
}

fn join_guest_connection(handle: JoinHandle<std::io::Result<()>>) {
    wait_for_guest_connection_with_timeout(handle, GUEST_CONNECTION_TIMEOUT)
        .expect("guest connection returned an error");
}

fn wait_for_guest_connection_with_timeout(
    handle: JoinHandle<io::Result<()>>,
    timeout: Duration,
) -> io::Result<()> {
    let deadline = Instant::now()
        .checked_add(timeout)
        .expect("production identity guest teardown timeout overflowed");
    while !handle.is_finished() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            panic!("production identity guest teardown timed out after {timeout:?}");
        }
        thread::sleep(std::cmp::min(remaining, GUEST_COMPLETION_POLL_INTERVAL));
    }

    match handle.join() {
        Ok(result) => result,
        Err(payload) => panic::resume_unwind(payload),
    }
}

fn send_write_file(stream: &mut UnixStream, sequence: u32, path: &str, sudo: bool) {
    let payload = guest_control_proto::encode_write_file(path, b"identity probe", sudo, false)
        .expect("encode write");
    let frame =
        guest_control_proto::encode(MSG_WRITE_FILE, sequence, &payload).expect("frame write");
    stream.write_all(&frame).expect("send write request");

    let response = read_message(stream);
    if response.msg_type == MSG_ERROR {
        panic!(
            "write request failed: {}",
            guest_control_proto::decode_error(&response.payload).expect("decode write error")
        );
    }
    assert_eq!(response.msg_type, MSG_WRITE_FILE_RESULT);
    assert_eq!(response.seq, sequence);
    let (success, error) = guest_control_proto::decode_write_file_result(&response.payload)
        .expect("decode write-file result");
    assert!(success, "write-file child failed: {error}");
}

fn send_supervised_env_exec(stream: &mut UnixStream, sequence: u32) {
    let payload =
        guest_control_proto::encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
            lifecycle: ExecLifecyclePolicy::Supervised,
            role: guest_control_proto::ExecProcessRole::Workload,
            timeout: ExecTimeoutPolicy::None,
            command: "printf '%s' \"$OKOU_TEST_ENV_SCRIPT_READY\"; sleep 60",
            env: &[("OKOU_TEST_ENV_SCRIPT_READY", "ready")],
            sudo: false,
            label: "production-env-script-cleanup",
            stdout: ExecOutputPolicy::Stream {
                limit_bytes: 64,
                chunk_limit_bytes: 64,
            },
            stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            expected_exit_codes: &[],
            control: ExecControlPolicy::Disabled,
            stdin_bytes: None,
        })
        .expect("encode exec-start payload");
    let frame =
        guest_control_proto::encode(MSG_EXEC_START, sequence, &payload).expect("frame exec start");
    stream.write_all(&frame).expect("send exec-start request");
}

fn send_exec_cancel(stream: &mut UnixStream, sequence: u32) {
    let payload = guest_control_proto::encode_exec_cancel();
    let frame = guest_control_proto::encode(MSG_EXEC_CANCEL, sequence, &payload)
        .expect("frame exec cancel");
    stream.write_all(&frame).expect("send exec-cancel request");
}

fn env_script_entries() -> BTreeSet<PathBuf> {
    let entries = match fs::read_dir(ENV_SCRIPT_ROOT) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return BTreeSet::new(),
        Err(error) => panic!("read env-script root {ENV_SCRIPT_ROOT:?}: {error}"),
    };

    entries
        .map(|entry| entry.expect("read env-script entry").path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(ENV_SCRIPT_PREFIX))
        })
        .collect()
}

fn wait_for_path_removal(path: &Path) {
    let deadline = Instant::now()
        .checked_add(GUEST_CONNECTION_TIMEOUT)
        .expect("env-script cleanup timeout overflowed");
    while path.exists() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(
            !remaining.is_zero(),
            "env-script path remained after operation cleanup: {path:?}"
        );
        thread::sleep(std::cmp::min(remaining, GUEST_COMPLETION_POLL_INTERVAL));
    }
}

fn read_message(stream: &mut UnixStream) -> RawMessage {
    let mut header = [0_u8; 4];
    stream.read_exact(&mut header).expect("read frame header");
    let body_len = u32::from_be_bytes(header) as usize;
    let mut body = vec![0_u8; body_len];
    stream.read_exact(&mut body).expect("read frame body");

    let mut frame = Vec::with_capacity(header.len() + body.len());
    frame.extend_from_slice(&header);
    frame.extend_from_slice(&body);
    let mut messages = guest_control_proto::Decoder::new()
        .decode(&frame)
        .expect("decode frame");
    assert_eq!(messages.len(), 1);
    messages.remove(0)
}

fn parse_identity_report(report: &str) -> Identity {
    let fields: BTreeMap<&str, &str> = report
        .lines()
        .map(|line| line.split_once('=').expect("identity report field"))
        .collect();
    let field = |name: &str| {
        fields
            .get(name)
            .copied()
            .unwrap_or_else(|| panic!("identity report missing {name:?}: {report:?}"))
    };

    Identity {
        uid: field("uid").parse().expect("parse uid"),
        gid: field("gid").parse().expect("parse gid"),
        groups: field("groups")
            .split_whitespace()
            .map(|group| group.parse().expect("parse group"))
            .collect(),
        cwd: PathBuf::from(field("cwd")),
        home: field("home").to_string(),
        user: field("user").to_string(),
        logname: field("logname").to_string(),
    }
}

fn current_identity() -> Identity {
    Identity {
        // SAFETY: These process identity getters have no preconditions.
        uid: unsafe { libc::geteuid() },
        // SAFETY: These process identity getters have no preconditions.
        gid: unsafe { libc::getegid() },
        groups: current_groups(),
        cwd: std::env::current_dir().expect("read current directory"),
        home: std::env::var("HOME").unwrap_or_default(),
        user: std::env::var("USER").unwrap_or_default(),
        logname: std::env::var("LOGNAME").unwrap_or_default(),
    }
}

fn current_groups() -> BTreeSet<u32> {
    // SAFETY: A null pointer with a zero size queries the required group count.
    let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
    assert!(
        count >= 0,
        "query current groups: {}",
        std::io::Error::last_os_error()
    );

    let mut groups = vec![0; count as usize];
    if count > 0 {
        // SAFETY: The vector has capacity for exactly `count` group IDs.
        let actual = unsafe { libc::getgroups(count, groups.as_mut_ptr()) };
        assert_eq!(actual, count, "read current groups");
    }

    let mut groups: BTreeSet<u32> = groups.into_iter().collect();
    // `id -G` includes the effective primary group as well as supplementary groups.
    // SAFETY: This process identity getter has no preconditions.
    groups.insert(unsafe { libc::getegid() });
    groups
}

#[cfg(test)]
mod tests;
