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
    match child_exit {
        CommandChildExit::PreReap => {
            match pipe_tasks.collect_with_deadline(deadline, timeout).await {
                Ok((stdout, stderr)) => {
                    let status = match child.wait().await {
                        Ok(status) => status,
                        Err(error) => {
                            return Err(cleanup_command_failure(
                                child,
                                pipe_tasks,
                                CommandRunError::Wait(error),
                            )
                            .await);
                        }
                    };
                    Ok((status, stdout, stderr))
                }
                Err(error) => Err(cleanup_command_failure(child, pipe_tasks, error).await),
            }
        }
        CommandChildExit::NoPreReapNotifier => {
            match pipe_tasks.collect_with_deadline(deadline, timeout).await {
                Ok((stdout, stderr)) => {
                    let status = match wait_child_with_deadline(child, deadline, timeout).await {
                        Ok(status) => status,
                        Err(error) => {
                            return Err(cleanup_command_failure(child, pipe_tasks, error).await);
                        }
                    };
                    Ok((status, stdout, stderr))
                }
                Err(error) => Err(cleanup_command_failure(child, pipe_tasks, error).await),
            }
        }
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
mod tests {
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
            exec_ignore_errors_with_timeout("sh", &["-c", "sleep 2"], Duration::from_millis(50))
                .await;

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
        assert_timeout_kills_grandchild("(exec 1>&-; sleep 5; touch \"$2\") & echo $! > \"$1\"")
            .await;
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
}
