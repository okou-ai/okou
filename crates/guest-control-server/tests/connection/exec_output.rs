use std::time::Duration;

use guest_contracts::exec_terminal::EXEC_OUTPUT_DRAIN_DEADLINE;
use guest_control_proto::{ExecOutputPolicy, ExecOutputStream, ExecTermination};

use super::exec_helpers::{EXEC_OPERATION_TIMEOUT_TEST_MS, read_exec_stdout_output};
use super::support::*;

#[test]
fn exec_operation_captures_binary_tails_after_large_stdout_stderr() {
    let (handle, mut host_stream) = start_guest_connection();
    let payload_len = 64 * 1024usize;
    let len = payload_len + 3;

    send_exec_start(
        &mut host_stream,
        138,
        "head -c 65536 /dev/zero | tr '\\0' o; printf '\\000\\377\\001'; head -c 65536 /dev/zero | tr '\\0' e >&2; printf '\\376\\000\\002' >&2",
        5000,
        ExecOutputPolicy::Capture {
            limit_bytes: len as u32,
        },
        ExecOutputPolicy::Capture {
            limit_bytes: len as u32,
        },
    );
    let (chunks, result) = read_exec_result(&mut host_stream, 138);

    assert!(chunks.is_empty());
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    let stdout = result.stdout.unwrap();
    let stderr = result.stderr.unwrap();
    assert_eq!(stdout.len(), len);
    assert_eq!(stderr.len(), len);
    let mut expected_stdout = vec![b'o'; payload_len];
    expected_stdout.extend_from_slice(&[0, 255, 1]);
    let mut expected_stderr = vec![b'e'; payload_len];
    expected_stderr.extend_from_slice(&[254, 0, 2]);
    assert_eq!(stdout, expected_stdout);
    assert_eq!(stderr, expected_stderr);
    assert!(!result.stdout_truncated);
    assert!(!result.stderr_truncated);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_stream_only_stdout_stderr_success() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start(
        &mut host_stream,
        102,
        "printf out; printf err >&2",
        5000,
        ExecOutputPolicy::Stream {
            limit_bytes: 64,
            chunk_limit_bytes: 8,
        },
        ExecOutputPolicy::Stream {
            limit_bytes: 64,
            chunk_limit_bytes: 8,
        },
    );
    let (chunks, result) = read_exec_result(&mut host_stream, 102);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, None);
    assert_eq!(result.stderr, None);
    assert_eq!(stdout_data(&chunks), b"out".to_vec());
    assert_eq!(stderr_data(&chunks), b"err".to_vec());
    for (expected, chunk) in chunks.iter().enumerate() {
        assert_eq!(chunk.output_seq, expected as u32);
    }

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_stream_handles_many_small_chunks() {
    let (handle, mut host_stream) = start_guest_connection();
    let expected = "x".repeat(96);
    let command = format!("printf {expected}");

    send_exec_start(
        &mut host_stream,
        116,
        &command,
        5000,
        ExecOutputPolicy::Stream {
            limit_bytes: expected.len() as u32,
            chunk_limit_bytes: 1,
        },
        ExecOutputPolicy::Discard,
    );
    let (chunks, result) = read_exec_result(&mut host_stream, 116);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(stdout_data(&chunks), expected.as_bytes());
    assert_eq!(chunks.len(), expected.len());
    assert!(chunks.iter().all(|chunk| !chunk.truncated));
    for (expected_seq, chunk) in chunks.iter().enumerate() {
        assert_eq!(chunk.output_seq, expected_seq as u32);
    }

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_stream_sequences_many_stdout_stderr_chunks() {
    let (handle, mut host_stream) = start_guest_connection();
    let expected_stdout = "o".repeat(64);
    let expected_stderr = "e".repeat(64);

    send_exec_start(
        &mut host_stream,
        124,
        "i=0; while [ \"$i\" -lt 64 ]; do printf o; printf e >&2; i=$((i + 1)); done",
        5000,
        ExecOutputPolicy::Stream {
            limit_bytes: expected_stdout.len() as u32,
            chunk_limit_bytes: 1,
        },
        ExecOutputPolicy::Stream {
            limit_bytes: expected_stderr.len() as u32,
            chunk_limit_bytes: 1,
        },
    );
    let (chunks, result) = read_exec_result(&mut host_stream, 124);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(stdout_data(&chunks), expected_stdout.as_bytes());
    assert_eq!(stderr_data(&chunks), expected_stderr.as_bytes());
    assert_eq!(chunks.len(), expected_stdout.len() + expected_stderr.len());
    for (expected_seq, chunk) in chunks.iter().enumerate() {
        assert_eq!(chunk.output_seq, expected_seq as u32);
    }

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_capture_and_stream_success() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start(
        &mut host_stream,
        103,
        "printf visible; printf visible >&2",
        5000,
        ExecOutputPolicy::CaptureAndStream {
            capture_limit_bytes: 64,
            stream_limit_bytes: 64,
            chunk_limit_bytes: 4,
        },
        ExecOutputPolicy::CaptureAndStream {
            capture_limit_bytes: 5,
            stream_limit_bytes: 6,
            chunk_limit_bytes: 2,
        },
    );
    let (chunks, result) = read_exec_result(&mut host_stream, 103);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, Some(b"visible".to_vec()));
    assert!(!result.stdout_truncated);
    assert_eq!(result.stderr, Some(b"visib".to_vec()));
    assert!(result.stderr_truncated);
    assert_eq!(stdout_data(&chunks), b"visible".to_vec());
    assert_eq!(stderr_data(&chunks), b"visibl".to_vec());
    assert!(chunks.iter().all(|chunk| match chunk.stream {
        ExecOutputStream::Stdout => chunk.chunk.len() <= 4 && !chunk.truncated,
        ExecOutputStream::Stderr => chunk.chunk.len() <= 2,
    }));
    assert!(chunks.iter().any(|chunk| {
        chunk.stream == ExecOutputStream::Stderr && chunk.truncated && chunk.chunk.is_empty()
    }));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_capture_limits_track_exact_and_one_byte_over() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start(
        &mut host_stream,
        104,
        "printf abcd",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 4 },
        ExecOutputPolicy::Discard,
    );
    let (_chunks, exact) = read_exec_result(&mut host_stream, 104);
    assert_eq!(exact.stdout, Some(b"abcd".to_vec()));
    assert!(!exact.stdout_truncated);

    send_exec_start(
        &mut host_stream,
        105,
        "printf abcde",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 4 },
        ExecOutputPolicy::Discard,
    );
    let (_chunks, over) = read_exec_result(&mut host_stream, 105);
    assert_eq!(over.stdout, Some(b"abcd".to_vec()));
    assert!(over.stdout_truncated);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_stream_limits_track_exact_over_and_zero_budget() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start(
        &mut host_stream,
        106,
        "printf abcd",
        5000,
        ExecOutputPolicy::Stream {
            limit_bytes: 4,
            chunk_limit_bytes: 2,
        },
        ExecOutputPolicy::Discard,
    );
    let (exact_chunks, exact) = read_exec_result(&mut host_stream, 106);
    assert_eq!(exact.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(stdout_data(&exact_chunks), b"abcd".to_vec());
    assert!(exact_chunks.iter().all(|chunk| !chunk.truncated));

    send_exec_start(
        &mut host_stream,
        107,
        "printf abcde",
        5000,
        ExecOutputPolicy::Stream {
            limit_bytes: 4,
            chunk_limit_bytes: 2,
        },
        ExecOutputPolicy::Discard,
    );
    let (over_chunks, over) = read_exec_result(&mut host_stream, 107);
    assert_eq!(over.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(stdout_data(&over_chunks), b"abcd".to_vec());
    assert!(
        over_chunks
            .iter()
            .any(|chunk| chunk.stream == ExecOutputStream::Stdout
                && chunk.truncated
                && chunk.chunk.is_empty())
    );

    send_exec_start(
        &mut host_stream,
        108,
        "printf abc",
        5000,
        ExecOutputPolicy::Stream {
            limit_bytes: 0,
            chunk_limit_bytes: 2,
        },
        ExecOutputPolicy::Discard,
    );
    let (zero_chunks, zero) = read_exec_result(&mut host_stream, 108);
    assert_eq!(zero.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(stdout_data(&zero_chunks), Vec::<u8>::new());
    assert_eq!(zero_chunks.len(), 1);
    assert_eq!(zero_chunks[0].stream, ExecOutputStream::Stdout);
    assert!(zero_chunks[0].truncated);
    assert!(zero_chunks[0].chunk.is_empty());

    send_exec_start(
        &mut host_stream,
        139,
        "printf abcde >&2",
        5000,
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Stream {
            limit_bytes: 4,
            chunk_limit_bytes: 2,
        },
    );
    let (stderr_over_chunks, stderr_over) = read_exec_result(&mut host_stream, 139);
    assert_eq!(
        stderr_over.termination,
        ExecTermination::Exited { exit_code: 0 }
    );
    assert_eq!(stderr_over.stdout, None);
    assert_eq!(stderr_over.stderr, None);
    assert_eq!(stderr_data(&stderr_over_chunks), b"abcd".to_vec());
    assert!(
        stderr_over_chunks
            .iter()
            .any(|chunk| chunk.stream == ExecOutputStream::Stderr
                && chunk.truncated
                && chunk.chunk.is_empty())
    );

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_timeout_returns_timed_out_with_partial_capture() {
    let (handle, mut host_stream) = start_guest_connection();
    host_stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .unwrap();

    send_exec_start(
        &mut host_stream,
        109,
        "printf before; sleep 60",
        EXEC_OPERATION_TIMEOUT_TEST_MS,
        ExecOutputPolicy::CaptureAndStream {
            capture_limit_bytes: 64,
            stream_limit_bytes: 64,
            chunk_limit_bytes: 64,
        },
        ExecOutputPolicy::Capture { limit_bytes: 64 },
    );
    assert_eq!(
        read_exec_stdout_output(&mut host_stream, 109),
        b"before".to_vec()
    );
    let (_chunks, result) = read_exec_result(&mut host_stream, 109);

    assert_eq!(result.termination, ExecTermination::TimedOut);
    assert_eq!(result.stdout, Some(b"before".to_vec()));
    assert_eq!(result.stderr, Some(Vec::new()));

    finish_guest_connection(handle, host_stream);
}

/// Output written by an inherited-fd grandchild within the drain deadline must
/// still be included after the foreground shell exits.
#[test]
fn exec_operation_captures_grandchild_output_before_drain_deadline() {
    use std::time::Instant;

    let fifo_path = unique_tmp_path("exec-operation-grandchild-output", ".fifo");
    let (handle, mut host_stream) = start_guest_connection();
    host_stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .unwrap();

    let command = format!(
        "mkfifo '{}'; {{ cat '{}' >/dev/null; echo stdout-late; echo stderr-late >&2; }} & exec 3>'{}'; echo stdout-early; echo stderr-early >&2",
        fifo_path.as_str(),
        fifo_path.as_str(),
        fifo_path.as_str()
    );
    let start = Instant::now();
    send_exec_start(
        &mut host_stream,
        123,
        &command,
        LONG_RUNNING_EXEC_TIMEOUT_MS,
        ExecOutputPolicy::Capture { limit_bytes: 1024 },
        ExecOutputPolicy::Capture { limit_bytes: 1024 },
    );
    let (_chunks, result) = read_exec_result(&mut host_stream, 123);
    let elapsed = start.elapsed();

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(
        String::from_utf8_lossy(&result.stdout.unwrap_or_default()),
        "stdout-early\nstdout-late\n"
    );
    assert_eq!(
        String::from_utf8_lossy(&result.stderr.unwrap_or_default()),
        "stderr-early\nstderr-late\n"
    );
    assert!(
        elapsed < EXEC_OUTPUT_DRAIN_DEADLINE,
        "late output should be captured before drain deadline, took {elapsed:?}",
    );

    finish_guest_connection(handle, host_stream);
}
