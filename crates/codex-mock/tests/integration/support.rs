use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Output, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt as _;

use codex_mock::find_session_file;
use serde_json::Value;

pub(crate) const BIN: &str = env!("CARGO_BIN_EXE_codex-mock");
const CLI_RUN_TIMEOUT: Duration = Duration::from_secs(10);
const CLI_RUN_KILL_TIMEOUT: Duration = Duration::from_secs(5);
const CHILD_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(1);

#[derive(Debug)]
pub(crate) struct RunOutput {
    pub(crate) events: Vec<Value>,
    pub(crate) status: i32,
    pub(crate) stderr: String,
}

pub(crate) struct ProcessGroupChild {
    child: Child,
    #[cfg(unix)]
    child_pid: u32,
}

impl ProcessGroupChild {
    pub(crate) fn spawn(command: &mut Command) -> std::io::Result<Self> {
        #[cfg(unix)]
        command.process_group(0);

        let child = command.spawn()?;
        #[cfg(unix)]
        let child_pid = child.id();
        Ok(Self {
            child,
            #[cfg(unix)]
            child_pid,
        })
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn id(&self) -> u32 {
        self.child_pid
    }

    pub(crate) fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin.take()
    }

    pub(crate) fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    pub(crate) fn wait_with_timeout(
        self,
        timeout: Duration,
        kill_timeout: Duration,
    ) -> ChildWaitOutcome {
        #[cfg(unix)]
        {
            wait_process_group_child_with_timeout(self, timeout, kill_timeout)
        }

        #[cfg(not(unix))]
        {
            wait_child_with_timeout(self.child, timeout, kill_timeout)
        }
    }
}

pub(crate) fn run(codex_home: &Path, args: &[&str]) -> std::io::Result<RunOutput> {
    let mut cmd = Command::new(BIN);
    cmd.env("CODEX_HOME", codex_home)
        .args(args)
        .stdin(Stdio::null());
    let output = output_with_timeout(cmd, args)?;

    let stdout = String::from_utf8(output.stdout)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let stderr = String::from_utf8(output.stderr)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut events = Vec::new();
    for line in stdout.lines() {
        if line.is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(line)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        events.push(v);
    }

    Ok(RunOutput {
        events,
        status: output.status.code().unwrap_or(-1),
        stderr,
    })
}

fn output_with_timeout(cmd: Command, args: &[&str]) -> std::io::Result<Output> {
    output_with_timeout_before_kill(cmd, args, CLI_RUN_TIMEOUT, CLI_RUN_KILL_TIMEOUT, |_| {})
}

fn output_with_timeout_before_kill(
    mut cmd: Command,
    args: &[&str],
    run_timeout: Duration,
    kill_timeout: Duration,
    before_kill: impl FnOnce(u32),
) -> std::io::Result<Output> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("codex-mock CLI stdout pipe missing"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| std::io::Error::other("codex-mock CLI stderr pipe missing"))?;
    let stdout_reader = OutputReader::spawn(stdout);
    let stderr_reader = OutputReader::spawn(stderr);
    let output_deadline = Instant::now() + run_timeout + kill_timeout;

    match wait_child_with_timeout_before_kill(child, run_timeout, kill_timeout, before_kill) {
        ChildWaitOutcome::Exited(status) => {
            collect_output(status, stdout_reader, stderr_reader, output_deadline)
        }
        ChildWaitOutcome::TimedOut(status) => {
            let output = collect_output(status, stdout_reader, stderr_reader, output_deadline)
                .map_err(|error| cli_run_timeout_error(args, run_timeout, None, Some(&error)))?;
            Err(cli_run_timeout_error(
                args,
                run_timeout,
                Some(&output),
                None,
            ))
        }
        ChildWaitOutcome::ReapTimedOut => Err(cli_run_timeout_error_after_kill(
            args,
            run_timeout,
            kill_timeout,
        )),
        ChildWaitOutcome::KillFailed(error) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!(
                "codex-mock CLI timed out after {run_timeout:?} and failed to kill the \
                 child: args={args:?}; error={error}"
            ),
        )),
        ChildWaitOutcome::ReapFailed(error) => {
            Err(cli_run_timeout_error(args, run_timeout, None, Some(&error)))
        }
        ChildWaitOutcome::CleanupFailed(error) => {
            Err(cli_run_timeout_error(args, run_timeout, None, Some(&error)))
        }
        ChildWaitOutcome::WaitFailed(error) => Err(std::io::Error::other(format!(
            "codex-mock CLI child wait failed: args={args:?}; error={error}"
        ))),
    }
}

fn cli_run_timeout_error(
    args: &[&str],
    run_timeout: Duration,
    output: Option<&Output>,
    cleanup_error: Option<&std::io::Error>,
) -> std::io::Error {
    let mut message = format!("codex-mock CLI timed out after {run_timeout:?}: args={args:?}");
    if let Some(output) = output {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        message.push_str(&format!(
            "; status={:?}; stdout={stdout:?}; stderr={stderr:?}",
            output.status
        ));
    }
    if let Some(error) = cleanup_error {
        message.push_str(&format!("; cleanup after timeout failed: {error}"));
    }
    std::io::Error::new(std::io::ErrorKind::TimedOut, message)
}

fn cli_run_timeout_error_after_kill(
    args: &[&str],
    run_timeout: Duration,
    kill_timeout: Duration,
) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        format!(
            "codex-mock CLI timed out after {run_timeout:?} and did not exit within \
             {kill_timeout:?} after SIGKILL: args={args:?}"
        ),
    )
}

pub(crate) enum ChildWaitOutcome {
    Exited(ExitStatus),
    TimedOut(ExitStatus),
    ReapTimedOut,
    KillFailed(std::io::Error),
    CleanupFailed(std::io::Error),
    ReapFailed(std::io::Error),
    WaitFailed(std::io::Error),
}

#[cfg(unix)]
fn wait_process_group_child_with_timeout(
    mut child: ProcessGroupChild,
    timeout: Duration,
    kill_timeout: Duration,
) -> ChildWaitOutcome {
    let deadline = Instant::now() + timeout;
    loop {
        match child_exited_without_reaping(child.child_pid) {
            Ok(true) => {
                let cleanup_result = kill_process_group(child.child_pid);
                let wait_result = child.child.wait();
                return match wait_result {
                    Ok(status) => match cleanup_result {
                        Ok(()) => ChildWaitOutcome::Exited(status),
                        Err(error) => ChildWaitOutcome::CleanupFailed(error),
                    },
                    Err(error) => ChildWaitOutcome::WaitFailed(error),
                };
            }
            Ok(false) => {}
            Err(error) => {
                spawn_child_reaper(child.child);
                return ChildWaitOutcome::WaitFailed(error);
            }
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        std::thread::sleep(remaining.min(CHILD_WAIT_POLL_INTERVAL));
    }

    let cleanup_result = kill_process_group(child.child_pid);
    let fallback_result = if cleanup_result.is_err() {
        child.child.kill()
    } else {
        Ok(())
    };
    let reaper_rx = spawn_child_reaper(child.child);
    if let Err(error) = cleanup_result {
        return match fallback_result {
            Ok(()) => ChildWaitOutcome::CleanupFailed(error),
            Err(fallback_error) => ChildWaitOutcome::CleanupFailed(std::io::Error::new(
                error.kind(),
                format!(
                    "kill app-server process group: {error}; direct-child fallback failed: \
                     {fallback_error}"
                ),
            )),
        };
    }

    match reaper_rx.recv_timeout(kill_timeout) {
        Ok(Ok(status)) => ChildWaitOutcome::TimedOut(status),
        Ok(Err(error)) => ChildWaitOutcome::ReapFailed(error),
        Err(mpsc::RecvTimeoutError::Timeout) => ChildWaitOutcome::ReapTimedOut,
        Err(mpsc::RecvTimeoutError::Disconnected) => ChildWaitOutcome::ReapFailed(
            std::io::Error::other("child reaper exited without status"),
        ),
    }
}

#[cfg(unix)]
fn child_exited_without_reaping(child_pid: u32) -> std::io::Result<bool> {
    let child_pid = libc::pid_t::try_from(child_pid).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "app-server child PID does not fit in pid_t",
        )
    })?;
    let child_wait_id = libc::id_t::try_from(child_pid).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "app-server child PID does not fit in id_t",
        )
    })?;

    loop {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        // SAFETY: this owner still retains the direct child. WNOWAIT observes
        // terminal state without releasing its PID/process-group identity.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                child_wait_id,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == 0 {
            // SAFETY: zero is valid for siginfo_t, and waitid may have updated
            // it. si_pid remains zero when WNOHANG observes no status.
            let info = unsafe { info.assume_init() };
            return Ok(unsafe { info.si_pid() } != 0);
        }

        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

#[cfg(unix)]
fn kill_process_group(child_pid: u32) -> std::io::Result<()> {
    let process_group = libc::pid_t::try_from(child_pid).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "app-server process-group ID does not fit in pid_t",
        )
    })?;
    if process_group <= 1 || process_group == unsafe { libc::getpgrp() } {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("refusing to signal app-server process group {process_group}"),
        ));
    }

    // SAFETY: ProcessGroupChild created this group with process_group(0), and
    // the unreaped group-leader child still reserves this numeric identity.
    if unsafe { libc::kill(-process_group, libc::SIGKILL) } == 0 {
        return Ok(());
    }

    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

pub(crate) fn wait_child_with_timeout(
    child: Child,
    timeout: Duration,
    kill_timeout: Duration,
) -> ChildWaitOutcome {
    wait_child_with_timeout_before_kill(child, timeout, kill_timeout, |_| {})
}

fn wait_child_with_timeout_before_kill(
    mut child: Child,
    timeout: Duration,
    kill_timeout: Duration,
    before_kill: impl FnOnce(u32),
) -> ChildWaitOutcome {
    // This function alone owns exit observation and signaling. The child only
    // moves to another waiter after signaling authority has been consumed.
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return ChildWaitOutcome::Exited(status),
            Ok(None) => {}
            Err(error) => {
                // A wait error can mean another actor reaped the child without
                // caching its status here, so a later numeric-PID kill is unsafe.
                spawn_child_reaper(child);
                return ChildWaitOutcome::WaitFailed(error);
            }
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        std::thread::sleep(remaining.min(CHILD_WAIT_POLL_INTERVAL));
    }

    before_kill(child.id());
    let kill_result = child.kill();
    let reaper_rx = spawn_child_reaper(child);
    if let Err(error) = kill_result {
        return ChildWaitOutcome::KillFailed(error);
    }

    match reaper_rx.recv_timeout(kill_timeout) {
        Ok(Ok(status)) => ChildWaitOutcome::TimedOut(status),
        Ok(Err(error)) => ChildWaitOutcome::ReapFailed(error),
        Err(mpsc::RecvTimeoutError::Timeout) => ChildWaitOutcome::ReapTimedOut,
        Err(mpsc::RecvTimeoutError::Disconnected) => ChildWaitOutcome::ReapFailed(
            std::io::Error::other("child reaper exited without status"),
        ),
    }
}

fn spawn_child_reaper(mut child: Child) -> Receiver<std::io::Result<ExitStatus>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait());
    });
    rx
}

struct OutputReader {
    rx: Receiver<std::io::Result<Vec<u8>>>,
}

impl OutputReader {
    fn spawn(mut pipe: impl Read + Send + 'static) -> Self {
        let (tx, rx) = mpsc::channel();
        let _ = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe.read_to_end(&mut bytes).map(|_| bytes);
            let _ = tx.send(result);
        });
        Self { rx }
    }

    fn finish(self, stream: &str, deadline: Instant) -> std::io::Result<Vec<u8>> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let result = match self.rx.recv_timeout(remaining) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("{stream} did not close before the child output deadline"),
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(std::io::Error::other(format!(
                    "{stream} reader exited without output"
                )));
            }
        };
        result.map_err(|error| {
            std::io::Error::new(error.kind(), format!("read child {stream}: {error}"))
        })
    }
}

fn collect_output(
    status: ExitStatus,
    stdout_reader: OutputReader,
    stderr_reader: OutputReader,
    deadline: Instant,
) -> std::io::Result<Output> {
    let stdout = stdout_reader.finish("stdout", deadline)?;
    let stderr = stderr_reader.finish("stderr", deadline)?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

pub(crate) fn require_session_file(codex_home: &Path) -> std::io::Result<PathBuf> {
    find_session_file(codex_home)?.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("session file not found under {codex_home:?}"),
        )
    })
}

#[cfg(unix)]
#[cfg(test)]
mod tests;
