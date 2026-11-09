//! Dropping CLI execution must retire its actual stdin and stderr workers.
//! This single-test binary isolates the environment/CWD setup used by the CLI.

#![cfg(target_os = "linux")]

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{FileTypeExt, OpenOptionsExt, PermissionsExt};
use std::time::Duration;

use guest_agent::active_input::ActiveInputRuntime;
use guest_agent::masker::SecretMasker;
use guest_agent_tests as common;
use shell_quote::quote_shell_arg;
use tokio::io::Interest;
use tokio::io::unix::AsyncFd;

const IO_TIMEOUT: Duration = Duration::from_secs(5);

fn retain_pipe(pid: u32, descriptor: i32, write: bool) -> io::Result<AsyncFd<File>> {
    let file = OpenOptions::new()
        .read(!write)
        .write(write)
        .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(format!("/proc/{pid}/fd/{descriptor}"))?;
    if !file.metadata()?.file_type().is_fifo() {
        return Err(io::Error::other("CLI endpoint is not a pipe"));
    }
    // SAFETY: AsyncFd owns this File and its stable descriptor until Drop;
    // the test only borrows it for I/O and never closes or replaces it.
    Ok(unsafe { AsyncFd::register(file) }?)
}

async fn wait_for_stdin_eof(pipe: &AsyncFd<File>) -> io::Result<()> {
    loop {
        let mut ready = pipe.readable().await?;
        match ready.try_io(|inner| {
            let mut file = inner.get_ref();
            let mut byte = [0];
            match file.read(&mut byte)? {
                0 => Ok(()),
                _ => Err(io::Error::other("unexpected stdin after initial prompt")),
            }
        }) {
            Ok(result) => return result,
            Err(_would_block) => {}
        }
    }
}

async fn wait_for_stderr_closed(pipe: &AsyncFd<File>) -> io::Result<()> {
    let ready = pipe.ready(Interest::ERROR).await?;
    if !ready.ready().is_error() {
        return Err(io::Error::other(
            "stderr pipe did not report reader retirement",
        ));
    }
    let mut file = pipe.get_ref();
    match file.write(b"after cancellation\n") {
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Ok(()),
        Err(error) => Err(error),
        Ok(_) => Err(io::Error::other("stderr reader still accepts bytes")),
    }
}

#[tokio::test]
async fn dropping_cli_execution_retires_both_stdio_workers()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let ready_file = tmp.path().join("cli-ready");
    let mock = tmp.path().join("owned-stdio-claude");
    std::fs::write(
        &mock,
        format!(
            "#!/bin/sh\nset -eu\nIFS= read -r initial\nprintf '%s\\n' \"$$\" > {}\nexec cat >/dev/null\n",
            quote_shell_arg(&ready_file.to_string_lossy()),
        ),
    )?;
    let mut permissions = std::fs::metadata(&mock)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&mock, permissions)?;

    // This executable has one current-thread test and no workers before setup.
    unsafe {
        common::setup_env(&mock, tmp.path(), "hold initial prompt", 1, 1)?;
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let masker = SecretMasker::from_raw("");
    let active_input = ActiveInputRuntime::new_enabled(
        &runtime.config.run_id,
        &runtime.config.prompt,
        runtime.http.clone(),
    );
    let mut execution = Box::pin(common::execute_cli_with_active_input_for_runtime(
        &runtime,
        &masker,
        None,
        active_input.into_writer(),
    ));
    tokio::select! {
        result = &mut execution => panic!("CLI exited before pipe observation: {result:?}"),
        result = common::wait_for_file_contains(&ready_file, "\n", IO_TIMEOUT) => result?,
    }
    let pid: u32 = std::fs::read_to_string(&ready_file)?.trim().parse()?;
    assert!(pid > 1);
    // Retain the real opposite endpoints. The stderr writer models an inherited
    // descriptor without spawning another process or changing child cleanup.
    let stdin = retain_pipe(pid, libc::STDIN_FILENO, false)?;
    let stderr = retain_pipe(pid, libc::STDERR_FILENO, true)?;
    drop(execution);

    let (stdin_retired, stderr_retired) = tokio::join!(
        tokio::time::timeout(IO_TIMEOUT, wait_for_stdin_eof(&stdin)),
        tokio::time::timeout(IO_TIMEOUT, wait_for_stderr_closed(&stderr)),
    );
    assert!(
        matches!(&stdin_retired, Ok(Ok(()))) && matches!(&stderr_retired, Ok(Ok(()))),
        "dropped execution retained stdio workers: stdin_timeout={} stderr_timeout={} stdin={stdin_retired:?} stderr={stderr_retired:?}",
        stdin_retired.is_err(),
        stderr_retired.is_err(),
    );
    Ok(())
}
