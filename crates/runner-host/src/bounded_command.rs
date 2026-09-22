use std::io;
use std::process::{ExitStatus, Output, Stdio};
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::child_cleanup::kill_and_reap_child_on_drop;

const COMMAND_CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const BOUNDED_COMMAND_CHILD_LABEL: &str = "bounded command";
const DEFAULT_SEMANTIC_OUTPUT_LIMIT_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_DIAGNOSTIC_OUTPUT_LIMIT_BYTES: usize = 64 * 1024;
const OUTPUT_READ_CHUNK_BYTES: usize = 8 * 1024;
const OUTPUT_TRUNCATION_MARKER: &[u8] = b"[output truncated]";

#[derive(Debug)]
pub enum BoundedCommandOutcome<T> {
    Exited(T),
    TimedOut,
}

#[derive(Debug)]
pub enum BoundedCommandError {
    Spawn(io::Error),
    Wait(io::Error),
    Lifecycle(String),
    OutputTooLarge { stream: &'static str, limit: usize },
}

#[derive(Clone, Copy, Debug)]
pub struct CommandOutputPolicy {
    stdout: StdoutOutputPolicy,
    diagnostic_stderr_max_bytes: usize,
}

#[derive(Clone, Copy, Debug)]
enum StdoutOutputPolicy {
    Discard,
    Semantic { max_bytes: usize },
}

impl CommandOutputPolicy {
    pub const fn diagnostic_stderr() -> Self {
        Self {
            stdout: StdoutOutputPolicy::Discard,
            diagnostic_stderr_max_bytes: DEFAULT_DIAGNOSTIC_OUTPUT_LIMIT_BYTES,
        }
    }

    pub const fn semantic_stdout() -> Self {
        Self {
            stdout: StdoutOutputPolicy::Semantic {
                max_bytes: DEFAULT_SEMANTIC_OUTPUT_LIMIT_BYTES,
            },
            diagnostic_stderr_max_bytes: DEFAULT_DIAGNOSTIC_OUTPUT_LIMIT_BYTES,
        }
    }
}

pub async fn run_bounded(
    mut command: Command,
    program: &str,
    timeout: Duration,
) -> Result<BoundedCommandOutcome<ExitStatus>, BoundedCommandError> {
    let mut child = BoundedChild::spawn(&mut command).map_err(BoundedCommandError::Spawn)?;

    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => Ok(BoundedCommandOutcome::Exited(status)),
        Ok(Err(error)) => {
            kill_and_reap_child(program, &mut child)
                .await
                .map_err(BoundedCommandError::Lifecycle)?;
            Err(BoundedCommandError::Wait(error))
        }
        Err(_) => {
            kill_and_reap_child(program, &mut child)
                .await
                .map_err(BoundedCommandError::Lifecycle)?;
            Ok(BoundedCommandOutcome::TimedOut)
        }
    }
}

pub async fn run_output_bounded(
    mut command: Command,
    program: &str,
    output_policy: CommandOutputPolicy,
    timeout: Duration,
) -> Result<BoundedCommandOutcome<Output>, BoundedCommandError> {
    match output_policy.stdout {
        StdoutOutputPolicy::Discard => {
            command.stdout(Stdio::null()).stderr(Stdio::piped());
        }
        StdoutOutputPolicy::Semantic { .. } => {
            command.stdout(Stdio::piped()).stderr(Stdio::piped());
        }
    }

    let mut child = BoundedChild::spawn(&mut command).map_err(BoundedCommandError::Spawn)?;
    let mut output_tasks = match child.output_tasks(output_policy) {
        Ok(output_tasks) => output_tasks,
        Err(stream) => {
            return match kill_and_reap_child(program, &mut child).await {
                Ok(()) => Err(BoundedCommandError::Lifecycle(format!(
                    "{program} {stream} pipe unavailable"
                ))),
                Err(cleanup_error) => Err(BoundedCommandError::Lifecycle(format!(
                    "{program} {stream} pipe unavailable and failed to stop child: {cleanup_error}"
                ))),
            };
        }
    };

    enum WaitOutcome {
        Child(io::Result<ExitStatus>),
        SemanticStdoutOverflow(usize),
        TimedOut,
    }

    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let wait_outcome = tokio::select! {
        biased;
        Some(limit) = output_tasks.semantic_stdout_overflow() => {
            WaitOutcome::SemanticStdoutOverflow(limit)
        }
        status = child.wait() => WaitOutcome::Child(status),
        () = &mut deadline => WaitOutcome::TimedOut,
    };

    let status = match wait_outcome {
        WaitOutcome::Child(Ok(status)) => status,
        WaitOutcome::Child(Err(error)) => {
            let cleanup_result = kill_and_reap_child(program, &mut child).await;
            output_tasks.abort();
            cleanup_result.map_err(BoundedCommandError::Lifecycle)?;
            return Err(BoundedCommandError::Wait(error));
        }
        WaitOutcome::SemanticStdoutOverflow(limit) => {
            let cleanup_result = kill_and_reap_child(program, &mut child).await;
            output_tasks.abort();
            cleanup_result.map_err(BoundedCommandError::Lifecycle)?;
            return Err(BoundedCommandError::OutputTooLarge {
                stream: "stdout",
                limit,
            });
        }
        WaitOutcome::TimedOut => {
            let cleanup_result = kill_and_reap_child(program, &mut child).await;
            output_tasks.abort();
            cleanup_result.map_err(BoundedCommandError::Lifecycle)?;
            return Ok(BoundedCommandOutcome::TimedOut);
        }
    };

    let (stdout, stderr) = output_tasks.collect(program).await?;
    Ok(BoundedCommandOutcome::Exited(Output {
        status,
        stdout,
        stderr,
    }))
}

struct BoundedChild {
    child: Option<Child>,
}

impl BoundedChild {
    fn spawn(command: &mut Command) -> io::Result<Self> {
        command.spawn().map(|child| Self { child: Some(child) })
    }

    async fn wait(&mut self) -> io::Result<ExitStatus> {
        let result = match self.child.as_mut() {
            Some(child) => child.wait().await,
            None => Err(io::Error::other("bounded command child is not owned")),
        };
        if result.is_ok() {
            self.child = None;
        }
        result
    }

    fn start_kill(&mut self) -> io::Result<()> {
        match self.child.as_mut() {
            Some(child) => child.start_kill(),
            None => Err(io::Error::other("bounded command child is not owned")),
        }
    }

    fn output_tasks(
        &mut self,
        output_policy: CommandOutputPolicy,
    ) -> Result<ChildOutputTasks, &'static str> {
        match self.child.as_mut() {
            Some(child) => ChildOutputTasks::from_child(child, output_policy),
            None => Err("child"),
        }
    }
}

impl Drop for BoundedChild {
    fn drop(&mut self) {
        kill_and_reap_child_on_drop(BOUNDED_COMMAND_CHILD_LABEL, &mut self.child);
    }
}

enum ChildOutputTasks {
    Stderr(JoinHandle<io::Result<CapturedChildOutput>>),
    StdoutAndStderr {
        stdout: JoinHandle<io::Result<CapturedChildOutput>>,
        stderr: JoinHandle<io::Result<CapturedChildOutput>>,
        semantic_stdout_overflow: oneshot::Receiver<usize>,
    },
}

impl ChildOutputTasks {
    fn from_child(
        child: &mut tokio::process::Child,
        output_policy: CommandOutputPolicy,
    ) -> Result<Self, &'static str> {
        match output_policy.stdout {
            StdoutOutputPolicy::Discard => {
                let stderr = child.stderr.take().ok_or("stderr")?;
                Ok(Self::Stderr(tokio::spawn(read_child_output(
                    stderr,
                    StreamOutputPolicy::Diagnostic {
                        max_bytes: output_policy.diagnostic_stderr_max_bytes,
                    },
                    None,
                ))))
            }
            StdoutOutputPolicy::Semantic { max_bytes } => {
                let stdout = child.stdout.take().ok_or("stdout")?;
                let stderr = child.stderr.take().ok_or("stderr")?;
                let (semantic_stdout_overflow_tx, semantic_stdout_overflow_rx) = oneshot::channel();
                Ok(Self::StdoutAndStderr {
                    stdout: tokio::spawn(read_child_output(
                        stdout,
                        StreamOutputPolicy::Semantic { max_bytes },
                        Some(semantic_stdout_overflow_tx),
                    )),
                    stderr: tokio::spawn(read_child_output(
                        stderr,
                        StreamOutputPolicy::Diagnostic {
                            max_bytes: output_policy.diagnostic_stderr_max_bytes,
                        },
                        None,
                    )),
                    semantic_stdout_overflow: semantic_stdout_overflow_rx,
                })
            }
        }
    }

    async fn semantic_stdout_overflow(&mut self) -> Option<usize> {
        match self {
            Self::Stderr(_) => std::future::pending().await,
            Self::StdoutAndStderr {
                semantic_stdout_overflow,
                ..
            } => semantic_stdout_overflow.await.ok(),
        }
    }

    async fn collect(&mut self, program: &str) -> Result<(Vec<u8>, Vec<u8>), BoundedCommandError> {
        let deadline = Instant::now() + COMMAND_CLEANUP_TIMEOUT;
        match self {
            Self::Stderr(stderr_task) => {
                let result = tokio::time::timeout_at(
                    deadline,
                    wait_child_output_task(program, "stderr", stderr_task),
                )
                .await;
                match result {
                    Ok(stderr) => Ok((Vec::new(), captured_child_output_bytes("stderr", stderr?)?)),
                    Err(_) => {
                        stderr_task.abort();
                        Err(output_task_timeout(program, "stderr"))
                    }
                }
            }
            Self::StdoutAndStderr {
                stdout: stdout_task,
                stderr: stderr_task,
                ..
            } => {
                let result = tokio::time::timeout_at(deadline, async {
                    tokio::try_join!(
                        wait_child_output_task(program, "stdout", stdout_task),
                        wait_child_output_task(program, "stderr", stderr_task),
                    )
                })
                .await;
                match result {
                    Ok(Ok((stdout, stderr))) => Ok((
                        captured_child_output_bytes("stdout", stdout)?,
                        captured_child_output_bytes("stderr", stderr)?,
                    )),
                    Ok(Err(error)) => {
                        stdout_task.abort();
                        stderr_task.abort();
                        Err(error)
                    }
                    Err(_) => {
                        let stream = if stdout_task.is_finished() {
                            "stderr"
                        } else {
                            "stdout"
                        };
                        stdout_task.abort();
                        stderr_task.abort();
                        Err(output_task_timeout(program, stream))
                    }
                }
            }
        }
    }

    fn abort(&self) {
        match self {
            Self::Stderr(stderr) => stderr.abort(),
            Self::StdoutAndStderr { stdout, stderr, .. } => {
                stdout.abort();
                stderr.abort();
            }
        }
    }
}

impl Drop for ChildOutputTasks {
    fn drop(&mut self) {
        self.abort();
    }
}

#[derive(Clone, Copy, Debug)]
enum StreamOutputPolicy {
    Diagnostic { max_bytes: usize },
    Semantic { max_bytes: usize },
}

impl StreamOutputPolicy {
    fn max_bytes(self) -> usize {
        match self {
            Self::Diagnostic { max_bytes } | Self::Semantic { max_bytes } => max_bytes,
        }
    }
}

#[derive(Debug)]
struct CapturedChildOutput {
    bytes: Vec<u8>,
    semantic_overflow: Option<usize>,
}

async fn read_child_output<R>(
    mut reader: R,
    output_policy: StreamOutputPolicy,
    semantic_stdout_overflow: Option<oneshot::Sender<usize>>,
) -> io::Result<CapturedChildOutput>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let max_bytes = output_policy.max_bytes();
    let mut output = Vec::with_capacity(max_bytes.min(OUTPUT_READ_CHUNK_BYTES));
    let mut buffer = [0_u8; OUTPUT_READ_CHUNK_BYTES];
    let mut truncated = false;

    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }

        let keep = max_bytes.saturating_sub(output.len()).min(read);
        let chunk = buffer.get(..keep).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "kept output bytes exceeded read buffer",
            )
        })?;
        output.extend_from_slice(chunk);
        if keep < read {
            match output_policy {
                StreamOutputPolicy::Semantic { max_bytes } => {
                    if let Some(sender) = semantic_stdout_overflow {
                        let _ = sender.send(max_bytes);
                    }
                    return Ok(CapturedChildOutput {
                        bytes: output,
                        semantic_overflow: Some(max_bytes),
                    });
                }
                StreamOutputPolicy::Diagnostic { .. } => truncated = true,
            }
        }
    }

    let semantic_overflow = match output_policy {
        StreamOutputPolicy::Diagnostic { .. } if truncated => {
            if !output.is_empty() {
                output.push(b'\n');
            }
            output.extend_from_slice(OUTPUT_TRUNCATION_MARKER);
            None
        }
        StreamOutputPolicy::Diagnostic { .. } | StreamOutputPolicy::Semantic { .. } => None,
    };

    Ok(CapturedChildOutput {
        bytes: output,
        semantic_overflow,
    })
}

async fn wait_child_output_task(
    program: &str,
    stream: &str,
    task: &mut JoinHandle<io::Result<CapturedChildOutput>>,
) -> Result<CapturedChildOutput, BoundedCommandError> {
    child_output_task_result(program, stream, task.await)
}

fn child_output_task_result(
    program: &str,
    stream: &str,
    result: Result<io::Result<CapturedChildOutput>, tokio::task::JoinError>,
) -> Result<CapturedChildOutput, BoundedCommandError> {
    match result {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => Err(BoundedCommandError::Lifecycle(format!(
            "read {program} {stream}: {error}"
        ))),
        Err(error) => Err(BoundedCommandError::Lifecycle(format!(
            "{program} {stream} task failed: {error}"
        ))),
    }
}

fn captured_child_output_bytes(
    stream: &'static str,
    output: CapturedChildOutput,
) -> Result<Vec<u8>, BoundedCommandError> {
    match output.semantic_overflow {
        Some(limit) => Err(BoundedCommandError::OutputTooLarge { stream, limit }),
        None => Ok(output.bytes),
    }
}

fn output_task_timeout(program: &str, stream: &str) -> BoundedCommandError {
    BoundedCommandError::Lifecycle(format!(
        "{program} {stream} task did not finish within {}ms after child exit",
        COMMAND_CLEANUP_TIMEOUT.as_millis()
    ))
}

async fn kill_and_reap_child(program: &str, child: &mut BoundedChild) -> Result<(), String> {
    let kill_error = child.start_kill().err();
    let deadline = Instant::now() + COMMAND_CLEANUP_TIMEOUT;
    match tokio::time::timeout_at(deadline, child.wait()).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) => Err(format!("wait killed {program}: {error}")),
        Err(_) => {
            let kill_detail = kill_error
                .map(|error| format!("; kill failed first: {error}"))
                .unwrap_or_default();
            Err(format!(
                "killed {program} did not exit within {}ms{kill_detail}",
                COMMAND_CLEANUP_TIMEOUT.as_millis()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
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
            Ok(CapturedChildOutput {
                bytes: Vec::new(),
                semantic_overflow: None,
            })
        });
        let stderr = tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(60)).await;
            Ok(CapturedChildOutput {
                bytes: Vec::new(),
                semantic_overflow: None,
            })
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
            Ok(CapturedChildOutput {
                bytes: Vec::new(),
                semantic_overflow: None,
            })
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
}
