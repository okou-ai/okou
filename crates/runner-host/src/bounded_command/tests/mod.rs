use super::*;

#[cfg(target_os = "linux")]
use crate::process::read_process_stat;
#[cfg(target_os = "linux")]
use std::path::Path;

#[cfg(target_os = "linux")]
const PROCESS_OBSERVATION_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg(target_os = "linux")]
fn pid_recording_command(pid_path: &Path) -> Command {
    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg("printf '%s' \"$$\" > \"$1.tmp\"; mv \"$1.tmp\" \"$1\"; exec sleep 60")
        .arg("sh")
        .arg(pid_path);
    command
}

#[cfg(target_os = "linux")]
async fn wait_for_recorded_process(pid_path: &Path) -> io::Result<(u32, u64)> {
    let deadline = std::time::Instant::now() + PROCESS_OBSERVATION_TIMEOUT;
    loop {
        match tokio::fs::read_to_string(pid_path).await {
            Ok(raw_pid) => {
                let pid = raw_pid.trim().parse::<u32>().map_err(io::Error::other)?;
                if let Some(stat) = read_process_stat(pid).await {
                    return Ok((pid, stat.starttime));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        if std::time::Instant::now() >= deadline {
            return Err(io::Error::other(format!(
                "timed out waiting for command pid in {}",
                pid_path.display()
            )));
        }
        tokio::task::yield_now().await;
    }
}

#[cfg(target_os = "linux")]
async fn wait_for_process_exit(pid: u32, starttime: u64) -> io::Result<()> {
    let deadline = std::time::Instant::now() + PROCESS_OBSERVATION_TIMEOUT;
    while matches!(read_process_stat(pid).await, Some(stat) if stat.starttime == starttime) {
        if std::time::Instant::now() >= deadline {
            return Err(io::Error::other(format!(
                "timed out waiting for process {pid} to be reaped"
            )));
        }
        tokio::task::yield_now().await;
    }
    Ok(())
}

#[tokio::test]
async fn status_command_times_out_after_reaping_child() {
    let mut command = Command::new("sleep");
    command.arg("60");

    let outcome = run_bounded(command, "sleep", Duration::from_millis(1))
        .await
        .unwrap();

    assert!(matches!(outcome, BoundedCommandOutcome::TimedOut));
}

#[cfg(target_os = "linux")]
#[tokio::test(start_paused = true)]
async fn status_command_timeout_reaps_recorded_child() -> io::Result<()> {
    let temp_dir = tempfile::tempdir()?;
    let pid_path = temp_dir.path().join("pid");
    let command = pid_recording_command(&pid_path);
    let command_timeout = Duration::from_secs(1);
    let mut command_future = Box::pin(run_bounded(command, "sh", command_timeout));
    // Observe the real child before advancing the paused command deadline.
    assert!(futures_util::poll!(command_future.as_mut()).is_pending());
    let process = wait_for_recorded_process(&pid_path).await;

    tokio::time::advance(command_timeout).await;
    // Physical kill/reap needs real OS scheduling under its cleanup bound.
    tokio::time::resume();
    let task = tokio::spawn(command_future);
    let (pid, starttime) = match process {
        Ok(process) => process,
        Err(error) => {
            task.abort();
            let _ = task.await;
            return Err(error);
        }
    };

    let outcome = task.await.unwrap().unwrap();

    assert!(matches!(outcome, BoundedCommandOutcome::TimedOut));
    assert!(
        read_process_stat(pid)
            .await
            .is_none_or(|stat| stat.starttime != starttime),
        "timed-out status command must be physically reaped before returning"
    );
    Ok(())
}

#[tokio::test]
async fn output_command_times_out_after_reaping_child() {
    let mut command = Command::new("sleep");
    command.arg("60");

    let outcome = run_output_bounded(
        command,
        "sleep",
        CommandOutputPolicy::semantic_stdout(),
        Duration::from_millis(1),
    )
    .await
    .unwrap();

    assert!(matches!(outcome, BoundedCommandOutcome::TimedOut));
}

#[cfg(target_os = "linux")]
#[tokio::test(start_paused = true)]
async fn output_command_timeout_reaps_recorded_child() -> io::Result<()> {
    let temp_dir = tempfile::tempdir()?;
    let pid_path = temp_dir.path().join("pid");
    let command = pid_recording_command(&pid_path);
    let command_timeout = Duration::from_secs(1);
    let mut command_future = Box::pin(run_output_bounded(
        command,
        "sh",
        CommandOutputPolicy::semantic_stdout(),
        command_timeout,
    ));
    // Start the real child and deadline, but do not schedule this future
    // until its identity is recorded. Paused time alone can auto-advance
    // while the observer awaits filesystem I/O.
    assert!(futures_util::poll!(command_future.as_mut()).is_pending());
    let process = wait_for_recorded_process(&pid_path).await;

    tokio::time::advance(command_timeout).await;
    // Kill/reap uses real OS scheduling: resume time before cleanup so its
    // watchdog cannot auto-advance ahead of the child's exit.
    tokio::time::resume();
    let task = tokio::spawn(command_future);
    let (pid, starttime) = match process {
        Ok(process) => process,
        Err(error) => {
            task.abort();
            let _ = task.await;
            return Err(error);
        }
    };

    let outcome = task.await.unwrap().unwrap();

    assert!(matches!(outcome, BoundedCommandOutcome::TimedOut));
    wait_for_process_exit(pid, starttime).await
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn output_command_cancellation_reaps_recorded_child() -> io::Result<()> {
    let temp_dir = tempfile::tempdir()?;
    let pid_path = temp_dir.path().join("pid");
    let command = pid_recording_command(&pid_path);
    let task = tokio::spawn(run_output_bounded(
        command,
        "sh",
        CommandOutputPolicy::semantic_stdout(),
        Duration::from_secs(60),
    ));
    let (pid, starttime) = match wait_for_recorded_process(&pid_path).await {
        Ok(process) => process,
        Err(error) => {
            task.abort();
            let _ = task.await;
            return Err(error);
        }
    };

    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    wait_for_process_exit(pid, starttime).await
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn semantic_stdout_overflow_terminates_and_reaps_child() -> io::Result<()> {
    let temp_dir = tempfile::tempdir()?;
    let pid_path = temp_dir.path().join("pid");
    let release_path = temp_dir.path().join("release");
    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(
            "printf '%s' \"$$\" > \"$1.tmp\"; mv \"$1.tmp\" \"$1\"; \
             while [ ! -e \"$2\" ]; do :; done; \
             while :; do printf x; printf '%131072s' x >&2; done",
        )
        .arg("sh")
        .arg(&pid_path)
        .arg(&release_path);
    let mut task = tokio::spawn(run_output_bounded(
        command,
        "sh",
        CommandOutputPolicy {
            stdout: StdoutOutputPolicy::Semantic { max_bytes: 3 },
            diagnostic_stderr_max_bytes: 5,
        },
        Duration::from_secs(60),
    ));
    let (pid, starttime) = match wait_for_recorded_process(&pid_path).await {
        Ok(process) => process,
        Err(error) => {
            task.abort();
            let _ = task.await;
            return Err(error);
        }
    };
    if let Err(error) = tokio::fs::write(&release_path, []).await {
        task.abort();
        let _ = task.await;
        wait_for_process_exit(pid, starttime).await?;
        return Err(error);
    }

    let error = match tokio::time::timeout(PROCESS_OBSERVATION_TIMEOUT, &mut task).await {
        Ok(result) => result.unwrap().unwrap_err(),
        Err(_) => {
            task.abort();
            let _ = task.await;
            wait_for_process_exit(pid, starttime).await?;
            return Err(io::Error::other(
                "semantic stdout overflow did not stop the command promptly",
            ));
        }
    };

    assert!(matches!(
        error,
        BoundedCommandError::OutputTooLarge {
            stream: "stdout",
            limit: 3
        }
    ));
    wait_for_process_exit(pid, starttime).await
}

#[tokio::test]
async fn output_command_captures_requested_streams() {
    let mut command = Command::new("sh");
    command.args(["-c", "printf stdout; printf stderr >&2"]);

    let outcome = run_output_bounded(
        command,
        "sh",
        CommandOutputPolicy {
            stdout: StdoutOutputPolicy::Semantic { max_bytes: 6 },
            diagnostic_stderr_max_bytes: 6,
        },
        Duration::from_secs(1),
    )
    .await
    .unwrap();
    let BoundedCommandOutcome::Exited(output) = outcome else {
        panic!("command unexpectedly timed out");
    };

    assert!(output.status.success());
    assert_eq!(output.stdout, b"stdout");
    assert_eq!(output.stderr, b"stderr");

    let mut command = Command::new("sh");
    command.args(["-c", "printf stdout; printf stderr >&2"]);
    let outcome = run_output_bounded(
        command,
        "sh",
        CommandOutputPolicy::diagnostic_stderr(),
        Duration::from_secs(1),
    )
    .await
    .unwrap();
    let BoundedCommandOutcome::Exited(output) = outcome else {
        panic!("command unexpectedly timed out");
    };

    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"stderr");
}

#[tokio::test]
async fn oversized_semantic_stdout_fails_after_oversized_stderr_drains() {
    let mut command = Command::new("sh");
    command.args(["-c", "head -c 65536 /dev/zero; head -c 65536 /dev/zero >&2"]);

    let error = run_output_bounded(
        command,
        "sh",
        CommandOutputPolicy {
            stdout: StdoutOutputPolicy::Semantic { max_bytes: 3 },
            diagnostic_stderr_max_bytes: 5,
        },
        Duration::from_secs(1),
    )
    .await
    .unwrap_err();

    assert!(matches!(
        error,
        BoundedCommandError::OutputTooLarge {
            stream: "stdout",
            limit: 3
        }
    ));
}

#[tokio::test]
async fn oversized_diagnostic_stderr_is_bounded_and_marked() {
    let mut command = Command::new("sh");
    command.args(["-c", "head -c 65536 /dev/zero | tr '\\0' x >&2; exit 7"]);

    let outcome = run_output_bounded(
        command,
        "sh",
        CommandOutputPolicy {
            stdout: StdoutOutputPolicy::Discard,
            diagnostic_stderr_max_bytes: 3,
        },
        Duration::from_secs(1),
    )
    .await
    .unwrap();
    let BoundedCommandOutcome::Exited(output) = outcome else {
        panic!("command unexpectedly timed out");
    };

    assert_eq!(output.status.code(), Some(7));
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"xxx\n[output truncated]");
}

#[tokio::test(start_paused = true)]
async fn output_tasks_share_one_cleanup_deadline() {
    let stdout = tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        Ok(CapturedChildOutput::Bytes(Vec::new()))
    });
    let stderr = tokio::spawn(async {
        tokio::time::sleep(Duration::from_secs(60)).await;
        Ok(CapturedChildOutput::Bytes(Vec::new()))
    });
    let (_, semantic_stdout_overflow) = oneshot::channel();
    let mut tasks = ChildOutputTasks::StdoutAndStderr {
        stdout,
        stderr,
        semantic_stdout_overflow,
    };
    let started_at = Instant::now();

    let error = tasks.collect("test-command").await.unwrap_err();

    assert_eq!(Instant::now() - started_at, COMMAND_CLEANUP_TIMEOUT);
    assert!(
        matches!(error, BoundedCommandError::Lifecycle(message) if message.contains("stderr task did not finish"))
    );
}

#[tokio::test(start_paused = true)]
async fn output_task_failure_is_not_masked_by_open_sibling() {
    let stdout = tokio::spawn(async { Err(io::Error::other("read failed")) });
    let stderr = tokio::spawn(async {
        tokio::time::sleep(Duration::from_secs(60)).await;
        Ok(CapturedChildOutput::Bytes(Vec::new()))
    });
    let (_, semantic_stdout_overflow) = oneshot::channel();
    let mut tasks = ChildOutputTasks::StdoutAndStderr {
        stdout,
        stderr,
        semantic_stdout_overflow,
    };
    let started_at = Instant::now();

    let error = tasks.collect("test-command").await.unwrap_err();

    assert_eq!(Instant::now() - started_at, Duration::ZERO);
    assert!(
        matches!(error, BoundedCommandError::Lifecycle(message) if message.contains("read test-command stdout: read failed"))
    );
}
