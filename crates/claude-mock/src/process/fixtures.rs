use crate::scenario::{echo_session_id, parse_echo_jsonl};
use crate::transcript::{
    JsonlTranscript, assistant_text_event, generate_session_id, init_event, result_event,
    tool_use_event,
};
use guest_contracts::cli_agent_session_id::is_valid_cli_agent_session_id;
use guest_contracts::stdout_framing::ORDINARY_CLI_STDOUT_MAX_LINE_BYTES;
use serde_json::json;
use std::collections::BTreeMap;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitCode, Stdio};
use std::time::{Duration, Instant};

use super::bash_tool_command;

const REAPABLE_HANG_DURATION: Duration = Duration::from_secs(3600);
const TERMINATION_READY_EVENT: &str = "claude_mock_termination_ready";
const POST_RESULT_READY_EVENT: &str = "claude_mock_post_result_ready";
const POST_RESULT_ACTIVITY_ONE_EVENT: &str = "claude_mock_post_result_activity_1_ready";
const POST_RESULT_ACTIVITY_TWO_EVENT: &str = "claude_mock_post_result_activity_2_ready";
const POST_RESULT_LIVENESS_EVENT: &str = "claude_mock_post_result_stale_deadline_survived";
const POST_RESULT_RELEASE_ONE_SOCKET: &str = ".vm0-post-result-release-1.sock";
const POST_RESULT_RELEASE_TWO_SOCKET: &str = ".vm0-post-result-release-2.sock";
const TRANSCRIPT_FENCE_PADDING_BYTES: usize = 16 * 1024;
const STDOUT_STREAM_CHUNK_BYTES: usize = 8 * 1024;
const TOOL_OOM_PARENT_HEADROOM_BYTES: u64 = 192 * 1024 * 1024;
const TOOL_OOM_RUNTIME_BYTES: usize = 128 * 1024 * 1024;
const TOOL_MARKER_TIMEOUT: Duration = Duration::from_secs(5);
const TOOL_COMPLETION_TIMEOUT: Duration = Duration::from_secs(5);
const TOOL_OOM_CONVERGENCE_TIMEOUT: Duration = Duration::from_secs(15);
const TOOL_OOM_POLL_INTERVAL: Duration = Duration::from_millis(10);
const TOOL_OOM_SURVIVOR_CGROUP: &str = "/tmp/vm0-tool-oom-survivor.cgroup";
const TOOL_OOM_OFFENDER_CGROUP: &str = "/tmp/vm0-tool-oom-offender.cgroup";
const TOOL_OOM_SURVIVOR_RELEASE: &str = "/tmp/vm0-tool-oom-survivor.release";

const TOOL_OOM_SURVIVOR_SCRIPT: &str = r#"
set -eu
test "$(cat /proc/self/oom_score_adj)" = 1000
exec python3 -c '
import pathlib, time
assert pathlib.Path("/proc/self/oom_score_adj").read_text().strip() == "1000"
memory = bytearray(32 * 1024 * 1024)
memory[::4096] = b"\x01" * (len(memory) // 4096)
relative = next(line[3:] for line in pathlib.Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::"))
pathlib.Path("/tmp/vm0-tool-oom-survivor.cgroup").write_text(relative)
while not pathlib.Path("/tmp/vm0-tool-oom-survivor.release").exists():
    time.sleep(0.01)
'
"#;

const TOOL_OOM_OFFENDER_SCRIPT: &str = r#"
set -eu
test "$(cat /proc/self/oom_score_adj)" = 1000
awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup > /tmp/vm0-tool-oom-offender.cgroup
(trap '' TERM; while :; do sleep 1; done) &
python3 -c '
import os, pathlib, time

assert pathlib.Path("/proc/self/oom_score_adj").read_text().strip() == "1000"
limit = int(os.environ["VM0_TEST_OOM_ALLOCATOR_BYTES"])
for _ in range(4):
    if os.fork() == 0:
        assert pathlib.Path("/proc/self/oom_score_adj").read_text().strip() == "1000"
        chunks = []
        allocated = 0
        while allocated < limit:
            chunk = bytearray(min(4 * 1024 * 1024, limit - allocated))
            chunk[::4096] = b"\x01" * ((len(chunk) + 4095) // 4096)
            allocated += len(chunk)
            chunks.append(chunk)
            time.sleep(0.01)
        while True:
            time.sleep(1)
while True:
    os.wait()
'
"#;

pub(super) fn run_fail_no_newline(msg: &str) -> ExitCode {
    eprint!("{msg}");
    let _ = std::io::stderr().flush();
    ExitCode::from(1)
}

pub(super) fn run_fail_invalid_utf8() -> ExitCode {
    let _ = std::io::stderr().write_all(b"invalid-\xff-stderr\n");
    let _ = std::io::stderr().flush();
    ExitCode::from(1)
}

pub(super) fn run_fail_invalid_utf8_long() -> ExitCode {
    let invalid = vec![0xff; 16 * 1024];
    let _ = std::io::stderr().write_all(&invalid);
    let _ = std::io::stderr().write_all(b"\n");
    let _ = std::io::stderr().flush();
    ExitCode::from(1)
}

pub(super) fn run_fail(msg: &str) -> ExitCode {
    eprintln!("{msg}");
    ExitCode::from(1)
}

pub(super) fn run_echo_jsonl_mode(payload: &str, hang_after_output: bool) -> ExitCode {
    let events = match parse_echo_jsonl(payload) {
        Ok(events) => events,
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::from(1);
        }
    };

    let session_id = echo_session_id(&events).map(str::to_owned);
    if let Some(session_id) = session_id.as_deref()
        && !is_valid_cli_agent_session_id(session_id)
    {
        eprintln!("invalid @ECHO@ session_id: {session_id:?}");
        return ExitCode::from(1);
    }

    let mut transcript = JsonlTranscript::default();
    for (line, _) in events {
        transcript.emit_raw_line(line);
    }
    if let Some(session_id) = session_id.as_deref() {
        transcript.write_session_history(session_id);
    }
    let _ = std::io::stdout().flush();
    if hang_after_output {
        hang_until_reaped();
    }
    ExitCode::SUCCESS
}

/// Emit the init + result JSONL pair shared by post-result mock test
/// prefixes, flush stdout so guest-agent sees them, and write the
/// session history checkpoint file. Caller decides which post-result
/// behavior follows (hang / exit / ignore SIGTERM / orphan stdout).
fn emit_post_result_pair() {
    let _ = emit_result_pair(false, "Done.");
}

fn emit_result_pair(is_error: bool, result: &str) -> String {
    let session_id = generate_session_id();
    let mut transcript = JsonlTranscript::default();
    transcript.emit_value(init_event(&session_id, &["Bash"]));
    transcript.emit_value(result_event(&session_id, is_error, result));
    transcript.write_session_history(&session_id);

    let _ = std::io::stdout().flush();
    session_id
}

fn emit_stuck_tool_events() {
    let session_id = generate_session_id();
    let mut transcript = JsonlTranscript::default();

    transcript.emit_value(init_event(&session_id, &["WebFetch"]));
    transcript.emit_value(tool_use_event(
        &session_id,
        "toolu_stuck_001",
        "WebFetch",
        json!({"url": "https://example.com/hang"}),
    ));

    // Flush stdout so guest-agent receives the events before we hang.
    // When piped, stdout is fully buffered and println! may not flush.
    let _ = std::io::stdout().flush();
}

fn ignore_sigterm() {
    // SAFETY: signal(SIGTERM, SIG_IGN) is async-signal-safe and these mock
    // scenarios do not share signal handler state after installing it.
    unsafe {
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
    }
}

fn emit_termination_ready_fence() {
    if let Ok(home) = std::env::var("HOME") {
        let _ = std::fs::write(format!("{home}/.claude-mock-sigterm-ignored"), b"");
    }
    emit_stream_event_fence(TERMINATION_READY_EVENT);
}

fn emit_stream_event_fence(event_type: &str) {
    // These mock-only events are consumption fences for integration tests.
    // Keep each record larger than guest-agent's transcript buffer so seeing
    // the marker on disk proves that all preceding events were ingested.
    println!(
        "{}",
        json!({
            "type": "stream_event",
            "event": {
                "type": event_type,
                "padding": "x".repeat(TRANSCRIPT_FENCE_PADDING_BYTES),
            }
        })
    );
    let _ = std::io::stdout().flush();
}

fn emit_fence_and_wait_for_release(
    event_type: &str,
    release_socket_name: &str,
) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|error| format!("read HOME: {error}"))?;
    let release_socket = Path::new(&home).join(release_socket_name);
    let listener = UnixListener::bind(&release_socket)
        .map_err(|error| format!("bind {}: {error}", release_socket.display()))?;
    emit_stream_event_fence(event_type);
    listener
        .accept()
        .map_err(|error| format!("accept {}: {error}", release_socket.display()))?;
    Ok(())
}

fn hang_until_reaped() {
    std::thread::sleep(REAPABLE_HANG_DURATION);
}

fn write_stdout_limit(stdout: &mut impl Write, byte: u8) -> std::io::Result<()> {
    let chunk = [byte; STDOUT_STREAM_CHUNK_BYTES];
    for _ in 0..ORDINARY_CLI_STDOUT_MAX_LINE_BYTES / STDOUT_STREAM_CHUNK_BYTES {
        stdout.write_all(&chunk)?;
    }
    Ok(())
}

pub(super) fn run_stdout_over_limit_scenario(output_format: &str, newline: bool) -> ExitCode {
    if output_format != "stream-json" {
        return ExitCode::from(1);
    }

    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    let _ = write_stdout_limit(&mut stdout, b'x');
    let suffix: &[u8] = if newline { b"x\n" } else { b"x" };
    let _ = stdout.write_all(suffix);
    let _ = stdout.flush();
    drop(stdout);
    hang_until_reaped();
    ExitCode::from(1)
}

pub(super) fn run_stdout_invalid_utf8_scenario(output_format: &str) -> ExitCode {
    if output_format != "stream-json" {
        return ExitCode::from(1);
    }

    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    let _ = stdout.write_all(b"do-not-log-invalid-stdout-\xff\n");
    let _ = stdout.flush();
    drop(stdout);
    hang_until_reaped();
    ExitCode::from(1)
}

pub(super) fn run_stdout_record_boundaries_scenario(output_format: &str) -> ExitCode {
    if output_format != "stream-json" {
        return ExitCode::from(1);
    }

    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    let result = stdout
        .write_all(b"crlf-record\r\n")
        .and_then(|()| write_stdout_limit(&mut stdout, b'x'))
        .and_then(|()| stdout.write_all(b"\neof-record"))
        .and_then(|()| stdout.flush());
    if let Err(error) = result {
        eprintln!("write stdout record-boundary fixture: {error}");
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}

pub(super) fn run_stuck_tool_scenario(
    output_format: &str,
    deaf: bool,
    close_stdout: bool,
) -> ExitCode {
    if output_format == "stream-json" {
        if deaf {
            ignore_sigterm();
        }
        emit_stuck_tool_events();

        if deaf {
            emit_termination_ready_fence();
        }

        if close_stdout {
            // SAFETY: this mock process has finished writing all test events
            // and is about to park forever. Closing fd 1 simulates a CLI that
            // no longer has stdout open while the process is still alive.
            unsafe {
                libc::close(libc::STDOUT_FILENO);
            }
        }

        // Hang forever - simulates a stuck WebFetch
        hang_until_reaped();
    }
    ExitCode::from(1)
}

pub(super) fn run_orphan_pipe_scenario(output_format: &str) -> ExitCode {
    if output_format == "stream-json" {
        emit_post_result_pair();

        // Spawn a child after flushing the completed stream. It inherits
        // stdout and keeps the pipe open after this process exits.
        let _ = Command::new("sleep")
            .arg(REAPABLE_HANG_DURATION.as_secs().to_string())
            .spawn();
    }
    ExitCode::SUCCESS
}

pub(super) fn run_hang_after_result_scenario(output_format: &str, deaf: bool) -> ExitCode {
    if output_format == "stream-json" {
        if deaf {
            // Ignore SIGTERM so only SIGKILL can terminate this process.
            // Exercises the SigtermPending -> SigkillPending -> Done escalation
            // branch of the reap FSM.
            ignore_sigterm();
        }
        emit_post_result_pair();
        if deaf {
            emit_termination_ready_fence();
        }
        // Hang this process forever. guest-agent's post-result reap SIGTERMs
        // it within POST_RESULT_SIGTERM_GRACE_SECS unless SIGTERM is ignored.
        hang_until_reaped();
    }
    ExitCode::SUCCESS
}

pub(super) fn run_hang_after_result_then_event_scenario(output_format: &str) -> ExitCode {
    if output_format == "stream-json" {
        let session_id = emit_result_pair(false, "Done.");
        if let Err(error) =
            emit_fence_and_wait_for_release(POST_RESULT_READY_EVENT, POST_RESULT_RELEASE_ONE_SOCKET)
        {
            eprintln!("{error}");
            return ExitCode::from(1);
        }
        let mut transcript = JsonlTranscript::default();
        transcript.emit_value(assistant_text_event(&session_id, "post-result event"));
        if let Err(error) = emit_fence_and_wait_for_release(
            POST_RESULT_ACTIVITY_ONE_EVENT,
            POST_RESULT_RELEASE_TWO_SOCKET,
        ) {
            eprintln!("{error}");
            return ExitCode::from(1);
        }
        emit_stream_event_fence(POST_RESULT_LIVENESS_EVENT);
        hang_until_reaped();
    }
    ExitCode::SUCCESS
}

pub(super) fn run_hang_after_result_periodic_events_scenario(output_format: &str) -> ExitCode {
    if output_format == "stream-json" {
        let session_id = emit_result_pair(false, "Done.");
        if let Err(error) =
            emit_fence_and_wait_for_release(POST_RESULT_READY_EVENT, POST_RESULT_RELEASE_ONE_SOCKET)
        {
            eprintln!("{error}");
            return ExitCode::from(1);
        }
        let mut transcript = JsonlTranscript::default();
        transcript.emit_value(assistant_text_event(
            &session_id,
            "post-result periodic event 0",
        ));
        if let Err(error) = emit_fence_and_wait_for_release(
            POST_RESULT_ACTIVITY_ONE_EVENT,
            POST_RESULT_RELEASE_TWO_SOCKET,
        ) {
            eprintln!("{error}");
            return ExitCode::from(1);
        }
        transcript.emit_value(assistant_text_event(
            &session_id,
            "post-result periodic event 1",
        ));
        emit_stream_event_fence(POST_RESULT_ACTIVITY_TWO_EVENT);
        hang_until_reaped();
    }
    ExitCode::SUCCESS
}

pub(super) fn run_hang_after_error_result_scenario(output_format: &str) -> ExitCode {
    if output_format == "stream-json" {
        let _ = emit_result_pair(true, "Mock Claude error.");
        hang_until_reaped();
    }
    ExitCode::SUCCESS
}

pub(super) fn run_exit_after_result_scenario(output_format: &str) -> ExitCode {
    if output_format == "stream-json" {
        emit_post_result_pair();
        // Exit immediately. Exercises the happy path: guest-agent
        // either arms post-result reap and observes `child.wait()`
        // before the deadline, or observes `child.wait()` first and
        // never arms reap. No signal should be sent.
    }
    ExitCode::SUCCESS
}

pub(super) fn run_write_env_json_scenario(output_format: &str, path: &str) -> ExitCode {
    if output_format != "stream-json" {
        return ExitCode::from(1);
    }

    let env: BTreeMap<String, String> = std::env::vars().collect();
    if let Some(parent) = Path::new(path).parent()
        && !parent.as_os_str().is_empty()
        && let Err(e) = std::fs::create_dir_all(parent)
    {
        eprintln!("create env json parent: {e}");
        return ExitCode::from(1);
    }
    let payload = match serde_json::to_vec(&env) {
        Ok(payload) => payload,
        Err(e) => {
            eprintln!("serialize env json: {e}");
            return ExitCode::from(1);
        }
    };
    if let Err(e) = std::fs::write(path, payload) {
        eprintln!("write env json: {e}");
        return ExitCode::from(1);
    }

    emit_post_result_pair();
    ExitCode::SUCCESS
}

pub(super) fn run_append_prompt_transport_scenario(output_format: &str, payload: &str) -> ExitCode {
    if output_format != "stream-json" {
        return ExitCode::from(1);
    }

    match verify_append_prompt_transport(payload) {
        Ok(summary) => {
            emit_result_pair(false, &summary);
            ExitCode::SUCCESS
        }
        Err(error) => {
            let message = format!("append prompt transport fixture failed: {error}");
            emit_result_pair(true, &message);
            eprintln!("{message}");
            ExitCode::from(1)
        }
    }
}

fn verify_append_prompt_transport(payload: &str) -> Result<String, String> {
    let payload: serde_json::Value = serde_json::from_str(payload)
        .map_err(|error| format!("parse scenario payload: {error}"))?;
    let expected_prompt = payload
        .get("expectedPrompt")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "scenario payload requires expectedPrompt".to_string())?;
    let capture_path = payload
        .get("capturePath")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "scenario payload requires capturePath".to_string())?;
    if capture_path.is_empty() {
        return Err("scenario capturePath must not be empty".to_string());
    }

    let args: Vec<String> = std::env::args().collect();
    if let Some(parent) = Path::new(capture_path).parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create argv capture parent: {error}"))?;
    }
    let capture =
        serde_json::to_vec(&args).map_err(|error| format!("serialize argv capture: {error}"))?;
    std::fs::write(capture_path, capture)
        .map_err(|error| format!("write argv capture: {error}"))?;

    let file_flag_positions: Vec<usize> = args
        .iter()
        .enumerate()
        .filter_map(|(index, arg)| (arg == "--append-system-prompt-file").then_some(index))
        .collect();
    if expected_prompt.is_empty() {
        if args
            .iter()
            .any(|arg| arg == "--append-system-prompt" || arg == "--append-system-prompt-file")
        {
            return Err("empty appended prompt emitted an append flag".to_string());
        }
        return Ok("empty appended prompt omitted both append flags".to_string());
    }

    let status = bash_tool_command()
        .args([
            "-c",
            "pkill -9 -f -- \"$1\"; exit 97",
            "vm0-pkill-f-collision-shell",
            expected_prompt,
        ])
        .status()
        .map_err(|error| format!("spawn broad pkill shell: {error}"))?;
    if status.signal() != Some(libc::SIGKILL) {
        return Err(format!(
            "broad pkill shell exited with {status}, expected SIGKILL"
        ));
    }

    if args.iter().any(|arg| arg == "--append-system-prompt") {
        return Err("inline --append-system-prompt remained in argv".to_string());
    }
    if args.iter().any(|arg| arg.contains(expected_prompt)) {
        return Err("raw appended prompt remained in argv".to_string());
    }
    let [file_flag_index] = file_flag_positions.as_slice() else {
        return Err(format!(
            "expected one --append-system-prompt-file flag, found {}",
            file_flag_positions.len()
        ));
    };
    let prompt_path = args
        .get(file_flag_index + 1)
        .ok_or_else(|| "append prompt file flag is missing its path".to_string())?;
    let prompt_bytes = std::fs::read(prompt_path)
        .map_err(|error| format!("read append prompt file {prompt_path}: {error}"))?;
    if prompt_bytes != expected_prompt.as_bytes() {
        return Err("append prompt file contents did not match".to_string());
    }
    let mode = std::fs::metadata(prompt_path)
        .map_err(|error| format!("stat append prompt file {prompt_path}: {error}"))?
        .permissions()
        .mode()
        & 0o777;
    if mode != 0o600 {
        return Err(format!(
            "append prompt file mode was {mode:o}, expected 600"
        ));
    }

    Ok("file-backed appended prompt survived broad pkill".to_string())
}

pub(super) fn run_parallel_shell_tool_oom_scenario(
    output_format: &str,
    guest_wide: bool,
) -> ExitCode {
    if output_format != "stream-json" {
        return ExitCode::from(1);
    }

    match verify_parallel_shell_tool_oom(guest_wide) {
        Ok(summary) => {
            emit_result_pair(false, &summary);
            ExitCode::SUCCESS
        }
        Err(error) => {
            let message = format!("parallel shell tool OOM fixture failed: {error}");
            emit_result_pair(true, &message);
            eprintln!("{message}");
            ExitCode::from(1)
        }
    }
}

fn verify_parallel_shell_tool_oom(guest_wide: bool) -> Result<String, String> {
    let runtime_relative = unified_cgroup_path(std::process::id())?;
    let runtime_suffix = "/workload/runtime";
    let operation_relative = runtime_relative
        .strip_suffix(runtime_suffix)
        .ok_or_else(|| {
            format!("mock CLI is outside the managed runtime cgroup: {runtime_relative}")
        })?;
    let tools_relative = format!("{operation_relative}/workload/tools");
    let tools_path = Path::new("/sys/fs/cgroup").join(tools_relative.trim_start_matches('/'));
    let workload_path = tools_path
        .parent()
        .ok_or_else(|| "tools cgroup has no workload parent".to_string())?;
    let memory_max_path = workload_path.join("memory.max");
    let original_memory_max = read_trimmed(&memory_max_path)?;
    let original_memory_max_bytes = original_memory_max
        .parse::<u64>()
        .map_err(|error| format!("invalid workload memory.max {original_memory_max}: {error}"))?;
    if read_trimmed(Path::new("/proc/self/oom_score_adj"))? != "0" {
        return Err("runtime OOM score is not the unmodified default".to_string());
    }
    let runtime_bytes = if guest_wide {
        // Keep every individual tool allocator smaller than the runtime. With
        // four half-sized allocators, total charge still exhausts this Guest.
        let meminfo = std::fs::read_to_string("/proc/meminfo")
            .map_err(|error| format!("read Guest memory size: {error}"))?;
        let memory_kib = meminfo
            .lines()
            .find_map(|line| line.strip_prefix("MemTotal:"))
            .and_then(|value| value.split_whitespace().next())
            .and_then(|value| value.parse::<usize>().ok())
            .ok_or_else(|| "Guest memory size is missing".to_string())?;
        memory_kib * 1024 / 3
    } else {
        TOOL_OOM_RUNTIME_BYTES
    };
    let runtime_memory = vec![1_u8; runtime_bytes];
    std::hint::black_box(&runtime_memory);
    let workload_current = read_trimmed(&workload_path.join("memory.current"))?
        .parse::<u64>()
        .map_err(|error| format!("invalid workload memory.current: {error}"))?;
    let test_memory_max = workload_current
        .checked_add(TOOL_OOM_PARENT_HEADROOM_BYTES)
        .ok_or_else(|| "workload OOM test limit overflowed".to_string())?;
    if test_memory_max >= original_memory_max_bytes {
        return Err(format!(
            "workload lacks OOM test headroom: current={workload_current} original_max={original_memory_max_bytes}"
        ));
    }
    if read_trimmed(&tools_path.join("memory.max"))? != "max" {
        return Err("tools cgroup unexpectedly has its own memory limit".to_string());
    }
    let before_events = read_cgroup_events(&workload_path.join("memory.events"))?;
    let runtime_path = workload_path.join("runtime");
    let before_runtime_events = read_cgroup_events(&runtime_path.join("memory.events"))?;

    for marker in [
        TOOL_OOM_SURVIVOR_CGROUP,
        TOOL_OOM_OFFENDER_CGROUP,
        TOOL_OOM_SURVIVOR_RELEASE,
    ] {
        match std::fs::remove_file(marker) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("remove stale marker {marker}: {error}")),
        }
    }

    let mut fixture = ParallelToolOomFixture::new(memory_max_path, original_memory_max);
    // Test-only limit changes, confined to a disposable Guest operation. The
    // guard restores the original value on every returning path.
    write_cgroup_value_as_root(
        &fixture.memory_max_path,
        &if guest_wide {
            "max".to_string()
        } else {
            test_memory_max.to_string()
        },
    )?;

    fixture.survivor = Some(spawn_bash_tool(TOOL_OOM_SURVIVOR_SCRIPT)?);
    let survivor_relative = wait_for_tool_marker(
        TOOL_OOM_SURVIVOR_CGROUP,
        fixture
            .survivor
            .as_mut()
            .ok_or_else(|| "survivor process is missing".to_string())?,
    )?;

    fixture.offender = Some(
        bash_tool_command()
            .args(["-c", TOOL_OOM_OFFENDER_SCRIPT])
            .env(
                "VM0_TEST_OOM_ALLOCATOR_BYTES",
                (runtime_bytes / 2).to_string(),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("spawn offender Bash tool: {error}"))?,
    );
    let offender_relative = wait_for_tool_marker(
        TOOL_OOM_OFFENDER_CGROUP,
        fixture
            .offender
            .as_mut()
            .ok_or_else(|| "offender process is missing".to_string())?,
    )?;

    validate_tool_cgroup(&survivor_relative, &tools_relative)?;
    validate_tool_cgroup(&offender_relative, &tools_relative)?;
    if survivor_relative == offender_relative {
        return Err("parallel Bash tools entered the same cgroup".to_string());
    }

    let offender_status = wait_for_child_exit(
        fixture
            .offender
            .as_mut()
            .ok_or_else(|| "offender process is missing".to_string())?,
        TOOL_OOM_CONVERGENCE_TIMEOUT,
        "offender Bash tool",
    )?;
    fixture.offender = None;
    if offender_status.signal() != Some(libc::SIGKILL) {
        return Err(format!(
            "offender Bash tool was not killed as a group: {offender_status}"
        ));
    }
    let offender_path = Path::new("/sys/fs/cgroup").join(offender_relative.trim_start_matches('/'));
    let deadline = Instant::now() + TOOL_COMPLETION_TIMEOUT;
    while read_cgroup_events(&offender_path.join("cgroup.events"))?.get("populated") != Some(&0) {
        if Instant::now() >= deadline {
            return Err("OOM-killed tool still has live descendants".to_string());
        }
        std::thread::sleep(TOOL_OOM_POLL_INTERVAL);
    }

    let survivor = fixture
        .survivor
        .as_mut()
        .ok_or_else(|| "survivor process is missing".to_string())?;
    if let Some(status) = survivor
        .try_wait()
        .map_err(|error| format!("inspect survivor Bash tool: {error}"))?
    {
        return Err(format!(
            "unrelated Bash tool exited during offender OOM: {status}"
        ));
    }

    std::fs::write(TOOL_OOM_SURVIVOR_RELEASE, b"release\n")
        .map_err(|error| format!("release survivor Bash tool: {error}"))?;
    let survivor_status =
        wait_for_child_exit(survivor, TOOL_COMPLETION_TIMEOUT, "survivor Bash tool")?;
    fixture.survivor = None;
    if !survivor_status.success() {
        return Err(format!(
            "unrelated Bash tool did not finish successfully: {survivor_status}"
        ));
    }

    let after_events = read_cgroup_events(&workload_path.join("memory.events"))?;
    let oom_group_kills = event_delta(&before_events, &after_events, "oom_group_kill")?;
    if oom_group_kills == 0 {
        return Err("workload cgroup did not record an OOM group kill".to_string());
    }
    let memcg_ooms = event_delta(&before_events, &after_events, "oom")?;
    if (memcg_ooms == 0) != guest_wide {
        return Err(format!(
            "wrong OOM scope: guest_wide={guest_wide} memcg_ooms={memcg_ooms}"
        ));
    }
    let after_runtime_events = read_cgroup_events(&runtime_path.join("memory.events"))?;
    if event_delta(&before_runtime_events, &after_runtime_events, "oom_kill")? != 0 {
        return Err("OOM killed a runtime process instead of only the tool".to_string());
    }

    // Keep the competing runtime allocation alive through victim selection.
    std::hint::black_box(&runtime_memory);
    drop(runtime_memory);
    fixture.restore_memory_max()?;
    Ok(format!(
        "parallel-shell-tool-oom-survived oom_group_kill={oom_group_kills} guest_wide={guest_wide} memcg_ooms={memcg_ooms} offender={offender_relative} survivor={survivor_relative}"
    ))
}

pub(super) fn run_runtime_only_oom_scenario(output_format: &str) -> ExitCode {
    if output_format != "stream-json" {
        return ExitCode::from(1);
    }
    let result = verify_runtime_only_oom();
    eprintln!("runtime-only OOM fixture unexpectedly returned: {result:?}");
    ExitCode::from(1)
}

fn verify_runtime_only_oom() -> Result<(), String> {
    let runtime = unified_cgroup_path(std::process::id())?;
    let workload = runtime
        .strip_suffix("/runtime")
        .filter(|path| path.starts_with("/vm0-exec/exec-") && path.ends_with("/workload"))
        .ok_or_else(|| "runtime-only OOM requires managed runtime placement".to_string())?;
    if read_trimmed(Path::new("/proc/self/oom_score_adj"))? != "0" {
        return Err("runtime OOM score changed".to_string());
    }
    let path = Path::new("/sys/fs/cgroup").join(workload.trim_start_matches('/'));
    let original_max = read_trimmed(&path.join("memory.max"))?;
    let current = read_trimmed(&path.join("memory.current"))?
        .parse::<u64>()
        .map_err(|error| format!("parse runtime charge: {error}"))?;
    let fixture = ParallelToolOomFixture::new(path.join("memory.max"), original_max);
    write_cgroup_value_as_root(
        &fixture.memory_max_path,
        &(current + TOOL_OOM_PARENT_HEADROOM_BYTES).to_string(),
    )?;
    // No managed tools exist. Exhaust only this disposable operation's memcg;
    // the runtime must remain eligible, and Runner must report its real death.
    let mut chunks = Vec::new();
    for _ in 0..64 {
        chunks.push(vec![1_u8; 4 * 1024 * 1024]);
        std::hint::black_box(&chunks);
    }
    Err("runtime survived its test-only memory limit".to_string())
}

struct ParallelToolOomFixture {
    memory_max_path: PathBuf,
    original_memory_max: String,
    memory_max_restored: bool,
    survivor: Option<Child>,
    offender: Option<Child>,
}

impl ParallelToolOomFixture {
    fn new(memory_max_path: PathBuf, original_memory_max: String) -> Self {
        Self {
            memory_max_path,
            original_memory_max,
            memory_max_restored: false,
            survivor: None,
            offender: None,
        }
    }

    fn restore_memory_max(&mut self) -> Result<(), String> {
        write_cgroup_value_as_root(&self.memory_max_path, &self.original_memory_max)?;
        self.memory_max_restored = true;
        Ok(())
    }
}

impl Drop for ParallelToolOomFixture {
    fn drop(&mut self) {
        let tools_relative = unified_cgroup_path(std::process::id())
            .ok()
            .and_then(|runtime| {
                runtime
                    .strip_suffix("/runtime")
                    .map(|path| format!("{path}/tools"))
            });
        for child in [&mut self.offender, &mut self.survivor]
            .into_iter()
            .flatten()
        {
            // A fixture error must not leave distributed allocators behind.
            // Only kill this owned child's validated tool leaf, never runtime.
            if let Some(tools_relative) = &tools_relative
                && let Ok(relative) = unified_cgroup_path(child.id())
                && validate_tool_cgroup(&relative, tools_relative).is_ok()
            {
                let path = Path::new("/sys/fs/cgroup")
                    .join(relative.trim_start_matches('/'))
                    .join("cgroup.kill");
                let _ = write_cgroup_value_as_root(&path, "1");
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        if !self.memory_max_restored {
            let _ = write_cgroup_value_as_root(&self.memory_max_path, &self.original_memory_max);
        }
    }
}

fn spawn_bash_tool(script: &str) -> Result<Child, String> {
    bash_tool_command()
        .args(["-c", script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("spawn Bash tool: {error}"))
}

fn wait_for_tool_marker(path: &str, child: &mut Child) -> Result<String, String> {
    let deadline = Instant::now() + TOOL_MARKER_TIMEOUT;
    loop {
        match std::fs::read_to_string(path) {
            Ok(contents) if !contents.trim().is_empty() => return Ok(contents.trim().to_string()),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("read Bash tool cgroup marker {path}: {error}")),
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("inspect Bash tool before readiness: {error}"))?
        {
            return Err(format!(
                "Bash tool exited before publishing cgroup marker {path}: {status}"
            ));
        }
        if Instant::now() >= deadline {
            return Err(format!("Bash tool did not publish cgroup marker {path}"));
        }
        std::thread::sleep(TOOL_OOM_POLL_INTERVAL);
    }
}

fn wait_for_child_exit(
    child: &mut Child,
    timeout: Duration,
    description: &str,
) -> Result<std::process::ExitStatus, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("wait for {description}: {error}"))?
        {
            return Ok(status);
        }
        if Instant::now() >= deadline {
            return Err(format!("{description} did not exit within {timeout:?}"));
        }
        std::thread::sleep(TOOL_OOM_POLL_INTERVAL);
    }
}

fn validate_tool_cgroup(relative: &str, tools_relative: &str) -> Result<(), String> {
    let prefix = format!("{tools_relative}/tool-");
    if !relative.starts_with(&prefix)
        || relative[prefix.len()..].is_empty()
        || relative[prefix.len()..].contains('/')
    {
        return Err(format!("unexpected Bash tool cgroup: {relative}"));
    }
    let path = Path::new("/sys/fs/cgroup").join(relative.trim_start_matches('/'));
    if read_trimmed(&path.join("memory.oom.group"))? != "1" {
        return Err(format!(
            "Bash tool cgroup does not enable memory.oom.group: {relative}"
        ));
    }
    Ok(())
}

fn unified_cgroup_path(pid: u32) -> Result<String, String> {
    let contents = std::fs::read_to_string(format!("/proc/{pid}/cgroup"))
        .map_err(|error| format!("read process cgroup: {error}"))?;
    contents
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .map(str::to_string)
        .ok_or_else(|| "unified cgroup path is missing".to_string())
}

fn read_trimmed(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path)
        .map(|value| value.trim().to_string())
        .map_err(|error| format!("read {}: {error}", path.display()))
}

fn write_cgroup_value_as_root(path: &Path, value: &str) -> Result<(), String> {
    let mut child = Command::new("sudo")
        .args(["-n", "tee"])
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .map_err(|error| format!("start privileged write to {}: {error}", path.display()))?;
    let stdin = child
        .stdin
        .as_mut()
        .ok_or_else(|| format!("open privileged write to {}", path.display()))?;
    stdin
        .write_all(value.as_bytes())
        .map_err(|error| format!("write {}: {error}", path.display()))?;
    drop(child.stdin.take());
    let status = child
        .wait()
        .map_err(|error| format!("wait for privileged write to {}: {error}", path.display()))?;
    if !status.success() {
        return Err(format!(
            "privileged write to {} failed: {status}",
            path.display()
        ));
    }
    Ok(())
}

fn read_cgroup_events(path: &Path) -> Result<BTreeMap<String, u64>, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    contents
        .lines()
        .map(|line| {
            let (name, value) = line
                .split_once(' ')
                .ok_or_else(|| format!("invalid cgroup event line: {line}"))?;
            let value = value
                .parse::<u64>()
                .map_err(|error| format!("invalid cgroup event value {value}: {error}"))?;
            Ok((name.to_string(), value))
        })
        .collect()
}

fn event_delta(
    before: &BTreeMap<String, u64>,
    after: &BTreeMap<String, u64>,
    name: &str,
) -> Result<u64, String> {
    let before = before
        .get(name)
        .ok_or_else(|| format!("cgroup event is missing before OOM: {name}"))?;
    let after = after
        .get(name)
        .ok_or_else(|| format!("cgroup event is missing after OOM: {name}"))?;
    after
        .checked_sub(*before)
        .ok_or_else(|| format!("cgroup event counter decreased: {name}"))
}
