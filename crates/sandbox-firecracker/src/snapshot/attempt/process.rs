use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::AsyncRead;
use tokio::task::JoinHandle;
use tracing::info;

use crate::config::SnapshotConfig;
use crate::firecracker_process::spawn_firecracker;
use crate::process::kill_process_group;
use crate::process_log::{
    PROCESS_LOG_RECORD_MAX_BYTES, PROCESS_LOG_RECORD_TRUNCATED, ProcessLogRecord,
    read_process_log_records,
};
use crate::snapshot_mount_namespace::{BindMount, SnapshotMountMode, build_command};

use super::super::SnapshotError;

/// Number of recent stderr lines retained from the spawn chain, used to
/// surface the underlying cause when the chain (`unshare → bash → ip netns
/// exec → firecracker`) exits before the API socket appears. 32 is enough
/// for a typical mount/unshare/netns error plus a few lines of bash/kernel
/// noise, far less than the memory cost warrants worrying about.
const STDERR_BUF_LINES: usize = 32;

/// Time granted to the stderr forwarder task to drain buffered lines after
/// the spawn chain has been observed to exit. Kept small: if the forwarder
/// hasn't caught up in 100ms after the pipe's write end closed, the buffer
/// we have is what the operator sees.
const STDERR_DRAIN_TIMEOUT: Duration = Duration::from_millis(100);

/// Cancellation finalizer child reap budget after SIGKILL. This is a fallback
/// path: keep it bounded so a cancelled snapshot cannot pin cleanup forever.
const SNAPSHOT_FINALIZER_CHILD_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

/// Short grace period for stdout/stderr log forwarders after child cleanup.
const SNAPSHOT_FINALIZER_PIPE_DRAIN_TIMEOUT: Duration = Duration::from_millis(100);

/// Shared bounded ring buffer of recent stderr lines from the spawn chain.
type StderrBuf = Arc<Mutex<VecDeque<String>>>;

pub(super) struct SnapshotProcessSpawn<'a> {
    pub(super) cow_device_path: &'a Path,
    pub(super) drive_bind: &'a Path,
    pub(super) home_image: &'a Path,
    pub(super) home_drive_bind: &'a Path,
    pub(super) network_name: &'a str,
    pub(super) binary_path: &'a Path,
    pub(super) api_sock: &'a Path,
    pub(super) current_dir: &'a Path,
}

pub(super) struct SnapshotProcessPresence {
    pub(super) has_child: bool,
    pub(super) has_stdout_forwarder: bool,
    pub(super) has_stderr_forwarder: bool,
}

pub(super) struct SnapshotProcessCleanupReport {
    pub(super) child_reaped: bool,
    pub(super) stdout_forwarder_finished: bool,
    pub(super) stderr_forwarder_finished: bool,
}

pub(super) struct SnapshotProcess {
    child: Option<process_launch::asynchronous::Child>,
    stdout_handle: Option<JoinHandle<()>>,
    stderr_handle: Option<JoinHandle<()>>,
    stderr_buf: StderrBuf,
}

impl Default for SnapshotProcess {
    fn default() -> Self {
        Self {
            child: None,
            stdout_handle: None,
            stderr_handle: None,
            stderr_buf: Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES))),
        }
    }
}

impl SnapshotProcess {
    pub(super) async fn spawn(&mut self, spawn: SnapshotProcessSpawn<'_>) -> std::io::Result<()> {
        let command = build_command(
            SnapshotMountMode::Creation {
                rootfs: BindMount::new(spawn.cow_device_path, spawn.drive_bind),
                home: BindMount::new(spawn.home_image, spawn.home_drive_bind),
            },
            spawn.network_name,
            spawn.binary_path,
            spawn.api_sock,
        );
        let mut child = spawn_firecracker(command, spawn.current_dir, None).await?;

        // Stream stdout/stderr lines to tracing (same pattern as sandbox.rs).
        // Stderr is also retained in a bounded ring buffer so that an early
        // spawn-chain exit (mount failure inside unshare bash, etc.) can be
        // reported with its real cause instead of just an API timeout.
        self.stdout_handle = spawn_stdout_forwarder(&mut child);
        // The stderr forwarder handle is retained so that, on detected early
        // exit, we can wait a bounded time for it to drain buffered lines
        // before snapshotting the ring buffer for the error message. Without
        // this join, the most informative lines (mount: bind failed, etc.)
        // can race the `try_wait` observation and be missed.
        self.stderr_handle = spawn_stderr_forwarder(&mut child, &self.stderr_buf);
        self.child = Some(child);

        Ok(())
    }

    pub(super) fn presence(&self) -> SnapshotProcessPresence {
        SnapshotProcessPresence {
            has_child: self.child.is_some(),
            has_stdout_forwarder: self.stdout_handle.is_some(),
            has_stderr_forwarder: self.stderr_handle.is_some(),
        }
    }

    pub(super) async fn finish_after_workflow(
        &mut self,
        result: Result<SnapshotConfig, SnapshotError>,
    ) -> Result<SnapshotConfig, SnapshotError> {
        // Probe for early spawn-chain exit *before* killing the process. This
        // distinguishes "firecracker is still running, error was an API/setup
        // issue" (try_wait → None) from "firecracker already died, error is
        // the downstream symptom of that" (try_wait → Some(non-zero)).
        let child_status = self
            .child
            .as_mut()
            .map_or(Ok(None), process_launch::asynchronous::Child::try_wait);
        drain_stderr_forwarder_after_spawn_exit(&child_status, &mut self.stderr_handle).await;
        let result = rewrap_spawn_chain_exit(result, child_status, &self.stderr_buf);

        // Kill Firecracker first — it holds the NBD device fd open.
        if let Some(child) = self.child.as_mut() {
            kill_and_reap_firecracker(child).await;
        }
        self.child.take();

        result
    }

    pub(super) fn drop_forwarder_handles(&mut self) {
        self.stdout_handle.take();
        self.stderr_handle.take();
    }

    pub(super) fn signal_for_drop(&self) {
        if let Some(child) = self.child.as_ref() {
            let _ = kill_process_group(child.id());
        }
    }

    pub(super) async fn finalize_after_cancellation(&mut self) -> SnapshotProcessCleanupReport {
        let child_reaped = if let Some(child) = self.child.as_mut() {
            kill_and_reap_firecracker_bounded(child, SNAPSHOT_FINALIZER_CHILD_WAIT_TIMEOUT).await
        } else {
            true
        };
        self.child.take();

        let stdout_forwarder_finished = drain_or_abort_forwarder(
            &mut self.stdout_handle,
            "stdout",
            SNAPSHOT_FINALIZER_PIPE_DRAIN_TIMEOUT,
        )
        .await;
        let stderr_forwarder_finished = drain_or_abort_forwarder(
            &mut self.stderr_handle,
            "stderr",
            SNAPSHOT_FINALIZER_PIPE_DRAIN_TIMEOUT,
        )
        .await;

        SnapshotProcessCleanupReport {
            child_reaped,
            stdout_forwarder_finished,
            stderr_forwarder_finished,
        }
    }

    #[cfg(test)]
    pub(super) fn track_child_for_test(&mut self, child: tokio::process::Child) {
        self.child = Some(child.into());
    }

    #[cfg(test)]
    pub(super) fn track_stdout_handle_for_test(&mut self, handle: JoinHandle<()>) {
        self.stdout_handle = Some(handle);
    }

    #[cfg(test)]
    pub(super) fn track_stderr_handle_for_test(&mut self, handle: JoinHandle<()>) {
        self.stderr_handle = Some(handle);
    }
}

fn spawn_stdout_forwarder(
    child: &mut process_launch::asynchronous::Child,
) -> Option<JoinHandle<()>> {
    child.stdout.take().map(|stdout| {
        // Intentionally detached: stdout has no cleanup decision input, and
        // EOF on the child pipe ends the task after Firecracker exits.
        tokio::spawn(forward_stdout(stdout))
    })
}

fn spawn_stderr_forwarder(
    child: &mut process_launch::asynchronous::Child,
    stderr_buf: &StderrBuf,
) -> Option<JoinHandle<()>> {
    child.stderr.take().map(|stderr| {
        let buf = Arc::clone(stderr_buf);
        // The caller retains this handle only for the early-exit drain path.
        // Otherwise EOF on the child pipe ends the task after Firecracker exits.
        tokio::spawn(async move { forward_stderr(stderr, &buf).await })
    })
}

async fn forward_stdout<R>(reader: R)
where
    R: AsyncRead + Unpin,
{
    let _ = read_process_log_records(reader, |record| match record {
        ProcessLogRecord::Line(line) => info!(target: "firecracker", "{line}"),
        ProcessLogRecord::Truncated => tracing::warn!(
            target: "firecracker",
            stream = "stdout",
            limit_bytes = PROCESS_LOG_RECORD_MAX_BYTES,
            PROCESS_LOG_RECORD_TRUNCATED
        ),
    })
    .await;
}

async fn forward_stderr<R>(reader: R, stderr_buf: &StderrBuf)
where
    R: AsyncRead + Unpin,
{
    let _ = read_process_log_records(reader, |record| {
        let line = match record {
            ProcessLogRecord::Line(line) => {
                tracing::warn!(target: "firecracker", "stderr: {line}");
                line.to_owned()
            }
            ProcessLogRecord::Truncated => {
                tracing::warn!(
                    target: "firecracker",
                    stream = "stderr",
                    limit_bytes = PROCESS_LOG_RECORD_MAX_BYTES,
                    PROCESS_LOG_RECORD_TRUNCATED
                );
                PROCESS_LOG_RECORD_TRUNCATED.to_string()
            }
        };

        if let Ok(mut buffer) = stderr_buf.lock() {
            if buffer.len() == STDERR_BUF_LINES {
                buffer.pop_front();
            }
            buffer.push_back(line);
        }
    })
    .await;
}

async fn drain_stderr_forwarder_after_spawn_exit(
    child_status: &std::io::Result<Option<std::process::ExitStatus>>,
    stderr_handle: &mut Option<JoinHandle<()>>,
) {
    if matches!(child_status, Ok(Some(status)) if !status.success())
        && let Some(handle) = stderr_handle.as_mut()
    {
        // Child's write end of stderr is closed; wait briefly for the
        // forwarder to finish reading so the captured buffer contains
        // the crash's final lines.
        let _ = tokio::time::timeout(STDERR_DRAIN_TIMEOUT, handle).await;
        stderr_handle.take();
    }
}

async fn kill_and_reap_firecracker(child: &mut process_launch::asynchronous::Child) {
    let _ = kill_process_group(child.id());
    let _ = child.wait().await;
}

async fn kill_and_reap_firecracker_bounded(
    child: &mut process_launch::asynchronous::Child,
    timeout: Duration,
) -> bool {
    let _ = kill_process_group(child.id());
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(_)) => true,
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "failed to wait for snapshot firecracker child during cleanup");
            false
        }
        Err(_) => {
            tracing::warn!(
                timeout_ms = timeout.as_millis() as u64,
                "timed out waiting for snapshot firecracker child during cleanup"
            );
            false
        }
    }
}

async fn drain_or_abort_forwarder(
    handle: &mut Option<JoinHandle<()>>,
    pipe: &'static str,
    timeout: Duration,
) -> bool {
    let Some(join_handle) = handle.as_mut() else {
        return true;
    };

    let join_result = tokio::select! {
        result = &mut *join_handle => Some(result),
        () = tokio::time::sleep(timeout) => None,
    };

    match join_result {
        Some(result) => {
            handle.take();
            match result {
                Ok(()) => true,
                Err(e) if e.is_cancelled() => true,
                Err(e) => {
                    tracing::warn!(pipe, error = %e, "snapshot pipe forwarder failed during cleanup");
                    false
                }
            }
        }
        None => {
            join_handle.abort();
            let result = join_handle.await;
            handle.take();
            if let Err(e) = result
                && !e.is_cancelled()
            {
                tracing::warn!(pipe, error = %e, "snapshot pipe forwarder failed after abort");
                return false;
            }
            true
        }
    }
}

/// Drain the captured stderr lines into a single newline-joined string.
/// Used in error reporting when the spawn chain exits prematurely; always
/// returns a non-empty string so the operator never sees a bare error.
fn drain_stderr_buf(buf: &StderrBuf) -> String {
    match buf.lock() {
        Ok(g) => {
            if g.is_empty() {
                "<no stderr captured>".to_string()
            } else {
                g.iter().cloned().collect::<Vec<_>>().join("\n")
            }
        }
        Err(_) => {
            // Poisoning means the stderr forwarder task panicked while
            // holding the lock — a real bug signal worth surfacing
            // independently of the error message that carries this sentinel.
            tracing::warn!("stderr buffer mutex poisoned during forwarder task");
            "<stderr buffer poisoned>".to_string()
        }
    }
}

/// If the snapshot workflow returned an API error AND the firecracker
/// spawn chain (unshare → bash → ip netns exec → firecracker) has
/// already exited with a non-zero status, re-wrap the error with the
/// captured stderr so the operator sees the underlying cause (e.g.
/// `mount: bind failed`) instead of a generic API timeout.
///
/// In every other case the original result is returned unchanged:
/// - `Ok(_)`: success — no rewrap.
/// - `Err(non-Api)`: the error is already specific (Setup / Vsock / Io /
///   Process) and shouldn't be replaced.
/// - `Ok(None)` child status: firecracker is still running, so the API
///   error is about API behavior, not a crashed spawn chain.
/// - `Ok(Some(success))` child status: firecracker exited cleanly (rare
///   at this point), not a mount/setup failure.
/// - `Err(_)` child status: `try_wait` failed for an unrelated reason
///   (EINTR, etc.); stay conservative and keep the original error.
fn rewrap_spawn_chain_exit(
    result: Result<SnapshotConfig, SnapshotError>,
    child_status: std::io::Result<Option<std::process::ExitStatus>>,
    stderr_buf: &StderrBuf,
) -> Result<SnapshotConfig, SnapshotError> {
    match (result, child_status) {
        (Err(SnapshotError::Api(api_err)), Ok(Some(status))) if !status.success() => {
            let stderr = drain_stderr_buf(stderr_buf);
            Err(SnapshotError::Process(format!(
                "firecracker spawn chain exited (status={status}): {stderr} \
                 (original API error: {api_err})"
            )))
        }
        (other, _) => other,
    }
}

#[cfg(test)]
mod tests {
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

        drain_stderr_forwarder_after_spawn_exit(&Ok(Some(exit_status_nonzero())), &mut handle)
            .await;

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
}
