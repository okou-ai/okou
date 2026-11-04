use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use crate::api::ApiError;
use crate::config::SnapshotConfig;

use super::*;

#[tokio::test]
async fn stderr_forwarder_bounds_oversized_records_and_keeps_following_output() {
    let mut input = vec![b'x'; PROCESS_LOG_RECORD_MAX_BYTES + 1];
    input.extend_from_slice(b"\nafter\n");
    let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));

    forward_stderr(input.as_slice(), &buf).await;

    assert_eq!(
        *buf.lock().expect("lock"),
        VecDeque::from([
            PROCESS_LOG_RECORD_TRUNCATED.to_string(),
            "after".to_string(),
        ])
    );
}

#[tokio::test]
async fn drain_stderr_forwarder_after_spawn_exit_waits_for_failed_status() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let drained = Arc::new(AtomicBool::new(false));
    let drained_for_task = Arc::clone(&drained);
    let mut handle = Some(tokio::spawn(async move {
        drained_for_task.store(true, Ordering::SeqCst);
    }));

    drain_stderr_forwarder_after_spawn_exit(&Ok(Some(exit_status_nonzero())), &mut handle).await;

    assert!(handle.is_none());
    assert!(drained.load(Ordering::SeqCst));
}

#[tokio::test]
async fn drain_stderr_forwarder_after_spawn_exit_preserves_other_handles() {
    async fn assert_handle_preserved(
        child_status: std::io::Result<Option<std::process::ExitStatus>>,
    ) {
        let mut handle = Some(tokio::spawn(std::future::pending::<()>()));

        drain_stderr_forwarder_after_spawn_exit(&child_status, &mut handle).await;
        let returned = handle.take().expect("handle should be preserved");

        assert!(
            !returned.is_finished(),
            "helper should not join or abort the forwarder"
        );
        returned.abort();
        let _ = returned.await;
    }

    assert_handle_preserved(Ok(None)).await;
    assert_handle_preserved(Ok(Some(exit_status_zero()))).await;
    assert_handle_preserved(Err(std::io::Error::from(std::io::ErrorKind::Interrupted))).await;
}

/// Empty stderr buffer should produce a sentinel string rather than
/// an empty error body. Verifies the early-exit error path is
/// always informative even with no captured output.
#[test]
fn drain_stderr_buf_reports_empty_with_sentinel() {
    let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));
    let s = drain_stderr_buf(&buf);
    assert!(s.contains("no stderr"), "got: {s}");
}

/// Captured lines are joined with newlines in insertion order.
#[test]
fn drain_stderr_buf_joins_lines() {
    let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));
    {
        let mut g = buf.lock().expect("lock");
        g.push_back("mount: bind failed".into());
        g.push_back("exit code 32".into());
    }
    assert_eq!(drain_stderr_buf(&buf), "mount: bind failed\nexit code 32");
}

/// At exact capacity, the stderr forwarder retains every record in order.
#[tokio::test]
async fn stderr_forwarder_retains_all_lines_at_exact_capacity() {
    let input = (0..STDERR_BUF_LINES)
        .map(|i| format!("line {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));

    forward_stderr(input.as_bytes(), &buf).await;

    let expected: VecDeque<_> = (0..STDERR_BUF_LINES).map(|i| format!("line {i}")).collect();
    assert_eq!(*buf.lock().expect("lock"), expected);
}

/// Past capacity, the stderr forwarder drops the oldest records and keeps
/// exactly the most recent `STDERR_BUF_LINES` records.
#[tokio::test]
async fn stderr_forwarder_evicts_oldest_lines_when_overflowing() {
    let total_lines = STDERR_BUF_LINES + 5;
    let input = (0..total_lines)
        .map(|i| format!("line {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));

    forward_stderr(input.as_bytes(), &buf).await;

    let buffer = buf.lock().expect("lock");
    assert_eq!(buffer.len(), STDERR_BUF_LINES);
    let expected: VecDeque<_> = (total_lines - STDERR_BUF_LINES..total_lines)
        .map(|i| format!("line {i}"))
        .collect();
    assert_eq!(*buffer, expected);
}

/// Build a placeholder `SnapshotConfig` for `Ok(_)` rewrap cases.
/// Values are irrelevant — the rewrap helper never inspects them.
fn placeholder_snapshot_config() -> SnapshotConfig {
    SnapshotConfig {
        snapshot_path: "/tmp/snapshot.bin".into(),
        memory_path: "/tmp/memory.bin".into(),
        cow_path: "/tmp/cow.img".into(),
        drive_bind_path: "/tmp/cow-device-bind".into(),
        home_drive_bind_path: "/tmp/home-device-bind".into(),
        vsock_bind_dir: "/tmp/vsock".into(),
    }
}

/// Build a `std::process::ExitStatus` with a given raw value. On Unix
/// this encodes: `raw = (exit_code << 8) | signal`. Using
/// `ExitStatus::from_raw(0x100)` yields exit code 1 / success=false.
fn exit_status_nonzero() -> std::process::ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(0x100)
}

fn exit_status_zero() -> std::process::ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(0)
}

fn stderr_buf_with_lines(lines: &[&str]) -> StderrBuf {
    let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));
    {
        let mut g = buf.lock().expect("lock");
        for line in lines {
            g.push_back((*line).to_string());
        }
    }
    buf
}

/// The target case: API error + child already exited non-zero → rewrap
/// into a Process error that names the captured stderr.
#[test]
fn rewrap_replaces_api_error_when_child_exited_nonzero() {
    let api_err = ApiError::Other("timeout".into());
    let err = rewrap_spawn_chain_exit(
        Err(SnapshotError::Api(api_err)),
        Ok(Some(exit_status_nonzero())),
        &stderr_buf_with_lines(&["mount: bind failed", "exit 32"]),
    )
    .unwrap_err();
    match err {
        SnapshotError::Process(msg) => {
            assert!(msg.contains("mount: bind failed"), "got: {msg}");
            assert!(msg.contains("exit 32"), "got: {msg}");
            assert!(msg.contains("original API error"), "got: {msg}");
            // Exit status must appear in the message — operators need it
            // to distinguish `exit 1` (mount denied) from `signal 9`
            // (OOM kill) from `exit 32` (mount target missing).
            assert!(msg.contains("status="), "should include exit status: {msg}");
        }
        other => panic!("expected Process error, got {other:?}"),
    }
}

/// Even when the stderr buffer is empty, the rewrapped message should
/// still be informative — falling back to the `<no stderr captured>`
/// sentinel rather than a bare `status=...:  (original ...)` string.
#[test]
fn rewrap_uses_sentinel_when_stderr_empty() {
    let err = rewrap_spawn_chain_exit(
        Err(SnapshotError::Api(ApiError::Other("timeout".into()))),
        Ok(Some(exit_status_nonzero())),
        &stderr_buf_with_lines(&[]),
    )
    .unwrap_err();
    match err {
        SnapshotError::Process(msg) => {
            assert!(
                msg.contains("no stderr"),
                "should fall back to sentinel when buffer is empty: {msg}"
            );
            assert!(msg.contains("status="), "got: {msg}");
        }
        other => panic!("expected Process error, got {other:?}"),
    }
}

/// `try_wait` itself returning `Err` (EINTR or similar) must not be
/// mistaken for "spawn chain exited" — stay conservative and keep the
/// original error instead of asserting something we couldn't observe.
#[test]
fn rewrap_preserves_api_error_when_try_wait_fails() {
    let err = rewrap_spawn_chain_exit(
        Err(SnapshotError::Api(ApiError::Other("timeout".into()))),
        Err(std::io::Error::from(std::io::ErrorKind::Interrupted)),
        &stderr_buf_with_lines(&["would-be-rewrapped"]),
    )
    .unwrap_err();
    assert!(matches!(err, SnapshotError::Api(_)), "got: {err:?}");
}

/// FC is still running (try_wait → None) → API error is genuine, keep it.
#[test]
fn rewrap_preserves_api_error_when_child_still_running() {
    let api_err = ApiError::Other("misconfigured".into());
    let err = rewrap_spawn_chain_exit(
        Err(SnapshotError::Api(api_err)),
        Ok(None),
        &stderr_buf_with_lines(&[]),
    )
    .unwrap_err();
    assert!(matches!(err, SnapshotError::Api(_)), "got: {err:?}");
}

/// FC exited with code 0 (rare but possible) → not a mount-style crash.
#[test]
fn rewrap_preserves_api_error_when_child_exited_zero() {
    let api_err = ApiError::Other("timeout".into());
    let err = rewrap_spawn_chain_exit(
        Err(SnapshotError::Api(api_err)),
        Ok(Some(exit_status_zero())),
        &stderr_buf_with_lines(&["noise"]),
    )
    .unwrap_err();
    assert!(matches!(err, SnapshotError::Api(_)), "got: {err:?}");
}

/// Non-API errors already carry their specific cause and should not
/// be replaced by a generic "spawn chain exited" message.
#[test]
fn rewrap_preserves_non_api_errors() {
    let err = rewrap_spawn_chain_exit(
        Err(SnapshotError::Setup("pre-warm failed".into())),
        Ok(Some(exit_status_nonzero())),
        &stderr_buf_with_lines(&["stderr junk"]),
    )
    .unwrap_err();
    match err {
        SnapshotError::Setup(msg) => assert_eq!(msg, "pre-warm failed"),
        other => panic!("expected Setup error, got {other:?}"),
    }
}

/// `Ok(_)` passes through untouched.
#[test]
fn rewrap_passes_ok_through() {
    let result = rewrap_spawn_chain_exit(
        Ok(placeholder_snapshot_config()),
        Ok(Some(exit_status_nonzero())),
        &stderr_buf_with_lines(&["noise"]),
    );
    assert!(result.is_ok(), "ok should pass through");
}
