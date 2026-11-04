use std::io::{self, BufWriter};

use super::*;

fn exec_result(termination: ExecTermination) -> RemoteExecResult {
    RemoteExecResult {
        termination,
        stdout: b"\0\xfeoutput".to_vec(),
        stderr: b"\xff\0guest stderr".to_vec(),
        diagnostic: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    }
}

async fn run_result(
    result: RemoteExecResult,
    show_diagnostic: bool,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
) -> ExitCode {
    let control = MockSandboxControl::new("/tmp");
    control.push_exec_remote_result(Ok(result));
    let mut args = make_args("test-id", "command");
    args.show_diagnostic = show_diagnostic;
    run_exec_with_writers(args, &control, stdout, stderr)
        .await
        .unwrap()
}

struct FailingWriter {
    bytes: Vec<u8>,
    remaining: usize,
    fail_flush: bool,
    recover: bool,
}

impl FailingWriter {
    fn after(remaining: usize) -> Self {
        Self {
            bytes: Vec::new(),
            remaining,
            fail_flush: false,
            recover: false,
        }
    }
}

impl Write for FailingWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            if self.recover {
                self.remaining = usize::MAX;
            }
            // Arbitrary writer error text must not reach the host diagnostic.
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "x".repeat(4096)));
        }
        let written = bytes.len().min(self.remaining);
        self.bytes.extend_from_slice(&bytes[..written]);
        self.remaining -= written;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.fail_flush {
            Err(io::ErrorKind::StorageFull.into())
        } else {
            Ok(())
        }
    }
}

fn delivery_diagnostic(stream: &str, kind: io::ErrorKind) -> String {
    format!("error: failed to deliver exec {stream}: {kind}\n")
}

#[tokio::test]
async fn stdout_failure_attempts_stderr_and_preserves_primary_exit_status() {
    for (termination, expected_exit) in [
        (ExecTermination::Exited { exit_code: 0 }, 1),
        (ExecTermination::Exited { exit_code: 42 }, 42),
        (ExecTermination::TimedOut, 124),
        (ExecTermination::Cancelled, 1),
        (ExecTermination::StartFailed, 1),
        (ExecTermination::WaitFailed, 1),
        (ExecTermination::Exited { exit_code: 256 }, 1),
        (ExecTermination::Exited { exit_code: -1 }, 255),
    ] {
        for remaining in [0, 2] {
            let result = exec_result(termination);
            let mut expected_stderr = result.stderr.clone();
            expected_stderr.push(b'\n');
            expected_stderr.extend_from_slice(
                delivery_diagnostic("stdout", io::ErrorKind::BrokenPipe).as_bytes(),
            );
            let mut stdout = FailingWriter::after(remaining);
            let mut stderr = Vec::new();

            let exit = run_result(result, false, &mut stdout, &mut stderr).await;

            assert_eq!(exit, ExitCode::from(expected_exit), "{termination:?}");
            assert_eq!(stdout.bytes, &b"\0\xfeoutput"[..remaining]);
            assert_eq!(stderr, expected_stderr);
        }
    }
}

#[tokio::test]
async fn stderr_failure_preserves_stdout_and_fails_successful_guest() {
    for remaining in [0, 2] {
        let result = exec_result(ExecTermination::Exited { exit_code: 0 });
        let mut stdout = Vec::new();
        let mut stderr = FailingWriter::after(remaining);

        let exit = run_result(result, false, &mut stdout, &mut stderr).await;

        assert_eq!(exit, ExitCode::FAILURE);
        assert_eq!(stdout, b"\0\xfeoutput");
        assert_eq!(stderr.bytes, &b"\xff\0guest stderr"[..remaining]);
    }
}

#[tokio::test]
async fn both_broken_channels_still_return_failure() {
    let result = exec_result(ExecTermination::Exited { exit_code: 0 });
    let mut stdout = FailingWriter::after(2);
    let mut stderr = FailingWriter::after(2);

    let exit = run_result(result, false, &mut stdout, &mut stderr).await;

    assert_eq!(exit, ExitCode::FAILURE);
    assert_eq!(stdout.bytes, b"\0\xfe");
    assert_eq!(stderr.bytes, b"\xff\0");
}

#[tokio::test]
async fn simultaneous_output_failures_report_stdout_once_when_stderr_recovers() {
    let result = exec_result(ExecTermination::Exited { exit_code: 0 });
    let mut stdout = FailingWriter::after(0);
    let mut stderr = FailingWriter {
        recover: true,
        ..FailingWriter::after(2)
    };

    let exit = run_result(result, false, &mut stdout, &mut stderr).await;

    assert_eq!(exit, ExitCode::FAILURE);
    let mut expected = b"\xff\0\n".to_vec();
    expected.extend_from_slice(delivery_diagnostic("stdout", io::ErrorKind::BrokenPipe).as_bytes());
    assert_eq!(stderr.bytes, expected);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn dev_full_stdout_fails_the_command() {
    let result = exec_result(ExecTermination::Exited { exit_code: 0 });
    let mut expected_stderr = result.stderr.clone();
    expected_stderr.push(b'\n');
    expected_stderr
        .extend_from_slice(delivery_diagnostic("stdout", io::ErrorKind::StorageFull).as_bytes());
    let mut stdout = std::fs::OpenOptions::new()
        .write(true)
        .open("/dev/full")
        .unwrap();
    let mut stderr = Vec::new();

    let exit = run_result(result, false, &mut stdout, &mut stderr).await;

    assert_eq!(exit, ExitCode::FAILURE);
    assert_eq!(stderr, expected_stderr);
}

#[tokio::test]
async fn buffered_unterminated_output_is_delivered_before_success() {
    let result = exec_result(ExecTermination::Exited { exit_code: 0 });
    let mut stdout = BufWriter::new(Vec::new());
    let mut stderr = BufWriter::new(Vec::new());

    let exit = run_result(result, false, &mut stdout, &mut stderr).await;

    assert_eq!(exit, ExitCode::SUCCESS);
    assert_eq!(stdout.get_ref(), b"\0\xfeoutput");
    assert_eq!(stderr.get_ref(), b"\xff\0guest stderr");
}

#[tokio::test]
async fn deferred_buffered_write_failures_fail_the_command() {
    for fail_stdout in [true, false] {
        let result = exec_result(ExecTermination::Exited { exit_code: 0 });
        let mut failing = BufWriter::new(FailingWriter::after(0));
        let mut healthy = Vec::new();

        let exit = if fail_stdout {
            run_result(result, false, &mut failing, &mut healthy).await
        } else {
            run_result(result, false, &mut healthy, &mut failing).await
        };

        assert_eq!(exit, ExitCode::FAILURE, "stdout failed: {fail_stdout}");
        if fail_stdout {
            let mut expected = b"\xff\0guest stderr\n".to_vec();
            expected.extend_from_slice(
                delivery_diagnostic("stdout", io::ErrorKind::BrokenPipe).as_bytes(),
            );
            assert_eq!(healthy, expected);
        } else {
            assert_eq!(healthy, b"\0\xfeoutput");
        }
    }
}

#[tokio::test]
async fn explicit_flush_failures_fail_the_command() {
    for fail_stdout in [true, false] {
        let result = exec_result(ExecTermination::Exited { exit_code: 0 });
        let mut failing = FailingWriter {
            fail_flush: true,
            ..FailingWriter::after(usize::MAX)
        };
        let mut healthy = Vec::new();

        let exit = if fail_stdout {
            run_result(result, false, &mut failing, &mut healthy).await
        } else {
            run_result(result, false, &mut healthy, &mut failing).await
        };

        assert_eq!(exit, ExitCode::FAILURE, "stdout failed: {fail_stdout}");
        let mut expected_stderr = b"\xff\0guest stderr\n".to_vec();
        expected_stderr.extend_from_slice(
            delivery_diagnostic(
                if fail_stdout { "stdout" } else { "stderr" },
                io::ErrorKind::StorageFull,
            )
            .as_bytes(),
        );
        if fail_stdout {
            assert_eq!(failing.bytes, b"\0\xfeoutput");
            assert_eq!(healthy, expected_stderr);
        } else {
            assert_eq!(healthy, b"\0\xfeoutput");
            assert_eq!(failing.bytes, expected_stderr);
        }
    }
}

#[tokio::test]
async fn generated_stderr_write_failures_are_observable() {
    let success = ExecTermination::Exited { exit_code: 0 };
    for (termination, raw, show, stdout_truncated, stderr_truncated, remaining, expected_exit) in [
        (success, "", true, false, false, 0, 1),
        (success, "clue", true, false, false, 4, 1),
        (success, "clue\n", true, false, false, 5, 1),
        (success, "clue", false, true, false, 4, 1),
        (success, "", false, true, false, 0, 1),
        (success, "", false, false, true, 0, 1),
        (
            success,
            "",
            false,
            true,
            true,
            REMOTE_EXEC_STDOUT_TRUNCATED_WARNING.len() + 1,
            1,
        ),
        (ExecTermination::TimedOut, "", false, false, false, 0, 124),
        (ExecTermination::Cancelled, "", false, false, false, 0, 1),
        (ExecTermination::StartFailed, "", false, false, false, 0, 1),
        (
            ExecTermination::WaitFailed,
            "clue",
            false,
            false,
            false,
            4,
            1,
        ),
    ] {
        let result = RemoteExecResult {
            stderr: raw.as_bytes().to_vec(),
            diagnostic: "terminal diagnostic".into(),
            stdout_truncated,
            stderr_truncated,
            ..exec_result(termination)
        };
        let mut stdout = Vec::new();
        // A usable error channel remains after one failed write. The command
        // must report the failure without replaying the omitted guest text.
        let mut stderr = FailingWriter {
            recover: true,
            ..FailingWriter::after(remaining)
        };

        let exit = run_result(result, show, &mut stdout, &mut stderr).await;

        assert_eq!(exit, ExitCode::from(expected_exit), "{termination:?}");
        assert_eq!(stdout, b"\0\xfeoutput");
        let diagnostic = delivery_diagnostic("stderr", io::ErrorKind::BrokenPipe);
        assert!(stderr.bytes.ends_with(diagnostic.as_bytes()));
        assert!(stderr.bytes.len() <= remaining + 1 + diagnostic.len());
    }
}

#[tokio::test]
async fn remote_error_flushes_its_message_and_preserves_failure() {
    for remaining in [usize::MAX, 0] {
        let control = MockSandboxControl::new("/tmp");
        control.push_exec_remote_result(Err(SandboxControlError::Remote("command failed".into())));
        let mut stdout = Vec::new();
        let mut stderr = BufWriter::new(FailingWriter::after(remaining));

        let exit = run_exec_with_writers(
            make_args("test-id", "command"),
            &control,
            &mut stdout,
            &mut stderr,
        )
        .await
        .unwrap();

        assert_eq!(exit, ExitCode::FAILURE);
        assert!(stdout.is_empty());
        if remaining != 0 {
            assert_eq!(stderr.get_ref().bytes, b"error: command failed\n");
        }
    }
}
