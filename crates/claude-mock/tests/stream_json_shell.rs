pub mod support;

use std::collections::HashSet;
use std::fs;
use std::process::Stdio;

#[cfg(unix)]
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::process::Command;
#[cfg(unix)]
use std::sync::mpsc;
#[cfg(unix)]
use std::time::{Duration, Instant};

#[cfg(unix)]
use claude_mock::process_group_child::observe_child_exit_without_reaping;
use serde_json::Value;
#[cfg(target_os = "linux")]
use support::kill_pid_file;
#[cfg(unix)]
use support::{
    ChildWaitOutcome, continue_cleanup_in_background, run_mock_output_with_orphaned_stdout,
    wait_child_status_and_cleanup_group_with_observer,
};
use support::{
    LARGE_MOCK_OUTPUT_BYTES, MOCK_CAPTURE_LIMIT_BYTES, STDERR_TRUNCATION_MARKER,
    STDOUT_TRUNCATION_MARKER, event_kind, expected_history_path, init_session_id, mock_claude,
    mock_stream_json_shell_output, parse_jsonl, result_content, run_mock_output,
    spawn_managed_mock_child, tool_result_content, wait_child_output,
};

#[test]
fn stream_json_shell_writes_matching_session_history() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;

    let mut command = mock_claude();
    command
        .env("HOME", home.path())
        .args(["--output-format", "stream-json", "--", "printf hello"]);
    let output = run_mock_output(&mut command)?;

    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let session_id = init_session_id(&events)?;
    let stdout = String::from_utf8(output.stdout)?;
    let history = fs::read_to_string(expected_history_path(home.path(), &session_id))?;

    assert_eq!(history, stdout);
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        [
            "system/init",
            "assistant/text",
            "assistant/tool_use",
            "user/tool_result",
            "result/success",
        ]
    );
    assert_eq!(
        events[2]
            .pointer("/message/content/0/input/command")
            .and_then(Value::as_str),
        Some("printf hello")
    );
    assert_eq!(
        events[3]
            .pointer("/message/content/0/content")
            .and_then(Value::as_str),
        Some("hello")
    );
    assert_eq!(
        events[4].get("result").and_then(Value::as_str),
        Some("hello")
    );
    assert_eq!(
        events[4].get("is_error").and_then(Value::as_bool),
        Some(false)
    );
    Ok(())
}

#[test]
fn stream_json_shell_background_child_does_not_hold_output_open()
-> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;

    let output = mock_stream_json_shell_output(home.path(), "sleep 30 & echo done")?;
    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        [
            "system/init",
            "assistant/text",
            "assistant/tool_use",
            "user/tool_result",
            "result/success",
        ]
    );
    assert!(tool_result_content(&events)?.contains("done"));
    assert!(result_content(&events)?.contains("done"));
    Ok(())
}

#[cfg(target_os = "linux")]
#[test]
fn stream_json_shell_escaped_child_does_not_hold_output_open()
-> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let ready = home.path().join("escaped-child-ready");
    let pid_file = home.path().join("escaped-child-pid");
    let ready_path = ready.to_string_lossy();
    let pid_path = pid_file.to_string_lossy();
    let prompt = format!(
        "setsid sh -c 'echo $$ > \"{pid_path}\"; echo ready > \"{ready_path}\"; exec sleep 30' & \
         while [ ! -f \"{ready_path}\" ]; do :; done; echo done"
    );

    let output = mock_stream_json_shell_output(home.path(), &prompt);
    kill_pid_file(&pid_file);
    let output = output?;
    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        [
            "system/init",
            "assistant/text",
            "assistant/tool_use",
            "user/tool_result",
            "result/success",
        ]
    );
    assert!(tool_result_content(&events)?.contains("done"));
    assert!(result_content(&events)?.contains("done"));
    Ok(())
}

#[cfg(target_os = "linux")]
#[test]
fn stream_json_shell_truncated_escaped_stderr_writer_does_not_hold_output_open()
-> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let ready = home.path().join("escaped-stderr-ready");
    let pid_file = home.path().join("escaped-stderr-pid");
    let ready_path = ready.to_string_lossy();
    let pid_path = pid_file.to_string_lossy();
    let prompt = format!(
        "setsid sh -c 'echo $$ > \"{pid_path}\"; yes escaped-stderr | head -c {LARGE_MOCK_OUTPUT_BYTES} >&2; echo ready > \"{ready_path}\"; exec yes escaped-stderr >&2' & \
         while [ ! -f \"{ready_path}\" ]; do :; done; echo done"
    );

    let output = mock_stream_json_shell_output(home.path(), &prompt);
    kill_pid_file(&pid_file);
    let output = output?;
    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        [
            "system/init",
            "assistant/text",
            "assistant/tool_use",
            "user/tool_result",
            "result/success",
        ]
    );
    assert!(tool_result_content(&events)?.contains("done"));
    assert!(result_content(&events)?.contains("done"));
    assert!(!tool_result_content(&events)?.contains("escaped-stderr"));
    assert!(!result_content(&events)?.contains("escaped-stderr"));
    Ok(())
}

#[test]
fn concurrent_stream_json_ids_are_unique() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let children = (0..16)
        .map(|_| {
            let mut command = mock_claude();
            command
                .env("HOME", home.path())
                .args(["--output-format", "stream-json", "--", "true"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            spawn_managed_mock_child(&mut command)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut session_ids = HashSet::new();

    for child in children {
        let output = wait_child_output(child)?;
        assert!(
            output.status.success(),
            "expected success, stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stderr.is_empty());

        let events = parse_jsonl(&output.stdout)?;
        let session_id = init_session_id(&events)?;
        assert!(
            session_ids.insert(session_id.clone()),
            "duplicate session id: {session_id}"
        );
        assert!(expected_history_path(home.path(), &session_id).exists());
    }

    Ok(())
}

#[test]
fn stream_json_shell_failure_writes_error_history() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;

    let mut command = mock_claude();
    command.env("HOME", home.path()).args([
        "--output-format",
        "stream-json",
        "--",
        "printf out; printf err >&2; exit 7",
    ]);
    let output = run_mock_output(&mut command)?;

    assert_eq!(output.status.code(), Some(7));
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let session_id = init_session_id(&events)?;
    let stdout = String::from_utf8(output.stdout)?;
    let history = fs::read_to_string(expected_history_path(home.path(), &session_id))?;

    assert_eq!(history, stdout);
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        [
            "system/init",
            "assistant/text",
            "assistant/tool_use",
            "user/tool_result",
            "result/error",
        ]
    );
    assert_eq!(
        events[3]
            .pointer("/message/content/0/content")
            .and_then(Value::as_str),
        Some("outerr")
    );
    assert_eq!(
        events[3]
            .pointer("/message/content/0/is_error")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        events[4].get("result").and_then(Value::as_str),
        Some("outerr")
    );
    assert_eq!(
        events[4].get("is_error").and_then(Value::as_bool),
        Some(true)
    );
    Ok(())
}

#[test]
fn stream_json_shell_large_stdout_is_bounded() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let prompt = format!("yes A | head -c {LARGE_MOCK_OUTPUT_BYTES}");

    let output = mock_stream_json_shell_output(home.path(), &prompt)?;

    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let session_id = init_session_id(&events)?;
    let stdout = String::from_utf8(output.stdout)?;
    let history = fs::read_to_string(expected_history_path(home.path(), &session_id))?;
    let tool_output = tool_result_content(&events)?;
    let result_output = result_content(&events)?;

    assert_eq!(history, stdout);
    assert_eq!(tool_output, result_output);
    assert!(tool_output.contains(STDOUT_TRUNCATION_MARKER));
    assert!(!tool_output.contains(STDERR_TRUNCATION_MARKER));
    assert!(tool_output.len() <= MOCK_CAPTURE_LIMIT_BYTES + 128);
    let expected_output = format!(
        "{}\n{STDOUT_TRUNCATION_MARKER}\n",
        "A\n".repeat(MOCK_CAPTURE_LIMIT_BYTES / 2)
    );
    assert_eq!(tool_output.len(), expected_output.len());
    assert!(tool_output == expected_output, "unexpected retained stdout");
    Ok(())
}

#[test]
fn stream_json_shell_large_stderr_failure_is_bounded() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let prompt = format!("printf out; yes E | head -c {LARGE_MOCK_OUTPUT_BYTES} >&2; exit 7");

    let output = mock_stream_json_shell_output(home.path(), &prompt)?;

    assert_eq!(output.status.code(), Some(7));
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let tool_output = tool_result_content(&events)?;
    let result_output = result_content(&events)?;

    assert_eq!(tool_output, result_output);
    assert!(tool_output.starts_with("out"));
    assert!(tool_output.contains(STDERR_TRUNCATION_MARKER));
    assert!(!tool_output.contains(STDOUT_TRUNCATION_MARKER));
    assert!(tool_output.len() <= MOCK_CAPTURE_LIMIT_BYTES + 128);
    let expected_output = format!(
        "out{}\n{STDERR_TRUNCATION_MARKER}\n",
        "E\n".repeat(MOCK_CAPTURE_LIMIT_BYTES / 2)
    );
    assert_eq!(tool_output.len(), expected_output.len());
    assert!(tool_output == expected_output, "unexpected retained stderr");
    Ok(())
}

#[test]
fn stream_json_shell_large_stdout_and_stderr_do_not_deadlock()
-> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let prompt = format!(
        "yes O | head -c {LARGE_MOCK_OUTPUT_BYTES}; \
         yes E | head -c {LARGE_MOCK_OUTPUT_BYTES} >&2; \
         exit 8"
    );

    let output = mock_stream_json_shell_output(home.path(), &prompt)?;

    assert_eq!(output.status.code(), Some(8));
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let tool_output = tool_result_content(&events)?;
    let result_output = result_content(&events)?;

    assert_eq!(tool_output, result_output);
    assert!(tool_output.contains(STDOUT_TRUNCATION_MARKER));
    assert!(tool_output.contains(STDERR_TRUNCATION_MARKER));
    assert!(tool_output.len() <= (MOCK_CAPTURE_LIMIT_BYTES * 2) + 256);
    let expected_output = format!(
        "{}\n{STDOUT_TRUNCATION_MARKER}\n{}\n{STDERR_TRUNCATION_MARKER}\n",
        "O\n".repeat(MOCK_CAPTURE_LIMIT_BYTES / 2),
        "E\n".repeat(MOCK_CAPTURE_LIMIT_BYTES / 2)
    );
    assert_eq!(tool_output.len(), expected_output.len());
    assert!(
        tool_output == expected_output,
        "unexpected retained streams"
    );
    Ok(())
}

#[test]
fn stream_json_shell_stdout_preserves_capture_boundary() -> Result<(), Box<dyn std::error::Error>> {
    for (output_bytes, retained_bytes, truncated) in [
        (
            MOCK_CAPTURE_LIMIT_BYTES - 1,
            MOCK_CAPTURE_LIMIT_BYTES - 1,
            false,
        ),
        (MOCK_CAPTURE_LIMIT_BYTES, MOCK_CAPTURE_LIMIT_BYTES, false),
        (MOCK_CAPTURE_LIMIT_BYTES + 1, MOCK_CAPTURE_LIMIT_BYTES, true),
    ] {
        let home = tempfile::tempdir()?;
        let prompt = format!("yes 0123456789abcdef | head -c {output_bytes}");

        let output = mock_stream_json_shell_output(home.path(), &prompt)?;

        assert!(
            output.status.success(),
            "expected success, stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stderr.is_empty());

        let events = parse_jsonl(&output.stdout)?;
        let tool_output = tool_result_content(&events)?;
        let result_output = result_content(&events)?;
        let expected_prefix: String = "0123456789abcdef\n"
            .chars()
            .cycle()
            .take(retained_bytes)
            .collect();
        let expected_output = if truncated {
            format!("{expected_prefix}\n{STDOUT_TRUNCATION_MARKER}\n")
        } else {
            expected_prefix
        };

        assert_eq!(tool_output, result_output);
        assert_eq!(
            tool_output.len(),
            expected_output.len(),
            "{output_bytes} bytes"
        );
        assert!(
            tool_output == expected_output,
            "unexpected retained stdout for {output_bytes} bytes"
        );
    }
    Ok(())
}

#[test]
fn stream_json_shell_stderr_failure_preserves_capture_boundary()
-> Result<(), Box<dyn std::error::Error>> {
    for (output_bytes, retained_bytes, truncated) in [
        (
            MOCK_CAPTURE_LIMIT_BYTES - 1,
            MOCK_CAPTURE_LIMIT_BYTES - 1,
            false,
        ),
        (MOCK_CAPTURE_LIMIT_BYTES, MOCK_CAPTURE_LIMIT_BYTES, false),
        (MOCK_CAPTURE_LIMIT_BYTES + 1, MOCK_CAPTURE_LIMIT_BYTES, true),
    ] {
        let home = tempfile::tempdir()?;
        let prompt =
            format!("printf out; yes fedcba9876543210 | head -c {output_bytes} >&2; exit 7");

        let output = mock_stream_json_shell_output(home.path(), &prompt)?;

        assert_eq!(output.status.code(), Some(7));
        assert!(output.stderr.is_empty());

        let events = parse_jsonl(&output.stdout)?;
        let tool_output = tool_result_content(&events)?;
        let result_output = result_content(&events)?;
        let expected_prefix: String = "fedcba9876543210\n"
            .chars()
            .cycle()
            .take(retained_bytes)
            .collect();
        let expected_output = if truncated {
            format!("out{expected_prefix}\n{STDERR_TRUNCATION_MARKER}\n")
        } else {
            format!("out{expected_prefix}")
        };

        assert_eq!(tool_output, result_output);
        assert_eq!(
            tool_output.len(),
            expected_output.len(),
            "{output_bytes} bytes"
        );
        assert!(
            tool_output == expected_output,
            "unexpected retained stderr for {output_bytes} bytes"
        );
    }
    Ok(())
}

#[test]
fn stream_json_shell_success_drains_stderr_without_exposing_it()
-> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let prompt = format!("yes hidden-stderr | head -c {LARGE_MOCK_OUTPUT_BYTES} >&2; printf ok");

    let output = mock_stream_json_shell_output(home.path(), &prompt)?;

    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let tool_output = tool_result_content(&events)?;
    let result_output = result_content(&events)?;

    assert_eq!(tool_output, "ok");
    assert_eq!(result_output, "ok");
    Ok(())
}

#[test]
fn stream_json_shell_invalid_utf8_output_remains_valid_jsonl()
-> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;

    let output = mock_stream_json_shell_output(home.path(), "printf '\\377'")?;

    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let tool_output = tool_result_content(&events)?;
    let result_output = result_content(&events)?;

    assert_eq!(tool_output, "\u{fffd}");
    assert_eq!(result_output, "\u{fffd}");
    Ok(())
}

#[test]
fn exit_after_result_writes_init_and_result_history() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;

    let mut command = mock_claude();
    command.env("HOME", home.path()).args([
        "--output-format",
        "stream-json",
        "--",
        "@exit-after-result",
    ]);
    let output = run_mock_output(&mut command)?;

    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let session_id = init_session_id(&events)?;
    let stdout = String::from_utf8(output.stdout)?;
    let history = fs::read_to_string(expected_history_path(home.path(), &session_id))?;

    assert_eq!(history, stdout);
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        ["system/init", "result/success"]
    );
    assert_eq!(
        events[0].get("model").and_then(Value::as_str),
        Some("mock-claude")
    );
    assert_eq!(
        events[0]
            .get("tools")
            .and_then(Value::as_array)
            .and_then(|tools| tools.first())
            .and_then(Value::as_str),
        Some("Bash")
    );
    assert_eq!(
        events[1].get("result").and_then(Value::as_str),
        Some("Done.")
    );
    assert_eq!(
        events[1].get("is_error").and_then(Value::as_bool),
        Some(false)
    );
    Ok(())
}

#[cfg(any(
    target_os = "linux",
    target_vendor = "apple",
    target_os = "freebsd",
    target_os = "dragonfly",
    target_os = "openbsd",
    target_os = "netbsd",
    target_os = "solaris",
    target_os = "illumos",
    target_os = "aix",
    target_os = "haiku",
    target_os = "hurd",
    target_os = "nto",
))]
#[test]
fn orphan_pipe_does_not_block_output_wait() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;

    let mut command = mock_claude();
    command
        .env("HOME", home.path())
        .args(["--output-format", "stream-json", "--", "@orphan-pipe"]);
    let output = run_mock_output_with_orphaned_stdout(&mut command)?;

    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        ["system/init", "result/success"]
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn orphan_pipe_rejects_child_startup_failure() -> Result<(), Box<dyn std::error::Error>> {
    for (case, non_executable_sleep) in [("missing sleep", false), ("non-executable sleep", true)] {
        let home = tempfile::tempdir()?;
        if non_executable_sleep {
            let sleep = home.path().join("sleep");
            fs::write(&sleep, b"not executable")?;
            fs::set_permissions(&sleep, fs::Permissions::from_mode(0o644))?;
        }
        let mut command = mock_claude();
        command
            .env("HOME", home.path())
            .env("PATH", home.path())
            .args(["--output-format", "stream-json", "--", "@orphan-pipe"]);
        let output = run_mock_output(&mut command)?;

        assert_eq!(output.status.code(), Some(1), "{case}");
        assert!(output.stdout.is_empty(), "{case}: published success output");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("start orphan-pipe child:"),
            "{case}: missing startup diagnostic"
        );
    }
    Ok(())
}

#[cfg(unix)]
#[test]
fn post_sigkill_timeout_transfers_child_and_pipe_cleanup() -> Result<(), Box<dyn std::error::Error>>
{
    const STDOUT_PREFIX: &[u8] = b"stdout-ready";
    const STDERR_PREFIX: &[u8] = b"stderr-ready";
    const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);

    let mut command = Command::new("sh");
    command
        .args([
            "-c",
            "printf stdout-ready; printf stderr-ready >&2; exec sleep 30",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = spawn_managed_mock_child(&mut command)?;
    let child_pid = child.id();
    let Some(mut child_stdout) = child.take_stdout() else {
        child.terminate();
        return Err(std::io::Error::other("missing test child stdout").into());
    };
    let Some(mut child_stderr) = child.take_stderr() else {
        child.terminate();
        return Err(std::io::Error::other("missing test child stderr").into());
    };

    let (stdout_ready_tx, stdout_ready_rx) = mpsc::channel();
    let (stdout_result_tx, stdout_result_rx) = mpsc::channel();
    let stdout_thread = std::thread::spawn(move || {
        let result = (|| -> std::io::Result<Vec<u8>> {
            let mut output = vec![0; STDOUT_PREFIX.len()];
            child_stdout.read_exact(&mut output)?;
            stdout_ready_tx
                .send(())
                .map_err(|_| std::io::Error::other("stdout readiness receiver dropped"))?;
            child_stdout.read_to_end(&mut output)?;
            Ok(output)
        })();
        let _ = stdout_result_tx.send(result);
    });

    let (stderr_ready_tx, stderr_ready_rx) = mpsc::channel();
    let (stderr_result_tx, stderr_result_rx) = mpsc::channel();
    let stderr_thread = std::thread::spawn(move || {
        let result = (|| -> std::io::Result<Vec<u8>> {
            let mut output = vec![0; STDERR_PREFIX.len()];
            child_stderr.read_exact(&mut output)?;
            stderr_ready_tx
                .send(())
                .map_err(|_| std::io::Error::other("stderr readiness receiver dropped"))?;
            child_stderr.read_to_end(&mut output)?;
            Ok(output)
        })();
        let _ = stderr_result_tx.send(result);
    });

    for (stream, ready_rx) in [("stdout", &stdout_ready_rx), ("stderr", &stderr_ready_rx)] {
        if let Err(error) = ready_rx.recv_timeout(CLEANUP_TIMEOUT) {
            child.terminate();
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("{stream} reader did not become ready: {error}"),
            )
            .into());
        }
    }

    let (observer_ready_tx, observer_ready_rx) = mpsc::channel();
    let (release_observer_tx, release_observer_rx) = mpsc::channel();
    let started = Instant::now();
    let outcome = wait_child_status_and_cleanup_group_with_observer(
        child,
        Duration::ZERO,
        Duration::from_millis(20),
        move |pid| {
            observe_child_exit_without_reaping(pid)?;
            observer_ready_tx
                .send(())
                .map_err(|_| std::io::Error::other("observer readiness receiver dropped"))?;
            let _ = release_observer_rx.recv();
            Ok(())
        },
    );
    let elapsed = started.elapsed();

    let (cleanup, error) = match outcome {
        ChildWaitOutcome::CleanupPending { cleanup, error } => (cleanup, error),
        ChildWaitOutcome::Complete(result) => {
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            return Err(std::io::Error::other(format!(
                "expected pending child cleanup, got {result:?}"
            ))
            .into());
        }
    };
    let (cleanup_complete_tx, cleanup_complete_rx) = mpsc::channel();
    continue_cleanup_in_background(
        cleanup,
        stdout_thread,
        stderr_thread,
        Some(cleanup_complete_tx),
    );

    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    assert!(
        error
            .to_string()
            .starts_with("mock child did not exit after SIGKILL:"),
        "unexpected timeout diagnostic: {error}"
    );
    assert!(
        elapsed < Duration::from_secs(1),
        "foreground timeout should remain bounded, elapsed: {elapsed:?}"
    );

    observer_ready_rx.recv_timeout(CLEANUP_TIMEOUT)?;
    release_observer_tx.send(())?;
    cleanup_complete_rx.recv_timeout(CLEANUP_TIMEOUT)?;

    let stdout = stdout_result_rx.recv_timeout(CLEANUP_TIMEOUT)??;
    let stderr = stderr_result_rx.recv_timeout(CLEANUP_TIMEOUT)??;
    assert_eq!(stdout, STDOUT_PREFIX);
    assert_eq!(stderr, STDERR_PREFIX);

    let child_pid = libc::pid_t::try_from(child_pid)?;
    let mut status = 0;
    // SAFETY: cleanup completion reports that the owned direct child has
    // already been waited; WNOHANG only verifies that no waitable child remains.
    let wait_result = unsafe { libc::waitpid(child_pid, &mut status, libc::WNOHANG) };
    assert_eq!(wait_result, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ECHILD)
    );

    Ok(())
}
