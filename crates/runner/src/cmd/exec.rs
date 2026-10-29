//! Execute a command inside a running sandbox for live debugging.

use std::io::Write;
use std::process::ExitCode;
use std::time::Duration;

use clap::Args;
use sandbox::{
    ExecTermination, RemoteExecResult, SandboxControl, SandboxControlError, SandboxControlTarget,
};
use shell_quote::quote_shell_arg;

use crate::error::{RunnerError, RunnerResult};
use crate::run_resolution;
use runner_host::paths::HomePaths;

use super::terminal_diagnostic::write_terminal_diagnostic;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

/// Arguments for executing a command inside an already-running sandbox.
///
/// The target is selected with either `--run` or `--sandbox`. Command arguments
/// after `--` are preserved as argv entries before being quoted for guest-side
/// shell execution.
#[derive(Args)]
#[command(group = clap::ArgGroup::new("target").required(true))]
pub struct ExecArgs {
    /// Target by run ID (full UUID or prefix) — resolved to a sandbox
    /// via status.json. Use this when you have a job ID from the
    /// dashboard.
    #[arg(long, group = "target")]
    run: Option<String>,

    /// Target by sandbox ID (full UUID or prefix) — used directly as
    /// the socket directory name. Visible in `runner doctor` output.
    #[arg(long, group = "target")]
    sandbox: Option<String>,

    /// Timeout in seconds for the command
    #[arg(long, default_value = "30")]
    timeout: u32,

    /// Run the command with sudo inside the sandbox
    #[arg(long)]
    sudo: bool,

    /// Print the guest terminal diagnostic for ordinary process exits
    #[arg(long)]
    show_diagnostic: bool,

    /// Command to execute inside the sandbox (after `--`).
    ///
    /// Arguments are preserved as argv — pipes, redirects, globs, and
    /// variable expansion must be invoked explicitly via a shell:
    ///
    /// ```text
    /// runner exec --sandbox <id> -- sh -c 'ls /tmp | wc -l'
    /// ```
    #[arg(last = true, required = true)]
    command: Vec<String>,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Executes the requested command inside a running sandbox.
///
/// `--sandbox` targets are used directly as sandbox identifiers. `--run`
/// targets are resolved through trusted live runner status before
/// dispatching to [`SandboxControl::exec_remote`].
///
/// Guest stdout and stderr are forwarded to local stdout and stderr. The
/// structured guest terminal state is converted to a local [`ExitCode`] at this
/// CLI boundary; ordinary process exit codes are truncated to `u8`, matching
/// shell behavior for values outside the 0-255 range.
///
/// [`SandboxControlError::Remote`] values are printed to stderr and returned
/// as [`ExitCode::FAILURE`]. Other sandbox-control errors are propagated as
/// [`RunnerError::Config`].
pub async fn run_exec(args: ExecArgs, control: &dyn SandboxControl) -> RunnerResult<ExitCode> {
    let mut stdout = std::io::stdout();
    let mut stderr = std::io::stderr();
    run_exec_with_writers(args, control, &mut stdout, &mut stderr).await
}

async fn run_exec_with_writers(
    args: ExecArgs,
    control: &dyn SandboxControl,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
) -> RunnerResult<ExitCode> {
    let home = HomePaths::new()?;
    run_exec_with_home_and_writers(args, control, &home, stdout, stderr).await
}

async fn run_exec_with_home_and_writers(
    args: ExecArgs,
    control: &dyn SandboxControl,
    home: &HomePaths,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
) -> RunnerResult<ExitCode> {
    let target = if let Some(ref sid) = args.sandbox {
        SandboxControlTarget::sandbox(sid)
    } else if let Some(ref rid) = args.run {
        let mappings = run_resolution::collect_active_run_mappings_from_home(home).await?;
        let mapping = run_resolution::resolve_run_mapping(rid, &mappings)?;
        SandboxControlTarget::run(mapping.run_id, mapping.sandbox_id)
    } else {
        // clap group guarantees one is set — this branch is unreachable.
        return Err(RunnerError::Config(
            "one of --run or --sandbox is required".into(),
        ));
    };

    let command = args
        .command
        .iter()
        .map(|a| quote_shell_arg(a))
        .collect::<Vec<_>>()
        .join(" ");
    let timeout = Duration::from_secs(u64::from(args.timeout));

    match control
        .exec_remote(target, &command, timeout, args.sudo)
        .await
    {
        Ok(result) => {
            let _ = stdout.write_all(&result.stdout);
            write_remote_exec_stderr(stderr, &result, args.show_diagnostic);

            Ok(remote_exec_exit_code(result.termination))
        }
        Err(SandboxControlError::Remote(msg)) => {
            let _ = writeln!(stderr, "error: {msg}");
            Ok(ExitCode::FAILURE)
        }
        Err(e) => Err(RunnerError::Config(e.to_string())),
    }
}

const REMOTE_EXEC_TIMEOUT_EXIT_CODE: u8 = 124;
const REMOTE_EXEC_STDOUT_TRUNCATED_WARNING: &str = "warning: remote stdout was truncated by the sandbox capture limit; use a narrower command or redirect output inside the guest";
const REMOTE_EXEC_STDERR_TRUNCATED_WARNING: &str = "warning: remote stderr was truncated by the sandbox capture limit; use a narrower command or redirect output inside the guest";

fn remote_exec_exit_code(termination: ExecTermination) -> ExitCode {
    match termination {
        ExecTermination::Exited { exit_code } => ExitCode::from(exit_code as u8),
        ExecTermination::TimedOut => ExitCode::from(REMOTE_EXEC_TIMEOUT_EXIT_CODE),
        ExecTermination::Cancelled | ExecTermination::StartFailed | ExecTermination::WaitFailed => {
            ExitCode::FAILURE
        }
    }
}

fn write_remote_exec_stderr(
    stderr: &mut impl Write,
    result: &RemoteExecResult,
    show_diagnostic: bool,
) {
    let _ = stderr.write_all(&result.stderr);
    let mut line_open = !result.stderr.is_empty() && !result.stderr.ends_with(b"\n");

    write_terminal_diagnostic(
        stderr,
        &result.termination,
        &result.stderr,
        &result.diagnostic,
        show_diagnostic,
        &mut line_open,
    );
    if result.stdout_truncated {
        write_remote_exec_warning(stderr, &mut line_open, REMOTE_EXEC_STDOUT_TRUNCATED_WARNING);
    }
    if result.stderr_truncated {
        write_remote_exec_warning(stderr, &mut line_open, REMOTE_EXEC_STDERR_TRUNCATED_WARNING);
    }
}

fn write_remote_exec_warning(stderr: &mut impl Write, line_open: &mut bool, message: &str) {
    if *line_open {
        let _ = writeln!(stderr);
        *line_open = false;
    }

    let _ = writeln!(stderr, "{message}");
}

#[cfg(test)]
mod tests;
