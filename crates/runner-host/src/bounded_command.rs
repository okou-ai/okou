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

    let terminal_result = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => return Ok(BoundedCommandOutcome::Exited(status)),
        Ok(Err(error)) => Err(BoundedCommandError::Wait(error)),
        Err(_) => Ok(BoundedCommandOutcome::TimedOut),
    };

    kill_and_reap_child(program, &mut child)
        .await
        .map_err(BoundedCommandError::Lifecycle)?;
    terminal_result
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

    let terminal_result = match wait_outcome {
        WaitOutcome::Child(Ok(status)) => {
            let (stdout, stderr) = output_tasks.collect(program).await?;
            return Ok(BoundedCommandOutcome::Exited(Output {
                status,
                stdout,
                stderr,
            }));
        }
        WaitOutcome::Child(Err(error)) => Err(BoundedCommandError::Wait(error)),
        WaitOutcome::SemanticStdoutOverflow(limit) => Err(BoundedCommandError::OutputTooLarge {
            stream: "stdout",
            limit,
        }),
        WaitOutcome::TimedOut => Ok(BoundedCommandOutcome::TimedOut),
    };

    let cleanup_result = kill_and_reap_child(program, &mut child).await;
    // Abort readers even when child cleanup fails.
    output_tasks.abort();
    cleanup_result.map_err(BoundedCommandError::Lifecycle)?;
    terminal_result
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
                ))))
            }
            StdoutOutputPolicy::Semantic { max_bytes } => {
                let stdout = child.stdout.take().ok_or("stdout")?;
                let stderr = child.stderr.take().ok_or("stderr")?;
                let (semantic_stdout_overflow_tx, semantic_stdout_overflow_rx) = oneshot::channel();
                Ok(Self::StdoutAndStderr {
                    stdout: tokio::spawn(read_child_output(
                        stdout,
                        StreamOutputPolicy::Semantic {
                            max_bytes,
                            overflow: semantic_stdout_overflow_tx,
                        },
                    )),
                    stderr: tokio::spawn(read_child_output(
                        stderr,
                        StreamOutputPolicy::Diagnostic {
                            max_bytes: output_policy.diagnostic_stderr_max_bytes,
                        },
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
        let result = tokio::time::timeout_at(deadline, async {
            match self {
                Self::Stderr(stderr_task) => {
                    let stderr = wait_child_output_task(program, "stderr", stderr_task).await?;
                    Ok((Vec::new(), captured_child_output_bytes("stderr", stderr)?))
                }
                Self::StdoutAndStderr {
                    stdout: stdout_task,
                    stderr: stderr_task,
                    ..
                } => {
                    let (stdout, stderr) = tokio::try_join!(
                        wait_child_output_task(program, "stdout", stdout_task),
                        wait_child_output_task(program, "stderr", stderr_task),
                    )?;
                    Ok((
                        captured_child_output_bytes("stdout", stdout)?,
                        captured_child_output_bytes("stderr", stderr)?,
                    ))
                }
            }
        })
        .await;

        let result = match result {
            Ok(result) => result,
            Err(_) => {
                let stream = match self {
                    Self::Stderr(_) => "stderr",
                    Self::StdoutAndStderr { stdout, .. } if stdout.is_finished() => "stderr",
                    Self::StdoutAndStderr { .. } => "stdout",
                };
                Err(output_task_timeout(program, stream))
            }
        };
        if result.is_err() {
            self.abort();
        }
        result
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

#[derive(Debug)]
enum StreamOutputPolicy {
    Diagnostic {
        max_bytes: usize,
    },
    Semantic {
        max_bytes: usize,
        overflow: oneshot::Sender<usize>,
    },
}

impl StreamOutputPolicy {
    fn max_bytes(&self) -> usize {
        match self {
            Self::Diagnostic { max_bytes } | Self::Semantic { max_bytes, .. } => *max_bytes,
        }
    }
}

#[derive(Debug)]
enum CapturedChildOutput {
    Bytes(Vec<u8>),
    SemanticOverflow { limit: usize },
}

async fn read_child_output<R>(
    mut reader: R,
    output_policy: StreamOutputPolicy,
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
                StreamOutputPolicy::Semantic {
                    max_bytes,
                    overflow,
                } => {
                    let _ = overflow.send(max_bytes);
                    return Ok(CapturedChildOutput::SemanticOverflow { limit: max_bytes });
                }
                StreamOutputPolicy::Diagnostic { .. } => truncated = true,
            }
        }
    }

    if matches!(output_policy, StreamOutputPolicy::Diagnostic { .. }) && truncated {
        if !output.is_empty() {
            output.push(b'\n');
        }
        output.extend_from_slice(OUTPUT_TRUNCATION_MARKER);
    }

    Ok(CapturedChildOutput::Bytes(output))
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
    match output {
        CapturedChildOutput::SemanticOverflow { limit } => {
            Err(BoundedCommandError::OutputTooLarge { stream, limit })
        }
        CapturedChildOutput::Bytes(bytes) => Ok(bytes),
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
mod tests;
