use super::*;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "linux")]
use crate::test_support::{kill_pidfd_and_wait, open_pidfd, wait_for_pidfd_exit};
use crate::wait::{WaitOutcome, wait_with_kill_timeout_or_connection_cancelled};

struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp_dir(label: &str) -> (PathBuf, TempDirGuard) {
    let dir = std::env::temp_dir().join(format!(
        "guest-control-server-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let guard = TempDirGuard(dir.clone());
    (dir, guard)
}

fn wait_for_path(path: &std::path::Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if path.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    path.exists()
}

#[test]
fn extract_exit_code_success() {
    let status = Command::new("true").status().unwrap();
    assert_eq!(extract_exit_code(status), 0);
}

#[test]
fn extract_exit_code_failure() {
    let status = Command::new("false").status().unwrap();
    assert_eq!(extract_exit_code(status), 1);
}

#[test]
fn extract_exit_code_specific() {
    let status = Command::new("sh")
        .arg("-c")
        .arg("exit 42")
        .status()
        .unwrap();
    assert_eq!(extract_exit_code(status), 42);
}

#[test]
fn extract_exit_code_signal_kill() {
    let mut child = Command::new("sleep").arg("60").spawn().unwrap();
    unsafe { libc::kill(child.id() as i32, libc::SIGKILL) };
    let status = child.wait().unwrap();
    assert_eq!(extract_exit_code(status), 137);
}

#[test]
fn process_group_signal_pid_skips_reserved_and_unrepresentable_targets() {
    assert_eq!(process_signal_pid(0), None);
    assert_eq!(process_signal_pid(1), Some(1));
    assert_eq!(process_signal_pid(i32::MAX as u32), Some(i32::MAX));
    assert_eq!(process_signal_pid(i32::MAX as u32 + 1), None);
    assert_eq!(process_group_signal_pid(0), None);
    assert_eq!(process_group_signal_pid(1), None);
    assert_eq!(process_group_signal_pid(42), Some(-42));
    assert_eq!(process_group_signal_pid(i32::MAX as u32), Some(-i32::MAX));
    assert_eq!(process_group_signal_pid(i32::MAX as u32 + 1), None);
}

#[cfg(target_os = "linux")]
fn process_is_gone_or_zombie(pid: i32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => {
            let close_paren = stat.rfind(')').unwrap_or(0);
            stat.get(close_paren + 2..)
                .and_then(|fields| fields.split_whitespace().next())
                == Some("Z")
        }
        Err(_) => true,
    }
}

#[cfg(target_os = "linux")]
fn wait_until_process_is_gone_or_zombie(pid: i32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(1);
    while Instant::now() < deadline {
        if process_is_gone_or_zombie(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    process_is_gone_or_zombie(pid)
}

#[cfg(target_os = "linux")]
fn kill_spawned_child(child: &mut Option<Child>) {
    if let Some(child) = child.take() {
        kill_and_reap_child(child);
    }
}

#[cfg(target_os = "linux")]
#[test]
fn kill_and_reap_child_kills_direct_child_group() {
    use std::io::{BufRead, BufReader};
    use std::os::unix::process::CommandExt;

    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg("sleep 60 & echo $!")
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command.process_group(0);

    let mut child = command.spawn().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut line = String::new();
    BufReader::new(stdout).read_line(&mut line).unwrap();
    let background_pid: i32 = line.trim().parse().unwrap();

    assert_eq!(unsafe { libc::kill(background_pid, 0) }, 0);
    kill_and_reap_child(child);

    if !wait_until_process_is_gone_or_zombie(background_pid) {
        let _ = unsafe { libc::kill(background_pid, libc::SIGKILL) };
        panic!("background pid {background_pid} should have been killed");
    }
}

#[cfg(target_os = "linux")]
#[test]
fn direct_child_group_kill_does_not_signal_unrelated_group() {
    use std::os::unix::process::CommandExt;

    let mut target_command = Command::new("sleep");
    target_command.arg("60").process_group(0);
    let target = target_command.spawn().unwrap();

    let mut unrelated = Command::new("setsid")
        .arg("sleep")
        .arg("60")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let unrelated_pidfd = open_pidfd(unrelated.id() as libc::pid_t).unwrap();

    kill_and_reap_child(target);

    let unrelated_exit = wait_for_pidfd_exit(&unrelated_pidfd, Duration::from_millis(100));
    let cleanup = kill_pidfd_and_wait(&unrelated_pidfd);
    if cleanup.is_err() {
        let _ = unrelated.kill();
    }
    let wait = unrelated.wait();

    cleanup.unwrap();
    wait.unwrap();
    assert!(
        matches!(unrelated_exit, Ok(false)),
        "direct child group cleanup must not signal an unrelated group: {unrelated_exit:?}"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn spawn_in_own_process_group_timeout_kills_background_child() {
    let (dir, _guard) = temp_dir("pg");
    let ready = dir.join("ready");
    let background_pid = dir.join("background-pid");

    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(
            "trap '' HUP; tail -f /dev/null & echo $! > \"$PIDFILE\"; \
                 touch \"$READY\"; wait",
        )
        .env("READY", &ready)
        .env("PIDFILE", &background_pid)
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let mut child = Some(spawn_in_own_process_group(&mut command).unwrap());
    if !wait_for_path(&ready, Duration::from_secs(2)) {
        kill_spawned_child(&mut child);
        panic!("background child should be started before timeout kill is tested");
    }
    let background_pid_text = match std::fs::read_to_string(&background_pid) {
        Ok(pid) => pid,
        Err(e) => {
            kill_spawned_child(&mut child);
            panic!("failed to read background pid: {e}");
        }
    };
    let background_pid: libc::pid_t = match background_pid_text.trim().parse() {
        Ok(pid) => pid,
        Err(e) => {
            kill_spawned_child(&mut child);
            panic!("failed to parse background pid {background_pid_text:?}: {e}");
        }
    };
    let background_pidfd = match open_pidfd(background_pid) {
        Ok(pidfd) => pidfd,
        Err(e) => {
            kill_spawned_child(&mut child);
            panic!("failed to open pidfd for pid {background_pid}: {e}");
        }
    };

    let connection_cancel = AtomicBool::new(false);
    let outcome = wait_with_kill_timeout_or_connection_cancelled(
        child.take().unwrap(),
        100,
        &connection_cancel,
        || false,
    );
    if !matches!(outcome, WaitOutcome::TimedOut) {
        kill_pidfd_and_wait(&background_pidfd)
            .unwrap_or_else(|e| panic!("failed to clean up background pidfd: {e}"));
        panic!("expected timeout kill to return WaitOutcome::TimedOut");
    }

    match wait_for_pidfd_exit(&background_pidfd, Duration::from_secs(2)) {
        Ok(true) => {}
        Ok(false) => {
            kill_pidfd_and_wait(&background_pidfd)
                .unwrap_or_else(|e| panic!("failed to clean up background pidfd: {e}"));
            panic!(
                "timeout kill should terminate background pid {background_pid} in the process group"
            );
        }
        Err(e) => {
            let cleanup = kill_pidfd_and_wait(&background_pidfd);
            panic!(
                "failed to wait for background pid {background_pid} exit: {e}; cleanup={cleanup:?}"
            );
        }
    }
}
