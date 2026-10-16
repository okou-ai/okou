//! Bounded command capture and process-session retirement.

use crate::process_session::CommandSession;
use std::io;
use std::process::{Output, Stdio};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

const COMMAND_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);

pub async fn command_output_with_timeout(
    command: &mut Command,
    timeout: Duration,
    timeout_context: &str,
) -> io::Result<Output> {
    command_output_with_optional_stdin_timeout(command, None, timeout, timeout_context).await
}

pub async fn command_output_with_stdin_timeout(
    command: &mut Command,
    stdin: &[u8],
    timeout: Duration,
    timeout_context: &str,
) -> io::Result<Output> {
    command_output_with_optional_stdin_timeout(command, Some(stdin), timeout, timeout_context).await
}

async fn command_output_with_optional_stdin_timeout(
    command: &mut Command,
    stdin: Option<&[u8]>,
    timeout: Duration,
    timeout_context: &str,
) -> io::Result<Output> {
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    }
    CommandSession::configure(command);
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let session = CommandSession::from_child(&child)?;
    let (Some(mut stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return match terminate_command(&mut child, &session).await {
            Ok(_) => Err(io::Error::other(
                "captured child omitted its stdout or stderr pipe",
            )),
            Err(error) => Err(io::Error::other(format!(
                "captured child omitted its stdout or stderr pipe; cleanup failed: {error}"
            ))),
        };
    };
    let stdin = if let Some(stdin_bytes) = stdin {
        let Some(child_stdin) = child.stdin.take() else {
            return match terminate_command(&mut child, &session).await {
                Ok(_) => Err(io::Error::other(
                    "captured child omitted its configured stdin pipe",
                )),
                Err(error) => Err(io::Error::other(format!(
                    "captured child omitted its configured stdin pipe; cleanup failed: {error}"
                ))),
            };
        };
        Some((child_stdin, stdin_bytes))
    } else {
        None
    };
    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();

    let output = {
        let wait_with_output = async {
            let write_stdin = async move {
                if let Some((mut child_stdin, stdin_bytes)) = stdin {
                    child_stdin.write_all(stdin_bytes).await?;
                }
                Ok::<(), io::Error>(())
            };
            let (stdin_result, stdout_result, stderr_result) = tokio::join!(
                write_stdin,
                stdout.read_to_end(&mut stdout_bytes),
                stderr.read_to_end(&mut stderr_bytes),
            );
            session.wait_for_exit().await?;
            stdin_result?;
            stdout_result?;
            stderr_result?;
            Ok::<(), io::Error>(())
        };
        tokio::time::timeout(timeout, wait_with_output).await
    };

    let result = match output {
        Ok(result) => result,
        Err(_) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            timeout_context.to_string(),
        )),
    };
    // EOF can leave quiet descendants alive. Finalize every result while the
    // unreaped leader still reserves its SID; never scan that SID after reaping.
    let cleanup = terminate_command(&mut child, &session).await;
    match (result, cleanup) {
        (Ok(()), Ok(status)) => Ok(Output {
            status,
            stdout: stdout_bytes,
            stderr: stderr_bytes,
        }),
        (Err(error), Ok(_)) => Err(error),
        (Ok(()), Err(error)) => Err(io::Error::other(format!(
            "completed command cleanup failed: {error}"
        ))),
        (Err(error), Err(cleanup_error)) => Err(io::Error::other(format!(
            "{error}; command cleanup failed: {cleanup_error}"
        ))),
    }
}

async fn terminate_command(
    child: &mut tokio::process::Child,
    session: &CommandSession,
) -> Result<std::process::ExitStatus, String> {
    let direct_kill_error = child.start_kill().err();
    let deadline = tokio::time::Instant::now() + COMMAND_CLEANUP_TIMEOUT;
    let session_error = session
        .kill_members(deadline, COMMAND_CLEANUP_TIMEOUT)
        .await
        .err();
    let wait_result = wait_for_child_until(child, deadline).await;

    match (session_error, wait_result) {
        (None, Ok(status)) => Ok(status),
        (Some(session_error), Ok(status)) => Err(command_cleanup_error(
            direct_kill_error,
            Some(session_error),
            format!("killed child status: {status}"),
        )),
        (session_error, Err(wait_error)) => Err(command_cleanup_error(
            direct_kill_error,
            session_error,
            wait_error,
        )),
    }
}

async fn wait_for_child_until(
    child: &mut tokio::process::Child,
    deadline: tokio::time::Instant,
) -> Result<std::process::ExitStatus, String> {
    match child.try_wait() {
        Ok(Some(status)) => return Ok(status),
        Ok(None) => {}
        Err(error) => return Err(format!("wait after kill failed: {error}")),
    }

    match tokio::time::timeout_at(deadline, child.wait()).await {
        Ok(Ok(status)) => Ok(status),
        Ok(Err(error)) => Err(format!("wait after kill failed: {error}")),
        Err(_) => Err(format!(
            "wait after kill timed out after {}ms",
            COMMAND_CLEANUP_TIMEOUT.as_millis()
        )),
    }
}

fn command_cleanup_error(
    direct_kill_error: Option<io::Error>,
    session_error: Option<String>,
    wait_result: String,
) -> String {
    let mut errors = Vec::new();
    if let Some(direct_kill_error) = direct_kill_error {
        errors.push(format!("start kill failed: {direct_kill_error}"));
    }
    if let Some(session_error) = session_error {
        errors.push(format!("session cleanup failed: {session_error}"));
    }
    errors.push(wait_result);
    errors.join("; ")
}
