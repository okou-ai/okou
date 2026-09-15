//! Timed child output collection must own the child through cleanup.

mod common;

use std::io::{self, Write};
use std::os::fd::OwnedFd;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command as StdCommand, Stdio};
use std::time::{Duration, Instant};
use tokio::io::unix::AsyncFd;
use tokio::process::Command;

const MANAGED_TIMEOUT: Duration = Duration::from_secs(20);
const FIXTURE_READY_TIMEOUT: Duration = Duration::from_secs(5);
const FIXTURE_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
const DESCENDANT_EXIT_TIMEOUT: Duration = Duration::from_secs(1);
const DESCENDANT_READY_ENV: &str = "OKOU_TEST_DESCENDANT_READY_FILE";
const DESCENDANT_RELEASE_ENV: &str = "OKOU_TEST_DESCENDANT_RELEASE_FILE";
const DESCENDANT_FIXTURE: &str = "command_output_timeout_descendant_fixture";
const QUIET_EXIT_CODE_ENV: &str = "OKOU_TEST_QUIET_EXIT_CODE";
const ECHO_STDIN_ENV: &str = "OKOU_TEST_ECHO_STDIN";
const STDIN_PAYLOAD: &[u8] = b"serialized request\n";

struct DescendantCleanup {
    pidfd: AsyncFd<OwnedFd>,
}

impl Drop for DescendantCleanup {
    fn drop(&mut self) {
        let _ =
            rustix::process::pidfd_send_signal(self.pidfd.get_ref(), rustix::process::Signal::KILL);
    }
}

#[test]
fn command_session_rejects_zero_session_id() {
    assert!(!common::process_session::session_id_matches_target(
        rustix::process::Pid::INIT,
        Ok(0),
    ));
}

#[tokio::test]
async fn command_output_timeout_preserves_completed_output()
-> Result<(), Box<dyn std::error::Error>> {
    let output = common::command_output_with_timeout(
        Command::new("/bin/sh")
            .arg("-c")
            .arg("printf 'captured stdout'; printf 'captured stderr' >&2; exit 7"),
        Duration::from_secs(5),
        "completed child exceeded its budget",
    )
    .await?;

    assert_eq!(output.status.code(), Some(7));
    assert_eq!(output.stdout, b"captured stdout");
    assert_eq!(output.stderr, b"captured stderr");
    Ok(())
}

#[tokio::test]
async fn command_output_with_stdin_timeout_writes_payload_and_eof()
-> Result<(), Box<dyn std::error::Error>> {
    let input = b"serialized request\n";
    let output = common::command_output_with_stdin_timeout(
        &mut Command::new("/bin/cat"),
        input,
        Duration::from_secs(5),
        "stdin echo exceeded its budget",
    )
    .await?;

    assert!(output.status.success());
    assert_eq!(output.stdout, input);
    assert!(output.stderr.is_empty());
    Ok(())
}

#[tokio::test]
async fn command_output_timeout_reaps_child_before_returning()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let pid_file = tmp.path().join("child.pid");
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg("printf '%s\n' \"$$\" > \"$OKOU_TEST_CHILD_PID_FILE\"; exec /bin/sleep 60")
        .env("OKOU_TEST_CHILD_PID_FILE", &pid_file);
    let execution = tokio::spawn(async move {
        common::command_output_with_timeout(
            &mut command,
            MANAGED_TIMEOUT,
            "long-lived child exceeded its budget",
        )
        .await
    });

    common::wait_for_file_contains(&pid_file, "\n", Duration::from_secs(5)).await?;
    let pid = std::fs::read_to_string(&pid_file)?.trim().parse::<u32>()?;
    let process_path = PathBuf::from(format!("/proc/{pid}"));
    assert!(
        process_path.exists(),
        "fixture child must be live before its timeout is advanced"
    );

    tokio::time::pause();
    tokio::time::advance(MANAGED_TIMEOUT).await;
    let join_result = execution.await;
    tokio::time::resume();
    let error = join_result?.expect_err("long-lived child should reach its managed timeout");

    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert_eq!(error.to_string(), "long-lived child exceeded its budget");
    assert!(
        !process_path.exists(),
        "timed-out child must be reaped before the helper returns"
    );
    Ok(())
}

#[tokio::test]
async fn command_output_timeout_terminates_separate_group_descendant()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let readiness_path = tmp.path().join("descendant-ready");
    let release_path = tmp.path().join("release-parent");
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("--ignored")
        .arg("--exact")
        .arg(DESCENDANT_FIXTURE)
        .arg("--nocapture")
        .env(DESCENDANT_READY_ENV, &readiness_path)
        .env(DESCENDANT_RELEASE_ENV, &release_path);
    let execution = tokio::spawn(async move {
        common::command_output_with_timeout(
            &mut command,
            MANAGED_TIMEOUT,
            "descendant-held output pipes exceeded their budget",
        )
        .await
    });

    common::wait_for_file_contains(&readiness_path, "\n", FIXTURE_READY_TIMEOUT).await?;
    let (parent_pid, descendant_pid) = read_fixture_pids(&readiness_path)?;
    let descendant = DescendantCleanup {
        pidfd: open_pidfd(descendant_pid)?,
    };
    let parent_pidfd = open_pidfd(parent_pid)?;
    let parent_rustix_pid = rustix_pid(parent_pid)?;
    let descendant_rustix_pid = rustix_pid(descendant_pid)?;
    assert_eq!(
        rustix::process::getsid(Some(parent_rustix_pid))?,
        parent_rustix_pid
    );
    assert_eq!(
        rustix::process::getpgid(Some(parent_rustix_pid))?,
        parent_rustix_pid
    );
    assert_eq!(
        rustix::process::getsid(Some(descendant_rustix_pid))?,
        parent_rustix_pid
    );
    assert_eq!(
        rustix::process::getpgid(Some(descendant_rustix_pid))?,
        descendant_rustix_pid
    );

    std::fs::write(&release_path, b"release\n")?;
    assert!(
        wait_for_pidfd_exit(&parent_pidfd, FIXTURE_EXIT_TIMEOUT).await?,
        "fixture parent {parent_pid} must exit before the managed deadline advances"
    );

    tokio::time::pause();
    tokio::time::advance(MANAGED_TIMEOUT).await;
    let join_result = execution.await;
    tokio::time::resume();

    let descendant_exited = wait_for_pidfd_exit(&descendant.pidfd, DESCENDANT_EXIT_TIMEOUT).await?;
    let error =
        join_result?.expect_err("descendant-held output pipes should reach the managed timeout");

    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert_eq!(
        error.to_string(),
        "descendant-held output pipes exceeded their budget"
    );
    assert!(
        descendant_exited,
        "separate-process-group descendant {descendant_pid} remained live after helper timeout"
    );
    Ok(())
}

#[test]
#[ignore = "subprocess fixture invoked by the descendant cleanup integration tests"]
fn command_output_timeout_descendant_fixture() -> Result<(), Box<dyn std::error::Error>> {
    let (Some(readiness_path), Some(release_path)) = (
        std::env::var_os(DESCENDANT_READY_ENV),
        std::env::var_os(DESCENDANT_RELEASE_ENV),
    ) else {
        return Ok(());
    };

    let quiet_exit_code = std::env::var(QUIET_EXIT_CODE_ENV)
        .ok()
        .map(|code| code.parse::<i32>())
        .transpose()?;
    let mut descendant = StdCommand::new("/bin/sleep")
        .arg("60")
        .stdin(Stdio::null())
        .stdout(if quiet_exit_code.is_some() {
            Stdio::null()
        } else {
            Stdio::inherit()
        })
        .stderr(if quiet_exit_code.is_some() {
            Stdio::null()
        } else {
            Stdio::inherit()
        })
        .process_group(0)
        .spawn()?;
    let descendant_pid = descendant.id();
    std::fs::write(
        &readiness_path,
        format!("{} {descendant_pid}\n", std::process::id()),
    )?;
    let release_path = PathBuf::from(release_path);
    let release_deadline = Instant::now() + FIXTURE_EXIT_TIMEOUT;
    while !release_path.exists() {
        if Instant::now() >= release_deadline {
            descendant.kill()?;
            descendant.wait()?;
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "timed out waiting to release descendant fixture parent",
            )
            .into());
        }
        std::thread::sleep(Duration::from_millis(1));
    }

    drop(descendant);
    if let Some(exit_code) = quiet_exit_code {
        if std::env::var_os(ECHO_STDIN_ENV).is_some() {
            io::copy(&mut io::stdin().lock(), &mut io::stdout().lock())?;
        }
        io::stdout().write_all(b"captured stdout")?;
        io::stderr().write_all(b"captured stderr")?;
        io::stdout().flush()?;
        io::stderr().flush()?;
        std::process::exit(exit_code);
    }
    Ok(())
}

#[tokio::test]
async fn completed_command_cleans_quiet_descendant_on_success()
-> Result<(), Box<dyn std::error::Error>> {
    check_quiet_descendant_cleanup(0, false).await
}

#[tokio::test]
async fn completed_command_cleans_quiet_descendant_on_failure()
-> Result<(), Box<dyn std::error::Error>> {
    check_quiet_descendant_cleanup(7, false).await
}

#[tokio::test]
async fn completed_stdin_command_cleans_quiet_descendant_on_success()
-> Result<(), Box<dyn std::error::Error>> {
    check_quiet_descendant_cleanup(0, true).await
}

#[tokio::test]
async fn completed_stdin_command_cleans_quiet_descendant_on_failure()
-> Result<(), Box<dyn std::error::Error>> {
    check_quiet_descendant_cleanup(7, true).await
}

async fn check_quiet_descendant_cleanup(
    exit_code: i32,
    with_stdin: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let readiness_path = tmp.path().join("descendant-ready");
    let release_path = tmp.path().join("release-parent");
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("--ignored")
        .arg("--exact")
        .arg(DESCENDANT_FIXTURE)
        .arg("--nocapture")
        .env(DESCENDANT_READY_ENV, &readiness_path)
        .env(DESCENDANT_RELEASE_ENV, &release_path)
        .env(QUIET_EXIT_CODE_ENV, exit_code.to_string());
    if with_stdin {
        command.env(ECHO_STDIN_ENV, "1");
    }
    let execution = tokio::spawn(async move {
        if with_stdin {
            common::command_output_with_stdin_timeout(
                &mut command,
                STDIN_PAYLOAD,
                MANAGED_TIMEOUT,
                "quiet descendant fixture exceeded its budget",
            )
            .await
        } else {
            common::command_output_with_timeout(
                &mut command,
                MANAGED_TIMEOUT,
                "quiet descendant fixture exceeded its budget",
            )
            .await
        }
    });

    common::wait_for_file_contains(&readiness_path, "\n", FIXTURE_READY_TIMEOUT).await?;
    let (parent_pid, descendant_pid) = read_fixture_pids(&readiness_path)?;
    let descendant = DescendantCleanup {
        pidfd: open_pidfd(descendant_pid)?,
    };
    let parent_pid = rustix_pid(parent_pid)?;
    let descendant_pid = rustix_pid(descendant_pid)?;
    assert_eq!(rustix::process::getsid(Some(parent_pid))?, parent_pid);
    assert_eq!(rustix::process::getpgid(Some(parent_pid))?, parent_pid);
    assert_eq!(rustix::process::getsid(Some(descendant_pid))?, parent_pid);
    assert_eq!(
        rustix::process::getpgid(Some(descendant_pid))?,
        descendant_pid
    );

    std::fs::write(&release_path, b"release\n")?;
    let output = execution.await??;
    // Query the kernel immediately: waiting here would allow cleanup after the
    // helper returns to incorrectly satisfy the ownership contract.
    let mut poll_fd =
        rustix::event::PollFd::new(descendant.pidfd.get_ref(), rustix::event::PollFlags::IN);
    rustix::event::poll(
        std::slice::from_mut(&mut poll_fd),
        Some(&rustix::event::Timespec::default()),
    )?;
    assert!(
        poll_fd.revents().contains(rustix::event::PollFlags::IN),
        "quiet descendant {descendant_pid} remained live after helper returned"
    );
    assert!(
        !PathBuf::from(format!("/proc/{parent_pid}")).exists(),
        "completed fixture parent must be reaped before the helper returns"
    );
    assert_eq!(output.status.code(), Some(exit_code));
    let mut expected_stdout = Vec::new();
    if with_stdin {
        expected_stdout.extend_from_slice(STDIN_PAYLOAD);
    }
    expected_stdout.extend_from_slice(b"captured stdout");
    // The self-executed libtest fixture also prints its own test-start banner.
    assert!(output.stdout.ends_with(&expected_stdout));
    assert_eq!(output.stderr, b"captured stderr");
    Ok(())
}

fn read_fixture_pids(path: &std::path::Path) -> io::Result<(u32, u32)> {
    let contents = std::fs::read_to_string(path)?;
    let mut fields = contents.split_whitespace();
    let parent_pid = fields
        .next()
        .ok_or_else(|| io::Error::other("descendant readiness omitted parent PID"))?
        .parse()
        .map_err(|error| io::Error::other(format!("parse fixture parent PID: {error}")))?;
    let descendant_pid = fields
        .next()
        .ok_or_else(|| io::Error::other("descendant readiness omitted descendant PID"))?
        .parse()
        .map_err(|error| io::Error::other(format!("parse fixture descendant PID: {error}")))?;
    if fields.next().is_some() {
        return Err(io::Error::other(
            "descendant readiness contained unexpected fields",
        ));
    }
    Ok((parent_pid, descendant_pid))
}

fn rustix_pid(pid: u32) -> io::Result<rustix::process::Pid> {
    let raw_pid =
        i32::try_from(pid).map_err(|_| io::Error::other("fixture PID does not fit in pid_t"))?;
    rustix::process::Pid::from_raw(raw_pid)
        .ok_or_else(|| io::Error::other("fixture PID cannot identify a process"))
}

fn open_pidfd(pid: u32) -> io::Result<AsyncFd<OwnedFd>> {
    let pidfd =
        rustix::process::pidfd_open(rustix_pid(pid)?, rustix::process::PidfdFlags::empty())?;
    AsyncFd::new(pidfd)
}

async fn wait_for_pidfd_exit(pidfd: &AsyncFd<OwnedFd>, timeout: Duration) -> io::Result<bool> {
    match tokio::time::timeout(timeout, pidfd.readable()).await {
        Ok(Ok(_)) => Ok(true),
        Ok(Err(error)) => Err(error),
        Err(_) => Ok(false),
    }
}
