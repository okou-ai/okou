use super::*;

#[test]
fn format_command_display_simple() {
    let display = format_command_display("mkfs.ext4", &["-F", "-q", "/tmp/x"]);
    assert_eq!(display, "mkfs.ext4 -F -q /tmp/x");
}

#[tokio::test]
async fn exec_with_timeout_returns_trimmed_stdout() {
    let output = exec_with_timeout("echo", &["hello"], Duration::from_secs(1))
        .await
        .unwrap();
    assert_eq!(output, "hello");
}

#[tokio::test]
async fn exec_with_timeout_captures_multiline_output() {
    let output = exec_with_timeout("printf", &["a\\nb\\nc"], Duration::from_secs(1))
        .await
        .unwrap();
    assert_eq!(output, "a\nb\nc");
}

#[tokio::test]
async fn exec_with_timeout_returns_error_on_failure() {
    let err = exec_with_timeout("false", &[], Duration::from_secs(1))
        .await
        .unwrap_err();
    assert!(
        err.command.contains("false"),
        "command was: {}",
        err.command
    );
    assert_eq!(err.exit_code, Some(1));
}

#[tokio::test]
async fn exec_with_timeout_error_contains_stderr() {
    let err = exec_with_timeout(
        "bash",
        &["-c", "echo oops >&2; exit 1"],
        Duration::from_secs(1),
    )
    .await
    .unwrap_err();
    assert!(err.detail.contains("oops"), "detail was: {}", err.detail);
}

#[tokio::test]
async fn exec_with_timeout_passes_multiple_args() {
    let output = exec_with_timeout("printf", &["%s-%s", "a", "b"], Duration::from_secs(1))
        .await
        .unwrap();
    assert_eq!(output, "a-b");
}

#[tokio::test]
async fn exec_ignore_errors_with_timeout_reports_nonzero() {
    let outcome = exec_ignore_errors_with_timeout("false", &[], Duration::from_secs(1)).await;
    assert_eq!(outcome, IgnoredCommandOutcome::NonZero);
}

#[tokio::test]
async fn exec_ignore_errors_with_timeout_reports_success() {
    let outcome = exec_ignore_errors_with_timeout("true", &[], Duration::from_secs(1)).await;
    assert_eq!(outcome, IgnoredCommandOutcome::Success);
}

#[tokio::test]
async fn exec_with_timeout_returns_timeout() {
    let err = exec_with_timeout("sh", &["-c", "sleep 2"], Duration::from_millis(50))
        .await
        .unwrap_err();

    assert!(
        err.detail.contains("timed out"),
        "detail was: {}",
        err.detail
    );
}

#[tokio::test]
async fn exec_ignore_errors_with_timeout_reports_timeout() {
    let outcome =
        exec_ignore_errors_with_timeout("sh", &["-c", "sleep 2"], Duration::from_millis(50)).await;

    assert_eq!(outcome, IgnoredCommandOutcome::Timeout);
}

#[tokio::test]
async fn exec_ignore_errors_with_timeout_reports_not_found() {
    let outcome = exec_ignore_errors_with_timeout(
        "vm0-definitely-missing-command-for-timeout-test",
        &[],
        Duration::from_millis(50),
    )
    .await;

    assert_eq!(outcome, IgnoredCommandOutcome::NotFound);
}

#[tokio::test]
async fn semantic_stdout_over_limit_returns_output_too_large() {
    let result = command_output_with_policy_and_exit_notifier(
        "sh",
        &["-c", "printf abcdef"],
        Duration::from_secs(1),
        CommandOutputPolicy {
            stdout: StreamOutputPolicy::SemanticCapture { max_bytes: 3 },
            stderr: StreamOutputPolicy::DiagnosticCapture { max_bytes: 16 },
        },
        |child| ChildExitNotifier::open(child.id()),
    )
    .await;

    match result {
        Err(CommandRunError::OutputTooLarge { pipe, limit }) => {
            assert_eq!(pipe, "stdout");
            assert_eq!(limit, 3);
        }
        other => panic!("unexpected result: {other:?}"),
    }
}

#[tokio::test]
async fn diagnostic_stderr_over_limit_truncates_without_failing_success() {
    let output = command_output_with_policy_and_exit_notifier(
        "sh",
        &["-c", "printf abcdef >&2"],
        Duration::from_secs(1),
        CommandOutputPolicy {
            stdout: StreamOutputPolicy::Discard,
            stderr: StreamOutputPolicy::DiagnosticCapture { max_bytes: 3 },
        },
        |child| ChildExitNotifier::open(child.id()),
    )
    .await
    .unwrap();

    assert!(output.status.success());
    assert!(output.stdout.bytes.is_empty());
    assert!(!output.stdout.truncated);
    assert_eq!(output.stderr.bytes, b"abc");
    assert!(output.stderr.truncated);
    assert_eq!(
        output.stderr.to_lossy_trimmed_string(),
        "abc\n[output truncated]"
    );
}

#[tokio::test]
async fn exec_status_with_timeout_reports_failure_stderr() {
    let err = exec_status_with_timeout(
        "sh",
        &["-c", "printf ignored; printf status-failed >&2; exit 7"],
        Duration::from_secs(1),
    )
    .await
    .unwrap_err();

    assert!(err.detail.contains("status-failed"), "err was: {err}");
    assert_eq!(err.exit_code, Some(7));
}

#[tokio::test]
async fn exec_status_os_with_timeout_preserves_non_utf8_argument() {
    use std::os::unix::ffi::OsStringExt;

    let dir = tempfile::tempdir().unwrap();
    let path = dir
        .path()
        .join(std::ffi::OsString::from_vec(b"native-\xff".to_vec()));
    std::fs::write(&path, b"present").unwrap();
    let args = [OsStr::new("-e"), path.as_os_str()];

    exec_status_os_with_timeout(OsStr::new("test"), &args, Duration::from_secs(1))
        .await
        .unwrap();
}

#[tokio::test]
async fn exec_status_os_with_timeout_bounds_failure_stderr() {
    let script = format!(
        "head -c {} /dev/zero | tr '\\0' x >&2; exit 9",
        DEFAULT_DIAGNOSTIC_OUTPUT_LIMIT_BYTES + 1
    );
    let args = [OsStr::new("-c"), OsStr::new(&script)];

    let err = exec_status_os_with_timeout(OsStr::new("sh"), &args, Duration::from_secs(1))
        .await
        .unwrap_err();

    assert_eq!(err.exit_code, Some(9));
    assert_eq!(
        err.detail.len(),
        DEFAULT_DIAGNOSTIC_OUTPUT_LIMIT_BYTES + "\n[output truncated]".len()
    );
    assert!(err.detail.ends_with("\n[output truncated]"));
}

#[test]
fn output_too_large_ignored_outcome_is_not_trusted() {
    assert!(!IgnoredCommandOutcome::OutputTooLarge.completed_without_timeout());
}

#[tokio::test]
#[cfg(target_os = "linux")]
async fn cleanup_wait_timeout_transfers_child_and_finishes_pipe_tasks() {
    let mut command = Command::new("sleep");
    command
        .arg("60")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .process_group(0);
    let mut child = CommandChild::new(command.spawn().unwrap());
    let pid = child.child.as_ref().and_then(Child::id).unwrap();
    let starttime = process_starttime(pid).expect("spawned child process was not observable");
    let stdout_task = child
        .spawn_pipe_task(
            PipeKind::Stdout,
            StreamOutputPolicy::DiagnosticCapture { max_bytes: 16 },
        )
        .unwrap();
    let stderr_task = child
        .spawn_pipe_task(
            PipeKind::Stderr,
            StreamOutputPolicy::DiagnosticCapture { max_bytes: 16 },
        )
        .unwrap();
    let mut pipe_tasks = PipeTasks::new(stdout_task, stderr_task);

    let error = tokio::time::timeout(
        Duration::from_secs(1),
        cleanup_command_failure_with_wait_gate(
            &mut child,
            &mut pipe_tasks,
            CommandRunError::Timeout(50),
            Duration::from_millis(25),
            std::future::pending(),
        ),
    )
    .await
    .expect("foreground cleanup exceeded its outer test bound");

    match error {
        CommandRunError::Lifecycle(detail) => {
            assert!(
                detail.contains("timed out after 50ms"),
                "detail was: {detail}"
            );
            assert!(
                detail.contains("killed child did not exit within 25ms"),
                "detail was: {detail}"
            );
        }
        other => panic!("unexpected cleanup result: {other:?}"),
    }
    assert!(child.child.is_none(), "child ownership was not transferred");
    assert!(pipe_tasks.stdout.is_none());
    assert!(pipe_tasks.stderr.is_none());
    assert_pid_reaped(pid, starttime).await;
}

#[tokio::test]
async fn exec_with_timeout_kills_child_process_group() {
    assert_timeout_kills_grandchild("(sleep 5; touch \"$2\") & echo $! > \"$1\"; wait").await;
}

#[tokio::test]
async fn exec_with_timeout_bounds_pipe_drain_after_parent_exits() {
    if !pidfd_available_or_skip("pipe-drain process-group cleanup") {
        return;
    }
    assert_timeout_kills_grandchild("(sleep 5; touch \"$2\") & echo $! > \"$1\"").await;
}

#[tokio::test]
async fn exec_with_timeout_aborts_only_remaining_pipe_reader() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pid");
    let marker = dir.path().join("marker");
    let pid_file = pid_file.to_str().unwrap();
    let marker = marker.to_str().unwrap();

    let result = tokio::time::timeout(
        Duration::from_secs(3),
        exec_with_timeout(
            "sh",
            &[
                "-c",
                "printf ready; (exec 1>&-; sleep 30; touch \"$2\") & echo $! > \"$1\"",
                "_",
                pid_file,
                marker,
            ],
            Duration::from_millis(250),
        ),
    )
    .await;

    // Check cleanup even when the watchdog cancels a regressed command.
    let pid = read_pid_file(pid_file).await;
    assert_pid_not_running(pid).await;
    assert!(!std::path::Path::new(marker).exists());
    let error = result
        .expect("capture command exceeded its outer test bound")
        .unwrap_err();
    assert_eq!(error.detail, "timed out after 250ms");
    assert_eq!(error.exit_code, None);
}

#[tokio::test]
async fn exec_ignore_errors_with_timeout_bounds_stderr_drain_after_parent_exits() {
    if !pidfd_available_or_skip("single-pipe process-group cleanup") {
        return;
    }
    assert_timeout_kills_grandchild("(exec 1>&-; sleep 5; touch \"$2\") & echo $! > \"$1\"").await;
}

#[tokio::test]
#[cfg(unix)]
async fn exec_with_timeout_pidfd_unavailable_pipe_drain_kills_before_parent_reap() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pid");
    let marker = dir.path().join("marker");
    let pid_file = pid_file.to_str().unwrap();
    let marker = marker.to_str().unwrap();

    let result = command_output_with_timeout_with_exit_notifier(
        "sh",
        &[
            "-c",
            "(sleep 5; touch \"$2\") & echo $! > \"$1\"",
            "_",
            pid_file,
            marker,
        ],
        Duration::from_millis(250),
        |_| ChildExitNotifier::unavailable_for_test(),
    )
    .await;

    assert!(
        matches!(result, Err(CommandRunError::Timeout(_))),
        "result was: {result:?}"
    );
    let pid = read_pid_file(pid_file).await;
    assert_pid_not_running(pid).await;
    assert!(!std::path::Path::new(marker).exists());
}

#[tokio::test]
#[cfg(unix)]
async fn exec_with_timeout_pidfd_unavailable_closed_pipes_still_bounds_child_wait() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pid");
    let marker = dir.path().join("marker");
    let pid_file = pid_file.to_str().unwrap();
    let marker = marker.to_str().unwrap();

    let result = command_output_with_timeout_with_exit_notifier(
        "sh",
        &[
            "-c",
            "echo $$ > \"$1\"; exec 1>&- 2>&-; sleep 5; touch \"$2\"",
            "_",
            pid_file,
            marker,
        ],
        Duration::from_millis(250),
        |_| ChildExitNotifier::unavailable_for_test(),
    )
    .await;

    assert!(
        matches!(result, Err(CommandRunError::Timeout(_))),
        "result was: {result:?}"
    );
    let pid = read_pid_file(pid_file).await;
    assert_pid_not_running(pid).await;
    assert!(!std::path::Path::new(marker).exists());
}

async fn assert_timeout_kills_grandchild(script: &str) {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pid");
    let marker = dir.path().join("marker");
    let pid_file = pid_file.to_str().unwrap();
    let marker = marker.to_str().unwrap();

    let outcome = exec_ignore_errors_with_timeout(
        "sh",
        &["-c", script, "_", pid_file, marker],
        Duration::from_millis(250),
    )
    .await;

    assert_eq!(outcome, IgnoredCommandOutcome::Timeout);
    let pid = read_pid_file(pid_file).await;
    assert_pid_not_running(pid).await;
    assert!(!std::path::Path::new(marker).exists());
}

#[tokio::test]
async fn exec_with_timeout_cancel_kills_child_process_group() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pid");
    let marker = dir.path().join("marker");
    let pid_file = pid_file.to_str().unwrap().to_string();
    let marker = marker.to_str().unwrap().to_string();

    let command = tokio::spawn({
        let pid_file = pid_file.clone();
        let marker = marker.clone();
        async move {
            exec_ignore_errors_with_timeout(
                "sh",
                &[
                    "-c",
                    "(sleep 5; touch \"$2\") & echo $! > \"$1\"; wait",
                    "_",
                    &pid_file,
                    &marker,
                ],
                Duration::from_secs(10),
            )
            .await
        }
    });

    let pid = read_pid_file(&pid_file).await;
    command.abort();
    let _ = command.await;

    assert_pid_not_running(pid).await;
    assert!(!std::path::Path::new(&marker).exists());
}

#[tokio::test]
async fn collect_with_deadline_cancel_aborts_pending_pipe_readers() {
    let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
    let (dropped_tx, mut dropped_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut pipe_tasks = PipeTasks::new(
        Some(pending_pipe_task(
            "stdout",
            started_tx.clone(),
            dropped_tx.clone(),
        )),
        Some(pending_pipe_task("stderr", started_tx, dropped_tx)),
    );

    let mut started = [
        recv_pipe_start(&mut started_rx).await,
        recv_pipe_start(&mut started_rx).await,
    ];
    started.sort_unstable();
    assert_eq!(started, ["stderr", "stdout"]);

    {
        let collect = pipe_tasks.collect_with_deadline(
            tokio::time::Instant::now() + Duration::from_secs(30),
            Duration::from_secs(30),
        );
        tokio::pin!(collect);
        tokio::select! {
            biased;
            result = &mut collect => panic!("pipe collection completed unexpectedly: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }
    }
    drop(pipe_tasks);

    let mut dropped = [
        recv_pipe_drop(&mut dropped_rx).await,
        recv_pipe_drop(&mut dropped_rx).await,
    ];
    dropped.sort_unstable();
    assert_eq!(dropped, ["stderr", "stdout"]);
}

#[tokio::test]
async fn collect_with_deadline_aborts_only_remaining_pipe_reader() {
    // The public timeout error cannot expose whether stdout was consumed.
    // Synchronize task lifetimes here alongside the real-command coverage.
    let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
    let (dropped_tx, mut dropped_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut pipe_tasks = PipeTasks::new(
        Some(tokio::spawn(async {
            Ok(PipeReadOutput {
                output: CapturedPipeOutput {
                    bytes: b"ready".to_vec(),
                    truncated: false,
                },
                overflow: None,
            })
        })),
        Some(pending_pipe_task("stderr", started_tx, dropped_tx)),
    );

    assert_eq!(recv_pipe_start(&mut started_rx).await, "stderr");
    tokio::time::timeout(Duration::from_secs(1), async {
        while !pipe_tasks.stdout.as_ref().unwrap().is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("stdout reader did not complete");
    assert!(!pipe_tasks.stderr.as_ref().unwrap().is_finished());

    // Model a command that used its budget before pipe collection. A ready
    // stdout must still be collected, without granting stderr a new budget.
    let timeout = Duration::from_secs(60);
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        pipe_tasks.collect_with_deadline(tokio::time::Instant::now(), timeout),
    )
    .await
    .expect("remaining stderr reader exceeded the original deadline");

    assert!(
        matches!(result, Err(CommandRunError::Timeout(60_000))),
        "result was: {result:?}"
    );
    assert!(pipe_tasks.stdout.is_none(), "stdout was not collected");
    assert!(pipe_tasks.stderr.is_some(), "stderr ownership was lost");

    tokio::time::timeout(Duration::from_secs(1), pipe_tasks.abort_all())
        .await
        .expect("remaining pipe cleanup did not finish");
    assert!(pipe_tasks.stdout.is_none());
    assert!(pipe_tasks.stderr.is_none());
    assert_eq!(recv_pipe_drop(&mut dropped_rx).await, "stderr");
}

struct PipeDropNotify {
    name: &'static str,
    dropped: tokio::sync::mpsc::UnboundedSender<&'static str>,
}

impl Drop for PipeDropNotify {
    fn drop(&mut self) {
        let _ = self.dropped.send(self.name);
    }
}

fn pending_pipe_task(
    name: &'static str,
    started: tokio::sync::mpsc::UnboundedSender<&'static str>,
    dropped: tokio::sync::mpsc::UnboundedSender<&'static str>,
) -> PipeReadTask {
    tokio::spawn(async move {
        let _notify = PipeDropNotify { name, dropped };
        let _ = started.send(name);
        std::future::pending::<std::io::Result<PipeReadOutput>>().await
    })
}

async fn recv_pipe_start(
    started: &mut tokio::sync::mpsc::UnboundedReceiver<&'static str>,
) -> &'static str {
    tokio::time::timeout(Duration::from_secs(1), started.recv())
        .await
        .expect("pipe task did not start")
        .expect("pipe task start channel closed")
}

async fn recv_pipe_drop(
    dropped: &mut tokio::sync::mpsc::UnboundedReceiver<&'static str>,
) -> &'static str {
    tokio::time::timeout(Duration::from_secs(1), dropped.recv())
        .await
        .expect("pipe reader was not aborted")
        .expect("pipe reader drop channel closed")
}

async fn read_pid_file(path: &str) -> u32 {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    loop {
        match std::fs::read_to_string(path) {
            Ok(pid) => match pid.trim().parse() {
                Ok(pid) => return pid,
                Err(_) if pid.trim().is_empty() => {}
                Err(e) => panic!("pid file {path} contains invalid pid: {e}"),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => panic!("read pid file {path}: {e}"),
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "pid file was not written: {path}"
        );
        tokio::task::yield_now().await;
    }
}

async fn assert_pid_not_running(pid: u32) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while process_is_running(pid) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "process {pid} was still running after command timeout"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[cfg(target_os = "linux")]
fn process_is_running(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    let Some((_, after_comm)) = stat.rsplit_once(") ") else {
        return false;
    };
    !after_comm.starts_with('Z')
}

#[cfg(target_os = "linux")]
fn process_starttime(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (_, after_comm) = stat.rsplit_once(") ")?;
    after_comm.split_whitespace().nth(19)?.parse().ok()
}

#[cfg(target_os = "linux")]
async fn assert_pid_reaped(pid: u32, starttime: u64) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while process_starttime(pid) == Some(starttime) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("process {pid} was not reaped after ownership handoff"));
}

#[cfg(all(unix, not(target_os = "linux")))]
fn process_is_running(pid: u32) -> bool {
    let pid = nix::unistd::Pid::from_raw(i32::try_from(pid).expect("pid fits in i32"));
    match nix::sys::signal::kill(pid, None) {
        Ok(()) => true,
        Err(nix::errno::Errno::ESRCH) => false,
        Err(_) => true,
    }
}

#[cfg(not(unix))]
fn process_is_running(_pid: u32) -> bool {
    false
}

fn pidfd_available_or_skip(test_name: &str) -> bool {
    if ChildExitNotifier::available_for_current_process_for_test() {
        true
    } else {
        eprintln!("skipping pidfd-dependent {test_name} test");
        false
    }
}
