use std::ffi::OsStr;
use std::future::Future;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::runtime::Handle;
use tokio::task::JoinHandle;
use tracing::warn;

use crate::process::ChildExitNotifier;

type PipeReadTask = JoinHandle<std::io::Result<PipeReadOutput>>;

const DEFAULT_SEMANTIC_OUTPUT_LIMIT_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_DIAGNOSTIC_OUTPUT_LIMIT_BYTES: usize = 64 * 1024;
const PIPE_READ_CHUNK_BYTES: usize = 8192;
const COMMAND_CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const COMMAND_CHILD_LABEL: &str = "sandbox host command";

/// Error from a failed command.
#[derive(Debug, thiserror::Error)]
#[error("command failed: {command}\n{detail}")]
pub struct CommandError {
    pub command: String,
    pub exit_code: Option<i32>,
    pub detail: String,
}

/// Outcome for best-effort commands where callers intentionally ignore
/// non-zero exits but still need coarse failure classification for cleanup
/// safety decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IgnoredCommandOutcome {
    Success,
    NonZero,
    NotFound,
    SpawnError,
    WaitError,
    PipeError,
    OutputTooLarge,
    Timeout,
    LifecycleError,
}

impl IgnoredCommandOutcome {
    pub fn completed_without_timeout(self) -> bool {
        matches!(self, Self::Success | Self::NonZero)
    }
}

#[derive(Debug, thiserror::Error)]
enum CommandRunError {
    #[error("spawn failed: {0}")]
    Spawn(std::io::Error),
    #[error("wait failed: {0}")]
    Wait(std::io::Error),
    #[error("pipe read task failed: {0}")]
    PipeTask(tokio::task::JoinError),
    #[error("pipe read failed: {0}")]
    PipeRead(std::io::Error),
    #[error("{0} pipe unavailable")]
    PipeUnavailable(&'static str),
    #[error("{pipe} exceeded output limit of {limit} bytes")]
    OutputTooLarge { pipe: &'static str, limit: usize },
    #[error("timed out after {0}ms")]
    Timeout(u128),
    #[error("command lifecycle failed: {0}")]
    Lifecycle(String),
}

#[derive(Debug)]
struct CommandOutput {
    status: ExitStatus,
    stdout: CapturedPipeOutput,
    stderr: CapturedPipeOutput,
}

#[derive(Debug)]
struct CapturedPipeOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

impl CapturedPipeOutput {
    fn discarded() -> Self {
        Self {
            bytes: Vec::new(),
            truncated: false,
        }
    }

    fn to_lossy_trimmed_string(&self) -> String {
        let mut output = String::from_utf8_lossy(&self.bytes).trim().to_string();
        if self.truncated {
            if output.is_empty() {
                output = "[output truncated]".to_string();
            } else {
                output.push_str("\n[output truncated]");
            }
        }
        output
    }
}

#[derive(Debug)]
struct PipeReadOutput {
    output: CapturedPipeOutput,
    overflow: Option<usize>,
}

#[derive(Clone, Copy)]
struct CommandOutputPolicy {
    stdout: StreamOutputPolicy,
    stderr: StreamOutputPolicy,
}

impl CommandOutputPolicy {
    fn capture_semantic_stdout() -> Self {
        Self {
            stdout: StreamOutputPolicy::SemanticCapture {
                max_bytes: DEFAULT_SEMANTIC_OUTPUT_LIMIT_BYTES,
            },
            stderr: StreamOutputPolicy::DiagnosticCapture {
                max_bytes: DEFAULT_DIAGNOSTIC_OUTPUT_LIMIT_BYTES,
            },
        }
    }

    fn status_only() -> Self {
        Self {
            stdout: StreamOutputPolicy::Discard,
            stderr: StreamOutputPolicy::DiagnosticCapture {
                max_bytes: DEFAULT_DIAGNOSTIC_OUTPUT_LIMIT_BYTES,
            },
        }
    }
}

#[derive(Clone, Copy)]
enum StreamOutputPolicy {
    Discard,
    DiagnosticCapture { max_bytes: usize },
    SemanticCapture { max_bytes: usize },
}

impl StreamOutputPolicy {
    fn capture_limit(self) -> Option<usize> {
        match self {
            Self::Discard => None,
            Self::DiagnosticCapture { max_bytes } | Self::SemanticCapture { max_bytes } => {
                Some(max_bytes)
            }
        }
    }

    fn is_semantic(self) -> bool {
        matches!(self, Self::SemanticCapture { .. })
    }
}

/// Format a human-readable display string for a command invocation.
fn format_command_display<P, A>(program: &P, args: &[A]) -> String
where
    P: AsRef<OsStr> + ?Sized,
    A: AsRef<OsStr>,
{
    let mut parts = Vec::with_capacity(args.len() + 1);
    parts.push(program.as_ref().to_string_lossy());
    parts.extend(args.iter().map(|arg| arg.as_ref().to_string_lossy()));
    parts.join(" ")
}

/// Execute a command with a bounded runtime.
///
/// This helper is intended for host lifecycle operations where an unbounded
/// subprocess can block resource cleanup. On timeout the child is killed and
/// waited before returning within a separate finite cleanup budget. On Unix,
/// the subprocess runs in its own process group so timeout cleanup also kills
/// grandchildren while the child is still owned. The command timeout bounds
/// child exit and stdout/stderr pipe draining; lifecycle errors report when
/// termination cannot be confirmed within the cleanup budget. When pipe
/// draining times out after the child has already been reaped, cleanup aborts
/// pipe readers without signalling by a stale PID.
pub async fn exec_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<String, CommandError> {
    let cmd_display = format_command_display(program, args);

    let output = command_output_with_timeout(program, args, timeout)
        .await
        .map_err(|e| CommandError {
            command: cmd_display.clone(),
            exit_code: None,
            detail: e.to_string(),
        })?;

    if output.status.success() {
        let stdout = output.stdout.to_lossy_trimmed_string();
        Ok(stdout)
    } else {
        let stderr = output.stderr.to_lossy_trimmed_string();
        Err(CommandError {
            command: cmd_display,
            exit_code: output.status.code(),
            detail: stderr,
        })
    }
}

/// Execute a command with bounded runtime, discarding stdout.
pub async fn exec_status_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<(), CommandError> {
    exec_status(program, args, timeout).await
}

/// Execute a command with native OS arguments and bounded runtime, discarding stdout.
pub async fn exec_status_os_with_timeout(
    program: &OsStr,
    args: &[&OsStr],
    timeout: Duration,
) -> Result<(), CommandError> {
    exec_status(program, args, timeout).await
}

async fn exec_status<P, A>(program: P, args: &[A], timeout: Duration) -> Result<(), CommandError>
where
    P: AsRef<OsStr>,
    A: AsRef<OsStr>,
{
    let cmd_display = format_command_display(&program, args);

    let output =
        command_output_with_policy(program, args, timeout, CommandOutputPolicy::status_only())
            .await
            .map_err(|e| CommandError {
                command: cmd_display.clone(),
                exit_code: None,
                detail: e.to_string(),
            })?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = output.stderr.to_lossy_trimmed_string();
        Err(CommandError {
            command: cmd_display,
            exit_code: output.status.code(),
            detail: stderr,
        })
    }
}

/// Execute a best-effort command with a bounded runtime.
pub async fn exec_ignore_errors_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> IgnoredCommandOutcome {
    match command_output_with_policy(program, args, timeout, CommandOutputPolicy::status_only())
        .await
    {
        Ok(o) if o.status.success() => IgnoredCommandOutcome::Success,
        Ok(_) => IgnoredCommandOutcome::NonZero,
        Err(CommandRunError::Timeout(_)) => IgnoredCommandOutcome::Timeout,
        Err(CommandRunError::Wait(_)) => IgnoredCommandOutcome::WaitError,
        Err(
            CommandRunError::PipeTask(_)
            | CommandRunError::PipeRead(_)
            | CommandRunError::PipeUnavailable(_),
        ) => IgnoredCommandOutcome::PipeError,
        Err(CommandRunError::OutputTooLarge { .. }) => IgnoredCommandOutcome::OutputTooLarge,
        Err(CommandRunError::Lifecycle(_)) => IgnoredCommandOutcome::LifecycleError,
        Err(CommandRunError::Spawn(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            IgnoredCommandOutcome::NotFound
        }
        Err(CommandRunError::Spawn(_)) => IgnoredCommandOutcome::SpawnError,
    }
}

async fn command_output_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> std::result::Result<CommandOutput, CommandRunError> {
    command_output_with_policy(
        program,
        args,
        timeout,
        CommandOutputPolicy::capture_semantic_stdout(),
    )
    .await
}

async fn command_output_with_policy<P, A>(
    program: P,
    args: &[A],
    timeout: Duration,
    output_policy: CommandOutputPolicy,
) -> std::result::Result<CommandOutput, CommandRunError>
where
    P: AsRef<OsStr>,
    A: AsRef<OsStr>,
{
    command_output_with_policy_and_exit_notifier(program, args, timeout, output_policy, |child| {
        ChildExitNotifier::open(child.id())
    })
    .await
}

#[cfg(test)]
async fn command_output_with_timeout_with_exit_notifier(
    program: &str,
    args: &[&str],
    timeout: Duration,
    open_exit_notifier: impl FnOnce(&Child) -> ChildExitNotifier,
) -> std::result::Result<CommandOutput, CommandRunError> {
    command_output_with_policy_and_exit_notifier(
        program,
        args,
        timeout,
        CommandOutputPolicy::capture_semantic_stdout(),
        open_exit_notifier,
    )
    .await
}

async fn command_output_with_policy_and_exit_notifier<P, A>(
    program: P,
    args: &[A],
    timeout: Duration,
    output_policy: CommandOutputPolicy,
    open_exit_notifier: impl FnOnce(&Child) -> ChildExitNotifier,
) -> std::result::Result<CommandOutput, CommandRunError>
where
    P: AsRef<OsStr>,
    A: AsRef<OsStr>,
{
    let mut command = Command::new(program);
    command
        .args(args)
        .stdout(stdio_for_policy(output_policy.stdout))
        .stderr(stdio_for_policy(output_policy.stderr))
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let spawned_child = command.spawn().map_err(CommandRunError::Spawn)?;
    let exit_notifier = open_exit_notifier(&spawned_child);
    let mut child = CommandChild::new(spawned_child);

    let stdout_task = match child.spawn_pipe_task(PipeKind::Stdout, output_policy.stdout) {
        Ok(task) => task,
        Err(error) => {
            let mut pipe_tasks = PipeTasks::new(None, None);
            return Err(cleanup_command_failure(&mut child, &mut pipe_tasks, error).await);
        }
    };
    let stderr_task = match child.spawn_pipe_task(PipeKind::Stderr, output_policy.stderr) {
        Ok(task) => task,
        Err(error) => {
            let mut pipe_tasks = PipeTasks::new(stdout_task, None);
            return Err(cleanup_command_failure(&mut child, &mut pipe_tasks, error).await);
        }
    };
    let mut pipe_tasks = PipeTasks::new(stdout_task, stderr_task);
    let deadline = tokio::time::Instant::now() + timeout;

    let child_exit = match wait_for_child_exit(&exit_notifier, deadline, timeout).await {
        Ok(child_exit) => child_exit,
        Err(error) => {
            return Err(cleanup_command_failure(&mut child, &mut pipe_tasks, error).await);
        }
    };

    let (status, stdout, stderr) =
        collect_command_output(child_exit, &mut child, &mut pipe_tasks, deadline, timeout).await?;
    Ok(CommandOutput {
        status,
        stdout,
        stderr,
    })
}

fn stdio_for_policy(policy: StreamOutputPolicy) -> Stdio {
    match policy {
        StreamOutputPolicy::Discard => Stdio::null(),
        StreamOutputPolicy::DiagnosticCapture { .. }
        | StreamOutputPolicy::SemanticCapture { .. } => Stdio::piped(),
    }
}

fn spawn_pipe_task(
    child: &mut Child,
    kind: PipeKind,
    policy: StreamOutputPolicy,
) -> std::result::Result<Option<PipeReadTask>, CommandRunError> {
    let Some(limit) = policy.capture_limit() else {
        return Ok(None);
    };
    match kind {
        PipeKind::Stdout => {
            let pipe = child
                .stdout
                .take()
                .ok_or(CommandRunError::PipeUnavailable(kind.name()))?;
            Ok(Some(tokio::spawn(read_pipe(pipe, policy, limit))))
        }
        PipeKind::Stderr => {
            let pipe = child
                .stderr
                .take()
                .ok_or(CommandRunError::PipeUnavailable(kind.name()))?;
            Ok(Some(tokio::spawn(read_pipe(pipe, policy, limit))))
        }
    }
}

async fn read_pipe<R>(
    mut pipe: R,
    policy: StreamOutputPolicy,
    limit: usize,
) -> std::io::Result<PipeReadOutput>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut output = Vec::with_capacity(limit.min(PIPE_READ_CHUNK_BYTES));
    let mut buffer = [0_u8; PIPE_READ_CHUNK_BYTES];
    let mut truncated = false;
    let mut overflow = None;

    loop {
        let read = pipe.read(&mut buffer).await?;
        if read == 0 {
            break;
        }

        let remaining = limit.saturating_sub(output.len());
        let keep = remaining.min(read);
        if keep > 0 {
            let Some(chunk) = buffer.get(..keep) else {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "kept pipe bytes exceeded read buffer",
                ));
            };
            output.extend_from_slice(chunk);
        }
        if keep < read {
            truncated = true;
            if policy.is_semantic() {
                overflow = Some(limit);
            }
        }
    }

    Ok(PipeReadOutput {
        output: CapturedPipeOutput {
            bytes: output,
            truncated,
        },
        overflow,
    })
}

enum CommandChildExit {
    PreReap,
    NoPreReapNotifier,
}

struct CommandChild {
    child: Option<Child>,
}

impl CommandChild {
    fn new(child: Child) -> Self {
        Self { child: Some(child) }
    }

    fn spawn_pipe_task(
        &mut self,
        kind: PipeKind,
        policy: StreamOutputPolicy,
    ) -> std::result::Result<Option<PipeReadTask>, CommandRunError> {
        let child = self
            .child
            .as_mut()
            .ok_or_else(|| CommandRunError::Lifecycle("command child is not owned".to_string()))?;
        spawn_pipe_task(child, kind, policy)
    }

    async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        let result = match self.child.as_mut() {
            Some(child) => child.wait().await,
            None => Err(std::io::Error::other("command child is not owned")),
        };
        if result.is_ok() {
            self.child.take();
        }
        result
    }

    async fn kill_and_wait_with_gate<F>(
        &mut self,
        cleanup_timeout: Duration,
        before_wait: F,
    ) -> std::result::Result<(), String>
    where
        F: Future<Output = ()>,
    {
        let Some(child) = self.child.as_mut() else {
            return Err("command child is not owned".to_string());
        };
        let pid = child.id();
        let (group_kill_error, child_kill_error) = request_child_tree_kill(child);
        let deadline = tokio::time::Instant::now() + cleanup_timeout;
        let wait_result = tokio::time::timeout_at(deadline, async {
            before_wait.await;
            self.wait().await
        })
        .await;

        match wait_result {
            Ok(Ok(_)) => {
                if let Some(error) =
                    group_kill_error.filter(|error| *error != nix::errno::Errno::ESRCH)
                {
                    warn!(
                        label = COMMAND_CHILD_LABEL,
                        ?pid,
                        %error,
                        "command child reaped after process-group kill failed"
                    );
                }
                if let Some(error) = child_kill_error
                    .filter(|error| error.kind() != std::io::ErrorKind::InvalidInput)
                {
                    warn!(
                        label = COMMAND_CHILD_LABEL,
                        ?pid,
                        %error,
                        "command child reaped after direct-child kill failed"
                    );
                }
                Ok(())
            }
            Ok(Err(error)) => Err(self.defer_reap_with_error(
                format!("failed to wait for killed child: {error}"),
                group_kill_error,
                child_kill_error,
            )),
            Err(_) => Err(self.defer_reap_with_error(
                format!(
                    "killed child did not exit within {}ms",
                    cleanup_timeout.as_millis()
                ),
                group_kill_error,
                child_kill_error,
            )),
        }
    }

    fn defer_reap_with_error(
        &mut self,
        failure: String,
        group_kill_error: Option<nix::errno::Errno>,
        child_kill_error: Option<std::io::Error>,
    ) -> String {
        let mut details = vec![failure];
        if let Some(error) = group_kill_error {
            details.push(format!("process-group kill failed first: {error}"));
        }
        if let Some(error) = child_kill_error {
            details.push(format!("direct-child kill failed first: {error}"));
        }
        self.spawn_reaper();
        details.join("; ")
    }

    fn spawn_reaper(&mut self) {
        if let Some(child) = self.child.take() {
            spawn_child_reaper(child);
        }
    }
}

impl Drop for CommandChild {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let pid = child.id();
        let (group_kill_error, child_kill_error) = request_child_tree_kill(&mut child);
        if let Some(error) = group_kill_error.filter(|error| *error != nix::errno::Errno::ESRCH) {
            warn!(
                label = COMMAND_CHILD_LABEL,
                ?pid,
                %error,
                "failed to kill command process group during drop cleanup"
            );
        }
        if let Some(error) =
            child_kill_error.filter(|error| error.kind() != std::io::ErrorKind::InvalidInput)
        {
            warn!(
                label = COMMAND_CHILD_LABEL,
                ?pid,
                %error,
                "failed to kill direct command child during drop cleanup"
            );
        }
        spawn_child_reaper(child);
    }
}

fn request_child_tree_kill(
    child: &mut Child,
) -> (Option<nix::errno::Errno>, Option<std::io::Error>) {
    #[cfg(unix)]
    let group_kill_error = crate::process::kill_process_group(child.id()).err();
    #[cfg(not(unix))]
    let group_kill_error = None;
    let child_kill_error = child.start_kill().err();
    (group_kill_error, child_kill_error)
}

fn spawn_child_reaper(mut child: Child) {
    let pid = child.id();
    let Ok(runtime) = Handle::try_current() else {
        warn!(
            label = COMMAND_CHILD_LABEL,
            ?pid,
            "cannot spawn command child reaper without an active Tokio runtime"
        );
        return;
    };

    runtime.spawn(async move {
        if let Err(error) = child.wait().await {
            warn!(
                label = COMMAND_CHILD_LABEL,
                ?pid,
                %error,
                "failed to reap command child after ownership handoff"
            );
        }
    });
}

struct PipeTasks {
    stdout: Option<PipeReadTask>,
    stderr: Option<PipeReadTask>,
}

#[derive(Clone, Copy)]
enum PipeKind {
    Stdout,
    Stderr,
}

impl PipeKind {
    fn name(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }
}

impl PipeTasks {
    fn new(stdout: Option<PipeReadTask>, stderr: Option<PipeReadTask>) -> Self {
        Self { stdout, stderr }
    }

    async fn collect_with_deadline(
        &mut self,
        deadline: tokio::time::Instant,
        timeout: Duration,
    ) -> std::result::Result<(CapturedPipeOutput, CapturedPipeOutput), CommandRunError> {
        let stdout = self
            .collect_one(PipeKind::Stdout, deadline, timeout)
            .await?;
        let stderr = self
            .collect_one(PipeKind::Stderr, deadline, timeout)
            .await?;

        Ok((stdout, stderr))
    }

    async fn collect_one(
        &mut self,
        kind: PipeKind,
        deadline: tokio::time::Instant,
        timeout: Duration,
    ) -> std::result::Result<CapturedPipeOutput, CommandRunError> {
        if self.pipe_mut(kind).is_none() {
            return Ok(CapturedPipeOutput::discarded());
        }

        let result = match tokio::time::timeout_at(
            deadline,
            self.pipe_mut(kind)
                .ok_or(CommandRunError::PipeUnavailable(kind.name()))?,
        )
        .await
        {
            Ok(result) => result,
            Err(_) => return Err(CommandRunError::Timeout(timeout.as_millis())),
        };

        self.take_pipe(kind);
        match collect_pipe_result(kind, result) {
            Ok(output) => Ok(output),
            Err(e) => {
                self.abort_all().await;
                Err(e)
            }
        }
    }

    fn pipe_mut(&mut self, kind: PipeKind) -> Option<&mut PipeReadTask> {
        match kind {
            PipeKind::Stdout => self.stdout.as_mut(),
            PipeKind::Stderr => self.stderr.as_mut(),
        }
    }

    fn take_pipe(&mut self, kind: PipeKind) -> Option<PipeReadTask> {
        match kind {
            PipeKind::Stdout => self.stdout.take(),
            PipeKind::Stderr => self.stderr.take(),
        }
    }

    async fn abort_all(&mut self) {
        self.abort_stdout().await;
        self.abort_stderr().await;
    }

    async fn abort_stdout(&mut self) {
        if let Some(task) = self.stdout.take() {
            abort_pipe_task(task).await;
        }
    }

    async fn abort_stderr(&mut self) {
        if let Some(task) = self.stderr.take() {
            abort_pipe_task(task).await;
        }
    }
}

impl Drop for PipeTasks {
    fn drop(&mut self) {
        if let Some(task) = self.stdout.take() {
            task.abort();
        }
        if let Some(task) = self.stderr.take() {
            task.abort();
        }
    }
}

fn collect_pipe_result(
    kind: PipeKind,
    result: std::result::Result<std::io::Result<PipeReadOutput>, tokio::task::JoinError>,
) -> std::result::Result<CapturedPipeOutput, CommandRunError> {
    let output = result
        .map_err(CommandRunError::PipeTask)?
        .map_err(CommandRunError::PipeRead)?;
    if let Some(limit) = output.overflow {
        Err(CommandRunError::OutputTooLarge {
            pipe: kind.name(),
            limit,
        })
    } else {
        Ok(output.output)
    }
}

async fn abort_pipe_task(task: PipeReadTask) {
    task.abort();
    let _ = task.await;
}

async fn cleanup_command_failure(
    child: &mut CommandChild,
    pipe_tasks: &mut PipeTasks,
    primary_error: CommandRunError,
) -> CommandRunError {
    cleanup_command_failure_with_wait_gate(
        child,
        pipe_tasks,
        primary_error,
        COMMAND_CLEANUP_TIMEOUT,
        std::future::ready(()),
    )
    .await
}

async fn cleanup_command_failure_with_wait_gate<F>(
    child: &mut CommandChild,
    pipe_tasks: &mut PipeTasks,
    primary_error: CommandRunError,
    cleanup_timeout: Duration,
    before_wait: F,
) -> CommandRunError
where
    F: Future<Output = ()>,
{
    let cleanup_result = child
        .kill_and_wait_with_gate(cleanup_timeout, before_wait)
        .await;
    pipe_tasks.abort_all().await;

    match cleanup_result {
        Ok(()) => primary_error,
        Err(cleanup_error) => {
            CommandRunError::Lifecycle(format!("{primary_error}; cleanup failed: {cleanup_error}"))
        }
    }
}

async fn wait_for_child_exit(
    exit_notifier: &ChildExitNotifier,
    deadline: tokio::time::Instant,
    timeout: Duration,
) -> std::result::Result<CommandChildExit, CommandRunError> {
    if exit_notifier.is_available() {
        match tokio::time::timeout_at(deadline, exit_notifier.wait_for_exit()).await {
            Ok(Ok(())) => return Ok(CommandChildExit::PreReap),
            Ok(Err(_)) => return Ok(CommandChildExit::NoPreReapNotifier),
            Err(_) => return Err(CommandRunError::Timeout(timeout.as_millis())),
        }
    }

    Ok(CommandChildExit::NoPreReapNotifier)
}

async fn collect_command_output(
    child_exit: CommandChildExit,
    child: &mut CommandChild,
    pipe_tasks: &mut PipeTasks,
    deadline: tokio::time::Instant,
    timeout: Duration,
) -> std::result::Result<
    (
        std::process::ExitStatus,
        CapturedPipeOutput,
        CapturedPipeOutput,
    ),
    CommandRunError,
> {
    let result = async {
        let (stdout, stderr) = pipe_tasks.collect_with_deadline(deadline, timeout).await?;
        let status = match child_exit {
            CommandChildExit::PreReap => child.wait().await.map_err(CommandRunError::Wait)?,
            CommandChildExit::NoPreReapNotifier => {
                wait_child_with_deadline(child, deadline, timeout).await?
            }
        };
        Ok((status, stdout, stderr))
    }
    .await;

    match result {
        Ok(output) => Ok(output),
        Err(error) => Err(cleanup_command_failure(child, pipe_tasks, error).await),
    }
}

async fn wait_child_with_deadline(
    child: &mut CommandChild,
    deadline: tokio::time::Instant,
    timeout: Duration,
) -> std::result::Result<std::process::ExitStatus, CommandRunError> {
    match tokio::time::timeout_at(deadline, child.wait()).await {
        Ok(Ok(status)) => Ok(status),
        Ok(Err(error)) => Err(CommandRunError::Wait(error)),
        Err(_) => Err(CommandRunError::Timeout(timeout.as_millis())),
    }
}

#[cfg(test)]
mod tests;
