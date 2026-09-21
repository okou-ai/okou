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
use crate::paths::HomePaths;
use crate::run_resolution;

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

    write_remote_exec_terminal_diagnostic(stderr, result, show_diagnostic, &mut line_open);
    if result.stdout_truncated {
        write_remote_exec_warning(stderr, &mut line_open, REMOTE_EXEC_STDOUT_TRUNCATED_WARNING);
    }
    if result.stderr_truncated {
        write_remote_exec_warning(stderr, &mut line_open, REMOTE_EXEC_STDERR_TRUNCATED_WARNING);
    }
}

fn write_remote_exec_terminal_diagnostic(
    stderr: &mut impl Write,
    result: &RemoteExecResult,
    show_diagnostic: bool,
    line_open: &mut bool,
) {
    let (fallback, include_terminal_diagnostic) = match result.termination {
        ExecTermination::Exited { .. } => (None, false),
        ExecTermination::TimedOut => (Some("Timeout"), false),
        ExecTermination::Cancelled => (Some("Cancelled"), true),
        ExecTermination::StartFailed | ExecTermination::WaitFailed => (None, true),
    };
    let include_diagnostic = show_diagnostic || include_terminal_diagnostic;

    if result.stderr.is_empty() {
        if let Some(message) = fallback {
            let _ = writeln!(stderr, "{message}");
            *line_open = false;
        }
    } else if include_diagnostic && !result.diagnostic.is_empty() && *line_open {
        let _ = writeln!(stderr);
        *line_open = false;
    }

    if include_diagnostic && !result.diagnostic.is_empty() {
        let _ = writeln!(stderr, "{}", result.diagnostic);
        *line_open = false;
    }
}

fn write_remote_exec_warning(stderr: &mut impl Write, line_open: &mut bool, message: &str) {
    if *line_open {
        let _ = writeln!(stderr);
        *line_open = false;
    }

    let _ = writeln!(stderr, "{message}");
}

runner_test_group!(cmd_other; #[cfg(test)]
mod tests {
    use std::path::Path;

    use sandbox::SandboxControlError;
    use sandbox_mock::{MockSandboxControl, RemoteExecCall};

    use super::*;

    fn make_args(sandbox_id: &str, command: &str) -> ExecArgs {
        ExecArgs {
            run: None,
            sandbox: Some(sandbox_id.into()),
            timeout: 5,
            sudo: false,
            show_diagnostic: false,
            command: command.split_whitespace().map(String::from).collect(),
        }
    }

    fn make_args_vec(command: Vec<&str>) -> ExecArgs {
        ExecArgs {
            run: None,
            sandbox: Some("id".into()),
            timeout: 5,
            sudo: false,
            show_diagnostic: false,
            command: command.into_iter().map(String::from).collect(),
        }
    }

    fn assert_recorded_command(control: &MockSandboxControl, expected: &str) {
        let calls = control.recorded_exec_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].command, expected);
    }

    async fn publish_active_run(
        home: &HomePaths,
        base_dir: &Path,
        run_id: &str,
        sandbox_id: &str,
    ) -> crate::live_runner_instances::LiveRunnerInstanceHandle {
        std::fs::create_dir_all(base_dir).unwrap();
        std::fs::write(
            base_dir.join("status.json"),
            serde_json::to_vec(&serde_json::json!({
                "active_runs": [{
                    "run_id": run_id,
                    "sandbox_id": sandbox_id,
                }],
            }))
            .unwrap(),
        )
        .unwrap();
        crate::live_runner_instances::publish(
            home,
            crate::live_runner_instances::LiveRunnerInstanceMetadata {
                config_path: base_dir.join("runner.yaml"),
                base_dir: base_dir.to_path_buf(),
                runner_group: "vm0/test".into(),
                subcommand: "start".into(),
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn success_forwards_output_and_propagates_exit_code() {
        let control = MockSandboxControl::new("/tmp");
        control.push_exec_remote_result(Ok(RemoteExecResult {
            termination: ExecTermination::Exited { exit_code: 42 },
            stdout: b"command output\n".to_vec(),
            stderr: b"command warning\n".to_vec(),
            diagnostic: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        }));
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        let result = run_exec_with_writers(
            make_args("test-id", "echo hello"),
            &control,
            &mut stdout,
            &mut stderr,
        )
        .await
        .unwrap();

        assert_eq!(result, ExitCode::from(42));
        assert_eq!(stdout, b"command output\n");
        assert_eq!(stderr, b"command warning\n");
    }

    #[tokio::test]
    async fn zero_exit_code_returns_success() {
        let control = MockSandboxControl::new("/tmp");
        let result = run_exec(make_args("test-id", "true"), &control)
            .await
            .unwrap();
        assert_eq!(result, ExitCode::SUCCESS);
    }

    #[tokio::test]
    async fn forwards_direct_sandbox_target_and_exec_policy() {
        let control = MockSandboxControl::new("/tmp");
        let args = ExecArgs {
            run: None,
            sandbox: Some("direct-sandbox".into()),
            timeout: 47,
            sudo: true,
            show_diagnostic: false,
            command: vec!["echo".into(), "hello world".into()],
        };

        let result = run_exec(args, &control).await.unwrap();

        assert_eq!(result, ExitCode::SUCCESS);
        assert_eq!(
            control.recorded_exec_calls(),
            vec![RemoteExecCall {
                target: SandboxControlTarget::sandbox("direct-sandbox"),
                command: "'echo' 'hello world'".to_string(),
                timeout: Duration::from_secs(47),
                sudo: true,
            }],
        );
    }

    #[tokio::test]
    async fn resolves_run_prefix_and_forwards_full_identity_and_exec_policy() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let run_id = "run-abcdef-full";
        let sandbox_id = "sandbox-123";
        let handle =
            publish_active_run(&home, &dir.path().join("runner-base"), run_id, sandbox_id).await;
        let control = MockSandboxControl::new("/tmp");
        let args = ExecArgs {
            run: Some("run-abc".into()),
            sandbox: None,
            timeout: 47,
            sudo: true,
            show_diagnostic: false,
            command: vec!["echo".into(), "hello world".into()],
        };
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        let result =
            run_exec_with_home_and_writers(args, &control, &home, &mut stdout, &mut stderr)
                .await
                .unwrap();
        assert!(handle.remove_if_current().await.unwrap());

        assert_eq!(result, ExitCode::SUCCESS);
        assert_eq!(
            control.recorded_exec_calls(),
            vec![RemoteExecCall {
                target: SandboxControlTarget::run(run_id, sandbox_id),
                command: "'echo' 'hello world'".to_string(),
                timeout: Duration::from_secs(47),
                sudo: true,
            }],
        );
    }

    #[tokio::test]
    async fn run_resolution_failure_does_not_dispatch_exec() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let handle = publish_active_run(
            &home,
            &dir.path().join("runner-base"),
            "run-abcdef-full",
            "sandbox-123",
        )
        .await;
        let control = MockSandboxControl::new("/tmp");
        let args = ExecArgs {
            run: Some("missing".into()),
            sandbox: None,
            timeout: 5,
            sudo: false,
            show_diagnostic: false,
            command: vec!["true".into()],
        };
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        let error = run_exec_with_home_and_writers(args, &control, &home, &mut stdout, &mut stderr)
            .await
            .unwrap_err();
        assert!(handle.remove_if_current().await.unwrap());

        assert!(matches!(
            error,
            RunnerError::Config(message) if message == "no active run matches 'missing'"
        ));
        assert!(control.recorded_exec_calls().is_empty());
    }

    #[tokio::test]
    async fn remote_error_prints_message_and_returns_failure() {
        let control = MockSandboxControl::new("/tmp");
        control.push_exec_remote_result(Err(SandboxControlError::Remote("command failed".into())));
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        let result = run_exec_with_writers(
            make_args("test-id", "fail"),
            &control,
            &mut stdout,
            &mut stderr,
        )
        .await
        .unwrap();

        assert_eq!(result, ExitCode::FAILURE);
        assert!(stdout.is_empty());
        assert_eq!(stderr, b"error: command failed\n");
    }

    #[tokio::test]
    async fn not_found_error_propagates_as_runner_error() {
        let control = MockSandboxControl::new("/tmp");
        control
            .push_exec_remote_result(Err(SandboxControlError::NotFound("no such sandbox".into())));

        let result = run_exec(make_args("missing", "test"), &control).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn connection_error_propagates_as_runner_error() {
        let control = MockSandboxControl::new("/tmp");
        control.push_exec_remote_result(Err(SandboxControlError::Connection("refused".into())));

        let result = run_exec(make_args("test-id", "test"), &control).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn exit_code_truncated_to_u8() {
        let control = MockSandboxControl::new("/tmp");
        // 256 truncates to 0 via `as u8`
        control.push_exec_remote_result(Ok(RemoteExecResult {
            termination: ExecTermination::Exited { exit_code: 256 },
            stdout: Vec::new(),
            stderr: Vec::new(),
            diagnostic: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        }));
        // -1 (0xFFFFFFFF) truncates to 255 via `as u8`
        control.push_exec_remote_result(Ok(RemoteExecResult {
            termination: ExecTermination::Exited { exit_code: -1 },
            stdout: Vec::new(),
            stderr: Vec::new(),
            diagnostic: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        }));

        let r1 = run_exec(make_args("id", "test"), &control).await.unwrap();
        assert_eq!(r1, ExitCode::from(0));

        let r2 = run_exec(make_args("id", "test"), &control).await.unwrap();
        assert_eq!(r2, ExitCode::from(255));
    }

    #[test]
    fn non_exited_terminations_map_to_cli_exit_codes() {
        assert_eq!(
            remote_exec_exit_code(ExecTermination::TimedOut),
            ExitCode::from(REMOTE_EXEC_TIMEOUT_EXIT_CODE)
        );
        assert_eq!(
            remote_exec_exit_code(ExecTermination::Cancelled),
            ExitCode::FAILURE
        );
        assert_eq!(
            remote_exec_exit_code(ExecTermination::StartFailed),
            ExitCode::FAILURE
        );
        assert_eq!(
            remote_exec_exit_code(ExecTermination::WaitFailed),
            ExitCode::FAILURE
        );
    }

    #[test]
    fn terminal_diagnostic_starts_on_new_line_after_stderr() {
        let result = RemoteExecResult {
            termination: ExecTermination::WaitFailed,
            stdout: Vec::new(),
            stderr: b"stderr clue".to_vec(),
            diagnostic: "wait failed".into(),
            stdout_truncated: false,
            stderr_truncated: false,
        };
        let mut stderr = Vec::new();

        write_remote_exec_stderr(&mut stderr, &result, false);

        assert_eq!(stderr, b"stderr clue\nwait failed\n");
    }

    #[test]
    fn terminal_fallback_is_not_added_when_stderr_has_content() {
        let result = RemoteExecResult {
            termination: ExecTermination::TimedOut,
            stdout: Vec::new(),
            stderr: b"stderr clue".to_vec(),
            diagnostic: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        };
        let mut stderr = Vec::new();

        write_remote_exec_stderr(&mut stderr, &result, false);

        assert_eq!(stderr, b"stderr clue");
    }

    #[test]
    fn terminal_fallback_is_added_when_stderr_is_empty() {
        let result = RemoteExecResult {
            termination: ExecTermination::Cancelled,
            stdout: Vec::new(),
            stderr: Vec::new(),
            diagnostic: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        };
        let mut stderr = Vec::new();

        write_remote_exec_stderr(&mut stderr, &result, false);

        assert_eq!(stderr, b"Cancelled\n");
    }

    #[test]
    fn terminal_diagnostic_keeps_fallback_when_stderr_is_empty() {
        let result = RemoteExecResult {
            termination: ExecTermination::Cancelled,
            stdout: Vec::new(),
            stderr: Vec::new(),
            diagnostic: "cancel diagnostic".into(),
            stdout_truncated: false,
            stderr_truncated: false,
        };
        let mut stderr = Vec::new();

        write_remote_exec_stderr(&mut stderr, &result, false);

        assert_eq!(stderr, b"Cancelled\ncancel diagnostic\n");
    }

    #[test]
    fn terminal_timeout_diagnostic_preserves_legacy_timeout_display() {
        let result = RemoteExecResult {
            termination: ExecTermination::TimedOut,
            stdout: Vec::new(),
            stderr: Vec::new(),
            diagnostic: "timeout diagnostic".into(),
            stdout_truncated: false,
            stderr_truncated: false,
        };
        let mut stderr = Vec::new();

        write_remote_exec_stderr(&mut stderr, &result, false);

        assert_eq!(stderr, b"Timeout\n");
    }

    #[test]
    fn successful_terminal_diagnostic_is_opt_in() {
        let result = RemoteExecResult {
            termination: ExecTermination::Exited { exit_code: 0 },
            stdout: Vec::new(),
            stderr: Vec::new(),
            diagnostic: "containment evidence".into(),
            stdout_truncated: false,
            stderr_truncated: false,
        };
        let mut default_stderr = Vec::new();
        let mut diagnostic_stderr = Vec::new();

        write_remote_exec_stderr(&mut default_stderr, &result, false);
        write_remote_exec_stderr(&mut diagnostic_stderr, &result, true);

        assert!(default_stderr.is_empty());
        assert_eq!(diagnostic_stderr, b"containment evidence\n");
    }

    #[test]
    fn terminal_warning_starts_on_new_line_after_stderr() {
        let result = RemoteExecResult {
            termination: ExecTermination::Exited { exit_code: 0 },
            stdout: Vec::new(),
            stderr: b"stderr clue".to_vec(),
            diagnostic: String::new(),
            stdout_truncated: true,
            stderr_truncated: false,
        };
        let mut stderr = Vec::new();

        write_remote_exec_stderr(&mut stderr, &result, false);

        assert_eq!(
            stderr,
            format!("stderr clue\n{REMOTE_EXEC_STDOUT_TRUNCATED_WARNING}\n").into_bytes()
        );
    }

    #[test]
    fn terminal_warning_follows_diagnostic_without_extra_blank_line() {
        let result = RemoteExecResult {
            termination: ExecTermination::WaitFailed,
            stdout: Vec::new(),
            stderr: b"stderr clue".to_vec(),
            diagnostic: "wait failed".into(),
            stdout_truncated: true,
            stderr_truncated: false,
        };
        let mut stderr = Vec::new();

        write_remote_exec_stderr(&mut stderr, &result, false);

        assert_eq!(
            stderr,
            format!("stderr clue\nwait failed\n{REMOTE_EXEC_STDOUT_TRUNCATED_WARNING}\n")
                .into_bytes()
        );
    }

    // ---- argument quoting -------------------------------------------------

    #[tokio::test]
    async fn safe_ascii_args_are_quoted() {
        let control = MockSandboxControl::new("/tmp");
        run_exec(make_args_vec(vec!["ls", "-la", "/var/log"]), &control)
            .await
            .unwrap();

        assert_recorded_command(&control, "'ls' '-la' '/var/log'");
    }

    #[tokio::test]
    async fn arg_with_space_is_quoted_as_single_token() {
        let control = MockSandboxControl::new("/tmp");
        run_exec(
            make_args_vec(vec!["cat", "/var/log/some file.log"]),
            &control,
        )
        .await
        .unwrap();

        assert_recorded_command(&control, "'cat' '/var/log/some file.log'");
    }

    #[tokio::test]
    async fn arg_with_single_quote_is_escaped() {
        let control = MockSandboxControl::new("/tmp");
        run_exec(make_args_vec(vec!["echo", "it's"]), &control)
            .await
            .unwrap();

        assert_recorded_command(&control, "'echo' 'it'\\''s'");
    }

    #[tokio::test]
    async fn pipeline_inside_quoted_arg_is_preserved() {
        let control = MockSandboxControl::new("/tmp");
        run_exec(
            make_args_vec(vec!["bash", "-c", "echo a | tr a b"]),
            &control,
        )
        .await
        .unwrap();

        assert_recorded_command(&control, "'bash' '-c' 'echo a | tr a b'");
    }

    #[tokio::test]
    async fn shell_metachar_in_arg_is_quoted() {
        let control = MockSandboxControl::new("/tmp");
        run_exec(make_args_vec(vec!["echo", "$HOME"]), &control)
            .await
            .unwrap();

        // `$` must be quoted so the guest shell does not expand it.
        assert_recorded_command(&control, "'echo' '$HOME'");
    }

    #[tokio::test]
    async fn command_separator_in_arg_is_quoted() {
        let control = MockSandboxControl::new("/tmp");
        run_exec(make_args_vec(vec!["echo", "ok; uname -a"]), &control)
            .await
            .unwrap();

        assert_recorded_command(&control, "'echo' 'ok; uname -a'");
    }

    #[tokio::test]
    async fn expansion_and_redirection_syntax_in_args_is_quoted() {
        let control = MockSandboxControl::new("/tmp");
        run_exec(
            make_args_vec(vec!["printf", "$(id)", "`id`", "*", "x > out"]),
            &control,
        )
        .await
        .unwrap();

        assert_recorded_command(&control, "'printf' '$(id)' '`id`' '*' 'x > out'");
    }

    #[tokio::test]
    async fn empty_arg_is_quoted() {
        let control = MockSandboxControl::new("/tmp");
        run_exec(make_args_vec(vec!["echo", ""]), &control)
            .await
            .unwrap();

        assert_recorded_command(&control, "'echo' ''");
    }

    #[tokio::test]
    async fn assignment_syntax_arg_is_quoted() {
        let control = MockSandboxControl::new("/tmp");
        run_exec(make_args_vec(vec!["FOO=bar", "env"]), &control)
            .await
            .unwrap();

        // `FOO=bar` must be quoted so the guest shell treats it as a command
        // name instead of a variable assignment.
        assert_recorded_command(&control, "'FOO=bar' 'env'");
    }

    #[tokio::test]
    async fn reserved_word_command_name_is_quoted() {
        let control = MockSandboxControl::new("/tmp");
        run_exec(make_args_vec(vec!["if"]), &control).await.unwrap();

        assert_recorded_command(&control, "'if'");
    }
});
